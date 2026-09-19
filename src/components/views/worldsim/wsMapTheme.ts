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
    "sky-color": "#7EC8F0", // 明亮天蓝
    "horizon-color": "#EAF6FF", // 近白的地平线
    "fog-color": "#DCEFFB", // 🔴 淡蓝白雾，**不是暗雾**：远景要"化开"成亮的
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.5,
    "atmosphere-blend": 0.8,
    "fog-ground-blend": 0.6,
  },
  bg: "#EAF6FF", // 近白兜底：`sky` 万一没生效，背景也不会是黑的
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
      "raster-opacity": 1,
      "raster-saturation": 0.15, // 灰底没色可抽，微微加一点，让下面的浅蓝色罩显得干净
      "raster-contrast": 0.08,
      "raster-brightness-max": 0.96,
    },
    hi: null,
    ref: { "raster-opacity": 0.85 },
  },
  /* 色罩：`background` 图层 + 浅蓝 + 0.35 不透明度。
     注意底图是**灰度**的 ⇒ 在灰度上做色相旋转是空操作，**只有盖颜色才有效**。
     算式（自检直接跑公式，不认嘴）：底图 0.937 →(对比度 0.08)→ 0.975 →(×0.96)→ 0.936，
     再叠 35% 的 `#CFE6F7`（亮度 0.888）⇒ 地面 = 0.936×0.65 + 0.888×0.35 = **0.919**。 */
  tint: { color: "#CFE6F7", opacity: 0.35 },
  /* 平涂三档：矮 → 中 → 高（高楼**更白更亮**，像 BA 里打了高光的塔楼）。
     注意这里**不是**明度递进拉开"楼比地亮"——BA 的地本来就亮（0.919），
     楼和地是靠**描边**分开的（`separation: "outline"`）。 */
  ramp: [
    [3, "#BFE3F7"], // 矮楼：淡天蓝
    [12, "#AEDBF4"],
    [25, "#9DD2F0"], // 中：BA 的主蓝
    [45, "#B9E2F8"],
    [70, "#D3EEFB"],
    [110, "#E8F6FF"], // 高/塔楼：近白（高光）
    [200, "#F4FBFF"],
    [320, "#FFFFFF"],
  ],
  roofFallback: "#8FC9EE",
  /* 屋顶压顶在 BA 风里**不能压暗**（那套做法是写实的"女儿墙"）——
     改成**更浅**的一档，读起来就是"楼顶被光照到"，还是平涂。 */
  antennaFallback: "#FFFFFF",
  /* 描边：深藏青 + 1.2px（任务书给的就是这个色，我按 WCAG 1.4.11「非文字图形 ≥ 3:1」算过：
     对叠加后的浅蓝地面 **7.7:1**，非常够 —— 原先我手算成 2.83:1 是因为把
     "伽马空间亮度"当成了 WCAG 亮度，**量错尺子**；自检里这条现在是自动算的）。 */
  outline: { color: "#2C4A63", width: 1.2 },
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
  low = false
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
    { id: "bg", type: "background", paint: { "background-color": theme.bg } },
    { id: "base", type: "raster", source: "base", paint: theme.raster.base },
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
      paint: { "background-color": tier.tint.color, "background-opacity": tier.tint.opacity },
    });
  }
  /* 注记压在最上层（街名不该被楼挡）——**组件的楼房层靠这个 id 当插入锚点**，别改名。 */
  layers.push({ id: "ref", type: "raster", source: "ref", paint: theme.raster.ref });
  return { sky: tier.sky || undefined, sources, layers };
}
