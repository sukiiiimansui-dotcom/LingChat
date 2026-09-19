/**
 * wsRoads.ts —— 路网的**纯逻辑**：把 `/api/roads` 的 GeoJSON 变成"地图上怎么画"。
 *
 * ## 为什么有这个文件（机主 2026-09-20）
 * 「**在地图上把道路和设施全部勾出来**（方便将行人啥的挪出来）」。
 * 在这一刀之前，小区级**根本没有路图层** —— 画面上那点路是**栅格瓦片里的像素**，
 * 拿不到几何；而"把行人挪到路上"要的恰恰是几何（得能算出"最近的路在哪一点"）。
 *
 * ## 两条纪律
 * ① **档次由后端给**（`properties.rank`，见 Rust `osm::road_rank`）。
 *    前端这里只维护"档次 → 线宽/颜色"这一张表 —— 两边各写一份 `match` 迟早漂移；
 * ② 画法要**分级**：主干粗且亮、支路细且暗。全一个粗细的话，一眼看不出路网结构，
 *    "行人该走哪条"也读不出来。
 */

/** 后端给的档次：0 快速路 → 5 步道（`osm::road_rank` 的对应表） */
export type RoadRank = 0 | 1 | 2 | 3 | 4 | 5;

/** 一档的观感：`w` 线宽（px），`color` 主色，`minzoom` 低于它不画 */
export interface RoadRankStyle {
  /** 这一档在地图上的中文名（HUD / 图例用，别让玩家猜"那条粗的是什么路"） */
  label: string;
  w: number;
  color: string;
  /**
   * 低于这个 zoom 就不画。
   * 为什么：整区视野下路网是**一张网**，细路会把画面糊死，也白费要素数
   * （`fill-extrusion`/`line` 的开销都随要素数线性增长）。
   */
  minzoom: number;
}

/**
 * 档次 → 观感。**暗色二次元主题**下的取法：
 * 路要比地面亮（不然看不见），但不能亮过楼（不然喧宾夺主）。
 * 主干用暖白（像路灯带），步道用冷青（像小径），既分得开又不刺眼。
 */
export const ROAD_RANK_STYLE: Record<number, RoadRankStyle> = {
  0: { label: "快速路", w: 4.2, color: "#e8dcc0", minzoom: 11 },
  1: { label: "主干道", w: 3.4, color: "#dfd2b4", minzoom: 11 },
  2: { label: "次干道", w: 2.6, color: "#c8c0ae", minzoom: 12.5 },
  3: { label: "支路", w: 1.8, color: "#a9b3bd", minzoom: 13.5 },
  4: { label: "社区路", w: 1.2, color: "#8fa0b0", minzoom: 14.5 },
  5: { label: "步道", w: 0.8, color: "#79d9ff", minzoom: 15.5 },
};

/** 档次的兜底（后端给了没见过的 rank ⇒ 当支路画，比当主干道安全） */
export const ROAD_STYLE_FALLBACK: RoadRankStyle = ROAD_RANK_STYLE[3]!;

export function roadStyleOf(rank: unknown): RoadRankStyle {
  const r = Number(rank);
  return Number.isFinite(r) ? (ROAD_RANK_STYLE[r] ?? ROAD_STYLE_FALLBACK) : ROAD_STYLE_FALLBACK;
}

/**
 * 一档一条线图层（`line`），加一条**底色描边**压在下面。
 *
 * 为什么描边要单独一层：MapLibre 的 `line` 没有"描边"属性，
 * 行业里的常规做法就是同一份数据画两遍 —— 先画粗的深色当边，再画细的亮色当芯。
 * 少了它，亮色线压在暗底图上会"浮"，看着像贴纸。
 */
export function roadLayerSpecs(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(ROAD_RANK_STYLE).map(Number).sort((a, b) => a - b)) {
    const s = ROAD_RANK_STYLE[key]!;
    out.push({
      id: `road-casing-${key}`,
      type: "line",
      source: "roads",
      minzoom: s.minzoom,
      filter: ["==", ["get", "rank"], key],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0b1017", "line-width": s.w + 1.6, "line-opacity": 0.75 },
    });
  }
  for (const key of Object.keys(ROAD_RANK_STYLE).map(Number).sort((a, b) => a - b)) {
    const s = ROAD_RANK_STYLE[key]!;
    out.push({
      id: `road-line-${key}`,
      type: "line",
      source: "roads",
      minzoom: s.minzoom,
      filter: ["==", ["get", "rank"], key],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": s.color,
        /* 桥隧稍微亮一点：立交/跨江桥在地图上就该比地面路显眼（也是"可走"的强提示） */
        "line-opacity": ["case", ["get", "bridge"], 0.95, ["get", "tunnel"], 0.5, 0.8],
        "line-width": s.w,
      },
    });
  }
  return out;
}

/** 路网统计的一句话（HUD 用）。**如实**：没名字的路要算进去，别只报"主干道几条"。 */
export function roadStatsLine(stats: { count?: number; by_rank?: Record<string, number>; named?: number } | null): string {
  const n = Number(stats?.count) || 0;
  if (!n) return "";
  const by = stats?.by_rank || {};
  const main = (Number(by["0"]) || 0) + (Number(by["1"]) || 0) + (Number(by["2"]) || 0);
  const named = Number(stats?.named) || 0;
  return `${n} 条路（主干 ${main} · 有名字 ${named}）`;
}

/**
 * 「本视野有几条路」——**只数真的看得见的档**。
 *
 * 为什么要按 zoom 过滤：HUD 写"120 条路"而屏幕上只有 3 条主干，那是**骗人**。
 * 计数口径必须和画法口径一致（`minzoom` 一样）。
 */
export function visibleRoadCount(
  fc: { features?: Array<{ properties?: Record<string, unknown> }> } | null,
  zoom: number
): number {
  let n = 0;
  for (const f of fc?.features || []) {
    if (roadStyleOf((f.properties || {}).rank).minzoom <= zoom) n++;
  }
  return n;
}
