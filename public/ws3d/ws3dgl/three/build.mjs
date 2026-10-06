// build.mjs —— 城市 → 几何缓冲（**纯逻辑，不 import three** ⇒ node 里能直接测）。
//
// 分工：本文件只产出「顶点/法线/UV/顶点色/索引」这些平铺数组；
// 怎么变成 BufferGeometry、挂什么材质、什么时候显示，全在 world.mjs。
// 这样 selftest.mjs 不开浏览器也能断言"UV 缩放对不对、楼顶在不在该在的高度、索引越界没有"。
//
// 与 v1（手写版 mesh.mjs）的关系：那边是「一种顶点格式 + 一堆 KIND/MAT 常量」，
// 顶点里塞了给自写着色器看的打包信息；three 这边改成**按材质分桶**（每个桶一个几何体 = 一次 draw call），
// 几何本身是通用的 position/normal/uv/color。生成规则（裙楼退台、阳台、屋顶设备、道路条带）是同一套思路，
// 但没有复制 v1 的代码 —— 顶点格式不同，硬搬只会得到两套要同时维护的东西。
//
// 顶点色（color）在 three 里由 vertexColors:true 的材质乘上去 ⇒
// 同一张贴图能出"每栋楼自己的色偏"（style.mjs 给每栋一个 tint），不用多一个 draw call。
import { roadSpec, SIDEWALK_W } from '../city.mjs';
import { hashSeed, rngOf, clamp } from '../util.mjs';
import { TIERS, GROUND, ACCENT, TILE, SHOP_H, toRgb, shade } from './palette.mjs';
import { queryNumbers, defaultSearch } from './style.mjs';

/** 细节分块边长（米）与两档可见距离的默认值（L / 参数可改） */
export const DEFAULT_OPTS = {
  lodNear: 270,     // < 这个距离：阳台/飘窗/门廊/空地停车场等近景细节
  lodMid: 640,      // < 这个距离：女儿墙/水箱/天线/坡顶等轮廓细节
  cell: 256,        // 细节分块（一格里一次 draw call）
  shopRecess: 0.34, // 底商内凹（米）—— 沿街立面因此有真实的阴影线
};

/**
 * 建模参数（v2）——与 style.mjs 同一套"URL 可覆盖 + 一键回退"的约定：
 *   `?phase=0`  立面 UV 相位回零（M1 的旧行为：全城窗户逐格对齐）
 *   `?farSil=0` 远景轮廓不发（M3 的旧行为：>lodMid 的楼是纯平顶棱柱）
 *   `?farR=640` 远景轮廓的距离门槛（默认取 opts.lodMid，与 mid 档的可见距离对齐）
 *   `?modeling=1`（别名 `?model=1`）总回退：M1 相位 0 + M3 轮廓关（配合 style.mjs 的旧分布 = 改动前的城）
 *   ⚠️ 主键叫 modeling 是因为 `?model=` 已被骨骼角色的 glb 路径占用，见 style.mjs 里的说明
 */
export const BUILD_V1 = { phase: 0, farSilhouette: 0, farRadius: null };
export const BUILD_V2 = { phase: 1, farSilhouette: 1, farRadius: null };

export function resolveBuildModel(opts = {}, search) {
  const q = queryNumbers(search === undefined ? defaultSearch() : search);
  const v1 = Number(opts.modeling) === 1 || Number(opts.model) === 1 || q.modeling === 1 || q.model === 1;
  const m = { ...(v1 ? BUILD_V1 : BUILD_V2) };
  for (const [k, raw] of Object.entries(q)) {
    if (!Number.isFinite(Number(raw))) continue;
    if (k === 'phase') m.phase = Number(raw);
    else if (k === 'farsil') m.farSilhouette = Number(raw) ? 1 : 0;
    else if (k === 'farr') m.farRadius = Number(raw);
  }
  // 显式传进来的 opts 优先（测试注入口）
  const o = opts.build || opts;
  if (Number.isFinite(Number(o.phase))) m.phase = Number(o.phase);
  if (o.farSilhouette !== undefined) m.farSilhouette = Number(o.farSilhouette) ? 1 : 0;
  if (Number.isFinite(Number(o.farRadius))) m.farRadius = Number(o.farRadius);
  return m;
}

/**
 * 每栋立面的**水平相位**（米，落在 [0, 一个开间) 内，开间 = TILE.w/4 = 4m）。
 *
 * 为什么要有：4 档材质各只有 1 张 512² 立面贴图铺 886 栋楼 ⇒ 同材质的楼上
 * 窗户**逐格对齐**，"过于重复"的头号来源。按种子给一个 0~1 开间的相位就把这条格线打散了。
 *
 * 🔴 只动 U（开间方向），**不动 V**：竖直方向要对齐地面与层线，动了 V 楼层数就跟贴图对不上。
 * 哈希单独一条流取（`rngOf(b.seed)` 的主随机流一个数都不多消费）⇒ 楼体其它几何逐字节不变。
 */
export function facadePhase(seed, scale = 1) {
  const h = hashSeed('uphase', seed) >>> 0;
  return ((h % 4096) / 4096) * (TILE.w / 4) * scale;
}

// ── 可增长顶点缓冲 ───────────────────────────────────────────────────────────
class Buf {
  constructor(cap = 4096) {
    this.cap = cap; this.n = 0; this.ni = 0;
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Float32Array(cap * 3);
    this.idx = new Uint32Array(cap * 2);
  }
  grow() {
    const c = this.cap * 2;
    const g = (a, k) => { const b = new Float32Array(c * k); b.set(a); return b; };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 3); this.uv = g(this.uv, 2); this.col = g(this.col, 3);
    const ix = new Uint32Array(c * 2); ix.set(this.idx); this.idx = ix;
    this.cap = c;
  }
  vert(x, y, z, nx, ny, nz, u, v, r, g2, b) {
    if (this.n >= this.cap) this.grow();
    const i = this.n * 3, j = this.n * 2;
    this.pos[i] = x; this.pos[i + 1] = y; this.pos[i + 2] = z;
    this.nrm[i] = nx; this.nrm[i + 1] = ny; this.nrm[i + 2] = nz;
    this.uv[j] = u; this.uv[j + 1] = v;
    this.col[i] = r; this.col[i + 1] = g2; this.col[i + 2] = b;
    return this.n++;
  }
  _room(k) {
    if (this.ni + k > this.idx.length) {
      const ix = new Uint32Array(this.idx.length * 2); ix.set(this.idx); this.idx = ix;
    }
  }
  tri(a, b, c) { this._room(3); this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c; }
  /** 两个三角形，a/b/c/d = 顶点索引（逆时针 = 正面） */
  face(a, b, c, d) { this._room(6); this.tri(a, b, c); this.tri(a, c, d); }
  get triangles() { return this.ni / 3; }
  get vertices() { return this.n; }
  empty() { return this.n === 0; }
  finish() {
    return {
      position: this.pos.subarray(0, this.n * 3),
      normal: this.nrm.subarray(0, this.n * 3),
      uv: this.uv.subarray(0, this.n * 2),
      color: this.col.subarray(0, this.n * 3),
      index: this.idx.subarray(0, this.ni),
      vertexCount: this.n, triangleCount: this.ni / 3,
    };
  }
}

const nrm3 = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };

/**
 * 加一个四边形（顶点世界坐标 + UV + 顶点色）。
 * `expect` 是**期望法线**：算出来的法线若与它反向就把绕序翻过来 ——
 * 手写绕序在四个面上很容易错一个，翻一次比事后对着黑面找半天划算。
 */
function addQuad(B, p, uv, col, expect) {
  let n = nrm3([
    (p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]),
    (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]),
    (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]),
  ]);
  let order = [0, 1, 2, 3];
  if (expect && (n[0] * expect[0] + n[1] * expect[1] + n[2] * expect[2]) < 0) {
    order = [3, 2, 1, 0];
    n = [-n[0], -n[1], -n[2]];
  }
  const ids = [];
  for (const k of order) ids.push(B.vert(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], uv[k][0], uv[k][1], col[0], col[1], col[2]));
  B.face(ids[0], ids[1], ids[2], ids[3]);
}

/** 轴对齐盒子（世界坐标，不旋转）—— 屋顶设备/女儿墙/阳台板都用它 */
function addBox(B, x0, y0, z0, x1, y1, z1, uvRef, col) {
  const uvs = [uvRef, [uvRef[0] + 0.25, uvRef[1]], [uvRef[0] + 0.25, uvRef[1] + 0.25], [uvRef[0], uvRef[1] + 0.25]];
  const A = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]];
  const Bp = [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  addQuad(B, A, uvs, col, [0, 0, -1]);
  addQuad(B, Bp, uvs, col, [0, 0, 1]);
  addQuad(B, [A[0], Bp[0], Bp[3], A[3]], uvs, col, [-1, 0, 0]);
  addQuad(B, [A[1], Bp[1], Bp[2], A[2]], uvs, col, [1, 0, 0]);
  addQuad(B, [A[3], Bp[3], Bp[2], A[2]], uvs, col, [0, 1, 0]);
  addQuad(B, [A[0], Bp[0], Bp[1], A[1]], uvs, col, [0, -1, 0]);
}

/** 旋转盒子（跟着楼转）—— 挑檐/围墙用它，轴对齐盒在旋转楼上会露角 */
function addRotBox(B, cx, cz, cos, sin, w, d, y0, y1, uvRef, col) {
  const P = (lx, y, lz) => [cx + lx * cos - lz * sin, y, cz + lx * sin + lz * cos];
  const N = (lx, lz) => [lx * cos - lz * sin, 0, lx * sin + lz * cos];
  const hx = w / 2, hz = d / 2;
  const uvs = [uvRef, uvRef, uvRef, uvRef];
  addQuad(B, [P(-hx, y0, hz), P(hx, y0, hz), P(hx, y1, hz), P(-hx, y1, hz)], uvs, col, N(0, 1));
  addQuad(B, [P(hx, y0, -hz), P(-hx, y0, -hz), P(-hx, y1, -hz), P(hx, y1, -hz)], uvs, col, N(0, -1));
  addQuad(B, [P(hx, y0, hz), P(hx, y0, -hz), P(hx, y1, -hz), P(hx, y1, hz)], uvs, col, N(1, 0));
  addQuad(B, [P(-hx, y0, -hz), P(-hx, y0, hz), P(-hx, y1, hz), P(-hx, y1, -hz)], uvs, col, N(-1, 0));
  addQuad(B, [P(-hx, y1, -hz), P(hx, y1, -hz), P(hx, y1, hz), P(-hx, y1, hz)], uvs, col, [0, 1, 0]);
  addQuad(B, [P(-hx, y0, hz), P(hx, y0, hz), P(hx, y0, -hz), P(-hx, y0, -hz)], uvs, col, [0, -1, 0]);
}

/** 竖直圆柱（水箱/通风管）：n 段，世界坐标 */
function addCyl(B, cx, cz, y0, y1, r, n, uvRef, col) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
    const expect = [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)];
    addQuad(B, [[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]],
      [uvRef, uvRef, [uvRef[0] + 0.25, uvRef[1] + 0.6], [uvRef[0] + 0.25, uvRef[1] + 0.6]], col, expect);
  }
  const c = B.vert(cx, y1, cz, 0, 1, 0, uvRef[0], uvRef[1], col[0], col[1], col[2]);
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const id = B.vert(cx + Math.cos(a) * r, y1, cz + Math.sin(a) * r, 0, 1, 0, uvRef[0], uvRef[1], col[0], col[1], col[2]);
    if (prev >= 0) B.tri(c, prev, id);
    prev = id;
  }
}

/** 简化折线：丢掉太近的点与几乎共线的点（道路条带的顶点数直接决定三角形数） */
export function simplify(pts, minSeg = 2.5, maxRad = 0.10) {
  if (!pts || pts.length < 2) return pts || [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    if (Math.hypot(b.x - a.x, b.z - a.z) < minSeg) continue;
    const a1 = Math.atan2(b.z - a.z, b.x - a.x), a2 = Math.atan2(c.z - b.z, c.x - b.x);
    let d = Math.abs(a1 - a2); if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < maxRad) continue;
    out.push(b);
  }
  const last = pts[pts.length - 1];
  if (out.length > 1 && Math.hypot(last.x - out[out.length - 1].x, last.z - out[out.length - 1].z) < minSeg) out.pop();
  out.push(last);
  return out;
}

// ── 路网 → 条带 ──────────────────────────────────────────────────────────────
/** 车行道条带（+ 两侧人行道 / 路缘石）。返回段数供报告用 */
function emitRoads(city, base) {
  const As = base.asphalt, Aw = base.asphaltWide, Wk = base.sidewalk;
  const roadCol = [1, 1, 1], walkCol = [1, 1, 1], curbCol = shade(GROUND.curb, 1.06);
  let segs = 0;
  for (const r of city.roads) {
    const sp = roadSpec(r.cls);
    const pts = simplify(r.pts, 2.5, 0.10);
    if (pts.length < 2) continue;
    const hw = sp.w / 2;
    const wide = sp.w >= 9;
    const B = wide ? Aw : As;                      // 宽路用带标线的沥青贴图（u 恰好跨整个路宽）
    const tile = wide ? TILE.roadWide : TILE.road;
    const uAcross = wide ? 1 : sp.w / tile;
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      if (L < 0.6) continue;
      const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
      const ext = Math.min(hw * 0.6, 2.4);         // 两端外延，补掉拐角的缝
      const ax = a.x - ux * ext, az = a.z - uz * ext;
      const bx = b.x + ux * ext, bz = b.z + uz * ext;
      const v0 = s / tile, v1 = (s + L + ext * 2) / tile;
      addQuad(B, [
        [ax + nx * hw, 0, az + nz * hw], [bx + nx * hw, 0, bz + nz * hw],
        [bx - nx * hw, 0, bz - nz * hw], [ax - nx * hw, 0, az - nz * hw],
      ], [[0, v0], [uAcross, v0], [uAcross, v1], [0, v1]], roadCol, [0, 1, 0]);
      // 人行道（抬高 0.14m）+ 路缘石内侧立面 + 外侧立面
      const wIn = hw, wOut = hw + SIDEWALK_W, y = 0.14;
      for (const side of [1, -1]) {
        const iA = [ax + nx * wIn * side, az + nz * wIn * side], iB = [bx + nx * wIn * side, bz + nz * wIn * side];
        const oA = [ax + nx * wOut * side, az + nz * wOut * side], oB = [bx + nx * wOut * side, bz + nz * wOut * side];
        const uvA = [0, v0], uvB = [SIDEWALK_W / TILE.walk, v1];
        addQuad(Wk, [[iA[0], y, iA[1]], [iB[0], y, iB[1]], [oB[0], y, oB[1]], [oA[0], y, oA[1]]],
          [uvA, uvB, uvB, uvA], walkCol, [0, 1, 0]);
        addQuad(Wk, [[iA[0], 0, iA[1]], [iB[0], 0, iB[1]], [iB[0], y, iB[1]], [iA[0], y, iA[1]]],
          [uvA, uvB, uvB, uvA], curbCol, [-nx * side, 0, -nz * side]);
        addQuad(Wk, [[oB[0], 0, oB[1]], [oA[0], 0, oA[1]], [oA[0], y, oA[1]], [oB[0], y, oB[1]]],
          [uvB, uvA, uvA, uvB], curbCol, [nx * side, 0, nz * side]);
      }
      s += L + ext * 2;
      segs++;
    }
  }
  return segs;
}

/** 斑马线（city.crossings 已经算好位置/朝向） */
function emitCrossings(city, paint) {
  const white = toRgb(GROUND.paint);
  let n = 0;
  for (const c of city.crossings) {
    const ux = Math.cos(c.ang), uz = Math.sin(c.ang);
    const nx = -uz, nz = ux;
    const barW = 0.5, step = 1.05;
    const count = Math.max(2, Math.min(14, Math.floor((c.w - 1) / step)));
    for (let i = 0; i < count; i++) {
      const o = (i - (count - 1) / 2) * step;
      const px = c.x + nx * o, pz = c.z + nz * o;
      const hl = c.len / 2, hb = barW / 2;
      addQuad(paint, [
        [px - ux * hl - nx * hb, 0.02, pz - uz * hl - nz * hb],
        [px + ux * hl - nx * hb, 0.02, pz + uz * hl - nz * hb],
        [px + ux * hl + nx * hb, 0.02, pz + uz * hl + nz * hb],
        [px - ux * hl + nx * hb, 0.02, pz - uz * hl + nz * hb],
      ], [[0, 0], [1, 0], [1, 1], [0, 1]], white, [0, 1, 0]);
      n++;
    }
  }
  return n;
}

// ── 楼体 ─────────────────────────────────────────────────────────────────────
/**
 * 一栋楼 = 底商内凹段 + 上部墙体 +（裙楼 + 塔楼退台）+（侧翼）+ 屋面/坡顶 + 女儿墙 + 屋顶设备 + 阳台/飘窗。
 * 桶的归属决定 LOD：wall/shop/roof 常显；女儿墙/水箱/天线/坡顶进 mid 块；阳台/飘窗/挑檐/空地进 near 块。
 * 风格字段（floors/material/roof/balcony/bay/uScale/tint/shop）由 style.mjs 抽样给出。
 */
function emitBuilding(b, ctx) {
  const { base, prop, near, opts } = ctx;
  const rng = rngOf(b.seed);
  const tier = clamp(b.material | 0, 0, TIERS.length - 1);
  const wall = base['wall' + tier];
  const col = b.tint || [1, 1, 1];
  const uOff = rng.int(0, 3) * 0.25, vOff = rng.int(0, 3) * 0.25;
  // M1：每栋立面的水平相位（纹理单位：1 = 一整张贴图宽 = TILE.w 米）
  const uPhase = ctx.bm.phase > 0 ? (facadePhase(b.seed, ctx.bm.phase) / TILE.w) : 0;
  const uS = b.uScale || 1;                 // 窗距密度（>1 = 窗更密）
  const trim = shade(TIERS[tier].base, 0.86);
  const h = b.h;
  const wantShop = b.shop !== false;
  const shopH = wantShop ? Math.min(SHOP_H, Math.max(0, h - 0.8)) : 0;
  const recess = wantShop ? opts.shopRecess : 0;
  let cx = b.x, cz = b.z, cw = b.w, cd = b.d, cc = b.cos, cs = b.sin;

  const P = (lx, y, lz) => [cx + lx * cc - lz * cs, y, cz + lx * cs + lz * cc];
  const N = (lx, lz) => [lx * cc - lz * cs, 0, lx * cs + lz * cc];

  /** 一段墙体（四面），yRef = 这一段的窗户从哪个高度起算（保证层线连续）。
   *  📌 U 上叠了每栋的相位（M1）：**只有 U 变，V 一个字节都没动**。 */
  const band = (B, w, d, y0, y1, yRef, fill) => {
    const hx = w / 2, hz = d / 2;
    const v0 = (y0 - yRef) / TILE.h + vOff, v1 = (y1 - yRef) / TILE.h + vOff;
    const uW = (w / TILE.w) * uS, uD = (d / TILE.w) * uS;
    const u0 = uOff + uPhase;
    const c4 = [[u0, v0], [u0 + uD, v0], [u0 + uD, v1], [u0, v1]];
    const cW = [[u0, v0], [u0 + uW, v0], [u0 + uW, v1], [u0, v1]];
    addQuad(B, [P(-hx, y0, hz), P(hx, y0, hz), P(hx, y1, hz), P(-hx, y1, hz)], cW, fill, N(0, 1));
    addQuad(B, [P(hx, y0, -hz), P(-hx, y0, -hz), P(-hx, y1, -hz), P(hx, y1, -hz)], cW, fill, N(0, -1));
    addQuad(B, [P(hx, y0, hz), P(hx, y0, -hz), P(hx, y1, -hz), P(hx, y1, hz)], c4, fill, N(1, 0));
    addQuad(B, [P(-hx, y0, -hz), P(-hx, y0, hz), P(-hx, y1, hz), P(-hx, y1, -hz)], c4, fill, N(-1, 0));
  };
  /** 水平屋面（贴屋面贴图） */
  const cap = (B, w, d, y, fill) => {
    const hx = w / 2, hz = d / 2;
    const u = (w / TILE.roof) + uOff, v = (d / TILE.roof) + vOff;
    addQuad(B, [P(-hx, y, -hz), P(hx, y, -hz), P(hx, y, hz), P(-hx, y, hz)],
      [[uOff, vOff], [u, vOff], [u, v], [uOff, v]], fill, [0, 1, 0]);
  };
  /** 女儿墙（四面墙 + 压顶） */
  const parapet = (B, w, d, y, c) => {
    const t = 0.34, ph = 1.0;
    const hx = w / 2, hz = d / 2;
    const uv = (m) => [[0, 0], [m / 4, 0], [m / 4, 1], [0, 1]];
    addQuad(B, [P(-hx, y, hz), P(hx, y, hz), P(hx, y + ph, hz), P(-hx, y + ph, hz)], uv(w), c, N(0, 1));
    addQuad(B, [P(hx, y, -hz), P(-hx, y, -hz), P(-hx, y + ph, -hz), P(hx, y + ph, -hz)], uv(w), c, N(0, -1));
    addQuad(B, [P(hx, y, hz), P(hx, y, -hz), P(hx, y + ph, -hz), P(hx, y + ph, hz)], uv(d), c, N(1, 0));
    addQuad(B, [P(-hx, y, -hz), P(-hx, y, hz), P(-hx, y + ph, hz), P(-hx, y + ph, -hz)], uv(d), c, N(-1, 0));
    const top = shade(c, 1.06);
    const hx2 = hx - t, hz2 = hz - t, u2 = [[0, 0], [w / 4, 0], [w / 4, t / 4], [0, t / 4]], u3 = [[0, 0], [d / 4, 0], [d / 4, t / 4], [0, t / 4]];
    addQuad(B, [P(-hx, y + ph, hz), P(hx, y + ph, hz), P(hx2, y + ph, hz2), P(-hx2, y + ph, hz2)], u2, top, [0, 1, 0]);
    addQuad(B, [P(hx, y + ph, -hz), P(-hx, y + ph, -hz), P(-hx2, y + ph, -hz2), P(hx2, y + ph, -hz2)], u2, top, [0, 1, 0]);
    addQuad(B, [P(hx, y + ph, hz), P(hx, y + ph, -hz), P(hx2, y + ph, -hz2), P(hx2, y + ph, hz2)], u3, top, [0, 1, 0]);
    addQuad(B, [P(-hx, y + ph, -hz), P(-hx, y + ph, hz), P(-hx2, y + ph, hz2), P(-hx2, y + ph, -hz2)], u3, top, [0, 1, 0]);
  };
  /** 四坡顶：出檐 → 屋脊（低层老城用，天际线立刻不一样） */
  const hip = (B, w, d, y0, rise) => {
    const ov = 0.45;
    const W = w / 2 + ov, D = d / 2 + ov;
    const alongW = w >= d;
    const rl = Math.max(0.6, Math.abs(W - D));
    const rx = alongW ? rl : 0, rz = alongW ? 0 : rl;
    const c = [shade(GROUND.brick, 0.95), shade(GROUND.brick, 0.82)];
    const e = [P(-W, y0, D), P(W, y0, D), P(W, y0, -D), P(-W, y0, -D)];
    const R0 = P(-rx, y0 + rise, -rz), R1 = P(rx, y0 + rise, rz);
    const up = (n2) => nrm3(n2);
    const nZ = up(alongW ? [0, 0.6, 1] : [1, 0.6, 0]);
    if (alongW) {
      addQuad(B, [e[0], e[1], R1, R0], [[0, 0], [w / 4, 0], [w / 4, 1], [0, 1]], c[0], [0, 0.6, 1]);
      addQuad(B, [e[2], e[3], R0, R1], [[0, 0], [w / 4, 0], [w / 4, 1], [0, 1]], c[0], [0, 0.6, -1]);
    } else {
      addQuad(B, [e[1], e[2], R1, R0], [[0, 0], [d / 4, 0], [d / 4, 1], [0, 1]], c[0], [1, 0.6, 0]);
      addQuad(B, [e[3], e[0], R0, R1], [[0, 0], [d / 4, 0], [d / 4, 1], [0, 1]], c[0], [-1, 0.6, 0]);
    }
    // 两端的三角坡面
    const tri = (a, b, r, expect) => {
      const n = nrm3([(b[1] - a[1]) * (r[2] - a[2]) - (b[2] - a[2]) * (r[1] - a[1]),
        (b[2] - a[2]) * (r[0] - a[0]) - (b[0] - a[0]) * (r[2] - a[2]),
        (b[0] - a[0]) * (r[1] - a[1]) - (b[1] - a[1]) * (r[0] - a[0])]);
      const flip = n[0] * expect[0] + n[1] * expect[1] + n[2] * expect[2] < 0;
      const nn = flip ? [-n[0], -n[1], -n[2]] : n;
      const [p0, p1, p2] = flip ? [r, b, a] : [a, b, r];
      const i0 = B.vert(p0[0], p0[1], p0[2], nn[0], nn[1], nn[2], 0, 0, c[1][0], c[1][1], c[1][2]);
      const i1 = B.vert(p1[0], p1[1], p1[2], nn[0], nn[1], nn[2], 1, 0, c[1][0], c[1][1], c[1][2]);
      const i2 = B.vert(p2[0], p2[1], p2[2], nn[0], nn[1], nn[2], 0.5, 1, c[1][0], c[1][1], c[1][2]);
      B.tri(i0, i1, i2);
    };
    if (alongW) {
      tri(e[1], e[2], R1, nZ);
      tri(e[3], e[0], R0, [-nZ[0], nZ[1], -nZ[2]]);
    } else {
      tri(e[0], e[1], R0, nZ);
      tri(e[2], e[3], R1, [-nZ[0], nZ[1], -nZ[2]]);
    }
    // 屋脊压顶
    const rc = shade(GROUND.roof, 1.15);
    addBox(B, cx - Math.abs(rx) - 0.3, y0 + rise - 0.16, cz - Math.abs(rz) - 0.3,
      cx + Math.abs(rx) + 0.3, y0 + rise + 0.06, cz + Math.abs(rz) + 0.3, [0.5, 0.5], rc);
  };

  /**
   * 远景轮廓①：女儿墙带（4 面 = 8 三角，进常显桶）。
   * **严格内缩在 mid 档真女儿墙的体积里**（真墙厚 0.34 / 高 1.0 ⇒ 这里内缩 0.30 / 高 0.72）：
   * 主人走近了、mid 分块显形时，真女儿墙正好把它挡在里面 —— 既不重复也不闪面。
   */
  const farRim = (B, w, d, y, c) => {
    const t = 0.30, ph = 0.72;
    const hx = Math.max(0.4, w / 2 - t), hz = Math.max(0.4, d / 2 - t);
    const uv = (m) => [[0, 0], [m / 4, 0], [m / 4, 1], [0, 1]];
    addQuad(B, [P(-hx, y, hz), P(hx, y, hz), P(hx, y + ph, hz), P(-hx, y + ph, hz)], uv(w), c, N(0, 1));
    addQuad(B, [P(hx, y, -hz), P(-hx, y, -hz), P(-hx, y + ph, -hz), P(hx, y + ph, -hz)], uv(w), c, N(0, -1));
    addQuad(B, [P(hx, y, hz), P(hx, y, -hz), P(hx, y + ph, -hz), P(hx, y + ph, hz)], uv(d), c, N(1, 0));
    addQuad(B, [P(-hx, y, -hz), P(-hx, y, hz), P(-hx, y + ph, hz), P(-hx, y + ph, -hz)], uv(d), c, N(-1, 0));
  };
  /**
   * 远景轮廓②：屋脊线（2 坡面 + 2 山墙 = 6 三角）。
   * 比 mid 档的真坡顶**矮一截、且不出檐**（真坡顶 rise ≥ 2.2、出檐 0.45）⇒ 同样躲在真体积里。
   */
  const farRidge = (B, w, d, y0) => {
    const inset = 0.5;
    const W = Math.max(0.5, w / 2 - inset), D = Math.max(0.5, d / 2 - inset);
    const rise = Math.min(2.0, Math.max(0.8, Math.min(w, d) * 0.16));
    const alongW = w >= d;
    const rl = Math.max(0.6, Math.abs(W - D));
    const rx = alongW ? rl : 0, rz = alongW ? 0 : rl;
    const c = [shade(GROUND.brick, 0.95), shade(GROUND.brick, 0.82)];
    const e = [P(-W, y0, D), P(W, y0, D), P(W, y0, -D), P(-W, y0, -D)];
    const R0 = P(-rx, y0 + rise, -rz), R1 = P(rx, y0 + rise, rz);
    const nZ = nrm3(alongW ? [0, 0.6, 1] : [1, 0.6, 0]);
    const uv = (m) => [[0, 0], [m / 4, 0], [m / 4, 1], [0, 1]];
    const tri = (a2, b2, r, expect) => {
      const n = nrm3([(b2[1] - a2[1]) * (r[2] - a2[2]) - (b2[2] - a2[2]) * (r[1] - a2[1]),
        (b2[2] - a2[2]) * (r[0] - a2[0]) - (b2[0] - a2[0]) * (r[2] - a2[2]),
        (b2[0] - a2[0]) * (r[1] - a2[1]) - (b2[1] - a2[1]) * (r[0] - a2[0])]);
      const flip = n[0] * expect[0] + n[1] * expect[1] + n[2] * expect[2] < 0;
      const nn = flip ? [-n[0], -n[1], -n[2]] : n;
      const [p0, p1, p2] = flip ? [r, b2, a2] : [a2, b2, r];
      B.tri(
        B.vert(p0[0], p0[1], p0[2], nn[0], nn[1], nn[2], 0, 0, c[1][0], c[1][1], c[1][2]),
        B.vert(p1[0], p1[1], p1[2], nn[0], nn[1], nn[2], 1, 0, c[1][0], c[1][1], c[1][2]),
        B.vert(p2[0], p2[1], p2[2], nn[0], nn[1], nn[2], 0.5, 1, c[1][0], c[1][1], c[1][2]));
    };
    if (alongW) {
      addQuad(B, [e[0], e[1], R1, R0], uv(w), c[0], [0, 0.6, 1]);
      addQuad(B, [e[2], e[3], R0, R1], uv(w), c[0], [0, 0.6, -1]);
      tri(e[1], e[2], R1, nZ);
      tri(e[3], e[0], R0, [-nZ[0], nZ[1], -nZ[2]]);
    } else {
      addQuad(B, [e[1], e[2], R1, R0], uv(d), c[0], [1, 0.6, 0]);
      addQuad(B, [e[3], e[0], R0, R1], uv(d), c[0], [-1, 0.6, 0]);
      tri(e[0], e[1], R0, nZ);
      tri(e[2], e[3], R1, [-nZ[0], nZ[1], -nZ[2]]);
    }
  };

  // ① 底商（内凹）+ 上部墙体
  const bodyTop = b.podium ? b.podium.h : h;
  if (wantShop && h - shopH > 0.6) {
    band(base.shop, cw - recess * 2, cd - recess * 2, 0, shopH, 0, col);
    band(wall, cw, cd, shopH, bodyTop, shopH, col);
  } else {
    band(wall, cw, cd, 0, bodyTop, 0, col);
  }
  let topW = cw, topD = cd, topY = bodyTop, topC = cx, topZ = cz;
  if (h - Math.max(shopH, 0) > 0.6 && !b.podium) cap(base.roof, cw, cd, topY, col);
  const pcol = trim;

  // ② 裙楼女儿墙
  if (b.podium) parapet(prop, cw, cd, topY, pcol);
  // ③ 塔楼（退台）
  if (b.podium && b.tower) {
    const t = b.tower;
    const tx = b.x + (t.ox || 0) * b.cos - (t.oz || 0) * b.sin;
    const tz = b.z + (t.ox || 0) * b.sin + (t.oz || 0) * b.cos;
    cx = tx; cz = tz; cw = t.w; cd = t.d;
    band(wall, t.w, t.d, b.podium.h, h, shopH, col);
    cap(base.roof, t.w, t.d, h, col);
    topW = t.w; topD = t.d; topY = h; topC = tx; topZ = tz;
  }
  // ④ 退台（setback）：顶上两层往里收一圈，退出来的平台是空中花园
  if (b.roof === 'setback' && !b.podium && h > 16) {
    const upH = 2 * 3.3, cut = 1.7, yT = h - upH;
    cx = b.x; cz = b.z;
    cap(base.roof, cw, cd, yT, col);
    parapet(prop, cw, cd, yT, pcol);
    const uw = cw - cut * 2, ud = cd - cut * 2;
    band(wall, uw, ud, yT, h, yT, col);
    cap(base.roof, uw, ud, h, col);
    topW = uw; topD = ud; topY = h; topC = b.x; topZ = b.z;
  }
  // ⑤ 屋顶处理
  cx = topC; cz = topZ; cw = topW; cd = topD;
  if (b.roof === 'pitched') {
    hip(prop, topW, topD, topY, Math.min(6.5, Math.max(2.2, Math.min(topW, topD) * 0.34)));
  } else {
    parapet(prop, topW, topD, topY, pcol);
    roofProps(prop, { x: topC, z: topZ, cos: b.cos, sin: b.sin }, topW * 0.62, topD * 0.62, topY, rng, b.roof);
  }
  // ⑤b 远景轮廓（M3）：>farR 的楼，女儿墙/坡顶/水箱全在 mid 档里 —— 那个距离上看不见，
  //     于是往**常显桶**补一圈低多边形轮廓（女儿墙带 8 三角 / 屋脊线 6 三角），天际线才有层次。
  //     近档已有的东西**一个都不重复发**：这里只发"内缩在真体积里"的那一圈，走近了它就被真细节盖住。
  if (ctx.far && ctx.bm.farSilhouette) {
    if (b.roof === 'pitched') { farRidge(base.roof, topW, topD, topY); ctx.far.tris += 6; }
    else { farRim(base.roof, topW, topD, topY, pcol); ctx.far.tris += 8; }
    ctx.far.buildings++;
  }
  // ⑥ 侧翼
  if (b.wing) {
    const wg = b.wing;
    cx = wg.x; cz = wg.z; cw = wg.w; cd = wg.d; cc = wg.cos; cs = wg.sin;
    band(base['wall' + clamp(wg.material | 0, 0, TIERS.length - 1)], wg.w, wg.d, 0, wg.h, 0, col);
    cap(base.roof, wg.w, wg.d, wg.h, col);
    parapet(prop, wg.w, wg.d, wg.h, pcol);
  }
  cx = b.x; cz = b.z; cc = b.cos; cs = b.sin;
  // ⑦ 近景：底商挑檐 + 阳台排 / 飘窗
  if (wantShop && h - shopH > 0.6) {
    addRotBox(near, b.x, b.z, b.cos, b.sin, b.w, b.d, shopH, shopH + 0.28, [uOff, vOff], shade(GROUND.curb, 0.95));
  }
  const floors = b.floors | 0;
  const floorH = (h - Math.max(shopH, 0) - 1.4) / Math.max(1, floors - 1);
  const along = b.w >= b.d;
  if (b.balcony && floors >= 3 && floors <= 18) {
    const depth = 0.85, thick = 0.16, railH = 0.95;
    const bc = shade(GROUND.curb, rng.range(0.92, 1.04));
    const ca = Math.abs(cc), sa = Math.abs(cs);
    for (let f = 1; f < floors; f++) {
      const y = Math.max(shopH, 0) + (f - 0.5) * floorH;
      if (y + 1.5 > h) break;
      for (const side of [1, -1]) {
        if (side < 0 && rng.chance(0.5)) continue;
        const lx = along ? 0 : side * (cw / 2), lz = along ? side * (cd / 2) : 0;
        const ox = along ? 0 : side * (depth / 2), oz = along ? side * (depth / 2) : 0;
        const px = cx + (lx + ox) * cc - (lz + oz) * cs, pz = cz + (lx + ox) * cs + (lz + oz) * cc;
        const sw2 = along ? cw * 0.86 : depth, sd2 = along ? depth : cd * 0.86;
        const bw2 = sw2 * ca + sd2 * sa, bd2 = sw2 * sa + sd2 * ca;
        addBox(near, px - bw2 / 2, y, pz - bd2 / 2, px + bw2 / 2, y + thick, pz + bd2 / 2, [uOff, vOff], bc);
        const rxx = along ? 0 : side * (depth - 0.07), rzz = along ? side * (depth - 0.07) : 0;
        const qx = cx + (lx + rxx) * cc - (lz + rzz) * cs, qz = cz + (lx + rxx) * cs + (lz + rzz) * cc;
        const rw = along ? sw2 : 0.12, rd = along ? 0.12 : sd2;
        const qw = rw * ca + rd * sa, qd = rw * sa + rd * ca;
        addBox(near, qx - qw / 2, y + thick, qz - qd / 2, qx + qw / 2, y + thick + railH, qz + qd / 2, [uOff, vOff], shade(bc, 0.92));
      }
    }
  } else if (b.bay > 0 && floors >= 3 && floors <= 16) {
    // 飘窗：每层每开间凸出去一个小盒子（比阳台轻，住宅味道足）
    const bc = shade(GROUND.curb, 1.02);
    const span = along ? cw : cd;
    const nb = Math.max(1, Math.min(3, Math.floor(span / 5.5)));
    const ca = Math.abs(cc), sa = Math.abs(cs);
    for (let f = 1; f < floors; f++) {
      const y = Math.max(shopH, 0) + (f - 0.5) * floorH;
      if (y + 1.6 > h) break;
      for (let k = 0; k < nb; k++) {
        const t0 = (k + 0.5) / nb - 0.5;
        const side = rng.chance(0.5) ? 1 : -1;
        const lx = along ? t0 * cw : side * (cw / 2);
        const lz = along ? side * (cd / 2) : t0 * cd;
        const bwd = 2.2, bdp = b.bay;
        const ox = along ? 0 : side * bdp / 2, oz = along ? side * bdp / 2 : 0;
        const px = cx + (lx + ox) * cc - (lz + oz) * cs, pz = cz + (lx + ox) * cs + (lz + oz) * cc;
        const sw2 = along ? bwd : bdp, sd2 = along ? bdp : bwd;
        const bw2 = sw2 * ca + sd2 * sa, bd2 = sw2 * sa + sd2 * ca;
        addBox(near, px - bw2 / 2, y, pz - bd2 / 2, px + bw2 / 2, y + 1.5, pz + bd2 / 2, [uOff, vOff], bc);
      }
    }
  }
}

/** 空地/停车场：铺装 + 车位划线 + 几辆车 + 围墙（街面不全是一排排盒子） */
function emitVacantLot(b, ctx) {
  const { base, near } = ctx;
  const rng = rngOf(b.seed);
  const w = b.w, d = b.d;
  const hx = w / 2, hz = d / 2;
  const P = (lx, y, lz) => [b.x + lx * b.cos - lz * b.sin, y, b.z + lx * b.sin + lz * b.cos];
  addQuad(base.sidewalk, [P(-hx, 0.06, -hz), P(hx, 0.06, -hz), P(hx, 0.06, hz), P(-hx, 0.06, hz)],
    [[0, 0], [w / TILE.walk, 0], [w / TILE.walk, d / TILE.walk], [0, d / TILE.walk]], shade(GROUND.sidewalk, 0.82), [0, 1, 0]);
  const rows = Math.max(1, Math.min(3, Math.round(hz / 3)));
  const n = Math.max(2, Math.min(6, Math.round(w / 2.6)));
  for (let r = 0; r < rows; r++) {
    const z = -hz + (r + 0.5) * (d / rows);
    for (let i = 0; i <= n; i++) {
      const x = -hx + (i / n) * w;
      addQuad(base.paint, [P(x - 0.06, 0.08, z - 1.2), P(x + 0.06, 0.08, z - 1.2), P(x + 0.06, 0.08, z + 1.2), P(x - 0.06, 0.08, z + 1.2)],
        [[0, 0], [1, 0], [1, 1], [0, 1]], toRgb(GROUND.paint), [0, 1, 0]);
    }
    const cars = rng.int(1, n);
    for (let c = 0; c < cars; c++) {
      if (rng.chance(0.4)) continue;
      const x = -hx + ((c + 0.5) / n) * w;
      const cc2 = rng.pick([[0.72, 0.74, 0.78], [0.55, 0.16, 0.14], [0.16, 0.22, 0.3], [0.85, 0.85, 0.84], [0.2, 0.38, 0.3]]);
      const px = b.x + x * b.cos - z * b.sin, pz = b.z + x * b.sin + z * b.cos;
      addBox(near, px - 2.15, 0.3, pz - 0.85, px + 2.15, 1.05, pz + 0.85, [0.2, 0.2], cc2);
      addBox(near, px - 1.15, 1.05, pz - 0.78, px + 0.75, 1.62, pz + 0.78, [0.3, 0.3], shade(cc2, 0.85));
    }
  }
  addRotBox(near, b.x, b.z, b.cos, b.sin, w + 0.5, d + 0.5, 0, 1.1, [0.1, 0.1], shade(GROUND.curb, 0.94));
}

/** 屋顶设备：水箱 / 空调机组 / 天线 / 通风管 / 楼梯间（都进 mid 块） */
function roofProps(B, b, w, d, y, rng, roof) {
  const metal = toRgb(GROUND.metal), rust = toRgb(GROUND.rust), dark = shade(GROUND.metal, 0.72);
  const place = (fn) => {
    const ox = rng.range(-0.5, 0.5) * w, oz = rng.range(-0.5, 0.5) * d;
    fn(b.x + ox * b.cos - oz * b.sin, b.z + ox * b.sin + oz * b.cos);
  };
  const kind = roof === 'tank' ? 'tank' : roof === 'mech' ? 'mech' : roof === 'antenna' ? 'antenna' : 'flat';
  if (kind === 'tank' && w > 3.2) {
    place((x, z) => {
      const r = clamp(Math.min(w, d) * 0.22, 0.9, 2.4), hh = rng.range(1.8, 3.1);
      addBox(B, x - r * 1.15, y, z - r * 1.15, x + r * 1.15, y + 0.5, z + r * 1.15, [0.1, 0.1], dark);
      addCyl(B, x, z, y + 0.5, y + 0.5 + hh, r, 10, [0.2, 0.2], rust);
    });
  } else if (kind === 'mech' || kind === 'antenna') {
    const n = kind === 'antenna' ? rng.int(1, 3) : rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      place((x, z) => {
        const bw = rng.range(1.3, 2.6), bd = rng.range(1.1, 2.2), bh = rng.range(0.8, 1.8);
        addBox(B, x - bw / 2, y, z - bd / 2, x + bw / 2, y + bh, z + bd / 2, [0.3, 0.3], metal);
        if (rng.chance(0.5)) addCyl(B, x, z, y + bh, y + bh + rng.range(0.5, 1.1), 0.28, 6, [0.4, 0.4], dark);
      });
    }
  } else {
    place((x, z) => {
      const bw = rng.range(1.1, 2.0), bh = rng.range(0.7, 1.2);
      addBox(B, x - bw / 2, y, z - bw / 2, x + bw / 2, y + bh, z + bw / 2, [0.3, 0.3], metal);
    });
  }
  if ((kind === 'antenna' || y > 34) && rng.chance(kind === 'antenna' ? 0.95 : 0.5)) {
    place((x, z) => {
      const hh = rng.range(3.5, 10);
      addBox(B, x - 0.09, y, z - 0.09, x + 0.09, y + hh, z + 0.09, [0.5, 0.5], dark);
      addBox(B, x - 0.6, y + hh * 0.72, z - 0.05, x + 0.6, y + hh * 0.72 + 0.1, z + 0.05, [0.5, 0.5], dark);
      addBox(B, x - 0.5, y + hh * 0.88, z - 0.05, x + 0.5, y + hh * 0.88 + 0.1, z + 0.05, [0.5, 0.5], dark);
      addBox(B, x - 0.18, y + hh, z - 0.18, x + 0.18, y + hh + 0.36, z + 0.18, [0.5, 0.5], [1.0, 0.25, 0.2]);
    });
  }
  if (w > 6 && rng.chance(0.5)) {
    place((x, z) => {
      const bw = rng.range(2.2, 3.4), bd = rng.range(2.0, 3.0), bh = rng.range(2.2, 3.0);
      addBox(B, x - bw / 2, y, z - bd / 2, x + bw / 2, y + bh, z + bd / 2, [0.15, 0.15], shade(GROUND.curb, 0.9));
    });
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────
/**
 * @param {object} city   city.mjs 的输出（roads/blocks/trees/manholes/crossings）
 * @param {object} opts   { styled, lodNear, lodMid, cell, ... }
 *   styled = style.mjs 的输出 { buildings, vacant }；不传就直接用 city.buildings
 */
export function buildWorld(city, optsIn = {}) {
  const opts = { ...DEFAULT_OPTS, ...optsIn };
  const bm = resolveBuildModel(opts, opts.search);
  const farR = bm.farRadius !== null ? bm.farRadius : opts.lodMid;
  const far = { buildings: 0, tris: 0 };
  const buildings = (opts.styled && opts.styled.buildings) || city.buildings;
  const vacantLots = (opts.styled && opts.styled.vacant) || [];
  const base = {
    wall0: new Buf(), wall1: new Buf(), wall2: new Buf(), wall3: new Buf(),
    shop: new Buf(), roof: new Buf(), asphalt: new Buf(), asphaltWide: new Buf(),
    sidewalk: new Buf(), paint: new Buf(), ground: new Buf(),
  };
  const prop = new Buf();

  // ① 地面：**按街区铺**（不是一张铺满屏的大平面 —— 那是纯亏的填充率）
  //    街区矩形比真实空地略大 2m，压到路面下面一点点（y=-0.02），接缝就看不见了
  for (const blk of city.blocks || []) {
    if (!(blk.w > 0) || !(blk.d > 0)) continue;
    const x0 = blk.x0 - 2, z0 = blk.z0 - 2, x1 = blk.x0 + blk.w + 2, z1 = blk.z0 + blk.d + 2;
    addQuad(base.ground, [[x0, -0.02, z0], [x1, -0.02, z0], [x1, -0.02, z1], [x0, -0.02, z1]],
      [[0, 0], [(x1 - x0) / TILE.ground, 0], [(x1 - x0) / TILE.ground, (z1 - z0) / TILE.ground], [0, (z1 - z0) / TILE.ground]],
      [1, 1, 1], [0, 1, 0]);
  }
  // 远处：一圈环带接到地平线（近处交给街区地面 + 路面）
  const RR = city.radius || 1000, R0 = RR * 1.05, R1 = RR * 3.0, SEG = 40;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
    addQuad(base.ground, [
      [Math.cos(a0) * R0, -0.06, Math.sin(a0) * R0], [Math.cos(a0) * R1, -0.06, Math.sin(a0) * R1],
      [Math.cos(a1) * R1, -0.06, Math.sin(a1) * R1], [Math.cos(a1) * R0, -0.06, Math.sin(a1) * R0],
    ], [[0, 0], [(R1 - R0) / TILE.ground, 0], [(R1 - R0) / TILE.ground, 1], [0, 1]], shade(GROUND.soil, 0.92), [0, 1, 0]);
  }

  // ② 细节分块：每格一个 mid / near 几何体（LOD 靠"整格显隐"，不重建几何）
  const cell = opts.cell;
  const chunks = new Map();
  const chunkOf = (x, z) => {
    const i = Math.floor(x / cell), j = Math.floor(z / cell);
    const k = i + '_' + j;
    let c = chunks.get(k);
    if (!c) {
      c = { key: k, i, j, cx: (i + 0.5) * cell, cz: (j + 0.5) * cell, mid: new Buf(2048), near: new Buf(2048), buildings: 0 };
      chunks.set(k, c);
    }
    return c;
  };

  // ③ 楼 + 空地 + 路 + 斑马线
  let buildingCount = 0;
  const byDistrict = {};
  for (const b of buildings) {
    if (!(b.h > 1) || !(b.w > 1)) continue;
    const ch = chunkOf(b.x, b.z);
    ch.buildings++;
    const isFar = bm.farSilhouette > 0 && Math.hypot(b.x, b.z) >= farR;
    emitBuilding(b, { base, prop: ch.mid, near: ch.near, opts, bm, far: isFar ? far : null });
    buildingCount++;
    if (b.district) byDistrict[b.district] = (byDistrict[b.district] || 0) + 1;
  }
  for (const v of vacantLots) {
    const ch = chunkOf(v.x, v.z);
    ch.buildings++;
    emitVacantLot(v, { base, near: ch.near, opts });
    buildingCount++;
  }
  const segs = emitRoads(city, base);
  const bars = emitCrossings(city, base.paint);

  // ④ 实例化数据（树 / 路灯 / 井盖）
  const trees = [], lamps = [], manholes = [];
  for (const t of city.trees) {
    const hh = hashSeed(t.x | 0, t.z | 0);
    trees.push({
      x: t.x, z: t.z, h: t.h, r: t.r, rot: (hh % 628) / 100,
      species: hh % 100 < 62 ? 0 : 1,                       // 0 = 阔叶球冠，1 = 针叶锥冠
      tint: 0.82 + ((hh >> 7) % 100) / 100 * 0.42,
    });
  }
  for (const m of city.manholes) manholes.push({ x: m.x, z: m.z, r: m.r });
  for (const r of city.roads) {
    const sp = roadSpec(r.cls);
    if (!sp.drive || sp.w < 5) continue;
    const pts = simplify(r.pts, 8, 0.35);
    const off = sp.w / 2 + SIDEWALK_W - 0.5;
    let flip = 1;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L < 1) continue;
      const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
      for (let d = 17; d < L; d += 34) {
        const x = a.x + ux * d + nx * off * flip, z = a.z + uz * d + nz * off * flip;
        if (Math.hypot(x, z) > (city.radius || 1000) * 1.02) continue;
        lamps.push({ x, z, rot: Math.atan2(-nx * flip, -nz * flip) });
        flip = -flip;
      }
    }
  }

  // ⑤ 收尾：空桶去掉（省一次 draw call），统计三角形
  const outBase = {};
  let tris = 0, verts = 0;
  const byBucket = {};
  for (const [k, B] of Object.entries(base)) {
    if (B.empty()) continue;
    outBase[k] = B.finish();
    tris += outBase[k].triangleCount; verts += outBase[k].vertexCount;
    byBucket[k] = outBase[k].triangleCount;
  }
  const chunkOut = [];
  let midTris = 0, nearTris = 0;
  for (const c of chunks.values()) {
    const mid = c.mid.empty() ? null : c.mid.finish();
    const near = c.near.empty() ? null : c.near.finish();
    if (mid) { midTris += mid.triangleCount; byBucket['chunk.mid'] = (byBucket['chunk.mid'] || 0) + mid.triangleCount; }
    if (near) { nearTris += near.triangleCount; byBucket['chunk.near'] = (byBucket['chunk.near'] || 0) + near.triangleCount; }
    chunkOut.push({ key: c.key, i: c.i, j: c.j, cx: c.cx, cz: c.cz, mid, near, buildings: c.buildings });
  }
  const manholeTris = manholes.length * 6;
  const treeTris = trees.reduce((s, t) => s + (t.species === 0 ? 36 : 28), 0);
  const lampTris = lamps.length * 34;
  return {
    base: outBase,
    chunks: chunkOut,
    instanced: { trees, lamps, manholes },
    stats: {
      buildings: buildingCount, roadSegments: segs, crosswalkBars: bars,
      tris, verts, midTris, nearTris,
      trisTotal: tris + midTris + nearTris + manholeTris + treeTris + lampTris,
      instancedTris: { trees: treeTris, lamps: lampTris, manholes: manholeTris },
      trees: trees.length, lamps: lamps.length, manholes: manholes.length,
      chunks: chunkOut.length, chunksWithBuildings: chunkOut.filter((c) => c.buildings > 0).length,
      byDistrict, byBucket,
      farSilhouette: { buildings: far.buildings, tris: far.tris, radius: farR },
      opts, build: bm,
    },
  };
}

export { Buf, addQuad, addBox, addRotBox, addCyl, TILE, SHOP_H, ACCENT };
