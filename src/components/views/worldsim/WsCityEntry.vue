<!--
  WsCityEntry.vue —— `/worldsim` 的**新入口**（2026-09-26 机主拍板：「**彻底替掉官方那套 UI**」）

  ## 这一屏是什么
  「世界模拟」入口 = **代拍页那一屏（MapLibre 3D 地图）**，外加一层**首次引导**
  （选城市 → 下载该城市的楼房数据 → 进地图）。上游那套 DataV 全国 SVG 下钻
  （`WorldSim.vue`：顶栏 ⋯ 抽屉 / 34 个区划 / 「点『进入』才下钻」/ 未读角标 / 小地图 /
  「选别的地方」）**不再是被引用的入口**（文件留着，路由里一行可回退）。

  ## 为什么地图是"常驻"而不是"引导完再挂"
  · 机主要的是「进 `/worldsim` **直接是地图**」—— 这一屏**始终**是一张 3D 地图；
  · 引导是**盖在它上面的一张 sheet**：首屏不白等，关掉 sheet 立刻就是可用地图；
  · 装过城市（`localStorage` 里有记录）⇒ **sheet 根本不出现**（机主：「装过就直接进地图，别每次问」）。
  · 「仍然进入地图」这条**必须在**（机主认过）：清单/包取不到时引导不能变成死路。

  ## 共享真源（PR 门禁 C1：App 侧不许第二份实现）
  这一屏**一行地图逻辑都没有**：地图本体与交通设施都在 `WsSceneView`（→ `WsDistrictMapLibre`），
  层/主题/相机/取数全走 `wsScene` / `wsMapTheme` / `wsOfflineFeed` / `wsGwLayer` … 那套共享真源。
  本文件只做三件：**挂地图 + 决定引导开不开 + 决定顶栏显示什么**。

  ## 顶栏的取舍（机主：「多余的UI，按钮」）
  只留一行、常驻元素 ≤3（`UI-DESIGN-SPEC.md` 的浮块上限）：
    · `←`            回主菜单（老入口也有，**不是**新造的）
    · `🌏 世界模拟 + 城市名`  唯一的状态显示（当前在用哪座城市的数据）
    · `🗺 城市数据`   打开引导 sheet（改选/重下/删除城市都在这张 sheet 里）
  去掉的：`⋯ 抽屉`（地图主题/皮肤/深浅 —— 3D 地图自己那套主题在 HUD 的 🎨 里，
  "重新引导"被"城市数据"取代）· 未读角标 · 小地图 · 缩放按钮 · 「选别的地方」·
  DataV 的 34 个区划与「进入」按钮。

  ## 🆕 2026-10-01（切片①）· `WsPhone` 悬浮手机**挂回来了**
  当初去掉它的理由是"老入口在小区级本来也不显示它"；但它是这一屏**唯一能点开的玩法入口**
  （地图/导航、打车、公交地铁、日程、通讯、天气六个 app **早就实现了**，只缺一个挂载点）
  ⇒ 现在传 `:phone="!guideOpen"`（引导 sheet 开着时不挂，免得挡着那张 sheet）。
  手机本体一行没改（`worldmap/WsPhone.vue`），挂载点与兜底提示在 `WsSceneView.vue`。
-->
<template>
  <div class="wsce">
    <!-- 🗺 地图常驻（新入口 = 直接进 3D 地图）。
         `chrome=false` 只关掉底栏那三个按钮（「← 回到区县」在没有区县这一级时是死按钮）；
         `tf=false` 关掉交通设施那条接线 —— 它会发一条 `/api/roads`（真机冷查分钟级、必超时），
         而新入口要**默认 0 条 `/api/*`**（与代拍页默认口径一致）。两个开关都只改"显示/接线"，
         地图本体、层序、取数一行不动（那些仍是同一份共享真源）。
         `:phone="!guideOpen"`（切片①，2026-10-01）把悬浮手机挂上来；它默认是**收起的**
         （`WsPhone.vue` 自己记偏好、不自动弹出）⇒ 首屏仍然是"地图 + 顶栏"，不挡地图。 -->
    <WsSceneView
      :key="sceneKey"
      :area="areaLabel"
      adcode=""
      :chrome="false"
      :tf="false"
      :phone="!guideOpen"
      :markers="districtPins"
      @pick-actor="onPickActor"
    />

    <!-- ── 顶栏（一行三件；引导开着时让位给 sheet）───────────────────────── -->
    <header v-if="!guideOpen" class="wsce__top">
      <button class="wsce__btn" type="button" :title="t('worldsim.back')" @click="goMenu">←</button>
      <div class="wsce__brand">
        <span aria-hidden="true">🌏</span>
        <span class="wsce__name">{{ t("worldsim.title") }}</span>
        <span class="wsce__tag">{{ cityLabel }}</span>
      </div>
      <button class="wsce__btn" type="button" @click="openGuide">🗺 {{ t("worldsim.city.data") }}</button>
    </header>

    <!-- 没装过城市数据时的**常驻提示**（点了就开引导）——"少了一整座城市的楼房"这种事
         不能只躺在控制台里；它是可点的一条，不弹窗、不挡地图。 -->
    <button v-if="!guideOpen && !installedCount" class="wsce__chip" type="button" @click="openGuide">
      ⚠️ {{ t("worldsim.city.noCity") }}
    </button>

    <!-- ── 首次引导（一张 sheet；装过就不出现）────────────────────────── -->
    <WsCityGuide v-if="guideOpen" :store="store" @enter="closeGuide" />

    <!-- 🧑 角色面板（切片②，2026-10-01）：点地图上的人 → **同一张** `WsCharPanel`。
         · **复用**，不重画：页面里没有第二份抽屉/送礼弹层（PR 门禁 C1）。送礼弹层由面板
           内部就地打开（`WsCharPanel.quick('gift')`），页面**不需要**也**不许**再开一个。
         · `v-if` 用面板自己的开关 ⇒ 关着时 DOM **不存在**（不是 `display:none`；
           `.ws-drawer` 计数就是验收口径）。
         · `:data` 传的是**本文件早就建好的那一份** `useWsActors()`（它没有模块级缓存 ——
           再建一份，面板里的日程/设施就会跟地图上的人对不上）。
         · `:actor` 由 `panelTargetId` 从 `actors.placed` 反查（不新造第二份名单）。 -->
    <WsCharPanel
      v-if="panelOpen"
      :actor="currentActor"
      :data="actors"
      :area-text="areaLabel"
      :narrow="panelNarrow"
      :open="panelOpen"
      :portrait-open="panelPortrait"
      :current-role-id="currentRoleId"
      :affinity="currentAffinity"
      :affinity-rank="currentAffinityRank"
      @close="closePanel"
      @portrait="togglePortrait"
      @goto-chat="onGotoChat"
      @quick="onQuick"
      @gift="onGift"
      @direct="onDirect"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import { useRouter } from "vue-router";
  import { useI18n } from "vue-i18n";
  import WsSceneView from "./WsSceneView.vue";
  import WsCityGuide from "./WsCityGuide.vue";
  /* 🧑 切片②（2026-10-01）：角色面板 = **同一个** `WsCharPanel.vue`（PR 门禁 C1：不许第二份实现）。
     它内部自己带 `WsGiftSheet`（送礼弹层），所以页面**不** import 那个弹层 —— 页面侧只有
     "开面板 / 接住 @gift" 两件事。 */
  import WsCharPanel from "./WsCharPanel.vue";
  import { type InstalledCity, cityStore } from "./wsCityStore";
  /* 🧑‍🤝‍🧑 **地图上的人**（M1-1）：装配逻辑全在既有的 `useWsActors` 里（**不新造第二套**）；
     钉子形状的换算调**共享纯函数** `wsActors.districtPinsOf()`（老入口 `WorldSim.vue` 调的是同一份）。 */
  import { useWsActors } from "@/composables/useWsActors";
  import { districtPinsOf, type PlacedActor, type WsDistrictPin } from "./wsActors";
  /* 🧑 面板的开关/选中（模块级单例，与地图组件 `WsDistrictMapLibre.vue` 读的是同一份）。 */
  import { useWsPanel } from "@/composables/useWsPanel";
  /* 💗 好感的**唯一真源**：`+6` 是 `wsRelation.ts` 的 `SOURCE_WEIGHT.gift`，
     页面只说"谁被送了什么"，**不写死任何数字**。 */
  import { rankOf as relRankOf, useWsRelation } from "./wsRelation";
  /* 🔔 提示：push 进 `wsToast` 的模块级队列，由 `WsSceneView` 挂的 `WsToasts` 渲染
     （本页 `:phone="!guideOpen"` ⇒ 同一条开关；不自己再挂一份渲染处）。 */
  import { wsToast } from "./wsToast";
  /* 🎮 角色库/当前对话角色（`gameStore`）—— 与孤儿页**同一个 store**（那边的 import 在 `WorldSim.vue:481`；
     `currentRoleId` 的算法照抄 `WorldSim.vue:916-918`，见下面）。 */
  import { useGameStore } from "@/stores/modules/game";
  /* 🔌 **把场景推给 Rust**（`scene` 在不在 = `world_sim_enabled()` 的判据）：契约与"退出必须推 null"
     都在 `wsRuntimePush.ts` 头部注释里（唯一真源），这里只调。 */
  import { clearRuntime, pushRuntime } from "./wsRuntimePush";

  const router = useRouter();
  /* `te` = 词条在不在（`actionLabel` 要用：缺词条就退回 action 原样，不编词） */
  const { t, te } = useI18n();
  const store = cityStore();

  /** 已经装好的城市（`[]` = 确实一个都没装 —— 这是"已量"，不是"读不到"） */
  const installed = ref<InstalledCity[]>([]);
  const guideOpen = ref(false);
  /** 装过城市后**不重挂地图**：本片只是"选 + 下 + 记住"，让地图用上这份数据是下一片的事 */
  const sceneKey = ref(0);

  const installedCount = computed(() => installed.value.length);

  /* ── 🧑‍🤝‍🧑 角色（M1-1）────────────────────────────────────────────────────────
     🔴 **列表驱动 + 数量可变**：一个 id、一个名字都不写死。
       · 名单（App 侧两级）：① `useWsActors.load()` 内部先取 `gameStore.gameRoles` +
         `loadWorldCharacters()`（`src/composables/useWorldMapBindings.ts:25`；真壳里第一级走
         LingChat 自己的角色接口 `characterGetAll` ⇒ **创意工坊新加的角色自动在内**）；
         ② 兜底 = `/api/schedule` 的 `characters[]`（`src/api/services/worldMap.ts:287`）
         ⇒ Rust `list_characters()`（`src-tauri/src/world_map/schedule.rs:242`）**扫角色目录**
         （`data_dir()/game_data/characters/<角色目录>/settings.yml`）⇒ 目录里多一个角色就多一个。
       · 位置：`useWsActors` 的三级站位（runtime → 日程设施点 → `scatterGrid` 散点），
         `posSource` 如实带在每个钉子上。
       ⇒ **新增角色不用改这里一行代码**：名单长了，钉子就多了。 */
  const actors = useWsActors();
  const districtPins = computed<WsDistrictPin[]>(() =>
    districtPinsOf(actors.placed.value || [], actors.schedule.value?.characters || [], 28)
  );
  /* ══ 🧑 切片②（2026-10-01）：点人 → 角色面板 → 送礼 → 好感 ────────────────────
     本片只做**接线**，三件事各有唯一真源，页面一行都不重写：
       · 面板本体与送礼弹层 → `WsCharPanel.vue`（含内部的 `WsGiftSheet.vue`）；
       · 「谁被选中」的 UI 状态 → `useWsPanel()`（模块级单例；地图组件也读它来判断"面板开着吗"）；
       · 好感的数与档位 → `useWsRelation()`（`+6` 来自 `SOURCE_WEIGHT.gift`，**页面不写死数字**）。 */
  const wsPanel = useWsPanel();
  /* 模板里只对**顶层** ref 自动解包 ⇒ 从对象里解出来的这几个必须单独拿（嵌套的不会解）。 */
  const {
    open: panelOpen,
    targetId: panelTargetId,
    portraitOpen: panelPortrait,
    narrow: panelNarrow,
    closePanel,
    togglePortrait,
  } = wsPanel;

  const relation = useWsRelation();

  /**
   * 面板当前对着的那个人 —— 从**本文件早就有的那一份** `actors.placed` 反查。
   *
   * 🔴 为什么不再 `useWsActors()` 一次：它**没有模块级缓存**（`useWsActors.ts:159-175`），
   * 每次调用都是新的一份状态 ⇒ 面板里的日程/设施会与地图上的人对不上（而地图读的是第一份）。
   * 玩家自己（`targetId === "me"`）也在 `placed` 里（id 固定 `me`）⇒ 这条反查一并覆盖。
   */
  const currentActor = computed<PlacedActor | null>(
    () => actors.placed.value.find((a) => a.id === panelTargetId.value) || null
  );
  /** 面板上那一格好感（页面只读真源，不做任何加权/衰减） */
  /* 🔴 为什么要一个 `affinityTick`：`wsRelation.ts` **一行 vue 都不 import** —— 它的 store 是
     **普通对象**（不是 `ref`/`reactive`），`gift()` 只是原地换掉 `store.rows` ⇒
     **computed 收不到通知**。不 bump 这一下，送完礼面板上那一格会停在送礼前的数字
     （"好感 +6 并立刻显示"就不成立）。这是本片为"非响应式真源"打的**唯一**一个补丁，
     真源本身一行没改（`wsRelation.ts` 仍是唯一真源，数字仍由 `SOURCE_WEIGHT` 决定）。 */
  const affinityTick = ref(0);
  const currentAffinity = computed(() => {
    void affinityTick.value; // 显式依赖：送礼后自增 ⇒ 强制重算（见上）
    return currentActor.value ? relation.affinityOf(currentActor.value.name) : 0;
  });
  /** 好感档位文案：调真源的 `rankOf()`（面板只负责显示，判据不重复实现） */
  const currentAffinityRank = computed(() => relRankOf(currentAffinity.value));

  /** 当前正在对话的角色 id（「去找他聊聊」据此决定直连还是先确认）—— 照抄孤儿页 `WorldSim.vue:916-918` */
  const gameStore = useGameStore();
  const currentRoleId = computed(() => Number(gameStore.currentInteractRoleId ?? gameStore.mainRoleId) || 0);

  /**
   * 地图上点了某个人（`WsSceneView` 透传上来的 `pick-actor`）⇒ 开面板。
   * 开法照抄孤儿页 `WorldSim.vue:1145-1147`（`wsPanel.openPanel(a.isMe ? "me" : a.id)`）。
   *
   * ⚠️ `roster:` 开头的兜底钉子（`districtPinsOf` 在"一个真角色都没装配上"时散点推的）
   *    在 `actors.placed` 里**反查不到真 actor** ⇒ 必须如实说一句，**不许静默**
   *    （点了没反应是机主最烦的一种）。
   */
  function onPickActor(id: string): void {
    const a = actors.placed.value.find((x) => x.id === id);
    if (!a) {
      wsToast("这个人还没装配到地图上（名单兜底钉子），面板开不了", "info");
      return;
    }
    wsPanel.openPanel(a.isMe ? "me" : a.id);
  }

  /**
   * 送礼**真的送出去了**（面板内部的 `WsGiftSheet` 已经扣背包 + 记账）。
   * 这一段照抄孤儿页 `WorldSim.vue:1061-1070`：页面只办**好感**这件事 ——
   * `relation.gift(role)` 内部按 `SOURCE_WEIGHT.gift`（= 6）加，**页面不写死数字**。
   */
  function onGift(p: { name: string; icon: string; role: string }): void {
    const role = String(p?.role || "").trim();
    if (!role) {
      // 拿不到角色名就不假装记上了（宁可少做，不可编数据）
      wsToast("这个角色还没有绑定的角色库 ID，好感没能记下", "info");
      return;
    }
    const row = relation.gift(role);
    affinityTick.value += 1; // 真源不是响应式的 ⇒ 手动通知面板重算（见 currentAffinity 的注释）
    wsToast(
      `${p.icon || "🎁"} ${p.name || "礼物"} 已送出 · ${role} 好感 ${row.affinity}（${relRankOf(row.affinity)}）`,
      "info"
    );
  }

  /**
   * 「去找他聊聊」（面板 `@goto-chat` 与快捷动作 `hi` 走同一条）—— 照抄孤儿页 `WorldSim.vue:1162-1175`。
   *
   * ⚠️ 这里**故意不调用** `select_character`：Rust 侧它会 `init_game_status()`，把当前对话整份重置 ——
   * 从地图上点一下就清空聊天记录是绝不能做的破坏性操作 ⇒ 已在聊就直跳，换人先确认。
   */
  function onGotoChat(a: PlacedActor): void {
    if (!a?.roleId) {
      wsToast(t("worldsim.chat.noRole"), "warn");
      return;
    }
    if (a.roleId === currentRoleId.value) {
      void router.push("/chat");
      return;
    }
    const ok = window.confirm(t("worldsim.chat.switchWarn", { name: a.name }));
    if (ok) void router.push("/chat");
  }

  /** 动作名（给"还没接"的提示用）：词条在就用词条，缺了退回 action 原样（不编词） */
  function actionLabel(action: string): string {
    const k = `worldsim.action.${action}`;
    return te(k) ? t(k) : action;
  }

  /**
   * 快捷动作分派（只接**本片真接了**的那两条，其余如实说"还没接"）。
   *
   *   · 打招呼   → `onGotoChat`（跳 /chat，零副作用）
   *   · 送礼物   → 面板内部**已经就地打开** `WsGiftSheet`（`WsCharPanel.quick()`）⇒ 这里什么都不做，
   *                 真正的记账/好感在 `@gift` 那条路（`onGift`）。
   *                 ⚠️ 孤儿页这里是个空 `return` + "需求未澄清"的注释（`WorldSim.vue:1187-1200`）——
   *                 需求已经落地，**别照抄那句空转**，也**不许在页面重画一份弹层**。
   *   · 约他出门 / 其它 → 那条线（`world_map_trip_start`）不在本片 ⇒ 如实 toast 一句「本片还没接」。
   */
  function onQuick(action: string, a: PlacedActor): void {
    if (action === "hi") {
      onGotoChat(a);
      return;
    }
    if (action === "gift") return; // 面板自己开了送礼弹层（本函数不是它的入口）
    wsToast(`「${actionLabel(action)}」本片还没接`, "info");
  }

  /** 面板的「指挥他去某地」（P4-4）：要 `world_map_trip_start` + 干预开关那条线 —— 本片没接，如实说 */
  function onDirect(to: string): void {
    wsToast(`「去${to}」本片还没接`, "info");
  }

  /** 当前在用哪座城市的数据（HUD 之外唯一的一处状态显示） */
  const cityLabel = computed(() => {
    if (!installed.value.length) return t("worldsim.city.noCityTag");
    return installed.value.map((c) => c.name).join("、");
  });

  /** 地图"区域名"（`WsSceneView` 只把它当显示名用；真实机位仍由地图自己的默认值决定） */
  const areaLabel = computed(() => (installed.value.length ? installed.value[0].name : ""));

  /* 「别每次问」：跳过过一次就记住（但**常驻提示不会消失** —— 上面那条 chip 仍在，
     点它随时能回来装）。装过城市 ⇒ 本来就不会自动开。 */
  const SKIP_KEY = "ws.cityguide.skipped.v1";

  function skipped(): boolean {
    try {
      return localStorage.getItem(SKIP_KEY) === "1";
    } catch {
      return false; // 读不到 localStorage ⇒ 当没跳过（宁可问一次，也别让引导永远不出现）
    }
  }

  function rememberSkip(): void {
    try {
      localStorage.setItem(SKIP_KEY, "1");
    } catch {
      /* 记不住就算了：最多下次再问一遍 */
    }
  }

  function openGuide(): void {
    guideOpen.value = true;
  }

  function closeGuide(): void {
    installed.value = store.installed();
    if (!installed.value.length) rememberSkip();
    guideOpen.value = false;
  }

  function goMenu(): void {
    router.push("/");
  }

  onMounted(() => {
    installed.value = store.installed();
    /* 首次引导的开屏判据（**唯一一处**）：没装过任何城市 + 没跳过过 ⇒ 开。
       ⚠️ 这里**不读清单**：读清单是 sheet 自己的事（它要显示三态与原因）。
       入口只关心"要不要问"，这样清单服务挂了也不影响进地图。 */
    guideOpen.value = !installed.value.length && !skipped();
    /* 🧑‍🤝‍🧑 装配「地图上的人」：**有界重试**（最多 20 次 × 500ms ≈ 10s，成功即停、不常驻轮询）——
       与代拍页 `kickBldBundle` / 名字层 `kickNames` 同一个形状。这一屏原来只装配一次，
       而"名单 / 头像 / 日程"三条通路任一慢半拍就会**静默出 0 个人**（机主看到的就是"地图上没人"）。

       🔴 **F7（2026-10-01 性能审计 §5.3）**：原来的发起判据是 `n === 0 || n % 4 === 0` ⇒
       **每一次重试都把整轮重打一遍**（`actors.load()` = 5 条 `/api/schedule` + `/api/schedule/chars`），
       首屏实测这些请求全挤在 2.9~4.2s 的关键路径上；而"装配成功、只是今天没有人"那种情况它照样再打 5 轮
       （用户感知不到任何好处，纯属白花 5 轮请求）。
       ⇒ 现在**只在必要时才打**：① 第一轮必打；② 之后**只有上一轮真的失败**（判据用**真源自己的**
       `loadError`，不另造一套）**且**离上次发起 ≥4 拍，才再打一次（保留原来的退避节奏）。
       装配成功（哪怕今天一个人都没有）⇒ 后面一拍都不再打；`done`（有人了）⇒ 立刻停。
       纪律逐条不变：**有界**（最多 6 次尝试 / 20 拍 ≈10s）、**成功即停**、**不常驻轮询**。 */
    let actorsInflight = false;    // 这一拍有没有在飞的装配（不许叠着打）
    let actorsLoadFailed = false;  // 上一次装配的实况（真源 loadError；没试过 = false）
    let actorsTriedAt = -99;       // 上一次**发起**在第几拍（退避用）
    (function kickActors(tries) {
      const n = tries || 0;
      const done = districtPins.value.filter((p) => !p.isMe).length > 0;
      /* ⚠️ 这里**不放** `window.__WS_ACTORS__` 之类的自证出口 —— 主对话定过规矩：
         **App 里不许塞调试出口**（否决过 `window.__w3d` / `__GW__`）。探头一律读**产品自己的**
         DOM 契约（`.maplibregl-marker` 的数量/位置/`title`）与**协议事实**（`/api/schedule` 请求）。
         （同理**不留**"只给探针看"的 computed：没人读的读数就是死代码 + 调试残留，主对话复核时删过一份。） */
      if (done) return;
      if (n === 0 || (!actorsInflight && actorsLoadFailed && n - actorsTriedAt >= 4)) {
        actorsTriedAt = n;
        actorsInflight = true;
        void actors
          .load()
          .then(() => { actorsLoadFailed = !!actors.loadError.value; })
          .catch(() => { actorsLoadFailed = true; })
          .finally(() => { actorsInflight = false; });
      }
      if (n >= 20) return;
      window.setTimeout(() => kickActors(n + 1), 500);
    })(0);
  });

  /* ── 🔌 把场景推给 Rust（`MapRuntime.scene`）────────────────────────────────────
     **为什么必须推**（真源 = `wsRuntimePush.ts` 头部注释，这里只复述结论）：
       · `scene` 在不在 = `world_sim_enabled()`（`src-tauri/src/world_map/state.rs:618`）的**唯一判据**；
       · 它 false 时：`producer.rs:63` 的位置指令剥离器**不启用**（AI 回话里的 `⟦wm:…⟧` 会漏进正文），
         且 `role_manager.rs:360` 的 `injection_for()` 返回空 ⇒ **角色不知道自己在哪**；
       · 老入口 `WorldSim.vue:1132` 一直在推，但 `/worldsim` 现在指向**本组件** ⇒ 这两件事**全关了**。
     推什么：`area`（本屏就是"在用哪座城市"）+ 地图上的人（键必须是角色的 display_name，见契约 ①）。
     ⚠️ **退出必须推 `{scene:null}`**（`clearRuntime()`）—— 不清的话 AI 会一直带着上次的地图上下文说话。 */
  watch(
    () => [areaLabel.value, districtPins.value.map((p) => p.id + ":" + (p.posSource || "")).join(",")] as const,
    () => {
      void pushRuntime({
        area: areaLabel.value || undefined,
        actors: actors.placed.value || [],
      });
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    void clearRuntime();
  });
</script>

<style scoped>
  /* 铺满整屏（与老入口 `.ws-root` 同一套定位口径：`fixed + inset:0 + z-index:50`）——
     地图组件自己是 `position:absolute; inset:0`，需要一个有定位的满屏父容器。 */
  .wsce {
    position: fixed;
    inset: 0;
    z-index: 50;
    overflow: hidden;
    background: #0a0f16;
  }

  .wsce__top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    /* 只让**这一条**吃手势，其余地方照旧留给地图（拖动/捏合不能被顶栏吃掉） */
    pointer-events: none;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .wsce__top > * {
    pointer-events: auto;
  }
  .wsce__btn {
    padding: 6px 10px;
    border-radius: 10px;
    border: 1px solid rgba(121, 217, 255, 0.28);
    background: rgba(7, 11, 17, 0.66);
    color: #eaf6ff;
    font: inherit;
    cursor: pointer;
    /* 🆕 2026-09-28 兼容矩阵实测：这颗「←」只有 **30×33**（WCAG 触控目标 44×44 不达标）；
       顶栏这两个按钮是这一屏**最常点的东西**（返回 / 城市数据）⇒ 撑到 44 高、至少 44 宽。
       用 inline-flex 居中：只加内边距，不放大底板，视觉上不至于变成"大黑板"。 */
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .wsce__brand {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px 10px;
    border-radius: 10px;
    background: rgba(7, 11, 17, 0.5);
    color: #eaf6ff;
  }
  .wsce__name {
    font-weight: 700;
  }
  .wsce__tag {
    max-width: 42vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(121, 217, 255, 0.16);
    color: #9fd8ef;
    font-size: 11px;
  }
  .wsce__chip {
    position: absolute;
    left: 8px;
    top: 46px;
    z-index: 30;
    padding: 5px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 207, 138, 0.42);
    background: rgba(7, 11, 17, 0.62);
    color: #ffcf8a;
    font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: pointer;
  }
</style>
