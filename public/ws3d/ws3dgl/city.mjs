// city.mjs —— 程序化城市生成（纯逻辑，node 可测）。
//
// 思路（第一版）：
//   ① 街道骨架：真实 OSM 路网（有缓存就吃）＋ 程序正交路网补空白 —— 先把"哪里能盖楼"定下来；
//   ② 把路网（车行道 + 人行道 + 退让）栅格化成掩码，掩码的**连通空闲区**就是街区；
//   ③ 每个街区递归二分切成地块，地块内缩退出建筑占地；
//   ④ 每栋楼给：裙楼 + 塔楼退台、层数/材质/屋顶差异、屋顶设备。
// 一切由 seed 决定 ⇒ 同一 seed 同一座城，换 seed 换城（可复现，不是每帧乱变）。
import { rngOf, hashSeed, clamp, lerp, distToSeg2, dedupe, polylineLen, inRotRect } from './util.mjs';

/** 各类道路宽度（米，车行道）+ 是否参与街区切分 */
export const ROAD_SPEC = {
  motorway: { w: 15, drive: 1 }, motorway_link: { w: 7, drive: 1 },
  trunk: { w: 13, drive: 1 }, trunk_link: { w: 7, drive: 1 },
  primary: { w: 11, drive: 1 }, primary_link: { w: 6, drive: 1 },
  secondary: { w: 9, drive: 1 }, secondary_link: { w: 5.5, drive: 1 },
  tertiary: { w: 8, drive: 1 }, tertiary_link: { w: 5, drive: 1 },
  unclassified: { w: 6.5, drive: 1 }, residential: { w: 6, drive: 1 },
  living_street: { w: 5, drive: 1 }, service: { w: 4.5, drive: 1 },
  pedestrian: { w: 5, drive: 1 }, track: { w: 3.5, drive: 1 },
  // 下面这些只当"小路"，不切街区（否则人行道会把街区切碎）
  footway: { w: 2.2, drive: 0 }, path: { w: 1.8, drive: 0 }, steps: { w: 1.8, drive: 0 },
  cycleway: { w: 2.5, drive: 0 }, bridleway: { w: 2, drive: 0 },
};
export const SIDEWALK_W = 2.6;   // 人行道宽（米）
const ROAD_MARGIN = 1.2;         // 街区与路缘之间的净空
const CELL = 4;                  // 栅格边长（米）—— 3m 更细但生成慢一倍，4m 够用

export function roadSpec(cls) {
  return ROAD_SPEC[cls] || { w: 5, drive: 1 };
}

/** 生成一座城。opts: { lat, lng, radius, realRoads:[{cls,pts:[{x,z}]}], seedStr } */
export function buildCity(opts) {
  const radius = opts.radius || 1000;
  const seed = hashSeed(opts.seedStr || 'ws3dgl', opts.lat.toFixed(4), opts.lng.toFixed(4), radius);
  const rng = rngOf(seed);
  const half = radius * 1.12 + 30;
  const N = Math.ceil((half * 2) / CELL);
  const gx = (x) => Math.round((x + half) / CELL);
  const gz = (z) => Math.round((z + half) / CELL);
  const wx = (g) => g * CELL - half;

  // ── ① 路网：真实 + 程序补 ───────────────────────────────────────────────
  // 只留**贴着本盘**的真实路（缓存文件是大圆，远处那些既不参与切街区也白算）
  const reach = radius * 1.18;
  const realRoads = (opts.realRoads || [])
    .filter((r) => r && r.pts && r.pts.length >= 2)
    .filter((r) => r.pts.some((p) => Math.hypot(p.x, p.z) <= reach))
    .map((r) => ({ cls: r.cls, pts: r.pts, name: r.name, osmId: r.osmId }));
  const procRoads = proceduralRoads({ radius, half, realRoads, rng });

  // 真实路网覆盖图（用来判断程序路该不该补、以及报告"真数据占比"）
  const realCover = new Uint8Array(N * N);
  for (const r of realRoads) {
    const pad = roadSpec(r.cls).w / 2 + 12;
    rasterSegments(r.pts, pad, (g) => { realCover[g] = 1; }, gx, gz, N);
  }
  let realCells = 0;
  for (let i = 0; i < realCover.length; i++) realCells += realCover[i];

  // ── ② 街区掩码 ─────────────────────────────────────────────────────────
  const occ = new Uint8Array(N * N);
  const markRoad = (r) => {
    const sp = roadSpec(r.cls);
    const pad = sp.w / 2 + (sp.drive ? SIDEWALK_W : 0) + ROAD_MARGIN;
    rasterSegments(r.pts, pad, (g) => { occ[g] = 1; }, gx, gz, N);
  };
  for (const r of realRoads) if (roadSpec(r.cls).drive) markRoad(r);
  for (const r of procRoads) markRoad(r);

  const owner = new Int32Array(N * N);          // 格 → 街区号（街区内空地判归属用）
  const blocks = findBlocks(occ, N, half, radius, owner);
  for (const b of blocks) {
    b.seed = hashSeed(seed, b.gx0, b.gz0, b.cells.length);
  }

  // ── ③④ 地块切分 + 建筑 ─────────────────────────────────────────────────
  const allRoads = realRoads.concat(procRoads);
  // 净空守卫：落位时卡"楼到路中心线 ≥ 路面半宽 + 0.5m"。opts.clearance === false 时整段跳过
  // （自检要拿"改之前"的数对照，所以留了这个开关）。
  // legacy：把"落位约束"退回改之前那套（5 探针 + depth 4 + 不看归属），只为复现改之前的实测数。
  const legacy = opts.legacy === true;
  const guard = (opts.clearance === false || legacy) ? null : buildRoadIndex(allRoads);
  const scratch = [];
  const buildings = [];
  let rejected = 0, fitted = 0;
  for (const blk of blocks) {
    const brng = rngOf(blk.seed);
    const rects = splitRect({ x: wx(blk.gx0), z: wx(blk.gz0), w: (blk.gx1 - blk.gx0) * CELL, d: (blk.gz1 - blk.gz0) * CELL }, 0, brng,
      legacy ? 4 : MAX_SPLIT_DEPTH);
    for (const rc of rects) {
      if (!parcelUsable(rc, owner, blk.id, gx, gz, N, occ, legacy)) continue;
      const b = buildingFromParcel(rc, blk, brng, radius);
      if (!b) continue;
      // 栅格掩码是 4m 粗格 + 5 个探针 ⇒ 斜穿地块的窄路会漏；这里用**精确距离**再卡一遍
      if (guard) {
        const fit = fitToRoads(b, guard, scratch);
        if (!fit.ok) { rejected++; continue; }
        if (fit.steps) fitted++;
      }
      buildings.push(b);
    }
  }
  // 生成完整体校验 + 修正（楼间距主要靠这一步）
  const clearance = guard ? enforceClearance(buildings, guard) : null;

  // ── 行道树 / 井盖 / 斑马线 ──────────────────────────────────────────────
  const trees = placeTrees(allRoads, buildings, radius, rng);
  const manholes = placeManholes(allRoads, radius, rng);
  const crossings = placeCrossings(allRoads, radius);

  const lenOf = (arr) => arr.reduce((s, r) => s + polylineLen(r.pts), 0);
  const realLen = Math.round(lenOf(realRoads)), procLen = Math.round(lenOf(procRoads));
  return {
    radius, seed,
    roads: allRoads,
    realRoadCount: realRoads.length,
    procRoadCount: procRoads.length,
    realRoadLen: realLen,
    procRoadLen: procLen,
    realCoverPct: (realCells / (N * N)) * 100,
    blocks, buildings, trees, manholes, crossings,
    stats: {
      roads: allRoads.length, realRoads: realRoads.length, procRoads: procRoads.length,
      blocks: blocks.length, parcels: buildings.length, buildings: buildings.length,
      trees: trees.length, manholes: manholes.length, crossings: crossings.length,
      // 真路网里程占比（比"面积占比"好懂，也不受缓存圆大小影响）
      realLenShare: +((realLen / Math.max(1, realLen + procLen)) * 100).toFixed(1),
      realCoverPct: +((realCells / (N * N)) * 100).toFixed(1),
      realRoadLen: realLen, procRoadLen: procLen,
      // 净空这一关的账：落位时缩了几栋 / 打回几栋，生成后修了几栋
      clearance: clearance
        ? { roadIndexSegs: guard.count, fittedAtPlacement: fitted, rejectedAtPlacement: rejected, ...clearance }
        : { disabled: true },
    },
  };
}

/** 程序正交路网：只在"真实路网没覆盖"的地方补，避免和真路网打架 */
function proceduralRoads({ radius, half, realRoads, rng }) {
  const out = [];
  // 真路网的粗占位图（12m 格）：判断"这里已经有路了"变成 O(1) 查表
  const S = 12, N = Math.ceil((half * 2) / S);
  const cover = new Uint8Array(N * N);
  const gi = (v) => Math.round((v + half) / S);
  for (const r of realRoads) {
    const pad = roadSpec(r.cls).w / 2 + 26;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const x0 = gi(Math.min(a.x, b.x) - pad), x1 = gi(Math.max(a.x, b.x) + pad);
      const z0 = gi(Math.min(a.z, b.z) - pad), z1 = gi(Math.max(a.z, b.z) + pad);
      for (let z = Math.max(0, z0); z <= Math.min(N - 1, z1); z++) {
        for (let x = Math.max(0, x0); x <= Math.min(N - 1, x1); x++) {
          const cx = x * S - half, cz = z * S - half;
          if (distToSeg2(cx, cz, a.x, a.z, b.x, b.z) <= pad * pad) cover[z * N + x] = 1;
        }
      }
    }
  }
  const covered = (x, z) => {
    const j = gi(x), i = gi(z);
    if (i < 0 || j < 0 || i >= N || j >= N) return true;
    return cover[i * N + j] === 1;
  };
  const makeLine = (fixed, vertical, cls) => {
    const pts = [];
    const step = 55;
    for (let t = -half; t <= half; t += step) {
      const jitter = Math.sin((t + fixed) * 0.013) * 5 + rng.range(-4, 4);
      const u = t + jitter;
      pts.push(vertical ? { x: fixed, z: u } : { x: u, z: fixed });
    }
    // 掐掉出圆的、以及已被真实路网覆盖的段落
    const segs = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const inside = Math.hypot(p.x, p.z) < radius * 1.04;
      const cov = covered(p.x, p.z);
      if (inside && !cov) {
        if (!cur) cur = [p]; else cur.push(p);
      } else if (cur) { if (cur.length >= 2) segs.push(cur); cur = null; }
    }
    if (cur && cur.length >= 2) segs.push(cur);
    for (const s of segs) {
      if (s.length >= 2 && rng.next() > 0.14) out.push({ cls, pts: s, proc: true });
    }
  };
  let i = 0;
  for (let x = -half; x <= half; x += 118 + rng.range(-22, 22), i++) makeLine(x, true, i % 3 === 0 ? 'tertiary' : 'residential');
  i = 0;
  for (let z = -half; z <= half; z += 124 + rng.range(-22, 22), i++) makeLine(z, false, i % 3 === 0 ? 'secondary' : 'residential');
  return out;
}

/** 把折线按 pad 宽度刷进栅格（回调收到格号） */
function rasterSegments(pts, pad, cb, gx, gz, N) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const x0 = gx(Math.min(a.x, b.x) - pad), x1 = gx(Math.max(a.x, b.x) + pad);
    const z0 = gz(Math.min(a.z, b.z) - pad), z1 = gz(Math.max(a.z, b.z) + pad);
    for (let z = Math.max(0, z0); z <= Math.min(N - 1, z1); z++) {
      for (let x = Math.max(0, x0); x <= Math.min(N - 1, x1); x++) {
        const cx = x * CELL - (N * CELL) / 2, cz = z * CELL - (N * CELL) / 2;
        if (distToSeg2(cx, cz, a.x, a.z, b.x, b.z) <= pad * pad) cb(z * N + x);
      }
    }
  }
}

/** 空闲格连通域 = 街区（面积太小的丢弃）。
 *  owner：格 → 街区号（+1），给 parcelUsable 判"这块地到底属不属于我这个街区"。
 *  ⚠️ 为什么需要它：街区的**矩形 bbox** 会盖住别的连通域（斜长条街区的 bbox 能铺满全图、
 *  或者一个被路围住的院子是另一个连通域）——只看"格是空的"就会把别人家的地也盖楼，
 *  实测两栋楼直接重叠（楼间距 = 0）。 */
function findBlocks(occ, N, half, radius, owner) {
  const seen = new Uint8Array(N * N);
  const stack = new Int32Array(1 << 19);
  const blocks = [];
  const minCells = Math.ceil(420 / (CELL * CELL));
  for (let start = 0; start < occ.length; start++) {
    if (occ[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start; seen[start] = 1;
    const cells = [];
    let gx0 = N, gx1 = -1, gz0 = N, gz1 = -1;
    while (sp > 0) {
      const g = stack[--sp];
      cells.push(g);
      const x = g % N, z = (g - x) / N;
      if (x < gx0) gx0 = x; if (x > gx1) gx1 = x;
      if (z < gz0) gz0 = z; if (z > gz1) gz1 = z;
      if (x > 0 && !occ[g - 1] && !seen[g - 1]) { seen[g - 1] = 1; stack[sp++] = g - 1; }
      if (x < N - 1 && !occ[g + 1] && !seen[g + 1]) { seen[g + 1] = 1; stack[sp++] = g + 1; }
      if (z > 0 && !occ[g - N] && !seen[g - N]) { seen[g - N] = 1; stack[sp++] = g - N; }
      if (z < N - 1 && !occ[g + N] && !seen[g + N]) { seen[g + N] = 1; stack[sp++] = g + N; }
    }
    if (cells.length < minCells) continue;
    // 只保留圆心附近的街区（半径外的不用画）
    const cx = (gx0 + gx1) / 2 * CELL - half, cz = (gz0 + gz1) / 2 * CELL - half;
    if (Math.hypot(cx, cz) > radius * 1.1) continue;
    const id = blocks.length + 1;
    for (const g of cells) { seen[g] = 2; if (owner) owner[g] = id; }
    // 顺带给世界坐标下的矩形：渲染层要拿它铺"街区地面"（不然只能铺一张铺满屏的大平面，填充率吃亏）
    // ⚠️ findBlocks 是模块级函数，拿不到 buildCity 里的 wx() 闭包 ⇒ 这里自己算（原来写成 wx(gx0) 直接 ReferenceError）
    blocks.push({ id, gx0, gx1, gz0, gz1, cells, cx, cz,
      x0: gx0 * CELL - half, z0: gz0 * CELL - half,
      w: (gx1 - gx0) * CELL, d: (gz1 - gz0) * CELL });
  }
  return blocks;
}

/** 街区矩形递归二分 → 地块。
 *  ⚠️ 原来 depth 上限是 4：`occ` 掩码里那两个"大自由区"（连通域是斜的长条，
 *  但 bbox 铺满整张图）在 4 层之后仍然剩 200m+ 见方的地块 ⇒ 生成出 700×400m 的巨型板楼，
 *  横跨 primary 路（实测楼到路中心线最小距离 = 0m）。这里让 depth 放到 10，由
 *  `area < MIN_PARCEL` 说了算，巨型街区自然被切成正常地块。 */
const MAX_SPLIT_DEPTH = 10;
const MIN_PARCEL_AREA = 2300;
function splitRect(rc, depth, rng, maxDepth = MAX_SPLIT_DEPTH) {
  const area = rc.w * rc.d;
  const small = Math.min(rc.w, rc.d);
  if (depth >= maxDepth || area < MIN_PARCEL_AREA || small < 30) return [rc];
  const alongW = rc.w >= rc.d;
  const f = rng.range(0.36, 0.64);
  if (alongW) {
    return splitRect({ x: rc.x, z: rc.z, w: rc.w * f, d: rc.d }, depth + 1, rng, maxDepth)
      .concat(splitRect({ x: rc.x + rc.w * f, z: rc.z, w: rc.w * (1 - f), d: rc.d }, depth + 1, rng, maxDepth));
  }
  return splitRect({ x: rc.x, z: rc.z, w: rc.w, d: rc.d * f }, depth + 1, rng, maxDepth)
    .concat(splitRect({ x: rc.x, z: rc.z + rc.d * f, w: rc.w, d: rc.d * (1 - f) }, depth + 1, rng, maxDepth));
}

/** 地块够不够"干净"：footprint 范围内的**每一个格**都得是"本街区自己的空地"。
 *  ⚠️ 两条都是这轮实测撞出来的：
 *   ① 原来是"四角 + 中心 5 个探针"：4m 粗格 + 只探 5 点 ⇒ 斜穿地块的窄路（service 4.5m）
 *      正好落在探针之间就漏了，楼直接压上街（实测楼到路中心线最小距离 = 0m，违规 475 处）；
 *   ② 只看"格是空的"不够：街区 bbox 会盖住**别的**连通域（斜长条的 bbox 铺满全图、
 *      或者被路围住的院子）⇒ 两栋不同街区的楼叠在一起（实测楼间距 = 0m）。
 *      owner[] 是格→街区的归属，格号对不上就不是我的地。 */
function parcelUsable(rc, owner, id, gx, gz, N, occ, legacy) {
  const pad = 3.2;
  const w = rc.w - pad * 2, d = rc.d - pad * 2;
  if (w < 7.5 || d < 7.5) return false;
  if (legacy) {
    // 改之前的判据：四角 + 中心 5 个探针（只为自检能复现"改之前"的数，正常生成用不到）
    const probes = [
      [rc.x + pad, rc.z + pad], [rc.x + rc.w - pad, rc.z + pad],
      [rc.x + pad, rc.z + rc.d - pad], [rc.x + rc.w - pad, rc.z + rc.d - pad],
      [rc.x + rc.w / 2, rc.z + rc.d / 2],
    ];
    for (const [x, z] of probes) {
      const i = gz(z), j = gx(x);
      if (i < 0 || j < 0 || i >= N || j >= N) return false;
      if (occ[i * N + j]) return false;
    }
    return true;
  }
  const x0 = gx(rc.x + pad), x1 = gx(rc.x + rc.w - pad);
  const z0 = gz(rc.z + pad), z1 = gz(rc.z + rc.d - pad);
  if (x0 < 0 || z0 < 0 || x1 >= N || z1 >= N) return false;
  for (let i = z0; i <= z1; i++) {
    for (let j = x0; j <= x1; j++) if (owner[i * N + j] !== id) return false;
  }
  return true;
}

// ── 净空：楼 ↔ 路中心线 / 楼 ↔ 楼 ─────────────────────────────────────────
//
// 真机反馈「碰撞体积挡住路了」：碰撞算法本身是对的（圆 vs 旋转矩形，见 player.mjs），
// 挡路的是**楼压到街上 / 楼与楼挤得走不过去**。所以这里做两件事：
//   ① 落位时（buildingFromParcel）按精确距离卡一遍：楼 footprint 到路中心线 ≥ 路面半宽 + 0.5m；
//   ② 生成完再整体校验并修正一遍（enforceClearance）：不够就缩一栋，缩到 6m 以下就拆掉。
// 实测数（最小距离/最小间距）由 auditClearance 独立扫出来，自检里打印。
export const CLEARANCE = {
  roadPad: 0.5,    // 楼面到"路面边缘"再留的净空（米）
  minGap: 2.0,     // 相邻楼之间最小间距（米）
  minSize: 6.0,    // 缩到比这还小的楼就拆掉（别缩成牙签）
};

/** 一栋楼的所有碰撞/占位盒：主体 + 侧翼（塔楼/裙楼都在主体 footprint 里） */
export function buildingBoxes(b) {
  const out = [{ x: b.x, z: b.z, w: b.w, d: b.d, cos: b.cos, sin: b.sin }];
  if (b.wing) out.push({ x: b.wing.x, z: b.wing.z, w: b.wing.w, d: b.wing.d, cos: b.wing.cos, sin: b.wing.sin });
  return out;
}

const pointBoxDist = (px, pz, hx, hz) => Math.hypot(Math.max(0, Math.abs(px) - hx), Math.max(0, Math.abs(pz) - hz));

/** 线段 vs 轴对齐盒（slab 法）：相交 ⇒ true */
function segHitsBox(ax, az, bx, bz, hx, hz) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const slab = (p, d, h) => {
    if (Math.abs(d) < 1e-12) return Math.abs(p) <= h;
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    return t0 <= t1;
  };
  return slab(ax, dx, hx) && slab(az, dz, hz);
}

/** 线段 ↔ 旋转矩形的最短距离（精确；相交/穿透 = 0）。
 *  转到矩形本地方程里，再做"线段 vs 轴对齐盒"：凸包之间的最近距离只可能出现在
 *  「线段端点到盒」或「盒角到线段」这两类上。 */
export function segRectDist(ax, az, bx, bz, B) {
  const c = B.cos, s = B.sin;
  const lax = (ax - B.x) * c + (az - B.z) * s, laz = -(ax - B.x) * s + (az - B.z) * c;
  const lbx = (bx - B.x) * c + (bz - B.z) * s, lbz = -(bx - B.x) * s + (bz - B.z) * c;
  const hx = B.w / 2, hz = B.d / 2;
  if (Math.abs(lax) <= hx && Math.abs(laz) <= hz) return 0;
  if (Math.abs(lbx) <= hx && Math.abs(lbz) <= hz) return 0;
  if (segHitsBox(lax, laz, lbx, lbz, hx, hz)) return 0;
  let d = Math.min(pointBoxDist(lax, laz, hx, hz), pointBoxDist(lbx, lbz, hx, hz));
  for (const [px, pz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]]) {
    d = Math.min(d, Math.sqrt(distToSeg2(px, pz, lax, laz, lbx, lbz)));
  }
  return d;
}

/** 两个旋转矩形的最短距离（精确；相交 = 0）。
 *  分离轴：凸多边形的距离 = 各自边法线方向上"投影间隙"的最大值。 */
export function rectRectDist(A, B) {
  const axes = [[A.cos, A.sin], [-A.sin, A.cos], [B.cos, B.sin], [-B.sin, B.cos]];
  let best = -Infinity;
  for (const [nx, nz] of axes) {
    const d = Math.abs((B.x - A.x) * nx + (B.z - A.z) * nz);
    const rA = (A.w / 2) * Math.abs(A.cos * nx + A.sin * nz) + (A.d / 2) * Math.abs(-A.sin * nx + A.cos * nz);
    const rB = (B.w / 2) * Math.abs(B.cos * nx + B.sin * nz) + (B.d / 2) * Math.abs(-B.sin * nx + B.cos * nz);
    best = Math.max(best, d - rA - rB);
  }
  return best > 0 ? best : 0;
}

/** 路网净空索引：把每条可通车路段按"它要求的净空带"刷进格子，查询只花 O(附近几格)。 */
export function buildRoadIndex(roads, cell = 24) {
  const segs = [];
  const map = new Map();
  const key = (i, j) => i * 100000 + j;
  for (const r of roads) {
    const sp = roadSpec(r.cls);
    if (!sp.drive) continue;                      // 人行道/小径既不切街区也不卡人
    const half = sp.w / 2, need = half + CLEARANCE.roadPad;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-6) continue;
      const id = segs.length;
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, cls: r.cls, half, need });
      const i0 = Math.floor((Math.min(a.x, b.x) - need) / cell), i1 = Math.floor((Math.max(a.x, b.x) + need) / cell);
      const j0 = Math.floor((Math.min(a.z, b.z) - need) / cell), j1 = Math.floor((Math.max(a.z, b.z) + need) / cell);
      for (let x = i0; x <= i1; x++) {
        for (let z = j0; z <= j1; z++) {
          const k = key(x, z);
          let arr = map.get(k); if (!arr) map.set(k, (arr = []));
          arr.push(id);
        }
      }
    }
  }
  const stamp = new Int32Array(segs.length);
  let tick = 0;
  return {
    segs, count: segs.length, cells: map.size,
    /** 盒子附近（按格子）可能侵入的路段；返回的数组是复用的，别存 */
    near(box, out = []) {
      out.length = 0; tick++;
      const i0 = Math.floor((box.x - box.w / 2) / cell), i1 = Math.floor((box.x + box.w / 2) / cell);
      const j0 = Math.floor((box.z - box.d / 2) / cell), j1 = Math.floor((box.z + box.d / 2) / cell);
      for (let x = i0; x <= i1; x++) {
        for (let z = j0; z <= j1; z++) {
          const arr = map.get(key(x, z));
          if (!arr) continue;
          for (const id of arr) { if (stamp[id] === tick) continue; stamp[id] = tick; out.push(segs[id]); }
        }
      }
      return out;
    },
  };
}

/** 一栋楼相对路网最"亏"的那处：{ deficit, need, dist, cls, box } */
function worstRoadGap(boxes, idx, scratch) {
  let worst = null;
  for (const box of boxes) {
    for (const s of idx.near(box, scratch)) {
      const d = segRectDist(s.ax, s.az, s.bx, s.bz, box);
      const deficit = s.need - d;
      if (deficit > 1e-6 && (!worst || deficit > worst.deficit)) worst = { deficit, need: s.need, dist: d, cls: s.cls, box };
    }
  }
  return worst;
}

/** 等比缩小一栋楼（保中心，翼/塔一起缩），高度不变 */
function scaleBuilding(b, f) {
  b.w *= f; b.d *= f;
  if (b.wing) {
    const g = b.wing;
    g.w *= f; g.d *= f;
    g.x = b.x + (g.x - b.x) * f;
    g.z = b.z + (g.z - b.z) * f;
  }
  if (b.tower) { b.tower.w *= f; b.tower.d *= f; b.tower.ox *= f; b.tower.oz *= f; }
}

/** 缩到刚好不压路：按"还差多少米"折算比例（保守 1.25 倍），缩不动就认输。
 *  返回 { ok, steps }（steps = 缩了几次，报告里要写"改了什么"）。 */
function fitToRoads(b, idx, scratch, minSize = CLEARANCE.minSize) {
  let steps = 0;
  for (let it = 0; it < 6; it++) {
    const v = worstRoadGap(buildingBoxes(b), idx, scratch);
    if (!v) return { ok: true, steps };
    const h = Math.max(v.box.w, v.box.d) / 2;
    const f = clamp(1 - (v.deficit * 1.25) / Math.max(0.5, h), 0.5, 0.94);
    if (Math.min(b.w, b.d) * f < minSize) return { ok: false, steps };
    scaleBuilding(b, f); steps++;
  }
  return { ok: !worstRoadGap(buildingBoxes(b), idx, scratch), steps };
}

/** 生成后整体校验 + 修正：路净空 + 楼间距（不够就缩一栋，缩没了就拆）。
 *  楼数组就地改（缩放在原对象上），被拆的从数组里删掉；返回统计。 */
export function enforceClearance(buildings, idx, opts = {}) {
  const minGap = opts.minGap === undefined ? CLEARANCE.minGap : opts.minGap;
  const minSize = opts.minSize === undefined ? CLEARANCE.minSize : opts.minSize;
  const stats = { checked: buildings.length, roadFixed: 0, gapFixed: 0, shrunk: 0, shrinkSteps: 0, dropped: 0, gapPasses: 0 };
  const scratch = [];
  for (let i = buildings.length - 1; i >= 0; i--) {
    const r = fitToRoads(buildings[i], idx, scratch, minSize);
    if (r.ok) { if (r.steps) { stats.roadFixed++; stats.shrunk++; stats.shrinkSteps += r.steps; } continue; }
    stats.dropped++; buildings.splice(i, 1);          // 缩不动（会变牙签）⇒ 拆掉
  }
  // 楼间距：格子配对 → 不够就缩"小的那栋"；缩到 minSize 以下就拆
  for (let pass = 0; pass < 4; pass++) {
    stats.gapPasses = pass + 1;
    const cell = 24, map = new Map(), key = (i, j) => i * 100000 + j;
    const items = [];
    buildings.forEach((b, bi) => buildingBoxes(b).forEach((box) => items.push({ box, bi })));
    items.forEach((it, id) => {
      const { box } = it;
      const i0 = Math.floor((box.x - box.w / 2) / cell), i1 = Math.floor((box.x + box.w / 2) / cell);
      const j0 = Math.floor((box.z - box.d / 2) / cell), j1 = Math.floor((box.z + box.d / 2) / cell);
      for (let x = i0; x <= i1; x++) for (let z = j0; z <= j1; z++) {
        const k = key(x, z); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(id);
      }
    });
    const seen = new Set(), kill = new Set(), shrinkTo = new Map();
    for (const arr of map.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const A = items[arr[i]], B = items[arr[j]];
          if (A.bi === B.bi) continue;
          const lo = Math.min(A.bi, B.bi), hi = Math.max(A.bi, B.bi), pk = lo * 100000 + hi;
          if (seen.has(pk)) continue;
          seen.add(pk);
          const gap = rectRectDist(A.box, B.box);
          if (gap >= minGap - 1e-6) continue;
          const a1 = buildings[lo], a2 = buildings[hi];
          if (!a1 || !a2) continue;
          const bi = (a1.w * a1.d) <= (a2.w * a2.d) ? lo : hi;
          const tgt = buildings[bi];
          const h = Math.max(tgt.w, tgt.d) / 2;
          const f = clamp(1 - ((minGap - gap) * 1.25) / Math.max(0.5, h), 0.5, 0.94);
          if (Math.min(tgt.w, tgt.d) * f < minSize) kill.add(bi);
          else shrinkTo.set(bi, Math.min(shrinkTo.get(bi) === undefined ? 1 : shrinkTo.get(bi), f));
        }
      }
    }
    const prune = () => {
      for (let i = buildings.length - 1; i >= 0; i--) {
        if (buildings[i]._dead) { delete buildings[i]._dead; buildings.splice(i, 1); stats.dropped++; }
      }
    };
    if (kill.size) { for (const bi of kill) if (buildings[bi]) buildings[bi]._dead = true; prune(); stats.gapFixed += kill.size; }
    if (shrinkTo.size) {
      for (const [bi, f] of shrinkTo) {
        if (!buildings[bi]) continue;
        scaleBuilding(buildings[bi], f);
        if (!fitToRoads(buildings[bi], idx, scratch, minSize).ok) buildings[bi]._dead = true;   // 缩了又贴上路 ⇒ 拆
        stats.gapFixed++; stats.shrunk++;
      }
      prune();
    }
    if (!kill.size && !shrinkTo.size) break;
  }
  return stats;
}

/** 独立扫一遍，量出"楼↔路中心线最小距离 / 楼↔楼最小间距"（自检与报告用） */
export function auditClearance(city) {
  const idx = buildRoadIndex(city.roads);
  const scratch = [];
  const boxes = [];
  city.buildings.forEach((b, bi) => buildingBoxes(b).forEach((box) => boxes.push({ box, bi })));
  let minRoad = Infinity, minRoadAt = null, roadViolations = 0, worst = null;
  for (const e of boxes) {
    for (const s of idx.near(e.box, scratch)) {
      const d = segRectDist(s.ax, s.az, s.bx, s.bz, e.box);
      if (d < minRoad) { minRoad = d; minRoadAt = { bi: e.bi, cls: s.cls, need: s.need, required: s.need }; }
      if (d < s.need - 1e-9) {
        roadViolations++;
        const deficit = s.need - d;
        if (!worst || deficit > worst.deficit) worst = { deficit: +deficit.toFixed(2), dist: +d.toFixed(2), need: s.need, cls: s.cls };
      }
    }
  }
  const cell = 24, map = new Map(), key = (i, j) => i * 100000 + j;
  boxes.forEach((e, id) => {
    const { box } = e;
    const i0 = Math.floor((box.x - box.w / 2) / cell), i1 = Math.floor((box.x + box.w / 2) / cell);
    const j0 = Math.floor((box.z - box.d / 2) / cell), j1 = Math.floor((box.z + box.d / 2) / cell);
    for (let x = i0; x <= i1; x++) for (let z = j0; z <= j1; z++) {
      const k = key(x, z); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(id);
    }
  });
  let minGap = Infinity, minGapAt = null, gapViolations = 0, pairs = 0;
  const seen = new Set();
  for (const arr of map.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const A = boxes[arr[i]], B = boxes[arr[j]];
        if (A.bi === B.bi) continue;
        const lo = Math.min(A.bi, B.bi), hi = Math.max(A.bi, B.bi), pk = lo * 100000 + hi;
        if (seen.has(pk)) continue;
        seen.add(pk); pairs++;
        const d = rectRectDist(A.box, B.box);
        if (d < minGap) { minGap = d; minGapAt = { a: lo, b: hi }; }
        if (d < CLEARANCE.minGap - 1e-9) gapViolations++;
      }
    }
  }
  return {
    boxes: boxes.length, buildings: city.buildings.length, roadSegs: idx.count, pairs,
    minRoadDist: +minRoad.toFixed(2), minRoadAt, roadViolations, worstRoad: worst,
    minGap: +minGap.toFixed(2), minGapAt, gapViolations,
    need: { roadPad: CLEARANCE.roadPad, minGap: CLEARANCE.minGap },
  };
}


/** 地块 → 建筑（裙楼 + 塔楼退台 + 材质/层数差异） */
function buildingFromParcel(rc, blk, rng, radius) {
  const pad = 3.2 + rng.range(0, 2.2);
  const w = rc.w - pad * 2, d = rc.d - pad * 2;
  if (w < 7 || d < 7) return null;
  const area = w * d;
  const distC = Math.hypot(rc.x + rc.w / 2, rc.z + rc.d / 2);
  // 分区：圆心附近高、边缘低，再叠加"街区簇"噪声（免得一圈一圈像靶子）
  const t = clamp((distC - 130) / 720, 0, 1);
  const cluster = (hashSeed(blk.seed, 7) % 1000) / 1000 - 0.5;
  let target = lerp(58, 9, t) * (1 + cluster * 0.75) * rng.range(0.7, 1.35);
  if (area < 120) target *= 0.55;
  const floors = clamp(Math.round(target / 3.3), 2, 42);
  const h = floors * 3.3;
  const material = h >= 34 || (h >= 22 && rng.chance(0.35)) ? 2 : h >= 13 ? 1 : 0;

  const cx = rc.x + rc.w / 2, cz = rc.z + rc.d / 2;
  const rot = rng.range(-0.05, 0.05);
  const b = {
    x: cx, z: cz, w, d, rot, cos: Math.cos(rot), sin: Math.sin(rot),
    floors, h, material, seed: hashSeed(blk.seed, cx | 0, cz | 0, floors),
    podium: null, wing: null, roof: rng.pick(['flat', 'flat', 'flat', 'tank', 'mech']),
  };
  // 裙楼 + 塔楼退台（楼够高才做，否则就是普通多层）
  if (floors >= 8) {
    const pf = rng.int(1, 2);
    const k = rng.range(0.16, 0.3);
    const tw = w * (1 - k), td = d * (1 - k);
    if (tw >= 6.5 && td >= 6.5 && floors - pf >= 3) {
      b.podium = { floors: pf, h: pf * 4.4 };
      b.tower = { w: tw, d: td, floors: floors - pf, h: (floors - pf) * 3.3, ox: rng.range(-1, 1) * (w - tw) * 0.18, oz: rng.range(-1, 1) * (d - td) * 0.18 };
      b.h = b.podium.h + b.tower.h;
    }
  }
  // 长条地块 → 加一翼（错落的天际线）
  const aspect = Math.max(w, d) / Math.max(1, Math.min(w, d));
  if (!b.podium && aspect > 1.85 && area > 700) {
    const along = w >= d;
    const wf = rng.range(0.3, 0.45);
    const side = rng.sign();
    const wing = along
      ? { x: cx + side * (w / 2 - w * wf / 2), z: cz, w: w * wf, d: d, rot, floors: clamp(floors + rng.int(-3, 5), 2, 42) }
      : { x: cx, z: cz + side * (d / 2 - d * wf / 2), w, d: d * wf, rot, floors: clamp(floors + rng.int(-3, 5), 2, 42) };
    wing.h = wing.floors * 3.3;
    wing.material = wing.floors >= 34 ? 2 : wing.floors >= 13 ? 1 : 0;
    // ⚠️ 翼也得有 cos/sin —— 只给 rot 的话网格生成会算出 NaN（踩过一次）
    wing.cos = Math.cos(rot); wing.sin = Math.sin(rot);
    b.wing = wing;
    // 主体缩一点，免得两翼完全重叠
    if (along) { b.w *= 1 - wf * 0.9; } else { b.d *= 1 - wf * 0.9; }
  }
  if (Math.hypot(b.x, b.z) > radius * 1.02) return null;
  b.zone = t < 0.3 ? 'core' : t < 0.65 ? 'mid' : 'outer';
  return b;
}

function placeTrees(roads, buildings, radius, rng) {
  const trees = [];
  // 建筑的粗格哈希（24m）：行道树要避开楼，逐棵去 some() 扫全城太慢
  const S = 24, pad = 1.6;
  const hash = new Map();
  const key = (i, j) => i * 100000 + j;
  const addRect = (b) => {
    const r = Math.max(b.w, b.d) / 2 + 3;
    const i0 = Math.floor((b.x - r) / S), i1 = Math.floor((b.x + r) / S);
    const j0 = Math.floor((b.z - r) / S), j1 = Math.floor((b.z + r) / S);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let a = hash.get(k); if (!a) hash.set(k, (a = []));
      a.push(b);
    }
  };
  for (const b of buildings) { addRect(b); if (b.wing) addRect(b.wing); }
  const near = (x, z) => {
    const a = hash.get(key(Math.floor(x / S), Math.floor(z / S)));
    if (!a) return false;
    for (const b of a) if (inRotRect(b, x, z, pad)) return true;
    return false;
  };
  outer:
  for (const r of roads) {
    const sp = roadSpec(r.cls);
    if (!sp.drive) continue;
    const off = sp.w / 2 + 1.5;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 4) continue;
      const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
      const nx = -dz, nz = dx;
      for (let s = 7; s < L; s += 13 + rng.range(-3, 3)) {
        for (const side of [1, -1]) {
          if (rng.chance(0.25)) continue;
          const x = a.x + dx * s + nx * off * side + rng.range(-0.8, 0.8);
          const z = a.z + dz * s + nz * off * side + rng.range(-0.8, 0.8);
          if (Math.hypot(x, z) > radius * 1.05) continue;
          if (near(x, z)) continue;
          trees.push({ x, z, h: rng.range(5.5, 9.5), r: rng.range(1.6, 2.6), seed: hashSeed(x | 0, z | 0) });
          if (trees.length > 1200) break outer;
        }
      }
    }
  }
  return trees;
}

function placeManholes(roads, radius, rng) {
  const out = [];
  for (const r of roads) {
    const sp = roadSpec(r.cls);
    if (!sp.drive) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
      const nx = -dz, nz = dx;
      for (let s = 12; s < L; s += rng.range(28, 55)) {
        const o = rng.range(-sp.w * 0.28, sp.w * 0.28);
        const x = a.x + dx * s + nx * o, z = a.z + dz * s + nz * o;
        if (Math.hypot(x, z) < radius) out.push({ x, z, r: 0.42 });
        if (out.length > 900) return out;
      }
    }
  }
  return out;
}

/** 交叉口 → 斑马线（按顶点聚簇 + 方向去重，够用就行） */
function placeCrossings(roads, radius) {
  const buckets = new Map();
  const key = (x, z) => `${Math.round(x / 9)}_${Math.round(z / 9)}`;
  roads.forEach((r, ri) => {
    const sp = roadSpec(r.cls);
    if (!sp.drive) return;
    for (let i = 0; i < r.pts.length; i++) {
      const p = r.pts[i];
      const k = key(p.x, p.z);
      let e = buckets.get(k);
      if (!e) buckets.set(k, (e = { x: 0, z: 0, n: 0, dirs: [], w: 0, roads: new Set() }));
      e.x += p.x; e.z += p.z; e.n++;
      e.w = Math.max(e.w, sp.w);
      e.roads.add(ri);
      const a = r.pts[i - 1] || r.pts[i + 1], b = r.pts[i + 1] || r.pts[i - 1];
      if (a && b) {
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        e.dirs.push(Math.atan2((b.z - a.z) / L, (b.x - a.x) / L));
      }
    }
  });
  const out = [];
  for (const e of buckets.values()) {
    if (e.roads.size < 2 || e.n < 2) continue;
    const cx = e.x / e.n, cz = e.z / e.n;
    if (Math.hypot(cx, cz) > radius * 0.98) continue;
    const dirs = [];
    for (const a of e.dirs) {
      let ang = ((a % Math.PI) + Math.PI) % Math.PI;
      if (!dirs.some((d) => Math.abs(d - ang) < 0.45 || Math.abs(Math.abs(d - ang) - Math.PI) < 0.45)) dirs.push(ang);
      if (dirs.length >= 2) break;
    }
    for (const ang of dirs) {
      out.push({ x: cx + Math.cos(ang) * (e.w / 2 + 2.6), z: cz + Math.sin(ang) * (e.w / 2 + 2.6), ang, w: e.w, len: 3.4 });
    }
    if (out.length > 500) break;
  }
  return out;
}

export { dedupe };
