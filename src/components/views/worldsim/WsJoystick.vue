<!--
  WsJoystick.vue —— 🕹 摇杆控件（**左下拇指区**；2026-10-03 机主裁决「街景不做，做近景」）。

  ## 这个组件做什么 / 不做什么
  · **做**：把指针/触摸变成"一个向量"，并把它交给 `wsJoystick.createJoyDriver()` ——
    真正的相机更新只在**那一个 rAF** 里发生（本组件每帧只 `emit("drive", 位移)` 一次）。
  · **不做**：不碰地图、不 import 地图库、不算任何米/像素（位移的数学全在纯函数模块里，
    这样它能离线钉字面量自检）。本组件里**一个换算公式都没有**。

  ## 几条硬约束（改之前先读，都在自检里钉着）
  · **命中区 ≥44×44**（`UI-DESIGN-SPEC.md:112`）：命中区 = 整个底盘 112×112（不是那个 52 的杆头）
    ⇒ `pointer-events: auto` 只挂底盘这一层，杆头 `pointer-events: none`。
  · **不许有 `backdrop-filter`**（红线）：浮在地图画布上，模糊 = 每帧把背后的像素读回来重算一遍。
    所以这里只有纯色底 + 1px 描边。
  · **只动 transform/opacity**：杆头跟手写的是 `translate3d`（不是 `left/top`）。
  · **手势绝不漏给地图**：MapLibre 的拖动监听挂在**容器**（`.ws-dml`）上，事件会冒泡上去 ⇒
    这里 `data-no-gesture` + 指针事件一律 `.stop`（与 `WsAvatarMark` 同款口径），
    再配 `touch-action: none`，双保险。
  · **`prefers-reduced-motion` 兜底**：摇杆是**输入控件**，不能因为系统"减弱动效"就禁用；
    这里只关掉那个非必要的过渡（`is-active` 的淡入），杆头跟手一律瞬时（本来就该瞬时）。
-->
<template>
  <div
    ref="baseEl"
    class="ws-joy"
    :class="{ 'is-active': active }"
    data-no-gesture
    role="group"
    :aria-label="ariaLabel"
    @pointerdown.stop.prevent="onDown"
    @pointermove.stop.prevent="onMove"
    @pointerup.stop.prevent="onUp"
    @pointercancel.stop.prevent="onUp"
    @lostpointercapture.stop="onUp"
    @click.stop
    @dblclick.stop
    @contextmenu.stop.prevent
  >
    <span ref="thumbEl" class="ws-joy__thumb" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, ref } from "vue";
  import {
    JOY_MODE_NOTE,
    ROAM_NOTE,
    createJoyDriver,
    joyThumbOffset,
    joyVectorFromPointer,
    type JoyFrameDelta,
    type JoyFramePhase,
    type JoyMotion,
    type JoyVector,
  } from "./wsJoystick";

  /* 不要 `low` 之类的档位 prop：摇杆是**输入**，低端机也必须能推（推不动 = 这一屏废了）。
     真要有降级，降的是画面（挑楼/标签），不是操作。 */
  const emit = defineEmits<{
    /**
     * 每帧**至多一次**（**停稳**的帧根本不发）——地图组件唯一允许驱动相机/角色/名字层的地方。
     * 第 3 个参数是运动状态（角色位移 / 朝向 / 踏步相位），宿主照它写「我」那颗钉子（§3/§4）；
     * 第 4 个参数是**相位**：`"center"` = 松手后的回中段（角色已停稳）⇒ 宿主**只许动相机**。
     */
    drive: [d: JoyFrameDelta, v: JoyVector, m: JoyMotion, phase: JoyFramePhase];
    /** 收尾：**恰好一次**（回中段跑完才发；地图组件在这里清 `joyActive` + 做那一次重算） */
    halt: [];
  }>();

  /**
   * 世界尺度（宿主量好传进来）——本组件**一个换算都不做**（红线）：
   *   · `mpp`      ：米/像素（宿主的 `bldMetersPerCssPixel(zoom, lat)`）；
   *   · `speedMps` ：满推速度（**米/秒**，宿主的 `joySpeedMpsOf(zoom)` 选出来的档）；
   *   · `zoomLevels`：🕹 推杆期间相机**拉近**多少级（宿主的 `JOY_ZOOM_PUSH_LEVELS`，量不到出发 zoom 时给 0）。
   * 缺一个（宿主还没量到）⇒ `joyCtxOf` 归一化成 0 ⇒ 推杆无效 —— 那才是诚实的降级，
   * 总比按屏幕像素编一个世界速度快。`zoomLevels = 0` 则是"这条通路关掉"，摇杆照旧能用。
   */
  const props = defineProps<{ mpp: number; speedMps: number; zoomLevels: number }>();

  const baseEl = ref<HTMLElement | null>(null);
  const thumbEl = ref<HTMLElement | null>(null);
  const active = ref(false);

  const ariaLabel = computed(() => `摇杆：按住并向任意方向推 —— ${JOY_MODE_NOTE}；位置是${ROAM_NOTE}`);

  /**
   * 按下那一刻量到的底盘（中心 + 半径）。
   * 🔴 为什么量一次就缓存：`clientWidth`/`getBoundingClientRect` 都是**强制布局**的读，
   *   放在每帧（或每次 pointermove）里，就是每帧一次 layout —— 与"只动 transform"是同一条红线。
   *   转屏/改尺寸的代价：这一次按压的方向手感偏一点，下一次按下自动校准（可接受，且不改整体布局）。
   */
  let box = { cx: 0, cy: 0, radius: 0 };
  /** 这一次按压属于哪根手指（多指：第二根手指碰到摇杆不许把第一根的状态顶掉） */
  let pid = -1;
  /**
   * 屏宽（px）——**只**用于"前瞻上限 = 屏宽 × 1/8"这一处（速度**不再**由屏宽决定，见 `JoyCtx`）。
   * 同样在按下那一刻量一次并缓存（每帧读 `clientWidth` = 每帧强制布局）。
   */
  let screenW = 0;

  const driver = createJoyDriver({
    ctx: () => ({ screenW, mpp: props.mpp, speedMps: props.speedMps, zoomLevels: props.zoomLevels }),
    onFrame: (d, v, m, phase) => emit("drive", d, v, m, phase),
    /* 🔴 `halt` **不再**在手指抬起那一刻发：那一刻相机可能还偏着 ~17px，先让它平滑贴回角色
       （`release()` 进入回中段，同一个 rAF 只动相机），贴回来了才发这一次 —— 宿主那一次重算
       因此**天然只发生一次、且发生在画面稳定之后**。手指的视觉复位（`active`/杆头）仍在 `onUp` 里当场做。 */
    onHalt: () => emit("halt"),
  });

  /** 杆头跟手（**一次 transform 写**，只动这一个节点；不做布局、不读布局） */
  function writeThumb(x: number, y: number): void {
    const el = thumbEl.value;
    if (el) el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  }

  function onDown(e: PointerEvent): void {
    // 鼠标只认主键（触屏/笔的 button 恒为 0），与 `WsAvatarMark` 同一口径
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pid !== -1) return;                       // 已经有一根手指在推了：这一次忽略
    const el = baseEl.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return;                   // 还没排版（0 尺寸）⇒ 这一次不接，别算出 NaN
    /* 屏宽取**地图容器**（`.ws-dml`）的宽 —— 地图不一定铺满窗口（将来嵌进卡片时也对）；
       取不到就退回窗口宽。⚠️ 口径变了（2026-10-03 第二轮）：屏宽**不再是速度尺子**，
       它只决定"前瞻上限 = 屏宽 × 1/8"；真的是 0 也只是前瞻为 0（相机仍按米/秒跟），不会"推不动"。 */
    const hostEl = el.closest(".ws-dml") as HTMLElement | null;
    screenW = hostEl?.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0) || 0;
    box = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: r.width / 2 };
    pid = e.pointerId;
    active.value = true;
    writeThumb(0, 0);
    /* 指针捕获：手指滑出这个 112px 的圆以后事件仍然回到这里
       （否则推到一半就断 —— 这是摇杆最典型的 bug，与拖动同一个道理）。 */
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败也照常工作（事件在元素上还是收得到）；绝不因此不接这一次按压 */
    }
    driver.begin();
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pid) return;
    const v = joyVectorFromPointer(e, box);
    /* 🔴 输入路径只做两件事：① 写那**一个向量**；② 写杆头那**一个 transform**。
       相机、地图、投影一个字都不碰（它们只在 rAF 里，由 `drive` 事件带走）。 */
    const t = joyThumbOffset(e.clientX - box.cx, e.clientY - box.cy, box.radius);
    writeThumb(t.x, t.y);
    driver.setVector(v);
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pid) return;
    pid = -1;
    const el = baseEl.value;
    if (el && el.hasPointerCapture?.(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* 已经释放过就忽略 */
      }
    }
    /* 手指抬起：**当场**做视觉复位（按下态的淡入要立刻结束、杆头立刻回中）+ 归零 + `release()`。
       `release()` 之后相机还在回中段跑（那几个 rAF 与手指无关），收尾那一次 `halt` 由它自己发。 */
    active.value = false;
    writeThumb(0, 0);
    driver.release();
  }

  onBeforeUnmount(() => {
    /* 卸载（关开关 / 离开这一屏）：停 rAF，**不** emit halt ——
       "松手"与"控件没了"是两件事，后者不该触发一次重算。 */
    driver.cancel();
    pid = -1;
  });
</script>

<style scoped>
  /* 🕹 底盘：几何全部来自 `wsJoystick.ts` 的常量（由宿主 `.ws-dml` 写成 CSS 变量继承下来）
     ⇒ 这里**一个数字都不写死**（改大小只改真源一处；命中区/让位高度跟着一起变）。 */
  .ws-joy {
    position: absolute;
    left: var(--ws-joy-inset, 8px);
    bottom: var(--ws-joy-inset, 8px);
    width: var(--ws-joy-base, 112px);
    height: var(--ws-joy-base, 112px);
    border-radius: 50%;
    box-sizing: border-box;
    /* 纯色 + 描边：**没有** backdrop-filter（红线：浮层模糊 = 每帧读回背后像素） */
    background: rgba(10, 16, 24, 0.34);
    border: 1px solid rgba(255, 255, 255, 0.28);
    /* z-index 5：在名字层（3）之上、🔬（6）之下；验证面板（40）摊开时压住它 —— 与 🔬 的关系保持"面板最大" */
    z-index: 5;
    /* 控件自己吃事件（地图容器上的拖动监听靠 `data-no-gesture` + `.stop` 拦住，不是靠这里不吃） */
    pointer-events: auto;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    /* 只动 opacity（transform 留给杆头）：按下时给一点反馈，非必要动效 */
    opacity: 0.86;
    transition: opacity 90ms linear;
  }
  .ws-joy.is-active {
    opacity: 1;
  }
  /* 杆头：可见摇杆头 52×52（居中）。**不接事件** —— 命中区是整块底盘，别让 52 这个数变成实际命中区。 */
  .ws-joy__thumb {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--ws-joy-thumb, 52px);
    height: var(--ws-joy-thumb, 52px);
    margin: calc(var(--ws-joy-thumb, 52px) / -2) 0 0 calc(var(--ws-joy-thumb, 52px) / -2);
    border-radius: 50%;
    background: rgba(233, 244, 255, 0.9);
    border: 1px solid rgba(10, 16, 24, 0.35);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    pointer-events: none;
    /* 跟手一律瞬时（有过渡反而"黏"）；这里声明 will-change 是本项目对"每帧写 transform"的既有口径 */
    will-change: transform;
  }
  /* ♿ 系统开了"减弱动效"⇒ 关掉那点淡入淡出（杆头跟手**不关**：那是输入，不是动效） */
  @media (prefers-reduced-motion: reduce) {
    .ws-joy {
      transition: none;
    }
  }
</style>
