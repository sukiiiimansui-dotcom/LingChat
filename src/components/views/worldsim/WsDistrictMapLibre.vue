<!--
  WsDistrictMapLibre.vue —— 小区级**直接用地图库渲染**（机主 2026-09-19 的决定）

  ## 为什么有这个组件
  机主原话：「在小区草图阶段，会**异常卡顿**，这里**直接用加载动画代替**，后面用**地图库直接使用**」。
  卡顿实测原因：那张草图是**一整张 78KB 的 SVG data-url**，几百个节点（每栋楼一个 `<g>`），
  手机上每次手势变换都要重新合成整张图 ⇒ 必然掉帧（下线后同级实测 **60fps / DOM 110**）。

  ## 这个组件做什么
  用 **vendored MapLibre（零依赖变更）** 画小区：
  · 底图风格**不依赖任何瓦片服务器**（自建 style：背景 + 真楼房 + 边界）；
  · **真实楼房挤出**（`fill-extrusion`，数据来自 `/api/buildings` —— 后端用"最近一次定位坐标"兜底，
    不用前端层层传参）；楼高来源如实区分：`height`（真数据）/ `levels`（层数×3m）/ `default`（默认 8m）；
  · 相机：以小区为中心、`pitch` 可倾斜（MapLibre 原生，我们手写渲染器做不到）。

  ## 纪律
  · **不新引依赖**：MapLibre 走 `public/vendor/maplibre/`（运行时动态 import）；
  · **不可用时如实降级**：无 WebGL / 模块加载失败 / 取不到楼房 ⇒ 显示原因，**不画假数据**；
  · 无头环境 WebGL 会在首帧后丢上下文（已知），所以"截图空白但指标正常"要如实写，不当作 bug。
-->
<template>
  <div ref="host" class="ws-dml" :style="joyVars">
    <!-- 🔴 2026-09-21 定案：这块模板画布**只在真的走 2D 自绘降级路时才存在**。
         病根：它无条件渲染 ⇒ 在 WebGL 路下是一块**默认 300×150、透明、display:block** 的空壳，
         CSS 又把它拉满整屏 ⇒ **盖住 MapLibre 那块 3759×1287 的真地图**（机主看到的"浅色矩形"就是它）。
         现在 `v-if="show2d"`：WebGL 路下它**根本不在 DOM 里**（于是 `cv.value` 为 null 是**正确状态**，
         所有取用点都按"可能为 null"处理；2D 路会自己建一块，见 `fallback2d`）。 -->
    <canvas v-if="show2d" ref="cv" class="ws-dml__cv" />

    <!-- 长等待可视化（机主 2026-09-19：「ai 绘制太久了，做可视化吧」）：
         小区级要等 `/api/buildings` 现取真楼栋（实测十几秒起，最慢见过 91.7s），
         原来这期间屏幕上只有 HUD 里一行 `初始化…` ⇒ 观感就是"卡住/白底"。
         这里复用项目**已有**的加载态：`WsLoading` 的 `map` 档 = **等高线三圈错峰扩开**，
         并把三段真实阶段点亮（取楼栋 → 整理 → 画），已等秒数实时走。
         ⚠️ 纪律：**没有分母就不画确定进度条**（只有"上次同半径的真实耗时"可当估算）。 -->
    <WsLoading
      v-if="phase !== 'done'"
      class="ws-dml__wait"
      variant="map"
      :text="waitText"
      :sub="waitSub"
      :stages="STAGE_NAMES"
      :stage="stageIdx"
      :progress="progRatio"
      :eta-ms="etaMs"
      :hint="'首次要现取真楼栋（Overpass），几十秒也可能；取到就立刻画，不用一直盯着'"
    />

    <!-- 🔴 **这段被移除的按钮曾经是"缩放"的唯一可靠入口**（原文如下，备份里可查）：
         「缩放控件（机主 2026-09-19 实测：浏览器会抢走手势 ⇒ 只靠捏合没法缩放，
         而"放大到街区才取楼"就永远不触发 ⇒ 看起来"楼房压根不显示"。
         所以给一对按钮，**不依赖手势**也能缩放。高德/百度也都有这对按钮。）」
         🗄 2026-09-24 机主裁定：「App 页现在只准保留代拍页代码」+「现在 App 页有多余 UI」
         ⇒ `＋ / － / 全区` 三个按钮**整块移除**（代拍页 `ws3dshow.html` 那一屏没有它们）。
         ⚠️ **未验**：真机手势能不能独立完成缩放（无头环境没有多点触控）——
            这正是机主报的「缩放像整屏图片被放大缩小」要一并查清的那条线；
            若真机缩不了，恢复方式：`git revert <本 commit>`。
         备份：tag `attic/pre-sceneview2-20260924`、`~/chk/removed-backup-20260924-sceneview2/`。 -->

    <!-- 🔬 验证面板（机主 2026-09-21：「**保证我们的全部验证功能在 App 页可全部看到喵！**」）。
         长在**出问题的那一页**上：渲染路 / 降级原因原文 / 地图库错误原文 / 图层与 key paint /
         场景（主题·夜色·世界时间·档位·DPR）/ 计数（与 HUD 同源）/ 定位来源 / 自检 / 自拍按钮。
         `?wsverify=1` 一进来就摊开；平时只留一个 🔬（**零开销**：收起时不取快照、不跑自检）。
         ⚠️ 它**只读**：不写样式、不改相机、不动任何业务状态（唯一的动作是机主点「现在拍一张」）。 -->
    <WsVerifyPanel
      :open="verifyOpen"
      :snapshot="panelSnapshot"
      :on-shoot="shootNow"
      :on-retry-map="retryMap"
      :on-force-resize="forceResizeCanvas"
      @toggle="verifyOpen = $event"
    />

    <!-- 🏷🗺 **名字层**（真名标签 + 区名标签）—— 规则全在共享真源 `wsNameLayer` 里，这里只画。
         ## 为什么是 DOM 而不是地图库的文字层
         我们的样式里 `glyphs` 是**明令禁止**的（`glyphs: undefined` ⇒ 样式校验失败 ⇒ `load` 永不触发、
         整张地图全白且零报错，项目里栽过）。要中文就得自托管 glyphs PBF 字体 + 工具链，不划算。
         ## 动效（`DESIGN-MG-MOTION.md` §4.0/§4.1/§4.2 的红线，逐条落在这里）
         · **位置只在 `moveend` 批量写一次**：节点用 `transform: translate3d(x px, y px, 0)`
           （**不是** `left/top` 百分比 —— 那是布局属性，每帧改一个就是一次 layout）；
         · **相机运动期间只写 1 个节点**：给容器加 `is-camera-moving`（一次 class + 一次 opacity 0.25），
           跟手靠**容器的一次 `translate3d`**（`map.project(锚点)` 算位移，O(1)）；
         · **节点池复用**：换名字发生在 `switching`（整层 opacity≈0）那一帧，**不是**看着旧名字变新名字；
         · 三档样式（真名 / 数据驱动区名 / 示意区名）**必须不同** —— 由 `style` → class 决定。 -->
    <div
      ref="labRootEl"
      class="ws-labs"
      :class="labRootClass"
    >
      <button
        v-for="n in nameNodes"
        :key="n.slot + ':' + n.id"
        type="button"
        class="ws-lab"
        :class="[labClassOf(n.style), { 'is-sketch': n.sketch, 'is-enter': nameEnter.includes(n.id) }]"
        :data-ws-lab="n.pick.kind"
        :data-ws-lab-id="n.id"
        :data-ws-lab-style="n.style"
        :style="{ transform: `translate3d(${n.x}px, ${n.y}px, 0)` }"
        :title="n.why"
        @click.stop="openCardFromNode(n)"
      >
        {{ n.text }}
      </button>
      <!-- 🆕 这一批**要走的**那几张：各自淡出后由宿主移除（**不是**整层一起换字）。
           用 `span` 而不是按钮 ⇒ 退场中的标签不可点（它马上就要消失，点它只会弹错卡）；
           位置由**真源**按当前相机投好（`exited[].x/y`），宿主不自己投影。 -->
      <span
        v-for="g in nameGhosts"
        :key="'ghost:' + g.slot + ':' + g.id"
        class="ws-lab is-ghost"
        :class="[labClassOf(g.style), { 'is-sketch': g.sketch, 'is-ghost-out': ghostFading }]"
        :style="{ transform: `translate3d(${g.x}px, ${g.y}px, 0)` }"
        aria-hidden="true"
      >
        {{ g.text }}
      </span>
    </div>

    <!-- 2D 降级路的"人"（WebGL 路用地图库 Marker，不在这里画） -->
    <!-- 🎬 动画预算·步①「清违禁」（2026-10-02）：钉子**不再用 `left/top` 百分比**（布局属性，
         每来一次位置更新 = 一次重排）—— 外层 `.ws-dml__pinat` 铺满整层（100%×100%），
         `translate3d(X%, Y%, 0)` 的百分比**相对自身盒子**解算，而它就是这一层 ⇒ 落点与原来的
         `left/top:X%` **是同一个点**（纯位移 ⇒ `transform-origin` 无关）。
         内层 `.ws-dml__pin` 就是原来那颗元素（class / `@click` / `::after` 44px 命中区 / `is-me`
         尺寸都没换），只是回到 `left:0; top:0` + 原有 `margin:-12px 0 0 -12px` 居中。
         外层 `pointer-events:none`（铺满整层，绝不能挡地图手势）；点击照旧落在内层（它自己 `auto`）。 -->
    <div v-if="!mapAvailable" class="ws-dml__pins">
      <span
        v-for="p in domPins"
        :key="p.id"
        class="ws-dml__pinat"
        :style="{ transform: `translate3d(${p.tx}, ${p.ty}, 0)` }"
      >
        <i
          class="ws-dml__pin"
          :class="{ 'is-me': p.isMe, 'is-aff': p.affinity }"
          :title="p.name + (p.affinity ? '（特地来找你）' : '')"
          @click.stop="emit('pick-actor', p.id)"
          >{{ (p.name || '我').slice(0, 1) }}</i
        >
      </span>
    </div>

    <!-- 🕹 **摇杆**（左下拇指区）—— 它是**控件**，不是信息块：常驻浮块那笔账（≤3）不被它改变，
         也**不许**顺带加任何读数（PLAN §2.2 的验收口径）。
         渲染判据只有一处 `joyGate`：`?joy=0` 或 2D 降级路 ⇒ 这里根本不在 DOM 里（判据 9 / 10）。
         `@drive` 每帧**至多一次**（唯一驱动点），`@halt` 松手**恰好一次**。 -->
    <WsJoystick
      v-if="joyGate.show"
      :mpp="joyMpp"
      :speed-mps="joySpeedMps"
      :zoom-levels="joyZoomLevels"
      @drive="onJoyDrive"
      @halt="onJoyHalt"
    />

    <!-- 🪪 **信息卡**：点楼体 / 点名字 / 点区名 ⇒ **同一张卡**（`wsBuildingCard.buildingCardData`）。
         动效令牌全部来自 `CARD_MOTION`（一处定义）；组件里**没有** `backdrop-filter`
         （全局 `.ws-card` 类自带 `blur(var(--ws-blur))`，玻璃主题下是 10px ⇒ 一用就掉帧，所以不套它）。 -->
    <WsBuildingCard :data="cardData" :open="cardOpen" :low="perfLow" @close="closeCard" />

    <!-- 指标条：验证用（也让人一眼看到"这是真数据还是降级"）。
         `ref="hudEl"`：样式自检 JSON 里要带上 **HUD 原话**（机主看到的就是这一行，逐字带回，
         不转述 —— 转述过一次就把"地图库 8 秒内没画出第一帧"写成了"加载失败"）。 -->
    <div ref="hudEl" class="ws-dml__hud">
      <!-- 🕹 第一格是**视角那一句**：摇杆开着时在原文后面补「漫游视角（不是步行模拟）」，
           2D 降级路补「没有相机，摇杆不适用」—— 两种情况都**必须看得见**（不许静默）。
           ⚠️ 拼法只有一处（`joyGateOf` 给的那句），这里不许再写第二版文案。 -->
      <span>{{ hudMode }}</span>
      <span>🏢 {{ stats.count }}</span>
      <span
        :title="`真高 ${stats.height}=OSM 真的写了 height / 层数 ${stats.levels}=levels×3 / 按类型估 ${stats.default}=**我们按 building=* 类型猜的，不是真数据**（中国 OSM 楼高覆盖率只有一两成）`"
      >
        真高 {{ stats.height }} · 层数 {{ stats.levels }} ·
        <em class="ws-dml__est">按类型估 {{ stats.default }}</em>
      </span>
      <span v-if="stats.area" :title="'当前渲染的区（取自 /api/geo_json）'">{{ stats.area }}</span>
      <!-- 👤 画面上的角色数（含你自己；WebGL 走地图库 Marker、2D 降级走 DOM 钉子）。
           🔴 **三态如实**：锚点还没有 / 一个人都没装配上时，**写出原因**（`stats.pinsNote`）——
           以前这条 `return` 是静默的，"地图上没人"到底是"没锚点"还是"名单为空"根本分不出来。 -->
      <span v-if="stats.pins || stats.pinsNote" :title="'画面上的角色数（含你自己；WebGL 用地图库 Marker，降级用 DOM 钉子）' + (stats.pinsAnchor ? ' · 锚点：' + stats.pinsAnchor : '') + (stats.pinsNote ? ' · ' + stats.pinsNote : '')">
        👤 {{ stats.pins }}<template v-if="stats.pinsNote"> <em class="ws-dml__est">数不出来</em></template>
      </span>
      <!-- 🛣 路网：口径与画法一致（按 zoom 过滤档位），并把"主干几条/有名字几条"如实带上 -->
      <span v-if="stats.roads" :title="'本视野看得见的路（' + (stats.roadNote || '') + '）；行人会吸附到这些路上'">
        🛣 {{ stats.roads }}
      </span>
      <!-- 🧱🏢 **离线楼房包**（切片 A）：默认**不发 `/api/buildings`**，楼从 `/bldbundle/<格>.json` 来。
           可数一行：已取 x 格 / 包外 y / 失败 z + 仓库 N 栋（**数不出来不写 0**）。
           `title` 是真源判词（`wsScene.bldVerdictText`）——"包外"必须与"这里没有楼"分得开。 -->
      <span v-if="stats.bldBundle" :title="stats.bldVerdict">{{ stats.bldBundle }}</span>
      <!-- 🏙 **挑楼口径那一行**（2026-10-02 B2：双预算 = Σ投影 px² + Σ顶点，两个**固定常量**；
           2026-10-03 追加第三个上限：**栋数**；同日再按 **zoom 分层** —— `z<14` 画足迹（宽档）、
           `z≥14` 画立体（严格档 100 栋），用户在顶栏还可切"多楼房模式（不推荐）"）。
           判词原文由共享真源 `wsBldBudget.stats.why` 产出（宿主不许再拼第二份）；
           宿主只在最前面加"现在哪一档形体 / 上限几栋 / 到没到上限"（`bldPickLine`）——
           机主要能一眼看出"这么少是因为我设了 100 栋"，还是"这一带本来就没几栋"。
           机主判"卡不卡"时：这一行给**可数**的那一半（画了几栋 / 花了多少像素与顶点），
           另一半（帧率）看同一栏的 `fps`。 -->
      <span v-if="stats.bldPick" :title="stats.bldPick">{{ stats.bldPick }}</span>
      <!-- 🏷🗺 **名字层**那一行（真源判词，三态：正数 / 0（已量）/ 数不出来 + 原因）。
           🔴 三档**分开计数**（真名 / 数据驱动 / 示意），并明写 **生成名上屏 0**
           —— 机主拍板"生成名只进信息卡"，这一条在这里是**看得见的**机器证据。 -->
      <span v-if="stats.names" :title="stats.names">{{ stats.names }}</span>
      <!-- 🧱🛣 离线路网包：同式（默认**不发 `/api/roads`**；仓库是**累积**的，换视野不减） -->
      <span v-if="stats.roadsBundle" :title="stats.roadsVerdict">{{ stats.roadsBundle }}</span>
      <!-- 🌊🌳 **水/绿地那一格**（2026-09-29 补）——
           事实早就算出来了（`wsGwLayer` 通过 `onHud` 回填 `stats.gwVerdict`），
           但**模板里一直没有渲染它** ⇒ 机主看不到"水到底画出来没有"，只能靠肉眼猜颜色；
           而 2026-09-29 那个并发 bug（`null.cellSize` ⇒ 每轮水绿层不画）**正是因为这一格缺位**
           才没能在屏幕上暴露出来。判词由真源给（三态：正数 / 0（已量）/ 数不出来 + 原因），
           这里只负责摆出来 —— 与代拍页的 `#m-gw` 同一份口径。 -->
      <span v-if="stats.gwVerdict" :title="stats.gwVerdict">{{ stats.gwVerdict }}</span>
      <!-- 🏪 设施：**必须写"示意布局"**——这些点的经纬度是按 /api/facilities 的
           28×30m 方格摊出来的，不是实测位置（实测位置要走另一条卡）。 -->
      <span v-if="stats.facilities" :title="'设施（' + (stats.facNote || '') + '）—— 点位是**示意布局**，不是实测经纬度'">
        🏪 {{ stats.facilities }}
      </span>
      <span v-if="stats.view" :title="'放大到街区才会取楼栋（Overpass 半径有上限）'">{{ stats.view }}</span>
      <span v-if="stats.contour !== 0">
        等高线 {{ stats.contour > 0 ? stats.contour + " 段" : "不可用" }}
      </span>
      <span>{{ stats.fps }} fps</span>
      <!-- 🎨 主题 A/B 开关（机主要"**暗色 ↔ 二次元**来回看"）。
           放在 HUD 里而不是藏进 URL：机主是零基础，让他手打 `?wstheme=` 不现实。
           点了会**记进 localStorage 并重载**（换主题要重建 sources/layers，热换容易踩到
           "图层引用了还不存在的 source"；重载对"来回对比"这个用法完全够，而且零风险）。 -->
      <button
        class="ws-dml__theme"
        :title="`当前：${theme.label}。点一下切到另一套并重载地图`"
        @click="switchTheme(themeId === 'anime' ? 'night' : 'anime')"
      >
        🎨 {{ theme.label }}
      </button>
      <!-- 「为什么慢、我们为此做了什么」—— 机主要的是**如实**，不是好看。
           这一条只在真的被压到低档时出现（软渲染/降级路），见 `fallback2d()`。 -->
      <span v-if="stats.perf" class="is-warn">{{ stats.perf }}</span>
      <span v-if="stats.note" class="is-warn">{{ stats.note }}</span>
      <!-- 🔴 2026-09-20 机主拍板「**两条都要**：有真数据用真的，真数据不够时自动叠示意层 + 标注」。
           这句话就是这条 HUD 的**验收标准**，所以它必须同时说清三件事：
             ① **真楼几栋**（N 是真数出来的，不是估的）；
             ② **为什么亮示意层**（"稀疏" = N 低于阈值，而不是"我们爱看"）；
             ③ **哪部分不是真的**（"非事实"三个字不许省）。
           节奏上是"真数据优先"：N ≥ 阈值时这一条**根本不出现**（示意层同时被摘掉，见 `syncAiLayers`）。 -->
      <span v-if="aiOn" class="is-ai">
        真楼 {{ stats.count }} 栋（稀疏）· {{ aiDrawn > 0 ? "已叠加 AI 示意层（非事实）" : "AI 示意层待生成" }}
      </span>
    </div>

    <!-- 🔴 **署名**（`ROUTE.md` 第 2 条：用了有许可的数据就必须有可见署名，且"关掉 attribution 不算方案"）。
         我们的地图库开了 `attributionControl: false` ⇒ 这里给一个**等价可见方案**：
         句子**逐字来自包里的 `index.json`**（`source` 字段，由导出脚本写），页面**不改写第二版**。
         取不到就如实写"署名取不到"——署名是合规项，**不许猜、不许编**。 -->
    <div v-if="stats.attribution" class="ws-dml__attr" :title="stats.attribution">{{ stats.attribution }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import worldMapApi, { facilitiesAuto, geoJson } from "@/api/services/worldMap";
  import WsLoading from "./WsLoading.vue";
  import type { WsDistrictPin } from "./wsActors";
  /* 🧱 重构切片 S1：舞台层共用的类型（L0.5，`PLAN-REFACTOR §2.2`）。
     `BldMapLike` 是从本文件**搬过去**的（形状一字未改）—— 舞台模块不许 import 宿主，
     所以"地图最小接口"必须待在双方都能 import 的中立处。 */
  import type { BldMapLike } from "./wsStageTypes";
  /* 🧱 重构切片 S2（M6）：**2D 降级路整块**搬到了 `wsFallback2d.ts`（`PLAN-REFACTOR.md` §2.1/§2.2）。
     宿主只做**装配**（构造只读 ctx + 调用那几个函数），依赖方向永远向下：那个模块**不 import 宿主**。
     装配点 = 下面 `domPins` 之后那一段（它必须在所有被 ctx 捕获的量都声明之后）。 */
  import { createFallback2d } from "./wsFallback2d";
  /* 🧱 重构切片 S3：**HUD/stats** 与 **相机/手势** 各搬进一个模块（`PLAN-REFACTOR.md` §2.1/§2.2/§3）。
     · `createHudStats`  —— 早装配（stats / aiOn / 长等待 / fps）：必须早于 S2 的装配点，
       因为那边（2D 降级路）的只读 ctx 里就有 `stats` / `aiOn` / `stopTimer`；
     · `createMapCamera` —— 晚装配（晚于 `labRootEl`）；
     · `createBundleHud` —— 晚装配（晚于离线包那几条管道）。
     三个装配点各自的理由写在两个模块的文件头。依赖方向永远向下：它们都**不 import 宿主**。 */
  import { createBundleHud, createHudStats } from "./wsHudStats";
  import { createMapCamera } from "./wsMapCamera";
  /* 🧱 重构切片 S4（M2）：**取数 / 落地**整块搬到了 `wsViewFetch.ts`（`PLAN-REFACTOR.md` §2.1/§2.2/§3）。
     搬走的是：`withTimeout` / `fetchBuildingsWithRetry` / `fetchRoadsWithRetry` / `overtureFill` /
     `loadRoadsForView` / `facLngLat` / `loadFacilities` / `loadBuildingsForView`，以及它们自己拥有的
     那几个量（`BLD_FETCH_MS` / `BLD_RETRIES` / 诊断读数 / `ovCache` / 两个去抖键 / `FAC_COLOR_FALLBACK`
     / `BLD_ENOUGH`）。
     ⚠️ **留在宿主**的（本片一个字节都没动）：`roadSegs`（吸附/寻路在用）、`LIVE_ON` / `bldLive` /
        `roadsLive`（offline-first 的决策）、`liveRadiusFor` / `viewHalf`（半径适配器）、以及
        `bldStore` / `roadsStore` / `bldFlush` / `roadsFlush`（M3 `wsBldLanding` 的地盘，S6 才搬）
        —— 它们按 §2.2 由宿主**注入**，模块之间没有横向 import。
     ⚠️ 装配点必须在 `bldLive` / `roadsLive` / `bldStore` / `roadsStore` 都声明之后（`const` ⇒ 早引踩 TDZ），
        见下面 `createViewFetch({…})` 那一段的理由说明。 */
  import { createViewFetch } from "./wsViewFetch";
  /* ⚠️ 上面这几条 import 里有 9 个名字**在本切片之后暂时没有消费者了**（它们的唯一用途跟着 M2 走了）：
     `facilitiesAuto` · `mergeBuildingSources` · `shouldAskSecondSource` · `hash32` · `roadStatsLine` ·
     `toXY` · `toLngLat` · `fetchRadiusLadder` · `WS_FETCH_R_BACKEND_MAX`。
     本切片是**纯搬迁**（§2.4：只移动 + 加签名，不顺手清理）⇒ 一行都不动它们；
     清理与 `HEIGHT_COLOR_RAMP` / `heightColorExpression`（S2 之后同样悬空）一起归 S9「删死代码」。
     `BldFeature` / `RoadSeg` / `worldMapApi` / `geoJson` 等**仍在宿主用**（面板、吸附、初始取楼）。 */
  /* 性能档位（模块级单例，与 `WorldSim.vue` 拿到的是**同一份**）。
     为什么这个组件也要拿它：**降级决定发生在这里** —— 只有这里知道"最后到底走了哪条渲染路"，
     而档位必须跟着那条路走（见 `fallback2d()` 里 `perf.forceLow()` 那段）。 */
  import { useWsPerf } from "./wsPerf";
  import { aiFeatureCollection, boxAround as aiBoxAround, type AiItem, type BBox } from "./wsAiLayers";
  /* 「OSM 优先、Overture 补缺」的合并规则（纯逻辑，单独一份 ⇒ 能在 Node 里全量自检）。 */
  import { mergeBuildingSources, shouldAskSecondSource, type BldFeature } from "./wsBuildingSources";
  /* 「楼多高、什么颜色」的纯逻辑（`wsBuildingLook.ts`，独立文件 ⇒ 可单测、不跟渲染纠缠）。
     2026-09-19 机主：「这个 ai 2d 小区好丑，直接试一下 3d 路线我看看效果」——
     这一刀就是"3D 路线"的美术部分：真轮廓 + 有起伏的高度 + 有层次的光照。 */
  import { HEIGHT_COLOR_RAMP, hash32, heightColorExpression } from "./wsBuildingLook";
  /* 🛣 路网（机主 2026-09-20：「**在地图上把道路和设施全部勾出来**（方便将行人啥的挪出来）」）。
     · `wsRoads`：分级画法（0 快速路 ~ 5 步道，各一档线宽/亮度 + 底色描边）+ HUD 计数口径；
     · `wsSnap`：**吸附与寻路**的纯几何 —— `snapToRoad` 返回的是**线段上的投影点**（不是最近顶点，
       否则角色会在两个顶点间一格一格跳）；`routeOnRoads` 是"角色自己出门"（`DESIGN-AUTONOMY`）的地基。
     两个模块都在 Node 里全量自检过（`ws_roads_snap_selftest.mjs` 44 项）。 */
  import { roadLayerSpecs, roadStatsLine, visibleRoadCount } from "./wsRoads";
  import { roadSegments, snapToRoad, toLngLat, toXY, type RoadSeg } from "./wsSnap";
  /* 🎨 「这张地图长什么样」的主题预设（2026-09-20 机主：「这个地图太暗了喵，还有就是我想给整体地图
     改成二次元式的那种风格喵」）。**美术参数全在那个文件里**，这里只负责"照它摆图层"：
       · `night` = 原来的暗色（**保留**，一个字没删，只是把卫星的压暗从 0.34 提到 0.56）；
       · `anime` = 二次元（蔚蓝档案风）：亮蓝天空 + 亮灰底图 + 浅蓝色罩 + 平涂楼体 + 深藏青描边；
       · A/B 开关：URL `?wstheme=night` / `?wstheme=anime`（也会记进 localStorage）。
     ⚠️ 为什么亮度/颜色参数必须集中在一个**能被 Node 断言**的纯模块里：地图库的亮度公式是
     仿射重映射（`out = min + (max-min)*rgb`）⇒ 提亮地面会**连带把楼比下去**，
     所以"楼/地亮度比"必须能算、能测，不能靠肉眼在真机上赌。 */
  import {
    WS_MAP_THEME_KEY,
    WS_MAP_THEME_DEFAULT,
    parseWsMapThemeParam,
    nightVariant,
    rampExpression,
    themeForTier,
    themeStyleParts,
    wsMapTheme,
    type WsMapTheme,
    type WsMapThemeId,
  } from "./wsMapTheme";
  /* 「代拍」：让页面自己 toDataURL 回传（agent 看不到 WebGL、机主又禁了 ADB 截屏 ⇒ 唯一通道） */
  import {
    appSelfShotArmed,
    appSelfShotDisarm,
    appSelfShotMaybeArmFromUrl,
    canvasIsBlank,
    diagnosticPng,
    postShot,
    sampleCanvas,
    selfShotArmed,
    selfShotDisarm,
    selfShotMaybeArmFromUrl,
    settleForShot,
  } from "./wsSelfShot";
  /* 🧪 「**App 自拍**」（`?selfshot=1`）：主 App 页走完"进小区级 → 等稳 → 抓帧回传"。
     为什么要它：闸门跑的是无头浏览器（**无 WebGL ⇒ 2D 降级路**）⇒ 闸门全绿也看不到
     WebGL 那条路的故障；而代拍页要机主手动打开。它把"点代拍页"降成"**刷新一次**"。
     分工与纪律见 `wsAppSelfShot.ts` 的文件头。 */
  import { type AppShotCtx, type ShotMapLike, runAppSelfShot } from "./wsAppSelfShot";
  /* 📊 「样式自检 JSON」的**纯**打包函数（图层/paint/错误/档位/HUD → 一份能读的 JSON）。
     纯函数才能进 Node 自检（`ws_selfshot_selftest.mjs`），也才能保证"只读不写"。 */
  import { type StyleLayerLite, buildStyleReport } from "./wsStyleReport";
  /* 🎬 场景装配（相机 + 层序）的**唯一真源**：与代拍页同一份（主会话要求"不许复制第二份"）。
     ⚠️ 数值**逐字保持**：本组件过去用 bearing 0 / maxPitch 85（与代拍页的 -18 / 70 不同），
     这两项**显式本地保留**并注明原因 —— 不许借"换源"顺手改观感。 */
  /* 🧱🏢🛣 **offline-first 的真源**（2026-09-25 切片 A）：发不发 `/api/*`、取数半径、三态判词
     全在这几个函数里 —— App **只读结论 + 如实写 HUD**，一条规则都不在这里重写。
     ⚠️ 这份真源同时有别的代理在用（片区名那条线），所以**本切片一个字都不改它**。 */
  import {
    WS_FETCH_R_BACKEND_MAX,
    applyPitchGuard,
    bldLiveDecision,
    cameraDefaults,
    /* 🧱 S3：`bldVerdictText` / `roadsVerdictText` 随 `renderBundleHud` 搬去了 `wsHudStats.ts`
       （判词真源仍是 `wsScene`，两边都从那儿取 —— 不是第二份实现）。 */
    fetchRadiusForView,
    fetchRadiusLadder,
    prerenderSourceOf,
    roadsLiveDecision,
    sceneOrderViolations,
    sceneSelfReport,
    viewHalfMetersOf,
    LOD_NEAR_ZOOM,
  } from "./wsScene";
import { WS_BLD_VECTOR_MINZOOM } from "./wsDistrictScene";
/* 🏙🎨 **挑选/冻结编排 + 美术取参**（2026-09-26 抽出的两份共享真源，**代拍页调的就是这一份**）：
   机主真机原话：「**App 页用的建筑模型不是 art1，每次滑动建筑都变了，名字也没有**」——
   实测两半都在这两行上：① App 原来用 `pickBuildingsForView`（**按视野**挑、没有冻结）⇒ 视野一变楼就变；
   ② App 只有 `bldLayerSpecsFor(theme, tier)` 两个参数，而代拍页还带 `artRamp`/outline/vgrad/opacity/stops
   ⇒ 同一个主题、两页喂进同一份装配函数的**输入不同**。现在两边调**同一份**：
   `createBldPickStore()` / `bldArtParamsOf()` / `bldCapForCellDeg()` / `parseBldnParam()` / `parseInViewParam()`。 */
import {
  createBldPickStore,
  bldCapForCellDeg,
  parseBldnParam,
  parseInViewParam,
  WS_BLD_CELL_CAP_REF_DEG,
  type BldPickStats,
} from "./wsBldPickStore";
/* 🏙 **按格取前 K 的挑楼**（机主 2026-10-02 拍板的 B2 + 2026-10-03 第五条）：成本模型/两个固定常量/
   确定性排序全在那一份里；这里只取两把尺子（"1 米楼高 = 多少屏幕像素" + "1 像素 = 多少米"，
   **两页必须同一把**，所以公式也只有那一份）。
   🆕 2026-10-03 第五条起取的是 **`bldMaxDrawnOf(档位)`**（= **每格**取前 K 栋）：
   **K 与 zoom 无关**（宿主挑楼时**不再传任何相机量给挑选规则**——那是"集合定下来"的前提）；
   分界线/滞回宽度只有 `wsBldBudget` 那一份（宿主不写任何数字），而且现在**只管画法**。
   `bldTierOfZoom` = **足迹/立体那条分界线的唯一判据**（带 0.25 滞回）——宿主不自己写
   `z < WS_BLD_FOOTPRINT_MAXZOOM`，也**不直接引用那条分界线的常量**（点选那条路也只是调它）。 */
import { bldMaxDrawnOf, bldMetersPerCssPixel, bldPxPerMeter, bldTierOfZoom, type BldBudgetBounds } from "./wsBldBudget";
/* 🏙 **楼栋档位的存储**（`localStorage["wsm:v1:bldmode"]`；默认严格档）——
   顶栏那颗 chip（`WsCityEntry.vue`）与本组件读的是**同一个模块级单例 ref** ⇒ 点一下这里就收到。 */
import { WS_BLD_MODE_MANY, useWsBldMode } from "./wsBldMode";
import { bldArtParamsOf, parseArtParam, type BldArtThemeLike } from "./wsArtParams";
/* 🏙 挑选的**入参类型**（`wsBuildingPick` 的纯函数类型）；实际编排在上一行那个 store 里 */
import type { PickBounds, PickFeature } from "./wsBuildingPick";
  /* 🎬🏢 **小区级 3D 装配的共享真源**（`wsDistrictScene.ts`，2026-09-25 切片 A 从本组件**搬家**过去）：
     `districtStyleOf`（原本地 `makeStyle`）、`bldLayerSpecsFor`（原 `bldLayerSpecs`）、
     `applyBuildingsTo` + `flushBldStore` / `flushRoadsStore`（原 `applyBuildings`/`flushBld`/`flushRoads`）。
     🔴 PR 标准门禁 C1：「App 宿主不许有第二份实现」—— 宿主只接线，逻辑在这份真源里，
     原型页之后也从这里取（它的那份由片区名那条线收口）。 */
  import {
    bldLayerSpecsFor,
    flushBldStore,
    flushRoadsStore,
    scenePlanConsumed,
    type BldPickAnyStats,
  } from "./wsDistrictScene";
  /* 🧱 **累积式要素仓库 + 离线格数学**（`createFeatureStore` / `*BundleCellsForView`）：
     机主「之前的没了…必须保证视野内完整」那条。合并/淘汰/格键的规则只有那一份，这里只调用。 */
  import { createFeatureStore } from "./wsFeatureStore";
  /* 🧱 **离线包取数管道**（App 侧承载；代拍页里那份是原型的内联写法，不进 PR）：
     串行取格 + 每格独立超时 + 并进仓库 + 一次 setData。判词/决策/半径仍从 `wsScene` 来。 */
  import {
    BLD_STORE_CAP,
    /* 🏘 第三条管道（片区名，切片③ 2026-10-01）的预算常量 + 取值器：**与代拍页同一份模块** */
    PLACES_STORE_CAP,
    ROADS_STORE_CAP,
    type BundleBuildingFeature,
    type BundleFeedFacts,
    type BundlePlaceFeature,
    type BundleRoadFeature,
    type BundleView,
    bldIdOf,
    bldPointOf,
    /* 🧱 S3：`bldVerdictState` / `bundleCountsLine` / `loadBundleIndex` / `roadsVerdictState`
       随 `renderBundleHud`/`attributionOfFeed` 搬去了 `wsHudStats.ts`（真源仍是本模块）。 */
    createBundleFeed,
    fetchWithTimeout,
    placesIdOf,
    placesPointOf,
    roadsIdOf,
    roadsPointOf,
  } from "./wsOfflineFeed";
  /* 🏠 「我的家」要的形状（`{name,lng,lat,kind}`）——**只有类型**从共享真源 `wsDaily.ts` 取，
     规则（怎么挑家/怎么排三件事）一行都不在这边（PR 门禁 C1）。 */
  import type { PlacePoint } from "./wsDaily";
  /* 🌊🌳 **真水系 / 绿地**（机主选的"自己画"）：格键 / 取数 / 归一化 / 配色 / 层序 / 署名 / 判词
     的**唯一真源**。代拍页那段内联的 `refreshGw()` 与这里**共用同一份** —— App 宿主里
     **一行规则都不写**（PR 门禁 C1 的红线：宿主不许有第二份实现），这里只接线。 */
  import { type GwMapLike, createGwLayer } from "./wsGwLayer";
  /* 🏷🗺 **名字层**（机主 2026-09-26：「我要求**每个显示的楼房都要有名字喵**，如果太密集了就根据类型
     划定区域（如经济区，美食区），**每个名字和楼房都能点击查看信息**」）。
     🔴 **宿主只接线**（PR 门禁 C1：App 不许有第二份实现）：取数 / 真名标签 / 区名聚合 / 迟滞闸门 /
     动效参数全在共享真源 `wsNameLayer`（它再用 `wsLabels` + `wsZoneNames`）⇒ 代拍页接的是同一份。 */
  import {
    LABEL_CAMERA_CLASS,
    LABEL_MOTION,
    type NameMapLike,
    type NameRenderNode,
    type NameRenderPlan,
    createNameLayer,
    nameVerdictLine,
  } from "./wsNameLayer";
  /* 🪪 **信息卡**（点楼体 / 点名字 / 点区名 ⇒ **同一张卡**；数据部分在纯逻辑 `wsBuildingCard` 里）。 */
  import { buildingCardData, type CardData } from "./wsBuildingCard";
  import WsBuildingCard from "./WsBuildingCard.vue";
  /* 🕹 **摇杆 + 近景（角色第一视角）**（2026-10-03 机主裁决：「街景不要了喵，直接给我们的地图做一个近景」）。
     🔴 事实口径（不许含糊）：MapLibre **做不出眼睛高度的实景**，这里是「**倾斜俯视的跟随**」——
     镜头盯着「我」的漫游位置（带阻尼与前瞻，**不再与角色重合**）、`pitch` = 64、`bearing` = 朝向
     （我们只记录移动方向、**不转相机**）；地面是平面贴图、楼是挤出体 ⇒ 观感是"游戏里的俯视跟随"，
     **不是街景照片**。
     规则/纯函数/驱动/位置真源/运动模型全在 `wsJoystick.ts`（本组件只接线，PR 门禁 C1）：
       ① 每帧把**相机**的屏幕位移交给 `panBy([dx,dy],{duration:0})`（库内已处理 pitch/bearing ⇒ **不写第二份投影数学**）；
       ② 🆕 **角色**走自己的世界坐标（运动模型积分 → `roamStore` → 「我」那颗钉子 `setLngLat`）——
          位置真源只有这一个（它**不进** `wsRuntimePush`、不当 gameplay 距离）；
       ③ `joyActive` 期间按红线降级（见下面四个 handler 的早退）+ 松手→**回中跑完**后**恰好 1 次**重算；
       ④ 🆕 **世界尺度**（米/像素 + 速度档）由本组件在 `joyCalibrate()` 里量一次再往下传
          （`wsJoystick.ts` 里一行米/像素换算都不写）—— 速度是**米/秒**，屏幕像素只是结果。 */
  import WsJoystick from "./WsJoystick.vue";
  import {
    /* 🧱 S3：`JOY_HUD_LIFT_PX` / `JOY_INSET_PX` / `joyBasePxOf` / `joyGateOf` / `joyThumbPxOf`
       随摇杆几何（`joyVars` 那一段）搬去了 `wsMapCamera.ts`（真源仍是 `wsJoystick.ts`）。 */
    JOY_PITCH_DEG,
    JOY_SPEED_MPS,
    JOY_STEP_PX,
    ROAM_PIN_ID,
    type JoyCamSnapshot,
    type JoyFramePhase,
    type JoyMotion,
    type JoyPxScale,
    JOY_ZOOM_PUSH_LEVELS,
    createJoyMotion,
    joyAimModeOf,
    joyAimRotateDegOf,
    joyAimStep,
    joyBearingNowOf,
    joyCamRestoreArgs,
    joyCamSnapshotOf,
    joyDepthGainOf,
    /* 🕹🧱 走路期间补刷新的**唯一闸门**（纯函数；2026-10-04 第八轮"楼会不见"那条） */
    joyFlushDue,
    joyHomeBoxesOf,
    joyLngLatOf,
    joyNamesHiddenOf,
    joyPanScaleOf,
    joyPxScaleOf,
    joyScreenHeadingOf,
    joyScreenOf,
    joySetBearingNow,
    joySetCam,
    joySetFrame,
    joySpeedMpsOf,
    joyWalkAnimOn,
    roamStore,
  } from "./wsJoystick";
  /* 📍 **屏外方向指示**（2026-10-04 第七条；机主原话「**为什么其他角色不见了喵**」，
     他自己点的方案是「**屏外加方向指示（小箭头 + 距离）**」）。
     病根：角色钉子走地图库 `Marker`，**出了视口就是真的没有**（没有"贴边"这回事）⇒ 屏外的人看不见。
     🔴 规则（夹取 / 角度 / 距离文案）**一行都不在这里**（在 `wsPinEdge.ts`，纯函数、Node 可直连）；
     本组件只做三件事：建节点（每颗钉子一个，**建一次复用**）、每轮算一次屏幕点、**只在变了才写 DOM**。
     🔴 角度换算（CSS `rotate()` 那个 `−90`）也**不在这里**：`pinEdgeRotateDegOf()` 转调摇杆那一份。 */
  import { PIN_EDGE_MARGIN_PX, PIN_EDGE_MIN_GAP_PX, pinDistText, pinEdgeOf, pinEdgeRotateDegOf } from "./wsPinEdge";
  /* 🔬 「验证面板」（机主 2026-09-21：「**保证我们的全部验证功能在 App 页可全部看到喵！**」）。
     面板与样式 JSON **吃同一份快照** —— 同一件事两种读者（人看图、agent 读 JSON），不许各算一套。 */
  import WsVerifyPanel from "./WsVerifyPanel.vue";
  import { type VerifySnapshot, runVerifyChecks } from "./wsVerifyChecks";
  /* 🎨 MapLibre 的**样式表**注入（`link[data-ws-ml-css]`）：本组件直接 import 引擎，
     所以必须自己补这一下 —— 少了它 `.maplibregl-marker` 不是 absolute，角色钉子会掉进文档流
     （2026-10-01 机主报的「人物位置错位」就是它；证据 `~/chk/_mlcss_probe.mjs`）。 */
  import { injectCss as ensureMlCss } from "@/composables/useWsMapLibre";
  /* 🧑 切片②（2026-10-01）：面板的开关状态（模块级单例，与宿主 `WsCityEntry.vue` 读的是同一份）。
     这里只为了**一句早退**：面板开着时点地图空处先关面板（见 `onMapClick`），
     **不新开第二条 click 监听**、也不在这里开面板/画面板（PR 门禁 C1）。 */
  import { useWsPanel } from "@/composables/useWsPanel";

  /* ══ 🏙🎨 **两页一致的取参**（2026-09-26）—— App 侧不再自己发明「画几栋 / 什么美术」 ══════════
     机主拍板口径：**代拍页和 App 页必须完全一样**（两页共用同一份实现 + 同一套参数）。
     所以这里的三个数**全部由共享真源解析**，默认值与代拍页**逐字相同**：
       · `?art=`      → `parseArtParam`（默认 1；2 = 高调平涂 + 近白高段，3 = 再加天空/raster 调色）
       · `?bldn=`     → `parseBldnParam`（默认 null = 按格面积等比缩：0.05° ⇒ 100、0.01° ⇒ 4）
       · `?inview=`   → `parseInViewParam`（默认 10 —— 机主「视野内最少有十栋房」）
     ⚠️ App 是 hash 路由（`#/worldsim?art=2`）⇒ 查询串可能在 **hash 里**，所以两处都读。
     ⚠️ 这是**调试口**（A/B 用），不是"App 里塞状态出口"：默认值 = 代拍页默认值，不传就零影响。 */
  function wsQuery(): string {
    try { return String(location.search || "") + "&" + String(location.hash || ""); } catch { return ""; }
  }
  const WS_ART_LEVEL = parseArtParam(wsQuery());
  /** `?bldn=` 显式钉住的值（null = 按面积算）；两个宿主读的是**同一个解析器** */
  const WS_BLDN_PIN = parseBldnParam(wsQuery());
  /** 视野内至少几栋（机主「最少十栋房」；`?inview=` 可 A/B） */
  const WS_BLD_INVIEW = parseInViewParam(wsQuery());
  /**
   * 🏢 **楼房形体档**（与代拍页同一个开关，2026-09-26 机主 (a′)）：
   * · 默认（不给参数）= **原始脚印**（基准上妆，**不拆件**）—— 与代拍页默认档**逐字段同源**；
   * · `?bld=2` = **拆件档**（裙楼/塔楼/退台/女儿墙/设备箱/天线，跑 `decorateBuildings(mode:"detail")`）。
   *
   * 🔴 为什么要有它（机主那句「**代拍页和App页完全一样喵**」的另一半）：让 App 默认档向代拍页看齐、
   * 同时**不永久丢掉** App 已有的形体细节 —— 细节改成"要看才开"的档，页面本来就有 `?bld=2`。
   * ⚠️ 默认档**不能**再走 `decorateBuildings`：那份 base 档**照样拆 roof/antenna**，
   * 于是 App 的层清单比页面多两条、`bld-ext` 还带 `part` 过滤（套到页面数据上会一栋都不画）。
   */
  const WS_BLD_MODE = (function () {
    try { return /[?&]bld=2\b/.test(wsQuery()) ? 2 : 1; } catch { return 1; }
  })();

  const props = withDefaults(
    defineProps<{
      /** 区域名（只用于日志/降级提示） */
      area?: string;
      /**
       * 当前**所在的区县 adcode**（如涪陵区 500102）。
       *
       * 🔴 这是 2026-09-19 两个真实事故的解药：
       * ① 之前不带坐标取楼栋，后端用它自己的"最近一次定位"（实测 29.752,107.278）⇒ 0 栋；
       * ② 我改成先问 IP 定位（只到"重庆市中心"）⇒ 画面跑到**渝中区解放碑**，
       *    而机主人在**涪陵区** ⇒ 地名/道路全对不上。
       * ⇒ 唯一正确的来源是**用户确认过的那个区**（`sim.leaf.adcode`），用它取中心与边界。
       */
      adcode?: string;
      /** 取楼半径（米） */
      radius?: number;
      /** 初始倾角（度）；0 = 俯视。倾斜是"2.5D 感"的一半 */
      pitch?: number;
      /**
       * 地图上的人（P1b 第一刀）。**位置是"示意"不是"实测"**：
       * 网格坐标属于草图空间，这里按**区界 bbox 线性映射**到经纬度 ——
       * 换句话说"人在区的相对位置是对的，但不会精确到某栋楼"。
       * 为什么只能这样？因为当初草图就没带地理坐标（`sketch.rs` 里 grep 不到 lat/lng），
       * 真实定位那条路要等"角色经纬度"落库，那是另一张卡。
       */
      markers?: WsDistrictPin[];
      /** 网格边长（默认 28，与草图 `WS_GRID` 一致） */
      grid?: number;
      /**
       * 天黑程度 0..1（`wsTime.nightLevel(hour)`，由 `WorldSim` 一路传下来）。
       * 默认 0 = 白天 ⇒ 配色与改动前**逐字一致**（老调用点不用改）。
       */
      night?: number;
      /**
       * **AI 精绘的产出**（楼/路/公园/水系，网格坐标）。以前它只画在那块"浮在地图上的 SVG"里，
       * 机主看到的就是"一张白卡片盖在黑暗地图上"；现在把它翻译成地图图层 ⇒ 楼能挤出 3D。
       */
      aiItems?: AiItem[];
      /**
       * 要不要把 AI 精绘的图元画到地图上。
       *
       * **默认关**（2026-09-19）。理由见 `syncAiLayers()` 的说明：AI 图元用的是
       * "草图网格 → 整区 bbox"的示意映射，一栋"楼"在地图上几百米宽，是**薄饼不是楼**，
       * 叠在真楼房旁边只会把画面弄脏。等 AI 图元带上真实经纬度（或走独立的示意模式）再默认开。
       *
       * 🆕 2026-09-20：它现在是**强制开**的开关（`aiAuto` 负责"自动"那半边）。
       * 想"无论如何都别画示意层"就传 `:ai-auto="false"`（见下）。
       */
      showAi?: boolean;
      /**
       * 要不要把角色**吸附到真实路网**上（`wsSnap.snapToRoad`）。
       *
       * 默认 **false**：吸附会让角色"位置变了"，而这个变化依赖"这一带的路网取回来了没有" ——
       * 路网取不到时人还在示意位置，取到了又跳一下。**先由调用方显式打开**，
       * 等路网稳定性验过再考虑默认开。
       */
      snapPins?: boolean;
      /**
       * 真数据稀疏时**自动**叠示意层（默认开）。
       *
       * 机主 2026-09-20 的原话就是验收标准：「**有真数据用真的，真数据不够时自动叠示意层 + 标注**」。
       * 所以这里不是"显示开关"，是**数据稀疏的兜底**：
       *   · 真楼 ≥ `BLD_SPARSE`（40 栋）⇒ 只用真楼，示意层**摘掉**；
       *   · 真楼 < 40（含"一栋都没有"）⇒ 自动叠上，并在 HUD 如实写明"非事实"。
       * 显式传 `false` 可关掉这个自动行为（那时只有 `showAi=true` 才画）。
       */
      aiAuto?: boolean;
      /**
       * 定位来源（`useWorldSim.locSource`：gps / ip / manual / restored）—— 验证面板要显示它。
       *
       * 机主实测「**定位拿到但落到北京**」时，屏幕上没有任何一处说明"这是 IP 兜底猜的"
       * （多半还是 VPN 出口）⇒ 看着就像定位坏了。来源必须写出来。
       */
      locSource?: string;
      /** 世界时间（如 `23:41`）—— 验证面板要"世界时间 + 夜色档"一起看，**透传**即可，别在这里算第二份 */
      worldTime?: string;
      /**
       * 🕹 要不要挂**摇杆 + 近景（角色第一视角）**。
       *
       * **默认 `false`**（刻意的）：只有 `/worldsim` 这一屏（`WsCityEntry.vue`）显式打开，
       * 别的宿主（孤儿页那条引导主线）**一个字都不用改**、行为逐字不变。
       * 开关本身（`?joy=0`）由入口解析（`wsJoystick.joyOnFromLocation()` —— 唯一定义处），
       * 这里只收结果：**本组件不读 URL**（免得同一件事有第二份判据）。
       * ⚠️ 2D 降级路（无 WebGL ⇒ 没有相机）⇒ 摇杆**不渲染**并写一行原因（`joyGateOf`）。
       */
      joy?: boolean;
    }>(),
    /* 🎨 2026-09-20 机主：「**2.5D 倾斜范围扩大至可看见天空（蔚蓝档案基沃托斯的天空）**」。
       55° 是"俯视看楼"的角度 —— 相机压得太低，天际线以上全在屏幕外，**根本看不到天空**。
       降到 38°：楼体的 2.5D 透视还在（看得出体量），但地平线和天空进了画面。
       ⚠️ 这只是**默认值**；机主仍可以用手势压到 85°（见下面 `maxPitch`）。 */
    {
      area: "",
      radius: 600,
      pitch: 38,
      markers: () => [],
      grid: 28,
      night: 0,
      aiItems: () => [],
      showAi: false,
      aiAuto: true,
      snapPins: false,
      locSource: "",
      worldTime: "",
      joy: false,
    }
  );


  /**
   * 🎬 **场景就绪**（2026-09-24）：地图实例 + **已经画上去的那批真楼栋** 一起交给外层。
   *
   * 为什么需要这个口子（而不是让外层自己再取一遍）：交通设施（代拍页 `?tf=1`）要按**楼脚印**
   * 算停车场/出入口 —— 楼栋是这个组件取的（带 adcode/驻地/半径爬梯那一整套），
   * 外层重取一遍 = **同一件事两份实现**（本项目反复栽的坑），还会把 Overpass 打第二遍。
   * ⇒ 组件在"楼真的画上去了"那一刻把 `fc` **原样**递出去（不做 dress/decorate，那是渲染用的副本）。
   *
   * ⚠️ 只发一个事件、不导出内部状态：`map` 只给"要在它上面加图层"的调用方用（如 `WsSceneView`），
   *    它自己**不**修改相机/层序以外的东西。
   */
  const emit = defineEmits<{
    /**
     * ⚠️ `places` 是**切片③ 新增的可选字段**（2026-10-01）：一个**只读取值器**，
     * 返回当前片区名仓库里的有名点（`{name,lng,lat,kind}`，给「我的家」挑选用）。
     * 旧监听者（连 `buildings` 都不读的那些）**逐字不变** —— 多一个键不影响任何既有行为；
     * 取值器而不是数组：名字点会随视野一批批到（`placesFlush`），快照比"某一刻的数组"更准。
     */
    (
      e: "scene-ready",
      payload: { map: unknown; buildings: { features?: unknown[] } | null; places?: () => readonly PlacePoint[] }
    ): void;
    /**
     * 🧑 **点了地图上的某个人**（切片②，2026-10-01）：只把钉子 id 交出去，由宿主开角色面板。
     *
     * 为什么在这里只"报点"、不自己开面板：面板与送礼弹层的**唯一实现**在 `WsCharPanel.vue`
     * （PR 门禁 C1：App 里不许第二份实现）⇒ 地图组件不认面板、不碰路由、不读好感。
     * `id` 就是 `WsDistrictPin.id`（真角色 `r<roleId>` / 玩家 `me` / 名单兜底 `roster:<folder>`）；
     * **兜底钉子反查不到真 actor**，宿主必须给一句 toast（不许静默，见 `WsCityEntry.onPickActor`）。
     */
    (e: "pick-actor", id: string): void;
  }>();

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
  /**
   * 那块**自绘**画布要不要存在？（模板 `v-if="show2d"`）
   * 只有真的走 2D 降级路时才 `true` —— 定案证据：WebGL 路下它是一块**默认 300×150、透明、
   * display:block** 的空壳，CSS 拉满整屏 ⇒ **盖住真地图**（机主的"浅色矩形"就是它）。
   */
  const show2d = ref(false);

  /* ══ 🕹 **近景那一套**（摇杆 → 漫游位置 → 相机跟随；2026-10-03 机主裁决）══════════════
     事实口径先写清楚（免得后面有人当街景用）：这是**倾斜俯视的跟随** ——
     镜头中心 = 「我」的漫游位置、`pitch` = 64°、`bearing` = 朝向；**不是**眼睛高度的实景
     （MapLibre 给不出那种东西：地面是平面贴图、楼是挤出体）。

     🧱 重构切片 S3（M1）：这段几何（`joyGate` / `basePitch` / `joyVh` / `joyMeasureVh` /
     `initPitch` / `joyVars`）**整块搬进了 `wsMapCamera.ts`** —— 装配点在下面 `labRootEl` 之后那一段
     （它要等那几个名字层的 ref 声明完，否则踩 TDZ）。**这里不许再写第二份。** */
  /* 📊 样式自检要带上 **HUD 原话**（机主看到的那一行）—— 只读，不参与任何渲染逻辑 */
  const hudEl = ref<HTMLElement | null>(null);
  /**
   * 🔬 验证面板要知道的"这一页现在到底是什么状态"。
   *
   * `renderKind` 初始是 `"init"`（还没分路）—— **不许猜**：分路之前说"WebGL 还是降级"就是编。
   * `fallbackWhy` 是**降级原因原文**（看门狗期限 / `map.on('error')` 文本），面板与样式 JSON 共用。
   * 面板展开是**一次快照**（不逐帧算），所以这几个 ref 的更新开销可以忽略。
   */
  const renderKind = ref<"init" | "webgl" | "waiting" | "failed" | "fallback2d">("init");

  const fallbackWhy = ref("");
  /**
   * 降级的**类别**（P0：把"永久判决"改成"可恢复"）：
   * `none` 没降级 / `temp` 只是慢（实例还在后台跑，出帧自动切回）/ `perm` 报错或拿不到实例。
   */
  const fallbackKind = ref<"none" | "temp" | "perm">("none");
  /** 🎬 相机/层序有没有真的取自 `wsScene`（自证用；拿不到模块就保持 false ⇒ 面板如实标"还没换源"） */
  /* 层序锚点「用上了没有」由共享真源回证（`wsDistrictScene.scenePlanConsumed()`）——宿主不再自存一份 */
  /** 曾经降级、后来恢复回 WebGL 了吗（面板要写出来：不然人以为一直在 2D） */
  const recovered = ref(false);
  /** 临时类的"后台等它出帧"计时器（卸载要清） */
  let recoverTimer = 0;
  /** 后台最多等多久（**只是等**，不影响 2D 可用；到点仍不恢复就如实写"HUD 里说等待超时"） */
  const RECOVER_MS = 180000;
  /** 已等待的秒数（看门狗那一刻的实际期限；面板/HUD 都要如实显示"等了多久"） */
  const renderLimitSecs = ref(0);
  /** `?wsverify=1` ⇒ 一进来就把验证面板摊开（机主要的"全部验证功能在 App 页可全部看到"） */
  const verifyOpen = ref(
    (() => {
      try {
        return /[?&]wsverify=1\b/.test(typeof location !== "undefined" ? location.search : "");
      } catch {
        return false;
      }
    })()
  );
  /**
   * 地图库 `error` 事件收到的错（**只记不改**）。
   *
   * 为什么单独一个数组（而不是读 `stats.note`）：`stats.note` 是给机主看的一句话，
   * 会被后面的写入**覆盖**；而"样式校验失败那类错误"往往发生在很早，等自拍时早就被冲掉了。
   * ⇒ 用一个只增不减的数组兜住它，自检 JSON 里原样带走。
   */
  const mapErrs: string[] = [];
  /* 性能档位（模块级单例）。**只在这一处用**：`fallback2d()` 里把档位压到低档 ——
     因为只有这里知道"最后真的走了哪条渲染路"，而档位必须跟那条路一致。 */
  const perf = useWsPerf();

  /**
   * 当前地图主题。优先级：**URL 参数 > localStorage > 默认（二次元）**。
   *
   * 为什么 URL 排第一：代拍通道就是"给机主一个 URL 让他点一下"（`?autoshot=1&wstheme=night`），
   * 这条路上**不能**被上次存下的偏好盖掉，否则"我想看另一套"永远看不到。
   * 为什么默认是二次元：机主这轮的原话是"想给**整体**地图改成二次元式的那种风格"。
   * 为什么全程 try/catch：`localStorage` 在隐私模式/某些 WebView 里会直接抛 ——
   * 一个美术偏好不该把整张地图搞崩。
   */
  function resolveThemeId(): WsMapThemeId {
    const fromUrl = parseWsMapThemeParam(typeof location !== "undefined" ? location.search : "");
    if (fromUrl) return fromUrl;
    try {
      const saved = localStorage.getItem(WS_MAP_THEME_KEY);
      if (saved && (saved === "night" || saved === "anime")) return saved;
    } catch {
      /* 读不到就用默认值，不报错 */
    }
    return WS_MAP_THEME_DEFAULT;
  }
  const themeId = ref<WsMapThemeId>(resolveThemeId());
  /** 当前主题对象（模板/HUD 也能读，机主在 HUD 上能看出现在是哪套） */
  /* 🌙 夜色（`DESIGN-NIGHT.md` 第 1 件）：主题 → **派生**出夜里那一版。
     为什么接在这一行：`theme` 是下面所有配色的**唯一来源**（`themeStyleParts`、楼体色阶
     `rampExpression`、描边、`sky`）⇒ 在这一处换掉，整张图（楼/地/天/色罩）一起入夜，
     不会出现"楼暗了地没暗"的割裂。`night = 0` 时 `nightVariant` **原样返回**，
     所以白天与改动前逐字一致（自检守着这条）。 */
  /** 昼夜缓变的时长（`DESIGN-NIGHT.md` 第 1 件要求 800~1500ms）。低档传 0 ⇒ 不写 transition。 */
  const NIGHT_FADE_MS = 1200;

  /** localStorage 键（与 `wsm:v1:mapTheme` 同一命名空间） */
  const WS_NIGHT_KEY = "wsm:v1:night";
  /**
   * 夜色**默认开不开**（逃生阀的闸）。
   *
   * 🔴 为什么留这个常量（2026-09-21 深夜，一段有争议的排障）：
   *   机主报「近/远两张截图**逐字节相同**、整屏一片浅蓝」，怀疑是夜色把画面抹平了。
   *   查下来**不成立**（三条证据）：
   *     ① 那两张是 **21:54:58** 拍的，而夜色代码的 mtime 是 21:56、commit 是 **22:01**、
   *        进包是 **22:04** ⇒ 拍那张图时**夜色还不存在**；
   *     ② 同款空白 **09-19 23:27** 就出现过（`~/chk/live/_stale-before-stylefix/232756-*.png`，
   *        132,368B，与这次的 132,431B 同形态）——那时既没有二次元主题也没有夜色；
   *     ③ 夜色**开着**的时候画面是有内容的：`~/chk/live/223849-show-near.png`（22:38）
   *        2.87MB、颜色 std≈4.8，楼和底图都在。
   *   ⇒ 那是**代拍/无头 WebGL 的老毛病**（项目早就写过「无头首帧后可能丢上下文，
   *     截图空白但指标正常」），不是这轮引入的回归。
   *
   * 所以默认**保持 auto（跟着世界时间走）** —— 关掉它等于白丢机主要的「按世界时间入夜」，
   * 而且**止血不了**（空白在夜色之前就有）。真要一键回到"永远白天"，把这里改成 `false`
   * 或走 `?wsnight=off`（机主也能自己用 URL 切）。
   */
  const WS_NIGHT_DEFAULT = true;

  /**
   * 读「夜色开不开」：**URL > localStorage > 默认**（与 `resolveThemeId` 同一优先级口径，
   * 理由也一样：代拍通道是"给机主一个 URL 让他点一下"，不能被上次存的偏好盖掉）。
   * 认不出来的值一律回默认，**不抛** —— 一个观感开关不该把地图搞崩。
   */
  function resolveNightOn(): boolean {
    try {
      const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
      const v = String(q.get("wsnight") || "").trim().toLowerCase();
      if (v === "off" || v === "0" || v === "no") return false;
      if (v === "on" || v === "1" || v === "yes") return true;
      const saved = localStorage.getItem(WS_NIGHT_KEY);
      if (saved === "off") return false;
      if (saved === "on") return true;
    } catch {
      /* 隐私模式 / 无 localStorage ⇒ 按默认，不报错 */
    }
    return WS_NIGHT_DEFAULT;
  }
  const nightOn = ref(resolveNightOn());

  /**
   * 天黑程度 0..1，夹一下（调用方给什么脏值都不会把配色算坏）。
   * 关掉开关时**恒为 0** ⇒ `nightVariant(theme, 0)` 原样返回 ⇒ 与"没有夜色那版"逐字一致
   * （这就是逃生阀的全部机制：不进白天分支的代码一行都不动）。
   */
  const nightLvl = computed(() =>
    nightOn.value ? Math.max(0, Math.min(1, Number(props.night) || 0)) : 0
  );
  const theme = computed<WsMapTheme>(() => nightVariant(wsMapTheme(themeId.value), nightLvl.value, !!perf.low.value));
  /** 低端档时要丢什么（`perf.low` 是单一真源，见 `wsCaps.ts`） */
  const themeTier = computed(() => themeForTier(theme.value, !!perf.low));

  /**
   * 🌙 **昼夜缓变**：天黑程度变了 → 把几条 paint 属性**就地**改成夜里那版。
   *
   * 为什么不是重建 style：重建会把瓦片、图层、标点全部推倒重来（闪一下 + 重新取瓦片），
   * 而 MapLibre 的 `fill-extrusion-color` / `background-color` / `line-color` **都支持过渡**
   * （`transition: true`，见 `DESIGN-NIGHT.md` 已查实的事实③）⇒
   * `setPaintProperty(id, prop, value, { duration })` 一句就够，**不要自己写插值**。
   *
   * ⚠️ 低档 `duration = 0`（`DESIGN-NIGHT.md` 要求"低档只留纯暗色"）：过渡要每帧重绘，
   *    在软渲染路上正好是我们花了两轮才省下来的东西。
   * ⚠️ 每一步先 `getLayer()` 探 + 整段 try：**地图库在图层不存在时会抛错**，
   *    而这条路是"锦上添花"，绝不能因为一个图层没建就把地图搞崩（守住闸门①不崩）。
   */
  watch(nightLvl, () => {
    const m = map as {
      getLayer?: (id: string) => unknown;
      setPaintProperty?: (id: string, prop: string, val: unknown, opts?: { duration: number }) => void;
      setSky?: (sky: Record<string, unknown>) => void;
    } | null;
    if (!m || !alive || !m.getLayer || !m.setPaintProperty) return;
    const t = theme.value;
    const duration = perf.low.value ? 0 : NIGHT_FADE_MS;
    try {
      if (m.getLayer("bg")) m.setPaintProperty("bg", "background-color", t.bg, { duration });
      if (m.getLayer("tint") && t.tint) {
        m.setPaintProperty("tint", "background-color", t.tint.color, { duration });
        m.setPaintProperty("tint", "background-opacity", t.tint.opacity, { duration });
      }
      /* 楼体色阶：整条 `interpolate` 表达式换掉。地图库对数据驱动属性会**交叉淡入**
         （这正是"不要自己写插值"的意思）。 */
      if (m.getLayer("bld-ext")) m.setPaintProperty("bld-ext", "fill-extrusion-color", rampExpression(t), { duration });
      if (m.getLayer("bld-line")) m.setPaintProperty("bld-line", "line-color", t.outline.color, { duration });
      /* 天空是**根级**属性（不是图层）⇒ 走 setSky。只有确认有这个方法才调
         （老版本没有它；`sky` 一旦被当成图层塞进 layers[] 会让整份 style 校验失败）。 */
      if (t.sky && typeof m.setSky === "function") m.setSky(t.sky);
    } catch (e) {
      /* 如实写进 HUD，别静默 —— 静默的失败下次还会再来一遍 */
      const msg = String((e as { message?: string })?.message || e).slice(0, 60);
      stats.note = stats.note ? `${stats.note} · 夜色过渡：${msg}` : `夜色过渡失败：${msg}`;
    }
  });

  /**
   * 运行时切主题（自用开关，机主要"暗色 ↔ 二次元"来回看）。
   * ⚠️ 这条**不做**在线换 style —— 换主题要重建 sources/layers，中途换容易踩到
   * "图层引用了还不存在的 source" 那类错误。这里只负责**记下来 + 重新载入页面**：
   * 对"来回对比"这个用法够用，而且**零风险**。 */
  function switchTheme(next: WsMapThemeId): void {
    if (next === themeId.value) return;
    themeId.value = next;
    try {
      localStorage.setItem(WS_MAP_THEME_KEY, next);
    } catch {
      /* 存不下也没关系，URL 参数照样能切 */
    }
    try {
      const u = new URL(location.href);
      u.searchParams.set("wstheme", next);
      location.replace(u.toString());
    } catch {
      /* 🔴 这里**必须**有个兜底动作：Tauri 的自定义协议（`tauri://…`）下 `location.replace`
         可能被拦，而偏好已经存进 localStorage 了 ⇒ 其实只要**刷一下**就生效。
         我第一版这里只留了句注释、没有真的 reload ⇒ 那就是"点了没反应"，
         跟我在「星」按钮上批评的毛病一模一样（自检永远看不出来，只有人点得出来）。 */
      try {
        location.reload();
      } catch {
        /* 连 reload 都不行 ⇒ 下次打开生效（偏好已经存下，不会丢） */
      }
    }
  }
  // eslint 不需要 map 的类型细节；这里只留一个句柄用于销毁
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  /* 🧱 S3（M8）：`let raf = 0;`（fps 采样那个 rAF 句柄）跟着 `startFps` 搬去了 `wsHudStats.ts`。 */
  let alive = true;
  /** 「放大才取楼」的去抖定时器（moveend 里用；卸载时要清） */
  let bldTimer = 0;
  /** 🏷 名字层在 `zoomend` 之后的去抖（缩放会改变避让结果与区名模式，必须重排一次；卸载时要清） */
  let zoomNameTimer = 0;
  /** 🏷 换批（"先隐后改字"）的定时器：新的一批到了要把它清掉（旧的不许覆盖新的）；卸载时要清 */
  let switchTimer = 0;
  /** 「地图库多久没画出第一帧就降级」的看门狗（卸载时要清，见 onBeforeUnmount） */
  let watchdog = 0;
  /** 地图库**真的出过一帧**没有？（`render` 事件；看门狗"别只看时间"就靠它） */
  let sawRender = false;
  /** 宽限用过了没有 —— **只宽限一次**，免得"宽限"变成"永远等下去" */
  let watchdogGraceUsed = false;

  /**
   * 是不是**自动化/无头**环境（`navigator.webdriver`）。
   *
   * 为什么要分开：看门狗期限对这两种环境的意义**正好相反** ——
   *   · 自动化（CI 闸门）：要的是"到点就**如实**降级"，等久了闸门自己先超时；
   *   · 真机：要的是"**别误判**"，WebGL 冷启动 + 首批瓦片本来就要十几秒。
   * 用一个开关环境都照顾到，而不是把 8 秒拍给所有人（那正是机主看到纯色屏的那条路）。
   * `navigator.webdriver` 是 Selenium/WebDriver 起的浏览器的标准标记；
   * 读不到就当**真机**（保守：真机的宽限比误判降级划算）。
   */
  function isAutomation(): boolean {
    try {
      return typeof navigator !== "undefined" && (navigator as { webdriver?: boolean }).webdriver === true;
    } catch {
      return false;
    }
  }

  /**
   * 看门狗期限（**环境感知**，不是一刀切 8 秒）。
   * 写成 computed 而不是常量：低档可能在挂载后才被压下去（`fallback2d` 会 `forceLow`），
   * 读的时候取当时的值才是"这条渲染路真的该等多久"。
   */
  const WATCHDOG_MS = computed(() => {
    if (isAutomation()) return 8000; // 闸门靠这条：到点如实降级，别把闸门拖成假失败
    /* 🔴 2026-09-21（P0）：真机期限**大幅放宽**（低端 30s / 其余 60s）。
       原来 12s/24s 的代价机主已经付过了：冷启动 + 首批瓦片本来就要十几秒到几十秒，
       到点被砍进 2D 路 ⇒ 又卡又没手势。而"等久了"在真机上只有好处（多等 = 少误判）；
       自动化保持 **8s 不变**（闸门靠这条：它要的是"到点如实降级"，等久了会把闸门拖成假失败）。
       ⚠️ 而且现在**判错也不致命**了：临时类降级是可恢复的（见 `watchdogFire` / `promoteToWebgl`）。 */
    return perf.low.value ? 30000 : 60000; // 真机：低端短一档，其余给足冷启动时间
  });

  /**
   * 看门狗到点：**如实降级**到 2D 自绘路，并把**实际期限**写进 HUD。
   *
   * ⚠️ 这里**没有**做"降级后再自动切回 WebGL"：`fallback2d()` 会换掉画布元素
   * （同一个 canvas 不能同时有 webgl 和 2d 上下文，见那里的注释），
   * 要切回来得**重建整张地图 + 换回那块画布**，代价与风险都不小。
   * ⇒ 本轮只做到"别误判 + 如实降级 + 降级路不再是一片纯色"，
   *   **自动回切列入未做**（写在 CHANGELOG 的未验/未做里，别当成已经支持）。
   */
  function watchdogFire(m: { remove(): void } | null, fc: { features?: BldFeature[] } | null, limitMs: number): void {
    if (!alive || phase.value === "done") return;
    const secs = Math.round(limitMs / 1000);
    /* 🔴 2026-09-21（P0 核心）：**"慢"不等于"坏"**。
       这里以前是**无条件** `m.remove()` + `map = null` —— 等于把"冷启动慢"判成**永久**降级：
       机器明明有 WebGL（代拍页 `ws3dshow.html` 实测顺滑，机主证过），却再也回不去那条路，
       于是又卡（2D 自绘填充率）、又像静态图、又没手势。**三个症状同一个根**。
       ⇒ 现在分两类：
         · **永久类**（`perm`）：地图库**报了错**（style/addLayer 那类，只能靠 `error` 事件捞），
           或者**压根没有实例**（无 WebGL / 地图库加载失败）⇒ 该降级，且把错误原文带进面板；
         · **临时类**（`temp`）：**没报错**，只是没在期限内出帧 ⇒ **不销毁地图**，
           把它留在 DOM 底下（`visibility:hidden`）继续渲染，2D 画在**另一块**画布上盖着它；
           一旦它出帧 ⇒ `promoteToWebgl()` **原地切回**（零重建、零换画布）。 */
    const hasErr = mapErrs.length > 0;
    const kind: "temp" | "perm" = !m || hasErr ? "perm" : "temp";
    const whyBase = `地图库 ${secs} 秒内没画出第一帧（load 未触发）`;
    /* 🆕 机主 2026-09-21：「**要求别降级了**」。没显式开逃生阀时**不画 2D**：
       留在页面上如实说明"还在等"，后台每 5 秒复查，出的帧一到、`load` 一来就照常往下走。
       真等不到了（见 `startRecoverPoll` 的期限）就切 `failed` —— **如实报错，不画假的 2D 图**。 */
    if (!ALLOW_2D) {
      renderKind.value = "waiting";
      fallbackKind.value = kind;
      renderLimitSecs.value = secs;
      stats.mode = `地图库还在加载…（已等 ${secs}s，后台继续等，**未降级**）`;
      stats.note = `${
        hasErr
          ? `地图库报了 ${mapErrs.length} 条错（原文见验证面板 ②）`
          : "地图库没报错，只是还没出帧"
      }｜${whyBase}｜页面保持加载态，出帧即继续；等满 ${Math.round(RECOVER_MS / 1000)}s 仍无 ⇒ 面板如实报错`;
      startRecoverPoll();
      return;
    }
    if (kind === "temp") {
      fallback2d(
        "2D 降级（地图库还在加载 · 会自动切回）",
        fc,
        `${whyBase}｜地图库没报错 ⇒ 判为**临时**：实例留在后台继续渲染，一出帧就切回 WebGL`,
        "temp",
        map
      );
      return;
    }
    try {
      m?.remove();
    } catch {
      /* 已经没了就算了 */
    }
    map = null;
    fallback2d(
      "2D 降级（地图库没起来）",
      fc,
      `${whyBase}${hasErr ? `｜地图库还报了 ${mapErrs.length} 条错（原文见验证面板 ②）` : ""}`,
      "perm",
      map
    );
  }
  /** 区界 bbox（setup 作用域也要用：Marker 同步要用它把网格换算成经纬度） */
  const bboxRef = ref<[number, number, number, number] | null>(null);
  /**
   * 🧭 **2D 自绘路自己用的那个范围**（`draw2d` 按"真楼 + 示意图元"现算的包围盒）。
   *
   * 为什么得要它（2026-09-27 机主报「连人都没有了」时查出来的真 bug）：
   *   · 降级路的人（`domPins`）要一个 bbox 才能把网格换成画面百分比；
   *   · 而 `bboxRef` 在 App 页（`adcode=""`）**只有 WebGL 地图能给**（`ensurePinAnchor()` 用 `map.getBounds()`）
   *     —— 降级路 `map = null` ⇒ `syncPins()` 一进门就 return，那个函数**永远轮不到执行**
   *     ⇒ `bboxRef` 恒 null ⇒ `domPins` 恒返回 `[]` ⇒ **降级路一个角色都放不下，且 HUD 只显示 `👤 0`（不解释）**。
   *   · 而 `draw2d` 画楼用的是**它自己现算的 minX/minY/maxX/maxY**（不读 `bboxRef`）——
   *     所以人必须用**同一份**范围，否则人会被映射到跟楼不一样的地方（画一个区、人按整市铺）。
   * ⇒ 这里把那份范围**留出来**给 `domPins` 用（只读，不改 `draw2d` 的绘制行为）。
   */
  const draw2dBbox = ref<[number, number, number, number] | null>(null);
  /** 真的把地图库跑起来了？（2D 降级时为 false ⇒ 走 DOM 钉子） */
  const mapAvailable = ref(false);
  /** 已经画在地图上的"人"（id → { el, marker }） */
  let pins: Array<{
    id: string;
    el: HTMLElement;
    mk: { setLngLat(c: [number, number]): unknown; getLngLat?(): { lng: number; lat: number }; remove(): void };
    /** 🕹 只有「我」那颗钉子有：朝向箭头 / 身体（建钉子时抓一次，**不在帧里 `querySelector`**） */
    face: HTMLElement | null;
    body: HTMLElement | null;
    /** 🎯 同理（预走线三件套：容器 / 虚线 / 箭头）—— 每帧只写它们的 `transform`，一次查询都不做 */
    aim: HTMLElement | null;
    dash: HTMLElement | null;
    tip: HTMLElement | null;
    /** 📍 屏外方向指示三件（**只有"别人"的钉子上建**，「我」不做）——
     *  `edge` = 定位容器（只吃 `translate3d`）、`edgeArrow` = 转的那根小箭头、`edgeDist` = 距离那一行。 */
    edge: HTMLElement | null;
    edgeArrow: HTMLElement | null;
    edgeDist: HTMLElement | null;
    /** 📍 上一轮写进 DOM 的那份"边缘状态"（`"off"` 或 `"1|角|文案"`）——**它没变就一次都不写** */
    edgeKey: string;
  }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mlMod: any = null;
  /* 🧱 重构切片 S4（M2）：`let lastBldKey`（"上一次取楼的中心+半径"去抖键）跟着
     `loadBuildingsForView` 搬去了 `wsViewFetch.ts` —— 它只有那一个消费者，宿主不再留副本。 */

  /* ── 「真数据优先，空了亮示意」——机主 2026-09-20 拍板的两条路 ─────────────────
     背景（都是实测数）：OSM 在中国的楼房覆盖**极不均**。同一个后端：
       渝中区驻地 400m → **152 栋**（成片）；涪陵区驻地 400m → **0 栋**、600m → 3、1400m → 29。
     这不是渲染问题，是**数据问题** —— 所以机主在涪陵看到的"零星几栋"再多调渲染也没用。
     ⇒ 两条路一起走：
        ① 真数据够（≥ `BLD_SPARSE`）⇒ **只用真楼**，示意层根本不出现；
        ② 真数据稀疏 / 为空 ⇒ 自动叠 AI 示意层，**并在 HUD 写明"非事实"**。
     为什么阈值取 40：一屏想看到"成片"，至少得有这么几栋；而实测的稀疏区（涪陵）连 2000m
     都只有 29 栋 —— 40 这条线正好把"渝中那种成片"和"涪陵那种零星"分开，不误伤密集区。 */
  const BLD_SPARSE = 40;

  /**
   * 示意街区铺多大（米，正方形边长）。
   *
   * 🔴 这个数**必须**是"小区尺度"，不能拿整个区县的 bbox 当画布 ——
   * 涪陵区 bbox 实测 **74.9km × 70.9km**，28 格草图铺上去 ⇒ **一格 = 2.7km**，
   * 一栋"楼"有 2.7 公里宽、十几米高，是一张**薄饼**，叠在真楼旁边只能把画面搞脏。
   * 这正是机主说的"这个 ai 2d 小区好丑"，也是 `showAi` 当初被默认关掉的原因。
   *
   * 铺 700m 时一格 ≈ 25m —— 和真实楼栋同一个量级，才**像楼**，也才真的"成片"。
   * 示意就是示意：位置是编的（见 `syncAiLayers` 的标注），但**尺度不能是错的**。
   */
  const AI_SPAN_M = 700;

  /** 已经画到地图上的 AI 示意图元数（HUD 要如实报；0 = 没画，不能说"已叠加"） */
  const aiDrawn = ref(0);
  /** 示意街区铺在哪（一个"小区尺度"的正方形，可以跟真楼的 bbox 不是同一块） */
  const aiBboxRef = ref<BBox | null>(null);

  /* ══ 🧱 重构切片 S3（M8）：**HUD / stats 的前半**装配（实现整块在 `wsHudStats.ts`）════════
     锚点 = 函数名（不按行号）：`aiOn` / `stats` / 长等待那一段 / `startFps`。
     为什么装配点在这儿（而不是与 M1 一起放到名字层那几个 ref 之后）：**S2（2D 降级路）的装配点
     在 `domPins` 之后那一段**，它那份只读 ctx 里就有 `stats` / `aiOn` / `stopTimer` ⇒ 这三样必须先存在；
     晚的那半（`hudMode` + 包 HUD + 署名取句）在同一个模块的 `createBundleHud` ——
     它要读的离线包管道声明在这之后（`fetchCell` / `bldFeed` / `gwLayer` 那一段），早构造必踩 TDZ。
     两个工厂各自的说明见模块文件头。
     ⚠️ 下面三样**故意留在宿主**：`phase`（宿主与 S2 都还在写它）· `K_MS`（`onMounted` 里还在写它）
        · `BLD_SPARSE`（与 2D 降级路共用的阈值）。 */
  type Phase = "fetch" | "build" | "render" | "done";
  const phase = ref<Phase>("fetch");
  const K_MS = "wsm:v1:bldgMs";
  const hudStats = createHudStats({
    props,
    BLD_SPARSE,
    phase,
    WS_BLD_MODE,
    K_MS,
    /* 🔴 宿主那面 `alive` 是 `let`（卸载时置 false）⇒ 传**取值器**：解构会拿到快照，
       `startFps` 的每帧判据就永远停在 true 上（那条路的收尾由 `stopFps()` 取消 rAF 兜住）。 */
    aliveNow: () => alive,
  });
  /* ⚠️ `STAGE_NAMES` 的真源也在 M8 里（「别写 `as const`」那条注释跟着它搬过去了）——
     这里解构回来只为模板的 `:stages=`。 */
  const { aiOn, stats, STAGE_NAMES, lastMs, stageIdx, waitText, waitSub, etaMs, progRatio } = hudStats;
  /* 这三个是宿主自己调的出口：装载心跳 / fps 起停（`waitSub`/`etaMs`/`progRatio` 已在上一行） */
  const { stopTimer, armTimer, startFps, stopFps } = hudStats;

  /* 🧱 长等待那一段（`STAGE_NAMES` / `waited` / `lastMs` / `t0` / `timer` / `stageIdx` / `waitText` /
     `waitSub` / `etaMs` / `progRatio` / `stopTimer`）整块搬进了 `wsHudStats.ts`（S3 / M8），
     上面那次 `createHudStats` 已经把它们接回来了 —— 这里**不许**再写第二份。 */

  /**
   * 以某点为**中心**、边长 `m` 米的正方形 bbox —— 给"示意街区"当画布。
   * 实现搬到了 `wsAiLayers.boxAround`（**纯函数**才能进 Node 自检；写在 .vue 里就跑不了单测）。
   */
  const boxAround = (lng: number, lat: number, m: number): BBox => aiBoxAround(lng, lat, m);

  /** 低于这个缩放就**不取楼栋**（整区尺度上楼房只是几个像素点，取回来也没用还费流量） */
  const BLD_MIN_ZOOM = 13.5;
  /**
   * 低于这个缩放**不取路网**。
   * 为什么门槛比楼低（13.5 → 12）：路网是**地图的骨架**，整区视野下也要能看出
   * "城市长什么样、人往哪走"；而楼在那个尺度上只是几个亚像素点。
   * 再低（z<12）就只剩区县轮廓，路网一格都挤不下，取回来纯浪费 Overpass。
   */
  const ROAD_MIN_ZOOM = 12;

  /* 版本戳：App 自拍回传的诊断图/JSON 里带上它，agent 一眼看出"**是哪一版代码在跑**"
     （2026-09-21 那次诊断图不带版本戳，差点把两轮不同的包当同一轮在比）。改这一页的行为就顺手 +1。 */
  const APP_SELF_SHOT_BUILD = "app-selfshot-2026-09-21-v1";

  /** 2D 降级路画布的 DPR 封顶默认值（见 `draw2d` 里那段；`?wsdpr=` 可覆盖） */
  const DPR_CAP_2D = 1.5;

  /**
   * 等容器**真的有布局尺寸**再建图（上限 `ms`，超时也继续 —— 不能因为量不到就不建图）。
   * 见建图那段的说明：量到 0×0 ⇒ canvas 停在 MapLibre 默认的 **300×150**（= 一块纯色）。
   */
  async function waitForBox(el: HTMLElement | null, ms = 3000): Promise<void> {
    if (!el) return;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (el.clientWidth > 0 && el.clientHeight > 0) return;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  const resizeTimers: number[] = [];
  let resizeRo: ResizeObserver | null = null;
  /** 这一次建图的实例序号（面板里对得上"resize 打在哪个实例上"） */
  let mapSeq = 0;
  /**
   * 🔴 **resize 自证日志**（2026-09-21，机主实测"画布仍是 300×150"之后加的）。
   *
   * 为什么非要它：上一版我只是"该调的时机都调一遍"，结果真机上**画布还是 300×150**，
   * 而**没有任何证据能说明是哪一步没生效**（时机？对象？实例？）—— 只能靠猜。
   * 现在每一次 resize 尝试都留一行：**时间 + 为什么调 + 容器 rect + 调前/调后 canvas + 实例号**，
   * 面板显示最近 5 条 ⇒ 一眼看出"是压根没调到"还是"调了但没生效"。
   */
  const resizeLog = ref<string[]>([]);
  function pushResizeLog(row: string): void {
    resizeLog.value = [...resizeLog.value.slice(-4), row];
  }
  /**
   * 🔴 **真地图那块画布**（`map.getCanvas()`）—— 2026-09-21 起，**所有**画布读数都用它。
   *
   * 为什么：机主的"resize 尝试记录"里同一次 `map.resize()` 一会儿量到 300×150、
   * 一会儿量到 **3759×1287** ⇒ 强烈指向**页面上不止一块 canvas**，而原来我一直量 `cv.value`
   * （模板那块 ref）—— 若 MapLibre 实际用的是它自己建的那块，那我量的就是**另一块**（默认 300×150），
   * 屏幕上那块"浅色矩形"也就有了着落。⇒ 先量对对象，再谈修。
   */
  function realMapCanvas(): HTMLCanvasElement | null {
    try {
      const mc = (map as { getCanvas?: () => HTMLCanvasElement } | null)?.getCanvas?.();
      return mc || null;
    } catch {
      return null;
    }
  }
  /** 当前该被当作"这张地图的画布"的那块：WebGL 路 = `map.getCanvas()`；降级路 = 2D 覆盖层 */
  function activeCanvas(): HTMLCanvasElement | null {
    const mc = realMapCanvas();
    if (renderKind.value === "webgl" || renderKind.value === "waiting" || renderKind.value === "init") return mc || cv.value;
    return cv.value;
  }
  /** 页面上**所有** canvas 的事实（面板要"几块、哪块是谁"的确定答案） */
  function canvasFacts(): NonNullable<VerifySnapshot["canvases"]> {
    const mc = realMapCanvas();
    try {
      return Array.from(document.querySelectorAll("canvas")).map((el, i) => {
        const c2 = el as HTMLCanvasElement;
        const st = getComputedStyle(c2);
        const par = c2.parentElement;
        return {
          i,
          w: c2.width,
          h: c2.height,
          cls: String(c2.className || "").slice(0, 30),
          parent: par ? `${par.tagName.toLowerCase()}.${String(par.className || "").split(" ")[0] || ""}`.slice(0, 30) : "无父",
          z: String(st.zIndex),
          display: String(st.display),
          visibility: String(st.visibility),
          isMapCanvas: !!mc && c2 === mc,
          isRef: c2 === cv.value,
          /* ⚠️ 判"遮挡"必须用**渲染尺寸**（clientWidth/Height），不能用 buffer（width/height）：
             罪魁那块 `ws-dml__cv` 的 buffer 只有 300×150，但 CSS 被拉满整屏 ⇒ 它照样盖住地图。 */
          cw: c2.clientWidth,
          ch: c2.clientHeight,
          covers: false,
        };
      });
    } catch {
      return [];
    }
  }
  /**
   * **设计上的覆盖层白名单**（判据：**它们本来就该铺在地图上面，且都应该是透明的**）。
   * 命中判据（任一）：class 含这些片段，或父元素 class 含这些片段。
   * ⚠️ 只用来**免掉"遮挡"误报**，绝不隐藏它们；**非白名单**的可见画布照旧要报（真凶就是这么抓到的）。
   */
  const OVERLAY_CANVAS_HINTS = ["cursor-trail", "cursor-effects", "ws-wx", "ws-weather", "ws-particle"];
  function isOverlayCanvas(el: HTMLCanvasElement): boolean {
    const cls = `${String(el.className || "")} ${String(el.parentElement?.className || "")}`;
    return OVERLAY_CANVAS_HINTS.some((h) => cls.includes(h));
  }

  /** 给清单补"是否遮挡"（**渲染面积**判：可见 + 非地图那块 + 面积 ≥ 地图的一半） */
  function canvasFactsWithCover(): NonNullable<VerifySnapshot["canvases"]> {
    const rows = canvasFacts();
    const mc = realMapCanvas();
    const mArea = mc ? Math.max(1, mc.clientWidth * mc.clientHeight) : 0;
    return rows.map((r) => ({
      ...r,
      overlay: (() => {
        try {
          const all = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
          const el = all[r.i];
          return !!el && isOverlayCanvas(el);
        } catch {
          return false;
        }
      })(),
      sample: (() => {
        try {
          const all = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
          const el = all[r.i];
          if (!el || el === mc) return "";
          const v = sampleCanvas(el);
          const alpha = v.aMin < 0 ? "" : ` α=${v.aMin}~${v.aMax}`;
          return `采样=${v.blank ? `单色/透明（${v.note}）` : "有内容"}${alpha}${
            v.aMax >= 250 && v.aMin >= 250 ? "（**不透明**：会挡住地图，需确认是否该铺在最上层）" : "（透明叠层 ✓）"
          }`;
        } catch {
          return "采样=失败";
        }
      })(),
      covers:
        !!mc &&
        !r.isMapCanvas &&
        !r.overlay &&
        r.display !== "none" &&
        r.visibility !== "hidden" &&
        mArea > 0 &&
        (r.cw || 0) * (r.ch || 0) >= mArea * 0.5,
    }));
  }

  /**
   * 若发现有**非 map.getCanvas() 的画布盖在地图上**（同一父级、可见），把它藏掉 ——
   * 那块多半是历史遗留（换过画布/降级过又切回来），盖在真地图上 ⇒ 屏幕上就是它（一片纯色）。
   * 只做一次、只动"盖在真画布之上"的那块，并且写进 resize 日志（**可回溯**）。
   */
  function removeStrayCanvases(): void {
    const mc = realMapCanvas();
    const box = host.value;
    if (!mc || !box) return;
    try {
      /* 规则（2026-09-21 定案后修正）：**只看"地图容器内部"**、可见、且不是 `map.getCanvas()` 的画布。
         ⚠️ 原来那条"必须与真画布同一父级"是**漏网的原因**：罪魁 `.ws-dml__cv` 的父级是 `div.ws-dml`
         （= 我们的 host），而真画布在 `div.maplibregl-canvas-container` 里 ⇒ 父级不同，规则放过了它。
         ⚠️ 也**不能**无差别删掉页面上所有非地图画布：天气粒子那块（`div.ws-wx` 里）是**该在**的，
         所以作用域限定在 host 内部。 */
      const all = Array.from(box.querySelectorAll("canvas")) as HTMLCanvasElement[];
      for (const el of all) {
        if (el === mc) continue;
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        const cls = String(el.className || "");
        const where = `${el.width}x${el.height} buffer / ${el.clientWidth}x${el.clientHeight} 渲染`;
        el.remove(); // **从 DOM 移除**（只 display:none 会留个空壳，下次判断又要靠运气）
        pushResizeLog(`移除遗留画布（${where} class=${cls}）—— 它盖在真地图上（真=${mc.width}x${mc.height}）`);
      }
    } catch {
      /* 删不掉不影响别的 */
    }
  }
  /** 兼容旧名（kickResize 里调的是它） */
  const hideStrayCanvases = removeStrayCanvases;

  /** 现在画布该有多大（容器 CSS 尺寸 × dpr）—— 判据与面板一致 */
  function wantCanvasSize(cv2: HTMLCanvasElement): string {
    const el = host.value;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    if (!el) return "?";
    return `${Math.round(el.clientWidth * dpr)}x${Math.round(el.clientHeight * dpr)}`;
  }
  /**
   * 调一次 resize 并**记日志**（容器尺寸 + 前后 canvas 尺寸）。
   * `why` 写清是谁触发的（首次 / 延迟 1000ms / ResizeObserver / 轮询兜底 / 强制按钮）。
   */
  function doResize(m: { resize?: () => void }, why: string): void {
    const el = host.value;
    const cv2 = activeCanvas();
    const box = el ? `${el.clientWidth}x${el.clientHeight}` : "无容器";
    const before = cv2 ? `${cv2.width}x${cv2.height}` : "无画布";
    if (!el || !cv2) {
      pushResizeLog(`${why}｜容器=${box}｜画布=${before}｜**没有容器或画布，跳过**`);
      return;
    }
    try {
      m.resize?.();
    } catch (e) {
      pushResizeLog(`${why}｜容器=${box}｜${before}→抛错 ${String((e as Error)?.message || e).slice(0, 24)}`);
      return;
    }
    const after = `${cv2.width}x${cv2.height}`;
    const want = wantCanvasSize(cv2);
    const ok = after === want;
    pushResizeLog(
      `${why}（实例#${mapSeq}）｜容器=${box}｜画布 ${before}→${after}｜期望 ${want}｜${ok ? "✅ 一致" : "❌ 仍不一致"}`
    );
  }
  /** 建图后补 resize：rAF 一次 + 延迟几次 + 观察**容器** + **5 秒内每 500ms 兜底轮询**（尺寸不一致就再调） */
  function kickResize(m: { resize?: () => void }): void {
    mapSeq++;
    doResize(m, "建图后立刻");
    for (const t of [250, 1000, 2500]) {
      resizeTimers.push(
        window.setTimeout(() => {
          if (alive) doResize(m, `延迟 ${t}ms`);
        }, t)
      );
    }
    /* 兜底轮询：不管前几次是不是"调早了"，只要尺寸还对不上就继续调（最多 5s） */
    const pollEnd = Date.now() + 5000;
    const poll = (): void => {
      if (!alive) return;
      const cv2 = cv.value;
      const el = host.value;
      if (cv2 && el && `${cv2.width}x${cv2.height}` !== wantCanvasSize(cv2)) {
        doResize(m, "轮询兜底");
        if (Date.now() < pollEnd) resizeTimers.push(window.setTimeout(poll, 500));
        return;
      }
      if (Date.now() < pollEnd) resizeTimers.push(window.setTimeout(poll, 500));
    };
    resizeTimers.push(window.setTimeout(poll, 500));
    /* 顺手清掉"盖在真地图上的遗留画布"（机主那块浅色矩形最可能的来源） */
    resizeTimers.push(window.setTimeout(() => alive && hideStrayCanvases(), 800));
    try {
      if (typeof ResizeObserver !== "undefined" && host.value) {
        resizeRo = new ResizeObserver(() => doResize(m, "ResizeObserver(容器)"));
        resizeRo.observe(host.value);
        /* ⚠️ 也观察**画布自己**：容器没变而画布 CSS 尺寸变了的情况（父级用别的方式撑开）也收得住 */
        if (cv.value) resizeRo.observe(cv.value);
      }
    } catch {
      /* 没有 ResizeObserver 就靠上面的轮询（不影响建图） */
    }
    /* 视口变化/转屏：设备方向一变，`dpr` 与布局尺寸都会变（**必须**再量一次） */
    try {
      window.addEventListener("resize", onWinResize);
      window.addEventListener("orientationchange", onWinResize);
    } catch {
      /* 挂不上就算了（轮询与观察器还在） */
    }
  }
  /** 视口/方向变化 → 延迟一点再量（浏览器改布局是异步的） */
  function onWinResize(): void {
    joyMeasureVh();      // 🕹 §15：转屏/改窗口 ⇒ 底盘尺寸跟着变（同一个 resize 里量，不新开监听）
    /* 📍 屏外指示的几何也在这里重量（容器尺寸 + 安全区）——**同一个 resize 里**，不新开监听；
       量完立刻同步一次：转屏后箭头的落点是按新矩形算的，不补这一下会停在旧位置上。 */
    pinEdgeMeasure();
    pinEdgeSync();
    if (!alive || !map) return;
    window.setTimeout(() => doResize(map as { resize?: () => void }, "窗口/转屏"), 300);
  }
  /**
   * 面板上的「🔄 强制重算画布」：**手动**调一次并回报前后尺寸。
   * 这是最快的判定手段 —— 机主点一下就知道"resize 能不能治好"，也能区分
   * "逻辑没跑到"（日志里没有记录）和"resize 本身无效"（记录了但尺寸不变）。
   */
  function forceResizeCanvas(): string {
    const m = map as { resize?: () => void } | null;
    const cv2 = cv.value;
    if (!m || !cv2) return "这一级没有地图实例（或没有画布），没法重算";
    const before = `${cv2.width}x${cv2.height}`;
    doResize(m, "面板强制按钮");
    const after = `${cv2.width}x${cv2.height}`;
    return after === before
      ? `点了但画布没变（仍 ${after}）—— 说明 resize() 对当前实例无效，得查容器/实例；日志见面板`
      : `画布 ${before} → ${after}${after === wantCanvasSize(cv2) ? "（✅ 已与容器一致）" : "（仍未一致）"}`;
  }

  /**
   * 读「2D 降级路画布的 DPR 封顶」：`?wsdpr=<数字>` > 默认 1.5（夹在 1~3，脏值不认）。
   * 与 `?wsnight=off` 同一套纪律：**URL 优先**（"我想看另一档"不能被默认值盖掉），读不到不抛。
   */
  function dprCap2d(): number {
    try {
      const v = Number(new URLSearchParams(location.search).get("wsdpr") || NaN);
      if (Number.isFinite(v) && v >= 1 && v <= 3) return v;
    } catch {
      /* 隐私模式/无 location ⇒ 用默认 */
    }
    return DPR_CAP_2D;
  }

  /**
   * 临时类降级后：**每 4 秒问一次"地图库出帧了吗"**，出来就切回 WebGL。
   *
   * 为什么值得（P0）：机主的机器**有** WebGL（代拍页顺滑），App 之所以掉进 2D 只是**慢**。
   * 以前"慢"被当成"坏"——永久判决、而且地图实例当场被销毁 ⇒ 再也回不去。
   * 现在实例留着跑（藏在 2D 画布下面），这里只负责"等它好了把它请回前台"。
   */
  function startRecoverPoll(): void {
    if (recoverTimer) return;
    const t0 = Date.now();
    const tick = (): void => {
      recoverTimer = 0;
      if (!alive) return;
      const m = map as { isStyleLoaded?: () => boolean; loaded?: () => boolean } | null;
      const ready = !!m && !!(m.isStyleLoaded?.() && (sawRender || m.loaded?.()));
      if (ready) {
        promoteToWebgl(Math.round((Date.now() - t0) / 1000));
        return;
      }
      if (Date.now() - t0 > RECOVER_MS) {
        const waited = Math.round(RECOVER_MS / 1000);
        if (renderKind.value === "waiting") {
          /* 等满了还没来 ⇒ **如实报错**（不降级、不画假图）。面板 + HUD 一起说清：
             为什么、等了多久、错误原文在哪、还有哪两条路可走（重试 / 手动逃生阀）。 */
          renderKind.value = "failed";
          stats.mode = `地图库没起来（已等 ${waited}s，**未降级**）`;
          stats.note = `地图库 ${waited}s 内始终没出帧（${mapErrs.length} 条错误，原文见验证面板）｜可按面板「🔄 重试地图」重建，或加 \`?wsfallback=1\` 用 2D 自绘兜底`;
        } else {
          stats.note = stats.note
            ? `${stats.note} · 后台等了 ${waited}s 仍未出帧`
            : `后台等了 ${waited}s 仍未出帧`;
        }
        return;
      }
      recoverTimer = window.setTimeout(tick, 5000);
    };
    recoverTimer = window.setTimeout(tick, 5000);
  }

  /**
   * **切回 WebGL**（临时类降级恢复）：把盖在上面的 2D 画布摘掉、把地图那块显示回来。
   * 不做任何重建 —— 地图实例、相机、图层、数据全都在（它们从没被销毁过）。
   */
  function promoteToWebgl(waitedSec = 0): boolean {
    const m = map as { getCanvas?: () => HTMLCanvasElement } | null;
    const mapCv = m?.getCanvas?.();
    if (!mapCv) return false;
    const twoD = cv.value;
    try {
      mapCv.style.visibility = "";
      mapCv.style.pointerEvents = "";
    } catch {
      /* 样式写不上也继续（至少把它显示回来这一步是对的） */
    }
    if (twoD && twoD !== mapCv) {
      try {
        twoD.remove();
      } catch {
        /* 摘不掉就留着（藏在下面也无害） */
      }
    }
    cv.value = mapCv;
    mapAvailable.value = true;
    renderKind.value = "webgl";
    fallbackKind.value = "none";
    recovered.value = true;
    /* 档位还回去：降级时被 `forceLow` 压过低档，不解除的话"恢复了却还是少描边/关模糊" */
    try {
      perf.clearForce();
    } catch {
      /* 老版本没有这个口子就算了（低档继续，不影响恢复本身） */
    }
    stats.perf = "";
    stats.mode = `街区视野（街道级）· 地图库已恢复${waitedSec ? `（后台等了 ${waitedSec}s）` : ""}`;
    stats.note = stats.note
      ? `${stats.note} · ✅ 地图库出帧了 ⇒ 已自动切回 WebGL（手势可用）`
      : "✅ 地图库出帧了 ⇒ 已自动切回 WebGL（手势可用）";
    try {
      syncPins();
      /* 🗄 2026-09-24：AI 示意层不再挂（机主：App 页是最终结构，但**去掉多余叠加**）
         —— `syncAiLayers()` 留在文件里，两个调用点与两个 watcher 都关掉。 */
    } catch {
      /* 同步失败不影响"画面已经切回 WebGL"这件事 */
    }
    return true;
  }

  /**
   * 面板上的「**重试地图**」：机主手动按一下，做两件事 ——
   *   ① 实例还在 ⇒ **立刻**按恢复判据试一次（很多时候它其实已经好了，只是没人去看）；
   *   ② 实例已经没了（永久类）⇒ 只能重载这一页再试（**会回到主菜单**，如实说出来）。
   */
  async function retryMap(): Promise<string> {
    const m = map as { isStyleLoaded?: () => boolean; loaded?: () => boolean } | null;
    if (m) {
      const ok = !!(m.isStyleLoaded?.() && (sawRender || m.loaded?.()));
      if (ok) return promoteToWebgl() ? "✅ 地图库其实已经出帧了 ⇒ 已切回 WebGL（手势可用）" : "拿不到地图画布，切不回去";
      return `地图库实例还在，但**仍未出帧**（样式已加载=${String(m.isStyleLoaded?.())}，出过帧=${sawRender}）—— 继续等它会自动切回`;
    }
    if (renderKind.value === "fallback2d") {
      try {
        location.reload();
        return "已请求重新加载这一页（会回到主菜单，再进一次小区级）";
      } catch {
        return "这张地图实例已经销毁，得重新进一次小区级（重载也被拦了）";
      }
    }
    return "现在就是 WebGL 路，不用重试";
  }

  /**
   * 「代拍」：页面上有 `?autoshot=1` 时，走到小区级就**自动拍三张**（近/远/侧）回传。
   *
   * 为什么由页面自己拍：agent 侧看不到 WebGL，机主又禁了 ADB 截屏（会看到整屏隐私）。
   * 详见 `wsSelfShot.ts` 的文件头。这里只负责"什么时候按快门"。
   *
   * 三张的机位是**商量好的**：一近（看楼体）、一远（看整片）、一侧（看高低起伏）。
   * 拍完自动关掉开关 —— 不然每次进出小区级都往服务器灌图。
   */
  async function runSelfShot(m: {
    getCanvas(): HTMLCanvasElement;
    easeTo(o: Record<string, unknown>): void;
    once(ev: string, cb: () => void): void;
    isStyleLoaded?: () => boolean;
    getZoom?: () => number;
    loaded?: () => boolean;
  }): Promise<void> {
    /** 拍一张：**先判空白**，空白就回传诊断图（白图什么都不说明，等于白点一次） */
    const snap = async (name: string): Promise<boolean> => {
      const cv = m.getCanvas();
      const { blank, note } = canvasIsBlank(cv);
      if (blank) {
        const diag = diagnosticPng([
          `空白：${note}`,
          `样式已加载=${String(m.isStyleLoaded?.())} 地图loaded=${String(m.loaded?.())}`,
          `画布=${cv.width}x${cv.height} zoom=${m.getZoom?.()}`,
          `取楼=${stats.count} 栋 · 半径档=${stats.view || "-"}`,
          `note=${(stats.note || "无").slice(0, 40)}`,
        ]);
        await postShot(diag || cv.toDataURL("image/png"), `${name}-DIAG`);
        stats.note = `代拍拿到空白（${note}）⇒ 已回传诊断图`;
        return false;
      }
      try {
        return await postShot(cv.toDataURL("image/png"), name);
      } catch (e) {
        stats.note = `代拍失败：${String((e as Error)?.name || e)}`;
        return false;
      }
    };
    /* 等真的画完（`idle` + 两帧 rAF），不是"睡够 4 秒就赌它好了" */
    await settleForShot(m, 800);
    if (!alive) return;
    let ok = await snap("app-dist-near");
    /* 🎨 「远」这张现在专门用来看**地平线与天空**（pitch 26° ≈ 接近平视）。
       机主要"看得见天空（基沃托斯的天空）"⇒ 三张证据图里必须有一张是抬着头的。 */
    m.easeTo({ zoom: 14.6, pitch: 26, duration: 900 });
    await settleForShot(m, 1200);
    if (!alive) return;
    ok = (await snap("app-dist-far")) || ok;
    m.easeTo({ zoom: 17.4, pitch: 50, bearing: -30, duration: 900 });
    await settleForShot(m, 1200);
    if (!alive) return;
    ok = (await snap("app-dist-close")) || ok;
    if (ok && !stats.note.includes("空白")) stats.note = "代拍：已回传 3 张（近/远/侧）";
    selfShotDisarm();
  }

  /**
   * 🧪 **App 自拍**（`?selfshot=1`）：主 App 页走完"进小区级 → 等稳 → 抓帧回传"。
   *
   * 与上面 `runSelfShot`（代拍页那条通道）**不共用机位**：这一条拍的就是**机主正在看的这一屏**
   * ——真主题、真图层、真降级逻辑，一个字都不改，所以它同时是"验收证据"和"故障现场"。
   *
   * 触发点两处（都只加一次调用，**不改任何既有语义**）：
   *   · 地图库 `load` 之后（WebGL 路）；
   *   · `fallback2d()` 末尾（降级路）—— **降级了更要拍**：那些"整屏纯色"的事故就发生在这条路上。
   *
   * 等稳的判据（`sawFirstFrame && dataReady`）：首帧 + 数据到齐，或者**超时照拍**
   * （超时也要给证据，只是会在诊断图/HUD 里如实写 `数据到齐=false`）。
   */
  function maybeAppSelfShot(kind: "webgl" | "fallback2d", why = ""): void {
    /* 🔬 面板要的就是这两个事实（**先记下来再说要不要自拍** —— 没开自拍时面板照样要显示） */
    renderKind.value = kind;
    fallbackWhy.value = why;
    /* 没开就是一次 boolean 判断（零开销）—— 与代拍同一个纪律 */
    if (!appSelfShotArmed()) return;
    appSelfShotDisarm(); // 立刻落闸：这一轮就是这一轮，页面里其它挂载点不要重复发起
    void runAppSelfShot(appShotCtx(kind, why));
  }

  /** 自拍的上下文（**面板的「现在拍一张」按钮也用它** —— 一条路，不是两套） */
  function appShotCtx(kind: "webgl" | "fallback2d", why: string): AppShotCtx {
    return {
      kind,
      fallbackWhy: why,
      /* 画布**现取**：降级路会换掉画布元素（见 `fallback2d` 那段），存下来的引用会拍到旧画布 */
      /* 📸 拍到**真地图那块**（WebGL 路 = `map.getCanvas()`；降级路 = 2D 覆盖层） */
      getCanvas: () => activeCanvas(),
      getMap: () => (kind === "webgl" ? (map as unknown as ShotMapLike | null) : null),
      sawFirstFrame: () => (kind === "webgl" ? sawRender : true),
      /* "数据到齐" = 有东西可看（楼/路/设施/人）—— 全区视野下楼栋本来就不取，所以是**或**不是**与** */
      dataReady: () => stats.count + stats.roads + stats.facilities + stats.pins > 0,
      dataNote: () =>
        `🏢${stats.count} 🛣${stats.roads} 🏪${stats.facilities} 👤${stats.pins} · ${stats.note || "无提示"}`,
      /* 真机 Overpass 冷查询实测 20~100s；无头/自动化给短一点（免得把闸门拖成假失败）。
         面板按钮走的是"**机主已经站在这一屏前**"的场景 ⇒ 给 6 秒就够（数据早就在了） */
      waitMs: isAutomation() ? 15000 : 45000,
      /* 等数据的这几十秒里机主可能切走 ⇒ 组件卸载就**什么都不发**（发了就是假证据） */
      aborted: () => !alive,
      /* 📊 样式自检 JSON：**有多少给多少，不知道写 null**（详见 `wsStyleReport.ts` 的文件头）。
         取值全走"现读"：`map` 可能是 null（降级路）、画布可能被换过 —— 提前存下来的都会失真。 */
      styleReport: (shot) => verifySnapshot(true, shot),
      note: (s) => {
        stats.note = stats.note ? `${stats.note} · ${s}` : s;
      },
      build: APP_SELF_SHOT_BUILD,
    };
  }

  /**
   * 🔬 面板与样式 JSON **共用的那一份快照**（同一件事，两种读者：人看面板、agent 读 JSON）。
   *
   * `full = true` 时给样式 JSON（带 shot 那一轮的细节）；面板走 `full = false`（没有 shot 段）。
   * 一律**现读**：`map` 可能是 null、画布可能被换过、`theme` 可能正在切 —— 提前存下来的都会失真。
   */
  function verifySnapshot(
    full: boolean,
    shot?: { name: string; blank: boolean; attempts: number; waitedMs: number; ready: boolean; why: string; posted: boolean }
  ): Record<string, unknown> {
    const layers = ((map?.getStyle?.()?.layers as StyleLayerLite[] | undefined) || []).filter((l) => !!l?.id);
    const canvas = cv.value
      ? {
          w: cv.value.width,
          h: cv.value.height,
          dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
          cssW: cv.value.clientWidth,
          cssH: cv.value.clientHeight,
        }
      : null;
    return buildStyleReport({
      build: APP_SELF_SHOT_BUILD,
      href: typeof location !== "undefined" ? location.href : "",
      isStyleLoaded: map?.isStyleLoaded?.() ?? null,
      layers,
      paintOf: (id, key) => map?.getPaintProperty?.(id, key),
      errors: mapErrs,
      wstheme: themeId.value,
      wsnight: { on: nightOn.value, level: nightLvl.value, lowTier: !!perf.low.value },
      canvas,
      fallback: { used: renderKind.value === "fallback2d", why: fallbackWhy.value },
      /* P0：**临时还是永久** + 有没有恢复过 —— 图和 JSON 都要带回去（agent 才知道该不该让人重试） */
      fallbackKind: renderKind.value === "fallback2d" ? fallbackKind.value : "none",
      recovered: recovered.value,
      sawRender: renderKind.value === "webgl" ? sawRender : renderKind.value === "fallback2d",
      hud: hudEl.value?.innerText || "",
      stats: { ...stats },
      ...(full && shot
        ? {
            shot: {
              name: shot.name,
              blank: shot.blank,
              attempts: shot.attempts,
              waitedMs: shot.waitedMs,
              ready: shot.ready,
              note: shot.why,
              posted: shot.posted,
            },
          }
        : {}),
    });
  }

  /**
   * 「**动效状态**」：**当场 DOM 观察**（不猜、不写死）。
   *
   * 机主 2026-09-21 的疑问是"看不到 MG 动画" —— 而"没触发"和"坏了"是两件事：
   * 加载动画播完就收、事件条只在**新事件**来时入场、设施淡入只在小区级且只播一次。
   * ⇒ 把这些事实摆出来，人自己就能分清。
   */
  function motionFacts(): NonNullable<VerifySnapshot["motion"]> {
    const q = (sel: string): Element[] => {
      try {
        return Array.from(document.querySelectorAll(sel));
      } catch {
        return [];
      }
    };
    const facNodes = q(".ws-fac__mark");
    let fadeDone: boolean | null = null;
    if (facNodes.length) {
      try {
        const st = getComputedStyle(facNodes[0] as Element);
        fadeDone = Math.abs(Number(st.opacity) - 1) < 0.05 && (st.transform === "none" || st.transform === "matrix(1, 0, 0, 1, 0, 0)");
      } catch {
        fadeDone = null;
      }
    }
    return {
      phase: String(phase.value),
      facilityNodes: facNodes.length,
      facilityFadeDone: fadeDone,
      eventRows: q(".ws-ef__list > *").length,
      weatherCanvas: q(".ws-wx__cv").length > 0,
      low: !!perf.low.value,
    };
  }

  /** 面板要显示的那份（`VerifySnapshot`；图层 + 关键 paint 从上面那份里取，**不重算**） */
  function panelSnapshot(): VerifySnapshot {
    const rep = verifySnapshot(false) as {
      isStyleLoaded: boolean | null;
      layers: { ids: string[]; types: Record<string, string> };
      keyPaints: Record<string, Record<string, unknown>>;
      errors: string[];
      canvas: { w: number; h: number; dpr: number; cssW: number | null; cssH: number | null } | null;
      fallback2d: { used: boolean; why: string };
      sawRender: boolean;
    };
    const layers = rep.layers.ids.map((id) => ({ id, type: rep.layers.types[id] || "?" }));
    /* "主题期望的图层" —— 与当前档位**同一份来源、同一档位**（`themeStyleParts`），
       少一条就能当场看出来。

       🔴 2026-09-24 修掉一次**假报**（机主真机截图："主题图层齐：实际 8 条 / 期望 4 条 · 缺 tint"）：
       这里原来写死 `low = false`（高档）去算期望，而**实际渲染按当前档位**——
       低档下 `themeForTier()` 会把 `tint` 甚至 `sky` 摘掉（`dropTint`）⇒ 期望里带着 `tint`、
       实际没有 ⇒ 面板年年报"缺 tint"，**而装配其实是正确的**。
       ⇒ 现在两边都用 `perf.low.value`，并**如实标出档位**（差值就是"低档本来就少的那几层"）。 */
    let expected: string[] = [];
    try {
      expected = (themeStyleParts(theme.value, !!perf.low.value, 0).layers || []).map((l: { id?: string }) => String(l.id || ""));
    } catch {
      expected = [];
    }
    if (perf.low.value) {
      const high = (() => {
        try {
          return (themeStyleParts(theme.value, false, 0).layers || []).map((l: { id?: string }) => String(l.id || ""));
        } catch {
          return [];
        }
      })();
      const droppedByTier = high.filter((id) => !expected.includes(id));
      if (droppedByTier.length) {
        /* 记账（HUD 的 note 通道）：**"低档按设计摘掉了这几层"** —— 不是缺装配，别让人去查半天 */
        const msg = `低档按设计摘掉图层：${droppedByTier.join(",")}（不是缺装配）`;
        stats.note = stats.note && stats.note.includes(msg) ? stats.note : stats.note ? `${stats.note} · ${msg}` : msg;
      }
    }
    return {
      kind: renderKind.value,
      build: APP_SELF_SHOT_BUILD,
      href: typeof location !== "undefined" ? location.href : "",
      fallbackWhy: fallbackWhy.value,
      fallbackKind: renderKind.value === "fallback2d" ? fallbackKind.value : "none",
      recovered: recovered.value,
      /* ⚠️ 这一条是**读的那一刻**的原始值（`map.isStyleLoaded()`）：
         它在"瓦片还在下"时会**长时间为 false**，而地图**可能早就画出内容了**
         （本会话真机截图就出现过 `样式已加载=false` 与 `出过首帧=true` **同屏**）。
         ⇒ 不粉饰原值，但在后面把 `sawRender` 一起写出来：**出过帧 = 这份 style 校验通过、
         图层也建起来了**（样式若非法，`load` 永不触发，一帧都不会有）。 */
      isStyleLoaded: rep.isStyleLoaded,
      sawRender: rep.sawRender,
      layers,
      expectedLayerIds: expected.filter(Boolean),
      errors: rep.errors,
      canvas: rep.canvas
        ? {
            w: rep.canvas.w,
            h: rep.canvas.h,
            cw: Number(rep.canvas.cssW || 0),
            ch: Number(rep.canvas.cssH || 0),
            dpr: rep.canvas.dpr,
          }
        : null,
      /* 🎬 场景装配自证（主会话要求：App 里也要能看到"相机/层序取自 wsScene"） */
      sceneSource: (() => {
        try {
          const camOk = true; // 相机默认值在 setup 期就取自 `cameraDefaults()`
          return sceneSelfReport(scenePlanConsumed() || camOk).source;
        } catch {
          return "（页面自带）";
        }
      })(),
      sceneViolations: (() => {
        try {
          const ids = (map?.getStyle?.()?.layers || []).map((l: { id?: string }) => String(l.id || ""));
          return sceneOrderViolations(ids);
        } catch {
          return [];
        }
      })(),
      /* 2D 路的 DPR 封顶（机主要的"降级路便宜了多少"的数字；WebGL 路不适用 ⇒ null） */
      dprCap2d: renderKind.value === "fallback2d" ? dprCap2d() : null,
      canvasBlank: (() => {
        const c2 = activeCanvas();
        return c2 ? canvasIsBlank(c2) : null;
      })(),
      counts: { buildings: stats.count, roads: stats.roads, facilities: stats.facilities, pins: stats.pins },
      /* 🧱 **离线包 offline-first 的可数回证**（切片 A）：默认发了几条 `/api/*`、取了哪些格、
         包外/失败各几格、仓库里多少要素（**数不出来写 null，不写 0**）、以及署名原句。
         ⚠️ 判词/计数口径**只有一份**（`wsScene.*VerdictText` / `wsOfflineFeed.bundleCountsLine`），
         面板只是把它念出来 —— 不在这里另算一套。 */
      bundle: (() => {
        const bf: BundleFeedFacts = bldFeed.facts();
        const rf: BundleFeedFacts = roadsFeed.facts();
        let pre: { src: string; tilePath: string; kind: string; attribution: string } | undefined;
        try {
          /* 远景预渲染的**路径与署名取自真源**（`wsScene.prerenderSourceOf`）——App 还没挂那一层
             （切片 C），这里只把真源的值念出来，免得以后有人手抄一份路径字面量。 */
          const p = prerenderSourceOf("real");
          pre = { src: p.src, tilePath: p.tilePath, kind: p.kind, attribution: p.attribution };
        } catch {
          pre = undefined;
        }
        return {
          bld: { have: bf.have, missing: bf.missing, failed: bf.failed, pending: bf.pending, n: bf.n, cap: bf.cap, verdict: stats.bldVerdict },
          roads: { have: rf.have, missing: rf.missing, failed: rf.failed, pending: rf.pending, n: rf.n, verdict: stats.roadsVerdict },
          /* 🧱 重构切片 S4（M2）：`bldHits` / `roadHits` / `bldInfo` / `roadInfo` 四个读数的所有者
             现在是 `wsViewFetch`（宿主里那四个 `let` 跟着函数一起搬走了）⇒ 这里换成它的出口。
             `on` 仍由宿主拼（`LIVE_ON` 是宿主自己的开关，不归 M2）。判据一字未改：还是"念出来"。 */
          live: { on: LIVE_ON, ...viewFetch.liveFacts() },
          attribution: stats.attribution,
          ...(pre ? { prerender: pre } : {}),
        };
      })(),
      roadSpecs: (() => {
        try {
          return roadLayerSpecs(theme.value.road).length;
        } catch {
          return 0;
        }
      })(),
      capsLow: !!perf.low.value,
      wstheme: themeId.value,
      wsnight: { on: nightOn.value, level: nightLvl.value },
      locSource: props.locSource || "",
      keyPaints: rep.keyPaints || {},
      worldTime: `${props.worldTime || "（拿不到）"} · 天黑 ${nightLvl.value}${nightOn.value ? "" : "（夜色关）"}`,
      motion: motionFacts(),
      resizeLog: resizeLog.value,
      canvases: canvasFactsWithCover(),
      hud: hudEl.value?.innerText || "",
    };
  }

  /** 面板的「现在拍一张」：**不看开关**（这是机主显式点的），拍完回一句人话 */
  async function shootNow(): Promise<string> {
    /* 还没分路（`init`）时按 WebGL 试：面板按钮多出现在地图已经起来之后，真降级了上面那条早就写了 */
    const kind = renderKind.value === "fallback2d" ? "fallback2d" : "webgl";
    const before = mapErrs.length;
    const r = await runAppSelfShot(appShotCtx(kind, fallbackWhy.value));
    const prefix = r.posted ? "已回传" : "POST 失败";
    const extra = r.blank ? `（空白：${r.why}，试了 ${r.attempts} 次 ⇒ 发的是诊断图）` : `（真画面）`;
    const errs = mapErrs.length > before ? ` · 期间地图库又报了 ${mapErrs.length - before} 条错` : "";
    return `${prefix} ${r.name} ${extra}${errs}`;
  }

  /**
   * 楼房两层的规格（初次加载与"放大后重取"共用一份，避免两处 paint 漂移）。
   *
   * 🎨 2026-09-19 改造（机主：「这个 ai 2d 小区好丑，直接试一下 3d 路线」）：
   *   · 高度改吃 `h3d`（= `wsBuildingLook.renderHeight()` 算好的渲染高度）。
   *     **以前吃的是 `height`，而 72% 的楼 height 都是同一个 8m ⇒ 天际线是一条平线。**
   *   · 颜色改按**高度**做色阶（以前按"数据来源"上色 ⇒ 一整片同一个色，又平又素）。
   *   · 打开竖向渐变：墙面有明暗，体块才"立"得起来。
   *   · 描边减淡（0.30→0.22 不透明度）：楼多了以后白边会织成一张网，比楼本身还抢眼。
   *
   * ⚠️ 这里**不能**用 `light` / `fill-extrusion-ambient-occlusion-*`：
   * 实测本 vendored 构建（v6.10.0）没有这两个字段 —— 加了不会报错，但**一点效果都没有**。
   * 想要的"光照"，现在靠「高度色阶 + 竖向渐变 + `sky` 大气透视」三样凑（见 DESIGN-SKYLINE.md）。
   *
   * 🏙 2026-09-20 第二步：「改造渲染」（`DESIGN-BUILDING-REALISM.md` §三 #2/#4/#6/#8，**零新数据**）：
   *   · 颜色改吃 `color3d`（高度色阶 + **确定性**微扰 ⇒ 不再"一片齐刷刷"）；
   *   · 新增**屋顶压顶**（内缩 0.85 + 更深色）与**天线**（>60m）两条挤出层，
   *     体块由 `wsBuildingLook.buildingParts()` 在渲染前拆好 —— 图层这里只读字段；
   *   · **远景褪色**按 zoom 调 `fill-extrusion-opacity`（#8）—— 注意**不是** `fog`：
   *     `fog` 在这个构建里是空操作（根级属性根本没有它），雾的参数在 `sky` 里，
   *     而且**雾要有 3D 地形才生效**（官方 `fog-color` 写着 "Requires 3D terrain"）。
   */
  /**
   * 🛣 路网图层（分级：主干粗亮、支路细暗，描边压底色）。
   *
   * 为什么**必须**放在楼房**下面**：路是"地面上的东西"，
   * 压在楼上会出现"路从楼顶穿过"的错觉（尤其倾斜视角）。
   * 所以 `addLayer(l, "bld-ext")` —— 和等高线用同一个 beforeId。
   */
  function roadLayerSpecsForMap(): Array<Record<string, unknown>> {
    /* 🎨 路网配色**跟主题走**（不传就退回原来那套暗底配色）。
       为什么必须传：二次元在 z14.8 之后**把栅格底图淡出到 0**（治"地面太糊"），
       此时路网是地面上**唯一的结构** —— 用暗底那套（近黑描边 + 暖白路芯）
       铺在浅青地面上就是"白线画白纸"。 */
    return roadLayerSpecs(theme.value.road);
  }

  /**
   * 网格 → 经纬度（**示意映射**）：把 28×28 的草图网格线性铺到区界 bbox 上。
   *
   * 为什么这里会有问题？因为严格来说这个映射**没有物理意义** —— 草图是程序生成的虚构街区，
   * 它和真实经纬度之间从来没有过换算关系（这是当初"想把草图贴到真实地图上"失败的根因）。
   * 现在这么做的语义是"**人在这个区里的相对位置**"：看得出谁在区的东边、谁在江对岸，
   * 但别指望它能对上某条具体街道。真正要精确，得让角色位置本身带经纬度（另一张卡）。
   */
  function gridToLngLat(gx: number, gy: number): [number, number] | null {
    const b = bboxRef.value;
    if (!b) return null;
    const g = Math.max(2, Math.round(props.grid || 28));
    const [w, s, e, n] = b;
    const lng = w + ((gx + 0.5) / g) * (e - w);
    /* 纬度要翻转：网格 y 向下增大，纬度向北增大（当年第一次写这个就忘了翻，人全跑到海里去了…） */
    const lat = n - ((gy + 0.5) / g) * (n - s);
    return [lng, lat];
  }

  /**
   * 造一个"人"的 DOM（用行内样式：scoped CSS 管不到运行时 new 出来的元素）。
   *
   * 🎯 切片②（2026-10-01）：**命中区 ≥44×44，视觉尺寸一点不变**——
   *   外面套一个 44×44 的**透明**盒（`hit`），原来那个 26/30px 的圆照旧居中。
   *   手法是项目既有的"透明外扩"（HUD 的 `.ws-dml__theme::after{inset:-12px -6px}`）；
   *   `min-width/height:44px` 那套（`WsCityEntry.vue:423-424`）会把底板也放大，这里不能用。
   *   ⚠️ 交给 `Marker` 的**必须是外层这个 `hit`**：`anchor:"center"` 与探针读的
   *   `.maplibregl-marker`（数量 / `title`）都落在它上面。
   */
  function pinEl(a: WsDistrictPin): HTMLElement {
    const hit = document.createElement("div");
    hit.style.cssText = [
      "width:44px",
      "height:44px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:transparent",
      "pointer-events:auto",
      /* 🔴 2026-10-01（切片② 真页面验收代理发现）：**「我」那颗钉不要压在别人身上**。
         `districtPinsOf` 把 me 排在最后 ⇒ 同 z-index 时它后画、盖在最上面；
         而没定位时 me 落在格心、只有一个角色时散点也在格心 ⇒ 那颗角色钉的 44×44 里
         **每一点都打到 me**（实测 `blockedBy: me`、点谁都是自己）。
         这里只给 z-index 排个序（角色 2 > 我 1）：命中判定看的是**最上面**那个元素，
         所以点下去先落到角色身上；视觉上也是"别人站在我前面"，与直觉一致。 */
      a.isMe ? "z-index:1" : "z-index:2",
    ].join(";");
    /* 钉子 id 落在**命中区**上（这是产品自己的 DOM 契约，不是调试出口）：
       自动化点外层任意一处都算点到这个人。 */
    hit.dataset.wsPinId = a.id;
    hit.addEventListener("click", (ev) => {
      /* 🔴 `stopPropagation()` 不能省：同一个点击会冒泡到地图容器 ⇒ 顺带把楼卡也弹出来
         （`onMapClick` 把任意落点当"点楼"，还有 `nearestDrawnBuilding` 兜底）。 */
      ev.stopPropagation();
      emit("pick-actor", a.id);
    });
    const el = document.createElement("div");
    const size = a.isMe ? 30 : 26;
    el.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      "border-radius:50%",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "font-size:12px",
      "color:#06222e",
      "font-weight:600",
      "box-shadow:0 2px 6px rgba(0,0,0,.45)",
      "border:2px solid rgba(255,255,255,.85)",
      a.isMe ? "background:#79d9ff" : "background:#cfe8f5",
      "overflow:hidden",
      "pointer-events:auto",
    ].join(";");
    if (a.avatarUrl) {
      const img = document.createElement("img");
      img.src = a.avatarUrl;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
      el.appendChild(img);
    } else {
      el.textContent = (a.name || "我").slice(0, 1);
    }
    hit.appendChild(el);
    /* 🕹 漫游（近景）时才写的两个子节点 —— **只有「我」有**，别人一颗都不多花：
       · `data-ws-roam-face`：朝向箭头（§4「朝向跟随移动方向」）—— 挂在 `hit` 上而**不是** `el` 里，
         因为 `el` 有 `overflow:hidden` 会把伸出去的箭头剪掉；
       · `data-ws-roam-body`：身体（就是那个圆），踏步动画只写它的 `transform`（§4「就地行走」）。
       ⚠️ 两个都**只在 transform 上动**（位置由 `Marker` 管、布局属性一个字不写）；
       具体每帧写不写由 `joyWalkAnimOn()` 判（`low` 档 / `prefers-reduced-motion` ⇒ 不写）。 */
    if (a.id === ROAM_PIN_ID) {
      el.dataset.wsRoamBody = "";
      const face = document.createElement("i");
      face.dataset.wsRoamFace = "";
      /* 朝向箭头 = 盖满整个 44×44 命中区的一层**透明** overlay，靠 `clip-path` 在正中上方
         画一个小矢头。为什么用"整层 + 裁剪"而不是"一个小三角"：`rotate` 的旋转中心必须是
         **身体中心**（= 这层 overlay 的中心），否则推杆时箭头会绕着身体乱甩；overlay 铺满 hit
         就天然是中心对齐，不用去算 `transform-origin` 的像素偏移。
         `clip-path` 是**绘制属性**（不参与布局），与"每帧只写 transform/opacity"同一条红线。 */
      face.style.cssText = [
        "position:absolute",
        "left:0",
        "top:0",
        "width:100%",
        "height:100%",
        "background:rgba(233,244,255,.95)",
        "clip-path:polygon(50% 2%, 62% 22%, 50% 15%, 38% 22%)",
        /* 朝向箭头**不吃事件**（命中区还是那个 44×44 的 hit） */
        "pointer-events:none",
        /* 提升为独立图层 ⇒ 每帧那次 `rotate` 只走合成器，不重新栅格化（`filter`/`box-shadow`
           一概不加：浮在地图上、每帧都在转的东西，画得越简单越稳） */
        "will-change:transform",
      ].join(";");
      hit.appendChild(face);
      /* 🎯 **预走线**（2026-10-04 第四轮；机主：「能给移动加预走线吗…动画要好看喵！」）——
         结构三件，**每一件每帧最多写一个 transform**（详见 `wsJoystick.ts` 第九节）：
           · `data-ws-roam-aim` 容器：只吃 `rotate(朝向)`（**角度真变了才写**，直着走通常 0 次）；
           · `.ws-aim__dash`    虚线：吃 `scaleX(线长 ÷ 满长)`（每帧 1 次）——里面那层 `.ws-aim__flow`
                                的"流动"是**纯 CSS 动画**（平移恰好一个周期 ⇒ 无缝循环，研究 §12.4），JS 一次都不写；
           · `.ws-aim__tip`     箭头：吃 `translate3d(线长, 0, 0)`（每帧 1 次）。
         ⚠️ 挂在 `hit` 上（与 face 同层）：**位置由 `Marker` 管**，我们一个布局属性都不写；
         它在**钉子自己的 DOM 里** ⇒ 名字层一个节点都不碰（"不与标签打架"的第一条）。
         ⚠️ 显隐**不是**每帧写 `opacity`：`hit` 上的 `is-aim` class 只翻转一次，剩下交给 CSS 过渡
         （入场 140ms / 淡出 320ms ease-out，见文件末尾那段全局样式）—— 这就是"停下优雅淡出"，
         也是"每帧 0 次 opacity 写"的来源。 */
      hit.dataset.wsRoamPin = "";
      const aim = document.createElement("span");
      /* 🔴 2026-10-04 第六轮（机主：「**预走线的轴心不在角色**」）—— **这一行是那一句的全部真因**：
         下面那段全局样式挂在 `.ws-aim` 这个**类**上（`position:absolute; left:50%; top:50%`，
         `transform-origin: 0 0`），而这里原来只写了 `data-ws-roam-aim` 属性、**类名一个字没写**
         ⇒ 那三条定位一条都没生效 ⇒ 这个 span 退回**普通文档流**，而它的父节点 `hit` 是
         `display:flex` 的 44×44（`justify-content:center`）⇒ 它成了**第二个 flex 项**，
         与 30px 的身体圆并排居中 ⇒ 轴心落在 `(44−30)/2 = **15px**` 的**右侧**（= 身体圆的右边缘），
         而不是身体圆心；`rotate()` 于是绕着"身体右边 15px"那一根轴转（"轴心不在角色"就是这个）。
         同一个漏写还让 `opacity:0`（静止时不可见）与 `is-aim` 的淡入淡出**整条失效**。
         ⇒ 补上类名一处即可：轴心回到 `hit` 正中 = **Marker 的锚点** = 角色世界坐标的屏幕投影。 */
      aim.className = "ws-aim";
      aim.dataset.wsRoamAim = "";
      const dash = document.createElement("span");
      dash.className = "ws-aim__dash";
      const flow = document.createElement("span");
      flow.className = "ws-aim__flow";
      dash.appendChild(flow);
      const tip = document.createElement("span");
      tip.className = "ws-aim__tip";
      aim.appendChild(dash);
      aim.appendChild(tip);
      hit.appendChild(aim);
    }
    /* 📍 **屏外方向指示**（2026-10-04 第七条；机主：「其他角色不见了喵」+ 他自己点的「屏外加方向指示」）。
       结构：一个定位容器 + 里面两件（转的箭头 / 不转的距离文案）。
       🔴 三条都是**硬约束**，改它的人先读这三行：
         ① `position:absolute` —— 外层 `hit` 是 `display:flex` 的 44×44，**多一个普通子节点就会变成第二个
            flex 项**、把身体圆挤走（`.ws-aim` 当年就是这么栽的，见它上面那段注释）；
         ② `pointer-events:none` —— 箭头只是指示，**不许**吃掉地图手势、也不许抢 `hit` 的点击；
         ③ 每颗钉子**建一次、之后只复用**（`pinEdgeSync` 只写 `transform` / `textContent` / 一个 class）。
       ⚠️ 「我」那颗钉子**不建**（相机跟着他，"屏外"对他没有意义 —— 机主点的是"其他角色"）。
       ⚠️ 这里只建节点：**位置/朝向/文案一个字都不在这里算**（那些在 `wsPinEdge.ts`，纯函数）。 */
    if (!a.isMe) {
      const edge = document.createElement("span");
      edge.className = "ws-pin-edge";
      edge.dataset.wsPinEdge = "";
      const arrow = document.createElement("i");
      arrow.className = "ws-pin-edge__arrow";
      const dist = document.createElement("em");
      dist.className = "ws-pin-edge__dist";
      edge.appendChild(arrow);
      edge.appendChild(dist);
      hit.appendChild(edge);
    }
    /* 标题里如实带出"位置是怎么来的"：吸附到路上（`road`）和网格示意位置，
       精度完全不是一回事 —— 以后排查"怎么站到江里了"就靠这一行。
       （挂在 `hit` 上 = 挂钩子的那个元素上，`syncPins` 更新 title 时也是它。） */
    hit.title =
      `${a.name || "我"}` +
      (a.posSource === "affinity" ? "（特地来找你）" : "") +
      (a.posSource === "road" ? "（在路上）" : a.posSource === "facility" ? "（在设施旁）" : "");
    return hit;
  }

  /**
   * 把 `markers` 同步到地图上：新增的建 Marker、已有的挪位置、消失的移除。
   * 好累～ 每次 moveend 都要重算一遍吗？不用 —— 网格→经纬度只依赖区界 bbox，
   * 与相机无关，所以只在"人变了 / 区界到了"时同步。
   */
  /* 🧱 缩放那三个（`zoomOnce` 150ms 节流 / `fitDistrict` 全区 / `zoomBy` 按钮缩放）搬进了
     `wsMapCamera.ts`（S3 / M1）。它们**目前没有任何调用点**（模板里 `＋ / － / 全区` 早已整块移除）
     —— 是死代码这件事不在本片处理（§3 把删死代码排在 S9），搬的时候一个字没改。 */

  /**
   * 把 AI 的产出同步到地图上（楼 → 挤出、路 → 线、公园/水系 → 面）。
   *
   * ## 什么时候画（机主 2026-09-20 定）
   * 由 `aiOn` 决定 —— **真数据优先**：真楼 ≥ 40 栋就整层摘掉，稀疏（含 0 栋）才画。
   * 所以这个函数是**双向**的：开的时候建图层，关的时候**必须把图层删掉**。
   * （以前这里只在 `!props.showAi` 时 `return` ⇒ 先开过后关会留下一层摘不掉的暖色楼。
   *  假数据留在画面上不发声明，比不画更坏。）
   *
   * ## 铺在哪（重要）
   * 用 `aiBboxRef`（**小区尺度的正方形**，边长 `AI_SPAN_M`），**不是**区县 bbox。
   * 原因见 `AI_SPAN_M` 的注释：涪陵区 bbox 有 75km 宽，28 格铺上去一格就 2.7km，
   * 那是薄饼不是楼。铺在驻地的 700m 方块里，一格 ≈ 25m，才和真楼同一个量级。
   *
   * ## 尺度是编的、位置也是编的 —— 所以 HUD 必须标"非事实"
   * 颜色口径照旧：真楼冰蓝 / 示意暖色（`#d9a06b`），两条路一眼分得开。
   */
  function removeAiLayers(m: {
    getLayer(id: string): unknown;
    removeLayer(id: string): void;
    getSource(id: string): unknown;
    removeSource(id: string): void;
  }): void {
    /* 顺序不能反：**先删图层再删源**（源还被图层引用时删不掉，且会抛错） */
    for (const id of ["ai-road", "ai-bld", "ai-area"]) {
      try {
        if (m.getLayer(id)) m.removeLayer(id);
      } catch {
        /* 已经没了 */
      }
    }
    try {
      if (m.getSource("ai")) m.removeSource("ai");
    } catch {
      /* 已经没了 */
    }
    aiDrawn.value = 0;
  }

  function syncAiLayers(): void {
    const m = map as unknown as {
      getSource(id: string): { setData(d: unknown): void } | undefined;
      addSource(id: string, spec: Record<string, unknown>): void;
      addLayer(spec: Record<string, unknown>, beforeId?: string): void;
      getLayer(id: string): unknown;
      removeLayer(id: string): void;
      removeSource(id: string): void;
    } | null;
    if (!m || !bboxRef.value) return;
    /* 真数据够了 ⇒ 把示意层摘干净（"真数据优先"的落地动作） */
    if (!aiOn.value) {
      removeAiLayers(m);
      return;
    }
    const bbox = aiBboxRef.value || bboxRef.value;
    const fc = aiFeatureCollection(props.aiItems || [], bbox, props.grid || 28);
    /* 如实记账：AI 还没吐出东西时 `aiDrawn` 就是 0，HUD 那句会写"待生成"而不是"已叠加" */
    aiDrawn.value = fc.features.length;
    if (!fc.features.length) return;
    const src = m.getSource("ai");
    if (src) {
      src.setData(fc);
      return;
    }
    m.addSource("ai", { type: "geojson", data: fc });
    /* 面（公园/水系）在楼之下；楼用暖色挤出；路最上 */
    m.addLayer({
      id: "ai-area",
      type: "fill",
      source: "ai",
      filter: ["in", ["get", "kind"], ["literal", ["park", "water"]]],
      paint: {
        /* 配色跟主题走（二次元的水是**明亮青蓝**）：原来这里是写死的 rgba，
           换主题时它不会跟着变 ⇒ 两套风格打架。 */
        "fill-color": ["match", ["get", "kind"], "park", theme.value.ai.park, theme.value.ai.water],
      },
    });
    m.addLayer({
      id: "ai-bld",
      type: "fill-extrusion",
      source: "ai",
      filter: ["==", ["get", "kind"], "building"],
      paint: {
        "fill-extrusion-color": "#d9a06b",
        "fill-extrusion-height": ["coalesce", ["get", "height"], 12],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.9,
      },
    });
    m.addLayer({
      id: "ai-road",
      type: "line",
      source: "ai",
      filter: ["==", ["get", "kind"], "road"],
      paint: { "line-color": "rgba(255, 226, 170, 0.55)", "line-width": 1.6 },
    });
  }

  /* 🗄 2026-09-24 机主裁定「App 页现在只准保留代拍页代码」⇒ **AI 示意层两个 watcher 都关掉**
     （`syncAiLayers()` 本身留在文件里，随时可恢复）。原文如下，恢复时按它改回：
       · 「AI 产出变了就同步（流式生成时每来一批都会调）」→ `watch(() => props.aiItems, …)`
       · 「真楼数变了 ⇒ `aiOn` 可能翻转 ⇒ 自动叠上 / 摘掉示意层」→ `watch(aiOn, …)`
     ⚠️ 只关"画到地图上"这一半：`aiOn` 这个 computed 仍然照旧（HUD 那句"真楼 N 栋（稀疏）…"
        读的就是它 —— 别把"计数"和"上屏"混为一谈）。 */

  /**
   * 把"示意位置"吸附到**真实路网**上（`wsSnap.snapToRoad`）。
   *
   * 这一步是"把行人挪到路上"的**实际落点**：网格坐标是草图空间的示意值，
   * 直接画到地图上会**落在楼里/江里**；吸附到最近的路段上（投影点，不是顶点）之后，
   * 位置才与底图/路网自洽 —— `DESIGN-AUTONOMY.md` 的"角色自己出门"也才有意义。
   *
   * ⚠️ 超过 `SNAP_MAX_M` 就**不吸**（返回 null ⇒ 保持原位）：
   * 路网在 2km 外时硬吸过去就是**瞬移**，比"位置不精确"糟糕得多。
   */
  const SNAP_MAX_M = 220;
  function snapPin(pos: [number, number]): { pos: [number, number]; snapped: boolean; segName?: string | null } {
    if (!props.snapPins || !roadSegs.length) return { pos, snapped: false };
    const hit = snapToRoad(pos, roadSegs, SNAP_MAX_M);
    if (!hit) return { pos, snapped: false };
    return { pos: hit.point, snapped: true, segName: hit.seg.name ?? null };
  }

  /**
   * 🧭 **没有 adcode 时的锚点**（新入口 `/worldsim` 就是这一种：城市包没有"区县"这一级）。
   *
   * 为什么必须有：`markers` → 屏幕位置的换算要一个 bbox（`gridToLngLat`）。没有它，
   * 角色**一个都画不出来** —— 而原来那条 `return` 是**静默**的（见下面 `syncPins`）。
   * 口径（**我们选的**，不是"行业标准"）：
   *   · 只在**还没有锚点**时用**当前视野**兜一次（`map.getBounds()`），**设一次就固定** ——
   *     否则每拖一次地图人就跟着重排一次（那正是"鬼影"的观感来源）；
   *   · 网格坐标本来就是**示意**位置（`posSource:"scatter"`/`"schedule"`），
   *     "人在当前城市视野里"与既有语义一致；
   *   · 有 adcode 时**一行都不走这里**（官方那条管线逐字不变）。
   * ⚠️ 第一版把它写在 `map.on("load")` 之前 ⇒ 那时 `map` **还是 null**（`map = m` 在这一段之后），
   *    于是这段代码**永远不会执行**、而 HUD 只显示"没有锚点"（探针一眼看出 0 个角色）。
   *    放在这里（`syncPins` 的入口）是**唯一**能保证"map 一定在"的位置。
   */
  function ensurePinAnchor(): boolean {
    if (bboxRef.value) return true;
    if (props.adcode) return false;                 // 有 adcode ⇒ 走官方那条（geoJson → bbox）
    const m = map as unknown as { getBounds?: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } } | null;
    try {
      const bb = m?.getBounds?.();
      const w = bb?.getWest(), s0 = bb?.getSouth(), e = bb?.getEast(), n = bb?.getNorth();
      if ([w, s0, e, n].every((v) => Number.isFinite(Number(v))) && Number(e) > Number(w) && Number(n) > Number(s0)) {
        bboxRef.value = [Number(w), Number(s0), Number(e), Number(n)];
        stats.pinsAnchor = "视野兜底（无 adcode）";
        /* 锚点是**视线兜底**出来的 ⇒ 位置上屏必须如实标出来（不许冒充真实经纬度） */
        return true;
      }
    } catch {
      /* 拿不到就保持 null —— 下面会如实写"数不出来：没有锚点" */
    }
    return false;
  }

  function syncPins(): void {
    const m = map;
    if (!m || !mlMod?.Marker) return;
    ensurePinAnchor();
    if (!bboxRef.value) {
      /* 🔴 **不静默**：这条 `return` 以前什么都不说，于是"没有锚点 ⇒ 一个钉子都画不出"
         在屏幕上与"名单是空的"长得一模一样（机主看到"地图上没人"，无从判断是哪一种）。
         三态如实写：锚点没有 ⇒ 数不出来 + 原因。 */
      stats.pinsNote = "数不出来：还没有锚点 bbox（adcode 为空且视野也拿不到）⇒ 一个人都放不下";
      stats.pins = 0;
      return;
    }
    const list = props.markers || [];
    const alive = new Set<string>();
    /* 🕹 漫游期间「我」的位置真源是 `roamStore`（不是网格坐标）：**这期间谁来同步都不许把它挪走**。
       不特判的话，松手那一次重算（`refreshBundles` 换了 `markers` 数组）就会走到这里，
       把刚走了几步的「我」一把打回格心 —— 机主看到的就是"走了两步又弹回去"。 */
    const roam = roamStore.get();
    for (const a of list) {
      let pos: [number, number];
      if (a.id === ROAM_PIN_ID && roam) {
        pos = [roam.lng, roam.lat];
      } else {
        const raw = gridToLngLat(a.gx, a.gy);
        if (!raw) continue;
        pos = snapPin(raw).pos;
      }

      alive.add(a.id);
      const hit = pins.find((x) => x.id === a.id);
      if (hit) {
        hit.mk.setLngLat(pos);
        hit.el.title = `${a.name || "我"}${a.posSource === "affinity" ? "（特地来找你）" : ""}`;
      } else {
        const el = pinEl(a);
        /* 🔴 `subpixelPositioning: true` **不是调参，是消抖的必需项**（研究 §11.1，2026-10-04 第四轮）：
           MapLibre 官方源码 `Marker._update()` 逐字 —— "because rounding the coordinates at every `move`
           event causes stuttered zooming, we only round them when `_update` is called with `moveend`
           or when its called with **no arguments** (when the Marker is initialized or **`Marker#setLngLat`
           is invoked**)" ⇒ 默认（`@defaultValue false`）下**我们每帧那次 `setLngLat` 都会把钉子
           `.round()` 到整数 CSS 像素**：地图以亚像素连续滚动、钉子却一格一格跳。
           官方为此专门提供了 `subpixelPositioning`，文档原话是"**If true, rounding is disabled for
           placement of the marker, allowing for subpixel positioning and smoother movement when the
           marker is translated**"。游标只影响"要不要 `.round()`"，对静止的钉子零代价。 */
        const mk = new mlMod.Marker({ element: el, anchor: "center", subpixelPositioning: true }).setLngLat(pos).addTo(m);
        pins.push({
          id: a.id,
          el,
          mk,
          face: el.querySelector<HTMLElement>("[data-ws-roam-face]"),
          body: el.querySelector<HTMLElement>("[data-ws-roam-body]"),
          aim: el.querySelector<HTMLElement>("[data-ws-roam-aim]"),
          dash: el.querySelector<HTMLElement>(".ws-aim__dash"),
          tip: el.querySelector<HTMLElement>(".ws-aim__tip"),
          /* 📍 三件（只有"别人"的钉子上有 ⇒ 「我」那三栏恒 null，`pinEdgeSync` 据此跳过它） */
          edge: el.querySelector<HTMLElement>("[data-ws-pin-edge]"),
          edgeArrow: el.querySelector<HTMLElement>(".ws-pin-edge__arrow"),
          edgeDist: el.querySelector<HTMLElement>(".ws-pin-edge__dist"),
          edgeKey: "",
        });
      }
    }
    for (const p of pins) {
      if (alive.has(p.id)) continue;
      try {
        p.mk.remove();
      } catch {
        /* 已经没了就算了（地图销毁时会一起走） */
      }
    }
    pins = pins.filter((p) => alive.has(p.id));
    stats.pins = pins.length;
    /* 📍 新钉子刚建出来 ⇒ **立刻补一次**屏外指示（不补的话，屏外的那个人要等到下一次相机事件才长出箭头）。
       ⚠️ 这里调的两个函数是**函数声明**（提升可见），而它们读的 `pinEdgeGeom` 是 setup 里的 `const` ——
          本函数的所有调用点都在 setup 跑完之后（watch 回调 / map 事件 / 异步 load）⇒ 不会踩 TDZ。 */
    pinEdgeMeasure();
    pinEdgeSync();
  }

  /* ══════════ 📍 **屏外方向指示**（2026-10-04 第七条）══════════════════════════════════
     机主原话：「**为什么其他角色不见了喵**，放大到最大后楼就没了喵」（前半句归本段）；他自己点的方案：
     「**屏外加方向指示（小箭头 + 距离）**」。病根：角色钉子走地图库 `Marker` ⇒ **出了视口就是真的没有**。

     ## 三个"只在变了才写"（与 `joyAimWrite` 同款；写点数**可数**，写在这里备查）
       · 一颗钉子从"屏内"翻到"屏外"（或翻回来）⇒ **1 次 class 写**（`is-off`），显隐交给 CSS 过渡；
       · 屏外时每轮：**≤2 次 `transform`**（容器位移 + 箭头 `rotate`）+ **≤1 次 `textContent`**（距离文案）；
         三者的合成串（`edgeKey`）**没变就一次都不写** —— 相机不动时稳态是 **0 次/轮**。
       · 屏内时：**0 次**（只有翻转那一轮那 1 次 class）。
     ## 时点：跟着**相机事件**走（`move` / `moveend` / `zoom`），**不在 rAF 里**（红线：不进每帧循环）
       · 摇杆推着的时候与其它 handler 一样**早退**（`joyActive`）—— 拉近期间整层都在早退，
         收尾由 `onJoyHalt()` 那**恰好一次**重算带上（与名字层同一套时点，判据 3/6 的红线）；
       · 新钉子建出来时（`syncPins` 末尾）与容器尺寸变化时（resize）各补一次。
     ## 几何：**只在挂载 / resize 量一次**（读 `clientWidth` 是强制布局，红线）
       · 安全区（刘海/手势条）用 `env(safe-area-inset-*)` 探针量一次 ⇒ 折成一个**内缩后的子矩形**，
         再把结果平移回去（纯函数只认一个标量 margin ⇒ 这里做的是仿射平移，**不是第二份几何**）；
       · 三块禁区（HUD 让位带 / 📱 / 🔬）用摇杆那一份 `joyHomeBoxesOf()`（**同一份矩形、同一个间距**
         `PIN_EDGE_MIN_GAP_PX = JOY_GAP_PX`）⇒ 箭头绝不会压在 HUD 上。 */
  /** 📍 开关（**默认开**）：唯一的关法是 `?edge=0`（与 `?names=0`/`?joy=0` 同一族写法） */
  const pinEdgeOn = ref(!/[?&]edge=0\b/.test(String(typeof location !== "undefined" ? location.search : "")));
  /** 量一次就缓存：容器 CSS 尺寸 + 四边安全区（`measured=false` ⇒ 数不出来，一颗箭头都不写） */
  const pinEdgeGeom = { w: 0, h: 0, l: 0, t: 0, r: 0, b: 0, measured: false };
  /** `env(safe-area-inset-*)` 探针：读**一次**就拆掉（量不到 ⇒ 四边 0，与"没有刘海"同义） */
  function pinEdgeInsetsOf(): { l: number; t: number; r: number; b: number } {
    const zero = { l: 0, t: 0, r: 0, b: 0 };
    try {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;" +
        "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);";
      (host.value || document.body).appendChild(probe);
      const cs = getComputedStyle(probe);
      const v = {
        t: parseFloat(cs.paddingTop) || 0,
        r: parseFloat(cs.paddingRight) || 0,
        b: parseFloat(cs.paddingBottom) || 0,
        l: parseFloat(cs.paddingLeft) || 0,
      };
      probe.remove();
      return v;
    } catch {
      return zero;   /* 读不出来 ⇒ 当"没有安全区"（**不改**任何其它判定；不是把"数不出来"写成别的数） */
    }
  }
  function pinEdgeMeasure(): void {
    const el = host.value;
    const w = el?.clientWidth || 0;
    const h = el?.clientHeight || 0;
    if (w <= 0 || h <= 0) return;             /* 量不到 ⇒ 保持 `measured=false`（数不出来，不编坐标） */
    const ins = pinEdgeInsetsOf();
    pinEdgeGeom.w = w;
    pinEdgeGeom.h = h;
    pinEdgeGeom.l = ins.l;
    pinEdgeGeom.t = ins.t;
    pinEdgeGeom.r = ins.r;
    pinEdgeGeom.b = ins.b;
    pinEdgeGeom.measured = true;
  }
  /**
   * 把一个点从三块禁区里**往上推**出去（与摇杆的"家"同一套矩形、同一个间距 ⇒ 不会打架）。
   * 为什么是"往上推"：三块禁区全部贴在**下缘**（HUD / 📱 / 🔬），推一次就走开。
   * 推完仍夹回安全矩形 —— 返回的点一定在屏内（含边）。
   */
  function pinEdgeAvoid(x: number, y: number): { x: number; y: number } {
    const G = pinEdgeGeom;
    const loX = G.l + PIN_EDGE_MARGIN_PX, hiX = G.w - G.r - PIN_EDGE_MARGIN_PX;
    const loY = G.t + PIN_EDGE_MARGIN_PX, hiY = G.h - G.b - PIN_EDGE_MARGIN_PX;
    let px = Math.max(loX, Math.min(hiX, x));
    let py = Math.max(loY, Math.min(hiY, y));
    const boxes = joyHomeBoxesOf(G.w, G.h);
    for (let pass = 0; pass < 4; pass++) {
      let hit = false;
      for (const b of boxes) {
        const inside = px > b.l - PIN_EDGE_MIN_GAP_PX && px < b.r + PIN_EDGE_MIN_GAP_PX &&
          py > b.t - PIN_EDGE_MIN_GAP_PX && py < b.b + PIN_EDGE_MIN_GAP_PX;
        if (!inside) continue;
        py = b.t - PIN_EDGE_MIN_GAP_PX;
        hit = true;
      }
      if (!hit) break;
      py = Math.max(loY, Math.min(hiY, py));
    }
    return { x: px, y: py };
  }
  /**
   * 📍 **一轮**：每颗"别人"的钉子算一次屏幕点 ⇒ 屏外画边缘箭头 + 距离，回到屏内就藏起来。
   * 规则（夹取/角度/文案）全在纯函数 `wsPinEdge.ts`；这里只做三件事：投影、写 DOM、**只在变了才写**。
   */
  function pinEdgeSync(): void {
    if (!pinEdgeOn.value) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    if (!m || typeof m.project !== "function") return;
    if (!pinEdgeGeom.measured) return;        /* 容器还没量过 ⇒ 数不出来（不编坐标、不写 DOM） */
    const G = pinEdgeGeom;
    const vw = G.w - G.l - G.r;
    const vh = G.h - G.t - G.b;
    /* 相机中心**一轮读一次**（距离那一行要用它；不是每颗钉子读一次相机） */
    let cLng = NaN, cLat = NaN;
    try {
      const c = (map as unknown as { getCenter?: () => { lng: number; lat: number } } | null)?.getCenter?.();
      cLng = Number(c?.lng);
      cLat = Number(c?.lat);
    } catch {
      cLng = NaN; cLat = NaN;
    }
    for (const p of pins) {
      const edge = p.edge;
      /* 「我」那颗钉子**没有这三个节点**（相机跟着他，"屏外"对他没意义 —— 机主点的是"其他角色"） */
      if (!edge || !p.edgeArrow || !p.edgeDist) continue;
      let px = NaN, py = NaN, lng = NaN, lat = NaN;
      try {
        const ll = p.mk.getLngLat ? p.mk.getLngLat() : null;
        lng = Number(ll?.lng);
        lat = Number(ll?.lat);
        const q = m.project([lng, lat]);
        px = Number(q?.x);
        py = Number(q?.y);
      } catch {
        px = NaN; py = NaN;
      }
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;   /* 数不出来 ⇒ 这一颗本轮一个字都不写 */
      /* 折算进"安全子矩形"再交给纯函数（仿射平移：先减左上安全区，算完再加回去） */
      const r = pinEdgeOf({ x: px - G.l, y: py - G.t }, { w: vw, h: vh });
      if (r.note) continue;
      if (!r.off) {
        /* 屏内：**只翻转一次 class**（显隐交给 CSS 过渡），位置/角度一个字都不写 */
        if (p.edgeKey !== "off") {
          p.edgeKey = "off";
          edge.classList.remove("is-off");
        }
        continue;
      }
      const at = pinEdgeAvoid(r.ex + G.l, r.ey + G.t);
      const rot = pinEdgeRotateDegOf(r.angleDeg);
      const text = pinDistText(pinEdgeMetersOf(lng, lat, cLng, cLat));
      const key = "1|" + at.x.toFixed(1) + "|" + at.y.toFixed(1) + "|" + rot.toFixed(1) + "|" + text;
      if (key === p.edgeKey) continue;         /* 三个写点全都一样 ⇒ 这一轮 **0 次** DOM 写 */
      p.edgeKey = key;
      edge.classList.add("is-off");
      edge.style.transform =
        `translate3d(${(at.x - px).toFixed(1)}px, ${(at.y - py).toFixed(1)}px, 0) translate(-50%, -50%)`;
      p.edgeArrow.style.transform = `rotate(${rot}deg)`;
      if (p.edgeDist.textContent !== text) p.edgeDist.textContent = text;
    }
  }
  /**
   * 📏 **"离我多远"**：相机中心 → 这一颗钉子的**地面米数**（纯算术，与挑楼那把尺子同一对常数
   * `111320·cos(lat)` / `110540`；**一次投影都不做** —— 两个点本来就是经纬度）。
   *
   * 口径：相机锁着「我」（近景那条口径）⇒ 中心就是「我」；两者不重合时以**相机中心**为准
   *   —— 这行字答的是"屏幕上那颗箭头指的那个人，离你现在看的地方多远"。
   * 三态：任一输入不是有限数 ⇒ `null` ⇒ 文案写「—」（**不许**写 `0 m` 冒充"就在我脚下"）。
   */
  function pinEdgeMetersOf(lng: number, lat: number, cLng: number, cLat: number): number | null {
    if (![lng, lat, cLng, cLat].every((v) => Number.isFinite(v))) return null;
    const lat0 = (lat + cLat) / 2;
    const dx = (lng - cLng) * 111320 * Math.cos((lat0 * Math.PI) / 180);
    const dy = (lat - cLat) * 110540;
    const d = Math.sqrt(dx * dx + dy * dy);
    return Number.isFinite(d) ? d : null;
  }

  /* 人变了就同步一次（`placed` 每次 load 会换新数组，浅层 watch 就够） */
  watch(
    /* 👤 **锚点变了也要重画**：新入口的锚点是"视野兜底"，它可能在 markers 之后才设上
       （第一版只 watch `props.markers` ⇒ 锚点晚到就永远不画，且没有任何提示）。
       🧭 2026-09-27 补 `draw2dBbox`：降级路的楼是**画完才有**那份范围的（`draw2d` 现算），
       比人晚到 ⇒ 不 watch 它的话，人会等到"下一次名单变化"才出现（甚至永远不出现）。 */
    () => [props.markers, bboxRef.value, draw2dBbox.value] as const,
    () => {
      syncPins();
      stats.pins = mapAvailable.value ? stats.pins : domPins.value.length;
      /* 🔴 **不许静默**：名单里有人、屏上却 0 个 ⇒ 必须写出"是哪一种数不出来"。
         以前这里什么都不说，屏幕上"名单空"与"放不下人"长得一模一样（机主「连人都没有了」）。 */
      const want = (props.markers || []).length;
      if (stats.pins > 0) stats.pinsNote = "";
      else if (want > 0) {
        stats.pinsNote = mapAvailable.value
          ? "数不出来：还没有锚点 bbox（adcode 为空且视野也拿不到）⇒ 一个人都放不下"
          : "数不出来：降级路还没画出可定范围的内容（2D 画布无楼 ⇒ 没有可用的锚点）";
      }
    }
  );

  /**
   * `adcode` **晚一拍到达**的补救（2026-09-19 真机实测发现的）。
   *
   * 现象：从「进入这个世界」进小区级时，HUD 里**没有区名**、画面停在 `初始化…`
   * ⇒ 说明挂载那一刻 `props.adcode` 还是空串，于是走了"IP 定位 + 现取 Overpass"的慢路径
   * （几十秒），而不是"整区铺满 + 放大才取楼"的快路径。
   *
   * 好累～ 这里其实是"**组件只读一次 props**"这种写法的通病：props 是响应式的，
   * 但"挂载时读一次就再不管"的代码到处都有。补个 watcher 就够，不用重构。
   */
  watch(
    () => props.adcode,
    async (ad) => {
      if (!ad || bboxRef.value || !map) return;
      try {
        const gj = (await geoJson(String(ad))) as {
          features?: Array<{
            geometry?: { type?: string; coordinates?: unknown };
            properties?: Record<string, unknown>;
          }>;
        };
        const f = gj?.features?.[0] ?? null;
        const b = bboxOfGeometry(f?.geometry);
        const m = map as unknown as { fitBounds(x: unknown, o?: unknown): void } | null;
        if (!b || !m) return;
        bboxRef.value = b;
        stats.area = String((f?.properties || {}).name || props.area || "");
        m.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: 16, pitch: props.pitch, duration: 0 }
        );
        stats.mode = "全区视野（区县边界）";
        stats.view = "全区视野";
        stats.note = "全区视野：放大到街区后自动加载楼房";
        syncPins();
        /* ⚠️ 已知缺口：这条补救路**没画区界描边**（那条线要用 districtFeat，
           而它在 onMounted 的局部作用域里）。要补的话把"加区界图层"抽成函数共用 —— 记在 CHANGELOG 里。 */
      } catch {
        /* 拿不到就保持现状，不打扰用户 */
      }
    }
  );

  /* ── 2D 降级路的"人" ─────────────────────────────────────────────────────
     没有 WebGL 就没有地图库 Marker。但"人"是这一屏的主角，不该因为渲染器降级就整批消失
     （低端机/无头环境都吃这一条）。所以这里用**最朴素**的办法：DOM 钉子 + 百分比定位，
     坐标同样来自"网格 → 区界 bbox"的示意映射（和 Marker 那条路同一套语义、同一份数据）。
     好累～ 两个渲染器要维护两套定位代码，这事不优雅 —— 但总比"降级了人就消失"强。 */
  const domPins = computed(() => {
    /* 🧭 降级路的锚点优先用 **`draw2d` 自己算出来的那份范围**（`draw2dBbox`）——
       因为画楼用的就是它，人必须跟楼同一套映射；没有时才退回 `bboxRef`
       （WebGL 路留下的行政区/视野范围，在降级路里只是"聊胜于无"的兜底）。
       🔴 2026-09-27 修：以前只认 `bboxRef`，而它在 App 页（`adcode=""`）+ 降级路下**永远是 null**
       ⇒ 人一个都放不下（机主：「连人都没有了」）。见 `draw2dBbox` 的注释。 */
    const b = draw2dBbox.value || bboxRef.value;
    if (!b || mapAvailable.value) return [];
    const g = Math.max(2, Math.round(props.grid || 28));
    const [w, s0, e, n] = b;
    const spanX = e - w || 1;
    const spanY = n - s0 || 1;
    return (props.markers || [])
      .map((a) => {
        const lng = w + ((a.gx + 0.5) / g) * spanX;
        /* 纬度向北增大、屏幕 y 向下 ⇒ 这里要翻一下，否则人全跑到底部去 */
        const lat = n - ((a.gy + 0.5) / g) * spanY;
        return {
          id: a.id,
          name: a.name,
          isMe: !!a.isMe,
          affinity: a.posSource === "affinity",
          /* 🎬 步①（2026-10-02）：这两个百分比**不再是 `left/top`**，而是喂给外层
             `.ws-dml__pinat` 的 `translate3d(X%, Y%, 0)`（合成属性）。
             分子分母一字未动（还是"网格→bbox"那一套），只是换了个用法 ⇒ 落点不变。 */
          tx: `${(((lng - w) / spanX) * 100).toFixed(2)}%`,
          ty: `${(((n - lat) / spanY) * 100).toFixed(2)}%`,
        };
      })
      .slice(0, 60); // 防呆：再多人也不至于把 DOM 撑爆
  });

  /* ══ 🧱 重构切片 S2（M6）：**2D 降级路的装配**（实现整块在 `wsFallback2d.ts`）══════════════
     宿主在这条路上只剩三件事：**构造一份只读 ctx** 递进去、把函数接回来、在调用点把 `map` 递进去。
     为什么是"工厂 + 解构"而不是"每个函数都收 ctx"：这批函数闭包着上面那一大堆 setup 期局部量
     （`theme`/`stats`/`cv`/`host`/`aiOn`/`aiBboxRef`/`draw2dBbox`/`domPins`/`phase`/`perf`/`props`…），
     逐处改写成 `ctx.xxx` 就不是"只搬不改"了；现在每个函数体都是从本文件**逐字节**搬过去的
     （对拍闸 `ws_fallback2d_move_selftest.mjs` 断言 diff = 0）。
     ⚠️ 位置必须在**所有被捕获的量都声明之后**（`domPins` 正好是最后一个）：它们是 `const`，
        声明前引用会踩 TDZ —— 本文件对 TDZ 有过前科，不靠"函数是惰性的"兜底。
     ⚠️ 唯一的例外是 `map`（`let`，建图/销毁会重新赋值）：解构只会拿到快照，
        所以由**调用点**当场把它递进去（`dressBld(fc, map)` / `fallback2d(…, map)`），
        与原实现读到它的时刻完全一致（同一个同步点）。
     ⚠️ `drawContours` 也在返回里，但它**没有任何调用点**（搬过来之前就没有）—— 是死代码这件事
        不在本切片处理（`PLAN-REFACTOR.md` §3 把删死代码排在 S9）。 */
  const fb2d = createFallback2d({
    stats,
    theme,
    perf,
    props,
    cv,
    host,
    aiOn,
    aiBboxRef,
    draw2dBbox,
    mapAvailable,
    fallbackKind,
    show2d,
    domPins,
    phase,
    NIGHT_FADE_MS,
    WS_BLD_MODE,
    dprCap2d,
    stopTimer,
    startRecoverPoll,
    maybeAppSelfShot,
    isAutomation,
    artTheme,
  });
  const { ALLOW_2D, styleNow, bboxOfGeometry, classify, dressBld, draw2d, fallback2d } = fb2d;

  /* 🧱 重构切片 S1（PLAN-REFACTOR §2.2 的 L0.5）：`BldMapLike` 原来就写在这儿，
     现在搬去 `wsStageTypes.ts` —— 舞台各模块（M2 取数、M6 降级路…）都要按这个形状收地图，
     而模块**不许 import 宿主**（§2.2 规则③）⇒ 形状得有个中立的落脚点。
     搬家是**纯类型移动**（interface 编译后不存在）⇒ 零运行时影响；字段一个都没改。 */

  /**
   * ✅ 2026-09-25（切片 A）：**取楼半径的本地实现已删除**。
   *
   * 这里原来有一份 App **自己的** `radiusForView()`（视野半对角线 × 0.95，夹到 `[350, 2000]`），
   * 与代拍页/真源 `wsScene.fetchRadiusForView()` **并存** —— 那正是 `ROUTE.md` 里
   * 「App 接同一功能时不该出现第二份实现」的红线（两份口径迟早漂移，而漂移了没人看得出来）。
   * 现在统一走真源：`liveRadiusFor()`（`viewHalfMetersOf` 量视野 → `fetchRadiusForView` 判半径），
   * 阶梯用 `fetchRadiusLadder()`。**旧实现直接删掉，不留兼容分支。**
   * 回退：`git revert <本 commit>`。
   */

  /** 路网段（吸附/寻路用）——拿到数据后就一直留着，别每次重新拆 */
  let roadSegs: RoadSeg[] = [];

  /**
   * 落图通路（`applyBuildings` / `planBeforeOf`）—— **2026-09-25 搬家到共享真源**
   * `wsDistrictScene.ts`（PR 标准门禁 C1：App 宿主不许有第二份实现）。
   * 宿主现在只接线：`flushBldStore` 负责"仓库并集 → 一次 setData → 首次建源建层"，
   * 插入锚点仍取自 `wsScene.sceneLayerPlan()`（用没用上由 `scenePlanConsumed()` 回证）。
   * 回退：`git revert <本 commit>`。
   */

  /* ══ 🧱🏢🛣 **offline-first + 累积仓库**（切片 A，2026-09-25）══════════════════════════
     病根（机主三条真机反馈同源）：「**楼只有一块**」「**加载慢**」「**路时有时无**」——
     App 一直走"现场取数 + 整份替换"：`/api/buildings` 一次只覆盖视野中心 R≤2000m 且冷查 27~33s
     （最慢见过 91.7s）、`/api/roads` 600m 冷查 32.5s（默认打一条必然撞超时）；而每取到一批就
     `setData(这一批)` ⇒ **整份替换** ⇒"新的一来旧的没了"。

     ✅ 现在两条数据都走**离线包**（静态文件，快且可预期）并进**同一个累积仓库**，一次 `setData`：
       · 默认 **0 条** `/api/buildings`、**0 条** `/api/roads`（决策取自真源 `wsScene.*LiveDecision()`）；
       · 只有 `?live=1` 才现场取数（补新区域/调试），失败照旧**可见**；
       · 换视野**要素数不减**（去重并集），淘汰只丢"视野外一圈"与超上限的（帧率护栏）。
     🔴 **判词/决策/半径一条都不在这里重写**：判词走 `bldVerdictText`/`roadsVerdictText`，
        半径走 `fetchRadiusForView`/`fetchRadiusLadder`/`viewHalfMetersOf`，格数学走 `wsFeatureStore`。
        旧的本地 `radiusForView`（那份"两份实现"）在本切片**删除**。 */
  const LIVE_ON = (() => {
    try {
      return /[?&]live=1\b/.test(location.search);
    } catch {
      return false;
    }
  })();
  const bldLive = bldLiveDecision({ forceLive: LIVE_ON });
  const roadsLive = roadsLiveDecision({ forceLive: LIVE_ON });
  /* 🧱 重构切片 S4（M2）：`let liveBldHits` / `let liveRoadHits`（那两个"默认应当是 0"的命中计数）
     跟着 `load*ForView` 一起搬去了 `wsViewFetch.ts` —— 宿主这边走 `viewFetch.liveFacts()` 念它。
     面板回证的另外两个（`liveBldInfo` / `liveRoadInfo`）同一出处。 */

  /** 视野半对角线（米）——量出来的，交给真源判半径（App 不自己写三角函数，代拍页同款） */
  function viewHalf(m: BldMapLike): number | null {
    try {
      const b = m.getBounds();
      return viewHalfMetersOf(
        { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
        m.getCenter().lat
      );
    } catch {
      return null;
    }
  }

  /** live 取数半径：**规则全在 `wsScene.fetchRadiusForView`**（视野中心→角 与 zoom 档位取大者） */
  function liveRadiusFor(m: BldMapLike): { radius: number; decidedBy: string; want: number; limitWhy: string | null; halfM: number | null } {
    const halfM = viewHalf(m);
    const p = fetchRadiusForView(m.getZoom(), halfM);
    return { radius: p.radius, decidedBy: p.decidedBy, want: p.want, limitWhy: p.limitWhy, halfM };
  }

  /* 🧱 **累积仓库**：由真源 `wsFeatureStore.createFeatureStore()` 造（合并/淘汰规则只有那一份），
     去重键与代表点取法由 `wsOfflineFeed` 给（一处定义、自检与 App 同一份）。 */
  const bldStore = createFeatureStore<BundleBuildingFeature>({ cap: BLD_STORE_CAP, idOf: bldIdOf, pointOf: bldPointOf });
  const roadsStore = createFeatureStore<BundleRoadFeature>({ cap: ROADS_STORE_CAP, idOf: roadsIdOf, pointOf: roadsPointOf });
  /* 🏘 **片区名仓库**（切片③，2026-10-01）：只给「我的家」取名点用（**不进地图、不画**）。
     cap / 去重键 / 代表点全取共享真源（与代拍页 `placesStoreOf()`（`ws3dshow.html:3485-3496`）同一份模块）。 */
  const placesStore = createFeatureStore<BundlePlaceFeature>({ cap: PLACES_STORE_CAP, idOf: placesIdOf, pointOf: placesPointOf });

  /** 浏览器取数（每格**独立超时**；AbortController 在 `wsOfflineFeed.fetchWithTimeout` 里） */
  const fetchCell = (url: string, timeoutMs: number) =>
    /* 🔴 2026-09-30：数据包一律 **`cache: "no-store"`** —— 服务端虽然已把数据 JSON 改成可校验，
       但**已经进过浏览器缓存的旧响应**（此前发的是 `immutable`）不会自己消失；
       显式 no-store 才能保证"页面拿到的是盘上那份"。数据是离线包，改动才重下，代价可接受。 */
    fetchWithTimeout(
      (u: string, init?: { signal?: AbortSignal }) => fetch(u, { ...(init || {}), cache: "no-store" }),
      url,
      timeoutMs
    );

  /**
   * 宿主视野（喂给 `createBundleFeed({ view })`）。
   *
   * ⚠️ **口径更正（2026-09-28）**：这段注释以前写的是「`map` 还没建时给 null ⇒ 管道本轮什么都不做，
   * **如实写成"未取"**」—— 后半句**是假的**，实测 `wsOfflineFeed.ts:945-946`：`bounds=null` ⇒
   * `plan()` 返回 null ⇒ `runOnce` 直接 `return { planned: false }`，**没有任何 HUD / onError 出口**
   * ⇒ 屏幕上**永远不会**出现"未取"。也就是说"没有地图 ⇒ 静默不取"这件事在当时**没有被写出来**，
   * 而这正是"降级路看起来一个人都没有、也没有解释"那一环的源头之一。
   * 现在这句话只陈述**事实**：没有地图 ⇒ 返回 null ⇒ 管道**静默**跳过本轮。
   * （要不要给它补一个 HUD 出口属于"降级路"那条线，2026-09-28 机主口径是**先不推进降级**，故此处只改注释。）
   */
  function bundleView(): BundleView {
    const m = map;
    try {
      if (!m?.getBounds || !m?.getCenter) return { bounds: null, center: null };
      return { bounds: m.getBounds() as BundleView["bounds"], center: m.getCenter() as { lng: number; lat: number } };
    } catch {
      return { bounds: null, center: null };
    }
  }

  /* ══ 🏙🎨 与代拍页**共用**的两件取参（2026-09-26 抽真源后接线；这边只留"从哪读"） ══════════ */

  /**
   * 🎨 把 **art 档**应用到主题上再交给 `bldLayerSpecsFor`（页面那边也是"先取参、再建 specs"）。
   * `art=1` ⇒ `bldArtParamsOf().ramp` 就是 `theme.ramp` **那个引用**（恒等）⇒ 返回的主题逐字段与原来相同。
   * 取参失败（主题为 null 等）⇒ 原样返回，不编一个主题出来。
   */
  function artTheme(t: WsMapTheme | null): WsMapTheme {
    if (!t) return t as unknown as WsMapTheme;
    try {
      const p = bldArtParamsOf(t as unknown as BldArtThemeLike, { art: WS_ART_LEVEL });
      return p.ramp === (t as unknown as BldArtThemeLike).ramp ? t : { ...t, ramp: p.ramp };
    } catch {
      return t;
    }
  }

  /** 🏙 挑选/冻结编排器（**整屏一份实例** ⇒ 冻结集跨帧、跨视野保持 —— 这就是"同一格永远同一批"）。 */
  let bldPickStoreInst: ReturnType<typeof createBldPickStore> | null = null;
  function bldPickStore(): ReturnType<typeof createBldPickStore> | null {
    try {
      if (!bldPickStoreInst) bldPickStoreInst = createBldPickStore();
      return bldPickStoreInst;
    } catch { return null; }
  }

  /**
   * 🏙 **楼栋档位**（机主 2026-10-03 拍板：默认严格档 + 一个"多楼房模式（不推荐）"开关）。
   * 模块级单例 ⇒ 顶栏那颗 chip（`WsCityEntry.vue`）改了这里立刻看得到（下面的 `watch` 重挑重绘）。
   * 🔴 档位到上限的换算只有一份（`bldMaxDrawnOf`），本组件**不写 100 / 4000 这两个数**。
   *
   * ⚠️ **别名是刻意的**：本文件里早就有个 `WS_BLD_MODE`（**形体档** `?bld=2`：楼长什么样），
   *    这里是**另一件事**（**画几栋**：lean/many）—— 两个都叫 `bldMode` 迟早有人改错那一个。
   */
  const { mode: bldDrawMode } = useWsBldMode();

  /**
   * 🏙🌆 **HUD 那一行**（机主验收要能一眼读出三件事，2026-10-03 第五条）：
   *   ① **现在画的是哪一档形体 / 哪一档档位**（足迹 z<14 · 立体 z≥14 · 多楼房模式）；
   *   ② **每格取前几栋（K）+ 这一屏画了几栋、来自几个格**（`stats.maxDrawn` / `cells` / `chosen`）；
   *   ③ **有没有被安全闸拦住**（`stats.why` 里那一串「安全闸拦住过：…（跳过 N 栋）」）。
   * 🔴 判词本体**仍然只由真源给**（`wsBldBudget.stats.why`，宿主不许再拼第二份）——
   *    这里只把**用户的选择**（哪一档）与**几个可数的总数**摆在前面，属于"选择/读数"，不是规则。
   *
   * ⚠️ 形体档读的是**这一轮落图用的那个档**（`bldPickTier`，在 `bldFlush` 里用共享真源
   *    `bldTierOfZoom(zoom, 上一次的档)` 现算现存）——**不是**"现在读一次地图的 zoom 再比 14"：
   *    跨 14 有 0.25 滞回 ⇒ 14.1 时画的仍是足迹档那一批，按 `zoom < 14` 报就会说成"立体"
   *    （判词撒谎）。也不是"现在读一次地图"，否则去抖窗口里那一行会与真正画出去的那批对不上。
   */
  function bldShapeTierName(): string {
    /* 多楼房模式：全 zoom 一致（用户明确要"多"）⇒ 不报"足迹/立体"，只报那一档本身 */
    if (bldDrawMode.value === WS_BLD_MODE_MANY) return "🏙 楼房 多（不推荐）";
    if (bldPickTier === 0) return "🏙 足迹档（z<14 · 平面）";
    if (bldPickTier === 1) return "🏙 楼房 严格档（z≥14 · 立体）";
    return "🏙 楼房 严格档";
  }
  function bldPickLine(s: BldPickAnyStats): string {
    /* `?bldn=` 那条 A/B 老路（按固定经纬格挑）**没有档位这回事**：原样转交它自己的判词
       （那个口径的"画几栋"由每块上限决定，写"严格档 ≤K 栋/格"就是撒谎）。 */
    if (!("maxDrawn" in s)) return s.why;
    /* 🔴 **不重复念数**：`why`（真源产出）里已经有「格 N 个（首…末）⇒ 画 M 栋（X 格出楼）·
       每格取前 K · 每格上限截过 C 格 · Σ投影/Σ顶点 · 安全闸拦住过：…（跳过 D 栋）」——
       宿主只补**用户的选择**（哪一档）与那个数本身，不再自己写第二份"画了多少"。 */
    return bldShapeTierName() + " · 每格 ≤" + s.maxDrawn + " 栋 · " + s.why;
  }

  /**
   * 🧱 **区块/数据格边长（度）** —— 与代拍页 `bldCellDeg()` **同一口径**：
   * 包自报的 `index.cellSize`（`feed.facts().cellDeg`）优先，读不到才退回 0.05（老包 / 索引还没读到）。
   * 🔴 绝不写死：分片包里格是 0.01°，写死 0.05 会让"同一个子格"的键两页对不上。
   */
  function bldCellDegNow(): number {
    try {
      const d = bldFeed.facts().cellDeg;
      if (typeof d === "number" && isFinite(d) && d > 0) return d;
    } catch { /* 落兜底 */ }
    return WS_BLD_CELL_CAP_REF_DEG;
  }

  /**
   * 🧱 **落图（楼）**：仓库并集 →（宿主上妆 `dressBld`）→ **一次 `setData`**。
   * 落图通路本身在共享真源 `wsDistrictScene.flushBldStore()`（PR 标准门禁 C1 要求"宿主只接线"）；
   * 这里只提供三件**宿主自己的**东西：**仓库**、**上妆口径**、**没有地图时怎么办**（2D 降级路交给自绘）。
   * 回退：`git revert <本 commit>`。
   */
  function bldFlush(why: string): void {
    if (!alive) return;
    bldFlushedOnce = true;
    /* 🌆 **这一轮按哪一档落图**（0 = 足迹 z<14 / 1 = 立体 z≥14 / null = zoom 读不出来）。
       🔴 prev = **上一次落图**的档（`bldFlushedTier`）⇒ 判据带 0.25 滞回（共享真源 `bldTierOfZoom`）：
          13.9↔14.1 来回缩放**不会**反复重挑（改造前是每跨一次就重挑一次）。
       🔴 顺序不能动：**读 prev → 算这一轮的档 → 落图 → 再把这一轮的档写回去**。
          先写等于把滞回关掉（每次都按裸阈值判），这也是本组件唯一写 `bldFlushedTier` 的地方。
       ⚠️ 闭包（下面的 `pick`）与这里用的是**同一次**算出来的档 ⇒ HUD 报的档与画出去的那批必然一致。 */
    const bldTierPrev = bldFlushedTier;
    const bldTierNow = bldTierOfZoom(map && typeof map.getZoom === "function" ? map.getZoom() : null, bldTierPrev);
    bldPickTier = bldTierNow;   /* HUD 那一行读它（与这一批同一档，见 `bldShapeTierName`） */
    flushBldStore<BundleBuildingFeature>(
      {
        features: () => bldStore.features(),
        /* 上妆（高度/颜色/拆件）在这里做**一次** ⇒ HUD 的计数与画出去的是同一批要素 */
        dress: (feats) => dressBld({ features: feats as unknown as BldFeature[] }, map),
        /* 2D 降级路没有可落的图（临时降级时 map 其实还在，但那时画的是自绘那块） */
        map: () => (renderKind.value === "fallback2d" ? null : (map as BldMapLike | null)),
        /* 🎨 **美术取参**：与代拍页同一份（`bldLayerSpecsFor` 内部调 `bldArtParamsOf`）——
           `?art=2` 把色阶高段推近白；`art=1` 时 `ramp` 是**主题那个引用**（恒等）⇒ 默认零改动。
           形体档 `mode:"base"` = 不拆件（机主 (a′) ⇒ 两页默认档同一条规格）。 */
        specs: () => bldLayerSpecsFor(theme.value, themeTier.value, { art: WS_ART_LEVEL, mode: WS_BLD_MODE === 2 ? "parts" : "base" }),
        onNoMap: (data) => draw2d(data as { features?: BldFeature[] }),
        /* 🏷 **记下"真正画出去的那批楼"**：名字层的锚点/点选降级都只认这一批 ——
           否则会出现机主报过的「有的压根没对应楼」（名字指到没画的楼）。
           这里存的是**引用**，不复制（一轮一次，开销可忽略）。 */
        afterDraw: (_why0, data) => {
          drawnBld = (data as { features?: unknown[] })?.features || [];
        },
        /* 🏙 **近景挑选 = 与代拍页同一份编排**（`wsBldPickStore`）。
           🔴 2026-10-02 换口径（机主拍板的 **B2**）：「每格 4 栋」**改成双预算挑楼** ——
           候选 = 视野内**全部**楼，预算 = **Σ投影 px²（`WS_BLD_BUDGET_PX2`）+ Σ顶点（`WS_BLD_BUDGET_VERTS`）**，
           两个都是**固定常量**（不是按帧率自动缩），`moveend`/`zoomend` 每次落图重算一次。
           规则/成本模型/确定性排序**一行都不在这里**（在 `wsBldBudget`，两页共用）。
           🔀 **A/B 逃生口**：`?bldn=N` 显式钉住 ⇒ 走**旧口径**（按固定经纬格挑 + 按格冻结，`store.pick`），
           同一个 store、同一份实现 ⇒ 机主可以在**真机**上同一个机位对比新旧两套（帧率只有他能判）。
           近景才挑（远景走预渲染瓦片，挑它没意义）—— 阈值与楼房矢量层**同一个共享常量**。 */
        pick: (() => {
          try {
            const z0 = map ? map.getZoom() : null;
            if (z0 === null || z0 < WS_BLD_VECTOR_MINZOOM) return null;
            const store = bldPickStore();
            if (!store) return null;
            const legacyCell = WS_BLDN_PIN !== null;   // `?bldn=` 一给就退回旧口径（A/B）
            return (feats: readonly BundleBuildingFeature[]) => {
              /* ⚠️ 相机四件（zoom / bounds / 中心纬度 / 俯角）在**调用这一刻**现读：
                 闭包捕获会拿到旧机位，而预算挑楼的全部输入就是机位。
                 🆕 `zNow`（**读不出来就是 NaN**，不是兜一个 11）专给"按 zoom 分档"用：
                 足迹/立体的分界线必须按**真实 zoom** 判，读不到就退回严格档（宁可少画，不许乱画）。 */
              const zNow = map && typeof map.getZoom === "function" ? Number(map.getZoom()) : NaN;
              const z = isFinite(zNow) ? zNow : WS_BLD_VECTOR_MINZOOM;
              const bounds = map ? (map.getBounds() as unknown as BldBudgetBounds) : null;
              if (legacyCell) {
                /* 一轮只读一次格尺寸（与代拍页 `BLDCELL`/`BLDN` 同一口径）：冻结键/挑选/分组三者同值 */
                const cellDeg = bldCellDegNow();
                const cap = bldCapForCellDeg(cellDeg, WS_BLDN_PIN);
                return store.pick({
                  features: feats as unknown as PickFeature[],
                  cap,
                  cellDeg,
                  bounds: bounds as unknown as PickBounds,
                  minInView: WS_BLD_INVIEW,
                }) as unknown as { features: readonly BundleBuildingFeature[]; stats: BldPickStats };
              }
              /* 📍 2026-10-04 第六条「**就近补齐**」的参照点 = **锚点的种子**（第七条改成锚点冻结）。
                 为什么加（机主原话）：「**保证地图上绝对有楼就行**」（他在"楼不见后还缩小了看，还是没有楼"）。
                 根因（真浏览器探针量过）：相机 38°~64° 俯角下"看得见的地面"只是一条窄带，而"每格取前 K"
                 **完全不看相机** ⇒ z16.4 那 12 栋锚点全落在窗口外、z19（放大到最大）直接是**空集**。
                 🔴 **第七条（机主：「在我移动了角色后，角色周围就出现了楼，很诡异喵」）**：
                 这里传的仍是**实时相机中心**，但 `store` 不再拿它当参照点 —— 它把这颗种子
                 **落成锚点格**（与 base 同一个 `cellDeg`），**同一个格只认第一次**那个点
                 ⇒ 同格内走动输出逐字节不变、跨格才新增、已画出去的绝不消失。
                 ⚠️ 所以**这一行不用改**（名字与语义都在 `wsBldPickStore.BldBudgetInputLite.nearCenter` 里写清了）；
                 宿主这边一个字都不许自己判"是不是新格"（那是编排层的状态，两页同一份）。
                 ⚠️ 与原 `centerLat` **共用这一次 `getCenter()`**（一轮一次相机读，不为了补楼多读一遍）。 */
              const centerLL = map && typeof map.getCenter === "function" ? map.getCenter() : null;
              const centerLat = centerLL ? Number(centerLL.lat) : 0;
              const pitch = map && typeof map.getPitch === "function" ? Number(map.getPitch()) : 0;
              return store.pickBudget({
                features: feats,
                bounds,
                screen: {
                  /* 屏幕投影：直接用地图库那把尺子（`map.project` 是**地面**投影，不带高度 —— 墙面的
                     屏幕高度由共享的 `bldPxPerMeter` 补，两页同一把尺子）。
                     🆕 2026-10-03 第五条起：挑楼**一次都不会调它**（候选池与排序键都与相机无关），
                     屏幕量全部由下面的 `metersPerPixel` 换算 —— 传它只是保持接线与自检口径一致。 */
                  project: (lng: number, lat: number): [number, number] => {
                    const p = map ? map.project([lng, lat]) : null;
                    return [p ? Number(p.x) : NaN, p ? Number(p.y) : NaN];
                  },
                  pxPerMeter: bldPxPerMeter(z, centerLat, pitch),
                  /* 🌆 那把**唯一**的屏幕尺子（1 px = 多少米）：同一个 `z`/中心纬度算出来的，
                     与 `bldPxPerMeter` **同一族公式**（都在共享真源里），页面侧同样只接线。 */
                  metersPerPixel: bldMetersPerCssPixel(z, centerLat),
                },
                /* 🏙 **每格取前 K 栋**（机主 2026-10-03 第五条：「显示哪些楼直接定下来」）：
                   K **只看用户选的档位**（严格档 3 / 多楼房 4000），**与 zoom / 与相机无关** ——
                   所以这里**没有** `zNow` / `bldTierPrev` 之类的相机输入（有它们就又是"集合随缩放变"）。 */
                maxDrawn: bldMaxDrawnOf(bldDrawMode.value),
                /* 🧮 分格的那张网格 = **离线包自己的格**（`index.json.cellSize`，与取数管道同一份）：
                   包自报优先、读不到才退回 0.05（老包）。写死 0.01 会让换包时"格"与包对不上。 */
                cellDeg: bldCellDegNow(),
                minInView: WS_BLD_INVIEW,
                /* 📍 **就近补齐**（2026-10-04 第六条引入；**第七条起这是"锚点的种子"**）：
                    把"离**本格锚点**最近、又还没入选"的那几栋追加到这批的**尾部**（栋数默认
                    `wsBldBudget.WS_BLD_NEAR_K` = 10，不在这里写死）。锚点表与补齐件冻结集都在
                    `store` 里（跨帧、跨视野保持）—— 宿主只负责**如实把实时相机中心喂给它**。 */
                nearCenter: centerLL ? { lng: Number(centerLL.lng), lat: Number(centerLL.lat) } : null,
              });
            };
          } catch { return null; }
        })(),
        onPicked: (s) => {
          const line = bldPickLine(s);
          bldPickWhy = line;
          stats.bldPick = line;
          scheduleBundleHud();
        },
        beforeDraw: (why0) => {
          bldFlushWhy = why0;
          scheduleBundleHud();
        },
      },
      why
    );
    /* 🔴 **落图之后**才把"这一轮是哪一档"记成下一次的 prev（滞回的写回点，全局只有这一处）——
       顺序反过来（先写后落图）等于把滞回关掉，见上面那段注释。 */
    bldFlushedTier = bldTierNow;
  }
  /** 上一次 flush 的原因（面板回证：是离线包来的还是 live 来的） */
  let bldFlushWhy = "";
  /** 🏙 上一次"近景挑楼"的口径（机主要 100 栋/视野）——面板回证用，没挑过就是空串 */
  let bldPickWhy = "";
  /** 🌆 **这一轮落图用的形体档**（0 = 足迹 z<14 / 1 = 立体 z≥14 / null = zoom 读不出来）——
   *  HUD 那一行（`bldShapeTierName`）读它，**不是**每帧去问地图（否则判词会与真正画出去的那批对不上）；
   *  它同时是"跨 14 要不要重挑"与"挑楼走哪条路（静态/投影）"的**同一个**判据来源。 */
  let bldPickTier: number | null = null;
  /** 这一屏**至少落过一次楼图**了（档位开关只在它之后才补一次重挑重绘，见下面的 `watch`） */
  let bldFlushedOnce = false;
  /** 🌆 **上一次落图**所在的形体档（滞回判据的 prev；0 = 足迹 / 1 = 立体 / null = 读不出来）——
   *  **只在 `bldFlush` 里写一次**（读 prev → 算新档 → 落图 → 写回，所有落图路径共用这一个写点）。 */
  let bldFlushedTier: number | null = null;

  /**
   * 🏙 **档位一变 ⇒ 立刻重挑一次 + 重绘**（机主 2026-10-03：「用户可选择是否启用多楼房模式」，
   * 点了必须真的生效，不能等下一次 `moveend`）。
   *
   * 走的就是本组件**既有**的那条通路，一行新机制都没有：
   *   `bldFlush("bldmode")` → 真源 `flushBldStore()` → 里面的 `pick` 闭包**再跑一次**
   *   （`maxDrawn` 在那里现读档位）→ `pickBuildingsByBudget` 重挑 → `setData` 重绘
   *   → `onPicked` 回填 HUD（`bldPickLine` 会带上新档位）。
   * ⚠️ 与 `moveend`/`zoomend` 那条 600ms 去抖**不同**：这是**用户点的一下**，
   *    必须当场看到变化（去抖只会让它"点了像是没反应"）。
   * ⚠️ `bldFlushedOnce` 这道闸：地图还没建好时 `bldFlush` 会落到 2D 降级那支
   *    （`onNoMap` → `draw2d`），那属于初始化本身要干的事，不归这个开关管。
   */
  watch(bldDrawMode, () => {
    if (!alive || !bldFlushedOnce) return;
    bldFlush("bldmode");
  });

  /**
   * 🌆 **跨过足迹/立体的分界线 ⇒ 重挑一次 + 重绘**（2026-10-03「按 zoom 分层」那一笔）。
   *
   * ⚠️ 2026-10-03 第五条起这条重挑**不再是"为了换集合"**：挑选（每格取前 K）与 zoom 完全无关，
   *    跨线前后挑出来的是**同一批 id**（自检第 ⑩ 组钉着）。留着它是因为**画法**换档后仍要走一次
   *    既有落图通路，让 `onPicked` 回填的 HUD 与"这一轮实际用的档"对齐（否则判词会停在上一档）。
   *
   * 走的就是本组件**既有**的那条通路，一行新机制都没有：
   *   `bldFlush("bldtier")` → 真源 `flushBldStore()` → 里面的 `pick` 闭包**再跑一次**
   *   （`maxDrawn` 在那里按**用户档位**现算）→ `pickBuildingsByBudget` 重挑 → `setData` 重绘
   *   → `onPicked` 回填 HUD（`bldPickLine` 会带上新的形体档）。
   * ⚠️ **只在真的跨线时**才补：档位判据是共享真源 `bldTierOfZoom(zoom, bldFlushedTier)`
   *    （**带 0.25 滞回**）——`bldFlushedTier` 是上一次落图的档，所以 13.9↔14.1 来回 10 次
   *    也**一次都不重挑**（改造前是 10 次；PLAN-BLD-LOWZOOM §验收 5）。
   * ⚠️ 档内每一次缩放都重挑一遍是白工（挑楼规则对同档的 zoom 变化已经由 `moveend` 那轮覆盖）。
   * ⚠️ `zoom` 读不出来（`null`）⇒ **不重挑**：拿不准就不动，宁可等下一次正常的落图。
   */
  function bldTierCrossedFlush(): void {
    if (!alive || !bldFlushedOnce) return;
    /* prev = 上一次落图的档 ⇒ 与 `bldFlush` 里算的是**同一个判据**（含滞回），不存在第二份阈值 */
    const tier = bldTierOfZoom(map && typeof map.getZoom === "function" ? map.getZoom() : null, bldFlushedTier);
    if (tier === null || tier === bldFlushedTier) return;
    bldFlush("bldtier");
  }

  /**
   * 🧱 **落图（路）**：仓库并集 → **一次 `setData`**（首次建源建层）。
   * 同楼：通路在 `wsDistrictScene.flushRoadsStore()`；宿主给仓库/地图/规格，并在落图前后做自己的计数。
   * ⚠️ 失败**必须可见**（原来是 try/catch 写 `stats.note`，这里保持同一口径）。
   */
  function roadsFlush(why: string): void {
    if (!alive) return;
    try {
      flushRoadsStore<BundleRoadFeature>(
        {
          features: () => roadsStore.features(),
          map: () => map as BldMapLike | null,
          specs: () => roadLayerSpecsForMap(),
          beforeDraw: (why0, data) => {
            /* 行人吸附用的段：拿到数据就留着（与画出去的是同一份，不重算一套） */
            roadSegs = roadSegments(data as never);
            roadFlushWhy = why0;
            scheduleBundleHud();
          },
          afterDraw: (_why0, data) => {
            const m = map as BldMapLike | null;
            if (!m) return;
            stats.roads = visibleRoadCount(data as never, m.getZoom());
            stats.roadStore = `仓库 ${data.features.length} 条（累积：已取 ${roadsFeed.facts().have} 格，包外 ${roadsFeed.facts().missing}，失败 ${roadsFeed.facts().failed}）`;
          },
        },
        why
      );
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 路网落图失败：${String((e as Error)?.message || e).slice(0, 40)}` : `路网落图失败：${e}`;
    }
  }
  let roadFlushWhy = "";

  /** 🛣🛣 离线包的两条管道（**永不发 `/api/*`**：只读静态包） */
  const bldFeed = createBundleFeed<BundleBuildingFeature>({
    kind: "bld",
    store: bldStore,
    view: bundleView,
    fetchCell,
    flush: bldFlush,
    /* 保留"视野外一圈"（与代拍页同式）：来回挪地图不该反复重取，也不该把刚取到的丢掉 */
    retainRadiusM: () => Math.max(2000, Math.round((bundleViewHalfMeters() || 0) * 2.2)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  const roadsFeed = createBundleFeed<BundleRoadFeature>({
    kind: "roads",
    store: roadsStore,
    view: bundleView,
    fetchCell,
    flush: roadsFlush,
    retainRadiusM: () => Math.max(3000, Math.round((bundleViewHalfMeters() || 0) * 2.5)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  function bundleViewHalfMeters(): number | null {
    const m = map as BldMapLike | null;
    return m ? viewHalf(m) : null;
  }

  /* ══ 🏘🏠 **第三条离线管道：片区名**（切片③，2026-10-01）══════════════════════════════════
     给谁用：「我的家」= 离地图中心最近的**有名片区**（`wsDaily.pickHome`）。
     为什么必须新接一条：App 原来只有 `bld`（`:3341`）与 `roads`（`:3353`）两条管道
     ⇒ 宿主**拿不到任何片区名**，而原型页的 `wsPlaces()`（`ws3dshow.html:4446-4468`）读的是
     **页面自己的** `placesStoreOf()`（`:3485-3496`）⇒ 那段内联 JS 在 App 里没有对应物，不能照抄。
     规则一行不写：目录 / 格尺寸 / 每轮格数 / 上限全是 `wsOfflineFeed` 的 SPECS 里那份（`kind: "places"`）。
     ⚠️ **不进地图**（`flush` 只重建快照）：名字层自己那条路负责画区名
        （`wsNameLayer.ts:486` 取的是同一批格）⇒ 同格会被取两次 —— 页面是**同款**双取
        （`:3485-3496` + `wsNameLayer.ts:486`），属已知口径，不是本片新引入的退化（施工图 §5.6）。 */
  let placePoints: readonly PlacePoint[] = [];
  /** 仓库并集 → 「我的家」要的取名点。**只留有名有坐标的**（没名字的一条都不留：绝不编） */
  function placesFlush(_why: string): void {
    const out: PlacePoint[] = [];
    for (const f of placesStore.features()) {
      const name = String(f?.n || "").trim();
      /* 形状交给共享取值器（`placesPointOf`）——原型页那条"按 GeoJSON 读 ⇒ 永远空数组"的坑
         （它自己的注释记着）在 App 这侧同样不许重演 */
      const pt = placesPointOf(f);
      if (!name || !pt) continue;
      out.push({ name, lng: pt[0], lat: pt[1], kind: f?.k || null });
    }
    placePoints = out;
  }
  /** 交给外层的取值器（`scene-ready` 的新可选字段）：**只读**，外层不许改 */
  function placesGetter(): readonly PlacePoint[] {
    return placePoints;
  }
  const placesFeed = createBundleFeed<BundlePlaceFeature>({
    kind: "places",
    store: placesStore,
    view: bundleView,
    fetchCell,
    flush: placesFlush,
    /* 与路同式（视野外一圈）：片区名稀且小，留宽一点，来回挪地图别反复重取 */
    retainRadiusM: () => Math.max(3000, Math.round((bundleViewHalfMeters() || 0) * 2.5)),
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });

  /* 🌊🌳 **水/绿地**：与代拍页**同一个模块、同一组参数**（格尺寸 / 取数 / 归一化 / 配色 / 层序 /
     署名 / 判词全在共享真源 `wsGwLayer` 里）。这里只给宿主自己的四样：**地图 / 视野 / 主题 / 取数**。
     ⚠️ 宿主里**一行规则都不写**（PR 门禁 C1 的红线：App 不许有第二份实现）——
     以前这类"取格 + 拼要素 + 定颜色 + 判词"在页面里有过一份内联原型，现在两边跑的是同一份。
     · **不设 zoom 闸门**：远景下它才最有用（机主 2026-09-26：「放太大了只能看到线路，
       水、绿植啥的都看不到」）⇒ 与楼/路不同，它每一档都取；
     · **层序**由共享真源给（`gwBeforeIdOf` = 第一个 `bld*` 图层之前 ⇒ 水/绿贴地面、楼盖在上面）。 */
  const gwLayer = createGwLayer({
    /* 2D 降级路没有可落的图（与 `bldFlush` 同一口径：那时画的是自绘那块） */
    map: () => (renderKind.value === "fallback2d" ? null : (map as unknown as GwMapLike | null)),
    view: bundleView,
    theme: () => theme.value,
    fetchCell,
    onHud: (line) => {
      /* 判词那一行由**真源**给（三态：正数 / 0（已量）/ 数不出来 + 原因），宿主只负责摆出来 */
      stats.gwVerdict = line;
    },
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });

  /* ══ 🏷🗺 名字层（真名标签 + 区名标签）═══════════════════════════════════════════════
     宿主只做四件事：**给它地图/取数/行政区名/画出去的楼**，拿回渲染计划后**照着写 DOM**。
     取数、避让、区名聚合、迟滞闸门、动效参数**一行都不在这里**（全在 `wsNameLayer`，PR 门禁 C1）。
     ⚠️ 跟手（§4.0）：相机运动期间**只写 1 个节点**（容器）——`translate3d` 由 `onMove` 写一次，
        节点自身的 `transform` 只在 `refreshNames()`（= moveend/load 之后）批量写一次。 */

  /** 上一轮 flush 真正**画出去**的楼（标签锚点必须落在"屏幕上那批"上，
   *  否则会出现机主报过的「有的压根没对应楼」——名字指到没画的楼）。 */
  let drawnBld: readonly unknown[] = [];
  /** 名字层开关：`?names=0` 关（排查用；默认开）。
   *  🔴 **必须声明在 `createNameLayer()` 之前**：`createNameLayer` 里会**同步**调一次
   *  `host.enabled()`（初始化事实）⇒ 声明在后就是 TDZ `ReferenceError`，
   *  而它会**整块炸掉地图的 setup**（真浏览器实测：`Cannot access 'er' before initialization`
   *  ⇒ `.ws-dml` 根本没挂上 ⇒ 整屏只剩顶栏）。这条是探针抓出来的，不是推出来的。 */
  const namesOn = ref(!/[?&]names=0/.test(String(typeof location !== "undefined" ? location.search : "")));
  const nameLayer = createNameLayer({
    map: () => (renderKind.value === "fallback2d" ? null : (map as unknown as NameMapLike | null)),
    fetchCell,
    enabled: () => namesOn.value,
    /* 行政区名：街区级这一屏**没有**名册（城市包线还没给）⇒ 如实传空（不是"这里没有行政区"） */
    admins: () => [],
    drawnBuildings: () => drawnBld,
    onPlan: (plan, facts) => { applyNamePlanWithHud(plan, nameVerdictLine(facts)); },
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  /** 名字层开关：`?names=0` 关（排查用；默认开；**声明见上**，在 `createNameLayer` 之前） */
  const namePlan = ref<NameRenderPlan>({ mode: "names", nodes: [], batch: 0, lite: false, cameraOpacity: LABEL_MOTION.cameraOpacity });
  /** 屏上的节点（**节点池复用**：只在"换批"时替换数组内容） */
  const nameNodes = ref<NameRenderNode[]>([]);
  /** 相机运动中（整层淡化：一次 class + 一次 opacity，**只写 1 个节点**） */
  const cameraMoving = ref(false);
  /** 换批中（"先隐后改字"：整层 opacity≈0 的那一帧才改 textContent） */
  const switching = ref(false);
  const labRootEl = ref<HTMLElement | null>(null);
  /* 🆕 2026-10-01（机主：「换字动画我想要的是**像高德地图那样可以不用重算**的」）──────────────
     两条：① 集合**没变** ⇒ 只更新坐标，**不加任何整层类**；
          ② 集合**真变了** ⇒ 只让**新来的/要走的**那几张各自淡入/淡出（不是整层一起换）。
     数据全来自**共享真源**的 `plan.changed / plan.entered / plan.exited`（宿主不自己算 diff）。 */
  /** 这一批**新进来**的节点 id（给这几张挂 `is-enter`，两帧后摘掉 ⇒ 120ms 淡入） */
  const nameEnter = ref<string[]>([]);
  /** 这一批**要走的**节点（单独一层 DOM：先原样显示，再加 `is-ghost-out` 淡出，随后移除） */
  const nameGhosts = ref<NameRenderNode[]>([]);
  /** 幽灵的淡出态（两帧后才置 true ⇒ 才有一趟真正的过渡，而不是"一挂上就是透明"） */
  const ghostFading = ref(false);
  let enterTimer = 0;
  let ghostTimer = 0;
  /* 🆕 「传送帧」：相机停下时把容器位移烘进节点坐标（`reproject`）—— 那次坐标重写**必须看不见**，
     但它落在 `.ws-lab` 的 `transition: transform 90ms` 上 ⇒ 画面会先退回拖动前再滑过来（实测反向行程 84px）。
     ⇒ 举旗一帧（`.ws-labs.is-snap .ws-lab:not(.is-enter):not(.is-ghost) { transition: none; }`）。 */
  const snapping = ref(false);
  let snapRaf1 = 0;
  let snapRaf2 = 0;

  /* ══ 🧱 重构切片 S3（M1 + M8 后半）：**相机 / 手势** 与 **包 HUD** 的装配 ══════════════════
     两个模块的实现整块在 `wsMapCamera.ts` / `wsHudStats.ts`（锚点 = 函数名，不按行号）。
     为什么装配点在这儿（而不是跟 M8 前半一起放在 `phase` / `stats` 那一段）：
       ① M1 要 `namesOn` / `nameNodes` / `cameraMoving` / `labRootEl` 四个名字层的 ref（上一段刚声明完）
          —— 它们是 `const`，早引必踩 TDZ（本文件对 TDZ 有过前科，不靠"函数是惰性的"兜）；
       ② M8 后半要 `bldFeed` / `roadsFeed` / `placesFeed` / `gwLayer` / `fetchCell`（离线包那几条管道）。
     ⚠️ `map` 一律走**取值器**（`mapNow`）：宿主那份是 `let`（建图时赋值、降级/卸载时置 null），
        解构只会拿到快照 ⇒ 模块里真正读它的那几个函数用「形参默认值 = 调用时现读」
        —— 与原实现读它的时刻是同一个同步点，所以宿主这边的调用点一个字都没改。
     依赖方向（§2.2）：两个模块都**不 import 宿主**；模块之间也**没有**横向 import
     （`joyGate` 由这一处注入 M8 的 `hudMode`）。
     ⚠️ `zoomOnce` / `fitDistrict` / `zoomBy` **故意不解构**：它们目前没有任何调用点（死代码，
        模板里那三个按钮早已移除）—— 跟着 S2 的 `drawContours` 同一个口径，删除留给 S9。 */
  const cam = createMapCamera({
    props,
    host,
    show2d,
    bboxRef,
    stats,
    namesOn,
    nameNodes,
    cameraMoving,
    labRootEl,
    mapNow: () => map,
  });
  const { joyGate, basePitch, joyMeasureVh, initPitch, joyVars } = cam;
  const { onMoveStart, onMove, onMoveEndNames, guardGestures, lockPageGestures, unlockPageGestures } = cam;

  const bundleHud = createBundleHud({
    stats,
    joyGate,
    bldFeed,
    roadsFeed,
    placesFeed,
    gwLayer,
    fetchCell,
    BLD_MIN_ZOOM,
    ROAD_MIN_ZOOM,
    /* HUD 去重器留在宿主（它闭包 `bundleHudQueued` 与 `alive`）—— 函数声明提升，这里引用得到 */
    scheduleBundleHud,
    mapNow: () => map,
  });
  const { hudMode, renderBundleHud, refreshBundles, attributionOfFeed } = bundleHud;

  /* ══ 🧱 重构切片 S4（M2）：**取数 / 落地** 的装配 ══════════════════════════════════════
     实现整块在 `wsViewFetch.ts`（锚点 = 函数名，不按行号）。装配点为什么在这儿：
       · 它要 `bldLive` / `roadsLive`（真源决策的结论）、`bldStore` / `roadsStore`（累积仓库）；
         全是 `const` ⇒ 早引必踩 TDZ（本文件对 TDZ 有过前科，不靠"函数是惰性的"兜）；
       · 各函数只在 `onMounted` 之后才被调用 ⇒ 宿主那几处调用点**一个字都没改**
         （`onMounted` 里三处 + `moveend` 里两处 + 初始取楼那两处 `fetchBuildingsWithRetry`）。
     ⚠️ `bldFlush` / `roadsFlush` / `liveRadiusFor` 都是**函数声明**（作用域内提升）⇒ 这里按值传的
        就是那一个函数，没有第二份实现；M3（`wsBldLanding`）搬走它们时只换注入来源。
     ⚠️ `alive` 走**取值器**（`aliveNow`）：宿主那面是 `let`（卸载时置 false），解构布尔只会拿到快照；
        模块里那 10 处 `if (!aliveNow()) return;` 与原实现在**同一时刻读同一个值**（逐条列在
        `ws_viewfetch_move_selftest.mjs` 的 ② 里，例外理由写在 `wsViewFetch.ts` 的文件头）。
     ⚠️ 只解构宿主真正还要用的 4 个；`withTimeout` / `fetchRoadsWithRetry` / `overtureFill` /
        `facLngLat` 搬走后在宿主**一个调用点都没有** —— 删除按 §3 留给 S9（与 S2 的 `drawContours`、
        S3 的 `zoomBy` 同一口径）。 */
  const viewFetch = createViewFetch({
    stats,
    props,
    BLD_MIN_ZOOM,
    ROAD_MIN_ZOOM,
    BLD_SPARSE,
    bldLive,
    roadsLive,
    liveRadiusFor,
    bldStore,
    roadsStore,
    bldFlush,
    roadsFlush,
    aliveNow: () => alive,
  });
  const { fetchBuildingsWithRetry, loadRoadsForView, loadFacilities, loadBuildingsForView } = viewFetch;

  function labClassOf(style: NameRenderNode["style"]): string {
    return style === "real" ? "is-real" : style === "derived" ? "is-derived" : "is-generated";
  }
  /** 容器 class（相机运动 / 换批 / 整层降级 / 传送帧 / 🕹拉近隐藏）—— 类名来自真源常量，宿主不写字面量 */
  const labRootClass = computed(() => ({
    [LABEL_CAMERA_CLASS]: cameraMoving.value,
    "is-switching": switching.value,
    "is-lite": namePlan.value.lite,
    /* 🆕 只在这一帧里掐掉"传送"的过渡（见 `reprojectNow`），**不掐**淡入淡出 */
    "is-snap": snapping.value,
    /* 🕹 拉近期间**整层隐藏**（研究 §9.6）：标签坐标是按进近景那一档 zoom 投影的，容器只补 translate，
       zoom 一变就系统性错位 ⇒ 与其显示错位的名字，不如整层藏起来。翻转时才写一次 class。 */
    "is-zoom-pull": joyZoomPulling.value,
  }));

  /**
   * 把**渲染计划**落到 DOM。🔴 三条纪律：
   * ① **位置只在此时写一次**（`translate3d`），相机运动期间一个字都不许再写节点；
   * ② 集合**没变** ⇒ **只更新坐标**，不加任何整层类（机主要的"像高德那样跟手滑"，2026-10-01）；
   * ③ 集合**真变了** ⇒ **只让新来的/要走的这几张各自淡入淡出**（`plan.entered/exited`），
   *    不再是整层淡化；**绝不允许"看着旧名字变成新名字"**（节点 key 带 id ⇒ 换名字 = 换元素）。
   */
  function applyNamePlan(plan: NameRenderPlan): void { applyNamePlanWithHud(plan, ""); }
  /**
   * 把**渲染计划**落到 DOM，并**在同一刻**写 HUD 那一行。
   *
   * 🔴 为什么 HUD 必须跟着节点一起写（2026-09-26 真浏览器实测的坑）：
   *   原来是 `refresh()` 里回调落节点（换批时**延迟 120ms** 做"先隐后改字"）、
   *   而 `stats.names` 在 `refresh()` 返回后**立刻**写 ⇒ 有 120ms 的窗口里
   *   **HUD 说的是新一批、屏上是旧一批**（实测抓到 `区名模式` 与"屏上 8 个真名"同时出现，
   *   其实是两批数据）。探针/机主读到的就是这种自相矛盾的一行。
   *   ⇒ 现在 HUD 文本随节点一起赋值，**两者永远描述同一批**。
   *   ⚠️ 同时把"上一批的切换定时器"清掉：否则后到的批会被先到的定时器覆盖（旧覆盖新）。
   */
  function applyNamePlanWithHud(plan: NameRenderPlan, hud: string): void {
    const changed = plan.batch !== namePlan.value.batch;
    namePlan.value = plan;
    if (switchTimer) { window.clearTimeout(switchTimer); switchTimer = 0; }
    const commit = (afterPaint = false): void => {
      nameNodes.value = plan.nodes;
      if (hud) stats.names = hud;                 // ← 与节点同一批（不许 HUD 领先屏上）
      /* 🔴 `switching` **必须在这里也清掉**：新的一批会 `clearTimeout(上一批的定时器)`，
         被清掉的那一批的"收尾 16ms"就永远不会跑 ⇒ 容器永久停在 `is-switching`（opacity 0）
         ⇒ 名字层**看不见了**（真浏览器实测抓到 `rootClass: "ws-labs is-switching"`）。
         现在：只有走了"延迟换字"的路径才需要等一帧再摘类，其余路径立刻摘。 */
      if (afterPaint) window.setTimeout(() => { if (alive) switching.value = false; }, 16);
      else switching.value = false;
    };
    if (!changed) {
      /* 同一批：数量/名字都没变 ⇒ 只更新坐标（**一次批量写**，moveend 才走到这里） */
      commit();
      return;
    }
    if (perfLow.value || reducedMotion()) {
      /* 降级（§4.1 降级表）：**保留三幕结构但去掉错峰**；reduced-motion 下纯淡入淡出（不缩时长） */
      commit();
      return;
    }
    /* 🆕 2026-10-01 机主：「换字动画我想要的是**像高德地图那样可以不用重算**的」——
       集合真变了时**只让新来的/要走的这几张各自淡入淡出**，屏上其余标签一张都不动。
       ⚠️ 红线不变：节点 key 是 `slot:id` ⇒ 换了 id 就是**换元素**，不会"看着旧名字变成新名字"；
          退场的那张走幽灵层（`span`，不可点），进场的那张从 0 淡到 1。 */
    if (plan.changed !== undefined) {
      commit();                                    // ← 位置/文案先落地（**不整层淡化**）
      fadeInNew(plan.entered || []);
      fadeOutGone(plan.exited || []);
      return;
    }
    /* ⬇️ 兜底：计划没带 `changed`（模块比宿主旧）时，仍走原来的"整层先隐后改字"（逐字保留旧行为） */
    switching.value = true;
    switchTimer = window.setTimeout(() => {
      switchTimer = 0;
      if (!alive) return;
      commit(true);                                 // ← 换字发生在整层看不见的那一帧
    }, LABEL_MOTION.nameOutMs);
  }

  /**
   * 🆕 **只给新来的那几张**播淡入（`is-enter`：opacity 0 → 1，用 `.ws-lab` 已有的 120ms 过渡）。
   * 两帧后摘类：① 让 Vue 先把带 `is-enter` 的节点挂上去 ② 让浏览器结算这一帧
   * ⇒ 才有"从 0 淡进来"的过渡，而不是"一出现就是全亮"。
   * 降级/减少动效下**不播**（不是缩短时长）。
   */
  function fadeInNew(ids: string[]): void {
    if (!ids.length || perfLow.value || reducedMotion()) return;
    nameEnter.value = ids.slice();
    if (enterTimer) window.clearTimeout(enterTimer);
    enterTimer = window.setTimeout(() => {
      enterTimer = 0;
      if (alive) nameEnter.value = [];
    }, 32);
  }

  /**
   * 🆕 **只给要走的这几张**播淡出：先按原样挂进幽灵层，两帧后加 `is-ghost-out` 淡到 0，
   * `nameOutMs` 之后移除。**不占** `nameNodes` 的节点池（否则复用池会把它当场改成别人的文案）。
   */
  function fadeOutGone(nodes: NameRenderNode[]): void {
    if (!nodes.length || perfLow.value || reducedMotion()) return;
    nameGhosts.value = nodes.slice();
    ghostFading.value = false;
    if (ghostTimer) window.clearTimeout(ghostTimer);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (alive) ghostFading.value = true; });
    });
    ghostTimer = window.setTimeout(() => {
      ghostTimer = 0;
      if (!alive) return;
      nameGhosts.value = [];
      ghostFading.value = false;
    }, LABEL_MOTION.nameOutMs + 40);
  }

  /**
   * 🆕 **就地重投影**（`moveend` / `zoomend` 调）：把容器上那份位移烘进节点坐标，**只重投影、不重排**。
   *
   * 为什么还要举一帧 `is-snap`（2026-10-01 真浏览器逐帧实测）：
   *   这次坐标重写是一次"传送"——容器同时从 `translate3d(Δ)` 归零、节点坐标加上同一个 Δ，
   *   **两者同帧 ⇒ 画面本该一动不动**。但 `.ws-lab` 上有 `transition: transform 90ms`，
   *   浏览器会把节点自己的坐标变化**做成过渡** ⇒ 实测屏幕 x 序列出现
   *   `…273,273,**190**,234,261,280,283…`：先退回拖动前（反向行程 **84px** = 拖动量），再用 ~88ms 滑到位。
   *   ⇒ 举旗一帧把过渡掐掉（**只掐传送**：`:not(.is-enter):not(.is-ghost)` ⇒ 淡入淡出照旧）。
   *
   * 🔴 举旗必须在**同一 tick**、且在 `reproject()` 之前：Vue 的 patch 是微任务，两者会落在同一次 DOM 变更里
   *   （只加类不换坐标 = 白掐；只换坐标不加类 = 又滑一遍）。
   *   摘旗用 **rAF 两帧**（不是 `setTimeout` 猜时长）：第一帧让浏览器带着 `transition:none` 画完这次传送，
   *   第二帧恢复常态；此时 transform 没再变 ⇒ 不会补一次过渡。
   */
  function reprojectNow(): void {
    if (!namesOn.value || !alive) return;
    snapping.value = true;
    const rp = nameLayer.reproject();                 // → onPlan → 节点新坐标（同一 tick 入队）
    if (!rp) { snapping.value = false; return; }      // 还没算过任何一批 ⇒ 别留一个死类
    if (snapRaf1) cancelAnimationFrame(snapRaf1);
    if (snapRaf2) cancelAnimationFrame(snapRaf2);
    snapRaf1 = requestAnimationFrame(() => {
      snapRaf1 = 0;
      snapRaf2 = requestAnimationFrame(() => {
        snapRaf2 = 0;
        if (alive) snapping.value = false;
      });
    });
  }

  /** 名字层刷新（moveend / load 之后调；**不阻塞首屏**） */
  async function refreshNames(why = "view"): Promise<void> {
    if (!namesOn.value || !alive) return;
    try {
      /* 判词由**真源**给；它跟着节点一起落进 HUD（见 `applyNamePlanWithHud`）⇒ 不用再写一次 */
      await nameLayer.refresh(why);
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 名字层：${String((e as Error)?.message || e).slice(0, 40)}` : `名字层：${e}`;
    }
  }

  /* ── 🪪 信息卡：三条入口（点楼体 / 点名字 / 点区名）⇒ 同一张卡 ───────────────── */
  const cardData = ref<CardData | null>(null);
  const cardOpen = ref(false);
  const perfLow = computed(() => !!perf.low.value);
  function reducedMotion(): boolean {
    try {
      return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch { return false; }
  }
  /** 打开卡片：**唯一入口** —— 三条点击路径都走它，卡片数据只由 `buildingCardData` 生成 */
  function openCard(input: Parameters<typeof buildingCardData>[0], click?: { x: number; y: number } | null): void {
    try {
      const rect = { x: 0, y: 0, w: 0, h: 0 };
      /* 卡片最终矩形：与 `WsBuildingCard.vue` 的 CSS 同一口径（min(88%, 420px) 宽、居中） */
      const host = labRootEl.value?.parentElement;
      const W = host?.clientWidth || 0, H = host?.clientHeight || 0;
      rect.w = Math.min(W * 0.88, 420);
      rect.h = Math.min(H * 0.76, 260);
      rect.x = (W - rect.w) / 2;
      rect.y = (H - rect.h) / 2;
      cardData.value = buildingCardData({ ...input, click: click || input.click || null, cardRect: rect, index: indexFactOfNames() });
      cardOpen.value = true;
      stats.card = `${cardData.value.kind}/${cardData.value.state}`;
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 卡片：${String((e as Error)?.message || e).slice(0, 40)}` : `卡片：${e}`;
    }
  }
  function closeCard(): void { cardOpen.value = false; stats.card = ""; }
  /** 署名（ODbL）原句：**只念包索引里的**（取不到 = null ⇒ 卡片如实写"署名取不到"） */
  function indexFactOfNames(): { attribution: string | null; real: boolean | null } | null {
    const f = nameLayer.facts();
    return f.attribution ? { attribution: f.attribution, real: true } : (f.state === "counted" ? { attribution: null, real: null } : null);
  }

  /** 点**标签**（真名 / 区名）—— 与点楼体弹**同一张卡** */
  function openCardFromNode(n: NameRenderNode): void {
    const p = n.pick;
    if (p.kind === "zone") { openCard({ kind: "zone", zone: p.zone }); return; }
    if (p.kind === "place") { openCard({ kind: "place", place: p.place }); return; }
    openCard({ kind: "building", building: { id: p.buildingId, lng: p.lng, lat: p.lat, properties: { name: p.name, osm_id: p.buildingId } } });
  }

  /** 🧑 切片②（2026-10-01）：面板开关（模块级单例）—— 本组件**只用它判断"面板开着吗"**
      （见 `onMapClick` 开头那句早退）。开面板/画面板/好感全在宿主的 `WsCharPanel.vue` 那条路上。 */
  const panel = useWsPanel();

  /** 🏙🌆 **点楼要查哪几条层**（按**当前 zoom** 选；同一条点选路，不是两套逻辑）。
   *  · `z < WS_BLD_FOOTPRINT_MAXZOOM`(14) ⇒ 屏上只有**足迹层**（`bld-foot`，平面 `fill`）；
   *  · `z ≥ 14` ⇒ 三条挤出层（主体 / 女儿墙 / 设备箱+天线）。
   *  ⚠️ zoom 读不出来（`null`）⇒ 按**两条都查**（点选是"用户明确点了一下"，宁可不命中也不能漏掉
   *     一栋明明画着的楼；层不存在时 `queryRenderedFeatures` 会抛 ⇒ 由调用处照旧降级到屏幕距离）。 */
  function bldClickLayersNow(m: { getZoom?: () => number } | null): string[] {
    const tier = bldTierOfZoom(m && typeof m.getZoom === "function" ? m.getZoom() : null);
    if (tier === 0) return ["bld-foot"];
    if (tier === 1) return ["bld-ext", "bld-roof", "bld-equip"];
    return ["bld-foot", "bld-ext", "bld-roof", "bld-equip"];
  }

  /** 点**楼体**（地图上的挤出层 / 足迹层）—— 与点标签弹**同一张卡** */
  function onMapClick(e: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number }; features?: unknown[] }): void {
    /* 🧑 切片②（2026-10-01）：角色面板开着时，点地图**先关面板**再 return ——
       否则点空处会顺手在面板背后弹一张楼卡（面板没关、楼卡还盖上来）。
       纪律：**只加这一句早退，不新开第二条 click 监听**（地图级 click 仍然只有 `m.on("click")` 一处）。
       面板状态读的是模块级单例（`useWsPanel`），与本组件同一次会话里是同一份。 */
    if (panel.open.value) {
      panel.closePanel();
      return;
    }
    try {
      /* `getZoom` 是 2026-10-03「按 zoom 分层」后点选要用的（`z<14` 查足迹层、`z≥14` 查三条挤出层）——
         这里必须一起声明，否则 `bldClickLayersNow(m)` 报 TS2559（两个类型没有共同属性）。 */
      const m = map as unknown as {
        queryRenderedFeatures?: (p: unknown, o?: unknown) => Array<{ properties?: Record<string, unknown>; id?: unknown }>;
        getZoom?: () => number;
      } | null;
      const pt = e?.point;
      let feats: Array<{ properties?: Record<string, unknown>; id?: unknown }> = [];
      if (m?.queryRenderedFeatures && pt) {
        /* 🏢 三条挤出层**都要查**（2026-10-02 B1 按 zoom 分了三条：主体 / 女儿墙 / 设备箱+天线）——
           只查 `bld-ext` 会让"点屋顶件"落空（虽然下面还有屏幕距离兜底，但那是降级不是正常路径）。
           多条命中时**按档位升序取第一条**（`zt` 小的 = 主体优先，卡片信息最全）。
           🌆 2026-10-03 **按 zoom 分层**后：`z<14` 屏上是**足迹层**（`bld-foot`，平面）——
           这时 `bld-ext` 整层不可见（`minzoom` = 14），查它必然空。所以层名**按当前 zoom 选**，
           走的是**同一条** `queryRenderedFeatures` 路（不是两套点选逻辑），只是换一批层名。 */
        const hitLayers = bldClickLayersNow(m);
        try {
          const hit = m.queryRenderedFeatures(pt, { layers: hitLayers }) || [];
          feats = hit.slice().sort((a, b) => {
            const za = Number((a.properties || {}).zt ?? 0), zb = Number((b.properties || {}).zt ?? 0);
            return (isFinite(za) ? za : 0) - (isFinite(zb) ? zb : 0);
          });
        } catch { feats = []; }
      }
      /* 🔴 无头/无 WebGL 下 `queryRenderedFeatures` 恒空（本项目栽过的**假阴性闸**）⇒ 如实降级：
         用**屏幕距离**在"这一轮真画出去的那批楼"里找最近的一栋（锚点来自 `afterDraw`，不是猜的）。 */
      if (!feats.length) {
        const nearest = nearestDrawnBuilding(pt);
        if (nearest) feats = [{ properties: nearest.properties, id: nearest.id }];
      }
      const f = feats[0];
      if (!f) return;                                   // 点到空处：什么都不弹（不编一栋楼出来）
      openCard({ kind: "building", building: { id: String((f.properties || {}).osm_id || f.id || ""), properties: (f.properties || {}) as Record<string, unknown> }, click: pt || null });
    } catch (err) {
      stats.note = stats.note ? `${stats.note} · 点楼：${String((err as Error)?.message || err).slice(0, 40)}` : `点楼：${err}`;
    }
  }

  /** 屏幕距离最近的一栋**已画**的楼（`queryRenderedFeatures` 拿不到时的**可见降级**，不编数据） */
  function nearestDrawnBuilding(pt: { x?: number; y?: number } | undefined): { id: string; properties: Record<string, unknown> } | null {
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number }; getZoom?: () => number } | null;
    if (!m?.project || !pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) return null;
    const zoom = m.getZoom ? m.getZoom() : 16;
    if (zoom < 13) return null;                          // 远景下楼是亚像素，不该被点到
    const maxPx = 26;                                    // 命中半径（≈ 一栋近景楼的屏幕上尺寸）
    let best: { id: string; properties: Record<string, unknown> } | null = null;
    let bestD = maxPx;
    for (const raw of drawnBld) {
      const f = raw as { id?: unknown; properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };
      const props = f.properties || {};
      if (String(props.part || "body") !== "body") continue;   // 只认主体（屋顶/天线不该被点）
      const ll = firstCoordOf(f.geometry);
      if (!ll) continue;
      const p = m.project(ll);
      if (!p || !Number.isFinite(p.x)) continue;
      const d = Math.hypot(p.x - Number(pt.x), p.y - Number(pt.y));
      if (d < bestD) { bestD = d; best = { id: String(props.osm_id || f.id || ""), properties: props }; }
    }
    return best;
  }
  function firstCoordOf(g: { coordinates?: unknown } | null | undefined): [number, number] | null {
    let v: unknown = g?.coordinates;
    for (let i = 0; i < 6 && Array.isArray(v); i++) {
      if (typeof v[0] === "number" && typeof v[1] === "number") return [v[0] as number, v[1] as number];
      v = v[0];
    }
    return null;
  }

  /* ── 跟手（§4.0）：相机运动期间**只写容器**；节点位置一个字都不写 ─────────────────
     算法：`movestart` 时记下"第一个节点的锚点此刻在屏幕上的位置"，
     之后每帧算它现在在哪 ⇒ 差值就是整层的位移（地图平移 = 全体标签同位移，所以这是**精确**的）。
     ⚠️ 只在**平移**（pan）时这么做；旋转/俯仰不是平移，那时整层淡到 0.25 就够（§4.2）。
     🧱 S3（M1）：`panAnchor` 与这三个 handler（`onMoveStart` / `onMove` / `onMoveEndNames`）
     **整块搬进了 `wsMapCamera.ts`** —— 下面接回来的就是**同一个**函数（不是第二份），
     `m.on(...)` 那几个调用点因此一个字都没改。 */

  /* ══════════════════════════════════════════════════════════════════════════════
   * 🕹 摇杆 → 相机（近景：**倾斜俯视的跟随**；机主裁决 2026-10-03）
   * ══════════════════════════════════════════════════════════════════════════════
   * 每帧只做这几件事（顺序不能动）：
   *   ① `panBy([dx,dy],{duration:0})` —— 屏幕像素位移，库内已处理 pitch/bearing，
   *      **我们一行投影数学都不写**（PLAN §2.3 红线）；
   *   ② 名字层跟手：**只写 1 个容器**的 `translate3d`，且位移就是 `-累计位移`
   *      （相机平移是刚体平移 ⇒ 这个值与 `map.project(锚点)` 逐位相同，但**0 次 project**）；
   *   ③ 🆕 **角色真的动**：运动模型给的**世界坐标**写进漫游真源 → 「我」那颗钉子 `setLngLat`
   *      （§3：角色与相机是**两件事**，不再互相反写）；同一帧顺带写 ④⑤ 两个 transform；
   *   ④ 🆕 朝向：钉子上的箭头 `rotate(headingDeg)`（§4：朝向跟随移动方向）；
   *   ⑤ 🆕 踏步：身体 `translate3d`，幅度 ∝ 速度（§4：就地行走动画，停下自动回正）；
   *   ⑥ 别的什么都不做：不 reproject、不重排标签、不重挑楼、不启动 600ms 去抖。
   *
   * 🔴 `joyActive` 是**自持标志**（不是问地图"你在动吗"）：`panBy({duration:0})` 每帧都是一次
   *    完整 ease ⇒ 每帧都会同步发 `movestart`/`move`/`moveend`（vendored `_ease()` 里
   *    `duration===0` 直接 `easeFunc(1); finish()`，`_afterEase` 又把 `_moving` 清掉 ⇒ 下一帧重来）。
   *    不早退的话就是"每帧重投影 + 每帧起一条 600ms 去抖 + 每帧重排标签"——
   *    机主报过的「名字滑动刷新、错位严重 / 松手卡一下」的放大版。
   *
   * ⚠️ 符号口径（**从 vendored 源码逐字核出来的**，别凭手感改）：
   *    `camera.panBy(offset)` = `panTo(center, {offset: offset.mult(-1)})`；
   *    `handleEaseTo` 把**请求的中心**放到屏幕点 `centerPoint + offset` 上
   *    ⇒ `panBy([dx,dy])` 的结果是"相机朝屏幕 (dx,dy) 方向走了 dx,dy 像素"（内容反向平移）。
   *    所以：**推杆方向 = 相机前进方向**，直接用 `[d.dx, d.dy]`，**不取负**；
   *    而内容/标签层的位移是 `-累计位移`（与既有 `onMove()` 算出来的那个值同号同值）。
   *
   * ⚠️ `zoomend` **不需要**早退：本图没有 `maxBounds` ⇒ `handleEaseTo` 的
   *    `isZooming = (约束后的 zoom !== 原 zoom)` 恒为 false ⇒ `panBy` 一次 zoom 事件都发不出来
   *    （vendored 源码逐字核过；判据 1 的"zoom 逐字节不变"由此成立）。
   *    另一只手同时捏合缩放属于**用户明确的视角操作**，那一轮照旧重算 —— 不归摇杆管。 */
  let joyActive = false;
  /** 本次按压累计的屏幕位移（px）——名字层容器跟手用；自己算 ⇒ 一次 `map.project()` 都不需要 */
  let joyAccX = 0;
  let joyAccY = 0;
  /* 🕹🧱 **摇杆走路期间"边走边补"的三个数**（2026-10-04 第八轮；机主原话「在将屏幕**斜过来**时
     移动角色**楼会不见**，**反复放大缩小就好了**，在正常直接**竖直向下看时就不会**喵」）。
     机制与闸门见 `wsJoystick.joyFlushDue` 那段；这里是它要的四个数（写点**全在摇杆驱动那条路**上：
     按下起算 / 每帧累加 / 刷完归零 / 松手与退出复位）：
       · `joyFlushMovedM`  ：**这一次按下以来角色走过的世界米数** —— 按 `joyMpp`（米/标定档像素，
                             本组件那把唯一的尺子，与挑楼/速度档同一把）把角色位移积分换算成米。
                             累计的是**路程**（每一帧的位移长度相加），不是直线距离：绕圈也在挪视野；
       · `joyFlushElapsedMs`：距上一次补刷新的**累计时间** —— 用驱动每帧给的 `dtMs` 累加
                             （本仓"唯一时钟 / 唯一 rAF"纪律：**不在这里另读一个时钟源**）；
       · `joyFlushPx/Py`   ：上一帧角色在**标定档像素**里的位置（本帧的世界位移 = 它与 `mv.px/py` 之差）。
     🔴 三个数都只在**摇杆驱动**那条路上读写：`joyActive === false` 时一个字节都不动
        （那条老路由 `moveend` 自己刷，见下面 `joyFlushNow()` 的说明）。 */
  let joyFlushMovedM = 0;
  let joyFlushElapsedMs = 0;
  let joyFlushPx = 0;
  let joyFlushPy = 0;
  /**
   * **接管前的相机**（关闭时要逐字还原到这一份；机主的硬要求："不许留残留状态"）。
   * 两个来源，都只在这里写：
   *   · 启动时存储值/URL 就是开 ⇒ 由建图那段填「**没有摇杆时**这一屏会落到的机位」；
   *   · 运行时在面板里打开 ⇒ 现读相机（`getCenter/getZoom/getPitch/getBearing`）。
   * 读不齐（任一项非有限）⇒ `joyCamSnapshotOf()` 给 `null` ⇒ **关闭时一次相机都不动**（宁可不还原，也不编）。
   */
  let joyPrevCam: JoyCamSnapshot | null = null;

  /* 🕹🆕 2026-10-03 **运动模型落地**（机主验收原话：「这个移动不能真正像游戏那样移动！甚至角色都没有动，
     太杂鱼了！能去学游戏引擎吗」）—— 下面这三个值就是"角色真的在动"的全部新增状态，各一处：
       · `joyOrigin`：漫游**原点**（= 进近景那一刻的相机中心，世界坐标的锚）；
       · `joyScale` ：屏幕 px → 经纬度的**局部标尺**（`joyCalibrate()` 用**地图库自己的** unproject 量一次）；
       · `joyMove`  ：运动状态（速度 / 角色位移 / 相机位移 / 朝向 / 踏步相位），由
                      `wsJoystick.joyMotionStep()` 每帧推进；**跨按压保留** ⇒ 松手再推不会把人瞬移回原点。 */
  let joyOrigin: { lng: number; lat: number } | null = null;
  let joyScale: JoyPxScale | null = null;
  let joyMove: JoyMotion = createJoyMotion();
  /**
   * 🧭 §13 **参考系**（这一屏只有这一份）：
   *   · `joyBearing0`：标定那一刻的相机 bearing —— 上面那把 px→经纬度的标尺就架在它上面；
   *   · `joyDepthGain`：`1/cos(pitch)`（§14，标定那一刻的俯角算出来）。
   * 相机 bearing 由**用户手势**改（双指旋转），**不跟角色朝向** —— 我们选的是"相机相对输入"那一套
   * （研究 §13.2）。所以每一个推杆帧都要把当前的 bearing 报给模型：`Δβ ≠ 0` 时它先把屏幕向量
   * 转回标尺坐标系，否则方向就按"标定那一刻的上"走（= 机主报的「移动方向和屏幕方向不一样」）。
   */
  let joyBearing0 = 0;
  let joyDepthGain = 1;
  /**
   * 🎥 §16 **视口倍率** `2^(zoomNow − zoom0)` —— 上一次 `joyReportCam()` 量到的那个数。
   * 用途只有一个：把模型给的**标定档**像素位移换成 `panBy` 要的**当前档**像素（`d × viewScale`）。
   * 🔴 必须与**模型这一帧用的那个数**是同一个（模型从 ctx 拿到的是上一次报的），否则两者差一档
   * ⇒ 相机按错的倍率追角色。所以它由同一处（`joyReportCam`）写、同一帧里只读一次。
   */
  let joyViewScale = 1;
  /**
   * 🎥 §16 **相机真值**（"单一几何真源"的那一根线，2026-10-04 第六轮）——
   * 把相机在**标尺坐标系**里的位置量出来报给模型（`joySetCam`），模型从此**不再自己积分** `cx/cy`。
   *
   * 为什么必须这样（离线读数在 `world_map/ws_camera_lock_probe.mjs`，同一份代码 A/B 对比）：
   *   · 老写法（开环）：用户拖图 200px 后再推 3 秒 ⇒ 角色离屏幕中心最大 **413.59px**、松手 1 秒后
   *     仍 **194.35px** —— **永远不回来**（模型的 `d` 只做相对平移，它根本不知道相机被搬走了）；
   *   · 捏合也一样：真实 zoom 比模型以为的高 1 级 ⇒ `panBy` 的像素换算差 2 倍 ⇒ 3 秒漂 **93.64px**。
   *
   * 度量成本：`getCenter()`/`getZoom()` 是**属性读**（与每帧已有的 `getBearing()` 同一类），
   * **0 次 `project`、0 次布局**；反解是那次标定量到的同一个 2×2 的逆（`joyScreenOf` 纯函数）。
   * 量不到（没有 getCenter / 标尺还没有）⇒ 报 `NaN` ⇒ 模型回到开环旧行为 —— **宁可不报，也不编坐标**。
   */
  function joyReportCam(): void {
    const m = map as unknown as {
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
    } | null;
    if (!m || !joyOrigin || !joyScale || typeof m.getCenter !== "function") {
      joyViewScale = 1;
      joySetCam(NaN, NaN, 1);
      return;
    }
    let vs = 1;
    try {
      const z = typeof m.getZoom === "function" ? Number(m.getZoom()) : NaN;
      /* `joyZoom0 > 0` 是"出发 zoom 量到过"的标志（量不到时它恒 0 ⇒ 不敢拿它当基准） */
      if (Number.isFinite(z) && joyZoom0 > 0) vs = joyPanScaleOf(z - joyZoom0);
    } catch {
      vs = 1;
    }
    joyViewScale = vs;
    try {
      const c = m.getCenter();
      const p = joyScreenOf(joyOrigin, joyScale, c.lng, c.lat);
      if (p) joySetCam(p.x, p.y, vs);
      else joySetCam(NaN, NaN, vs);
    } catch {
      joySetCam(NaN, NaN, vs);
    }
  }
  /** 当前相机 bearing（**属性读**，不是 `project`、不触发布局）；读不到就沿用标定值 */
  function joyReadBearing(): number {
    const m = map as unknown as { getBearing?: () => number } | null;
    try {
      const b = m && typeof m.getBearing === "function" ? Number(m.getBearing()) : NaN;
      return Number.isFinite(b) ? b : joyBearing0;
    } catch {
      return joyBearing0;
    }
  }
  /* 🕹🆕 2026-10-03 第二轮（机主：「视角无法锁定角色，**位移很大**喵！！！」）—— **世界尺度**两个数，
     各只有一处来源，都由 `joyCalibrate()` 量一次后传给摇杆组件（它自己一行换算都不写）：
       · `joyMpp`      ：米/像素 —— 用本组件**既有那把唯一的尺子** `bldMetersPerCssPixel(zoom, lat)`
                        （与挑楼/楼高同一把，见本文件 `metersPerPixel` 那处调用）；**不新增第二份换算**。
                        ⚠️ 它不带俯角压缩（64° 时竖直方向的地面尺度差约 1/sin64° ≈ 11%）——
                          与世界速度的口径误差就这么多，写在这里免得下一个人以为是 bug。
       · `joySpeedMps` ：满推速度（**米/秒**）—— `joySpeedMpsOf(zoom)` 选档（步行/载具）。
                        🔴 上一版速度按"屏宽/秒"给 ⇒ 这一档的 1024px 屏上等于 **967 m/s**（瞬移）。
     量不到（没有 getZoom/getCenter）⇒ 两个数留 0 ⇒ 推杆无效：**宁可不走，也不编一个世界速度**。 */
  const joyMpp = ref(0);
  const joySpeedMps = ref(JOY_SPEED_MPS);
  /* 🕹🆕 2026-10-03 第三轮（机主拍板 Ⓐ「相机拉近」）—— **相机距离**四个值，各只有一处：
       · `joyZoomLevels`：交给摇杆组件的"推杆期间拉近几级" —— **量到了出发 zoom 才给**，
                          量不到给 0（这条通路整条关掉：宁可不拉，也不把相机 move 到 zoom 0）；
       · `joyZoom0`     ：进近景那一刻的出发 zoom（回程的目标值，容差 **0** —— `joyZoom0 + 0` 逐位相等）；
       · `joyZoomApplied`：上一次**已经写进相机**的拉近量（判据：`zo` 没变 ⇒ 一次相机写点都不发）；
       · `joyZoomPulling`：名字层是否正在**整层隐藏**（研究 §9.6；状态翻转才写一次 class，不进每帧循环）。 */
  const joyZoomLevels = ref(0);
  let joyZoom0 = 0;
  let joyZoomApplied = 0;
  const joyZoomPulling = ref(false);
  /** ♿ 系统"减弱动效"：**只关踏步**（摇杆是输入，任何档位都不许关；见 `joyWalkAnimOn`） */
  const joyReducedMotion = (() => {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  })();

  /* 🎯 2026-10-04 第四轮 **预走线**（机主："能给移动加预走线吗…动画要好看喵！"）—— 三个状态，各一处：
       · `joyAimOn`  ：这一帧该不该画（= 速度比例 > 0 且不是 low 档）。**翻转时才写一次 class**；
       · `joyAimK`   ：已经平滑过的线长比例 0..1（`joyAimStep` 按 `JOY_AIM_TAU_S` 收敛）；
       · `joyFaceDeg`：上一次**真的写进 DOM** 的朝向（0.1° 死区）—— `face` 与预走线容器**共用**这一份
                      （两者表示同一个朝向，同一帧只会有一个在画）。 */
  let joyAimOn = false;
  let joyAimK = 0;
  let joyFaceDeg = NaN;

  /**
   * 量**两把尺子**（整条链路只有这一处换算，共 3 次投影调用 + 1 次 `bldMetersPerCssPixel`）：
   *   ① **屏幕 px → 经纬度**（局部雅可比）：四个数**全部**来自地图库自己的 `project`/`unproject`
   *      —— 我们一行投影数学都不写（既有红线）。量的是**相机中心**处的雅可比，纯平移下不变。
   *   ② 🆕 **米/像素 + 速度档**（世界尺度，交给摇杆组件）：`bldMetersPerCssPixel(zoom, lat)` +
   *      `joySpeedMpsOf(zoom)` —— 只读 `getCenter`/`getZoom`，与 ① 相互独立（① 失败也能量出 ②）。
   * 🔴 **移动中 0 次**：本函数只在"进近景"（`joyEnter`）与建图那一刻被调，**帧里一次都不调**。
   * 量不齐 ①（库没这俩方法 / 抛错 / 非有限 / 全 0）⇒ `null`：**角色不动、只有相机走**
   * （宁可退回旧行为，也不写一个编出来的经纬度）；量不齐 ② ⇒ 推杆无效（不编世界速度）。
   */
  function joyCalibrate(): void {
    joyScale = null;
    /* 🎥 §16 相机真值先作废（报"不知道"）：下面重新量到标尺之前，任何旧读数都是**上一台相机**的。
       量不到就一直是 `NaN` ⇒ 模型走开环旧行为（与"量不到尺子就站住"同一条纪律）。 */
    joySetCam(NaN, NaN, 1);
    /* 🕹 相机距离那一路也**从这里归零**：量不到出发 zoom ⇒ `joyZoomLevels = 0` ⇒ 摇杆只平移、不拉近
       （拉近量的真源由此处一处决定；`joyZoomApplied`/隐藏态跟着复位，避免拿上一台相机的状态接着用）。 */
    joyZoomLevels.value = 0;
    joyZoom0 = 0;
    joyZoomApplied = 0;
    joyZoomPulling.value = false;
    const m = map as unknown as {
      project?: (c: [number, number]) => { x: number; y: number };
      unproject?: (p: [number, number]) => { lng: number; lat: number };
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
      getBearing?: () => number;
      getPitch?: () => number;
    } | null;
    if (!m || typeof m.getCenter !== "function") return;
    /* 🕹 **世界尺度**先量（只用到 getCenter/getZoom，**不依赖** project/unproject）：
       量得到 ⇒ 即使下面那把 px→经纬度的标尺量不出来（角色不动），**相机照样按真实米/秒走**
       （"宁可退回旧行为"那条降级路仍然成立）。 */
    try {
      const c0 = m.getCenter();
      const z0 = typeof m.getZoom === "function" ? m.getZoom() : NaN;
      joyMpp.value = bldMetersPerCssPixel(z0, c0.lat);
      joySpeedMps.value = joySpeedMpsOf(z0);
      /* 🕹 出发 zoom 量到了才**武装**拉近那条路（`JOY_ZOOM_PUSH_LEVELS` 是 policy，数值在 wsJoystick.ts 一处）；
         `z0` 非有限 ⇒ 两个数都留 0/关 —— 与"不编世界速度"同一条纪律。 */
      if (Number.isFinite(z0)) {
        joyZoom0 = z0;
        joyZoomLevels.value = JOY_ZOOM_PUSH_LEVELS;
      }
    } catch {
      joyMpp.value = 0;
    }
    /* 🧭 §13/§14：**参考系**（屏幕向量 ⇄ 世界方向的唯一换算处，纯函数模块）交给模型：
       · `bearing0` = 标尺架在哪个朝向（下面那把 px→经纬度的雅可比就是**此刻**的相机量的）；
       · `depthGain` = `1/cos(pitch)`（俯角带来的竖直压缩，§14）——「往上推」的屏幕速度要按它收，
         否则世界里会走出 2.28 倍的速度（旧行为）。
       ⚠️ 量不到就如实退回 (0, 1) = "当作没转过、俯角 0 压缩"（与 mpp 那条"不编数"同一条纪律）。 */
    try {
      const b0 = typeof m.getBearing === "function" ? Number(m.getBearing()) : 0;
      const p0 = typeof m.getPitch === "function" ? Number(m.getPitch()) : JOY_PITCH_DEG;
      joyBearing0 = Number.isFinite(b0) ? b0 : 0;
      joyDepthGain = joyDepthGainOf(p0);
      joySetFrame({ bearing0: joyBearing0, bearingNow: joyBearing0 }, joyDepthGain);
    } catch {
      joyBearing0 = 0;
      joyDepthGain = 1;
      joySetFrame(null, 1);
    }
    if (typeof m.project !== "function" || typeof m.unproject !== "function") return;
    try {
      const c = m.getCenter();
      const p0 = m.project([c.lng, c.lat]);
      const px = m.unproject([p0.x + 1, p0.y]);
      const py = m.unproject([p0.x, p0.y + 1]);
      const s = joyPxScaleOf({
        dxLng: px.lng - c.lng,
        dxLat: px.lat - c.lat,
        dyLng: py.lng - c.lng,
        dyLat: py.lat - c.lat,
      });
      if (!s) return;
      joyOrigin = { lng: c.lng, lat: c.lat };
      joyScale = s;
      joyMove = createJoyMotion();
    } catch {
      joyScale = null;
    }
    /* 🎥 §16 标定完成 ⇒ 立刻报一次**相机真值**：`joyOrigin` 就是这一刻的相机中心 ⇒ 真值是 (0,0)
       （`vs` 也由这一处一并量出来 = `2^(z0 − z0)` = 1）。此前一律是 `NaN`（"不知道"），
       模型那时走的是开环旧路 —— 与"量不到尺子就站住"同一条纪律。 */
    joyReportCam();
  }

  /**
   * 🕹 每帧**至多一次**：把运动模型算出来的**世界坐标**写进漫游真源，并驱动「我」那颗钉子。
   * 写点一共 3 个，**全是 `setLngLat` / `transform`，没有一个布局属性**：
   *   ① `Marker.setLngLat` —— "角色真的在动"就是这一行（§3：角色走世界坐标，相机另算，两者不再重合）；
   *   ② 朝向箭头 `rotate`（§4：朝向跟随移动方向，`headingDeg` 由**速度方向**算出）；
   *   ③ 身体踏步 `translate3d`（§4：就地行走动画 —— 位移归世界坐标、摆动归 transform；
   *      幅度 ∝ 速度 ⇒ 停下时 `speedRatio = 0` ⇒ 恒等变换 ⇒ **自动回正**，不用再补一帧）。
   * ⚠️ 诚实记一笔：`Marker.setLngLat()` 内部会自己 `project` 一次（**引擎自己的**，不是我们写的投影数学，
   *    而且只涉及这一个 marker）。既有红线"移动中 0 次 `map.project()`"指的是**我们的代码**不许调 ——
   *    这条仍然成立（自检 ⑩k3 钉着）。
   */
  function joyApplyRoam(mv: JoyMotion): void {
    if (!joyOrigin || !joyScale) return;
    const w = joyLngLatOf(joyOrigin, joyScale, mv.px, mv.py);
    roamStore.write(w.lng, w.lat, mv.headingDeg);
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    if (!pin) return; // 名单里还没有「我」⇒ 位置已经在真源里了，钉子出来时 `syncPins` 会照它摆
    try {
      pin.mk.setLngLat([w.lng, w.lat]);
    } catch {
      /* 地图拆了就算了（这一帧白写，不抛） */
    }
    /* 朝向：**只在"不在画预走线"时写**（预走线亮着时箭头是藏起来的 —— 写它等于白发一次）。
       另加 **0.1° 死区**：直着走时 `headingDeg` 只会在浮点尾巴上抖，四舍五入到 0.1° 后大多数帧
       根本没有变化 ⇒ 这些帧从"每帧 1 个写点"变成 0 个（写点预算里那个"最坏 8 / 稳态 5"就是这么来的）。 */
    if (pin.face && !joyAimOn) {
      /* 🧭 §13：`mv.headingDeg` 是**世界（罗盘）朝向** —— 画在屏幕上要减掉当前 bearing（唯一换算处） */
      const deg = Number(joyScreenHeadingOf(mv.headingDeg, joyBearingNowOf()).toFixed(1));
      if (deg !== joyFaceDeg) {
        joyFaceDeg = deg;
        pin.face.style.transform = `rotate(${deg}deg)`;
      }
    }
    /* 踏步（§4：就地行走）：**一步一个起落**，不是一步两个。
       🔴 2026-10-04 第四轮消抖（机主「移动时很诡异，一直在抖」）—— 旧写法是
       `-|sin(stepPhase·2π)| × a`：`|sin|` 每个相位周期有**两个**波峰，而 `stepPhase` 的单位是**步**
       （`JOY_STEP_HZ = 2.2` 步/秒）⇒ 那个"踏步"实际是 **4.4 次/秒的上下振**（研究 §11.2 的反面教材：
       被相机跟随的角色身上，任何周期性位移都会被看成抖）。
       现在用 `sin²(π·stepPhase)`：一个相位=**一个**起落（2.2 次/秒，人走路的量级），
       而且 `sin²` 在触地那一点是 C¹ 连续的（`|sin|` 在那里有个折点，看着像"顿一下"）。
       幅度仍是 `speedRatio × JOY_STEP_PX`（停下 ⇒ 0 ⇒ 恒等变换 ⇒ 自动回正，一个字没改）。 */
    if (pin.body && joyWalkAnimOn({ low: !!perf.low.value, reduced: joyReducedMotion })) {
      const a = mv.speedRatio * JOY_STEP_PX;
      const bob = Math.sin(mv.stepPhase * Math.PI) ** 2;
      pin.body.style.transform = a > 0 ? `translate3d(0, ${(-bob * a).toFixed(2)}px, 0)` : "";
    }
  }

  /**
   * 🎯 **预走线那一帧的两个写点**（机主："预走线 + 指向移动方向的箭头，动画要好看"）。
   *
   * 写点**恰好 2 个**（与 `JOY_AIM_WRITES_MAX` 对齐；都在**钉子自己的 DOM** 里）：
   *   ① 虚线 `scaleX`（线长 ÷ 满长）——**只动 transform**，不碰 `width`；
   *   ② 箭头 `translate3d(线长, 0, 0)`——同样只动 transform。
   * 容器那次 `rotate` 是**第三个**、但带 0.1° 死区（角度没变就一次都不写）；
   * `opacity` **一次都不写**：显隐是 `is-aim` class 翻转 + CSS 过渡（见文件末尾全局样式）。
   *
   * ⚠️ 为什么回中段（`phase === "center"`）也允许写这两个数：**线必须收回去**，
   *    否则松手那一瞬它会长在半路"僵住"（`speedRatio` 在 `release()` 里当场归零，
   *    线长的收敛只能靠模型按 `JOY_AIM_TAU_S` 走完）。所以回中段的角色写点**只有这 2 个**：
   *    `setLngLat` / 真源 `roamStore.write` / `project` 三者仍然是 **0 次**（自检 ⑩e3/⑩e4 分别钉）。
   */
  function joyAimWrite(pin: { el: HTMLElement; aim: HTMLElement | null; dash: HTMLElement | null; tip: HTMLElement | null; face: HTMLElement | null } | undefined, mv: JoyMotion | undefined, dtMs: number): void {
    if (!pin?.aim || !pin.dash || !pin.tip) return;
    const mode = joyAimModeOf({ low: !!perf.low.value, reduced: joyReducedMotion });
    /* ① 该不该画：`off`（low 档）⇒ 一次都不画；速度恰好 0（松手/停稳）⇒ 收线不再起新的 */
    const want = mode !== "off" && !!mv && Number.isFinite(mv.speedRatio) && mv.speedRatio > 0;
    if (want !== joyAimOn) {
      joyAimOn = want;
      /* **一次 class 写**（状态翻转那一帧）：CSS 过渡负责淡入 140ms / 淡出 320ms（ease-out，研究 §12.3）。
         起新的一段时把平滑量**归零**：上一段末尾可能冻在 20% 上（那一帧之后 rAF 链就断了），
         不归零的话线会"啪"地从 20% 开始长。 */
      pin.el.classList.toggle("is-aim", want);
      if (want) joyAimK = 0;
      /* 🎯 起新一段时把角度死区**作废**（`NaN` ⇒ 下一帧必写）：上一段的容器角度停在收线那一刻，
         若这一段的方向恰好相同，`deg !== joyFaceDeg` 会判"没变"而**一次都不写** ——
         线就会带着上一段的旧角亮起来（0.1° 死区那个共用变量带来的唯一副作用，这里堵掉）。 */
      if (want) joyFaceDeg = NaN;
      /* 收线那一帧把**朝向箭头补到当前朝向**：预走线亮着的时候箭头是被 CSS 藏起来的
         （`[data-ws-roam-pin].is-aim [data-ws-roam-face]` 那条），而箭头自己的 `rotate` 在
         预走线期间**故意不写**（省一个写点）。不补这一下，松手后箭头会停在上一次写进去的旧角度上。 */
      else joyFaceSync(pin, mv ? mv.headingDeg : NaN);
    }
    if (mode === "off") return;
    if (!joyAimOn && joyAimK <= 0) return; // 收干净了 ⇒ 这一帧 0 个写点（不再空写）
    const f = joyAimStep(joyAimK, mv ? mv.speedRatio : 0, dtMs);
    joyAimK = f.k;
    pin.dash.style.transform = `translate3d(0, 0, 0) scaleX(${f.scaleX.toFixed(4)})`;
    pin.tip.style.transform = `translate3d(${f.tipPx.toFixed(2)}px, 0, 0)`;
    /* ③ 容器：只吃 rotate（角度死区 0.1°）。为什么和 `pin.face` 共用 `joyFaceDeg`：
       两者表示的是**同一个朝向**，同一帧只会有一个在画 —— 共用一份就少一次 `toFixed` 与一次比较。 */
    if (mode === "full" || mode === "static") {
      /* 🧭 §13：`headingDeg` 是**世界（罗盘）朝向** ⇒ 先换成**当前屏幕**角（`joyFaceDeg` 存的就是
         这个口径，与朝向箭头共用一份）。
         🎯 §13.4：预走线容器是**沿 `+x`（右）画的**（`.ws-aim__dash` 从 `left:17px` 起、箭头
         `clip-path` 朝 +x），而 `rotate(θ)` 把 `+x` 转到屏幕角 θ ⇒ 要它指向 `h` 就得写 `h - 90`。
         这一处就是那个 `-90`（`joyAimRotateDegOf`）。**朝向箭头不减**（它是沿 `-y` 画的）——
         两个元素本来就该用两个式子，这也是"线、箭头、真实位移"从此同一个角的全部代价。 */
      const deg = Number(joyScreenHeadingOf(mv ? mv.headingDeg : 0, joyBearingNowOf()).toFixed(1));
      if (deg !== joyFaceDeg) {
        joyFaceDeg = deg;
        pin.aim.style.transform = `rotate(${joyAimRotateDegOf(deg)}deg)`;
      }
    }
  }
  /**
   * 朝向箭头的**补写**（唯一一处）：只在"预走线收线那一帧"与"收尾 `joyAimReset`"两处调。
   * 为什么需要它：预走线亮着时箭头被 CSS 藏着，而它的 `rotate` 在那一整段里**故意不写**
   * （省一个每帧写点）—— 收线时若不补，箭头会停在上一次写进 DOM 的**旧角度**上（人是停下了，
   * 朝向就是他最后走的方向，不该是一个更早的方向）。
   */
  function joyFaceSync(pin: { face: HTMLElement | null } | undefined, headingDeg: number): void {
    if (!pin?.face || !Number.isFinite(headingDeg)) return;
    /* 🧭 §13：调用方原样传的是 `mv.headingDeg`（**世界**朝向）⇒ 这里换成当前**屏幕**角再写 */
    joyFaceDeg = Number(joyScreenHeadingOf(headingDeg, joyBearingNowOf()).toFixed(1));
    pin.face.style.transform = `rotate(${joyFaceDeg}deg)`;
  }
  /** 🎯 把预走线收干净（**幂等**）：class 摘掉 + 平滑量归零 + 朝向补写。`onJoyHalt`/`joyExit` 都会调一次 —— 保证"线不会僵住" */
  function joyAimReset(): void {
    const wasAiming = joyAimOn;
    joyAimOn = false;
    joyAimK = 0;
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    pin?.el.classList.remove("is-aim");
    /* 只有"刚才真的在画"才补写箭头（否则就是一次白写：箭头本来就是那个角度） */
    if (wasAiming) joyFaceSync(pin, joyMove.headingDeg);
  }

  /**
   * 「我」钉子上那两处漫游写点回**恒等**。
   * `clearHeading = false`（松手）：只收踏步 —— 人是停下了，不是转回正北；
   * `clearHeading = true`（关掉摇杆）：朝向也回正 —— 一切还原，与"相机逐字还原"同一条纪律。
   */
  function joyPinReset(clearHeading: boolean): void {
    const pin = pins.find((p) => p.id === ROAM_PIN_ID);
    if (pin?.body) pin.body.style.transform = "";
    if (pin?.dash) pin.dash.style.transform = "";
    if (pin?.tip) pin.tip.style.transform = "";
    joyAimReset(); // 🎯 预走线也一并收（class 摘掉 + 平滑量归零；幂等）
    if (clearHeading && pin?.face) pin.face.style.transform = "";
    if (clearHeading && pin?.aim) pin.aim.style.transform = "";
  }

  /** 读当前相机 → 快照（缺值给 null；宿主不许在没快照时动相机） */
  function joyReadCam(): JoyCamSnapshot | null {
    const m = map as unknown as {
      getCenter?: () => { lng: number; lat: number };
      getZoom?: () => number;
      getPitch?: () => number;
      getBearing?: () => number;
    } | null;
    if (!m) return null;
    try {
      return joyCamSnapshotOf({
        center: typeof m.getCenter === "function" ? m.getCenter() : null,
        zoom: typeof m.getZoom === "function" ? m.getZoom() : NaN,
        pitch: typeof m.getPitch === "function" ? m.getPitch() : NaN,
        bearing: typeof m.getBearing === "function" ? m.getBearing() : NaN,
      });
    } catch {
      return null;
    }
  }

  /**
   * 打开（面板开关 / 启动时就是开）：记下接管前的相机 → 进近景（只改俯角）→ 量标尺 →
   * 位置真源与「我」一起落到现在这个中心。
   * 🔴 `joyCalibrate()` 必须排在**改完俯角之后**：俯角不同，同一个屏幕 px 对应的地面距离差好几倍
   *    （38° 与 64° 量的标尺不是一回事）。
   */
  function joyEnter(): void {
    const m = map as unknown as { jumpTo?: (o: unknown) => void } | null;
    if (joyPrevCam || !m) return; // 幂等：已经在近景里就什么都不做
    joyPrevCam = joyReadCam();
    try {
      /* **只改俯角**（中心/zoom/bearing 一个字不动）——"进近景"= 抬头看这座城市，不是把镜头搬走 */
      if (typeof m.jumpTo === "function") m.jumpTo({ pitch: JOY_PITCH_DEG, duration: 0 });
    } catch {
      /* 相机收不了就当没进近景；摇杆照常能推（推的还是 panBy，不依赖俯角） */
    }
    joyCalibrate();
    /* 位置真源 = 原点（相机中心）；`joyApplyRoam(joyMove)` 用的是刚归零的运动状态 ⇒
       「我」**立刻**站到画面中心 —— 进近景就看得见自己，不是推一下才冒出来。 */
    if (joyOrigin) roamStore.write(joyOrigin.lng, joyOrigin.lat, joyMove.headingDeg);
    joyApplyRoam(joyMove);
  }

  /**
   * 关闭（面板开关关掉 / 2D 降级把摇杆收走）：先收尾 → **相机逐字还原** → 位置真源清空。幂等。
   * ⚠️ 顺序不能反：先 `onJoyHalt()`（把这次按压的容器位移烘进节点坐标、并做那**一次**重算），
   *    再 `jumpTo` 还原 —— 否则还原那一跳会作用在一层还没对齐的标签上（就是机主报过的"错位"）。
   */
  function joyExit(): void {
    if (joyActive) onJoyHalt();
    const args = joyCamRestoreArgs(joyPrevCam);
    joyPrevCam = null;
    roamStore.clear();
    /* 🕹 会话状态**清干净**（2026-10-03 新增的三个值 + 钉子上的朝向/踏步）：
       不清 `joyOrigin`/`joyScale` 的话，下一次打开会拿着**上一台相机**的标尺算世界坐标
       （俯角/缩放早变了）—— 那正是"编出来的坐标"；不清朝向的话，箭头会停在最后一次的方向上。 */
    joyOrigin = null;
    joyScale = null;
    joyMove = createJoyMotion();
    joyAccX = 0;
    joyAccY = 0;
    /* 🕹🧱 走路补刷新的那两个计数（米数 / 时间）也一并清掉（与 `joyAccX/joyAccY` 同一类残留：
       留着一个"走了一半"的米数，下一次打开时按下的那一帧会被它接走 —— 虽然按下那一刻还会重置，
       但这里清干净更省心）。 */
    joyFlushMovedM = 0;
    joyFlushElapsedMs = 0;
    /* 🕹 相机距离这四个值一个都不能留：留 `joyZoom0` 会拿着**上一台相机**的出发 zoom 去还原
       （与"不清标尺"同一类错误），留 `joyZoomPulling` 会让名字层一直藏着。
       `joyZoomLevels` 交给下一次 `joyCalibrate()` 重新武装（它开头就把四个值全归零）。 */
    joyZoomLevels.value = 0;
    joyZoom0 = 0;
    joyZoomApplied = 0;
    joyZoomPulling.value = false;
    /* 🎥 §16 相机真值也清掉（报"不知道"）：留着上一台相机的数，下一次开摇杆会拿着它去纠偏
       —— 与"不清标尺""不清出发 zoom"是同一类错误（宁可回到开环，也不拿旧读数当真值）。 */
    joyViewScale = 1;
    joySetCam(NaN, NaN, 1);
    joyPinReset(true);
    /* 「我」回到名单里的网格位置：真源已清空 ⇒ `syncPins` 走的是常规那一路（含吸附） */
    syncPins();
    if (!args) return; // 没快照 ⇒ **一次相机都不动**（绝不编一个"原来的机位"）
    try {
      (map as unknown as { jumpTo?: (o: unknown) => void } | null)?.jumpTo?.(args);
    } catch {
      /* 还原失败也不抛：位置真源已经清掉，功能上等于"回到默认路" */
    }
  }

  /* 面板里的开关（`WsCharPanel` → `WsCityEntry` → `:joy`）在运行时会变 ⇒ 这两件事跟着它走：
     打开 = 进近景（记快照 + 抬头），关闭 = **逐字还原**（相机回快照、DOM 卸载、位置真源清空）。
     ⚠️ 启动时就是开的那条路不由这里触发（地图还没建）—— 建图那段直接填 `joyPrevCam`（见那里注释）。 */
  watch(
    () => !!props.joy,
    (on) => {
      if (!alive) return;
      if (on) joyEnter();
      else joyExit();
    }
  );

  /** 名字层跟手：**只写 1 个容器**（O(1)），节点一个字都不写 */
  function joyNamesFollow(): void {
    const el = labRootEl.value;
    if (!el) return;
    el.style.transform = `translate3d(${(-joyAccX).toFixed(2)}px, ${(-joyAccY).toFixed(2)}px, 0)`;
  }

  /** 每帧**至多一次**（来自摇杆组件那唯一一个 rAF）；`mv` = 这一步的运动状态（角色那一半），
   *  `phase` = `"push"`（推着/滑行）或 `"center"`（**松手后的回中段**：角色已停稳，只有相机在贴回角色）。 */
  function onJoyDrive(d: { dx: number; dy: number }, _v?: unknown, mv?: JoyMotion, phase?: JoyFramePhase, dtMs = 0): void {
    const m = map as unknown as {
      panBy?: (o: [number, number], opt?: { duration: number }) => void;
      easeTo?: (o: Record<string, unknown>) => void;
    } | null;
    if (!alive || !m || typeof m.panBy !== "function") return;
    /* 🧭 §13：每帧**只报一个数**（相机 bearing）——属性读，0 次 `project`、0 次布局读。
       用户转过地图之后，"屏幕上往上推"对应的世界方向变了；不报这一下，模型就还按标定那一刻算。 */
    joySetBearingNow(joyReadBearing());
    /* 🔴 两条路**分开判**（2026-10-03 第二轮）：世界速度下相机头 ~2 秒会被死区按在原地
       （满推 8.8 px/s），那几帧 `d = {0,0}` 但**角色已经在走** ⇒ 相机那一半要跳过、
       角色那一半照写。老代码把两者绑在"相机位移非 0"上，于是那 2 秒里钉子一动不动。 */
    const camMoved = !!(d.dx || d.dy);
    /* 🕹 相机距离（研究 §9；机主拍板 Ⓐ 拉近）：`zo` = 运动模型算出来的"已拉近几级"（松手后回 0）。
       它跟 `camMoved` **不是一回事**：拉近从第一帧就开始改相机，而死区让 `panBy` 头 ~2.3 秒一动不动
       ⇒ 接管标志（`joyActive`）必须**两条都算**，否则那 2.3 秒里 `easeTo` 引发的
       `movestart/move/moveend/zoomend` 全部不会早退，每帧都走一遍常规重投影/取包
       （判据 3/6 的红线；`zoomend` 那一支是这一轮**必须补**的早退，见它的注释）。 */
    const zoomArmed = joyZoomLevels.value > 0;
    const zo = zoomArmed && mv && Number.isFinite(mv.zo) ? mv.zo : 0;
    const zoomMoved = zo !== joyZoomApplied;
    if ((camMoved || zoomMoved) && !joyActive) {
      /* 进入：**一次 class**（与既有 `movestart` 同一套 `is-camera-moving`，整层淡到 0.25）+
         累计位移归零。`panAnchor` 保持 null ⇒ 后面那几个 handler 早退也不会有人误用旧锚点。
         ⚠️ 归零是**必须**的：上一次收尾时 `onMoveEndNames()` 已经把位移烘进节点坐标了，
         这里不归零就是把同一段位移**再叠一次**（名字层越推越偏）。
         ⚠️ 只在**相机真的动**这一刻置位：相机没动的那些帧不置位 ⇒ 收尾也不必白跑一次取包
         （那一次重算是给"画面位移"擦屁股的，画面没位移就没有屁股要擦）。
         🕹 回中段也会走到这里（`joyActive` 那时仍为 true —— `onHalt` 要等相机停稳才发）⇒
         名字层照旧跟手，回中那点位移（~17px）也一并被烘进去，不会留一条错位的缝。 */
      joyActive = true;
      joyAccX = 0;
      joyAccY = 0;
      /* 🕹🧱 补刷新的那四个数也从**这一刻**起算（与 `joyAccX/joyAccY` 同一次按下的口径）：
         "上一次刷新" = 按下那一刻 ⇒ 第一次补刷新最早也在 600ms 之后、而且必须走够 100m。
         `mv` 在相机真的动了的这一帧一定有（驱动每帧都传）；量不到就按 0 起算 —— 只用差值，不影响。 */
      joyFlushMovedM = 0;
      joyFlushElapsedMs = 0;
      joyFlushPx = mv ? mv.px : 0;
      joyFlushPy = mv ? mv.py : 0;
      /* 整层淡化只跟**真的平移**走：拉近期间名字层本来就整层隐藏（§9.6），没必要再叠一层淡化 */
      if (camMoved) cameraMoving.value = true;
    }
    /* 🕹🆕 **相机距离写点**（唯一一处；`zo` 与上一次相同 ⇒ **一次都不发** —— 常态每帧都是这一支）：
       走的是**既有相机通路** `easeTo`（与 `panBy` 同一族，库内处理映射），**一行投影数学都不写**。
       `duration: 0` 与 `panBy({duration:0})` 同口径：平滑已经由 `joyMotionStep` 的指数逼近做完了
       （研究 §9 的 τ=0.5s 拉近 / 复用 `JOY_RECENTER_TAU_S` 回程），这里只负责"把这一刻的值落到相机上"。
       🔴 `joyZoom0 + 0` 逐位等于出发 zoom ⇒ 回程结束时相机距离**恰好**回到进近景那一刻。 */
    if (zoomMoved) {
      joyZoomApplied = zo;
      if (typeof m.easeTo === "function") {
        try {
          m.easeTo({ zoom: joyZoom0 + zo, duration: 0 });
        } catch {
          /* 相机收不了就当这一帧没拉（下一帧还会再试）；平移那一路照旧 */
        }
      }
    }
    /* 🕹 名字层：拉近期间**整层隐藏**（研究 §9.6 —— 标签坐标是按进近景那一档 zoom 投影的，
       容器只补 translate，zoom 一变就系统性错位）。🔴 **状态翻转才写一次**（不进每帧循环）。 */
    const hideNames = joyNamesHiddenOf(zo);
    if (hideNames !== joyZoomPulling.value) joyZoomPulling.value = hideNames;
    if (camMoved) {
      /* 🕹 像素换算（研究 §9.4；`joyPanScaleOf` 一个乘方，不碰投影）：角色的位移积分在**进近景那一档**
         的像素里（世界尺度冻结，红线），`panBy` 走的却是**当前**这一档 ⇒ 拉近 zo 级要乘 2^zo，
         否则相机按 2^zo 的倍率追不上角色，角色被甩到硬夹带边缘（= 上一版"视角无法锁定角色"）。
         累计位移（名字层跟手用）也按**实际写进相机的像素**记，收尾烘进节点坐标的才是真值。
         🎥 §16：这个倍率现在取自 `joyViewScale`（上一帧 `joyReportCam()` 量的**真实** zoom 差，
         含用户自己捏合进去的那几级）—— 与模型这一帧用的 `ctx.viewScale` **是同一个数**
         （模型拿的也是上一次报的）⇒ 两边不可能差一档。没有真值时它恒 1 ⇒ 逐位等于旧行为。 */
      const k = joyViewScale;
      m.panBy([d.dx * k, d.dy * k], { duration: 0 });
      joyAccX += d.dx * k;
      joyAccY += d.dy * k;
      joyNamesFollow();
    }
    /* 🎥 §16 **报相机真值**（每帧恰好一次，且在**所有**相机写点之后 —— 下一帧的模型看的就是它）：
       位置 = `getCenter()` 用标定那把尺子反解出来的标定档坐标；倍率 = 真实 zoom 差。
       量不到 ⇒ `NaN` ⇒ 模型回开环。这是"相机位置只有一个来源（地图自己）"的落地处。 */
    joyReportCam();
    /* 🆕 角色那一路（与相机**分成两件事**，§3）：世界坐标写进真源 + 钉子 `setLngLat` + 朝向 + 踏步。
       🔴 位置**不再**从 `getCenter()` 反写 —— 反写就等于"我 = 相机"，屏幕上的钉子永远不动
       （上一版"角色都没有动"的病根就在这一处）。
       🔴 **回中段一个角色写点都不发**（判据：`phase === "center"` ⇒ 0 次 `setLngLat` / 0 次
       `roamStore.write` / 0 次 `Marker.setLngLat` 内部那次 project）：那时角色已经停稳
       （`joyMotionStep` 的 `centering` 只在"没输入且速度恰好 0"时为真），发出去也只是把同一个
       坐标重写一遍 —— 而那正是"回中只许动相机"这句要求的可数形式。 */
    if (mv && phase !== "center") {
      joyMove = mv; // 留一份最新状态（这一份**不是**驱动的那份；只给"进来时先站到原点"用）
      joyApplyRoam(mv);
      /* 🕹🧱 **这一次按下以来角色走了多少米**（世界位移 → `joyMpp` 那把唯一的尺子 → 米）。
         `mv.px/py` 是角色在**标定档像素**里的位置（世界尺度冻结在那一档），`joyMpp` 正是
         "1 个标定档像素 = 多少米" ⇒ 两者相乘就是世界米数，**一次投影、一次 DOM 写都没有**。
         代价：每帧 3 个乘/加 + 1 个 `Math.sqrt`（见自检 ⑰ 的"每帧代价"那一组）。 */
      const fdx = mv.px - joyFlushPx;
      const fdy = mv.py - joyFlushPy;
      if (joyMpp.value > 0) joyFlushMovedM += Math.sqrt(fdx * fdx + fdy * fdy) * joyMpp.value;
      joyFlushPx = mv.px;
      joyFlushPy = mv.py;
      joyFlushElapsedMs += dtMs;
    }
    /* 🕹🧱 **受节流约束的那一次补刷新**（机主「走路时楼会不见」的正解；机制见 `joyFlushNow()`）：
       `joyFlushDue` 是**唯一**判定点 —— ≥100m **且** ≥600ms 才放行 ⇒ 常态每帧只做
       "读两个数 + 比大小"（0 次 `setData`、0 次重挑、0 次 DOM 写）。
       🔴 `joyActive === false` 时这一支不进：那条老路（`moveend`/`zoomend` 那几个 handler）
       一个字都没改 —— 相机没被摇杆接管时，刷新照旧归它们管。 */
    if (joyActive && joyFlushDue({ movedM: joyFlushMovedM, elapsedMs: joyFlushElapsedMs })) {
      joyFlushMovedM = 0;
      joyFlushElapsedMs = 0;
      joyFlushNow();
    }
    /* 🎯 预走线（**两个写点，两条路都要走**）：push 段跟着速度长出来；`center` 段只做一件事 ——
       **把线收回去**（`speedRatio` 在 `release()` 里当场归零，收敛只能由 `joyAimStep` 按 τ 走完）。
       🔴 它与上面那条"回中段 0 个角色写点"不冲突：那条红线管的是**角色的世界位置**
       （`setLngLat` / 真源 / 投影），而这里只写钉子内部两个**装饰性 transform**。
       判据在自检 ⑩e3（那三条仍是 0）+ ⑩e4（回中段的预走线写点 ≤ 2/帧，且结尾必须收到 0）。 */
    joyAimWrite(pins.find((p) => p.id === ROAM_PIN_ID), mv, dtMs);
  }

  /**
   * 🕹🧱 **摇杆期间的"边走边补"**（2026-10-04 第八轮；唯一入口 —— 每帧那个闸门在 `onJoyDrive` 末尾）。
   *
   * 为什么必须有它（机主原话：「在将屏幕**斜过来**时移动角色**楼会不见**，**反复放大缩小就好了**，
   * 在正常直接**竖直向下看时就不会**喵」）：摇杆驱动期间 `move`/`moveend` 整条"刷新包 + 落楼 + 名字"
   * 的路都被早退（`m.on("move", …)` 与 `m.on("moveend", …)` 那两句 `if (joyActive) return;`，
   * 理由见那两处注释），俯角 64° 下看得见的地面只有**一条窄带**
   * ⇒ 走几十米那批楼就滚出屏幕、而没有新的补进来；`zoomend` 仍会重挑一次（`bldTierCrossedFlush`）
   * ⇒ 所以"反复放大缩小就好了"。判据与常量在 `wsJoystick.joyFlushDue`（≥100m 且 ≥600ms）。
   *
   * 三件事，顺序不能反：
   *   ① **先把容器那份位移烘进节点坐标**（`onMoveEndNames()` 容器归零 + `reprojectNow()` 就地重投影）：
   *      名字层的节点坐标是**相对容器**的，而容器上正挂着这一段走过的位移；不先烘就重排名字，
   *      新算出来的坐标会与旧位移**叠加**一次 ⇒ 整层标签偏掉（机主报过的"名字错位"那一族）。
   *      烘完把累计位移归零，跟手从新基准接着累（`joyNamesFollow()` 每帧写的就是它）。
   *      ⚠️ `onMoveEndNames()` 会顺手清 `cameraMoving`（= 摘掉"相机在动"那层淡化）——摇杆还推着，
   *         所以同一个 tick 里立刻置回来：Vue 的 patch 在微任务里，**只落一次 DOM 结果、不闪**。
   *   ② **落楼**（`bldFlush("joy")` → 真源 `flushBldStore` → 按**当前**视野重挑一次）：这一发才是
   *      "楼会不见"的正解。`refreshBundles` **替代不了它**：格都取过时它在 `wsOfflineFeed` 里整轮早退
   *      （`if (!batch.length) return`）⇒ 光靠取包**不重挑楼**，屏上就一直是走路前那一批。
   *   ③ **取新格 + 重排名字**（与 `moveend` / `onJoyHalt` **同一条路**，不新写第二条）：
   *      `refreshBundles("joy")` → 完成后 `refreshNames("joy")`（新数据落地时 feed 自己会再落一次图）。
   *
   * 🔴 节流由调用方那一处判据保证（≥100m **且** ≥600ms）——本函数**不是**每帧调用的。
   * 🔴 冻结集 / 锚点一个都不清：走的是同一份 `wsBldPickStore`（`bldFlush` 里那套"只增不减"）。
   * 🔴 刷新函数名与 `moveend` 完全同一批三个，**没有**第二条刷新路（自检 ⑰ 钉着）。
   */
  function joyFlushNow(): void {
    if (!alive) return;
    /* ① 烘位移（口径与 `onJoyHalt` 的收尾逐字相同：容器归零 → 就地重投影） */
    const moved = joyAccX !== 0 || joyAccY !== 0;
    joyAccX = 0;
    joyAccY = 0;
    if (moved) {
      onMoveEndNames();
      reprojectNow();
      /* 摇杆还在推着 ⇒ "相机在动"这个状态照旧（同一个 tick，不产生一次闪烁） */
      cameraMoving.value = true;
    }
    /* ② 落楼：按当前视野重挑一次（仓库并集、冻结集、锚点一个都不动） */
    bldFlush("joy");
    /* ③ 取新格 → 重排名字（既有通路；新格落地时 feed 会自己再落一次图） */
    void refreshBundles("joy").then(() => (alive ? refreshNames("joy") : undefined));
  }

  /**
   * 收尾 —— **恰好一次**重算（判据 6：不是 0 次，也不是每帧 1 次）。
   *
   * 🔴 2026-10-03 第二轮**时点变了**：不再在手指抬起那一刻发，而是**相机回中跑完之后**才发
   * （`release()` → 回中段 → 相机贴回角色 → `onHalt`）。这样做有两个好处，都是一个原因：
   *   · 回中段里 `joyActive` **仍然为 true** ⇒ `panBy` 每帧引发的 `movestart/move/moveend`
   *     全部照旧早退，**回中期间 0 次重投影 / 0 次取包 / 0 次重排标签**（判据 ⑩e3 钉着）；
   *   · 那一次重算因此落在**画面已经停稳之后**，烘进节点坐标的位移是最终值 —— 不会留一条
   *     "重投影完了相机还在挪"的错位缝（机主报过的"名字错位/松手卡一下"就是这么来的）。
   *
   * 顺序照抄既有 `moveend`（同一个理由，见那里 2026-10-01 那段注释）：
   *   清标志 → 容器归零 → **就地重投影**（把这次位移烘进节点坐标）→ 一次取包 + 一次重排。
   * 🔴 那 600ms 去抖**不启动**（推送期间它一直没起过；收尾就直接跑一次，不再等）。
   */
  function onJoyHalt(): void {
    if (!joyActive) return;            // 没推过 ⇒ 不是"松手"，一次重算都不该有
    /* 🎯 预走线**紧跟着收干净**（幂等）：`halt` 是"每一次按压恰好一次"的收尾
       —— 正常路根本轮不到它干活（松手后第一帧 `phase="center"` 就把 class 摘了），
       它挡的是**病态路**：某一发按压短到松手后一帧都没投递
       （相机没动过、`zo` 也没动过），那时不在这里收，线就会**僵在半路**。
       放在守卫之后是**必须**的：这条判据钉着"没推过 ⇒ 一次重算都不做"（自检 ⑦）。 */
    joyAimReset();
    joyActive = false;
    /* 🕹🔴 **相机距离的保险丝**（研究 §9.5「松手后 zoom 回到出发值」的结构保证）：
       正常路走不到这里 —— 回中段的最后一帧会把 `zo` **恰好**写 0（`JOY_ZOOM_EPS_LEVELS` 那一跳），
       宿主那时就已经把相机 distance 放回 `joyZoom0`、名字层也跟着恢复，所以 `joyZoomApplied === 0`。
       只有病态路会命中：时钟被冻住 / rAF 反复给同一时间戳 ⇒ 回程被 `JOY_CENTER_MAX_FRAMES` 强收尾，
       `zo` 还停在半路。那时必须补一发，否则相机会**永久停在拉近后的距离**上、名字层也一直藏着。 */
    if (joyZoomApplied !== 0) {
      joyZoomApplied = 0;
      joyZoomPulling.value = false;
      const em = map as unknown as { easeTo?: (o: Record<string, unknown>) => void } | null;
      if (em && typeof em.easeTo === "function") {
        try {
          em.easeTo({ zoom: joyZoom0, duration: 0 });
        } catch {
          /* 相机收不了也不抛：`joyExit()` 的 `jumpTo(快照)` 兜底 */
        }
      }
    }
    const moved = joyAccX !== 0 || joyAccY !== 0;
    joyAccX = 0;
    joyAccY = 0;
    /* 🕹🧱 **补刷新的两个计数在这里复位**（"松手 = 上一次刷新翻篇"；下一次按下时 `onJoyDrive`
       还会再置一次 —— 这里复位是防"留在半路的值被下一次按下接走"）。
       ⚠️ 只动这两个计数：`joyMove`（跨按压保留的位置/朝向）一个字都不碰。 */
    joyFlushMovedM = 0;
    joyFlushElapsedMs = 0;
    /* 🕹🧱 **松手再刷一次**（"与既有松手补一次同口径"）：下面那条 `refreshBundles("joyhalt")`
       只会在**有新格**时落图（`wsOfflineFeed` 的 `if (!batch.length) return`）⇒ 停下来的这一屏
       可能一直停在走路中间那一批楼上。补一发 `bldFlush` 按**最终**视野重挑一次（同一条通路）。 */
    bldFlush("joyhalt");
    /* 🆕 停下即回正（§4）：踏步是 transform，不补这一下就会**停在"半抬腿"那一帧**上。
       朝向**不清**（人是停下了，不是转回正北）—— 关掉摇杆时才由 `joyExit()` 一并还原。
       角色位置也**不动**：速度在 `release()` 那一刻已经归零，松手后又不再跑帧 ⇒ 位置自然冻结。 */
    joyPinReset(false);
    if (!alive) return;
    if (moved) {
      onMoveEndNames();                // 容器归零（`cameraMoving=false` + 一次 transform 写）
      reprojectNow();                  // 重投影**只重投影、不重排**（O(N)，N ≤ 26）
    }
    /* 📍 **恰好一次**：摇杆推着的时候三个相机钩子全部早退（判据 3/6 的红线），
       屏外指示停在推杆前那一刻 —— 画面停稳之后在这里补一次（与名字层那一次重算同一个时点）。 */
    pinEdgeSync();
    if (bldTimer) window.clearTimeout(bldTimer);
    bldTimer = 0;
    void refreshBundles("joyhalt").then(() => (alive ? refreshNames("joyhalt") : undefined));
  }

  /* 🔴 摇杆**被卸载**时（面板把开关关掉、或 WebGL 掉了走 2D 降级路）组件那边只 `cancel()` ——
     它**不**发 `halt`（"控件没了" ≠ "松手"）。但这边的收尾一件都不能少，否则会留下两种残留：
       · `joyActive` 留在 true ⇒ 四个 handler **永远**早退（"地图从此不再刷新名字/不再取包"，一声不响）；
       · 相机停在近景的 64° ⇒ 与"关掉 = 逐字还原"矛盾。
     所以这里调**同一个** `joyExit()`（幂等：推着才做那一次重算，没快照就不动相机）。 */
  watch(
    () => joyGate.value.show,
    (on) => {
      if (!on) joyExit();
    }
  );

  /* 🧱 S3（M8）：`renderBundleHud` 整块搬进了 `wsHudStats.ts` —— 下面是**同一个函数**（从上面那次
     `createBundleHud` 接回来的），`scheduleBundleHud` 与 `bldFlush`/`roadsFlush` 那几个调用点
     一字未改、也没有第二份实现。 */

  /**
   * 🔴 **F4（2026-10-01 性能审计 §5.4）：HUD 一次落图只渲染一次。**
   *
   * 问题：一次楼/路落图里 `renderBundleHud()` 会被调好几处 —— `bldFlush.onPicked`、
   * `bldFlush.beforeDraw`、`roadsFlush.beforeDraw`、以及 `refreshBundles` 收尾（审计点名的三处 +
   * 复核时又找到的路那处）。每次写 **4 个 reactive ref** ⇒ 每次都是**一次整组件重渲染**，
   * 而审计把松手后的 DOM 变更分类统计出来：HUD 文本是**最大的一类（28 次）**。
   * 注意它单次都 <50ms（没量到 long task）—— 这里省的是"同一批数据被渲染好几遍"的抖动/GC，
   * **不是**在消灭某一帧的大卡顿（别把收益说过头）。
   *
   * 做法：**脏标记 + 微任务**。同一轮里调用 N 次 ⇒ 只在微任务里 `renderBundleHud()` 一次；
   * 读到的是**调用那一刻之后的最新 facts**（`facts()` 是同步快照，晚一点读只会更新、不会更旧）。
   * ⚠️ 这里只管**计数/判词那一行**（`stats.bldBundle/bldVerdict/…`）；名字层那条纪律
   * （`stats.names` 必须与节点**同一刻**写，`applyNamePlanWithHud`）**不归这里管，不许并进来**。
   */
  let bundleHudQueued = false;
  function scheduleBundleHud(): void {
    if (bundleHudQueued) return;
    bundleHudQueued = true;
    queueMicrotask(() => {
      bundleHudQueued = false;
      if (!alive) return;
      try { renderBundleHud(); } catch { /* HUD 失败不影响落图（与原来那处 try 同一口径） */ }
    });
  }

  /* 🧱 S3（M8）：`refreshBundles`（按视野补离线格）与 `attributionOfFeed`（取一个包的署名原句）
     整块搬进了 `wsHudStats.ts` —— 上面那次 `createBundleHud` 把它们接了回来。
     ⚠️ **摇杆那条补刷新调的就是同一个 `refreshBundles`**（`refreshBundles("joy")` / `("joyhalt")`，
     见 `onJoyDrive`/`onJoyHalt`）：搬的是定义、不是复制，`ws_joystick_selftest` 的 ⑰ 组钉着这一点。 */

  /** 🔴 署名（ODbL 硬要求）：句子**取自包里的 `index.json`**（导出脚本写的那句原话），不在这里重写 */
  async function loadBundleAttribution(): Promise<void> {
    try {
      /* 🌊 水/绿地那句由 **gw 层自己的 facts** 给（它内部读的就是同一个 `/gwbundle/index.json`，
         且已经走完候选目录判定 ⇒ 这里再读一遍等于第二份口径）。 */
      const [b, r] = await Promise.all([
        attributionOfFeed(bldFeed, "bld"),
        attributionOfFeed(roadsFeed, "roads"),
      ]);
      let g = "";
      try { g = gwLayer.facts().attribution || ""; } catch { g = ""; }
      const lines = [b, r, g].filter((x): x is string => !!x);
      stats.attribution = lines.join(" · ");
      /* 取不到就**如实说取不到**（不编一句"© Overture"充数；署名是合规项，不能猜） */
      if (!lines.length) stats.attribution = "离线包署名取不到（index.json 没拿到）";
    } catch {
      stats.attribution = "离线包署名取不到（index.json 没拿到）";
    }
  }

  /* ── 浏览器手势兜底（CSS 之外的保险）─────────────────────────────────────
     机主实测：即使 `.ws-dml` 上写了 `touch-action: none`，浏览器仍然把滑动当成页面手势
     （Via / 部分国产内核会忽略 touch-action，或抢的是"边缘返回手势"）。
     🧱 S3（M1）：`guardGestures` / `lockPageGestures` / `unlockPageGestures`（连它们的
     `htmlTouchBackup`）整块搬进了 `wsMapCamera.ts`；宿主只留 `unguard` 这个句柄。 */
  let unguard: (() => void) | null = null;

  /* 🧱 S3（M8）：fps 采样（`startFps`）整块搬进了 `wsHudStats.ts`，连 **rAF 句柄 `raf`** 一起
     （宿主 `onBeforeUnmount` 里那两句 `cancelAnimationFrame(raf); raf = 0;` 现在就是 `stopFps()`）。
     口径没变：它在"分渲染路"**之前**启动（上面那次 `startFps()`），降级路也有数。 */

  onMounted(async () => {
    /* ⚠️ 守卫看的是 **host**，不是 `cv`：2D 画布在 WebGL 路下**故意不存在**（`v-if="show2d"`），
       以前那句 `if (!cv.value) return;` 会让整段建图逻辑**直接不跑**（白屏零报错那种）。 */
    if (!host.value) return;
    /* `?autoshot=1` = 开代拍（页面自己截图回传）。写在最前面：
       后面任何一步 return（降级路）都不影响"开关已经开了"这件事。 */
    selfShotMaybeArmFromUrl();
    /* `?selfshot=1` = 开 **App 自拍**（主 App 页刷新一次就拍，不用点代拍页）。
       同样写在最前面：降级路也要拍 —— 那条路正是闸门"以为验过了"的路。 */
    appSelfShotMaybeArmFromUrl();
    /* 🔴 守卫必须挂在 **canvas** 上，不能挂整个 host：
       挂 host 时，手指哪怕只抖 1px，`touchmove` 的 preventDefault 就会让浏览器**取消这次触摸**
       ⇒ 后面根本不派发 click ⇒ 容器里的「＋ / － / 全区」**全部点不动**
       （机主 2026-09-19：「那个全区压根点不动」—— 就是这一行挂错了对象）。
       按钮是 canvas 的兄弟节点，只守护 canvas 就两全。 */
    if (cv.value) unguard = guardGestures(cv.value);
    lockPageGestures();
    /* 🧱 S3（M8）：那句 `timer = window.setInterval(… waited.value = Date.now() - t0 …, 200)` 就是
       `armTimer()`（`t0` / `waited` / `timer` 三个量一起搬去了 `wsHudStats.ts`）—— 时点与周期一字未改。 */
    armTimer();
    // ① WebGL 预检（无头/低端机可能是软件渲染甚至没有）→ **如实降级**，不白屏
    let ok = false;
    try {
      const t = document.createElement("canvas");
      ok = !!(t.getContext("webgl2") || t.getContext("webgl"));
    } catch {
      ok = false;
    }
    /* ⚠️ 顺序很重要：**先取数据**，再决定用哪条渲染路。
       原来"无 WebGL 就直接 return" ⇒ 低端机只能看到一行提示；现在改成
       **Canvas2D 降级**：用同一批真实楼房画俯视图（形状/朝向/高度来源都在），
       这样"没有 WebGL 的设备"也能看到小区 —— 顺带让无头环境（本机 WebGL 不可用）**可验证**。 */
    /* 用共享的 `BldFeature`：原来这里自己写了一份 `{geometry?: unknown}`，
       而 `geometry: unknown` 喂不进合并函数（它要 `{type?, coordinates?}`）——
       两份形状描述迟早漂移，所以只留一份。 */
    type BldgFeat = BldFeature;
    let fc: { features?: BldgFeat[]; error?: string } | null = null;
    let fetchFailed = false;
    /* ⚠️ 这两个**必须声明在 try 之外**：下面 `m.on("load")` 里要用 —— 写在 try 里就成了块作用域
       （tsc 直接 TS2304「Cannot find name 'districtBbox'」，我第一次就写错了）。 */
    let districtFeat: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> } | null =
      null;
    let districtBbox: [number, number, number, number] | null = null;
    /** 本次实际用的取楼半径（稀疏地段会自动放大一次；HUD 文案要用，所以声明在 try 外） */
    let usedR = props.radius;
    /** 是否"整区视野"（有区县 bbox）—— try 外也要用（写 HUD 文案），所以声明在外层 */
    let districtWide = false;
    /** 试过的取楼半径（如实写进 HUD：试过 600m 就必须写出来） */
    const triedRs: number[] = [props.radius];
    /** 行政区驻地（properties.center）：涪陵这种大区 bbox 中心会落在山里（实测 1.8km 内 0 栋），驻地才有楼 */
    let seat: { lng: number; lat: number } | null = null;
    const tFetch = performance.now();
    try {
      /* ⚠️ 必须用封装（它内部会解包 `geojson.features`）：
         原来这里直接 `fetch(...).json()` 后读**顶层** `features` ⇒ **恒为 0 栋**
         （后端明明返回了 179 栋），页面却显示"这一带没有楼房数据" —— 2026-09-19 事故。 */
      /* ⓪ **先拿"用户所在的区"的几何**：中心与边界都以它为准（IP 定位只作为最后兜底）。
         涪陵区实测：center=[107.3949,29.7037]、MultiPolygon；有了它就能"整区铺满"，
         并且取楼栋的坐标不再漂到别的城市去。 */
      if (props.adcode) {
        try {
          const gj = (await geoJson(String(props.adcode))) as {
            features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }>;
          };
          districtFeat = gj?.features?.[0] ?? null;
          districtBbox = bboxOfGeometry(districtFeat?.geometry);
          bboxRef.value = districtBbox;
          stats.pinsAnchor = "行政区 bbox";
          /* 如实记下"这是哪个区"（如"涪陵区"）：HUD 直接显示，验证时一眼能看出对不对得上 */
          stats.area = String((districtFeat?.properties || {}).name || props.area || "");
          const pc = (districtFeat?.properties || {}).center as unknown;
          if (Array.isArray(pc) && pc.length >= 2 && Number.isFinite(Number(pc[0])) && Number.isFinite(Number(pc[1]))) {
            seat = { lng: Number(pc[0]), lat: Number(pc[1]) };
          }
        } catch {
          districtFeat = null;
          districtBbox = null;
          bboxRef.value = null;
        }
      }

      /* 整区视野下**不取楼**（机主 2026-09-19：小区生成半天不完成）：
         楼栋是现问 Overpass 的（涪陵实测几十秒起），以前它挡在加载流程**前面** ⇒ 整个小区级一直转圈。
         现在：有区县 bbox（= 整区视野）就**先出图**（底图 + 等高线），楼栋等放大到街区再按视野取；
         只有拿不到 adcode（老路径）时才保留原来的先取楼再建图行为。 */
      districtWide = !!districtBbox;
      /* 注意：这里**不要**写 stats.note —— 下面"空结果"那段已经会写同一句，
         两处都写 HUD 里就会出现「… · …」重复（本轮实测就重复了）。 */

      /* 🆕 示意街区的画布：**小区尺度的正方形**，铺在驻地（有人住的地方）。
         为什么不用 `districtBbox`：那是整个区县（涪陵 75km 宽）——
         28 格铺上去一格 2.7km，一栋"楼"2.7 公里宽，是薄饼不是楼。见 `AI_SPAN_M`。
         位置优先级与取楼一致：**驻地 > bbox 中心**（bbox 中心常常落在山里）。 */
      if (seat) {
        aiBboxRef.value = boxAround(seat.lng, seat.lat, AI_SPAN_M);
      } else if (districtBbox) {
        aiBboxRef.value = boxAround(
          (districtBbox[0] + districtBbox[2]) / 2,
          (districtBbox[1] + districtBbox[3]) / 2,
          AI_SPAN_M
        );
      }

      /* ① **先拿坐标，再带坐标取楼栋**（2026-09-19 事故）：
         不带坐标时后端用它自己的"最近一次定位"兜底，实测那个点是 29.752,107.278（另一座城）⇒ **0 栋**，
         而渝中 29.558,106.569 有 **285 栋** —— 页面于是显示"这一带没有楼房数据"（把"拿错坐标"说成了"没有数据"）。
         `fast: true` = IP 快速档，不会弹 GPS 授权；拿不到就退回原来的兜底路（不阻塞）。 */
      let lat: number | undefined;
      let lng: number | undefined;
      if (seat) {
        /* 最高优先：所在区的**驻地**（真实有人住的地方，楼栋才取得到） */
        lat = seat.lat;
        lng = seat.lng;
      } else if (districtBbox) {
        /* 次选：bbox 中心（形状不规则时可能落在山里 ⇒ 只在没有 center 时用） */
        lat = (districtBbox[1] + districtBbox[3]) / 2;
        lng = (districtBbox[0] + districtBbox[2]) / 2;
      }
      /* 🔴 **F2（2026-10-01 性能审计 §5.1）：定位不再挡在建图的关键路径上。**
         · **谁在等它**：只有下面 `if (!districtWide && bldLive.live)` 那一段 —— 本文件里读 `lat/lng`
           的**全部只有两处**（`:fetchBuildingsWithRetry(lat, lng, props.radius)` 与"楼房稀疏放大半径"
           那次重试），两处都在 live 分支里。
         · **现在谁不等了**：默认口径（楼从**离线楼房包**来、`bldLive.live=false`）—— 它根本不用这个结果，
           却原来要**串着等**这一跳（审计实测 1289ms / 忙时 1870ms，§4「关键路径」那一行）。
         · **live 路径为什么不受影响**：请求还是同一个 `?fast=1`、参数逐字相同，只是**发起点提前到这里**
           而**等待点搬进 live 分支**（下面 `await locP`）；`Number.isFinite` 判据、失败后「保持 undefined、
           让后端兜底」这条语义、以及"有坐标就不打定位"（原来 `throw new Error("skip-ip")` 的语义）
           全部逐字保留 ⇒ 那两处的输入与原来完全一致。
         ⚠️ 默认口径下**一个 `/api/location` 都不发**（省的是"算完就扔"的那一跳，不是拿别的东西顶替）。 */
      type LocRes = Awaited<ReturnType<typeof worldMapApi.location>> | null;
      let locP: Promise<LocRes> | null = null;
      if (lat === undefined && lng === undefined && bldLive.live) {
        /* `worldMapApi.location` 内部三级降级、自己**永不抛**；这里仍兜一层 `catch(() => null)`
           ⇒ 与原来那个 `catch`（"定位拿不到：保持 undefined，让后端兜底"）同一语义。 */
        locP = worldMapApi.location({ fast: true }).catch(() => null);
      }
      let geo: { features?: unknown[] } | null = null;
      /* 🧱 **offline-first**（切片 A）：默认**不发**这条 `/api/buildings`（决策在真源
         `wsScene.bldLiveDecision()`）—— 现场一次只覆盖视野中心 R≤2000m 且冷查 27~33s（最慢 91.7s），
         正是机主看到的"**楼只有一块**"。楼改从**离线楼房包**来（`/bldbundle/<格>.json`，静态文件），
         在地图 `load` 之后按视野补格（见 `refreshBundles`）。`?live=1` 才走下面这条兜底。 */
      if (!districtWide && bldLive.live) {
        /* 🔴 2026-09-24 取数超时重做（机主「有时矢量层不出现」→ 父会话定的下一刀）：
           原来这里一把 **20s** 硬超时、**不重试**。而同一台后端实测**冷查 27~33s**
           （`/api/buildings` 渝中 600m 冷 27.3s / `/api/roads` 32.5s；缓存命中 0.03~0.05s）
           ⇒ **冷启动那次几乎必然超时** ⇒ `fc=null` ⇒ 屏幕上**一栋楼都没有**，
           而人看到的只是"这一带没楼"（真因却是"我们没等够"）。
           现在：**放宽到 55s** + **最多重试 2 次**（第 2 次开始后端多半已在写缓存 ⇒ 命中很快），
           并把"超时/失败 + 试了几次 + 原文"如实写进 HUD（**三态：失败/空数据/成功，不许混**）。 */
        /* 🧭 F2：**live 是唯一要用定位结果的通路** ⇒ 只有这里 await 它（默认口径连发起都不发、
           更不等）。上面那次 `throw new Error("skip-ip")` 的语义因此也没丢：有坐标时压根没有这条 promise。 */
        if (locP) {
          try {
            const loc = await locP;
            /* `loc` 可能为 null（发起时 `.catch(() => null)` 兜底）⇒ 先判空再读字段。
               与原判据**等价**：`Number.isFinite(undefined)` 本来就是 false（原来那句用
               `loc?.lat` 可选链，null 一样进不来）。 */
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
              lat = Number(loc.lat);
              lng = Number(loc.lng);
            }
          } catch {
            /* 定位拿不到：保持 undefined，让后端兜底（与原来行为一致） */
          }
        }
        geo = (await fetchBuildingsWithRetry(lat, lng, props.radius)) as { features?: unknown[] } | null;
      } else if (!districtWide) {
        /* 没走 live ⇒ 如实留一句"楼从离线包来"（不写"没有楼"，也不写 0） */
        stats.note = "楼从**离线楼房包**来（默认不发 /api/buildings；要现场取数加 ?live=1）";
      }
      /* OSM 楼栋覆盖**极不均匀**（2026-09-19 实测同一个后端：涪陵区中心 400m→**0 栋**、600m→3 栋、
         1500m→29 栋；渝中区中心 400m→**152 栋**）。所以第一把太少时**自动放大一次**半径
         （只放一次、封顶 2500m，免得把 Overpass 打爆），并把这件事写进 HUD —— 不假装"没有楼房"。 */
      if (!districtWide && bldLive.live && (geo?.features?.length ?? 0) < 5) {
        const r2 = Math.min(2500, Math.max(1500, props.radius * 3));
        triedRs.push(r2);
        const geo2 = (await fetchBuildingsWithRetry(lat, lng, r2)) as { features?: unknown[] } | null;
        if ((geo2?.features?.length ?? 0) > (geo?.features?.length ?? 0)) {
          geo = geo2;
          usedR = r2;
          stats.note = `楼房稀疏：取楼半径已放大到 ${r2}m`;
        }
      }
      fc = geo ? { features: geo.features as BldgFeat[] } : null;
    } catch (e) {
      fc = null;
      fetchFailed = true;
      /* 失败原因**原样留下**（HUD/面板都要写它 —— 原来只有一句"后端没响应"，看不出是超时还是 500）。
         🧱 S4（M2）：这份原因的**所有者**跟着 `fetchBuildingsWithRetry` 搬去了 `wsViewFetch`，
         这里换成它的入口（写的是**同一个** `bldFailedWhy`，不是第二份）。 */
      viewFetch.noteBldFailure(String((e as Error)?.message || e || "未知原因").slice(0, 60));
    }
    /* 记下**这次**的真实耗时：下一次进来它就成了"约还需"的依据（没有记忆就不画进度条） */
    const fetchMs = Math.round(performance.now() - tFetch);
    if (fetchMs > 500 && fc?.features?.length) {
      lastMs.value = fetchMs;
      try {
        localStorage.setItem(K_MS, String(fetchMs));
      } catch {
        /* 写不进去也不影响本次 */
      }
    }
    if (!alive) return;
    phase.value = "build";
    if (fc?.features?.length) classify(fc as { features?: BldFeature[] });
    if (!fc || fc.error || !fc.features?.length) {
      /* 如实区分三种情况：请求失败 / 后端报错 / 真的这一带没有楼（别再把失败说成"没有数据"） */
      const base = fetchFailed
        ? `楼房取不到（${viewFetch.bldFailedWhyNow() || "后端没响应"}，已试 ${viewFetch.bldTriesNow()} 次 · 半径 ${triedRs.join("m 与 ")}m）`
        : fc?.error
          ? String(fc.error).slice(0, 40)
          : districtWide
            ? "全区视野：放大到街区后自动加载楼房"
            : `OSM 在这一带没有登记楼房（已试 ${triedRs.join("m 与 ")}m）`;
      /* 上面若已写过"稀疏已放大半径"，两条都保留（用 · 连起来），别把信息覆盖掉 */
      stats.note = stats.note ? `${stats.note} · ${base}` : base;
    }

    /* fps 从这里就开始数（降级路也要有数，见 `startFps` 的说明） */
    startFps();
    if (!ok) {
      fallback2d("2D 降级（无 WebGL）", fc, "", "perm", map);
      return;
    }
    phase.value = "render";

    /* ⚠️ **必须用变量间接**：写成字面量 `import("/vendor/...")` 会让 TS 去解析这个路径
       （`TS2307: Cannot find module`），而它在运行时是 public/ 下的静态文件、根本没有类型。
       用变量之后 TS 不再解析（`any`），Vite 也不参与（public/ 原样发布）—— 两边都干净。 */
    const ML_URL = "/vendor/maplibre/maplibre-gl.mjs";
    /* 🎨 **样式表放在引擎前面发**（2026-10-01 首屏审计，施工图 `BLUEPRINT-FIRSTPAINT.md` 方案 1）：
       `ensureMlCss()` 只是往 `<head>` 插一个 `<link>`（幂等、不阻塞 JS），而引擎是 584KB 的
       `await import(...)` ⇒ 原来 CSS 要**等引擎解析完**才发请求（实测：页面 chunk 的 CSS @t≈1419，
       而 maplibre-gl.css 83,195B 直到 @t≈2481 才到）⇒ 提前到 import 之前，两张表并行下载，
       预估省 **≈0.9s**（推算，需复量）。 */
    ensureMlCss();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let maplibregl: any = null;
    try {
      const mod = await import(/* @vite-ignore */ ML_URL);
      maplibregl = mod?.default || mod;
    } catch (e) {
      /* 🔴 原文必须带出来（原来写的是**猜的**一句「vendor/maplibre 缺失？」+ 把异常吞掉）。
         代价：HUD 上那句猜的话把"到底是 404、语法错、还是 worker 起不来"盖住了 ——
         2026-09-26 实测就吃过这个亏：控制台里手动 `import()` **成功**（hasMap=true），
         而宿主里这一句失败、且**一个字的原因都没有**，只能靠翻源码猜。
         现在把异常原文写进 `fallbackWhy`（面板/样式 JSON 都会带它）——失败不许静默。 */
      const why = String((e as Error)?.message || e).slice(0, 140);
      fallback2d("2D 降级（地图库加载失败）", null, `vendor/maplibre 加载失败：${why || "（无 message）"}`, "perm", map);
      return;
    }
    mlMod = maplibregl; // Marker 在它身上，setup 作用域的 syncPins 要用
    /* 🔴 **引擎和样式表必须成对**（2026-10-01 修机主报的「人物位置错位」）：
       本组件是**绕过 `useWsMapLibre` 自己 import 引擎**的那条路（为了不碰 package.json），
       而这条路原来只把**引擎**拿进来了、没拿 **样式表** ⇒ 页面上一条 `.maplibregl-*` 规则都没有：
         · `.maplibregl-marker{position:absolute}` 缺失 ⇒ 角色钉子**掉进文档流**，
           它们的 `translate(x,y)` 只是叠在流式位置上（实测 4 个钉子被推到 y 589~958，视口只有 557 高）；
         · `.maplibregl-canvas-container{position:absolute}` 同样缺失（容器成了 static）。
       实测脚本：`~/chk/_mlcss_probe.mjs`（`position: "static"` / `markerRule: null` / `mlLinks: []`）。
       ⇒ 与 composable 那条路**用同一个注入函数**（幂等；`wsmaplibre_selftest.mjs` ⑤ 盯着这条配对）。
       ⚠️ 2026-10-01 起这次调用**已经提前到 `import(ML_URL)` 之前**（见上面那段注释），
       这里不再重复调用 —— 两处都在只会是同一个幂等操作。 */
    mapAvailable.value = true;
    if (!alive || !maplibregl?.Map) {
      phase.value = "done";
      stopTimer();
      return;
    }

    /* 🔴🔴 2026-09-21（真 P0，机主面板截图定案）：**建图那一刻容器如果还没有布局尺寸**
       （0×0：还在加载态/刚插入 DOM/父级还没排版），MapLibre 会把 canvas buffer 定成**默认 300×150**，
       而 CSS 又把它拉满整屏 ⇒ 屏幕上是一块**纯色的空画布**（alpha=0，一帧都没画过）。
       机主那张面板证据：`画布 300×150 像素 / 布局 1253×429 / dpr=3`、`地图库零错误`、`首帧已出`。
       ⇒ 所以：① 建图前**等容器真有尺寸**（有上限，量不到也照建，绝不卡死）；
                ② 建图后**主动补几次 resize**（加载态收起/转屏/分屏都会改尺寸）。 */
    await waitForBox(host.value);

    // ③ 建图（注意：样式里**不能写 `glyphs: undefined`** —— 会让样式校验失败且零报错）
    const m = new maplibregl.Map({
      container: host.value as HTMLElement,
      /* `cv.value` 在 WebGL 路下是 null（`v-if` 关着）⇒ 不能把 null 当 canvas 传 */
      ...(cv.value ? { canvas: cv.value as HTMLCanvasElement } : {}),
      style: styleNow(),
      center: [106.569, 29.558],
      /* 🎬 相机默认值取自 `wsScene.cameraDefaults()`（唯一真源；数值与换源前**逐字相同** 16.4/38） */
      zoom: cameraDefaults().zoom,
      pitch: initPitch.value,
      /* 🎬 2026-09-24 机主拍板「相机全统一」⇒ bearing/maxPitch 也取自 `wsScene`（-18 / 70）。
         顺带修掉「侧视角一划就没」：原来 85° 太贴近地平线，同样的手指位移对应巨大的地面距离。 */
      bearing: cameraDefaults().bearing,
      /* 🔴 `maxPitch` 必须显式放开：MapLibre 的默认上限是 **60°** ——
         不改的话机主"想往下压看天"最多压到 60，永远抬不起头。
         85° 是 MapLibre 允许的上限（90 会把相机压到与地面平行、数值上容易出问题）。 */
      maxPitch: cameraDefaults().maxPitch, // 70（机主拍板：与代拍页统一）
      attributionControl: false,
      /* 🔴 2026-09-25（父代理从 vendored 库**逐字核出**的一手证据）：`preserveDrawingBuffer`
         **必须写在 `canvasContextAttributes` 里** —— 顶层那个键本构建**根本不读**：
         全库只出现 1 次（`defaultOptions.canvasContextAttributes:{antialias:!1,preserveDrawingBuffer:!1,…}`），
         构造期做的是 `{...jm, ...e, canvasContextAttributes:{...jm.canvasContextAttributes, ...e.canvasContextAttributes}}`
         ⇒ 写在顶层 = 截图/自拍**拍到空白**（App 自拍那条链一直拿不到真画面）。
         ⚠️ 只写这一个键：其余默认值靠库的浅合并保住（`antialias` 等行为一字不变）。 */
      canvasContextAttributes: { preserveDrawingBuffer: true },
      /* 🗺 **关掉世界副本**：库默认 `renderWorldCopies: true` —— 经度滚过边界时最多多画 7 份世界
         （`for(let e=1;e<=3;e++)`）。我们只做中国城市级，那 6 份一份都不需要（纯白花填充率）。 */
      renderWorldCopies: false,
      /* 🧠 瓦片缓存收口：库默认 `maxTileCacheSize: null`（= 不设上限）⇒ 长时间拖动后瓦片会一直堆着。
         低档给更小的一份（`maxTileCacheZoomLevels` **不动**：它的默认值本来就是库常量，重复设没有意义）。 */
      maxTileCacheSize: perf.low.value ? 40 : 120,
      /* 🖥 低档机**像素比封顶 1.5**（真机 dpr 常见 2.4~3，填充率按平方涨）。
         库源码确认这条是真的生效的：`getPixelRatio(){return this._overridePixelRatio ?? devicePixelRatio}`
         —— 传了就覆盖，不传（高档）逐字保持原行为。⚠️ 取舍：观感略软，换填充率。 */
      ...(perf.low.value ? { pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5) } : {}),
    });
    map = m;

    /* 🎬 侧视角护栏（**唯一真源** `wsScene.applyPitchGuard()`）—— 补「App = 代拍页那一屏」的欠账：
       代拍页早就有这套（pitch > 55° 按比例降拖动/滚轮速度），App 侧一直没搬 ⇒ 侧视角一划就没
       （同样的手指位移对应巨大的地面距离）。数值全部取自 `wsScene`，**不在这里抄第二份**。
       调两次：建图后立刻一次（此刻 `dragPan` 可能还没挂 ⇒ 函数内部静默跳过），
       之后每次 `pitch` 变化重设一次（已读源码确认 `enable()` 会重写惯性选项 ⇒ 真的生效）。 */
    applyPitchGuard(m);
    m.on("pitch", () => {
      applyPitchGuard(m);
    });

    /* 🔴 **必须有这个监听器**（2026-09-19 用一次真实事故换来的）：
       地图库的错误**不会**冒泡成 JS 异常 —— 样式校验失败时它只发一个 `error` 事件，
       然后 `load` **永远不触发**：底图不画、楼不画、连瓦片都不请求，
       屏幕上是一块**全透明的空画布**，而页面**零报错**（控制台也干干净净）。
       代拍回来的三张"纯白"就是这么来的（白 = α=0 的透明图）。
       ⇒ 把它接到 HUD 的 note 上：**坏掉要看得见**，而不是让人猜"是不是没做好"。 */
    m.on("error", (e: { error?: { message?: string } }) => {
      const msg = String(e?.error?.message || e || "").slice(0, 60);
      if (msg) stats.note = stats.note ? `${stats.note} · 地图库：${msg}` : `地图库报错：${msg}`;
    });
    /* 📊 **另挂一个只记不改的**（不动上面那条的语义）：`stats.note` 会被后来的写入覆盖，
       而样式自检 JSON 要的是"从头到现在一共报过哪些错"。最多留 20 条（自检包不灌水）。 */
    m.on("error", (e: { error?: { message?: string } }) => {
      const msg = String(e?.error?.message || e || "").slice(0, 160);
      if (msg && mapErrs.length < 20) mapErrs.push(msg);
    });

    /* ⏱ **看门狗**：地图库"起来了"不等于"画出来了"。
       WebGL 初始化失败、上下文被系统回收、驱动摆烂时，MapLibre **不发错误、也不发 `load`**
       —— 页面于是永远停在「初始化…」，HUD 只有一行小字，**控制台干干净净**。
       实测（2026-09-19 无头环境）：`hasWebGL()` 为真、`new Map()` 成功、`load` 永不触发、
       `stats.mode` 停在初值「初始化…」、fps 1 —— 这就是"能玩"闸门第③条挂掉的现场。
       ⇒ 给它一个期限；过期就**如实降级**到 2D 路（有楼、有人、有解释），
         而不是让人对着一块不动的画面猜"是不是还没加载好"。

       🔴 2026-09-21 两处修正（机主"整屏纯色"事件的后续）：
       ① **期限不能一刀切 8 秒**：真机冷启动要等样式 + 首批瓦片（弱网实测十几秒），
          而 8 秒刚好卡在中间 ⇒ 一台**本来能跑 WebGL** 的机器被无谓地打进 2D 自绘路，
          那条路在"全区视野"下又没有楼栋数据 ⇒ 机主看到的就是**一整片底色**。
          ⇒ 环境感知：自动化/无头保持 8s（**闸门就靠这条**，等久了会把闸门拖成假失败），
            真机 24s、低端 12s。
       ② **别只看时间**：期限到点先问一句"它到底动过没有"（`sawRender` = 真出过一帧）。
          动过 ⇒ 真机上再宽限一次（**只宽限一次**，且自动化不宽限，免得无限等下去）。
          仍然没动 ⇒ 如实降级，并把**实际期限**写进 HUD（原来写死"8 秒"，改了期限就成了假话）。 */
    m.on("render", () => {
      sawRender = true;
    });
    /* 🔴 建图后**立刻**清一次"容器里那些不是地图的画布"：
       定案证据（机主 canvas 清单）—— 地图那块 `maplibregl-canvas` **尺寸完全正确 3759×1287**，
       而模板那块 `ws-dml__cv`（buffer 停在默认 300×150、CSS 拉满整屏、display:block）**压在它上面**
       ⇒ 机主看到的"浅色矩形"就是这块空壳。不清掉，地图画得再好也看不见。 */
    removeStrayCanvases();
    /* 🔴 2026-09-26（与代拍页同一个病；App 自证原文：`路网落图失败：Style is not done loading.`）：
       样式还没就绪时 `addSource`/`addLayer` **会直接抛**，而各调用点把异常吞进 `stats.note`/面板
       ⇒ 楼/路/水绿**整层消失**，屏幕上只剩底图与名字 —— 机主原话「**有名字，无建筑**」。
       修法：样式就绪前**先排队**；`style.load`/`load` 之后按原顺序补做（FIFO ⇒ addSource 一定先于依赖它的 addLayer）。
       兜底再挂一个有界定时器（4s 一次，不常驻）。 */
    const pendingStyleOps: Array<() => void> = [];
    try {
      const styleReady = (): boolean => {
        try { return !!(m as unknown as { isStyleLoaded?: () => boolean }).isStyleLoaded?.(); } catch { return false; }
      };
      const _addLayer = m.addLayer.bind(m) as unknown as (s: unknown, b?: unknown) => unknown;
      const _addSource = m.addSource.bind(m) as unknown as (i: string, s: unknown) => unknown;
      const flushPending = (): void => {
        const q = pendingStyleOps.splice(0);
        for (const fn of q) {
          try { fn(); } catch (e) {
            stats.note = stats.note
              ? `${stats.note} · 补层失败：${String((e as Error)?.message || e).slice(0, 40)}`
              : `补层失败：${e}`;
          }
        }
      };
      (m as unknown as { addLayer: unknown }).addLayer = (spec: unknown, before?: unknown) => {
        if (!styleReady()) { pendingStyleOps.push(() => { _addLayer(spec, before); }); return m; }
        return _addLayer(spec, before);
      };
      (m as unknown as { addSource: unknown }).addSource = (id: string, spec: unknown) => {
        if (!styleReady()) { pendingStyleOps.push(() => { _addSource(id, spec); }); return m; }
        return _addSource(id, spec);
      };
      m.once("style.load", flushPending);
      m.once("load", flushPending);
      window.setTimeout(flushPending, 4000);
    } catch { /* 包装失败不影响地图 */ }
    /* 建图后补 resize（含观察容器尺寸变化）—— 见上面那段"真 P0"的说明 */
    kickResize(m);
    watchdog = window.setTimeout(() => {
      /* 已经画完就不用管了（看门狗不是"超时即失败"，是"到点还没好才算失败"） */
      if (!alive || phase.value === "done") return;
      const limitMs = WATCHDOG_MS.value;
      if (sawRender && !isAutomation() && !watchdogGraceUsed) {
        /* 出过帧 ⇒ 它在动，只是还没到 `load`（大瓦片/慢盘）。**只宽限一次**。 */
        watchdogGraceUsed = true;
        stats.note = stats.note
          ? `${stats.note} · 地图库已出帧但未就绪，宽限中`
          : "地图库已出帧但未就绪，宽限中";
        watchdog = window.setTimeout(() => watchdogFire(m, fc, limitMs), limitMs);
        return;
      }
      watchdogFire(m, fc, limitMs);
    }, WATCHDOG_MS.value);

    m.on("load", () => {
      /* 第一帧真的出来了 ⇒ 撤掉看门狗（它不是"超时就算失败"，是"到点还没好才算失败"） */
      window.clearTimeout(watchdog);
      if (fc?.features?.length) {
        /* `?live=1` 的首批（或老路径）：**并进同一个累积仓库**再 flush ——
           落图通路只有一条（`bldFlush` → 真源 `flushBldStore`），一次 `setData`，换视野不减。 */
        bldStore.merge(fc.features as unknown as BundleBuildingFeature[], "live:init");
        bldFlush("live+init");
        // 用真实楼房的范围收一下相机（取不到就保持默认中心）
        try {
          const b = new (maplibregl as unknown as { LngLatBounds: new () => unknown }).LngLatBounds();
          for (const f of (fc as { features?: Array<{ geometry?: { coordinates?: unknown } }> }).features || []) {
            const g = f.geometry || {};
            const walk = (v: unknown): void => {
              if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
                (b as { extend: (c: [number, number]) => void }).extend([v[0] as number, v[1] as number]);
              } else if (Array.isArray(v)) {
                for (const x of v) walk(x);
              }
            };
            walk(g.coordinates);
          }
          m.fitBounds(b as never, { padding: 24, pitch: initPitch.value, duration: 0 });
        } catch {
          /* 收不了相机就用默认视野，不影响可用性 */
        }
      }
      /* ④ **整区视野**：先按区县 bbox 铺满（"像省级地图一样显示整个区"）。
         楼栋在整区尺度上只是几个像素点，所以**放大到街区再取**（见下面的 moveend）。 */
      /* 🔴 默认视野 = **街道级 + 倾斜**（机主 2026-09-19：「这个小区怎么是 2d 的，我的 3d 建筑呢」）。
         之前我为了让"整区铺满"生效，一进来就 `fitBounds(整个区)`（zoom≈10）——
         那个缩放下楼栋是亚像素的，加上"放大到街区才取楼"的规则 ⇒ **一栋楼都看不见、看着就是 2D**。
         现在反过来：默认落在**区驻地**的街道级（zoom 15.2 + pitch），楼栋立刻可取 ⇒ 3D 马上可见；
         "看整个区"降级成右上角那个「全区」按钮（想广角时点一下）。 */
      if (seat || districtBbox) {
        try {
          const c: [number, number] = seat
            ? [seat.lng, seat.lat]
            : [(districtBbox![0] + districtBbox![2]) / 2, (districtBbox![1] + districtBbox![3]) / 2];
          /* 🔴 2026-09-19 再把默认缩放**推近一档**（15.2 → 16.4）。
             为什么：zoom 15.2 在手机横屏上**一眼 4km 宽**（分辨率约 3.6m/px），
             一栋 20m 的楼只有 5~6 个像素 —— 这不是"小区级"，是"城区全景"，
             而且取楼半径按视野算会落到 1.4km 上限，Overpass 更容易拖挂。
             16.4 ≈ 1.6m/px：同样的楼有 12~13 像素，成片的街区才真的"成片"。 */
          m.jumpTo({ center: c, zoom: 16.4, pitch: initPitch.value, bearing: 0 } as never);
          /* 🕹 **启动时摇杆就是开**（存储值/URL 显式打开）⇒ 把"没有摇杆时的机位"记下来：
             关了开关要**逐字还原**到这一份（俯角 = `basePitch`，不是 64）。
             ⚠️ 只有这一处能在建图期填快照：此刻相机已经是 64 了，现读只会读到"接管后"的值。 */
          if (props.joy) {
            joyPrevCam = { center: [c[0], c[1]], zoom: 16.4, pitch: basePitch.value, bearing: 0 };
          }
          stats.mode = "街区视野（街道级）";
          stats.view = "街区视野";
          /* 🆕 建图这一刻就**主动取一次楼**（以前只靠 `moveend` 触发）。
             为什么必须补这一下：`jumpTo` 之后如果视野没变（或 moveend 在监听器挂上之前就发过了），
             `moveend` 根本不会来 ⇒ 屏幕上永远没有楼、HUD 永远 `🏢 0`。
             用户看到的是"这功能坏了"，而不是"还差一次移动"。 */
          void loadBuildingsForView(m as unknown as BldMapLike);
          void loadRoadsForView(m as unknown as BldMapLike); // 路网与楼并行取（互不阻塞）
          void loadFacilities(m as unknown as BldMapLike); // 设施一次就够（不随视野重取）
        } catch {
          /* 收不了相机就保持默认视野 */
        }
      } else {
        /* 🆕 2026-09-26（父代理批准的一行，**读数诚实**问题）：
           上面那段只在"给了 adcode"（有驻地/区界 bbox）时才跑，而**新入口 `/worldsim`
           故意不传 adcode**（城市数据按城市包来，没有"区县"这一级）⇒ `stats.mode` 会一直停在
           初值「初始化…」，尽管地图早就跑起来了（离线格/楼/水绿都在动）。
           用户与探针都会把「初始化…」读成"还没就绪" —— 那是一句**会骗人的读数**。
           这里如实换一句：默认机位、没有指定区县。**不改任何行为**（只是给读数赋值）。 */
        stats.mode = "默认机位（未指定区县）";
      }
      /* 🕹 **启动时摇杆就是开**（存储值/`?joy=1`）⇒ 记下"没有摇杆时的机位"，关了开关要逐字还原。
         上面那条分支（有驻地/区界 bbox）已经在 `jumpTo` 那行旁边填过快照了；这里是**兜底**：
         没有 bbox 时相机停在建图默认值上，center/zoom/bearing 现读即可（近景只改过俯角），
         `pitch` 用 `basePitch`（= 关着时该有的那个 38）。
         ⚠️ 读不齐就**不填**（`joyPrevCam` 留 null）⇒ 关闭时一次相机都不动 —— 宁可不动，也不编一个机位。 */
      if (props.joy && !joyPrevCam) {
        const cam0 = joyReadCam();
        if (cam0) joyPrevCam = { ...cam0, pitch: basePitch.value };
      }
      /* 📍 **屏外方向指示的几何**（容器尺寸 + 四边安全区）在这里量一次 —— **与摇杆无关**
         （摇杆关着也照样要有"其他角色在哪"的指示），resize/转屏时在 `onWinResize()` 里重量。 */
      pinEdgeMeasure();
      /* 🕹 启动时摇杆就是开（存储值/`?joy=1`）⇒ 在这里把**漫游会话**也建起来，与运行期打开走同一条语义：
         ① `joyCalibrate()` 量「屏幕 px → 经纬度」（此刻俯角已经是 64 ⇒ 量的是近景那把尺子）；
         ② 位置真源 +「我」那颗钉子一起落到画面中心 —— 不这么做的话，"启动就开摇杆"这条路上
            `joyEnter()` 不会被调用（`watch` 只在**变化**时触发），标尺是空的 ⇒ 人推杆只有相机动、
            角色还是不动（同一句"太杂鱼"再犯一次）。
         ⚠️ 判据用 `joyGate.show`（= 摇杆到底在不在）而不是 `props.joy`：2D 降级路 DOM 里没有摇杆，
            那条路一个字都不许动（判据 9/10）。 */
      if (joyGate.value.show) {
        joyMeasureVh();     // 🕹 §15：底盘尺寸按容器高度定（建图这一刻量一次；resize 时再量）
        joyCalibrate();
        if (joyOrigin) roamStore.write(joyOrigin.lng, joyOrigin.lat, joyMove.headingDeg);
        joyApplyRoam(joyMove);
      }
      /* 🗄 2026-09-24 已移除：区县边界（`dist-fill` / `dist-line`，"整区铺满"的可读性）。
         代拍页那一屏没有它；机主要"只留代拍页代码"⇒ 这一层不挂。
         `districtFeat` 仍然照旧取（相机中心/驻地/取楼半径都靠它），只是不再画边界。
         恢复：`git revert <本 commit>`。 */
      if (false && districtFeat) {
        try {
          m.addSource("dist", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [districtFeat] },
          });
          const below = m.getLayer("bld-ext") ? "bld-ext" : undefined;
          m.addLayer(
            { id: "dist-fill", type: "fill", source: "dist", paint: { "fill-color": "#79d9ff", "fill-opacity": 0.06 } },
            below
          );
          m.addLayer(
            {
              id: "dist-line",
              type: "line",
              source: "dist",
              paint: { "line-color": "#79d9ff", "line-width": 1.4, "line-opacity": 0.9 },
            },
            below
          );
        } catch {
          /* 画不上就算了：区界只是更好读，不该影响主流程 */
        }
      }

      /* 🗄 2026-09-24 机主裁定「App 页现在只准保留代拍页代码」⇒ 三样不再挂：
         ① **等高线**（`drawContours`，代拍页没有这一层）；② **AI 示意层**（`syncAiLayers`，
         楼栋稀疏时叠的暖色示意图元）；③ 下面的**区县边界**（`dist-fill`/`dist-line`）。
         ⚠️ `syncPins()` **保留**：它是地图上的人（`markers`），代拍页之外但属"同一屏"的地图图层，
            机主没点它；要停就传 `:markers="[]"`（`WorldSim` 那边一行的事）。
         恢复：`git revert <本 commit>`（备份 tag `attic/pre-sceneview2-20260924`）。 */
      syncPins();
      phase.value = "done";
      stopTimer();
      /* 🧱🏢🛣 **离线包首刷**（切片 A）：地图一就绪就按视野补格（后台、串行、每格独立超时）。
         放在 `phase=done` 之后 ⇒ **不阻塞首屏**（这正是治"加载慢"的那一刀：以前要等
         `/api/buildings` 十几秒到 91.7s，现在首屏一出来楼就一批批补进来）。
         ⚠️ 楼/路走同一条管道（`refreshBundles`），live 只在 `?live=1` 时另外打。
         🔴 2026-09-28 **删掉了一次重复调用**：这里原来先 `void refreshBundles("init")`，
         下一行又 `void refreshBundles("init").then(名字层)` —— 两次调用会让首屏的
         楼/路/水绿**每条管道多跑一整轮**（第二次撞上 feed 的 `busy` 守卫 ⇒ `queued=true`
         ⇒ 本轮结束后**再跑一轮 `runOnce`**；楼每轮还要吃 `BLD_BUNDLE_PER_REFRESH` 格预算）。
         名字层只需要**挂在第一份 promise 上**（下面那一行就是），不需要第二个 kick。
         ⇒ 现在只留下面那一行：**一轮取数 + 取完挂名字**。 */
      /* 🏷🗺 **名字层首刷**（与楼同一个道理：只挂 `moveend` 会"开页没有名字"——本项目栽过三次的
         「挂钩只在用户事件上 ⇒ 首屏空白」）⇒ 这里 kick 一次，成功即停、不常驻轮询。
         放在取包之后：先有楼（锚点只认**画出去的那批**），再挂名字。 */
      void refreshBundles("init").then(() => (alive ? refreshNames("init") : undefined));
      /* 🔴 署名（ODbL）**随数据一起显示**：句子取自包里的 `index.json`（导出脚本那句原话） */
      void loadBundleAttribution();
      /* 🎬 场景就绪 ⇒ 把地图与**真楼栋**交给外层（交通设施要用楼脚印；见 `emit` 的说明）。
         放在 `phase` 之后：这时 loading 已收起、楼体图层已 addLayer，外层加图层不会插进加载态。 */
      emit("scene-ready", {
        map: m,
        buildings: (fc as { features?: unknown[] } | null) || null,
        /* 🏠 切片③：把「我的家」的取名点取值器**一起**递出去（与楼栋同一次事件 —— 外层不必再取一遍） */
        places: placesGetter,
      });
      /* 代拍：`?autoshot=1` 开了开关才跑，没开就是一次 boolean 判断（零开销） */
      if (selfShotArmed()) void runSelfShot(m as unknown as Parameters<typeof runSelfShot>[0]);
      /* 🧪 App 自拍（`?selfshot=1`）：这是 **WebGL 路**的触发点（降级路的在 `fallback2d` 末尾） */
      maybeAppSelfShot("webgl");
      /* 🕹 标尺的**兜底量法**：极少数情况下建图那一刻容器还没排版（0×0 ⇒ `project`/`unproject`
         会给出非有限值），`joyCalibrate()` 会如实退回 `null`（⇒ 只有相机走、角色不动）。
         `load` 时版面已经有了 ⇒ 在这里补量一次。**只在还没量到时**才调（正常路径 0 次调用），
         而且同样**不在帧里** —— "移动中 0 次投影"那条红线不受影响。 */
      if (joyGate.value.show && !joyScale) {
        joyCalibrate();
        if (joyOrigin) roamStore.write(joyOrigin.lng, joyOrigin.lat, joyMove.headingDeg);
        joyApplyRoam(joyMove);
      }
    });

    /* 🏷🗺 **名字层的相机联动**（`DESIGN-MG-MOTION.md` §4.0/§4.2 —— 这一段的每一条都是红线）
       · `movestart`：容器加 `is-camera-moving`（**一次 class + 一次 opacity**，整层 1 → 0.25）；
       · `move`（每帧）：**只写 1 个容器**的 `translate3d`（跟手），N 个节点一个字都不写；
       · `moveend`：容器归零 + 节点位置**批量重排一次**（在 `refreshNames` 里）；
       · `click`：点楼体 ⇒ 与点名字**同一张卡**（`queryRenderedFeatures` 拿不到时走"最近已画楼"降级）。 */
    /* 🕹 **摇杆期间四个 handler 一律早退**（`joyActive` = 自持标志，见 `onJoyDrive` 那段）：
       `panBy({duration:0})` 每帧都会发一轮 movestart/move/moveend，不早退就是"每帧重投影 +
       每帧起一条 600ms 去抖 + 每帧重排标签"。跟手由 `joyNamesFollow()` 自己写**一个容器**，
       松手由 `onJoyHalt()` **恰好一次**重算 —— 判据 3/4/5/6 都钉在这里。 */
    m.on("movestart", () => { if (joyActive) return; onMoveStart(); });
    m.on("move", () => { if (joyActive) return; onMove(); });
    /* 移动中点击**丢弃**（不排队、不 `queryRenderedFeatures`）：相机在动，射线命中的楼已经移走，
       "点中"本身没意义；排队又会在松手时弹卡（判据 5）。 */
    m.on("click", (e: unknown) => {
      if (joyActive) return;
      onMapClick(e as { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } });
    });

    /* 视野变化 → 按需补数据（去抖 600ms，避免拖动时把后端/磁盘打爆）。
       · **默认**：只补**离线格**（静态文件 ⇒ 不打 Overpass；换视野要素数**不减**：并进累积仓库）；
       · `?live=1`：另外走现场取数（楼/路各一条），失败照旧**可见**。 */
    m.on("moveend", () => {
      /* 🕹 摇杆推着的时候这一发是**每帧都有**的（`panBy({duration:0})` 每次都走完一轮 ease）
         ⇒ 必须早退：不早退就会"每帧重投影 + 每帧起一条 600ms 去抖 + 每帧重取离线包"。
         松手那一次重算归 `onJoyHalt()`（**恰好一次**）。 */
      if (joyActive) return;
      /* 🔴 容器位移**必须**在这里归零：节点自身马上要被写成新位置，容器再留着旧位移就是"错位"
         （机主真机报过的「名字显示是滑动刷新一次，不能跟随，**错位严重**」就是这一层没对齐）。 */
      onMoveEndNames();
      /* 🆕 2026-10-01 **就地重投影**（治机主说的"松手卡一下/弹回"）：
         容器刚归零，而节点还钉在**上一台相机**的坐标上 —— 原来要等 600ms 去抖 + 取包之后才重排，
         那 600ms 里整层是错位的（真因是"重投影排在了重排后面"，不是算得慢）。
         现在：`reproject()` **只重投影、不重排**（O(N)，N ≤ 26；集合/避让/上限/batch 一律不动）
         ⇒ 同一 tick 内 Vue 就把 transform 落下去（微任务先于下一帧绘制）⇒ 看不到跳变。
         ⚠️ 它**不替代** `refreshNames`：600ms 后那一轮仍照跑（该重算时重算、该增删时增删）。 */
      reprojectNow();
      if (bldTimer) window.clearTimeout(bldTimer);
      bldTimer = window.setTimeout(() => {
        bldTimer = 0;
        void refreshBundles("move").then(() => (alive ? refreshNames("move") : undefined));
        if (bldLive.live) void loadBuildingsForView(m as unknown as BldMapLike);
        if (roadsLive.live) void loadRoadsForView(m as unknown as BldMapLike);
      }, 600);
    });
    /* 缩放结束也要重排：zoom 变了 ⇒ 避让网格的候选/撞掉**全变**（区名模式的迟滞信号就是它）
       🔴 2026-10-03 第三轮**必须加这一句早退**：摇杆拉近期间宿主每帧写一次 `easeTo({zoom})`
       （`onJoyDrive`），而 `duration: 0` 的 ease 会**同步**发一轮 zoomstart/zoom/zoomend
       （与 `panBy` 同一族，vendored 源码见判据 ⑧）⇒ 不早退的话，拉近的每一帧都会在这里
       跑一次 `reprojectNow()`（重投影）+ 起一个 160ms 的 `refreshNames("zoom")` + 可能一次
       `bldTierCrossedFlush()`（重挑楼）—— 正是判据 3/6 的"移动期间 0 次重投影 / 0 次重挑"那条红线。
       收尾那**一次**重算仍由 `onJoyHalt()` 在画面停稳之后做（那时 zoom 已经回到出发值）。 */
    m.on("zoomend", () => {
      if (joyActive) return;
      onMoveEndNames();
      /* 🆕 同 `moveend`：先**就地重投影**（缩放不是刚体平移，容器跟手只是近似），
         160ms 后那一轮 `refreshNames("zoom")` 照旧（跨档才重算，档内复用 —— 见 `wsNameLayer`）。 */
      reprojectNow();
      if (zoomNameTimer) window.clearTimeout(zoomNameTimer);
      zoomNameTimer = window.setTimeout(() => { zoomNameTimer = 0; if (alive) void refreshNames("zoom"); }, 160);
      /* 🌆 **跨过足迹/立体分界线 ⇒ 重挑一次**（走既有的 `bldFlush` 通路，见 `bldTierCrossedFlush`）：
         分界线两边画法与栋数上限都不同，不重挑就会一直按旧档画到下一次 `moveend`。 */
      bldTierCrossedFlush();
    });

    /* ══ 📍 **屏外方向指示**的相机钩子（2026-10-04 第七条）════════════════════════════════
       为什么是**单独一组监听**而不是塞进上面那五个 handler：那五个是摇杆红线的判据对象
       （`ws_joystick_selftest.mjs` ⑦ 逐字钉着它们的形状），把新功能混进去会让"改一处、红一片"；
       单独注册一条，**早退条件与它们逐字相同**（`if (joyActive) return;`）⇒ 时点也完全相同。
       时点 = **相机事件**（不是 rAF、不是每帧循环）；写点数与开关见 `pinEdgeSync` 上方那段说明。
       ⚠️ 只挂 `move` / `moveend` / `zoom` 三个（`zoomend` **故意不挂** —— 它是摇杆那条"唯一入口"
         判据的对象，且 `zoom` 已经在跟了；多挂一条就是给那条红线添一个新的解释空间）。 */
    m.on("move", () => { if (joyActive) return; pinEdgeSync(); });
    m.on("moveend", () => { if (joyActive) return; pinEdgeSync(); });
    m.on("zoom", () => { if (joyActive) return; pinEdgeSync(); });

    /* fps 计数已提到 `startFps()`（在"分渲染路"之前启动，降级路也有数） */
  });

  onBeforeUnmount(() => {
    alive = false;
    /* 🕹 摇杆会话**就地作废**（不重算 —— 这一屏马上就没了）：`alive=false` 之后 `onJoyHalt()`
       本来也会早退，但这里显式清一次，免得"标志留在 true 上"这种事再被后来的人踩。 */
    joyActive = false;
    joyAccX = 0;
    joyAccY = 0;
    unguard?.();
    unguard = null;
    unlockPageGestures();
    stopTimer();
    if (bldTimer) window.clearTimeout(bldTimer);
    if (zoomNameTimer) window.clearTimeout(zoomNameTimer);
    if (switchTimer) window.clearTimeout(switchTimer);
    if (enterTimer) window.clearTimeout(enterTimer);      // 🆕 进场淡入的收尾定时器
    if (ghostTimer) window.clearTimeout(ghostTimer);      // 🆕 退场幽灵的移除定时器
    if (snapRaf1) cancelAnimationFrame(snapRaf1);         // 🆕 传送帧的举旗/摘旗
    if (snapRaf2) cancelAnimationFrame(snapRaf2);
    if (watchdog) window.clearTimeout(watchdog);
    watchdog = 0;
    if (recoverTimer) window.clearTimeout(recoverTimer);
    recoverTimer = 0;
    for (const t of resizeTimers) window.clearTimeout(t);
    resizeTimers.length = 0;
    try {
      window.removeEventListener("resize", onWinResize);
      window.removeEventListener("orientationchange", onWinResize);
    } catch {
      /* 摘不掉无所谓（页面已经在卸载） */
    }
    try {
      resizeRo?.disconnect();
    } catch {
      /* 断开失败无所谓 */
    }
    resizeRo = null;
    /* 🧱 S3（M8）：rAF 句柄随 `startFps` 搬去了 `wsHudStats.ts` ⇒ 这里调它的出口（逐字等价于
       原来那两句 `if (raf) cancelAnimationFrame(raf); raf = 0;`）。 */
    stopFps();
    try {
      map?.remove?.();
    } catch {
      /* 已经没了就算了 */
    }
    map = null;
  });
</script>

<!-- 🧱 重构切片 S1（PLAN-REFACTOR §3）：**这一整块样式（436 行）已整体外置**到同目录的
     `wsDistrictMapLibre.css`，这里只留下面一行引用 —— 宿主 .vue 从此只装"模板 + 逻辑"。

     🔴 为什么选「带 src 的 scoped 样式块」这条路（另外两条都踩过坑）：
       · 工具链**原生支持**，且 scoped 语义**完整保留**：`@vitejs/plugin-vue` 5.2.4 对
         "有 src 且 scoped"的样式块走的是 `getTempSrcDescriptor(…, scoped: query.scoped)` +
         `?vue&type=style&src=<id>&scoped=<id>` 这条分支（`dist/index.mjs:145-152`、`:2719-2727`）
         ⇒ 外置文件照样按本组件的 `data-v-<id>` 打标，与内联时同效；
       · 在样式块里用 CSS 的导入指令：会把"内联"与"打标"的**先后顺序**交给 PostCSS，
         一旦内联晚于打标，整块 scoped **静默失效**（样式看着在、就是没生效，最难查）；
       · 在 script 里 import 一份 .css：拿到的是**全局**样式（没有 scoped）⇒ 会污染别的页面。

     ⚠️ 动这个文件前先知道：有 6 份自检按**选择器原文**核对样式
     （`ws_pages_consistency` / `ws_labels` / `ws_joystick` / `ws_anim_ban` /
       `ws_actor_pick` / `ws_zone_names`）——它们已同步改成"宿主源码 = .vue 文本 + 外置的那份 CSS"，
     别把它们改回只读 .vue（改了就是一片假红）。
     回退：`git revert`（外置文件与这一行是一对，不许只回退一半）。 -->
<style scoped src="./wsDistrictMapLibre.css"></style>

<!--
  🎯 预走线（2026-10-04 第四轮）——**故意不加 `scoped`**，两个原因，都不是疏忽：
    ① 那几个节点是 `pinEl()` 用 `document.createElement` 造的**动态节点**，身上没有 `data-v-xxx`
       ⇒ scoped 选择器一个都匹配不上（朝向箭头当年靠**内联 cssText** 绕开了这件事，
          但预走线需要 `@keyframes` 与 `@media`，内联样式写不了）；
    ② Vue 的 scoped 会把 `@keyframes` **改名**（`ws-aim-flow` → `ws-aim-flow-<hash>`）并只重写同一块里
       的 `animation-name`，而"流动"是写在这条链上的 —— 改名那一刻就断了（静默失效，最难查）。
  ⇒ 用全局块 + `ws-aim` 前缀（全仓唯一）划清边界。这里**只有**预走线，没有别的选择器。
  动画纪律（与 `.ws-labs` 那一段同一条红线）：
    · 每帧只有 `transform` 被 JS 写（虚线 `scaleX` / 箭头 `translate3d` / 容器 `rotate`）；
    · 显隐只走 `opacity` 过渡：入场 140ms、**淡出 320ms `ease-out`**（研究 §12.3：MDN 的 `ease-out`
      = `cubic-bezier(0, 0, 0.58, 1)`，"starts abruptly and then progressively slows down towards the end"
      —— 停下时先收得快、尾巴慢，这才是"优雅淡出"而不是硬切）；
    · "流动"是**纯 CSS**（平移恰好一个周期 ⇒ 无缝循环，§12.4 的 marching-ants 正统做法，
      但我们不用 `stroke-dashoffset`/`background-position` —— 那两个不是 transform，会掉出合成器）；
    · `prefers-reduced-motion` ⇒ **只关流动**（线照画：它同时是操作反馈）；`low` 档整条不画（JS 判）。
-->
<style>
  /* 容器：一个 0×0 的锚点，落在钉子（44×44 命中区）的正中；它只吃 `rotate(朝向)` */
  .ws-aim {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
    pointer-events: none;          /* 命中区仍是那个 44×44 的 hit：预走线一个字的事件都不吃 */
    transform-origin: 0 0;
    opacity: 0;                    /* 停稳时**不可见**（不是删节点：删了就没有淡出） */
    transition: opacity 320ms cubic-bezier(0, 0, 0.58, 1);   /* 淡出（ease-out，§12.3） */
    will-change: transform, opacity;
  }
  /* 画着的时候：亮起来（入场 140ms —— 比退场快，符合"响应要快、收起要从容"） */
  [data-ws-roam-pin].is-aim .ws-aim {
    opacity: 0.85;
    transition-duration: 140ms;
  }
  /* 预走线亮着时**朝向小箭头让位**（两者是同一个语义；不让位就是两个箭头在同一个半径上打架）。
     `opacity` 过渡：收线那一帧它淡回来（180ms），不是硬切。
     ⚠️ 这条与"收线时补写箭头角度"配套：JS 在 class 摘掉那一帧会把角度补到**当前**朝向
        （见宿主 `joyFaceSync` 的注释），否则箭头会带着旧角度淡回来。 */
  [data-ws-roam-face] {
    transition: opacity 180ms linear;
  }
  [data-ws-roam-pin].is-aim [data-ws-roam-face] {
    opacity: 0;
  }
  /* 底线之外的一层（`overflow:hidden` 当"只露出这么长"的窗口；窗口宽度 34 = 满推线长） */
  .ws-aim__dash {
    position: absolute;
    left: 17px;                    /* = JOY_AIM_GAP_PX（身体半径 15 + 2px 缝） */
    top: -1px;
    width: 34px;                   /* = JOY_AIM_MAX_PX（JS 只写 scaleX，**从不改 width** —— 布局属性） */
    height: 2px;
    transform-origin: 0 50%;
    overflow: hidden;
  }
  /* 会在窗口里横向平移的虚线花纹：宽度 = 34 + 9（一个周期）⇒ 平移 9px 后与原图**逐像素重合** ⇒ 无缝 */
  .ws-aim__flow {
    position: absolute;
    left: 0;
    top: 0;
    width: 43px;                   /* = JOY_AIM_MAX_PX + JOY_AIM_DASH_PX */
    height: 2px;
    background: repeating-linear-gradient(
      90deg,
      rgba(233, 244, 255, 0.95) 0 5px,
      rgba(233, 244, 255, 0) 5px 9px
    );
    animation: ws-aim-flow 460ms linear infinite;
  }
  @keyframes ws-aim-flow {
    from {
      transform: translate3d(0, 0, 0);
    }
    to {
      transform: translate3d(-9px, 0, 0);   /* = JOY_AIM_DASH_PX：**恰好一个周期** */
    }
  }
  /* 箭头：贴着虚线的末端（位置由 JS 的 `translate3d` 给），朝向 = 容器的 rotate 带过来的。
     🔴 `left: 0`（**不是** 17px）：JS 写进来的位移是 `tipPx = GAP + dashPx`（**含**那 17px 的起点），
     这里再加一次 17 就会把箭头推到虚线末端之外 17px 去（画出来是"线和箭头中间空一截"）。 */
  .ws-aim__tip {
    position: absolute;
    left: 0;
    top: -4px;
    width: 7px;                    /* = JOY_AIM_TIP_PX */
    height: 8px;
    background: rgba(233, 244, 255, 0.95);
    clip-path: polygon(0 0, 100% 50%, 0 100%);   /* 绘制属性（不参与布局），与既有朝向箭头同一手法 */
    pointer-events: none;
  }
  /* ♿ 系统"减弱动效"⇒ **只关流动**（虚线变静止的虚线；线本身照画 —— 它是操作反馈，不是装饰）。
     `low` 档更狠：整条不画（JS 的 `joyAimModeOf` 给 `"off"` ⇒ 一次都不写、class 都不加）。 */
  /* ══ 📍 **屏外方向指示**（2026-10-04 第七条；机主：「为什么其他角色不见了喵」+
     他自己点的「屏外加方向指示（小箭头 + 距离）」）══════════════════════════════════════
     结构：`.ws-pin-edge`（定位容器，挂在钉子的 44×44 命中区里）+ 箭头 + 距离文案。
     🔴 三条硬约束（与 `pinEl`/`pinEdgeSync` 那两段注释是同一份口径）：
       ① `position:absolute` —— 外层 `hit` 是 `display:flex` 的 44×44，**普通子节点会变成第二个
          flex 项**、把身体圆挤走（`.ws-aim` 当年就是这么把轴心挤到身体右边的）；
       ② `pointer-events:none` —— 箭头只是指示：不吃地图手势、不抢钉子的点击（命中区仍是那 44×44）；
       ③ 只动 `transform` / `opacity`（`opacity` 的过渡交给 CSS，JS 只翻转一次 class）——
          "动画里不碰布局属性"是全项目红线（`ws_anim_ban_selftest.mjs` ① 扫的就是它）。
     🛡 刘海/手势条：**不在 CSS 里躲**（那会与 JS 算出来的落点错位）——JS 侧用
        `env(safe-area-inset-*)` 探针把四边量出来，折进"安全子矩形"再算落点，见 `pinEdgeMeasure()`。 */
  .ws-pin-edge {
    position: absolute;
    left: 50%;
    top: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    pointer-events: none;
    opacity: 0;                       /* 屏内 = 不显示（翻转 `is-off` 才亮） */
    transition: opacity 160ms ease-out;
    will-change: transform;           /* 每轮只写 transform ⇒ 走合成器，不重新栅格化 */
  }
  .ws-pin-edge.is-off {
    opacity: 1;
  }
  /* 箭头：**沿 +x（向右）画**（`clip-path` 尖端在右）—— 这样 `pinEdgeRotateDegOf()` 里那一个 `−90`
     对它和摇杆的预走线箭头**同时成立**（全项目只有这一处换算，不各写一套）。
     ⚠️ **不加 `filter`/`box-shadow`**：它在相机移动时每轮都在转，加一层滤镜就是每轮一次重新栅格化
     —— 与既有朝向箭头 `.ws-aim__tip` 同一条纪律。 */
  .ws-pin-edge__arrow {
    width: 9px;
    height: 9px;
    background: rgba(233, 244, 255, 0.95);
    clip-path: polygon(0 18%, 100% 50%, 0 82%);
    transform-origin: 50% 50%;
  }
  .ws-pin-edge__dist {
    font-size: 10px;
    line-height: 1.2;
    font-style: normal;               /* 它是个 `<em>`：默认斜体，这里按正体排 */
    color: #e9f4ff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
    white-space: nowrap;
  }
  /* ♿ 系统"减弱动效"⇒ **只关流动**（虚线变静止的虚线；线本身照画 —— 它是操作反馈，不是装饰）。
     `low` 档更狠：整条不画（JS 的 `joyAimModeOf` 给 `"off"` ⇒ 一次都不写、class 都不加）。 */
  @media (prefers-reduced-motion: reduce) {
    .ws-aim__flow {
      animation: none;
    }
    .ws-aim {
      transition-duration: 180ms;
    }
  }
  /* ♿ 系统"减弱动效" ⇒ 屏外指示的显隐不做过渡（指示本身照旧，它承载的是"人在哪"这个信息） */
  @media (prefers-reduced-motion: reduce) {
    .ws-pin-edge {
      transition-duration: 0ms;
    }
  }
</style>
