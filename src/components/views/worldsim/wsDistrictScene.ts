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

/* ⚠️ `rampExpression` 已不再用：色阶表达式统一走 `wsArtParams.bldRampColorExpr`（取参只有一份） */
import { themeForTier, themeStyleParts, type WsMapTheme } from "./wsMapTheme";
import { sceneLayerPlan } from "./wsScene";
/* 🎨 **取参只有一份**（`bldArtParamsOf`）—— 本文件只决定"参数怎么变成图层"，不决定参数从哪来 */
import { bldArtParamsOf } from "./wsArtParams";
/* 🎨 基准上妆要 `renderHeight`（楼属性 → 渲染高度，纯函数）。⚠️ 本文件**只**用它的纯函数，
   不碰"形体细化"那套（那属于 `?bld=2` 的 `decorateBuildings`）。 */
import { renderHeight } from "./wsBuildingLook";
/* 🏙 挑选的**统计类型**来自编排真源（`wsBldPickStore`）；规则类型（`wsBuildingPick`）本文件已不再直接用 ——
   `pickBuildingsForView` 那条"按视野挑、无冻结"的旧路**已从这里移除**（App 会"挪一下就变"，机主否过）。 */
import type { BldPickStats } from "./wsBldPickStore"

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
/**
 * 🏢 **楼房矢量层从哪一档开始画**（= `bld-ext` / `bld-line` 的 minzoom）。
 * 🔴 抽成共享常量的原因（2026-09-25 真机事故）：这个数以前在 specs 里写 12.8、而页面"挑楼"的门槛
 * 另写了 14 ⇒ 机主停在 **13.5 级**时**两不靠**：矢量楼在画（≥12.8）、封顶却没生效（<14）
 * ⇒ 12,000 栋全画出来 = 他截图里那片"黑点/还这么多"。**阈值只许有一份。**
 * 2026-09-25 二次更正（机主「**小范围一个区块最高 100 栋**」）后**统一到 14**：
 * `z < 14` 由**预渲染瓦片**负责（瓦片不透明度也延到 14 才归零），`z ≥ 14` 才画矢量楼并按区块封顶。
 */
export const WS_BLD_VECTOR_MINZOOM = 11;   /* ← 2026-09-26 与 `LOD_NEAR_ZOOM` 对齐（机主：楼要一直显示） */

/** 🖊 描边从哪一档才开始**可见**：小比例下每栋只有 1~3px，深色描边会把填充整个盖住（"灯芯绒"）。
 *  与 AI 绘制管线里那条经验同源（z12 小楼不许描边）；这里用 zoom 插值让线从 12.8 的 0 平滑长到 15 的正常宽。 */
export const WS_BLD_OUTLINE_FULL_ZOOM = 15;

/* ══ 🎨 **基准上妆**（`dressBase`，2026-09-26 从代拍页 `dressBldBase` 搬过来）════════════════
 * 机主拍板 **(a′)：App 向代拍页看齐**（「**我的要求是代拍页和App页完全一样喵**」）——
 * 两页默认档都必须走**同一条**"只补渲染字段、**不拆件**"的上妆，所以它不能再只长在页面里
 * （App 抄一份就是 PR 门禁 C1 要防的"第二份实现"）。
 *
 * ## 为什么必须有这一步（页面注释里的真机事故，原话搬来）
 * 图层写的是 `"fill-extrusion-height": ["get","h3d"]`（**没有兜底**），而离线通路以前直接把仓库要素
 * 塞进 `setData`、**从没上妆** ⇒ `h3d` 缺失 = MapLibre 当 0 ⇒ 一地图**平躺的板**
 * （机主 2026-09-25「**这是近处，连3d都没有**」的真因）。
 */

/** 小楼阈值（m²）：脚印面积小于它就 `small = 1`（代拍页 `?bst=2` 用它"小楼不描边"）。
 *  ⚠️ 页面里那份字面量（`BST_SMALL_M2 = 220`）**等它可以动时改成读这里**（v75）——数值以这一份为准。 */
export const WS_BLD_SMALL_M2 = 220;

/** `dressBase()` 的计数（**楼栋数**，不是要素数 —— 不拆件时两者相等，但口径要写死） */
export interface DressBaseCounts {
  n: number;
  /** 有真高度（`height_src === "height"`）的栋数 */
  real: number;
  /** 按层数折算的栋数 */
  levels: number;
  /** 按 `kind` 估 + 确定性抖动的栋数（**不是随机**：同 id 永远同高） */
  kind: number;
}

/**
 * 脚印面积（m²，鞋带公式，经纬度按本地米制换算）——**逐字等于页面那份** `fpAreaM2Of`。
 *
 * 🔴 为什么不去调 `wsBuildingLook.footprintMetrics()`：两者**数值上会有极小差异**
 *   （那份用**首点**纬度做 `kx`、并在质心系里做鞋带；这份用**环上纬度均值**、在绝对坐标里做）。
 *   而 `small = fp < 220` 是**阈值判定** ⇒ 极小的差会让临界楼在两页之间翻面。
 *   "两页完全一样"优先 ⇒ 这里与页面**同式**；等页面也改调共享（v75）之后，这份就是唯一一份。
 */
export function bldFootprintAreaM2(f: { geometry?: { coordinates?: unknown } | null }): number {
  const g = (f && f.geometry) || {};
  const ring = ((g.coordinates as number[][][]) || [])[0] || [];
  if (ring.length < 3) return 0;
  let lat0 = 0;
  for (const q of ring) lat0 += q[1];
  lat0 /= ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky);
  }
  return Math.abs(a) / 2;
}

/**
 * 🎨 **基准上妆（不拆件）**：给每栋楼补 `h3d`（渲染高度）/ `h_from`（高度来源）/ `fp`（脚印 m²）/ `small`。
 *
 * **只补字段、不动几何、不拆件** —— 默认档两页共用这一条（机主 (a′)）。
 * 拆件（裙楼/塔楼/女儿墙/设备箱/天线）走 `wsBuildingLook.decorateBuildings(..., {mode:"detail"})`，
 * 那是 `?bld=2` 那条路（页面本来就有，App 侧本次补上）。
 *
 * @returns `features`（新对象，**不改入参**）+ `counts`（HUD 的高度来源分布；口径与 `ShapeCounts` 同名）
 */
export function dressBase<T extends { properties?: Record<string, unknown> | null; geometry?: unknown }>(
  features: readonly T[] | null | undefined
): { features: Array<Record<string, unknown>>; counts: DressBaseCounts } {
  const counts: DressBaseCounts = { n: 0, real: 0, levels: 0, kind: 0 };
  const out: Array<Record<string, unknown>> = [];
  for (const f of features || []) {
    const { h, from } = renderHeight(f.properties || {});
    const fp = bldFootprintAreaM2(f as { geometry?: { coordinates?: unknown } | null });
    counts.n += 1;
    if (from === "real") counts.real += 1;
    else if (from === "levels") counts.levels += 1;
    else counts.kind += 1;
    out.push({
      ...f,
      properties: { ...(f.properties || {}), h3d: h, h_from: from, fp: Math.round(fp), small: fp < WS_BLD_SMALL_M2 ? 1 : 0 },
    });
  }
  return { features: out, counts };
}

/** 楼体图层的形体档（**两页共用**）：`base` = 原始脚印一条挤出层（默认）· `parts` = 拆件后的 body/roof/antenna 三层 */
export type BldLayerMode = "base" | "parts";

export interface BldLayerOpts {
  /** `?art=` 档位（默认 1 = 恒等 ⇒ 与旧版逐字节相同） */
  art?: number;
  /** `?look=` 档位（默认 1） */
  look?: number;
  /** 形体档（默认 `base` —— 机主 (a′) 之后**两页默认档都是这一档**） */
  mode?: BldLayerMode;
}

export function bldLayerSpecsFor(theme: WsMapTheme, tier: ThemeTier, opts: BldLayerOpts = {}): Array<Record<string, unknown>> {
  /* 🎨 取参**只有一份**（`wsArtParams.bldArtParamsOf`）：色阶 / 描边 / 渐变 / 不透明度 / 停靠点全从它来，
     本文件不写死任何颜色。`art=1` 时 `ramp` 就是主题那个**引用** ⇒ 默认逐字节不变。 */
  const th = theme;
  const P = bldArtParamsOf(th, { art: opts.art ?? 1, look: opts.look ?? 1 });

  /* ── ① `base` 档（**默认**，机主 (a′) 后两页共用）：原始脚印、一条挤出层 + 一条描边层 ──
     规格**逐字段等于代拍页默认档**（`bldLayerSpecs()` 的 else 分支）—— 这是"两页完全一样"的判据，
     由 `ws_pages_consistency.mjs` 的 ④a/④b 盯着。 */
  if ((opts.mode ?? "base") === "base") {
    return [
      {
        id: "bld-ext", type: "fill-extrusion", source: "bld",
        minzoom: WS_BLD_VECTOR_MINZOOM,
        paint: {
          "fill-extrusion-color": P.rampColor,
          "fill-extrusion-height": ["get", "h3d"],
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": P.opacity,
          "fill-extrusion-vertical-gradient": P.vgrad,
        },
      },
      ...(tier.outlineWidth !== null
        ? [{
            id: "bld-line", type: "line", source: "bld",
            minzoom: WS_BLD_VECTOR_MINZOOM,
            /* ⚠️ 这一笔**故意先保留** App 原来的 zoom 插值（`0 → 主题宽`）。
               "改成主题给的固定宽"是**可见变化**（z11~15 描边会变粗），主会话要求它**单独一笔**，
               好让它能被单独审/单独回退 ⇒ 见紧接着的那一笔（本文件同一行的下一刀）。 */
            paint: {
              "line-color": P.outline.color,
              "line-width": ["interpolate", ["linear"], ["zoom"],
                WS_BLD_VECTOR_MINZOOM, 0,
                WS_BLD_OUTLINE_FULL_ZOOM, tier.outlineWidth ?? th.outline.width],
            },
          }]
        : []),
    ];
  }

  /* ── ② `parts` 档（`?bld=2` 拆件）：**与代拍页 `?bld=2` 同形** ────────────────────
     🔴 2026-09-26 机主 (a′) 之后特意**不**再按 `part` 拆成三条层：代拍页 `?bld=2` 一直是
     "**一条 `bld-ext` 画全部 body/roof/antenna**"（颜色读要素自带的 `color3d`，拆件时每条都写了）。
     三条层的版本（`bld-ext`/`bld-roof`/`bld-antenna` + `part` 过滤）是 App 自己的旧形状，
     它会让两页"同一个 `?bld=2`"给出**不同的图层清单**（`ws_pages_consistency.mjs` ④ 会红），
     而且同一个 `bld-ext` 换了宿主就可能匹配 0 栋（`part` 过滤 + 数据没 `part`）。
     ⇒ 两页同形，两个档位（默认 / `?bld=2`）的清单都一致。 */
  return [
    {
      id: "bld-ext", type: "fill-extrusion", source: "bld",
      minzoom: WS_BLD_VECTOR_MINZOOM,
      paint: {
        "fill-extrusion-height": ["get", "h3d"],
        /* ⚠️ 拆件的体块**没有 `min_height`** ⇒ 必须先读 `h_base`（裙楼/塔楼/退台各自落在不同高度） */
        "fill-extrusion-base": ["coalesce", ["get", "h_base"], ["coalesce", ["get", "min_height"], 0]],
        "fill-extrusion-opacity": P.opacity,
        "fill-extrusion-vertical-gradient": P.vgrad,
        /* 颜色读要素自带的 `color3d`（同一张高度色阶 + 按部位调明暗：女儿墙偏亮、设备箱偏深）；
           `color3d` 缺席（没上妆的要素）才走高度色阶 —— 与页面同一条表达式。 */
        "fill-extrusion-color": ["coalesce", ["get", "color3d"], P.rampColor],
      },
    },
    ...(tier.outlineWidth !== null
      ? [{
          id: "bld-line", type: "line", source: "bld",
          minzoom: WS_BLD_VECTOR_MINZOOM,
          paint: {
            "line-color": P.outline.color,
            /* ⚠️ 同 `base` 档：这一笔**故意先保留** App 原来的 zoom 插值，
               "改成主题给的固定宽"是**可见变化**、主会话要求它**单独一笔** ⇒ 见紧接着的下一刀。 */
            "line-width": ["interpolate", ["linear"], ["zoom"],
              WS_BLD_VECTOR_MINZOOM, 0,
              WS_BLD_OUTLINE_FULL_ZOOM, tier.outlineWidth ?? th.outline.width],
          },
        }]
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
  /**
   * 🏙 **近景挑选**（机主 2026-09-25「楼房过于密集…**上限 100 栋根据视野来显示**」，
   * 2026-09-26 更正为「**小范围一个区块最高 100 栋**」+「视野内最少十栋房」）。
   *
   * 传了就把挑出来的那批交给 `dress()`（**其余仍在仓库里，只是不画** —— 事实不编，只编"画多少"）。
   * `null`/不传 = 全画（远景/预览）。
   *
   * 🔴 **编排不在这个模块里**（2026-09-26）：按格挑 + 按格冻结 + 视野补齐的规则与状态都在
   * `wsBldPickStore.createBldPickStore()`（页面与 App **各自一份实例**，调的是**同一个**函数）。
   * 这里只负责"挑出来的那批去 `dress()`、其余不画"这一步。
   *
   * ⚠️ 上一版这里叫 `pickNearView`，内部调 `pickBuildingsForView`（**按视野**挑、**没有冻结**）——
   * App 因此"挪走再挪回，那批楼就变了"（机主真机原话：「**每次滑动建筑都变了**」），
   * 而代拍页早已是按格那套 ⇒ 两页不是一个东西。**别把按视野那套加回来。**
   */
  pick?: ((feats: readonly T[]) => { features: readonly T[]; stats: BldPickStats }) | null;
  /** 挑完回报（**只读**，给 HUD 写"显示 N / 视野内 M"；不许在这里改数据） */
  onPicked?: (stats: BldPickStats) => void;
}

/**
 * 把**累积仓库的并集一次性**写进地图（楼）。
 * 语义（机主 2026-09-25：「之前的没了…必须保证视野内完整」）：**一次 `setData`**，
 * 数据来自仓库并集而不是"这一批" ⇒ 换视野/换来源都不会把已画上的楼抹掉。
 */
export function flushBldStore<T>(opts: BldFlushOpts<T>, why = "flush"): void {
  /* 🏙 近景挑选：**只影响"画哪些"**，仓库不动（HUD 的"仓库 N 栋"仍是全量）。
     编排（按格挑 + 按格冻结 + 视野补齐）在 `wsBldPickStore` 里 —— 这里只转交。 */
  let drawn = opts.features();
  if (opts.pick) {
    const r = opts.pick(drawn);
    drawn = r.features;
    try { opts.onPicked?.(r.stats); } catch { /* HUD 失败不影响落图 */ }
  }
  const data = opts.dress(drawn);
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
