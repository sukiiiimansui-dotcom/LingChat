/* wsStyleWatch.ts —— **"活着的 WebGL 路也要有人看着它"**（2026-10-11）。
 *
 * ## 为什么要有它（真机读数，不是猜）
 * `~/chk/wslog/phone1.jsonl`（真机、新包）：`?kill=` 用真 `loseContext()` 丢了上下文之后，
 * **68 秒里没有 `webglcontextrestored`** ⇒ `styleLoaded=false`、`getStyle().layers=null`、
 * `hasSrc=false`、`hasLayer=false` **一直不动**，而 `bld.drawn=62`、相机还在走
 * ⇒ 屏幕上就是"楼房莫名消失"。**而现有的兜底治不了它**：
 *   · `bldHeal`（`wsBldLanding`）第一句就是"样式没就绪 ⇒ 什么都不做"（那是对的：那一刻 addSource 会抛），
 *     它管的是"**样式活着、源/层缺了**"；
 *   · `wsEngineGuard` 的恢复轮询（`startRecoverPoll`）**只在已经掉进 2D 之后**才跑 ⇒ 活着的 WebGL 路没人看。
 * ⇒ 这一份补的就是那个空档：**低频**地问"样式还活着吗"，**连续死够 N 毫秒**才动作（防抖，避免误判）。
 *
 * ## 与 `bldHeal` 的分工（写清楚，免得两套兜底打架）
 * | 判据 | 谁管 | 动作 |
 * |---|---|---|
 * | 样式活着、`bld` 源或挤出层缺 | `bldHeal`（`wsBldLanding`） | 先补缺层、再走既有落图通路 |
 * | **样式本身死了**（`isStyleLoaded()===false` 或 `getStyle()` 空）且持续 ≥ N | **本模块** | 交给宿主（App：`fallback2d(...,"temp",...)` 并写可见原因；见宿主接线） |
 * 两者**互斥**：样式死了的时候 `bldHeal` 本来就早退（不打架）；样式活着的日常里本模块**纯读**。
 *
 * ## 纪律
 * · **幂等**：健康 ⇒ 只调一次 `isDead()`（默认实现是两次只读调用），**零写**、零分配；
 * · **防抖**：单次"看起来死了"不算（`isStyleLoaded()` 在样式切换期间会短暂为 false）⇒ 必须**连续**死够 `deadMs`；
 * · **不静默**：`facts()` 报 `checks / dead / fires / lastFireMs / lastWhy`；
 * · **可关**：宿主用 `?stylewatch=0` 直接不装（那份代码路径逐字节不变）。
 *
 * 本模块**纯逻辑**（不碰 DOM / 不碰 map 对象，`isDead` 由调用方注入）⇒ node 里能用假时钟逐个钉字面量。
 */

export interface StyleWatchOpts {
  /** **连续**死够多久才动作（ms）。真机取 5000：短于它会把样式切换的瞬时 false 误判成死亡。 */
  deadMs: number;
  /** 注入的判据（返回 true = 此刻看起来死了）。**必须是只读的**。 */
  isDead: () => boolean;
  /** 判定死亡时调用一次（宿主在这里做恢复 + 记原因）。抛错不影响看门狗继续跑。 */
  onDead: (why: string) => void;
  /** 时钟（默认 `Date.now`；自检注入假时钟） */
  now?: () => number;
  /** 判词里的原因前缀（默认 `样式/上下文死亡`） */
  whyPrefix?: string;
}

export interface StyleWatchFacts {
  /** 问过几次"还活着吗" */
  checks: number;
  /** 其中"看起来死了"的次数（历史累计） */
  dead: number;
  /** 真的到了阈值、动作了几次 */
  fires: number;
  /** 最近一次动作耗时（ms）；没动作过 = null */
  lastFireMs: number | null;
  /** 最近一次动作的原因原文 */
  lastWhy: string;
  /** 当前这一轮"连续死"的起点（没在死 = null）—— 排障用 */
  deadSince: number | null;
}

export type StyleWatchTick = "healthy" | "dead" | "fired";

export interface StyleWatch {
  /** 宿主低频调用（例如 1s 一次）。**健康时零写**。 */
  tick(): StyleWatchTick;
  facts(): StyleWatchFacts;
  /** 手动复位"连续死"的计时（换图/重建后调用） */
  reset(): void;
}

export function createStyleWatch(opts: StyleWatchOpts): StyleWatch {
  const now = opts.now || (() => Date.now());
  const deadMs = Number.isFinite(opts.deadMs) ? Math.max(0, Number(opts.deadMs)) : 5000;
  const prefix = opts.whyPrefix || "样式/上下文死亡";
  const f: StyleWatchFacts = { checks: 0, dead: 0, fires: 0, lastFireMs: null, lastWhy: "", deadSince: null };

  return {
    tick(): StyleWatchTick {
      f.checks += 1;
      let dead = false;
      try { dead = !!opts.isDead(); } catch { dead = false; }   /* 判据抛错 = 不当作死（宁可漏，不可误判后乱动作） */
      if (!dead) { f.deadSince = null; return "healthy"; }
      f.dead += 1;
      const t = now();
      if (f.deadSince === null) f.deadSince = t;
      if (t - f.deadSince < deadMs) return "dead";
      /* 到阈值：动作**恰好一次**，然后把计时复位（下一轮重新累计；健康时立刻归位） */
      const why = prefix + "（连续 " + Math.round(t - f.deadSince) + "ms）";
      const t0 = now();
      f.deadSince = null;
      try { opts.onDead(why); } catch { /* 恢复动作抛错不许把看门狗弄死 */ }
      f.fires += 1;
      f.lastFireMs = Math.max(0, Math.round(now() - t0));
      f.lastWhy = why;
      return "fired";
    },
    facts(): StyleWatchFacts { return { ...f }; },
    reset(): void { f.deadSince = null; },
  };
}
