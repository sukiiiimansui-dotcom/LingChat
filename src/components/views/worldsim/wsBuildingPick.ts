/**
 * wsBuildingPick.ts —— **近景按视野挑楼**（机主 2026-09-25：「楼房过于密集…**上限 100 栋根据视野来显示**」）。
 *
 * ## 为什么要有它
 * 离线楼房包里一格就有几千栋真脚印（渝中那格 12,633 栋、仓库上限 12,000）——全画出来近景就是一片"楼房地毯"，
 * 既不美观也读不出结构。机主要的是**少而清楚**：一眼能看出"这一片是小区、那边是基础设施"。
 * 所以：**仓库照样收真数据**（事实不许编），只是**画**的时候按视野挑一批出来（画面可以编"画多少"，
 * 但不许编"是什么"——挑出来的每一个仍然是真脚印）。
 *
 * ## 规则（纯函数、确定性；`ws_building_pick_selftest.mjs` 钉着）
 * 1. **只在视野内挑**（`bounds`）；没有 bounds ⇒ 从全部里挑，并把 `inView` 记成 `null`（**数不出来 ≠ 0**）。
 * 2. **有名字的优先** —— 名字是真信息，也是"小区/基础设施"最直接的锚。
 * 3. 其次**底面大的优先**（`bbox` 面积）：大房子比车棚更该出现在稀疏画面里。
 * 4. **分桶轮转**（默认 8×8）：第 1 轮每桶取最好的一栋、第 2 轮每桶取第二好的……直到上限
 *    ⇒ 挑出来的**铺得开**，不会 100 栋全挤在一个角（这是"随视野"真正的意思）。
 * 5. 同分时按 `id` 排 —— **同一视野两次挑选结果逐字节相同**（不许抖）。
 */
export const WS_BLD_VIEW_CAP = 100;

export interface PickBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/** 只依赖这两个字段（GeoJSON Feature 的最小形状）⇒ 与具体要素类型解耦 */
export interface PickFeature {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

export interface PickViewInput {
  bounds: PickBounds | null;
  center?: { lng: number; lat: number } | null;
  /** 上限（默认 `WS_BLD_VIEW_CAP` = 100）；`<=0` 视为 0（一栋都不画，但仍如实报数） */
  cap?: number;
  /** 分桶数（默认 8 ⇒ 8×8）；越小越"就近扎堆"，越大越"均匀铺开" */
  buckets?: number;
}

export interface PickViewStats {
  /** 仓库里一共有多少（全部，含视野外） */
  considered: number;
  /** 视野内多少；**没有 bounds ⇒ null**（数不出来，不许写 0） */
  inView: number | null;
  /** 定位不到点的要素（没几何 / 坐标非法）⇒ **一律不画**，但如实计数（不许混进"视野内"） */
  noPoint: number;
  chosen: number;
  cap: number;
  buckets: number;
  /** 每个桶各挑了几栋（长度 = buckets²；没有 bounds ⇒ null） */
  byBucket: number[] | null;
  /** 人读口径（HUD 直接用；含"上限/分桶/视野内"三个数） */
  why: string;
}

/** 外环的经纬度包围盒面积（度²）——**只用来排序**，不是"建筑面积"（不算事实，只做挑选权重） */
function bboxArea(f: PickFeature): number {
  const g = f.geometry;
  if (!g || !g.coordinates) return 0;
  const rings: number[][][] =
    g.type === "Polygon"
      ? (g.coordinates as number[][][])
      : g.type === "MultiPolygon"
        ? ((g.coordinates as number[][][][]).flat() as number[][][])
        : [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const ring of rings) {
    for (const pt of ring || []) {
      const x = Number(pt?.[0]), y = Number(pt?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      n += 1;
    }
  }
  if (!n) return 0;
  return Math.max(0, (maxX - minX)) * Math.max(0, (maxY - minY));
}

function hasName(f: PickFeature): boolean {
  const p = f.properties || {};
  const nm = (p.name ?? p["name:zh"] ?? p.n ?? p.ref) as unknown;
  return typeof nm === "string" ? nm.trim().length > 0 : nm != null && String(nm).trim().length > 0;
}

/** 面（外环任一点）是否在视野里；取**外环首点**判桶与归属（够用且便宜、确定性好） */
function firstPoint(f: PickFeature): [number, number] | null {
  const g = f.geometry;
  if (!g || !g.coordinates) return null;
  const c = g.type === "Polygon"
    ? (g.coordinates as number[][][])[0]?.[0]
    : g.type === "MultiPolygon"
      ? ((g.coordinates as number[][][][])[0] || [])[0]?.[0]
      : undefined;
  const x = Number(c?.[0]), y = Number(c?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * 🔁 **要素的三个派生值（首点 / 包围盒面积 / 有没有名字）—— 按要素对象记忆一次**。
 *
 * 为什么（2026-09-26 性能子代理实测）：挑楼**每一轮 flush 都要重扫整仓**
 * （12,000~50,000 栋；`bld.pick` 实测中位 53ms、p90 300ms），而这三个值**只跟要素自身有关**
 * （首点要扫第一环、面积要扫全部外环顶点）。同一个要素对象在一次会话里会被扫几十遍。
 * 用 **WeakMap** 记：不给要素加属性（不会被 `setData`/序列化带出去）、不阻止回收、也不占生命周期。
 *
 * 🔴 **前提（改这里的人必须守住）**：**要素对象进了仓库就是只读的** ——
 * 几何在包解析/接口解析时建好，之后**任何代码都不许原地改它**。
 * （`dressBldBase` 是 `{...f, properties:{...}}` **造新对象**，不动原对象；这一点是这条缓存成立的基础。）
 * 语义不变：同输入 ⇒ 同输出（`ws_building_pick_selftest` 逐条钉着）。
 */
interface PickDerived {
  /** 外环首点（定位不到 ⇒ null） */
  pt: [number, number] | null;
  /** 外环包围盒面积（度²；**只用来排序**，不是建筑面积） */
  area: number;
  /** 有名字 ⇒ 1（排序第一关键字） */
  named: number;
  /** 稳定 id 的字符串形式（`String(f.id ?? "")`；排序第三关键字）—— 每次 `String()` 也是钱 */
  key: string;
  /** 格键（**跟着 `size` 变**，所以连 size 一起记） */
  ckSize: number;
  ck: string;
}
const DERIVED = new WeakMap<object, PickDerived>();
/**
 * 取（并在需要时算一次）要素的派生值。`size` = 分块边长（度）；`<=0` 表示"这次不需要格键"
 * （`pickBuildingsForView` 用桶、不用格）。
 */
function derivedOf(f: PickFeature, size: number): PickDerived {
  if (!f || typeof f !== "object") return { pt: null, area: 0, named: 0, key: "", ckSize: -1, ck: "" };
  let d = DERIVED.get(f as unknown as object);
  if (!d) {
    d = { pt: firstPoint(f), area: bboxArea(f), named: hasName(f) ? 1 : 0, key: String((f as PickFeature).id ?? ""), ckSize: -1, ck: "" };
    DERIVED.set(f as unknown as object, d);
  }
  /* 格键 = `w.toFixed(5)_s.toFixed(5)_size`：**每栋每轮都要拼一次**（30,000 栋就是 9 万次字符串操作）
     —— 实测这就是"记忆了三个派生值之后仍然没快多少"的原因，所以连它一起记忆。 */
  if (size > 0 && d.pt && d.ckSize !== size) {
    const w = Math.floor(d.pt[0] / size) * size;
    const s = Math.floor(d.pt[1] / size) * size;
    d.ck = `${w.toFixed(5)}_${s.toFixed(5)}_${size}`;
    d.ckSize = size;
  }
  return d;
}

/**
 * 按视野挑楼。**纯函数**：不改入参、不用随机、同输入同输出。
 */
export function pickBuildingsForView<T extends PickFeature>(
  feats: readonly T[],
  input: PickViewInput,
): { features: T[]; stats: PickViewStats } {
  const cap = Math.max(0, Math.floor(input.cap ?? WS_BLD_VIEW_CAP));
  const nb = Math.max(1, Math.min(32, Math.floor(input.buckets ?? 8)));
  const considered = feats.length;

  const b = input.bounds;
  const hasBounds = !!(b && [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].every((v) => Number.isFinite(v)));
  const west = hasBounds ? b!.getWest() : 0;
  const south = hasBounds ? b!.getSouth() : 0;
  const east = hasBounds ? b!.getEast() : 0;
  const north = hasBounds ? b!.getNorth() : 0;
  const spanX = east - west;
  const spanY = north - south;

  type Item = { f: T; bucket: number; named: number; area: number; key: string };
  const items: Item[] = [];
  let inView = 0;
  let noPoint = 0;
  for (const f of feats) {
    const dv = derivedOf(f, 0);                 // 0 = 这次不需要格键（桶式挑选不用格）
    const pt = dv.pt;
    let bucket = -1;
    if (hasBounds && !pt) {
      /* 🔴 定位不到点（没几何/坐标非法）⇒ **不画**。第一版把它当"在视野内 bucket 0"画了出来，
         自检第⑤组当场抓到（`["j1","ok1","j2","j3"]`）——判词三态：**证不了在视野内，就不许画也不许算作视野内**。 */
      noPoint += 1;
      continue;
    }
    if (hasBounds && pt) {
      const inside = pt[0] >= west && pt[0] <= east && pt[1] >= south && pt[1] <= north;
      if (!inside) continue;                       // 视野外：**不画**（但仍算在 considered 里）
      inView += 1;
      const bx = spanX > 0 ? Math.min(nb - 1, Math.max(0, Math.floor(((pt[0] - west) / spanX) * nb))) : 0;
      const by = spanY > 0 ? Math.min(nb - 1, Math.max(0, Math.floor(((pt[1] - south) / spanY) * nb))) : 0;
      bucket = by * nb + bx;
    } else {
      bucket = 0;                                  // 没有 bounds：全部当一个桶（如实标注 inView=null）
    }
    items.push({
      f,
      bucket,
      named: dv.named,
      area: dv.area,
      key: dv.key,                                // ← 记忆过的 id 字符串（不再每次 String()）
    });
  }

  /* 每个桶内部按（有名字 → 底面大 → id 稳定）排序 */
  const byBucket = new Map<number, Item[]>();
  for (const it of items) {
    const arr = byBucket.get(it.bucket);
    if (arr) arr.push(it);
    else byBucket.set(it.bucket, [it]);
  }
  for (const arr of byBucket.values()) {
    arr.sort((a, z) =>
      (z.named - a.named) || (z.area - a.area) || (a.key < z.key ? -1 : a.key > z.key ? 1 : 0));
  }

  /* 轮转：第 r 轮从每个桶取第 r 好的 —— 保证"铺得开" */
  const buckets = [...byBucket.keys()].sort((a, z) => a - z);
  const chosen: T[] = [];
  const perBucket: number[] = hasBounds ? new Array(nb * nb).fill(0) : [];
  for (let round = 0; chosen.length < cap; round++) {
    let tookAny = false;
    /* 每轮内部：**按"该桶本轮那栋"的分数从高到低**取（同分按桶序号，保持确定性）。
       为什么：cap 小于桶数时（例如 cap=1），若按桶序号取，永远是"最左下那个桶"赢 ——
       那不是"最重要的先来"。自检第③组"都没名字时底面大的优先"就是被这条抓到的。 */
    const order = buckets.slice().sort((b1, b2) => {
      const x = byBucket.get(b1)!, y = byBucket.get(b2)!;
      if (round >= x.length) return round >= y.length ? b1 - b2 : 1;
      if (round >= y.length) return -1;
      const a1 = x[round], a2 = y[round];
      return (a2.named - a1.named) || (a2.area - a1.area) || (b1 - b2);
    });
    for (const bk of order) {
      const arr = byBucket.get(bk)!;
      if (round >= arr.length) continue;
      if (chosen.length >= cap) break;
      chosen.push(arr[round].f);
      if (hasBounds && perBucket[bk] !== undefined) perBucket[bk] += 1;
      tookAny = true;
    }
    if (!tookAny) break;                           // 所有桶都取空了
  }

  const stats: PickViewStats = {
    considered,
    inView: hasBounds ? inView : null,
    noPoint,
    chosen: chosen.length,
    cap,
    buckets: nb,
    byBucket: hasBounds ? perBucket : null,
    why: `显示 ${chosen.length} / ${hasBounds ? "视野内 " + inView : "视野内 **数不出来**（没有 bounds）"} 栋`
      + `（仓库 ${considered} · 上限 ${cap} · ${nb}×${nb} 分桶轮转：有名字优先、底面大的优先`
      + (noPoint ? ` · **定位不到点 ${noPoint} 栋未画**` : "") + `）`,
  };
  return { features: chosen, stats };
}


/* ══ 🧱 **按区块封顶**（机主 2026-09-25 更正：「楼房别乱变不变的，我是说**小范围一个区块最高 100 栋**」）══
 * 上一版是"**整个视野**最多 100 栋、随视野重挑" —— 两个毛病：① 挪一下地图那批楼就换了一批（"乱变"）；
 * ② 视野大时稀、视野小时又扎堆。机主要的规则是：**空间切成固定区块，每块最多 100 栋**。
 * ⇒ 挑选只依赖**区块本身**（与视野/中心无关）⇒ 同一块永远是那 100 栋，**拖动不乱变**。
 * 区块用**固定经纬格**（默认 0.02° ≈ 2.2km，与离线包同一套 `floor(lng/size)*size` 数学）。
 */
/* ── 🧍 **视野下限**（机主 2026-09-26 真机原话：「**还要保证视野内最少有十栋房**」，
 *    同一句里重申「每个区块最多 100 个固定」）—— 两条**同时**要，缺一条都不算做到：
 *    ① 每块 ≤cap、**同一块永远同一批**（= `base`，只依赖区块的**冻结集**）；
 *    ② **当前视野内至少 `minInView` 栋**（够不着时按同一套规则**补**）。
 *
 * 做法（顺序不能反）：**先算 base（老规则，一字节不改）** → 再数 base 里落在 `bounds` 内的有几栋 →
 *   · ≥ `minInView` ⇒ **原样返回**（一个字节都不多）；
 *   · < `minInView` ⇒ 从「**落在此视野内、且尚未入选**」的那批里，按**同一套排序规则**
 *     （块序 = 格子键升序；块内 = 有名字 → 底面大 → id 定序）补到够；候选取尽就补到取尽，**如实报 `floorShort`**。
 *
 * 🔴 **补进来的这批绝不进 base 的冻结集**（冻结只冻结 base）——否则"同一块永远同一批"会被视野污染：
 *    挪一下地图，那 100 栋就换了一批 = 又回到机主否掉的"乱变"。
 * 🔴 因此补楼**可能让某块这一刻超过 cap**（补的正是该块"落选"的那批）：`cap` 管的是**冻结集**，
 *    补充件随视野走 —— 这是两条口径冲突时的取舍（"视野内至少 10 栋"优先），HUD 用 `baseChosen` 与
 *    `floorAdded` **分开报**，别把两者加起来说成"每块 100"。
 * 🔴 没给 `bounds` ⇒ `inView` / `floorShort` 报 **null（数不出来）**，绝不写 0（判词三态）。
 */
export interface CapCellInput {
  /** 区块边长（度）；默认 0.02 ≈ 2.2km（"小范围一个区块"） */
  cellDeg?: number;
  /** 每块上限；默认 `WS_BLD_CELL_CAP` = 100 */
  cap?: number;
  /** 当前视野（`{getWest(), getSouth(), getEast(), getNorth()}` 或 null）。
   *  **不给 ⇒ 不知道视野内有几栋**（`inView` 报 null，不是 0）；给个坏对象（缺方法/NaN）同样按"没给"处理，不抛。 */
  bounds?: PickBounds | null;
  /** 视野内**至少**几栋；默认 **0 = 不启用下限**（⇒ 老调用点行为逐字节不变）。
   *  `<=0` / NaN / 不给 ⇒ 0。⚠️ `cap=0` 时按字面语义仍会补（base 空 ⇒ 从视野内的落选件补够）——
   *  要"一栋都不画"的开关请同时传 `minInView: 0`（页面现有 `BLDN > 0` 闸门已天然满足）。 */
  minInView?: number;
}
export interface CapCellStats {
  considered: number;
  cells: number;
  cap: number;
  cellDeg: number;
  /** 每块实际画了几栋（按格子键排序）——**只数 `base` 冻结集**；补的那几栋见 `floorAdded` */
  byCell: Array<{ cell: string; drawn: number; dropped: number }>;
  /** 实际返回的栋数 = `baseChosen + floorAdded`（老口径"画了几栋"） */
  chosen: number;
  /** `base`（每块 ≤cap 的**冻结集**）的栋数 = `chosen − floorAdded`；**补的那几栋不算在内** */
  baseChosen: number;
  dropped: number;
  /** 定位不到的（没几何/坐标坏）——**不画且如实计数** */
  noPoint: number;
  /** `base` 里**落在视野内**的栋数；没给 `bounds` ⇒ **null（数不出来，不写 0）** */
  inView: number | null;
  /** 本次生效的视野下限（= `input.minInView`，默认 0） */
  minInView: number;
  /** 为凑够下限**补进来**的栋数（**不进 base 冻结集**，随视野变） */
  floorAdded: number;
  /** 补到"视野内候选取尽"仍差几栋；**0 = 够**；没给 `bounds` ⇒ **null（没量过，不敢说"够"）** */
  floorShort: number | null;
  why: string;
}

export const WS_BLD_CELL_CAP = 100;
export const WS_BLD_CELL_DEG = 0.02;

/** 每块最多 `cap` 栋；**只依赖区块 ⇒ 稳定**（拖动不重挑、同一块永远同一批）。
 *  可选（`bounds` + `minInView`）再保证「**当前视野内至少 `minInView` 栋**」——
 *  补的来自"视野内、未入选"的那批，**不进冻结集**（细则见上方注释块）。 */
export function capBuildingsPerCell<T extends PickFeature>(
  feats: readonly T[],
  input: CapCellInput = {},
): { features: T[]; stats: CapCellStats } {
  const size = Number.isFinite(input.cellDeg as number) && (input.cellDeg as number) > 0 ? (input.cellDeg as number) : WS_BLD_CELL_DEG;
  const cap = Math.max(0, Math.floor(input.cap ?? WS_BLD_CELL_CAP));
  const rawMin = Number(input.minInView ?? 0);
  const minInView = Number.isFinite(rawMin) ? Math.max(0, Math.floor(rawMin)) : 0;
  const b = input.bounds ?? null;
  /* 坏 bounds（缺方法 / NaN）一律当"没给" ⇒ 如实报"数不出来"，绝不拿半个视野去补楼 */
  const hasBounds = !!(b
    && typeof b.getWest === "function" && typeof b.getSouth === "function"
    && typeof b.getEast === "function" && typeof b.getNorth === "function"
    && [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].every((v) => Number.isFinite(v)));

  type CellItem = { f: T; named: number; area: number; key: string; pt: [number, number] };
  const byCell = new Map<string, CellItem[]>();
  let noPoint = 0;
  for (const f of feats) {
    /* 🔁 三个派生值走记忆（见 `derivedOf`）—— 挑楼每轮 flush 都重扫整仓，这里省的是大头 */
    const dv = derivedOf(f, size);
    const pt = dv.pt;
    if (!pt) { noPoint++; continue; }                    // 定位不到 ⇒ 不画（也不许算进任何区块）
    const cell = dv.ck;                                  // ← 记忆过的格键（不再每栋每次 toFixed+拼接）
    const it: CellItem = { f, named: dv.named, area: dv.area, key: dv.key, pt };
    const arr = byCell.get(cell);
    if (arr) arr.push(it); else byCell.set(cell, [it]);
  }
  const base: CellItem[] = [];
  /** 每块**落选**的那批（已按块内同一套顺序排好）—— 补楼**只从这里取**（= "尚未入选"）。
   *  ⚠️ 只有真要补（给了 bounds 且下限 > 0）才建：**不传新参数的老调用点连一次多余分配都没有**。 */
  const wantFloor = hasBounds && minInView > 0;
  const leftovers: CellItem[][] = [];
  const rows: Array<{ cell: string; drawn: number; dropped: number }> = [];
  let dropped = 0;
  for (const cell of [...byCell.keys()].sort()) {
    const arr = byCell.get(cell)!;
    /* 块内排序：**有名字优先 → 底面大优先 → id 定序**（同分同序 ⇒ 两次挑选逐字节相同） */
    arr.sort((a, z) => (z.named - a.named) || (z.area - a.area) || (a.key < z.key ? -1 : a.key > z.key ? 1 : 0));
    const take = arr.slice(0, cap);
    for (const x of take) base.push(x);
    if (wantFloor) leftovers.push(arr.slice(cap));
    rows.push({ cell, drawn: take.length, dropped: arr.length - take.length });
    dropped += arr.length - take.length;
  }

  /* ── 视野下限：先数 base 里在视野内的，再决定要不要补（**不补时原样返回 base**） ── */
  let inView: number | null = null;
  let floorAdded = 0;
  let floorShort: number | null = null;
  const added: T[] = [];
  if (hasBounds) {
    const west = b!.getWest(), south = b!.getSouth(), east = b!.getEast(), north = b!.getNorth();
    /* 判"在视野内"的口径与 `pickBuildingsForView` **一致**（闭区间，取 `firstPoint` 那个外环首点） */
    const inside = (pt: [number, number]): boolean =>
      pt[0] >= west && pt[0] <= east && pt[1] >= south && pt[1] <= north;
    inView = 0;
    for (const x of base) if (inside(x.pt)) inView += 1;
    let need = Math.max(0, minInView - inView);
    if (wantFloor) {
      for (const arr of leftovers) {                     // 块序与 base 相同（格子键升序）
        if (need <= 0) break;
        for (const x of arr) {                           // 块内也是"同一套排序规则"
          if (!inside(x.pt)) continue;                   // **只补落在此视野内的**
          added.push(x.f);
          floorAdded += 1;
          need -= 1;
          if (need <= 0) break;
        }
      }
    }
    floorShort = need;                                   // 取尽仍差几栋（0 = 够）
  }

  const baseFeats = base.map((x) => x.f);
  /* 🔴 没补 ⇒ **原样返回 base**（一个字节都不多）；补了 ⇒ base 在前、补的在后（页面按 `baseChosen` 切） */
  const out = floorAdded > 0 ? baseFeats.concat(added) : baseFeats;
  /* 判词三态：给了 bounds 才敢报"视野内 N / 补 +X / 仍差 Y"；没给就写"数不出来"（不写 0） */
  const viewSeg = hasBounds
    ? ` · 视野内 ${inView}（下限 ${minInView} · 补 +${floorAdded} / 仍差 ${floorShort}）`
    : (minInView > 0 ? ` · 视野内 **数不出来**（没给 bounds ⇒ 补不了，一栋没补）` : "");
  return {
    features: out,
    stats: {
      considered: feats.length, cells: byCell.size, cap, cellDeg: size,
      byCell: rows, chosen: out.length, baseChosen: baseFeats.length, dropped, noPoint,
      inView, minInView, floorAdded, floorShort,
      why: `每块 ≤${cap} 栋 · ${byCell.size} 块 / 画 ${out.length} 栋`
        + (floorAdded > 0 ? `（冻结 ${baseFeats.length} + 视野补 ${floorAdded}）` : "")
        + `（输入 ${feats.length} · 块内超出 ${dropped}`
        + (noPoint ? ` · 定位不到 ${noPoint}` : "") + `）· 区块 ${size}° ≈ ${(size * 111).toFixed(1)}km`
        + viewSeg,
    },
  };
}
