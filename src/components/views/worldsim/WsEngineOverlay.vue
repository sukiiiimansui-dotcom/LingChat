<template>
  <!-- 实验性 3D 引擎叠加层（`?engine=1`）。
       关着时这里**不产 DOM**（`v-if`）⇒ 与接入前完全一致；开着时它盖在地图之上但要
       `pointer-events:none`，拖动/缩放/旋转仍然全归 MapLibre。
       尺寸跟随宿主（`inset:0`），父容器是 `.ws-sceneview`，与地图同尺寸同位置。 -->
  <div v-if="on" class="ws-engineov" data-ws-engine="1">
    <iframe
      ref="frameEl"
      class="ws-engineov__f"
      :src="src"
      title="3D 引擎叠加层（实验）"
      allow="same-origin"
      referrerpolicy="no-referrer"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
/* WsEngineOverlay.vue —— 把 `public/ws3d/engine/engine_overlay.html` 当 iframe 叠到地图上。
 *
 * 口径与坑写在 `wsEngineOverlay.ts` 里（开关、默认关、阶段②只做"可见"不做相机同步）。
 * 这里只负责 DOM：一层 `position:absolute; inset:0` 的容器 + 里面 100% 的 iframe。
 *
 * 为什么 iframe 要单独写 `pointer-events:none`：容器上的 `pointer-events:none` 对 iframe
 * 内部文档**不生效**（iframe 是独立浏览上下文，会把事件吃进自己的 document）。
 * 两处都写，才是真的"输入不接管"；否则用户在地图上拖动时鼠标一旦划过叠加层就断手。
 */

import { onBeforeUnmount, ref } from "vue";
import { bindEngineFrame, engineOverlayOn, engineOverlaySrc } from "./wsEngineOverlay";

const on = engineOverlayOn;
const src = engineOverlaySrc();

/* iframe 载入后才拿得到 contentWindow：把它登记给 `wsEngineOverlay`，
   宿主那边的 rAF 循环（≤30Hz）才有地方投 `w3d:hostview`。 */
const frameEl = ref<HTMLIFrameElement | null>(null);
function onFrameLoad(): void {
  bindEngineFrame(frameEl.value?.contentWindow ?? null);
}
onBeforeUnmount(() => bindEngineFrame(null));
</script>

<style scoped>
/* 与 `.ws-sceneview__overlay`（canvas 版叠加层的宿主）同尺寸同定位，只是内容换成 iframe。
   z-index 不设：同层按 DOM 顺序压在地图之上、HUD 之下即可，避免和 HUD 抢层级。 */
.ws-engineov {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background: transparent;
}

.ws-engineov__f {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: transparent;
  pointer-events: none;
  color-scheme: normal;
}
</style>
