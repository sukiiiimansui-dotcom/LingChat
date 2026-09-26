/**
 * wsNameLayer.ts —— 🏷🗺 **名字层**的唯一真源（真名标签 / 区名标签 / 点选喂卡片）。
 *
 * ## 机主原话（2026-09-26，验收标准）
 * 「**我要求每个显示的楼房都要有名字喵**，**如果太密集了就根据类型划定区域（如经济区，美食区）**，
 *  **每个名字和楼房都能点击查看信息**（要求有**精美的 mg 动画**）」
 *
 * ## 三条实测事实决定了这一层的样子（都不是推测）
 * ① **真楼名只覆盖 2.0%**（渝中区 400m：101 栋里 2 栋有名）⇒「每栋都有真名」做不到；
 * ② **48px 网格在 904×341 舞台上只放得下 29 个四字楼名**（cap 26→200 仍是 29）⇒ 每栋挂可见标签放不下；
 * ③ **按类型划区只在 ~1km 粒度成立**（0.05° 上 `food` 过半 0 格、0.01° 上 11 格）
 *    ⇒ 区名聚合粒度 = **0.01° 子格**，取数粒度 = **0.05°**（两者本来就不同，不是"口径不符"）。
 * 机主拍板的口径：**屏上标签只给「真名 + 区名」；生成名只进信息卡**（＊标记 / 单独计数 / 绝不进数据与对话）。
 *
 * ## 这一份管什么（全部规则，一处定义；App 与代拍页都只接线 —— PR 门禁 C1）
 * · **取数**：按视野算 `namesbundle`（真名点）与 `placesbundle`（片区真名）的 **0.05° 格**，
 *   串行取、每格独立超时、包外与失败**分开计**；按格缓存（上限 `NAMES_STORE_CAP`）。
 * · **真名标签**：`wsLabels.pickLabels`（48px 避让网格 + 优先级 + 上限）——**规则不在这里重写**。
 * · **区名标签**：`wsZoneNames.planZoneNames`（真名优先 / 过半才算数据驱动 / 示意另算）+
 *   `createZoneModeGate`（迟滞：0.45 进 / 0.20 退 / 连续 2 次 / 400ms 防抖）。
 * · **密集 ⇒ 切区名**：密集时**小名字（POI）退场**、**大名字（行政区名 / 区片名）留在屏上**、
 *   区名进场 —— 机主要的是「真名 + 区名」，所以真名不会因为密集就全没了。
 * · **点选**：每个节点带 `pick`（原样转交 `wsBuildingCard.buildingCardData`）⇒
 *   点标签与点楼体**是同一张卡**（`DESIGN-MG-MOTION.md` §4.4）。
 * · **动效参数**（`LABEL_MOTION`）：三幕 120/40/200ms + 错峰 25ms、hover 90 / 退让 120 / 复现 160、
 *   相机运动整层 0.25（80ms）→ moveend 复现 160ms、节点阶梯阈值 —— **数字只有这一处**。
 *
 * ## 🔴 红线（写在代码里，谁都别绕）
 * 1. **生成名绝不进数据层、绝不进对话上下文**，本模块**核**了这条：`NameFacts.generatedOnScreen`
 *    是字面量类型 `0` —— 屏上出现的生成名**恒为 0 个**（生成名只出现在点击后的信息卡里）。
 * 2. **真名 / 数据驱动 / 示意**三档**样式必须不同**（`NameRenderNode.style`，宿主按它给 class）。
 * 3. 署名（ODbL）**只念包索引里的原话**（`index.attribution`），取不到写"署名取不到"，不编。
 * 4. 判词三态：**正数 / 0（已量）/ 数不出来（写原因）** —— 0 与"没测出来"永远分得开。
 *
 * ## ⚠️ 两处**必须如实记下来**的现状（不是设计选择，是约束）
 * · `namesbundle` **没有**进 `wsOfflineFeed.SPECS`（那份表归性能线），所以这里的格 URL
 *   用本模块的常量 `NAMES_BUNDLE_DIR` 拼 —— **唯一**一处自己拼包路径的地方，已用自检钉住；
 *   正确收口方式是给 `SPECS` 加一个 `names` 项（`BundleKind` 加一个字面量），那是别人的文件，**已上报**。
 * · `wsLabels` 的种类表是固定的（`admin | place | road_trunk | road_secondary | building`），
 *   **POI 真名**落在"小名字"那一档 ⇒ 借 `building` 档（优先级 20、z≥13 才显示）。
 *   这是"不改别人的文件"下的取舍，**不是**说 POI 是楼 —— `kind` 在这里只决定优先级与 zoom 闸门。
 */

import { bundleCellUrl, fetchWithTimeout, bundlePlacesOf, type BundleFetch, type BundleView } from "./wsOfflineFeed";
import { bundleCellsForView } from "./wsFeatureStore";
import {
  type LabelItem,
  type LabelPlan,
  type PickResult,
  type PlacedLabel,
  adminLabelsFrom,
  buildingLabelsFrom,
  labelPlanFor,
  pickLabels,
  placeLabelsFrom,
} from "./wsLabels";
import {
  WS_ZONE_SUB_DEG,
  type ZoneName,
  type ZoneNamePoint,
  type ZoneRealName,
  createZoneModeGate,
  pickZoneNames,
  planZoneNames,
  zoneAttributionOf,
  zonePointsFrom,
  zoneRealNamesFromPlaces,
} from "./wsZoneNames";

/* ══ ① 常量（**只有这一处**；宿主与自检都不许再写一份） ═════════════════════════════════ */

/** 真名包目录名（见文件头 ⚠️：`SPECS` 里还没有 `names`，这里是唯一自己拼包路径的地方） */
export const NAMES_BUNDLE_DIR = "namesbundle";
/** 真名包自己的格边长（度）—— **取数**单位，与划区的 0.01° 不是一回事 */
export const NAMES_BUNDLE_CELL_DEG = 0.05;
/** 一轮最多取几格（视野内、索引里有、近的先取） */
export const NAMES_MAX_CELLS = 6;
/** 一轮最多发几个请求（真名点 + 片区名 = 每格 2 个请求） */
export const NAMES_PER_REFRESH = 6;
/** 按格缓存上限（格） */
export const NAMES_STORE_CAP = 64;
/** 单格超时（毫秒；与离线包同一个预算） */
export const NAMES_TIMEOUT_MS = 6000;
/** 置信度兜底阈值（索引里 `minConfidenceRecommended` 优先；读不到才用它） */
export const NAMES_MIN_CONF_FALLBACK = 0.5;
/** 屏上最多几个区名（`DESIGN-MG-MOTION.md` §4.1 的"最多 4 个区名"是**入场错峰**口径，这里给 8） */
export const NAMES_ZONE_CAP = 8;
/** 区名模式下同时保留的"大名字"（行政区名 / 区片名）个数 */
export const NAMES_BIG_KEEP = 4;
/** 区名名额里给**真名区**的上限（其余名额留给数据驱动/示意区 —— 见下面的注释） */
export const NAMES_ZONE_REAL_MAX = 4;

/**
 * 标签层动效参数 —— 数字抄 `DESIGN-MG-MOTION.md` §4.1/§4.2/§5，**只此一处**。
 * 判据（自检钉）：全部时长 ∈ {90,120,140,160,200,320,…}；错峰 ∈ {8,25,30}；只动 transform/opacity。
 */
export const LABEL_MOTION = {
  /* 三幕（Fade Through）：楼名退 → 40ms 重叠 → 区名进 */
  nameOutMs: 120,
  overlapMs: 40,
  zoneInMs: 200,
  zoneStaggerMs: 25,
  zoneStaggerMax: 4,
  /* 单体（§4.2）：hover 90 / 松开 140 / 被遮挡退让 120（**不动位置**，只 opacity）/ 复现 160 */
  hoverMs: 90,
  releaseMs: 140,
  retreatMs: 120,
  showMs: 160,
  /* 相机运动（§4.2）：整层淡化 = **只写 1 个节点** */
  cameraMs: 80,
  cameraOpacity: 0.25,
  restoreMs: 160,
  /* 同一个切换批的最短间隔（与 `wsZoneNames.WS_ZONE_SWITCH_MIN_MS` 同值；这里给宿主做去抖） */
  minSwitchMs: 400,
  /* 避让网格与上限（**与 `wsLabels` 同值**：48px 是实测出来的，不许缩） */
  gridPx: 48,
  /* 节点阶梯（§5）：≤12 CSS / 13~26 分批 / 27~60 WAAPI / >60 整层 */
  ladder: { l0: 12, l1: 26, l2: 60 },
  /** `>60` 时换手段（整层淡出→重排→淡入），**不是**缩时长 */
  liteAbove: 60,
  easeEnter: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  easeLeave: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

/** 允许出现在标签动画里的属性（白名单；自检拿它抓"有人偷偷动 left/width"） */
export const LABEL_ANIM_PROPS: readonly string[] = ["transform", "opacity"];

/** 标签的 DOM 契约（宿主按它渲染；探针按它数节点 —— **不靠调试出口**） */
export const LABEL_DOM_CLASS = "ws-lab";
export const LABEL_ROOT_CLASS = "ws-labs";
/** 相机运动期间加在**容器**上的类（整层淡化，只写 1 个节点） */
export const LABEL_CAMERA_CLASS = "is-camera-moving";
export const LABEL_STYLE_CLASS: Record<NameNodeStyle, string> = {
  real: "is-real",
  derived: "is-derived",
  generated: "is-generated",
};

/* ══ ② 宿主接口（App 宿主与代拍页各给一份；规则全在本模块） ═══════════════════════════ */

export interface NameMapLike {
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } | null;
  getZoom(): number;
  project(lngLat: [number, number]): { x: number; y: number };
  getCanvas?(): { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
}

export interface NameLayerHost {
  /** 地图（拿不到 ⇒ 这一轮只算事实、不渲染；**不抛**） */
  map: () => NameMapLike | null;
  /** 取一格（浏览器 = `fetchWithTimeout` 包 `fetch`；自检 = 假实现） */
  fetchCell: BundleFetch;
  /** `?names=0` 这类开关（不传 = 一直开） */
  enabled?: () => boolean;
  /** 行政区名（宿主喂；本 App 在街区级没有名单 ⇒ 传空数组是**如实**的） */
  admins?: () => readonly { id?: string; name?: string; lng?: number; lat?: number; level?: number }[];
  /** **画出去的**楼的 GeoJSON 要素（有 `properties.name` 的才会变成标签）——宿主在 `afterDraw` 里存 */
  drawnBuildings?: () => readonly unknown[];
  /** 置信度阈值（默认取索引里的 `minConfidenceRecommended`） */
  minConf?: () => number | null;
  /** 每一轮算完的回调（宿主写 HUD / 渲染） */
  onPlan?: (plan: NameRenderPlan, facts: NameFacts) => void;
  /** 失败原文（不静默） */
  onError?: (why: string) => void;
  /** 时钟（自检注入；不传 = `Date.now`） */
  now?: () => number;
}

/* ══ ③ 渲染计划（宿主照着画；**位置只在 refresh 那一刻算一次**） ═══════════════════════ */

export type NameNodeStyle = "real" | "derived" | "generated";
export type NameMode = "names" | "zones";

/** 一个标签节点（宿主的节点池按 `slot` 复用 ⇒ 换批只改 textContent/class，**不增删节点**） */
export interface NameRenderNode {
  slot: number;
  id: string;
  /** 屏上文案：真名原样 / 「美食区」/ 「示意·美食」 */
  text: string;
  /** 三档样式（**必须不同**） */
  style: NameNodeStyle;
  /** 是不是示意件（机器可判；屏上样式必须与真名不同） */
  sketch: boolean;
  /** 屏幕像素（moveend 那一刻算好的**终态**；期间只动容器） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 锚点经纬度（相机运动时宿主用它 project 出位移 ⇒ 整层跟手） */
  lng: number;
  lat: number;
  /** 一行依据（tooltip / 面板） */
  why: string;
  /** 点击要转交给 `buildingCardData` 的**主体**（宿主一行转交，不做二次解释） */
  pick:
    | { kind: "place"; place: { n: string; k?: string; c?: string; cf?: number; p: [number, number]; i?: string } }
    | { kind: "zone"; zone: ZoneName }
    | { kind: "building"; buildingId: string; name: string; lng: number; lat: number };
}

export interface NameRenderPlan {
  mode: NameMode;
  /** 节点表（`slot` 从 0 连续编号 ⇒ 宿主的节点池按下标复用） */
  nodes: NameRenderNode[];
  /** 这一批的代号：**变了才需要"先隐后改字"**（宿主据此播三幕） */
  batch: number;
  /** 节点数超过阶梯阈值 ⇒ 换手段（整层淡出→重排→淡入），**不是缩时长** */
  lite: boolean;
  /** 相机运动期间容器目标 opacity（§4.2：整层 1 → 0.25，只写 1 个节点） */
  cameraOpacity: number;
}

/* ══ ④ 事实（HUD / 探针 / 判词；三态） ═══════════════════════════════════════════════ */

export type NameState = "off" | "no-index" | "size-mismatch" | "uncounted" | "counted";

export interface NameFacts {
  state: NameState;
  /** **屏上节点总数**（= 大名字 + 区名；区名模式下与"标签层放置数"不是一个数） */
  labels: number;
  /** **标签层成功放置数**（`pickLabels.shown`）——"显示 / 丢弃(避让) / 超上限"三个数里的"显示" */
  pickedShown: number;
  /** 其中**真名**（POI / 片区 / 行政区 / 有名字的楼） */
  realLabels: number;
  /** 其中**区名**（数据驱动 + 示意） */
  zoneLabels: number;
  /** 区名模式下**留在屏上的"大名字"**（行政区名 / 区片名）个数 —— 与 `zoneLabels` 拆开报 */
  bigLabels: number;
  /** 区名里**数据驱动**（主导类过半）的个数 */
  zoneDerived: number;
  /** 区名里**示意**的个数（屏上样式必须与真名不同） */
  zoneSketch: number;
  /** 🔴 **屏上的生成名个数** —— 字面量 `0`：机主拍板"生成名只进信息卡"，这一条是机器可查的红线 */
  generatedOnScreen: 0;
  /** 避让统计（`pickLabels` 的现成字段；密度信号 = dropped/candidates） */
  candidates: number;
  droppedByCollision: number;
  /** 因为**超过上限**被丢的数量（看板卡要求的第三个可数指标：显示 / 丢弃(避让) / 超上限） */
  droppedByCap: number;
  /** 本次布局是不是被上限截断（`pickLabels.capped` 的透传） */
  capped: boolean;
  skippedNoName: number;
  skippedOffscreen: number;
  /** 密度信号 D = 撞掉 / 候选；**没候选 = null（数不出来，不是 0）** */
  density: number | null;
  /** 当前模式（迟滞闸门判的） */
  mode: NameMode;
  /** 取数：这一轮要几格 / 取到几格 / 包外几格 / 失败几格 */
  cells: number;
  hit: number;
  missing: number;
  failed: number;
  /** 进统计的真名点数（已过 `cf` 阈值） */
  points: number;
  /** 真名点被置信度阈值挡掉几条（如实计数） */
  droppedByConf: number;
  /** 划区走过的子格数 / 够格数 / 过半格数 */
  zoneCells: number;
  zoneEligible: number;
  zoneOverHalf: number;
  /** 署名原句（取不到 = null，不编） */
  attribution: string | null;
  /** 包自报的格边长（度） */
  cellSize: number | null;
  /** 数不出来 / 异常的原因原文 */
  why: string | null;
}

export interface NameLayer {
  /** 按视野补格 → 算标签/区名 → 出渲染计划（**永不抛**） */
  refresh(why?: string): Promise<NameFacts>;
  facts(): NameFacts;
  plan(): NameRenderPlan;
  /** 一行的三态判词（宿主 HUD 直接念） */
  verdict(): string;
}

/* ══ ⑤ 判词一行（三态：正数 / 0（已量）/ 数不出来（写原因）） ═════════════════════════ */

export function nameVerdictLine(f: NameFacts): string {
  if (f.state === "off") return "🏷🗺 名字层 关（?names=0）";
  if (f.state === "no-index") return `🏷🗺 名字 数不出来：真名包索引没读到（${String(f.why || "index.json 没读到").slice(0, 50)}）`;
  if (f.state === "size-mismatch") return `🏷🗺 名字 数不出来：包分格 ${String(f.cellSize)}° 取不到格（本轮不取）`;
  if (f.state === "uncounted") {
    return `🏷🗺 名字 数不出来：这一轮 0 格取到（格 ${f.hit}/${f.cells}${f.failed ? " · 失败 " + f.failed : ""}）`;
  }
  /* counted：**真名 / 数据驱动 / 示意 三档分开写**，生成名单独写一个 0（机主拍板那条红线） */
  /* 🔴 看板卡点名的三个可数指标：**显示 / 丢弃(避让) / 超上限** —— 分开写，不许合成一个数。
     候选数也带上（"显示 26 / 候选 67"才说明得清"为什么只有 26 个"）。 */
  return (
    `🏷 标签 显示 ${f.pickedShown} / 丢弃(避让) ${f.droppedByCollision} / 超上限 ${f.droppedByCap}` +
    `（候选 ${f.candidates}${f.capped ? " · 被上限截断" : ""}）` +
    ` · 屏上 ${f.labels}（大名字 ${f.bigLabels} · 真名 ${f.realLabels} · 区名 ${f.zoneLabels}=数据驱动 ${f.zoneDerived}+真名区/示意 ${f.zoneSketch}）` +
    ` · 🚫生成名上屏 ${f.generatedOnScreen} · 点 ${f.points} · 格 ${f.hit}/${f.cells}` +
    /* 划区的**中间量**也要看得见：否则"区名 0 个"就只剩一句结论，查不出是"没够格"还是"过半=0"
       （0.05° 上 food 过半就是 0 格 —— 这条实测事实必须能从 HUD 上读出来）。 */
    ` · 子格 够格 ${f.zoneEligible}/${f.zoneCells} 过半 ${f.zoneOverHalf}` +
    ` · D ${f.density === null ? "数不出来" : f.density.toFixed(2)} · ${f.mode === "zones" ? "区名模式" : "名字模式"}`
  );
}

/* ══ ⑥ 实现 ═════════════════════════════════════════════════════════════════════════ */

/** 一格的真名点 + 片区真名（按格缓存） */
interface NameCellData {
  /** 过完 `cf` 阈值的真名点（`{n,k,p,cf,i}`） */
  points: ZoneNamePoint[];
  /** 被置信度挡掉的条数 */
  droppedByConf: number;
  /** 片区真名（placesbundle 的 `{n,k,p,i}`，已按类型档筛过） */
  reals: ZoneRealName[];
  /** 这一格是不是"取到了"（包外 = false，且**不算失败**） */
  ok: boolean;
}

function emptyFacts(on: boolean): NameFacts {
  return {
    state: on ? "uncounted" : "off",
    labels: 0, pickedShown: 0, realLabels: 0, zoneLabels: 0, bigLabels: 0, zoneDerived: 0, zoneSketch: 0,
    generatedOnScreen: 0,
    candidates: 0, droppedByCollision: 0, droppedByCap: 0, capped: false, skippedNoName: 0, skippedOffscreen: 0,
    density: null, mode: "names",
    cells: 0, hit: 0, missing: 0, failed: 0,
    points: 0, droppedByConf: 0,
    zoneCells: 0, zoneEligible: 0, zoneOverHalf: 0,
    attribution: null, cellSize: null, why: null,
  };
}

/** 真名包一格的 URL（见文件头 ⚠️：`SPECS` 里还没有 `names`） */
export function namesCellUrl(cellKey: string, dir = NAMES_BUNDLE_DIR): string {
  return `/${dir}/${cellKey}.json`;
}
export function namesIndexUrl(dir = NAMES_BUNDLE_DIR): string {
  return `/${dir}/index.json`;
}

/** 一格 `namesbundle` 文件 → 真名点（**没有名字/没有坐标的一条都不留**） */
export function namePointsOfCell(json: unknown, minConf: number): { points: ZoneNamePoint[]; droppedByConf: number } {
  const list = (json as { places?: unknown } | null)?.places;
  const raw = Array.isArray(list) ? (list as ZoneNamePoint[]) : [];
  const pts: ZoneNamePoint[] = [];
  let dropped = 0;
  for (const it of raw) {
    const n = String((it && (it.n !== undefined ? it.n : it.name)) || "").trim();
    if (!n) continue;                                        // 没名字的点不进（编名字 = 幻觉源）
    const p = it?.p;
    const lng = Array.isArray(p) ? Number(p[0]) : Number((it as { lng?: unknown })?.lng);
    const lat = Array.isArray(p) ? Number(p[1]) : Number((it as { lat?: unknown })?.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const cf = Number((it as { cf?: unknown })?.cf);
    if (Number.isFinite(cf) && cf < minConf) { dropped++; continue; }   // 置信度阈值（索引里给的建议）
    pts.push(it);
  }
  return { points: pts, droppedByConf: dropped };
}

export function createNameLayer(host: NameLayerHost): NameLayer {
  const cells = new Map<string, NameCellData>();
  const now = host.now || (() => Date.now());
  const gate = createZoneModeGate();
  let last: NameFacts = emptyFacts(host.enabled ? host.enabled() : true);
  let lastPlan: NameRenderPlan = { mode: "names", nodes: [], batch: 0, lite: false, cameraOpacity: LABEL_MOTION.cameraOpacity };
  let batch = 0;
  let lastBatchSig = "";
  let indexDone = false;
  let indexCells: Set<string> | null = null;
  let indexFact: { attribution: string | null; cellSize: number | null; minConf: number | null; cells: number | null } | null = null;

  function viewOf(): BundleView | null {
    const m = host.map();
    if (!m) return null;
    const b = m.getBounds();
    if (!b) return null;
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    if (![w, s, e, n].every((v) => Number.isFinite(v))) return null;
    return {
      bounds: b as unknown as BundleView["bounds"],
      center: { lng: (w + e) / 2, lat: (s + n) / 2 },
    };
  }

  function viewportOf(): { width: number; height: number } | null {
    const m = host.map();
    const c = m?.getCanvas?.();
    const w = Number(c?.clientWidth ?? c?.width);
    const h = Number(c?.clientHeight ?? c?.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  }

  async function loadIndex(): Promise<void> {
    if (indexDone) return;
    indexDone = true;
    try {
      const r = await host.fetchCell(namesIndexUrl(), NAMES_TIMEOUT_MS);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        attribution?: unknown; cellSize?: unknown; cells?: unknown; minConfidenceRecommended?: unknown; real?: unknown;
      } | null;
      const keys = j?.cells && typeof j.cells === "object" ? Object.keys(j.cells as Record<string, unknown>) : null;
      indexCells = keys ? new Set(keys) : null;
      indexFact = {
        attribution: zoneAttributionOf({ attribution: (j?.attribution as string) ?? null, source: null }),
        cellSize: Number.isFinite(Number(j?.cellSize)) ? Number(j?.cellSize) : null,
        minConf: Number.isFinite(Number(j?.minConfidenceRecommended)) ? Number(j?.minConfidenceRecommended) : null,
        cells: keys ? keys.length : null,
      };
    } catch (e) {
      indexCells = null;
      indexFact = null;
      host.onError?.(`names index ${String((e as Error)?.message || e).slice(0, 60)}`);
    }
  }

  /** 取一格（真名点 + 片区真名；两包**同一个 0.05° 格键**）。**成功/包外/失败三态分明** */
  async function fetchCellData(key: string, minConf: number): Promise<"hit" | "missing" | "failed"> {
    let pts: ZoneNamePoint[] = [];
    let dropped = 0;
    let reals: ZoneRealName[] = [];
    let gotAny = false;
    let miss = 0;
    let fail = 0;
    try {
      const r = await host.fetchCell(namesCellUrl(key), NAMES_TIMEOUT_MS);
      if (r.ok) {
        const parsed = namePointsOfCell(await r.json(), minConf);
        pts = parsed.points;
        dropped = parsed.droppedByConf;
        gotAny = true;
      } else if (r.status === 404) miss++;
      else fail++;
    } catch { fail++; }
    try {
      /* 片区名走**已有的** kind（`places`）⇒ URL 由 `wsOfflineFeed` 拼，这里不写第二份路径 */
      const r2 = await host.fetchCell(bundleCellUrl("places", key), NAMES_TIMEOUT_MS);
      if (r2.ok) {
        reals = zoneRealNamesFromPlaces(bundlePlacesOf(await r2.json()) as unknown as Parameters<typeof zoneRealNamesFromPlaces>[0]);
        gotAny = true;
      } else if (r2.status === 404) miss++;
      else fail++;
    } catch { fail++; }
    if (gotAny) {
      cells.set(key, { points: pts, droppedByConf: dropped, reals, ok: true });
      /* 缓存上限：先进先出（Map 保持插入序） */
      while (cells.size > NAMES_STORE_CAP) {
        const k = cells.keys().next().value as string | undefined;
        if (k === undefined) break;
        cells.delete(k);
      }
      return "hit";
    }
    if (fail > 0) return "failed";
    cells.set(key, { points: [], droppedByConf: 0, reals: [], ok: false });
    return "missing";
  }

  async function refresh(why = "view"): Promise<NameFacts> {
    const on = host.enabled ? host.enabled() : true;
    if (!on) {
      last = { ...emptyFacts(false) };
      return emit();
    }
    try {
      await loadIndex();
      const cellSize = indexFact?.cellSize ?? null;
      /* 🔴 包自报的格边长优先（0.05 与 0.02 那两次事故的硬化）：拿不到索引 ⇒ 数不出来 */
      if (indexFact === null) {
        last = { ...emptyFacts(true), state: "no-index", why: "真名包索引没读到" };
        return emit();
      }
      if (cellSize === null) {
        last = { ...emptyFacts(true), state: "no-index", why: "索引里没有 cellSize", attribution: indexFact.attribution };
        return emit();
      }
      const view = viewOf();
      if (!view) {
        last = { ...emptyFacts(true), state: "uncounted", why: "视野拿不到（地图还没就绪）", attribution: indexFact.attribution, cellSize };
        return emit();
      }
      const planCells = bundleCellsForView(view.bounds, view.center, NAMES_MAX_CELLS, cellSize);
      if (!planCells) {
        last = { ...emptyFacts(true), state: "uncounted", why: "格数学算不出来（视野离谱）", attribution: indexFact.attribution, cellSize };
        return emit();
      }
      const wanted = indexCells ? planCells.cells.filter((c) => (indexCells as Set<string>).has(c.key)) : planCells.cells;
      /* 取数：只取"还没缓存"的，一轮最多 NAMES_PER_REFRESH 格 */
      const need = wanted.filter((c) => !cells.has(c.key)).slice(0, NAMES_PER_REFRESH);
      let hit = 0, missing = 0, failed = 0;
      for (const c of need) {
        const r = await fetchCellData(c.key, host.minConf?.() ?? indexFact.minConf ?? NAMES_MIN_CONF_FALLBACK);
        if (r === "hit") hit++;
        else if (r === "missing") missing++;
        else failed++;
      }
      /* 汇总（**视野里那几格**的并集；缓存里别处的格不参与本轮统计） */
      const used = wanted.map((c) => cells.get(c.key)).filter(Boolean) as NameCellData[];
      const hitCells = wanted.filter((c) => cells.get(c.key)?.ok).length;
      const points: ZoneNamePoint[] = [];
      const reals: ZoneRealName[] = [];
      let droppedByConf = 0;
      for (const d of used) {
        points.push(...d.points);
        reals.push(...d.reals);
        droppedByConf += d.droppedByConf;
      }
      const minConf = host.minConf?.() ?? indexFact.minConf ?? NAMES_MIN_CONF_FALLBACK;
      const zonesPlan = planZoneNames(points, reals, {
        subDeg: WS_ZONE_SUB_DEG,
        /* 容器 = **这一轮真取到的** 0.05° 格（视野边缘的半格不出结论） */
        containerDeg: cellSize,
        containers: wanted.filter((c) => cells.get(c.key)?.ok).map((c) => c.key),
      });

      /* ── 真名标签（POI + 片区 + 行政区 + 有名字的楼）──
         `pickLabels` 的产出只有屏幕坐标（`PlacedLabel` 不带经纬度），而**跟手**需要经纬度锚点、
         **点选**需要原始记录 ⇒ 这里同时建两张按 id 索引的表，节点生成时取。 */
      const items: LabelItem[] = [];
      const anchorOf = new Map<string, [number, number]>();
      const pickOf = new Map<string, NameRenderNode["pick"]>();
      for (const p of points) {
        const n = String(p.n ?? p.name ?? "").trim();
        const pp = p.p;
        const lng = Array.isArray(pp) ? Number(pp[0]) : Number(p.lng);
        const lat = Array.isArray(pp) ? Number(pp[1]) : Number(p.lat);
        if (!n || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        /* POI 真名借"小名字"那一档（见文件头 ⚠️：不改 `wsLabels` 的种类表） */
        const id = "poi:" + String(p.i ?? n);
        items.push({ id, kind: "building", name: n, lng, lat, source: "real" });
        anchorOf.set(id, [lng, lat]);
        pickOf.set(id, {
          kind: "place",
          place: {
            n, k: String(p.k ?? ""), c: String((p as { c?: unknown }).c ?? ""),
            cf: Number.isFinite(Number(p.cf)) ? Number(p.cf) : undefined,
            p: [lng, lat], i: String(p.i ?? ""),
          },
        });
      }
      const placeItems = placeLabelsFrom(reals.map((r) => ({ n: r.name, k: r.rawKind, p: [r.lng, r.lat], i: r.id })));
      for (const it of placeItems) {
        items.push(it);
        anchorOf.set(it.id, [it.lng, it.lat]);
        pickOf.set(it.id, { kind: "place", place: { n: it.name, k: it.placeType, p: [it.lng, it.lat], i: it.id } });
      }
      const adminItems = adminLabelsFrom((host.admins?.() || []) as { id: string; name: string; lng: number; lat: number; level?: number }[]);
      for (const it of adminItems) {
        items.push(it);
        anchorOf.set(it.id, [it.lng, it.lat]);
        pickOf.set(it.id, { kind: "place", place: { n: it.name, k: "admin", p: [it.lng, it.lat], i: it.id } });
      }
      if (host.drawnBuildings) {
        for (const it of buildingLabelsFrom(host.drawnBuildings() as unknown[])) {
          items.push(it);
          anchorOf.set(it.id, [it.lng, it.lat]);
          pickOf.set(it.id, { kind: "building", buildingId: it.id, name: it.name, lng: it.lng, lat: it.lat });
        }
      }

      const m = host.map();
      const vp = viewportOf();
      let picked: PickResult | null = null;
      if (m && vp) {
        const z = m.getZoom();
        picked = pickLabels(items, (lng, lat) => m.project([lng, lat]), vp, labelPlanFor(z), { gridPx: LABEL_MOTION.gridPx });
      }
      const density = picked ? (picked.candidates > 0 ? picked.droppedByCollision / picked.candidates : null) : null;
      const g = gate.sample(density, now());
      const mode: NameMode = g.zoneMode ? "zones" : "names";
      /* 🔴 **名额必须分两半**（2026-09-26 真浏览器实测抓到的产品缺陷）：
         实测那一屏有 8 个**真名区**（placesbundle 的社区/街道名，排序里 real 永远在前），
         8 个名额被它们占满 ⇒ **数据驱动区（「零售区」）一个都上不了屏** ——
         而机主要的正是"按类型划出来的区"（经济区/美食区那种）。
         ⇒ 真名区最多 `NAMES_ZONE_REAL_MAX` 个，剩下的名额留给**算出来的**区；
           两边各自按 `planZoneNames` 的确定性顺序取，合起来 ≤ `NAMES_ZONE_CAP`。 */
      const zoneReal = zonesPlan.zones.filter((z) => z.source === "real");
      const zoneCalc = zonesPlan.zones.filter((z) => z.source !== "real");
      const zonePickReal = pickZoneNames(zoneReal, Math.min(NAMES_ZONE_REAL_MAX, NAMES_ZONE_CAP));
      const zonePickCalc = pickZoneNames(zoneCalc, Math.max(0, NAMES_ZONE_CAP - zonePickReal.shown.length));
      const zoneShown = [...zonePickReal.shown, ...zonePickCalc.shown];

      /* ── 渲染计划 ── */
      const nodes: NameRenderNode[] = [];
      /** 区名锚点落在画布外被丢弃的个数（与真名那条路的 `skippedOffscreen` 合并计数，见下） */
      let zoneDroppedOffscreen = 0;
      const nodeOfLabel = (s: PlacedLabel): NameRenderNode => {
        const a = anchorOf.get(s.id);
        return {
          slot: 0,
          id: s.id,
          text: s.name,
          style: "real",
          sketch: false,
          x: s.x, y: s.y, w: s.w, h: s.h,
          lng: a ? a[0] : 0,
          lat: a ? a[1] : 0,
          why: `真名（${s.kind} · 优先级 ${s.priority}）`,
          pick: pickOf.get(s.id) || { kind: "building", buildingId: s.id, name: s.name, lng: a ? a[0] : 0, lat: a ? a[1] : 0 },
        };
      };
      if (picked && vp) {
        if (mode === "names") {
          for (const s of picked.shown) nodes.push(nodeOfLabel(s));
        } else {
          /* 密集：**小名字退场**（POI），**大名字留在屏上**（行政区名 / 区片名），区名进场 */
          const big = picked.shown.filter((s) => s.kind === "admin" || s.kind === "place").slice(0, NAMES_BIG_KEEP);
          for (const s of big) nodes.push(nodeOfLabel(s));
          /* 🔴🔴 2026-09-26 机主真机：「**楼名与楼对不上位置**」——区名原来**不按视野过滤**：
             候选来自"取过的格"（含挪走之前留下的旧格）⇒ 真浏览器实测 **7/8 个区名的锚点在画布外**
             （`@(1892,2074)`、`@(8554,3166)`…），屏上那几个正好是"看着像乱放"的。
             真名那条路早就有视野过滤（`pickLabels(..., vp, ...)`），区名必须同口径：
             **只上屏投影点落在视野内（含一屏边距）的区名**，丢了多少如实计数（`zoneDroppedOffscreen`）。 */
          for (const z of zoneShown) {
            const n = nodeOfZone(z);
            if (vp) {
              const pad = 24;
              const inView = n.x >= -pad && n.y >= -pad && n.x <= vp.width + pad && n.y <= vp.height + pad;
              if (!inView) { zoneDroppedOffscreen++; continue; }
            }
            nodes.push(n);
          }
        }
      }
      nodes.forEach((n, i) => { n.slot = i; });
      const lite = nodes.length > LABEL_MOTION.liteAbove;
      const sig = mode + "|" + nodes.map((n) => n.id + ":" + n.text).join(",");
      if (sig !== lastBatchSig) { batch++; lastBatchSig = sig; }
      lastPlan = { mode, nodes, batch, lite, cameraOpacity: LABEL_MOTION.cameraOpacity };

      const realLabels = nodes.filter((n) => n.style === "real").length;
      /* 🔴 「区名」的计数口径：**带 pick.kind==="zone" 的节点**（而不是"样式不是 real"）——
         因为真名区（`source:"real"` 的区名）样式就是 real，按样式数会把它算成真名标签，
         于是"区名 0 个"与实际不符（2026-09-26 真浏览器实测抓到的读数矛盾，就是这一条）。 */
      const zoneLabels = nodes.filter((n) => n.pick.kind === "zone").length;
      const bigLabels = nodes.length - zoneLabels;
      last = {
        state: "counted",
        labels: nodes.length,
        pickedShown: picked?.shown.length ?? 0,
        realLabels,
        zoneLabels,
        bigLabels,
        zoneDerived: nodes.filter((n) => n.style === "derived").length,
        /* 区名里**不是数据驱动**的那些（真名区 + 示意区）—— 数据驱动的另有一个数 */
        zoneSketch: nodes.filter((n) => n.pick.kind === "zone" && n.style !== "derived").length,
        generatedOnScreen: 0,
        candidates: picked?.candidates ?? 0,
        droppedByCollision: picked?.droppedByCollision ?? 0,
        droppedByCap: picked?.droppedByCap ?? 0,
        capped: !!picked?.capped,
        skippedNoName: picked?.skippedNoName ?? 0,
        /* **视野外丢弃** = 真名候选被 `pickLabels` 丢的 + 区名锚点在画布外被丢的（同一口径，一个数） */
        skippedOffscreen: (picked?.skippedOffscreen ?? 0) + zoneDroppedOffscreen,
        density,
        mode,
        cells: wanted.length,
        hit: hitCells,
        missing,
        failed,
        points: points.length,
        droppedByConf,
        zoneCells: zonesPlan.cells,
        zoneEligible: zonesPlan.eligible,
        zoneOverHalf: zonesPlan.overHalf,
        attribution: indexFact.attribution,
        cellSize,
        why: hitCells === 0 && wanted.length > 0 ? "视野里的格一格都没取到" : null,
      };
      return emit();
    } catch (e) {
      last = { ...emptyFacts(true), state: "uncounted", why: String((e as Error)?.message || e).slice(0, 60) };
      host.onError?.("names " + last.why);
      return emit();
    }
  }

  function nodeOfZone(z: ZoneName): NameRenderNode {
    /* 🔴🔴 2026-09-26 机主真机：「**楼名与楼对不上位置 / 点开后完全不一致**」——
       原来这里把 `x/y` 硬写成 0（以为宿主会自己重投影），可宿主只拿 `n.x/n.y` 写 `translate3d`
       ⇒ **所有区名标签全堆在画布左上角**（实测 8 个区名 @(28,5)(17,5)(11,5)(23,5)…），
       点哪个都点到压在它上面的另一个 ⇒ 既"对不上位置"又"点开不一致"。
       规矩：**节点位置是这份真源的职责**（`nodeOfLabel` 也是用挑出来的 `s.x/s.y`），
       区名就在这里用同一个 `host.map().project()` 投影，宿主只负责画。 */
    let x = 0;
    let y = 0;
    try {
      const m = host.map?.();
      if (m && Number.isFinite(z.lng) && Number.isFinite(z.lat)) {
        const p = m.project([z.lng, z.lat]);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { x = p.x; y = p.y; }
      }
    } catch { /* 投影拿不到就老实留在 0（`why` 里会说明是"数不出来"那条路） */ }
    return {
      slot: 0,
      id: z.id,
      text: z.label,
      style: z.style,
      sketch: z.sketch,
      x, y, w: 0, h: 0,
      lng: z.lng, lat: z.lat,
      why: z.why,
      pick: { kind: "zone", zone: z },
    };
  }

  function emit(): NameFacts {
    try { host.onPlan?.(lastPlan, last); } catch { /* 渲染失败不影响事实 */ }
    return last;
  }

  return {
    refresh,
    facts: () => last,
    plan: () => lastPlan,
    verdict: () => nameVerdictLine(last),
  };
}
