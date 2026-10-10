/**
 * MVT 瓦片取数层（`?mvt=1` 先导）——`addProtocol("mvt", …)` 的 loader 与计数。
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

/** `?mvt=1` 的**唯一**判定处（宿主与取数层共用同一个正则，别写第二份） */
export function mvtEnabled(search?: string): boolean {
  const q = search !== undefined ? search : (typeof location !== "undefined" ? location.search : "");
  try { return /[?&]mvt=1\b/.test(q); } catch { return false; }
}

/** 瓦片模板（`mvt://` 由协议 loader 转成站点路径；见 `protocolHandler`） */
export const MVT_TILE_TEMPLATE = "mvt://mvt/{z}/{x}/{y}.pbf";
/** worker 侧协议脚本（同源静态文件；**必须**注入，否则 worker 查不到协议 ⇒ 瓦片不落地） */
export const MVT_WORKER_SCRIPT = "/mvt-worker-protocol.js";

/** gzip 魔数 */
export const MVT_GZIP_MAGIC: readonly number[] = [0x1f, 0x8b];

export function mvtIsGzip(u8: Uint8Array | null | undefined): boolean {
  return !!u8 && u8.length >= 2 && u8[0] === MVT_GZIP_MAGIC[0] && u8[1] === MVT_GZIP_MAGIC[1];
}

export interface MvtTilesFacts {
  requests: number;
  ok: number;
  empty: number;
  errors: number;
  gzipSeen: number;
  decompressed: number;
  passthrough: number;
  fallback: number;
  registeredMain: boolean;
  registeredWorker: boolean | "unknown";
}

export interface MvtTilesOptions {
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
  facts(): MvtTilesFacts;
}

/** 缺省解压：优先 `DecompressionStream`；没有 ⇒ `null`（**表示走了降级路**，由调用方计数） */
export async function mvtDefaultGunzip(u8: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  if (typeof DS !== "function") return null;
  const stream = new Blob([u8]).stream().pipeThrough(new (DS as new (f: string) => unknown)("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
}

export function createMvtTiles(opts: MvtTilesOptions = {}): MvtTiles {
  const facts: MvtTilesFacts = { requests: 0, ok: 0, empty: 0, errors: 0, gzipSeen: 0, decompressed: 0,
    passthrough: 0, fallback: 0, registeredMain: false, registeredWorker: "unknown" };
  let registered = false;

  const fetchBytes = opts.fetchBytes || (async (url: string, init?: { signal?: AbortSignal }) => {
    const r = await fetch(url, init);
    if (r.status === 404 || r.status === 204) return { status: r.status, u8: new Uint8Array(0) };
    return { status: r.status, u8: new Uint8Array(await r.arrayBuffer()) };
  });
  const decompress = opts.decompress || mvtDefaultGunzip;

  async function protocolHandler(params: { url?: string } | string, abort?: AbortController): Promise<{ data: ArrayBuffer }> {
    facts.requests += 1;
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
    return { data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer };
  }

  return {
    protocolHandler,
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
export interface MvtRuntime {
  tiles: MvtTiles;
  idTable: ReturnType<typeof import("./wsMvtIdTable").createMvtIdTable>;
  enabled: boolean;
  registeredAt: number;
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
  const tiles = createMvtTiles({ workerScriptUrl: opts.workerScriptUrl === undefined ? MVT_WORKER_SCRIPT : opts.workerScriptUrl });
  const idTable = opts.idTable || createMvtIdTable({ maxTiles: 64 });
  try { await tiles.register(ml as { addProtocol?: unknown; importScriptInWorkers?: unknown }); }
  catch (e) {
    (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = { enabled: true, error: String((e as Error)?.message || e), tiles: tiles.facts() };
    return null;
  }
  RUNTIME = { tiles, idTable, enabled: true, registeredAt: Date.now() };
  (globalThis as { __WS_MVT__?: unknown }).__WS_MVT__ = {
    enabled: true, template: opts.template || MVT_TILE_TEMPLATE,
    tiles: tiles.facts(), ids: idTable.facts(),
  };
  return RUNTIME;
}

/** 给宿主用：`?mvt=1` 时返回瓦片模板，否则 `null`（关掉那条路**一字节都不碰**） */
export function mvtTemplateForHost(): string | null {
  return mvtEnabled() && RUNTIME ? (RUNTIME.enabled ? MVT_TILE_TEMPLATE : null) : null;
}
