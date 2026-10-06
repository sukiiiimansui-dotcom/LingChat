/**
 * wsMapStyle.ts —— **底图 style / 图层的唯一真源**（2026-09-22 从 `useWsMapLibre.ts` **原样搬入**）。
 *
 * 为什么搬：`ALIGN-UPSTREAM.md` / `MERGE-STANDALONE-PAGES.md` 要求"样式构建**只允许一份**"，
 * 而它原来长在 `useWsMapLibre.ts`（1200 行的 composable）里 ⇒ 别的渲染路想复用只能抄一份。
 * ⚠️ **本次是纯搬运、零行为变化**：函数体/常量/注释一字未改；`ML_*` 常量组一并搬来，
 *   原文件**import 回去**继续用（`export *` 不建本地绑定 —— 漏了这步就编译不过，量过的坑）。
 *
 * 🔴 **现状（2026-10-06，S9b8 批 E 之后）**：那个"原文件"（`useWsMapLibre.ts`）已整份删除，
 *   本模块**唯一的活出口是 `assetUrl`**（`src/composables/wsMapLibreCss.ts:11` → 现役宿主
 *   `WsDistrictMapLibre.vue` 的 `injectCss`）。其余符号三类，逐符号依据见 `REMOVED-CODE.md` 的 S9b8 条：
 *     · 已退役（连本体删）：S9b7 的 8 个 + 本批的 `ML_SRC` / `ML_LAND` / `ML_LINE` / `ML_HI` / `ML_HI_LINE`；
 *     · 收敛（本体留着、只去 `export`）：`basemapTiles`（S9b7）、`ML_BG` / `ML_BASE_LAYER`（本批）——
 *       消费者都在本文件内（`styleFor`）；
 *     · 只剩闸在读：`styleFor` / `THEME_DARK` / `THEME_LIGHT` / `ML_BASE`
 *       （`ws_base_maxzoom_selftest.mjs` ①②④ 段 + ⑦b 段的反向判据）——**不是活路**，
 *       但它们同时是那份"底图 maxzoom 收口"守卫的输入/锚点，退掉就等于放弃那条守卫（见 S9b8 台账）。
 *   现役 App 的 style 走
 *   `WsDistrictMapLibre.vue → wsFallback2d.styleNow() → wsDistrictScene.districtStyleOf()`
 *   → `wsMapTheme.themeStyleParts()`，与这里的 `styleFor` 是两条路。
 */
/* ── 🎨 主题色（2026-10-06 从 `wsGeoMap.ts` **原样搬入**，纯搬运、零行为变化）────────
 * 为什么搬：底图 style 是**唯一真源**，却要向一个已退役的 Canvas2D 渲染器借主题常量 ——
 * 那个渲染器（`wsGeoMap.ts` 的 `WsGeoMap` 类）随下钻死簇一起删了，所以把这三个符号
 * 落到它唯一的活消费者这里。下面这段与 `wsGeoMap.ts` 里的原文**逐字节相同**。 */
export interface GeoTheme {
  /** 陆地填充 */
  land: string;
  /** 陆地描边（行政边界） */
  line: string;
  /** 高亮填充（选中/下钻目标）—— 用 LingChat 主色 */
  accent: string;
  /** 高亮描边 */
  accentLine: string;
  /** 标注文字 */
  label: string;
  /** 标注描边（压在图上也要读得清） */
  labelHalo: string;
  /** 海/底 */
  sea: string;
}

export const THEME_DARK: GeoTheme = {
  sea: "#0b1017",
  land: "#1e2937",
  line: "rgba(255,255,255,0.30)",
  accent: "rgba(121,217,255,0.34)",
  accentLine: "#79d9ff",
  label: "rgba(255,255,255,0.92)",
  labelHalo: "rgba(0,0,0,0.55)",
};
export const THEME_LIGHT: GeoTheme = {
  sea: "#d7e5f0",
  land: "#ffffff",
  line: "rgba(28,48,68,0.45)",
  accent: "rgba(41,150,200,0.26)",
  accentLine: "#1f7fb8",
  label: "rgba(22,34,46,0.92)",
  labelHalo: "rgba(255,255,255,0.75)",
};
/* 🗄 2026-10-06（S9b7 批 D）：这里原来 import 了 `wsScene` 的 `lodPlan` /
   `PRERENDER_LAYER_ID` / `PRERENDER_SOURCE_ID` —— 它们**只**喂下面那个
   `prerenderStyleSpecs()`（同一批退役）。样式真源不该反向依赖场景装配；现役 LOD 层由
   代拍页自己按 `public/vendor/wsScene.mjs` 的 `lodPlan()` 装配（`ws3dshow.html:2511`）。 */

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
   底图 source / layer 的 id
   🗄 2026-10-06（S9b8 批 E，逐符号复核的结论 —— 不是照抄"只剩闸在消费"那句）：
     · **退役（连本体删）**：`ML_SRC="ws-ml-src"` / `ML_LAND="ws-ml-land"` / `ML_LINE="ws-ml-line"`
       / `ML_HI="ws-ml-hi"` / `ML_HI_LINE="ws-ml-hi-line"` —— 唯一铺它们的是 S9b7 已退役的
       `layersFor()`；剥注释后扫 `src`+`public`（排除 vendor）+ 闸目录**全部** .mjs：**零命中**
       （按**字面量** `ws-ml-*` 再扫一遍也零命中，排除"有人直接写字符串"这条漏网）。
     · **收敛（只去 `export`）**：`ML_BG` / `ML_BASE_LAYER` —— 消费者**只在模块内**
       （`styleFor` 里 `id: ML_BG` 与 `id: ML_BASE_LAYER` 各一处）；闸里对它们是 0 引用。
     · **继续导出**：`ML_BASE` —— 闸 `ws_base_maxzoom_selftest.mjs` 用 `ML.ML_BASE` 取底图源
       判 `maxzoom` 收口（同时它也是 `styleFor` 内部那个 source 的键）。
   守卫（可执行，别靠记性）：同闸 ⑦b 段（源码级 + 模块面 + "4 个锚点必须继续导出"的反向判据）。
   ══════════════════════════════════════════════════════════════════════════ */
const ML_BG = "ws-ml-bg";
/** 底图 source/layer 的 id（UI 升级 2026-09-19：没有底图时"地图"只是一块纯色） */
export const ML_BASE = "ws-ml-base";
const ML_BASE_LAYER = "ws-ml-base-l";

/**
 * 免密钥底图（Carto，实测可达 0.57s，**全球覆盖含中国**，署名 OSM+CARTO）。
 *
 * 为什么必须补：原样式里 `sources: {}` ⇒ 世界/省/市/区县每一层都只画一块背景色，
 * 机主一眼就说"只有白底/不像地图"。这里按主题给暗/亮两套，随 `setDark()` 切。
 * ⚠️ 纪律：**只挂实测能取到的源**（带等高线的 opentopomap / Esri 地形从本机网络超时，不写进来）。
 */
/* 🗄 2026-10-06（S9b7 批 D）：`basemapTiles` 去掉 `export` —— 它唯一的消费者是本文件的
   `styleFor`（下面 `tiles: basemapTiles(dark)` 那一处）。外部没人用过（全仓 grep 只命中定义处）。 */
function basemapTiles(dark: boolean): string[] {
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
/* 🗄 2026-10-06（S9b8 批 E）退役：`ML_HI_LINE = "ws-ml-hi-line"` 原来长在这里
   （上一批 S9b7 的墓碑里就记着它零消费者，本批连本体退）。
   逐字墓碑（连同上面那四个，回退时照抄这一份即可）：
     export const ML_SRC = "ws-ml-src";        export const ML_LAND = "ws-ml-land";
     export const ML_LINE = "ws-ml-line";      export const ML_HI = "ws-ml-hi";
     export const ML_HI_LINE = "ws-ml-hi-line";
   原文：`git log -p -- src/components/views/worldsim/wsMapStyle.ts`。 */

/**
 * 样式（MapLibre 的"皮肤"）。**背景色 = 现在的海色**（`.ws-sea-*` 那套的同一来源）。
 *
 * 🔴 这里**不能出现 `glyphs` / `sprite`**（坑②：`glyphs: undefined` 会让样式校验失败，
 *  `load` 永不触发、页面零报错）。数据 source 与图层在 `load` 之后加（换级要 `setData`）。
 */
export function styleFor(theme: GeoTheme, opts: { basemap?: boolean; baseMaxZoom?: number } = {}): Record<string, unknown> {
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
      /* ⚠️ 2026-10-01 首屏审计（`BLUEPRINT-FIRSTPAINT.md` 方案 3）发现的**白等**，已修：
         有 `baseFade` 的主题到 `to` 就完全透明，再往上取瓦片是纯等（实测 z16 每张 330~424ms、8~10 张）。
         `GeoTheme`（本函数的入参类型）上**没有** `baseFade`/`sources` —— 它们在
         `WsMapTheme`/`WsMapLookSpec`（`wsMapTheme.ts`，也就是主题 JSON 的 `themes[*].baseFade`：
         `night` 是 `null`、`anime` 才有值）⇒ 所以收口值由**调用方**用可选的 `opts.baseMaxZoom` 递进来
         （`useWsMapLibre.ts` 建图那条：`stageThemeParts()` → `wsMapTheme.baseMaxZoomFor()`）。
         ⚠️ 2026-10-06（S9b7 批 D）：那条调用点已随 `useWsMapLibre.ts` 删除，`styleForStage` 也已退役
         ⇒ 现在**读这个参数的只剩闸**（`ws_base_maxzoom_selftest.mjs` ①②段）。上面那半句留原样，
         是为了记住"默认值为什么必须是 20"。
         🔴 2026-10-04 语义收窄：那个函数现在**同时**夹一层"主题自己声明的 `sources.base.maxzoom`"
         （只收口、不放大）—— 起因是机主推翻「地面太糊」之后，二次元的淡出终点抬到 18，
         若把 18 原样写进这里，地图库到 z17 就会去要 Esri 那张 **2521B 占位图**
         「Map data not yet available」= 2026-09-25「地图变白/没了」换个入口重演。
         ⇒ 这里拿到的永远是 `min(主题声明的 16, ceil(淡出终点))`。

         🔴 纪律（两条都别破坏）：
         · **默认行为逐字不变** —— 不传 `baseMaxZoom`（`undefined`）时 `maxzoom` 仍是 `20`：
           `?? 20` 只对 `null`/`undefined` 兜底，任何数字（含 0）都原样生效；
           `styleForStage` 的回退路与老调用点因此一个字节都不动；
         · **有淡出才收口** —— 没有 `baseFade` 的主题（对照组 `gray`、主题解析失败的回退路）
           必须**保持 20**：它们真的要瓦片，砍了就糊。别在这里写死一个数字，
           也别把 `GeoTheme` 缺字段这件事用 `as any` 糊过去。 */
      maxzoom: opts.baseMaxZoom ?? 20,
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

/* 🗄 2026-10-06（S9b7 批 D）退役：`layersFor` / `paintUpdatesFor` / `NO_HIGHLIGHT_FILTER`
   三个符号原来长在这里（`layersFor` 铺 `ws-ml-*` 数据层、`paintUpdatesFor` 是换主题的三元组、
   `NO_HIGHLIGHT_FILTER` 是 `layersFor` 里那两条高亮层的 `filter:`）。
   依据：`layersFor` / `paintUpdatesFor` 在**全仓（含本文件）零引用** —— 它们唯一的调用方是
   `useWsMapLibre.ts`（2026-10-06 整份删除）；`NO_HIGHLIGHT_FILTER` 的**唯一**消费者就是
   `layersFor`（`:201` / `:208` 两处 `filter:`），先删 `layersFor` 它就成了零消费者死常量
   （审计口径是"只去 export"，去完 export 仍是死的 —— 所以这里连本体一起退，别骗下一个人）。
   原文：`git log -p -- src/components/views/worldsim/wsMapStyle.ts`（或 `REMOVED-CODE.md` 的 S9b7 条）。
   守卫（可执行）：`ws_base_maxzoom_selftest.mjs` ⑦ 段。 */

/* 🗄 2026-10-06（S9b7 批 D）退役：`WS_MAP_STYLE_SOURCE` / `wsMapStyleLayerIds` 原来长在这里。
   · `WS_MAP_STYLE_SOURCE` 是"样式实现自报家门"的字符串 —— 但**全仓零 import**：
     面板 `wsVerifyChecks.ts:415-418` 判的是**字面量** `c.styleSource === "wsMapStyle.ts"`，
     从没读过这个常量；而且现役代码里**没有任何一处产出 `styleSource` 字段**
     （唯一的生产者 `prerenderStyleSpecs()` 自己也随本批退役）⇒ 退役它对运行期零影响。
     ⚠️ 若将来要给那条面板行接线，锚点该是现役路的产物（`wsDistrictScene.districtStyleOf`），
        不是这里。
   · `wsMapStyleLayerIds` 报的是 `layersFor` 那批 `ws-ml-*` 图层 id ⇒ 随 `layersFor` 一起失去对象。
   守卫：`ws_transport_selftest.mjs` ⑬ 段（模块面 + 源码级）。 */

/* 🗄 2026-10-06（S9b7 批 D）退役：`prerenderStyleSpecs` / `WS_LOD_STYLE_SOURCE` 原来长在这里。
   依据：`src`/`public` 零 import，全仓只有 `ws_lod_selftest.mjs:527` 在调（App 侧**本轮没接线**，
   同闸 `:1528` 的反手判据盯着两页不许用）；它的自证常量只被这个函数自用。
   现役的预渲染层是代拍页自己按 `wsScene.lodPlan()` 装配的（`ws3dshow.html:2511`），
   与这个模块级入口不是同一条路 —— **换不了锚点**（换了就是换被测对象）。
   守卫：`ws_lod_selftest.mjs` ④ 段（含"样式真源里不许有第二份 LOD 装配/阈值"那条换锚点判据）。
   原文：`git log -p -- src/components/views/worldsim/wsMapStyle.ts`。 */

/* 🗄 2026-10-06（S9b7 批 D）退役：`styleForStage` 原来长在这里（区县级"主题外观 + 舞台数据层"
   的组合式 style，2026-09-22 机主选 A）。
   逐条退役理由：
     ① **不在现役路上**：App 的 style 由 `WsDistrictMapLibre.vue` 的 `style: styleNow()` →
        `wsFallback2d.ts` 的 `styleNow()` → `wsDistrictScene.districtStyleOf()` →
        `wsMapTheme.themeStyleParts()` 产出；`src`/`public` 里对本符号零引用。
     ② **唯一调用点早已退役**：它服务的"区县级建图"那条路长在 `useWsMapLibre.ts`（2026-10-06 删除）。
     ③ **换不了锚点**：它守的"区县级调用点与兜底路拿到同一个 `baseMaxZoom`"没有第二个通路可比；
        现役那条路的底图上限由 `themeStyleParts()` 一处收口，由 `ws_base_maxzoom_selftest.mjs`
        的 ⑤/⑥ 段单独守着。
   ⇒ 代价照实记：退掉它 = 放弃「底图源上限双通路一致」那条守卫（现役路不受影响）。
   守卫：`ws_base_maxzoom_selftest.mjs` ③ 段（对象不许回来 / 现役路仍走 `districtStyleOf`）。
   原文：`git log -p -- src/components/views/worldsim/wsMapStyle.ts`。 */
