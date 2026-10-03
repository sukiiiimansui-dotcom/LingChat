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
/* 🎨 基准上妆要 `buildingPartSet`（拆件：主体 + 屋顶系，纯函数）。
   ⚠️ 本文件**只**用它的纯函数，不碰"形体细化"那套（那属于 `?bld=2` 的 `decorateBuildings`）。
   `renderHeight` 已不再直接调（它现在在 `buildingPartSet` 里算，两边各算一次迟早漂移）。 */
import { buildingPartSet, HEIGHT_COLOR_RAMP, type ShapeMode } from "./wsBuildingLook";
/* 🏢 **拆件的 zoom 分档真源**（2026-10-02 B1）：两个固定阈值 + `part→档位` 查表 + 离线可见性判定。
   ⚠️ 它是**单向**依赖（本文件 → 它），它不 import 任何东西 ⇒ 不成环。 */
import {
  WS_BLD_DETAIL_ROOF_ZOOM,
  WS_BLD_DETAIL_EQUIP_ZOOM,
  bldTierOfPart,
  bldLayerVisibilityAt,
} from "./wsBldDetailTiers";
/* 🏙 挑选的**统计类型**来自编排真源（`wsBldPickStore`）；规则类型（`wsBuildingPick`）本文件已不再直接用 ——
   `pickBuildingsForView` 那条"按视野挑、无冻结"的旧路**已从这里移除**（App 会"挪一下就变"，机主否过）。 */
import type { BldPickStats } from "./wsBldPickStore"
/* 🏙 双预算挑楼的**统计类型**（真源在 `wsBldBudget`）—— 落图通路对两种口径一视同仁：
   它只把挑出来的那批交给 `dress()`、把 `stats` 转给 `onPicked()`，**不解读**统计里的字段。 */
import type { BldBudgetStats } from "./wsBldBudget"
/* 🌆 **足迹档的分界线**（2026-10-03「按 zoom 分层」）：`z < WS_BLD_FOOTPRINT_MAXZOOM` 画足迹
   （`bld-foot`，平面）、`z ≥ 14` 画立体（`bld-ext`，挤出）—— 与上面的屋顶系阈值**同一条分界线**
   （那个 14 全项目只有一份，在 `wsBldBudget` 里引用 `wsBldDetailTiers`）。 */
import { WS_BLD_FOOTPRINT_MAXZOOM } from "./wsBldBudget";

/** 两种挑楼口径的统计（按格 / 双预算）—— 落图通路只转交，不解读 */
export type BldPickAnyStats = BldPickStats | BldBudgetStats;

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
 * 楼房那几条图层（`bld-foot` / `bld-ext` / `bld-roof` / `bld-equip` / `bld-line`；
 * 2026-10-02 起按 zoom 分三条挤出层，**2026-10-03 起再加一条足迹层**）。
 * 颜色/描边/色阶**全从主题取**（`theme` / `themeTier`），这里不写死任何色号。
 */
/**
 * 🏢 **楼房矢量层从哪一档开始画**（= `bld-foot` / `bld-line` 的 minzoom）。
 * 🔴 抽成共享常量的原因（2026-09-25 真机事故）：这个数以前在 specs 里写 12.8、而页面"挑楼"的门槛
 * 另写了 14 ⇒ 机主停在 **13.5 级**时**两不靠**：矢量楼在画（≥12.8）、封顶却没生效（<14）
 * ⇒ 12,000 栋全画出来 = 他截图里那片"黑点/还这么多"。**阈值只许有一份。**
 * 2026-09-25 二次更正（机主「**小范围一个区块最高 100 栋**」）后**统一到 14**：
 * `z < 14` 由**预渲染瓦片**负责（瓦片不透明度也延到 14 才归零），`z ≥ 14` 才画矢量楼并按区块封顶。
 * 2026-10-03 **按 zoom 分层**后它的语义变成"**楼房矢量**（先足迹、后立体）从这一档开始"：
 *   · `11 ≤ z < 14` ⇒ **足迹层** `bld-foot`（平面 `fill`，看得见城市肌理）；
 *   · `z ≥ 14` ⇒ **立体层** `bld-ext`（挤出）。
 * ⇒ **"瓦片归零点 = 矢量楼起点"那条三向不变量仍然成立**（`ws_lod_selftest.mjs` 盯着 11/11/11），
 *   变的只是"11~14 这一段画的是什么形状"。
 */
export const WS_BLD_VECTOR_MINZOOM = 11;   /* ← 2026-09-26 与 `LOD_NEAR_ZOOM` 对齐（机主：楼要一直显示） */

/**
 * 🌆 **足迹层的不透明度**（`bld-foot` 的 `fill-opacity`；2026-10-03「按 zoom 分层」那一笔）。
 *
 * 取值理由（不是拍脑袋 —— 机主的原话是"平面，**看得见城市肌理**"）：
 *  ① **看得见**：z12 时一栋 30m 楼在屏上只有 0.9px、z13 只有 1.8px（1280px 视口实测表，见
 *     `wsBldBudget` 文件头）⇒ 足迹是"这一片有没有城市、肌理是方格还是自由生长"的**唯一线索**，
 *     低于 0.3 在一张亮底图上就快读不出来了；
 *  ② **不压住路网/水绿**：路网层是**插在 `bld-ext` 之前**的（`flushRoadsStore` 的 `before` +
 *     `wsLayerOrder.planEnsureRoadOrder` 的事后断言）⇒ 路恒在足迹**之上**；水/绿地是底图那批层，
 *     0.35 的覆盖不会把它们压成一片死色（同一量级的先例：代拍页 `bld-contact` 接触阴影 = 0.35）；
 *  ③ **它是一个常量、不是表达式**：足迹档**只在 z<14 出现**（`maxzoom` 那一刀），
 *     zoom 插值在这里没有意义，还会多一个"低 zoom 越画越淡"的不确定观感；
 *  ④ **只跟图层走**：不掺帧率/设备/候选数（机主红线：不许自动降级）。
 */
export const WS_BLD_FOOTPRINT_OPACITY = 0.35;

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
 * 🎨 **基准上妆（默认档 = 主体 + 屋顶系）**：给每栋楼补 `h3d`/`h_from`/`color3d`/`h_base`/`part`/`zt`/`fp`/`small`。
 *
 * ## 🏢 2026-10-02 改口径（机主拍板的 B1：「拆件进默认档 + 按 zoom 分层」）
 * 以前这里是"**只补渲染字段、不拆件**"（一栋楼一个要素，屏上全是平顶柱体）。
 * 现在默认档走 `buildingPartSet(mode:"roof")` ⇒ 一栋楼变成 **1~5 个要素**：
 *   · `body`（第 0 档，**一直画**）；
 *   · `parapet` 女儿墙（第 1 档，`z ≥ 14` 才画）；
 *   · `equip` 设备箱 1~3 个 + `antenna` 天线（第 2 档，`z ≥ 16` 才画）。
 * **裙楼/塔楼/退台仍然只在 `?bld=2`**（`mode:"detail"`）—— 默认档的轮廓始终是原始脚印。
 *
 * ## 两条闸（同一份固定阈值，都**不**看帧率/设备）
 * ① **图层侧**：`bld-roof` / `bld-equip` 各自的 `minzoom`（`bldLayerSpecsFor`）——
 *    这是真正让渲染器"这一档 0 顶点 / 0 draw call"的那条闸（`bldLayerVisibilityAt` 可离线判定）；
 * ② **生成侧**：`opts.zoom` 给了就**连体块都不生成**（省 `setData` 的解析与内存）。
 *    两条闸同值 ⇒ 不存在"生成了却没人画"的白工，也不存在"该画却没生成"的空档。
 *
 * @param features 楼栋要素（**不动入参**）
 * @param opts.ramp 高度色阶（拆件的 `color3d` 从它派生；不给 ⇒ `HEIGHT_COLOR_RAMP`）
 * @param opts.zoom 当前 zoom（生成侧分档；不给/非有限数 ⇒ **全档都生成**，离线与自检用）
 * @returns `features`（新对象，**不改入参**）+ `counts`（HUD 的高度来源分布；`n` **永远是楼栋数**）
 */
export function dressBase<T extends { properties?: Record<string, unknown> | null; geometry?: unknown }>(
  features: readonly T[] | null | undefined,
  opts: { ramp?: Array<[number, string]>; zoom?: number | null } = {}
): { features: Array<Record<string, unknown>>; counts: DressBaseCounts } {
  const counts: DressBaseCounts = { n: 0, real: 0, levels: 0, kind: 0 };
  const out: Array<Record<string, unknown>> = [];
  const ramp = opts.ramp ?? HEIGHT_COLOR_RAMP;
  const zoom = typeof opts.zoom === "number" && isFinite(opts.zoom) ? opts.zoom : null;
  /* 生成侧分档：与图层侧的 `minzoom` **同一份常量**（`wsBldDetailTiers`） */
  const roofOn = zoom === null || bldLayerVisibilityAt(WS_BLD_DETAIL_ROOF_ZOOM, null, zoom) === "visible";
  const equipOn = zoom === null || bldLayerVisibilityAt(WS_BLD_DETAIL_EQUIP_ZOOM, null, zoom) === "visible";
  const mode: ShapeMode = "roof";
  for (const f of features || []) {
    const fp = bldFootprintAreaM2(f as { geometry?: { coordinates?: unknown } | null });
    const set = buildingPartSet(
      f as { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> },
      ramp,
      { mode }
    );
    /* 🔴 计数口径 = **楼栋数**（拆件后要素变多，HUD 的「🏢 N」必须还是"这里有几栋楼"） */
    counts.n += 1;
    if (set.parts[0]) {
      const from = (set.parts[0].properties as Record<string, unknown> | undefined)?.h_from;
      if (from === "real") counts.real += 1;
      else if (from === "levels") counts.levels += 1;
      else counts.kind += 1;
    }
    for (const part of set.parts) {
      const p = (part.properties || {}) as Record<string, unknown>;
      const zt = bldTierOfPart(p.part);
      if (zt === 1 && !roofOn) continue;   // 女儿墙那一档：z<14 连生成都不生成
      if (zt === 2 && !equipOn) continue;  // 设备箱/天线那一档：z<16 同上
      out.push({
        ...part,
        properties: { ...p, fp: Math.round(fp), small: fp < WS_BLD_SMALL_M2 ? 1 : 0 },
      });
    }
  }
  return { features: out, counts };
}

/** 楼体图层的形体档（**两页共用**）：`base` = 默认档（主体 + 屋顶系，2026-10-02 起）· `parts` = `?bld=2` 拆件档（多裙楼/塔楼/退台） */
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

  /* ── 🏢🌆 **按 zoom 分档的楼房层**（2026-10-02 B1 三条挤出层 + 2026-10-03 足迹层）──────
     档位来自 `wsBldDetailTiers`（唯一真源）：0 = 主体/裙楼/塔楼/退台 · 1 = 女儿墙
     （`z ≥ WS_BLD_DETAIL_ROOF_ZOOM` = 14）· 2 = 设备箱 + 天线（`z ≥ WS_BLD_DETAIL_EQUIP_ZOOM` = 16）。
     2026-10-03 **再按同一条分界线分"画法"**：`z < WS_BLD_FOOTPRINT_MAXZOOM`(14) ⇒ 足迹（`fill`）·
     `z ≥ 14` ⇒ 立体（`fill-extrusion`）—— 机主原话：「z<14 画"足迹"（平面，看得见城市肌理）；
     z≥14 画立体（严格档 100 栋）」。

     🔴 **闸是 `minzoom` / `maxzoom`**：MapLibre 的 `layout.visibility` 在 v6.10.0 **不接受 zoom 表达式**
     （vendor 里那份 style-spec 的 `parameters` 只有 `global-state`；写了 zoom 表达式 ⇒ **整份 style
     校验失败 ⇒ 地图永不 load**，这个坑项目踩过）。`minzoom`/`maxzoom` 是官方"按 zoom 开关整层"的那一档，
     语义上就是"z 落在区间外 ⇒ 该层不可见 ⇒ **0 顶点 / 0 draw call**"（离线判定 `bldLayerVisibilityAt`）。
     ⚠️ **固定阈值**：这几个数只跟 zoom 走，**不看帧率、不看设备**（机主红线：不许性能档位自动降级）。

     分层筛选靠要素上算好的 `zt`（0/1/2），**不在 filter 里拼表达式** —— 表达式报错是静默的
     （本项目为此付过代价）。`zt` 缺席（没上妆的要素）**按第 0 档算** ⇒ 照旧画，绝不"少画楼"。 */
  const tierFilter = (t: 0 | 1 | 2): unknown[] =>
    t === 0 ? ["==", ["coalesce", ["get", "zt"], 0], 0] : ["==", ["get", "zt"], t];
  /** 🎨 **楼体取色（全项目唯一一份表达式）**：要素自带的 `color3d` 优先，缺了才走主题色阶。
   *  足迹层（`fill-color`）与三条挤出层（`fill-extrusion-color`）**共用同一个数组对象** ⇒
   *  "远了是足迹、近了是立体"的**颜色口径同一个字节都不会漂**（各写一份迟早变成一片楼两种色）。 */
  const bldColorExpr: unknown[] = ["coalesce", ["get", "color3d"], P.rampColor];
  /** 屋顶系两条层共用的 paint：颜色读要素自带的 `color3d`（同一张高度色阶 + 按部位调明暗：
   *  女儿墙偏亮、设备箱偏深），底座读 `h_base`（屋顶件不是从地面长出来的）。 */
  const detailPaint = {
    "fill-extrusion-height": ["get", "h3d"],
    "fill-extrusion-base": ["coalesce", ["get", "h_base"], ["coalesce", ["get", "min_height"], 0]],
    "fill-extrusion-opacity": P.opacity,
    "fill-extrusion-vertical-gradient": P.vgrad,
    "fill-extrusion-color": bldColorExpr,
  };
  /* ── 🌆 **足迹层**（`bld-foot`，2026-10-03 机主拍板：「z<14 画"足迹"（平面，看得见城市肌理）」）──
     与立体层**同一个 source、同一批要素**，差别只在画法与 zoom 区间：
       · `fill`（贴地平面）而不是 `fill-extrusion`；
       · `maxzoom = WS_BLD_FOOTPRINT_MAXZOOM`(14) ⇒ **z ≥ 14 整层不可见**（MapLibre 语义：
         `minzoom ≤ z < maxzoom`；这一档由 `bld-ext` 接手）——闸是 `maxzoom` 而不是 `visibility`，
         理由与屋顶系那两条层完全相同（`layout.visibility` 不接受 zoom 表达式）；
       · `minzoom = WS_BLD_VECTOR_MINZOOM`(11)：与"楼房矢量从 11 起"那条三向不变量同一个起点；
       · `filter = tierFilter(0)`：只画主体（z<14 时屋顶系那两档连要素都不生成，见 `dressBase`）。
     🔴 **层序**：它是 specs 数组的**第一条** ⇒ `applyBuildingsTo()` 里那句 `addLayer(l, before)`
     先加它（`before` 取法与同文件其它层**逐字相同**：场景计划 → `ref` 注记层兜底，没有第二套）
     ⇒ 它落在 `bld-ext` 以及**后插进来的路网**之下 —— 足迹是地面上的东西，压住路网/注记就成了
     "一层半透明脏膜"。 */
  const footLayer = {
    id: "bld-foot", type: "fill", source: "bld",
    minzoom: WS_BLD_VECTOR_MINZOOM,
    maxzoom: WS_BLD_FOOTPRINT_MAXZOOM,
    filter: tierFilter(0),
    paint: {
      "fill-color": bldColorExpr,
      "fill-opacity": WS_BLD_FOOTPRINT_OPACITY,
    },
  };
  const roofLayer = {
    id: "bld-roof", type: "fill-extrusion", source: "bld",
    minzoom: WS_BLD_DETAIL_ROOF_ZOOM,
    filter: tierFilter(1),
    paint: { ...detailPaint },
  };
  const equipLayer = {
    id: "bld-equip", type: "fill-extrusion", source: "bld",
    minzoom: WS_BLD_DETAIL_EQUIP_ZOOM,
    filter: tierFilter(2),
    paint: { ...detailPaint },
  };
  const outlineLayers = tier.outlineWidth !== null
    ? [{
        id: "bld-line", type: "line", source: "bld",
        minzoom: WS_BLD_VECTOR_MINZOOM,
        /* 🖊 **描边宽度 = 共享取参给的那一个**（`P.lineWidth`）：`art=1` ⇒ 主题给的**固定宽**；
           `art≥2` ⇒ `WS_BLD_OUTLINE_STOPS` 的 zoom 插值。**与代拍页逐字段相同**。 */
        paint: {
          "line-color": P.outline.color,
          "line-width": P.lineWidth,
        },
      }]
    : [];

  /* ── ① `base` 档（**默认**，机主 (a′) 后两页共用）：原始脚印 + 屋顶系两条 ──
     规格**逐字段等于代拍页默认档**（`bldLayerSpecs()` 的 else 分支）—— 这是"两页完全一样"的判据，
     由 `ws_pages_consistency.mjs` 的 ④a/④b 盯着。
     ⚠️ `bld-ext` 从 2026-10-02 起也读 `color3d`/`h_base`：默认档的数据**现在也拆件**
     （`dressBase` 走 `mode:"roof"`），主体与屋顶件必须是**同一条取色**（各读各的会一片楼两种色）。
     ⚠️ 2026-10-03 **按 zoom 分层**：`bld-foot`（足迹，z<14）打头、`bld-ext` 的 `minzoom` 抬到
     `WS_BLD_FOOTPRINT_MAXZOOM`(14)（立体只在 z≥14 出现）；屋顶系两条不动。 */
  if ((opts.mode ?? "base") === "base") {
    return [
      footLayer,
      {
        id: "bld-ext", type: "fill-extrusion", source: "bld",
        minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
        filter: tierFilter(0),
        paint: { ...detailPaint },
      },
      roofLayer,
      equipLayer,
      ...outlineLayers,
    ];
  }

  /* ── ② `parts` 档（`?bld=2` 拆件）：**与代拍页 `?bld=2` 同形** ────────────────────
     拆件档比默认档多出来的只是**数据**（裙楼/塔楼/退台/窗格），图层这边不再需要第二套 paint
     ⇒ 两档共用上面那几条层，只有 `bld-win`（`?win=1`）是**代拍页独有**的一层，不进本函数。 */
  return [
    footLayer,
    {
      id: "bld-ext", type: "fill-extrusion", source: "bld",
      minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
      filter: tierFilter(0),
      paint: { ...detailPaint },
    },
    roofLayer,
    equipLayer,
    ...outlineLayers,
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
   *
   * 🏙 **2026-10-02（B2）**：默认口径换成 `store.pickBudget()`（**双预算**：Σ投影 px² + Σ顶点，
   * 两个固定常量）。`store.pick()`（按格 + 冻结）留给 `?bldn=` 的 A/B 逃生口与两页一致闸第③组。
   * 本参数的类型因此放宽成"两种统计都收"（`BldPickAnyStats`）—— 通路只转交，不解读。
   */
  pick?: ((feats: readonly T[]) => { features: readonly T[]; stats: BldPickAnyStats }) | null;
  /** 挑完回报（**只读**，给 HUD 写"显示 N / 视野内 M"；不许在这里改数据） */
  onPicked?: (stats: BldPickAnyStats) => void;
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
