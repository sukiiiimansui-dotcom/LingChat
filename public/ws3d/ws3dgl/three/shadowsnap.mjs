// shadowsnap.mjs —— 平行光阴影相机的**纹素吸附**（texel snapping）：消掉"地面移动时明暗在爬/沸"。
//
// ## 病根（一句话）
// 光源跟着角色**连续**平移（`main.mjs` 的 tick 里每帧 set 一次），而阴影贴图的纹素网格长在**光空间**里 ——
// 光源挪 1 米，同一个世界点在 shadow map 上的采样位置就挪一个亚纹素的距离：
// 每帧都落在纹素里的不同位置 ⇒ 深度比较的舍入结果每帧变 ⇒ 地面上的阴影边缘像在"爬"。
//
// ## 药（标准做法）
// 每帧先把光源/目标在**光空间**里按一个纹素的尺寸量化（`Math.round(相位/纹素)*纹素`），再变换回世界。
//   · 只有**垂直于光轴**的两个分量会改变纹素相位（沿光轴平移只改深度，网格不动）⇒ 只吸这两个；
//   · 吸附是"整个刚性平移"（光源与目标一起挪同一个向量）⇒ 光**方向**一个字节都没变；
//   · 吸完，网格在世界空间里是**固定点阵**：不动的地面点永远落在纹素里的同一个位置 ⇒ 不再重采样。
//   ⚠️ 不能图省事对世界 x/z 取整：纹素网格长在光空间里，只有当光轴与坐标轴对齐时两者才等价。
//
// ## 光空间的基底必须和 three 自己算的一模一样（否则"吸"过去的还是错的网格）
//   DirectionalLightShadow.updateMatrices → shadowCamera.position = 光源世界位置 → lookAt(light.target)
//   → Object3D.lookAt → Matrix4.lookAt(eye, target, up)：
//       z = normalize(eye - target)，x = normalize(cross(up, z))，y = cross(z, x)
//   up = shadowCamera.up = (0,1,0)（退化时 three 会把 z 抖 1e-4，本喵照抄，见 lightBasis）。
//   ⇒ 验收判据（selftest_shimmer.mjs）直接拿真 three 的 `light.shadow.matrix` 对拍，不靠嘴说。
//
// 本文件**不 import three**（纯数学，node 里能直接断言、能在无浏览器的机器上量的就是这个）。
import { STYLES } from './palette.mjs';

/** three 在 `_x.lengthSq() === 0` 时把 z 抖的这个量（Matrix4.lookAt 原文 1e-4） */
const DEGENERATE_NUDGE = 1e-4;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const L = Math.hypot(v[0], v[1], v[2]); return L ? [v[0] / L, v[1] / L, v[2] / L] : [0, 0, 1]; };

/**
 * 阴影相机的光空间基底（= three 的 `Matrix4.lookAt(eye, target, up)` 那三根轴）。
 * @param {number[]} dir 光源→目标的方向（不必归一化；`STYLES[style].sunDir` 直接喂）
 * @param {number[]} up  阴影相机的 up（默认 (0,1,0)，与 three 一致）
 * @returns {{x:number[], y:number[], z:number[]}} 三根**单位**正交轴（世界空间里表示）
 */
export function lightBasis(dir, up = [0, 1, 0]) {
  let z = unit(dir);
  let x = cross(up, z);
  if (dot(x, x) === 0) {                       // 光轴与 up 平行：照 three 的做法抖一下再叉乘
    const nudged = z.slice();
    if (Math.abs(up[2]) === 1) nudged[0] += DEGENERATE_NUDGE; else nudged[2] += DEGENERATE_NUDGE;
    z = unit(nudged);
    x = cross(up, z);
  }
  x = unit(x);
  return { x, y: cross(z, x), z };
}

/** 一个阴影纹素在世界空间里的边长（米）：正交阴影相机宽 2*area，摊到 mapSize 个纹素上 */
export function shadowTexelSize(area, mapSize) {
  return (2 * area) / Math.max(1, mapSize);
}

/**
 * 世界点落在阴影贴图上的采样坐标（单位 = **纹素**）。
 * 口径 = three 的 shadow matrix（`_updateMatrix`）：uv = 0.5*ndc + 0.5，ndc = (p-光源)·轴 / area。
 * ⇒ 同一个不动的地面点，这个值的**小数部分**就是"它落在纹素里的哪个位置"；小数部分一变，就是要重采样。
 */
export function shadowTexelCoord(p, position, basis, area, mapSize) {
  const d = [p[0] - position[0], p[1] - position[1], p[2] - position[2]];
  return [
    (0.5 * (dot(d, basis.x) / area) + 0.5) * mapSize,
    (0.5 * (dot(d, basis.y) / area) + 0.5) * mapSize,
  ];
}

/**
 * 算这一帧的光源 / 目标（已吸到纹素网格）。
 * @param {object} o
 * @param {number} o.px        角色 x（阴影区跟着它走）
 * @param {number} o.pz        角色 z
 * @param {number[]} o.sunDir  太阳方向（`STYLES[style].sunDir`）
 * @param {number} [o.distance=260] 光源离目标的距离（照抄 main.mjs 原来的 260）
 * @param {number} [o.area=150]    阴影相机半宽（`?shadowArea`）
 * @param {number} [o.mapSize=2048] 阴影贴图边长（画质档会给 2048 / 1024）
 * @param {boolean} [o.enabled=true] false = 不吸（`?snap=0` 的 A/B 退路）
 * @returns {{position:number[], target:number[], texel:number, offset:number[], snapped:boolean}}
 *          `offset` = 这一帧为了对齐网格挪了多少（世界 x/z 分量），恒在半个纹素的对角线内
 */
export function snapShadowLight(o) {
  const sunDir = o.sunDir || STYLES.day.sunDir;
  const distance = o.distance === undefined ? 260 : o.distance;
  const area = o.area === undefined ? 150 : o.area;
  const mapSize = o.mapSize === undefined ? 2048 : o.mapSize;
  const target = [o.px, 0, o.pz];
  const position = [o.px + sunDir[0] * distance, sunDir[1] * distance, o.pz + sunDir[2] * distance];
  const texel = shadowTexelSize(area, mapSize);
  // mapSize 不合理（比如阴影关掉时读到的怪值）就宁可不吸：吸错网格比不吸更糟
  if (o.enabled === false || !(area > 0) || !(mapSize >= 16) || !(texel > 0)) {
    return { position, target, texel, offset: [0, 0], snapped: false };
  }
  const b = lightBasis(sunDir);
  const ex = dot(position, b.x), ey = dot(position, b.y);
  const dx = Math.round(ex / texel) * texel - ex;   // 吸到"纹素尺寸的整数倍"这个固定点阵上
  const dy = Math.round(ey / texel) * texel - ey;
  const off = [
    b.x[0] * dx + b.y[0] * dy,
    b.x[1] * dx + b.y[1] * dy,
    b.x[2] * dx + b.y[2] * dy,
  ];
  return {
    position: [position[0] + off[0], position[1] + off[1], position[2] + off[2]],
    target: [target[0] + off[0], target[1] + off[1], target[2] + off[2]],
    texel, offset: [off[0], off[2]], snapped: true,
  };
}
