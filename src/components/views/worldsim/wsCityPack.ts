/**
 * wsCityPack.ts —— 「城市数据包」的**协议解析唯一真源**（2026-09-26，App 入口替换 / 初始引导）
 *
 * ## 它负责什么
 * 机主拍板的数据路线：**城市数据从云端按城市下载**（「真正在安装包里的东西，选择从云端下载哪些城市数据，
 * 不过我们自己就用重庆的就行」+「下载源先用本机预览服务（5212）」）。
 * 云端与本机之间只靠两样东西说话（**契约由导出器那边定，这里只按契约读**）：
 *
 *   ① 清单：`GET {BASE}/citypacks/cities.json`
 *      → `{ version, generatedAt, cities: [{ id, name, bbox, cells, features, bytes, sha256, url, attribution }] }`
 *   ② 包：  `GET {BASE}/citypacks/<id>.zip`
 *      → 内含 `index.json` + 各格 `<格>.json`（`cellSize = 0.05`，与前端格口径同一套）
 *
 * 本文件是**纯函数 + 纯解析**：不碰 Vue、不碰 DOM、不发请求（取数在 `wsCityStore.ts`）。
 * 这样自检可以拿一个**自造的 zip** 把它整条路走一遍（`ws_city_store_selftest.mjs`）。
 *
 * ## 判词纪律（机主定的三态，绝不含糊）
 * 清单/包的任何一步只有三种结果：**正数 / 0（已量）/ 数不出来（写原因）**。
 * 「没取到」永远不许写成 0 —— 所以下面每个"读"函数返回的都是**带原因的联合类型**，
 * 而不是 `null` / `[]`（那两个东西在调用方看起来一模一样，是本项目反复栽的坑）。
 *
 * ## 不引新依赖
 * 解压走浏览器/Node 都自带的 `DecompressionStream("deflate-raw")`（Chrome 103+ / Node 18+），
 * 不引 jszip / fflate（PR 里多一个依赖要解释，而且我们只用得上 zip 的"读"这一半）。
 * 解压不可用时**如实报错**（`数不出来：这个运行时不支持 …`），不静默返回空。
 */

/* ══════════════════════════════════════════════════════════════════════════════
 * 一、清单（cities.json）
 * ════════════════════════════════════════════════════════════════════════════ */

/** 一个城市包在清单里的样子（字段按契约；**全部可选字段缺失时如实显示"未声明"**，不猜） */
export interface CityPackInfo {
  id: string;
  name: string;
  /** [west, south, east, north] —— 这一包**覆盖到的数据范围**（不是行政区划边界） */
  bbox?: [number, number, number, number];
  /** 格数（导出器给的数；缺 = 未声明，不许当成 0） */
  cells?: number;
  /** 要素数（同上） */
  features?: number;
  /** 包大小（字节；同上） */
  bytes?: number;
  /** 整包 sha256（十六进制；缺失 = 这一包不校验，如实写出来） */
  sha256?: string;
  /** 包地址（相对 cities.json 或绝对 URL；缺失 = 按契约默认 `<id>.zip`） */
  url?: string;
  /** 署名原句（ODbL 要求可见；缺失 = 这一包没给，如实写） */
  attribution?: string;
}

/** 清单读取的三态结果 */
export type CityListState =
  | { state: "ok"; cities: CityPackInfo[]; dropped: string[] }
  | { state: "empty" }
  | { state: "unknown"; why: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * 署名那一格：契约写的是字符串，但**真清单**（`export_city_pack.py` 产出）给的是**数组**
 * （每层一句，ODbL 要求原样带出）⇒ 两种都收，数组用 ` · ` 连起来。
 * ⚠️ 不做别的加工：具体句子是导出器的原话，这里只负责"别丢"。
 */
function attrOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bboxOf(v: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const b = v.map((x) => Number(x));
  if (b.some((x) => !Number.isFinite(x))) return undefined;
  return [b[0], b[1], b[2], b[3]];
}

/**
 * 把 `cities.json` 的 JSON 解析成三态。
 *
 * ⚠️ 为什么坏条目**丢掉但要报数**：清单是别人的导出器产的，一条缺 `id` 的记录不该让整个引导变砖，
 * 但也不能静默消失 —— `dropped` 里带着原因上屏（"清单里 2 条记录缺 id/name ⇒ 已忽略"）。
 */
export function parseCityList(json: unknown): CityListState {
  if (json === null || typeof json !== "object") {
    return { state: "unknown", why: "清单不是 JSON 对象（顶层是 " + typeOf(json) + "）" };
  }
  const raw = (json as { cities?: unknown }).cities;
  if (!Array.isArray(raw)) {
    const keys = Object.keys(json as Record<string, unknown>).slice(0, 8).join(", ");
    return { state: "unknown", why: "清单里没有 cities 数组（顶层键：" + (keys || "无") + "）" };
  }
  const cities: CityPackInfo[] = [];
  const dropped: string[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") {
      dropped.push("一条不是对象");
      continue;
    }
    const o = it as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) {
      dropped.push("缺 id 或 name（" + JSON.stringify(id || name || "空") + "）");
      continue;
    }
    cities.push({
      id,
      name,
      bbox: bboxOf(o.bbox),
      cells: num(o.cells),
      features: num(o.features),
      bytes: num(o.bytes),
      sha256: str(o.sha256) || undefined,
      url: str(o.url) || undefined,
      attribution: attrOf(o.attribution),
    });
  }
  if (!cities.length && !dropped.length) return { state: "empty" }; // 清单在，里面**确实** 0 个城市（已量）
  if (!cities.length) return { state: "unknown", why: "清单里的 " + dropped.length + " 条记录全部不可用：" + dropped.join("；") };
  return { state: "ok", cities, dropped };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * 默认选中哪个城市 —— 机主定的：「**我们自己就用重庆的就行**」。
 * 匹配口径：id / name 里含 `prefer`（默认"重庆"）或它的拼音 `chongqing`；匹配不到就返回 null
 * （**不擅自**把清单第一个当默认 —— 那是替用户做决定，"首屏显示的城市"正是机主要改的东西）。
 */
export function pickDefaultCity(cities: readonly CityPackInfo[], prefer = "重庆"): CityPackInfo | null {
  const want = prefer.trim().toLowerCase();
  const pin = "chongqing";
  for (const c of cities) {
    const s = (c.id + " " + c.name).toLowerCase();
    if (s.includes(want) || s.includes(pin)) return c;
  }
  return null;
}

/** 人类可读的字节数；`null/undefined` = 未声明（**不许显示成 0 B**） */
export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "大小未声明";
  if (n < 1024) return n + " B";
  const kb = n / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  return (kb / 1024).toFixed(kb / 1024 < 10 ? 1 : 0) + " MB";
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 二、zip 解包（只用标准库：DecompressionStream）
 * ════════════════════════════════════════════════════════════════════════════ */

/** zip 中央目录里一条记录（只取我们真正要用的字段） */
export interface ZipEntry {
  name: string;
  /** 0 = 不压缩（stored）/ 8 = deflate */
  method: number;
  compSize: number;
  size: number;
  /** 本地头偏移（数据起点 = 本地头 + 30 + nameLen + extraLen） */
  offset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * 读中央目录（**只信中央目录**：本地头的 size 字段在"流式写"的包里常常是 0，
 * 而中央目录永远有真值 —— 这是 zip 规范里最值得信的一处）。
 *
 * 失败一律抛错，错误文本本身就是"数不出来"的原因（调用方原样上屏）。
 */
export function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const n = bytes.length;
  if (n < 22) throw new Error("不是 zip（只有 " + n + " 字节，连尾部记录都不够）");
  /* EOCD 在文件末尾，最长 22 + 65535 字节注释 ⇒ 从尾部往前找签名 */
  const from = Math.max(0, n - 22 - 65535);
  let eocd = -1;
  for (let i = n - 22; i >= from; i--) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip（找不到中央目录尾部记录 EOCD）");
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOff = u32(bytes, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new Error("这个包用了 zip64（条目数/偏移超出经典 zip），本实现暂不支持");
  }
  if (cdOff + cdSize > n) throw new Error("zip 中央目录越界（声明 " + cdSize + " 字节 @ " + cdOff + "，文件只有 " + n + "）");
  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > n || u32(bytes, p) !== SIG_CEN) throw new Error("中央目录第 " + (i + 1) + " 条起就坏了（签名不对）");
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 「这个运行时有解压能力吗」—— 没有就如实说，不假装成功 */
export function inflateAvailable(): boolean {
  return typeof DecompressionStream === "function";
}

/** 读一条 zip 记录的**原始字节**（stored 直接切；deflate 走 DecompressionStream） */
export async function readZipEntryBytes(bytes: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const ln = u16(bytes, e.offset + 26);
  const le = u16(bytes, e.offset + 28);
  if (u32(bytes, e.offset) !== SIG_LOC) throw new Error("本地头签名不对：" + e.name);
  const start = e.offset + 30 + ln + le;
  const raw = bytes.subarray(start, start + e.compSize);
  if (e.method === 0) return raw.slice();
  if (e.method !== 8) throw new Error("不认识的压缩方式 " + e.method + "（只支持 0=stored / 8=deflate）：" + e.name);
  if (!inflateAvailable()) throw new Error("这个运行时不支持解压（没有 DecompressionStream）⇒ 数不出来");
  const ds = new DecompressionStream("deflate-raw");
  /* ⚠️ 用 `Blob` 而不是 `new Response(raw).body`：raw 是**视图**（subarray），
     直接喂给 Response 在部分实现里会把整个底层 buffer 当请求体（会把整包再复制一遍）。 */
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 整包 sha256（十六进制小写）；用于和清单里的 `sha256` 对账 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("这个运行时不支持 sha256（没有 crypto.subtle）⇒ 无法校验");
  const d = await c.subtle.digest("SHA-256", bytes as unknown as ArrayBufferView);
  return Array.from(new Uint8Array(d))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 三、包内容（index.json + 各格）
 * ════════════════════════════════════════════════════════════════════════════ */

/** 从包里读出来的东西 —— 读不到的每一处都带**原因**，不返回空数组充数 */
export interface PackContents {
  /** 根 `index.json` 解析结果（读不到 = null） */
  index: unknown | null;
  indexWhy: string | null;
  /** 包里所有条目名 */
  files: string[];
  /**
   * 各层的格文件（`…/<格>.json`，**不含任何 `index.json`**）。
   *
   * 🔴 真包的形状（2026-09-26 拿 `chongqing.zip` 实测）：**按层分目录**
   * `bldbundle/` · `roadsbundle/` · `placesbundle/` · `gwbundle/`，每层自己一个 `index.json`，
   * 根 `index.json` 再声明一份**去重后的格键表**（这就是清单里的 `cells`）。
   * ⇒ 于是"几格"有两个数：**文件数**（501，按层算）与**格键数**（372，去重）。
   * 两个都留着、谁也不冒充谁：`cellCount` 取去重那个（与清单同口径）。
   */
  cells: string[];
  /** 各层的 `index.json`（真包里有 4 个） */
  layerIndexes: string[];
  /** 包内出现的层目录名（如 `bldbundle`）—— 下一片取数管道要按它找格 */
  layers: string[];
  /** 根 `index.json` 自己声明的格键表（有则与上面的文件数对账） */
  declared: string[] | null;
  /**
   * **"几格"的唯一定义**：有声明就用声明（去重键数，与清单 `cells` 同口径），
   * 没有就用格文件数。判词纪律：这两个数**都不是 0 就是 0**、
   * "读不出来"由 `cellsWhy` 说出来 —— 别用 0 表示"不知道"。
   */
  cellCount: number;
  /** 包声明的中心点（`index.json` 的可选字段 `center`/`focus`；没有 = null，**不猜**） */
  center: [number, number] | null;
  /** `index.json` 里声明的 cellSize（对不上前端口径就该报出来） */
  cellSize: number | null;
  /** 压缩方式**本实现不支持**的条目（`名字（方式 N）`）——
      在"解包"这一步就要拦住：否则会读到一半才炸，失败阶段会指到"写入"，让人找错地方 */
  unsupported: string[];
  /** 认不出来的话，这里是原因（"index.json 里没有我认识的格清单字段：keys=…"） */
  cellsWhy: string | null;
}

const INDEX_NAME = "index.json";

/** 条目名是不是某个 `index.json`（根或层内的都算） */
function isIndexName(name: string): boolean {
  return name === INDEX_NAME || name.endsWith("/" + INDEX_NAME);
}

function cellKeysFromIndex(index: unknown): string[] | null {
  if (!index || typeof index !== "object") return null;
  const o = index as Record<string, unknown>;
  for (const k of ["cells", "cellKeys", "keys", "grid"]) {
    const v = o[k];
    if (Array.isArray(v)) {
      const list = v
        .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? str((x as Record<string, unknown>).key) || str((x as Record<string, unknown>).cell) : null))
        .filter((x): x is string => !!x);
      if (list.length) return list;
    }
  }
  return null;
}

function centerFromIndex(index: unknown): [number, number] | null {
  if (!index || typeof index !== "object") return null;
  const o = index as Record<string, unknown>;
  for (const k of ["center", "focus"]) {
    const v = o[k];
    if (Array.isArray(v) && v.length === 2) {
      const c = v.map((x) => Number(x));
      if (c.every((x) => Number.isFinite(x))) return [c[0], c[1]];
    }
    if (v && typeof v === "object") {
      const lng = Number((v as Record<string, unknown>).lng ?? (v as Record<string, unknown>).lon);
      const lat = Number((v as Record<string, unknown>).lat);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
    }
  }
  return null;
}

/**
 * 把整包字节读成"内容"。
 *
 * 🔴 为什么把 `declared` / `cells` / `cellCount` / `cellsWhy` 都带出来：
 * "包里到底有几格"有**两种来源**（格文件数、根 `index.json` 的声明），真包实测**它们不相等**
 * （505 个格文件 vs 372 个去重格键）—— 只报一个数就等于把口径藏起来。
 * 所以：`cellCount` 是**唯一定义**（优先用声明，与清单 `cells` 同口径），另两个原始数照旧带出来。
 */
export async function readPackContents(bytes: Uint8Array): Promise<PackContents> {
  const entries = parseZipEntries(bytes);
  const files = entries.map((e) => e.name);
  const cells = files.filter((f) => f.endsWith(".json") && !isIndexName(f) && !f.startsWith("__"));
  const layerIndexes = files.filter((f) => isIndexName(f));
  const layers = Array.from(
    new Set(
      cells
        .map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""))
        .filter((d) => !!d)
    )
  ).sort();
  const idxEntry = entries.find((e) => e.name === INDEX_NAME);
  let index: unknown | null = null;
  let indexWhy: string | null = null;
  if (!idxEntry) {
    indexWhy = "包里没有 " + INDEX_NAME;
  } else {
    try {
      index = JSON.parse(new TextDecoder("utf-8").decode(await readZipEntryBytes(bytes, idxEntry)));
    } catch (e) {
      indexWhy = INDEX_NAME + " 读不出来：" + errText(e);
    }
  }
  const declared = cellKeysFromIndex(index);
  let cellsWhy: string | null = null;
  if (!cells.length && !declared) {
    cellsWhy = index
      ? "包里既没有 <格>.json 文件，" + INDEX_NAME + " 里也没有我认识的格清单字段（顶层键：" + Object.keys(index as Record<string, unknown>).slice(0, 8).join(", ") + "）"
      : "包里没有格文件（" + (indexWhy || "且没有 " + INDEX_NAME) + "）";
  }
  const cs = index && typeof index === "object" ? num((index as Record<string, unknown>).cellSize) : undefined;
  const unsupported = entries
    .filter((e) => e.method !== 0 && e.method !== 8)
    .map((e) => e.name + "（方式 " + e.method + "）");
  return {
    index,
    indexWhy,
    files,
    cells,
    layerIndexes,
    layers,
    declared,
    cellCount: declared && declared.length ? declared.length : cells.length,
    center: centerFromIndex(index),
    cellSize: cs ?? null,
    unsupported,
    cellsWhy,
  };
}

/** 错误文本（`unknown` 统一转成人话） */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
