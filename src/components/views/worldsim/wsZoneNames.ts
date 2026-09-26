/**
 * wsZoneNames.ts —— 🗺 **区名**的唯一真源（真名 / 数据驱动 / 示意）。纯逻辑：不碰 DOM、不碰地图、不联网。
 *
 * ## 为什么有这一份
 * 机主 2026-09-26 原话：「**我要求每个显示的楼房都要有名字喵**，**如果太密集了就根据类型划定区域
 * （如经济区，美食区）**」。三条**实测**事实决定了这份模块的形状（都不是推测）：
 *   ① **真楼名只覆盖 2.0%**（渝中区 400m：101 栋里 2 栋有名）⇒「每栋都有真名」做不到；
 *   ② **48px 避让网格在 904×341 舞台上只放得下 29 个四字楼名**（cap 26→200 仍是 29）⇒ 每栋挂标签物理上放不下；
 *   ③ **按类型划区只在 ~1km 粒度成立**：名字包自己的 0.05° 格上 `food` 占比过半 = **0 格**；
 *      换到 **0.01°（≈1.1km）** 才 **11 格**（`NAMES-BUNDLE-REPORT.md` §3）。
 * ⇒ **划区粒度 = 0.01° 子格**（不是包自己的 0.05°），且**只在"主导类过半"时才算数据驱动**。
 *
 * ## 三种区名（**屏上样式必须互不相同**，机主/父代理 2026-09-26 拍板）
 * | `source` | 什么时候出 | 名字长什么样 | 依据 |
 * |---|---|---|---|
 * | `real` | 这个子格里**有真地名/行政区名**（`placesbundle` / `adminLabelsFrom`） | **原样**（如「解放碑」） | 真数据；**优先于**聚合名（聚合名绝不许盖真名） |
 * | `derived` | 子格名字数 ≥ `minCount` **且** 主导粗类占比 **> 0.5** | 类别名 + 「区」（如「美食区」） | **数据驱动**：带 `derivedFrom` / `count` / `bbox` |
 * | `generated` | 同上但**没过半**（`sketch` 允许时） | 「示意·」+ 类别名（如「示意·美食」） | **示意**，屏上样式必须与真名不同；`sketch: true` |
 * **不上屏的那一档**：名字数 < `minCount` ⇒ 一个字都不出（`zoneNameForCell` 返回 null）——宁可没有，不许编。
 *
 * ## 三条硬性质（都有自检钉子）
 * 1. **确定性**：同一输入两次调用**逐字节相同**（排序、取名、锚点全部只由输入决定，无随机、无时间）；
 * 2. **不随视野漂**：结果**只由"这一个子格里的点"决定** —— 拿全量算与只拿这一格的点算，
 *    这一格的区名**逐字节相同**（没有任何跨格的归一化：占比只除**本格**的总数）；
 * 3. **判词三态**：正数 / 0（已量）/ 数不出来（写原因）—— 0 与"没测出来"**永远分得开**。
 *
 * ## 红线（项目铁律，写在代码里谁都别绕）
 * · 生成名/示意名**绝不进数据层、绝不进对话上下文**（不进 `/namesbundle`、不进发给 LingChat 的文本）；
 *   本模块产出的 `generated` 区名只用于**屏上**显示，且 `sketch === true` 是机器可判的标志位；
 * · 真数据（Overture/OSM，ODbL）署名**只念包索引里的原话**（`zoneAttributionOf`），不在代码里另写一句。
 *
 * ## 口径来源（改判据必须一起改的地方）
 * · 格键与楼/路/片区包**同一套数学**：直接复用 `wsFeatureStore.bundleCellOf / bundleCellKey`
 *   （🔴 不许在这里写第二份 `floor(x/deg)*deg` —— 0.02/0.05 那两次事故就是这么来的）；
 * · 粗类 12 个 = `namesbundle/index.json.kinds`（导出器 `COARSE_KINDS`）；
 * · 判据数字（`minCount 5` / `占比 > 0.5`）= `NAMES-BUNDLE-REPORT.md` §3 写死的那条，
 *   自检拿**真包**复现「0.05° food 过半 **0 格** / 0.01° **11 格**」。
 */

import { bundleCellKey, bundleCellOf } from "./wsFeatureStore";
import { placeTierOf } from "./wsLabels";

/* ══ ① 判据常量（**只有这一处**；页面/App/自检都不许再写一份） ═════════════════════════════ */

/** 划区粒度（度）：0.01° ≈ 1.1km —— 实测这一档「主导类过半」才有 20/85 格（0.05° 只有 4/41） */
export const WS_ZONE_SUB_DEG = 0.01;
/** 够格门槛：某格名字数 ≥ 它才参与划区（与 `NAMES-BUNDLE-REPORT.md` §3 的判据同一个数） */
export const WS_ZONE_MIN_COUNT = 5;
/** 主导类占比**必须严格大于**它才算数据驱动（0.5 = 过半；等于 0.5 **不算**） */
export const WS_ZONE_DOMINANCE = 0.5;
/** 示意名的前缀（屏上必须与真名样式不同；这一段文本本身也是"这是示意"的可见证据） */
export const WS_ZONE_GEN_TAG = "示意";
/** 数据驱动名的后缀（类别名 + 它 = 「美食区」） */
export const WS_ZONE_DERIVED_SUFFIX = "区";

/** namesbundle 的 12 个粗类（顺序即 `index.json.kinds`，**不许改序**：自检按序对拍） */
export const WS_ZONE_COARSE_KINDS = [
  "food", "retail", "commercial", "lodging", "education", "medical",
  "transport", "landmark", "park", "culture", "industrial", "other",
] as const;
export type CoarseKind = (typeof WS_ZONE_COARSE_KINDS)[number];

/** 粗类 → 中文类别词（**只用于区名**，不用于任何"真名"） */
export const WS_ZONE_KIND_LABEL: Record<CoarseKind, string> = {
  food: "美食", retail: "零售", commercial: "商业", lodging: "住宿",
  education: "教育", medical: "医疗", transport: "交通", landmark: "地标",
  park: "公园", culture: "文化", industrial: "工业",
  /* 🔴 「没类别」那一档（真包 24 条 = 1.3%）：**不进主导类统计**（它不构成"以什么为主"），
     但仍然计入 `total`（分母），并如实出现在 `unclassified` 里。 */
  other: "其他",
};

/** 这一档"没有类别"（真包那 24 条 `categories.primary` 为空的） */
export const WS_ZONE_UNCLASSIFIED: CoarseKind = "other";

/** 归一化一个粗类：空 ⇒ `other`；不认得 ⇒ `other`（并如实计入 `unknownKinds`，不静默吞） */
export function coarseKindOf(k: unknown): CoarseKind {
  const s = String(k ?? "").trim().toLowerCase();
  if (!s) return WS_ZONE_UNCLASSIFIED;
  return (WS_ZONE_COARSE_KINDS as readonly string[]).indexOf(s) >= 0 ? (s as CoarseKind) : WS_ZONE_UNCLASSIFIED;
}

/** 中文类别词（不认得的也走 `other` 的"其他"，**不抛**） */
export function zoneKindLabelOf(k: unknown): string {
  return WS_ZONE_KIND_LABEL[coarseKindOf(k)];
}

/* ══ ② 输入归一化：真名点（namesbundle）/ 真地名（placesbundle）/ 行政名 ═════════════════════ */

/**
 * 参与**类型统计**的一个真名点（字段名与 `namesbundle` 的 `{n,k,c,p,cf,i}` **逐字相同**）。
 * `n` 为空 ⇒ **不进统计**（编名字 = 给 AI 造幻觉源；真包里 1876 条**全部**有名字）。
 */
export interface ZoneNamePoint {
  n?: string;
  name?: string;
  k?: string;
  kind?: string;
  p?: readonly number[];
  lng?: number;
  lat?: number;
  cf?: number;
  i?: string;
  id?: string;
}

export interface ZonePointFact {
  /** 归一化后的点（只含"有名字 + 有坐标"的） */
  points: ZoneNamePoint[];
  /** 因为**没有名字**被丢掉的条数（如实计数，不许写成"这里没有地点"） */
  skippedNoName: number;
  /** 因为**没有坐标**被丢掉的条数 */
  skippedNoPoint: number;
  /** 粗类不认识（落到 `other`）的条数 */
  unknownKinds: number;
  /** 原始条数 */
  considered: number;
}

/** 一条输入记录 → `[lng, lat]`（同时认 `p:[lng,lat]` 与 `lng/lat` 两种形状） */
export function zonePointLngLat(it: ZoneNamePoint | null | undefined): [number, number] | null {
  if (!it) return null;
  const p = it.p;
  if (p && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) return [Number(p[0]), Number(p[1])];
  if (Number.isFinite(Number(it.lng)) && Number.isFinite(Number(it.lat))) return [Number(it.lng), Number(it.lat)];
  return null;
}

/** 归一化一批真名点（namesbundle 格文件的 `places[]` 直接喂进来即可） */
export function zonePointsFrom(list: readonly ZoneNamePoint[] | null | undefined): ZonePointFact {
  const out: ZonePointFact = { points: [], skippedNoName: 0, skippedNoPoint: 0, unknownKinds: 0, considered: 0 };
  for (const it of list || []) {
    out.considered++;
    const name = String((it && (it.n !== undefined ? it.n : it.name)) || "").trim();
    if (!name) { out.skippedNoName++; continue; }
    const ll = zonePointLngLat(it);
    if (!ll) { out.skippedNoPoint++; continue; }
    const raw = String((it && (it.k !== undefined ? it.k : it.kind)) || "").trim().toLowerCase();
    if (raw && (WS_ZONE_COARSE_KINDS as readonly string[]).indexOf(raw) < 0) out.unknownKinds++;
    out.points.push(it);
  }
  return out;
}

/** 真地名/行政名的**档**：admin（行政区）> area（区片 suburb/quarter/borough）> local（小区 neighbourhood） */
export type ZoneRealTier = "admin" | "area" | "local";
export const WS_ZONE_REAL_TIER_RANK: Record<ZoneRealTier, number> = { admin: 3, area: 2, local: 1 };

/** 一条**真名**（区名的第一优先来源） */
export interface ZoneRealName {
  id: string;
  name: string;
  lng: number;
  lat: number;
  tier: ZoneRealTier;
  /** 出处：`place` = placesbundle 的片区名；`admin` = 行政区名（DataV 边界接口喂进来） */
  from: "place" | "admin";
  /** 原始类型（place 的 `k`；admin 为 undefined）——信息卡要能回答"这是哪一档的真名" */
  rawKind?: string;
}

/**
 * 从 `placesbundle` 的 `places[]`（`{n,k,p,i}`）取真地名。
 * 🔴 **不认得的 place 类型不进**（`placeTierOf` 返回 null）—— 宁可少显示，不许显示错的东西
 *    （与 `wsLabels.placeLabelsFrom` 同一条纪律；这里只是把"档"记下来给区名排序用）。
 */
export function zoneRealNamesFromPlaces(
  list: readonly { n?: string; name?: string; k?: string; kind?: string; p?: readonly number[]; lng?: number; lat?: number; i?: string; id?: string }[] | null | undefined,
): ZoneRealName[] {
  const out: ZoneRealName[] = [];
  for (const it of list || []) {
    const name = String((it && (it.n !== undefined ? it.n : it.name)) || "").trim();
    if (!name) continue;                                    // 缺名字不显示，也不编
    const raw = String((it && (it.k !== undefined ? it.k : it.kind)) || "").trim().toLowerCase();
    const t = placeTierOf(raw);
    if (t === null) continue;                               // 不认得的类型
    const ll = zonePointLngLat(it as ZoneNamePoint);
    if (!ll) continue;
    out.push({
      id: "place:" + String((it as { i?: string; id?: string }).i || (it as { id?: string }).id || raw + ":" + name),
      name, lng: ll[0], lat: ll[1],
      tier: t === "area" ? "area" : "local",
      from: "place", rawKind: raw,
    });
  }
  return out;
}

/** 从行政名（`wsLabels.adminLabelsFrom` 的入参形状）取真名 —— tier 恒 `admin` */
export function zoneRealNamesFromAdmins(
  list: readonly { id?: string; name?: string; lng?: number; lat?: number; level?: number }[] | null | undefined,
): ZoneRealName[] {
  const out: ZoneRealName[] = [];
  for (const it of list || []) {
    const name = String((it && it.name) || "").trim();
    if (!name || !Number.isFinite(Number(it.lng)) || !Number.isFinite(Number(it.lat))) continue;
    out.push({
      id: "admin:" + String(it.id || name), name,
      lng: Number(it.lng), lat: Number(it.lat),
      tier: "admin", from: "admin",
    });
  }
  return out;
}

/* ══ ③ 分桶（0.01° 子格）—— 格数学**复用** `wsFeatureStore`，这里不写第二份 ═══════════════ */

export interface ZoneBucket {
  key: string;
  /** 子格西南角（度） */
  w: number;
  s: number;
  deg: number;
  /** 这一格的点数（**分母**；含 `other`） */
  total: number;
  /** 有粗类的点数（= total − other） */
  classified: number;
  /** 各粗类计数（只含 > 0 的类；键按 `WS_ZONE_COARSE_KINDS` 序写，便于逐字节对拍） */
  byKind: Record<string, number>;
  /** 落到 `other` 的点数（**不计入主导类**，但计入 `total`） */
  unclassified: number;
  /** 重心（点均值；锚点兜底用） */
  lng: number;
  lat: number;
  /** [w, s, e, n] */
  bbox: [number, number, number, number];
}

export interface ZoneOpts {
  /** 子格边长（度）；默认 `WS_ZONE_SUB_DEG`（0.01） */
  subDeg?: number;
  /** 够格门槛；默认 `WS_ZONE_MIN_COUNT`（5） */
  minCount?: number;
  /** 过半阈值；默认 `WS_ZONE_DOMINANCE`（0.5，**严格大于**） */
  dominance?: number;
  /** 允不允许出**示意**区名；默认 `true`（关掉 ⇒ 没过半就什么都不出） */
  sketch?: boolean;
  /** 真名够不够格：真名所在格的点数 ≥ 它才出真名区（默认 0 = 真名不受"够格"限制） */
  minRealCount?: number;
  /* ── 取数口径（🔴 **必读**：真名包的格与划区的格**不是同一个粒度**） ─────────────────
     真名包（`namesbundle`）自己的格是 **0.05°**（它是**取数单位**：一次 fetch 一格）；
     而"按类型划区"的粒度**必须是 0.01°**（实测：0.05° 上 `food` 过半 = 0 格、0.01° 上 11 格）。
     ⇒ 这两者**本来就该不同**，不要对拍、更不要因此拒绝算区名。
     真正要对拍的是下面这一对：**子格必须被容器格整除**（否则一个子格会跨两个容器 ⇒ 拿到的点只覆盖半格）。
     再往下是"**边缘子格**"这个坑：视野边缘那一格 0.05° 的包可能只覆盖到一部分子格 ——
     用 `containers` 把"**整格都取到**"的容器格名报上来，本模块就只在这些容器内的子格上出区名。 */
  /** 容器格边长（度）；默认 = `subDeg`（= 不做容器过滤）。真名包给 **0.05** */
  containerDeg?: number;
  /** 这一轮**真的取到**的容器格键集合（`namesbundle` 的 `106.55000_29.55000_0.05`）。
   *  给了它 ⇒ 只有落在这些容器里的子格才参与（**视野边缘的半格数据不出结论**）。 */
  containers?: readonly string[] | ReadonlySet<string> | null;
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 容器格集合归一化（数组/Set 都认；空 ⇒ null = 不做过滤） */
function containerSetOf(v: ZoneOpts["containers"]): ReadonlySet<string> | null {
  if (!v) return null;
  const s = v instanceof Set ? v : new Set(v);
  return s.size ? s : null;
}

/** 容器格键（子格落在哪个容器里；容器必须被 `subDeg` 整除，否则口径不成立） */
export function zoneContainerKeyOf(lng: number, lat: number, containerDeg: number): string {
  const c = bundleCellOf(lng, lat, containerDeg);
  return bundleCellKey(c.w, c.s, containerDeg);
}

/** 子格 ↔ 容器格**口径是否相容**（容器边长必须是子格边长的整数倍） */
export function zoneGridCompatible(subDeg: number, containerDeg: number): boolean {
  const a = num(subDeg, WS_ZONE_SUB_DEG), b = num(containerDeg, a);
  if (!(a > 0) || !(b > 0)) return false;
  const k = b / a;
  return Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1;
}

/** 分桶：只由**输入点**决定（与视野无关）。返回按格键升序 —— 确定性的一半在这里。
 *
 * 🔴 重心**必须按规范序求和**：浮点加法不满足结合律，`a+b+c ≠ c+b+a`（末位差 1e-14）——
 *    自检真抓到过：同一批点**逆序喂入**，重心从 `106.55499999999999` 变成 `106.55499999999998`，
 *    `JSON.stringify` 就不再逐字节相同。修法不是"四舍五入掩盖"，而是**先把坐标按字典序排好再求和**
 *    （与输入顺序完全无关，且不做任何精度损失）。 */
export function zoneBucketsOf(points: readonly ZoneNamePoint[] | null | undefined, opts: ZoneOpts = {}): ZoneBucket[] {
  const deg = num(opts.subDeg, WS_ZONE_SUB_DEG);
  const map = new Map<string, { b: ZoneBucket; pts: number[][] }>();
  for (const it of points || []) {
    const ll = zonePointLngLat(it);
    if (!ll) continue;                                      // 没坐标的点进不了任何格
    const name = String((it && (it.n !== undefined ? it.n : it.name)) || "").trim();
    if (!name) continue;                                    // 没名字的点不进统计（双保险）
    const { w, s } = bundleCellOf(ll[0], ll[1], deg);
    const key = bundleCellKey(w, s, deg);
    let e = map.get(key);
    if (!e) {
      e = {
        b: {
          key, w, s, deg, total: 0, classified: 0, byKind: {}, unclassified: 0,
          lng: 0, lat: 0, bbox: [w, s, +(w + deg).toFixed(5), +(s + deg).toFixed(5)],
        },
        pts: [],
      };
      map.set(key, e);
    }
    const b = e.b;
    const k = coarseKindOf(it && (it.k !== undefined ? it.k : it.kind));
    b.total++;
    if (k === WS_ZONE_UNCLASSIFIED) b.unclassified++;
    else { b.classified++; b.byKind[k] = (b.byKind[k] || 0) + 1; }
    e.pts.push(ll);
  }
  const out: ZoneBucket[] = [];
  for (const { b, pts } of map.values()) {
    /* 规范序：lng 升序 → lat 升序（同点重复多少遍都一样，因为值相同） */
    pts.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
    let sx = 0;
    let sy = 0;
    for (const p of pts) { sx += p[0]; sy += p[1]; }
    b.lng = b.total > 0 ? sx / b.total : +(b.w + deg / 2).toFixed(6);
    b.lat = b.total > 0 ? sy / b.total : +(b.s + deg / 2).toFixed(6);
    /* 键序固定（按 `WS_ZONE_COARSE_KINDS`）⇒ `JSON.stringify` 逐字节可比 */
    const ordered: Record<string, number> = {};
    for (const k of WS_ZONE_COARSE_KINDS) if (b.byKind[k]) ordered[k] = b.byKind[k];
    b.byKind = ordered;
    out.push(b);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** 主导粗类：**占比 = 该类计数 ÷ 该格总点数（含 other）** —— 与报告的判据同分母（实测复现 0/11 格） */
export interface ZoneDominant {
  kind: CoarseKind;
  count: number;
  share: number;
  /** 并列时的**并列数**（> 1 说明"主导"名不副实 ⇒ 判词要写出来） */
  ties: number;
}
export function zoneDominantOf(b: ZoneBucket | null | undefined): ZoneDominant | null {
  if (!b || !b.total) return null;
  let best: CoarseKind | null = null;
  let bestN = -1;
  let ties = 0;
  for (const k of WS_ZONE_COARSE_KINDS) {
    if (k === WS_ZONE_UNCLASSIFIED) continue;               // 「没类别」不构成"以什么为主"
    const n = b.byKind[k] || 0;
    if (n <= 0) continue;
    if (n > bestN) { bestN = n; best = k; ties = 1; }
    else if (n === bestN) ties++;
  }
  if (best === null) return null;
  return { kind: best, count: bestN, share: bestN / b.total, ties };
}

/* ══ ④ 区名（三种 source）—— 决策顺序**写死**：真名 > 数据驱动 > 示意 > 不出 ═══════════════ */

export type ZoneSource = "real" | "derived" | "generated";

export interface ZoneName {
  id: string;
  /** 子格键（与楼/路/片区包同口径：`106.55000_29.55000_0.01`） */
  key: string;
  /** 名字本体：真名原样 / 「美食区」/ 「示意·美食」 */
  name: string;
  /** 屏上文案（= `name`；留一个字段是为了以后真名要加后缀时**只改一处**） */
  label: string;
  source: ZoneSource;
  /** 数据驱动/示意：主导粗类；真名 = null */
  derivedFrom: CoarseKind | null;
  /** 真名：出处与档；聚合名 = null */
  realFrom: "place" | "admin" | null;
  realId: string | null;
  tier: ZoneRealTier | null;
  /** 主导类计数（真名 = 该格点数） */
  count: number;
  /** 该格点数（分母） */
  total: number;
  /** 主导类占比（真名 = null：真名不是"算出来"的） */
  share: number | null;
  bbox: [number, number, number, number];
  lng: number;
  lat: number;
  /** 屏上样式分档：`real` / `derived` / `generated` —— **三者必须不同**（机主拍板） */
  style: ZoneSource;
  /** 是不是"示意"（机器可判的红线标志位；真名/数据驱动 = false） */
  sketch: boolean;
  /** 一行依据（可数；HUD/tooltip 直接念它） */
  why: string;
}

/** 一个格里的真名（按档 → id 排序后取第一条；**同格多个真名只出一个**，其余进 `alsoReal`） */
export function realNamesOfCell(realNames: readonly ZoneRealName[] | null | undefined, key: string, deg: number): ZoneRealName[] {
  const hit: ZoneRealName[] = [];
  for (const r of realNames || []) {
    if (!r || !String(r.name || "").trim()) continue;
    if (!Number.isFinite(r.lng) || !Number.isFinite(r.lat)) continue;
    const c = bundleCellOf(r.lng, r.lat, deg);
    if (bundleCellKey(c.w, c.s, deg) !== key) continue;
    hit.push(r);
  }
  hit.sort((a, b) =>
    (WS_ZONE_REAL_TIER_RANK[b.tier] - WS_ZONE_REAL_TIER_RANK[a.tier]) ||
    (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return hit;
}

/** 类别名：`美食` + `区` = 「美食区」；示意名：`示意·` + `美食` */
export function derivedZoneNameOf(kind: unknown): string {
  return zoneKindLabelOf(kind) + WS_ZONE_DERIVED_SUFFIX;
}
export function sketchZoneNameOf(kind: unknown): string {
  return WS_ZONE_GEN_TAG + "·" + zoneKindLabelOf(kind);
}

export interface ZoneCellInput {
  bucket: ZoneBucket;
  /** 这一格撒得到的真名（`realNamesOfCell` 的结果；空数组 = 没有） */
  realNames?: readonly ZoneRealName[];
}

/**
 * **一个子格 → 一个区名**（或 `null`）。决策顺序写死在这里，别处不许再判一遍：
 *   ① 有真名 ⇒ `real`（**哪怕没过半、哪怕点很少** —— 真名优先，聚合名绝不许盖它；
 *      点太少时用 `minRealCount` 拦，默认 0 = 不拦）；
 *   ② 够格（`total ≥ minCount`）且主导占比 **> dominance** ⇒ `derived`（数据驱动）；
 *   ③ 够格但没过半、且 `sketch` ⇒ `generated`（示意）；
 *   ④ 其余 ⇒ `null`（一个字都不出）。
 */
export function zoneNameForCell(cell: ZoneCellInput, opts: ZoneOpts = {}): ZoneName | null {
  const b = cell && cell.bucket;
  if (!b || !b.key) return null;
  const minCount = Math.max(1, Math.trunc(num(opts.minCount, WS_ZONE_MIN_COUNT)));
  const dominance = num(opts.dominance, WS_ZONE_DOMINANCE);
  const sketch = opts.sketch !== false;
  const minReal = Math.max(0, Math.trunc(num(opts.minRealCount, 0)));

  /* ① 真名优先（真地名 / 行政区名） */
  const reals = (cell.realNames || []).filter((r) => r && String(r.name || "").trim());
  if (reals.length && b.total >= minReal) {
    const r = reals[0];
    const also = reals.length - 1;
    return {
      id: "zone:" + b.key,
      key: b.key,
      name: r.name,
      label: r.name,
      source: "real",
      derivedFrom: null,
      realFrom: r.from,
      realId: r.id,
      tier: r.tier,
      count: b.total,
      total: b.total,
      share: null,
      bbox: b.bbox,
      /* 真名的锚点 = **真名自己的点**（不搬家：它的位置就是事实）；聚合名才用格重心 */
      lng: Number(r.lng),
      lat: Number(r.lat),
      style: "real",
      sketch: false,
      why: `🗺 真名「${r.name}」（${r.from === "admin" ? "行政区名" : "片区名"}·${r.tier}）· 格内 ${b.total} 个点` +
        (also > 0 ? ` · 同格另有真名 ${also} 条` : ""),
    };
  }

  const dom = zoneDominantOf(b);
  const base = {
    id: "zone:" + b.key,
    key: b.key,
    bbox: b.bbox,
    lng: b.lng,
    lat: b.lat,
    realFrom: null as null,
    realId: null as null,
    tier: null as null,
  };
  if (b.total < minCount || !dom) {
    /* ④ 不够格：**一个字都不出**（宁可没有，不许编） */
    return null;
  }
  const shareTxt = `${dom.count}/${b.total} = ${(dom.share * 100).toFixed(1)}%`;
  if (dom.share > dominance) {
    return {
      ...base,
      name: derivedZoneNameOf(dom.kind),
      label: derivedZoneNameOf(dom.kind),
      source: "derived",
      derivedFrom: dom.kind,
      count: dom.count,
      total: b.total,
      share: dom.share,
      style: "derived",
      sketch: false,
      why: `🗺 数据驱动：主导「${zoneKindLabelOf(dom.kind)}」 ${shareTxt}（> ${(dominance * 100).toFixed(0)}%）` +
        (dom.ties > 1 ? ` · ⚠ 并列 ${dom.ties} 类` : "") + ` · 格内 ${b.total} 个点（有类别 ${b.classified}）`,
    };
  }
  if (!sketch) return null;
  return {
    ...base,
    name: sketchZoneNameOf(dom.kind),
    label: sketchZoneNameOf(dom.kind),
    source: "generated",
    derivedFrom: dom.kind,
    count: dom.count,
    total: b.total,
    share: dom.share,
    style: "generated",
    sketch: true,
    why: `🗺 **示意**：最多的一类是「${zoneKindLabelOf(dom.kind)}」但只占 ${shareTxt}` +
      `（没过半 ⇒ 不是数据驱动的区名，只是"这一带这类多一些"）· 格内 ${b.total} 个点`,
  };
}

export interface ZonePlan {
  zones: ZoneName[];
  /** 走过的格数（`zoneBucketsOf` 的格数） */
  cells: number;
  /** 够格的格数（`total ≥ minCount`） */
  eligible: number;
  /** 主导类**过半**的格数（= 数据驱动的上限；真名占了的格不算） */
  overHalf: number;
  bySource: { real: number; derived: number; generated: number };
  /** 格内点数（分母）的分布 —— 判词里"中位"用它，别看感觉 */
  totalStats: { min: number; median: number; max: number };
  /** 主导占比的中位（只统计够格且没被真名占的格） */
  shareMedian: number | null;
  /** 因为不够格一个字都没出的格数 */
  skippedSparse: number;
  /** 🔴 因为**容器格没取全**（视野边缘的半格）而**不出结论**的子格数 —— 如实计数，别当成"这里没数据" */
  skippedPartial: number;
}

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * **一批点 + 真名 → 一批区名**（确定性：同输入两次调用 `JSON.stringify` 逐字节相同）。
 * 🔴 **不接收任何视野/相机参数** —— 这就是"不随视野漂"的结构保证：
 *    结果只由"每个子格里的点"决定，跨格之间没有任何归一化。
 *
 * `opts.containers` 给了就只算"落在**取全了的容器格**里"的子格 —— 视野边缘的半格数据不出结论。
 */
export function planZoneNames(
  points: readonly ZoneNamePoint[] | null | undefined,
  realNames: readonly ZoneRealName[] | null | undefined = [],
  opts: ZoneOpts = {},
): ZonePlan {
  const deg = num(opts.subDeg, WS_ZONE_SUB_DEG);
  const minCount = Math.max(1, Math.trunc(num(opts.minCount, WS_ZONE_MIN_COUNT)));
  const containerDeg = num(opts.containerDeg, deg);
  const containers = containerSetOf(opts.containers);
  const all = zoneBucketsOf(points, opts);
  const buckets = containers
    ? all.filter((b) => containers.has(zoneContainerKeyOf(b.w + deg / 2, b.s + deg / 2, containerDeg)))
    : all;
  const zones: ZoneName[] = [];
  const bySource = { real: 0, derived: 0, generated: 0 };
  const totals: number[] = [];
  const shares: number[] = [];
  let eligible = 0;
  let overHalf = 0;
  let skippedSparse = 0;
  for (const b of buckets) {
    totals.push(b.total);
    const z = zoneNameForCell({ bucket: b, realNames: realNamesOfCell(realNames, b.key, deg) }, opts);
    if (!z) { skippedSparse++; continue; }
    if (b.total >= minCount) {
      eligible++;
      const dom = zoneDominantOf(b);
      if (dom && dom.share > num(opts.dominance, WS_ZONE_DOMINANCE)) overHalf++;
      if (dom && z.source !== "real") shares.push(dom.share);
    }
    zones.push(z);
    bySource[z.source]++;
  }
  /* 排序：真名 → 数据驱动 → 示意；同类按点数降序 → 格键升序（**全确定**） */
  const rank: Record<ZoneSource, number> = { real: 0, derived: 1, generated: 2 };
  zones.sort((a, b) =>
    (rank[a.source] - rank[b.source]) ||
    (b.total - a.total) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    zones,
    cells: buckets.length,
    eligible,
    overHalf,
    bySource,
    totalStats: {
      min: totals.length ? Math.min(...totals) : 0,
      median: median(totals) ?? 0,
      max: totals.length ? Math.max(...totals) : 0,
    },
    shareMedian: median(shares),
    skippedSparse,
    skippedPartial: all.length - buckets.length,
  };
}

/* ══ ⑤ 上屏挑选（上限 + 分开计数；与 `wsLabels.pickLabels` 同一条纪律） ═══════════════════ */

export interface ZonePick {
  shown: ZoneName[];
  candidates: number;
  droppedByCap: number;
  /** **分开计数**（真名/数据驱动/示意三档不许混成一个数） */
  bySource: { real: number; derived: number; generated: number };
  /** 掉出去的那批里各档各有多少（如实报，别只说"丢了 12 个"） */
  droppedBySource: { real: number; derived: number; generated: number };
  cap: number;
  capped: boolean;
}

/**
 * 挑 `cap` 个区名上屏。排序与 `planZoneNames` 的返回序一致（真名 > 数据驱动 > 示意；
 * 同类点数多的先）⇒ 上限一卡，先掉的一定是"示意 + 点少"的那些。
 */
export function pickZoneNames(zones: readonly ZoneName[] | null | undefined, cap: number): ZonePick {
  const list = [...(zones || [])];
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  const bySource = { real: 0, derived: 0, generated: 0 };
  const droppedBySource = { real: 0, derived: 0, generated: 0 };
  const shown = list.slice(0, n);
  const dropped = list.slice(n);
  for (const z of shown) bySource[z.source]++;
  for (const z of dropped) droppedBySource[z.source]++;
  return {
    shown, candidates: list.length, droppedByCap: dropped.length,
    bySource, droppedBySource, cap: n, capped: dropped.length > 0,
  };
}

/* ══ ⑥ 密集判据（"太密集就划区"的触发器）—— 迟滞窗口，数字抄 `DESIGN-MG-MOTION.md` §4.1 ═══ */

/** 进入区名模式：密度信号 ≥ 它，**连续 2 次采样** */
export const WS_ZONE_ENTER_RATIO = 0.45;
/** 退出区名模式：密度信号 ≤ 它，**连续 2 次采样**（0.20 < D < 0.45 = 死区，防横跳） */
export const WS_ZONE_EXIT_RATIO = 0.20;
/** 连续采样次数（实测 16.4→16.6 有非单调回弹 ⇒ 单帧定夺会横跳） */
export const WS_ZONE_SAMPLES = 2;
/** 同一批切换的最短间隔（防抖兜底，毫秒） */
export const WS_ZONE_SWITCH_MIN_MS = 400;

/** 密度信号 = **撞掉数 ÷ 候选数**（直接来自 `wsLabels.pickLabels` 的现成字段） */
export function zoneDensityOf(pick: { droppedByCollision?: number; candidates?: number } | null | undefined): number | null {
  if (!pick) return null;
  const c = Number(pick.candidates);
  if (!Number.isFinite(c) || c <= 0) return null;           // 没候选 ⇒ **数不出来**（不是 0）
  const d = Number(pick.droppedByCollision) || 0;
  return Math.max(0, Math.min(1, d / c));
}

export interface ZoneModeGate {
  /** 喂一次采样 → 返回**这一刻**该不该用区名模式（内部带迟滞与"连续 N 次"） */
  sample(density: number | null, nowMs?: number): { zoneMode: boolean; changed: boolean; reason: string };
  /** 当前状态（不改变任何东西） */
  state(): { zoneMode: boolean; density: number | null; streakEnter: number; streakExit: number; lastSwitchMs: number | null };
  reset(): void;
}

/**
 * 迟滞闸门（纯逻辑，可自检）。语义：
 * · `D ≥ 0.45` 连续 **2** 次 ⇒ 进区名模式；`D ≤ 0.20` 连续 **2** 次 ⇒ 退出；
 * · 死区（0.20 < D < 0.45）**保持原状**（防"缩放边缘反复横跳"）；
 * · `D === null`（没候选，数不出来）⇒ **不改状态**（不许拿"没数据"当"不密集"）；
 * · 同一批切换最短间隔 `WS_ZONE_SWITCH_MIN_MS`（防抖兜底）。
 */
export function createZoneModeGate(opts: { enter?: number; exit?: number; samples?: number; minSwitchMs?: number } = {}): ZoneModeGate {
  const enter = num(opts.enter, WS_ZONE_ENTER_RATIO);
  const exit = num(opts.exit, WS_ZONE_EXIT_RATIO);
  const need = Math.max(2, Math.trunc(num(opts.samples, WS_ZONE_SAMPLES)));
  const minMs = Math.max(0, num(opts.minSwitchMs, WS_ZONE_SWITCH_MIN_MS));
  let zoneMode = false;
  let last: number | null = null;
  let streakEnter = 0;
  let streakExit = 0;
  let lastSwitchMs: number | null = null;
  return {
    sample(density, nowMs) {
      const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      last = Number.isFinite(Number(density)) ? Math.max(0, Math.min(1, Number(density))) : null;
      if (last === null) {
        /* 数不出来 ⇒ 保持原状（连 streak 都不动：它不该被"没量到"喂大） */
        return { zoneMode, changed: false, reason: "密度数不出来（没候选）⇒ 保持原状" };
      }
      streakEnter = last >= enter ? streakEnter + 1 : 0;
      streakExit = last <= exit ? streakExit + 1 : 0;
      const wantEnter = !zoneMode && streakEnter >= need;
      const wantExit = zoneMode && streakExit >= need;
      if (!wantEnter && !wantExit) {
        return {
          zoneMode, changed: false,
          reason: `D=${last.toFixed(3)} ⇒ 保持（进入连 ${streakEnter}/${need} · 退出连 ${streakExit}/${need}${last > exit && last < enter ? " · 死区" : ""}）`,
        };
      }
      if (lastSwitchMs !== null && now - lastSwitchMs < minMs) {
        return { zoneMode, changed: false, reason: `D=${last.toFixed(3)} 够格但距上次切换只有 ${now - lastSwitchMs}ms < ${minMs}ms（防抖）` };
      }
      zoneMode = wantEnter;
      lastSwitchMs = now;
      streakEnter = 0;
      streakExit = 0;
      return { zoneMode, changed: true, reason: `D=${last.toFixed(3)} 连续 ${need} 次 ⇒ ${zoneMode ? "进区名模式" : "退出区名模式"}` };
    },
    state: () => ({ zoneMode, density: last, streakEnter, streakExit, lastSwitchMs }),
    reset() { zoneMode = false; last = null; streakEnter = 0; streakExit = 0; lastSwitchMs = null; },
  };
}

/* ══ ⑦ 署名 + 判词（三态；页面/App 都念同一句） ═══════════════════════════════════════════ */

export interface ZoneIndexLike { attribution?: string | null; source?: string | null; cellSize?: number | null; real?: boolean | null }

/**
 * 署名**原句**：只念包索引里的 `attribution`（ODbL 要求署名随数据走），取不到退回 `source`，
 * 都没有 ⇒ `null`（调用方写"署名取不到"，**绝不编一句**）。
 */
export function zoneAttributionOf(index: ZoneIndexLike | null | undefined): string | null {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}

export type ZoneState =
  /** 索引没读到 ⇒ 连"这一带有几个名字点"都不知道 */
  | "no-index"
  /** 🔴 容器格（取数粒度）与子格（划区粒度）**不相容**（容器边长不是子格整数倍 ⇒ 子格会跨容器）⇒ **本轮不算** */
  | "size-mismatch"
  /** 名字点一条都没有（已量：这个视野里没有真名点） */
  | "no-points"
  /** 正常：有格 ⇒ 报数（**0 个区名也是"已量"的 0**） */
  | "counted";

export interface ZoneFacts {
  state: ZoneState;
  /** 名字点（去重后进统计的）条数 */
  points: number;
  /** 走过的格数 */
  cells: number;
  eligible: number;
  overHalf: number;
  bySource: { real: number; derived: number; generated: number };
  /** 划区粒度（度）：**0.01** —— 与取数粒度（下面那个）**本来就不同**，不是"口径不符" */
  subDeg: number;
  /** **取数**粒度（度）= 包索引自报的 `cellSize`（真名包 = 0.05）；没读到 = null */
  cellSize: number | null;
  /** 容器格 ↔ 子格口径相容（0.05 / 0.01 = 5 ⇒ true） */
  gridOk: boolean;
  /** 🔴 因为容器格没取全（视野边缘半格）而没出结论的子格数 */
  skippedPartial: number;
  attribution: string | null;
  /** 数不出来/异常的原因原文 */
  why: string | null;
}

/** 判词一行。三态：正数 / 0（已量）/ 数不出来（写清原因）。 */
export function zoneVerdictLine(f: ZoneFacts): string {
  if (f.state === "no-index") return `🗺 区名 数不出来：真名包索引没读到（${String(f.why || "index.json 没读到").slice(0, 60)}）`;
  if (f.state === "size-mismatch") {
    return `🗺 区名 数不出来：取数粒度 ${String(f.cellSize)}° 不是划区粒度 ${f.subDeg}° 的整数倍 ⇒ 子格会跨容器，本轮不算`;
  }
  if (f.state === "no-points") return `🗺 区名 0 个（已量：这一轮 ${f.points} 个真名点，格 ${f.cells}）`;
  return `🗺 区名 ${f.bySource.real} 真名 · ${f.bySource.derived} 数据驱动 · ${f.bySource.generated} 示意` +
    `（格 ${f.eligible}/${f.cells} 够格 · 过半 ${f.overHalf} · 点 ${f.points}` +
    (f.skippedPartial > 0 ? ` · 边缘半格未算 ${f.skippedPartial}` : "") + `）`;
}

/**
 * 由 `ZonePlan` + 索引实况算事实（页面/App 同一处；**0 与"数不出来"分得开**）。
 * `ctx.index.cellSize` = **取数**粒度（真名包 0.05）⇒ 用它当容器格做相容性检查：
 * `0.05 / 0.01 = 5` ⇒ 相容；不相容才是真的"数不出来"。
 */
export function zoneFactsOf(
  plan: ZonePlan | null,
  ctx: { points: number; index: ZoneIndexLike | null | undefined; subDeg?: number; indexError?: string | null },
): ZoneFacts {
  const subDeg = num(ctx.subDeg, WS_ZONE_SUB_DEG);
  const idx = ctx.index;
  const containerDeg = idx && Number.isFinite(Number(idx.cellSize)) ? Number(idx.cellSize) : null;
  const base: ZoneFacts = {
    state: "counted",
    points: ctx.points,
    cells: plan ? plan.cells : 0,
    eligible: plan ? plan.eligible : 0,
    overHalf: plan ? plan.overHalf : 0,
    bySource: plan ? plan.bySource : { real: 0, derived: 0, generated: 0 },
    subDeg,
    cellSize: containerDeg,
    gridOk: containerDeg === null ? true : zoneGridCompatible(subDeg, containerDeg),
    skippedPartial: plan ? plan.skippedPartial : 0,
    attribution: zoneAttributionOf(idx),
    why: null,
  };
  if (!idx || containerDeg === null) {
    return { ...base, state: "no-index", why: ctx.indexError || "index.json 没读到" };
  }
  if (!base.gridOk) {
    return { ...base, state: "size-mismatch", why: `取数 ${containerDeg}° / 划区 ${subDeg}°` };
  }
  if (ctx.points === 0) return { ...base, state: "no-points" };
  return base;
}

/* ══ ⑧ 结构断言用的分档（无头里能验的那部分） ═══════════════════════════════════════════ */

/** 屏上样式类：真名 / 数据驱动 / 示意 —— **三档必须不同**（自检钉；机主拍板） */
export function zoneStyleClassOf(z: Pick<ZoneName, "source"> | null | undefined): string {
  const s = z && z.source;
  if (s === "real") return "is-real";
  if (s === "derived") return "is-derived";
  return "is-generated";
}

/** 一条区名可点击（信息卡）—— 两种入口（点楼体 / 点区名）弹的是**同一张**卡 */
export function zoneClickPayload(z: ZoneName): { zoneId: string; zoneKey: string; lng: number; lat: number } {
  return { zoneId: z.id, zoneKey: z.key, lng: z.lng, lat: z.lat };
}
