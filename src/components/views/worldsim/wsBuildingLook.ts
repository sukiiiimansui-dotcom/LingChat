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
 * ⚠️ 没匹配上的（含中国 OSM 里最多的裸 `building=yes`）用 **12m**：约 4 层，
 *    是"城区里最不容易出错"的一档（矮了像平房、高了像 CBD，都更假）。
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
  yes: 12,
};

/** 兜底高度（米）：类型不认识时用（见 `KIND_HEIGHT_M` 的说明） */
export const FALLBACK_HEIGHT_M = 12;

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
  const base = KIND_HEIGHT_M[String(p.kind || "yes").toLowerCase()] ?? FALLBACK_HEIGHT_M;
  /* 抖动只跟 osm_id 有关 ⇒ 同一条街每次刷新长得一样（随机会闪，别用随机） */
  const k = hash32(String(p.osm_id || p.name || "x")) % 31; // 0..30
  const jitter = 1 - KIND_JITTER + (2 * KIND_JITTER * k) / 30; // 0.85 ~ 1.15
  const h = Math.max(3, Math.round(base * jitter * 10) / 10);
  return { h: Math.min(MAX_RENDER_H, h), from: "kind" };
}

/**
 * 给整份 FeatureCollection 里每栋楼**补上渲染字段**（`h3d` / `h_from`）。
 *
 * 为什么在 JS 里算好、而不是写在地图库的表达式里：
 * MapLibre 的 paint 表达式**报错是静默的**（写错一个字段名 ⇒ 图层直接不画，控制台偶尔才吭一声）。
 * 在 JS 里算好只有一个好处但很关键：**HUD 上的计数和画面上真正用的高度一定是同一个数**
 * —— 两边各算一次，迟早漂移，而漂移了没人会发现。
 */
export function decorateBuildings(fc: {
  features?: Array<{ properties?: Record<string, unknown> }>;
} | null): {
  features: Array<{ properties?: Record<string, unknown> }>;
  count: { n: number; real: number; levels: number; kind: number };
} {
  const feats = (fc?.features || []) as Array<{ properties?: Record<string, unknown> }>;
  const count = { n: feats.length, real: 0, levels: 0, kind: 0 };
  const out = feats.map((f) => {
    const { h, from } = renderHeight(f.properties);
    count[from]++;
    return { ...f, properties: { ...(f.properties || {}), h3d: h, h_from: from } };
  });
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
export function heightColorExpression(): unknown[] {
  const stops: unknown[] = [];
  for (const [h, c] of HEIGHT_COLOR_RAMP) stops.push(h, c);
  return ["interpolate", ["linear"], ["coalesce", ["get", "h3d"], 8], ...stops];
}
