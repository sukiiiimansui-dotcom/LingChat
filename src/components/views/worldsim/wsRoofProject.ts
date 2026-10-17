/**
 * wsRoofProject.ts —— **楼顶投影**（唯一入口；3D 矩阵优先，取不到用共享尺子近似）。
 *
 * 真机 2026-10-17 两轮读数（`?wsalign=1`）：
 *   · 第一轮 `roof3d:0 / roofGround:1..7`：旧实现先看 `map.transform._pixelMatrix3D`；
 *     而 `map.transform` 是包装器，真正的 transform 在 `currentTransform` 上。
 *   · 第二轮改成直接调方法后**仍然全回退** ⇒ 说明这版 MapLibre（v6.10.0）的**平面地图**
 *     transform 上没有可用的 `_pixelMatrix3D`（该矩阵只在垂直透视/地形那条路上算），
 *     `locationToScreenPoint(lngLat, helper)` 在内部拿 `undefined` 矩阵抛错。
 *
 * ⇒ 不再赌私有成员：3D 矩阵能拿到就用（`via:"matrix3d"`），拿不到就用**本仓既有的**
 *    "1 米楼高 = 多少屏幕像素"尺子 `bldPxPerMeter(zoom, lat, pitch)` 把地面投影向上抬
 *    （`via:"approx"`）。这条尺子与楼体墙面/挑楼用的是同一份（`wsBldBudget`），
 *    不是第二份相机；误差随离屏幕中心的距离增大（透视压缩），但**远好于停在地面**。
 *
 * 所有尝试/异常/高程值都记进 `roofDiag`，由 `?wsalign=1` 回传（不再靠"回退计数"猜）。
 */

import { bldPxPerMeter } from "./wsBldBudget";
import type { NameRoofProjection } from "./wsNameLayer";

interface RoofTransformLike {
  locationToScreenPoint?: (p: [number, number], helper: { getElevationForLngLat: () => number }) => { x: number; y: number } | null;
  currentTransform?: RoofTransformLike;
  _pixelMatrix3D?: unknown;
}

export interface RoofMapLike {
  transform?: RoofTransformLike;
  project?: (p: [number, number]) => { x: number; y: number } | null;
  getPitch?: () => number;
  getZoom?: () => number;
  getCenter?: () => { lat: number; lng: number } | null;
}

export interface RoofDiagLast {
  via: "matrix3d" | "approx" | "ground" | "none";
  h: number;
  /** 传进来的 map 是什么（`hasTransform:false` 时用来分辨"是不是原生 Map"） */
  mapCtor: string;
  hasProject: boolean;
  hasGetPitch: boolean;
  hasGetZoom: boolean;
  hasGetCenter: boolean;
  hasTransform: boolean;
  hasLSTP: boolean;
  hasCurrent: boolean;
  hasCurrentLSTP: boolean;
  hasPixel3D: boolean;
  hasCurrentPixel3D: boolean;
  /** `locationToScreenPoint` 的异常原文（每个入口一条；没抛就是空串） */
  errTransform: string;
  errCurrent: string;
  /** 方法返回了但不是有限值时的原文 */
  retTransform: string;
  retCurrent: string;
  /** 近似口径的输入/输出（同一栋楼：h -> expectedDy） */
  pitch: number | null;
  zoom: number | null;
  pxPerM: number | null;
  expectedDy: number | null;
  groundY: number | null;
  groundErr: string;
}

export const roofDiag = {
  calls: 0,
  matrix3d: 0,
  approx: 0,
  ground: 0,
  none: 0,
  /** 最近一次**非 matrix3d** 的详细原因（成功时不动它；回传看这个） */
  lastFail: null as RoofDiagLast | null,
};

function errText(e: unknown): string {
  try {
    const m = (e as { message?: unknown })?.message;
    return String(m !== undefined ? m : e).slice(0, 180);
  } catch {
    return "（异常原文取不到）";
  }
}

/**
 * `(lng, lat, 楼顶高度 m)` → 屏幕 CSS 像素。
 *
 * 顺序：`map.transform.locationToScreenPoint` → `map.transform.currentTransform.locationToScreenPoint`
 * → 地面投影 + `bldPxPerMeter` 抬升（`approx`）→ 纯地面（`ground`）→ `null`。
 */
export function projectRoofOn(map: RoofMapLike | null | undefined, lng: number, lat: number, height: number): NameRoofProjection {
  roofDiag.calls += 1;
  const h = Number(height) || 0;
  const helper = { getElevationForLngLat: () => h };
  let ctor = "";
  try { ctor = String((map as { constructor?: { name?: string } })?.constructor?.name || ""); } catch { ctor = ""; }
  const diag: RoofDiagLast = {
    via: "none", h,
    mapCtor: ctor,
    hasProject: typeof map?.project === "function",
    hasGetPitch: typeof map?.getPitch === "function",
    hasGetZoom: typeof map?.getZoom === "function",
    hasGetCenter: typeof map?.getCenter === "function",
    hasTransform: !!map?.transform,
    hasLSTP: typeof map?.transform?.locationToScreenPoint === "function",
    hasCurrent: !!map?.transform?.currentTransform,
    hasCurrentLSTP: typeof map?.transform?.currentTransform?.locationToScreenPoint === "function",
    hasPixel3D: !!map?.transform?._pixelMatrix3D,
    hasCurrentPixel3D: !!map?.transform?.currentTransform?._pixelMatrix3D,
    errTransform: "", errCurrent: "", retTransform: "", retCurrent: "",
    pitch: null, zoom: null, pxPerM: null, expectedDy: null, groundY: null, groundErr: "",
  };

  if (!map) { roofDiag.none += 1; roofDiag.lastFail = diag; return null; }

  const tries: Array<[RoofTransformLike | undefined, "Transform" | "CurrentTransform"]> = [
    [map.transform, "Transform"],
    [map.transform?.currentTransform, "CurrentTransform"],
  ];
  for (const [tr, tag] of tries) {
    if (!tr || typeof tr.locationToScreenPoint !== "function") continue;
    try {
      const p = tr.locationToScreenPoint([lng, lat], helper);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        diag.via = "matrix3d";
        roofDiag.matrix3d += 1;
        return { x: p.x, y: p.y, via: "matrix3d" };
      }
      if (tag === "Transform") diag.retTransform = p ? `x=${p.x},y=${p.y}` : "null";
      else diag.retCurrent = p ? `x=${p.x},y=${p.y}` : "null";
    } catch (e) {
      if (tag === "Transform") diag.errTransform = errText(e);
      else diag.errCurrent = errText(e);
    }
  }

  /* 私有矩阵不可用：用共享尺子把地面投影向上抬（楼顶屏幕 y = 地面 y − 楼高 × 每米像素） */
  try {
    const base = map.project?.([lng, lat]);
    if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
      diag.groundY = base.y;
      const pitch = Number(map.getPitch?.() ?? NaN);
      const zoom = Number(map.getZoom?.() ?? NaN);
      const c = map.getCenter?.() || null;
      const lat0 = c ? Number(c.lat) : NaN;
      const pxPerM = Number.isFinite(pitch) && Number.isFinite(zoom) && Number.isFinite(lat0)
        ? bldPxPerMeter(zoom, lat0, pitch)
        : NaN;
      diag.pitch = Number.isFinite(pitch) ? pitch : null;
      diag.zoom = Number.isFinite(zoom) ? zoom : null;
      diag.pxPerM = Number.isFinite(pxPerM) ? pxPerM : null;
      const dy = h > 0 && Number.isFinite(pxPerM) && pxPerM > 0 ? h * pxPerM : 0;
      diag.expectedDy = dy;
      if (dy > 0.05) {
        diag.via = "approx";
        roofDiag.approx += 1;
        roofDiag.lastFail = diag;
        return { x: base.x, y: base.y - dy, via: "approx" };
      }
      diag.via = "ground";
      roofDiag.ground += 1;
      roofDiag.lastFail = diag;
      return { x: base.x, y: base.y, via: "ground" };
    }
  } catch (e) {
    diag.groundErr = errText(e);
  }
  diag.via = "none";
  roofDiag.none += 1;
  roofDiag.lastFail = diag;
  return null;
}
