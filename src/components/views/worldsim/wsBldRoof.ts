/* wsBldRoof.ts —— **程序化坡屋顶**（双坡/四坡/金字塔），纯几何、不 import three/DOM。
 *
 * 只在**低层住宅类**上做（`h≤15`、`lv≤3`、4~8 角点、短边≥3m）；`k=yes`/未知**不猜**。
 * 双坡/四坡只给 4 角点；屋脊沿**脚印长边**，`ridgeAngleDeg` 是判据（≤5° 才采用）。
 * 5~8 角点用金字塔（顶点在质心），避免给不规则脚印硬套双坡。
 *
 * 顶点增量（相对平顶，n=唯一角点数）：
 *   双坡/四坡：+18−(3n−6)=24−3n（n=4 +12、n=5 +9、n=6 +6、n=8 0）
 *   金字塔：+3n−(3n−6)=+6
 *
 * 判据（S4）：
 *   · 非住宅 `k` 生成 0 个屋顶；变异 `force:"all"` ⇒ 非住宅也有屋顶 ⇒ 红；
 *   · 双坡屋脊与长边夹角 ≤5°；
 *   · 总屋顶顶点 ≤ `ROOF_VERTS_MAX`（超预算按 h/面积/id 降级并计数）。
 */

export type Pt2 = [number, number];
export type Pt3 = [number, number, number];

export interface RoofPlan {
  type: "gable" | "hip" | "pyramid";
  /** 屋檐高（墙顶） */
  eave: number;
  /** 屋脊/顶点高（= 数据楼高） */
  peak: number;
  /** 每个三角 3 个局部 xyz */
  faces: Array<[Pt3, Pt3, Pt3]>;
  /** 顶点数（= faces.length × 3） */
  verts: number;
  /** 屋脊两端（双坡/四坡；局部米，y 不在这里） */
  ridge?: [Pt2, Pt2];
  /** 屋脊方向与长边夹角（度；双坡/四坡才有） */
  ridgeAngleDeg: number;
  /** 长边两端（双坡/四坡才有） */
  longEdge?: [Pt2, Pt2];
  minSide: number;
  area: number;
}

/** 允许做坡屋顶的类型（低层住宅/宗教小建筑）。`yes`/未知**不在**表里。 */
export const ROOF_KINDS: ReadonlySet<string> = new Set([
  "house", "detached", "semidetached_house", "terrace", "bungalow", "hut",
  "church", "temple", "mosque",
]);

/** 总屋顶顶点预算（只算屋顶三角；体块/女儿墙走另一本账） */
export const ROOF_VERTS_MAX = 24_000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const sub = (a: Pt2, b: Pt2): Pt2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt2): number => Math.hypot(v[0], v[1]);
const mid = (a: Pt2, b: Pt2): Pt2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const add = (a: Pt2, b: Pt2): Pt2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt2, k: number): Pt2 => [a[0] * k, a[1] * k];
const unit = (v: Pt2): Pt2 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l];
};
const dot = (a: Pt2, b: Pt2): number => a[0] * b[0] + a[1] * b[1];

function shoelace(pts: readonly Pt2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

function minEdge(pts: readonly Pt2[]): number {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const l = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (l < m) m = l;
  }
  return Number.isFinite(m) ? m : 0;
}

function uniq(pts: readonly Pt2[]): Pt2[] {
  const out: Pt2[] = [];
  for (const p of pts) {
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  if (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

/** 屋顶三角统一朝上（x/z 平面叉积 ≥0）；否则交换后两点 */
function tri(a: Pt3, b: Pt3, c: Pt3): [Pt3, Pt3, Pt3] {
  const up = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
  return up >= 0 ? [a, b, c] : [a, c, b];
}

/** 类型是否属于“可做坡屋顶”的低层（不含 h/lv 之外的条件） */
export function roofKindEligible(props: Record<string, unknown>, h: number): boolean {
  const k = String(props.k ?? props.kind ?? "yes").toLowerCase();
  if (!ROOF_KINDS.has(k)) return false;
  if (!(h > 0 && h <= 15)) return false;
  const lvRaw = Number(props.lv);
  const lv = Number.isFinite(lvRaw) && lvRaw > 0 ? lvRaw : Math.round(h / 3);
  return lv <= 3;
}

/**
 * 生成屋顶方案。`pts` 是**局部米**的脚印（外环，未闭合也可）。
 * `force`：auto（默认）/ all（变异：未知类型也做）/ off（影子/对照）。
 */
export function roofPlanOf(
  props: Record<string, unknown>,
  pts: readonly Pt2[],
  top: number,
  base: number,
  opts: { force?: "auto" | "all" | "off" } = {}
): RoofPlan | null {
  const force = opts.force ?? "auto";
  if (force === "off") return null;
  if (!(top > 0 && top <= 15)) return null;
  const lvRaw = Number(props.lv);
  const lv = Number.isFinite(lvRaw) && lvRaw > 0 ? lvRaw : Math.round(top / 3);
  if (lv > 3) return null;
  const k = String(props.k ?? props.kind ?? "yes").toLowerCase();
  if (force !== "all" && !ROOF_KINDS.has(k)) return null;

  const ring = uniq(pts);
  const n = ring.length;
  if (n < 4 || n > 8) return null;
  const minSide = minEdge(ring);
  if (!(minSide >= 3)) return null;
  const area = shoelace(ring);
  if (!(area >= 9)) return null;

  const roofH = Math.max(1.2, Math.min(3.6, minSide * 0.28));
  const eave = top - roofH;
  if (!(eave - base >= 0.4)) return null;

  /* 5~8 角点：金字塔（顶点在质心） */
  if (n > 4) {
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p[0];
      cy += p[1];
    }
    cx /= n;
    cy /= n;
    const apex: Pt3 = [cx, top, cy];
    const faces: Array<[Pt3, Pt3, Pt3]> = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      faces.push(tri([a[0], eave, a[1]], [b[0], eave, b[1]], apex));
    }
    return { type: "pyramid", eave, peak: top, faces, verts: faces.length * 3, ridgeAngleDeg: 0, minSide, area };
  }

  /* 4 角点：找最长边，屋脊沿它 */
  let li = 0;
  let ll = -1;
  for (let i = 0; i < 4; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % 4]!;
    const l = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (l > ll) {
      ll = l;
      li = i;
    }
  }
  const A = ring[li]!;
  const B = ring[(li + 1) % 4]!;
  const C = ring[(li + 2) % 4]!;
  const D = ring[(li + 3) % 4]!;
  const longEdge: [Pt2, Pt2] = [A, B];
  const midBC = mid(B, C);
  const midDA = mid(D, A);
  const ridgeVec = sub(midDA, midBC);
  const ridgeLen = len(ridgeVec);
  const longLen = ll;
  const wide = (Math.hypot(B[0] - C[0], B[1] - C[1]) + Math.hypot(D[0] - A[0], D[1] - A[1])) / 2;
  if (!(ridgeLen > 0.1) || !(wide > 0.1)) return null;
  /* 屋脊方向与长边夹角（度）——超过 5° 就不硬套双坡/四坡 */
  const u = unit(sub(B, A));
  const cosang = Math.max(-1, Math.min(1, Math.abs(dot(unit(ridgeVec), u))));
  const ridgeAngleDeg = (Math.acos(cosang) * 180) / Math.PI;
  if (ridgeAngleDeg > 5) return null;

  const aspect = longLen / wide;
  const faces: Array<[Pt3, Pt3, Pt3]> = [];
  const eavePt = (p: Pt2): Pt3 => [p[0], eave, p[1]];
  const peakPt = (p: Pt2): Pt3 => [p[0], top, p[1]];

  if (aspect >= 1.4 && longLen - wide >= 0.5) {
    /* 双坡：脊线 = 两条短边中点 */
    const R1 = midBC;
    const R2 = midDA;
    faces.push(tri(eavePt(A), eavePt(B), peakPt(R1)));
    faces.push(tri(eavePt(A), peakPt(R1), peakPt(R2)));
    faces.push(tri(eavePt(C), eavePt(D), peakPt(R2)));
    faces.push(tri(eavePt(C), peakPt(R2), peakPt(R1)));
    faces.push(tri(eavePt(B), eavePt(C), peakPt(R1)));
    faces.push(tri(eavePt(D), eavePt(A), peakPt(R2)));
    return { type: "gable", eave, peak: top, faces, verts: faces.length * 3, ridge: [R1, R2], ridgeAngleDeg, longEdge, minSide, area };
  }

  /* 四坡：脊线两端各向内收半个宽；太短就退金字塔 */
  const inset = wide / 2;
  if (longLen - 2 * inset < 0.3) {
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p[0];
      cy += p[1];
    }
    cx /= 4;
    cy /= 4;
    const apex: Pt3 = [cx, top, cy];
    for (let i = 0; i < 4; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % 4]!;
      faces.push(tri([a[0], eave, a[1]], [b[0], eave, b[1]], apex));
    }
    return { type: "pyramid", eave, peak: top, faces, verts: faces.length * 3, ridgeAngleDeg: 0, minSide, area };
  }
  const R1 = add(midBC, mul(u, -inset));
  const R2 = add(midDA, mul(u, inset));
  faces.push(tri(eavePt(A), eavePt(B), peakPt(R2)));
  faces.push(tri(eavePt(A), peakPt(R2), peakPt(R1)));
  faces.push(tri(eavePt(C), eavePt(D), peakPt(R1)));
  faces.push(tri(eavePt(C), peakPt(R1), peakPt(R2)));
  faces.push(tri(eavePt(B), eavePt(C), peakPt(R1)));
  faces.push(tri(eavePt(D), eavePt(A), peakPt(R2)));
  return { type: "hip", eave, peak: top, faces, verts: faces.length * 3, ridge: [R1, R2], ridgeAngleDeg, longEdge, minSide, area };
}
