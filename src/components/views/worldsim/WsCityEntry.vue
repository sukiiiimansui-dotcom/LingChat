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
  只留一行（`UI-DESIGN-SPEC.md` 的浮块上限按**块**算，顶栏整体仍是 1 块）：
    · `←`            回主菜单（老入口也有，**不是**新造的）
    · `🌏 世界模拟 + 城市名`  唯一的状态显示（当前在用哪座城市的数据）
    · `🗺 城市数据`   打开引导 sheet（改选/重下/删除城市都在这张 sheet 里）
    · `🏙 楼房 100 栋` 🆕 2026-10-03 **楼房档位开关**（机主：「一开始直接固定可显示的楼房数据，
      严格限制，但是要求用户可在选择是否启用多楼房模式（不推荐）」）—— 默认严格档，
      点一下切"多楼房模式（不推荐）"。**只在这一行里加一颗按钮**，没有再冒第四个浮块；
      上限数字与档位分别来自真源 `wsBldBudget` / `wsBldMode`，本页不写数（见 script 里那段注释）。
  去掉的：`⋯ 抽屉`（地图主题/皮肤/深浅 —— 3D 地图自己那套主题在 HUD 的 🎨 里，
  "重新引导"被"城市数据"取代）· 未读角标 · 小地图 · 缩放按钮 · 「选别的地方」·
  DataV 的 34 个区划与「进入」按钮。

  ## 🆕 2026-10-01（当晚第三轮 · 切片③）· 「🏠 我的家 + 今日三件事」常驻浮块
  机主那一轮的「继续开发（好看，稳定，可玩）」要的日常循环（动森式 M1-1/M1-2）**原型页早就跑通了**
  （`public/ws3dshow.html:4436-4531`），但 App 侧**零消费者**（`grep -rn "wsDaily" src/` 只有
  `wsPageVendor.ts:65` 的 re-export）⇒ 这一片把它接进来：浮块 `WsDailyHud.vue` +
  落盘/跨天 `wsDailyStore.ts` + **第三条离线管道 places**（`WsDistrictMapLibre.vue`，家要从真名片区里挑）。
  · 事件走**新开的 `daily-ready`**（`WsSceneView` 在 `tf` 早退**之前**分流）—— 新入口是 `:tf="false"`，
    复用 `scene-ready` 那条 handler 会**永远收不到且不报错**（施工图 §5.1 的最大一个坑）。
  · 家/三件事/跨天**规则一行都不在本文件**：全在共享真源 `wsDaily.ts`（PR 门禁 C1）。
  · 体感边界（如实）：片区内**没有**离线包覆盖的名点 ⇒ 家会写「数不出来（原因）」，**不编一个家**；
    冷缓存下这是正常态（places 是新管道，包外机位永远选不到家）。

  ## 🆕 2026-10-02（期 1 · 世界开口）· **事件上屏 + 天气角标 + 消费权定死**
  三件事都与玩家可见的变化有关，所以放在一个切片里（`PLAN-GAMEPLAY.md:51-59` §期 1）：
    ① **事件上屏**：现实事件引擎（`useWorldEvents`，早就在跑）抽中一条时冒一个**瞬时气泡**
       （`WsEventBubble`，≈4.2 秒后自己消失 ⇒ **不是**常驻浮块，上面那条 ≤3 的账没被破坏）；
       popup 通道照孤儿页的语义弹一条 `wsToast`（配色按事件类别）。
       ⚠️ 气泡挂空名单（屏幕中央 + 写明是谁），因为这一屏是 MapLibre 真地理视图、
          `WsEventBubble` 的格网数学只对老 `WsDistrict` 成立（见 `bubblePlaced` 的注释）。
    ② **天气角标**接回（`WsWeatherBadge` + `useWorldWeather`）：孤儿页那一轮做完了却一直 0 挂载点。
    ③ 🔴 **待写记忆的消费权**（这一期最要紧的一条，计划里标红）：队列原先有两个消费方 ——
       Rust 注入路径（`state.rs::injection_text`）与前端面板的 `world_map_take_pending_memory`（drain）。
       两边抢同一个队列，前端一取走，AI 那一轮注入就**静默**少一段。
       **裁定：唯一消费方 = 注入路径**（行交付给模型后才划掉，`summary::memory_block` 的"交付即消费"）；
       前端从此只走新命令 `world_map_pending_memory`（**只读预览**，一行不取走；
       `useWorldEvents` 里 `drainMemory` 随之改名 `previewMemory`）。
       本页因此**不再**在任何检查点"顺手收一遍队列"。

  ## 🆕 2026-10-01（切片①）· `WsPhone` 悬浮手机**挂回来了**  当初去掉它的理由是"老入口在小区级本来也不显示它"；但它是这一屏**唯一能点开的玩法入口**
  （地图/导航、打车、公交地铁、日程、通讯、天气六个 app **早就实现了**，只缺一个挂载点）
  ⇒ 现在传 `:phone="!guideOpen"`（引导 sheet 开着时不挂，免得挡着那张 sheet）。
  手机本体一行没改（`worldmap/WsPhone.vue`），挂载点与兜底提示在 `WsSceneView.vue`。

  ## 🆕 2026-10-01（当晚第二轮）· 把**世界模拟的皮肤**挂回来（根元素加 `ws-root theme-mint` + import CSS）
  机主报「点了角色**连个UI都没有，字直接在地图上显示**」⇒ 实测：**这一屏根本没有 `--ws-*` 令牌表**。
  旧入口 `WorldSim.vue` 干了两件事：`import "@/assets/styles/worldsim.css"` + 根元素
  `class="ws-root <主题类>"`（令牌定义在 `.ws-root.theme-*` 下）；2026-09-26 换成这一屏时**两件都没做**
  ⇒ 部署包里 `--ws-panel:` **一处定义都没有、只有引用** ⇒ 抽屉/卡片的底色、边框、圆角、排版全丢。
  与当天早上那个「MapLibre 样式表没加载」是同一类病：**换入口漏挂全局依赖**。
  ⚠️ 但**不能只 import 就完事**：皮肤里 `--ws-blur` 是 `0px`（薄荷）/ `10px`（玻璃），而
  `blur(0px)` **不是"没有模糊"** —— 只要不是 `none`，浏览器就每帧读回底下像素（`worldsim.css:198-201`），
  而这一屏底下是每帧重画的 WebGL 画布 ⇒ 所以下面把两个 blur 令牌**显式置 `none`**。
-->
<template>
  <div class="wsce ws-root theme-mint" :class="{ 'wsce--panel': panelOpen }">
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
      @daily-ready="onDailyReady"
    />

    <!-- 🏠📋 切片③（2026-10-01）·「我的家 + 今日三件事」常驻浮块（M1-1 那一轮的日常循环搬进 App）。
         逻辑一行不在模板里：家/三件事/跨天全在共享真源 `wsDaily.ts`，落盘与编排在 `wsDailyStore.ts`；
         本页只把「地图中心 + 片区名 + 居民 + 设施名」喂进去，再把结果与勾选接回来。
         ⚠️ 它**不是**第四个常驻块：同屏常驻浮块 = 顶栏（1）+ 未装城市 chip（1，装过就不出现）+ 本块（1）
            ≤ 3（`UI-DESIGN-SPEC.md:108`）；引导 sheet 开着时不挂（与顶栏同一个开关）。 -->
    <WsDailyHud
      v-if="!guideOpen"
      :verdict="dailyVerdict"
      :home="dailyHomeName"
      :why="dailyWhy"
      :tasks="dailyTasks"
      :day="dailyDay"
      :note="dailyNote"
      @toggle="onDailyToggle"
    />

    <!-- 💬 期 1（2026-10-02）·**事件上屏**：现实事件引擎抽中一条时冒一个气泡（≈4.2 秒后自己消失）。
         数据层（tick 轮询 + `world_map:event` 广播 + 三通道开关）一行不在本文件：全在
         `useWorldEvents`（**已在跑**、也被孤儿页 `WorldSim.vue` 挂着）——这里只做接线。
         🔴 它是**瞬时**元素，不是常驻浮块（上面那条 ≤3 的账没被它破坏）。
         ⚠️ `:placed="[]"` 是**故意**的（详见 script 里 `bubblePlaced` 的注释）：
            这一屏是 MapLibre **真地理**视图，而 `WsEventBubble` 的定位数学
            （`letterboxOf` + `gridToBox` 那套 28×28 素描格网）只在老 `WsDistrict` 视图里成立；
            硬套过来气泡会**飘到错的地方**（比"居中说清是谁"更糟：那等于编了一个位置）。
            空名单 ⇒ 组件走它自己的兜底分支：屏幕中央浮一个并写明是谁（绝不静默丢弃）。
         ⚠️ `:max="1"` 也是同一个理由：都在屏幕正中 ⇒ 同时画 4 条会叠成一坨（谁也读不出来）。
            只画最新那条；到点它们照样自己消失（`WS_BUBBLE_MAX=4` 那个上限是给"有人头可挂"的场景用的）。 -->
    <WsEventBubble
      v-if="!guideOpen"
      :bubbles="wsEventBubbles"
      :placed="bubblePlaced"
      :grid="28"
      :me-name="meName"
      :max="1"
      :low="perfLow"
    />

    <!-- 🌤 期 1（2026-10-02）·**天气角标**接回 App 入口（孤儿页那一轮实现后一直 0 挂载点：
         `PLAYABLE-COVERAGE.md:396`）。真源是 `useWorldWeather`（真壳 invoke / 预览 HTTP 双通路，
         拿不到就显示「天气不可用」——**不显示晴天、不留空白**，见 `WsWeatherBadge.vue` 头注释）。
         ⚠️ 它自带 `backdrop-filter: blur(6px)`（`worldsim-weather.css:47`）⇒ 本页在 scoped 样式里
            就地改成 `none`（见文件末尾；**不改那个共享样式文件**，别的页还在用）。
         位置：右上角下来一点（顶栏那一排按钮在 top:0，角标默认 `top:.7em` 会压住「🗺 城市数据」）。 -->
    <WsWeatherBadge v-if="!guideOpen" :weather="wxState" />

    <!-- ── 顶栏（一行三件；引导开着时让位给 sheet）───────────────────────── -->
    <header v-if="!guideOpen" class="wsce__top">
      <button class="wsce__btn" type="button" :title="t('worldsim.back')" @click="goMenu">←</button>
      <div class="wsce__brand">
        <span aria-hidden="true">🌏</span>
        <span class="wsce__name">{{ t("worldsim.title") }}</span>
        <span class="wsce__tag">{{ cityLabel }}</span>
      </div>
      <button class="wsce__btn" type="button" @click="openGuide">🗺 {{ t("worldsim.city.data") }}</button>
      <!-- 🏙 2026-10-03 · **楼房档位开关**（顶栏第三个 chip；机主：「严格限制…但是要求用户
           可在选择是否启用多楼房模式（不推荐）」）。
           · 严格档显示「楼房 100 栋」（数字由真源给），点一下进多楼房模式；
           · 多楼房模式显示「楼房 多（不推荐）」，点一下回严格档；
           · `title` 是**鼠标悬停/长按能看懂代价**的那一句（更卡、不推荐）；
           · 点一下**立刻生效**：`toggleBldMode()` 改的是 `wsBldMode` 的模块级 ref，
             地图组件 `watch(bldMode)` → 既有的 `bldFlush("bldmode")` 通路当场重挑 + 重绘。 -->
      <button
        class="wsce__btn wsce__btn--bld"
        type="button"
        :title="bldChipTitle"
        @click="toggleBldMode"
      >
        {{ bldChipText }}
      </button>
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
      :needs="panelNeeds"
      :needs-note="panelNeedsNote"
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
  /* 🏠📋 切片③（2026-10-01）·「我的家 + 今日三件事」：
     浮块本体 = `WsDailyHud.vue`（只渲染）；落盘/跨天/编排 = `wsDailyStore.ts`（`now`/`storage` 双注入）；
     **规则**（怎么挑家、怎么排三件事、怎么跨天重置）= 共享真源 `wsDaily.ts`，本页一行都不写（PR 门禁 C1）。 */
  import WsDailyHud from "./WsDailyHud.vue";
  import { createDailyStore } from "./wsDailyStore";
  import type { DailyTask, PlacePoint, Resident, Spot } from "./wsDaily";
  import { type InstalledCity, cityStore } from "./wsCityStore";
  /* 💬🌤 期 1（2026-10-02）·「事件上屏 + 天气角标」：
     事件数据层 = `useWorldEvents`（**同一份** composable，孤儿页 `WorldSim.vue` 挂的也是它）；
     画气泡 = `WsEventBubble.vue`（一行渲染逻辑都不在本文件）；
     天气 = `useWorldWeather`（真壳 invoke / 预览 HTTP 双通路）+ `WsWeatherBadge.vue`。
     ⚠️ 天气角标的样式在**全局** `worldsim-weather.css` 里（组件自己不带 style），必须 import，
        否则角标是一行没有底色的裸字（换入口漏挂全局依赖是本页犯过两次的病，见文件头）。 */
  import WsEventBubble from "./WsEventBubble.vue";
  import WsWeatherBadge from "./WsWeatherBadge.vue";
  import { popupKindOf, useWorldEvents } from "@/composables/useWorldEvents";
  import { useWorldWeather } from "@/composables/useWorldWeather";
  import { useWsPerf } from "./wsPerf";
  import "@/assets/styles/worldsim-weather.css";
  /* ❤️⚡ 期 2（2026-10-02）·「心情 / 体力」：
     数值层的唯一真源 = `wsNeeds.ts`（0–1 量程 + 昼夜基线 + 天气/三件事折算 + 事件脉冲按半衰期衰减）。
     本页只**喂真实输入 + 推上去**，不在这里写任何一条换算（PR 门禁 C1：不许第二份实现）。 */
  import { localHourOf, needPairOf, useWsNeeds } from "./wsNeeds";
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
  /* 🎨 **世界模拟的皮肤**（令牌表 + `.ws-*` 组件的公共样式）。
     ⚠️ 它原来**只有旧入口 `WorldSim.vue` import** ⇒ 换成这一屏之后一直没加载，
     结果 `--ws-panel` 这类令牌全空、抽屉看起来就是"一堆字铺在地图上"（机主 2026-10-01 报的）。
     `worldsim.css` 里的令牌定义在 `.ws-root.theme-*` 下 ⇒ 根元素也必须挂 `ws-root`（见模板）。
     它是**全局皮肤**（不是 scoped）：这一屏内的 `.ws-btn` / `.ws-card` / 抽屉等一律受益。 */
  import "@/assets/styles/worldsim.css";
  /* 🏙 2026-10-03 · **楼房档位开关**（机主：「严格限制…但是要求用户可在选择是否启用多楼房模式（不推荐）」）。
     · **上限是多少** → 共享真源 `wsBldBudget`（`bldMaxDrawnOf(mode)`：严格档 100 / 多楼房 4000）；
     · **用户选了哪一档** → `wsBldMode`（`localStorage["wsm:v1:bldmode"]`，默认严格档）；
     · 本页只做**第三件事**：把两个真源读出来渲染成一颗 chip，点击转交 `toggleMode()`
       —— 一个数字、一条规则都不在这里重写（PR 门禁 C1）。
     点了**立刻生效**：地图组件 `watch(bldMode)` → `bldFlush("bldmode")` 当场重挑 + 重绘。 */
  import { bldMaxDrawnOf } from "./wsBldBudget";
  import { WS_BLD_MODE_MANY, useWsBldMode } from "./wsBldMode";

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

  /* ══ 🏙 2026-10-03 · 楼房档位（顶栏那颗 chip）══════════════════════════════════════════
     机主要的是**"默认就严格限制、想要多自己开"**，所以这一屏只需要三行接线：
       · 档位（`mode`）与切换（`toggleMode()`）来自 `wsBldMode`（模块级单例 ⇒ 地图那边同一份）；
       · chip 上的**数字**来自真源 `bldMaxDrawnOf()`（本页不写 100 / 4000）；
       · 文案来自 i18n（`worldsim.bld.*`）—— `title` 必须把"更卡、不推荐"讲出来。 */
  const { mode: bldMode, toggleMode: toggleBldMode } = useWsBldMode();
  /** chip 上的字：严格档「楼房 100 栋」/ 多楼房「楼房 多（不推荐）」 */
  const bldChipText = computed(() =>
    bldMode.value === WS_BLD_MODE_MANY ? t("worldsim.bld.many") : t("worldsim.bld.lean", { n: bldMaxDrawnOf("lean") })
  );
  /** 悬停/长按的说明：**点一下会发生什么 + 代价**（"多 ≠ 更好"要说在明面上） */
  const bldChipTitle = computed(() =>
    bldMode.value === WS_BLD_MODE_MANY
      ? t("worldsim.bld.manyTitle", { m: bldMaxDrawnOf(WS_BLD_MODE_MANY) })
      : t("worldsim.bld.leanTitle", { n: bldMaxDrawnOf("lean") })
  );

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

  /* ══ 🏠📋 切片③（2026-10-01）·「我的家 + 今日三件事」─────────────────────────────
     本页只做**接线**（规则全在共享真源 `wsDaily.ts`、落盘编排在 `wsDailyStore.ts`）：
       ① 接住 `WsSceneView` 的 `@daily-ready`（地图 + 片区名取值器）—— 那条事件**走的是 tf 早退之前**的分流，
          否则新入口（`:tf="false"`）永远收不到（见 `WsSceneView.onSceneReady` 的第一行）；
       ② 把「地图中心 + 片区名 + 居民 + 设施名」喂给 store，build 一次，然后**有界重试**（`kickDaily`）；
       ③ 把结果同步给 `WsDailyHud`，勾选交回 store。
     🔴 **App 里没有任何 `window.__*` 出口**（本文件 `:378-381` 那条规矩，原型的 `__WSD__`/`__WS_PLACES_N__`
        一个都不搬）：断言只读 DOM 契约（`[data-ws-daily*]`）与 `localStorage["wsDaily.v1"]`。 */
  const daily = createDailyStore();

  /** 地图（只为 `getCenter()` 与 `moveend` 两个用途；图层/相机一概不经手） */
  type DailyMapLike = {
    getCenter?: () => { lng: number; lat: number };
    on?: (ev: string, cb: () => void) => void;
  };
  let dailyMap: DailyMapLike | null = null;
  /** 片区名取值器（地图组件 → 薄壳 → 这里，**原样转上来**的那个）；null = 还没接上 */
  let dailyPlaces: (() => readonly PlacePoint[]) | null = null;

  const dailyHomeName = ref("");
  const dailyVerdict = ref(daily.verdict());
  const dailyWhy = ref("");
  const dailyTasks = ref<readonly DailyTask[]>([]);
  const dailyDay = ref(daily.day());
  const dailyNote = ref("");

  /** store 不是响应式的（普通对象）⇒ 每次 build/toggle 之后把结果**照抄**进 refs（不新造第二份状态） */
  function syncDaily(): void {
    dailyHomeName.value = daily.home()?.name || "";
    dailyVerdict.value = daily.verdict();
    dailyWhy.value = daily.why();
    dailyTasks.value = daily.tasks();
    dailyDay.value = daily.day();
    dailyNote.value = daily.note();
  }

  /** 地图中心（拿不到 ⇒ `null`：判词会写「没有地图中心 ⇒ 数不出来」，**不编一个位置**） */
  function dailyCenter(): { lng: number; lat: number } | null {
    try {
      const c = dailyMap?.getCenter?.();
      if (!c) return null;
      const lng = Number(c.lng);
      const lat = Number(c.lat);
      return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
    } catch {
      return null;
    }
  }

  /**
   * 居民 = 地图上的人**去掉自己**（`isMe`）。
   * 一个 id/名字都不写死（角色库多一个角色就自动在内）；「跟自己打个招呼」不是一件事，所以排除玩家。
   */
  function dailyResidents(): Resident[] {
    const out: Resident[] = [];
    for (const a of actors.placed.value || []) {
      if (!a || a.isMe || !a.id || !a.name) continue;
      out.push({ id: a.id, name: a.name });
    }
    return out;
  }

  /**
   * 设施/地点 = **只用真名**：`actors.placed[*].place`（日程里的设施名，`useWsActors.ts:361/376`）。
   * 🔴 **不许**搬原型页写死的 `SPOT`（`ws3dshow.html:401` 那个「重庆·渝中区」）—— 那会变成编地点。
   * 去重后**按名字排序**：`planDaily` 用 `dayHash % spots.length` 选一个 ⇒ 顺序变了当天就会换地方
   * （`actors.placed` 的顺序会随名单刷新变），排序是"同一天不抖"的一部分。
   */
  function dailySpots(): Spot[] {
    const seen = new Map<string, string>();
    for (const a of actors.placed.value || []) {
      const nm = String(a?.place || "").trim();
      if (!nm || seen.has(nm)) continue;
      seen.set(nm, `fac:${nm}`);
    }
    return [...seen.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([name, id]) => ({ id, name }));
  }

  /** 一次编排：读盘 → 挑家 → 排三件事 → 落盘（全在 store 里；这里只喂输入） */
  function rebuildDaily(): void {
    daily.build({
      places: dailyPlaces ? dailyPlaces() : [],
      center: dailyCenter(),
      residents: dailyResidents(),
      spots: dailySpots(),
    });
    syncDaily();
  }

  /**
   * 有界重试（**照 `kickActors` 同一形状**：最多 20 拍 × 500ms ≈ 10s、成功即停、**不常驻轮询**）。
   *
   * 为什么需要：地图中心 / 片区名（离线格要一批批取）/ 角色装配 三条通路谁慢半拍，
   * "三件事"就会**静默**退回占位（机器上看到的只是"没有名字的三件事"）—— 本文件 `:168-170` 记过这个病。
   * 每一拍只是**纯函数重算**（不取数、不发请求），所以代价可忽略。
   * 停的条件：**有家（或确实量到"这一带没有有名片区"）且有人**；到 20 拍也停，并把当时的实话显示出来。
   */
  const DAILY_TICKS_MAX = 20;
  let dailyTimer = 0;
  let dailyTick = 0;
  function kickDaily(): void {
    const stop = (): void => {
      if (dailyTimer) {
        window.clearTimeout(dailyTimer);
        dailyTimer = 0;
      }
    };
    const step = (): void => {
      dailyTimer = 0;
      rebuildDaily();
      let placesN = 0;
      try {
        placesN = dailyPlaces ? dailyPlaces().length : 0;
      } catch {
        placesN = 0;
      }
      /* "量到了"（家挑到了，或片区名确实到了 ⇒ pickHome 的判词已成事实）**且**有人 ⇒ 停 */
      const settled = !!daily.home() || placesN > 0;
      if (settled && dailyResidents().length > 0) {
        stop();
        return;
      }
      if (dailyTick >= DAILY_TICKS_MAX) {
        stop();
        return;
      }
      dailyTick += 1;
      dailyTimer = window.setTimeout(step, 500);
    };
    stop();
    dailyTick = 0;
    step();
  }

  /**
   * 地图与片区名到位（`WsSceneView` 转上来的 `daily-ready`）。
   * `moveend` ⇒ 重挑"家"（原型页的第二个触发点，`ws3dshow.html:4888`）：视野变了，最近的有名片区可能变了；
   * 已勾选的完成态由 `planDaily` 按 id 对齐继承（跨天/换任务才会重置）⇒ 拖动地图**不会**清空今天。
   */
  function onDailyReady(p: { map: unknown; places?: () => readonly PlacePoint[] }): void {
    dailyPlaces = typeof p?.places === "function" ? p.places : null;
    const m = (p?.map || null) as DailyMapLike | null;
    /* 只在新地图实例上挂一次（重挂地图时旧监听随旧实例消失 —— 与 `WsSceneView.onSceneReady` 同款守卫） */
    if (m && m !== dailyMap) {
      try {
        m.on?.("moveend", () => rebuildDaily());
      } catch {
        /* 挂不上不影响首屏（`daily-ready` 会随下一次 `scene-ready` 再来） */
      }
    }
    dailyMap = m;
    kickDaily();
  }

  /** 勾选一件事：真源 `toggleTask` + 落盘都在 store 里，本页只转发 */
  function onDailyToggle(id: string, done: boolean): void {
    daily.toggle(id, done);
    syncDaily();
  }

  /* ══ 💬 期 1（2026-10-02）·**事件上屏** + 待写记忆只读预览 ═══════════════════════════
     数据层（tick 轮询 + `world_map:event` 广播 + 三通道开关 + 待写记忆预览）**一行都不在本文件**：
     全在共享 composable `useWorldEvents`（孤儿页 `WorldSim.vue` 挂的是同一份 ⇒ 不存在第二份实现）。
     本页只做三件事：
       ① 把当前说话的角色名传进 tick（事件挂到正确的人头上靠它）；
       ② popup 通道：抽中时 `wsToast` 弹一条（配色按事件类别；气泡那一路由 composable 自己写 `bubbles`）；
       ③ 把 `bubbles` 交给 `WsEventBubble` 画（组件只负责画）。
     ⚠️ 生命周期：`/worldsim` 进来就是地图 ⇒ `autoStart`（引擎要 `scene` 才有意义，而本页
        `pushRuntime` 是 `immediate` 的）。离开本页：composable 自己 `onScopeDispose(stop)`，
        下面再显式 `stop()` 一次（自然检查点，与孤儿页同款）。
     ⚠️ 场景还没推上去（引导 sheet 开着 / 一个城市都没装）时，后端 `world_map_tick` 返回
        `reason:"no_scene"` 且**不写任何事件、不写任何记忆**（后端守「别污染对话记忆」的纪律）
        ⇒ 这一段不会凭空造出事件来。 */
  /**
   * 当前正在对话的角色名（= `settings.yml` 的 `ai_name`，也是 runtime 里 `actors` 的键）。
   * 照抄孤儿页 `WorldSim.vue:1013-1020`：**不新造口径**，否则事件会挂到另一个名字上。
   */
  const currentRoleName = computed(() => {
    const id = currentRoleId.value;
    const r = id
      ? (gameStore.gameRoles as Record<number, { roleName?: string } | undefined>)[id]
      : undefined;
    return String(r?.roleName || "").trim();
  });

  const wsEvents = useWorldEvents({
    role: currentRoleName,
    autoStart: true,
    onFired: (e) => {
      /* ❤️⚡ 期 2：事件带的 `effects` → 一条脉冲（**页面里 0 处算术**，全在 `wsNeeds` 里）。
         ⚠️ 这一句必须放在**通道判断之前**：三个通道（弹窗/气泡/口述）按本仓既有口径只控制
         **展示**，引擎与注入照常（`useWorldEvents` 的 `setChannel` 注释写着）——
         把"记不记后果"挂在展示开关上，会变成"关掉气泡 ⇒ 世界不再有因果"，那是另一套语义。 */
      if (needs.applyEvent(e.event)) needsEpoch.value += 1;
      // 关掉这一路就该安静（气泡那一路由 composable 内部按 `channels.bubble` 自己判）
      if (!wsEvents.channels.value.popup) return;
      wsToast(e.popup || e.event?.title || "", popupKindOf(e.event?.category));
    },
  });
  /* 模板只对**顶层** ref 自动解包 ⇒ 从对象里解出来的必须单独拿（嵌套的不会解）。 */
  const { bubbles: wsEventBubbles } = wsEvents;

  /**
   * 气泡要挂的人：**故意给空名单**。
   *
   * 🔴 为什么不是 `actors.placed`：`WsEventBubble` 的定位数学（`useWorldEvents.bubbleAnchorOf`
   *    → `letterboxOf` + `gridToBox`）算的是**老 `WsDistrict` 那套 28×28 素描格网**在
   *    信箱折算后的盒子像素 —— 那一屏的地图就是这个格网。而本页是 MapLibre **真地理**视图
   *    （人物钉子是 `maplibregl.Marker`：`WsDistrictMapLibre.vue:2594` 的 `setLngLat`，
   *    跟格网像素没有任何关系）⇒ 把 `actors.placed` 传进来，气泡会**飘到错的地方**。
   *    飘着的气泡比没有气泡更糟：它看起来像数据，其实是编的位置。
   *    空名单 ⇒ 走组件自己的兜底分支（屏幕中央浮一个 + 写明是谁，绝不静默丢弃一条已发生的事件）。
   *    给这一屏做**真**锚定（`map.project(lngLat)` 那条路）是新的定位实现，属 UI 线，
   *    不在期 1 的范围（`PLAN-GAMEPLAY.md:54` 的改动面只有"挂上去"）。
   */
  const bubblePlaced: PlacedActor[] = [];
  /** 气泡上那个"是谁"的兜底名字 = 玩家自己（`placed` 里 `isMe` 那一个；拿不到就留空） */
  const meName = computed(() => String(actors.placed.value.find((a) => a.isMe)?.name || "").trim());
  /** 低性能档：气泡入场动画退化成纯淡入（与 `WsSceneView` 读的是同一份 `wsPerf` 单例） */
  const perf = useWsPerf();
  const perfLow = perf.low;

  /* ══ 🌤 期 1 · 天气角标 ══════════════════════════════════════════════════════════
     真源 = `useWorldWeather`（唯一真源，角标/粒子层都读它；拿不到就降级成「天气不可用」，
     **不显示晴天、不留空白**）。城市名取值器照抄孤儿页 `WorldSim.vue:875-883`：
     取 `area` 里最后一段**不是裸 adcode** 的名字（裸 adcode 给 wttr.in 查不到东西）。 */
  const wxCity = computed(() => {
    const parts = String(areaLabel.value || "")
      .split(/[·・>]/)
      .map((x) => x.trim())
      .filter((x) => x && !/^\d+$/.test(x) && x !== "中国");
    return parts.length ? parts[parts.length - 1]! : "";
  });
  const wx = useWorldWeather({ city: () => wxCity.value });
  const { state: wxState } = wx;

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
    /* ❤️⚡ 期 2：对齐下一个整点重算一次基线（一次性 setTimeout 链；卸载时清掉，见 onBeforeUnmount） */
    armNeedsHour();
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

  /* ══ ❤️⚡ 期 2（2026-10-02）·「心情 / 体力真的推上去」（因果通电）───────────────────
     背景（一句话）：Rust 侧 `event_cmd.rs` 一直在读 `actors[role].mood/.energy`（须落在 0–1），
     `events.rs::weight_for` 的 ④⑤ 拿它做权重修正（心情 <0.35 ⇒ 情绪类 ×2.2；体力 <0.30 ⇒
     健康 ×1.6 / 工作学习 ×0.6）—— 但**前端从来没推过这两个键**，所以那两条修正一直没生效。

     本页只做三件事，规矩都写在 `wsNeeds.ts` 头部（那里是唯一真源）：
       ① 把**已经到手的真实输入**（本机时间 / 真实天气 / 事件表的 `effects` / 今日三件事完成数）
          交给 `wsNeeds.compute()` 换成 0–1 —— 它是**推导值**，不是测量值，判词里必须写明；
       ② 事件发生（`onFired`）时把它带的 `effects` 记成一条脉冲 —— **页面里 0 处算术**；
       ③ 把结果随 `pushRuntime` 推上去（只给**当前对话角色**：别人的数值我们没有任何真实输入）。

     🔴 两条刻意的不做：
       · **不挂常驻轮询**：数值只在"输入变了"时重算（事件 / 天气 / 今日三件事 / 整点 / 换角色），
         整点那一下用**一次性 `setTimeout` 对齐下一个整点**（不是 `setInterval`，与 `useWorldEvents`
         的定时链同一口径）；
       · **拿不到就什么都不推**（`needPairOf` 返回 `null` ⇒ patch 里没有 `needs`）——
         Rust 侧读到 `None` = "不知道"，与"0.0 = 很累"是两件事（`events.rs` 文件头写明）。 */
  /* 🔴 角色按**函数**给：换聊天对象时 `currentRoleName` 会变，脉冲与算值必须立刻跟着换一套
     （旧写法把角色定死在薄壳创建那一刻 ⇒ 换人后会把上一个角色的脉冲算到新角色头上）。 */
  const needs = useWsNeeds({ role: () => currentRoleName.value });
  /** 事件脉冲变了 ⇒ 手动通知重算（`wsNeeds` 与 `wsRelation` 一样**不 import vue**，不是响应式的） */
  const needsEpoch = ref(0);
  /** 当前钟点（整点对齐那一下要重算基线；`null` = 时钟读不出来 ⇒ 判"数不出来"） */
  const needsHour = ref(localHourOf(Date.now()));
  let needsHourTimer = 0;

  /** 对齐**下一个整点**再算一次（一次性定时器；组件卸载时清掉） */
  function armNeedsHour(): void {
    const now = Date.now();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    const at = next.getTime() + 3600_000; // 下一个整点
    needsHourTimer = window.setTimeout(() => {
      needsHour.value = localHourOf(Date.now());
      armNeedsHour();
    }, Math.max(1000, at - now));
  }

  /**
   * 这一屏的读数（**推导值**）：输入全部来自别处的真源，本页一个数都不编。
   * `dailyTasks` 还没排出来 ⇒ `null`（"数不出来"，不是 0 件）。
   */
  const needsResult = computed(() => {
    void needsEpoch.value; // 显式依赖（见 needsEpoch 的注释）
    void needsHour.value;
    const tasks = dailyTasks.value || [];
    return needs.compute({
      weather: wxState.value,
      dailyDone: tasks.length ? tasks.filter((t) => t.done).length : null,
    });
  });
  /** 能推给 Rust 的那两个数；`null` = 这一轮不推（**绝不用 0.5 顶替**） */
  const needsPair = computed(() => needPairOf(needsResult.value));
  /** 推之前先归一：只给**当前对话角色**（键 = display_name，与 `actors` 同一套） */
  const needsForPush = computed<Record<string, { mood?: number; energy?: number }> | undefined>(() => {
    const role = currentRoleName.value;
    const pair = needsPair.value;
    if (!role || !pair) return undefined;
    return { [role]: pair };
  });
  /** 参与 watch 判据的签名（数值没变就不重推 —— 后端 `changed` 也就不用背包袱） */
  const needsSig = computed(() => {
    const p = needsPair.value;
    return p ? `${currentRoleName.value}:${p.mood}|${p.energy}` : "none";
  });

  /** 面板那一格：**只有面板对着的正是当前对话角色**时才有值（别人的数值没有来源） */
  const panelNeeds = computed(() =>
    currentActor.value && currentActor.value.name === currentRoleName.value ? needsPair.value : null
  );
  const panelNeedsNote = computed(() => {
    if (!currentActor.value) return "";
    const shown = currentActor.value.name;
    const who = currentRoleName.value;
    if (shown !== who) {
      /* ⚠️ 这行会经 `{{ needsNote }}` **原样上屏**（不是 Markdown 渲染器）⇒ 不许写 `**` 之类的记号。
         🔴 2026-10-03 机主真机验收时撞在这里：他看到"别人的没有来源"以为坏了。文案按他要求改成
         **说清"这是谁的数、为什么没有"**，并且把"浏览器预览根本没有角色数据"这条也直说 ——
         预览里 `init_game`/`get_game_info` 都被 web-mock 挡成空值，`gameRoles` 没人填
         ⇒ `currentRoleName` 恒为空串，这一格在预览里**永远出不了数**（真机才有）。 */
      if (!who) {
        return "数不出来：这一格算的是「正在跟你对话的那个人」的心情/体力，而现在没有这个角色 —— 浏览器预览没有角色数据（真机上才有数）。";
      }
      return `数不出来：这一格算的是「${who}」的心情/体力，不是「${shown}」的 —— 要让它有数，先在聊天里选 ta，再点开这一格。`;
    }
    return needsResult.value.why;
  });

  /* ── 🔌 把场景推给 Rust（`MapRuntime.scene`）────────────────────────────────────
     **为什么必须推**（真源 = `wsRuntimePush.ts` 头部注释，这里只复述结论）：
       · `scene` 在不在 = `world_sim_enabled()`（`src-tauri/src/world_map/state.rs:618`）的**唯一判据**；
       · 它 false 时：`producer.rs:63` 的位置指令剥离器**不启用**（AI 回话里的 `⟦wm:…⟧` 会漏进正文），
         且 `role_manager.rs:360` 的 `injection_for()` 返回空 ⇒ **角色不知道自己在哪**；
       · 老入口 `WorldSim.vue:1132` 一直在推，但 `/worldsim` 现在指向**本组件** ⇒ 这两件事**全关了**。
     推什么：`area`（本屏就是"在用哪座城市"）+ 地图上的人（键必须是角色的 display_name，见契约 ①）
             + 期 2 的 `needs`（当前角色的 mood/energy，见上面那一段）。
     ⚠️ **退出必须推 `{scene:null}`**（`clearRuntime()`）—— 不清的话 AI 会一直带着上次的地图上下文说话。 */
  watch(
    () => [
      areaLabel.value,
      districtPins.value.map((p) => p.id + ":" + (p.posSource || "")).join(","),
      needsSig.value,
    ] as const,
    () => {
      void pushRuntime({
        area: areaLabel.value || undefined,
        actors: actors.placed.value || [],
        needs: needsForPush.value,
      });
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    /* 🏠 三件事的有界重试也要收掉（否则组件卸载后还会有最多 10s 的空转定时器） */
    if (dailyTimer) {
      window.clearTimeout(dailyTimer);
      dailyTimer = 0;
    }
    /* ❤️⚡ 期 2：整点对齐那一下也要收掉（不留下"离开这一屏还在排下一发"的定时器） */
    if (needsHourTimer) {
      window.clearTimeout(needsHourTimer);
      needsHourTimer = 0;
    }
    /* 💬 期 1：离开这一屏就停掉事件引擎（tick 轮询 + 广播订阅 + drain 定时器）。
       下面 `clearRuntime()` 会把 `scene` 推成 null ⇒ 就算没停，后端 tick 也只会返回 `no_scene`；
       但两条都做才是"这一屏走了，它的事就该停"（与孤儿页 `WorldSim.vue:1633` 同款）。 */
    wsEvents.stop();
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

  /* 🔴 **整屏地图上禁毛玻璃**（红线 R1 的同一口径，见 `assets/styles/worldsim.css:198-201`）：
     `backdrop-filter` 的值只要**不是 `none`**，浏览器就给这个元素建一层 backdrop 层、
     **每一帧把底下的像素读回来重合成一次**（`blur(0px)` 也算）。这一屏底下是**每帧都在重画的
     WebGL 地图画布**，所以卡片/遮罩上的每一层毛玻璃都是纯亏。
     皮肤（刚 import 的那份）里 `--ws-blur` 是 `0px`（薄荷）/ `10px`（玻璃）⇒ 直接挂上会**新开**一批
     `blur(0px)` 的 backdrop 层；这里把两个令牌都置 `none`：`blur(none)` 在计算值阶段非法 ⇒ 退回 `none`
     ⇒ 一处关掉这一屏里**所有** `blur(var(--ws-blur*))`。
     全屏遮罩那份兜底 1px（`WsCharPanel.vue` 的 `.ws-drawer__mask`）另有显式 `none` ——
     它就是机主 2026-10-01「点了角色直接卡死」的现场（窄屏实测 rAF 最差 1025ms）。 */
  .wsce.ws-root {
    --ws-blur: none;
    --ws-blur-low: none;
  }

  /* 🌤 期 1：**天气角标自带一层毛玻璃**（`worldsim-weather.css:47-48` 写死 `blur(6px)`），
     而它不是走 `--ws-blur` 令牌的 ⇒ 上面那两行令牌压不住它。这一屏底下是每帧重画的 WebGL 画布，
     值只要不是 `none` 就每帧读回像素 ⇒ 在本页**就地把它改成 `none`**。
     ⚠️ 不改那个共享样式文件：它还有别的读法（角标/粒子层共用一份），改它等于替所有人做决定；
     这里是"这一屏不用毛玻璃"的局部决定（口径与上面那条 R1 一致）。 */
  .wsce :deep(.ws-wxtag) {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    /* 顶栏那一排按钮在 `top:0`（44px 高）⇒ 角标默认的 `top:.7em` 会压在「🗺 城市数据」上 */
    top: 52px;
  }

  /* 💬 期 1：事件气泡的位置由组件自己算（`position:absolute`），这里只保证它**不吃地图手势**：
     整层已经是 `pointer-events:none`（组件内），气泡本体 `pointer-events:auto` —— 与老宿主一致。 */
  .wsce :deep(.ws-ebx) {
    z-index: 8; /* 压在地图与交通 HUD（6）之上、顶栏（30）之下：它是"刚发生的事"，该被看见 */
  }

  /* 📱 角色面板开着时，把**悬浮手机的按钮**让开（机主：「UI互相挤压」）。
     手机的 z-index 是 `--z-ws-phone:60`，比抽屉的 30 高 ⇒ 那个 52×52 的 📱 会压在面板内容上
     （截图里它正好盖在"快捷动作/送礼物"那一行的右下角）。
     ⚠️ 只藏**按钮**、不卸载 `WsPhone`：送礼的 toast 渲染处跟手机共用 `phone` 开关
     （`WsSceneView` 里 `<WsToasts v-if="phone" />`），把它卸了，"好感 +6"那条反馈就看不见了。 */
  .wsce--panel :deep(.wsphone-fab) {
    opacity: 0;
    pointer-events: none;
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
  /* 🏙 2026-10-03 · 顶栏第三颗（楼房档位开关）。
     它是**常驻**的第三件，窄屏上必须先让位：`flex: 0 1 auto` + `min-width: 0` + 省略号，
     否则「🏏 世界模拟 重庆」那一串会被挤到换行/溢出（顶栏只有一行，绝不换行）。
     ⚠️ 只放宽**宽度**：高度仍由 `.wsce__btn` 的 `min-height: 44px` 撑着（触控目标不许缩水）。 */
  .wsce__btn--bld {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-color: rgba(255, 207, 138, 0.42);
    color: #ffcf8a;
  }
</style>
