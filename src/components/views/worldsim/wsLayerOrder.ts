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
/**
 * 🌆 **足迹层 id**（2026-10-03「按 zoom 分层」：`z < 14` 时屏上的"楼"就是这一层，`fill` 贴地平面）。
 *
 * 为什么路网的自愈要知道它：足迹是**地面上的肌理**，被它盖住 = 一层半透明脏膜（机主原话：
 * 足迹不许压住路网）。而"路网先插、楼体后插"的顺序下（页面实测到过），`bld-foot` 会落在路网
 * **之上**，此时老判据（只看 `bld-ext` / tf）认为"已经是对的"⇒ **不会自愈** ⇒ 真机上是脏的。
 * ⇒ 它和 `BUILDING_LAYER_ID` 一起构成路网的层序约束：**足迹 < 路网 < 设施 < 楼体**。
 */
export const FOOTPRINT_LAYER_ID = "bld-foot";
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
  const footIdx = idx(FOOTPRINT_LAYER_ID);
  const blockers: string[] = [];
  const lowestTf = tfIdx.length ? Math.min(...tfIdx) : -1;
  if (lowestTf >= 0 && firstRoad > lowestTf) blockers.push("交通设施");
  if (bldIdx >= 0 && firstRoad > bldIdx) blockers.push("楼体");
  /* 🌆 2026-10-03：路网还必须**压在足迹层之上**（`bld-foot` 是贴地平面 ⇒ 盖住路网就是脏膜）。
     判据与上面两条同式（索引更小 = 更靠下）；只有足迹层在挡时也走下面同一套 `before` 计算。 */
  if (footIdx >= 0 && firstRoad < footIdx) blockers.push("足迹层");
  if (!blockers.length) return ops; // 已经是对的 ⇒ **不动**（避免无谓的 moveLayer 抖动）
  /* 显式移动：移到"最下面那个阻挡者"之前 */
  let before = "";
  if (lowestTf >= 0 && bldIdx >= 0) before = lowestTf < bldIdx ? ids[lowestTf]! : ids[bldIdx]!;
  else if (lowestTf >= 0) before = ids[lowestTf]!;
  else if (bldIdx >= 0) before = ids[bldIdx]!;
  /* 只有足迹层在挡（没有楼体层、也没有设施）⇒ 锚点取**足迹层之上最近的那一条**。
     🔴 取不到就**不动**：老代码那一支会算出 `undefined`，而 `before: undefined` 的语义是
     "移到最上"—— 那比"留在原地"更糟（路网跑到所有东西上面）。 */
  else if (footIdx >= 0) before = ids[footIdx + 1] || "";
  if (!before) return ops;
  for (const id of roads) ops.push({ op: "move", id, before, why: `路网被「${blockers.join("+")}」压在上面 ⇒ 显式移到它之下` });
  return ops;
}

/** 自愈计数的一句话（HUD/回证用） */
export function layerOrderHud(heals: number, roads: number): string {
  return `🛣 ${roads} 条 · 层序自愈 ${heals} 次`;
}

/**
 * 🛣 **路网计数的三态判据**（纯函数）—— 2026-09-22 机主抓到我们**误报**：
 * HUD 写着 `🛣 0 条 · 图层 12 个 · "路网没画上"`，而画面上**路明明看得见**
 * （12 = 6 个等级 × casing+line ⇒ 图层确实都插上了）⇒ 是 `visibleRoadCount()` **数不出来**，
 * 不是"没画上"。**误报比不报更糟**（会把人带偏）。
 *
 * 三态（不许混）：
 *   · `missing` = 真没插（无 source 或路网图层 0 个）—— 这才是"路网没画上"；
 *   · `unknown` = 图层在但**可见要素 0** ⇒ **数不出来**（写清用哪种口径、瓦片加载没有）；
 *   · `ok`      = 可见要素 > 0 ⇒ 正常报数。
 */
export interface RoadCountVerdict {
  state: "missing" | "unknown" | "ok";
  /** 数出来就是数字；`null` = **数不出来**（HUD 要显示"数不出来"，**不许写 0**） */
  n: number | null;
  /** 用的哪种口径（`rendered` = 屏幕可见要素；`source` = 数据源要素；`unknown` = 都没拿到） */
  gauge: "rendered" | "source" | "unknown";
  why: string;
}

export function roadCountVerdict(input: {
  hasSource: boolean;
  layerCount: number;
  /** `map.queryRenderedFeatures({layers:[…road line…]})` 的条数；拿不到传 null */
  rendered: number | null;
  /** `map.querySourceFeatures("roads")` 的条数（**瓦片未加载时会是 0**）；拿不到传 null */
  source: number | null;
  /** 瓦片是否已加载（`map.areTilesLoaded?.()`）；不知道传 null */
  tilesLoaded?: boolean | null;
}): RoadCountVerdict {
  if (!input.hasSource || input.layerCount === 0) {
    return {
      state: "missing",
      n: 0,
      gauge: "unknown",
      why: input.hasSource ? "路网图层 0 个 ⇒ **确实没画上**" : "没有 roads source ⇒ **确实没画上**",
    };
  }
  if (typeof input.rendered === "number" && input.rendered > 0) {
    return { state: "ok", n: input.rendered, gauge: "rendered", why: "屏幕可见要素（queryRenderedFeatures）" };
  }
  if (typeof input.source === "number" && input.source > 0) {
    return { state: "ok", n: input.source, gauge: "source", why: "数据源要素（querySourceFeatures）" };
  }
  /* 图层都在，但两种口径都数不出 > 0 ⇒ **不许写 0**：如实说"数不出来"并交代原因 */
  const tileTxt =
    input.tilesLoaded === true ? "瓦片已加载" : input.tilesLoaded === false ? "**瓦片还没加载完**" : "瓦片状态未知";
  return {
    state: "unknown",
    n: null,
    gauge: "unknown",
    why:
      `图层都在（${input.layerCount} 个）但两种口径都数不出要素（rendered=${String(input.rendered)}、` +
      `source=${String(input.source)}，${tileTxt}）⇒ **数不出来**，不代表没有路`,
  };
}

/** HUD 那一格的文案（三态各自说人话） */
export function roadCountHud(v: RoadCountVerdict, layerCount: number, heals: number): string {
  const nTxt = v.state === "unknown" ? "数不出来" : String(v.n ?? 0);
  const tail = v.state === "missing" ? " · **路网没画上**" : "";
  return `🛣 ${nTxt} 条 · 图层 ${layerCount} 个 · 自愈 ${heals} 次 · 口径=${v.gauge}${tail}`;
}
