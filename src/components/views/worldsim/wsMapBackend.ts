/* wsMapBackend.ts —— **map 后端**：把现有那张 MapLibre 地图**包一层**，让它服从 `wsRenderBackend` 的契约。
 *
 * ## 这个文件不许干的事（既定的红线，写在最前面免得后面手痒）
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

import { bldIdOfFeature } from "./wsBldIdKey";
import {
  contractActors,
  metersPerPixelAt,
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

/** 交接那次抓数据的**等待上限**（毫秒）：路网/楼房是异步落图的，抓一次常常抓空 */
export const CAPTURE_WAIT_MS = 3000;

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
    /* 顺序要紧：两个 source 都在 MapLibre 里，而它下一刻就要被销毁了 ⇒ 必须在这里 await 完。
     *
     * 🔴 这两份数据是**异步落图**的：`bld` 与 `roads` 各自等数据回来才 `setData`。
     *    原来只抓**一次**，抓不到就 `null` ⇒ 用户手快（或路网慢）时切过去就是"只有楼、没有路"，
     *    而且**再也没有补的机会**（地图那一刻就销毁了）。现在改成**有上限地等**：
     *    每 150 ms 重试一次，最多等 `CAPTURE_WAIT_MS`；等不到也照样把它交出去，
     *    但**如实记下各自几条**（`counts`），让下游能说清"是没有数据，还是没画"。 */
    let buildings = await grab("bld");
    let roads = await grab("roads");
    const deadline = Date.now() + CAPTURE_WAIT_MS;
    while ((!buildings || !roads) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (!buildings) buildings = await grab("bld");
      if (!roads) roads = await grab("roads");
    }
    if (!buildings && !roads) return null;
    return {
      buildings,
      roads,
      themeId: th,
      counts: { buildings: buildings?.features?.length ?? 0, roads: roads?.features?.length ?? 0 },
    };
  }

  return {
    id: "map",

    async init(h: HTMLElement, s: WsRenderState): Promise<void> {
      host = h;
      instance = ledgerPush("map", "created");
      state = "created";
      /**
       * 2026-10-08：**把"上台时被交代的那一眼"先记下来**。
       *
       * 为什么必须有这一句：地图实例是**异步**才绑上来的（`scene-ready` → `bind()`）。
       * 在那之前 `readView()` 只能答 `lastView`，而 `lastView` 原来是 `null`
       * ⇒ 舞台"失败即回退"回到 map 之后，探针读 `state.center` 读到的是 `null`，
       * 「center 交接误差 ≤1 m」那条判据**永远量不出来**（实测读数就是 `meters: null`）。
       * 现在：init 时给的那份 state 就是它的答案，bind 之后自然换成地图的真实视野。
       */
      if (s) lastView = { ...s, actors: s.actors.map((a) => ({ ...a })) };
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
     * **口径对拍**（只读）：地图自己的"米每像素" vs 我们用 `metersPerPixelAt` 算的那个。
     *
     * 为什么要它：真机反馈"拖动时叠加层与地图走得不一样远"——最像的一个原因是**比例口径不同**
     * （两边米每像素只要差一点，静止看中心是 0 误差、越靠边越错、拖起来差得更明显）。
     * 这条把两个数**摆出来**，比值必须是 1.00。
     */
    scaleProbe(): { zoom: number; lat: number; mapMpp: number | null; ourMpp: number; ratio: number | null } | null {
      const m = map as unknown as { getZoom?: () => number; getCenter?: () => { lat: number }; transform?: { pixelsPerMeter?: number } } | null;
      try {
        const zoom = Number(m?.getZoom?.() ?? NaN);
        const lat = Number(m?.getCenter?.().lat ?? NaN);
        const ppm = Number(m?.transform?.pixelsPerMeter ?? NaN);
        if (!Number.isFinite(zoom) || !Number.isFinite(lat)) return null;
        const ourMpp = metersPerPixelAt(lat, zoom);
        const mapMpp = Number.isFinite(ppm) && ppm > 0 ? 1 / ppm : null;
        return { zoom, lat, mapMpp, ourMpp, ratio: mapMpp ? ourMpp / mapMpp : null };
      } catch {
        return null;
      }
    },

    /** 探针用：脚本化平移（`duration: 0` = 立刻，便于逐帧对拍；真机手势走地图自己的那条路） */
    panBy(dx: number, dy: number): boolean {
      const m = map as unknown as { panBy?: (o: [number, number], opt?: unknown) => unknown } | null;
      if (!m?.panBy) return false;
      try {
        m.panBy([Number(dx) || 0, Number(dy) || 0], { duration: 0 });
        return true;
      } catch {
        return false;
      }
    },

    /** **屏幕像素 → 经纬度**（真地图的 `unproject()`；纯数学，不需要 GL）—— §1.3 表要用它取"屏内目标点" */
    unproject(p: [number, number]): [number, number] | null {
      const m = map as unknown as { unproject?: (q: [number, number]) => { lng: number; lat: number } } | null;
      if (!m?.unproject) return null;
      try {
        const ll = m.unproject([Number(p[0]), Number(p[1])]);
        return Number.isFinite(ll?.lng) && Number.isFinite(ll?.lat) ? [ll.lng, ll.lat] : null;
      } catch {
        return null;
      }
    },

    /**
     * **图层清单**（只读）：`bld*` 那几层的 `visibility` —— "地图自己那套楼"现在显不显示。
     *
     * 真机反馈"地图和立体楼两层同时在画"⇒ 修的时候要把地图那套楼藏掉，而**藏没藏、还原没还原**
     * 必须是可读的（不许静默）。所以这里如实报出来。
     */
    layers(): Array<{ id: string; visibility: string | null }> {
      const out: Array<{ id: string; visibility: string | null }> = [];
      const m = map as unknown as {
        getStyle?: () => { layers?: Array<{ id?: string }> } | undefined;
        getLayoutProperty?: (id: string, k: string) => unknown;
      };
      try {
        const layers = m?.getStyle?.()?.layers || [];
        for (const l of layers) {
          const id = String(l?.id || "");
          if (!id.startsWith("bld")) continue;
          let vis: string | null = null;
          try {
            const v = m.getLayoutProperty?.(id, "visibility");
            vis = v === undefined || v === null ? null : String(v);
          } catch {
            vis = "?";
          }
          out.push({ id, visibility: vis });
        }
      } catch {
        /* 拿不到就给空表（如实：不是"没有楼"，是"读不到"） */
      }
      return out;
    },

    /**
     * **经纬度 → 屏幕像素**（真地图的 `project()`；纯数学，不需要 GL）。
     * §1.3 那条"同楼四角 ≤1.5 px"的对拍要拿它与叠加层那边的 `camera.project()` 比。
     */
    project(c: [number, number]): { x: number; y: number } | null {
      if (!map?.project) return null;
      try {
        const p = map.project([Number(c[0]), Number(c[1])]);
        return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? { x: p.x, y: p.y } : null;
      } catch {
        return null;
      }
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
          /* id 口径：能规范化的（MVT 数字 id / 12 位 hex）走 `bldIdOfFeature`；其余原样 —— 老路一字节不变 */
          const canon = bldIdOfFeature(o as { id?: unknown; properties?: Record<string, unknown> });
          return { kind: "bld", id: canon ?? String(id), lng: rp[0], lat: rp[1] };
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
