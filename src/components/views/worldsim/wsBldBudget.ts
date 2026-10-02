/**
 * wsBldBudget.ts —— 🏙 **「双预算挑楼」的唯一真源**（2026-10-02）。
 *
 * ## 这是什么（机主 2026-10-02 拍板的那一条）
 * 机主原话（经父代理转述，**照这个做**）：
 *   「**B2 把"每格 4 栋"改成双预算挑楼**（候选=视野内全部楼，预算 = **Σ投影 px² + Σ顶点**，
 *    **固定常量**，`moveend` 重算）。常量自己定，但要在注释里写清**为什么是这个数**。」
 *
 * 被替掉的旧口径：`wsBldPickStore.bldCapForCellDeg()` —— 每 0.05° 格 ≤100 栋，
 * 0.01° 细格按面积等比缩 ⇒ **每格 4 栋**。实测渝中 6 格 2492 栋只画约 24 栋（≈1%），
 * 屏上是"随机丢楼"。本模块把"按个数挑"换成**按代价挑**。
 *
 * ## 代价模型从哪来（不许编，全部可溯源）
 * 外部取经（`world_map/PERF-BUILDINGS-EXTERNAL.md`）里**有官方来源**的两条：
 *  ① 【deck.gl 官方性能指南】渲染时间两项 = **顶点着色器调用数（≈要素数）+ 片元着色器调用数（= 画到的像素总数）**；
 *     并给量级：半径 5px 的点 × 1000 万 = **最多 10 亿次片元调用/帧**、"连新 MacBook Pro 都吃力"；
 *     高 DPI = **4 倍片元**。⇒ **手机上先跪的是填充率**，所以第一个预算按 **px²** 立。
 *  ② 【MapLibre 官方源码·`fill_extrusion_bucket.ts`】每段墙固定 **4 顶点 / 6 索引（2 三角形）**，
 *     屋顶 n 个顶点的环 ⇒ n−2 个三角形；官方 issue 里"一 tile 一 draw call、累计顶点超
 *     `MAX_VERTEX_ARRAY_LENGTH = 2^16−1 = 65535` 才切新 segment"。
 *     ⇒ 【我方推算，与外部文档同式】一栋 **4 顶点**长方形楼 ≈ 墙 4×4 + 屋顶 4 = **20 顶点**
 *       ⇒ 每栋顶点 = `5 × 轮廓点数`（见 `bldRingVertices`）。第二个预算按**顶点**立。
 * ⚠️ 这两条都**不是**实测帧率：本机无头无 WebGL，真机 fps 只有机主能判（外部文档 §5 已如实写明）。
 *
 * ## 为什么是这两个**固定常量**（机主点名的"说清为什么"）
 * **`WS_BLD_BUDGET_PX2 = 400_000`（CSS 像素²）**
 *   · 口径：屏幕空间里"这栋楼可能画到的像素"之和（屋顶投影 + 可见墙面的投影，见 `bldScreenCost`）。
 *   · 锚点：本项目的两个真实视口 —— 宽屏 `932×557 ≈ 519k`、手机宽 `500×772 ≈ 386k`（PROJECT-STATE 实测尺寸）。
 *     取 **400k ≈ 一屏的 0.77~1.04 倍** ⇒ **楼体加起来最多铺满约一屏**：楼体带来的片元开销
 *     在最坏情况下 ≈ 一次全屏 pass —— 与底图栅格/道路**同量级**，不是它的几十倍。
 *   · 留余量：默认机位（z16.4，视野 ≈1.46km×0.87km，渝中密度 ≈342 栋/km²）估出来约 **434 栋 / 12.6 万 px²**
 *     ⇒ 预算是估算值的 **3.2 倍**：**正常视野下这个预算根本不起约束**（这正是"不再随机丢 99%"要的效果），
 *     它只在**拉远**（每栋楼变小、屏上同时几千栋）时才咬住。若它定得刚好卡在默认机位上，
 *     观感会随视野抖动 —— 那是"预算当降级档用"，机主明确不批。
 * **`WS_BLD_BUDGET_VERTS = 40_000`（顶点）**
 *   · 锚点：`65535` 是 MapLibre 切新 segment（= 新 draw call）的硬线，取它的 **61%** 作预算 ⇒
 *     单个 tile 里我们这批楼**不可能**自己把 segment 撑爆（线/水系等其它同源几何也吃同一段余量）。
 *   · 量级：按上面 20 顶点/栋的官方推算，40k 顶点 ≈ **2000 栋**；外部文档实测口径是
 *     "渝中 **2492 栋**全画 ≈ 5 万顶点，**仍 < 65535**、draw call 数不变，GPU 顶点侧是零头"
 *     ⇒ 40k 正好落在**那份调研自己认定的安全量级之内**，且比它小 20%。
 *   · 为什么要有第二个预算：像素预算**管不住顶点**（z12 时一栋楼在屏上只有 1~2px，
 *     12000 栋的 px² 也就 2 万出头，但顶点是 24 万）—— 那是 JS/上传/内存的账，不是填充率的账。
 *
 * ## 确定性（项目纪律）
 * 同一输入（视野 + 楼数据 + 两个常量）⇒ **挑出来的批次逐字节可复现**：
 *   · 没有任何 `Math.random()` / `Date.now()` / 帧率 / 设备能力输入；
 *   · 排序是**全序**：`单位顶点换到的像素`降序 → 像素降序 → `id` 升序（第三键保证不存在"等值不定序"）；
 *   · 输入顺序不影响结果（全序 + 稳定 `Array.sort`），但**同序输入必然同序输出**。
 */

/** Σ投影面积预算（CSS 像素²）—— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_PX2 = 400_000;

/** Σ顶点预算 —— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_VERTS = 40_000;

/** 每段墙固定 4 个顶点（MapLibre `fill_extrusion_bucket` 的 `prepareSegment(4, …)` + 4×`addVertex`） */
export const WS_BLD_VERTS_PER_SEGMENT = 4;

/**
 * 一栋楼的**三角化顶点数**（官方源码口径）：每段墙 4 顶点 + 屋顶每个轮廓点 1 个。
 *
 * @param ringPoints **闭合环的点数**（GeoJSON 首尾同点，所以 4 边形是 5）
 * @returns 顶点数；点太少（<4，不构成面）⇒ 0
 */
export function bldRingVertices(ringPoints: number): number {
  const n = Number(ringPoints);
  if (!isFinite(n) || n < 4) return 0;
  /* 闭合环的最后一点与首点重合 ⇒ 真正的"轮廓顶点"是 n−1 个：
     墙 = (n−1) 段 × 4 顶点、屋顶 = (n−1) 个顶点 ⇒ 5(n−1)。
     对 4 边形：5×4 = **20**，与外部取经里"一栋 4 顶点长方楼 ≈ 20 顶点"逐字对上。 */
  return 5 * (n - 1);
}

/** Web Mercator：**1 CSS 像素代表多少米**（赤道 156543.03392 @ z0，随纬度按 cos 缩） */
export function bldMetersPerCssPixel(zoom: number, lat: number): number {
  const z = isFinite(zoom) ? zoom : 0;
  const la = isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
  return (156543.03392 * Math.cos((la * Math.PI) / 180)) / Math.pow(2, z);
}

/**
 * **竖直方向：1 米楼高 = 多少屏幕像素**（`sin(pitch)` 是俯角带来的压缩）。
 *
 * 为什么要有它：`map.project()` 是**地面**投影，不带高度 ⇒ 墙面的屏幕高度必须自己算。
 * 两页**必须同一把尺子**，所以公式只有这一份（页面经 vendor 调它）。
 */
export function bldPxPerMeter(zoom: number, lat: number, pitchDeg: number): number {
  const mpp = bldMetersPerCssPixel(zoom, lat);
  if (!(mpp > 0)) return 0;
  const p = isFinite(pitchDeg) ? Math.max(0, Math.min(85, pitchDeg)) : 0;
  return Math.sin((p * Math.PI) / 180) / mpp;
}

/** 宿主提供的**屏幕空间投影**（本模块不碰地图对象：纯函数才可离线测） */
export interface BldScreenCtx {
  /** 经纬度 → 屏幕 CSS 像素（宿主给 `map.project` 的包装） */
  project: (lng: number, lat: number) => [number, number];
  /** 1 米楼高 = 多少屏幕像素（`bldPxPerMeter(zoom, lat, pitch)`；页面/HUD 读数也用同一份） */
  pxPerMeter: number;
}

/** 一个候选的一次成本测量结果（**中间量，导出给自检/回证用**） */
export interface BldCost {
  id: string;
  /** 屋顶投影面积（屏幕 bbox 面积，px²；保守上界） */
  roofPx: number;
  /** 可见墙面投影面积（px²）：半周长 × 墙高像素 —— 矩形的可见墙 ≈ 周长一半 */
  wallPx: number;
  /** 总投影面积（px²）= roofPx + wallPx */
  px: number;
  /** 顶点数（官方源码口径：5 × 轮廓点数） */
  verts: number;
  /** 轮廓点数（闭合环长度） */
  ringPoints: number;
  /** 渲染高度（`h3d`，米） */
  h3d: number;
}

/** 取要素的**外环**（后端只产 Polygon；拿不到 ⇒ null，绝不猜一个环出来） */
function outerRingOf(f: unknown): number[][] | null {
  const g = (f as { geometry?: { type?: string; coordinates?: unknown } } | null)?.geometry;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = (g.coordinates as number[][][])[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}

/** 读 `h3d`（渲染高度）；没有 ⇒ 0（墙高 0 ⇒ 只算屋顶面积，**不猜高度**——伪造高度是项目红线） */
function h3dOf(f: unknown): number {
  const p = (f as { properties?: Record<string, unknown> } | null)?.properties || {};
  const h = Number(p.h3d);
  return isFinite(h) && h > 0 ? h : 0;
}

/** 第一个坐标点（外环取不到时的**兜底判视野**用；多边形之外的形状也认） */
function readFirstPoint(f: unknown): number[] | null {
  const c = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
  let cur: unknown = c;
  /* 一路下钻到第一个"两个数"的数组（Polygon / MultiPolygon / 其它都成立） */
  for (let i = 0; i < 6 && Array.isArray(cur); i++) {
    if (typeof cur[0] === "number" && typeof cur[1] === "number") return cur as number[];
    cur = cur[0];
  }
  return null;
}

/**
 * 🧮 **一栋楼的屏幕代价**（唯一的成本函数；挑楼与自检都调它，不许各算一套）。
 *
 * 口径：
 *  · 屋顶 = 投影后屏幕 **bbox 面积**（w×h）—— 对任意形状都是**保守上界**（真面积 ≤ bbox 面积）；
 *  · 墙 = **半周长 (w+h) × 墙高像素**（矩形可见墙 ≈ 周长一半；斜视角下墙面被压扁，取上界）；
 *  · 顶点 = `5 × 轮廓点数`（官方源码口径，见 `bldRingVertices`）。
 *
 * @param f          要素（Polygon）
 * @param ctx        屏幕投影上下文
 * @param [outCost]  可选：把中间量写出来（自检/回证用）
 * @returns 代价；**外环拿不到 ⇒ `null`**（调用方如实计"跳过"，不塞进预算里）
 */
export function bldScreenCost(f: unknown, ctx: BldScreenCtx, outCost?: { v?: BldCost }): BldCost | null {
  const ring = outerRingOf(f);
  if (!ring) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    let xy: [number, number];
    try { xy = ctx.project(lng, lat); } catch { continue; }
    const x = Number(xy[0]), y = Number(xy[1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return null; // 一个点都没投影出来
  const w = x1 - x0, h = y1 - y0;
  const h3d = h3dOf(f);
  const ppm = isFinite(ctx.pxPerMeter) && ctx.pxPerMeter > 0 ? ctx.pxPerMeter : 0;
  const roofPx = w * h;
  const wallPx = (w + h) * (h3d * ppm);
  const verts = bldRingVertices(ring.length);
  const cost: BldCost = {
    id: String((f as { id?: unknown } | null)?.id ?? ""),
    roofPx, wallPx, px: roofPx + wallPx, verts, ringPoints: ring.length, h3d,
  };
  if (outCost) outCost.v = cost;
  return cost;
}

/** 视野（与 `wsBuildingPick.PickBounds` 同形：只要这四个 getter，宿主给 `map.getBounds()` 即可） */
export interface BldBudgetBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/** 双预算挑楼的输入（**全部显式**，本模块不读 `window`/`location`/地图对象） */
export interface BldBudgetInput<T> {
  /** 仓库**全量**要素（含视野外）——"画面可以编，事实不许编" */
  features: readonly T[];
  /** 当前视野；不给 ⇒ 拿不到候选（统计里如实报 0 并说明） */
  bounds: BldBudgetBounds | null | undefined;
  /** 屏幕投影上下文（`project` + `pxPerMeter`） */
  screen: BldScreenCtx;
  /** 像素预算（默认 `WS_BLD_BUDGET_PX2`） */
  budgetPx2?: number;
  /** 顶点预算（默认 `WS_BLD_BUDGET_VERTS`） */
  budgetVerts?: number;
  /** 视野内**至少**几栋（机主 2026-09-26：「视野内最少有十栋房」）；0 = 不启用 */
  minInView?: number;
}

/** 双预算挑楼的统计（**HUD 与自检的唯一读数口**；字段全部是有限数/布尔/字符串） */
export interface BldBudgetStats {
  /** 仓库里一共有多少栋（事实口径） */
  total: number;
  /** 落在视野内、且有可用外环的候选数 */
  considered: number;
  /** 视野外的（如实计） */
  outOfView: number;
  /** 视野内但**没有外环**（不是 Polygon / 点数不足）⇒ 进不了成本模型的 */
  noRing: number;
  /** 挑中的栋数 */
  chosen: number;
  /** Σ投影面积（px²，取整） */
  px2: number;
  /** Σ顶点 */
  verts: number;
  /** 像素预算（常量，回证用） */
  px2Budget: number;
  /** 顶点预算（常量，回证用） */
  vertsBudget: number;
  /** 真是被**像素**预算拦住的（否则 false —— 不谎报"预算起作用了"） */
  px2Bound: boolean;
  /** 真是被**顶点**预算拦住的 */
  vertsBound: boolean;
  /** 视野下限（`minInView`） */
  minInView: number;
  /** 为了让视野内够 `minInView` 栋而**破例**补进来的栋数（0 = 没破例） */
  floorAdded: number;
  /**
   * 有没有**超出预算**。正常恒 false；只有一种情况会 true：
   * 视野内候选本身不足 `minInView` 栋之后的**兜底破例**（见 `floorAdded`）。
   * ⚠️ 如实报，不许把它藏进"应该是不会发生的"里。
   */
  overBudget: boolean;
  /** 人话判词（**只由本模块产出**，宿主不许再拼第二份） */
  why: string;
}

export interface BldBudgetOutcome<T> {
  /** 挑中的那批 —— **顺序 = 预算顺序**（不是入参顺序），可逐字节复现 */
  features: T[];
  stats: BldBudgetStats;
}

/**
 * 🏙 **双预算挑楼**（纯函数、无状态、确定性）。
 *
 * 规则（三条，缺一条就不是机主批的那个方案）：
 *  ① **候选 = 视野内全部楼**（不再有"每格 N 栋"）；
 *  ② 按「**单位顶点换到的像素**」降序取（`px/verts`；同值比 `px`，再同比 `id`）——
 *     这是外部取经里那句"按投影面积/顶点成本降序取"的落地：同样一个顶点预算，
 *     先保住**看起来最大**的那批；
 *  ③ 两个预算**都是固定常量**，任一超了就换下一个候选（不是停手：继续找还塞得下的小楼）。
 *     **绝不**按帧率/设备自动缩（机主红线）。
 *
 * 视野下限（`minInView`）：预算扫完之后若不足，按同一顺序**破例补**到下限，并把
 * `floorAdded` / `overBudget` 如实写进统计 —— 机主 2026-09-26 的要求优先于预算，
 * 但**不许**因此谎报"预算成立"。
 */
export function pickBuildingsByBudget<T extends { id?: unknown }>(
  input: BldBudgetInput<T>
): BldBudgetOutcome<T> {
  const feats = input.features || [];
  const budgetPx2 = Number.isFinite(input.budgetPx2 as number) ? Number(input.budgetPx2) : WS_BLD_BUDGET_PX2;
  const budgetVerts = Number.isFinite(input.budgetVerts as number) ? Number(input.budgetVerts) : WS_BLD_BUDGET_VERTS;
  const minInView = Number.isFinite(input.minInView as number) ? Math.max(0, Number(input.minInView)) : 0;
  const b = input.bounds;

  const stats: BldBudgetStats = {
    total: feats.length, considered: 0, outOfView: 0, noRing: 0, chosen: 0,
    px2: 0, verts: 0, px2Budget: budgetPx2, vertsBudget: budgetVerts,
    px2Bound: false, vertsBound: false, minInView, floorAdded: 0, overBudget: false, why: "",
  };

  if (!b) {
    stats.why = "数不出来：没给视野（bounds），挑不出楼";
    return { features: [], stats };
  }
  let w: number, s: number, e: number, n: number;
  try {
    w = Number(b.getWest()); s = Number(b.getSouth()); e = Number(b.getEast()); n = Number(b.getNorth());
  } catch {
    stats.why = "数不出来：读视野失败（getBounds 抛错）";
    return { features: [], stats };
  }
  if (![w, s, e, n].every((v) => isFinite(v))) {
    stats.why = "数不出来：视野不是四个有限数";
    return { features: [], stats };
  }

  /* ① 筛候选（视野内 + 有外环 + 量得出代价）。**按入参顺序**遍历，结果与顺序无关（后面全序排序） */
  type Cand = { f: T; c: BldCost; ratio: number };
  const cands: Cand[] = [];
  for (const f of feats) {
    /* ⚠️ 先判视野、再判能不能算代价 —— 顺序反了会让视野外那些"没有外环"的要素被计进 `noRing`，
       而 `noRing` 的口径是"**视野内**但进不了成本模型的"，报错了等于判词撒谎。 */
    const ring = outerRingOf(f);
    const p0 = ring ? ring[0] : readFirstPoint(f);
    const inView = !!p0 && p0[0]! >= w && p0[0]! <= e && p0[1]! >= s && p0[1]! <= n;
    if (!inView) { stats.outOfView += 1; continue; }
    if (!ring) { stats.noRing += 1; continue; }
    const c = bldScreenCost(f, input.screen);
    if (!c) { stats.noRing += 1; continue; }
    stats.considered += 1;
    const denom = c.verts > 0 ? c.verts : 1;
    cands.push({ f, c, ratio: c.px / denom });
  }

  /* ② 全序排序：单位顶点换到的像素降序 → 像素降序 → id 升序（第三键消除"等值不定序"） */
  cands.sort((A, B) => {
    if (B.ratio !== A.ratio) return B.ratio - A.ratio;
    if (B.c.px !== A.c.px) return B.c.px - A.c.px;
    return A.c.id < B.c.id ? -1 : A.c.id > B.c.id ? 1 : 0;
  });

  /* ③ 贪心填空：任一预算会超 ⇒ 跳过这个候选、继续找塞得下的小楼 */
  const chosen: Cand[] = [];
  const taken = new Array<boolean>(cands.length).fill(false);
  let sumPx = 0, sumV = 0;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    const overPx = sumPx + c.c.px > budgetPx2;
    const overV = sumV + c.c.verts > budgetVerts;
    if (overPx || overV) {
      if (overPx) stats.px2Bound = true;
      if (overV) stats.vertsBound = true;
      continue;
    }
    taken[i] = true;
    chosen.push(c);
    sumPx += c.c.px;
    sumV += c.c.verts;
  }

  /* ④ 视野下限：不足 `minInView` ⇒ 按同一顺序破例补，并**如实记破例** */
  if (chosen.length < minInView) {
    for (let i = 0; i < cands.length && chosen.length < minInView; i++) {
      if (taken[i]) continue;
      const c = cands[i]!;
      taken[i] = true;
      chosen.push(c);
      sumPx += c.c.px;
      sumV += c.c.verts;
      stats.floorAdded += 1;
    }
  }

  stats.chosen = chosen.length;
  stats.px2 = Math.round(sumPx);
  stats.verts = Math.round(sumV);
  stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;

  const bd: string[] = [];
  if (stats.px2Bound) bd.push("像素");
  if (stats.vertsBound) bd.push("顶点");
  stats.why =
    "视野内 " + stats.considered + " 栋（下限 " + minInView + "）⇒ 画 " + stats.chosen +
    " 栋 · Σ投影 " + stats.px2 + "px²/" + budgetPx2 + " · Σ顶点 " + stats.verts + "/" + budgetVerts +
    (bd.length ? " · 预算拦住过：" + bd.join("+") : " · 两个预算都没咬住") +
    (stats.floorAdded ? " · 破例补 " + stats.floorAdded + " 栋（凑视野下限）" : "") +
    (stats.overBudget ? " · ⚠️ 已超预算（下限破例）" : "") +
    (stats.outOfView ? " · 视野外 " + stats.outOfView : "") +
    (stats.noRing ? " · 无外环 " + stats.noRing : "");

  return { features: chosen.map((c) => c.f), stats };
}
