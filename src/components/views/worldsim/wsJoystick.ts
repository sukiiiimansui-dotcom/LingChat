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

/* ── §15 **底盘尺寸随视口高度收**（2026-10-04 第五轮；机主：「左下那个大灰圆」）──────────────
 * 查证（截图像素量的，见 `RESEARCH-GAME-MOVEMENT.md` §15）：那个"大灰圆"= 摇杆底盘本身，
 * 直径 205 图像 px ÷ 有效 DPR 1.86 = **110 CSS px**（= 112 的设计值，**不是** DPR/CSS 搞错），
 * 杆头 93 ÷ 1.86 = 50（设计值 52）⇒ 两者比例 2.20 ≈ 112/52 ✓。也就是说**尺寸本身没写错，
 * 是"112px 不随视口变"这件事错**：那一屏的视口只有 **581 CSS px 高**，112 就占了 19%；
 * 真机横屏（≈360~430 CSS px 高）上要占 **1/4 屏**。
 * 规则：底盘直径 = `16vh`，夹在 `[76, 112]`（下界保命中区 ≥44 与杆头行程，上界是原设计值）。
 * 🔴 只有这一处算尺寸：宿主把结果写进 CSS 变量（`--ws-joy-base/thumb/h`），组件 CSS 一个数字不写死。
 * ⚠️ `JOY_BASE_PX = 112` 仍是**上界与默认值**（老调用方不给视口高度 ⇒ 逐字回到 112）。
 */
export const JOY_BASE_VH_RATIO = 0.16;
/** 底盘下界（px）——命中区下限 44 的两倍留量，且要装得下 35px 的杆头 */
export const JOY_BASE_MIN_PX = 76;

/** 视口高度 → 底盘直径（px）：`clamp(16vh, 76, 112)`；量不到 ⇒ 默认 112（§15） */
export function joyBasePxOf(viewportH: number): number {
  const h = Number(viewportH);
  if (!Number.isFinite(h) || h <= 0) return JOY_BASE_PX;
  return Math.max(JOY_BASE_MIN_PX, Math.min(JOY_BASE_PX, Math.round(h * JOY_BASE_VH_RATIO)));
}
/** 底盘 → 杆头直径（px）：按原设计比例 `52/112` 缩，夹到 `[32, 52]`（§15） */
export function joyThumbPxOf(basePx: number): number {
  const b = Number(basePx);
  if (!Number.isFinite(b) || b <= 0) return JOY_THUMB_PX;
  return Math.max(32, Math.min(JOY_THUMB_PX, Math.round((b * JOY_THUMB_PX) / JOY_BASE_PX)));
}
/** 底盘 + 杆头 → 杆头行程半径（px）——`(底盘 - 杆头) / 2`（唯一一处；§15） */
export function joyThumbTravelPxOf(basePx: number, thumbPx: number): number {
  const b = Number.isFinite(Number(basePx)) && Number(basePx) > 0 ? Number(basePx) : JOY_BASE_PX;
  const t = Number.isFinite(Number(thumbPx)) && Number(thumbPx) > 0 ? Number(thumbPx) : JOY_THUMB_PX;
  return Math.max(0, (b - t) / 2);
}
/** 底盘 → 杆头行程（px）——`(底盘 - 杆头) / 2`，两个尺寸各一处来源（§15） */


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
export function joyThumbOffset(dx: number, dy: number, radius: number, travelPx?: number): { x: number; y: number } {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const len = Math.hypot(dx, dy);
  if (!r || !Number.isFinite(len) || len <= 0) return { x: 0, y: 0 };
  /* 🕹 §15：行程可随底盘缩（不给 ⇒ 设计值 30，老调用方逐位不变） */
  const travel = Number.isFinite(Number(travelPx)) && Number(travelPx) >= 0 ? Number(travelPx) : JOY_THUMB_TRAVEL_PX;
  const k = (Math.min(1, len / r) / len) * travel;
  return { x: dx * k, y: dy * k };
}

/* ══════════════════════════════════════════════════════════════════
 * 二·五、**参考系**：屏幕向量 ⇄ 世界方向（唯一换算处；研究 §13）
 * ══════════════════════════════════════════════════════════════════
 * 2026-10-04 第五轮机主验收：「**移动时，角色移动方向和屏幕移动方向不一样**」。查下来有两件事，
 * 都在这一个小节里收口：
 *   ① 🔴 **预走线/箭头画的角与真实位移差 90°**（真因，可数）：虚线那一条是**沿 `+x`（右）画的**
 *      （`.ws-aim__dash{left:17px;width:34px;height:2px}`、箭头 `clip-path:polygon(0 0,100% 50%,0 100%)`），
 *      而 JS 写进去的是 `headingDeg` —— 一个**罗盘**角（0 = 屏幕上方，自检 ⑩h2 钉着"向右推 = 90"）。
 *      `rotate(θ)` 把 `+x` 转到 θ ⇒ 画出来的是 `90 + heading`：**恒差 +90°**。
 *      所以基准差只有一处、且必须是常量：`JOY_AIM_BASE_DEG`（朝向箭头是**沿 `-y`（上）画的**
 *      —— `clip-path:polygon(50% 2%,...)` —— 所以它不减，两个元素本来就该用两个式子）。
 *   ② **地图一转（bearing ≠ 0）方向就错**：标尺（`joyScale`，宿主用 `project`/`unproject` 量的局部雅可比）
 *      冻结在**标定那一刻**的相机上，而推杆向量是**当前屏幕**上的。两者之间差一个 `Δbearing`
 *      —— 不转过来，屏幕上"往上推"就会被当成"标定那一刻的上"。（相机 bearing 由**用户手势**改，
 *      **不跟角色朝向**：这就是我们选的参考系模型 ①「相机相对输入」，研究 §13.2。）
 * 🔴 这里**没有一行投影数学**（红线照旧）：世界位移仍然走标尺（库自己的 `project`/`unproject`），
 *    本小节只做**平面内转一个角**（Δbearing）与**罗盘/屏幕角互换**，三处都不碰经纬度。
 */
/** 预走线容器**不转**的时候指向哪（度，屏幕 12 点 = 0、顺时针）：沿 `+x` ⇒ 90（§13.4） */
export const JOY_AIM_BASE_DEG = 90;
/** `depthGain` 的上限（= 1/cos(75.5°) ≈ 4）：坏输入顶不破它（§14） */
export const JOY_DEPTH_GAIN_MAX = 4;

/** 参考系（标定那一刻 vs 现在；bearing 那两个数决定要不要转，camX/camY 是**相机真值**） */
export interface JoyFrame {
  /** 标定那一刻的相机 bearing（度）——标尺坐标系就架在它上面 */
  bearing0: number;
  /** 当前相机 bearing（度）——由宿主在 `rotate` 时更新（不进每帧循环） */
  bearingNow: number;
  /**
   * 🎥 **相机在标尺坐标系里的位置**（px，`joyScreenOf` 反解 `getCenter()` 得来）——
   * 单一几何真源的"源"。**`NaN` = 没量到**（🔴 不能用 0：0 是"相机正好在原点"这个**断言**，
   * 拿它当缺省会把相机硬拽回原点 —— 缺省必须是"不知道"）。
   */
  camX: number;
  camY: number;
  /**
   * **视口倍率** `2^(zoomNow − zoom0)`（px 口径；与 `JoyCtx.viewScale` 同一个数）——
   * 死区/前瞻上限是**屏幕像素**口径，拉近/捏合之后要除回标定档（§16）。缺省 1。
   */
  viewScale: number;
}
/** 归一化：bearing 非有限一律 0（"量不到就当作正北"）；相机真值非有限一律 **NaN**（"不知道"） */
export function joyFrameOf(x: Partial<JoyFrame> | null | undefined): JoyFrame {
  const n = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) ? f : 0;
  };
  const g = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) ? f : NaN;
  };
  const vs = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) && f > 0 ? f : 1;
  };
  return x
    ? {
        bearing0: n(x.bearing0),
        bearingNow: n(x.bearingNow),
        camX: g(x.camX),
        camY: g(x.camY),
        viewScale: vs(x.viewScale),
      }
    : { bearing0: 0, bearingNow: 0, camX: NaN, camY: NaN, viewScale: 1 };
}
/* 🧭 **当前参考系**（宿主一处写、驱动一处读）——与 `roamStore` 同款的单例口径：
   为什么不走 props：`WsJoystick.vue` 的 `defineProps`/`ctx` 两行被判据 ⑩k11 **逐字钉着**
   （"组件自己不算世界尺度"那条红线），所以参考系不塞进那个对象字面量，改由宿主写在这里。
   🔴 纯函数（`joyMotionStep`/`joyFrameVectorOf`）**永远用参数**，不读这个单例 ——
   自检才能在同一个进程里逐个 bearing 钉字面量（不互相污染）。 */
let joyFrameNow: JoyFrame = { bearing0: 0, bearingNow: 0, camX: NaN, camY: NaN, viewScale: 1 };
let joyDepthGainNow = 1;
/** 宿主写：`bearing0` = 标定那一刻的相机 bearing；`bearingNow` = 当前；`depthGain` 由俯角算（§14） */
export function joySetFrame(f: Partial<JoyFrame> | null | undefined, depthGain?: number): void {
  joyFrameNow = joyFrameOf(f);
  const g = Number(depthGain);
  joyDepthGainNow = Number.isFinite(g) && g > 0 ? Math.min(JOY_DEPTH_GAIN_MAX, Math.max(1, g)) : 1;
}
/** 读当前参考系（宿主画预走线/箭头时也要它：世界朝向 → 屏幕角） */
export function joyFrameGet(): JoyFrame {
  return { ...joyFrameNow };
}
/** 宿主**每帧只更新这一个数**（相机 bearing 变了才有效果；整数之外的分配一个都不做） */
export function joySetBearingNow(deg: number): void {
  const f = Number(deg);
  if (Number.isFinite(f)) joyFrameNow = { ...joyFrameNow, bearingNow: f };
}
/**
 * 🎥 宿主**每帧报一次相机真值**：相机在**标尺坐标系**里的位置（px）。
 * 传 `NaN` = 这一帧量不到（回到开环旧行为，不写假坐标）。这就是"单一几何真源"的那一根线：
 * 相机位置由**地图自己**（`getCenter()` 反解）说了算，不再是模型自己积分的第二个账本。
 */
export function joySetCam(x: number, y: number, viewScale?: number): void {
  const fx = Number(x);
  const fy = Number(y);
  const fv = Number(viewScale);
  joyFrameNow = {
    ...joyFrameNow,
    camX: Number.isFinite(fx) ? fx : NaN,
    camY: Number.isFinite(fy) ? fy : NaN,
    viewScale: Number.isFinite(fv) && fv > 0 ? fv : 1,
  };
}
/** 当前 bearing 的**只读**读数（宿主每帧换算屏幕角用；不进任何写点预算） */
export function joyBearingNowOf(): number {
  return joyFrameNow.bearingNow;
}
/** 把**当前参考系**并进宿主给的世界尺度 —— 驱动里**唯一**一处合并（§13/§14/§16） */
export function joyCtxWithFrame(base: Partial<JoyCtx> | null | undefined): JoyCtxFull {
  return joyCtxOf({
    ...(base || {}),
    bearing0: joyFrameNow.bearing0,
    bearingNow: joyFrameNow.bearingNow,
    depthGain: joyDepthGainNow,
    camX: joyFrameNow.camX,
    camY: joyFrameNow.camY,
    viewScale: joyFrameNow.viewScale,
  });
}
/**
 * **屏幕向量 → 标尺坐标系**（唯一一处把 bearing 算进来的地方）。
 * 推导（§13.3）：bearing = β 时"屏幕正上方"对应罗盘方向 β ⇒ 屏幕上朝向 `h` 的一次推 = 罗盘方向
 * `β_now + h`；而标尺是在 `β0` 那一刻量的，同一个罗盘方向在标尺里是 `β_now + h - β0`
 * ⇒ 把当前屏幕向量**顺时针转 `Δβ = β_now - β0`** 即可（屏幕坐标 y 向下 ⇒ 顺时针为正，与 CSS `rotate` 同号）。
 * ⚠️ `Δβ = 0`（不转地图，或老调用方不给这两个字段）⇒ **逐位返回原向量**（既有 251 条判据一字不变）。
 */
export function joyFrameVectorOf(v: JoyVector, f: JoyFrame | null | undefined): JoyVector {
  const g = joyFrameOf(f);
  const d = ((g.bearingNow - g.bearing0) * Math.PI) / 180;
  if (!v || !Number.isFinite(d) || d === 0) return v;
  const c = Math.cos(d);
  const s = Math.sin(d);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, mag: v.mag };
}
/** 归一化到 [0, 360)——罗盘角与屏幕角共用这一个口径 */
export function joyNormDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}
/**
 * 标尺坐标系里的速度 → **世界（罗盘）朝向**（度，正北 0、顺时针）。
 * 为什么要 `+bearing0`：`atan2(vx,-vy)` 给的是**标尺坐标系**里的角；标尺的"上"在罗盘上是 `β0`
 * （`bearing = -18` 时，屏幕上推上去其实朝北偏西 18° —— 存进 `roamStore` 的那个朝向必须是**罗盘**角，
 * 否则"朝向"这件事出了这一屏（小地图/载具/游戏距离）就是错的）。
 */
export function joyWorldHeadingOf(vx: number, vy: number, bearing0: number): number {
  const b = Number.isFinite(Number(bearing0)) ? Number(bearing0) : 0;
  return joyNormDeg((Math.atan2(vx, -vy) * 180) / Math.PI + b);
}
/** **世界朝向 → 当前屏幕上该画的角度**（度，屏幕 12 点 = 0、顺时针）—— 与 `joyWorldHeadingOf` 互为逆 */
export function joyScreenHeadingOf(worldDeg: number, bearingNow: number): number {
  const b = Number.isFinite(Number(bearingNow)) ? Number(bearingNow) : 0;
  return joyNormDeg(Number(worldDeg) - b);
}
/**
 * 🎯 **预走线容器该写的 `rotate`**（唯一一处减掉 `JOY_AIM_BASE_DEG`）。
 * 为什么是减：`rotate(θ)` 把沿 `+x` 画的那条线转到"屏幕角 θ"；要它指向 `h`，就要 `θ = h - 90`。
 * 朝向箭头（沿 `-y` 画）**不减** —— 它直接用 `h`。两者共用同一个 `h`（宿主里那个 `joyFaceDeg`），
 * 所以"线、箭头、真实位移"从此是同一个角。
 */
export function joyAimRotateDegOf(screenHeadingDeg: number): number {
  return joyNormDeg(Number(screenHeadingDeg) - JOY_AIM_BASE_DEG);
}

/* ── §14 **俯角带来的竖直压缩**（世界速度各向同性的那一半）─────────────────────────
 * 事实（自证在本仓既有公式里）：`bldPxPerMeter = sin(pitch)/mpp` 是本仓**已验证**的"1 米楼高 = 多少像素"。
 * 用同一套针孔相机（相机到画面中心距离固定 ⇒ 抬俯角不改变中心尺度）解地面雅可比：
 *   横向 1px = `mpp` 米；**纵向（朝/背地平线）1px = `mpp / cos(pitch)` 米**。
 * 64° ⇒ 1/cos64° = **2.2812**（不是 `1/sin64° ≈ 1.11` —— 旧注释那一版把楼高公式的 sin 用错了地方）。
 * 后果（旧行为）：满推速度是按**各向同性**的 `mpp` 换算成 px/s 的，于是"往屏幕上方推"在世界里
 * 走的是 13.9 × 2.2812 ≈ **31.7 m/s（114 km/h）**，"往右推"才是 13.9 m/s —— 屏幕上看一样快，
 * 世界里差 2.28 倍（走出来的距离、`距中心 N m` 的读数全都跟着错）。
 * 修法：把 px/s 目标按**这次推的方向**除以下面这个增益 ⇒ `|世界速度| ≡ speedMps`，与方向无关。
 * `depthGain = 1`（不给这个字段 / `pitch = 0`）⇒ 与旧行为**逐位相同**（既有判据不受影响）。
 */
/** 俯角 → 纵向增益 `1/cos(pitch)`（夹到 `[1, JOY_DEPTH_GAIN_MAX]`；非有限 ⇒ 1） */
export function joyDepthGainOf(pitchDeg: number): number {
  const p = Number(pitchDeg);
  if (!Number.isFinite(p) || p <= 0) return 1;
  const c = Math.cos((Math.min(p, 75.5) * Math.PI) / 180);
  if (!(c > 0)) return JOY_DEPTH_GAIN_MAX;
  return Math.min(JOY_DEPTH_GAIN_MAX, Math.max(1, 1 / c));
}
/** 屏幕**单位**方向 `(ux,uy)` 在这一次推里"1px 顶几倍米"（各向同性世界速度的唯一换算处，§14） */
export function joyGroundGainOf(ux: number, uy: number, depthGain: number): number {
  const g = Number.isFinite(Number(depthGain)) && Number(depthGain) > 0 ? Math.min(JOY_DEPTH_GAIN_MAX, Number(depthGain)) : 1;
  const a = Number.isFinite(ux) ? ux : 0;
  const b = Number.isFinite(uy) ? uy : 0;
  const k = Math.hypot(a, b * g);
  return k > 0 ? k : 1;
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
  /**
   * 🧭 标定那一刻的相机 bearing（度）——标尺坐标系（§13）。
   * 🔴 **可选**（2026-10-04 第五轮，父代理复跑的 `vue-tsc` 报了 TS2739）：前四个数由宿主当 props 传进
   * `WsJoystick.vue`，而这三个是**驱动侧**注入的（`joyCtxWithFrame()` 读模块里那份参考系）——
   * 组件那份 `ctx: () => ({ screenW, mpp, speedMps, zoomLevels })` 是**判据 ⑩k11 逐字钉着**的四字段
   * 字面量，不该为了类型好看往里塞它拿不到的数。所以类型上如实表达：**缺 = 没有参考系信息**，
   * `joyCtxOf()` 给中性值 `0` ⇒ `Δβ = 0` ⇒ **逐位等于旧行为**（"缺字段"不等于"错字段"）。
   */
  bearing0?: number;
  /** 🧭 当前相机 bearing（度）——宿主每帧报一次（`joySetBearingNow`）；不给 ⇒ 0（= 旧行为） */
  bearingNow?: number;
  /** 📐 俯角竖直增益 `1/cos(pitch)`（§14）——不给 ⇒ 1（= 旧行为） */
  depthGain?: number;
  /**
   * 🎥 **相机在标尺坐标系里的位置**（px）——宿主每帧用 `joyScreenOf()` 反解 `getCenter()` 得来（§16）。
   * 给了 = **闭环**：相机位置以**地图自己**为准（单一几何真源），模型只决定"这一帧往角色那边修多少"；
   * 不给 / `NaN` = **开环**（= 本轮之前的旧行为：相机位置由模型自己积分）。
   */
  camX?: number;
  camY?: number;
  /**
   * 🎥 **当前视口相对标定那一刻的像素倍率** `2^(zoomNow − zoom0)`（§16）。
   * 死区/前瞻上限是**屏幕像素**口径的设计值（"离屏幕中心 20px 内不追"），而模型内部全在**标定档**的
   * 像素里 ⇒ 拉近/捏合之后不除这个倍率，同一个 20px 在屏幕上就变成 20×2^Δz（满推时 45px，
   * 手机 400px 宽的屏上是 11% —— 那正是"镜头锁不住"的一个来源）。不给 / 非正 ⇒ 1（= 旧行为）。
   */
  viewScale?: number;
}
/**
 * `joyCtxOf()` **归一化之后**的 ctx：三个参考系字段从"可选"变成"必填"（中性值已填好）。
 * 为什么要分成两个类型（而不是直接用 `JoyCtx`）：内部纯函数要按 `number` 用它们
 * （`c.bearing0 + …`），`JoyCtx` 里那三个是可选的 ⇒ 在 `strictNullChecks` 下会报"可能是 undefined"
 * —— 这个别名把"调用方可以不给"和"我这里一定拿到数"两件事分开表达（类型系统替我们守住归一化那一步）。
 * 🎥 §16 的 `camX/camY` 是**例外**：它们的"没量到"是一个**真状态**（不是某个数），如实填 `NaN`;
 * `viewScale` 的缺省是 `1`（= 不缩放，逐位等于旧行为）。
 */
export type JoyCtxFull = JoyCtx & {
  bearing0: number;
  bearingNow: number;
  depthGain: number;
  camX: number;
  camY: number;
  viewScale: number;
};

/**
 * ctx 归一化：非有限 / ≤0 一律**归 0** ⇒ 这一步什么都不走
 * （"量不到尺子就站住"，与 `joyPxScaleOf` 的"宁可不动，也不写编出来的坐标"同一条纪律）。
 * ⚠️ `zoomLevels` 例外：它**可以是 0**（= 不拉近），所以不能用上面那条"≤0 归 0"；
 *    非有限一律 0，其余夹进 `[0, JOY_ZOOM_MAX_LEVELS]`（坏输入顶不破上限 —— §9.2 的"上限"纪律）。
 */
export function joyCtxOf(x: Partial<JoyCtx> | null | undefined): JoyCtxFull {
  const n = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) && f > 0 ? f : 0;
  };
  const zl = (v: unknown): number => {
    const f = Number(v);
    if (!Number.isFinite(f) || f <= 0) return 0;
    return Math.min(JOY_ZOOM_MAX_LEVELS, f);
  };
  /* 🧭 bearing 是**有符号**的（可以 -180..180）⇒ 不能用上面那条"≤0 归 0"；非有限才归 0（§13） */
  const bg = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  /* 📐 增益的下界是 **1**（俯角 0 = 不压缩）：坏输入（NaN/∞/负数）一律回到 1（§14） */
  const dg = (v: unknown): number => {
    const f = Number(v);
    if (!Number.isFinite(f) || f <= 0) return 1;
    return Math.min(JOY_DEPTH_GAIN_MAX, Math.max(1, f));
  };
  /* 🎥 相机真值：**非有限 = 没量到 = NaN**（不是 0 —— 0 是"相机在原点"这个断言，§16） */
  const g = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) ? f : NaN;
  };
  /* 🎥 视口倍率：非有限 / ≤0 一律 1（= 不缩放，逐位等于旧行为，§16） */
  const vs = (v: unknown): number => {
    const f = Number(v);
    return Number.isFinite(f) && f > 0 ? f : 1;
  };
  return x
    ? {
        screenW: n(x.screenW),
        mpp: n(x.mpp),
        speedMps: n(x.speedMps),
        zoomLevels: zl(x.zoomLevels),
        bearing0: bg(x.bearing0),
        bearingNow: bg(x.bearingNow),
        depthGain: dg(x.depthGain),
        camX: g(x.camX),
        camY: g(x.camY),
        viewScale: vs(x.viewScale),
      }
    : { screenW: 0, mpp: 0, speedMps: 0, zoomLevels: 0, bearing0: 0, bearingNow: 0, depthGain: 1, camX: NaN, camY: NaN, viewScale: 1 };
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
  /* 📐 §14：这一推的**方向**决定"1 屏幕 px 顶几倍米"（纵向 1px = 横向 1px 的 `depthGain` 倍）——
     除它一下，`|世界位移| = speedMps × 时间` 才与方向无关（旧行为里"往上推"快 2.28 倍）。
     `depthGain = 1` ⇒ `gg ≡ 1` ⇒ 与旧公式逐位相同。 */
  const gg = joyGroundGainOf(v.x / unit, v.y / unit, c.depthGain);
  const k = sp / c.mpp / unit / gg; // (m/s) ÷ (m/px) ÷ |方向| ÷ 方向增益 ⇒ 每单位分量的 px/s
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

/**
 * 🎥 `joyLngLatOf` 的**严格逆**（同一个 2×2 雅可比解回来）——"相机在标尺坐标系里的位置"就是它算的。
 * 为什么必须有这一份：单一几何真源要求**相机的位置从地图自己的 `getCenter()` 反解出来**，
 * 而不是由模型再积分一个 `cx`（那就是第二份几何：用户拖图/捏合动过的相机它永远看不见）。
 * 它不是"第二份投影数学"（红线）：没有经纬度换算、没有三角、不碰地图库 —— 只有那次标定量到的
 * 同一个 2×2 的逆（行列式为零/非有限 ⇒ `null`，宁可不报真值，也不写编出来的坐标）。
 */
export function joyScreenOf(
  origin: { lng: number; lat: number },
  s: JoyPxScale,
  lng: number,
  lat: number
): { x: number; y: number } | null {
  if (!origin || !s) return null;
  const dlng = Number(lng) - Number(origin.lng);
  const dlat = Number(lat) - Number(origin.lat);
  const det = s.dxLng * s.dyLat - s.dyLng * s.dxLat;
  if (!Number.isFinite(dlng) || !Number.isFinite(dlat) || !Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const x = (dlng * s.dyLat - dlat * s.dyLng) / det;
  const y = (dlat * s.dxLng - dlng * s.dxLat) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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
  /* 🧭 §13：**屏幕向量 → 标尺坐标系**（唯一一处）。地图被用户转过（`bearingNow ≠ bearing0`）时，
     同一个"屏幕上往上推"对应的世界方向就变了 —— 不转这一步，方向就是错的。
     `Δβ = 0` ⇒ 逐位返回原向量（既有判据一字不变）。 */
  const fv = joyFrameVectorOf(v, c);
  /* 目标速度（px/s）——由**世界速度档** ÷ 米每像素 得来（`joyTargetVelocity` 是唯一换算处；
     它内部再按 §14 的纵向增益把"世界速度各向同性"这一条补齐） */
  const t = joyTargetVelocity(fv, c);
  const pushing = !!(v && v.mag > 0);
  const bad = !Number.isFinite(m.vx + m.vy + m.px + m.py + m.cx + m.cy + m.zo);
  if (bad) return { d: { dx: 0, dy: 0 }, move: createJoyMotion(), moving: false, centering: false };
  /* dt=0（注入的时钟没走 / 同一毫秒内两次）⇒ 状态逐字节不变；只有"还在推 / 还在滑 / 相机还没贴住角色 / 相机距离还没归位"才续帧 */
  if (!dt) {
    /* 🎥 §16：报了相机真值就按**真值**判"相机还没贴住角色"（否则外力搬走的相机在这一帧会被判"已贴合"） */
    const off =
      Number.isFinite(c.camX) && Number.isFinite(c.camY)
        ? m.px !== c.camX || m.py !== c.camY
        : m.px !== m.cx || m.py !== m.cy;
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
  /* ③④⑤ 相机：目标 = 角色 + **有界**前瞻；回中段（角色停稳）前瞻/死区都归 0
     🎥 §16 **单一几何真源**（2026-10-04 第六轮，机主：「镜头无法锁定在角色身上」）——
     相机的位置**不再由本函数积分**：`ctx.camX/camY`（宿主每帧从 `getCenter()` 反解出来的真值）就是它。
     这一改治的是**病根**：老写法里 `cx/cy` 是"模型以为相机在哪"的第二本账，与真实相机只靠 `d` 相加
     维持同步 ⇒ **凡不是摇杆干的相机运动**（用户拖图 / 捏合 / 转地图 / 手动缩放）它一概看不见，
     偏移永久留在那儿（离线读数：用户拖 200px 后再推 3 秒，角色离屏幕中心最大 **413.59px**、
     松手 1 秒后仍 **194.35px**；老代码只会把它夹在"前瞻上限 + 死区"的**模型**带里，真实屏幕上没有上界）。
     `camX/camY` 不给 / `NaN` ⇒ `baseX/baseY = m.cx/m.cy` ⇒ **逐位等于旧行为**（既有判据一条不动）。 */
  const camMeasured = Number.isFinite(c.camX) && Number.isFinite(c.camY);
  const baseX = camMeasured ? c.camX : m.cx;
  const baseY = camMeasured ? c.camY : m.cy;
  /* 🎥 死区/前瞻上限是**屏幕像素**口径 ⇒ 拉近/捏合后要除回标定档（`viewScale = 2^Δz`，缺省 1）。
     只在**闭环**时生效：开环路 `vs` 恒 1 ⇒ 下面每一行逐位等于旧代码。 */
  const vs = camMeasured ? c.viewScale : 1;
  const centering = !pushing && speed === 0;
  const leadMax = (c.screenW * JOY_LEAD_MAX_RATIO) / vs;
  const clampLead = (x: number): number => (leadMax > 0 ? Math.max(-leadMax, Math.min(leadMax, x)) : 0);
  const leadX = centering ? 0 : clampLead(vx * JOY_LEAD_S);
  const leadY = centering ? 0 : clampLead(vy * JOY_LEAD_S);
  const dead = centering ? 0 : JOY_CAM_DEADZONE_PX / vs;
  const shrink = (e: number): number => (Math.abs(e) <= dead ? 0 : e > 0 ? e - dead : e + dead);
  /* 🔴 **硬夹的上界**（研究 §7 的"有界"）：相机与角色的偏移**永不超过**（前瞻上限 + 死区）。
     这是"视角锁定角色"的结构保证 —— 即使状态被外部写坏，相机也会被拉回带上（保险丝，不是常用路径）。 */
  const band = leadMax + JOY_CAM_DEADZONE_PX;
  /* 🎥 闭环时夹的是**误差**（不是位置）：相机被外力搬到 200px 外也不会一帧跳回去，而是以
     ≤ band×ck 的每帧修正量平滑滑回（离线读数：推 3 秒内回到死区内）。开环那条路一个字不动。 */
  const clampBand = (e: number): number => (band > 0 ? Math.max(-band, Math.min(band, e)) : 0);
  const ex = camMeasured ? clampBand(shrink(px + leadX - baseX)) : shrink(px + leadX - baseX);
  const ey = camMeasured ? clampBand(shrink(py + leadY - baseY)) : shrink(py + leadY - baseY);
  const ck = 1 - Math.exp(-s / (centering ? JOY_RECENTER_TAU_S : JOY_CAM_TAU_S));
  let cx = baseX + ex * ck;
  let cy = baseY + ey * ck;
  /* ⚠️ 位置硬夹只走**开环**那一支：闭环的当前位置来自地图，拿硬夹去改它等于"把观测值改掉"
     （假读数 + 一帧跳 152px）；闭环的"有界"由上面 `clampBand` 的**每帧修正量上界**保证。 */
  if (!camMeasured) {
    cx = Math.max(px - band, Math.min(px + band, cx));
    cy = Math.max(py - band, Math.min(py + band, cy));
  }
  /* 🔴 亚像素尾巴**不许写**：`shrink()` 在死区边界上会给出 1e-15 这种量级的偏差 ⇒ 相机每帧
     挪 1e-16px ⇒ `d` 非 0 ⇒ rAF 链**永不收尾**、每帧白发一次 `panBy`（实测栽过：滑停后
     `moving` 一直为 true、跑满 400 帧上限）。小于百分之一像素就当"这一步没动"。 */
  if (Math.abs(cx - baseX) < JOY_CAM_EPS_PX && Math.abs(cy - baseY) < JOY_CAM_EPS_PX) {
    cx = baseX;
    cy = baseY;
  }
  /* 停稳 = 速度恰好 0 **且** 相机这一帧一步都没走 **且** 相机距离不再变（⇒ `d` 恰好 {0,0}、`zo` 恰好 0，链可以断）。
     🔴 不能拿"离目标 < 0.05px"来判：推着走时相机本来就会停在离目标最多
     `JOY_CAM_DEADZONE_PX` 的地方，那个判据永远不为真。
     🔴 `zo` 也必须进这一条：回程尾段相机可能已经贴住角色（`d = {0,0}`）而相机距离还在收敛，
     那时断链就会把相机**永久停在拉近后的距离**上（名字层也跟着一直藏着）。 */
  const settled = speed === 0 && cx === baseX && cy === baseY && zo === m.zo;
  /* ④ 朝向 + 踏步：满速 = 世界速度 ÷ 米每像素（没有尺子 ⇒ 比例恒 0，不动画） */
  const vmax = c.mpp > 0 ? Math.min(c.speedMps, JOY_SPEED_MAX_MPS) / c.mpp : 0;
  const speedRatio = vmax > 0 ? Math.min(1, speed / vmax) : 0;
  const headingDeg = vmax > 0 && speed > vmax * 0.01 ? joyWorldHeadingOf(vx, vy, c.bearing0) : m.headingDeg;
  const stepPhase = m.stepPhase + (speedRatio > 0 ? s * JOY_STEP_HZ * speedRatio : 0);
  const move: JoyMotion = {
    vx,
    vy,
    px,
    py,
    cx,
    cy,
    /* 🧭 §13：存的是**世界（罗盘）朝向**（= 标尺角 + `bearing0`）。宿主要在**当前屏幕**上画它，
       得再减掉 `bearingNow`（`joyScreenHeadingOf`）—— 一步都不许各自算。 */
    headingDeg: joyNormDeg(headingDeg),
    speedRatio,
    stepPhase,
    zo,
  };
  return { d: { dx: cx - baseX, dy: cy - baseY }, move, moving: !settled, centering };
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

/* 🕹🧱 **摇杆走路期间的"边走边补"节流**（2026-10-04 第八轮）。
 *
 * 机主原话：「在将屏幕**斜过来**时移动角色**楼会不见**，**反复放大缩小就好了**，
 *           在正常直接**竖直向下看时就不会**喵」。
 * 🔴 机制（代码级，不是猜）：宿主 `WsDistrictMapLibre.vue` 在摇杆驱动期间（`joyActive === true`）
 *    把 `move` / `moveend` 整条"刷新包 + 落楼 + 名字"的路**早退**掉了（`m.on("move", () => {
 *    if (joyActive) return; … })` 与 `m.on("moveend", () => { if (joyActive) return; … })`）
 *    ⇒ 画出去的楼**一直是上一次停下来的那批**；俯角 64° 时看得见的地面只有**一条窄带**，
 *    走几十米那批楼就滚出屏幕、**没有新的补进来** ⇒「楼不见」；
 *    `zoomend` 仍会重挑一次（`bldTierCrossedFlush`）⇒ 所以「**反复放大缩小就好了**」；
 *    俯角 0（竖直向下）视野宽得多 ⇒ 那批楼久留在屏内 ⇒「**竖直向下看就不会**」。
 *
 * 这条纯函数就是那次补刷新的**唯一闸门**：两个条件都满足才允许再刷一次 ——
 * 既不饿死（走远了屏上没楼），也不变成每帧刷（每帧一次重挑 + `setData` = 掉帧与发热）。
 * 🔴 它**只做算术**：不读地图、不碰 DOM、不认时间源（`movedM` / `elapsedMs` 都由宿主喂进来
 *    ⇒ node 里能逐个钉字面量，也能被"变异"后重跑）。
 */

/** 走过这么多米才允许再补刷一次（走路 1.4m/s ⇒ 最少 71s 一次；载具 13.9m/s ⇒ 约 7.2s 一次） */
export const JOY_FLUSH_MIN_M = 100;
/** 距上一次补刷新至少这么久（ms）——"不许变成每帧刷"的那一半闸门 */
export const JOY_FLUSH_MIN_MS = 600;

/**
 * 现在**该不该**补刷一次（宿主每帧问一次；`true` 的那一帧才真的去刷）。
 * 判据：`movedM >= JOY_FLUSH_MIN_M` **且** `elapsedMs >= JOY_FLUSH_MIN_MS`（**两边都含边界**）。
 * 三态，**不抛**：任一输入不是有限数（NaN/±∞/undefined）⇒ `false`；负数/不足 ⇒ `false`
 * —— "数不出来"与"还没走够"在调用方看来是同一件事：**这一帧不刷**。
 */
export function joyFlushDue(input: { movedM: number; elapsedMs: number }): boolean {
  if (!input) return false;
  const moved = Number(input.movedM);
  const ms = Number(input.elapsedMs);
  if (!Number.isFinite(moved) || !Number.isFinite(ms)) return false;
  return moved >= JOY_FLUSH_MIN_M && ms >= JOY_FLUSH_MIN_MS;
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
   * 🎯 第 5 个参数是**这一帧的 dt（ms，已夹到 `JOY_MAX_DT_MS`）**：只给预走线那条平滑用
   * （`joyAimStep` 要按时间常数收线；宿主自己去读时钟就会多出第二个时间源 —— 本仓"唯一 rAF / 唯一时钟"纪律）。
   */
  onFrame: (d: JoyFrameDelta, v: JoyVector, move: JoyMotion, phase: JoyFramePhase, dtMs: number) => void;
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
    /* 🧭 `joyCtxWithFrame` = 宿主那份世界尺度 + **当前参考系**（§13 的 Δbearing / §14 的俯角增益）——
       驱动里唯一一处合并；不并的话"地图被用户转过之后"方向就是错的 */
    const r = joyMotionStep(move, v, joyCtxWithFrame(deps.ctx()), dt);
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
      /* 第 5 个参数 = 这一帧的 dt（**同一个夹法**：`clampDt` 是唯一一处夹，预走线的平滑与运动模型
         用的是同一个时间步长 —— 不然掉帧时线会按真实 dt 收、角色按 64ms 走，两者对不上）。 */
      deps.onFrame(r.d, v, move, r.centering ? "center" : "push", clampDt(dt));
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

/* ══════════════════════════════════════════════════════════════════
 * 八、🕹 摇杆的"家"（位置）：长按搬家 + 记住 + 安全区（2026-10-04 第四轮）
 * ══════════════════════════════════════════════════════════════════
 * 机主原话：「**这个摇杆位置太反人类了喵**！」—— 固定左下角那块 112px，要拇指每次都回到同一个点。
 * 研究 §10 查到两条硬事实，决定了本轮的取舍：
 *   · §10.1 [官方] Unity Input System 的 `OnScreenStick` 就是**以 pointer-down 那个点为中心**生成摇杆的
 *     （逐字："within a box **centered on the pointer-down screen point**, and with an edge length defined in
 *     the component's Movement Range property"）—— "触点即生成"确实是引擎官方的做法；
 *   · 但**整片拇指区不能归摇杆**：本屏地图的拖动/捏合是 MapLibre 自己挂在画布上的监听
 *     （`WsDistrictMapLibre.vue` **一个默认手势都没关**），盖一层透明"拇指区"会把地图拖动、双指缩放
 *     **全挡掉** ⇒ 那是一条会破功能的改法，本轮**不做**（要做就得把地图手势接过来自己转发，另一个量级）。
 * ⇒ 折中方案（**这就是本轮的完整口径**，别当成没做完）：
 *     **在地图上长按（不在浮块/标签/钉子上）⇒ 摇杆的家搬到这里，并记住**；
 *     底盘默认仍是左下 `JOY_INSET_PX`（既有几何红线一条不动），命中区仍是整块 112。
 * 三条纪律：
 *   ① **被动监听**：只读 pointerdown/move/up，从不 `preventDefault`/`stopPropagation`
 *      （长按没触发 ⇒ 那一次拖动照旧是地图拖动；不抢手势就不会有"地图拖不动了"这种回归）；
 *   ② **搬到哪儿都夹住**：先夹进容器，再把 HUD 让位带 / 📱 FAB / 🔬 三个矩形**往上推开**
 *      （§10.2 [标准] WCAG 2.2 SC 2.5.8：目标要么够大、要么彼此够开 —— 我们两个都要）；
 *   ③ **记忆要能坏**：归一化坐标存本地；读不出来 / 坏数据 / 夹到放不下 ⇒ **回默认左下**（绝不抛、绝不猜）。
 */

/** 位置的**本地记忆键**（唯一一处定义；`wsm:v1:` 前缀与其它世界模拟存储一致） */
export const JOY_HOME_STORE_KEY = "wsm:v1:joypos";
/**
 * 长按多久算"搬到这里"（ms）。
 * ⚠️ 数字是**本仓自定**（没抓到外部来源，见研究 §10 的失败清单）：取 420 而不是 iOS/Android 常见的 500，
 * 因为**手指只要移动超过 `JOY_HOME_SLOP_PX` 就立刻取消**（那一次是地图拖动）⇒ 宁可短一点、早给反馈。
 */
export const JOY_HOME_HOLD_MS = 420;
/** 长按期间允许的手指抖动（px）：超过它就判"这是地图拖动"，取消搬家（与 §10.1 的拖动阈值同一族概念） */
export const JOY_HOME_SLOP_PX = 10;
/** HUD 在让位后的**一行高度**（px）——与自检 ③ 的那组字面量同值（HUD 一行 ≈22px 含 padding） */
export const JOY_HOME_HUD_ROW_PX = 22;
/** 📱 FAB 的外接矩形（`WsPhone.vue:205-216`：52×52、right 14、bottom 96） */
export const JOY_HOME_FAB = { w: 52, h: 52, right: 14, bottom: 96 } as const;
/** 🔬 的外接矩形（`WsVerifyPanel.vue:439-444`：44×44、right 8、bottom 8） */
export const JOY_HOME_MAG = { w: 44, h: 44, right: 8, bottom: 8 } as const;

/** 一个矩形（容器坐标，CSS px；左上原点） */
export interface JoyHomeBox {
  l: number;
  t: number;
  r: number;
  b: number;
}
/** 家的**归一化坐标**（底盘中心 ÷ 容器宽高）—— 存这一个，转屏/换窗口都能复原 */
export interface JoyHome {
  fx: number;
  fy: number;
}
/** 容器里**碰不得**的三块（HUD 让位带 / 📱 / 🔬）——容器尺寸决定，所以是函数不是常量表 */
export function joyHomeBoxesOf(w: number, h: number, basePx?: number): JoyHomeBox[] {
  const W = Number.isFinite(w) && w > 0 ? w : 0;
  const H = Number.isFinite(h) && h > 0 ? h : 0;
  if (!W || !H) return [];
  return [
    /* HUD：`left:8`、`bottom: calc(8px + JOY_HUD_LIFT_PX)`、宽 `W-60`、一行 22 —— 与自检 ③ 同一组数 */
    { l: JOY_INSET_PX, t: H - (JOY_INSET_PX + JOY_HUD_LIFT_PX) - JOY_HOME_HUD_ROW_PX, r: JOY_INSET_PX + (W - 60), b: H - (JOY_INSET_PX + JOY_HUD_LIFT_PX) },
    { l: W - JOY_HOME_FAB.right - JOY_HOME_FAB.w, t: H - JOY_HOME_FAB.bottom - JOY_HOME_FAB.h, r: W - JOY_HOME_FAB.right, b: H - JOY_HOME_FAB.bottom },
    { l: W - JOY_HOME_MAG.right - JOY_HOME_MAG.w, t: H - JOY_HOME_MAG.bottom - JOY_HOME_MAG.h, r: W - JOY_HOME_MAG.right, b: H - JOY_HOME_MAG.bottom },
  ];
}
/** 默认的家（与现行 CSS 逐字一致：左下角、`JOY_INSET_PX` 边距）——`resolve` 放不下时也回这里 */
export function joyHomeDefaultOf(w: number, h: number, basePx?: number): { cx: number; cy: number } | null {
  const W = Number.isFinite(w) && w > 0 ? w : 0;
  const H = Number.isFinite(h) && h > 0 ? h : 0;
  if (!W || !H) return null;
  const r = (Number.isFinite(Number(basePx)) && Number(basePx) > 0 ? Number(basePx) : JOY_BASE_PX) / 2;
  return { cx: JOY_INSET_PX + r, cy: H - JOY_INSET_PX - r };
}
/**
 * **把家夹进安全区**（唯一的"能不能放这儿"判据）。步骤固定、可离线复算：
 *   ① 夹进容器（四边留 `JOY_INSET_PX`）；② 与任一禁区（各自外扩 `JOY_GAP_PX`）相交 ⇒ **往上推**到它上方；
 *   ③ 推完再夹一次（最多 4 轮，三个矩形足够收敛）；④ 推上去放不下（比容器还高）⇒ `null`（调用方回默认）。
 * 为什么是"往上推"而不是"左右推"：三块禁区全部贴在**下缘**（HUD / 📱 / 🔬），往上推一次就走开，
 * 而且"拇指自然落点是下半屏"这件事不需要被破坏 —— 家仍然在够得着的地方。
 */
export function joyHomeResolve(w: number, h: number, cx: number, cy: number, basePx?: number): { cx: number; cy: number } | null {
  const W = Number.isFinite(w) && w > 0 ? w : 0;
  const H = Number.isFinite(h) && h > 0 ? h : 0;
  if (!W || !H) return null;
  const r = (Number.isFinite(Number(basePx)) && Number(basePx) > 0 ? Number(basePx) : JOY_BASE_PX) / 2;
  const lo = JOY_INSET_PX + r;
  const hiX = W - lo;
  const hiY = H - lo;
  if (hiX < lo || hiY < lo) return null; // 容器还装不下一块底盘 ⇒ 没有可信的家
  const clamp = (v: number, a: number, b: number): number => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : a);
  let x = clamp(cx, lo, hiX);
  let y = clamp(cy, lo, hiY);
  const boxes = joyHomeBoxesOf(W, H, basePx);
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    for (const b of boxes) {
      const out =
        x + r <= b.l - JOY_GAP_PX || x - r >= b.r + JOY_GAP_PX || y + r <= b.t - JOY_GAP_PX || y - r >= b.b + JOY_GAP_PX;
      if (out) continue;
      y = b.t - JOY_GAP_PX - r;
      hit = true;
    }
    if (!hit) break;
    if (y < lo) return null; // 推到容器外了 ⇒ 交给调用方回默认
    y = clamp(y, lo, hiY);
  }
  return { cx: x, cy: y };
}
/**
 * 家的最终裁决（宿主只调这一个）：**有记忆 ⇒ 先用它**（归一化 × 当前容器）、**放不下/没有/坏数据 ⇒ 默认左下**。
 * 返回的一定是"夹过的、不与三块禁区相交的"中心；容器量不出来 ⇒ `null`（宿主动不了它 —— 与"量不到尺子就站住"同一纪律）。
 */
export function joyHomeOf(w: number, h: number, stored: JoyHome | null, basePx?: number): { cx: number; cy: number } | null {
  const def = joyHomeDefaultOf(w, h, basePx);
  if (!def) return null;
  if (!stored) return joyHomeResolve(w, h, def.cx, def.cy, basePx) || def;
  return joyHomeResolve(w, h, stored.fx * w, stored.fy * h, basePx) || joyHomeResolve(w, h, def.cx, def.cy, basePx) || def;
}
/** 底盘 CSS 锚在**左下角**（`left/bottom: var(--ws-joy-inset)`）⇒ 家到"默认位置"的差就是那**唯一一个** `translate3d` */
export function joyHomeOffsetOf(w: number, h: number, home: { cx: number; cy: number } | null, basePx?: number): { dx: number; dy: number } {
  const def = joyHomeDefaultOf(w, h, basePx);
  if (!def || !home) return { dx: 0, dy: 0 };
  return { dx: home.cx - def.cx, dy: home.cy - def.cy };
}
/**
 * 存的那一位：`"fx,fy"`（两个 0..1 的有限数）；**坏数据一律 `null`**（`"{}"` / `"1"` / `"abc"` / 越界 / 空 ⇒ 没有记忆）。
 * 与 `joyStoredOf` 同一条纪律：绝不抛、绝不猜（坏数据不该把摇杆搬到屏幕外）。
 */
export function joyHomeStoredOf(raw: unknown): JoyHome | null {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^-?\d*\.?\d+,-?\d*\.?\d+$/.test(s)) return null;
  const [a, b] = s.split(",").map((t) => Number(t));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || a > 1 || b < 0 || b > 1) return null;
  return { fx: a, fy: b };
}
/** 读盘（坏了/没有/读不动 ⇒ `null`，绝不抛 —— 与 `readJoyStored` 同款） */
export function readJoyHome(): JoyHome | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return joyHomeStoredOf(localStorage.getItem(JOY_HOME_STORE_KEY));
  } catch {
    return null;
  }
}
/** 落盘（写不进去不影响本次会话）；`null` = 忘掉记忆 ⇒ 下次回默认左下 */
export function writeJoyHome(home: JoyHome | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!home) localStorage.removeItem(JOY_HOME_STORE_KEY);
    else localStorage.setItem(JOY_HOME_STORE_KEY, `${home.fx},${home.fy}`);
  } catch {
    /* 写不进去就只活这一次会话 */
  }
}
/**
 * 长按判定（**纯函数**，自检钉真值表；组件在 pointermove 与定时器两处都用它）：
 *   · 手指抬了（`down=false`）⇒ `"cancel"`；
 *   · 位移超过 `JOY_HOME_SLOP_PX` ⇒ `"cancel"`（这是**地图拖动**，不是搬家）；
 *   · 按够 `JOY_HOME_HOLD_MS` 且没走 ⇒ `"fire"`；
 *   · 其余 ⇒ `"pending"`（继续等）。
 */
export function joyHoldDecide(input: { down: boolean; movedPx: number; heldMs: number }): "pending" | "fire" | "cancel" {
  if (!input || !input.down) return "cancel";
  const moved = Number.isFinite(input.movedPx) ? input.movedPx : Infinity;
  if (moved > JOY_HOME_SLOP_PX) return "cancel";
  const held = Number.isFinite(input.heldMs) ? input.heldMs : 0;
  return held >= JOY_HOME_HOLD_MS ? "fire" : "pending";
}

/* ══════════════════════════════════════════════════════════════════
 * 九、🎯 预走线（指向移动方向的虚线 + 箭头）—— 2026-10-04 第四轮
 * ══════════════════════════════════════════════════════════════════
 * 机主原话：「能给移动加**预走线**吗，就是在移动方向上加一个**可以指向移动方向的箭头**（**动画要好看**喵！）」。
 * 研究 §12 的三条结论直接决定画法：
 *   · §12.1 [官方] Mapbox 定位指示器（puck）的标准形态是"**绕自身转朝向 + 视口跟随**"
 *     （`createDefault2DPuck(withBearing = true)` + `puckBearing = PuckBearing.COURSE`）⇒ 指示器要**长在角色身上**，
 *     不是屏幕正中一个固定箭头；
 *   · §12.2 [官方] 导航把位置点钉在取景框下缘、靠内容流动表达"在动" ⇒ 线必须挂在角色上、跟着角色走；
 *   · §12.3 [官方] MDN：`ease-out` = `cubic-bezier(0, 0, 0.58, 1)`，"starts abruptly and then progressively
 *     slows down towards the end" ⇒ **淡出用 ease-out**，且入场（140ms）比退场（320ms）快。
 * 四个硬约束（逐条落在常量与判据里）：
 *   ① **只写 transform/opacity**：线长 = 虚线元素的 `scaleX`、箭头位置 = 箭头元素的 `translate3d`、
 *      显隐 = class 驱动的 CSS `opacity` 过渡（**每帧 0 次 opacity 写**）；**一个布局属性都不碰**；
 *   ② **停下优雅淡出**（不是硬切）：`is-aim` 摘掉那一帧起走 320ms `ease-out`，同时线长按 `JOY_AIM_TAU_S` 收回；
 *   ③ **可关**：`low` 档整条不画（省性能）；`prefers-reduced-motion` 只关"流动"（虚线不跑、线照画 ——
 *      它同时是**操作反馈**：告诉你"我正在往哪边走、推多满"）；
 *   ④ **不与名字层/标签打架**：最远端 = `JOY_AIM_GAP_PX + JOY_AIM_MAX_PX + JOY_AIM_TIP_PX = 58px`（有上界），
 *      而且它画在**钉子自己的 DOM 里**（与朝向箭头同一层），**一个名字层节点都不碰**（判据钉着）。
 * ⚠️ 诚实记一笔：线长与"米数"**没有**换算关系（§6 的红线是"世界速度不许按像素放大"，这里反过来）——
 *    它是一个**风格化的推出量指示**，不许被读成"我还能走 34px"。
 */

/** 虚线起点离身体中心的距离（px）= 身体 30px 的半径 15 + 2px 缝（长在身体外面一点，别盖住人） */
export const JOY_AIM_GAP_PX = 17;
/** 起步线长（px）—— ≈ 半个身体直径：一推就看得见，不是"推到底才出现" */
export const JOY_AIM_MIN_PX = 14;
/** 满推线长（px）—— 34 ≈ 拉近后满推的屏幕速度 20.0058 px/s（研究 §9.8 实测）× 1.7（约一秒半的路程） */
export const JOY_AIM_MAX_PX = 34;
/** 箭头（三角）宽度（px）——也是它 `translate3d` 的终点偏移量 */
export const JOY_AIM_TIP_PX = 7;
/**
 * 线长的**平滑时间常数**（秒）—— 松手后按它收回（与速度那条指数逼近同构，研究 §1）。
 * 0.22s：0.3 秒收掉 `1−e^(−1.36) = 74.4%`，正好落在 CSS 那 320ms 淡出的窗口里 ⇒ 观感是"线**缩回去**并淡掉"，
 * 不是"啪一下没了"。**为什么不用 CSS transition 管线长**：push 期间线长每帧都在写，
 * transition 会把每一帧都当成一次新过渡的起点（线永远追不上手指）——所以"平滑"必须由模型负责。
 */
export const JOY_AIM_TAU_S = 0.22;
/** 虚线周期（px）：CSS 的"流动"动画平移**恰好一个周期** ⇒ 无缝循环（§12.4 的正统做法，但我们走 transform） */
export const JOY_AIM_DASH_PX = 9;
/**
 * 每帧**写点预算**（**具名** —— 机主的要求是"有界且具名"，不是一个模糊的"很少"）：
 *   相机 3：`panBy`（有位移才写）/ `easeTo({zoom})`（`zo` 变了才写）/ 名字层容器跟手（同上）
 *   角色 5：`setLngLat` / 朝向（`face.rotate` 与 `aim.rotate` **同一帧只可能有一个**）/ 踏步 /
 *           虚线 `scaleX` / 箭头 `translate3d`
 * ⇒ **最坏 8 个**；稳态（方向不变、zoom 已收敛）通常 5 个。**预走线自己最多占 2 个**（`JOY_AIM_WRITES_MAX`）。
 * 另有两个 class 写点（`is-aim` / `is-zoom-pull`）**只在状态翻转那一帧**发生，不进每帧循环；
 * 预走线**收线那一帧**另有一次朝向箭头补写（`joyFaceSync`，同一帧 ≤ 9 个写点）—— 那是"箭头在预走线期间
 * 让位、收线时要带着**当前**角度淡回来"的代价，一次一段，不在稳态里。
 */
export const JOY_FRAME_WRITES_MAX = 8;
export const JOY_AIM_WRITES_MAX = 2;

/**
 * 预走线这一档怎么画（**唯一判据**，自检钉真值表）：
 *   · `"off"`    = `low` 档：**整条不画**（每帧 0 个写点 —— 省性能）；
 *   · `"static"` = 系统"减弱动效"：线照画（它是操作反馈），但**虚线不流动**（CSS 关掉那段动画）；
 *   · `"full"`   = 正常：虚线流动 + 淡入淡出。
 */
export type JoyAimMode = "full" | "static" | "off";
export function joyAimModeOf(input: { low: boolean; reduced: boolean }): JoyAimMode {
  if (input && input.low) return "off";
  return input && input.reduced ? "static" : "full";
}
/** 推出量 → 线长比例的缓动（ease-out 二次，§12.3 的曲线族）：起步就长出来一截，快满推时变化放缓 */
export function joyAimEase(k: number): number {
  const x = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0;
  return 1 - (1 - x) * (1 - x);
}
/** 一帧要写进 DOM 的两个数（**只有两个** —— 与 `JOY_AIM_WRITES_MAX` 对齐） */
export interface JoyAimFrame {
  /** 线长比例 0..1（虚线元素 `scaleX`）——已经按 `JOY_AIM_TAU_S` 平滑过 */
  k: number;
  /** 虚线长度（px）= `MIN + (MAX − MIN) × k` */
  dashPx: number;
  /** 虚线元素的 `scaleX` = `dashPx / JOY_AIM_MAX_PX` */
  scaleX: number;
  /** 箭头的 `translate3d` 位移（px，沿**朝向**轴）= `GAP + dashPx` */
  tipPx: number;
  /** 要不要画（`k` 还没到 0）—— 宿主据此决定"还写不写这两个数" */
  on: boolean;
}
/**
 * 预走线的一步（**纯函数**，宿主每帧调一次）。
 * 不变量（自检钉着）：① 非有限输入一律归 0（绝不写 NaN 进 `transform`）；② `k` 单调趋近目标、不越界；
 * ③ 松手（`speedRatio = 0`）后按 `JOY_AIM_TAU_S` 收回，**且低到 `JOY_AIM_MIN_PX` 以下就写 0**（能收尾）。
 */
export function joyAimStep(prevK: number, speedRatio: number, dtMs: number): JoyAimFrame {
  const dt = clampDt(dtMs) / 1000;
  const target = joyAimEase(speedRatio);
  const prev = Number.isFinite(prevK) ? Math.max(0, Math.min(1, prevK)) : 0;
  const a = dt > 0 ? 1 - Math.exp(-dt / JOY_AIM_TAU_S) : 0;
  let k = prev + (target - prev) * a;
  if (!Number.isFinite(k)) k = 0;
  k = Math.max(0, Math.min(1, k));
  const dashPx = JOY_AIM_MIN_PX + (JOY_AIM_MAX_PX - JOY_AIM_MIN_PX) * k;
  /* 收尾：目标就是 0 且已经够短 ⇒ **写恰好 0**（指数衰减永远到不了 0，与 `JOY_REST_MPS` 同一条纪律） */
  if (target === 0 && k < 0.02) k = 0;
  const dash = k === 0 ? 0 : dashPx;
  return { k, dashPx: dash, scaleX: dash / JOY_AIM_MAX_PX, tipPx: JOY_AIM_GAP_PX + dash, on: k > 0 };
}
