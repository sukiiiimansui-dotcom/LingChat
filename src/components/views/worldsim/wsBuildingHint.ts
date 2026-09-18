/**
 * wsBuildingHint.ts —— 把**真实楼体**变成「草图生成器的输入」（B 方案的地基）
 *
 * ## 为什么走 B（结论来自实测，别再来回试）
 * 轮次 14 用渝中区 400m 的 **152 栋真实楼体**量过：
 * · 真实城市肌理**主朝向 ≈30~40°**（渝中区顺江岸斜着长）；
 * · 而 `sketch.rs` 生成的是**轴对齐（0°/90°）井字路网**，**差 30~40°**；
 * · 更致命的是草图的楼体位置是 **RNG 生成** ⇒ **逐栋对齐在数学上不可能**。
 * ⇒ 所以不是"把草图贴到真实地图上"（A），而是**反过来：让草图按真实数据长出来**（B）。
 *
 * ## 这个模块干什么
 * 输入：区县中心 + 真实楼体 GeoJSON（`/api/buildings`）；
 * 输出：给生成器用的摘要 —— **主朝向**、**净密度**、以及每栋楼在**网格坐标**下的
 * 位置/占地/高度/名字（网格↔经纬度用 `wsGridGeo` 的唯一映射）。
 * 生成器据此排路网（按主朝向）并把楼放在真实的相对位置上 ⇒ 草图与真楼天然对应。
 *
 * ## 明确不做
 * 不生成草图本身（那是 Rust 侧 `sketch.rs` 的活）；不做地图渲染；不联网。
 */

import { cellMeters, gridToLngLat, inSpan, lngLatToGrid, type GridGeoAnchor } from "./wsGridGeo";

/** 真实楼体（从 GeoJSON feature 里抽出来的最小集合） */
export interface RealBuilding {
  /** 网格坐标下的**占地中心**（小数格） */
  gx: number;
  gy: number;
  /** 占地面积的**格数**（1 格 ≈42.9m ⇒ 0.01 格 ≈ 18m²，只作相对比较用） */
  cellsArea: number;
  /** 高度（米）——沿 fallback 链算出来的最终值 */
  heightM: number;
  /** 高度来自哪：`height` / `levels` / `default`（**必须留痕**，否则无法评价数据质量） */
  heightSrc: "height" | "levels" | "default";
  /** 楼层数（有就是数字） */
  levels: number | null;
  /** OSM id / 名字 / 类型（生成器可以用名字做地标） */
  id: string;
  name: string;
  kind: string;
}

export interface BuildingHint {
  /** 真实楼体主朝向（度，0~90；轴对齐城市的典型值是 0 或接近 90） */
  orientationDeg: number;
  /** 主朝向的强度 0~1（边长加权占比；越高说明城市肌理越规整） */
  orientationStrength: number;
  /** 落在草图实地范围内的楼（已按占地降序） */
  buildings: RealBuilding[];
  /** 范围内总栋数 / 被丢弃的栋数（范围外） */
  insideCount: number;
  droppedCount: number;
  /** 高度来源分布（数据质量留痕） */
  heightSrc: Record<"height" | "levels" | "default", number>;
  /** 平均高度（米，只统计范围内的楼） */
  meanHeightM: number;
}

/** 高度 fallback 链：`height`（米）→ `levels`×3m → 默认 8m。**与 Rust 侧 `building_height` 同一口径。** */
export const DEFAULT_BUILDING_HEIGHT_M = 8;
export const METERS_PER_LEVEL = 3;

/**
 * 主朝向估计：按**边长加权**统计所有多边形边的角度（模 90°），取峰值所在的 5° 桶中心。
 * 用边长加权而不是"数边"：长边（临街立面）才代表街区走向，短边多是阳台/凹凸。
 */
export function dominantOrientationDeg(rings: number[][][]): {
  deg: number;
  strength: number;
} {
  const bins = new Array(18).fill(0) as number[];
  let total = 0;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const dx = ring[i + 1]![0] - ring[i]![0];
      const dy = ring[i + 1]![1] - ring[i]![1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      ang = ((ang % 90) + 90) % 90; // 模 90°：矩形街区的两个方向等价
      bins[Math.min(17, Math.floor(ang / 5))] += len;
      total += len;
    }
  }
  if (!total) return { deg: 0, strength: 0 };
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[best]!) best = i;
  return { deg: best * 5 + 2.5, strength: bins[best]! / total };
}

/** GeoJSON 多边形 → 环列表（兼容 Polygon / MultiPolygon；只取每个多边形的主环） */
export function ringsOf(geometry: unknown): number[][][] {
  const g = (geometry || {}) as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon") {
    const c = g.coordinates as number[][][] | undefined;
    return c && c[0] ? [c[0]] : [];
  }
  if (g.type === "MultiPolygon") {
    const c = g.coordinates as number[][][][] | undefined;
    return Array.isArray(c) ? c.map((p) => p[0]).filter(Boolean) as number[][][] : [];
  }
  return [];
}

/** 环 → 占地中心（面积质心；退化时退回顶点平均） */
export function ringCenter(ring: number[][]): [number, number] | null {
  if (!ring || ring.length < 3) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length - 1 || ring.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i]![0];
      sy += ring[i]![1];
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** 环的近似面积（平面度²，只用于相对排序） */
export function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  }
  return Math.abs(a) / 2;
}

function pickHeight(props: Record<string, unknown>): { h: number; src: RealBuilding["heightSrc"]; levels: number | null } {
  const levels = Number(props.levels);
  const hasLevels = Number.isFinite(levels) && levels > 0;
  const hRaw = Number(props.height);
  if (Number.isFinite(hRaw) && hRaw > 0) return { h: hRaw, src: "height", levels: hasLevels ? levels : null };
  if (hasLevels) return { h: levels * METERS_PER_LEVEL, src: "levels", levels };
  return { h: DEFAULT_BUILDING_HEIGHT_M, src: "default", levels: null };
}

/**
 * 把 GeoJSON FeatureCollection（`/api/buildings` 的内容）整理成生成器用的摘要。
 * @param anchor 网格锚（`makeAnchor` 造的）
 */
export function buildingHint(anchor: GridGeoAnchor, geo: unknown): BuildingHint {
  const fs = ((geo as { features?: unknown[] })?.features || []) as Array<{
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;
  const rings: number[][][] = [];
  const buildings: RealBuilding[] = [];
  const src: Record<"height" | "levels" | "default", number> = { height: 0, levels: 0, default: 0 };
  let dropped = 0;
  const cellM = cellMeters(anchor);
  const cellAreaM2 = cellM * cellM;

  for (const f of fs) {
    const rs = ringsOf(f.geometry);
    if (!rs.length) continue;
    rings.push(...rs);
    const main = rs[0]!;
    const c = ringCenter(main);
    if (!c) continue;
    const [gx, gy] = lngLatToGrid(anchor, c[0], c[1]);
    if (!inSpan(anchor, c[0], c[1])) {
      dropped++;
      continue;
    }
    const p = f.properties || {};
    const { h, src: s, levels } = pickHeight(p);
    src[s]++;
    // 面积：度² → m²（纬度方向 111320 m/度；经度按纬度收缩）
    const areaDeg2 = ringArea(main);
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.max(0.02, Math.cos((anchor.center[1] * Math.PI) / 180));
    const areaM2 = areaDeg2 * mPerDegLat * mPerDegLng;
    buildings.push({
      gx,
      gy,
      cellsArea: areaM2 / cellAreaM2,
      heightM: h,
      heightSrc: s,
      levels,
      id: String(p.osm_id ?? ""),
      name: String(p.name ?? ""),
      kind: String(p.kind ?? ""),
    });
  }

  buildings.sort((a, b) => b.cellsArea - a.cellsArea);
  const ori = dominantOrientationDeg(rings);
  const mean = buildings.length ? buildings.reduce((s, b) => s + b.heightM, 0) / buildings.length : 0;
  return {
    orientationDeg: ori.deg,
    orientationStrength: ori.strength,
    buildings,
    insideCount: buildings.length,
    droppedCount: dropped,
    heightSrc: src,
    meanHeightM: mean,
  };
}

/** 供调试/日志：把摘要压成一行（别在 UI 里直接 JSON.stringify 大对象） */
export function hintLine(h: BuildingHint): string {
  const named = h.buildings.filter((b) => b.name).length;
  return (
    `${h.insideCount} 栋（有名 ${named}）· 主朝向 ${h.orientationDeg.toFixed(1)}°` +
    `（强度 ${(h.orientationStrength * 100).toFixed(0)}%）· 平均高 ${h.meanHeightM.toFixed(1)}m` +
    ` · 高度来源 height/levels/default = ${h.heightSrc.height}/${h.heightSrc.levels}/${h.heightSrc.default}` +
    ` · 范围外丢弃 ${h.droppedCount}`
  );
}

/** 网格坐标 → 经纬度（转出去给 MapLibre 用；这里只是转发 `wsGridGeo`，避免调用方两处 import） */
export function buildingLngLat(anchor: GridGeoAnchor, b: RealBuilding): [number, number] {
  return gridToLngLat(anchor, b.gx, b.gy);
}
