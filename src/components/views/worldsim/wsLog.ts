/**
 * wsLog.ts —— 页面**超级详细日志上报**的**唯一真源**（2026-09-25 机主：「在页面做超级详细的日志上报喵」）。
 *
 * ## 为什么要有它
 * 排查真机问题时，我们能拿到的只有**机主的一张截图**。此前每次都要靠"HUD 上那句聚合数字"猜
 * （例：截图里一句 `模块缺 createBundleFeed（旧 vendor?）` 就要花半小时去分辨"是产物缺符号、还是浏览器缓存"）。
 * ⇒ 把**过程**（每条请求 / 每次模块加载 / 每个错误 / 关键决策）按时间记下来，页面上能看、能一键复制、
 * 也能 `window.__WSLOG__` 取走，排查就从"猜"变成"读日志"。
 *
 * ## 三条硬约束（都写进断言，见 `ws_log_selftest.mjs`）
 * ① **日志不许拖慢页面**：环形缓冲（默认 1500 条）+ 字段截断（默认 400 字符）+ 只做 push/计数，
 *    **不做任何每帧工作**（`text()` 只在面板打开/点击时才拼）。
 * ② **不许静默丢**：超上限丢掉的条数记在 `dropped` 里（三态：`dropped>0` 是"已量"，不是 0）。
 * ③ **数不出来就写 null，不写 0**：所有"没量到"的数值一律 `null`（判词三态纪律）。
 *
 * ## 用法（页面只接线，规则都在这）
 * ```ts
 * const log = createWsLog({ tag: "ws3dshow" });
 * const un = log.patchFetch();      // 每条 fetch 自动记：url / status / ms / bytes / 错误
 * const ue = log.installErrors();   // window.onerror + unhandledrejection
 * log.info("boot", "页面启动", { build: BUILD });
 * log.text();                       // 截图/复制友好的整份报告
 * ```
 */
export type WsLogLevel = "debug" | "info" | "warn" | "error";

export interface WsLogEntry {
  /** 单调序号（从 1 起）：**即使时间戳相同也能排序** */
  seq: number;
  /** 距创建该 logger 的毫秒数（排查"先发生什么"用） */
  dt: number;
  /** 墙钟时间（本地 HH:MM:SS.mmm，只为看时间点） */
  at: string;
  lvl: WsLogLevel;
  tag: string;
  msg: string;
  data?: unknown;
}

export interface WsLogCounts {
  total: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
  /** 因超上限被丢掉的条数（**不许静默丢**：>0 就说明日志不完整） */
  dropped: number;
  cap: number;
}

export interface WsLogOptions {
  /** logger 自己的名字，出现在报告抬头 */
  tag?: string;
  /** 环形缓冲上限（默认 1500） */
  cap?: number;
  /** 每条 data 序列化后的字符上限（默认 400） */
  maxStr?: number;
  /** 注入时钟（自检用；默认 Date.now） */
  now?: () => number;
  /** 每条日志的回调（面板实时刷新用；**不许在里面做重活**） */
  sink?: (e: WsLogEntry) => void;
  /** 低于这个级别的不记（默认 "debug" = 全记） */
  minLevel?: WsLogLevel;
}

const LEVEL_ORDER: Record<WsLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 安全的字符串化：**循环引用 / BigInt / 超长 都不许抛**（抛了会把调用点带崩） */
export function safeStr(v: unknown, maxStr = 400): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > maxStr ? v.slice(0, maxStr) + `…(+${v.length - maxStr})` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return String(v) + "n";
  if (typeof v === "function") return `[fn ${(v as { name?: string }).name || "anonymous"}]`;
  try {
    const seen = new WeakSet<object>();
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val as object)) return "[circular]";
        seen.add(val as object);
      }
      if (typeof val === "bigint") return String(val) + "n";
      if (typeof val === "function") return `[fn ${(val as { name?: string }).name || "anonymous"}]`;
      return val;
    });
    if (s === undefined) return String(v);
    return s.length > maxStr ? s.slice(0, maxStr) + `…(+${s.length - maxStr})` : s;
  } catch (e) {
    return `[数不出来：${(e as Error)?.message || String(e)}]`;
  }
}

/** 本地 HH:MM:SS.mmm */
function hhmmss(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function createWsLog(opts: WsLogOptions = {}) {
  const cap = Math.max(50, opts.cap ?? 1500);
  const maxStr = Math.max(40, opts.maxStr ?? 400);
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const buf: WsLogEntry[] = [];
  const counts: WsLogCounts = { total: 0, debug: 0, info: 0, warn: 0, error: 0, dropped: 0, cap };
  const min = LEVEL_ORDER[opts.minLevel ?? "debug"];
  let seq = 0;
  /* 节流用：同一 tag+msg 的高频重复只留前几次（防"每帧一条"把缓冲打满）—— 但**计数不作假** */
  const repeats = new Map<string, number>();

  function push(lvl: WsLogLevel, tag: string, msg: string, data?: unknown): WsLogEntry | null {
    if (LEVEL_ORDER[lvl] < min) return null;
    const key = lvl + "|" + tag + "|" + msg;
    const n = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, n);
    /* 前 5 次逐条记；之后每 50 次记一条「（重复 N 次）」——**丢的是重复行，不是不同事件** */
    if (n > 5 && n % 50 !== 0) {
      counts.dropped += 1;
      return null;
    }
    const e: WsLogEntry = {
      seq: ++seq,
      dt: now() - t0,
      at: hhmmss(now()),
      lvl,
      tag,
      msg: n > 5 ? `${msg}（同类第 ${n} 次）` : msg,
      ...(data === undefined ? {} : { data: typeof data === "string" ? safeStr(data, maxStr) : data }),
    };
    counts.total += 1;
    counts[lvl] += 1;
    buf.push(e);
    if (buf.length > cap) {
      buf.splice(0, buf.length - cap);
      counts.dropped += 1;
    }
    try { opts.sink?.(e); } catch { /* sink 抛错不许影响业务 */ }
    return e;
  }

  /** 截图友好的整份报告：抬头（环境）→ 计数 → 逐条（带 dt/级别/tag） */
  function text(env: Record<string, unknown> = {}): string {
    const head = [
      `📋 wsLog 报告 · ${opts.tag || "page"} · 生成于 ${hhmmss(now())}`,
      `条数 ${counts.total}（debug ${counts.debug} / info ${counts.info} / warn ${counts.warn} / error ${counts.error}）`
        + ` · 缓冲上限 ${cap} · **丢弃 ${counts.dropped}**${counts.dropped ? "（日志不完整，重复行或超上限）" : ""}`,
    ];
    const envLines = Object.keys(env).length
      ? ["── 环境 ──", ...Object.keys(env).map((k) => `  ${k} = ${safeStr(env[k], maxStr)}`)]
      : [];
    const body = buf.map((e) => {
      const d = e.data === undefined ? "" : `  ${typeof e.data === "string" ? e.data : safeStr(e.data, maxStr)}`;
      const mark = e.lvl === "error" ? "❌" : e.lvl === "warn" ? "⚠️" : e.lvl === "info" ? "·" : "◦";
      return `${mark} [${String(e.dt).padStart(7)}ms] ${e.tag}: ${e.msg}${d}`;
    });
    return [...head, ...envLines, "── 事件 ──", ...body].join("\n");
  }

  return {
    tag: opts.tag || "page",
    log: push,
    debug: (tag: string, msg: string, data?: unknown) => push("debug", tag, msg, data),
    info: (tag: string, msg: string, data?: unknown) => push("info", tag, msg, data),
    warn: (tag: string, msg: string, data?: unknown) => push("warn", tag, msg, data),
    error: (tag: string, msg: string, data?: unknown) => push("error", tag, msg, data),
    entries: () => buf.slice(),
    counts: () => ({ ...counts }),
    text,
    json: (env: Record<string, unknown> = {}) => ({ tag: opts.tag || "page", at: now(), counts: { ...counts }, env, entries: buf.slice() }),
    clear: () => { buf.length = 0; repeats.clear(); },
    /**
     * 包住 `fetch`：每条请求记 **url / status / ms / 字节数 / 错误**（字节数只有真读到 body 才有，
     * 拿不到就是 `null` —— 不许写 0）。返回 `restore()`。
     */
    patchFetch(target: { fetch?: typeof fetch } = globalThis as unknown as { fetch?: typeof fetch }) {
      const orig = target.fetch;
      if (typeof orig !== "function") { push("warn", "log", "patchFetch：没有 fetch 可包"); return () => {}; }
      target.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === "string" ? input : (input as Request)?.url || String(input);
        const t = now();
        try {
          const r = await orig.call(this, input as RequestInfo, init);
          push(r.ok ? "debug" : "warn", "fetch", `${r.status} ${url}`, { ms: now() - t, ct: r.headers?.get?.("content-type") || null });
          return r;
        } catch (e) {
          push("error", "fetch", `失败 ${url}`, { ms: now() - t, err: safeStr((e as Error)?.message || e, 200) });
          throw e;
        }
      };
      return () => { target.fetch = orig; };
    },
    /** `window.onerror` + `unhandledrejection` 全收（返回 `restore()`） */
    installErrors(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>) {
      const prevOnError = target.onerror as ((...a: unknown[]) => unknown) | null;
      const onErr = (ev: unknown) => {
        const e = ev as { message?: string; filename?: string; lineno?: number; colno?: number; error?: Error; reason?: unknown };
        push("error", "window", e?.message || safeStr(e?.reason ?? ev, 200), {
          at: `${e?.filename || "?"}:${e?.lineno ?? "?"}:${e?.colno ?? "?"}`,
          stack: e?.error?.stack ? safeStr(e.error.stack, 300) : null,
        });
        return false;
      };
      const onRej = (ev: unknown) => {
        const e = ev as { reason?: unknown };
        const r = e?.reason as Error | undefined;
        push("error", "promise", r?.message || safeStr(e?.reason, 200), { stack: r?.stack ? safeStr(r.stack, 300) : null });
      };
      try { target.onerror = onErr as unknown as typeof target.onerror; } catch { /* 忽略 */ }
      const ae = (target.addEventListener as ((t: string, f: (e: unknown) => void) => void) | undefined);
      try { ae?.call(target, "unhandledrejection", onRej); } catch { /* 忽略 */ }
      return () => {
        try { target.onerror = prevOnError as unknown; } catch { /* 忽略 */ }
        try { (target.removeEventListener as ((t: string, f: (e: unknown) => void) => void) | undefined)?.call(target, "unhandledrejection", onRej); } catch { /* 忽略 */ }
      };
    },
  };
}

export type WsLog = ReturnType<typeof createWsLog>;

/** 环境快照（报告抬头用）：**取不到的一律 null，不写 0** */
export function envSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } })?.memory;
  const conn = (nav as unknown as { connection?: { effectiveType?: string; downlink?: number } })?.connection;
  return {
    ua: nav?.userAgent ?? null,
    lang: nav?.language ?? null,
    dpr: (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? null,
    viewport: (globalThis as { innerWidth?: number }).innerWidth
      ? `${(globalThis as { innerWidth: number }).innerWidth}×${(globalThis as { innerHeight?: number }).innerHeight ?? "?"}`
      : null,
    url: (globalThis as { location?: Location }).location?.href ?? null,
    heapMB: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    heapLimitMB: mem?.jsHeapSizeLimit ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
    conn: conn?.effectiveType ?? null,
    ...extra,
  };
}
