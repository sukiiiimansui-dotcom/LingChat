/* wsMapBackend.ts —— **map 后端**：把现有那张 MapLibre 地图**包一层**，让它服从 `wsRenderBackend` 的契约。
 *
 * ## 🔴 这个文件不许干的事（主人定的红线，写在最前面免得后面手痒）
 * · **不许**碰地图的取参（`wsArtParams` / `bldArtParamsOf`）、挑楼（`wsBldPickStore`）、
 *   `bld-*` 图层清单 —— 那些都是共享真源，改一处就踩两页一致闸（`ws_pages_consistency.mjs`）；
 * · **不许**在这里画任何东西：地图怎么画是 `WsDistrictMapLibre.vue` 的事，本文件只做三件事 ——
 *   **读**它现在的视野、**喂**给它一个新的视野、**捞**一份它正在画的数据。
 * · 默认后端就是它 ⇒ 只要用户不切，这个文件一行都不会被执行到（`install()` 之前零副作用）。
 *
 * ## 它是怎么拿到那个 map 实例的
 * `WsDistrictMapLibre` 在建图完成时 emit `scene-ready`（宿主已经这么用了），舞台转手递给 `bind()`。
 * 地图被销毁时舞台调 `unbind()` 把它置空 —— 拿不到实例时所有方法都"如实返回空"，绝不抛。
 */

import {
  contractActors,
  contractSelection,
  contractTheme,
  ledgerMark,
  ledgerPush,
  metersBetweenCenters,
  saneRadius,
  viewRadiusOf,
  zoomOfViewRadius,
  type WsRenderActor,
  type WsRenderBackend,
  type WsRenderFc,
  type WsRenderSelection,
  type WsRenderState,
  type WsRenderStats,
  type WsRenderWorld,
} from "./wsRenderBackend";

/* ── 只写用得到的形状（**不 import maplibre 的类型**：那是"引擎结构泄进契约"的反面） ── */
interface GeoJsonSourceLike {
  getData?: () => Promise<unknown>;
}
interface CanvasLike {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
  getBoundingClientRect?: () => { width: number; height: number };
}
interface MapLike {
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  jumpTo: (opts: Record<string, unknown>) => void;
  stop?: () => void;
  getCanvas: () => CanvasLike;
  getSource?: (id: string) => unknown;
  project?: (c: [number, number]) => { x: number; y: number };
  queryRenderedFeatures?: (p: [number, number] | [[number, number], [number, number]], o?: unknown) => unknown[];
}

/** 屏幕上取样的那一圈（**两个后端共用同一套**，不然比出来的 id 没有可比性） */
export const WS_CENTER_RING: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [[0, 0]];
  for (const r of [6, 12, 18]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  }
  return out;
})();

export interface WsMapBackendOpts {
  /** 主题（宿主推进来的那一份；`readView` 原样带回） */
  themeNow?: () => { theme: string; timeOfDay: number; clock: string };
}

export function createMapBackend(opts: WsMapBackendOpts = {}): WsRenderBackend {
  let map: MapLike | null = null;
  let host: HTMLElement | null = null;
  let instance = 0;
  let state: "created" | "running" | "paused" | "destroyed" | "failed" = "created";
  /** 上一次 `readView()` 的结果（地图被销毁后 `readView()` 还能回答"我走的时候在哪"） */
  let lastView: WsRenderState | null = null;
  let frames = 0;
  let fpsAt = Date.now();

  const themeOf = (): { theme: string; timeOfDay: number; clock: string } =>
    opts.themeNow ? opts.themeNow() : contractTheme.value;

  function cssSize(): { w: number; h: number } {
    const c = map?.getCanvas?.();
    const w = c?.clientWidth || c?.getBoundingClientRect?.().width || host?.clientWidth || 0;
    const h = c?.clientHeight || c?.getBoundingClientRect?.().height || host?.clientHeight || 0;
    return { w, h };
  }

  function readView(): WsRenderState | null {
    if (!map) return lastView;
    const c = map.getCenter();
    const zoom = map.getZoom();
    const h = cssSize().h || 1;
    const v: WsRenderState = {
      center: { lat: c.lat, lng: c.lng },
      radius: saneRadius(viewRadiusOf(c.lat, zoom, h)),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      theme: themeOf().theme,
      timeOfDay: themeOf().timeOfDay,
      clock: themeOf().clock,
      actors: contractActors.value.map((a) => ({ ...a })),
      selection: contractSelection.value ? { ...contractSelection.value } : null,
    };
    lastView = v;
    return v;
  }

  async function captureWorld(): Promise<WsRenderWorld | null> {
    const th = themeOf().theme;
    const grab = async (id: string): Promise<WsRenderFc | null> => {
      try {
        const src = map?.getSource?.(id) as GeoJsonSourceLike | undefined;
        if (!src?.getData) return null;
        const data = (await src.getData()) as WsRenderFc | null;
        if (!data || !Array.isArray(data.features)) return null;
        return { type: "FeatureCollection", features: data.features };
      } catch {
        /* 取不到就说取不到（`null`）—— 绝不拿半份数据糊上去 */
        return null;
      }
    };
    /* ⚠️ 顺序要紧：两个 source 都在 MapLibre 里，而它下一刻就要被销毁了 ⇒ 必须在这里 await 完 */
    const buildings = await grab("bld");
    const roads = await grab("roads");
    if (!buildings && !roads) return null;
    return { buildings, roads, themeId: th };
  }

  return {
    id: "map",

    async init(h: HTMLElement): Promise<void> {
      host = h;
      instance = ledgerPush("map", "created");
      state = "created";
    },

    /** 舞台在地图就绪（`scene-ready`）时把实例递进来 */
    bind(m: unknown): void {
      map = (m as MapLike) || null;
      state = "running";
      ledgerMark(instance, "running");
    },
    unbind(): void {
      map = null;
    },

    applyView(s: WsRenderState): void {
      if (!map) return;
      const h = cssSize().h || 1;
      const zoom = zoomOfViewRadius(s.center.lat, saneRadius(s.radius), h);
      try {
        /* 与 MapLibre 的命令式 API 同一个口径：center/zoom/bearing/pitch 一次给全，
           `jumpTo` 不带过渡 ⇒ 切过去就是那一眼，不是"飘过去"（"无缝"要的是瞬时对齐）。 */
        map.jumpTo({ center: [s.center.lng, s.center.lat], zoom, bearing: s.bearing, pitch: s.pitch });
      } catch {
        /* 相机给不出合法的数就不动它（保持原样，绝不把地图甩到 NaN） */
      }
      lastView = { ...s, actors: s.actors.map((a) => ({ ...a })) };
    },

    readView,

    setTheme(theme: string, timeOfDay: number): void {
      /* 主题这件事**不由本后端做**：`wsm:v1:mapTheme` 与 `wsm:v1:night` 的真源在
         `wsMapTheme` / 宿主里，这里只把当前值记进 `lastView`（宿主改主题时自己会重绘）。 */
      if (lastView) lastView = { ...lastView, theme, timeOfDay };
      else lastView = readView();
    },

    setActors(actors: readonly WsRenderActor[]): void {
      /* 2D 的角色是**既有 marker 通路**画的（`WsDistrictMapLibre` 的 `markers` prop），
         本后端不插一脚；这里只保证契约里那一份与宿主推的是同一批。 */
      if (lastView) lastView = { ...lastView, actors: actors.map((a) => ({ ...a })) };
    },

    setSelection(sel: WsRenderSelection | null): void {
      if (lastView) lastView = { ...lastView, selection: sel ? { ...sel } : null };
    },

    captureWorld,

    pause(): void {
      /* MapLibre 没有"暂停渲染"的公开 API，但它**本来就是按需重绘**（不是每帧循环）⇒
         真正的"停"是：掐掉正在进行的过渡/惯性，之后不再有人要求重绘。
         隐藏那个后端靠的是**销毁（组件卸载 ⇒ `map.remove()` ⇒ WebGL 上下文释放）**，
         这里这一步是"别在旧后端的最后一帧上再算一次"。 */
      try {
        map?.stop?.();
      } catch {
        /* 停不了也不影响（下一步就是销毁） */
      }
      state = "paused";
      ledgerMark(instance, "paused");
    },

    resume(): void {
      state = "running";
      ledgerMark(instance, "running");
      fpsAt = Date.now();
      frames = 0;
    },

    destroy(): void {
      /* 地图实例归 `WsDistrictMapLibre.vue` 的 `onBeforeUnmount` 管（它自己 `map.remove()`）；
         本文件只是那张地图的**观察者**，不能替它删东西。 */
      map = null;
      host = null;
      state = "destroyed";
      ledgerMark(instance, "destroyed");
    },

    stats(): WsRenderStats {
      const now = Date.now();
      const dt = now - fpsAt;
      if (dt > 1000) {
        frames = 0;
        fpsAt = now;
      }
      frames++;
      const c = map?.getCanvas?.();
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      return {
        backend: "map",
        draws: 0,
        dpr,
        fps: 0,
        rendering: state === "running",
        note: `canvas ${c?.width || 0}×${c?.height || 0}`,
      };
    },

    /**
     * 屏幕正中那栋楼 = `queryRenderedFeatures` 在正中那一圈里**第一个命中的 `bld-*` 要素**。
     * 用渲染器的命中而不是自己算几何 ⇒ 这条判据是**真的在问地图"你画的是哪栋"**。
     */
    centerPick(): { kind: "bld"; id: string; lng: number; lat: number } | null {
      if (!map?.queryRenderedFeatures) return null;
      const { w, h } = cssSize();
      if (!w || !h) return null;
      for (const [dx, dy] of WS_CENTER_RING) {
        const p: [number, number] = [w / 2 + dx, h / 2 + dy];
        let feats: unknown[] = [];
        try {
          feats = map.queryRenderedFeatures(p) || [];
        } catch {
          feats = [];
        }
        for (const f of feats) {
          const o = f as { id?: unknown; layer?: { id?: string }; geometry?: { coordinates?: unknown } };
          const lid = String(o?.layer?.id || "");
          if (!lid.startsWith("bld-")) continue;
          const id = o?.id;
          if (id === undefined || id === null || id === "") continue;
          /* 这条要素的代表点：拿它自己几何的第一个坐标（足够当"是哪一栋"，不是要精确的形心） */
          const rp = firstCoordOf(o.geometry);
          if (!rp) continue;
          return { kind: "bld", id: String(id), lng: rp[0], lat: rp[1] };
        }
      }
      return null;
    },
  } as WsRenderBackend & { bind(m: unknown): void; unbind(): void };
}

/** 从（Multi）Polygon 的坐标里取第一个点（**只用来指认"是哪一栋"**） */
function firstCoordOf(geom: { coordinates?: unknown } | undefined | null): [number, number] | null {
  const c = geom?.coordinates as unknown;
  if (!Array.isArray(c)) return null;
  const dig = (v: unknown): [number, number] | null => {
    if (!Array.isArray(v)) return null;
    if (typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
    for (const x of v) {
      const r = dig(x);
      if (r) return r;
    }
    return null;
  };
  const r = dig(c);
  return Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) ? r : null;
}

/** 两个中心差多少米（探针判据用；**复用契约里的那一个**，别在这里再写一遍） */
export { metersBetweenCenters };
