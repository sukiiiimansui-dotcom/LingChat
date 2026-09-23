/**
 * wsLayerOrder.ts —— 「**地面设施的层序**」的**纯逻辑**（可在 Node 里用假 map 断言）。
 *
 * ## 为什么有这个文件（2026-09-22 机主的真机回归）
 * 机主两张图对比：`?v=9` 路网很好，`?tf=1`（加了交通设施）**路网不见了**。
 * 我读接线觉得"结构上不该互相挤掉"（路先插在 `bld-ext` 之前、设施后插也在它之前 ⇒ 路在下），
 * 但**真机证据说没了** ⇒ 结论：**不能靠"先插的那一次"保证顺序**，要**事后断言**：
 *   ① 缺 source / 缺图层 ⇒ 补；
 *   ② 都在 ⇒ 用 `moveLayer()` 把路网**显式**移到交通设施之下、楼体之下；
 *   ③ 每次自愈都计数（HUD 显示"自愈 N 次"）⇒ 下次刷新能看出是不是它在自愈。
 *
 * 这里只产出"该做哪些操作"（`LayerOp[]`），**执行交给调用方**（页面用真 map、自检用假 map）——
 * 于是"顺序对不对"这件事能在 Node 里断言，不必等真机。
 */

/** 调用方能提供的最小能力（真 map / 假 map 都行） */
export interface LayerOrderMapLike {
  hasSource(id: string): boolean;
  hasLayer(id: string): boolean;
  /** 现有图层 id（按**自下而上**的绘制顺序） */
  layerIds(): string[];
}

/** 要执行的一步（`add` = 重新补 source+图层；`move` = 显式移到 `before` 之前） */
export interface LayerOp {
  op: "add-roads" | "move";
  /** `move` 用：要移动的图层 id */
  id?: string;
  /** 移到这个图层**之前**（`undefined` = 移到最上，一般不该用） */
  before?: string;
  why: string;
}

/** 交通设施图层 id（与 `wsTransportRules.TF_LAYER_IDS` 一致；这里只用于"排到它们下面"） */
export const TF_LAYER_ID_LIST = ["tf-cross", "tf-drive", "tf-park", "tf-bus", "tf-signal"] as const;
/** 楼体图层 id（路网必须在其下） */
export const BUILDING_LAYER_ID = "bld-ext";
/** 路网图层 id 前缀（`wsRoads.roadLayerSpecs()` 生成） */
export const ROAD_LAYER_PREFIXES = ["road-casing-", "road-line-"] as const;

/** 现有图层里，路网那批（**按绘制顺序**） */
export function roadLayersOf(m: LayerOrderMapLike): string[] {
  return m.layerIds().filter((id) => ROAD_LAYER_PREFIXES.some((p) => id.startsWith(p)));
}

/**
 * 计划"怎么保证路网在交通设施与楼体之下"（**纯函数**）。
 *
 * 返回的 `ops` 按顺序执行即可；**空数组 = 已经是对的**（这时 HUD 的自愈计数不该涨）。
 */
export function planEnsureRoadOrder(m: LayerOrderMapLike): LayerOp[] {
  const ops: LayerOp[] = [];
  const roads = roadLayersOf(m);
  if (!m.hasSource("roads") || !roads.length) {
    /* source 或图层缺失 ⇒ **补**（自愈；不猜为什么没了，先让它对） */
    return [{ op: "add-roads", why: m.hasSource("roads") ? "路网图层缺失 ⇒ 重新补层" : "roads source 缺失 ⇒ 重建" }];
  }
  const ids = m.layerIds();
  const idx = (id: string): number => ids.indexOf(id);
  /** 路网第一条的绘制位置（越小越靠下） */
  const firstRoad = Math.min(...roads.map(idx));
  /* 目标：路网必须在**所有**交通设施之前（更靠下）——按绘制顺序 = 索引更小 */
  const tfIdx = TF_LAYER_ID_LIST.map(idx).filter((i) => i >= 0);
  const bldIdx = idx(BUILDING_LAYER_ID);
  const blockers: string[] = [];
  const lowestTf = tfIdx.length ? Math.min(...tfIdx) : -1;
  if (lowestTf >= 0 && firstRoad > lowestTf) blockers.push("交通设施");
  if (bldIdx >= 0 && firstRoad > bldIdx) blockers.push("楼体");
  if (!blockers.length) return ops; // 已经是对的 ⇒ **不动**（避免无谓的 moveLayer 抖动）
  /* 显式移动：移到"最下面那个阻挡者"之前 */
  let before = "";
  if (lowestTf >= 0 && bldIdx >= 0) before = lowestTf < bldIdx ? ids[lowestTf]! : ids[bldIdx]!;
  else if (lowestTf >= 0) before = ids[lowestTf]!;
  else before = ids[bldIdx]!;
  for (const id of roads) ops.push({ op: "move", id, before, why: `路网被「${blockers.join("+")}」压在上面 ⇒ 显式移到它之下` });
  return ops;
}

/** 自愈计数的一句话（HUD/回证用） */
export function layerOrderHud(heals: number, roads: number): string {
  return `🛣 ${roads} 条 · 层序自愈 ${heals} 次`;
}
