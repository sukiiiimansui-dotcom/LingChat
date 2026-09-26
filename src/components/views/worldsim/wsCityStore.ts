/**
 * wsCityStore.ts —— 「城市数据包」的**取数与存储接口**（App 入口替换 / 初始引导，2026-09-26）
 *
 * ## 一句话
 * 引导页要能说清：**城市名 / 包多大 / 已装没装 / 下载进度 / 失败原因**；
 * 而"包从哪来、装到哪去"必须能被换掉（现在是浏览器预览，真机是 Tauri 文件系统）。
 * 所以这里只有**一个门面** `cityStore()`，方法固定四个：
 *
 *   · `list()`                  —— 读清单（三态：正数 / 0（已量）/ 数不出来 + 原因）
 *   · `installed()`             —— 已经装好的城市（含元数据；`[]` 是"确实一个都没装"，不是"读不到"）
 *   · `install(id, onProgress)` —— 下载 → 校 sha256 → 解包 → 存；每一步都有真进度与真失败原因
 *   · `remove(id)`              —— 卸载（元数据 + 内容一起清）
 *
 * ## 🔴 换真源只改一处
 * `WS_CITY_PACK_BASE`（下面那个常量）是**下载源唯一可替换点**：机主拍的
 * 「下载源先用本机预览服务（5212）」就是它。以后换成 CDN 只改这一行 —— 别在别处再写一个地址。
 *
 * ## 🔴 下一片（真机落盘）要接的接口点
 * 真机是 Tauri 壳，**没有 HTTP 服务**（`/bldbundle/<格>.json` 这类相对路径在真机上取不到，
 * 这是今天已知的缺口，正是"选城市 + 下载"要补的洞）。下一片要做的是：
 *   ① 后端加两条命令：`ws_city_download(id, url, sha256)`（边下边写文件 + 报进度）
 *      与 `ws_city_remove(id)` / `ws_city_list()`；落盘位置与既有 `api::data_dir()` 同一套；
 *   ② 前端把 `createCityStore({ backend })` 的 `backend` 换成"调上面三条命令"的实现
 *      （`CityPackBackend` 就是为这个留的缝，**引导 UI 一行都不用改**）；
 *   ③ 让取数管道从"已装城市"读格：`wsOfflineFeed.bundleCellUrl()` 是唯一的口径点，
 *      换 URL 前缀 / 换成文件读取都从那里进（本文件暴露 `readCell()` 给那一步用）。
 * 本片**不做**上面三件（机主明确："真机的下载落盘/断点续传留到下一片"）。
 *
 * ## 浏览器实现（本片）
 * · 下载：真 `fetch` + `ReadableStream` 逐块读 ⇒ **真进度**（有 `content-length` 就有分母，
 *   没有就老老实实"已下载 X MB · 总大小未知"，**不装确定进度条**）；
 * · 校验：`crypto.subtle` 算整包 sha256，与清单里的 `sha256` 对账（清单没给就如实写"未校验"）；
 * · 解包：`wsCityPack.readPackContents()`（`DecompressionStream`，零新依赖）；
 * · 落盘：元数据进 `localStorage`（这样**装过就直接进地图，不再问**），格内容进内存 Map。
 *   ⚠️ 如实说明：浏览器预览里"格内容"只在本次会话的内存里（刷新即空）——
 *   真机落盘是下一片的事；所以这里把"内存驻留上限"写死并**把超限情形报到界面上**，不假装全都装下了。
 */

import {
  type CityListState,
  type CityPackInfo,
  type PackContents,
  errText,
  fmtBytes,
  parseCityList,
  parseZipEntries,
  readPackContents,
  readZipEntryBytes,
  sha256Hex,
  type ZipEntry,
} from "./wsCityPack";

/** 🔴 下载源唯一可替换点（机主：先用本机预览服务 5212）。换 CDN 只改这一行。 */
export const WS_CITY_PACK_BASE = "http://127.0.0.1:5212";

/** 清单与包的路径口径（`{BASE}/citypacks/...`）——同样只有这一份 */
export function cityPackUrl(rel: string, base = WS_CITY_PACK_BASE): string {
  return base.replace(/\/+$/, "") + "/citypacks/" + rel.replace(/^\/+/, "");
}

/** 已装城市（元数据）—— 引导页"已装没装 / 包多大"就读它 */
export interface InstalledCity {
  id: string;
  name: string;
  /** 清单声明的包大小（字节；未声明 = undefined，**不写 0**） */
  bytes?: number;
  /** 实下载字节数（真数出来的） */
  got: number;
  /** 包里的格数（读出来的） */
  cells: number;
  /** 包里的文件数 */
  files: number;
  /**
   * 实际**驻留**的包内条目数 / 应该驻留的条目数（文本类：`.json` / `.txt` / `.md`）。
   * 两个都在 ⇒ "装了多少"是可数的；`resident` 那串只在**没装全**时才出现（如实写原因）。
   */
  stored?: number;
  entries?: number;
  /** 包内格粒度（从格文件名/格键读出来，去重升序）—— 粒度正在从 0.05 改到 0.01，**别假设单值** */
  cellSizes?: number[];
  /** sha256 对账结果：`ok` 对上 / `mismatch` 对不上 / `none` 清单没给（未校验） / `skip` 没算 */
  sha: "ok" | "mismatch" | "none" | "skip";
  /** 装完的时间戳 */
  at: number;
  /** 署名原句（清单给的；没有 = 空串，界面上如实写"未声明"） */
  attribution: string;
  /** 未能全部驻留内存时的原因（空 = 全在） */
  resident?: string;
}

/** 进度事件：阶段 + 真字节数（`total` 为 null = 服务端没给 content-length，**别编分母**） */
export interface InstallProgress {
  stage: "download" | "verify" | "unpack" | "store";
  got: number;
  total: number | null;
  note?: string;
}

export type InstallOutcome =
  | { ok: true; city: InstalledCity; contents: PackContents }
  | { ok: false; stage: InstallProgress["stage"]; why: string };

/**
 * 存储后端（**下一片换成 Tauri 实现的那道缝**）。
 * 浏览器默认实现见 `browserBackend()`；自检注入内存实现（不碰 localStorage）。
 */
export interface CityPackBackend {
  readMeta(): InstalledCity[];
  writeMeta(list: InstalledCity[]): void;
  putCells(entries: Array<[string, string]>): void;
  getCell(name: string): string | null;
  dropCellsFor(id: string): void;
}

/** 内存驻留上限（超过就只留 index + 名字表，并把原因写进 `InstalledCity.resident`） */
export const WS_CITY_RESIDENT_MAX_BYTES = 64 * 1024 * 1024;

const META_KEY = "ws.citypacks.v1";

function ls(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式/被禁 ⇒ 只是"记不住"，功能照走
  }
}

/** 浏览器后端：元数据 → localStorage；格内容 → 内存 Map（真机落盘在下一片） */
export function browserBackend(): CityPackBackend {
  const cells = new Map<string, string>();
  return {
    readMeta() {
      const raw = ls()?.getItem(META_KEY);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? (arr as InstalledCity[]) : [];
      } catch {
        return []; // 存坏了就当没装过（下一次 install 会覆盖）
      }
    },
    writeMeta(list) {
      try {
        ls()?.setItem(META_KEY, JSON.stringify(list));
      } catch {
        /* 配额满/被禁：不抛（界面会显示"记不住 ⇒ 每次都会问你"） */
      }
    },
    putCells(entries) {
      for (const [k, v] of entries) cells.set(k, v);
    },
    getCell(name) {
      return cells.get(name) ?? null;
    },
    dropCellsFor() {
      /* 浏览器预览里内存 Map 是全局一份，按城市精确回收要等真机落盘那一片；
         这里如实留空：拿到真机后端时 dropCellsFor(id) 就是删目录。 */
    },
  };
}

/** 纯内存后端（自检/一次性会话用；不碰 localStorage） */
export function memoryBackend(seed: InstalledCity[] = []): CityPackBackend {
  const cells = new Map<string, string>();
  let meta: InstalledCity[] = seed.slice();
  return {
    readMeta: () => meta.slice(),
    writeMeta: (list) => {
      meta = list.slice();
    },
    putCells: (entries) => {
      for (const [k, v] of entries) cells.set(k, v);
    },
    getCell: (name) => cells.get(name) ?? null,
    dropCellsFor: () => {
      /* 自检里够用：元数据由 writeMeta 清 */
    },
  };
}

export interface CityStoreOptions {
  base?: string;
  backend?: CityPackBackend;
  fetchImpl?: typeof fetch;
  /** 清单缓存毫秒（默认 60s；`list(true)` 会强制重取） */
  listTtlMs?: number;
  /** 内存驻留上限（默认 `WS_CITY_RESIDENT_MAX_BYTES`；自检会调小它来验"超限如实报"） */
  residentMaxBytes?: number;
}

export interface CityStore {
  /** 当前下载源（只读；改它请改 `WS_CITY_PACK_BASE`） */
  readonly base: string;
  list(force?: boolean): Promise<CityListState>;
  installed(): InstalledCity[];
  install(id: string, onProgress?: (p: InstallProgress) => void): Promise<InstallOutcome>;
  remove(id: string): void;
  /** 读已装进内存的格内容（下一片：取数管道从"已装城市"读格时用它） */
  readCell(name: string): string | null;
  /** 只给自检/调试：清掉清单缓存 */
  forgetList(): void;
}

/** 造一个门面。App 里请用 `cityStore()`（单例）；自检传自己的 backend/fetch。 */
export function createCityStore(opts: CityStoreOptions = {}): CityStore {
  const base = (opts.base || WS_CITY_PACK_BASE).replace(/\/+$/, "");
  const backend = opts.backend || browserBackend();
  const doFetch = opts.fetchImpl || ((...a: Parameters<typeof fetch>) => fetch(...a));
  const ttl = opts.listTtlMs ?? 60_000;
  const residentMax = opts.residentMaxBytes ?? WS_CITY_RESIDENT_MAX_BYTES;
  let cached: { at: number; val: CityListState } | null = null;
  /** 清单里的城市表（install 要拿 url/sha256/attribution） */
  let cachedCities: CityPackInfo[] = [];

  const url = (rel: string): string => base + "/citypacks/" + rel.replace(/^\/+/, "");
  const listUrl = (): string => url("cities.json");

  async function readList(): Promise<CityListState> {
    let r: Response;
    try {
      r = await doFetch(listUrl(), { cache: "no-store" } as RequestInit);
    } catch (e) {
      return { state: "unknown", why: "取清单失败：" + errText(e) + "（" + listUrl() + "）" };
    }
    if (!r.ok) return { state: "unknown", why: "取清单失败：HTTP " + r.status + " " + (r.statusText || "") + "（" + listUrl() + "）" };
    let json: unknown;
    try {
      json = await r.json();
    } catch (e) {
      return { state: "unknown", why: "清单不是合法 JSON：" + errText(e) + "（" + listUrl() + "）" };
    }
    /* 清单三态只有一套口径：解析在 `wsCityPack.parseCityList()`，这里只转发 */
    return parseCityList(json);
  }

  async function list(force = false): Promise<CityListState> {
    if (!force && cached && Date.now() - cached.at < ttl) return cached.val;
    const val = await readList();
    cached = { at: Date.now(), val };
    cachedCities = val.state === "ok" ? val.cities : [];
    return val;
  }

  /** 读包里某一格的文本（entries 复用：一次解析、多格读取，别每格重解一遍 zip） */
  async function cellText(all: Uint8Array, entries: ZipEntry[], name: string): Promise<string> {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new Error("包里没有这一格：" + name);
    return new TextDecoder("utf-8").decode(await readZipEntryBytes(all, e));
  }

  async function install(id: string, onProgress?: (p: InstallProgress) => void): Promise<InstallOutcome> {
    const report = (stage: InstallProgress["stage"], got: number, total: number | null, note?: string): void => {
      onProgress?.({ stage, got, total, note });
    };

    /* ① 先要清单（要 url / sha256 / 名字）。清单读不到 ⇒ 这一步就如实失败，绝不硬编地址去猜。 */
    const listState = await list();
    if (listState.state !== "ok") {
      const why = listState.state === "empty" ? "清单里没有任何城市" : listState.why;
      return { ok: false, stage: "download", why: "拿不到城市清单 ⇒ " + why };
    }
    const info = cachedCities.find((c) => c.id === id);
    if (!info) return { ok: false, stage: "download", why: "清单里没有这个城市：" + id };
    const zipUrl = info.url ? (info.url.startsWith("http") ? info.url : url(info.url)) : url(id + ".zip");

    /* ② 下载（真进度；没有 content-length 就把 total 报成 null） */
    let bytes: Uint8Array;
    let got = 0;
    let total: number | null = null;
    try {
      const r = await doFetch(zipUrl, { cache: "no-store" } as RequestInit);
      if (!r.ok) {
        return { ok: false, stage: "download", why: "下载失败：HTTP " + r.status + " " + (r.statusText || "") + "（" + zipUrl + "）" };
      }
      const len = Number(r.headers?.get?.("content-length") || 0);
      total = Number.isFinite(len) && len > 0 ? len : null;
      const reader = r.body?.getReader?.();
      if (!reader) {
        const buf = new Uint8Array(await r.arrayBuffer());
        got = buf.length;
        bytes = buf;
        report("download", got, total, "服务端没给流式响应，一次性读完");
      } else {
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            got += value.length;
            report("download", got, total);
          }
        }
        const all = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        bytes = all;
      }
    } catch (e) {
      return { ok: false, stage: "download", why: "下载失败：" + errText(e) + "（" + zipUrl + "）" };
    }

    /* ③ 校 sha256（清单没给就如实标 none —— "没校验"和"校验通过"是两件事） */
    let sha: InstalledCity["sha"] = info.sha256 ? "skip" : "none";
    if (info.sha256) {
      report("verify", got, total, "正在算 sha256");
      try {
        const mine = await sha256Hex(bytes);
        if (mine.toLowerCase() !== info.sha256.trim().toLowerCase()) {
          return {
            ok: false,
            stage: "verify",
            why: "sha256 对不上（清单 " + info.sha256.slice(0, 16) + "… / 实得 " + mine.slice(0, 16) + "…）⇒ 包已丢弃，请重试",
          };
        }
        sha = "ok";
      } catch (e) {
        return { ok: false, stage: "verify", why: "校验失败：" + errText(e) };
      }
    }

    /* ④ 解包 */
    report("unpack", got, total, "正在解包");
    let contents: PackContents;
    let entries: ZipEntry[];
    try {
      entries = parseZipEntries(bytes);
      contents = await readPackContents(bytes);
    } catch (e) {
      return { ok: false, stage: "unpack", why: "解包失败：" + errText(e) };
    }
    if (!contents.cells.length && !contents.declared) {
      return { ok: false, stage: "unpack", why: "包内容不认识：" + (contents.cellsWhy || "原因不明") };
    }
    /* 🔴 压缩方式要先在这里拦住：`readPackContents()` 只读 index.json，
       坏格子要等到"写入"那一步才会炸 —— 那样报出来的阶段是 `store`，
       读的人会跑去查存储，实际坏的是包。所以这一步就把清单摊开来看。 */
    if (contents.unsupported.length) {
      const head = contents.unsupported.slice(0, 4).join("、");
      const tail = contents.unsupported.length > 4 ? " 等 " + contents.unsupported.length + " 个" : "";
      return { ok: false, stage: "unpack", why: "包里有本实现不支持的压缩方式：" + head + tail };
    }

    /* ⑤ 存 —— 存**整包条目**（按 zip 顺序），不只是格文件。
       🔴 为什么不只存格文件：feed 的**第一跳**就是 `/<层目录>/index.json`（先读格白名单再取格），
       层索引不是"格"、但**必须能读出来**，否则"从已装城市包读数据"第一步就失败
       （城市包那条线实测报回来的缺口）。
       顺序沿用 zip 顺序：导出器把「根 index + NOTICE + 四张层索引 + gw + places + roads + bld」
       排在前面的收益（装到一半时水绿/片区名/路网仍然完整）**只有在这个顺序下才成立**。 */
    report("store", got, total, "正在写入");
    let resident: string | undefined;
    const texty = contents.files.filter((f) => !f.endsWith("/") && /\.(json|txt|md)$/i.test(f));
    let stored = 0;
    try {
      const keep: Array<[string, string]> = [];
      let acc = 0;
      for (const file of texty) {
        const text = await cellText(bytes, entries, file);
        acc += text.length;
        if (acc > residentMax) {
          resident =
            "只驻留了 " +
            keep.length +
            "/" +
            texty.length +
            " 个包内条目（累计 " +
            fmtBytes(acc) +
            " 超过内存上限 " +
            fmtBytes(residentMax) +
            "）—— 真机落盘在下一片";
          break;
        }
        keep.push([file, text]);
        stored = keep.length;
      }
      backend.putCells(keep);
    } catch (e) {
      return { ok: false, stage: "store", why: "写入失败：" + errText(e) };
    }

    const city: InstalledCity = {
      id: info.id,
      name: info.name,
      bytes: info.bytes,
      got,
      /* **格数**取"去重格键数"（`cellCount`）—— 与清单里的 `cells` 同口径；
         `files` 是包内条目数（含各层 index.json），两个数不混。 */
      cells: contents.cellCount,
      files: contents.files.length,
      stored,
      entries: texty.length,
      cellSizes: contents.cellSizeSeen,
      sha,
      at: Date.now(),
      attribution: info.attribution || "",
      resident,
    };
    const meta = backend.readMeta().filter((c) => c.id !== city.id);
    meta.push(city);
    backend.writeMeta(meta);
    report("store", got, total, "装好了");
    return { ok: true, city, contents };
  }

  /** 已装城市（**从后端读**，不是另一个内存副本 —— 换 Tauri 后端后这里读的就是文件系统） */
  function installed(): InstalledCity[] {
    return backend.readMeta();
  }

  function remove(id: string): void {
    backend.writeMeta(backend.readMeta().filter((c) => c.id !== id));
    backend.dropCellsFor(id);
  }

  return {
    base,
    list,
    installed,
    install,
    remove,
    readCell: (name: string) => backend.getCell(name),
    forgetList: () => {
      cached = null;
    },
  };
}

let singleton: CityStore | null = null;

/** App 用的单例（引导页只调它）。浏览器实现；真机那一片把 backend 换掉即可。 */
export function cityStore(): CityStore {
  if (!singleton) singleton = createCityStore();
  return singleton;
}
