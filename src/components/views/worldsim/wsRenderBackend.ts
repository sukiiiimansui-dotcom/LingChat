/* wsRenderBackend.ts —— **双引擎并列的契约**（主人 2026-10-07：「将 three.js 作为一种渲染形式，
 * 与原有的 map 无缝切换；只是引擎不同，不嵌功能，并列功能」；2026-10-07 补一句口径：「用户可以选择
 * 渲染方式，**除了渲染不一样，其他全一样**」）。
 *
 * ## 这个文件是什么
 * 页面外壳（Vue + HUD + 面板 + 角色/钉子/交互状态）**不变**，下面挂的"画布"有两个后端：
 *   · `map`   —— 现有那张 MapLibre 地图（默认，**行为一个字都不许变**）；
 *   · `three` —— 用**同一份世界数据与同一套配色**画的 three.js 渲染（用户显式选的那条路）。
 * 两者互不知道对方存在，只共同服从下面这份 `WsRenderState`；切换 = 换后端 + 交接状态。
 *
 * ## 🔴 红线（PLAN-DUAL-ENGINE.md §1 定的，本喵照抄不改口径）
 * 契约里**只许出现经纬度与米**：不许把 MapLibre 的 `LngLat` 或 three 的 `Vector3`
 * 泄进来。判据是**可执行的**：`world_map/ws_render_contract_selftest.mjs` 会扫这个文件，
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

/** 后端 id。`map` 是默认；坏值一律回落到它（`PLAN-DUAL-ENGINE.md` §4.4）。 */
export type WsRenderBackendId = "map" | "three" | "overlay";

/**
 * 🧊 三种状态（主人 2026-10-07 追加的口径：「maplibre 那个很丑的喵，我认为 C 的话值得一试喵」）：
 *   · `map`     —— 只有地图（**默认**，行为一个字都不许变）；
 *   · `three`   —— 只有 three（全渲染：用 App 的楼/路数据与同一套配色）；
 *   · `overlay` —— **地图 + three 透明叠加层同时活着**（主人明确要试的那条路）。
 *
 * 🔴 那条"同时最多一个画布"的不变量**只对 `map ⇄ three` 成立**（这也是本轮实现并验的那一段）；
 *    `overlay` 下两个 WebGL 上下文并存是**要试的东西**，不再是违规。
 *
 * ⚠️ **本轮 `overlay` 只留接口位**（主人给过退路：「先把 map ⇄ three 的切换与契约做完并提交，
 *    把 overlay 只留接口位（契约里有这个状态、能返回"未实现"），并把差额写进报告」）——
 *    它的实现要求（透明画布 / 不接管输入 / 不进后处理 / 每帧从地图读相机 / 动态物第一批：
 *    红绿灯·街边设施·交通工具 / `webglcontextlost` 兜底）一条都还没做，见 `OVERLAY_GAP`。
 */
export const WS_RENDER_IMPLEMENTED: readonly WsRenderBackendId[] = ["map", "three"];

/** `overlay` 为什么还不能选（**一句话，HUD 与 chip 都用它**；空串 = 能选） */
export const OVERLAY_GAP =
  "叠加层（overlay）本轮只留契约位，还没实现：透明画布 / 不接管输入 / 每帧跟地图读相机 / 红绿灯与车辆那批动态物都没做";

/** `localStorage` 键（与现存 17 个 `wsm:v1:*` 同口径） */
export const WS_RENDER_KEY = "wsm:v1:renderer";
/** 默认后端：**永远是 map**（three 只是用户可选的那一种） */
export const WS_RENDER_DEFAULT: WsRenderBackendId = "map";

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
 * 为什么契约里要有它（`PLAN-DUAL-ENGINE.md` §2 的接口表里没有，是本轮加的）：
 * 两条后端**不许同时活着** ⇒ 切到 three 时 MapLibre 已经被销毁，`bld` / `roads` 两个
 * source 也随之消失。而主人这一轮的口径是「**除了渲染不一样，其他全一样**」= three 必须画
 * **同一批楼、同一套高度、同一套颜色** ⇒ 只能在旧后端还活着的时候把那份 GeoJSON 捞下来。
 * 捞的是**地图 source 里的那份**（`GeoJSONSource.getData()`，公开 API），不是重算一份
 * —— 重算就是第二套挑楼/取参逻辑，那正是红线。
 */
export interface WsRenderWorld {
  buildings: WsRenderFc | null;
  roads: WsRenderFc | null;
  themeId: string;
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

/** 两个实现同一份（`PLAN-DUAL-ENGINE.md` §2）。P1 只用到 init/applyView/readView/… 那一半。 */
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

/** Web Mercator 在给定纬度、给定 zoom（512px 瓦片）下，一个 CSS 像素等于多少米 */
export function metersPerPixelAt(lat: number, zoom: number): number {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** `metersPerPixelAt` 的反函数（两个后端各自用它把自己的画布换算回 zoom） */
export function zoomForMetersPerPixel(lat: number, mpp: number): number {
  const k = (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / mpp;
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

/** 把任意字符串解析成后端 id（**坏值回 `map`**，这是唯一判据） */
export function parseRendererId(raw: unknown): WsRenderBackendId {
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
 * 🔴 初值**永远**是 `map`（哪怕上次存的是 three）：地图那条路**必须先跑到就绪**，
 * 我们才有 center/zoom 可交接、也才有 `bld` 那份世界数据可捞。存了 three 的偏好会在
 * 地图 ready 之后由舞台自动切过去（一次切换，用户看到的是"进来就是 3D"）。
 */
export const rendererLive: Ref<WsRenderBackendId> = ref(WS_RENDER_DEFAULT);
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
 * 🔴 **失败即回退**的那句话（`PLAN-DUAL-ENGINE.md` §4.5）。
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
    /* `overlay` 是"契约里有、本轮没实现"的那一个：给一句**人话**，别让用户看到"没有注册" */
    throw new Error(id === "overlay" ? `未实现：${OVERLAY_GAP}` : `没有注册这个渲染后端：${id}`);
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

/** 一个 canvas 的体检信息（**只读**；`gl` 是它自己那套上下文，不是我们建的） */
export interface WsCanvasInfo {
  w: number;
  h: number;
  aw: number;
  ah: number;
  cls: string;
  id: string;
  parent: string;
  /** 在舞台（`.ws-sceneview`）里 = 后端画布；在外面的另有主人 */
  inStage: boolean;
  /**
   * `'webgl2'` / `'webgl'` / `'2d'` / `'none'` / `'?'`（没查）。
   *
   * 🔴 **默认不查**（`'?'`）：`getContext()` 这个调用本身会**给还没有上下文的画布建一个上下文**，
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
      gl,
    };
  };
  doc.querySelectorAll("canvas").forEach((cv) => out.push(one(cv as HTMLCanvasElement)));
  for (const f of Array.from(doc.querySelectorAll("iframe"))) {
    try {
      const d = (f as HTMLIFrameElement).contentDocument;
      if (d) d.querySelectorAll("canvas").forEach((cv) => out.push(one(cv as HTMLCanvasElement)));
    } catch {
      /* 跨源就算不到（我们只用同源） */
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
      /* 跨源就算不到（我们只用同源） */
    }
  }
  return n;
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

if (typeof window !== "undefined") {
  (window as unknown as { __WSRENDER__?: unknown }).__WSRENDER__ = {
    view: renderProbeView,
    viewJson: () => JSON.stringify(renderProbeView()),
    centerPick: probeCenterPick,
    centerPickJson: () => JSON.stringify(probeCenterPick()),
    /** canvas 的 GL 体检（**显式调用**：它会给没上下文的画布建上下文，别在轮询里调） */
    canvasGlJson: () => JSON.stringify(canvasInfo(document, true)),
    diagJson: () => JSON.stringify(probeBackendDiag()),
    /** 切到某个后端（**探针专用**：与点 chip 是同一条路，只是省掉找元素点它） */
    setPref: (id: string) => setRendererPref(parseRendererId(id)),
  };
}
