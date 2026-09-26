/**
 * wsMapTheme.ts —— 「地图长什么样」的**主题预设**（纯数据 + 纯函数，可单测）。
 *
 * ## 为什么单独一个文件（2026-09-20）
 * 机主原话：「**这个地图太暗了喵，还有就是我想给整体地图改成二次元式的那种风格喵**」。
 * 这两件事看着像"调几个数字"，但踩下去全是雷：
 *   · 地图库的亮度公式是**仿射重映射**（不是"调亮一点点"）⇒ 提亮地面会**一起提亮所有东西**，
 *     楼体色阶不动的话，3D 楼会直接**沉进地面**（这正是"看着很丑"的成因之一）；
 *   · `sky` 的字段名、`raster-*` 的取值范围、**哪些图层类型合法**，只要写错一个，
 *     MapLibre 的表现是"**整份 style 校验失败 ⇒ 全站退回 2D 降级**"（我们真踩过）；
 *   · 主题必须**可切换**（机主要能"暗色 ↔ 二次元"来回看），且**旧的暗色主题不许删**。
 * 所以把"主题"变成一份**可被 Node 断言的数据**：颜色、亮度参数、描边、降级规则全在这里，
 * 渲染组件只负责"照着这个对象摆图层"，不再自己决定美术。
 *
 * ## 🔴 本文件里所有"魔法数字"的来源（别当它们是我拍的）
 * · `measuredLuma` —— 我从 Esri **真瓦片**上下载后逐像素量的（涪陵 z16，各 4 张取均值）：
 *     `Canvas/World_Dark_Gray_Base` = 0.287、`World_Imagery` = 0.362、
 *     `Canvas/World_Light_Gray_Base` = 0.937（z14 0.943）。
 *     复现脚本：`~/chk/measure-tile-luma.py` 与 `~/chk/probe-light-basemaps.py`。
 * · 亮度公式 —— 从 **本项目 vendor 的那份包里把 GLSL 抠出来的**（`maplibre-gl.mjs` 的
 *     raster fragment shader），不是照文档猜的：
 *       rgb += (avg - rgb) * u_saturation_factor              // 先饱和度
 *       rgb  = (rgb - 0.5) * u_contrast_factor + 0.5          // 再对比度（绕 0.5）
 *       out  = mix(brightness_min, brightness_max, rgb)       // 最后亮度**重映射**
 *     ⇒ `raster-brightness-max: 0.34` 的真实含义是"**整条色带压到 34%**"（真的暗）。
 *     `rasterBrightness()` 就是这三行的忠实复刻，自检拿它算"地面到底多亮"。
 */

/* `shade()` = "把一个颜色按比例压暗"的**唯一实现**（在 `wsBuildingLook.ts`，无依赖、纯函数）。
   为什么从这里 import 而不是再写一个：`wsGameLook()` 派生出来的每一档颜色都要往下压，
   两份压暗实现迟早会分叉（这个项目已经为"两处各写一份"付过代价）。 */
import { shade } from "./wsBuildingLook";

/** 主题 id。`night` = 原来的暗色（**保留，不删**）；`anime` = 二次元（蔚蓝档案风）。 */
export type WsMapThemeId = "night" | "anime";

/** 默认主题：机主要"整体改成二次元"，所以默认就是它；想看旧的传 `?wstheme=night`。 */
export const WS_MAP_THEME_DEFAULT: WsMapThemeId = "anime";

/** localStorage 的键（和 `wsPerf` 一个命名空间风格） */
export const WS_MAP_THEME_KEY = "wsm:v1:mapTheme";

/**
 * 「楼和地靠什么分开」—— 这不是美术口味，是**自检该守哪条不变量**：
 *  · `luminance`：靠**明度差**（暗色主题：地压暗、楼比地亮）。守"楼/地亮度比 ≥ N"。
 *  · `outline`  ：靠**描边**（二次元：地本来就亮，楼也是亮的，明度差拉不开）。
 *               守"描边与地面的对比度 ≥ 3:1"（WCAG 1.4.11 对非文字图形的要求）。
 *
 * 为什么必须分开写：机主用的 BA 色板里地面 `#EAF3FA`（亮度 0.93）**比矮楼 `#BFE3F7`（0.87）还亮**
 * —— 硬套"楼必须比地亮"这条不变量，只会逼我把 BA 配色改成不是 BA。**不变量要跟着风格走。**
 */
export type WsMapThemeSeparation = "luminance" | "outline";

/** 栅格图层的 paint（只列我们真会写的字段 —— 写错字段名 MapLibre 是**静默不画**的） */
export interface WsMapRasterPaint {
  "raster-opacity": unknown;
  "raster-saturation"?: number;
  "raster-contrast"?: number;
  "raster-brightness-min"?: number;
  "raster-brightness-max"?: number;
  "raster-hue-rotate"?: number;
}

/** 一个瓦片服务 */
export interface WsMapRasterSource {
  tiles: [string];
  /**
   * 版权署名。**不是可选的美化项**：Esri 的服务条款要求署名，删掉就是拿别人的数据不说出处。
   * 🔴 我 2026-09-20 把 sources 从组件搬进本文件时**漏掉了它**（`themeStyleParts` 只搬了
   * tiles/maxzoom）—— 这种"搬家丢字段"不会报错、也没人看得出来，是最容易悄悄发生的一类回归。
   * 现在它跟 tiles 一起放在主题里，并且自检会断言每条栅格源都有署名。
   */
  attribution?: string;
  /** Esri Canvas 系列**最高只到 z16**，z17+ 是 2521B 的"Map data not yet available"占位图
   *  （实测：`measure-tile-luma.py` 打到 z17，四张全是 2521B、亮度 0.803）。
   *  ⇒ 一律限到 16，让地图库**放大复用** z16 的瓦片（略糊，但远好过整屏灰占位图）。 */
  maxzoom: number;
}

export interface WsMapTheme {
  id: WsMapThemeId;
  label: string;
  /** 给 HUD 显示的一句话（机主看得懂的那种） */
  hud: string;
  separation: WsMapThemeSeparation;
  /**
   * 根级 `sky` 对象。
   *
   * 🔴 **只能写这 7 个字段**（我从 vendored 包里抄的 spec）：
   *    `sky-color` / `horizon-color` / `fog-color` / `fog-ground-blend` /
   *    `horizon-fog-blend` / `sky-horizon-blend` / `atmosphere-blend`
   * ⚠️ `range` / `high-color` / `space-color` / `star-intensity` 是 **Mapbox** 的字段，MapLibre 不认。
   * ⚠️ `sky` **不是图层类型** —— 往 `layers[]` 里塞 `{type:"sky"}` 会让整份 style 校验失败
   *    （真踩过：`layers[0]: missing required property` ⇒ 全站退回 2D）。
   *    这条现在有自检守着（`ws_map_theme_selftest.mjs` 直接从包里抠图层类型白名单来断言）。
   */
  sky: Record<string, unknown> | null;
  /** `bg` 背景图层颜色（瓦片还没到 / 天空之外的地方）。**它也是"天空没生效"时的兜底**：
   *  二次元主题把它设成近白，就算 `sky` 一点不画，背景也不会是黑的。 */
  bg: string;
  sources: {
    base: WsMapRasterSource;
    /** 高分层（卫星影像）。**二次元主题没有它** —— 卫星就是写实，跟平涂是冲突的。 */
    hi: WsMapRasterSource | null;
    ref: WsMapRasterSource;
  };
  raster: {
    base: WsMapRasterPaint;
    hi: WsMapRasterPaint | null;
    ref: WsMapRasterPaint;
  };
  /**
   * 半透明色罩（一条 `background` 图层，压在底图上、楼房下）。
   * 为什么用这个而不是 `raster-hue-rotate`：底图是**灰度**的，灰度上转色相**什么都不会发生**；
   * 想要"BA 那种浅蓝地面"，只能**盖一层浅蓝**。`background-opacity` 是合法 paint 属性（spec 里 0~1）。
   */
  tint: { color: string; opacity: number } | null;
  /** 楼体高度色阶（`[高度m, 颜色]`，交给 `fill-extrusion-color` 的 interpolate） */
  ramp: Array<[number, string]>;
  /** `color3d` 缺字段时屋顶/天线的兜底色 */
  roofFallback: string;
  antennaFallback: string;
  /** 楼体描边（`bld-line` 那条 `line` 图层） */
  outline: { color: string; width: number };
  /**
   * **AI 示意层**的配色（真数据稀疏时才会出现，见 `wsAiLayers`）。
   *
   * ⚠️ 为什么"水体换色"只能在这里做：小区级**没有水系数据集** ——
   * 底图是 Esri 的**灰度**瓦片（`World_Light_Gray_Base` 里江面就是一片浅灰，
   * 和陆地同色系，**没法只把水挑出来染**；灰度上做色相旋转是空操作）。
   * 我们真正拥有几何的"水"，只有 AI 精绘产出的示意水体（`kind: "water"`）。
   * ⇒ 想让**真实江面**也变青蓝，得先有水的矢量数据（Overpass/自有水系），那是另一张卡，
   *   不是调个参数能解决的。**别把这条当成"水体已改好"。**
   * 取值一律写成完整的 CSS 颜色（含 alpha），免得表达式里再算透明度。
   */
  ai: { park: string; water: string };
  /**
   * 栅格底图在**高 zoom** 下淡出。
   *
   * 🔴 为什么需要它（机主 2026-09-20：「**地面太糊，优化下**」）：
   * 二次元用的亮灰底图**最高只到 z16**，而小区级默认 zoom 16.4、放大到 17~18 ⇒
   * MapLibre 只能把 z16 的瓦片**放大 2~4 倍** ⇒ **必然糊**，这是数据上限，调清晰度没用。
   * ⇒ 正解是"高 zoom 干脆不用照片"：淡出到 0，露出**纯色地面**（`bg` + `tint` 合成出来
   * 的那个浅青色，和 3D 那条路的地面色**逐位相同**）+ **我们自己的路网线** + 楼体
   * ⇒ **任何缩放下都是锐利的矢量**，而且更像 BA 的干净平涂。
   * 低 zoom（省/市/区县）保持现状：那里底图的道路/地名是有信息量的。
   * `null` = 全程不淡出（暗色主题用它：卫星影像 z19 有真细节，淡掉反而更差）。
   */
  baseFade: { from: number; to: number } | null;
  /**
   * **路网配色**（`wsRoads.roadLayerSpecs` 取用）。
   *
   * 为什么路网也归主题管：底图淡出之后，**路网就是地面上唯一的结构**。
   * 而 `wsRoads` 原来的配色是按**暗底**设计的（近黑描边 `#0b1017` + 暖白路芯）——
   * 铺在浅色二次元地面上就是"白线画白纸"（路芯和地面一样亮，看不见），
   * 而近黑描边会变成一条条黑杠。⇒ 这套颜色必须跟着主题走。
   */
  road: { casing: string; casingOpacity: number; rankColors: Record<number, string> };
  /**
   * **2D 降级路**（Canvas2D 自绘）用的调色板。
   *
   * 🔴 为什么必须有这一块（2026-09-20 主会话无头截图发现的割裂感）：
   * 主题原先只写在 MapLibre 的 **style** 上，而**无 WebGL / 低端机走的是 Canvas2D 自绘**
   * —— 那条路的底色是**写死的 `#101820` 深色**。于是一台低端机上会出现
   * 「面包屑/面板/HUD 都是二次元浅蓝白，**中间地图却是黑的**」这种半截子观感。
   * ⇒ 降级路必须读**同一份主题**，不许再自带一套颜色。
   * `bg` 建议等于 3D 那条路的地面色（自检会断言两者够接近，免得两条路像两个世界）。
   */
  canvas: {
    /** 画布底色（降级路的"地面"） */
    bg: string;
    /** 「这一带没有楼房数据」那行字 */
    empty: string;
    /** 真楼轮廓线与线宽（2D 是俯视图，比 3D 细一档才不糊） */
    bldStroke: string;
    bldStrokeW: number;
    /** 示意图元的投影（往右下偏的那块）与轮廓 */
    aiShadow: string;
    aiStroke: string;
    aiStrokeW: number;
  };
  /** 竖向渐变：写实要 true（墙面有明暗）；**平涂要 false**（BA 的楼是一块纯色板） */
  verticalGradient: boolean;
  /** 挤出体不透明度按 zoom 的曲线（远景淡一点 = 大气透视） */
  extrudOpacity: unknown[];
  /** 低端档（`perf.low`）丢什么 —— 帧率优先。
   *  ⚠️ 字段名一律是 `drop*`（**true = 关掉**）。第一版我叫 `sky` / `tint`，语义含糊，
   *  实现里就写反了（低端反而把天空开着）—— 自检抓出来的。名字要能自己说清方向。 */
  low: {
    /** 关掉 `sky` 层 */
    dropSky: boolean;
    /** 描边宽度（`null` = 整条描边层不建）。**为什么不是一律关**：见下面 anime 的注释。 */
    outlineWidth: number | null;
    /** 关掉色罩（少一条全屏 quad） */
    dropTint: boolean;
  };
  /** 各栅格源的**实测**平均亮度（0~1）。自检拿它算地面真实亮度，**不是估值**。 */
  measuredLuma: { base: number; hi: number | null };
  /** 楼/地最小亮度比（`separation=luminance` 时被自检守着） */
  minGroundContrast: number;
  /**
   * 🎮 **观感派生**带上的结构性旋钮（颜色之外的那几件：接触阴影 / 暗角 / 道路加粗 / 如实跳过清单）。
   *
   * 为什么是**可选字段**：基准主题（`NIGHT`/`ANIME`）**不带它** ⇒ 所有老消费者（App 组件、
   * 老自检、`wstheme.json` 的老读取方）**逐字段零影响**；只有 `wsGameLook()` 派生出来的
   * 那一版会填。`?look=2` 之外的一切路径行为不变。
   */
  look?: WsMapLookSpec;
}

/**
 * 🎮 「游戏过场」观感的**结构性**旋钮（纯数据；颜色一律来自主题本身，见 `wsGameLook`）。
 *
 * 为什么这些不放进 `paint` 里：它们**不是某个图层的 paint** ——
 * `shadow` 要开两条新图层、`vignette` 是 DOM 叠加、`road` 要在路网建好之后**再压一档宽度**。
 * 页面按这份数据做，不在页面里写第二套数字。
 */
export interface WsMapLookSpec {
  /**
   * 楼脚印的**接触阴影**（治"楼像漂浮的薄板"）：
   * MapLibre 的 `fill-extrusion` **不投阴影**（没有 shadow map），所以做法是
   * 「把同一份楼脚印**再画一遍**：一层带像素偏移的深色面 + 一层贴边的模糊线」，压在最底下。
   */
  shadow: {
    color: string;
    /** 偏移那层（`fill`）的不透明度 */
    opacity: number;
    /** 贴边那层（`line`）的 `line-blur`（px）—— 越小越"硬" */
    blur: number;
    /** 偏移量（px，屏幕空间；太阳在左上 ⇒ 影子往右下） */
    dx: number;
    dy: number;
    /** 贴边线宽（px） */
    width: number;
  };
  /** 远楼暗角（DOM 叠加层：`radial-gradient`，确定性、不吃手势）。
   *  ⚠️ **近似**：MapLibre 没有屏幕空间后处理 ⇒ 这不是渲染管线里的 vignette，是一层 CSS。 */
  vignette: { color: string; opacity: number; /** 中心透明区半径 % */ inner: number; /** 视角外圈 % */ outer: number };
  /**
   * 路网在主题配色之上**再压一档粗细**（"道路偏细弱"的对策；casing 与 fill 一起加）。
   *
   * `glow` = **霓虹辉光**：同一份 `roads` source 再画一层"宽而模糊的亮线"，压在路芯之下
   * （抄 dev.to 那篇"把曼哈顿变成游戏过场"里**真写了**的做法：一条 source、两层线 ——
   * 下面宽而模糊的辉光 + 上面细而亮的路芯）。`null` = 不做。
   */
  road: {
    casingAdd: number;
    widthScale: number;
    glow: { ranks: number[]; blur: number; opacity: number; widthScale: number } | null;
  };
  /** **如实**记录这一版没做/做不了的项（三态纪律：不许假装做过） */
  skipped: Array<{ k: string; why: string }>;
  /**
   * **如实**记录"做过又撤掉"的项（与 `skipped` 分开：一个是没做，一个是做了发现不对再撤）。
   *
   * 为什么要有这一栏（机主 2026-09-24 拍板后的返工）：第一版照"深底亮线"做了三件
   * 事后被判定为**改美术方向**的东西（压暗地面 / 霓虹辉光 / 远景淡出）。
   * 撤掉必须**留痕** —— 否则下一个人还会照同一个方向再试一遍。
   */
  reverted?: Array<{ k: string; why: string }>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ① 暗色主题（原来的样子 —— **只做了"太暗"那一处的提亮**，其它一律不动）
 * ──────────────────────────────────────────────────────────────────────────── */
const NIGHT: WsMapTheme = {
  id: "night",
  label: "暗色（原来的）",
  hud: "暗色夜景",
  separation: "luminance",
  sky: {
    "sky-color": "#0a1119",
    "horizon-color": "#1b2a3a",
    "fog-color": "#0d1620",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.4,
    "atmosphere-blend": 0.7,
  },
  bg: "#0a1017",
  sources: {
    base: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    hi: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 19,
      attribution: "Sources: Esri, Maxar, Earthstar Geographics",
    },
    ref: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
    },
  },
  raster: {
    base: {
      "raster-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0.92, 16.2, 0],
      "raster-saturation": -0.25,
      "raster-contrast": 0.04,
      "raster-brightness-max": 0.74,
    },
    /* 🔴 就是这里"太暗"。
       原来 `raster-brightness-max: 0.34` + `saturation: -0.4` ⇒ 实测地面亮度只有 **0.117**，
       而低层楼的色阶是 0.187 —— 楼只比地亮 1.6 倍，整屏糊成一块深灰。
       按机主"太暗"的反馈提到 **0.56**（任务书给的 0.5~0.6 区间中部），
       saturation 从 -0.4 收到 **-0.22**（压暗本来就在掉色，再抽饱和就成灰泥了）。
       算出来的地面：0.362 →(对比度 0.10)→ 0.347 →(×0.56)→ **0.194**。 */
    hi: {
      "raster-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 16.2, 0.95],
      "raster-saturation": -0.22,
      "raster-contrast": 0.1,
      "raster-brightness-min": 0.0,
      "raster-brightness-max": 0.56,
    },
    ref: { "raster-opacity": 0.9 },
  },
  tint: null,
  /* 地面提亮到 0.194~0.206 之后，原来的色阶（最暗 `#23323e` = 0.187）就**比地还暗**了
     ⇒ 楼会沉进地面。整条色阶**等比上抬**（同一族：深蓝 → 冰蓝 → 近白），最暗一档 0.322：
       · 对地面 0.206（低 zoom 那层）比值 = 1.56
       · 再算上 `buildingColor()` 的 ±10% 确定性微扰，最坏 0.322×0.9 = 0.290 ⇒ 比值仍有 1.41
     自检里那条"楼/地亮度比 ≥ 1.35"就是钉这个的。 */
  ramp: [
    [3, "#3b566f"],
    [8, "#456a89"],
    [16, "#54809f"],
    [30, "#6394b3"],
    [60, "#7cb0c9"],
    [110, "#9fd0e2"],
    [200, "#c8e9f5"],
    [320, "#eef9ff"],
  ],
  roofFallback: "#1b2833",
  antennaFallback: "#cfe8f5",
  outline: { color: "rgba(190,235,255,0.22)", width: 0.5 },
  /* 沿用原来的 AI 示意层配色（这次不动暗色主题，免得把已有观感弄漂） */
  ai: { park: "rgba(126, 200, 130, 0.42)", water: "rgba(90, 150, 210, 0.42)" },
  /* 暗色**不淡出**：卫星影像 z19 有真细节，淡掉反而更差 */
  baseFade: null,
  /* 路网配色：照抄 `wsRoads.ROAD_RANK_STYLE` 原来的值（暗底那一套），行为一字不变 */
  road: {
    casing: "#0b1017",
    casingOpacity: 0.75,
    rankColors: {
      0: "#e8dcc0", 1: "#dfd2b4", 2: "#c8c0ae",
      3: "#a9b3bd", 4: "#8fa0b0", 5: "#79d9ff",
    },
  },
  /* 2D 降级路：**照抄原来写死在 draw2d() 里的那几个值**，暗色主题行为一字不变 */
  canvas: {
    bg: "#101820",
    empty: "rgba(255,255,255,.7)",
    bldStroke: "rgba(255,255,255,.28)",
    bldStrokeW: 0.7,
    aiShadow: "rgba(40,20,0,.45)",
    aiStroke: "rgba(255,226,170,.6)",
    aiStrokeW: 0.6,
  },
  verticalGradient: true,
  extrudOpacity: ["interpolate", ["linear"], ["zoom"], 12.8, 0.72, 15, 0.86, 17, 0.97],
  low: { dropSky: true, outlineWidth: null, dropTint: true },
  measuredLuma: { base: 0.287, hi: 0.362 },
  minGroundContrast: 1.35,
};

/* ────────────────────────────────────────────────────────────────────────────
 * ② 二次元主题（蔚蓝档案风）
 *
 * 参考物是**我们自己主菜单那套**（天蓝云海 + 白/蓝 UI + 冰蓝高光），不是随便找的动漫。
 * 五条做法，**每条都能单独降级**：
 *   a. 平涂楼体 —— `verticalGradient: false` + 高饱和按高度分档（高楼更白更亮，像 BA 的高光建筑）
 *   b. 描边     —— `bld-line` 改成深藏青细线（1.2px）⇒ 立刻"动画感"
 *   c. 天空     —— 根级 `sky` 做亮天蓝→近白渐变（合法 7 字段）
 *   d. 地面     —— 换 **亮灰底图**（实测 0.937）+ 一层浅蓝**色罩**；**不用卫星**（卫星 = 写实）
 *   e. 大气     —— `fog-color` 用**淡蓝白**（不是暗雾），远景"化开"成亮蓝白
 * ──────────────────────────────────────────────────────────────────────────── */
const ANIME: WsMapTheme = {
  id: "anime",
  label: "二次元（蔚蓝档案）",
  hud: "二次元 · 平涂",
  separation: "outline",
  sky: {
    /* 🎨 2026-09-20 二轮（机主："① 颜色再鲜 ② 整体更亮"）：
       天空换成**彩度更高**的蓝（亮度基本不变、纯度和蓝味都上去了）。 */
    "sky-color": "#72C8F7", // 明亮天蓝（比上一版 #7EC8F0 更纯）
    "horizon-color": "#E8F8FF", // 近白的地平线（略偏青，和地面同调）
    "fog-color": "#D6EEFC", // 🔴 淡蓝白雾，**不是暗雾**：远景要"化开"成亮的
    /* 🎨 二轮+（机主："要能看见天空（基沃托斯的天空）"）：
       把**地平线那圈白雾带**调明显 —— `horizon-fog-blend` 抬到 0.65 让近白的雾色
       往天上多铺一点，`fog-ground-blend` 抬到 0.75 让雾和地面交界更"化开"。
       ⚠️ **没验**：MapLibre 文档写着 `fog-color` 需要 **3D 地形**（"Requires 3D terrain"），
          而我们**没接 terrain** ⇒ 这圈雾带到底画不画得出来，**没有真机图不敢说**。
          真正一定生效的是 `sky-color`/`horizon-color` 那条天空渐变（天空层本身）。 */
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.65,
    "atmosphere-blend": 0.85,
    "fog-ground-blend": 0.75,
  },
  bg: "#E8F8FF", // 近白兜底：`sky` 万一没生效，背景也不会是黑的
  sources: {
    /* 「亮灰底图」而不是卫星：卫星照片再调都是**写实**，跟平涂天生打架。
       实测这套服务 z14/z16 是**真内容**（7265/5753B，亮度 0.937），z17 变 2521B 占位图
       ⇒ 所以 maxzoom 必须钉在 16（让地图库放大复用 z16，别去要占位图）。 */
    base: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    hi: null, // ← 二次元**没有高分层**（不用卫星）。少一层 = 少一份流量，低端档也轻松
    ref: {
      /* 注记要和底图配套：亮底必须用**浅灰系列**的注记（深字），
         继续用 `Dark_Gray_Reference`（浅字）会变成"白字压白底"= 等于没字。
         ⚠️ 实测（涪陵 z16）：这套注记瓦片是 **872B 全透明**（那个点位本来就没标注）
         ⇒ "有没有字"这件事**这一轮没验成**，别当成"标签已修好"。 */
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
    },
  },
  raster: {
    /* 底图源本身已经 0.937（很亮），所以这里**不再上提**，只用对比度拉一点层次：
       0.937 →(对比度 0.08, 绕 0.5)→ 0.975 →(×0.96 压一点点)→ **0.936**。
       为什么要压：不压的话地面跟最亮的楼（`#E8F6FF`）一样白，画面会"过曝"。
       色罩再叠上去 → 最终地面 **0.919**（见 `tint` 的注释）。 */
    base: {
      /* 🎨 二轮：亮度**拉满到 1.0**（上一版 0.96 还压着一档）、对比再降一点（更平更干净）、
         彩度 0.15 → 0.55。⚠️ 底图是灰度的，"加彩度"加不出颜色来（灰上加饱和还是灰）——
         真正给地面**上色**的是下面那层 `tint`；这里加彩度是为了让瓦片里本来就有色的部分
         （绿地/水面在灰度图里也带一点点色偏）更明显。 */
      "raster-opacity": 1,
      "raster-saturation": 0.55,
      "raster-contrast": 0.06,
      "raster-brightness-max": 1.0,
    },
    hi: null,
    ref: { "raster-opacity": 0.85 },
  },
  /* 色罩：`background` 图层 + **冷青** + 0.45 不透明度（上一版是 0.35 的 `#CFE6F7`）。
     "去灰"靠的就是这一层：底图是灰的，**只有盖颜色才上得了色**
     （在灰度上做色相旋转是空操作）。
     🎨 二轮改动：颜色偏青（`#BCE7F8`）、不透明度 0.35→0.45 ⇒ 彩度明显上去、又仍然很亮。
     算式（自检直接跑公式，不认嘴）：底图 0.937 →(对比度 0.06)→ 0.965 →(×1.0)→ 0.965，
     再叠 45% 的 `#BCE7F8`（亮度 0.875）⇒ 地面 = 0.965×0.55 + 0.875×0.45 = **0.924**。 */
  tint: { color: "#BCE7F8", opacity: 0.45 },
  /* 平涂三档：矮 → 中 → 高（高楼**更白更亮**，像 BA 里打了高光的塔楼）。
     注意这里**不是**明度递进拉开"楼比地亮"——BA 的地本来就亮（0.919），
     楼和地是靠**描边**分开的（`separation: "outline"`）。 */
  /* 🎨 二轮：整体**更鲜 + 更亮**（机主 ①②）。做法是"每一档都往亮里推、同时把彩度拉起来"，
     而不是"把暗的调更暗" —— 后者会让楼离地面更远，但也更脏、更不像 BA。
     ⚠️ 这条色阶**不可能**满足"楼体最暗档 / 地面 > 1.35"：
        地面 0.924 ⇒ 要过 1.35 就得有 0.924×1.35 = **1.248**，而白色的上限是 **1.0**。
        ⇒ 二次元主题的分隔手段**声明为描边**（`separation: "outline"`，见下），
          自检守的是"描边对地面 ≥3:1"而不是明度比。这是风格差异，不是漏做。 */
  ramp: [
    [3, "#BCE4F9"], // 矮楼：淡天蓝
    [12, "#AEDDF7"],
    [25, "#A2D8F6"], // 中：BA 的主蓝
    [45, "#BCE4F9"],
    [70, "#D6EFFC"],
    [110, "#EBF7FE"], // 高/塔楼：近白（高光）
    [200, "#F6FCFF"],
    [320, "#FFFFFF"],
  ],
  roofFallback: "#A8DBF5",
  /* 屋顶压顶在 BA 风里**不能压暗**（那套做法是写实的"女儿墙"）——
     改成**更浅**的一档，读起来就是"楼顶被光照到"，还是平涂。 */
  antennaFallback: "#FFFFFF",
  /* 描边：**二轮加重**（机主 ③）—— 1.2px → **1.8px**、颜色更深（`#2C4A63` → `#1B3550`）。
     为什么敢加重：BA 风里**这是楼与地唯一的分隔手段**（地面 0.924 本来就比矮楼亮，
     明度差是负的）⇒ 描边越清楚，"楼立起来"的感觉越强。自检按 WCAG 1.4.11
     （非文字图形 ≥ 3:1）算，实测对这层地面是 **10.6:1** —— 余量很大，
     所以机主就算再说"再重一点"，直接调 `outline.width` 到 2.2 也不会糊成一片。 */
  outline: { color: "#1B3550", width: 1.8 },
  /* AI 示意层：水体换成**明亮青蓝**（机主 ④"水体换色"），公园淡绿。
     ⚠️ 只有"示意水体"能这么染；**真实江面在灰度底图里，染不了**（见 `ai` 字段的说明）。 */
  ai: { park: "rgba(150, 214, 160, 0.45)", water: "rgba(79, 195, 234, 0.5)" },
  /* 🔴 治「地面太糊」：**z13.6 起淡出、z14.8 起完全不用照片**（小区级默认 16.4 ⇒ 全在淡出之后）。
     淡出后露出的是 `bg` + `tint` 合成出来的浅青地面 —— 它的亮度（0.922）
     和"有瓦片时"（0.924）**只差 0.002** ⇒ 过渡不会"咔"一下变个色（这是刻意的：我当初把
     `tint` 调成 0.45 就是为了让两种情况落在一起）。自检里有一条钉这个 Δ。 */
  baseFade: { from: 13.6, to: 14.8 },
  /* 路网：浅底那一套 —— **路芯近白 + 蓝灰描边**（BA/地图 App 的常见做法：
     靠描边把路"勾"出来，而不是靠路芯比地面亮）。描边 `#8FBBD4` 比地面暗一档 ⇒ 看得见。 */
  road: {
    casing: "#8FBBD4",
    casingOpacity: 0.9,
    rankColors: {
      0: "#FFFFFF", 1: "#FBFDFF", 2: "#F4FAFE",
      3: "#EBF5FC", 4: "#E3F1FA", 5: "#7FD4F0",
    },
  },
  /* 2D 降级路：底色取**和 3D 地面同一个色**（`#DCEFF7`，就是 `groundHex(anime)` 算出来的那个），
     描边取和 3D 同族的深藏青 —— 这样低端机看到的和满血机是"同一座城"，
     而不是"浅蓝界面 + 黑地图"。 */
  canvas: {
    bg: "#DCEFF7",
    empty: "rgba(27,53,80,.75)",
    bldStroke: "#1B3550",
    bldStrokeW: 1.2,
    aiShadow: "rgba(44,74,99,.22)",
    aiStroke: "rgba(27,53,80,.5)",
    aiStrokeW: 0.8,
  },
  verticalGradient: false, // ← 平涂的关键：关掉竖向渐变，楼是一块纯色板
  extrudOpacity: ["interpolate", ["linear"], ["zoom"], 12.8, 0.8, 15, 0.92, 17, 1],
  low: {
    dropSky: true,
    /* 🔴 这里和任务书"低端关描边"**故意不一致**，理由要写清楚：
       BA 风里地面(0.919)和楼(0.87~1.0)明度几乎一样 ⇒ **描边是唯一的分隔手段**。
       低端档真把描边关了，楼会整片"化"进地面（比掉几帧难看多了）。
       所以低端只把它**变细到 0.6px**（同样是一条 line 层，要素数没变，省的是像素填充）。 */
    outlineWidth: 0.6,
    dropTint: true,
  },
  measuredLuma: { base: 0.937, hi: null },
  /** 二次元靠描边分隔 ⇒ 明度比这条不变量**不适用**（设 1.0 = 只要不比地暗就行） */
  minGroundContrast: 1.0,
};

/** 全部主题。**加新主题只动这里**，组件不用改。 */
export const WS_MAP_THEMES: Record<WsMapThemeId, WsMapTheme> = { night: NIGHT, anime: ANIME };

/** 认不出来的 id 一律回默认 —— **不抛异常**：主题坏了不该让整张地图白屏 */
export function wsMapTheme(id: string | null | undefined): WsMapTheme {
  const k = String(id || "") as WsMapThemeId;
  return WS_MAP_THEMES[k] || WS_MAP_THEMES[WS_MAP_THEME_DEFAULT];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 🗺 候选底图（页面 `?bm=<id>`）—— **不给参数 = 逐字段与原来一样**
 * ══════════════════════════════════════════════════════════════════════════
 * 机主原话（2026-09-26）：「**放太大了只能看到线路，水，绿植啥的都看不到**」。
 *
 * ## 🔴 先说清"换底图"这件事为什么必须带证据（两条血泪）
 * ① 底图源与**亮度基准**是绑在一起的：`measuredLuma.base` 是 `rasterBrightness()/groundLuma()/
 *    groundHex()` 唯一的输入，它一错，"地面多亮"就全错，楼/地明度关系与描边对比度跟着错。
 * ② 2026-09-25 有人把底图换成 `World_Street_Map` 但**没动基准** ⇒ 机主看到「地图直接变白/没了」，
 *    当天 revert。我 2026-09-26 逐档 curl 才量出**真因不是亮度基准**：
 *      · `World_Street_Map` / `World_Topo_Map` 在这一带 **z≥14 只返回 2521 字节的占位图**
 *        （ArcGIS 的 "Map data not yet available"，四个服务返回的是**同一张图**，sha256 相同）；
 *      · 页面默认机位是 **z16.4** ⇒ 整屏都是占位图 ⇒ 那才是"变白"。
 *    ⇒ 规矩：**每个候选必须带 `realZooms`（curl 实测过有真内容的档位）**，
 *      `source.maxzoom` 不许超过它的上界 —— 自检会断言（写死在代码里，不靠人记得）。
 *
 * ## 亮度基准怎么来的（不是估的）
 * 每个候选的 `measuredLuma` / `measuredRgb` 都是把 curl 下来的**真瓦片逐像素**量出来的
 * （口径 = Rec.709，带 alpha 加权；脚本 `~/chk/bm_tile_probe.py`）。实测（SPOT 渝中区）：
 *
 * | 服务 | 真内容档 | 平均亮度 | 均 RGB | 彩色像素占比 |
 * |---|---|---|---|---|
 * | `Canvas/World_Light_Gray_Base`（现状） | z11/13/15/16（z17 占位） | 0.9274 | (237,237,237) | **0.000** |
 * | `World_Topo_Map`（候选 topo） | z11/13（z14+ 占位） | 0.8849 | (222,227,226) | 0.067~0.262 |
 * | `World_Street_Map`（候选 street） | z11/13（z14+ 占位） | 0.7921 | (219,200,177) | 0.793~0.839 |
 * | `World_Imagery`（候选 imagery） | z11/13/16/17 | 0.3714 | (99,95,78) | 0.74~0.99 |
 *
 * 📌 **彩色像素占比 = 0.000** 就是"看不到绿植"的**数字证据**：现用底图（灰度）里一个有色像素都没有
 *    —— 在灰度上做色相旋转、加饱和度**都是空操作**，再怎么调参数也调不出植被色（这一点本文件
 *    下面的 `ai` 字段注释早就写过，现在有了实测数）。
 *
 * ## 为什么这些候选**只在页面**（`?bm=`）而不改默认
 * 观感只有机主真机能判（本机无头无 WebGL）。所以这里只**提供可对比的候选**，
 * 默认路径（不给 `?bm`）**逐字段不走这里**（`withBasemapCandidate(t, null) === t`，同一对象）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个候选底图（**纯数据**；颜色/亮度/淡出/署名全在这里，页面不许自己写第二份） */
export interface WsBasemapCandidate {
  id: string;
  label: string;
  /** HUD 上那一行（机主看得懂的话） */
  hud: string;
  /** 这个候选想解决什么（写清楚，免得下一个人以为它是随便加的） */
  why: string;
  /** 栅格源（**必须**带 attribution —— 换源不许把署名弄丢） */
  source: WsMapRasterSource;
  /** 栅格 paint。**不给 = 沿用主题那一份**（对照候选就靠这个做到"逐字段 = 现状"） */
  raster?: WsMapRasterPaint;
  /** 色罩"留多少"（1 = 与主题一致，0.35 = 只留三成）。**颜色仍取自主题**，这里只说比例 */
  tintScale?: number;
  /** 高 zoom 淡出。**不给 = 沿用主题**；`null` = 全程不淡出（默认机位也要看得见瓦片） */
  baseFade?: { from: number; to: number } | null;
  /** 实测平均亮度（0~1）。不给 = 沿用主题那一个（对照候选） */
  measuredLuma?: number;
  /** 实测平均色（0~255，仅存档/自检用；地图库的 `raster-*` 只吃亮度） */
  measuredRgb?: [number, number, number];
  /** 🔴 **curl 实测**有真内容的档位（占位图不算）。`source.maxzoom` 必须 ≤ 这里最大值 */
  realZooms: number[];
  /** 逐档实测证据（HTTP/字节/是否 2521B 占位图）—— 报告与自检都读它 */
  evidence: string;
  /** 如实写清这个候选的代价/未知（三态纪律：不把没验的写成好的） */
  risk?: string;
}

/** 占位图字节数（ArcGIS "Map data not yet available"）。**换源前必须比对这个数**。 */
export const WS_TILE_PLACEHOLDER_BYTES = 2521;

/**
 * 候选表。`gray` 是**对照组**（= 现状那一张），靠"raster/baseFade/measuredLuma 全不给"
 * 做到与主题逐字段一致 ⇒ 自检能断言"开关机制本身是零改动"。
 */
export const WS_BASEMAP_CANDIDATES: Record<string, WsBasemapCandidate> = {
  gray: {
    id: "gray",
    label: "对照·现状（灰度）",
    hud: "底图对照 = 现状（灰度，无植被/水体色）",
    why: "对照组：与主题逐字段一致（用来证明 ?bm 开关本身不改任何东西）",
    source: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    realZooms: [11, 13, 15, 16],
    evidence:
      "z11 200/10951B 否 · z13 200/12492B 否 · z15 200/15115B 否 · z16 200/9370B 否 · z17 200/2521B **是占位图** " +
      "⇒ maxzoom 必须 ≤16（沿用主题现值）",
    risk: "实测彩色像素占比 0.000（纯灰度）⇒ 这张底图**永远调不出植被/水体色**（在灰度上做色相/饱和是空操作）",
  },
  gray16: {
    id: "gray16",
    label: "对照·灰底图不淡出",
    hud: "底图对照 = 同一张灰底图，但**默认机位不淡出**（分离变量用）",
    why:
      "把「看不见瓦片」和「瓦片没颜色」两个原因**分开**：这一档只改淡出（源与主题同一张），" +
      "用来证明机主在默认机位看到的是「纯色地面」而不是「灰瓦片」",
    source: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 16,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    baseFade: null,
    measuredLuma: 0.9274,
    measuredRgb: [237, 237, 237],
    realZooms: [11, 13, 15, 16],
    evidence: "同 gray（z16 真图 9370B、z17 2521B 占位）⇒ z≤16 有真图、默认机位 z16.4 用 z16 放大即可",
    risk: "仍是灰度 ⇒ 只解决「看不看得见瓦片」，**不解决「有没有绿植」**",
  },
  topo: {
    id: "topo",
    label: "候选·地形图（有绿/水）",
    hud: "底图候选 = 地形图（**有植被绿 / 水体蓝**，但本区最高只到 z13）",
    why: "机主要的「看得到水/绿植」：这张底图**真的有**植被色与水体色（实测彩色占比 6.7%~26%）",
    source: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      ],
      /* 🔴 13 是**实测上限**：z14 起全是 2521B 占位图。写 13 让地图库把 z13 放大复用
         （略糊，但远好过整屏占位图 —— 上次换源的翻车就是这么来的）。 */
      maxzoom: 13,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    raster: {
      "raster-opacity": 1,
      "raster-saturation": 0.55,
      "raster-contrast": 0.06,
      "raster-brightness-max": 1.0,
    },
    /* 彩色底图再压 45% 的青罩会把绿/蓝洗掉 ⇒ 色罩只留三成五（**颜色仍取自主题**）。 */
    tintScale: 0.35,
    /* 全程不淡出：默认机位（街区级）也要看得见这张底图 —— 淡出正是"看不到水/绿植"的一半原因。 */
    baseFade: null,
    measuredLuma: 0.8849,
    measuredRgb: [222, 227, 226],
    realZooms: [11, 13],
    evidence:
      "z11 200/31960B 否 · z13 200/28164B 否 · z14 200/2521B **是占位图** · z15 200/2521B **是** · " +
      "z16 200/2521B **是** · z17 200/2521B **是**（与另外三个服务返回的是同一张图：sha256 9eafd300…）",
    risk:
      "本区最高只到 z13 ⇒ 默认机位（z16.4）是 **3.4 档过放大**（糊；要清晰需把机位拉到 z≤14）。" +
      "⚪ 未验：它自带地名，主题的注记层（Light_Gray_Reference）是否与它重叠 —— 只有真机图能判",
  },
  street: {
    id: "street",
    label: "候选·街道图（有绿/水）",
    hud: "底图候选 = 街道图（暖色路网 + 绿/水；**上次「变白」的元凶**，留作反面对照）",
    why:
      "2026-09-25 换它导致「地图变白」的那一张。现在有实测：真因是 **z≥14 占位图**（不是亮度基准），" +
      "所以这一档把 maxzoom 钉在 13 再放一次，用作「占位图」教训的对照",
    source: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 13,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors",
    },
    raster: {
      "raster-opacity": 1,
      "raster-saturation": 0.35,
      "raster-contrast": 0.04,
      "raster-brightness-max": 1.0,
    },
    tintScale: 0.3,
    baseFade: null,
    measuredLuma: 0.7921,
    measuredRgb: [219, 200, 177],
    realZooms: [11, 13],
    evidence:
      "z11 200/47702B 否 · z13 200/38743B 否 · z14 200/2521B **是占位图** · z15 200/2521B **是** · " +
      "z16 curl 失败(rc=56) · z17 200/2521B **是**",
    risk: "路网是大面积暖橙（饱和度 0.79~0.84）⇒ 与 BA 平涂风格的冲突比 topo 大；同样只到 z13",
  },
  imagery: {
    id: "imagery",
    label: "候选·卫星影像",
    hud: "底图候选 = 卫星影像（**唯一撑到 z17 的**；写实，改美术方向）",
    why:
      "本机网络实测里**唯一**在 z17 仍有真图的栅格源（水体/植被都是真的），" +
      "留作「要清晰又要真色」的兜底；但它是写实路线，与 BA 平涂冲突 ⇒ 要不要它属于**美术方向**，得机主定",
    source: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      maxzoom: 19,
      attribution: "Sources: Esri, Maxar, Earthstar Geographics",
    },
    raster: {
      "raster-opacity": 1,
      "raster-saturation": 0.3,
      "raster-contrast": 0.08,
      "raster-brightness-min": 0.18,
      "raster-brightness-max": 1.0,
    },
    /* 卫星本来就暗且写实 ⇒ 不再叠 BA 的青罩（叠了就是"糊上一层蓝"）。 */
    tintScale: 0,
    baseFade: null,
    measuredLuma: 0.3714,
    measuredRgb: [99, 95, 78],
    realZooms: [11, 13, 16, 17, 18, 19],
    evidence:
      "z11 200/20536B 否 · z13 200/17067B 否 · z15 curl 超时(rc=28) · z16 200/17301B 否 · z17 200/12718B 否 · " +
      "z18 200/10424B 否 · z19 200/10598B 否 ⇒ 实测到 z19 都有真图（唯一撑过 z17 的服务）",
    risk:
      "写实影像 + 实测亮度 0.371（BA 亮底目标 0.92）⇒ **色调与二次元主题冲突**；" +
      "抬到 BA 的亮度需要 brightness-min 0.18 以上，会把远处糊成灰雾（本次未做真机确认）",
  },
};

/** 候选 id 列表（页面徽标/自检用） */
export function wsBasemapIds(): string[] {
  return Object.keys(WS_BASEMAP_CANDIDATES);
}

/**
 * 从 URL 读候选底图（`?bm=topo`）。返回 `null` = "URL 没说"或"认不出的 id"
 * （**认不出不许当默认候选用** —— 宁可什么都不换，也别悄悄换一张底图）。
 */
export function parseWsBasemapParam(search: string | null | undefined): string | null {
  try {
    const v = new URLSearchParams(String(search || "")).get("bm");
    if (!v) return null;
    return v in WS_BASEMAP_CANDIDATES ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把一个候选底图**套到主题上**（纯函数）。
 *
 * 🔴 `id` 为空/认不出 ⇒ **原样返回入参那一个对象**（`===` 成立）。
 *    这是"默认行为一个字节都不许变"的**结构性保证**：默认路径根本不进这个函数的分支，
 *    不靠"我记得别改"。
 *
 * 只覆盖这五个字段（其余一律不动 —— 楼体色阶/描边/路网/AI 层都不是底图的事）：
 *   `sources.base` · `raster.base` · `tint`（按 `tintScale` 缩放**不透明度**，颜色仍取自主题）·
 *   `baseFade` · `measuredLuma.base`，外加 `label`/`hud` 两行给人看的字。
 */
export function withBasemapCandidate(theme: WsMapTheme, id: string | null | undefined): WsMapTheme {
  const c = id ? WS_BASEMAP_CANDIDATES[String(id)] : null;
  if (!c) return theme;
  const tint = theme.tint
    ? { color: theme.tint.color, opacity: +(theme.tint.opacity * (c.tintScale === undefined ? 1 : c.tintScale)).toFixed(4) }
    : null;
  return {
    ...theme,
    label: `${theme.label} · 底图 ${c.label}`,
    hud: c.hud,
    sources: { ...theme.sources, base: c.source },
    raster: c.raster ? { ...theme.raster, base: c.raster } : theme.raster,
    tint,
    baseFade: c.baseFade === undefined ? theme.baseFade : c.baseFade,
    measuredLuma: c.measuredLuma === undefined ? theme.measuredLuma : { ...theme.measuredLuma, base: c.measuredLuma },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 🎮 「游戏过场」观感：**由基准主题派生**出来的第二版（代拍页 `?look=2`）
 * ══════════════════════════════════════════════════════════════════════════
 * 机主原话（2026-09-24 早）：「**这个好难看，去网上学**」⇒ 第一版做成了"深底亮线"。
 *
 * 🔴 **机主当天真机点开后的裁定（本文件最重要的一段）**：
 *    原话「**代拍页的地图底都看不清了，还有就是配色为什么把 BA 风格改喵了！**」
 *    ⇒ 处理方式 = **保留结构、配色拉回 BA**：地面恢复亮底，只留接触阴影 / cel 硬边 / **弱**暗角。
 *
 * ## 🩸 教训（写死在代码里，免得下一个人照同一个方向再试一遍）
 * **派生观感只能"加结构"，不许改机主拍板的美术方向。**
 * BA 的"亮底 + 深藏青描边 + 平涂"是机主拍板并已验收过的美术（见 `ART-STUDY.md`）；
 * 我把地面明度从 0.924 压到 0.361，属于**擅自改美术方向** —— 更讽刺的是，
 * **我自己的调研里就写着**：Mini Tokyo 3D 的地面**也是近白**（`hsl(20,20%,98%)`），
 * 它的游戏感来自**纵深**，不是"深底"。我拿"深底亮线"当 MT3D 的事实，方向一开始就选错了。
 * ⇒ 派生件只准动两处：`ramp`（**分档形式**）与 `look`（**新增的结构层**）；
 *    颜色类字段一律**逐字段等于基准**，并由自检守着（"低于基准即红"）。
 *
 * ## 这一版到底改了什么（只有两项，别再多）
 * ① `ramp`：8 档平滑 → **3 档硬边（cel）**，而且**三档色全部从基准色阶里挑**
 *    （`base.ramp` 的第 1 / 3 / 6 档，停靠点也跟着基准走）⇒ **一个新色号都没有**，
 *    最暗档也**不低于**基准的最暗档（楼体不许被压暗）；
 * ② `look`：**新增的结构层** —— 楼脚印接触阴影（面 + 贴边线）/ **弱**暗角 / 道路 casing+路芯加粗；
 *    它们的取色全部由**基准色**派生（阴影 = 基准暗锚点往基准底色提一点，暗角 = 基准暗锚点）。
 * 其余字段（`bg`/`tint`/`raster`/`sky`/`outline`/`road`/`canvas`/`baseFade`/`verticalGradient`/
 * `extrudOpacity`/`low`/`separation`/`minGroundContrast`/`measuredLuma`）**逐字段原样**
 * —— 代码上就是"只覆盖 ramp/label/hud/look 四个键"，自检里另有逐字段断言。
 *
 * ## 抄了谁（抄的是**做法**不是素材；每条都对着我真取到的内容写）
 * · **cel shading**（Flax 的 cel-shading 文档 + `buggzeth/three-js-toon-shader`）：平涂块面只要
 *   **三档**（Highlight / Key / Shadow）+ 档与档之间**硬边**。⚠️ Flax 的 0.9 / 0.4 是 **NoL 空间**的
 *   阈值，**不能照抄到"米"上** ⇒ 只抄"三档"这个数量，档位用基准色阶自己的楼高停靠点。
 * · **Mini Tokyo 3D**（`assets/style.json`，157 层逐字段读的）：楼体挤出**只有一档纯色**，
 *   道路是 **casing/fill 一对**（同色系、亮度低一档）—— 后者对应本版的"路加粗"。
 *   ⚠️ 它的 `fill-extrusion-vertical-gradient` 那条**没采纳**：BA 是机主拍板的**平涂**（渐变关），
 *   受光/背光改用 **cel 分档**表达（同一需求，结构手段，不动美术方向）。
 * · **Mapbox cartography 指南**（官方 skill 文档；那份 PDF 取不到，**不以它为依据**）：
 *   非文字图形 **WCAG 4.5:1**、层级顺序（background→building→road→label）。
 * · **dev.to「把曼哈顿变成游戏过场」**：它**真写了**的只有相机（pitch 73~79；⚠️ 相机不归这版管）
 *   与"霓虹路 = 同一份 source 两层线"。⚠️ **霓虹辉光已撤**（见 `look.reverted`）。
 *
 * ⚠️ **能力边界**（style-spec 逐字段核过）：MapLibre **没有**根级 `fog`、
 *    没有 `fill-extrusion-ambient-occlusion-*`、**没有屏幕空间后处理** ⇒
 *    真阴影 / 真暗角**做不了**，本版用"楼脚印薄层 + DOM 径向渐变"**近似**，徽标里如实标。
 *
 * ## 🔴 为什么是"派生"而不是"再写一套色板"
 * 项目纪律：**配色只有一个真源**（本文件）。所以派生件里出现的每个颜色，要么**就是**基准色，
 * 要么是**基准色之间的混合**（`mixHex(基准色, 基准色, 系数)`）。自检用两条钉它：
 * ① 配色类字段逐字段等于基准；② 把基准色换成探针色 ⇒ 派生色必须跟着变。
 */
export type WsMapLookId = "base" | "game";

/**
 * 两个 `#rrggbb` 按 `t` 线性混合（`t=0` ⇒ a，`t=1` ⇒ b）。
 *
 * 🔴 在 **sRGB（伽马）空间**混合，和 `groundHex()` 的色罩合成**同一把尺子** ——
 * 拿"解过伽马"的空间混合，算出来的地面亮度会和自检对不上（两套尺子的老坑）。
 * 认不出颜色（`rgba()` 之类）就**原样返回 `a`**：派生/诊断件不该把页面搞崩。
 */
export function mixHex(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-fA-F]{6})$/.exec(String(a || "").trim());
  const pb = /^#?([0-9a-fA-F]{6})$/.exec(String(b || "").trim());
  if (!pa || !pb) return a;
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const mix = (sh: number): string =>
    Math.max(0, Math.min(255, Math.round(((na >> sh) & 255) + (((nb >> sh) & 255) - ((na >> sh) & 255)) * k)))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(16)}${mix(8)}${mix(0)}`;
}

/** 派生主题的 id 后缀（`wstheme.json` 的 `looks.game.<主题 id>` 用的就是这份数据） */
export const WS_GAME_LOOK_ID: WsMapLookId = "game";

/**
 * 🔴 **地面明度的允许偏差 ε**（自检与徽标共用这一个数，别在两处各写一个）。
 *
 * 机主 2026-09-24 拍板："派生观感**不许降低地面明度**、不许换色系"。
 * 判据两条（都在 `ws_map_theme_selftest.mjs` 里）：① `|派生 − 基准| ≤ ε`；
 * ② **派生 < 基准 ⇒ 红**（哪怕只低一点点）。ε 留一点余量只是为了将来"想提亮一点点"这种正当改动，
 * **绝不允许**用它来合法化"压暗地面"。
 */
export const WS_GAME_LOOK_GROUND_EPS = 0.02;

/**
 * 🎮 由**基准主题**派生"游戏过场"观感（纯函数：同一个输入永远同一个输出，无随机、无时间）。
 *
 * 只覆盖 4 个键：`label` / `hud`（文案）、`ramp`（分档形式）、`look`（结构层）。
 * **颜色类字段一个都不覆盖** —— 见文件头那段教训。
 *
 * @param base 基准主题（`ANIME` / `NIGHT` / 夜色变体都行）
 */
export function wsGameLook(base: WsMapTheme): WsMapTheme {
  /* 结构色的**锚点**（从基准主题里按亮度挑，不新写色号）：
     · 暗锚点 = 这套主题里最暗的纯色（anime 是描边那个深藏青 `#1B3550`）—— 亮底上的阴影必须够暗；
     · 亮锚点 = 天顶色够亮就用它，不够亮（night 的天顶近黑）退到"主题里最亮的色"。
     两个都按**亮度**挑（不是按字段位置）⇒ 换主题不会挑出一个暗的当亮线。 */
  const hexes = (...cs: unknown[]): string[] =>
    cs.filter((c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ""))) as string[];
  /** 候选里**最暗**的一个（空表退回 `base.bg`，绝不抛） */
  const darkest = (cs: string[]): string => cs.slice().sort((a, b) => gammaLuma(a) - gammaLuma(b))[0] || base.bg;
  /** 候选里**最亮**的一个 */
  const brightest = (cs: string[]): string =>
    cs.slice().sort((a, b) => gammaLuma(b) - gammaLuma(a))[0] || base.antennaFallback;
  const skyOf = (base.sky || {}) as Record<string, unknown>;
  const deep = darkest(hexes(base.outline.color, base.roofFallback, base.ramp[0]?.[1], base.bg, base.canvas.bg));
  const glowTop = String(skyOf["sky-color"] || "");
  const glow = gammaLuma(glowTop) >= 0.5 ? glowTop : brightest(hexes(base.antennaFallback, base.ramp[base.ramp.length - 1]?.[1], glowTop));
  const white = brightest(hexes(base.antennaFallback, base.ramp[base.ramp.length - 1]?.[1], base.roofFallback));

  /* 🧱 ① cel 三档：**档位色与停靠点全部取自基准色阶**（第 1 / 3 / 6 档）——
     一个色号都没新造，而且"最暗档"必然 ≥ 基准色阶的最暗档（楼体只会更亮，不会更暗）。 */
  const pick = (i: number): [number, string] => base.ramp[Math.max(0, Math.min(base.ramp.length - 1, i))]!;
  const ramp: Array<[number, string]> = [pick(0), pick(2), pick(5)];

  /* 🧱 ② 结构层的取色（都是**基准色之间的混合**）：
     · 接触阴影：基准暗锚点往基准底色提一点（亮底上纯黑的影子会像第二圈描边）；
     · 弱暗角：就用基准暗锚点本身，**强度靠 opacity 压到 0.18**（第一版 0.5 被机主判"底都看不清了"）。 */
  const shadowColor = mixHex(deep, base.bg, 0.18);

  return Object.assign({}, base, {
    label: base.label + " · 游戏过场",
    hud: base.hud + " · 游戏过场（cel 三档 + 接触阴影）",
    ramp,
    look: {
      shadow: { color: shadowColor, opacity: 0.42, blur: 6, dx: 3, dy: 4, width: 1.1 },
      vignette: { color: deep, opacity: 0.18, inner: 55, outer: 100 },
      /* 路：**只加粗**（casing 与路芯一起加，取色仍走基准 `road` 调色板）；
         霓虹辉光 = `null`（撤了，原因见下面 `reverted`）。 */
      road: { casingAdd: 2.2, widthScale: 1.25, glow: null },
      skipped: [
        {
          k: "水体（渐变 / 高光边）",
          why:
            "**没有水系矢量源**：本页只取 `/api/buildings`、`/api/roads`；" +
            "`hydro.rs` 那套 Natural Earth 1:50m 只喂行政区划 SVG，且区级实测 0 环 " +
            "⇒ 江面在底图里只是**栅格像素**，无法单独上色/描边。要做得先有水的矢量数据（另一张卡）。",
        },
        {
          k: "真阴影（投影遮挡）",
          why: "MapLibre 的 fill-extrusion **不投阴影**（无 shadow map）⇒ 本版用楼脚印深色薄层 + 贴边模糊线**近似**，不是真阴影。",
        },
      ],
      reverted: [
        {
          k: "压暗地面（第一版的「深底亮线」）",
          why:
            "**机主 2026-09-24 裁定**：「代拍页的地图底都看不清了」⇒ 地面回到 BA 亮底" +
            "（`bg`/`tint`/`raster` 逐字段等于基准）。而且我自己的调研就写着 MT3D 地面**也是近白** " +
            "⇒「深底」不是 MT3D 的事实，是我选错了方向。**派生件不许改机主拍板的美术方向。**",
        },
        {
          k: "霓虹辉光（`road-glow-*`）",
          why:
            "**撤了**：它在「深底」前提成立时才有意义 —— BA 亮底上白色辉光与地面**同明度** ⇒ " +
            "既看不见、又把路缘糊掉（**降低可读性**）。机制仍在数据里（`look.road.glow`，" +
            "`null` = 不建层），要开只需改数据；页面那条路有自检守着（注入 glow 数据 ⇒ 层必须建出来）。",
        },
        {
          k: "远景淡出（大气透视）",
          why:
            "**撤回基准值**（`extrudOpacity` 逐字段等于基准）：亮底上把远景楼调透明 = 楼「化」进地面，" +
            "与机主「底要看得清」的诉求相反；它也不在机主的保留清单里（清单 = 接触阴影 / cel 硬边 / 路 casing）。",
        },
        {
          k: "楼体竖向渐变（受光面/背光面）",
          why:
            "**撤回基准值**（`verticalGradient` 保持 false）：BA 的**平涂**是机主拍板的美术方向，" +
            "「受光/背光」改用 **cel 分档**表达（结构手段），不再动渐变。",
        },
      ],
    },
  });
}

/**
 * 🛰 **预渲染瓦片的调色板**（机主 2026-09-24：「采用近距离渲染，**远距离预渲染**的方式…」）。
 *
 * 为什么放在主题文件里：LOD 的"远处"是一张张**烘焙好的图**，颜色一旦写死在生成脚本里，
 * 就变成了**第二套配色** —— 改主题时它会静默留在旧色上（这个项目为"两份"付过代价）。
 * ⇒ 调色板**派生**自主题本身（和 `wsGameLook()` 同一套做法：挑锚点、不新写色号）。
 *
 * 🔴 口径（**改主题 ⇒ 瓦片跟着变**）：`world_map/make_prerender_tiles.mjs` 用本函数取色，
 *    改完主题**必须重跑它**；`ws_lod_selftest.mjs` 会拿清单里的指纹与"现在从模块算出来的"
 *    逐字节对拍 ⇒ 忘了重跑就红（不是靠人记得）。
 *
 * ⚠️ 骨架阶段这套色画的是**示意**瓦片（假几何），只为证明"切换/过渡/回证"成立；
 *    真实楼脚印 + 路网的离线管线是**第 2 步**（另一张卡）。
 */
export interface WsPrerenderPalette {
  /** 地面（= 色罩合成后的那个色，与 `metrics.groundHex` 同一把尺子） */
  ground: string;
  /** 楼块的几档（从主题高度色阶里挑：矮 / 中 / 高） */
  blocks: string[];
  /** 楼轮廓（主题描边色；可能是 `#rrggbb` 也可能是 `rgba()` —— 生成器两种都认） */
  outline: string;
  /** 路芯（按等级从高到低，取主题 `road.rankColors` 的 0~3 档） */
  roadCore: string[];
  /** 路描边（主题 `road.casing`） */
  roadCasing: string;
  casingOpacity: number;
}

export function wsPrerenderPalette(theme: WsMapTheme): WsPrerenderPalette {
  const hex = (c: unknown): string | null => (/^#[0-9a-fA-F]{6}$/.test(String(c || "")) ? String(c) : null);
  const rampHex = theme.ramp.map(([, c]) => hex(c)).filter((c): c is string => !!c);
  /** 按"在色阶里的位置"挑一档（挑不到就退回主题的屋顶/兜底色 —— 派生件绝不抛） */
  const at = (k: number): string => {
    if (!rampHex.length) return hex(theme.roofFallback) || theme.bg;
    const i = Math.max(0, Math.min(rampHex.length - 1, Math.round(k * (rampHex.length - 1))));
    return rampHex[i]!;
  };
  const ranks = [0, 1, 2, 3].map((r) => hex(theme.road.rankColors[r])).filter((c): c is string => !!c);
  return {
    ground: groundHex(theme),
    blocks: [at(0.3), at(0.55), at(0.85)],
    outline: String(theme.outline.color || "#000000"),
    roadCore: ranks.length ? ranks : [theme.bg],
    roadCasing: String(theme.road.casing || theme.bg),
    casingOpacity: theme.road.casingOpacity,
  };
}

/**
 * 从 URL 读主题开关（机主要的 **A/B 对比**入口）：
 *   `?wstheme=anime` / `?wstheme=night`
 * 返回 `null` = "URL 没说"（此时调用方去看 localStorage / 用默认值）。
 * 为什么要 URL 参数：代拍通道就是"给一个 URL 让机主点一下"，参数是最省事的开关。
 */
export function parseWsMapThemeParam(search: string | null | undefined): WsMapThemeId | null {
  try {
    const q = new URLSearchParams(String(search || ""));
    const v = q.get("wstheme");
    if (!v) return null;
    return (v in WS_MAP_THEMES ? v : null) as WsMapThemeId | null;
  } catch {
    return null;
  }
}

/** 读**已存**的主题（localStorage 不可用就返回 null —— 别为了个偏好把页面搞崩） */
export function readWsMapTheme(): WsMapThemeId | null {
  try {
    return parseWsMapThemeParam(`?wstheme=${localStorage.getItem(WS_MAP_THEME_KEY) || ""}`);
  } catch {
    return null;
  }
}

/** 存主题偏好（同样容错：隐私模式/无 localStorage 时静默失败） */
export function saveWsMapTheme(id: WsMapThemeId): void {
  try {
    localStorage.setItem(WS_MAP_THEME_KEY, id);
  } catch {
    /* 存不下就算了，不该因为一个偏好写失败而报错 */
  }
}

/**
 * `raster-*` 三层变换的**忠实复刻**（系数直接来自 vendored 包的 GLSL，见文件头）。
 *
 * 输入：源瓦片平均亮度（0~1）；输出：屏幕上那块像素的亮度。
 * `satFactor` / `contrastFactor` 也是包里那两个函数，照抄：
 *   sat>0 → 1 - 1/(1.001-sat)；sat<0 → **-sat**（负饱和 ⇒ 正系数 ⇒ 把像素往灰里拉）
 *   contrast>0 → 1/(1-c)；否则 1+c
 *
 * ⚠️ 诚实说明：这里只在**平均值**上算（逐像素的对比度会改变分布）。
 *   但三步都是**仿射**的，对均值成立；而且饱和度那一步**恰好保值**
 *   （每个像素往自己的通道均值靠，均值不变）⇒ 拿它算"地面多亮"是站得住的。
 */
export function rasterBrightness(
  sourceLuma: number,
  paint: WsMapRasterPaint | null | undefined,
  which: "min" | "max" = "max"
): number {
  if (!paint) return sourceLuma;
  let v = Number(sourceLuma);
  if (!Number.isFinite(v)) return 0;
  v = Math.max(0, Math.min(1, v));
  /* ① 对比度（绕 0.5） */
  const c = Number(paint["raster-contrast"] ?? 0);
  if (c) {
    const cf = c > 0 ? 1 / (1 - c) : 1 + c;
    v = (v - 0.5) * cf + 0.5;
  }
  /* ② 亮度重映射：out = brightness_min + (max - min) * v（就是 GLSL 里那个 mix） */
  const lo = Number(paint["raster-brightness-min"] ?? 0);
  const hi = Number(paint["raster-brightness-max"] ?? 1);
  return lo + (hi - lo) * v;
}

/**
 * 十六进制色 → **伽马空间**亮度（0~1，就是 `0.2126R+0.7152G+0.0722B` 直接算，不解伽马）。
 *
 * 🔴 为什么必须有这个、而不是全都用 `relativeLuminance()`：
 * 地图库的 `raster-*` 三步变换跑在**纹理原始值**上（sRGB 编码，即伽马空间），
 * 我量瓦片亮度时也是按原始 0~255 算的 ⇒ **大家必须在同一个空间里比**。
 * 拿"解过伽马"的 WCAG 亮度去跟"伽马空间"的地面亮度作比，是**两套尺子**，
 * 算出来的"楼比地亮多少"就是错的（我第一版就这么错过一次）。
 * ⇒ 比**明暗**用 `gammaLuma`；算**WCAG 对比度**（描边可见性）才用 `relativeLuminance`。
 */
export function gammaLuma(hex: string): number {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return 0;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 十六进制色 → 相对亮度（WCAG 口径，含 sRGB 反伽马）。给"描边够不够显眼"用。 */
export function relativeLuminance(hex: string): number {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return 0;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return 0;
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 对比度（1~21）。用于"细描边在浅底上到底看不看得见"。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 色罩叠加后的地面亮度（source-over，按不透明度**在伽马空间**线性混合 ——
 * 和地图库/我量瓦片的口径一致，见 `gammaLuma` 的说明）。
 * `tint` 为 null 时就是底图本身的亮度。
 */
export function groundLuma(theme: WsMapTheme, which: "base" | "hi" = "base"): number {
  const src = which === "hi" ? theme.measuredLuma.hi : theme.measuredLuma.base;
  const paint = which === "hi" ? theme.raster.hi : theme.raster.base;
  if (src == null || paint == null) return NaN;
  const under = rasterBrightness(src, paint);
  if (!theme.tint) return under;
  const t = gammaLuma(theme.tint.color);
  return under * (1 - theme.tint.opacity) + t * theme.tint.opacity;
}

/**
 * 合成后的**地面颜色**（十六进制）—— 底图（灰度，按 `raster-*` 变换后）+ 色罩叠出来的那个色。
 *
 * 为什么需要它：自检要算"描边对地面够不够显眼"，而描边是**画在这个颜色上**的。
 * 我第一版自检里把地面色**写死成 `#CFE6F7`** —— 后来色罩改成 `#BCE7F8` 之后，
 * 那条断言**还在拿旧颜色算**，报出来的比值是假的（"假绿"的一种：数字变了、判据没跟着变）。
 * ⇒ 地面色必须**从主题算出来**，不许在测试里手抄。
 */
export function groundHex(theme: WsMapTheme, which: "base" | "hi" = "base"): string {
  const src = which === "hi" ? theme.measuredLuma.hi : theme.measuredLuma.base;
  const paint = which === "hi" ? theme.raster.hi : theme.raster.base;
  if (src == null || paint == null) return theme.bg;
  /* 底图是灰的 ⇒ 每个通道都等于这个亮度（伽马空间），和 `groundLuma` 同一把尺子 */
  const u = rasterBrightness(src, paint);
  const toHex = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  if (!theme.tint) return `#${toHex(u)}${toHex(u)}${toHex(u)}`;
  const th = String(theme.tint.color).replace("#", "");
  const n = parseInt(th, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const k = theme.tint.opacity;
  return `#${ch.map((c) => toHex(u * (1 - k) + c * k)).join("")}`;
}

/** 色阶里**最暗**那一档的亮度（楼体暗部）—— 只用六位十六进制档（`rgba()` 那些不算） */
export function rampFloorLuma(theme: WsMapTheme): number {
  const hexes = theme.ramp.map(([, c]) => c).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  if (!hexes.length) return 0;
  return Math.min(...hexes.map((c) => gammaLuma(c)));
}

/** 主题 → `fill-extrusion-color` 的 interpolate 表达式（`color3d` 缺失时的兜底） */
export function rampExpression(theme: WsMapTheme): unknown[] {
  const stops: unknown[] = [];
  for (const [h, c] of theme.ramp) stops.push(h, c);
  return ["interpolate", ["linear"], ["coalesce", ["get", "h3d"], 8], ...stops];
}

/**
 * 低端档（`perf.low`）该用的实际参数 —— **把降级规则也变成纯函数**，
 * 这样"低端到底关了啥"能被断言，而不是散在渲染代码的 if 里。
 */
export function themeForTier(
  theme: WsMapTheme,
  low: boolean
): { sky: Record<string, unknown> | null; outlineWidth: number | null; tint: WsMapTheme["tint"] } {
  if (!low) return { sky: theme.sky, outlineWidth: theme.outline.width, tint: theme.tint };
  return {
    sky: theme.low.dropSky ? null : theme.sky,
    outlineWidth: theme.low.outlineWidth,
    tint: theme.low.dropTint ? null : theme.tint,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 夜色：由**当前主题派生**出来的一版（`DESIGN-NIGHT.md` 第 1 件）
 *
 * 🔴 纪律：**不许改 `ANIME` 已验收的值**（机主 2026-09-20 看过那套配色）。
 *    所以夜色不是"再写一套常量"，而是**函数**：同一个主题 + 天黑程度 → 夜里那一版。
 *    好处：以后调 ANIME 的白天配色，夜色会**自动跟着走**，不会两边漂。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 解析一个 CSS 颜色 —— **两种格式都要认**：
 *   · `#rgb` / `#rrggbb`（大多数字段）
 *   · `rgb(...)` / `rgba(...)`（`outline.color` 与 `ai.*` 用的是带 alpha 的写法）
 *
 * 🔴 为什么要认第二种：我第一版只认 hex，于是 `outline.color`（`rgba(190,235,255,.22)`）
 *    和 `ai.park` **静默不变色** —— 夜色在"楼描边"和"AI 水系"上根本没生效，
 *    而**页面上看不出任何报错**（函数按设计"认不出就原样返回"）。
 *    是 `ws_night_selftest.mjs` 断言"夜里必须真的变了"才把它抓出来的。
 *    教训：**"优雅降级"必须配一条"我确实生效了"的断言**，否则降级就是静默失效。
 *
 * @returns `{ rgb, alpha, fmt }`；认不出来返回 null（调用方原样回退，绝不抛）
 */
function parseColor(css: string): { rgb: [number, number, number]; alpha: number | null; fmt: "hex" | "rgb" } | null {
  if (typeof css !== "string") return null;
  const t = css.trim();
  const hx = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t);
  if (hx) {
    const h = hx[1].length === 3 ? hx[1].replace(/./g, (c) => c + c) : hx[1];
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      alpha: null,
      fmt: "hex",
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (rgb) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      alpha: rgb[4] === undefined ? null : Number(rgb[4]),
      fmt: "rgb",
    };
  }
  return null;
}

/** 按**进来的格式**吐回去（hex 还是 hex、rgba 还是 rgba）—— 免得把 `rgba` 写成 `#hex` 丢了 alpha。 */
function formatColor(rgb: [number, number, number], alpha: number | null, fmt: "hex" | "rgb"): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  if (fmt === "hex") {
    const h = (n: number) => c(n).toString(16).padStart(2, "0");
    return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
  }
  return alpha === null ? `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})` : `rgba(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])}, ${alpha})`;
}

/** 把 `a` 往 `b` 靠 `t`（0..1）。任一边认不出来就原样返回 `a` —— 宁可不变色，也别画出一个坏值。 */
function mixColor(a: string, b: string, t: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  if (!A || !B) return a;
  const k = Math.max(0, Math.min(1, t));
  return formatColor(
    [A.rgb[0] + (B.rgb[0] - A.rgb[0]) * k, A.rgb[1] + (B.rgb[1] - A.rgb[1]) * k, A.rgb[2] + (B.rgb[2] - A.rgb[2]) * k],
    A.alpha,
    A.fmt
  );
}

/**
 * 楼体专用的"入夜"：**先压暗，再偏暖**。
 *
 * 为什么不能只压暗：全压暗会变成一堆冷灰，像"掉电"而不是"入夜"。
 * 夜里楼体应当是**暗底 + 暖意**（窗里透出来的光是暖的）—— 所以压暗之后
 * 给红通道补一点、蓝通道减一点。`k = 0` 时**必须**逐位等于原值。
 */
function duskColor(css: string, k: number, dim = 0.55, warm = 22): string {
  const c = parseColor(css);
  if (!c) return css;
  const f = 1 - dim * k;
  const [r, g, b] = c.rgb;
  return formatColor([r * f + warm * k, g * f + warm * 0.35 * k, b * f - warm * 0.3 * k], c.alpha, c.fmt);
}

/** 夜幕蓝：地面/天空/色罩往这里靠（不是纯黑 —— 纯黑会把"层次"也一起吃掉） */
const NIGHT_BLUE = "#0B1526";

/**
 * 由主题派生"夜里那一版"。**纯函数**：同样的输入永远同样的输出，且 `level = 0` 时
 * **原样返回输入**（调用方因此可以无脑用它，不必自己判白天）。
 *
 * @param level 天黑程度 0..1（`wsTime.nightLevel(hour)`）
 * @param flat  低档：只留"纯暗色"（关掉偏暖）—— 见 `DESIGN-NIGHT.md` 第 1 件
 */
export function nightVariant(theme: WsMapTheme, level = 1, flat = false): WsMapTheme {
  const k = Math.max(0, Math.min(1, level));
  if (k <= 0) return theme;
  /* 低档要的是**均匀的暗**：偏暖会让每栋楼颜色都不一样，弱设备上反而更难看出层次，
     而且多算一遍色。所以低档把 warm 关掉、压得更狠。 */
  const warm = flat ? 0 : 22;
  const dimA = flat ? 0.66 : 0.55;

  const sky =
    theme.sky === null
      ? null
      : {
          ...theme.sky,
          /* ⚠️ 只动三个**颜色**字段，其余（blend 系数）原样保留 ——
             `sky` 那 7 个字段是从 vendored 包里抠出来的白名单，多写一个键
             就会让**整份 style 校验失败**、全站退回 2D（踩过，见本文件头的注释）。 */
          ...("sky-color" in theme.sky
            ? { "sky-color": mixColor(String(theme.sky["sky-color"]), NIGHT_BLUE, 0.72 * k) }
            : {}),
          ...("horizon-color" in theme.sky
            ? { "horizon-color": mixColor(String(theme.sky["horizon-color"]), "#243B5C", 0.66 * k) }
            : {}),
          ...("fog-color" in theme.sky
            ? { "fog-color": mixColor(String(theme.sky["fog-color"]), NIGHT_BLUE, 0.7 * k) }
            : {}),
        };

  const dimRaster = (p: WsMapRasterPaint | null): WsMapRasterPaint | null => {
    if (!p) return p;
    /* 只压 `raster-brightness-max`（"最亮能到多亮"）⇒ 整体压暗，
       而且**不会**动主题里写死的 saturation/contrast（那些是风格，不是时刻）。 */
    const cur = typeof p["raster-brightness-max"] === "number" ? (p["raster-brightness-max"] as number) : 1;
    return { ...p, "raster-brightness-max": Math.max(0.12, cur * (1 - 0.62 * k)) };
  };

  return {
    ...theme,
    hud: `${theme.hud} · 夜`,
    bg: mixColor(theme.bg, NIGHT_BLUE, 0.82 * k),
    sky,
    raster: {
      base: dimRaster(theme.raster.base) as WsMapRasterPaint,
      hi: dimRaster(theme.raster.hi),
      ref: dimRaster(theme.raster.ref) as WsMapRasterPaint,
    },
    tint: theme.tint
      ? {
          color: mixColor(theme.tint.color, NIGHT_BLUE, 0.8 * k),
          opacity: Math.min(0.92, theme.tint.opacity + 0.34 * k),
        }
      : theme.tint,
    ramp: theme.ramp.map(([h, c]) => [h, duskColor(c, k, dimA, warm)] as [number, string]),
    roofFallback: duskColor(theme.roofFallback, k, dimA, warm),
    antennaFallback: duskColor(theme.antennaFallback, k, dimA, warm),
    outline: { ...theme.outline, color: duskColor(theme.outline.color, k, dimA, warm) },
    ai: { park: duskColor(theme.ai.park, k, dimA, warm), water: duskColor(theme.ai.water, k, dimA, warm) },
  };
}

/**
 * 主题 → 一份 style 的**底半部分**（`sky` + `sources` + 背景那几条图层）。
 *
 * 为什么把它做成**纯函数**而不是留在组件里：
 * 2026-09-20 我踩过的坑是"往 `layers[0]` 塞了个坏对象 ⇒ 整份 style 校验失败 ⇒ **全站退回 2D**"。
 * 那种错误在浏览器里只表现为"HUD 报一句 missing required property"，而且是**运行时**才炸。
 * 放到这里之后，`ws_map_theme_selftest.mjs` 能在 **Node 里**把生成出来的 style
 * **按 vendored 包里抠出来的真 spec 逐条校验** —— 不用开浏览器、不用真机、秒级。
 *
 * ⚠️ 图层顺序是有意义的（自下而上）：`bg → base → hi → tint → ref`。
 *   楼房的图层由组件**插到 `ref` 之前**（`addLayer(l, "ref")`）⇒ 自动落在 `tint` 上面。
 *   `tint` 必须在底图之上、楼之下，否则要么盖不住底图、要么把楼也一起染了。
 */
export function themeStyleParts(
  theme: WsMapTheme,
  low = false,
  /**
   * 颜色过渡时长（毫秒）。**默认 0 = 与之前逐字一致**（自检与老调用点不受影响）。
   * 只有"昼夜缓变"这一件事需要它：把 `*-transition` 写进 paint ⇒ 之后
   * `setPaintProperty(...)` 改变颜色时，地图库**自己**会把颜色缓过去（800~1500ms），
   * 我们**不写插值动画**（`DESIGN-NIGHT.md` 的事实 ③：两个属性都 `transition: true`）。
   */
  transitionMs = 0
): {
  sky: Record<string, unknown> | undefined;
  sources: Record<string, unknown>;
  layers: Array<Record<string, unknown>>;
} {
  const tier = themeForTier(theme, low);
  const sources: Record<string, unknown> = {
    base: { type: "raster", ...theme.sources.base, tileSize: 256, crossOrigin: "anonymous" },
    ref: { type: "raster", ...theme.sources.ref, tileSize: 256, crossOrigin: "anonymous" },
  };
  /* ⚠️ 上面两条用 `...theme.sources.x` 展开 —— 它会**连 attribution 一起**带过来。
     别改成"只挑 tiles/maxzoom 手抄"：我第一版就是手抄的，结果**把 Esri 的署名弄丢了**
     （见 `WsMapRasterSource.attribution` 的说明）。自检里有一条专门断言署名在。 */
  const layers: Array<Record<string, unknown>> = [
    {
      id: "bg",
      type: "background",
      paint: {
        "background-color": theme.bg,
        ...(transitionMs > 0 ? { "background-color-transition": { duration: transitionMs, delay: 0 } } : {}),
      },
    },
    {
      id: "base",
      type: "raster",
      source: "base",
      /* 🔴 高 zoom 淡出（治「地面太糊」）：二次元的亮灰底图最高只到 z16，
         小区级放大到 17~18 就是"把 z16 放大 4 倍" ⇒ 必糊。
         淡出后露出 `bg` + `tint` 合成出来的纯色地面（和"有瓦片时"只差 0.002 亮度）
         + 我们自己的路网 + 楼体 ⇒ 全是矢量，任何缩放都锐利。
         ⚠️ `baseFade` 只覆盖 `raster-opacity` 这一个字段，**不动**主题里写的
            saturation/contrast/brightness（那些在淡出区间里照样按 zoom 生效）。 */
      paint: theme.baseFade
        ? {
            ...theme.raster.base,
            "raster-opacity": [
              "interpolate", ["linear"], ["zoom"],
              theme.baseFade.from, 1,
              theme.baseFade.to, 0,
            ],
          }
        : theme.raster.base,
    },
  ];
  /* 高分层：二次元主题没有它（`sources.hi === null`）。
     ⚠️ 没有图层却留着 source 是"死重量"，所以**源和图层一起加、一起不加**。 */
  if (theme.sources.hi && theme.raster.hi) {
    sources.hi = { type: "raster", ...theme.sources.hi, tileSize: 256, crossOrigin: "anonymous" };
    layers.push({ id: "hi", type: "raster", source: "hi", minzoom: 14.5, paint: theme.raster.hi });
  }
  if (tier.tint) {
    layers.push({
      id: "tint",
      type: "background",
      paint: {
        "background-color": tier.tint.color,
        "background-opacity": tier.tint.opacity,
        ...(transitionMs > 0
          ? {
              "background-color-transition": { duration: transitionMs, delay: 0 },
              "background-opacity-transition": { duration: transitionMs, delay: 0 },
            }
          : {}),
      },
    });
  }
  /* 注记压在最上层（街名不该被楼挡）——**组件的楼房层靠这个 id 当插入锚点**，别改名。 */
  layers.push({ id: "ref", type: "raster", source: "ref", paint: theme.raster.ref });
  return { sky: tier.sky || undefined, sources, layers };
}
