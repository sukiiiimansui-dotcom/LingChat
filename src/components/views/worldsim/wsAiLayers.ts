/**
 * wsAiLayers.ts —— 把 **AI 精绘的产出**（网格坐标的楼/路/公园/水系）变成**地图图层**。
 *
 * ## 为什么需要它（机主 2026-09-19）
 * 「这个小区怎么是 2d 的，我的 3d 建筑呢喵！」—— 因为 AI 画出来的东西一直落在那块
 * **浮在地图上的 SVG 画布**里（旧草图宿主），而小区级已经换成地图库渲染 ⇒
 * 观感就是"一张白卡片盖在黑暗地图上"，**不是世界的一部分**。
 *
 * 这个模块负责把那些图元**翻译成 GeoJSON**，交给地图库当图层画（楼还能 `fill-extrusion` 挤出 3D）。
 *
 * ## 坐标口径（**必须**和角色钉子一致）
 * 网格坐标 → 经纬度用的是同一套"**区界 bbox 线性示意映射**"（见 `WsDistrictMapLibre.gridToLngLat`）：
 * 看得出"在区的哪个方位"，但**对不上具体街道**（草图本来就没有地理坐标）。
 * ⚠️ 两处映射若漂移，楼和人就会错位 —— 所以这里只写一份，别人都调它。
 */

/** 区界 bbox：`[minLng, minLat, maxLng, maxLat]` */
export type BBox = [number, number, number, number];

/** 网格矩形 → 经纬度环（闭合）。`grid` = 网格边长（默认 28，与草图一致） */
export function gridRectRing(bbox: BBox, grid: number, x: number, y: number, w: number, h: number): number[][] {
  const g = Math.max(2, Math.round(grid || 28));
  const [w0, s0, e0, n0] = bbox;
  const spanX = (e0 - w0) || 1;
  const spanY = (n0 - s0) || 1;
  const lng = (gx: number): number => w0 + (gx / g) * spanX;
  /* 纬度翻转：网格 y 向下、纬度向北（这条一忘，楼就全跑水里去） */
  const lat = (gy: number): number => n0 - (gy / g) * spanY;
  return [
    [lng(x), lat(y)],
    [lng(x + w), lat(y)],
    [lng(x + w), lat(y + h)],
    [lng(x), lat(y + h)],
    [lng(x), lat(y)],
  ];
}

/** 网格线段 → 经纬度线段 */
export function gridSegCoords(bbox: BBox, grid: number, x1: number, y1: number, x2: number, y2: number): number[][] {
  const g = Math.max(2, Math.round(grid || 28));
  const [w0, s0, e0, n0] = bbox;
  const spanX = (e0 - w0) || 1;
  const spanY = (n0 - s0) || 1;
  const lng = (gx: number): number => w0 + (gx / g) * spanX;
  const lat = (gy: number): number => n0 - (gy / g) * spanY;
  return [
    [lng(x1), lat(y1)],
    [lng(x2), lat(y2)],
  ];
}

/**
 * 以某点为**中心**、边长 `m` 米的正方形 bbox —— 纯函数，给"示意街区"当画布。
 *
 * ## 为什么需要它（2026-09-20）
 * 示意层的图元本来是拿**整个区县的 bbox** 当画布的。实测涪陵区 bbox = **74.9km × 70.9km**，
 * 28 格草图铺上去 ⇒ **一格 = 2.7km** ⇒ 一栋"楼"有 2.7 公里宽、十几米高 ——
 * 是一张**薄饼**，不是楼。机主那句"这个 ai 2d 小区好丑"，根子就在这个尺度错。
 * 换成 700m 的方块，一格 ≈ 25m，和真实楼栋同一个量级，才**像楼**、才真的"成片"。
 * ⚠️ 尺度对 ≠ 位置对：位置仍然是**编的**（网格 ↔ 经纬度是线性示意映射），
 *    所以 HUD 必须标"非事实"，这一条不许省。
 *
 * ⚠️ 经度要乘 `cos(纬度)`：同样 1 度经度，越往北越短（涪陵 29.7°N 差 13%）。
 * 高纬度 `cos→0` 会让经度差爆掉 ⇒ 夹一个下限兜底（宁可略大，也不产生 Infinity）。
 */
export function boxAround(lng: number, lat: number, m: number): BBox {
  const dLat = m / 2 / 110540;
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const dLng = m / 2 / (111320 * cos);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** 楼层 → 米（3m/层，与项目其它地方同口径）；没有层数就给一个"看得出是房子"的默认高度 */
export function floorsToMeters(floors: number | string | undefined): number {
  const f = Number(floors);
  if (Number.isFinite(f) && f > 0) return Math.min(300, f * 3);
  return 12;
}

export interface AiItem {
  kind: "building" | "road" | "park" | "water";
  item: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    type?: string;
    name?: string;
    floors?: number | string;
  };
}

export interface AiFeature {
  type: "Feature";
  properties: { kind: string; name: string; floors: number; height: number; ai: true };
  geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "LineString"; coordinates: number[][] };
}

/**
 * 图元列表 → GeoJSON 要素（纯函数，可单测）。
 * 缺字段的图元**直接跳过**（宁可少画，也不画一个位置瞎猜的东西）。
 */
export function aiFeatures(items: readonly AiItem[], bbox: BBox | null, grid = 28): AiFeature[] {
  if (!bbox || !items?.length) return [];
  const out: AiFeature[] = [];
  for (const it of items) {
    const p = it?.item || {};
    const name = String(p.name || "");
    if (it.kind === "road") {
      if (![p.x1, p.y1, p.x2, p.y2].every((v) => Number.isFinite(Number(v)))) continue;
      out.push({
        type: "Feature",
        properties: { kind: "road", name, floors: 0, height: 0, ai: true },
        geometry: { type: "LineString", coordinates: gridSegCoords(bbox, grid, Number(p.x1), Number(p.y1), Number(p.x2), Number(p.y2)) },
      });
      continue;
    }
    if (![p.x, p.y, p.w, p.h].every((v) => Number.isFinite(Number(v)))) continue;
    const w = Math.max(0.15, Number(p.w));
    const h = Math.max(0.15, Number(p.h));
    const floors = Number(p.floors) || 0;
    out.push({
      type: "Feature",
      properties: { kind: it.kind, name, floors, height: floorsToMeters(p.floors), ai: true },
      geometry: { type: "Polygon", coordinates: [gridRectRing(bbox, grid, Number(p.x), Number(p.y), w, h)] },
    });
  }
  return out;
}

export function aiFeatureCollection(items: readonly AiItem[], bbox: BBox | null, grid = 28): {
  type: "FeatureCollection";
  features: AiFeature[];
} {
  return { type: "FeatureCollection", features: aiFeatures(items, bbox, grid) };
}

/**
 * 「最终布局」→ AI 图元列表（纯函数，可单测）。
 *
 * ## 为什么需要它（2026-09-20 补，一个**静默的数据分叉**）
 * `/api/district_stream` 是流式的，**偶尔会丢片段**（网络/解析），
 * 所以后端在 `done` 事件里补了一份**权威布局** `{size, buildings, roads, parks, water}`。
 * 旧草图（SVG）那条路已经用它整份替换（`DistrictPaint.loadLayout`），
 * 但**地图图层吃的 `aiItems` 一直是流式的残缺版** —— 两份数据从此分叉：
 * SVG 上是完整的街区，地图上缺一块，而且**缺哪儿看不出来**（两边都不报错）。
 *
 * 这个函数就是把两者接回同一个源：`done` 一到，`aiItems` 整份换成这份布局。
 * ⚠️ 是**替换**不是合并（与 `loadLayout` 同口径）—— 合并会出现两份重复的楼。
 */
export function aiItemsFromLayout(
  layout:
    | {
        buildings?: AiItem["item"][];
        roads?: AiItem["item"][];
        parks?: AiItem["item"][];
        water?: AiItem["item"][];
      }
    | null
    | undefined
): AiItem[] {
  if (!layout) return [];
  const out: AiItem[] = [];
  const push = (kind: AiItem["kind"], list?: AiItem["item"][]): void => {
    for (const item of list || []) if (item) out.push({ kind, item });
  };
  push("building", layout.buildings);
  push("road", layout.roads);
  push("park", layout.parks);
  push("water", layout.water);
  return out;
}
