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

import { atlasUvOf, cellOf, repeatOf, ROOF_CELL_INDEX } from "./wsBldFacade";
import { HEIGHT_COLOR_RAMP, renderHeight } from "./wsBuildingLook";
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

/* ══════════════════════════════════════════════════════════════════════════
 * 楼色：**瓦片里的 `c` 只当"明度档"，色相与绝对明度由主题色阶给**
 *
 * 背景：瓦片/离线包里烤进去的 `c`（= 生成时的 `color3d`）来自 `HEIGHT_COLOR_RAMP`
 *   那套**深蓝灰**（#23323e → #e8f7ff，L* 20.0 → 96.4）。而地图主题（默认 anime）的
 *   色阶是**浅天蓝 → 近白**（#B0E0F8 → #FFFFFF，L* 86.7 → 100）。两套并排出现时，
 *   楼是深色、底图是浅色、HUD 又是一套深蓝玻璃 ⇒ 三种色系互不相干。
 *
 * 做法（**不改瓦片**，生成物归生成线管）：
 *   · 把 `c` 的 WCAG 相对亮度映射到**瓦片那条暗色阶的首尾之间**，得到一个 0..1 的
 *     位置 `u`（单调，所以"越高越亮 / 女儿墙偏亮 / 设备箱偏深"这些关系原样保留）；
 *   · 再按同一个 `u` 在**当前主题色阶**上取色。
 *   ⇒ 屏幕上的色相**只可能**来自主题色阶（`c` 的蓝灰色相一个通道都进不去），
 *     而逐栋/逐部件的明暗差仍然来自 `c`。
 *
 * 代价（写清楚，别让人以为免费）：
 *   ① 这是**运行时映射**：换了主题，同一批 `c` 会映射到新主题的色阶（不必重出瓦片）；
 *      但因为顶点色在 `buildBldMeshData` 里烘进几何，**主题切换仍需重建网格**才生效
 *      （宿主原来就有"主题变了要重取数据"的提示，本改动没有让这条变好）。
 *   ② `c` 的绝对明度信息被丢掉（那本来就是旧暗色阶的值，与当前主题无关）。
 *   ③ 2D 地图那条 `bld-ext` 的 paint 仍读 `color3d`（`?renderer=map` 的排查通路）——
 *      本条只统一 3D 两条路（three / overlay），**没有**动 2D 图层表达式。
 * ══════════════════════════════════════════════════════════════════════════ */

/** WCAG 相对亮度（伽马展开后）：只用来把"暗色阶里的一档"换算成 0..1 的位置 */
function relativeLuma(rgb: [number, number, number]): number {
  const ch = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}

/** 主题色阶按**位置**取色（0 = 最暗档，1 = 最亮档；相邻档之间线性插值） */
function rampHexAtU(themeId: string, u: number): string {
  const th = wsMapTheme(themeId) as unknown as { ramp?: Array<[number, string]> };
  const stops = Array.isArray(th.ramp) && th.ramp.length ? th.ramp : [[0, "#cccccc"] as [number, string]];
  if (stops.length === 1) return stops[0]![1];
  const x = Math.max(0, Math.min(1, Number.isFinite(u) ? u : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixHexStr(stops[i]![1], stops[i + 1]![1], x - i);
}

/**
 * 一栋楼（或一个部件）的最终颜色。`color3d` 缺席 ⇒ 直接按高度在主题色阶取色；
 * 有 ⇒ 只取它的相对明度位置，色相/绝对明度由主题给。纯函数、无全局。
 */
export function themedBuildingHex(color3d: string, h: number, themeId: string): string {
  const raw = String(color3d || "").trim();
  const hex = /^#?[0-9a-fA-F]{6}$/.test(raw) ? (raw.startsWith("#") ? raw : `#${raw}`) : "";
  if (!hex) return rampHexAt(themeId, h);
  const stops = HEIGHT_COLOR_RAMP;
  const lo = relativeLuma(hexToRgb(stops[0]![1]));
  const hi = relativeLuma(hexToRgb(stops[stops.length - 1]![1]));
  const span = hi - lo;
  const u = span > 1e-6 ? (relativeLuma(hexToRgb(hex)) - lo) / span : 0;
  return rampHexAtU(themeId, u);
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
export function outerRingsOf(geom: unknown): { rings: Array<Array<[number, number]>>; holes: number } {
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
  /** **因为太扁被丢掉的**（`top - base < 0.4`：`h_base` 与 `h3d` 打架/顶底同高）
   *  —— 真机"整屏只有一栋楼"那条要紧的数：数据退化时这个会很大 */
  thinDropped: number;
  /** 因为轮廓画不出三角形被丢掉的（环退化/自交/点太少） */
  shapeDropped: number;
}

export interface BldMeshData {
  /** xyz 三元组（**局部米**；y 是高度） */
  positions: number[];
  /** 逐顶点 UV（单格内 0..1；顶面常量） */
  uvs: number[];
  /** 逐顶点图集矩形 (u0, v0, du, dv)；顶面 = 屋面格 */
  facadeRect: number[];
  /** 逐顶点重复次数 (uRep, vRep)；顶面 = (1,1) */
  facadeRep: number[];
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
    fromReal: 0, fromLevels: 0, fromKind: 0, thinDropped: 0, shapeDropped: 0,
  };
  const pos: number[] = [];
  const col: number[] = [];
  /* 立面图集用的三个逐顶点属性（顶面用屋面格常量，**不拆索引段**） */
  const uvs: number[] = [];
  const facadeRect: number[] = [];
  const facadeRep: number[] = [];
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
      if (!(top - base >= 0.4)) {
        stats.thinDropped += 1;
        continue;
      }
      if (Number.isFinite(h3dRaw) && h3dRaw > 0) stats.withH3d++;
      const c3d = typeof props.color3d === "string" && props.color3d ? String(props.color3d) : "";
      if (c3d) stats.withColor3d++;
      if (rh.from === "real") stats.fromReal++;
      else if (rh.from === "levels") stats.fromLevels++;
      else stats.fromKind++;
      /* `c`/`color3d` 只当明度档；最终颜色按当前主题色阶走（见 `themedBuildingHex`） */
      const hex = themedBuildingHex(c3d, top, themeId);
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
        /* 立面图集：**每栋取一次**（id → 格；不在这里算抖动，抖动走顶点色） */
        const fId = String((f as { id?: unknown }).id ?? (props as { id?: unknown }).id ?? "");
        const roofRect = atlasUvOf(ROOF_CELL_INDEX);
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
            /* 顶面：UV 常量 + 屋面格（窗格不会贴到屋顶上） */
            uvs.push(0.5, 0.5);
            facadeRect.push(roofRect.u0, roofRect.v0, roofRect.u1 - roofRect.u0, roofRect.v1 - roofRect.v0);
            facadeRep.push(1, 1);
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
          /* 立面：这面墙的重复次数（横向按边长、竖向按层数/楼高）与图集格 */
          const cellRect = atlasUvOf(cellOf(fId));
          const rep = repeatOf(el, top - base, (props as { lv?: unknown }).lv);
          const quadUv: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
          for (let qi = 0; qi < quad.length; qi++) {
            const p = quad[qi]!;
            pos.push(p[0]!, p[1]!, p[2]!);
            col.push(wr, wg, wb);
            const uv2 = quadUv[qi]!;
            uvs.push(uv2[0], uv2[1]);
            facadeRect.push(cellRect.u0, cellRect.v0, cellRect.u1 - cellRect.u0, cellRect.v1 - cellRect.v0);
            facadeRep.push(rep.uRep, rep.vRep);
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
        stats.shapeDropped += 1;
      }
    }

  return {
    positions: pos,
    uvs,
    facadeRect,
    facadeRep,
    colors: col,
    triFeature: triTo,
    boxes: featBox,
    featureIds,
    featureMeta,
    stats,
    triangles: triTo.length,
  };
}
