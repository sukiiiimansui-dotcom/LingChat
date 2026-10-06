// urban.mjs —— 出生点选址 + 路网补满（纯逻辑，node 可测）。
//
// 为什么需要这一层（2026-10-06 真机截图的病根，已量过）：
//   · 主人截图里「LOD 近 = 2、近处一大片空地」——本喵用 probe_density.mjs 量出来：
//     定位点（重庆 29.5689,106.5577）周围 350m 内**只有 1 条真路**，真路网最密的格子离原点 **1768m**，
//     缓存只覆盖本盘 7.5%。于是原点那一圈全靠 city.mjs 的程序补路网，而它是"避让真路网"的补法：
//     真路一多，补出来的路就被割成一截截，围不出街区 ⇒ 楼自然稀疏。
//   · 所以这里做两件事：① 换一个"真路密 + 真能盖出楼"的中心当出生点；② 空白处补**连通**的正交路网，
//     保证半径内不出现大片空地（city.mjs 自己的补路网可以用 opts.procRoads=false 关掉，见那里的注释）。
//
// 全部是纯函数：不碰网络、不碰 three，probe/selftest 里都能直接跑。
import { buildCity, roadSpec } from '../city.mjs';
import { distToSeg2 } from '../util.mjs';

/** 路网折线顶点密度（比"里程"更能反映"这里被认真测绘过"） */
export function vertexDensity(roads, cell = 250) {
  const m = new Map();
  for (const r of roads) {
    for (const p of r.pts) {
      const k = Math.round(p.x / cell) + '_' + Math.round(p.z / cell);
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

/** 候选中心：把顶点密度按 3×3 邻域累加，取前 n 个（周围有人烟的格子） */
export function candidateCenters(roads, { cell = 250, n = 6, maxDist = 1e9 } = {}) {
  const m = vertexDensity(roads, cell);
  const scored = [];
  for (const k of m.keys()) {
    const [i, j] = k.split('_').map(Number);
    let s = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += m.get((i + a) + '_' + (j + b)) || 0;
    const x = i * cell, z = j * cell;
    if (Math.hypot(x, z) > maxDist) continue;
    scored.push({ x, z, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  // 候选之间至少隔开一格，免得六个候选其实是同一片
  const out = [];
  for (const c of scored) {
    if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < cell * 1.5)) continue;
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

/** 把所有路整体平移（换中心就等于把整张路网挪到原点） */
export function shiftRoads(roads, cx, cz) {
  return roads.map((r) => ({ ...r, pts: r.pts.map((p) => ({ x: p.x - cx, z: p.z - cz })) }));
}

/**
 * 空白处补连通正交路网。
 * 和 city.mjs 的 proceduralRoads 的区别：**直线、不抖、不随机丢段、按整条线连续铺**，
 * 所以一定能围出闭合街区（那版是"避让式"补法，真路一多就围不出街区 —— 正是空地的主因）。
 * 三档间距：主干 240m / 次干 120m / 支路 60m，只在"真路覆盖不到"的地方铺。
 */
export function fillStreets(roads, { radius, halo = 46, blockKm = 1 } = {}) {
  const S = 12;
  const half = radius * 1.12 + 40;
  const N = Math.ceil((half * 2) / S);
  const gi = (v) => Math.round((v + half) / S);
  const cover = new Uint8Array(N * N);
  for (const r of roads) {
    if (!roadSpec(r.cls).drive) continue;
    const pad = roadSpec(r.cls).w / 2 + halo;
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
  const out = [];
  /**
   * 一条线上的合成路。**关键决定：以"整条线"为单位取舍，不在被真路压到的地方断开。**
   * 为什么（2026-10-06 量出来的）：断开的线会让两侧的空地连成一片，
   * `findBlocks` 拿到的是"连通域"，于是街区 bbox 涨到 200~300m 的 L 形，
   * 而 city.mjs 是按 bbox 矩形切地块 + 五点探针判可用 ⇒ 地块全被判废，一栋楼都盖不出来
   * （实测：断线版 288 条路 → 30 个街区 / 82 栋楼；不断线版见下）。
   * 不断线的代价只是"合成路和真路在路口重叠"（城市里路口本来就重叠），完全可接受。
   */
  const line = (fixed, vertical, cls, step) => {
    const pts = [];
    let inside = 0, free = 0;
    for (let t = -half; t <= half; t += step) {
      const p = vertical ? { x: fixed, z: t } : { x: t, z: fixed };
      if (Math.hypot(p.x, p.z) >= radius * 1.06) continue;
      inside++; if (!covered(p.x, p.z)) free++;
      pts.push(p);
    }
    if (inside < 2 || free / inside < 0.45) return;    // 这条线大部分已经被真路盖住了 ⇒ 整条不铺
    out.push({ cls, pts, synth: true });
  };
  /** 把刚铺的合成路刷进覆盖图。pad 只要"别让下一级压在它身上"这么宽就够 ——
   *  取半个间距会把下一级本该铺的位置也堵死（实测：pad=间距一半 ⇒ 路网铺不进去、街区反而涨到 300m） */
  const markSynth = (road) => {
    const pad = roadSpec(road.cls).w / 2 + 12;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const x0 = gi(Math.min(a.x, b.x) - pad), x1 = gi(Math.max(a.x, b.x) + pad);
      const z0 = gi(Math.min(a.z, b.z) - pad), z1 = gi(Math.max(a.z, b.z) + pad);
      for (let z = Math.max(0, z0); z <= Math.min(N - 1, z1); z++) {
        for (let x = Math.max(0, x0); x <= Math.min(N - 1, x1); x++) {
          const cx = x * S - half, cz = z * S - half;
          if (distToSeg2(cx, cz, a.x, a.z, b.x, b.z) <= pad * pad) cover[z * N + x] = 1;
        }
      }
    }
  };
  // 三档是**逐级二分**：主干 320m 一档，次干插在正中，巷再插在正中 ⇒ 最终每格 80m（blockKm 可整体放大）
  const B = 320 * blockKm;
  const layers = [
    { step: B, off: 0, cls: 'tertiary' },
    { step: B, off: B / 2, cls: 'residential' },
    { step: B / 2, off: B / 4, cls: 'service' },
  ];
  for (const ly of layers) {
    const sample = Math.max(20, ly.step / 4);
    for (let x = -half + ly.off; x <= half; x += ly.step) line(x, true, ly.cls, sample);
    for (let z = -half + ly.off; z <= half; z += ly.step) line(z, false, ly.cls, sample);
    for (const r of out) if (!r.marked) { markSynth(r); r.marked = true; }
  }
  for (const r of out) delete r.marked;
  return out;
}

/** 楼在半径内的"密度体检"：出生点该不该换、近档楼数够不够，全靠这几个数说话 */
export function densityReport(buildings, radius = 1000) {
  const r = { total: buildings.length, near: 0, mid: 0 };
  for (const b of buildings) {
    const d = Math.hypot(b.x, b.z);
    if (d < 270) r.near++;
    if (d < 640) r.mid++;
  }
  r.rings = [];
  for (let r0 = 0; r0 < radius; r0 += 100) {
    r.rings.push(buildings.filter((b) => { const d = Math.hypot(b.x, b.z); return d >= r0 && d < r0 + 100; }).length);
  }
  return r;
}

/**
 * 一步到位：挑中心 → 平移 → 补满路网 → 生成城。
 * `probeRadius` 阶段的城只用来"试盖"，半径小 ⇒ 快（真机上也只要几百毫秒）。
 */
export function prepareCity({ lat, lng, radius, realRoads, seedStr, center, opts = {} }) {
  const t0 = Date.now();
  const wantFill = opts.fill !== false;
  const shifted = center && (center.x || center.z) ? shiftRoads(realRoads, center.x, center.z) : realRoads;
  const synth = wantFill ? fillStreets(shifted, { radius, halo: opts.halo, blockKm: opts.blockKm }) : [];
  const city = buildCity({
    lat, lng, radius, realRoads: shifted.concat(synth), seedStr,
    procRoads: opts.procRoads !== false ? undefined : false,
  });
  return {
    city, roads: shifted, synth, center: center || { x: 0, z: 0 },
    stats: { synthRoads: synth.length, ms: Date.now() - t0 },
  };
}

/** 在若干候选中心里挑"盖出来的楼最多"的那个（用小子半径试盖，快） */
export function pickCenter({ lat, lng, radius, realRoads, seedStr, opts = {}, probeRadius = 340, maxCandidates = 5 }) {
  const cands = [{ x: 0, z: 0, score: -1, api: true },
    ...candidateCenters(realRoads, { cell: 250, n: maxCandidates, maxDist: radius * 2.2 })];
  const tried = [];
  let best = null;
  for (const c of cands) {
    const shifted = shiftRoads(realRoads, c.x, c.z);
    const synth = opts.fill === false ? [] : fillStreets(shifted, { radius: probeRadius, halo: opts.halo, blockKm: opts.blockKm });
    const city = buildCity({ lat, lng, radius: probeRadius, realRoads: shifted.concat(synth), seedStr, procRoads: opts.procRoads !== false ? undefined : false });
    const rep = densityReport(city.buildings, probeRadius);
    const rec = { x: c.x, z: c.z, near: rep.near, total: rep.total, centerDist: Math.round(Math.hypot(c.x, c.z)) };
    tried.push(rec);
    if (!best || rec.near > best.near || (rec.near === best.near && rec.total > best.total)) best = rec;
  }
  return { best, tried };
}
