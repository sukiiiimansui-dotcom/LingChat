/**
 * wsTransportRules.ts —— **交通设施 v0 预设**（规则 + 样式，**唯一真源**）。
 *
 * ## 为什么单独一个"规则"文件
 * 机主 2026-09-21：「**预设 = 你先画一套**」（不是只写规则文档）。
 * 规则文档是 `~/rikka/Dsh-SYuki/world_map/TRANSPORT-RULES.md`，这里把它变成**能跑的参数**：
 * 生成逻辑（`wsTransport.ts`）与样式（本文件 `TF_LAYER_STYLE`）**都只读这一份** ——
 * 将来 App 与代拍页复用同一套，不再出现"两套参数各自漂移"（本项目栽过好几次）。
 *
 * ## 🔴 铁律（写在这里，免得后来人忘）
 * 这五类**全部是"按规则摆出来的示意位置"，不是实测坐标** ⇒ 界面上必须标
 * 「交通设施 N（示意，非事实）」。**只有 OSM 真站点（地铁/出租/码头）才配称事实**，
 * 而 v0 里它们**一个都不编**（没有真数据就不画）。
 */

/** 道路等级：0 快速路 … 5 步道（与 `/api/roads` 的 `class` 对齐） */
export type RoadClass = 0 | 1 | 2 | 3 | 4 | 5;

/** 生成逻辑要吃的最小输入（结构化，不绑具体数据源：`wsRoads` / `/api/roads` 都能喂） */
export interface TfRoad {
  /** 折线（经纬度）—— `[lng, lat]` 顺序，与 GeoJSON 一致 */
  pts: Array<[number, number]>;
  /** 等级（缺省按 3 = 支路） */
  cls?: number;
  /** 路名（公交站命名取"最近路名 + 站"；没有就用"公交站"） */
  name?: string;
}

/** 楼栋足迹（生成停车场/出入口要面积与边界最近点） */
export interface TfBuilding {
  /** 外环（经纬度，首尾不必闭合；面积按鞋带公式算） */
  ring: Array<[number, number]>;
  /** 用途（`commercial` / `office` 会触发停车场规则；OSM 的 `building=*` 原值） */
  kind?: string;
  /** 名称（可选，只用于标注） */
  name?: string;
}

/** 规则参数（v0 预设；**要调就调这里**，别去生成逻辑里改魔法数） */
export const TF_RULES = {
  bus: {
    /** 只沿 class ≤ 2 的路设站 */
    maxCls: 2,
    /** 站间目标间隔（米）：350~500 ⇒ 生成时用 `spacing` 做步长，落点会因路口吸附而落在区间内 */
    spacing: 420,
    minGap: 350,
    maxGap: 500,
    /** 优先落在**路口 40m 内**：在这个半径内若有路口，就把站点挪过去 */
    preferJunctionM: 40,
    /** 上限（超出**按距离取近**，不随机丢） */
    cap: 20,
  },
  crosswalk: {
    maxCls: 3,
    /** 交叉口的**每个方向**各 1 条 */
    perApproach: 1,
    /** 路口间距 < 80m ⇒ **合并**（同一条斑马线服务两个路口） */
    mergeWithinM: 80,
    cap: 60,
  },
  signal: {
    /** ≥3 条路相交 或 class ≤ 1 相交 ⇒ 设灯 */
    minArms: 3,
    majorCls: 1,
    /** 路口**各角 1 点**（4 个角；三岔口只有 3 个角） */
    perCorner: 1,
    cap: 30,
  },
  parking: {
    /** 楼脚印 ≥ 1500 m² 或 商业/办公 ⇒ 配停车场 */
    minAreaM2: 1500,
    /** 触发停车场的用途（**string[] 而不是字面量元组**：调用方的 kind 是任意字符串，
        不然 `includes(b.kind)` 过不了类型检查 —— 这是类型与运行时语义的正当放宽，不是偷懒） */
    kinds: ["commercial", "office", "retail", "supermarket"] as string[],
    /** 距路 > 60m ⇒ **跳过**（车开不进去的停车场没有意义） */
    maxDistToRoadM: 60,
    /** 车位数按面积算（每车位 25 m²，含通道） */
    m2PerSpace: 25,
    minSpaces: 4,
    maxSpaces: 20,
    cap: 15,
  },
  driveway: {
    /** 楼脚印 ≥ 3000 m² ⇒ 车行出入口 */
    minAreaM2: 3000,
    /** 楼边界最近点 → 最近路，接入线长 4~8m */
    accessMinM: 4,
    accessMaxM: 8,
    cap: 30,
  },
} as const;

/** 各类设施的上限（集中一份：生成逻辑与 HUD 回证都读它，别各写一遍） */
export const TF_CAPS: Readonly<Record<TfKind, number>> = {
  bus: TF_RULES.bus.cap,
  crosswalk: TF_RULES.crosswalk.cap,
  signal: TF_RULES.signal.cap,
  parking: TF_RULES.parking.cap,
  driveway: TF_RULES.driveway.cap,
};

export type TfKind = "bus" | "crosswalk" | "signal" | "parking" | "driveway";

/** 图层 id（顺序即绘制顺序：**路网之上、楼体之下** —— 它们是地面设施） */
export const TF_LAYER_IDS: Readonly<Record<TfKind, string>> = {
  bus: "tf-bus",
  crosswalk: "tf-cross",
  signal: "tf-signal",
  parking: "tf-park",
  driveway: "tf-drive",
}; // 命名与 `TRANSPORT-RULES.md` 一致（页面/App 都读这一份）

/**
 * 图层样式（**只读这一份**）。
 * ⚠️ 颜色取自 `ART-STUDY.md` 的"平涂高调 + 粉紫只做点缀"：
 *   公交/停车场/出入口走**青蓝-白**系，红绿灯用**暖黄**（它本身就该显眼），
 *   粉紫**不用**在交通设施上（留给事件/示意层，避免全屏都在抢眼）。
 */
export const TF_LAYER_STYLE: Readonly<Record<TfKind, { type: string; paint: Record<string, unknown> }>> = {
  bus: {
    type: "circle",
    paint: { "circle-radius": 3.4, "circle-color": "#2F7FD8", "circle-stroke-width": 1.2, "circle-stroke-color": "#FFFFFF" },
  },
  crosswalk: {
    type: "line",
    paint: { "line-color": "#FFFFFF", "line-width": 2.2, "line-opacity": 0.9 },
  },
  signal: {
    type: "circle",
    paint: { "circle-radius": 2.6, "circle-color": "#FFC24B", "circle-stroke-width": 1, "circle-stroke-color": "#1B3550" },
  },
  parking: {
    type: "circle",
    paint: { "circle-radius": 3.0, "circle-color": "#79D9FF", "circle-stroke-width": 1, "circle-stroke-color": "#FFFFFF" },
  },
  driveway: {
    type: "line",
    paint: { "line-color": "#BFE6FF", "line-width": 2.6, "line-opacity": 0.95 },
  },
};

/** 低档（`perfLow`）只画这两类（保帧率）—— 一条常量，页面与 App 都读它 */
export const TF_LOW_TIER_KINDS: readonly TfKind[] = ["bus", "signal"];
