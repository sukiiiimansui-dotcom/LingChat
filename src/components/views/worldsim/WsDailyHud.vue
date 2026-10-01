<!--
  WsDailyHud.vue —— 「🏠 我的家 + 今日三件事」的**浮块本体**（切片③，2026-10-01）。

  ## 它是什么
  App 入口 `/worldsim` 上那张常驻小卡：一行"我的家"、三行可勾选的小事、一行脚注。
  原型页那份 DOM 在抽屉里（`ws3dshow.html:244-245` + 渲染函数 `:4478-4503`）——
  这里**只把可见文案与行结构搬过来**，逻辑一行没有：
    · 家那一行 = 宿主给的 `verdict`（**共享真源 `wsDaily.pickHome` 的判词原文**，本组件不改写）；
    · 三行 = 宿主给的 `tasks`（文本含**真实**居民/设施名，由 `wsDaily.planDaily` 生成）；
    · 脚注 = `完成 N/3 · 日期 · <pickHome 的 why>`（与原型页同一句式的三段）。
  ⚠️ 原型页的脚注里念的是 `wsDailyWhy`，而那个变量在它那儿装的是 **pickHome 的 why**（不是 planDaily 的），
    所以这里也念 `why` —— **逐字同款**，不是抄错。planDaily 的 why（跨天重置/缺件）放在 `title` 里。

  ## 这一屏的四条红线（都在这张卡的样式里，改样式前先看）
  ① 🔴 **不许 `backdrop-filter`**（值不是 `none` 就每帧读回底下像素，而底下是每帧重画的 WebGL 画布；
     `assets/styles/worldsim.css:198-201`）。"浮起来"靠**底色 + 边框 + 阴影** ⇒ 见 `.wsdaily`。
     本屏的 `--ws-blur` 已被宿主显式置成 `none`（`WsCityEntry.vue` 的 `.wsce.ws-root`），这里也不写死 blur。
  ② 🔴 **不许"全屏根元素 + 自己 `.stop` 掉 pointer 事件"**：本组件根元素是**一张小卡**（不是 `inset:0`），
     地图手势照旧落在卡外；卡内只有真实的面（勾选行）吃事件 —— 今晚刚修过 `WsCharPanel` 那个同类 bug。
  ③ 🔴 **flex 列里的子项一律 `flex: none`**：默认 `flex-shrink:1` 会在矮视口把内容压扁、再被自己的
     `overflow:hidden` 裁掉、`scrollHeight` 不涨 ⇒ **既放不下又滚不动**（今晚修过）。所以行/脚注都是 `none`，
     容器用 `max-height` + `overflow-y:auto` 兜底（内容不缩 ⇒ 真的能滚）。
  ④ 🔴 **触控目标 ≥44×44**（`UI-DESIGN-SPEC.md:112`）：勾选行 `min-height:44px` 且整行可点（`<label>` 包着
     `<input>`）—— 原型页那行 `row.style.cssText`（`ws3dshow.html:4488`）**没写高度**，别照抄它。
-->
<template>
  <section
    class="wsdaily"
    data-ws-daily
    :aria-label="t('worldsim.daily.tasks')"
    :title="titleText"
  >
    <!-- 🏠 家那一行：判词原文（宿主从 `wsDailyStore.verdict()` 拿来，本组件不改写） -->
    <div class="wsdaily__home" :data-ws-daily-home="home || ''">
      <span class="wsdaily__ico" aria-hidden="true">🏠</span>
      <span class="wsdaily__htxt">{{ homeLine }}</span>
    </div>

    <!-- 📋 三件事：整行是一个 `<label>`（点哪儿都能勾），行高 ≥44 -->
    <label
      v-for="task in tasks"
      :key="task.id"
      class="wsdaily__row"
      :data-ws-daily-task="task.id"
      :data-done="task.done ? '1' : '0'"
    >
      <input class="wsdaily__cb" type="checkbox" :checked="!!task.done" @change="onChange(task, $event)" />
      <span class="wsdaily__txt" :class="{ 'is-done': task.done }">{{ task.text }}</span>
    </label>

    <!-- 🧾 脚注：完成 N/3 · 日期 · why（三段与原型页同一句式） -->
    <div class="wsdaily__foot" data-ws-daily-foot>{{ footText }}</div>
  </section>
</template>

<script setup lang="ts">
  import { computed } from "vue";
  import { useI18n } from "vue-i18n";
  import type { DailyTask } from "./wsDaily";

  const props = defineProps<{
    /** 家那一行的**判词原文**（`wsDailyStore.verdict()`；空串时退回 i18n 的兜底词） */
    verdict: string;
    /** 家的名字（`""` = 数不出来）——只用于 DOM 契约 `data-ws-daily-home`，不改可见文案 */
    home?: string;
    /** `pickHome` 的 why 原文（脚注直念，宿主不许改写） */
    why?: string;
    /** 今日三件事（真源 `planDaily` 的产出，本组件只渲染） */
    tasks?: readonly DailyTask[];
    /** 本地日期键（`wsDaily.dayKeyOf` 的产出） */
    day?: string;
    /** `planDaily` 的 why 原文（跨天重置/缺件都在里面）——放 `title`，**不动可见文案** */
    note?: string;
  }>();

  const emit = defineEmits<{ (e: "toggle", id: string, done: boolean): void }>();
  const { t } = useI18n();

  /** 家那一行：判词优先；万一没给（防御）⇒ 用 i18n 的两个词说"数不出来"，绝不显示空白 */
  const homeLine = computed(
    () => props.verdict || `${t("worldsim.daily.home")}：${t("worldsim.daily.unknown")}`
  );
  /** 脚注：`完成 N/3 · 日期`（+ 有 why 就接一段，与原型页同款） */
  const footText = computed(() => {
    const tasks = props.tasks || [];
    const doneN = tasks.filter((x) => x.done).length;
    const bits = [`完成 ${doneN}/${tasks.length || 3}`, String(props.day || "")];
    if (props.why) bits.push(String(props.why));
    return bits.filter(Boolean).join(" · ");
  });
  /** hover 提示：这一屏的名字 + planDaily 的实话（跨天重置/缺件）——可见文案一个字不动 */
  const titleText = computed(() => [t("worldsim.daily.tasks"), String(props.note || "")].filter(Boolean).join(" · "));

  /** 勾选 ⇒ 交给宿主（宿主调 `wsDailyStore.toggle`）；本组件**不自己写盘/不自己算规则** */
  function onChange(task: DailyTask, ev: Event): void {
    emit("toggle", task.id, !!(ev.target as HTMLInputElement | null)?.checked);
  }
</script>

<style scoped>
  /* 浮块本体：**小卡**（不是全屏层 ⇒ 不吃地图手势）。
     位置在顶栏之下、右上角：那里没有别的常驻件（左下是地图自己的指标条 `.ws-dml__hud`，
     右下是手机 📱 + 缩放 `.ws-dml__zoom`，右侧宽屏会被角色抽屉盖住 —— 都是刻意避开的）。
     ⚠️ `top: 82px` 不是随手写的：顶栏占 0~56px，而"未装城市"那条 chip（`WsCityEntry.vue` 的
     `.wsce__chip`）在 `top:46px`、高约 29px ⇒ 到 ~75px。卡片从 82px 起才不会在**窄屏**上和它叠
     （窄屏时 `62vw` 的卡左边缘会伸到 chip 那一片去）。改这两个数之前先看这条。 */
  .wsdaily {
    position: absolute;
    top: 82px;
    right: 8px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: min(20em, 62vw);
    max-height: min(46vh, 320px);
    overflow-y: auto;
    padding: 6px 9px;
    border-radius: var(--ws-radius-sm, 14px);
    border: 1px solid var(--ws-border);
    background: var(--ws-panel);
    box-shadow: var(--ws-shadow-lg);
    color: var(--ws-fg);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: left;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .wsdaily__home {
    /* ②③：子项不缩（内容高度是硬要求） */
    flex: none;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .wsdaily__ico {
    flex: none;
    line-height: 1.5;
  }
  .wsdaily__row {
    /* 🔴 `flex: none`：矮视口下不许被压扁（压扁 + 自己的 overflow 会变成"既放不下又滚不动"） */
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    /* 🔴 触控目标 ≥44×44：行高 44，整行是 `<label>` ⇒ 点哪儿都能勾 */
    min-height: 44px;
    cursor: pointer;
  }
  .wsdaily__cb {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--ws-primary-deep, #62b79d);
    cursor: pointer;
  }
  .wsdaily__txt {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* 已完成的行淡下去（0.55 与原型页 `ws3dshow.html:4493` 同值） */
  .wsdaily__txt.is-done {
    opacity: 0.55;
  }
  .wsdaily__foot {
    flex: none;
    margin-top: 2px;
    padding-top: 4px;
    border-top: 1px solid var(--ws-border);
    /* 🔴 用 `--ws-fg`（不是 `--ws-fg-dim`）：这张卡是 `--ws-panel`（86% 白）**浮在每帧重画的地图上**，
       最坏情形（底下是全黑地图）合成出来的底约 #dbdbdb —— `--ws-fg-dim` 对它是 3.5:1，**不达 4.5**；
       `--ws-fg` 对它是 5.1:1（对纯白 7.0:1）⇒ 次要感靠字号与字重，不靠把字调淡。 */
    color: var(--ws-fg);
    overflow-wrap: anywhere;
  }
</style>
