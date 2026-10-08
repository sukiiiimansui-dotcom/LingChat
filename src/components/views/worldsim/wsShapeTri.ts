/* wsShapeTri.ts —— **平面多边形的三角化**（纯函数、零依赖、可单测）。
 *
 * ## 为什么要有这个文件
 * 3D 后端要画的是**真实的楼脚印**（OSM/Overture 的 Polygon，L 形、凹多边形、细长条都有），
 * 而三家里那份 `three.min.js` 是**精简构建**（没有 `ShapeUtils` / `ExtrudeGeometry` —— 实查：
 * 整份文件里 `ShapeUtils` 出现 0 次）。原型那套自己造城的几何是**矩形地块**（`addBox`/`addRotBox`），
 * 根本没有多边形三角化这回事 ⇒ 这段只能自己写。
 *
 * 算法 = **耳切（ear clipping）**，输入一个简单多边形（外环），输出三角形索引三元组。
 * 复杂多边形（带洞的院子/天井）本轮**只取外环**：洞会被填上。这是一个**已知差额**，
 * 后端会在 `stats().note` 里如实报出丢了多少个洞（不静默）。
 *
 * 正确性判据（`world_map/ws_shape_tri_selftest.mjs`）：**三角形面积和 = 多边形面积**
 * （相对误差 < 1e-6），凹多边形与 3 点共线的退化边都要过。
 */

export type Pt = readonly [number, number];

/** 有向面积 ×2（>0 = 逆时针）。耳切要靠它定方向，自检靠它算面积。 */
export function signedArea2(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** 多边形面积（绝对值，平方米口径由调用方决定） */
export function ringArea(pts: readonly Pt[]): number {
  return Math.abs(signedArea2(pts)) / 2;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * 耳切三角化。返回**索引三元组**（相对传入数组的下标），逆时针序。
 *
 * · 少于 3 点 ⇒ 空；面积退化（≈0）⇒ 空（宁可少画一片面，也不画一条零面积的碎三角）；
 * · 中间遇到自交/退化导致切不动 ⇒ **能切多少算多少**并返回（不抛：一栋楼的形状怪
 *   不该让整座城停下来）。
 */
export function triangulateRing(input: readonly Pt[]): number[] {
  const pts: Pt[] = [];
  for (const p of input) {
    if (!p) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    /* 非有限值 / 重复点都丢掉：它们会让耳切死循环或切出零面积三角 */
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    pts.push([x, y]);
  }
  /* 首尾重复（GeoJSON 线性环是闭合的）⇒ 去掉尾巴那一个重复点 */
  if (pts.length > 1) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  const n = pts.length;
  if (n < 3) return [];
  if (ringArea(pts) < 1e-9) return [];

  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (signedArea2(pts) < 0) idx.reverse();          // 统一成逆时针

  const out: number[] = [];
  let guard = n * n + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = pts[ia]!;
      const b = pts[ib]!;
      const c = pts[ic]!;
      if (cross(a, b, c) <= 1e-12) continue;        // 凹点或共线 ⇒ 不是耳
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(pts[j]!, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;                            // 退化了：能切多少算多少
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/**
 * 一个多边形（外环 + 若干洞）的**可画三角**。
 * 本轮洞**不参与**（只取外环），但洞的个数要**报出来**（后端把它写进 `stats().note`）。
 */
export function triangulatePolygon(rings: readonly (readonly Pt[])[]): { tris: number[]; pts: Pt[]; holes: number } {
  const outer = (rings[0] || []) as readonly Pt[];
  const pts = outer.slice() as Pt[];
  return { tris: triangulateRing(pts), pts, holes: Math.max(0, rings.length - 1) };
}
