/* wsMatMul.ts —— 4×4 矩阵小工具（**纯函数**：不 import three、不碰 DOM，能直接在 node 里单测）。
 *
 * ## 为什么单独抽一个模块
 * 这里栽过一次，代价是**量具静默地撒谎**：three 的 `Matrix4.elements` 是**列主序**
 * （`e[i*4+j]` = 第 j 行第 i 列），而 `Vector3.applyMatrix4` 算的是
 * `e[0]x + e[4]y + e[8]z + e[12]w`。当时那段投影代码按**行主序**读（`m[i*4+0..3]`），
 * 实际乘的是 `Mᵀ·v` —— 同一台相机同一个点差 **1071 px**，形状就是"镜像 + 放大"
 * （真机回传里那个 `cur 261 / centerErr 1210` 就是这么来的）。
 * **渲染不受影响**（three 自己算自己的），所以页面看着是好的、只有读数在骗人。
 *
 * ⇒ 口径只留在这里一份，并配一条对拍闸（`world_map/ws_overlay_matcheck_selftest.mjs`）：
 *   这里算出来的像素必须与 three 的 `Vector3.project()` 逐位一致（≤0.01 px）。
 */

/** 列主序 4×4 × 四维向量：`o[i] = Σ_j m[j*4+i]·p[j]`（与 three 同口径） */
export function mulMat(m: number[], p: number[]): number[] {
  const o = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    o[i] = m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]! * p[3]!;
  }
  return o;
}

/**
 * **错误口径的对照**：把列主序当行主序读。任何投影/拾取都不许走它 ——
 * 它只出现在自检里（"判据真的分得开对错"要用它证）。
 */
export function mulMatTransposed(m: number[], p: number[]): number[] {
  const o = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    o[i] = m[i * 4]! * p[0]! + m[i * 4 + 1]! * p[1]! + m[i * 4 + 2]! * p[2]! + m[i * 4 + 3]! * p[3]!;
  }
  return o;
}

/**
 * 局部平面坐标（`[x, z]`，y 归零）→ 画布像素。
 *
 * 传进来的是**某一帧的快照矩阵**（`matrixWorldInverse` + `projectionMatrix`）与那一帧的
 * 画布尺寸 ⇒ 量的是"屏幕上画的是什么"，不是"现在的相机是什么"。
 * 相机背后/退化情形返回 `null`（宁可不给数，也不给一个假的）。
 */
export function projectPoint(
  mwInv: number[] | null | undefined,
  proj: number[] | null | undefined,
  local: [number, number],
  w: number,
  h: number
): [number, number] | null {
  if (!mwInv || !proj) return null;
  try {
    const cam = mulMat(mwInv, [local[0], 0, local[1], 1]);
    const clip = mulMat(proj, cam);
    const wClip = clip[3]!;
    /* 透视投影里 `w_clip = -z_cam`：**非正就说明点在相机背后或在相机平面上** ——
       那种点做透视除法会得到一个"镜像"的、看着像屏幕内的假像素（实测：正后方的点会落到
       画布正中心）⇒ 宁可返回 null（调用方按"投不出来"计数），也不给一个假坐标。 */
    if (!Number.isFinite(wClip) || !(wClip > 1e-9)) return null;
    return [((clip[0]! / wClip + 1) / 2) * w, ((1 - clip[1]! / wClip) / 2) * h];
  } catch {
    return null;
  }
}

/**
 * 带高度的局部坐标 → 画布像素（`y` 是米）。
 *
 * 为什么需要：楼在屏幕上是"有高度"的，**地面点**（y=0）在俯角下常常落在楼体**下方**的
 * 空地/天空上 —— 用地面点做像素取证会读到一片空（实测：两个 20×20 采样框只命中 118 px）。
 * 采样点应该取**楼顶**（`y = top`）。
 */
export function projectPointY(
  mwInv: number[] | null | undefined,
  proj: number[] | null | undefined,
  local: [number, number],
  y: number,
  w: number,
  h: number
): [number, number] | null {
  if (!mwInv || !proj) return null;
  try {
    const cam = mulMat(mwInv, [local[0], Number(y) || 0, local[1], 1]);
    const clip = mulMat(proj, cam);
    const wClip = clip[3]!;
    if (!Number.isFinite(wClip) || !(wClip > 1e-9)) return null;
    return [((clip[0]! / wClip + 1) / 2) * w, ((1 - clip[1]! / wClip) / 2) * h];
  } catch {
    return null;
  }
}

/** 两组矩阵是否逐元素相同（拿不到就 `null` = 不知道，不是 false） */
export function matEq(a: number[] | null | undefined, b: number[] | null | undefined, eps = 1e-9): boolean | null {
  if (!a || !b || a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > eps) return false;
  return true;
}

/** 像素差（拿不到任一就给 `null`） */
export function pxDiff(a: [number, number] | null, b: [number, number] | null): number | null {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
