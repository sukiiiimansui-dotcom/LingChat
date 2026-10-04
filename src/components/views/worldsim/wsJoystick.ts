// 🕹 **摇杆输入 + 漫游位置真源 + 近景（角色第一视角）常量与开关**（2026-10-03 机主裁决：
// 「街景不要了喵，直接给我们的地图做一个近景（角色第一视角）」，见 `world_map/PROJECT-STATE.md` 轮 51）。
//
// ## 这个文件里有什么（五块，其余一律不做）
//   ① **一个向量**：把指针位置变成推杆向量（死区 / 归一化 / 夹紧 / 松手归零），全是纯函数
//      ⇒ 能在 Node 里钉字面量断言（`world_map/ws_joystick_selftest.mjs`），不用开浏览器；
//   ② **唯一驱动点**：`createJoyDriver()` —— 指针事件**只写 `setVector()` 这一个向量**，
//      真正的相机更新只发生在**一个 rAF** 里（pointermove 1000 次/秒 ⇒ 相机最多 60 次/秒）。
//      rAF/时钟/世界尺度全部可注入 ⇒ 离线也能数帧数。**松手后同一个 rAF 继续跑"回中段"**
//      （只有相机在动，`onFrame` 带 `phase:"center"`），相机贴回角色才发那一次 `onHalt`。
//   ③ **运动模型**：选档（米/秒）→（加速/摩擦）→ 速度 →（积分）→ 角色位移；
//      相机**阻尼跟随 + 有界前瞻 + 死区 + 停下回中**。
//      🔴 2026-10-03 第一轮机主验收：「这个移动**不能真正像游戏那样移动**！甚至**角色都没有动**，
//      太杂鱼了！**能去学游戏引擎吗**」——病根就是缺这一块：上一版把**输入直接当速度**、
//      而且**只推相机**，相机又正好锁在角色身上 ⇒ 屏幕上那颗钉子一动不动。
//      🔴 2026-10-03 第二轮机主验收：「**视角无法锁定角色，位移很大喵！！！**」——两处病根：
//      ① 速度按"屏宽/秒"给 ⇒ 世界速度 967 m/s（瞬移）；② 前瞻**无界**、松手**不回中** ⇒ 角色被
//      永久甩在画面外 176.7px。两条都在本文件里改掉了（见"两条红线"与第三节）。
//      依据逐条落在 `world_map/RESEARCH-GAME-MOVEMENT.md`（引擎官方文档；本文件每条都注明 §几）。
//   ④ **「我」的漫游位置真源**：`roamStore`。🔴 语义是**漫游（演示）**，**不是 GPS**：
//      · **不写进 `wsRuntimePush`**（推给 Rust 的 me 只允许是真定位，否则模型会真以为玩家在那儿）；
//      · 也**不当** gameplay 的距离依据（期 3「走近说话」12/20 米那条判词的口径是"真坐标"，
//        拿演示位置去算会得出"你离他 8 米"这种编出来的结论 ⇒ 要接必须先给判词加第四态，见 `ROAM_NOTE`）。
//   ⑤ **开关与持久化**：**默认关** + 玩家面板里的开关 + `wsm:v1:joy` 记忆 + `?joy=1/0` 逃生口（见第 六 节）。
//      ⚠️ 机主 2026-10-03 改过一次口径：不再默认开、也不做常驻摇杆 ⇒ **改开关先读第 六 节**。
//
// ## 两条红线（写在这里，因为最容易在"顺手优化"时破掉）
//   · 🔴 **速度定义在**世界单位（米/秒）**，屏幕速度是**结果**：`px/s = m/s ÷ 米每像素`（研究 §6）。
//     上一版按「屏宽/秒」给（`JOY_SCREEN_PER_SEC = 0.6`）⇒ z16.4 的 1024px 屏上等于
//     **967 m/s ≈ 3482 km/h** —— 机主验收原话就是「**位移很大喵！！！**」，那不是在走，是在瞬移。
//     现在只有两个**物理**档（`joySpeedMpsOf(zoom)`：步行 1.4 / 载具 13.9）+ 一个**硬上限**
//     `JOY_SPEED_MAX_MPS`；嫌慢就走"缩放档位 / 载具"那条路（研究 §7/§8），
//     **不许**再拿屏宽把世界速度偷偷放大。
//     米每像素**不在本文件里算**（不写第二份换算 —— 这条红线照旧）：宿主用既有那把唯一的尺子
//     `bldMetersPerCssPixel(zoom, lat)` 量好、当作 `JoyCtx.mpp` 传进来；尺子的用法只是从
//     "定速度"变成"换算结果"。
//     相机的实际位移只交给 `map.panBy([dx,dy],{duration:0})`（库内已处理 pitch/bearing）。
//   · 🕹 **相机距离（zoom）是"看得见在动"的第三根杠杆**（2026-10-03 第三轮，机主拍板走"拉近"）：
//     世界速度有硬上限、档位又不能突变 ⇒ 剩下唯一能调的就是**相机离多远**。方向**只能是拉近**：
//     `px/s = (m/s) ÷ 米每像素`，而米每像素每级恰好翻倍（研究 §9.4）⇒ 拉远只会让屏幕位移**减半**
//     （8.8276 → 4.4138 px/s），拉近才让它翻倍（`JOY_ZOOM_PUSH_LEVELS = 1.18` ⇒ 2^1.18 ≈ 2.266 倍）。
//     🔴 三件事一起守住：① 世界速度一个字不改（变的只是同一段位移占多少屏幕像素）；
//     ② 相机距离的变化**走既有相机通路**（宿主用 `easeTo({zoom,duration:0})`，本文件一行投影数学都不写）；
//     ③ 松手后的回程**复用** `JOY_RECENTER_TAU_S`（与"相机贴回角色"同一套，不新造第二套回程）。
//     ⚠️ 拉近期间**名字层必须整层隐藏**（判据在 `joyNamesHiddenOf`，理由见研究 §9.6）：标签坐标是按
//     进近景那一刻的 zoom 投影好写进 DOM 的，容器只补 translate；zoom 一变就系统性错位。
//   · **不 import vue / 不 import 地图库 / 不碰 `document`/`window`**：本文件必须能在 node 里直接跑。
//     唯一的浏览器 IO 是 `localStorage`（`readJoyStored`/`writeJoyStored` 两个函数、全程 try/catch，
//     与 `wsBldMode.ts` 同款）—— 在 node 里 `typeof localStorage === "undefined"` ⇒ 退回默认（关）。

/* ══════════════════════════════════════════════════════════════════
 * 一、几何与手感常量（**唯一真源**：组件 CSS 从 CSS 变量取、HUD 让位也从这里算）
 * ══════════════════════════════════════════════════════════════════ */

/** 底盘直径（px）——`PLAN-JOYSTICK-STREETVIEW.md` §2.2 / `UI-DESIGN-SPEC.md:112` */
export const JOY_BASE_PX = 112;
/** 可见杆头直径（px）——同上（杆头只影响观感，**不**决定命中区） */
export const JOY_THUMB_PX = 52;
/** 命中区下限（px）——触控红线 ≥44×44（`UI-DESIGN-SPEC.md:112`）；底盘 112 就是命中区 */
export const JOY_HIT_MIN_PX = 44;
/** 距屏幕左边/下边（px）——与 HUD 同一条 8px 边距（左下拇指区，见 §2.2） */
export const JOY_INSET_PX = 8;
/** 摇杆顶边与 HUD 之间的缝（px）——HUD 让位 = 底盘 + 两个 8px */
export const JOY_GAP_PX = 8;
/**
 * HUD 要抬高多少（px）= 底盘 + 边距 + 缝。
 * 🔴 **让位是必须的**：HUD 也在 `left:8 bottom:8`（`WsDistrictMapLibre.vue` 的 `.ws-dml__hud`），
 * 不让位就正好压住 HUD 最左一格（"街区视野…"那一格）。无摇杆路 `--ws-joy-h` = 0 ⇒ HUD 逐字不变。
 */
export const JOY_HUD_LIFT_PX = JOY_BASE_PX + JOY_INSET_PX + JOY_GAP_PX;
/** 杆头能走的半径（px）——由上面两个常量推出，组件**不再写第二份** */
export const JOY_THUMB_TRAVEL_PX = (JOY_BASE_PX - JOY_THUMB_PX) / 2;

/** 死区（占半径的比例）：手指按住不动时的抖动不该让画面漂 */
export const JOY_DEADZONE = 0.12;
/**
 * **步行档**满推速度（米/秒）——本文件唯一的"速度真源"（研究 §6）。
 * 依据：① Unity `NavMeshAgent.speed` 的语义就是"世界单位/秒 的**最大**速度"（[官方](https://docs.unity3d.com/ScriptReference/AI.NavMeshAgent-speed.html)）；
 *      ② 数值与本仓既有真源 `src-tauri/src/world_map/move.rs` 的 `Walk`（1.4 m/s）对齐 —— 两处不许各写一版。
 */
export const JOY_SPEED_MPS = 1.4;
/**
 * **载具/漫游档**满推速度（米/秒）= **50 km/h**（城市道路口径）。
 * 为什么要有这一档：本屏近景是 z16.4 ⇒ 一屏 ≈ 1.6 km，步行 1.4 m/s 在这个尺度上只有
 * **0.89 px/s**（一屏走 19 分钟）—— 那不是"慢"，是"看不出来"（研究 §8 老实写清了这件事）。
 * 载具档在同一档缩放上是 **8.8 px/s**（一屏 116 秒），是**物理上真实的**车速，
 * 而不是"按屏幕像素反过来放大世界速度"（那条路机主本轮明确禁止）。
 */
export const JOY_SPEED_ROAM_MPS = 13.9;
/** 🔴 **世界速度硬上限**（米/秒）：任何档位、任何输入（哪怕 `mag > 1` 的坏向量）都不得超过它 */
export const JOY_SPEED_MAX_MPS = 13.9;
/** 速度档的缩放分界：`z ≥ 17`（一屏 ≲ 300m，步行尺度）⇒ 步行档；否则 ⇒ 载具档 */
export const JOY_SPEED_ZOOM_WALK = 17;

/* ──────────────────────────────────────────────────────────────────
 * 🕹 **相机距离（拉近）**——四个常量全在这里，唯一的真源（2026-10-03 第三轮，机主拍板 Ⓐ）
 * 为什么需要它（研究 §9.5 的可数证据）：世界速度有硬上限（13.9 m/s）、档位不许突变，
 * 于是"屏幕上几乎不动"这件事只剩**相机离多远**可调：本屏 z16.4 上 8.8276 px/s，
 * 起推后相机要 **2266ms** 才动（死区 20px ÷ 速度），手机一屏（420px）要 **47.6 秒**。
 * 🔴 方向只有拉近一条：米/像素每级翻倍 ⇒ 拉远 = 屏幕位移**减半**（§9.4）。
 * ────────────────────────────────────────────────────────────────── */
/**
 * **推杆期间相机拉近多少级**（zoom 级数，**正 = 拉近**；0 = 关掉这条通路）。
 * 取 **1.18** 的算法（不是拍脑袋）：要让"起推后相机 ≤1 秒就开始动"（= 死区 20px ÷ 屏幕速度）
 * 需要 20 px/s，而现在是 8.8276 px/s ⇒ 需要 20/8.8276 = 2.2658 倍 ⇒ `log2(2.2658) = 1.1799` 级。
 * 拉近后：**20.0058 px/s**（一屏 21.0 秒，起推 1000ms 内相机就动），且世界速度一个字没改。
 */
export const JOY_ZOOM_PUSH_LEVELS = 1.18;
/**
 * 🔴 **拉近的上限**（级数）——`joyCtxOf()` 拿它夹 `zoomLevels`，坏输入（Infinity / 999）也顶不破。
 * 依据（研究 §9.2）：导航 SDK 也把这件事夹住 —— Mapbox `FollowingFrameOptions.maxZoom = 16.35` /
 * `minZoom = 10.5`，而且 zoom/pitch/padding/bearing 各有 `*UpdatesAllowed` 开关。
 * 数量级取 2.5 级（2^2.5 ≈ 5.66 倍 ⇒ 50 px/s 那一档）：再近就只剩几十米，
 * 反而看不出"我在城市的哪儿"，也就失去了近景的意义。
 */
export const JOY_ZOOM_MAX_LEVELS = 2.5;
/**
 * 拉近的时间常数 τ（秒）——推杆期间相机距离按它**指数逼近**（与速度那条同构，研究 §1）。
 * 0.5s ⇒ 1 秒走完 `1 − e^(−2) = 86.47%`（1.0203044 级），1.5 秒 95.02%（1.1212512 级）。
 * 取 0.5 而不是瞬移：相机距离突变 = 画面整体缩放一下，比走得慢更难受（§3 的阻尼跟随同理）。
 */
export const JOY_ZOOM_TAU_S = 0.5;
/**
 * 拉近量的**归零阈值**（级数）——指数衰减永远到不了 0 ⇒ 低于它就**写恰好 0**。
 * 🔴 这条是"松手后 zoom 回到出发值"的**结构保证**（容差 0，不是"差一点点"）：
 * `joyZoom0 + 0 === joyZoom0` 逐位相等，相机距离也随之**逐位**回到进近景那一刻，
 * 名字层才敢在同一帧恢复显示（`joyNamesHiddenOf` 用同一个阈值）。
 */
export const JOY_ZOOM_EPS_LEVELS = 0.001;
/** 单帧最大步长（ms）：掉帧/后台回来时**不许**一次跳出去（64 ≈ 15.6fps 的一帧） */
export const JOY_MAX_DT_MS = 64;
/** 近景倾角（度）：机主裁决 **60~70**；`maxPitch` = 70（`wsScene.CAMERA_DEFAULTS`）⇒ 取 64 留余量 */
export const JOY_PITCH_DEG = 64;

/** 推杆向量：**屏幕坐标**（x 右为正、y 下为正），与 `panBy` 同一套，省一次符号换算 */
export interface JoyVector {
  /** 方向 × 推出量（含死区已扣）；范围 [-1,1] */
  x: number;
  /** 同上（下为正） */
  y: number;
  /** 推出量 0..1（= hypot(x,y)）：0 = 没推/死区内 ⇒ 相机一次都不更新 */
  mag: number;
}
/** 归零向量（松手 / 死区内 / 还没按下）——**冻结**：地图组件把它当只读用 */
export const JOY_ZERO: Readonly<JoyVector> = Object.freeze({ x: 0, y: 0, mag: 0 });

/* ══════════════════════════════════════════════════════════════════
 * 二、纯函数：指针位置 → 向量 → 每帧屏幕位移
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 推杆向量（纯函数）。
 * @param dx     指针相对**底盘中心**的横向位移（px，右为正）
 * @param dy     纵向位移（px，**下为正**）
 * @param radius 底盘半径（px）——手指推出底盘也算"满推"（夹紧到 1，不按超出比例放大）
 *
 * 三件事一起做完：**死区内归零** → **线性去死区并归一化到 0..1** → **方向保持**。
 * ⚠️ 边界口径（自检钉着）：`|r| ≤ 死区` ⇒ **0**（含恰好等于死区）；
 *    `|r| ≥ 半径` ⇒ `mag = 1`（方向不变）。
 */
export function joyVectorOf(dx: number, dy: number, radius: number): JoyVector {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const len = Math.hypot(dx, dy);
  if (!r || !Number.isFinite(len) || len <= 0) return { ...JOY_ZERO };
  const raw = len / r; // 0..∞（可以 > 1）
  const mag = raw >= 1 ? 1 : raw <= JOY_DEADZONE ? 0 : (raw - JOY_DEADZONE) / (1 - JOY_DEADZONE);
  if (!mag) return { ...JOY_ZERO };
  return { x: (dx / len) * mag, y: (dy / len) * mag, mag };
}

/** 指针事件 → 向量（组件只调这个；中心与半径在**按下那一刻**量一次，见组件里的说明） */
export function joyVectorFromPointer(
  p: { clientX: number; clientY: number },
  box: { cx: number; cy: number; radius: number }
): JoyVector {
  return joyVectorOf(p.clientX - box.cx, p.clientY - box.cy, box.radius);
}

/**
 * 杆头的视觉位移（px；相对底盘中心，右/下为正）。
 *
 * 🔴 与**相机**的那份向量故意不同口径：死区是给"手按住不动时画面别漂"用的，
 * 而杆头必须**老老实实跟着手指**（死区内也是）—— 否则按住轻推时杆头像卡住了，手感是坏的。
 * 所以这里只做"比例 × 行程 + 夹紧"，与 `joyVectorOf` 的死区无关。
 */
export function joyThumbOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const len = Math.hypot(dx, dy);
  if (!r || !Number.isFinite(len) || len <= 0) return { x: 0, y: 0 };
  const k = (Math.min(1, len / r) / len) * JOY_THUMB_TRAVEL_PX;
  return { x: dx * k, y: dy * k };
}

/**
 * 一帧要用到的**世界尺度**（宿主量好传进来；本文件一行米/像素换算都不写 —— 红线）。
 * 三个数各只有一个来源：`screenW` = 地图容器宽（组件在按下那一刻量一次）、
 * `mpp` = `bldMetersPerCssPixel(zoom, lat)`（宿主在 `joyCalibrate` 里量一次）、
 * `speedMps` = `joySpeedMpsOf(zoom)`（同一处选档）。
 * ⚠️ `screenW` **只**用于"前瞻上限 = 屏宽 × 比例"这一处 —— 速度**不再**由屏宽决定。
 * 🕹 `zoomLevels` 是第四个数：**推杆期间相机拉近多少级**，由宿主在 `joyCalibrate()` 里"量到了出发 zoom"
 * 才给 `JOY_ZOOM_PUSH_LEVELS`，量不到就给 **0**（⇒ 这条通路整条关闭，宁可不拉，也不把相机移到 zoom 0）。
 */
export interface JoyCtx {
  /** 地图容器宽度（px） */
  screenW: number;
  /** 米/像素（**唯一那把尺子**：与挑楼/楼高共用 `bldMetersPerCssPixel`） */
  mpp: number;
  /** 满推速度（米/秒，**世界单位**）：`joySpeedMpsOf(zoom)` 选出来的那一档 */
  speedMps: number;
  /** 🕹 推杆期间相机**拉近**多少级（0 = 不拉；正 = 拉近）——由 `JOY_ZOOM_PUSH_LEVELS` 供，这里夹到上限 */
  zoomLevels: number;
}

/**
 * ctx 归一化：非有限 / ≤0 一律**归 0** ⇒ 这一步什么都不走
 * （"量不到尺子就站住"，与 `joyPxScaleOf` 的"宁可不动，也不写编出来的坐标"同一条纪律）。
 * ⚠️ `zoomLevels` 例外：它**可以是 0**（= 不拉近），所以不能用上面那条"≤0 归 0"；
 *    非有限一律 0，其余夹进 `[0, JOY_ZOOM_MAX_LEVELS]`（坏输入顶不破上限 —— §9.2 的"上限"纪律）。
 */
export function joyCtxOf(x: Partial<JoyCtx> | null | undefined): JoyCtx {
  const n = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) && f > 0 ? f : 0;
  };
  const zl = (v: unknown): number => {
    const f = Number(v);
    if (!Number.isFinite(f) || f <= 0) return 0;
    return Math.min(JOY_ZOOM_MAX_LEVELS, f);
  };
  return x
    ? { screenW: n(x.screenW), mpp: n(x.mpp), speedMps: n(x.speedMps), zoomLevels: zl(x.zoomLevels) }
    : { screenW: 0, mpp: 0, speedMps: 0, zoomLevels: 0 };
}

/**
 * 满速向量（px/s）——**唯一一处**「世界速度 → 屏幕速度」换算：`px/s = m/s ÷ 米每像素`（研究 §6）。
 * 🔴 上限在这里夹（`JOY_SPEED_MAX_MPS`）：输入推出量 >1 的坏向量也只给到上限
 *    ⇒"世界位移永远 ≤ 上限 × 时间"是**结构上**成立的，不靠调用方自觉。
 * ⚠️ 与 `joyScreenDelta` 的分工：那个是"一帧走多远"（`dt` 要**夹到 64ms**，掉帧不跳变）；
 *    这个是"一秒走多远"（**不夹** —— 它就是速度目标，被 `joyMotionStep` 的积分用）。
 */
export function joyTargetVelocity(v: JoyVector, ctx: JoyCtx): { dx: number; dy: number } {
  const c = joyCtxOf(ctx);
  const unit = v ? Math.hypot(v.x, v.y) : 0;
  if (!(c.mpp > 0) || !(unit > 0) || !(v.mag > 0)) return { dx: 0, dy: 0 };
  /* 世界速度（m/s）：满推速度与上限取小，再乘推出量（夹到 1） */
  const sp = Math.min(c.speedMps, JOY_SPEED_MAX_MPS) * Math.min(1, Math.abs(v.mag));
  const k = sp / c.mpp / unit; // (m/s) ÷ (m/px) ÷ |方向| ⇒ 每单位分量的 px/s
  return { dx: v.x * k, dy: v.y * k };
}

/**
 * 一帧的屏幕位移（px，**右/下为正**）—— **满速下的稳态位移**，不是"这一帧真实走了多远"
 * （真实位移见 `joyMotionStep()`：要先加速/摩擦）。留它是为了"不作加速那条对照"能被离线数出来。
 * ⚠️ `dtMs` 在这里**夹到 `JOY_MAX_DT_MS`**（只此一处夹 —— 掉帧时不许跳变）。
 */
export function joyScreenDelta(v: JoyVector, ctx: JoyCtx, dtMs: number): { dx: number; dy: number } {
  const t = joyTargetVelocity(v, ctx);
  const f = clampDt(dtMs) / 1000;
  if (!f) return { dx: 0, dy: 0 };
  return { dx: t.dx * f, dy: t.dy * f };
}

/** 单帧 dt 的**唯一夹法**（`joyScreenDelta` 与 `joyMotionStep` 共用；掉帧时不许跳变） */
export function clampDt(dtMs: number): number {
  return Number.isFinite(dtMs) ? Math.min(JOY_MAX_DT_MS, Math.max(0, dtMs)) : 0;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、运动模型：选档 →（加速/摩擦）→ 速度 →（积分）→ 角色位移；相机阻尼跟随 + **有界**前瞻 + 死区 + 停下回中
 * ══════════════════════════════════════════════════════════════════
 * 依据 `world_map/RESEARCH-GAME-MOVEMENT.md`（游戏引擎官方文档/公认工程实践；每条后面的 §n 指那份文件）。
 * 五件事全在 `joyMotionStep()` 这一个纯函数里，**一帧调一次**：
 *   ① **选档**（§6/§7）：满推速度由 `joySpeedMpsOf(zoom)` 从**物理档位表**里选（步行/载具），
 *      再由 `joyTargetVelocity` 换算成 px/s（`m/s ÷ mpp`）—— 屏宽**不参与**速度。
 *   ② **输入不是速度**（§1）：再按时间常数 τ 把速度**指数逼近**目标。
 *      `v += (vT - v) × (1 - e^(-dt/τ))` —— 与帧率无关（60fps 与 30fps 手感一致），也**不会瞬间满速**。
 *      推杆用 `JOY_ACCEL_TAU_S`、回中用 `JOY_FRICTION_TAU_S`；指数衰减永远到不了 0
 *      ⇒ 低于 `JOY_REST_MPS`（**世界单位**）直接**写 0**（判据：停稳可判、rAF 链能收尾）。
 *   ③ **按 dt 积分**（§2）：位移 = **新**速度 × dt（半隐式欧拉：先更新速度再积分位置 —— 比显式欧拉稳）。
 *      dt 只有 `clampDt()` 一处夹（≤64ms）⇒ 掉帧/后台回来不会一次跳出去。
 *   ④ **角色与相机分开 + 前瞻有界**（§3/§7）：角色按自己的速度在世界里走；相机目标是「角色 + 前瞻」，
 *      前瞻 = `速度 × JOY_LEAD_S` 并**硬夹到 `屏宽 × JOY_LEAD_MAX_RATIO`**（Cinemachine 的 look-ahead
 *      也要被 Screen X/Y 与 Min/Max Distance 夹住，否则就是"镜头跑掉"）。
 *      相机与角色的屏幕偏移另有**硬夹**（前瞻上限 + 死区）⇒"视角锁定角色"是**结构**保证，不是调参运气。
 *      🔴 2026-10-03 第二轮机主验收：「**视角无法锁定角色，位移很大喵！！！**」——上一版稳态把角色
 *      永久甩在画面外 **176.7px（0.177 屏宽）**，且松手后**不回中**（前瞻停在原处）。现在：
 *      · 推着走时偏移被死区+前瞻上界夹住（满推稳态 = 死区 − 速度×(前瞻−阻尼) ≈ 17px，见自检 ⑩e）；
 *      · **松手后**进入"回中段"：前瞻归 0、死区归 0，按 `JOY_RECENTER_TAU_S` 平滑贴回角色（§7）。
 *   ⑤ **死区**（§3）：偏差 ≤ `JOY_CAM_DEADZONE_PX` 相机就**不追**（只在推着/滑行时生效）。
 *      取"偏差减死区"而不是迟滞开关 ⇒ 不会在边界上抖；**回中段死区为 0** ⇒ 能一路贴到角色身上。
 */

/**
 * **缩放档 → 速度档**（研究 §7：「大地图上让世界速度与看得见的位移两全」的正解之一：
 * 速度随视野尺度换档 —— GIS/飞行模拟里 pan 速度随高度走；Unreal 社区对 RTS 相机的答案也是
 * "把移动速度挂到 spring arm 长度上"[二手](https://forums.unrealengine.com/t/changing-camera-speed-based-on-zoom-distance/2576753/4)）。
 * 🔴 但我们**每一档都是物理世界里拿得出手的速度**（1.4 步行 / 13.9 = 50km/h 载具），
 *    而不是"每秒多少像素"—— 这正是上一版栽的那一跤。
 * ⚠️ 档位在**进近景那一刻**由 `joyCalibrate()` 量一次（`panBy` 不改 zoom ⇒ 漫游中不会换档；
 *    换档 = 速度突变，观感是"被弹了一下"，所以刻意不做）。读不到 zoom ⇒ 给**最慢**那一档。
 */
export function joySpeedMpsOf(zoom: number): number {
  /* 读不到（NaN/∞）⇒ **最慢那一档**：宁可慢，也不给一个编出来的速度 */
  if (!Number.isFinite(zoom)) return JOY_SPEED_MPS;
  return zoom >= JOY_SPEED_ZOOM_WALK ? JOY_SPEED_MPS : JOY_SPEED_ROAM_MPS;
}

/** 加速时间常数 τ（秒）——输入 → 速度的指数逼近速度（§1；Unity `SmoothDamp`/Unreal `FInterpTo` 同一族） */
export const JOY_ACCEL_TAU_S = 0.26;
/** 摩擦/阻尼时间常数 τ（秒）——输入回中后速度按它衰减（§1 的"摩擦"，同一个公式、目标换成 0） */
export const JOY_FRICTION_TAU_S = 0.16;
/** 相机跟随时间常数 τ（秒）——相机不瞬移，按它追「角色 + 前瞻」（§3 的阻尼跟随） */
export const JOY_CAM_TAU_S = 0.18;
/** 前瞻时长（秒）——相机对准"角色 `JOY_LEAD_S` 秒之后会到的地方"（§3 的 look-ahead） */
export const JOY_LEAD_S = 0.5;
/**
 * 🔴 **前瞻上限（占屏宽的比例）= 1/8** —— look-ahead 必须**有界**（§7）：
 * 官方 Cinemachine 的 Lookahead Time 也受 Screen X/Y 与 Min/Max Distance 约束
 * （[Framing Transposer](https://docs.unity3d.com/Packages/com.unity.cinemachine@2.8/manual/CinemachineBodyFramingTransposer.html)：Maximum Distance = "limit how far from the target the camera can get"）。
 * 128px@1024 屏宽：按本屏的物理档永远够不着（满推前瞻只有 4.4px），它是**保险丝**，不是常用值。
 */
export const JOY_LEAD_MAX_RATIO = 0.125;
/** 相机死区（px）——偏差小于它就不追（§3 的 dead zone）；**只在推着/滑行时**生效 */
export const JOY_CAM_DEADZONE_PX = 20;
/**
 * **回中时间常数 τ（秒）**——松手后相机平滑贴回角色那一段（§7「停下后必须衰减回去」）。
 * 取 0.1s：从满推稳态的 ~17px 偏移出发，**0.3s 内落到 1px 以内**（e^(−0.3/0.1)=0.05），
 * 且整段是 ~35 帧的缓动（不是瞬移）—— 自检 ⑩e2 钉着这两个读数。
 */
export const JOY_RECENTER_TAU_S = 0.1;
/** 回中段最长帧数（保险丝）：时钟被冻住/rAF 反复给同一个时间戳时也一定会收尾并发出那一次 halt */
export const JOY_CENTER_MAX_FRAMES = 90;
/** 相机单帧位移下限（px）——比它小的位移**不写**（浮点尾巴会让 rAF 链永不收尾；见 `joyMotionStep`） */
export const JOY_CAM_EPS_PX = 0.01;
/** 速度归零阈值（**米/秒**，世界单位）——指数衰减永远到不了 0，低于它就**写 0**（否则 rAF 链永不收尾） */
export const JOY_REST_MPS = 0.05;
/** 踏步动画：每秒几步（§4「速度决定动画状态」—— 幅度、相位都由**速度**推出来，不另设开关） */
export const JOY_STEP_HZ = 2.2;
/** 踏步动画：幅度（px）——"极轻"：只有 1.5px，且 `low` 档 / `prefers-reduced-motion` 直接不跑 */
export const JOY_STEP_PX = 1.5;

/**
 * 角色朝向 / 踏步要不要跑（**唯一判据**，自检钉真值表）。
 * §4：就地行走动画是**装饰**，不是操作 —— 所以它可以被关；摇杆本身（输入）任何档位都不许关。
 */
export function joyWalkAnimOn(input: { low: boolean; reduced: boolean }): boolean {
  return !input.low && !input.reduced;
}

/**
 * 屏幕 px → 经纬度的**局部线性映射**（雅可比；宿主用地图库自己的 `unproject` 量一次）。
 * 🔴 为什么不是"自己写投影数学"：一整条链路只有这一处换算，而它**不是我们推的**——
 *    四个数全部由 `map.unproject()` 在同一台相机上量出来（见宿主 `joyCalibrate()`）。
 *    相机中心在**纯平移**下的这个雅可比是**不变**的 ⇒ 会话期间量一次就够，移动中一次都不用再量。
 */
export interface JoyPxScale {
  /** 屏幕 +1px 向右 ⇒ 经度/纬度增量（度） */
  dxLng: number;
  dxLat: number;
  /** 屏幕 +1px 向下 ⇒ 经度/纬度增量（度） */
  dyLng: number;
  dyLat: number;
}

/** 量出来的四个数**必须全有限且不全为 0**，否则给 `null`（⇒ 宁可不走，也不写一个编出来的坐标） */
export function joyPxScaleOf(s: Partial<JoyPxScale> | null | undefined): JoyPxScale | null {
  if (!s) return null;
  const v = [Number(s.dxLng), Number(s.dxLat), Number(s.dyLng), Number(s.dyLat)];
  if (!v.every((n) => Number.isFinite(n))) return null;
  if (v.every((n) => n === 0)) return null;
  return { dxLng: v[0], dxLat: v[1], dyLng: v[2], dyLat: v[3] };
}

/** 会话原点 + 屏幕位移（px）→ 经纬度（**唯一的 px→经纬度换算**；角色与相机共用同一把标尺） */
export function joyLngLatOf(
  origin: { lng: number; lat: number },
  s: JoyPxScale,
  x: number,
  y: number
): { lng: number; lat: number } {
  return { lng: origin.lng + x * s.dxLng + y * s.dyLng, lat: origin.lat + x * s.dxLat + y * s.dyLat };
}

/** 运动状态（**可注入、可离线跑**；宿主每帧拿到的是**新对象**，不改这一份） */
export interface JoyMotion {
  /** 角色速度（px/s，屏幕坐标：右/下为正） */
  vx: number;
  vy: number;
  /** 角色相对**会话原点**的累计屏幕位移（px）——世界坐标 = `joyLngLatOf(原点, 标尺, px, py)` */
  px: number;
  py: number;
  /** 相机相对会话原点的累计屏幕位移（px）——`panBy` 的累计值就是它（名字层跟手也用它） */
  cx: number;
  cy: number;
  /** 朝向（度，正北 0、顺时针）——由**速度方向**定（§4）；停下保持上一次，不乱转 */
  headingDeg: number;
  /** 速度 ÷ 满速（0..1）——踏步幅度用它（停下 ⇒ 0 ⇒ 动画自己回正） */
  speedRatio: number;
  /** 踏步相位（圈，累计）——停下来就不再涨 */
  stepPhase: number;
  /**
   * 🕹 **相机当前拉近了多少级**（0..`JOY_ZOOM_MAX_LEVELS`；0 = 相机就在进近景那一刻的距离上）。
   * ⚠️ 它**不是**"屏幕位移"也不是"速度"：世界速度一个字不改，变的是同一段位移占多少像素
   * （屏幕上的一秒位移 = `|v| × 2^zo`，见 `joyPanScaleOf`）。
   * 🔴 松手后它会**恰好**回到 0（`JOY_ZOOM_EPS_LEVELS` 那一跳），相机距离因此逐位回到出发值。
   */
  zo: number;
}

/** 会话开始的零状态（每进一次近景 `createJoyMotion()` 一份新的） */
export function createJoyMotion(): JoyMotion {
  return { vx: 0, vy: 0, px: 0, py: 0, cx: 0, cy: 0, headingDeg: 0, speedRatio: 0, stepPhase: 0, zo: 0 };
}

/** 一步的结果：相机该走多少（喂 `panBy`）+ 新状态 + 还没停稳吗（驱动要不要续 rAF） */
export interface JoyStepResult {
  /** 相机这一帧的屏幕位移（px，右/下为正）——**与旧版同口径**，直接喂 `map.panBy` */
  d: JoyFrameDelta;
  /** 这一步之后的状态（新对象） */
  move: JoyMotion;
  /** 速度没归零 **或** 相机还没追上 ⇒ 驱动要继续跑（都停了就断链，不空转） */
  moving: boolean;
  /** 🆕 `true` = 这一步属于**回中段**（角色停稳、只有相机在贴回角色）⇒ 宿主**一个角色写点都不发** */
  centering: boolean;
}

/**
 * 运动模型的一步（纯函数；`dtMs` ≤ 64）。
 * 不变量（自检钉着）：
 *   ① 任何一项非有限（NaN/∞）⇒ **整份归零**并判停稳（宁可停住，也不把 NaN 写进 `setLngLat`）；
 *   ② `dt = 0` ⇒ 状态逐字节不变、`d = 0`（不许凭空走出位移）；
 *   ③ 停稳（`moving === false`）⇒ `d = {0,0}` 且速度恰好 0（"没推就不更新相机"的旧不变量）；
 *   ④ 朝向只在**真的有速度**（> 满速的 1%）时更新；
 *   ⑤ **相机与角色的屏幕偏移永远 ≤**（前瞻上限 + 死区）—— 硬夹出来的结构保证（"视角锁定角色"）；
 *   ⑥ 无输入且速度恰好 0 ⇒ `centering = true`（前瞻/死区都归 0，相机贴着角色收敛）；
 *   ⑦ 🕹 **相机距离**：推杆期朝 `ctx.zoomLevels` 逼近、松手后朝 0 收敛，且**松手后必定写恰好 0**
 *      （`zo === 0` ⇒ 相机逐位回到出发值）；`zoomLevels = 0` ⇒ `zo` 恒 0（这条通路是**可选**的）。
 */
export function joyMotionStep(m: JoyMotion, v: JoyVector, ctx: JoyCtx, dtMs: number): JoyStepResult {
  const dt = clampDt(dtMs);
  const s = dt / 1000;
  const c = joyCtxOf(ctx);
  /* 目标速度（px/s）——由**世界速度档** ÷ 米每像素 得来（`joyTargetVelocity` 是唯一换算处） */
  const t = joyTargetVelocity(v, c);
  const pushing = !!(v && v.mag > 0);
  const bad = !Number.isFinite(m.vx + m.vy + m.px + m.py + m.cx + m.cy + m.zo);
  if (bad) return { d: { dx: 0, dy: 0 }, move: createJoyMotion(), moving: false, centering: false };
  /* dt=0（注入的时钟没走 / 同一毫秒内两次）⇒ 状态逐字节不变；只有"还在推 / 还在滑 / 相机还没贴住角色 / 相机距离还没归位"才续帧 */
  if (!dt) {
    const off = m.px !== m.cx || m.py !== m.cy;
    const stopped = !pushing && m.vx === 0 && m.vy === 0;
    return {
      d: { dx: 0, dy: 0 },
      move: { ...m },
      moving: pushing || m.vx !== 0 || m.vy !== 0 || off || m.zo !== 0,
      centering: stopped,
    };
  }

  /* ① 输入 → 速度（指数逼近；推杆用加速 τ、回中用摩擦 τ） */
  const k = 1 - Math.exp(-s / (pushing ? JOY_ACCEL_TAU_S : JOY_FRICTION_TAU_S));
  let vx = m.vx + (t.dx - m.vx) * k;
  let vy = m.vy + (t.dy - m.vy) * k;
  let speed = Math.hypot(vx, vy);
  /* 归零阈值在**世界单位**里定（`JOY_REST_MPS` ⇒ px/s 要 ÷ 米每像素）；没有尺子（mpp=0）时
     速度恒 0 —— 一步都不许走（否则指数衰减永远到不了 0，rAF 链会一直转）。 */
  if (!pushing && (!(c.mpp > 0) || speed < JOY_REST_MPS / c.mpp)) {
    vx = 0;
    vy = 0;
    speed = 0;
  }
  /* ② 半隐式欧拉：用**新**速度积分位置 */
  const px = m.px + vx * s;
  const py = m.py + vy * s;
  /* 🕹 ②b **相机距离**（研究 §9；机主拍板 Ⓐ 拉近）——推杆期间朝 `ctx.zoomLevels` 逼近，
     松手后朝 0 回归。两条**与速度那条同构**（§1 的指数逼近）：
       · 推杆期用 `JOY_ZOOM_TAU_S`（0.5s，相机距离不要瞬移）；
       · **回程复用 `JOY_RECENTER_TAU_S`**（0.1s）——与"相机贴回角色"是**同一套**，不新造第二套回程。
     🔴 归零是**恰好** 0（不是"很小"）：`joyZoom0 + 0` 逐位相等 ⇒ 相机距离逐位回到出发值，
     名字层才敢在同一帧恢复（`joyNamesHiddenOf` 用同一个阈值）。指数衰减永远到不了 0，所以必须跳。 */
  const zoT = pushing ? c.zoomLevels : 0;
  const zk = 1 - Math.exp(-s / (pushing ? JOY_ZOOM_TAU_S : JOY_RECENTER_TAU_S));
  let zo = m.zo + (zoT - m.zo) * zk;
  if (!pushing && Math.abs(zo) < JOY_ZOOM_EPS_LEVELS) zo = 0;
  if (!Number.isFinite(zo)) zo = 0;
  /* ③④⑤ 相机：目标 = 角色 + **有界**前瞻；回中段（角色停稳）前瞻/死区都归 0 */
  const centering = !pushing && speed === 0;
  const leadMax = c.screenW * JOY_LEAD_MAX_RATIO;
  const clampLead = (x: number): number => (leadMax > 0 ? Math.max(-leadMax, Math.min(leadMax, x)) : 0);
  const leadX = centering ? 0 : clampLead(vx * JOY_LEAD_S);
  const leadY = centering ? 0 : clampLead(vy * JOY_LEAD_S);
  const dead = centering ? 0 : JOY_CAM_DEADZONE_PX;
  const shrink = (e: number): number => (Math.abs(e) <= dead ? 0 : e > 0 ? e - dead : e + dead);
  const ex = shrink(px + leadX - m.cx);
  const ey = shrink(py + leadY - m.cy);
  const ck = 1 - Math.exp(-s / (centering ? JOY_RECENTER_TAU_S : JOY_CAM_TAU_S));
  let cx = m.cx + ex * ck;
  let cy = m.cy + ey * ck;
  /* 🔴 **硬夹**（研究 §7 的"有界"）：相机与角色的偏移**永不超过**（前瞻上限 + 死区）。
     这是"视角锁定角色"的结构保证 —— 即使状态被外部写坏，相机也会被拉回带上（保险丝，不是常用路径）。 */
  const band = leadMax + JOY_CAM_DEADZONE_PX;
  cx = Math.max(px - band, Math.min(px + band, cx));
  cy = Math.max(py - band, Math.min(py + band, cy));
  /* 🔴 亚像素尾巴**不许写**：`shrink()` 在死区边界上会给出 1e-15 这种量级的偏差 ⇒ 相机每帧
     挪 1e-16px ⇒ `d` 非 0 ⇒ rAF 链**永不收尾**、每帧白发一次 `panBy`（实测栽过：滑停后
     `moving` 一直为 true、跑满 400 帧上限）。小于百分之一像素就当"这一步没动"。 */
  if (Math.abs(cx - m.cx) < JOY_CAM_EPS_PX && Math.abs(cy - m.cy) < JOY_CAM_EPS_PX) {
    cx = m.cx;
    cy = m.cy;
  }
  /* 停稳 = 速度恰好 0 **且** 相机这一帧一步都没走 **且** 相机距离不再变（⇒ `d` 恰好 {0,0}、`zo` 恰好 0，链可以断）。
     🔴 不能拿"离目标 < 0.05px"来判：推着走时相机本来就会停在离目标最多
     `JOY_CAM_DEADZONE_PX` 的地方，那个判据永远不为真。
     🔴 `zo` 也必须进这一条：回程尾段相机可能已经贴住角色（`d = {0,0}`）而相机距离还在收敛，
     那时断链就会把相机**永久停在拉近后的距离**上（名字层也跟着一直藏着）。 */
  const settled = speed === 0 && cx === m.cx && cy === m.cy && zo === m.zo;
  /* ④ 朝向 + 踏步：满速 = 世界速度 ÷ 米每像素（没有尺子 ⇒ 比例恒 0，不动画） */
  const vmax = c.mpp > 0 ? Math.min(c.speedMps, JOY_SPEED_MAX_MPS) / c.mpp : 0;
  const speedRatio = vmax > 0 ? Math.min(1, speed / vmax) : 0;
  const headingDeg = vmax > 0 && speed > vmax * 0.01 ? (Math.atan2(vx, -vy) * 180) / Math.PI : m.headingDeg;
  const stepPhase = m.stepPhase + (speedRatio > 0 ? s * JOY_STEP_HZ * speedRatio : 0);
  const move: JoyMotion = {
    vx,
    vy,
    px,
    py,
    cx,
    cy,
    headingDeg: headingDeg < 0 ? headingDeg + 360 : headingDeg,
    speedRatio,
    stepPhase,
    zo,
  };
  return { d: { dx: cx - m.cx, dy: cy - m.cy }, move, moving: !settled, centering };
}

/**
 * 🕹 **相机位移的像素换算**：拉近 `zo` 级 ⇒ 同一段世界位移要多占 `2^zo` 倍像素。
 * 为什么必须有这一步：角色的位移积分在**进近景那一帧**的像素里（`ctx.mpp` 与那把标尺都冻结在那一档 ——
 * 世界尺度不许漂，研究 §6 的红线），而 `panBy` 走的像素属于**当前**这一档（拉近后的）。
 * 少了它，相机会按 `2^zo` 的倍率追不上角色 ⇒ 角色被甩到硬夹带边缘（前瞻上限 + 死区），
 * 也就是 2026-10-03 第二轮机主报过的「**视角无法锁定角色**」。
 * 🔴 这不是"第二份投影数学"（红线）：它就是 zoom 的定义本身 —— 每级尺度翻倍（研究 §9.4），
 *    没有经纬度、没有三角函数、也不碰地图库。
 */
export function joyPanScaleOf(zo: number): number {
  const z = Number(zo);
  return Number.isFinite(z) ? Math.pow(2, z) : 1;
}

/**
 * 🕹 推杆拉近期间**名字层要不要整层隐藏**（研究 §9.6，宿主每帧问一次，翻转时才写一次 class）。
 * 为什么必须藏：名字层每个节点的坐标是**进近景那一刻**用地图库的 `project()` 算好写进 DOM 的，
 * 拖动期间只靠**容器一次 `translate3d`** 跟手 —— 那条跟手是**纯平移补偿**。zoom 一变，
 * 投影坐标整体按 `2^Δz` 缩放、补偿量对不上（离屏幕中心 200px 的标签在 Δz=1.2 时差约 260px，
 * 比机主报过的"名字错位"大一个量级）⇒ 与其显示错位的名字，不如整层藏起来。
 * 阈值与"zo 写恰好 0"用**同一个** `JOY_ZOOM_EPS_LEVELS`：不会出现"相机已经回位、名字还藏着"
 * （或反过来）的缝。`zo = 0`（关掉这条通路时的常态）⇒ 恒 `false` ⇒ 一个字节都不动。
 */
export function joyNamesHiddenOf(zo: number): boolean {
  const z = Number(zo);
  return Number.isFinite(z) && Math.abs(z) > JOY_ZOOM_EPS_LEVELS;
}

/* ══════════════════════════════════════════════════════════════════
 * 四、唯一驱动点：一个 rAF（可注入 ⇒ 离线能数帧数）
 * ══════════════════════════════════════════════════════════════════ */

export interface JoyFrameDelta {
  dx: number;
  dy: number;
}
/** 这一帧属于哪一段：`push` = 推着/滑行（角色可能还在动）；`center` = **回中段**（只有相机在动） */
export type JoyFramePhase = "push" | "center";

export interface JoyDriverDeps {
  /**
   * 每帧**最多一次**（**停稳**的帧根本不回调）——相机/角色/名字层的写点只许挂在这里。
   * 第 3 个参数是**这一步之后的运动状态**：宿主用它写角色世界坐标（`px/py`）、朝向与踏步
   * （§3/§4；相机那一路只认 `d`）。第 4 个参数是**相位**：`phase === "center"` 时角色已经停稳，
   * 宿主**只许动相机**（不写 `setLngLat`、不写真源、不重挑楼/不算名字）—— 自检 ⑩e3 钉着。
   */
  onFrame: (d: JoyFrameDelta, v: JoyVector, move: JoyMotion, phase: JoyFramePhase) => void;
  /**
   * 收尾：**恰好一次**（宿主在这里清 `joyActive` + 做那一次重算；没按下过就不会回调）。
   * 🔴 2026-10-03 第二轮：时机**推迟到回中结束**（原先在 `release()` 里同步发）。
   *    为什么：回中段仍在跑 rAF，若 `joyActive` 已经清掉，`panBy` 每帧引发的
   *    `movestart/move/moveend` 就会走**常规那条重算路**（每帧重投影 + 重排标签 + 取包）
   *    —— 机主报过的"名字错位/松手卡一下"的放大版，也正是本轮判据"回中期间 0 次重算"要挡的。
   *    推迟到相机停稳后再发 ⇒ 那一次重算**天然只发生一次、且发生在画面稳定之后**
   *    （顺序仍是既有那条：清标志 → 容器归零 → 就地重投影 → 一次取包 + 一次重排）。
   */
  onHalt: () => void;
  /**
   * 这一帧的**世界尺度**（屏宽 / 米每像素 / 满推速度）。
   * 组件在**按下那一刻**量一次屏宽后缓存（每帧读 `clientWidth` = 每帧强制布局）；
   * 米每像素与速度档由宿主在 `joyCalibrate()` 里量一次（纯平移下不变）。
   */
  ctx: () => JoyCtx;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}
export interface JoyDriver {
  /** 按下（pointerdown）：开一次会话，向量归零（按住不动 ⇒ 0 次相机更新） */
  begin(): void;
  /** 指针移动：**只写这一个向量**（无 DOM 写、无相机调用） */
  setVector(v: JoyVector): void;
  /**
   * 松手：向量与速度**立刻**归零（"人是停下了"），然后**进入回中段**：
   * rAF 继续跑，但只有相机在动；相机贴回角色后发那**恰好一次** `onHalt`。
   * 重复调用是空操作；没按下过 ⇒ 什么都不会发生（"控件不在" ≠ "松手"）。
   */
  release(): void;
  /** 卸载 / 关开关：停 rAF，**不**回调 `onHalt`（那是"松手"，不是"走了"） */
  cancel(): void;
  /** 自持标志：**手指还按着**（回中段为 `false`，但 rAF 可能还在跑 —— 见 `centering`） */
  readonly active: boolean;
  /** 松手后"只回中"那一段是否还在跑（宿主/自检读数；生产里靠 `onFrame` 的 phase） */
  readonly centering: boolean;
  /** 跑过多少帧（自检读数；生产留着是 0 成本） */
  readonly frames: number;
  /** 当前运动状态（自检读数；生产里宿主用 `onFrame` 那一份，不读这里） */
  readonly move: JoyMotion;
}

/**
 * 摇杆驱动（**唯一 rAF**）。
 * 生命周期：`begin()` → N × `setVector()` → `release()`（→ 回中段 → `onHalt`）；`cancel()` 用于组件卸载。
 * 不变量（自检钉着）：
 *   ① `setVector()` 一次都不触发相机回调 —— 它只写向量 + 确保 rAF 在跑；
 *   ② 一帧内 `onFrame` **至多 1 次**，且只在**还没停稳**（速度非 0、相机没追上，**或相机距离还在变**）时；
 *   ③ 停稳 ⇒ rAF 链**自己停**（不空转）；`release()` ⇒ 速度**立刻**归零、位置冻住，
 *      回中段跑完（相机贴回角色**且相机距离回到出发值**）后 `onHalt` **恰好 1 次**，之后一帧都不再回调
 *      （"松手恰好一次重算"那条红线仍钉着，只是时点从"松手那一刻"挪到"相机停稳那一刻"）；
 *   ④ 运动状态**跨按压保留**（松手不清位置/朝向）⇒ 再推一下不会把人瞬移回原点；
 *   ⑤ 回中段被打断（又按下 / 卸载）也**不会**漏发或多发 `onHalt`：`begin()` 先把它结清，`cancel()` 不发。
 */
export function createJoyDriver(deps: JoyDriverDeps): JoyDriver {
  const now = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const raf =
    deps.raf ||
    ((cb: (t: number) => void) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(() => cb(now()), 16) as unknown as number));
  const caf =
    deps.caf || ((id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id as never)));

  let v: JoyVector = { ...JOY_ZERO };
  let move: JoyMotion = createJoyMotion();
  let active = false; // 手指还按着
  let centering = false; // 松手后的"只回中"段（rAF 还在跑，但只有相机在动）
  let owed = false; // 还欠一次 `onHalt`（"恰好一次"那条）
  let centerFrames = 0;
  let frameId = 0;
  let last = 0;
  let frames = 0;

  function kick(): void {
    if (frameId) return;
    if (!active && !centering) return;
    last = now();
    frameId = raf(frame);
  }
  /** 回中段收尾：停 rAF 的续帧、结清那一次 `onHalt`（幂等） */
  function settleCenter(): void {
    centering = false;
    centerFrames = 0;
    v = { ...JOY_ZERO };
    if (owed) {
      owed = false;
      deps.onHalt();
    }
  }
  function frame(t: number): void {
    frameId = 0;
    if (!active && !centering) return;
    const dt = t - last;
    last = t;
    frames += 1;
    const before = move;
    const r = joyMotionStep(move, v, deps.ctx(), dt);
    move = r.move;
    /* 🔴 回调判据 = **相机动了 _或_ 角色动了**（两条缺一不可）。
       2026-10-03 第二轮补的那一半：世界速度小（z16.4 上满推 8.8 px/s），相机头 ~2 秒会被死区按在原地
       —— 老判据只看相机位移（`r.d`），那 2 秒里**角色也一帧都不写**，屏幕上的钉子还是不动
       （正是第一轮机主报的"角色都没有动"）。现在角色位置一变就回调；相机位移为 0 的那几帧
       `d = {0,0}`，宿主据此**不发 `panBy`**（只写角色）。
       ⚠️ 角色那一路要**同时**满足 `r.moving`：`joyMotionStep` 判停稳（NaN 闸那一支）时会把状态整份归零，
       那种"归零"不是角色在走 —— 不许借它把钉子写回原点。 */
    const charMoved = r.move.px !== before.px || r.move.py !== before.py;
    /* 🕹 相机距离也算"这一帧有事"（2026-10-03 第三轮）：回程尾段相机可能已经贴住角色（`d = {0,0}`）、
       角色也停着，但 `zo` 还在朝 0 收敛 —— 不把 `zo` 的变化算进来，那几帧就**送不到宿主**，
       相机距离会停在半路、名字层也恢复不了；尤其 `zo` 恰好写 0 的**最后一帧**会被吞掉。
       ⚠️ 断链那条不变量照旧：停稳（`settled`，含 `zo === m.zo`）⇒ 三个判据全假 ⇒ 一帧都不发。 */
    const zoomMoved = r.move.zo !== before.zo;
    if (r.d.dx || r.d.dy || (r.moving && charMoved) || zoomMoved) {
      deps.onFrame(r.d, v, move, r.centering ? "center" : "push");
    }
    if (active) {
      /* 还推着 / 还在滑行 / 相机还没追上 ⇒ 续帧；都停了就断链（不空转、不残留定时器）。
         松手那一次 `onHalt` 不在这里发 —— 手指还按着就不是"松手"，即使杆已经推回死区。 */
      if (r.moving) frameId = raf(frame);
      return;
    }
    centerFrames += 1;
    /* 回中段：相机贴回角色 ⇒ 收尾；帧数超保险丝也收尾（时钟被冻住时不许把 rAF 链挂死） */
    if (!r.moving || centerFrames >= JOY_CENTER_MAX_FRAMES) {
      settleCenter();
      return;
    }
    frameId = raf(frame);
  }
  /** 松手/卸载：速度**立刻**归零（位置/朝向/相机留在原地 —— 下次推杆从这儿接着走） */
  function haltMove(): void {
    move = { ...move, vx: 0, vy: 0, speedRatio: 0 };
  }

  return {
    get active() {
      return active;
    },
    get centering() {
      return centering;
    },
    get frames() {
      return frames;
    },
    get move() {
      return move;
    },
    begin() {
      if (centering) settleCenter(); // 上一段回中还没跑完就又被按下 ⇒ 先把那一次收尾结清（恰好 1 次）
      active = true;
      owed = true;
      v = { ...JOY_ZERO };
      last = now();
      kick();
    },
    setVector(nv) {
      if (!active) return;
      v = nv || { ...JOY_ZERO };
      kick();
    },
    release() {
      if (!active) return; // 没按下过 ⇒ 不是"松手"，一次重算都不该有
      active = false;
      v = { ...JOY_ZERO };
      haltMove();
      /* 回中段：相机（可能还偏着 ~17px）平滑贴回角色；跑完才发 `onHalt`
         ⇒ 回中期间宿主的四个 handler 仍被 `joyActive` 早退挡住（0 次重算）。 */
      centering = true;
      centerFrames = 0;
      kick();
    },
    cancel() {
      active = false;
      centering = false;
      centerFrames = 0;
      owed = false; // "控件没了" ≠ "松手"：**不**回调 onHalt（宿主自己的 `joyExit()` 兜底收尾）
      v = { ...JOY_ZERO };
      haltMove();
      if (frameId) {
        caf(frameId);
        frameId = 0;
      }
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 五、「我」的漫游位置真源（**不是 GPS**；见文件头 🔴）
 * ══════════════════════════════════════════════════════════════════ */

/** 位置的**来源标注**：只有一个合法值 —— 免得将来有人顺手写成 `"gps"` */
export const ROAM_SOURCE = "roam" as const;
/** 给人和 UI 的那句实话（HUD / 判词要引用就引这一份，不许各写一版） */
export const ROAM_NOTE = "漫游位置（演示，不是 GPS）";
/**
 * 「我」那颗钉子的 id（= 漫游时被驱动的那一个）。
 * 🔴 这个 id **不是我们的**：它由 `composables/useWsActors.ts` 造玩家那条时写死（`id: "me"`），
 *    这里只是**引用**它的唯一一处（自检里钉着"两处必须一致"，改那边忘了这边会红）。
 */
export const ROAM_PIN_ID = "me";
/** 近景那一句（HUD 上要看得见：这是**倾斜俯视的跟随**，不是眼睛高度的实景） */
export const JOY_MODE_NOTE = "漫游视角（不是步行模拟）";
/** 2D 降级路的实话（没有相机 ⇒ 摇杆不出现，但要**写出原因**，不静默消失） */
export const JOY_2D_NOTE = "2D 降级路没有相机，摇杆不适用";

export interface RoamPos {
  lng: number;
  lat: number;
  /**
   * 朝向（度，正北为 0、顺时针）—— 语义 2026-10-03 变了，**认准这一条**：
   * 现在是**角色脸朝哪**（= 移动方向，`joyMotionStep` 从速度算出来，§4），
   * 不再是"相机 bearing 的副本"（那是老版本，相机与角色本来就重合，两者没区别）。
   */
  headingDeg: number;
  /** 永远 `"roam"`：这一份位置**不许**冒充定位（类型上就写死） */
  source: typeof ROAM_SOURCE;
  /** 写入时刻（ms，`Date.now()`）—— 判"这份位置还新不新"用 */
  t: number;
}
export interface RoamStore {
  get(): RoamPos | null;
  /**
   * **唯一写入点**。
   * 🔴 2026-10-03：写法变了 —— 以前是"每帧读 `map.getCenter()` **反写**回来"（于是位置永远等于相机，
   * 角色自然一动不动）；现在是**运动模型算出来的世界坐标**（`joyLngLatOf(原点, 标尺, px, py)`）
   * 写进来。相机反过来从它派生 ⇒ "角色"与"相机"从数据上就是两件事（§3）。
   * 这里仍然**不做任何换算**（换算只在 `joyLngLatOf` 一处）。
   */
  write(lng: number, lat: number, headingDeg: number, t?: number): RoamPos;
  clear(): void;
}
export function createRoamStore(): RoamStore {
  let pos: RoamPos | null = null;
  return {
    get: () => pos,
    write(lng, lat, headingDeg, t = Date.now()) {
      pos = { lng, lat, headingDeg, source: ROAM_SOURCE, t };
      return pos;
    },
    clear() {
      pos = null;
    },
  };
}
/** 本屏共用那一份（App 侧单例；**不进 Rust**、不参与 gameplay 距离，见文件头） */
export const roamStore = createRoamStore();

/* ══════════════════════════════════════════════════════════════════
 * 六、开关：**默认关** + 面板开关 + 本地记忆 + URL 逃生口
 * （机主 2026-10-03 改的口径：「摇杆改成点击玩家头像，在面板里选择开启喵！」）
 * ══════════════════════════════════════════════════════════════════
 * 四层，优先级从高到低：
 *   ① `?joy=1` / `?joy=0`：**URL 显式给了就覆盖**存储值（逃生口，排查与 A/B 用）；
 *   ② 本地记忆 `localStorage["wsm:v1:joy"]`（值 `"1"` / `"0"`）—— 玩家面板里点的那一下；
 *   ③ 默认 **关**：不写 URL、也没存过 ⇒ **连摇杆 DOM 都没有**，而且初始俯角/中心与改造前**逐字一致**
 *      （"默认关不许有副作用"是机主的硬要求 —— 所以 `pitch 64` 只允许出现在 `joy === true` 那一路）；
 *   ④ 读不出来 / 坏数据（`"{}"`/`"true"`/`null`/隐私模式抛错）⇒ **关**：与 `wsBldMode`/`wsRelation`
 *      同款口径 —— **绝不抛、绝不猜**（坏数据不该让整屏白掉，也不该替他打开一个功能）。 */

/** 本地记忆的键（**唯一一处定义**；`wsm:v1:` 前缀与本项目其它世界模拟存储一致） */
export const JOY_STORE_KEY = "wsm:v1:joy";

/**
 * URL 那一位：`?joy=1` ⇒ `true`、`?joy=0` ⇒ `false`、**没写 ⇒ `null`**（= 没表态，交给下一层）。
 * ⚠️ `\b` 边界：`?joy=01` / `?joy=0x` **不算表态**（与仓里 `?names=0` / `?wsfallback=1` 同一套写法）。
 */
export function joyUrlChoiceOf(query: string): boolean | null {
  const s = String(query || "");
  if (/[?&]joy=1\b/.test(s)) return true;
  if (/[?&]joy=0\b/.test(s)) return false;
  return null;
}

/**
 * 从**当前地址**读 URL 那一位。
 * ⚠️ App 是 hash 路由（`#/worldsim?joy=1`）⇒ 查询串可能在 hash 里，两处都要看
 * （与 `WsDistrictMapLibre.wsQuery()` 同一口径；`?joy=1` 那种也照样认）。
 * 读不到地址（无 location）⇒ `null`（不表态），**不是** true —— 默认关这条不许被这里绕过去。
 */
export function joyUrlChoiceFromLocation(): boolean | null {
  try {
    return joyUrlChoiceOf(String(location.search || "") + "&" + String(location.hash || ""));
  } catch {
    return null;
  }
}

/** 本地存的那一位：**只有 `"1"` 算开**，其余（没存过 / `"0"` / 坏数据）一律 **关** */
export function joyStoredOf(raw: unknown): boolean {
  return raw === "1";
}

/** 落在哪一边：**URL 显式 > 本地记忆 > 默认（关）** */
export function joyResolveOf(input: { url: boolean | null; stored: boolean }): boolean {
  return input.url === null ? !!input.stored : !!input.url;
}

/** 读盘：坏了/没有/读不动 ⇒ **关**，绝不抛（隐私模式下 `localStorage` 本身就会抛） */
export function readJoyStored(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return joyStoredOf(localStorage.getItem(JOY_STORE_KEY));
  } catch {
    return false;
  }
}

/** 落盘：写不进去不影响本次会话（与 `wsBldMode.writeBldMode()` 同一口径） */
export function writeJoyStored(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(JOY_STORE_KEY, on ? "1" : "0");
  } catch {
    /* 写不进去就只活这一次会话 */
  }
}

/** 进这一屏时该不该开（`WsCityEntry` **只调这一个**）：URL 显式 > 存储 > 关 */
export function joyInitialOn(): boolean {
  return joyResolveOf({ url: joyUrlChoiceFromLocation(), stored: readJoyStored() });
}

/**
 * 摇杆该不该出现在 DOM 里 + HUD 要写哪句话（**唯一判据**，两条都钉着自检）。
 *
 * 判据 9：`?joy=0` ⇒ `show:false`（DOM 里不出现）+ **0 次相机更新**（组件不在 ⇒ 没人建驱动）；
 * 判据 10：2D 降级路（无 WebGL ⇒ 没有相机）⇒ `show:false` + HUD 写明原因（**不静默消失**）。
 * 🔴 这条同时挡住"第二份实现"（C1）：降级路**不装摇杆**，而不是"装了但不生效"。
 */
export function joyGateOf(input: { joy: boolean; fallback2d: boolean }): { show: boolean; hudNote: string } {
  if (!input.joy) return { show: false, hudNote: "" };
  if (input.fallback2d) return { show: false, hudNote: JOY_2D_NOTE };
  return { show: true, hudNote: JOY_MODE_NOTE };
}

/* ══════════════════════════════════════════════════════════════════
 * 七、相机快照 / 还原（"关掉 ⇒ 逐字还原"的那一半，纯函数）
 * ══════════════════════════════════════════════════════════════════
 * 机主的要求：关闭 ⇒ 相机/俯角**还原到接管之前的值**，不许留残留状态。
 * 于是有两件事必须离线可判（自检钉着）：
 *   ① 快照里**四个值一个都不能少**（缺一个 ⇒ `null`：宁可**不动相机**，也不写一个编出来的中心/俯角）；
 *   ② 没有快照 ⇒ `joyCamRestoreArgs()` 返回 `null` ⇒ 宿主**一次 `jumpTo` 都不许发**。 */

/** 接管前的相机（中心/缩放/俯角/朝向 —— 四个都要，缺一不可） */
export interface JoyCamSnapshot {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/** 从"读相机"的结果里取一份快照；任何一项缺失/非有限 ⇒ `null`（= 没有可信的还原点） */
export function joyCamSnapshotOf(
  read:
    | {
        center?: { lng?: unknown; lat?: unknown } | [unknown, unknown] | null;
        zoom?: unknown;
        pitch?: unknown;
        bearing?: unknown;
      }
    | null
    | undefined
): JoyCamSnapshot | null {
  if (!read) return null;
  const c = read.center;
  const lng = Array.isArray(c) ? Number(c[0]) : Number((c as { lng?: unknown } | null | undefined)?.lng);
  const lat = Array.isArray(c) ? Number(c[1]) : Number((c as { lat?: unknown } | null | undefined)?.lat);
  const zoom = Number(read.zoom);
  const pitch = Number(read.pitch);
  const bearing = Number(read.bearing);
  if (![lng, lat, zoom, pitch, bearing].every((n) => Number.isFinite(n))) return null;
  return { center: [lng, lat], zoom, pitch, bearing };
}

/**
 * 关闭时要喂给 `map.jumpTo` 的参数（**无快照 ⇒ `null`** ⇒ 宿主不许动相机）。
 * `duration: 0` 是刻意的：还原是"回到原处"，不是一段动画（有过渡反而像"被弹回去"）。
 */
export function joyCamRestoreArgs(prev: JoyCamSnapshot | null): (JoyCamSnapshot & { duration: number }) | null {
  if (!prev) return null;
  const ok = [...prev.center, prev.zoom, prev.pitch, prev.bearing].every((n) => Number.isFinite(n));
  if (!ok) return null;
  return { center: [prev.center[0], prev.center[1]], zoom: prev.zoom, pitch: prev.pitch, bearing: prev.bearing, duration: 0 };
}
