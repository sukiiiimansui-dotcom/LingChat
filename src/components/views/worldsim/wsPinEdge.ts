/**
 * wsPinEdge.ts —— 📍 **角色「屏外方向指示」的唯一真源**（2026-10-04 第七条）。
 *
 * ## 它是为哪一句话写的（机主原话）
 * 机主真机报：「**为什么其他角色不见了喵**，放大到最大后楼就没了喵」（前半句是这个模块的病）。
 * 追问后他自己**点了**方案：「**屏外加方向指示（小箭头 + 距离）**」。
 * 真因（父代理真浏览器探针量过）：角色钉子走的是地图库 `Marker`，**屏外就是真的没有**
 *   —— 没有"贴在边缘"这回事（`Marker` 出了视口就不在画面上），于是"其他角色不见了"。
 *
 * ## 这个模块是什么（纯算术，零 IO、零 DOM、Node 可直连）
 * 把「一个屏幕点」换算成「该不该画边缘箭头 / 画在哪 / 朝哪个方向 / 离我多远」。
 *   · **不管 DOM**：宿主（`WsDistrictMapLibre.vue`）建节点、写 `transform` 都在它自己那边；
 *   · **不读地图**：屏幕点由宿主用 `map.project()` 算好（角色这条路本来就有投影 ——
 *     "0 次投影"那条红线只约束**挑楼**，见 `wsBldBudget`）；
 *   · **不抛**：坏输入一律 `off:false` + 原因字段（三态纪律：数不出来就说数不出来，
 *     绝不让宿主把一个 `NaN` 写进 `transform` —— 那会让整层钉子跟着坏掉）。
 *
 * ## 角度口径（全项目唯一一处换算）
 * `angleDeg` = **屏幕上"从下往上为 0、顺时针为正"**：
 *   正上 `0` · 正右 `90` · 正下 `180` · 正左 `-90`（**取 -90 不取 270**，见 `pinEdgeAngleDegOf`）。
 * 这与既有 `wsJoystick.joyWorldHeadingOf` / `joyScreenHeadingOf` 是**同一个口径**
 *   （"屏幕 12 点 = 0、顺时针"），只是那个走 [0,360)、这里走 (-180,180]。
 * 🔴 **CSS `rotate()` 的那个 `-90` 只许出现一次**：本模块的 `pinEdgeRotateDegOf()` 直接调
 *    `wsJoystick.joyAimRotateDegOf()`（它内部就是 `norm(deg − 90)`，为"沿 +x 画的元素"服务）。
 *    宿主拿它写 `rotate(...)`，**不许自己再减一次** —— 本项目栽过"两处各写一套换算"。
 *    ⇒ 箭头图标必须沿 **+x（向右）** 画（`clip-path` 的三角尖端在右），这样同一个角
 *      在"预走线箭头"和"屏外箭头"上指的是同一个方向。
 *
 * ## 夹取（clamp）与内缩（margin）
 * 安全矩形 = 视口四边各内缩 `margin`（默认 `PIN_EDGE_MARGIN_PX`，宿主会再加上安全区/让位带）。
 *   · 目标点在矩形内（**含边界**）⇒ `off:false`，`ex/ey` = 目标点**原样**（一个像素都不动）；
 *   · 在外 ⇒ 把「窗口中心 → 目标点」这条射线夹到矩形边界上：`ex/ey` **一定在矩形内（含边）**，
 *     `clamp:true`。方向不变（夹取只改长度、不改方向 ⇒ 点积恒 > 0，自检里逐条钉着）。
 * ⚠️ "含边界"是**有意的**：恰好在 margin 线上 ⇒ 还没出去（不画箭头）；越界 1px ⇒ 出去（画）。
 *    这条边界口径是自检的变异证明对象（把"含"改成"不含"必须有一条红）。
 */

/* 🕹 两个共享量都从 `wsJoystick` 借（**不抄第二份**）：
   · `JOY_GAP_PX` —— HUD 让位带 / 📱 / 🔬 与别的东西之间的最小间距（那个模块已经在用它做摇杆的家）；
   · `joyAimRotateDegOf` —— CSS `rotate()` 的唯一 `−90`。
   ⚠️ `wsJoystick` **不 import 任何东西**（实测）⇒ 本模块 → 它，不成环、Node 里也能直接跑。 */
import { JOY_GAP_PX, joyAimRotateDegOf } from "./wsJoystick";

/** 安全矩形默认内缩（CSS px）。为什么 28：44×44 命中区的半径是 22，再加 6px 余量 ⇒
 *  箭头贴边时**不会被手指的落点区盖住**，也不会压到屏幕圆角（真机观感只有机主能判，这里是结构值）。 */
export const PIN_EDGE_MARGIN_PX = 28;

/** 与 HUD 让位带（📱 / 🔬 / 信息条）之间的最小间距 —— **与摇杆的"家"用同一个数**（`JOY_GAP_PX`）：
 *  同一块屏幕上，两个"躲让位带"的东西用两个不同的间距，迟早会在某个尺寸上打架。 */
export const PIN_EDGE_MIN_GAP_PX = JOY_GAP_PX;

/** 视口尺寸（CSS px；和 `map.getContainer().clientWidth/clientHeight` 同一个口径） */
export interface PinEdgeView {
  w: number;
  h: number;
}

/** 目标点的屏幕坐标（CSS px，左上原点；`map.project()` 给的就是这个口径） */
export interface PinEdgeTarget {
  x: number;
  y: number;
}

/** `pinEdgeOf()` 的结果（**全部是有限数或布尔**，宿主可以直接写进 `transform`） */
export interface PinEdgeResult {
  /** **该不该画边缘箭头**：`true` = 目标点在安全矩形外（屏外/贴边外） */
  off: boolean;
  /** 箭头该待的位置（CSS px）；屏内时 = 目标点原样 */
  ex: number;
  /** 同上（纵坐标） */
  ey: number;
  /** 方向角（度）：屏幕上**从下往上为 0、顺时针为正**（正左 = −90） */
  angleDeg: number;
  /** `ex/ey` 是不是被夹过（= `off`；与 `off` 分开读是为了"坏输入"那一档：两者都是 false） */
  clamp: boolean;
  /** **空串 = 正常**；非空 = 数不出来的原因（此时 `off:false`、一像素都不动，**绝不抛**） */
  note: string;
}

/**
 * 🧭 屏幕方向角：**从下往上为 0、顺时针为正**。
 *
 * 推导（一条式子，两行说清）：屏幕 y **向下**增长 ⇒ "上"是 `(0,-1)`、"右"是 `(1,0)`。
 *   要"上 = 0、右 = 90" ⇒ `atan2(dx, -dy)`：上 → `atan2(0, 1) = 0` ✓；右 → `atan2(1, 0) = 90°` ✓；
 *   下 → `atan2(0, -1) = 180°` ✓；左 → `atan2(-1, 0) = **-90°**` ✓（**取 -90 不取 270**：
 *   值域落 (-180, 180]，写进 `rotate()` 与 270 等价，但读数时"负 = 偏左"一眼能懂）。
 *
 * @returns 角度（度）；`dx=dy=0`（点在中心）⇒ 0（**不是 NaN** —— 那一档语义是"没有方向"）
 */
export function pinEdgeAngleDegOf(dx: number, dy: number): number {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  if (x === 0 && y === 0) return 0;
  return (Math.atan2(x, -y) * 180) / Math.PI;
}

/**
 * 📍 **一个屏幕点该不该画屏外箭头、画在哪、朝哪**（本模块的主函数，纯函数、无状态、不抛）。
 *
 * @param target 目标点的屏幕坐标（`map.project([lng,lat])`）
 * @param view   视口尺寸（CSS px）
 * @param margin 四边内缩（默认 `PIN_EDGE_MARGIN_PX`；宿主会把安全区/让位带折进来）
 */
export function pinEdgeOf(
  target: PinEdgeTarget,
  view: PinEdgeView,
  margin: number = PIN_EDGE_MARGIN_PX
): PinEdgeResult {
  const tx = Number(target?.x);
  const ty = Number(target?.y);
  const w = Number(view?.w);
  const h = Number(view?.h);
  const m = Number.isFinite(Number(margin)) ? Math.max(0, Number(margin)) : PIN_EDGE_MARGIN_PX;
  /* 🔴 坏输入一律**不抛**：给出 0/0（有限数，宿主写进 transform 也不会毁掉整层） + 原因。
     三态纪律：这是"数不出来"，不是"在屏内" —— 所以 `off:false` 之外还要 `note` 非空，
     调用方（宿主）据此**不写这一颗钉子的箭头**，而不是把它当成"屏内、不用管"。 */
  const bad = (note: string): PinEdgeResult => ({
    off: false, ex: Number.isFinite(tx) ? tx : 0, ey: Number.isFinite(ty) ? ty : 0,
    angleDeg: 0, clamp: false, note,
  });
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return bad("目标点不是有限数");
  if (!Number.isFinite(w) || !Number.isFinite(h)) return bad("视口尺寸不是有限数");
  if (w <= 0 || h <= 0) return bad("视口尺寸不是正数");
  /* 矩形退化（两条边各内缩 margin 之后什么都不剩）⇒ 数不出来：绝不返回一个"夹到奇怪的线上"的点 */
  const halfW = w / 2 - m;
  const halfH = h / 2 - m;
  if (!(halfW > 0) || !(halfH > 0)) return bad("margin 过大（内缩后矩形没有面积）");

  const cx = w / 2;
  const cy = h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const angleDeg = pinEdgeAngleDegOf(dx, dy);
  /* ① 屏内（**含边界**）：原样返回，一像素都不动 */
  if (tx >= m && tx <= w - m && ty >= m && ty <= h - m) {
    return { off: false, ex: tx, ey: ty, angleDeg, clamp: false, note: "" };
  }
  /* ② 屏外：把「中心 → 目标」这条射线夹到矩形边界上（**只改长度、不改方向**）。
        `t` = 射线还能走多远（两轴各算一次，取小的那个 ⇒ 先撞上的那条边就是答案）。
        某一轴的分量为 0 ⇒ 它不构成限制（`Infinity` 不参与 min）。 */
  const ux = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const uy = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(ux, uy);
  if (!Number.isFinite(t)) return bad("射线定不出来（目标点就在中心却判在屏外）");
  let ex = cx + dx * t;
  let ey = cy + dy * t;
  /* 浮点兜底：乘法可能把点甩出去 1e-12 ⇒ 再夹一次（保证"一定在矩形内（含边）"这条硬承诺） */
  ex = Math.max(m, Math.min(w - m, ex));
  ey = Math.max(m, Math.min(h - m, ey));
  return { off: true, ex, ey, angleDeg, clamp: true, note: "" };
}

/**
 * 🎯 **该写进 CSS `rotate()` 的角度**（唯一一处 `−90`，直接复用摇杆那份）。
 *
 * 为什么要有这个转口：本模块的 `angleDeg` 是"上 = 0"的地理口径，而 `rotate(θ)` 转的是**沿 +x 画**的元素
 *   ⇒ 要它指向 `angleDeg` 就得写 `angleDeg − 90`。这个换算 `wsJoystick.joyAimRotateDegOf()` 里
 *   已经有一份（预走线容器用的就是它）⇒ 这里**转调**，不写第二份。
 */
export function pinEdgeRotateDegOf(angleDeg: number): number {
  return joyAimRotateDegOf(Number.isFinite(Number(angleDeg)) ? Number(angleDeg) : 0);
}

/**
 * 📏 **距离文案**（屏外箭头旁边那一行）。
 *
 * 口径（自检逐条钉着字面量）：
 *   · `0` ⇒ `"0 m"` —— **不许**写成 `0.0 km`（"我刚站在那儿"不该显示成公里）；
 *   · `< 1000 m` ⇒ 整数米（`999` ⇒ `"999 m"`）；
 *   · `≥ 1000 m` ⇒ 保留一位小数的公里（`1000` ⇒ `"1.0 km"`、`1234` ⇒ `"1.2 km"`）；
 *   · **数不出来**（`null` / `undefined` / `NaN` / 负数）⇒ `"—"`（三态纪律：不许拿 0 冒充）。
 * ⚠️ 分支看的是**四舍五入之后**的米数 ⇒ `999.6` 显示 `"1.0 km"`（不是 `"1000 m"`）：先定单位、再写数，
 *    免得出现"1000 m"这种与下一档重复的写法。
 */
export function pinDistText(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return "—";
  const v = Number(meters);
  if (!Number.isFinite(v) || v < 0) return "—";
  const r = Math.round(v);
  return r < 1000 ? r + " m" : (r / 1000).toFixed(1) + " km";
}
