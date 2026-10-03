/**
 * wsNeeds.ts —— 「心情 / 体力」的**数值层**（玩法植入计划 · 期 2「因果通电」）。
 *
 * ## 为什么有这一层（接口早留好了，前端从来不推）
 * Rust 侧的读数口一直在：`event_cmd.rs` 头部的字段映射表写着
 * `mood / energy ← actors[role].mood / .energy`（**须落在 0–1**，取不到 = `None` = 不知道），
 * 读它的地方是 `events.rs::weight_for` 的 ④⑤：
 *   · `mood < LOW_MOOD_THRESHOLD`(0.35) ⇒ 情绪类事件权重 ×2.2（`LOW_MOOD_FACTOR`）；
 *   · `energy < LOW_ENERGY_THRESHOLD`(0.30) ⇒ 健康类 ×1.6、工作学习类 ×0.6。
 * 也就是说：**只要有人把 0–1 的 mood/energy 推上去，"心情低 → 更容易出情绪事件"就真的生效了**。
 * 在这之前，全仓 grep 只有"没人写"——`actors[*]` 里从来没有过这两个键。
 *
 * ## 数值从哪来（🔴 这一段是本期最需要说清楚的事）
 * 前端**没有**任何一个"测量出来的"心情/体力（没有传感器、没有模型自评）。所以这里**不编**，
 * 只做一件事：把**已经到手的真实状态**按一张写明的表换算成 0–1：
 *
 * | 输入 | 真源 | 缺了怎么办 |
 * |---|---|---|
 * | 本机时间（时） | `Date.now()` → 本地小时 | **缺了就整体判"数不出来"**（时间是最小充分输入） |
 * | 天气 | `useWorldWeather`（真天气；降级态 = 没拿到） | 记进 `missing`，**那一项不参与**（不是按"0 分天气"算） |
 * | 刚发生的事件 | `useWorldEvents`（Rust 事件表带的 `effects`） | 没有事件 = 没有脉冲（列表不变） |
 * | 今日三件事 | `wsDailyStore`（本机玩法状态） | 记进 `missing`，那一项不参与 |
 *
 * ⇒ 产物是**推导值**（`source: "derived"`），不是测量值。给用户看的时候必须连口径一起给
 * （`basis` / `missing` / `why` 三个字段就是干这个的），**不许**把它说成"角色的真实心情"。
 * 判词一律照本仓老规矩：数不出来就写"数不出来"，**不写 0.5 假装有值**。
 *
 * ## 三条硬口径（与 Rust 对齐，别在这里改）
 * ① **量程就是 0–1（含端点）**，与 `event_cmd.rs::actor_unit` 的 `(0.0..=1.0).contains(v)` 逐字对齐；
 *    本文件**不引入第三套量程**（`NEEDS_MIN/MAX` 是唯一定义处，`round` 只做确定性取整）。
 * ② **纯函数 + 可注入输入**：`computeNeeds()` 不读系统时间、不碰 localStorage、不 import vue
 *    ⇒ 同一份输入跑两次**逐字节相同**（自检直接对拍 JSON）。
 * ③ 存储层只在 `useWsNeeds()`（与 `wsRelation.ts` 同款：坏数据一律退回空表，**绝不抛**）。
 *
 * ## 数值表（**手感值**，与事件权重同款，不是标定参数）
 * - 昼夜曲线 `CIRCADIAN_ENERGY`：锚点之间线性插值（凌晨 3 点最低 0.16，上午 9 点最高 0.82）；
 * - 情绪基线 `MOOD_BASE = 0.55`，再按**昼夜基线**偏移 `MOOD_FROM_ENERGY × (base − ENERGY_REFERENCE)`；
 *   ⚠️ 用的是 `base`（昼夜基线），**不是**最终体力值 —— 也就是说"事件把体力拉低"**不会**连带拉低心情
 *   （两者各自累加脉冲）。这是有意的口径（改它=改玩法），原先注释写成 `energy` 与代码不符，已按代码改正。
 * - 天气：雨/雪 −0.08、雾 −0.06、雷 −0.05、≥32℃ −0.06、≤5℃ −0.05、晴/多云 +0.04；
 * - 今日三件事：每完成一件 +0.04（上限 +0.12）；
 * - 事件脉冲：按半衰期衰减（心情 6h、体力 4h），24h 之外丢掉，最多留 `IMPULSE_MAX` 条；
 *   **每条脉冲带 `role`** —— 换角色后互不串味（`impulsesOfRole()` 是唯一过滤口）。
 */

/* ══════════════════════════════════════════════════════════════════
 * 一、量程与常量（唯一定义处）
 * ══════════════════════════════════════════════════════════════════ */

/** 量程下限（= Rust `actor_unit` 的 `0.0`） */
export const NEEDS_MIN = 0;
/** 量程上限（= Rust `actor_unit` 的 `1.0`） */
export const NEEDS_MAX = 1;
/** 取整位数：只为"同一输入 ⇒ 逐字节相同"（不是精度声明） */
export const NEED_ROUND_DP = 3;

/** 情绪基线（0–1） */
export const MOOD_BASE = 0.55;
/** 体力对情绪的折算系数：`(energy - 0.60) × 这个数` */
export const MOOD_FROM_ENERGY = 0.45;
/** 体力基准点（= 昼夜曲线里"还不错"的一档） */
export const ENERGY_REFERENCE = 0.6;
/** 今日三件事每完成一件的情绪增量（上限 `DAILY_DONE_MAX × 它`） */
export const DAILY_DONE_MOOD = 0.04;
/** 三件事最多计入的件数 */
export const DAILY_DONE_MAX = 3;
/** 心情脉冲半衰期（毫秒，6 小时） */
export const MOOD_HALF_LIFE_MS = 6 * 3600 * 1000;
/** 体力脉冲半衰期（毫秒，4 小时） */
export const ENERGY_HALF_LIFE_MS = 4 * 3600 * 1000;
/** 脉冲保留时长（24 小时；更老的丢掉，免得表无限长） */
export const IMPULSE_TTL_MS = 24 * 3600 * 1000;
/** 脉冲条数上限（存储与内存都按这个裁） */
export const IMPULSE_MAX = 24;
/** 存储键（与 `wsm:v1:relation` 同一族；期 6 的存档汇总要认它） */
export const WS_NEEDS_KEY = "wsm:v1:needs";
/** 存储版本 */
export const NEEDS_STORE_V = 1;

/**
 * 昼夜体力曲线（**小时 → 0–1**，锚点之间线性插值）。
 *
 * 为什么是这些点：这是"一天里什么时候有精神"的常识形状（凌晨最低、上午最高、
 * 午后回落、晚上再降），用来当**基线**而不是"测量值" —— 表本身就是口径，改它 = 改玩法。
 */
export const CIRCADIAN_ENERGY: ReadonlyArray<readonly [number, number]> = [
  [0, 0.28],
  [3, 0.16],
  [6, 0.3],
  [7, 0.55],
  [9, 0.82],
  [12, 0.78],
  [14, 0.62],
  [17, 0.55],
  [19, 0.5],
  [21, 0.42],
  [23, 0.3],
];

/* ══════════════════════════════════════════════════════════════════
 * 二、纯数学
 * ══════════════════════════════════════════════════════════════════ */

/** 一对需求值（0–1；就是推给 `actors[名].mood/.energy` 的那两个数） */
export interface NeedPair {
  mood: number;
  energy: number;
}

/** 一条事件脉冲（事件发生那一刻的增量 + 发生时间） */
export interface NeedImpulse extends NeedPair {
  /** 发生时间（ms，本地时钟；用于按半衰期衰减） */
  at: number;
  /** 事件 id（排障/对账用；缺了就写 `""`，**不编一个 id**） */
  id: string;
  /**
   * 🔴 **这条脉冲属于哪个角色**（`display_name`，与 `actors` 同一套键）。
   *
   * 为什么必须有：事件是按角色订阅的（`useWorldEvents({ role: currentRoleName })`），
   * 而"当前对话角色"会随聊天对象切换。没有这一格的话，换人之后**上一个角色的脉冲**
   * （TTL 24h、半衰期 6h/4h）照样算进新角色推上去的 mood/energy ——
   * 那等于把"别人的心情"当成"这个角色的心情"推给 Rust。同族的 `wsRelation` 是按角色分行存的，
   * 这里按同一口径：**一个角色一份脉冲**，`impulsesOfRole()` 是唯一的过滤口。
   */
  role: string;
}

/** 夹到 0–1（含端点；`NaN` ⇒ 0，调用方负责判"数不出来"） */
export function clampNeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return NEEDS_MIN;
  return n < NEEDS_MIN ? NEEDS_MIN : n > NEEDS_MAX ? NEEDS_MAX : n;
}

/** 确定性取整（同一输入 ⇒ 同一串字节） */
export function roundNeed(v: number): number {
  const f = 10 ** NEED_ROUND_DP;
  return Math.round(clampNeed(v) * f) / f;
}

/**
 * **增量**取整：只取整、**不夹到 0–1**。
 *
 * 🔴 为什么必须有第二个函数（自检当场抓到的一个真 bug）：事件脉冲是**增量**，天然可为负
 * （`mood.low` 就是 −0.22）。第一版让脉冲也走 `roundNeed()` ⇒ 它内部先 `clampNeed()`
 * ⇒ 所有负增量被夹成 **0** ⇒ "心情低落"这条事件一点后果都没有，而**自检全绿**
 * （因为断言只看"脉冲 +1 条"，不看数值）。量表值走 `roundNeed`，增量走这个。
 */
export function roundDelta(v: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** NEED_ROUND_DP;
  return Math.round(n * f) / f;
}

/** 本地小时（0–23）；拿不到合法时间 ⇒ `null`（**不是** 0 点） */
export function localHourOf(nowMs: unknown): number | null {
  const n = Number(nowMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  const h = d.getHours();
  return Number.isFinite(h) ? h : null;
}

/** 昼夜体力（小时越界会取模救回来；非有限数 ⇒ `null`） */
export function circadianEnergy(hour: unknown): number | null {
  const h0 = Number(hour);
  if (!Number.isFinite(h0)) return null;
  const h = ((Math.trunc(h0) % 24) + 24) % 24;
  const pts = CIRCADIAN_ENERGY;
  if (h <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i += 1) {
    const [h1, v1] = pts[i]!;
    const [h0p, v0] = pts[i - 1]!;
    if (h <= h1) {
      const k = h1 === h0p ? 0 : (h - h0p) / (h1 - h0p);
      return v0 + (v1 - v0) * k;
    }
  }
  return pts[pts.length - 1]![1];
}

/** 半衰期衰减因子（`dtMs <= 0` ⇒ 1；半衰期非法 ⇒ 1，即"不衰减"而不是"清零"） */
export function decayFactor(dtMs: number, halfLifeMs: number): number {
  const dt = Number(dtMs);
  const hl = Number(halfLifeMs);
  if (!Number.isFinite(dt) || dt <= 0) return 1;
  if (!Number.isFinite(hl) || hl <= 0) return 1;
  return 0.5 ** (dt / hl);
}

/**
 * 把脉冲表按 `nowMs` 衰减到"现在"，并丢掉过期的。
 * **不改入参**；返回**时间升序**（与存储顺序一致 ⇒ 对拍稳定）。
 */
export function decayedImpulses(
  list: readonly NeedImpulse[] | null | undefined,
  nowMs: unknown
): NeedImpulse[] {
  const now = Number(nowMs);
  const out: NeedImpulse[] = [];
  if (!Array.isArray(list) || !Number.isFinite(now)) return out;
  for (const it of list) {
    const at = Number(it?.at);
    if (!Number.isFinite(at)) continue;
    const dt = now - at;
    if (dt > IMPULSE_TTL_MS) continue; // 过期
    const fm = decayFactor(dt, MOOD_HALF_LIFE_MS);
    const fe = decayFactor(dt, ENERGY_HALF_LIFE_MS);
    out.push({
      at,
      id: typeof it.id === "string" ? it.id : "",
      // 角色**原样带下去**（衰减不改归属；丢了它这条脉冲就会在过滤时被当成"没主的"而消失）
      role: typeof it.role === "string" ? it.role : "",
      mood: roundDelta(Number(it.mood) * fm),
      energy: roundDelta(Number(it.energy) * fe),
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、真实输入 → 判词（每一项都要能说清"用了/没用/为什么"）
 * ══════════════════════════════════════════════════════════════════ */

/** 天气输入（只取用得到的那几个字段；形状对齐 `wsWeather.WsWeatherState`） */
export interface NeedWeatherInput {
  /** 天气分类 key（`wsWeather` 的 `kind`：`clear` / `rain` / `snow` / `fog` / `thunder` …） */
  kind?: unknown;
  /** 气温（℃） */
  tempC?: unknown;
  /** 是否降级（没拿到真天气） */
  degraded?: unknown;
}

/** 天气 → 情绪增量 + 一句人读说明 */
export function weatherMoodDelta(wx: NeedWeatherInput | null | undefined): {
  delta: number;
  used: boolean;
  note: string;
} {
  if (!wx || typeof wx !== "object" || wx.degraded === true) {
    return { delta: 0, used: false, note: "天气不可用 ⇒ 这一项未参与" };
  }
  const kind = String(wx.kind || "").trim().toLowerCase();
  const temp = Number(wx.tempC);
  const parts: string[] = [];
  let delta = 0;
  const byKind: Record<string, [number, string]> = {
    rain: [-0.08, "下雨 −0.08"],
    snow: [-0.08, "下雪 −0.08"],
    fog: [-0.06, "有雾 −0.06"],
    thunder: [-0.05, "雷雨 −0.05"],
    clear: [0.04, "晴 +0.04"],
    cloudy: [0.04, "多云 +0.04"],
  };
  const hit = byKind[kind];
  if (hit) {
    delta += hit[0];
    parts.push(hit[1]);
  }
  if (Number.isFinite(temp)) {
    if (temp >= 32) {
      delta += -0.06;
      parts.push(`高温 ${temp}℃ −0.06`);
    } else if (temp <= 5) {
      delta += -0.05;
      parts.push(`低温 ${temp}℃ −0.05`);
    }
  }
  if (!parts.length) return { delta: 0, used: false, note: `天气(${kind || "未分类"})不参与修正` };
  return { delta, used: true, note: parts.join(" · ") };
}

/** 今日三件事完成数 → 情绪增量（`null` = 数不出来 ⇒ 不参与） */
export function dailyMoodDelta(done: unknown): { delta: number; used: boolean; note: string } {
  if (done === null || done === undefined || !Number.isFinite(Number(done))) {
    return { delta: 0, used: false, note: "今日三件事还没排 ⇒ 这一项未参与" };
  }
  const n = Math.max(0, Math.min(DAILY_DONE_MAX, Math.trunc(Number(done))));
  return {
    delta: DAILY_DONE_MOOD * n,
    used: true,
    note: `今日三件事 ${n}/${DAILY_DONE_MAX} +${roundNeed(DAILY_DONE_MOOD * n)}`,
  };
}

/** `computeNeeds` 的输入（全部可注入 ⇒ 纯函数） */
export interface NeedInputs {
  /** 本机时间（ms）—— **必须给**（拿不到就判"数不出来"） */
  nowMs?: unknown;
  /** 真实天气（`useWorldWeather().state`）；`null` = 没拿到 */
  weather?: NeedWeatherInput | null;
  /** 事件脉冲（已发生的事件带的增量） */
  impulses?: readonly NeedImpulse[] | null;
  /** 今日三件事完成数；`null` = 数不出来 */
  dailyDone?: unknown;
}

/** `computeNeeds` 的产物（判词三件套：`why` / `basis` / `missing`） */
export interface NeedResult {
  /** `false` = 数不出来（此时 `mood`/`energy` 必须是 `null`） */
  ok: boolean;
  mood: number | null;
  energy: number | null;
  /** 人读判词（含"数不出来"的原因） */
  why: string;
  /** 这次**用了**哪些真实输入 */
  basis: string[];
  /** 这次**缺**哪些输入（如实列出，不当 0 算） */
  missing: string[];
  /** 被 0–1 夹回去的次数（可数；>0 说明有输入把值顶出了量程） */
  clamped: number;
  /** 参与计算的未衰减脉冲条数 */
  impulses: number;
}

/**
 * 真实状态 → 心情 / 体力（**纯函数**；同一输入两次逐字节相同）。
 *
 * 判据（照计划验收③）：**本机时间拿不到 ⇒ `ok:false` + 判词「数不出来」**。
 * 其余输入缺一项就少参与一项，并写进 `missing` —— 不拿 0 冒充，也不假装算过。
 */
export function computeNeeds(input: NeedInputs = {}): NeedResult {
  const basis: string[] = [];
  const missing: string[] = [];
  const hour = localHourOf(input.nowMs);
  if (hour === null) {
    return {
      ok: false,
      mood: null,
      energy: null,
      why: "数不出来：拿不到本机时间（心情/体力的基线就是按小时算的）",
      basis,
      missing: ["本机时间"],
      clamped: 0,
      impulses: 0,
    };
  }
  const base = circadianEnergy(hour);
  if (base === null) {
    return {
      ok: false,
      mood: null,
      energy: null,
      why: `数不出来：${hour} 时算不出昼夜基线`,
      basis,
      missing: ["昼夜基线"],
      clamped: 0,
      impulses: 0,
    };
  }
  basis.push(`本机时间 ${hour} 时`);

  const wx = weatherMoodDelta(input.weather);
  if (wx.used) basis.push(`真实天气（${wx.note}）`);
  else missing.push(wx.note);

  const daily = dailyMoodDelta(input.dailyDone);
  if (daily.used) basis.push(daily.note);
  else missing.push(daily.note);

  const pulses = decayedImpulses(input.impulses, input.nowMs);
  const pMood = pulses.reduce((s, p) => s + p.mood, 0);
  const pEnergy = pulses.reduce((s, p) => s + p.energy, 0);
  if (pulses.length) {
    basis.push(`事件脉冲 ${pulses.length} 条（心情 ${roundDelta(pMood)} / 体力 ${roundDelta(pEnergy)}）`);
  } else {
    basis.push("事件脉冲 0 条（还没有事件把它推离基线）");
  }

  const rawEnergy = base + pEnergy;
  const rawMood = MOOD_BASE + (base - ENERGY_REFERENCE) * MOOD_FROM_ENERGY + wx.delta + daily.delta + pMood;
  const energy = roundNeed(rawEnergy);
  const mood = roundNeed(rawMood);
  // 夹取是**如实记账**：被顶出量程就记一笔（Rust 侧越界会被当"不知道"，见 actor_unit）
  const clamped = [rawEnergy, rawMood].filter((v) => v < NEEDS_MIN || v > NEEDS_MAX).length;

  const why =
    `推导值（非测量）：体力 ${energy} · 心情 ${mood}` +
    ` ← ${basis.join("；")}` +
    (missing.length ? `；未参与：${missing.join("；")}` : "") +
    (clamped ? `；⚠️ 有 ${clamped} 项被夹回 0–1` : "");
  return { ok: true, mood, energy, why, basis, missing, clamped, impulses: pulses.length };
}

/** 只取"能推给 Rust"的那两个数：`ok:false` ⇒ `null`（**绝不用 0.5 顶替**） */
export function needPairOf(res: NeedResult | null | undefined): NeedPair | null {
  if (!res || !res.ok || res.mood === null || res.energy === null) return null;
  return { mood: res.mood, energy: res.energy };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、事件 → 脉冲（事件表是唯一真源，这里只搬运）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 读一条事件带的 `effects`（Rust `events.rs::NeedEffect` 的序列化形状）。
 *
 * `null` = **这份数据没有**（老壳/老事件：字段缺失，或整条不是对象）——
 * 调用方据此判"不知道"，**不许**退回 0 当成"没有副作用"（那是两件事）。
 * `{mood:0, energy:0}` = 表里明写了"不改"。
 */
export function effectOfEvent(ev: unknown): NeedPair | null {
  if (!ev || typeof ev !== "object") return null;
  const raw = (ev as { effects?: unknown }).effects;
  if (!Array.isArray(raw)) return null;
  let mood = 0;
  let energy = 0;
  /** 真正读出来的**数的个数**（不是"表里有几条"）—— 用来区分"明写不改"与"读不出来" */
  let read = 0;
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const m = Number((e as { mood?: unknown }).mood);
    const n = Number((e as { energy?: unknown }).energy);
    if (Number.isFinite(m)) {
      mood += m;
      read += 1;
    }
    if (Number.isFinite(n)) {
      energy += n;
      read += 1;
    }
  }
  /* `[]`（真源明写"这类事件没有副作用"）⇒ `{0,0}`；**表里有东西却一个数都读不出来** ⇒ `null`。
     🔴 这两件事必须分开：`{0,0}` 是"明写不改"，`null` 是"这份数据读不出来"。
     早先这里对后者返回 `{0,0}` —— 那等于把脏数据当成"表里明写了不改"，属于**替数据编口径**。 */
  if (raw.length === 0) return { mood: 0, energy: 0 };
  if (!read) return null;
  // 增量本身也按量程口径记（Rust `validate()` 限制在 −1..=1；这里再挡一层，防脏数据）
  const clip = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
  return { mood: clip(mood), energy: clip(energy) };
}

/** 事件 id（`""` = 认不出来，**不编**） */
export function eventIdOf(ev: unknown): string {
  const id = (ev as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id.trim() : "";
}

/**
 * 把一条事件变成脉冲（**只改这一处**：页面里 0 处算术）。
 *
 * 返回**新数组**（不改入参）。这几种情况**不新增脉冲**（负数断言的那条路）：
 *   · 事件认不出（没有 id）；· `effects` 那份数据没有（`null`）；· 两个增量都是 0；· 时间非法。
 * 尾部按 `IMPULSE_MAX` 裁旧 → 表不会无限长。
 *
 * `role` = 这条脉冲算谁头上（**必填语义**：调用方给不出角色就别记，见 `impulsesOfRole`）。
 */
export function applyEventToImpulses(
  list: readonly NeedImpulse[] | null | undefined,
  ev: unknown,
  nowMs: unknown,
  role = ""
): NeedImpulse[] {
  const cur = Array.isArray(list) ? list.slice() : [];
  const at = Number(nowMs);
  const id = eventIdOf(ev);
  if (!id || !Number.isFinite(at)) return cur;
  const fx = effectOfEvent(ev);
  if (!fx) return cur;
  if (fx.mood === 0 && fx.energy === 0) return cur;
  cur.push({ at, id, role: typeof role === "string" ? role : "", mood: roundDelta(fx.mood), energy: roundDelta(fx.energy) });
  return cur.length > IMPULSE_MAX ? cur.slice(cur.length - IMPULSE_MAX) : cur;
}

/**
 * 🔴 **唯一**的"这条脉冲算谁头上"过滤口（页面与薄壳都调它，不许各写一份）。
 *
 * `role` 给空串 = 没有角色上下文 ⇒ 只取同样没标角色的那些（**不**趁机把所有人的都算进来）。
 */
export function impulsesOfRole(list: readonly NeedImpulse[] | null | undefined, role: string): NeedImpulse[] {
  const want = typeof role === "string" ? role : "";
  if (!Array.isArray(list)) return [];
  return list.filter((p) => (typeof p?.role === "string" ? p.role : "") === want);
}

/**
 * 内容比较（逐字段，不看引用也不看 JSON 键序）。
 *
 * 为什么需要它：脉冲表**满 `IMPULSE_MAX` 之后**，新事件会顶掉最旧的一条 ⇒
 * **长度不变**。旧的"长度没变就算没新增"判据会把这种事件判成"无事发生"：
 * 既不落盘、也不重推给 Rust（推上去的还是旧值）。这里按内容判，才不会漏。
 */
export function sameImpulses(a: readonly NeedImpulse[] | null | undefined, b: readonly NeedImpulse[] | null | undefined): boolean {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    const p = x[i];
    const q = y[i];
    if (!p || !q) return false;
    if (p.at !== q.at || p.id !== q.id || p.role !== q.role || p.mood !== q.mood || p.energy !== q.energy) return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════
 * 五、存储（坏数据一律退回空表，绝不抛 —— 与 `wsRelation` 同款）
 * ══════════════════════════════════════════════════════════════════ */

export interface NeedStore {
  v: number;
  impulses: NeedImpulse[];
}

/**
 * 消毒：任何形状都能进来（用户手改 / 旧版本 / 别的插件写的）。
 *
 * 🔴 两条"不编"：
 *   · **缺一半就算读不出来** —— 只有 mood 没有 energy 的记录**整条丢掉**，
 *     不给它补 `mood:0`（补 0 = 把它读成"心情极差"，那是替数据编了一个值）；
 *   · **没有角色的丢掉** —— 这条脉冲算谁头上不知道，留着就会被算到"当前对话角色"身上
 *     （= 把别人的心情当成他的）。本键是本片新引入的（`wsm:v1:needs` 随期 2 一起来），
 *     盘上没有"带角色的历史数据"要搬，所以直接丢比猜更诚实。
 */
export function sanitizeStore(raw: unknown): NeedStore {
  const impulses: NeedImpulse[] = [];
  const o = (raw || {}) as { impulses?: unknown };
  const list = Array.isArray(o.impulses) ? o.impulses : [];
  for (const it of list) {
    const at = Number((it as { at?: unknown } | null)?.at);
    const mood = Number((it as { mood?: unknown } | null)?.mood);
    const energy = Number((it as { energy?: unknown } | null)?.energy);
    const role = (it as { role?: unknown } | null)?.role;
    if (!Number.isFinite(at) || at <= 0) continue;
    if (!Number.isFinite(mood) || !Number.isFinite(energy)) continue;
    if (typeof role !== "string" || role === "") continue;
    impulses.push({
      at,
      id: typeof (it as { id?: unknown }).id === "string" ? (it as { id: string }).id : "",
      role,
      mood: roundDelta(mood),
      energy: roundDelta(energy),
    });
  }
  impulses.sort((a, b) => a.at - b.at);
  return { v: NEEDS_STORE_V, impulses: impulses.slice(-IMPULSE_MAX) };
}

/** 序列化（排序 + 定长小数 ⇒ 同一状态同一串字节） */
export function serializeStore(s: NeedStore): string {
  return JSON.stringify({ v: NEEDS_STORE_V, impulses: sanitizeStore(s).impulses });
}

/* ══════════════════════════════════════════════════════════════════
 * 六、接线用的薄壳（IO 只在这里）
 * ══════════════════════════════════════════════════════════════════ */

/** 只依赖这两个浏览器能力，便于自检注入替身 */
export interface NeedStoreIo {
  get: (k: string) => string | null;
  set: (k: string, v: string) => void;
}

function browserIo(): NeedStoreIo {
  return {
    get: (k) => {
      try {
        return globalThis.localStorage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        /* 写不进去就算了：最多这次刷新丢掉脉冲，不抛 */
      }
    },
  };
}

export interface UseWsNeedsOptions {
  /** 时间源（默认真本机时钟） */
  now?: () => number;
  /** 存储（默认 localStorage） */
  io?: NeedStoreIo;
  /**
   * 当前对话角色（`display_name`）。给**函数**是因为"当前角色"会随聊天对象变——
   * 每次 `applyEvent`/`compute` 现取一次，换人后立刻换一套脉冲（不用重开薄壳、不用手动 reload）。
   */
  role?: string | (() => string);
}

/**
 * 薄壳：读盘 → 应用事件 → 算值。
 *
 * 刻意**不 import vue**（本文件要在 node 里直接跑自检）：
 * 状态就是普通字段，页面自己决定要不要塞进 `ref`/`watch`。
 *
 * 🔴 **按角色隔离**：事件只记在**当前角色**头上，算值也只吃当前角色那份（`impulsesOfRole`）。
 * 盘上仍然一个键（`wsm:v1:needs`），靠每条脉冲自带的 `role` 分行 —— 与 `wsRelation` 同款。
 */
export function useWsNeeds(opts: UseWsNeedsOptions = {}) {
  const now = opts.now || (() => Date.now());
  const io = opts.io || browserIo();
  const roleOf = (): string => {
    const r = typeof opts.role === "function" ? opts.role() : opts.role;
    return typeof r === "string" ? r : "";
  };
  let impulses: NeedImpulse[] = read();

  function read(): NeedImpulse[] {
    const raw = io.get(WS_NEEDS_KEY);
    if (!raw) return [];
    try {
      return sanitizeStore(JSON.parse(raw)).impulses;
    } catch {
      return []; // 坏数据当没存过
    }
  }

  function save(): void {
    io.set(WS_NEEDS_KEY, serializeStore({ v: NEEDS_STORE_V, impulses }));
  }

  return {
    /** 当前脉冲表（**全部角色**的副本，排障/对账用；算值请走 `compute`，它按角色过滤） */
    impulses: () => impulses.slice(),
    /** 当前角色的那几条（只读副本） */
    impulsesOf(role?: string): NeedImpulse[] {
      return impulsesOfRole(impulses, role === undefined ? roleOf() : role);
    },
    /**
     * 事件 → 脉冲（`false` = 表**逐字段**没变，调用方据此决定要不要重推）。
     * ⚠️ 判据是**内容**而不是长度：表满 `IMPULSE_MAX` 后新事件会顶掉最旧的一条、长度不变，
     *    按长度判会把这种事件漏掉（不落盘也不重推）。
     */
    applyEvent(ev: unknown): boolean {
      const next = applyEventToImpulses(impulses, ev, now(), roleOf());
      if (sameImpulses(impulses, next)) return false;
      impulses = next;
      save();
      return true;
    },
    /** 算一次（每次都重新按 `now` 衰减 ⇒ 数值只跟"现在 + 这个角色 + 真实输入"有关） */
    compute(input: Omit<NeedInputs, "nowMs" | "impulses"> = {}): NeedResult {
      return computeNeeds({ ...input, nowMs: now(), impulses: impulsesOfRole(impulses, roleOf()) });
    },
    /** 重读盘（换页/换角色后对齐用） */
    reload(): void {
      impulses = read();
    },
    /** 清空（自检/排障用；页面没有入口）—— **全部角色**都清 */
    clear(): void {
      impulses = [];
      save();
    },
  };
}
