<!--
  WsChatDrawer.vue —— 「走近说话」的**对话抽屉**（`PLAN-GAMEPLAY.md:69-76` · 期 3 第二节）。

  ## 它是什么，不是什么
  它是**地图这一屏里**的说话入口（阶段② 的边界：只长在地图屏内，`GAMEPLAY-AC-LIKE-V2.md:70` C-5）：
  走到角色附近 ⇒ 底部滑出一张抽屉 ⇒ 打一句话发出去。
  · **不是**聊天页：不碰主聊天页、不做会话切换、不显示历史记录（那些是 `MainChat` 的事）；
  · **不是**第二套对话协议：发出去走的还是既有 `send_chat_message`（宿主 `WsCityEntry.vue` 调），
    这里**一个 invoke 都没有** —— 组件只管"显示 + 收集这一句话"（与 `WsGiftSheet` 同一分工）。
  · **判词照读**：附近有几个人、距离多少、数不出来为什么，全部由 `wsNearby` 判，
    本组件只把 `nearText` 原样上屏（`{{ }}`，**不是** Markdown 渲染器 ⇒ 文案里不许写 `**`）。

  ## 两条硬约束（本仓前科）
  ① **不许吞地图手势**：`WsCharPanel` 那次事故（`WsCharPanel.vue:26-33`）是根元素 `inset:0` 还
     `.stop` 掉指针 ⇒ 整屏地图拖不动。这里照它的结论办：根 `pointer-events:none`，
     只有**面板本体**与**遮罩**接事件并 `.stop`，其余地方照旧能拖地图。
  ② **不许毛玻璃**：这一屏底下是每帧重画的 WebGL 画布，`backdrop-filter` 只要不是 `none`
     就每帧读回像素（`worldsim.css:198-201`、`DESIGN-MG-MOTION.md:41` R1）⇒ 本组件不写它，
     宿主那份 `.wsce.ws-root { --ws-blur: none }` 也顺手把继承来的压成 `none`。

  ## 动效
  进出只有 `transform` + `opacity`（`ws-slide-up` / 遮罩淡入），200~300ms（`UI-DESIGN-SPEC.md:65`）；
  两条降级面都给了：`low`（低性能档 ⇒ 整段动画关掉）与系统级 `prefers-reduced-motion`
  （`worldsim.css:273-281` 那条全局规则会把时长压到 0.001ms，自动只留终态）。
  触控目标 ≥44×44（`UI-DESIGN-SPEC.md:112`）。
-->
<template>
  <div class="wscd" data-no-gesture>
    <!-- 点空白 = 收起（宽屏只盖底部一条，地图其余部分照常能拖） -->
    <div
      class="wscd__mask"
      @click="emit('close')"
      @pointerdown.stop
      @pointerup.stop
      @wheel.stop
    />

    <aside
      class="wscd__panel ws-card"
      :class="{ 'wscd__panel--low': low }"
      role="dialog"
      aria-modal="false"
      :aria-label="t('worldsim.chatDrawer.title')"
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
      @wheel.stop
      @dblclick.stop
    >
      <header class="wscd__head">
        <span class="wscd__av" aria-hidden="true">{{ initial }}</span>
        <div class="wscd__who">
          <div class="wscd__name">{{ role?.name || t('worldsim.chatDrawer.noWho') }}</div>
          <!-- 🔴 判词原样上屏（三态：正数 / 0（已量） / 数不出来 + 原因）。空串 = 还没判过，
               不硬凑一句话（宁可不写，也不写一句像模像样的假话）。 -->
          <div v-if="nearText" class="wscd__near">{{ nearText }}</div>
        </div>
        <button
          class="ws-btn ws-btn--ghost wscd__x"
          type="button"
          :title="t('worldsim.chatDrawer.close')"
          @click="emit('close')"
        >
          ▾
        </button>
      </header>

      <div class="wscd__body">
        <div v-if="!messages.length" class="wscd__empty">{{ t('worldsim.chatDrawer.empty') }}</div>
        <div
          v-for="(m, i) in messages"
          :key="`${m.at}-${i}`"
          class="wscd__row"
          :class="{ 'wscd__row--me': m.me }"
        >
          <span class="wscd__bubble">{{ m.text }}</span>
        </div>
        <div v-if="busy" class="wscd__row wscd__row--me">
          <span class="wscd__bubble wscd__bubble--dim">{{ t('worldsim.chatDrawer.sending') }}</span>
        </div>
      </div>

      <footer class="wscd__foot">
        <!-- 透明契约：这一句除了你的正文，还会带上什么（**原样**显示将要拼上去的那一截）。
             没拿到世界状态时如实说"只会看到你这句话"，绝不假装带了上下文。 -->
        <div class="wscd__prefix" :class="{ 'wscd__prefix--none': !prefix }">
          {{ prefix ? t('worldsim.chatDrawer.prefix', { text: prefix }) : t('worldsim.chatDrawer.noPrefix') }}
        </div>
        <div class="wscd__input">
          <textarea
            ref="box"
            v-model="draft"
            class="wscd__ta"
            rows="2"
            :placeholder="t('worldsim.chatDrawer.placeholder')"
            :disabled="busy || !role || !canSend"
            @keydown.enter.exact.prevent="submit"
          />
          <div class="wscd__ops">
            <button
              class="ws-btn wscd__outing"
              type="button"
              :disabled="busy || !role"
              :title="t('worldsim.action.hint')"
              @click="emit('outing')"
            >
              🚶 {{ t('worldsim.action.outing') }}
            </button>
            <button
              class="ws-btn ws-btn--primary wscd__send"
              type="button"
              :disabled="busy || !role || !canSend || !draft.trim()"
              @click="submit"
            >
              {{ t('worldsim.chatDrawer.send') }}
            </button>
          </div>
        </div>
        <!-- 发不出去时给一条**能走通的路**（而不是只说"不行"）：跳聊天页把 ta 选成当前角色。
             为什么会发不出去：`send_chat_message` 没有角色参数，它发给的是**当前对话角色**
             （`api/chat.rs:220` 读 `gs.current_role_id`）—— 走近碰到的人未必是那一个，
             这时静默发出去等于把话说给了另一个人。 -->
        <button
          v-if="!canSend"
          class="ws-btn wscd__goto"
          type="button"
          @click="emit('goto')"
        >
          {{ t('worldsim.chatDrawer.toChat') }}
        </button>
        <div v-if="note" class="wscd__note">{{ note }}</div>
      </footer>
    </aside>
  </div>
</template>

<script lang="ts">
  /**
   * 抽屉里的一条消息（**只活在这一屏的会话里**；不读也不写聊天记录 —— 那是聊天页的事）。
   *
   * 为什么单独开一个普通脚本块：setup 脚本块里**不许有 ESM `export`**（编译期就报错）。
   * 宿主 `WsCityEntry.vue` 要按同一个形状攒这几行字，形状只定义在这里。
   */
  export interface WsChatLine {
    /** 是不是玩家说的（现在只有玩家这一侧；角色回话显示在聊天页/气泡里） */
    me: boolean;
    /** 正文（**不含**世界状态前缀 —— 那一截只加在发出去的消息上） */
    text: string;
    /** 什么时候说的（ms，回执/排序用） */
    at: number;
  }
</script>

<script setup lang="ts">
  import { computed, nextTick, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";

  const { t } = useI18n();

  const props = withDefaults(
    defineProps<{
      /** 对着谁说话（名字 = `display_name`，与 runtime `actors` 的键同一套） */
      role?: { name: string; subtitle?: string; avatarUrl?: string } | null;
      /** `wsNearby` 的判词（三态；空串 = 还没判出来，界面就不写这一行） */
      nearText?: string;
      /** 将要拼在正文前面的那一截世界状态（`wsScenePrefix` 的产物；空 = 只发正文） */
      prefix?: string;
      /** 这一屏已经说过的话（宿主拿着状态 ⇒ 关掉抽屉再打开不丢） */
      messages?: readonly WsChatLine[];
      /** 正在发（发出去之前不许重复点） */
      busy?: boolean;
      /** 上一次发送的如实回执（成功/失败/今天不再加分 —— 都写在这里） */
      note?: string;
      /** 低性能档：整段进出动画关掉（与 `WsEventBubble` 的 `low` 同一口径） */
      low?: boolean;
      /** 打开时自动聚焦输入框 */
      autofocus?: boolean;
      /**
       * 这一句**能不能发**。
       *
       * 为什么要有这个开关：`send_chat_message` **没有角色参数** —— 它发给的是
       * `game_status.current_role_id` 那个角色（`api/chat.rs:220`）。走近碰上的人未必是
       * 当前对话角色，这时若照发，话就进了**另一个人**的对话里（玩家以为在跟 A 说）。
       * ⇒ 宿主判"是不是当前角色"，不是就把这里置 false 并给一句说明（`note`），
       *   抽屉只负责**不发**、并给一条"去聊天页选 ta"的路。
       */
      canSend?: boolean;
    }>(),
    {
      role: null,
      nearText: "",
      prefix: "",
      messages: () => [],
      busy: false,
      note: "",
      low: false,
      autofocus: true,
      canSend: true,
    }
  );

  const emit = defineEmits<{
    (e: "close"): void;
    /** 说一句（**正文**，不含前缀 —— 前缀由宿主按 `wsScenePrefix` 拼） */
    (e: "send", text: string): void;
    /** 约他出门（下游与面板里的快捷动作是同一条，宿主实现） */
    (e: "outing"): void;
    /** 「去聊天页选 ta」（`canSend === false` 时那条能走通的路） */
    (e: "goto"): void;
  }>();

  const draft = ref("");
  const box = ref<HTMLTextAreaElement | null>(null);
  /** 头像位：没有真头像就画首字母（不画假头像 —— 与 `WsPhoneChat` 同一条纪律） */
  const initial = computed(() => (props.role?.name || "?").slice(0, 1));

  function submit(): void {
    const text = draft.value.trim();
    if (!text || props.busy || !props.role) return;
    emit("send", text);
    draft.value = "";
  }

  watch(
    () => props.autofocus,
    (on) => {
      if (!on) return;
      void nextTick(() => box.value?.focus());
    },
    { immediate: true }
  );
</script>

<style scoped>
  /* 根整层不吃事件（唯一的例外是遮罩与面板本体）—— 见文件头约束① */
  .wscd {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
  }
  .wscd__mask {
    position: absolute;
    inset: 0;
    pointer-events: auto;
    background: rgba(6, 10, 14, 0.28);
    animation: ws-fade-in 0.2s ease both;
  }
  .wscd__panel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 62vh;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    border-radius: var(--ws-radius-lg) var(--ws-radius-lg) 0 0;
    padding: 10px 12px 12px;
    overflow: hidden;
    animation: ws-slide-up 0.24s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
  /* 低性能档：动画整段关掉（只留终态）。prefers-reduced-motion 那条全局规则另有兜底 */
  .wscd__panel--low,
  .wscd__panel--low + .wscd__mask {
    animation: none;
  }
  @keyframes ws-slide-up {
    from {
      transform: translateY(16px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .wscd__head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  .wscd__av {
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--ws-primary-soft);
    color: var(--ws-fg);
    font-weight: 700;
  }
  .wscd__who {
    flex: 1;
    min-width: 0;
  }
  .wscd__name {
    font-weight: 700;
    color: var(--ws-fg);
  }
  /* 判词是**正文级**信息（"附近几个人/数不出来"），不是装饰 ⇒ 用 --ws-fg-dim（AA 达标） */
  .wscd__near {
    color: var(--ws-fg-dim);
    font-size: 0.86em;
    line-height: 1.35;
  }
  .wscd__x {
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }

  /* 消息区自己吃掉滚动（别让滚轮/拖拽漏给地图手势） */
  .wscd__body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 6px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wscd__empty {
    color: var(--ws-fg-dim);
    font-size: 0.86em;
    padding: 4px 2px;
  }
  .wscd__row {
    display: flex;
  }
  .wscd__row--me {
    justify-content: flex-end;
  }
  .wscd__bubble {
    max-width: 82%;
    padding: 6px 10px;
    border-radius: var(--ws-radius-sm);
    background: var(--ws-panel-2);
    color: var(--ws-fg);
    font-size: 0.92em;
    line-height: 1.4;
    word-break: break-word;
  }
  .wscd__row--me .wscd__bubble {
    background: var(--ws-primary-soft);
  }
  .wscd__bubble--dim {
    color: var(--ws-fg-dim);
  }

  .wscd__foot {
    border-top: 1px solid var(--ws-border);
    padding-top: 8px;
  }
  .wscd__prefix {
    color: var(--ws-fg-dim);
    font-size: 0.8em;
    line-height: 1.35;
    margin-bottom: 6px;
  }
  /* 没带上下文时**加重**说清（这是"AI 只知道你这一句"的如实提示，不该看起来像装饰） */
  .wscd__prefix--none {
    color: var(--ws-warn);
  }
  .wscd__input {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .wscd__ta {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    resize: none;
    padding: 8px 10px;
    border-radius: var(--ws-radius-sm);
    border: 1px solid var(--ws-border);
    background: var(--ws-panel-2);
    color: var(--ws-fg);
    font: inherit;
  }
  .wscd__ops {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
  }
  .wscd__outing,
  .wscd__send {
    min-height: 44px;
    justify-content: center;
    white-space: nowrap;
  }
  .wscd__goto {
    margin-top: 6px;
    min-height: 44px;
  }
  .wscd__note {
    margin-top: 6px;
    color: var(--ws-fg-dim);
    font-size: 0.82em;
  }
</style>
