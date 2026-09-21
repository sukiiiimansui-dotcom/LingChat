<template>
  <!--
    T2-1 step2 · 地图上的「设施」这一层（生活 7 类 + 交通 7 类）

    ## 为什么是这个坐标系
    后端给的 `gx/gy` 是**小区图的格点**（`facilities.rs` 的小区布局网格），
    与 `WorldSim.vue` 的 `WS_GRID=28` / `WsDistrict` 的 `SKETCH_SIZE=28` 同一套。
    所以本层要放进 `WsDistrict` 的 `#pin` 插槽（`.ws-neigh__pan` 手势变换容器内）——
    与 WsAvatarLayer/WsVehicleMark/WsWindowLight 同一个位置：
      · 放进变换容器 → 平移/缩放**自动**跟着走，本组件一行 transform 都不用写；
      · 尺寸会被一起放大 → 每枚标记 `scale(1/zoom)` 抵消，屏幕尺寸恒定。

    **不要**把这一层画到 GeoJSON 画布上（那是行政区划的经纬度坐标系，两套东西）。
    卡片里说的「接收投影函数或容器尺寸」，这里走的是**容器尺寸**那条：
    与头像层共用 `letterboxOf()`（`wsActors.ts`），没有抄一份地图渲染逻辑。

    ## 为什么有面板（而不是纯标记）
    卡片的验收里有一条「支持开关（至少按类别过滤 + 总数显示）」。
    面板如果渲染在本组件里，它就在**手势变换容器内部**，会被地图带着缩放平移
    （放大 4× 时图例变成巨大一块）。所以面板走 `<Teleport>` 到 `.ws-root`
    （WorldSim 的页面根，主题变量 `--ws-*` 也在那一层，`position: fixed` 的定位上下文），
    既不跟地图缩放，又能吃到主题色/深色模式。
    ⚠️ `.ws-root` 不存在时（例如被单独塞进别的页面）退回 `body`：
       那时 `var(--ws-*)` 取不到，样式里每处都写了显式兜底色，不会变成透明字。
    `panel="none"` 可以整个关掉面板，只留标记层（接线时若不想要这块 UI 就传它）。

    ## 诚实性（本卡最容易做假的地方）
    取不到数据时**绝不画点**、也**绝不说"这里没有设施"**：
    面板显示「设施数据取不到 + 原因」，标记层一个点都不渲染。
    "后端返回 0 个" 与 "请求失败" 是两种不同的状态，`wsFacilities.ts::emptyState()` 分开表述。
  -->
  <div class="ws-fac" :class="{ 'is-off': !visible }" :data-shown="shown.length" data-testid="ws-fac">
    <!-- `:key="showSeq"` —— 每"出现"一次（数据到手 / 重新打开显示）就重建这批节点，
         让下面那条错峰淡入**重播**（见 script 里 `showSeq` 的说明）。 -->
    <div :key="showSeq" ref="host" class="ws-fac__box" data-testid="ws-fac-box">
      <!-- 标记：一个设施 = 一枚（按类型给图标 + 配色，占地尺寸按格数还原） -->
      <span
        v-for="(m, i) in marks"
        :key="m.p.id"
        class="ws-fac__mark"
        :class="{ 'is-big': m.label }"
        :data-type="m.p.type"
        :data-id="m.p.id"
        data-testid="ws-fac-mark"
        :style="{
          left: `${m.r.cx.toFixed(2)}px`,
          top: `${m.r.cy.toFixed(2)}px`,
          width: `${m.r.w.toFixed(2)}px`,
          height: `${m.r.h.toFixed(2)}px`,
          // 反缩放写进自定义属性：样式表里那条 scale() 用它，避免每个点内联一整套 transform
          '--ws-fac-inv': `${(1 / (zoom > 0 ? zoom : 1)).toFixed(4)}`,
          '--ws-fac-c': meta(m.p.type).color,
          '--ws-fac-fill': meta(m.p.type).fill,
          // 错峰淡入的**第几拍**（在 JS 里夹好上限，样式表直接乘间隔 —— 免得 CSS min() 在老 WebView 上算不出）
          '--ws-fac-d': delayOf(i),
        }"
        :title="`${meta(m.p.type).zh} · ${m.p.name}`"
      >
        <i class="ws-fac__ico" aria-hidden="true">{{ meta(m.p.type).icon }}</i>
        <!-- 名字只在"格子够大 / 是地标"时写（照抄 Python draw_facilities 的取舍） -->
        <b v-if="m.label" class="ws-fac__name">{{ m.p.name }}</b>
      </span>
    </div>

    <!-- ── 图例 / 开关面板（Teleport 出地图变换容器）── -->
    <Teleport v-if="panel !== 'none'" :to="panelHost">
      <div class="ws-facp" :class="{ 'is-collapsed': collapsed }" data-testid="ws-fac-panel">
        <button
          class="ws-facp__head"
          type="button"
          data-no-gesture
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <span class="ws-facp__title">🏥 设施图层</span>
          <span class="ws-facp__total" data-testid="ws-fac-total">{{ totalText }}</span>
          <span class="ws-facp__chev">{{ collapsed ? "▸" : "▾" }}</span>
        </button>

        <div v-show="!collapsed" class="ws-facp__body">
          <!-- 三种"没有点"的状态各说各的，绝不混成一句"暂无设施" -->
          <p v-if="state.kind !== 'ok'" class="ws-facp__state" :class="`is-${state.kind}`" data-testid="ws-fac-state">
            <span>{{ state.text }}</span>
            <em v-if="state.detail">{{ state.detail }}</em>
          </p>

          <label class="ws-facp__sw" data-no-gesture>
            <input v-model="visible" type="checkbox" data-testid="ws-fac-visible" />
            <span>显示设施</span>
          </label>

          <div class="ws-facp__grp">
            <label class="ws-facp__sw" data-no-gesture>
              <input v-model="filter.life" type="checkbox" data-testid="ws-fac-life" />
              <span>生活设施</span>
            </label>
            <label class="ws-facp__sw" data-no-gesture>
              <input v-model="filter.transport" type="checkbox" data-testid="ws-fac-transport" />
              <span>交通设施</span>
            </label>
          </div>

          <!-- 按类别过滤：**7 类生活全在这里**，另 7 类交通展开时才出现 -->
          <div class="ws-facp__cats">
            <button
              v-for="r in rows"
              :key="r.key"
              class="ws-facp__cat"
              type="button"
              data-no-gesture
              :data-cat="r.key"
              :data-on="r.on ? '1' : '0'"
              :class="{ 'is-on': r.on, 'is-zero': r.count === 0 }"
              :style="{ '--ws-fac-c': r.color, '--ws-fac-fill': r.fill }"
              :title="`${r.zh}：${r.count} 个（点一下开关这一类）`"
              @click="toggleCat(r.key)"
            >
              <i aria-hidden="true">{{ r.icon }}</i>
              <span>{{ r.zh }}</span>
              <b>{{ r.count }}</b>
            </button>
          </div>

          <!-- 数据来源如实写出来：落点到底贴着哪份布局，是"贴住真建筑"还是"只对齐网格" -->
          <p class="ws-facp__src" data-testid="ws-fac-src">
            {{ srcLine }}
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
  import { useElementSize } from "@/composables/useWorldSimGeo";
  import { facilitiesAuto, facilitiesTypesAuto } from "@/api/services/worldMap";
  import type { FacPayload, FacTypesPayload } from "@/api/services/worldMap";
  import { hash32 } from "./wsGeo";
  import { letterboxOf } from "./wsActors";
  import {
    categoryRows,
    cleanPoints,
    defaultFilter,
    emptyState,
    filterPoints,
    gridMismatch,
    markerRect,
    metaOf,
    shouldLabel,
    sourceText,
    totalLine,
    type FacFilter,
    type FacPoint,
  } from "./wsFacilities";

  const props = withDefaults(
    defineProps<{
      /** 区域名「广州市·越秀区」——决定草图布局与设施播种（与 WsDistrict 同一个值） */
      area: string;
      /** 小区图网格边长（`WS_GRID`）。**必须与页面显示的那张图一致**，否则点会整体错位 */
      grid?: number;
      /** 地图手势的缩放倍率：标记位置跟着缩放走，尺寸用 `scale(1/zoom)` 抵消 */
      zoom?: number;
      /** 交通设施层级：community（默认）/ district / city */
      level?: string;
      /** 地图库布局缓存 key —— 传了就落在**玩家实际看到的那张图**上（最准） */
      layoutKey?: string;
      /**
       * 随机种子。**默认 = `hash32(area)`**，与 `WsDistrict` 画草图用的是同一个数
       * ⇒ 刷新后设施位置不变（卡片验收项）。
       * 只有测试才该显式传它；传 `Date.now()` 会让设施每次刷新乱跳。
       */
      seed?: number;
      /** `fixed`（默认）= 渲染图例/开关面板；`none` = 只留标记层，不要那块 UI */
      panel?: "fixed" | "none";
    }>(),
    { grid: 28, zoom: 1, level: "community", layoutKey: "", seed: -1, panel: "fixed" }
  );

  const emit = defineEmits<{ (e: "loaded", v: { shown: number; total: number }): void }>();

  const host = ref<HTMLElement | null>(null);
  const { w, h } = useElementSize(host);

  const visible = ref(true);
  const collapsed = ref(false);
  const filter = reactive<FacFilter>(defaultFilter());

  /**
   * 「出现」的代数（MG 动效剩余项 ⑤：设施图层**错峰淡入**）。
   *
   * 为什么需要一个计数器而不是只挂一条 CSS 动画：动画只在**节点被创建**时跑一次，
   * 而这一层有两种"出现" —— ① 数据到手（挂载）；② 用户把「显示设施」重新打开。
   * 第二种如果只靠 CSS，节点是一直在场的（`:class="{ 'is-off': !visible }"` 只是藏起来）
   * ⇒ **关了再开不会重播**，观感上就是"这个开关没有反馈"。
   * 所以把它当 `:key` 挂在标记容器上：每"出现"一次就换一次 key ⇒ 节点重建 ⇒ 错峰重播。
   * 代价：重建几十个 `<span>`（不含数据请求、不含地图重绘），换的是一次明确的开场。
   */
  const showSeq = ref(0);
  watch(
    () => visible.value,
    (v) => {
      if (v) showSeq.value += 1;
    }
  );

  /**
   * 错峰间隔（`UI-DESIGN-SPEC.md`：stagger **20~40ms**）。取 26ms。
   * 上限 12 档：设施多的社区（几十个点）不能让最后一个等到一秒以后 ——
   * 那样读起来不是"错峰"而是"卡住了"。所以**超过 12 个之后同批落定**。
   */
  const STAGGER_MS = 26;
  const STAGGER_CAP = 12;
  function delayOf(i: number): string {
    return `${Math.min(i, STAGGER_CAP) * STAGGER_MS}ms`;
  }

  const payload = ref<FacPayload | null>(null);
  const types = ref<FacTypesPayload | null>(null);
  const loading = ref(false);
  const error = ref("");

  /** 面板挂到哪个宿主：优先 WorldSim 的页面根（带主题变量），没有就 body */
  const panelHost = ref<string>("body");
  onMounted(() => {
    if (typeof document === "undefined") return;
    panelHost.value = document.querySelector(".ws-root") ? ".ws-root" : "body";
  });

  /** 有效种子：默认与 WsDistrict 的草图种子**逐位相同**（这是"刷新不变"的根据） */
  const effSeed = computed(() =>
    props.seed >= 0 ? props.seed >>> 0 : hash32(props.area || "world")
  );
  const effSize = computed(() => (props.grid > 0 ? Math.round(props.grid) : 28));

  /** 全部点（生活 + 交通，已清洗）；后端两条数组按 group 分开给 */
  const cleaned = computed(() => {
    const d = payload.value;
    if (!d) return { points: [] as FacPoint[], dropped: 0 };
    const g = Number(d.grid) || effSize.value;
    const a = cleanPoints(d.facilities, g);
    const b = cleanPoints(d.transport, g);
    return { points: [...a.points, ...b.points], dropped: a.dropped + b.dropped };
  });
  const all = computed(() => cleaned.value.points);
  /** 被丢掉的非法点数。**不在 computed 里写 ref**（那是副作用，Vue 会警告且可能反复触发） */
  const dropped = computed(() => cleaned.value.dropped);

  const shown = computed(() => (visible.value ? filterPoints(all.value, filter) : []));

  const lb = computed(() => letterboxOf(w.value, h.value, effSize.value));

  const marks = computed(() =>
    shown.value.map((p) => {
      const r = markerRect(p, lb.value, effSize.value);
      return { p, r, label: shouldLabel(p, r, props.zoom) };
    })
  );

  const rows = computed(() => categoryRows(all.value, types.value?.types, filter));

  const counts = computed(() => {
    const life = all.value.filter((p) => p.group !== "transport").length;
    const transport = all.value.length - life;
    return { life, transport, shown: shown.value.length };
  });

  const totalText = computed(() => totalLine(counts.value));

  const state = computed(() =>
    emptyState({
      loading: loading.value,
      error: error.value,
      total: all.value.length,
      shown: visible.value ? shown.value.length : 0,
      area: payload.value?.area || props.area,
    })
  );

  /** 数据来源那一行：布局来源 + 网格核对（对不上要显式说出来，别闷头画） */
  const srcLine = computed(() => {
    const d = payload.value;
    if (!d) return error.value ? "没取到数据" : "…";
    const bits: string[] = [sourceText(d.layout_source)];
    const mm = gridMismatch(d.grid, effSize.value);
    if (mm) bits.push(mm);
    if (dropped.value) bits.push(`丢弃 ${dropped.value} 个非法点`);
    bits.push(`种子 ${effSeed.value}`);
    return bits.join(" · ");
  });

  function meta(t: string) {
    return metaOf(t, types.value?.types);
  }

  function toggleCat(key: string) {
    const i = filter.off.indexOf(key);
    if (i >= 0) filter.off.splice(i, 1);
    else filter.off.push(key);
  }

  /** 取数代次：慢响应回来时若已换了区域就丢掉，避免"上一个区的设施画在这个区上" */
  let token = 0;

  async function load() {
    const my = ++token;
    loading.value = true;
    error.value = "";
    try {
      // 类型表与设施并取（类型表失败不算致命：wsFacilities 有内置兜底表，会在面板里标明）
      const [fac, typ] = await Promise.all([
        facilitiesAuto({
          area: props.area,
          size: effSize.value,
          seed: effSeed.value,
          level: props.level,
          key: props.layoutKey || undefined,
        }),
        facilitiesTypesAuto().catch(() => null),
      ]);
      if (my !== token) return; // 过期响应
      payload.value = fac;
      types.value = typ;
      emit("loaded", { shown: shown.value.length, total: all.value.length });
    } catch (e) {
      if (my !== token) return;
      // **不静默降级成空数组**：空数组在界面上等于"这里没有设施"，那是假话
      payload.value = null;
      types.value = null;
      error.value = errText(e);
    } finally {
      if (my === token) loading.value = false;
    }
  }

  function errText(e: unknown): string {
    if (e instanceof Error && e.message) return e.message;
    const s = String(e ?? "");
    // 真壳里最可能的两种情况：命令没注册 / 浏览器里 8791 没起
    if (/not found|unknown command|未注册/i.test(s)) return `${s}（Tauri 命令没注册？）`;
    if (/Failed to fetch|NetworkError|load failed/i.test(s)) return `${s}（后端 8791 没起？）`;
    return s || "未知错误";
  }

  onMounted(load);
  watch(
    () => [props.area, effSize.value, effSeed.value, props.level, props.layoutKey],
    () => load()
  );
  // 手动认领的卡不建议在页面里塞定时器；这里只在可见性变化时通知父级一次
  watch(shown, (v) => emit("loaded", { shown: v.length, total: all.value.length }));

  /** 供页面/自动化采样读取（也是"点是不是真的画了"的证据来源） */
  defineExpose({
    reload: load,
    points: all,
    shownPoints: shown,
    error,
    /** 后端原始返回（面板上"来源/种子"那几行就是从这里读的） */
    payload,
    /** 面板 HTML 挂在哪（自动化脚本据此确认面板真的在 DOM 里） */
    panelHost,
  });

  onBeforeUnmount(() => {
    token++; // 卸载后回来的响应一律丢弃
  });
</script>

<style scoped>
  .ws-fac {
    position: absolute;
    inset: 0;
    /* 与头像层同款：这一层只做定位参照，绝不吃地图手势的事件
       （标记本身也不可点 —— 交互都在面板里，见文件头"为什么有面板"） */
    pointer-events: none;
    /* 压在头像层（z-index:3）**下面**：设施是地面，人应该站在上面 */
    z-index: 2;
  }
  .ws-fac.is-off {
    display: none;
  }
  .ws-fac__box {
    position: absolute;
    inset: 0;
  }
  .ws-fac__mark {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.15em;
    box-sizing: border-box;
    /* 反缩放锚在中心：放大 4× 时标记仍是屏幕上这么大（与头像同一个套路） */
    transform: translate(-50%, -50%) scale(var(--ws-fac-inv, 1));
    transform-origin: 50% 50%;
    /* 用类型色描边 + 极淡填充：既能看出类别，又不把底下的建筑盖死 */
    border: 1.5px solid var(--ws-fac-c, #8899aa);
    border-radius: 3px;
    background: var(--ws-fac-fill, rgba(136, 153, 170, 0.22));
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    overflow: visible;
    line-height: 1;
    /* 「出现时错峰淡入」（MG 动效剩余项 ⑤；间隔见 script 的 STAGGER_MS/CAP）。
       ⚠️ 关键帧里**必须把基准 transform 一起写上**（`translate(-50%,-50%)` + 反缩放），
       否则动画期间元素会丢掉"锚在中心"和"屏幕尺寸恒定"这两条，
       表现是**一出现时整片点向左上角窜一下**再弹回来（这条是推导出来的：动画期间
       是 keyframes 的 transform 在生效，不是上面那条声明）。 */
    animation: ws-fac-in 0.36s cubic-bezier(0.22, 0.68, 0.32, 1) both;
    animation-delay: var(--ws-fac-d, 0ms);
  }
  /* 低档：错峰淡入整条摘掉（几十个点同时做透明度合成，正是低档最该省的东西）。
     信息一条不少：点直接以终态出现。`.ws-root.ws-perf-low` 是**祖先链**上的类
     （打在 WorldSim 的页面根），scoped 的作用域属性只加在链尾 ⇒ 跨组件照样命中。 */
  .ws-root.ws-perf-low .ws-fac__mark {
    animation: none;
  }
  .ws-fac__ico {
    font-style: normal;
    /* 图标尺寸跟着标记大小走（clamp 兜住 1×1 格与超大占地两端） */
    font-size: clamp(7px, 68%, 22px);
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.3));
    user-select: none;
  }
  .ws-fac__name {
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
    pointer-events: none;
  }

  /* ── 面板（Teleport 到 .ws-root，不跟地图缩放）────────────────────────
     位置：左下角、抬到底部情境卡之上（`.ws-zoomctl` 在右下角、底部卡在 bottom:0）。
     z-index 55：盖住地图内容（层内 3~6），低于角落小窗（60）/ 主菜单（1000）。 */
  .ws-facp {
    position: absolute;
    left: 0.7em;
    bottom: 5.6em;
    z-index: 55;
    width: 13.5em;
    max-height: 62%;
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
    /* 面板是 DOM UI，要能点（不在手势容器里，所以不会抢地图的拖动） */
    pointer-events: auto;
  }
  .ws-facp__head {
    display: flex;
    align-items: center;
    gap: 0.4em;
    width: 100%;
    padding: 0.4em 0.55em;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ws-facp__title {
    font-weight: 600;
    white-space: nowrap;
  }
  .ws-facp__total {
    flex: 1;
    font-size: 0.85em;
    opacity: 0.8;
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ws-facp__chev {
    opacity: 0.7;
    font-size: 0.9em;
  }
  .ws-facp__body {
    padding: 0 0.55em 0.55em;
    overflow-y: auto;
    /* 面板里唯一可滚的区域：内容多了不会把整个面板顶出屏幕 */
    overscroll-behavior: contain;
  }
  .ws-facp__state {
    margin: 0.2em 0 0.5em;
    padding: 0.35em 0.45em;
    border-radius: 0.4em;
    font-size: 0.85em;
    line-height: 1.4;
    background: rgba(0, 0, 0, 0.05);
  }
  .ws-facp__state em {
    display: block;
    margin-top: 0.15em;
    font-style: normal;
    font-size: 0.9em;
    opacity: 0.75;
    word-break: break-all;
  }
  .ws-facp__state.is-error {
    background: rgba(220, 90, 90, 0.16);
    border: 1px solid rgba(220, 90, 90, 0.4);
  }
  .ws-facp__state.is-empty,
  .ws-facp__state.is-filtered {
    background: rgba(200, 160, 60, 0.16);
    border: 1px solid rgba(200, 160, 60, 0.38);
  }
  .ws-facp__sw {
    display: flex;
    align-items: center;
    gap: 0.35em;
    padding: 0.15em 0;
    font-size: 0.9em;
    cursor: pointer;
    user-select: none;
  }
  .ws-facp__sw input {
    width: 1em;
    height: 1em;
    accent-color: var(--ws-primary, #8fd6c0);
  }
  .ws-facp__grp {
    display: flex;
    gap: 0.8em;
  }
  .ws-facp__cats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25em;
    margin-top: 0.35em;
  }
  .ws-facp__cat {
    display: inline-flex;
    align-items: center;
    gap: 0.2em;
    padding: 0.15em 0.35em;
    border: 1px solid var(--ws-fac-c, #8899aa);
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
  .ws-facp__cat.is-on {
    opacity: 1;
    background: var(--ws-fac-fill, rgba(136, 153, 170, 0.26));
  }
  .ws-facp__cat.is-zero {
    /* 这一类在这张图上一个都没有：如实置灰，别让人以为开关坏了 */
    border-style: dashed;
    opacity: 0.35;
  }
  .ws-facp__cat b {
    font-weight: 600;
    opacity: 0.85;
  }
  .ws-facp__src {
    margin: 0.45em 0 0;
    font-size: 0.75em;
    line-height: 1.4;
    opacity: 0.7;
    word-break: break-all;
  }
  /* 设施标记的入场（错峰淡入，MG 动效剩余项 ⑤）。
     ⚠️ 只动 `opacity` + `transform`；`transform` **必须整条复述**基准值
     （`translate(-50%,-50%)` 定位锚点 + `scale(var(--ws-fac-inv))` 反缩放）——
     动画期间生效的是 keyframes 里的 transform，漏掉任何一段，标记就会在入场时
     "窜位"或"忽大忽小"。 */
  @keyframes ws-fac-in {
    from {
      opacity: 0;
      transform: translate(-50%, -50%) scale(var(--ws-fac-inv, 1)) scale(0.55);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%) scale(var(--ws-fac-inv, 1)) scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ws-facp__cat {
      transition: none;
    }
    /* 全局那条 reduced-motion 规则把**时长**压成 0.001ms，但**延时还在** ——
       带着 `both` 填充，标记会先以 opacity:0 停最多 12 拍（约 0.3s）才出现，
       读起来就是"点了开关没反应，过一会儿才蹦出来"。所以这里把延时也归零。 */
    .ws-fac__mark {
      animation-delay: 0ms;
    }
  }
</style>
