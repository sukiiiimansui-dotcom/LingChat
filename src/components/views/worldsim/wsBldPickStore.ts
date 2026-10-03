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
  pickBuildingsByBudget,
  type BldBudgetStats,
  type BldBudgetBounds,
  type BldScreenCtx,
} from "./wsBldBudget";

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
   * 🔴 **栋数硬上限**（机主 2026-10-03："一开始直接固定可显示的楼房数据，严格限制"）。
   * 与 `budgetPx2`/`budgetVerts` 同一路透传：**算档位不在这里**（`bldMaxDrawnOf(mode)` 在
   * `wsBldBudget`、档位存储在 `wsBldMode`），本模块只把宿主算好的数原样交给规则模块。
   */
  maxDrawn?: number;
  minInView?: number;
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
    stats: BldBudgetStats;
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
      stats: BldBudgetStats;
    } {
      return pickBuildingsByBudget<T>({
        features: input.features,
        bounds: input.bounds,
        screen: input.screen,
        budgetPx2: input.budgetPx2,
        budgetVerts: input.budgetVerts,
        /* 栋数上限**原样透传**（`undefined` 也有意义：规则模块按默认严格档处理 —— 这里别"顺手补个默认值"，
           否则两处各写一份默认数，改一处漏一处） */
        maxDrawn: input.maxDrawn,
        minInView: input.minInView,
      });
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
