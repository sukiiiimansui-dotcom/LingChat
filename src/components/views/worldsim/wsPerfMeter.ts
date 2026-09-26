/**
 * wsPerfMeter.ts —— **耗时可数口径的唯一一份**（页面与 App 共用；页面只接线）。
 *
 * ## 为什么有这一份（机主 2026-09-26 真机原话：「**现在就是加载慢，且…渲染不全，卡顿喵**」）
 * "加载慢/卡顿"是**观感**，而观感必须能被拆成可数的毫秒，否则只能靠感觉吵。
 * 本机（Termux + 无头 Chromium）**没有 WebGL** ⇒ 帧率只能机主真机判；
 * 但「网络 / 解析 / 计算 / setData」这些**在 JS 里花掉的时间**是可以当场量出来的 ——
 * 这一份就是那把尺子：`pmTime()` 包一层，数字进环形统计，`pmSnapshot()` 一次取走。
 *
 * ## 口径（三条，别处不许再抄一份）
 * 1. **时间原点 = `performance.timeOrigin`**：`pmNow()` 就是 `performance.now()`，
 *    与 `performance.getEntriesByType("resource")` 的 `startTime` **同一把尺子**
 *    ⇒ 网络条目与本模块的 span 可以直接对齐（"首屏 X 秒里 Y 秒花在 Z"要能对得上）。
 * 2. **中位/p90 = 对保留样本的最近秩（nearest-rank）**，不是插值：可复算、无浮点玄学。
 *    样本超过 `PM_SAMPLE_CAP` 只保留**最近**那批 ⇒ 快照里如实写 `kept`（免得把"截断过"说成"全部"）。
 * 3. **数不出来就不写 0**：没有 `performance`（老环境/自检桩）⇒ `pmAvailable()` 为 false，
 *    `pmSnapshot()` 里如实写 `available:false`，调用方据此说"数不出来"。
 *
 * ## 长任务（Long Tasks）
 * `longtask` 是浏览器自己的口径（>50ms 的主线程任务），比我们手工包函数**更接近"卡顿"**：
 * 它连布局/GC/样式重算一起算。`pmObserveLongTasks()` 挂一次 PerformanceObserver
 * （`buffered:true` 连挂之前发生的也收），保留**最长的 N 条**。无头没有 WebGL 时
 * 长任务仍可量（渲染相关的长任务会少，这一点在报告里要如实说）。
 *
 * ⚠️ 本文件**零依赖**（不 import 任何兄弟模块）：它要能在自检里单独 bundle，
 * 也要能在 vendor 产物里被任何模块引用而不引入环。
 */

/** 每个标签最多保留多少条样本（保留**最近**的；超了只影响中位/p90 的样本面，n/total/max 仍是全量） */
export const PM_SAMPLE_CAP = 2000;
/** 长任务最多记几条（按耗时降序） */
export const PM_LONG_TASK_KEEP = 12;
/** 长任务门槛（ms）——与浏览器 `longtask` 的口径一致（我们只做兜底自算时才用） */
export const PM_LONG_TASK_MS = 50;

export interface PmSpanStat {
  label: string;
  /** 全量调用次数 */
  n: number;
  /** 全量总耗时（ms） */
  total: number;
  max: number;
  /** 参与中位/p90 计算的样本条数（≤ PM_SAMPLE_CAP） */
  kept: number;
  median: number | null;
  p90: number | null;
  /** 附带记录的字节数（可选；全量求和） */
  bytes: number | null;
  /** 最近一次附带的说明（可选） */
  note: string | null;
}

export interface PmMark {
  name: string;
  /** 相对 `performance.timeOrigin` 的毫秒（= `performance.now()` 的量纲） */
  t: number;
  /** 与**本模块第一次被调用**之间的毫秒差（"从探针开工到这一刻"） */
  sinceBoot: number;
  extra: Record<string, unknown> | null;
}

export interface PmLongTask {
  /** 相对 timeOrigin 的起点（ms） */
  start: number;
  dur: number;
  name: string;
}

export interface PmSnapshot {
  available: boolean;
  now: number | null;
  bootT: number | null;
  marks: PmMark[];
  spans: PmSpanStat[];
  longTasks: {
    /** 观察器有没有挂上（没挂 = 数不出来，不是 0） */
    observing: boolean;
    supported: boolean | null;
    count: number;
    total: number;
    max: number | null;
    top: PmLongTask[];
  };
  context: Record<string, unknown>;
}

interface PmSpanBucket {
  n: number;
  total: number;
  max: number;
  samples: number[];
  bytes: number | null;
  note: string | null;
}

const spans = new Map<string, PmSpanBucket>();
let marks: PmMark[] = [];
let bootT: number | null = null;
const context: Record<string, unknown> = {};
let ltObserving = false;
let ltSupported: boolean | null = null;
let ltCount = 0;
let ltTotal = 0;
let ltMax: number | null = null;
let ltTop: PmLongTask[] = [];

/** 有没有真 `performance`（自检桩里没有 ⇒ 一切判词走"数不出来"） */
export function pmAvailable(): boolean {
  return typeof performance !== "undefined" && typeof performance.now === "function";
}

/** 与 Resource Timing 同一把尺子的"现在"（ms，相对 timeOrigin） */
export function pmNow(): number {
  if (pmAvailable()) return performance.now();
  return typeof Date !== "undefined" && Date.now ? Date.now() : 0;
}

/** 开工时刻（第一次有人问时间时记下）—— `sinceBoot` 的零点 */
function bootOnce(): number {
  if (bootT === null) bootT = pmNow();
  return bootT;
}

/** 记一个**时刻**（阶段边界）：名字自己起，`extra` 里放当时的可数事实（zoom/格数/字节…） */
export function pmMark(name: string, extra: Record<string, unknown> | null = null): void {
  const b = bootOnce();
  const t = pmNow();
  marks.push({ name: String(name), t, sinceBoot: Math.round((t - b) * 100) / 100, extra: extra || null });
  /* 环形上限：**阶段边界本来就少**，但页面若被误用在循环里，也不许把内存吃光 */
  if (marks.length > 400) marks = marks.slice(-400);
}

/** 记一条耗时（ms）。`bytes` 只有真知道时才传（不知道就**不传**，快照里是 null 而不是 0） */
export function pmSpan(label: string, ms: number, bytes?: number | null, note?: string | null): void {
  const k = String(label);
  const v = Number(ms);
  if (!Number.isFinite(v)) return;                        // 坏数字不进统计（也不写 0）
  let b = spans.get(k);
  if (!b) { b = { n: 0, total: 0, max: 0, samples: [], bytes: null, note: null }; spans.set(k, b); }
  b.n += 1;
  b.total += v;
  if (v > b.max) b.max = v;
  b.samples.push(v);
  if (b.samples.length > PM_SAMPLE_CAP) b.samples.splice(0, b.samples.length - PM_SAMPLE_CAP);
  if (typeof bytes === "number" && Number.isFinite(bytes)) b.bytes = (b.bytes || 0) + bytes;
  if (note !== undefined && note !== null) b.note = String(note).slice(0, 200);
}

/** 同步函数计时（异常照抛，但**已经花掉的时间照样记账**——失败的那次也是成本） */
export function pmTime<T>(label: string, fn: () => T, bytesOf?: (r: T) => number | null | undefined): T {
  const t0 = pmNow();
  try {
    const r = fn();
    let by: number | null = null;
    try { const x = bytesOf ? bytesOf(r) : null; if (typeof x === "number" && Number.isFinite(x)) by = x; } catch { by = null; }
    pmSpan(label, pmNow() - t0, by);
    return r;
  } catch (e) {
    pmSpan(label, pmNow() - t0, null, "抛错(" + String((e as Error)?.message || e).slice(0, 60) + ")");
    throw e;
  }
}

/** 把 async 函数包一层（`await` 全程计时）—— 取数/解析那种"跨网络"的段落用它 */
export async function pmTimeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = pmNow();
  try {
    const r = await fn();
    pmSpan(label, pmNow() - t0);
    return r;
  } catch (e) {
    pmSpan(label, pmNow() - t0, null, "抛错(" + String((e as Error)?.message || e).slice(0, 60) + ")");
    throw e;
  }
}

/** 最近秩分位（0<p<=1）；空样本 ⇒ null（**不写 0**） */
export function pmPercentile(sortedAsc: readonly number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const q = Math.min(1, Math.max(0, p));
  const idx = Math.max(0, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[Math.min(sortedAsc.length - 1, idx)];
}

/** 一次取走全部读数（给探针/HUD/报告用；**不改状态**） */
export function pmSnapshot(): PmSnapshot {
  const out: PmSpanStat[] = [];
  for (const [label, b] of spans) {
    const s = b.samples.slice().sort((a, z) => a - z);
    out.push({
      label, n: b.n, total: Math.round(b.total * 100) / 100, max: Math.round(b.max * 100) / 100,
      kept: s.length,
      median: s.length ? Math.round((pmPercentile(s, 0.5) as number) * 100) / 100 : null,
      p90: s.length ? Math.round((pmPercentile(s, 0.9) as number) * 100) / 100 : null,
      bytes: b.bytes, note: b.note,
    });
  }
  /* 输出按**总耗时降序** —— 报告里"谁是大头"一眼可见（不用人肉排） */
  out.sort((a, z) => z.total - a.total);
  return {
    available: pmAvailable(),
    now: pmAvailable() ? Math.round(pmNow() * 100) / 100 : null,
    bootT: bootT === null ? null : Math.round(bootT * 100) / 100,
    marks: marks.slice(),
    spans: out,
    longTasks: {
      observing: ltObserving, supported: ltSupported, count: ltCount,
      total: Math.round(ltTotal * 100) / 100, max: ltMax === null ? null : Math.round(ltMax * 100) / 100,
      top: ltTop.slice(),
    },
    context: { ...context },
  };
}

/** 归零（自检与"再来一次"用；**不动长任务观察器**，避免重复挂） */
export function pmReset(): void {
  spans.clear();
  marks = [];
  bootT = null;
  for (const k of Object.keys(context)) delete context[k];
  ltCount = 0; ltTotal = 0; ltMax = null; ltTop = [];
}

/** 挂长任务观察器（幂等；返回"这次有没有挂上"）。不支持 ⇒ false，且 `supported=false` 进快照 */
export function pmObserveLongTasks(): boolean {
  if (ltObserving) return true;
  if (typeof PerformanceObserver === "undefined") { ltSupported = false; return false; }
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const dur = Number((e as PerformanceEntry).duration) || 0;
        const start = Math.round(Number((e as PerformanceEntry).startTime) * 100) / 100;
        ltCount += 1; ltTotal += dur;
        if (ltMax === null || dur > ltMax) ltMax = dur;
        ltTop.push({ start, dur: Math.round(dur * 100) / 100, name: String((e as PerformanceEntry).name || "task") });
        ltTop.sort((a, z) => z.dur - a.dur);
        if (ltTop.length > PM_LONG_TASK_KEEP) ltTop = ltTop.slice(0, PM_LONG_TASK_KEEP);
      }
    });
    po.observe({ entryTypes: ["longtask"], buffered: true } as PerformanceObserverInit);
    ltObserving = true; ltSupported = true;
    return true;
  } catch {
    /* 不支持 `longtask`（Safari/旧内核）⇒ 如实记 supported=false，绝不假装量过 */
    ltSupported = false;
    return false;
  }
}

/** 附一条上下文（环境快照要带的东西：zoom / 格尺寸 / 仓库上限…） */
export function pmSetContext(k: string, v: unknown): void {
  context[String(k)] = v;
}
