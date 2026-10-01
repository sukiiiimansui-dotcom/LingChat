<!--
  WsToasts.vue —— 「世界模拟」toast 队列的**唯一**渲染处（切片①，2026-10-01）

  ## 为什么要有这个组件
  `wsToast()`（`wsToast.ts`）只是往一个**模块级队列**里推消息 —— 队列得有人渲染才看得见。
  这个渲染原先只有一处：孤儿页 `WorldSim.vue` 里的那几行 `<div class="ws-toasts">`。
  切片① 把悬浮手机挂回 `/worldsim`（`WsSceneView.vue`）之后，**新入口没有这个渲染处** ——
  实测（`~/chk/_phone_probe.mjs`，2026-10-01）：点「音乐」「我的」两个没接进来的应用，
  面板行为对（不换页），但**页面上一个字都没出现** ＝ 机主最烦的"点了没反应"。

  ⇒ 把这段渲染收成一个组件，两个宿主都挂它（PR 门禁 C1：不许第二份实现）。

  ## 两个宿主各挂一次，**不能同时挂两个**
  `items` 是模块级单例（不是 per-instance），两个宿主同时渲染会**弹两条一样的**。
  所以：老宿主 `WorldSim.vue` 挂一处；新宿主 `WsSceneView.vue` **跟着 `phone` 开关挂**
  （`phone=false` 时只有老宿主在渲染）。

  ## 样式为什么带兜底值
  令牌（`--ws-panel` / `--ws-border` / `--ws-shadow` / `--ws-blur`）定义在全局皮肤
  `src/assets/styles/worldsim.css` 的 `.ws-root.theme-*` 里 —— 而**新入口不渲染 `.ws-root`**，
  取不到那些变量。所以这里一律 `var(--令牌, 兜底值)`（与 `worldsim-trip.css` 同一条既有约定：
  单独用也不至于没颜色）。动画用自己的 `ws-toast-in` 关键帧，不依赖全局那一份。
-->
<template>
  <!-- 提示条：`aria-live` 让读屏也念出来；`pointer-events:none` ⇒ 不挡地图拖动 -->
  <div v-if="items.length" class="ws-toasts" aria-live="polite">
    <div v-for="m in items" :key="m.id" class="ws-toast" :class="`ws-toast--${m.kind}`">
      {{ m.text }}
    </div>
  </div>
</template>

<script setup lang="ts">
  import { useWsToast } from "./wsToast";

  /* 队列是模块级单例：这里只读，不负责清（清由需要它的宿主自己调 `useWsToast().clear()`）。 */
  const { items } = useWsToast();
</script>

<style scoped>
  .ws-toasts {
    position: absolute;
    left: 50%;
    bottom: 5.2em;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35em;
    pointer-events: none;
    z-index: 40;
  }
  .ws-toast {
    max-width: 22em;
    padding: 0.35em 0.85em;
    font-size: 0.94em;
    line-height: 1.6;
    border-radius: 999px;
    background: var(--ws-panel, rgba(7, 11, 17, 0.82));
    border: 1px solid var(--ws-border, rgba(121, 217, 255, 0.28));
    color: var(--ws-fg, #eaf6ff);
    box-shadow: var(--ws-shadow, 0 6px 24px rgba(0, 0, 0, 0.35));
    backdrop-filter: blur(var(--ws-blur, 10px));
    -webkit-backdrop-filter: blur(var(--ws-blur, 10px));
    animation: ws-toast-in 0.24s ease both;
  }
  .ws-toast--ok {
    border-color: var(--ws-ok, #6cc39a);
  }
  .ws-toast--warn {
    border-color: var(--ws-warn, #ffcf8a);
  }
  .ws-toast--err {
    border-color: var(--ws-err, #ff8a8a);
  }
  @keyframes ws-toast-in {
    from {
      opacity: 0;
      transform: translateY(0.4em);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
