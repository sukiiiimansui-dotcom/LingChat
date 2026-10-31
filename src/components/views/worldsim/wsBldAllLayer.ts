/* wsBldAllLayer.ts —— 资产包 v3（Blender 全量：楼 / 街道设施 / 车辆）在叠加层里的那一层。
 *
 * ## 与 v1 / v2 的分工
 * v1（Kenney 贴图调色板）与 v2（Godot 顶点色）的层仍在 `wsBldAssets.ts`，行为不动；
 * 本文件只服务 v3：**楼按真实楼高挑模型**（manifest 的 `height_m`，不按高宽比拉伸），
 * 设施/车辆按**类型**各一个 InstancedMesh，沿路网确定性撒点。
 *
 * ## 三档 LOD（见 `world_map/docs/ws-lod-tiers.md`）
 *   T0 近景 mpp < 1.2     完整模型（单件 ≤ 8k 三角）
 *   T1 中景 1.2 ~ 2.6     盒子卡（12 三角 / 栋，颜色取该楼模型的平均顶点色）
 *   T2 远景 mpp ≥ 2.6     不加载资产（交给底图体块）
 * 迟滞 15%：进档用阈值 ×0.85、退档用 ×1.15；单次 update 最多翻 8 栋的档。
 *
 * ## 预算（硬上限，按**距离升序**花）
 *   合计 ≤ 220k 三角 / ≤ 40 draws；超过就把剩下的楼留在 T1（12 三角），不会留空洞：
 *   T0 150k + T1 15k + 设施 30k + 车辆 8k + 填充 12k = 215k；draws 由 楼 T0 ≤ 20 + T1 1 +
 *   设施类型 ≤ 12 + 车辆类型 ≤ 5 = 38 兜住。
 *
 * ## 不做什么
 * · 不画道路块（v3 包里有 road 类别，等道路方案拍板再接线）；
 * · 不 import three（由调用方把 THREE 传进来，与 `wsBldAssets` 同一个口径）；
 * · 不碰 DOM / 相机（视野中心与半径由调用方递进来）。
 */

import { hashId } from "./wsBldFacade";
import { PLACE_STRIDE } from "./wsBldMesh";
import {
  ASSET_VIEW_MARGIN,
  ASSET_VIEW_MIN_M,
  decodeVertexColors,
  pickAssetFit,
  type BldAssetLayer,
  type BldAssetMeta,
  type BldAssetPack,
} from "./wsBldAssets";
import { facadeKeyOf, facadeRectOf, type FacadeUvRect } from "./wsBldFacadeAtlas";

/* ── 纯规则常量（可单测） ───────────────────────────────────────────────── */
export const LOD_T0_MPP = 1.2;
export const LOD_T1_MPP = 2.6;
export const LOD_HYST = 0.15;
export const MAX_SWITCHES = 8;
export const BUD_TRIS = 220_000;
export const BUD_DRAWS = 40;
export const BUD_T0_TRIS = 150_000;
export const BUD_T1_TRIS = 15_000;
export const BUD_PROP_TRIS = 30_000;
export const BUD_VEH_TRIS = 8_000;
export const BUD_T0_ITEM = 8000;
/** 合成填充（沿街底商条 + 内院低层）：盒子的三角预算 */
export const BUD_INFILL_TRIS = 30_000;
/** 填充实例上限（每类） */
export const INFILL_CAP = 1000;
/** 填充沿街采样间距（米）：太稀则栋/ha 上不去，太密则底商互相穿插 */
export const INFILL_STEP_M = 14;
/** 填充候选总量上限（生成侧，与单帧可见数无关；打散线序后截断即随机抽样） */
export const INFILL_MAX = 9000;

/** 填充的立面格池：底商条按哈希取一间店，内院低层按高度取一档住宅 */
export const INFILL_SHOP_CELLS = ["cafe", "pharm", "super", "salon", "rest"];
/** 内院低层：高度分档 → 候选立面（<9 m 低层、9~16 m 中层、>16 m 高层） */
export const INFILL_RES_CELLS: [string[], string[], string[]] = [
  ["house", "townhouse"],
  ["townhouse", "apartment"],
  ["apartment", "midrise"],
];
/** kitbash 挂件实例上限（全部挂件共用**一个** InstancedMesh ⇒ 只多一次 draw） */
export const ATTACH_CAP = 3600;
/** 挂件只给这个距离内的填充底商挂（远了看不到，白付三角） */
export const ATTACH_INFILL_M = 180;

/** 远处剔除的细杆类（>60 m 只剩一根像素宽的线，画出来就是闪烁的"细棍子"） */
export const PROP_FAR_DROP_M = 60;
export const PROP_FAR_DROP_KINDS = ["prop_streetlamp", "prop_sign", "prop_bench", "prop_bollard"];
/** 单类设施/车辆的实例上限 */
export const PROP_CAP = 300;
export const VEH_CAP = 240;
/** 设施离路中心线的横向距离（米）；车辆落在车道里 */
export const PROP_SIDE_M = 8.5;
export const VEH_LANES = [-5.25, -1.75, 1.75, 5.25];
/** 撒点间距（米） */
export const PROP_STEP_M = 26;
export const VEH_STEP_M = 38;

/**
 * `hashId` 的**无符号**取位：返回 `(h >>> shift) % mod`。
 *
 * 为什么要它：`hashId` 是 uint32，而 JS 的 `>>` 是**有符号**移位 —— 最高位为 1 时结果是负数，
 * `%(取模)` 于是也是负数，`PAL[-3]` 取到 undefined，`setRGB(undefined[0])` 抛 TypeError。
 * 这个异常被 `update` 的 try/catch 吞掉后整段填充写入都没执行（实测 `infill=0`、`err` 里
 * 是 `can't access property 0, ...color is undefined`）。凡是从哈希里取尺寸/下标都要走这里。
 */
export function ub(h: number, shift: number, mod: number): number {
  const m = mod > 0 ? mod : 1;
  return (h >>> shift) % m;
}

/** 填充调色板（sRGB → 线性；instanceColor 走线性工作空间） */
const INFILL_PAL: [number, number, number][] = [
  [232, 220, 200], [214, 198, 174], [230, 224, 212],
  [200, 214, 208], [206, 172, 142], [176, 190, 204],
].map((c) => {
  const srgb = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return [srgb(c[0]!), srgb(c[1]!), srgb(c[2]!)] as [number, number, number];
});


/* ── kitbash 挂件（治"同一个盒子"） ────────────────────────────────────────
 * 每个挂件就是一个盒子（复用同一个单位盒几何）⇒ **全部挂件只占一次 draw**；
 * 组合由"建筑 id 的哈希"决定：同一栋楼永远同一套挂件，不同楼互不相同。
 * 只做两个套系：conv（便利店）与 cafe（咖啡店），其余类别暂不挂。 */
export type KitClass = "conv" | "cafe";

interface AttachSpec {
  /** 横向尺寸占楼宽（或楼深）的比例 */
  w: [number, number];
  /** 竖向尺寸占楼高的比例 */
  h: [number, number];
  /** 凸出立面的进深（米） */
  depth: number;
  /** 底边离地高度（占楼高比例） */
  y: [number, number];
  /** 横向偏移（占楼宽比例，-0.5..0.5） */
  x: [number, number];
  /** 出现概率（按 id 哈希；0..1） */
  p: number;
  /** 最低楼高（米），低于它不挂（挂不上去/不合理） */
  minH: number;
  color: [number, number, number];
}

export const KIT_SPECS: Record<KitClass, AttachSpec[]> = {
  /* 便利店：亮色招牌 + 白雨棚 + 卷帘门 + 空调外机 + 广告牌 */
  conv: [
    { w: [0.46, 0.62], h: [0.10, 0.14], depth: 0.22, y: [0.60, 0.70], x: [-0.10, 0.10], p: 0.85, minH: 2.6, color: [0.93, 0.30, 0.24] },
    { w: [0.55, 0.76], h: [0.05, 0.07], depth: 0.95, y: [0.40, 0.46], x: [-0.06, 0.06], p: 0.75, minH: 2.8, color: [0.94, 0.93, 0.88] },
    { w: [0.30, 0.42], h: [0.40, 0.50], depth: 0.10, y: [0.02, 0.06], x: [-0.20, 0.20], p: 0.55, minH: 2.6, color: [0.56, 0.59, 0.61] },
    { w: [0.10, 0.14], h: [0.08, 0.11], depth: 0.32, y: [0.48, 0.62], x: [-0.34, 0.34], p: 0.60, minH: 3.0, color: [0.50, 0.52, 0.53] },
    { w: [0.26, 0.36], h: [0.05, 0.07], depth: 0.80, y: [0.66, 0.78], x: [-0.30, 0.30], p: 0.35, minH: 6.0, color: [0.75, 0.73, 0.68] },
    { w: [0.40, 0.56], h: [0.10, 0.15], depth: 0.14, y: [0.82, 0.88], x: [-0.14, 0.14], p: 0.30, minH: 3.2, color: [0.96, 0.95, 0.90] },
  ],
  /* 咖啡店：深色木招牌 + 条纹雨棚（深绿）+ 小阳台 + 空调 + 立牌 */
  cafe: [
    { w: [0.34, 0.46], h: [0.09, 0.12], depth: 0.20, y: [0.58, 0.66], x: [-0.08, 0.08], p: 0.80, minH: 2.6, color: [0.24, 0.34, 0.26] },
    { w: [0.40, 0.58], h: [0.06, 0.08], depth: 0.75, y: [0.38, 0.44], x: [-0.05, 0.05], p: 0.65, minH: 2.8, color: [0.30, 0.42, 0.32] },
    { w: [0.22, 0.30], h: [0.34, 0.42], depth: 0.12, y: [0.10, 0.16], x: [-0.24, 0.24], p: 0.45, minH: 2.6, color: [0.62, 0.56, 0.46] },
    { w: [0.09, 0.12], h: [0.07, 0.10], depth: 0.30, y: [0.50, 0.64], x: [-0.32, 0.32], p: 0.50, minH: 3.0, color: [0.48, 0.50, 0.51] },
    { w: [0.22, 0.30], h: [0.05, 0.06], depth: 0.70, y: [0.64, 0.74], x: [-0.26, 0.26], p: 0.40, minH: 5.5, color: [0.70, 0.62, 0.50] },
    { w: [0.18, 0.24], h: [0.16, 0.22], depth: 0.16, y: [0.02, 0.06], x: [-0.34, 0.34], p: 0.45, minH: 2.4, color: [0.88, 0.86, 0.78] },
  ],
};

/** 资产名 → 挂件套系（拿不到返回空串 = 不挂） */
export function kitClassOf(assetName: string): KitClass | "" {
  const m = /^bld_([a-z]+)_\d+$/.exec(String(assetName ?? ""));
  const k = m ? m[1]! : "";
  if (k === "cafe" || k === "pharm" || k === "super") return "conv";
  if (k === "rest" || k === "salon") return "cafe";
  return "";
}

export type LodTier = 0 | 1 | 2;

/** v3 的资产层总开关：T1 撑到 2.6，T2 才彻底交回底图（15% 迟滞） */
export const V3_ASSET_ON_MPP = LOD_T1_MPP;
export const V3_ASSET_OFF_MPP = LOD_T1_MPP * (1 + LOD_HYST);

/** 资产层开/关（0/1）—— 与 `lodTierStep` 的 T1/T2 边界同一口径 */
export function assetOnStep(prev: 0 | 1, mpp: number): 0 | 1 {
  const m = Number(mpp);
  if (!Number.isFinite(m) || m <= 0) return prev;
  if (prev === 1) return m >= V3_ASSET_OFF_MPP ? 0 : 1;
  return m <= V3_ASSET_ON_MPP ? 1 : 0;
}

/** 单档迟滞：进档看阈值 ×(1−h)，退档看阈值 ×(1+h)，中间保持原档 */
export function lodTierStep(prev: LodTier, mpp: number): LodTier {
  const m = Number(mpp);
  if (!Number.isFinite(m) || m <= 0) return prev;
  const inT0 = LOD_T0_MPP * (1 - LOD_HYST);
  const outT0 = LOD_T0_MPP * (1 + LOD_HYST);
  const inT1 = LOD_T1_MPP * (1 - LOD_HYST);
  const outT1 = LOD_T1_MPP * (1 + LOD_HYST);
  if (prev === 0) {
    if (m > outT1) return 2;
    if (m > outT0) return 1;
    return 0;
  }
  if (prev === 1) {
    if (m < inT0) return 0;
    if (m > outT1) return 2;
    return 1;
  }
  if (m < inT0) return 0;
  if (m < inT1) return 1;
  return 2;
}

/** 一栋楼的预算候选（纯数据；`planTiers` 用它，不碰 three） */
export interface BldPlanItem {
  /** places 里的下标 */
  i: number;
  /** 到视野中心的距离平方 */
  d2: number;
  /** 该楼模型的三角数（T0） */
  tris: number;
  /** 没有匹配模型（高度/长宽比都不达标）⇒ 这帧只能用 T1 立面卡 */
  forcedT1?: boolean;
}

export interface BldPlan {
  /** 进 T0 的楼（places 下标） */
  t0: number[];
  /** 进 T1 的楼 */
  t1: number[];
  /** 预算装不下、这帧不画的楼 */
  skipped: number[];
  t0Tris: number;
  t1Tris: number;
  /** 这一帧真的翻了多少栋的档 */
  switches: number;
}

/**
 * 预算守护：候选按距离升序，先尽量进 T0（单件 ≤8k、合计 ≤100k），装不下停 T1（12 三角/栋，
 * 合计 ≤40k），再装不下就跳过（`skipped` 非空 ⇒ `overBudget()` 如实报）。
 * `prev` 是上一帧每栋的档（-1 = 上一帧没画），单帧翻档数封顶 8。
 */
export function planTiers(
  base: LodTier,
  items: readonly BldPlanItem[],
  prev: Int8Array,
  opts: { t0Tris?: number; t1Tris?: number; maxSwitches?: number; t0Item?: number } = {}
): BldPlan {
  const t0Cap = opts.t0Tris ?? BUD_T0_TRIS;
  const t1Cap = opts.t1Tris ?? BUD_T1_TRIS;
  const maxSwitch = opts.maxSwitches ?? MAX_SWITCHES;
  const itemCap = opts.t0Item ?? BUD_T0_ITEM;
  const out: BldPlan = { t0: [], t1: [], skipped: [], t0Tris: 0, t1Tris: 0, switches: 0 };
  if (base === 2) {
    for (const it of items) out.skipped.push(it.i);
    return out;
  }
  const sorted = items.slice().sort((a, b) => a.d2 - b.d2 || a.i - b.i);
  for (const it of sorted) {
    let want: LodTier = base;
    if (it.forcedT1) want = 1;
    if (want === 0) {
      const fits = it.tris <= itemCap && out.t0Tris + it.tris <= t0Cap;
      if (!fits) want = 1;
    }
    if (want === 1 && out.t1Tris + 12 > t1Cap) {
      out.skipped.push(it.i);
      continue;
    }
    /* 单帧换档上限：超了就保持上一帧的档（上一帧没画过就按目标档） */
    const p = prev[it.i] ?? -1;
    if (p >= 0 && p !== want) {
      if (out.switches >= maxSwitch) want = p as LodTier;
      else out.switches += 1;
    }
    if (want === 0) {
      out.t0.push(it.i);
      out.t0Tris += it.tris;
    } else if (want === 1) {
      out.t1.push(it.i);
      out.t1Tris += 12;
    } else {
      out.skipped.push(it.i);
    }
  }
  return out;
}

/* ── 路网撒点（纯函数；输入经纬度 → 本地米） ─────────────────────────────── */

export type ToLocal = (lng: number, lat: number) => [number, number];
export interface RoadFcLike {
  type?: string;
  features?: unknown[];
}

/** 从 GeoJSON 路网里取折线（LineString / MultiLineString），投影到本地米 */
export function roadLinesOf(fc: RoadFcLike | null | undefined, toLocal: ToLocal): [number, number][][] {
  const out: [number, number][][] = [];
  for (const f of (fc?.features as any[]) || []) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      const line = (g.coordinates as number[][]).map((c) => toLocal(c[0]!, c[1]!));
      if (line.length >= 2) out.push(line);
    } else if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) {
      for (const part of g.coordinates as number[][][]) {
        const line = part.map((c) => toLocal(c[0]!, c[1]!));
        if (line.length >= 2) out.push(line);
      }
    }
  }
  return out;
}

export interface SamplePoint {
  x: number;
  z: number;
  /** 沿路方向（弧度；与 places 的 rotY 同一口径） */
  rot: number;
}

/** 沿折线等距采样（`phase` 错开每条线的起点，避免所有路口对齐） */
export function sampleAlong(line: readonly [number, number][], step: number, phase: number): SamplePoint[] {
  const out: SamplePoint[] = [];
  if (!(step > 0) || line.length < 2) return out;
  const segs: { ax: number; az: number; dx: number; dz: number; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1]![0], az = line[i - 1]![1];
    const dx = line[i]![0] - ax, dz = line[i]![1] - az;
    const len = Math.hypot(dx, dz);
    if (len <= 1e-6) continue;
    segs.push({ ax, az, dx, dz, len });
    total += len;
  }
  if (!segs.length) return out;
  for (let s = phase % step; s < total; s += step) {
    let rest = s;
    for (const g of segs) {
      if (rest > g.len) {
        rest -= g.len;
        continue;
      }
      const t = rest / g.len;
      out.push({ x: g.ax + g.dx * t, z: g.az + g.dz * t, rot: Math.atan2(g.dx, g.dz) });
      break;
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 图层实现
 * ══════════════════════════════════════════════════════════════════════════ */

export interface BldAllDetail {
  tier: LodTier;
  t0: number;
  t1: number;
  t2: number;
  trisT0: number;
  trisT1: number;
  trisProps: number;
  trisVeh: number;
  props: number;
  vehicles: number;
  propKinds: number;
  vehKinds: number;
  propsByKind: Record<string, number>;
  vehByKind: Record<string, number>;
  switches: number;
  skipped: number;
  draws: number;
  budget: { tris: number; draws: number; t0: number; t1: number };
  /* ── 量化（2026-10-27：重复度 / 密度 / 比例） ── */
  /** 每个 bld 资产被几栋楼用到 */
  bldByAsset: Record<string, number>;
  /** 用得最多的 5 个资产（count + 占比） */
  top5: { name: string; count: number; share: number }[];
  /** 重复度 = 最常用资产的占比（0..1） */
  repetition: number;
  /** 视野面积（公顷，按 (2r)² 估） */
  areaHa: number;
  /** 每公顷栋数（含合成填充） */
  densityPerHa: number;
  /** 每公顷**真实**楼数（不含填充） */
  bldDensityPerHa: number;
  /** 实例高宽比/深宽比的离散度 */
  ratio: { sySxMean: number; sySxSd: number; szSxMean: number; szSxSd: number };
  /** 每层层高不在 3.0~3.3 m 的实例数 / 有层数信息的实例数 */
  floorViolations: number;
  floorSamples: number;
  /** 合成填充的实例数与三角数 */
  infill: number;
  infillTris: number;
  /** 匹配不上（只能用 T1 卡）的可见楼数 */
  unmatched: number;
  /** 被拉伸出 0.7~1.4 的实例数（目标 0） */
  stretched: number;
  /** 本帧 update 抛的异常（空 = 正常） */
  err: string;
  /** 调试：合成填充撒点总数 / 本帧进入视野的候选数 / 前 3 个点与 accept 结果 */
  infillPlaced: number;
  infillSeen: number;
  infillProbe: { x: number; z: number; d2: number; ok: boolean }[];
  /** 调试：路网折线条数 / 填充候选总数（与 `infillPlaced` 比能看出上限是否截断） */
  infillLines: number;
  infillCand: number;
  /** 调试：视野内的设施候选数（预算前）/ 被">60m 细杆剔除"去掉的个数 */
  propsSeen: number;
  propsFarDrop: number;
  /** 立面图集是否真的挂上了（1 = 挂上；0 = 没纹理，T1 是纯色盒） */
  facade: number;
  /** 带立面的填充实例数 / 填充实例数（比例 = infillFacade / infill） */
  infillFacade: number;
  /** kitbash 挂件实例数（全部共用一个 draw） */
  attach: number;
  /** 「模型 + 挂件组合」口径的 top1 占比（kitbash 前后对比用；旧口径 real top1 见 repetition） */
  identityTop1: number;
  /** kitbash 开关（1 开 0 关） */
  kitbash: number;
}

export interface BldAllLayer extends BldAssetLayer {
  detail(): BldAllDetail;
}

export interface BldAllOpts {
  ids: readonly string[];
  roads?: RoadFcLike | null;
  toLocal?: ToLocal | null;
  /** 画布 CSS 高（mpp = 2×radius / 高）；缺省按 633 */
  heightPx?: number;
  capProps?: number;
  capVehicles?: number;
  /** T1 立面图集纹理（不传 = 纯色盒，行为与之前完全一致） */
  facadeTexture?: any;
  /** `false` = 强制关掉立面图集（A/B 用；默认开） */
  facadeOn?: boolean;
  /** `false` = 关掉 kitbash 挂件（A/B 用；默认开） */
  kitbash?: boolean;
  /** 平面着色（A/B 用；默认开） */
  flatShading?: boolean;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** 用包里的顶点色建一份几何（pos f32 + color u8→线性 + idx u32） */
function geometryOf(THREE: Record<string, any>, pack: BldAssetPack, m: BldAssetMeta): any {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(pack.bin, m.pos, m.verts * 3);
  if (m.color == null) throw new Error("v3 资产缺 color 段偏移：" + m.name);
  const col = decodeVertexColors(new Uint8Array(pack.bin, m.color, m.verts * 3));
  const idx = new Uint32Array(pack.bin, m.idx, m.idxCount);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 模型的平均顶点色（0..1 线性；T1 盒子卡用它上色） */
function averageColorOf(pack: BldAssetPack, m: BldAssetMeta): [number, number, number] {
  if (m.color == null) return [0.7, 0.7, 0.7];
  const src = new Uint8Array(pack.bin, m.color, m.verts * 3);
  const lin = decodeVertexColors(src);
  /* 平均色会被窗洞/屋面/阴影拉成灰；取亮度最高的那一档（≈墙面）当盒子卡的颜色 */
  const L: number[] = [];
  for (let i = 0; i < m.verts; i++) {
    L.push(lin[i * 3]! * 0.3 + lin[i * 3 + 1]! * 0.59 + lin[i * 3 + 2]! * 0.11);
  }
  L.sort((a, b) => b - a);
  const keep = Math.max(1, Math.round(L.length * 0.25));
  const cut = L[keep - 1]!;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < m.verts; i++) {
    const v = lin[i * 3]! * 0.3 + lin[i * 3 + 1]! * 0.59 + lin[i * 3 + 2]! * 0.11;
    if (v + 1e-6 < cut) continue;
    r += lin[i * 3]!;
    g += lin[i * 3 + 1]!;
    b += lin[i * 3 + 2]!;
    n += 1;
  }
  n = Math.max(1, n);
  return [r / n / 255, g / n / 255, b / n / 255];
}

/** 单位盒子（x/z −0.5..0.5，y 0..1；12 三角；白色顶点色让 instanceColor 完全生效） */
function unitBox(THREE: Record<string, any>): any {
  const g = new THREE.BufferGeometry();
  const p: number[] = [];
  for (const y of [0, 1]) for (const z of [-0.5, 0.5]) for (const x of [-0.5, 0.5]) p.push(x, y, z);
  const f = [
    0, 1, 2, 2, 1, 3, // y=0
    4, 6, 5, 5, 6, 7, // y=1
    0, 4, 1, 1, 4, 5, // z=-0.5
    2, 3, 6, 6, 3, 7, // z=+0.5
    0, 2, 4, 4, 2, 6, // x=-0.5
    1, 5, 3, 3, 5, 7, // x=+0.5
  ];
  const pos = new Float32Array(p);
  const col = new Uint8Array(pos.length);
  col.fill(255);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(f), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * 带 UV + 侧/顶两个材质组的单位盒子（与 `unitBox` 同一个占位：x/z −0.5..0.5，y 0..1）。
 *
 * 为什么要另建一份：立面图集要**每个面自己的 uv**（相邻面不能共用顶点），而且顶面
 * 不能取立面（否则"屋顶上开窗"），所以顶/底单独一个材质组（materialIndex=1）。
 * 另附 per-instance 的 `aUvRect`（u0,v0,du,dv）—— 各立面在图集里的矩形宽窄不一致。
 */
function uvBox(THREE: Record<string, any>, cap: number): any {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const groups: [number, number, number][] = [];
  /** 一个面：4 个角按「左下、右下、左上、右上」给（从外面看逆时针） */
  const face = (
    n: [number, number, number],
    bl: [number, number, number],
    br: [number, number, number],
    tl: [number, number, number],
    tr: [number, number, number],
    mi: number
  ): void => {
    const base = pos.length / 3;
    /* ⚠️ addGroup 的 start 是**索引缓冲里的偏移**，不是顶点号：这里必须先取 idx.length */
    const start = idx.length;
    for (const v of [bl, br, tl, tr]) {
      pos.push(v[0], v[1], v[2]);
      nor.push(n[0], n[1], n[2]);
    }
    uv.push(0, 0, 1, 0, 0, 1, 1, 1);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    groups.push([start, 6, mi]);
  };
  // 侧面（材质组 0）
  face([1, 0, 0], [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], 0);
  face([-1, 0, 0], [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5], 0);
  face([0, 0, 1], [-0.5, 0, 0.5], [0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], 0);
  face([0, 0, -1], [0.5, 0, -0.5], [-0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], 0);
  // 顶 / 底（材质组 1）
  face([0, 1, 0], [-0.5, 1, 0.5], [0.5, 1, 0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5], 1);
  face([0, -1, 0], [-0.5, 0, -0.5], [0.5, 0, -0.5], [-0.5, 0, 0.5], [0.5, 0, 0.5], 1);
  g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(Float32Array.from(uv), 2));
  /* ⚠️ 白色顶点色**必须给**：材质开了 `vertexColors`，缺 `color` 属性时 WebGL 给它 (0,0,0)
     ⇒ 整个立面取样完再乘 0，楼变成纯黑（实测就栽在这里：黑墙 + 正常屋面）。 */
  const col = new Uint8Array((pos.length / 3) * 3);
  col.fill(255);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  for (const [start, count, mi] of groups) g.addGroup(start, count, mi);
  g.setAttribute("aUvRect", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 4), 4));
  g.computeBoundingSphere();
  return g;
}

/**
 * 建 v3 资产层。几何只建一次；每帧只重摆实例。
 * 楼记录 `places` 与 v1/v2 同一份（[中心X, 中心Z, 底, 顶, 宽, 深, 旋转, 高]，stride 8）。
 */
export function buildBldAllLayer(
  THREE: Record<string, any>,
  pack: BldAssetPack,
  places: Float32Array,
  opts: BldAllOpts
): BldAllLayer {
  if (pack.v !== 3) throw new Error("buildBldAllLayer 只吃 v3 包，拿到 v" + pack.v);
  const n = Math.floor(places.length / PLACE_STRIDE);
  const ids = opts.ids;
  const capProps = Math.max(1, opts.capProps ?? PROP_CAP);
  const capVeh = Math.max(1, opts.capVehicles ?? VEH_CAP);
  const viewportH = Math.max(1, Number(opts.heightPx) || 633);
  const flat = opts.flatShading !== false;

  const bldAssets: BldAssetMeta[] = pack.meta.filter((m) => (m.category || "bld") === "bld");
  if (!bldAssets.length) throw new Error("v3 包里没有 category=bld 的资产");
  const propAssets = pack.meta.filter((m) => m.category === "prop");
  const vehAssets = pack.meta.filter((m) => m.category === "vehicle");

  /* 设施/车辆按 kind 分组，每类只用 variant 0 的一份几何（draw 预算只有 40） */
  const groupOf = (list: BldAssetMeta[]): { kind: string; m: BldAssetMeta }[] => {
    const seen = new Map<string, BldAssetMeta>();
    for (const m of list) {
      const k = String(m.kind || m.name);
      const cur = seen.get(k);
      if (!cur || (m.variant ?? 0) < (cur.variant ?? 0)) seen.set(k, m);
    }
    return Array.from(seen.entries()).map(([kind, m]) => ({ kind, m }));
  };
  const propGroups = groupOf(propAssets);
  const vehGroups = groupOf(vehAssets);

  /* ── 几何 + 材质 ── */
  const bldGeoms = bldAssets.map((m) => geometryOf(THREE, pack, m));
  const bldColors = bldAssets.map((m) => averageColorOf(pack, m));
  const propGeoms = propGroups.map((g) => geometryOf(THREE, pack, g.m));
  const vehGeoms = vehGroups.map((g) => geometryOf(THREE, pack, g.m));
  const boxGeom = unitBox(THREE);
  /* 立面图集（可选）：有纹理时 T1/填充的盒子换成带 UV 的盒子，侧面取样该类立面、顶面走屋面材质 */
  const facadeTex = opts.facadeTexture || null;
  const facadeOn = !!facadeTex && opts.facadeOn !== false;
  /** kitbash 挂件：URL 上的 kitbash=0 可关（A/B） */
  const kitbashOn = opts.kitbash !== false;
  /** 每份 bld 资产的图集矩形（没有该类立面 ⇒ null，用兜底矩形） */
  const bldRect: (FacadeUvRect | null)[] = facadeOn
    ? bldAssets.map((m) => facadeRectOf(facadeKeyOf(m.name)))
    : [];
  const fallbackRect: FacadeUvRect = facadeRectOf("house") || { u: 0, v: 0, du: 1, dv: 1 };

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: flat,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  mat.name = "ws-bld-all";
  /* T1 的盒子卡：同一个材质 + instanceColor；单独一份是为了让淡化只改一份透明度 */
  const t1Mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: flat,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  t1Mat.name = "ws-bld-all-t1";
  /* 立面图集挂在 T1 材质上：顶点着色器把盒子侧面的 uv 映射到**该实例**的图集矩形。
     `aUvRect` 是 per-instance 属性（每类立面的宽高比不同，矩形宽窄不一致 ⇒ 不能只传格号）。 */
  if (facadeOn) {
    t1Mat.map = facadeTex;
    t1Mat.onBeforeCompile = (shader: any): void => {
      shader.vertexShader = "attribute vec4 aUvRect;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = aUvRect.xy + vMapUv * aUvRect.zw;\n#endif"
      );
    };
    t1Mat.customProgramCacheKey = (): string => "ws-facade-atlas";
  }
  /* 屋面材质（图集模式下盒子的顶/底两个材质组）：素色 + instanceColor，不参与立面取样 */
  const roofMat = new THREE.MeshStandardMaterial({
    vertexColors: false,
    /* 屋面：浅暖灰（比立面暗一档，俯视时不会抢立面） */
    color: 0xc2bdb2,
    roughness: 0.96,
    metalness: 0,
    flatShading: flat,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  roofMat.name = "ws-bld-all-roof";
  /** 图集模式下盒子是"侧面 + 顶/底"两个材质组 ⇒ 每个 mesh 两个 draw */
  const t1Mats = facadeOn ? [t1Mat, roofMat] : t1Mat;
  /** 淡化/不透明要一起改的材质（图集模式下屋面是第二份材质） */
  const fadeMats = facadeOn ? [mat, t1Mat, roofMat] : [mat, t1Mat];
  const bldCountDraws = facadeOn ? 2 : 1;
  const boxT1 = facadeOn ? uvBox(THREE, Math.max(1, n)) : boxGeom;
  const boxInf = facadeOn
    ? [uvBox(THREE, INFILL_CAP), uvBox(THREE, INFILL_CAP)]
    : [boxGeom, boxGeom];
  /* 填充的立面池：底商条按哈希选一间店，内院低层按楼高分档（同一档里再哈希二选一） */
  const shopRects: FacadeUvRect[] = facadeOn
    ? INFILL_SHOP_CELLS.map((c) => facadeRectOf(c) || fallbackRect)
    : [];
  const resRects: FacadeUvRect[] = [];
  if (facadeOn) {
    for (const band of INFILL_RES_CELLS) {
      for (const c of band) resRects.push(facadeRectOf(c) || fallbackRect);
    }
  }

  const group = new THREE.Group();
  group.name = "ws-bld-all";
  group.visible = false;

  /** 每份 bld 资产一个 InstancedMesh（容量 = 楼数） */
  const bldMeshes = bldAssets.map((m, i) => {
    const im = new THREE.InstancedMesh(bldGeoms[i]!, mat, Math.max(1, n));
    im.name = "ws-bld-all:" + m.name;
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    group.add(im);
    return im;
  });
  const t1Mesh = new THREE.InstancedMesh(boxT1, t1Mats, Math.max(1, n));
  t1Mesh.name = "ws-bld-all:t1";
  t1Mesh.frustumCulled = false;
  t1Mesh.count = 0;
  t1Mesh.visible = false;
  group.add(t1Mesh);

  const propMeshes = propGroups.map((g, i) => {
    const im = new THREE.InstancedMesh(propGeoms[i]!, mat, capProps);
    im.name = "ws-prop:" + g.kind;
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    group.add(im);
    return im;
  });
  const vehMeshes = vehGroups.map((g, i) => {
    const im = new THREE.InstancedMesh(vehGeoms[i]!, mat, capVeh);
    im.name = "ws-veh:" + g.kind;
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    group.add(im);
    return im;
  });

  /* 合成填充（沿街底商条 / 内院低层）：两个 InstancedMesh 共用单位盒子，逐实例上色。
     位置来自路网采样（与设施/车辆同一套确定性规则），只为把"视野内栋数密度"拉到真值区间；
     它们不是真实楼，diag 里单独记 `infill`，不混进 bld 资产的重复度统计。 */
  const infillMeshes = [0, 1].map((k) => {
    const im = new THREE.InstancedMesh(boxInf[k]!, t1Mats, INFILL_CAP);
    im.name = "ws-infill:" + (k === 0 ? "shop-strip" : "courtyard");
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    group.add(im);
    return im;
  });

  /* kitbash 挂件：一个 InstancedMesh 装所有套系的挂件（只多一次 draw） */
  const attachMesh = new THREE.InstancedMesh(boxGeom, mat, ATTACH_CAP);
  attachMesh.name = "ws-attach";
  attachMesh.frustumCulled = false;
  attachMesh.count = 0;
  attachMesh.visible = false;
  group.add(attachMesh);

  /* ── 楼：每栋挑一次模型 + 目标缩放（真实高度 1:1，横向按占地夹住） ── */
  const bldPick = new Int32Array(n).fill(-1);
  const bldScale = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = i * PLACE_STRIDE;
    const h = places[p + 7]!;
    const w = places[p + 4]!;
    const d = places[p + 5]!;
    if (!(h >= 0.8) || !(w >= 0.4) || !(d >= 0.4)) continue;
    /* 高度 + 长宽比双条件匹配；匹配不上就 -1（这栋只用 T1 立面卡，**不拉伸**） */
    const ai = pickAssetFit(bldAssets, String(ids[i] ?? ""), h, w, d);
    bldPick[i] = ai;
    if (ai < 0) continue;
    const m = bldAssets[ai]!;
    const ah = Math.max(0.3, Number(m.height_m) || m.size[1] || 1);
    /* **只许等比缩放**（sx = sy = sz），限幅 0.7~1.4；超出就说明匹配条件该把它挡掉 */
    const s = clamp(h / ah, 0.7, 1.4);
    bldScale[i * 3] = s;
    bldScale[i * 3 + 1] = s;
    bldScale[i * 3 + 2] = s;
  }

  /* ── 设施/车辆：沿路网确定性撒点（每条线按名字/序号错开相位） ── */
  interface Place {
    x: number;
    z: number;
    rot: number;
  }
  interface Infill extends Place {
    w: number;
    d: number;
    h: number;
    kind: 0 | 1;
    color: [number, number, number];
    /** 立面图集模式下的中性明度抖动（0.94~1.04）：贴图自带颜色，不能再乘调色板色 */
    tint: number;
    /** 立面格编号（0..4 店 / 0..2 住宅档）：同一栋楼永远是同一格 */
    cell: number;
  }
  const infill: Infill[] = [];
  /** 本帧之前生成过的填充候选总数（诊断：与 `infill.length` 对比能看出是否被上限截断） */
  let infillCand = 0;
  let infillLines = 0;

  const propsByKind: Place[][] = propGroups.map(() => []);
  const vehByKind: Place[][] = vehGroups.map(() => []);
  const thinGroup = propGroups.map((g) => PROP_FAR_DROP_KINDS.indexOf(g.kind) >= 0);
  const toLocal = opts.toLocal || null;
  if (toLocal && opts.roads) {
    const lines = roadLinesOf(opts.roads, toLocal);
    infillLines = lines.length;
    /* **线序按 hash 打散**：填充有全局上限，按原序迭代时上限一满就只剩"前几条路"有填充
       ⇒ 换到别的机位看到 0 栋（曾经的病征）。打散后截断落在随机子集上，空间上是均匀的。 */
    const order = lines.map((_, li) => li).sort((a, b) => (hashId("lo|" + a) - hashId("lo|" + b)) || (a - b));
    let propBudget = capProps * propGroups.length * 4;
    let vehBudget = capVeh * vehGroups.length * 4;
    for (const li of order) {
      const line = lines[li]!;
      const phaseP = (hashId("p|" + li) % 17) * 1.3;
      const phaseV = (hashId("v|" + li) % 13) * 2.1;
      const pp = sampleAlong(line, PROP_STEP_M, phaseP);
      for (let si = 0; si < pp.length && propBudget > 0; si++) {
        const s = pp[si]!;
        const h = hashId("pk|" + li + "|" + si);
        const gi = h % propGroups.length;
        const list = propsByKind[gi]!;
        if (list.length >= capProps) continue;
        const side = (h >>> 3) & 1 ? 1 : -1;
        const off = PROP_SIDE_M + ub(h, 5, 3);
        const nx = Math.cos(s.rot), nz = -Math.sin(s.rot);
        list.push({ x: s.x + nx * off * side, z: s.z + nz * off * side, rot: s.rot + (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
        propBudget -= 1;
      }
      /* 合成填充：同一条线的采样点，**沿街底商条 + 内院低层两层**。
         两层各用自己的哈希（同一个哈希拆位会让两者的尺寸强相关）。 */
      const ip = sampleAlong(line, INFILL_STEP_M, ub(hashId("inf|" + li), 0, 11) * 2);
      infillCand += ip.length;
      for (let si = 0; si < ip.length; si++) {
        if (infill.length >= INFILL_MAX) break;
        const sp = ip[si]!;
        const nx2 = Math.cos(sp.rot), nz2 = -Math.sin(sp.rot);
        const hs = hashId("infs|" + li + "|" + si);
        const side2 = (hs >>> 2) & 1 ? 1 : -1;
        /* ① 底商条：贴人行道外侧，进深 4~6 m、高 3.2~4.2 m —— 每个采样点都有 */
        const sw = 8 + ub(hs, 4, 6);
        const sd = 4.5 + ub(hs, 7, 2);
        const sh = 3.2 + ub(hs, 9, 3) * 0.4;
        const soff = 10.5 + ub(hs, 11, 3);
        infill.push({
          x: sp.x + nx2 * soff * side2,
          z: sp.z + nz2 * soff * side2,
          rot: sp.rot,
          w: sw,
          d: sd,
          h: sh,
          kind: 0,
          color: INFILL_PAL[hs % INFILL_PAL.length]!,
          tint: 0.94 + ub(hs, 7, 100) / 1000,
          cell: ub(hs, 16, INFILL_SHOP_CELLS.length),
        });
        /* ② 内院低层：再退 20~28 m，2~5 层；约六成采样点有（留出院子/空地的不均匀感） */
        if (infill.length >= INFILL_MAX) break;
        const hc = hashId("infc|" + li + "|" + si);
        if (ub(hc, 20, 100) >= 60) continue;
        const cw = 6 + ub(hc, 4, 6);
        const cd = 6 + ub(hc, 8, 5);
        const ch = 6 + ub(hc, 12, 4) * 3;
        const coff = 20 + ub(hc, 11, 9);
        const cside = (hc >>> 3) & 1 ? 1 : -1;
        infill.push({
          x: sp.x + nx2 * coff * cside,
          z: sp.z + nz2 * coff * cside,
          rot: sp.rot,
          w: cw,
          d: cd,
          h: ch,
          kind: 1,
          color: INFILL_PAL[ub(hc, 5, INFILL_PAL.length)]!,
          tint: 0.94 + ub(hc, 7, 100) / 1000,
          /* 内院低层按**楼高**选立面档（同一高度带里再用哈希二选一） */
          cell: (ch > 16 ? 2 : ch > 9 ? 1 : 0) * 2 + ub(hc, 17, 2),
        });
      }

      const vp = sampleAlong(line, VEH_STEP_M, phaseV);
      for (let si = 0; si < vp.length && vehBudget > 0; si++) {
        const s = vp[si]!;
        const h = hashId("vk|" + li + "|" + si);
        const gi = h % vehGroups.length;
        const list = vehByKind[gi]!;
        if (list.length >= capVeh) continue;
        const lane = VEH_LANES[(h >> 4) % VEH_LANES.length]!;
        const dir = lane < 0 ? 1 : -1;
        const nx = Math.cos(s.rot), nz = -Math.sin(s.rot);
        list.push({ x: s.x + nx * lane, z: s.z + nz * lane, rot: s.rot + (dir < 0 ? Math.PI : 0) });
        vehBudget -= 1;
      }
    }
  }

  /* ── 合成填充：沿路采样，路边一条底商、更外侧一栋内院低层 ── */
  /* ── 每帧状态 ── */
  let count = 0;
  let drawnTris = 0;
  let visCount = 0;
  let over = false;
  let fade = 0;
  let lastCx = NaN;
  let lastCz = NaN;
  let lastR = NaN;
  let tier: LodTier = 1;
  let switches = 0;
  let skippedN = 0;
  let forcedN = 0;
  const prevTier = new Int8Array(n).fill(-1);
  const propCounts = new Int32Array(propGroups.length);
  const infCount = new Int32Array(2);
  let infTris = 0;
  let infTotal = 0;
  let infillSeen = 0;
  let infillProbe: { x: number; z: number; d2: number; ok: boolean }[] = [];
  let propsSeen = 0;
  let propsFarDrop = 0;
  /** 本帧画出来且带立面的填充实例数（分母 = infTotal） */
  let infillFacade = 0;
  /** 本帧画出来的 kitbash 挂件数 */
  let attachN = 0;
  /** 「模型 + 挂件组合」口径下的 top1 占比（重复度 A/B 用） */
  let identityTop1 = 0;
  /** 本帧真的摆出来的填充实例（挂件挂到它们身上，也用于去重统计） */
  const placedInfill: Infill[] = [];
  let lastT0: number[] = [];
  let lastT1: number[] = [];
  const vehCounts = new Int32Array(vehGroups.length);
  let propTris = 0;
  let vehTris = 0;
  let propTotal = 0;
  let vehTotal = 0;

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const c3 = new THREE.Color(1, 1, 1);
  const buckets: number[][] = bldAssets.map(() => []);
  let t1List: number[] = [];

  let updateError = "";
  function update(cx: number, cz: number, radius: number, accept?: ((x: number, z: number) => boolean) | null, force = false): void {
    try {
    const r = Number.isFinite(radius) && radius > 0 ? radius : 120;
    const mpp = (2 * r) / viewportH;
    tier = lodTierStep(tier, mpp);
    if (!force && Number.isFinite(lastCx) && Math.hypot(cx - lastCx, cz - lastCz) < 40 && Math.abs(r - lastR) < r * 0.25) return;
    lastCx = cx;
    lastCz = cz;
    lastR = r;

    const maxD = Math.max(ASSET_VIEW_MIN_M, r * ASSET_VIEW_MARGIN);
    const inner = Math.max(60, r * 1.2);
    const inner2 = inner * inner;
    const maxD2 = maxD * maxD;

    /* ① 楼：收集视野内候选（近处必进，远处看投影筛） */
    const cand: BldPlanItem[] = [];
    visCount = 0;
    for (let i = 0; i < n; i++) {
      const p = i * PLACE_STRIDE;
      const dx = places[p]! - cx;
      const dz = places[p + 1]! - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > inner2) {
        if (d2 > maxD2) { prevTier[i] = -1; continue; }
        if (accept && !accept(places[p]!, places[p + 1]!)) { prevTier[i] = -1; continue; }
      }
      visCount += 1;
      const ai = bldPick[i]!;
      cand.push({ i, d2, tris: ai >= 0 ? bldAssets[ai]!.tris : 0, forcedT1: ai < 0 });
    }
    forcedN = cand.reduce((k, c) => k + (c.forcedT1 ? 1 : 0), 0);
    const plan = planTiers(tier, cand, prevTier);
    switches = plan.switches;
    skippedN = plan.skipped.length;
    over = plan.skipped.length > 0;
    for (const b of buckets) b.length = 0;
    t1List = [];
    for (const i of plan.t0) {
      buckets[bldPick[i]!]!.push(i);
      prevTier[i] = 0;
    }
    for (const i of plan.t1) {
      t1List.push(i);
      prevTier[i] = 1;
    }
    for (const i of plan.skipped) prevTier[i] = -1;
    lastT0 = plan.t0;
    lastT1 = plan.t1;

    let live = 0;
    let liveTris = 0;
    const canTint = typeof t1Mesh.setColorAt === "function";
    for (let ai = 0; ai < bldAssets.length; ai++) {
      const list = buckets[ai]!;
      const im = bldMeshes[ai]!;
      for (let k = 0; k < list.length; k++) {
        const i = list[k]!;
        const p = i * PLACE_STRIDE;
        v3.set(places[p]!, 0, places[p + 1]!);
        q.setFromAxisAngle(UP, places[p + 6]!);
        s3.set(bldScale[i * 3]!, bldScale[i * 3 + 1]!, bldScale[i * 3 + 2]!);
        m4.compose(v3, q, s3);
        im.setMatrixAt(k, m4);
        /* 逐实例色彩抖动（同模型多栋不至于一模一样）；id 哈希 ⇒ 同一栋永远同一个色 */
        if (typeof im.setColorAt === "function") {
          const u = (hashId("tint|" + String(ids[i] ?? "")) % 1000) / 1000;
          const b = 0.9 + 0.18 * u;
          c3.setRGB(b, b * (1 + 0.03 * (u - 0.5)), b * (1 - 0.03 * (u - 0.5)));
          im.setColorAt(k, c3);
        }
      }
      im.count = list.length;
      im.visible = list.length > 0;
      if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      if (list.length) {
        live += list.length;
        liveTris += list.length * bldAssets[ai]!.tris;
      }
    }
    const t1Uv = facadeOn ? boxT1.getAttribute("aUvRect") : null;
    for (let k = 0; k < t1List.length; k++) {
      const i = t1List[k]!;
      const p = i * PLACE_STRIDE;
      const ai0 = bldPick[i]!;
      v3.set(places[p]!, 0, places[p + 1]!);
      q.setFromAxisAngle(UP, places[p + 6]!);
      const h = places[p + 7]!;
      const w = places[p + 4]!;
      const d = places[p + 5]!;
      s3.set(w, h, d);
      m4.compose(v3, q, s3);
      t1Mesh.setMatrixAt(k, m4);
      if (t1Uv) {
        const r = (ai0 >= 0 ? bldRect[ai0] : null) || fallbackRect;
        t1Uv.setXYZW(k, r.u, r.v, r.du, r.dv);
      }
      if (canTint) {
        /* 图集模式：贴图本身已经是该类资产的颜色，**不再乘模型平均色**（会变成平方变暗），
           只给一点中性抖动让同类的几栋不完全一样 */
        const ai2 = ai0 >= 0 ? ai0 : 0;
        if (facadeOn) {
          const u2 = (hashId("t1tint|" + String(ids[i] ?? "")) % 1000) / 1000;
          const b2 = 0.92 + 0.14 * u2;
          c3.setRGB(b2, b2, b2);
        } else {
          /* 匹配不上（bldPick = -1）的楼只有 T1 卡：给个中性墙色，别访问不存在的模型色 */
          const c = ai0 >= 0 ? bldColors[ai2]! : [0.74, 0.72, 0.67];
          c3.setRGB(c[0]!, c[1]!, c[2]!);
        }
        t1Mesh.setColorAt(k, c3);
        if (t1Mesh.instanceColor) t1Mesh.instanceColor.needsUpdate = true;
      }
    }
    if (t1Uv) t1Uv.needsUpdate = true;
    t1Mesh.count = t1List.length;
    t1Mesh.visible = t1List.length > 0;
    if (t1Mesh.instanceMatrix) t1Mesh.instanceMatrix.needsUpdate = true;
    live += t1List.length;
    liveTris += t1List.length * 12;

    /* ② 设施 / 车辆：按距离筛（近处优先花预算），单类 cap；T2 远景整层不画。
       细杆类（路灯/路牌/长椅/护柱）超过 60 m 直接不画：这个尺度下它们只有一两个像素宽，
       画出来是一根抖动/闪烁的"细棍子"，比不画更难看。信号灯/站台/公交站保留（体块明显）。 */
    const propVis: { gi: number; p: Place; d2: number }[] = [];
    const vehVis: { gi: number; p: Place; d2: number }[] = [];
    propsSeen = 0;
    propsFarDrop = 0;
    if (tier < 2) {
      const farDrop2 = PROP_FAR_DROP_M * PROP_FAR_DROP_M;
      for (let gi = 0; gi < propsByKind.length; gi++) {
        const thin = thinGroup[gi]!;
        for (const p of propsByKind[gi]!) {
          const dx = p.x - cx, dz = p.z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > maxD2) continue;
          if (accept && !accept(p.x, p.z)) continue;
          propsSeen += 1;
          if (thin && d2 > farDrop2) { propsFarDrop += 1; continue; }
          propVis.push({ gi, p, d2 });
        }
      }
    }
    if (tier < 2) {
      for (let gi = 0; gi < vehByKind.length; gi++) {
        for (const p of vehByKind[gi]!) {
          const dx = p.x - cx, dz = p.z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > maxD2) continue;
          if (accept && !accept(p.x, p.z)) continue;
          vehVis.push({ gi, p, d2 });
        }
      }
    }
    propVis.sort((a, b) => a.d2 - b.d2);
    vehVis.sort((a, b) => a.d2 - b.d2);

    propTotal = 0;
    propTris = 0;
    propCounts.fill(0);
    let propTrisUsed = 0;
    for (const it of propVis) {
      const per = Math.max(1, propGroups[it.gi]!.m.tris);
      if (propCounts[it.gi]! >= capProps) continue;
      if (propTrisUsed + per > BUD_PROP_TRIS) continue;
      const im = propMeshes[it.gi]!;
      const k = propCounts[it.gi]!;
      v3.set(it.p.x, 0, it.p.z);
      q.setFromAxisAngle(UP, it.p.rot);
      s3.set(1, 1, 1);
      m4.compose(v3, q, s3);
      im.setMatrixAt(k, m4);
      propCounts[it.gi] = k + 1;
      propTrisUsed += per;
      propTotal += 1;
    }
    propTris = propTrisUsed;
    for (let gi = 0; gi < propMeshes.length; gi++) {
      const im = propMeshes[gi]!;
      im.count = propCounts[gi]!;
      im.visible = im.count > 0;
      if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
    }

    vehTotal = 0;
    vehTris = 0;
    vehCounts.fill(0);
    let vehTrisUsed = 0;
    for (const it of vehVis) {
      const per = Math.max(1, vehGroups[it.gi]!.m.tris);
      if (vehCounts[it.gi]! >= capVeh) continue;
      if (vehTrisUsed + per > BUD_VEH_TRIS) continue;
      const im = vehMeshes[it.gi]!;
      const k = vehCounts[it.gi]!;
      v3.set(it.p.x, 0, it.p.z);
      q.setFromAxisAngle(UP, it.p.rot);
      s3.set(1, 1, 1);
      m4.compose(v3, q, s3);
      im.setMatrixAt(k, m4);
      vehCounts[it.gi] = k + 1;
      vehTrisUsed += per;
      vehTotal += 1;
    }
    vehTris = vehTrisUsed;
    for (let gi = 0; gi < vehMeshes.length; gi++) {
      const im = vehMeshes[gi]!;
      im.count = vehCounts[gi]!;
      im.visible = im.count > 0;
      if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
    }

    /* ③ 合成填充：同样的距离筛 + 每类 cap + 三角预算 */
    infTotal = 0;
    infTris = 0;
    infillFacade = 0;
    infCount.fill(0);
    placedInfill.length = 0;
    if (tier < 2) {
      const infVis: { p: Infill; d2: number }[] = [];
      infillProbe = [];
      for (const p of infill) {
        const dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxD2) continue;
        const okAcc = accept ? accept(p.x, p.z) : true;
        if (infillProbe.length < 3) infillProbe.push({ x: Math.round(p.x), z: Math.round(p.z), d2: Math.round(d2), ok: !!(okAcc) });
        if (accept && !okAcc) continue;
        infVis.push({ p, d2 });
      }
      infillSeen = infVis.length;
      infVis.sort((a, b) => a.d2 - b.d2);
      const canTint2 = typeof infillMeshes[0].setColorAt === "function";
      const infUv = facadeOn
        ? [boxInf[0]!.getAttribute("aUvRect"), boxInf[1]!.getAttribute("aUvRect")]
        : [null, null];
      for (const it of infVis) {
        const k = it.p.kind;
        if (infCount[k]! >= INFILL_CAP) continue;
        if (infTris + 12 > BUD_INFILL_TRIS) continue;
        const im = infillMeshes[k]!;
        v3.set(it.p.x, 0, it.p.z);
        q.setFromAxisAngle(UP, it.p.rot);
        s3.set(it.p.w, it.p.h, it.p.d);
        m4.compose(v3, q, s3);
        im.setMatrixAt(infCount[k]!, m4);
        if (facadeOn) {
          /* 逐实例给立面格：底商条按哈希选一间店、内院低层按楼高分档 */
          const pool = k === 0 ? shopRects : resRects;
          const r = pool[it.p.cell % pool.length]!;
          infUv[k]!.setXYZW(infCount[k]!, r.u, r.v, r.du, r.dv);
          infillFacade += 1;
        }
        if (canTint2) {
          if (facadeOn) {
            const t = it.p.tint;
            c3.setRGB(t, t, t);
          } else {
            c3.setRGB(it.p.color[0], it.p.color[1], it.p.color[2]);
          }
          im.setColorAt(infCount[k]!, c3);
        }
        infCount[k] = infCount[k]! + 1;
        infTris += 12;
        infTotal += 1;
        if (placedInfill.length < 2100) placedInfill.push(it.p);
      }
      for (let k = 0; k < 2; k++) {
        const im = infillMeshes[k]!;
        im.count = infCount[k]!;
        im.visible = im.count > 0;
        if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      if (infUv[0]) infUv[0].needsUpdate = true;
      if (infUv[1]) infUv[1].needsUpdate = true;
    }

    count = live + infTotal;
    drawnTris = liveTris + propTris + vehTris + infTris;

    /* ④ kitbash 挂件：按「建筑 id 的哈希」给每栋楼配一套挂件（招牌/雨棚/卷帘门/空调/阳台/广告牌）。
       全部挂件共用一个 InstancedMesh ⇒ 只多一次 draw；组合固定（同一栋楼永远同一套）。 */
    attachN = 0;
    identityTop1 = 0;
    if (tier < 2) {
      /* 去重统计（模型 + 挂件组合）**与开关无关**地算：关掉挂件时 mask=0，
         正好就是"只按模型"的旧口径，A/B 才有可比的两组数。 */
      const ident = new Map<string, number>();
      let identTotal = 0;
      const bump = (key: string): void => {
        ident.set(key, (ident.get(key) || 0) + 1);
        identTotal += 1;
      };
      const lp = (r: [number, number], h: number): number => r[0] + (r[1] - r[0]) * ((h % 97) / 97);
      /** 给一栋楼挂一套；返回 mask（0 = 没挂，identity 统计用） */
      const putKit = (
        idKey: string,
        cls: KitClass | "",
        bx: number,
        bz: number,
        rot: number,
        bw: number,
        bd: number,
        bh: number
      ): number => {
        const kit = kitbashOn && cls ? KIT_SPECS[cls] : null;
        if (!kit) return 0;
        /* 一栋只用**一面**立面（哈希定），挂件在那一面上从上到下排 */
        const face = (hashId("atf|" + idKey) >>> 5) % 4;
        const faceW = face < 2 ? bw : bd;
        const faceOff = face < 2 ? bd * 0.5 : bw * 0.5;
        const cr = Math.cos(rot), sr = Math.sin(rot);
        let mask = 0;
        for (let t = 0; t < kit.length && attachN < ATTACH_CAP; t++) {
          const sp = kit[t]!;
          if (bh < sp.minH) continue;
          const hh = hashId("att|" + idKey + "|" + t);
          if (ub(hh, 0, 1000) / 1000 >= sp.p) continue;
          const along = Math.max(0.4, faceW * lp(sp.w, ub(hh, 4, 97)));
          const hs = Math.max(0.06, bh * lp(sp.h, ub(hh, 8, 97)));
          const yb = bh * lp(sp.y, ub(hh, 12, 97));
          const xo = faceW * lp(sp.x, ub(hh, 16, 97));
          const dep = sp.depth;
          /* 局部坐标 → 世界（与楼的 rotY 同一套旋转） */
          let lx = 0, lz = 0, sx = 0, sz = 0;
          if (face === 0) { lx = xo; lz = faceOff + dep * 0.5; sx = along; sz = dep; }
          else if (face === 1) { lx = xo; lz = -(faceOff + dep * 0.5); sx = along; sz = dep; }
          else if (face === 2) { lz = xo; lx = faceOff + dep * 0.5; sx = dep; sz = along; }
          else { lz = xo; lx = -(faceOff + dep * 0.5); sx = dep; sz = along; }
          const wx = bx + lx * cr + lz * sr;
          const wz = bz - lx * sr + lz * cr;
          v3.set(wx, yb, wz);
          q.setFromAxisAngle(UP, rot);
          s3.set(sx, hs, sz);
          m4.compose(v3, q, s3);
          attachMesh.setMatrixAt(attachN, m4);
          c3.setRGB(sp.color[0], sp.color[1], sp.color[2]);
          attachMesh.setColorAt(attachN, c3);
          attachN += 1;
          mask |= 1 << t;
        }
        return mask;
      };
      /* ① T1 真楼里属于便利店/咖啡店的 */
      for (let k = 0; k < t1List.length; k++) {
        const i = t1List[k]!;
        const p = i * PLACE_STRIDE;
        const ai = bldPick[i]!;
        const nm = ai >= 0 ? bldAssets[ai]!.name : "?";
        const cls = ai >= 0 ? kitClassOf(nm) : "";
        const mask = putKit("t1|" + String(ids[i] ?? i), cls, places[p]!, places[p + 1]!, places[p + 6]!, places[p + 4]!, places[p + 5]!, places[p + 7]!);
        bump(nm + "#" + mask);
      }
      /* ② 填充：底商条按「近处才挂」的规则配一套（内院低层不挂，避免像棚子） */
      const near2 = ATTACH_INFILL_M * ATTACH_INFILL_M;
      for (const p of placedInfill) {
        if (p.kind === 1) {
          bump("infill-courtyard#0");
          continue;
        }
        const dx = p.x - cx, dz = p.z - cz;
        const dd = dx * dx + dz * dz;
        let mask = 0;
        if (dd <= near2) {
          const key = Math.round(p.x) + "|" + Math.round(p.z);
          const cls: KitClass = ub(hashId("kic|" + key), 3, 2) === 0 ? "conv" : "cafe";
          mask = putKit("if|" + key, cls, p.x, p.z, p.rot, p.w, p.d, p.h);
        }
        bump("infill-shop#" + mask);
      }
      /* top1 占比（模型 + 挂件组合） */
      let top = 0;
      for (const n of ident.values()) if (n > top) top = n;
      identityTop1 = identTotal > 0 ? Math.round((top / identTotal) * 1000) / 1000 : 0;
      attachMesh.count = attachN;
      attachMesh.visible = attachN > 0;
      if (attachMesh.instanceMatrix) attachMesh.instanceMatrix.needsUpdate = true;
      if (attachMesh.instanceColor) attachMesh.instanceColor.needsUpdate = true;
    } else {
      attachMesh.count = 0;
      attachMesh.visible = false;
    }
    drawnTris += attachN * 12;
    } catch (e) {
      updateError = String((e as Error)?.message || e).slice(0, 160);
    }
  }

  function applyFade(f: number, toAssets: boolean): void {
    fade = clamp(f, 0, 1);
    group.visible = fade > 0;
    const opaque = toAssets || fade >= 1;
    for (const m of fadeMats) {
      if (opaque) {
        m.transparent = false;
        m.opacity = 1;
        m.depthTest = true;
        m.depthWrite = true;
      } else {
        m.transparent = true;
        m.opacity = fade;
        m.depthTest = false;
        m.depthWrite = false;
      }
    }
    group.renderOrder = toAssets ? 0 : 2;
    for (const im of group.children as any[]) im.renderOrder = group.renderOrder;
  }

  function detail(): BldAllDetail {
    const byKind = (arr: Int32Array, groups: { kind: string }[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (let i = 0; i < groups.length; i++) if (arr[i]! > 0) out[groups[i]!.kind] = arr[i]!;
      return out;
    };
    const t0 = bldMeshes.reduce((k, im) => k + (im.visible ? im.count : 0), 0);
    const t1 = t1Mesh.visible ? t1Mesh.count : 0;
    const real = t0 + t1;
    /* 重复度：本帧真画出来的楼（T0+T1）按资产名计数 */
    const byAsset: Record<string, number> = {};
    for (const list of [lastT0, lastT1]) {
      for (const i of list) {
        const ai = bldPick[i]!;
        if (ai < 0) continue;
        const name = bldAssets[ai]!.name;
        byAsset[name] = (byAsset[name] || 0) + 1;
      }
    }
    const ranks = Object.entries(byAsset).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top5 = ranks.slice(0, 5).map(([name, count]) => ({ name, count, share: real ? count / real : 0 }));
    const repetition = real ? (ranks[0]?.[1] || 0) / real : 0;
    /* 比例：sy/sx、sz/sx 的均值与离散度；层高超出 3.0~3.3 m 的实例数 */
    let sySx = 0, sySx2 = 0, szSx = 0, szSx2 = 0, nR = 0;
    let floorViol = 0, floorN = 0;
    for (const list of [lastT0, lastT1]) {
      for (const i of list) {
        const sx = bldScale[i * 3]!;
        const sy = bldScale[i * 3 + 1]!;
        const sz = bldScale[i * 3 + 2]!;
        if (sx > 0) {
          const a = sy / sx, b = sz / sx;
          sySx += a; sySx2 += a * a;
          szSx += b; szSx2 += b * b;
          nR += 1;
        }
        const ai = bldPick[i]!;
        const floors = ai >= 0 ? Number(bldAssets[ai]!.floors) || 0 : 0;
        if (floors > 0) {
          floorN += 1;
          const per = places[i * PLACE_STRIDE + 7]! / floors;
          if (per < 3.0 || per > 3.3) floorViol += 1;
        }
      }
    }
    const mean = (sum: number, n: number): number => (n > 0 ? sum / n : 0);
    const sd = (sum: number, sq: number, n: number): number => {
      if (n <= 0) return 0;
      const m = sum / n;
      return Math.sqrt(Math.max(0, sq / n - m * m));
    };
    const r = lastR > 0 ? lastR : 0;
    const areaHa = r > 0 ? (2 * r) * (2 * r) / 10000 : 0;
    return {
      tier,
      t0,
      t1,
      t2: Math.max(0, visCount - real),
      trisT0: trisNow() - t1 * 12 - propTris - vehTris - infTris,
      trisT1: t1 * 12,
      trisProps: propTris,
      trisVeh: vehTris,
      props: propTotal,
      vehicles: vehTotal,
      propKinds: propGroups.length,
      vehKinds: vehGroups.length,
      propsByKind: byKind(propCounts, propGroups),
      vehByKind: byKind(vehCounts, vehGroups),
      switches,
      skipped: skippedN,
      draws: draws(),
      budget: { tris: BUD_TRIS, draws: BUD_DRAWS, t0: BUD_T0_TRIS, t1: BUD_T1_TRIS },
      bldByAsset: byAsset,
      top5,
      repetition: Math.round(repetition * 1000) / 1000,
      areaHa: Math.round(areaHa * 100) / 100,
      densityPerHa: areaHa > 0 ? Math.round((count / areaHa) * 10) / 10 : 0,
      bldDensityPerHa: areaHa > 0 ? Math.round((real / areaHa) * 10) / 10 : 0,
      ratio: {
        sySxMean: Math.round(mean(sySx, nR) * 1000) / 1000,
        sySxSd: Math.round(sd(sySx, sySx2, nR) * 1000) / 1000,
        szSxMean: Math.round(mean(szSx, nR) * 1000) / 1000,
        szSxSd: Math.round(sd(szSx, szSx2, nR) * 1000) / 1000,
      },
      floorViolations: floorViol,
      floorSamples: floorN,
      infill: infTotal,
      infillTris: infTris,
      unmatched: forcedN,
      err: updateError,
      infillPlaced: infill.length,
      infillSeen,
      infillProbe,
      infillLines,
      infillCand,
      propsSeen,
      propsFarDrop,
      facade: facadeOn ? 1 : 0,
      infillFacade,
      attach: attachN,
      identityTop1,
      kitbash: kitbashOn ? 1 : 0,
      stretched: (() => {
        let k = 0;
        for (const i of lastT0) {
          const ai = bldPick[i]!;
          if (ai < 0) continue;
          const ah = Math.max(0.3, Number(bldAssets[ai]!.height_m) || 1);
          const r = places[i * PLACE_STRIDE + 7]! / ah;
          if (r < 0.7 - 1e-6 || r > 1.4 + 1e-6) k += 1;
        }
        return k;
      })(),
    };
  }

  function draws(): number {
    let k = 0;
    for (const im of bldMeshes) if (im.visible && im.count > 0) k += 1;
    if (t1Mesh.visible && t1Mesh.count > 0) k += bldCountDraws;
    for (const im of propMeshes) if (im.visible && im.count > 0) k += 1;
    for (const im of vehMeshes) if (im.visible && im.count > 0) k += 1;
    for (const im of infillMeshes) if (im.visible && im.count > 0) k += bldCountDraws;
    if (attachMesh.visible && attachMesh.count > 0) k += 1;
    return k;
  }

  /** 从实例反算（update 半截抛异常时也比变量可靠） */
  function countNow(): number {
    let k = 0;
    for (const im of bldMeshes) k += im.count;
    k += t1Mesh.count + infTotal;
    return k;
  }
  function trisNow(): number {
    let t = 0;
    for (let i = 0; i < bldMeshes.length; i++) t += bldMeshes[i]!.count * bldAssets[i]!.tris;
    t += t1Mesh.count * 12 + propTris + vehTris + infTris + attachMesh.count * 12;
    return t;
  }

  return {
    group,
    update,
    applyFade,
    count: countNow,
    tris: trisNow,
    draws,
    overBudget: () => over,
    visible: () => visCount,
    lifted: () => 0,
    detail,
    dispose(): void {
      try {
        for (const g of [...bldGeoms, ...propGeoms, ...vehGeoms, boxGeom, boxT1, ...boxInf]) g.dispose?.();
        for (const im of [...bldMeshes, t1Mesh, ...propMeshes, ...vehMeshes, ...infillMeshes, attachMesh]) {
          im.dispose?.();
          if (im.parent) im.parent.remove(im);
        }
        mat.dispose?.();
        t1Mat.dispose?.();
        if (group.parent) group.parent.remove(group);
      } catch {
        /* 释放失败不影响页面 */
      }
    },
  };
}
