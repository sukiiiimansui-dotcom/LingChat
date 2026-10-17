/* wsToon.ts —— **卡通（赛璐璐）三级明暗 + 暖冷分色**的纯函数层。
 *
 * 定位（2026-10-17）：和 LingChat 的二次元 UI 一套 —— toon 分档、受光偏暖、阴面偏冷、
 * 屋顶与墙面区分。**不做**赛博朋克（与浅色底图冲突）。
 *
 * 为什么放在纯函数里：**判据要能离线算**（L\* 落带、色相差、分档阶差），不依赖 GPU。
 * 渲染侧（`wsBldMesh`）只做一件事：把连续明暗系数 `k` 换成这里给出的**三档系数与色偏**。
 *
 * 判据（见 `world_map/ws_toon_selftest.mjs`）：
 *   ① 三级明暗的 L\* 阶差 ≥ 8（美术手册"楼梯间"）
 *   ② 受光面与阴面的色相差 ≥ 8°
 *   ③ 三档的 k 严格递增（去重后恰 3 个值）
 *   ④ 变异（不分档，保留连续 k）⇒ ① / ③ 红
 */

/** 三级明暗系数：阴面 / 侧光 / 受光（乘在基色上） */
export const TOON_BANDS: readonly number[] = [0.55, 0.78, 1.0];

/** 每档的暖冷色偏（乘性，三通道）；受光偏暖（多红少蓝）、阴面偏冷（多蓝少红） */
export const TOON_TINT: readonly [number, number, number][] = [
  [0.94, 0.98, 1.1],   /* 阴面：偏冷（蓝 +10%，红 −6%） */
  [1.0, 1.0, 1.02],    /* 侧光：接近中性（略冷） */
  [1.08, 1.02, 0.92],  /* 受光：偏暖（红 +8%，蓝 −8%） */
];

/** 屋顶系数（与墙面区分：略暗、略冷） */
export const ROOF_MUL: readonly [number, number, number] = [0.88, 0.9, 0.96];

/**
 * 连续明暗系数 → **三档之一**（阈值取在档间中点）。
 * @param k 0..1 的连续明暗（Lambert 那一套算出来的）
 */
export function toonBandOf(k: number): number {
  const v = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
  if (v <= (TOON_BANDS[0]! + TOON_BANDS[1]!) / 2) return TOON_BANDS[0]!;
  if (v <= (TOON_BANDS[1]! + TOON_BANDS[2]!) / 2) return TOON_BANDS[1]!;
  return TOON_BANDS[2]!;
}

/** 档位序号（0 阴面 / 1 侧光 / 2 受光），给暖冷色偏查表用 */
export function toonBandIndex(band: number): 0 | 1 | 2 {
  if (band <= TOON_BANDS[0]!) return 0;
  if (band <= TOON_BANDS[1]!) return 1;
  return 2;
}

/** 一档的最终乘性系数（明暗 × 暖冷），三通道 */
export function toonMulOf(band: number): [number, number, number] {
  const t = TOON_TINT[toonBandIndex(band)]!;
  return [band * t[0], band * t[1], band * t[2]];
}
