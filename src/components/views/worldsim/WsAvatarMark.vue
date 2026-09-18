<template>
  <!--
    单个头像标记（地图上的「人」）—— P2-1 的最小单元

    为什么拆成独立组件（而不是在列表里铺一堆 div）：
      · 每个头像要自己管「图片加载失败 → 退名字首字占位」这一份状态；
      · 悬停/选中的样式只在被hover的那一个上，拆开后 Vue 的更新粒度就是一个人。
    结构与视觉：外圈 = 情绪环（选中/自己用不同色），内圈 = 圆头像，下面 = 名字标签。
  -->
  <button
    class="ws-av"
    :class="[
      `ws-av--${size}`,
      {
        'is-me': actor.isMe,
        'is-on': selected,
        'is-crowd': actor.crowd > 1,
        'is-nopic': !picOk,
        'is-dragging': dragging,
        'is-draggable': drag,
        'is-focused': focused,
        'is-plain': plan.mode === 'plain',
        'is-letter': plan.mode === 'letter',
        'is-char': plan.ring === 'char',
      },
    ]"
    type="button"
    data-no-gesture
    :data-actor="actor.id"
    :style="style"
    :title="title"
    :aria-label="label"
    @pointerdown.stop="onDown"
    @pointermove.stop="onMove"
    @pointerup.stop="onUp"
    @pointercancel.stop="onCancel"
    @dblclick.stop
    @wheel.stop
    @click.stop="onClick"
  >
    <span class="ws-av__ring">
      <img
        v-if="actor.avatarUrl && picOk && plan.mode === 'image'"
        class="ws-av__pic"
        :src="actor.avatarUrl"
        :alt="actor.name"
        draggable="false"
        loading="lazy"
        decoding="async"
        @error="picOk = false"
      />
      <!-- T4-3：LingChat 角色拿不到图 → 首字母色块占位（**如实降级，绝不画假头像**） -->
      <span v-else-if="plan.mode === 'letter'" class="ws-av__ph" aria-hidden="true">{{
        plan.initial
      }}</span>
      <!-- 路人：一个纯色圆点（视觉上与角色区分开：更小、无描边、无字母） -->
      <span v-else class="ws-av__dot" aria-hidden="true" />
      <span v-if="actor.isMe" class="ws-av__me" aria-hidden="true">★</span>
      <span v-if="actor.crowd > 1" class="ws-av__n" aria-hidden="true">{{ actor.crowd }}</span>
      <!-- 占位原因角标：浏览器里是「需真壳命令」，真壳里是「该角色没有头像文件」。
           两种都只在**页面级**的大小上显示（mini 太小），并且带 `title` 说清原因。 -->
      <span v-if="showHint" class="ws-av__hint" aria-hidden="true">🛈</span>
    </span>
    <span v-if="showName" class="ws-av__name">{{ label }}</span>
    <span v-if="showPlace && actor.place" class="ws-av__place">{{ actor.place }}</span>
    <!-- T4-3：重大事件聚焦的铭牌（事件标题跟在名字后面）。
         放在按钮内部是**故意**的：它跟着头像一起被 `scale(1/zoom)` 抵消，
         不需要任何额外的坐标换算 —— 位置天然就压在那一枚头像上。 -->
    <span v-if="focused && focusTitle" class="ws-av__evt">{{ focusTitle }}</span>
  </button>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import { letterboxOf, gridToBox, type PlacedActor } from "./wsActors";
  import { avatarFallbackText, avatarPlanOf, type AvatarPlan } from "./wsFocus";
  // P4-4：拖拽必须与地图手势**同一套口径** —— 阈值 4px、拖后抑制补发的 click（350ms）。
  // 直接复用那两个常量/纯函数，绝不在这里另写一组数（两套数必然手感不一致）。
  import { CLICK_SUPPRESS_MS, isDrag } from "@/composables/useWorldSimGestures";

  const props = withDefaults(
    defineProps<{
      actor: PlacedActor;
      /** 盒子尺寸（CSS 像素，未缩放的本地坐标）——由 WsAvatarLayer 统一量一次传下来 */
      boxW: number;
      boxH: number;
      grid: number;
      selected?: boolean;
      /** 'map' 地图大头像 / 'mini' 小地图上的小点 */
      size?: "map" | "mini";
      /** 玩家显示名（我的头像上要写名字） */
      meName?: string;
      /**
       * 地图当前的缩放倍率（手势那套）。
       *
       * 为什么要传进来：头像层是**地图变换容器的子节点**，地图放大 4× 时
       * 头像也会被一起放大成 4 倍的大饼。这里用 `scale(1/k)` 反向抵消，
       * 让头像**位置跟着地图走、尺寸始终是屏幕上那么大** —— 这是地图类应用
       * （高德/Google Maps 的 POI）的通行做法，也是「地图上的人」能看清的前提。
       */
      zoom?: number;
      /**
       * P4-4：这个头像能不能被**拖动**（把角色拖到地图别处 = 下一条「去那里」的指令）。
       *
       * 默认 **false**：小地图（`size='mini'`）等场景不该能拖，
       * 只有主地图那一层会打开它（WorldSim 的 `#pin` 插槽）。
       */
      drag?: boolean;
      /**
       * T4-3：这一枚头像的计划（`avatarPlanOf` 的结果）。
       *
       * 由 `WsAvatarLayer` **统一算一次**再传下来，而不是每个人自己算：
       * 计划里含 `isTauriRuntime()`（模块级常量），逐个人算等于同一件事问 N 遍。
       * 不传时退回默认值（等价于老行为：有 URL 就画图，否则画占位）。
       */
      plan?: AvatarPlan;
      /** T4-3：这一枚正被重大事件聚焦（放大 + 描边 + 铭牌） */
      focused?: boolean;
      /** T4-3：聚焦事件的标题（铭牌上跟在名字后的那一行；空则不显示） */
      focusTitle?: string;
    }>(),
    {
      selected: false,
      size: "map",
      meName: "",
      zoom: 1,
      drag: false,
      plan: undefined,
      focused: false,
      focusTitle: "",
    }
  );

  const emit = defineEmits<{
    (e: "pick", a: PlacedActor): void;
    /** 超过阈值、真的开始拖了（只发一次） */
    (e: "dragstart", a: PlacedActor): void;
    /** 拖动中（每次 pointermove 一次，坐标是 client 坐标） */
    (e: "dragmove", p: { a: PlacedActor; clientX: number; clientY: number }): void;
    /** 松手（`moved=false` 表示没超过阈值 = 一次点击，调用方别当拖拽处理） */
    (e: "dragend", p: { a: PlacedActor; clientX: number; clientY: number; moved: boolean }): void;
  }>();

  const { t } = useI18n();

  /** 图片加载失败 → 退占位（不弹错、不空着） */
  const picOk = ref(true);
  // 换了头像 URL 要重新给一次机会（否则第一次失败以后永远画占位）
  watch(
    () => props.actor.avatarUrl,
    () => {
      picOk.value = true;
    }
  );

  const label = computed(() => {
    if (props.actor.isMe) return props.meName || t("worldsim.actor.me");
    return props.actor.name;
  });

  /**
   * T4-3：这一枚的画法。
   *
   * 传了 `plan` 就用（层里统一算的）；没传就**就地兜一个等价物** ——
   * 默认值必须与 `avatarPlanOf` 的语义逐字一致，否则同一个组件在两条调用路径下
   * 会长得不一样（小地图那一路最容易漏）。
   */
  const plan = computed<AvatarPlan>(
    () =>
      props.plan ||
      avatarPlanOf(props.actor, !!String(props.actor.avatarUrl || "").trim(), false)
  );

  /** 占位原因角标：`letter` 档且不是 mini 才显示（mini 太小，画上去就是个污点） */
  const showHint = computed(
    () => props.size === "map" && plan.value.mode === "letter" && !!plan.value.fallback
  );
  const fallbackTip = computed(() => avatarFallbackText(plan.value.fallback).fallback);

  const showName = computed(() => props.size === "map");
  const showPlace = computed(() => props.size === "map" && !!props.actor.place);

  const title = computed(() => {
    const who = label.value;
    const what = props.actor.nowText || props.actor.place;
    const base = what ? `${who} · ${what}` : who;
    // 占位原因要能查到（否则"为什么这个人是字母"在真机上永远说不清）
    return showHint.value && fallbackTip.value ? `${base} · ${fallbackTip.value}` : base;
  });

  /**
   * 定位：把格子坐标折成盒子内像素。
   *
   * `left/top` 定位置、`translate(-50%,-50%)` 把自己居中、
   * `scale(1/zoom)` 抵消地图手势的放大 —— 三条一起才等于「钉在地图的那块地上，
   * 但始终保持屏幕上这么大」。少任何一条都会出问题（不抵消 → 放大成巨饼；
   * 不居中 → 头像右下角压在那个点上；不用 left/top → 变换会被 CSS 覆盖）。
   */
  const style = computed(() => {
    const lb = letterboxOf(props.boxW, props.boxH, props.grid);
    const p = gridToBox(props.actor.px, props.actor.py, lb);
    const k = Number.isFinite(props.zoom) && props.zoom > 0 ? props.zoom : 1;
    return {
      left: `${p.x.toFixed(2)}px`,
      top: `${p.y.toFixed(2)}px`,
      transform: `translate(-50%, -50%) scale(${(1 / k).toFixed(4)})`,
    };
  });

  /* ── P4-4：把这个人拖到地图别处 ────────────────────────────────────────────
   *
   * 三条硬要求（机主给的口径，改之前先读）：
   *  ① **绝不触发地图平移缩放**：本元素是 `<button>`（在 `useWorldSimGestures` 的
   *     免手势名单里）**并且**挂了 `data-no-gesture`，指针事件在这里 `.stop` 掉 ——
   *     地图那套 `pointerdown` 收不到，`pointers` 表一直是空的，所以拖地图的数学
   *     一次都不会跑（不是「跑了但被忽略」，是根本没启动）。
   *  ② **阈值 4px**（复用 `isDrag`）：小于它一律当点击，否则「点一下就选中」会失灵。
   *  ③ 拖完必须**吃掉浏览器补发的那一发 click**（`CLICK_SUPPRESS_MS`）：
   *     不然松手会顺带触发「选中这个人」，把刚拖到的目的地又盖掉。
   *
   * 指针捕获挂在自己的元素上（`setPointerCapture`）：手指滑出这个几十像素的小圆
   * 以后事件仍然回到这里，否则往远处拖到一半就断了（拖拽最典型的 bug）。
   */
  const dragging = ref(false);
  let armed = false;
  let pid = -1;
  let startX = 0;
  let startY = 0;
  let suppressUntil = 0;

  function elOf(e: PointerEvent): HTMLElement | null {
    return (e.currentTarget as HTMLElement) || null;
  }

  function onDown(e: PointerEvent) {
    if (!props.drag) return;
    // 只认主键（鼠标右键/中键不参与拖动）；触屏/笔的 button 恒为 0
    if (e.pointerType === "mouse" && e.button !== 0) return;
    armed = true;
    dragging.value = false;
    pid = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    try {
      elOf(e)?.setPointerCapture(e.pointerId);
    } catch {
      /* 老 WebView 不支持捕获：退化也能用，只是拖出元素后可能断 */
    }
  }

  function onMove(e: PointerEvent) {
    if (!armed || e.pointerId !== pid) return;
    if (!dragging.value) {
      // 阈值内：还是「可能的点击」，什么都不做（点击选中靠 click 那条路）
      if (!isDrag(e.clientX - startX, e.clientY - startY)) return;
      dragging.value = true;
      emit("dragstart", props.actor);
    }
    emit("dragmove", { a: props.actor, clientX: e.clientX, clientY: e.clientY });
  }

  function onUp(e: PointerEvent) {
    if (!armed || e.pointerId !== pid) return;
    armed = false;
    try {
      elOf(e)?.releasePointerCapture(e.pointerId);
    } catch {
      /* 已经释放/不支持捕获 */
    }
    if (!dragging.value) return; // 没超过阈值 = 一次点击，交给 onClick
    dragging.value = false;
    suppressUntil = Date.now() + CLICK_SUPPRESS_MS;
    emit("dragend", { a: props.actor, clientX: e.clientX, clientY: e.clientY, moved: true });
  }

  function onCancel() {
    // 浏览器把手势抢走了（页面开始滚动之类）：干净退出，别留下「半拖着」的状态
    const wasDragging = dragging.value;
    armed = false;
    dragging.value = false;
    if (wasDragging) {
      suppressUntil = Date.now() + CLICK_SUPPRESS_MS;
      emit("dragend", { a: props.actor, clientX: startX, clientY: startY, moved: false });
    }
  }

  /** 点一下就选中 —— 拖过的那一发补发的 click 必须拦掉（见上面的 ③） */
  function onClick() {
    if (Date.now() < suppressUntil) return;
    emit("pick", props.actor);
  }
</script>

<style scoped>
  .ws-av {
    position: absolute;
    /* translate/scale 由组件按 zoom 动态算（见 style 计算属性），这里只留兜底 */
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.12em;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ws-fg);
    cursor: pointer;
    /* 自己是地图手势层里的一个洞：头像可点，其它地方的事件照旧穿透给手势 */
    pointer-events: auto;
    -webkit-tap-highlight-color: transparent;
  }
  .ws-av__ring {
    position: relative;
    display: block;
    width: 2.1em;
    height: 2.1em;
    border-radius: 50%;
    overflow: hidden;
    background: var(--ws-panel-2);
    border: 2px solid var(--ws-primary);
    box-shadow: var(--ws-shadow);
    transition:
      transform 0.16s ease,
      border-color 0.16s ease;
  }
  .ws-av__pic {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ws-av__ph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: 1em;
    font-weight: 700;
    color: var(--ws-on-primary);
    background: var(--ws-primary-soft);
  }
  /* T4-3：路人 = 一个纯色圆点（**不画字母**：字母是"这个角色有头像但取不到"的语义，
     给路人画字母会让人以为他也是 LingChat 角色）。尺寸比角色点小一圈，
     一眼就能分出「有头像的角色 / 路人」。 */
  .ws-av__dot {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--ws-fg-dim);
    opacity: 0.55;
  }
  /* T4-3：占位原因角标（右下角一枚小 🛈，`title` 里说清原因） */
  .ws-av__hint {
    position: absolute;
    right: -0.1em;
    bottom: -0.1em;
    font-size: 0.5em;
    line-height: 1;
    opacity: 0.9;
    text-shadow: 0 0 2px var(--ws-bg);
    pointer-events: none;
  }
  /* T4-3：聚焦铭牌（事件标题）。放在名字下面一行，跟着头像一起缩放。 */
  .ws-av__evt {
    max-width: 8em;
    margin-top: 0.1em;
    padding: 0.05em 0.4em;
    font-size: 0.72em;
    font-weight: 700;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ws-fg);
    background: var(--ws-accent);
    border: 1px solid var(--ws-accent);
    border-radius: 999px;
    box-shadow: var(--ws-shadow);
    animation: ws-av-evt 0.24s ease both;
  }
  @keyframes ws-av-evt {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.9);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .ws-av__me {
    position: absolute;
    right: 0;
    bottom: 0;
    font-size: 0.55em;
    line-height: 1;
    padding: 0.1em;
    color: var(--ws-accent-2);
    text-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
  }
  .ws-av__n {
    position: absolute;
    left: -0.2em;
    top: -0.2em;
    min-width: 1.1em;
    padding: 0 0.2em;
    font-size: 0.6em;
    line-height: 1.1em;
    border-radius: 999px;
    background: var(--ws-warn);
    color: #3a2c10;
    text-align: center;
  }
  .ws-av__name {
    max-width: 6em;
    padding: 0.05em 0.4em;
    font-size: 0.78em;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 999px;
    background: var(--ws-panel);
    border: 1px solid var(--ws-border);
    backdrop-filter: blur(var(--ws-blur));
    -webkit-backdrop-filter: blur(var(--ws-blur));
  }
  .ws-av__place {
    max-width: 7em;
    font-size: 0.7em;
    color: var(--ws-fg-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 2px var(--ws-bg);
  }
  /* 自己：用主题里那个专门的「自己头像点」色（--ws-accent-2） */
  .ws-av.is-me .ws-av__ring {
    border-color: var(--ws-accent-2);
    border-width: 3px;
  }
  .ws-av.is-on .ws-av__ring {
    border-color: var(--ws-primary-deep);
    transform: scale(1.14);
    box-shadow: var(--ws-shadow-lg);
  }
  .ws-av.is-crowd .ws-av__ring {
    /* 一堆人挤在一起时加一点点描边，好区分 */
    outline: 1px solid var(--ws-border);
  }
  /* ── T4-3：LingChat 角色 vs 路人的**视觉区分**（卡片第 2 条硬要求）──────────
     「头像点稍大 + 有描边」：角色点放大到 2.35em 并且描边加粗到 2.5px，
     路人（is-plain）缩到 1.5em、用 1px 虚描边、去掉阴影。
     两条规则都不动 left/top（动画纪律：只动 transform/颜色/尺寸这类可合成属性）。 */
  .ws-av.is-char .ws-av__ring {
    width: 2.35em;
    height: 2.35em;
    border-width: 2.5px;
  }
  .ws-av.is-plain .ws-av__ring {
    width: 1.5em;
    height: 1.5em;
    border-width: 1px;
    border-style: dashed;
    border-color: var(--ws-border);
    box-shadow: none;
    background: var(--ws-bg);
  }
  /* ── T4-3：重大事件聚焦 ────────────────────────────────────────────────────
     只做三件事：① 再放大一点（与选中态区分开：选中是 1.14，聚焦是 1.25）；
     ② 描边换成强调色 + 更亮的光晕；③ 名字标签反白，让人一眼读到"是谁"。
     抬到压暗层之上那条规则在 `WsAvatarLayer`（父级层叠上下文，这里够不着）。 */
  .ws-av.is-focused .ws-av__ring {
    border-color: var(--ws-accent);
    border-width: 3px;
    transform: scale(1.25);
    /* ⚠️ 不用 `color-mix()`：它在 Android WebView 111+ 才有，而这台机器上
       （以及很多老 WebView）会**整条 box-shadow 失效**。写成固定 rgba 最稳。 */
    box-shadow:
      0 0 0 3px rgba(255, 255, 255, 0.28),
      0 0 18px 5px rgba(120, 170, 255, 0.55);
  }
  .ws-av.is-focused .ws-av__name {
    color: var(--ws-bg);
    background: var(--ws-accent);
    border-color: var(--ws-accent);
    font-weight: 700;
  }
  .ws-av.is-focused {
    z-index: 9;
  }
  .ws-av:hover .ws-av__ring,
  .ws-av:focus-visible .ws-av__ring {
    transform: scale(1.1);
  }
  /* P4-4：能被拖的时候给一点暗示（抓手光标 + 选中态放大），拖动中再加一圈高亮。
   注意：这里只动 transform / opacity / 颜色，不动 left/top/width（动画纪律）。 */
  .ws-av.is-draggable {
    cursor: grab;
  }
  .ws-av.is-dragging {
    cursor: grabbing;
    z-index: 4;
  }
  .ws-av.is-dragging .ws-av__ring {
    transform: scale(1.22);
    border-color: var(--ws-accent);
    box-shadow: var(--ws-shadow-lg);
  }
  .ws-av.is-dragging .ws-av__name {
    opacity: 0.65;
  }
  /* 小地图上的点：只留圆点，不要名字 */
  .ws-av--mini .ws-av__ring {
    width: 1.15em;
    height: 1.15em;
    border-width: 1.5px;
    box-shadow: none;
  }
  .ws-av--mini .ws-av__ph {
    font-size: 0.6em;
  }
  .ws-av--mini {
    pointer-events: auto;
  }
</style>
