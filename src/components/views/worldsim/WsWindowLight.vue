<!--
  「世界模拟」T4-1：窗户光 —— 夜里把小区图上的建筑窗户点亮

  ⚠️ 老线**没有**这个能力（`public/world_map/world_time.js` 里只有 timeTint /
     applyTimeTint / sunTimes / FACILITIES，grep「窗」零命中）。这是 T4-1 的原始要求，
     属于**新写**，不是移植。

  ── 怎么算出「哪里有窗」────────────────────────────────────────────────────
    新线小区图的建筑是 `<rect class="ws-b">`（`wsDistrictPaint.ts::buildingSpecs`），
    坐标在 `0..size` 的格子里。这里**只读**它们的 x/y/width/height，用
    `wsTime.ts::windowCells()`（纯函数）在每栋楼里摊出一格格窗。
    刻意不去改 `buildingSpecs` 的输出 —— 那份 SVG 文本是自检的基准，动它等于
    把一批断言一起改了；读 DOM 则完全不动既有渲染路径。

  ── 为什么把这一层放在 `#pin` 插槽里 ──────────────────────────────────────
    插槽落在 `.ws-neigh__pan`（手势的变换容器）里，与建筑**同一套坐标系、同一个
    transform**：地图平移/缩放时窗户自动跟着走，这里一个 transform 都不用写，
    也不会有「窗户漂在楼外面」的对不齐。这与 `WsAvatarLayer` 放这儿的理由完全一样。

  ── 什么时候不亮 ──────────────────────────────────────────────────────────
    · 白天（`night <= 0`）：整层不渲染，一个节点都不建；
    · 还没开始 AI 精绘、或者精绘只画到一半：有几栋楼点几栋楼，其余保持原样
      （草图 `<img>` 上没有 DOM 可读，所以**只有 AI 精绘层有窗户光** —— 这一点
      已在交付报告里如实写明）；
    · 低端机（`ws-perf-low`）：由页面决定传 `night=0` 关掉它（省掉几百个节点的合成）。
-->
<template>
  <svg
    v-if="cells.length"
    class="ws-win"
    viewBox="0 0 1 1"
    preserveAspectRatio="none"
    aria-hidden="true"
    data-ws-winlight
  >
    <!-- `<g>` 承担信箱折算 + 格子单位 → 单位空间。
         ⚠️ x/y **必须分开缩放**：本层是 `viewBox="0 0 1 1"` + `preserveAspectRatio="none"`
            （1 个单位 = 容器宽/高的 100%），而地图占的那块通常只在**一个方向**上小于容器
            （另一个方向撑满）。统一除 size 会让窗户在地图方向被拉长 —— 这条是推导出来的，
            不是试出来的：单位空间里一格 = box.w/size（横向）与 box.h/size（纵向）。 -->
    <g :transform="`translate(${box.left}, ${box.top}) scale(${box.w / size}, ${box.h / size})`">
      <rect
        v-for="(c, i) in cells"
        :key="i"
        :x="c.x"
        :y="c.y"
        :width="c.w"
        :height="c.h"
        :fill="`rgba(255, 214, 138, ${cellAlpha(c.lit)})`"
      />
      <!-- 给亮着的窗再加一层更暖的芯：单色小方块看着像贴纸，双色叠一下才有灯的样子 -->
      <rect
        v-for="(c, i) in cells"
        :key="`hot-${i}`"
        :x="c.x + c.w * 0.28"
        :y="c.y + c.h * 0.28"
        :width="c.w * 0.44"
        :height="c.h * 0.44"
        :fill="`rgba(255, 245, 214, ${cellAlpha(c.lit, 1.35)})`"
      />
    </g>
  </svg>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import { windowCells, type WsBuildingRect, type WsWindowCell } from "./wsTime";

  const props = withDefaults(
    defineProps<{
      /** 天黑程度 0..1（`wsTime.ts::nightLevel(hour)`）——0 表示白天，整层不渲染 */
      night: number;
      /** 小区图的网格边长（与 `.ws-paint` 的 viewBox 一致） */
      size?: number;
      /**
       * 是否盯着 DOM 读建筑。默认开：只有 `#pin` 这一处用到它，
       * 关掉是为了让「纯展示」的用法（自检、演示页）不依赖 DOM。
       */
      watchDom?: boolean;
      /** 建筑矩形由外部直接给（给了就不读 DOM）——自检/演示页用 */
      rects?: readonly WsBuildingRect[];
    }>(),
    { size: 28, watchDom: true, rects: undefined }
  );

  /**
   * 建筑矩形的一批快照。用「读 DOM」而不是「让页面把数据传下来」的理由：
   * 那份数据现在只存在于 `DistrictCanvas` 内部（`WsDistrict` 没有 expose、
   * `done` 事件也不带布局），为了这个纯观感的能力去改 `WsDistrict.vue` /
   * `useWorldSim.ts` 属于扩大 diff，不划算。
   */
  const rects = ref<WsBuildingRect[]>([]);

  /** 读一遍当前画布上的 `.ws-b`。重复的相邻矩形会去重 —— AI 流是增量的，不保证每帧都重画。 */
  function readRects(): WsBuildingRect[] {
    if (props.rects) return props.rects.slice();
    if (!props.watchDom || typeof document === "undefined") return [];
    const list = document.querySelectorAll<SVGRectElement>(".ws-neigh__ai svg .ws-b");
    const out: WsBuildingRect[] = [];
    let px = NaN;
    let py = NaN;
    let pw = NaN;
    let ph = NaN;
    for (const el of Array.from(list)) {
      const x = Number(el.getAttribute("x"));
      const y = Number(el.getAttribute("y"));
      const w = Number(el.getAttribute("width"));
      const h = Number(el.getAttribute("height"));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) continue;
      // 全等 → 同一栋楼被重复列入（同一个位置画了两次，没必要算两遍窗）
      if (x === px && y === py && w === pw && h === ph) continue;
      px = x;
      py = y;
      pw = w;
      ph = h;
      out.push({ x, y, w, h });
    }
    return out;
  }

  function refresh() {
    if (props.night <= 0) {
      rects.value = [];
      return;
    }
    // 先折算信箱，再读建筑：两者都依赖画布已经在 DOM 里
    measureBox();
    const next = readRects();
    // 内容没变就别换引用：换了会让下面每一扇窗都重渲染一次
    const prev = rects.value;
    if (
      prev.length === next.length &&
      next.every((r, i) => {
        const p = prev[i]!;
        return p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h;
      })
    ) {
      return;
    }
    rects.value = next;
  }

  const cells = computed<WsWindowCell[]>(() => windowCells(rects.value));

  /**
   * 信箱（letterbox）折算：把「小区图实际占的那块」量出来。
   *
   * ⚠️ 为什么必须量：AI 精绘画布的 viewBox 是**正方形**（`0 0 size size`），
   *    而盒子常常是长方形 —— 地图 SVG 靠 `preserveAspectRatio` 居中留白
   *    （`WsAvatarLayer.vue` 的文件头把这件事写得很清楚：头像也必须复刻同一套折算，
   *    否则会"落在盒子上而不是图上"）。窗户光同理：不折算就会与楼错位。
   *
   * 量什么：画布根 `<svg class="ws-paint">` 相对**本层容器**的矩形 ——
   *    两者在同一个手势变换容器（`.ws-neigh__pan`）里，变换对两者相同，
   *    所以这一步只需要处理"居中留白"，不需要碰手势。
   * 单位：四个数都是**容器的比例**（0..1）：`left/top` 是偏移，`w/h` 是地图占的份额。
   *    横向撑满时 `w = 1`，纵向留白时 `h < 1`（或反过来）—— 所以 `<g>` 里的
   *    scale 必须 x/y 分开算，不能统一除 `size`。
   */
  const box = ref({ left: 0, top: 0, w: 1, h: 1 });

  function measureBox() {
    if (typeof document === "undefined") return;
    /* 容器就是这一层自己的根 `<svg class="ws-win">`：
       它与画布根（`.ws-paint`）同在 `.ws-neigh__pan` 里，所以两者的
       `getBoundingClientRect()` 差**只**来自「居中留白」，与手势无关。 */
    const host = document.querySelector<SVGSVGElement>("svg.ws-win");
    if (!host) return; // 白天整层没渲染：没有容器可量（也没有窗要点亮），下次再量
    const paint = document.querySelector<SVGSVGElement>(".ws-neigh__ai svg.ws-paint");
    if (!paint) return; // 精绘还没开始：保持 1:1 兜底（此时反正也没有建筑）
    const hb = host.getBoundingClientRect();
    const pb = paint.getBoundingClientRect();
    if (hb.width <= 0 || hb.height <= 0 || pb.width <= 0 || pb.height <= 0) return;
    const next = {
      left: round4((pb.left - hb.left) / hb.width),
      top: round4((pb.top - hb.top) / hb.height),
      w: round4(pb.width / hb.width),
      h: round4(pb.height / hb.height),
    };
    const prev = box.value;
    if (
      prev.left === next.left &&
      prev.top === next.top &&
      prev.w === next.w &&
      prev.h === next.h
    ) {
      return;
    }
    box.value = next;
  }

  function round4(v: number): number {
    return Math.round(v * 10000) / 10000;
  }

  /** 天黑程度 → 单扇窗的不透明度（整层一起缩放，不做逐窗动画：那是几百个节点在合成器上排队） */
  function cellAlpha(lit: number, boost = 1): number {
    return Math.min(0.95, props.night * lit * 0.85 * boost);
  }

  /* ── 什么时候重读 DOM ────────────────────────────────────────────────────
   * AI 精绘是**流式**的：建筑一栋一栋 append 进来，没有任何「画完了」的事件
   * 传到这一层。所以：
   *   ① `MutationObserver` 盯着 `.ws-neigh__ai` 子树（新增建筑立刻点亮）——
   *      回调里只读 `.ws-b` 的 4 个数字属性，读 DOM 不写 DOM，不会自激；
   *   ② 再挂一个低频兜底扫描（2.5s）：AI 层被整份替换（重画）时 observer 也只
   *      报「childList 变了」，兜底扫描保证不漏。 */
  let mo: MutationObserver | null = null;
  let boxRo: ResizeObserver | null = null;
  let sweep: number | null = null;
  let scheduled = false;

  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    void nextTick(() => {
      scheduled = false;
      refresh();
      // 画布可能刚被整份重建（AI 重绘）→ 信箱折算要跟着重量
      measureBox();
    });
  }

  onMounted(() => {
    refresh();
    if (typeof MutationObserver !== "undefined" && props.watchDom && !props.rects) {
      const host = document.querySelector(".ws-neigh__ai");
      if (host) {
        mo = new MutationObserver(scheduleRefresh);
        mo.observe(host, { childList: true, subtree: true });
      }
    }
    sweep = window.setInterval(() => {
      refresh();
      measureBox();
    }, 2500);
    if (typeof ResizeObserver !== "undefined") {
      // 盒子长宽比变了（旋屏、软键盘、横竖屏分档）→ 留白也变了，必须重量。
      // 观察 `.ws-neigh__ai`（它随盒子伸缩），而不是这一层自己（它被我们的
      // transform 影响，用自身尺寸当输入会形成回环）。
      const boxHost = document.querySelector(".ws-neigh__ai");
      if (boxHost) {
        boxRo = new ResizeObserver(() => measureBox());
        boxRo.observe(boxHost);
      }
    }
  });

  onBeforeUnmount(() => {
    mo?.disconnect();
    mo = null;
    boxRo?.disconnect();
    boxRo = null;
    if (sweep !== null) window.clearInterval(sweep);
    sweep = null;
  });

  // 天黑程度从 0 → 正数时补读一次（白天整层是空的，那时 DOM 里可能已经攒了楼）
  watch(
    () => props.night > 0,
    (on) => {
      if (on) scheduleRefresh();
    }
  );
</script>

<style scoped>
  /* 与 `.ws-avs`（人物层）同款：绝对定位铺满手势容器、绝不吃掉地图手势 */
  .ws-win {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2;
  }
  /* 窗户光不该每一帧重算合成：给它一点淡入，跨过「开灯时刻」时不要「啪」地亮 */
  .ws-win rect {
    transition: fill 1.2s ease;
  }
  .ws-root.ws-perf-low .ws-win rect {
    transition: none;
  }
</style>
