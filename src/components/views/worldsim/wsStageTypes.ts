/* wsStageTypes.ts —— L0.5：**舞台层共用的类型**（`PLAN-REFACTOR.md` §2.2）。
 *
 * ## 这个文件是什么
 * 舞台拆分（§2.1 的 M1…M9）之后，各模块与宿主之间要靠类型对齐：模块**不许 import 宿主**
 * （§2.2 规则③），所以"宿主注入的那份上下文"与"从宿主搬出去的地图/快照形状"必须有**中立**的
 * 落脚点 —— 就是这里。它属于 L0.5：在叶子模块（L0）之上、在 M* 之下。
 *
 * ## 两条硬纪律
 * ① **0 运行时代码**：本文件只许出现 `type` / `interface` / `import type` / `export type`。
 *    出现任何一个 `const` / `function` / `enum`（有运行时产物）就是走错了地方 ——
 *    那些属于 L0 的真源模块（`wsScene` / `wsMapTheme` / …）。
 * ② **不许有第二份定义**（`pr_standard_check.py` 的 C1）：这里只做"搬家"与"再导出"，
 *    绝不为同一个形状写第二份 interface —— 两份迟早漂移，而漂移了没人看得出来。
 *
 * ## S1 落在哪一步（照实记）
 * · `BldMapLike`：**从宿主搬来**（原 `WsDistrictMapLibre.vue` 内部 `interface`）。它有真实消费者
 *   （宿主里 10+ 处 `loadBuildingsForView(m)` / `viewHalf(m)` / `m as BldMapLike` 等签名），
 *   搬出来没有任何运行时影响（interface 编译后不存在）。
 * · `VerifySnapshot`：**不复制**，只在这里再导出 —— 真源仍在 `wsVerifyChecks.ts`（`VerifySnapshot`
 *   与产出它的 `runVerifyChecks` 必须待在一起，拆开就是两份）。
 * · `StageCtx`：**本次故意没写**。它的形状由"第一个真正搬出去的 `mountX()` 需要注入什么"决定；
 *   S1 里没有任何模块消费它，先写出来就是**凭空发明 API**（写完没人用 ⇒ 没人能证它对不对）。
 *   它随第一个搬迁切片（S2 起）落地，那时字段是被真实调用点倒逼出来的。
 */

/** 取楼用的地图最小接口（只声明用到的，避免 any）。
 *  ⚠️ 2026-10-04（S1）从 `WsDistrictMapLibre.vue` 原样搬来，**一个字段都没改**；
 *     搬家的理由：`wsViewFetch`（M2）等模块要按这个形状收地图，而模块不许 import 宿主。 */
export interface BldMapLike {
  getZoom(): number;
  getCenter(): { lng: number; lat: number };
  getBounds(): { getEast(): number; getWest(): number; getNorth(): number; getSouth(): number };
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  addSource(id: string, spec: Record<string, unknown>): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
}

/** 验证快照（面板与样式 JSON 吃的那一份）—— **再导出**，真源在 `wsVerifyChecks.ts`。
 *  用 `export type { … } from` 这种写法：它是**纯类型**再导出，编译后不留任何运行时痕迹
 *  （也就不会把 `wsVerifyChecks` 拖进模块依赖图）。 */
export type { VerifySnapshot } from "./wsVerifyChecks";

/* ══ S2（M6 `wsFallback2d`）的注入面 ══════════════════════════════════════════════════════
 * 下面两个 interface 是 `PLAN-REFACTOR.md` §2.2 那句「跨模块共享状态一律走宿主构造的只读 ctx，
 * 由宿主注入」的落地：M6 那批函数**闭包着宿主一大把 setup 期局部量**，把它们改成"每次调用都传参"
 * 就得改函数体里每一处 `theme.value` ⇒ 那就不是"只搬不改"了。
 * ⇒ 宿主构造这份 ctx，`createFallback2d(ctx)` 在里面**解构一次**，函数体一个字都不用动（对拍闸守着）。
 *
 * ⚠️ 两条纪律：
 * ① **这里是形状的说明书，不是第二份实现**：`Fallback2dStats` 只是宿主那个 `reactive` 的
 *    **结构化视图**（只列 M6 真正读写的字段），真源永远是宿主里那一份；
 * ② **字段只许按"真实调用点倒逼"增加** —— 没人用的字段不要先写上来（S1 里 `StageCtx` 就是这么被推迟的）。
 */
import type { ComputedRef, Ref } from "vue";
import type { AiItem, BBox } from "./wsAiLayers";
import type { PerfApi } from "./wsPerf";
import type { WsMapTheme } from "./wsMapTheme";
/* S3（M8/M1）的注入面要用到的形状 —— **只 import type**（编译后不留运行时痕迹 ⇒ 不拉依赖） */
import type { BundleBuildingFeature, BundleFeed, BundleFeedFacts, BundlePlaceFeature, BundleRoadFeature, BundleFetch } from "./wsOfflineFeed";
import type { GwLayer } from "./wsGwLayer";
import type { JoyCamSnapshot, JoyMotion, JoyPxScale, RoamStore, joyGateOf } from "./wsJoystick";
import type { NameLayer, NameRenderNode } from "./wsNameLayer";
/* S7（M7）的注入面要用到的形状 —— 同上（只 import type）：`WsDistrictPin` 是
   `pinEl` / `props.markers` 的元素形状（真源 `wsActors`）。 */
import type { WsDistrictPin } from "./wsActors";
/* S4（M2）的注入面要用到的形状 —— 同样是**只 import type**（编译后不留运行时痕迹） */
import type { FeatureStore } from "./wsFeatureStore";
/* S6（M3）的注入面要用到的形状 —— 同上（只 import type）：
   `ThemeTier`（形体档对应的样式档，真源 `wsDistrictScene.themeForTier` 的产物）、
   `RoadSeg`（路的吸附段）、`BldFeature`（上妆那两个函数的入参形状）。 */
import type { ThemeTier } from "./wsDistrictScene";
import type { RoadSeg } from "./wsSnap";
/* S11：`scene-ready` 的 payload 里那个取名点取值器（真源 `wsDaily`，宿主就是从那 import 的）。 */
import type { PlacePoint } from "./wsDaily";
import type { BldFeature } from "./wsBuildingSources";

/** 宿主 `stats`（`reactive({…})`）里 M6 读写的那些字段 —— **只列用到的**。
 *  口径：M6 写 `count/height/levels/default/parts/contour/mode/perf/pins/note`，读 `note`。 */
export interface Fallback2dStats {
  mode: string;
  count: number;
  height: number;
  levels: number;
  default: number;
  parts: number;
  note: string;
  contour: number;
  pins: number;
  perf: string;
}

/** M6（2D 降级路）要用的宿主状态/函数 —— 全部**只读**（宿主仍是它们唯一的拥有者）。 */
export interface Fallback2dCtx {
  /** HUD 计数（见 `Fallback2dStats` 的说明） */
  stats: Fallback2dStats;
  /** 当前主题（`draw2d`/`rampColor`/`dressBld` 的配色唯一来源） */
  theme: ComputedRef<WsMapTheme>;
  /** 性能档位单例（`fallback2d` 里 `forceLow` 就是"谁降级谁负责压档"那一行） */
  perf: PerfApi;
  /** 只用到 `props.aiItems` / `props.grid`（AI 示意层那两处） */
  props: { aiItems?: AiItem[]; grid?: number };
  /** 模板那块自绘画布（`v-if="show2d"`）；降级时会**换一块新的** */
  cv: Ref<HTMLCanvasElement | null>;
  /** 组件根元素（画布插入点） */
  host: Ref<HTMLElement | null>;
  /** 真数据够不够 → 要不要叠示意层（单一真源，见宿主注释） */
  aiOn: ComputedRef<boolean>;
  /** 示意层的正方形范围 */
  aiBboxRef: Ref<BBox | null>;
  /** `draw2d` 现算出来的那份范围（`domPins` 与它共用同一份，人才站在画出来的楼上） */
  draw2dBbox: Ref<[number, number, number, number] | null>;
  /** 地图库真的跑起来了吗（降级时为 false） */
  mapAvailable: Ref<boolean>;
  /** 降级的类别（`none`/`temp`/`perm`） */
  fallbackKind: Ref<"none" | "temp" | "perm">;
  /** 自绘画布要不要存在 */
  show2d: Ref<boolean>;
  /** 2D 路的 DOM 钉子（`fallback2d` 只读它的长度写 HUD） */
  domPins: { readonly value: ReadonlyArray<unknown> };
  /** 加载阶段（`fallback2d` 末尾置 `done`） */
  phase: Ref<"fetch" | "build" | "render" | "done">;
  /** 昼夜缓变时长（低档传 0） */
  NIGHT_FADE_MS: number;
  /** 形体档（`?bld=2` = 2；`dressBld` 用它选 `decorateBuildings`） */
  WS_BLD_MODE: number;
  /** 2D 画布 DPR 封顶（`?wsdpr=` 可覆盖） */
  dprCap2d(): number;
  /** 停掉"等待"计时器 */
  stopTimer(): void;
  /** 临时降级后：后台等它出帧，出来了切回 WebGL */
  startRecoverPoll(): void;
  /** App 自拍（降级路更要拍） */
  maybeAppSelfShot(kind: "webgl" | "fallback2d", why?: string): void;
  /** 是不是自动化/无头环境（`ALLOW_2D` 的第二个入口） */
  isAutomation(): boolean;
  /** 美术档取参（真源在宿主，M6 只转调） */
  artTheme(t: WsMapTheme | null): WsMapTheme;
}

/* ══ S3（M8 `wsHudStats` / M1 `wsMapCamera`）的注入面 ═══════════════════════════════════
 * 与上面 S2 那段同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体一个字都不用动），
 * 差别只有一处：**S3 有三个装配点**（依赖时点不同，见 `wsHudStats.ts` 文件头）——
 *   · `createHudStats`（早：stats/aiOn/长等待/fps）—— 必须早于 S2 的装配点（那边要 `stats`/`aiOn`）；
 *   · `createMapCamera`（晚：晚于 `labRootEl`）与 `createBundleHud`（晚：晚于离线包管道）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：`StageStats` 只描述**搬到 M8 里的**那个 `reactive`，
 *    真源永远只有一份（现在它就诞生在 `wsHudStats.ts` 的 `createHudStats` 里）。
 * ⚠️ 字段只许按"真实调用点倒逼"增加（S1 里 `StageCtx` 就是因为没人用而被推迟的）。
 */

/** 宿主那份 `stats`（`reactive({…})`）的**结构化视图** —— 全部字段（它现在在 M8 里诞生）。
 *  口径：这是屏幕上每一个计数的唯一落点；M6/M8/M9 都只读写这张表里的格子。 */
export interface StageStats {
  mode: string;
  count: number;
  height: number;
  levels: number;
  default: number;
  names: string;
  card: string;
  fps: number;
  note: string;
  contour: number;
  area: string;
  view: string;
  pins: number;
  pinsAnchor: string;
  pinsNote: string;
  roads: number;
  roadStore: string;
  bldBundle: string;
  bldMode: number;
  parts: number;
  bldPick: string;
  roadsBundle: string;
  bldVerdict: string;
  roadsVerdict: string;
  attribution: string;
  gwVerdict: string;
  roadNote: string;
  facilities: number;
  facNote: string;
  perf: string;
}

/** M8 前半（`createHudStats`）要用的宿主状态 —— 全部**只读**。 */
export interface HudStatsCtx {
  /** 只用到 `showAi` / `aiAuto`（`aiOn` 的两半判据）。
   *  ⚠️ 两个都是**必填** `boolean`：宿主那份 `withDefaults` 给了默认值（false / true）
   *     ⇒ Vue 解析后的 props 类型里它们不是 `boolean | undefined`（松写成可选会让
   *     `aiOn` 变成 `ComputedRef<boolean | undefined>`，与 S2/M6 那份 `ComputedRef<boolean>` 对不上）。 */
  props: { showAi: boolean; aiAuto: boolean };
  /** 「真楼够不够」的阈值（`aiOn` 用它；原样从宿主搬去 M8，不复制第二份数） */
  BLD_SPARSE: number;
  /** 加载阶段（宿主与 S2 都还在写它 ⇒ **所有权仍在宿主**，这里只读） */
  phase: Ref<"fetch" | "build" | "render" | "done">;
  /** 形体档（`?bld=2` = 2；`stats.bldMode` 初值就是它） */
  WS_BLD_MODE: number;
  /** 「上次取数耗时」的 localStorage 键（宿主 `onMounted` 里还在写它 ⇒ 只读注入） */
  K_MS: string;
  /** 宿主那面 `alive` 旗（`let`，卸载时置 false）——**取值器**：解构会快照（`startFps` 每次调用读一次） */
  aliveNow(): boolean;
}

/** M1（`createMapCamera`）要用的宿主状态 —— 全部**只读**。 */
export interface MapCameraCtx {
  /** 只用到 `joy` / `pitch`（近景判据与两个俯角）。
   *  ⚠️ 两个都是**必填**：宿主 `withDefaults` 给了默认值（`joy: false` / `pitch: 38`）
   *     ⇒ 解析后的 props 类型就是 `boolean` / `number`（松写会让 `setPitch?.(props.pitch)` 报 TS2345）。 */
  props: { joy: boolean; pitch: number };
  /** 组件根元素（`joyMeasureVh` 量它的高度） */
  host: Ref<HTMLElement | null>;
  /** 2D 自绘画布要不要存在（`joyGate` 的第二个输入） */
  show2d: Ref<boolean>;
  /** 区界 bbox（`fitDistrict` 铺满整区用） */
  bboxRef: Ref<[number, number, number, number] | null>;
  /** HUD 计数（`fitDistrict` 写 `mode`/`view`/`note` 三格） */
  stats: StageStats;
  /** 名字层开关（`onMoveStart` 第一道早退） */
  namesOn: Ref<boolean>;
  /** 屏上的名字节点（跟手要拿第一个节点的锚点） */
  nameNodes: Ref<NameRenderNode[]>;
  /** 相机运动中（跟手那三个 handler 的唯一状态） */
  cameraMoving: Ref<boolean>;
  /** 标签层容器（位移只写它一个节点） */
  labRootEl: Ref<HTMLElement | null>;
  /** 🔴 宿主那个 `let map` 的**取值器**（建图/销毁会重新赋值 ⇒ 不许解构快照） */
  mapNow(): unknown;
}

/** M8 后半（`createBundleHud`）要用的宿主状态 —— 全部**只读**。 */
export interface BundleHudCtx {
  /** HUD 计数（包那一行 + 判词 + 署名都写它） */
  stats: StageStats;
  /** 近景分流判据（`hudMode` 拼第二句；真源在 M1，宿主注入 ⇒ 两个模块之间**没有**横向 import） */
  joyGate: ComputedRef<ReturnType<typeof joyGateOf>>;
  /** 楼/路/片区名三条离线管道（`refreshBundles` 转调它们，不重写取数规则） */
  bldFeed: BundleFeed<BundleBuildingFeature>;
  roadsFeed: BundleFeed<BundleRoadFeature>;
  placesFeed: BundleFeed<BundlePlaceFeature>;
  /** 🌊🌳 水/绿地那一条（**不设 zoom 闸门**） */
  gwLayer: GwLayer;
  /** 浏览器取数（每格独立超时；`fetchWithTimeout` 的装配在宿主） */
  fetchCell: BundleFetch;
  /** 取楼/取路各自的 zoom 闸门（阈值只有一份，仍留在宿主） */
  BLD_MIN_ZOOM: number;
  ROAD_MIN_ZOOM: number;
  /** HUD 去重器（**留在宿主**：它闭包宿主的 `bundleHudQueued` 与 `alive`） */
  scheduleBundleHud(): void;
  /** 🔴 宿主那个 `let map` 的取值器（同 `MapCameraCtx.mapNow`） */
  mapNow(): unknown;
}

/* ══ S4（M2 `wsViewFetch`）的注入面 ═════════════════════════════════════════════════════
 * 与 S2/S3 同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体一个字都不用动），
 * 只有一处例外：**`alive` 是一个布尔**，JS 里没法按引用共享 ⇒ 它在 M2 里走 `aliveNow()` 现读
 * （逐处理由与"为什么不用形参默认值"写在 `wsViewFetch.ts` 的文件头）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：`bldStore` / `roadsStore` / `bldFlush` / `roadsFlush`
 *    的真源都在宿主（M3 `wsBldLanding` 那一片，S6 才搬）⇒ 这里只声明 M2 真正用到的那几个成员。
 * ⚠️ 字段只许按"真实调用点倒逼"增加（S1 里 `StageCtx` 就是因为没人用而被推迟的）。
 */

/** M2（取数/落地）要用的宿主状态/函数 —— 全部**只读**（宿主仍是它们唯一的拥有者）。 */
export interface ViewFetchCtx {
  /** HUD 计数（`note` / `view` / `roadNote` / `facilities` / `facNote` 五格是 M2 写的） */
  stats: StageStats;
  /** 只用到 `area`（设施的稳定种子 `hash32(area)` 与后端参数） */
  props: { area?: string };
  /** 取楼/取路各自的 zoom 闸门（阈值只有一份，仍留在宿主） */
  BLD_MIN_ZOOM: number;
  ROAD_MIN_ZOOM: number;
  /** 「真楼够不够」的阈值（第二数据源补缺的开关；原样留在宿主，不复制第二份数） */
  BLD_SPARSE: number;
  /** offline-first 的**结论**（决策在真源 `wsScene.bldLiveDecision`，宿主握结论） */
  bldLive: { live: boolean };
  roadsLive: { live: boolean };
  /** 半径适配器（规则全在真源 `wsScene.fetchRadiusForView`；M2 只转调，不重写） */
  liveRadiusFor(m: BldMapLike): {
    radius: number;
    decidedBy: string;
    want: number;
    limitWhy: string | null;
    halfM: number | null;
  };
  /** 累积仓库（合并/淘汰规则的真源是 `wsFeatureStore`；这里只用到 `merge`） */
  bldStore: FeatureStore<BundleBuildingFeature>;
  roadsStore: FeatureStore<BundleRoadFeature>;
  /** 落图通路（真源在 `wsDistrictScene`；M2 只管"什么时候喊一声"） */
  bldFlush(why: string): void;
  roadsFlush(why: string): void;
  /** 🔴 宿主那面 `alive` 旗的**取值器**（`let`，卸载时置 false）——
   *  解构会拿到快照；这里每次调用现读，与原实现在**同一时刻**读同一个值。 */
  aliveNow(): boolean;
}

/* ══ S5（M4 `wsNameHost` / M5 `wsJoystickStage`）的注入面 ═══════════════════════════════
 * 与 S2/S3/S4 同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体一个字都不用动）。
 * 这一片的别名比 S4 多一处**形状上**的差别，两条都写清楚：
 *   · `alive` 仍走 `aliveNow()`（**不许冻在入口**：M4/M5 的函数会跑在定时器/rAF/微任务里）；
 *   · `map` 在 **M5** 里走"函数体第一行的 `const map = ctx.mapNow()`"而不是形参默认值 ——
 *     因为 `onJoyDrive` / `onJoyHalt` 的**签名行**被 `ws_joystick_selftest` 逐字钉着（判据 ⑦/⑫h），
 *     多一个形参就红了（理由逐条写在 `wsJoystickStage.ts` 的文件头）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：真源永远只有一份
 *    （`stats` / `perf` / `pins` / `cameraMoving` / ref 那几个都在宿主）。
 * ⚠️ 字段只许按"真实调用点倒逼"增加（S1 里 `StageCtx` 就是因为没人用而被推迟的）。
 */

/** 宿主 `pins` 里**真正被读到**的那些字段（结构化视图）。
 *  ⚠️ S7（M7）把 `mk` 收窄成 `PickMarkerLike`，并补了 `edge*` 三件 + `edgeKey` ——
 *     这是**同一份**宿主对象的视图（真对象就是 `new mlMod.Marker(…)`，
 *     `remove()` / `getLngLat?()` 本来就在它身上）⇒ 只扩不复制，绝不为同一个形状再写第二份 interface。 */
export interface StagePin {
  id: string;
  el: HTMLElement;
  mk: PickMarkerLike;
  face: HTMLElement | null;
  body: HTMLElement | null;
  aim: HTMLElement | null;
  dash: HTMLElement | null;
  tip: HTMLElement | null;
  /** 📍 屏外方向指示三件（**只有"别人"的钉子上建**，「我」那三栏恒 null） */
  edge: HTMLElement | null;
  edgeArrow: HTMLElement | null;
  edgeDist: HTMLElement | null;
  /** 📍 上一轮写进 DOM 的那份"边缘状态"（`"off"` 或 `"1|角|文案"`）—— 没变就一次都不写 */
  edgeKey: string;
}

/** M4（`createNameHost`）要用的宿主状态 —— 全部**只读**（宿主仍是它们唯一的拥有者）。 */
export interface NameHostCtx {
  /** HUD 计数（`names` 由本模块写、`note` 读写 —— 与 `applyNamePlanWithHud` 同一刻写是硬纪律） */
  stats: StageStats;
  /** 浏览器取数（名字层取格用；`fetchWithTimeout` 的装配在宿主） */
  fetchCell: BundleFetch;
  /** 性能档位单例（`perfLow` 就是它的结构化视图 —— 那个 computed 也跟着本片搬来了） */
  perf: PerfApi;
  /** 分路状态（`fallback2d` 时名字层不许再要地图 —— 判据就在喂给 `createNameLayer` 的取值器里） */
  renderKind: Ref<"init" | "webgl" | "waiting" | "failed" | "fallback2d">;
  /** 🔴 宿主那面 `alive` 旗的**取值器**（同 `ViewFetchCtx.aliveNow`） */
  aliveNow(): boolean;
  /** 🔴 宿主那个 `let map` 的**取值器**（建图/销毁会重新赋值 ⇒ 不许解构快照） */
  mapNow(): unknown;
  /** 🔴 宿主那个 `let drawnBld` 的**取值器**（`afterDraw` 每轮重写 ⇒ 名字层要读当下那一份） */
  drawnBldNow(): readonly unknown[];
}

/** M5（`createJoystickStage`）要用的宿主状态 —— 全部**只读**（宿主仍是它们唯一的拥有者）。
 *  ⚠️ 两个 `watch`（`props.joy` 开合 / `joyGate.show` 卸载兜底）**故意留在宿主** ⇒ 这里没有
 *     `props` / `joyGate`（模块不需要它们；写上来就是没人用的字段，见文件头那条纪律）。 */
export interface JoystickStageCtx {
  /** 相机运动中（摇杆判定"相机真的动了"那一刻置位；名字层跟手那一层淡化用它） */
  cameraMoving: Ref<boolean>;
  /** 标签层容器（跟手只写它一个节点） */
  labRootEl: Ref<HTMLElement | null>;
  /** 钉子名单（「我」那颗由 `ROAM_PIN_ID` 找；本模块只读，不新增/删除） */
  pins: StagePin[];
  /** 「我」回到名单里的网格位置（`joyExit` 收尾用；规则在宿主 `syncPins`） */
  syncPins(): void;
  /** 屏外方向指示补一次（`onJoyHalt` 那**恰好一次**的时点；规则在 `wsPinEdge`） */
  pinEdgeSync(): void;
  /** 落楼（真源 `wsDistrictScene.flushBldStore`；本模块只管"什么时候喊一声"） */
  bldFlush(why: string): void;
  /** 按视野补离线格（实现在 M8 `wsHudStats.ts`；**宿主注入 ⇒ M5 不与 M8 横向 import**） */
  refreshBundles(why?: string): Promise<void>;
  /** 名字层重排（实现在 M4 `wsNameHost.ts`；同上，走宿主注入） */
  refreshNames(why?: string): Promise<void>;
  /** 容器归零（实现在 M1 `wsMapCamera.ts`；同上） */
  onMoveEndNames(): void;
  /** 就地重投影（实现在 M4 `wsNameHost.ts`；同上） */
  reprojectNow(): void;
  /** 性能档位单例（踏步/预走线的 low 档判据） */
  perf: PerfApi;
  /** 米/像素（`joyCalibrate` 量一次；宿主 `JoyMotion` 的世界速度用它） */
  joyMpp: Ref<number>;
  /** 满推速度档（同上；模板 `:speed-mps` 直接吃它） */
  joySpeedMps: Ref<number>;
  /** 推杆期间拉近几级（`joyCalibrate` 武装；模板 `:zoom-levels` 直接吃它） */
  joyZoomLevels: Ref<number>;
  /** 名字层是否正在整层隐藏（拉近期间；`labRootClass` 的 `is-zoom-pull` 读它） */
  joyZoomPulling: Ref<boolean>;
  /** ♿ 系统"减弱动效"（**只关踏步**；宿主那段 `matchMedia` 求值仍在宿主 —— 本模块只读） */
  joyReducedMotion: boolean;
  /** 🔴 宿主那面 `alive` 旗的**取值器**（同 `ViewFetchCtx.aliveNow`） */
  aliveNow(): boolean;
  /** 🔴 宿主那个 `let map` 的**取值器**（建图/销毁会重新赋值 ⇒ 不许解构快照） */
  mapNow(): unknown;
  /** 🔴 宿主那面 `joyActive` 旗（**唯一一份仍在宿主**：五个 `m.on(...)` 早退与卸载都在读它）
   *  —— 与 S4 的 `alive` 同一条处理：模块每帧现读，要改就喊一声。 */
  joyActiveNow(): boolean;
  setJoyActive(v: boolean): void;
  /** 🔴 宿主那个 `let bldTimer`（`moveend` 那条 600ms 去抖也用它）—— 取值器 + 写入器 */
  bldTimerNow(): number;
  setBldTimer(v: number): void;
}

/* ══ S6（M3 `wsBldLanding`）的注入面 ═══════════════════════════════════════════════════
 * 与 S2~S5 同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体几乎一个字都不用动）。
 * 这一片的别名有**四类**（逐类逐处可数，理由写在 `wsBldLanding.ts` 的文件头）：
 *   · `alive` → `aliveNow()`（4 处，与原实现同一时刻现读；不许冻在入口）；
 *   · `map` → `mapNow()`（6 处读点 = 3 个函数体首行 + 3 处内联；唯一不许快照的是 `gwLayer`
 *     那个**以后才会被调**的取值器，它走内联）；
 *   · `roadSegs` / `drawnBld`（宿主那两个 `let` 是**只写**的）⇒ 走**写入器**各 1 处
 *     （与 S5 的 `setJoyActive` / `setBldTimer` 同一条落法：宿主握真源，模块不养第二份）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：真源永远只有一份
 *    （`stats` / `renderKind` / `theme` / `themeTier` / `fetchCell` / `roadSegs` / `drawnBld` 都在宿主）。
 * ⚠️ 字段只许按"真实调用点倒逼"增加：本块里**零引用**的 `perf` / `props` 因此没写上来
 *    （与 S1 里被推迟的 `StageCtx`、S5 的 `JoystickStageCtx` 同一条纪律）。
 */

/** M3 读的那几个地图成员 —— `BldMapLike`（取楼那一套）**再补两个 M3 用到的**。
 *  ⚠️ 为什么是"补"而不是新写一份：`BldMapLike` 已经是宿主那个 `map` 的**同一份**结构化视图
 *     （S1 搬来的，M2/M5/M6 都在用）⇒ 这里只 `extends` 它，绝不复制它的字段（C1 那条红线）。
 *  ⚠️ 这两个成员写**必填**：`project` 在挑楼那个闭包里是直接调的（`map ? … : null` 只是判空，
 *     没有 `typeof` 守卫），写成可选反而要往正文里加一处守卫 —— 那就不是"只搬不改"了。 */
export interface BldLandingMapLike extends BldMapLike {
  getPitch(): number;
  project(c: [number, number]): { x: number; y: number };
}

/** M3（挑楼流水线 / 落地）要用的宿主状态 —— 全部**只读**（宿主仍是它们唯一的拥有者）。
 *  ⚠️ 两个写入器是**唯一**允许 M3 改的宿主状态：那两个 `let` 的读者（吸附/寻路、名字层）
 *     都在宿主 ⇒ 模块自己养一份就是第二份真源。 */
export interface BldLandingCtx {
  /** HUD 计数（`bldPick` / `roads` / `roadStore` / `gwVerdict` / `note` 几格是 M3 写的） */
  stats: StageStats;
  /** 分路状态（`bldFlush` 与 `gwLayer` 的取值器都按它判"有没有图可落"） */
  renderKind: Ref<"init" | "webgl" | "waiting" | "failed" | "fallback2d">;
  /** 当前主题（`bldLayerSpecsFor` 与 `gwLayer` 的配色唯一来源） */
  theme: ComputedRef<WsMapTheme>;
  /** 形体档对应的样式档（真源 `wsMapTheme.themeForTier`；宿主那个 computed 的所有权不动） */
  themeTier: ComputedRef<ThemeTier>;
  /** 浏览器取数（M3 那三条离线管道都用它；`fetchWithTimeout` 的装配仍在宿主） */
  fetchCell: BundleFetch;
  /** 上妆（真源在 M6 `wsFallback2d`；M3 只在落图那一次调它） */
  dressBld(fc: { features?: BldFeature[] } | null, map: BldMapLike | null): { type: "FeatureCollection"; features: unknown[] };
  /** 2D 降级路的自绘（真源在 M6；`onNoMap` 那一支调它） */
  draw2d(fc: { features?: BldFeature[] } | null): void;
  /** HUD 去重器（**留在宿主**：它闭包宿主的 `bundleHudQueued` 与 `alive`） */
  scheduleBundleHud(): void;
  /** 路网图层规格（`roadLayerSpecsForMap` 的实现仍在宿主，M3 只转调，不写第二份） */
  roadLayerSpecsForMap(): Array<Record<string, unknown>>;
  /** 美术档（`?art=`；阈值/取参都在共享真源，宿主只给"读到几"） */
  WS_ART_LEVEL: number;
  /** 形体档（`?bld=2` = 2；`bldLayerSpecsFor` 的 `mode` 由它定） */
  WS_BLD_MODE: number;
  /** `?bldn=` 钉住的**旧口径**（非 null ⇒ 走按格挑的 A/B 老路） */
  WS_BLDN_PIN: number | null;
  /** 「视野内最少十栋房」阈值（挑楼时原样交给规则模块） */
  WS_BLD_INVIEW: number;
  /** 🔴 宿主那个 `let map` 的**取值器**（建图/销毁会重新赋值 ⇒ 不许解构快照） */
  mapNow(): BldLandingMapLike | null;
  /** 🔴 宿主那面 `alive` 旗的**取值器**（同 `ViewFetchCtx.aliveNow`；`bldFlush` 每处现读） */
  aliveNow(): boolean;
  /** 🔴 宿主那个 `let roadSegs` 的**写入器**（取值那半在宿主：吸附/寻路在读它） */
  setRoadSegs(v: RoadSeg[]): void;
  /** 🔴 宿主那个 `let drawnBld` 的**写入器**（取值那半在宿主：名字层经 `drawnBldNow()` 读它） */
  setDrawnBld(v: readonly unknown[]): void;
}

/* ══ S7（M7 `wsPickInteract`）的注入面 ══════════════════════════════════════════════════
 * 与 S2~S6 同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体几乎一个字都不用动）。
 * 这一片的别名有**六类**（逐类逐处可数，理由写在 `wsPickInteract.ts` 的文件头）：
 *   · `map` → `mapNow()`（5 处内联；布尔/对象没法按引用共享，每处现读）；
 *   · `mlMod` / `pins` → 体首 `mlModNow()` / `pinsNow()`（各 1 处 hoist）——
 *     `new mlMod.Marker(…)` 对箭头调用有优先级坑，`pins` 又既读又写；
 *   · `pins = …` → `setPins(…)`（1 处写入器，与 S6 的 `setRoadSegs` / `setDrawnBld` 同款）；
 *   · `roadSegs` → `roadSegsNow()`（2 处）· `drawnBld` → `drawnBldNow()`（1 处）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：`stats` / `theme` / `bboxRef` / `pins` / `drawnBld` /
 *    `roadSegs` / `nameLayer` / `labRootEl` 的真源都只有一份（在宿主那一侧）。
 * ⚠️ 字段只许按"真实调用点倒逼"增加：`domPins`（任务书列进 M7 但**故意留在宿主**）、
 *    `draw2dBbox` / `mapAvailable` / `aiFeatureCollection` 这些本块里零引用 ⇒ 没写上来。
 */

/** 建角色钉子用的那一个 MapLibre 成员 —— **只声明用到的**（不复制整个引擎类型，
 *  与 `BldMapLike` 同一条纪律）。`new` 那一句写在模块体首 hoist 下来的 `mlMod` 上。 */
export interface PickMarkerModLike {
  Marker: new (o: { element: HTMLElement; anchor: string; subpixelPositioning: boolean }) => {
    setLngLat(c: [number, number]): { addTo(m: unknown): PickMarkerLike };
  };
}

/** `new mlMod.Marker(…).setLngLat(pos).addTo(m)` 的产物 —— 宿主 `pins` 里存的就是它。
 *  ⚠️ `getLngLat` 是**可选**：`pinEdgeSync` 读它时带 `?.`（MapLibre 有，桩里可能没有）。 */
export interface PickMarkerLike {
  setLngLat(c: [number, number]): unknown;
  getLngLat?(): { lng: number; lat: number };
  remove(): void;
}

/** 宿主那个 `let pins` 的元素形状 —— **不在这里再写一份**：它就是上面（M5 那一段）那个
 *  `StagePin`，本片只**增量**加了 `mk.remove()` / `mk.getLngLat?()` 与 `edge*` / `edgeKey`
 *  （见那一段的说明；真对象本来就是 `new mlMod.Marker(…)`，对摇杆是纯增量）。
 *  🔴 **这是本片唯一的非机械改动**：它是**类型**（编译后不存在）⇒ 运行时零改动。 */

/** M7（交互命中：钉子 / 吸附 / 锚点 / AI 示意层 / 信息卡点选）要用的宿主状态 —— 全部**只读**。
 *  ⚠️ 三个"不按引用共享"的入口是**取值器/写入器**：`map` / `mlMod` / `pins` 都是宿主 `let`
 *     （建图、动态 import、新增与移除钉子都会重写它）⇒ 模块自己养一份就是第二份真源。
 *  ⚠️ `cardData` / `cardOpen` / `closeCard` / `panel` **不在这里**：它们在 M7 那一块**里面**
 *     （连声明一起搬进模块，宿主同名解构回去给模板用）。
 *  ⚠️ `domPins` **故意不在**：它唯一的同步消费点 `createFallback2d` 在本装配点**之前**
 *     ⇒ 搬进 M7 就成环（理由写在 `wsPickInteract.ts` 文件头）。 */
export interface PickInteractCtx {
  /** 只用到 `adcode` / `grid` / `markers` / `aiItems` / `snapPins` 五个。
   *  ⚠️ 按**解析后的**类型写（宿主 `withDefaults` 给了默认值的那四个 ⇒ 不是 `| undefined`）；
   *     `adcode` **不在** `withDefaults` 的默认值表里 ⇒ 如实写可选（写成 `string` 会 TS2322）。 */
  props: { adcode?: string; grid: number; markers: WsDistrictPin[]; aiItems: AiItem[]; snapPins: boolean };
  /** HUD 计数（M7 写 `pins` / `pinsNote` / `pinsAnchor` / `card` / `note` 那几格） */
  stats: StageStats;
  /** 当前主题（AI 示意层的配色唯一来源） */
  theme: ComputedRef<WsMapTheme>;
  /** 「真数据够不够」⇒ 要不要留 AI 示意层（真源在 M8 `createHudStats`） */
  aiOn: ComputedRef<boolean>;
  /** 已画到地图上的 AI 示意图元数（HUD 要如实报） */
  aiDrawn: Ref<number>;
  /** 示意街区铺在哪（一个"小区尺度"的正方形） */
  aiBboxRef: Ref<BBox | null>;
  /** 区界 bbox（网格 → 经纬度要用它；`ensurePinAnchor` 也会写它） */
  bboxRef: Ref<[number, number, number, number] | null>;
  /** 钉子被点时只"报点"（开面板是宿主 `WsCharPanel` 那一侧的事） */
  emit(event: "pick-actor", id: string): void;
  /** 标签层容器（M4 接回来的 ref；`openCard` 量卡片矩形要读它） */
  labRootEl: Ref<HTMLElement | null>;
  /** 名字层实例（`indexFactOfNames` 只念它的 `facts()`；真源在 M4 `wsNameHost`） */
  nameLayer: NameLayer;
  /** 📍 屏外指示的两个宿主函数（`syncPins` 末尾各补一次；**故意留在宿主**：
   *  它们读宿主那一份几何缓存 `pinEdgeGeom`，搬进来就会把屏外指示整段拖进 M7） */
  pinEdgeMeasure(): void;
  pinEdgeSync(): void;
  /** 🔴 宿主那个 `let map` 的**取值器**（建图/销毁会重新赋值 ⇒ 不许解构快照） */
  mapNow(): unknown;
  /** 🔴 宿主那个 `let mlMod` 的**取值器**（动态 import 完才赋值 ⇒ 不许解构快照） */
  mlModNow(): PickMarkerModLike | null;
  /** 🔴 宿主那个 `let pins` 的**取值器**（新增/移除都会重写它；`pinEdgeSync` 与 M5 也在读） */
  pinsNow(): StagePin[];
  /** 🔴 宿主那个 `let pins` 的**写入器**（`syncPins` 末尾按存活名单过滤后写回） */
  setPins(v: StagePin[]): void;
  /** 🔴 宿主那个 `let roadSegs`（M3 的 `setRoadSegs` 在写它）—— 吸附只读 */
  roadSegsNow(): RoadSeg[];
  /** 🔴 宿主那个 `let drawnBld`（`afterDraw` 每轮重写）—— 屏幕距离兜底只读 */
  drawnBldNow(): readonly unknown[];
}

/* ══ S7（M9 `wsEngineGuard`）的注入面 ══════════════════════════════════════════════════
 * 与 S2~S7 同一套落法（宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体除别名外一个字都不用动）。
 * 这一片的别名逐类可数（理由与处数写在 `wsEngineGuard.ts` 的文件头）：
 *   · `alive` → `aliveNow()`（10 处）；`map` → `mapNow()`（14 处）+ `setMap(null)`（1 处）；
 *   · `resizeRo` / `recoverTimer` → 取值器 + 写入器（2+1 / 1+3）；`sawRender` → `sawRenderNow()`（5 处）。
 * ⚠️ 同样是"形状的说明书，不是第二份实现"：`stats` / `renderKind` / `cv` / `host` / `map` / `sawRender` /
 *    `resizeRo` / `recoverTimer` / `resizeTimers` / `isAutomation` 的真源都只有一份（在宿主那一侧）。
 * ⚠️ 字段只许按"真实调用点倒逼"增加。
 */

/** M9（引擎自愈 / 验证 / 自拍）要用的宿主状态 —— 全部**只读**，除了三个写入器与一个共享数组。 */
export interface EngineGuardCtx {
  /** 只用到 `locSource` / `worldTime`（验证面板那两格；两个都有默认值 ⇒ 是 `string` 不是可选） */
  props: { locSource: string; worldTime: string };
  /** HUD 计数（M9 写 `mode` / `note` / `perf` / `pins` 那几格，读别的） */
  stats: StageStats;
  /** 当前主题（面板要拿 `themeStyleParts` 算"期望的图层"） */
  theme: ComputedRef<WsMapTheme>;
  /** 性能档（`low` 与 `clearForce` 都在用；真源 `wsPerf` 的模块级单例） */
  perf: PerfApi;
  /** 模板那块画布（降级路会被换成新画布；`promoteToWebgl` 会写回真地图那块） */
  cv: Ref<HTMLCanvasElement | null>;
  /** 地图容器（resize 量与观察的对象） */
  host: Ref<HTMLElement | null>;
  /** HUD 节点（验证快照要把"人看到的那一行"原样带走） */
  hudEl: Ref<HTMLElement | null>;
  /** 装载阶段（`motionFacts` 读它报"现在到哪一段"） */
  phase: Ref<string>;
  /** 主题 id（快照里如实写出来是哪一套） */
  themeId: Ref<string>;
  /** 夜色开关 / 档位（快照那两格） */
  nightOn: Ref<boolean>;
  nightLvl: ComputedRef<number>;
  /** 渲染路（`in`it`/`waiting`/`failed`/`fallback2d` 都在这条路上写） */
  renderKind: Ref<"init" | "webgl" | "waiting" | "failed" | "fallback2d">;
  /** 降级原因原文（面板/JSON 都念它，不许转述） */
  fallbackWhy: Ref<string>;
  /** 临时还是永久（看门狗判的；面板要区分"还会回来"与"回不来了"） */
  fallbackKind: Ref<"none" | "temp" | "perm">;
  /** 地图库错误原文（数组是**共享的**：`m.on("error")` 那一路在 push） */
  mapErrs: string[];
  /** 真的把地图库跑起来了？（2D 降级时为 false；`promoteToWebgl` 切回来时会置 true） */
  mapAvailable: Ref<boolean>;
  /** 2D 降级路开关（M6 的出口；看门狗按它决定"等"还是"降"） */
  ALLOW_2D: boolean;
  /** 2D 降级路的落地（真源在 M6；看门狗只在临时/永久两类各调一次） */
  fallback2d(mode: string, fc: { features?: BldFeature[] } | null, why?: string, kind?: "temp" | "perm", map?: BldMapLike | null): void;
  /** M2 的读数出口（面板的 `bundle.live` 那一行；`on` 由宿主拼）。
   *  ⚠️ 形状按 `VerifySnapshot.bundle.live` 如实写：写成 `Record<string, unknown>` 的话，
   *     `...viewFetch.liveFacts()` 展开出来的东西对不上 `bundle.live` ⇒ TS2322。 */
  viewFetch: { liveFacts(): { bldHits: number; roadHits: number; bldInfo: string; roadInfo: string } };
  /** offline-first 开关（宿主自己那一份；面板如实写"默认不发 /api"） */
  LIVE_ON: boolean;
  /** 两条离线包的 facts 出口（面板念它们的读数，不重算） */
  bldFeed: { facts(): BundleFeedFacts };
  roadsFeed: { facts(): BundleFeedFacts };
  /** M1 的出口：转屏/改窗口时重量底盘尺寸（`onWinResize` 里那一句） */
  joyMeasureVh(): void;
  /** 📍 屏外指示的两个宿主函数（`onWinResize` 里各补一次；它们读宿主那份几何缓存） */
  pinEdgeMeasure(): void;
  pinEdgeSync(): void;
  /** 钉子的总同步（`promoteToWebgl` 切回 WebGL 那一下补一次；真源在 M7 `wsPickInteract`） */
  syncPins(): void;
  /** 🔴 宿主那个 `const` **数组**（`onBeforeUnmount` 要遍历清定时器）—— 模块只 `.push`，
   *  宿主那边照旧看得见 ⇒ 它是**同一个引用**，不是别名、也不是第二份。 */
  resizeTimers: number[];
  /** 自动化/无头判定（**留在宿主**：M6 装配那一刻就同步调它 ⇒ 搬进 M9 会成环） */
  isAutomation(): boolean;
  /** 🔴 宿主那面 `alive` 旗的取值器（卸载后所有异步路都要早退；每处现读） */
  aliveNow(): boolean;
  /** 🔴 宿主那个 `let map` 的取值器。
   *  ⚠️ 宿主那一份的类型**就是 `any`**（见它上面那行 eslint-disable 的注释）⇒ 这里如实写 `any`：
   *     写 `unknown` 会让快照里那几处 `map?.getStyle?.()` / `map?.isStyleLoaded?.()` 直接编不过
   *     （而"补一层 cast"就是改被搬走的正文了）。 */
  mapNow(): any;
  /** 🔴 宿主那个 `let map` 的写入器（watchdogFire 的**永久类**那一路会置 null） */
  setMap(v: unknown): void;
  /** 🔴 宿主那个 `let resizeRo` 的**写入器**（卸载要 `disconnect`；模块只写一次）。
   *  ⚠️ 它**返回**写进去的那个引用：`kickResize` 里把它绑成块内 `const resizeRo` 之后，
   *     下面两行 `resizeRo.observe(...)` **一个字都不用动**、TS 的「刚赋值」窄化也还在
   *     （只给取值器的话那两行会被判 possible null —— 那就得往被搬走的正文里加东西了）。 */
  setResizeRo(v: ResizeObserver): ResizeObserver;
  /** 🔴 宿主那个 `let recoverTimer`（卸载要 `clearTimeout`）—— 取值器 + 写入器 */
  recoverTimerNow(): number;
  setRecoverTimer(v: number): void;
  /** 🔴 宿主那面 `sawRender` 旗（`m.on("render")` 在写；看门狗"别只看时间"就靠它） */
  sawRenderNow(): boolean;
}

/* ══ S11（`wsStageEvents`）的注入面 ═══════════════════════════════════════════════════════
 * 与 S2~S7 同一套落法（宿主构造 ctx → 工厂里解构一次 ⇒ 回调体除别名之外一个字节都不用动）。
 * 本片消费的是**宿主 `onMounted` 里那一串地图事件接线**，形状上有一处别处没有的特点：
 * `fc` / `seat` / `districtBbox` / `districtFeat` / `maplibregl` 是 `onMounted` 的局部量
 * （setup 作用域够不到）⇒ 装配点在 `onMounted` 里，而且它们按**值**递进来 —— 都是那个 `try`
 * 之后**定稿**的量；走取值器会让 `if (fc?.features?.length)` 那处的 TS 窄化丢掉（TS18047），
 * 就得往被搬走的正文里加一行 `const fc = fcNow();`。理由逐条写在 `wsStageEvents.ts` 文件头。
 * 别名逐类可数（处数也在那边）：`alive` / `joyActive` / `watchdog` → 取值器；
 * `sawRender` → 写入器；`bldTimer` / `zoomNameTimer` → 取值器 + 写入器。
 * ⚠️ 字段只许按"真实调用点倒逼"增加（与 S1~S7 同一条纪律）。
 */

/** S11（地图事件接线）要用的宿主状态与函数。 */
export interface StageEventsCtx {
  /** 只用到 `joy`（`load` 里填"没有摇杆时的机位"快照与建摇杆会话的判据） */
  props: { joy: boolean };
  /** HUD（错误原文写 `note`；`mode` / `view` 那两格也在 `load` 里写） */
  stats: StageStats;
  /** 装载阶段（`load` 收尾写 `done`；真源仍在宿主） */
  phase: Ref<string>;
  /** `scene-ready` 的出口（把地图与真楼栋交给外层；签名与宿主 `defineEmits` 逐字一致） */
  emit(e: "scene-ready", payload: { map: unknown; buildings: { features?: unknown[] } | null; places?: () => readonly PlacePoint[] }): void;
  /** 地图库错误原文（**共享数组**：那条"只记不改"的 `error` 监听在 push） */
  mapErrs: string[];
  /** 本次取楼结果（`try` 里定稿、装配点之后再没人改 ⇒ 按值递进来） */
  fc: { features?: BldFeature[]; error?: string } | null;
  /** 行政区驻地（同上） */
  seat: { lng: number; lat: number } | null;
  /** 区县 bbox（同上） */
  districtBbox: [number, number, number, number] | null;
  /** 区县几何（同上；`load` 里那段已停用的边界图层在判空） */
  districtFeat: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> } | null;
  /** 动态 import 到的地图库本体（`load` 里要它的 `LngLatBounds`；`mlMod` 那份真源仍在宿主） */
  maplibregl: any;
  /** 初始俯角（`fitBounds` / `jumpTo` 用；真源在 M1） */
  initPitch: ComputedRef<number>;
  /** 没有摇杆时该有的俯角（填还原快照用） */
  basePitch: ComputedRef<number>;
  /** 近景分流判据（`load` 里决定要不要把漫游会话建起来） */
  joyGate: ComputedRef<ReturnType<typeof joyGateOf>>;
  /** 侧视角护栏（真源 `wsScene`；`pitch` 每变一次重设一次） */
  applyPitchGuard(m: any): void;
  /** M1 的三个相机 handler（`movestart` / `move` / `moveend`） */
  onMoveStart(): void;
  onMove(): void;
  onMoveEndNames(): void;
  /** M7 的点选入口（`click`） */
  onMapClick(e: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number }; features?: unknown[] }): void;
  /** M4 的名字层出口（`moveend` / `zoomend` 各一次） */
  reprojectNow(): void;
  refreshNames(why?: string): Promise<void>;
  /** M8 的离线包补格（`load` / `moveend`） */
  refreshBundles(why?: string): Promise<void>;
  /** M8 的进度条（`load` 里收尾） */
  stopTimer(): void;
  /** M7 的钉子总同步（`load` 收尾一次） */
  syncPins(): void;
  /** 📍 屏外指示（`load` 里量一次几何；三个相机钩子各同步一次） */
  pinEdgeMeasure(): void;
  pinEdgeSync(): void;
  /** M2 的按视野取数（`load` 与 `moveend`） */
  loadBuildingsForView(m: BldMapLike): Promise<void>;
  loadRoadsForView(m: BldMapLike): Promise<void>;
  loadFacilities(m: BldMapLike): Promise<void>;
  /** 署名（ODbL）随数据一起显示 */
  loadBundleAttribution(): Promise<void>;
  /** M3 的累积仓库与落图通路（`load` 把 live 首批并进去） */
  bldStore: FeatureStore<BundleBuildingFeature>;
  bldFlush(why: string): void;
  /** 跨过立体/足迹分界线 ⇒ 重挑一次（`zoomend`） */
  bldTierCrossedFlush(): void;
  /** offline-first 的结论（`moveend` 决定要不要现场取数） */
  bldLive: { live: boolean };
  roadsLive: { live: boolean };
  /** 🏠「我的家」的取名点取值器（随 `scene-ready` 一起递出去） */
  placesGetter(): readonly PlacePoint[];
  /** 代拍 / App 自拍（`load` 里各一次） */
  selfShotArmed(): boolean;
  runSelfShot(m: any): void;
  maybeAppSelfShot(kind: "webgl" | "fallback2d", why?: string): void;
  /** M5 的摇杆会话（`load` 里量标尺、写位置真源） */
  joyCalibrate(): void;
  joyApplyRoam(mv: JoyMotion): void;
  joyReadCam(): JoyCamSnapshot | null;
  prevCamNow(): JoyCamSnapshot | null;
  setPrevCam(cam: JoyCamSnapshot | null): void;
  originNow(): { lng: number; lat: number } | null;
  moveNow(): JoyMotion;
  /** 屏幕 px → 经纬度那把尺子（`null` = 还没量到 ⇒ `load` 里补量一次；判据是 `!scaleNow()`） */
  scaleNow(): JoyPxScale | null;
  roamStore: RoamStore;
  /** M1 的底盘尺寸（建图那一刻量一次） */
  joyMeasureVh(): void;
  /** 🔴 宿主那面 `alive` 旗的取值器（卸载后异步路要早退；每处现读，不许冻在入口） */
  aliveNow(): boolean;
  /** 🔴 宿主那个 `let joyActive` 的取值器（摇杆自持标志；8 处早退每处现读） */
  joyActiveNow(): boolean;
  /** 🔴 宿主那面 `sawRender` 旗的**写入器**（`m.on("render")` 是它唯一的写者） */
  setSawRender(v: boolean): void;
  /** 🔴 宿主那个 `let watchdog` 的取值器（`load` 里 `clearTimeout` 要读**当时**那一份） */
  watchdogNow(): number;
  /** 🔴 宿主那个 `let bldTimer`（`onBeforeUnmount` 要 clearTimeout）—— 取值器 + 写入器 */
  bldTimerNow(): number;
  setBldTimer(v: number): void;
  /** 🔴 宿主那个 `let zoomNameTimer`（同上）—— 取值器 + 写入器 */
  zoomNameTimerNow(): number;
  setZoomNameTimer(v: number): void;
}

/* ══ S13（`wsPinEdgeStage`）的注入面 ═══════════════════════════════════════════════════
 * 📍 屏外角色箭头那一族（`pinEdgeOn` / `pinEdgeGeom` / `pinEdgeInsetsOf` / `pinEdgeMeasure` /
 * `pinEdgeAvoid` / `pinEdgeSync` / `pinEdgeMetersOf`）要用的宿主状态。与 S2~S11 同一套落法：
 * 宿主构造只读 ctx → 工厂里解构一次 ⇒ 函数体除两处别名外**一个字节都不动**（对拍闸守着）。
 *
 * ⚠️ 三条纪律（与上面几片同源）：
 * ① **形状的说明书，不是第二份实现**：`pins` 的真源永远是宿主那个 `let`（M7 会重新赋值）；
 * ② **字段只许按"真实调用点倒逼"增加**；
 * ③ `pinEdgeOn`（`?edge=0` 开关）与 `pinEdgeGeom`（量一次就缓存的几何）**不在这里** ——
 *    它们只有这一族读写（宿主一个读者都没有）⇒ 连声明一起搬进模块，不是第二份真源。
 */
export interface PinEdgeStageCtx {
  /** 底板元素（唯一的几何来源：`clientWidth/clientHeight` 与安全区探针的挂点；容器节点是同一个，
   *  `ref` 本身按值递进来，宿主不会换掉它） */
  host: Ref<HTMLElement | null>;
  /** 🔴 宿主那个 `let pins` 的**取值器**（新增/移除钉子都会重写它 ⇒ 不许解构快照；
   *  `pinEdgeSync` 函数体首行现读一次，全程同步 ⇒ 与逐处现读逐条等价） */
  pinsNow(): StagePin[];
  /** 🔴 宿主那个 `let map` 的**取值器**（同上；`pinEdgeSync` 体首现读一次） */
  mapNow(): unknown;
}
