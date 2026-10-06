// style.mjs —— 给"长得都一样的盒子"做**风格抽样**（纯逻辑，node 可测）。
//
// 主人的原话是「最毛坯的地方就是**过于重复**了」。city.mjs 只按到圆心的距离给高度，
// 同一条街上的楼于是像一个模子刻的。这一层在**不动 city.mjs** 的前提下（v1 基线要保住）做四件事：
//   ① 高度长尾：多数 2~8 层 + 少量塔楼（`u^2.2` 抽样），不是均匀分布；
//   ② 街区风格分档：按 320m 邻域哈希分成 老城/住宅/商务/混合，**同一片街区的楼共享倾向**；
//   ③ 每栋独立种子 + 加权抽样：材质 4 套（砖/混凝土/玻璃/涂料）、屋顶 6 类（平顶/水箱/机组/坡顶/退台/天线）、
//      立面处理（窗距、阳台排、飘窗、底商、偶发空地停车场）；
//   ④ 少量地标（角楼/塔楼）打破天际线。
//
// 为什么放在 three 这层而不是改 city.mjs：主人要拿 v1 跟 three 版**同条件 A/B**，
// 生成器一改两边都变，就说不清"到底哪一版的画面变了"。要回到"v1 原味城市"只需 ?variety=0。
import { rngOf, hashSeed, clamp, lerp } from '../util.mjs';
import { TIERS } from './palette.mjs';

/** 第 4 套立面（涂料/抹灰）——加进 TIERS 之外单独标，免得动 v1 的三档含义（material 0/1/2） */
export const PAINT_TIER = 3;

/** 单栋最长边上限（米）：超过就切 —— v1 的街区 bbox 能出 1.6km 细条，不切会堵路 */
export const MAX_SIDE = 90;

/** 街区风格：同一片 320m 邻域共享一套倾向，这样"老城"和"CBD"才会成片出现 */
export const DISTRICTS = {
  oldtown: {
    name: '老城低层', floors: [2, 8], maxTall: 12,
    mat: [[0, 5], [3, 4], [1, 2]],                 // 砖 / 涂料 / 混凝土
    roof: [['pitched', 3], ['flat', 3], ['tank', 1], ['mech', 1]],
    balcony: 0.35, bay: 0.10, podium: 0.05, shop: 0.75, vacant: 0.05, balconyFloors: [2, 7],
  },
  housing: {
    name: '住宅板楼', floors: [5, 20], maxTall: 26,
    mat: [[1, 4], [3, 3], [0, 2]],
    roof: [['flat', 5], ['tank', 2], ['mech', 2], ['setback', 1]],
    balcony: 0.72, bay: 0.35, podium: 0.15, shop: 0.7, vacant: 0.02, balconyFloors: [3, 16],
  },
  cbd: {
    name: '商务塔楼', floors: [10, 40], maxTall: 52,
    mat: [[2, 5], [1, 3], [3, 1]],
    roof: [['mech', 4], ['tank', 3], ['flat', 3], ['antenna', 2], ['setback', 2]],
    balcony: 0.08, bay: 0.0, podium: 0.65, shop: 0.9, vacant: 0.01, balconyFloors: [8, 20],
  },
  mixed: {
    name: '混合', floors: [3, 16], maxTall: 22,
    mat: [[1, 4], [0, 3], [2, 2], [3, 2]],
    roof: [['flat', 4], ['tank', 2], ['mech', 2], ['setback', 1], ['pitched', 1]],
    balcony: 0.45, bay: 0.2, podium: 0.25, shop: 0.8, vacant: 0.03, balconyFloors: [3, 12],
  },
};

/** 每片街区的色偏（同一片成色调，片与片不同）—— 治"一片灰绿" */
export const TINTS = {
  oldtown: [[1.08, 1.0, 0.9], [1.02, 0.96, 0.88], [0.98, 0.97, 0.95]],
  housing: [[1.0, 1.0, 1.0], [1.04, 1.0, 0.94], [0.96, 0.98, 1.02]],
  cbd: [[0.94, 0.97, 1.04], [1.0, 1.0, 1.0], [0.98, 1.0, 1.02]],
  mixed: [[1.0, 1.0, 1.0], [1.03, 0.99, 0.95], [0.97, 0.99, 1.03], [1.05, 0.98, 0.92]],
};

export const DISTRICT_OF_ZONE = {
  core: [['cbd', 4], ['mixed', 3], ['housing', 2]],
  mid: [['housing', 4], ['mixed', 4], ['oldtown', 1]],
  outer: [['oldtown', 4], ['housing', 3], ['mixed', 2]],
};

/**
 * **密处也是 CBD**（v2 新加的那条规则）：光看 `zone` 不够 —— 实测北京那一片 r=1km，
 * core 分区的楼只有 99/793，按 zone 投骰出来全城只有 **3~4 栋**商务楼（`cbd` 权重根本轮不上）。
 * 于是补一条"按 3×3 邻域**楼面密度**（Σ 宽×进深×层数）判 CBD"：密度够高的地方，就算 zone 写着 mid/outer 也按 CBD 抽。
 * 为什么不用"数楼数"：实测数楼数最密的那几格在北边 d≈800m 的程序补路网区（n=55），
 * 而中心区只有 n≈30 —— 数楼数会把"郊区大排档"认成 CBD。楼面密度才认得出中心（前 12% 的楼平均离圆心 248m、85% 是 core）。
 */
export const DENSE_PAIRS = [['cbd', 8], ['mixed', 1], ['housing', 1]];

/** 3×3 邻域楼面密度（单位：千 m²）—— 纯函数，node 可测；CBD 判据与"哪来的楼"解耦 */
export function densityField(buildings, cell = 160) {
  const grid = new Map();
  for (const b of buildings || []) {
    if (!(b.w > 0) || !(b.d > 0)) continue;
    const k = Math.round(b.x / cell) + '_' + Math.round(b.z / cell);
    grid.set(k, (grid.get(k) || 0) + (b.w * b.d * Math.max(1, b.floors || 1)) / 1000);
  }
  return {
    cell, grid,
    at(x, z) {
      const i = Math.round(x / cell), j = Math.round(z / cell);
      let s = 0;
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) s += grid.get((i + a) + '_' + (j + c)) || 0;
      return s;
    },
  };
}

/** 加权抽样：`[[值, 权重], ...]` */
export function weighted(rng, pairs) {
  let total = 0;
  for (const p of pairs) total += p[1];
  let r = rng.next() * total;
  for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
  return pairs[pairs.length - 1][0];
}

// ── 建模参数（v2 天际线重排）─────────────────────────────────────────────────
// 为什么做成"参数表 + URL 覆盖"而不是直接改数字：主人真机 A/B 时要能**一键回到旧分布**
// （`?modeling=1`），也要能只翻某一个旋钮（`?pitchMax=9` / `?flatW=0` / `?antP=0`）。
// **全部确定性**：参数只改权重与门槛，不改随机数的消费次数（每次抽样仍恰好用掉一个 rng 值），
// 所以同一个 seed 永远给同一个结果，`?modeling=1` 出来的城跟改动前逐字节一样。
export const MODEL_V1 = {
  v: 1,
  pitchMaxFloors: 9,       // 旧：floors > 9 的坡顶被压成平顶
  setbackMinFloors: 5,     // 旧：floors < 5 的退台被压成平顶
  antennaMinFloors: 12,    // 旧：floors < 12 的天线被换成机组
  antChance: 0,            // 旧：没有"高楼长天线"这条规则
  densityCell: 160,        // CBD 密度格边长（米）
  densityMin: Infinity,    // 旧：密度规则永不触发（只看 zone）
  roof: {                  // 旧权重表 = DISTRICTS 里那三张（原样引用，不复制）
    oldtown: DISTRICTS.oldtown.roof, housing: DISTRICTS.housing.roof,
    cbd: DISTRICTS.cbd.roof, mixed: DISTRICTS.mixed.roof,
  },
};

export const MODEL_V2 = {
  v: 2,
  pitchMaxFloors: 14,      // 放宽：老城的坡顶不再一过 9 层就没了
  setbackMinFloors: 4,
  antennaMinFloors: 8,     // 放宽：8 层以上就能留天线
  antChance: 0.16,         // 够高的楼**另给一次**长天线的机会（天线不是 CBD 专属）
  densityCell: 160,
  densityMin: 600,         // 3×3 楼面密度 ≥ 600 千 m² ⇒ 按 CBD 抽（实测约命中 12% 的楼）
  glassW: 1.3,             // 玻璃（材质 2）权重乘子：CBD 之外也让"混合"片出点玻璃楼
  roof: {
    // 平顶从 48% 压到 ~32%：三片街区都往下调，坡顶/退台/机组补上来
    oldtown: [['pitched', 5], ['flat', 3], ['tank', 1], ['mech', 1]],
    housing: [['flat', 3], ['tank', 2], ['mech', 2], ['setback', 2], ['pitched', 1]],
    cbd: [['mech', 3], ['tank', 2], ['antenna', 3], ['setback', 3], ['flat', 3], ['pitched', 1]],
    mixed: [['flat', 4], ['tank', 2], ['mech', 1], ['pitched', 2], ['setback', 1]],
  },
};

/** 权重乘子的键（URL 里 `?flatW=0` 就是把平顶权重乘 0 ⇒ 一栋平的都不抽） */
export const ROOF_KEYS = ['flat', 'pitched', 'tank', 'mech', 'setback', 'antenna'];

/** 数值参数的别名表：URL 名（小写）→ 参数名。整档回退的 `?modeling=1` 单独处理 */
const PARAM_ALIAS = {
  pitchmax: 'pitchMaxFloors', setmin: 'setbackMinFloors', antmin: 'antennaMinFloors',
  antp: 'antChance', densitycell: 'densityCell', densitymin: 'densityMin', glassw: 'glassW',
  flatw: 'flatW', pitchw: 'pitchedW', tankw: 'tankW', mechw: 'mechW', setbackw: 'setbackW', setw: 'setbackW', antw: 'antennaW',
};

/** 浏览器里默认读 location.search；node 里没有 location ⇒ 空串（默认档） */
export function defaultSearch() {
  try { return (globalThis.location && globalThis.location.search) || ''; } catch { return ''; }
}

/** `?a=1&b=2.5` → { a: 1, b: 2.5 }（非数值的键原样丢掉；`?flag` 当 1） */
export function queryNumbers(search = defaultSearch()) {
  const out = {};
  for (const kv of String(search || '').replace(/^\?/, '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = (i < 0 ? kv : kv.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1));
    const n = Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function applyParams(m, src) {
  if (!src) return m;
  // 参数名大小写不敏感（URL 里 `?pitchMaxFloors=14` 与 `?pitchMax=14` 等价；别名见 PARAM_ALIAS）
  const byLower = {};
  for (const k of Object.keys(m)) byLower[k.toLowerCase()] = k;
  for (const [k, raw] of Object.entries(src)) {
    if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) continue;
    const lk = String(k).toLowerCase();
    const name = PARAM_ALIAS[lk] || byLower[lk];
    if (name && name in m && typeof m[name] === 'number') m[name] = Number(raw);
  }
  return m;
}

/**
 * 参数解析：默认 v2 ⇒ URL query 覆盖 ⇒ 显式传进来的 opts 覆盖（测试用这个注入口）。
 * `?modeling=1` = 整档回到改动前的分布；单个旋钮（`?pitchMax=` / `?flatW=` / `?glassW=` …）照常可用。
 *
 * ⚠️ 为什么主键叫 `modeling` 而不是 `model`：`?model=<glb 路径>` 已经被**骨骼角色**占了
 * （main.mjs 的 `Q.get('model')` 是换模型用的，README 里有记载）。`?model=1` 仍当别名认
 * （主人要的那句"一键回旧分布"照旧能用），但**只在值是数字 1 时**才触发回退 ⇒
 * `?char=skinned&model=./x.glb` 这种路径值不会误触发。
 */
export function resolveModel(opts = {}, search) {
  const q = queryNumbers(search === undefined ? defaultSearch() : search);
  const v = Number.isFinite(Number(opts.v)) ? Number(opts.v)
    : Number.isFinite(Number(opts.modeling)) ? Number(opts.modeling)
      : Number.isFinite(Number(opts.model)) ? Number(opts.model)
        : ((q.modeling === 1 || q.model === 1) ? 1 : 2);
  const base = v === 1 ? MODEL_V1 : MODEL_V2;
  const m = {
    ...base,
    roof: Object.fromEntries(Object.entries(base.roof).map(([k2, t]) => [k2, t.map((p) => [p[0], p[1]])])),
    glassW: base.glassW !== undefined ? base.glassW : 1,
  };
  for (const k2 of ROOF_KEYS) m[k2 + 'W'] = 1;
  applyParams(m, q);
  applyParams(m, opts);
  return m;
}

/** 这一片街区的屋顶权重（套上 `?flatW=` 之类的乘子；表里没有的键不动） */
export function roofTableOf(model, key) {
  const table = model.roof[key] || model.roof.mixed;
  const one = (k) => (model[k] === undefined ? 1 : model[k]);
  if (ROOF_KEYS.every((k) => one(k + 'W') === 1)) return table;
  return table.map(([n, w]) => [n, w * one(n + 'W')]);
}

/** 这一片街区的材质权重（`?glassW=` 只乘玻璃那一档） */
export function matTableOf(model, key) {
  const table = (DISTRICTS[key] || DISTRICTS.mixed).mat;
  if ((model.glassW || 1) === 1) return table;
  return table.map(([n, w]) => [n, n === 2 ? w * model.glassW : w]);
}

/** 长尾高度：多数矮、少数高（u^2.2 让 70% 落在区间前 1/3） */
export function longTailFloors(rng, lo, hi, weight = 2.2) {
  const u = Math.pow(rng.next(), weight);
  return clamp(Math.round(lerp(lo, hi, u)), lo, hi);
}

/** 这一片（320m 邻域）是什么风格。`ctx.density` 够高时按 CBD 抽（见 DENSE_PAIRS），不再只看 zone */
export function districtOf(x, z, zone, rng, ctx = {}) {
  const nb = rngOf(hashSeed('nb3', Math.floor(x / 320), Math.floor(z / 320)));
  const model = ctx.model || MODEL_V2;
  const dense = ctx.density !== undefined && ctx.density >= model.densityMin;
  const pairs = dense ? DENSE_PAIRS : (DISTRICT_OF_ZONE[zone] || DISTRICT_OF_ZONE.mixed);
  const key = weighted(nb, pairs);
  return { key, def: DISTRICTS[key], rng: nb, dense };
}

/**
 * 大地块**再分割**：一刀切成 2~3 栋（带 2.5~4m 的缝），各自独立抽样风格。
 * 为什么要有：city.mjs 的地块最小面积是 2300 m²（那是 v1 的基线，不动），
 * 于是密度被钉死在"≈1 栋/2300 m²"——近处看着就稀。切一刀密度翻两三倍，
 * 而且**同一片街区不再是一排同款板楼**（每块独立种子）。缝宽 ≥2.5m 也满足了"楼间最小间距 ≥2m"。
 */
/** 一刀切：把一块沿长边切成 k 份（缝 ≥2.5m，满足"楼间最小间距 ≥2m"） */
function cutAlong(src, rng, k) {
  const along = src.w >= src.d;
  const L = along ? src.w : src.d;
  const gap = rng.range(2.6, 4.2);
  const one = (L - gap * (k - 1)) / k;
  if (one < 9) return null;
  const parts = [];
  for (let i = 0; i < k; i++) {
    const f = one * rng.range(0.85, 1.15);
    const off = -L / 2 + i * (one + gap) + one / 2;
    const lx = along ? off : 0, lz = along ? 0 : off;
    parts.push({
      ...src,
      x: src.x + lx * src.cos - lz * src.sin,
      z: src.z + lx * src.sin + lz * src.cos,
      w: along ? f : src.w,
      d: along ? src.d : f,
      seed: hashSeed('split3', src.seed, i, k),
      podium: null, tower: null, wing: null,
    });
  }
  return parts;
}

/**
 * 地块再分割。**先治"细长巨块"再谈密度**：
 * city.mjs 的街区是连通域的 bbox，实测能出 1600m × 20m 这种细条 ⇒ 会生成一栋 1.6km 长的楼，
 * 它压在路上、把整条街堵死（探针里"可通行自测"只走了 51m 就是被它挡的）。
 * 所以先把最长边切到 ≤90m，再按面积随机切一刀。
 */
function splitParcel(src, rng) {
  let parts = [src];
  for (let it = 0; it < 6; it++) {
    let changed = false;
    const next = [];
    for (const p of parts) {
      const m = Math.max(p.w, p.d);
      if (m > MAX_SIDE) {
        const cut = cutAlong(p, rng, Math.min(6, Math.ceil(m / MAX_SIDE + 0.4)));
        if (cut) { next.push(...cut); changed = true; continue; }
      }
      next.push(p);
    }
    parts = next;
    if (!changed) break;
  }
  const area = src.w * src.d;
  if (area < 1100 || !rng.chance(0.5)) return parts;
  const out = [];
  for (const p of parts) {
    const a = p.w * p.d;
    if (a < 1100) { out.push(p); continue; }
    const k = a > 2600 && rng.chance(0.5) ? 3 : 2;
    const cut = cutAlong(p, rng, k);
    out.push(...(cut || [p]));
  }
  return out;
}

/**
 * 给一栋楼抽样风格（高度/材质/体量/屋顶/立面处理），原地改 b。
 * 返回 'building' | 'vacant'。
 * `ctx` = { model, density }：model 是解析好的参数表（门槛 + 权重），density 是这一点的邻域楼面密度。
 */
function styleOne(b, rng, zone, stats, ctx) {
  {
    const src = b;
    const model = ctx.model;
    const district = districtOf(b.x, b.z, zone, rng, ctx);
    const def = district.def;
    const dist = Math.hypot(b.x, b.z);
    const landmark = zone === 'core' && rng.chance(0.05) && dist < 420;
    let floors = longTailFloors(rng, def.floors[0], def.floors[1]);
    if (landmark) { floors = Math.round(def.maxTall * rng.range(0.85, 1.25)); stats.landmarks++; }
    else if (rng.chance(0.05)) floors = clamp(floors + rng.int(6, 14), 2, def.maxTall);
    floors = clamp(floors, 2, 60);
    let material = weighted(rng, ctx.mat[district.key] || ctx.mat.mixed);
    if (landmark) material = rng.chance(0.75) ? 2 : 1;
    b.floors = floors;
    b.h = floors * 3.3;
    b.material = material;
    b.seed = hashSeed('s3', src.seed, floors, material);
    b.balcony = rng.chance(def.balcony);
    b.bay = rng.chance(def.bay) ? rng.range(0.35, 0.55) : 0;
    b.uScale = rng.pick([1, 1, 1.12, 0.86]);
    b.shop = rng.chance(def.shop);
    b.district = district.key;
    b.landmark = landmark;
    b.tint = (TINTS[district.key] || TINTS.mixed)[rng.int(0, (TINTS[district.key] || TINTS.mixed).length - 1)]
      .map((v) => v * rng.range(0.93, 1.07));
    stats.districts[district.key] = (stats.districts[district.key] || 0) + 1;
    stats.mats[material] = (stats.mats[material] || 0) + 1;
    stats.sumFloors += floors;
    stats.floorsMin = Math.min(stats.floorsMin, floors); stats.floorsMax = Math.max(stats.floorsMax, floors);
    if (!landmark && rng.chance(def.vacant)) return 'vacant';
    if (b.podiumFlag && floors >= 8 && rng.chance(def.podium)) {
      const pf = rng.int(1, 2);
      const k = rng.range(0.16, 0.32);
      const tw = b.w * (1 - k), td = b.d * (1 - k);
      if (tw >= 6.5 && td >= 6.5 && floors - pf >= 3) {
        b.podium = { floors: pf, h: pf * 4.4 };
        b.tower = { w: tw, d: td, floors: floors - pf, h: (floors - pf) * 3.3, ox: rng.range(-1, 1) * (b.w - tw) * 0.2, oz: rng.range(-1, 1) * (b.d - td) * 0.2 };
        b.h = b.podium.h + b.tower.h;
      } else b.podium = null;
    } else b.podium = null;
    if (!b.podium) b.tower = null;
    const aspect = Math.max(b.w, b.d) / Math.max(1, Math.min(b.w, b.d));
    if (!b.podium && aspect > 1.85 && b.w * b.d > 700 && rng.chance(0.4)) {
      const along = b.w >= b.d;
      const wf = rng.range(0.3, 0.45);
      const side = rng.sign();
      const geo = along
        ? { x: b.x + side * (b.w / 2 - b.w * wf / 2), z: b.z, w: b.w * wf, d: b.d }
        : { x: b.x, z: b.z + side * (b.d / 2 - b.d * wf / 2), w: b.w, d: b.d * wf };
      const wfl = clamp(floors + rng.int(-4, 6), 2, 60);
      b.wing = { ...geo, rot: b.rot, cos: b.cos, sin: b.sin, floors: wfl, h: wfl * 3.3, material: weighted(rng, ctx.mat[district.key] || ctx.mat.mixed) };
      if (along) b.w *= 1 - wf * 0.9; else b.d *= 1 - wf * 0.9;
    } else b.wing = null;
    b.roof = weighted(rng, ctx.roof[district.key] || ctx.roof.mixed);
    // 三条门槛（v2 放宽）+ 一条 v2 新增的"高楼长天线"
    if (b.roof === 'pitched' && floors > model.pitchMaxFloors) b.roof = 'flat';
    if (b.roof === 'setback' && floors < model.setbackMinFloors) b.roof = 'flat';
    if (b.roof === 'antenna' && floors < model.antennaMinFloors) b.roof = 'mech';
    // 天线不是 CBD 专属：够高的楼再给一次机会。概率 0（v1）时**不消费随机数** ⇒ 旧城逐字节不变
    if (model.antChance > 0 && b.roof !== 'antenna' && b.roof !== 'pitched'
      && floors >= model.antennaMinFloors && rng.chance(model.antChance)) b.roof = 'antenna';
    stats.roofs[b.roof] = (stats.roofs[b.roof] || 0) + 1;
    if (district.dense) stats.dense = (stats.dense || 0) + 1;
    return 'building';
  }
}

/**
 * 把 city.mjs 生成的楼**重新分配风格**（几何尺寸/位置不动，只动"长什么样"）。
 * 返回 { buildings, vacant, stats }：vacant 是"改成空地/停车场"的那些。
 *
 * opts：
 *   `share`  0 = 原样返回（`?variety=0`，v1 基线 A/B 用）
 *   `model`  参数覆盖（对象，最高优先级，测试注入口）
 *   `search` URL query 串（默认取浏览器的 location.search；`?model=1` = 回到旧分布）
 */
export function styleCity(city, opts = {}) {
  const share = opts.share !== undefined ? opts.share : 1;      // ?variety=0 → 0（原样返回）
  const model = resolveModel(opts.model || {}, opts.search);
  const out = [], vacant = [];
  const stats = { districts: {}, roofs: {}, mats: {}, landmarks: 0, vacant: 0, floorsMin: 99, floorsMax: 0, sumFloors: 0, split: 0, dense: 0, model: model.v };
  // 邻域楼面密度：**在一开始的城上算一次**（与风格参数无关 ⇒ 同一个城永远同一张密度图）
  const field = densityField(city.buildings || [], model.densityCell);
  const tables = {
    model, field,
    roof: Object.fromEntries(Object.keys(DISTRICTS).map((k) => [k, roofTableOf(model, k)])),
    mat: Object.fromEntries(Object.keys(DISTRICTS).map((k) => [k, matTableOf(model, k)])),
  };
  for (const src of city.buildings) {
    const b0 = { ...src, wing: src.wing ? { ...src.wing } : null, podium: src.podium ? { ...src.podium } : null, tower: src.tower ? { ...src.tower } : null };
    if (share <= 0) { out.push(b0); continue; }
    const rng = rngOf(hashSeed('style3', src.seed, (src.x * 3) | 0, (src.z * 3) | 0));
    const zone = src.zone || 'mid';
    const parts = splitParcel(b0, rng);
    if (parts.length > 1) stats.split++;
    for (let pi = 0; pi < parts.length; pi++) {
      const b = parts.length === 1 ? b0 : { ...b0 };
      Object.assign(b, parts[pi], { podium: null, tower: null, wing: null });
      b.podiumFlag = !!src.podium;
      const r2 = parts.length === 1 ? rng : rngOf(hashSeed('part3', src.seed, pi, parts.length));
      const k2 = { ...tables, density: field.at(b.x, b.z) };
      const kind = styleOne(b, r2, zone, stats, k2);
      if (kind === 'vacant') { vacant.push(b); stats.vacant++; } else out.push(b);
    }
  }
  stats.avgFloors = +(stats.sumFloors / Math.max(1, out.length)).toFixed(1);
  stats.density = { cell: model.densityCell, min: model.densityMin };
  return { buildings: out, vacant, stats, model };
}


export { TIERS, PAINT_TIER as PAINT };
