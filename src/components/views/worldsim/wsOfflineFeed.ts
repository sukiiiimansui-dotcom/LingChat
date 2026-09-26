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
import {
  BLD_BUNDLE_CELL_DEG, PLACES_BUNDLE_CELL_DEG, ROADS_BUNDLE_CELL_DEG,
  bldBundleCellsForView, placesBundleCellsForView, roadsBundleCellsForView,
  /* 🌊 水/绿地与别的包**同一套格数学**（`floor(x/deg)*deg`）；它没有自己的 `*BundleCellsForView`
     包装（不加第二个名字 = 少一处能写歪的地方），直接在 `SPECS.gw.plan` 里传格边长。 */
  bundleCellsForView,
} from "./wsFeatureStore";
/* ⏱ 计时尺子（唯一一份，见 `wsPerfMeter`）：管道里"每格取多久 / 解析多久 / 并仓多久"必须可数，
   否则机主那句「加载慢」只能靠感觉 —— 有了它，首屏能拆成"网络 vs 解析 vs 计算"三段。 */
import { pmMark, pmNow, pmSetContext, pmSpan, pmTimeAsync } from "./wsPerfMeter";

/**
 * 这条 URL 的**真实字节数**（从 Resource Timing 读；同源 ⇒ `decodedBodySize` 可用）。
 * 为什么读它而不是自己 `text().length`：后者要**多读一遍 body**（首屏最不该加的那份工），
 * 而 Resource Timing 是浏览器网络层的账本。取不到 ⇒ `null`（**不写 0 冒充"没字节"**）。
 */
function netBytesOf(url: string): number | null {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null;
    const es = performance.getEntriesByName(url) as PerformanceResourceTiming[];
    const e = es && es.length ? es[es.length - 1] : null;
    if (!e) return null;
    const n = Number(e.decodedBodySize || e.transferSize || 0);
    return n > 0 ? n : null;
  } catch { return null; }
}

/* 🌊🌳 **水/绿地**也走同一条管道（2026-09-26「搬进 lingchat」）：它是**第四种离线包**，不是特例 ——
   目录名 / 格尺寸 / 计划 / 解析 / 预算全在下面 `SPECS.gw` 里，于是"索引优先 / 串行取格 / 每格独立超时 /
   包外与失败分开计"这些规矩**一份都不用再写**（机主选的方向是「自己画」：Esri 底图在这一带
   两个服务都只给占位图，屏上就没有水也没有绿植）。 */
export type BundleKind = "bld" | "roads" | "places" | "gw";

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
/* ══ 🏢 **楼房仓库上限**：机主 2026-09-26 拍板「远景容量放宽到 30000~50000 栋」═════════════
   上限同时是**帧率护栏**的一半（另一半是保留半径）⇒ 不能拍脑袋加。实测（`~/chk/_cap_cost.mjs`，
   真包 + 每档独立子进程 + gc；z13 样保留半径 14km，本机 aarch64）：

   | 上限   | 仓库占格 | heapUsed(稳态) | 淘汰/轮 | 挑楼(冷/热) | 画出去 | 视野内 |
   |--------|---------|---------------|--------|------------|--------|--------|
   | 12,000 |   4     | +23.0MB       | 155ms  | 207 / **27ms** |  307  | 275 |
   | 30,000 |  10     | +33.8MB       | 257ms  | 318 / **63ms** |  813  | 412 |
   | 50,000 |  14     | +48.6MB       | 268ms  | 596 / 185ms    | 1030  | 301 |
   | 100,000|  20     | +73.3MB       | 274ms  | 1303 / 198ms   | 1054  |  —  |

   · **保留半径 2km（默认机位）时上限根本不生效**：任何上限都是 2,544 栋 / 3 格
     ⇒ 放宽上限**不影响默认机位的观感与内存**，只影响 z≤13.5 那一档。
   · 挑楼的"热"值是真实场景（每轮 flush 重扫同一批要素对象）：`wsBuildingPick` 的
     `derivedOf` 记忆化之后 12k 从 ~70ms 降到 ~27ms ⇒ **30,000 的新增成本比"改之前 12,000"还低**。
   · 但**装得下 ≠ 取得到**：一轮只取 `BLD_BUNDLE_MAX_CELLS`(6) 格、每次刷新取 2 格
     ⇒ 只把上限调大，z13 的实际格数仍被取数预算卡在 6 格（≈9.6MB / 62,405 栋）。
     要真拿到 10 格：`最近 10 格 = 14.0MB`（≈1.4s 解析，一次性，之后走解析缓存）。
   ⇒ **推荐值 30,000**（区间低端：+10.8MB 换 2.6 倍画出的楼，且挑楼比改前还快）；
     50,000 的边际收益只有 +27% 的格数，却要 ~3 倍的挑楼耗时。 */
/**
 * 🧮 **一轮取数的字节预算**（默认 1.5MB）：格数不再是主要闸门 —— 细格包上一轮可以取十几格，
 * 但"这一轮下多少字节"必须封顶（否则用户看到的就是"转圈半天"）。
 * 1.5MB 对老包（0.05°、单格中位 205KB / 最大 1.9MB）≈ 今天"一轮 2 格"的量级；
 * 对细格包（0.01°、单格中位 57KB）≈ 一轮十几到二十几格 ⇒ **同一条规则，两种粒度都对**。
 * 取不到索引里的 `bytes`（老索引没这字段）⇒ 退回按格数（不猜）。
 */
export const BUNDLE_BYTES_PER_ROUND = 1.5 * 1048576;
/** 一轮最多发几条格子请求（串行也有排队成本；细格包上"十几格"是合理的，几十条不是） */
export const BUNDLE_REQ_PER_ROUND_MAX = 16;
export const BLD_STORE_CAP = 30000;
/** **实测推荐值**（机主给的区间低端）。改默认时要**页面与 App 一起改**（自检钉着"两处同值"）。 */
export const BLD_STORE_CAP_RECOMMENDED = 30000;
/** 机主给的上界（2026-09-26）：超过这个数不接受（再多人也看不完，内存先爆）。 */
export const BLD_STORE_CAP_MAX = 50000;
/**
 * 把"想要的仓库上限"收进合法区间（**可配的唯一入口**：页面/App 都调它，别各自写 clamp）。
 * 取不到/坏值 ⇒ 回默认值（**不猜**）；过小 ⇒ 2000 兜底；过大 ⇒ `BLD_STORE_CAP_MAX`。
 */
export function resolveBldStoreCap(requested?: number | null): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return BLD_STORE_CAP;
  return Math.max(2000, Math.min(BLD_STORE_CAP_MAX, Math.floor(n)));
}
export const ROADS_STORE_CAP = 6000;

/* 🌊🌳 水/绿地的**格边长**：0.05° —— 与 `public/gwbundle/*.json` 里每一格自报的 `cellSize` **实测一致**
   （index 5 格 / 359 面）。🔴 这个数**只此一份**：前端算格键与"包自报口径"对拍都用它，
   绝不允许"包里写多少就按多少算"（2026-09-25 那次 0.02/0.05 两套口径的事故，
   后果是把**有数据**的格说成「包外」—— 把有说成没有）。 */
export const GW_BUNDLE_CELL_DEG = 0.05;
/* 水/绿包很小（实测 5 格 / 359 面、单格几十 KB）⇒ 一轮**一次取完**：与代拍页原来"一轮取完再报数"同口径，
   少一次"格 2/6"的中间态（判词那一行也就不会在首屏闪一下）。 */
export const GW_BUNDLE_PER_REFRESH = 6;
/** 视野里最多留几格（与代拍页 `keys.slice(0, 6)` 同值） */
export const GW_BUNDLE_MAX_CELLS = 6;
/** 水/绿的仓库上限（帧率护栏的一部分；实测全城 359 面，给足余量） */
export const GW_STORE_CAP = 4000;

/* ══ 离线包的静态路径（**只这一份**：App 侧谁都不许再拼字面量） ═════════════════════ */

/**
 * 一格包的 URL。`kind` → 目录名，**一律查 `SPECS`**（三个包一套规则）。
 * 🔴 2026-09-25 真踩到：这里原来是 `kind === "bld" ? "bldbundle" : "roadsbundle"` 的**三元**
 * ⇒ 加了 `"places"` 之后，片区名的格子被拼成 `/roadsbundle/…`：请求发到了**路的包**，
 * 解析出来 0 个点（HUD 上看着像"包是空的"），而 `fetchLog` 里根本没有 `/placesbundle/`。
 * ⇒ 教训：**新加一种包时，凡是有"目录名"的地方都必须走同一张表**（自检里现在钉着这条）。
 */
export function bundleCellUrl(kind: BundleKind, cellKey: string, dir?: string): string {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${dir || dirsOf(spec)[0]}/${cellKey}.json`;
}

/**
 * 离线包的**清单**（`index.json`）：里面的 `source` 就是**署名原句**（由导出脚本写进去）。
 * 署名要求的是"复用同一句常量，别改写第二版" ⇒ 这里**只用包里的原句**，TS 里不重写一句。
 */
export function bundleIndexUrl(kind: BundleKind, dir?: string): string {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${dir || dirsOf(spec)[0]}/index.json`;
}

/**
 * 📦 **一种包可以有几个候选目录**（按优先级）：先来的先用，索引读不到就退下一个。
 *
 * 为什么需要（2026-09-26，机主拍板「按视野取格/分片」）：分片后**格尺寸会变小**（0.05° → 0.01°），
 * 而"老包是唯一被端到端验过的一版"（App / 城市包 / 代拍页都在吃它）⇒ **两版必须能并存**：
 * 新版放自己的目录、索引里自报 `cellSize`，客户端**按索引里的数算格键**（不再写死），
 * 老包还在就继续能跑。真要指定目录：`?bdir=<名字>`（排查/A-B 用）。
 */
function dirsOf(spec: { dir: string; dirs?: string[] }): string[] {
  const list = (spec.dirs && spec.dirs.length ? spec.dirs : [spec.dir]).slice();
  /* `?bdir=` 覆盖（只认列在候选里的，避免拼错目录名去猜） */
  try {
    if (typeof location !== "undefined" && location.search) {
      const m = /[?&]bdir=([A-Za-z0-9._-]+)/.exec(location.search);
      if (m && list.indexOf(m[1]) >= 0) return [m[1]].concat(list.filter((d) => d !== m[1]));
    }
  } catch { /* 无 location（自检/Node）⇒ 用默认顺序 */ }
  return list;
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

/* ══ 🌊🌳 **水/绿地**：一格包 → 要素（与代拍页抽共享前那段内联代码**逐字同口径**） ═══════════
   包里的形状（见 `world_map/gw_bundle.py`）：`{ key, cellSize, source, attribution, f: [{k, r, n}] }`
     · `k` = `"water"` / `"green"`（**只认 water，其余一律算绿地** —— 与页面原实现同一条判断）；
     · `r` = 环数组；**扁形** = 一环一个要素（多边形），**嵌套形** = `[[外环, 洞…]]` 一组一个要素；
     · `n` = 名字（可空 —— 名字取不到就不编，填空）。
   两条纪律：
     ① **环一定闭合**（首尾点相同；页面原来就是这么补的，闭合与否决定 MapLibre 填不填这一块）；
     ② **单格自报的 `cellSize` 与常量不符 ⇒ 抛错**（宁可这一格记"失败"，也不把异口径的数字当成正常水面）。 */

export interface BundleGwFeature {
  type: "Feature";
  id: string;
  properties: { name: string | null; kind: "water" | "green"; src: "bundle"; bsrc: "osm" };
  geometry: { type: "Polygon"; coordinates: number[][][] };
}

/** 一环（`[[lng,lat], …]`）；空数组/坏形状都返回 false（调用方按"跳过"处理，不抛） */
function isRing(v: unknown): v is number[][] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]) && typeof (v[0] as unknown[])[0] === "number";
}
/** 闭合一个环（首尾不同才补第一个点；**不改原数组** —— 包还在别处用） */
function closeRing(ring: number[][]): number[][] {
  const first = ring[0], last = ring[ring.length - 1];
  return first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice() : ring.concat([first]);
}

export function bundleGwOf(json: unknown): BundleGwFeature[] {
  const j = json as { key?: unknown; cellSize?: unknown; f?: unknown } | null;
  const arr = j?.f;
  /* 🔴 缺 `f` 字段 = **包坏了/取错了** ⇒ 抛错记 failed（可见）；空数组才是"这格确实没有水/绿" */
  if (!Array.isArray(arr)) throw new Error("gwbundle 里没有 f 数组");
  /* 🔴 **单格口径对拍**：索引那一层已经拦过一次（`wsGwLayer`），这里再拦一次 ——
     因为"索引是旧的、格子文件被按新格尺寸重导过"这种情况只有逐格看才看得见。 */
  const cs = j?.cellSize;
  if (cs !== undefined && cs !== null && Math.abs(Number(cs) - GW_BUNDLE_CELL_DEG) > 1e-9) {
    throw new Error(`gwbundle 格尺寸口径不符：包 ${cs}° / 前端 ${GW_BUNDLE_CELL_DEG}°`);
  }
  const cell = typeof j?.key === "string" && j.key ? j.key : "";
  const out: BundleGwFeature[] = [];
  for (let fi = 0; fi < arr.length; fi++) {
    const raw = arr[fi] as { k?: unknown; r?: unknown; n?: unknown } | null;
    if (!raw) continue;
    const kind: "water" | "green" = raw.k === "water" ? "water" : "green";
    const rings = Array.isArray(raw.r) ? (raw.r as unknown[]) : [];
    const name = raw.n === undefined || raw.n === null ? null : String(raw.n);
    const props = { name, kind, src: "bundle" as const, bsrc: "osm" as const };
    /* 嵌套形（MultiPolygon：第一个元素是"环"而不是"点"）⇒ **一组一个要素**，带洞；扁形 ⇒ 一环一个要素 */
    const nested = rings.length > 0 && !isRing(rings[0]);
    const groups: unknown[][] = nested ? (rings as unknown[][]) : rings.map((r) => [r]);
    for (let gi = 0; gi < groups.length; gi++) {
      const parts = groups[gi].filter((r): r is number[][] => isRing(r) && (r as number[][]).length >= 3);
      if (!parts.length) continue;
      out.push({
        type: "Feature",
        /* 稳定 id 用**包自己的格键** + 位置 ⇒ 同一格重取时能去重（仓库 `merge` 靠它），
           且不同格之间不会撞（撞了就会被当成重复要素丢掉 —— 那是**少画**，属于"把有说成没有"）。 */
        id: cell ? `${cell}#${fi}:${gi}` : `${kind}|${parts[0].length}|${parts[0][0][0]},${parts[0][0][1]}`,
        properties: props,
        geometry: { type: "Polygon", coordinates: parts.map(closeRing) },
      });
    }
  }
  return out;
}

/** 🌊 水/绿要素的 id（`bundleGwOf` 已经给了稳定 id；没有就返回 null ⇒ 仓库如实计 `noId`） */
export function gwIdOf(f: BundleGwFeature): string | null {
  return f && f.id ? String(f.id) : null;
}

/** 🌊 水/绿要素的代表点：**外环**各点平均（淘汰按"离视野中心多远"；取不到 ⇒ null，不参与淘汰也不丢） */
export function gwPointOf(f: BundleGwFeature): LngLat | null {
  const ring = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  for (const q of ring) {
    if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) { x += q[0]; y += q[1]; n++; }
  }
  return n ? [x / n, y / n] : null;
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
/**
 * 🔁 **代表点按要素对象记忆一次**（2026-09-26 性能实测）。
 *
 * 为什么：`pointOf` 是仓库**淘汰**（`retainNear`）与**挑楼**都要用的回调，每次都得把外环顶点扫一遍求质心；
 * 而淘汰是**每一轮 flush 都跑一次全仓**（12,000~50,000 栋）⇒ 实测淘汰合计 **1.8~3.7s**（10 轮），
 * 是仅次于 `JSON.parse` 的一块。与 `wsBuildingPick.derivedOf` 同一套理由与前提：
 * **要素进仓库之后是只读的**（几何在解析时建好，之后没人原地改）⇒ 这个值只跟要素自身有关。
 * 用 **WeakMap** 记：不给要素加属性（不会被 `setData`/序列化带出去）、不阻止回收、不占生命周期。
 * 🔴 与挑楼那份缓存**不共用**：仓库淘汰按"到视野中心的距离"需要代表点，挑楼按"外环首点"分块，
 * 两者口径不同（本文件早先就写明了"代表点 ≠ 首点"），别混成一个。
 */
const PT_CACHE = new WeakMap<object, LngLat | null>();
function memoPoint<T extends object>(f: T, calc: (x: T) => LngLat | null): LngLat | null {
  if (!f || typeof f !== "object") return null;
  const k = f as unknown as object;
  if (PT_CACHE.has(k)) return PT_CACHE.get(k) ?? null;
  const v = calc(f);
  PT_CACHE.set(k, v);
  return v;
}
/** 记忆版楼房代表点（**导出名就是它** ⇒ 页面/App/自检的调用点一行都不用改） */
export function bldPointOf(f: BundleBuildingFeature): LngLat | null { return memoPoint(f, bldPointOfRaw); }
/** 未记忆的原始实现（给自检/对照用：证明"记忆版"与它逐值相同） */
export function bldPointOfRaw(f: BundleBuildingFeature): LngLat | null {
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
/** 路代表点：折线中点（与代拍页同一取法：中位顶点，不是几何中点）——**记忆版（导出名）** */
export function roadsPointOf(f: BundleRoadFeature): LngLat | null { return memoPoint(f, roadsPointOfRaw); }
/** 未记忆的原始实现（对照用） */
export function roadsPointOfRaw(f: BundleRoadFeature): LngLat | null {
  const c = f?.geometry?.coordinates || [];
  const m = c[Math.floor(c.length / 2)];
  return m && Number.isFinite(m[0]) && Number.isFinite(m[1]) ? [m[0], m[1]] : null;
}

/* ══ 一种包的全部"跟着包走"的知识（路径 / 计划 / 解析 / 预算）—— 集中在这里，页面只接线 ══ */

interface BundleKindSpec<T> {
  dir: string;
  /** 📦 候选目录（按优先级）：索引读不到就退下一个 ⇒ **不同格尺寸的包能并存**（老包不删也能跑）。 */
  dirs?: string[];
  /**
   * 🔴 **兜底**格边长（**只在包自己没报 `cellSize` 时用**）。
   *
   * 2026-09-26 改（机主拍板分片）：**格尺寸以 `index.json.cellSize` 为准**，不再拿这个常量去算格键。
   * 历史教训（2026-09-25）：包按 0.02 分格、前端按 0.05 算键 ⇒ 格键与索引零交集 ⇒
   * 每个格都被判"包外" ⇒ **把有数据说成没数据**。当时靠"两边同值 + 不一致就拒绝"防住；
   * 现在分片会让格尺寸**故意**变小 ⇒ 防线改成两条：
   *   ① 有 `cellSize` ⇒ **按它算**（0.05/0.02/0.01 都能跑）；
   *   ② 调用方**显式钉了**尺寸（`BundleFeedOptions.expectCellDeg`，页面用 `?cell=` 给）而包不符 ⇒
   *      **仍然拒绝取数**并写 `sizemismatch`（"说成包外"这条路永远不许走）。
   */
  cellDeg: number;
  plan: (bounds: BundleBoundsLike | null, center: { lng: number; lat: number } | null, maxCells: number, sizeDeg: number) => {
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
    /* 📦 **分片包优先**：`bldbundle-002`（细子格，格尺寸以它自己的 `index.cellSize` 为准）在就在前面，
       不在就退回老包 `bldbundle`（0.05°，**唯一被端到端验过的一版**，先别删）。 */
    dirs: ["bldbundle-002", "bldbundle"],
    cellDeg: BLD_BUNDLE_CELL_DEG,
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number, size: number) => bldBundleCellsForView(b, c, maxCells, size),
    parse: bundleBuildingsOf,
    perRefresh: BLD_BUNDLE_PER_REFRESH,
    maxCells: BLD_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `bldbundle:${k}`,
    unit: "栋",
  } as unknown as BundleKindSpec<BundleBuildingFeature>,
  places: {
    dir: "placesbundle",
    cellDeg: PLACES_BUNDLE_CELL_DEG,
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number, size: number) => placesBundleCellsForView(b, c, maxCells, size),
    parse: bundlePlacesOf,
    perRefresh: PLACES_BUNDLE_PER_REFRESH,
    maxCells: PLACES_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `placesbundle:${k}`,
    unit: "个",
  } as unknown as BundleKindSpec<BundlePlaceFeature>,
  roads: {
    dir: "roadsbundle",
    cellDeg: ROADS_BUNDLE_CELL_DEG,
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number, size: number) => roadsBundleCellsForView(b, c, maxCells, size),
    parse: bundleRoadsOf,
    perRefresh: ROADS_BUNDLE_PER_REFRESH,
    maxCells: ROADS_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `bundle:${k}`,
    unit: "条",
  } as unknown as BundleKindSpec<BundleRoadFeature>,
  /* 🌊🌳 **水/绿地**（第四种包）：目录 `gwbundle`、格边长 `GW_BUNDLE_CELL_DEG`（= 0.05°）、
     计划走**同一个** `bundleCellsForView` —— 也就是说"取哪些格"与楼/路/片区名是同一套格数学，
     差别只有"格边长"这一个参数（口径要漂就一起漂，不会各漂一半）。 */
  gw: {
    dir: "gwbundle",
    cellDeg: GW_BUNDLE_CELL_DEG,
    plan: (b: BundleBoundsLike | null, c: { lng: number; lat: number } | null, maxCells: number) => bundleCellsForView(b, c, maxCells, GW_BUNDLE_CELL_DEG),
    parse: bundleGwOf,
    perRefresh: GW_BUNDLE_PER_REFRESH,
    maxCells: GW_BUNDLE_MAX_CELLS,
    sourceKey: (k: string) => `gwbundle:${k}`,
    unit: "面",
  } as unknown as BundleKindSpec<BundleGwFeature>,
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
  /** 🔴 **口径不符 ⇒ 本轮拒绝取数**（`index.cellSize` ≠ 前端常量）：既不取格、也不写 `missing`。
   *  为什么不能"退回试格子"：0.05 的键在 0.02 的包里**一个都不存在** ⇒ 全 404 ⇒ 照样把有数据说成包外。 */
  refused: boolean;
  /** **实际生效**的格边长（度）：包自报 `cellSize` 优先；包没报才用兜底常量 */
  cellDeg: number;
  /** 调用方**显式钉住**的格边长（`expectCellDeg`；没钉 ⇒ null）—— 与 `cellDeg` 不同就意味着已拒绝取数 */
  cellDegPin: number | null;
  /** 这一场真正在用的包目录（多候选里选中的那个） */
  dir: string;
  /** 候选目录（按优先级）—— HUD 要能回答"为什么用的是这个目录" */
  dirs: string[];
  /** 📐 **跟着格尺寸走的预算**（格越细，计划格数/一轮请求数越大；但**字节**由 `bytesPerRound` 封顶） */
  budget: { cellDeg: number; scale: number; maxCells: number; perRefresh: number; bytesPerRound: number };
  /** 🗂 包里那张**索引**（`index.json`）的实况 —— HUD 要能回答"包外是读来的还是猜的" */
  index: { state: "未读" | "读取中" | "已读" | "失败" | "口径不符"; cells: number | null; keys: number | null;
           why: string | null; attribution: string | null; real: boolean | null; cellSize: number | null };
  /** 累计并进仓库的要素数 */
  got: number;
  /** 有没有为这一种包**真的计划过取数**（false ⇒ HUD 写"未取"，而不是编一个 0） */
  asked: boolean;
  /** 🔴 **被淘汰连累而作废、下一轮会重取的格数**（历史累计）。
   *  为什么可数：这是"楼没了"的修复代价 —— 每次作废都意味着可能再来一次下载（有解析缓存则只并内存）。 */
  evictedSources: number;
  /** ♻️ 已解析要素缓存实况（关着时 `maxCells=0`、命中恒 0 —— **不写"数不出来"**，因为它真是 0） */
  cache: { cells: number; feats: number; hits: number; maxCells: number };
  /** 🧊 flush 合并窗口实况（`ms=0` = 老行为：逐批 flush） */
  coalesce: { ms: number; merged: number };
}

export interface BundleRefreshReport {
  /** 视野算不出格（bounds 拿不到）⇒ 什么都没做 */
  planned: boolean;
  /** 🔴 格尺寸口径不符 ⇒ **拒绝取数**（一个格都没取，也没写"包外"） */
  refused?: boolean;
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
  /**
   * 📐 **显式钉住的格尺寸（度）**：给了它，而包自报的 `cellSize` 与它不同 ⇒ **拒绝取数**并写
   * `sizemismatch`（="把有数据说成包外"那条路永远不许走）。
   * 不给 ⇒ **按包自报的算**（0.05 / 0.02 / 0.01 的包都能跑）—— 这是 2026-09-26 分片改造后的默认。
   * 用途：`?cell=` 显式比对、自检里对拍两种包、以及将来"页面按哪个尺寸挑选"要对齐时。
   */
  expectCellDeg?: number | null;
  /** 🧮 一轮取数的**字节预算**（默认 `BUNDLE_BYTES_PER_ROUND` = 1.5MB）；<=0 ⇒ 只看格数 */
  bytesPerRound?: number;
  /** 失败原文（给 HUD/面板 —— 不静默空着） */
  onError?: (why: string) => void;
  /**
   * 🧊 **flush 合并窗口（ms）**：窗口内到齐的几批**只 flush 一次**（默认 `0` = 老行为，逐批 flush）。
   *
   * 为什么（2026-09-26 实测，`~/chk/_perf_base2.json`）：`flush` 是这条管道最贵的一段 ——
   * 页面侧一次 flush = **全仓库** `setData`（路实测中位 **637ms**、楼 **253ms**），
   * 而一次变焦会连着到好几批 ⇒ 同一份全量数据被反复交给 MapLibre（k 批 ⇒ 约 k²/2 份）。
   * 合并窗口把"到齐就画"改成"稍微等一下一起画"：**画出来的最终内容一模一样**，只是少做几次全量搬运。
   * ⚠️ 窗口越大越省，但"楼出现"的延迟也越大 ⇒ 建议 200~400ms（页面口径自己定，模块不猜）。
   */
  flushCoalesceMs?: number;
  /**
   * ♻️ **已解析要素缓存（最多几格）**：淘汰之后回头再取同一格时，**直接从内存里拿**，
   * 不重新下载、更不重新 `JSON.parse`（实测单格 1.78MB / 解析中位 350ms）。
   *
   * 为什么需要：仓库有上限（楼 12,000 栋 ≈ 2~4 格），一格被淘汰后回头就是一次完整的"下载 + 解析"。
   * ⚠️ 这是**拿内存换时间**：默认 `0`（关）。开的话自己评估单格体量 —— 以本机实测的楼包为例，
   * 一格 ≈ 3,000~11,000 个要素，建议 2~3 格封顶。
   */
  parsedCacheCells?: number;
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
  let refused = false;
  let bytesThisRound = 0;                  // 这一轮**按索引算出来**要下的字节（不是估算）
  let activeDir: string | null = null;     // 这一场真正在用的包目录（多候选里选中的那个）
  let effCellDeg: number | null = null;    // 包自报的格尺寸（null ⇒ 还没读到索引，用兜底）
  let evictedSources = 0;                     // 被淘汰连累作废、下一轮要重取的格（历史累计）
  let indexFact: BundleIndexFact | null = null;
  let indexState: "未读" | "读取中" | "已读" | "失败" | "口径不符" = "未读";
  let indexWhy: string | null = null;
  let indexPromise: Promise<BundleIndexFact> | null = null;

  /* ══ 🧊 flush 合并窗口（默认 0 = 老行为；见 `BundleFeedOptions.flushCoalesceMs`） ═══════════
     为什么需要：一次 flush = 页面把**整个仓库**再交给 MapLibre 一次（路实测中位 637ms）。
     一次变焦会连着到好几批 ⇒ 同一份全量数据被搬 k 次（k 批时累计搬运量 ≈ k²/2 格）。
     合并窗口把"到齐就画"变成"稍等一起画"：**最终画面一模一样**，只是少搬几次。
     ⚠️ 窗口里只保留**一条** pending 记录（把 why 串起来），不做队列 —— 队列会让延迟无界。 */
  const coalesceMs = Math.max(0, Math.floor(Number(opts.flushCoalesceMs || 0)));
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFlushWhy = "";
  let coalescedFlushes = 0;                  // 被合并掉（没真的 flush）的次数 —— 可数
  let flushDone = 0;                         // 真 flush 过几次（第一条**不并窗口**，见下）

  /** 真的 flush 一次（计时在这里，**合并窗口下的那次也照样记账**） */
  function doFlush(why: string): void {
    const t = pmNow();
    flushDone += 1;
    try { opts.flush(why); } finally { pmSpan(`feed.flush:${spec.dir}`, pmNow() - t, null, why); }
  }
  /**
   * 请求 flush：窗口为 0 ⇒ 立即（与老行为逐字节相同）；否则并进窗口。
   * 🔴 **第一条不并**（`flushDone === 0`）：开页那一格是"首屏能不能看见楼"的关键路径，
   * 合并窗口会白白把它推迟一个窗口（实测 300ms）。首屏要快、后面才谈省。
   */
  function requestFlush(why: string): void {
    if (coalesceMs <= 0 || flushDone === 0) { doFlush(why); return; }
    pendingFlushWhy = pendingFlushWhy ? pendingFlushWhy + "+" + why : why;
    if (flushTimer) { coalescedFlushes += 1; return; }        // 已在窗口里 ⇒ 只记账，不再排一个
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const w = pendingFlushWhy; pendingFlushWhy = "";
      try { doFlush(w); } catch { /* flush 抛错不影响管道（页面自己会记 errs） */ }
    }, coalesceMs);
  }

  /* ══ ♻️ 已解析要素缓存（默认 0 = 关；见 `BundleFeedOptions.parsedCacheCells`） ═══════════════
     只缓存"取到并解析成功"的格子要素；**已经解析过的东西不该因为仓库淘汰而重来一遍**
     （实测单格 1.78MB / `JSON.parse` 中位 350ms）。Map 的插入序当 LRU 用（取用即刷新）。 */
  const cacheCells = Math.max(0, Math.floor(Number(opts.parsedCacheCells || 0)));
  const parsedCache = new Map<string, T[]>();
  let cacheHits = 0;
  function cacheTake(k: string): T[] | null {
    const v = parsedCache.get(k);
    if (!v) return null;
    parsedCache.delete(k); parsedCache.set(k, v);            // 刷新 LRU 位置
    return v;
  }
  function cachePut(k: string, v: T[]): void {
    if (cacheCells <= 0) return;
    parsedCache.delete(k); parsedCache.set(k, v);
    while (parsedCache.size > cacheCells) {
      const first = parsedCache.keys().next();
      if (first.done) break;
      parsedCache.delete(first.value);
    }
  }
  /** 缓存里现在有几格 / 合计几个要素（可数口径，进快照与 facts） */
  function cacheStats(): { cells: number; feats: number; hits: number; maxCells: number } {
    let feats = 0;
    for (const v of parsedCache.values()) feats += v.length;
    return { cells: parsedCache.size, feats, hits: cacheHits, maxCells: cacheCells };
  }
  if (cacheCells > 0) pmSetContext(`feed.parsedCache:${spec.dir}`, cacheCells);
  if (coalesceMs > 0) pmSetContext(`feed.flushCoalesce:${spec.dir}`, coalesceMs);

  function ensureIndex(): Promise<BundleIndexFact> {
    if (indexPromise) return indexPromise;
    indexState = "读取中";
    /* ⏱ `index.json` 是**第一跳**（没有它连"哪些格存在"都不知道）⇒ 单独记时，别混进格子账里。
       📦 **按候选目录逐个试**（`dirsOf`）：第一个能读出索引的目录就是这一场的"活目录" ⇒
       新细格包与老包**能并存**，谁在就用谁，页面/App 都不用改。 */
    const dirs = dirsOf(spec);
    indexPromise = (async (): Promise<BundleIndexFact> => {
      let last: BundleIndexFact | null = null;
      let tried = 0;
      for (const d of dirs) {
        tried += 1;
        const f = await pmTimeAsync(`feed.index:${spec.dir}`, () => loadBundleIndex(opts.fetchCell, opts.kind, d));
        last = f;
        if (!f.cells) continue;                       // 这个目录没索引 ⇒ 试下一个
        activeDir = d;
        indexFact = f;
        /* 🔴 **格尺寸以包自报的 `cellSize` 为准**（2026-09-26 分片改造）：
           包按 0.05 / 0.02 / 0.01 分格都能跑，**不再拿前端常量去算格键** ——
           2026-09-25 那次"包 0.02 / 前端 0.05 ⇒ 格键零交集 ⇒ 把有数据说成包外"就是写死造成的。
           防线改成"**显式钉住的尺寸**对不上才拒绝"（见下），兜底常量只在包**没报**时用。 */
        /* ⚠️ **坏值也算"没报"**：`cellSize: null` 经 `Number(null)` 会变 **0**（自检⑧D 抓到的坑），
           而 0 会让格键计算除零 ⇒ **一个格都取不到**（比报错更难查）⇒ 只有"有限且 > 0"才算包自报。 */
        const rawSize = f.cellSize;
        const pkg = (typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0) ? rawSize : null;
        effCellDeg = (pkg === null ? spec.cellDeg : pkg);
        const pin = Number(opts.expectCellDeg);
        if (pkg === null) {
          /* 老包没有 `cellSize` 字段：**不猜**，用兜底常量，并如实标注 */
          indexState = "已读";
          indexWhy = "包里没有可用的 cellSize（缺字段 / 坏值）⇒ 按兜底常量 " + spec.cellDeg + "° 算（数不出来就说不出来）";
          return f;
        }
        if (Number.isFinite(pin) && Math.abs(pkg - pin) > 1e-9) {
          /* 🔴 **口径对拍**（2026-09-25 事故的硬化，保留）：调用方**显式钉了**期望尺寸而包不符 ⇒
             键集与索引**零交集** ⇒ 若不拦，每个格都会被"读"成包外 —— 那是**把有数据说成没数据**。
             ⇒ **拒绝取数**（不取格、不写 missing），两个数字与目录名都写进 HUD/errs。 */
          indexState = "口径不符";
          refused = true;
          indexWhy = `包（${d}）按 ${pkg}° 分格、但这一趟**钉住**了 ${pin}° ⇒ 格键与索引零交集，拒绝取数（否则会把有数据的格说成「包外」）`;
          opts.onError?.(`${spec.dir}@${d} 格尺寸口径不符：包 ${pkg}° / 钉住 ${pin}° ⇒ 本轮一个格都不取`);
          return f;
        }
        indexState = "已读";
        indexWhy = null;
        return f;
      }
      /* 所有候选目录都没读到索引 ⇒ 如实退回试格子（老行为，判词不许写成"这里没有"） */
      indexState = "失败";
      indexWhy = `索引没读到（试过 ${tried} 个目录：${dirs.join(" / ")}）⇒ 退回试格子`;
      opts.onError?.(`index ${spec.dir} 没读到（试过 ${tried} 个目录），退回试格子`);
      return last || { kind: opts.kind, url: "", source: null, cellCount: null, cells: null, attribution: null, real: null,
                       cellSize: null, cellBytes: null, cellBld: null, cellSizeByLayer: null, layerCellSizeSole: null,
                       ok: false, why: `试过 ${tried} 个目录都没读到索引` };
    })();
    return indexPromise;
  }

  /** 这一场**实际按多少度分格**（包自报优先；索引还没读到 ⇒ 兜底常量） */
  function effectiveDeg(): number { return effCellDeg === null ? spec.cellDeg : effCellDeg; }

  /* ══ 📐 **预算跟着格尺寸走**（2026-09-26 分片改造）══════════════════════════════════════
     粗格（0.05°）时"一轮 2 格 / 计划 6 格"是合适的；格变细 25 倍之后，同样的**格数**只盖住 1/25 的视野 ——
     照抄格数会变成"一格一格慢慢啃"。而用户感知的成本是**字节**，不是格数。
     ⇒ 三个量都按"格面积的倒数"放大（`scale = (0.05/deg)²`），**并以字节为最终闸门**：
       · 老包 0.05° ⇒ scale = 1 ⇒ **与今天逐字节相同的行为**（双包并存的硬约束）；
       · 0.01° ⇒ scale = 25 ⇒ 计划格数 6→150、一轮请求 2→16（上限），但**这一轮下多少字节由预算卡死**。 */
  function scaleOf(): number {
    const d = effectiveDeg();
    if (!Number.isFinite(d) || d <= 0) return 1;
    return Math.max(1, Math.pow(BLD_BUNDLE_CELL_DEG / d, 2));
  }
  /** 计划里最多留几格（跟着格面积放大；上界 400 = 防"视野大得离谱"时排长队） */
  function maxCellsEff(): number { return Math.min(400, Math.max(spec.maxCells, Math.round(spec.maxCells * scaleOf()))); }
  /** 一轮最多发几条格子请求（跟着格面积放大；上界 `BUNDLE_REQ_PER_ROUND_MAX` —— 串行也不该排 100 条） */
  function perRefreshEff(): number { return Math.min(BUNDLE_REQ_PER_ROUND_MAX, Math.max(spec.perRefresh, Math.round(spec.perRefresh * scaleOf()))); }

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
      refused: refused, cellDeg: effectiveDeg(), cellDegPin: (Number.isFinite(Number(opts.expectCellDeg)) ? Number(opts.expectCellDeg) : null),
      dir: activeDir || dirsOf(spec)[0], dirs: dirsOf(spec),
      /* 📐 跟着格尺寸走的三个预算（报告/排查要能回答"为什么一轮取这么多"） */
      budget: { cellDeg: effectiveDeg(), scale: Math.round(scaleOf() * 100) / 100, maxCells: maxCellsEff(), perRefresh: perRefreshEff(), bytesPerRound: Math.round(bytesThisRound) },
      evictedSources,
      cache: cacheStats(),
      coalesce: { ms: coalesceMs, merged: coalescedFlushes },
      index: {
        state: indexState,
        cellSize: indexFact ? indexFact.cellSize : null,
        cells: indexFact && indexFact.cellCount !== null ? indexFact.cellCount : null,
        keys: indexFact && indexFact.cells ? indexFact.cells.size : null,
        why: indexWhy,
        attribution: (indexFact && (indexFact.attribution || indexFact.source)) || null,
        real: indexFact ? indexFact.real : null,
      },
    };
  }

  /**
   * 视野需要哪些格。⚠️ `feed.plan()` 是**同步**的（页面/探针要随手读）⇒ 它用"当前已知的格尺寸"
   * （索引已读 ⇒ 包自报的；还没读 ⇒ 兜底常量）。**取数那条路（`runOnce`）一定先 `await ensureIndex()`**
   * ⇒ 真正去取格时用的永远是包自报的尺寸，不受这里影响。
   */
  function planned(): { keys: string[]; wanted: number; capped: boolean } | null {
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, maxCellsEff(), effectiveDeg());
    if (!p) return null;
    return { keys: p.cells.map((c) => c.key), wanted: p.wanted, capped: p.capped };
  }

  async function runOnce(why: string): Promise<BundleRefreshReport> {
    /* 🗂 **先读索引**（一次；失败就退回试格子）—— 两件事都靠它：
       ① 索引里没有的格 = **包外**，零请求；② **格尺寸以包自报为准** ⇒ 必须先读它再算格键
       （不然细格包会被按 0.05 算键 ⇒ 键与索引零交集 ⇒ 把有数据说成包外）。 */
    const idx = await ensureIndex();
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, maxCellsEff(), effectiveDeg());
    if (!p) return { planned: false, batch: 0, got: 0, capped: false };
    asked = true;
    wanted = p.wanted;
    capped = p.capped;
    /* 🔴 口径不符 ⇒ **本轮什么都不做**（不取格、不写 missing）：把事情说成"包外"是最坏的那种谎 */
    if (refused) return { planned: true, batch: 0, got: 0, capped: p.capped, refused: true };
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
    /* 🧮 **取哪几格**：先按"格数上限"截，再按**字节预算**截（索引里有每格字节 ⇒ 是算出来的，不是估的）。
       至少留一格（哪怕它自己就超预算）—— 否则极密的格会一条都不取、屏上永远空。 */
    const byteBudget = Number.isFinite(Number(opts.bytesPerRound)) && Number(opts.bytesPerRound) >= 0
      ? Number(opts.bytesPerRound) : BUNDLE_BYTES_PER_ROUND;
    const cap0 = todo.slice(0, perRefreshEff());
    const batch: typeof cap0 = [];
    let bytesPicked = 0;
    for (const c of cap0) {
      const by = idx.cellBytes ? (idx.cellBytes.get(c.key) || 0) : 0;
      if (batch.length > 0 && byteBudget > 0 && bytesPicked + by > byteBudget) break;
      batch.push(c);
      bytesPicked += by;
    }
    bytesThisRound = bytesPicked;
    if (!batch.length) return { planned: true, batch: 0, got: 0, capped: p.capped };

    pending += batch.length;
    let n = 0;
    for (const cell of batch) {
      /* ⏱ 每格四段拆开记：**网络 / 读流+JSON.parse / 紧凑字段→要素 / 并仓**。
         为什么要拆：机主说的"加载慢"可能是网络（真慢），也可能是解析（我们自己写的循环慢）——
         不拆开就会把锅甩给网络，那是猜。 */
      const url = bundleCellUrl(opts.kind, cell.key, activeDir || dirsOf(spec)[0]);
      const t0 = pmNow();
      try {
        /* ♻️ **先看缓存**（默认关）：淘汰之后回头再取同一格 ⇒ 不下载、不解析，直接并回去。
           ⚠️ 走缓存也要如实记一笔 span（不然"这一格花了多少"会凭空消失）。 */
        const hit = cacheTake(cell.key);
        if (hit) {
          opts.store.merge(hit, spec.sourceKey(cell.key));
          cacheHits += 1;
          have.add(cell.key);
          got += hit.length;
          n += hit.length;
          pmSpan(`feed.cacheHit:${spec.dir}`, pmNow() - t0, null, `${hit.length} 个要素`);
          continue;
        }
        const r = await opts.fetchCell(url, BUNDLE_TIMEOUT_MS);
        const tNet = pmNow();
        if (r.status === 404) {
          /* **包外**（不是失败、更不是"这里没有"）：如实记下来，HUD 会写"包外 N" */
          missing.add(cell.key);
          pmSpan(`feed.net:${spec.dir}`, tNet - t0, null, "404 包外");
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const by = netBytesOf(url);
        pmSpan(`feed.net:${spec.dir}`, tNet - t0, by);
        const j = await r.json();
        const tJson = pmNow();
        pmSpan(`feed.json:${spec.dir}`, tJson - tNet, by);
        const feats = spec.parse(j);
        const tParse = pmNow();
        pmSpan(`feed.parse:${spec.dir}`, tParse - tJson, by);
        opts.store.merge(feats, spec.sourceKey(cell.key));
        pmSpan(`feed.merge:${spec.dir}`, pmNow() - tParse, by);
        /* ♻️ 存进"已解析"缓存（默认关）：下次这一格被淘汰后再入镜时，省掉下载 + 解析 */
        cachePut(cell.key, feats);
        if (have.size === 0) pmMark(`feed.firstCell:${spec.dir}`, { cell: cell.key, bytes: by, n: feats.length });
        have.add(cell.key);
        got += feats.length;
        n += feats.length;
      } catch (e) {
        failed.add(cell.key);
        const why0 = String((e as Error)?.message || e || "取数失败").slice(0, 60);
        pmSpan(`feed.net:${spec.dir}`, pmNow() - t0, null, "失败:" + why0);
        opts.onError?.(`${spec.dir} ${cell.key} ${why0}`);
      } finally {
        pending -= 1;
      }
    }
    /* 淘汰只在**超出保留半径/上限**时动手（保留"视野外一圈" ⇒ 来回挪不该重取）。
       🔴 2026-09-26：仓库现在会**连被淘汰波及的来源键一起作废**（`wsFeatureStore.retainNear`）⇒
       下一轮 `todo` 会把那一格重新排进来（有解析缓存就直接从内存并回去）。 */
    try {
      const c = opts.view().center;
      if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
        const ev = opts.store.retainNear([c.lng, c.lat], opts.retainRadiusM());
        const ds = (ev as { droppedSources?: number } | null)?.droppedSources;
        if (ds) evictedSources += Number(ds) || 0;
      }
    } catch {
      /* 淘汰失败不影响显示（下一轮再试） */
    }
    /* ⏱ `flush` 是这条管道最贵的一段嫌疑（页面在里面挑楼 + 上妆 + setData）⇒ 单独记。
       合并窗口开时，这一段会**挪到定时器里**（`requestFlush`），延迟但只做一次。 */
    requestFlush(`${why}+${batch.length}`);
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
  /** 包自己的格边长（度）—— 与前端常量对拍用；缺字段 = null（老包） */
  cellSize: number | null;
  /**
   * 🧮 **每一格的字节数与栋数**（`index.json` 的 `cells[key].bytes / .bld`；老包/缺字段 ⇒ null）。
   *
   * 为什么值得单独留：① 报告要回答"这一趟要下多少 MB"（可数，不靠估）；
   * ② **取数预算改成"字节预算"**就靠它 —— 格数在细格包上会变成几百个，
   *    而"这一轮下多少字节"才是用户真正感知的成本（0.05° 一格的 1.9MB vs 0.01° 一格的 57KB）。
   */
  cellBytes: Map<string, number> | null;
  cellBld: Map<string, number> | null;
  /**
   * ✅ **这一趟索引到底读到了没有**（`false` ⇒ 后面那些字段**全是 null**，消费方据此走"数不出来"那条路）。
   *
   * 为什么要有这个字段（2026-09-26 真 bug）：`loadBundleIndex()` 的返回类型曾经是"一个 fact"，
   * 但**"没读到"这件事在类型里没表达** ⇒ 直接调用它的消费方（`wsGwLayer`）要在"全 null"里自己猜，
   * 猜漏了就是 `Cannot read properties of null (reading 'cellSize')`（App 页实测抓到，
   * 每次开页少画水/绿 + HUD 一行红字）。⇒ 现在**显式给一个布尔 + 原因**，谁都不用猜。
   * ⚠️ 字段只增不减：老消费者不看它也不会坏（与 `cellSize` 一样，null 一律表示"数不出来"）。
   */
  ok: boolean;
  /** 没读到的**原句**（HTTP 状态 / 解析错 / 未知类型…）；读到了 ⇒ null */
  why: string | null;
  /**
   * 🗂 **按层自报的格边长**（`index.json.cellSizeByLayer`：`{层名: 度}`；没有 ⇒ null）。
   *
   * 为什么要有（2026-09-26 主对话批，"只加字段、不改语义"）：**城市包**里不同层可能是不同粒度
   * （楼一档、路/水绿一档），那种包的**包级 `cellSize` 会是 null**（报不出来），而消费方
   * （入口/App）需要知道"我这一层按多少度算键"。以前谁需要谁自己再解析一遍索引 —— 那就是第二份实现。
   * ⇒ 在这里**加一个字段**，让索引事实仍然是唯一来源。
   * ⚠️ **旧消费者不受影响**：字段只增不减，缺字段一律 `null`（不许拿它当 0 —— 与 `cellSize` 同一条纪律）。
   */
  cellSizeByLayer: Record<string, number> | null;
    /** 包级 `cellSize` 为 null、但只有**一个**层报了尺寸时，把它当整体尺寸用（省得每个消费方各判一次） */
  layerCellSizeSole: number | null;
}

/**
 * 读一张离线包的清单，把**署名原句**取回来。
 * 为什么走清单而不是在 TS 里写一句：`ROUTE.md` 要求"复用同一句常量，别改写第二版"——
 * 最不容易漂的做法就是**让导出脚本那句原话随包走**，页面照抄显示。
 */
export async function loadBundleIndex(fetchCell: BundleFetch, kind: BundleKind, dir?: string): Promise<BundleIndexFact> {
  /* 🔴 **这个函数是 total 的：永不抛、永不返回 null**（2026-09-26 真 bug 的修法）。
     原来 `bundleIndexUrl()` 在 try **外面** ⇒ 它一抛（未知 kind / 目录表拿不到），
     调用方拿到的就是"什么都没赋值"（`indexFact` 仍是 null）⇒ 下一次调用（它自己的 `indexDone`
     已经置 true、跳过了加载）直接撞 `null.cellSize`。现在：连"算 URL"都在 try 里，
     任何失败都回一个**全 null 的 fact**，调用方只需看 `ok`。 */
  let url = "";
  try {
    url = bundleIndexUrl(kind, dir);
    const r = await fetchCell(url, BUNDLE_TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { source?: unknown; cellCount?: unknown; cells?: unknown; attribution?: unknown; real?: unknown; cellSize?: unknown } | null;
    const rawCells = (j?.cells && typeof j.cells === "object") ? Object.keys(j.cells as Record<string, unknown>) : null;
    /* 🧮 每格的 `bytes` / `bld`（两种包都有；缺了就 null ⇒ 字节预算退回"按格数"，如实） */
    let cellBytes: Map<string, number> | null = null;
    let cellBld: Map<string, number> | null = null;
    if (rawCells) {
      for (const k of rawCells) {
        const meta = (j!.cells as Record<string, { bytes?: unknown; bld?: unknown }>)[k] || {};
        const by = num(meta.bytes), bd = num(meta.bld);
        if (by !== null && by > 0) { if (!cellBytes) cellBytes = new Map(); cellBytes.set(k, by); }
        if (bd !== null && bd > 0) { if (!cellBld) cellBld = new Map(); cellBld.set(k, bd); }
      }
    }
    /* 🗂 按层自报的格尺寸（城市包可能层间不同粒度；包级 `cellSize` 那种情况下是 null） */
    let cellSizeByLayer: Record<string, number> | null = null;
    let layerCellSizeSole: number | null = null;
    const rawLayers = (j as { cellSizeByLayer?: unknown } | null)?.cellSizeByLayer;
    if (rawLayers && typeof rawLayers === "object") {
      for (const [k, v] of Object.entries(rawLayers as Record<string, unknown>)) {
        const n = num(v);
        if (n === null || n <= 0) continue;              // 坏值一律不进（不许拿 0 去算键）
        if (!cellSizeByLayer) cellSizeByLayer = {};
        cellSizeByLayer[k] = n;
      }
      const vals = cellSizeByLayer ? Object.values(cellSizeByLayer) : [];
      layerCellSizeSole = (vals.length === 1) ? vals[0] : null;
    }
    const okCells = !!(rawCells && rawCells.length);
    return {
      kind, url,
      source: typeof j?.source === "string" && j.source ? j.source : null,
      cellCount: num(j?.cellCount),
      cells: rawCells ? new Set(rawCells) : null,
      attribution: typeof j?.attribution === "string" && j.attribution ? j.attribution : null,
      real: typeof j?.real === "boolean" ? j.real : null,
      /* ⚠️ `cellSize` **不走 `num()`**：`num(null)` 会回 0（`Number(null) === 0`），
         而 0 是坏值（格键除零 ⇒ 一个格都取不到），必须如实归成 **null = 数不出来**。 */
      cellSize: (typeof j?.cellSize === "number" && Number.isFinite(j.cellSize) && j.cellSize > 0) ? j.cellSize : null,
      cellBytes, cellBld, cellSizeByLayer, layerCellSizeSole,
      ok: okCells,
      why: okCells ? null : "索引里没有 cells（取到了文件但内容不像清单）",
    };
  } catch (e) {
    /* 任何失败（404 / 超时 / JSON 坏 / 未知 kind）都**如实回一个 fact**，不抛、不 null */
    return { kind, url, source: null, cellCount: null, cells: null, attribution: null, real: null, cellSize: null,
             cellBytes: null, cellBld: null, cellSizeByLayer: null, layerCellSizeSole: null,
             ok: false, why: String((e as Error)?.message || e || "索引读取失败").slice(0, 120) };
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
  /* 🔴 口径不符 ⇒ **只**说这一句（不许出现"包外 N" —— 那会把"有数据"说成"没有"） */
  if (f.refused) {
    const pkgC = f.index && f.index.cellSize !== null && f.index.cellSize !== undefined ? f.index.cellSize + "°" : "?";
    return `${icon} ❌ **格尺寸口径不符**（包 ${pkgC} / 前端 ${f.cellDeg}°）⇒ **本轮一个格都不取**`
      + `（取格会把有数据的格说成「包外」；修包或改前端常量后重试）`;
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
export function bldVerdictState(f: BundleFeedFacts): "bundle" | "outside" | "pending" | "failed" | "sizemismatch" {
  /* ⚠️ **`refused` 排在最前**：口径不符时"包外/失败/没有楼"三种说法**都不成立**，
     说任何一种都是撒谎（这次事故就是把"有数据"说成"包外"）。 */
  if (f.refused) return "sizemismatch";
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
