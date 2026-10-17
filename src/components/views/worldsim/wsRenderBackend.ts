/* wsRenderBackend.ts —— **双引擎并列的契约**（2026-10-07 「将 three.js 作为一种渲染形式，
 * 与原有的 map 无缝切换；只是引擎不同，不嵌功能，并列功能」；2026-10-07 补一句口径：「用户可以选择
 * 渲染方式，**除了渲染不一样，其他全一样**」）。
 *
 * ## 这个文件是什么
 * 页面外壳（Vue + HUD + 面板 + 角色/钉子/交互状态）**不变**，下面挂的"画布"有两个后端：
 *   · `map`   —— 现有那张 MapLibre 地图（默认，**行为一个字都不许变**）；
 *   · `three` —— 用**同一份世界数据与同一套配色**画的 three.js 渲染（用户显式选的那条路）。
 * 两者互不知道对方存在，只共同服从下面这份 `WsRenderState`；切换 = 换后端 + 交接状态。
 *
 * ## 红线（§1 定的，照抄不改口径）
 * 契约里**只许出现经纬度与米**：不许把 MapLibre 的 `LngLat` 或 three 的 `Vector3`
 * 泄进来。判据是**可执行的**：回归测试 会扫这个文件，
 * 出现 `LngLat` / `Vector3` / `maplibregl` / `THREE` 这类引擎标识符就报红。
 * ⇒ 两个后端的适配层（`wsMapBackend.ts` / `wsThreeBackend.ts`）才是"翻译官"，脏活都在那边。
 *
 * ## 单位与口径（**必须写清楚，不然两个后端会各算一套**）
 * · `center`  —— 视野中心（经纬度）；
 * · `radius`  —— **视口半高对应的地面米数**（不是"取楼半径"！那一个是另一个概念）：
 *                `radius = 0.5 × 画布CSS高 × metersPerPixel(lat, zoom)`；
 * · `bearing` —— 度，正北为 0、顺时针为正（与 MapLibre 同向）；
 * · `pitch`   —— 度，**0 = 垂直俯视**（与 MapLibre 同向，不是"仰角"）；
 * · `theme`   —— 主题 id（`wstheme.json` 的 `themes.*`，如 `anime` / `night`）；
 * · `timeOfDay` —— 0..1 的夜度（0 = 白天）；`clock` 是给 HUD 看的 `HH:MM`。
 */

import { computed, ref, type ComputedRef, type Ref } from "vue";
import { metersBetween } from "./wsFeatureStore";
import { FOV_Y, M_PER_DEG, camFrameOf } from "./wsThreeCam";

/** 后端 id。`map` 是默认；坏值一律回落到它（§4.4）。 */
export type WsRenderBackendId = "map" | "three" | "overlay";

/**
 * **跨模块的只读诊断账本**（2026-10-14）。
 *
 * 为什么放在契约模块里：写它的有**两个地方**（叠加层自己的上下文计数；地图宿主那边的
 * `renderKind` / `fallbackWhy` / 看门狗 / 画布上下文事件），读它的只有一个（`?wsalign=1`
 * 的回传）。放一份共享的纯数据对象最省事，也**不引入任何引擎结构**（全是数字与字符串）。
 *
 * 口径：谁的那一格谁写；这里**只记事实**，不参与任何判定（判定在量具里读它）。
 */
export interface WsNameBindRow {
  /** 屏上文案 */
  t: string;
  /** 绑到的楼（规范 12 位 hex）；没绑上 = null */
  id: string | null;
  /** `pick.kind`（`building` / `place` / `zone`） */
  k: string;
  /** 锚点（楼顶；没绑 = 地面） */
  x: number;
  y: number;
  /** 同一锚点的地面投影（用来算"锚点离楼底差多少"） */
  bx: number;
  by: number;
  /** 锚点高度（米）；0 = 地面 */
  h: number;
  /** 用共享尺子算的期望竖向偏移（负 = 向上；null = 尺子不可用） */
  expDy: number | null;
  /** 实际竖向偏移（锚点 y − 地面 y） */
  dy: number | null;
}

export interface WsNameBindProbe {
  ver: 1;
  /** 名字层这一轮的三态（`counted` / `uncounted`）与原因 */
  state: string;
  why: string | null;
  /** 未绑分类是否真跑了（`counted` / `skipped`） */
  classState: string;
  labels: number;
  bound: number;
  unboundPoi: number;
  hidden: number;
  /** 被收起规则命中的个数（floor 补位前；判"规则有没有误收"看这个） */
  hiddenByRule: number;
  boundButNotDrawn: number;
  noBldNear: number;
  ambiguous: number;
  droppedByDupBld: number;
  noBldId: number;
  roof3d: number;
  /** 3D 矩阵不可用、用共享尺子近似抬升的次数 */
  roofApprox: number;
  roofGround: number;
  roofNull: number;
  /** 3D 入口的异常/可用性/高程输入（`lastFail` 只在非 matrix3d 时更新） */
  roofErr: { calls: number; matrix3d: number; approx: number; ground: number; none: number; lastFail: unknown } | null;
  /** 绑定用的楼从哪来（`drawn` / `pool` 回退 / `none`）+ 数量 + 其中有高度的 */
  drawn: { source: string; count: number; withHeight: number };
  /** 兜底补位的未绑 POI 名个数（规则要收、但屏上 0 个绑楼名字时） */
  fallbackNames: number;
  /** 分档计数（"为什么没字"）：POI 候选 / 被 z 闸挡掉的 POI / 片区行政名候选 */
  poiCandidates: number;
  poiGated: number;
  areaCandidates: number;
  /** 这一轮耗时：`layer` = 名字层内部各段；`dom` = 宿主把计划落到 DOM 的耗时（ms） */
  ms: { layer: { fetch: number; items: number; grid: number; bindDrawn: number; bindPool: number; poolGrid: number; poolQuery: number; zones: number; pick: number; nodes: number; total: number }; dom: number };
  /** 名字层容器实况（计划有节点但屏上没字时，用它分开"计划空"与"容器被藏"） */
  root: { cls: string; opacity: string; visibility: string; labs: number } | null;
  /** 只回传屏上的（最多 12 条）——不刷屏 */
  nodes: WsNameBindRow[];
  /** 锚点相对地面投影的像素差（只统计绑了楼的节点） */
  dxMed: number | null;
  dyMed: number | null;
  dxMax: number | null;
  dyMax: number | null;
}

/**
 * **屏幕当前那张地图实例的登记处**（2026-10-17 真机定位）。
 *
 * 为什么需要它：真机读数里 `mapAlive.sameCanvas: false` —— 地图实例/画布被换过
 * （上下文丢失后重建那类），叠加层闭包还握着**旧实例**，于是"藏楼"全打在旧地图上、
 * 屏幕上那张图的楼一直没藏（用户看到的就是地图自己那套）。
 * ⇒ 地图宿主每次拿到（或重建出）实例就 `wsLiveMap.set(m)`；叠加层每次补藏前 `get()` 一下，
 * 发现不是自己手里那个就**重新绑定**。
 */
export const wsLiveMap: { set: (m: unknown) => void; get: () => unknown } = (() => {
  let cur: unknown = null;
  return {
    set: (m: unknown) => {
      if (m) cur = m;
    },
    get: () => cur,
  };
})();

/**
 * **楼房图层宿主的登记处**（2026-10-17）。
 *
 * 叠加层是楼房渲染者时会**拆掉**地图那套 `bld*` 图层（结构性，见 `wsBldLayerSwitch`）；
 * 它一旦画不出来（闸不放行）或退出，必须把地图那套**建回来** —— 但重建规格/落图管线
 * 归落图线（`wsBldLanding` 的 `bldFlush`），本模块**不写第二份重建**：
 * 地图宿主把自己的 `bldFlush` 登记进来，叠加层在需要时**调既有入口**。
 */
export const wsBuildingsHost: { set: (f: ((why: string) => void) | null) => void; flush: (why: string) => boolean } = (() => {
  let flush: ((why: string) => void) | null = null;
  return {
    set: (f) => {
      flush = f;
    },
    flush: (why: string) => {
      if (!flush) return false;
      try {
        flush(why);
        return true;
      } catch {
        return false;
      }
    },
  };
})();

/**
 * **叠加层实际画出去的楼 id 登记处**（2026-10-17，名字绑定用）。
 *
 * 名字层绑的是"已画楼"（宿主 `drawnBld`），但叠加层现在画的是**瓦片扫出来的那批**，
 * 两套 id 集合不是同一份 ⇒ 视野一换就绑不上、名字发不上来。
 * 叠加层每次重建后把自己画出去的 id（带 `h3d/h_base`，够名字层做楼顶锚点）登记在这里；
 * 宿主读"已画楼"时**优先用这里**（叠加层负责画楼时），退出时清空。
 */
export const wsDrawnBld: {
  set: (list: ReadonlyArray<{ id: string; properties: Record<string, unknown> }> | null) => void;
  get: () => ReadonlyArray<{ id: string; properties: Record<string, unknown> }> | null;
} = (() => {
  let cur: ReadonlyArray<{ id: string; properties: Record<string, unknown> }> | null = null;
  return {
    set: (list) => {
      cur = list && list.length ? list : null;
    },
    get: () => cur,
  };
})();

export const wsDiag = {
  /** 引擎现在走哪条路（`init` / `webgl` / `waiting` / `failed` / `fallback2d`） */
  renderKind: "",
  /** 降级原因（人话；没降级就是空串） */
  fallbackWhy: "",
  /** 看门狗到点降级的次数 */
  watchdogFires: 0,
  /** "样式死亡"看门狗动作次数 */
  styleDeadFires: 0,
  /** 地图那块画布的 `webglcontextlost` / `webglcontextrestored` 次数 */
  mapCtxLost: 0,
  mapCtxRestored: 0,
  /**
   * 样式现况（2026-10-16 真机定位加）：`loaded` = `isStyleLoaded()`（**源没下完也是 false**），
   * `hasStyle`/`layers` = 样式对象在不在、有几条层（**这才是"真死"的判据**），
   * `notLoaded` = "样式在、层也在、但 loaded=false"被观测到的次数（老判据的误报次数）。
   */
  style: { loaded: null as boolean | null, hasStyle: false, layers: 0, err: "", notLoaded: 0 },
  /**
   * 名字↔楼绑定的真机读数（2026-10-17；名字宿主每次落计划时写，`?wsalign=1` 的回传原样带走）。
   * `null` = 名字层还没落过一版计划（**不是 0**）。
   */
  nameBind: null as WsNameBindProbe | null,
};

/**
 * `?wsalign=1` 的唯一判定处（叠加层量具与名字层回传共用；别名只在这里写一次）。
 * 没有 `location`（Node 自检）⇒ false。
 */
export function alignProbeOn(search?: string): boolean {
  try {
    const q = search !== undefined ? search : (typeof location !== "undefined" ? location.search : "");
    return /[?&]wsalign=1\b/.test(q);
  } catch { return false; }
}

/**
 * 三种状态（2026-10-07 追加的口径：「maplibre 那个很丑的 C 的话值得一试」）：
 *   · `map`     —— 只有地图（**默认**，行为一个字都不许变）；
 *   · `three`   —— 只有 three（全渲染：用 App 的楼/路数据与同一套配色）；
 *   · `overlay` —— **地图 + three 透明叠加层同时活着**（用户明确要试的那条路）。
 *
 * 那条"同时最多一个画布"的不变量**只对 `map ⇄ three` 成立**（这也是本轮实现并验的那一段）；
 *    `overlay` 下两个 WebGL 上下文并存是**要试的东西**，不再是违规。
 *
 * **本轮 `overlay` 只留接口位**（用户给过退路：「先把 map ⇄ three 的切换与契约做完并提交，
 *    把 overlay 只留接口位（契约里有这个状态、能返回"未实现"），并把差额写进报告」）——
 *    它的实现要求（透明画布 / 不接管输入 / 不进后处理 / 每帧从地图读相机 / 动态物第一批：
 *    红绿灯·街边设施·交通工具 / `webglcontextlost` 兜底）一条都还没做，见 `OVERLAY_GAP`。
 */
export const WS_RENDER_IMPLEMENTED: readonly WsRenderBackendId[] = ["map", "three", "overlay"];

/**
 * 三种状态都实现了（`overlay` 在 2026-10-11 上线：透明画布 + 每帧跟地图读相机 + 楼）。
 * 这个常量留着是为了别处不必改：空串 = "都能选"。O2 那批动态物（红绿灯/车流）还没做，
 * 但它们不影响"能不能选叠加层"。
 */
export const OVERLAY_GAP = "";

/** `localStorage` 键（与现存 17 个 `wsm:v1:*` 同口径） */
export const WS_RENDER_KEY = "wsm:v1:renderer";
/** 默认后端：**叠加层（three.js）**。楼只由 three 画，地图那套 `bld-*` 图层不再创建。
 *  （2026-10-17 改：原来的默认是 map —— 那时地图会自己画一套楼；现在楼只留 three 这一套，
 *   `map` 仍可显式指定（`?renderer=map`），但它**不画楼**，只剩底图/路网。） */
export const WS_RENDER_DEFAULT: WsRenderBackendId = "overlay";

export interface WsRenderCenter {
  lat: number;
  lng: number;
}

/** 契约里的"一个人"：**只有经纬度**（钉子那套 `gx/gy` 由宿主换算完再进来） */
export interface WsRenderActor {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** 朝向（度，正北 0、顺时针）—— 2D 用不到，3D 的纸片人用 */
  heading?: number;
  /** 是不是「我」（3D 那条路第一人称时要藏起来，见原型 `character.mjs` 的口径） */
  isMe?: boolean;
  /** 立绘情绪/图名（拿不到就由后端自己兜底） */
  art?: string;
}

/** 当前选中的楼/人（P1 只搬运，不做命中；命中是 P3） */
export interface WsRenderSelection {
  kind: string;
  id: string;
}

export interface WsRenderState {
  center: WsRenderCenter;
  /** 视口半高（米）—— 见文件头的口径 */
  radius: number;
  bearing: number;
  pitch: number;
  theme: string;
  timeOfDay: number;
  clock: string;
  actors: WsRenderActor[];
  selection: WsRenderSelection | null;
}

/** 一坨 GeoJSON（形状从宽：**不许**在这里写 maplibre 的类型） */
export interface WsRenderFc {
  type: "FeatureCollection";
  features: unknown[];
}

/**
 * 交接的"世界数据"：换后端时**从旧后端捞一份交给新后端**。
 *
 * 为什么契约里要有它（§2 的接口表里没有，是本轮加的）：
 * 两条后端**不许同时活着** ⇒ 切到 three 时 MapLibre 已经被销毁，`bld` / `roads` 两个
 * source 也随之消失。而用户这一轮的口径是「**除了渲染不一样，其他全一样**」= three 必须画
 * **同一批楼、同一套高度、同一套颜色** ⇒ 只能在旧后端还活着的时候把那份 GeoJSON 捞下来。
 * 捞的是**地图 source 里的那份**（`GeoJSONSource.getData()`，公开 API），不是重算一份
 * —— 重算就是第二套挑楼/取参逻辑，那正是红线。
 */
export interface WsRenderWorld {
  buildings: WsRenderFc | null;
  roads: WsRenderFc | null;
  themeId: string;
  /**
   * 交接那一刻各自捞到几条（**如实记**，不是判据）。
   *
   * 为什么要它：真机反馈过"只有楼、路大多数时候没有"。路网是**异步落图**的，
   * 切换那一刻可能还没到；没有这两个数就分不清"three 没画"还是"地图上本来就没有"。
   * three 那条路会把它写进 `stats().note`（见 `wsThreeBackend.stats`）。
   */
  counts?: { buildings: number; roads: number };
}

export interface WsRenderStats {
  backend: WsRenderBackendId;
  draws: number;
  dpr: number;
  fps: number;
  /** 这个后端此刻在不在渲染（隐藏/暂停的必须为 false） */
  rendering: boolean;
  /** 人话的补充（可空） */
  note?: string;
}

/** 两个实现同一份（§2）。P1 只用到 init/applyView/readView/… 那一半。 */
export interface WsRenderBackend {
  readonly id: WsRenderBackendId;
  init(host: HTMLElement, state: WsRenderState, world: WsRenderWorld | null): Promise<void>;
  applyView(state: WsRenderState): void;
  readView(): WsRenderState | null;
  setTheme(theme: string, timeOfDay: number): void;
  setActors(actors: readonly WsRenderActor[]): void;
  setSelection(sel: WsRenderSelection | null): void;
  /** 换后端时把"这个世界"捞出来（拿不到就返回 null，**绝不编**） */
  captureWorld(): Promise<WsRenderWorld | null>;
  /**
   * **后端自己动了相机**（用户在它自己的画布上拖/捏/滚轮）时叫一声。
   *
   * 为什么需要它：两个后端各自管自己的相机，而"切回去还是同一眼"这件事只有舞台知道怎么办
   * （把这份状态记成 `pendingView`，切回时喂给另一个后端）。没有这一声，用户在 three 里拖到
   * 哪儿，切回地图时就会被弹回切换前那一份视野。
   *
   * ⚠️ 可选：`map` 那条路不需要它（地图自己的手势只有它自己知道，舞台在切换那一刻
   * `readView()` 一次就够）。实现方不必有，调用方要判空。
   */
  setViewListener?(cb: ((s: WsRenderState) => void) | null): void;
  /** 停渲染（隐藏的那个必须停；RAF / 地图重绘都停） */
  pause(): void;
  resume(): void;
  destroy(): void;
  stats(): WsRenderStats;
  /**
   * **屏幕正中那栋楼**（P1 的验收判据要它：「切换前后画面中心的那栋楼是同一栋」）。
   *
   * 为什么是"两个后端各报一个、探针比 id"而不是"看截图"：本机无 GPU 的年代只能肉眼看，
   * 而肉眼看的结论不可复算。两个后端的**取法必须是各自引擎真的那条路**——
   * 2D 走 `queryRenderedFeatures`（渲染器的命中），3D 走 three 的 `Raycaster`（真实射线），
   * 两条路互相独立 ⇒ 比出来相同才有意义。
   *
   * 判据的含义写死在这里：从屏幕正中开始，先在正中试，再沿着一圈小环（6/12/18 px）试，
   * **第一个命中的**就是它。中心正好落在街上时两条路会各自往外扩 —— 所以两边都用同一套环。
   */
  centerPick?(): { kind: "bld"; id: string; lng: number; lat: number } | null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、度量换算（**纯函数**：契约单位只有米与经纬度，这里就是那条桥）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * zoom 0、赤道上，一个 CSS 像素等于多少米 —— **512 px 瓦片**口径。
 *
 * 🔴 2026-10-11 更正：这里原来是 `156543.03392804097`（= 2πR/256），那是**256 px 瓦片**的老口径。
 * 而 MapLibre 的 `zoom` 是按 **512 px 瓦片**定义的，vendor 里逐字可查：
 *   · `_tileSize = 512`；
 *   · `worldSize() { return this._tileSize * this._scale }`（`_scale = 2^zoom`）；
 *   · `_pixelPerMeter = Vt(1, this.center.lat) * this.worldSize`（`Vt(alt,lat) = alt/(C·cos lat)`，
 *     C = 地球周长 40075016.68557849 米）。
 * ⇒ 米每像素 = `C·cos(lat) / (512 · 2^zoom)`，也就是这里这个数。
 * 用错口径的后果**在真机上肉眼可见**：算出来的"视口半高"整整大了一倍 ⇒ three / 叠加层的相机
 * 站远一倍、楼按一半的尺度画 ⇒ **静止时越靠边越错、拖动时走得比地图慢一半**
 * （真机两条反馈：「不是同一个楼、明显错位」「移动时位移不一致」）。
 */
export const METERS_PER_PIXEL_Z0 = 40075016.68557849 / 512; // ≈ 78271.517

/** Web Mercator 在给定纬度、给定 zoom（**512 px 瓦片**）下，一个 CSS 像素等于多少米 */
export function metersPerPixelAt(lat: number, zoom: number): number {
  return (METERS_PER_PIXEL_Z0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** `metersPerPixelAt` 的反函数（两个后端各自用它把自己的画布换算回 zoom） */
export function zoomForMetersPerPixel(lat: number, mpp: number): number {
  const k = (METERS_PER_PIXEL_Z0 * Math.cos((lat * Math.PI) / 180)) / mpp;
  return Math.log2(k);
}

/** 视口半高（米）← zoom + 画布 CSS 高 */
export function viewRadiusOf(lat: number, zoom: number, cssHeight: number): number {
  return 0.5 * cssHeight * metersPerPixelAt(lat, zoom);
}

/** zoom ← 视口半高（米）+ 画布 CSS 高（`viewRadiusOf` 的反函数） */
export function zoomOfViewRadius(lat: number, radius: number, cssHeight: number): number {
  return zoomForMetersPerPixel(lat, (2 * radius) / Math.max(1, cssHeight));
}

/** 两个中心之间差多少米（**复用共享真源**，不在这里写第二份） */
export function metersBetweenCenters(a: WsRenderCenter, b: WsRenderCenter): number {
  return metersBetween([a.lng, a.lat], [b.lng, b.lat]);
}

/** 把契约里那个"半高半径"夹到能用的范围（0 或 NaN ⇒ 拿默认值兜住，绝不算出 NaN 相机） */
export function saneRadius(r: number, dflt = 300): number {
  const v = Number(r);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(20000, Math.max(20, v));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、偏好（`wsm:v1:renderer`，坏值回 map）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 把任意字符串解析成后端 id（**坏值回默认**，这是唯一判据；三个合法 id 各自照原样返回） */
export function parseRendererId(raw: unknown): WsRenderBackendId {
  /* 🔴 `map` 必须显式认出来：默认值改成 `overlay` 之后，原来靠"兜底回 map"顺带认它的写法
     会把持久化的 `map` 偏好（老版本芯片写下的）当成坏值 ⇒ 静默变成 overlay
     （`?renderer=map` 那条"只看底图/路网"的回退口也因此失效）。 */
  if (raw === "map") return "map";
  if (raw === "three") return "three";
  if (raw === "overlay") return "overlay";
  return WS_RENDER_DEFAULT;
}

/** 这个 id 本轮**实现**了没有（`overlay` 没实现 ⇒ 选了会走"失败即回退"那条路，不是静默忽略） */
export function rendererImplemented(id: WsRenderBackendId): boolean {
  return WS_RENDER_IMPLEMENTED.includes(id);
}

export function readRendererPref(): WsRenderBackendId {
  try {
    return parseRendererId(localStorage.getItem(WS_RENDER_KEY));
  } catch {
    return WS_RENDER_DEFAULT;
  }
}

export function saveRendererPref(id: WsRenderBackendId): void {
  try {
    localStorage.setItem(WS_RENDER_KEY, id);
  } catch {
    /* 存不下就算了（隐私模式）：本次会话照样能切，只是记不住 */
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、模块级单例状态（页面外壳与"舞台"共用这一份 —— 项目里既有做法）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 用户想要的那个后端（chip 点一下就改它；`WsSceneView` watch 它做真切换） */
export const rendererPref: Ref<WsRenderBackendId> = ref(readRendererPref());
/**
 * **真的挂在台上**的那个后端（与 `rendererPref` 可能短暂不同：初始化失败时会退回 map）。
 *
 * 初值**永远**是 `map`（哪怕上次存的是 three / overlay）：地图那条路**必须先跑到就绪**，
 * 才有 center/zoom 可交接、也才有 `bld` 那份世界数据可捞。存了别的偏好会在
 * 地图 ready 之后由舞台自动切过去（一次切换，用户看到的是"进来就是 3D"）。
 *
 * ⚠️ 这里**不能**写 `WS_RENDER_DEFAULT`：默认值在 2026-10-17 改成了 `overlay`，而本 ref 是
 * "台上真正在跑的那个"。若初值跟着默认值变成 `overlay`，`rendererPref === rendererLive`
 * 从一开始就成立 ⇒ 舞台的启动切换判据（`pref !== live`）永远为假 ⇒ **叠加层一次都不会被创建**，
 * 而 HUD/探针读到的 `live` 却是 `overlay`（假读数），台账里只剩 `map:running`。
 */
export const rendererLive: Ref<WsRenderBackendId> = ref<WsRenderBackendId>("map");
/** 角色名单（宿主每轮把钉子换算成经纬度推进来；两个后端读同一份） */
export const contractActors: Ref<WsRenderActor[]> = ref([]);
/** 主题与昼夜（宿主推进来；两个后端读同一份） */
export const contractTheme: Ref<{ theme: string; timeOfDay: number; clock: string }> = ref({
  theme: "anime",
  timeOfDay: 0,
  clock: "",
});
/** 当前选中（P1 只搬运） */
export const contractSelection: Ref<WsRenderSelection | null> = ref(null);

/**
 * **失败即回退**的那句话（§4.5）。
 * 非空 ⇒ HUD 上必须看得见它（"不许白屏、也不许静默退回"）。
 */
export const rendererFallback: Ref<string> = ref("");

/** 上一次切换为什么没成（给探针与控制面板看，**不参与显示逻辑**） */
export const rendererLastError: Ref<string> = ref("");

/** 切换耗时（ms，最近若干次；探针报中位/最大） */
export const switchLog: Ref<Array<{ at: number; from: string; to: string; ms: number; ok: boolean; why?: string }>> = ref([]);

export function noteSwitch(row: { from: string; to: string; ms: number; ok: boolean; why?: string }): void {
  switchLog.value = [...switchLog.value.slice(-19), { at: Date.now(), ...row }];
}

/** 后端生命周期台账（**给探针用的**：断言"同时只有一个在渲染"就是读它 + 数 canvas） */
export type WsRenderLifeState = "created" | "running" | "paused" | "destroyed" | "failed";
export interface WsRenderLedgerRow {
  instance: number;
  id: WsRenderBackendId;
  state: WsRenderLifeState;
  at: number;
  why?: string;
}
const ledger: WsRenderLedgerRow[] = [];
let instanceSeq = 0;

export function ledgerPush(id: WsRenderBackendId, state: WsRenderLifeState, why?: string): number {
  const instance = ++instanceSeq;
  ledger.push({ instance, id, state, at: Date.now(), why });
  if (ledger.length > 200) ledger.splice(0, ledger.length - 200);
  return instance;
}

export function ledgerMark(instance: number, state: WsRenderLifeState, why?: string): void {
  const row = ledger.find((r) => r.instance === instance);
  if (!row) return;
  row.state = state;
  row.at = Date.now();
  if (why) row.why = why;
}

/** 台账里还活着的那些（`destroyed` / `failed` 之外都算活着） */
export function liveBackends(): WsRenderLedgerRow[] {
  return ledger.filter((r) => r.state !== "destroyed" && r.state !== "failed");
}

/** 台账里**正在渲染**的那些（这是"任何时刻 ≤1"那条判据读的东西） */
export function renderingBackends(): WsRenderLedgerRow[] {
  return ledger.filter((r) => r.state === "running");
}

/** 用户点了 chip：改偏好 + 落盘（**真切换**由舞台做，这里不碰 DOM） */
export function setRendererPref(id: WsRenderBackendId): void {
  rendererPref.value = id;
  saveRendererPref(id);
}

/** 清掉"失败原因"（用户看过之后点掉） */
export function clearFallback(): void {
  rendererFallback.value = "";
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、注册表（两个实现同一份接口；`three` 按需加载）
 * ══════════════════════════════════════════════════════════════════════════ */

export type WsRenderBackendFactory = () => WsRenderBackend;

const factories = new Map<WsRenderBackendId, WsRenderBackendFactory>();

export function registerRenderBackend(id: WsRenderBackendId, make: WsRenderBackendFactory): void {
  factories.set(id, make);
}

export function hasRenderBackend(id: WsRenderBackendId): boolean {
  return factories.has(id);
}

/** 造一个新实例（**必须**由舞台成对调用 `destroy`；不许重复 init） */
export function createRenderBackend(id: WsRenderBackendId): WsRenderBackend {
  const make = factories.get(id);
  if (!make) {
    /* 三种状态都实现了（`overlay` 于 2026-10-11 上线）⇒ 走到这里就是**没人注册**这个 id，
       给一句能查的实话（舞台上 `registerRenderBackend` 那三行是唯一注册点）。 */
    throw new Error(`没有注册这个渲染后端：${id}`);
  }
  return make();
}

/** 给"舞台"用的：当前是不是 map 那一侧（模板里 `v-if` 读它） */
export const showingMap: ComputedRef<boolean> = computed(() => rendererLive.value === "map");

/* ══════════════════════════════════════════════════════════════════════════
 * 五、给探针的窗口钩子（只读；**不带任何写操作**）
 * ══════════════════════════════════════════════════════════════════════════ */

export interface WsRenderProbeView {
  pref: WsRenderBackendId;
  live: WsRenderBackendId;
  fallback: string;
  lastError: string;
  ledger: WsRenderLedgerRow[];
  switches: Array<{ from: string; to: string; ms: number; ok: boolean; why?: string }>;
  actors: number;
  /** 角色名单的**逐字指纹**（id@lat,lng 排序后拼起来）—— 探针比"切前切后是不是同一批人"用它 */
  actorsKey: string;
  theme: string;
  /** 舞台上那个后端的自述（拿不到就 null） */
  stats: WsRenderStats | null;
  /** **舞台上那个后端此刻的契约状态**（`readView()`）—— 探针比交接误差读的就是它 */
  state: WsRenderState | null;
  /** canvas 计数（**父文档 + 同源 iframe 一起数**） */
  canvases: number;
  /** 每一个 canvas 是谁的（探针要能说清"2 个里哪一个是后端的"） */
  canvasList: WsCanvasInfo[];
  /** 后端画布（在 `.ws-sceneview` 里那些）的个数 —— "任何时刻 ≤1 个在渲染"这条判据读它 */
  stageCanvases: number;
}

/** 一个 canvas 的体检信息（**只读**；`gl` 是它自己那套上下文，不是建的） */
export interface WsCanvasInfo {
  w: number;
  h: number;
  aw: number;
  ah: number;
  cls: string;
  id: string;
  parent: string;
  /** 在舞台（`.ws-sceneview`）里 = 后端画布；在外面的另有用户 */
  inStage: boolean;
  /**
   * 这个画布**接不接输入**（`pointer-events` 的计算值）。
   * 叠加层那条路的判据用它："两块画布，但**只有一块接输入**"（那一块是地图）。
   */
  pe: string;
  /**
   * `'webgl2'` / `'webgl'` / `'2d'` / `'none'` / `'?'`（没查）。
   *
   * **默认不查**（`'?'`）：`getContext` 这个调用本身会**给还没有上下文的画布建一个上下文**，
   * 而每帧/每次轮询都查一遍 = 一次真实的上下文泄漏 —— 2026-10-07 探针实测到了它的后果
   * （轮询几百次之后，连 MapLibre 自己都拿不到 WebGL2 了，整页掉进 2D 降级路）。
   * ⇒ 想查就**显式**调 `canvasInfo(true)`，一次就好。
   */
  gl: string;
}

/** canvas 体检（探针用；也顺手给 `stageCanvases` 那条判据当实现） */
export function canvasInfo(doc: Document = document, probeGl = false): WsCanvasInfo[] {
  const out: WsCanvasInfo[] = [];
  const one = (cv: HTMLCanvasElement): WsCanvasInfo => {
    let gl = "?";
    if (probeGl) {
      try {
        if (cv.getContext("webgl2")) gl = "webgl2";
        else if (cv.getContext("webgl")) gl = "webgl";
        else if (cv.getContext("2d")) gl = "2d";
        else gl = "none";
      } catch {
        gl = "err";
      }
    }
    return {
      w: cv.clientWidth,
      h: cv.clientHeight,
      aw: cv.width,
      ah: cv.height,
      cls: String(cv.className || "").slice(0, 60),
      id: cv.id || "",
      parent: String((cv.parentElement && cv.parentElement.className) || "").slice(0, 60),
      inStage: !!(cv.closest && cv.closest(".ws-sceneview")),
      pe: (() => {
        try {
          const w = cv.ownerDocument?.defaultView || window;
          return String(w.getComputedStyle(cv).pointerEvents || "");
        } catch {
          return "?";
        }
      })(),
      gl,
    };
  };
  doc.querySelectorAll("canvas").forEach((cv) => out.push(one(cv as HTMLCanvasElement)));
  for (const f of Array.from(doc.querySelectorAll("iframe"))) {
    try {
      const d = (f as HTMLIFrameElement).contentDocument;
      if (d) d.querySelectorAll("canvas").forEach((cv) => out.push(one(cv as HTMLCanvasElement)));
    } catch {
      /* 跨源就算不到（只用同源） */
    }
  }
  return out;
}

export function renderProbeView(): WsRenderProbeView {
  let stats: WsRenderStats | null = null;
  let state: WsRenderState | null = null;
  try {
    stats = liveBackend ? liveBackend.stats() : null;
    state = liveBackend ? liveBackend.readView() : null;
  } catch {
    stats = null;
    state = null;
  }
  const list = canvasInfo();
  return {
    pref: rendererPref.value,
    live: rendererLive.value,
    fallback: rendererFallback.value,
    lastError: rendererLastError.value,
    ledger: ledger.map((r) => ({ ...r })),
    switches: switchLog.value.map((s) => ({ from: s.from, to: s.to, ms: s.ms, ok: s.ok, why: s.why })),
    actors: contractActors.value.length,
    actorsKey: contractActors.value
      .map((a) => `${a.id}@${Number(a.lat).toFixed(5)},${Number(a.lng).toFixed(5)}`)
      .sort()
      .join("|"),
    theme: contractTheme.value.theme,
    stats,
    state,
    canvases: list.length,
    canvasList: list,
    stageCanvases: list.filter((c) => c.inStage).length,
  };
}

/** 数 canvas：父文档 + **同源 iframe**（3D 那条路以后要是改回 iframe，这里照样数得到） */
export function countCanvases(doc: Document = document): number {
  let n = doc.querySelectorAll("canvas").length;
  for (const f of Array.from(doc.querySelectorAll("iframe"))) {
    try {
      const d = (f as HTMLIFrameElement).contentDocument;
      if (d) n += d.querySelectorAll("canvas").length;
    } catch {
      /* 跨源就算不到（只用同源） */
    }
  }
  return n;
}

/** 地图后端（舞台登记；只给 §1.3 的像素对拍用） */
let mapBackendRef: unknown = null;
export function setMapBackendRef(b: unknown): void {
  mapBackendRef = b;
}
export function mapBackendNow(): unknown {
  return mapBackendRef;
}

/** 舞台上那个后端（舞台在挂载/卸载时写它；只给探针与 stats 用） */
let liveBackend: WsRenderBackend | null = null;
export function setLiveBackend(b: WsRenderBackend | null): void {
  liveBackend = b;
}
export function liveBackendNow(): WsRenderBackend | null {
  return liveBackend;
}

/**
 * 屏幕正中那栋楼（**两个后端各自的真命中路径**：2D `queryRenderedFeatures` / 3D `Raycaster`）。
 * 探针拿它比 id ⇒ "切换前后是同一栋"这条判据是**坐标/id 断言**，不是肉眼看。
 */
export function probeCenterPick(): { kind: "bld"; id: string; lng: number; lat: number } | null {
  try {
    return liveBackend?.centerPick?.() ?? null;
  } catch {
    return null;
  }
}

/** three 后端自己的读数（栋数/三角数/洞/取色来源…）；map 那条路返回 null */
export function probeBackendDiag(): unknown {
  try {
    const b = liveBackend as unknown as { diag?: () => unknown } | null;
    return b?.diag ? b.diag() : null;
  } catch {
    return null;
  }
}

/**
 * 舞台那个后端手上的**世界数据**（就是交接时递给下一个后端的那一份）。
 *
 * 给谁用：`world_map/ws_three_harness_probe.mjs`（自用靶场）—— 它把这份数据当夹具，
 * 在**不经过 MapLibre** 的页面里把 three 后端单拉起来量读数。这样量到的楼/路
 * 与地图交给 three 的**是同一份**，不是靶场自己又挑了一遍。
 */
export async function probeCaptureWorld(): Promise<WsRenderWorld | null> {
  try {
    return (await liveBackend?.captureWorld?.()) ?? null;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __WSRENDER__?: unknown }).__WSRENDER__ = {
    view: renderProbeView,
    viewJson: () => JSON.stringify(renderProbeView()),
    centerPick: probeCenterPick,
    centerPickJson: () => JSON.stringify(probeCenterPick()),
    /** canvas 的 GL 体检（**显式调用**：它会给没上下文的画布建上下文，别在轮询里调） */
    canvasGlJson: () => JSON.stringify(canvasInfo(document, true)),
    diagJson: () => JSON.stringify(probeBackendDiag()),
    /**
     * **§1.3 像素对拍**用的两个投影：地图侧（真 MapLibre 的 `project()`）与叠加层侧
     * （`camera.project()`）。两条都**不需要 GL**（纯数学）⇒ 本机也能量"楼与底图对不对得齐"。
     * 谁没在台上就返回 `null`（如实，不编）。
     */
    /** 屏幕像素 → 经纬度（真地图的 `unproject`；§1.3 表用它取"屏内目标点"） */
    mapUnproject: (x: number, y: number) => {
      try {
        const b = mapBackendNow() as unknown as { unproject?: (q: [number, number]) => [number, number] | null } | null;
        return b?.unproject ? b.unproject([Number(x), Number(y)]) : null;
      } catch {
        return null;
      }
    },
    /**
     * **§1.3 表用**：让地图相机换一组 `{pitch, bearing, zoom}`（其余保持）——
     * 探针要扫"误差 vs 俯仰"，而 App 的俯仰没有 URL 入口。
     */
    mapApplyViewJson: (patchJson: string) => {
      try {
        const b = mapBackendNow() as unknown as { applyView?: (s: WsRenderState) => void; readView?: () => WsRenderState | null } | null;
        const cur = b?.readView?.();
        if (!b?.applyView || !cur) return "null";
        const patch = JSON.parse(String(patchJson || "{}")) as Partial<WsRenderState>;
        b.applyView({ ...cur, ...patch });
        return JSON.stringify(b.readView?.() ?? null);
      } catch {
        return "null";
      }
    },
    /**
     * **§1.3 表用**：用**我们的模型**（`wsThreeCam` 的相机 + 针孔投影，纯数学）把某个经纬度
     * 投成屏幕像素 —— 不需要 GL、不需要上下文，也不要求叠加层活着。
     * 与叠加层相机走的是**同一套模型**（同一个 `camFrameOf`），所以拿它与真地图的
     * `map.project()` 比，量的就是"两套投影差多少像素"。
     */
    overlayPixelFromState: (lng: number, lat: number) => {
      try {
        const b = mapBackendNow() as unknown as { readView?: () => WsRenderState | null } | null;
        const s = b?.readView?.();
        if (!s) return null;
        const doc = typeof document !== "undefined" ? document : null;
        const el = doc?.querySelector?.(".ws-sceneview") as HTMLElement | null;
        const rect = el?.getBoundingClientRect?.();
        const w = Math.max(1, Math.round(rect?.width || 0));
        const h = Math.max(1, Math.round(rect?.height || 0));
        const radius = saneRadius(s.radius);
        const cos0 = Math.cos((s.center.lat * Math.PI) / 180);
        /* 🔴 相机是绕**视野中心**摆的（`camFrameOf` 的第一个参数是"看向哪里"）；
           目标点是同一个局部框架里的另一个点。2026-10-11 第一版把**目标点自己**当成了
           视野中心 ⇒ 每个点都投到画布正中（那张表因此全是"误差 = dPx"的假象）。 */
        const x = (Number(lng) - s.center.lng) * M_PER_DEG * cos0;
        const z = (s.center.lat - Number(lat)) * M_PER_DEG;
        const fr = camFrameOf(0, 0, radius, s.bearing, s.pitch);
        /* 世界 → 相机：基的转置（x/y/z 轴都是单位正交） */
        const px = fr.pos[0];
        const py = fr.pos[1];
        const pz = fr.pos[2];
        const rx = x - px;
        const ry = 0 - py;
        const rz = z - pz;
        const cxA = rx * fr.xAxis[0] + ry * fr.xAxis[1] + rz * fr.xAxis[2];
        const cyA = rx * fr.yAxis[0] + ry * fr.yAxis[1] + rz * fr.yAxis[2];
        const czA = rx * fr.zAxis[0] + ry * fr.zAxis[1] + rz * fr.zAxis[2];
        const depth = -czA; // 相机看向 -Z
        if (!(depth > 1e-6)) return null;
        const tanHalf = Math.tan(FOV_Y / 2);
        const aspect = w / h;
        const ndcX = cxA / depth / (tanHalf * aspect);
        const ndcY = cyA / depth / tanHalf;
        return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
      } catch {
        return null;
      }
    },
    /** 口径对拍：地图自己的米每像素 vs 我们的（比值必须 1.00） */
    mapScaleJson: () => {
      try {
        const b = mapBackendNow() as unknown as { scaleProbe?: () => unknown } | null;
        return JSON.stringify(b?.scaleProbe ? b.scaleProbe() : null);
      } catch {
        return "null";
      }
    },
    /** 脚本化平移（逐帧对拍用）：`mapPanBy(dx, dy)` */
    mapPanBy: (dx: number, dy: number) => {
      try {
        const b = mapBackendNow() as unknown as { panBy?: (a: number, c: number) => boolean } | null;
        return b?.panBy ? b.panBy(dx, dy) : false;
      } catch {
        return false;
      }
    },
    /** 叠加层**上次真的画出去那一帧**里，某个经纬度落在屏幕哪儿（逐帧对拍读它） */
    overlayLastDrawProject: (lng: number, lat: number) => {
      try {
        const b = liveBackend as unknown as { projectFromLastDraw?: (a: number, c: number) => [number, number] | null } | null;
        return b?.projectFromLastDraw ? b.projectFromLastDraw(Number(lng), Number(lat)) : null;
      } catch {
        return null;
      }
    },
    /** 切换叠加层的对齐模式（`render` = 同帧 / `raf` = 各跑各的）—— A/B 对比 */
    overlayAlignMode: (m: string) => {
      try {
        const b = liveBackend as unknown as { setAlignMode?: (x: string) => string } | null;
        return b?.setAlignMode ? b.setAlignMode(String(m)) : null;
      } catch {
        return null;
      }
    },
    /** 叠加层这一帧实际画的那批楼（id 表 + 计数）—— 与地图那份做差集，判"是不是同一批" */
    overlayIdsJson: () => {
      try {
        const b = liveBackend as unknown as { diag?: () => unknown } | null;
        return JSON.stringify(b?.diag ? b.diag() : null);
      } catch {
        return "null";
      }
    },
    /** 问**地图后端**"屏幕正中那栋"（不论谁在台上）—— 判"地图那套楼藏起来之后，命中查询还答不答得出来" */
    mapCenterPickJson: () => {
      try {
        const b = mapBackendNow() as unknown as { centerPick?: () => unknown } | null;
        return JSON.stringify(b?.centerPick ? b.centerPick() : null);
      } catch (e) {
        return JSON.stringify({ err: String((e as Error)?.message || e) });
      }
    },
    /** 自用对齐量具的读数（中心误差 / 屏外计数 / 拟合）—— 没开 `?wsalign=1` 时是 null */
    overlayAlignJson: () => {
      try {
        const b = liveBackend as unknown as { alignStats?: () => unknown } | null;
        return JSON.stringify(b?.alignStats ? b.alignStats() : null);
      } catch (e) {
        return JSON.stringify({ err: String((e as Error)?.message || e) });
      }
    },
    /** 叠加层三组矩阵（画出去那一帧 / 现读相机 / 模型现算）+ 同一测试点的各口径像素 */
    overlayFrameJson: (lng: number, lat: number) => {
      try {
        const b = liveBackend as unknown as { frameDump?: (a: number, c: number) => unknown } | null;
        return JSON.stringify(b?.frameDump ? b.frameDump(Number(lng), Number(lat)) : null);
      } catch (e) {
        return JSON.stringify({ err: String((e as Error)?.message || e) });
      }
    },
    /** 跨模块诊断账本（上下文 / 降级原因 / 看门狗次数） */
    wsDiagJson: () => JSON.stringify({ ...wsDiag }),
    /** 叠加层藏了地图哪几层楼、还原了几层，外加**当场回读**的地图可见性（判据的地面真值） */
    overlayHiddenJson: () => {
      try {
        const b = liveBackend as unknown as { hiddenInfo?: () => unknown } | null;
        return JSON.stringify(b?.hiddenInfo ? b.hiddenInfo() : null);
      } catch {
        return "null";
      }
    },
    /** 地图 `bld*` 图层的 `visibility` 清单（"地图自己那套楼"显不显示） */
    mapLayersJson: () => {
      try {
        const b = mapBackendNow() as unknown as { layers?: () => unknown } | null;
        return JSON.stringify(b?.layers ? b.layers() : null);
      } catch {
        return "null";
      }
    },
    mapProject: (lng: number, lat: number) => {
      try {
        const b = mapBackendNow() as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
        const p = b?.project?.([Number(lng), Number(lat)]);
        return p ? [p.x, p.y] : null;
      } catch {
        return null;
      }
    },
    overlayProject: (lng: number, lat: number) => {
      try {
        const b = liveBackend as unknown as { projectLngLat?: (a: number, c: number) => [number, number] | null } | null;
        return b?.projectLngLat ? b.projectLngLat(Number(lng), Number(lat)) : null;
      } catch {
        return null;
      }
    },
    /** 舞台上那份"世界数据"的 JSON（靶场探针的夹具来源；拿不到就是 `null`）。
     *  返回的是 **Promise**：`captureWorld` 要等 `getData`。探针那边必须用
     *  WebDriver 的 `execute/async` 取 —— 写成同步 `JSON.stringify(promise)` 只会得到
     *  `{}`，看起来像"地图没吐数据"（2026-10-08 实测踩过）。 */
    worldJson: () => probeCaptureWorld().then((w) => JSON.stringify(w)),
    /** 切到某个后端（**探针专用**：与点 chip 是同一条路，只是省掉找元素点它） */
    setPref: (id: string) => setRendererPref(parseRendererId(id)),
  };
}
