/* wsThreeCam.ts —— **相机模型**：与 MapLibre 同一套针孔（两个后端共用，不许各写一份）。
 *
 * MapLibre 那条式子：`cameraToCenterDistance = 0.5 × 画布CSS高 / tan(垂直视场角/2) × mpp`
 * —— 也就是 `dist = radius / tan(FOV_Y / 2)`，`radius` 是契约里的"视口半高（米）"。
 * 我们把这份模型收在这里，是因为它有**两个消费者**：
 *   · `wsThreeBackend`（独立那条路：相机自己管，正解 + 反解）；
 *   · `wsOverlayBackend`（叠加层：相机**每帧从地图读**，只用正解）。
 * 两份实现迟早漂成"两个引擎看到的不是同一眼"，所以只留一份。
 *
 * ## 这里不 import three
 * 产出是**纯数组**（位置 + 三个基向量），调用方自己包成它那套引擎认识的矩阵/向量。
 * 这样叠加层与独立路都能用，而这个文件在 node 里也能被单测。
 */

/** 垂直视场角（弧度）= 36.87°，与 MapLibre 的相机模型同一个数 */
export const FOV_Y = 0.6435011087932844;
/** 近裁剪面下限（米） */
export const NEAR_M = 0.6;
/** 每度多少米（球面近似，R = 6378137）：局部平面框架用 */
export const M_PER_DEG = 111319.49079327358;

/** 视口半高（米）→ 相机到中心的距离（米） */
export function camDistOfRadius(radius: number): number {
  return radius / Math.tan(FOV_Y / 2);
}

export interface CamFrame {
  /** 相机位置（局部米；y 向上） */
  pos: [number, number, number];
  /** 相机基（世界坐标下的 x/y/z 轴） */
  xAxis: [number, number, number];
  yAxis: [number, number, number];
  zAxis: [number, number, number];
  /** 相机到中心距离（米）—— 近远裁剪面按它算 */
  dist: number;
}

/**
 * 由"目标点 + 视口半高 + 朝向 + 俯仰"算出相机的位置与基。
 *
 * @param cx 目标点在局部框架里的 x（东，米）
 * @param cz 目标点在局部框架里的 z（南，米）
 * @param radius 视口半高（米）
 * @param bearing 度（正北 0、顺时针）
 * @param pitch 度（0 = 垂直俯视）
 *
 * ⚠️ 基是**显式给**的，不用 `lookAt`：pitch=0 时 `up × forward` 退化，three 会自己加个 1e-4
 * 的扰动，而那个扰动决定"屏幕上方是哪边"—— 靠它就等于靠实现细节。这里 x 轴恒为水平、指向屏幕右方。
 */
export function camFrameOf(cx: number, cz: number, radius: number, bearing: number, pitch: number): CamFrame {
  const dist = camDistOfRadius(radius);
  const b = (bearing * Math.PI) / 180;
  const p = (Math.max(0, Math.min(88, pitch)) * Math.PI) / 180;
  const fx = Math.sin(b);
  const fz = -Math.cos(b); // 地面上的朝向（bearing 0 = 正北 = -z）
  const dx = fx * Math.sin(p);
  const dz = fz * Math.sin(p);
  const dy = -Math.cos(p); // pitch 0 ⇒ 垂直向下看
  const pos: [number, number, number] = [cx - dx * dist, -dy * dist, cz - dz * dist];
  const zAxis: [number, number, number] = [-dx, -dy, -dz]; // 相机 +Z = 从目标指向相机
  const xAxis: [number, number, number] = [Math.cos(b), 0, Math.sin(b)];
  const yAxis: [number, number, number] = [
    zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
    zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
    zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
  ];
  return { pos, xAxis, yAxis, zAxis, dist };
}

/** 近裁剪面（米）：随距离放大，但有个下限 */
export function nearOf(dist: number): number {
  return Math.max(NEAR_M, dist / 900);
}

/** 远裁剪面（米）：把整个视野兜住（别把远处的楼切掉） */
export function farOf(dist: number, radius: number): number {
  return Math.max(4000, dist * 24 + radius * 8);
}
