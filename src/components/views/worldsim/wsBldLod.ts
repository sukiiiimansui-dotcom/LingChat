/* wsBldLod.ts —— **楼房细节 LOD 的纯阈值/滞回**（不 import three、不碰 DOM/地图）。
 *
 * 口径（S3）：`Hpx = 楼高 / mpp × pitchCos`，单位 CSS 像素。
 *   · < 32px：只画体块（远景）
 *   · 32~72px：女儿墙只画**外圈墙**（无顶环带），设备箱/天线不画
 *   · ≥ 72px：女儿墙全带 + 设备箱 + 天线（近景）
 *
 * 滞回 ±15%：进入用阈值 ×1.15、退出用 ÷1.15，状态按楼 id 记在 `BldLodState`。
 * 状态是**唯一**的“跨重建记忆”；几何函数仍只吃输入，`buildBldMeshData` 通过 `lod.state` 注入。
 *
 * 为什么不做“按帧率自动降”：用户红线。这里只有固定像素阈值 + 固定顶点预算。
 */

export const LOD_DETAIL_PX = 32;
export const LOD_FULL_PX = 72;
export const LOD_HYSTERESIS = 0.15;
/** 细节顶点预算（只算女儿墙/设备/天线；体块不算） */
export const DETAIL_VERTS_MAX = 22_000;
/** 单栋细节顶点上限（女儿墙/设备/天线；体块不算） */
export const DETAIL_PER_BUILDING_VERTS = 96;
/** 地标/多体块塔的单栋细节上限（4 段体块 + 女儿墙 + 设备/天线要放得下） */
export const DETAIL_PER_BUILDING_LANDMARK_VERTS = 1_200;
/** 默认 mpp：z16.4 · 纬度 29.56°（米/CSS 像素，512px 瓦片口径）。真机接线前 `?model=1` 用这个。 */
export const DEFAULT_LOD_MPP = 0.787;

export type LodTier = 0 | 1 | 2;

/** 单次判定（纯函数；prev 由状态模块给） */
export function lodTierOfHpx(prev: LodTier | undefined, hpx: number): LodTier {
  const x = Number.isFinite(hpx) ? Math.max(0, hpx) : 0;
  const detailOn = LOD_DETAIL_PX * (1 + LOD_HYSTERESIS);
  const detailOff = LOD_DETAIL_PX * (1 - LOD_HYSTERESIS);
  const fullOn = LOD_FULL_PX * (1 + LOD_HYSTERESIS);
  const fullOff = LOD_FULL_PX * (1 - LOD_HYSTERESIS);
  if (prev === 2) return x >= fullOff ? 2 : x >= detailOff ? 1 : 0;
  if (prev === 1) return x >= fullOn ? 2 : x >= detailOff ? 1 : 0;
  return x >= fullOn ? 2 : x >= detailOn ? 1 : 0;
}

export interface BldLodState {
  /** 按楼 id 记上一档；同一个 id 在反复重建时保持滞回 */
  tierOf(id: string, hpx: number): LodTier;
  reset(): void;
  size(): number;
}

export function createBldLodState(): BldLodState {
  const tiers = new Map<string, LodTier>();
  return {
    tierOf(id, hpx) {
      const t = lodTierOfHpx(tiers.get(id), hpx);
      tiers.set(id, t);
      return t;
    },
    reset() {
      tiers.clear();
    },
    size() {
      return tiers.size;
    },
  };
}

/** 进程内共享状态（App/页面各自一份；自检可自己 create 一份，避免互相污染） */
export const sharedBldLodState = createBldLodState();

/* ── S5：真机 zoom → mpp 的**只读实时上下文**（由 MVT 覆层/three 相机写入） ──
   只在重建时读；稳态每帧不读、不判。`?z=`/`?mpp=` 仍优先于它（排查口）。 */
let liveMpp: number | null = null;

/** MapLibre 视野变化时写一次（`mvtCoverageRun` 调；lat 用 bounds 中心） */
export function noteView(zoom: number, lat = 29.56): void {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return;
  const m = mppAtZoom(z, lat);
  if (m > 0) liveMpp = m;
}

/** 直接写 mpp（three 相机帧用；给不到 zoom 时） */
export function noteMpp(mpp: number): void {
  const m = Number(mpp);
  if (Number.isFinite(m) && m > 0) liveMpp = m;
}

/** 最近一次真机视野的 mpp；没写过 ⇒ null（`wsBldMesh` 再退默认） */
export function lodMppNow(): number | null {
  return liveMpp;
}

/** 自检/换图时清空（不影响共享 LOD 档状态） */
export function resetLiveView(): void {
  liveMpp = null;
}

/** zoom + 纬度 → 米/CSS 像素（Web Mercator）。
 *  ⚠️ 必须用 MapLibre 的 **512px 瓦片**口径：`40075016.686 / 512 ≈ 78271.517`；
 *  `156543.03392` 是 **256px 瓦片**的旧口径，会让 Hpx 大一倍、细节晚一档出现。
 *  与 `wsBldBudget.bldMetersPerCssPixel` 同式（那边是唯一真源，自检对拍）。 */
export function mppAtZoom(zoom: number, lat = 29.56): number {
  const z = Number.isFinite(zoom) ? zoom : 16.4;
  const la = Number.isFinite(lat) ? lat : 29.56;
  return ((40075016.686 / 512) * Math.cos((la * Math.PI) / 180)) / Math.pow(2, z);
}


/* ── S6：最近一次建模的 facts（真机/HUD 读；不参与几何） ───────────────── */
let modelFacts: Record<string, unknown> | null = null;

export function noteModelFacts(facts: Record<string, unknown>): void {
  modelFacts = facts;
  try {
    (globalThis as { __WS_MODEL__?: unknown }).__WS_MODEL__ = facts;
  } catch {
    /* 写入失败不影响渲染 */
  }
}

export function modelFactsNow(): Record<string, unknown> | null {
  return modelFacts;
}
