/**
 * wsScene.ts —— 「**场景装配**」的**唯一真源**（2026-09-22，主会话要求：相机与图层装配不许有两份）。
 *
 * ## 为什么单独一个模块
 * 到这一步为止，"外观"已经统一了（`wsMapStyle` + `wsMapTheme`），但**相机默认值与图层装配**
 * 仍是两份：代拍页 `ws3dshow.html` 自己写 `zoom/pitch/bearing/maxPitch` 与 `before="bld-ext"`，
 * App 的小区级组件也各写一份 ⇒ 两边"看着像同一个东西"却会慢慢漂。
 * ⇒ 这里把三样抽出来（**只有数据与纯函数，不碰 DOM**）：
 *   ① `CAMERA_DEFAULTS` / `cameraDefaults()`：相机默认值与边界（含 `maxPitch: 70` —— 侧视角倍率爆炸的护栏）；
 *   ② `SCENE_LAYER_ORDER` / `sceneLayerPlan()`：图层**顺序与 before 关系**（路网 → 楼体 → 设施 → 注记）；
 *   ③ `sceneSelfReport()`：**自证**（面板/自检那一行读它 —— 换用没有生效，页面上一眼可见）。
 *
 * ⚠️ 纪律：**只有一份**。页面/组件**不许**再写 `pitch: 38` 这类字面量；
 *   要改默认相机，改这里的 `CAMERA_DEFAULTS`，两边一起变。
 */

/** 自证标记：谁产出了这份场景装配（面板读它） */
export const WS_SCENE_SOURCE = "wsScene.ts";

/** 相机默认值与边界（**唯一真源**；代拍页与 App 都从这里取） */
export interface SceneCamera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  minZoom: number;
  maxZoom: number;
  /** 🔴 70：能给天空，但到不了"只剩一条线"（侧视角拖动倍率爆炸的护栏） */
  maxPitch: number;
}

export const CAMERA_DEFAULTS: Readonly<SceneCamera> = {
  center: [116.2, 39.9], // 占位中心：真位置由定位/数据 bbox 决定
  zoom: 16.4, // 街区级（能看见楼体体量）
  pitch: 38, // 抬头能看见天空，又不至于把地面压扁
  bearing: -18, // 轻微斜角，楼有立体感
  minZoom: 3,
  maxZoom: 19,
  maxPitch: 70,
};

/** 取一份**可改的**相机默认值（调用方常要覆盖 center） */
export function cameraDefaults(): SceneCamera {
  return { ...CAMERA_DEFAULTS };
}

/** 图层**顺序**（自下而上；`group` 只是给人和自检看的名字） */
export interface SceneLayerPlanEntry {
  group: "roads" | "transport" | "buildings" | "prerender" | "labels";
  /** 该组里图层的 id 前缀（用于自检断言"实际图层属于哪一组"） */
  idPrefixes: readonly string[];
  /** 插到哪个图层**之前**（`null` = 追加到最上） */
  beforeId: string | null;
  why: string;
}

export const SCENE_LAYER_ORDER: readonly SceneLayerPlanEntry[] = [
  { group: "roads", idPrefixes: ["road-casing-", "road-line-"], beforeId: "bld-ext", why: "路是地面上的东西，压在楼上会像从楼顶穿过" },
  { group: "transport", idPrefixes: ["tf-"], beforeId: "bld-ext", why: "交通设施**贴在路之上**（先插路网、后插设施 ⇒ 设施在上）" },
  { group: "buildings", idPrefixes: ["bld-"], beforeId: null, why: "楼体在最上（数据层，交互载体）" },
  /* 🛰 LOD 第 1 步（2026-09-24）：预渲染瓦片层。**它在矢量层之上**是刻意的 ——
     远景（z≤12）要让瓦片**盖住**实时层，中间靠 `raster-opacity` 随 zoom 淡到 0 把画面交还矢量层；
     反过来放（瓦片在下）就得给 12 条路网 + 楼体各写一份"淡入"，那才是新造一套机制。
     ⚠️ 这条"在上"由 `sceneOrderViolations()` 守着（被矢量层压住 = 远景会露出实时层）。 */
  { group: "prerender", idPrefixes: ["prerender"], beforeId: "ref", why: "预渲染瓦片 = 远景替身，压在矢量层之上、注记之下（靠 zoom 淡出把近景交还实时层）" },
];

/** 一份**可读的**层序计划（面板/自检显示它 ⇒ "同一份装配"可核对） */
export function sceneLayerPlan(): SceneLayerPlanEntry[] {
  return SCENE_LAYER_ORDER.map((e) => ({ ...e }));
}

/** 按 id 判断某个图层属于计划里的哪一组（`null` = 不在计划内，如底图/色罩/天空） */
export function sceneGroupOf(layerId: string): SceneLayerPlanEntry["group"] | null {
  const id = String(layerId || "");
  for (const e of SCENE_LAYER_ORDER) if (e.idPrefixes.some((p) => id.startsWith(p))) return e.group;
  return null;
}

/**
 * **自证**：这份场景装配来自哪一份实现？
 * @param consumed true = 调用方确实用了本模块（相机取自 `cameraDefaults()` 且层序取自 `sceneLayerPlan()`）
 */
export function sceneSelfReport(consumed: boolean): { source: string; ok: boolean; detail: string } {
  return consumed
    ? { source: WS_SCENE_SOURCE, ok: true, detail: `场景装配真源 = \`${WS_SCENE_SOURCE}\`（相机 + 层序都取自它）` }
    : {
        source: "（页面自带）",
        ok: false,
        detail: "**这一处还没换源**：相机/层序仍是页面里各写一份 —— 换用 `wsScene.ts` 后这行会变 ✅",
      };
}

/** 图层顺序是否**符合计划**（纯函数：拿实际图层 id 列表断言，页面与自检都用它） */
export function sceneOrderViolations(layerIds: readonly string[]): string[] {
  const out: string[] = [];
  const idx = (id: string): number => layerIds.indexOf(id);
  const firstOf = (g: SceneLayerPlanEntry["group"]): number => {
    const e = SCENE_LAYER_ORDER.find((x) => x.group === g)!;
    const positions = layerIds
      .map((id, i) => (e.idPrefixes.some((p) => id.startsWith(p)) ? i : -1))
      .filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : -1;
  };
  const roads = firstOf("roads");
  const tf = firstOf("transport");
  const bld = firstOf("buildings");
  const pre = firstOf("prerender");
  if (roads >= 0 && tf >= 0 && roads > tf) out.push("路网被交通设施压在上面（应在下方）");
  if (roads >= 0 && bld >= 0 && roads > bld) out.push("路网被楼体压在上面（应在下方）");
  if (tf >= 0 && bld >= 0 && tf > bld) out.push("交通设施被楼体压在上面（应在下方）");
  /* 🛰 只在**预渲染层真的在**时才判这条 —— 没开 `?lod` 的页面/App 里它压根不存在，
     这时报"违规"就是假报（三态纪律：不要把"没有这一层"说成"顺序错了"）。 */
  if (pre >= 0) {
    if (roads >= 0 && pre < roads) out.push("预渲染瓦片被路网压住（远景会露出实时路网）");
    if (tf >= 0 && pre < tf) out.push("预渲染瓦片被交通设施压住（远景会露出实时设施）");
    if (bld >= 0 && pre < bld) out.push("预渲染瓦片被楼体压住（远景会露出实时楼体）");
  }
  void idx;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
   🛰 **LOD：近处实时渲染 / 远处预渲染** —— 第 1 步「切换骨架」的唯一真源
   （机主 2026-09-24 原话：「采用**近距离渲染，远距离预渲染**的方式加载全国楼房数据和道路喵！」）

   这一步**不依赖大数据**：瓦片由 `world_map/make_prerender_tiles.mjs` 在本地生成
   （骨架阶段是**示意**瓦片，只为证明"切换 / 过渡 / 回证"成立；真数据管线是第 2 步）。

   🔴 **复用**既有那套机制，不新造：`wsMapTheme.themeStyleParts()` 里照片底图就是靠
     `raster-opacity: ["interpolate",["linear"],["zoom"], z0, 1, z1, 0]` 淡出的
     （`theme.baseFade`）。这里**同一个形状**，只是换成预渲染层。
   🔴 **阈值/层 id/表达式/瓦片键算法只有这一份**：页面与（将来的）App 都从这里取，
     两边各写一份就一定会漂 —— 这是这个项目反复付代价的那类问题。
   🔴 图层顺序：预渲染层在**矢量层之上、注记之下**（见 `SCENE_LAYER_ORDER` 的那条）。
   ══════════════════════════════════════════════════════════════════════════════ */

/** 预渲染层/源/资源路径（**我们自己的瓦片**，不是 Esri） */
export const PRERENDER_LAYER_ID = "prerender";
export const PRERENDER_SOURCE_ID = "prerender";
export const PRERENDER_TILE_PATH = "/prerender/{z}/{x}/{y}.png";
export const PRERENDER_MANIFEST_PATH = "/prerender/manifest.json";
/** 瓦片像素尺寸（与生成脚本一致；设计文档定 512） */
export const PRERENDER_TILE_SIZE = 512;
/** 瓦片金字塔的 zoom 上限（源级 `maxzoom`：更高的 zoom 由地图库放大复用 z13 那张） */
export const PRERENDER_TILE_MAXZOOM = 13;
/** `z ≤ FAR` = 预渲染瓦片独占；`z ≥ NEAR` = 实时矢量独占；中间按 zoom 线性交叉过渡 */
export const LOD_FAR_ZOOM = 12;
export const LOD_NEAR_ZOOM = 14;
/** 瓦片署名（**自产**，如实写清不是真实数据 —— 骨架阶段它是示意瓦片） */
export const PRERENDER_ATTRIBUTION = "预渲染瓦片（自产；骨架阶段为示意瓦片，非真实楼/路数据）";
/** 视野内瓦片键的硬上限（防"缩到 z3 时把整个世界铺满"那种意外；超了如实标 `capped`） */
export const LOD_VIEW_TILE_CAP = 2048;

export type LodTier = "prerender" | "crossfade" | "vector";

/** 当前 zoom 走哪条路（三态：预渲染 / 过渡中 / 实时矢量） */
export function lodTierOf(zoom: number): LodTier {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_FAR_ZOOM;
  if (z <= LOD_FAR_ZOOM) return "prerender";
  if (z >= LOD_NEAR_ZOOM) return "vector";
  return "crossfade";
}

export function lodTierLabel(tier: LodTier): string {
  if (tier === "prerender") return `预渲染（z≤${LOD_FAR_ZOOM}）`;
  if (tier === "vector") return `实时矢量（z≥${LOD_NEAR_ZOOM}）`;
  return `过渡中（${LOD_FAR_ZOOM}~${LOD_NEAR_ZOOM}）`;
}

/** 预渲染层在某个 zoom 下的不透明度（纯函数 ⇒ 自检不必建地图、更不必有 WebGL） */
export function lodOpacityAt(zoom: number): number {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_FAR_ZOOM;
  if (z <= LOD_FAR_ZOOM) return 1;
  if (z >= LOD_NEAR_ZOOM) return 0;
  return +((LOD_NEAR_ZOOM - z) / (LOD_NEAR_ZOOM - LOD_FAR_ZOOM)).toFixed(4);
}

/**
 * 写进 `raster-opacity` 的表达式 —— **与 `baseFade` 逐字同形**（这就是"复用同一机制"的字面含义）。
 * 自检里有一条断言它和 `wsMapTheme` 生成的 `base` 淡出表达式**形状一致**（防有人另造一套）。
 */
export function lodOpacityExpression(): unknown[] {
  return ["interpolate", ["linear"], ["zoom"], LOD_FAR_ZOOM, 1, LOD_NEAR_ZOOM, 0];
}

/** 预渲染层的栅格源（**我们自己的瓦片路径**；`maxzoom` = 金字塔上限，更高的 zoom 放大复用） */
export function lodSourceSpec(): Record<string, unknown> {
  return {
    type: "raster",
    tiles: [PRERENDER_TILE_PATH],
    tileSize: PRERENDER_TILE_SIZE,
    maxzoom: PRERENDER_TILE_MAXZOOM,
    attribution: PRERENDER_ATTRIBUTION,
  };
}

/** 预渲染**图层**：只有一条 paint（不透明度随 zoom），颜色在瓦片里、由主题决定 */
export function lodLayerSpec(): Record<string, unknown> {
  return {
    id: PRERENDER_LAYER_ID,
    type: "raster",
    source: PRERENDER_SOURCE_ID,
    /* z ≥ NEAR 整层隐藏（不透明度那时也正好是 0）⇒ 近景**不再请求瓦片**，也不参与绘制 */
    maxzoom: LOD_NEAR_ZOOM,
    paint: { "raster-opacity": lodOpacityExpression() },
  };
}

/** 计划（页面/App 照它建层；`beforeId` 取自 `SCENE_LAYER_ORDER`，不在这里手写锚点） */
export function lodPlan(): {
  group: "prerender";
  layerId: string;
  sourceId: string;
  beforeId: string | null;
  tilePath: string;
  manifestPath: string;
  tileSize: number;
  tileMaxzoom: number;
  layerMaxzoom: number;
  far: number;
  near: number;
  source: Record<string, unknown>;
  layer: Record<string, unknown>;
} {
  const entry = SCENE_LAYER_ORDER.find((e) => e.group === "prerender");
  return {
    group: "prerender",
    layerId: PRERENDER_LAYER_ID,
    sourceId: PRERENDER_SOURCE_ID,
    beforeId: entry ? entry.beforeId : null,
    tilePath: PRERENDER_TILE_PATH,
    manifestPath: PRERENDER_MANIFEST_PATH,
    tileSize: PRERENDER_TILE_SIZE,
    tileMaxzoom: PRERENDER_TILE_MAXZOOM,
    layerMaxzoom: LOD_NEAR_ZOOM,
    far: LOD_FAR_ZOOM,
    near: LOD_NEAR_ZOOM,
    source: lodSourceSpec(),
    layer: lodLayerSpec(),
  };
}

/* ── 瓦片键（slippy map 的标准算法；**只这一份**） ───────────────────────────── */

export function lodTileKey(z: number, x: number, y: number): string {
  return `${Math.round(z)}/${Math.round(x)}/${Math.round(y)}`;
}

/** 经纬度 → 瓦片 x（标准 Web Mercator） */
export function lodTileX(lng: number, z: number): number {
  return Math.floor(((Number(lng) + 180) / 360) * Math.pow(2, z));
}

/** 纬度 → 瓦片 y（标准 Web Mercator；纬度先夹到 ±85.0511，免得 `tan` 炸） */
export function lodTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const r = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}

/** 只要 `getWest/getEast/getNorth/getSouth` 四个方法（真 `LngLatBounds` 与自检的假边界都满足） */
export interface LodBoundsLike {
  getWest(): number;
  getEast(): number;
  getNorth(): number;
  getSouth(): number;
}

/**
 * 当前视野需要哪些瓦片（**数出来是几就是几**；超上限时如实标 `capped`，不假装数全了）。
 * `zoom` 会被夹到 `maxzoom`（源的上限 ⇒ 再放大也是复用那一层瓦片）。
 */
export function lodViewTiles(
  bounds: LodBoundsLike | null | undefined,
  zoom: number,
  maxzoom: number = PRERENDER_TILE_MAXZOOM
): { z: number; keys: string[]; capped: boolean } | null {
  if (!bounds || typeof bounds.getWest !== "function") return null;
  const z = Math.max(0, Math.min(Math.round(Number.isFinite(zoom) ? zoom : 0), Math.round(maxzoom)));
  const n = Math.pow(2, z);
  const w = Number(bounds.getWest());
  const e = Number(bounds.getEast());
  const s = Number(bounds.getSouth());
  const nn = Number(bounds.getNorth());
  if (![w, e, s, nn].every((v) => Number.isFinite(v))) return null;
  const clampX = (x: number): number => Math.max(0, Math.min(n - 1, x));
  const x0 = clampX(lodTileX(w, z));
  const x1 = clampX(lodTileX(e, z));
  const y0 = clampX(lodTileY(nn, z));
  const y1 = clampX(lodTileY(s, z));
  /* 跨 180° 的情况：`e < w` ⇒ x 折返（全国尺度用不到，但别在这里悄悄算错） */
  const wrap = e < w;
  const xRanges: Array<[number, number]> = wrap ? [[x0, n - 1], [0, x1]] : [[Math.min(x0, x1), Math.max(x0, x1)]];
  const yLo = Math.min(y0, y1);
  const yHi = Math.max(y0, y1);
  const capacity = xRanges.reduce((acc, [a, b]) => acc + (b - a + 1), 0) * (yHi - yLo + 1);
  const keys: string[] = [];
  let capped = capacity > LOD_VIEW_TILE_CAP;
  for (const [xa, xb] of xRanges) {
    for (let x = xa; x <= xb; x++) {
      for (let y = yLo; y <= yHi; y++) {
        if (keys.length >= LOD_VIEW_TILE_CAP) {
          capped = true;
          break;
        }
        keys.push(lodTileKey(z, x, y));
      }
      if (keys.length >= LOD_VIEW_TILE_CAP) break;
    }
    if (keys.length >= LOD_VIEW_TILE_CAP) break;
  }
  return { z, keys, capped };
}

/* ── 判词（三态纪律：正数 / `0（已量）` / `数不出来` —— **绝不裸写 0**） ───────── */

export interface LodTileVerdict {
  state: "off" | "ok" | "missing" | "unknown";
  /** **已载入**的瓦片数；`null` = 数不出来（取不到坐标/状态） */
  hit: number | null;
  /** 命中数的**口径**（`cache` = 瓦片状态（最硬）；`events` = 事件计数；`unknown` = 没拿到） */
  hitGauge: "cache" | "events" | "unknown";
  /** **加载失败**的瓦片数；`null` = 数不出来 */
  fail: number | null;
  /** 失败数的口径（同上）。⚠️ 这个构建里 **404 不抛 error 事件**（读 vendored 源码确认）⇒ 真缺图看 `absent` */
  failGauge: "cache" | "events" | "unknown";
  /** 当前视野**应有**多少张（按 zoom 夹到瓦片层算）；`null` = 数不出来（拿不到视野/zoom） */
  view: number | null;
  /** 视野内、清单里**有**的；`null` = 清单没取到（⇒ 数不出来，**不是 0**） */
  inInventory: number | null;
  /** 视野内、清单里**没有**的 ⇒ 必然会取不到（**确定性证据，不依赖事件**：真缺图看它） */
  absent: number | null;
  /** 视野键是否被上限截断（截了就不能说"共 N 张"） */
  capped: boolean;
  why: string;
}

/** 瓦片状态计数（页面从地图内部只读诊断里读出来；拿不到就是 `null`） */
export interface LodTileStates {
  loaded: number;
  errored: number;
  loading: number;
  total: number;
}

/**
 * 瓦片命中/缺图的三态判据（纯函数）。
 *
 * 为什么**不能**直接报"命中 0"：`sourcedata` 事件在瓦片没加载完时一条都不来
 * ——那和"这张图不存在"是两件事（`AUDIT-STINK.md` 的判词纪律就是这么来的：
 * 当年把"数不出来"写成了"路网没画上"，机主屏幕上路明明在）。
 *
 * 证据优先级：**瓦片状态**（`states`，最硬）→ **事件计数**（`loaded`/`failed` 键表）→ `数不出来`。
 */
export function lodTileVerdict(input: {
  enabled: boolean;
  view: { z: number; keys: string[]; capped: boolean } | null;
  /** 清单里的瓦片键（`null` = 清单没取到 ⇒ 数不出来）。数组或 Set 都认 */
  inventory: string[] | Set<string> | null;
  /** 事件里数到的已载入键（`null` = 事件没给可用坐标） */
  loaded: string[] | null;
  /** 事件里数到的失败键（`null` = 同上） */
  failed: string[] | null;
  /** 地图内部的瓦片状态计数（只读诊断；给了就优先用它 —— 比事件可靠） */
  states?: LodTileStates | null;
}): LodTileVerdict {
  const empty = {
    hit: null,
    hitGauge: "unknown" as const,
    fail: null,
    failGauge: "unknown" as const,
    view: null,
    inInventory: null,
    absent: null,
    capped: false,
  };
  if (!input.enabled) {
    return { state: "off", ...empty, why: "未启用（URL 加 `?lod=1` 才建预渲染层）" };
  }
  const inv = input.inventory === null ? null : input.inventory instanceof Set ? input.inventory : new Set(input.inventory);
  const view = input.view;
  if (!view) {
    return { state: "unknown", ...empty, why: "数不出来：拿不到视野/zoom（地图还没就绪）" };
  }
  const keys = view.keys;
  const inInv = inv === null ? null : keys.filter((k) => inv.has(k)).length;
  const absent = inInv === null ? null : keys.length - inInv;
  const st = input.states || null;
  const hit = st ? st.loaded : input.loaded === null ? null : input.loaded.length;
  const hitGauge: LodTileVerdict["hitGauge"] = st ? "cache" : input.loaded === null ? "unknown" : "events";
  const fail = st ? st.errored : input.failed === null ? null : input.failed.length;
  const failGauge: LodTileVerdict["failGauge"] = st ? "cache" : input.failed === null ? "unknown" : "events";
  const why: string[] = [];
  if (inv === null) why.push("清单没取到 ⇒ 「本区应有/清单缺」数不出来");
  if (hit === null) why.push("拿不到瓦片状态、事件里也没有 tile 坐标 ⇒ 命中数不出来");
  if (absent !== null && absent > 0) why.push(`视野里有 ${absent} 张**清单里没有** ⇒ 它们必然取不到（这是确定性证据，不依赖事件）`);
  if (view.capped) why.push(`视野瓦片数超过上限 ${LOD_VIEW_TILE_CAP} ⇒ 只数了一部分（不能说"共 N 张"）`);
  if (keys.length === 0) why.push("视野里一张都算不出来（边界异常？）");
  const state: LodTileVerdict["state"] =
    absent !== null && absent > 0
      ? "missing" /* 视野里有清单上没有的键 ⇒ 那些**必然**取不到：确定结论，不受事件影响 */
      : hit === null || inv === null || keys.length === 0
        ? "unknown"
        : "ok";
  return {
    state,
    hit,
    hitGauge,
    fail,
    failGauge,
    inInventory: inInv,
    absent,
    capped: view.capped,
    view: view.capped ? null : keys.length,
    why: why.length ? why.join("；") : "视野瓦片与清单一致（口径：清单 = 生成脚本写出的键）",
  };
}

/** MapLibre 瓦片事件里可能出现的坐标形状（**只读**：`coord` / `tile.tileID`，都带 `canonical`） */
interface LodTileIdLike {
  z?: unknown;
  x?: unknown;
  y?: unknown;
  canonical?: LodTileIdLike;
}
interface LodTileEventLike {
  coord?: LodTileIdLike | null;
  tileID?: LodTileIdLike | null;
  tile?: { tileID?: LodTileIdLike | null } | null;
}

/**
 * 从地图的 `sourcedata` / `error` 事件里抠出**瓦片键** `z/x/y`。
 *
 * 为什么要有它、而不是页面里写个 `e.tile.tileID.z`：
 * ① 形状不止一种 —— 读 vendored 源码确认，瓦片加载完成时源里 fire 的是
 *    `new MapSourceDataEvent("data", {tile, coord: tile.tileID})`（**没有 `sourceDataType:"tile"`**，
 *    构建里根本没有那个字符串；`sourceId` 是 TileManager 作为事件父级合并进来的）；
 * ② **抠不到就必须返回 null** ⇒ 调用方把命中数判成"数不出来"，**绝不写 0**
 *    （把"我没拿到坐标"写成"命中 0 张"正是判词纪律要防的那种误报）。
 */
export function lodEventTileKey(e: unknown): string | null {
  const ev = (e || {}) as LodTileEventLike;
  const cands: Array<LodTileIdLike | null | undefined> = [ev.coord, ev.tile && ev.tile.tileID, ev.tileID];
  for (const c of cands) {
    if (!c) continue;
    const can = c.canonical || c;
    const z = Number(can.z);
    const x = Number(can.x);
    const y = Number(can.y);
    if (Number.isFinite(z) && Number.isFinite(x) && Number.isFinite(y)) return lodTileKey(z, x, y);
  }
  return null;
}

/** 一张瓦片清单（`/prerender/manifest.json`）的形状 —— 生成脚本写、页面读 */
export interface PrerenderManifest {
  generatedBy: string;
  themeId: string;
  themeFingerprint: string;
  palette: Record<string, unknown>;
  tileSize: number;
  zoomRange: [number, number];
  tileCount: number;
  tiles: Record<string, number>;
}

export interface LodLiveVerdict {
  state: "missing" | "unknown" | "ok";
  n: number | null;
  gauge: "rendered" | "source" | "unknown";
  why: string;
}

/**
 * 「实时层要素数」的三态判据 —— 与 `wsLayerOrder.roadCountVerdict()` **同一条规则**
 * （`queryRenderedFeatures` → `querySourceFeatures` → `数不出来`）。
 * 这里不 import 它，是为了让 `wsScene` 保持零依赖（页面引的是打包产物）；
 * 自检里有一条**对拍**：同一组输入两边必须给同样的判定（防两套规则漂）。
 */
export function lodLiveVerdict(input: {
  layerCount: number;
  rendered: number | null;
  source: number | null;
  tilesLoaded?: boolean | null;
}): LodLiveVerdict {
  if (input.layerCount === 0) {
    return { state: "missing", n: 0, gauge: "unknown", why: "实时矢量层 0 个 ⇒ **确实没有**（不是数不出来）" };
  }
  if (typeof input.rendered === "number" && input.rendered > 0) {
    return { state: "ok", n: input.rendered, gauge: "rendered", why: "屏幕可见要素（queryRenderedFeatures）" };
  }
  if (typeof input.source === "number" && input.source > 0) {
    return { state: "ok", n: input.source, gauge: "source", why: "数据源要素（querySourceFeatures）" };
  }
  const tileTxt =
    input.tilesLoaded === true ? "瓦片已加载" : input.tilesLoaded === false ? "**瓦片还没加载完**" : "瓦片状态未知";
  return {
    state: "unknown",
    n: null,
    gauge: "unknown",
    why:
      `图层都在（${input.layerCount} 个）但两种口径都数不出要素（rendered=${String(input.rendered)}、` +
      `source=${String(input.source)}，${tileTxt}）⇒ **数不出来**，不代表没有`,
  };
}

/** 数字 → HUD 文案：`null` 一律写「数不出来」，**绝不写成 0** */
export function lodNum(n: number | null, measuredZero = "0（已量）"): string {
  if (n === null || n === undefined) return "数不出来";
  if (n === 0) return measuredZero;
  return String(n);
}

/** HUD 那一行（页面只调它 ⇒ 文案口径也只有一份） */
export function lodHudLine(input: {
  enabled: boolean;
  zoom: number;
  tiles: LodTileVerdict;
  live: LodLiveVerdict | null;
}): string {
  if (!input.enabled) return "🛰 LOD 未启用（URL 加 `?lod=1`；当前未建预渲染层）";
  const t = lodTierOf(input.zoom);
  const v = input.tiles;
  const tileTxt =
    `瓦片 命中 ${lodNum(v.hit)}（口径=${v.hitGauge}） · 失败 ${lodNum(v.fail)}（口径=${v.failGauge}）` +
    ` · 清单缺 ${lodNum(v.absent)} · 本区应有 ${lodNum(v.view)}` +
    (v.capped ? " ⚠️被上限截断" : "");
  const liveTxt = input.live
    ? `实时层 ${input.live.state === "missing" ? "0（已量：图层没建）" : lodNum(input.live.n)} 要素`
    : "实时层 数不出来（还没查）";
  return `🛰 LOD[${lodTierLabel(t)} 不透明度 ${lodOpacityAt(input.zoom).toFixed(2)}] ${tileTxt} · ${liveTxt}`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   🎬 侧视角（近地平线）**倍率爆炸**的护栏 —— 机主 2026-09-21：「一下划不见」。

   根因：pitch 越大，地面与视线越接近平行 ⇒ **同样的手指位移对应巨大的地面距离**。
   做法（与代拍页 `ws3dshow.html` 里那套**同一套数值**；这里是唯一真源，App 侧照它接线）：
     ① `maxPitch` 85 → 70（见上面的 `CAMERA_DEFAULTS`：能给天空，但到不了"只剩一条线"）；
     ② pitch > 55° 之后**按比例降拖动/滚轮速度**（MapLibre 的公开口子）；
     ③ 系数可被读出（HUD 自证：能看出护栏在不在工作）。
   ⚠️ 触屏"捏合缩放"**没有** rate 口子（`touchZoomRotate` 不暴露）⇒ 那一项**没做**，如实记。
   ⚠️ **为什么可以每次 pitch 变化都重设**（读过 vendored maplibre 源码才敢写）：
     `dragPan.enable(o)` 是 `this._inertiaOptions = o || {}`（**无条件重写、没有"已启用就早退"**），
     而惯性在**手势结束时**才读：`this._inertia._onMoveEnd(this._map.dragPan._inertiaOptions)`；
     `scrollZoom.setWheelZoomRate(e)` 也只是 `this._wheelZoomRate = e`（滚轮时读）。
     ⇒ 重设**真的会生效**，不是空操作。
   ⚠️ 本函数**幂等且容错**：地图半初始化 / 没挂这些句柄 / 抛错 ⇒ 只是这次护栏不生效，**绝不影响地图**。
   ══════════════════════════════════════════════════════════════════════════════ */
export const PITCH_SOFT = 55;
/** 未阻尼时的拖动惯性上限（MapLibre `dragPan` 的 `maxSpeed`，px/s 量级） */
export const PAN_MAX_SPEED = 1400;
/** 未阻尼时的滚轮缩放速率（MapLibre `scrollZoom.setWheelZoomRate`） */
export const WHEEL_ZOOM_RATE = 1 / 450;

/** pitch → 阻尼系数。≤55° 恒为 **1**（低角度手感逐字不变）；超过后按 25° 一档缓降，**永不为 0/负** */
export function panDamping(pitch: number): number {
  const p = Number.isFinite(pitch) ? pitch : 0;
  return p <= PITCH_SOFT ? 1 : 1 / (1 + (p - PITCH_SOFT) / 25);
}

/** 阻尼后**真正写进地图**的两个值（纯值 ⇒ 自检能直接断言，不必建地图、更不必有 WebGL） */
export function pitchGuardParams(pitch: number): { damping: number; maxSpeed: number; wheelZoomRate: number } {
  const damping = panDamping(pitch);
  return { damping, maxSpeed: Math.round(PAN_MAX_SPEED * damping), wheelZoomRate: WHEEL_ZOOM_RATE * damping };
}

/** 只要求"有那几个口子"，**不 import maplibre 类型** —— 页面能用、自检里能塞假地图 */
export interface PitchGuardMap {
  getPitch?: () => number;
  dragPan?: { enable?: (opts: { maxSpeed: number }) => void };
  scrollZoom?: { setWheelZoomRate?: (rate: number) => void };
}

/** 把护栏应用到真地图（或自检里的假地图）。返回本次的阻尼系数；失败返回 1（= 不阻尼） */
export function applyPitchGuard(map: PitchGuardMap | null | undefined): number {
  try {
    const p = map && typeof map.getPitch === "function" ? map.getPitch() : 0;
    const { damping, maxSpeed, wheelZoomRate } = pitchGuardParams(p);
    if (map && map.dragPan && typeof map.dragPan.enable === "function") map.dragPan.enable({ maxSpeed });
    if (map && map.scrollZoom && typeof map.scrollZoom.setWheelZoomRate === "function") map.scrollZoom.setWheelZoomRate(wheelZoomRate);
    return damping;
  } catch {
    return 1; // 护栏失败**不影响地图**
  }
}
