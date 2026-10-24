/* wsBldVariants.ts —— 楼房的**几何变体**：确定性选择 + 低面数构件几何（纯函数，不 import three / 不碰 DOM）。
 *
 * ## 为什么单独一个文件
 * `wsBldFacade.ts` 只换**贴图**（6 格图集 + 色相抖动），体块/顶部/角部仍然是同一套 ⇒
 * 同一片区看过去像复制粘贴。这里给每栋楼在**形状**上再分三档：
 *   · 立面节奏 `rhythm`：0 竖向壁柱（竖条窗）/ 1 横向窗台带（每层一条窗带）/ 2 阳台盒（小格窗）
 *   · 顶部处理 `top`   ：0 平顶 / 1 退台（收分台）/ 2 帽檐·设备层（有 p=6 就复用，没有加屋顶盒）
 *   · 角部处理 `corner`：0 直角 / 1 装饰切角面板 / 2 凸窗盒（可选，仅近景）
 *
 * 选择规则（**同一栋楼永远同一套**，不是随机数）：
 *   `hashId("v:rhythm:"+id)` / `("v:top:"+id)` / `("v:corner:"+id)` 各取一次，
 *   按建筑类型（`k`/`kind`：住宅/商业/办公）的权重落档；类型缺失时按高度分档
 *   （<24m 住宅 / 24–60m 商业 / ≥60m 办公）。
 *
 * 预算（与 `wsBldMesh` 的细节预算同一本总账）：
 *   · 每个构件 2–6 个三角（见 `COMPONENT_TRIS`）；
 *   · 中景（LOD tier 1）只放**一件**最省心的节奏构件；近景（tier 2）才加顶部与角部；
 *   · 远景（tier 0）**一个构件都不加**（`variantCostOf` 直接返回 0）；
 *   · 变体自己的总额 `VARIANT_VERTS_MAX` 从 `DETAIL_VERTS_MAX` 里划出 ⇒ 三角总数不涨。
 *
 * 判据：`world_map/ws_bld_variant_selftest.mjs`（两次生成逐字节相同 / 三种都出现 /
 * 中近景才有 / 总量不超预算 / 变异能杀）。
 */

import { hashId } from "./wsBldFacade";
import { triangulateRing } from "./wsShapeTri";

export type Pt2 = readonly [number, number];
export type Pt3 = readonly [number, number, number];

export type BldVariantClass = "residential" | "commercial" | "office";
export type BldRhythm = 0 | 1 | 2;
export type BldTop = 0 | 1 | 2;
export type BldCorner = 0 | 1 | 2;

export interface BldVariantPick {
  cls: BldVariantClass;
  /** 0 竖向壁柱 / 1 横向窗台带 / 2 阳台盒 */
  rhythm: BldRhythm;
  /** 0 平顶 / 1 退台 / 2 帽檐·设备层 */
  top: BldTop;
  /** 0 直角 / 1 切角面板 / 2 凸窗盒 */
  corner: BldCorner;
}

/** 每种构件大约几个三角（文件头"2–6 个三角"的出处；实际以 `variantGeoOf` 为准） */
export const COMPONENT_TRIS = {
  fin: 4,          /* 壁柱：正面 + 一个侧面（两个四边形） */
  ledge: 4,        /* 窗台带：正面 + 顶面 */
  balcony: 6,      /* 阳台盒：底板 + 正面栏板 + 一个侧面 */
  setback: 9,      /* 收分台：n 条侧墙 + n−2 个顶三角（n=4 时 10 个三角） */
  roofBox: 10,     /* 屋顶盒：四面墙 + 顶盖 */
  chamfer: 2,      /* 切角面板：一块斜板 */
  bay: 4,          /* 凸窗盒：正面 + 一个侧面（两个四边形） */
} as const;

/** 变体总顶点预算（从 `DETAIL_VERTS_MAX = 22_000` 里划出，**不额外加总量**） */
export const VARIANT_VERTS_MAX = 8_000;
/** 单栋变体顶点上限（与 `DETAIL_PER_BUILDING_VERTS` 同数，独立一本账） */
export const VARIANT_PER_BUILDING_VERTS = 96;

/* ── 建筑类型（k/kind 的粗分类；认不出的按高度分档） ───────────────────────── */

const RESIDENTIAL: ReadonlySet<string> = new Set([
  "house", "detached", "semidetached_house", "terrace", "bungalow", "hut",
  "apartments", "residential", "dormitory", "flats", "cabin", "villa",
]);
const COMMERCIAL: ReadonlySet<string> = new Set([
  "commercial", "retail", "supermarket", "mall", "shop", "kiosk", "marketplace",
  "hotel", "restaurant", "cafe", "bar", "pub", "cinema", "theatre", "stadium",
  "transportation", "train_station", "airport", "hospital", "school", "university",
  "education", "civic", "government", "religious", "church", "temple", "mosque",
]);
const OFFICE: ReadonlySet<string> = new Set([
  "office", "tower", "skyscraper", "business", "industrial", "warehouse",
]);

/** 建筑类型 → 三类之一；`yes`/未知按高度分档（与 `renderHeight` 的估算档同一量级） */
export function bldClassOf(props: Record<string, unknown> | null | undefined, h: number): BldVariantClass {
  const raw = String(props?.k ?? props?.kind ?? "").toLowerCase();
  if (RESIDENTIAL.has(raw)) return "residential";
  if (COMMERCIAL.has(raw)) return "commercial";
  if (OFFICE.has(raw)) return "office";
  const hh = Number.isFinite(h) ? h : 0;
  if (hh >= 60) return "office";
  if (hh >= 24) return "commercial";
  return "residential";
}

/* 权重（百分比，和为 100）：类型只影响**哪一档更常见**，三档都可能出现 */
const RHYTHM_W: Record<BldVariantClass, readonly [number, number, number]> = {
  residential: [30, 25, 45],
  commercial: [20, 50, 30],
  office: [55, 20, 25],
};
const TOP_W: Record<BldVariantClass, readonly [number, number, number]> = {
  residential: [45, 30, 25],
  commercial: [30, 30, 40],
  office: [25, 35, 40],
};

function pickWeighted(hash: number, w: readonly [number, number, number]): 0 | 1 | 2 {
  const r = hash % 100;
  if (r < w[0]) return 0;
  if (r < w[0] + w[1]) return 1;
  return 2;
}

/**
 * 一栋楼的变体（**纯函数**：同 id + 同类型 + 同高度 ⇒ 永远同一套）。
 * @param id 要素 id（`hashId` 的输入；空 id 时调用方给个稳定占位）
 * @param props 要素属性（读 `k` / `kind`）
 * @param h 楼的最高点（米；类型缺失时用来分档）
 */
export function pickBldVariant(id: string, props: Record<string, unknown> | null | undefined, h: number): BldVariantPick {
  const cls = bldClassOf(props, h);
  const key = String(id ?? "");
  return {
    cls,
    rhythm: pickWeighted(hashId(`v:rhythm:${key}`), RHYTHM_W[cls]),
    top: pickWeighted(hashId(`v:top:${key}`), TOP_W[cls]),
    corner: (hashId(`v:corner:${key}`) % 3) as BldCorner,
  };
}

/**
 * 这栋楼在某一档上要花多少顶点（**预算口径**；实际几何若退化只会更少）。
 * `ringN` = 最大外环点数（退台收分台按 n 算）；`hasEquip` = 这栋有 p=6 设备箱。
 */
export function variantCostOf(
  pick: BldVariantPick,
  tier: number,
  ringN: number,
  hasEquip: boolean
): number {
  if (!(tier >= 1)) return 0;
  /* 中景只放一件：壁柱 12 / 窗台带 12 / 阳台 12 */
  if (tier === 1) return 12;
  /* 近景三种节奏都是 36：3 根壁柱 × 12 / 3 道窗台 × 12 / 2 个阳台 × 18 */
  let v = 36;
  if (pick.top === 1) {
    /* 收分台：n 面墙 + (n−2) 个顶三角；n>6 或 n<4 用屋顶盒（10 三角） */
    v += ringN >= 4 && ringN <= 6 ? 6 * ringN + 3 * (ringN - 2) : 30;
  } else if (pick.top === 2 && !hasEquip) {
    v += 30;
  }
  if (pick.corner === 1) v += 6;
  else if (pick.corner === 2) v += 12;
  return v;
}

/* ── 几何：局部米 → 三角（每个三角带一个面法线，给顶点色分档用） ────────────── */

export interface VariantTri {
  a: Pt3;
  b: Pt3;
  c: Pt3;
  /** 面法线（只需方向；顶面 [0,1,0]，底面 [0,-1,0]） */
  n: Pt3;
  /** true = 屋顶面（乘 `ROOF_MUL`），false = 墙面（走三档明暗） */
  roof: boolean;
}

export interface VariantGeo {
  tris: VariantTri[];
  verts: number;
}

export interface VariantGeoInput {
  pick: BldVariantPick;
  tier: number;
  /** 局部米外环（未闭合也可；重复点会被去掉） */
  ring: readonly Pt2[];
  /** 墙脚（米） */
  base: number;
  /** 墙顶（米） */
  top: number;
  /** 几何抖动种子（通常 `hashId("v:geom:"+id)`；**只用于在边上的落点**） */
  seed: number;
  hasEquip: boolean;
  /** 有坡屋顶时不加“顶部处理”（坡屋顶本身就是顶部） */
  allowTop?: boolean;
}

interface Edge {
  a: Pt2;
  b: Pt2;
  ux: number;
  uz: number;
  /** 外法线（单位） */
  nx: number;
  nz: number;
  len: number;
  i: number;
}


function saneRing(ring: readonly Pt2[]): Pt2[] {
  const out: Pt2[] = [];
  for (const p of ring) {
    const x = Number(p?.[0]);
    const z = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === z) continue;
    out.push([x, z]);
  }
  if (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

function signedArea2(pts: readonly Pt2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

function edgesOf(ring: readonly Pt2[]): Edge[] {
  const n = ring.length;
  const out: Edge[] = [];
  if (n < 3) return out;
  /* 逆时针（局部 x/z 平面）时外法线 = (dz, −dx)；顺时针反过来 */
  const s = signedArea2(ring) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) continue;
    out.push({ a, b, ux: dx / len, uz: dz / len, nx: (s * dz) / len, nz: (-s * dx) / len, len, i });
  }
  return out;
}

/** 边按长度降序（同长按原下标 ⇒ 确定性） */
function edgesByLength(edges: readonly Edge[]): Edge[] {
  return edges.slice().sort((a, b) => b.len - a.len || a.i - b.i);
}

function addTri(tris: VariantTri[], a: Pt3, b: Pt3, c: Pt3, n: Pt3, roof: boolean): void {
  tris.push({ a, b, c, n, roof });
}

/** 四边面 → 两个三角（p0→p1→p2→p3 顺序绕一圈） */
function addQuad(tris: VariantTri[], p0: Pt3, p1: Pt3, p2: Pt3, p3: Pt3, n: Pt3, roof: boolean): void {
  addTri(tris, p0, p1, p2, n, roof);
  addTri(tris, p0, p2, p3, n, roof);
}

function centroidOf(ring: readonly Pt2[]): Pt2 {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

/** 边上 t∈(0,1) 处、半宽 hw 的两个墙点 + 外挑点 */
function edgeSpot(e: Edge, t: number, hw: number, depth: number): { p1: Pt2; p2: Pt2; p1d: Pt2; p2d: Pt2 } {
  const cx = e.a[0] + (e.b[0] - e.a[0]) * t;
  const cz = e.a[1] + (e.b[1] - e.a[1]) * t;
  const p1: Pt2 = [cx - e.ux * hw, cz - e.uz * hw];
  const p2: Pt2 = [cx + e.ux * hw, cz + e.uz * hw];
  const p1d: Pt2 = [p1[0] + e.nx * depth, p1[1] + e.nz * depth];
  const p2d: Pt2 = [p2[0] + e.nx * depth, p2[1] + e.nz * depth];
  return { p1, p2, p1d, p2d };
}

/* 每个构件的几何；返回追加的三角数（顶点数 = 三角数 × 3） */

function addFin(tris: VariantTri[], e: Edge, t: number, y0: number, y1: number, seed: number): void {
  const hw = Math.max(0.18, Math.min(0.7, e.len * 0.14));
  const depth = 0.32;
  const { p1, p2, p1d, p2d } = edgeSpot(e, t, hw, depth);
  const n: Pt3 = [e.nx, 0, e.nz];
  addQuad(tris,
    [p1d[0], y0, p1d[1]], [p2d[0], y0, p2d[1]], [p2d[0], y1, p2d[1]], [p1d[0], y1, p1d[1]],
    n, false);
  /* 只做一个侧面（薄壁柱的另一个侧面在近景也基本被正立面挡住） */
  if ((seed & 1) === 0) {
    addQuad(tris,
      [p1[0], y0, p1[1]], [p1d[0], y0, p1d[1]], [p1d[0], y1, p1d[1]], [p1[0], y1, p1[1]],
      [-e.ux, 0, -e.uz], false);
  } else {
    addQuad(tris,
      [p2d[0], y0, p2d[1]], [p2[0], y0, p2[1]], [p2[0], y1, p2[1]], [p2d[0], y1, p2d[1]],
      [e.ux, 0, e.uz], false);
  }
}

function addLedge(tris: VariantTri[], e: Edge, frac: number, base: number, top: number): void {
  if (!(top - base > 0.6)) return;
  const y = base + (top - base) * Math.max(0.08, Math.min(0.92, frac));
  const depth = 0.42;
  const th = 0.22;
  const p1 = e.a;
  const p2 = e.b;
  const p1d: Pt2 = [p1[0] + e.nx * depth, p1[1] + e.nz * depth];
  const p2d: Pt2 = [p2[0] + e.nx * depth, p2[1] + e.nz * depth];
  const yh = y - th / 2;
  const yt = y + th / 2;
  addQuad(tris,
    [p1d[0], yh, p1d[1]], [p2d[0], yh, p2d[1]], [p2d[0], yt, p2d[1]], [p1d[0], yt, p1d[1]],
    [e.nx, 0, e.nz], false);
  addQuad(tris,
    [p1[0], yt, p1[1]], [p2[0], yt, p2[1]], [p2d[0], yt, p2d[1]], [p1d[0], yt, p1d[1]],
    [0, 1, 0], false);
}

function addBalcony(
  tris: VariantTri[],
  e: Edge,
  t: number,
  frac: number,
  base: number,
  top: number,
  full: boolean
): void {
  if (!(top - base > 1.6)) return;
  const y = Math.min(base + (top - base) * Math.max(0.08, Math.min(0.85, frac)), top - 1.3);
  const hw = Math.max(1.0, Math.min(1.8, e.len * 0.22));
  const depth = 0.78;
  const { p1, p2, p1d, p2d } = edgeSpot(e, t, hw, depth);
  const y1 = y + 1.0;
  addQuad(tris,
    [p1[0], y, p1[1]], [p2[0], y, p2[1]], [p2d[0], y, p2d[1]], [p1d[0], y, p1d[1]],
    [0, -1, 0], false);
  addQuad(tris,
    [p1d[0], y, p1d[1]], [p2d[0], y, p2d[1]], [p2d[0], y1, p2d[1]], [p1d[0], y1, p1d[1]],
    [e.nx, 0, e.nz], false);
  if (full) {
    addQuad(tris,
      [p1[0], y, p1[1]], [p1d[0], y, p1d[1]], [p1d[0], y1, p1d[1]], [p1[0], y1, p1[1]],
      [-e.ux, 0, -e.uz], false);
  }
}

function addSetback(tris: VariantTri[], ring: readonly Pt2[], top: number, dh: number): void {
  const c = centroidOf(ring);
  const inner: Pt2[] = ring.map((p) => [c[0] + (p[0] - c[0]) * 0.7, c[1] + (p[1] - c[1]) * 0.7]);
  const edges = edgesOf(ring);
  for (const e of edges) {
    const i = e.i;
    const j = (i + 1) % ring.length;
    const oi = ring[i]!;
    const oj = ring[j]!;
    const ii = inner[i]!;
    const ij = inner[j]!;
    addQuad(tris,
      [oi[0], top, oi[1]], [oj[0], top, oj[1]], [ij[0], top + dh, ij[1]], [ii[0], top + dh, ii[1]],
      [e.nx, 0, e.nz], false);
  }
  const cap = triangulateRing(inner);
  for (let k = 0; k + 2 < cap.length; k += 3) {
    const a = inner[cap[k]!]!;
    const b = inner[cap[k + 1]!]!;
    const d = inner[cap[k + 2]!]!;
    addTri(tris, [a[0], top + dh, a[1]], [b[0], top + dh, b[1]], [d[0], top + dh, d[1]], [0, 1, 0], true);
  }
}

function addRoofBox(tris: VariantTri[], ring: readonly Pt2[], top: number, h: number, scale: number): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  if (!(maxX - minX > 1) || !(maxZ - minZ > 1)) return;
  const c = centroidOf(ring);
  const hw = Math.max(0.7, Math.min(2.2, (maxX - minX) * scale));
  const hd = Math.max(0.7, Math.min(2.2, (maxZ - minZ) * scale));
  const x0 = c[0] - hw;
  const x1 = c[0] + hw;
  const z0 = c[1] - hd;
  const z1 = c[1] + hd;
  const y0 = top;
  const y1 = top + Math.max(0.8, h);
  /* 四面墙（各自外法线） */
  addQuad(tris, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], false);
  addQuad(tris, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], false);
  addQuad(tris, [x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1], false);
  addQuad(tris, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], false);
  addQuad(tris, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], true);
}

function addChamfer(tris: VariantTri[], ring: readonly Pt2[], base: number, top: number, seed: number): void {
  const n = ring.length;
  if (n < 3) return;
  const i = seed % n;
  const c = ring[i]!;
  const prev = ring[(i - 1 + n) % n]!;
  const next = ring[(i + 1) % n]!;
  const ePrev = edgesOf(ring).find((e) => e.i === (i - 1 + n) % n);
  const eNext = edgesOf(ring).find((e) => e.i === i);
  if (!ePrev || !eNext) return;
  const q1: Pt2 = [c[0] + (prev[0] - c[0]) * 0.22 + ePrev.nx * 0.04, c[1] + (prev[1] - c[1]) * 0.22 + ePrev.nz * 0.04];
  const q2: Pt2 = [c[0] + (next[0] - c[0]) * 0.22 + eNext.nx * 0.04, c[1] + (next[1] - c[1]) * 0.22 + eNext.nz * 0.04];
  const nx = ePrev.nx + eNext.nx;
  const nz = ePrev.nz + eNext.nz;
  const l = Math.hypot(nx, nz) || 1;
  addQuad(tris,
    [q1[0], base, q1[1]], [q2[0], base, q2[1]], [q2[0], top, q2[1]], [q1[0], top, q1[1]],
    [nx / l, 0, nz / l], false);
}

function addBay(tris: VariantTri[], ring: readonly Pt2[], base: number, top: number, seed: number): void {
  const n = ring.length;
  if (n < 3) return;
  const i = seed % n;
  const c = ring[i]!;
  const prev = ring[(i - 1 + n) % n]!;
  const next = ring[(i + 1) % n]!;
  const up = (p: Pt2): Pt2 => {
    const dx = p[0] - c[0];
    const dz = p[1] - c[1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const u1 = up(prev);
  const u2 = up(next);
  const bx = u1[0] + u2[0];
  const bz = u1[1] + u2[1];
  const bl = Math.hypot(bx, bz) || 1;
  const nx = bx / bl;
  const nz = bz / bl;
  const reach = 0.9;
  const depth = 0.55;
  const q1: Pt2 = [c[0] + u1[0] * reach, c[1] + u1[1] * reach];
  const q2: Pt2 = [c[0] + u2[0] * reach, c[1] + u2[1] * reach];
  const o1: Pt2 = [q1[0] + nx * depth, q1[1] + nz * depth];
  const o2: Pt2 = [q2[0] + nx * depth, q2[1] + nz * depth];
  addQuad(tris,
    [o1[0], base, o1[1]], [o2[0], base, o2[1]], [o2[0], top, o2[1]], [o1[0], top, o1[1]],
    [nx, 0, nz], false);
  addQuad(tris,
    [q1[0], base, q1[1]], [o1[0], base, o1[1]], [o1[0], top, o1[1]], [q1[0], top, q1[1]],
    [-u1[1], 0, u1[0]], false);
}

/**
 * 生成一栋楼的变体几何（局部米）。**没有任何随机/时钟**：同输入逐字节同输出。
 *
 * 取舍：只对**一个外环**（调用方给最大的那个）加构件；立面节奏在边上布置，
 * 顶部处理叠在墙顶上（`allowTop:false` 时不加，例如有坡屋顶）；角部只做一个角。
 */
export function variantGeoOf(input: VariantGeoInput): VariantGeo {
  const ring = saneRing(input.ring);
  const tris: VariantTri[] = [];
  const tier = input.tier;
  if (ring.length < 3 || !(tier >= 1)) return { tris, verts: 0 };
  const base = Number.isFinite(input.base) ? input.base : 0;
  const top = Number.isFinite(input.top) ? input.top : 0;
  if (!(top - base > 0.8)) return { tris, verts: 0 };
  const edges = edgesOf(ring);
  if (!edges.length) return { tris, verts: 0 };
  const byLen = edgesByLength(edges);
  const seed = Number.isFinite(input.seed) ? Math.abs(Math.floor(input.seed)) : 0;
  const pick = input.pick;

  /* 立面节奏：中景一件；近景三件（都放在最长的边上，落点按种子错开） */
  if (tier === 1) {
    const e = byLen[0]!;
    if (pick.rhythm === 0) addFin(tris, e, 0.5, base + 0.5, top - 0.4, seed);
    else if (pick.rhythm === 1) addLedge(tris, e, 0.55, base, top);
    else addBalcony(tris, e, 0.5, 0.55, base, top, false);
  } else {
    if (pick.rhythm === 0) {
      /* 3 根壁柱：3 条最长边各一根；边数不足就回绕（落点 0.32/0.68 交替） */
      for (let k = 0; k < 3; k++) {
        const e = byLen[k % byLen.length]!;
        const onSame = Math.floor(k / byLen.length);
        const t = onSame === 0 ? (k % 2 === 0 ? 0.32 : 0.68) : 0.5;
        addFin(tris, e, t, base + 0.5, top - 0.35, seed + k);
      }
    } else if (pick.rhythm === 1) {
      /* 3 道窗台带：最长边两道、第二长边一道 */
      addLedge(tris, byLen[0]!, 0.34, base, top);
      addLedge(tris, byLen[0]!, 0.68, base, top);
      addLedge(tris, byLen[1 % byLen.length]!, 0.5, base, top);
    } else {
      /* 两个阳台盒（底板 + 栏板 + 一个侧面） */
      addBalcony(tris, byLen[0]!, 0.3, 0.5, base, top, true);
      addBalcony(tris, byLen[0]!, 0.7, 0.5, base, top, true);
    }
    /* 顶部处理：有坡屋顶时不加（坡屋顶自己就是顶部） */
    if (input.allowTop !== false) {
      if (pick.top === 1) {
        if (ring.length >= 4 && ring.length <= 6) {
          addSetback(tris, ring, top, Math.max(1.2, Math.min(2.6, (top - base) * 0.05)));
        } else {
          addRoofBox(tris, ring, top, Math.max(1.3, Math.min(2.6, (top - base) * 0.05)), 0.22);
        }
      } else if (pick.top === 2) {
        /* 有 p=6 设备箱就复用（不加几何）；没有才补一个屋顶盒 */
        if (!input.hasEquip) addRoofBox(tris, ring, top, 1.5, 0.2);
      }
    }
    /* 角部处理（可选） */
    if (pick.corner === 1) addChamfer(tris, ring, base, top, seed);
    else if (pick.corner === 2) addBay(tris, ring, base, top, seed);
  }

  return { tris, verts: tris.length * 3 };
}

/* 供自检用：把“这一档应该有几个顶点”直接算出来（不用去数三角） */
export function variantTierOf(hpx: number): 0 | 1 | 2 {
  /* 只给自检/探针用的简化判词；真源仍是 `wsBldLod.lodTierOfHpx`（滞回由状态给）。 */
  if (hpx >= 72) return 2;
  if (hpx >= 32) return 1;
  return 0;
}
