<template>
  <!--
    T2-2 step2 · 地图上的「交通设施」这一层（公交站/地铁/停车场/加油站/火车站/机场/码头）

    ## 与 WsFacilityLayer 的分工（别重复画）
    `WsFacilityLayer` 已经能把「生活 + 交通」都画出来（它有个 `交通设施` 分组开关，**默认关**）。
    这一层是**交通专用**的加强版，多两件卡片明确要求的东西：
      ① **形状**区分（公交=实心圆 / 地铁=空心圈 / 停车=方块 / 加油=菱形 / 火车=长条 / 机场=飞机 / 码头=锚）
         —— 只看颜色和图标在小尺寸下分不清，形状能；
      ② **三级切换**（小区/区县/城市）与"这一级比上一级多了什么"。
    ⚠️ 接线时**不要同时打开** `WsFacilityLayer` 的交通分组（同一批点会画两遍）。
    两者的数据源是同一条（`facilities.rs` 的 `generate_all().transport`），所以取舍任意。

    ## 坐标
    与生活设施层完全一致：`gx/gy` 是小区图**格点**，铺在 `#pin` 手势变换容器里，
    尺寸走 `letterboxOf/gridToBox`（不抄地图渲染逻辑）。

    ## 诚实性
    取不到就显示「取不到 + 原因」，**一个点都不画**；
    后端明确说"生成不出节点"（`ok:false`）时也如实说，不假装"这里没有车站"。
  -->
  <div class="ws-tr" :class="{ 'is-off': !visible }" :data-shown="shown.length" data-testid="ws-tr">
    <div ref="host" class="ws-tr__box" data-testid="ws-tr-box">
      <span
        v-for="m in marks"
        :key="m.n.id"
        class="ws-tr__mark"
        :class="[`is-${m.shape}`]"
        :data-type="m.n.type"
        :data-id="m.n.id"
        :data-shape="m.shape"
        data-testid="ws-tr-mark"
        :style="{
          left: `${m.r.cx.toFixed(2)}px`,
          top: `${m.r.cy.toFixed(2)}px`,
          width: `${m.r.w.toFixed(2)}px`,
          height: `${m.r.h.toFixed(2)}px`,
          '--ws-tr-inv': `${(1 / (zoom > 0 ? zoom : 1)).toFixed(4)}`,
          '--ws-tr-c': meta(m.n.type).color,
          '--ws-tr-fill': meta(m.n.type).fill,
        }"
        :title="`${meta(m.n.type).zh} · ${m.n.name}`"
      >
        <i class="ws-tr__ico" aria-hidden="true">{{ meta(m.n.type).icon }}</i>
        <b v-if="m.label" class="ws-tr__name">{{ m.n.name }}</b>
      </span>
    </div>

    <Teleport v-if="panel !== 'none'" :to="panelHost">
      <div
        class="ws-trp"
        :class="`is-${panelSide}`"
        data-testid="ws-tr-panel"
      >
        <div class="ws-trp__head">
          <span class="ws-trp__title">🚌 交通设施</span>
          <span class="ws-trp__total" data-testid="ws-tr-total">{{ totalText }}</span>
        </div>

        <div class="ws-trp__body">
          <p v-if="state.kind !== 'ok'" class="ws-trp__state" :class="`is-${state.kind}`" data-testid="ws-tr-state">
            <span>{{ state.text }}</span>
            <em v-if="state.detail">{{ state.detail }}</em>
          </p>

          <label class="ws-trp__sw" data-no-gesture>
            <input v-model="visible" type="checkbox" data-testid="ws-tr-visible" />
            <span>显示车站</span>
          </label>

          <!-- 三级切换：数字来自后端的 LEVEL_PLAN（前端不写第二份） -->
          <div class="ws-trp__levels" data-testid="ws-tr-levels">
            <button
              v-for="lv in levelRows"
              :key="lv.level"
              class="ws-trp__lv"
              type="button"
              data-no-gesture
              :data-level="lv.level"
              :class="{ 'is-on': lv.level === level }"
              :title="lv.kinds.length ? `这一级有：${lv.kinds.map((k) => meta(k).zh).join('、')}` : '这一级没有站点'"
              @click="pickLevel(lv.level)"
            >
              <b>{{ lv.zh }}</b>
              <span>{{ lv.count }}</span>
            </button>
          </div>
          <!-- 「区县比小区多了地铁、加油站、火车站」——差别落到文字上，不用读者自己比三个数字 -->
          <p v-if="levelLine" class="ws-trp__diff" data-testid="ws-tr-diff">{{ levelLine }}</p>

          <div class="ws-trp__cats">
            <button
              v-for="r in rows"
              :key="r.key"
              class="ws-trp__cat"
              type="button"
              data-no-gesture
              :data-cat="r.key"
              :data-on="r.on ? '1' : '0'"
              :class="[`is-${transitShapeOf(r.key)}`, { 'is-on': r.on, 'is-zero': r.count === 0 }]"
              :style="{ '--ws-tr-c': r.color, '--ws-tr-fill': r.fill }"
              :title="`${r.zh}：${r.count} 个（点一下开关这一类）`"
              @click="toggleCat(r.key)"
            >
              <i class="ws-trp__shape" aria-hidden="true"></i>
              <span>{{ r.zh }}</span>
              <b>{{ r.count }}</b>
            </button>
          </div>

          <p class="ws-trp__src" data-testid="ws-tr-src" :title="srcLine">{{ srcLine }}</p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
  import { useElementSize } from "@/composables/useWorldSimGeo";
  import { transportNodesAuto } from "@/api/services/worldMap";
  import type { TransitNodesPayload, TransitNode } from "@/api/services/worldMap";
  import { hash32 } from "./wsGeo";
  import { letterboxOf } from "./wsActors";
  import {
    categoryRows,
    cleanPoints,
    defaultFilter,
    emptyState,
    filterPoints,
    gridMismatch,
    levelDiffs,
    markerRect,
    metaOf,
    shouldLabel,
    anchorSourceText,
    sourceText,
    totalLine,
    transitShapeOf,
    type FacFilter,
  } from "./wsFacilities";

  const props = withDefaults(
    defineProps<{
      /** 区域名「广州市·越秀区」——决定草图与站点播种（与 WsDistrict / 生活设施层同一个值） */
      area: string;
      /** 小区图网格边长（`WS_GRID`） */
      grid?: number;
      /** 地图手势缩放倍率（标记尺寸用 `scale(1/zoom)` 抵消） */
      zoom?: number;
      /** 当前层级：community / district / city —— 支持 `v-model:level` 由页面控制 */
      level?: string;
      /** 地图库布局缓存 key（有 AI 精绘布局时最准） */
      layoutKey?: string;
      /** 稳定种子，默认 `hash32(area)`（与 WsDistrict 画草图同一个数 → 刷新不变） */
      seed?: number;
      /** `fixed` = 渲染图例/三级切换面板；`none` = 只留标记层 */
      panel?: "fixed" | "none";
      /** 面板位置：默认左下（与生活设施面板错开一格，避免叠在一起） */
      panelSide?: "left" | "right";
    }>(),
    {
      grid: 28,
      zoom: 1,
      level: "community",
      layoutKey: "",
      seed: -1,
      panel: "fixed",
      panelSide: "right",
    }
  );

  const emit = defineEmits<{
    (e: "update:level", v: string): void;
    (e: "loaded", v: { shown: number; total: number; level: string }): void;
  }>();

  const host = ref<HTMLElement | null>(null);
  const { w, h } = useElementSize(host);

  const visible = ref(true);
  /** 交通这一层只有 7 类，默认**全开**（这个组件存在的意义就是把它们都画出来） */
  const filter = reactive<FacFilter>({ life: false, transport: true, off: [] });

  const payload = ref<TransitNodesPayload | null>(null);
  const loading = ref(false);
  const error = ref("");
  const panelHost = ref("body");
  const innerLevel = ref(props.level);

  onMounted(() => {
    if (typeof document === "undefined") return;
    panelHost.value = document.querySelector(".ws-root") ? ".ws-root" : "body";
  });

  watch(
    () => props.level,
    (v) => {
      if (v && v !== innerLevel.value) innerLevel.value = v;
    }
  );

  const effSeed = computed(() =>
    props.seed >= 0 ? props.seed >>> 0 : hash32(props.area || "world")
  );
  const effSize = computed(() => (props.grid > 0 ? Math.round(props.grid) : 28));
  const level = computed(() => innerLevel.value || "community");

  function pickLevel(l: string) {
    if (l === level.value) return;
    innerLevel.value = l;
    emit("update:level", l);
  }

  const cleaned = computed(() => {
    const d = payload.value;
    if (!d) return { points: [] as TransitNode[], dropped: 0 };
    const g = Number(d.grid) || effSize.value;
    const c = cleanPoints(d.nodes, g);
    // 站点是交通设施：`cleanPoints` 按 group 判定，这里显式标成 transport
    return {
      points: c.points.map((p) => ({ ...p, group: "transport" as const })),
      dropped: c.dropped,
    };
  });
  const all = computed(() => cleaned.value.points);
  const dropped = computed(() => cleaned.value.dropped);
  const shown = computed(() => (visible.value ? filterPoints(all.value, filter) : []));
  const lb = computed(() => letterboxOf(w.value, h.value, effSize.value));

  const marks = computed(() =>
    shown.value.map((n) => {
      const r = markerRect(n, lb.value, effSize.value);
      return { n, r, shape: transitShapeOf(n.type), label: shouldLabel(n, r, props.zoom) };
    })
  );

  const rows = computed(() =>
    categoryRows(all.value, payload.value?.types?.types, filter).filter(
      (r) => r.group === "transport"
    )
  );

  /** 三级按钮：数字来自后端（**当前这一级**用实时数据，其余用后端算好的 levels） */
  const levelRows = computed(() => {
    const lv = payload.value?.levels || [];
    const total = all.value.length;
    return lv.map((r) => ({
      level: r.level,
      zh: r.zh,
      count: r.level === level.value ? total : r.count,
      kinds: r.kinds,
    }));
  });

  const levelLine = computed(() => {
    const lv = payload.value?.levels;
    if (!lv || lv.length < 2) return "";
    const diffs = levelDiffs(lv, payload.value?.types?.types);
    return diffs
      .map((r, i) =>
        i === 0 ? `${r.zh}：${r.count} 个` : `${r.zh}：${r.count} 个${r.added.length ? `（+${r.added.join("、")}）` : ""}`
      )
      .join(" → ");
  });

  const counts = computed(() => ({ life: 0, transport: all.value.length, shown: shown.value.length }));
  const totalText = computed(() => totalLine(counts.value));

  const state = computed(() =>
    emptyState({
      loading: loading.value,
      error: error.value,
      total: all.value.length,
      shown: visible.value ? shown.value.length : 0,
      area: payload.value?.area || props.area,
      // 这一层画的是**车站**：文案也说"车站"，别说成泛泛的"设施"
      noun: "车站",
    })
  );

  const srcLine = computed(() => {
    const d = payload.value;
    if (!d) return error.value ? "没取到数据" : "…";
    const bits: string[] = [sourceText(d.source), anchorSourceText(d.anchor_source)];
    const mm = gridMismatch(d.grid, effSize.value);
    if (mm) bits.push(mm);
    if (d.geo === false) bits.push("没有锚点 → 站点无经纬度（图层用格点坐标，不受影响）");
    if (dropped.value) bits.push(`丢弃 ${dropped.value} 个非法点`);
    bits.push(`种子 ${effSeed.value}`);
    return bits.join(" · ");
  });

  function meta(t: string) {
    return metaOf(t, payload.value?.types?.types);
  }
  function toggleCat(key: string) {
    const i = filter.off.indexOf(key);
    if (i >= 0) filter.off.splice(i, 1);
    else filter.off.push(key);
  }

  let token = 0;
  async function load() {
    const my = ++token;
    loading.value = true;
    error.value = "";
    try {
      const r = await transportNodesAuto({
        area: props.area,
        size: effSize.value,
        seed: effSeed.value,
        level: level.value,
        key: props.layoutKey || undefined,
      });
      if (my !== token) return;
      payload.value = r;
      emit("loaded", { shown: shown.value.length, total: all.value.length, level: level.value });
    } catch (e) {
      if (my !== token) return;
      // 不静默降级成空数组：空数组在界面上等于"这里没有车站"
      payload.value = null;
      error.value = e instanceof Error && e.message ? e.message : String(e ?? "未知错误");
    } finally {
      if (my === token) loading.value = false;
    }
  }

  onMounted(load);
  watch(
    () => [props.area, effSize.value, effSeed.value, level.value, props.layoutKey],
    () => load()
  );
  watch(shown, (v) =>
    emit("loaded", { shown: v.length, total: all.value.length, level: level.value })
  );

  defineExpose({ reload: load, nodes: all, shownNodes: shown, error, payload, panelHost });
  onBeforeUnmount(() => {
    token++;
  });
</script>

<style scoped>
  .ws-tr {
    position: absolute;
    inset: 0;
    /* 与头像层/生活设施层同款：只做定位参照，绝不吃地图手势 */
    pointer-events: none;
    /* 压在生活设施层（2）**之上**：车站是"路上的东西"，应该看得见 */
    z-index: 3;
  }
  .ws-tr.is-off {
    display: none;
  }
  .ws-tr__box {
    position: absolute;
    inset: 0;
  }
  /* ── 形状：一眼分开公交/地铁/停车/加油/火车/机场/码头 ───────────────── */
  .ws-tr__mark {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    transform: translate(-50%, -50%) scale(var(--ws-tr-inv, 1));
    transform-origin: 50% 50%;
    border: 1.5px solid var(--ws-tr-c, #7aa7d8);
    background: var(--ws-tr-fill, rgba(122, 167, 216, 0.3));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
    line-height: 1;
  }
  .ws-tr__mark.is-circle {
    border-radius: 50%;
  }
  .ws-tr__mark.is-ring {
    border-radius: 50%;
    border-width: 2px;
    background: transparent;
  }
  .ws-tr__mark.is-square {
    border-radius: 2px;
  }
  .ws-tr__mark.is-diamond {
    border-radius: 2px;
    transform: translate(-50%, -50%) scale(var(--ws-tr-inv, 1)) rotate(45deg);
  }
  .ws-tr__mark.is-diamond .ws-tr__ico {
    transform: rotate(-45deg);
  }
  .ws-tr__mark.is-pill,
  .ws-tr__mark.is-plane {
    border-radius: 999px;
  }
  .ws-tr__mark.is-anchor {
    border-radius: 50% 50% 45% 45%;
    border-style: double;
  }
  .ws-tr__ico {
    font-style: normal;
    font-size: clamp(7px, 68%, 22px);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.3));
    user-select: none;
  }
  .ws-tr__name {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 1px;
    padding: 0 0.25em;
    font-size: 9px;
    font-weight: 500;
    white-space: nowrap;
    color: #fff;
    text-shadow:
      0 0 2px rgba(0, 0, 0, 0.9),
      0 0 4px rgba(0, 0, 0, 0.7);
  }

  /* ── 面板（Teleport 到 .ws-root，不跟地图缩放）── */
  .ws-trp {
    position: absolute;
    z-index: 56;
    width: 12.5em;
    /* 高度上限按**视口实数**算，不写死百分比：
       上边留给天气角标（top: 7.6em），下边留给「世界事件」条 + 底部卡片（9.4em ≈ 122px）。
       写 42% 时在 932×430 的验证视口里正好差 20 多像素，图例最后一行被切一半（截图里看得到）。 */
    /* 高度上限 = 视口高 − 上方留给天气角标的 7.6em − 下方留给「世界事件」条的 8.8em。
       两个数都是**实测**的：@932×430 视口下 --ws-fs ≈ 14.8px，事件条顶边 ≈ 300px。
       ⚠️ 两个坑都踩过：① 写死 42% → 内容(204px)比上限(179px)高，图例最后一行被切一半；
       ② 只留 7.2em → 不切了，但面板底边压到「世界事件」条上（截图里看得到）。 */
    max-height: calc(100% - 7.6em - 8.8em);
    display: flex;
    flex-direction: column;
    font-size: var(--ws-fs, 13px);
    color: var(--ws-fg, #4a5b63);
    background: var(--ws-panel, rgba(255, 255, 255, 0.88));
    border: 1px solid var(--ws-border, rgba(143, 214, 192, 0.4));
    border-radius: 0.75em;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(var(--ws-blur, 6px));
    overflow: hidden;
    pointer-events: auto;
  }
  /* 面板落位（实测调出来的，不是拍脑袋）：
     左下角已给生活设施面板；右下角有手机悬浮球 `.wsphone-fab` 与「世界事件」条；
     右上角有天气角标。**唯一不打架的位置是右侧、天气角标之下、世界事件条之上**
     —— 第一版放在右下（bottom: 5.6em）实测被悬浮球压住了最右边那一列图例（截图见卡片评论）。 */
  .ws-trp.is-right {
    right: 0.7em;
    /* 7.6em ≈ 99px：天气角标底边之下（实测角标底 ≈95px），世界事件条（≈300px）之上 */
    top: 7.6em;
  }
  /* 想要靠左就用它 —— 注意左上/左下已有生活设施面板与顶栏，叠了得自己挪 */
  .ws-trp.is-left {
    left: 0.7em;
    bottom: 5.6em;
  }
  .ws-trp__head {
    display: flex;
    align-items: center;
    gap: 0.4em;
    padding: 0.4em 0.55em;
  }
  .ws-trp__title {
    font-weight: 600;
    white-space: nowrap;
  }
  .ws-trp__total {
    flex: 1;
    font-size: 0.85em;
    opacity: 0.8;
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ws-trp__body {
    padding: 0 0.55em 0.55em;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ws-trp__state {
    margin: 0.2em 0 0.5em;
    padding: 0.35em 0.45em;
    border-radius: 0.4em;
    font-size: 0.85em;
    line-height: 1.4;
    background: rgba(0, 0, 0, 0.05);
  }
  .ws-trp__state em {
    display: block;
    margin-top: 0.15em;
    font-style: normal;
    font-size: 0.9em;
    opacity: 0.75;
    word-break: break-all;
  }
  .ws-trp__state.is-error {
    background: rgba(220, 90, 90, 0.16);
    border: 1px solid rgba(220, 90, 90, 0.4);
  }
  .ws-trp__state.is-empty,
  .ws-trp__state.is-filtered {
    background: rgba(200, 160, 60, 0.16);
    border: 1px solid rgba(200, 160, 60, 0.38);
  }
  .ws-trp__sw {
    display: flex;
    align-items: center;
    gap: 0.35em;
    padding: 0.15em 0;
    font-size: 0.9em;
    cursor: pointer;
    user-select: none;
  }
  .ws-trp__sw input {
    width: 1em;
    height: 1em;
    accent-color: var(--ws-primary, #8fd6c0);
  }
  /* 三级切换 */
  .ws-trp__levels {
    display: flex;
    gap: 0.25em;
    margin: 0.35em 0 0.2em;
  }
  .ws-trp__lv {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.05em;
    padding: 0.2em 0.3em;
    border: 1px solid var(--ws-border, rgba(143, 214, 192, 0.5));
    border-radius: 0.4em;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.82em;
    line-height: 1.35;
    cursor: pointer;
    opacity: 0.6;
  }
  .ws-trp__lv.is-on {
    opacity: 1;
    font-weight: 600;
    background: var(--ws-primary-soft, rgba(143, 214, 192, 0.2));
    border-color: var(--ws-primary, #8fd6c0);
  }
  .ws-trp__lv b {
    font-weight: inherit;
  }
  .ws-trp__lv span {
    font-size: 0.9em;
    opacity: 0.85;
  }
  .ws-trp__diff {
    margin: 0.15em 0 0.35em;
    font-size: 0.75em;
    line-height: 1.45;
    opacity: 0.8;
    word-break: break-all;
  }
  .ws-trp__cats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25em;
  }
  .ws-trp__cat {
    display: inline-flex;
    align-items: center;
    gap: 0.25em;
    padding: 0.15em 0.35em;
    border: 1px solid var(--ws-tr-c, #7aa7d8);
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.82em;
    line-height: 1.5;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }
  .ws-trp__cat.is-on {
    opacity: 1;
    background: var(--ws-tr-fill, rgba(122, 167, 216, 0.26));
  }
  .ws-trp__cat.is-zero {
    border-style: dashed;
    opacity: 0.35;
  }
  .ws-trp__cat b {
    font-weight: 600;
    opacity: 0.85;
  }
  /* 图例左侧的小形状：与地图上的标记**同一套形状**（图例与实物对得上） */
  .ws-trp__shape {
    width: 0.62em;
    height: 0.62em;
    border: 1.5px solid var(--ws-tr-c, #7aa7d8);
    background: var(--ws-tr-fill, rgba(122, 167, 216, 0.3));
    flex: none;
  }
  .ws-trp__cat.is-circle .ws-trp__shape {
    border-radius: 50%;
  }
  .ws-trp__cat.is-ring .ws-trp__shape {
    border-radius: 50%;
    border-width: 2px;
    background: transparent;
  }
  .ws-trp__cat.is-square .ws-trp__shape {
    border-radius: 1px;
  }
  .ws-trp__cat.is-diamond .ws-trp__shape {
    border-radius: 1px;
    transform: rotate(45deg);
  }
  .ws-trp__cat.is-pill .ws-trp__shape,
  .ws-trp__cat.is-plane .ws-trp__shape {
    width: 0.95em;
    border-radius: 999px;
  }
  .ws-trp__cat.is-anchor .ws-trp__shape {
    border-radius: 50% 50% 45% 45%;
    border-style: double;
  }
  .ws-trp__src {
    margin: 0.45em 0 0;
    font-size: 0.75em;
    line-height: 1.4;
    opacity: 0.7;
    /* 单行 + 省略号：它常换行到 3 行，而面板高度要留给图例（整行文字挂 title 里可读全量）。
       ⚠️ 别改成多行——实测多行时最后一行图例会被 max-height 切一半（截图里看得到）。 */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (prefers-reduced-motion: reduce) {
    .ws-trp__cat {
      transition: none;
    }
  }
</style>
