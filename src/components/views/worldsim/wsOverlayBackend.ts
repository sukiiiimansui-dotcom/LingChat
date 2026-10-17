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

import { BLD_CAP, buildBldMeshData, outerRingsOf, type BldMeshData } from "./wsBldMesh";
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
import { FOV_Y, NEAR_M, camFrameOf, farOf, nearOf } from "./wsThreeCam";
import { matEq, projectPoint } from "./wsMatMul";
import { alignProbeOn, wsDiag, wsLiveMap } from "./wsRenderBackend";
import { fpsMark } from "./wsFpsProbe";

const THREE_PATH = "/ws3d/ws3dgl/vendor/three.min.js";
/** 每度多少米（与 `wsThreeCam.M_PER_DEG` 同口径；这里只用它做锚点漂移判断） */
const M_PER_DEG = 111319.49079327358;
/** 地图中心离锚点超过这个米数就重锚（局部平面框架的近似误差随距离平方涨） */
const REANCHOR_M = 2000;
/**
 * 地图自己那套楼的图层前缀（`wsDistrictScene.ts` 里逐字是 `bld-foot` / `bld-ext` /
 * `bld-roof` / `bld-equip` / `bld-line` 五个）。**只碰这一组**：底图/水面/绿地/路网/标签一律不碰。
 */
const BLD_LAYER_PREFIX = "bld";

/**
 * 像素取证的**绝对值下限**（真机 2026-10-17：`pix.alive = 1` 也放行过 ⇒ 闸太弱）。
 * 采样框 20×20（缓冲像素，最多 4 个点 + 2 条兜底横带 = 最多 2400 px）；
 * 真画出楼时读到的是几百~几千，1~2 个只是噪点/边角。比例那条见闸的第 ⑤ 条（`cover`）。
 */
const PIX_MIN_ALIVE = 40;

/**
 * **叠加层画布的 dpr 上限**（`?ovldpr=`，默认 3 = 与改造前一致）。
 *
 * 为什么要有：真机 2026-10-17「一拖动帧率就从 40 掉到 5-15」。叠加层画布在 dpr=3 时是
 * **3840×1734** 的缓冲，**填充率随 dpr² 走**（9 倍像素）；拖动时它每帧重画一遍。
 * 把叠加层单独压到 2 或 1.5 是最便宜的一档，用它做 A/B 就能把"填充率"与"别的开销"分开。
 */
function dprCapOf(): number {
  try {
    const v = Number(new URLSearchParams(location.search).get("ovldpr"));
    if (Number.isFinite(v) && v > 0.5 && v <= 4) return v;
  } catch {
    /* 读不到就用默认 */
  }
  return 3;
}

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

/**
 * **量具身份**：这把尺子自己改一次就 +1。
 *
 * 为什么非要它：真机回传是异步、跨版本混在一起看的 —— 没有版本号时，
 * "这条读数是新尺子量的还是旧尺子量的"只能靠猜，而两者的字段含义并不一样
 * （旧尺子的 `corner` 不过滤屏外点，读数不可比）。
 *   1 = 初版（`corner` 不过滤屏外点，无 `offScreen`/`fit`/`geom`）
 *   2 = 过滤屏外点 + `offScreen`/`centerErr`/`fit`/`raw`/`geom`
 *   3 = 叠加层藏起地图那套楼（读数含义随之变：屏上只剩一套楼）+ 回传带 `ver`/`search`
 *   4 = **矩阵口径修正**（"画出去那一帧"的投影原先按行主序读 = 转置口径，量出来的位置
 *       整个是错的，真机那批 844~1210 px 就是这么来的）+ `centerErr` 改成**发车前现算**
 *       + 回传带上下文/降级账（`ctx`/`engine`）。⚠️ **≤3 的读数与 ≥4 不可比。**
 *   5 = 加 `nameBind`（名字↔楼 id / 楼顶锚点 / 回退账）。⚠️ **≤4 没有这一栏**（不是 0）。
 */
const ALIGN_VER = 5;

/**
 * 自用开关：`?ovlpix=0` **关掉"像素取证"那一道**（默认开）。
 *
 * 为什么需要它：本机无头没有可用的 GPU（SwiftShader 下 `MeshBasicMaterial` 编译失败），
 * 叠加层**一像素都画不出来** ⇒ 像素取证永远不过 ⇒ 藏楼这套逻辑在**本机**就没法被闸驱动
 * （真机上它是过的：2026-10-16 真机回传 `hidLayers: 5` 就是证据）。
 * 关掉之后仍要求"几何建出来了 + 真的发过绘制调用 + 材质没有着色器诊断"三条，
 * 只是少了最后那道像素兜底；**默认开**，也只在自用闸里用。
 */
function pixProbeOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("ovlpix") === "0";
  } catch {
    return false;
  }
}

/** 自用开关：`?wsalign=1` 才装 */
export function alignProbeWanted(): boolean {
  /* 判定只在 `wsRenderBackend.alignProbeOn` 一处（名字层回传也读它，别写第二份） */
  return alignProbeOn();
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
  /** **累计画出去多少帧**（`drawOnce` 每次 +1；地图驱动的 `frames` 只数 map render，别混） */
  let drawsTotal = 0;
  let draws = 0;
  let fps = 0;
  let fpsAt = 0;
  let fpsFrames = 0;
  /** 每帧从地图读到的四量（**只是读数的缓存**，不是"我们的相机状态"） */
  let lastSeen: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null = null;
  let refreshTimer = 0;
  /** 重锚正在异步重建（别叠加第二次；也保证"锚点与网格同一刻切"） */
  let reanchorInFlight = false;
  /** 上一次重锚尝试的时刻（失败也别每帧重试：getData 是整份源，每帧拉一次会拖垮帧率） */
  let lastReanchorAt = 0;
  let reanchors = 0;
  let reanchorFails = 0;
  const errors: string[] = [];

  /* ── 上下文与降级计数（`?wsalign=1` 的回传要带着它们：真机"划着划着变成 2D 自绘路"要有账）── */
  /** 叠加层自己的 WebGL 上下文：建了几次、我们自己丢了几次、收到几个 lost/restored 事件 */
  let ovlCtxCreated = 0;
  let ovlCtxLost = 0;
  let ovlCtxLostEvents = 0;
  let ovlCtxRestoredEvents = 0;

  /** 页面上现在有几个画布（"越堆越多"是这台机器上出现过的故障形状） */
  function canvasCountNow(): number {
    try {
      return document.querySelectorAll("canvas").length;
    } catch {
      return -1;
    }
  }

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

  function fovYDeg(): number {
    return (FOV_Y * 180) / Math.PI;
  }

  /** 把"当前视野"写进一台相机（`syncCamera` 与量具的模型相机**共用这一份公式**） */
  function applyCamFrame(cam: Record<string, any>, v: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number }, w: number, h: number): void {
    const [cx, cz] = toLocal(v.center.lng, v.center.lat);
    const f = camFrameOf(cx, cz, v.radius, v.bearing, v.pitch);
    cam.position?.set?.(f.pos[0], f.pos[1], f.pos[2]);
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(f.xAxis[0], f.xAxis[1], f.xAxis[2]),
      new THREE!.Vector3(f.yAxis[0], f.yAxis[1], f.yAxis[2]),
      new THREE!.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2])
    );
    cam.quaternion?.setFromRotationMatrix?.(m);
    cam.near = nearOf(f.dist);
    cam.far = farOf(f.dist, v.radius);
    if (cam.aspect !== w / h) cam.aspect = w / h;
    cam.updateProjectionMatrix?.();
    cam.updateMatrixWorld?.(true);
  }

  /** 每帧：把地图的相机搬进 three（正解走 `wsThreeCam`，与独立那条路同一个模型） */
  function syncCamera(): void {
    if (!camera) return;
    const v = readMapView();
    if (!v) return;
    lastSeen = v;
    const { w, h } = sizeOf();
    applyCamFrame(camera as unknown as Record<string, any>, v, w, h);
  }

  /**
   * 地图自己那套楼的**图层 id 名单**（按样式里的真实顺序，只取 `bld` 打头的）。
   * 先 `getLayer` 确认层真的在 —— 不在的**不记**，免得出场时对一个不存在的层发指令。
   */
  function mapBldLayerIds(): string[] {
    const m = map as unknown as {
      getStyle?: () => { layers?: Array<{ id?: unknown }> } | undefined;
      getLayer?: (id: string) => unknown;
    } | null;
    if (!m?.getStyle || !m?.getLayer) return [];
    let all: unknown[] = [];
    try {
      all = m.getStyle()?.layers || [];
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const l of all) {
      const id = String((l as { id?: unknown })?.id ?? "");
      if (!id || !id.startsWith(BLD_LAYER_PREFIX)) continue;
      try {
        if (!m.getLayer(id)) continue;
      } catch {
        continue;
      }
      out.push(id);
    }
    return out;
  }

  /** 只认可见性四种合法值；拿不到（自定义样式/假地图）就当 `visible` */
  function normVisibility(v: unknown): string {
    return v === "none" || v === "visible" || v === "inherit" ? String(v) : "visible";
  }

  /**
   * 叠加层活着的时候把**地图自己那套楼**藏起来。
   *
   * 为什么：两套楼画的是同一批数据（同一份 `bld` 源、同一份高度口径），叠在一起就是
   * **同一栋楼画两遍** —— 边缘描边加深、颜色偏暗，镜头一动两套的**刷新时机也不一致**
   * （地图跟着瓦片走，叠加层要等 `sourcedata` + 防抖再重建），看上去就是"错位/走不一样远"。
   * 楼只留一套，另一套（three 那套）才有意义。
   *
   * 边界：**只碰 `bld` 打头的层**。底图、水面、绿地、路网、标签一律不动 —— 那些是叠加层
   * 不画的东西，藏了就是黑屏。每层进名单前先 `getLayer`，出场时逐项**照原值**还回去。
   */
  /** 延迟复读的定时器（同一时刻只挂一个） */
  let hideVerifyTimer = 0;
  /**
   * **1 秒后再读一遍**：真机上"写后立刻是 none、之后又 visible"说明**当时的复读不够**
   * （样式重载把层重建 / 读写不是同一个 style 对象）。这里 1 秒后复读全部已藏的层：
   * 全部仍 none ⇒ 这一轮算生效；任一层不是 ⇒ `hideDrift++`、记 ids、**重试一轮**。
   */
  function scheduleHideVerify(ms: number): void {
    if (hideVerifyTimer) return;                 /* 只挂一个 */
    hideVerifyTimer = window.setTimeout(() => {
      hideVerifyTimer = 0;
      const m = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
      if (!m?.getLayoutProperty || state === "destroyed") return;
      const bad: string[] = [];
      for (const id of hiddenLayers.keys()) {
        try {
          const v = m.getLayoutProperty?.(id, "visibility");
          const vs = v === undefined || v === null ? null : String(v);
          if (vs !== "none") bad.push(id);
        } catch {
          bad.push(id);
        }
      }
      if (!bad.length) return;
      hideDrift += 1;
      hideDriftIds = bad.slice(0, 8);
      if (hideRounds < 3) {
        hideRounds += 1;
        /* 重试：清掉这几层的记录（让补藏重新记原值），下一帧补藏会再写一次 */
        for (const id of bad) hiddenLayers.delete(id);
        hideSyncAt = 0;
        try { hideMapBuildings(); } catch { /* 下一帧再来 */ }
      }
    }, ms);
  }

  /**
   * **确认手里是屏幕当前那张地图**（真机 2026-10-17：`mapAlive.sameCanvas:false` ⇒
   * 我们的补藏全打在**旧实例**上，屏幕上那张图的楼一直没藏 ⇒ 用户看到"怪楼"）。
   * 判定：`wsLiveMap.get()` 给出的实例（宿主每次拿到/重建实例都登记）若与我们手里这个不同、
   * 且它有 `setLayoutProperty` ⇒ **重绑**：旧实例上尽力还原 → 换引用 → 订阅改挂 → 计数。
   */
  function ensureLiveMap(): boolean {
    let live: unknown = null;
    try { live = wsLiveMap.get(); } catch { live = null; }
    const cand = live as { setLayoutProperty?: unknown; on?: unknown; off?: unknown } | null;
    if (!cand || cand === (map as unknown) || typeof cand.setLayoutProperty !== "function") return true;
    /* 先摘旧实例的订阅 + 尽力还原（旧实例可能已经死了，失败不抛） */
    try { map?.off?.("sourcedata", onSourceData); map?.off?.("styledata", onStyleData); } catch { /* 旧实例可能已死 */ }
    try { restoreMapBuildings("rebind"); } catch { /* 旧实例可能已死 */ }
    hiddenLayers.clear();
    hidCount = 0;
    map = cand as unknown as OverlayMapLike;
    try { map.on?.("sourcedata", onSourceData); map.on?.("styledata", onStyleData); } catch { /* 新实例挂不上就下帧再试 */ }
    mapRebinds += 1;
    return true;
  }

  function hideMapBuildings(): void {
    ensureLiveMap();
    const m = map as unknown as {
      getLayoutProperty?: (id: string, k: string) => unknown;
      setLayoutProperty?: (id: string, k: string, v: unknown) => void;
    } | null;
    if (!m?.setLayoutProperty || state === "destroyed") return;
    /* 🔴 硬要求：**只有叠加层真的在画楼才允许藏**；否则立刻把地图那套还原（不许把画面弄空）。 */
    const gate = meshDrawingOk(false);
    hideGateOk = gate.ok;
    hideGateWhy = gate.why;
    if (!gate.ok) {
      restoreMapBuildings("guard:" + gate.why);
      return;
    }
    const now = new Set(mapBldLayerIds());
    /* ① 已经不在样式里的条目退掉（层被移走了，还它没意义） */
    for (const id of [...hiddenLayers.keys()]) if (!now.has(id)) hiddenLayers.delete(id);
    for (const id of now) {
      let prev = hiddenLayers.get(id);
      const known = hiddenLayers.has(id);
      try {
        const cur = m.getLayoutProperty?.(id, "visibility");
        const curS = cur === undefined || cur === null ? null : normVisibility(cur);
        if (known && curS === "none") continue;   /* 已经藏好了：一次写都不做 */
        if (!known) prev = curS;                  /* 头一次见：记下原值 */
        m.setLayoutProperty(id, "visibility", "none");
        /* **写完读回**（真机 2026-10-17：`hidLive` 报 5 层全 visible 而 `hideSyncs=35`
           —— 两个数不可能同时为真 ⇒ 加自校验：没生效就重试一次，再不行如实计数） */
        let back = m.getLayoutProperty?.(id, "visibility");
        let backS = back === undefined || back === null ? null : String(back);
        if (backS !== "none") {
          hideRetries += 1;
          m.setLayoutProperty(id, "visibility", "none");
          back = m.getLayoutProperty?.(id, "visibility");
          backS = back === undefined || back === null ? null : String(back);
          if (backS !== "none") {
            hideVerifyFailed += 1;
            continue;                            /* 没藏上：**不记进名单**（免得出场还原一个假账） */
          }
        }
      } catch {
        /* 单层失败不影响其它层（也不记进名单，免得还的时候报错）—— 但要计数，不许静默 */
        hideErrors += 1;
        continue;
      }
      if (!known) hiddenLayers.set(id, prev === undefined ? null : prev);
    }
    hidCount = hiddenLayers.size;
    hideSyncs += 1;
    lastHideAt = performance.now();
    hidesSinceStyle += 1;
    scheduleHideVerify(1000);
  }

  /** 出场：**倒序**把藏起来的楼逐项还原（与藏的顺序相反，成对出现；失败路径也走它） */
  function restoreMapBuildings(reason = "unspecified"): void {
    if (!hiddenLayers.size) return;
    restoreReasons[reason] = (restoreReasons[reason] || 0) + 1;
    const m = map as unknown as {
      setLayoutProperty?: (id: string, k: string, v: unknown) => void;
    } | null;
    const rows = [...hiddenLayers.entries()].reverse();
    if (m?.setLayoutProperty) {
      for (const [id, prev] of rows) {
        try {
          m.setLayoutProperty(id, "visibility", prev === null ? "visible" : prev);
        } catch {
          /* 单层失败不阻断其余还原 */
        }
      }
      restoredCount = rows.length;
    }
    hiddenLayers.clear();
    hidCount = 0;
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
  function rebuild(themeId: string, fcIn: WsRenderFc | null, nextAnchor: { lat: number; lng: number; cos: number } | null = null): void {
    /* 帧率采集的行为打点：几何重建是本模块最贵的一段（覆盖层低帧率窗口要能归因到这里） */
    fpsMark("overlay-rebuild");
    const fc = fcIn;
    /* 🔴 2026-10-17 真机"楼会变掉/多出奇怪的楼"：**锚点必须与网格同一刻切**。
       原来是先换全局 `anchor`、再异步重建 ⇒ 重建那几十~几百毫秒里，**旧网格（旧锚点坐标）**
       配着**新锚点相机**画，整体按锚点位移（最多 2 km）瞬移。
       现在：建网格用 `useAnchor`（目标锚点），建好换上网格的那一刻才 `anchor = nextAnchor`。 */
    const useAnchor = nextAnchor ?? anchor;
    const toLocalForBuild = (lng: number, lat: number): [number, number] => {
      const a = useAnchor;
      if (!a) return [0, 0];
      return [(lng - a.lng) * M_PER_DEG * a.cos, -(lat - a.lat) * M_PER_DEG];
    };
    /* 🔴 2026-10-16 真机"楼会变掉"那条：重建**必须是原子的** ——
       旧网格一直画着，新网格**先在本地建好**再一次性换上；只有"新网格是空的/建不出来"
       才允许把地图那套还原。原来先 `disposeMesh()`（屏幕上一瞬间没楼）+ 先 `restoreMapBuildings()`
       （地图那套又冒出来）⇒ 每次数据落图都闪一下，看起来就是"楼会变掉"。 */
    const next = fc
      ? buildBldMeshData({
          features: fc.features,
          toLocal: toLocalForBuild,
          themeId,
          cap: BLD_CAP,
        })
      : null;
    if (!THREE || !scene || !next || !next.triangles) {
      /* 新网格建不出来 ⇒ 老实换掉旧网格，并把地图那套**还回去**（宁可两套里少一套，也不许整屏没楼） */
      disposeMesh();
      data = null;
      hideGateOk = false;
      hideGateWhy = "重建出来是空的";
      restoreMapBuildings("rebuild-empty");
      return;
    }
    /* 一次性换上：先建好 three 对象，再掐掉旧的（中间没有"两个都不在"的帧） */
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(next.positions), 3));
    g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(next.colors), 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const newer = new THREE.Mesh(g, mat);
    newer.name = "ws-overlay-buildings";
    scene.add(newer);
    disposeMesh();                  /* 旧的这时候才退场（同一帧里完成） */
    fpsMark("mesh-swap");
    bldMesh = newer;
    data = next;
    /* 网格换好了 ⇒ 这一刻才切锚点（相机与网格从此又是同一个局部框架） */
    if (nextAnchor) anchor = nextAnchor;
    /* 网格帧采样点（最多 6 条）：楼心局部坐标（网格帧）+ 真实经纬度 */
    if (fc) {
    try {
      meshPts = [];
      const ids = next.featureIds.slice(0, 6);
      const byId = new Map<string, { lng: number; lat: number }>();
      for (const f3 of fc.features) {
        const g3 = (f3 as { geometry?: unknown }).geometry;
        const { rings } = outerRingsOf(g3);
        const p3 = rings[0]?.[0];
        if (p3) byId.set(String((f3 as { id?: unknown }).id ?? ""), { lng: p3[0], lat: p3[1] });
      }
      for (let i = 0; i < ids.length; i++) {
        const ll = byId.get(ids[i]!);
        const bx0 = next.boxes[i * 4]!, bz0 = next.boxes[i * 4 + 1]!, bx1 = next.boxes[i * 4 + 2]!, bz1 = next.boxes[i * 4 + 3]!;
        if (!ll || !(bx0 <= bx1) || !(bz0 <= bz1)) continue;
        meshPts.push({ id: ids[i]!, lng: ll.lng, lat: ll.lat, local: [(bx0 + bx1) / 2, (bz0 + bz1) / 2] });
      }
    } catch { meshPts = []; }
    }
    /* 覆盖面：**同一份 fc、同一个视野**两边各数一遍（楼少的根因要能一眼看出来） */
    if (fc) {
    try {
      const v = lastSeen || readMapView();
      const r2 = v ? v.radius * 1.25 : Number.POSITIVE_INFINITY;
      const inView = (x: number, z: number): boolean => Math.hypot(x, z) <= r2;
      let exp = 0;
      for (const f2 of fc.features) {
        const g = (f2 as { geometry?: unknown }).geometry;
        const { rings } = outerRingsOf(g);
        const p0 = rings[0]?.[0];
        if (!p0) continue;
        const xy = toLocal(p0[0], p0[1]);
        if (inView(xy[0], xy[1])) exp += 1;
      }
      let act = 0;
      const bx = next.boxes;
      for (let i = 0; i + 3 < bx.length; i += 4) {
        const cx = (bx[i]! + bx[i + 2]!) / 2;
        const cz = (bx[i + 1]! + bx[i + 3]!) / 2;
        if (inView(cx, cz)) act += 1;
      }
      cover.expected = exp;
      cover.actual = act;
      cover.srcAll = fc.features.length;
      cover.meshAll = next.stats.buildings;
      cover.thinDropped = next.stats.thinDropped;
      cover.shapeDropped = next.stats.shapeDropped;
      cover.judgedAt = performance.now();
      /* 视野外（我们画了、但不在当前视野半径内）—— 真机"多出奇怪的楼"先看这两个数：
         `meshOut` = 网格里落在视野外的栋数（跨视野累积仓库的主要来源），
         `srcOut` = 源里视野外的要素数（它不为 0 是**累积仓库的设计**，不是 bug）。 */
      cover.meshOut = Math.max(0, next.stats.buildings - act);
      cover.srcOut = Math.max(0, fc.features.length - exp);
      try {
        const hs = next.featureMeta.map((m) => Number(m.h3d)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
        const q = (pp: number): number => (hs.length ? hs[Math.min(hs.length - 1, Math.max(0, Math.floor(hs.length * pp)))]! : 0);
        meshHeights = { n: hs.length, p10: Number(q(0.1).toFixed(2)), p50: Number(q(0.5).toFixed(2)), p90: Number(q(0.9).toFixed(2)), flat: Number((hs.filter((h) => h < 3).length / Math.max(1, hs.length)).toFixed(3)) };
      } catch { meshHeights = null; }
    } catch {
      /* 数不出来就不判（宁可漏，不误判） */
      cover.expected = 0;
      cover.actual = 0;
    }
    }
    /* 数据是**后到**的 ⇒ 重建完立刻画一帧：渲染是"地图画完一帧"驱动的，地图静止时不会再来
       render，等它就等于这一批楼不显示。 */
    drawOnce();
  }

  /** 从地图 source 里现捞一份 `bld`（拿不到就 null —— 不编数据） */
  async function grabBld(): Promise<WsRenderFc | null> {
    try {
      const src = map?.getSource?.("bld");
      if (!src?.getData) return null;
      getDataCalls += 1;
      const d = (await src.getData()) as WsRenderFc | null;
      if (!d || !Array.isArray(d.features)) return null;
      return { type: "FeatureCollection", features: d.features };
    } catch {
      return null;
    }
  }

  /** 后到的数据自己补上（`bld` 落图 ⇒ 重建）；防抖，别在一次落图里重建十遍 */
  function scheduleRefresh(): void {
    refreshScheduled += 1;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc);
          refreshDone += 1;
          lastRefreshMs = performance.now();
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
  }

  const onSourceData = (e: { sourceId?: string }): void => {
    if (e?.sourceId !== "bld") return;
    srcDataEvents += 1;
    /* 楼图层可能**刚刚才建出来**（冷启动直接进叠加层），也可能被"源在层缺"的看门狗补回来
       ⇒ 每一次落图都补一次藏（幂等：已经藏好时一次写都不做）。 */
    hideMapBuildings();
    scheduleRefresh();
  };

  /**
   * 样式变了（含**上下文丢失后的样式重建**、主题切换）：楼图层可能整批换新 ⇒ 补藏一次。
   * 我们自己 `setLayoutProperty` 也会触发它 —— 那种情况下层已经是 `none`，补藏是空转，不会自激。
   */
  const onStyleData = (): void => {
    styleDataEvents += 1;
    lastStyleAt = performance.now();
    styleDataStamps.push(Math.round(lastStyleAt));
    if (styleDataStamps.length > 20) styleDataStamps.shift();
    /* 事件里**立刻**补藏一次（hidesSinceStyle 会在补藏末尾 +1 ⇒ 能看出"补藏在事件之后"） */
    hidesSinceStyle = 0;
    hideMapBuildings();
  };

  let curThemeId = "anime";
  /* ── 自用对齐探针的状态（`?wsalign=1` 才用；默认全是空转） ── */
  const alignOn = alignProbeWanted();
  let alignCorner: [number, number] | null = null;
  const alignErrs: number[] = [];
  /** 逐帧 `(离画布中心多少像素, 误差)` —— 用来分清"误差∝距离(比例差)"与"误差≈常数(整体偏移)" */
  const alignPairs: Array<{ d: number; e: number }> = [];
  /** 屏外 / 相机背后 / 投不出来的样本：**单独计数、不进 cur·med·max** */
  let alignOffScreen = 0;
  /** 地图中心那一点的两边投影差（**基准点**：不为 0 就说明相机/画布基准有问题，不是尺度） */
  let alignCenterErr: number | null = null;
  let alignRaw: Array<{ mx: number; my: number; ox: number; oy: number; d: number; e: number }> = [];
  let alignMax = 0;
  let alignCur = 0;
  let alignReports = 0;
  let alignLastReportAt = 0;
  let alignStaticTimer = 0;
  let alignBadge: HTMLElement | null = null;
  /**
   * 这一次 overlay 活着期间**藏起来的**地图楼图层：`id → 原值`（`null` = 原来没设过）。
   * 用 `Map` 而不是数组：楼图层会**后到**（冷启动 `?renderer=overlay` 时样式里还没有它们，
   * 上下文丢失后的看门狗还会把它们补回来）⇒ 需要"随时再查一遍、只补新出现的"这种幂等操作。
   * 插入顺序 = 藏的顺序 ⇒ 还原时倒着走。
   */
  const hiddenLayers = new Map<string, string | null>();
  /** 藏/还原各几层（进 `stats`：**不许静默**） */
  let hidCount = 0;
  let restoredCount = 0;
  /**
   * **藏楼闸**：只有"叠加层真的在画楼"才允许藏地图那套楼。
   *
   * 为什么（2026-10-16 真机事故）：藏楼原来只与"overlay 是当前后端"绑定 ⇒ 叠加层起不来 /
   * 数据没到 / 网格建不出来 / 着色器编不过（本机靶场实测过 `MeshBasicMaterial`
   * `VALIDATE_STATUS false`）/ 画了 0 栋 —— 任何一种都会让**屏幕上一栋楼都没有**
   * （地图那套被藏了、叠加层这套又没画出来）。这条闸把它绑到"**有效绘制**"上。
   */
  let hideGateOk = false;
  let hideGateWhy = "还没画过";
  /** 上一次像素取证的时间（节流：别每帧都 readPixels） */
  let pixProbeAt = 0;
  /** 上一次像素读数（给报告/探针看：本机到底有没有画出像素） */
  let pixAlive = -1;
  /** 上一次"补藏/补还原"的时间（节流：别每帧走一遍 `getStyle()`） */
  let hideSyncAt = 0;
  /** 像素取证连续判空几次（**两振才出局**：单次读空可能只是抖动，立刻还原会造成"楼会变掉"的闪） */
  let pixStrikes = 0;
  /**
   * **覆盖面**（2026-10-17 真机："整屏只有一栋楼"）：`actual` 是我们网格里**落在视野内**的楼数，
   * `expected` 是地图源里**落在视野内**的要素数（同一份数据、同一个视野）。
   * 楼少到 `actual*2 < expected` 就当作"没画够" ⇒ 还原地图那套（不许静默：数进 note 与回传）。
   */
  /** 网格里每栋楼的高度分布（给名字层"楼顶投影 vs 楼本来就是平的"那条判据） */
  let meshHeights: { n: number; p10: number; p50: number; p90: number; flat: number } | null = null;
  /**
   * "网格帧采样点"：建网格时记下**几条**楼心的局部坐标（网格自己的帧）与它们的真实经纬度。
   * 用途（重锚窗口闸）：同一时刻用**画出去那一帧**的矩阵分别投这两个坐标 ——
   * 网格帧与相机帧一致时两者重合；锚点被提前切了就会差出锚点位移（最多 2 km）。
   */
  let meshPts: Array<{ id: string; lng: number; lat: number; local: [number, number] }> = [];
  const cover: { expected: number; actual: number; srcAll: number; meshAll: number; thinDropped: number; shapeDropped: number; judgedAt: number; meshOut: number; srcOut: number } =
    { expected: 0, actual: 0, srcAll: 0, meshAll: 0, thinDropped: 0, shapeDropped: 0, judgedAt: 0, meshOut: 0, srcOut: 0 };
  /** 覆盖面连续判短几次（**两振才出局**：源刚长出来、网格还没跟上时会短暂偏短） */
  let coverStrikes = 0;
  /** 数据通道的账（"为什么只画出一栋"要能查：调度了几次 / 完成几次 / 取了几次数） */
  let refreshScheduled = 0;
  let refreshDone = 0;
  /** 地图事件来的次数（真机"藏了又被显示"要查是不是 style/data 事件在反复触发重建） */
  let srcDataEvents = 0;
  let styleDataEvents = 0;
  let getDataCalls = 0;
  let lastRefreshMs = -1;
  /** 藏/还原各发生了多少次、**为什么**（真机上"楼会变掉"要能查账） */
  let hideSyncs = 0;
  /** 藏楼自校验的账：重试几次 / 写完读回仍不是 none 的层数 / 写入抛错次数（都不许静默） */
  let hideRetries = 0;
  /** 重绑次数（地图实例/画布被换过 ⇒ 重新绑到屏幕当前那张上） */
  let mapRebinds = 0;
  /** 名字层 DOM 写入次数（MutationObserver，只读）；名字节点现数在回传时取 */
  let labelWrites = 0;
  let labelObs: MutationObserver | null = null;
  /**
   * **藏楼"漂移"**（真机 2026-10-17：写后立刻读是 none，之后又变 visible）
   * —— 写后立刻复读只能证明"那一刻"，证不了"之后"。所以再挂一次**延迟复读**（1 秒后）：
   * 任一层不是 none ⇒ `hideDrift++`、记下是哪几层、并**重试**（最多 3 轮，防死循环）。
   */
  let hideDrift = 0;
  let hideDriftIds: string[] = [];
  let hideRounds = 0;
  /** 样式/数据事件的最近时刻与"补藏发生在事件之后"的计数（判"补藏在事件序列里的位置"） */
  let lastStyleAt = 0;
  let lastHideAt = 0;
  let hidesSinceStyle = 0;
  let styleDataStamps: number[] = [];
  let hideVerifyFailed = 0;
  let hideErrors = 0;
  const restoreReasons: Record<string, number> = {};

  /**
   * 叠加层"真的画出了东西"吗 —— 四个条件都过才算数（任一不过 ⇒ **不藏 / 立刻还原**）：
   *   ① 几何建出来了（`buildings > 0 && triangles > 0`）；
   *   ② 真的发出过绘制调用（`draws > 0`）；
   *   ③ 材质**没有**着色器诊断（three 在编译/链接失败时会给 material 挂 `.diagnostics`）；
   *   ④ 像素取证：抽两条横带 `readPixels`，看得见非透明像素（这是"屏幕上真有东西"的地面真值）。
   * 读不出来的 API（老 three / 假地图）不当作通过 —— 宁可**不藏**，也不许把画面弄空。
   */
  let pixEverProbed = false;
  /** 像素取证**真跑了几次**（帧预算闸用它证"没有每帧 readPixels"） */
  let pixProbesRun = 0;
  /** 像素取证的 **last good result**（节流期间复用；`ok=false` 时 why 用于还原原因） */
  let pixOk = false;
  let pixWhy = "还没量";
  /**
   * 探针**节流**（2026-10-17 真机 fps 从 7~16 掉到 1.4~3 的头号原因）：
   * `readPixels` 是**同步 GPU 读回**，每帧一次就能把手机打到个位数 fps。
   * 现在：还没藏楼时 500ms 最多一次（要能尽快建立"在画"的证据）；
   * 已经藏稳了 5s 一次（守卫的活是**发现状态变化**，不是每帧验像素）。
   * 几何/覆盖/材质诊断那三条是**纯 JS**，仍然每帧判（很便宜）。
   */
  const PIX_PROBE_START_MS = 500;
  const PIX_PROBE_STEADY_MS = 5000;
  function meshDrawingOk(probePixels: boolean): { ok: boolean; why: string; kind: "ok" | "geom" | "draws" | "shader" | "pix" | "cover" } {
    /* ①②③ 纯 JS、每帧都可以判（很便宜） */
    if (!data || !(data.stats.buildings > 0) || !(data.triangles > 0)) {
      return { ok: false, why: "叠加层还没建出楼（0 栋）", kind: "geom" };
    }
    if (!(draws > 0)) return { ok: false, why: "叠加层还没发出绘制调用", kind: "draws" };
    /* ④' **实例校验**：手里不是屏幕当前那张地图 ⇒ 不许继续藏（藏的可能是旧画布）。
       先尝试重绑；重绑后由下一次补藏在新实例上重做。 */
    try {
      const live = wsLiveMap.get();
      if (live && live !== (map as unknown) && typeof (live as { setLayoutProperty?: unknown }).setLayoutProperty === "function") {
        return { ok: false, why: "地图实例已换（手里是旧的，先重绑）", kind: "pix" };
      }
    } catch { /* 登记处读不到就不判 */ }
    const mat = (bldMesh as unknown as { material?: { diagnostics?: unknown } } | null)?.material;
    if (mat && (mat as { diagnostics?: unknown }).diagnostics) {
      return { ok: false, why: "叠加层着色器报错（材料诊断有内容）", kind: "shader" };
    }
    /* ⑤ **画得够不够**（比例判据）：同一份源、同一个视野，源内要素数 vs 网格内楼数。
       实画×2 < 源（且源≥4）⇒ 先"往前修"（补一次数据重建），连续两次仍短 ⇒ 才真还原。
       阈值取一半的理由：两套读同一份源，我们只能合法丢掉"建不出体块"的（扁到 top-base<0.4 /
       轮廓退化），正常比例很低（夹具 135 栋实测 0 栋）；掉到一半以下就是结构性少（1 对 40）。 */
    if (cover.expected >= 4 && cover.actual * 2 < cover.expected) {
      coverStrikes += 1;
      if (coverStrikes === 1) {
        scheduleRefresh();
        return { ok: false, why: "画得太少（源 " + cover.expected + " / 实画 " + cover.actual + "）· 已补一次数据", kind: "cover" };
      }
      return { ok: false, why: "画得太少（源 " + cover.expected + " / 实画 " + cover.actual + " · 第 " + coverStrikes + " 次）", kind: "cover" };
    }
    coverStrikes = 0;
    /* ④ 像素取证（**最贵**的一条）：只在 `drawOnce` 刚画完那一刻读，并且**节流**。
       `readPixels` 是同步 GPU 读回 —— 每帧一次就能把手机打到个位数 fps（真机 2026-10-17 实测）。 */
    if (!probePixels) {
      if (!pixEverProbed) return { ok: false, why: "还没在画完那一刻取过像素证据", kind: "pix" };
      return { ok: pixOk, why: pixWhy, kind: pixOk ? "ok" : "pix" };
    }
    const nowMs = performance.now();
    const due = nowMs - pixProbeAt >= (hideGateOk ? PIX_PROBE_STEADY_MS : PIX_PROBE_START_MS);
    if (pixEverProbed && !due) return { ok: pixOk, why: pixWhy, kind: pixOk ? "ok" : "pix" };
    pixProbeAt = nowMs;
    pixEverProbed = true;
    pixProbesRun += 1;
    if (pixProbeOff()) {
      pixAlive = -2;                     /* -2 = 没量（自用开关关掉） */
      pixStrikes = 0;
      pixOk = true;
      pixWhy = "画了（像素取证=关 ?ovlpix=0）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    const gl = (() => { try { return (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null; } catch { return null; } })();
    if (!gl?.readPixels) {
      pixOk = true;
      pixWhy = "画了（像素取证不可用）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    let alive = 0;
    /* 帧率采集的行为打点：同步 GPU 读回是整帧里最贵的一步，单独打一个标签 */
    fpsMark("pixel-probe");
    try {
      const dpr = renderer?.getPixelRatio?.() ?? 1;
      const bw = Math.max(1, Math.round(w0() * dpr));
      const bh = Math.max(1, Math.round(h0() * dpr));
      const readRect = (x: number, y: number, w2: number, h2: number): number => {
        const buf = new Uint8Array(w2 * h2 * 4);
        gl.readPixels(x, y, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let n = 0;
        for (let i = 3; i < buf.length; i += 4) if (buf[i]! > 8) n++;
        return n;
      };
      /* 按**我们自己的网格**采样：楼在屏幕上稀疏（地面透明），横带容易扫空 ⇒
         拿每栋楼的 XZ 包围盒中心，用"画出去那一帧"的矩阵投到屏幕，在投出来的点周围读一小块。
         🔴 采样点是 **CSS 像素**、`readPixels` 要**缓冲像素** ⇒ 必须乘 dpr（真机 dpr=3 时
         不乘就偏到 1/3 处，常年只读到 1 个像素——真机序列 1,1,1,1100,1,… 就是这个形状）。 */
      const step = Math.max(1, Math.ceil(((data?.boxes?.length ?? 0) / 4) / 1)) || 1;
      const samplePts: Array<[number, number]> = [];
      try {
        const boxes = data?.boxes ?? [];
        for (let i = 0; i + 3 < boxes.length && samplePts.length < 4; i += 4 * step) {
          const cx2 = (boxes[i]! + boxes[i + 2]!) / 2;
          const cz2 = (boxes[i + 1]! + boxes[i + 3]!) / 2;
          const p = projectFromLastDrawLocal(cx2, cz2);
          if (p && p[0] >= 12 && p[0] <= bw - 12 && p[1] >= 12 && p[1] <= bh - 12) samplePts.push(p);
        }
      } catch {
        /* 采样点算不出来就走兜底横带 */
      }
      /* **最多 2 个** 20×20 的框（400 px/框）；不读整条横带（dpr=3 时一条 61 KB）。 */
      let probes = 0;
      for (const [x, y] of samplePts) {
        const bxp = Math.round(x * dpr);
        const byp = bh - Math.round(y * dpr);
        alive += readRect(bxp - 10, byp - 10, 20, 20);
        probes += 1;
        if (alive >= PIX_MIN_ALIVE || probes >= 2) break;
      }
      /* 兜底：采样点一个都没投出来时，读**一条**窄横带（1~2 行） */
      if (alive <= 0 && !samplePts.length) {
        const rows = Math.max(1, Math.min(2, Math.floor(bh / 200)));
        const y = Math.max(0, Math.min(bh - rows, Math.round(bh * 0.5)));
        alive += readRect(0, y, bw, rows);
      }
    } catch {
      pixOk = true;
      pixWhy = "画了（像素取证抛错）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    if (alive < PIX_MIN_ALIVE) {
      pixStrikes += 1;
      pixOk = false;
      pixWhy = "像素太少（" + alive + " < " + PIX_MIN_ALIVE + " · 第 " + pixStrikes + " 次）";
      return { ok: false, why: pixWhy, kind: "pix" };
    }
    pixStrikes = 0;
    pixAlive = alive;
    pixOk = true;
    pixWhy = "画了（" + alive + " 个非空像素）";
    return { ok: true, why: pixWhy, kind: "ok" };
  }

  /** 局部米坐标 → 屏幕像素（用**画出去那一帧**的矩阵；只给像素取证的采样点算位置） */
  function projectFromLastDrawLocal(x: number, z: number): [number, number] | null {
    if (!lastDraw) return null;
    return projectPoint(lastDraw.mwInv, lastDraw.proj, [x, z], lastDraw.w, lastDraw.h);
  }

  /** 画布 CSS 尺寸（`sizeOf` 是函数声明，这里给闸用同一份） */
  function w0(): number { return sizeOf().w; }
  function h0(): number { return sizeOf().h; }

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
  /** 上面那组快照是**哪一刻**取的（毫秒，`performance.now()`）—— 判"读数是不是旧帧"要用它 */
  let lastDrawAt = 0;
  /** 这一帧那批楼**从哪儿来**（`world` = 舞台交进来的那份 / `source` = 从地图 source 现捞的） */
  let lastSource = "none";

  /** 真的画一帧（并把"画的时候"的相机矩阵快照下来 —— 逐帧对拍读的就是它） */
  function drawOnce(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const { w, h } = sizeOf();
    lastDrawAt = performance.now();
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
    drawsTotal += 1;
    draws = renderer.info?.render?.calls ?? 0;
    /* 画完立刻过一遍藏楼闸：**首帧、重建后、以及"还一层都没藏"时**都要查（节流在闸里） */
    try {
      if (draws > 0) {
        /* 每帧先确认"手里是屏幕当前那张地图"（比较一次，开销可忽略；不同才重绑）。
           否则闸会判"实例已换" ⇒ 软失败 ⇒ 永远走不到补藏 ⇒ 也就永远不重绑（自锁）。 */
        ensureLiveMap();
        const gate = meshDrawingOk(true);
        hideGateOk = gate.ok;
        hideGateWhy = gate.why;
        const now2 = performance.now();
        /* ❗"立刻还原"这条**不受节流约束**（画面变空必须当帧处理）；补藏才节流 */
        /* 两类"可先往前修"的判据（**两振出局**），其余条件仍是当帧立刻还原：
           · `pix`：单次读空/偏少可能只是采样点没落上（我原来靠字符串子串判，消息一改就失效，
             真机上因此**单次 0 就读成"立刻还原"**，7 次还原 = 楼闪 7 次）；
           · `cover`：源刚长出来、网格还没跟上时也会短暂偏少。 */
        const soft = !gate.ok && ((gate.kind === "pix" && pixStrikes < 2) || (gate.kind === "cover" && coverStrikes < 2));
        if (!gate.ok && !soft) {
          if (hiddenLayers.size) restoreMapBuildings("guard-draw:" + gate.why);
        } else if (gate.ok && now2 - hideSyncAt > 400) {
          hideSyncAt = now2;
          if (hiddenLayers.size !== mapBldLayerIds().length) hideMapBuildings();
        }
      }
    } catch {
      /* 闸自己抛错不许影响渲染；下一次再来 */
    }
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

  /**
   * 当前那一帧的像素差（地图当下 vs 叠加层上次画出去那一帧）。
   *
   * 🔴 2026-10-11 改（真机那 8 条回传暴露的问题）：原来**什么点都计**，而目标角可能早就跑到
   * 屏幕外 1.1 km（真机 `center.lat` 与 `corner.lat` 差 0.0102°），在高俯仰下两套投影只要略有
   * 差异就会被放大成几百像素 ⇒ `cur/med/max` 全被"远点在俯视下的放大"主导，没有意义。
   * 现在：**只统计落在画布内（留边距）的点**；屏外/相机背后/投不出来的**单独计数**（`offScreen`），
   * 不进 cur·med·max。同时记 `dPx`（离画布中心多少像素）与中心基准点误差。
   */
  function alignSample(): void {
    if (!alignOn || !alignCorner || !map) return;
    const m = map as unknown as {
      project?: (c: [number, number]) => { x: number; y: number };
      getCenter?: () => { lat: number; lng: number };
    } | null;
    const { w, h } = sizeOf();
    /* 基准点：地图中心那一点。它必须 ≈0 —— 不为 0 说明相机/画布基准不对，与"尺度/远近"无关。 */
    try {
      const c = m?.getCenter?.();
      if (c) {
        const a0 = m?.project?.([c.lng, c.lat]);
        const b0 = this_projectFromLastDraw(c.lng, c.lat);
        if (a0 && b0) alignCenterErr = Math.hypot(a0.x - b0[0], a0.y - b0[1]);
      }
    } catch {
      /* 基准点量不到就先不算（不影响屏内点那一组） */
    }
    const a = m?.project?.(alignCorner);
    const b = this_projectFromLastDraw(alignCorner[0], alignCorner[1]);
    const cx = w / 2;
    const cy = h / 2;
    const inView = (x: number, y: number): boolean => x >= 8 && x <= w - 8 && y >= 8 && y <= h - 8;
    if (!a || !b) {
      alignOffScreen++;
      return;
    }
    if (!inView(a.x, a.y) || !inView(b[0], b[1])) {
      /* 地图那侧或叠加层那侧把这个点投到屏外/背后 ⇒ 排除（两边都得在屏内才有可比性） */
      alignOffScreen++;
      return;
    }
    const e = Math.hypot(a.x - b[0], a.y - b[1]);
    const dPx = Math.hypot(a.x - cx, a.y - cy);
    alignCur = e;
    alignErrs.push(e);
    alignPairs.push({ d: dPx, e });
    if (alignErrs.length > 240) alignErrs.shift();
    if (alignPairs.length > 240) alignPairs.shift();
    if (e > alignMax) alignMax = e;
    if (alignRaw.length < 3) alignRaw.push({ mx: Number(a.x.toFixed(2)), my: Number(a.y.toFixed(2)), ox: Number(b[0].toFixed(2)), oy: Number(b[1].toFixed(2)), d: Number(dPx.toFixed(2)), e: Number(e.toFixed(2)) });
    alignBadgePaint();
    const now = performance.now();
    if (now - alignLastReportAt > 2000) alignFlush("moving");
  }

  /** 最小二乘拟合 `err ≈ a + b·dPx`：`a` 大 = 整体偏移；`b` 大 = 比例/尺度差 */
  function alignFit(): { a: number; b: number; n: number } | null {
    const ps = alignPairs;
    if (ps.length < 4) return null;
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (const p of ps) { sx += p.d; sy += p.e; sxx += p.d * p.d; sxy += p.d * p.e; }
    const n = ps.length;
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;
    const b = (n * sxy - sx * sy) / den;
    const a = (sy - b * sx) / n;
    return { a: Number(a.toFixed(3)), b: Number(b.toFixed(4)), n };
  }

  /** 回传一条（`moveend` 必发；其余按 2 秒节流） */
  function alignFlush(kind: string): void {
    if (!alignOn || !alignCorner) return;
    /* 中心误差**在发车前现算一遍**：徽标上的 `中心` 是逐帧刷的，回传是每 2 秒/moveend 才发，
       两个数差得远时无从判断"是不是同一个量"。这里钉死：回传里的 `centerErr` 就是**这一刻**的值。 */
    try {
      const mm = map as unknown as { project?: (c: [number, number]) => { x: number; y: number }; getCenter?: () => { lat: number; lng: number } } | null;
      const c = mm?.getCenter?.();
      if (c) {
        const p0 = mm?.project?.([c.lng, c.lat]);
        const p1 = this_projectFromLastDraw(c.lng, c.lat);
        if (p0 && p1) alignCenterErr = Math.hypot(p0.x - p1[0], p0.y - p1[1]);
      }
    } catch {
      /* 现算失败就沿用上一次的（如实：它仍是个数，只是不是这一刻的） */
    }
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
    /* 藏楼之后**地图的命中查询还答不答得出来**（"点楼"会不会哑）—— 成对读数：
       ① `hid`：现在的状态（楼藏着）在屏幕正中查一次；
       ② `shown`：**当场把藏起来的楼放回来**再查一次，然后立刻按原值藏回去
          （三步都在同一个 JS 任务里 ⇒ 中间不会渲染出一帧 ⇒ 不会露楼）。
       两个数一比就能分开："藏楼把命中弄哑了"（hid=0 而 shown>0）还是"地图自己就答不出来"
       （两个都是 0 ⇒ 是样式/渲染那边的事，不是藏楼）。 */
    let pick: Record<string, unknown> | null = null;
    try {
      const { w, h } = sizeOf();
      const m = map as unknown as {
        queryRenderedFeatures?: (p: [number, number], o?: unknown) => Array<{ layer?: { id?: string } }>;
        setLayoutProperty?: (id: string, k: string, v: unknown) => void;
      };
      if (m?.queryRenderedFeatures) {
        const at: [number, number] = [w / 2, h / 2];
        const count = (feats: Array<{ layer?: { id?: string } }>): { n: number; bld: number; byLayer: Record<string, number> } => {
          const byLayer: Record<string, number> = {};
          let bld = 0;
          for (const f of feats) {
            const id = String(f?.layer?.id ?? "?");
            byLayer[id] = (byLayer[id] || 0) + 1;
            if (id.startsWith(BLD_LAYER_PREFIX)) bld++;
          }
          return { n: feats.length, bld, byLayer };
        };
        const hid = count(m.queryRenderedFeatures(at) || []);
        let shown: Record<string, unknown> | null = null;
        const ids = [...hiddenLayers.keys()];
        if (ids.length && m.setLayoutProperty) {
          let err = "";
          for (const id of ids) { try { m.setLayoutProperty(id, "visibility", "visible"); } catch (e) { err += String((e as Error)?.message || e) + ";"; } }
          try {
            shown = count(m.queryRenderedFeatures(at) || []);
          } catch (e) {
            shown = { n: null, err: String((e as Error)?.message || e) };
          }
          /* 立刻按**原值**藏回去（倒序，与出场同一套口径） */
          for (const [id, prev] of [...hiddenLayers.entries()].reverse()) {
            try { m.setLayoutProperty(id, "visibility", prev === null ? "visible" : prev); } catch { /* 单层失败不阻断 */ }
          }
          if (err) shown = { ...(shown || {}), err };
        }
        /* 源侧交叉确认（真机 2026-10-17：`shown.n=0` ⇒ 要分清"藏楼把命中弄哑"还是"源/渲染本身没东西"） */
        let srcQ: number | null = null;
        try {
          const q = (map as unknown as { querySourceFeatures?: (id: string) => unknown[] })?.querySourceFeatures?.("bld");
          srcQ = Array.isArray(q) ? q.length : null;
        } catch { srcQ = null; }
        pick = { hid, shown, at, hiddenIds: ids, srcQuerySource: srcQ, srcAll: cover.srcAll, meshAll: cover.meshAll };
      } else {
        pick = { hid: null, why: "no-query" };
      }
    } catch (e) {
      pick = { hid: null, err: String((e as Error)?.message || e) };
    }
    const sorted = [...alignErrs].sort((x, y) => x - y);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    /* 🆕 **画布几何**（下一号嫌疑）：两套投影在纯数学上已经逐点 ≤0.005 px（见
       world_map/ws_proj_table_probe.mjs 那张表）⇒ 屏上若真错开，只剩"两块画布不一样大/
       不一样位/不一样 DPR"这类**非数学**因素。这里把它们如实报出去。 */
    let geom: Record<string, unknown> | null = null;
    try {
      const doc = document;
      const mapCv = doc.querySelector(".maplibregl-canvas") || doc.querySelector(".ws-dml__cv");
      const ovlCv = renderer?.domElement as HTMLCanvasElement | undefined;
      const box = (el: Element | null | undefined): unknown => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const c = el as HTMLCanvasElement;
        return {
          cls: String((el as HTMLElement).className || ""),
          rect: [Number(r.left.toFixed(2)), Number(r.top.toFixed(2)), Number(r.width.toFixed(2)), Number(r.height.toFixed(2))],
          buf: [c.width ?? null, c.height ?? null],
          style: [(el as HTMLElement).style?.width || "", (el as HTMLElement).style?.height || ""],
        };
      };
      geom = { dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : null, map: box(mapCv), overlay: box(ovlCv) };
    } catch {
      geom = null;
    }
    alignReports++;
    alignLastReportAt = performance.now();
    beacon({
      /* 量具身份：`ver` = 尺子版本，`search` = 这份读数是在什么参数下取的 */
      ver: ALIGN_VER,
      search: (() => {
        try {
          return String(location.search || "");
        } catch {
          return "";
        }
      })(),
      kind,
      corner: alignCorner,
      cur: Number(alignCur.toFixed(3)),
      max: Number(alignMax.toFixed(3)),
      med: med === null ? null : Number(med.toFixed(3)),
      n: alignErrs.length,
      /* 🆕 屏外计数（**不进 cur·med·max**）+ 中心基准点 + (dPx,err) 拟合 + 至少 3 组原始屏幕坐标 */
      offScreen: alignOffScreen,
      centerErr: alignCenterErr === null ? null : Number(alignCenterErr.toFixed(3)),
      fit: alignFit(),
      raw: alignRaw.slice(-3),
      geom: geom,
      reports: alignReports,
      center: m?.getCenter?.() ?? null,
      zoom: m?.getZoom?.() ?? null,
      bearing: m?.getBearing?.() ?? null,
      pitch: m?.getPitch?.() ?? null,
      mppRatio,
      bld: data?.stats.buildings ?? 0,
      tris: data?.triangles ?? 0,
      /* 藏了地图哪几层楼（"两层楼叠着"那件事真机上到底成没成，看这一栏） */
      hidLayers: hidCount,
      hidIds: [...hiddenLayers.keys()],
      /* 藏楼闸的现况（真机事故：藏了地图那套、叠加层又没画出来 ⇒ 整屏没楼） */
      /* ⚠️ `draws` 是**上一帧的绘制调用数**（three 的 `info.render.calls` 每帧重置），
         **不是累计值** —— 真机那 23 条"draws 恒为 1"就是这么来的（一帧画 1 次）。
         要知道"到底在不在出帧"看 `frames`（累计）与 `drawGapMs`（距上次画多久）。 */
      /* `frames` = **地图驱动的帧**（map render 回调）；`drawsTotal` = **累计真画了几帧**
         （含重建后补画的那一帧）—— 两者别混。 */
      hidGate: { ok: hideGateOk, why: hideGateWhy, draws: draws, frames, drawsTotal, drawGapMs: lastDrawAt ? Math.round(performance.now() - lastDrawAt) : null },
      /* 重锚账（默认模式下重锚是新接上的路：跑了几次、失败几次） */
      reanchor: { count: reanchors, fails: reanchorFails, inFlight: reanchorInFlight, lastAgoMs: lastReanchorAt ? Math.round(performance.now() - lastReanchorAt) : null },
      /* 藏/还原各发生几次、为什么（真机"楼会变掉"要能查账） */
      pix: { alive: pixAlive, probed: pixEverProbed, strikes: pixStrikes },
      /* 覆盖面（"整屏只有一栋楼"那条：源里有几个 vs 我们画了几个） */
      cover: { expected: cover.expected, actual: cover.actual, srcAll: cover.srcAll, meshAll: cover.meshAll, thinDropped: cover.thinDropped, shapeDropped: cover.shapeDropped, meshOut: cover.meshOut, srcOut: cover.srcOut, strikes: coverStrikes },
      /* 数据通道的账（"为什么只画出一栋"：调度几次 / 完成几次 / 取了几次数） */
      feed: { refreshScheduled, refreshDone, getDataCalls, srcDataEvents, styleDataEvents, lastRefreshMs: lastRefreshMs < 0 ? null : Math.round(performance.now() - lastRefreshMs) },
      meshStats: data?.stats ?? null,
      /* **每帧分解**（拖动期间"谁在花时间"）：`mapFrames` = 地图 render 回调次数，
         `overlayFrames` = 我们真画了几帧，`labelWrites` = 名字层 DOM 写入次数，
         `labelNodes` = 这个名字层现有多少节点（10 个 vs 500 个代价差一个量级）。 */
      perFrame: {
        mapFrames: frames,
        overlayFrames: drawsTotal,
        labelWrites,
        labelNodes: (() => { try { return document.querySelectorAll(".ws-labs *").length; } catch { return -1; } })(),
        dpr: renderer?.getPixelRatio?.() ?? null,
        dprCap: dprCapOf(),
      },
      /* **叠加层那块画布到底在不在屏幕最上层**（像素取证读的是自己的缓冲，
         证明不了"它有没有被地图画布盖住"——"楼没了"还可能是这层被盖） */
      layer: (() => {
        try {
          const ovl = renderer?.domElement as HTMLCanvasElement | undefined;
          if (!ovl) return null;
          const mapCv = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
          const idx = (el: Element | null): number => {
            if (!el) return -1;
            const all = Array.from(document.querySelectorAll("canvas"));
            return all.indexOf(el as HTMLCanvasElement);
          };
          const cs = getComputedStyle(ovl);
          const ms = mapCv ? getComputedStyle(mapCv) : null;
          return {
            ovlIndex: idx(ovl),
            mapIndex: idx(mapCv),
            ovlZ: cs.zIndex, mapZ: ms ? ms.zIndex : null,
            ovlOpacity: cs.opacity, ovlVisibility: cs.visibility, ovlDisplay: cs.display,
            ovlInDom: document.contains(ovl),
            parentCls: String((ovl.parentElement?.className as string) || "").slice(0, 40),
          };
        } catch { return null; }
      })(),
      meshHeights,
      pixProbesRun,
      hidCounters: { hideSyncs, restoreTotal: Object.values(restoreReasons).reduce((a, b) => a + b, 0), restoreReasons, hideRetries, hideVerifyFailed, hideErrors, mapRebinds, hideDrift, hideDriftIds, hideRounds },
      /* **事件序列位置**（判"补藏到底在 styledata 之后还是之前"）：
         lastStyleAgoMs = 最近一次 styledata 距今；lastHideAgoMs = 最近一次补藏距今；
         hidesSinceStyle = 最近一次 styledata 之后补藏了几次（>0 ⇒ 补藏确实发生在事件之后） */
      hidTiming: {
        lastStyleAgoMs: lastStyleAt ? Math.round(performance.now() - lastStyleAt) : null,
        lastHideAgoMs: lastHideAt ? Math.round(performance.now() - lastHideAt) : null,
        hidesSinceStyle,
        styleDataStamps: styleDataStamps.slice(-6),
        now: Math.round(performance.now()),
      },
      /* 地图那套楼到底藏上没藏上：**写进去的**与**读回来的**并排（真机那两个数打架时要能一眼分开） */
      hidWrote: [...hiddenLayers.keys()],
      /* 手里这台地图还活着吗（"读回全 visible"还有一个可能是**我们握的是旧实例**） */
      /* `sameCanvas` = 我们手里那张的 canvas 与屏幕上的 `.maplibregl-canvas` 是不是同一块 */
      mapAlive: (() => {
        try {
          const cv = (map as unknown as { getCanvas?: () => Element | null })?.getCanvas?.() ?? null;
          const st = (map as unknown as { getStyle?: () => unknown })?.getStyle?.() ?? null;
          return { hasStyle: !!st, canvasInDom: cv ? document.contains(cv as unknown as Node) : null, sameCanvas: cv ? cv === renderer?.domElement?.parentElement?.querySelector?.(".maplibregl-canvas") : null };
        } catch { return null; }
      })(),
      /* **当场回读**地图那 5 层的真实可见性（判据读它，不读我自己的记账） */
      hidLive: (() => {
        const mm = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
        return mapBldLayerIds().map((id) => {
          let v: string | null = null;
          try { const x = mm?.getLayoutProperty?.(id, "visibility"); v = x === undefined || x === null ? null : String(x); } catch { v = "?"; }
          return { id, vis: v };
        });
      })(),
      /* 屏幕正中那一圈：地图还能不能答出要素（`bld` 计数 = 藏起来的楼还答不答） */
      pick,
      /* 名字↔楼绑定（2026-10-17）：每节点锚点/楼顶/地面投影差 + 未绑分类；没装/没算过 = null */
      nameBind: wsDiag.nameBind,
      /* ── 上下文与降级账（2026-10-14）：真机"划着划着掉回 2D 自绘路"要有账可查 ── */
      ctx: {
        ovlCreated: ovlCtxCreated,
        ovlLostByUs: ovlCtxLost,
        ovlLostEvents: ovlCtxLostEvents,
        ovlRestoredEvents: ovlCtxRestoredEvents,
        canvases: canvasCountNow(),
      },
      engine: {
        renderKind: wsDiag.renderKind,
        fallbackWhy: wsDiag.fallbackWhy,
        watchdogFires: wsDiag.watchdogFires,
        styleDeadFires: wsDiag.styleDeadFires,
        mapCtxLost: wsDiag.mapCtxLost,
        mapCtxRestored: wsDiag.mapCtxRestored,
        draws: draws,
        fps: Math.round(fps * 10) / 10,
      },
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
      const f = alignFit();
      alignBadge.textContent = `align: cur ${alignCur.toFixed(2)} / max ${alignMax.toFixed(2)} / med ${med.toFixed(2)} px`
        + ` · 中心 ${alignCenterErr === null ? "?" : alignCenterErr.toFixed(2)}`
        + ` · 拟合 a=${f ? f.a : "?"} b=${f ? f.b : "?"}`
        + ` · 屏外 ${alignOffScreen} · n=${alignErrs.length} · 报 ${alignReports}`;
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
    /* 🔴 矩阵必须按**列主序**读：three 的 `Matrix4.elements` 是列主序（`e[i*4+j]` = 第 j 行第 i 列），
       `Vector3.applyMatrix4` 算的是 `e[0]x + e[4]y + e[8]z + e[12]w`。
       这里原来按**行主序**读（`m[i*4+0..3]`）⇒ 实际乘的是 `Mᵀ·v`，量出来的位置整个是转置的
       （本机实测：同一台相机同一个点，转置口径与原口径差 1071 px，形状就是"镜像 + 放大"）。
       渲染不受影响（那是 three 自己算的），**错的是读数** —— 真机那批 `cur 261 / centerErr 1210`
       就是这么来的。修好之后这个函数必须与 `camera.project()` 逐位一致（有闸盯着）。 */
    return projectPoint(lastDraw.mwInv, lastDraw.proj, [xy[0], xy[1]], lastDraw.w, lastDraw.h);
  }

  /** 地图画完一帧 ⇒ 同一帧把叠加层也画了（`alignMode === 'render'` 时的唯一驱动） */
  function onMapRender(): void {
    if (state !== "running") return;
    const now = performance.now();
    maybeReanchor();          /* render 模式（默认）也要重锚 */
    syncCamera();
    drawOnce();
    frames++;
    /* fps 两种模式都要数：`render` 模式原来只 `frames++`，`stats().fps` 恒为 0
       ⇒ "它到底在不在出帧"这条判据在叠加层上读不出东西（2026-10-11 真页面探针实测）。 */
    fpsFrames++;
    if (!fpsAt) fpsAt = now;
    if (now - fpsAt >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsFrames = 0;
    }
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
    maybeReanchor();
    syncCamera();
    drawOnce();
    raf = requestAnimationFrame(tick);
  }

  /**
   * 地图中心漂太远 ⇒ **重锚 + 重建**（局部平面框架的近似误差随距离平方涨）。
   * 🔴 2026-10-17：这段原来只写在 `tick()`（`raf` 模式）里 —— 而**默认是 `render` 模式**
   * （挂地图的 `render` 事件、RAF 循环根本不跑）⇒ **默认模式下永远不重锚**：
   * 网格一直用最初那个锚点，长距离拖动后局部坐标越漂越大、墨卡托畸变累积
   * （"移动时楼的位移与地图不一致"就有它的一份）⇒ 现在两个驱动**都调**这一个函数。
   */
  function maybeReanchor(): void {
    if (reanchorInFlight) return;
    /* 冷却 1500ms：`getData()` 是整份源，失败时若每帧重试会把帧率打下去 */
    if (lastReanchorAt && performance.now() - lastReanchorAt < 1500) return;
    const v = readMapView();
    if (!v || !anchor || anchorDriftM(v.center) <= REANCHOR_M) return;
    /* 先记下目标锚点；异步取数据、用目标锚点建网格，**建好那一刻**由 `rebuild` 与网格一起切
       （提前切 = 旧实现：旧网格配新相机，整体瞬移）。 */
    reanchorInFlight = true;
    lastReanchorAt = performance.now();
    reanchors += 1;
    const nextAnchor = { lat: v.center.lat, lng: v.center.lng, cos: Math.cos((v.center.lat * Math.PI) / 180) };
    void (async () => {
      try {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc, nextAnchor);
        } else {
          reanchorFails += 1;
        }
      } finally {
        reanchorInFlight = false;
      }
    })();
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
        ovlCtxCreated++;
        /* 自己这块画布的生死也记账：真机上"划着划着掉回 2D"必须能看出掉的是哪一个上下文 */
        try {
          cv.addEventListener("webglcontextlost", () => { ovlCtxLostEvents++; }, false);
          cv.addEventListener("webglcontextrestored", () => { ovlCtxRestoredEvents++; }, false);
        } catch {
          /* 挂不上监听不影响渲染（计数少一个而已） */
        }
        renderer.setClearAlpha(0);
        /* 名字层的 DOM 写入计数（只读观察，不改它的行为）：
           `?fpshud=1` 那条 fps 采样按标签分桶，但"拖动时标签到底写了多少次"要有个数。 */
        try {
          const labRoot = document.querySelector(".ws-labs");
          const MO = (window as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
          if (labRoot && MO) {
            labelObs = new MO((list) => {
              for (const rec of list) {
                if (rec.type === "attributes") labelWrites += 1;
                else labelWrites += rec.addedNodes.length + rec.removedNodes.length;
              }
            });
            labelObs.observe(labRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
          }
        } catch { labelObs = null; }
        renderer.setPixelRatio(Math.min(dprCapOf(), window.devicePixelRatio || 1));
        renderer.setSize(w, hh, false);
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(fovYDeg(), w / hh, NEAR_M, 8000);
        anchor = { lat: s.center.lat, lng: s.center.lng, cos: Math.cos((s.center.lat * Math.PI) / 180) };
        curThemeId = s.theme || contractTheme.value.theme || "anime";
        /* 楼：先用舞台交进来的那份世界数据（拿不到就去地图 source 里捞一次） */
        const fc = world?.buildings ?? (await grabBld());
        lastSource = world?.buildings ? "world" : fc ? "source" : "none";
        syncCamera();
        if (fc) rebuild(world?.themeId || curThemeId, fc);
        map?.on?.("sourcedata", onSourceData);
        map?.on?.("styledata", onStyleData);
        /* 楼只留一套：地图自己那套先藏起来（名单逐项记下，走的时候还回去） */
        hideMapBuildings();
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
        /* 起不来就把藏过的楼还回去：**失败路径也不许把地图的楼留在隐藏状态** */
        restoreMapBuildings("init-fail");
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
      map?.on?.("styledata", onStyleData);
      /* 地图后到（先 init 后 bind）⇒ 补藏一次；已经藏过的话这一步是幂等的 */
      if (state === "running") hideMapBuildings();
    },
    unbindMap(): void {
      try {
        map?.off?.("sourcedata", onSourceData);
        map?.off?.("styledata", onStyleData);
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
      try { labelObs?.disconnect(); } catch { /* ignore */ }
      labelObs = null;
      disposeMesh();
      /* 先**摘掉事件**再还原：`setLayoutProperty` 会同步触发 `styledata`，
         监听器还在的话就会把刚还原的楼又藏回去（自己跟自己打架）。 */
      try {
        map?.off?.("sourcedata", onSourceData);
        map?.off?.("styledata", onStyleData);
      } catch {
        /* ignore */
      }
      /* 出场：把地图自己那套楼**逐项还原**（顺序与藏的时候相反） */
      restoreMapBuildings("destroy");
      try {
        renderer?.dispose?.();
        const gl = (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null;
        const lose = gl?.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null;
        if (lose?.loseContext) {
          ovlCtxLost++;
          lose.loseContext();
        }
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

    /**
     * 藏/还原的**账**（只读）：名单 + 计数，外加**现在**回地图上读一遍的真实可见性。
     *
     * 为什么带 `live`：只报自己记的数就是自说自话 —— 判据要读**地图那边**的实际状态。
     */
    hiddenInfo(): {
      hid: number;
      restored: number;
      rebinds: number;
      ids: string[];
      prev: Array<string | null>;
      live: Array<{ id: string; vis: string | null }>;
    } {
      const m = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
      const live = mapBldLayerIds().map((id) => {
        let vis: string | null = null;
        try {
          const v = m?.getLayoutProperty?.(id, "visibility");
          vis = v === undefined || v === null ? null : String(v);
        } catch {
          vis = null;
        }
        return { id, vis };
      });
      return {
        hid: hidCount,
        restored: restoredCount,
        rebinds: mapRebinds,
        ids: [...hiddenLayers.keys()],
        prev: [...hiddenLayers.values()],
        live,
      };
    },

    /**
     * **逐项 dump 三组矩阵 + 同一个测试点在四种口径下的像素**（2026-10-14）。
     *
     * 为什么要它：真机那批回传说"叠加层实际画出去那一帧 vs 地图"差 844~1210 px，而纯数学那张表
     * 说两套投影逐点 ≤0.005 px ⇒ 两者不是同一条路。把三组摆出来两两比，就能分开：
     *   · `drawn` = **上次真的画出去那一帧**的快照（`ageMs` 告诉你是多久以前的）；
     *   · `live`  = 查的这一刻相机对象上的矩阵；
     *   · `model` = 用**同一份相机公式**（`camFrameOf`）现建一台相机算出来的矩阵；
     *   · `test`  = 同一个经纬度在 地图 / 画出去那帧 / 现读相机 / 模型相机 下的像素。
     * 口径本身由 `wsMatMul` 与那条对拍闸看着（生产代码里不留"错误口径对照"）。
     */
    frameDump(lng: number, lat: number): Record<string, unknown> {
      const { w, h } = sizeOf();
      const els = (m: unknown): number[] | null => {
        try {
          const e = (m as { elements?: ArrayLike<number> })?.elements;
          return e ? Array.from(e) : null;
        } catch {
          return null;
        }
      };
      const local = toLocal(Number(lng), Number(lat));
      const drawn = lastDraw ? { mwInv: lastDraw.mwInv, proj: lastDraw.proj, w: lastDraw.w, h: lastDraw.h } : null;
      const live = camera ? { mwInv: els((camera as unknown as { matrixWorldInverse?: unknown }).matrixWorldInverse), proj: els((camera as unknown as { projectionMatrix?: unknown }).projectionMatrix) } : null;
      /* 模型相机：与 `syncCamera` 同一份公式（`applyCamFrame`）现建一台，独立于当前相机对象 */
      let model: { mwInv: number[] | null; proj: number[] | null } | null = null;
      const v = lastSeen || readMapView();
      try {
        if (THREE && v) {
          const mc = new THREE.PerspectiveCamera(fovYDeg(), w / h, NEAR_M, 8000);
          applyCamFrame(mc as unknown as Record<string, any>, v, w, h);
          model = { mwInv: els((mc as unknown as { matrixWorldInverse?: unknown }).matrixWorldInverse), proj: els((mc as unknown as { projectionMatrix?: unknown }).projectionMatrix) };
        }
      } catch {
        model = null;
      }
      const mapP = (() => {
        try {
          const p = (map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null)?.project?.([Number(lng), Number(lat)]);
          return p ? [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))] : null;
        } catch {
          return null;
        }
      })();
      return {
        w,
        h,
        drawnAgeMs: lastDrawAt ? Number((performance.now() - lastDrawAt).toFixed(1)) : null,
        drawnProj: drawn?.proj ?? null,
        drawnMwInv: drawn?.mwInv ?? null,
        liveProj: live?.proj ?? null,
        liveMwInv: live?.mwInv ?? null,
        modelProj: model?.proj ?? null,
        modelMwInv: model?.mwInv ?? null,
        drawnEqLive: matEq(drawn?.mwInv ?? null, live?.mwInv ?? null) === true && matEq(drawn?.proj ?? null, live?.proj ?? null) === true,
        liveEqModel: matEq(live?.mwInv ?? null, model?.mwInv ?? null) === true && matEq(live?.proj ?? null, model?.proj ?? null) === true,
        test: {
          lng: Number(lng),
          lat: Number(lat),
          mapPx: mapP,
          drawnPx: projectPoint(drawn?.mwInv ?? null, drawn?.proj ?? null, local, drawn?.w ?? w, drawn?.h ?? h),
          livePx: projectPoint(live?.mwInv ?? null, live?.proj ?? null, local, w, h),
          modelPx: projectPoint(model?.mwInv ?? null, model?.proj ?? null, local, w, h),
        },
      };
    },

    /**
     * 自用对齐探针的读数（没开开关就是 null）。
     *
     * `centerErr` 与 HUD 徽标上那个"中心"**是同一个量**（同一处代码路径、同一个变量）——
     * 真机那次两边差得远，是因为徽标逐帧刷、回传每 2 秒才发，读的不是同一刻。
     * 现在 `alignFlush()` 发车前会**现算一遍**中心误差，这条读数就与回传里的 `centerErr` 对齐了。
     */
    alignStats(): { on: boolean; cur: number; max: number; n: number; reports: number; centerErr: number | null; offScreen: number; fit: { a: number; b: number; n: number } | null } | null {
      if (!alignOn) return null;
      return {
        on: true,
        cur: Number(alignCur.toFixed(3)),
        max: Number(alignMax.toFixed(3)),
        n: alignErrs.length,
        reports: alignReports,
        centerErr: alignCenterErr === null ? null : Number(alignCenterErr.toFixed(3)),
        offScreen: alignOffScreen,
        fit: alignFit(),
      };
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
        note:
          `${st?.buildings ?? 0} 栋（叠加在地图上） / ${data?.triangles ?? 0} 三角` +
          (hidCount ? ` / 藏起地图楼 ${hidCount} 层` : ` / 没藏地图楼（${hideGateWhy}）`) +
          ` / 覆盖 源${cover.expected}:实画${cover.actual}（视野外 网格${cover.meshOut}·源${cover.srcOut}）` +
          (cover.thinDropped || cover.shapeDropped ? `（丢扁 ${cover.thinDropped}·丢形 ${cover.shapeDropped}）` : "") +
          (restoredCount ? ` / 已还原 ${restoredCount} 层` : "")
          + ` / 相机跟地图：${lastSeen ? "在跟" : "还没读到"}`
          + (errors.length ? ` / ⚠️ ${errors[0]}` : "")
          + alignNote(),
      };
    },
  } as WsRenderBackend & { bindMap(m: unknown): void; unbindMap(): void };
}
