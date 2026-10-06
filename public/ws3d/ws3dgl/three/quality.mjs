// quality.mjs —— 画质策略（**纯逻辑**：dpr / MSAA / 阴影 / LOD / 渲染路径）。
//
// 为什么单独一个文件：这些"旋钮往哪拧"的判断原来长在 main.mjs 里，而 main.mjs 一 import 就碰
// window/document（`window.addEventListener('error', …)`）⇒ node 里根本 import 不了，
// 于是"自适应会不会偷偷降 dpr"这种事**只能靠真机看**。搬到这份无依赖模块之后，
// selftest_anime.mjs 能在 node 里直接喂坏帧时间断言它（不吃 GPU、不开浏览器）。
//
// 口径（主人拍板，2026-10-06）：
//   · dpr 默认 = min(devicePixelRatio, 3)，**自适应画质不许动 dpr**（要的就是这个清晰度）；
//   · MSAA 默认 0（dpr 3 本身就是超采样），`?msaa=2|4` 保留；
//   · 阴影半径 90m、隔帧更新；画质档只动 阴影 / LOD / bloom。
import { OUTLINE } from './palette.mjs';

/** 清晰度上限：手机上通常 devicePixelRatio 就是 3 */
export const DPR_MAX = 3;
/** 页面「清晰度」按钮的循环档（从高到低） */
export const DPR_PRESETS = [3, 2, 1.5, 1];
/** 抗锯齿档：0 = 关（默认）；2 / 4 = composer 那个 RT 的 samples。0 也接受 ?msaa=0 */
export const MSAA_MODES = [0, 2, 4];

/**
 * 画质梯子：**只有 阴影 / LOD / bloom 三项**，故意不含 dpr ——
 * 自适应能往下退的旋钮就这些，梯子里没有 dpr，代码里也就没法"顺手"把清晰度降掉。
 */
export const LEVELS = [
  { name: '满档', shadow: 2048, near: 270, mid: 640, bloom: true },
  { name: '降阴影', shadow: 1536, near: 250, mid: 600, bloom: true },
  { name: '降阴影+泛光', shadow: 1024, near: 220, mid: 520, bloom: false },
  { name: '低 LOD', shadow: 1024, near: 180, mid: 430, bloom: false },
  { name: '最低', shadow: 0, near: 150, mid: 340, bloom: false },
];

/** 阴影相机半宽（米）：150 → 90，2048 贴图下一个纹素 14.65cm → 8.8cm（更锐且不更贵） */
export const SHADOW_AREA = 90;
/** 阴影贴图隔帧更新（1 = 每帧，2 = 隔帧）。人站着不动时干脆不重算 */
export const SHADOW_EVERY = 2;

/** 阴影纹素尺寸（米/纹素）：2*area/mapSize —— 与 shadowsnap.mjs 用的是同一个公式 */
export function shadowTexel(area, mapSize) {
  return (2 * area) / Math.max(1, mapSize);
}

/**
 * 选 dpr。优先级：`?dpr=` > 页面开关 > 默认满档。
 * 一律 clamp 到 devicePixelRatio 与 DPR_MAX —— 渲染超过物理像素没意义（那是白烧填充率）。
 * @param {{devicePixelRatio?:number,query?:number|null,ui?:number|null,max?:number}} o
 */
export function pickDpr({ devicePixelRatio = 1, query = null, ui = null, max = DPR_MAX } = {}) {
  const native = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const want = query !== null && query !== undefined ? Number(query)
    : (ui !== null && ui !== undefined ? Number(ui) : max);
  const dpr = Number.isFinite(want) && want > 0 ? want : max;
  return Math.min(native, dpr, max);
}

/** 选 MSAA：`?msaa=` > 页面开关 > 默认 0（只接受 0/2/4，别的值退到最近的合法档） */
export function pickMsaa({ query = null, ui = null, modes = MSAA_MODES } = {}) {
  const raw = query !== null && query !== undefined ? Number(query) : (ui !== null && ui !== undefined ? Number(ui) : 0);
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  let best = modes[1];
  for (const m of modes) if (m > 0 && Math.abs(m - raw) < Math.abs(best - raw)) best = m;
  return best;
}

/** 阴影贴图分辨率：`?shadowRes=`（只在满档生效）> 画质档 */
export function pickShadowRes({ quality = 0, levels = LEVELS, query = null } = {}) {
  const L = levels[Math.min(quality, levels.length - 1)];
  if (quality === 0 && query !== null && query !== undefined && Number.isFinite(Number(query))) return Number(query);
  return L.shadow;
}

/**
 * 自适应的**下一步**（纯函数：喂一串帧时间，告诉你档位该不该动、为什么动）。
 * 🔴 返回值里**只有 quality**：没有任何一条路能改 dpr。
 * @param {{frameMs:number[], quality:number, sinceLastChangeMs:number, levels?:Array, cooldownMs?:number, minFrames?:number}} o
 */
export function adaptiveStep({
  frameMs = [], quality = 0, sinceLastChangeMs = Infinity, levels = LEVELS, cooldownMs = 2500, minFrames = 40,
} = {}) {
  const last = levels.length - 1;
  const q = Math.max(0, Math.min(last, quality));
  if (sinceLastChangeMs < cooldownMs || frameMs.length < minFrames) {
    return { quality: q, changed: false, why: null, med: null };
  }
  const recent = frameMs.slice(-30).slice().sort((a, b) => a - b);
  const med = recent[recent.length >> 1];
  const ok = frameMs.slice(-90).every((v) => v < 14.5);
  if (med > 19.5 && q < last) {
    return { quality: q + 1, changed: true, med, why: `帧耗时中位 ${med.toFixed(1)}ms ⇒ 自动降档（只动阴影与 LOD，dpr 不动）` };
  }
  if (ok && frameMs.length >= 85 && q > 0) {
    return { quality: q - 1, changed: true, med, why: '稳定 60fps ⇒ 升回一档（dpr 不动）' };
  }
  return { quality: q, changed: false, med, why: `帧耗时中位 ${med.toFixed(1)}ms` };
}

/**
 * 这一帧走哪条渲染路。**没有后处理时绝不能走 composer**：
 * composer 那条路是"渲染到 RT → 全屏 blit 到画布"，dpr 3 下这一层全屏带宽很贵（还多一张 3× 的 RT）。
 * @param {{hasComposer?:boolean,bloomOn?:boolean,sharpOn?:boolean,outlineOn?:boolean}} o
 * @returns {'composer'|'outline'|'direct'}
 */
export function renderPath({ hasComposer = false, bloomOn = false, sharpOn = false, outlineOn = false } = {}) {
  if (hasComposer && (bloomOn || sharpOn)) return 'composer';
  if (outlineOn) return 'outline';
  return 'direct';
}

/** 描边参数（与 App 2D 那档同色；thickness 见 ART-PLAN-ANIME.md §4） */
export function outlineParams() { return { color: OUTLINE.color, thickness: OUTLINE.thickness }; }
