/**
 * wsGridGeo.ts —— 「小区草图网格(`WS_GRID`) ↔ 经纬度」的**唯一换算**（小区级 2.5D 化的地基）
 *
 * ## 为什么需要它（看板卡 t-mu6zxp8a-43m704 的第 1 步）
 * 机主方向：「2.5D 房和小区图最终要**结合起来仿 3D**（2 维的小区底 + 真实的 2.5D 房）」。
 * 但实测核实（2026-09-19，`grep` 零命中）：`sketch.rs` 生成的草图**没有任何经纬度/bbox/比例尺** ——
 * 路网是"井字主干道"现编的，楼/公园/水域是 RNG 生成，只借 OSM 的 density/water/park 三个提示。
 * 也就是说：**草图贴到真实地图上时，没人知道该覆盖多大范围、原点在哪。**
 *
 * 本模块只解决这一件事：**给定区县的真实中心 + 约定的实地边长，产出网格与经纬度的双向换算**。
 * 有了它，真实楼房（有经纬度）才能落在草图的对应格子上，人/车/设施也才能与楼对齐。
 *
 * ## 关键约定（都写成常量，改一处全局生效）
 * - 网格原点：**左上角** `(0,0)`（与屏幕坐标一致，y 向下增长）；
 * - 经纬度原点：区县中心（`geo_json` 的 `properties.centroid`，退回 `center`）；
 * - 实地边长：**默认 1200 m**（28 格 ⇒ 每格 ≈ 42.9 m，接近真实街区尺度）；
 * - y 轴方向：网格 y 向下、纬度向上 ⇒ **换算时取负**（写错会让整张图上下翻转，且不容易一眼看出来）。
 *
 * ## 明确不做
 * 不做墨卡托投影（小区级 1.2km 内，等距圆柱近似的误差 < 0.1%，没必要引入投影复杂度）；
 * 不做旋转/朝向（草图本身没有朝向信息，见卡片评论的"很可能对不上"判断）。
 */

/** 每度纬度对应的米数（WGS84 平均值，够用） */
export const METERS_PER_DEG_LAT = 111_320;

/** 默认实地边长（米）——28 格 ⇒ 每格 ≈42.9m */
export const DEFAULT_SPAN_M = 1200;

/** 草图默认网格数（与 `WorldSim` 的 `WS_GRID` 保持一致；调用方可覆盖） */
export const DEFAULT_CELLS = 28;

export interface GridGeoAnchor {
  /** 区县中心 [lng, lat] */
  center: [number, number];
  /** 网格数（正方形，cells×cells） */
  cells: number;
  /** 实地边长（米） */
  spanM: number;
  /** 每格对应的经度差（>0） */
  dLng: number;
  /** 每格对应的纬度差（>0） */
  dLat: number;
  /** 左上角（网格 0,0 的中心）的经纬度 */
  origin: [number, number];
}

/**
 * 由"区县中心 + 实地边长 + 网格数"造一个锚点。
 *
 * @param center 区县中心 [lng, lat]（建议用 `geo_json` 的 centroid；拿不到时用 center）
 * @param cells  网格数（默认 28）
 * @param spanM  实地边长（米，默认 1200）
 */
export function makeAnchor(
  center: [number, number],
  cells = DEFAULT_CELLS,
  spanM = DEFAULT_SPAN_M
): GridGeoAnchor {
  const n = Math.max(1, Math.trunc(cells) || DEFAULT_CELLS);
  const span = Math.max(1, Number(spanM) || DEFAULT_SPAN_M);
  const lng = clampLng(Number(center?.[0]) || 0);
  const lat = clampLat(Number(center?.[1]) || 0);
  const perCellM = span / n;
  const dLat = perCellM / METERS_PER_DEG_LAT;
  // 经度方向的米/度随纬度收缩：cos(lat)。极区会趋 0 → 夹一个下限，避免除零/爆炸。
  const cosLat = Math.max(0.02, Math.cos((lat * Math.PI) / 180));
  const dLng = perCellM / (METERS_PER_DEG_LAT * cosLat);
  // 左上角 = 中心 - (cells/2) 格；y 向上为正、网格 y 向下 ⇒ 纬度取 +（左上角纬度更高）
  const half = n / 2;
  const origin: [number, number] = [lng - half * dLng, lat + half * dLat];
  return { center: [lng, lat], cells: n, spanM: span, dLng, dLat, origin };
}

/**
 * 网格坐标 → 经纬度。
 * `gx/gy` 用**格子中心**的语义：`gx=0` 是左上角那一格的中心（与草图渲染里 `i+0.5` 的用法一致）。
 */
export function gridToLngLat(a: GridGeoAnchor, gx: number, gy: number): [number, number] {
  const x = Number(gx) || 0;
  const y = Number(gy) || 0;
  return [a.origin[0] + x * a.dLng, a.origin[1] - y * a.dLat];
}

/** 经纬度 → 网格坐标（小数 = 格内位置；`gridToLngLat` 的逆运算） */
export function lngLatToGrid(a: GridGeoAnchor, lng: number, lat: number): [number, number] {
  return [(Number(lng) - a.origin[0]) / a.dLng, (a.origin[1] - Number(lat)) / a.dLat];
}

/** 该点是否落在草图的实地范围内（用于"这栋楼该不该画进小区图"的判断） */
export function inSpan(a: GridGeoAnchor, lng: number, lat: number): boolean {
  const [gx, gy] = lngLatToGrid(a, lng, lat);
  return gx >= 0 && gy >= 0 && gx <= a.cells && gy <= a.cells;
}

/** 每格边长（米）—— 尺度校验时用它跟真实街区尺度对一下 */
export function cellMeters(a: GridGeoAnchor): number {
  return a.spanM / a.cells;
}

/** 网格的经纬度四角（供 MapLibre `image` source 的 `coordinates` 用，顺序：左上/右上/右下/左下） */
export function cornersForImage(a: GridGeoAnchor): [[number, number], [number, number], [number, number], [number, number]] {
  const tl = gridToLngLat(a, -0.5, -0.5);
  const tr = gridToLngLat(a, a.cells - 0.5, -0.5);
  const br = gridToLngLat(a, a.cells - 0.5, a.cells - 0.5);
  const bl = gridToLngLat(a, -0.5, a.cells - 0.5);
  return [tl, tr, br, bl];
}

function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat));
}
function clampLng(lng: number): number {
  return Math.max(-180, Math.min(180, lng));
}
