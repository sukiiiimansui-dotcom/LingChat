// local-roads.mjs —— App 独立页与原型之间的**唯一**一层胶水（原型 16 个文件逐字节没动，见 WS3D-IN-APP.md）。
//
// ## 为什么要有它
// 原型（`ws3dgl-three.html` + `ws3dgl/**`）取数的两跳都指着本机开发服务：
//   ① `:8790/api/osm_cache` 拿"有哪些路网缓存键"（`data.mjs:41-43` → `:57 indexCache`）；
//   ② 再按键去 8788 静态取 `worlddata/osm/<key>.json`（`data.mjs:139-165`）。
// 可 **APK 里没有 8790**（没人监听那个端口），而路网本来就在 App 自己的 `public/roadsbundle/` 里
// （69 格 / 5.92 MB / 24,704 条，schema `{key, roads:[{i,r,n,p}]}`）。所以这一层把请求就地答掉：
//
//   · `:8790/api/*`              → **全部本地应答**（一个包都不出网；探针判据「:8790 命中 0 次」就靠这条）
//   · `/api/osm_cache`           → `./roads-index.json`（由 `world_map/ws3d_make_index.mjs` 从 roadsbundle 生成）
//   · `worlddata/osm/<键>.json`  → `/roadsbundle/<格>.json` + **schema 转换**（下面是逐字段对照）
//   · 其它一切（`three.min.js`、`*.mjs`、`/roadsbundle/…`）原样放行 `fetch`
//
// 🔴 **必须在 `three/main.mjs` 之前 import**（`index.html` 里就是那个顺序）：`main.mjs` 在模块求值期
//    就把 `location.search` 读完了，晚一步装钩子就等于没装。
//
// ## schema 转换（roadsbundle → 原型 `parseOsmRoads` 要的形状，`data.mjs:124-136`）
//   `{i, r, n, p}` ──► `{type:"way", id, tags:{highway, name}, geometry:[{lat, lon}]}`
//   · `id`       = `i`（OSM way id；`data.mjs:156` 拿它当去重键 ⇒ 重叠格里的同一条路只会留一份）
//   · `highway`  = rank→等级（`prerender_pipeline.py:105-110 HIGHWAY_RANK`
//                  0 快速路 / 1 主干 / 2 次干 / 3 支路，注释逐字写着"与 wsRoads.ts 的 rank 一致"）。
//                  ⚠️ 这一步**是有损的**：roadsbundle 只留了 4 档，原始的 residential/service 已经不在包里，
//                  所以 3 档一律按 tertiary 建模（`city.mjs:14-19 ROAD_SPEC` 里 tertiary = 8 m）。
//   · `name`     = `n`（真 OSM 名字，57.7% 有）
//   · `geometry` = `p` 的 `[lng,lat]` → `{lat, lon}`（⚠️ 原型读的是 **`lon`** 不是 `lng`）
//
// ## 一个格 5.5 km，而这一页只画半径 300 m ⇒ 格集合由**本层**按 App 自己的口径算
// 原型的 `pickRoadCaches()`（`data.mjs:72-118`）把每个缓存当"圆心 + 半径"的圆来做贪心集合覆盖。
// roadsbundle 的格是 0.05° 方块（≈5.5×4.8 km），**一个格就盖满整个 300 m 视盘** ⇒ 贪心只会挑 1 个，
// 而挑中的那个未必是"脚下这一格"（命中哪一格取决于 bytes/elements 的性价比）。真让它挑错，
// 表现是**静默**的：包里明明读到了几百条路，城里却一条真路都没有（全被 `city.mjs:46-50` 的
// `reach = radius*1.18` 裁掉了）。所以这里改成：**每次取路文件都回"这一页真正需要的格"的并集**
// （`neededCells()`），下游 `data.mjs:147-159` 按 OSM id 去重 ⇒ 并集的结果是精确的，重复只是字节。
// 索引里那条自己的能力（`cell`）也一并并进去，保证"你要的那个文件一定在答复里"。
import { M_PER_DEG_LAT } from './ws3dgl/util.mjs';

const rawFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null;
const Q = new URLSearchParams(location.search);
const numQ = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);

/** 页面中心：`?lat/?lng` 优先；没有就退回原型自己的默认值（`three/main.mjs:540` 同一对数） */
const CENTER = { lat: numQ('lat', 29.5689), lng: numQ('lng', 106.5577) };
/** 渲染半径：与原型 `three/main.mjs:36 state.radius = num('r', 1000)` 同一口径 */
const RADIUS = numQ('r', 1000);
/** 「所在」那行显示什么（App 侧传 `?name=<角色名>`） */
const AREA = Q.get('name') || '离线路网包';
/**
 * 除视盘之外还要多要的一圈：原型选址会把整座城**平移**到"真路最密 + 真能盖出楼"的候选点
 * （`urban.mjs:176-190`；候选点铺在 250 m 网格上、`maxDist = radius*2.2 = 660 m` ⇒ 对角线 ≤ 707 m）。
 * 不把这一圈算进来，城一平移就会移到没有真路的空白上（`fillStreets` 只能补合成路）。
 */
const SHIFT_M = 750;

/** App 的格数学：`wsFeatureStore.ts:233-241`（`bundleCellOf` / `bundleCellKey`）逐字，边长取 `:222 ROADS_BUNDLE_CELL_DEG = 0.05` */
const CELL = 0.05;
function bundleCellOf(lng, lat, size = CELL) {
  const w = Math.floor(lng / size) * size;
  const s = Math.floor(lat / size) * size;
  return { w: +w.toFixed(5), s: +s.toFixed(5) };
}
function bundleCellKey(w, s, size = CELL) {
  return `${w.toFixed(5)}_${s.toFixed(5)}_${size}`;
}

/**
 * 这一页真正需要的格（口径 = `wsFeatureStore.ts:264-293 bundleCellsForView`：同款**整数格号**枚举，
 * 避免 `(e-w)/size` 的浮点抖动多算一整行；同样"按离中心的距离近的先取"）。
 */
export function neededCells() {
  const span = RADIUS + SHIFT_M;
  const dLat = span / M_PER_DEG_LAT;
  const dLng = span / (M_PER_DEG_LAT * Math.max(0.02, Math.cos((CENTER.lat * Math.PI) / 180)));
  const i0 = Math.floor((CENTER.lng - dLng) / CELL), i1 = Math.floor((CENTER.lng + dLng) / CELL);
  const j0 = Math.floor((CENTER.lat - dLat) / CELL), j1 = Math.floor((CENTER.lat + dLat) / CELL);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const w = +((i * CELL).toFixed(5)), s = +((j * CELL).toFixed(5));
      const d = Math.hypot((w + CELL / 2 - CENTER.lng) * M_PER_DEG_LAT * Math.cos((CENTER.lat * Math.PI) / 180), (s + CELL / 2 - CENTER.lat) * M_PER_DEG_LAT);
      out.push({ key: bundleCellKey(w, s), w, s, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/* ── 取数：索引 + 格文件（都从本页同源的相对路径拿；读过的格缓存住，重复请求不再读盘）── */
const idxUrl = new URL('./roads-index.json', import.meta.url);
let indexP = null;                      // Promise<索引 JSON>
const cellCache = new Map();            // 格名 → {key, roads:[…]} 原样 JSON
const unionCache = new Map();           // 并集签名 → 响应文本
const stat = { osmCache: 0, apiCalls: [], roadFiles: [], payloadCells: [], errors: [] };

function loadIndex() {
  if (!indexP) {
    indexP = rawFetch(idxUrl.href, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`roads-index.json HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { stat.errors.push('索引读不到：' + e.message); throw e; });
  }
  return indexP;
}

function loadCell(cell) {
  if (!cellCache.has(cell)) {
    const url = new URL(`../roadsbundle/${cell}.json`, import.meta.url);
    cellCache.set(cell, rawFetch(url.href, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch((e) => { stat.errors.push(`格 ${cell} 读不到：${e.message}`); return null; }));
  }
  return cellCache.get(cell);
}

/** 一格的 roads → 原型 `elements[]`（见文件头逐字段对照） */
const RANK_HW = ['motorway', 'primary', 'secondary', 'tertiary'];   // HIGHWAY_RANK 的四档
function elementsOf(json) {
  const out = [];
  for (const r of (json && json.roads) || []) {
    const p = Array.isArray(r && r.p) ? r.p : [];
    if (p.length < 2) continue;                                       // `data.mjs:133` 要求 ≥2 个点
    const geometry = [];
    for (const pt of p) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      geometry.push({ lat: pt[1], lon: pt[0] });
    }
    if (geometry.length < 2) continue;
    const id = r.i !== undefined && r.i !== null && r.i !== '' ? String(r.i) : `syn:${p[0][0]},${p[0][1]}`;
    out.push({ type: 'way', id, tags: { highway: RANK_HW[Number(r.r)] || 'tertiary', name: r.n || '' }, geometry });
  }
  return out;
}

/** 把若干格并成一次响应（下游按 OSM id 去重 ⇒ 并集是精确的） */
async function roadPayload(cells) {
  const sig = cells.join('|');
  if (unionCache.has(sig)) return unionCache.get(sig);
  const parts = await Promise.all(cells.map((c) => loadCell(c)));
  const elements = [];
  let roads = 0;
  for (const j of parts) {
    if (!j) continue;
    roads += (j.roads || []).length;
    elements.push(...elementsOf(j));
  }
  const text = JSON.stringify({ local: 'public/roadsbundle', cells, roads, elements });
  unionCache.set(sig, text);
  stat.payloadCells = cells;
  return text;
}

/* ── 8790 的四个装饰端点：本地应答（原型对它们全是"拿不到就降级"，但别去撞一个不存在的端口）── */
function localApi(pathname, search) {
  const now = new Date();
  if (pathname === '/api/osm_cache') {
    return loadIndex().then((idx) => ({ count: idx.count || (idx.files || []).length, files: idx.files || [] }));
  }
  if (pathname === '/api/location') {
    return Promise.resolve({ lat: CENTER.lat, lng: CENTER.lng, area: AREA, path: [{ name: AREA }], local: true });
  }
  if (pathname === '/api/time') {
    const p2 = (n) => String(n).padStart(2, '0');
    return Promise.resolve({
      date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
      time: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
      period: now.getHours() < 6 ? '凌晨' : now.getHours() < 12 ? '上午' : now.getHours() < 18 ? '下午' : '晚上',
      ts: now.getTime(), local: true,
    });
  }
  if (pathname === '/api/schedule') return Promise.resolve({ roles: [], local: true });
  if (pathname === '/api/osm_area') {
    // 只有"这一页会取哪些格"是真的，元素数按索引里的 roads 求和（不编）
    return loadIndex().then((idx) => {
      const want = new Set(neededCells().map((c) => c.key));
      const files = (idx.files || []).filter((f) => want.has(f.cell));
      return {
        cached: true, radius: numQ('r', 1000), cells: files.length,
        elements: files.reduce((a, f) => a + (f.elements || 0), 0),
        source: 'public/roadsbundle', local: true,
      };
    });
  }
  return Promise.resolve({ local: true, path: pathname, note: '独立页没有这个端点，如实回空' });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

if (rawFetch) {
  window.fetch = async function localFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href);
    } catch {
      return rawFetch(input, init);
    }
    try {
      /* ① 一切 8790 的 API：就地答（APK 里那个端口根本不存在） */
      if (url.port === '8790') {
        stat.osmCache += url.pathname === '/api/osm_cache' ? 1 : 0;
        stat.apiCalls.push(url.pathname);
        return jsonResponse(await localApi(url.pathname, url.search));
      }
      /* ② 原型的路网文件请求：`worlddata/osm/<键>.json`（相对本页 ⇒ 落在 `public/ws3d/worlddata/osm/`）*/
      const m = /\/worlddata\/osm\/([^/]+)\.json$/.exec(url.pathname);
      if (m) {
        const key = decodeURIComponent(m[1]);
        const idx = await loadIndex().catch(() => null);
        const rec = idx && (idx.files || []).find((f) => f.key === key);
        if (!rec) {
          stat.errors.push(`索引里没有这个键：${key}`);
          return jsonResponse({ error: 'unknown cache key', key, elements: [] }, 404);
        }
        const cells = neededCells().map((c) => c.key);
        if (!cells.includes(rec.cell)) cells.unshift(rec.cell);      // "你要的那一格一定在答复里"
        stat.roadFiles.push({ key, cell: rec.cell, asked: cells.length });
        return new Response(await roadPayload(cells), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
    } catch (e) {
      stat.errors.push(String((e && e.message) || e));
      return jsonResponse({ error: String((e && e.message) || e), elements: [] }, 500);
    }
    return rawFetch(input, init);
  };
  window.__WS3DLOCAL__ = {
    stat,
    center: CENTER, radius: RADIUS, area: AREA, shiftM: SHIFT_M, cellSize: CELL,
    neededCells: () => neededCells().map((c) => c.key),
    indexUrl: idxUrl.href,
  };
}
