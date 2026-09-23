/**
 * wsMapStyle.ts —— **底图 style / 图层的唯一真源**（2026-09-22 从 `useWsMapLibre.ts` **原样搬入**）。
 *
 * 为什么搬：`ALIGN-UPSTREAM.md` / `MERGE-STANDALONE-PAGES.md` 要求"样式构建**只允许一份**"，
 * 而它原来长在 `useWsMapLibre.ts`（1200 行的 composable）里 ⇒ 别的渲染路想复用只能抄一份。
 * ⚠️ **本次是纯搬运、零行为变化**：函数体/常量/注释一字未改；`ML_*` 常量组一并搬来，
 *   原文件**import 回去**继续用（`export *` 不建本地绑定 —— 漏了这步就编译不过，量过的坑）。
 */
import { THEME_DARK, THEME_LIGHT, type GeoTheme } from "@/components/views/worldsim/wsGeoMap";

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
       实测本 vendored 构建支持 fog-color / fog-ground-blend / horizon-blend；
       **不支持** `light` 与 `fill-extrusion-ambient-occlusion`（"光照"只能靠时间驱动配色）。 */
    fog: {
      range: [0.6, 9],
      color: theme.sea,
      "horizon-blend": 0.12,
      "high-color": theme.land,
      "space-color": theme.sea,
      "star-intensity": 0,
    },
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
