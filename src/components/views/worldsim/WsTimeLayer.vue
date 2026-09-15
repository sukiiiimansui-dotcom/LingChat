<!--
  「世界模拟」T4-1：昼夜色调覆盖层

  它做什么：把当前位置的「一天的哪个时刻」变成整张地图上的一层色
  （黎明紫粉 / 正午透明 / 黄昏橙红 / 夜晚深蓝）。色值全部来自 `wsTime.ts::timeTint()`。

  ── 为什么是一层覆盖，而不是去改地图的颜色 ────────────────────────────────
    ① 地图是**后端画好的 SVG**（国/省/市/区县走 `/api/geo_svg`，小区走 `DistrictCanvas`），
       前端没有「图上每一个颜色」的清单，逐元素着色等于把后端的配色抄一份到前端；
    ② 老线（`public/world_map/world_time.js::applyTimeTint`）本来也是「一张半透明色
       盖在整张 canvas 上」—— 覆盖层与它同口径，只是把 `ctx.fillRect` 换成 DOM；
    ③ 覆盖层与地图**解耦**：换地图风格（gaode/dark/water）、换缩放、AI 精绘重画，
       这一层都不用跟着改。

  ── 位置 ──────────────────────────────────────────────────────────────────
    `position: absolute; inset: 0` —— 铺满**包含块**，而包含块就是最近的定位祖先：
    页面里是 `<main class="ws-stage">`（它本来就是 `position: relative`）。
    于是这一层天然只盖住地图舞台，顶栏/信息行/底栏一个都不碰，
    **不需要量任何高度**（顶栏流式、底栏在宽扁屏那档会变悬浮，量它必错）。

  ── 不吃事件、不进无障碍树 ────────────────────────────────────────────────
    `pointer-events: none`：地图的点击/拖拽/缩放必须原样穿过去；
    `aria-hidden="true"`：它纯粹是观感，读屏软件不该念它。
-->
<template>
  <div class="ws-tod" :class="{ 'is-night': night > 0 }" aria-hidden="true" data-ws-tod>
    <!-- 色调层：`css` 就是 timeTint() 给出的 rgba -->
    <div class="ws-tod__tint" :style="{ background: tint.css }" />
    <!-- 地平线暖光：只在清晨/黄昏出现（`warm` 为 0 时整层不渲染） -->
    <div v-if="warm > 0" class="ws-tod__warm" :style="{ opacity: String(warm) }" />
  </div>
</template>

<script setup lang="ts">
  import { computed } from "vue";
  import type { WsTimeTint } from "./wsTime";

  const props = defineProps<{
    /** 昼夜色调（`wsTime.ts::timeTint(hour)` 的返回值） */
    tint: WsTimeTint;
    /** 天黑程度 0..1（`wsTime.ts::nightLevel(hour)`） */
    night: number;
  }>();

  /**
   * 地平线暖光的强度：只在日出/日落前后出现，正午与深夜都是 0。
   * 为什么单独一层：单一 rgba 平涂会把天空和地面染成一个色，
   * 加一层「底部偏暖」的渐变，黄昏才有「太阳在地平线上」的方向感。
   */
  const warm = computed(() => {
    const h = props.tint.hour;
    if (h >= 4.5 && h <= 9) return Math.round((1 - Math.abs(h - 6.5) / 2.5) * 100) / 100;
    if (h >= 15.5 && h <= 20.5) return Math.round((1 - Math.abs(h - 18) / 2.5) * 100) / 100;
    return 0;
  });
</script>

<style scoped>
  /* 铺满**包含块**。包含块是最近的定位祖先：主应用里就是 `<main class="ws-stage">`
     （它本来就是 `position: relative`），所以在页面里这一层天然只盖住地图舞台 ——
     顶栏、信息行、底栏一个都不碰，**不需要量任何高度**。
     （第一版曾按"顶栏多高/底栏多高"实测再内联 top/bottom，是多余的复杂度。） */
  .ws-tod {
    position: absolute;
    inset: 0;
    /* 地图的点击/拖拽/缩放必须原样穿过这一层 */
    pointer-events: none;
    /* 盖在地图之上、人物与面板之下（那些是 z-index 3 起）：
       色是给「地面」上的，不该把人脸也染蓝 */
    z-index: 1;
    overflow: hidden;
    /* 时段切换（跨整点/回前台对表）时淡一下，别「啪」地跳 */
    transition: opacity 0.6s ease;
  }
  .ws-tod__tint {
    position: absolute;
    inset: 0;
    transition: background 0.6s ease;
  }
  /* 地平线暖光：底部一条暖色带，向上融掉。色相取自黄昏关键帧（255,126,64） */
  .ws-tod__warm {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 46%;
    background: linear-gradient(
      to top,
      rgba(255, 138, 74, 0.42) 0%,
      rgba(255, 168, 108, 0.18) 45%,
      rgba(255, 190, 140, 0) 100%
    );
    transition: opacity 0.6s ease;
  }

  /* 低端机（P5-5 的 `ws-perf-low`）：过渡也关掉 —— 它在合成器上要一直重绘。
     色值本身一个都不改，只是「不淡入」。 */
  .ws-root.ws-perf-low .ws-tod,
  .ws-root.ws-perf-low .ws-tod__tint,
  .ws-root.ws-perf-low .ws-tod__warm {
    transition: none;
  }
</style>
