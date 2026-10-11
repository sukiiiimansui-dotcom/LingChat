/* wsOverlayBackend.ts —— **地图之上那一层**（契约里的 `overlay`）：地图照常在下层画，three 只把楼立体地叠上去。
 *
 * ## 口径（`world_map/PLAN-OVERLAY-BACKEND.md` 是施工图，这里照它实现）
 * · **不接管输入**：叠加层画布 `pointer-events: none` —— 拖/捏/滚轮/旋转/俯仰**全部**仍归地图。
 *   相机只有一条输入链路，不会出现两个后端抢手势。
 * · **相机每帧从地图读**：本文件**不存相机状态**，每帧 `map.getCenter()/getZoom()/getBearing()/getPitch()`
 *   + `map.getCanvas()` 的 CSS 尺寸 → 契约那两个纯函数 → `wsThreeCam` 的相机模型。
 *   （相机单一真源的纪律：绝不自己积分，见 `reference/2026-10-04-camera-single-truth-and-basemap-flat.md`。）
 * · **楼与 2D 同源**：几何由 `wsBldMesh.buildBldMeshData()` 算 —— 与 `three` 那条路**同一份**实现；
 *   数据来源是舞台交进来的那份 `bld`（地图 source 里那一份），叠加层不自己挑楼。
 * · **路网这类后到的数据**：叠加层挂在**地图的 `sourcedata`** 上，落图之后自己补（地图一直在，
 *   不像 `three` 那条路只能拿一次快照）。
 * · 失败即回退、开关默认关由舞台负责（本文件起不来就抛，走既有那条回退路）。
 *
 * ## 这一版不做什么（照实写）
 * · 只画**楼**（动态物是 O2）；
 * · 不做深度遮挡的假象（2D 底图在下面，楼压在它上面）；
 * · 没有命中/卡片（P3）。
 */

import { BLD_CAP, buildBldMeshData, type BldMeshData } from "./wsBldMesh";
import {
  contractTheme,
  metersPerPixelAt,
  saneRadius,
  viewRadiusOf,
  type WsRenderActor,
  type WsRenderBackend,
  type WsRenderFc,
  type WsRenderSelection,
  type WsRenderState,
  type WsRenderStats,
  type WsRenderWorld,
} from "./wsRenderBackend";
import { camFrameOf, farOf, nearOf } from "./wsThreeCam";

const THREE_PATH = "/ws3d/ws3dgl/vendor/three.min.js";
/** 每度多少米（与 `wsThreeCam.M_PER_DEG` 同口径；这里只用它做锚点漂移判断） */
const M_PER_DEG = 111319.49079327358;
/** 地图中心离锚点超过这个米数就重锚（局部平面框架的近似误差随距离平方涨） */
const REANCHOR_M = 2000;
/** `sourcedata` 之后的补建防抖（毫秒） */
const REFRESH_DEBOUNCE_MS = 400;

/* ══════════════════════════════════════════════════════════════════════════
 * 🔧 自用对齐探针（`?wsalign=1`）—— **给真机用的量具**，不是产品功能
 * ══════════════════════════════════════════════════════════════════════════
 * 本机量不到"拖动时叠加层与地图差多少像素"（一个页面只能建一次 WebGL 上下文，叠加层常常
 * 起不来）⇒ 把这把尺子装进页面，让**真机**把数带回来：
 *   · 固定一栋楼的一个角（开的时候选一次、经纬度冻住，绝不每帧换目标）；
 *   · 每次地图 `render` 算一次屏幕空间像素差：`map.project(角)` vs 叠加层
 *     **上一次真的画出去那一帧**的投影（`projectFromLastDraw`）；
 *   · 记 `cur / max / 中位`（近 N 次）+ 当时的 `center/zoom/bearing/pitch` + 计数；
 *   · **停手 1 秒**再记一组（静止基准）；回传走 `<img>` beacon 到 8795 的 `__wslog`，
 *     `moveend` 必发一条、其余**最多每 2 秒一条**（不刷屏）。
 *   · 顺带把"米每像素口径"的比值一起带回去（用 `map.unproject` 在屏幕横轴上量 200 px
 *     对应多少米 —— **不动地图、不借内部字段**）。
 *
 * 🔴 纪律：① **只读**（不碰渲染、不改地图状态）② 默认不装（没这个参数 ⇒ 这段代码一步都不跑）
 *   ③ 这一段属**自用层**：将来给上游提 PR 时要**整段剔除**（连 `?wsalign=` 的判定一起）。
 */

/** 自用开关：`?wsalign=1` 才装 */
export function alignProbeWanted(): boolean {
  try {
    return new URLSearchParams(location.search).get("wsalign") === "1";
  } catch {
    return false;
  }
}

/** 一行回传（`<img>` beacon；跨端口没问题，不用 fetch ⇒ 不会因 CORS/预检卡住） */
function beacon(row: Record<string, unknown>): void {
  try {
    const j = encodeURIComponent(JSON.stringify(row));
    const img = new Image();
    img.src = `http://127.0.0.1:8795/__wslog?tag=align_phone&j=${j}`;
  } catch {
    /* 回传失败不影响页面（它本来就只是量具） */
  }
}

/** 只写用得到的形状（**不 import maplibre 的类型**：引擎结构不许泄进这里） */
interface OverlayMapLike {
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  getCanvas: () => { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
  getSource?: (id: string) => { getData?: () => Promise<unknown> } | undefined;
  on?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
  off?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
}

export function createOverlayBackend(): WsRenderBackend {
  let THREE: Record<string, any> | null = null;
  let renderer: any = null;
  let scene: any = null;
  let camera: any = null;
  let host: HTMLElement | null = null;
  let map: OverlayMapLike | null = null;
  let bldMesh: any = null;
  let data: BldMeshData | null = null;
  /** 局部平面框架的锚点（地图中心漂太远就重锚） */
  let anchor: { lat: number; lng: number; cos: number } | null = null;
  let state: "created" | "running" | "paused" | "destroyed" | "failed" = "created";
  let raf = 0;
  let frames = 0;
  let draws = 0;
  let fps = 0;
  let fpsAt = 0;
  let fpsFrames = 0;
  /** 每帧从地图读到的四量（**只是读数的缓存**，不是"我们的相机状态"） */
  let lastSeen: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null = null;
  let refreshTimer = 0;
  const errors: string[] = [];

  const runtimeUrl = (path: string): string =>
    new URL(path, typeof location !== "undefined" ? location.href : "http://127.0.0.1/").href;

  function sizeOf(): { w: number; h: number } {
    const w = host?.clientWidth || host?.getBoundingClientRect().width || 800;
    const h = host?.clientHeight || host?.getBoundingClientRect().height || 600;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  /** 经纬度 → 局部米（锚点固定；`[x, z]`，x 东、z 南） */
  function toLocal(lng: number, lat: number): [number, number] {
    const a = anchor as { lat: number; lng: number; cos: number };
    return [(lng - a.lng) * M_PER_DEG * a.cos, (a.lat - lat) * M_PER_DEG];
  }

  /** 锚点离地图中心多远（米，等距近似） */
  function anchorDriftM(c: { lat: number; lng: number }): number {
    if (!anchor) return 0;
    const a = anchor as { lat: number; lng: number; cos: number };
    const dx = (c.lng - a.lng) * M_PER_DEG * a.cos;
    const dz = (c.lat - a.lat) * M_PER_DEG;
    return Math.hypot(dx, dz);
  }

  /** 从地图读四量（**唯一真源**；读不到就给 null，绝不编） */
  function readMapView(): { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null {
    if (!map?.getCenter || !map.getZoom) return null;
    try {
      const c = map.getCenter();
      const zoom = map.getZoom();
      const cv = map.getCanvas?.() as { clientHeight?: number; height?: number } | undefined;
      const h = Number(cv?.clientHeight) || Number(cv?.height) || sizeOf().h;
      return {
        center: { lat: Number(c.lat), lng: Number(c.lng) },
        radius: saneRadius(viewRadiusOf(Number(c.lat), Number(zoom), h)),
        bearing: Number(map.getBearing?.() ?? 0),
        pitch: Number(map.getPitch?.() ?? 0),
      };
    } catch {
      return null;
    }
  }

  /** 每帧：把地图的相机搬进 three（正解走 `wsThreeCam`，与独立那条路同一个模型） */
  function syncCamera(): void {
    if (!camera) return;
    const v = readMapView();
    if (!v) return;
    lastSeen = v;
    const { w, h } = sizeOf();
    const [cx, cz] = toLocal(v.center.lng, v.center.lat);
    const f = camFrameOf(cx, cz, v.radius, v.bearing, v.pitch);
    camera.position.set(f.pos[0], f.pos[1], f.pos[2]);
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(f.xAxis[0], f.xAxis[1], f.xAxis[2]),
      new THREE!.Vector3(f.yAxis[0], f.yAxis[1], f.yAxis[2]),
      new THREE!.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2])
    );
    camera.quaternion.setFromRotationMatrix(m);
    camera.near = nearOf(f.dist);
    camera.far = farOf(f.dist, v.radius);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function disposeMesh(): void {
    if (!bldMesh) return;
    try {
      scene?.remove(bldMesh);
      bldMesh.geometry?.dispose?.();
      const mats = Array.isArray(bldMesh.material) ? bldMesh.material : [bldMesh.material];
      for (const mm of mats) mm?.dispose?.();
    } catch {
      /* 释放失败不影响后续（它已经不在场景里了） */
    }
    bldMesh = null;
  }

  /** 用一份 `bld` 要素重建楼（几何走共用模块 ⇒ 与 three 那条路画的是同一批） */
  function rebuild(themeId: string, fc: WsRenderFc | null): void {
    disposeMesh();
    data = null;
    if (!THREE || !scene || !fc) return;
    data = buildBldMeshData({
      features: fc.features,
      toLocal: (lng: number, lat: number) => toLocal(lng, lat),
      themeId,
      cap: BLD_CAP,
    });
    if (!data.triangles) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(data.positions), 3));
    g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(data.colors), 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    bldMesh = new THREE.Mesh(g, mat);
    bldMesh.name = "ws-overlay-buildings";
    scene.add(bldMesh);
    /* 数据是**后到**的（`sourcedata` / 重锚）⇒ 重建完立刻画一帧：
       渲染是"地图画完一帧"驱动的，地图静止时不会再来 render，等它就等于这一批楼不显示。 */
    drawOnce();
  }

  /** 从地图 source 里捞一份 `bld`（与 `three` 那条路同一条数据通路） */
  async function grabBld(): Promise<WsRenderFc | null> {
    try {
      const src = map?.getSource?.("bld");
      if (!src?.getData) return null;
      const d = (await src.getData()) as WsRenderFc | null;
      if (!d || !Array.isArray(d.features)) return null;
      return { type: "FeatureCollection", features: d.features };
    } catch {
      return null;
    }
  }

  /** 后到的数据自己补上（`bld` 落图 ⇒ 重建）；防抖，别在一次落图里重建十遍 */
  function scheduleRefresh(): void {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc);
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
  }

  const onSourceData = (e: { sourceId?: string }): void => {
    if (e?.sourceId === "bld") scheduleRefresh();
  };

  let curThemeId = "anime";
  /* ── 自用对齐探针的状态（`?wsalign=1` 才用；默认全是空转） ── */
  const alignOn = alignProbeWanted();
  let alignCorner: [number, number] | null = null;
  const alignErrs: number[] = [];
  let alignMax = 0;
  let alignCur = 0;
  let alignReports = 0;
  let alignLastReportAt = 0;
  let alignStaticTimer = 0;
  let alignBadge: HTMLElement | null = null;
  /**
   * 怎么跟地图对齐（**这是"拖动时位移不一致"那条的头号嫌疑**）：
   *   · `render`（默认）：挂 `map.on('render')` —— 地图画完一帧就叫我们，**同一帧**用它的相机画叠加层；
   *   · `raf`：自己的 `requestAnimationFrame`（老行为）。地图与叠加层各跑各的节奏，
   *     拖动时相机读数可能差一帧 ⇒ **静止看不出来、一动就按速度成比例地错开**。
   * 保留两种是为了让探针在**同一页面、同一段拖动**里 A/B 对比（不是靠讲道理）。
   */
  let alignMode: "render" | "raf" = "render";
  /** 上一次**真的画出去**那一帧的相机矩阵（逐帧对拍要看"屏幕上是什么"，不是"现在是什么"） */
  let lastDraw: { mwInv: number[]; proj: number[]; w: number; h: number } | null = null;
  /** 这一帧那批楼**从哪儿来**（`world` = 舞台交进来的那份 / `source` = 从地图 source 现捞的） */
  let lastSource = "none";

  /** 真的画一帧（并把"画的时候"的相机矩阵快照下来 —— 逐帧对拍读的就是它） */
  function drawOnce(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const { w, h } = sizeOf();
    try {
      lastDraw = {
        mwInv: Array.from(camera.matrixWorldInverse.elements as number[]) as number[],
        proj: Array.from(camera.projectionMatrix.elements as number[]) as number[],
        w,
        h,
      } as { mwInv: number[]; proj: number[]; w: number; h: number };
    } catch {
      lastDraw = null;
    }
    renderer.render(scene, camera);
    draws = renderer.info?.render?.calls ?? 0;
    /* 自用对齐探针：**画完**才采（采的就是"屏幕上这一帧"）—— 没开开关时 alignOn=false，一步不跑 */
    if (alignOn && alignCorner) {
      try {
        alignSample();
      } catch {
        /* 量具自己抛错不许影响渲染 */
      }
    }
  }

  /* ── 自用对齐探针（只在 `?wsalign=1` 时真跑） ───────────────────────────────── */
  /** 选一个"固定的角"：拿地图 `bld` 源里第一栋的第一个环点，投票到屏幕中心最近的那个 —— **只选一次** */
  async function alignPickCorner(): Promise<void> {
    if (!alignOn || alignCorner) return;
    try {
      const fc = await grabBld();
      const feats = (fc?.features || []) as Array<{ geometry?: unknown }>;
      const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
      const { w, h } = sizeOf();
      const cx = w / 2;
      const cy = h / 2;
      let best: [number, number] | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const f of feats) {
        const g = f?.geometry as { type?: string; coordinates?: unknown } | null;
        const cs = g?.coordinates as unknown;
        const first = Array.isArray(cs) && Array.isArray(cs[0]) && Array.isArray((cs[0] as unknown[])[0])
          ? ((cs[0] as unknown[])[0] as unknown[])
          : Array.isArray(cs) && Array.isArray(cs[0])
            ? (cs[0] as unknown[])
            : null;
        if (!first) continue;
        const lng = Number(first[0]);
        const lat = Number(first[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const p = m?.project?.([lng, lat]);
        if (!p) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestD) {
          bestD = d;
          best = [lng, lat];
        }
      }
      alignCorner = best;
      if (best && map) {
        const m2 = map as unknown as { on?: (ev: string, cb: () => void) => void };
        m2.on?.("moveend", () => {
          alignFlush("moveend");
          if (alignStaticTimer) window.clearTimeout(alignStaticTimer);
          /* 停手 1 秒后再记一组（静止基准）—— 真机上"静止对不齐"与"动起来才错"是两回事 */
          alignStaticTimer = window.setTimeout(() => alignFlush("static"), 1000);
        });
      }
    } catch {
      /* 选不到角就不装（如实：量不到就不量，不编一个坐标） */
    }
  }

  /** 当前那一帧的像素差（地图当下 vs 叠加层上次画出去那一帧） */
  function alignSample(): void {
    if (!alignOn || !alignCorner || !map) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    const a = m?.project?.(alignCorner);
    const b = this_projectFromLastDraw(alignCorner[0], alignCorner[1]);
    if (!a || !b) return;
    const d = Math.hypot(a.x - b[0], a.y - b[1]);
    alignCur = d;
    alignErrs.push(d);
    if (alignErrs.length > 240) alignErrs.shift();
    if (d > alignMax) alignMax = d;
    alignBadgePaint();
    const now = performance.now();
    if (now - alignLastReportAt > 2000) alignFlush("moving");
  }

  /** 回传一条（`moveend` 必发；其余按 2 秒节流） */
  function alignFlush(kind: string): void {
    if (!alignOn || !alignCorner) return;
    const m = map as unknown as {
      getCenter?: () => { lat: number; lng: number };
      getZoom?: () => number;
      getBearing?: () => number;
      getPitch?: () => number;
      unproject?: (p: [number, number]) => { lat: number; lng: number };
    } | null;
    let mppRatio: number | null = null;
    try {
      /* 不动地图、不借内部字段：屏幕横轴上量 200 px 对应多少米（unproject 两次） */
      const { w, h } = sizeOf();
      const c0 = m?.unproject?.([w / 2, h / 2]);
      const c1 = m?.unproject?.([w / 2 + 200, h / 2]);
      if (c0 && c1) {
        const kx = 111320 * Math.cos((((c0.lat + c1.lat) / 2) * Math.PI) / 180);
        const ky = 110540;
        const dMeters = Math.hypot((c1.lng - c0.lng) * kx, (c1.lat - c0.lat) * ky);
        const measured = dMeters / 200;
        const ours = metersPerPixelAt(Number(m?.getCenter?.().lat ?? 0), Number(m?.getZoom?.() ?? 0));
        mppRatio = measured > 0 ? Number((ours / measured).toFixed(4)) : null;
      }
    } catch {
      mppRatio = null;
    }
    const sorted = [...alignErrs].sort((x, y) => x - y);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    alignReports++;
    alignLastReportAt = performance.now();
    beacon({
      kind,
      corner: alignCorner,
      cur: Number(alignCur.toFixed(3)),
      max: Number(alignMax.toFixed(3)),
      med: med === null ? null : Number(med.toFixed(3)),
      n: alignErrs.length,
      reports: alignReports,
      center: m?.getCenter?.() ?? null,
      zoom: m?.getZoom?.() ?? null,
      bearing: m?.getBearing?.() ?? null,
      pitch: m?.getPitch?.() ?? null,
      mppRatio,
      bld: data?.stats.buildings ?? 0,
      tris: data?.triangles ?? 0,
    });
  }

  /** HUD 上看得见的那一行（自用；关掉开关就没有它） */
  function alignBadgePaint(): void {
    if (!alignOn) return;
    try {
      if (!alignBadge) {
        alignBadge = document.createElement("div");
        alignBadge.className = "ws-align-badge";
        alignBadge.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:9999;background:#000a;color:#8fe;font:12px ui-monospace,monospace;padding:2px 6px;border-radius:4px;pointer-events:none";
        document.body.appendChild(alignBadge);
      }
      const sorted = [...alignErrs].sort((x, y) => x - y);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      alignBadge.textContent = `align: cur ${alignCur.toFixed(2)} / max ${alignMax.toFixed(2)} / med ${med.toFixed(2)} px · n=${alignErrs.length} · 报 ${alignReports}`;
    } catch {
      /* 徽标画不出来不影响量具 */
    }
  }

  /** 给 `stats().note` 用的那一句（自用；没开开关就是空串） */
  function alignNote(): string {
    if (!alignOn) return "";
    return ` / align(cur ${alignCur.toFixed(2)} max ${alignMax.toFixed(2)} px · n=${alignErrs.length})`;
  }

  /** `projectFromLastDraw` 的本地实现（对象方法只是转发；自用探针也要调它） */
  function this_projectFromLastDraw(lng: number, lat: number): [number, number] | null {
    if (!lastDraw) return null;
    const xy = toLocal(Number(lng), Number(lat));
    const v = [xy[0], 0, xy[1], 1];
    const mul = (m: number[], p: number[]): number[] => {
      const o = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        o[i] = m[i * 4]! * p[0]! + m[i * 4 + 1]! * p[1]! + m[i * 4 + 2]! * p[2]! + m[i * 4 + 3]! * p[3]!;
      }
      return o;
    };
    const cam = mul(lastDraw.mwInv, v);
    const clip = mul(lastDraw.proj, cam);
    if (!Number.isFinite(clip[3]!) || Math.abs(clip[3]!) < 1e-9) return null;
    return [((clip[0]! / clip[3]! + 1) / 2) * lastDraw.w, ((1 - clip[1]! / clip[3]!) / 2) * lastDraw.h];
  }

  /** 地图画完一帧 ⇒ 同一帧把叠加层也画了（`alignMode === 'render'` 时的唯一驱动） */
  function onMapRender(): void {
    if (state !== "running") return;
    syncCamera();
    drawOnce();
    frames++;
  }

  function tick(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const now = performance.now();
    fpsFrames++;
    if (!fpsAt) fpsAt = now;
    if (now - fpsAt >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsFrames = 0;
    }
    /* 地图中心漂太远 ⇒ 重锚 + 重建（局部框架的近似误差随距离平方涨） */
    const v = readMapView();
    if (v && anchor && anchorDriftM(v.center) > REANCHOR_M) {
      anchor = { lat: v.center.lat, lng: v.center.lng, cos: Math.cos((v.center.lat * Math.PI) / 180) };
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc);
        }
      })();
    }
    syncCamera();
    drawOnce();
    raf = requestAnimationFrame(tick);
  }

  /** 挂驱动：`render` 模式挂地图的帧回调，`raf` 模式自己数帧 */
  function attachDrive(): void {
    if (alignMode === "render" && map?.on) {
      map.on("render", onMapRender);
      drawOnce();          // 先画一帧（地图可能暂时不重绘）
    } else if (!raf) {
      raf = requestAnimationFrame(tick);
    }
  }
  function detachDrive(): void {
    try {
      map?.off?.("render", onMapRender);
    } catch {
      /* ignore */
    }
    stopLoop();
  }

  function stopLoop(): void {
    if (raf) {
      try {
        cancelAnimationFrame(raf);
      } catch {
        /* ignore */
      }
      raf = 0;
    }
  }

  return {
    id: "overlay",

    async init(h: HTMLElement, s: WsRenderState, world: WsRenderWorld | null): Promise<void> {
      host = h;
      state = "created";
      let cv: HTMLCanvasElement | null = null;
      try {
        THREE = (await import(/* @vite-ignore */ runtimeUrl(THREE_PATH))) as Record<string, any>;
        const { w, h: hh } = sizeOf();
        cv = document.createElement("canvas");
        cv.className = "ws-overlay-canvas";
        /* 🔴 不接管输入：这一条就是那一条（详见文件头） */
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
        h.appendChild(cv);
        renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: true, powerPreference: "high-performance" });
        renderer.setClearAlpha(0);
        renderer.setPixelRatio(Math.min(3, window.devicePixelRatio || 1));
        renderer.setSize(w, hh, false);
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(36.87, w / hh, 0.6, 8000);
        anchor = { lat: s.center.lat, lng: s.center.lng, cos: Math.cos((s.center.lat * Math.PI) / 180) };
        curThemeId = s.theme || contractTheme.value.theme || "anime";
        /* 楼：先用舞台交进来的那份世界数据（拿不到就去地图 source 里捞一次） */
        const fc = world?.buildings ?? (await grabBld());
        lastSource = world?.buildings ? "world" : fc ? "source" : "none";
        syncCamera();
        if (fc) rebuild(world?.themeId || curThemeId, fc);
        map?.on?.("sourcedata", onSourceData);
        state = "running";
        attachDrive();
        /* 自用对齐探针（`?wsalign=1`）：选一次固定角 + 画个徽标；没开开关时这两句都是空转 */
        if (alignOn) {
          void alignPickCorner();
          alignBadgePaint();
        }
      } catch (e) {
        const msg = "叠加层起不来：" + String((e as Error)?.message || e);
        errors.push(msg);
        try {
          cv?.remove();
        } catch {
          /* 摘不掉不影响回退 */
        }
        stopLoop();
        renderer = null;
        scene = null;
        camera = null;
        host = null;
        state = "failed";
        throw new Error(msg);
      }
    },

    /** 舞台把地图实例递进来（地图**一直在**，这就是与 `three` 那条路最大的不同） */
    bindMap(m: unknown): void {
      map = (m as OverlayMapLike) || null;
      map?.on?.("sourcedata", onSourceData);
    },
    unbindMap(): void {
      try {
        map?.off?.("sourcedata", onSourceData);
      } catch {
        /* ignore */
      }
      map = null;
    },

    applyView(): void {
      /* 叠加层的视野**只从地图读**（这条是它的定义）⇒ 舞台推过来的状态不写相机 */
      syncCamera();
    },

    readView(): WsRenderState | null {
      const v = lastSeen || readMapView();
      if (!v) return null;
      return {
        center: v.center,
        radius: v.radius,
        bearing: v.bearing,
        pitch: v.pitch,
        theme: curThemeId,
        timeOfDay: contractTheme.value.timeOfDay,
        clock: contractTheme.value.clock,
        actors: [],
        selection: null,
      };
    },

    setTheme(theme: string, _timeOfDay: number): void {
      curThemeId = theme || curThemeId;
    },

    setActors(_actors: readonly WsRenderActor[]): void {
      /* 叠加层不画立绘：角色仍由地图那层（2D 立绘/钉子）负责 —— 「除了渲染不一样，其他全一样」 */
    },

    setSelection(_sel: WsRenderSelection | null): void {
      /* 同 `three`：选择只搬运，不在这里画 */
    },

    async captureWorld(): Promise<WsRenderWorld | null> {
      /* 叠加层**不拥有世界数据**（地图一直在）⇒ 由地图后端去交接（舞台那边判） */
      return null;
    },

    pause(): void {
      detachDrive();
      state = "paused";
    },

    resume(): void {
      if (!renderer) return;
      state = "running";
      attachDrive();
    },

    destroy(): void {
      detachDrive();
      if (alignStaticTimer) window.clearTimeout(alignStaticTimer);
      alignStaticTimer = 0;
      try {
        alignBadge?.remove?.();
      } catch {
        /* ignore */
      }
      alignBadge = null;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      disposeMesh();
      try {
        map?.off?.("sourcedata", onSourceData);
      } catch {
        /* ignore */
      }
      try {
        renderer?.dispose?.();
        const gl = (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null;
        const lose = gl?.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null;
        if (lose?.loseContext) lose.loseContext();
      } catch {
        /* ignore */
      }
      try {
        renderer?.domElement?.remove?.();
      } catch {
        /* ignore */
      }
      renderer = null;
      scene = null;
      camera = null;
      host = null;
      map = null;
      state = "destroyed";
    },

    /**
     * **局部经纬度 → 屏幕像素**（§1.3 那条"同楼四角 ≤1.5 px"的判据要用它）。
     *
     * 为什么要有：叠加层的楼与 2D 底图必须**对得齐**，而"看着齐"不算判据 —— 得拿同一栋楼的
     * 同一个角，在地图那边 `map.project()` 与这边 `camera.project()` 各算一遍、比像素。
     * 这里投的是**地面点（y=0）**：底图上那个经纬度就在地面上。
     */
    projectLngLat(lng: number, lat: number): [number, number] | null {
      if (!THREE || !camera) return null;
      try {
        const { w, h } = sizeOf();
        const [x, z] = toLocal(Number(lng), Number(lat));
        const v = new THREE.Vector3(x, 0, z).project(camera);
        return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
      } catch {
        return null;
      }
    },

    /**
     * 给探针看的原始读数（**只读**）：这一帧叠加层实际画的那批楼是哪一批。
     *
     * 为什么要它：真机反馈"地图与叠加层的楼不是同一批、明显错位"。要判定是"同一批但投影错位"
     * 还是"两套不同的楼"，就得把**两边各自的 id 表**摆出来做差集 —— 猜没有意义。
     */
    diag(): { buildings: number; triangles: number; ids: string[]; idsCapped: boolean; source: string } {
      const ids = data?.featureIds ?? [];
      return {
        buildings: data?.stats.buildings ?? 0,
        triangles: data?.triangles ?? 0,
        ids,
        idsCapped: false,
        source: lastSource,
      };
    },

    /**
     * **上一次真的画出去那一帧**里，某个经纬度（地面 y=0）落在屏幕的哪儿。
     * 逐帧对拍要读的是"屏幕上是什么"，不是"现在是什么" —— 所以用快照矩阵手算，
     * 不借 three 的 `project()`（它算的是**当下**的相机）。
     */
    projectFromLastDraw(lng: number, lat: number): [number, number] | null {
      return this_projectFromLastDraw(lng, lat);
    },

    /** 自用对齐探针的读数（没开开关就是 null） */
    alignStats(): { on: boolean; cur: number; max: number; n: number; reports: number } | null {
      if (!alignOn) return null;
      return { on: true, cur: Number(alignCur.toFixed(3)), max: Number(alignMax.toFixed(3)), n: alignErrs.length, reports: alignReports };
    },

    /** 探针用：切换对齐模式（`render` = 同帧；`raf` = 各跑各的）——A/B 对比用 */
    setAlignMode(m: string): string {
      const want = m === "raf" ? "raf" : "render";
      if (want === alignMode) return alignMode;
      alignMode = want;
      detachDrive();
      attachDrive();
      return alignMode;
    },

    stats(): WsRenderStats {
      const st = data?.stats;
      return {
        backend: "overlay",
        draws,
        dpr: renderer?.getPixelRatio?.() ?? 1,
        fps: Math.round(fps * 10) / 10,
        rendering: state === "running",
        note: `${st?.buildings ?? 0} 栋（叠加在地图上） / ${data?.triangles ?? 0} 三角`
          + ` / 相机跟地图：${lastSeen ? "在跟" : "还没读到"}`
          + (errors.length ? ` / ⚠️ ${errors[0]}` : "")
          + alignNote(),
      };
    },
  } as WsRenderBackend & { bindMap(m: unknown): void; unbindMap(): void };
}
