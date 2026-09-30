/**
 * wsGwLayer.ts —— 🌊🌳 **真水系 / 绿地**的**唯一真源**（代拍页与 App 宿主共用同一份）。
 *
 * ## 为什么有这一份
 * 机主选了「**自己画**」：Esri 底图在 z17 这一带两个服务都只给占位图（实测同一张 2521B），
 * 屏幕上是**一片没有水、没有绿植**的楼群。于是我们用 `/gwbundle/<格>.json`（`world_map/gw_bundle.py`
 * 从 OSM/Overpass 取的真多边形，**ODbL**）自己画两层 `fill`。
 *
 * 这份文件把页面里那段原型（`public/ws3dshow.html` 的 `refreshGw()`）**整段抽出来**，
 * 页面与 App 都只接线 —— 因为 PR 门禁 C1 的红线是「**App 宿主不许有第二份实现**」，
 * 而"水/绿怎么取、怎么归一、什么颜色、压在哪一层、判词怎么写"正是最容易被写第二遍的那种规则。
 *
 * ## 这一份管什么（全部规则，一处定义）
 * · **视野 → 格键**：走 `wsFeatureStore.bundleCellsForView()`（`floor(x/deg)*deg`，0.05°）
 *   —— 与离线包**同口径**。🔴 这里的格边长只取常量 `GW_BUNDLE_CELL_DEG`，
 *   **绝不** "包里写多少就按多少算"：0.02/0.05 两套口径那次事故，后果是**把有数据说成没数据**。
 * · **取数**：走共享管道 `wsOfflineFeed.createBundleFeed({kind:"gw"})`（索引优先 / 串行 /
 *   每格独立超时 / 包外与失败分开计 / 并进仓库去重），这里**一行取数循环都不写**。
 * · **归一化**：`wsOfflineFeed.bundleGwOf()`（`{k,r,n}` 扁平 → GeoJSON Polygon，环闭合，水/绿按 `k` 分）。
 * · **颜色**：**只从主题取** `ai.water` / `ai.park`（与预渲染瓦片里的示意水绿同色系）；
 *   取不到 ⇒ **如实报错、不画**（绝不硬编码色号，也绝不悄悄换别的颜色）。
 * · **层序**：压在**楼体之前**（水/绿是地面上的东西，压在楼上会像浮在半空）。
 * · **署名**：只念 `index.json` 里那句**原话**（ODbL 要求署名随数据走），不在 TS 里重写一句。
 * · **一行判词**：`gwVerdictLine()` —— **三态**：正数 / 0（已量）/ 数不出来（写清原因）。
 *
 * ## 三态纪律（机主定的红线）
 * `facts()` 里的 `water`/`green` **数得出来才是数字**：索引没读到、主题没色、口径不符、
 * 一格都没取到 ⇒ `water/green` 保持 `null`，判词写「数不出来：<原因>」，
 * **绝不写 0 冒充"这里没有水"**。
 */

import {
  type BundleBoundsLike,
  type BundleFetch,
  type BundleGwFeature,
  type BundleIndexFact,
  type BundleView,
  GW_BUNDLE_CELL_DEG,
  GW_BUNDLE_MAX_CELLS,
  GW_STORE_CAP,
  createBundleFeed,
  gwIdOf,
  gwPointOf,
  loadBundleIndex,
} from "./wsOfflineFeed";
import { type FeatureStore, bundleCellsForView, createFeatureStore, metersBetween } from "./wsFeatureStore";

/* ══ ⓪ 归一化（`{k,r,n}` 扁平 → GeoJSON：环闭合 / 水绿按 `k` 分 / MultiPolygon 嵌套） ═══════════
   实现**只有一份**，住在 `wsOfflineFeed` 里（与楼 / 路 / 片区名的解析器同族，也正因为在那儿，
   离线管道 `SPECS.gw.parse` 才能直接用它）。这里**再导出一次**：好让"水/绿地的全部规则"从
   **一个入口**就取得全 —— 页面、App 宿主、自检、以后别的宿主都只 import 这一个模块。
   ⚠️ 是 re-export，**不是**第二份实现：改归一化只改 `wsOfflineFeed.bundleGwOf()` 一处。 */
export { bundleGwOf, gwIdOf, gwPointOf } from "./wsOfflineFeed";

/* ══ ① 术语与常量（图层 id / 格尺寸只有一个来源：这里与 `wsOfflineFeed` 的 SPECS.gw） ═══════ */

export type GwKind = "water" | "green";
/** 两种要素（顺序即建层顺序：先水后绿 —— 与页面原实现逐字相同） */
export const GW_KINDS: readonly GwKind[] = ["water", "green"];
/** 图层 / 数据源 id（**两层同名**；页面与 App 用的是同一对字面量） */
export const GW_LAYER_ID_OF: Record<GwKind, string> = { water: "gw-water", green: "gw-green" };
export const GW_LAYER_IDS: readonly string[] = [GW_LAYER_ID_OF.water, GW_LAYER_ID_OF.green];
/** 离线包目录名（真源在 `wsOfflineFeed.SPECS.gw.dir`；这里再写一次是给自检/探针核对的字面量） */
export const GW_BUNDLE_DIR = "gwbundle";
/** 点/面的来源键前缀（与 `SPECS.gw.sourceKey` 同式） */
export const GW_SOURCE_KEY_PREFIX = GW_BUNDLE_DIR + ":";

export function gwSourceKeyOf(cellKey: string): string {
  return GW_SOURCE_KEY_PREFIX + cellKey;
}

/** 保留半径的下限（米）。🔴 **不能给小**：一格 0.05° 在纬度上就有 **~5.6 km**（经度 ~4.8 km，对角线 ~7.4 km），
 *  给 3 km 时仓库会把**刚取回来那一格自己的要素**当成"太远"当场淘汰 ⇒ 判词少报。
 *  这不是推测：2026-09-26 真浏览器 A/B 实测（同 URL、同机位）抽前 `水 6 面 · 绿 132 面`、
 *  抽后 `水 4 面 · 绿 84 面` —— 差的那批正是被淘汰的（见 `gwRetainRadiusM()`）。 */
export const GW_RETAIN_RADIUS_M = 12000;

/**
 * 默认保留半径（米）= **至少装得下"视野 + 一整格"**：`max(12km, 视野对角线 × 1.2 + 一格对角线)`。
 * 为什么要视野那一项：视野越大，被算进计划、因而会被取回来的格子离中心越远；
 * 只按格对角线给常量的话，大视野下照样会"取回来就淘汰"。
 */
export function gwRetainRadiusM(bounds: BundleBoundsLike | null): number {
  try {
    if (!bounds) return GW_RETAIN_RADIUS_M;
    const w = bounds.getWest(), e = bounds.getEast(), s = bounds.getSouth(), n = bounds.getNorth();
    if (![w, e, s, n].every((v) => Number.isFinite(v))) return GW_RETAIN_RADIUS_M;
    const viewDiag = metersBetween([w, s], [e, n]);
    const cellDiag = metersBetween([0, 0], [GW_BUNDLE_CELL_DEG, GW_BUNDLE_CELL_DEG]);
    return Math.max(GW_RETAIN_RADIUS_M, Math.round(viewDiag * 1.2 + cellDiag));
  } catch {
    return GW_RETAIN_RADIUS_M;
  }
}

/* ══ ② 颜色：**只从主题拿**（同一个主题对象在页面与 App 里形状不同 ⇒ 两条路径都认） ═════════
   页面拿到的是 `/wstheme.json` 里的 `themes.<id>`（也可能整份快照 / `looks.*` / `basemaps.*`），
   App 拿到的是 `wsMapTheme()` 造的 `WsMapTheme`（顶层就有 `ai`）。两条路都走**同一张路径表**。 */

export interface GwColors {
  water: string | null;
  green: string | null;
}

/** 主题里"水/绿"可能住的路径（**顺序即优先级**；与页面原实现逐字相同，只是搬到这里） */
const GW_COLOR_PATHS: Record<GwKind, readonly string[]> = {
  water: ["themes.anime.ai.water", "ai.water", "look.ai.water", "themes.night.ai.water"],
  green: ["themes.anime.ai.park", "ai.park", "look.ai.park", "themes.night.ai.park"],
};

/** 按点分路径取一个**字符串**（取到非字符串 = 当作没有，绝不 toString 一个对象当颜色） */
function pickString(o: unknown, path: string): string | null {
  let cur: unknown = o;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" && cur ? cur : null;
}

export function gwColorsOf(theme: unknown): GwColors {
  const first = (paths: readonly string[]): string | null => {
    for (const p of paths) {
      const v = pickString(theme, p);
      if (v) return v;
    }
    return null;
  };
  return { water: first(GW_COLOR_PATHS.water), green: first(GW_COLOR_PATHS.green) };
}

/** 缺哪几个（判词/自检要能说出"缺的是哪一个"，而不是笼统"没颜色"） */
export function gwMissingColors(c: GwColors): GwKind[] {
  const miss: GwKind[] = [];
  if (!c.water) miss.push("water");
  if (!c.green) miss.push("green");
  return miss;
}

/* ══ ③ 地图能力与层序：**压在楼体之前**（规则只有这一条，页面与 App 同一个函数） ═══════════ */

/** 建层需要的最小地图能力（MapLibre 的 `Map` 与 App 宿主的适配器都满足） */
export interface GwMapLike {
  getLayer(id: string): unknown;
  getSource(id: string): { setData(d: unknown): void } | undefined;
  addSource(id: string, spec: Record<string, unknown>): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  /** 🆕 2026-09-30：把已有图层挪位置（治"被底图栅格压住"）。宿主没暴露 ⇒ 跳过，不抛。 */
  moveLayer?(id: string, beforeId?: string): void;
  /** 现有图层的读取口（MapLibre 的 `getStyle()`）；取不到 ⇒ 追加在最上层，不抛 */
  getStyle?(): { layers?: Array<{ id?: unknown; type?: unknown }> } | undefined;
}

/**
 * 插入锚点 = **第一个 id 以 `bld` 开头的图层**（页面原实现逐字同义：`ls.find(l => l.id.indexOf("bld") === 0)`）。
 * 为什么是"楼"：水/绿是**地面**上的东西，压在楼上会像浮在半空。
 * 取不到（这一带没有楼体层 / 拿不到样式）⇒ `undefined` = 追加到最上层（与页面原来的兜底一致，不抛错）。
 */
/**
 * 🌊🌳 **水/绿该插到谁之前**（层序锚点）。
 *
 * 🔴 2026-09-30 机主真机实测（「那个江还是显示不了」）后的重写：
 *   逐像素比对两张 2392×1080 截图 —— 画面里 **64.7% 的像素是底图瓦片的水色 `#C0D8E0`**，
 *   而我们水层的青调（`ai.water` 合成色）**只占 0.23%**；同时 HUD 明明写着
 *   `🌊🌳 水 30 面 · 绿 255 面（真数据 · 格 3/3）` ⇒ **数据在、层也建了，但被底图栅格盖住了**。
 *   （旧口径是"插到第一个 `bld*` 之前"，可底图那几层 `bg/base/tint` 是**后加的**：
 *    主题在图层建好之后才落地 ⇒ 栅格被追加到最上面，把水/绿整片压住。）
 *
 * 新口径（按优先级）：
 *   ① **紧贴底图栅格之上** —— 找 `bg/base/tint` 里最靠上的那一层，取它**后面那一层**当锚点
 *      （锚点不存在/它就是最后一层 ⇒ 返回 undefined = 追加到最上，也就是"在栅格之上"）；
 *   ② 没有底图栅格（样式还没落地等）⇒ 退回老口径"第一个 `bld*` 之前"；
 *   ③ 都没有 ⇒ undefined（追加到最上）。
 * ⚠️ 刻意**不**拿 `ref`（注记栅格）与 `prerender*` 当参照：LOD 的设计就是"远景让预渲染瓦片盖住矢量层"，
 *    水/绿跟着它们跑到最上面会把那套设计弄反。
 */
export function gwBeforeIdOf(m: GwMapLike): string | undefined {
  try {
    const ls = m.getStyle?.()?.layers || [];
    let lastBase = -1;
    ls.forEach((l, i) => {
      const id = String(l?.id ?? "");
      if (id === "bg" || id === "base" || id === "tint") lastBase = i;
    });
    if (lastBase >= 0) {
      const next = ls[lastBase + 1];
      const nextId = next ? String(next.id ?? "") : "";
      /* 下一层可能是 `ref`（注记）或 prerender：那就插到它之前 ⇒ 仍在底图之上、注记之下 */
      return nextId || undefined;
    }
    for (const l of ls) {
      const id = String(l?.id ?? "");
      if (id.indexOf("bld") === 0) return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/* ══ ④ 落图：首次建源建层，之后只 `setData`（与页面原实现逐字同义的 8 行，抽出来共用） ═════ */

export interface GwApplyResult {
  /** 这次**新建**的图层 id（自检/回证要能回答"层到底建了没有"） */
  added: string[];
  /** 这次只 `setData`（层早就在）的图层 id */
  updated: string[];
  /** 实际存在的 gw 图层 / 数据源（回证读它） */
  layers: string[];
  sources: string[];
  /** 每层各自的失败原文（不静默；调用方决定写进 HUD 还是 errs） */
  errs: string[];
}

/**
 * 把两种要素落成两层 `fill`。
 * ⚠️ `beforeId` **每次只算一次**（两层用同一个锚点）—— 与页面原实现一致；
 * 颜色**必须由调用方从主题取好**（这里没有兜底色，取不到就别调它）。
 */
export function applyGwLayers(opts: {
  m: GwMapLike | null;
  colors: GwColors;
  data: Record<GwKind, readonly unknown[]>;
  beforeId?: string;
}): GwApplyResult {
  const out: GwApplyResult = { added: [], updated: [], layers: [], sources: [], errs: [] };
  const m = opts.m;
  if (!m) return out;
  /* 🔴 2026-09-29：**锚点不存在时不许让整层消失**。
     实测（App 页无头，面板原文）：地图库报了 12 条
     `Cannot add layer "road-casing-N" before non-existing layer "ref"` —— 说明"算 beforeId 那一刻还在、
     真正 addLayer 时已经被换掉"（迟到 setStyle / 主题重挂，本仓栽过多次的那一类）**是常态风险**。
     gw 的锚点同样来自 `bld*` 的现查 ⇒ 一旦那时没有 bld 层，`addLayer(spec, "bld-ext")` 会**直接抛**，
     整层不建、屏幕上就是"没有水"（而且只在 HUD 留一行字）。
     ⇒ 这里两道保险：① 加之前**再查一次**锚点在不在；② 仍失败就**退到追加**（`undefined`），
     宁可顺序不完美，也不许"整层不画"。 */
  let before = opts.beforeId;
  try {
    const get = (m as { getLayer?: (id: string) => unknown }).getLayer;
    if (before && typeof get === "function" && !get.call(m, before)) before = undefined;
  } catch {
    before = undefined;
  }
  for (const k of GW_KINDS) {
    const id = GW_LAYER_ID_OF[k];
    const color = opts.colors[k];
    if (!color) continue;                                     // 没颜色就不建（绝不拿兜底色顶上）
    const fc = { type: "FeatureCollection", features: opts.data[k] as unknown[] };
    try {
      const src = m.getSource(id);
      if (src) {
        src.setData(fc);
        out.updated.push(id);
      } else {
        m.addSource(id, { type: "geojson", data: fc });
        const spec = {
          id,
          type: "fill",
          source: id,
          paint: { "fill-color": color, "fill-outline-color": color },
        };
        try {
          m.addLayer(spec, before);
        } catch (e0) {
          /* 退到追加：顺序不完美，但"水在地图上"这件事不能因为一个锚点没了一笔勾销 */
          if (before === undefined) throw e0;
          m.addLayer(spec);
          out.errs.push(`${id} 锚点 "${before}" 不存在 ⇒ 已退到追加（顺序可能与其它层不同）`);
        }
        out.added.push(id);
      }
      out.layers.push(id);
      out.sources.push(id);
    } catch (e) {
      /* 失败**可见**（不静默）：页面原来写 `errs.push("gw " + e)`，这里把原文交给调用方 */
      out.errs.push(`${id} ${String((e as Error)?.message || e).slice(0, 60)}`);
    }
  }
  /* 🔴 2026-09-30：**只在"确实被底图栅格压住"时**才把水/绿挪一次（幂等、便宜、无噪音）。
     为什么不能每轮无条件 `moveLayer`：第一次上线的版本就是这么写的，结果 HUD 里冒出
     `gw-water moveLayer 失败（Cannot read properties of null …）`——样式在"算锚点"与"挪层"
     之间被换掉时，MapLibre 内部会读到已失效的层对象。既然目的是"别被压住"，
     那就**先看层序、被压住才动手**，并且**best-effort 不报错**（真正要暴露的是"有没有画出来"，
     那件事由 HUD 的 `🌊🌳 …` 判词负责）。 */
  try {
    const ls = (m as { getStyle?: () => { layers?: Array<{ id?: unknown }> } | undefined }).getStyle?.()?.layers || [];
    let lastBase = -1;
    let minGw = Number.POSITIVE_INFINITY;
    ls.forEach((l, i) => {
      const id = String(l?.id ?? "");
      if (id === "bg" || id === "base" || id === "tint") lastBase = i;
      if (out.layers.indexOf(id) >= 0) minGw = Math.min(minGw, i);
    });
    /* 有底图栅格、且水/绿排在它下面 ⇒ 才挪 */
    if (lastBase >= 0 && Number.isFinite(minGw) && minGw < lastBase) {
      const next = ls[lastBase + 1];
      const anchor = next ? String(next.id ?? "") : "";
      for (const id of out.layers) {
        try {
          const mv = (m as { moveLayer?: (a: string, b?: string) => void }).moveLayer;
          if (typeof mv === "function") mv.call(m, id, anchor || undefined);
        } catch {
          /* best-effort：挪不动就维持现状（顺序不完美好过"整层不画"） */
        }
      }
    }
  } catch {
    /* getStyle 不可用（宿主没暴露）⇒ 跳过 */
  }
  return out;
}

/* ══ ⑤ 署名：**只念包里的原话**（ODbL；与 App 对 bld/roads 的口径相同） ═══════════════════ */

export interface GwIndexLike {
  attribution?: string | null;
  source?: string | null;
  cellCount?: number | null;
  cellSize?: number | null;
}

/**
 * 署名原句：优先**可机读的** `attribution`（导出脚本写进去的那句常量），老包缺字段才退回 `source`。
 * 取不到就返回 `null` ⇒ 调用方写"署名取不到"，**绝不编一句**（署名是合规项）。
 */
export function gwAttributionOf(index: GwIndexLike | null | undefined): string | null {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}

/* ══ ⑥ 视野 → 格（**索引优先**：索引里没有的格 = 包外，零请求、且是读来的事实） ═══════════ */

export interface GwPlan {
  /** 这一轮**真要取**的格键（索引里有 ∩ 视野内，≤ `GW_BUNDLE_MAX_CELLS`，近的先取） */
  keys: string[];
  /** 视野一共需要几格（未截断前的数；判词里"只取了最近的"用） */
  wanted: number;
  /** 是不是被上限截过 */
  capped: boolean;
}

/**
 * 视野需要哪些 gw 格。**格数学只有一份**（`wsFeatureStore.bundleCellsForView`，
 * 与 `SPECS.gw.plan` 传的是**同一个函数同一组参数**），这里只多做一件索引过滤。
 */
export function gwPlanForView(
  indexCells: Set<string> | null,
  bounds: BundleBoundsLike | null,
  center: { lng: number; lat: number } | null
): GwPlan | null {
  const p = bundleCellsForView(bounds, center, GW_BUNDLE_MAX_CELLS, GW_BUNDLE_CELL_DEG);
  if (!p) return null;
  const keys = indexCells ? p.cells.map((c) => c.key).filter((k) => indexCells.has(k)) : p.cells.map((c) => c.key);
  return { keys, wanted: p.wanted, capped: p.capped };
}

/* ══ ⑦ 一行可数判词（**三态**；页面与 App 都念这一句，谁都不许自己拼数字） ═══════════════ */

export type GwState =
  /** `?gw=0` 关层 */
  | "off"
  /** 索引取不到 ⇒ 连"这一带有几格"都不知道 */
  | "no-index"
  /** 包按 X° 分格、前端按 0.05° 算 ⇒ **拒绝取数**（取格会把有数据的格说成「包外」） */
  | "size-mismatch"
  /** 主题里没有 `ai.water` / `ai.park` ⇒ 不画（绝不硬编码色号） */
  | "no-color"
  /** 视野里明明有格，却一格都没取到 ⇒ **数不出来**（不是 0） */
  | "uncounted"
  /** 有取到的格 ⇒ 报数（**可能是 0，那是"已量"的 0**） */
  | "counted";

export interface GwFacts {
  /** 这一层开着没有（App 恒 `true`；页面 `?gw=0` 时为 `false`） */
  on: boolean;
  state: GwState;
  /** 水/绿**面数**；`null` = **数不出来**（绝不写 0 冒充"没有"） */
  water: number | null;
  green: number | null;
  /** 视野里要取几格（索引判定的，≤6） */
  cells: number;
  /** 真拿到数据几格 */
  hit: number;
  /** 取数失败的格数（包外与失败分开计；这里只报失败） */
  failed: number;
  /** 索引里一共几格（`null` = 没读到） */
  indexCells: number | null;
  /** 包自己的格边长（度）；与常量对拍用 */
  cellSize: number | null;
  /** ODbL 署名原句（取不到 = null，不编） */
  attribution: string | null;
  /** 数不出来时的**原因原文** */
  why: string | null;
  /** 回证：gw 图层/数据源实际有几个（探针读它；不参与判词） */
  layers: string[];
  sources: string[];
}

/**
 * 判词那一行。**页面 HUD 的文案就是这几句**（逐字），抽出来之后两边念的是同一句。
 *
 * 三态分别在：
 *   · **正数**：`水 N 面 · 绿 M 面（真数据 · 格 g/G[ · 失败 K]）`；
 *   · **0（已量）**：同上，`N=M=0` 且 `g>0`（或这一带**索引里就没有格**，`G=0`）—— 那是量出来的 0；
 *   · **数不出来**：索引取不到 / 口径不符 / 主题没色 / 一格都没取到 —— 都**写清原因**，不写 0。
 */
export function gwVerdictLine(f: GwFacts): string {
  if (!f.on) return "🌊🌳 水/绿地 关（?gw=0）";
  if (f.state === "no-index") {
    return "🌊🌳 水/绿地 数不出来：索引取不到（" + String(f.why || "index.json 没读到").slice(0, 60) + "）";
  }
  if (f.state === "size-mismatch") {
    return (
      "🌊🌳 水/绿地 数不出来：格尺寸口径不符（包 " + String(f.cellSize) + "° / 前端 " + GW_BUNDLE_CELL_DEG +
      "°）⇒ **本轮一个格都不取**（取格会把有数据的格说成「包外」）"
    );
  }
  if (f.state === "no-color") return "🌊🌳 水/绿地 数不出来：主题里没有 ai.water / ai.park（不硬编码色号）";
  if (f.state === "uncounted") {
    return (
      "🌊🌳 水/绿地 数不出来：这一轮 0 格取到（格 " + f.hit + "/" + f.cells +
      (f.failed ? " · 失败 " + f.failed : "") + "）"
    );
  }
  return (
    "🌊🌳 水 " + f.water + " 面 · 绿 " + f.green + " 面（真数据 · 格 " + f.hit + "/" + f.cells +
    (f.failed ? " · 失败 " + f.failed : "") + "）"
  );
}

/**
 * 页面那个 `window.__GW__` 的**形状**（自证字段；探针读它）。
 * ⚠️ 字段名与页面历史版本**逐字相同**（`on/index/attribution/cells/hit/err/water/green`）——
 * 换名字等于让探针读一个不存在的字段（本项目反复踩过"自证字段撒谎"）。
 */
export interface GwSnapshot {
  on: boolean;
  index: number | null;
  attribution: string | null;
  cells: number;
  hit: number;
  err: number;
  water: number | null;
  green: number | null;
}

export function gwSnapshotOf(f: GwFacts): GwSnapshot {
  return {
    on: f.on,
    /* 与页面历史口径一致：`cellCount || null`（0 也写 null） */
    index: f.indexCells || null,
    attribution: f.attribution,
    cells: f.cells,
    hit: f.hit,
    err: f.failed,
    water: f.water,
    green: f.green,
  };
}

/* ══ ⑧ 装配：把上面这些接成"一层"（页面 / App 各建一个实例，规则完全共用） ═══════════════ */

export interface GwLayerHost {
  /** 地图（拿不到 ⇒ 这一轮只算事实、不落图；**不抛**） */
  map: () => GwMapLike | null;
  /** 视野（共享模块要的形状；拿不到 ⇒ 本轮什么都不做，如实写"未取"） */
  view: () => BundleView;
  /** 主题对象（页面 = `/wstheme.json` 那一份；App = `WsMapTheme`）——**颜色只从它取** */
  theme: () => unknown;
  /** 取一格（浏览器 = `wsOfflineFeed.fetchWithTimeout` 包 `fetch`；自检 = 假实现） */
  fetchCell: BundleFetch;
  /** `?gw=0` 这类开关（不传 = 一直开） */
  enabled?: () => boolean;
  /** 每一次算完判词都会回调（页面写 DOM HUD；App 写 stats）——**文案由本模块给** */
  onHud?: (line: string, facts: GwFacts) => void;
  /** 快照回调（页面写 `window.__GW__`；App 写回证出口） */
  onSnapshot?: (s: GwSnapshot, facts: GwFacts) => void;
  /** 失败原文（不静默；页面写 `errs`，App 写 `stats.note`） */
  onError?: (why: string) => void;
  /** 覆盖保留半径（米）；不传 = `GW_RETAIN_RADIUS_M` */
  retainRadiusM?: () => number;
  /** 覆盖插入锚点；不传 = `gwBeforeIdOf(map)`（**底图栅格之上、道路与楼体之下**） */
  beforeId?: (m: GwMapLike) => string | undefined;
}

export interface GwLayer {
  /** 按视野补格 → 落图 → 算事实 → 回判词。**永不抛**（失败都变成判词里的"数不出来：…"） */
  refresh(why?: string): Promise<GwFacts>;
  /** 上一次的事实（不取数、不改图） */
  facts(): GwFacts;
  /** 读过的索引（署名/格数从这里来；没读过 = null） */
  index(): BundleIndexFact | null;
  /** 累积仓库的要素数（回证用；数不出来 = null） */
  storeCount(): number | null;
}

function emptyFacts(on: boolean): GwFacts {
  return {
    on, state: "uncounted", water: null, green: null,
    cells: 0, hit: 0, failed: 0, indexCells: null, cellSize: null,
    attribution: null, why: null, layers: [], sources: [],
  };
}

/**
 * 换一份事实：**保留上一轮回证到的图层/数据源**（它们描述"地图上现在有什么"，
 * 不会因为这一轮换了判词态就消失）—— 只有 `draw()` 真的动过图层才覆盖。
 */
function nextFacts(prev: GwFacts, on: boolean, patch: Partial<GwFacts> & { state: GwState }): GwFacts {
  return Object.assign(emptyFacts(on), { layers: prev.layers.slice(), sources: prev.sources.slice() }, patch);
}

export function createGwLayer(host: GwLayerHost): GwLayer {
  /* 累积仓库：合并/淘汰规则在 `wsFeatureStore`（这里不写第二套）。水/绿很小（实测 5 格 / 359 面），
     但**上限照给**：它是帧率护栏的一部分，也给"取重了"留出兜底。 */
  const store: FeatureStore<BundleGwFeature> = createFeatureStore<BundleGwFeature>({
    cap: GW_STORE_CAP,
    idOf: gwIdOf,
    pointOf: gwPointOf,
  });

  let last: GwFacts = emptyFacts(host.enabled ? host.enabled() : true);
  let indexFact: BundleIndexFact | null = null;
  /**
   * 🔴 **在飞的索引加载**（2026-09-29 加的，治并发）：
   * 只有这一个 promise 会真的发请求，谁后到就 await 同一份 ⇒ 既不会重复取，也不会
   * 出现"进度标志已置真、数据还没写"的窗口（那个窗口会让 `idx.cellSize` 撞 null）。
   * 旧的 `indexDone` 布尔已被它取代（"读过没有"现在等价于 `indexFact !== null`）。
   */
  let indexInflight: Promise<BundleIndexFact> | null = null;

  /** 落图一次（首次建源建层，之后只 `setData`）；返回这次回证到的图层/数据源 */
  function draw(): void {
    const colors = gwColorsOf(host.theme());
    if (gwMissingColors(colors).length) return;               // 判词那一支已经提前返回，这里只是兜底
    const feats = store.features();
    const res = applyGwLayers({
      m: host.map(),
      colors,
      data: {
        water: feats.filter((f) => f.properties?.kind === "water"),
        green: feats.filter((f) => f.properties?.kind === "green"),
      },
      beforeId: beforeIdOf(),
    });
    last.layers = res.layers;
    last.sources = res.sources;
    for (const e of res.errs) host.onError?.("gw " + e);
  }

  function beforeIdOf(): string | undefined {
    const m = host.map();
    if (!m) return undefined;
    if (host.beforeId) {
      try {
        return host.beforeId(m);
      } catch {
        return undefined;
      }
    }
    return gwBeforeIdOf(m);
  }

  function recount(): void {
    const feats = store.features();
    last.water = feats.reduce((n, f) => n + (f.properties?.kind === "water" ? 1 : 0), 0);
    last.green = feats.reduce((n, f) => n + (f.properties?.kind === "green" ? 1 : 0), 0);
  }

  function emit(): GwFacts {
    const line = gwVerdictLine(last);
    try {
      host.onHud?.(line, last);
    } catch { /* HUD 失败不影响数据 */ }
    try {
      host.onSnapshot?.(gwSnapshotOf(last), last);
    } catch { /* 回证失败不影响数据 */ }
    return last;
  }

  /** 管道：取数/索引优先/每格独立超时/包外与失败分开计 —— **规则全在 `wsOfflineFeed`** */
  const feed = createBundleFeed<BundleGwFeature>({
    kind: "gw",
    store,
    view: host.view,
    fetchCell: host.fetchCell,
    flush: () => {
      draw();
    },
    retainRadiusM: host.retainRadiusM || (() => gwRetainRadiusM(host.view().bounds)),
    onError: (why) => host.onError?.(why),
  });

  async function refresh(why = "view"): Promise<GwFacts> {
    const on = host.enabled ? host.enabled() : true;
    if (!on) {
      last = nextFacts(last, false, { state: "off" });
      return emit();
    }
    try {
      /* ① 索引（一次；失败也要记住，别每帧重试）—— 署名与"哪些格存在"都从这里来 */
      /* 🔴🔴 **2026-09-29 修的真 bug：并发 refresh 撞 `null.cellSize`** ——
         原写法是 `if (!indexDone) { indexDone = true; const f = await loadBundleIndex(...); indexFact = f; ... }`
         ⇒ `indexDone` **在 await 之前**就置了 true：并发的第二次 refresh（开页时 `init` 与 `moveend`
         各 kick 一次，几乎必中）会跳过加载，直接走到下面 `const idx = indexFact` ——
         而那次赋值**还没发生**（`indexFact` 仍是初始的 null）⇒ `idx.cellSize` 抛
         `Cannot read properties of null (reading 'cellSize')` ⇒ **整轮水/绿层不画**，
         HUD 上只留一行红字（真机表现：**数据都对、画面上就是没有江**）。
         ⚠️ 这个坑在本文件的历史注释里出现过一次（`wsOfflineFeed.ts:1148-1153` 的"indexFact 仍是 null"
         那段），当时只修了"加载函数永不抛"，**没修调用方的并发**。
         ⇒ 现在改成**共享同一个在飞 promise**：谁先到谁发起，后来的 await 同一份；
         并且**兜一道 null 检查**（拿不到就如实写"数不出来"，绝不 deref）。 */
      if (!indexFact) {
        if (!indexInflight) {
          indexInflight = loadBundleIndex(host.fetchCell, "gw").then((f) => {
            indexFact = f;
            return f;
          });
        }
        const f = await indexInflight;
        /* `loadBundleIndex` 失败时**全 null**（它自己吞了异常，只如实标 null）⇒ 这里据此判"数不出来" */
        if (f.cellCount === null && f.cells === null) {
          last = nextFacts(last, true, { state: "no-index", why: "index.json 没读到", cellSize: f.cellSize });
          return emit();
        }
      }
      const idx = indexFact;
      if (!idx) {
        /* 并发兜底：上面那条 promise 还没回来就又有一轮 refresh（或它被 reset）⇒ 如实说，不 deref */
        last = nextFacts(last, true, { state: "uncounted", why: "索引还没读回来（并发 refresh）" });
        return emit();
      }
      /* ② 口径对拍（🔴 0.02/0.05 那次事故的硬化）：不符就**一个格都不取** —— 说"包外"是最坏的那种谎 */
      if (idx.cellSize !== null && Math.abs(idx.cellSize - GW_BUNDLE_CELL_DEG) > 1e-9) {
        last = nextFacts(last, true, {
          state: "size-mismatch",
          cellSize: idx.cellSize,
          indexCells: idx.cellCount,
          attribution: gwAttributionOf(idx),
          why: "包 " + idx.cellSize + "° / 前端 " + GW_BUNDLE_CELL_DEG + "°",
        });
        return emit();
      }
      /* ③ 颜色（主题里没有 ⇒ **不画**，也绝不用兜底色） */
      const colors = gwColorsOf(host.theme());
      if (gwMissingColors(colors).length) {
        last = nextFacts(last, true, {
          state: "no-color",
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "主题缺 " + gwMissingColors(colors).join("/"),
        });
        return emit();
      }
      /* ④ 取数（管道自己按视野算格；一次把新格取完 —— 水/绿包很小） */
      await feed.refresh(why);
      /* ⑤ 落图：管道只在"真有新格"时 flush 一次 ⇒ 这里**兜一次首屏/空视野**（页面原实现每轮都建层） */
      if (!last.layers.length) draw();
      /* ⑥ 事实 + 判词（三态） */
      const view = host.view();
      const plan = gwPlanForView(idx.cells, view.bounds, view.center);
      const facts = feed.facts();
      /* 🔴 **视野拿不到**（地图还没就绪 / 降级路）⇒ 也是「数不出来」，**不许**报成"格 0/0 的已量 0"：
         那是把"没法量"说成"量过了，是 0"。 */
      if (!plan) {
        last = nextFacts(last, true, {
          state: "uncounted",
          cells: 0,
          hit: 0,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "视野拿不到（地图还没就绪）",
        });
        return emit();
      }
      const keys = plan.keys;
      const hit = keys.reduce((n, k) => n + (store.has(gwSourceKeyOf(k)) ? 1 : 0), 0);
      const uncounted = keys.length > 0 && hit === 0;
      /* 🔴 **三态**：一格都没取到 ⇒ `water/green` 保持 `null`（判词写"数不出来"，原因写明），
         `recount()` **绝不能**在这一态跑 —— 它会把"数不出来"改写成 0 面，那就是**把没测出来说成没有**。 */
      if (uncounted) {
        last = nextFacts(last, true, {
          state: "uncounted",
          cells: keys.length,
          hit,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "视野里的格一格都没取到",
        });
      } else {
        last = nextFacts(last, true, {
          state: "counted",
          cells: keys.length,
          hit,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: null,
        });
        recount();
      }
      return emit();
    } catch (e) {
      /* 判词纪律：任何异常都变成"数不出来 + 原因"，**绝不**留一个 0 在屏上 */
      last = nextFacts(last, true, {
        state: "uncounted",
        why: String((e as Error)?.message || e).slice(0, 60),
      });
      host.onError?.("gw " + last.why);
      return emit();
    }
  }

  return {
    refresh,
    facts: () => last,
    index: () => indexFact,
    storeCount: () => {
      try {
        const s = store.stats();
        return Number.isFinite(s.n) ? s.n : null;
      } catch {
        return null;
      }
    },
  };
}
