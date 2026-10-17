/**
 * wsFpsProbe.ts —— 帧率与行为的滚动采样（页面内，后台运行）。
 *
 * 目的：把"卡不卡"拆成**可复算的数**：每秒一窗的 fps、最长帧间隔、jank 数，
 * 以及这一窗主要在执行什么行为。每 10 秒汇总一次发回本机日志服务，供事后分析。
 *
 * 约束（写在实现里，改之前先读）：
 * 1. `requestAnimationFrame` 回调**只做整数自增与数值比较**：不分配对象、不拼字符串、
 *    不读 DOM。窗口关闭由 1 秒定时器做，分位/分桶/掉帧事件由 10 秒定时器做。
 * 2. 行为标签由宿主在**操作边界**打点（`fpsMark`）。没有打点的帧记为 `idle`；
 *    瞬时操作（重建/换网格/名字重排/取瓦片/像素读回/样式重载）带短 TTL，
 *    过期自动回到 `idle`，避免"一次重建被算成整段都慢"。
 * 3. 与本页既有的对齐量具完全解耦：各自开关、各自回传 tag，互不读写状态。
 *    本探针默认开启（后台分析需要连续样本），`?fpsprobe=0` 关闭。
 * 4. 屏上默认不显示任何东西；`?fpshud=1` 才挂一行自用小字，每秒最多更新一次。
 * 5. 时间只用 `performance.now()` 单调时钟算间隔；墙钟时间仅作为每条回传的标记记录，
 *    不参与任何间隔/分位计算。
 */

/* ══════════════════════════════════════════════════════════════════
 * 一、常量与类型
 * ══════════════════════════════════════════════════════════════════ */

/** 行为标签（顺序即回传里的 tag 下标，改动会改变 wire 含义，只能追加到末尾） */
export const FPS_TAGS = [
  "idle",
  "moving",
  "overlay-rebuild",
  "mesh-swap",
  "name-layer-update",
  "mvt-tiles-fetch",
  "pixel-probe",
  "style-reload",
  "hidden-tab",
  /* 2026-10-17 追加（wire 下标只能追加）：页面刚起的那 30 秒单独打这个标签，
     别把初始化/首屏算进 idle —— 真机那批"17.6s 起连续 8 个 0fps 窗 · tag=idle"
     就是标签密度不足造成的**没法归因**。 */
  "page-load",
] as const;

export type FpsTag = (typeof FPS_TAGS)[number];

export const FPS_TAG_COUNT = FPS_TAGS.length;

/** 窗口长度（毫秒）。1 秒窗口：窗口内帧数 / 实际经过时间 */
export const FPS_WINDOW_MS = 1000;

/** 环形缓冲保留多少窗（180 窗 = 约 3 分钟） */
export const FPS_RING = 180;

/** 汇总与回传周期（毫秒） */
export const FPS_REPORT_MS = 10000;

/** 单帧间隔超过这个值算一次 jank */
export const FPS_JANK_MS = 100;

/** 掉帧事件阈值：窗口 fps 低于（全局 p50 × 该比例）且不低于下限 */
export const FPS_DROP_RATIO = 0.65;
export const FPS_DROP_MIN_FPS = 0.5;

/** 判定掉帧事件至少需要的窗口数（样本太少时 p50 不稳定） */
export const FPS_DROP_MIN_WINDOWS = 8;

/** 回传地址（GET，Image beacon；与对齐量具的 tag 不同） */
export const FPS_LOG_URL = "http://127.0.0.1:8795/__wslog?tag=fps&j=";

/** 自用 HUD 的 DOM id */
export const FPS_HUD_ID = "ws-fps-hud";

/** 瞬时行为标签的存活时间（毫秒）；0 = 粘住直到下一次打点 */
const TAG_TTL_MS: Record<FpsTag, number> = {
  idle: 0,
  moving: 400,
  "overlay-rebuild": 1200,
  "mesh-swap": 400,
  "name-layer-update": 800,
  "mvt-tiles-fetch": 1500,
  "pixel-probe": 120,
  "style-reload": 1500,
  "hidden-tab": 0,
  "page-load": 30000,
};

const TAG_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < FPS_TAGS.length; i++) m[FPS_TAGS[i]] = i;
  return m;
})();

const IDLE_TAG = TAG_INDEX.idle as number;
const HIDDEN_TAG = TAG_INDEX["hidden-tab"] as number;

/* ══════════════════════════════════════════════════════════════════
 * 二、纯函数（自检直接打这些）
 * ══════════════════════════════════════════════════════════════════ */

/** 一窗的 fps：帧数 / 实际经过时间。时间非正 ⇒ 数不出来（返回 null，不是 0） */
export function fpsOfWindow(frames: number, elapsedMs: number): number | null {
  if (!(elapsedMs > 0)) return null;
  return (frames * 1000) / elapsedMs;
}

/** 窗口是否到期（`>=`：恰好到达窗口长度的这一拍就要关窗） */
export function windowDue(elapsedMs: number, winMs: number = FPS_WINDOW_MS): boolean {
  return elapsedMs >= winMs;
}

/** 按最近秩（nearest-rank）取分位；样本为空返回 null。p 会被夹到 0..100 */
export function percentileNearestRank(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  const clamped = Math.max(0, Math.min(100, p));
  const k = Math.ceil((clamped / 100) * n) - 1;
  return sorted[Math.max(0, Math.min(n - 1, k))] as number;
}

/** 时间占比最大的标签下标（并列时取更靠前的，`idle` 在前 ⇒ 无行为证据时归 idle） */
export function pickDominant(acc: ArrayLike<number>): number {
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i] as number;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

export interface FpsWindow {
  /** 窗口起点（`performance.now()` 单调时钟） */
  tMs: number;
  /** 实际窗口长度（定时器可能晚到，这里是实际经过时间） */
  ms: number;
  fps: number;
  /** 本窗内最长帧间隔 */
  gapMs: number;
  /** 本窗内 > FPS_JANK_MS 的帧间隔个数 */
  jank: number;
  /** 本窗主导行为标签下标 */
  tag: number;
}

export interface FpsDrop {
  tMs: number;
  tag: FpsTag;
  fps: number;
  durMs: number;
  n: number;
}

/**
 * 从按时间排好序的窗口里找"成片掉帧"：连续若干窗低于阈值算一段。
 * 阈值 = max(FPS_DROP_MIN_FPS, p50 × FPS_DROP_RATIO)，调用方应传入同一份 p50。
 * 返回最近 `limit` 段。
 */
export function detectDrops(windows: readonly FpsWindow[], p50: number, limit = 3): FpsDrop[] {
  if (!(p50 > 0) || windows.length < FPS_DROP_MIN_WINDOWS) return [];
  const thr = Math.max(FPS_DROP_MIN_FPS, p50 * FPS_DROP_RATIO);
  const out: FpsDrop[] = [];
  let i = 0;
  while (i < windows.length) {
    const w = windows[i] as FpsWindow;
    if (w.fps > thr) {
      i++;
      continue;
    }
    const counts = new Array<number>(FPS_TAG_COUNT).fill(0);
    let j = i;
    let min = Number.POSITIVE_INFINITY;
    let dur = 0;
    while (j < windows.length) {
      const v = windows[j] as FpsWindow;
      if (v.fps > thr) break;
      if (v.fps < min) min = v.fps;
      dur += v.ms;
      counts[v.tag] = (counts[v.tag] as number) + 1;
      j++;
    }
    out.push({
      tMs: w.tMs,
      tag: FPS_TAGS[pickDominant(counts)] as FpsTag,
      fps: round1(min),
      durMs: Math.round(dur),
      n: j - i,
    });
    i = j;
  }
  return out.slice(-Math.max(1, limit));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、采样核心（不碰 DOM；自检用假时钟驱动）
 * ══════════════════════════════════════════════════════════════════ */

export interface FpsReport {
  v: 1;
  probe: "worldsim";
  sid: string;
  /** 墙钟时间（仅标记，不参与间隔计算） */
  at: string;
  /** 采样起点（performance.now 单调时钟） */
  t0: number;
  /** 本条回传距采样起点的毫秒 */
  dt: number;
  /** 环形缓冲里的窗口数 */
  n: number;
  /** 参与全局统计的窗口数（排除 hidden-tab） */
  nStat: number;
  hiddenWindows: number;
  fpsP50: number | null;
  fpsP10: number | null;
  fpsP01: number | null;
  fpsMin: number | null;
  worstGapMs: number;
  jankWindows: number;
  /** 按行为分桶：n / 中位 / 最小 */
  buckets: Record<string, { n: number; p50: number; min: number }>;
  /** 最近 3 段掉帧事件 */
  drops: FpsDrop[];
  /** 最近 10 秒的窗口（报告周期内的抽样） */
  last: { n: number; fpsAvg: number | null; fpsMin: number | null; tag: string | null };
  /** 本次新增的窗口：[距起点毫秒, fps, 最长间隔, jank 数, 标签下标] */
  w: Array<[number, number, number, number, number]>;
  /** 累计关过的窗口数（分析侧据此发现丢报） */
  cn: number;
  /** 掉帧判定阈值（fps），NULL = 样本不足 */
  dropThr: number | null;
  /** 标签下标 ↔ 名字（自描述，便于离线脚本解） */
  tags: readonly string[];
  /* ── 2026-10-17 追加（`fv: 2` 起；老字段语义不变，新字段只是多出来）── */
  /** 回传格式修订号（2 = 有长任务/停滞/首帧） */
  fv: 2;
  /** 首帧时刻（相对 `t0` 的毫秒；null = 采样期里还没有帧） */
  fp: number | null;
  /** ≥100ms 的长任务**总数**（PerformanceObserver longtask） */
  ltN: number;
  /** 最长的一次长任务（ms） */
  ltMax: number;
  /** 长任务 top10（按时长降序）：[相对 t0 开始, 时长] —— 把"8 秒 0fps 却标 idle"钉到具体活上 */
  lt: Array<[number, number]>;
  /** **停滞事件**：连续 ≥3 个窗 fps=0（且非 hidden）⇒ 带当时的标签与"最近一次标签切换时刻" */
  st: Array<{ t: number; n: number; tag: string; tagAt: number | null }>;
}

export interface FpsMeter {
  /** 帧回调：只做整数自增与比较 */
  frame(ts: number): void;
  /** 行为打点（宿主在操作边界调用） */
  mark(tag: FpsTag, now?: number): void;
  /** 关一个窗口并返回它（定时器调用） */
  closeWindow(now?: number): FpsWindow | null;
  /** 汇总（不发送） */
  snapshot(now?: number): FpsReport;
  /** 汇总并发送 */
  report(now?: number): FpsReport;
  /** 环形缓冲的窗口副本（时间顺序） */
  windows(): FpsWindow[];
  /** 当前主导标签 */
  currentTag(): FpsTag;
  /** 累计关闭的窗口数 */
  ringTotal(): number;
  /** 窗口内计数器（自检用） */
  counters(): { frames: number; maxGapMs: number; jank: number; elapsedMs: number };
  /** 记一条长任务（≥100ms；`PerformanceObserver({type:"longtask"})` 喂进来） */
  addLongTask(startMs: number, durMs: number): void;
  /** 最近一次**标签切换**的时刻（停滞事件要带它：出事那一刻到底在干什么） */
  lastTagAt(): number | null;
}

export interface FpsMeterOptions {
  /** 发送一行汇总（真实实现为 Image beacon；自检里捕获） */
  send?: (row: FpsReport) => void;
  /** 采样起点；默认取第一次创建时的 performance.now() */
  t0?: number;
  /** 会话标记（默认随机短串；只用于离线把多次运行分开） */
  sid?: string;
  /** 时钟（自检注入假时钟；默认真实单调时钟） */
  now?: () => number;
}

export function createFpsMeter(opts: FpsMeterOptions = {}): FpsMeter {
  const nowFn = opts.now ?? (() => performance.now());
  const t0 = opts.t0 ?? nowFn();
  const sid = opts.sid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /* 长任务：最多留 40 条（回传时取 top10；`ltN` 是总数） */
  const LONG_TASK_KEEP = 40;
  const longTasks: Array<[number, number]> = [];
  let ltN = 0;
  let ltMax = 0;
  let firstPaint: number | null = null;
  let lastTagAtMs: number | null = null;

  /* 环形缓冲：数值数组，避免每秒分配对象 */
  const ringT = new Float64Array(FPS_RING);
  const ringMs = new Float64Array(FPS_RING);
  const ringFps = new Float64Array(FPS_RING);
  const ringGap = new Float64Array(FPS_RING);
  const ringJank = new Uint16Array(FPS_RING);
  const ringTag = new Uint8Array(FPS_RING);
  let ringN = 0;
  let ringHead = 0;
  let ringTotal = 0;

  /* 当前窗口的帧计数（帧回调只碰这几个）+ 标签时间账 */
  let frames = 0;
  let maxGap = 0;
  let jank = 0;
  let lastFrame = -1;
  let winStart = t0;

  const acc = new Float64Array(FPS_TAG_COUNT);
  let labelNow = IDLE_TAG;
  let labelSince = t0;
  let labelExpire = 0;
  /** 已经回传过的窗口数（新窗口游标） */
  let sentN = 0;

  /** 把"标签到期"结清到 now 之前（只在定时器/打点里调用，不在帧回调里） */
  function settle(now: number): void {
    if (labelExpire > 0 && now >= labelExpire) {
      if (labelExpire > labelSince) acc[labelNow] = (acc[labelNow] as number) + (labelExpire - labelSince);
      labelSince = labelExpire;
      labelNow = IDLE_TAG;
      labelExpire = 0;
    }
  }

  function frame(ts: number): void {
    if (firstPaint === null) firstPaint = Math.max(0, ts - t0);
    frames += 1;
    if (lastFrame >= 0) {
      const gap = ts - lastFrame;
      if (gap > maxGap) maxGap = gap;
      if (gap > FPS_JANK_MS) jank += 1;
    }
    lastFrame = ts;
  }

  function mark(tag: FpsTag, now: number = nowFn()): void {
    const id = TAG_INDEX[tag];
    if (id === undefined) return;
    settle(now);
    if (id === labelNow) {
      /* 同一标签重复打点：只续期，不切段（moving 每帧都会打） */
      const ttl = TAG_TTL_MS[tag];
      labelExpire = ttl > 0 ? now + ttl : 0;
      return;
    }
    acc[labelNow] = (acc[labelNow] as number) + Math.max(0, now - labelSince);
    labelSince = now;
    labelNow = id;
    lastTagAtMs = now;
    const ttl = TAG_TTL_MS[tag];
    labelExpire = ttl > 0 ? now + ttl : 0;
  }

  function pushWindow(w: FpsWindow): void {
    ringT[ringHead] = w.tMs;
    ringMs[ringHead] = w.ms;
    ringFps[ringHead] = w.fps;
    ringGap[ringHead] = w.gapMs;
    ringJank[ringHead] = w.jank > 65535 ? 65535 : w.jank;
    ringTag[ringHead] = w.tag;
    ringHead = (ringHead + 1) % FPS_RING;
    if (ringN < FPS_RING) ringN += 1;
    ringTotal += 1;
  }

  function closeWindow(now: number = nowFn()): FpsWindow | null {
    settle(now);
    const elapsed = now - winStart;
    if (!(elapsed > 0)) return null;
    /* 关窗时把"最后一帧到关窗"这段也记进本窗的最长间隔：否则一窗末尾的停顿会被算到下一窗头上。
       jank 计数仍只在"帧真的到了"时加一（关窗这段没有到来帧，已经由那一次长间隔计过，
       再加一次就是把同一段停顿数两遍）。记完把 lastFrame 对齐到关窗时刻，下一窗从边界重新量。 */
    if (lastFrame >= 0 && now > lastFrame) {
      const tail = now - lastFrame;
      if (tail > maxGap) maxGap = tail;
    }
    lastFrame = now;
    acc[labelNow] = (acc[labelNow] as number) + (now - labelSince);
    labelSince = now;
    const tag = pickDominant(acc);
    acc.fill(0);
    const fps = fpsOfWindow(frames, elapsed);
    if (fps === null) return null;
    const w: FpsWindow = {
      tMs: winStart,
      ms: elapsed,
      fps: round2(fps),
      gapMs: Math.round(maxGap),
      jank,
      tag,
    };
    pushWindow(w);
    winStart = now;
    frames = 0;
    maxGap = 0;
    jank = 0;
    return w;
  }

  function windows(): FpsWindow[] {
    const out: FpsWindow[] = [];
    const start = ringN < FPS_RING ? 0 : ringHead;
    for (let k = 0; k < ringN; k++) {
      const i = (start + k) % FPS_RING;
      out.push({
        tMs: ringT[i] as number,
        ms: ringMs[i] as number,
        fps: ringFps[i] as number,
        gapMs: ringGap[i] as number,
        jank: ringJank[i] as number,
        tag: ringTag[i] as number,
      });
    }
    return out;
  }

  /** 长任务（`PerformanceObserver({type:"longtask"})` 喂进来）：留最长的 40 条，回传 top10 */
  function addLongTask(startMs: number, durMs: number): void {
    if (!(durMs >= FPS_JANK_MS)) return;
    ltN += 1;
    if (durMs > ltMax) ltMax = durMs;
    const rel = Math.max(0, startMs - t0);
    if (longTasks.length < LONG_TASK_KEEP) longTasks.push([rel, durMs]);
    else {
      let worst = 0;
      for (let i = 1; i < longTasks.length; i++) if ((longTasks[i] as [number, number])[1] < (longTasks[worst] as [number, number])[1]) worst = i;
      if (durMs > (longTasks[worst] as [number, number])[1]) longTasks[worst] = [rel, durMs];
    }
  }

  function snapshot(now: number = nowFn()): FpsReport {
    const all = windows();
    const stat = all.filter((w) => w.tag !== HIDDEN_TAG);
    const fpsArr = stat.map((w) => w.fps).sort((a, b) => a - b);
    const p50 = percentileNearestRank(fpsArr, 50);

    const buckets: Record<string, { n: number; p50: number; min: number }> = {};
    for (let t = 0; t < FPS_TAG_COUNT; t++) {
      const rows = all.filter((w) => w.tag === t);
      if (!rows.length) continue;
      const vals = rows.map((w) => w.fps).sort((a, b) => a - b);
      buckets[FPS_TAGS[t] as string] = {
        n: rows.length,
        p50: round1(percentileNearestRank(vals, 50) as number),
        min: round1(vals[0] as number),
      };
    }

    let worstGap = 0;
    let jankWindows = 0;
    for (const w of stat) {
      if (w.gapMs > worstGap) worstGap = w.gapMs;
      if (w.jank > 0) jankWindows += 1;
    }

    /* **停滞事件**（2026-10-17 真机「8 秒 0fps 但 tag=idle」）：连续 ≥3 个窗 fps=0 且非 hidden。
       带上那一串的起始时刻、窗数、当时主导标签、以及**最近一次标签切换时刻**（出事那一刻在干什么）。
       `fps === 0` 是"这一秒一帧都没有"——不是"帧率低"，所以单独成一条，别混进 drops。 */
    const stalls: Array<{ t: number; n: number; tag: string; tagAt: number | null }> = [];
    {
      let run = 0;
      let runStart = 0;
      for (let i = 0; i < all.length; i++) {
        const ww = all[i] as FpsWindow;
        const zero = ww.tag !== HIDDEN_TAG && ww.fps <= 0;
        if (zero) {
          if (run === 0) runStart = i;
          run += 1;
        } else {
          if (run >= 3) {
            const seg = all.slice(runStart, runStart + run);
            const counts = new Array<number>(FPS_TAG_COUNT).fill(0);
            for (const x of seg) counts[x.tag] = (counts[x.tag] as number) + 1;
            stalls.push({
              t: Math.round((seg[0] as FpsWindow).tMs - t0),
              n: run,
              tag: FPS_TAGS[pickDominant(counts)] as string,
              tagAt: lastTagAtMs === null ? null : Math.round(lastTagAtMs - t0),
            });
          }
          run = 0;
        }
      }
      if (run >= 3) {
        const seg = all.slice(runStart, runStart + run);
        const counts = new Array<number>(FPS_TAG_COUNT).fill(0);
        for (const x of seg) counts[x.tag] = (counts[x.tag] as number) + 1;
        stalls.push({
          t: Math.round((seg[0] as FpsWindow).tMs - t0),
          n: run,
          tag: FPS_TAGS[pickDominant(counts)] as string,
          tagAt: lastTagAtMs === null ? null : Math.round(lastTagAtMs - t0),
        });
      }
    }

    const perReport = Math.max(1, Math.ceil(FPS_REPORT_MS / FPS_WINDOW_MS));
    const tail = all.slice(-perReport);
    let fpsSum = 0;
    let fpsMin = Number.POSITIVE_INFINITY;
    const tailCounts = new Array<number>(FPS_TAG_COUNT).fill(0);
    for (const w of tail) {
      fpsSum += w.fps;
      if (w.fps < fpsMin) fpsMin = w.fps;
      tailCounts[w.tag] = (tailCounts[w.tag] as number) + 1;
    }

    const dropThr = p50 === null ? null : Math.max(FPS_DROP_MIN_FPS, p50 * FPS_DROP_RATIO);
    const drops = p50 === null ? [] : detectDrops(stat, p50, 3);

    /* 本次新增窗口（自上次回传之后关掉的）。环形缓冲最多 180 窗，超出部分丢不掉就如实少报 */
    const pending = Math.min(Math.max(0, ringTotal - sentN), ringN);
    const wOut: Array<[number, number, number, number, number]> = [];
    for (let k = ringN - pending; k < ringN; k++) {
      const win = all[k] as FpsWindow;
      wOut.push([Math.round(win.tMs - t0), round1(win.fps), win.gapMs, win.jank, win.tag]);
    }
    sentN = ringTotal;

    return {
      v: 1,
      probe: "worldsim",
      sid,
      at: new Date().toISOString(),
      t0: Math.round(t0),
      dt: Math.round(now - t0),
      n: all.length,
      nStat: stat.length,
      hiddenWindows: all.length - stat.length,
      fpsP50: p50 === null ? null : round1(p50),
      fpsP10: fpsArr.length ? round1(percentileNearestRank(fpsArr, 10) as number) : null,
      fpsP01: fpsArr.length ? round1(percentileNearestRank(fpsArr, 1) as number) : null,
      fpsMin: fpsArr.length ? round1(fpsArr[0] as number) : null,
      worstGapMs: Math.round(worstGap),
      jankWindows,
      buckets,
      drops,
      last: {
        n: tail.length,
        fpsAvg: tail.length ? round1(fpsSum / tail.length) : null,
        fpsMin: tail.length ? round1(fpsMin) : null,
        tag: tail.length ? (FPS_TAGS[pickDominant(tailCounts)] as string) : null,
      },
      w: wOut,
      cn: ringTotal,
      fv: 2,
      fp: firstPaint === null ? null : Math.round(firstPaint),
      ltN,
      ltMax: Math.round(ltMax),
      lt: [...longTasks].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, d]) => [Math.round(t), Math.round(d)] as [number, number]),
      st: stalls.slice(-5),
      dropThr: dropThr === null ? null : round1(dropThr),
      tags: FPS_TAGS,
    };
  }

  function report(now: number = nowFn()): FpsReport {
    const row = snapshot(now);
    try {
      opts.send?.(row);
    } catch {
      /* 回传失败不影响页面 */
    }
    return row;
  }

  return {
    frame,
    mark,
    closeWindow,
    snapshot,
    report,
    windows,
    currentTag: () => FPS_TAGS[labelNow] as FpsTag,
    ringTotal: () => ringTotal,
    counters: () => ({ frames, maxGapMs: Math.round(maxGap), jank, elapsedMs: Math.round(nowFn() - winStart) }),
    addLongTask,
    lastTagAt: () => lastTagAtMs,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、页面接线（开关、rAF、定时器、HUD、回传）
 * ══════════════════════════════════════════════════════════════════ */

function queryString(search?: string): string {
  if (search !== undefined) return search;
  try {
    return `${String(location.search || "")}&${String(location.hash || "")}`;
  } catch {
    return "";
  }
}

/** 采集开关：默认开，`?fpsprobe=0`（或 `?fps=0`）关闭。与 `?wsalign=1` 无关 */
export function fpsProbeOn(search?: string): boolean {
  const q = queryString(search);
  return !/[?&](?:fpsprobe|fps)=0\b/.test(q);
}

/** 屏上读数开关：默认关，`?fpshud=1` 才显示 */
export function fpsHudOn(search?: string): boolean {
  const q = queryString(search);
  return /[?&]fpshud=1\b/.test(q);
}

interface ActiveProbe {
  core: FpsMeter;
  raf: number;
  windowTimer: number;
  reportTimer: number;
  onVisibility: () => void;
  hudEl: HTMLElement | null;
  lastP10: number | null;
  /** 长任务观察器（stop 时断开） */
  ltObs: PerformanceObserver | null;
}

let active: ActiveProbe | null = null;

function paintHud(probe: ActiveProbe, win: FpsWindow | null): void {
  const el = probe.hudEl;
  if (!el) return;
  const fps = win ? win.fps.toFixed(1) : "--";
  const p10 = probe.lastP10 === null ? "--" : probe.lastP10.toFixed(1);
  const gap = win ? String(win.gapMs) : "--";
  const tag = FPS_TAGS[(win ? win.tag : TAG_INDEX[probe.core.currentTag()]) as number] as string;
  el.textContent = `fps ${fps} · p10 ${p10} · gap ${gap}ms · ${tag}`;
}

function makeHud(): HTMLElement | null {
  try {
    const el = document.createElement("div");
    el.id = FPS_HUD_ID;
    el.setAttribute("data-ws-fps", "1");
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;pointer-events:none;" +
      "font:11px/1.4 ui-monospace,monospace;color:#bff3ff;background:rgba(0,0,0,.45);" +
      "padding:2px 6px;border-radius:4px;white-space:nowrap";
    document.body.appendChild(el);
    return el;
  } catch {
    return null;
  }
}

function beacon(row: FpsReport): void {
  try {
    const img = new Image();
    img.src = FPS_LOG_URL + encodeURIComponent(JSON.stringify(row));
  } catch {
    /* 回传失败不影响页面 */
  }
}

/**
 * 安装探针（幂等）。在页面挂载时调用一次；没有 DOM / 被开关关掉时返回 false。
 * 返回 true 表示这次确实启动了采样。
 */
export function installFpsProbe(opts: { search?: string; sid?: string } = {}): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (active) return true;
  const search = queryString(opts.search);
  if (!fpsProbeOn(search)) return false;

  const core = createFpsMeter({ send: beacon, sid: opts.sid });
  /* 页面刚起的 30 秒单独打 `page-load`（TTL 30s）：真机那批"17.6s 起 8 个 0fps 窗 · tag=idle"
     就是因为初始化阶段被标成了 idle，没法归因。 */
  try { core.mark("page-load"); } catch { /* 打点失败不影响采样 */ }
  const hudEl = fpsHudOn(search) ? makeHud() : null;
  const probe: ActiveProbe = {
    core,
    raf: 0,
    windowTimer: 0,
    reportTimer: 0,
    onVisibility: () => {
      try {
        core.mark(document.visibilityState === "hidden" ? "hidden-tab" : "idle");
      } catch {
        /* 可见性读不到就不打点 */
      }
    },
    hudEl,
    lastP10: null,
    ltObs: null,
  };

  const tick = (ts: number): void => {
    core.frame(ts);
    probe.raf = window.requestAnimationFrame(tick);
  };
  probe.raf = window.requestAnimationFrame(tick);

  /* 1 秒窗口：只在这里关窗（帧回调里不做） */
  probe.windowTimer = window.setInterval(() => {
    const w = core.closeWindow(performance.now());
    if (hudEl) paintHud(probe, w);
  }, FPS_WINDOW_MS);

  /* 10 秒汇总：分位、分桶、掉帧事件都在这里做，然后回传一次 */
  probe.reportTimer = window.setInterval(() => {
    try {
      const row = core.report(performance.now());
      probe.lastP10 = row.fpsP10;
    } catch {
      /* 汇总失败不影响页面 */
    }
  }, FPS_REPORT_MS);

  /* 🔴 长任务观measure（2026-10-17 真机「8 秒 0fps 但 tag=idle」）：主线程上任何 ≥100ms 的
     同步活都会被记下来（开始时刻 + 时长，回传 top10）⇒ 停滞事件能直接指到"谁干的"。
     浏览器不支持就静默跳过（老内核/桌面）。 */
  let ltObs: PerformanceObserver | null = null;
  try {
    const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO) {
      ltObs = new PO((list) => {
        for (const e of list.getEntries()) {
          try { core.addLongTask(Number(e.startTime) || 0, Number(e.duration) || 0); } catch { /* 单条失败跳过 */ }
        }
      });
      ltObs.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    ltObs = null;
  }

  try {
    document.addEventListener("visibilitychange", probe.onVisibility);
    if (document.visibilityState === "hidden") core.mark("hidden-tab");
  } catch {
    /* 没挂上也能跑：只是少 hidden-tab 标签 */
  }

  (probe as unknown as { ltObs?: PerformanceObserver | null }).ltObs = ltObs;
  active = probe;
  if (hudEl) paintHud(probe, null);
  return true;
}

/** 停止采样并清理（页面卸载时调用；可重复调用） */
export function stopFpsProbe(): void {
  const probe = active;
  if (!probe) return;
  active = null;
  try {
    window.cancelAnimationFrame(probe.raf);
  } catch {
    /* 已取消 */
  }
  try {
    window.clearInterval(probe.windowTimer);
    window.clearInterval(probe.reportTimer);
  } catch {
    /* 已清理 */
  }
  try {
    document.removeEventListener("visibilitychange", probe.onVisibility);
  } catch {
    /* 已移除 */
  }
  try {
    (probe as unknown as { ltObs?: PerformanceObserver | null }).ltObs?.disconnect();
  } catch {
    /* 已断开 */
  }
  try {
    probe.hudEl?.remove();
  } catch {
    /* 已移除 */
  }
}

/** 宿主打点入口：探针没装时是空转（一次函数调用 + 一次判空） */
export function fpsMark(tag: FpsTag): void {
  if (active) active.core.mark(tag);
}

/** 采样是否在跑（自检/调试用） */
export function fpsProbeActive(): boolean {
  return active !== null;
}
