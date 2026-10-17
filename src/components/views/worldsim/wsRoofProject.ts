/**
 * wsRoofProject.ts —— **楼顶投影**（地图库 3D 矩阵的唯一入口）。
 *
 * 为什么单独一份：真机 2026-10-17 的 `?wsalign=1` 读数里 `roof3d:0 / roofGround:1..7` ——
 * 说明名字层以为"私有成员不可用"而全部退回地面。根因不是矩阵不存在，而是
 * `map.transform` 是一个**包装器**：`locationToScreenPoint` 被转发到 `transform.currentTransform`，
 * 而 `_pixelMatrix3D` 只在**被转发到的那个对象**上。旧实现先看包装器的 `_pixelMatrix3D`
 * ⇒ 永远看不到 ⇒ 永远回退。这里改成**直接调方法**，包装器与内层各试一次；
 * 只有方法真的抛错/给不出有限值才退回地面（并让调用方计数）。
 *
 * 本文件不 import 地图库（只收一个最小形状），可在 Node 里单测。
 */

import type { NameRoofProjection } from "./wsNameLayer";

interface RoofTransformLike {
  locationToScreenPoint?: (p: [number, number], helper: { getElevationForLngLat: () => number }) => { x: number; y: number } | null;
  currentTransform?: RoofTransformLike;
}

export interface RoofMapLike {
  transform?: RoofTransformLike;
  project?: (p: [number, number]) => { x: number; y: number } | null;
}

/**
 * `(lng, lat, 楼顶高度 m)` → 屏幕 CSS 像素。
 *
 * 顺序：`map.transform.locationToScreenPoint` → `map.transform.currentTransform.locationToScreenPoint`
 * → `map.project`（地面，`via:"ground"`）→ `null`。
 */
export function projectRoofOn(map: RoofMapLike | null | undefined, lng: number, lat: number, height: number): NameRoofProjection {
  if (!map) return null;
  const h = Number(height) || 0;
  const helper = { getElevationForLngLat: () => h };
  const tries: Array<RoofTransformLike | undefined> = [map.transform, map.transform?.currentTransform];
  for (const tr of tries) {
    if (!tr || typeof tr.locationToScreenPoint !== "function") continue;
    try {
      const p = tr.locationToScreenPoint([lng, lat], helper);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y, via: "matrix3d" };
    } catch {
      /* 这个入口不可用：试下一个（包装器/内层） */
    }
  }
  try {
    const p = map.project?.([lng, lat]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y, via: "ground" };
  } catch {
    /* 地图还没就绪 */
  }
  return null;
}
