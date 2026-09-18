<template>
  <!--
    地图上的「人」这一层（P2-1）—— 覆盖在小区图上、**跟着地图一起缩放平移**。

    为什么放在手势的变换容器（.ws-neigh__pan / .ws-geo__pan）里面：
      它是地图的一部分，不是悬浮 HUD。放进变换容器后，平移/缩放由手势那一层负责，
      这里一个 transform 都不用写；否则每次手势都要在这里重算一遍，必然对不齐。

    为什么还要再套一层 .ws-avs__box：
      地图 SVG 的 viewBox 是正方形（`0 0 size size`），而盒子常常是长方形的，
      CSS 用 `object-fit: contain` 居中留白（信箱）。头像要落在**图上**而不是盒子上，
      就必须复刻同一套信箱折算 —— 纯数学在 wsActors.ts 的 letterboxOf()，
      盒子尺寸由 useElementSize 量出来（与后端 SVG 的 1:1 约定一致）。
  -->
  <div class="ws-avs" :class="{ 'is-mini': size === 'mini' }">
    <!-- T4-3：压暗层（聚光灯）。放在**头像下面**（z-index:3 < 头像的 4）——
         被聚焦的那一枚头像由下面那条 `:has()` 规则抬到 9，于是"光打在他身上、
         其余压暗"的层次才对。没有聚焦时这个节点根本不存在（零开销）。 -->
    <WsEventFocus
      v-if="showFocusMark"
      variant="veil"
      :queue="effQueue"
      :placed="viewActors"
      :grid="grid"
      :zoom="zoom"
      :low="low"
      :box-w="w"
      :box-h="h"
    />
    <div ref="host" class="ws-avs__box">
      <WsAvatarMark
        v-for="a in viewActors"
        :key="a.id"
        :data-actor="a.id"
        :actor="a"
        :box-w="w"
        :box-h="h"
        :grid="grid"
        :size="size"
        :zoom="zoom"
        :drag="drag"
        :plan="planOf(a)"
        :selected="a.id === selectedId"
        :focused="!!focusOf(a)"
        :focus-title="focusOf(a)?.title || ''"
        :me-name="meName"
        @pick="(x) => emit('pick', x)"
        @dragstart="(x) => emit('dragstart', x)"
        @dragmove="(p) => emit('dragmove', p)"
        @dragend="(p) => emit('dragend', p)"
      />
      <!-- T4-3：浏览器通路下「头像为什么是占位」的如实说明。
           绝不假装拿到了真头像 —— 真壳里这条不显示（那时走的是真图或"该角色没有头像文件"）。 -->
      <span v-if="showDegrade" class="ws-avs__note" :title="degradeTitle">{{ degradeText }}</span>
      <!-- P4-4：拖动中的落点预览（一枚「目的地」图钉）。
           放在同一个信箱盒子里，坐标由页面算好（页面才知道手势变换）。
           `pointer-events:none` + `data-no-gesture`：它是纯显示，绝不参与任何交互。 -->
      <span
        v-if="dragPin"
        class="ws-avs__pin"
        data-no-gesture
        :style="{
          left: `${dragPin.x.toFixed(2)}px`,
          top: `${dragPin.y.toFixed(2)}px`,
          transform: `translate(-50%, -100%) scale(${(1 / (zoom > 0 ? zoom : 1)).toFixed(4)})`,
        }"
        aria-hidden="true"
        >📍</span
      >
    </div>
    <!-- T4-3：亮圈 + 铭牌。放在**头像上面**（z-index:5 > 头像的 4），
         否则亮圈会被头像自己盖掉一圈。 -->
    <WsEventFocus
      v-if="showFocusMark"
      variant="mark"
      :queue="effQueue"
      :placed="viewActors"
      :grid="grid"
      :zoom="zoom"
      :low="low"
      :box-w="w"
      :box-h="h"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, ref } from "vue";
  import WsAvatarMark from "./WsAvatarMark.vue";
  import WsEventFocus from "./WsEventFocus.vue";
  import { useElementSize } from "@/composables/useWorldSimGeo";
  import { isTauriRuntime } from "@/api/services/worldMap";
  import {
    avatarFallbackText,
    avatarPlanOf,
    focusOfRole,
    useWsFocus,
    type AvatarPlan,
    type FocusQueueState,
  } from "./wsFocus";
  import { scatterGrid, spreadCrowdMemo, type PlacedActor } from "./wsActors";
  import { spreadOptsOf } from "./wsPerf";
  import { useWsRoster } from "./wsRoster";

  const props = withDefaults(
    defineProps<{
      placed: PlacedActor[];
      grid?: number;
      selectedId?: string;
      meName?: string;
      size?: "map" | "mini";
      /**
       * 地图当前的缩放倍率（手势那套）。
       *
       * 头像层在变换容器内部，所以位置会自动跟着缩放走；
       * 但**尺寸**也会被一起放大 —— 传进来让每个头像 `scale(1/zoom)` 抵消，
       * 效果就是「钉在地图上的那块地，但始终是屏幕上这么大」。
       * 小地图（size='mini'）没有手势，保持 1。
       */
      zoom?: number;
      /** P4-4：这一层的人能不能拖（默认不能；只有主地图打开） */
      drag?: boolean;
      /** P4-4：拖动中的落点预览（**信箱盒子坐标**，由页面算；null = 没在拖） */
      dragPin?: { x: number; y: number } | null;
      /**
       * T4-3：重大事件聚焦队列（`useWsFocus().queue`）。
       *
       * 两种形状都收（`Ref` 或裸对象）：小地图那条路只传值，主地图传的是 ref。
       * 传进来之后，被聚焦的那一枚头像会拿到 `is-focused` —— 那是**唯一**的跨组件
       * 契约：聚光灯的压暗层靠父级 `:has()` 规则把这一枚抬到它之上。
       * **不传时本层行为与从前逐字节一致**（两个 WsEventFocus 都不渲染）。
       */
      focus?: FocusQueueState | { value: FocusQueueState } | null;
      /** T4-3：低性能档（去掉光晕/旋转动画，只留静态描边） */
      low?: boolean;
    }>(),
    {
      grid: 28,
      selectedId: "",
      meName: "",
      size: "map",
      zoom: 1,
      drag: false,
      dragPin: null,
      focus: null,
      low: false,
    }
  );

  const emit = defineEmits<{
    (e: "pick", a: PlacedActor): void;
    (e: "dragstart", a: PlacedActor): void;
    (e: "dragmove", p: { a: PlacedActor; clientX: number; clientY: number }): void;
    (e: "dragend", p: { a: PlacedActor; clientX: number; clientY: number; moved: boolean }): void;
  }>();

  // 量「信箱盒子」的尺寸：它就是用来复刻 object-fit: contain 的参照物
  const host = ref<HTMLElement | null>(null);
  const { w, h } = useElementSize(host, { w: 320, h: 320 });

  /** 网格边长的 ref 形态（兜底名单的散点与错开要用；props.grid 是数字） */
  const gridRef = computed(() => Math.max(1, Number(props.grid) || 28));

  /** 当前是不是真壳（浏览器预览恒为 false）——全层共用一次判定，别逐个角色去问 */
  const tauri = isTauriRuntime();

  /* ── T4-3：名单兜底（只在"地图上一个角色都没有"时生效）────────────────────
   *
   * 为什么要它：卡片第 2 条要的是「角色带头像 / 路人保持圆点」的**视觉区分**，
   * 那就得地图上同时有这两种人。而浏览器通路下 `loadWorldCharacters()` 的兜底 URL
   * 是 `/api/schedule/chars` —— **8791 上没有这条路由**（实测 404，只有 `/api/schedule`），
   * 于是浏览器里角色恒为空、地图上只剩玩家一个 ⇒ 这一条根本看不到。
   *
   * 兜底数据来自**本机真实服务**的 `/api/schedule`（姓名/目录都是真的），
   * 位置如实标成 `scatter`（本地散开）—— 不假装他们站在某个真实设施里。
   * 真壳里 `enabled: false`（名单走 `characterGetAll`），一次请求都不发。
   * 详见 `wsRoster.ts` 的文件头（含"该修哪一处"的交回说明）。
   */
  const roster = useWsRoster({
    enabled: !tauri,
    existing: computed(() => (props.placed || []).filter((a) => !a.isMe).length),
  });
  onMounted(() => {
    void roster.load();
  });

  /**
   * 视图真正用的名单 = 页面给的 `placed` **或**（它里面一个角色都没有时）兜底名单。
   *
   * 为什么是"或"而不是"并"：`placed` 是 `useWsActors` 装配的真名单，
   * 一旦它里面有角色（真壳里正常情况），兜底就必须**完全不参与** ——
   * 否则同一张图上会既有真位置的角色、又有散点推的角色，看起来像鬼影。
   */
  const viewActors = computed<PlacedActor[]>(() => {
    const list = props.placed || [];
    if (tauri || list.some((a) => !a.isMe)) return list;
    // ⚠️ 这一行**必须**留着：`roster.toActors()` 是个普通函数，里面 `chars.value` 的读取
    //    不算在这个 computed 的依赖里 —— 不显式读一次，名单到了也不会重算
    //    （表现是"兜底名单永远不出现"，而且完全没有报错，最难查的那种）。
    const chars = roster.chars.value;
    // 玩家自己的名字后端不给（`MapActor.name` 是空串），`WsAvatarMark` 靠 i18n 的
    // `worldsim.actor.me` 兜底成「我」—— 但**首字母占位**只认 `name`，会画出一个 `?`
    // （实测截图里就是那个问号）。这里补一次与 i18n 同义的兜底名，纯粹为了占位好看。
    const named = list.map((a) => (a.isMe && !String(a.name || "").trim() ? { ...a, name: "我" } : a));
    if (!chars.length) return named;
    const extra = roster.toActors(gridRef.value, scatterGrid);
    if (!extra.length) return named;
    // 兜底的人也要过一遍错开（同坐标的人不能叠在一起）——复用同一套纯函数
    const g = gridRef.value;
    const spread = spreadCrowdMemo(
      extra.map((a) => ({ x: a.gx, y: a.gy })),
      g,
      Math.max(0.6, g * 0.055),
      spreadOptsOf(props.low)
    );
    const placedExtra: PlacedActor[] = extra.map((a, i) => ({
      ...a,
      px: spread[i]?.x ?? a.gx,
      py: spread[i]?.y ?? a.gy,
      crowd: spread[i]?.crowd ?? 1,
    }));
    // 玩家永远在最后（压在最上面，与 useWsActors.placed 的顺序约定一致）
    return [...placedExtra, ...named];
  });
  /* ── T4-3：头像计划（真壳命令 vs 浏览器降级）────────────────────────────
   *
   * 判据全在纯函数 `avatarPlanOf` 里（可单测），这里只负责把三样东西喂给它：
   *   ① 这个人的 `folder`（有没有 = 是不是 LingChat 角色）
   *   ② `avatarUrl` **是不是真的**有值（空白串不算 —— 后端偶尔会给 `" "`）
   *   ③ 当前是不是真壳（`isTauriRuntime()`：浏览器预览恒为 false）
   *
   * ⚠️ 浏览器里 `avatarUrl` **一定是空**：`get_avatar_file` 是真壳命令
   *   （web-mock 对未登记命令返回 undefined，`isTauriRuntime()` 也为 false）。
   *   所以浏览器里看到的一律是**首字母色块占位** —— 这是如实的降级，
   *   不是"没做"也不是"假装拿到了"。真壳里同一行代码走的就是真头像。
   */
  const plans = computed<Map<string, AvatarPlan>>(() => {
    // 小地图（mini）不画占位字母也不显示说明：那一档只有纯色点，见 WsAvatarMark
    const m = new Map<string, AvatarPlan>();
    // ⚠️ 必须遍历 `viewActors`（含兜底名单）——遍历 `props.placed` 的话，
    //    兜底来的角色拿不到 plan，会退回 `WsAvatarMark` 的默认值（碰巧等价，但那是巧合）
    for (const a of viewActors.value) {
      m.set(a.id, avatarPlanOf(a, !!String(a.avatarUrl || "").trim(), tauri));
    }
    return m;
  });
  function planOf(a: PlacedActor): AvatarPlan | undefined {
    return plans.value.get(a.id);
  }

  /** 这一枚被聚焦了吗（拿的是队列里那一条，标题要显示在铭牌上） */
  function focusOf(a: PlacedActor) {
    const q = effQueue.value;
    if (!q) return null;
    if (a.isMe) return focusOfRole(q, a.name);
    return focusOfRole(q, a.name) || focusOfRole(q, a.folder);
  }

  /**
   * 聚焦队列的**当前值**（统一两种入参形状：Ref 或裸对象）。
   *
   * 为什么要兼容裸对象：小地图（`WsMePanel` 里那份）只传值，主地图传 ref。
   * 兼容的成本就是这三行，而要求两个调用方都包一层 ref 会更容易写错。
   */
  const focusQueue = computed<FocusQueueState | null>(() => {
    const f = props.focus as FocusQueueState | { value: FocusQueueState } | null;
    if (!f) return null;
    const v = (f as { value?: FocusQueueState }).value;
    return v || (f as FocusQueueState);
  });

  /**
   * T4-3：本层**自己**的聚焦态（`useWsFocus` 的唯一实例）。
   *
   * 为什么由这一层持有实例、而不是只等页面的 prop：
   *   ① 页面的自动聚焦（`useWorldEvents.onFired` → `focusEvent()`）接线还没做，
   *      但**演示/手动聚焦**必须现在就能用 —— 否则整套光学在浏览器里一条都验不了
   *      （与机主「所有改动都要能第一时间在浏览器验证」直接冲突）；
   *   ② `useWsFocus` 的 `demo` 钩子要有**真实调用点**才不会被 tree-shaking 摇掉
   *      （踩过：`ws:focus-demo` 那个字符串在 dist 里根本找不到）。
   *   ③ 页面接好线之后，两边**不打架**：`focus` prop 一旦有内容就优先用它
   *      （见下面的 `focusQueue` 兜底顺序），本层自己那份只承载"页面没管"的那些。
   */
  const local = useWsFocus({ demo: true });
  /** 真正给模板用的队列：页面给的优先，其次才是本层自己收到的（演示/手动） */
  const effQueue = computed<FocusQueueState | null>(() => focusQueue.value || local.queue.value);

  /** 有可画的聚焦条目吗（没有就一个节点都不渲染，零开销） */
  const showFocusMark = computed(() => (effQueue.value?.items?.length || 0) > 0);

  /** 有几个 LingChat 角色是"占位"（用来决定要不要挂那条说明） */
  const placeholderCount = computed(() => {
    let n = 0;
    for (const p of plans.value.values()) if (p.mode === "letter") n++;
    return n;
  });

  /**
   * 那条说明要不要显示。
   *
   * 只在**浏览器通路**且**确实有角色拿不到图**时显示 —— 两个理由：
   *   · 真壳里 `fallback === 'nofile'`（这个角色确实没有头像文件）不需要一条常驻说明，
   *     头像自己的 `title` 已经说清了；
   *   · 小地图（mini）不显示（地方太小，而且那一档根本不画字母）。
   */
  const showDegrade = computed(
    () => props.size === "map" && placeholderCount.value > 0 && !tauri
  );
  // 里外两层信息：外层说"几个是占位"，`title` 说清**为什么**是占位（浏览器通路 vs 没有文件）。
  // 只有浏览器通路会走到这里（真壳里 `showDegrade` 恒为 false），所以原因固定是"需真壳命令"。
  const degradeText = computed(() => `🛈 ${placeholderCount.value} 个角色头像是占位`);
  const degradeTitle = computed(() => avatarFallbackText("browser").fallback);

</script>

<style scoped>
  .ws-avs {
    position: absolute;
    inset: 0;
    /* 这一层只是个定位参照：绝不能吃掉地图手势的事件 */
    pointer-events: none;
    z-index: 3;
  }
  .ws-avs__box {
    position: absolute;
    inset: 0;
  }
  /* 拖动中的落点图钉：纯显示（不吃事件），只动 transform */
  .ws-avs__pin {
    position: absolute;
    transform-origin: 50% 100%;
    font-size: 1.6em;
    line-height: 1;
    pointer-events: none;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35));
    opacity: 0.95;
    z-index: 5;
  }
  /* T4-3：浏览器通路的"头像为什么是占位"说明条。
     钉在头像盒子的左下角（不遮地图主体），`pointer-events:none` 免得吃掉手势。 */
  .ws-avs__note {
    position: absolute;
    left: 0.35em;
    bottom: 0.35em;
    padding: 0.1em 0.45em;
    font-size: 0.68em;
    line-height: 1.5;
    color: var(--ws-fg-dim);
    background: var(--ws-panel);
    border: 1px dashed var(--ws-border);
    border-radius: 999px;
    opacity: 0.9;
    pointer-events: none;
  }
  /* ── T4-3：被聚焦的头像必须盖在聚光灯的压暗层（z-index:6）**之上** ──────────
     不抬的话，聚光灯中心那一枚头像自己也被压黑了 —— 完全反了。
     为什么只能在这里抬：头像都在 `.ws-avs`（z-index:3）这个层叠上下文**内部**，
     给头像自己加 z-index 是**抬不出父级上下文**的，必须由父级容器让路。
     `:has()` 的浏览器门槛（Chrome 105+ / Android WebView 105+）与
     `backdrop-filter`（本项目到处在用）基本同级；退一步，即使不支持，
     也只是"聚焦的头像被压暗了一点点"，不影响功能。 */
  .ws-avs:has(.ws-av.is-focused) .ws-av.is-focused {
    z-index: 9;
  }
</style>
