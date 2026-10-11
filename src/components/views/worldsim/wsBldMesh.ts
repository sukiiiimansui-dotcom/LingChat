/* wsBldMesh.ts —— **楼的几何**：一份纯函数，两个引擎共用（three 那条独立路 + 地图上的叠加层）。
 *
 * ## 为什么单独一个文件
 * 地图上的叠加层（`overlay`）要与 `three` 那条路画**同一批楼**：同一份 `bld` 要素、
 * 同一个高度口径（`renderHeight()` / `h3d`）、同一套顶点色。两份实现抄来抄去迟早漂，
 * 所以把"要素 → 顶点数组"这一步整个搬到这里 —— **谁都不许再写第二份**。
 *
 * ## 这里不做什么（判据盯着）
 * · 不 import three、不碰 `document`/`window`（`world_map/ws_bldmesh_move_selftest.mjs` 会扫）；
 * · 不认识相机、不认识画布：调用方把"经纬度 → 局部米"的投影函数（`toLocal`）传进来；
 * · 不做渲染决策（材质/灯光/层序都在调用方）。
 *
 * ## 口径（与 2D 的 `bld-*` 层逐项对齐）
 * · 高度：`h3d` 优先，没有才用 `renderHeight()`（真高 → 层数×3 → 按类型估）；
 * · 颜色：要素自带的 `color3d` 优先（与 2D 的 `bld-ext` paint 读同一个字段），
 *   没有才按主题色阶 `ramp` 兜底；
 * · 明暗：顶面系数取 1.0（屋顶 = `color3d` 原色），墙面按朝向吃一次 Lambert ——
 *   因为运行时那份 three 是**裁剪构建**、没有 `MeshLambertMaterial`（见 `wsThreeBackend.ts` 文件头）。
 *
 * ⚠️ 产出全是**扁平数组**（位置 / 顶点色 / 逐三角形要素下标 / 逐要素 XZ 包围盒 + 逐要素元信息），
 *    调用方自己包成它那套引擎认识的缓冲。
 */

import { renderHeight } from "./wsBuildingLook";
import { wsMapTheme } from "./wsMapTheme";
import { triangulateRing } from "./wsShapeTri";

/** 一次最多画几栋楼（**离锚点最近的先画**）；超出部分如实报出来，不静默丢 */
export const BLD_CAP = 3500;

function rampHexAt(themeId: string, h: number): string {
  const th = wsMapTheme(themeId) as unknown as { ramp?: Array<[number, string]> };
  const stops = Array.isArray(th.ramp) ? th.ramp : [];
  if (!stops.length) return "#cccccc";
  if (h <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (h <= b[0]) {
      const t = (h - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return mixHexStr(a[1], b[1], t);
    }
  }
  return stops[stops.length - 1]![1];
}
export function hexToRgb(hex: string): [number, number, number] {
  const s = String(hex || "").trim().replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const n = Number.parseInt(v.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0.8, 0.8, 0.8];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mixHexStr(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((x, i) => Math.round((x + (cb[i]! - x) * t) * 255));
  return "#" + c.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

/* ── 烘进顶点色的 Lambert（**这个 three 构建没有 MeshLambertMaterial**，见文件头）────────
 * 原来场景里是 `AmbientLight(0.62)` + `DirectionalLight(0.38)` 打在 Lambert 材质上；
 * 现在同一套系数在**建几何时**算进顶点色，材质退成 `MeshBasicMaterial`（不受光）。
 * · 顶面：系数取 **1.0** ⇒ 屋顶颜色就是 `color3d` 原色（与 2D 的 `bld-ext` 逐位一致）；
 * · 墙面：按水平法线吃一次 Lambert（0.62 + 0.38 × max(0, n·L̂)）。 */
const AMBIENT_K = 0.62;
const SUN_K = 0.38;
const SUN_DIR: readonly [number, number, number] = (() => {
  const v: [number, number, number] = [0.35, 1, 0.36];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
})();
/** 某个朝向的漫反射系数（顶面由调用方直接给 1.0） */
function shadeOf(nx: number, ny: number, nz: number): number {
  const d = nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2];
  return AMBIENT_K + SUN_K * Math.max(0, d);
}


/** 把环坐标（可能嵌套）读成 [lng,lat] 数组（道路那条折线读取也用同一份） */
export function ringPts(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Array.isArray(p)) continue;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
  }
  return out;
}

/** 一个（Multi）Polygon 的**外环**列表（洞本轮不画，只计数） */
function outerRingsOf(geom: unknown): { rings: Array<Array<[number, number]>>; holes: number } {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  const rings: Array<Array<[number, number]>> = [];
  let holes = 0;
  if (!g) return { rings, holes };
  if (g.type === "Polygon") {
    const cs = g.coordinates as unknown[];
    if (Array.isArray(cs) && cs.length) {
      rings.push(ringPts(cs[0]));
      holes += Math.max(0, cs.length - 1);
    }
  } else if (g.type === "MultiPolygon") {
    const cs = g.coordinates as unknown[];
    for (const poly of Array.isArray(cs) ? cs : []) {
      const arr = poly as unknown[];
      if (!Array.isArray(arr) || !arr.length) continue;
      rings.push(ringPts(arr[0]));
      holes += Math.max(0, arr.length - 1);
    }
  }
  return { rings, holes };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 对外：要素 → 顶点数据
 * ══════════════════════════════════════════════════════════════════════════ */

/** 交接进来的那份 `bld` 要素（形状从宽：这里不认识 GeoJSON 的类型定义） */
export type BldMeshFeature = {
  id?: unknown;
  properties?: Record<string, unknown>;
  geometry?: unknown;
};

export interface BldMeshInput {
  features: readonly unknown[];
  /** 经纬度 → 局部米（`[x, z]`；y 向上由调用方补） */
  toLocal: (lng: number, lat: number) => [number, number];
  /** 主题 id（`color3d` 缺席时按它的 `ramp` 兜底色） */
  themeId: string;
  /** 一次最多画几栋（离锚点最近的先画） */
  cap: number;
}

/** 与 `WsThreeDiag` 里那几个计数逐字对应（**搬迁不改行为**：数字含义一字不变） */
export interface BldMeshStats {
  buildings: number;
  capped: number;
  holesDropped: number;
  withColor3d: number;
  withH3d: number;
  fromReal: number;
  fromLevels: number;
  fromKind: number;
}

export interface BldMeshData {
  /** xyz 三元组（**局部米**；y 是高度） */
  positions: number[];
  /** 逐顶点 rgb（0..1） */
  colors: number[];
  /** **一个三角形一个槽**：值 = 该三角形属于第几个要素 */
  triFeature: number[];
  /** 逐要素 `[minX, minZ, maxX, maxZ]`（射线求交预筛用） */
  boxes: number[];
  /** 逐要素 id（与 `triFeature`/`boxes` 的要素下标**同一套编号**） */
  featureIds: string[];
  /** 逐要素元信息（命中时回报的颜色/高度） */
  featureMeta: Array<{ color: string; h3d: number; hBase: number }>;
  stats: BldMeshStats;
  /** 三角形总数（= `triFeature.length`；0 = 一栋都没画出来） */
  triangles: number;
}

/**
 * 把一份 `bld` 要素变成顶点数据。**纯函数**：同样的输入永远同样的输出，
 * 不读时钟、不读全局、不碰引擎。
 */
export function buildBldMeshData(input: BldMeshInput): BldMeshData {
  const { toLocal, themeId, cap } = input;
  const stats: BldMeshStats = {
    buildings: 0, capped: 0, holesDropped: 0, withColor3d: 0, withH3d: 0,
    fromReal: 0, fromLevels: 0, fromKind: 0,
  };
  const pos: number[] = [];
  const col: number[] = [];
  const triTo: number[] = [];
  const featBox: number[] = [];
  const featureIds: string[] = [];
  const featureMeta: Array<{ color: string; h3d: number; hBase: number }> = [];
  let list = input.features;
  /* 超过上限时**先画离锚点最近的**（近处的楼才是用户真正在看的那一批）。
     排序用要素自己的第一个坐标当代表点 —— 精确到米没必要，这只是"先画谁"的取舍。 */
  if (list.length > cap) {
    const keyed = list.map((f, i) => {
      const g = (f as { geometry?: unknown }).geometry;
      const { rings } = outerRingsOf(g);
      const p0 = rings[0]?.[0];
      const d = p0 ? Math.hypot(...toLocal(p0[0], p0[1])) : Number.POSITIVE_INFINITY;
      return { f, i, d };
    });
    keyed.sort((x, y) => x.d - y.d);
    stats.capped = keyed.length - cap;
    list = keyed.slice(0, cap).map((k) => k.f);
  }

    for (const raw of list) {
      const f = raw as { id?: unknown; properties?: Record<string, unknown>; geometry?: unknown };
      const props = f.properties || {};
      const { rings, holes } = outerRingsOf(f.geometry);
      if (!rings.length) continue;
      stats.holesDropped += holes;
      const h3dRaw = Number(props.h3d);
      const rh = renderHeight(props);                    // ← 与 2D **同一个函数**
      const top = Number.isFinite(h3dRaw) && h3dRaw > 0 ? h3dRaw : rh.h;
      const baseRaw = Number(props.h_base ?? props.min_height ?? 0);
      const base = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.min(baseRaw, top - 0.4) : 0;
      if (!(top - base >= 0.4)) continue;
      if (Number.isFinite(h3dRaw) && h3dRaw > 0) stats.withH3d++;
      if (typeof props.color3d === "string" && props.color3d) stats.withColor3d++;
      if (rh.from === "real") stats.fromReal++;
      else if (rh.from === "levels") stats.fromLevels++;
      else stats.fromKind++;
      const hex = typeof props.color3d === "string" && props.color3d ? props.color3d : rampHexAt(themeId, top);
      const rgb = hexToRgb(hex);
      const fi = featureIds.length;
      featureIds.push(String(f.id ?? ""));
      featureMeta.push({ color: hex, h3d: top, hBase: base });
      let added = false;
      const box = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      const grow = (x: number, z: number): void => {
        if (x < box[0]) box[0] = x;
        if (z < box[1]) box[1] = z;
        if (x > box[2]) box[2] = x;
        if (z > box[3]) box[3] = z;
      };
      for (const ring of rings) {
        if (ring.length < 3) continue;
        const pts = ring.map(([lng, lat]) => toLocal(lng, lat));
        for (const p of pts) grow(p[0], p[1]);
        const tris = triangulateRing(pts);
        if (!tris.length) continue;
        added = true;
        /* 顶盖（法线朝上：算一下叉积，朝下就换序，绝不靠"输入一定是逆时针"） */
        for (let i = 0; i < tris.length; i += 3) {
          const a = pts[tris[i]!]!;
          const b = pts[tris[i + 1]!]!;
          const c = pts[tris[i + 2]!]!;
          const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const q = up >= 0 ? [a, b, c] : [a, c, b];
          for (const p of q) {
            pos.push(p[0], top, p[1]);
            col.push(rgb[0], rgb[1], rgb[2]);
          }
          /* 🔴 一个三角形**一个槽**（墙那边每个四边形 2 个三角形、也是 2 个槽）。
             原来这里 push 三个 ⇒ 槽位与三角形下标错位，`centerPick` 按槽位反查就会指错/指空
             （2026-10-11 靶场"对着某栋楼问它命中了谁"那条测出来的）。 */
          triTo.push(fi);
        }
        /* 墙：每条边一个四边形（不做背面剔除的取舍 —— 材质用 DoubleSide，朝向错了也看得见） */
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[(i + 1) % pts.length]!;
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const quad = [
            [a[0], base, a[1]], [b[0], base, b[1]], [b[0], top, b[1]],
            [a[0], base, a[1]], [b[0], top, b[1]], [a[0], top, a[1]],
          ];
          /* 墙面法线 = 这条边在水平面里转 90°（朝外那一侧由叉积定；DoubleSide 下无所谓正负，
             只要"同一个朝向拿到同一个系数"） */
          const ex = b[0] - a[0];
          const ez = b[1] - a[1];
          const el = Math.hypot(ex, ez) || 1;
          const k = shadeOf(-ez / el, 0, ex / el);
          const wr = rgb[0] * k;
          const wg = rgb[1] * k;
          const wb = rgb[2] * k;
          for (const p of quad) {
            pos.push(p[0]!, p[1]!, p[2]!);
            col.push(wr, wg, wb);
          }
          triTo.push(fi, fi);          // 四边形 = 2 个三角形 ⇒ 2 个槽
        }
      }
      if (added) {
        stats.buildings++;
        featBox.push(box[0], box[1], box[2], box[3]);
      } else {
        /* 没画成的那一栋要**从名单里退掉**，否则 `centerPick` 会指到一栋画不出来的楼上 */
        featureIds.pop();
        featureMeta.pop();
      }
    }

  return {
    positions: pos,
    colors: col,
    triFeature: triTo,
    boxes: featBox,
    featureIds,
    featureMeta,
    stats,
    triangles: triTo.length,
  };
}
