// 🧱 **累积式要素仓库**（机主 2026-09-25 原话：「过一会加载的楼房虽然加载，但是之前的没了，
//    必须保证视野内的楼房完整，道路完整」）。
//
// 问题形态：页面以前是"取一批 ⇒ `setData(这一批)`" ⇒ **整份替换**，
// 于是新数据一来旧的就没了（楼房）／视野一大就只有中心一小块（道路，因为源上限 600m）。
//
// ✅ 做法：把要素**累积**在一个仓库里，按**稳定 id 去重**，只在"超出保留半径"或"超过上限"时淘汰，
//    每次合并**批量**吐一份 FeatureCollection（调用方一次 setData）。
//
// 🔴 这一份是**纯逻辑**（不碰 DOM / 不碰 map）—— 页面与（将来的）App 共用同一份，
//    谁都不许再写第二套"合并/淘汰"（这个项目对"两份实现"付过很多次代价）。
//
// 三态判词（HUD 要读）：`stats()` 里的 `n`（要素数）永远是**数得出来的数**；
// 淘汰/去重的计数分开给（`dropped` / `dupes`），拿不到就 null，**绝不写 0 冒充"没有"**。

export type LngLat = [number, number];

/** 从要素里取一个**稳定 id**（取不到就返回 null —— 那种要素不参与去重，如实计数） */
export type FeatureIdOf<T> = (f: T) => string | null;
/** 取要素的**代表点**（用来算"离视野中心多远"⇒ 淘汰用）。取不到返回 null。 */
export type FeaturePointOf<T> = (f: T) => LngLat | null;

export interface StoreStats {
  /** 当前仓库里的要素数 */
  n: number;
  /** 参与去重的要素里，**没有 id** 的个数（这些无法去重，只能全留） */
  noId: number;
  /** 历史累计新增（不去重意义上的"进来过多少"） */
  added: number;
  /** 被 id 去重丢掉的重复要素数 */
  dupes: number;
  /** 被淘汰（太远 / 超上限）丢掉的要素数 */
  dropped: number;
  /** 合并次数 */
  merges: number;
  /** 用过的"来源键"（比如瓦片键 / 离线格键）—— 用来回答"哪些格子已经取过了" */
  sources: number;
  /** 最近一次合并耗时的**中位数**近似（毫秒；样本少于 1 次时为 null = 数不出来） */
  lastMergeMs: number | null;
  /** 硬上限 */
  cap: number;
  /** 🔴 **被淘汰连累而作废的"来源键"个数**（历史累计）—— 见 `retainNear` 的 `dirtySources` 说明。
   *  为什么必须可数：作废一个来源键 = 那一格**下次还会被取一遍**（这是"楼没了"的修复代价），
   *  代价多大要能看见，不能悄悄发生。 */
  sourcesDropped: number;
}

export interface MergeResult {
  added: number;
  dupes: number;
  noId: number;
  total: number;
  ms: number;
}

const R_EARTH_M = 6371000;
/** 两点距离（米；等距近似够用 —— 只拿来排序/淘汰，不做测绘） */
export function metersBetween(a: LngLat, b: LngLat): number {
  const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const ky = 110540;
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
}

export interface FeatureStore<T> {
  /** 合并一批要素（按 id 去重；同名 id 以**新的**为准） */
  merge(features: readonly T[], sourceKey?: string): MergeResult;
  /** 淘汰：先丢"离 center 超过 keepRadiusM"的，再（若仍超 cap）丢最远的，直到 ≤ cap。
   *  🔴 同时把"被淘汰波及的来源键"作废（`has()` 变 false）—— 见实现里的 `dirtySources`。 */
  retainNear(center: LngLat, keepRadiusM: number): { droppedFar: number; droppedOverCap: number; n: number; droppedSources: number };
  /** 当前并集（调用方拿它一次性 setData） */
  features(): T[];
  /** 是否**当前仓库里确实还有**某个来源键的要素（瓦片键 / 离线格键） */
  has(sourceKey: string): boolean;
  stats(): StoreStats;
  clear(): void;
}

/**
 * 建一个要素仓库。
 * @param cap            硬上限（超过就按"离视野中心距离"淘汰）—— 这是**帧率护栏**的一部分
 * @param idOf           稳定 id 提取器
 * @param pointOf        代表点提取器（淘汰用）
 */
export function createFeatureStore<T>(opts: {
  cap: number;
  idOf: FeatureIdOf<T>;
  pointOf: FeaturePointOf<T>;
}): FeatureStore<T> {
  const cap = Math.max(1, Math.floor(opts.cap));
  /** id → 要素（插入序）；没有 id 的放 noIdList（不去重） */
  const byId = new Map<string, T>();
  let noIdList: T[] = [];
  let added = 0, dupes = 0, dropped = 0, merges = 0, lastMergeMs: number | null = null;
  const sources = new Set<string>();
  let sourcesDropped = 0;
  /**
   * 🔴🔴 **要素 → 它的来源键**（2026-09-26 性能/完整性子代理实测出来的真 bug 的修法）。
   *
   * 病根（真浏览器实测，`~/chk/_perf_base2.json` 的 ⑤）：`retainNear` 只丢**要素**、**不动作 `sources`**
   * ⇒ 一格被淘汰后 `has(格键)` 仍为 true ⇒ 离线管道 `todo` 里那一格**永远跳过**
   * ⇒ **挪走再挪回来，那一片就再也没有数据**（实测：挪回原机位后 `considered 177`（还是远处那一格）、
   * `inView 0`、`floorShort 10`，且 bldbundle 请求数**一条都没增加**）。
   * 这就是机主说的「渲染不全」的一个**硬真因**（不是观感）。
   *
   * 修法：用 **WeakMap** 记住每个"进来过"的要素属于哪个来源键（不污染要素本身 ⇒ 不会被
   * `setData`/`JSON.stringify`/structuredClone 带出去，也不会阻止 GC）；淘汰时把**被丢掉的要素**
   * 对应的来源键作废 ⇒ 管道下一轮就会**重新取那一格**（`merge` 按 id 去重 ⇒ 重取安全，
   * 缺的那部分正好补回来）。
   * ⚠️ 只作废"有要素被丢"的来源键：没被波及的格子照旧不重取（那才是"来回挪不该反复取"的设计）。
   */
  const srcOf = new WeakMap<object, string>();

  function all(): T[] {
    return noIdList.length ? [...byId.values(), ...noIdList] : [...byId.values()];
  }

  return {
    merge(features, sourceKey) {
      const t0 = Date.now();
      let a = 0, d = 0, nid = 0;
      for (const f of features) {
        const id = opts.idOf(f);
        if (!id) {
          noIdList.push(f); nid++; a++;
          if (sourceKey && f && typeof f === "object") srcOf.set(f as unknown as object, sourceKey);
          continue;
        }
        if (byId.has(id)) { dupes++; d++; continue; }   // 已有 ⇒ 丢新的（同一要素重复取到，几何等价）
        byId.set(id, f);
        a++;
        /* 记下"它从哪一格来"（只有真进仓库的才记；被去重丢掉的不需要 —— 它的孪生兄弟已经记过） */
        if (sourceKey && f && typeof f === "object") srcOf.set(f as unknown as object, sourceKey);
      }
      added += a;
      merges++;
      if (sourceKey) sources.add(sourceKey);
      lastMergeMs = Date.now() - t0;
      return { added: a, dupes: d, noId: nid, total: byId.size + noIdList.length, ms: lastMergeMs };
    },

    retainNear(center, keepRadiusM) {
      /* ⚠️ 顺序要紧：**先**按"太远"淘汰（视野外一圈之外），**再**看是否还超上限。
         为什么保留"视野外一圈"：来回挪地图时不该反复重取（机主抱怨的正是"来回一趟就没了"）。 */
      const droppedSourcesBefore = sourcesDropped;
      let droppedFar = 0, droppedOverCap = 0;
      const keep: [number, T][] = [];
      const far: [number, T][] = [];
      for (const f of all()) {
        const pt = opts.pointOf(f);
        if (!pt) { keep.push([0, f]); continue; }       // 没有代表点 ⇒ 不参与距离淘汰（也别丢）
        const dist = metersBetween(pt, center);
        (dist <= keepRadiusM ? keep : far).push([dist, f]);
      }
      droppedFar = far.length;
      /* 还超上限 ⇒ 按距离**从远到近**丢，直到 ≤ cap（这就是帧率护栏的"上限"那一半） */
      let over: [number, T][] = [];
      if (keep.length > cap) {
        const sorted = [...keep].sort((x, y) => x[0] - y[0]);
        over = sorted.slice(cap);
        keep.length = 0;
        keep.push(...sorted.slice(0, cap));
        droppedOverCap = over.length;
      }
      /* 🔴 **淘汰之后，来源键只保留"确实还有要素活着"的那些**（没活着的作废）。
         ⚠️ 判据是"**这一格一个要素都不剩了**"，不是"丢了几个" —— 这条是踩过才改的：
         第一版写成"只要有要素被丢就作废"，结果**跨保留半径的格子每一轮都被作废**
         （真浏览器实测：同一格在 3.5s 内被取了 3 次、`feed.net:bldbundle` 1→3 次；因为
         半径外的部分本来就会被反复丢掉 ⇒ 作废 ⇒ 重取 ⇒ 再丢，绕圈）。
         现在的语义：被丢掉的格**只要还剩邻居在**，就仍算"取过"（不重取，也就不绕圈）；
         **整格被丢光**才作废 ⇒ 管道下一轮会重新取它（`merge` 按 id 去重 ⇒ 重取安全，
         缺的那部分正好补回来）。这一条正是"挪走再挪回，那一片空了"的修法。 */
      if (droppedFar + droppedOverCap > 0) {
        const alive = new Set<string>();
        for (const [, f] of keep) {
          if (f && typeof f === "object") { const k = srcOf.get(f as unknown as object); if (k) alive.add(k); }
        }
        for (const k of [...sources]) {
          if (alive.has(k)) continue;
          sources.delete(k);
          sourcesDropped += 1;
        }
      }
      /* 落盘：重建两个容器（保持"有 id 的进 map、没 id 的进 list"） */
      const keepSet = new Set(keep.map(([, f]) => f));
      const nextById = new Map<string, T>();
      const nextNoId: T[] = [];
      for (const [id, f] of byId) if (keepSet.has(f)) nextById.set(id, f);
      for (const f of noIdList) if (keepSet.has(f)) nextNoId.push(f);
      byId.clear();
      for (const [id, f] of nextById) byId.set(id, f);
      noIdList = nextNoId;
      dropped += droppedFar + droppedOverCap;
      /* `droppedSources` = **这一次**作废掉几个来源键（调用方/探针据此判"要不要重取"） */
      const droppedSourcesNow = droppedSourcesBefore === sourcesDropped ? 0 : sourcesDropped - droppedSourcesBefore;
      return { droppedFar, droppedOverCap, n: byId.size + noIdList.length, droppedSources: droppedSourcesNow };
    },

    features: all,
    has: (k) => sources.has(k),

    stats() {
      return {
        n: byId.size + noIdList.length,
        noId: noIdList.length,
        added, dupes, dropped, merges,
        sources: sources.size,
        sourcesDropped,
        lastMergeMs,
        cap,
      };
    },

    /* ⚠️ `clear()` 必须**连来源键一起清**：`has()` 的语义现在是"仓库里确实还有这一格的要素"
       （见 `retainNear` 的 `dirtySources`）—— 只清要素不清来源键，就会又变回"说已经取过、其实没有"。 */
    clear() { byId.clear(); noIdList = []; sources.clear(); },
  };
}

/* ── 🛣🏢 离线包：格子与"视野需要哪些格"（纯函数，页面/App 共用） ───────────────────── */

/** 离线**路**包的格边长（度）。0.05° ≈ 5.5km —— 手机上一次取几格也不至于太大。 */
export const ROADS_BUNDLE_CELL_DEG = 0.05;
/** 离线**楼房**包的格边长（度）。楼房比路密得多（实测 373 格 / 72 万栋），但沿用同一格边长：
 *  · 一套格子公式两边共用（少一处能写错的地方）； · 单格中位 **205 KB**、最大 **1.9 MB**（实测），
 *    一次取 1~6 格 ⇒ 手机能接受。真要再小，改这里 + 重跑导出脚本即可（口径同式）。 */
export const BLD_BUNDLE_CELL_DEG = 0.05;

/** 离线**片区名**包的格边长（度）。与路/楼**同款格子**（0.05° ≈ 5.5km）：一套公式三处用，
 *  且片区点很稀（实测主城 56 块共几百个点）⇒ 单格只有几 KB。 */
export const PLACES_BUNDLE_CELL_DEG = 0.05;

/** 一个要素落在哪一格（格心取整；与两个导出脚本同式） */
export function bundleCellOf(lng: number, lat: number, size: number): { w: number; s: number } {
  const w = Math.floor(lng / size) * size;
  const s = Math.floor(lat / size) * size;
  return { w: +w.toFixed(5), s: +s.toFixed(5) };
}

export function bundleCellKey(w: number, s: number, size: number): string {
  return `${w.toFixed(5)}_${s.toFixed(5)}_${size}`;
}

export function roadsBundleCellOf(lng: number, lat: number, size = ROADS_BUNDLE_CELL_DEG): { w: number; s: number } {
  return bundleCellOf(lng, lat, size);
}

export function roadsBundleCellKey(w: number, s: number, size = ROADS_BUNDLE_CELL_DEG): string {
  return bundleCellKey(w, s, size);
}

export function bldBundleCellOf(lng: number, lat: number, size = BLD_BUNDLE_CELL_DEG): { w: number; s: number } {
  return bundleCellOf(lng, lat, size);
}

/** 🏢 离线楼房包的格键（与 `world_map/export_bld_bundle.py` 同式） */
export function bldBundleCellKey(w: number, s: number, size = BLD_BUNDLE_CELL_DEG): string {
  return bundleCellKey(w, s, size);
}

/**
 * 视野需要哪些离线格：**按离视野中心的距离排序**（近的先取），最多 `maxCells` 格。
 * 返回 `{ cells, wanted, capped }` —— `capped` 为真时 HUD 要如实写"只取了最近的 N 格"。
 */
export function bundleCellsForView(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null,
  center: { lng: number; lat: number } | null,
  maxCells: number,
  size: number,
): { cells: Array<{ key: string; w: number; s: number }>; wanted: number; capped: boolean } | null {
  if (!bounds || !center) return null;
  const w0 = bounds.getWest(), e0 = bounds.getEast(), s0 = bounds.getSouth(), n0 = bounds.getNorth();
  if (![w0, e0, s0, n0, center.lng, center.lat].every((v) => Number.isFinite(v))) return null;
  const seen = new Set<string>();
  const out: Array<{ key: string; w: number; s: number; d: number }> = [];
  /* ⚠️ 用**整数格号**算行列数，不要用 `(ce-cw)/size` —— 浮点会给出 1.9999999/2.0000000002
     之类的值，`ceil` 一抖就多算一整行/一整列（自检里 9 格被算成 16 格就是这么来的）。 */
  const i0 = Math.floor(w0 / size), i1 = Math.floor(e0 / size);
  const j0 = Math.floor(s0 / size), j1 = Math.floor(n0 / size);
  const steps = i1 - i0 + 1, stepn = j1 - j0 + 1;
  if (steps * stepn > 4096) return null;               // 视野离谱地大 ⇒ 让调用方判"数不出来"
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < stepn; j++) {
      const w = +((i0 + i) * size).toFixed(5), s = +((j0 + j) * size).toFixed(5);
      const key = bundleCellKey(w, s, size);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, w, s, d: metersBetween([w + size / 2, s + size / 2], [center.lng, center.lat]) });
    }
  }
  out.sort((a, b) => a.d - b.d);
  const capped = out.length > maxCells;
  return { cells: out.slice(0, maxCells).map(({ key, w, s }) => ({ key, w, s })), wanted: out.length, capped };
}

/** 🛣 视野需要哪些**路**离线格（按离视野中心距离，近的先取） */
export function roadsBundleCellsForView(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null,
  center: { lng: number; lat: number } | null,
  maxCells = 6,
  size = ROADS_BUNDLE_CELL_DEG,
) {
  return bundleCellsForView(bounds, center, maxCells, size);
}

/** 🏘 视野需要哪些**片区名**离线格（同式；点很稀 ⇒ 一般一次 1~4 格就够） */
export function placesBundleCellsForView(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null,
  center: { lng: number; lat: number } | null,
  maxCells = 6,
  size = PLACES_BUNDLE_CELL_DEG,
) {
  return bundleCellsForView(bounds, center, maxCells, size);
}

/** 🏢 视野需要哪些**楼房**离线格（同式；楼房密 ⇒ 默认上限给大一点，仍是"近的先取"） */
export function bldBundleCellsForView(
  bounds: { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null,
  center: { lng: number; lat: number } | null,
  maxCells = 6,
  size = BLD_BUNDLE_CELL_DEG,
) {
  return bundleCellsForView(bounds, center, maxCells, size);
}
