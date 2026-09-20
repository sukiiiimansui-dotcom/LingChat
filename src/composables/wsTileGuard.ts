/**
 * wsTileGuard.ts —— 底图瓦片**预检**：别用 HTTP 200 判断瓦片正常。
 *
 * ## 为什么必须有这个（2026-09-19 真实事故）
 * 我们给自用页接了 `basemaps.cartocdn.com`（无 key）。它**不报错**：
 * HTTP **200** + 一张"带水印的正常图片"（整幅斜字 `API KEY REQUIRED` / `carto.com/basemaps/apikey`）。
 * 机主看到的现象是「除中国外全世界都有那行字」——因为我们自绘的省/市/区多边形不透明，
 * 正好把中国区的水印盖住了。**200 + 水印比 403 更坏**，因为所有常规检查都会通过。
 *
 * 同类行为（子代理实测/官方文档）：
 * · MapTiler 无 key → **403 + 一张写着 "Invalid key" 的 PNG**；
 * · Stadia 无 key（非 localhost）→ 401 或 "warning tile"；
 * · Thunderforest 无 key → 纯文本 `API key required`（连图片都不是）。
 *
 * ## 分工
 * · **纯函数**（`judgeTile` / `tileUrlAt` / `basemapRiskOf`）：可脱网单测，全部规则都在这里；
 * · **唯一碰网络**的 `probeBasemapTile()`：取一张已知瓦片 → 交给 `judgeTile` 判定。
 *
 * ## 界限（如实说）
 * 本模块能识别这四种：不是图片、是文本错误、空白小图、HTTP 错；
 * 它**不能**识别"是一张正常图片但内容被加了水印"（那需要图像比对或 OCR）。
 * 对付水印靠的是 `basemapRiskOf()` 的**静态清单**（已知哪些服务商无 key 会发水印图）+ 换源。
 */

export type TileVerdictKind = "ok" | "http" | "empty" | "not-image" | "tiny" | "timeout" | "network";

export interface TileVerdict {
  /** true = 可以挂上底图 */
  ok: boolean;
  kind: TileVerdictKind;
  bytes: number;
  /**
   * 判定是不是**确定性的**失败（HTTP 错 / 不是图片 / 空响应 / 空白小图）。
   *
   * 🔴 为什么单独标出来（2026-09-19 实测踩到）：**超时不是结论**。
   * 无头浏览器里同一张 Esri 瓦片用了 **3.71s**，而我把探针超时设成 3.5s ⇒ 被判"失败"
   * ⇒ 护栏把**本来可用**的底图关掉了。**过严的护栏比没有护栏更坏**。
   * 所以：只有 `definitive` 才允许禁用底图；超时/网络错一律**保持启用**（真挂了地图自己会报）。
   */
  definitive: boolean;
  /** 给人看的一句话（会进 `info.journal`，出问题时能一眼看出为什么没底图） */
  reason: string;
}

/** PNG / JPEG / WEBP / GIF 的魔数（`head` 至少要 12 字节，少于此按 not-image 处理） */
const MAGIC: Array<{ name: string; bytes: number[] }> = [
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { name: "gif", bytes: [0x47, 0x49, 0x46] },
  { name: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF****WEBP
];

/** 小于这个字节数基本不可能是有效瓦片（实测：真瓦片 9KB~45KB，错误文本 < 200B） */
export const MIN_TILE_BYTES = 512;

export function imageKindOf(head: ArrayLike<number> | undefined | null): string | null {
  if (!head || head.length < 4) return null;
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => Number(head[i]) === b)) {
      if (m.name === "webp" && head.length >= 12) {
        const w = String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!);
        if (w !== "WEBP") return null;
      }
      return m.name;
    }
  }
  return null;
}

/**
 * 判定一张瓦片的响应。**顺序有讲究**：先 HTTP，再"是不是图片"，最后才是尺寸
 * —— 因为"403 + 一张 PNG"必须先被 HTTP 拦下，而"纯文本 API key required"要被图片魔数拦下。
 */
export function judgeTile(opts: {
  status?: number;
  bytes: number;
  head?: ArrayLike<number> | null;
  contentType?: string | null;
}): TileVerdict {
  const bytes = Number(opts.bytes) || 0;
  const status = opts.status;
  if (status !== undefined && status !== 200) {
    return { ok: false, kind: "http", bytes, definitive: true, reason: `HTTP ${status}（服务端拒绝）` };
  }
  if (bytes < 120) {
    return { ok: false, kind: "empty", bytes, definitive: true, reason: `响应只有 ${bytes}B（空响应）` };
  }
  const kind = imageKindOf(opts.head);
  if (!kind) {
    /* 文本错误最常见：Thunderforest 的 `API key required`、JSON 错误体、HTML 错误页 */
    const ct = String(opts.contentType || "");
    return {
      ok: false,
      kind: "not-image",
      bytes,
      definitive: true,
      reason: ct && !/image/i.test(ct) ? `响应不是图片（Content-Type=${ct.slice(0, 40)}）` : "响应不是图片（很可能是错误文本）",
    };
  }
  if (bytes < MIN_TILE_BYTES) {
    return { ok: false, kind: "tiny", bytes, definitive: true, reason: `${kind} 但只有 ${bytes}B（空白/占位图）` };
  }
  return { ok: true, kind: "ok", bytes, definitive: true, reason: `${kind} ${bytes}B` };
}

/** 把 `{z}/{x}/{y}` 模板换成具体瓦片（Esri 的 `{z}/{y}/{x}` 只是顺序不同，纯字符串替换即可） */
export function tileUrlAt(template: string, z: number, x: number, y: number): string {
  return String(template || "")
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/**
 * 静态风险清单：**已知某些服务商"无 key 也回 200，但发的是水印图/占位图"**。
 * 这类故障运行时探针很难自动识别，所以在这里**提前点名**（换源时不再踩第二次）。
 */
export function basemapRiskOf(url: string): { risky: boolean; note: string } {
  const u = String(url || "");
  const hasKey = /[?&](key|api_?key|token)=/i.test(u);
  if (/cartocdn\.com/i.test(u) && !hasKey) {
    return {
      risky: true,
      note: "Carto 无 key：返回 **200 + 整幅水印图**（API KEY REQUIRED）——2026-09-19 实测踩过",
    };
  }
  if (/maptiler\.com/i.test(u) && !hasKey) {
    return { risky: true, note: "MapTiler 无 key：403 + 一张写着 Invalid key 的 PNG" };
  }
  if (/stadiamaps\.com/i.test(u) && !hasKey) {
    return { risky: true, note: "Stadia 非 localhost 且无 key：401 或 warning tile" };
  }
  if (/thunderforest\.com/i.test(u) && !hasKey) {
    return { risky: true, note: "Thunderforest 无 key：纯文本 `API key required`（连图都不是）" };
  }
  if (/tile\.openstreetmap\.org/i.test(u)) {
    return { risky: true, note: "OSM 官方瓦片：政策**明文禁止离线/批量**使用，Android 离线场景不要用" };
  }
  return { risky: false, note: "" };
}

/** 预检取哪一张：z=4/x=8/y=6 ≈ 地中海一带（一定有内容的陆海交界，避免拿纯海洋瓦片误判） */
export const PROBE_TILE = { z: 4, x: 8, y: 6 };

/**
 * 真探针（唯一碰网络的函数）。任何异常都收敛成 `TileVerdict`，**绝不抛**。
 * 超时给 6s（见 `definitive` 的说明）：底图晚一点没关系，**误判把好底图关掉**才是问题。
 */
export async function probeBasemapTile(
  template: string,
  opts: { z?: number; x?: number; y?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<TileVerdict> {
  const z = opts.z ?? PROBE_TILE.z;
  const x = opts.x ?? PROBE_TILE.x;
  const y = opts.y ?? PROBE_TILE.y;
  const url = tileUrlAt(template, z, x, y);
  const doFetch = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, kind: "network", bytes: 0, definitive: false, reason: "没有 fetch 可用" };
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  /* 超时给 6s：无头/弱网实测单张 Esri 瓦片可到 3.7s，太紧会误判（护栏必须宽于现实） */
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000) : null;
  try {
    const res = await doFetch(url, { signal: ctrl ? ctrl.signal : undefined });
    const buf = new Uint8Array(await res.arrayBuffer());
    return judgeTile({
      status: res.status,
      bytes: buf.length,
      head: buf.subarray(0, 12),
      contentType: res.headers?.get?.("content-type") ?? null,
    });
  } catch (e) {
    const msg = String((e as { name?: string })?.name === "AbortError" ? "超时" : (e as Error)?.message || e);
    return {
      ok: false,
      kind: /超时|abort/i.test(msg) ? "timeout" : "network",
      bytes: 0,
      definitive: false,
      reason: msg.slice(0, 80),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
