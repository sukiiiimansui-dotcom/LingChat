/* wsBldModel.ts —— **拆件 → 体块/环带**的纯几何预处理（不 import three、不碰 DOM）。
 *
 * 定位（S2）：`wsMvtBldMap` 把瓦片里的非主体件挂到了 `properties.__parts`；
 * 本文件只回答两件事，**不画任何东西**：
 *   ① 这栋楼该画哪些**体块**（p=1 裙楼 / 2 塔楼 / 3 退台）——有体块就不画单块主体；
 *   ② 女儿墙 p=4 的**环带环**怎么处理（`ringBand` 把外圈 + 内圈倒序拼成一条，
 *      直接喂 `triangulateRing` 会 0 三角；在中点 n 处只取**外圈**，内圈用同一套
 *      0.7m 径向缩进重算 —— MVT 编码器不保证两半逐点对应，直接用两半会差 12%）。
 *
 * 判据（见 `world_map/ws_bld_model_selftest.mjs`）：
 *   · 458m 塔那栋有 4 个体块（p=1/2/3/3）+ 女儿墙；
 *   · p=4 拆出的外圈面积 − 内圈面积 ≈ 顶环带三角形面积（误差 ≤1%）；
 *   · 变异（把 p=4 当普通环 / 只留最高一条）⇒ 判据红。
 */

/** 与 `wsMvtBldMap.MvtBldPart` 同形（这里不 import 那个模块，避免把映射层拖进几何层） */
export interface BldPartLike {
  p?: unknown;
  h?: unknown;
  hb?: unknown;
  c?: unknown;
  zt?: unknown;
  geometry?: unknown;
}

export type Pt = [number, number];

export interface BldModelParts {
  /** 体块（p=1/2/3），按 hb 升序；有它就不画单块主体 */
  massing: BldPartLike[];
  /** 女儿墙（p=4），一条环带环 */
  parapet: BldPartLike[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 部件码；认不出返回 -1（不要拿 0 兜底，0 是主体） */
export function partCodeOf(p: unknown): number {
  if (p === undefined || p === null || p === "") return 0;
  const n = Number(p);
  return Number.isFinite(n) ? n : -1;
}

const MASS_CODE = new Set([1, 2, 3]);

/** 环的（有符号）面积 ×2；环点顺序就是输入的经纬度顺序 */
function signedArea2(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** 一个环的绝对面积 */
export function ringArea(pts: readonly Pt[]): number {
  return Math.abs(signedArea2(pts)) / 2;
}

function pointOf(raw: unknown): Pt | null {
  if (!Array.isArray(raw)) return null;
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** 女儿墙厚度（米）：与 `wsBuildingLook.PARAPET_THICK_M` 同值；用于重算内圈 */
export const PARAPET_THICK_M = 0.7;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/** 向外圈里径向缩进 `meters` 米（与生成侧 `insetRingMeters` 同一算法；点序不变） */
export function insetRingOf(outer: readonly Pt[], meters: number): Pt[] {
  const n = outer.length;
  if (n < 3 || !(meters > 0)) return outer.map((p) => [p[0], p[1]] as Pt);
  let cx = 0;
  let cy = 0;
  for (const p of outer) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  const lat0 = outer[0]![1]!;
  const kx = M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return outer.map((p) => {
    const dx = (p[0] - cx) * kx;
    const dy = (p[1] - cy) * ky;
    const d = Math.hypot(dx, dy);
    if (!(d > 1e-6)) return [p[0], p[1]] as Pt;
    const k = Math.max(0.08, 1 - meters / d);
    return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as Pt;
  });
}

/** p=4 的环带环 → 外圈 + 按 `meters` 重算的内圈（点序一一对应）。形状不对返回 null。 */
export function bandRingsOf(part: BldPartLike, meters: number = PARAPET_THICK_M): { outer: Pt[]; inner: Pt[] } | null {
  const geom = part.geometry as { type?: string; coordinates?: unknown } | null;
  let rings: unknown[] = [];
  if (geom?.type === "Polygon" && Array.isArray(geom.coordinates)) {
    rings = geom.coordinates as unknown[];
  } else if (geom?.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    const poly = (geom.coordinates as unknown[])[0];
    if (Array.isArray(poly)) rings = poly;
  }
  const ring = rings[0];
  if (!Array.isArray(ring)) return null;
  const pts: Pt[] = [];
  for (const raw of ring) {
    const p = pointOf(raw);
    if (p) pts.push(p);
  }
  /* MVT 通常不带闭合点；带了就去掉尾巴 */
  if (pts.length > 1) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  /* 外圈 + 内圈倒序 = 2n 点；奇数说明不是 `ringBand` 的产物，别硬拆 */
  if (pts.length < 6 || pts.length % 2 !== 0) return null;
  const n = pts.length / 2;
  const a = pts.slice(0, n);
  const b = pts.slice(n);
  /* ⚠️ MVT 编码器不保证“前半=外圈”，也不保证后半与前半逐点对应
     （458m 塔那栋实测：前半面积 1.404e-7、后半 1.489e-7，后半才是外圈；
     直接把两半配对做顶环带，面积会差 12%）。⇒ 只取**面积大的那半当外圈**，
     内圈用同一套径向缩进（0.7m）重新算，点序天然一一对应，顶环带面积才闭合。 */
  const outer = ringArea(a) >= ringArea(b) ? a : b;
  const inner = insetRingOf(outer, meters);
  return { outer, inner };
}

/** 外圈面积 / 内圈面积 / 环带面积（经纬度口径；比值与投影无关） */
export function bandAreaOf(outer: readonly Pt[], inner: readonly Pt[]): { outer: number; inner: number; band: number } {
  const o = ringArea(outer);
  const i = ringArea(inner);
  return { outer: o, inner: i, band: o - i };
}

function triArea(a: Pt, b: Pt, c: Pt): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

/** 顶环带按“外圈第 i 段 + 内圈第 i 段”拼 quad 后的三角形面积和（用来证明拆法闭合） */
export function bandTopAreaOf(outer: readonly Pt[], inner: readonly Pt[]): number {
  const n = Math.min(outer.length, inner.length);
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += triArea(outer[i]!, outer[j]!, inner[j]!);
    a += triArea(outer[i]!, inner[j]!, inner[i]!);
  }
  return a;
}

/**
 * 一栋楼的建模件：
 * · `__parts` 里的 p=1/2/3 是体块；p=4 是女儿墙；
 * · 主体自己如果是 p=1/2/3（没有 p=0）也补进体块（S1 为避免双画把它从 `__parts` 排除了）；
 * · 去重键 `p + h(0.1m) + hb(0.01m)`，同键留先到的（S1 已按环点数挑过更完整的）。
 */
export function modelPartsOf(props: Record<string, unknown>, primary: BldPartLike): BldModelParts {
  const raw = Array.isArray(props.__parts) ? props.__parts : [];
  const masses = new Map<string, BldPartLike>();
  const parapets = new Map<string, BldPartLike>();
  const add = (part: BldPartLike): void => {
    const code = partCodeOf(part.p);
    if (MASS_CODE.has(code)) {
      const key = `${code}:${Math.round(num(part.h) * 10)}:${Math.round(num(part.hb) * 100)}`;
      if (!masses.has(key)) masses.set(key, part);
    } else if (code === 4) {
      const key = `4:${Math.round(num(part.h) * 10)}:${Math.round(num(part.hb) * 100)}`;
      if (!parapets.has(key)) parapets.set(key, part);
    }
  };
  for (const part of raw) {
    if (part && typeof part === "object") add(part as BldPartLike);
  }
  add(primary);
  const massing = [...masses.values()].sort((a, b) => num(a.hb) - num(b.hb) || num(a.h) - num(b.h) || partCodeOf(a.p) - partCodeOf(b.p));
  const parapet = [...parapets.values()].sort((a, b) => num(a.hb) - num(b.hb) || num(a.h) - num(b.h));
  return { massing, parapet };
}
