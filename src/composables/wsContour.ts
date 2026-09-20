/**
 * wsContour.ts —— **真等高线**：Terrarium DEM → marching squares → GeoJSON 线
 *
 * ## 为什么是这个数据源（2026-09-19 实测，不是二手信息）
 * · `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`
 *   → **200 / 43KB / 3~4.6s**，且 **CORS 允许**（`Access-Control-Allow-Origin: *`）
 *   ⇒ 浏览器可以直连取像素、`getImageData` 不会被污染（taint）。
 * · 同刻实测**不通**的地形源：`tile.openstreetmap.org`、`a.tile.opentopomap.org`、
 *   `server.arcgisonline.com/…/World_Topo_Map`（**这三个才自带等高线**）、`tiles.stadiamaps.com`
 *   全部超时 —— 所以"拿一张带等高线的瓦片"这条路目前走不通，改成**自己算**。
 * · 仓库自带的 `src-tauri/assets/elev_cn.json` 是 **1° 步长（≈111km）** 的着色用数据，
 *   画等高线远远不够，不能拿来充数。
 *
 * ## 分工（纪律：纯函数与取数分开，纯函数必须能脱网验收）
 * · **纯函数**（本文件大部分）：瓦片坐标换算 / Terrarium 解码 / marching squares / GeoJSON 组装
 *   —— 自检 `world_map/ws_contour_selftest.mjs` 用合成 DEM 全量验，不需要浏览器。
 * · **唯一碰 DOM 的函数** `readDemGrid()`：`fetch` → `createImageBitmap` → canvas 取像素。
 *
 * ## 已知取舍（如实写）
 * · 线段**不合并成折线**：相邻单元共享同一个插值端点，视觉上是连续的；
 *   合并要建拓扑（成本高、收益只有"少几条 feature"），当前不做。
 * · 只取**中心那一张** DEM 瓦片（z=12 时约 9.5km 见方 ≈ 重庆纬度 8km），
 *   所以视野拉远时等高线只覆盖中心区域 —— 由调用方决定"太远就不画"。
 */

/** DEM 瓦片层级：z=12 ⇒ 每像素约 38m（赤道）/ 重庆纬度约 32m，够画 20m 间隔的等高线 */
export const DEM_TILE_Z = 12;
/** 瓦片像素边长（Terrarium 固定 256） */
export const DEM_TILE_SIZE = 256;
/** Terrarium 高程编码的零点（RGB 打包后的中值 = 海平面） */
export const TERRARIUM_OFFSET = 32768;

/** 瓦片 URL（纯字符串拼接，便于自检） */
export function demTileUrl(z: number, x: number, y: number): string {
  return `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
}

/**
 * Terrarium 解码：`elevation = (R * 256 + G + B / 256) - 32768`（米）。
 * ⚠️ 别写成 `R*256*256` —— Terrarium 与 Mapbox RGB 编码**不是**同一套（这是常见错误来源）。
 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - TERRARIUM_OFFSET;
}

/** 经纬度 → 瓦片小数坐标（Web Mercator，OSM 约定） */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** 瓦片内像素 (i,j) → 经纬度（`n` = 瓦片像素边长） */
export function tilePixelToLngLat(
  z: number,
  tx: number,
  ty: number,
  i: number,
  j: number,
  n: number = DEM_TILE_SIZE
): { lng: number; lat: number } {
  return globalPixelToLngLat(z, tx * n + i, ty * n + j, n);
}

/**
 * **全局像素**坐标 → 经纬度（`n` = 瓦片边长）。
 *
 * 为什么要有它：多瓦片拼接后，格点坐标不再是"某张瓦片内的 (i,j)"，而是**跨瓦片的全局像素**。
 * `tilePixelToLngLat` 现在只是它的特例（`gx = tx*n + i`）—— 两者口径**必须**是同一个，
 * 否则拼接出来的等高线会整体偏移一格（这类"差一格"的 bug 极难肉眼发现）。
 */
export function globalPixelToLngLat(
  z: number,
  gx: number,
  gy: number,
  n: number = DEM_TILE_SIZE
): { lng: number; lat: number } {
  const n2 = 2 ** z;
  const lng = ((gx / n) / n2) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (gy / n)) / n2))) * 180) / Math.PI;
  return { lng, lat };
}

/**
 * 按**地图缩放**选 DEM 层级（视野越广 → 用越粗的 DEM）。
 *
 * 为什么不能只用 z12：z12 一张瓦片 ≈ 8~9.5km 见方 —— 省/市级视野下要拼几十张才够，
 * 手机扛不住（也白费流量）；而 z9 一张瓦片 ≈ 70km，几张就覆盖一个省。
 */
export function demZoomForMapZoom(mapZoom: number): number {
  const z = Number.isFinite(mapZoom) ? mapZoom : 12;
  if (z < 7) return 9;
  if (z < 9) return 10;
  if (z < 11) return 11;
  if (z < 13) return 12;
  return 13;
}

/** 按地图缩放选**等高距**（米）：广视野用大间隔，近景用小间隔（否则线密到糊成一片） */
export function intervalForMapZoom(mapZoom: number): number {
  const z = Number.isFinite(mapZoom) ? mapZoom : 12;
  /* ⚠️ 实测：z11 用 50m 间隔会算出 **5.6 万段**（2×2 张 z12 瓦片，山城地形）——
     手机上偏重，而广视野本来就该用更粗的间隔。所以 z<12 一律 100m。 */
  if (z < 8) return 200;
  if (z < 12) return 100;
  if (z < 14) return 50;
  return 20;
}

/** 一张 DEM 瓦片的高程格（`tx/ty` 是它的瓦片坐标，`size` 一般是 256） */
export interface DemPart {
  tx: number;
  ty: number;
  grid: ArrayLike<number>;
  size?: number;
}

/**
 * 把多张瓦片的高程格**拼成一张大格**（按 tx/ty 求最小外接矩形）。
 *
 * ⚠️ 没提供的瓦片区域**保持 0**（= 海平面）—— 调用方要么给齐矩形内的所有瓦片，
 * 要么接受那片区域会出现"贴着边界的假等高线"。真实调用里我们是按矩形一次性取齐的。
 */
export function stitchGrids(
  parts: readonly DemPart[],
  n: number = DEM_TILE_SIZE
): { grid: Float32Array; w: number; h: number; tx0: number; ty0: number; missing: number } {
  if (!parts?.length) return { grid: new Float32Array(0), w: 0, h: 0, tx0: 0, ty0: 0, missing: 0 };
  let tx0 = Infinity;
  let ty0 = Infinity;
  let tx1 = -Infinity;
  let ty1 = -Infinity;
  for (const p of parts) {
    tx0 = Math.min(tx0, p.tx);
    ty0 = Math.min(ty0, p.ty);
    tx1 = Math.max(tx1, p.tx);
    ty1 = Math.max(ty1, p.ty);
  }
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const w = cols * n;
  const h = rows * n;
  const grid = new Float32Array(w * h);
  const seen = new Set<string>();
  for (const p of parts) {
    const size = p.size ?? n;
    const ox = (p.tx - tx0) * n;
    const oy = (p.ty - ty0) * n;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        grid[(oy + y) * w + (ox + x)] = Number(p.grid[y * size + x]) || 0;
      }
    }
    seen.add(`${p.tx},${p.ty}`);
  }
  return { grid, w, h, tx0, ty0, missing: cols * rows - seen.size };
}

/**
 * 取等高线层级序列（含上下界，步长 `interval`）。
 * `maxLevels` 是**防呆**：有人传 interval=1 时会炸出几千层，直接截断并保留最低的若干层。
 */
export function contourLevels(
  min: number,
  max: number,
  interval: number,
  maxLevels = 60
): number[] {
  if (!(interval > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  const first = Math.ceil(min / interval) * interval;
  const out: number[] = [];
  for (let v = first; v <= max + 1e-9; v += interval) {
    out.push(Math.round(v * 1000) / 1000);
    if (out.length >= maxLevels) break;
  }
  return out;
}

export type Seg = [[number, number], [number, number]];

/**
 * marching squares（带线性插值）—— 在 `w×h` 的高程格上取 `level` 的等值线段。
 *
 * 单元编号（tl=8, tr=4, br=2, bl=1）；鞍点（5/10）出两段，其余出一段。
 * 返回的坐标是**格点坐标**（可为小数），换算经纬度是调用方的事 —— 这样纯函数可脱网测。
 */
export function contourSegments(
  grid: ArrayLike<number>,
  w: number,
  h: number,
  level: number
): Seg[] {
  const out: Seg[] = [];
  if (w < 2 || h < 2 || grid.length < w * h) return out;
  const at = (x: number, y: number): number => Number(grid[y * w + x]);
  const lerp = (a: number, b: number): number => {
    const d = b - a;
    return Math.abs(d) < 1e-12 ? 0.5 : (level - a) / d;
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      let idx = 0;
      if (tl >= level) idx |= 8;
      if (tr >= level) idx |= 4;
      if (br >= level) idx |= 2;
      if (bl >= level) idx |= 1;
      if (idx === 0 || idx === 15) continue;
      const T: [number, number] = [x + lerp(tl, tr), y];
      const R: [number, number] = [x + 1, y + lerp(tr, br)];
      const B: [number, number] = [x + lerp(bl, br), y + 1];
      const L: [number, number] = [x, y + lerp(tl, bl)];
      switch (idx) {
        case 1:
        case 14:
          out.push([L, B]);
          break;
        case 2:
        case 13:
          out.push([B, R]);
          break;
        case 3:
        case 12:
          out.push([L, R]);
          break;
        case 4:
        case 11:
          out.push([T, R]);
          break;
        case 6:
        case 9:
          out.push([T, B]);
          break;
        case 7:
        case 8:
          out.push([L, T]);
          break;
        case 5: // 鞍点：tl 与 br 在上
          out.push([L, T], [B, R]);
          break;
        case 10: // 鞍点：tr 与 bl 在上
          out.push([T, R], [L, B]);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

export interface ContourFeature {
  type: "Feature";
  properties: { ele: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/**
 * 一张 DEM 瓦片 → 若干层等高线的 GeoJSON 要素（经纬度坐标）。
 * `minLevel/maxLevel` 不给就按格内实际高程范围推。
 */
export function tileContours(opts: {
  grid: ArrayLike<number>;
  w: number;
  h: number;
  z: number;
  tx: number;
  ty: number;
  interval: number;
  minLevel?: number;
  maxLevel?: number;
  maxLevels?: number;
}): ContourFeature[] {
  const { grid, w, h, z, tx, ty, interval } = opts;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < w * h && k < grid.length; k++) {
    const v = Number(grid[k]);
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [];
  const min = opts.minLevel ?? lo;
  const max = opts.maxLevel ?? hi;
  /* 委托给 stitchedContours（单张瓦片就是 1×1 的拼接）—— 两条路只留一份实现 */
  return stitchedContours({
    grid,
    w,
    h,
    z,
    tx0: tx,
    ty0: ty,
    n: w,
    interval,
    minLevel: min,
    maxLevel: max,
    maxLevels: opts.maxLevels ?? 60,
  });
}

/**
 * **拼接后的大格** → 等高线（坐标按**全局像素**换算）。
 * `tileContours` 是它在单张瓦片上的特例（`w=h=n, tx0=tx, ty0=ty`）——
 * 两条路口径必须一致，否则拼接出来的线会整体偏移（差一格的 bug 肉眼极难发现）。
 */
export function stitchedContours(opts: {
  grid: ArrayLike<number>;
  w: number;
  h: number;
  z: number;
  tx0: number;
  ty0: number;
  n?: number;
  interval: number;
  minLevel?: number;
  maxLevel?: number;
  maxLevels?: number;
}): ContourFeature[] {
  const { grid, w, h, z, tx0, ty0, interval } = opts;
  const n = opts.n ?? DEM_TILE_SIZE;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < w * h && k < grid.length; k++) {
    const v = Number(grid[k]);
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [];
  const levels = contourLevels(opts.minLevel ?? lo, opts.maxLevel ?? hi, interval, opts.maxLevels ?? 60);
  const feats: ContourFeature[] = [];
  for (const level of levels) {
    for (const [a, b] of contourSegments(grid, w, h, level)) {
      const p1 = globalPixelToLngLat(z, tx0 * n + a[0], ty0 * n + a[1], n);
      const p2 = globalPixelToLngLat(z, tx0 * n + b[0], ty0 * n + b[1], n);
      feats.push({
        type: "Feature",
        properties: { ele: level },
        geometry: { type: "LineString", coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]] },
      });
    }
  }
  return feats;
}

/**
 * **一次取数就够一个视野**：按地图缩放选 DEM 层级与等高距，取 `tiles×tiles` 张瓦片拼起来算线。
 * 这是"引擎层（国/省/市/区县）也要有等高线"的入口；唯一碰网络的地方（`readDemGrid`）。
 */
export async function contoursForView(opts: {
  lng: number;
  lat: number;
  mapZoom: number;
  tiles?: number;
  maxTiles?: number;
  maxLevels?: number;
}): Promise<{ feats: ContourFeature[]; demZ: number; interval: number; tiles: number; missing: number; ms: number }> {
  const t0 = Date.now();
  const demZ = demZoomForMapZoom(opts.mapZoom);
  const interval = intervalForMapZoom(opts.mapZoom);
  const n = DEM_TILE_SIZE;
  const c = lngLatToTile(opts.lng, opts.lat, demZ);
  const want = Math.max(1, Math.min(3, Math.round(opts.tiles ?? 2)));
  const maxTiles = Math.max(1, Math.min(9, opts.maxTiles ?? 9));
  const half = Math.floor(want / 2);
  const tx0 = Math.floor(c.x) - half;
  const ty0 = Math.floor(c.y) - half;
  const parts: DemPart[] = [];
  const tasks: Array<Promise<void>> = [];
  let budget = maxTiles;
  for (let dy = 0; dy < want; dy++) {
    for (let dx = 0; dx < want; dx++) {
      if (budget-- <= 0) break;
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      tasks.push(
        readDemGrid(demTileUrl(demZ, tx, ty), n)
          .then((grid) => {
            parts.push({ tx, ty, grid, size: n });
          })
          .catch(() => {
            /* 单张失败不影响其它张：stitch 会把缺口如实计进 missing */
          })
      );
    }
  }
  await Promise.all(tasks);
  if (!parts.length) throw new Error("DEM 全部取数失败");
  const st = stitchGrids(parts, n);
  const feats = stitchedContours({
    grid: st.grid,
    w: st.w,
    h: st.h,
    z: demZ,
    tx0: st.tx0,
    ty0: st.ty0,
    n,
    interval,
    maxLevels: opts.maxLevels ?? 60,
  });
  return { feats, demZ, interval, tiles: parts.length, missing: st.missing, ms: Date.now() - t0 };
}

/** 包一层 FeatureCollection（MapLibre 的 geojson source 直接用） */
export function contourFeatureCollection(feats: ContourFeature[]): {
  type: "FeatureCollection";
  features: ContourFeature[];
} {
  return { type: "FeatureCollection", features: feats };
}

/**
 * 按高程给色（与 `elevation.rs` 的 `ELEV_RAMP` **同一套口径**：低=青绿，高=暖棕）。
 * 只做线性插值，避免这边再引一份色带（漂移是这类"孪生实现"最容易出的错）。
 */
export function contourColor(ele: number, min = 0, max = 1200): string {
  const t = Math.max(0, Math.min(1, (ele - min) / Math.max(1, max - min)));
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [61, 138, 122]],
    [0.5, [214, 190, 122]],
    [1.0, [168, 110, 82]],
  ];
  let a = stops[0]!;
  let b = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i]![0] && t <= stops[i + 1]![0]) {
      a = stops[i]!;
      b = stops[i + 1]!;
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const k = (t - a[0]) / span;
  const c = a[1].map((v, i) => Math.round(v + (b[1][i]! - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * 取一张 DEM 瓦片的**高程格**（唯一碰 DOM 的函数）。
 * 走 `fetch` → `Blob` → `createImageBitmap`：跨域图片这样解码**不会污染 canvas**，
 * `getImageData` 才读得出来（直接 `<img src=跨域>` 再 drawImage 会被 taint 抛 SecurityError）。
 */
export async function readDemGrid(url: string, size = DEM_TILE_SIZE): Promise<Float32Array> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("readDemGrid 只能在浏览器里跑");
  }
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`DEM ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("拿不到 2d 上下文");
  ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0, size, size);
  const d = ctx.getImageData(0, 0, size, size).data;
  const g = new Float32Array(size * size);
  for (let k = 0; k < g.length; k++) {
    g[k] = decodeTerrarium(d[k * 4]!, d[k * 4 + 1]!, d[k * 4 + 2]!);
  }
  return g;
}
