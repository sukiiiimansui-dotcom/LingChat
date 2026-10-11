/**
 * `?mvt=1` 的**主线程"视口覆盖登记"**：把当前视口应覆盖的瓦片取回来、解码、登记进 id 表。
 *
 * 为什么需要它（实测）：R1 那条路上，瓦片是 **worker** 自己取、自己解压的（协议在 worker 里注册），
 * 我们主线程的 loader **根本不会被调用** ⇒ `registeredTiles` 恒为 0、id 表是空的、页面上也没有
 * 任何可观测信号。两条候选里选了这条（主线程自己算覆盖 + fetch + 解码）：
 *   · **本机可验**（纯 Node 单测 + 变异证明，不依赖浏览器/worker 内部行为）；
 *   · 不赌"MapLibre 的 worker 会不会丢弃未知 `postMessage`"；
 *   · 与"id 是唯一真源、数据从我们自己的解码路径进来"的语义一致。
 *
 * 三条纪律（写进实现）：
 *   ① **每轮最多几块**（`maxTiles`）+ **并发上限**（`concurrency`）⇒ 不把主线程压死；
 *   ② 每块只登记**一次**（`seen` 集合按瓦片键去重）⇒ 不重复解码；
 *   ③ **计数与耗时全部露出来**（`facts()`：轮次/块数/要素数/冲突/解码失败/上一轮与累计耗时）
 *      ⇒ 能看出"它值不值"。
 */
import { decodeMvtFeatures } from "./wsMvtDecode";
import type { BldMvtIdTable } from "./wsMvtIdTable";

export interface CoverageBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

export interface CoverageFacts {
  /** 跑过几轮 / 每轮请求了几块 / 真的取到并解码了几块 */
  rounds: number;
  requested: number;
  registeredTiles: number;
  registeredFeatures: number;
  /** 404（生成器不落空瓦片 ⇒ 合法缺失）与解码失败（硬错误）分开计 */
  missing: number;
  decodeFailures: number;
  metaConflicts: number;
  /** 上一轮 / 累计耗时（ms）—— 用来判"这东西值不值" */
  lastRoundMs: number;
  totalMs: number;
  /** 因为 `maxTiles` 被跳过的块数（覆盖集合大于本轮上限时） */
  skippedOverCap: number;
  lastError: string | null;
}

export interface CoverageDeps {
  idTable: BldMvtIdTable;
  /** 瓦片模板（`mvt://…` 或 `/mvt/…` 都收；统一按站点路径取） */
  template: string;
  fetchBytes?: (url: string) => Promise<{ status: number; u8: Uint8Array }>;
  /** 注入解压（自检用）；缺省用 `DecompressionStream("gzip")` */
  gunzip?: (u8: Uint8Array) => Promise<Uint8Array | null>;
  maxTiles?: number;
  concurrency?: number;
  margin?: number;
  /** 解码器（自检注入用）；缺省 `decodeMvtFeatures` */
  decode?: (bytes: Uint8Array) => Array<{ id: number; properties: Record<string, unknown> }>;
}

export interface CoverageResult {
  ok: boolean;
  coverage: number;
  requested: number;
  registered: number;
  ms: number;
  skipped: number;
  missing: number;
  decodeFailures: number;
}

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** 视口覆盖的瓦片键（标准 slippy 切分；四周各外扩 `margin` 块） */
export function coverageTileKeys(b: CoverageBounds, zoom: number, margin = 1): string[] {
  const z = Math.max(0, Math.round(zoom));
  const x0 = lon2x(b.getWest(), z) - margin, x1 = lon2x(b.getEast(), z) + margin;
  const y0 = lat2y(b.getNorth(), z) - margin, y1 = lat2y(b.getSouth(), z) + margin;
  const max = 2 ** z - 1;
  const out: string[] = [];
  for (let x = Math.max(0, x0); x <= Math.min(max, x1); x++) {
    for (let y = Math.max(0, y0); y <= Math.min(max, y1); y++) out.push(`${z}/${x}/${y}`);
  }
  return out;
}

/** 缺省解压（浏览器与 Node 26 都有 `DecompressionStream`）；没有 ⇒ `null`（由调用方计数） */
async function defaultGunzip(u8: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  if (typeof DS !== "function") return null;
  const stream = new Blob([u8]).stream().pipeThrough(new (DS as new (f: string) => unknown)("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
}

export function createCoverageRegistrar(deps: CoverageDeps) {
  const maxTiles = Math.max(1, Math.floor(deps.maxTiles ?? 24));
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 4));
  const margin = deps.margin ?? 1;
  const decode = deps.decode || (decodeMvtFeatures as unknown as (b: Uint8Array) => Array<{ id: number; properties: Record<string, unknown> }>);
  const fetchBytes = deps.fetchBytes || (async (url: string) => {
    const r = await fetch(url);
    if (r.status === 404 || r.status === 204) return { status: r.status, u8: new Uint8Array(0) };
    return { status: r.status, u8: new Uint8Array(await r.arrayBuffer()) };
  });
  const seen = new Set<string>();
  const facts: CoverageFacts = { rounds: 0, requested: 0, registeredTiles: 0, registeredFeatures: 0,
    missing: 0, decodeFailures: 0, metaConflicts: 0, lastRoundMs: 0, totalMs: 0, skippedOverCap: 0, lastError: null };
  let inFlight = false;

  /** 瓦片键 → 站点路径（`mvt://mvt/{z}/{x}/{y}.pbf` 与 `/mvt/{z}/{x}/{y}.pbf` 都收） */
  function urlOf(key: string): string {
    const t = deps.template.replace(/^mvt:\/\//, "/");
    const [z, x, y] = key.split("/");
    return t.replace("{z}", z).replace("{x}", x).replace("{y}", y.replace(/\..*$/, "") + (t.endsWith(".pbf") ? ".pbf" : ""));
  }

  async function registerOne(key: string): Promise<boolean> {
    facts.requested += 1;
    let res: { status: number; u8: Uint8Array };
    try { res = await fetchBytes(urlOf(key)); }
    catch (e) { facts.missing += 1; facts.lastError = String((e as Error)?.message || e).slice(0, 120); return false; }
    if (!res || res.status === 404 || res.status === 204 || !res.u8 || res.u8.length === 0) { facts.missing += 1; return false; }
    let bytes = res.u8;
    /* ⚠️ **必须自己判 gzip**：HTTP 那条路服务器发 `Content-Encoding: gzip`、浏览器会替我们解；
       但**真 App 的 asset 路没有这个头**（磁盘上是 gzip）⇒ 不自己解就会把压缩字节当 protobuf 解、静默解出 0 条。
       （这条是自检抓出来的：注入的 fetch 返回磁盘字节时 registeredFeatures 恒为 0。） */
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      let raw: Uint8Array | null = null;
      try { raw = await (deps.gunzip || defaultGunzip)(bytes); }
      catch (e) { facts.decodeFailures += 1; facts.lastError = "gunzip:" + String((e as Error)?.message || e).slice(0, 100); return false; }
      if (!raw || !raw.length) { facts.decodeFailures += 1; facts.lastError = "gunzip: 解不开（缺 DecompressionStream？）"; return false; }
      bytes = raw;
    }
    let feats: Array<{ id: number; properties: Record<string, unknown> }>;
    try { feats = decode(bytes); } catch (e) { facts.decodeFailures += 1; facts.lastError = String((e as Error)?.message || e).slice(0, 120); return false; }
    let added = 0;
    try { added = deps.idTable.registerTileFromFeatures(key, feats).added; }
    catch (e) { facts.lastError = String((e as Error)?.message || e).slice(0, 120); return false; }
    facts.registeredTiles += 1;
    facts.registeredFeatures += added;
    facts.metaConflicts = deps.idTable.facts().conflicts;
    return true;
  }

  /**
   * 跑一轮：算覆盖 → 去重 → **每轮最多 `maxTiles` 块** → **并发 `concurrency`** 取+解+登记。
   * 同一时刻只允许一轮（`inFlight`）⇒ 相机抖动不会把它叠起来。
   */
  async function run(bounds: CoverageBounds | null | undefined, zoom: number | null | undefined): Promise<CoverageResult> {
    const t0 = Date.now();
    if (inFlight || !bounds || !Number.isFinite(Number(zoom))) {
      return { ok: false, coverage: 0, requested: 0, registered: 0, ms: 0, skipped: 0, missing: 0, decodeFailures: 0 };
    }
    inFlight = true;
    try {
      const all = coverageTileKeys(bounds, Number(zoom), margin);
      const todo = all.filter((k) => !seen.has(k));
      const skipped = Math.max(0, todo.length - maxTiles);
      const batch = todo.slice(0, maxTiles);
      let registered = 0;
      for (let i = 0; i < batch.length; i += concurrency) {
        const slice = batch.slice(i, i + concurrency);
        const rs = await Promise.all(slice.map((k) => registerOne(k)));
        for (let j = 0; j < slice.length; j++) if (rs[j]) { seen.add(slice[j]); registered += 1; }
      }
      facts.rounds += 1;
      facts.skippedOverCap += skipped;
      facts.lastRoundMs = Date.now() - t0;
      facts.totalMs += facts.lastRoundMs;
      return { ok: true, coverage: all.length, requested: batch.length, registered, ms: facts.lastRoundMs,
        skipped, missing: facts.missing, decodeFailures: facts.decodeFailures };
    } finally {
      inFlight = false;
    }
  }

  return { run, facts: () => ({ ...facts }), seenCount: () => seen.size };
}
