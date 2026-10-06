// validate.mjs —— 布局体检 + 脱困 + 可通行自测（纯逻辑，node 可测）。
//
// 为什么单开一个文件：主人真机反馈「碰撞体积挡住路了」。碰撞算法本身是 v1 的 OBB vs 圆推离（正确），
// 挡路的真因是**生成器可能把楼压到街上**、或相邻楼贴得比人还窄。所以这里做三件事：
//   ① 量：楼体 footprint 到道路中心线的最小距离、楼与楼的最小间距（把数报出来，不靠感觉）；
//   ② 修：压线的楼按需要的量缩进去，缩不动（<7m）就删掉；贴太近的楼让矮的那栋退一步；
//   ③ 试：从出生点沿真实街道走 200m，每步都过一遍 resolve()，看会不会被卡住。
// 全部纯函数：selftest 与 probe 都能跑，不依赖浏览器。
import { buildCollider, resolve } from '../player.mjs';
import { worldToLocal } from '../util.mjs';
import { roadSpec } from '../city.mjs';

/** 点到旋转矩形（OBB）的距离（>0 在外面，=0 在边上） */
export function pointToObb(b, x, z) {
  const l = worldToLocal(b, x - b.x, z - b.z);
  const hx = b.w / 2, hz = b.d / 2;
  const dx = Math.max(Math.abs(l.x) - hx, 0), dz = Math.max(Math.abs(l.z) - hz, 0);
  return Math.hypot(dx, dz);
}

/** 线段到 OBB 的最近距离（按 step 采样；0.5m 够用，判据本身就是 0.5m 级） */
export function segToObb(b, ax, az, bx, bz, step = 0.5) {
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(L / step));
  let best = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = pointToObb(b, ax + (bx - ax) * t, az + (bz - az) * t);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

/** 路段的 100m 空间哈希（不然 1300 栋 × 1.6 万段会跑到天荒地老） */
function segGrid(roads, cell = 60) {
  const m = new Map();
  const key = (i, j) => i + '_' + j;
  roads.forEach((r, ri) => {
    const hw = roadSpec(r.cls).w / 2;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const i0 = Math.floor((Math.min(a.x, b.x) - 12) / cell), i1 = Math.floor((Math.max(a.x, b.x) + 12) / cell);
      const j0 = Math.floor((Math.min(a.z, b.z) - 12) / cell), j1 = Math.floor((Math.max(a.z, b.z) + 12) / cell);
      for (let x = i0; x <= i1; x++) for (let z = j0; z <= j1; z++) {
        const k = key(x, z);
        let arr = m.get(k); if (!arr) m.set(k, (arr = []));
        arr.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, hw });
      }
    }
  });
  return {
    near(b, radius = 25) {
      const i0 = Math.floor((b.x - b.w / 2 - radius) / cell), i1 = Math.floor((b.x + b.w / 2 + radius) / cell);
      const j0 = Math.floor((b.z - b.d / 2 - radius) / cell), j1 = Math.floor((b.z + b.d / 2 + radius) / cell);
      const out = [];
      for (let x = i0; x <= i1; x++) for (let z = j0; z <= j1; z++) {
        const arr = m.get(key(x, z));
        if (arr) out.push(...arr);
      }
      return out;
    },
  };
}

/** 楼 → 最近道路中心线的距离与"还差多少"（负 = 侵入路面） */
export function roadClearance(b, grid) {
  let best = Infinity, hw = 0;
  for (const s of grid.near(b)) {
    const d = segToObb(b, s.ax, s.az, s.bx, s.bz);
    if (d - s.hw < best) { best = d - s.hw; hw = s.hw; }
  }
  return best === Infinity ? { clear: Infinity, hw: 0 } : { clear: best, hw };
}

/** 体检：楼↔路最小净距、楼↔楼最小间距（都是"米"，正数=有缝隙） */
export function validateLayout(buildings, roads, opts = {}) {
  const grid = segGrid(roads);
  // 抽样（默认每 3 栋量 1 栋）：这只是"报数"用的体检，不必逐栋精确到厘米，
  // 逐栋量在手机上要 600ms+（踩过），抽样后 200ms 上下还能抓到压线的楼
  const sample = Math.max(1, opts.sample || 3);
  let minClear = Infinity, minClearAt = null;
  for (let bi = 0; bi < buildings.length; bi += sample) {
    const b = buildings[bi];
    if (!(b.w > 0)) continue;
    const { clear } = roadClearance(b, grid);
    if (clear < minClear) { minClear = clear; minClearAt = { x: Math.round(b.x), z: Math.round(b.z) }; }
  }
  // 楼与楼最小间距（轴对齐近似：几何旋转都在 ±3° 内，误差 <5%）
  const S = 40, m = new Map();
  const key = (i, j) => i + '_' + j;
  let minGap = Infinity, minGapAt = null;
  for (const b of buildings) {
    if (!(b.w > 1)) continue;
    const i = Math.floor(b.x / S), j = Math.floor(b.z / S);
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      for (const o of (m.get(key(i + a, j + c)) || [])) {
        const dx = Math.abs(o.x - b.x) - (o.w + b.w) / 2;
        const dz = Math.abs(o.z - b.z) - (o.d + b.d) / 2;
        const gap = Math.max(dx, dz);
        if (gap < minGap) { minGap = gap; minGapAt = { x: Math.round(b.x), z: Math.round(b.z) }; }
      }
    }
    const k = key(i, j);
    let arr = m.get(k); if (!arr) m.set(k, (arr = []));
    arr.push(b);
  }
  return {
    buildings: buildings.length,
    minRoadClear: minClear === Infinity ? null : +minClear.toFixed(2),
    minRoadClearAt: minClearAt,
    minGap: minGap === Infinity ? null : +minGap.toFixed(2),
    minGapAt: minGapAt,
    roads: roads.length,
  };
}

/**
 * 修正：压线的楼缩进去、缩不动就删；贴太近的楼让矮的退一步。
 * 判据（主人给的）：楼体到道路中心线 ≥ 路面半宽 + 0.5m；相邻楼间距 ≥ 2m。
 */
export function sanitizeLayout(buildings, roads, opts = {}) {
  const clear = opts.roadClear !== undefined ? opts.roadClear : 0.5;
  const minGap = opts.minGap !== undefined ? opts.minGap : 2.0;
  const minSize = opts.minSize || 7;
  const maxShrink = opts.maxShrink || 0.5;
  const grid = segGrid(roads);
  let kept = [];
  let shrunk = 0, removed = 0;
  for (const src of buildings) {
    if (!(src.w > 1) || !(src.h > 1)) continue;
    // 超大/超细的楼先扔（style.mjs 已把最长边切到 ≤90m，这里只是兜底；
    // 留着它们会压在路上、把整条街堵死 —— 探针里"走 200m 只走了 51m"就是这么来的）
    if (Math.max(src.w, src.d) > (opts.maxSide || 120)) { removed++; continue; }
    let b = src, ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const { clear: c } = roadClearance(b, grid);
      if (c >= clear) { ok = true; break; }
      const need = (clear - c) * 2 + 0.2;                  // 两边各缩这么多
      const b2 = { ...b };
      let did = false;
      if (b2.w - need >= Math.max(minSize, b2.w * (1 - maxShrink))) { b2.w -= need; did = true; }
      if (b2.d - need >= Math.max(minSize, b2.d * (1 - maxShrink))) { b2.d -= need; did = true; }
      if (!did) break;
      b = b2;
      if (b.podium && b.tower) b.tower = { ...b.tower, w: Math.max(6, b.tower.w - need * 0.5), d: Math.max(6, b.tower.d - need * 0.5) };
    }
    if (!ok && roadClearance(b, grid).clear < clear) { removed++; continue; }
    if (b !== src) shrunk++;
    if (b.w < minSize || b.d < minSize) { removed++; continue; }
    kept.push(b);
  }

  // ── 楼间间距：**反复修**（缩一栋会牵动另一对），修不动就删矮的那栋 ─────────────
  let gapFixed = 0, overlapDropped = 0;
  const passes = opts.gapPasses || 3;
  for (let pass = 0; pass < passes; pass++) {
    // 最后一轮**不再商量**：还差 2m 就把矮的那栋删掉（缩不动时留着它 = 留一堵夹墙）
    const strict = pass === passes - 1;
    const S = 40, m = new Map();
    const key = (i, j) => i + '_' + j;
    const alive = new Set();
    let changed = 0;
    for (const b of kept) alive.add(b);
    for (const b of kept) {
      if (!alive.has(b)) continue;
      const i = Math.floor(b.x / S), j = Math.floor(b.z / S);
      for (let a = -1; a <= 1; a++) for (const c of [-1, 0, 1]) {
        for (const o of (m.get(key(i + a, j + c)) || [])) {
          if (!alive.has(o)) continue;
          const dx = Math.abs(o.x - b.x) - (o.w + b.w) / 2;
          const dz = Math.abs(o.z - b.z) - (o.d + b.d) / 2;
          const gap = Math.max(dx, dz);
          if (gap >= minGap) continue;
          const keep = b.h <= o.h ? b : o;                   // 矮的退让（高的通常是塔楼）
          if (gap < 0 || strict) { alive.delete(keep); overlapDropped++; changed++; continue; }
          const need = minGap - gap + 0.15;
          const alongX = dx > dz;                            // ⚠️ 要缩"决定这个间距的那条轴"
          const canW = keep.w - need >= minSize, canD = keep.d - need >= minSize;
          if ((alongX && !canW) || (!alongX && !canD)) {     // 那条轴已经缩不动 ⇒ 整个让位
            if (!canW && !canD) { alive.delete(keep); overlapDropped++; changed++; continue; }
            const other = alongX ? 'd' : 'w';
            if (keep[other] - need < minSize) { alive.delete(keep); overlapDropped++; changed++; continue; }
            keep[other] -= need;
          } else if (alongX) keep.w -= need; else keep.d -= need;
          gapFixed++; changed++;
        }
      }
      const k = key(i, j);
      let arr = m.get(k); if (!arr) m.set(k, (arr = []));
      arr.push(b);
    }
    kept = kept.filter((b) => alive.has(b));
    if (!changed) break;
  }
  return { buildings: kept, shrunk, removed: removed + overlapDropped, gapFixed, overlapDropped, keptBefore: buildings.length };
}

/**
 * 可通行自测：从出生点沿最近的真实街道走 `target` 米，每步都跑 resolve()。
 * 判"卡住"：这一步实际位移 < 期望位移 × 0.5（被楼推回来或推不动）。
 */
export function walkTest(buildings, roads, opts = {}) {
  const target = opts.target || 200;
  const r = opts.radius || 0.45;                 // 角色半径（与 character.mjs 一致）
  const step = opts.step || 0.35;
  const collider = buildCollider({ buildings });
  // 挑一条从出生点附近经过、且足够长的路
  let best = null;
  for (const rd of roads) {
    const sp = roadSpec(rd.cls);
    if (!sp.drive || sp.w < 5) continue;
    for (let i = 1; i < rd.pts.length; i++) {
      const a = rd.pts[i - 1], b = rd.pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 20) continue;
      const d = Math.hypot(a.x, a.z);
      if (!best || d < best.d) best = { d, a, b, cls: rd.cls };
    }
  }
  if (!best) return { ok: false, reason: '没有可走的路', covered: 0 };
  const pos = { x: best.a.x, z: best.a.z };
  let dx = best.b.x - best.a.x, dz = best.b.z - best.a.z;
  let L0 = Math.hypot(dx, dz); dx /= L0; dz /= L0;
  let covered = 0, stuck = 0, maxPush = 0, pushed = 0;
  const limit = Math.ceil(target / step) * 3;
  for (let k = 0; k < limit && covered < target; k++) {
    // 沿街走，但不要一直贴着同一条折线：走到端点就按原方向继续（穿路口）
    const want = step;
    const before = { x: pos.x, z: pos.z };
    pos.x += dx * step; pos.z += dz * step;
    resolve(pos, r, collider.near(pos.x, pos.z));
    const moved = Math.hypot(pos.x - before.x, pos.z - before.z);
    covered += moved;
    if (moved < want * 0.5) { stuck++; maxPush = Math.max(maxPush, want - moved); }
    else if (moved < want * 0.98) { pushed++; maxPush = Math.max(maxPush, want - moved); }
    // 撞得厉害就稍微绕一下（模拟玩家的走位），免得一路顶着墙角算失败
    if (moved < want * 0.5) {
      const side = k % 2 ? 1 : -1;
      pos.x += -dz * side * step * 2; pos.z += dx * side * step * 2;
      resolve(pos, r, collider.near(pos.x, pos.z));
    }
  }
  return {
    ok: covered >= target * 0.9 && stuck <= limit * 0.25,
    covered: +covered.toFixed(1), target, stuck, squeezed: pushed, maxPush: +maxPush.toFixed(2),
    road: best.cls, start: [+best.a.x.toFixed(1), +best.a.z.toFixed(1)],
  };
}
