// 设施图层（T2-1 step2）的**纯逻辑**：取数后的清洗、筛选、几何换算、空态文案。
//
// 为什么单独一个文件、而不是写在 WsFacilityLayer.vue 里：
//   ① 这些函数**不碰 DOM、不碰网络**，可以被 `~/rikka/Dsh-SYuki/world_map/facilities_layer_selftest.mjs`
//      用 esbuild 打包后直接跑断言（本项目的既定做法，见 weather_selftest_t2.mjs）；
//      写在 SFC 里就只能靠"打开页面看一眼"，那不叫验证。
//   ② 「拿不到数据」是本卡最容易做假的地方（画几个假点谁也看不出来），
//      所以判定与文案必须是**能被测试钉死**的纯函数，而不是散在模板里的三元表达式。
//
// 坐标约定（全文件最重要的一条）：`gx/gy` 是**小区图的格点**，不是经纬度。
// 几何换算走 `letterboxOf`/`gridToBox`（wsActors.ts）——与头像层、车辆层同一套信箱折算，
// **不复制地图渲染逻辑**（卡片明确要求）。

import { letterboxOf, gridToBox, type Letterbox } from "./wsActors";

/**
 * 类型**只定义一份**，放在数据层（`@/api/services/worldMap`）——那里同时定义了三条通路的
 * 返回形状与校验（`assertFacPayload`）。这里用 `import type` 引进来再转出去：
 * 类型导入在编译期被完全擦除，所以本文件仍然**零运行时依赖**（只有上面那行纯数学的 wsActors），
 * 可以被 esbuild 单独打包进 node 跑断言。
 */
import type {
  FacPoint,
  FacTypeMeta,
  FacTypesPayload,
  FacPayload,
  TransitLevelRow,
  TransportStations,
} from "@/api/services/worldMap";

export type { FacPoint, FacTypeMeta, FacTypesPayload, FacPayload, TransitLevelRow, TransportStations };

/** 生活设施 7 类的**展示顺序**（与 `facilities.rs` 的 ALL_TYPES 前 7 项一致） */
export const LIFE_ORDER = [
  "residential",
  "commercial",
  "education",
  "medical",
  "leisure",
  "civic",
  "lodging",
] as const;

/** 交通设施 7 类的展示顺序（ALL_TYPES 后 7 项） */
export const TRANSPORT_ORDER = [
  "bus_stop",
  "subway",
  "parking",
  "gas",
  "train_station",
  "airport",
  "pier",
] as const;

/** 内置兜底元数据：`types` 接口拿不到时**不至于把点画成一片灰**，但会标注为兜底 */
const FALLBACK_META: Record<string, { zh: string; icon: string; color: number[] }> = {
  residential: { zh: "住宅", icon: "🏠", color: [230, 210, 170] },
  commercial: { zh: "商业", icon: "🛒", color: [230, 190, 120] },
  education: { zh: "教育", icon: "🏫", color: [150, 200, 240] },
  medical: { zh: "医疗", icon: "🏥", color: [235, 150, 150] },
  leisure: { zh: "休闲娱乐", icon: "🎡", color: [170, 220, 160] },
  civic: { zh: "市政服务", icon: "🏛️", color: [190, 180, 220] },
  lodging: { zh: "住宿", icon: "🏨", color: [220, 180, 210] },
  bus_stop: { zh: "公交站", icon: "🚌", color: [120, 180, 235] },
  subway: { zh: "地铁站", icon: "🚇", color: [90, 130, 200] },
  parking: { zh: "停车场", icon: "🅿️", color: [150, 160, 175] },
  gas: { zh: "加油站", icon: "⛽", color: [240, 170, 90] },
  train_station: { zh: "火车站", icon: "🚄", color: [200, 130, 130] },
  airport: { zh: "机场", icon: "✈️", color: [160, 200, 220] },
  pier: { zh: "码头", icon: "⚓", color: [110, 165, 200] },
};

/** `[r,g,b]` → `#rrggbb`。越界值夹住（后端理论上不会给，但前端不该把 `-5` 拼进颜色串）。 */
export function cssColor(rgb: unknown): string {
  const [r, g, b] = rgbTriple(rgb);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * `[r,g,b]` → `rgba(r,g,b,a)`。
 *
 * 为什么在 JS 里拼、而不是 CSS 里写 `color-mix(in srgb, var(--c) 22%, transparent)`：
 * `color-mix()` 要 Chrome 111+（2023），而本项目的宿主之一是**安卓 WebView**
 * —— 版本由用户的系统决定，不是我们说了算。老 WebView 上 `color-mix()` 整条声明作废
 * → 填充色直接没了（描边还在，看起来像"半坏"）。拼 rgba 是到处都认的写法。
 */
export function rgbaOf(rgb: unknown, alpha = 0.22): string {
  const [r, g, b] = rgbTriple(rgb);
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0.22;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 取 `[r,g,b]` 三元组，非法值给中性灰（不抛异常：颜色坏了不该让整层不画） */
function rgbTriple(rgb: unknown): [number, number, number] {
  const a = Array.isArray(rgb) ? rgb : [];
  const c = (i: number, d: number) => {
    const v = Number(a[i]);
    if (!Number.isFinite(v)) return d;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return [c(0, 136), c(1, 136), c(2, 136)];
}

/** 类型 → 展示元数据（优先后端 `types`，缺了退回内置表；都没有则给个中性点） */
export function metaOf(
  type: string,
  types?: Record<string, FacTypeMeta> | null
): { zh: string; icon: string; color: string; fill: string; known: boolean } {
  const m = types?.[type];
  if (m && typeof m === "object") {
    return {
      zh: String(m.zh ?? type),
      icon: String(m.icon ?? "•"),
      color: cssColor(m.color),
      fill: rgbaOf(m.color),
      known: true,
    };
  }
  const f = FALLBACK_META[type];
  if (f) {
    return { zh: f.zh, icon: f.icon, color: cssColor(f.color), fill: rgbaOf(f.color), known: true };
  }
  return { zh: type || "未知", icon: "•", color: "#888888", fill: rgbaOf([136, 136, 136]), known: false };
}

/**
 * 清洗后端返回的设施点。**坏点直接丢掉并计数**（不猜、不补），
 * 因为"画一个位置不明的点"比"少画一个点"更糟。
 *
 * 判定：`gx/gy` 必须是有限数且落在 `[0, grid]` 内；`w/h` 缺省 1；
 * `type`/`name` 缺了给空串（只影响图例文案，不影响落点）。
 */
export function cleanPoints(
  raw: unknown,
  grid: number
): { points: FacPoint[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const n = Number.isFinite(grid) && grid > 0 ? grid : 0;
  const out: FacPoint[] = [];
  let dropped = 0;
  for (const it of list) {
    const o = it as Partial<FacPoint> | null;
    if (!o || typeof o !== "object") {
      dropped++;
      continue;
    }
    const gx = Number(o.gx);
    const gy = Number(o.gy);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) {
      dropped++;
      continue;
    }
    // 格点必须在网格内（含右/下边界：占地可能从 grid-w 开始）
    if (n > 0 && (gx < 0 || gy < 0 || gx > n || gy > n)) {
      dropped++;
      continue;
    }
    const w = Math.max(1, Math.round(Number(o.w) || 1));
    const h = Math.max(1, Math.round(Number(o.h) || 1));
    out.push({
      id: String(o.id ?? `${o.type}-${gx}-${gy}`),
      gx,
      gy,
      w,
      h,
      type: String(o.type ?? ""),
      type_zh: o.type_zh ? String(o.type_zh) : undefined,
      name: String(o.name ?? ""),
      icon: o.icon ? String(o.icon) : undefined,
      color: Array.isArray(o.color) ? o.color : undefined,
      group: o.group === "transport" ? "transport" : "life",
      indoor: !!o.indoor,
      cell_meters: Number(o.cell_meters) || undefined,
      dist: Number.isFinite(Number(o.dist)) ? Number(o.dist) : undefined,
    });
  }
  return { points: out, dropped };
}

/** 图层开关状态（面板里的开关直接映射到它） */
export interface FacFilter {
  /** 生活设施总开关 */
  life: boolean;
  /** 交通设施总开关 */
  transport: boolean;
  /** 被单独关掉的类别（key） */
  off: string[];
}

export function defaultFilter(): FacFilter {
  // 默认只开生活设施：交通设施是 T2-2 的交付物，叠在一张小区图上点会很密
  return { life: true, transport: false, off: [] };
}

/** 按开关过滤（**纯函数**：同样的输入永远同样的输出，自检直接钉它） */
export function filterPoints(points: FacPoint[], f: FacFilter): FacPoint[] {
  const off = new Set(f.off || []);
  return points.filter((p) => {
    if (p.group === "transport" ? !f.transport : !f.life) return false;
    return !off.has(p.type);
  });
}

export interface FacRow {
  key: string;
  zh: string;
  icon: string;
  color: string;
  /** 同色的半透明填充（老 WebView 不支持 color-mix，所以在 JS 里拼好） */
  fill: string;
  group: "life" | "transport";
  /** 这一类**当前数据里**有多少个（不是"应该有"多少） */
  count: number;
  on: boolean;
}

/**
 * 图例行：以**后端类型表**为准（拿不到就用数据里出现过的类型），
 * 顺序按 LIFE_ORDER/TRANSPORT_ORDER，未知类型排在最后（不丢，如实列出来）。
 * `count` 数的是**本次数据**里的点，所以"图例说 7 类、地图上只画出 3 类"这种不一致一眼可见。
 */
export function categoryRows(
  points: FacPoint[],
  types: Record<string, FacTypeMeta> | null | undefined,
  f: FacFilter
): FacRow[] {
  const cnt = new Map<string, number>();
  for (const p of points) cnt.set(p.type, (cnt.get(p.type) || 0) + 1);
  const off = new Set(f.off || []);
  const seen = new Set<string>();
  const rows: FacRow[] = [];
  const push = (key: string, group: "life" | "transport") => {
    if (seen.has(key)) return;
    seen.add(key);
    const m = metaOf(key, types);
    rows.push({
      key,
      zh: m.zh,
      icon: m.icon,
      color: m.color,
      fill: m.fill,
      group,
      count: cnt.get(key) || 0,
      on: group === "transport" ? f.transport && !off.has(key) : f.life && !off.has(key),
    });
  };
  for (const k of LIFE_ORDER) push(k, "life");
  for (const k of TRANSPORT_ORDER) push(k, "transport");
  // 后端表里有、但上面两个顺序表没覆盖的类型（将来扩展第 15 类时不会消失）
  for (const k of Object.keys(types || {})) {
    if (!seen.has(k)) push(k, types?.[k]?.group === "transport" ? "transport" : "life");
  }
  // 数据里有、类型表里没有的（后端加了新类型但前端还没更新）
  for (const k of cnt.keys()) if (!seen.has(k)) push(k, "life");
  return rows;
}

/** 一个设施在**信箱盒子**里的像素矩形（中心点 + 尺寸），供绝对定位使用 */
export interface MarkerRect {
  /** 中心 x（盒子 CSS 像素） */
  cx: number;
  cy: number;
  /** 占地像素尺寸（不小于 2px，否则看不见） */
  w: number;
  h: number;
}

/**
 * 格点 → 盒子像素。用的是 `letterboxOf`（与头像层/车辆层同一套折算），
 * **不是**经纬度投影 —— 设施坐标是小区图格点，这点写死在类型里。
 */
export function markerRect(
  p: FacPoint,
  lb: Letterbox,
  grid: number
): MarkerRect {
  const n = Number.isFinite(grid) && grid > 0 ? grid : 0;
  const w = Math.max(1, p.w);
  const h = Math.max(1, p.h);
  // 中心点：占地矩形的中心（不是左上角），否则大设施会整体偏左上
  const c = gridToBox(p.gx + w / 2, p.gy + h / 2, lb);
  // 超出网格的占地裁到边界内（后端不会给，防御性）
  const maxPx = n > 0 ? n * lb.scale : Number.POSITIVE_INFINITY;
  return {
    cx: Math.max(0, Math.min(maxPx, c.x)),
    cy: Math.max(0, Math.min(maxPx, c.y)),
    w: Math.max(2, w * lb.scale),
    h: Math.max(2, h * lb.scale),
  };
}

/** 会不会被信箱留白挤到盒子外（留白区域不该有点） —— 用于"别把点画在画布外"的自检 */
export function insideBox(r: MarkerRect, boxW: number, boxH: number, pad = 1): boolean {
  return (
    r.cx >= -pad && r.cy >= -pad && r.cx <= boxW + pad && r.cy <= boxH + pad
  );
}

/**
 * 要不要在这枚标记上写名字。
 *
 * 照抄 Python `draw_facilities` 的取舍：**格子够大才写**，否则一片字糊在一起。
 * 这里再叠一条"地标类型优先"：学校/医院/机场/火车站/码头这类是玩家真正会去找的，
 * 小区里那一堆住宅/便利店在同尺寸下不写字（它们靠图标+图例就够）。
 *
 * 判据取 `max(w,h)`（任一边够大）而不是 `min`：设施是**长方形**的（学校 3×1、医院 2×1），
 * 用短边判会把"又宽又矮"的楼全判成不该写字 —— 而它们恰恰是最该被找到的那几个。
 *
 * 🔴 阈值 18px 是**实测改出来的**（原写 22px，在手机上等于永远不写字）：
 *    手机横屏（932×430）时地图盒子只有 905×283，`scale = min(905,283)/28 ≈ 10.1 px/格`，
 *    而学校/医院/政府这些地标在 `facilities.rs` 里就是 **2×1 格 = 20.2px** ——
 *    卡在 22px 门槛下 → 整层一个名字都不显示（浏览器实测：`labeled=[]`）。
 *    18px 让"2 格宽的地标"能写字，同时 1×1 的（10px）仍然不写，不会糊成一片。
 */
const LANDMARKS = new Set([
  "education",
  "medical",
  "civic",
  "airport",
  "train_station",
  "pier",
  "subway",
]);

/** 地标写名字的最小屏幕像素（任一边）——手机横屏 2 格宽 = 20.2px，所以要 ≤ 20 */
export const LANDMARK_LABEL_PX = 18;
/** 普通设施写名字的最小屏幕像素：只有 4 格以上（≈40px）才不至于糊在一起 */
export const PLAIN_LABEL_PX = 40;

export function shouldLabel(p: FacPoint, r: MarkerRect, zoom: number): boolean {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const px = Math.max(r.w, r.h) * z;
  if (LANDMARKS.has(p.type)) return px >= LANDMARK_LABEL_PX;
  return px >= PLAIN_LABEL_PX;
}

/** 图层空态/降级态：**如实说清是哪一种**，绝不假装"这里没有设施" */
export interface FacEmpty {
  kind: "loading" | "error" | "empty" | "filtered" | "ok";
  text: string;
  detail?: string;
}

export function emptyState(o: {
  loading?: boolean;
  error?: string;
  total: number;
  shown: number;
  area?: string;
  /**
   * 这一层画的是「什么」（默认「设施」）。
   *
   * 为什么要这个参数：交通图层说「设施数据取不到」不算错、但不够准确 ——
   * 用户看到的是"车站那一层"，就该说"车站数据取不到"。文案精确性是这个项目
   * 反复强调的东西（"取不到"≠"没有"），连名词也不该含糊。
   */
  noun?: string;
}): FacEmpty {
  const n = o.noun || "设施";
  if (o.loading) return { kind: "loading", text: `正在取${n}…` };
  if (o.error) {
    return {
      kind: "error",
      text: `${n}数据取不到`,
      detail: o.error,
    };
  }
  if (o.total === 0) {
    return {
      kind: "empty",
      text: o.area ? `${o.area} 这张图上没有${n}` : `这张图上没有${n}`,
      detail: `后端返回了 0 个点 —— 不是加载失败，是这份布局确实没生成出${n}`,
    };
  }
  if (o.shown === 0) {
    return { kind: "filtered", text: "设施都被开关关掉了", detail: `共 ${o.total} 个，当前显示 0 个` };
  }
  return { kind: "ok", text: "" };
}

/** 总数文案：「共 38 个（生活 30 · 交通 8）」；显示数少于总数时补一句，避免误读成"只有这么多" */
export function totalLine(
  counts: { life: number; transport: number; shown: number }
): string {
  const total = counts.life + counts.transport;
  const parts: string[] = [];
  if (counts.life) parts.push(`生活 ${counts.life}`);
  if (counts.transport) parts.push(`交通 ${counts.transport}`);
  const head = `共 ${total} 个${parts.length ? `（${parts.join(" · ")}）` : ""}`;
  return counts.shown === total ? head : `${head} · 显示 ${counts.shown}`;
}

/**
 * 后端网格与前端网格不一致时的告警文案。
 * 两边对不上时点会整体错位（这才是真 bug），所以**显式说出来**，不闷头画。
 */
export function gridMismatch(grid: unknown, expect: number): string {
  const g = Number(grid);
  if (!Number.isFinite(g) || g <= 0) return "后端没报告网格尺寸，无法核对坐标系";
  if (g === expect) return "";
  return `后端网格 ${g}×${g} ≠ 前端 ${expect}×${expect}，设施点会整体错位`;
}

/**
 * **锚点**来源的中文说明 —— 与"布局来源"是两件事，别混成一句。
 *
 * 为什么必须分开说：可以出现「布局来自草图 + 锚点来自算路起点」这种组合
 * （手机页面调 `transportPlan` 不给 area 时就是这样）。只说"草图"会让人以为
 * 站点位置与地图上那枚图标重合；只说"起点"又看不出布局是哪份。
 */
export function anchorSourceText(src: unknown): string {
  switch (String(src || "")) {
    case "explicit-anchor":
      return "锚点由调用方显式给出";
    case "center":
      return "锚点由「中心点」退半张图算出";
    case "maplib-meta":
      return "锚点取自地图库布局的经纬度";
    case "trip-origin":
      return "锚点取自算路起点（没给地理位置）";
    case "none":
      return "没有锚点";
    default:
      return src ? String(src) : "锚点来源未标注";
  }
}

/** 布局来源的中文说明（面板上如实展示"设施画在哪份布局上"） */
export function sourceText(src: unknown): string {
  switch (String(src || "")) {
    case "maplib":
      return "地图库布局（AI 精绘的那张）";
    case "layout":
      return "调用方传入的布局";
    case "sketch":
      return "本地规则草图（网格与显示一致，AI 精绘后建筑可能不同）";
    default:
      return "未知来源";
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 二、交通设施（T2-2 step2）—— 形状、三级差别、算路吸附状态
 *
 * 为什么放在这个文件里：交通站点与生活设施是**同一份数据结构**（`FacPoint`），
 * 清洗/配色/几何/空态全部复用上面那套；这里只加"交通特有"的三件纯逻辑。
 * ══════════════════════════════════════════════════════════════════ */

/** 站点形状：让"公交 vs 地铁 vs 机场"不用看图标也能一眼分开（卡片要求） */
export type TransitShape = "circle" | "ring" | "square" | "diamond" | "pill" | "plane" | "anchor";

/**
 * 类型 → 形状。选型理由（都是"在 20px 大小下也分得开"的形状）：
 *   · 公交站 = 实心圆（最常见，最不起眼 → 视觉权重最低）
 *   · 地铁站 = 空心圈（与公交同族但中空，城市里成串出现时一眼区分）
 *   · 停车场 = 方块（"P" 的联想，规整）
 *   · 加油站 = 菱形（尖角 = 危险品/服务点）
 *   · 火车站 = 圆角长条（比公交大一号，是地标）
 *   · 机场   = 长条 + 飞机（占地本来就 3×2）
 *   · 码头   = 圆形 + 锚（临水）
 * 后端没登记的类型一律回落到 `circle`（**不丢点**，只是形状没个性）。
 */
export const TRANSIT_SHAPE: Record<string, TransitShape> = {
  bus_stop: "circle",
  subway: "ring",
  parking: "square",
  gas: "diamond",
  train_station: "pill",
  airport: "plane",
  pier: "anchor",
};

export function transitShapeOf(type: string): TransitShape {
  return TRANSIT_SHAPE[type] || "circle";
}

/** 三级对比的一行（在 `TransitLevelRow` 上补"相对上一级多了/少了哪些类型"） */
export interface LevelDiffRow {
  level: string;
  zh: string;
  count: number;
  kinds: string[];
  /** 相对**上一级**新增的类型（小区级没有上一级 → 空） */
  added: string[];
  /** 相对上一级消失的类型（正常配置里不会出现，出现就是配置改了，要看得见） */
  lost: string[];
}

/**
 * 把后端的 `levels` 数组算成"逐级差别"。
 *
 * 为什么需要它：卡片要求"社区级/区县级/城市级要能看出差别"，而后端给的是三组独立的数量+种类。
 * 三个数字并排（8 / 13 / 23）读者还得自己比对；直接告诉他"区县比小区多了地铁、加油站、火车站"
 * 才是"看得出差别"。**只做差集，不猜语义**（新增/消失都如实列，配置改了也藏不住）。
 */
export function levelDiffs(
  levels: TransitLevelRow[] | null | undefined,
  types?: Record<string, FacTypeMeta> | null
): LevelDiffRow[] {
  const rows = Array.isArray(levels) ? levels : [];
  const out: LevelDiffRow[] = [];
  let prev: Set<string> | null = null;
  for (const r of rows) {
    const cur = new Set(Array.isArray(r?.kinds) ? r.kinds : []);
    const added = prev ? [...cur].filter((k) => !prev!.has(k)) : [];
    const lost = prev ? [...prev].filter((k) => !cur.has(k)) : [];
    out.push({
      level: String(r?.level ?? ""),
      zh: String(r?.zh ?? r?.level ?? ""),
      count: Number(r?.count) || 0,
      kinds: [...cur],
      added: added.map((k) => metaOf(k, types).zh),
      lost: lost.map((k) => metaOf(k, types).zh),
    });
    prev = cur;
  }
  return out;
}

/** 三级差别的一句话（面板上用；`→` 串起来） */
export function levelSummary(
  levels: TransitLevelRow[] | null | undefined,
  types?: Record<string, FacTypeMeta> | null
): string {
  const rows = levelDiffs(levels, types);
  if (!rows.length) return "";
  return rows
    .map((r, i) => {
      const head = `${r.zh} ${r.count} 个`;
      if (i === 0) return head;
      const bits: string[] = [];
      if (r.added.length) bits.push(`+${r.added.join("、")}`);
      if (r.lost.length) bits.push(`-${r.lost.join("、")}`);
      return bits.length ? `${head}（${bits.join(" ")}）` : head;
    })
    .join(" → ");
}

/** 算路结果的站点状态：**有没有真的吸附到站点**，如实说 */
export interface PlanStationLine {
  /** `true` = 上下车点落在真实站点上 */
  snapped: boolean;
  text: string;
}

/**
 * 从 `TransportPlan.stations` 生成一行说明。
 *
 * 三种情况分得很清楚（这正是本卡最容易含糊过去的地方）：
 *   · 没有 `stations` 字段 → 后端**没走**站点吸附（旧行为）：上下车点是几何估计的
 *   · 有但没有 `nodes` → 后端走了但一个站点也没生成（布局没空地）→ 同样是几何估计
 *   · 有且有节点 → 吸附成立，并说出用了哪份布局（`source`）与锚点状态（`geo`）
 */
export function planStationLine(stations?: TransportStations | null): PlanStationLine {
  if (!stations) {
    return { snapped: false, text: "上下车点：几何估计（本次算路没启用站点吸附）" };
  }
  const n = Number(stations.count) || (stations.nodes ? stations.nodes.length : 0);
  if (!n) {
    return { snapped: false, text: "上下车点：几何估计（这份布局没有生成出交通站点）" };
  }
  const src = sourceText(stations.source);
  const asrc = anchorSourceText((stations as { anchor_source?: string }).anchor_source);
  const geo = stations.geo === false ? "，本次没给锚点所以站点没有经纬度" : "";
  return {
    snapped: true,
    text: `上下车点吸附到 ${n} 个真实站点（${src}；${asrc}${geo}）`,
  };
}
