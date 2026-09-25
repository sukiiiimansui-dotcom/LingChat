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
/**
 * 🔴 **真瓦片**（默认）：由 `world_map/prerender_pipeline.py` 用**真楼脚印（Overture，ODbL）+ OSM 道路**画的那批。
 * 机主 2026-09-25 拍板：「**占位瓦片默认不画**」+「取数半径跟随视野放大」。
 */
export const PRERENDER_TILE_PATH = "/prerender/{z}/{x}/{y}.png";
export const PRERENDER_MANIFEST_PATH = "/prerender/manifest.json";
/**
 * **示意/占位瓦片**（骨架阶段的假几何花纹）：机主在真机上看到「瓦片太难看了（覆盖全部地图）」
 * —— 占位瓦片铺满整张图、而真数据只覆盖一小片 —— 所以把它挪到**单独目录**：
 *   · 默认（`?lod=1`）**一条都不请求**：真瓦片没覆盖到的地方**就空着**，绝不再拿花纹去补；
 *   · 只有显式 `?lod=demo` 才用它（对照 A/B、自检、复现第 1 步的过渡观感）。
 * 两者**必须分目录**：混在一起时 HUD 分不出"这张是真数据还是花纹"，判词就等于撒谎。
 */
export const PRERENDER_DEMO_TILE_PATH = "/prerender-demo/{z}/{x}/{y}.png";
export const PRERENDER_DEMO_MANIFEST_PATH = "/prerender-demo/manifest.json";
/** 瓦片像素尺寸（与生成脚本一致；设计文档定 512） */
export const PRERENDER_TILE_SIZE = 512;
/** 瓦片金字塔的 zoom 上限（源级 `maxzoom`：更高的 zoom 由地图库放大复用 z13 那张） */
export const PRERENDER_TILE_MAXZOOM = 13;
/** `z ≤ FAR` = 预渲染瓦片独占；`z ≥ NEAR` = 实时矢量独占；中间按 zoom 线性交叉过渡 */
export const LOD_FAR_ZOOM = 12;
export const LOD_NEAR_ZOOM = 14;
/** 瓦片源：`real` = 真数据（默认）、`demo` = 示意/占位（只在 `?lod=demo` 下用） */
export type PrerenderSource = "real" | "demo";
/**
 * 源层署名（写进**样式 spec 的 `attribution`**）。⚠️ 画面上的**可见**署名不读这里：
 * `attributionControl` 是关的 ⇒ 由 HUD 那一行显示，文案**逐字取自清单 `manifest.attribution`**
 * （真数据那句 Overture ODbL 由管线的 `overture_api.ATTRIBUTION` 生成并写进清单，不在这里抄第二版）。
 */
export const PRERENDER_ATTRIBUTION = "预渲染瓦片（自产）· 数据署名见清单 manifest.attribution";
export const PRERENDER_DEMO_ATTRIBUTION = "预渲染瓦片（示意/占位，非真实楼·路数据）";
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

/**
 * 🔴 **瓦片的不透明度分档**（机主 2026-09-25：「**路确实有了，但是瓦片太挡视野了喵**」）。
 *
 * 为什么改：原来 z≤12 是**全不透明**（`[12,1, 14,0]`）—— 那是第 1 步"骨架期"定的，
 * 当时实时层只有 600m 一小块，瓦片必须自己顶满；**现在不一样了**：
 *   · 楼：实时层已能取到 2000m；· 路：离线包按视野铺（`/roadsbundle`）⇒ 实时层能覆盖大半屏。
 * ⇒ 瓦片从"主角"退回**本职**：**远处没有实时数据时的替身**。分档（单调不增）：
 *   z≤10 → **1.00**（全国/市区尺度：瓦片仍是唯一的信息源，"城市轮廓"要看得清）
 *   z11  → 0.72（开始让位）
 *   z12  → 0.45（明显让位；此刻实时层+离线路网已盖住视野里的大部分）
 *   z13  → 0.18（几乎交还实时层，只剩一点"远处的底"）
 *   z≥14 → **0**（完全交还；层本身也在 `LOD_NEAR_ZOOM` 关掉）
 *   ⚠️ 2026-09-25 改：原来 13.5 就归零，而矢量楼要到 14 才画 ⇒ **12.8~14 那截两层都不管**
 *   （机主在 13.5 看到「只有路线没有楼」）。现在归零点与矢量楼起点**统一在 14**。
 * ⚠️ **不是删掉瓦片**：z≤12 之外/实时层取不到的地方，仍靠它兜底（见 README/DESIGN 的 LOD 分工）。
 * 自检钉着：档位单调不增、`z ≥ LOD_OPACITY_ZERO_ZOOM` 必须为 0。
 */
export const LOD_OPACITY_ZERO_ZOOM = 14;
export const LOD_OPACITY_STOPS: ReadonlyArray<readonly [number, number]> = [
  /* 🔴 2026-09-25 修正（机主：「**拉远就看不到楼了喵**」）：原档位在 z12~14 一路压到 0，
     而**楼房矢量层要到 14 才画** ⇒ 中间那一截"两层都不管" = 拉远看不到楼。
     现在瓦片**在 14 之前都保持足够不透明**（只是轻微让位），交接点严格落在 14。 */
  [8, 1], [9, 1], [10, 1], [11, 0.9], [12, 0.8], [13, 0.7], [13.5, 0.5], [LOD_OPACITY_ZERO_ZOOM, 0],
];

/** 预渲染层在某个 zoom 下的不透明度（纯函数 ⇒ 自检不必建地图、更不必有 WebGL） */
export function lodOpacityAt(zoom: number): number {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_OPACITY_STOPS[LOD_OPACITY_STOPS.length - 1][0];
  const st = LOD_OPACITY_STOPS;
  if (z <= st[0][0]) return st[0][1];
  for (let i = 1; i < st.length; i++) {
    if (z <= st[i][0]) {
      const [z0, o0] = st[i - 1], [z1, o1] = st[i];
      if (z1 === z0) return o1;
      return +((o0 + ((o1 - o0) * (z - z0)) / (z1 - z0))).toFixed(4);
    }
  }
  return st[st.length - 1][1];
}

/**
 * 写进 `raster-opacity` 的表达式 —— 与 `baseFade` **同一机制**（`interpolate/linear/zoom`），
 * 但档位按上面那套"让位给实时层"重新定过（不再是 baseFade 的 2 档）。
 */
export function lodOpacityExpression(): unknown[] {
  const flat: unknown[] = [];
  for (const [z, o] of LOD_OPACITY_STOPS) flat.push(z, o);
  return ["interpolate", ["linear"], ["zoom"], ...flat];
}

/** 某个源的路径/署名（**只这一份表**：页面与 App 都从这里取，别在两处写路径字面量） */
export function prerenderSourceOf(src: PrerenderSource = "real"): {
  src: PrerenderSource;
  tilePath: string;
  manifestPath: string;
  attribution: string;
  /** 这个源里的瓦片按什么口径记来源（真数据 / 示意占位） */
  kind: "real" | "placeholder";
} {
  if (src === "demo") {
    return {
      src: "demo",
      tilePath: PRERENDER_DEMO_TILE_PATH,
      manifestPath: PRERENDER_DEMO_MANIFEST_PATH,
      attribution: PRERENDER_DEMO_ATTRIBUTION,
      kind: "placeholder",
    };
  }
  return {
    src: "real",
    tilePath: PRERENDER_TILE_PATH,
    manifestPath: PRERENDER_MANIFEST_PATH,
    attribution: PRERENDER_ATTRIBUTION,
    kind: "real",
  };
}

/** 预渲染层的栅格源（**我们自己的瓦片路径**；`maxzoom` = 金字塔上限，更高的 zoom 放大复用） */
export function lodSourceSpec(src: PrerenderSource = "real"): Record<string, unknown> {
  const s = prerenderSourceOf(src);
  return {
    type: "raster",
    tiles: [s.tilePath],
    tileSize: PRERENDER_TILE_SIZE,
    maxzoom: PRERENDER_TILE_MAXZOOM,
    attribution: s.attribution,
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
export function lodPlan(src: PrerenderSource = "real"): {
  group: "prerender";
  layerId: string;
  sourceId: string;
  beforeId: string | null;
  src: PrerenderSource;
  srcKind: "real" | "placeholder";
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
  const s = prerenderSourceOf(src);
  return {
    group: "prerender",
    layerId: PRERENDER_LAYER_ID,
    sourceId: PRERENDER_SOURCE_ID,
    beforeId: entry ? entry.beforeId : null,
    src: s.src,
    srcKind: s.kind,
    tilePath: s.tilePath,
    manifestPath: s.manifestPath,
    tileSize: PRERENDER_TILE_SIZE,
    tileMaxzoom: PRERENDER_TILE_MAXZOOM,
    layerMaxzoom: LOD_NEAR_ZOOM,
    far: LOD_FAR_ZOOM,
    near: LOD_NEAR_ZOOM,
    source: lodSourceSpec(src),
    layer: lodLayerSpec(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   🔭 **取数半径**（机主 2026-09-25 拍板：「取数半径跟随视野放大到 2~8km」）

   病根：半径以前被写死在很小的值（楼 350~2000m、路固定 600m），而手机横屏 z15
   一眼就能看到 ~4km 宽 ⇒ 半径之外**必然是空的**，看起来就是「楼房只有这一块」
   「剩下的路没画」。这两条反馈同源。

   🔴 三条口径（都在这里定，页面/App 只调用）：
     ① **近景 2km 起、远景最多 8km**（阶梯见 `WS_FETCH_R_LADDER`）；
     ② **封顶 8km**：请求再大也不会超过它（`clamp` 在函数里，调用方拿不到超标值）；
     ③ 视野比档位更大时**按视野取大者**（`decidedBy: "view"`）—— 否则"看得见的地方没数据"。
   ⚠️ 代价要如实报：半径翻倍 ⇒ 取数时间与要素数都涨（Overpass 冷查十几秒到分钟级）。
     所以 HUD 必须回证「半径 R / 要素数 / 是否命中缓存 / 花了多久」，页面不许自己编。
   ══════════════════════════════════════════════════════════════════════════════ */
export const WS_FETCH_R_MIN = 2000;
/** 机主拍板的**策略上限**（将来源支持时用；当前被下面的源上限夹住） */
export const WS_FETCH_R_MAX = 8000;
/**
 * **后端单次查询的硬上限**（实测事实，不是策略）：`/api/buildings` 与 `/api/roads` 在调试服务里
 * 写死 `r ∈ (0, 2000]`，超过直接回 `{"ok":false,"error":"半径非法"}`（`world_map_rs/src/main.rs`
 * 的 buildings_api / roads_api 两处；fork 侧 App 通路 `src-tauri/src/world_map/mod.rs` 同款）。
 */
export const WS_FETCH_R_BACKEND_MAX = 2000;
/**
 * 🔴 **数据源自己的上限 = 真正卡住的那一层**（2026-09-25 带对照组的 A/B 实测，不是拍脑袋）。
 *
 * 同一个端点（overpass-api.de）、相差 22 秒的两发，只有半径不同：
 * | R | 结果 |
 * |---|---|
 * | 300m  | **200 / 1.8s / 100 个要素**（对照：端点当时是活的） |
 * | 2000m | **504 Gateway Timeout**（9.2s，服务端直接拒）—— 注意这**就是现在放开的那一档** |
 * | 4000m | 连接被掐（`OpenSSL SSL_read`）/ 另一端点 504 |
 * | 8000m | 一次 200，但只回 **5,651** 个要素（同一片区域 Overture 有 **10.8 万栋**）⇒ **结果被截断** |
 *
 * 外加两条机制性事实：query 里 `[out:json][timeout:40]` 是**服务端**超时（我们改不了），
 * 公共实例还有按 IP 的限流 ⇒ **不是"改大 Rust 的闸门就能拿"**。
 * ⇒ 结论：**不放开**。放开只会把"明确的 `半径非法`"换成"慢失败 + 可能**静默截断**的错数据"，
 *   而截断正是本项目最忌讳的那种错（看起来像"这一带楼少"）。
 * ⇒ 远景**靠预渲染瓦片**（LOD 本来的设计），实时矢量只服务近景 2km。
 */
export const WS_FETCH_R_SOURCE_MAX = 2000;
/* ══ 🛣 路网（**另一条源上限**：比楼更严 —— 2026-09-25 真机回归「道路全没了喵」）════════
   后端实测（`/api/roads`，渝中 29.5567,106.5629；主会话与我各测一次，数字一致）：
     r=600m  → **197 条 / 0~1s**（缓存命中）
     r=800m  → `ok:false` / **0 条 / 99s**   ← 悬崖就在 600 与 800 之间
     r=1200m → `ok:false` / **0 条 / 79~100s**
     r=2000m → `ok:false` / **0 条 / 94s**
   ⇒ 把路的半径跟楼一起抬到 2000m = **把路弄没了**（慢 94s 之后回 0 条）。教训：楼与路的
     "能吃住的半径"**不是一个数**，不许共用一条策略；每一条都要有自己的实测上限。
   ⇒ 单次取路**封顶 600m**；再远**不靠实时取数**，交给**预渲染瓦片**（真瓦片里已画 rank0~3 路网）——
     这正是 LOD 的分工（近处实时 / 远处预渲染）。 */
export const WS_ROADS_R_MAX = 600;
/**
 * 🔴 **分块取数（多打几次小半径）也实测过 —— 不划算**（2026-09-25 任务 A，同一后端）。
 *
 * 做法：把 600m 的块按 850m 间距（= R×√2，格心圆盖满整格）铺满"覆盖半径 ≈1.3km"的 3×3，
 * 每块一条 `/api/roads?r=600`，**串行冷启**实测：
 * | 块 | 耗时 | 结果 |
 * |---|---|---|
 * | (-1,-1) | **56.2s** | `ok:false`（空手而归）|
 * | (-1,0) | **44.4s** | 86 条 |
 * | (-1,1) | **17.6s** | 83 条 |
 * | (0,-1) | **41.1s** | 137 条 |
 * | (0,0)（早先暖过）| **0.13s** | 197 条 · `cached` |
 *
 * ⇒ 三条结论：
 *   ① **冷块跟"一次要个大半径"一样慢**（瓶颈在 Overpass 侧，不在我们请求的形状）；
 *   ② **缓存救不了移动的视野**：后端缓存键是"纬度/0.002、经度/0.002、半径"的格子
 *      （`osm.rs::grid_key`），视野一平移就换一批冷格子；
 *   ③ 9 块 ≈ **3~8 分钟**，且本轮 4 个冷块里 **1 个直接失败**（约 1/4 失败率）——
 *      拿这个喂"实时层"不合适（首屏等它 = 又回到"链被堵住"的老问题）。
 *
 * ⇒ 决定：**不做分块**。live 层就一个 600m 的圆（近景够用），**远处的路交给预渲染瓦片**。
 * ⚠️ 这段数字留着是为了让下一个人**不必再试一遍**，也**别偷偷加 9 个请求**（自检里有断言钉着）。
 */
export const WS_ROADS_CHUNKING_VERDICT =
  "分块实测不划算：冷块 17.6~56.2s、4 块里 1 块 ok:false；只有缓存命中那块 0.13s（视野一平移就换冷格子）"
  + " ⇒ 不做分块，live 层一个 600m 圆，远处的路靠预渲染瓦片";

export const WS_ROADS_LIMIT_WHY =
  "后端实测：取路 r≥800m 会跑 79~100s 后返回空（800→0/99s、1200→0/79s、2000→0/94s；600 才有 197 条）"
  + "⇒ 单次封顶 600m，远处的路看预渲染瓦片";

/** 取路半径：**永远夹到实测上限**（与楼半径无关——两条源的能力不是一个数） */
export function roadsRadiusFor(buildingsRadius: number | null | undefined): {
  radius: number; wanted: number; capped: boolean; why: string | null;
} {
  const want = Number.isFinite(buildingsRadius as number) ? Math.max(0, Number(buildingsRadius as number)) : WS_ROADS_R_MAX;
  const capped = want > WS_ROADS_R_MAX;
  return { radius: WS_ROADS_R_MAX, wanted: capped ? want : WS_ROADS_R_MAX, capped, why: capped ? WS_ROADS_LIMIT_WHY : null };
}

/* ══ 🛣 live 取路的**开关策略**（2026-09-25 机主第二张截图：live 超时 ⇒ 路又没了）════════
   机主截图里的 HUD 原文：
     「路 失败：Error: 超时 12s（撞可用上限）⚠ 策略要 7350m ⇒ 源上限 2000m，"远景不取数"」
   两条实测摆在一起看：
     · 600m **命中缓存** 0.1~1s（暖格），但**冷查是分钟级** —— 分块实测 17.6~56.2s/块，且 4 块里 1 块直接 `ok:false`；
     · 所以"先打一条 600m 试试"在**冷缓存/新区域**下必然撞 12s 超时 ⇒ 用户看到的就是"路没了"。
   ⇒ 结论：**现场 Overpass 不适合当首屏数据源**（它的耗时分布是分钟级 + 非零失败率，不是"偶尔慢"）。
     · **默认 0 条 Overpass**：路从**离线路面包**（静态 `/roadsbundle/<格>.json`，69 格/23,984 条/5.9MB）
       与**预渲染瓦片**来 —— 这两条都是"本地/静态"，耗时与失败都可控；
     · 想现场取数（补新区域、调试）：**`?live=1` 显式开**，且照旧**不阻塞**别层（12s 超时后如实报失败）。
   🔴 不许把默认再改回"先打一条试试" —— 冷缓存下它做的就是**堵住首屏 + 把"没取到"呈现成"路没了"**。 */
export const WS_ROADS_LIVE_DEFAULT = false;
export const WS_ROADS_LIVE_VERDICT =
  "默认不发 /api/roads：现场 Overpass 冷查是分钟级（分块实测 17.6~56.2s/块、4 块 1 失败）"
  + "，600m 只有**缓存命中**才 0.1~1s ⇒ 默认 0 条，路走离线路面包 + 预渲染瓦片；要现场取数加 ?live=1";

/** live 取路**要不要打**：规则在这里（页面只读结论 + 如实写 HUD），默认 `false` */
export function roadsLiveDecision(input?: { forceLive?: boolean | null }): { live: boolean; why: string } {
  if (input && input.forceLive === true) {
    return { live: true, why: "URL 显式 ?live=1 ⇒ 现场取数（明知冷查可能撞 12s 超时，失败会如实报出来）" };
  }
  return { live: false, why: WS_ROADS_LIVE_VERDICT };
}

/* ══ 🏢 live 取**楼**的开关策略（与路同一套思路；机主 2026-09-25 截图：「楼房只有中间一块」）════
   证据与算术：
     · `/api/buildings` 一次只覆盖视野中心 **R≤2000m**（后端硬闸 `r ∈ (0,2000]`；实测 r=2000 常 504）；
     · 冷查 **27~33s**（最慢见过 91.7s）—— 与"路 超时 12s"同源的毛病；
     · 而**已缓存的 Overture 盘**能导出**离线楼房包**（`world_map/export_bld_bundle.py`）：
       实测 **55 盘 → 720,087 栋 → 373 格 / 102.6 MB**，单格中位 **205 KB** / 最大 **1.9 MB**（静态文件）。
   ⇒ 结论：**默认不发 `/api/buildings`**，楼从**离线楼房包**来（按视野取最近的几格、并进累积仓库）；
     现场取数只在 `?live=1` 时打（补新区域/调试），失败照旧**可见**。
   🔴 包外（没有离线格的区域）**必须如实写「包外」** —— 不许让"我们没数据"看起来像"这里没有楼"。 */
export const WS_BLD_LIVE_DEFAULT = false;
export const WS_BLD_LIVE_VERDICT =
  "默认不发 /api/buildings：现场一次只有 R≤2000m（后端硬闸）且冷查 27~33s（最慢 91.7s）"
  + " ⇒ 默认 0 条，楼走离线楼房包（实测 373 格 / 720,087 栋 / 102.6MB，单格中位 205KB）；要现场取数加 ?live=1";

/** live 取楼**要不要打**（规则在这里；页面只读结论 + 如实写 HUD） */
export function bldLiveDecision(input?: { forceLive?: boolean | null }): { live: boolean; why: string } {
  if (input && input.forceLive === true) {
    return { live: true, why: "URL 显式 ?live=1 ⇒ 现场取数（R≤2000m、冷查可能几十秒，失败会如实报出来）" };
  }
  return { live: false, why: WS_BLD_LIVE_VERDICT };
}

/**
 * 楼房那一格的**判词**（"没离线格/包外"与"这里没有楼"必须分得开）。
 *
 * 机主 2026-09-25 截图的现象是"楼房只有中间一块"——根因是**现场取数的半径上限**，
 * 而不是"外面没有楼"。所以：
 *   · `bundle`  = **离线包优先**（默认：仓库里有 N 栋，来自离线格）；
 *   · `outside` = **包外**（这一带没有离线格，且没开 live ⇒ 如实写"包外"，不写 0、不写"没有楼"）；
 *   · `pending` / `ok` / `empty` / `failed` / `off` 与路同一套语义。
 */
export function bldVerdictText(input: {
  /* 🔴 第七态 `sizemismatch` = **格尺寸口径不符**（包按 X° 分格、前端按 Y° 算键 ⇒ 拒绝取数）：
     它与"包外 / 取数失败 / 这里没有楼"**四者互不混淆** —— 说错任何一种是撒谎。 */
  state: "bundle" | "outside" | "pending" | "ok" | "empty" | "failed" | "off" | "sizemismatch";
  n?: number | null;
  have?: number | null;
  missing?: number | null;
  cells?: number | null;
  cap?: number | null;
  err?: string | null;
  /** 包自己的格边长（度）与前端常量 —— 口径不符时**两个数字都要说出来** */
  pkgCell?: number | null;
  feCell?: number | null;
}): string {
  const n = input.n === null || input.n === undefined ? "数不出来" : String(input.n);
  if (input.state === "off") return "🏢 未开（?bld=0）";
  if (input.state === "sizemismatch") {
    const pkg = input.pkgCell === null || input.pkgCell === undefined ? "?" : input.pkgCell + "°";
    const fe = input.feCell === null || input.feCell === undefined ? "?" : input.feCell + "°";
    return `🏢 ❌ **格尺寸口径不符**（包 ${pkg} / 前端 ${fe}）⇒ 拒绝取数 —— `
      + "**不是「包外」、不是「取数失败」、更不是「这里没有楼」**（修包或改前端常量后重试）";
  }
  if (input.state === "pending") return "🏢 离线格取数中…";
  if (input.state === "failed") return `🏢 取数**失败**：${input.err || "原因未知"} —— 不是「这一带没有楼」`;
  if (input.state === "outside") {
    return "🏢 **包外**（这一带没有离线楼房格；默认不发 /api/buildings ⇒ 要现场取数加 ?live=1）"
      + " —— 这是「我们没这个包」，**不是**「这里没有楼」";
  }
  const cells = input.cells === null || input.cells === undefined ? "数不出来" : String(input.cells);
  const cap = input.cap ? `，上限 ${input.cap}` : "";
  return `🏢 离线包 offline-first（仓库 ${n} 栋${cap}；已取 ${cells} 格；**默认不发 /api/buildings** ⇒ 要现场取数加 ?live=1）`;
}

/**
 * 取路那一格的**判词**（"没取"与"没数据"必须分得开）。
 *
 * 机主真机回归的第二个坑：路取不到时页面写的是「这一带没有路网数据」——**把"没取到"说成了"没有"**。
 * 六态各说各的话：`pending` 取数中 / `ok` 正数 / `empty` 0（已量：后端在这些块都回 0）/
 * `failed` 取数失败（带原因）/ `off` 未开（?roads=0）/
 * `bundle` **live 未开**（默认：路走离线路面包 + 预渲染瓦片 —— 不是"没有路"，也不是"取失败"）。
 */
export function roadsVerdictText(input: {
  state: "pending" | "ok" | "empty" | "failed" | "off" | "bundle";
  n?: number | null;
  radius?: number | null;
  capped?: boolean;
  wanted?: number | null;
  why?: string | null;
  cached?: boolean | null;
  ms?: number | null;
  err?: string | null;
}): string {
  const r = input.radius === null || input.radius === undefined ? "?" : String(Math.round(input.radius));
  const cap = input.capped ? `（半径已封顶；本想要 ${Math.round(Number(input.wanted) || 0)}m —— ${input.why || ""}）` : "";
  if (input.state === "off") return "🛣 未开（?roads=0）";
  if (input.state === "bundle") {
    /* ⚠️ 这一态**必须**与"没有路""取失败"分得开：它说的是"我们没发现场请求，路在离线包里" */
    const nb = input.n === null || input.n === undefined ? "数不出来" : String(input.n);
    return `🛣 离线包 offline-first（仓库 ${nb} 条；**默认不发 /api/roads**：冷查分钟级 ⇒ 要现场取数加 ?live=1）`;
  }
  if (input.state === "pending") return `🛣 取数中…（r=${r}m${cap}）`;
  if (input.state === "failed") return `🛣 取数**失败**：${input.err || "原因未知"}（r=${r}m${cap}）—— 不是「这一带没有路」`;
  const n = input.n === null || input.n === undefined ? "数不出来" : (input.n === 0 ? "0（已量：后端返回 0 条）" : String(input.n));
  const ch = input.cached === true ? " · 缓存命中" : (input.cached === false ? " · 实时取数" : "");
  const secs = Number.isFinite(input.ms as number) ? ` · ${(Number(input.ms) / 1000).toFixed(1)}s` : "";
  return `🛣 ${n} 条（r=${r}m${cap}${ch}${secs}）`;
}

/**
 * 📱 **像素比**：低档机收敛到 ≤1.5，其余 ≤2（上限来自 `devicePixelRatio`，取不到按 1 算）。
 *
 * 为什么放在真源里：`ws3dshow.html` 的地图构造要用它，App 侧将来也要用 —— **规则只写一份**。
 * 为什么低档要收：像素比直接乘**填充率**（`pixelRatio²`），而 2D/3D 地图的瓶颈正是填充率；
 * 低档机（`wsCaps.render.perf === "low"`，由 `wsPerf` 按实测帧率写回）用 1.5 换帧率。
 * ⚠️ 具体数字**未在真机测过**（本机无头无 WebGL）—— 这是"宁可少画一点也别掉帧"的保守选择。
 */
export function pixelRatioForTier(perfTier: string | null | undefined, dpr?: number | null): number {
  const d = Number.isFinite(dpr as number) ? Number(dpr) : 1;
  const base = Math.min(2, Math.max(1, d));
  return String(perfTier) === "low" ? Math.min(1.5, base) : base;
}

/** 为什么只能到 2000m（HUD 要如实说出来，别让人以为是"我们不想给"） */
export const WS_FETCH_R_LIMIT_WHY =
  "Overpass 公共实例实测：R=2000 起常 504、R=8000 会静默截断 ⇒ 远景改用预渲染瓦片";
/** 实际可用的上限（策略与能力取小）—— 调用方只该用这个 */
export function wsFetchRadiusMax(): number {
  return Math.min(WS_FETCH_R_MAX, WS_FETCH_R_SOURCE_MAX, WS_FETCH_R_BACKEND_MAX);
}
/** zoom → 半径（近景 2000m；每退一档加一档；`z ≤ 11` 顶格 8000m） */
export const WS_FETCH_R_LADDER: ReadonlyArray<readonly [number, number]> = [
  [15, 2000], [14, 3000], [13, 4000], [12, 6000], [11, 8000],
];

/** 半径按 50m 取整（请求 URL 稳定 ⇒ 后端缓存键稳定；别每帧换一个半径把缓存打散） */
export function fetchRadiusRound(r: number): number {
  return Math.round(r / 50) * 50;
}

/**
 * 视野**中心到角**的距离（米）—— 宿主无关：调用方把地图的四个边界与中心纬度传进来即可
 * （页面用 `map.getBounds()`、App 用同一份；两边不各写一套三角函数）。
 * 为什么用半对角线而不是宽/2：角落也要有数据，否则屏幕上四个角是空的。
 */
export function viewHalfMetersOf(
  bounds: { west: number; south: number; east: number; north: number } | null | undefined,
  lat: number,
): number | null {
  if (!bounds) return null;
  const w = Number(bounds.west), s = Number(bounds.south), e = Number(bounds.east), n = Number(bounds.north);
  if (![w, s, e, n, lat].every((v) => Number.isFinite(v))) return null;
  const mx = (Math.abs(e - w) / 2) * 111320 * Math.cos((lat * Math.PI) / 180);
  const my = (Math.abs(n - s) / 2) * 110540;
  return Math.round(Math.hypot(mx, my));
}

/** 档位值（只看 zoom，不看视野） */
export function fetchRadiusForZoom(zoom: number): number {
  const z = Number.isFinite(zoom) ? Number(zoom) : 15;
  for (const [z0, r] of WS_FETCH_R_LADDER) if (z >= z0) return r;
  return WS_FETCH_R_LADDER[WS_FETCH_R_LADDER.length - 1][1];
}

/**
 * 最终取数半径 = clamp(max(档位值, 视野要的), 2km, 8km)。
 * `viewHalfMeters` = 视野**中心到角**的距离（米）；拿不到就传 null（只用档位值）。
 * 返回 `decidedBy`：是档位定的、视野定的、还是撞了 8km 上限 —— HUD 照实写。
 */
export function fetchRadiusForView(zoom: number, viewHalfMeters: number | null): {
  radius: number;
  /** `cap` = 撞了**实际可用的上限**（策略要更多，但源给不了 —— `limitWhy` 说明原因） */
  decidedBy: "zoom" | "view" | "cap";
  zoomRadius: number;
  viewRadius: number | null;
  /** 策略原本想要多少（被夹住时用来说明差距；没被夹住就是 radius） */
  want: number;
  /** 被夹住的原因（没被夹住 = null） */
  limitWhy: string | null;
} {
  const zoomRadius = fetchRadiusForZoom(zoom);
  const viewRadius = Number.isFinite(viewHalfMeters as number)
    ? fetchRadiusRound(Number(viewHalfMeters))
    : null;
  const hardMax = wsFetchRadiusMax();
  const want = Math.max(zoomRadius, viewRadius === null ? 0 : viewRadius);
  const radius = Math.min(hardMax, Math.max(WS_FETCH_R_MIN, want));
  const decidedBy = want > hardMax ? "cap" : (viewRadius !== null && viewRadius > zoomRadius ? "view" : "zoom");
  return { radius, decidedBy, zoomRadius, viewRadius, want, limitWhy: want > hardMax ? WS_FETCH_R_LIMIT_WHY : null };
}

/**
 * 加档序列：数据太少时逐级放大（`×2`），**绝不越过 8km**。
 * 为什么还要加档：稀疏地段（涪陵那种）2km 里可能一栋楼都没有，而密集地段第一级就够
 * （调用方拿到"够了"就 break）⇒ 加档只帮稀疏区、不伤密集区。
 */
export function fetchRadiusLadder(zoom: number, viewHalfMeters: number | null): number[] {
  const hardMax = wsFetchRadiusMax();
  const r0 = fetchRadiusForView(zoom, viewHalfMeters).radius;
  const out = [r0];
  while (out[out.length - 1] < hardMax) {
    const next = Math.min(hardMax, fetchRadiusRound(out[out.length - 1] * 2));
    if (next === out[out.length - 1]) break;
    out.push(next);
  }
  return out;
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
  /** 视野内、清单里标为 **真数据** 的张数；`null` = 数不出来 */
  real: number | null;
  /** 视野内、清单里标为 **占位（示意）** 的张数；`null` = 数不出来 */
  placeholder: number | null;
  /** 视野内、清单里有但**没标种类**的张数（老清单）—— 如实报出来，不当成 0 */
  unknownKind: number | null;
  /** **已载入**的瓦片数；`null` = 数不出来（取不到坐标/状态） */
  hit: number | null;
  /** 命中数的**口径**（`cache` = 瓦片状态（最硬）；`events` = 事件计数；`unknown` = 没拿到） */
  hitGauge: "cache" | "events" | "unknown";
  /** **加载失败**的瓦片数；`null` = 数不出来 */
  fail: number | null;
  /**
   * 失败数的口径（同上）。
   * 🔴 两个口径**看到的东西不一样**（读 vendored 源码确认）：
   *   · `cache` = 瓦片 `state === "errored"` —— **含 404**（`_loadTile` 的 catch 里先置状态）⇒ 这才是"真缺图"；
   *   · `events` = `map.on("error")` —— **收不到 404**（404 走的是 `this.update(...)`，不 fire）⇒ 会少报。
   * ⇒ 页面优先用 `cache`；拿不到 cache 时如实标 `events`，并另有 `absent`（清单对拍，确定性）。
   */
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
  /** 清单里的瓦片键（`null` = 清单没取到 ⇒ 数不出来）。
   *  三种写法都认：`string[]` / `Set` / **`Record<键, 记录>`**（后者能分出真/占位） */
  inventory: string[] | Set<string> | Record<string, unknown> | null;
  /** 事件里数到的已载入键（`null` = 事件没给可用坐标） */
  loaded: string[] | null;
  /** 事件里数到的失败键（`null` = 同上） */
  failed: string[] | null;
  /** 地图内部的瓦片状态计数（只读诊断；给了就优先用它 —— 比事件可靠） */
  states?: LodTileStates | null;
}): LodTileVerdict {
  const empty = {
    real: null as number | null,
    placeholder: null as number | null,
    unknownKind: null as number | null,
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
  const raw = input.inventory === null || input.inventory === undefined ? null : input.inventory;
  const inv: Set<string> | null = raw === null ? null
    : raw instanceof Set ? raw
      : Array.isArray(raw) ? new Set(raw)
        : new Set(Object.keys(raw as Record<string, unknown>));
  const kindOf = (k: string): LodTileKind => {
    if (raw === null || raw instanceof Set || Array.isArray(raw)) return "unknown";
    return lodTileKindOf((raw as Record<string, unknown>)[k]);
  };
  const view = input.view;
  if (!view) {
    return { state: "unknown", ...empty, why: "数不出来：拿不到视野/zoom（地图还没就绪）" };
  }
  const keys = view.keys;
  const inInv = inv === null ? null : keys.filter((k) => inv.has(k)).length;
  const absent = inInv === null ? null : keys.length - inInv;
  const real = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "real").length;
  const placeholder = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "placeholder").length;
  const unknownKind = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "unknown").length;
  const st = input.states || null;
  const hit = st ? st.loaded : input.loaded === null ? null : input.loaded.length;
  const hitGauge: LodTileVerdict["hitGauge"] = st ? "cache" : input.loaded === null ? "unknown" : "events";
  const fail = st ? st.errored : input.failed === null ? null : input.failed.length;
  const failGauge: LodTileVerdict["failGauge"] = st ? "cache" : input.failed === null ? "unknown" : "events";
  const why: string[] = [];
  if (inv === null) why.push("清单没取到 ⇒ 「本区应有/清单缺」数不出来");
  if (unknownKind !== null && unknownKind > 0) why.push(`视野里有 ${unknownKind} 张清单记录**没标种类**（老清单）⇒ 真/占位分不出来`);
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
    real,
    placeholder,
    unknownKind,
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

/** 一张瓦片的**来源种类**（🔴 判词纪律：一张拼花里必须分得出哪张是真、哪张是占位） */
export type LodTileKind = "real" | "placeholder" | "unknown";

/** 清单里一条瓦片记录（**新格式**是对象；老格式是数字 = 字节数，视为 `placeholder`） */
export interface PrerenderTileEntry {
  kind: LodTileKind;
  src?: string;
  bytes?: number;
  /** 这张瓦片里画进去的楼栋数（`null` = 数不出来） */
  bld?: number | null;
  fetchedSecs?: number;
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
  /** 按瓦片：对象 = 新格式（带 `kind`）；数字 = 老格式（当初只有示意瓦片，一律按 `placeholder` 认） */
  tiles: Record<string, number | PrerenderTileEntry>;
  /** 汇总（生成方给；页面自己也会按视野重算一遍，两者不一致时以**视野**为准） */
  kinds?: Record<string, number>;
  attribution?: string;
  dataKind?: string;
}

/** 把清单里的一条记录归一成"种类"（认不出就是 `unknown`，**不猜**） */
export function lodTileKindOf(entry: unknown): LodTileKind {
  if (entry === null || entry === undefined) return "unknown";
  if (typeof entry === "number") return "placeholder"; // 老格式：那时只有示意瓦片
  const k = (entry as PrerenderTileEntry).kind;
  return k === "real" || k === "placeholder" ? k : "unknown";
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

/* ── 读地图（宿主无关）：**回证要的证据**只在真源里取一次 ────────────────────────
   为什么放这里（PR 标准①：运行期逻辑只在共享真源）：这两件事**代拍页与将来的 App 都要做**
   （瓦片状态、实时层要素数）。放在页面里 ⇒ App 接线时必然抄第二份。
   两个函数都只要求"有个地图对象"（不 import maplibre 类型）⇒ 页面、App、自检的假地图都能用。 */

/** 「实时矢量层」= 楼体 + 路网 —— 这两类正是 LOD 远景要用瓦片替身的东西（前缀只有这一份） */
export const LOD_LIVE_LAYER_PREFIXES: readonly string[] = ["bld-", "road-casing-", "road-line-", "road-glow-"];
/** 这两个 geojson 源是场景里"实时矢量"的数据来源（与页面/App 的现有约定一致） */
export const LOD_LIVE_SOURCE_IDS: readonly string[] = ["bld", "roads"];

export function lodLiveLayerIds(layerIds: readonly string[]): string[] {
  return (layerIds || []).filter((id) => LOD_LIVE_LAYER_PREFIXES.some((p) => String(id).startsWith(p)));
}

/** 地图对象里"瓦片缓存"那一小块（只要这几个方法；真 map 与假 map 都满足） */
export interface LodTileCacheMapLike {
  style?: {
    tileManagers?: Record<string, { _inViewTiles?: {
      getAllIds?: () => string[];
      getRenderableIds?: () => string[];
      getTileByID?: (id: string) => { state?: string } | undefined;
    } } | undefined>;
  } | null;
}

/**
 * 读**瓦片状态**（只读诊断口径，最硬的那条证据）。
 * 🔴 用 `getAllIds()`（视野里**全部**瓦片，含 `errored`）而不是 `getRenderableIds()`：
 *    读 vendored 源码确认后者只返回 `isRenderable()` 的瓦片 ⇒ **errored 会被漏掉**，
 *    那样"缺图数"永远是 0（把"数不出来"变成"确实没有"—— 判词纪律最防的那种误报）。
 *    404 的瓦片同样是 `state="errored"`（`_loadTile` 的 catch 里先置状态）⇒ 这一条能数出真缺图。
 * 拿不到（字段形状变了/早期版本）⇒ **返回 null**，调用方据此判"数不出来"。
 */
export function lodTileStatesOf(map: LodTileCacheMapLike | null | undefined, sourceId = PRERENDER_SOURCE_ID): LodTileStates | null {
  try {
    const tm = map && map.style && map.style.tileManagers ? map.style.tileManagers[sourceId] : null;
    const cache = tm && tm._inViewTiles;
    if (!cache || typeof cache.getTileByID !== "function") return null;
    const ids = typeof cache.getAllIds === "function" ? cache.getAllIds()
      : typeof cache.getRenderableIds === "function" ? cache.getRenderableIds() : null;
    if (!ids) return null;
    const out: LodTileStates = { loaded: 0, errored: 0, loading: 0, total: 0 };
    for (const id of ids) {
      const t = cache.getTileByID(id);
      const s = t && t.state;
      out.total++;
      if (s === "loaded") out.loaded++;
      else if (s === "errored") out.errored++;
      else if (s === "loading" || s === "reloading") out.loading++;
    }
    return out;
  } catch {
    return null;
  }
}

/** 地图对象里"查询要素"那一小块 */
export interface LodQueryMapLike {
  getStyle?: () => { layers?: Array<{ id?: string }> } | null;
  queryRenderedFeatures?: (opts: { layers: string[] }) => unknown[] | null;
  querySourceFeatures?: (sourceId: string) => unknown[] | null;
  areTilesLoaded?: () => boolean;
}

/**
 * 「实时层要素数」：**在这一个函数里**走完"屏幕可见 → 数据源 → 数不出来"三级口径
 * （页面/App 都只调它 ⇒ 口径不会两边漂）。拿不到地图 ⇒ `null`（调用方写"还没查"）。
 */
export function lodLiveVerdictOf(map: LodQueryMapLike | null | undefined): LodLiveVerdict | null {
  if (!map || typeof map.getStyle !== "function") return null;
  let layers: string[] = [];
  try {
    const st = map.getStyle();
    layers = lodLiveLayerIds(((st && st.layers) || []).map((l) => String((l && l.id) || "")));
  } catch {
    layers = [];
  }
  let rendered: number | null = null;
  let source: number | null = null;
  let tilesLoaded: boolean | null = null;
  try {
    if (layers.length && typeof map.queryRenderedFeatures === "function") {
      const r = map.queryRenderedFeatures({ layers });
      rendered = Array.isArray(r) ? r.length : null;
    }
  } catch {
    rendered = null;
  }
  try {
    /* 退路：数据源要素（⚠️ 瓦片没加载完时会数出 0 ⇒ 不能当"没有"）
       一个源都查不到（还没建）⇒ 给 `null`（"数不出来"），**不是 0**。 */
    if ((rendered === null || rendered === 0) && typeof map.querySourceFeatures === "function") {
      let n = 0;
      let anyOk = false;
      for (const sid of LOD_LIVE_SOURCE_IDS) {
        try {
          const f = map.querySourceFeatures(sid);
          if (Array.isArray(f)) {
            n += f.length;
            anyOk = true;
          }
        } catch {
          /* 该源还没建：这一路没数到，但不算结论 */
        }
      }
      source = anyOk ? n : null;
    }
  } catch {
    source = null;
  }
  try {
    if (typeof map.areTilesLoaded === "function") tilesLoaded = !!map.areTilesLoaded();
  } catch {
    tilesLoaded = null;
  }
  return lodLiveVerdict({ layerCount: layers.length, rendered, source, tilesLoaded });
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
  /* 🔴 判词不许含糊（机主看到的可能是"一张拼花"）：**真 / 占位 / 缺** 三样分列，
     不许只报一个"命中 N 张"（那样分不出哪张是真数据、哪张是骨架阶段的占位花纹）。 */
  const tileTxt =
    `瓦片 命中 ${lodNum(v.hit)}（口径=${v.hitGauge}） · 失败 ${lodNum(v.fail)}（口径=${v.failGauge}）` +
    ` · 本区 **真 ${lodNum(v.real)} / 占位 ${lodNum(v.placeholder)} / 缺 ${lodNum(v.absent, "0（已量）")}**` +
    (v.unknownKind ? `（另有 ${v.unknownKind} 张未标种类）` : "") +
    ` · 应有 ${lodNum(v.view)}` +
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
