/**
 * wsOfflineFeed.ts —— App 侧的 **offline-first 取数管道**：离线包 → 累积仓库 → **一次** `setData`。
 *
 * ## 为什么有这一份（机主 2026-09-25 的三条真机反馈）
 * 「**楼只有一块**」「**加载慢**」「**路时有时无**」——三条同源：App 侧一直在走"现场取数 + 整份替换"：
 *   · `/api/buildings` 一次只覆盖视野中心 **R≤2000m**（后端硬闸）且冷查 **27~33s**（最慢见过 91.7s）；
 *   · `/api/roads` 600m 冷查 **32.5s**，默认打一条必然撞超时 ⇒ 屏幕上就是"路没了"；
 *   · 每次取到新的一批就 `setData(这一批)` ⇒ **整份替换**，所以"新的一来旧的没了"。
 * 而离线包是**静态文件**（`/bldbundle/<格>.json`、`/roadsbundle/<格>.json`）：快、可预期、不碰 Overpass。
 *
 * ## 这一份的边界（PR 标准：运行期逻辑只允许一份）
 * ✅ 这里放：按视野取格 → **串行**取数（每格**独立超时**）→ 并进累积仓库 → 淘汰 → 一次 flush。
 * 🔴 **判词 / 决策 / 半径 / 格子数学全在真源**，这里一个都不重写：
 *   · `wsScene.bldLiveDecision()` / `roadsLiveDecision()` —— 默认发不发 `/api/*`；
 *   · `wsScene.bldVerdictText()` / `roadsVerdictText()` —— 三态判词；
 *   · `wsScene.fetchRadiusForView()` / `fetchRadiusLadder()` / `viewHalfMetersOf()` —— live 取数半径；
 *   · `wsFeatureStore.bldBundleCellsForView()` / `roadsBundleCellsForView()` / `createFeatureStore()` ——
 *     格键、格数学、去重与淘汰。
 * ⚠️ 代拍页 `public/ws3dshow.html` 里那套**内联**同类循环是**原型/试验台**的写法（页面 = 试验台）；
 *   App 侧一律走这里，**不许在 `.vue` 里再抄一遍**（自检会钉）。
 *
 * ## 三态纪律
 * `facts()` 里的 `n` 是**数得出来才给数**：仓库缺符号/没有仓库 ⇒ `null`（判词会写「数不出来」），
 * **绝不写 0 冒充"这里没有"**。而 **包外（404）与失败分开计**：包外是"我们没这个包"，
 * 不是"这里没有楼/没有路"（`ROUTE.md`：画面可以编，事实不许编）。
 */

import type { FeatureStore, LngLat } from "./wsFeatureStore";
import { bldBundleCellsForView, placesBundleCellsForView, roadsBundleCellsForView } from "./wsFeatureStore";

export type BundleKind = "bld" | "roads" | "places";

/* ══ 与代拍页**同名同值**的接线常量 ═══════════════════════════════════════════════
   它们不是"规则"（规则在 `wsScene`），是这层管道的**预算**：一次取几格、等多久、仓库上限。
   自检 `ws_app_offline_selftest` 会拿 `public/ws3dshow.html` 里那份内联值逐个对拍 —— 两边
   一旦漂移就红（"同一套"必须是数得出来的同一套，不是嘴上说的）。 */

/** 一格离线包的**独立超时**（静态文件；拿不到就记 failed 并说出来，绝不占用 live 预算、不堵首屏） */
export const BUNDLE_TIMEOUT_MS = 6000;
/** 一次 refresh 最多取几格（**串行**、后台、不阻塞首屏） */
export const BLD_BUNDLE_PER_REFRESH = 2;
export const ROADS_BUNDLE_PER_REFRESH = 2;
/** 视野需要哪些格：计划里最多留几格（多的记 `capped`，HUD 如实写"只取了最近的"） */
export const BLD_BUNDLE_MAX_CELLS = 6;
export const ROADS_BUNDLE_MAX_CELLS = 8;
/** 帧率护栏：仓库上限（超了按"离视野中心距离"淘汰）。与代拍页同值；真能画多少**只有真机可判**。 */
/** 🏘 片区名的取数节奏/上限（点很稀、文件只有几 KB ⇒ 一次可以多取几格） */
export const PLACES_BUNDLE_PER_REFRESH = 4;
export const PLACES_BUNDLE_MAX_CELLS = 6;
export const PLACES_STORE_CAP = 3000;
export const BLD_STORE_CAP = 12000;
export const ROADS_STORE_CAP = 6000;

/* ══ 离线包的静态路径（**只这一份**：App 侧谁都不许再拼字面量） ═════════════════════ */

/**
 * 一格包的 URL。`kind` → 目录名，**一律查 `SPECS`**（三个包一套规则）。
 * 🔴 2026-09-25 真踩到：这里原来是 `kind === "bld" ? "bldbundle" : "roadsbundle"` 的**三元**
 * ⇒ 加了 `"places"` 之后，片区名的格子被拼成 `/roadsbundle/…`：请求发到了**路的包**，
 * 解析出来 0 个点（HUD 上看着像"包是空的"），而 `fetchLog` 里根本没有 `/placesbundle/`。
 * ⇒ 教训：**新加一种包时，凡是有"目录名"的地方都必须走同一张表**（自检里现在钉着这条）。
 */
export function bundleCellUrl(kind: BundleKind, cellKey: string): string {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${spec.dir}/${cellKey}.json`;
}

/**
 * 离线包的**清单**（`index.json`）：里面的 `source` 就是**署名原句**（由导出脚本写进去）。
 * 署名要求的是"复用同一句常量，别改写第二版" ⇒ 这里**只用包里的原句**，TS 里不重写一句。
 */
export function bundleIndexUrl(kind: BundleKind): string {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${spec.dir}/index.json`;
}

/* ══ 取数接口（宿主无关：浏览器给 `fetch`，自检给假实现） ═══════════════════════════ */

/** 一格包的响应（只声明用到的三个成员；`Response` 与自检的假响应都满足） */
export interface BundleResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}
/** 取数实现（`fetchWithTimeout()` 就是给浏览器 `fetch` 用的那一份） */
export type BundleFetch = (url: string, timeoutMs: number) => Promise<BundleResponse>;

export interface BundleBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}
/** 视野（宿主无关：App 把地图的 bounds/center 递进来） */
export interface BundleView {
  bounds: BundleBoundsLike | null;
  center: { lng: number; lat: number } | null;
}

/** 楼房要素：几何是**一块**（MultiPolygon 已在解析时拆成多个要素 —— 不编数据，只是拆开画） */
export interface BundleBuildingFeature {
  type: "Feature";
  id: string;
  properties: Record<string, unknown>;
  geometry: { type: "Polygon"; coordinates: number[][][] };
}
export interface BundleRoadFeature {
  type: "Feature";
  id: string;
  properties: Record<string, unknown>;
  geometry: { type: "LineString"; coordinates: number[][] };
}

/**
 * 浏览器取数 + **独立超时**（`AbortController`）。
 * 超时原文写清楚（HUD/面板要显示"为什么这格失败"），不静默。
 */
export async function fetchWithTimeout(
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<BundleResponse>,
  url: string,
  ms: number = BUNDLE_TIMEOUT_MS
): Promise<BundleResponse> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    return await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined);
  } catch (e) {
    const why = (e as { name?: string } | null)?.name === "AbortError" ? `超时 ${Math.round(ms / 1000)}s` : String(e);
    throw new Error(why);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ══ 解析：包里的紧凑字段 → **与现场 `/api/buildings`、`/api/roads` 同一形状的要素** ═══════
   为什么必须同形状：下游（`wsBuildingLook.renderHeight` / `decorateBuildings` / HUD 分档）就不必
   知道"这批楼是从包来的还是从接口来的" —— 两条来源走同一条上妆与计数通路，才不会出现
   "包来的楼全落进『按类型估』"这种静默降级。 */

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一格**楼房**包 → 要素。
 * 请求字段（见 `world_map/export_bld_bundle.py`）：`i` 短 id / `p` 各块外环 / `h` 真高(米) /
 * `f` 层数 / `c` 类型 / `n` 名字。包里**全是 Overture 真脚印**（real，ODbL）。
 */
export function bundleBuildingsOf(json: unknown): BundleBuildingFeature[] {
  const arr = (json as { bld?: unknown } | null)?.bld;
  /* 🔴 缺 `bld` 字段 = **包坏了/取错了** ⇒ 抛错记 failed（可见）；空数组才是"这格确实 0 栋" */
  if (!Array.isArray(arr)) throw new Error("bldbundle 里没有 bld 数组");
  const out: BundleBuildingFeature[] = [];
  for (const raw of arr) {
    const b = raw as { i?: unknown; p?: unknown; h?: unknown; f?: unknown; c?: unknown; n?: unknown } | null;
    if (!b) continue;
    const id = String(b.i ?? "");
    if (!id) continue;
    const parts = Array.isArray(b.p) ? (b.p as unknown[]) : [];
    for (let k = 0; k < parts.length; k++) {
      const ring = parts[k];
      if (!Array.isArray(ring) || ring.length < 4) continue;
      /* 一块一个要素 ⇒ id 加 `#k` 后缀（**不是编数据**：几何/高度/来源全部原样） */
      const fid = parts.length > 1 ? `${id}#${k}` : id;
      const h = num(b.h);
      const floors = num(b.f);
      const props: Record<string, unknown> = {
        osm_id: fid,
        /* 出处如实标：`src` = 来自离线包；`bsrc` = 上游是 Overture（ODbL，署名随数据走） */
        src: "bundle",
        bsrc: "overture",
        kind: b.c === undefined || b.c === null ? "yes" : String(b.c),
        name: b.n === undefined || b.n === null ? "" : String(b.n),
      };
      if (h !== null && h > 0) {
        props.height = h;
        props.height_src = "height";
      } else if (floors !== null && floors > 0) {
        /* 与后端同一口径：层数折进 `height`（×3m），档位标 `levels` ⇒ HUD 的"层数"那一列才算得对 */
        props.height = Math.min(500, Math.round(floors * 3 * 10) / 10);
        props.height_src = "levels";
      } else {
        props.height_src = "default";
      }
      if (floors !== null && floors > 0) props.levels = floors;
      out.push({
        type: "Feature",
        id: fid,
        properties: props,
        geometry: { type: "Polygon", coordinates: [ring as number[][]] },
      });
    }
  }
  return out;
}

/** 一格**路网**包 → 要素（`i` id / `r` 等级 / `n` 名字 / `p` 折线） */
export function bundleRoadsOf(json: unknown): BundleRoadFeature[] {
  const arr = (json as { roads?: unknown } | null)?.roads;
  if (!Array.isArray(arr)) throw new Error("roadsbundle 里没有 roads 数组");
  const out: BundleRoadFeature[] = [];
  for (const raw of arr) {
    const x = raw as { i?: unknown; r?: unknown; n?: unknown; p?: unknown } | null;
    if (!x || !Array.isArray(x.p) || (x.p as unknown[]).length < 2) continue;
    const id = String(x.i ?? "");
    if (!id) continue;
    out.push({
      type: "Feature",
      id,
      properties: {
        osm_id: id,
        rank: num(x.r),
        name: x.n === undefined || x.n === null ? "" : String(x.n),
        src: "bundle",
        bsrc: "osm",
      },
      geometry: { type: "LineString", coordinates: x.p as number[][] },
    });
  }
  return out;
}

/* ══ 仓库的去重键 / 代表点（`createFeatureStore` 只吃这三个参数 —— 合并与淘汰规则不在这里） ══ */

/** 楼房：稳定 id（取不到返回 null ⇒ 仓库如实计 `noId`，不去重也不丢） */
/** 🏘 离线片区名包里的一条（`{n: 名字, k: place 类型, p: [lng,lat], i: 稳定 id}`） */
export interface BundlePlaceFeature {
  n: string;
  k: string;
  p: [number, number];
  i: string;
}

/**
 * 解析片区名包。🔴 **没有名字的一条都不留**（`ROUTE.md` 铁律：缺名字就不显示、**绝不编**）；
 *    类型不认得的也留着（由 `wsLabels.placeTierOf` 决定显不显示 —— 这里不替它做判断）。
 */
export function bundlePlacesOf(json: unknown): BundlePlaceFeature[] {
  const arr = (json as { places?: unknown })?.places;
  if (!Array.isArray(arr)) return [];
  const out: BundlePlaceFeature[] = [];
  for (const it of arr) {
    const o = it as Partial<BundlePlaceFeature> | null;
    const name = String(o?.n ?? "").trim();
    if (!name) continue;                                   // **红线：没名字不导出也不显示**
    const pt = o?.p;
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    out.push({ n: name, k: String(o?.k ?? ""), p: [Number(pt[0]), Number(pt[1])], i: String(o?.i ?? name) });
  }
  return out;
}

/** 片区名的去重键（包里的 `i`；没有就退回"类型:名字"） */
export function placesIdOf(f: BundlePlaceFeature): string | null {
  return String(f?.i || (f?.k ? f.k + ":" + f.n : f?.n) || "") || null;
}

export function placesPointOf(f: BundlePlaceFeature): LngLat | null {
  const p = f?.p;
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
}

export function bldIdOf(f: BundleBuildingFeature): string | null {
  const p = (f && f.properties) || {};
  const id = (p.store_id as string) || (p.osm_id as string) || (p.id as string) || (f && f.id);
  return id ? String(id) : null;
}
/** 楼房代表点：外环质心（淘汰按"离视野中心多远"）；取不到 ⇒ null（不参与淘汰，也不丢） */
export function bldPointOf(f: BundleBuildingFeature): LngLat | null {
  const ring = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  for (const q of ring) {
    if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) {
      x += q[0] as number;
      y += q[1] as number;
      n++;
    }
  }
  return n ? [x / n, y / n] : null;
}
export function roadsIdOf(f: BundleRoadFeature): string | null {
  const p = (f && f.properties) || {};
  const id = (p.osm_id as string) || (p.id as string) || (f && f.id);
  return id ? String(id) : null;
}
/** 路代表点：折线中点（与代拍页同一取法：中位顶点，不是几何中点） */
export function roadsPointOf(f: BundleRoadFeature): LngLat | null {
  const c = f?.geometry?.coordinates || [];
  const m = c[Math.floor(c.length / 2)];
  return m && Number.isFinite(m[0]) && Number.isFinite(m[1]) ? [m[0], m[1]] : null;
}

/* ══ 一种包的全部"跟着包走"的知识（路径 / 计划 / 解析 / 预算）—— 集中在这里，页面只接线 ══ */

interface BundleKindSpec<T> {
  dir: string;
  plan: (bounds: BundleBoundsLike | null, center: { lng: number; lat: number } | null, maxCells: number) => {
    cells: Array<{ key: string; w: number; s: number }>;
    wanted: number;
    capped: boolean;
  } | null;
  parse: (json: unknown) => T[];
  perRefresh: number;
  maxCells: number;
  /** 仓库的来源键（`store.has()` 用；与代拍页同式） */
  sourceKey: (cellKey: string) => string;
  /** 单格计数单位（HUD 文案） */
  unit: string;
}

const SPECS = {
  bld: {
    dir: "bldbundle",
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number) => bldBundleCellsForView(b, c, maxCells),
    parse: bundleBuildingsOf,
    perRefresh: BLD_BUNDLE_PER_REFRESH,
    maxCells: BLD_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `bldbundle:${k}`,
    unit: "栋",
  } as unknown as BundleKindSpec<BundleBuildingFeature>,
  places: {
    dir: "placesbundle",
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number) => placesBundleCellsForView(b, c, maxCells),
    parse: bundlePlacesOf,
    perRefresh: PLACES_BUNDLE_PER_REFRESH,
    maxCells: PLACES_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `placesbundle:${k}`,
    unit: "个",
  } as unknown as BundleKindSpec<BundlePlaceFeature>,
  roads: {
    dir: "roadsbundle",
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number) => roadsBundleCellsForView(b, c, maxCells),
    parse: bundleRoadsOf,
    perRefresh: ROADS_BUNDLE_PER_REFRESH,
    maxCells: ROADS_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `bundle:${k}`,
    unit: "条",
  } as unknown as BundleKindSpec<BundleRoadFeature>,
};

/* ══ 可数口径（HUD/面板只读它 —— 页面不自己数、更不自己编） ═══════════════════════════ */

export interface BundleFeedFacts {
  /** 仓库要素数；**`null` = 数不出来**（绝不写 0 冒充"没有"） */
  n: number | null;
  have: number;
  /** 包外（404）：这一格包里没有 —— **不是失败，也不是"这里没有楼/路"** */
  missing: number;
  failed: number;
  pending: number;
  cap: number | null;
  /** 视野共需几格（`capped` 时 HUD 写"只取了最近的"）；数不出来 = null */
  wanted: number | null;
  /** 这一轮计划是不是被 `maxCells` 截过 */
  capped: boolean;
  /** 🗂 包里那张**索引**（`index.json`）的实况 —— HUD 要能回答"包外是读来的还是猜的" */
  index: { state: "未读" | "读取中" | "已读" | "失败"; cells: number | null; keys: number | null;
           why: string | null; attribution: string | null; real: boolean | null };
  /** 累计并进仓库的要素数 */
  got: number;
  /** 有没有为这一种包**真的计划过取数**（false ⇒ HUD 写"未取"，而不是编一个 0） */
  asked: boolean;
}

export interface BundleRefreshReport {
  /** 视野算不出格（bounds 拿不到）⇒ 什么都没做 */
  planned: boolean;
  /** 这次真的取了几格 */
  batch: number;
  /** 这次并进仓库几个要素 */
  got: number;
  capped: boolean;
}

export interface BundleFeed<T> {
  /** 按视野取**最多 perRefresh 格**（串行、每格独立超时）⇒ 合并 ⇒ 一次 flush。**永不发 `/api/*`** */
  refresh(why?: string): Promise<BundleRefreshReport>;
  facts(): BundleFeedFacts;
  /** 视野需要的格（自检/面板回证用；不取数） */
  plan(): { keys: string[]; wanted: number; capped: boolean } | null;
}

export interface BundleFeedOptions<T> {
  kind: BundleKind;
  /** 累积仓库（**由调用方用 `wsFeatureStore.createFeatureStore()` 造** —— 合并/淘汰规则只有那一份） */
  store: FeatureStore<T>;
  view: () => BundleView;
  fetchCell: BundleFetch;
  /** 合并 + 淘汰之后**一次性**写进地图（页面只接线；App 在这里做上妆 + `setData`） */
  flush: (why: string) => void;
  /** 淘汰半径（米）：保留"视野外一圈" ⇒ 来回挪地图不该反复重取 */
  retainRadiusM: () => number;
  /** 失败原文（给 HUD/面板 —— 不静默空着） */
  onError?: (why: string) => void;
}

/**
 * 建一条离线包管道。
 *
 * 🔴 三条硬性质（自检逐条钉住）：
 *   ① **串行**：一次 refresh 里一格一格取（并发峰值 = 1），且**只打离线包**（不含 `/api/`）；
 *   ② **换视野要素数不减**：新数据是 `merge` 进仓库（去重并集），淘汰只丢"视野外一圈"与超上限的；
 *   ③ **并发刷新不重取同一格**：正在取时再来一次 ⇒ 只记一次"待补"，不重复下载（省流量、也不重复计数）。
 */
export function createBundleFeed<T>(opts: BundleFeedOptions<T>): BundleFeed<T> {
  const spec = SPECS[opts.kind] as unknown as BundleKindSpec<T>;
  const have = new Set<string>();
  const missing = new Set<string>();
  const failed = new Set<string>();
  let pending = 0;
  let got = 0;
  let wanted: number | null = null;
  let capped = false;
  let asked = false;
  let busy = false;
  let queued = false;
  /* 🗂 **索引优先**（父代理 2026-09-25 体检：index 早就生成了，页面却从不请求、靠试 404 猜）：
     先读一次 `<包>/index.json` ⇒ 只对"索引里有的格"发请求；索引里没有的格直接记 `missing`（**包外**，
     零请求、且是**读来的事实**）。索引取不到 ⇒ **如实退回**试格子（`indexState="失败"`，HUD 写出来）。 */
  let indexFact: BundleIndexFact | null = null;
  let indexState: "未读" | "读取中" | "已读" | "失败" = "未读";
  let indexWhy: string | null = null;
  let indexPromise: Promise<BundleIndexFact> | null = null;

  function ensureIndex(): Promise<BundleIndexFact> {
    if (indexPromise) return indexPromise;
    indexState = "读取中";
    indexPromise = loadBundleIndex(opts.fetchCell, opts.kind).then((f) => {
      indexFact = f;
      if (f.cells) { indexState = "已读"; indexWhy = null; }
      else { indexState = "失败"; indexWhy = "索引没读到（退回试格子）"; opts.onError?.(`index ${spec.dir} 没读到，退回试格子`); }
      return f;
    });
    return indexPromise;
  }

  function counters(): BundleFeedFacts {
    let n: number | null = null;
    let cap: number | null = null;
    try {
      const st = opts.store.stats();
      n = Number.isFinite(st.n) ? st.n : null;
      cap = Number.isFinite(st.cap) ? st.cap : null;
    } catch {
      n = null; // 数不出来就说数不出来
    }
    return {
      n, have: have.size, missing: missing.size, failed: failed.size,
      pending, cap, wanted, capped, got, asked,
      index: {
        state: indexState,
        cells: indexFact && indexFact.cellCount !== null ? indexFact.cellCount : null,
        keys: indexFact && indexFact.cells ? indexFact.cells.size : null,
        why: indexWhy,
        attribution: (indexFact && (indexFact.attribution || indexFact.source)) || null,
        real: indexFact ? indexFact.real : null,
      },
    };
  }

  function planned(): { keys: string[]; wanted: number; capped: boolean } | null {
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, spec.maxCells);
    if (!p) return null;
    return { keys: p.cells.map((c) => c.key), wanted: p.wanted, capped: p.capped };
  }

  async function runOnce(why: string): Promise<BundleRefreshReport> {
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, spec.maxCells);
    if (!p) return { planned: false, batch: 0, got: 0, capped: false };
    asked = true;
    wanted = p.wanted;
    capped = p.capped;
    /* 🗂 **先读索引**（一次；失败就退回试格子）—— 索引里没有的格 = **包外**，零请求 */
    const idx = await ensureIndex();
    /* 已经取过的格不重取；**包外**的也不重试（404/索引判包外 都是"包里没有"，重试只白费流量） */
    const todo: typeof p.cells = [];
    for (const c of p.cells) {
      if (opts.store.has(spec.sourceKey(c.key))) continue;
      if (missing.has(c.key)) continue;
      if (idx.cells) {
        if (idx.cells.has(c.key)) todo.push(c);
        else missing.add(c.key);            // **包外**（读来的事实，不是猜的）
        continue;
      }
      todo.push(c);                          // 索引没读到：退回老办法（试）
    }
    const batch = todo.slice(0, spec.perRefresh);
    if (!batch.length) return { planned: true, batch: 0, got: 0, capped: p.capped };

    pending += batch.length;
    let n = 0;
    for (const cell of batch) {
      try {
        const r = await opts.fetchCell(bundleCellUrl(opts.kind, cell.key), BUNDLE_TIMEOUT_MS);
        if (r.status === 404) {
          /* **包外**（不是失败、更不是"这里没有"）：如实记下来，HUD 会写"包外 N" */
          missing.add(cell.key);
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const feats = spec.parse(j);
        opts.store.merge(feats, spec.sourceKey(cell.key));
        have.add(cell.key);
        got += feats.length;
        n += feats.length;
      } catch (e) {
        failed.add(cell.key);
        const why0 = String((e as Error)?.message || e || "取数失败").slice(0, 60);
        opts.onError?.(`${spec.dir} ${cell.key} ${why0}`);
      } finally {
        pending -= 1;
      }
    }
    /* 淘汰只在**超出保留半径/上限**时动手（保留"视野外一圈" ⇒ 来回挪不该重取） */
    try {
      const c = opts.view().center;
      if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
        opts.store.retainNear([c.lng, c.lat], opts.retainRadiusM());
      }
    } catch {
      /* 淘汰失败不影响显示（下一轮再试） */
    }
    opts.flush(`${why}+${batch.length}`);
    return { planned: true, batch: batch.length, got: n, capped: p.capped };
  }

  return {
    async refresh(why = "view") {
      /* 正在取 ⇒ 只排一次队（不重复下载同一格；排队的这一次会在当前轮结束后补上） */
      if (busy) {
        queued = true;
        return { planned: false, batch: 0, got: 0, capped };
      }
      busy = true;
      try {
        const r = await runOnce(why);
        if (queued) {
          queued = false;
          const r2 = await runOnce(why);
          return { planned: r.planned || r2.planned, batch: r.batch + r2.batch, got: r.got + r2.got, capped: r2.capped || r.capped };
        }
        return r;
      } finally {
        busy = false;
      }
    },
    facts: counters,
    plan: planned,
  };
}

/* ══ 清单（署名原句） ═══════════════════════════════════════════════════════════════ */

export interface BundleIndexFact {
  kind: BundleKind;
  url: string;
  /** **包里写的那句署名**（原句；取不到 = null ⇒ 面板写"署名取不到"，不编一句） */
  source: string | null;
  /** 包里一共几格（数不出来 = null） */
  cellCount: number | null;
  /** 包里**有数据的格键**（`Set`）；`null` = 索引没读到 ⇒ 只能退回"试格子"（不许当成"包外"） */
  cells: Set<string> | null;
  /** 可机读署名（`index.json.attribution`；老包没有这个字段 = null） */
  attribution: string | null;
  /** 是不是**真实数据**包（`index.json.real`；缺失 = null ⇒ 不许猜） */
  real: boolean | null;
}

/**
 * 读一张离线包的清单，把**署名原句**取回来。
 * 为什么走清单而不是在 TS 里写一句：`ROUTE.md` 要求"复用同一句常量，别改写第二版"——
 * 最不容易漂的做法就是**让导出脚本那句原话随包走**，页面照抄显示。
 */
export async function loadBundleIndex(fetchCell: BundleFetch, kind: BundleKind): Promise<BundleIndexFact> {
  const url = bundleIndexUrl(kind);
  try {
    const r = await fetchCell(url, BUNDLE_TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { source?: unknown; cellCount?: unknown; cells?: unknown; attribution?: unknown; real?: unknown } | null;
    const rawCells = (j?.cells && typeof j.cells === "object") ? Object.keys(j.cells as Record<string, unknown>) : null;
    return {
      kind, url,
      source: typeof j?.source === "string" && j.source ? j.source : null,
      cellCount: num(j?.cellCount),
      cells: rawCells ? new Set(rawCells) : null,
      attribution: typeof j?.attribution === "string" && j.attribution ? j.attribution : null,
      real: typeof j?.real === "boolean" ? j.real : null,
    };
  } catch {
    return { kind, url, source: null, cellCount: null, cells: null, attribution: null, real: null };
  }
}

/* ══ HUD/面板那一行的**可数口径**（只这一份格式化 ⇒ 页面不自己拼数字，也不可能把"数不出来"写成 0） ══ */

/**
 * `🏢 离线格 已取 x / 包外 y / 失败 z · 仓库 N 栋`（三态：数不出来照实写）。
 * @param icon HUD 图标（`🏢` / `🛣`）
 * @param unit `栋` / `条`
 */
export function bundleCountsLine(f: BundleFeedFacts, icon: string, unit: string): string {
  if (!f.asked && f.have === 0 && f.missing === 0 && f.failed === 0) {
    return `${icon} 离线格 未取（还没要数据）`;
  }
  const idx = f.index
    ? (f.index.state === "已读" ? `（索引 ${f.index.cells === null ? "?" : f.index.cells} 格）`
      : f.index.state === "失败" ? "（索引失败：退回试格子）" : `（索引${f.index.state}）`)
    : "";
  const head = `${icon} 离线格 已取 ${f.have} / 包外 ${f.missing} / 失败 ${f.failed}${idx}`;
  const pend = f.pending > 0 ? ` / 待取 ${f.pending}` : "";
  const store = f.n === null ? "数不出来" : String(f.n);
  const cap = f.capped ? `（视野共需 ${f.wanted === null ? "?" : f.wanted} 格，只取了最近的）` : "";
  return `${head}${pend} · 仓库 ${store} ${unit}${cap}`;
}

/* ══ 判词用哪一个**态**（只选态；句子一律由 `wsScene.bldVerdictText/roadsVerdictText` 给） ══════
   为什么"选态"也要单独一份：选错态的后果是**把"我们没这个包"说成"这里没有楼"**（反之亦然）——
   那正是判词纪律要防的事。所以这条规则只有一个地方，并且自检逐态钉住。 */

/** 楼房的态：`outside`（包外）与 `failed`（取数失败）必须分得开，也不许把"还在取"写成"没有" */
export function bldVerdictState(f: BundleFeedFacts): "bundle" | "outside" | "pending" | "failed" {
  /* ⚠️ `missing` 现在有**两个来源**：索引说"包里没这格"（读来的）与 404（试出来的）——
     两者都是**包外**，判词一视同仁（"我们没这个包"，不是"这里没有楼"）。 */
  if (f.pending > 0 && f.n === 0 && f.have === 0) return "pending";
  if (f.n === 0 && f.have === 0 && f.missing > 0) return "outside";
  if (f.n === 0 && f.have === 0 && f.failed > 0 && f.missing === 0) return "failed";
  return "bundle";
}

/** 路的态（真源 `roadsVerdictText` **没有** `outside` 这一态 ⇒ 包外只在计数行里如实写） */
export function roadsVerdictState(f: BundleFeedFacts): "bundle" | "pending" | "failed" {
  if (f.pending > 0 && f.n === 0 && f.have === 0) return "pending";
  if (f.n === 0 && f.have === 0 && f.failed > 0 && f.missing === 0) return "failed";
  return "bundle";
}
