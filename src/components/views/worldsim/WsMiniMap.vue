<!--
  WsMiniMap.vue —— 「我的」面板里的**圆形小地图**（机主 2026-09-18 要求）

  ## 机主原话
  「小地图功能那个小地图换成圆形的，自由缩放，拖拽」

  ## 为什么不是"把原来的方框改成圆角"
  原来那块 `.ws-mini` 只是一个**纯色方块 + 头像点**（背景是 `--ws-stage-bg`），
  根本没有地图内容 —— 圆不圆、能不能拖都没意义。所以这里先把**真地图**放进去：
  用 `wsGeoMap`（GeoJSON 渲染器，与主地图同一份数据 `geoStage.feats`）静态画一张，
  再把头像点叠在**同一个变换层**里。

  ## 为什么拖拽/缩放只改变换、不重绘
  1. 圆里那张图是**已经画好的位图**（canvas），拖拽/捏合只改 `transform` →
     不重建 Path2D、不重画、不看网络，60fps 的常规操作；
  2. 头像点与地图**必须在同一层**：分开变换就会出现"地图动了、人没动"
     （这正是机主在 wsgame 上骂过的错位问题的同类）。
  3. 手势自己实现（渲染器传 `interactive: false`），因为要同时带动点子层。

  ## 边界
  · 缩放 1×~4×，平移被夹住（不许把地图拖出圆外）；
  · 双击复位（与主地图一致的手势习惯）；
  · `prefers-reduced-motion` 下不加过渡。
-->
<template>
  <div
    ref="host"
    class="ws-mini"
    :class="{ 'is-drag': dragging }"
    :title="t('worldsim.me.minimap')"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @wheel.prevent="onWheel"
    @dblclick="reset"
  >
    <!-- 变换层：地图位图 + 头像点（同一层，一起动） -->
    <div class="ws-mini__inner" :style="innerStyle">
      <canvas ref="cv" class="ws-mini__cv" />
      <WsAvatarLayer
        class="ws-mini__layer"
        :placed="placed"
        :grid="grid"
        size="mini"
        :selected-id="selectedId"
        :me-name="meName"
        @pick="(a) => emit('pick', a)"
      />
    </div>

    <!-- 复位按钮：只在动过之后出现（平时不占视觉） -->
    <button
      v-if="moved"
      class="ws-mini__reset"
      type="button"
      title="复位小地图"
      @pointerdown.stop
      @click.stop="reset"
    >
      ⟲
    </button>
    <div class="ws-mini__hint">拖动平移 · 滚轮/双指缩放 · 双击复位</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import { WsGeoMap, THEME_DARK, THEME_LIGHT, type GeoFeat } from "./wsGeoMap";
  import WsAvatarLayer from "./WsAvatarLayer.vue";
  import type { PlacedActor } from "./wsActors";

  const props = withDefaults(
    defineProps<{
      /** 当前级的要素（主地图同一份，见 `useWsGeoStage().feats`） */
      feats?: GeoFeat[];
      placed?: PlacedActor[];
      grid?: number;
      selectedId?: string;
      meName?: string;
      /** 深色主题（跟主地图一起切） */
      dark?: boolean;
    }>(),
    { feats: () => [], placed: () => [], grid: 28, selectedId: "", meName: "", dark: true }
  );
  const emit = defineEmits<{ (e: "pick", a: PlacedActor): void }>();
  const { t } = useI18n();

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
  let map: WsGeoMap | null = null;
  let ro: ResizeObserver | null = null;

  /* ── 变换状态（只这两条 + 一个夹紧函数，够了）────────────────────────── */
  const scale = ref(1);
  const tx = ref(0);
  const ty = ref(0);
  const dragging = ref(false);
  const moved = computed(() => scale.value > 1.01 || Math.abs(tx.value) > 2 || Math.abs(ty.value) > 2);
  const innerStyle = computed(() => ({
    transform: `translate3d(${tx.value}px, ${ty.value}px, 0) scale(${scale.value})`,
  }));

  /** 夹住平移：内容放大 s 倍后最多能移动 (s-1)/2 个容器边长 */
  function clamp() {
    const el = host.value;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const mx = ((scale.value - 1) * w) / 2;
    const my = ((scale.value - 1) * h) / 2;
    tx.value = Math.max(-mx, Math.min(mx, tx.value));
    ty.value = Math.max(-my, Math.min(my, ty.value));
  }

  function reset() {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
  }

  function zoomAt(f: number, px: number, py: number) {
    const el = host.value;
    if (!el) return;
    const next = Math.max(1, Math.min(4, scale.value * f));
    const real = next / scale.value;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    // 以指针为锚（焦点缩放）—— 与主地图同一套公式，手指下的东西不会跑
    tx.value = px - cx - (px - cx - tx.value) * real;
    ty.value = py - cy - (py - cy - ty.value) * real;
    scale.value = next;
    clamp();
  }

  /* ── 手势：单指平移 / 双指捏合 / 滚轮 ─────────────────────────────────── */
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; s: number } | null = null;
  const local = (e: PointerEvent | WheelEvent) => {
    const r = host.value?.getBoundingClientRect();
    return { x: e.clientX - (r?.left || 0), y: e.clientY - (r?.top || 0) };
  };

  function onDown(e: PointerEvent) {
    /* ⚠️ `setPointerCapture` 在某些情况下会**抛异常**（例如合成事件、或指针已被释放）——
       不接住的话整个 onDown 就断了，表现成"拖不动"且**没有报错**。
       实测：我的自动化测试派发合成 PointerEvent 时就撞上了这条。 */
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 拿不到捕获也能拖：下面照样按 pointermove 更新 */
    }
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) dragging.value = true;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale.value };
      dragging.value = false;
    }
  }
  function onMove(e: PointerEvent) {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId)!;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const want = Math.max(1, Math.min(4, (pinch.s * d) / pinch.d));
        zoomAt(want / scale.value, mid.x, mid.y);
      }
      return;
    }
    if (dragging.value) {
      tx.value += p.x - prev.x;
      ty.value += p.y - prev.y;
      clamp();
    }
  }
  function onUp(e: PointerEvent) {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) dragging.value = false;
  }
  function onWheel(e: WheelEvent) {
    const p = local(e);
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }

  /* ── 渲染：把主地图那一级的要素静态画进来（不再参与手势）────────────── */
  function mount() {
    if (!cv.value || map) return;
    map = new WsGeoMap({
      canvas: cv.value,
      theme: props.dark ? THEME_DARK : THEME_LIGHT,
      interactive: false,
    });
    map.setFeatures(props.feats, { animate: false });
  }
  watch(
    () => props.feats,
    (f) => {
      mount();
      map?.setFeatures(f, { animate: false });
      reset();
    },
    { deep: false }
  );
  watch(
    () => props.dark,
    (d) => map?.setTheme(d ? THEME_DARK : THEME_LIGHT)
  );

  onMounted(() => {
    mount();
    if (typeof ResizeObserver !== "undefined" && host.value) {
      ro = new ResizeObserver(() => map?.layout());
      ro.observe(host.value);
    }
  });
  onBeforeUnmount(() => {
    ro?.disconnect();
    map?.destroy();
    map = null;
  });
</script>

<style scoped>
  /* ── 圆形小地图（机主要求：圆形 + 自由缩放 + 拖拽）─────────────────────
     圆形用 border-radius 裁（不是画个圆遮罩）：裁完地图位图和头像点一起被裁，
     不会出现"点在圆外飘着"。 */
  .ws-mini {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    overflow: hidden;
    background: var(--ws-stage-bg, #0f1620);
    box-shadow:
      0 0 0 1px var(--ws-border, rgba(255, 255, 255, 0.18)),
      0 6px 18px rgba(0, 0, 0, 0.28);
    touch-action: none; /* 手势自己处理，别让浏览器抢去滚动 */
    cursor: grab;
    user-select: none;
  }
  .ws-mini.is-drag {
    cursor: grabbing;
  }
  .ws-mini__inner {
    position: absolute;
    inset: 0;
    transform-origin: 50% 50%;
    will-change: transform; /* 只动 transform：拖拽/缩放不触发重排、不重画地图 */
  }
  /* ⚠️ canvas 是替换元素（默认 300×150），只给 inset 不会拉伸，必须显式 100% */
  .ws-mini__cv {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .ws-mini__layer {
    position: absolute;
    inset: 0;
  }
  .ws-mini__reset {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 34px;
    height: 34px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.42);
    color: #fff;
    font-size: 1em;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  /* 操作提示贴在圆的下沿：不挡内容，也让人知道这块能拖 */
  .ws-mini__hint {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 4px;
    text-align: center;
    font-size: 0.68em;
    opacity: 0.55;
    pointer-events: none;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }
  .ws-root.ws-perf-low .ws-mini__inner {
    will-change: auto;
  }
</style>
