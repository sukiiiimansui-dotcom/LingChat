/**
 * wsSnap.ts —— 「把行人放到路上/设施旁」的**纯几何逻辑**（不碰地图库、不碰 DOM，可单测）。
 *
 * ## 为什么需要它（机主 2026-09-20）
 * 「**在地图上把道路和设施全部勾出来**（方便将行人啥的挪出来）」。
 * 背景是 `DESIGN-AUTONOMY.md`：10 分钟没人说话，角色就自己出门溜达 —— 那要求
 * ① 知道**路在哪**（不能穿墙、不能走到江里）、② 知道**能去哪**（设施点）。
 *
 * ## 🔴 一条最容易写错、也最容易被忽略的规矩
 * `snapToRoad` 必须返回"**最近道路段上的投影点**"，**不是最近的顶点**。
 * 为什么：路是折线，相邻顶点间可能有几十米；吸附到顶点会让角色在移动时
 * **一格一格地跳**（两个顶点之间来回切），看起来像卡顿/瞬移。
 * 投影到线段上，角色才会沿着路**平滑地滑**。
 *
 * ## 坐标系约定
 * · 输入输出都是 `[lng, lat]`（GeoJSON 口径）；
 * · 内部换算到**以参考纬度为中心的局部平面**（米），算完再换回来。
 *   这不是"投影"（没有椭球），但在小区级（几百米~2km）误差远小于一个楼宽，
 *   而它换来的是**不引任何几何库**。纬度 1°≈110540m、经度 1°≈111320·cos(lat)m。
 */

/** `[lng, lat]` */
export type LngLat = [number, number];

/** 一段路（两个端点 + 档次 + 名字）。折线会被拆成一串这样的段。 */
export interface RoadSeg {
  a: LngLat;
  b: LngLat;
  rank: number;
  name?: string | null;
  bridge?: boolean;
  tunnel?: boolean;
}

/** 一个设施点 */
export interface FacilityPt {
  id: string;
  name: string;
  /** 设施类别（`/api/facilities` 的 kind/type） */
  kind: string;
  pos: LngLat;
}

export interface SnapRoad {
  /** 吸附后的落点（**线段上的投影点**，不是顶点） */
  point: LngLat;
  /** 到路的距离（米） */
  distM: number;
  seg: RoadSeg;
}

export interface SnapFacility {
  point: LngLat;
  distM: number;
  item: FacilityPt;
}

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

/** 经度 1° 在这个纬度上等于多少米 */
export function metersPerDegLng(lat: number): number {
  return M_PER_DEG_LNG_EQ * Math.cos((lat * Math.PI) / 180);
}

/** 局部平面（米）。`lat0` 取"这批数据的中位纬度"即可，误差可以忽略。 */
export function toXY(p: LngLat, lat0: number): [number, number] {
  return [p[0] * metersPerDegLng(lat0), p[1] * M_PER_DEG_LAT];
}

export function toLngLat(xy: [number, number], lat0: number): LngLat {
  const k = metersPerDegLng(lat0);
  return [k === 0 ? 0 : xy[0] / k, xy[1] / M_PER_DEG_LAT];
}

/** 两点距离（米）——等距圆柱近似 */
export function distM(a: LngLat, b: LngLat): number {
  const lat0 = (a[1] + b[1]) / 2;
  const kx = metersPerDegLng(lat0);
  const dx = (a[0] - b[0]) * kx;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** GeoJSON 的 FeatureCollection（道路）→ 段列表。**只吃 LineString**，别的类型跳过（不猜）。 */
export function roadSegments(
  fc: { features?: Array<{ properties?: Record<string, unknown>; geometry?: unknown }> } | null | undefined
): RoadSeg[] {
  const out: RoadSeg[] = [];
  for (const f of fc?.features || []) {
    const g = (f.geometry || {}) as { type?: string; coordinates?: unknown };
    if (g.type !== "LineString" || !Array.isArray(g.coordinates)) continue;
    const pts = g.coordinates as unknown as LngLat[];
    const props = f.properties || {};
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
      out.push({
        a: [Number(a[0]), Number(a[1])],
        b: [Number(b[0]), Number(b[1])],
        rank: Number(props.rank),
        name: (props.name as string | null) ?? null,
        bridge: !!props.bridge,
        tunnel: !!props.tunnel,
      });
    }
  }
  return out;
}

/**
 * 点 → 线段的**投影**（参数 t 夹在 [0,1]）。
 *
 * 退化线段（两端点重合）必须**显式处理**：`len2 === 0` 时 t 只能是 0，
 * 否则会除零得到 `NaN`，而 `NaN` 会一路传染到坐标上 —— 角色直接消失，
 * 而且**不报错**（本项目已经吃过好几次这种"静默 NaN"的亏）。
 */
export function projectOnSegment(p: LngLat, a: LngLat, b: LngLat, lat0: number): { point: LngLat; t: number; distM: number } {
  const [px, py] = toXY(p, lat0);
  const [ax, ay] = toXY(a, lat0);
  const [bx, by] = toXY(b, lat0);
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  const x = ax + t * vx;
  const y = ay + t * vy;
  return { point: toLngLat([x, y], lat0), t, distM: Math.hypot(px - x, py - y) };
}

/**
 * 最近的**路**（返回路上的投影点）。
 *
 * `maxM` 给了就是"够不着就算了"（返回 null）——**这一点很重要**：
 * 角色在江心/山里时，"最近的路"可能在两公里外，硬吸过去就是**瞬移**。
 * 宁可返回 null 让调用方决定（留在原地 / 慢慢走过去），也不要悄悄传送。
 */
export function snapToRoad(p: LngLat, segs: readonly RoadSeg[], maxM = Infinity): SnapRoad | null {
  if (!segs.length) return null; // 空路网：如实返回 null，**不编一个点出来**
  const lat0 = p[1];
  let best: SnapRoad | null = null;
  for (const s of segs) {
    const r = projectOnSegment(p, s.a, s.b, lat0);
    if (r.distM <= maxM && (!best || r.distM < best.distM)) best = { point: r.point, distM: r.distM, seg: s };
  }
  return best;
}

/** 最近的**设施**（点是零维的，所以直接找最近的一个，没有"投影"问题） */
export function snapToFacility(
  p: LngLat,
  items: readonly FacilityPt[],
  maxM = Infinity
): SnapFacility | null {
  let best: SnapFacility | null = null;
  for (const it of items) {
    const d = distM(p, it.pos);
    if (d <= maxM && (!best || d < best.distM)) best = { point: it.pos, distM: d, item: it };
  }
  return best;
}

/* ── 寻路 ────────────────────────────────────────────────────────────────
 * `routeOnRoads` 是"角色自己出门"的地基：给定两点，沿**真实路网**给一条路径。
 *
 * 刻意做**最简版**（不引库、不做 A*、不做分层）：
 *   · 图小（一个小区级视野几百条段、几千个节点），Dijkstra 足够；
 *   · 先要"**正确**"（不穿江、不穿楼），再谈快 —— 手机上算 1 万次松弛是毫秒级的事。
 * ─────────────────────────────────────────────────────────────────────── */

/** 档次 → 通行代价系数（走主干道比钻小巷快；高架桥也比地面快一点点） */
export const RANK_COST: Record<number, number> = { 0: 0.7, 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.15, 5: 1.35 };

export interface RouteResult {
  /** 折线（含起终点的吸附点），可以直接喂给地图 */
  points: LngLat[];
  /** 总长度（米，**按实际路网**，不是直线距离） */
  meters: number;
  /** 走到路上花的直线距离（起点/终点各自的"最后一截"） */
  approachM: number;
}

/** 节点合并容差（米）：真实路网里同一路口会有一堆几乎重合的顶点 */
export const NODE_MERGE_M = 6;

/** 节点表：把经纬度量化到 `NODE_MERGE_M` 的格子里（比两两比对快，也够准） */
function nodeKey(p: LngLat): string {
  const kx = metersPerDegLng(p[1]);
  const gx = Math.round((p[0] * kx) / NODE_MERGE_M);
  const gy = Math.round((p[1] * M_PER_DEG_LAT) / NODE_MERGE_M);
  return `${gx},${gy}`;
}

interface Graph {
  nodes: LngLat[];
  /** 邻接表：node → [邻居 node, 代价米] */
  adj: Array<Array<[number, number]>>;
}

export function buildGraph(segs: readonly RoadSeg[]): Graph {
  const index = new Map<string, number>();
  const nodes: LngLat[] = [];
  const adj: Array<Array<[number, number]>> = [];
  const idOf = (p: LngLat): number => {
    const k = nodeKey(p);
    const hit = index.get(k);
    if (hit !== undefined) return hit;
    const id = nodes.length;
    index.set(k, id);
    nodes.push(p);
    adj.push([]);
    return id;
  };
  for (const s of segs) {
    const ia = idOf(s.a);
    const ib = idOf(s.b);
    if (ia === ib) continue; // 退化线段（合并后同点）不产生边
    const w = distM(nodes[ia]!, nodes[ib]!) * (RANK_COST[s.rank] ?? 1);
    adj[ia]!.push([ib, w]);
    adj[ib]!.push([ia, w]);
  }
  return { nodes, adj };
}

/** 最近的**图节点**（寻路的起终点要先落到路网节点上） */
function nearestNode(g: Graph, p: LngLat): { id: number; distM: number } | null {
  let best: { id: number; distM: number } | null = null;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = distM(p, g.nodes[i]!);
    if (!best || d < best.distM) best = { id: i, distM: d };
  }
  return best;
}

/**
 * 沿路网求最短路（Dijkstra，无库）。
 *
 * 返回 `null` 的三种情况**都必须如实区分**（调用方据此决定"别动/原地等/走路"）：
 *   · 路网为空 ⇒ 没路可走；
 *   · 找不到起点或终点节点 ⇒ 坐标不在这片路网附近；
 *   · **图不连通**（最典型的：两点隔江，中间没有桥）⇒ 无解，**绝不能直线过去**
 *     （直线过去就是"角色从江面上飘过"，是这个功能最容易出的洋相）。
 */
export function routeOnRoads(
  from: LngLat,
  to: LngLat,
  segs: readonly RoadSeg[],
  opts: { maxApproachM?: number; graph?: Graph } = {}
): RouteResult | null {
  if (!segs.length) return null;
  const maxApproach = opts.maxApproachM ?? 400;
  const g = opts.graph ?? buildGraph(segs);
  if (!g.nodes.length) return null;

  const s = nearestNode(g, from);
  const t = nearestNode(g, to);
  if (!s || !t) return null;
  if (s.distM > maxApproach || t.distM > maxApproach) return null; // 够不着路网：不硬接
  if (s.id === t.id) {
    /* 同一个节点：两点在同一个路口附近 ⇒ 直接给"吸附点 → 吸附点"的一小段 */
    return { points: [from, to], meters: distM(from, to), approachM: s.distM + t.distM };
  }

  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[s.id] = 0;
  /* 朴素 Dijkstra（O(V²)）：小区级视野 V 通常只有几百~几千，够用且**没有依赖**。
     真到几万节点再换二叉堆 —— 现在就换属于"还没病先吃药"。 */
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u < 0) break; // 剩下的都不可达
    if (u === t.id) break;
    done[u] = 1;
    for (const [v, w] of g.adj[u]!) {
      const nd = dist[u]! + w;
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }
  if (!Number.isFinite(dist[t.id]!)) return null; // 不连通（跨江无桥就是这样）

  const path: LngLat[] = [];
  for (let v = t.id; v >= 0; v = prev[v]!) path.push(g.nodes[v]!);
  path.reverse();
  return {
    points: [from, ...path, to],
    meters: dist[t.id]!,
    approachM: s.distM + t.distM,
  };
}
