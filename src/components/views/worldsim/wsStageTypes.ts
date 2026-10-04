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
