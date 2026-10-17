/**
 * MVT 瓦片取数层（**默认开**，`?mvt=0` 显式关）——`addProtocol("mvt", …)` 的 loader 与计数。
 *
 * 与工具仓那份同源（`world_map/mvt-spike/tools/wsMvtTiles.mjs` + `mvt-worker-protocol.js`），
 * 本文件是**宿主侧**那一半：主线程注册 + worker 注入 + 计数。三条实测约束（都来自 2026-10-10 的读数）：
 *
 *  ① **`config.REGISTERED_PROTOCOLS` 是每个线程一份**：只注册主线程时，worker 查不到协议、会
 *     `actor.sendAsync({type:"GR"})` 绕回主线程（实测：handler 被调、数据也返回，**但瓦片始终不落地**）。
 *     ⇒ 必须再用 `importScriptInWorkers` 往 worker 里注入一份（`public/mvt-worker-protocol.js`）。
 *  ② **worker 里一旦注册成功就不再回主线程**（`makeRequest` 查到协议就用它，失败也不回退）
 *     ⇒ worker 脚本必须**自适应**：worker 里没有 `DecompressionStream` 就**不注册**。
 *  ③ 磁盘上的 `.pbf` 是 gzip 的：HTTP 那条路由服务端发 `Content-Encoding`（浏览器自己解）；
 *     真 App 的 asset 路没有这个头 ⇒ **在 worker 里用 `DecompressionStream` 解**。
 *
 * 计数（HUD/探针读 `facts()`）：请求数 / gzip 命中 / 自己解压 / 走 HTTP 解压（passthrough）/
 * 空瓦片 / 降级（fallback）/ 错误。**降级不许静默**。
 */

/**
 * MVT 那条路的**唯一**判定处（宿主与取数层共用，别写第二份）。
 *
 * **2026-10-17 起默认开**（主人拍板「mvt 改成默认」）；`?mvt=0` / `?mvt=false` 显式关，
 * 关掉即**逐字节回到 GeoJSON 那条路**（`ws_bldlanding_move_selftest` 的影子对拍 diff 0 为证）。
 * `?mvt=1` 仍照旧表示"强制开"，供真机对拍用。
 *
 * 没有 `location`（Node 自检 / 非浏览器）时**按默认开**处理，除非显式传 `search`。
 */
export function mvtEnabled(search?: string): boolean {
  const q = search !== undefined ? search : (typeof location !== "undefined" ? location.search : "");
  try {
    if (/[?&]mvt=(0|false|off)\b/i.test(q)) return false;   // 显式关（回退口）
    return true;                                            // 默认开；`?mvt=1` 也走这里
  } catch { return true; }
}

/**
 * **overlay 后端与 MVT 互斥的护栏**（2026-10-17 默认翻转时加）。
 *
 * `wsOverlayBackend.grabBld()` 是从 `map.getSource("bld").getData()` 取 **FeatureCollection** 的；
 * **vector 源没有 `getData`** ⇒ 两者同开时 overlay **静默拿不到楼**（屏幕上少一片楼，且不报错）。
 * 在 M1 那条线把 overlay 改成读 vector 源（`querySourceFeatures`）之前：**overlay 开着就不启用 MVT**，
 * 宁可少一条新路，也不让默认路径上少一片楼。`three` 后端不依赖地图源（实测无引用）⇒ 不在护栏内。
 *
 * `?renderer=` 的解析真源在 `WsCityEntry.vue`（boot 参数）；这里只读同一个参数名做护栏，
 * 若那边改名，这里要一起改。持久化偏好走共享的 `readRendererPref()`（不写第二份）。
 */
import { fpsMark } from "./wsFpsProbe";

function overlayNeedsGeo(): boolean {
  try {
    const q = typeof location !== "undefined" ? location.search : "";
    const m = /[?&]renderer=([a-z]+)/i.exec(q);
    if (m) return String(m[1]).toLowerCase() === "overlay";
  } catch { /* 取不到 URL 就只看偏好 */ }
  /* 持久化偏好：**直接读同一个键**（真源 = `wsRenderBackend.ts` 的 `WS_RENDER_KEY = "wsm:v1:renderer"`）。
     不 import 那个模块：它拖 `vue` 与另外两个模块，会让本文件的 Node 自检 staging 变重/变脆；
     键名只此一处复制，那边改名这里要一起改（注释即契约）。 */
  try {
    const raw = localStorage.getItem("wsm:v1:renderer");
    return String(raw || "") === "overlay";
  } catch { return false; }
}

/** 旧 `/mvt/` 路径的模板（兼容旧页面/旧书签；新代码按 profile 选 `mvt-slim` / `mvt-full`） */
export const MVT_TILE_TEMPLATE = "mvt://mvt/{z}/{x}/{y}.pbf";
/** 运行期选出来的路：`protocol` = R1（协议 + worker 注册）· `plain` = 普通 URL 源（R3/R4） */
export type MvtMode = "protocol" | "plain";
/** worker 侧协议脚本（同源静态文件；**必须**注入，否则 worker 查不到协议 ⇒ 瓦片不落地） */
export const MVT_WORKER_SCRIPT = "/mvt-worker-protocol.js";
/** worker 能力探针（只问一件事：worker 里有没有 `DecompressionStream`） */
export const MVT_WORKER_PROBE = "/mvt-worker-probe.js";
/** 普通 URL 源用的模板（旧 `/mvt/`；不注册协议那条路） */
export const MVT_PLAIN_TEMPLATE = "/mvt/{z}/{x}/{y}.pbf";

import { decodeMvtFeatures } from "./wsMvtDecode";
import { createCoverageRegistrar, type CoverageBounds, type CoverageResult } from "./wsMvtCoverage";
/* **profile 的纯逻辑**（无 vue）：目录映射只有 `bldMvtDirOf` 一处；本文件只拼模板。 */
import { bldMvtDirOf, effectiveBldProfile, type WsBldProfile } from "./wsBldProfile";

/** profile → 协议路模板（`mvt://mvt-slim|mvt-full/{z}/{x}/{y}.pbf`） */
export function mvtTemplateForProfile(profile: WsBldProfile): string {
  return `mvt://${bldMvtDirOf(profile)}/{z}/{x}/{y}.pbf`;
}
/** profile → 普通 URL 源模板（`/mvt-slim|mvt-full/{z}/{x}/{y}.pbf`） */
export function mvtPlainTemplateForProfile(profile: WsBldProfile): string {
  return `/${bldMvtDirOf(profile)}/{z}/{x}/{y}.pbf`;
}

/** gzip 魔数 */
export const MVT_GZIP_MAGIC: readonly number[] = [0x1f, 0x8b];

export function mvtIsGzip(u8: Uint8Array | null | undefined): boolean {
  return !!u8 && u8.length >= 2 && u8[0] === MVT_GZIP_MAGIC[0] && u8[1] === MVT_GZIP_MAGIC[1];
}

export interface MvtTilesFacts {
  /** 已登记元数据的瓦片数 / 要素数 / 元数据冲突数 / 解码失败数（③ 的判据读数） */
  registeredTiles: number;
  registeredFeatures: number;
  metaConflicts: number;
  decodeFailures: number;
  requests: number;
  ok: number;
  empty: number;
  errors: number;
  gzipSeen: number;
  decompressed: number;
  passthrough: number;
  fallback: number;
  /** 运行期自适应：worker 没有解压器 ⇒ 回落普通 URL 源的次数（0/1，**不静默**） */
  fallbackPlain: number;
  registeredMain: boolean;
  registeredWorker: boolean | "unknown";
}

export interface MvtTilesOptions {
  /** id→元数据唯一真源：**在本层解码瓦片后登记**（不依赖 `querySourceFeatures`/渲染器） */
  idTable?: { registerTileFromFeatures(tileKey: string, features: readonly unknown[]): { added: number; skipped: number }; facts(): { conflicts: number }; };
  /** 注入解码（自检/测试用）；缺省用本仓的 `decodeMvtFeatures` */
  decode?: (bytes: Uint8Array) => Array<{ id: number; properties: Record<string, unknown> }>;
  /** 注入取字节（自检/测试用）；缺省用全局 `fetch` */
  fetchBytes?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; u8: Uint8Array }>;
  /** 注入解压（自检/测试用）；缺省用 `DecompressionStream("gzip")` */
  decompress?: (u8: Uint8Array) => Promise<Uint8Array | null>;
  /** worker 侧脚本的 URL（同源）；`null` = 不注入 worker（R4/纯 HTTP 那条路） */
  workerScriptUrl?: string | null;
}

export interface MvtTiles {
  /** MapLibre `addProtocol` 的 loader 形状：`(params, abort) => Promise<{data: ArrayBuffer}>` */
  protocolHandler(params: { url?: string } | string, abort?: AbortController): Promise<{ data: ArrayBuffer }>;
  /** 注册到主线程 + 往 worker 注入（幂等；同一实例重复调只做一次） */
  register(ml: { addProtocol?: unknown; importScriptInWorkers?: unknown }): Promise<void>;
  /** 运行期自适应选了普通 URL 源（worker 没解压器）⇒ 计数 */
  noteFallbackPlain(): void;
  facts(): MvtTilesFacts;
}

/** 缺省解压：优先 `DecompressionStream`；没有 ⇒ `null`（**表示走了降级路**，由调用方计数） */
export async function mvtDefaultGunzip(u8: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  if (typeof DS !== "function") return null;
  const stream = new Blob([u8]).stream().pipeThrough(new (DS as new (f: string) => unknown)("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
}

/** 解码入口（同步实现；留一层壳，便于注入/替换） */
function decodeMvtFeaturesAsync(bytes: Uint8Array): Array<{ id: number; properties: Record<string, unknown> }> {
  return decodeMvtFeatures(bytes) as unknown as Array<{ id: number; properties: Record<string, unknown> }>;
}

export function createMvtTiles(opts: MvtTilesOptions = {}): MvtTiles {
  const facts: MvtTilesFacts = { requests: 0, ok: 0, empty: 0, errors: 0, gzipSeen: 0, decompressed: 0,
    passthrough: 0, fallback: 0, fallbackPlain: 0, registeredMain: false, registeredWorker: "unknown",
    registeredTiles: 0, registeredFeatures: 0, metaConflicts: 0, decodeFailures: 0 };
  let registered = false;

  const fetchBytes = opts.fetchBytes || (async (url: string, init?: { signal?: AbortSignal }) => {
    const r = await fetch(url, init);
    if (r.status === 404 || r.status === 204) return { status: r.status, u8: new Uint8Array(0) };
    return { status: r.status, u8: new Uint8Array(await r.arrayBuffer()) };
  });
  const decompress = opts.decompress || mvtDefaultGunzip;

  async function protocolHandler(params: { url?: string } | string, abort?: AbortController): Promise<{ data: ArrayBuffer }> {
    facts.requests += 1;
    /* 帧率采集的行为打点：瓦片请求在协议 loader 里发生，打在这里才能和低帧率窗口对上 */
    fpsMark("mvt-tiles-fetch");
    const url = (typeof params === "string" ? params : (params && params.url) || "").replace(/^mvt:\/\//, "/");
    let res: { status: number; u8: Uint8Array };
    try {
      res = await fetchBytes(url, abort ? { signal: abort.signal } : undefined);
    } catch (e) {
      facts.errors += 1;
      throw e;
    }
    if (!res || res.status === 404 || res.status === 204 || !res.u8 || res.u8.length === 0) {
      facts.empty += 1;
      return { data: new ArrayBuffer(0) };                 // 空瓦片语义：给空 buffer，**不抛**（不制造 tile error 噪声）
    }
    /* 帧率采集的行为打点（第二处）：网络等待已经结束，下面这段解码/登记是同步 CPU 开销；
       入口那次打点的 TTL 可能已经耗完，在这里重新标一次。 */
    fpsMark("mvt-tiles-fetch");
    let u8 = res.u8;
    if (mvtIsGzip(u8)) {
      facts.gzipSeen += 1;
      let raw: Uint8Array | null = null;
      try { raw = await decompress(u8); } catch (e) { facts.errors += 1; throw e; }
      if (raw && raw.length) { facts.decompressed += 1; u8 = raw; }
      else {
        /* 有 gzip 魔数却解不开：**如实计数并抛出**（让上层走降级），绝不静默给空瓦片 */
        facts.fallback += 1;
        throw new Error("mvt: 收到 gzip 但解不开（缺 DecompressionStream ⇒ 应回落 HTTP 那条路：服务端发 Content-Encoding，或瓦片不压缩落盘）");
      }
    } else {
      facts.passthrough += 1;                              // 上层已按 Content-Encoding 解好
    }
    facts.ok += 1;
    /* ③ **在这条路上就登记**（不依赖浏览器查询 API）：解 id/属性 → 唯一真源。
       解码失败/属性缺失**如实计数**，绝不让它变成"表里悄悄少几栋"。 */
    if (opts.idTable) {
      try {
        const all = (opts.decode || decodeMvtFeaturesAsync)(u8);
        /* 拆件后**同 id 多件**（主体 p=0 / 女儿墙 4 / 设备箱 6 / 天线 7）⇒ id 表**只登记主体**，
           否则女儿墙顶高与主体高度会被判成"同 id 元数据冲突"（实测 1064 条假冲突）。 */
        const feats = all.filter((f) => Number(((f.properties || {}) as { p?: unknown }).p || 0) === 0);
        const tileKey = url.replace(/^\//, "").replace(/\.pbf.*$/, "");
        const r = opts.idTable.registerTileFromFeatures(tileKey, feats);
        facts.registeredTiles += 1;
        facts.registeredFeatures += r.added;
        facts.metaConflicts = opts.idTable.facts().conflicts;
      } catch (e) {
        facts.decodeFailures += 1;
        throw e;
      }
    }
    return { data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer };
  }

  return {
    protocolHandler,
    /** 宿主选路时调用（计数，供 HUD/探针读） */
    noteFallbackPlain() { facts.fallbackPlain += 1; },
    async register(ml) {
      if (registered) return;
      registered = true;
      const addProtocol = (ml as { addProtocol?: unknown }).addProtocol;
      if (typeof addProtocol === "function") {
        (addProtocol as (name: string, fn: unknown) => void)("mvt", protocolHandler);
        facts.registeredMain = true;
      }
      const workerUrl = opts.workerScriptUrl;
      const inject = (ml as { importScriptInWorkers?: unknown }).importScriptInWorkers;
      if (workerUrl && typeof inject === "function") {
        try {
          await (inject as (u: string) => Promise<void>)(workerUrl);
          facts.registeredWorker = true;
        } catch {
          facts.registeredWorker = false;                  // 注入失败 ⇒ 靠主线程那条路（GR），并如实记账
        }
      } else {
        facts.registeredWorker = false;
      }
    },
    facts() { return { ...facts }; },
  };
}

/* ── 运行时单例：宿主在拿到 maplibre 模块**之后、建图之前**调一次 `setupMvtProtocol()` ── */
/** 问一次 worker 的能力（浏览器里跑；拿不到答案 ⇒ 按"没有解压器"处理，选更保守的那条路） */
export async function probeWorkerCapabilities(url: string = MVT_WORKER_PROBE, timeoutMs = 1500):
  Promise<{ hasDecompressionStream: boolean; answered: boolean }> {
  try {
    const W = (globalThis as { Worker?: new (u: string) => Worker }).Worker;
    if (typeof W !== "function") return { hasDecompressionStream: false, answered: false };
    const w = new W(url);
    const answer = await new Promise<{ hasDecompressionStream: boolean } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      w.onmessage = (e: MessageEvent) => { clearTimeout(timer); resolve(e.data as { hasDecompressionStream: boolean }); };
      w.onerror = () => { clearTimeout(timer); resolve(null); };
    });
    try { w.terminate(); } catch { /* 已关就忽略 */ }
    return answer ? { hasDecompressionStream: !!answer.hasDecompressionStream, answered: true } : { hasDecompressionStream: false, answered: false };
  } catch {
    return { hasDecompressionStream: false, answered: false };
  }
}

export interface MvtRuntime {
  tiles: MvtTiles;
  idTable: ReturnType<typeof import("./wsMvtIdTable").createMvtIdTable>;
  enabled: boolean;
  registeredAt: number;
  /** 运行期选出来的路（协议 / 普通 URL） */
  mode: MvtMode;
  /** 主线程"视口覆盖登记"（R1 主路上 id 表的唯一来源；计数与耗时都在 `facts()`） */
  coverage: ReturnType<typeof createCoverageRegistrar> | null;
  /** 宿主该用的瓦片模板（跟着 `mode` 走） */
  template: string;
}
let RUNTIME: MvtRuntime | null = null;

/** 供 HUD/探针读（项目既有惯例：`__BLD_*` 一族） */
export function mvtRuntime(): MvtRuntime | null { return RUNTIME; }

/**
 * 注册 `mvt` 协议（R1：主线程 + worker 两处）。**必须在建图之前**调用 ——
 * worker 的 `REGISTERED_PROTOCOLS` 是独立一份（见文件头注），建图后再补会有一段"查不到协议"的窗口。
 * 失败**不静默**：把 `facts()` 与错误记进 `window.__WS_MVT__`，并如实返回 false。
 */
export async function setupMvtProtocol(
  ml: unknown,
  opts: { workerScriptUrl?: string | null; template?: string; idTable?: MvtRuntime["idTable"] } = {}
): Promise<MvtRuntime | null> {
  if (!mvtEnabled()) return null;
  if (RUNTIME) return RUNTIME;
  const { createMvtIdTable } = await import("./wsMvtIdTable");
  const idTable = opts.idTable || createMvtIdTable({ maxTiles: 64 });
  const tiles = createMvtTiles({ workerScriptUrl: opts.workerScriptUrl === undefined ? MVT_WORKER_SCRIPT : opts.workerScriptUrl, idTable });
  /* **运行期自适应**：先问 worker 有没有解压器 —— 没有就不注册协议、直接走普通 URL 源，并计数。
     拿不到答案（探针超时/无 Worker）⇒ 也按"没有"处理（选更保守、在两个发货口径下都能落地的那条）。 */
  const cap = await probeWorkerCapabilities();
  /* **安全降级（2026-10-17 默认开之后新增）**：默认开着，但这条路的磁盘瓦片是 gzip 的，
     而 worker 侧的解压器是"能不能解"的唯一支点。解压器缺失时**不再**退到"普通 URL 源"
     （那条路 MapLibre 直接取字节、没有 Content-Encoding ⇒ 拿 gzip 当 protobuf 解 ⇒ 图上什么都没有，
     而且**一声不响**）⇒ 这里**把整条 MVT 路关掉**，逐字节回到 GeoJSON 那条老路，并如实记账。
     `?mvt=1` 是强制口（真机排障用）：强制时仍按老逻辑退到普通 URL 源。 */
  const forced = (() => { try { return /[?&]mvt=1\b/.test(typeof location !== "undefined" ? location.search : ""); } catch { return false; } })();
  /* overlay 与 MVT 互斥（见 `overlayNeedsGeo` 的说明）：不强开时直接不启用，并记账。 */
  if (!forced && overlayNeedsGeo()) {
    (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = {
      enabled: false, reason: "overlay-needs-geojson",
      note: "overlay 后端从 bld 源取 FeatureCollection（vector 源没有 getData）⇒ 两者互斥，MVT 本次不启用",
    };
    return null;
  }
  if (!cap.hasDecompressionStream && !forced) {
    (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = {
      enabled: false, reason: "no-decompression-stream", probe: cap,
      note: "默认开但 worker 里没有 DecompressionStream ⇒ 整条 MVT 关掉，回到 GeoJSON 路（不静默变差）",
    };
    return null;
  }
  const mode: MvtMode = cap.hasDecompressionStream ? "protocol" : "plain";
  if (mode === "protocol") {
    try { await tiles.register(ml as { addProtocol?: unknown; importScriptInWorkers?: unknown }); }
    catch (e) {
      (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = { enabled: true, error: String((e as Error)?.message || e), tiles: tiles.facts() };
      return null;
    }
  } else {
    (tiles as { noteFallbackPlain?: () => void }).noteFallbackPlain?.();
  }
  /* 模板按 **profile** 选目录（slim/full），一个 profile 同时管瓦片与离线包；
     `opts.template` 仍可显式覆盖（自检/对拍）。切换 profile 需要刷新（见 `wsBldProfile`）。 */
  const profile = effectiveBldProfile();
  const template = mode === "protocol"
    ? (opts.template || mvtTemplateForProfile(profile))
    : mvtPlainTemplateForProfile(profile);
  /* 主线程登记器：**R1 主路上 id 表的唯一来源**（worker 那条路不经过我们的 loader） */
  const coverage = createCoverageRegistrar({ idTable, template, maxTiles: 24, concurrency: 4 });
  RUNTIME = { tiles, idTable, enabled: true, registeredAt: Date.now(), mode, template, coverage };
  /* ⚠️ 用 **getter** 暴露：页面读的时候要拿到**实时**计数（一次性快照会让"登记的块数"永远是 0）。 */
  (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = {
    enabled: true, mode, template, probe: cap,
    get tiles() { return tiles.facts(); },
    get ids() { return idTable.facts(); },
    get coverage() { return coverage.facts(); },
  };
  return RUNTIME;
}

/** 给宿主用：开关开着时返回**本次运行期选出来**的瓦片模板，否则 `null`（关掉那条路**一字节都不碰**） */
export function mvtTemplateForHost(): string | null {
  return mvtEnabled() && RUNTIME && RUNTIME.enabled ? RUNTIME.template : null;
}

/**
 * 宿主每轮落图后调一次：**主线程登记当前视口覆盖的瓦片**（节流与每轮上限在 registrar 里）。
 * 关闭 / 未注册 ⇒ 立刻 return（那条路一字节都不碰）。**不 await**：登记不该拖住落图。
 */
export function mvtCoverageRun(bounds: CoverageBounds | null | undefined, zoom: number | null | undefined): Promise<CoverageResult | null> {
  if (!RUNTIME || !RUNTIME.coverage) return Promise.resolve(null);
  return RUNTIME.coverage.run(bounds, zoom).catch(() => null);
}

/** 覆盖登记的实时计数（探针/HUD 读） */
export function mvtCoverageFacts(): ReturnType<ReturnType<typeof createCoverageRegistrar>["facts"]> | null {
  return RUNTIME && RUNTIME.coverage ? RUNTIME.coverage.facts() : null;
}

/** 运行期选路的结果（HUD/探针读；`mode === "plain"` 说明 worker 没有解压器、已自动回落） */
export function mvtMode(): MvtMode | null {
  return RUNTIME ? RUNTIME.mode : null;
}
