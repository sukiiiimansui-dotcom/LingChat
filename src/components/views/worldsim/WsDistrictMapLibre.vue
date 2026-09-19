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

    <!-- 指标条：验证用（也让人一眼看到"这是真数据还是降级"） -->
    <div class="ws-dml__hud">
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
      <span v-if="stats.view" :title="'放大到街区才会取楼栋（Overpass 半径有上限）'">{{ stats.view }}</span>
      <span v-if="stats.contour !== 0">
        等高线 {{ stats.contour > 0 ? stats.contour + " 段" : "不可用" }}
      </span>
      <span>{{ stats.fps }} fps</span>
      <span v-if="stats.note" class="is-warn">{{ stats.note }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
  import worldMapApi, { geoJson } from "@/api/services/worldMap";
  import WsLoading from "./WsLoading.vue";
  import type { WsDistrictPin } from "./wsActors";
  import { aiFeatureCollection, type AiItem } from "./wsAiLayers";
  /* 「楼多高、什么颜色」的纯逻辑（`wsBuildingLook.ts`，独立文件 ⇒ 可单测、不跟渲染纠缠）。
     2026-09-19 机主：「这个 ai 2d 小区好丑，直接试一下 3d 路线我看看效果」——
     这一刀就是"3D 路线"的美术部分：真轮廓 + 有起伏的高度 + 有层次的光照。 */
  import { HEIGHT_COLOR_RAMP, decorateBuildings, heightColorExpression, renderHeight } from "./wsBuildingLook";
  /* 「代拍」：让页面自己 toDataURL 回传（agent 看不到 WebGL、机主又禁了 ADB 截屏 ⇒ 唯一通道） */
  import {
    canvasIsBlank,
    diagnosticPng,
    postShot,
    selfShotArmed,
    selfShotDisarm,
    selfShotMaybeArmFromUrl,
    settleForShot,
  } from "./wsSelfShot";
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
       */
      showAi?: boolean;
    }>(),
    { area: "", radius: 600, pitch: 55, markers: () => [], grid: 28, aiItems: () => [], showAi: false }
  );

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
  // eslint 不需要 map 的类型细节；这里只留一个句柄用于销毁
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  let raf = 0;
  let alive = true;
  /** 「放大才取楼」的去抖定时器（moveend 里用；卸载时要清） */
  let bldTimer = 0;
  /** 「地图库 8 秒没画出第一帧就降级」的看门狗（卸载时要清，见 onBeforeUnmount） */
  let watchdog = 0;
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
    return {
      version: 8,
      name: "ws-district",
      /* 🌆 天际线 L0 · 大气透视：远处的楼自动褪色、往天色里"化开" —— 这是"深度感"
          最大的来源，比任何后期滤镜都有效（见 world_map/DESIGN-SKYLINE.md 手段 #1）。

         🔴 2026-09-19 更正字段名（**主会话原来写的是 `fog`，在这个构建里是空操作**）：
         实测本 vendored 构建 = **MapLibre GL JS v6.10.0**，它的根级样式属性是
         `sky` / `light` / `terrain` / `snow` / `projection` —— **没有 `fog`**
         （`grep 'fog:' maplibre-gl-shared.mjs` = 0 次，而 `sky:{type:\`sky\`}` = 1 次）。
         雾的参数（`fog-color` / `fog-ground-blend` / `horizon-fog-blend`）在 v5 起
         **并进了 `sky`**。所以写 `fog:{...}` 不报错（根级属性不做校验，实测注入
         `zzzBogusRootProp` 也零报错）—— 但**一点效果都没有**，属于"看着配了、其实是空的"。
         ⚠️ 另外 `range` / `high-color` / `space-color` / `star-intensity` 是 **Mapbox** 的
         sky 字段，MapLibre 不认。这里用的是 MapLibre 的真字段名。 */
      sky: {
        "sky-color": "#0a1119",
        "horizon-color": "#1b2a3a",
        "fog-color": "#0d1620",
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.4,
        "atmosphere-blend": 0.7,
      },
      sources: {
        base: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 19,
          /* 🔴 `crossOrigin: "anonymous"` 不是可选项，是**代拍通道的命门**：
             浏览器把没声明 CORS 的跨域图片画进 canvas 会**污染画布**，
             之后 `canvas.toDataURL()` 直接抛 SecurityError ⇒ 自截图/代拍全废，
             而画面上**一切正常**（只有取图那一步失败，特别难查）。
             Esri 实测回 `Access-Control-Allow-Origin: *`，所以声明了就干净。 */
          crossOrigin: "anonymous",
          attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
        },
        /* 🅱 注记层（街名/地名）。暗色底图的 `..._Base` 是**不带字**的 ——
           只铺它，画面就是"一片深灰上有几个方块"，看不出这是哪条街（机主："不像地图"）。
           Esri 的 Reference 服务是**透明 PNG**（实测小瓦片 872B），叠上去就有字了。
           同一家的两套服务配同一套瓦片编号，不会错位。 */
        ref: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 19,
          crossOrigin: "anonymous", // 同上：不声明就会污染画布，代拍取不到图
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0a1017" } },
        /* 地面：**压暗 + 去饱和**。不压的话地面和矮楼一个亮度，整屏糊成一块深灰 ——
           这是"看着很丑"的成因之一（楼必须明显亮于地，才有"立起来"的感觉）。 */
        {
          id: "base",
          type: "raster",
          source: "base",
          paint: {
            "raster-opacity": 0.92,
            "raster-saturation": -0.25,
            "raster-contrast": 0.04,
            "raster-brightness-max": 0.74,
          },
        },
        /* 注记压在最上层（和地图 App 一个口径：街名不该被楼挡住）。
           楼房的图层会插到它**下面**（`addLayer(l, "ref")`）—— 所以它必须在这里先建好。 */
        { id: "ref", type: "raster", source: "ref", paint: { "raster-opacity": 0.9 } },
      ],
    };
  }

  /**
   * 从 GeoJSON 几何里算 bbox（MultiPolygon/Polygon 都吃）—— 纯函数，用来"整区铺满"。
   * 返回 `[minLng, minLat, maxLng, maxLat]`；几何为空/不是面 ⇒ null（**不猜**）。
   */
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
   * 楼高来源分类（与 Rust/前端别处的口径一致：height → levels×3 → **按 OSM 类型估**）。
   *
   * ⚠️ 三档必须分得开（`DESIGN-3D-MODES.md` §八 的红线）：
   * OSM 在中国的楼高覆盖率很低（渝中区实测 800m 内 232 栋里 **166 栋没有高度**），
   * 那 166 栋的高度是**我们按 `building=*` 类型猜的**，HUD 里单独一列，
   * 绝不能混进"真高" —— 混在一起报一个数就是把估计值当真数据。
   */
  function classify(fc: { features?: Array<{ properties?: Record<string, unknown> }> }) {
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
  function dressBld(fc: { features?: Array<{ properties?: Record<string, unknown> }> } | null): {
    type: "FeatureCollection";
    features: unknown[];
  } {
    const { features, count } = decorateBuildings(fc);
    stats.count = count.n;
    stats.height = count.real;
    stats.levels = count.levels;
    stats.default = count.kind; // HUD 里这一列叫「按类型估」
    return { type: "FeatureCollection", features };
  }

  /** 渲染高度 → 颜色（2D 降级路用；与 3D 的色阶**同一张表**，免得两条路观感不一致） */
  function rampColor(h: number): string {
    let c = HEIGHT_COLOR_RAMP[0]![1];
    for (const [stop, col] of HEIGHT_COLOR_RAMP) {
      if (h >= stop) c = col;
    }
    return c;
  }

  /**
   * Canvas2D 降级：把真实楼房画成**俯视图**。
   * 不引任何东西 —— 经纬度按包围盒线性映射到画布，y 轴翻转（纬度向上、画布向下）。
   */
  function draw2d(fc: { features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> }> } | null) {
    const c = cv.value;
    if (!c) return;
    // ⚠️ 别把局部变量叫 `host`：会遮蔽外层的 ref，TS 直接报"自引用"（TS7022/TS2448）
    const el = host.value;
    const w = Math.max(64, el?.clientWidth || 320);
    const h = Math.max(64, el?.clientHeight || 240);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, w, h);
    const feats = fc?.features || [];
    if (!feats.length) {
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = "12px system-ui";
      ctx.fillText("这一带没有楼房数据", 12, 22);
      return;
    }
    // 包围盒
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rings: Array<{ pts: number[][]; col: string }> = [];
    for (const f of feats) {
      const g = (f.geometry || {}) as { type?: string; coordinates?: unknown };
      const polys: number[][][][] =
        g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
      /* 颜色按**渲染高度**取（与 3D 路同一张色阶表）—— 降级路也看得出高低 */
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
      ctx.strokeStyle = "rgba(255,255,255,.28)";
      ctx.lineWidth = 0.7;
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
    m.easeTo({ zoom: 15, pitch: 46, duration: 900 });
    await settleForShot(m, 1200);
    if (!alive) return;
    ok = (await snap("app-dist-far")) || ok;
    m.easeTo({ zoom: 17.2, pitch: 62, bearing: -30, duration: 900 });
    await settleForShot(m, 1200);
    if (!alive) return;
    ok = (await snap("app-dist-close")) || ok;
    if (ok && !stats.note.includes("空白")) stats.note = "代拍：已回传 3 张（近/远/侧）";
    selfShotDisarm();
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
   * 想要的"光照"，现在靠「高度色阶 + 竖向渐变 + `fog` 大气透视」三样凑（见 DESIGN-SKYLINE.md）。
   */
  function bldLayerSpecs(): Array<Record<string, unknown>> {
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
        paint: {
          "fill-extrusion-color": heightColorExpression(),
          "fill-extrusion-height": ["coalesce", ["get", "h3d"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.97,
          /* 竖向渐变：楼顶比楼底亮一点。MapLibre 的默认值就是 true，但我们**显式写死** ——
             默认值会随版本改，而这一条直接决定"挤出的方块像不像楼"。 */
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "bld-line",
        type: "line",
        source: "bld",
        minzoom: 12.8, // 与 bld-ext 同档（轮廓线也是按要素数算的，别在整区视野白画）
        paint: { "line-color": "rgba(190,235,255,0.22)", "line-width": 0.5 },
      },
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
    el.title = `${a.name || "我"}${a.posSource === "affinity" ? "（特地来找你）" : ""}`;
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
   * 🔴 2026-09-19：**默认整层关掉**（`props.showAi` 默认 false）。
   * 为什么（不是审美问题，是**尺度错**）：
   * `aiFeatureCollection()` 把 28×28 的草图网格铺到**整个区县的 bbox** 上
   * （渝中区 ≈ 10.7km 宽）⇒ 一个 1 格宽的"楼"在地图上**有 380 米宽、12 米高**，
   * 是一张**薄饼**，不是楼。它压在真楼房旁边，只能把画面搞脏 ——
   * 机主说的"这个 ai 2d 小区好丑"，这一层是主犯。
   * 要让它好看，得先让 AI 的图元带**真实经纬度**（那是"角色/图元落库"那张卡），
   * 或者给它一条独立的"示意模式"（见 `world_map/DESIGN-3D-MODES.md` ③）。
   * 在那之前：**默认不画**，代码留着（`showAi` 传 true 即可复现）。
   */
  function syncAiLayers(): void {
    if (!props.showAi) return;
    const m = map as unknown as {
      getSource(id: string): { setData(d: unknown): void } | undefined;
      addSource(id: string, spec: Record<string, unknown>): void;
      addLayer(spec: Record<string, unknown>, beforeId?: string): void;
      getLayer(id: string): unknown;
    } | null;
    if (!m || !bboxRef.value) return;
    const fc = aiFeatureCollection(props.aiItems || [], bboxRef.value, props.grid || 28);
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
        "fill-color": ["match", ["get", "kind"], "park", "rgba(126, 200, 130, 0.42)", "rgba(90, 150, 210, 0.42)"],
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

  function syncPins(): void {
    const m = map;
    if (!m || !mlMod?.Marker || !bboxRef.value) return;
    const list = props.markers || [];
    const alive = new Set<string>();
    for (const a of list) {
      const pos = gridToLngLat(a.gx, a.gy);
      if (!pos) continue;
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

  /** 取楼用的地图最小接口（只声明用到的，避免 any） */
  interface BldMapLike {
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
  const BLD_R_MAX = 1400;
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

  /**
   * 「像高德那样」的第二半：**放大到街区再取楼**，而且**取少了会自动放大再试**。
   *
   * 三步：
   *   ① 半径从**当前视野**算（见 `radiusForView`）；
   *   ② 楼太少（< `BLD_ENOUGH`）就翻倍再试一次，最多爬到 `BLD_R_MAX`，**命中即停**；
   *   ③ 全都试完还是空 ⇒ **如实写进 HUD**（试过哪些半径），绝不静默 ——
   *      静默正是"HUD 常显示 🏢 0 却没人知道为什么"的成因。
   *
   * ⚠️ 为什么要封顶 1400m：**实测**（同一后端）
   *   · 涪陵驻地 400m→0 栋、600m→3、900m→18、1200m→27、1500m→29、**2500m→取不到**；
   *   · 渝中区驻地 400m→56、800m→232、**1200m→查询直接失败（Overpass 拖挂）**。
   *   ⇒ 半径越大越容易整条查询失败，而失败一次要等二十几秒。宁可"多爬两级"，
   *     也不要一次性甩一个 2500m 出去（那是**更慢而且更容易什么都没有**的选择）。
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
    let best: { feats: Array<{ properties?: Record<string, unknown> }>; r: number } | null = null;
    let failed = false;
    for (const r of ladder) {
      tried.push(r);
      try {
        const geo = await withTimeout(worldMapApi.buildings({ lat: c.lat, lng: c.lng, r }), 25000);
        if (!alive) return;
        const feats = (geo?.features || []) as Array<{ properties?: Record<string, unknown> }>;
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
      return;
    }
    const data = dressBld({ features: feats });
    if (m.getSource("bld")) {
      m.getSource("bld")!.setData(data);
    } else {
      m.addSource("bld", { type: "geojson", data });
      /* 插在注记层之前 ⇒ 街名压在楼上面（和地图 App 一个口径：楼不该把街名挡住） */
      const before = m.getLayer("ref") ? "ref" : undefined;
      for (const l of bldLayerSpecs()) m.addLayer(l, before);
    }
    stats.view = "街区视野";
    stats.note = best!.feats.length < BLD_ENOUGH ? `楼房稀疏：半径已放大到 ${best!.r}m（试过 ${tried.join("/")}m）` : "";
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
    fc: { features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> }> } | null,
    why = ""
  ): void {
    stats.mode = mode;
    mapAvailable.value = false;
    stats.pins = domPins.value.length;
    if (why) stats.note = stats.note ? `${stats.note} · ${why}` : why;
    draw2d(fc);
    phase.value = "done";
    stopTimer();
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
    type BldgFeat = { geometry?: unknown; properties?: Record<string, unknown> };
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
    if (fc?.features?.length) classify(fc as { features?: Array<{ properties?: Record<string, unknown> }> });
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

    // ③ 建图（注意：样式里**不能写 `glyphs: undefined`** —— 会让样式校验失败且零报错）
    const m = new maplibregl.Map({
      container: host.value as HTMLElement,
      canvas: cv.value as HTMLCanvasElement,
      style: makeStyle(),
      center: [106.569, 29.558],
      zoom: 16.4,
      pitch: props.pitch,
      bearing: 0,
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

    /* ⏱ **看门狗**：地图库"起来了"不等于"画出来了"。
       WebGL 初始化失败、上下文被系统回收、驱动摆烂时，MapLibre **不发错误、也不发 `load`**
       —— 页面于是永远停在「初始化…」，HUD 只有一行小字，**控制台干干净净**。
       实测（2026-09-19 无头环境）：`hasWebGL()` 为真、`new Map()` 成功、`load` 永不触发、
       `stats.mode` 停在初值「初始化…」、fps 1 —— 这就是"能玩"闸门第③条挂掉的现场。
       ⇒ 给它一个期限；过期就**如实降级**到 2D 路（有楼、有人、有解释），
         而不是让人对着一块不动的画面猜"是不是还没加载好"。 */
    watchdog = window.setTimeout(() => {
      /* 已经画完就不用管了（看门狗不是"超时即失败"，是"到点还没好才算失败"） */
      if (!alive || phase.value === "done") return;
      try {
        m.remove();
      } catch {
        /* 已经没了就算了 */
      }
      map = null;
      fallback2d("2D 降级（地图库没起来）", fc, "地图库 8 秒内没画出第一帧（load 未触发）");
    }, 8000);

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
    });

    /* 视野变化 → 按需取楼（"放大到街区再取"的触发点；去抖 600ms，避免拖动时把 Overpass 打爆） */
    m.on("moveend", () => {
      if (bldTimer) window.clearTimeout(bldTimer);
      bldTimer = window.setTimeout(() => {
        bldTimer = 0;
        void loadBuildingsForView(m as unknown as BldMapLike);
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
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
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
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #fff;
    font-size: 11px;
    line-height: 1.6;
    pointer-events: none;
  }
  .ws-dml__hud .is-warn {
    color: #ffd28a;
  }
  /* 「按类型估」的楼数：**估计值必须长得和真数据不一样**（暖色），
     否则读者会把猜的高度当成 OSM 写的（DESIGN-3D-MODES.md §八 的红线）。 */
  .ws-dml__hud .ws-dml__est {
    color: #ffcf8a;
    font-style: normal;
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
</style>
