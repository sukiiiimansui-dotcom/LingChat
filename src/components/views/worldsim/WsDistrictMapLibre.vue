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
    <canvas ref="cv" class="ws-dml__cv" />

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

    <!-- 缩放控件（机主 2026-09-19 实测：浏览器会抢走手势 ⇒ 只靠捏合没法缩放，
         而"放大到街区才取楼"就永远不触发 ⇒ 看起来"楼房压根不显示"。
         所以给一对按钮，**不依赖手势**也能缩放。高德/百度也都有这对按钮。 -->
    <div v-if="mapAvailable" class="ws-dml__zoom">
      <!-- 保险：click 之外再挂 pointerup（有些国产内核在 canvas 上 preventDefault 后
           会吃掉同层邻居的 click 合成事件）—— 150ms 节流避免一次点击跳两级 -->
      <button type="button" title="放大（到街道级别就会取真楼房）" @click="zoomOnce(1)" @pointerup="zoomOnce(1)">＋</button>
      <button type="button" title="缩小" @click="zoomOnce(-1)" @pointerup="zoomOnce(-1)">－</button>
      <button type="button" title="看整个区（整区铺满；这一档不取楼栋）" @click="fitDistrict()" @pointerup="fitDistrict()">全区</button>
    </div>

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
      <span v-if="stats.pins" :title="'画面上的角色数（含你自己；WebGL 用地图库 Marker，降级用 DOM 钉子）'">
        👤 {{ stats.pins }}
      </span>
      <!-- 🛣 路网：口径与画法一致（按 zoom 过滤档位），并把"主干几条/有名字几条"如实带上 -->
      <span v-if="stats.roads" :title="'本视野看得见的路（' + (stats.roadNote || '') + '）；行人会吸附到这些路上'">
        🛣 {{ stats.roads }}
      </span>
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

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
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
    /** 🛣 本视野**看得见**的路条数（口径与画法一致：按 zoom 过滤档位，见 `visibleRoadCount`） */
    roads: 0,
    /** 路网统计的一句话（主干几条 / 有几条有名字）—— 数据质量要看得见 */
    roadNote: "",
    /** 🏪 画在地图上的设施点（`/api/facilities` 的生活类 + 交通类） */
    facilities: 0,
    /** 设施统计的一句话（哪几类、共几个；缺的类如实说） */
    facNote: "", 
    /** 低档的原因（被**实际渲染路**压下来的，见 `wsPerf.forceLowTier`）。空串 = 没被压 */
    perf: "",
  });

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
   * 自建 style。
   *
   * ⚠️ 2026-09-19 更正：原来写「**不依赖瓦片服务器**」——那是当时的取舍，但结果是这块地方
   * 一直是一整片纯深色（机主："只有白底/不像地图"）。现在接 **Esri 暗色灰底**（免 key、实测 0.48s）。
   * 🔴 Esri 路径是 `{z}/{y}/{x}`（y 在前），写成 `{z}/{x}/{y}` 不报错但地图会跑到错位置。
   */
  function makeStyle() {
    /* 🎨 整份 style 的"底半部分"（`sky` + `sources` + 背景/底图/色罩/注记）现在由
       `wsMapTheme.themeStyleParts()` 生成 —— 它是**纯函数**，所以
       `ws_map_theme_selftest.mjs` 能在 Node 里把生成出来的 style 按
       **从 vendored maplibre 包里现抠出来的 spec** 逐条校验
       （根级属性白名单 / 图层类型枚举 / sky 的 7 个合法字段 / 各 paint 字段表）。

       🔴 为什么值得这么做：2026-09-20 我往 `layers[0]` 塞过一个坏对象 ⇒
       **整份 style 校验失败 ⇒ `load` 永不触发 ⇒ 全站退回 2D 降级**。
       那种错只在**运行时**炸一次，而它本来是可以被断言掉的。
       ⚠️ `sky` **不是图层类型**（图层类型只有 fill/line/symbol/circle/heatmap/
       fill-extrusion/raster/hillshade/color-relief/background），只能走**根级** `sky`。 */
    const parts = themeStyleParts(theme.value, !!perf.low, perf.low.value ? 0 : NIGHT_FADE_MS);
    return {
      version: 8,
      name: `ws-district-${theme.value.id}`,
      /* `sky` 可能没有（低端档会关掉它）—— 用展开而不是写 `sky: undefined`，
         免得给 style 里塞一个值为 undefined 的键（校验器会当它存在）。 */
      ...(parts.sky ? { sky: parts.sky } : {}),
      sources: parts.sources,
      /* ⚠️ 顺序有意义（自下而上）：bg → base → [hi] → [tint] → ref。
         楼房的图层由 `addLayer(l, "ref")` 插到 **ref 之前** ⇒ 自动落在线罩**之上**。
         `ref` 必须留在最后一条：它是楼房层的插入锚点（见 loadBuildingsForView）。 */
      layers: parts.layers,
    };
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
    /* 色阶跟着主题走（暗色=深蓝→冰蓝；二次元=淡天蓝→近白）。
       必须在**这里**（渲染前）算好：`color3d` 是写进要素属性的，图层的 paint 只读它。 */
    const { features, count } = decorateBuildings(fc, theme.value.ramp);
    stats.count = count.n;
    stats.height = count.real;
    stats.levels = count.levels;
    stats.default = count.kind; // HUD 里这一列叫「按类型估」
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
    const cv2 = cv.value;
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
      syncAiLayers();
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
      getCanvas: () => cv.value,
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
    /* "主题期望的图层" —— 与当前档位同一份来源（`themeStyleParts`），少一条就能当场看出来 */
    let expected: string[] = [];
    try {
      expected = (themeStyleParts(theme.value, !!perf.low.value, 0).layers || []).map((l: { id?: string }) => String(l.id || ""));
    } catch {
      expected = [];
    }
    const cvv = cv.value;
    return {
      kind: renderKind.value,
      build: APP_SELF_SHOT_BUILD,
      href: typeof location !== "undefined" ? location.href : "",
      fallbackWhy: fallbackWhy.value,
      fallbackKind: renderKind.value === "fallback2d" ? fallbackKind.value : "none",
      recovered: recovered.value,
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
      /* 2D 路的 DPR 封顶（机主要的"降级路便宜了多少"的数字；WebGL 路不适用 ⇒ null） */
      dprCap2d: renderKind.value === "fallback2d" ? dprCap2d() : null,
      canvasBlank: cvv ? canvasIsBlank(cvv) : null,
      counts: { buildings: stats.count, roads: stats.roads, facilities: stats.facilities, pins: stats.pins },
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

  function bldLayerSpecs(): Array<Record<string, unknown>> {
    /* 🎨 主题参数（暗色 ↔ 二次元）与低端档 —— 都从单一真源取，不在这里写死任何颜色 */
    const th = theme.value;
    const tier = themeTier.value;
    /** 挤出体的公共 paint（三条层只差颜色/过滤，写一份免得漂移） */
    const common = {
      /* 主题/时间切换要**平滑**而不是「啪」一下：本构建的 paint 属性带 `transition: true`（spec 实测），
         写上 `*-transition` 就由 MapLibre 自己做时长插值 —— **别自己写 rAF 插值动画**（那是重复劳动且更贵）。
         三层（bld-ext / bld-roof / bld-antenna）共用这个对象 ⇒ 改一处覆盖三层。
         900ms 是手感取值：太短像瞬变、太长像卡住。 */
      "fill-extrusion-color-transition": { duration: 900, delay: 0 },
      "fill-extrusion-opacity-transition": { duration: 900, delay: 0 },
      "fill-extrusion-height": ["coalesce", ["get", "h3d"], 8],
      /* 底座统一读 `h_base`（拆件时每条都写了；老数据没有就退回 `min_height`） */
      "fill-extrusion-base": ["coalesce", ["get", "h_base"], ["get", "min_height"], 0],
      /* 远景褪色（#8）：远处楼淡一点，近处实（曲线由主题给，见 `wsMapTheme.extrudOpacity`） */
      "fill-extrusion-opacity": th.extrudOpacity,
      /* 竖向渐变：楼顶比楼底亮一点 —— **写实**要它（墙面有明暗、体块才"立"得起来）；
         **二次元要关掉它**（平涂/cell-shading：楼是一块纯色板，有渐变就不"动画"了）。
         MapLibre 默认就是 true，但我们**显式写死**：默认值会随版本改，而这一条直接决定观感。 */
      "fill-extrusion-vertical-gradient": th.verticalGradient,
    };
    /** 低端档：`outlineWidth === null` ⇒ **整条描边层不建**（少一层 = 少一遍要素遍历）。
        暗色主题低端就是这条路；二次元低端只把线调细（因为那里描边是**唯一**的分隔手段）。 */
    const showOutline = tier.outlineWidth !== null;
    return [
      {
        id: "bld-ext",
        type: "fill-extrusion",
        source: "bld",
        /* 性能（机主 2026-09-19：「能玩」优先）：
           `fill-extrusion` 的开销**随要素数线性增长**（见 MapLibre 官方性能指南 /
           Bavaria 矢量瓦片 3D 经验），而整区视野下楼只有亚像素 ⇒ 这一档**整层不画**。
           取楼本来也要 zoom ≥ 13.5，两层阈值对齐（12.8 留一点余量，免得来回抖）。 */
        minzoom: 12.8,
        /* 只画主体 —— 屋顶/天线是另外两条层（拆件后同一个源里有三种 `part`） */
        filter: ["==", ["get", "part"], "body"],
        paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], rampExpression(th)] },
      },
      {
        /* 屋顶压顶：同一轮廓内缩 + 更深色 ⇒ 楼顶多一圈"女儿墙"的层次（#4）
           ⚠️ 只在 `h3d ≥ 15m` 的楼上生成（`wsBuildingLook.ROOF_MIN_H`）——
           矮平房压顶只会显脏，还白翻一倍要素数。 */
        id: "bld-roof",
        type: "fill-extrusion",
        source: "bld",
        minzoom: 14.5, // 远景看不出这一层，不白画
        filter: ["==", ["get", "part"], "roof"],
        paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], th.roofFallback] },
      },
      {
        /* 天线：>60m 的楼顶一根细挤出（#6）—— 城市轮廓里最抓眼的一档，要素数极少 */
        id: "bld-antenna",
        type: "fill-extrusion",
        source: "bld",
        minzoom: 14.5,
        filter: ["==", ["get", "part"], "antenna"],
        paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], th.antennaFallback] },
      },
      ...(showOutline
        ? [
            {
              id: "bld-line",
              type: "line",
              source: "bld",
              minzoom: 12.8, // 与 bld-ext 同档（轮廓线也是按要素数算的，别在整区视野白画）
              /* 只描主体的边：屋顶/天线也描的话，楼顶会糊成一团线（它们本来就是靠色差读的） */
              filter: ["==", ["get", "part"], "body"],
              /* 二次元这层是"动画感"的主要来源（平涂 + 深藏青细线）；
                 暗色这层只是淡淡一圈，低端档直接不建。 */
              paint: { "line-color": th.outline.color, "line-width": tier.outlineWidth ?? th.outline.width },
            },
          ]
        : []),
    ];
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

  /* AI 产出变了就同步（流式生成时每来一批都会调） */
  watch(
    () => props.aiItems,
    () => syncAiLayers()
  );

  /**
   * 真楼数变了 ⇒ `aiOn` 可能翻转 ⇒ 自动叠上 / 摘掉示意层。
   *
   * 这条 watcher 是整刀的**因果**所在：示意层不是"用户打开的开关"，
   * 而是"真数据稀疏"这个**被动发现的事实**的结果 —— 谁也别去手动同步它。
   */
  watch(aiOn, () => syncAiLayers());

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

  function syncPins(): void {
    const m = map;
    if (!m || !mlMod?.Marker || !bboxRef.value) return;
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
    () => props.markers,
    () => {
      syncPins();
      stats.pins = mapAvailable.value ? stats.pins : domPins.value.length;
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
    const b = bboxRef.value;
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

  /** 取楼半径的上下限（米）。下限：太小了连一个小区都盖不住；上限见下方"为什么要封顶" */
  const BLD_R_MIN = 350;
  /**
   * 上限 **2000m**（2026-09-20 从 1400 放宽）。
   *
   * 为什么：机主真机截图（涪陵）里 `🏢 0`，查下来是这一带的楼**本来就稀** ——
   * 实测涪陵驻地 400m→**0 栋**、600m→3、900m→18、1000m→21、1400m→29、
   * **2500m→整条查询失败**。1400m 只够拿到那 29 栋里的一部分。
   * 放宽是**只帮稀疏区、不伤密集区**的改法：密集区（渝中 700m 就有 232 栋）
   * 第一级就 ≥`BLD_ENOUGH` 停下，**根本走不到上限**；只有稀疏区才会爬到 2000。
   */
  const BLD_R_MAX = 2000;
  /** "够看"的楼栋数：一屏想看到"成片"，至少得有这么几栋（不到就换更大的半径再试一次） */
  const BLD_ENOUGH = 25;

  /**
   * 视野 → 取楼半径：**按屏幕真正看得见的范围**要数据，而不是拿 zoom 拍脑袋。
   *
   * 🔴 这一条是 `🏢 0` 的直接解药（2026-09-19 定位到根因）：
   * 旧公式 `500 * 2^(15-z)` 在默认的 zoom 15.2 上只给 **435m** ——
   * 而 zoom 15.2 在手机横屏上**一眼能看到 4km 宽**，435m 连屏幕的一小块都盖不住；
   * 涪陵驻地那一带 400m 内更是**一栋楼都没有**（实测 400m→0、600m→3）⇒
   * 取回来是空的，HUD 就永远停在 `🏢 0`，而且那时还是**静默 return**、什么都不说。
   */
  function radiusForView(m: BldMapLike): number {
    const b = m.getBounds();
    const c = m.getCenter();
    const dLng = Math.abs(b.getEast() - b.getWest()) / 2;
    const dLat = Math.abs(b.getNorth() - b.getSouth()) / 2;
    /* 经纬度 → 米（够用的近似：纬度 1°≈110.54km，经度要乘 cos(纬度)） */
    const mx = dLng * 111320 * Math.cos((c.lat * Math.PI) / 180);
    const my = dLat * 110540;
    const r = Math.hypot(mx, my) * 0.95;
    return Math.max(BLD_R_MIN, Math.min(BLD_R_MAX, Math.round(r / 50) * 50));
  }

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
    const z = m.getZoom();
    if (z < ROAD_MIN_ZOOM) {
      stats.view = stats.view || "全区视野";
      return;
    }
    const c = m.getCenter();
    const r = radiusForView(m);
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r}`;
    if (key === lastRoadKey) return;
    lastRoadKey = key;
    try {
      const geo = await withTimeout(worldMapApi.roads({ lat: c.lat, lng: c.lng, r }), 25000);
      if (!alive) return;
      const fc = geo as { type?: string; features?: unknown[] } | null;
      const feats = (fc?.features || []) as BldFeature[];
      if (!feats.length) {
        /* 空结果**必须说出来**（同楼房的纪律：静默 = 让人以为"这里没路"） */
        stats.roads = 0;
        stats.note = stats.note ? `${stats.note} · 这一带没有路网数据（${r}m）` : `这一带没有路网数据（${r}m）`;
        return;
      }
      const data = { type: "FeatureCollection", features: feats };
      if (m.getLayer("road-line-0")) {
        (m.getSource("roads") as { setData(d: unknown): void } | undefined)?.setData(data);
      } else {
        m.addSource("roads", { type: "geojson", data });
        /* 插在**楼房之下**：路是地面上的东西，压在楼上会像"从楼顶穿过" */
        const before = m.getLayer("bld-ext") ? "bld-ext" : m.getLayer("ref") ? "ref" : undefined;
        for (const l of roadLayerSpecsForMap()) if (!m.getLayer(l.id as string)) m.addLayer(l, before);
      }
      roadSegs = roadSegments(data as never);
      stats.roads = visibleRoadCount(data as never, z);
      /* `worldMapApi.roads()` 只解包 `geojson`（与 buildings 同一个壳），
         统计在**原始信封**里 ⇒ 这里显式放宽类型读一次；拿不到就给 null（HUD 会少一行统计，
         但**不会**编一个数字出来）。 */
      stats.roadNote = roadStatsLine((geo as { stats?: Record<string, unknown> } | null)?.stats ?? null);
    } catch {
      stats.note = stats.note ? `${stats.note} · 路网取不到` : "路网取不到（后端没响应或超时）";
    }
  }

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
    const z = m.getZoom();
    if (z < BLD_MIN_ZOOM) {
      stats.view = "全区视野";
      return;
    }
    const c = m.getCenter();
    const r0 = radiusForView(m);
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r0}`;
    if (key === lastBldKey) return;
    lastBldKey = key;

    /* 半径梯子：视野半径 → 翻倍 → 再翻倍（封顶）。命中就停，别白等 Overpass。 */
    const ladder: number[] = [r0];
    while (ladder[ladder.length - 1]! < BLD_R_MAX) {
      ladder.push(Math.min(BLD_R_MAX, ladder[ladder.length - 1]! * 2));
    }
    const tried: number[] = [];
    /** 一路记着"目前最好的一份"：后面某一级失败/更少时，不至于把手上的楼丢掉 */
    let best: { feats: BldFeature[]; r: number } | null = null;
    let failed = false;
    for (const r of ladder) {
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

    const feats = best?.feats ?? [];
    if (!alive) return;
    if (!feats.length) {
      /* 🔴 空结果**必须说出来**：不然就是"看起来卡住了/什么都没有" */
      stats.view = "街区视野";
      stats.note = failed
        ? `楼房数据取不到（已试 ${tried.join("/")}m）`
        : `OSM 在这一带没有登记楼房（已试 ${tried.join("/")}m）`;
      /* OSM 一栋都没有 = 最稀疏的情况 ⇒ 交给第二源补（拿不到就只留上面那句实话） */
      const fill0 = await overtureFill(c.lat, c.lng, best?.r ?? r0, 0);
      if (!alive || !fill0?.features.length) return;
      applyBuildings(m, dressBld({ features: fill0.features }));
      stats.note = `${stats.note} · ${fill0.note}`;
      return;
    }
    /* 🆕 第二源补缺：OSM 不够看时才问（够看的地方一次网络都不发） */
    let features: BldFeature[] = feats;
    let fillNote = "";
    if (shouldAskSecondSource(feats.length, BLD_SPARSE)) {
      /* 先如实说"正在补"，别让人对着不动的画面猜（这一问冷启动要十几秒） */
      stats.note = `真楼只有 ${feats.length} 栋，正在取 Overture 补缺…`;
      const fill = await overtureFill(c.lat, c.lng, best!.r, feats.length);
      if (!alive) return;
      if (fill?.features.length) {
        const mg = mergeBuildingSources(feats, fill.features);
        features = mg.features as typeof features;
        fillNote = `${fill.note}（去重 ${mg.dropped}）`;
      } else {
        fillNote = "Overture 补缺不可用（只用 OSM）";
      }
    }
    applyBuildings(m, dressBld({ features }));
    stats.view = "街区视野";
    const sparse = best!.feats.length < BLD_ENOUGH ? `楼房稀疏：半径已放大到 ${best!.r}m（试过 ${tried.join("/")}m）` : "";
    stats.note = [sparse, fillNote].filter(Boolean).join(" · ");
  }

  /**
   * 把一份**已上妆**的楼栋数据落到图层上：首次建源 + 建层，之后只 `setData`。
   * （两条路都要用：OSM 有一份数据的路、OSM 空但 Overture 有数据的路 —— 写两遍迟早漂移。）
   */
  function applyBuildings(m: BldMapLike, data: { type: "FeatureCollection"; features: unknown[] }): void {
    if (m.getSource("bld")) {
      m.getSource("bld")!.setData(data);
      return;
    }
    m.addSource("bld", { type: "geojson", data });
    /* 插在注记层之前 ⇒ 街名压在楼上面（和地图 App 一个口径：楼不该把街名挡住） */
    const before = m.getLayer("ref") ? "ref" : undefined;
    for (const l of bldLayerSpecs()) m.addLayer(l, before);
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
    if (oldCv && !oldCv.getContext("2d")) {
      const fresh = document.createElement("canvas");
      /* ⚠️ 要连**所有属性**一起搬（`class` 之外还有 Vue 的 scoped 标记 `data-v-xxxx`）——
         漏了它，新画布就丢掉了 `position:absolute; width:100%; height:100%`，
         会缩回浏览器默认的 300×150 跑到左上角：**又是一次"降级了但看着是坏的"**。 */
      for (const a of Array.from(oldCv.attributes)) fresh.setAttribute(a.name, a.value);
      if (keepAlive && oldCv.parentElement) {
        /* 盖在**上面**（`afterend`）：下面那块 WebGL 画布继续存在、继续渲染，只是看不见 */
        oldCv.parentElement.insertBefore(fresh, oldCv.nextSibling);
        fresh.classList.add("ws-dml__cv--2d");
      } else if (oldCv.parentElement) {
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
    if (!cv.value) return;
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
      let geo = districtWide ? null : await withTimeout(worldMapApi.buildings({ lat, lng, r: props.radius }), 20000);
      /* OSM 楼栋覆盖**极不均匀**（2026-09-19 实测同一个后端：涪陵区中心 400m→**0 栋**、600m→3 栋、
         1500m→29 栋；渝中区中心 400m→**152 栋**）。所以第一把太少时**自动放大一次**半径
         （只放一次、封顶 2500m，免得把 Overpass 打爆），并把这件事写进 HUD —— 不假装"没有楼房"。 */
      if (!districtWide && (geo?.features?.length ?? 0) < 5) {
        const r2 = Math.min(2500, Math.max(1500, props.radius * 3));
        triedRs.push(r2);
        const geo2 = await withTimeout(worldMapApi.buildings({ lat, lng, r: r2 }), 20000);
        if ((geo2?.features?.length ?? 0) > (geo?.features?.length ?? 0)) {
          geo = geo2;
          usedR = r2;
          stats.note = `楼房稀疏：取楼半径已放大到 ${r2}m`;
        }
      }
      fc = geo ? { features: geo.features as BldgFeat[] } : null;
    } catch {
      fc = null;
      fetchFailed = true;
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
        ? "楼房数据请求失败（后端没响应）"
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
    } catch {
      fallback2d("2D 降级（地图库加载失败）", null, "vendor/maplibre 缺失？");
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
      canvas: cv.value as HTMLCanvasElement,
      style: makeStyle(),
      center: [106.569, 29.558],
      zoom: 16.4,
      pitch: props.pitch,
      bearing: 0,
      /* 🔴 `maxPitch` 必须显式放开：MapLibre 的默认上限是 **60°** ——
         不改的话机主"想往下压看天"最多压到 60，永远抬不起头。
         85° 是 MapLibre 允许的上限（90 会把相机压到与地面平行、数值上容易出问题）。 */
      maxPitch: 85,
      attributionControl: false,
      // 无头截图需要；真机无影响
      preserveDrawingBuffer: true,
    });
    map = m;

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
        m.addSource("bld", { type: "geojson", data: dressBld(fc) });
        const before0 = m.getLayer("ref") ? "ref" : undefined;
        for (const l of bldLayerSpecs()) m.addLayer(l, before0);
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
      }
      /* 区县边界（"整区铺满"的可读性）：淡填充 + 主色描边，**压在楼房之下**。
         没有它，整区视野下用户看不出"这块就是我所在的区"（高德那套也是这么做的）。 */
      if (districtFeat) {
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

      /* 楼房就位后再画等高线（要 beforeId="bld-ext"，顺序不能反） */
      void drawContours(m as unknown as Parameters<typeof drawContours>[0]);
      // 首帧真的画出来了才收起加载态（画不出来就让它继续转，别假装好了）
      /* 地图就绪 + 区界已知 ⇒ 把"人"和"AI 画的街区"摆上去 */
      syncPins();
      syncAiLayers();
      phase.value = "done";
      stopTimer();
      /* 代拍：`?autoshot=1` 开了开关才跑，没开就是一次 boolean 判断（零开销） */
      if (selfShotArmed()) void runSelfShot(m as unknown as Parameters<typeof runSelfShot>[0]);
      /* 🧪 App 自拍（`?selfshot=1`）：这是 **WebGL 路**的触发点（降级路的在 `fallback2d` 末尾） */
      maybeAppSelfShot("webgl");
    });

    /* 视野变化 → 按需取楼（"放大到街区再取"的触发点；去抖 600ms，避免拖动时把 Overpass 打爆） */
    m.on("moveend", () => {
      if (bldTimer) window.clearTimeout(bldTimer);
      bldTimer = window.setTimeout(() => {
        bldTimer = 0;
        void loadBuildingsForView(m as unknown as BldMapLike);
        void loadRoadsForView(m as unknown as BldMapLike);
      }, 600);
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
    gap: 8px;
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
  .ws-dml__hud .is-warn {
    color: #ffd28a;
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

</style>
