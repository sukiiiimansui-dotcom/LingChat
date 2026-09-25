// 🏷 **地名 / 楼名标签层（单一真源，纯逻辑）** —— 机主 2026-09-25：「**如何实现楼房及区域名字喵**」。
//
// 🔴 为什么是 DOM 标签而不是 MapLibre 的文字层：
//   我们的样式里 `glyphs` 是**明令禁止**的（`glyphs: undefined` ⇒ 样式校验失败 ⇒ `load` 永不触发、
//   整张地图全白且零报错——项目里栽过）。要中文就得自托管 glyphs PBF 字体 + 生成工具链，
//   体积/依赖都不划算 ⇒ **用 DOM 标签**（先例：`WsAvatarMark.vue` 的名字标签、`WsDistrictMapLibre.vue` 的 domPins）。
//
// 🔴 **铁律（ROUTE.md：画面可以编，事实不许编）**：
//   · 标签只显示**真名字**；没有 `name` 的对象**就不显示**（**不许编**"某某大厦"——编名字 = 给 AI 制造幻觉源）；
//   · 每个标签带 `source: real | sketch`；**喂给判断的只有 real**（`pickLabels` 默认丢掉 sketch）。
//
// 本模块**纯函数**：不碰 DOM、不碰 map ⇒ 页面与 App 共用，且自检不需要 WebGL。

export type LabelKind = "admin" | "place" | "road_trunk" | "road_secondary" | "building";
export type LabelSource = "real" | "sketch";

export interface LabelItem {
  /** 稳定 id（去重用；`kind:osm_id` 形态） */
  id: string;
  kind: LabelKind;
  /** **真名字**（空串 = 不显示，调用方别塞占位符） */
  name: string;
  lng: number;
  lat: number;
  source: LabelSource;
  /** 行政级别（仅 admin 用；区县=3、市=2、省=1）—— 用来在同类里再排序 */
  adminLevel?: number;
  /** 片区类型（仅 place 用）：`suburb/quarter/borough` = **区片**（任何 zoom 都显示），
   *  `neighbourhood` = 小区/街区（z≥11 才显示）。数据不认得的类型**不显示**。 */
  placeType?: string;
}

/** 片区类型分档：**区片**（大范围）vs **小区/街区**（近景） */
export const PLACE_AREA_TYPES: readonly string[] = ["suburb", "quarter", "borough"];
export const PLACE_LOCAL_TYPES: readonly string[] = ["neighbourhood"];
/** 这一档里的类型（不认得的类型 ⇒ 不显示 —— 宁可少显示，不许显示错的东西） */
export function placeTierOf(placeType: string | undefined | null): "area" | "local" | null {
  const t = String(placeType || "").trim().toLowerCase();
  if (PLACE_AREA_TYPES.indexOf(t) >= 0) return "area";
  if (PLACE_LOCAL_TYPES.indexOf(t) >= 0) return "local";
  return null;
}

/** 当前 zoom 允许显示哪几类（**阈值只写在这里**，页面不许再写一份） */
export interface LabelPlan {
  zoom: number;
  admin: boolean;
  place: boolean;
  roadTrunk: boolean;
  roadSecondary: boolean;
  building: boolean;
  /** **区片**名（suburb/quarter/borough）：任何 zoom 都显示（它就是"这是哪一片"） */
  placeArea: boolean;
  /** **小区/街区**名（neighbourhood）：z≥11 才有意义（更近才看得见街区） */
  placeLocal: boolean;
  /** 一次布局最多显示多少个（性能护栏；超了如实报"丢弃"） */
  cap: number;
}

/**
 * 分层规则（机主/父代理 2026-09-25 定的口径）：
 *   · z≤10：只 区县名（admin）+ **区片名**（suburb/quarter/borough）；
 *   · z11~12：+ 主干路名 + **小区/街区名**（neighbourhood）；
 *   · z13+：+ 次干路名 + 楼名（此时片区名和它们**同层竞争**，优先级 行政>主干>次干>**片区**>楼名）。
 */
export function labelPlanFor(zoom: number): LabelPlan {
  const z = Number.isFinite(zoom) ? Number(zoom) : 14;
  return {
    zoom: z,
    admin: true,                        // 行政名任何 zoom 都要（它就是"这是哪儿"）
    /* `place` = "这一档**有没有**片区名可见"。因为**区片**名任何 zoom 都显示 ⇒ 恒 true；
       真正的**分档**在 `labelItemAllowed()` 里按类型判（区片=placeArea / 小区=placeLocal）。 */
    place: true,
    placeArea: true,                    // **区片**名：任何 zoom 都显示（"这是哪一片"）
    placeLocal: z >= 11,                // **小区/街区**名：z≥11 才显示
    roadTrunk: z >= 11,                 // 主干道名
    roadSecondary: z >= 13,             // 次干道名
    building: z >= 13,                  // 楼名（真实数据只有 ~5% 有名字，别期待满屏）
    cap: z >= 16 ? 26 : z >= 13 ? 20 : z >= 11 ? 12 : 6,
  };
}

/** 优先级：行政 > 主干道 > 次干道 > 片区/小区 > 楼名（同位置冲突时取高的） */
export function labelPriorityOf(it: Pick<LabelItem, "kind" | "adminLevel" | "placeType">): number {
  switch (it.kind) {
    case "admin": return 100 + (3 - Math.min(3, Math.max(1, it.adminLevel || 3)));
    case "road_trunk": return 60;
    case "road_secondary": return 40;
    /* 片区：**区片**（suburb/quarter/borough）比**小区**（neighbourhood）高一点点 ——
       两者同属 `place` 档，但视野里同时有"渝中区/上清寺街道"和"某某小区"时，先保大的。
       注意仍然低于次干道（40）—— 父代理定的顺序：行政 > 主干 > 次干 > 片区 > 楼名。 */
    case "place": return placeTierOf(it.placeType) === "area" ? 34 : 30;
    case "building": return 20;
    default: return 0;
  }
}

/**
 * 一个**具体标签**在当前 plan 下允不允许显示（比 `labelKindAllowed` 更细：`place` 还要看**类型档**）。
 * `suburb/quarter/borough` 看 `plan.placeArea`；`neighbourhood` 看 `plan.placeLocal`；
 * 类型不认得（`placeTierOf` 返回 null）⇒ **不显示**（宁可少显示，不许显示错的东西）。
 */
export function labelItemAllowed(it: Pick<LabelItem, "kind" | "placeType">, plan: LabelPlan): boolean {
  if (!labelKindAllowed(it.kind, plan)) return false;
  if (it.kind !== "place") return true;
  const tier = placeTierOf(it.placeType);
  if (tier === "area") return plan.placeArea;
  if (tier === "local") return plan.placeLocal;
  return false;
}

/** 某一类在当前 plan 下允不允许显示 */
export function labelKindAllowed(kind: LabelKind, plan: LabelPlan): boolean {
  switch (kind) {
    case "admin": return plan.admin;
    case "place": return plan.place;
    case "road_trunk": return plan.roadTrunk;
    case "road_secondary": return plan.roadSecondary;
    case "building": return plan.building;
    default: return false;
  }
}

/** 标签在屏幕上的锚点（投影后） */
export interface PlacedLabel {
  id: string;
  kind: LabelKind;
  name: string;
  source: LabelSource;
  priority: number;
  /** 屏幕坐标（像素） */
  x: number;
  y: number;
  /** 估算的盒子（避让用；页面渲染时用它对齐） */
  w: number;
  h: number;
}

export interface PickResult {
  shown: PlacedLabel[];
  /** 候选总数（过了"有名字 + 类别允许 + 在视野内"的筛） */
  candidates: number;
  /** 因为避让被丢的数量 */
  droppedByCollision: number;
  /** 因为超过上限被丢的数量 */
  droppedByCap: number;
  /** 因为**没有名字**而根本没进候选的数量（如实计数：这一条最容易变成"编名字"的诱因） */
  skippedNoName: number;
  /** 因为 `source === "sketch"` 被丢的数量（喂判断的只有 real） */
  skippedSketch: number;
  /** 因为不在视野内被丢 */
  skippedOffscreen: number;
  /** 本次布局是否被上限截断（HUD 要如实写） */
  capped: boolean;
}

const CHAR_W = 6.5;   // 估算：中文约 1em，取 11px 字号下每字 6.5px（只用于避让，不用于排版）

/** 估算标签盒（避让用；与页面 CSS 的 font-size/line-height 口径对应） */
export function labelBox(name: string, kind: LabelKind): { w: number; h: number } {
  const n = Array.from(String(name)).length;
  const pad = kind === "building" ? 6 : 8;
  const h = kind === "admin" ? 18 : 14;
  return { w: Math.max(16, Math.round(n * CHAR_W) + pad), h };
}

/**
 * 挑标签：**边界内 + 有名字 + 类别允许 + 只 real** → 按优先级排序 → **网格碰撞避让** → 上限截断。
 *
 * @param items    候选（来自真实数据：行政名 / 路名 / 楼名 / 片区名）
 * @param project  (lng,lat) → {x,y}（页面传 map.project；自检传桩）
 * @param viewport 画布尺寸（像素）
 */
export function pickLabels(
  items: readonly LabelItem[],
  project: (lng: number, lat: number) => { x: number; y: number },
  viewport: { width: number; height: number },
  plan: LabelPlan,
  opts: { gridPx?: number; margin?: number; allowSketch?: boolean } = {},
): PickResult {
  const grid = Math.max(8, opts.gridPx || 48);
  const margin = Number.isFinite(opts.margin as number) ? Number(opts.margin) : 24;
  const allowSketch = !!opts.allowSketch;
  const out: PickResult = {
    shown: [], candidates: 0, droppedByCollision: 0, droppedByCap: 0,
    skippedNoName: 0, skippedSketch: 0, skippedOffscreen: 0, capped: false,
  };
  const W = Number(viewport && viewport.width), H = Number(viewport && viewport.height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return out;

  const cands: PlacedLabel[] = [];
  for (const it of items) {
    if (!it || String(it.name || "").trim() === "") { out.skippedNoName++; continue; }   // **缺名字不显示，也不编**
    if (!allowSketch && it.source === "sketch") { out.skippedSketch++; continue; }       // 判断用的只有 real
    if (!labelItemAllowed(it, plan)) continue;      // place 还要看类型档（区片 / 小区）
    const pt = project(it.lng, it.lat);
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) { out.skippedOffscreen++; continue; }
    if (pt.x < -margin || pt.y < -margin || pt.x > W + margin || pt.y > H + margin) { out.skippedOffscreen++; continue; }
    const box = labelBox(it.name, it.kind);
    cands.push({
      id: it.id, kind: it.kind, name: String(it.name).trim(), source: it.source,
      priority: labelPriorityOf(it), x: Math.round(pt.x), y: Math.round(pt.y), w: box.w, h: box.h,
    });
  }
  out.candidates = cands.length;
  /* 排序：优先级降序 → 名字长度升序（短的更容易放下）→ id（**稳定**：同输入同输出，不许靠随机） */
  cands.sort((a, b) => (b.priority - a.priority) || (Array.from(a.name).length - Array.from(b.name).length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const occupied = new Set<string>();
  for (const c of cands) {
    if (out.shown.length >= plan.cap) { out.droppedByCap++; out.capped = true; continue; }
    const x0 = Math.floor((c.x - c.w / 2) / grid), x1 = Math.floor((c.x + c.w / 2) / grid);
    const y0 = Math.floor((c.y - c.h / 2) / grid), y1 = Math.floor((c.y + c.h / 2) / grid);
    let hit = false;
    for (let gx = x0; gx <= x1 && !hit; gx++) for (let gy = y0; gy <= y1 && !hit; gy++) if (occupied.has(gx + "," + gy)) hit = true;
    if (hit) { out.droppedByCollision++; continue; }
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) occupied.add(gx + "," + gy);
    out.shown.push(c);
  }
  return out;
}

/** 🏷 从路网要素里取**有名字**的路（离线包 / live 同款形状）—— 同类只留一条（同类名去重） */
export function roadLabelsFrom(features: readonly any[], kindOfRank: (rank: number) => LabelKind): LabelItem[] {
  const seen = new Map<string, LabelItem>();
  for (const f of features || []) {
    const props = (f && f.properties) || {};
    const name = String(props.name || "").trim();
    if (!name) continue;                                    // **没名字就不显示**（不许编）
    const kind = kindOfRank(Number(props.rank));
    if (kind !== "road_trunk" && kind !== "road_secondary") continue;
    if (seen.has(name)) continue;                           // 同名路只留一条（自然去重）
    const coords = (f.geometry && f.geometry.coordinates) || [];
    const mid = coords[Math.floor(coords.length / 2)];
    if (!mid || !Number.isFinite(mid[0])) continue;
    seen.set(name, {
      id: "road:" + name, kind, name, lng: mid[0], lat: mid[1],
      source: "real",                                       // 路网来自真 OSM（离线包/live 都是）
    });
  }
  return [...seen.values()];
}

/** 🏷 从楼房要素里取**有名字**的楼（`/api/buildings` 的 `properties.name`；实测只有 ~5% 有） */
export function buildingLabelsFrom(features: readonly any[]): LabelItem[] {
  const out: LabelItem[] = [];
  for (const f of features || []) {
    const props = (f && f.properties) || {};
    const name = String(props.name || "").trim();
    if (!name) continue;                                    // **缺名字不显示**（编名字 = 幻觉源）
    const g = (f.geometry) || {};
    const ring = (g.coordinates || [])[0] || [];
    if (!ring.length) continue;
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    out.push({
      id: "bld:" + (props.osm_id || f.id || name), kind: "building", name,
      lng: sx / ring.length, lat: sy / ring.length, source: "real",
    });
  }
  return out;
}

/**
 * 🏷 **片区/小区名**（来自离线包 `/placesbundle/<格>.json` 的 `{n,k,p,i}`）。
 * 🔴 **没有名字的不进**（`skippedNoName` 由 `pickLabels` 统一计数；这里直接丢掉，双保险）；
 *    **不认得的 place 类型也不进**（宁可少显示，不许显示错的东西）。
 */
export function placeLabelsFrom(
  list: readonly { n?: string; name?: string; k?: string; kind?: string; p?: number[]; lng?: number; lat?: number; i?: string; id?: string }[],
): LabelItem[] {
  const out: LabelItem[] = [];
  for (const it of list || []) {
    const name = String((it && (it.n !== undefined ? it.n : it.name)) || "").trim();
    if (!name) continue;                                   // **缺名字不显示**（编名字 = 幻觉源）
    const type = String((it && (it.k !== undefined ? it.k : it.kind)) || "").trim().toLowerCase();
    if (placeTierOf(type) === null) continue;               // 不认得的类型不显示
    const lng = it && it.p && Number.isFinite(it.p[0]) ? Number(it.p[0]) : Number((it || {}).lng);
    const lat = it && it.p && Number.isFinite(it.p[1]) ? Number(it.p[1]) : Number((it || {}).lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push({
      id: "place:" + (it.i || it.id || (type + ":" + name)), kind: "place", name,
      lng: lng, lat: lat, source: "real", placeType: type,
    });
  }
  return out;
}

/** 🏷 行政名（区县/市/省）—— 数据来自 DataV 边界接口（8790），页面把名字与驻地坐标喂进来 */
export function adminLabelsFrom(list: readonly { id: string; name: string; lng: number; lat: number; level?: number }[]): LabelItem[] {
  const out: LabelItem[] = [];
  for (const it of list || []) {
    const name = String((it && it.name) || "").trim();
    if (!name || !Number.isFinite(it.lng) || !Number.isFinite(it.lat)) continue;
    out.push({ id: "admin:" + (it.id || name), kind: "admin", name, lng: it.lng, lat: it.lat, source: "real", adminLevel: it.level || 3 });
  }
  return out;
}
