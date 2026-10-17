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
 * · 唯一的 ambient 读：`?model=1` / `?mpp=` / `?z=`（默认关；Node 无 `location` 时按关）。
 *   几何仍只由输入要素 + 这些标量决定；LOD 的滞回状态由 `lod.state` 注入（默认共享）。
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

import { atlasUvOf, cellOf, repeatOf, PLAIN_CELL_INDEX, ROOF_CELL_INDEX } from "./wsBldFacade";
import { ROOF_MUL, bandsForBase, toonBandOf, toonMulOf } from "./wsToon";
import { HEIGHT_COLOR_RAMP, renderHeight } from "./wsBuildingLook";
import { wsMapTheme } from "./wsMapTheme";
import { triangulateRing } from "./wsShapeTri";
import { bandRingsOf, massingOf, modelPartsOf, type BldPartLike } from "./wsBldModel";
import { DEFAULT_LOD_MPP, DETAIL_VERTS_MAX, mppAtZoom, sharedBldLodState, type BldLodState, type LodTier } from "./wsBldLod";
import { ROOF_VERTS_MAX, roofKindEligible, roofPlanOf, type RoofPlan } from "./wsBldRoof";

type Pt2 = readonly [number, number];
type Rgb3 = [number, number, number];
type UvRect = { u0: number; v0: number; u1: number; v1: number };
type UvRep = { uRep: number; vRep: number };
type Bands = { k: [number, number, number]; mix: [number, number, number] };

/** 一次最多画几栋楼（**离锚点最近的先画**）；超出部分如实报出来，不静默丢 */
export const BLD_CAP = 3500;

/* ── S3 的浏览器开关（只在 input 没显式给时读；Node 自检 `location` 不存在 ⇒ 默认关） ── */
function urlModelOn(): boolean {
  try {
    return /[?&]model=1\b/.test(typeof location !== "undefined" ? location.search : "");
  } catch {
    return false;
  }
}

/** `?mpp=` 直接给米/CSS 像素；`?z=` 按 Web Mercator 反算（默认纬度 29.56°）。 */
function urlLodMpp(): number | null {
  try {
    const q = typeof location !== "undefined" ? location.search : "";
    const mm = /[?&]mpp=([0-9.]+)/.exec(q);
    if (mm) {
      const v = Number(mm[1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    const mz = /[?&]z=([0-9.]+)/.exec(q);
    if (mz) {
      const v = Number(mz[1]);
      if (Number.isFinite(v)) return mppAtZoom(v);
    }
  } catch {
    /* 读不到 URL 就用默认 mpp */
  }
  return null;
}

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
  /** S2/S3 建模开关：true = 用 `__parts` 的体块/女儿墙/设备/天线；
   *  不传时读 `?model=1`；显式 false = 影子路（输出与旧版逐字节相同，`model=0` 回证用）。 */
  model?: boolean;
  /** S3 LOD：mpp（米/CSS 像素，缺省 `?mpp=` / `?z=` / z16.4）/ 垂直压缩 /
   *  细节顶点预算 / 滞回状态（缺省共享）/ 自检强制档。 */
  lod?: {
    mpp?: number;
    pitchCos?: number;
    detailVerts?: number;
    state?: BldLodState;
    forceTier?: LodTier;
  };
  /** S4 坡屋顶：auto（默认）/ all（变异：未知类型也做）/ off（影子）；
   *  verts = 屋顶总顶点预算（缺省 `ROOF_VERTS_MAX`）。 */
  roof?: {
    force?: "auto" | "all" | "off";
    verts?: number;
  };
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
  /** S2：真的用了拆件建模的栋数 / 体块数 / 女儿墙环带数 / 环带丢弃数 / 体块失败回退主体数 */
  modeledBuildings: number;
  massingBuildings: number;
  massingParts: number;
  parapetBands: number;
  parapetDropped: number;
  massFallback: number;
  /** S3：各 LOD 档的栋数（0 远 / 1 中 / 2 近） */
  lodTiers: [number, number, number];
  /** 细节实际用掉的顶点数 / 预算 / 因预算被降级或跳过的细节数 */
  detailVerts: number;
  detailCap: number;
  detailDropped: number;
  /** 设备箱 / 天线实际画出的件数 */
  equipParts: number;
  antennaParts: number;
  /** 本次用的 mpp（米/CSS 像素；0 = 没走 LOD/建模） */
  lodMpp: number;
  /** S4：选中的坡屋顶数 / 屋顶顶点 / 预算 / 因预算丢掉 / 各类型数 */
  roofs: number;
  roofVerts: number;
  roofCap: number;
  roofDropped: number;
  roofTypes: { gable: number; hip: number; pyramid: number };
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
 * 把一份 `bld` 要素变成顶点数据。**纯几何**：不读时钟、不碰引擎；
 * 例外只有三个 URL 开关（`?model=1` / `?mpp=` / `?z=`）与可注入的 LOD 状态。
 */
export function buildBldMeshData(input: BldMeshInput): BldMeshData {
  const { toLocal, themeId, cap } = input;
  const modelOn = input.model === true || (input.model === undefined && urlModelOn());
  const lodMpp = (() => {
    const v = Number(input.lod?.mpp);
    if (Number.isFinite(v) && v > 0) return v;
    return urlLodMpp() ?? DEFAULT_LOD_MPP;
  })();
  const pitchCos = (() => {
    const v = Number(input.lod?.pitchCos);
    return Number.isFinite(v) ? Math.max(0.5, Math.min(1, v)) : 1;
  })();
  const detailCap = (() => {
    const v = Number(input.lod?.detailVerts);
    return Number.isFinite(v) && v >= 0 ? v : DETAIL_VERTS_MAX;
  })();
  const lodState = input.lod?.state ?? sharedBldLodState;
  const forceTier = input.lod?.forceTier;
  const stats: BldMeshStats = {
    buildings: 0, capped: 0, holesDropped: 0, withColor3d: 0, withH3d: 0,
    fromReal: 0, fromLevels: 0, fromKind: 0, thinDropped: 0, shapeDropped: 0,
    modeledBuildings: 0, massingBuildings: 0, massingParts: 0, parapetBands: 0, parapetDropped: 0, massFallback: 0,
    lodTiers: [0, 0, 0], detailVerts: 0, detailCap: 0, detailDropped: 0, equipParts: 0, antennaParts: 0, lodMpp: 0,
    roofs: 0, roofVerts: 0, roofCap: 0, roofDropped: 0, roofTypes: { gable: 0, hip: 0, pyramid: 0 },
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
  /* 每栋基色 → 三档系数（缓存；同一基色只算一次） */
  const bandsCache = new Map<string, { k: [number, number, number]; mix: [number, number, number] }>();
  const bandsOf = (hex: string): { k: [number, number, number]; mix: [number, number, number] } => {
    const hit = bandsCache.get(hex);
    if (hit) return hit;
    const v = bandsForBase(hex);
    bandsCache.set(hex, v);
    return v;
  };
  /** 档位最终乘性系数（白混在调用处用 mix 处理；这里只给乘性部分） */
  const toonK = (hex: string, k: number, bands: { k: [number, number, number] }): { band: number; idx: 0 | 1 | 2 } => {
    const bandK = toonBandOf(k, bands.k as unknown as [number, number, number]);
    const idx: 0 | 1 | 2 = bandK <= bands.k[0] ? 0 : bandK <= bands.k[1] ? 1 : 2;
    return { band: bandK, idx };
  };
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

  /* ── S3：先算每栋的 LOD 档与细节代价，再按预算确定性选细节 ─────────────────
     两遍：① 只算档/代价（不写几何）；② 正式画时按 plan 决定画不画细节。
     这样几何顺序/拾取编号与旧路完全一致，预算超了也能按 tier/屏幕高度/id 降级。 */
  type DetailPlan = {
    key: string;
    tier: LodTier;
    hpx: number;
    h: number;
    massing: BldPartLike[];
    parapet: BldPartLike[];
    equip: BldPartLike[];
    antenna: BldPartLike[];
    wallCost: number;
    fullCost: number;
    selected: 0 | 1 | 2;
    roof: RoofPlan | null;
    roofSelected: boolean;
  };
  const planByKey = new Map<string, DetailPlan>();
  if (modelOn) {
    const plans: DetailPlan[] = [];
    const roofCandidates: Array<{ plan: DetailPlan; rp: RoofPlan }> = [];
    let pi = 0;
    for (const raw of list) {
      const myIndex = pi++;
      const f = raw as { id?: unknown; properties?: Record<string, unknown>; geometry?: unknown };
      const props = f.properties || {};
      const h3dRaw = Number(props.h3d);
      const rh = renderHeight(props);
      const top = Number.isFinite(h3dRaw) && h3dRaw > 0 ? h3dRaw : rh.h;
      const baseRaw = Number(props.h_base ?? props.min_height ?? 0);
      const base = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.min(baseRaw, top - 0.4) : 0;
      const c3d = typeof props.color3d === "string" && props.color3d ? String(props.color3d) : "";
      const primaryPart: BldPartLike = { p: props.p, h: top, hb: base, c: c3d || undefined, geometry: f.geometry };
      /* 远景只需要体块；全量拆件（女儿墙/设备/天线）只在 tier>0 才算 —— 省掉 680 栋的无用解析 */
      const massing = massingOf(props, primaryPart);
      let hTop = top;
      for (const part of massing) {
        const ph = Number(part.h);
        if (Number.isFinite(ph)) hTop = Math.max(hTop, ph);
      }
      const id = String(f.id ?? "");
      const key = id || "#" + myIndex;
      const hpx = (hTop / lodMpp) * pitchCos;
      const tier = forceTier !== undefined ? forceTier : lodState.tierOf(key, hpx);
      stats.lodTiers[tier] += 1;
      const plan: DetailPlan = {
        key, tier, hpx, h: hTop, massing,
        parapet: [], equip: [], antenna: [],
        wallCost: 0, fullCost: 0, selected: 0,
        roof: null, roofSelected: false,
      };
      /* S4：没有体块的低层住宅才算坡屋顶；远景也要（轮廓），不受 LOD 门控 */
      const roofForce = input.roof?.force ?? "auto";
      if (massing.length === 0 && roofForce !== "off" && (roofForce === "all" || roofKindEligible(props, top))) {
        const { rings: rr } = outerRingsOf(f.geometry);
        if (rr.length === 1 && rr[0]!.length >= 4) {
          const pts = rr[0]!.map(([lng, lat]) => toLocal(lng, lat));
          const rp = roofPlanOf(props, pts, top, base, { force: roofForce });
          if (rp) {
            plan.roof = rp;
            roofCandidates.push({ plan, rp });
          }
        }
      }
      if (tier > 0) {
        const mp = modelPartsOf(props, primaryPart);
        const parapet: BldPartLike[] = [];
        let wallCost = 0;
        for (const part of mp.parapet) {
          const br = bandRingsOf(part);
          if (!br) {
            stats.parapetDropped += 1;
            continue;
          }
          parapet.push(part);
          wallCost += 6 * br.outer.length;
        }
        let extraCost = 0;
        for (const part of mp.equip) {
          const { rings: er } = outerRingsOf(part.geometry);
          for (const r of er) extraCost += 9 * r.length - 6;
        }
        for (const part of mp.antenna) {
          const { rings: ar } = outerRingsOf(part.geometry);
          for (const r of ar) extraCost += 9 * r.length - 6;
        }
        plan.parapet = parapet;
        plan.equip = mp.equip;
        plan.antenna = mp.antenna;
        plan.wallCost = wallCost;
        plan.fullCost = wallCost * 3 + extraCost;
        plans.push(plan);
      }
      planByKey.set(key, plan);
    }
    /* 优先级：近档 → 屏幕高度 → 楼高 → id；同输入永远同一顺序 */
    plans.sort((a, b) =>
      b.tier - a.tier ||
      b.hpx - a.hpx ||
      b.h - a.h ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
    let remaining = detailCap;
    for (const plan of plans) {
      if (plan.tier === 2) {
        if (plan.fullCost <= remaining) {
          plan.selected = 2;
          remaining -= plan.fullCost;
        } else if (plan.wallCost <= remaining) {
          plan.selected = 1;
          remaining -= plan.wallCost;
          stats.detailDropped += 1;
        } else {
          plan.selected = 0;
          stats.detailDropped += 1;
        }
      } else if (plan.tier === 1) {
        if (plan.wallCost <= remaining) {
          plan.selected = 1;
          remaining -= plan.wallCost;
        } else {
          plan.selected = 0;
          stats.detailDropped += 1;
        }
      }
    }
    stats.detailVerts = detailCap - remaining;
    stats.detailCap = detailCap;
    stats.lodMpp = lodMpp;
    /* S4 屋顶预算：h 高 → 面积大 → id 小优先；超了不画并计数 */
    const roofCapRaw = Number(input.roof?.verts);
    const roofCap = Number.isFinite(roofCapRaw) && roofCapRaw >= 0 ? roofCapRaw : ROOF_VERTS_MAX;
    roofCandidates.sort((a, b) =>
      b.rp.peak - a.rp.peak ||
      b.rp.area - a.rp.area ||
      (a.plan.key < b.plan.key ? -1 : a.plan.key > b.plan.key ? 1 : 0)
    );
    let roofLeft = roofCap;
    for (const item of roofCandidates) {
      if (item.rp.verts <= roofLeft) {
        item.plan.roofSelected = true;
        roofLeft -= item.rp.verts;
        stats.roofs += 1;
        stats.roofVerts += item.rp.verts;
        stats.roofTypes[item.rp.type] += 1;
      } else {
        stats.roofDropped += 1;
      }
    }
    stats.roofCap = roofCap;
  }

  let featureIndex = 0;
    for (const raw of list) {
      const myIndex = featureIndex++;
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
      const c3d = typeof props.color3d === "string" && props.color3d ? String(props.color3d) : "";
      /* S2/S3：plan 由预扫算好（LOD/预算已决定）。model=0 时 plan 为空，完全走旧路。 */
      const fId = String((f as { id?: unknown }).id ?? (props as { id?: unknown }).id ?? "");
      const planKey = fId || "#" + myIndex;
      const plan = modelOn ? planByKey.get(planKey) : undefined;
      const massing = plan?.massing ?? [];
      const parapets = plan?.parapet ?? [];
      const equipParts = plan?.equip ?? [];
      const antennaParts = plan?.antenna ?? [];
      const selectedTier = plan?.selected ?? 0;
      const roofPlan = plan?.roofSelected && plan.roof ? plan.roof : null;
      let metaTop = top;
      let metaBase = base;
      if (modelOn && massing.length) {
        let mt = -Infinity;
        let mb = Infinity;
        for (const part of massing) {
          const ph = Number(part.h);
          const pb = Number(part.hb);
          if (Number.isFinite(ph)) mt = Math.max(mt, ph);
          if (Number.isFinite(pb)) mb = Math.min(mb, pb);
        }
        if (Number.isFinite(mt) && Number.isFinite(mb) && mt - mb >= 0.4) {
          metaTop = mt;
          metaBase = mb;
        }
      }
      if (!(metaTop - metaBase >= 0.4)) {
        stats.thinDropped += 1;
        continue;
      }
      if (Number.isFinite(h3dRaw) && h3dRaw > 0) stats.withH3d++;
      if (c3d) stats.withColor3d++;
      if (rh.from === "real") stats.fromReal++;
      else if (rh.from === "levels") stats.fromLevels++;
      else stats.fromKind++;
      /* `c`/`color3d` 只当明度档；最终颜色按当前主题色阶走（见 `themedBuildingHex`）。
         建模时按最高体块取色，保证同一栋的体块/女儿墙落在同一色阶档。 */
      const hex = themedBuildingHex(c3d, metaTop, themeId);
      const rgb = hexToRgb(hex);
      const fi = featureIds.length;
      featureIds.push(String(f.id ?? ""));
      featureMeta.push({ color: hex, h3d: metaTop, hBase: metaBase });
      const massCellRect = atlasUvOf(cellOf(fId));
      const roofRect = atlasUvOf(ROOF_CELL_INDEX);
      const plainRect = atlasUvOf(PLAIN_CELL_INDEX);
      const oneRep: UvRep = { uRep: 1, vRep: 1 };
      let added = false;
      let modeled = false;
      const box = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      const grow = (x: number, z: number): void => {
        if (x < box[0]) box[0] = x;
        if (z < box[1]) box[1] = z;
        if (x > box[2]) box[2] = x;
        if (z > box[3]) box[3] = z;
      };
      /* ── S2 建模用的推顶点/推面（只在 model=1 调用；旧路仍是下面那段内联代码） ── */
      const pushV = (x: number, y: number, z: number, r: number, g: number, b: number, u: number, v: number, rect: UvRect, rep: UvRep): void => {
        pos.push(x, y, z);
        col.push(r, g, b);
        uvs.push(u, v);
        facadeRect.push(rect.u0, rect.v0, rect.u1 - rect.u0, rect.v1 - rect.v0);
        facadeRep.push(rep.uRep, rep.vRep);
      };
      const pushCapTri = (a: Pt2, b: Pt2, c: Pt2, y: number, color: Rgb3, rect: UvRect): void => {
        const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const q = up >= 0 ? [a, b, c] : [a, c, b];
        for (const p of q) pushV(p[0], y, p[1], color[0], color[1], color[2], 0.5, 0.5, rect, oneRep);
        triTo.push(fi);
      };
      const pushWall = (a: Pt2, b: Pt2, y0: number, y1: number, baseHex: string, baseRgb: Rgb3, bands: Bands, rect: UvRect, rep: UvRep, sign: 1 | -1): void => {
        if (a[0] === b[0] && a[1] === b[1]) return;
        const ex = b[0] - a[0];
        const ez = b[1] - a[1];
        const el = Math.hypot(ex, ez) || 1;
        const tk = toonK(baseHex, shadeOf((sign * -ez) / el, 0, (sign * ex) / el), bands);
        const tm = toonMulOf(tk.band, tk.idx);
        const mixW = bands.mix[tk.idx]!;
        const wr = baseRgb[0] * tm[0] * (1 - mixW) + mixW;
        const wg = baseRgb[1] * tm[1] * (1 - mixW) + mixW;
        const wb = baseRgb[2] * tm[2] * (1 - mixW) + mixW;
        const quad = [
          [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]],
          [a[0], y0, a[1]], [b[0], y1, b[1]], [a[0], y1, a[1]],
        ];
        const quadUv: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
        for (let qi = 0; qi < quad.length; qi++) {
          const p = quad[qi]!;
          const uv2 = quadUv[qi]!;
          pushV(p[0]!, p[1]!, p[2]!, wr, wg, wb, uv2[0], uv2[1], rect, rep);
        }
        triTo.push(fi, fi);          // 四边形 = 2 个三角形 ⇒ 2 个槽
      };
      const drawSolid = (part: BldPartLike, wallRect: UvRect = massCellRect): boolean => {
        const t = Number(part.h);
        const b = Number(part.hb);
        if (!Number.isFinite(t) || !Number.isFinite(b)) return false;
        const pTop = t;
        const pBase = Math.max(0, Math.min(b, pTop - 0.4));
        if (!(pTop - pBase >= 0.4)) return false;
        const { rings: prings } = outerRingsOf(part.geometry);
        if (!prings.length) return false;
        const phex = typeof part.c === "string" && part.c ? themedBuildingHex(part.c, pTop, themeId) : hex;
        const prgb = hexToRgb(phex);
        const pbands = bandsOf(phex);
        let any = false;
        for (const ring of prings) {
          if (ring.length < 3) continue;
          const pts = ring.map(([lng, lat]) => toLocal(lng, lat));
          for (const p of pts) grow(p[0], p[1]);
          const tris = triangulateRing(pts);
          if (!tris.length) continue;
          any = true;
          const capRgb: Rgb3 = [prgb[0] * ROOF_MUL[0], prgb[1] * ROOF_MUL[1], prgb[2] * ROOF_MUL[2]];
          for (let i = 0; i < tris.length; i += 3) {
            pushCapTri(pts[tris[i]!]!, pts[tris[i + 1]!]!, pts[tris[i + 2]!]!, pTop, capRgb, roofRect);
          }
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]!;
            const b2 = pts[(i + 1) % pts.length]!;
            if (a[0] === b2[0] && a[1] === b2[1]) continue;
            const el = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1;
            const rep = repeatOf(el, pTop - pBase, undefined);
            pushWall(a, b2, pBase, pTop, phex, prgb, pbands, wallRect, rep, 1);
          }
        }
        return any;
      };
      const drawBand = (part: BldPartLike, full = true): boolean => {
        const t = Number(part.h);
        const b = Number(part.hb);
        if (!Number.isFinite(t) || !Number.isFinite(b)) return false;
        const pTop = t;
        const pBase = Math.max(0, Math.min(b, pTop - 0.2));
        if (!(pTop - pBase >= 0.2)) return false;
        const br = bandRingsOf(part);
        if (!br) return false;
        const outer = br.outer.map(([lng, lat]) => toLocal(lng, lat));
        const inner = br.inner.map(([lng, lat]) => toLocal(lng, lat));
        const n = Math.min(outer.length, inner.length);
        if (n < 3) return false;
        for (const p of outer) grow(p[0], p[1]);
        for (const p of inner) grow(p[0], p[1]);
        const phex = typeof part.c === "string" && part.c ? themedBuildingHex(part.c, pTop, themeId) : hex;
        const prgb = hexToRgb(phex);
        const pbands = bandsOf(phex);
        /* LOD1：只画外圈墙（6n），不画内圈/顶环带；设备/天线也不画 */
        if (!full) {
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            pushWall(outer[i]!, outer[j]!, pBase, pTop, phex, prgb, pbands, plainRect, oneRep, 1);
          }
          return true;
        }
        const capRgb: Rgb3 = [prgb[0] * ROOF_MUL[0], prgb[1] * ROOF_MUL[1], prgb[2] * ROOF_MUL[2]];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          pushWall(outer[i]!, outer[j]!, pBase, pTop, phex, prgb, pbands, plainRect, oneRep, 1);
          pushWall(inner[i]!, inner[j]!, pBase, pTop, phex, prgb, pbands, plainRect, oneRep, -1);
          pushCapTri(outer[i]!, outer[j]!, inner[j]!, pTop, capRgb, roofRect);
          pushCapTri(outer[i]!, inner[j]!, inner[i]!, pTop, capRgb, roofRect);
        }
        return true;
      };
      /* S2：有体块就画体块（替代单块主体）；一个体块都画不出来才回退主体并计数 */
      let massDrawn = false;
      if (modelOn && massing.length) {
        for (const part of massing) {
          if (drawSolid(part)) {
            massDrawn = true;
            stats.massingParts += 1;
          }
        }
        if (massDrawn) {
          added = true;
          stats.massingBuildings += 1;
          modeled = true;
        } else {
          stats.massFallback += 1;
        }
      }
      if (!massDrawn) {
        for (const ring of rings) {
        if (ring.length < 3) continue;
        const pts = ring.map(([lng, lat]) => toLocal(lng, lat));
        for (const p of pts) grow(p[0], p[1]);
        const tris = triangulateRing(pts);
        if (!tris.length) continue;
        added = true;
        /* 立面图集：**每栋取一次**（id → 格；不在这里算抖动，抖动走顶点色） */
        const wallTop = roofPlan ? roofPlan.eave : top;
        /* 顶盖（法线朝上：算一下叉积，朝下就换序，绝不靠"输入一定是逆时针"）；
           有坡屋顶时不画平顶，墙只砌到檐口，顶上由 roofPlan 的三角接。 */
        if (!roofPlan) {
        for (let i = 0; i < tris.length; i += 3) {
          const a = pts[tris[i]!]!;
          const b = pts[tris[i + 1]!]!;
          const c = pts[tris[i + 2]!]!;
          const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const q = up >= 0 ? [a, b, c] : [a, c, b];
          for (const p of q) {
            pos.push(p[0], top, p[1]);
            /* 屋顶与墙面区分：略暗略冷（系数来自 `wsToon.ROOF_MUL`，判据可离线算） */
            col.push(rgb[0] * ROOF_MUL[0], rgb[1] * ROOF_MUL[1], rgb[2] * ROOF_MUL[2]);
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
        }
        /* 墙：每条边一个四边形（不做背面剔除的取舍 —— 材质用 DoubleSide，朝向错了也看得见） */
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[(i + 1) % pts.length]!;
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const quad = [
            [a[0], base, a[1]], [b[0], base, b[1]], [b[0], wallTop, b[1]],
            [a[0], base, a[1]], [b[0], wallTop, b[1]], [a[0], wallTop, a[1]],
          ];
          /* 墙面法线 = 这条边在水平面里转 90°（朝外那一侧由叉积定；DoubleSide 下无所谓正负，
             只要"同一个朝向拿到同一个系数"） */
          const ex = b[0] - a[0];
          const ez = b[1] - a[1];
          const el = Math.hypot(ex, ez) || 1;
          /* **卡通三级明暗 + 暖冷分色**（2026-10-17）：连续 k 先分档，再乘该档的暖冷系数。
             判据（L* 阶差、色相差）在 `world_map/ws_toon_selftest.mjs` 里离线算。 */
          /* 档位系数**按该栋基色反推**（保证暗侧 L\* ≥64，任何主题都不发黑） */
          const bs = bandsOf(hex);
          const tk = toonK(hex, shadeOf(-ez / el, 0, ex / el), bs);
          const tm = toonMulOf(tk.band, tk.idx);
          const mixW = bs.mix[tk.idx]!;
          /* 白混：乘性系数到顶后的"亮面提亮"（防止深色基色被夹在上限下） */
          const wr = rgb[0] * tm[0] * (1 - mixW) + mixW;
          const wg = rgb[1] * tm[1] * (1 - mixW) + mixW;
          const wb = rgb[2] * tm[2] * (1 - mixW) + mixW;
          /* 立面：这面墙的重复次数（横向按边长、竖向按层数/楼高）与图集格 */
          const cellRect = atlasUvOf(cellOf(fId));
          const rep = repeatOf(el, wallTop - base, (props as { lv?: unknown }).lv);
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
        /* S4：坡屋顶三角（檐口→脊/顶点）；屋顶面用屋面格，平顶盖已跳过 */
        if (roofPlan) {
          const roofRgb: Rgb3 = [rgb[0] * ROOF_MUL[0], rgb[1] * ROOF_MUL[1], rgb[2] * ROOF_MUL[2]];
          for (const face of roofPlan.faces) {
            for (const p of face) {
              pushV(p[0], p[1], p[2], roofRgb[0], roofRgb[1], roofRgb[2], 0.5, 0.5, roofRect, oneRep);
              grow(p[0], p[2]);
            }
            triTo.push(fi);
          }
          added = true;
          modeled = true;
        }
      }
      }
      /* S3：细节按预算选出的档画。tier1 = 女儿墙外圈墙；tier2 = 全带 + 设备 + 天线。 */
      if (modelOn && !roofPlan && selectedTier >= 1) {
        for (const part of parapets) {
          if (drawBand(part, selectedTier === 2)) {
            added = true;
            stats.parapetBands += 1;
            modeled = true;
          } else {
            stats.parapetDropped += 1;
          }
        }
      }
      if (modelOn && !roofPlan && selectedTier === 2) {
        for (const part of equipParts) {
          if (drawSolid(part, plainRect)) {
            added = true;
            stats.equipParts += 1;
            modeled = true;
          }
        }
        for (const part of antennaParts) {
          if (drawSolid(part, plainRect)) {
            added = true;
            stats.antennaParts += 1;
            modeled = true;
          }
        }
      }
      if (modeled) stats.modeledBuildings += 1;
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
