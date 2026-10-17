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

/**
 * 三级明暗的 **L\* 目标**（阴面 / 侧光 / 受光）。
 *
 * 为什么不再用固定系数（真机 2026-10-17「还是黑」）：固定 0.55 在主题基色
 * `#9fb3cc` 上算出来 **L\* = 40.5**，远低于"浅色主题下不黑"的下限 65。
 * 改成**按每栋基色的 L\* 反推系数**：无论主题深浅，阴面都落在 65 附近、
 * 相邻档阶差 ≥8 ⇒ "暗侧墙不再发黑"这条对所有主题都成立（不是只调了一次色）。
 */
export const TOON_TARGET_L: readonly number[] = [64, 73, 82];
/** 档位系数允许范围（1 以上 = 提亮；上限防过曝） */
const K_MIN = 0.3;
const K_MAX = 1.2;

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
export function toonBandOf(k: number, bands: readonly [number, number, number] = [0.8, 0.92, 1.04]): number {
  const v = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
  if (v <= (bands[0] + bands[1]) / 2) return bands[0];
  if (v <= (bands[1] + bands[2]) / 2) return bands[1];
  return bands[2];
}

const srgbToLin = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** `#rrggbb` → CIE L\*（0..100）；解析失败返回 `null` */
export function lstarOfHex(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = srgbToLin(((n >> 16) & 255) / 255);
  const g = srgbToLin(((n >> 8) & 255) / 255);
  const b = srgbToLin((n & 255) / 255);
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

/**
 * 按**基色的 L\*** 反推三档系数：让"乘完暖冷色偏之后"的 L\* 分别落在 `TOON_TARGET_L`。
 * @param baseHex 该栋的基色（主题色阶/瓦片色都行）
 * @returns `[k0, k1, k2]`（阴面 / 侧光 / 受光）
 */
export function bandsForBase(baseHex: string): { k: [number, number, number]; mix: [number, number, number] } {
  const L0 = lstarOfHex(baseHex);
  if (L0 === null || L0 <= 1) return { k: [0.8, 0.92, 1.04], mix: [0, 0, 0] };
  const yOf = (L: number): number => {
    const t = (L + 16) / 116;
    const y = t * t * t;
    return y > 0.008856 ? y : L / 903.3;
  };
  /* 基色线性 RGB（0..1），白混与评估都在这里算 */
  const m = /^#?([0-9a-f]{6})$/i.exec(baseHex)!;
  const n = parseInt(m[1]!, 16);
  const base = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const toL = (rgb: number[]): number => {
    const Y = 0.2126 * srgbToLin(rgb[0]!) + 0.7152 * srgbToLin(rgb[1]!) + 0.0722 * srgbToLin(rgb[2]!);
    return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  };
  const tintY = TOON_TINT.map((t) => 0.2126 * srgbToLin(t[0]) + 0.7152 * srgbToLin(t[1]) + 0.0722 * srgbToLin(t[2]));
  const kOut: number[] = [];
  const mixOut: number[] = [];
  let prevL: number | null = null;
  for (let i = 0; i < 3; i++) {
    /* 阶差用**实测**保证：上一档解出来多少，下一档至少 +8.5（深色基色白混饱和时也不塌） */
    const target = Math.max(TOON_TARGET_L[i]!, prevL === null ? 0 : prevL + 8.5);
    const t = TOON_TINT[i]!;
    /* 1) 先只靠乘性系数：k = (Y目标 / (Y基·tintY))^(1/2.2)，上限 K_MAX */
    let k = Math.min(K_MAX, Math.max(K_MIN, Math.pow(Math.max(1e-6, yOf(target)) / Math.max(1e-6, yOf(L0) * tintY[i]!), 1 / 2.2)));
    /* 2) 定点迭代两轮：用**真实 L* 评估**修正 k（乘性调不平就交给白混） */
    for (let it = 0; it < 3; it++) {
      const L = toL(base.map((v, c) => v * k * t[c]!));
      if (Math.abs(L - target) < 0.3) break;
      k = Math.min(K_MAX, Math.max(K_MIN, k * Math.pow(Math.max(0.0001, yOf(target)) / Math.max(1e-6, yOf(L)), 1 / 2.2)));
    }
    /* 3) 乘性到顶仍不够亮 ⇒ **白混提亮**（toon 里的"亮面提亮"，不是换色） */
    let mix = 0;
    let L = toL(base.map((v, c) => v * k * t[c]!));
    for (let it = 0; it < 40 && target - L > 0.05; it++) {
      mix = Math.min(1, mix + 0.025);
      L = toL(base.map((v, c) => (v * k * t[c]! * (1 - mix) + 1 * mix)));
    }
    prevL = L;
    kOut.push(Math.round(k * 1000) / 1000);
    mixOut.push(Math.round(mix * 1000) / 1000);
  }
  return { k: [kOut[0]!, kOut[1]!, kOut[2]!], mix: [mixOut[0]!, mixOut[1]!, mixOut[2]!] };
}

/** 档位序号（0 阴面 / 1 侧光 / 2 受光），给暖冷色偏查表用 */
export function toonBandIndex(band: number, bands: readonly [number, number, number] = [0.8, 0.92, 1.04]): 0 | 1 | 2 {
  if (band <= bands[0]) return 0;
  if (band <= bands[1]) return 1;
  return 2;
}

/** 一档的最终乘性系数（明暗 × 暖冷），三通道 */
export function toonMulOf(band: number, idx?: 0 | 1 | 2): [number, number, number] {
  const i = idx ?? toonBandIndex(band);
  const t = TOON_TINT[i]!;
  return [band * t[0], band * t[1], band * t[2]];
}
