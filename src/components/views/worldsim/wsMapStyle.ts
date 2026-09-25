/**
 * wsMapStyle.ts —— **底图 style / 图层的唯一真源**（2026-09-22 从 `useWsMapLibre.ts` **原样搬入**）。
 *
 * 为什么搬：`ALIGN-UPSTREAM.md` / `MERGE-STANDALONE-PAGES.md` 要求"样式构建**只允许一份**"，
 * 而它原来长在 `useWsMapLibre.ts`（1200 行的 composable）里 ⇒ 别的渲染路想复用只能抄一份。
 * ⚠️ **本次是纯搬运、零行为变化**：函数体/常量/注释一字未改；`ML_*` 常量组一并搬来，
 *   原文件**import 回去**继续用（`export *` 不建本地绑定 —— 漏了这步就编译不过，量过的坑）。
 */
import { THEME_DARK, THEME_LIGHT, type GeoTheme } from "@/components/views/worldsim/wsGeoMap";
import { lodPlan, PRERENDER_LAYER_ID, PRERENDER_SOURCE_ID } from "@/components/views/worldsim/wsScene";

/**
 * 把 public 资源解析成**页面源**下的绝对 URL。
 * ⚠️ 基准必须是 `location.href`（页面），不是 `import.meta.url`（模块）——理由见文件头。
 */
export function assetUrl(path: string): string {
  try {
    if (typeof location === "undefined") return path;
    return new URL(path, location.href).href;
  } catch {
    return path;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   图层 / 数据源 id（外部（验证页、后续图层）要按 id 找图层，所以导出）
   ══════════════════════════════════════════════════════════════════════════ */
export const ML_SRC = "ws-ml-src";
export const ML_BG = "ws-ml-bg";
/** 陆地填充（第 4 层：最低对比） */
export const ML_LAND = "ws-ml-land";
/** 行政边界（第 3 层） */
export const ML_LINE = "ws-ml-line";
/** 高亮填充（选中/悬停）—— 永远画在最上层（规格：用户内容最上） */
export const ML_HI = "ws-ml-hi";
/** 底图 source/layer 的 id（UI 升级 2026-09-19：没有底图时"地图"只是一块纯色） */
export const ML_BASE = "ws-ml-base";
export const ML_BASE_LAYER = "ws-ml-base-l";

/**
 * 免密钥底图（Carto，实测可达 0.57s，**全球覆盖含中国**，署名 OSM+CARTO）。
 *
 * 为什么必须补：原样式里 `sources: {}` ⇒ 世界/省/市/区县每一层都只画一块背景色，
 * 机主一眼就说"只有白底/不像地图"。这里按主题给暗/亮两套，随 `setDark()` 切。
 * ⚠️ 纪律：**只挂实测能取到的源**（带等高线的 opentopomap / Esri 地形从本机网络超时，不写进来）。
 */
export function basemapTiles(dark: boolean): string[] {
  /* 🔴 **不要用 Carto**（2026-09-19 实测确认）：不带 key 时它返回的是**带水印的正常图片** ——
     HTTP 200、不 403、不报错，图面却是整幅斜字 `API KEY REQUIRED`（我下载瓦片用原生识图看过了）。
     机主看到的「除中国外全世界都有那行字」就是它：我们自绘的省/市/区多边形**不透明**，正好盖住中国区的水印。
     ⇒ 换成 **Esri**（免 key、同机同网实测 0.39s / 0.48s）：
        · 亮色 = World_Topo_Map（**自带真等高线**，正合"要等高线"的要求）
        · 暗色 = Canvas/World_Dark_Gray_Base（干净暗底）
     🔴 Esri 路径是 `{z}/{y}/{x}`（**y 在前**）：写成 `{z}/{x}/{y}` **不报错但地图会跑到错位置**。 */
  return [
    dark
      ? "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  ];
}
export const ML_HI_LINE = "ws-ml-hi-line";

/**
 * 样式（MapLibre 的"皮肤"）。**背景色 = 现在的海色**（`.ws-sea-*` 那套的同一来源）。
 *
 * 🔴 这里**不能出现 `glyphs` / `sprite`**（坑②：`glyphs: undefined` 会让样式校验失败，
 *  `load` 永不触发、页面零报错）。数据 source 与图层在 `load` 之后加（换级要 `setData`）。
 */
export function styleFor(theme: GeoTheme, opts: { basemap?: boolean } = {}): Record<string, unknown> {
  /* `GeoTheme` 里**没有** dark 字段（只有颜色），所以从海色反推 —— 两个常量 Theme 的 sea 不同，
     这是最不容易漂的判据（写死一份"当前主题"会与 setDark 分叉）。 */
  const dark = theme.sea === THEME_DARK.sea;
  /* `opts.basemap === false` = **探针判定这张底图不可用**（不是图片/太小/HTTP 错）：
     宁可只画背景色，也**绝不**把水印图或错误图铺满屏幕（2026-09-19 事故的教训）。 */
  const useBase = opts.basemap !== false;
  const sources: Record<string, unknown> = {};
  const layers: Array<Record<string, unknown>> = [
    {
      id: ML_BG,
      type: "background",
      paint: { "background-color": theme.sea },
    },
  ];
  if (useBase) {
    sources[ML_BASE] = {
      type: "raster",
      tiles: basemapTiles(dark),
      tileSize: 256,
      maxzoom: 20,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS User Community",
    };
    /* 底图在背景之上、我们自己的数据层之下（数据层不能被底图盖住） */
    layers.push({
      id: ML_BASE_LAYER,
      type: "raster",
      source: ML_BASE,
      paint: { "raster-opacity": dark ? 0.85 : 0.92 },
    });
  }
  return {
    version: 8,
    name: "ws-maplibre",
    /* 🌆 天际线 L0 · 大气透视（雾）：远处往"海底色"里化开 —— 深度感最大的来源
       （见 world_map/DESIGN-SKYLINE.md 手段 #1）。
       用 `theme.sea` 而不是硬编码：亮/暗两套主题自动跟随
       （GeoTheme 只有 land/line/accent/accentLine/label/labelHalo/sea 七个字段，**没有 `dark`** ——
        当初我写 `theme.dark` 被 tsc 当场抓住，就是这个原因）。

       🔴 2026-09-25 更正（从 vendored 源码的 `$root` 键表逐字核出，见 RESEARCH-MOBILE-3D-PERF.md）：
       · **根级没有 `fog` 这个键** —— `fog-color` / `fog-ground-blend` / `horizon-blend` 属于 **`sky`**；
         原来这里那段根级 `fog: {…}` 是**死配置（从来没生效过）**，已删除。
         要真正加雾/天际线，走 `sky`（`wsMapTheme.ts` 的 sky 段，那里已经是合法写法）。
       · 本构建**不支持** `star-intensity`（旧块里那个键同样是死配置）。
       · **`light` 是支持的**（`$root.light` + shader 里 `u_lightpos/u_lightcolor/u_lightintensity` 都在算）
         ⇒ 将来要"给楼打光"直接用根级 `light`，**零依赖、零额外 draw call**。
         （本条推翻了此处旧注释"不支持 `light`"的说法。） */
    sources,
    layers,
  };
}

/** 主色：与现有两套主题共用同一个 `accentLine`（深色下就是 `--accent-color` 冰蓝 #79d9ff） */
export function layersFor(theme: GeoTheme): Array<Record<string, unknown>> {
  return [
    {
      id: ML_LAND,
      type: "fill",
      source: ML_SRC,
      /* 半透明：底图要能透上来（原来是不透明色块 ⇒ 接上底图也会被整块盖住，白接） */
      paint: { "fill-color": theme.land, "fill-opacity": theme.sea === THEME_DARK.sea ? 0.55 : 0.45 },
    },
    {
      id: ML_LINE,
      type: "line",
      source: ML_SRC,
      layout: { "line-join": "round", "line-cap": "round" },
      // 0.8px 与 Canvas2D 版逐字一致（那边是 `lineWidth = 0.8 / k`，屏幕像素恒定）
      paint: { "line-color": theme.line, "line-width": 0.8 },
    },
    {
      id: ML_HI,
      type: "fill",
      source: ML_SRC,
      filter: NO_HIGHLIGHT_FILTER,
      paint: { "fill-color": theme.accent, "fill-opacity": 1 },
    },
    {
      id: ML_HI_LINE,
      type: "line",
      source: ML_SRC,
      filter: NO_HIGHLIGHT_FILTER,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": theme.accentLine, "line-width": 1.6 },
    },
  ];
}

/** 换主题时要改的 (图层, 属性, 值) 三元组 —— 与 `layersFor`/`styleFor` 一一对应 */
export function paintUpdatesFor(theme: GeoTheme): Array<[string, string, unknown]> {
  return [
    [ML_BG, "background-color", theme.sea],
    [ML_LAND, "fill-color", theme.land],
    [ML_LINE, "line-color", theme.line],
    [ML_HI, "fill-color", theme.accent],
    [ML_HI_LINE, "line-color", theme.accentLine],
  ];
}

/** 「谁也匹配不上」的过滤器：高亮层初始就用它，等价于不可见。 */
export const NO_HIGHLIGHT_FILTER: unknown[] = ["==", ["get", "adcode"], "\u0000ws-none"];

/**
 * 🔎 **"同一份真源"的自证标记**（对齐清单 B 用）。
 *
 * 为什么要有它：B 的目标是"**各级都调同一份实现**"，而"有没有真的调到"以前只能靠读代码。
 * ⇒ 让样式构建方**自报家门**：谁产出这张图的 style，谁的名字就写进 `info.styleSource`，
 * 面板（五级都能开）会显示「样式真源 = …」⇒ 换源有没有生效，**在页面上一眼可见**，不必猜。
 */
export const WS_MAP_STYLE_SOURCE = "wsMapStyle.ts";

/** 本模块产出的图层 id（面板/自检用它断言"图层确实来自这一份"） */
export function wsMapStyleLayerIds(): string[] {
  return [ML_BG, ML_BASE_LAYER, ML_LAND, ML_LINE, ML_HI_LINE];
}

/**
 * 🛰 **LOD 第 1 步：预渲染栅格层的样式入口**（2026-09-24，机主：「近距离渲染 / 远距离预渲染」）。
 *
 * 为什么在这里再包一层：`wsScene.lodPlan()` 是**结构与阈值**的唯一真源
 * （层 id / before 锚点 / zoom 阈值 / 不透明度表达式 / 瓦片路径都在那边），
 * 而"往一份 style 里放什么"属于本文件的职责（`wsMapStyle.ts` = 样式的唯一真源）。
 * ⇒ 这里**一个数字都不写**，只是把计划取出来、顺手标上真源（防"两份装配"）。
 *
 * 🔴 **颜色不在这一层**：着色在**瓦片像素**里（骨架阶段由
 * `world_map/make_prerender_tiles.mjs` 用 `wsMapTheme.wsPrerenderPalette()` 画），
 * 本层只有一条 `raster-opacity`。改主题 ⇒ 重跑那个脚本 ⇒ 瓦片跟着变
 * （`ws_lod_selftest.mjs` 用清单里的指纹盯着这件事，不是靠嘴说）。
 *
 * ⚠️ **默认不加**：App 侧这一轮**不接线**（原型先定稿）—— 谁调它，谁自己负责
 * `?lod`/开关；没开的时候图层压根不该存在（否则会去要一批不存在的瓦片）。
 */
export function prerenderStyleSpecs(): {
  sourceId: string;
  layerId: string;
  /** 插到哪个图层之前（来自 `SCENE_LAYER_ORDER`，预渲染层必须在矢量层之上） */
  beforeId: string | null;
  source: Record<string, unknown>;
  layer: Record<string, unknown>;
  /** 自证：这份 spec 来自哪一份真源（页面/面板可读） */
  styleSource: string;
} {
  const p = lodPlan();
  return {
    sourceId: PRERENDER_SOURCE_ID,
    layerId: PRERENDER_LAYER_ID,
    beforeId: p.beforeId,
    source: { ...p.source },
    layer: { ...p.layer },
    styleSource: `${WS_LOD_STYLE_SOURCE}(${p.far}→${p.near})`,
  };
}

/** LOD 那份 spec 的"自报家门"标记（与 `WS_MAP_STYLE_SOURCE` 同一个用法） */
export const WS_LOD_STYLE_SOURCE = "wsMapStyle.ts/wsScene.lodPlan";

/**
 * 🎨 **舞台样式（对齐清单 B · 区县级换源，2026-09-22 机主选 A）**
 *
 * 目标：区县级的**外观**（背景/底图/色罩/天空）改吃 `wsMapTheme.themeStyleParts`（**与小区级同一份真源**），
 * 而**数据层**（`ML_SRC` 上的面/线/高亮）仍是舞台自己的 —— 那批是**交互的载体**
 * （点击下钻靠 `queryRenderedFeatures({layers:[ML_LAND]})`、`fitBounds` 靠它算 bbox）⇒ **一层都不能动**。
 *
 * ⇒ 组合式：`[主题的 bg/base/tint/ref]` + `[舞台的 land/line/hi]`，**顺序即绘制序**（数据层在最上）。
 * ⚠️ 纪律：**零手改数值** —— 主题那几个图层的 paint 原样搬过来（机主拍板选 A，不为好看微调）。
 * ⚠️ 主题解析失败（拿不到 `themeStyleParts`）⇒ **回退到 `styleFor`**（老路），不让整级地图没掉。
 */
export function styleForStage(
  theme: GeoTheme,
  opts: { basemap?: boolean; themeId?: "anime" | "night"; low?: boolean; nightFadeMs?: number; parts?: { sky?: unknown; sources: Record<string, unknown>; layers: Array<Record<string, unknown>> } | null } = {}
): Record<string, unknown> {
  const base = styleFor(theme, opts); // 数据层与兜底都用它（**它本身一字未改**）
  const parts = opts.parts;
  if (!parts || !parts.layers || !parts.layers.length) {
    return { ...base, __styleSource: "wsMapStyle.ts/fallback(styleFor)" }; // 兜底如实标注
  }
  /* 主题的外观层 + 舞台的数据层（后者引用 ML_SRC，由调用方 addSource/ addLayer 负责） */
  const baseLayers = (base.layers || []) as Array<Record<string, unknown>>;
  /* 数据层 = 舞台自己在 `ML_SRC` 上建的那几条（id 以 `ws-ml-` 开头）—— 它们是**交互载体**，原样保留 */
  const dataLayers = baseLayers.filter((l) => String(l.id || "").startsWith("ws-ml-"));
  return {
    version: 8,
    name: `ws-stage-${opts.themeId || "anime"}`,
    ...(parts.sky ? { sky: parts.sky } : {}),
    sources: { ...(parts.sources as Record<string, unknown>), ...(base.sources as Record<string, unknown>) },
    layers: [...(parts.layers as Array<Record<string, unknown>>), ...dataLayers],
    __styleSource: `${WS_MAP_STYLE_SOURCE}/theme(${opts.themeId || "anime"})`,
  };
}
