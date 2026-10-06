// util.mjs —— 纯工具：确定性随机 / 哈希 / 几何小函数。
// 这个文件**不碰 DOM**，所以 node 里能直接 import 跑自检（selftest.mjs）。

/** 32 位确定性伪随机（同一 seed ⇒ 同一座城；换 seed 就换一座城） */
export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串/数字混成 32 位种子 */
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** rng 小包装：range / int / pick / chance —— 写生成器时少打点字 */
export function rngOf(seed) {
  const r = mulberry32(seed >>> 0);
  return {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    chance: (p) => r() < p,
    pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))],
    sign: () => (r() < 0.5 ? -1 : 1),
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** 世界坐标：x = 东（米），z = 南（米），y = 上（米）。北 = -z */
export const M_PER_DEG_LAT = 111320;
export function metersPerDegLng(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** 经纬度 → 本地米（等距圆柱近似，1km 尺度完全够用） */
export function projectLL(lat, lng, lat0, lng0) {
  return { x: (lng - lng0) * metersPerDegLng(lat0), z: (lat0 - lat) * M_PER_DEG_LAT };
}

/** 点到线段的距离平方（px,pz 到 a-b） */
export function distToSeg2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = clamp(t, 0, 1);
  const qx = ax + dx * t, qz = az + dz * t;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

/** Douglas-Peucker 简化的输入准备：去掉重复点 */
export function dedupe(pts, eps = 0.01) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > eps || Math.abs(q.z - p.z) > eps) out.push(p);
  }
  return out;
}

/** 折线长度（米） */
export function polylineLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}

/** 旋转矩形（建筑）用的坐标变换：本地 → 世界 */
export function localToWorld(b, lx, lz) {
  return { x: b.x + lx * b.cos - lz * b.sin, z: b.z + lx * b.sin + lz * b.cos };
}
/** 世界 → 本地 */
export function worldToLocal(b, dx, dz) {
  return { x: dx * b.cos + dz * b.sin, z: -dx * b.sin + dz * b.cos };
}

/** 点是否在旋转矩形内（含外扩 pad） */
export function inRotRect(b, px, pz, pad = 0) {
  const l = worldToLocal(b, px - b.x, pz - b.z);
  return Math.abs(l.x) <= b.w / 2 + pad && Math.abs(l.z) <= b.d / 2 + pad;
}

// ── 4×4 矩阵（列主序，跟 WebGL 一致）─────────────────────────────────────
export function m4identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
export function m4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
export function m4perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
export function m4lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let L = Math.hypot(zx, zy, zz) || 1; zx /= L; zy /= L; zz /= L;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  L = Math.hypot(xx, xy, xz) || 1; xx /= L; xy /= L; xz /= L;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ]);
}
export function m4ortho(l, r, b, t, n, f) {
  return new Float32Array([
    2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ]);
}
