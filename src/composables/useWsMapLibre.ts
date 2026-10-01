/**
 * useWsMapLibre —— 「世界模拟」底图引擎的 **MapLibre 版**（P1a：换引擎，接口与 Canvas2D 版逐一对应）
 *
 * ── 与 `useWsGeoStage`（Canvas2D 版）的关系 ─────────────────────────────────
 * **不删旧的**。两个 composable 的**公开接口逐字对应**：
 *   `{ ok, err, feats, mount(), load(ad, animate?), highlight(ads), setDark(bool), zoomBy(f), reset(), layout() }`
 * 调用方（`WorldSim.vue`）只要把 `useWsGeoStage(...)` 换成 `useWsMapLibre(...)`，其余一行不用改
 * （线上多两个可选扩展：`info`（诊断指标）、`destroy()`、`get map()`）。
 *
 * 换引擎的动机（机主已批准，P0 已验证）：MapLibre 自带成熟的**手势惯性与连续缩放**，
 * 我们不用自己写捏合/惯性；P0 实测 60fps / 帧均 16.67ms / 加载 246~386ms / 0 报错。
 *
 * ── 🔴 回退是硬要求（本文件最重要的一条性质）────────────────────────────────
 * `ok` 的语义是「**引擎可用且已就绪**」。下面任何一种情况都必须是 `ok=false` + 可读 `err`：
 *   · 没有 WebGL（软件渲染被禁 / 低端设备）    · vendored 模块加载失败
 *   · 样式在超时内没加载完（含样式校验失败）    · 首次取数失败
 *   · WebGL 上下文丢失（Android WebView 上真发生过）
 * 页面据此**无声回退**到旧路（后端现画的 SVG）——**绝不能因为新引擎把地图整个弄没**。
 * 所以：就绪前 `.ws-geo__cv`（Canvas2D 的 canvas）保持原样、本引擎的容器不可见也不抢手势；
 * 一旦失败就把容器拆掉、把 canvas 原样放回来。
 *
 * ── 🔴 三个实测踩过的坑（别再踩）────────────────────────────────────────────
 * ① **绝不在模块里写静态 `import ... from "/vendor/..."`** → rollup 会去解析这个路径并
 *    **构建失败**（`Rollup failed to resolve import`），连 `@vite-ignore` 都救不了静态写法。
 *    这里把 URL 在运行期拼出来（`ML_ENGINE_PATH`）+ 带 `@vite-ignore` 的动态 import，
 *    打包器完全不碰它。
 * ② **样式对象里绝不能出现 `glyphs: undefined`** → 样式校验直接失败 → `load` 永不触发 →
 *    没有图层、没有 FPS，而**页面零报错**（只在 MapLibre 内部记录）。所以这里连 `glyphs`
 *    这个键都不写，并且额外加了 `STYLE_TIMEOUT_MS` 兜底：样式超时 = 明确的 `err`，
 *    不是"永远转圈"。
 * ③ **canvas 必须 `preserveDrawingBuffer: true`**，否则**无头截图拍到空白**（页面其实是好的）。
 *    真机不受影响，但验证链路必须开。
 *
 * ── 另外两条本文件特有的决定 ───────────────────────────────────────────────
 * · **public 资源按 `location.href` 解析**（`assetUrl()`）：`/vendor/maplibre/*` 属于
 *   public 目录，永远由**页面所在源**提供。⚠️ 不能按模块 URL 解析 —— 验证页可能从另一个源
 *   取本模块（见已退休的 `public/wsmlstage.html`，2026-09-24 删，见 `world_map/REMOVED-CODE.md`），那样会把 /vendor 指到错的源上（实测：vite dev
 *   的 public 快照里没有 maplibre → 拿到 index.html → 模块加载失败）。
 * · **`glyphs` 没有服务**（vendored 目录里没有字体）⇒ MapLibre 的 `symbol` 层画不出字。
 *   所以全国视图的 7 个大区名改用 **HTML Marker**（`MACRO_ANCHORS`，与 Canvas2D 版同一份锚点）。
 */
import { getCurrentInstance, isRef, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { geoJson } from "@/api/services/worldMap";
/* 🎨 对齐清单 B：舞台外观改吃主题（与小区级同一份真源） */
import { themeStyleParts, wsMapTheme } from "@/components/views/worldsim/wsMapTheme";
import { parseFeatures, THEME_DARK, THEME_LIGHT, type GeoFeat, type GeoTheme } from "@/components/views/worldsim/wsGeoMap";
/* 🔴 2026-09-22：`ML_*` 常量组与 `styleFor`/`layersFor`/`paintUpdatesFor` **已搬至 `wsMapStyle.ts`**
   （唯一真源）—— **勿再本地实现**。
   ⚠️ 只写 `export *` **不够**（它不建本地绑定），而本文件剩余代码仍在用这些符号
   ⇒ 必须**同时 import 回来**；下面这份名单就是逐符号核对出来的。 */
import {
  styleForStage,
  WS_MAP_STYLE_SOURCE,
  wsMapStyleLayerIds,
  assetUrl,
  NO_HIGHLIGHT_FILTER,
  basemapTiles,
  ML_SRC,
  ML_LAND,
  ML_HI,
  ML_HI_LINE,
  styleFor,
  layersFor,
  paintUpdatesFor,
} from "@/components/views/worldsim/wsMapStyle";
export * from "@/components/views/worldsim/wsMapStyle";

import { basemapRiskOf, probeBasemapTile } from "@/composables/wsTileGuard";
import { contourFeatureCollection, contoursForView } from "@/composables/wsContour";

/* ══════════════════════════════════════════════════════════════════════════
   public/vendor 里的 MapLibre（vendored，零依赖改动 —— 不许动 package.json）
   ══════════════════════════════════════════════════════════════════════════ */
const ML_VENDOR_DIR = "/vendor/maplibre";
/** 引擎模块（584KB）+ 它的 worker/shared 分块由相对 import 自己带出来 */
export const ML_ENGINE_PATH = `${ML_VENDOR_DIR}/maplibre-gl.mjs`;
export const ML_CSS_PATH = `${ML_VENDOR_DIR}/maplibre-gl.css`;
/** 样式（= 地图皮肤 JSON）加载超时。超过就判失败并回退，绝不让页面对着空白转圈。 */
export const STYLE_TIMEOUT_MS = 4000;

/** 等高线（引擎层）：国/省/市/区县都要有真地形线，不只小区级那一个组件 */
export const ML_CONTOUR_SRC = "ws-ml-contour";
export const ML_CONTOUR_LAYER = "ws-ml-contour-l";
/** 低于这个缩放不画等高线（世界级视野上线会糊成一片、也没意义） */
export const ML_CONTOUR_MIN_ZOOM = 7;

/** 空集合（source 先建出来，换级用 `setData`，不重建图层 ⇒ 缩放/换级都不掉帧） */
const EMPTY_FC = { type: "FeatureCollection", features: [] as unknown[] };


/* ══════════════════════════════════════════════════════════════════════════
   MapLibre 的最小结构类型（**不装依赖**：包管理不许动，所以不 import "maplibre-gl" 的类型）
   ══════════════════════════════════════════════════════════════════════════ */
interface MlLngLat {
  lng: number;
  lat: number;
}
export interface MlMap {
  on(ev: string, cb: (e: never) => void): void;
  once(ev: string, cb: (e: never) => void): void;
  off(ev: string, cb: (e: never) => void): void;
  getCanvas(): HTMLCanvasElement;
  getStyle(): { layers?: Array<{ id: string }> } | undefined;
  addSource(id: string, spec: Record<string, unknown>): void;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  addLayer(spec: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  setPaintProperty(layer: string, name: string, value: unknown): void;
  setFilter(layer: string, filter: unknown): void;
  setLayoutProperty(layer: string, name: string, value: unknown): void;
  /** 命中判定：屏幕点 → 当前**渲染出来的**要素（只认我们自己的图层） */
  queryRenderedFeatures(
    point: { x: number; y: number },
    opts?: { layers?: string[] }
  ): Array<{ properties?: Record<string, unknown> }>;
  fitBounds(bounds: [[number, number], [number, number]], opts?: Record<string, unknown>): void;
  easeTo(opts: Record<string, unknown>): void;
  resize(): void;
  remove(): void;
  getZoom(): number;
  getPitch(): number;
  getBearing(): number;
  getCenter(): MlLngLat;
  isStyleLoaded(): boolean;
  /** MapLibre 的**公开字段**：地图被 `remove()` 或上下文丢失后会变成 undefined（判据用） */
  style?: unknown;
}
interface MlMarker {
  setLngLat(p: [number, number]): MlMarker;
  addTo(map: MlMap): MlMarker;
  remove(): void;
  getElement(): HTMLElement;
}
interface MlModule {
  Map: new (opts: Record<string, unknown>) => MlMap;
  Marker: new (opts?: Record<string, unknown>) => MlMarker;
  getVersion?: () => string;
}

/** 模块级缓存：多个舞台实例共享一次 import（584KB，别重复拉） */
let enginePromise: Promise<MlModule> | null = null;
let cssInjected = false;

/* ══════════════════════════════════════════════════════════════════════════
   公开类型
   ══════════════════════════════════════════════════════════════════════════ */
export interface WsMapLibrePick {
  adcode: string;
  name: string;
}

/** 松引用：可以是 Vue 的 ref，也可以是**裸元素** ——
 *  验证页（`public/wsmlstage.html`，**2026-09-24 已退休**）要能在**没有 Vue 组件实例**的环境里驱动本 composable。 */
export type MaybeEl<T> = Ref<T | null> | T | null | undefined;

/** 相机留白：顶栏 / 底部动作条 / 浮动角标都压在地图上，fitBounds 必须给它们让位 */
export interface WsFitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export type WsFitPaddingIn = number | Partial<WsFitPadding> | undefined;

/** ⚠️ 这三个数是**照 WorldSim 的实际浮块**定的（顶栏 + 时段角标 ≈ 52px 高；
 *  底部动作条 ≈ 96px）⇒ 全国/省级图的上下边缘不会被浮块盖住。 */
export const DEFAULT_FIT_PADDING: WsFitPadding = { top: 52, right: 14, bottom: 96, left: 14 };
/** fitBounds 的 zoom 上限：区县级 bbox 很窄时不至于冲进 zoom 20（那是"贴脸"而不是"看全") */
export const FIT_MAX_ZOOM = 13.5;
export const ML_MIN_ZOOM = 1;
export const ML_MAX_ZOOM = 18;

export interface UseWsMapLibreOpts {
  /** 舞台容器（量尺寸、放 map、以及隐藏 `.ws-geo__cv` 的地方） */
  host: MaybeEl<HTMLElement>;
  /** 现有的 Canvas2D 画布：引擎就绪后被隐藏，失败/销毁时原样放回 */
  canvas?: MaybeEl<HTMLCanvasElement>;
  /** 当前级的 adcode（变化即换级） */
  adcode: () => string;
  /** 点了某个区域（点空白给空 adcode —— 页面自己判空） */
  onPick: (p: WsMapLibrePick) => void;
  /** 深色主题（跟随世界模拟的深色开关） */
  dark: () => boolean;
  /** 相机留白（可选；默认 `DEFAULT_FIT_PADDING`） */
  fitPadding?: WsFitPaddingIn;
  /** 换级飞行时长（ms，默认 600；0 = 不做动画） */
  flyMs?: number;
}

/** 诊断指标（**不影响**与 `useWsGeoStage` 的对齐；给验证页/排障看） */
export interface WsMapLibreInfo {
  engine: "maplibre";
  /** 引擎版本（`getVersion()`） */
  version: string;
  /** `mount()` → 图层就绪的毫秒 */
  loadMs: number;
  /** 最近一次取数（geoJson → setData → fitBounds）的毫秒 */
  dataMs: number;
  /** 当前要素数 */
  feats: number;
  /** MapLibre 自己报的错误（`map.on("error")`）—— 页面 `window.onerror` 之外的第二条线索 */
  errors: string[];
  /** 生命周期流水（boot / layers+ / data / ctxlost / ctxrestored …）：
   *  排查"地图什么时候坏的"只需要看这一串（有界 24 条）。 */
  journal: string[];
}

/* ══════════════════════════════════════════════════════════════════════════
   纯函数（全部可被 node 单测：`world_map/wsmaplibre_selftest.mjs`）
   ══════════════════════════════════════════════════════════════════════════ */

/** `[minLng, minLat, maxLng, maxLat]` */
export type BBox = [number, number, number, number];

/** 按需把 padding 规格归一成四边数字（数字 = 四边相同） */
export function normalizePadding(p?: WsFitPaddingIn): WsFitPadding {
  if (typeof p === "number" && Number.isFinite(p)) return { top: p, right: p, bottom: p, left: p };
  const o = (p || {}) as Partial<WsFitPadding>;
  const pick = (k: keyof WsFitPadding) =>
    Number.isFinite(o[k] as number) ? Math.max(0, Number(o[k])) : DEFAULT_FIT_PADDING[k];
  return { top: pick("top"), right: pick("right"), bottom: pick("bottom"), left: pick("left") };
}

/**
 * FeatureCollection 的 bbox（只认面/线/点这些**真几何**，忽略没有坐标的要素）。
 *
 * 为什么要自己算而不是用 `properties.center`：全国 35 个要素里，`center` 是**行政中心点**
 * 而不是几何中心（例如某些省的 center 落在边界外），拿它做 fitBounds 会偏。
 */
export function bboxOf(fc: unknown): BBox | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lng = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const x of c) walk(x);
  };
  const features = (fc as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return null;
  for (const f of features) walk((f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates);
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat))
    return null;
  return [minLng, minLat, maxLng, maxLat];
}

/** 退化 bbox（只有一个点、或一条零面积线）→ 撑开一点点：
 *  `fitBounds` 拿到零宽高会算出 **Infinity zoom**（MapLibre 会警告并放弃）。 */
export function expandDegenerateBounds(b: BBox, minSpan = 1e-3): BBox {
  const [w, s, e, n] = b;
  const half = Math.max(0, minSpan) / 2;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  return [
    e - w < minSpan ? cx - half : w,
    n - s < minSpan ? cy - half : s,
    e - w < minSpan ? cx + half : e,
    n - s < minSpan ? cy + half : n,
  ];
}

/** 「要素数 → 要不要画大区锚点」：与 Canvas2D 版同一条规则（`feats.length > 20` 视为全国） */
export function macroAnchorsVisible(featCount: number): boolean {
  return featCount > 20;
}

/**
 * bbox → `fitBounds` 参数（**纯函数，自检的主要对象**：留白换算错了图上就是"地图被顶栏盖住"）。
 * `animate=false` 时 `duration=0`（换级首帧不做动画）。
 */
export function fitOptionsFor(
  b: BBox,
  padding?: WsFitPaddingIn,
  o: { animate?: boolean; flyMs?: number; maxZoom?: number } = {}
): { bounds: [[number, number], [number, number]]; padding: WsFitPadding; duration: number; maxZoom: number } {
  const bb = expandDegenerateBounds(b);
  return {
    bounds: [
      [bb[0], bb[1]],
      [bb[2], bb[3]],
    ],
    padding: normalizePadding(padding),
    duration: o.animate === false ? 0 : Math.max(0, o.flyMs ?? 600),
    maxZoom: o.maxZoom ?? FIT_MAX_ZOOM,
  };
}

/** 相对倍数 → 绝对 zoom（MapLibre 的 zoom 是 log2 量纲；`f>1` 放大），并按 [min,max] 夹住 */
export function zoomAfter(z: number, f: number, min = ML_MIN_ZOOM, max = ML_MAX_ZOOM): number {
  const factor = Number.isFinite(f) && f > 0 ? f : 1;
  const next = Number(z) + Math.log2(factor);
  if (!Number.isFinite(next)) return min;
  return Math.max(min, Math.min(max, next));
}

/**
 * 高亮 adcode 列表 → MapLibre 过滤器表达式。
 *
 * ⚠️ 后端 `properties.adcode` 是**数字**（110000），而页面传进来的是字符串 ⇒ 必须
 * `to-string` 归一，否则 `["==", ["get","adcode"], "110000"]` 永远匹配不上（静默不亮）。
 * empty ⇒ 一个都匹配不上的过滤器（而不是 `null`：`null` 会让**整层**亮起来）。
 */
export function highlightFilterOf(ads: string[]): unknown[] {
  const list = (ads || []).map((a) => String(a ?? "").trim()).filter(Boolean);
  if (!list.length) return NO_HIGHLIGHT_FILTER;
  const any = list.map((a) => ["==", ["to-string", ["get", "adcode"]], a]);
  return any.length === 1 ? any[0] : ["any", ...any];
}




/**
 * 全国视图的**大区锚点**（规格：全国只留 5~8 个，不再标 32 个省名）。
 * ⚠️ 与 `wsGeoMap.ts` 的 `MACRO_ANCHORS` 是**同一份表**（那边没有导出，这里只能复制）——
 * `wsmaplibre_selftest.mjs` 直接读 `wsGeoMap.ts` 源码逐项对拍，防两边漂移。
 */
export const MACRO_ANCHORS: Array<{ name: string; lng: number; lat: number }> = [
  { name: "西北", lng: 86.5, lat: 42.0 },
  { name: "华北", lng: 114.5, lat: 39.5 },
  { name: "东北", lng: 126.5, lat: 45.5 },
  { name: "华东", lng: 119.0, lat: 31.5 },
  { name: "华中", lng: 112.5, lat: 29.5 },
  { name: "西南", lng: 101.5, lat: 27.5 },
  { name: "华南", lng: 110.5, lat: 22.5 },
];

/** 有没有 WebGL（没有就**必须**回退，别让页面白屏）。
 *
 *  ⚠️ 预检本身会**真的创建一个 WebGL 上下文**（Chrome 每个页面只允许 ~16 个），
 *  探完必须把它丢掉 —— 否则挂载一次漏一个，软件渲染（SwiftShader）下就是
 *  "地图莫名其妙丢了上下文"（2026-09-18 实测：无头 SwiftShader 上真丢过）。 */
export function webglAvailable(doc: Document | null = typeof document !== "undefined" ? document : null): boolean {
  if (!doc) return false;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const c = doc.createElement("canvas");
    gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGL2RenderingContext | WebGLRenderingContext | null;
    return !!gl;
  } catch {
    return false;
  } finally {
    try {
      (gl as { getExtension?: (n: string) => { loseContext?: () => void } | null } | null)
        ?.getExtension?.("WEBGL_lose_context")
        ?.loseContext?.();
    } catch {
      /* 丢掉探针上下文失败无所谓，不影响判定 */
    }
  }
}

/** 要素数（不认识的结构给 0） */
export function featureCount(fc: unknown): number {
  const f = (fc as { features?: unknown[] } | null)?.features;
  return Array.isArray(f) ? f.length : 0;
}

function elOf<T>(v: MaybeEl<T>): T | null {
  if (isRef(v)) return (v.value as T | null) ?? null;
  return (v as T | null) ?? null;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e ?? "未知错误");
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

async function importEngine(): Promise<MlModule> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // ⚠️ 运行期拼 URL + `@vite-ignore`：见文件头坑①（静态写法会让 rollup 构建失败）
      const url = assetUrl(ML_ENGINE_PATH);
      const mod = (await import(/* @vite-ignore */ url)) as unknown as { default?: MlModule } & MlModule;
      const m = (mod?.default || mod) as MlModule;
      if (!m || typeof m.Map !== "function") throw new Error(`模块形状不对（没有 Map）：${url}`);
      return m;
    })().catch((e) => {
      enginePromise = null; // 允许重试（网络/资源病态时别把失败钉死）
      throw e;
    });
  }
  return enginePromise;
}

/**
 * 把 vendored 的 MapLibre **样式表**注入 `<head>`（幂等，一次就够）。
 *
 * 🔴 **2026-10-01 导出给"绕过 composable 的宿主"**：机主报「人物位置错位，疑似没有 z 轴，倾斜地图会错位」——
 * 实测（`~/chk/_mlcss_probe.mjs`）：App 入口那一屏**根本没有这张样式表**
 * （`link[data-ws-ml-css]` 不存在、`.maplibregl-marker` 规则 `null`、`getComputedStyle(钉).position === "static"`），
 * 于是角色钉子**掉进文档流**（它们的 `translate(x,y)` 只是叠在流式位置上）⇒ 人整体被推到屏幕外/错位，
 * 间距还恰好等于各自高度（`~/chk/_pins_probe.mjs` 量到 4 个钉子在 y 589~958，视口只有 557 高）。
 * 根因：`WsDistrictMapLibre.vue` 为了不碰 package.json **自己 `import()` 了 `/vendor/maplibre/maplibre-gl.mjs`**，
 * 而这条路上原来只有引擎、没有样式表（引擎由本文件的 `boot()` 载入时才会 `injectCss()`）。
 * ⇒ 谁直接载引擎，谁就必须调这个函数（`wsmaplibre_selftest.mjs` ⑤ 盯着这条）。
 */
export function injectCss(): void {
  if (cssInjected || typeof document === "undefined") return;
  if (document.querySelector("link[data-ws-ml-css]")) {
    cssInjected = true;
    return;
  }
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = assetUrl(ML_CSS_PATH);
  l.setAttribute("data-ws-ml-css", "1");
  document.head.appendChild(l);
  cssInjected = true;
}

/* ══════════════════════════════════════════════════════════════════════════
   composable
   ══════════════════════════════════════════════════════════════════════════ */
export function useWsMapLibre(o: UseWsMapLibreOpts) {
  /** 引擎可用且**已就绪**（false = 页面应回退到旧路） */
  const ok = ref(false);
  /** 人话错误（回退原因） */
  const err = ref("");
  /** 当前画出来的要素（给"点空白处取消选中"/面板定位用）—— 与 Canvas2D 版**同一个类型** */
  const feats = ref<GeoFeat[]>([]);
  const info = ref<WsMapLibreInfo & { styleSource?: string; styleLayerIds?: string[] }>({
    engine: "maplibre",
    /* 🔎 对齐清单 B 的自证：这张图的 style 由 `wsMapStyle.ts` 产出（换源有没有生效看这里） */
    styleSource: WS_MAP_STYLE_SOURCE,
    styleLayerIds: wsMapStyleLayerIds(),
    version: "",
    loadMs: 0,
    dataMs: 0,
    feats: 0,
    errors: [],
    journal: [],
  });

  let map: MlMap | null = null;
  let container: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;
  let booting = false;
  let destroyed = false;
  let pendingAd = "";
  let lastHi: string[] = [];
  let lastBBox: BBox | null = null;
  let canvasPrevDisplay: string | null = null;
  let hostPatchedPosition = false;
  /** Marker 构造器（大区锚点用；`load` 之后才拿得到） */
  let engineCtor: MlModule["Marker"] | null = null;
  const markers: MlMarker[] = [];
  /** adcode → FeatureCollection（换级来回切不用重复取；有界 LRU） */
  const cache = new Map<string, unknown>();
  const CACHE_MAX = 8;
  const stops: Array<() => void> = [];

  const themeNow = (): GeoTheme => (o.dark() ? THEME_DARK : THEME_LIGHT);

  function cacheSet(ad: string, fc: unknown): void {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ad, fc);
  }

  function setContainerVisible(on: boolean): void {
    if (container) {
      container.style.visibility = on ? "visible" : "hidden";
      container.style.pointerEvents = on ? "auto" : "none";
    }
    const cv = elOf(o.canvas);
    if (!cv) return;
    if (on) {
      if (canvasPrevDisplay === null) canvasPrevDisplay = cv.style.display;
      cv.style.display = "none";
    } else if (canvasPrevDisplay !== null) {
      cv.style.display = canvasPrevDisplay;
      canvasPrevDisplay = null;
    }
  }

  /**
   * 等容器**真的有布局尺寸**再建图（上限 `ms`，超时也继续 —— 不能因为量不到尺寸就不建图）。
   *
   * 为什么必须有：MapLibre 建图时会量一次容器尺寸并据此设 canvas buffer；
   * 量到 0×0 就退回**默认 300×150**，之后除非有人 `resize()`，否则**永远**是那个尺寸。
   * （2026-09-21 机主的面板证据：`画布 300×150 像素 / 布局 1253×429 / dpr=3`、alpha=0 ⇒ 一帧都没画。）
   */
  async function waitForBox(el: HTMLElement | null, ms = 3000): Promise<void> {
    if (!el) return;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (el.clientWidth > 0 && el.clientHeight > 0) return;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /** 建图后补 resize：rAF 一次 + 延迟几次（覆盖加载态收起/转屏/分屏）。计时器在 destroy 里清 */
  let resizeTimers: number[] = [];
  function kickResize(): void {
    const kick = (): void => {
      try {
        map?.resize();
      } catch {
        /* 地图没了就算了 */
      }
    };
    requestAnimationFrame(kick);
    for (const t of [250, 1000, 2500]) resizeTimers.push(window.setTimeout(kick, t));
  }

  function ensureContainer(host: HTMLElement): HTMLElement {
    if (container) return container;
    // `.ws-geo` 本来就是定位上下文；没有就补一个（并在销毁时还原，别改别人的样式）
    try {
      if (getComputedStyle(host).position === "static") {
        host.style.position = "relative";
        hostPatchedPosition = true;
      }
    } catch {
      /* getComputedStyle 在极端环境下可能抛，忽略 */
    }
    const el = document.createElement("div");
    el.className = "ws-geo__ml";
    el.setAttribute("data-ws-ml", "1");
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      // ⚠️ 就绪前用 `visibility:hidden` 而不是 `display:none`：
      //    MapLibre 建图时要量容器尺寸，display:none 会量到 0×0（首帧空白）。
      visibility: "hidden",
      pointerEvents: "none",
      zIndex: "2",
      background: themeNow().sea,
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(el);
    container = el;
    return el;
  }

  /** 取主题的 style 零件（`themeStyleParts`）；**任何失败都返回 null** ⇒ 调用方回退 `styleFor` */
  function stageThemeParts(): { sky?: unknown; sources: Record<string, unknown>; layers: Array<Record<string, unknown>> } | null {
    try {
      const id = (typeof localStorage !== "undefined" ? (localStorage.getItem("wsm:v1:mapTheme") as "anime" | "night" | null) : null) || "anime";
      const t = wsMapTheme(id === "night" ? "night" : "anime");
      const p = themeStyleParts(t, false, 0);
      /* 如实标注来源（面板那行读它 —— 换源有没有生效，页面上直接看得到） */
      info.value.styleSource = `${WS_MAP_STYLE_SOURCE}/theme(${id})`;
      return { sky: (p as { sky?: unknown }).sky, sources: (p as { sources: Record<string, unknown> }).sources, layers: (p as { layers: Array<Record<string, unknown>> }).layers };
    } catch {
      info.value.styleSource = `${WS_MAP_STYLE_SOURCE}/fallback(styleFor)`;
      return null;
    }
  }

  function destroyMarkers(): void {
    for (const m of markers.splice(0)) {
      try {
        m.remove();
      } catch {
        /* 地图已销毁 */
      }
    }
  }

  function styleLabel(el: HTMLElement, theme: GeoTheme): void {
    el.style.cssText = [
      "font:600 13px/1 -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
      `color:${theme.label}`,
      // 光晕用 text-shadow 叠两遍（Canvas2D 版是 strokeText；效果一致但不需要 glyphs）
      `text-shadow:0 0 3px ${theme.labelHalo}, 0 0 3px ${theme.labelHalo}`,
      "white-space:nowrap",
      "pointer-events:none",
      "user-select:none",
      "-webkit-user-select:none",
    ].join(";");
  }

  /** 全国视图才画大区锚点；下钻后撤掉（与 Canvas2D 版 `showMacro` 同规则） */
  function refreshMarkers(featCount: number): void {
    const m = map;
    if (!m || !container) return;
    if (!macroAnchorsVisible(featCount)) {
      destroyMarkers();
      return;
    }
    if (markers.length) return;
    const MarkerCtor = engineCtor;
    if (!MarkerCtor) return;
    const theme = themeNow();
    for (const a of MACRO_ANCHORS) {
      const el = document.createElement("div");
      el.className = "ws-ml-label";
      el.textContent = a.name;
      styleLabel(el, theme);
      markers.push(new MarkerCtor({ element: el, anchor: "center" }).setLngLat([a.lng, a.lat]).addTo(m));
    }
  }

  function updateMarkerTheme(theme: GeoTheme): void {
    for (const m of markers) styleLabel(m.getElement(), theme);
  }

  function applyTheme(m: MlMap | null, theme: GeoTheme): void {
    if (container) container.style.background = theme.sea;
    if (!m) return;
    for (const [layer, prop, value] of paintUpdatesFor(theme)) {
      try {
        if (m.getLayer(layer) === undefined) continue;
        m.setPaintProperty(layer, prop, value);
      } catch {
        /* 图层还没加：忽略 */
      }
    }
    updateMarkerTheme(theme);
  }

  function journal(ev: string): void {
    info.value.journal.push(ev);
    if (info.value.journal.length > 24) info.value.journal.shift();
  }

  /** 把 source + 四个图层补齐。
   *
   *  为什么需要它（实测踩到的）：WebGL 上下文丢失时 MapLibre 会**把样式整个拆掉**
   *  （`map.style` 变成 undefined）并在恢复时重建 —— 重建出来的样式里如果没有我们的图层，
   *  地图就只剩一层背景色（**看起来就是"全黑但没有报错"**）。
   *  所以任何"要画数据"的时机都先过一遍 `ensureLayers()`，不要假设图层一直在。 */
  /* ── 等高线（引擎层）────────────────────────────────────────────────────
     与小区级共用同一套纯函数（`wsContour.ts`）：**按视野换 DEM 层级 + 多瓦片拼接**。
     省/市级视野用 z9~z11（一张瓦片覆盖几十公里），街区级才用 z12~z13 —— 否则要么糊成一片、
     要么为覆盖视野得拼几十张瓦片（手机上纯属浪费）。 */
  let contourTimer = 0;
  let lastContourKey = "";

  async function refreshContours(): Promise<void> {
    const m = map;
    if (!m || destroyed) return;
    try {
      const z = m.getZoom();
      if (z < ML_CONTOUR_MIN_ZOOM) {
        journal("contour:zoom-out");
        return;
      }
      const c = m.getCenter();
      const key = `${z.toFixed(1)},${c.lng.toFixed(2)},${c.lat.toFixed(2)}`;
      if (key === lastContourKey) return;
      lastContourKey = key;
      const r = await contoursForView({ lng: c.lng, lat: c.lat, mapZoom: z });
      if (destroyed || !map) return;
      const data = contourFeatureCollection(r.feats);
      const src = map.getSource(ML_CONTOUR_SRC);
      if (src) {
        src.setData(data);
      } else {
        map.addSource(ML_CONTOUR_SRC, { type: "geojson", data });
        map.addLayer({
          id: ML_CONTOUR_LAYER,
          type: "line",
          source: ML_CONTOUR_SRC,
          paint: {
            "line-color": [
              "case",
              ["==", ["%", ["get", "ele"], 100], 0],
              "#ffd28a",
              "rgba(121, 217, 255, 0.45)",
            ],
            "line-width": ["case", ["==", ["%", ["get", "ele"], 100], 0], 1.1, 0.45],
            "line-opacity": 0.75,
          },
        });
      }
      journal(`contour:z${r.demZ} ${r.feats.length}段 ${r.ms}ms${r.missing ? ` 缺${r.missing}` : ""}`);
    } catch (e) {
      journal(`contour:fail ${String((e as Error)?.message || e).slice(0, 40)}`);
    }
  }

  function ensureLayers(): boolean {
    const m = map;
    if (!m) return false;
    try {
      if (!m.style) return false; // 样式还没装好（重建中）
      /* 🛟 **幂等护栏**（2026-09-24，主会话放行 ③①）：
         `styleForStage()`（建图时那条）**已经把 `ws-ml-*` 数据层放进 style 里了**，所以正常情况下
         走到这里 `ML_LAND` 已经存在、整段跳过。这段保留的意义是**时序兜底**：
         样式重建中 / 主题切换后 / 旧包加载顺序不同时，数据层可能还没装上 —— 那时按需补插。
         ⇒ **行为不变**：判据仍是"`ML_LAND` 不存在才补"，且逐层 `getLayer(id) === undefined` 才 `addLayer`
         （重复插入本来就不会发生，这里只是把"为什么保留"写成显式注释 + 逐层判据）。
         ⚠️ 不许把它简化成"无条件 addLayer" —— 那会在 style 已含数据层时抛 duplicate layer id。 */
      if (m.getLayer(ML_LAND) === undefined) {
        if (!m.getSource(ML_SRC)) m.addSource(ML_SRC, { type: "geojson", data: EMPTY_FC });
        for (const layer of layersFor(themeNow())) {
          const id = String(layer.id);
          if (m.getLayer(id) === undefined) m.addLayer(layer); // ← 逐层幂等判据
        }
        applyHighlight(lastHi); // 图层是新的 → 高亮过滤器要重打一遍
        journal("layers+");
      }
      return true;
    } catch {
      journal("layers!err");
      return false;
    }
  }

  function applyHighlight(ads: string[]): void {
    const m = map;
    if (!m) return;
    const f = highlightFilterOf(ads);
    for (const id of [ML_HI, ML_HI_LINE]) {
      try {
        if (m.getLayer(id) === undefined) continue;
        m.setFilter(id, f);
      } catch {
        /* 图层还没加：忽略 */
      }
    }
  }

  function addMarkersIfNeeded(): void {
    refreshMarkers(feats.value.length);
  }

  /** 就绪：把 canvas 换下来、把 map 容器亮出来，并且**只在这个时刻**接管手势 */
  function show(on: boolean): void {
    setContainerVisible(on);
    if (on && map) {
      try {
        map.resize();
      } catch {
        /* 容器尺寸异常 */
      }
    }
  }

  function onPickEvent(e: { point?: { x: number; y: number } }): void {
    const m = map;
    if (!m || !e?.point) return;
    let adcode = "";
    let name = "";
    try {
      // 只查**陆地填充层**：用渲染出来的要素做命中，比 Canvas2D 版的射线法还准
      //（射线法要自己处理孔洞；这里问引擎"我这一像素上画了谁"）
      const hits = m.queryRenderedFeatures(e.point, { layers: [ML_LAND] });
      const p = hits?.[0]?.properties || {};
      const ad = p.adcode;
      if (ad !== undefined && ad !== null && String(ad)) {
        adcode = String(ad);
        name = String(p.name ?? adcode);
      }
    } catch {
      /* 图层未就绪：当作点空白（与 Canvas2D 版的 hit() 一致） */
    }
    o.onPick({ adcode, name });
  }

  function onContextLost(): void {
    // Android WebView / 软件渲染上真会发生（`wsgame.html` 与 P1a 的无头 SwiftShader 都实测到）
    journal("ctxlost");
    info.value.errors.push("webglcontextlost");
    err.value = "WebGL 上下文丢失（设备回收了 GPU 上下文）";
    ok.value = false;
    show(false); // 把 canvas 放回去 → 页面回退旧路，而不是留一块黑
  }

  /** 上下文回来了 → **自愈**：MapLibre 会用"丢失前保存的样式"重建（含我们加过的图层），
   *  但重建是异步的，所以这里轮询等样式装好，再把图层补齐、把数据重画、把地图亮出来。
   *  等不到就维持回退态（`ok=false`），页面照旧用旧路 —— 绝不假装好了。 */
  function onContextRestored(): void {
    journal("ctxrestored");
    info.value.errors.push("webglcontextrestored");
    let tries = 0;
    const heal = () => {
      const m = map;
      if (!m) return;
      if (!m.style && tries++ < 20) return void setTimeout(heal, 150);
      if (!ensureLayers()) return void (tries++ < 20 ? setTimeout(heal, 150) : journal("heal:give-up"));
      journal("healed");
      ok.value = true;
      err.value = "";
      show(true);
      void load(pendingAd || o.adcode(), false);
    };
    setTimeout(heal, 200);
  }

  function teardown(): void {
    destroyMarkers();
    engineCtor = null;
    stopObserving();
    try {
      map?.remove();
    } catch {
      /* 已经销毁 */
    }
    map = null;
    for (const t of resizeTimers) window.clearTimeout(t);
    resizeTimers = [];
    container?.remove();
    container = null;
    setContainerVisible(false);
    const host = elOf(o.host);
    if (host && hostPatchedPosition) {
      host.style.position = "";
      hostPatchedPosition = false;
    }
  }

  function fail(msg: string): void {
    err.value = msg;
    ok.value = false;
    teardown();
  }

  function stopObserving(): void {
    ro?.disconnect();
    ro = null;
  }

  async function boot(host: HTMLElement): Promise<void> {
    const t0 = performance.now();
    try {
      if (!webglAvailable()) throw new Error("WebGL 不可用（软件渲染被禁 / 低端设备）");
      /* 🎨 **样式表要在引擎之前发**（2026-10-01 首屏审计）：`injectCss()` 只插一个 `<link>`
         （幂等、不阻塞 JS），而 `importEngine()` 是 584KB 的 await ⇒ 排在它后面发请求
         等于白等一次解析。WebGL 预检放在最前面是有意的：2D 降级那条路**不该付这份 CSS**。 */
      injectCss();
      const mod = await importEngine();
      if (destroyed) return;
      info.value.version = mod.getVersion?.() || "?";

      const el = ensureContainer(host);

      /* ── 底图预检（2026-09-19 事故的护栏）──────────────────────────────────
         **别用 HTTP 200 判断瓦片正常**：Carto 无 key 会回 200 + 整幅水印图（实测踩过），
         MapTiler 回 403 + 一张写 "Invalid key" 的 PNG，Thunderforest 回纯文本。
         这里取一张已知瓦片验一次；判**不可用**就这一轮**不挂底图**（只剩背景色 + 我们的数据层），
         并把原因写进 `info.journal` —— 诚实降级，绝不把错误图当底图铺在屏幕上。 */
      let baseOk = true;
      /* ⚠️ `GeoTheme` 里没有 `dark` 字段（tsc 抓到我写错：`themeNow().dark` 恒为 undefined ⇒ 暗色主题会用亮色底图）。
         与 `styleFor` 用同一判据：从海色反推。 */
      const darkNow = themeNow().sea === THEME_DARK.sea;
      try {
        const risk = basemapRiskOf(basemapTiles(darkNow)[0]!);
        if (risk.risky) {
          baseOk = false;
          info.value.journal.push(`basemap: 静态清单判定有风险 —— ${risk.note}`);
        }
        const v = await probeBasemapTile(basemapTiles(darkNow)[0]!);
        /* 🔴 只有**确定性**失败才禁用底图：超时/网络错**不是结论**（实测 3.71s 的瓦片被 3.5s 超时误杀过），
           这时保持启用 —— 真挂了地图自己会报错，而误杀会让用户白看一片空白。 */
        baseOk = baseOk && (v.ok || !v.definitive);
        const tag = v.ok ? "预检通过" : v.definitive ? "预检失败（已禁用底图）" : "预检无结论（保持启用）";
        info.value.journal.push(`basemap: ${tag}（${v.reason}）`);
        if (v.definitive && !v.ok) info.value.errors.push(`basemap: ${v.reason}`);
      } catch (e) {
        /* 预检本身炸了**不该拦住地图**（也保持启用），把原因留痕即可 */
        baseOk = true;
        info.value.journal.push(`basemap: 预检异常 —— ${String((e as Error)?.message || e).slice(0, 60)}`);
      }

      /* 🔴🔴 2026-09-21 机主截图定案的真根因：**画布 buffer 停在 MapLibre 默认的 300×150、alpha=0**
         （布局却是 1253×429 @dpr3）—— 建图那一刻容器**还没有布局尺寸**（0×0），
         而这里原来只在 `ResizeObserver(host)` 里 `resize()`：host 的尺寸**本来就没变** ⇒ 一次都不触发
         ⇒ 画布永远 300×150 ⇒ CSS 拉满整屏 = **一块纯色**。机主看到的"像图片/落后"就是这个。
         ⇒ 两件事：① **等容器真有尺寸**再建图（有上限，量不到也照建，不卡死）；
                   ② 建图后**主动补 resize**（延迟几次，覆盖"加载态收起 / 方向切换 / 分屏"）。 */
      await waitForBox(el);
      const m = new mod.Map({
        container: el,
        /* 🎨 对齐清单 B（区县级换源，机主选 A）：外观吃 `wsMapTheme.themeStyleParts`（与小区级同一份真源），
           数据层仍是舞台自己的（交互载体，不许动）。拿不到主题 ⇒ `styleForStage` 内部回退 `styleFor`。 */
        style: styleForStage(themeNow(), {
          basemap: baseOk,
          themeId: (typeof localStorage !== "undefined" ? (localStorage.getItem("wsm:v1:mapTheme") as "anime" | "night" | null) : null) || "anime",
          low: false,
          parts: stageThemeParts(),
        }),
        // 初始相机只是占位：真正的 center/zoom 由第一批要素的 bbox 用 fitBounds 决定
        center: [104, 35],
        zoom: 3.2,
        attributionControl: false,
        // 🔴 无头截图必须（坑③）
        preserveDrawingBuffer: true,
        dragRotate: true,
        pitchWithRotate: true,
        touchZoomRotate: true,
        fadeDuration: 120,
        minZoom: ML_MIN_ZOOM,
        maxZoom: ML_MAX_ZOOM,
      });
      map = m;
      engineCtor = mod.Marker;

      m.on("error", (e: never) => {
        const ev = e as unknown as { error?: { message?: string } };
        const s = String(ev?.error?.message || ev || "").slice(0, 200);
        if (s) info.value.errors.push(s);
        if (!ok.value && s) err.value = `MapLibre 报错：${s}`;
      });

      const loaded = await waitStyle(m, STYLE_TIMEOUT_MS);
      if (destroyed) return;
      if (!loaded) {
        const hint = info.value.errors.length
          ? `（MapLibre 内部错误：${info.value.errors[0]}）`
          : "（页面通常不会报错——样式校验失败只在引擎内部记录，这就是它最坑的地方）";
        throw new Error(`样式的 ${STYLE_TIMEOUT_MS}ms 内没加载完${hint}`);
      }

      journal("styled");
      ensureLayers();
      /* 等高线：先拉一次；之后相机停了再拉（去抖 900ms，别在拖动过程中反复打 DEM 服务器） */
      void refreshContours();
      m.on("moveend", () => {
        if (contourTimer) window.clearTimeout(contourTimer);
        contourTimer = window.setTimeout(() => {
          contourTimer = 0;
          void refreshContours();
        }, 900);
      });

      m.on("click", onPickEvent as (e: never) => void);
      try {
        m.getCanvas().addEventListener("webglcontextlost", onContextLost);
        m.getCanvas().addEventListener("webglcontextrestored", onContextRestored);
      } catch {
        /* 拿不到 canvas：忽略 */
      }
      /* 建图后**立刻**补一次 + 延迟几次（加载态收起、转屏、分屏都会改尺寸）——
         `map.resize()` 不写这一句，画布就一直是建图那一刻的尺寸（就是机主那张 300×150）。 */
      kickResize();
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => {
          try {
            map?.resize();
          } catch {
            /* 忽略 */
          }
        });
        /* ⚠️ 观察**容器**（`el`）而不是只观察 `host`：容器的尺寸变化才是画布该跟着变的那一刻。
           `host` 也留着（它变尺寸时容器多半也跟着变，两条都收着更稳）。 */
        ro.observe(el);
        ro.observe(host);
      }

      ok.value = true;
      err.value = "";
      show(true);
      addMarkersIfNeeded();
      applyHighlight(lastHi);
      info.value.loadMs = Math.round(performance.now() - t0);
      await load(pendingAd || o.adcode(), false);
    } catch (e) {
      if (destroyed) return;
      fail(msgOf(e));
    }
  }

  function waitStyle(m: MlMap, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, ms);
      m.once("load", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  function mount(): void {
    if (destroyed) return;
    const host = elOf(o.host);
    if (!host) return;
    if (map || booting) {
      layout();
      return;
    }
    booting = true;
    void boot(host).finally(() => {
      booting = false;
    });
  }

  /** 换一级：取 GeoJSON → setData → fitBounds。失败就把 `ok` 置回 false（页面回退旧路）。 */
  async function load(ad: string, animate = true): Promise<void> {
    const id = String(ad || "").trim();
    if (!id) return;
    const m = map;
    // 引擎还在启动/不健康：记下来，等就绪后补画（`mount()` 之后马上 watch 到 adcode 就是这个时序）
    if (!m || !ok.value) {
      pendingAd = id;
      return;
    }
    // 图层可能在上一次上下文丢失后被清掉 —— 补齐再画（否则会静默地什么都不画）
    if (!ensureLayers()) {
      pendingAd = id;
      return;
    }
    const t = performance.now();
    try {
      let fc = cache.get(id);
      if (!fc) {
        fc = await geoJson(id);
        if (!featureCount(fc)) throw new Error(`${id} 没有要素`);
        cacheSet(id, fc);
      }
      if (destroyed || !map) return;
      map.getSource(ML_SRC)?.setData(fc);
      const b = bboxOf(fc);
      if (b) {
        lastBBox = b;
        const fit = fitOptionsFor(b, o.fitPadding, { animate, flyMs: o.flyMs });
        map.fitBounds(fit.bounds, { padding: fit.padding, duration: fit.duration, maxZoom: fit.maxZoom });
      }
      // `feats` 与 Canvas2D 版**同类型**（面板/头像定位都吃它）——
      // 注意：MapLibre 渲染**不用**它（source 直接吃原始 FeatureCollection），这里只是接口对齐
      feats.value = parseFeatures(fc);
      info.value.feats = feats.value.length;
      info.value.dataMs = Math.round(performance.now() - t);
      journal("data:" + id + ":" + feats.value.length);
      refreshMarkers(feats.value.length);
      err.value = "";
    } catch (e) {
      err.value = msgOf(e);
      // ⚠️ 与 Canvas2D 版同一条规则：只在**第一次**就失败时才回退
      //    （画到一半失败不该把已经看得见的图撤掉）
      if (!feats.value.length) {
        ok.value = false;
        show(false);
      }
    }
  }

  function highlight(ads: string[]): void {
    lastHi = (ads || []).filter(Boolean);
    applyHighlight(lastHi);
  }

  function setDark(dark: boolean): void {
    applyTheme(map, dark ? THEME_DARK : THEME_LIGHT);
  }

  function zoomBy(f: number): void {
    const m = map;
    if (!m) return;
    const z = zoomAfter(m.getZoom(), f);
    m.easeTo({ zoom: z, duration: prefersReducedMotion() ? 0 : 320 });
  }

  function reset(ms?: number): void {
    const m = map;
    if (!m || !lastBBox) return;
    const fit = fitOptionsFor(lastBBox, o.fitPadding, { animate: ms !== 0, flyMs: ms });
    m.fitBounds(fit.bounds, { padding: fit.padding, duration: fit.duration, maxZoom: fit.maxZoom });
  }

  function layout(): void {
    try {
      map?.resize();
    } catch {
      /* 忽略 */
    }
  }

  function destroy(): void {
    destroyed = true;
    ok.value = false;
    teardown();
    for (const s of stops.splice(0)) {
      try {
        s();
      } catch {
        /* 忽略 */
      }
    }
  }

  // 换级就重画（`adcode` 是函数，所以手动 watch 它算出来的值）—— 与 Canvas2D 版逐字同构
  stops.push(
    watch(
      () => o.adcode(),
      (ad) => void load(ad),
      { immediate: true }
    )
  );
  /* ⚠️ 画布/容器**不是**在 setup 那一刻就存在的：舞台上 `v-else-if` 分支会随 `step` 变
     （先「定位中」、再地图）—— 所以不能只在 `onMounted` 里建一次。这里盯着两个 ref，
     谁先到齐就在谁之后建（已建过就只做一次 layout）。 */
  stops.push(
    watch(
      [() => elOf(o.host), () => elOf(o.canvas)],
      ([h]) => {
        if (h && !map && !booting) mount();
        else layout();
      },
      { immediate: true, flush: "post" }
    )
  );
  stops.push(
    watch(
      () => o.dark(),
      (d) => setDark(d)
    )
  );

  // 组件里用 → 卸载自动销毁；**非组件环境**（验证页）不装这个钩子，由调用方自己 destroy()
  if (getCurrentInstance()) onBeforeUnmount(destroy);

  return {
    ok,
    err,
    feats,
    /** 诊断指标（与 Canvas2D 版的接口对齐**不受影响**：这是额外字段） */
    info,
    mount,
    load,
    highlight,
    setDark,
    zoomBy,
    reset,
    layout,
    destroy,
    get map(): MlMap | null {
      return map;
    },
    /** 供验证页判断"引擎是否已接管" */
    get container(): HTMLElement | null {
      return container;
    },
  };
}
