/**
 * wsBldPickStore.ts —— **「按格挑选 + 按格冻结 + 视野补齐」的编排真源**（2026-09-26 抽出）。
 *
 * ## 为什么要有它（不是"再抄一份"，是**搬家**）
 * 规则（怎么挑、怎么排序、怎么补）**早就在** `wsBuildingPick.ts` 里（纯函数、自检钉着）。
 * 但**编排**——"先算 base → 只把 base 逐格冻结 → 补齐件每帧重算、不进冻结集"——
 * 一直**只长在 `public/ws3dshow.html` 里**（那段 `const ckey = …` 到 `window.__BLD_PICK__ = r.stats;`）。
 * 于是 App 宿主 `WsDistrictMapLibre.vue` 拿不到它 ⇒ 实测它那四个符号
 * （`capBuildingsPerCell` / `__BLD_FROZEN__` / `minInView` / `pickBuildingsForView`）命中**全是 0**
 * ⇒ App 侧没有"按格挑选 + 按格冻结 + 视野补齐"，**视野一变喂给地图的楼就变**（机主原话：
 * 「App 页用的建筑模型不是 art1，**每次滑动建筑都变了**，名字也没有」）。
 * 「编排长在页面里」正是 PR 门禁 **C1（不许第二份实现）** 要防的形状 ⇒ 先抽真源，页面/宿主只接线。
 *
 * ## 语义（三条口径，一条都不能少）
 * ① **每块 ≤ `cap`、同一块永远同一批** —— 挑选只依赖**固定经纬格**（`floor(x/size)*size`），
 *    与视野/中心**无关**；同一格算出来的那批（= `base`）一旦进冻结集，**后续只读冻结集**。
 * ② **视野内至少 `minInView` 栋** —— base 算完后数"base 里落在视野内的"，不够就从
 *    「视野内、未入选」那批按**同一套排序规则**补（`stats.floorAdded`）。
 * ③ 🔴 **补的那批绝不进冻结集** —— 否则挪一下地图，那 100 栋就换了一批 = 又回到机主否掉的"乱变"。
 *    因此：**冻结只冻结 `base`**（`stats.baseChosen` 之前那一段），补齐件**每帧重算**。
 *
 * ## 逐字节等价（`ws_bld_pick_store_selftest.mjs` 第④组钉着）
 * 本模块与**页面里那段旧实现**（从固定 git 锚点取出的原文，`new Function` 跑起来）
 * 在同输入下 `features` 的 id 序列与整个 `stats` **逐字节相同**。
 * 冻结键的格式、`toFixed(5)`、`Map` 的插入序（→ 输出顺序）全部照搬页面，**改这里的人别"顺手整理"**。
 *
 * ## 与规则模块的分工
 * · `wsBuildingPick.ts`：**怎么挑**（纯函数、无状态）；
 * · 本模块：**什么时候冻结、冻结哪一段、补齐件怎么算**（有状态、每个宿主一份实例）；
 * · 页面/宿主：**什么时候调、HUD 怎么念**（`stats.why` 由规则模块产出，宿主**不许**再拼第二份）。
 */

import {
  capBuildingsPerCell,
  type CapCellStats,
  type PickBounds,
  type PickFeature,
} from "./wsBuildingPick";
/* 🏙 **双预算挑楼**（机主 2026-10-02 拍板的 B2）：规则/成本模型/固定常量都在那一份里，
   本模块只做"宿主调哪一个口"的接线（页面与 App 都只认 `createBldPickStore()`）。 */
import {
  bldNearKOf,
  bldResolvedCellDeg,
  pickBuildingsByBudget,
  type BldBudgetStats,
  type BldBudgetBounds,
  type BldScreenCtx,
} from "./wsBldBudget";
/* 🧮 **格数学只有那一份**（`bundleCellOf` / `bundleCellKey`）：2026-10-04 第七条起
   **锚点也要落格**（"相机进过的离线包格"），必须与 base 的"按格取前 K"**同一张网**——
   两份 `floor(x/deg)*deg` 就是本项目栽过的那类"两套口径"。`wsFeatureStore` 不 import 任何东西 ⇒ 不成环。 */
import { bundleCellKey, bundleCellOf } from "./wsFeatureStore";

/** 一次挑选的输入（**全部显式传入**，本模块不读 `window`/`location`/全局主题） */
export interface BldPickInput<T extends PickFeature> {
  /** 仓库**全量**要素（含视野外）——"画面可以编，事实不许编"：这里永远给全量 */
  features: readonly T[];
  /** 每块上限（默认由规则模块定 = 100）；`0` = 一栋不画，但统计照报 */
  cap?: number;
  /** 区块边长（度）——**必须与离线包的格尺寸同口径**（`wsFeatureStore` / 索引 `cellSize`） */
  cellDeg?: number;
  /** 当前视野；不给 / 给坏的 ⇒ `inView` 报 **null（数不出来）**，绝不写 0 */
  bounds?: PickBounds | null;
  /** 视野内**至少**几栋（默认 0 = 不启用下限） */
  minInView?: number;
}

/** 规则模块的统计 + **编排**这一层自己产出的三个数（键序也与页面旧实现一致） */
export interface BldPickStats extends CapCellStats {
  /** 本轮**命中冻结集**的格数（用冻结那批、没重挑） */
  frozenCells: number;
  /** 本轮**首次冻结**的格数（新格照常加入） */
  newCells: number;
  /** 冻结集贡献的栋数（= `chosen − floorAdded`，与 `baseChosen` 同值；页面 HUD 用它独立核对） */
  frozenBase: number;
}

export interface BldPickOutcome<T extends PickFeature> {
  /** **base（冻结后）在前、视野补充件在后** —— 顺序稳定，"冻结集"可独立核对 */
  features: T[];
  stats: BldPickStats;
}

/**
 * `pickBudget()` 的输入 —— 与 `wsBldBudget.BldBudgetInput` 同形，只是**泛型放宽**
 * （预算路的候选不需要 `PickFeature` 那套字段，只要有个 `id` 就能做确定性排序的兜底键）。
 */
export interface BldBudgetInputLite<T> {
  /** 仓库**全量**要素（含视野外）——"画面可以编，事实不许编" */
  features: readonly T[];
  /** 当前视野（`map.getBounds()` 那种四个 getter 的对象） */
  bounds: BldBudgetBounds | null | undefined;
  /** 屏幕投影（`project` + `pxPerMeter`；公式真源 `wsBldBudget.bldPxPerMeter`） */
  screen: BldScreenCtx;
  budgetPx2?: number;
  budgetVerts?: number;
  /**
   * 🔴 **每格取前几栋（K）**（机主 2026-10-03："一开始直接固定可显示的楼房数据，严格限制"；
   * 同日第五条：候选池改成"按离线包格已加载的楼" ⇒ 这个数变成**每格**上限，不再是整屏上限）。
   * 与 `budgetPx2`/`budgetVerts` 同一路透传：**算 K 不在这里**（`bldMaxDrawnOf(档位)` 在
   * `wsBldBudget`、档位存储在 `wsBldMode`），本模块只把宿主算好的数原样交给规则模块。
   *
   * ⚠️ **K 与 zoom 无关**（第五条）：宿主只用**用户选的档位**算它；本模块**不碰地图对象**
   * （见文件头"本模块不读 `window`/`location`/全局主题"）⇒ 也没法在别处偷偷乘一个 zoom 因子。
   */
  maxDrawn?: number;
  /**
   * 🧮 **离线包格边长（度）** —— "按格取前 K"的那张网格（2026-10-03 第五条）。
   * 宿主给**包自报**的 `feed.facts().cellDeg`（页面/App 同一份）；不给 ⇒ 规则模块退回
   * `BLD_BUNDLE_CELL_DEG`（0.05）。**取格/算格键/分格三处必须是同一份格数学**，本模块只透传。
   */
  cellDeg?: number;
  minInView?: number;
  /**
   * 🆕 📍 **相机中心 —— 这是"锚点的种子"**（2026-10-04 第六条引入；**第七条改成锚点冻结**）。
   *
   * 🔴 语义变了（宿主接线不用改，但**理解必须换**）：它**不再**原样透传给规则模块当参照点，
   * 而是被本模块**落成锚点格**（与 base 同一个 `cellDeg`）后播进锚点表：
   *   · **同一个格只认第一次**那个点（"首次进入该格时的相机中心"）⇒ 宿主每轮照传实时中心，
   *     同格内怎么动都**不会**新增锚点 ⇒ 输出逐字节不变（机主要的就是这个：角色一动楼不该冒出来）；
   *   · 跨格才新增锚点（**只增不删**）⇒ 跨格可能多补几栋，且**已画出去的绝不消失**；
   *   · **坏值 / `null` / 没给** ⇒ 这一轮**不新增锚点**（已有锚点的补齐与"冻结还原"照常）——
   *     不吞、不猜，也不拿它当"锚点表清空"（清空会让已画的楼消失，正是第七条要治的病）。
   *
   * ⚠️ **字段名没改**（仍叫 `nearCenter`）是有意的：页面那条路的 store 来自 `public/vendor/wsScene.mjs`，
   * 旧产物只认这个名字 —— 改名会让页面在 vendor 重出之前**静默丢掉**就近补齐（"绝对有楼"当场退化）。
   * 新名字（锚点表）只出现在本模块与规则模块之间。
   */
  nearCenter?: { lng: number; lat: number } | null;
  /** 🆕 就近补齐的栋数（默认在规则模块里 = 10；`0` = 关闭）；**原样透传** */
  nearK?: number;
}

/**
 * `pickBudget()` 的统计 = **规则模块那一份 + 编排层自己产出的两个数**（键序：先规则、后编排）。
 *
 * 为什么要有后两个：规则模块只知道"**这一轮**用了几个锚点"（`nearAnchors`），
 * 而"**手里一共记着几个锚点 / 已经冻结了几批**"是**编排层**的状态 ——
 * HUD 与自检要能读到它（"锚点只增不删"这条得可数，不然就是一句空话）。
 */
export interface BldPickBudgetStats extends BldBudgetStats {
  /** 📍 本实例**手里一共记着几个锚点**（只增不删；≥ `nearAnchors`，坏种子那一轮会 > ） */
  nearAnchorTotal: number;
  /** 🔒 其中**已经冻结成批**的锚点数（那批要素的**引用**被本实例持有 ⇒ 离线包淘汰也不消失） */
  nearFrozenBatches: number;
}

/* ══ 🏙 「每块画几栋」「视野内至少几栋」—— **取参也在这一份里** ══════════════════════════════
 * 为什么放在这里（2026-09-26，两页一致性）：这两个数原来**只长在代拍页里**（页面自己的
 * `bldnEff()` / `INVIEW_N`）。App 宿主用的是另一套（`WS_BLD_VIEW_CAP` = 100，**按视野**挑的旧方案）
 * ⇒ 同一个机位、同一份包，两页画出来的楼不是一个集合。
 * ⇒ 数的来源收进真源：页面 `?bldn=`/`?inview=`、App 的调试口，都调这两个函数。
 */

/** 「每块 ≤100 栋」是按哪个格尺寸定的基准（页面历史口径：0.05° ≈ 5.5km） */
export const WS_BLD_CELL_CAP_REF_DEG = 0.05;
/** 视野内至少几栋（机主 2026-09-26：「还要保证视野内最少有十栋房」） */
export const WS_BLD_INVIEW_DEFAULT = 10;

/** `?bldn=` 显式钉住的每块上限（没给 ⇒ null）；`0` = 近景一栋不画（保留语义） */
export function parseBldnParam(search: string | null | undefined): number | null {
  try {
    const m = /[?&]bldn=(\d+)/.exec(String(search ?? ""));
    return m ? Math.max(0, Math.min(5000, parseInt(m[1], 10))) : null;
  } catch {
    return null;
  }
}

/**
 * 每块最多几栋 —— **跟着"块"的面积等比缩**（机主批的"等密度"算法）。
 * 依据：区块边长默认 0.05°≈5.5km；分片后数据格变成 0.01°（面积 1/25），若上限照旧 100
 * ⇒ 屏上密度**暴涨 25 倍**（那是改观感）⇒ 上限按面积缩：`100 × (deg/0.05)²`。
 * **老包（0.05°）⇒ 仍是 100，逐字节与旧版相同**；0.01° 包 ⇒ 自动变 4。
 *
 * @param cellDeg 区块/数据格边长（度）
 * @param pin     `?bldn=` 显式钉住的值（`parseBldnParam()`；null/不给 = 按面积算）
 */
export function bldCapForCellDeg(cellDeg: number, pin?: number | null): number {
  if (pin !== null && pin !== undefined && Number.isFinite(pin)) return Math.max(0, Math.floor(pin));
  /* 🔴 **逐字等于页面 `bldnEff()` 的那一行**（不含"校验 deg"的小动作）：
     页面那边 `deg` 已经过 `bldCellDeg()` 的校验（正数，否则退 0.05）⇒ 这里再加一层
     `deg > 0 ? deg : 0.05` 反而会让 `deg=0` 时两页不同（页面 `Math.round(100*0)=0 → max(1,0)=1`，
     加固版会退回 0.05 ⇒ 100）。**判据是"同输入同输出"，不是"更稳"** ——
     自检 `ws_pages_consistency.mjs` 第②组用 6 个格尺寸 × 6 个 pin 逐值钉着，`deg=0` 就是被抓到的那一例。 */
  const deg = Number(cellDeg);
  return Math.max(1, Math.round(100 * Math.pow(deg / WS_BLD_CELL_CAP_REF_DEG, 2)));
}

/**
 * `?inview=` 视野内下限（没给 / 非法 / 负数 ⇒ `def`，默认 `WS_BLD_INVIEW_DEFAULT` = 10）。
 * ⚠️ 正则与"非负才认"与页面那个通用 `qnum("inview", 10)` **逐条相同**（含小数）——
 *    自检第⑧组拿页面锚点原文里的 `qnum` 对拍，别"顺手改成 `\d+`"（那会让 `?inview=10.5` 两页不同）。
 */
export function parseInViewParam(search: string | null | undefined, def: number = WS_BLD_INVIEW_DEFAULT): number {
  try {
    const m = new RegExp("[?&]inview=(-?[0-9.]+)").exec(String(search ?? ""));
    if (!m) return def;
    const v = Number(m[1]);
    return isFinite(v) && v >= 0 ? v : def;
  } catch {
    return def;
  }
}

/** 冻结集快照（回证/HUD 用；**只读**，别拿它去改内部状态） */
export interface BldPickSnapshot {
  /** 冻结集里一共多少格（页面旧实现写进 `window.__BLD_FROZEN_N__` 的那个数） */
  frozenTotal: number;
  /** 冻结键（含 `cellDeg|cap@…` 前缀），**插入序** */
  keys: string[];
  /** 逐格明细：栋数 + id 序列（"同一格永远同一批"就是拿它逐字节比） */
  cells: Array<{ key: string; n: number; ids: string[] }>;
}

export interface BldPickStore {
  /** 挑一次。**纯编排**：不改入参要素，只更新内部的冻结集 */
  pick<T extends PickFeature>(input: BldPickInput<T>): BldPickOutcome<T>;
  /**
   * 🏙 **双预算挑楼**（机主 2026-10-02 拍板的 B2，**现在的默认口径**）。
   *
   * 与 `pick()` 的区别（一句话）：`pick()` 按**固定经纬格**挑（"同一格永远同一批"，有冻结集）；
   * 本方法按**代价**挑（候选 = 视野内全部楼，预算 = Σ投影 px² + Σ顶点，两个**固定常量**）。
   * ⇒ 本方法**没有冻结集**（它的确定性来自"同视野 + 同数据 ⇒ 逐字节同一批"，见 `wsBldBudget`）。
   *
   * ⚠️ `pick()` **仍然保留**：① 它是两页一致闸 `ws_pages_consistency.mjs` 第③组的判据对象
   *    （那一组拿它逐字节比两页口径）；② `?bldn=` 那条 A/B 老路还在。**两条路都只有一份实现。**
   */
  pickBudget<T extends { id?: unknown }>(input: BldBudgetInputLite<T>): {
    features: T[];
    stats: BldPickBudgetStats;
  };
  /** 冻结集里多少格（等价页面旧实现的 `window.__BLD_FROZEN_N__`） */
  frozenTotal(): number;
  /**
   * 🔴 **冻结缓存本身**（`{格键: 要素数组}`）——就是这份实例真正在用的那个对象，**不是拷贝**。
   * 为什么给这个口子：页面以前把这个对象挂在 `window.__BLD_FROZEN__` 上做回证（"同一格永远同一批"可核），
   * 接线后它应当**仍然是同一个对象**（拿它当 outlet ⇒ 零拷贝、也**不可能**出现第二份冻结点）。
   */
  frozenObject(): BldFrozenCellsObj<PickFeature>;
  /** 只读快照（确定性对拍 / HUD 回证） */
  snapshot(): BldPickSnapshot;
  /** 清空冻结集（换主题/换包/换口径时用；**不是**每帧该干的事） */
  clear(): void;
}

/**
 * 冻结缓存：`{格键: 要素数组}` 的**普通对象**（页面旧实现就是它，所以拿它当 outlet 时形状逐字节相同）。
 * ⚠️ 用普通对象而不是 `Map` 是有意的：键里含 `@` `|` `_` 与数字，**永远不是整数索引**
 * ⇒ `Object.keys()` 的插入序是规范的，与页面旧实现完全一致。
 */
export type BldFrozenCellsObj<T extends PickFeature = PickFeature> = Record<string, readonly T[]>;

/** 页面的旧实现就是拿这几个字段定位的（`geometry.coordinates[0][0]`）——**照搬，别"顺手整理"** */
function pointOfFeature(f: PickFeature): [number, number] | null {
  const p = (f.geometry && f.geometry.coordinates && (f.geometry.coordinates as number[][][])[0]
    && (f.geometry.coordinates as number[][][])[0][0]) || null;
  return p as [number, number] | null;
}

/**
 * 造一个挑选/冻结编排器。**每个宿主一份**（页面一份、App 宿主一份），
 * 冻结集就是这份实例的状态 —— 页面以前把它挂在 `window.__BLD_FROZEN__` 上。
 *
 * @param opts.frozen 传入既有的冻结缓存（`Map<格键, 要素数组>`）以便复用/外部核对；
 *                    不给就自己新建一份。
 */
export function createBldPickStore(opts?: { frozen?: BldFrozenCellsObj }): BldPickStore {
  const frozen: BldFrozenCellsObj = opts?.frozen ?? {};

  /* ══ 📍 **锚点表 + 各锚点的补齐件冻结集**（2026-10-04 第七条；机主「在我移动了角色后，
   *    角色周围就出现了楼，很诡异喵」+ 老口径「将楼的位置固定啊喵（包括名字）」）══════════════
   * 这一层**只存状态**：规则（取哪个锚点最近的那几栋、怎么排序）**一行都不在这里**，
   * 全在 `pickBuildingsByBudget`。本层做三件事：
   *   ① 把宿主给的**相机中心**落成锚点格（与 base 同一份 `cellDeg`、同一份格数学）；
   *   ② **同一个格只认第一次**那个点 ⇒ 同格内走动不新增锚点 ⇒ 输出逐字节不变；
   *   ③ 把每个锚点"这一轮真的入了列"的那批要素**按引用冻下来**，下一轮原样交回规则模块当
   *      `nearFrozen` ⇒ **离线包把那些格淘汰掉，已画的楼也不会消失**（整场单调）；
   *   ④ 标出**哪一个锚点是"当前锚点"**（相机所在那一格的那一个）：只有它还要**全量重算**，
   *      其余（老锚点）**只并冻结集**（`frozenOnly`）⇒ 每轮代价 = 1 次全池扫描 + 并集，
   *      **与锚点数无关**。这不是新口径，是"冻结"二字的直译：老锚点那批本来就"不许再变"。
   * 🔴 锚点表**只增不删**（口径如此：删一个锚点就会让它那批楼消失）。
   *    换包/换城市要换一份**新实例**（`clear()` 只清"按格挑选"那条路的冻结集，不动这里）。 */
  const nearAnchors: Array<{ lng: number; lat: number; key: string }> = [];
  const nearFeat = new Map<string, unknown[]>();
  /** 当前锚点的格键（相机这一轮落在哪一格）——`null` = 还没播过种（此时锚点表本来就是空的） */
  let nearCurrentKey: string | null = null;

  return {
    pick<T extends PickFeature>(input: BldPickInput<T>): BldPickOutcome<T> {
      /* ① 规则在共享纯函数里（本模块**不重写**挑选/排序/下限逻辑） */
      const r = capBuildingsPerCell(input.features, {
        cap: input.cap,
        cellDeg: input.cellDeg,
        bounds: input.bounds ?? null,
        minInView: input.minInView,
      });
      /* 🔴 用**模块解析后的**格尺寸/上限（不是入参的原始值）当冻结键的一截：
         入参非法时（NaN / 0 / 缺）规则模块会退回默认值，键必须跟着它走，否则会出现
         "同一份数据两套键"（页面旧实现直接用入参值，前提是那儿传进来的一定合法）。 */
      const size = r.stats.cellDeg;
      const cap = r.stats.cap;
      const ckey = size + "|" + cap;

      /* ② base = 前 `baseChosen` 个；**补齐件 = 剩下的**（每次重算、绝不冻结） */
      const baseN = (typeof r.stats.baseChosen === "number") ? r.stats.baseChosen : r.features.length;
      const baseFeats = r.features.slice(0, baseN);
      const addedNow = r.features.slice(baseN);

      /* ③ 逐格分桶（**只对 base 做**）——键格式与页面旧实现逐字节相同 */
      const byCellNow = new Map<string, T[]>();
      for (const f of baseFeats) {
        const pt = pointOfFeature(f);
        if (!pt) continue;
        const w = Math.floor(pt[0] / size) * size, s = Math.floor(pt[1] / size) * size;
        const k = ckey + "@" + w.toFixed(5) + "_" + s.toFixed(5);
        const arr = byCellNow.get(k);
        if (arr) arr.push(f); else byCellNow.set(k, [f]);
      }

      /* ④ 命中冻结集就用冻结那批；新格照常加入（插入序 = 首次出现序 ⇒ 输出顺序稳定） */
      const stableFeats: T[] = [];
      let frozenCells = 0, newCells = 0;
      for (const [k, arr] of byCellNow) {
        const fr = frozen[k];
        if (fr) {
          frozenCells++;
          /* 冻结集里的要素与本次的 `T` 是同一批（同一份仓库喂进来的）⇒ 这个收窄是安全的 */
          for (const f of fr) stableFeats.push(f as unknown as T);
        } else {
          frozen[k] = arr;
          newCells++;
          for (const f of arr) stableFeats.push(f);
        }
      }

      const stats: BldPickStats = {
        ...r.stats,
        frozenCells,
        newCells,
        frozenBase: stableFeats.length,
      };
      return { features: stableFeats.concat(addedNow), stats };
    },

    frozenTotal(): number {
      return Object.keys(frozen).length;
    },

    /* 🏙 **双预算挑楼** —— 规则一行都不在这里（在 `wsBldBudget.pickBuildingsByBudget`）。
       本方法之所以存在：页面与 App **都只认 `createBldPickStore()` 这一个口**
       （2026-09-26 抽真源的初衷），新口径不该让宿主去 import 第二个模块。 */
    pickBudget<T extends { id?: unknown }>(input: BldBudgetInputLite<T>): {
      features: T[];
      stats: BldPickBudgetStats;
    } {
      /* ① **播种锚点**：相机中心 ⇒ 锚点格（格边长 = **与 base 同一份解析** `bldResolvedCellDeg`，
             格数学 = **与 base 同一个** `bundleCellOf`/`bundleCellKey`）。
             🔴 `if (!nearFeat.has(key))` 这一行**就是本轮的修复本体**：同一个格**只认第一次**那个点
             （旧口径是"每轮现读相机中心"，于是一走动就换一批楼、在他脚边凭空冒出来）。 */
      const deg = bldResolvedCellDeg(input.cellDeg);
      const seed = input.nearCenter as { lng?: unknown; lat?: unknown } | null | undefined;
      const seedGiven = !!seed && typeof seed === "object";
      const seedLng = seedGiven ? Number(seed!.lng) : NaN;
      const seedLat = seedGiven ? Number(seed!.lat) : NaN;
      /* 🔴 `nearK: 0`（用户**关掉**补齐）⇒ **连锚点都不播** —— "关掉"必须是"什么都不做"：
         否则锚点表会悄悄长起来，下次打开时参照点已经不是"你进这一格时的位置"了。
         "什么叫关着"的口径只有一处（`bldNearKOf`，与规则模块同一个函数、同一个默认数）。 */
      if (bldNearKOf(input.nearK) > 0 && seedGiven && isFinite(seedLng) && isFinite(seedLat)) {
        const cell = bundleCellOf(seedLng, seedLat, deg);
        const key = bundleCellKey(cell.w, cell.s, deg);
        if (!nearFeat.has(key)) {
          nearAnchors.push({ lng: seedLng, lat: seedLat, key });
          nearFeat.set(key, []);
        }
        /* 🔴 **每轮都写**（不是只在新建时写）：相机**走回老格**时，那一个锚点就重新成为"当前锚点"
           —— 只有当前锚点还要全量重算（冷加载时那一格的数据可能还在陆续到位）。 */
        nearCurrentKey = key;
      }
      /* ② **所有锚点**交给规则模块（只增不删；顺序 = 首次出现序 ⇒ "按锚点顺序追加"这条可复现）。
            坏种子**不参与**（这一轮不新增锚点）—— 规则模块那边的"数不出来"只留给**直接调它**的人
            （旧 vendor/页面），本模块不替它编一个坏锚点出来（那会把已有锚点整条打成"数不出来"）。
            🔒 **老锚点标 `frozenOnly`**：相机已经不在它那一格里 ⇒ 它的贡献早就定稿，
               只并冻结集、不再花一次全池扫描重算它（**代价回到"与锚点数无关"**）。 */
      const anchorsOut = nearAnchors.map((a) => ({
        lng: a.lng,
        lat: a.lat,
        frozenOnly: a.key !== nearCurrentKey,
      }));
      const frozenOut = nearAnchors.map((a) => (nearFeat.get(a.key) || []) as unknown as T[]);
      const out = pickBuildingsByBudget<T>({
        features: input.features,
        bounds: input.bounds,
        screen: input.screen,
        budgetPx2: input.budgetPx2,
        budgetVerts: input.budgetVerts,
        /* 🔴 每格上限 K **原样透传**（`undefined` 也有意义：规则模块按默认严格档处理 —— 这里别"顺手补个默认值"，
           否则两处各写一份默认数，改一处漏一处） */
        maxDrawn: input.maxDrawn,
        /* 🧮 格边长同样**原样透传**（分格的那张网格 = 离线包自己的格 ⇒ 只有一份格数学）。
           ⚠️ 本模块**不判 0.01/0.05**、也不给 `cellDeg` 打默认值（默认值只在规则模块那一处）；
             上面播种用的是 `bldResolvedCellDeg`（**同一个解析口**，不是第二份默认值）。 */
        cellDeg: input.cellDeg,
        minInView: input.minInView,
        /* 📍 2026-10-04 第七条：传的是**锚点表 + 各锚点的冻结集**（不再是每轮现读的相机中心）；
           `nearK`（栋数）与"关掉"的语义仍归规则模块那一处说了算。 */
        nearAnchors: anchorsOut,
        nearFrozen: frozenOut,
        nearK: input.nearK,
      });
      /* ③ **按锚点把这一轮新入列的那批冻下来**（引用，不拷）。
             补齐件照口径"追加在结果尾部、按锚点顺序" ⇒ 用 `nearAddedPerAnchor` 就能逐段切开
             （这就是那个字段存在的理由：编排层要按锚点记账，而它只有规则模块知道）。 */
      const stats: BldPickBudgetStats = {
        ...out.stats,
        nearAnchorTotal: nearAnchors.length,
        nearFrozenBatches: 0,
      };
      const per = Array.isArray(out.stats.nearAddedPerAnchor) ? out.stats.nearAddedPerAnchor : [];
      const addedN = Math.max(0, Number(out.stats.nearAdded) || 0);
      if (addedN > 0 && out.features.length >= addedN) {
        const tail = out.features.slice(out.features.length - addedN);
        let off = 0;
        for (let i = 0; i < nearAnchors.length && off < tail.length; i++) {
          const cnt = Math.max(0, Number(per[i]) || 0);
          if (cnt <= 0) continue;
          const arr = nearFeat.get(nearAnchors[i]!.key)!;
          for (let j = 0; j < cnt && off < tail.length; j++, off++) {
            const f = tail[off]!;
            /* 同一栋只存一次（对象同一性）：冻结点是**引用**，重复 push 会让"欠账"越滚越长 */
            if (!arr.includes(f as unknown)) arr.push(f as unknown);
          }
        }
      }
      for (const a of nearAnchors) if ((nearFeat.get(a.key) || []).length > 0) stats.nearFrozenBatches += 1;
      return { features: out.features, stats };
    },

    frozenObject(): BldFrozenCellsObj {
      return frozen;
    },

    snapshot(): BldPickSnapshot {
      const keys = Object.keys(frozen);
      const cells: Array<{ key: string; n: number; ids: string[] }> = [];
      for (const k of keys) {
        const arr = frozen[k];
        cells.push({ key: k, n: arr.length, ids: arr.map((f) => String(f.id ?? "")) });
      }
      return { frozenTotal: keys.length, keys, cells };
    },

    clear(): void {
      for (const k of Object.keys(frozen)) delete frozen[k];
    },
  };
}
