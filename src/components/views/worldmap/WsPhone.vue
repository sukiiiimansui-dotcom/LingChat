<!--
  WsPhone.vue —— 「悬浮手机」的**入口外壳**（T5-1）

  ## 为什么需要它
  `worldmap/PhoneOverlay.vue`（861 行）是**全屏预览页**：`position:fixed; inset:0; z-index:50`，
  还依赖 `useRouter` / `useWorldMapLayer`。它是"形态预览"，**不是能随手掏出来的手机**。
  八项功能（T5-2~T5-8）也还没有入口 —— 本组件补的就是这个入口，并把 8 个位置留出来。

  ## 形态（按任务卡的"建议 b+c"）
  · **b) 聊天界面右下角常驻悬浮按钮** —— 一键呼出（本组件实现）
  · c) 长按地图上的角色也能打开 —— 依赖世界模拟页，留给后续（本组件对外暴露 `open()`）
  按卡片原话：「手机该像手机一样随手能掏出来」。

  ## 与其他浮层的共存（卡片第 2 条）
  用**集中式 z-index 令牌**定规矩，别各处硬编码：
      --z-ws-overlay: 40   （世界模拟叠加层，T6-2 用）
      --z-ws-phone:   60   （手机**在上** —— 卡片明确要求）
      --z-ws-toast:   80   （提示，最上）
  T6-2 实现叠加层时必须用 `var(--z-ws-overlay)`，否则两边会互相盖。

  ## 收放记忆（卡片第 3 条）
  用户的展开/收起偏好写 localStorage（`ws.phone.open`），跨会话记住。
  ⚠️ 只记"偏好"，**不自动弹出** —— 打开应用时手机不该自己跳出来挡聊天。

  ## 安全区（卡片第 4 条）
  按钮与面板都用 `env(safe-area-inset-*)` 让开刘海与手势条。
-->
<template>
  <!-- 悬浮按钮：聊天页右下角常驻。默认不挡内容：它自己 52×52，且避开安全区 -->
  <button
    v-if="!open"
    class="wsphone-fab"
    type="button"
    :title="t('worldsim.phone.open')"
    @click="toggle(true)"
  >
    <span class="wsphone-fab__ico">📱</span>
  </button>

  <!-- 手机面板：贴右下角的"手机"卡片，不是全屏遮罩（不挡聊天） -->
  <Transition name="wsphone">
    <div v-if="open" class="wsphone" role="dialog" :aria-label="t('worldsim.phone.title')">
      <div class="wsphone__bar">
        <span class="wsphone__title">📱 {{ t("worldsim.phone.title") }}</span>
        <span class="wsphone__spacer" />
        <button class="wsphone__x" type="button" :title="t('worldsim.phone.close')" @click="toggle(false)">
          ✕
        </button>
      </div>

      <div class="wsphone__grid">
        <button
          v-for="a in APPS"
          :key="a.key"
          class="wsphone__app"
          type="button"
          :title="a.hint"
          @click="emit('open-app', a.key)"
        >
          <span class="wsphone__ico">{{ a.icon }}</span>
          <span class="wsphone__nm">{{ a.name }}</span>
          <span class="wsphone__todo">{{ a.todo }}</span>
        </button>
      </div>

      <div class="wsphone__foot">{{ t("worldsim.phone.footHint") }}</div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
  import { onMounted, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";

  const { t } = useI18n();

  const emit = defineEmits<{
    /** 点了某个应用 —— T5-2~T5-8 接这里 */
    (e: "open-app", key: string): void;
    (e: "toggle", open: boolean): void;
  }>();

  /**
   * 八项功能 = T5-2~T5-8 的落点。
   * `todo` 字段是**诚实的占位标记**：卡片还没做就不假装能用（机主明确讨厌假数据）。
   */
  const APPS = [
    { key: "map", icon: "🗺", name: "地图/导航", todo: "T5-2", hint: "地图与真实路径规划（T5-2）" },
    { key: "taxi", icon: "🚕", name: "打车", todo: "T5-3", hint: "接行程状态机 + 地图车辆联动（T5-3）" },
    { key: "transit", icon: "🚇", name: "公交地铁", todo: "T5-4", hint: "真实换乘与票价（T5-4）" },
    { key: "chat", icon: "💬", name: "通讯", todo: "T5-5", hint: "接 LingChat 真实对话与角色（T5-5）" },
    { key: "plan", icon: "🗓", name: "日程待办", todo: "T5-6", hint: "接地图联动（T5-6）" },
    { key: "weather", icon: "⛅", name: "天气", todo: "T5-7", hint: "依赖 T0-3 的 weather 命令（T5-7）" },
    { key: "music", icon: "🎵", name: "音乐", todo: "T5-8", hint: "接 LingChat 网易云服务（T5-8）" },
    { key: "me", icon: "🙂", name: "我的", todo: "—", hint: "角色/玩家信息入口" },
  ] as const;

  const KEY = "ws.phone.open";
  const open = ref(false);

  function readSaved(): boolean {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  }
  function toggle(v: boolean) {
    open.value = v;
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* 隐私模式等场景写不进去就算了，不影响功能 */
    }
    emit("toggle", v);
  }

  onMounted(() => {
    /* 可访问性/可预期性：**不自动展开**。
       记忆的是"用户上次的偏好"，下次他再点开时我们仍然从收起态开始 ——
       一个会自动弹出来挡聊天的手机，比没有手机更烦。 */
    open.value = false;
    savedPref = readSaved();
  });
  let savedPref = false;
  /** 供父组件/世界模拟页调用（卡片第 1 条的 c：长按角色也能开） */
  defineExpose({ open: () => toggle(true), close: () => toggle(false), isOpen: () => open.value, pref: () => savedPref });

  watch(open, (v) => {
    if (!v) return;
    // 展开时把焦点交给第一个应用，键盘/读屏用户不用摸黑
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".wsphone__app")?.focus();
    });
  });
</script>

<style scoped>
  /* z-index 令牌：手机在叠加层之上（T6-2 的叠加层请用 --z-ws-overlay） */
  :root {
    --z-ws-overlay: 40;
    --z-ws-phone: 60;
    --z-ws-toast: 80;
  }

  .wsphone-fab {
    position: fixed;
    right: calc(14px + env(safe-area-inset-right, 0px));
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-ws-phone, 60);
    width: 52px;
    height: 52px;
    border-radius: 17px;
    border: 0;
    cursor: pointer;
    background: rgba(18, 26, 36, 0.72);
    backdrop-filter: saturate(1.2) blur(12px);
    -webkit-backdrop-filter: saturate(1.2) blur(12px);
    box-shadow:
      0 10px 26px rgba(0, 0, 0, 0.42),
      inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-size: 22px;
    line-height: 1;
    transition: transform 0.16s cubic-bezier(0.2, 0, 0, 1);
  }
  .wsphone-fab:hover {
    transform: translateY(-1px);
  }
  .wsphone-fab:active {
    transform: translateY(0) scale(0.96);
  }

  /* 手机本体：右下角一块"手机"，**不是全屏遮罩** —— 卡片要求「不挡聊天」 */
  .wsphone {
    position: fixed;
    right: calc(14px + env(safe-area-inset-right, 0px));
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-ws-phone, 60);
    width: min(300px, calc(100vw - 28px));
    max-height: min(430px, calc(100vh - 140px));
    display: flex;
    flex-direction: column;
    border-radius: 22px;
    padding: 12px;
    background: rgba(14, 20, 28, 0.9);
    backdrop-filter: saturate(1.2) blur(16px);
    -webkit-backdrop-filter: saturate(1.2) blur(16px);
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.5),
      inset 0 0 0 1px rgba(255, 255, 255, 0.09);
    color: #fff;
    overflow: hidden;
  }
  .wsphone__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 10px;
  }
  .wsphone__title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .wsphone__spacer {
    flex: 1;
  }
  .wsphone__x {
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    font-size: 14px;
  }
  .wsphone__x:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  .wsphone__grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 8px;
    overflow-y: auto;
    padding: 2px;
  }
  .wsphone__app {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 9px 4px 7px;
    border: 0;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.05);
    color: #fff;
    cursor: pointer;
    /* 触控目标 ≥44×44（可达性判据） */
    min-height: 66px;
    transition: background 0.14s linear;
  }
  .wsphone__app:hover {
    background: rgba(53, 211, 154, 0.16);
  }
  .wsphone__ico {
    font-size: 20px;
    line-height: 1;
  }
  .wsphone__nm {
    font-size: 11px;
    line-height: 1.2;
  }
  .wsphone__todo {
    font-size: 9.5px;
    color: rgba(255, 255, 255, 0.4);
  }

  .wsphone__foot {
    padding: 10px 4px 2px;
    font-size: 11px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.42);
  }

  /* 收放动画：只动 transform / opacity（GPU 合成），进入 decelerate、离开 accelerate */
  .wsphone-enter-active {
    transition:
      transform 0.3s cubic-bezier(0, 0, 0, 1),
      opacity 0.3s cubic-bezier(0, 0, 0, 1);
  }
  .wsphone-leave-active {
    transition:
      transform 0.22s cubic-bezier(0.3, 0, 1, 1),
      opacity 0.22s cubic-bezier(0.3, 0, 1, 1);
  }
  .wsphone-enter-from,
  .wsphone-leave-to {
    opacity: 0;
    transform: translateY(14px) scale(0.96);
  }
  @media (prefers-reduced-motion: reduce) {
    .wsphone-enter-active,
    .wsphone-leave-active {
      transition: none;
    }
  }
</style>
