/* wsBldLanding.ts —— M3：**挑楼流水线 / 落地**（`PLAN-REFACTOR.md` §2.1 / §2.2 / §3 的 S6 行）。
 *
 * ## 这个文件是什么
 * 从 `WsDistrictMapLibre.vue` **整块搬出来**的那一段（锚点 = **函数名 / 标识符**，不按行号）：
 * `LIVE_ON` · `bldLive` / `roadsLive` · `viewHalf` / `liveRadiusFor` · `bldStore` / `roadsStore` /
 * `placesStore` · `bundleView` · `bldPickStore` · `bldShapeTierName` / `bldPickLine` / `bldCellDegNow` ·
 * `bldFlush`（连同它自己的三份会话状态 `bldFlushWhy` / `bldPickWhy` / `bldPickTier` / `bldFlushedOnce` /
 * `bldFlushedTier`，以及 `watch(bldDrawMode)`——那个 watch **只读块内状态**，所以整块跟着走）·
 * `bldTierCrossedFlush` · `roadsFlush`（+ `roadFlushWhy`）· 三条离线管道 `bldFeed` / `roadsFeed` /
 * `placesFeed`（+ `placesFlush` / `placesGetter` / `placePoints` / `bundleViewHalfMeters`）· `gwLayer`。
 *
 * ## 没搬的（照实留痕）
 * **留在宿主的**（有实测消费点，搬了就是第二份 ⇒ 由宿主经 ctx 注入）：
 *   · `fetchCell` —— M3 那三条 feed **和** M4 `createNameLayer` **和** M8 `createBundleHud` 都在吃；
 *   · `stats` / `renderKind` / `theme`（+ `themeTier`）—— HUD 出口与主题真源都在宿主；
 *   · `dressBld` / `draw2d`—— 由 `createFallback2d`（M6）给回来，宿主再转注给这里；
 *   · `perf` / `props` —— 本块里**零引用**（实测逐行扫过），所以 ctx 里没有它们
 *     （字段只按真实调用点倒逼增加，见 `wsStageTypes.ts` 那条纪律）。
 * **只写不持有的两个 `let`**（宿主仍是唯一拥有者；模块**不养第二份**）：
 *   · `roadSegs`（吸附/寻路在读它）⇒ ctx 给**写入器** `setRoadSegs`；
 *   · `drawnBld`（名字层经 `drawnBldNow()` 读它）⇒ ctx 给**写入器** `setDrawnBld`。
 *   与 S5 的 `setJoyActive` / `setBldTimer` 同一条落法（取值器/写入器成对，宿主握真源）。
 * **`artTheme` 原地不动**（宿主那一段一个字都没改）：它虽然写在原块的范围里，但唯一的消费点
 * （`createFallback2d` 的 ctx）在**装配点之前**，而 M3 又要那个工厂给回来的 `dressBld` / `draw2d`
 * ⇒ 搬进来就是**互相依赖成环**。按 §1.4「做不到只搬不改的那段就别搬」处理，理由记在这里。
 *
 * ## ctx 的落法（与 S2~S5 同一套）
 * 宿主构造一份只读 ctx，本工厂在开头**解构一次**，解构出来的名字与搬走前宿主里的闭包变量**同名**
 * ⇒ 下面这些函数的函数体**一个字节都不用改**（对拍闸 `ws_bldlanding_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 🔴 只有四类别名（逐类可数；对拍闸把每一类都机器化，多一处少一处都红）
 * ① `alive` → `aliveNow()`（**4 处**）：JS 里布尔无法按引用共享，且**不许冻在入口** ——
 *    `bldFlush` 会跑在 `moveend` 去抖与落图回调里，`roadsFlush` 跑在取数回调里 ⇒ 与原实现
 *    **同一时刻现读**同一个值（理由与 S4 `wsViewFetch.ts` 文件头逐字同款）。
 * ② `map` → `mapNow()`（**6 处读点** = 3 个函数体首行 + 3 处内联）：宿主那面是 `let`
 *    （建图时赋值、降级/卸载时置 null）。三个函数（`bldFlush` / `bldTierCrossedFlush` / `roadsFlush`）
 *    **全程同步**：落图回调由 `flushBldStore` / `flushRoadsStore` **同步**调用（见 `wsDistrictScene`），
 *    而 `mapNow()` 只是读一下宿主那个变量（无副作用、无投影）⇒ 首行读一次与逐处现读**逐条等价**
 *    （S5 `wsJoystickStage.ts` 同款落法，那 8 个函数也是体首一行）。
 *    ⚠️ **唯一不许快照**的是 `gwLayer` 的 `map` 取值器：它由共享模块在**以后**（`refresh`）才调 ⇒
 *    那一处是**内联 `mapNow()`**，读的时刻与搬走前完全相同。另外两处内联（`bundleView` /
 *    `bundleViewHalfMeters`）本身就是函数体第一句，等价于"体首那一次读"。
 * ③ `roadSegs = …` → `setRoadSegs(…)`（**1 处**）；④ `drawnBld = …` → `setDrawnBld(…)`（**1 处**）。
 * ⚠️ 除这四类，**没有**任何别的正文改动：分支 / 阈值 / 调用顺序 / 回调顺序 / DOM 契约**逐字不变**。
 *
 * ## 装配位置（TDZ）与依赖方向
 * 宿主那处 `createBldLanding({…})` 必须在 `stats` / `fetchCell` / `renderKind` / `theme` /
 * `themeTier` / `dressBld` / `draw2d` **都声明之后**（`const` ⇒ 早引必踩 TDZ），而在
 * M8 `createBundleHud` / M2 `createViewFetch` / M5 `createJoystickStage` **之前** ——
 * 它们要 `bldFeed` / `bldStore` / `bldFlush` 这些**从返回值上取的**量。
 * ⚠️ 宿主解构出来的名字与原闭包变量**同名** ⇒ 所有下游调用点（宿主里那几处，以及模块侧
 * `wsViewFetch.ts` / `wsJoystickStage.ts` 经 ctx 的调用）**一个字都没改**，也都是**同一个函数**
 * ——本文件是它们唯一的实现（没有第二份）。
 * 依赖方向（§2.2）：本模块属 L2，**不 import 宿主**、也不与任何 M* 横向 import（共享量全由宿主注入）；
 * 它要的 `bldFlush` 级别的横向量一件都没有（本片实测**不需要** `wsViewFetch.ts` 那边任何东西）。
 */
import { watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { bldLiveDecision, fetchRadiusForView, roadsLiveDecision, viewHalfMetersOf } from "./wsScene";
import {
  BLD_STORE_CAP,
  PLACES_STORE_CAP,
  ROADS_STORE_CAP,
  bldIdOf,
  bldPointOf,
  createBundleFeed,
  placesIdOf,
  placesPointOf,
  roadsIdOf,
  roadsPointOf,
  type BundleBuildingFeature,
  type BundlePlaceFeature,
  type BundleRoadFeature,
  type BundleView,
} from "./wsOfflineFeed";
import { createFeatureStore } from "./wsFeatureStore";
import {
  WS_BLD_VECTOR_MINZOOM,
  bldLayerSpecsFor,
  flushBldStore,
  flushRoadsStore,
  type BldPickAnyStats,
} from "./wsDistrictScene";
import {
  WS_BLD_CELL_CAP_REF_DEG,
  bldCapForCellDeg,
  createBldPickStore,
  type BldPickStats,
} from "./wsBldPickStore";
import { bldMaxDrawnOf, bldMetersPerCssPixel, bldPxPerMeter, bldTierOfZoom, type BldBudgetBounds } from "./wsBldBudget";
import { WS_BLD_MODE_MANY, useWsBldMode } from "./wsBldMode";
import type { BldFeature } from "./wsBuildingSources";
import type { PickBounds, PickFeature } from "./wsBuildingPick";
import { createGwLayer, type GwMapLike } from "./wsGwLayer";
import { visibleRoadCount } from "./wsRoads";
import { roadSegments } from "./wsSnap";
import type { PlacePoint } from "./wsDaily";
import type { BldLandingCtx, BldMapLike } from "./wsStageTypes";

/**
 * 装配 M3（挑楼流水线 / 落地）。
 * ⚠️ 位置与理由见文件头「装配位置（TDZ）与依赖方向」那一段。
 */
export function createBldLanding(ctx: BldLandingCtx) {
  /* 解构出来的名字**与搬走前宿主里的闭包变量同名** ⇒ 下面函数体一个字都不用动（见文件头）。 */
  const { stats, renderKind, theme, themeTier, fetchCell, dressBld, draw2d } = ctx;
  const { scheduleBundleHud, roadLayerSpecsForMap } = ctx;
  const { WS_ART_LEVEL, WS_BLD_MODE, WS_BLDN_PIN, WS_BLD_INVIEW } = ctx;
  const { aliveNow, mapNow, setRoadSegs, setDrawnBld } = ctx;

  /* ══ 🧱🏢🛣 **offline-first + 累积仓库**（切片 A，2026-09-25）══════════════════════════
     病根（机主三条真机反馈同源）：「**楼只有一块**」「**加载慢**」「**路时有时无**」——
     App 一直走"现场取数 + 整份替换"：`/api/buildings` 一次只覆盖视野中心 R≤2000m 且冷查 27~33s
     （最慢见过 91.7s）、`/api/roads` 600m 冷查 32.5s（默认打一条必然撞超时）；而每取到一批就
     `setData(这一批)` ⇒ **整份替换** ⇒"新的一来旧的没了"。

     ✅ 现在两条数据都走**离线包**（静态文件，快且可预期）并进**同一个累积仓库**，一次 `setData`：
       · 默认 **0 条** `/api/buildings`、**0 条** `/api/roads`（决策取自真源 `wsScene.*LiveDecision()`）；
       · 只有 `?live=1` 才现场取数（补新区域/调试），失败照旧**可见**；
       · 换视野**要素数不减**（去重并集），淘汰只丢"视野外一圈"与超上限的（帧率护栏）。
     🔴 **判词/决策/半径一条都不在这里重写**：判词走 `bldVerdictText`/`roadsVerdictText`，
        半径走 `fetchRadiusForView`/`fetchRadiusLadder`/`viewHalfMetersOf`，格数学走 `wsFeatureStore`。
        旧的本地 `radiusForView`（那份"两份实现"）在本切片**删除**。 */
  const LIVE_ON = (() => {
    try {
      return /[?&]live=1\b/.test(location.search);
    } catch {
      return false;
    }
  })();
  const bldLive = bldLiveDecision({ forceLive: LIVE_ON });
  const roadsLive = roadsLiveDecision({ forceLive: LIVE_ON });
  /* 🧱 重构切片 S4（M2）：`let liveBldHits` / `let liveRoadHits`（那两个"默认应当是 0"的命中计数）
     跟着 `load*ForView` 一起搬去了 `wsViewFetch.ts` —— 宿主这边走 `viewFetch.liveFacts()` 念它。
     面板回证的另外两个（`liveBldInfo` / `liveRoadInfo`）同一出处。 */

  /** 视野半对角线（米）——量出来的，交给真源判半径（App 不自己写三角函数，代拍页同款） */
  function viewHalf(m: BldMapLike): number | null {
    try {
      const b = m.getBounds();
      return viewHalfMetersOf(
        { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
        m.getCenter().lat
      );
    } catch {
      return null;
    }
  }

  /** live 取数半径：**规则全在 `wsScene.fetchRadiusForView`**（视野中心→角 与 zoom 档位取大者） */
  function liveRadiusFor(m: BldMapLike): { radius: number; decidedBy: string; want: number; limitWhy: string | null; halfM: number | null } {
    const halfM = viewHalf(m);
    const p = fetchRadiusForView(m.getZoom(), halfM);
    return { radius: p.radius, decidedBy: p.decidedBy, want: p.want, limitWhy: p.limitWhy, halfM };
  }

  /* 🧱 **累积仓库**：由真源 `wsFeatureStore.createFeatureStore()` 造（合并/淘汰规则只有那一份），
     去重键与代表点取法由 `wsOfflineFeed` 给（一处定义、自检与 App 同一份）。 */
  const bldStore = createFeatureStore<BundleBuildingFeature>({ cap: BLD_STORE_CAP, idOf: bldIdOf, pointOf: bldPointOf });
  const roadsStore = createFeatureStore<BundleRoadFeature>({ cap: ROADS_STORE_CAP, idOf: roadsIdOf, pointOf: roadsPointOf });
  /* 🏘 **片区名仓库**（切片③，2026-10-01）：只给「我的家」取名点用（**不进地图、不画**）。
     cap / 去重键 / 代表点全取共享真源（与代拍页 `placesStoreOf()`（`ws3dshow.html:3485-3496`）同一份模块）。 */
  const placesStore = createFeatureStore<BundlePlaceFeature>({ cap: PLACES_STORE_CAP, idOf: placesIdOf, pointOf: placesPointOf });


  /**
   * 宿主视野（喂给 `createBundleFeed({ view })`）。
   *
   * ⚠️ **口径更正（2026-09-28）**：这段注释以前写的是「`map` 还没建时给 null ⇒ 管道本轮什么都不做，
   * **如实写成"未取"**」—— 后半句**是假的**，实测 `wsOfflineFeed.ts:945-946`：`bounds=null` ⇒
   * `plan()` 返回 null ⇒ `runOnce` 直接 `return { planned: false }`，**没有任何 HUD / onError 出口**
   * ⇒ 屏幕上**永远不会**出现"未取"。也就是说"没有地图 ⇒ 静默不取"这件事在当时**没有被写出来**，
   * 而这正是"降级路看起来一个人都没有、也没有解释"那一环的源头之一。
   * 现在这句话只陈述**事实**：没有地图 ⇒ 返回 null ⇒ 管道**静默**跳过本轮。
   * （要不要给它补一个 HUD 出口属于"降级路"那条线，2026-09-28 机主口径是**先不推进降级**，故此处只改注释。）
   */
  function bundleView(): BundleView {
    const m = mapNow();
    try {
      if (!m?.getBounds || !m?.getCenter) return { bounds: null, center: null };
      return { bounds: m.getBounds() as BundleView["bounds"], center: m.getCenter() as { lng: number; lat: number } };
    } catch {
      return { bounds: null, center: null };
    }
  }

  /** 🏙 挑选/冻结编排器（**整屏一份实例** ⇒ 冻结集跨帧、跨视野保持 —— 这就是"同一格永远同一批"）。 */
  let bldPickStoreInst: ReturnType<typeof createBldPickStore> | null = null;
  function bldPickStore(): ReturnType<typeof createBldPickStore> | null {
    try {
      if (!bldPickStoreInst) bldPickStoreInst = createBldPickStore();
      return bldPickStoreInst;
    } catch { return null; }
  }

  /**
   * 🏙 **楼栋档位**（机主 2026-10-03 拍板：默认严格档 + 一个"多楼房模式（不推荐）"开关）。
   * 模块级单例 ⇒ 顶栏那颗 chip（`WsCityEntry.vue`）改了这里立刻看得到（下面的 `watch` 重挑重绘）。
   * 🔴 档位到上限的换算只有一份（`bldMaxDrawnOf`），本组件**不写 100 / 4000 这两个数**。
   *
   * ⚠️ **别名是刻意的**：本文件里早就有个 `WS_BLD_MODE`（**形体档** `?bld=2`：楼长什么样），
   *    这里是**另一件事**（**画几栋**：lean/many）—— 两个都叫 `bldMode` 迟早有人改错那一个。
   */
  const { mode: bldDrawMode } = useWsBldMode();

  /**
   * 🏙🌆 **HUD 那一行**（机主验收要能一眼读出三件事，2026-10-03 第五条）：
   *   ① **现在画的是哪一档形体 / 哪一档档位**（足迹 z<14 · 立体 z≥14 · 多楼房模式）；
   *   ② **每格取前几栋（K）+ 这一屏画了几栋、来自几个格**（`stats.maxDrawn` / `cells` / `chosen`）；
   *   ③ **有没有被安全闸拦住**（`stats.why` 里那一串「安全闸拦住过：…（跳过 N 栋）」）。
   * 🔴 判词本体**仍然只由真源给**（`wsBldBudget.stats.why`，宿主不许再拼第二份）——
   *    这里只把**用户的选择**（哪一档）与**几个可数的总数**摆在前面，属于"选择/读数"，不是规则。
   *
   * ⚠️ 形体档读的是**这一轮落图用的那个档**（`bldPickTier`，在 `bldFlush` 里用共享真源
   *    `bldTierOfZoom(zoom, 上一次的档)` 现算现存）——**不是**"现在读一次地图的 zoom 再比 14"：
   *    跨 14 有 0.25 滞回 ⇒ 14.1 时画的仍是足迹档那一批，按 `zoom < 14` 报就会说成"立体"
   *    （判词撒谎）。也不是"现在读一次地图"，否则去抖窗口里那一行会与真正画出去的那批对不上。
   */
  function bldShapeTierName(): string {
    /* 多楼房模式：全 zoom 一致（用户明确要"多"）⇒ 不报"足迹/立体"，只报那一档本身 */
    if (bldDrawMode.value === WS_BLD_MODE_MANY) return "🏙 楼房 多（不推荐）";
    if (bldPickTier === 0) return "🏙 足迹档（z<14 · 平面）";
    if (bldPickTier === 1) return "🏙 楼房 严格档（z≥14 · 立体）";
    return "🏙 楼房 严格档";
  }
  function bldPickLine(s: BldPickAnyStats): string {
    /* `?bldn=` 那条 A/B 老路（按固定经纬格挑）**没有档位这回事**：原样转交它自己的判词
       （那个口径的"画几栋"由每块上限决定，写"严格档 ≤K 栋/格"就是撒谎）。 */
    if (!("maxDrawn" in s)) return s.why;
    /* 🔴 **不重复念数**：`why`（真源产出）里已经有「格 N 个（首…末）⇒ 画 M 栋（X 格出楼）·
       每格取前 K · 每格上限截过 C 格 · Σ投影/Σ顶点 · 安全闸拦住过：…（跳过 D 栋）」——
       宿主只补**用户的选择**（哪一档）与那个数本身，不再自己写第二份"画了多少"。 */
    return bldShapeTierName() + " · 每格 ≤" + s.maxDrawn + " 栋 · " + s.why;
  }

  /**
   * 🧱 **区块/数据格边长（度）** —— 与代拍页 `bldCellDeg()` **同一口径**：
   * 包自报的 `index.cellSize`（`feed.facts().cellDeg`）优先，读不到才退回 0.05（老包 / 索引还没读到）。
   * 🔴 绝不写死：分片包里格是 0.01°，写死 0.05 会让"同一个子格"的键两页对不上。
   */
  function bldCellDegNow(): number {
    try {
      const d = bldFeed.facts().cellDeg;
      if (typeof d === "number" && isFinite(d) && d > 0) return d;
    } catch { /* 落兜底 */ }
    return WS_BLD_CELL_CAP_REF_DEG;
  }

  /**
   * 🧱 **落图（楼）**：仓库并集 →（宿主上妆 `dressBld`）→ **一次 `setData`**。
   * 落图通路本身在共享真源 `wsDistrictScene.flushBldStore()`（PR 标准门禁 C1 要求"宿主只接线"）；
   * 这里只提供三件**宿主自己的**东西：**仓库**、**上妆口径**、**没有地图时怎么办**（2D 降级路交给自绘）。
   * 回退：`git revert <本 commit>`。
   */
  function bldFlush(why: string): void {
    const map = mapNow();
    if (!aliveNow()) return;
    bldFlushedOnce = true;
    /* 🌆 **这一轮按哪一档落图**（0 = 足迹 z<14 / 1 = 立体 z≥14 / null = zoom 读不出来）。
       🔴 prev = **上一次落图**的档（`bldFlushedTier`）⇒ 判据带 0.25 滞回（共享真源 `bldTierOfZoom`）：
          13.9↔14.1 来回缩放**不会**反复重挑（改造前是每跨一次就重挑一次）。
       🔴 顺序不能动：**读 prev → 算这一轮的档 → 落图 → 再把这一轮的档写回去**。
          先写等于把滞回关掉（每次都按裸阈值判），这也是本组件唯一写 `bldFlushedTier` 的地方。
       ⚠️ 闭包（下面的 `pick`）与这里用的是**同一次**算出来的档 ⇒ HUD 报的档与画出去的那批必然一致。 */
    const bldTierPrev = bldFlushedTier;
    const bldTierNow = bldTierOfZoom(map && typeof map.getZoom === "function" ? map.getZoom() : null, bldTierPrev);
    bldPickTier = bldTierNow;   /* HUD 那一行读它（与这一批同一档，见 `bldShapeTierName`） */
    flushBldStore<BundleBuildingFeature>(
      {
        features: () => bldStore.features(),
        /* 上妆（高度/颜色/拆件）在这里做**一次** ⇒ HUD 的计数与画出去的是同一批要素 */
        dress: (feats) => dressBld({ features: feats as unknown as BldFeature[] }, map),
        /* 2D 降级路没有可落的图（临时降级时 map 其实还在，但那时画的是自绘那块） */
        map: () => (renderKind.value === "fallback2d" ? null : (map as BldMapLike | null)),
        /* 🎨 **美术取参**：与代拍页同一份（`bldLayerSpecsFor` 内部调 `bldArtParamsOf`）——
           `?art=2` 把色阶高段推近白；`art=1` 时 `ramp` 是**主题那个引用**（恒等）⇒ 默认零改动。
           形体档 `mode:"base"` = 不拆件（机主 (a′) ⇒ 两页默认档同一条规格）。 */
        specs: () => bldLayerSpecsFor(theme.value, themeTier.value, { art: WS_ART_LEVEL, mode: WS_BLD_MODE === 2 ? "parts" : "base" }),
        onNoMap: (data) => draw2d(data as { features?: BldFeature[] }),
        /* 🏷 **记下"真正画出去的那批楼"**：名字层的锚点/点选降级都只认这一批 ——
           否则会出现机主报过的「有的压根没对应楼」（名字指到没画的楼）。
           这里存的是**引用**，不复制（一轮一次，开销可忽略）。 */
        afterDraw: (_why0, data) => {
          setDrawnBld((data as { features?: unknown[] })?.features || []);
        },
        /* 🏙 **近景挑选 = 与代拍页同一份编排**（`wsBldPickStore`）。
           🔴 2026-10-02 换口径（机主拍板的 **B2**）：「每格 4 栋」**改成双预算挑楼** ——
           候选 = 视野内**全部**楼，预算 = **Σ投影 px²（`WS_BLD_BUDGET_PX2`）+ Σ顶点（`WS_BLD_BUDGET_VERTS`）**，
           两个都是**固定常量**（不是按帧率自动缩），`moveend`/`zoomend` 每次落图重算一次。
           规则/成本模型/确定性排序**一行都不在这里**（在 `wsBldBudget`，两页共用）。
           🔀 **A/B 逃生口**：`?bldn=N` 显式钉住 ⇒ 走**旧口径**（按固定经纬格挑 + 按格冻结，`store.pick`），
           同一个 store、同一份实现 ⇒ 机主可以在**真机**上同一个机位对比新旧两套（帧率只有他能判）。
           近景才挑（远景走预渲染瓦片，挑它没意义）—— 阈值与楼房矢量层**同一个共享常量**。 */
        pick: (() => {
          try {
            const z0 = map ? map.getZoom() : null;
            if (z0 === null || z0 < WS_BLD_VECTOR_MINZOOM) return null;
            const store = bldPickStore();
            if (!store) return null;
            const legacyCell = WS_BLDN_PIN !== null;   // `?bldn=` 一给就退回旧口径（A/B）
            return (feats: readonly BundleBuildingFeature[]) => {
              /* ⚠️ 相机四件（zoom / bounds / 中心纬度 / 俯角）在**调用这一刻**现读：
                 闭包捕获会拿到旧机位，而预算挑楼的全部输入就是机位。
                 🆕 `zNow`（**读不出来就是 NaN**，不是兜一个 11）专给"按 zoom 分档"用：
                 足迹/立体的分界线必须按**真实 zoom** 判，读不到就退回严格档（宁可少画，不许乱画）。 */
              const zNow = map && typeof map.getZoom === "function" ? Number(map.getZoom()) : NaN;
              const z = isFinite(zNow) ? zNow : WS_BLD_VECTOR_MINZOOM;
              const bounds = map ? (map.getBounds() as unknown as BldBudgetBounds) : null;
              if (legacyCell) {
                /* 一轮只读一次格尺寸（与代拍页 `BLDCELL`/`BLDN` 同一口径）：冻结键/挑选/分组三者同值 */
                const cellDeg = bldCellDegNow();
                const cap = bldCapForCellDeg(cellDeg, WS_BLDN_PIN);
                return store.pick({
                  features: feats as unknown as PickFeature[],
                  cap,
                  cellDeg,
                  bounds: bounds as unknown as PickBounds,
                  minInView: WS_BLD_INVIEW,
                }) as unknown as { features: readonly BundleBuildingFeature[]; stats: BldPickStats };
              }
              /* 📍 2026-10-04 第六条「**就近补齐**」的参照点 = **锚点的种子**（第七条改成锚点冻结）。
                 为什么加（机主原话）：「**保证地图上绝对有楼就行**」（他在"楼不见后还缩小了看，还是没有楼"）。
                 根因（真浏览器探针量过）：相机 38°~64° 俯角下"看得见的地面"只是一条窄带，而"每格取前 K"
                 **完全不看相机** ⇒ z16.4 那 12 栋锚点全落在窗口外、z19（放大到最大）直接是**空集**。
                 🔴 **第七条（机主：「在我移动了角色后，角色周围就出现了楼，很诡异喵」）**：
                 这里传的仍是**实时相机中心**，但 `store` 不再拿它当参照点 —— 它把这颗种子
                 **落成锚点格**（与 base 同一个 `cellDeg`），**同一个格只认第一次**那个点
                 ⇒ 同格内走动输出逐字节不变、跨格才新增、已画出去的绝不消失。
                 ⚠️ 所以**这一行不用改**（名字与语义都在 `wsBldPickStore.BldBudgetInputLite.nearCenter` 里写清了）；
                 宿主这边一个字都不许自己判"是不是新格"（那是编排层的状态，两页同一份）。
                 ⚠️ 与原 `centerLat` **共用这一次 `getCenter()`**（一轮一次相机读，不为了补楼多读一遍）。 */
              const centerLL = map && typeof map.getCenter === "function" ? map.getCenter() : null;
              const centerLat = centerLL ? Number(centerLL.lat) : 0;
              const pitch = map && typeof map.getPitch === "function" ? Number(map.getPitch()) : 0;
              return store.pickBudget({
                features: feats,
                bounds,
                screen: {
                  /* 屏幕投影：直接用地图库那把尺子（`map.project` 是**地面**投影，不带高度 —— 墙面的
                     屏幕高度由共享的 `bldPxPerMeter` 补，两页同一把尺子）。
                     🆕 2026-10-03 第五条起：挑楼**一次都不会调它**（候选池与排序键都与相机无关），
                     屏幕量全部由下面的 `metersPerPixel` 换算 —— 传它只是保持接线与自检口径一致。 */
                  project: (lng: number, lat: number): [number, number] => {
                    const p = map ? map.project([lng, lat]) : null;
                    return [p ? Number(p.x) : NaN, p ? Number(p.y) : NaN];
                  },
                  pxPerMeter: bldPxPerMeter(z, centerLat, pitch),
                  /* 🌆 那把**唯一**的屏幕尺子（1 px = 多少米）：同一个 `z`/中心纬度算出来的，
                     与 `bldPxPerMeter` **同一族公式**（都在共享真源里），页面侧同样只接线。 */
                  metersPerPixel: bldMetersPerCssPixel(z, centerLat),
                },
                /* 🏙 **每格取前 K 栋**（机主 2026-10-03 第五条：「显示哪些楼直接定下来」）：
                   K **只看用户选的档位**（严格档 3 / 多楼房 4000），**与 zoom / 与相机无关** ——
                   所以这里**没有** `zNow` / `bldTierPrev` 之类的相机输入（有它们就又是"集合随缩放变"）。 */
                maxDrawn: bldMaxDrawnOf(bldDrawMode.value),
                /* 🧮 分格的那张网格 = **离线包自己的格**（`index.json.cellSize`，与取数管道同一份）：
                   包自报优先、读不到才退回 0.05（老包）。写死 0.01 会让换包时"格"与包对不上。 */
                cellDeg: bldCellDegNow(),
                minInView: WS_BLD_INVIEW,
                /* 📍 **就近补齐**（2026-10-04 第六条引入；**第七条起这是"锚点的种子"**）：
                    把"离**本格锚点**最近、又还没入选"的那几栋追加到这批的**尾部**（栋数默认
                    `wsBldBudget.WS_BLD_NEAR_K` = 10，不在这里写死）。锚点表与补齐件冻结集都在
                    `store` 里（跨帧、跨视野保持）—— 宿主只负责**如实把实时相机中心喂给它**。 */
                nearCenter: centerLL ? { lng: Number(centerLL.lng), lat: Number(centerLL.lat) } : null,
              });
            };
          } catch { return null; }
        })(),
        onPicked: (s) => {
          const line = bldPickLine(s);
          bldPickWhy = line;
          stats.bldPick = line;
          scheduleBundleHud();
        },
        beforeDraw: (why0) => {
          bldFlushWhy = why0;
          scheduleBundleHud();
        },
      },
      why
    );
    /* 🔴 **落图之后**才把"这一轮是哪一档"记成下一次的 prev（滞回的写回点，全局只有这一处）——
       顺序反过来（先写后落图）等于把滞回关掉，见上面那段注释。 */
    bldFlushedTier = bldTierNow;
  }
  /** 上一次 flush 的原因（面板回证：是离线包来的还是 live 来的） */
  let bldFlushWhy = "";
  /** 🏙 上一次"近景挑楼"的口径（机主要 100 栋/视野）——面板回证用，没挑过就是空串 */
  let bldPickWhy = "";
  /** 🌆 **这一轮落图用的形体档**（0 = 足迹 z<14 / 1 = 立体 z≥14 / null = zoom 读不出来）——
   *  HUD 那一行（`bldShapeTierName`）读它，**不是**每帧去问地图（否则判词会与真正画出去的那批对不上）；
   *  它同时是"跨 14 要不要重挑"与"挑楼走哪条路（静态/投影）"的**同一个**判据来源。 */
  let bldPickTier: number | null = null;
  /** 这一屏**至少落过一次楼图**了（档位开关只在它之后才补一次重挑重绘，见下面的 `watch`） */
  let bldFlushedOnce = false;
  /** 🌆 **上一次落图**所在的形体档（滞回判据的 prev；0 = 足迹 / 1 = 立体 / null = 读不出来）——
   *  **只在 `bldFlush` 里写一次**（读 prev → 算新档 → 落图 → 写回，所有落图路径共用这一个写点）。 */
  let bldFlushedTier: number | null = null;

  /**
   * 🏙 **档位一变 ⇒ 立刻重挑一次 + 重绘**（机主 2026-10-03：「用户可选择是否启用多楼房模式」，
   * 点了必须真的生效，不能等下一次 `moveend`）。
   *
   * 走的就是本组件**既有**的那条通路，一行新机制都没有：
   *   `bldFlush("bldmode")` → 真源 `flushBldStore()` → 里面的 `pick` 闭包**再跑一次**
   *   （`maxDrawn` 在那里现读档位）→ `pickBuildingsByBudget` 重挑 → `setData` 重绘
   *   → `onPicked` 回填 HUD（`bldPickLine` 会带上新档位）。
   * ⚠️ 与 `moveend`/`zoomend` 那条 600ms 去抖**不同**：这是**用户点的一下**，
   *    必须当场看到变化（去抖只会让它"点了像是没反应"）。
   * ⚠️ `bldFlushedOnce` 这道闸：地图还没建好时 `bldFlush` 会落到 2D 降级那支
   *    （`onNoMap` → `draw2d`），那属于初始化本身要干的事，不归这个开关管。
   */
  watch(bldDrawMode, () => {
    if (!aliveNow() || !bldFlushedOnce) return;
    bldFlush("bldmode");
  });

  /**
   * 🌆 **跨过足迹/立体的分界线 ⇒ 重挑一次 + 重绘**（2026-10-03「按 zoom 分层」那一笔）。
   *
   * ⚠️ 2026-10-03 第五条起这条重挑**不再是"为了换集合"**：挑选（每格取前 K）与 zoom 完全无关，
   *    跨线前后挑出来的是**同一批 id**（自检第 ⑩ 组钉着）。留着它是因为**画法**换档后仍要走一次
   *    既有落图通路，让 `onPicked` 回填的 HUD 与"这一轮实际用的档"对齐（否则判词会停在上一档）。
   *
   * 走的就是本组件**既有**的那条通路，一行新机制都没有：
   *   `bldFlush("bldtier")` → 真源 `flushBldStore()` → 里面的 `pick` 闭包**再跑一次**
   *   （`maxDrawn` 在那里按**用户档位**现算）→ `pickBuildingsByBudget` 重挑 → `setData` 重绘
   *   → `onPicked` 回填 HUD（`bldPickLine` 会带上新的形体档）。
   * ⚠️ **只在真的跨线时**才补：档位判据是共享真源 `bldTierOfZoom(zoom, bldFlushedTier)`
   *    （**带 0.25 滞回**）——`bldFlushedTier` 是上一次落图的档，所以 13.9↔14.1 来回 10 次
   *    也**一次都不重挑**（改造前是 10 次；PLAN-BLD-LOWZOOM §验收 5）。
   * ⚠️ 档内每一次缩放都重挑一遍是白工（挑楼规则对同档的 zoom 变化已经由 `moveend` 那轮覆盖）。
   * ⚠️ `zoom` 读不出来（`null`）⇒ **不重挑**：拿不准就不动，宁可等下一次正常的落图。
   */
  function bldTierCrossedFlush(): void {
    const map = mapNow();
    if (!aliveNow() || !bldFlushedOnce) return;
    /* prev = 上一次落图的档 ⇒ 与 `bldFlush` 里算的是**同一个判据**（含滞回），不存在第二份阈值 */
    const tier = bldTierOfZoom(map && typeof map.getZoom === "function" ? map.getZoom() : null, bldFlushedTier);
    if (tier === null || tier === bldFlushedTier) return;
    bldFlush("bldtier");
  }

  /**
   * 🧱 **落图（路）**：仓库并集 → **一次 `setData`**（首次建源建层）。
   * 同楼：通路在 `wsDistrictScene.flushRoadsStore()`；宿主给仓库/地图/规格，并在落图前后做自己的计数。
   * ⚠️ 失败**必须可见**（原来是 try/catch 写 `stats.note`，这里保持同一口径）。
   */
  function roadsFlush(why: string): void {
    const map = mapNow();
    if (!aliveNow()) return;
    try {
      flushRoadsStore<BundleRoadFeature>(
        {
          features: () => roadsStore.features(),
          map: () => map as BldMapLike | null,
          specs: () => roadLayerSpecsForMap(),
          beforeDraw: (why0, data) => {
            /* 行人吸附用的段：拿到数据就留着（与画出去的是同一份，不重算一套） */
            setRoadSegs(roadSegments(data as never));
            roadFlushWhy = why0;
            scheduleBundleHud();
          },
          afterDraw: (_why0, data) => {
            const m = map as BldMapLike | null;
            if (!m) return;
            stats.roads = visibleRoadCount(data as never, m.getZoom());
            stats.roadStore = `仓库 ${data.features.length} 条（累积：已取 ${roadsFeed.facts().have} 格，包外 ${roadsFeed.facts().missing}，失败 ${roadsFeed.facts().failed}）`;
          },
        },
        why
      );
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 路网落图失败：${String((e as Error)?.message || e).slice(0, 40)}` : `路网落图失败：${e}`;
    }
  }
  let roadFlushWhy = "";

  /** 🛣🛣 离线包的两条管道（**永不发 `/api/*`**：只读静态包） */
  const bldFeed = createBundleFeed<BundleBuildingFeature>({
    kind: "bld",
    store: bldStore,
    view: bundleView,
    fetchCell,
    flush: bldFlush,
    /* 保留"视野外一圈"（与代拍页同式）：来回挪地图不该反复重取，也不该把刚取到的丢掉 */
    retainRadiusM: () => Math.max(2000, Math.round((bundleViewHalfMeters() || 0) * 2.2)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  const roadsFeed = createBundleFeed<BundleRoadFeature>({
    kind: "roads",
    store: roadsStore,
    view: bundleView,
    fetchCell,
    flush: roadsFlush,
    retainRadiusM: () => Math.max(3000, Math.round((bundleViewHalfMeters() || 0) * 2.5)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  function bundleViewHalfMeters(): number | null {
    const m = mapNow() as BldMapLike | null;
    return m ? viewHalf(m) : null;
  }

  /* ══ 🏘🏠 **第三条离线管道：片区名**（切片③，2026-10-01）══════════════════════════════════
     给谁用：「我的家」= 离地图中心最近的**有名片区**（`wsDaily.pickHome`）。
     为什么必须新接一条：App 原来只有 `bld`（`:3341`）与 `roads`（`:3353`）两条管道
     ⇒ 宿主**拿不到任何片区名**，而原型页的 `wsPlaces()`（`ws3dshow.html:4446-4468`）读的是
     **页面自己的** `placesStoreOf()`（`:3485-3496`）⇒ 那段内联 JS 在 App 里没有对应物，不能照抄。
     规则一行不写：目录 / 格尺寸 / 每轮格数 / 上限全是 `wsOfflineFeed` 的 SPECS 里那份（`kind: "places"`）。
     ⚠️ **不进地图**（`flush` 只重建快照）：名字层自己那条路负责画区名
        （`wsNameLayer.ts:486` 取的是同一批格）⇒ 同格会被取两次 —— 页面是**同款**双取
        （`:3485-3496` + `wsNameLayer.ts:486`），属已知口径，不是本片新引入的退化（施工图 §5.6）。 */
  let placePoints: readonly PlacePoint[] = [];
  /** 仓库并集 → 「我的家」要的取名点。**只留有名有坐标的**（没名字的一条都不留：绝不编） */
  function placesFlush(_why: string): void {
    const out: PlacePoint[] = [];
    for (const f of placesStore.features()) {
      const name = String(f?.n || "").trim();
      /* 形状交给共享取值器（`placesPointOf`）——原型页那条"按 GeoJSON 读 ⇒ 永远空数组"的坑
         （它自己的注释记着）在 App 这侧同样不许重演 */
      const pt = placesPointOf(f);
      if (!name || !pt) continue;
      out.push({ name, lng: pt[0], lat: pt[1], kind: f?.k || null });
    }
    placePoints = out;
  }
  /** 交给外层的取值器（`scene-ready` 的新可选字段）：**只读**，外层不许改 */
  function placesGetter(): readonly PlacePoint[] {
    return placePoints;
  }
  const placesFeed = createBundleFeed<BundlePlaceFeature>({
    kind: "places",
    store: placesStore,
    view: bundleView,
    fetchCell,
    flush: placesFlush,
    /* 与路同式（视野外一圈）：片区名稀且小，留宽一点，来回挪地图别反复重取 */
    retainRadiusM: () => Math.max(3000, Math.round((bundleViewHalfMeters() || 0) * 2.5)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });

  /* 🌊🌳 **水/绿地**：与代拍页**同一个模块、同一组参数**（格尺寸 / 取数 / 归一化 / 配色 / 层序 /
     署名 / 判词全在共享真源 `wsGwLayer` 里）。这里只给宿主自己的四样：**地图 / 视野 / 主题 / 取数**。
     ⚠️ 宿主里**一行规则都不写**（PR 门禁 C1 的红线：App 不许有第二份实现）——
     以前这类"取格 + 拼要素 + 定颜色 + 判词"在页面里有过一份内联原型，现在两边跑的是同一份。
     · **不设 zoom 闸门**：远景下它才最有用（机主 2026-09-26：「放太大了只能看到线路，
       水、绿植啥的都看不到」）⇒ 与楼/路不同，它每一档都取；
     · **层序**由共享真源给（`gwBeforeIdOf` = 第一个 `bld*` 图层之前 ⇒ 水/绿贴地面、楼盖在上面）。 */
  const gwLayer = createGwLayer({
    /* 2D 降级路没有可落的图（与 `bldFlush` 同一口径：那时画的是自绘那块） */
    map: () => (renderKind.value === "fallback2d" ? null : (mapNow() as unknown as GwMapLike | null)),
    view: bundleView,
    theme: () => theme.value,
    fetchCell,
    onHud: (line) => {
      /* 判词那一行由**真源**给（三态：正数 / 0（已量）/ 数不出来 + 原因），宿主只负责摆出来 */
      stats.gwVerdict = line;
    },
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });

  /* 宿主还要用的那些，逐个经返回对象交回（宿主一个调用点都没改）。 */
  return {
    LIVE_ON, bldLive, roadsLive, liveRadiusFor,
    bldStore, roadsStore, bldFlush, roadsFlush, bldTierCrossedFlush,
    bldFeed, roadsFeed, placesFeed, placesGetter, gwLayer,
  };
}
