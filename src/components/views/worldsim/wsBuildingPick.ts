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
    const pt = firstPoint(f);
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
      named: hasName(f) ? 1 : 0,
      area: bboxArea(f),
      key: String(f.id ?? ""),
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
