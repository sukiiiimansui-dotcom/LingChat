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
  <div ref="host" class="ws-dml">
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
        :class="[labClassOf(n.style), { 'is-sketch': n.sketch }]"
        :data-ws-lab="n.pick.kind"
        :data-ws-lab-id="n.id"
        :data-ws-lab-style="n.style"
        :style="{ transform: `translate3d(${n.x}px, ${n.y}px, 0)` }"
        :title="n.why"
        @click.stop="openCardFromNode(n)"
      >
        {{ n.text }}
      </button>
    </div>

    <!-- 2D 降级路的"人"（WebGL 路用地图库 Marker，不在这里画） -->
    <div v-if="!mapAvailable" class="ws-dml__pins">
      <i
        v-for="p in domPins"
        :key="p.id"
        class="ws-dml__pin"
        :class="{ 'is-me': p.isMe, 'is-aff': p.affinity }"
        :style="{ left: p.left, top: p.top }"
        :title="p.name + (p.affinity ? '（特地来找你）' : '')"
        >{{ (p.name || '我').slice(0, 1) }}</i
      >
    </div>

    <!-- 🪪 **信息卡**：点楼体 / 点名字 / 点区名 ⇒ **同一张卡**（`wsBuildingCard.buildingCardData`）。
         动效令牌全部来自 `CARD_MOTION`（一处定义）；组件里**没有** `backdrop-filter`
         （全局 `.ws-card` 类自带 `blur(var(--ws-blur))`，玻璃主题下是 10px ⇒ 一用就掉帧，所以不套它）。 -->
    <WsBuildingCard :data="cardData" :open="cardOpen" :low="perfLow" @close="closeCard" />

    <!-- 指标条：验证用（也让人一眼看到"这是真数据还是降级"）。
         `ref="hudEl"`：样式自检 JSON 里要带上 **HUD 原话**（机主看到的就是这一行，逐字带回，
         不转述 —— 转述过一次就把"地图库 8 秒内没画出第一帧"写成了"加载失败"）。 -->
    <div ref="hudEl" class="ws-dml__hud">
      <span>{{ stats.mode }}</span>
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
  import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
  import worldMapApi, { facilitiesAuto, geoJson } from "@/api/services/worldMap";
  import WsLoading from "./WsLoading.vue";
  import type { WsDistrictPin } from "./wsActors";
  /* 性能档位（模块级单例，与 `WorldSim.vue` 拿到的是**同一份**）。
     为什么这个组件也要拿它：**降级决定发生在这里** —— 只有这里知道"最后到底走了哪条渲染路"，
     而档位必须跟着那条路走（见 `fallback2d()` 里 `perf.forceLow()` 那段）。 */
  import { useWsPerf } from "./wsPerf";
  import { aiFeatureCollection, aiFeatures, boxAround as aiBoxAround, type AiItem, type BBox } from "./wsAiLayers";
  /* 「OSM 优先、Overture 补缺」的合并规则（纯逻辑，单独一份 ⇒ 能在 Node 里全量自检）。 */
  import { mergeBuildingSources, shouldAskSecondSource, type BldFeature } from "./wsBuildingSources";
  /* 「楼多高、什么颜色」的纯逻辑（`wsBuildingLook.ts`，独立文件 ⇒ 可单测、不跟渲染纠缠）。
     2026-09-19 机主：「这个 ai 2d 小区好丑，直接试一下 3d 路线我看看效果」——
     这一刀就是"3D 路线"的美术部分：真轮廓 + 有起伏的高度 + 有层次的光照。 */
  import { HEIGHT_COLOR_RAMP, decorateBuildings, hash32, heightColorExpression, renderHeight } from "./wsBuildingLook";
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
    bldVerdictText,
    cameraDefaults,
    fetchRadiusForView,
    fetchRadiusLadder,
    prerenderSourceOf,
    roadsLiveDecision,
    roadsVerdictText,
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
    districtStyleOf,
    /* 🎨 基准上妆（`h3d`/`h_from`/`fp`/`small`，**不拆件**）—— 两页默认档共用这一条（机主 (a′)）。
       以前 App 用 `decorateBuildings` base 档，那份**照样拆 roof/antenna** ⇒ 两页默认档不是一个东西。 */
    dressBase,
    flushBldStore,
    flushRoadsStore,
    scenePlanConsumed,
  } from "./wsDistrictScene";
  /* 🧱 **累积式要素仓库 + 离线格数学**（`createFeatureStore` / `*BundleCellsForView`）：
     机主「之前的没了…必须保证视野内完整」那条。合并/淘汰/格键的规则只有那一份，这里只调用。 */
  import { createFeatureStore } from "./wsFeatureStore";
  /* 🧱 **离线包取数管道**（App 侧承载；代拍页里那份是原型的内联写法，不进 PR）：
     串行取格 + 每格独立超时 + 并进仓库 + 一次 setData。判词/决策/半径仍从 `wsScene` 来。 */
  import {
    BLD_STORE_CAP,
    ROADS_STORE_CAP,
    type BundleBuildingFeature,
    type BundleFeedFacts,
    type BundleRoadFeature,
    type BundleView,
    bldIdOf,
    bldPointOf,
    bldVerdictState,
    bundleCountsLine,
    createBundleFeed,
    fetchWithTimeout,
    loadBundleIndex,
    roadsIdOf,
    roadsPointOf,
    roadsVerdictState,
  } from "./wsOfflineFeed";
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
  /* 🔬 「验证面板」（机主 2026-09-21：「**保证我们的全部验证功能在 App 页可全部看到喵！**」）。
     面板与样式 JSON **吃同一份快照** —— 同一件事两种读者（人看图、agent 读 JSON），不许各算一套。 */
  import WsVerifyPanel from "./WsVerifyPanel.vue";
  import { type VerifySnapshot, runVerifyChecks } from "./wsVerifyChecks";
  /* 真等高线（Terrarium DEM → marching squares，纯函数自检 37/37）。
     放在这里而不是只在自用页：小区级是 zoom≈15 的俯视/倾斜视角，**20m 间隔的等高线在这里最好看也最有用**
     （山城尤其明显），而且它和我们已接的 Esri 暗色底图、真楼房挤出是三层叠加。 */
  import {
    DEM_TILE_SIZE,
    DEM_TILE_Z,
    contourFeatureCollection,
    demTileUrl,
    lngLatToTile,
    readDemGrid,
    tileContours,
  } from "@/composables/wsContour";

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
    (e: "scene-ready", payload: { map: unknown; buildings: { features?: unknown[] } | null }): void;
  }>();

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
  /**
   * 那块**自绘**画布要不要存在？（模板 `v-if="show2d"`）
   * 只有真的走 2D 降级路时才 `true` —— 定案证据：WebGL 路下它是一块**默认 300×150、透明、
   * display:block** 的空壳，CSS 拉满整屏 ⇒ **盖住真地图**（机主的"浅色矩形"就是它）。
   */
  const show2d = ref(false);
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
  /**
   * 🔴 2026-09-21 机主硬要求：「**要求别降级了，直接全面迭代（最新）**」+「App 整个地图感觉像落后好多」。
   *
   * ⇒ **默认不再自动降到 2D 自绘路**（那条路又卡、又像静态图、又没有手势 ——
   *   而机主的机器**有** WebGL，代拍页 `ws3dshow.html` 实测顺滑）。
   * 手动逃生阀 `?wsfallback=1`（真机确实没有 WebGL 时才用）保留，默认关。
   * ⚠️ 例外：**自动化/无头**（`navigator.webdriver`）保留 2D 兜底 ——「能玩」闸门跑的就是那条路，
   * 关掉它等于把闸门变成假失败（它量不到任何东西）。
   */
  const ALLOW_2D = (() => {
    try {
      if (/[?&]wsfallback=1\b/.test(location.search)) return true;
    } catch {
      /* 无 location ⇒ 看下面的 automation 判定 */
    }
    return isAutomation();
  })();
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
  let raf = 0;
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
        "temp"
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
      "perm"
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
  let pins: Array<{ id: string; el: HTMLElement; mk: { setLngLat(c: [number, number]): unknown; remove(): void } }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mlMod: any = null;
  /** 上一次取楼的"中心+半径"缓存键（相同就不重复请求） */
  let lastBldKey = "";

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

  /**
   * 现在到底该不该画示意层。
   *
   * **唯一真源**：`stats.count`（= 上一次真的取回来的真楼栋数，`classify`/`dressBld` 里写的）
   * —— 不另开一个计数器，否则"HUD 说的"和"画的"迟早漂移。
   * 这样它天然满足"真数据优先"：真楼一到 40 栋，`aiOn` 自己变 false，
   * 下面的 watcher 会把已经画上去的图层**摘掉**（不是留着不管）。
   */
  const aiOn = computed(() => props.showAi || (props.aiAuto && stats.count < BLD_SPARSE));

  const stats = reactive({
    mode: "初始化…",
    count: 0,
    height: 0,
    levels: 0,
    default: 0,
    /** 🏷🗺 名字层那一行（**真源判词**：真名 N · 区名 M=数据驱动+示意 · **生成名上屏 0** · 点/格/D/模式）
     *  —— 三档**分开计数**，且"生成名上屏"恒为 0（机主拍板：生成名只进信息卡） */
    names: "",
    /** 🪪 信息卡：当前开着没有（探针读 DOM，不靠调试出口） */
    card: "",
    fps: 0,
    note: "",
    /** 等高线段数：>0 有效、0 还没画、-1 取不到（HUD 上如实显示） */
    contour: 0,
    /** 当前渲染的是**哪个区**（取自 `/api/geo_json` 的 properties.name，如"涪陵区"）—— 验证用 */
    area: "",
    /** 视野档：全区视野 / 街区视野（放大后才取楼栋） */
    view: "",
    /** 画在屏幕上的"人"的数量（WebGL 走地图库 Marker、2D 降级走 DOM；两个都算） */
    pins: 0,
    /** 👤 人的锚点从哪来（`视野兜底（无 adcode）` / `行政区 bbox`）；空 = 还没有锚点 */
    pinsAnchor: "",
    /** 👤 放不下人时的**原因原文**（三态里的"数不出来"；空 = 没这个问题） */
    pinsNote: "",
    /** 🛣 本视野**看得见**的路条数（口径与画法一致：按 zoom 过滤档位，见 `visibleRoadCount`） */
    roads: 0,
    /** 🛣 累积仓库那一行（可数：仓库 N 条 / 已取格 / 包外 / 失败）—— 与 HUD 同源 */
    roadStore: "",
    /** 🏢 离线楼房包那一行（`🏢 离线格 已取 x / 包外 y / 失败 z · 仓库 N 栋`） */
    bldBundle: "",
    /** 🏢 形体档：1 = 原始脚印（默认，与代拍页同源）· 2 = 拆件（`?bld=2`）—— 探针/回证要读它 */
    bldMode: 1,
    /** 🏢 拆件档拆出来几个要素（`ShapeCounts.parts`；默认档不拆 ⇒ 0） */
    parts: 0,
    /** 🛣 离线路网包那一行（同式） */
    roadsBundle: "",
    /** 🏢 判词（**真源** `wsScene.bldVerdictText`：包外 / 取数失败 / 正常，三态不混） */
    bldVerdict: "",
    /** 🛣 判词（**真源** `wsScene.roadsVerdictText`；包外只在计数行里如实写） */
    roadsVerdict: "",
    /** 🔴 署名（**原句取自包里的 `index.json`**，不在这里重写第二版）—— ODbL 硬要求 */
    attribution: "",
    /** 🌊🌳 水/绿地那一行（**真源** `wsGwLayer.gwVerdictLine`：正数 / 0（已量）/ 数不出来，三态不混） */
    gwVerdict: "",
    /** 路网统计的一句话（主干几条 / 有几条有名字）—— 数据质量要看得见 */
    roadNote: "",
    /** 🏪 画在地图上的设施点（`/api/facilities` 的生活类 + 交通类） */
    facilities: 0,
    /** 设施统计的一句话（哪几类、共几个；缺的类如实说） */
    facNote: "", 
    /** 低档的原因（被**实际渲染路**压下来的，见 `wsPerf.forceLowTier`）。空串 = 没被压 */
    perf: "",
  });
  /* 🏢 形体档写进 stats：探针/HUD 要能读出"这一屏是默认档还是拆件档"（回证） */
  stats.bldMode = WS_BLD_MODE;

  /* ── 长等待可视化：三段**真实**阶段 + 已等秒数（机主 2026-09-19）────────────
     · `fetch` 是唯一的长尾（Overpass 现取，十秒到一分半都见过）；
     · `lastMs` = **上次同半径成功取数的真实耗时**（localStorage 记忆）——它是唯一
       有资格当"约还需"的数；没有它就**不画进度条**，只转等高线（不装确定）。 */
  /* ⚠️ 别写 `as const`：只读元组不能喂给 `WsLoading` 的 `stages?: string[]`（TS4104，已实测踩到） */
  const STAGE_NAMES: string[] = ["取真实楼栋", "整理数据", "画 2.5D"];
  type Phase = "fetch" | "build" | "render" | "done";
  const phase = ref<Phase>("fetch");
  const waited = ref(0);
  const lastMs = ref(0);
  const t0 = Date.now();
  let timer = 0;
  const K_MS = "wsm:v1:bldgMs";
  try {
    lastMs.value = Number(localStorage.getItem(K_MS) || 0) || 0;
  } catch {
    /* 隐私模式读不到就当没记录 */
  }
  const stageIdx = computed(() => {
    const i = STAGE_NAMES.indexOf(
      phase.value === "fetch" ? "取真实楼栋" : phase.value === "build" ? "整理数据" : "画 2.5D"
    );
    return Math.max(0, i);
  });
  const waitText = computed(() =>
    phase.value === "fetch" ? "正在取真实楼栋…" : phase.value === "build" ? "整理楼栋数据…" : "正在画 2.5D…"
  );
  const waitSub = computed(() => {
    const s = (waited.value / 1000).toFixed(1);
    if (phase.value === "fetch" && lastMs.value > 0) {
      return `已等 ${s}s · 上次 ${(lastMs.value / 1000).toFixed(1)}s（估算）`;
    }
    return `已等 ${s}s`;
  });
  const etaMs = computed(() => (phase.value === "fetch" && lastMs.value > 0 ? lastMs.value : undefined));
  const progRatio = computed(() => {
    if (phase.value !== "fetch" || lastMs.value <= 0) return undefined; // 没有分母 → 交给不确定态
    return Math.min(0.9, waited.value / lastMs.value);
  });
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  /**
   * 自建 style —— **装配在共享真源里**（`wsDistrictScene.districtStyleOf()`）。
   *
   * 🔴 2026-09-25（PR 标准门禁 C1）：这里原来有一份本地 `makeStyle()`，与原型页那份并存 ⇒
   * "运行期逻辑必须在共享单一真源"（`ROUTE.md §五.1`）不达标。现在**搬家**到
   * `wsDistrictScene.ts`（行为逐字不变），宿主只把主题/档位/过渡时长递进去。
   * 回退：`git revert <本 commit>`。
   */
  function styleNow(): Record<string, unknown> {
    return districtStyleOf(theme.value, !!perf.low.value, perf.low.value ? 0 : NIGHT_FADE_MS);
  }

  function bboxOfGeometry(g: { type?: string; coordinates?: unknown } | null | undefined): [number, number, number, number] | null {
    if (!g) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const walk = (v: unknown): void => {
      if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
        const x = v[0] as number;
        const y = v[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      if (Array.isArray(v)) for (const x of v) walk(x);
    };
    walk(g.coordinates);
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
    return [minX, minY, maxX, maxY];
  }

  /**
   * 以某点为**中心**、边长 `m` 米的正方形 bbox —— 给"示意街区"当画布。
   * 实现搬到了 `wsAiLayers.boxAround`（**纯函数**才能进 Node 自检；写在 .vue 里就跑不了单测）。
   */
  const boxAround = (lng: number, lat: number, m: number): BBox => aiBoxAround(lng, lat, m);

  /**
   * 楼高来源分类（与 Rust/前端别处的口径一致：height → levels×3 → **按 OSM 类型估**）。
   *
   * ⚠️ 三档必须分得开（`DESIGN-3D-MODES.md` §八 的红线）：
   * OSM 在中国的楼高覆盖率很低（渝中区实测 800m 内 232 栋里 **166 栋没有高度**），
   * 那 166 栋的高度是**我们按 `building=*` 类型猜的**，HUD 里单独一列，
   * 绝不能混进"真高" —— 混在一起报一个数就是把估计值当真数据。
   */
  function classify(fc: { features?: BldFeature[] }) {
    let h = 0;
    let l = 0;
    let d = 0;
    for (const f of fc.features || []) {
      const s = String((f.properties || {}).height_src || "default");
      if (s === "height") h++;
      else if (s === "levels") l++;
      else d++;
    }
    stats.height = h;
    stats.levels = l;
    stats.default = d;
    stats.count = (fc.features || []).length;
  }

  /**
   * 给后端给的真楼房"上妆"：补上渲染字段 `h3d`（渲染高度）与 `h_from`（高度凭什么），
   * 顺手把 HUD 的三档计数更新掉。
   *
   * **只在这里算一次**，后面所有 `addSource/setData` 都用这份结果 ——
   * 画面用的高度和 HUD 报的数于是**必然是同一个数**（两边各算一次迟早漂移，漂移了没人会发现）。
   */
  function dressBld(fc: { features?: BldFeature[] } | null): {
    type: "FeatureCollection";
    features: unknown[];
  } {
    /* 🎨 **默认档 = 基准上妆（不拆件）** —— 机主拍板 **(a′)：App 向代拍页看齐**
       （原话「**我的要求是代拍页和App页完全一样喵**」）。
       两页默认档走**同一个** `dressBase()`（共享真源 `wsDistrictScene`）：只补
       `h3d`/`h_from`/`fp`/`small`，**不拆件** ⇒ 图层清单与 paint 才可能逐字段相同
       （`ws_pages_consistency.mjs` 的 ④a/④b 盯着）。
       ⚠️ 以前这里调 `decorateBuildings(fc, ramp)`（base 档）—— 那份**照样拆出 roof/antenna**，
       于是 App 默认档比页面多两条层、还多一套 `part` 过滤（同一条 `bld-ext` 的过滤在页面上会
       匹配 0 栋 = 一栋都不画）。这是"凑 id 式假绿"的根，别再走回去。
       🏢 **`?bld=2` = 拆件档**（与代拍页同一个开关）：走 `decorateBuildings(..., {mode:"detail"})`，
       颜色写进要素属性 `color3d` ⇒ 图层那边用 `mode:"parts"` 的规格（三条 part 层）读它。 */
    if (WS_BLD_MODE === 2) {
      const { features, count } = decorateBuildings(fc, artTheme(theme.value).ramp, { mode: "detail" });
      stats.count = count.n;
      stats.height = count.real;
      stats.levels = count.levels;
      stats.default = count.kind; // HUD 里这一列叫「按类型估」
      stats.parts = count.parts;
      return { type: "FeatureCollection", features };
    }
    const { features, counts } = dressBase(fc?.features as readonly BldFeature[] | undefined);
    stats.count = counts.n;
    stats.height = counts.real;
    stats.levels = counts.levels;
    stats.default = counts.kind; // HUD 里这一列叫「按类型估」
    return { type: "FeatureCollection", features };
  }

  /** 渲染高度 → 颜色（2D 降级路用；与 3D 的色阶**同一张表**，免得两条路观感不一致）。
   *  表来自当前主题 —— 二次元主题下连 2D 降级也是那套淡天蓝。 */
  function rampColor(h: number): string {
    const ramp = theme.value.ramp;
    let c = ramp[0]![1];
    for (const [stop, col] of ramp) {
      if (h >= stop) c = col;
    }
    return c;
  }

  /**
   * Canvas2D 降级：把真实楼房画成**俯视图**。
   * 不引任何东西 —— 经纬度按包围盒线性映射到画布，y 轴翻转（纬度向上、画布向下）。
   */
  function draw2d(fc: { features?: BldFeature[] } | null) {
    const c = cv.value;
    if (!c) return;
    /* 🎨 2D 降级路的调色板**从主题取**（2026-09-20 主会话截图发现：主题只写在 MapLibre 的
       style 上，而低端机走的是这条 Canvas2D 自绘路 ⇒ 底色是写死的深色，
       结果一台低端机上是"浅蓝界面 + 黑地图"的半截子观感）。
       这一刀把 `bg / empty / 描边 / 示意层投影` 全部改成读 `theme.canvas`。
       ⚠️ 这块画布**没有自己的 CSS 底色**（`.ws-dml__cv` 只有 position/inset），
          所以下面那次 fillRect 就是"地面"本身，改它才有效。 */
    const pal = theme.value.canvas;
    // ⚠️ 别把局部变量叫 `host`：会遮蔽外层的 ref，TS 直接报"自引用"（TS7022/TS2448）
    const el = host.value;
    const w = Math.max(64, el?.clientWidth || 320);
    const h = Math.max(64, el?.clientHeight || 240);
    /* 🔴 2026-09-21：降级路的画布**像素数封顶 1.5×**（原来是 `min(2, dpr)`）。
       机主的证据把这条钉死了：「**在小区级很卡**（那可能降级后的是，在那个代拍里的用 webgl
       却一点都不卡）」—— 同一台手机，WebGL 那条路不卡 ⇒ **贵的是这条路**。
       它贵在**填充率**：真机 1080×2400 @dpr2.4 的画布，按 dpr=2 建 = **1080×2400 像素**
       （原来 `min(2, 2.4)` 就是 2），每一次自绘（底色 + 网格 + 楼 + 等高线 + 示意层）
       都要把这么多像素写一遍；封到 1.5 ⇒ 810×1800 = **少 44% 的像素**，观感几乎无差别
       （这块画布画的是平面俯视图，不是要抠细节的写实图）。
       逃生阀：`?wsdpr=2`（低端机想对照/想更清楚时用，与 `?wsnight=off` 同一套口径）。 */
    let dpr = Math.min(dprCap2d(), window.devicePixelRatio || 1);
    /* 再按**总像素**封一道（机主/主会话要的"降级路画布尺寸封顶"）：
       大屏（平板/横屏）上 `w×h` 本来就大，DPR 1.5 也能堆到几百万像素。
       1.4M 像素 ≈ 1440×960 的 2D 自绘量：够看清街区轮廓，又不会让每次自绘去写几百万像素。 */
    const MAX_PX_2D = 1_400_000;
    const px = w * h * dpr * dpr;
    if (px > MAX_PX_2D) dpr = Math.max(1, dpr * Math.sqrt(MAX_PX_2D / px));
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    const feats = fc?.features || [];
    /* 🆕 2026-09-20：**降级路也要能"看到城市"**。
       以前这里只画真楼 ⇒ 涪陵（真楼 0~29 栋）在低端机上就是一片空 + 一行
       「这一带没有楼房数据」，和机主要的"成片"完全相反。
       现在把同一份示意图元也画进来（同一条 `aiOn` 判据：真数据够就不画）。
       ⚠️ 位置仍然是示意（线性映射），所以这一层用**暖色**画，和真楼的冰蓝分得开。 */
    const aiFc = aiOn.value && aiBboxRef.value ? aiFeatures(props.aiItems || [], aiBboxRef.value, props.grid || 28) : [];
    const aiPolys: Array<{ pts: number[][]; kind: string }> = [];
    for (const f of aiFc) {
      if (f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (ring?.length) aiPolys.push({ pts: ring as number[][], kind: String(f.properties.kind) });
    }
    if (!feats.length && !aiPolys.length) {
      /* 🔴🔴 **这里曾经就是机主看到的「纯色屏」**（2026-09-21 定案）。
         原来这个分支只做两件事：铺满 `pal.bg` + 在左上角写一行 12px 的
         「这一带没有楼房数据」⇒ 一屏**只有底色**（二次元主题下是 `#DCEFF7` 一片浅蓝），
         远看/缩略图看**就是一张纯色图**；而机主 21:54 那两张"逐字节相同"的截图
         量出来正是 `std=0.00` 的单色。

         为什么会走到这儿：看门狗把"地图库 8 秒内没画出第一帧"判成降级 ⇒ 2D 路，
         而 2D 路的楼栋要**放大到街区**才会去取 ⇒ 全区视野下 `feats` 是空的。
         两个"如实"叠在一起，结果是一屏什么都没有。

         ⇒ 纪律改成：**降级路永远不许留一整片纯色**。没有数据就画一个**明确的等待态**：
           浅网格（看得出"这是一块地，不是坏了"）+ 两行字（在等什么、为什么）。
         代价是几十条线，**只画一次**（`draw2d` 不是逐帧调用）⇒ 低档帧率不受影响；
         真正的"呼吸"动效交给 DOM/CSS（见模板里那块 `.ws-dml__wait`），不开 canvas 逐帧。
         ⚠️ 网格颜色从**主题**取（`pal.empty` + 低透明度）而不是写死灰色：
           夜色/暗色主题下写死的灰线会变成"亮底上的白线"（看不见），这条踩过。 */
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = pal.empty;
      ctx.lineWidth = 1;
      const step = 28;
      ctx.beginPath();
      for (let x = step; x < w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = step; y < h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = pal.empty;
      ctx.font = "13px system-ui";
      ctx.fillText("降级预览 · 楼栋还没取到", 12, 24);
      ctx.globalAlpha = 0.75;
      ctx.font = "11px system-ui";
      /* 🔴 这两行必须**逐字为真**（原来那行「这一带没有楼房数据」是在替后端下结论，
         而真相常常只是"这一档根本没去取"）。
         为什么不能写「放大到街区会自动加载」：**2D 降级路上缩放是死的** ——
         `zoomBy`/`fitDistrict` 都要 `map`（MapLibre 实例），而降级时 `map = null`
         ⇒ 楼栋永远不会再取。写在画布上的承诺必须是我们真做得到的。 */
      ctx.fillText("地图库没起来，走的是自绘路；HUD 里有原因", 12, 42);
      ctx.globalAlpha = 1;
      /* 这一屏**什么都没画**（连楼都没有）⇒ 也就没有"范围内"可言：把范围清空，
         让 `domPins` 空着并在 HUD 如实写"数不出来"，而不是把人撒在一块没画的画布上。 */
      draw2dBbox.value = null;
      return;
    }
    // 包围盒（真楼 + 示意图元一起算，否则示意层会被算到画布外）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rings: Array<{ pts: number[][]; col: string }> = [];
    for (const f of feats) {
      const g = (f.geometry || {}) as { type?: string; coordinates?: unknown };
      const polys: number[][][][] =
        g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
      /* 颜色按**渲染高度**取（与 3D 路同一张色阶表）—— 降级路也看得出高低。
         拆件（屋顶/天线）在 2D 俯视图里只会重影，所以**只画主体**。 */
      if ((f.properties || {}).part && (f.properties || {}).part !== "body") continue;
      const col = rampColor(renderHeight(f.properties).h);
      for (const poly of polys) {
        const ring = poly[0];
        if (!ring?.length) continue;
        rings.push({ pts: ring as number[][], col });
        for (const p of ring) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        }
      }
    }
    for (const a of aiPolys) {
      for (const p of a.pts) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;
    /* 🧭 把这份范围**留给降级路的人**（`domPins` 要用同一份，人才会站在画出来的楼上）。 */
    draw2dBbox.value = [minX, minY, maxX, maxY];
    const pad = 10;
    const k = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    const ox = (w - k * (maxX - minX)) / 2;
    const oy = (h - k * (maxY - minY)) / 2;
    const X = (lng: number) => ox + (lng - minX) * k;
    const Y = (lat: number) => oy + (maxY - lat) * k; // y 翻转
    for (const r of rings) {
      ctx.beginPath();
      r.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.closePath();
      ctx.fillStyle = r.col;
      ctx.fill();
      /* 描边跟主题走：二次元是**深藏青**（浅底上才看得见），暗色是淡白细线 */
      ctx.strokeStyle = pal.bldStroke;
      ctx.lineWidth = pal.bldStrokeW;
      ctx.stroke();
    }
    /* 示意层（暖色，和真楼的冰蓝分得开）。俯视图里没有"高度"，
       所以给每栋楼往右下**偏移一小块**当投影 —— 一眼能看出这是"有体量的楼"，
       而不是一块平贴的色块（机主要的"成片楼房"在 2D 降级路上也要成立）。 */
    for (const a of aiPolys) {
      const hex = a.kind === "park" ? theme.value.ai.park : a.kind === "water" ? theme.value.ai.water : "#d9a06b";
      ctx.beginPath();
      a.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.closePath();
      if (a.kind === "park" || a.kind === "water") {
        /* 和上面 3D 的 `ai-area` 用**同一对颜色**（`theme.ai`），别再写第二套 rgba */
        ctx.fillStyle = a.kind === "park" ? theme.value.ai.park : theme.value.ai.water;
        ctx.fill();
        continue;
      }
      /* 投影：往右下挪 6% 的楼宽，紫黑半透明 */
      const dx = Math.max(1.5, (Math.max(...a.pts.map((p) => p[0])) - Math.min(...a.pts.map((p) => p[0]))) * k * 0.12);
      ctx.save();
      ctx.translate(dx, dx * 0.7);
      ctx.fillStyle = pal.aiShadow;
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = hex;
      ctx.fill();
      ctx.strokeStyle = pal.aiStroke;
      ctx.lineWidth = pal.aiStrokeW;
      ctx.stroke();
    }
  }

  /**
   * 取中心那张 DEM 瓦片 → 算等高线 → 挂成一层线（放在楼房**之下**，不抢主体）。
   * ⚠️ 失败一律如实写进 HUD 的 note，**不画假等高线**；`stats.contour` 记 -1。
   */
  async function drawContours(m: {
    getCenter(): { lng: number; lat: number };
    getSource(id: string): { setData(d: unknown): void } | undefined;
    getLayer(id: string): unknown;
    addSource(id: string, spec: Record<string, unknown>): void;
    addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  }): Promise<void> {
    try {
      const c = m.getCenter();
      const t = lngLatToTile(c.lng, c.lat, DEM_TILE_Z);
      const tx = Math.floor(t.x);
      const ty = Math.floor(t.y);
      const grid = await readDemGrid(demTileUrl(DEM_TILE_Z, tx, ty));
      const feats = tileContours({
        grid,
        w: DEM_TILE_SIZE,
        h: DEM_TILE_SIZE,
        z: DEM_TILE_Z,
        tx,
        ty,
        interval: 20,
        maxLevels: 40,
      });
      if (!feats.length) {
        stats.contour = 0;
        return;
      }
      const data = contourFeatureCollection(feats);
      const src = m.getSource("dem");
      if (src) {
        src.setData(data);
      } else {
        m.addSource("dem", { type: "geojson", data });
        /* ⚠️ `addLayer(spec, beforeId)` 里的 beforeId **不存在会直接抛**
           （`Layer with id "bld-ext" does not exist`）。
           而"这一带没有楼房"时 `bld-ext` 根本不会被建出来（涪陵实测 400m 就是 0 栋）
           ⇒ 等高线会连带整层失败、HUD 只显示"等高线不可用"。
           所以这里**逐级回退**：楼 → 注记层 → 直接追加。 */
        const before = m.getLayer("bld-ext") ? "bld-ext" : m.getLayer("ref") ? "ref" : undefined;
        m.addLayer(
          {
            id: "dem-line",
            type: "line",
            source: "dem",
            paint: {
              /* 每整 100m 计曲线加粗提亮（地形图惯例：一眼读数） */
              "line-color": [
                "case",
                ["==", ["%", ["get", "ele"], 100], 0],
                "#ffd28a",
                "rgba(121, 217, 255, 0.55)",
              ],
              "line-width": ["case", ["==", ["%", ["get", "ele"], 100], 0], 1.2, 0.5],
              "line-opacity": 0.8,
            },
          },
          before
        );
      }
      stats.contour = feats.length;
    } catch (e) {
      stats.contour = -1;
      const why = String((e as Error)?.message || e).slice(0, 24);
      stats.note = stats.note ? `${stats.note} · 等高线取不到` : `等高线取不到（${why}）`;
    }
  }

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
          live: { on: LIVE_ON, bldHits: liveBldHits, roadHits: liveRoadHits, bldInfo: liveBldInfo, roadInfo: liveRoadInfo },
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

  /** 造一个"人"的 DOM（用行内样式：scoped CSS 管不到运行时 new 出来的元素） */
  function pinEl(a: WsDistrictPin): HTMLElement {
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
    /* 标题里如实带出"位置是怎么来的"：吸附到路上（`road`）和网格示意位置，
       精度完全不是一回事 —— 以后排查"怎么站到江里了"就靠这一行。 */
    el.title =
      `${a.name || "我"}` +
      (a.posSource === "affinity" ? "（特地来找你）" : "") +
      (a.posSource === "road" ? "（在路上）" : a.posSource === "facility" ? "（在设施旁）" : "");
    return el;
  }

  /**
   * 把 `markers` 同步到地图上：新增的建 Marker、已有的挪位置、消失的移除。
   * 好累～ 每次 moveend 都要重算一遍吗？不用 —— 网格→经纬度只依赖区界 bbox，
   * 与相机无关，所以只在"人变了 / 区界到了"时同步。
   */
  /** 节流：`click` 与 `pointerup` 都可能触发同一动作（双保险），150ms 内只认第一次 */
  let lastZoomAt = 0;
  function zoomOnce(delta: number): void {
    const now = Date.now();
    if (now - lastZoomAt < 150) return;
    lastZoomAt = now;
    zoomBy(delta);
  }

  /** 「全区」：铺满整个区县（这个缩放下不取楼栋——楼只是几个像素点，Overpass 也扛不住大半径） */
  function fitDistrict(): void {
    const b = bboxRef.value;
    const m = map as unknown as { fitBounds(x: unknown, o?: unknown): void; setPitch?(v: number): void } | null;
    if (!b || !m) return;
    try {
      m.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: 16, pitch: props.pitch, duration: 500 }
      );
      /* 不赌库的默认值：整区铺满之后**显式**把倾角摆回来（2.5D 的观感全靠它） */
      m.setPitch?.(props.pitch);
      stats.mode = "全区视野（区县边界）";
      stats.view = "全区视野";
      stats.note = "全区视野：放大到街区后自动加载楼房";
    } catch {
      /* 收不了相机就算了 */
    }
  }

  /** 按钮缩放：走地图库的 zoomTo（带一点动画，手感比瞬移好） */
  function zoomBy(delta: number): void {
    const m = map as unknown as { getZoom(): number; zoomTo(z: number, o?: unknown): void } | null;
    if (!m) return;
    try {
      m.zoomTo(Math.max(1, Math.min(18, m.getZoom() + delta)), { duration: 420 });
    } catch {
      /* 缩不动就算了，不影响别的 */
    }
  }

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
    for (const a of list) {
      const raw = gridToLngLat(a.gx, a.gy);
      if (!raw) continue;
      const { pos, snapped } = snapPin(raw);

      alive.add(a.id);
      const hit = pins.find((x) => x.id === a.id);
      if (hit) {
        hit.mk.setLngLat(pos);
        hit.el.title = `${a.name || "我"}${a.posSource === "affinity" ? "（特地来找你）" : ""}`;
      } else {
        const el = pinEl(a);
        const mk = new mlMod.Marker({ element: el, anchor: "center" }).setLngLat(pos).addTo(m);
        pins.push({ id: a.id, el, mk });
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
          left: `${(((lng - w) / spanX) * 100).toFixed(2)}%`,
          top: `${(((n - lat) / spanY) * 100).toFixed(2)}%`,
        };
      })
      .slice(0, 60); // 防呆：再多人也不至于把 DOM 撑爆
  });

  /** 给现问 Overpass 的调用加超时上限：宁可显示取不到，也不能让界面无限转圈 */
  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_res, rej) => {
        window.setTimeout(() => rej(new Error(`取数超时（${ms / 1000}s）`)), ms);
      }),
    ]);
  }

  /* ── 🔴 取数超时与重试（2026-09-24，父会话定的下一刀）──────────────────────────
     为什么必须动：同一台后端实测**冷查 27~33s**（渝中 600m：buildings 27.3s / roads 32.5s），
     而原来 App 侧一刀切 **20s / 25s 且不重试** ⇒ **冷启动那次几乎必然整批丢**，
     屏幕上就是"一栋楼都没有 / 一条路都没有"，人只会以为"这一带没数据"。
     口径：**等够 + 重试 + 失败必须可见**（三态：失败 / 空数据 / 成功，不许混）。
     ⚠️ 这里只放宽"等多久"，**不改任何观感数值**；代价是冷启动那一次要等更久
        （loading 动画一直在转，且 HUD 会写等了多久）。 */
  const BLD_FETCH_MS = 55_000; // 单次上限（冷查实测最长 33s，留一倍余量）
  const BLD_RETRIES = 2; // 最多再试 2 次（第 2 次起后端多半已在写缓存 ⇒ 命中是毫秒级）
  /** 楼房取数试了几次（HUD/面板如实报 —— 只报"失败"看不出我们为此做了什么） */
  let bldTries = 0;
  /** 楼房取数失败的原因原文（超时/HTTP 码/后端 error） */
  let bldFailedWhy = "";

  /** 带重试的取楼：**失败必须能把原因带出去**（返回 null = 三次都没成） */
  async function fetchBuildingsWithRetry(
    lat: number | undefined,
    lng: number | undefined,
    r: number
  ): Promise<unknown | null> {
    let lastErr: unknown = null;
    for (let i = 0; i <= BLD_RETRIES; i++) {
      bldTries++;
      try {
        return await withTimeout(worldMapApi.buildings({ lat, lng, r }), BLD_FETCH_MS);
      } catch (e) {
        lastErr = e;
        /* 每次失败都写进 HUD 的 note 通道（`stats.note`）—— 面板展开就能看到"第几次、为什么" */
        const msg = String((e as Error)?.message || e || "").slice(0, 60);
        bldFailedWhy = msg;
        if (i < BLD_RETRIES) {
          stats.note = stats.note ? `${stats.note} · 取楼失败重试中（${i + 1}/${BLD_RETRIES}）` : `取楼失败重试中（${i + 1}/${BLD_RETRIES}）：${msg}`;
          /* 等 1.2s 再试：冷查那次后端往往正在写缓存，立刻重试会再排一次队 */
          await new Promise<void>((res) => window.setTimeout(res, 1200));
        }
      }
    }
    throw (lastErr as Error) || new Error("取楼失败（原因未知）");
  }

  /** 路网取数试了几次（HUD/面板如实报） */
  let roadTries = 0;

  /** 带重试的取路：与 `fetchBuildingsWithRetry` **同一口径**（等够 + 重试 + 失败带原因） */
  async function fetchRoadsWithRetry(lat: number, lng: number, r: number): Promise<unknown | null> {
    let lastErr: unknown = null;
    for (let i = 0; i <= BLD_RETRIES; i++) {
      roadTries++;
      try {
        return await withTimeout(worldMapApi.roads({ lat, lng, r }), BLD_FETCH_MS);
      } catch (e) {
        lastErr = e;
        const msg = String((e as Error)?.message || e || "").slice(0, 60);
        if (i < BLD_RETRIES) {
          stats.note = stats.note ? `${stats.note} · 路网取不到重试中（${i + 1}/${BLD_RETRIES}）` : `路网取不到重试中（${i + 1}/${BLD_RETRIES}）：${msg}`;
          await new Promise<void>((res) => window.setTimeout(res, 1200));
        }
      }
    }
    throw (lastErr as Error) || new Error("取路失败（原因未知）");
  }

  /**
   * **第二数据源补缺**（Overture Maps Buildings，ODbL）—— 「换源」那一刀。
   *
   * ## 为什么只在稀疏时才问
   * 渝中区 400m 就有 152 栋**带高度**的真楼；涪陵 400m 有 **0 栋**。
   * 第二源的角色是**补缺**而不是替换（机主原话：「有真数据用真的」）⇒
   * 够看的地方（≥ `BLD_SPARSE`）根本不发这个请求：既省一次 12MB/17s 的取数，
   * 也不会拿一层**没有高度**的脚印把本来有高度的真楼淹掉。
   *
   * ## 拿不到就当没有
   * 这个源是 Termux 上的 Python 服务（8792）。**真壳 APK 里没有 Python** ⇒ 必然失败。
   * 所以这里一律 `catch` 掉、返回 null，调用方照旧只用 OSM：
   * 少一层楼，但页面照常能玩（而且那时 AI 示意层会自动顶上，见 `aiOn`）。
   *
   * ## 缓存
   * 后端按 bbox 落盘缓存（同一 bbox 只打一次 S3），前端再记一层 `Map`：
   * 拖动时来回经过同一个位置不会重复打网络。
   */
  const ovCache = new Map<string, { features: BldFeature[]; note: string }>();

  async function overtureFill(
    lat: number,
    lng: number,
    r: number,
    osmCount: number
  ): Promise<{ features: BldFeature[]; note: string } | null> {
    if (!shouldAskSecondSource(osmCount, BLD_SPARSE)) return null;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(r)}`;
    const hit = ovCache.get(key);
    if (hit) return hit;
    try {
      /* 冷启动要现读 parquet（实测 13.5s 取数 + 建/载索引），给足 60s；
         热缓存是毫秒级。超时就当没有，别拖住整屏。 */
      const geo = await withTimeout(worldMapApi.overtureBuildings({ lat, lng, r }), 60000);
      if (!alive) return null;
      const feats = (geo?.features || []) as BldFeature[];
      const out = {
        features: feats,
        /* 署名是**硬要求**（ODbL）：不写来源就是违规使用，所以这句话跟着数据一起走 */
        note: `Overture 补缺 ${feats.length} 栋（© Overture Maps, ODbL）`,
      };
      ovCache.set(key, out);
      return out;
    } catch {
      /* 服务没起 / 真壳里没有 Python / 网络抖 —— 都不是错误，只是"没有第二源" */
      ovCache.set(key, { features: [], note: "" });
      return null;
    }
  }

  /** 取楼用的地图最小接口（只声明用到的，避免 any） */  interface BldMapLike {
    getZoom(): number;
    getCenter(): { lng: number; lat: number };
    getBounds(): { getEast(): number; getWest(): number; getNorth(): number; getSouth(): number };
    getSource(id: string): { setData(d: unknown): void } | undefined;
    getLayer(id: string): unknown;
    addSource(id: string, spec: Record<string, unknown>): void;
    addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  }

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

  /* ── 🛣 路网：与楼房**同一套节奏**（视野算半径 / 去抖键 / 超时 / 如实上报）────
     为什么单独一个函数而不是塞进 loadBuildingsForView：
       · 两者的**触发条件不同** —— 楼在 z≥13.5 才取（亚像素没意义），
         而路在**更远**就该画出来（z12 起，路网是"地图的骨架"）；
       · 失败要能分别报（"楼取不到"和"路取不到"是两条不同的坏消息）。
     ⚠️ 后端是**现问 Overpass**（涪陵 800m 冷查询实测 14.7s，缓存命中 95ms）⇒
       必须有超时 + 按"中心+半径"去抖，别在拖动时反复打。 */
  let lastRoadKey = "";
  /** 路网段（吸附/寻路用）——拿到数据后就一直留着，别每次重新拆 */
  let roadSegs: RoadSeg[] = [];

  async function loadRoadsForView(m: BldMapLike): Promise<void> {
    if (!alive) return;
    /* 🔴 **默认根本不打 live**（offline-first）：决策在真源 `wsScene.roadsLiveDecision()`
       —— 冷查分钟级、600m 只有缓存命中才 0.1~1s，所以默认 0 条，路从**离线路网包**来；
       `?live=1` 才走这条（补新区域/调试），失败照旧**可见**。 */
    if (!roadsLive.live) return;
    const z = m.getZoom();
    if (z < ROAD_MIN_ZOOM) {
      stats.view = stats.view || "全区视野";
      return;
    }
    const c = m.getCenter();
    /* 半径**由真源算**（视野中心→角 与 zoom 档位取大者，夹到可用上限）—— 本组件不再有第二份 */
    const rp = liveRadiusFor(m);
    const r = rp.radius;
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r}`;
    if (key === lastRoadKey) return;
    lastRoadKey = key;
    liveRoadHits += 1; // 可数口径：这一轮真的发了一条 `/api/roads`
    try {
      /* 🔴 2026-09-24：与取楼同一口径 —— **放宽上限（25s → 55s）+ 重试 2 次 + 失败可见**。
         实测 `/api/roads` 渝中 600m **冷查 32.5s**（缓存命中 0.03s）⇒ 25s 那一刀必然砍掉冷查。
         路网是"地图的骨架"，它丢了比楼丢了更明显（父会话的诊断里 App 面板曾有 🛣118，那是缓存命中时）。 */
      const geo = (await fetchRoadsWithRetry(c.lat, c.lng, r)) as { type?: string; features?: unknown[] } | null;
      if (!alive) return;
      const fc = geo as { type?: string; features?: unknown[] } | null;
      const feats = (fc?.features || []) as BldFeature[];
      if (!feats.length) {
        /* 空结果**必须说出来**（同楼房的纪律：静默 = 让人以为"这里没路"）。
           ⚠️ 仓库里已有的**不清空**（累积语义：live 说的是"这一问回了 0 条"，不是"全都没有"）。 */
        stats.note = stats.note ? `${stats.note} · live 取路回来 0 条（r=${r}m）` : `live 取路回来 0 条（r=${r}m）`;
        liveRoadInfo = `r=${r}m（${rp.decidedBy}）· 0 条（已量）`;
        return;
      }
      /* 🧱 **并进同一个累积仓库**（不是整份替换）：换视野/换来源都不会"新的一来旧的没了" */
      roadsStore.merge(feats as unknown as BundleRoadFeature[], `live:${key}`);
      roadsFlush("live");
      /* `worldMapApi.roads()` 只解包 `geojson`（与 buildings 同一个壳），
         统计在**原始信封**里 ⇒ 这里显式放宽类型读一次；拿不到就给 null（HUD 会少一行统计，
         但**不会**编一个数字出来）。 */
      stats.roadNote = roadStatsLine((geo as { stats?: Record<string, unknown> } | null)?.stats ?? null);
      liveRoadInfo = `r=${r}m（${rp.decidedBy}${rp.limitWhy ? `，策略本想要 ${rp.want}m` : ""}）· ${feats.length} 条 · live 第 ${liveRoadHits} 条`;
    } catch (e) {
      const why = String((e as Error)?.message || e || "后端没响应").slice(0, 60);
      liveRoadInfo = `r=${r}m（${rp.decidedBy}）· 失败：${why} · 已试 ${roadTries} 次`;
      stats.note = stats.note ? `${stats.note} · 路网取不到（${why}，已试 ${roadTries} 次）` : `路网取不到（${why}，已试 ${roadTries} 次）`;
    }
  }
  /** 最近一次 live 取路的实况（面板回证；离线路走 `stats.roadStore` 那一行） */
  let liveRoadInfo = "";

  /* ── 🏪 设施（`/api/facilities`）→ MapLibre 圆点 ────────────────────────────
     机主 2026-09-20：「在地图上把**道路和设施**全部勾出来（方便将行人啥的挪出来）」。
     以前设施由旧的 DOM 层画（`WsFacilityLayer`），而那层在
     `districtUnderlayVisible=false` 的 `v-if` 里 ⇒ **小区级根本看不到**。
     这里把它迁到地图上（同一条渲染通路，缩放/倾斜/遮挡全都自洽）。

     🔴 坐标口径（这是最容易搞错的一步）：`/api/facilities` 给的是
     `gx/gy`（28×28 网格）+ **`cell_meters`（实测 30m）** ⇒ 它描述的是
     **28×30 = 840m 的一块街区**，不是整个区县。
     所以映射是「**以地图中心为原点的 840m 方格**」——
     要是像 AI 示意层那样铺到**区县 bbox**（几十公里）上，一格就是好几公里，
     又变成"一栋楼几百米宽"那类**尺度错**（那个坑已经踩过一次）。
     ⚠️ 由此**设施点是"示意布局"不是实测位置**，HUD 必须这么写（见 `facNote`）。

     ⚠️ 名称标注做不了：`symbol` 图层的 `text-field` **必须有 `glyphs`（字体服务）**，
     而我们的样式是**故意不带 glyphs** 的（引字体＝多一个外部依赖 + 多一次跨域）。
     所以名字走 HUD 的 `title`（悬停可看），地图上只画**分类配色**的圆点。 */
  const FAC_COLOR_FALLBACK = "#9fb4c8";

  /** 网格 → 经纬度（以 `center` 为原点的局部平面；网格 y 向下、纬度向北 ⇒ 要翻） */
  function facLngLat(gx: number, gy: number, center: [number, number], cellM: number, grid: number): [number, number] {
    const [cx, cy] = toXY(center, center[1]);
    const x = (gx + 0.5 - grid / 2) * cellM;
    const y = (grid / 2 - (gy + 0.5)) * cellM;
    return toLngLat([cx + x, cy + y], center[1]);
  }

  async function loadFacilities(m: BldMapLike): Promise<void> {
    if (!alive) return;
    const c = m.getCenter();
    const center: [number, number] = [c.lng, c.lat];
    try {
      const raw = await withTimeout(
        facilitiesAuto({
          area: props.area,
          size: 28,
          /* 种子**必须稳定**（后端注释里写死的约定）：传 `hash32(area)` ⇒ 刷新后设施位置不变。
             用随机种子的话每次刷新设施都搬家，玩家会以为地图坏了。 */
          seed: hash32(props.area || "ws"),
          level: "district",
        }),
        15000
      );
      if (!alive) return;
      const items = [...(raw?.facilities || []), ...(raw?.transport || [])] as unknown as Array<Record<string, unknown>>;
      const grid = Math.max(2, Number(raw?.grid) || 28);
      const cellM = Number(raw?.cell_meters) || 30;
      const feats = items
        .map((it) => {
          const gx = Number(it.gx);
          const gy = Number(it.gy);
          if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
          const col = Array.isArray(it.color) && it.color.length >= 3
            ? `rgb(${Number(it.color[0])},${Number(it.color[1])},${Number(it.color[2])})`
            : FAC_COLOR_FALLBACK;
          return {
            type: "Feature" as const,
            properties: {
              id: String(it.id || ""),
              name: String(it.name || ""),
              type: String(it.type || ""),
              typeZh: String(it.type_zh || ""),
              icon: String(it.icon || ""),
              group: String(it.group || "life"),
              color: col,
            },
            geometry: { type: "Point" as const, coordinates: facLngLat(gx, gy, center, cellM, grid) },
          };
        })
        .filter(Boolean);
      if (!feats.length) {
        stats.facNote = "设施：后端没有返回点位（如实说明，不编）";
        return;
      }
      const data = { type: "FeatureCollection", features: feats };
      if (m.getLayer("fac-dot")) {
        (m.getSource("fac") as { setData(d: unknown): void } | undefined)?.setData(data);
      } else {
        m.addSource("fac", { type: "geojson", data });
        /* 插在注记层之前（设施点不该盖住街名） */
        const before = m.getLayer("ref") ? "ref" : undefined;
        m.addLayer(
          {
            id: "fac-dot",
            type: "circle",
            source: "fac",
            /* 低 zoom 只留"主干类"（生活必需 + 交通节点）—— 整区视野下 43 个点会糊成一片 */
            minzoom: 13.2,
            filter: ["in", ["get", "group"], ["literal", ["life", "transport"]]],
            paint: {
              "circle-color": ["get", "color"],
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.2, 3, 15, 5, 17, 7],
              "circle-stroke-color": "#0b1017",
              "circle-stroke-width": 1.2,
              "circle-opacity": 0.95,
            },
          },
          before
        );
      }
      const byType: Record<string, number> = {};
      for (const f of feats) {
        const t = String((f as { properties: Record<string, unknown> }).properties.typeZh || "其他");
        byType[t] = (byType[t] || 0) + 1;
      }
      stats.facilities = feats.length;
      const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);
      /* ⚠️ 必须写"示意布局"：这些点的经纬度是**按 840m 方格摊出来的**，不是实测位置 */
      stats.facNote = `${feats.length} 个（示意布局 ${grid}×${cellM}m 方格）：${top.map(([k, v]) => `${k}${v}`).join(" ")}`;
    } catch {
      stats.facNote = "设施取不到（后端没响应或超时）";
    }
  }

  /**
   * 「像高德那样」的第二半：**放大到街区再取楼**，而且**取少了会自动放大再试**。
   *
   * 三步：
   *   ① 半径从**当前视野**算（见 `radiusForView`）；
   *   ② 楼太少（< `BLD_ENOUGH`）就翻倍再试一次，最多爬到 `BLD_R_MAX`，**命中即停**；
   *   ③ 全都试完还是空 ⇒ **如实写进 HUD**（试过哪些半径），绝不静默 ——
   *      静默正是"HUD 常显示 🏢 0 却没人知道为什么"的成因。
   *
   * ⚠️ 为什么要封顶（现在是 2000m）：**实测**（同一后端）
   *   · 涪陵驻地 400m→0 栋、600m→3、900m→18、1000m→21、1400m→29、**2500m→取不到**；
   *   · 渝中区驻地 400m→56、800m→232、**1200m→查询直接失败（Overpass 拖挂）**。
   *   ⇒ 半径越大越容易整条查询失败，而失败一次要等二十几秒。宁可"多爬两级"，
   *     也不要一次性甩一个 2500m 出去（那是**更慢而且更容易什么都没有**的选择）。
   *   2000m 是"实测能返回的里面最大的那一档"（涪陵 2000m→29 栋），再大就到失败区了。
   *
   * 同一个"中心+半径"不重复取（`lastBldKey`），避免拖动时把 Overpass 打爆。
   */
  async function loadBuildingsForView(m: BldMapLike): Promise<void> {
    if (!alive) return;
    /* 🔴 **默认根本不打 live**（offline-first）：决策在真源 `wsScene.bldLiveDecision()`
       —— 现场一次只覆盖 R≤2000m 且冷查 27~33s（最慢 91.7s），所以默认 0 条，楼从**离线楼房包**来；
       `?live=1` 才走这条（补新区域/调试），失败照旧**可见**。 */
    if (!bldLive.live) return;
    const z = m.getZoom();
    if (z < BLD_MIN_ZOOM) {
      stats.view = "全区视野";
      return;
    }
    const c = m.getCenter();
    /* 半径与阶梯**都由真源给**（`fetchRadiusForView` / `fetchRadiusLadder`，2km 起、封顶 8km）；
       后端单查还有硬闸 2000m ⇒ 每一级**夹一次**并把差异写进面板（策略要多少 / 源给不了多少）。 */
    const rp = liveRadiusFor(m);
    const r0 = rp.radius;
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r0}`;
    if (key === lastBldKey) return;
    lastBldKey = key;
    liveBldHits += 1; // 可数口径：这一轮真的发了一条 `/api/buildings`

    const ladder = fetchRadiusLadder(z, rp.halfM);
    const asks: number[] = [];
    for (const r of ladder) {
      const a = Math.min(r, WS_FETCH_R_BACKEND_MAX);
      if (asks.indexOf(a) < 0) asks.push(a);
    }
    const tried: number[] = [];
    /** 一路记着"目前最好的一份"：后面某一级失败/更少时，不至于把手上的楼丢掉 */
    let best: { feats: BldFeature[]; r: number } | null = null;
    let failed = false;
    for (let i = 0; i < asks.length; i++) {
      const r = asks[i]!;
      tried.push(r);
      try {
        const geo = await withTimeout(worldMapApi.buildings({ lat: c.lat, lng: c.lng, r }), 25000);
        if (!alive) return;
        const feats = (geo?.features || []) as BldFeature[];
        if (feats.length > (best?.feats.length ?? 0)) best = { feats, r };
        if (feats.length >= BLD_ENOUGH) break; // 够看了，别再花时间
      } catch {
        failed = true;
        /* 这一级没拿到（超时/后端抖）就试下一级 —— 不因为一次失败就放弃整屏 */
      }
    }

    let features: BldFeature[] = best?.feats ?? [];
    if (!alive) return;
    if (!features.length) {
      /* 🔴 空结果**必须说出来**：不然就是"看起来卡住了/什么都没有" */
      stats.view = "街区视野";
      stats.note = failed
        ? `楼房数据取不到（已试 ${tried.join("/")}m）`
        : `OSM 在这一带没有登记楼房（已试 ${tried.join("/")}m）`;
      /* OSM 一栋都没有 = 最稀疏的情况 ⇒ 交给第二源补（拿不到就只留上面那句实话） */
      const fill0 = await overtureFill(c.lat, c.lng, best?.r ?? r0, 0);
      if (!alive || !fill0?.features.length) {
        liveBldInfo = `r=${r0}m（${rp.decidedBy}）· 0 栋（已量，试过 ${tried.join("/")}m）`;
        return;
      }
      liveBldInfo = `r=${r0}m（${rp.decidedBy}）· Overture 补缺 ${fill0.features.length} 栋`;
      bldStore.merge(fill0.features as unknown as BundleBuildingFeature[], `live:fill:${key}`);
        bldFlush("live-fill");
      stats.note = `${stats.note} · ${fill0.note}`;
      return;
    }
    /* 🆕 第二源补缺：OSM 不够看时才问（够看的地方一次网络都不发） */
    let fillNote = "";
    if (shouldAskSecondSource(features.length, BLD_SPARSE)) {
      /* 先如实说"正在补"，别让人对着不动的画面猜（这一问冷启动要十几秒） */
      stats.note = `真楼只有 ${features.length} 栋，正在取 Overture 补缺…`;
      const fill = await overtureFill(c.lat, c.lng, best!.r, features.length);
      if (!alive) return;
      if (fill?.features.length) {
        const mg = mergeBuildingSources(features, fill.features);
        features = mg.features as typeof features;
        fillNote = `${fill.note}（去重 ${mg.dropped}）`;
      } else {
        fillNote = "Overture 补缺不可用（只用 OSM）";
      }
    }
    /* 🧱 **并进同一个累积仓库**（不是整份替换）：live 与离线包走同一条落图通路（一次 `setData`） */
    bldStore.merge(features as unknown as BundleBuildingFeature[], `live:${key}`);
    bldFlush("live");
    liveBldInfo = `r=${r0}m（${rp.decidedBy}${rp.limitWhy ? `，策略本想要 ${rp.want}m` : ""}）· ${features.length} 栋 · live 第 ${liveBldHits} 条`;
    stats.view = "街区视野";
    const sparse = best!.feats.length < BLD_ENOUGH ? `楼房稀疏：半径已放大到 ${best!.r}m（试过 ${tried.join("/")}m）` : "";
    stats.note = [sparse, fillNote].filter(Boolean).join(" · ");
  }
  /** 最近一次 live 取楼的实况（面板回证；离线路走 `stats.bldBundle` 那一行） */
  let liveBldInfo = "";
  /**
   * "够看"的楼栋数（**只在 `?live=1` 这条兜底路里用**）：一屏想看到"成片"至少得有这么几栋，
   * 不到就沿阶梯放大再试一级。25 与代拍页 `loadForView` 里那个 `>= 25` **同值**（自检对拍）。
   * ⚠️ 默认路径（离线包）**不看这个数**：包里有多少画多少，格子按视野取。
   */
  const BLD_ENOUGH = 25;

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
  /** live 取数打了几条（**默认应当是 0**；`?live=1` 才是 1）—— 面板/自检的可数口径 */
  let liveBldHits = 0;
  let liveRoadHits = 0;

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

  /** 浏览器取数（每格**独立超时**；AbortController 在 `wsOfflineFeed.fetchWithTimeout` 里） */
  const fetchCell = (url: string, timeoutMs: number) =>
    fetchWithTimeout((u: string, init?: { signal?: AbortSignal }) => fetch(u, init), url, timeoutMs);

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
    flushBldStore<BundleBuildingFeature>(
      {
        features: () => bldStore.features(),
        /* 上妆（高度/颜色/拆件）在这里做**一次** ⇒ HUD 的计数与画出去的是同一批要素 */
        dress: (feats) => dressBld({ features: feats as unknown as BldFeature[] }),
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
        /* 🏙 **近景挑选 = 与代拍页同一份编排**（`wsBldPickStore`：**按格挑 + 按格冻结 + 视野补齐**）。
           🔴 2026-09-26 改（机主真机「**每次滑动建筑都变了**」）：原来这里是
           `pickNearView` → `pickBuildingsForView`（**按视野**挑、**没有冻结**）⇒ 视野一变那批楼就换了一批，
           而代拍页早就是"按格挑 + 按格冻结"那套 ⇒ 两页不是一个东西。现在两页调**同一个** store。
           近景才挑（远景走预渲染瓦片，挑它没意义）—— 阈值与楼房矢量层**同一个共享常量**。 */
        pick: (() => {
          try {
            const z = map ? map.getZoom() : null;
            if (z === null || z < WS_BLD_VECTOR_MINZOOM) return null;
            const store = bldPickStore();
            if (!store) return null;
            /* 一轮只读一次（与代拍页 `BLDCELL`/`BLDN` 同一口径）：保证"冻结键 / 挑选 / 分组"三者同值 */
            const cellDeg = bldCellDegNow();
            const cap = bldCapForCellDeg(cellDeg, WS_BLDN_PIN);
            return (feats: readonly BundleBuildingFeature[]) => store.pick({
              features: feats as unknown as PickFeature[],
              cap,
              cellDeg,
              bounds: map ? (map.getBounds() as unknown as PickBounds) : null,
              minInView: WS_BLD_INVIEW,
            }) as unknown as { features: readonly BundleBuildingFeature[]; stats: BldPickStats };
          } catch { return null; }
        })(),
        onPicked: (s) => { bldPickWhy = s.why; try { renderBundleHud(); } catch { /* HUD 失败不影响落图 */ } },
        beforeDraw: (why0) => {
          bldFlushWhy = why0;
          renderBundleHud();
        },
      },
      why
    );
  }
  /** 上一次 flush 的原因（面板回证：是离线包来的还是 live 来的） */
  let bldFlushWhy = "";
  /** 🏙 上一次"近景挑楼"的口径（机主要 100 栋/视野）——面板回证用，没挑过就是空串 */
  let bldPickWhy = "";

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
            renderBundleHud();
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

  function labClassOf(style: NameRenderNode["style"]): string {
    return style === "real" ? "is-real" : style === "derived" ? "is-derived" : "is-generated";
  }
  /** 容器 class（相机运动 / 换批 / 整层降级）—— 类名来自真源常量，宿主不写字面量 */
  const labRootClass = computed(() => ({
    [LABEL_CAMERA_CLASS]: cameraMoving.value,
    "is-switching": switching.value,
    "is-lite": namePlan.value.lite,
  }));

  /**
   * 把**渲染计划**落到 DOM。🔴 两条纪律：
   * ① **位置只在此时写一次**（`translate3d`），相机运动期间一个字都不许再写节点；
   * ② **先隐后改字**：如果这一批的"名字集合"变了 ⇒ 先进 `switching`（整层 opacity→0，120ms），
   *    等它真的看不见了才换 `nameNodes`，然后退出去（区名 200ms 进场）。
   *    绝不允许"看着旧名字变成新名字"（那是最廉价的一种观感）。
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
    switching.value = true;
    switchTimer = window.setTimeout(() => {
      switchTimer = 0;
      if (!alive) return;
      commit(true);                                 // ← 换字发生在整层看不见的那一帧
    }, LABEL_MOTION.nameOutMs);
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

  /** 点**楼体**（地图上的挤出层）—— 与点标签弹**同一张卡** */
  function onMapClick(e: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number }; features?: unknown[] }): void {
    try {
      const m = map as unknown as { queryRenderedFeatures?: (p: unknown, o?: unknown) => Array<{ properties?: Record<string, unknown>; id?: unknown }> } | null;
      const pt = e?.point;
      let feats: Array<{ properties?: Record<string, unknown>; id?: unknown }> = [];
      if (m?.queryRenderedFeatures && pt) {
        try { feats = m.queryRenderedFeatures(pt, { layers: ["bld-ext"] }) || []; } catch { feats = []; }
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
     ⚠️ 只在**平移**（pan）时这么做；旋转/俯仰不是平移，那时整层淡到 0.25 就够（§4.2）。 */
  let panAnchor: { lng: number; lat: number; x: number; y: number } | null = null;
  function onMoveStart(): void {
    if (!namesOn.value || !nameNodes.value.length) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    const n0 = nameNodes.value[0];
    if (!m?.project || !n0) return;
    const p = m.project([n0.lng, n0.lat]);
    if (!p) return;
    panAnchor = { lng: n0.lng, lat: n0.lat, x: p.x, y: p.y };
    cameraMoving.value = true;                           // 一次 class + 一次 opacity（**只写 1 个节点**）
  }
  function onMove(): void {
    if (!panAnchor || !cameraMoving.value) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    if (!m?.project) return;
    const p = m.project([panAnchor.lng, panAnchor.lat]);
    const el = labRootEl.value;
    if (!p || !el) return;
    /* 🔴 一次 transform 写在一个容器上（O(1)），**不是** N 个节点 —— 这就是"不卡"的全部秘密 */
    el.style.transform = `translate3d(${(p.x - panAnchor.x).toFixed(2)}px, ${(p.y - panAnchor.y).toFixed(2)}px, 0)`;
  }
  function onMoveEndNames(): void {
    cameraMoving.value = false;
    panAnchor = null;
    const el = labRootEl.value;
    if (el) el.style.transform = "translate3d(0, 0, 0)";   // 节点自身已经是新位置 ⇒ 容器归零
  }

  /** HUD/面板那一行（**可数口径只有一份**：`wsOfflineFeed.bundleCountsLine`）
   *  · `stats.bldBundle/roadsBundle` = 机主看的**可数一行**（已取/包外/失败 + 仓库数）；
   *  · `stats.bldVerdict/roadsVerdict` = **真源判词**（三态：包外 / 取数失败 / 正常；数不出来照实写）。 */
  function renderBundleHud(): void {
    const bf = bldFeed.facts();
    const rf = roadsFeed.facts();
    stats.bldBundle = bundleCountsLine(bf, "🏢", "栋");
    stats.roadsBundle = bundleCountsLine(rf, "🛣", "条");
    stats.bldVerdict = bldVerdictText({ state: bldVerdictState(bf), n: bf.n, cells: bf.have, cap: bf.cap });
    stats.roadsVerdict = roadsVerdictText({ state: roadsVerdictState(rf), n: rf.n });
  }

  /**
   * 按视野补离线格（**后台、串行、每格独立超时**；一次最多 2 格，不堵首屏）。
   * 楼/路/水绿各一条管道，三条互不阻塞；**都不打 `/api/*`**。
   */
  async function refreshBundles(why = "view"): Promise<void> {
    const m = map as BldMapLike | null;
    if (!m) return; // 地图还没建（或 2D 降级路）⇒ 没有视野可算，管道如实不取
    const z = m.getZoom();
    /* 阈值与实时层对齐（楼 z≥13.5、路 z≥12）：整区视野下楼是亚像素，取它只是白花流量 */
    if (z >= BLD_MIN_ZOOM) await bldFeed.refresh(why);
    if (z >= ROAD_MIN_ZOOM) await roadsFeed.refresh(why);
    /* 🌊🌳 水/绿地**不设 zoom 闸门**（远景下它才最有用；判词由真源回填 `stats.gwVerdict`） */
    await gwLayer.refresh(why);
    renderBundleHud();
  }

  /**
   * 📦 **取一个包的署名原句** —— **目录由 feed 的候选表决定**，这里不许自己拼路径。
   *
   * 🔴 2026-09-26 修的真 bug：这里原来三处**直连** `loadBundleIndex(fetchCell, kind)`（不传 dir）
   * ⇒ 它只用 `spec.dir`（**老包目录那一个**），而**页面走的是 feed 的候选表**
   * （`bldbundle-002` 细格包在前、退回 `bldbundle`）。
   * ⇒ 后果：**老包一删，App 会"署名取不到"而页面正常**（署名是 ODbL 合规项，不能少）。
   *
   * 现在：① 先读 feed 自己已经读到的索引事实（`facts().index.attribution`，它走的就是候选表，已读 ⇒ 零请求）；
   *      ② feed 还没读（首屏 `refreshBundles` 与署名是**并发**的）⇒ 按 **feed 给出的候选表**
   *         （`facts().dirs`）逐个目录试读 —— 顺序与 feed 完全一致，**不在这里写第二份目录名单**。
   */
  async function attributionOfFeed(
    feed: { facts(): { dirs?: string[]; index: { attribution: string | null } } },
    kind: string
  ): Promise<string> {
    try {
      const a = feed.facts().index.attribution;
      if (a) return a;
    } catch { /* 落 ② */ }
    let dirs: string[] = [];
    try { dirs = feed.facts().dirs || []; } catch { dirs = []; }
    for (const d of dirs) {
      try {
        const f = await loadBundleIndex(fetchCell, kind as never, d);
        const a = f.attribution || f.source;
        if (a) return a;
      } catch { /* 试下一个目录 */ }
    }
    return "";
  }

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
     所以这里在 **JS 层再拦一次**：`touchmove` 一律 preventDefault（被动监听是拦不住的，
     必须 `{ passive: false }`），多指 `touchstart` 也拦。注意 preventDefault **不会**
     阻止地图库自己的监听器 —— 它只掐掉浏览器的默认行为。 */
  function guardGestures(el: HTMLElement): () => void {
    const onMove = (e: TouchEvent): void => {
      if (e.cancelable) e.preventDefault();
    };
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchstart", onStart, { passive: false });
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchstart", onStart);
    };
  }
  let unguard: (() => void) | null = null;

  /* ── 页面级手势封锁（机主诊断：滑动不足 0.3 秒就被浏览器捕获）────────────────
     这条现象说明：触摸**开始时确实到了地图**，但滑到约 300ms 时被**浏览器页面级手势**
     （侧滑返回 / 页面滚动 / 下拉刷新）判走了。只在地图元素上写 `touch-action` 挡不住它
     —— 必须在**根元素**上临时声明"这一屏不做任何页面手势"，否则浏览器的手势识别器
     照样在系统层抢先。离开小区级时**原样还原**（别污染其它页面）。 */
  let htmlTouchBackup: { touchAction: string; overscroll: string; overflow: string } | null = null;
  function lockPageGestures(): void {
    try {
      const el = document.documentElement;
      htmlTouchBackup = { touchAction: el.style.touchAction, overscroll: el.style.overscrollBehavior, overflow: el.style.overflow };
      el.style.touchAction = "none";
      el.style.overscrollBehavior = "none";
      el.style.overflow = "hidden";
    } catch {
      /* 拿不到根元素就算了（不该发生） */
    }
  }
  function unlockPageGestures(): void {
    if (!htmlTouchBackup) return;
    try {
      const el = document.documentElement;
      el.style.touchAction = htmlTouchBackup.touchAction;
      el.style.overscrollBehavior = htmlTouchBackup.overscroll;
      el.style.overflow = htmlTouchBackup.overflow;
    } catch {
      /* 忽略 */
    }
    htmlTouchBackup = null;
  }

  /**
   * 兜底：放弃地图库，改用 Canvas2D 画俯视图 + DOM 钉子画人。
   *
   * **三条路共用一份**（无 WebGL / 地图库加载失败 / **地图库起来了但 `load` 一直不来**）：
   * 写三遍迟早漂移；而第三条**以前根本不存在** ——
   * 结果是玩家永远停在「初始化…」：没有楼、没有人、没有解释，只有一行小字。
   * （2026-09-19 实测：无头环境下 `hasWebGL()` 返回真、`new Map()` 也成功，
   *  但 `load` **永远不触发** ⇒ HUD 就卡在初值。这正是"能玩"闸门第③条挂掉的原因。）
   */
  function fallback2d(
    mode: string,
    fc: { features?: BldFeature[] } | null,
    why = "",
    kind: "temp" | "perm" = "perm"
  ): void {
    stats.mode = mode;
    mapAvailable.value = false;
    /* 🔴🔴 **这条是本次 fps 修复的核心一行**（2026-09-20）：
       走到这里 = 我们已经确定在用 **Canvas2D 软渲染**（不管是因为探针说没 WebGL、
       地图库加载失败，还是地图库 `load` 一直不来被看门狗砍掉）。软渲染天生重 ——
       实测小区级只有 7fps。
       而**档位判定此前完全不知道这件事**：它只看核数/内存/WebGL 探针，于是
       "页面在跑最重的路、档位还是高档"，雨/雪、小地图、头像、车辆全套满血跑。
       ⇒ 谁降级，谁负责把档位压下去（**因果**，不是**预测**）。
       用 `perf.low` 的地方会自动跟着变：`ws-perf-low` 类、天气层、车辆/行程卡全部生效。 */
    perf.forceLow(mode);
    /* HUD 上如实写清两件事：**为什么被压到低档** + **2D 画布的 DPR 封顶**
       （机主的三个症状里"很卡"就是这条路的填充率；写出来他才看得出我们为此做了什么） */
    stats.perf = `已因「${mode}」压到低档（2D 画布 DPR 封顶 ${dprCap2d()}，真机 dpr=${typeof devicePixelRatio === "number" ? devicePixelRatio : "?"}）`;
    /* 🔴 **降级前必须换一块新画布**：`cv` 可能已经被 WebGL 占过（MapLibre 在它上面建了
       webgl 上下文），而按 HTML 规范，`canvas.getContext("2d")` 在**已经有 webgl 上下文**
       的画布上会返回 `null` ⇒ `draw2d()` 里 `if (!ctx) return;` 直接**静默不画**。
       症状："已经降级了，HUD 也说了原因，但画布是**空白**的"，而且**零报错**。
       （同一张画布不能有两种上下文，这是规范行为，不是 bug —— 但极容易踩。） */
    const oldCv = cv.value;
    const hostEl = host.value;
    /* 🔴 P0：**临时类降级不换画布、也不销毁地图** —— 直接在原来那块上面**盖**一块新的 2D 画布。
       为什么这样就绕开了"一个 canvas 不能同时有 webgl 和 2d 上下文"这条规范限制：
       **2D 画的是另一块 canvas**，WebGL 那块原封不动留在 DOM 里（只是藏起来），
       MapLibre 继续拿它渲染 ⇒ 它一出帧，把上面这块摘掉、把下面那块显示回来 = **切回 WebGL**
       （零重建、零换画布、相机与图层全都在）。这正是上一轮写在注释里"列入未做"的那件事。 */
    const keepAlive = kind === "temp" && !!map && !!oldCv;
    fallbackKind.value = kind;
    if (keepAlive) {
      try {
        (oldCv as HTMLCanvasElement).style.visibility = "hidden";
        (oldCv as HTMLCanvasElement).style.pointerEvents = "none";
      } catch {
        /* 样式写不上也不影响"盖一块新的"这件事 */
      }
    }
    /* 两种都要新建一块：
       ① 旧画布拿不到 2D 上下文（它被 WebGL 占过）；
       ② **旧画布压根不存在**（WebGL 路下模板那块被 `v-if` 关掉了）—— 这一条是这次加上的，
          少了它，降级路会"什么都不画"（`draw2d` 里 `if (!c) return`）且**零报错**。 */
    if (!oldCv || !oldCv.getContext("2d")) {
      show2d.value = true; // 让 `v-if` 打开（下一帧生效；这一帧我们直接用新建的这块）
      const fresh = document.createElement("canvas");
      /* ⚠️ 要连**所有属性**一起搬（`class` 之外还有 Vue 的 scoped 标记 `data-v-xxxx`）——
         漏了它，新画布就丢掉了 `position:absolute; width:100%; height:100%`，
         会缩回浏览器默认的 300×150 跑到左上角：**又是一次"降级了但看着是坏的"**。 */
      /* 旧画布在不在都要能走通：不在就照**模板那块的类名**补上（`ws-dml__cv` 的定位/铺满规则靠它） */
      if (oldCv) for (const at of Array.from(oldCv.attributes)) fresh.setAttribute(at.name, at.value);
      else fresh.className = "ws-dml__cv";
      if (keepAlive && oldCv?.parentElement) {
        /* 盖在**上面**（`afterend`）：下面那块 WebGL 画布继续存在、继续渲染，只是看不见 */
        oldCv.parentElement.insertBefore(fresh, oldCv.nextSibling);
        fresh.classList.add("ws-dml__cv--2d");
      } else if (oldCv?.parentElement) {
        oldCv.replaceWith(fresh);
      } else if (hostEl) {
        /* `map.remove()` 会把画布**从 DOM 里摘掉**（我们把它交给了地图库管），
           这时 `replaceWith` 是空操作 ⇒ 必须自己插回去，否则又是"画在一块不在页面上的画布"。 */
        hostEl.insertBefore(fresh, hostEl.firstChild);
      }
      cv.value = fresh;
    }
    stats.pins = domPins.value.length;
    if (why) stats.note = stats.note ? `${stats.note} · ${why}` : why;
    draw2d(fc);
    phase.value = "done";
    stopTimer();
    /* 临时类：**后台继续等它出帧**，出来了就切回 WebGL（每 4 秒看一次，见 `startRecoverPoll`） */
    if (keepAlive) startRecoverPoll();
    /* 🧪 App 自拍：**降级路更要拍** —— "整屏纯色"那类事故就发生在这条路上（闸门只跑这条路，
       所以这条路正是"agent 以为验过了"的那条）。`why` 原样带进诊断图，别让图上写着"2D"却没有原因。 */
    maybeAppSelfShot("fallback2d", why || "未说明原因");
  }

  /**
   * fps 采样（滚动 1 秒窗口，与项目其它地方同一口径）。
   *
   * ⚠️ **必须在"分渲染路"之前启动**：以前它写在 WebGL 路的末尾 ⇒
   * 降级路（2D）的 HUD 永远显示 `0 fps`，看起来像"卡死了"，其实是没人在数。
   * 数字本身也更有意义 —— 它量的是**这个页面**的帧率，不是某条渲染路的。
   */
  function startFps(): void {
    let last = performance.now();
    let frames = 0;
    let win = 0;
    const tick = (now: number) => {
      if (!alive) return;
      const dt = now - last;
      last = now;
      frames++;
      win += dt;
      if (win >= 1000) {
        stats.fps = Math.round((frames * 1000) / win);
        frames = 0;
        win = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

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
    timer = window.setInterval(() => {
      waited.value = Date.now() - t0;
    }, 200);
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
      try {
        if (lat !== undefined && lng !== undefined) throw new Error("skip-ip");
        const loc = await worldMapApi.location({ fast: true });
        if (Number.isFinite(loc?.lat) && Number.isFinite(loc?.lng)) {
          lat = Number(loc.lat);
          lng = Number(loc.lng);
        }
      } catch {
        /* 定位拿不到：保持 undefined，让后端兜底（与原来行为一致） */
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
      /* 失败原因**原样留下**（HUD/面板都要写它 —— 原来只有一句"后端没响应"，看不出是超时还是 500） */
      bldFailedWhy = String((e as Error)?.message || e || "未知原因").slice(0, 60);
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
        ? `楼房取不到（${bldFailedWhy || "后端没响应"}，已试 ${bldTries} 次 · 半径 ${triedRs.join("m 与 ")}m）`
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
      fallback2d("2D 降级（无 WebGL）", fc);
      return;
    }
    phase.value = "render";

    /* ⚠️ **必须用变量间接**：写成字面量 `import("/vendor/...")` 会让 TS 去解析这个路径
       （`TS2307: Cannot find module`），而它在运行时是 public/ 下的静态文件、根本没有类型。
       用变量之后 TS 不再解析（`any`），Vite 也不参与（public/ 原样发布）—— 两边都干净。 */
    const ML_URL = "/vendor/maplibre/maplibre-gl.mjs";
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
      fallback2d("2D 降级（地图库加载失败）", null, `vendor/maplibre 加载失败：${why || "（无 message）"}`);
      return;
    }
    mlMod = maplibregl; // Marker 在它身上，setup 作用域的 syncPins 要用
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
      pitch: props.pitch || cameraDefaults().pitch,
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
          m.fitBounds(b as never, { padding: 24, pitch: props.pitch, duration: 0 });
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
          m.jumpTo({ center: c, zoom: 16.4, pitch: props.pitch, bearing: 0 } as never);
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
      emit("scene-ready", { map: m, buildings: (fc as { features?: unknown[] } | null) || null });
      /* 代拍：`?autoshot=1` 开了开关才跑，没开就是一次 boolean 判断（零开销） */
      if (selfShotArmed()) void runSelfShot(m as unknown as Parameters<typeof runSelfShot>[0]);
      /* 🧪 App 自拍（`?selfshot=1`）：这是 **WebGL 路**的触发点（降级路的在 `fallback2d` 末尾） */
      maybeAppSelfShot("webgl");
    });

    /* 🏷🗺 **名字层的相机联动**（`DESIGN-MG-MOTION.md` §4.0/§4.2 —— 这一段的每一条都是红线）
       · `movestart`：容器加 `is-camera-moving`（**一次 class + 一次 opacity**，整层 1 → 0.25）；
       · `move`（每帧）：**只写 1 个容器**的 `translate3d`（跟手），N 个节点一个字都不写；
       · `moveend`：容器归零 + 节点位置**批量重排一次**（在 `refreshNames` 里）；
       · `click`：点楼体 ⇒ 与点名字**同一张卡**（`queryRenderedFeatures` 拿不到时走"最近已画楼"降级）。 */
    m.on("movestart", () => { onMoveStart(); });
    m.on("move", () => { onMove(); });
    m.on("click", (e: unknown) => { onMapClick(e as { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } }); });

    /* 视野变化 → 按需补数据（去抖 600ms，避免拖动时把后端/磁盘打爆）。
       · **默认**：只补**离线格**（静态文件 ⇒ 不打 Overpass；换视野要素数**不减**：并进累积仓库）；
       · `?live=1`：另外走现场取数（楼/路各一条），失败照旧**可见**。 */
    m.on("moveend", () => {
      /* 🔴 容器位移**必须**在这里归零：节点自身马上要被写成新位置，容器再留着旧位移就是"错位"
         （机主真机报过的「名字显示是滑动刷新一次，不能跟随，**错位严重**」就是这一层没对齐）。 */
      onMoveEndNames();
      if (bldTimer) window.clearTimeout(bldTimer);
      bldTimer = window.setTimeout(() => {
        bldTimer = 0;
        void refreshBundles("move").then(() => (alive ? refreshNames("move") : undefined));
        if (bldLive.live) void loadBuildingsForView(m as unknown as BldMapLike);
        if (roadsLive.live) void loadRoadsForView(m as unknown as BldMapLike);
      }, 600);
    });
    /* 缩放结束也要重排：zoom 变了 ⇒ 避让网格的候选/撞掉**全变**（区名模式的迟滞信号就是它） */
    m.on("zoomend", () => {
      onMoveEndNames();
      if (zoomNameTimer) window.clearTimeout(zoomNameTimer);
      zoomNameTimer = window.setTimeout(() => { zoomNameTimer = 0; if (alive) void refreshNames("zoom"); }, 160);
    });

    /* fps 计数已提到 `startFps()`（在"分渲染路"之前启动，降级路也有数） */
  });

  onBeforeUnmount(() => {
    alive = false;
    unguard?.();
    unguard = null;
    unlockPageGestures();
    stopTimer();
    if (bldTimer) window.clearTimeout(bldTimer);
    if (zoomNameTimer) window.clearTimeout(zoomNameTimer);
    if (switchTimer) window.clearTimeout(switchTimer);
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
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try {
      map?.remove?.();
    } catch {
      /* 已经没了就算了 */
    }
    map = null;
  });
</script>

<style scoped>
  .ws-dml {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #101820;
    /* 🔴 手势必须归地图：不写这行，浏览器会把拖动/捏合当**页面手势**吃掉
       （机主 2026-09-19：在 mock 网页里"无法捕捉手势，只能被浏览器捕捉"）。
       与老舞台 `.ws-geo__inner` 同一口径 —— 新组件漏了这条，就是那次事故的原因。 */
    touch-action: none;
    overscroll-behavior: contain;
  }
  /* ⚠️ canvas 是替换元素（默认 300×150），只给 inset 不会拉伸 → 必须显式 100% */
  .ws-dml__cv {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none; /* canvas 自己也要声明（它才是触点真正落在的元素） */
  }
  .ws-dml__zoom {
    position: absolute;
    right: 10px;
    bottom: 120px;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ws-dml__zoom button {
    /* 自保：不参与祖先的任何 pointer-events 继承，且明确可点 */
    pointer-events: auto;
    touch-action: manipulation;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 12px;
    background: rgba(10, 16, 24, 0.72);
    color: #fff;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    /* 同上：低档关掉模糊（3 个按钮 × 40px，代价比 HUD 小，但没理由留着） */
    backdrop-filter: blur(var(--ws-blur-low, 8px));
    -webkit-backdrop-filter: blur(var(--ws-blur-low, 8px));
  }
  .ws-dml__pins {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
  }
  .ws-dml__pin {
    position: absolute;
    width: 24px;
    height: 24px;
    margin: -12px 0 0 -12px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-style: normal;
    font-weight: 600;
    color: #06222e;
    background: #cfe8f5;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
  }
  .ws-dml__pin.is-me {
    background: #79d9ff;
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
  }
  .ws-dml__pin.is-aff {
    outline: 2px solid #ffd28a;
  }
  .ws-dml__hud {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    /* 🆕 2026-09-26（机主真机/浏览器截图报「HUD 挤成一团、文字互相压」）：
       原来这里**没有 `flex-wrap`、也没给子项 `flex-shrink: 0`** ——
       一行塞不下时浏览器会把每一格**压到内容宽度以下**，文字就溢出自己的盒子、
       和邻格**互相压**（截图里「初 00 1 18 73」「失败 633 0」这种就是溢出不是两个数）。
       修法两条（都只是"别压"和"放不下就换行"，**一个信息都没删**）：
         ① 容器 `flex-wrap: wrap` + `max-width`（右边也留 8px，不许顶出屏幕）；
         ② 子项 `flex: 0 0 auto` + `white-space: nowrap`（保持原样不压缩）。
       ⚠️ 句子型的两格（告警 / AI 示意说明）单独放行换行 —— 它们可能比一屏还长，
          `nowrap` 会把它们顶出屏幕（窄屏 360px 必现）。 */
    flex-wrap: wrap;
    align-items: baseline;
    /* 🆕 2026-09-28：右边留 **60px**（原来 16px）——验证面板的 🔬 按钮在**右下角**
       （44×44 + 8px 边距 ⇒ 需要 60px）。不预留的话，HUD 会把它整块压住
       （兼容矩阵 78 格实测 `HUD ∩ 🔬 = 1440px²`，36/36 格全中）；
       现在 🔬 有 `z-index` 在对上层、可点，但**HUD 右下角那截文字会被按钮盖住** ⇒ 干脆留位。 */
    max-width: calc(100% - 60px);
    box-sizing: border-box;
    overflow: hidden;
    gap: 2px 8px;
    padding: 3px 8px;
    border-radius: 8px;
    background: rgba(10, 16, 24, 0.6);
    /* 🔴 低档必须能关掉这里的模糊（2026-09-20 实测）：
       这条 HUD 横条**一直可见**、又宽，还每秒改一次文字（fps）⇒ 它的**背景每帧都在变**
       ⇒ `backdrop-filter` 就得**每帧把背后的像素读回来重新模糊一遍**。
       有 GPU 时这是免费的；**软渲染（无 WebGL / 低端机）时这是最贵的一件事**，
       而它偏偏写在 CSS 里写死 8px ⇒ `.ws-perf-low` 根本管不到它。
       实测归因（同一次会话里逐个 display:none 对照）：整条 `.ws-dml` 值 **17fps**
       （藏掉它 22 → 39fps），而主线程的 Script/Layout/Style 加起来只有 ~5ms/秒
       —— 说明瓶颈是**光栅化/合成**，不是 JS。改这一行比砍十个 rAF 有用。
       口径照抄项目已有的 `--ws-blur-low`（**只在 `.ws-perf-low` 里定义 = 0px**，
       高档拿不到它 ⇒ 回退到 8px，行为一字不变）。 */
    backdrop-filter: blur(var(--ws-blur-low, 8px));
    -webkit-backdrop-filter: blur(var(--ws-blur-low, 8px));
    color: #fff;
    font-size: 11px;
    line-height: 1.6;
    pointer-events: none;
  }
  /* 🔴 子项**一律不许被压缩**（见上面 `.ws-dml__hud` 里 2026-09-26 那段）：
     一压缩文字就溢出盒子 ⇒ 与邻格视觉重叠。
     `max-width: 100%` 是兜底：单格再长也不会比容器还宽。 */
  .ws-dml__hud > span,
  .ws-dml__hud > .ws-dml__theme {
    flex: 0 0 auto;
    white-space: nowrap;
    max-width: 100%;
  }
  /* 句子型的两格（告警 `.is-warn` / AI 示意说明 `.is-ai`）允许**格内换行**：
     它们可能远长于一屏，`nowrap` 会把整条 HUD 顶出屏幕（窄屏 360px 必现）。 */
  .ws-dml__hud > .is-warn,
  .ws-dml__hud > .is-ai {
    flex: 1 1 auto;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  /* 🆕 2026-09-26 窄屏压缩（**只调字号/行高/间距，一格信息都不删**）：
     实测 360×800（小型竖屏手机）下这条 HUD 占视口高 30%（判据上限 25%）——
     行数由内容决定、改不了，能改的是**每行多高**与**格间留白**。
     主题按钮要一起调：它自带 `font-size/line-height/padding`，
     不跟下来的话它会成为每一行的最高元素（行高被它顶住，压缩白做）。 */
  @media (max-width: 520px) {
    .ws-dml__hud {
      font-size: 10px;
      line-height: 1.3;
      gap: 1px 6px;
      padding: 2px 6px;
    }
    .ws-dml__hud .ws-dml__theme {
      font-size: 10px;
      line-height: 1.3;
      padding: 0 6px;
    }
  }
  /* 🆕 2026-09-28 **矮屏（横屏手机）**：兼容矩阵 78 格实测 —— 915×412 横屏下这条 HUD
     长到 **899×143 = 占屏高 35%**（判据上限 25%），而且它整块压在验证面板的 🔬 上
     （`HUD ∩ 🔬 = 1440px²`，36/36 格全中）。
     两条一起上（**一格信息都不删**）：
       ① 每行更矮（字号/行高/间距压缩，与窄屏那条同一手法）；
       ② 高度封顶 **26vh** 且**可滚动** —— 封顶保证画面不被吃掉，滚动保证后面的格子仍然够得着。
      ⚠️ 滚动需要 `pointer-events: auto`（容器默认 `none`，为的是不挡地图拖动）⇒ **只在矮屏开**
         （矮屏本来就是"信息被挤爆"的场景；竖屏行为一字不变）。这条的体感要**真机判**：
         如果你觉得"横屏时在 HUD 那一条上拖不动地图"，告诉我，我把它改成"点一下才展开"。 */
  @media (max-height: 560px) {
    .ws-dml__hud {
      font-size: 10px;
      line-height: 1.3;
      gap: 1px 6px;
      padding: 2px 6px;
      max-height: 26vh;
      overflow-y: auto;
      overscroll-behavior: contain;
      pointer-events: auto; /* 只为让"超出的一截"能滚（见上面的 ⚠️） */
    }
    .ws-dml__hud .ws-dml__theme {
      font-size: 10px;
      line-height: 1.3;
      padding: 0 6px;
    }
  }
  .ws-dml__hud .is-warn {
    color: #ffd28a;
  }
  /* 🔴 **署名条**（ODbL 硬要求：`attributionControl:false` ⇒ 必须有等价可见方案）。
     刻意做得素且**不占交互**（`pointer-events: none` + 右下角一行小字）：
     它必须**一直可见**（署名要求"画面上可见"，不是"藏在 title 里"），但不该盖住地图内容。
     `max-width` + 省略号：句子是导出脚本写的原句（可能不短），宁可截断显示也不改写它。
     ⚠️ 位置抬到 HUD 之上（`bottom: 30px`）：HUD 是**一行会很长**的 flex 条，
     同一条 `bottom: 8px` 上两者会叠在一起（机主横屏时尤其明显）。 */
  .ws-dml__attr {
    position: absolute;
    right: 8px;
    bottom: 30px;
    max-width: 62%;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(10, 16, 24, 0.45);
    color: rgba(255, 255, 255, 0.72);
    font-size: 10px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  /* 🎨 主题 A/B 开关。
     🔴 `pointer-events: auto` **不能省**：整条 HUD 是 `pointer-events:none`（它只是层显示，
     不该挡住地图的拖动/缩放）⇒ 不显式打开的话，这个按钮看得见、**点不动**（最难查的那种）。
     其余刻意做得素：不加 `backdrop-filter`（HUD 那条模糊已经是 fps 杀手，见上面的长注释），
     不加 transition —— 它不该成为新的每帧开销。 */
  .ws-dml__hud .ws-dml__theme {
    position: relative; /* ::after 的外扩可点区以它为参照 */
    pointer-events: auto;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    line-height: 1.4;
    color: #eaf6ff;
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 999px;
    padding: 1px 8px;
  }
  /* 触控目标 ≥ 44×44（WCAG）—— 但 HUD 只有 11px 高，撑到 44 会把地图挡掉一大条。
     折中：用透明外扩把**可点区域**做大，视觉尺寸不动（机主手指点得中，画面也不被占）。 */
  .ws-dml__hud .ws-dml__theme::after {
    content: "";
    position: absolute;
    inset: -12px -6px;
  }
  /* 「按类型估」的楼数：**估计值必须长得和真数据不一样**（暖色），
     否则读者会把猜的高度当成 OSM 写的（DESIGN-3D-MODES.md §八 的红线）。 */
  .ws-dml__hud .ws-dml__est {
    color: #ffcf8a;
    font-style: normal;
  }
  /* 「示意层已叠加」这一条：用**和暖色示意楼同一个色**（#d9a06b 系），
     让"字"和"画面上那层楼"一眼对得上 —— 观者不用读完字就知道哪片是编的。
     它是"非事实"的声明，所以给个描边底，别淹没在其它小字里。 */
  .ws-dml__hud .is-ai {
    color: #ffc98a;
    border: 1px solid rgba(217, 160, 107, 0.55);
    border-radius: 5px;
    padding: 0 4px;
  }
  /* 长等待覆盖层：铺满容器、压住那张还空着的画布（空画布 + 无提示 = 看起来像白底/卡死）。
     加载卡自身来自 `WsLoading`（等高线三圈错峰扩开），这里只负责定位与层级。 */
  .ws-dml__wait {
    position: absolute;
    inset: 0;
    z-index: 2;
    /* 加载卡是**纯展示**：别让它吃掉手势/点击（加载完就卸载了，但这层不该成为拦路虎） */
    pointer-events: none;
  }
  /* 低档兜底：见下面 `backdrop-filter` 处关于「blur(0px) 是假关」的说明 */
  .ws-root.ws-perf-low .ws-dml__hud,
  .ws-root.ws-perf-low .ws-dml__zoom button {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* ══ 🏷🗺 名字层（真名标签 + 区名标签）══════════════════════════════════════════════
     🔴 三条硬约束（`DESIGN-MG-MOTION.md` §4.0/§4.2 的红线）：
     ① 动画**只动 transform/opacity**（节点位置 = `translate3d`，绝不 `left/top`）；
     ② 相机运动期间**只写容器这一个节点**（`transform` + `opacity`），节点自身一个字都不写；
     ③ **禁 `backdrop-filter`**（浮在地图画布上 ⇒ 每帧读回底下像素；`blur(0px) ≠ 没有模糊`）。
     所以下面只有"纯色底 + 1px 描边"，没有任何模糊。 */
  .ws-labs {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;              /* 容器不吃事件；只有标签本身可点 */
    /* 跟手期间由 JS 写一次 translate3d（O(1)）；用完即撤（[MDN] will-change 的要求） */
    will-change: transform, opacity;
    opacity: 1;
    transition: opacity 80ms linear;   /* `LABEL_MOTION.cameraMs` 同口径（相机运动整层 1 → 0.25） */
  }
  .ws-labs.is-camera-moving {
    opacity: 0.25;                     /* §4.2：整层淡化 = **1 个节点**，不是 N 个 */
  }
  .ws-labs.is-switching {
    opacity: 0;                        /* "先隐后改字"：这一帧才允许换 textContent */
    transition: opacity 120ms cubic-bezier(0.3, 0, 1, 1);  /* `nameOutMs` */
  }
  /* >60 个标签 ⇒ 换手段（整层淡出→重排→淡入），**不是**缩时长 */
  .ws-labs.is-lite .ws-lab {
    transition: none;
  }
  .ws-lab {
    position: absolute;
    left: 0;
    top: 0;
    /* 命中区 ≥44×44：**静态 padding** 撑出来（不许用动画改尺寸放大命中区） */
    padding: 12px 10px;
    margin: -14px 0 0 -10px;           /* 让"文字中心"落在锚点上（padding 的一半） */
    background: transparent;
    border: 0;
    font: inherit;
    font-size: 11px;
    line-height: 14px;
    color: #eaf2f6;
    white-space: nowrap;
    cursor: pointer;
    pointer-events: auto;
    transform-origin: 50% 100%;
    /* 悬停 90ms / 松开 140ms；退让与复现都由 class 驱动（§4.2 参数表） */
    transition: transform 90ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 120ms cubic-bezier(0.3, 0, 1, 1);
  }
  .ws-lab::before {
    /* 文字底衬（纯色 + 1px 描边，**无模糊**）：只有实际文字大小，不吃命中区 */
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    top: 10px;
    bottom: 10px;
    border-radius: 5px;
    background: rgba(16, 24, 32, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.16);
    z-index: -1;
  }
  .ws-lab:hover,
  .ws-lab:focus-visible {
    transform: scale(1.05);            /* 强调只动 scale（**不许**改 font-size/padding） */
  }
  /* 🔴 三档样式**必须不同**（机主拍板）：真名 / 数据驱动区名 / 示意区名 */
  .ws-lab.is-real {
    color: #ffffff;
    font-weight: 600;
  }
  .ws-lab.is-derived {
    color: #ffe9a8;                    /* 数据驱动：暖黄，字号略大（它是"算出来的结论"） */
    font-size: 12px;
  }
  .ws-lab.is-derived::before {
    background: rgba(58, 44, 12, 0.78);
    border-color: rgba(255, 214, 120, 0.45);
  }
  .ws-lab.is-generated {
    /* 示意件：**斜体 + 虚线边 + 低饱和** —— 与真名一眼可分（项目红线：样式必须不同） */
    color: #cfe0d8;
    font-style: italic;
    font-weight: 400;
  }
  .ws-lab.is-generated::before {
    background: rgba(24, 34, 30, 0.66);
    border-style: dashed;
    border-color: rgba(180, 214, 200, 0.4);
  }
  /* 低档 / 减少动效：换手段（去 hover 缩放），**不是**把时长缩短 */
  .ws-root.ws-perf-low .ws-lab:hover,
  .ws-root.ws-perf-low .ws-lab:focus-visible {
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ws-lab {
      transition: opacity 120ms linear;  /* 只留一次很短的淡入（[MDN]），无位移无缩放 */
    }
    .ws-lab:hover,
    .ws-lab:focus-visible {
      transform: none;
    }
    .ws-labs {
      transition: opacity 120ms linear;
    }
  }

</style>
