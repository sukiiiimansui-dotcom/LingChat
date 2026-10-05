/* wsMapCamera.ts —— M1：**相机 / 摇杆几何 / 手势兜底**（`PLAN-REFACTOR.md` §2.1 的 M1 / §3 的 S3）。
 *
 * ## 这个文件收什么
 * 从宿主 `WsDistrictMapLibre.vue` **整块搬出来**的那些"相机这一层"（锚点 = 函数名，不按行号）：
 *   · 近景那一套的几何：`joyGate`（分流**唯一判据**）/ `basePitch` / `joyVh` / `joyMeasureVh` /
 *     `initPitch` / `joyVars`（摇杆几何 → CSS 变量）
 *   · （S9b2 已删）相机动作：`zoomOnce`（150ms 节流）/ `fitDistrict`（全区）/ `zoomBy`（按钮缩放）
 *     —— 三个都没有调用点（模板里 `＋ / － / 全区` 三个按钮早已整块移除），S9b2 把那 42 行
 *     连同私有的 `lastZoomAt` 一起删掉（判据跟着改成"这三个名字在宿主 ∪ 模块里都不再定义"）
 *   · 名字层跟手：`onMoveStart` / `onMove` / `onMoveEndNames`（+ 它们私有的 `panAnchor`）
 *   · 浏览器手势兜底：`guardGestures` / `lockPageGestures` / `unlockPageGestures`（+ 私有的 `htmlTouchBackup`）
 *
 * ## 搬迁纪律（这一片**零行为变化**）
 * 搬迁 = **移动 + 加签名**：分支、阈值、调用顺序、DOM 契约**逐字不变**。所以下面每个函数体
 * 都是从宿主**逐字节**复制过来的（对拍闸 `ws_stage_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 为什么是 `createMapCamera(ctx)` 这个工厂
 * 这批函数闭包着宿主一堆 setup 期局部量（`props` / `show2d` / `bboxRef` / `stats` / `namesOn` /
 * `nameNodes` / `cameraMoving` / `labRootEl` / `host`）。改成"每次调用都传参"就要逐处改写成
 * `ctx.xxx` ⇒ 那就不是"只搬不改"了。⇒ 宿主构造只读 ctx 递进来，工厂在这里**解构一次**。
 *
 * ## 🔴 为什么 `map` 是**形参默认值**，而不是 ctx 里解构出来的字段
 * 宿主那份 `map` 是 `let`（建图时赋值、降级/卸载时置 null）⇒ 解构只会拿到**快照**，
 * 而这个工厂的装配点在建图**之前**（它要早于 `onMounted`，因为 `m.on("movestart", …)` 那些
 * 回调在挂载时就要接上）。所以：ctx 给的是**取值器** `mapNow()`，真正读它的那几个函数
 * 把形参默认值写成 `map = ctx.mapNow()` —— 默认值在**每次调用时**求值 ⇒ 读到的就是**当时**那个 map，
 * 与原实现读它的时刻完全一致（同一个同步点）。
 * ⚠️ 副作用是"签名行多一个形参"（§2.4 明确允许：搬迁 = 移动 + 加签名）；**函数体一个字都没动**。
 * ⚠️ 宿主调用点因此也一个字都不用改（`onMoveStart()` / `refreshBundles("joy")` 照旧）——
 *    这一点是硬要求：`ws_joystick_selftest` 的 ⑦/⑰ 用**逐字正则**钉着那几个调用点。
 *
 * ## 本片**没搬**的（照实留痕）
 * · `let unguard`（宿主 `onMounted` 里接、`onBeforeUnmount` 里摘）仍在宿主：它只存
 *   `guardGestures()` 的返回句柄，宿主是它唯一的消费者。
 * · 摇杆会话那条线（`joyActive` / `joyReadCam` / `joyEnter` / `joyExit` / `onJoyDrive` / `onJoyHalt`）
 *   属于 **M5**（§2.1 的 `wsJoystickStage.ts`），不在本片。
 * · （S9b2 已删）`zoomOnce` / `fitDistrict` / `zoomBy` + 私有的 `lastZoomAt`：S3 搬过来时就
 *   **没有任何调用点**（2026-10-04 实查：`grep -n` 全文件只有定义处 —— 模板里 `＋ / － / 全区`
 *   三个按钮早已整块移除）。2026-10-05 复核仍是零消费者 ⇒ 连同 return 里的三行一起删掉，
 *   本喵不留第二份壳：这里的判据（"搬走的名字全 stage 只定义一次"）跟着改成"这三个名字
 *   在宿主 ∪ 模块里一处定义都没有"。 */

import { computed, ref } from "vue";
import {
  JOY_HUD_LIFT_PX,
  JOY_INSET_PX,
  JOY_PITCH_DEG,
  joyBasePxOf,
  joyGateOf,
  joyThumbPxOf,
} from "./wsJoystick";
import { cameraDefaults } from "./wsScene";
import type { MapCameraCtx } from "./wsStageTypes";

/**
 * 装配相机/摇杆几何/手势这一层：宿主把只读 ctx 递进来，拿回全部函数。
 *
 * ⚠️ 调用点必须在 `show2d` / `host` / `bboxRef` / `stats` / `namesOn` / `nameNodes` /
 * `cameraMoving` / `labRootEl` 都声明之后（本片放在宿主 3800 行那一段：名字层的 ref 之后）：
 * 这些量是 `const`，声明前引用会踩 TDZ（本仓有过前科，不靠"函数是惰性的"兜）。
 */
export function createMapCamera(ctx: MapCameraCtx) {
  const { props, host, show2d, bboxRef, stats } = ctx;
  const { namesOn, nameNodes, cameraMoving, labRootEl } = ctx;

  /* ══ 🕹 **近景那一套**（摇杆 → 漫游位置 → 相机跟随；2026-10-03 机主裁决）══════════════
     事实口径先写清楚（免得后面有人当街景用）：这是**倾斜俯视的跟随** ——
     镜头中心 = 「我」的漫游位置、`pitch` = 64°、`bearing` = 朝向；**不是**眼睛高度的实景
     （MapLibre 给不出那种东西：地面是平面贴图、楼是挤出体）。

     分流只在一处（判据 9 / 10）：`joyGateOf()` 同时决定「DOM 里有没有摇杆」与「HUD 多写哪一句」：
       · `props.joy=false`（`?joy=0`）⇒ 不渲染 + **0 次相机更新**（组件都不在，没人建驱动）；
       · 2D 降级路 ⇒ 不渲染 + HUD 写「2D 降级路没有相机，摇杆不适用」（不静默消失）。
     ⚠️ 声明位置必须在 `show2d` 之后（上面那一行）：本文件对 TDZ 有过前科，不靠"computed 是惰性的"兜。 */
  const joyGate = computed(() => joyGateOf({ joy: !!props.joy, fallback2d: !!show2d.value }));
  /** **没有摇杆时**这一屏的俯角（= 改造前那个值；`props.pitch` 默认 38）—— 近景与"还原"都对着它 */
  const basePitch = computed(() => props.pitch || cameraDefaults().pitch);
  /**
   * 🕹 §15 容器高度（px）——底盘尺寸按它收（`16vh`）。只在挂载与 resize/转屏那一帧量一次，
   * **不进每帧循环**（读 `clientHeight` 是强制布局，红线）。
   */
  const joyVh = ref(0);
  function joyMeasureVh(): void {
    const h = host.value?.clientHeight || 0;
    if (h > 0 && h !== joyVh.value) joyVh.value = h;
  }
  /** 初始倾角：**只有 `joy === true` 才 64**（机主 2026-10-03：默认关**不许**有副作用 ⇒ 关着时逐字 38） */
  const initPitch = computed(() => (props.joy ? JOY_PITCH_DEG : basePitch.value));
  /** 摇杆几何 → CSS 变量（**唯一真源**是 `wsJoystick.ts` 的常量；组件与 HUD 都从这里继承） */
  const joyVars = computed<Record<string, string>>(() => {
    /* 🕹 §15：底盘**随容器高度收**（`16vh`，夹 [76,112]）—— 112px 在 581px 高的视口上占 19%，
       真机横屏更狠（1/4 屏）。三个数（底盘/杆头/让位高度）全部由**同一处**的纯函数算。 */
    const base = joyBasePxOf(joyVh.value);
    return {
      "--ws-joy-base": `${base}px`,
      "--ws-joy-thumb": `${joyThumbPxOf(base)}px`,
      "--ws-joy-inset": `${JOY_INSET_PX}px`,
      /* 让位高度：**无摇杆路 = 0px** ⇒ HUD 的 `calc(8px + var(--ws-joy-h))` 逐字回到 `bottom:8px`。
         ⚠️ 这一格**故意不跟着底盘缩**（判据 ② 逐字钉着 `JOY_HUD_LIFT_PX`，且"多让一点"无害：
         底盘变小只是让 HUD 与它之间多一条缝，不会压住）。 */
      "--ws-joy-h": joyGate.value.show ? `${JOY_HUD_LIFT_PX}px` : "0px",
    };
  });

  /* ── 跟手（§4.0）：相机运动期间**只写容器**；节点位置一个字都不写 ─────────────────
     算法：`movestart` 时记下"第一个节点的锚点此刻在屏幕上的位置"，
     之后每帧算它现在在哪 ⇒ 差值就是整层的位移（地图平移 = 全体标签同位移，所以这是**精确**的）。
     ⚠️ 只在**平移**（pan）时这么做；旋转/俯仰不是平移，那时整层淡到 0.25 就够（§4.2）。 */
  let panAnchor: { lng: number; lat: number; x: number; y: number } | null = null;
  function onMoveStart(map = ctx.mapNow()): void {
    if (!namesOn.value || !nameNodes.value.length) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    const n0 = nameNodes.value[0];
    if (!m?.project || !n0) return;
    const p = m.project([n0.lng, n0.lat]);
    if (!p) return;
    panAnchor = { lng: n0.lng, lat: n0.lat, x: p.x, y: p.y };
    cameraMoving.value = true;                           // 一次 class + 一次 opacity（**只写 1 个节点**）
  }
  function onMove(map = ctx.mapNow()): void {
    if (!panAnchor || !cameraMoving.value) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    if (!m?.project) return;
    const p = m.project([panAnchor.lng, panAnchor.lat]);
    const el = labRootEl.value;
    if (!p || !el) return;
    /* 🔴 一次 transform 写在一个容器上（O(1)），**不是** N 个节点 —— 这就是"不卡"的全部秘密 */
    el.style.transform = `translate3d(${(p.x - panAnchor.x).toFixed(2)}px, ${(p.y - panAnchor.y).toFixed(2)}px, 0)`;
  }
  function onMoveEndNames(): void {
    cameraMoving.value = false;
    panAnchor = null;
    const el = labRootEl.value;
    if (el) el.style.transform = "translate3d(0, 0, 0)";   // 节点自身已经是新位置 ⇒ 容器归零
  }

  /* ── 浏览器手势兜底（CSS 之外的保险）─────────────────────────────────────
     机主实测：即使 `.ws-dml` 上写了 `touch-action: none`，浏览器仍然把滑动当成页面手势
     （Via / 部分国产内核会忽略 touch-action，或抢的是"边缘返回手势"）。
     所以这里在 **JS 层再拦一次**：`touchmove` 一律 preventDefault（被动监听是拦不住的，
     必须 `{ passive: false }`），多指 `touchstart` 也拦。注意 preventDefault **不会**
     阻止地图库自己的监听器 —— 它只掐掉浏览器的默认行为。 */
  function guardGestures(el: HTMLElement): () => void {
    const onMove = (e: TouchEvent): void => {
      if (e.cancelable) e.preventDefault();
    };
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchstart", onStart, { passive: false });
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchstart", onStart);
    };
  }

  /* ── 页面级手势封锁（机主诊断：滑动不足 0.3 秒就被浏览器捕获）────────────────
     这条现象说明：触摸**开始时确实到了地图**，但滑到约 300ms 时被**浏览器页面级手势**
     （侧滑返回 / 页面滚动 / 下拉刷新）判走了。只在地图元素上写 `touch-action` 挡不住它
     —— 必须在**根元素**上临时声明"这一屏不做任何页面手势"，否则浏览器的手势识别器
     照样在系统层抢先。离开小区级时**原样还原**（别污染其它页面）。 */
  let htmlTouchBackup: { touchAction: string; overscroll: string; overflow: string } | null = null;
  function lockPageGestures(): void {
    try {
      const el = document.documentElement;
      htmlTouchBackup = { touchAction: el.style.touchAction, overscroll: el.style.overscrollBehavior, overflow: el.style.overflow };
      el.style.touchAction = "none";
      el.style.overscrollBehavior = "none";
      el.style.overflow = "hidden";
    } catch {
      /* 拿不到根元素就算了（不该发生） */
    }
  }
  function unlockPageGestures(): void {
    if (!htmlTouchBackup) return;
    try {
      const el = document.documentElement;
      el.style.touchAction = htmlTouchBackup.touchAction;
      el.style.overscrollBehavior = htmlTouchBackup.overscroll;
      el.style.overflow = htmlTouchBackup.overflow;
    } catch {
      /* 忽略 */
    }
    htmlTouchBackup = null;
  }

  return {
    joyGate,
    basePitch,
    joyMeasureVh,
    initPitch,
    joyVars,
    onMoveStart,
    onMove,
    onMoveEndNames,
    guardGestures,
    lockPageGestures,
    unlockPageGestures,
  };
}
