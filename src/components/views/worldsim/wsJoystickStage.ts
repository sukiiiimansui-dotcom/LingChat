/* wsJoystickStage.ts —— M5：**摇杆近景的整条会话**（`PLAN-REFACTOR.md` §2.1 的 M5 / §3 的 S5）。
 *
 * ## 这个文件收什么
 * 从宿主 `WsDistrictMapLibre.vue` **整块搬出来**的那些"摇杆 → 近景跟随"的东西
 * （锚点 = 函数名，不按行号）：
 *   · 会话状态：`joyAccX`/`joyAccY`（跟手位移）、`joyFlush*`（🕹🧱 补刷新那四个数）、
 *     `joyPrevCam`（接管前的相机快照）、`joyOrigin`/`joyScale`/`joyMove`（漫游位置真源）、
 *     `joyBearing0`/`joyDepthGain`（§13/§14 参考系）、`joyViewScale`（§16 视口倍率）、
 *     `joyZoom0`/`joyZoomApplied`（相机距离）、`joyAimOn`/`joyAimK`/`joyFaceDeg`（🎯 预走线）
 *   · 标尺与相机真值：`joyCalibrate`（量两把尺子）/ `joyReportCam`（§16 每帧报一次）/ `joyReadBearing`
 *   · 会话开合：`joyReadCam` / `joyEnter` / `joyExit`
 *   · 帧里那一路：`joyNamesFollow`（名字层跟手，**只写 1 个容器**）/ `onJoyDrive`（唯一驱动点）/
 *     `joyApplyRoam`（角色世界坐标 → 钉子）/ `joyAimWrite` + `joyFaceSync` + `joyAimReset` +
 *     `joyPinReset`（🎯 预走线与箭头那几个写点）
 *   · 收尾与补刷新：`onJoyHalt`（**恰好一次**重算）/ `joyFlushNow`（🕹🧱 受节流约束的"边走边补"）
 *
 * ## 搬迁纪律（这一片**零行为变化**）
 * 搬迁 = **移动 + 加签名**：分支、阈值、调用顺序、DOM 契约**逐字不变**。所以下面每个函数体
 * 都是从宿主**逐字节**复制过来的（对拍闸 `ws_namejoy_move_selftest.mjs` 断言 diff = 0）。
 *
 * 🔴 **本轮机主点名的热区全在这里、且只有一个实现**（2026-10-04 第八轮那次「走路时楼会不见」）：
 *   · `joyFlushNow()` —— 摇杆期间的补刷新（唯一入口在 `onJoyDrive` 末尾那个闸门）；
 *   · `joyFlushDue({ movedM, elapsedMs })` —— ≥100m **且** ≥600ms 的节流判据（真源在 `wsJoystick.ts`，
 *     本文件只转调，**不重写第二份**）；
 *   · 松手那一发 `bldFlush("joyhalt")`（每锚点冻结走的是同一份 `wsBldPickStore`）。
 *   搬的是**定义**、不是复制 ⇒ 宿主里一个函数体都不留（宿主只接回 `onJoyDrive` / `onJoyHalt` 两个
 *   模板回调与三处 `onMounted` 用的入口）。
 *
 * ## 为什么是 `createJoystickStage(ctx)` 这个工厂
 * 这批函数闭包着宿主一堆 setup 期局部量（`props` / `joyGate` / `cameraMoving` / `labRootEl` /
 * `pins` / `perf` / 两个 ref …）。改成"每次调用都传参"就要逐处改写成 `ctx.xxx` ⇒ 那就不是"只搬不改"了。
 * ⇒ 宿主构造只读 ctx 递进来，工厂在这里**解构一次**。**本模块不 import 宿主**；
 * 与 M4（名字层）之间也**没有**横向 import —— `reprojectNow` / `refreshNames` / `labRootEl`
 * 都由宿主注入（§2.2 规则①②）。
 *
 * ## 🔴 四处**别名/现读**（逐处列在下面，理由同 S4 的 `alive`）
 * ① `map` → **每个读它的函数体第一行**加一句 `const map = ctx.mapNow();`（8 个函数，8 行）。
 *    宿主那份是 `let`（建图时赋值、降级/卸载时置 null）⇒ 解构只会拿到快照。
 *    ⚠️ 为什么不用 S3 那种"形参默认值 = 调用时现读"：`onJoyDrive` 与 `onJoyHalt` 的**签名行**
 *      被 `ws_joystick_selftest` 逐字钉着（判据 ⑦/⑫h），多一个形参就红了 ⇒ 统一用"体内第一行现读"，
 *      这样**签名行一个字都没改**（比 S4 那种"改正文别名"还小：这里多出来的是一整行，肉眼可数）。
 *     ⚠️ 位置在早退**之前**：`ctx.mapNow()` 只是读一下宿主那个变量（无副作用、无投影），
 *      与"早退时不读"在可观察行为上完全一致。
 * ② `alive` → `aliveNow()`（5 处）：宿主 `onBeforeUnmount` 里置 false，而这里有微任务/rAF 之后的收尾
 *    ⇒ **不许在入口冻成快照**（S4 逐字写下的那条理由）。
 * ③ `joyActive` → `joyActiveNow()` / `setJoyActive(…)`（6 处）：宿主那面仍是**唯一一份** `let`
 *    （五个 `m.on(...)` handler 的早退与 `onBeforeUnmount` 都在读它，那些是**宿主自己的守卫**）
 *    ⇒ 与 S4 的 `alive` 同一条处理：宿主握着旗，模块每次现读、要改就喊一声。
 * ④ `bldTimer` → `bldTimerNow()` / `setBldTimer(0)`（2 行）：同上（宿主 `moveend` 那条去抖也在用它）。
 */

import {
  JOY_PITCH_DEG,
  JOY_STEP_PX,
  JOY_ZOOM_PUSH_LEVELS,
  ROAM_PIN_ID,
  createJoyMotion,
  joyAimModeOf,
  joyAimRotateDegOf,
  joyAimStep,
  joyBearingNowOf,
  joyCamRestoreArgs,
  joyCamSnapshotOf,
  joyDepthGainOf,
  joyFlushDue,
  joyLngLatOf,
  joyNamesHiddenOf,
  joyPanScaleOf,
  joyPxScaleOf,
  joyScreenHeadingOf,
  joyScreenOf,
  joySetBearingNow,
  joySetCam,
  joySetFrame,
  joySpeedMpsOf,
  joyWalkAnimOn,
  roamStore,
  type JoyCamSnapshot,
  type JoyFramePhase,
  type JoyMotion,
  type JoyPxScale,
} from "./wsJoystick";
import { bldMetersPerCssPixel } from "./wsBldBudget";
import type { JoystickStageCtx } from "./wsStageTypes";

/**
 * 装配摇杆近景这一层：宿主把只读 ctx 递进来，拿回全部入口。
 *
 * ⚠️ 调用点必须在 `pins` / `perf` / `joyMpp` / `joySpeedMps` / `joyZoomLevels` / `joyZoomPulling` /
 * `bldFlush` / `refreshBundles` / `reprojectNow` 都声明之后（本片放在宿主原来那段的位置：
 * M4 名字层装配之后）—— 早引必踩 TDZ（本仓对 TDZ 有过前科）。
 * ⚠️ 两个 `watch`（`props.joy` 开合、`joyGate.show` 卸载兜底）**故意留在宿主**：它们是"接线"，
 *    宿主里那两处的文本一个字都没改（`ws_joystick_selftest` 用逐字正则钉着它们）。
 */
export function createJoystickStage(ctx: JoystickStageCtx) {
  const { cameraMoving, labRootEl } = ctx;
  const { pins, syncPins, pinEdgeSync, bldFlush, refreshBundles, refreshNames } = ctx;
  const { onMoveEndNames, reprojectNow, perf, joyMpp, joySpeedMps } = ctx;
  const { joyZoomLevels, joyZoomPulling, joyReducedMotion } = ctx;
  const { aliveNow, mapNow, joyActiveNow, setJoyActive, bldTimerNow, setBldTimer } = ctx;

  /* ══════════════════════════════════════════════════════════════════════════════
   * 🕹 摇杆 → 相机（近景：**倾斜俯视的跟随**；机主裁决 2026-10-03）
   * ══════════════════════════════════════════════════════════════════════════════
   * 每帧只做这几件事（顺序不能动）：
   *   ① `panBy([dx,dy],{duration:0})` —— 屏幕像素位移，库内已处理 pitch/bearing，
   *      **我们一行投影数学都不写**（PLAN §2.3 红线）；
   *   ② 名字层跟手：**只写 1 个容器**的 `translate3d`，且位移就是 `-累计位移`
   *      （相机平移是刚体平移 ⇒ 这个值与 `map.project(锚点)` 逐位相同，但**0 次 project**）；
   *   ③ 🆕 **角色真的动**：运动模型给的**世界坐标**写进漫游真源 → 「我」那颗钉子 `setLngLat`
   *      （§3：角色与相机是**两件事**，不再互相反写）；同一帧顺带写 ④⑤ 两个 transform；
   *   ④ 🆕 朝向：钉子上的箭头 `rotate(headingDeg)`（§4：朝向跟随移动方向）；
   *   ⑤ 🆕 踏步：身体 `translate3d`，幅度 ∝ 速度（§4：就地行走动画，停下自动回正）；
   *   ⑥ 别的什么都不做：不 reproject、不重排标签、不重挑楼、不启动 600ms 去抖。
   *
   * 🔴 `joyActive` 是**自持标志**（不是问地图"你在动吗"）：`panBy({duration:0})` 每帧都是一次
   *    完整 ease ⇒ 每帧都会同步发 `movestart`/`move`/`moveend`（vendored `_ease()` 里
   *    `duration===0` 直接 `easeFunc(1); finish()`，`_afterEase` 又把 `_moving` 清掉 ⇒ 下一帧重来）。
   *    不早退的话就是"每帧重投影 + 每帧起一条 600ms 去抖 + 每帧重排标签"——
   *    机主报过的「名字滑动刷新、错位严重 / 松手卡一下」的放大版。
   *    ⚠️ 这面旗（`let joyActive`）**仍归宿主**（五个 `m.on(...)` 的早退与 `onBeforeUnmount` 都在读它）
   *       ⇒ 本文件每次经 `joyActiveNow()` 现读、要改就 `setJoyActive(…)`（见文件头 ③）。
   *
   * ⚠️ 符号口径（**从 vendored 源码逐字核出来的**，别凭手感改）：
   *    `camera.panBy(offset)` = `panTo(center, {offset: offset.mult(-1)})`；
   *    `handleEaseTo` 把**请求的中心**放到屏幕点 `centerPoint + offset` 上
   *    ⇒ `panBy([dx,dy])` 的结果是"相机朝屏幕 (dx,dy) 方向走了 dx,dy 像素"（内容反向平移）。
   *    所以：**推杆方向 = 相机前进方向**，直接用 `[d.dx, d.dy]`，**不取负**；
   *    而内容/标签层的位移是 `-累计位移`（与既有 `onMove()` 算出来的那个值同号同值）。
   *
   * ⚠️ `zoomend` **不需要**早退：本图没有 `maxBounds` ⇒ `handleEaseTo` 的
   *    `isZooming = (约束后的 zoom !== 原 zoom)` 恒为 false ⇒ `panBy` 一次 zoom 事件都发不出来
   *    （vendored 源码逐字核过；判据 1 的"zoom 逐字节不变"由此成立）。
   *    另一只手同时捏合缩放属于**用户明确的视角操作**，那一轮照旧重算 —— 不归摇杆管。 */

  /** 本次按压累计的屏幕位移（px）——名字层容器跟手用；自己算 ⇒ 一次 `map.project()` 都不需要 */
  let joyAccX = 0;
  let joyAccY = 0;
  /* 🕹🧱 **摇杆走路期间"边走边补"的三个数**（2026-10-04 第八轮；机主原话「在将屏幕**斜过来**时
     移动角色**楼会不见**，**反复放大缩小就好了**，在正常直接**竖直向下看时就不会**喵」）。
     机制与闸门见 `wsJoystick.joyFlushDue` 那段；这里是它要的四个数（写点**全在摇杆驱动那条路**上：
     按下起算 / 每帧累加 / 刷完归零 / 松手与退出复位）：
       · `joyFlushMovedM`  ：**这一次按下以来角色走过的世界米数** —— 按 `joyMpp`（米/标定档像素，
                             本组件那把唯一的尺子，与挑楼/速度档同一把）把角色位移积分换算成米。
                             累计的是**路程**（每一帧的位移长度相加），不是直线距离：绕圈也在挪视野；
       · `joyFlushElapsedMs`：距上一次补刷新的**累计时间** —— 用驱动每帧给的 `dtMs` 累加
                             （本仓"唯一时钟 / 唯一 rAF"纪律：**不在这里另读一个时钟源**）；
       · `joyFlushPx/Py`   ：上一帧角色在**标定档像素**里的位置（本帧的世界位移 = 它与 `mv.px/py` 之差）。
     🔴 三个数都只在**摇杆驱动**那条路上读写：`joyActive === false` 时一个字节都不动
        （那条老路由 `moveend` 自己刷，见下面 `joyFlushNow()` 的说明）。 */
  let joyFlushMovedM = 0;
  let joyFlushElapsedMs = 0;
  let joyFlushPx = 0;
  let joyFlushPy = 0;
  /**
   * **接管前的相机**（关闭时要逐字还原到这一份；机主的硬要求："不许留残留状态"）。
   * 两个来源，都只在这里写：
   *   · 启动时存储值/URL 就是开 ⇒ 由建图那段填「**没有摇杆时**这一屏会落到的机位」；
   *   · 运行时在面板里打开 ⇒ 现读相机（`getCenter/getZoom/getPitch/getBearing`）。
   * 读不齐（任一项非有限）⇒ `joyCamSnapshotOf()` 给 `null` ⇒ **关闭时一次相机都不动**（宁可不还原，也不编）。
   */
  let joyPrevCam: JoyCamSnapshot | null = null;

  /* 🕹🆕 2026-10-03 **运动模型落地**（机主验收原话：「这个移动不能真正像游戏那样移动！甚至角色都没有动，
     太杂鱼了！能去学游戏引擎吗」）—— 下面这三个值就是"角色真的在动"的全部新增状态，各一处：
       · `joyOrigin`：漫游**原点**（= 进近景那一刻的相机中心，世界坐标的锚）；
       · `joyScale` ：屏幕 px → 经纬度的**局部标尺**（`joyCalibrate()` 用**地图库自己的** unproject 量一次）；
       · `joyMove`  ：运动状态（速度 / 角色位移 / 相机位移 / 朝向 / 踏步相位），由
                      `wsJoystick.joyMotionStep()` 每帧推进；**跨按压保留** ⇒ 松手再推不会把人瞬移回原点。 */
  let joyOrigin: { lng: number; lat: number } | null = null;
  let joyScale: JoyPxScale | null = null;
  let joyMove: JoyMotion = createJoyMotion();
  /**
   * 🧭 §13 **参考系**（这一屏只有这一份）：
   *   · `joyBearing0`：标定那一刻的相机 bearing —— 上面那把 px→经纬度的标尺就架在它上面；
   *   · `joyDepthGain`：`1/cos(pitch)`（§14，标定那一刻的俯角算出来）。
   * 相机 bearing 由**用户手势**改（双指旋转），**不跟角色朝向** —— 我们选的是"相机相对输入"那一套
   * （研究 §13.2）。所以每一个推杆帧都要把当前的 bearing 报给模型：`Δβ ≠ 0` 时它先把屏幕向量
   * 转回标尺坐标系，否则方向就按"标定那一刻的上"走（= 机主报的「移动方向和屏幕方向不一样」）。
   */
  let joyBearing0 = 0;
  let joyDepthGain = 1;
  /**
   * 🎥 §16 **视口倍率** `2^(zoomNow − zoom0)` —— 上一次 `joyReportCam()` 量到的那个数。
   * 用途只有一个：把模型给的**标定档**像素位移换成 `panBy` 要的**当前档**像素（`d × viewScale`）。
   * 🔴 必须与**模型这一帧用的那个数**是同一个（模型从 ctx 拿到的是上一次报的），否则两者差一档
   * ⇒ 相机按错的倍率追角色。所以它由同一处（`joyReportCam`）写、同一帧里只读一次。
   */
  let joyViewScale = 1;
  /* 🕹🆕 2026-10-03 第三轮（机主拍板 Ⓐ「相机拉近」）—— **相机距离**里那两个**只有本文件读写的**值
     （`joyZoomLevels` / `joyZoomPulling` 是 ref、模板与 `labRootClass` 都要，**仍归宿主**）：
       · `joyZoom0`     ：进近景那一刻的出发 zoom（回程的目标值，容差 **0** —— `joyZoom0 + 0` 逐位相等）；
       · `joyZoomApplied`：上一次**已经写进相机**的拉近量（判据：`zo` 没变 ⇒ 一次相机写点都不发）。 */
  let joyZoom0 = 0;
  let joyZoomApplied = 0;

  /* 🎯 2026-10-04 第四轮 **预走线**（机主："能给移动加预走线吗…动画要好看喵！"）—— 三个状态，各一处：
       · `joyAimOn`  ：这一帧该不该画（= 速度比例 > 0 且不是 low 档）。**翻转时才写一次 class**；
       · `joyAimK`   ：已经平滑过的线长比例 0..1（`joyAimStep` 按 `JOY_AIM_TAU_S` 收敛）；
       · `joyFaceDeg`：上一次**真的写进 DOM** 的朝向（0.1° 死区）—— `face` 与预走线容器**共用**这一份
                      （两者表示同一个朝向，同一帧只会有一个在画）。 */
  let joyAimOn = false;
  let joyAimK = 0;
  let joyFaceDeg = NaN;

  function joyReportCam(): void {
    const map = mapNow();
    const m = map as unknown as {
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
    } | null;
    if (!m || !joyOrigin || !joyScale || typeof m.getCenter !== "function") {
      joyViewScale = 1;
      joySetCam(NaN, NaN, 1);
      return;
    }
    let vs = 1;
    try {
      const z = typeof m.getZoom === "function" ? Number(m.getZoom()) : NaN;
      /* `joyZoom0 > 0` 是"出发 zoom 量到过"的标志（量不到时它恒 0 ⇒ 不敢拿它当基准） */
      if (Number.isFinite(z) && joyZoom0 > 0) vs = joyPanScaleOf(z - joyZoom0);
    } catch {
      vs = 1;
    }
    joyViewScale = vs;
    try {
      const c = m.getCenter();
      const p = joyScreenOf(joyOrigin, joyScale, c.lng, c.lat);
      if (p) joySetCam(p.x, p.y, vs);
      else joySetCam(NaN, NaN, vs);
    } catch {
      joySetCam(NaN, NaN, vs);
    }
  }
  /** 当前相机 bearing（**属性读**，不是 `project`、不触发布局）；读不到就沿用标定值 */
  function joyReadBearing(): number {
    const map = mapNow();
    const m = map as unknown as { getBearing?: () => number } | null;
    try {
      const b = m && typeof m.getBearing === "function" ? Number(m.getBearing()) : NaN;
      return Number.isFinite(b) ? b : joyBearing0;
    } catch {
      return joyBearing0;
    }
  }
  /* 🕹🆕 2026-10-03 第二轮（机主：「视角无法锁定角色，**位移很大**喵！！！」）—— **世界尺度**两个数，
     各只有一处来源，都由 `joyCalibrate()` 量一次后传给摇杆组件（它自己一行换算都不写）：
       · `joyMpp`      ：米/像素 —— 用本组件**既有那把唯一的尺子** `bldMetersPerCssPixel(zoom, lat)`
                        （与挑楼/楼高同一把，见本文件 `metersPerPixel` 那处调用）；**不新增第二份换算**。
                        ⚠️ 它不带俯角压缩（64° 时竖直方向的地面尺度差约 1/sin64° ≈ 11%）——
                          与世界速度的口径误差就这么多，写在这里免得下一个人以为是 bug。
       · `joySpeedMps` ：满推速度（**米/秒**）—— `joySpeedMpsOf(zoom)` 选档（步行/载具）。
                        🔴 上一版速度按"屏宽/秒"给 ⇒ 这一档的 1024px 屏上等于 **967 m/s**（瞬移）。
     量不到（没有 getZoom/getCenter）⇒ 两个数留 0 ⇒ 推杆无效：**宁可不走，也不编一个世界速度**。
     ⚠️ 这两个 ref **仍归宿主**（模板 `:mpp` / `:speed-mps` 直接吃它们）⇒ 这里经 ctx 读写。 */

  /* 🕹🆕 2026-10-03 第三轮：**相机距离**那四个值的说明见文件头与本段上方
     （`joyZoomLevels` / `joyZoomPulling` 两个 ref 留在宿主，`joyZoom0` / `joyZoomApplied` 在本文件）。 */

  /**
   * 量**两把尺子**（整条链路只有这一处换算，共 3 次投影调用 + 1 次 `bldMetersPerCssPixel`）：
   *   ① **屏幕 px → 经纬度**（局部雅可比）：四个数**全部**来自地图库自己的 `project`/`unproject`
   *      —— 我们一行投影数学都不写（既有红线）。量的是**相机中心**处的雅可比，纯平移下不变。
   *   ② 🆕 **米/像素 + 速度档**（世界尺度，交给摇杆组件）：`bldMetersPerCssPixel(zoom, lat)` +
   *      `joySpeedMpsOf(zoom)` —— 只读 `getCenter`/`getZoom`，与 ① 相互独立（① 失败也能量出 ②）。
   * 🔴 **移动中 0 次**：本函数只在"进近景"（`joyEnter`）与建图那一刻被调，**帧里一次都不调**。
   * 量不齐 ①（库没这俩方法 / 抛错 / 非有限 / 全 0）⇒ `null`：**角色不动、只有相机走**
   * （宁可退回旧行为，也不写一个编出来的经纬度）；量不齐 ② ⇒ 推杆无效（不编世界速度）。
   */
  function joyCalibrate(): void {
    const map = mapNow();
    joyScale = null;
    /* 🎥 §16 相机真值先作废（报"不知道"）：下面重新量到标尺之前，任何旧读数都是**上一台相机**的。
       量不到就一直是 `NaN` ⇒ 模型走开环旧行为（与"量不到尺子就站住"同一条纪律）。 */
    joySetCam(NaN, NaN, 1);
    /* 🕹 相机距离那一路也**从这里归零**：量不到出发 zoom ⇒ `joyZoomLevels = 0` ⇒ 摇杆只平移、不拉近
       （拉近量的真源由此处一处决定；`joyZoomApplied`/隐藏态跟着复位，避免拿上一台相机的状态接着用）。 */
    joyZoomLevels.value = 0;
    joyZoom0 = 0;
    joyZoomApplied = 0;
    joyZoomPulling.value = false;
    const m = map as unknown as {
      project?: (c: [number, number]) => { x: number; y: number };
      unproject?: (p: [number, number]) => { lng: number; lat: number };
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
      getBearing?: () => number;
      getPitch?: () => number;
    } | null;
    if (!m || typeof m.getCenter !== "function") return;
    /* 🕹 **世界尺度**先量（只用到 getCenter/getZoom，**不依赖** project/unproject）：
       量得到 ⇒ 即使下面那把 px→经纬度的标尺量不出来（角色不动），**相机照样按真实米/秒走**
       （"宁可退回旧行为"那条降级路仍然成立）。 */
    try {
      const c0 = m.getCenter();
      const z0 = typeof m.getZoom === "function" ? m.getZoom() : NaN;
      joyMpp.value = bldMetersPerCssPixel(z0, c0.lat);
      joySpeedMps.value = joySpeedMpsOf(z0);
      /* 🕹 出发 zoom 量到了才**武装**拉近那条路（`JOY_ZOOM_PUSH_LEVELS` 是 policy，数值在 wsJoystick.ts 一处）；
         `z0` 非有限 ⇒ 两个数都留 0/关 —— 与"不编世界速度"同一条纪律。 */
      if (Number.isFinite(z0)) {
        joyZoom0 = z0;
        joyZoomLevels.value = JOY_ZOOM_PUSH_LEVELS;
      }
    } catch {
      joyMpp.value = 0;
    }
    /* 🧭 §13/§14：**参考系**（屏幕向量 ⇄ 世界方向的唯一换算处，纯函数模块）交给模型：
       · `bearing0` = 标尺架在哪个朝向（下面那把 px→经纬度的雅可比就是**此刻**的相机量的）；
       · `depthGain` = `1/cos(pitch)`（俯角带来的竖直压缩，§14）——「往上推」的屏幕速度要按它收，
         否则世界里会走出 2.28 倍的速度（旧行为）。
       ⚠️ 量不到就如实退回 (0, 1) = "当作没转过、俯角 0 压缩"（与 mpp 那条"不编数"同一条纪律）。 */
    try {
      const b0 = typeof m.getBearing === "function" ? Number(m.getBearing()) : 0;
      const p0 = typeof m.getPitch === "function" ? Number(m.getPitch()) : JOY_PITCH_DEG;
      joyBearing0 = Number.isFinite(b0) ? b0 : 0;
      joyDepthGain = joyDepthGainOf(p0);
      joySetFrame({ bearing0: joyBearing0, bearingNow: joyBearing0 }, joyDepthGain);
    } catch {
      joyBearing0 = 0;
      joyDepthGain = 1;
      joySetFrame(null, 1);
    }
    if (typeof m.project !== "function" || typeof m.unproject !== "function") return;
    try {
      const c = m.getCenter();
      const p0 = m.project([c.lng, c.lat]);
      const px = m.unproject([p0.x + 1, p0.y]);
      const py = m.unproject([p0.x, p0.y + 1]);
      const s = joyPxScaleOf({
        dxLng: px.lng - c.lng,
        dxLat: px.lat - c.lat,
        dyLng: py.lng - c.lng,
        dyLat: py.lat - c.lat,
      });
      if (!s) return;
      joyOrigin = { lng: c.lng, lat: c.lat };
      joyScale = s;
      joyMove = createJoyMotion();
    } catch {
      joyScale = null;
    }
    /* 🎥 §16 标定完成 ⇒ 立刻报一次**相机真值**：`joyOrigin` 就是这一刻的相机中心 ⇒ 真值是 (0,0)
       （`vs` 也由这一处一并量出来 = `2^(z0 − z0)` = 1）。此前一律是 `NaN`（"不知道"），
       模型那时走的是开环旧路 —— 与"量不到尺子就站住"同一条纪律。 */
    joyReportCam();
  }

  /**
   * 🕹 每帧**至多一次**：把运动模型算出来的**世界坐标**写进漫游真源，并驱动「我」那颗钉子。
   * 写点一共 3 个，**全是 `setLngLat` / `transform`，没有一个布局属性**：
   *   ① `Marker.setLngLat` —— "角色真的在动"就是这一行（§3：角色走世界坐标，相机另算，两者不再重合）；
   *   ② 朝向箭头 `rotate`（§4：朝向跟随移动方向，`headingDeg` 由**速度方向**算出）；
   *   ③ 身体踏步 `translate3d`（§4：就地行走动画 —— 位移归世界坐标、摆动归 transform；
   *      幅度 ∝ 速度 ⇒ 停下时 `speedRatio = 0` ⇒ 恒等变换 ⇒ **自动回正**，不用再补一帧）。
   * ⚠️ 诚实记一笔：`Marker.setLngLat()` 内部会自己 `project` 一次（**引擎自己的**，不是我们写的投影数学，
   *    而且只涉及这一个 marker）。既有红线"移动中 0 次 `map.project()`"指的是**我们的代码**不许调 ——
   *    这条仍然成立（自检 ⑩k3 钉着）。
   */
  function joyApplyRoam(mv: JoyMotion): void {
    if (!joyOrigin || !joyScale) return;
    const w = joyLngLatOf(joyOrigin, joyScale, mv.px, mv.py);
    roamStore.write(w.lng, w.lat, mv.headingDeg);
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    if (!pin) return; // 名单里还没有「我」⇒ 位置已经在真源里了，钉子出来时 `syncPins` 会照它摆
    try {
      pin.mk.setLngLat([w.lng, w.lat]);
    } catch {
      /* 地图拆了就算了（这一帧白写，不抛） */
    }
    /* 朝向：**只在"不在画预走线"时写**（预走线亮着时箭头是藏起来的 —— 写它等于白发一次）。
       另加 **0.1° 死区**：直着走时 `headingDeg` 只会在浮点尾巴上抖，四舍五入到 0.1° 后大多数帧
       根本没有变化 ⇒ 这些帧从"每帧 1 个写点"变成 0 个（写点预算里那个"最坏 8 / 稳态 5"就是这么来的）。 */
    if (pin.face && !joyAimOn) {
      /* 🧭 §13：`mv.headingDeg` 是**世界（罗盘）朝向** —— 画在屏幕上要减掉当前 bearing（唯一换算处） */
      const deg = Number(joyScreenHeadingOf(mv.headingDeg, joyBearingNowOf()).toFixed(1));
      if (deg !== joyFaceDeg) {
        joyFaceDeg = deg;
        pin.face.style.transform = `rotate(${deg}deg)`;
      }
    }
    /* 踏步（§4：就地行走）：**一步一个起落**，不是一步两个。
       🔴 2026-10-04 第四轮消抖（机主「移动时很诡异，一直在抖」）—— 旧写法是
       `-|sin(stepPhase·2π)| × a`：`|sin|` 每个相位周期有**两个**波峰，而 `stepPhase` 的单位是**步**
       （`JOY_STEP_HZ = 2.2` 步/秒）⇒ 那个"踏步"实际是 **4.4 次/秒的上下振**（研究 §11.2 的反面教材：
       被相机跟随的角色身上，任何周期性位移都会被看成抖）。
       现在用 `sin²(π·stepPhase)`：一个相位=**一个**起落（2.2 次/秒，人走路的量级），
       而且 `sin²` 在触地那一点是 C¹ 连续的（`|sin|` 在那里有个折点，看着像"顿一下"）。
       幅度仍是 `speedRatio × JOY_STEP_PX`（停下 ⇒ 0 ⇒ 恒等变换 ⇒ 自动回正，一个字没改）。 */
    if (pin.body && joyWalkAnimOn({ low: !!perf.low.value, reduced: joyReducedMotion })) {
      const a = mv.speedRatio * JOY_STEP_PX;
      const bob = Math.sin(mv.stepPhase * Math.PI) ** 2;
      pin.body.style.transform = a > 0 ? `translate3d(0, ${(-bob * a).toFixed(2)}px, 0)` : "";
    }
  }

  /**
   * 🎯 **预走线那一帧的两个写点**（机主："预走线 + 指向移动方向的箭头，动画要好看"）。
   *
   * 写点**恰好 2 个**（与 `JOY_AIM_WRITES_MAX` 对齐；都在**钉子自己的 DOM** 里）：
   *   ① 虚线 `scaleX`（线长 ÷ 满长）——**只动 transform**，不碰 `width`；
   *   ② 箭头 `translate3d(线长, 0, 0)`——同样只动 transform。
   * 容器那次 `rotate` 是**第三个**、但带 0.1° 死区（角度没变就一次都不写）；
   * `opacity` **一次都不写**：显隐是 `is-aim` class 翻转 + CSS 过渡（见文件末尾全局样式）。
   *
   * ⚠️ 为什么回中段（`phase === "center"`）也允许写这两个数：**线必须收回去**，
   *    否则松手那一瞬它会长在半路"僵住"（`speedRatio` 在 `release()` 里当场归零，
   *    线长的收敛只能靠模型按 `JOY_AIM_TAU_S` 走完）。所以回中段的角色写点**只有这 2 个**：
   *    `setLngLat` / 真源 `roamStore.write` / `project` 三者仍然是 **0 次**（自检 ⑩e3/⑩e4 分别钉）。
   */
  function joyAimWrite(pin: { el: HTMLElement; aim: HTMLElement | null; dash: HTMLElement | null; tip: HTMLElement | null; face: HTMLElement | null } | undefined, mv: JoyMotion | undefined, dtMs: number): void {
    if (!pin?.aim || !pin.dash || !pin.tip) return;
    const mode = joyAimModeOf({ low: !!perf.low.value, reduced: joyReducedMotion });
    /* ① 该不该画：`off`（low 档）⇒ 一次都不画；速度恰好 0（松手/停稳）⇒ 收线不再起新的 */
    const want = mode !== "off" && !!mv && Number.isFinite(mv.speedRatio) && mv.speedRatio > 0;
    if (want !== joyAimOn) {
      joyAimOn = want;
      /* **一次 class 写**（状态翻转那一帧）：CSS 过渡负责淡入 140ms / 淡出 320ms（ease-out，研究 §12.3）。
         起新的一段时把平滑量**归零**：上一段末尾可能冻在 20% 上（那一帧之后 rAF 链就断了），
         不归零的话线会"啪"地从 20% 开始长。 */
      pin.el.classList.toggle("is-aim", want);
      if (want) joyAimK = 0;
      /* 🎯 起新一段时把角度死区**作废**（`NaN` ⇒ 下一帧必写）：上一段的容器角度停在收线那一刻，
         若这一段的方向恰好相同，`deg !== joyFaceDeg` 会判"没变"而**一次都不写** ——
         线就会带着上一段的旧角亮起来（0.1° 死区那个共用变量带来的唯一副作用，这里堵掉）。 */
      if (want) joyFaceDeg = NaN;
      /* 收线那一帧把**朝向箭头补到当前朝向**：预走线亮着的时候箭头是被 CSS 藏起来的
         （`[data-ws-roam-pin].is-aim [data-ws-roam-face]` 那条），而箭头自己的 `rotate` 在
         预走线期间**故意不写**（省一个写点）。不补这一下，松手后箭头会停在上一次写进去的旧角度上。 */
      else joyFaceSync(pin, mv ? mv.headingDeg : NaN);
    }
    if (mode === "off") return;
    if (!joyAimOn && joyAimK <= 0) return; // 收干净了 ⇒ 这一帧 0 个写点（不再空写）
    const f = joyAimStep(joyAimK, mv ? mv.speedRatio : 0, dtMs);
    joyAimK = f.k;
    pin.dash.style.transform = `translate3d(0, 0, 0) scaleX(${f.scaleX.toFixed(4)})`;
    pin.tip.style.transform = `translate3d(${f.tipPx.toFixed(2)}px, 0, 0)`;
    /* ③ 容器：只吃 rotate（角度死区 0.1°）。为什么和 `pin.face` 共用 `joyFaceDeg`：
       两者表示的是**同一个朝向**，同一帧只会有一个在画 —— 共用一份就少一次 `toFixed` 与一次比较。 */
    if (mode === "full" || mode === "static") {
      /* 🧭 §13：`headingDeg` 是**世界（罗盘）朝向** ⇒ 先换成**当前屏幕**角（`joyFaceDeg` 存的就是
         这个口径，与朝向箭头共用一份）。
         🎯 §13.4：预走线容器是**沿 `+x`（右）画的**（`.ws-aim__dash` 从 `left:17px` 起、箭头
         `clip-path` 朝 +x），而 `rotate(θ)` 把 `+x` 转到屏幕角 θ ⇒ 要它指向 `h` 就得写 `h - 90`。
         这一处就是那个 `-90`（`joyAimRotateDegOf`）。**朝向箭头不减**（它是沿 `-y` 画的）——
         两个元素本来就该用两个式子，这也是"线、箭头、真实位移"从此同一个角的全部代价。 */
      const deg = Number(joyScreenHeadingOf(mv ? mv.headingDeg : 0, joyBearingNowOf()).toFixed(1));
      if (deg !== joyFaceDeg) {
        joyFaceDeg = deg;
        pin.aim.style.transform = `rotate(${joyAimRotateDegOf(deg)}deg)`;
      }
    }
  }
  /**
   * 朝向箭头的**补写**（唯一一处）：只在"预走线收线那一帧"与"收尾 `joyAimReset`"两处调。
   * 为什么需要它：预走线亮着时箭头被 CSS 藏着，而它的 `rotate` 在那一整段里**故意不写**
   * （省一个每帧写点）—— 收线时若不补，箭头会停在上一次写进 DOM 的**旧角度**上（人是停下了，
   * 朝向就是他最后走的方向，不该是一个更早的方向）。
   */
  function joyFaceSync(pin: { face: HTMLElement | null } | undefined, headingDeg: number): void {
    if (!pin?.face || !Number.isFinite(headingDeg)) return;
    /* 🧭 §13：调用方原样传的是 `mv.headingDeg`（**世界**朝向）⇒ 这里换成当前**屏幕**角再写 */
    joyFaceDeg = Number(joyScreenHeadingOf(headingDeg, joyBearingNowOf()).toFixed(1));
    pin.face.style.transform = `rotate(${joyFaceDeg}deg)`;
  }
  /** 🎯 把预走线收干净（**幂等**）：class 摘掉 + 平滑量归零 + 朝向补写。`onJoyHalt`/`joyExit` 都会调一次 —— 保证"线不会僵住" */
  function joyAimReset(): void {
    const wasAiming = joyAimOn;
    joyAimOn = false;
    joyAimK = 0;
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    pin?.el.classList.remove("is-aim");
    /* 只有"刚才真的在画"才补写箭头（否则就是一次白写：箭头本来就是那个角度） */
    if (wasAiming) joyFaceSync(pin, joyMove.headingDeg);
  }

  /**
   * 「我」钉子上那两处漫游写点回**恒等**。
   * `clearHeading = false`（松手）：只收踏步 —— 人是停下了，不是转回正北；
   * `clearHeading = true`（关掉摇杆）：朝向也回正 —— 一切还原，与"相机逐字还原"同一条纪律。
   */
  function joyPinReset(clearHeading: boolean): void {
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    if (pin?.body) pin.body.style.transform = "";
    if (pin?.dash) pin.dash.style.transform = "";
    if (pin?.tip) pin.tip.style.transform = "";
    joyAimReset(); // 🎯 预走线也一并收（class 摘掉 + 平滑量归零；幂等）
    if (clearHeading && pin?.face) pin.face.style.transform = "";
    if (clearHeading && pin?.aim) pin.aim.style.transform = "";
  }

  /** 读当前相机 → 快照（缺值给 null；宿主不许在没快照时动相机） */
  function joyReadCam(): JoyCamSnapshot | null {
    const map = mapNow();
    const m = map as unknown as {
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
      getPitch?: () => number;
      getBearing?: () => number;
    } | null;
    if (!m) return null;
    try {
      return joyCamSnapshotOf({
        center: typeof m.getCenter === "function" ? m.getCenter() : null,
        zoom: typeof m.getZoom === "function" ? m.getZoom() : NaN,
        pitch: typeof m.getPitch === "function" ? m.getPitch() : NaN,
        bearing: typeof m.getBearing === "function" ? m.getBearing() : NaN,
      });
    } catch {
      return null;
    }
  }

  /**
   * 打开（面板开关 / 启动时就是开）：记下接管前的相机 → 进近景（只改俯角）→ 量标尺 →
   * 位置真源与「我」一起落到现在这个中心。
   * 🔴 `joyCalibrate()` 必须排在**改完俯角之后**：俯角不同，同一个屏幕 px 对应的地面距离差好几倍
   *    （38° 与 64° 量的标尺不是一回事）。
   */
  function joyEnter(): void {
    const map = mapNow();
    const m = map as unknown as { jumpTo?: (o: unknown) => void } | null;
    if (joyPrevCam || !m) return; // 幂等：已经在近景里就什么都不做
    joyPrevCam = joyReadCam();
    try {
      /* **只改俯角**（中心/zoom/bearing 一个字不动）——"进近景"= 抬头看这座城市，不是把镜头搬走 */
      if (typeof m.jumpTo === "function") m.jumpTo({ pitch: JOY_PITCH_DEG, duration: 0 });
    } catch {
      /* 相机收不了就当没进近景；摇杆照常能推（推的还是 panBy，不依赖俯角） */
    }
    joyCalibrate();
    /* 位置真源 = 原点（相机中心）；`joyApplyRoam(joyMove)` 用的是刚归零的运动状态 ⇒
       「我」**立刻**站到画面中心 —— 进近景就看得见自己，不是推一下才冒出来。 */
    if (joyOrigin) roamStore.write(joyOrigin.lng, joyOrigin.lat, joyMove.headingDeg);
    joyApplyRoam(joyMove);
  }

  /**
   * 关闭（面板开关关掉 / 2D 降级把摇杆收走）：先收尾 → **相机逐字还原** → 位置真源清空。幂等。
   * ⚠️ 顺序不能反：先 `onJoyHalt()`（把这次按压的容器位移烘进节点坐标、并做那**一次**重算），
   *    再 `jumpTo` 还原 —— 否则还原那一跳会作用在一层还没对齐的标签上（就是机主报过的"错位"）。
   */
  function joyExit(): void {
    const map = mapNow();
    if (joyActiveNow()) onJoyHalt();
    const args = joyCamRestoreArgs(joyPrevCam);
    joyPrevCam = null;
    roamStore.clear();
    /* 🕹 会话状态**清干净**（2026-10-03 新增的三个值 + 钉子上的朝向/踏步）：
       不清 `joyOrigin`/`joyScale` 的话，下一次打开会拿着**上一台相机**的标尺算世界坐标
       （俯角/缩放早变了）—— 那正是"编出来的坐标"；不清朝向的话，箭头会停在最后一次的方向上。 */
    joyOrigin = null;
    joyScale = null;
    joyMove = createJoyMotion();
    joyAccX = 0;
    joyAccY = 0;
    /* 🕹🧱 走路补刷新的那两个计数（米数 / 时间）也一并清掉（与 `joyAccX/joyAccY` 同一类残留：
       留着一个"走了一半"的米数，下一次打开时按下的那一帧会被它接走 —— 虽然按下那一刻还会重置，
       但这里清干净更省心）。 */
    joyFlushMovedM = 0;
    joyFlushElapsedMs = 0;
    /* 🕹 相机距离这四个值一个都不能留：留 `joyZoom0` 会拿着**上一台相机**的出发 zoom 去还原
       （与"不清标尺"同一类错误），留 `joyZoomPulling` 会让名字层一直藏着。
       `joyZoomLevels` 交给下一次 `joyCalibrate()` 重新武装（它开头就把四个值全归零）。 */
    joyZoomLevels.value = 0;
    joyZoom0 = 0;
    joyZoomApplied = 0;
    joyZoomPulling.value = false;
    /* 🎥 §16 相机真值也清掉（报"不知道"）：留着上一台相机的数，下一次开摇杆会拿着它去纠偏
       —— 与"不清标尺""不清出发 zoom"是同一类错误（宁可回到开环，也不拿旧读数当真值）。 */
    joyViewScale = 1;
    joySetCam(NaN, NaN, 1);
    joyPinReset(true);
    /* 「我」回到名单里的网格位置：真源已清空 ⇒ `syncPins` 走的是常规那一路（含吸附） */
    syncPins();
    if (!args) return; // 没快照 ⇒ **一次相机都不动**（绝不编一个"原来的机位"）
    try {
      (map as unknown as { jumpTo?: (o: unknown) => void } | null)?.jumpTo?.(args);
    } catch {
      /* 还原失败也不抛：位置真源已经清掉，功能上等于"回到默认路" */
    }
  }

  /** 名字层跟手：**只写 1 个容器**（O(1)），节点一个字都不写 */
  function joyNamesFollow(): void {
    const el = labRootEl.value;
    if (!el) return;
    el.style.transform = `translate3d(${(-joyAccX).toFixed(2)}px, ${(-joyAccY).toFixed(2)}px, 0)`;
  }

  /** 每帧**至多一次**（来自摇杆组件那唯一一个 rAF）；`mv` = 这一步的运动状态（角色那一半），
   *  `phase` = `"push"`（推着/滑行）或 `"center"`（**松手后的回中段**：角色已停稳，只有相机在贴回角色）。 */
  function onJoyDrive(d: { dx: number; dy: number }, _v?: unknown, mv?: JoyMotion, phase?: JoyFramePhase, dtMs = 0): void {
    const map = mapNow();
    const m = map as unknown as {
      panBy?: (o: [number, number], opt?: { duration: number }) => void;
      easeTo?: (o: Record<string, unknown>) => void;
    } | null;
    if (!aliveNow() || !m || typeof m.panBy !== "function") return;
    /* 🧭 §13：每帧**只报一个数**（相机 bearing）——属性读，0 次 `project`、0 次布局读。
       用户转过地图之后，"屏幕上往上推"对应的世界方向变了；不报这一下，模型就还按标定那一刻算。 */
    joySetBearingNow(joyReadBearing());
    /* 🔴 两条路**分开判**（2026-10-03 第二轮）：世界速度下相机头 ~2 秒会被死区按在原地
       （满推 8.8 px/s），那几帧 `d = {0,0}` 但**角色已经在走** ⇒ 相机那一半要跳过、
       角色那一半照写。老代码把两者绑在"相机位移非 0"上，于是那 2 秒里钉子一动不动。 */
    const camMoved = !!(d.dx || d.dy);
    /* 🕹 相机距离（研究 §9；机主拍板 Ⓐ 拉近）：`zo` = 运动模型算出来的"已拉近几级"（松手后回 0）。
       它跟 `camMoved` **不是一回事**：拉近从第一帧就开始改相机，而死区让 `panBy` 头 ~2.3 秒一动不动
       ⇒ 接管标志（`joyActive`）必须**两条都算**，否则那 2.3 秒里 `easeTo` 引发的
       `movestart/move/moveend/zoomend` 全部不会早退，每帧都走一遍常规重投影/取包
       （判据 3/6 的红线；`zoomend` 那一支是这一轮**必须补**的早退，见它的注释）。 */
    const zoomArmed = joyZoomLevels.value > 0;
    const zo = zoomArmed && mv && Number.isFinite(mv.zo) ? mv.zo : 0;
    const zoomMoved = zo !== joyZoomApplied;
    if ((camMoved || zoomMoved) && !joyActiveNow()) {
      /* 进入：**一次 class**（与既有 `movestart` 同一套 `is-camera-moving`，整层淡到 0.25）+
         累计位移归零。`panAnchor` 保持 null ⇒ 后面那几个 handler 早退也不会有人误用旧锚点。
         ⚠️ 归零是**必须**的：上一次收尾时 `onMoveEndNames()` 已经把位移烘进节点坐标了，
         这里不归零就是把同一段位移**再叠一次**（名字层越推越偏）。
         ⚠️ 只在**相机真的动**这一刻置位：相机没动的那些帧不置位 ⇒ 收尾也不必白跑一次取包
         （那一次重算是给"画面位移"擦屁股的，画面没位移就没有屁股要擦）。
         🕹 回中段也会走到这里（`joyActive` 那时仍为 true —— `onHalt` 要等相机停稳才发）⇒
         名字层照旧跟手，回中那点位移（~17px）也一并被烘进去，不会留一条错位的缝。 */
      setJoyActive(true);
      joyAccX = 0;
      joyAccY = 0;
      /* 🕹🧱 补刷新的那四个数也从**这一刻**起算（与 `joyAccX/joyAccY` 同一次按下的口径）：
         "上一次刷新" = 按下那一刻 ⇒ 第一次补刷新最早也在 600ms 之后、而且必须走够 100m。
         `mv` 在相机真的动了的这一帧一定有（驱动每帧都传）；量不到就按 0 起算 —— 只用差值，不影响。 */
      joyFlushMovedM = 0;
      joyFlushElapsedMs = 0;
      joyFlushPx = mv ? mv.px : 0;
      joyFlushPy = mv ? mv.py : 0;
      /* 整层淡化只跟**真的平移**走：拉近期间名字层本来就整层隐藏（§9.6），没必要再叠一层淡化 */
      if (camMoved) cameraMoving.value = true;
    }
    /* 🕹🆕 **相机距离写点**（唯一一处；`zo` 与上一次相同 ⇒ **一次都不发** —— 常态每帧都是这一支）：
       走的是**既有相机通路** `easeTo`（与 `panBy` 同一族，库内处理映射），**一行投影数学都不写**。
       `duration: 0` 与 `panBy({duration:0})` 同口径：平滑已经由 `joyMotionStep` 的指数逼近做完了
       （研究 §9 的 τ=0.5s 拉近 / 复用 `JOY_RECENTER_TAU_S` 回程），这里只负责"把这一刻的值落到相机上"。
       🔴 `joyZoom0 + 0` 逐位等于出发 zoom ⇒ 回程结束时相机距离**恰好**回到进近景那一刻。 */
    if (zoomMoved) {
      joyZoomApplied = zo;
      if (typeof m.easeTo === "function") {
        try {
          m.easeTo({ zoom: joyZoom0 + zo, duration: 0 });
        } catch {
          /* 相机收不了就当这一帧没拉（下一帧还会再试）；平移那一路照旧 */
        }
      }
    }
    /* 🕹 名字层：拉近期间**整层隐藏**（研究 §9.6 —— 标签坐标是按进近景那一档 zoom 投影的，
       容器只补 translate，zoom 一变就系统性错位）。🔴 **状态翻转才写一次**（不进每帧循环）。 */
    const hideNames = joyNamesHiddenOf(zo);
    if (hideNames !== joyZoomPulling.value) joyZoomPulling.value = hideNames;
    if (camMoved) {
      /* 🕹 像素换算（研究 §9.4；`joyPanScaleOf` 一个乘方，不碰投影）：角色的位移积分在**进近景那一档**
         的像素里（世界尺度冻结，红线），`panBy` 走的却是**当前**这一档 ⇒ 拉近 zo 级要乘 2^zo，
         否则相机按 2^zo 的倍率追不上角色，角色被甩到硬夹带边缘（= 上一版"视角无法锁定角色"）。
         累计位移（名字层跟手用）也按**实际写进相机的像素**记，收尾烘进节点坐标的才是真值。
         🎥 §16：这个倍率现在取自 `joyViewScale`（上一帧 `joyReportCam()` 量的**真实** zoom 差，
         含用户自己捏合进去的那几级）—— 与模型这一帧用的 `ctx.viewScale` **是同一个数**
         （模型拿的也是上一次报的）⇒ 两边不可能差一档。没有真值时它恒 1 ⇒ 逐位等于旧行为。 */
      const k = joyViewScale;
      m.panBy([d.dx * k, d.dy * k], { duration: 0 });
      joyAccX += d.dx * k;
      joyAccY += d.dy * k;
      joyNamesFollow();
    }
    /* 🎥 §16 **报相机真值**（每帧恰好一次，且在**所有**相机写点之后 —— 下一帧的模型看的就是它）：
       位置 = `getCenter()` 用标定那把尺子反解出来的标定档坐标；倍率 = 真实 zoom 差。
       量不到 ⇒ `NaN` ⇒ 模型回开环。这是"相机位置只有一个来源（地图自己）"的落地处。 */
    joyReportCam();
    /* 🆕 角色那一路（与相机**分成两件事**，§3）：世界坐标写进真源 + 钉子 `setLngLat` + 朝向 + 踏步。
       🔴 位置**不再**从 `getCenter()` 反写 —— 反写就等于"我 = 相机"，屏幕上的钉子永远不动
       （上一版"角色都没有动"的病根就在这一处）。
       🔴 **回中段一个角色写点都不发**（判据：`phase === "center"` ⇒ 0 次 `setLngLat` / 0 次
       `roamStore.write` / 0 次 `Marker.setLngLat` 内部那次 project）：那时角色已经停稳
       （`joyMotionStep` 的 `centering` 只在"没输入且速度恰好 0"时为真），发出去也只是把同一个
       坐标重写一遍 —— 而那正是"回中只许动相机"这句要求的可数形式。 */
    if (mv && phase !== "center") {
      joyMove = mv; // 留一份最新状态（这一份**不是**驱动的那份；只给"进来时先站到原点"用）
      joyApplyRoam(mv);
      /* 🕹🧱 **这一次按下以来角色走了多少米**（世界位移 → `joyMpp` 那把唯一的尺子 → 米）。
         `mv.px/py` 是角色在**标定档像素**里的位置（世界尺度冻结在那一档），`joyMpp` 正是
         "1 个标定档像素 = 多少米" ⇒ 两者相乘就是世界米数，**一次投影、一次 DOM 写都没有**。
         代价：每帧 3 个乘/加 + 1 个 `Math.sqrt`（见自检 ⑰ 的"每帧代价"那一组）。 */
      const fdx = mv.px - joyFlushPx;
      const fdy = mv.py - joyFlushPy;
      if (joyMpp.value > 0) joyFlushMovedM += Math.sqrt(fdx * fdx + fdy * fdy) * joyMpp.value;
      joyFlushPx = mv.px;
      joyFlushPy = mv.py;
      joyFlushElapsedMs += dtMs;
    }
    /* 🕹🧱 **受节流约束的那一次补刷新**（机主「走路时楼会不见」的正解；机制见 `joyFlushNow()`）：
       `joyFlushDue` 是**唯一**判定点 —— ≥100m **且** ≥600ms 才放行 ⇒ 常态每帧只做
       "读两个数 + 比大小"（0 次 `setData`、0 次重挑、0 次 DOM 写）。
       🔴 `joyActive === false` 时这一支不进：那条老路（`moveend`/`zoomend` 那几个 handler）
       一个字都没改 —— 相机没被摇杆接管时，刷新照旧归它们管。 */
    if (joyActiveNow() && joyFlushDue({ movedM: joyFlushMovedM, elapsedMs: joyFlushElapsedMs })) {
      joyFlushMovedM = 0;
      joyFlushElapsedMs = 0;
      joyFlushNow();
    }
    /* 🎯 预走线（**两个写点，两条路都要走**）：push 段跟着速度长出来；`center` 段只做一件事 ——
       **把线收回去**（`speedRatio` 在 `release()` 里当场归零，收敛只能由 `joyAimStep` 按 τ 走完）。
       🔴 它与上面那条"回中段 0 个角色写点"不冲突：那条红线管的是**角色的世界位置**
       （`setLngLat` / 真源 / 投影），而这里只写钉子内部两个**装饰性 transform**。
       判据在自检 ⑩e3（那三条仍是 0）+ ⑩e4（回中段的预走线写点 ≤ 2/帧，且结尾必须收到 0）。 */
    joyAimWrite(pins.find((p) => p.id === ROAM_PIN_ID), mv, dtMs);
  }

  /**
   * 🕹🧱 **摇杆期间的"边走边补"**（2026-10-04 第八轮；唯一入口 —— 每帧那个闸门在 `onJoyDrive` 末尾）。
   *
   * 为什么必须有它（机主原话：「在将屏幕**斜过来**时移动角色**楼会不见**，**反复放大缩小就好了**，
   * 在正常直接**竖直向下看时就不会**喵」）：摇杆驱动期间 `move`/`moveend` 整条"刷新包 + 落楼 + 名字"
   * 的路都被早退（`m.on("move", …)` 与 `m.on("moveend", …)` 那两句 `if (joyActive) return;`，
   * 理由见那两处注释），俯角 64° 下看得见的地面只有**一条窄带**
   * ⇒ 走几十米那批楼就滚出屏幕、而没有新的补进来；`zoomend` 仍会重挑一次（`bldTierCrossedFlush`）
   * ⇒ 所以"反复放大缩小就好了"。判据与常量在 `wsJoystick.joyFlushDue`（≥100m 且 ≥600ms）。
   *
   * 三件事，顺序不能反：
   *   ① **先把容器那份位移烘进节点坐标**（`onMoveEndNames()` 容器归零 + `reprojectNow()` 就地重投影）：
   *      名字层的节点坐标是**相对容器**的，而容器上正挂着这一段走过的位移；不先烘就重排名字，
   *      新算出来的坐标会与旧位移**叠加**一次 ⇒ 整层标签偏掉（机主报过的"名字错位"那一族）。
   *      烘完把累计位移归零，跟手从新基准接着累（`joyNamesFollow()` 每帧写的就是它）。
   *      ⚠️ `onMoveEndNames()` 会顺手清 `cameraMoving`（= 摘掉"相机在动"那层淡化）——摇杆还推着，
   *         所以同一个 tick 里立刻置回来：Vue 的 patch 在微任务里，**只落一次 DOM 结果、不闪**。
   *   ② **落楼**（`bldFlush("joy")` → 真源 `flushBldStore` → 按**当前**视野重挑一次）：这一发才是
   *      "楼会不见"的正解。`refreshBundles` **替代不了它**：格都取过时它在 `wsOfflineFeed` 里整轮早退
   *      （`if (!batch.length) return`）⇒ 光靠取包**不重挑楼**，屏上就一直是走路前那一批。
   *   ③ **取新格 + 重排名字**（与 `moveend` / `onJoyHalt` **同一条路**，不新写第二条）：
   *      `refreshBundles("joy")` → 完成后 `refreshNames("joy")`（新数据落地时 feed 自己会再落一次图）。
   *
   * 🔴 节流由调用方那一处判据保证（≥100m **且** ≥600ms）——本函数**不是**每帧调用的。
   * 🔴 冻结集 / 锚点一个都不清：走的是同一份 `wsBldPickStore`（`bldFlush` 里那套"只增不减"）。
   * 🔴 刷新函数名与 `moveend` 完全同一批三个，**没有**第二条刷新路（自检 ⑰ 钉着）。
   */
  function joyFlushNow(): void {
    if (!aliveNow()) return;
    /* ① 烘位移（口径与 `onJoyHalt` 的收尾逐字相同：容器归零 → 就地重投影） */
    const moved = joyAccX !== 0 || joyAccY !== 0;
    joyAccX = 0;
    joyAccY = 0;
    if (moved) {
      onMoveEndNames();
      reprojectNow();
      /* 摇杆还在推着 ⇒ "相机在动"这个状态照旧（同一个 tick，不产生一次闪烁） */
      cameraMoving.value = true;
    }
    /* ② 落楼：按当前视野重挑一次（仓库并集、冻结集、锚点一个都不动） */
    bldFlush("joy");
    /* ③ 取新格 → 重排名字（既有通路；新格落地时 feed 会自己再落一次图） */
    void refreshBundles("joy").then(() => (aliveNow() ? refreshNames("joy") : undefined));
  }

  /**
   * 收尾 —— **恰好一次**重算（判据 6：不是 0 次，也不是每帧 1 次）。
   *
   * 🔴 2026-10-03 第二轮**时点变了**：不再在手指抬起那一刻发，而是**相机回中跑完之后**才发
   * （`release()` → 回中段 → 相机贴回角色 → `onHalt`）。这样做有两个好处，都是一个原因：
   *   · 回中段里 `joyActive` **仍然为 true** ⇒ `panBy` 每帧引发的 `movestart/move/moveend`
   *     全部照旧早退，**回中期间 0 次重投影 / 0 次取包 / 0 次重排标签**（判据 ⑩e3 钉着）；
   *   · 那一次重算因此落在**画面已经停稳之后**，烘进节点坐标的位移是最终值 —— 不会留一条
   *     "重投影完了相机还在挪"的错位缝（机主报过的"名字错位/松手卡一下"就是这么来的）。
   *
   * 顺序照抄既有 `moveend`（同一个理由，见那里 2026-10-01 那段注释）：
   *   清标志 → 容器归零 → **就地重投影**（把这次位移烘进节点坐标）→ 一次取包 + 一次重排。
   * 🔴 那 600ms 去抖**不启动**（推送期间它一直没起过；收尾就直接跑一次，不再等）。
   */
  function onJoyHalt(): void {
    const map = mapNow();
    if (!joyActiveNow()) return;            // 没推过 ⇒ 不是"松手"，一次重算都不该有
    /* 🎯 预走线**紧跟着收干净**（幂等）：`halt` 是"每一次按压恰好一次"的收尾
       —— 正常路根本轮不到它干活（松手后第一帧 `phase="center"` 就把 class 摘了），
       它挡的是**病态路**：某一发按压短到松手后一帧都没投递
       （相机没动过、`zo` 也没动过），那时不在这里收，线就会**僵在半路**。
       放在守卫之后是**必须**的：这条判据钉着"没推过 ⇒ 一次重算都不做"（自检 ⑦）。 */
    joyAimReset();
    setJoyActive(false);
    /* 🕹🔴 **相机距离的保险丝**（研究 §9.5「松手后 zoom 回到出发值」的结构保证）：
       正常路走不到这里 —— 回中段的最后一帧会把 `zo` **恰好**写 0（`JOY_ZOOM_EPS_LEVELS` 那一跳），
       宿主那时就已经把相机 distance 放回 `joyZoom0`、名字层也跟着恢复，所以 `joyZoomApplied === 0`。
       只有病态路会命中：时钟被冻住 / rAF 反复给同一时间戳 ⇒ 回程被 `JOY_CENTER_MAX_FRAMES` 强收尾，
       `zo` 还停在半路。那时必须补一发，否则相机会**永久停在拉近后的距离**上、名字层也一直藏着。 */
    if (joyZoomApplied !== 0) {
      joyZoomApplied = 0;
      joyZoomPulling.value = false;
      const em = map as unknown as { easeTo?: (o: Record<string, unknown>) => void } | null;
      if (em && typeof em.easeTo === "function") {
        try {
          em.easeTo({ zoom: joyZoom0, duration: 0 });
        } catch {
          /* 相机收不了也不抛：`joyExit()` 的 `jumpTo(快照)` 兜底 */
        }
      }
    }
    const moved = joyAccX !== 0 || joyAccY !== 0;
    joyAccX = 0;
    joyAccY = 0;
    /* 🕹🧱 **补刷新的两个计数在这里复位**（"松手 = 上一次刷新翻篇"；下一次按下时 `onJoyDrive`
       还会再置一次 —— 这里复位是防"留在半路的值被下一次按下接走"）。
       ⚠️ 只动这两个计数：`joyMove`（跨按压保留的位置/朝向）一个字都不碰。 */
    joyFlushMovedM = 0;
    joyFlushElapsedMs = 0;
    /* 🕹🧱 **松手再刷一次**（"与既有松手补一次同口径"）：下面那条 `refreshBundles("joyhalt")`
       只会在**有新格**时落图（`wsOfflineFeed` 的 `if (!batch.length) return`）⇒ 停下来的这一屏
       可能一直停在走路中间那一批楼上。补一发 `bldFlush` 按**最终**视野重挑一次（同一条通路）。 */
    bldFlush("joyhalt");
    /* 🆕 停下即回正（§4）：踏步是 transform，不补这一下就会**停在"半抬腿"那一帧**上。
       朝向**不清**（人是停下了，不是转回正北）—— 关掉摇杆时才由 `joyExit()` 一并还原。
       角色位置也**不动**：速度在 `release()` 那一刻已经归零，松手后又不再跑帧 ⇒ 位置自然冻结。 */
    joyPinReset(false);
    if (!aliveNow()) return;
    if (moved) {
      onMoveEndNames();                // 容器归零（`cameraMoving=false` + 一次 transform 写）
      reprojectNow();                  // 重投影**只重投影、不重排**（O(N)，N ≤ 26）
    }
    /* 📍 **恰好一次**：摇杆推着的时候三个相机钩子全部早退（判据 3/6 的红线），
       屏外指示停在推杆前那一刻 —— 画面停稳之后在这里补一次（与名字层那一次重算同一个时点）。 */
    pinEdgeSync();
    if (bldTimerNow()) window.clearTimeout(bldTimerNow());
    setBldTimer(0);
    void refreshBundles("joyhalt").then(() => (aliveNow() ? refreshNames("joyhalt") : undefined));
  }

  return {
    joyCalibrate,
    joyApplyRoam,
    joyReadCam,
    joyEnter,
    joyExit,
    joyNamesFollow,
    onJoyDrive,
    onJoyHalt,
    joyFlushNow,
    /* 🕹 会话状态里那几个"宿主 `onMounted` 要读、`onBeforeUnmount` 要清"的出口（都是 `let`，
       没法按引用共享 ⇒ 走取值器/写入器；模板与两个 watch 用的那三个入口在上面）：
         · `joyPrevCam`：建图那段要填「没有摇杆时会落到的机位」；
         · `joyOrigin`/`joyScale`/`joyMove`：建图那段要判断"标尺量出来了没有"并把「我」摆到原点；
         · 卸载时那两个累计位移归零（`joyActive` 那面旗仍由宿主清）。 */
    prevCamNow: () => joyPrevCam,
    setPrevCam: (cam: JoyCamSnapshot | null): void => { joyPrevCam = cam; },
    originNow: () => joyOrigin,
    scaleNow: () => joyScale,
    moveNow: () => joyMove,
    resetAcc: (): void => { joyAccX = 0; joyAccY = 0; },
  };
}
