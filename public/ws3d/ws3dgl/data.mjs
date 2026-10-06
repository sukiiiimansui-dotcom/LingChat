// data.mjs —— 取数层：8790 的 API + 8788 的静态真数据（只读，不新造后端）。
//
// 实测结论（2026-10-06，本喵一条条打过）：
//   · 8790 **没有**"给我 footprint + 高度"的接口 —— /api/geo_json、/api/statistics 直接 404；
//     /api/buildings 只有 wsm-rs（8791，那是 Rust 调试服务，原型不依赖它）。
//   · 但 8790 有 `/api/osm_cache`：它列出 worlddata/osm/ 下**所有**缓存键（含 `road_*`），
//     键里带网格中心（A*0.002, B*0.002）与半径 ⇒ 这就是一份**真数据的索引**。
//   · 文件本体由 8788 静态直接给（同一台机、同一个 docroot），所以页面不必造后端。
//
// 于是数据通路 = 8790 给索引 + 8788 给真几何。取不到就如实降级，绝不自己编数据当"真路网"。

import { projectLL, metersPerDegLng, M_PER_DEG_LAT } from './util.mjs';

export const API_BASE = (() => {
  // 没有 location（node 里跑自检/量密度脚本）时**必须**同时给 host：
  // 只给 hostname 的话下面 `loc.port === '8790'` 会命中第一个分支，拼出 `http://undefined`
  // （2026-10-06 实测：v1 只在浏览器里跑所以没暴露，three 版的 node 量测脚本一头撞上）
  const loc = typeof location !== 'undefined' ? location : { port: '8790', protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:8790' };
  if (loc.port === '8790') return `${loc.protocol}//${loc.host}`;
  return `${loc.protocol || 'http:'}//${loc.hostname || '127.0.0.1'}:8790`;
})();

export async function fetchJson(url, timeoutMs = 12000) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ac ? ac.signal : undefined });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* 非 JSON：保留 text 供诊断 */ }
    return {
      ok: r.ok, status: r.status, url, bytes: txt.length, json,
      ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
    };
  } catch (e) {
    return { ok: false, status: 0, url, error: String(e && e.message ? e.message : e), ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
  } finally { if (timer) clearTimeout(timer); }
}

export async function apiGet(path, timeoutMs) {
  return fetchJson(API_BASE + path, timeoutMs);
}

/** 键名 → {prefix, lat, lng, radius}；解不出来返回 null */
export function parseCacheKey(key) {
  const m = /^(?:(bldg|road|gw|green|water|amenity|places)_)?(-?\d+)_(-?\d+)_([\d.]+)$/.exec(key);
  if (!m) return null;
  const g = 0.002;
  return {
    key, prefix: m[1] || '', lat: parseInt(m[2], 10) * g, lng: parseInt(m[3], 10) * g,
    radius: parseFloat(m[4]),
  };
}

/** /api/osm_cache 的 files[] → 分类索引 */
export function indexCache(files) {
  const out = { road: [], bldg: [], other: [], bad: [] };
  for (const f of files || []) {
    const p = parseCacheKey(f.key);
    if (!p) { out.bad.push(f.key); continue; }
    const rec = Object.assign({}, f, p);
    if (p.prefix === 'road') out.road.push(rec);
    else if (p.prefix === 'bldg') out.bldg.push(rec);
    else out.other.push(rec);
  }
  out.road.sort((a, b) => a.radius - b.radius);
  return out;
}

/** 贪心挑真路网缓存：用 25m 粗网格估"每字节能新盖多少面积"，够覆盖就停 */
export function pickRoadCaches(roadKeys, lat, lng, radius, opts = {}) {
  const maxFiles = opts.maxFiles || 10;
  const maxBytes = opts.maxBytes || 3.5e6;
  const S = 25;
  const cells = [];
  for (let i = -Math.ceil(radius / S); i <= Math.ceil(radius / S); i++) {
    for (let j = -Math.ceil(radius / S); j <= Math.ceil(radius / S); j++) {
      const x = i * S + S / 2, z = j * S + S / 2;
      if (x * x + z * z <= radius * radius) cells.push([x, z]);
    }
  }
  const cand = roadKeys
    .map((r) => {
      const c = projectLL(r.lat, r.lng, lat, lng);
      const d = Math.hypot(c.x, c.z);
      if (d - r.radius > radius) return null;
      const cov = [];
      cells.forEach(([x, z], i) => { if ((x - c.x) ** 2 + (z - c.z) ** 2 <= r.radius * r.radius) cov.push(i); });
      if (!cov.length) return null;
      return { rec: r, cov, bytes: r.bytes || 1e5, elements: r.elements || 100, dist: Math.round(d) };
    })
    .filter(Boolean);
  const covered = new Set();
  const picked = [];
  let bytes = 0;
  while (covered.size < cells.length && picked.length < maxFiles) {
    let best = null;
    for (const c of cand) {
      if (c.used) continue;
      const gain = c.cov.filter((i) => !covered.has(i)).length;
      if (!gain) continue;
      const estNew = Math.max(1, (c.elements * gain) / c.cov.length);
      const score = c.bytes / estNew;
      if (!best || score < best.score) best = { c, score, gain };
    }
    if (!best || bytes + best.c.bytes > maxBytes) break;
    best.c.used = true;
    best.c.cov.forEach((i) => covered.add(i));
    picked.push(best.c.rec);
    bytes += best.c.bytes;
  }
  return {
    picked, bytes,
    coveragePct: +((covered.size / Math.max(1, cells.length)) * 100).toFixed(1),
    candidates: cand.length,
  };
}

const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential',
  'living_street', 'service', 'pedestrian', 'track']);

/** Overpass elements（way + geometry）→ 本地米折线 */
export function parseOsmRoads(elements, lat0, lng0, opts = {}) {
  const roads = [];
  for (const e of elements || []) {
    if (e.type !== 'way' || !e.geometry) continue;
    const hw = (e.tags || {}).highway;
    if (!hw || !DRIVABLE.has(hw)) continue;
    if (opts.onlyDrive !== false && !DRIVABLE.has(hw)) continue;
    const pts = e.geometry.map((g) => projectLL(g.lat, g.lon, lat0, lng0));
    if (pts.length >= 2) roads.push({ cls: hw, pts, osmId: e.id, name: (e.tags || {}).name || '' });
  }
  return roads;
}

/** 拉真路网：索引给键 → 8788 静态取文件（同源，相对路径） */
export async function loadRealRoads(pick, lat0, lng0, opts = {}) {
  const base = opts.base || 'worlddata/osm/';
  const out = { roads: [], files: [], errors: [], bytes: 0 };
  const results = await Promise.all(pick.picked.map(async (rec) => {
    const url = new URL(`${base}${rec.key}.json`, opts.pageUrl || (typeof location !== 'undefined' ? location.href : 'http://127.0.0.1:8788/'));
    const r = await fetchJson(url.href, opts.timeoutMs || 20000);
    return { rec, r };
  }));
  // ⚠️ 必须按 OSM way id 去重：缓存文件是**重叠的圆**，同一条路会在好几个文件里出现
  //    （实测不去重会出现 5124 条 / 1200km 的假里程，去掉后才是真实路网）
  const seen = new Set();
  for (const { rec, r } of results) {
    if (!r.ok || !r.json) { out.errors.push(`${rec.key}: HTTP ${r.status} ${r.error || ''}`); continue; }
    const els = r.json.elements || [];
    const roads = parseOsmRoads(els, lat0, lng0);
    let added = 0;
    for (const rd of roads) {
      const k = rd.osmId !== undefined ? 'w' + rd.osmId : `h${rd.pts[0].x.toFixed(1)}_${rd.pts[0].z.toFixed(1)}`;
      if (seen.has(k)) continue;
      seen.add(k); out.roads.push(rd); added++;
    }
    out.files.push({ key: rec.key, radius: rec.radius, roads: roads.length, added, bytes: r.bytes, lat: rec.lat, lng: rec.lng });
    out.bytes += r.bytes;
  }
  out.unique = out.roads.length;
  return out;
}

/** 一步到位：8790 索引 → 选片 → 8788 取几何 */
export async function loadRoadNetwork({ lat, lng, radius, osmCacheJson, pageUrl }) {
  const idx = indexCache((osmCacheJson && osmCacheJson.files) || []);
  const pick = pickRoadCaches(idx.road, lat, lng, radius);
  const got = await loadRealRoads(pick, lat, lng, { pageUrl });
  return { index: idx, pick, ...got };
}
