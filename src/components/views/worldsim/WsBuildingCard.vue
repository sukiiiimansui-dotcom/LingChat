<!--
  WsBuildingCard.vue —— 🪪 「世界模拟」的**信息卡**（楼体 / 真名点 / 区名 **三种入口共用同一张卡**）。

  ## 机主原话（2026-09-26）
  「**每个名字和楼房都能点击查看信息**（要求有**精美的 mg 动画**）」
  ⇒ 两个入口是**同一"物种"**（`DESIGN-MG-MOTION.md` §4.4）：同一个组件、同一条时序常量、同一组 `data-*`，
  唯一的差别是**生长原点**（点楼体 = 以点击点为中心；点区名 = 底部升起 24px）。

  ## 三条设计约束（都是硬约束，不是风格偏好）
  ① 🔴 **禁 `backdrop-filter`**（RED LINE R1）：实测 `blur(0px) ≠ 没有模糊` —— 只要值不是 `none`
     就会建 backdrop 层、**每帧把底下的像素读回来**，而卡片正浮在地图画布上（fps 19→27 的代价）。
     ⚠️ 所以这里**绝不能**套用全局的 `.ws-card` 类：那个类里写着
     `backdrop-filter: blur(var(--ws-blur))`，玻璃主题下 `--ws-blur` 是 `10px` ⇒ 一用就退回掉帧。
     本组件用**自己的** `ws-bcard` 类：半透明**纯色** + 1px 描边 + 一层阴影。
  ② **只动 `transform` / `opacity`**（R2）：位置/生长用 `translate3d` + `scale`，不许动
     `width/height/top/left/margin/padding/font-size`；动画属性白名单在 `wsBuildingCard.CARD_ANIM_PROPS`。
  ③ **两个降级面**（R8）：`.ws-perf-low`（低档：去位移、内容不分层、140ms）与
     `prefers-reduced-motion: reduce`（纯淡入 120ms，**保留终态**，去掉位移与缩放）。
     ⚠️ 全站 CSS 已把 `.ws-root *` 的 `transition-duration` 压到 `0.12s !important`，
     但 **`transition-delay` 不在覆盖范围**内 ⇒ reduced-motion 时由本组件**自己**把错峰清零，
     否则会"卡片已经到了、内容还在排队"。

  ## 时序（**唯一来源** = `wsBuildingCard.CARD_MOTION`，这里一律引用，绝不写字面量）
  入场 200ms（`e-enter`）/ 内容 4 层每层 140ms、起于 60ms、错峰 30ms（末层 290ms ≤ 450ms 预算）/
  退场 160ms（`e-leave`）/ 遮罩 160ms 且**退场晚 40ms** 收。
-->
<template>
  <!-- 遮罩：**半透明纯色**（不是毛玻璃）；点它 = 关闭 -->
  <div
    v-if="mounted"
    class="ws-bcard__scrim"
    :class="{ 'is-in': phase !== 'enter' }"
    :style="scrimStyle"
    aria-hidden="true"
    @click="requestClose"
  />
  <div
    v-if="mounted && data"
    :id="data.domId"
    v-bind="data.dataAttrs"
    class="ws-bcard"
    :class="[`is-${data.state}`, { 'is-lite': lite, 'is-sheet': !!sheet, 'is-in': phase !== 'enter' }]"
    :style="cardStyle"
    role="dialog"
    aria-modal="true"
    :aria-label="data.title"
  >
    <!-- ① 标题层（错峰第 0 层） -->
    <header class="ws-bcard__head" :style="layerStyle(0)">
      <span class="ws-bcard__title" :title="data.why">{{ data.title }}</span>
      <span v-if="data.titleTag" class="ws-bcard__tag" :class="data.sketch ? 'is-sketch' : 'is-real'">
        {{ data.sketch ? '＊' : '' }}{{ data.titleTag }}
      </span>
      <button class="ws-bcard__x" type="button" aria-label="关闭" @click="requestClose">✕</button>
    </header>

    <!-- ② 类型层（错峰第 1 层） -->
    <p class="ws-bcard__type" :class="{ 'is-muted': !data.typeKnown }" :style="layerStyle(1)" :title="data.typeHint || ''">
      {{ data.type }}
    </p>

    <!-- ③④ 元信息层（错峰第 2、3 层；**恰好 4 层**，与规范一致） -->
    <dl class="ws-bcard__meta" :style="layerStyle(2)">
      <div v-for="f in headFields" :key="f.key" class="ws-bcard__row" :class="`is-${f.tone || 'real'}`">
        <dt>{{ f.label }}</dt>
        <dd :title="f.hint || ''">{{ f.value }}</dd>
      </div>
    </dl>
    <dl class="ws-bcard__meta ws-bcard__meta--tail" :style="layerStyle(3)">
      <div v-for="f in tailFields" :key="f.key" class="ws-bcard__row" :class="`is-${f.tone || 'real'}`">
        <dt>{{ f.label }}</dt>
        <dd :title="f.hint || ''">{{ f.value }}</dd>
      </div>
    </dl>

    <!-- 署名（ODbL 合规项：**原话**来自包索引，取不到就明写取不到） -->
    <footer class="ws-bcard__src" :title="data.attribution ? '数据署名（原话来自包索引）' : '包索引里没有 attribution'">
      {{ data.attribution || S.attrMissing }}
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * 组件只做**表现**：卡上写什么全部来自 `wsBuildingCard.buildingCardData()`（纯函数、可自检）。
 * 这样页面（`ws3dshow.html`）与 App 走的是同一份字段与同一条时序，不会出现两套语言。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  CARD_MOTION as M,
  CARD_STRINGS as S,
  cardComposeTransform,
  cardEnterStyle,
  cardExitTransform,
  cardRestTransform,
  type CardData,
  type CardField,
} from "./wsBuildingCard";

const props = withDefaults(
  defineProps<{
    /** 卡片数据（`buildingCardData()` 的产出）；null = 不画 */
    data?: CardData | null;
    /** 开着没有（父组件控制；收起时本组件**自己**跑完退场再卸载） */
    open?: boolean;
    /** 低档（`.ws-perf-low` / `wsPerf` 的 low）：去位移、内容不分层、140ms */
    low?: boolean;
    /** 强制 reduced-motion 行为（无头/自检里用；真机由媒体查询自动判） */
    reduced?: boolean;
  }>(),
  { data: null, open: false, low: false, reduced: false }
);

const emit = defineEmits<{ (e: "close"): void; (e: "opened"): void }>();

/* ── 降级面判定（媒体查询只读一次，之后跟随变化） ───────────────────────────── */
const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const prefersReduced = ref(!!mq && mq.matches);
if (mq) {
  const on = (e: MediaQueryListEvent) => { prefersReduced.value = e.matches; };
  /* Safari 老版本只有 addListener；两条都挂，移除时也两条都试 */
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", on);
  else if (typeof (mq as unknown as { addListener?: (f: (e: MediaQueryListEvent) => void) => void }).addListener === "function") {
    (mq as unknown as { addListener: (f: (e: MediaQueryListEvent) => void) => void }).addListener(on);
  }
  onBeforeUnmount(() => {
    if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", on);
    else if (typeof (mq as unknown as { removeListener?: (f: (e: MediaQueryListEvent) => void) => void }).removeListener === "function") {
      (mq as unknown as { removeListener: (f: (e: MediaQueryListEvent) => void) => void }).removeListener(on);
    }
  });
}
const reduced = computed(() => props.reduced || prefersReduced.value);
const lite = computed(() => props.low || reduced.value);          // 节点数/档位阶梯的"换手段"开关
const sheet = computed(() => !!props.data?.origin?.fromSheet);

/* ── 时序（**全部来自 `CARD_MOTION`**，这里不许出现第二个字面量） ─────────────── */
const enterMs = computed(() => (reduced.value ? M.reducedMs : props.low ? M.lowEnterMs : M.enterMs));
const contentMs = computed(() => (props.low ? M.lowContentMs : M.contentMs));
const contentStartMs = computed(() => (props.low ? M.lowContentStartMs : M.contentStartMs));
const staggerMs = computed(() => (props.low || reduced.value ? 0 : M.contentStaggerMs));

const mounted = ref(false);
/** `enter` = 已落"起点"那一帧；`in` = 已落终态；`exit` = 正在退场 */
const phase = ref<"enter" | "in" | "exit">("enter");
let timer: ReturnType<typeof setTimeout> | null = null;
const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

watch(
  () => [props.open, props.data] as const,
  ([open]) => {
    if (open && props.data) {
      clear();
      mounted.value = true;
      phase.value = "enter";                      // 先落起点（inline style，与终态不同 ⇒ 下一帧才会过渡）
      /* rAF 只用来"让起点先上屏"；没有 rAF 的环境（无头/自检）退回 16ms 定时器 */
      const raf: (f: () => void) => unknown =
        typeof requestAnimationFrame === "function" ? (f) => requestAnimationFrame(f) : (f) => setTimeout(f, 16);
      raf(() => {
        phase.value = "in";
        /* 入场结束通知（父组件用它恢复标签层的动效/做去抖）；低档与 reduced 一样要发 */
        timer = setTimeout(() => emit("opened"), enterMs.value);
      });
      return;
    }
    if (!open && mounted.value) {
      /* 退场：卡片 160ms（reduced 下 120ms 纯淡出），跑完**才**卸载（终态保留到最后一帧） */
      clear();
      phase.value = "exit";
      timer = setTimeout(() => { mounted.value = false; }, reduced.value ? M.reducedMs : M.exitMs);
    }
  },
  { immediate: true }
);
onBeforeUnmount(clear);

function requestClose() { emit("close"); }

/* ── 样式：**只含 transform / opacity**（R2；自检拿源码断言这条） ─────────────── */
const cardStyle = computed<Record<string, string>>(() => {
  const dur = `${enterMs.value}ms`;
  const base: Record<string, string> = {
    transition: `transform ${dur} ${M.easeEnter}, opacity ${dur} ${M.easeEnter}`,
    "transform-origin": sheet.value ? "50% 100%" : "50% 50%",
  };
  const d = props.data;
  if (!d) return base;
  if (phase.value === "enter") {
    /* 起点 = 以点击点为 origin 生长（`cardEnterStyle` 会夹紧 ±40px；区名入口改底部升起 24px）。
       🔴 transform 必须**拼在基准居中之后**（`cardComposeTransform`）—— 直接覆盖会把居中一起干掉。 */
    const st = cardEnterStyle(d.origin);
    return { ...base, transform: cardComposeTransform(st.transform), opacity: st.opacity ?? "0" };
  }
  if (phase.value === "exit") {
    return {
      ...base,
      transition: `transform ${M.exitMs}ms ${M.easeLeave}, opacity ${M.exitMs}ms ${M.easeLeave}`,
      transform: cardExitTransform(),
      opacity: "0",
    };
  }
  /* 终态：位移/缩放**必须归零**（否则卡片会停在被夹紧的位置上） */
  return { ...base, transform: cardRestTransform(), opacity: "1" };
});

const scrimStyle = computed<Record<string, string>>(() => {
  const dur = reduced.value ? M.reducedMs : M.scrimMs;
  const delay = phase.value === "exit" ? `${M.scrimDelayMs}ms` : "0ms";
  return {
    transition: `opacity ${dur}ms ${phase.value === "exit" ? M.easeLeave : M.easeEnter} ${delay}`,
    opacity: phase.value === "in" ? String(M.scrimOpacity) : "0",
  };
});

/**
 * 内容层：每层 `translate3d(0, 6px, 0) → 0` + `opacity 0 → 1`，
 * 起于 `contentStartMs`，**错峰 `staggerMs` × 序号**（低档/reduced 下错峰 = 0 = 一层）。
 */
function layerStyle(idx: number): Record<string, string> {
  const delay = contentStartMs.value + staggerMs.value * idx;
  const dur = reduced.value ? M.reducedMs : contentMs.value;
  const ease = phase.value === "exit" ? M.easeLeave : M.easeEnter;
  const done = phase.value === "in";
  return {
    transition: `transform ${dur}ms ${ease} ${done ? delay : 0}ms, opacity ${dur}ms ${ease} ${done ? delay : 0}ms`,
    transform: done ? "translate3d(0, 0, 0)" : `translate3d(0, ${reduced.value ? 0 : M.contentShiftPx}px, 0)`,
    opacity: done ? "1" : "0",
  };
}

/* ── 字段分两段：前 2 行进"错峰层"，其余一次性列出（层数不超 4，规范预算） ───
   标题与类型已经占了第 0、1 层；署名单独做页脚（ODbL 合规项要一直在，不参与错峰）。 */
const rows = computed<CardField[]>(() =>
  (props.data?.fields || []).filter((f) => f.key !== "name" && f.key !== "nameSource" && f.key !== "type" && f.key !== "attribution")
);
const headFields = computed<CardField[]>(() => rows.value.slice(0, 2));
const tailFields = computed<CardField[]>(() => rows.value.slice(2));
</script>

<style scoped>
/* ⚠️ 这里**不写** `backdrop-filter`（红线 R1）。要"浮起来"的感觉只靠三层：
   半透明纯色 + 1px 描边 + 一层阴影。低档下阴影也被 --ws-shadow-lg 换掉（全局已有规则）。 */
.ws-bcard__scrim {
  position: absolute;
  inset: 0;
  background: rgba(16, 20, 28, 0.32); /* 纯色，不是毛玻璃 */
  z-index: 40;
  will-change: opacity;
}
.ws-bcard {
  position: absolute;
  left: 50%;
  top: 50%;
  /* 尺寸用固定最大宽高（**不是动画属性**）⇒ 生长只靠 transform，不触发布局 */
  width: min(88%, 420px);
  max-height: 76%;
  overflow: hidden auto;
  transform: translate(-50%, -50%);
  margin: 0;
  padding: 14px 16px 12px;
  box-sizing: border-box;
  background: var(--ws-panel, rgba(255, 255, 255, 0.86));
  color: var(--ws-fg, #4a5b63);
  border: 1px solid var(--ws-border, rgba(143, 214, 192, 0.38));
  border-radius: var(--ws-radius, 16px);
  box-shadow: var(--ws-shadow-lg, 0 10px 30px rgba(90, 120, 130, 0.16));
  z-index: 41;
  will-change: transform, opacity;
  pointer-events: auto;
}
/* 🎯 只有被点中的那一张卡带 will-change（[MDN] 明确要求"用完就撤"；这里随节点卸载自动撤） */
.ws-bcard.is-lite { will-change: auto; }

.ws-bcard__head { display: flex; align-items: baseline; gap: 8px; }
.ws-bcard__title { font-size: 16px; font-weight: 600; line-height: 1.3; flex: 1 1 auto; word-break: break-word; }
.ws-bcard__tag {
  flex: none; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--ws-border, rgba(143, 214, 192, 0.38));
}
/* 🔴 生成/示意件**样式必须与真名不同**（机主拍板 + 项目红线）：虚线边 + 斜体 + 低饱和底 */
.ws-bcard__tag.is-sketch {
  font-style: italic; border-style: dashed;
  background: var(--ws-primary-soft, rgba(143, 214, 192, 0.18));
  color: var(--ws-fg-dim, #67757b);
}
.ws-bcard__tag.is-real { background: var(--ws-primary-soft, rgba(143, 214, 192, 0.18)); }
/* 关闭键：**静态 padding 撑到 ≥44×44** 的命中区（不许用动画改尺寸来放大命中区） */
.ws-bcard__x {
  flex: none; width: 44px; height: 44px; margin: -12px -10px -12px 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; color: var(--ws-fg-dim, #67757b);
  font-size: 14px; cursor: pointer;
}
.ws-bcard__type { margin: 6px 0 8px; font-size: 12.5px; color: var(--ws-fg-dim, #67757b); }
.ws-bcard__type.is-muted { font-style: italic; }
.ws-bcard__meta { margin: 0; padding: 0; }
.ws-bcard__meta--tail { margin-top: 2px; }
.ws-bcard__row { display: flex; gap: 10px; padding: 3px 0; font-size: 12.5px; }
.ws-bcard__row dt { flex: none; width: 62px; color: var(--ws-fg-dim, #67757b); }
.ws-bcard__row dd { flex: 1 1 auto; margin: 0; word-break: break-word; }
.ws-bcard__row.is-warn dd { color: var(--ws-warn, #e8b86d); }
.ws-bcard__row.is-muted dd { color: var(--ws-fg-dim, #67757b); }
.ws-bcard__row.is-sketch dd { font-style: italic; }
.ws-bcard__src {
  margin-top: 8px; padding-top: 6px; font-size: 10.5px; line-height: 1.4;
  color: var(--ws-fg-dim, #67757b); border-top: 1px solid var(--ws-border, rgba(143, 214, 192, 0.38));
}
/* 低档：去掉阴影之外的装饰（动画本身由 JS 换手段：去位移、内容不分层） */
.ws-bcard.is-lite { box-shadow: var(--ws-shadow, 0 4px 14px rgba(90, 120, 130, 0.1)); }
</style>
