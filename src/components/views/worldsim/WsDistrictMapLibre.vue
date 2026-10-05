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
  /* 🧱 重构切片 S6（M3）：**挑楼流水线 / 落地**整块搬到了 `wsBldLanding.ts`（`PLAN-REFACTOR.md`
     §2.1 / §2.2 / §3 的 S6 行）。搬走的是：`LIVE_ON` / `bldLive` / `roadsLive` / `viewHalf` /
     `liveRadiusFor` / `bldStore` / `roadsStore` / `placesStore` / `bundleView` / `bldPickStore` /
     `bldShapeTierName` / `bldPickLine` / `bldCellDegNow` / `bldFlush`（连同它自己那几份会话状态与
     `watch(bldDrawMode)`）/ `bldTierCrossedFlush` / `roadsFlush` / `bldFeed` / `roadsFeed` /
     `placesFeed` / `placesFlush` / `placesGetter` / `gwLayer`。
     ⚠️ 上面 S4 那段注释里"留在宿主"的名单是**那一片当时的账**：`LIVE_ON` / `bldLive` / `roadsLive` /
        `liveRadiusFor` / `bldStore` / `roadsStore` / `bldFlush` / `roadsFlush` 在本片**已经搬进 M3**
        ⇒ 宿主改从 `createBldLanding({…})` 的返回值上取（解构名与原闭包变量同名 ⇒ 下面所有调用点
        一个字都没改，也仍然是同一个函数）。
     ⚠️ **仍然留在宿主**的：`fetchCell`（M3/M4/M8 三处共用）、`stats` / `renderKind` / `theme` /
        `themeTier` / `dressBld` / `draw2d`、`roadSegs` / `drawnBld`（M3 只写、宿主持有真源）、
        `artTheme`（唯一消费点在装配点**之前**，搬进去就成环 —— 理由写在 `wsBldLanding.ts` 文件头）。
     ⚠️ 本片因此空出来的 import（`bldLiveDecision` / `roadsLiveDecision` / `viewHalfMetersOf` /
        `fetchRadiusForView` / `createFeatureStore` / `createBundleFeed` / `createGwLayer` /
        `createBldPickStore` / `bldCapForCellDeg` / `bldMaxDrawnOf` / `bldPxPerMeter` /
        `bldMetersPerCssPixel` / `bldTierOfZoom` / `WS_BLD_MODE_MANY` / `useWsBldMode` /
        `visibleRoadCount` / `roadSegments` 与那些 cap 常量/类型）按 §3 第 5 条**一行都不删**，
        清理归 S9（与 S2 的 `drawContours`、S4 的 `withTimeout` 同一口径）。 */
  import { createBldLanding } from "./wsBldLanding";
  /* 🧱 重构切片 S7（M7）：**交互命中**（钉子 / 吸附 / 锚点 / AI 示意层 / 信息卡点选）
     整块搬到了 `wsPickInteract.ts`（装配点在 `panel` 之后那一处，理由在模块文件头）。
     ⚠️ 宿主里**空出来的 import**（`useWsPanel` 等）按 §3 第 5 条一行都不删，清理归 S9。 */
  import { createPickInteract } from "./wsPickInteract";
  /* 🧱 重构切片 S7（M9）：**引擎自愈 / 验证 / 自拍**（看门狗、画布事实与 resize 自证、WebGL 回切、
     代拍 / App 自拍、验证快照与面板）整块搬到了 `wsEngineGuard.ts`（装配点在 M7 那一处之后，
     理由在模块文件头）。⚠️ 宿主里空出来的 import 不删，清理归 S9。 */
  import { createEngineGuard } from "./wsEngineGuard";
  /* 🧱 重构切片 S11：**地图事件接线**（`onMounted` 里那 13 处 `m.on(...)` 与它们的回调体）
     整块搬到了 `wsStageEvents.ts`（装配点在 `onMounted` 里 `map = m;` 之后 —— ctx 要按值收五个
     `onMounted` 局部量；注册点与顺序**逐字留在原地**，理由在模块文件头）。
     ⚠️ 宿主里空出来的 import 按 §3 第 5 条一行都不删，清理归 S9。 */
  import { createStageEvents } from "./wsStageEvents";
  /* 🧱 重构切片 S13：**屏外角色箭头**那一族（量容器几何 + 安全区探针 / 躲三块禁区 /
     每颗钉子算一次屏幕点 / 只在变了才写 DOM）整块搬到了 `wsPinEdgeStage.ts`
     （装配点在 `roadLayerSpecsForMap` 之后 —— ctx 要按值收 `host` 与 `pins`，理由写在那一段）。
     ⚠️ 纯函数 `wsPinEdge.ts` 仍是算术的**唯一真源**（新模块只 import，不抄第二份）；
     宿主里因此空出来的 import 按 §3 第 5 条**一行都不删**，清理归 S9。 */
  import { createPinEdgeStage } from "./wsPinEdgeStage";
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
    /* 🧱 S5（M4）：`LABEL_MOTION` / `NameMapLike` / `NameRenderPlan` / `createNameLayer` /
       `nameVerdictLine` 跟着"名字层落 DOM 那一族"搬去了 `wsNameHost.ts`（真源仍是本模块）——
       宿主这边只剩 `labRootClass` 要的 `LABEL_CAMERA_CLASS` 与签名要的 `NameRenderNode`。 */
    LABEL_CAMERA_CLASS,
    type NameRenderNode,
  } from "./wsNameLayer";
  /* 🧱 S5（M4）：名字层**落 DOM 的那一整族**（`namesOn` / `nameLayer` / `namePlan` / `nameNodes` /
     `switching` / `labRootEl` / 进场退场 / `reprojectNow` / `refreshNames` / `perfLow`）搬进了
     `wsNameHost.ts` —— 宿主只接线，装配点在本文件那一处（见 `createNameHost` 的说明）。
     S5（M5）：摇杆近景那整条会话搬进了 `wsJoystickStage.ts`（装配点同样只有一处）。
     🔴 两个模块都**不 import 宿主**；模块之间也**没有**横向 import —— 共享量全由宿主注入（§2.2）。 */
  import { createNameHost } from "./wsNameHost";
  import { createJoystickStage } from "./wsJoystickStage";
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
       随摇杆几何（`joyVars` 那一段）搬去了 `wsMapCamera.ts`（真源仍是 `wsJoystick.ts`）。
       🧱 S5（M5）：**摇杆近景那整条会话**（几何换算 / 运动模型 / 预走线 / 相机真值那一族：
       `JOY_PITCH_DEG` / `JOY_STEP_PX` / `JOY_ZOOM_PUSH_LEVELS` / `createJoyMotion` / `joyAimModeOf` /
       `joyAimRotateDegOf` / `joyAimStep` / `joyBearingNowOf` / `joyCamRestoreArgs` / `joyCamSnapshotOf` /
       `joyDepthGainOf` / `joyFlushDue` / `joyLngLatOf` / `joyNamesHiddenOf` / `joyPanScaleOf` /
       `joyPxScaleOf` / `joyScreenHeadingOf` / `joyScreenOf` / `joySetBearingNow` / `joySetCam` /
       `joySetFrame` / `joySpeedMpsOf` / `joyWalkAnimOn`）整块搬去了 `wsJoystickStage.ts`
       （真源仍是 `wsJoystick.ts`）。宿主这边只剩这四样：
         · `JOY_SPEED_MPS` —— `joySpeedMps` 那个 ref 的初值（模板 `:speed-mps` 吃它，所有权留宿主）；
         · `ROAM_PIN_ID`   —— 建钉子/`syncPins` 那条路（宿主的钉子名单）；
         · `joyHomeBoxesOf` —— 屏外指示与三块禁区的几何（宿主的 `pinEdgeSync`）；
         · `roamStore`     —— 建图那段要把「我」摆到原点。 */
    JOY_SPEED_MPS,
    ROAM_PIN_ID,
    joyHomeBoxesOf,
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
  /** 临时类的"后台等它出帧"计时器（卸载要清） */
  let recoverTimer = 0;
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
  /* 🧱 S5（M4）：`let switchTimer`（换批"先隐后改字"那个去抖）跟着 `applyNamePlanWithHud`
     搬去了 `wsNameHost.ts` —— 它只有那一个消费者，宿主不再留副本（卸载收尾走 `cancelMotion()`）。 */
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

  /* ══ 🧱 重构切片 S13：**屏外角色箭头**那一族的装配 ═══════════════════════════════════
     实现整块在 `wsPinEdgeStage.ts`（锚点 = 函数名，不按行号；机制的逐条注释在那边）。
     为什么装配点就在这儿：它要 `host`（:733 的 ref）与 `pins`（:1004 的 `let`），两者在上面都已声明；
     本工厂**只定义函数、装配那一刻一次都不调** ⇒ `map` 此刻是不是 null 与本处无关
     （`mapNow()` 是取值器，真调用发生在建图之后）。
     ⚠️ 宿主那面 `pins` / `map` 是 `let`（新增/移除钉子、建图/销毁都会重写）⇒ 一律给**取值器**，
     真源仍只有宿主那一份（与 S6 的 `setRoadSegs` / S7 的取值器同一条落法）。
     🔴 `pinEdgeMeasure` / `pinEdgeSync` 现在是 **M7 / M9 / M11 / M5 的 ctx 的一部分** ——
     下面解构出来的就是**同一个函数**（本模块是唯一实现，没有第二份），再往下传给它们。 */
  const pinEdgeStage = createPinEdgeStage({
    host,
    pinsNow: () => pins,
    mapNow: () => map,
  });
  /* 解构名与原闭包变量**同名** ⇒ 宿主里所有调用点（`syncPins` 末尾 / resize 自证 / 四个下游 ctx）
     一个字都没改。 */
  const { pinEdgeInsetsOf, pinEdgeMeasure, pinEdgeAvoid, pinEdgeSync, pinEdgeMetersOf } = pinEdgeStage;

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
    /* 🧱 S7（M9）：这三个出口搬进了 `wsEngineGuard.ts`，而 M6 的装配点在它**之前**
       （本片要 `fallback2d` / `ALLOW_2D`）⇒ 宿主这一侧用**惰性转发**断环：
       箭头只在 `fallback2d` 真正被调时求值（那时 M9 早已装配完）⇒ 与原来同一个函数、同一个时刻，
       值没变、时序没变；M6 的模块体一个字都没改。`isAutomation` 仍留在宿主（函数声明）⇒ 原样。 */
    dprCap2d: () => dprCap2d(),
    stopTimer,
    startRecoverPoll: () => startRecoverPoll(),
    maybeAppSelfShot: (kind: "webgl" | "fallback2d", why?: string) => maybeAppSelfShot(kind, why),
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

  /* ══ 🧱 重构切片 S6（M3）：**挑楼流水线 / 落地**的装配 ══════════════════════════════════
     实现整块在 `wsBldLanding.ts`（锚点 = 函数名/标识符，不按行号）。装配点为什么在这儿：
       ① 它要 `stats` / `fetchCell` / `renderKind` / `theme` / `themeTier` / `dressBld` / `draw2d`
          —— 全是 `const`（后两个由上面那次 `createFallback2d` 给回来）⇒ 早引必踩 TDZ
          （本文件对 TDZ 有过前科，不靠"函数是惰性的"兜）；
       ② 而下游三处只能从**这里**取：M8 后半（`createBundleHud`）要 `bldFeed` / `roadsFeed` /
          `placesFeed` / `gwLayer`，M2（`createViewFetch`）要 `bldLive` / `roadsLive` /
          `liveRadiusFor` / `bldStore` / `roadsStore` / `bldFlush` / `roadsFlush`，M5 要 `bldFlush`。
     ⚠️ `map`（`let`：建图时赋值、降级/卸载时置 null）与 `alive`（`let`：卸载时置 false）都走
        **取值器**：解构只会拿到快照，而 `alive` 一旦冻在入口，"卸载后别再落图"那条早退就失效了。
     ⚠️ `roadSegs` / `drawnBld` 是宿主自己的 `let`（吸附/寻路、名字层在读它），M3 只**写**它们
        ⇒ 这里给的是**写入器**（与 S5 的 `setJoyActive` / `setBldTimer` 同一条落法：宿主握真源）。
     ⚠️ `artTheme` **故意不进 ctx**：它的消费点在上面（`createFallback2d` 的 ctx），而 M3 又要那个
        工厂给回来的 `dressBld` / `draw2d` ⇒ 搬进去就是互相依赖成环（理由写在 `wsBldLanding.ts` 文件头）。 */
  const bldLanding = createBldLanding({
    stats,
    renderKind,
    theme,
    themeTier,
    fetchCell,
    dressBld,
    draw2d,
    scheduleBundleHud,
    roadLayerSpecsForMap,
    WS_ART_LEVEL,
    WS_BLD_MODE,
    WS_BLDN_PIN,
    WS_BLD_INVIEW,
    mapNow: () => map,
    aliveNow: () => alive,
    setRoadSegs: (v) => { roadSegs = v; },
    setDrawnBld: (v) => { drawnBld = v; },
  });
  /* 解构名与原闭包变量**同名** ⇒ 下面所有调用点一个字都没改（含模块侧经 ctx 的那几处）。 */
  const {
    LIVE_ON, bldLive, roadsLive, liveRadiusFor,
    bldStore, roadsStore, bldFlush, roadsFlush, bldTierCrossedFlush,
    bldFeed, roadsFeed, placesFeed, placesGetter, gwLayer,
  } = bldLanding;

  /* ══ 🏷🗺 名字层（真名标签 + 区名标签）═══════════════════════════════════════════════
     宿主只做四件事：**给它地图/取数/行政区名/画出去的楼**，拿回渲染计划后**照着写 DOM**。
     取数、避让、区名聚合、迟滞闸门、动效参数**一行都不在这里**（全在 `wsNameLayer`，PR 门禁 C1）。
     ⚠️ 跟手（§4.0）：相机运动期间**只写 1 个节点**（容器）——`translate3d` 由 `onMove` 写一次，
        节点自身的 `transform` 只在 `refreshNames()`（= moveend/load 之后）批量写一次。 */

  /** 上一轮 flush 真正**画出去**的楼（标签锚点必须落在"屏幕上那批"上，
   *  否则会出现机主报过的「有的压根没对应楼」——名字指到没画的楼）。 */
  let drawnBld: readonly unknown[] = [];
  /** 相机运动中（整层淡化：一次 class + 一次 opacity，**只写 1 个节点**）。
   *  ⚠️ 它**没跟着 M4 走**：M1（相机跟手三个 handler）与 M5（摇杆那一路）都在写它，
   *     而模板上的 `labRootClass` 也在读它 ⇒ 所有权留在宿主，两个模块经 ctx 拿同一个 ref。 */
  const cameraMoving = ref(false);

  /* ══ 🧱 重构切片 S5（M4）：**名字层落 DOM 的那一整族**的装配 ══════════════════════════════
     实现整块在 `wsNameHost.ts`（锚点 = 函数名，不按行号）。装配点为什么**必须在这儿**：
       ① `createNameLayer` 会**同步**调一次 `enabled()` ⇒ `namesOn` 必须先于它存在（TDZ 前科）；
       ② 它要 `stats` / `fetchCell` / `perf` / `renderKind` / `drawnBld`（全是 `const`/`let`）；
       ③ 而 M1（下一段 `createMapCamera`）要 `namesOn` / `nameNodes` / `cameraMoving` / `labRootEl`
          ⇒ 只能夹在中间。
     ⚠️ `drawnBld` 走**取值器**（`drawnBldNow`）：宿主 `afterDraw` 每轮重写它，解构只会拿到快照。
     ⚠️ `labRootClass`（模板那个 `:class`）**故意留在宿主**：它同时读 `cameraMoving` 与
        `joyZoomPulling`（摇杆那一路）—— 搬进 M4 就要把两个别的域的状态也拖进去。
     ⚠️ 只解构宿主真正还要用的：`applyNamePlan` / `applyNamePlanWithHud` / `fadeInNew` /
        `fadeOutGone` 搬走后在宿主**一个调用点都没有**（前两个本来就只有定义处）——
        删除按 §3 留给 S9（与 S2 的 `drawContours`、S3 的 `zoomBy` 同一口径）。 */
  const nameHost = createNameHost({
    stats,
    fetchCell,
    perf,
    renderKind,
    aliveNow: () => alive,
    mapNow: () => map,
    drawnBldNow: () => drawnBld,
  });
  const {
    nameLayer, namesOn, namePlan, nameNodes, switching, labRootEl,
    nameEnter, nameGhosts, ghostFading, snapping, perfLow,
    labClassOf, reprojectNow, refreshNames, cancelMotion,
  } = nameHost;
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

  /** 容器 class（相机运动 / 换批 / 整层降级 / 传送帧 / 🕹拉近隐藏）—— 类名来自真源常量，宿主不写字面量。
   *  ⚠️ 它**故意留在宿主**（理由见上面 M4 装配点那段）：`cameraMoving` 与 `joyZoomPulling` 分属两域，
   *     而它两个都要读 —— 搬进任何一边都要把另一边的状态拖过去。 */
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

  /* 🧱 S5（M4）：`applyNamePlan` / `applyNamePlanWithHud` / `fadeInNew` / `fadeOutGone` /
     `reprojectNow` / `refreshNames` 六个函数**整块搬进了 `wsNameHost.ts`** —— 上面那次
     `createNameHost` 把 `reprojectNow` / `refreshNames` 接了回来（**同一个**函数，不是第二份），
     所以本文件里那几个调用点（`moveend` / `zoomend` / `load` / 摇杆那一路）一个字都没改。
     ⚠️ 另外四个在宿主**一个调用点都没有**：`applyNamePlan` 本来就只有定义处（死代码，删除留 S9），
     `fadeInNew`/`fadeOutGone`/`applyNamePlanWithHud` 只有 M4 内部在调。 */

  /* ══ 🧱 重构切片 S7（M7）：**交互命中**（钉子 / 吸附 / 锚点 / AI 示意层 / 信息卡点选）的装配 ═══
     实现整块在 `wsPickInteract.ts`（锚点 = 函数名，不按行号；机制的逐条注释在那边）。
     为什么装配点在这儿：它要 `nameLayer` / `labRootEl`（上面 M4 那一处解构出来的 `const`，2825 行）
     与 `panel`（就在上一行）⇒ 早一处就是 TDZ。宿主那面 `map` / `mlMod` / `pins` / `roadSegs` /
     `drawnBld` 是 `let`（M5 的 ctx、`pinEdgeSync`、M3 的写入器都在用）⇒ 一律给**取值器/写入器**，
     真源仍只有宿主那一份（与 S6 的 `setRoadSegs` / `setDrawnBld` 同一条落法）。
     ⚠️ `domPins`（任务书把它列进 M7 了）**故意留在宿主**：M6 的装配点在它之后、
     而本工厂要等到 `nameLayer` / `panel` 才敢装配 ⇒ 搬进去就成环。理由写在 `wsPickInteract.ts` 文件头。 */
  const pickInteract = createPickInteract({
    props,
    stats,
    theme,
    aiOn,
    aiDrawn,
    aiBboxRef,
    bboxRef,
    emit,
    labRootEl,
    nameLayer,
    pinEdgeMeasure,
    pinEdgeSync,
    mapNow: () => map,
    mlModNow: () => mlMod,
    pinsNow: () => pins,
    setPins: (v) => { pins = v; },
    roadSegsNow: () => roadSegs,
    drawnBldNow: () => drawnBld,
  });
  /* 解构名与原闭包变量**同名** ⇒ 宿主里所有调用点（含模板与 M5 的 ctx）一个字都没改。 */
  const { cardData, cardOpen, closeCard, onMapClick, openCardFromNode, syncPins } = pickInteract;
  /* ══ 🧱 重构切片 S7（M9）：**引擎自愈 / 验证 / 自拍**的装配 ═══════════════════════════════
     实现整块在 `wsEngineGuard.ts`（锚点 = 函数名，不按行号；机制的逐条注释在那边）。
     为什么装配点在这儿：它要 `viewFetch`（面板快照念 M2 的读数）、`joyMeasureVh`（M1）、
     `bldFeed` / `roadsFeed` / `LIVE_ON`（M3/M8）与 `syncPins`（上一段 M7 的出口）—— 全在这之前；
     而 `fallback2d` / `ALLOW_2D`（M6）也在上面。宿主那面 `alive` / `map` / `sawRender` /
     `recoverTimer` / `resizeRo` 是活状态（事件与卸载都在用）⇒ 一律给取值器/写入器。
     ⚠️ `isAutomation` **留在宿主**（M6 装配那一刻就同步调它 ⇒ 搬进去会成环），按值递进来。 */
  const engineGuard = createEngineGuard({
    props,
    stats,
    theme,
    perf,
    cv,
    host,
    hudEl,
    phase,
    themeId,
    nightOn,
    nightLvl,
    renderKind,
    fallbackWhy,
    fallbackKind,
    mapErrs,
    ALLOW_2D,
    fallback2d,
    viewFetch,
    LIVE_ON,
    bldFeed,
    roadsFeed,
    mapAvailable,
    joyMeasureVh,
    pinEdgeMeasure,
    pinEdgeSync,
    syncPins,
    resizeTimers,
    isAutomation,
    aliveNow: () => alive,
    mapNow: () => map,
    setMap: (v) => { map = v; },
    /* ⚠️ 这个写入器**返回**写进去的那个引用：`kickResize` 里绑成块内 `const` 才能保住窄化
       （宿主那面是 `let`，只给取值器的话下面 `resizeRo.observe(...)` 会被判"可能为 null"）。 */
    setResizeRo: (v: ResizeObserver) => { resizeRo = v; return v; },
    recoverTimerNow: () => recoverTimer,
    setRecoverTimer: (v) => { recoverTimer = v; },
    sawRenderNow: () => sawRender,
  });
  /* 解构名与原闭包变量**同名** ⇒ 宿主里所有调用点（模板三个按钮、`onMounted`、`onBeforeUnmount`）
     一个字都没改。 */
  const {
    WATCHDOG_MS, watchdogFire, kickResize, onWinResize, forceResizeCanvas, retryMap, runSelfShot,
    maybeAppSelfShot, removeStrayCanvases, panelSnapshot, shootNow, dprCap2d, startRecoverPoll,
  } = engineGuard;

  /* ── 跟手（§4.0）：相机运动期间**只写容器**；节点位置一个字都不写 ─────────────────
     算法：`movestart` 时记下"第一个节点的锚点此刻在屏幕上的位置"，
     之后每帧算它现在在哪 ⇒ 差值就是整层的位移（地图平移 = 全体标签同位移，所以这是**精确**的）。
     ⚠️ 只在**平移**（pan）时这么做；旋转/俯仰不是平移，那时整层淡到 0.25 就够（§4.2）。
     🧱 S3（M1）：`panAnchor` 与这三个 handler（`onMoveStart` / `onMove` / `onMoveEndNames`）
     **整块搬进了 `wsMapCamera.ts`** —— 下面接回来的就是**同一个**函数（不是第二份），
     `m.on(...)` 那几个调用点因此一个字都没改。 */

  /* ══ 🕹 摇杆 → 相机（近景：**倾斜俯视的跟随**；机主裁决 2026-10-03）════════════════════════
     🧱 重构切片 S5（M5）：**整条摇杆会话**（`joyCalibrate` / `joyReportCam` / `joyReadBearing` /
        `joyReadCam` / `joyEnter` / `joyExit` / `joyApplyRoam` / `joyAimWrite` / `joyFaceSync` /
        `joyAimReset` / `joyPinReset` / `joyNamesFollow` / `onJoyDrive` / `joyFlushNow` /
        `onJoyHalt` 与它们那批会话状态）**整块搬进了 `wsJoystickStage.ts`**（锚点 = 函数名，
        不按行号；机制的逐条注释在那边），下面接回来的就是**同一个**东西（不是第二份）。
     ⚠️ **只有这面旗留在宿主**：`joyActive`（五个 `m.on(...)` 的早退与 `onBeforeUnmount` 都在读它
        —— 那是宿主自己的守卫）⇒ 模块每次经注入的取值器**现读**、要改就喊一声（与 S4 的 `alive` 同一条处理）。
     ⚠️ 两个 `watch`（`props.joy` 开合 / `joyGate.show` 卸载兜底）**也留在宿主**：它们是"接线"，
        调用的是接回来的同一个 `joyEnter` / `joyExit` ⇒ 那两处的文本一个字都没改。 */
  let joyActive = false;
  /** 本次按压累计的屏幕位移与"边走边补"那几个计数、接管前的相机快照、漫游位置真源、
   *  §13/§14 参考系、§16 视口倍率 —— **全是 M5 的会话状态**（见上面那段说明）。 */

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
  /* 🧱 S5（M5）：`joyReportCam` / `joyReadBearing` **搬进了 `wsJoystickStage.ts`** —— 上面那段
     说明留在宿主是因为它讲的是"宿主为什么必须让相机自己报真值"（含离线读数出处）。 */

  /* 🕹🆕 2026-10-03 第二轮（机主：「视角无法锁定角色，**位移很大**喵！！！」）—— **世界尺度**两个数，
     各只有一处来源，都由 `joyCalibrate()` 量一次后传给摇杆组件（它自己一行换算都不写）：
       · `joyMpp`      ：米/像素 —— 用本组件**既有那把唯一的尺子** `bldMetersPerCssPixel(zoom, lat)`
                        （与挑楼/楼高同一把，见本文件 `metersPerPixel` 那处调用）；**不新增第二份换算**。
                        ⚠️ 它不带俯角压缩（64° 时竖直方向的地面尺度差约 1/sin64° ≈ 11%）——
                          与世界速度的口径误差就这么多，写在这里免得下一个人以为是 bug。
       · `joySpeedMps` ：满推速度（**米/秒**）—— `joySpeedMpsOf(zoom)` 选档（步行/载具）。
                        🔴 上一版速度按"屏宽/秒"给 ⇒ 这一档的 1024px 屏上等于 **967 m/s**（瞬移）。
     量不到（没有 getZoom/getCenter）⇒ 两个数留 0 ⇒ 推杆无效：**宁可不走，也不编一个世界速度**。
     ⚠️ 这两个 ref **仍归宿主**（模板 `:mpp` / `:speed-mps` 直接吃它们；`joyCalibrate` 经注入写它们）。 */
  const joyMpp = ref(0);
  const joySpeedMps = ref(JOY_SPEED_MPS);
  /* 🕹🆕 2026-10-03 第三轮（机主拍板 Ⓐ「相机拉近」）—— **相机距离**四个值，各只有一处：
       · `joyZoomLevels`：交给摇杆组件的"推杆期间拉近几级" —— **量到了出发 zoom 才给**，
                          量不到给 0（这条通路整条关掉：宁可不拉，也不把相机 move 到 zoom 0）；
       · `joyZoomPulling`：名字层是否正在**整层隐藏**（研究 §9.6；状态翻转才写一次 class，不进每帧循环）。
     ⚠️ 另外两个（`joyZoom0` = 出发 zoom、`joyZoomApplied` = 已写进相机的拉近量）**只有摇杆那一族读**，
        跟着 S5（M5）搬进了 `wsJoystickStage.ts`；这两个 ref 留着是因为模板与 `labRootClass` 都要读它们。 */
  const joyZoomLevels = ref(0);
  const joyZoomPulling = ref(false);
  /** ♿ 系统"减弱动效"：**只关踏步**（摇杆是输入，任何档位都不许关；见 `joyWalkAnimOn`） */
  const joyReducedMotion = (() => {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  })();

  /* 🎯 2026-10-04 第四轮 **预走线**（机主："能给移动加预走线吗…动画要好看喵！"）—— 三个状态
     （`joyAimOn` / `joyAimK` / `joyFaceDeg`）**搬进了 `wsJoystickStage.ts`**：它们只有预走线那一族
     函数读写（`joyAimWrite` / `joyFaceSync` / `joyAimReset` / `joyApplyRoam`）。 */

  /* 🧱 S5（M5）：`joyCalibrate`（量两把尺子）/ `joyApplyRoam` / `joyAimWrite` / `joyFaceSync` /
     `joyAimReset` / `joyPinReset` / `joyReadCam` / `joyEnter` / `joyExit` **整块搬进了
     `wsJoystickStage.ts`**（上面那次 `createJoystickStage` 把 `joyCalibrate` / `joyApplyRoam` /
     `joyReadCam` / `joyEnter` / `joyExit` 接了回来 —— 同一个函数，不是第二份）。
     ⚠️ 机制与逐条注释（含"为什么 `joyCalibrate` 必须排在改完俯角之后""为什么退出要逐字还原相机"）
        都在那个文件里，别在这里另写一份。 */

  /* ══ 🧱 重构切片 S5（M5）：**摇杆近景那整条会话**的装配 ══════════════════════════════════
     实现整块在 `wsJoystickStage.ts`（锚点 = 函数名，不按行号）。装配点为什么在这儿：
       · 它要 `pins`（钉子名单）/ `perf` / `bldFlush` / `syncPins` / `pinEdgeSync`（宿主自己的）；
       · 要 `joyMpp` / `joySpeedMps` / `joyZoomLevels` / `joyZoomPulling` / `joyReducedMotion`
         （上面那几行刚声明完 —— 它们是模板与 `labRootClass` 的读者 ⇒ 所有权留在宿主）；
       · 要 M4 接回来的 `labRootEl` / `reprojectNow` / `refreshNames` 与 M8 接回来的 `refreshBundles`、
         M1 接回来的 `onMoveEndNames` ⇒ 必须晚于那三处装配（§2.2 规则①：同层不横向 import，
         共享量一律由宿主注入）。
     ⚠️ 四处**现读**（宿主那面是 `let`，布尔/数字没法按引用共享 —— 与 S4 的 `alive` 同一条处理）：
        `alive` / `map` / `joyActive` / `bldTimer` —— 模块侧逐处列在 `wsJoystickStage.ts` 文件头。
     ⚠️ 只解构宿主真正还要用的：`joyNamesFollow` / `joyFlushNow` 搬走后在宿主一个调用点都没有
        （前者只被 `onJoyDrive` 调、后者只被那个闸门调）—— 删除按 §3 留给 S9。 */
  const joyStage = createJoystickStage({
    cameraMoving,
    labRootEl,
    pins,
    syncPins,
    pinEdgeSync,
    bldFlush,
    refreshBundles,
    refreshNames,
    onMoveEndNames,
    reprojectNow,
    perf,
    joyMpp,
    joySpeedMps,
    joyZoomLevels,
    joyZoomPulling,
    joyReducedMotion,
    aliveNow: () => alive,
    mapNow: () => map,
    joyActiveNow: () => joyActive,
    setJoyActive: (v) => { joyActive = v; },
    bldTimerNow: () => bldTimer,
    setBldTimer: (v) => { bldTimer = v; },
  });
  const {
    joyCalibrate, joyApplyRoam, joyReadCam, joyEnter, joyExit,
    onJoyDrive, onJoyHalt,
    prevCamNow, setPrevCam, originNow, moveNow, scaleNow, resetAcc,
  } = joyStage;

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

  /* 🧱 S5（M5）：`joyNamesFollow`（名字层跟手，**只写 1 个容器**）与**帧里那一路** ——
     `onJoyDrive`（每帧至多一次的唯一驱动点）/ `joyFlushNow`（🕹🧱 受节流约束的"边走边补"）/
     `onJoyHalt`（收尾那**恰好一次**重算）—— **整块搬进了 `wsJoystickStage.ts`**。
     🔴 本轮机主点名的热区（摇杆补刷新 / `joyFlushDue` 节流 / 松手那一发按最终视野重挑楼）就在那三个
        函数里，搬的是**定义**、不是复制 ⇒ 全仓仍然只有一个实现（`ws_joystick_selftest` 的 ⑦/⑩/⑰ 组钉着）。
     ⚠️ 上面那次 `createJoystickStage` 把 `onJoyDrive` / `onJoyHalt` 接了回来 → 模板那两个回调
        （`@drive` / `@halt`）一个字都没改；`refreshBundles("joy")` / `refreshNames("joy")` 那几个
        调用点也照旧是宿主既有那批函数（经注入拿到的同一个）。 */

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
    /* ══ 🧱 重构切片 S11：**地图事件接线**的装配 ═════════════════════════════════════════
       13 处 `m.on(...)` 与回调体整块在 `wsStageEvents.ts`（按 8 组注册，事件名与顺序在那边列着）。
       装配点在这儿（不是 setup 作用域）的原因：ctx 要**按值**收上面那几个已经定稿的
       `onMounted` 局部量 —— `fc` / `seat` / `districtBbox` / `districtFeat` / `maplibregl`
       （改成取值器会丢掉 `if (fc?.features?.length)` 那处的 TS 窄化；理由在模块文件头）。
       🔴 注册点与顺序**逐字留在原地**：下面那 8 处调用逐个待在原来 `m.on` 的位置上 ——
       `m.once("style.load"/"load")` 的补层队列、`kickResize` 与看门狗都夹在它们中间，
       整串提前注册会让 `load` 上的监听次序变（那就不是"零行为变化"了）。
       宿主那面 `alive` / `joyActive` / `watchdog` / `sawRender` / `bldTimer` / `zoomNameTimer`
       是活状态 ⇒ 取值器/写入器（与 S5 的 `setBldTimer` / `setJoyActive` 同一条落法）。 */
    const stageEvents = createStageEvents({
      props,
      stats,
      phase,
      emit,
      mapErrs,
      fc,
      seat,
      districtBbox,
      districtFeat,
      maplibregl,
      initPitch,
      basePitch,
      joyGate,
      applyPitchGuard,
      onMoveStart,
      onMove,
      onMoveEndNames,
      onMapClick,
      reprojectNow,
      refreshNames,
      refreshBundles,
      stopTimer,
      syncPins,
      pinEdgeSync,
      pinEdgeMeasure,
      loadBuildingsForView,
      loadRoadsForView,
      loadFacilities,
      loadBundleAttribution,
      bldStore,
      bldFlush,
      bldTierCrossedFlush,
      bldLive,
      roadsLive,
      placesGetter,
      selfShotArmed,
      runSelfShot,
      maybeAppSelfShot,
      joyCalibrate,
      joyApplyRoam,
      joyReadCam,
      prevCamNow,
      setPrevCam,
      originNow,
      moveNow,
      scaleNow,
      roamStore,
      joyMeasureVh,
      aliveNow: () => alive,
      joyActiveNow: () => joyActive,
      setSawRender: (v) => { sawRender = v; },
      watchdogNow: () => watchdog,
      bldTimerNow: () => bldTimer,
      setBldTimer: (v) => { bldTimer = v; },
      zoomNameTimerNow: () => zoomNameTimer,
      setZoomNameTimer: (v) => { zoomNameTimer = v; },
    });
    /* 解构出来的 8 个注册函数 —— 名字与调用点见下面那 8 处（顺序与事件名逐字未变）。 */
    const {
      registerPitchGuard, registerMapErrors, registerRenderFlag, registerMapLoad,
      registerCameraMotion, registerViewMoveEnd, registerViewZoomEnd, registerPinEdge,
    } = stageEvents;

    /* 🎬 侧视角护栏（**唯一真源** `wsScene.applyPitchGuard()`）—— 补「App = 代拍页那一屏」的欠账：
       代拍页早就有这套（pitch > 55° 按比例降拖动/滚轮速度），App 侧一直没搬 ⇒ 侧视角一划就没
       （同样的手指位移对应巨大的地面距离）。数值全部取自 `wsScene`，**不在这里抄第二份**。
       调两次：建图后立刻一次（此刻 `dragPan` 可能还没挂 ⇒ 函数内部静默跳过），
       之后每次 `pitch` 变化重设一次（已读源码确认 `enable()` 会重写惯性选项 ⇒ 真的生效）。 */
    applyPitchGuard(m);
    /* ① pitch → wsStageEvents.registerPitchGuard（注册点与顺序留在原地） */
    registerPitchGuard(m);

    /* ② error ×2 → wsStageEvents.registerMapErrors */
    registerMapErrors(m);

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
    /* ③ render → wsStageEvents.registerRenderFlag */
    registerRenderFlag(m);
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

    /* ④ load → wsStageEvents.registerMapLoad（本片最大的一处） */
    registerMapLoad(m);

    /* ⑤ movestart / move / click → wsStageEvents.registerCameraMotion */
    registerCameraMotion(m);

    /* ⑥ moveend → wsStageEvents.registerViewMoveEnd */
    registerViewMoveEnd(m);
    /* ⑦ zoomend → wsStageEvents.registerViewZoomEnd */
    registerViewZoomEnd(m);

    /* ⑧ 屏外指示 move / moveend / zoom → wsStageEvents.registerPinEdge */
    registerPinEdge(m);

    /* fps 计数已提到 `startFps()`（在"分渲染路"之前启动，降级路也有数） */
  });

  onBeforeUnmount(() => {
    alive = false;
    /* 🕹 摇杆会话**就地作废**（不重算 —— 这一屏马上就没了）：`alive=false` 之后 `onJoyHalt()`
       本来也会早退，但这里显式清一次，免得"标志留在 true 上"这种事再被后来的人踩。 */
    joyActive = false;
    /* 🧱 S5（M5）：那两个累计位移（跟手/补刷新用）是摇杆会话自己的状态（已搬进 `wsJoystickStage.ts`）
       ⇒ 经那个出口清掉（`resetAcc()` 逐字就是原来的 `joyAccX = 0; joyAccY = 0;`）。 */
    resetAcc();
    unguard?.();
    unguard = null;
    unlockPageGestures();
    stopTimer();
    if (bldTimer) window.clearTimeout(bldTimer);
    if (zoomNameTimer) window.clearTimeout(zoomNameTimer);
    /* 🧱 S5（M4）：换批 / 进场淡入 / 退场幽灵 / 传送帧举旗摘旗那**五个**定时器与两帧句柄
       都是 `wsNameHost.ts` 私有的 `let` ⇒ 经这个出口一次清掉（函数体里那五条判据与顺序
       与原宿主逐字相同，见 `cancelMotion` 的说明）。 */
    cancelMotion();
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
