/**
 * wsTransportLayer.ts —— 交通设施的「**画到地图上**」这一步（2026-09-24）。
 *
 * ## 为什么把它抽出来（**唯一真源**这条纪律）
 * 生成逻辑（`wsTransport.buildTransport`）与规则/样式（`wsTransportRules`）本来就只有一份，
 * 但"**把结果变成 source + 图层**"这件事原来是**代拍页 `ws3dshow.html` 里手写的**
 * （约 30 行：按 kind 分组 → 拼 GeoJSON → addSource/addLayer）。
 * 本轮 App 也要这一屏（机主：「App 的世界模拟 = 代拍页那一屏」）——
 * 如果 App 再抄一遍，就正好落进本项目反复栽的坑：**同一件事两份实现，慢慢漂**。
 *
 * ⇒ 这里只做"**纯的函数**"：
 *   · `tfGeojsonFor(res, kind)`：生成结果 → 该类别的 GeoJSON（**纯函数**，能进 Node 自检）；
 *   · `tfLayerAddsFor(map, res, beforeId)`：算出该 addLayer 哪些层（**纯函数**，不碰 map）；
 *   · `drawTransport()`：唯一会 **动 map** 的那一步（删旧层 → 建新层），App 与代拍页共用。
 *
 * ## 三条不许越界的纪律
 * ① **不写第二套规则/样式/配色**：一律读 `wsTransportRules`（`TF_LAYER_IDS` / `TF_LAYER_STYLE`）
 *    与 `wsTransport`（`buildTransport` / `transportHudLine`）。
 * ② **产物是「示意，非事实」**：这里不生成任何点位，点位全部来自 `buildTransport`；
 *    HUD 那一行必须带「示意」，否则不许显示（见 `transportHudLine`）。
 * ③ **不自己取数**：路网/楼栋由调用方给（App 从 `WsDistrictMapLibre` 拿、代拍页从自己的路网取）——
 *    这样"取数"只有一个地方，也不会把 Overpass 打两遍。
 *
 * 低档（`perfLow`）只画 `TF_LOW_TIER_KINDS` 两类（保帧率）—— 名单也读规则文件，不在这里另写。
 */
import { buildTransport, transportHudLine, type TfResult } from "./wsTransport";
import { TF_LAYER_IDS, TF_LAYER_STYLE, TF_LOW_TIER_KINDS, type TfBuilding, type TfKind, type TfRoad } from "./wsTransportRules";

/** 交通设施的类别顺序（**绘制顺序**：斑马线 → 出入口 → 停车场 → 公交站 → 红绿灯） */
export const TF_KIND_ORDER: readonly TfKind[] = ["crosswalk", "driveway", "parking", "bus", "signal"];

/** 地图上的最小能力（真 map 与自检用的假 map 都满足；不写 `any`） */
export interface TfMapLike {
  getCenter(): { lng: number; lat: number };
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  addSource(id: string, spec: Record<string, unknown>): void;
  removeLayer?(id: string): void;
  removeSource?(id: string): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
}

/** 路网 GeoJSON（只用到 features；与 `/api/roads` / `worldMapApi.roads()` 同一个形状） */
export interface TfRoadsFc {
  features?: Array<{
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  }>;
}

/** 楼栋 GeoJSON（`WsDistrictMapLibre` 里那份 `BldFeature[]` 也满足） */
export interface TfBuildingsFc {
  features?: Array<{
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  }>;
}

/** 一类设施 → 一个 GeoJSON（**纯函数**：同样的输入必然同样输出，可在 Node 里断言） */
export function tfGeojsonFor(
  res: TfResult,
  kind: TfKind
): { type: "FeatureCollection"; features: Array<Record<string, unknown>> } | null {
  const feats = (res?.features || []).filter((f) => f.kind === kind);
  if (!feats.length) return null; // 这一类没有 ⇒ **不建空层**（省一次 source/图层）
  return {
    type: "FeatureCollection",
    features: feats.map((f) =>
      f.to
        ? {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [f.at, f.to] },
            properties: { why: f.why },
          }
        : {
            type: "Feature",
            geometry: { type: "Point", coordinates: f.at },
            properties: { why: f.why, name: f.name || "", n: f.count || 0 },
          }
    ),
  };
}

/** 这一类该建的图层（**纯函数**：只读规则文件的 id 与样式，不碰 map） */
export function tfLayerAddsFor(
  res: TfResult,
  kind: TfKind
): { id: string; spec: Record<string, unknown> } | null {
  const gj = tfGeojsonFor(res, kind);
  if (!gj) return null;
  const style = TF_LAYER_STYLE[kind];
  const id = String(TF_LAYER_IDS[kind]);
  return { id, spec: { id, type: style.type, source: id, paint: style.paint } };
}

/**
 * 按规则从"路网 + 楼栋"算出设施（**只是包一层**，规则/生成逻辑都在 `wsTransport`）。
 * 存在这个包装的唯一理由：调用方不必知道 `toRoad/toBld` 这些字段怎么摊平。
 */
export function buildTransportFor(
  roads: TfRoadsFc | null,
  buildings: TfBuildingsFc | null,
  center: [number, number],
  low = false
): TfResult {
  const toRoad = (f: NonNullable<TfRoadsFc["features"]>[number]): TfRoad => ({
    pts: (f?.geometry?.coordinates as Array<[number, number]>) || [],
    cls: Number(f?.properties?.class) || undefined,
    name: typeof f?.properties?.name === "string" ? f.properties.name : undefined,
  });
  const toBld = (f: NonNullable<TfBuildingsFc["features"]>[number]): TfBuilding => {
    const g = f?.geometry || {};
    const ring = (g.type === "Polygon" ? (g.coordinates as Array<Array<[number, number]>>)?.[0] : []) || [];
    const kind = (f?.properties?.building ?? f?.properties?.kind ?? "") as string;
    return { ring: ring as Array<[number, number]>, kind: String(kind || "") };
  };
  const roadList = (roads?.features || []).map(toRoad).filter((r) => r.pts.length >= 2);
  const bldList = (buildings?.features || []).map(toBld).filter((b) => b.ring.length >= 3);
  return buildTransport(roadList, bldList, center, low);
}

/**
 * **唯一会动地图的那一步**：把交通设施画到 `beforeId` 之前（默认楼体 `bld-ext` ⇒ 设施在楼之下）。
 *
 * 幂等：同一类别反复调用时**先删旧层再建**（`moveend` 会重画，不删就会叠出一堆同 id 图层）。
 * 返回 HUD 那一行原文（**调用方必须显示它**：里面有「示意，非事实」与各计数）。
 */
export function drawTransport(
  map: TfMapLike,
  res: TfResult,
  beforeId?: string
): { hud: string; drawn: number; layerIds: string[] } {
  const layerIds: string[] = [];
  for (const kind of TF_KIND_ORDER) {
    const id = String(TF_LAYER_IDS[kind]);
    try {
      if (map.getLayer(id)) map.removeLayer?.(id);
    } catch {
      /* 没有这一层（或实现没有 removeLayer）⇒ 直接往下建 */
    }
    try {
      if (map.getSource(id)) map.removeSource?.(id);
    } catch {
      /* 同上：删不掉不阻塞重建 */
    }
    const add = tfLayerAddsFor(res, kind);
    if (!add) continue;
    map.addSource(add.id, { type: "geojson", data: tfGeojsonFor(res, kind) });
    map.addLayer(add.spec, beforeId);
    layerIds.push(add.id);
  }
  return { hud: transportHudLine(res), drawn: res?.features?.length || 0, layerIds };
}

/** 低档要不要砍到只剩两类（名单读规则文件；调用方拿它传给 `low`） */
export function tfKindAllowed(kind: TfKind, low: boolean): boolean {
  return !low || TF_LOW_TIER_KINDS.includes(kind);
}

/**
 * 路网**层序事后断言**的执行半边（纯逻辑在 `wsLayerOrder.planEnsureRoadOrder`）。
 *
 * 为什么 App 也要跑它：代拍页 2026-09-22 的真机回归就是"加了 `?tf=1` 之后**路网不见了**"——
 * 交通设施插进来之后，光靠"先插的那一次"不能保证顺序。App 现在走同一条装配路，
 * ⇒ 同一条保险也要有，并且**如实报自愈次数**（不报就等于没做）。
 *
 * ⚠️ `add-roads` 这一步这里**只计数、不重取路网** —— 取数是 `WsDistrictMapLibre` 的职责，
 * 越权重取会把 Overpass 打第二遍（它下一次 `moveend` 会自己补回来）。
 */
export function executeLayerOps(
  map: TfMapLike & { moveLayer?(id: string, beforeId?: string): void },
  ops: Array<{ op: string; id?: string; before?: string; why: string }>
): { moved: number; needRoads: number; notes: string[] } {
  let moved = 0;
  let needRoads = 0;
  const notes: string[] = [];
  for (const o of ops) {
    if (o.op === "add-roads") {
      needRoads++;
      notes.push(o.why);
      continue;
    }
    if (o.op !== "move" || !o.id) continue;
    try {
      if (!map.getLayer(o.id)) continue;
      map.moveLayer?.(o.id, o.before);
      moved++;
      notes.push(o.why);
    } catch {
      /* 移不动就保持原样：宁可层序不完美，也不要因此把地图搞崩 */
    }
  }
  return { moved, needRoads, notes };
}
