/**
 * wsDistrictScene.ts —— **小区级 3D 街景（districts）装配的唯一真源**。
 *
 * ## 为什么有这一份（不是"再抄一份"，是**搬家**）
 * `ROUTE.md §五.1`（机主 2026-09-25 原话「**App 页才是最终结构（PR）**」）要求：
 * **运行期逻辑必须落在共享单一真源，页面只做"接线 + 回证"**；判据是"换宿主、调同样的函数"。
 * 而 PR 标准门禁（`world_map/pr_standard_check.py` C1）实测：下面这五个函数在
 * `WsDistrictMapLibre.vue`（App 宿主）与 `public/ws3dshow.html`（原型页）里**各有一份**，
 * 共享目录里**一份都没有** ⇒ 两份都算私货。本文件把**宿主那一份升格成真源**：
 *
 * | 旧名（宿主 / 原型页） | 本模块的导出 |
 * |---|---|
 * | `makeStyle()` | `districtStyleOf(theme, low, fadeMs)` |
 * | `bldLayerSpecs()` | `bldLayerSpecsFor(theme, tier)` |
 * | `applyBuildings(m, data)` | `applyBuildingsTo(m, data, specs)` |
 * | `flushBld(why)` | `flushBldStore(opts, why)` |
 * | `flushRoads(why)` | `flushRoadsStore(opts, why)` |
 * | （宿主私有）`planBeforeOf(m, group)` | `planBeforeOf(m, group)` + `scenePlanConsumed()` |
 *
 * 🔴 **本文件的纪律**：
 *   1. **逐字搬**：行为、默认值、边界条件一字不改（搬家 commit 的 diff 应当一眼看出是搬运）；
 *      观感数值（颜色/色阶/层序/不透明度）**一个都不在这里写死** —— 全部来自 `wsMapTheme` 与 `wsScene`。
 *   2. **只被"接线"调用**：页面/宿主负责"什么时候刷、数据从哪来、HUD 怎么念"；
 *      这里负责"数据怎么落到图层上"（首次建源建层、之后一次 `setData`、插入锚点取自场景计划）。
 *   3. 累积仓库的**合并/淘汰**规则不在这里（在 `wsFeatureStore` + `wsOfflineFeed`）；
 *      取数决策/半径/判词也不在这里（在 `wsScene`）。
 *
 * ⚠️ 原型页 `public/ws3dshow.html` 里那份仍由它自己持有（门禁按 `C1b` ⚠️ 提醒，收口归片区名那条线）；
 *    本模块的导出名就是留给页面侧复用的（普通 `export function`，不藏）。
 */

import { rampExpression, themeForTier, themeStyleParts, type WsMapTheme } from "./wsMapTheme";
import { sceneLayerPlan } from "./wsScene";

/** 楼层档位（`themeForTier()` 的返回；层序/描边这些"随主题变"的参数都从这里取） */
export type ThemeTier = ReturnType<typeof themeForTier>;

/** 落图需要的地图最小接口（真 MapLibre 实例与自检的假地图都满足） */
export interface DistrictMapLike {
  getLayer(id: string): unknown;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  addSource(id: string, spec: Record<string, unknown>): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
}

export interface FeatureCollectionLike {
  type: "FeatureCollection";
  features: unknown[];
}

/* ══ ① 样式 ══════════════════════════════════════════════════════════════════════ */

/**
 * 小区级地图的**整份 style**（原宿主 `makeStyle()`，逐字搬）。
 *
 * ⚠️ 2026-09-19 更正：原来写「**不依赖瓦片服务器**」——那是当时的取舍，但结果是这块地方
 * 一直是一整片纯深色（机主："只有白底/不像地图"）。现在接 **Esri 暗色灰底**（免 key、实测 0.48s）。
 * 🔴 Esri 路径是 `{z}/{y}/{x}`（y 在前），写成 `{z}/{x}/{y}` 不报错但地图会跑到错位置。
 *
 * @param theme   主题对象（含 `id`；`wsMapTheme()` / `nightVariant()` 派生而来）
 * @param low     低端档（关 sky/降档，见 `themeForTier`）
 * @param fadeMs  颜色过渡时长（**低端档必须传 0**：软渲染下过渡就是每帧重算）
 */
export function districtStyleOf(theme: WsMapTheme, low: boolean, fadeMs: number): Record<string, unknown> {
  /* 🎨 整份 style 的"底半部分"（`sky` + `sources` + 背景/底图/色罩/注记）由
     `wsMapTheme.themeStyleParts()` 生成 —— 它是**纯函数**，所以
     `ws_map_theme_selftest.mjs` 能在 Node 里把生成出来的 style 按
     **从 vendored maplibre 包里现抠出来的 spec** 逐条校验
     （根级属性白名单 / 图层类型枚举 / sky 的 7 个合法字段 / 各 paint 字段表）。

     🔴 为什么值得这么做：2026-09-20 往 `layers[0]` 塞过一个坏对象 ⇒
     **整份 style 校验失败 ⇒ `load` 永不触发 ⇒ 全站退回 2D 降级**。
     那种错只在**运行时**炸一次，而它本来是可以被断言掉的。
     ⚠️ `sky` **不是图层类型**（图层类型只有 fill/line/symbol/circle/heatmap/
     fill-extrusion/raster/hillshade/color-relief/background），只能走**根级** `sky`。 */
  const parts = themeStyleParts(theme, low, fadeMs);
  return {
    version: 8,
    name: `ws-district-${theme.id}`,
    /* `sky` 可能没有（低端档会关掉它）—— 用展开而不是写 `sky: undefined`，
       免得给 style 里塞一个值为 undefined 的键（校验器会当它存在）。 */
    ...(parts.sky ? { sky: parts.sky } : {}),
    sources: parts.sources,
    /* ⚠️ 顺序有意义（自下而上）：bg → base → [hi] → [tint] → ref。
       楼房的图层由 `addLayer(l, "ref")` 插到 **ref 之前** ⇒ 自动落在线罩**之上**。
       `ref` 必须留在最后一条：它是楼房层的插入锚点。 */
    layers: parts.layers,
  };
}

/* ══ ② 楼房图层规格 ═══════════════════════════════════════════════════════════════ */

/**
 * 楼房那几条图层（`bld-ext` / `bld-roof` / `bld-antenna` / `bld-line`）（原宿主 `bldLayerSpecs()`，逐字搬）。
 * 颜色/描边/色阶**全从主题取**（`theme` / `themeTier`），这里不写死任何色号。
 */
export function bldLayerSpecsFor(theme: WsMapTheme, tier: ThemeTier): Array<Record<string, unknown>> {
  /* 🎨 主题参数（暗色 ↔ 二次元）与低端档 —— 都从单一真源取，不在这里写死任何颜色 */
  const th = theme;
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

/* ══ ③ 落图 ══════════════════════════════════════════════════════════════════════ */

/** 场景计划（层序锚点）到底用上没有 —— 面板/自证要读它（宿主以前自己存一个 `sceneConsumed`） */
let planConsumed = false;
export function scenePlanConsumed(): boolean {
  return planConsumed;
}
/** 自检/热重载用：把"用上了"的标记复位（**不改任何渲染行为**） */
export function resetScenePlanConsumed(): void {
  planConsumed = false;
}

/** 计划里的插入锚点（`wsScene.sceneLayerPlan()` 是唯一真源；取到就记下"场景真源用上了"） */
export function planBeforeOf(m: DistrictMapLike, group: "roads" | "buildings"): string | undefined {
  try {
    const e = sceneLayerPlan().find((x) => x.group === group);
    if (!e) return undefined;
    planConsumed = true;
    return e.beforeId && m.getLayer(e.beforeId) ? e.beforeId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把一份**已上妆**的楼栋数据落到图层上：首次建源 + 建层，之后只 `setData`。
 * （落图通路**只有这一条**：离线包与 `?live=1` 两条来源都先把要素并进仓库，再由 `flushBldStore` 调它
 *   —— 写两遍迟早漂移，而"两条来源各画一套"正是"新的一来旧的没了"的成因。）
 */
export function applyBuildingsTo(
  m: DistrictMapLike,
  data: FeatureCollectionLike,
  specs: Array<Record<string, unknown>>
): void {
  if (m.getSource("bld")) {
    m.getSource("bld")!.setData(data);
    return;
  }
  m.addSource("bld", { type: "geojson", data });
  /* 🎬 层序：`before=` 取自**计划**（`wsScene.sceneLayerPlan()`）—— 计划里 buildings 的
     `beforeId` 就是这里的取值，**逐字相同**；取不到才退回本地判断（`ref` 注记层 ⇒ 街名压在楼上面）。 */
  const before = planBeforeOf(m, "buildings") ?? (m.getLayer("ref") ? "ref" : undefined);
  for (const l of specs) m.addLayer(l, before);
}

export interface BldFlushOpts<T> {
  /** 仓库并集（宿主持有仓库；合并/淘汰规则在 `wsFeatureStore`） */
  features: () => readonly T[];
  /** 上妆（宿主自己的口径：App = `dressBld`，原型页 = 它那套 decorate）——本文件不碰观感数值 */
  dress: (feats: readonly T[]) => FeatureCollectionLike;
  /** 地图；`null` = 没有可落的图（2D 降级路 / `?bld=0`）⇒ 交给 `onNoMap` */
  map: () => DistrictMapLike | null;
  /** 楼房图层规格（**取自真源** `bldLayerSpecsFor(theme, tier)`） */
  specs: () => Array<Record<string, unknown>>;
  /** 没有地图时怎么办（App：交给 2D 自绘；原型页 `?bld=0`：只记数不画） */
  onNoMap?: (data: FeatureCollectionLike) => void;
  /** 落图**之前**（宿主的计数/HUD；**不许在这里改数据**） */
  beforeDraw?: (why: string, data: FeatureCollectionLike) => void;
  /** 落图**之后**（宿主的标签/HUD；画不成时不会调用） */
  afterDraw?: (why: string, data: FeatureCollectionLike) => void;
}

/**
 * 把**累积仓库的并集一次性**写进地图（楼）。
 * 语义（机主 2026-09-25：「之前的没了…必须保证视野内完整」）：**一次 `setData`**，
 * 数据来自仓库并集而不是"这一批" ⇒ 换视野/换来源都不会把已画上的楼抹掉。
 */
export function flushBldStore<T>(opts: BldFlushOpts<T>, why = "flush"): void {
  const data = opts.dress(opts.features());
  opts.beforeDraw?.(why, data);
  const m = opts.map();
  if (!m) {
    opts.onNoMap?.(data);
    return;
  }
  applyBuildingsTo(m, data, opts.specs());
  opts.afterDraw?.(why, data);
}

export interface RoadsFlushOpts<T> {
  /** 仓库并集（路的合并/淘汰同样在 `wsFeatureStore`） */
  features: () => readonly T[];
  /** 地图；`null` ⇒ 什么都不画（宿主自己更新吸附/计数那半边） */
  map: () => DistrictMapLike | null;
  /** 路网图层规格（真源 `wsRoads.roadLayerSpecs(theme.road)`） */
  specs: () => Array<Record<string, unknown>>;
  beforeDraw?: (why: string, data: FeatureCollectionLike) => void;
  afterDraw?: (why: string, data: FeatureCollectionLike) => void;
}

/** 把**累积仓库的并集一次性**写进地图（路）；首次建源建层，之后只 `setData`。 */
export function flushRoadsStore<T>(opts: RoadsFlushOpts<T>, why = "flush"): void {
  const data: FeatureCollectionLike = { type: "FeatureCollection", features: opts.features() as unknown[] };
  opts.beforeDraw?.(why, data);
  const m = opts.map();
  if (!m) return;
  if (m.getLayer("road-line-0")) {
    m.getSource("roads")?.setData(data);
  } else {
    m.addSource("roads", { type: "geojson", data });
    /* 插在**楼房之下**：路是地面上的东西，压在楼上会像"从楼顶穿过" */
    const before = m.getLayer("bld-ext") ? "bld-ext" : m.getLayer("ref") ? "ref" : undefined;
    for (const l of opts.specs()) if (!m.getLayer(l.id as string)) m.addLayer(l, before);
  }
  opts.afterDraw?.(why, data);
}
