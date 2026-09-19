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

      <!-- 应用页：目前只接了「地图/导航」（T5-2）；其余点了会如实提示「还没接进来」 -->
      <!--
        MG 切片 B（2026-09-19）：「首页 ↔ 应用」的转场**带方向**。

        为什么要有方向：这两页的关系是**上下层**（首页是"桌面"，应用是"进去之后"），
        不是"两个平级的页面"。方向动画就是把这层关系画出来 ——
        · 进应用：旧页往左退、新页从右边滑进来（"往里走"）；
        · 返回首页：整个镜像过来（"退出来"）。
        用户不用读文字，光看方向就知道自己是进去了还是出来了。

        `mode="out-in"`：先退旧的再进新的。两页同时占位的话，面板高度会被顶一下
        （一页高、一页矮），那一下抖动比没有动画更糟。
      -->
      <Transition :name="navDir === 'in' ? 'wsnav-in' : 'wsnav-back'" mode="out-in">
        <div v-if="app" class="wsphone__app-view">
          <div class="wsphone__appbar">
            <button class="wsphone__back" type="button" @click="goHome">‹ 返回</button>
            <span class="wsphone__appname">{{ appName }}</span>
          </div>
          <WsPhoneNav v-if="app === 'map'" />
          <WsPhoneTaxi v-else-if="app === 'taxi'" />
          <WsPhoneTransit v-else-if="app === 'transit'" />
          <WsPhonePlan v-else-if="app === 'plan'" />
          <WsPhoneChat v-else-if="app === 'chat'" />
          <WsPhoneWeather v-else-if="app === 'weather'" />
        </div>

        <div v-else class="wsphone__grid">
          <button
            v-for="a in APPS"
            :key="a.key"
            class="wsphone__app"
            type="button"
            :title="a.hint"
            @click="onApp(a.key)"
          >
            <span class="wsphone__ico">{{ a.icon }}</span>
            <span class="wsphone__nm">{{ a.name }}</span>
            <span class="wsphone__todo">{{ a.todo }}</span>
          </button>
        </div>
      </Transition>

      <div class="wsphone__foot">{{ t("worldsim.phone.footHint") }}</div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
  import { computed, onMounted, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import WsPhoneNav from "./WsPhoneNav.vue";
  import WsPhoneTaxi from "./WsPhoneTaxi.vue";
  import WsPhoneTransit from "./WsPhoneTransit.vue";
  import WsPhonePlan from "./WsPhonePlan.vue";
  import WsPhoneChat from "./WsPhoneChat.vue";
  import WsPhoneWeather from "./WsPhoneWeather.vue";

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
    { key: "weather", icon: "⛅", name: "天气", todo: "T5-7", hint: "当前天气 + 与地图角标同源（T5-7）" },
    { key: "music", icon: "🎵", name: "音乐", todo: "T5-8", hint: "接 LingChat 网易云服务（T5-8）" },
    { key: "me", icon: "🙂", name: "我的", todo: "—", hint: "角色/玩家信息入口" },
  ] as const;

  const KEY = "ws.phone.open";
  const open = ref(false);
  /** 当前打开的应用 key（'' = 首页 8 宫格）。已接的只有 map（T5-2）。 */
  const app = ref("");
  const appName = computed(() => APPS.find((a) => a.key === app.value)?.name || "");

  function readSaved(): boolean {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  }
  /** 已接的应用清单：T5-3~T5-8 落地时**加到这里**并把 WsPhoneNav 换成对应组件 */
  const READY = new Set(["map", "taxi", "transit", "plan", "chat", "weather"]);

  /**
   * 转场方向（MG 切片 B）：`in` = 进应用（往左走），`back` = 返回首页（往右走）。
   *
   * ⚠️ 为什么用一个变量记方向，而不是让 CSS 自己猜：
   *    `<Transition>` 的 `name` 是**响应式读的**，`app` 一变、name 立刻就是新值 ——
   *    离开和进入会同时用上新方向，方向感就丢了。所以方向必须在**改 `app` 之前**定好。
   *    这不是绕路：真实产品里"往哪走"本来就是一次导航的意图，本来就该在动作发生时定下来。
   */
  const navDir = ref<"in" | "back">("in");

  function onApp(key: string) {
    if (READY.has(key)) {
      navDir.value = "in"; // 先进去，再换页
      app.value = key;
      return;
    }
    emit("open-app", key); // 交给外层如实提示"还没接进来"
  }

  /** 返回首页：方向相反（同一个函数，两处入口：返回键 + 收起手机） */
  function goHome() {
    navDir.value = "back";
    app.value = "";
  }

  function toggle(v: boolean) {
    open.value = v;
    if (!v) app.value = ""; // 收起时回到首页，下次打开是干净的
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
    /* MG 切片 B（2026-09-19）：缩放的中心定在**悬浮按钮的圆心**上
       （按钮 52×52、右边距 14 → 圆心在面板右下角的外侧 26px 处；
        按钮底边与面板底边同在 96px，所以圆心比面板底边矮 26px）。
       于是展开时手机像是"从按钮里长出来"的 —— 这正是 MD3 说的 Container Transform：
       用户一眼看出"这块面板和那个按钮是同一个东西"。
       ⚠️ 别改成 right bottom：那样是从角落硬撑开，和按钮没有关系。 */
    transform-origin: calc(100% - 26px) calc(100% + 26px);
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

  .wsphone__app-view {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    /* 🔴 必须能滚：手机面板的 `max-height: min(430px, 100vh-140px)` 会裁掉超高内容，
       而天气（T5-7）比面板高 —— 不滚的话下半截（六格数据 + 数据源 + 「在地图上看」）
       在 DOM 里有、屏幕上够不着（2026-09-18 实测：932×430 里只看到主卡的上半部分）。
       这是**外壳**的修正，T5-2~T5-8 的所有应用一起受益。 */
    flex: 1 1 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .wsphone__appbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 2px 2px;
  }
  .wsphone__back {
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    cursor: pointer;
  }
  .wsphone__back:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
  .wsphone__appname {
    font-size: 12.5px;
    font-weight: 600;
  }

  .wsphone__grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 8px;
    overflow-y: auto;
    padding: 2px;
  }
  .wsphone__app {
    position: relative;
    overflow: hidden; /* 按下时荡开的那圈高光要靠它裁成圆角 */
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
    /* MG 切片 B：按下时整块**缩一点**（0.94），松手弹回 —— 这是最便宜也最有效的
       "按到了"反馈。transform 只走合成，8 个图标一起按也不会掉帧。 */
    transition:
      background 0.14s linear,
      transform 0.16s cubic-bezier(0.2, 0, 0, 1);
  }
  .wsphone__app:hover {
    background: rgba(53, 211, 154, 0.16);
  }
  .wsphone__app:active {
    transform: scale(0.94);
  }
  .wsphone__ico {
    font-size: 20px;
    line-height: 1;
    /* 图标反着来：外框压扁的同时图标**弹大一点**（一压一弹 = 有回弹的错觉） */
    transition: transform 0.16s cubic-bezier(0.2, 0, 0, 1);
  }
  .wsphone__app:active .wsphone__ico {
    transform: scale(1.14);
  }
  /* 按下时从图标处荡开的一圈高光。一次性（按一次放一次），不循环、不占常驻合成层。 */
  .wsphone__app::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.42), transparent 68%);
    opacity: 0;
    pointer-events: none; /* 装饰不吃点击 */
  }
  .wsphone__app:active::after {
    animation: wsp-tap 0.36s ease-out;
  }
  @keyframes wsp-tap {
    from {
      opacity: 0.85;
      transform: scale(0.55);
    }
    to {
      opacity: 0;
      transform: scale(1.2);
    }
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
  /* MG 切片 B：展开曲线带**过冲**（0.34, 1.4, 0.64, 1 里的 1.4 > 1 就是过冲）——
     手机"弹"出来一点点再落定，就是机主要的"惯性/回弹"。
     回落只有 0.2s 且用加速曲线：关掉要干脆，不要拖泥带水。 */
  .wsphone-enter-active {
    transition:
      transform 0.34s cubic-bezier(0.34, 1.4, 0.64, 1),
      opacity 0.22s cubic-bezier(0, 0, 0, 1);
  }
  .wsphone-leave-active {
    transition:
      transform 0.2s cubic-bezier(0.3, 0, 1, 1),
      opacity 0.16s cubic-bezier(0.3, 0, 1, 1);
  }
  .wsphone-enter-from,
  .wsphone-leave-to {
    opacity: 0;
    /* 从按钮那个角"长出来"：配合上面的 transform-origin，位移要更小才自然 */
    transform: translateY(10px) scale(0.88);
  }

  /* ── MG 切片 B：首页 ↔ 应用 的方向感转场 ─────────────────────────────────
     两套（in / back）互为镜像。时长照 MD3 移动端基准：
     进入 decelerate（快起慢停）220~260ms，离开 accelerate（慢起快走）140~160ms。
     只动 transform / opacity；`mode="out-in"` 保证同一时刻只有一页在流里。 */
  .wsnav-in-enter-active,
  .wsnav-back-enter-active {
    transition:
      opacity 0.22s cubic-bezier(0, 0, 0, 1),
      transform 0.26s cubic-bezier(0, 0, 0, 1);
  }
  .wsnav-in-leave-active,
  .wsnav-back-leave-active {
    transition:
      opacity 0.14s cubic-bezier(0.3, 0, 1, 1),
      transform 0.16s cubic-bezier(0.3, 0, 1, 1);
  }
  /* 进应用：旧页往左退、新页从右边进来 */
  .wsnav-in-enter-from {
    opacity: 0;
    transform: translateX(18px) scale(0.985);
  }
  .wsnav-in-leave-to {
    opacity: 0;
    transform: translateX(-12px) scale(0.985);
  }
  /* 回首页：整个镜像过来 —— 方向本身就是语义 */
  .wsnav-back-enter-from {
    opacity: 0;
    transform: translateX(-18px) scale(0.985);
  }
  .wsnav-back-leave-to {
    opacity: 0;
    transform: translateX(12px) scale(0.985);
  }
  @media (prefers-reduced-motion: reduce) {
    .wsphone-enter-active,
    .wsphone-leave-active,
    .wsnav-in-enter-active,
    .wsnav-in-leave-active,
    .wsnav-back-enter-active,
    .wsnav-back-leave-active,
    .wsphone__app,
    .wsphone__ico {
      transition: none;
    }
    /* 按下时那圈荡开的高光是一次性装饰 —— 关掉不影响任何功能反馈
       （按下仍然会缩，因为那是瞬时状态，不是动画） */
    .wsphone__app:active::after {
      animation: none;
    }
  }
</style>
