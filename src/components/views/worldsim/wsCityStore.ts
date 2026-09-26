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
 * ## 🔴 下载源：一处可替换 + 两条覆盖途径（本文件是唯一入口）
 * `WS_CITY_PACK_BASE_DEFAULT` 是**唯一的常量行**，默认值 = **示例占位**
 * （RFC 2606 保留域名 `.invalid`，永远不会解析成真服务器）：
 * **真源由维护者或用户自建**（GitHub Release / 自己的静态服务器都行），
 * 见 `world_map/CITY-PACK-FORMAT.md` 的「托管与自建」。优先级从高到低：
 *
 *   ① **运行时** `?citybase=<url>`：不改码、不重编译就能换源（浏览器预览、给 reviewer 试自己的源用）；
 *   ② **构建期** `VITE_WS_CITY_PACK_BASE`：fork / 自建打包的人写进 `.env`，一次配好、永久生效；
 *   ③ `WS_CITY_PACK_BASE_DEFAULT`：示例占位（**谁都没配**时的诚实默认值：取不到清单 ⇒ "数不出来"）。
 *
 * 坏值（空 / 不是 URL / 非 http(s) 协议）⇒ **回落到默认占位**，并把原因记进
 * `WS_CITY_PACK_BASE_INFO`（`from: "fallback"` + `why` + `requested`）—— 不静默、不猜、不当成"没配"。
 * 「按顺序取三个来源」这个判断是**纯函数** `resolveCityPackBase()`（自检逐条验它，不依赖真 location）。
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

/**
 * 🔴 下载源默认值 = **示例占位**（RFC 2606 保留域名 `.invalid`：永远不会解析成真服务器，
 * 所以"忘了配"会**响亮地**失败成"数不出来"，而不是静默打到某台真服务器上）。
 * ⇒ 真源不随代码走：维护者用 GitHub Release / 用户自建静态服务器，见 `CITY-PACK-FORMAT.md`「托管与自建」。
 */
export const WS_CITY_PACK_BASE_DEFAULT = "https://example.invalid/lingchat-citypacks";

/** 运行时覆盖的参数名：`?citybase=<url>`（值里有 `&` 请自己 URL 编码） */
export const WS_CITY_PACK_BASE_PARAM = "citybase";

/** 构建期覆盖：`VITE_WS_CITY_PACK_BASE`（fork/自建打包写进 `.env`；没配就是 undefined） */
const ENV_BASE = import.meta.env?.VITE_WS_CITY_PACK_BASE as string | undefined;

/** 下载源是"谁给的"（`fallback` = 覆盖值坏掉、已回落默认，**原因在 `why`**） */
export interface CityPackBaseInfo {
  /** 最终生效的下载源（已去掉末尾 `/`；客户端拼 `{base}/citypacks/<rel>`，base = 服务器根） */
  base: string;
  from: "param" | "env" | "default" | "fallback" | "option";
  /** 被拒绝的原值（只在 `from === "fallback"` 时有）—— 可定位是谁配错的 */
  requested?: string;
  /** 为什么回落（只在 `from === "fallback"` 时有） */
  why?: string;
}

/** 校验并归一化一条候选下载源（**只接受 http(s) 绝对地址**；`{base}/citypacks/` 那个口径由调用方拼） */
function normalizeBase(raw: string): { ok: true; base: string } | { ok: false; why: string } {
  const v = raw.trim();
  if (!v) return { ok: false, why: "是空值" };
  if (/\s/.test(v)) return { ok: false, why: "含空白字符" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, why: "不是合法 URL（要写成 http(s)://主机[:端口][/路径]）" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, why: "协议是 " + u.protocol + "（只接受 http/https）" };
  }
  return { ok: true, base: v.replace(/\/+$/, "") };
}

/** 读当前地址栏的查询串（Node/无 location 环境返回 `""`；取 location 抛异常也不许把模块加载搞挂） */
function locationSearch(): string {
  try {
    return typeof location !== "undefined" && location ? String(location.search || "") : "";
  } catch {
    return "";
  }
}

function judged(raw: string, from: "param" | "env"): CityPackBaseInfo {
  const n = normalizeBase(raw);
  if (n.ok) return { base: n.base, from };
  const who = from === "param" ? "?citybase=" : "VITE_WS_CITY_PACK_BASE";
  return {
    base: WS_CITY_PACK_BASE_DEFAULT,
    from: "fallback",
    requested: raw,
    why: "覆盖源 " + who + " " + n.why + " ⇒ 回落到默认占位（没配过真源时取不到清单会如实报「数不出来」）",
  };
}

/**
 * 解析下载源（**纯函数**：`search` / `env` 都能注入 ⇒ 自检可以逐条验，不必依赖真 `location` 与真构建期变量）。
 * 省略 `search` = 读 `location.search`；省略 `env` = 读构建期常量 `VITE_WS_CITY_PACK_BASE`。
 */
export function resolveCityPackBase(input: { search?: string; env?: string } = {}): CityPackBaseInfo {
  const search = input.search !== undefined ? input.search : locationSearch();
  const env = input.env !== undefined ? input.env : ENV_BASE;
  let asked: string | undefined;
  try {
    const params = new URLSearchParams(search || "");
    if (params.has(WS_CITY_PACK_BASE_PARAM)) asked = params.get(WS_CITY_PACK_BASE_PARAM) || "";
  } catch {
    asked = undefined; // 参数串坏到连 URLSearchParams 都读不动 ⇒ 当作"没给"（不改默认行为）
  }
  if (asked !== undefined) return judged(asked, "param");
  if (typeof env === "string" && env.trim()) return judged(env, "env");
  return { base: WS_CITY_PACK_BASE_DEFAULT, from: "default" };
}

/** 当前生效的下载源**与它的来路**（坏值回落时这里带着 `why`/`requested`，界面/自检据此如实说明） */
export const WS_CITY_PACK_BASE_INFO: CityPackBaseInfo = resolveCityPackBase();

/** 🔴 下载源（解析结果）。换默认值改 `WS_CITY_PACK_BASE_DEFAULT`；临时换源走 `?citybase=` / 构建期常量。 */
export const WS_CITY_PACK_BASE = WS_CITY_PACK_BASE_INFO.base;

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
  /** 当前下载源（只读：默认占位 / `?citybase=` / 构建期常量 / 坏值回落，见 `baseInfo.from`） */
  readonly base: string;
  /** 这个 base 是**怎么来的**（坏值回落时 `why`/`requested` 有值 ⇒ 界面可以如实说明，别当无事发生） */
  readonly baseInfo: CityPackBaseInfo;
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
  /* `opts.base` 是**编程接口**（自检/将来的 Tauri 后端注入）：照旧只去末尾斜杠；
     而"用户能配的两条路"（`?citybase=` / 构建期常量）走 `resolveCityPackBase()` ⇒ 那里才做严格校验与回落。 */
  const baseInfo: CityPackBaseInfo = opts.base
    ? { base: opts.base.replace(/\/+$/, ""), from: "option" }
    : WS_CITY_PACK_BASE_INFO;
  const base = baseInfo.base;
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
    baseInfo,
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
