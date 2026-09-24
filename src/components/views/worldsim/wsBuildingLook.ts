/**
 * wsBuildingLook.ts —— 「楼怎么长、怎么上色」的**纯逻辑**（不碰 DOM、不碰地图库，可单测）。
 *
 * ## 为什么单独拎出来（2026-09-19）
 * 机主原话：「这个 ai 2d 小区好丑，直接试一下 3d 路线我看看效果」。
 * 要把"好看"这件事做出来，绕不开两个决定：**每栋楼多高、什么颜色**。
 * 这两件事以前散在 `WsDistrictMapLibre.vue` 的 paint 表达式里，改一次要重编一次页面、
 * 而且没法单独验。现在把它们变成纯函数：输入是后端给的属性，输出是"渲染用的高度 + 来源标签"。
 *
 * ## 🔴 诚实红线（来自 `DESIGN-3D-MODES.md` §八）
 * OSM 在中国的楼高覆盖率很低（渝中区实测：800m 内 232 栋里 **166 栋没有高度**）。
 * 我们不假装那是真数据：
 *   · 真高 → `src: "real"`（原样用）
 *   · 层数×3 → `src: "levels"`（后端已折算好，仍是 OSM 写了的）
 *   · **按 OSM 建筑类型估** → `src: "kind"`（**我们猜的**，HUD 单独计数、单独配色说明）
 * 三档必须分得开。混在一起报一个数，就是"把估计值当真数据"。
 */

/** 渲染高度是从哪来的（HUD 与配色都按它分档） */
export type HeightFrom = "real" | "levels" | "kind";

/** 一栋楼的渲染参数 */
export interface RenderHeight {
  /** 渲染用高度（米）—— `fill-extrusion-height` 吃的就是它 */
  h: number;
  /** 这个高度**凭什么**（别把估计值当真数据） */
  from: HeightFrom;
}

/**
 * OSM 建筑类型 → 合理层高（米）。
 *
 * 为什么需要它：`height_src=default` 那一批后端统一给 8m（一栋"不知道多高"的楼）。
 * 一整片全是 8m ⇒ **天际线是一条平线**，看着比不放楼还假。
 *
 * 取值依据（中国城区最常见的形态，宁可保守也别把老城画成曼哈顿）：
 *   · 老城低层/沿街：3~7m（1~2 层）
 *   · 6~7 层住宅（最常见的"老小区"）：≈ 18m
 *   · 临街商业 4~5 层：≈ 15m
 *   · 写字楼/酒店：40m 起；`tower` 是 OSM 里明确标的高塔，给 90m
 * ⚠️ **说不清是什么楼的**（裸 `building=yes` / 未登记类型）走 `UNKNOWN_KIND_BAND_M` 那一档（**15~18m**）；
 *    这张表里的 `yes` 只写该档的中点，作用有二：① 让读表的人一眼看到量级；
 *    ② 模块还没加载时（代拍页 inline 兜底）用它。**真正的取值为区间 + 确定性哈希**，见 `renderHeight()`。
 */
export const KIND_HEIGHT_M: Record<string, number> = {
  house: 7,
  detached: 7,
  semidetached_house: 7,
  terrace: 9,
  bungalow: 4,
  hut: 3,
  shed: 3,
  garage: 3,
  garages: 3,
  carport: 3,
  roof: 3,
  residential: 18,
  dormitory: 15,
  apartments: 21,
  commercial: 15,
  retail: 12,
  office: 45,
  hotel: 40,
  tower: 90,
  hospital: 24,
  school: 12,
  university: 15,
  kindergarten: 9,
  industrial: 10,
  warehouse: 9,
  factory: 10,
  church: 18,
  temple: 10,
  mosque: 15,
  museum: 18,
  construction: 12,
  yes: 16.5,
};

/**
 * 🔧 **估算档位**（`building=yes` / 未登记类型 ⇒ 没有任何高度数据时的兜底区间，米）。
 *
 * **这是估算值，不是事实** —— 只在后端 `height_src` 既不是 `height` 也不是 `levels` 时生效；
 * HUD 上永远单列成「按类型估 N」，绝不混进「真高 N」。
 *
 * ## 为什么从 12m 提到 15~18m（机主 2026-09-24 拍板）
 * 机主真机反馈「**大量楼像薄板/纸片平躺**」。用他那一屏的真数据量了一下
 * （渝中区 `29.5567/106.5629`、r=800m、**378 栋**）：
 *   · 高度中位数 **11.8m**、≥24m 只有 **25 栋**、≥60m **16 栋**；
 *   · 平均脚印 **653m²**；**179 栋（47%）** 落在「h<15m 且脚印≥300m²」= 视觉上的薄板；
 *   · 无高度的那批里 `building=yes` **141 栋**（占估算类 219 栋的 2/3）。
 * ⇒ 薄板的根因是**估算值偏低 + 大脚印**，不是渲染路径。
 * 中国城区的裸 `building=yes` 实测多为 4~6 层（≈15~18m），12m（≈4 层）偏矮；
 * 取 15~18 还能让这批楼**跨过屋顶细节的 15m 门槛**（女儿墙/设备箱跟着出现，屋顶不再是一块平板）。
 *
 * ⚠️ 改这个区间就会改变**全站**（App 与代拍页共用本函数）的估算楼高 —— 改之前先看 HUD 的「按类型估 N」。
 */
export const UNKNOWN_KIND_BAND_M: [number, number] = [15, 18];

/** 兜底高度（米）：类型不认识时用 = **估算档的中点**（见 `UNKNOWN_KIND_BAND_M`） */
export const FALLBACK_HEIGHT_M = 16.5;

/**
 * 稳定的 32 位哈希（FNV-1a）。**同一个 osm_id 永远得到同一个数**。
 *
 * 为什么需要它：一整片 `building=yes` 如果全给 12m，就是一张**平顶地毯** ——
 * 眼睛一眼就看出"这是程序铺的"。加一点**确定性**抖动（不是随机数！）
 * 人眼读到的就是"一片高低不齐的楼"，而且刷新多少次都一样、不会闪。
 */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV 素数
  }
  return h >>> 0;
}

/** 估算高度的抖动幅度：0.85 ~ 1.15（±15%）—— 够看出参差，又不会把 12m 的楼抖成 20m */
export const KIND_JITTER = 0.15;

/** 一栋楼能有多少米（防呆上限，与后端 MAX_HEIGHT_M 同量级） */
export const MAX_RENDER_H = 500;

/**
 * 楼属性 → 渲染高度。**纯函数**（同输入同输出，可单测）。
 *
 * 优先级：真高 → 层数折算（后端已折进 `height`）→ 按 `kind` 估 + 确定性抖动。
 */
export function renderHeight(props: Record<string, unknown> | undefined | null): RenderHeight {
  const p = props || {};
  const raw = Number(p.height);
  const src = String(p.height_src || "default");
  if (Number.isFinite(raw) && raw > 0) {
    if (src === "height") return { h: Math.min(MAX_RENDER_H, raw), from: "real" };
    /* `levels` 档：后端已经按 levels×3 折好写进 height，直接用；它仍是 OSM 自己写的数 */
    if (src === "levels") return { h: Math.min(MAX_RENDER_H, raw), from: "levels" };
  }
  const seed = String(p.osm_id || p.name || "x");
  const kind = String(p.kind || "yes").toLowerCase();
  /* 🔧 「说不清是什么楼」那一档（裸 `building=yes` / 未登记类型）：**15~18m 区间**，
     区间内位置由 `hash32(seed + "#unk")` 决定 ⇒ 同一栋楼每次一样、整片看又有参差（**不是随机数**）。
     见 `UNKNOWN_KIND_BAND_M` 上方的依据（机主 2026-09-24：12m 太低 ⇒ 大脚印的楼像薄板）。 */
  if (kind === "yes" || !Object.prototype.hasOwnProperty.call(KIND_HEIGHT_M, kind)) {
    const k = hash32(seed + "#unk") % 101; // 0..100
    const h = UNKNOWN_KIND_BAND_M[0] + ((UNKNOWN_KIND_BAND_M[1] - UNKNOWN_KIND_BAND_M[0]) * k) / 100;
    return { h: Math.min(MAX_RENDER_H, Math.max(3, Math.round(h * 10) / 10)), from: "kind" };
  }
  const base = KIND_HEIGHT_M[kind] ?? FALLBACK_HEIGHT_M;
  /* 抖动只跟 osm_id 有关 ⇒ 同一条街每次刷新长得一样（随机会闪，别用随机） */
  const k = hash32(seed) % 31; // 0..30
  const jitter = 1 - KIND_JITTER + (2 * KIND_JITTER * k) / 30; // 0.85 ~ 1.15
  const h = Math.max(3, Math.round(base * jitter * 10) / 10);
  return { h: Math.min(MAX_RENDER_H, h), from: "kind" };
}

/**
 * 给整份 FeatureCollection 里每栋楼**补上渲染字段**（`h3d` / `h_from` / `color3d` / `part`），
 * 并把够高的楼**拆出屋顶压顶与天线**。
 *
 * ⚠️ `count` 数的是**楼栋数**（不是要素数）：拆件之后要素会变多，
 * 但 HUD 上的 `🏢 N` 必须还是"这里有 N 栋楼"，不然读数就没意义了。
 *
 * 为什么在 JS 里算好、而不是写在地图库的表达式里：
 * MapLibre 的 paint 表达式**报错是静默的**（写错一个字段名 ⇒ 图层直接不画，控制台偶尔才吭一声）。
 * 在 JS 里算好只有一个好处但很关键：**HUD 上的计数和画面上真正用的高度一定是同一个数**
 * —— 两边各算一次，迟早漂移，而漂移了没人会发现。
 */
export function decorateBuildings(fc: {
  features?: Array<{ properties?: Record<string, unknown> }>;
} | null, ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP, opts: ShapeOpts = {}): {
  features: Array<Record<string, unknown>>;
  count: ShapeCounts;
} {
  const feats = (fc?.features || []) as Array<{
    id?: unknown;
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;
  const count: ShapeCounts = {
    n: feats.length, real: 0, levels: 0, kind: 0,
    /* ⚠️ 默认档位 = `base`（App 侧不传 opts ⇒ 行为与这一版之前**逐字节相同**）。
       `detail` 只在代拍页 `?bld=2` 打开。 */
    mode: opts.mode === "detail" ? "detail" : "base", low: !!opts.low,
    body: 0, podium: 0, tower: 0, setback: 0, roof: 0, parapet: 0, equip: 0, antenna: 0,
    equipSkipped: 0, skipped: 0, skippedWhy: "", parts: 0,
  };
  const out: Array<Record<string, unknown>> = [];
  for (const f of feats) {
    count[renderHeight(f.properties).from]++;
    /* 🔴 计数与**真正画出去的那批要素**同源（同一个 `buildingPartSet` 的返回值）——
       两边各算一次迟早漂移，而漂移了 HUD 上没人看得出来。 */
    const set = buildingPartSet(f, ramp, opts);
    for (const part of set.parts) {
      out.push(part);
      const k = String((part.properties as Record<string, unknown>).part || "");
      if (k === "body") count.body++;
      else if (k === "podium") count.podium++;
      else if (k === "tower") count.tower++;
      else if (k === "setback") count.setback++;
      else if (k === "roof") count.roof++;
      else if (k === "parapet") count.parapet++;
      else if (k === "equip") count.equip++;
      else if (k === "antenna") count.antenna++;
    }
    if (set.info.skipped) {
      count.skipped++;
      if (!count.skippedWhy) count.skippedWhy = set.info.skipWhy; // 只留第一条当样例（HUD 放不下 N 条）
    }
    count.equipSkipped += set.info.equipSkipped;
  }
  count.parts = out.length;
  return { features: out, count };
}

/**
 * 渲染高度 → 颜色插值节点（给 `fill-extrusion-color` 用）。
 *
 * 为什么按**高度**上色而不是按"数据来源"上色（以前是那样）：
 * 数据口径是给工程师看的，不该拿来当美术。按高度上色，画面才有**天际线** ——
 * 矮的沉进暗部、高的亮起来，一眼看出"哪片是高楼"。
 * （"哪些是估的"仍然可读：见 `HEIGHT_FROM_ALPHA`，用的是透明度那一档，不抢色彩。）
 *
 * ⚠️ 低端必须**明显亮于** Esri 暗底图（约 #1e1e1e~#2d2d2d）：不然楼和地面一个亮度，
 *    整屏糊成一块 —— 这正是"看着很丑"的成因之一。
 */
export const HEIGHT_COLOR_RAMP: Array<[number, string]> = [
  [3, "#23323e"],
  [8, "#2d4356"],
  [16, "#3a586f"],
  [30, "#4a7290"],
  [60, "#5f93b0"],
  [110, "#7fbcd4"],
  [200, "#b6e2f2"],
  [320, "#e8f7ff"],
];

/** `HEIGHT_COLOR_RAMP` → MapLibre 的 `interpolate/linear` 表达式（写一次，两条路共用） */
export function heightColorExpression(ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP): unknown[] {
  const stops: unknown[] = [];
  for (const [h, c] of ramp) stops.push(h, c);
  return ["interpolate", ["linear"], ["coalesce", ["get", "h3d"], 8], ...stops];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 第二步：**"改造渲染"**（`world_map/DESIGN-BUILDING-REALISM.md` §三 的 #2/#4/#6/#8）
 *
 * 一句话：**不换数据**，用同一批 OSM 轮廓"画得更像一座真城市"。
 * 思路是把"一栋楼"在**渲染前**拆成几个体块（body / roof / antenna）——
 * 全部在 JS 里算好，图层的 paint 只读现成字段（`h3d` / `h_base` / `color3d` / `part`）。
 *
 * 为什么坚持"在 JS 里算好"：MapLibre 的 paint 表达式**报错是静默的**
 * （字段名写错 ⇒ 图层直接不画，控制台偶尔才吭一声）。在 JS 里算，
 * 不但能被单测覆盖，还能让 **HUD 的计数和画面上真正画的东西必然是同一份**。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 这栋楼被拆成哪种体块。
 *
 * `base` 档只用 body/roof/antenna（App 侧现在就是这三种）；
 * `detail` 档（代拍页 `?bld=2`）多了 podium（裙楼）/tower（塔楼）/setback（退台段）/parapet（女儿墙）/equip（设备箱）。
 * ⚠️ 新体块只在 `detail` 档出现 ⇒ App 侧那三层（按 part 过滤的）不受影响；
 *    将来接进 App 时，`WsDistrictMapLibre.vue` 的三层 filter 要一起加上新 part（**本次范围外**）。
 */
export type BldPart = "body" | "roof" | "antenna" | "podium" | "tower" | "setback" | "parapet" | "equip";

/** 屋顶压顶只给"够高的楼"做（矮平房压顶反而脏，而且白翻一倍要素数） */
export const ROOF_MIN_H = 15;
/** 屋顶相对轮廓的**内缩比例**（0.85 = 向中心收 15%）——近似"女儿墙" */
export const ROOF_INSET = 0.85;
/** 屋顶那层压顶的厚度（米）——太厚就不像屋顶像加了一层 */
export const ROOF_THICK_M = 1.3;
/** 多高的楼才配一根"天线"（城市轮廓里最抓眼的一档） */
export const ANTENNA_MIN_H = 60;
/** 天线长度（米） */
export const ANTENNA_M = 12;

/** 十六进制色 → 按系数调亮/调暗（>1 亮、<1 暗），夹在 0~255 */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * k)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** 高度 → 色阶取色（纯查表，和 GL 里那条 `interpolate` 用**同一张表**） */
export function rampColorOf(h: number, ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP): string {
  let c = ramp[0]![1];
  for (const [stop, col] of ramp) if (h >= stop) c = col;
  return c;
}

/**
 * 一栋楼的**最终颜色** = 高度色阶 + **确定性**微扰。
 *
 * 为什么要微扰：一整片楼如果都取色阶上同一档，颜色会"齐刷刷一样"，
 * 一眼就看得出是程序刷的。±10% 的明度差异足够让眼睛读出"一栋一栋"，又不会花。
 *
 * 🔴 种子必须来自 `osm_id`（**不是 `Math.random()`**）：同一栋楼每次渲染颜色必须一致，
 *    用随机数会让整片楼**每帧闪**（而且刷新一次变一个样，没法比对截图）。
 */
export function buildingColor(h: number, seed: string, ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP): string {
  const k = 0.9 + (hash32(seed || "x") % 21) / 100; // 0.90 ~ 1.10
  return shade(rampColorOf(h, ramp), k);
}

/** 环的**外环**（后端只产出 Polygon；拿不到就返回 null，不猜） */
function outerRing(geom: unknown): number[][] | null {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = (g.coordinates as number[][][])[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}

/** 向质心缩 k 倍（k<1 内缩）。近似"女儿墙"用，**不做真多边形偏移**（那要处理凹角/自交，不值当） */
export function insetRing(ring: number[][], k: number): number[][] {
  const n = ring.length - 1; // GeoJSON 环首尾同点，质心只数前 n 个
  if (n < 3) return ring;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0]!;
    cy += ring[i]![1]!;
  }
  cx /= n;
  cy /= n;
  const out = ring.map((p) => [cx + (p[0]! - cx) * k, cy + (p[1]! - cy) * k]);
  /* 缩放后首尾可能因为浮点误差不再严格相等 ⇒ 显式闭合（不闭合的环，渲染器会当线处理） */
  out[out.length - 1] = out[0]!.slice();
  return out;
}

/** 环的经纬度包围盒（算"天线"的粗细用，跟楼的大小成比例） */
function ringSpan(ring: number[][]): { w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    const x = p[0]!;
    const y = p[1]!;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** 楼顶正中的一个小方块（当天线底座用） */
function antennaRing(ring: number[][]): number[][] {
  const n = ring.length - 1;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0]!;
    cy += ring[i]![1]!;
  }
  cx /= n;
  cy /= n;
  const { w, h } = ringSpan(ring);
  /* 粗细跟着楼走：最小取楼自身短边的 6%，但**至少** ~2.5m，免得密集区细成亚像素看不见 */
  const r = Math.max(0.000025, Math.min(w, h) * 0.06);
  return [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx - r, cy - r],
  ];
}

/** 造一个"体块"要素（body/roof/antenna/podium/tower/setback/parapet/equip 共用一条通道） */
function partFeature(
  src: { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> },
  ring: number[][],
  base: number,
  top: number,
  part: BldPart,
  color: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "Feature",
    id: `${String(src.id || "")}#${part}${extra.tier ? "-t" + String(extra.tier) : ""}${extra.idx !== undefined ? "-" + String(extra.idx) : ""}`,
    properties: { ...(src.properties || {}), part, h3d: top, h_base: base, color3d: color, ...extra },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/**
 * 楼属性 → 渲染高度（含拆件）。**纯函数**，`decorateBuildings` 内部用它。
 *
 * 返回**体块列表**：`base` 档 = 主体 + （够高才有的）屋顶压顶 + （很高才有的）天线；
 * `detail` 档（`opts.mode="detail"`）= 裙楼/塔楼 + 退台 + 女儿墙 + 设备箱 + 天线（见文件末尾"第四步"）。
 * 所有体块都是**同一个轮廓加工出来的**，所以不需要任何新数据。
 */
export function buildingParts(
  f: { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> },
  ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP,
  opts: ShapeOpts = {}
): Array<Record<string, unknown>> {
  return buildingPartSet(f, ramp, opts).parts;
}

/**
 * 一栋楼的**完整拆件结果 + 这条楼的细节统计**（`buildingParts` 只是取 `.parts`）。
 *
 * 为什么多返回一个 `info`：HUD 上的「女儿墙 N / 设备箱 N / 跳过的纸片楼 N」必须和
 * **真正画出去的那批要素**是同一份数据算出来的。让"数"和"画"共用一次计算，
 * 就不存在"计数说 12、画面画了 9"这种漂移。
 */
export function buildingPartSet(
  f: { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> },
  ramp: Array<[number, string]> = HEIGHT_COLOR_RAMP,
  opts: ShapeOpts = {}
): { parts: Array<Record<string, unknown>>; info: BldDetailInfo } {
  const props = f.properties || {};
  const { h, from } = renderHeight(props);
  const seed = String(props.osm_id || f.id || "");
  const color = buildingColor(h, seed, ramp);
  const base = Number(props.min_height) || 0;
  const info: BldDetailInfo = { skipped: false, skipWhy: "", podium: false, tiers: 1, equipWanted: 0, equipPlaced: 0, equipSkipped: 0 };
  /* 主体：几何**原样**，只补上算好的字段（`h_base` 统一口径，paint 里不用再分支） */
  const body: Record<string, unknown> = {
    type: "Feature",
    id: `${String(f.id || "")}#body`,
    properties: {
      ...props,
      part: "body",
      h3d: h,
      h_from: from,
      h_base: base,
      color3d: color,
    },
    geometry: f.geometry,
  };
  const ring = outerRing(f.geometry);
  if (!ring) return { parts: [body], info };
  /* ⑤ 低档（`perfLow` / `?low=1`）：**只画主体**。退台/屋顶细节/窗格全部不生成。
     ⚠️ 这一条必须在 `base` 分支**之前**判 —— 低档要的正是"连压顶/天线都不要"，
     落到 base 分支就会把压顶和天线又画回来（自检里踩过：低档出来 3 个要素）。 */
  if (opts.low) return { parts: [body], info };
  const detail = (opts.mode ?? "base") === "detail";
  if (!detail) {
    /* ── `base` 档 = 2026-09-19 那一版，**一字不改**（App 侧走的就是这条） ───────────── */
    const parts: Array<Record<string, unknown>> = [body];
    if (h >= ROOF_MIN_H) {
      /* 屋顶压顶：内缩 + 更深色 ⇒ 楼顶有一圈"女儿墙"的层次（DESIGN-BUILDING-REALISM #4） */
      parts.push(partFeature(f, insetRing(ring, ROOF_INSET), h, h + ROOF_THICK_M, "roof", shade(color, 0.62)));
    }
    if (h >= ANTENNA_MIN_H) {
      /* 天线：城市轮廓里最抓眼的一档（#6）。只在很高的楼上做，要素数不会失控 */
      parts.push(partFeature(f, antennaRing(ring), h, h + ANTENNA_M, "antenna", shade(color, 1.25)));
    }
    return { parts, info };
  }
  /* ── `detail` 档（代拍页 `?bld=2`）：裙楼/塔楼 + 退台 + 女儿墙 + 设备箱 + 天线 ─────── */
  const plan = buildingMasses(ring, h, base, opts);
  info.skipped = plan.skipped;
  info.skipWhy = plan.why;
  info.podium = plan.podium;
  info.tiers = plan.tiers;
  const parts: Array<Record<string, unknown>> = plan.masses.map((mass) => {
    const wall = mass.top >= base + WIN_MIN_H && !plan.skipped; // 窗格只给"够高的墙面"
    return partFeature(f, mass.ring, mass.base, mass.top, mass.part, massColor(mass, color), {
      shape: plan.skipped ? "sliver" : "mass",
      tier: mass.tier,
      /* 窗格层与色彩层**互补**（同一 source 两层：一层 pattern、一层 color，两者互斥）。
         用 JS 里算好的 0/1 标记，而不是在图层的 filter 里拼表达式 —— 表达式报错是静默的。 */
      win: wall ? 1 : 0,
    });
  });
  const topH = base + h;
  const topRing = plan.masses[plan.masses.length - 1]!.ring;
  if (!plan.skipped && h >= PARAPET_MIN_H) {
    const fm = footprintMetrics(topRing);
    /* 墙厚：取"薄墙"常数，但**不许吃掉整栋楼**（小楼顶上一圈厚墙 = 看起来像实心块） */
    const t = Math.max(0.2, Math.min(PARAPET_THICK_M, fm.minSideM * 0.18));
    parts.push(partFeature(f, ringBand(topRing, insetRingMeters(topRing, t)), topH, topH + PARAPET_H, "parapet", shade(color, 1.08), { wallThickM: +t.toFixed(2), win: 0 }));
    const eq = equipBoxes(topRing, seed, topH);
    info.equipWanted = eq.wanted;
    info.equipPlaced = eq.boxes.length;
    info.equipSkipped = eq.skipped;
    for (let i = 0; i < eq.boxes.length; i++) {
      const b = eq.boxes[i]!;
      parts.push(partFeature(f, b.ring, b.base, b.top, "equip", shade(color, 0.72), { side: b.side, idx: i, win: 0 }));
    }
  }
  if (!plan.skipped && h >= ANTENNA_MIN_H) {
    parts.push(partFeature(f, antennaRing(topRing), topH, topH + ANTENNA_M, "antenna", shade(color, 1.25), { win: 0 }));
  }
  return { parts, info };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 第四步：**形体细化**（机主 2026-09-24：「能优化一下楼房模吗啊喵」）
 *
 * 六条，逐条可单独验收（全部**纯函数**、全部**确定性**、**一次 `Math.random` 都没有**）：
 *   ① **裙楼 + 塔楼**：脚印够大 + 够高 ⇒ 底部裙楼（保持原脚印、较矮）+ 上部塔楼（内缩 20%）；
 *   ② **退台**：`h ≥ 60m` 按高度分 2~3 段，逐段内缩 10%（阶梯状）；
 *   ③ **屋顶细节**：女儿墙（一圈薄墙 0.6m）+ 设备箱/水箱（按面积 1~3 个，1.5~4m）+ 天线（已有）；
 *   ④ **窗格贴图**：颜色/图案**互斥** ⇒ 同一 source 开两层，用要素上的 `win: 0/1` 标记分派
 *      （表达式里不拼 filter，理由见下面 `win` 的注释）；图案由 `windowPatternSpec()` 生成
 *      （直接产 RGBA，**不需要 canvas、不引 sprite 服务器**）；
 *   ⑤ **低档**（`opts.low`）：只画主体，退台/屋顶细节/窗格**全部关掉**（保帧率）；
 *   ⑥ **形体干净**：脚印 <20m² 或长宽比 >6 的"纸片楼"**跳过全部细节**（只留主体），并计入 `skipped`。
 *
 * 🔴 两条红线：
 *   · 新体块**只在 `detail` 档**出现；`base` 档（App 侧的默认）逐字节不变 —— 自检里有回归项；
 *   · 配色仍从**同一张高度色阶**派生（`shade()` 调明暗），不引入第二套配色。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 形体档位：`base` = App 现在这一版（主体/压顶/天线）；`detail` = 上面那六条 */
export type ShapeMode = "base" | "detail";

/** 形体生成开关（**默认 base**：App 侧不传 opts ⇒ 行为不变） */
export interface ShapeOpts {
  mode?: ShapeMode;
  /** 低档（`perfLow`）：只画主体 + 描边，关掉退台/屋顶细节/窗格 */
  low?: boolean;
}

/** 一栋楼的细节统计（`buildingPartSet` 的第二返回值；HUD 的回证就吃它） */
export interface BldDetailInfo {
  /** 纸片楼/碎片 ⇒ 只留主体、跳过了全部细节 */
  skipped: boolean;
  /** 跳过的原因（人读的一句话；没跳过就是空串） */
  skipWhy: string;
  /** 是不是"裙楼 + 塔楼"切分 */
  podium: boolean;
  /** 竖向分了几段（含最下面那段；1 = 没退台） */
  tiers: number;
  equipWanted: number;
  equipPlaced: number;
  /** 想放但**放不下**（候选位置都出界）的设备箱数 —— 如实计，不假装放上了 */
  equipSkipped: number;
}

/** `decorateBuildings` 返回的计数（HUD/徽标的**唯一**来源） */
export interface ShapeCounts {
  /** 楼栋数（拆件之后要素会变多，这个数**永远**是"这里有几栋楼"） */
  n: number;
  real: number;
  levels: number;
  kind: number;
  mode: ShapeMode;
  low: boolean;
  body: number;
  /** 裙楼（底部那块） */
  podium: number;
  tower: number;
  /** 退台段（不含最下面那一段） */
  setback: number;
  /** 基准档的屋顶压顶（detail 档不做它，改用女儿墙 + 设备箱） */
  roof: number;
  parapet: number;
  equip: number;
  /** 想放但放不下的设备箱（候选位置全出界） */
  equipSkipped: number;
  antenna: number;
  /** 跳过的纸片楼（脚印 <20m² 或长宽比 >6） */
  skipped: number;
  /** 第一栋被跳过的为什么（样例，便于回证） */
  skippedWhy: string;
  /** 要素总数（= 真正画出去的数量） */
  parts: number;
}

/* ── ① 裙楼/塔楼的判定线与比例 ─────────────────────────────────────────────── */
/** 脚印至少这么大才谈得上"裙楼"（小了就是普通楼，硬拆只会变成两根牙签） */
export const PODIUM_MIN_AREA_M2 = 800;
/** 至少这么高才配"裙楼 + 塔楼"（矮楼拆塔楼只会显得头重脚轻） */
export const PODIUM_MIN_H = 24;
/** 塔楼相对裙楼的内缩（0.80 = 内缩 20%，任务给的区间是 15~25%） */
export const PODIUM_INSET = 0.8;
/** 裙楼高度 = 楼高 × 这个比例，再夹到 [8, 21] 米（裙楼一般是 2~6 层，太厚就不像裙楼了） */
export const PODIUM_H_RATIO = 0.3;
export const PODIUM_H_MIN = 8;
export const PODIUM_H_MAX = 21;
/** 塔楼至少要留出这么高（不许让裙楼把整栋吃掉） */
export const TOWER_MIN_H = 10;

/* ── ② 退台 ───────────────────────────────────────────────────────────────── */
/** 多高开始做退台（任务给的阈值） */
export const SETBACK_MIN_H = 60;
/** 每退一级内缩 10%（任务给的区间是 8~12%） */
export const SETBACK_INSET = 0.1;
/** 高到这个数就分 3 段（否则 2 段）—— 按**高度**分档，不是按随机数 */
export const SETBACK_TIERS_3_H = 120;

/* ── ③ 屋顶细节 ───────────────────────────────────────────────────────────── */
/** 屋顶细节（女儿墙/设备箱）从多高开始做（与基准档的压顶同一条线：矮平房做了只会显脏） */
export const PARAPET_MIN_H = ROOF_MIN_H;
/** 女儿墙高（0.4~0.8m 区间内取值） */
export const PARAPET_H = 0.6;
/** 女儿墙厚（米；小楼会被 minSide×0.18 夹小，免得一圈厚墙把楼顶占满） */
export const PARAPET_THICK_M = 0.7;
/** 楼顶小于这个面积就不放设备箱（放不下，会变成楼顶长角） */
export const EQUIP_MIN_AREA_M2 = 60;
/** 设备箱边长 1.5~4.0m（任务给的区间；步进 0.5 ⇒ 6 档） */
export const EQUIP_SIDE_MIN = 1.5;
export const EQUIP_SIDE_STEPS = 6;
export const EQUIP_SIDE_STEP_M = 0.5;

/* ── ⑥ 形体干净（纸片楼护栏） ─────────────────────────────────────────────── */
/** 脚印小于这个面积 = 纸片楼（OSM 里常见：一条边墙、一个雨棚被建成 building） */
export const SLIVER_AREA_M2 = 20;
/** 长宽比大于这个数 = 扁片（会挤出一张"刀片"，加细节只会更碎） */
export const SLIVER_ASPECT = 6;

/* ── ④ 窗格 ───────────────────────────────────────────────────────────────── */
/** 墙面高到这个数才铺窗格（矮楼的墙面本来就小，贴上去只会花） */
export const WIN_MIN_H = 40;
/** 窗格图的边长（2 的幂：GPU 平铺友好） */
export const WIN_PATTERN_SIZE = 32;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/** 环的**顶点均值**（与 `insetRing` 内部那套算法同源：首尾同点只数前 n 个） */
export function ringCentroid(ring: number[][]): [number, number] {
  const n = Math.max(1, ring.length - 1);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i]![0]!;
    cy += ring[i]![1]!;
  }
  return [cx / n, cy / n];
}

/**
 * 脚印的**米制**度量（面积 / 长宽比 / 短边 / 顶点平均半径）。
 *
 * 为什么要换算成米：OSM 给的是经纬度，而"20m² 以下算纸片楼""长宽比 >6"这些判据全是米制。
 * 经度方向的 1° 长度随纬度收缩（`cos(lat)`），**不换算就会在重庆把判定算歪**。
 */
export function footprintMetrics(ring: number[][]): { areaM2: number; aspect: number; minSideM: number; meanRadiusM: number } {
  const n = ring.length - 1;
  if (n < 3) return { areaM2: 0, aspect: Infinity, minSideM: 0, meanRadiusM: 0 };
  const c = ringCentroid(ring);
  const lat0 = ring[0]![1]!;
  const kx = M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  let area = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let rSum = 0;
  for (let i = 0; i < n; i++) {
    const px = (ring[i]![0]! - c[0]) * kx;
    const py = (ring[i]![1]! - c[1]) * ky;
    const qx = (ring[(i + 1) % n]![0]! - c[0]) * kx;
    const qy = (ring[(i + 1) % n]![1]! - c[1]) * ky;
    area += px * qy - qx * py; // 鞋带公式
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
    rSum += Math.hypot(px, py);
  }
  const w = x1 - x0;
  const hgt = y1 - y0;
  const minSideM = Math.min(w, hgt);
  return {
    areaM2: Math.abs(area) / 2,
    aspect: minSideM > 0.01 ? Math.max(w, hgt) / minSideM : Infinity,
    minSideM,
    meanRadiusM: rSum / n,
  };
}

/** 点是否在多边形内（射线法；`ring` 可带闭合点）。设备箱四角要靠它验"在楼顶里面" */
export function pointInRing(x: number, y: number, ring: number[][]): boolean {
  const n = ring.length >= 4 ? ring.length - 1 : ring.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 向质心缩进**指定米数**（`insetRing` 是按比例的版本，这个是按绝对厚度的版本）。
 *
 * 用途：女儿墙要的是"一圈 ~0.7m 的薄墙"，按比例缩的话大脚印会缩出 3 米厚的"墙"。
 * ⚠️ 仍然是**径向缩进**（不是真多边形偏移）——真偏移要处理凹角自交，本项目一直没做（见 `insetRing`）。
 */
export function insetRingMeters(ring: number[][], meters: number): number[][] {
  const n = ring.length - 1;
  if (n < 3 || !(meters > 0)) return ring;
  const c = ringCentroid(ring);
  const lat0 = ring[0]![1]!;
  const kx = M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const out = ring.map((p) => {
    const dx = (p[0]! - c[0]) * kx;
    const dy = (p[1]! - c[1]) * ky;
    const d = Math.hypot(dx, dy);
    if (!(d > 1e-6)) return [p[0]!, p[1]!];
    const k = Math.max(0.08, 1 - meters / d);
    return [c[0] + (p[0]! - c[0]) * k, c[1] + (p[1]! - c[1]) * k];
  });
  out[out.length - 1] = out[0]!.slice();
  return out;
}

/**
 * 两条**同点数**的环 → 一条"环带"多边形（外环正走 + 内环倒走）。
 *
 * 这就是女儿墙：把"一圈薄墙"做成**一个**多边形（而不是给每条边生一个四边形）——
 * 要素数从 O(顶点数) 降到 O(1)，而且挤出后外侧面/内侧面/顶面都天然正确。
 * ⚠️ 两条环必须是同点数、且内环完全在外环里（`insetRingMeters` 的产物满足）。
 */
export function ringBand(outer: number[][], inner: number[][]): number[][] {
  const o = outer.slice(0, Math.max(0, outer.length - 1));
  const i = inner.slice(0, Math.max(0, inner.length - 1));
  if (o.length < 3 || i.length !== o.length) return outer; // 形状不对就别硬编（宁可不画细节）
  const ring: number[][] = o.concat(i.slice().reverse());
  ring.push(ring[0]!.slice());
  return ring;
}

/** 竖向的一段体块 */
export interface Mass {
  part: BldPart;
  ring: number[][];
  base: number;
  top: number;
  /** 第几段（从下往上，1 起）—— 退台段靠它编号 */
  tier: number;
}

/** 一栋楼的竖向分块方案 */
export interface ShapePlan {
  masses: Mass[];
  skipped: boolean;
  podium: boolean;
  /** 分了几段（含最下面那段；1 = 没退台） */
  tiers: number;
  why: string;
}

/**
 * 一栋楼的**竖向分块**：裙楼 + 塔楼（①）+ 退台（②）+ 纸片楼跳过（⑥）。**纯函数**。
 *
 * 三种情况：
 *   · `base` 档 / 低档 ⇒ 单块主体（原样，App 侧走这条）；
 *   · 纸片楼 ⇒ 单块主体 + `skipped=true`（不生成任何细节，避免"楼顶长角/碎片"）；
 *   · `detail` 档 ⇒ 裙楼（若够大够高）+ 2~3 段退台。
 * 最高一段的 `top` 恒等于 `base + h`（自检里有这条断言：不许因为分段把楼"变矮"）。
 */
export function buildingMasses(ring: number[][], h: number, base = 0, opts: ShapeOpts = {}): ShapePlan {
  const single: ShapePlan = { masses: [{ part: "body", ring, base, top: base + h, tier: 1 }], skipped: false, podium: false, tiers: 1, why: "" };
  const detail = (opts.mode ?? "base") === "detail" && !opts.low;
  if (!detail) return single;
  const m = footprintMetrics(ring);
  if (m.areaM2 < SLIVER_AREA_M2 || m.aspect > SLIVER_ASPECT) {
    return {
      ...single,
      skipped: true,
      why: `脚印 ${m.areaM2.toFixed(1)}m² / 长宽比 ${Number.isFinite(m.aspect) ? m.aspect.toFixed(1) : "∞"}`,
    };
  }
  const top = base + h;
  const masses: Mass[] = [];
  let curRing = ring;
  let curBase = base;
  let podium = false;
  if (m.areaM2 >= PODIUM_MIN_AREA_M2 && h >= PODIUM_MIN_H) {
    let pH = Math.round(Math.min(PODIUM_H_MAX, Math.max(PODIUM_H_MIN, h * PODIUM_H_RATIO)) * 2) / 2;
    if (pH > h - TOWER_MIN_H) pH = Math.max(2, Math.round((h - TOWER_MIN_H) * 2) / 2); // 塔楼至少留 TOWER_MIN_H
    masses.push({ part: "podium", ring, base, top: base + pH, tier: 1 });
    curRing = insetRing(ring, PODIUM_INSET);
    curBase = base + pH;
    podium = true;
  }
  const tiers = h >= SETBACK_TIERS_3_H ? 3 : h >= SETBACK_MIN_H ? 2 : 1;
  const slice = (top - curBase) / tiers;
  for (let k = 0; k < tiers; k++) {
    const prev = masses[masses.length - 1];
    const ringK = k === 0 ? curRing : insetRing(prev ? prev.ring : curRing, 1 - SETBACK_INSET);
    masses.push({
      part: k === 0 ? (podium ? "tower" : "body") : "setback",
      ring: ringK,
      base: curBase + slice * k,
      top: k === tiers - 1 ? top : curBase + slice * (k + 1), // 最后一段封顶 = base+h（不靠浮点累加）
      tier: k + 1,
    });
  }
  return { masses, skipped: false, podium, tiers, why: "" };
}

/** 设备箱（水箱/空调机组）：一块方形体块 */
export interface EquipBox {
  ring: number[][];
  base: number;
  top: number;
  side: number;
}

/**
 * 楼顶设备箱：按**面积**定 1~3 个、尺寸 1.5~4m、位置由 `osm_id` 哈希决定。**纯函数**。
 *
 * 三条纪律：
 *   ① 数量只看面积（<400m² → 1 个、<1500m² → 2 个、再大 → 3 个）—— 不看随机数；
 *   ② 每个箱子先试 4 个**候选位**（角度/半径/朝向都由哈希给），四角必须**全在楼顶轮廓内**才落；
 *      4 个候选都不行就**不放**并计入 `skipped`（绝不硬塞到楼外去）；
 *   ③ 楼顶太小（<60m²）直接返回空 —— 放上去只会看起来像楼顶长了角。
 */
export function equipBoxes(ring: number[][], seed: string, roofTop: number): { boxes: EquipBox[]; wanted: number; skipped: number } {
  const m = footprintMetrics(ring);
  if (m.areaM2 < EQUIP_MIN_AREA_M2) return { boxes: [], wanted: 0, skipped: 0 };
  const wanted = m.areaM2 < 400 ? 1 : m.areaM2 < 1500 ? 2 : 3;
  /* 往里让一圈（女儿墙的厚度 + 一点余量）⇒ 箱子不会压在女儿墙上 */
  const inner = insetRingMeters(ring, Math.min(PARAPET_THICK_M + 0.6, Math.max(0.5, m.minSideM * 0.12)));
  const c = ringCentroid(inner);
  const im = footprintMetrics(inner);
  const kx = M_PER_DEG_LNG * Math.cos((c[1] * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const boxes: EquipBox[] = [];
  let skipped = 0;
  for (let i = 0; i < wanted; i++) {
    let placed = false;
    for (let cand = 0; cand < 4 && !placed; cand++) {
      const s = hash32(`${seed}#eq${i}:${cand}`);
      const ang = ((s % 360) * Math.PI) / 180;
      const frac = 0.15 + (((s >>> 9) % 40) / 100); // 半径的 0.15~0.55（靠中心，别贴边）
      const side = EQUIP_SIDE_MIN + ((s >>> 17) % EQUIP_SIDE_STEPS) * EQUIP_SIDE_STEP_M; // 1.5~4.0m
      const rot = (((s >>> 23) % 90) * Math.PI) / 180; // 朝向：0~90°（正交的楼顶上也别都是一顺儿）
      const r = im.meanRadiusM * frac;
      const cx = c[0] + (Math.cos(ang) * r) / kx;
      const cy = c[1] + (Math.sin(ang) * r) / ky;
      const half = side / 2;
      const corners: number[][] = [];
      const signs: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const sg of signs) {
        const dx = sg[0] * half * Math.cos(rot) - sg[1] * half * Math.sin(rot);
        const dy = sg[0] * half * Math.sin(rot) + sg[1] * half * Math.cos(rot);
        corners.push([cx + dx / kx, cy + dy / ky]);
      }
      if (!corners.every((p) => pointInRing(p[0]!, p[1]!, inner))) continue; // 出界 ⇒ 换下一个候选位
      corners.push(corners[0]!.slice());
      boxes.push({ ring: corners, base: roofTop, top: roofTop + Math.max(1, Math.min(3, side * 0.75)), side });
      placed = true;
    }
    if (!placed) skipped++;
  }
  return { boxes, wanted, skipped };
}

/** 体块颜色：**同一张高度色阶** + 按部位的明暗系数（不引入第二套配色） */
function massColor(mass: Mass, baseColor: string): string {
  if (mass.part === "podium") return shade(baseColor, 0.94);
  if (mass.part === "body") return shade(baseColor, 0.97);
  return baseColor; // tower / setback
}

/**
 * 计数怎么读（**三态判词纪律**，页面/HUD 都走这一个函数，别各写一遍）：
 *   · 正数 ⇒ 真的生成了这么多；
 *   · `0（已量）` ⇒ 确实量到 0（**绝不裸写 "0"**，免得和"没数"混淆）；
 *   · `数不出来` ⇒ 没拿到统计 / 字段不是有限数。
 */
export function fmtCount(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "数不出来";
  if (n === 0) return "0（已量）";
  return String(n);
}

/** `?bld=2` 的一行回证（HUD/徽标抬头）。**三态**：数不出来 / 低档已关 / 未开（基准版）/ 逐项数字 */
export function shapeCountsLine(c: Partial<ShapeCounts> | null | undefined): string {
  if (!c) return "形体细节：数不出来（没拿到统计）";
  if (c.low) return "形体细节：低档已关（裙楼/退台/女儿墙/设备箱都不生成）";
  if (c.mode !== "detail") return "形体细节：未开（bld=1 基准版：只有主体/压顶/天线）";
  const eqSkip = Number(c.equipSkipped);
  const eqExtra = Number.isFinite(eqSkip) && eqSkip > 0 ? `（另 ${eqSkip} 个放不下）` : "";
  const skipWhy = c.skipped ? `（如 ${String(c.skippedWhy || "未记录原因").slice(0, 40)}）` : "";
  return (
    `形体细节：裙楼 ${fmtCount(c.podium)} · 塔楼 ${fmtCount(c.tower)} · 退台 ${fmtCount(c.setback)}` +
    ` · 女儿墙 ${fmtCount(c.parapet)} · 设备箱 ${fmtCount(c.equip)}${eqExtra}` +
    ` · 跳过纸片楼 ${fmtCount(c.skipped)}${skipWhy} · 要素 ${fmtCount(c.parts)}`
  );
}

/** 徽标里展开的逐行回证（`k` 名称 / `v` 值 / `why` 这一项在说什么） */
export function shapeCountRows(c: Partial<ShapeCounts> | null | undefined): Array<{ k: string; v: string; why: string }> {
  if (!c) return [{ k: "统计", v: "数不出来", why: "没拿到 decorateBuildings 的计数" }];
  if (c.low) {
    return [
      { k: "档位", v: "低档（perfLow / ?low=1）", why: "只画主体 + 描边" },
      { k: "细节", v: "已关", why: "裙楼/退台/女儿墙/设备箱/窗格都不生成（保帧率）" },
    ];
  }
  if (c.mode !== "detail") {
    return [
      { k: "档位", v: "基准版（bld=1）", why: "只有主体/压顶/天线 —— 想看新形体请加 ?bld=2" },
      { k: "楼栋", v: fmtCount(c.n), why: "这一屏取到的楼栋数（不是要素数）" },
      { k: "要素", v: fmtCount(c.parts), why: "真正画出去的要素数" },
    ];
  }
  return [
    { k: "档位", v: "普通（detail）", why: "裙楼/塔楼 + 退台 + 女儿墙 + 设备箱 + 天线" },
    { k: "楼栋", v: fmtCount(c.n), why: "这一屏取到的楼栋数（不是要素数）" },
    { k: "裙楼", v: fmtCount(c.podium), why: `脚印 ≥${PODIUM_MIN_AREA_M2}m² 且 h ≥${PODIUM_MIN_H}m 才切` },
    { k: "塔楼", v: fmtCount(c.tower), why: `塔楼相对裙楼内缩 ${Math.round((1 - PODIUM_INSET) * 100)}%` },
    { k: "退台", v: fmtCount(c.setback), why: `h ≥${SETBACK_MIN_H}m 分 2 段 / ≥${SETBACK_TIERS_3_H}m 分 3 段，每段内缩 ${Math.round(SETBACK_INSET * 100)}%` },
    { k: "女儿墙", v: fmtCount(c.parapet), why: `h ≥${PARAPET_MIN_H}m 的楼，屋顶一圈 ${PARAPET_H}m 薄墙` },
    { k: "设备箱", v: fmtCount(c.equip), why: `按楼顶面积 1~3 个；另有 ${fmtCount(c.equipSkipped)} 个放不下` },
    { k: "天线", v: fmtCount(c.antenna), why: `h ≥${ANTENNA_MIN_H}m` },
    { k: "跳过纸片楼", v: fmtCount(c.skipped), why: `脚印 <${SLIVER_AREA_M2}m² 或长宽比 >${SLIVER_ASPECT}（跳过细节，只留主体）${c.skippedWhy ? "；如 " + c.skippedWhy : ""}` },
    { k: "要素", v: fmtCount(c.parts), why: "画出去的要素总数（含主体/裙楼/塔楼/退台/女儿墙/设备箱/天线）" },
  ];
}

/** 窗格图案（RGBA 像素；`map.addImage(id, {width,height,data})` 直接吃） */
export interface WindowPattern {
  size: number;
  wall: string;
  pane: string;
  cols: number;
  rows: number;
  /** 长度 `size*size*4` 的 RGBA（**纯函数产物** ⇒ Node 里可以逐像素断言，不需要 canvas） */
  data: number[];
}

/** 十六进制色 → [r,g,b]（`#rgb` 与 `#rrggbb` 都认；认不出来给白，别抛） */
export function hexRgb(hex: string): [number, number, number] {
  let s = String(hex || "").trim().replace("#", "");
  if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!;
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 生成 32×32 的**窗格图案**（④）。**纯函数**，不需要 canvas、不引 sprite 服务器。
 *
 * 为什么直接产 RGBA 而不是"页面上用 canvas 画"：canvas 在 Node 里跑不了 ⇒ 图案就**没法自检**。
 * 现在图案是纯数据，自检可以逐像素断言（角上是墙色、每格中心是窗色、窗台比窗暗），
 * 页面那边只是把它塞进 `map.addImage()`。
 *
 * 配色**从主题色阶派生**（调用方传 `wall`/`pane`，页面传的是 `rampColorOf()` + `shade()` 的结果）
 * ⇒ 不引入第二套配色。
 */
export function windowPatternSpec(wall: string, pane: string, size = WIN_PATTERN_SIZE, cols = 4, rows = 4): WindowPattern {
  const w = hexRgb(wall);
  const p = hexRgb(pane);
  const sill = hexRgb(shade(pane, 0.8));
  const data: number[] = new Array(size * size * 4);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    const i = (y * size + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, w);
  const cw = Math.floor(size / cols);
  const ch = Math.floor(size / rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cw + 1;
      const y0 = cy * ch + 1;
      for (let y = y0; y < y0 + Math.max(1, ch - 3); y++) {
        for (let x = x0; x < x0 + Math.max(1, cw - 2); x++) put(x, y, p);
      }
      /* 窗台：每格底部一行压暗 ⇒ 远景一片窗格时才有"层"的感觉 */
      for (let x = x0; x < x0 + Math.max(1, cw - 2); x++) put(x, Math.min(size - 1, y0 + Math.max(1, ch - 3)), sill);
    }
  }
  return { size, wall, pane, cols, rows, data };
}
