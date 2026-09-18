<!--
  「世界模拟」T4-3：**重大事件聚焦**（压暗全场 + 聚光灯 + 铭牌）

  ## 为什么要拆成两个渲染位（`variant`）
  压暗必须是**全场**的，而全场压暗只能由 `inset: 0` 的层来做；亮圈与铭牌则必须
  **跟着头像**（和它同一个手势变换坐标系）。两者在 DOM 上的位置不同：
      · `variant="veil"` —— WsAvatarLayer 的**直接子节点**（z-index:3，压在头像下面）
      · `variant="mark"` —— 同一层的**兄弟**（z-index:5，浮在头像上面）
  但它们的输入完全一样（队列 + 名单 + 盒子尺寸 + 缩放），几何也是同一套纯函数
  （`focusAnchorOf`）。拆成两个组件会把「谁是主角」这件事写两遍，
  所以做成一个组件的两个渲染位 —— 一次接线，两处都跟上。

  ## 与头像层的**唯一**跨组件契约
  被聚焦的那一枚头像会拿到 `.is-focused`（WsAvatarLayer 传的 `focused` prop），
  抬层靠 WsAvatarLayer 里那条 `:has()` 规则（必须由父级层叠上下文让路，
  头像自己加 z-index 抬不出来）。两个组件之间**不 import**、不互相调用。

  ## 坐标系（与气泡/头像**同一套**，改之前先读 WsAvatarMark 的定位三件套）
  `left/top` = 信箱折算后的盒子像素 → `translate(-50%,-50%)` 居中 → `scale(1/zoom)`
  抵消地图放大。盒子尺寸用 `offsetWidth/offsetHeight` 量（**不是** getBoundingClientRect：
  后者会被祖先的手势 transform 放大，量出来是错的 —— `WsVehicleMark` 踩过这个坑）。

  ## 镜头（camera）为什么在这里只画箭头
  `focusAnchorOf` / `cameraOffsetFor` 已把「该不该挪、该挪多少」算好，但**真挪**
  是手势层（useWorldSimGestures 的 tx/ty）的事，而那个实例在 `WsDistrict` 内部、
  没有对外 setter。所以本组件：① 目标在视口外时画一个指向箭头；
  ② 把平移量交给页面接线（见交回说明）。
  **不许**在这里偷偷改 DOM 的 transform —— 那会和手势的响应式状态打架，
  下一次手势就会把镜头弹回去（看起来像"聚焦闪了一下就没了"）。
-->
<template>
  <!-- ① 压暗 + 聚光灯：一个元素搞定（`radial-gradient` 的中心就是主角）。
       为什么用径向渐变而不是"挖一个洞的遮罩"：后者要 4 个 div 或 mask-image，
       在低端 WebView 上合成成本高得多；一个渐变零额外图层。 -->
  <div v-if="variant === 'veil'" class="ws-fxv" data-no-gesture aria-hidden="true">
    <div v-for="f in shown" :key="`d-${f.key}`" class="ws-fxv__dim" :style="dimStyleOf(f)" />
  </div>

  <!-- ② 亮圈 + 铭牌：挂在主角头上（每个换行写，避免行内元素被空格撑开） -->
  <div v-else ref="host" class="ws-fx" data-no-gesture aria-hidden="true">
    <div
      v-for="f in shown"
      :key="`c-${f.key}`"
      class="ws-fx__one"
      :class="[`ws-fx--${f.category}`, { 'is-lite': low, 'is-below': flipBelow(f) }]"
      :style="styleOf(f)"
    >
      <span v-if="!low" class="ws-fx__halo" />
      <span class="ws-fx__ring" />
      <span class="ws-fx__card">
        <span class="ws-fx__ico">{{ emojiOf(f) }}</span>
        <span class="ws-fx__nm">{{ f.role }}</span>
        <span v-if="f.title" class="ws-fx__tt">{{ f.title }}</span>
        <span v-if="offOf(f)" class="ws-fx__arrow">➤</span>
        <span v-if="!findActor(f.role)" class="ws-fx__nw">?</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
  import {
    focusAnchorOf,
    FOCUS_CATEGORY_EMOJI,
    type FocusCategory,
    type FocusQueueState,
    type WsFocusItem,
  } from "./wsFocus";
  import type { PlacedActor } from "./wsActors";

  const props = withDefaults(
    defineProps<{
      /** 渲染位：`veil` 只画压暗层；`mark` 只画亮圈 + 铭牌 */
      variant?: "veil" | "mark";
      /** 聚焦队列（`useWsFocus().queue`）—— 旧 → 新；没在聚焦时是 null/空队列 */
      queue: FocusQueueState | null;
      /** 地图上的人（用来把聚焦条目挂到对应头像上） */
      placed: PlacedActor[];
      /** 小区图网格边长（与 WsDistrict / 后端 sketch 一致） */
      grid?: number;
      /** 地图手势的缩放倍率（`WsDistrict` 的 gsScale） */
      zoom?: number;
      /** 低性能档：去掉光晕/旋转动画，只留一圈静态描边（见 wsPerf） */
      low?: boolean;
      /** 同屏最多画几条（默认 2，与 `FOCUS_MAX` 一致） */
      max?: number;
      /**
       * 信箱盒子的尺寸（**由调用方量好传进来**）。
       *
       * ⚠️ 为什么不能让本组件自己量（2026-09-18 实测踩到）：
       *   `variant="veil"` 与 `variant="mark"` 是**两个实例**。各自 `onMounted` 时量
       *   `offsetWidth` —— veil 那个实例挂载时机更早（深色主题切换/首帧布局未稳），
       *   实测量到 **0**，于是 `letterboxOf(1,1,28)` 算出 `scale = 1/28`，
       *   聚光灯中心被算成 `(0.5px, 0.2px)`、半径被夹到下限 8px —— 光斑跑到左上角去了。
       *   这不是"轻微偏移"，是**完全错位**，而且页面上不会报任何错。
       *   ⇒ 盒子只有**一个**真值来源：`WsAvatarLayer` 的 `useElementSize`。
       *   传进来之后两个变体必然一致，也省掉一次 ResizeObserver。
       */
      boxW?: number;
      boxH?: number;
    }>(),
    { variant: "mark", grid: 28, zoom: 1, low: false, max: 2, boxW: 0, boxH: 0 }
  );

  /** 模板只对顶层 ref 自动解包，这里就地取一下（与 WorldSim 的用法一致） */
  const shown = computed<WsFocusItem[]>(() => {
    const list = props.queue?.items || [];
    const cap = Math.max(1, Math.trunc(Number(props.max) || 1));
    // 取**最新**的 cap 条（队列旧→新，所以从尾部切）
    return list.length > cap ? list.slice(-cap) : list;
  });

  /** 类别 → emoji（与 useWorldEvents 的 WS_CATEGORY_META 同源，自检里有断言查一致性） */
  function emojiOf(f: { category: FocusCategory }): string {
    return FOCUS_CATEGORY_EMOJI[f.category] || "🔔";
  }

  /* ── 盒子尺寸 ──────────────────────────────────────────────────────────
   * 首选调用方传进来的 `boxW/boxH`（唯一真值来源，见 prop 注释）；
   * 没传才退回自己量（`offsetWidth` 不受祖先 transform 影响，这是老办法）。
   * 自己量时**必须等一帧**（nextTick）：挂载那一刻布局未必已稳，实测会量到 0。 */
  const host = ref<HTMLElement | null>(null);
  const ownW = ref(0);
  const ownH = ref(0);
  let ro: ResizeObserver | null = null;

  function measure() {
    const el = host.value;
    if (!el) return;
    const w = el.offsetWidth || el.clientWidth;
    const h = el.offsetHeight || el.clientHeight;
    if (w > 0) ownW.value = w;
    if (h > 0) ownH.value = h;
  }

  /** 真正参与几何计算的盒子尺寸：调用方给的优先 */
  const boxW = computed(() => (props.boxW > 0 ? props.boxW : ownW.value));
  const boxH = computed(() => (props.boxH > 0 ? props.boxH : ownH.value));

  onMounted(async () => {
    await nextTick();
    measure();
    if (typeof ResizeObserver !== "undefined" && host.value) {
      ro = new ResizeObserver(measure);
      ro.observe(host.value);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", measure);
    }
  });

  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
    if (typeof window !== "undefined") window.removeEventListener("resize", measure);
  });

  /** 聚焦条目挂在谁头上：先按名字，再退回目录名（两种键后端都可能给，与气泡同款） */
  function findActor(role: string): PlacedActor | null {
    const who = String(role || "").trim();
    if (!who) return null;
    return (
      props.placed.find((a) => a.name === who) || props.placed.find((a) => a.folder === who) || null
    );
  }

  /**
   * 这个人此刻在视口里吗。
   *
   * 用**真实的 DOM 矩形**（`getBoundingClientRect`）+ 视口尺寸判，不做几何推导：
   * 这一层拿不到手势的 tx/ty/scale（见组件头注释），硬算必然在缩放后失准；
   * 而 DOM 矩形里已经含着那套变换的结果 —— 这是唯一不会算错的口径。
   * 拿不到元素（还没渲染/角色不在场）→ 当作"在画面内"（不画箭头，免得误报）。
   *
   * 之所以在**渲染期**现算而不是事件发生时算一次：用户手动把地图拖过去以后，
   * 箭头必须自己消失。代价是同屏最多 2 次 `getBoundingClientRect`，很便宜。
   */
  function isOffscreen(a: PlacedActor | null): boolean {
    if (!a || typeof document === "undefined") return false;
    const el = document.querySelector(`.ws-av[data-actor="${a.id}"]`) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    if (!w || !h) return false;
    const pad = 16;
    return r.right < -pad || r.bottom < -pad || r.left > w + pad || r.top > h + pad;
  }

  /**
   * 渲染期现算的"在画面外"判定。
   *
   * 为什么不缓存：缓存要处理"队列换代/地图被拖动"两种失效，任何一处漏掉都会
   * 让箭头**留在屏幕上不消失**（那比"少画一个箭头"难查得多）。同屏最多 2 条，
   * 每条渲染一次 `getBoundingClientRect`，代价可以忽略 —— 用正确性换这点性能不值。
   */
  function offOf(f: WsFocusItem): boolean {
    return isOffscreen(findActor(f.role));
  }

  /**
   * 铭牌要不要翻到亮圈**下方**。
   *
   * 为什么需要它（2026-09-18 实测）：铭牌默认在亮圈上方 2.5em，锚点离屏幕上边近时
   * 它会被视口裁掉 —— 截图上只剩半行字。角色站在地图上半部分是**常态**
   * （小区图裁切后就那样），所以这不是边缘情况。
   *
   * 判据用**视口坐标**（`getBoundingClientRect().top + offsetTop` +
   * 祖先手势变换）：`offsetTop` 是布局坐标，两者相加才是它此刻在屏幕上的位置 ——
   * 手拖动/缩放地图时这个值会变，所以每次渲染现算（同屏最多 2 条，代价可忽略）。
   * 拿不到元素（还没渲染）→ 不翻（保持默认，不为了一个量不到的坐标改布局）。
   */
  const CARD_NEED_PX = 96;
  function flipBelow(f: WsFocusItem): boolean {
    if (typeof document === "undefined") return false;
    const el = document.querySelector(`.ws-av[data-actor="${findActor(f.role)?.id ?? ""}"]`);
    const host2 = host.value;
    if (!el || !host2) return false;
    const hostTop = host2.getBoundingClientRect().top;
    if (!hostTop) return false;
    // 用**头像中心**而不是上边缘：铭牌是相对锚点（中心）算距离的。
    // `offsetTop` 是"相对最近定位祖先"的布局坐标，这里只当**位移**用；
    // 平移量由 `hostTop`（真实视口坐标）提供 —— 缩放带来的比例差在判据里无关紧要
    // （我们只关心"离屏幕顶是不是不足一条铭牌的高度"）。
    const centerY = hostTop + (el as HTMLElement).offsetTop + el.clientHeight / 2;
    // 拿不到可信坐标（0/NaN）就不翻，宁可维持原样
    if (!Number.isFinite(centerY) || centerY <= 0) return false;
    return centerY < CARD_NEED_PX;
  }

  /** 落点（纯函数算，组件只拼 CSS） */
  function anchorOf(f: WsFocusItem) {
    const a = findActor(f.role);
    return focusAnchorOf(
      a ? { gx: a.gx, gy: a.gy, px: a.px, py: a.py } : null,
      boxW.value,
      boxH.value,
      props.grid,
      props.zoom
    );
  }

  /** 压暗层的样式：渐变中心 = 主角位置，亮圈半径用**屏幕像素** */
  function dimStyleOf(f: WsFocusItem): Record<string, string> {
    const anchor = anchorOf(f);
    // `radius` 是屏幕像素，而这一层会被父级放大 zoom 倍 ⇒ 布局坐标里要除以 zoom
    // （与气泡那个 `gap/zoom` 完全是同一个道理，见 bubbleAnchorOf 的 ③）
    const k = anchor.scale > 0 ? anchor.scale : 1;
    if (!anchor.found) {
      // 找不到人：不压暗（宁可什么都不做，也不把整屏压黑了却没主角）
      return { opacity: "0" };
    }
    return {
      "--ws-fx-x": `${anchor.x.toFixed(2)}px`,
      "--ws-fx-y": `${anchor.y.toFixed(2)}px`,
      "--ws-fx-r": `${(anchor.radius / k).toFixed(2)}px`,
    };
  }

  /** 亮圈/铭牌的样式（与头像同款三件套：left/top + translate(-50%,-50%) + scale(1/zoom)） */
  function styleOf(f: WsFocusItem): Record<string, string> {
    const anchor = anchorOf(f);
    if (!anchor.found) {
      return {
        left: "50%",
        top: "50%",
        transform: `translate(-50%, -50%) scale(${anchor.scale.toFixed(4)})`,
      };
    }
    return {
      left: `${anchor.x.toFixed(2)}px`,
      top: `${anchor.y.toFixed(2)}px`,
      transform: `translate(-50%, -50%) scale(${anchor.scale.toFixed(4)})`,
    };
  }
</script>

<style scoped>
  /* ── 压暗层（variant="veil"）：比头像低一层，聚光灯中心的那枚头像要能被"抬出来" ── */
  .ws-fxv {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 3;
  }
  .ws-fxv__dim {
    position: absolute;
    inset: 0;
    /* 一个径向渐变同时做两件事：中心留亮（聚光灯）+ 其余压暗。
       透明区到半透明区之间留一段过渡，硬边会像"一个圆洞"，软边才像"光打在他身上"。 */
    background: radial-gradient(
      circle var(--ws-fx-r, 60px) at var(--ws-fx-x, 50%) var(--ws-fx-y, 50%),
      rgba(0, 0, 0, 0) 0%,
      rgba(0, 0, 0, 0) 58%,
      rgba(0, 0, 0, 0.55) 100%
    );
    animation: ws-fx-dim 0.26s ease both;
  }

  /* ── 亮圈 + 铭牌（variant="mark"）──────────────────────────────────────── */
  .ws-fx {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* 浮在头像（z-index:4）之上；被聚焦的那一枚头像由父级的 `:has()` 规则抬到 9 */
    z-index: 5;
  }
  .ws-fx__one {
    position: absolute;
    /* 亮圈必须与头像**同心**，所以缩放不动点是中心（气泡那套的"底边中心"不适用） */
    transform-origin: 50% 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0;
    height: 0;
  }
  /* 外圈持续扩散的光晕（看起来像"心跳"而不是"闪烁"） */
  .ws-fx__halo,
  .ws-fx__ring {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 4.6em;
    height: 4.6em;
    margin: -2.3em 0 0 -2.3em;
    border-radius: 50%;
    border: 2px solid var(--ws-accent);
    box-shadow: 0 0 12px 2px rgba(120, 170, 255, 0.45);
  }
  .ws-fx__halo {
    animation: ws-fx-halo 1.5s ease-out infinite;
  }
  .ws-fx__ring {
    border-style: dashed;
    opacity: 0.9;
    animation: ws-fx-spin 6s linear infinite;
  }
  /* 低档：不要动画、不要光晕，只留一圈静态实线（一眼仍看得出聚焦到谁） */
  .ws-fx.is-lite .ws-fx__ring {
    border-style: solid;
    animation: none;
    box-shadow: none;
  }

  /* 铭牌：亮圈上方那一条"谁 + 什么事" */
  .ws-fx__card {
    position: absolute;
    left: 50%;
    bottom: 2.5em;
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    max-width: 13em;
    padding: 0.22em 0.5em;
    font-size: 0.86em;
    font-weight: 700;
    line-height: 1.45;
    white-space: nowrap;
    color: var(--ws-fg);
    background: var(--ws-panel);
    border: 1px solid var(--ws-accent);
    border-radius: 999px;
    box-shadow: var(--ws-shadow-lg);
    transform: translateX(-50%);
    animation: ws-fx-pop 0.24s ease both;
  }
  .ws-fx__nm {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ws-fx__tt {
    max-width: 7em;
    font-weight: 400;
    color: var(--ws-fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 锚点离屏幕上边太近 → 铭牌翻到亮圈**下方**（否则被视口裁掉，见 flipBelow 注释） */
  .ws-fx__one.is-below .ws-fx__card {
    top: 2.5em;
    bottom: auto;
  }
  /* 人在画面外：铭牌上多一个方向箭头（镜头没挪过去时唯一的提示） */
  .ws-fx__arrow {
    transform: rotate(-45deg);
    color: var(--ws-accent);
  }
  /* 名单里没这个人（后端给的角色名与地图上的名字对不上）：如实标一个 `?`，
     绝不假装"已经聚焦到某个人"—— 那种情况下亮圈挂在屏幕中央，一看就知道没对上 */
  .ws-fx__nw {
    color: var(--ws-warn, #d08700);
  }

  @keyframes ws-fx-dim {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes ws-fx-pop {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(6px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scale(1);
    }
  }
  @keyframes ws-fx-halo {
    0% {
      transform: scale(0.72);
      opacity: 0.85;
    }
    70% {
      transform: scale(1.5);
      opacity: 0;
    }
    100% {
      transform: scale(1.5);
      opacity: 0;
    }
  }
  @keyframes ws-fx-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
