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
export const BUD_INFILL_TRIS = 12_000;
/** 填充实例上限（每类） */
export const INFILL_CAP = 500;
/** 单类设施/车辆的实例上限 */
export const PROP_CAP = 300;
export const VEH_CAP = 240;
/** 设施离路中心线的横向距离（米）；车辆落在车道里 */
export const PROP_SIDE_M = 8.5;
export const VEH_LANES = [-5.25, -1.75, 1.75, 5.25];
/** 撒点间距（米） */
export const PROP_STEP_M = 26;
export const VEH_STEP_M = 38;

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

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  mat.name = "ws-bld-all";
  /* T1 的盒子卡：同一个材质 + instanceColor；单独一份是为了让淡化只改一份透明度 */
  const t1Mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  t1Mat.name = "ws-bld-all-t1";

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
  const t1Mesh = new THREE.InstancedMesh(boxGeom, t1Mat, Math.max(1, n));
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
    const im = new THREE.InstancedMesh(boxGeom, t1Mat, INFILL_CAP);
    im.name = "ws-infill:" + (k === 0 ? "shop-strip" : "courtyard");
    im.frustumCulled = false;
    im.count = 0;
    im.visible = false;
    group.add(im);
    return im;
  });

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
  }
  const infill: Infill[] = [];

  const propsByKind: Place[][] = propGroups.map(() => []);
  const vehByKind: Place[][] = vehGroups.map(() => []);
  const toLocal = opts.toLocal || null;
  if (toLocal && opts.roads) {
    const lines = roadLinesOf(opts.roads, toLocal);
    let propBudget = capProps * propGroups.length * 4;
    let vehBudget = capVeh * vehGroups.length * 4;
    for (let li = 0; li < lines.length; li++) {
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
        const side = (h >> 3) & 1 ? 1 : -1;
        const off = PROP_SIDE_M + ((h >> 5) % 3);
        const nx = Math.cos(s.rot), nz = -Math.sin(s.rot);
        list.push({ x: s.x + nx * off * side, z: s.z + nz * off * side, rot: s.rot + (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
        propBudget -= 1;
      }
      /* 合成填充：直接复用同一条线的采样（props 能撒出来，这里一定也会执行） */
      const ip = sampleAlong(line, 22, (hashId("inf|" + li) % 11) * 2);
      for (let si = 0; si < ip.length; si++) {
        if (infill.length >= INFILL_CAP * 2) break;
        const sp = ip[si]!;
        const hh2 = hashId("infk|" + li + "|" + si);
        const kind: 0 | 1 = (hh2 & 1) === 0 ? 0 : 1;
        const side2 = (hh2 >> 2) & 1 ? 1 : -1;
        const nx2 = Math.cos(sp.rot), nz2 = -Math.sin(sp.rot);
        const sRGB = (v: number): number => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        const PAL: [number, number, number][] = [
          [232, 220, 200], [214, 198, 174], [230, 224, 212],
          [200, 214, 208], [206, 172, 142], [176, 190, 204],
        ].map((c) => [sRGB(c[0]!), sRGB(c[1]!), sRGB(c[2]!)] as [number, number, number]);
        if (kind === 0) {
          const w = 8 + ((hh2 >> 4) % 6);
          const d = 4.5 + ((hh2 >> 7) % 2);
          const h2 = 3.2 + ((hh2 >> 9) % 3) * 0.4;
          const off = 10.5 + ((hh2 >> 11) % 3);
          infill.push({ x: sp.x + nx2 * off * side2, z: sp.z + nz2 * off * side2, rot: sp.rot, w, d, h: h2, kind, color: PAL[hh2 % PAL.length]! });
        } else {
          const w = 6 + ((hh2 >> 4) % 6);
          const d = 6 + ((hh2 >> 8) % 5);
          const h2 = 6 + ((hh2 >> 12) % 4) * 3;
          const off = 20 + ((hh2 >> 11) % 9);
          infill.push({ x: sp.x + nx2 * off * side2, z: sp.z + nz2 * off * side2, rot: sp.rot, w, d, h: h2, kind, color: PAL[(hh2 >> 3) % PAL.length]! });
        }
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
    for (let k = 0; k < t1List.length; k++) {
      const i = t1List[k]!;
      const p = i * PLACE_STRIDE;
      v3.set(places[p]!, 0, places[p + 1]!);
      q.setFromAxisAngle(UP, places[p + 6]!);
      const h = places[p + 7]!;
      const w = places[p + 4]!;
      const d = places[p + 5]!;
      s3.set(w, h, d);
      m4.compose(v3, q, s3);
      t1Mesh.setMatrixAt(k, m4);
      if (canTint) {
        /* 匹配不上（bldPick = -1）的楼只有 T1 卡：给个中性墙色，别访问不存在的模型色 */
        const ai = bldPick[i]!;
        const c = ai >= 0 ? bldColors[ai]! : [0.74, 0.72, 0.67];
        c3.setRGB(c[0]!, c[1]!, c[2]!);
        t1Mesh.setColorAt(k, c3);
        if (t1Mesh.instanceColor) t1Mesh.instanceColor.needsUpdate = true;
      }
    }
    t1Mesh.count = t1List.length;
    t1Mesh.visible = t1List.length > 0;
    if (t1Mesh.instanceMatrix) t1Mesh.instanceMatrix.needsUpdate = true;
    live += t1List.length;
    liveTris += t1List.length * 12;

    /* ② 设施 / 车辆：按距离筛（近处优先花预算），单类 cap；T2 远景整层不画 */
    const propVis: { gi: number; p: Place; d2: number }[] = [];
    const vehVis: { gi: number; p: Place; d2: number }[] = [];
    if (tier < 2) {
      for (let gi = 0; gi < propsByKind.length; gi++) {
        for (const p of propsByKind[gi]!) {
          const dx = p.x - cx, dz = p.z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > maxD2) continue;
          if (accept && !accept(p.x, p.z)) continue;
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
    infCount.fill(0);
    if (tier < 2) {
      const infVis: { p: Infill; d2: number }[] = [];
      for (const p of infill) {
        const dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxD2) continue;
        if (accept && !accept(p.x, p.z)) continue;
        infVis.push({ p, d2 });
      }
      infVis.sort((a, b) => a.d2 - b.d2);
      const canTint2 = typeof infillMeshes[0].setColorAt === "function";
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
        if (canTint2) {
          c3.setRGB(it.p.color[0], it.p.color[1], it.p.color[2]);
          im.setColorAt(infCount[k]!, c3);
        }
        infCount[k] = infCount[k]! + 1;
        infTris += 12;
        infTotal += 1;
      }
      for (let k = 0; k < 2; k++) {
        const im = infillMeshes[k]!;
        im.count = infCount[k]!;
        im.visible = im.count > 0;
        if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }

    count = live + infTotal;
    drawnTris = liveTris + propTris + vehTris + infTris;
    } catch (e) {
      updateError = String((e as Error)?.message || e).slice(0, 160);
    }
  }

  function applyFade(f: number, toAssets: boolean): void {
    fade = clamp(f, 0, 1);
    group.visible = fade > 0;
    const opaque = toAssets || fade >= 1;
    for (const m of [mat, t1Mat]) {
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
    if (t1Mesh.visible && t1Mesh.count > 0) k += 1;
    for (const im of propMeshes) if (im.visible && im.count > 0) k += 1;
    for (const im of vehMeshes) if (im.visible && im.count > 0) k += 1;
    for (const im of infillMeshes) if (im.visible && im.count > 0) k += 1;
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
    t += t1Mesh.count * 12 + propTris + vehTris + infTris;
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
        for (const g of [...bldGeoms, ...propGeoms, ...vehGeoms, boxGeom]) g.dispose?.();
        for (const im of [...bldMeshes, t1Mesh, ...propMeshes, ...vehMeshes, ...infillMeshes]) {
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
