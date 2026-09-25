/**
 * wsDaily.ts —— **日常循环的纯逻辑**（机主 2026-09-25：「继续开发（好看，稳定，可玩）」+ 动森式玩法 M1-1）
 *
 * 这一份只做两件事，**都不碰 UI、不碰网络**（可自检、可确定性复现）：
 *  ① `pickHome()` —— 「**我的家**」：从**已有的片区名**里挑一个当锚点（就近、确定性；没有名字就如实说没有，绝不编）；
 *  ② `planDaily()` —— 「**今日三件事**」：按**日期**生成 3 条可完成的小事，**跨天自动重置**（这是"过日子"的骨架）。
 *
 * 三态纪律（本仓反复强调）：**取不到就写 null / why，不写 0、不编**。
 * 确定性纪律：同一输入（同一天、同一组居民/设施）**逐字节同结果** —— 否则刷新一次任务就变，玩家会觉得世界在抖。
 */

/** 片区名点（来自 `placesbundle`：真实 OSM 的 `place=neighbourhood|quarter|suburb`） */
export interface PlacePoint {
  /** 名字（**必须有**；没名字的点不该被传进来） */
  name: string;
  lng: number;
  lat: number;
  /** 类型：小区/街区/区片 */
  kind?: string | null;
}

export interface PickHomeOpts {
  /** 当前位置（通常是地图中心） */
  center: { lng: number; lat: number } | null;
  /** 只要这个半径内的（米）；默认 3000 */
  maxM?: number;
  /** 偏好类型（按顺序优先）；默认 `["neighbourhood","quarter","suburb"]`（越"小范围"越像家） */
  preferKinds?: string[];
}

export interface PickHomeResult {
  home: PlacePoint | null;
  /** 人读口径（HUD/日志直接用） */
  why: string;
  /** 候选数（视野/半径内有几个有名片区）；**没有 center 时是 null（数不出来）** */
  candidates: number | null;
  /** 选中的那个离家多远（米）；选不到时 null */
  distM: number | null;
}

const R = 6371008.8;
const D2R = Math.PI / 180;

/** 两点距离（米，haversine）——与 `blocks.py`/前端 `wsGeo` 同式，纯函数 */
export function distM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLng = (b.lng - a.lng) * D2R;
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 挑「我的家」：**离中心最近**的有名片区；同距离时按名字稳定排序（确定性）。
 * 找不到（半径内没有有名点 / 没有 center）⇒ `home:null` + `why` 写明原因（**不编一个家**）。
 */
export function pickHome(places: readonly PlacePoint[], opts: PickHomeOpts): PickHomeResult {
  const maxM = Number.isFinite(opts.maxM as number) ? (opts.maxM as number) : 3000;
  const prefer = opts.preferKinds || ["neighbourhood", "quarter", "suburb"];
  const valid = (places || []).filter((p) => p && typeof p.name === "string" && p.name.trim()
    && Number.isFinite(p.lng) && Number.isFinite(p.lat));
  if (!opts.center || !Number.isFinite(opts.center.lng) || !Number.isFinite(opts.center.lat)) {
    return { home: null, why: "没有地图中心 ⇒ 数不出来（不能瞎挑一个家）", candidates: null, distM: null };
  }
  const c = opts.center;
  const inRange = valid
    .map((p) => ({ p, d: distM(c, p) }))
    .filter((x) => x.d <= maxM);
  if (inRange.length === 0) {
    return { home: null, why: `半径 ${maxM}m 内没有**有名字**的片区（有名点共 ${valid.length} 个）⇒ 不编一个家`,
             candidates: 0, distM: null };
  }
  const rank = (k: string | null | undefined) => {
    const i = prefer.indexOf(String(k || ""));
    return i < 0 ? prefer.length : i;
  };
  inRange.sort((a, b) =>
    (rank(a.p.kind) - rank(b.p.kind)) || (a.d - b.d) || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0));
  const best = inRange[0];
  return {
    home: best.p,
    why: `家 = ${best.p.name}（${best.p.kind || "片区"} · 距中心 ${Math.round(best.d)}m · 半径内有名点 ${inRange.length} 个）`,
    candidates: inRange.length,
    distM: best.d,
  };
}

/** 居民（对话对象）——只取每日任务要用的字段 */
export interface Resident { id: string; name: string; }

/** 设施/地点（每日任务里的"去一次 X"用） */
export interface Spot { id: string; name: string; kind?: string | null; }

export interface DailyTask {
  id: string;
  /** 显示文本（含**真实名字**，不编） */
  text: string;
  /** 任务种类：打招呼 / 送礼 / 去一个地方 */
  kind: "greet" | "gift" | "visit";
  /** 指向谁/哪儿（点开可用） */
  targetId: string | null;
  done: boolean;
}

export interface DailyState {
  /** 本地日期键 `YYYY-MM-DD`（跨天重置的唯一依据） */
  day: string;
  tasks: DailyTask[];
}

export interface PlanDailyOpts {
  /** 今天（毫秒）；默认 `Date.now()` —— 传入是为了可测 |
   *  ⚠️ 用**本地时区**的日期，不用 UTC（否则东八区半夜会提前换天） */
  nowMs?: number;
  /** 上次的状态（用于：同一天则保留完成状态；跨天则重置） */
  prev?: DailyState | null;
  residents?: readonly Resident[];
  spots?: readonly Spot[];
  /** 家的名字（有就优先"在家附近"这类任务） */
  homeName?: string | null;
}

/** 本地日期键（**不用 toISOString**：那是 UTC，东八区凌晨会算错天） */
export function dayKeyOf(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从字符串取一个稳定的 32 位散列（**同名同序** ⇒ 每天的任务不会乱跳） */
export function dayHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/**
 * 生成「今日三件事」。
 * 规则（**确定性**：同一天 + 同一组输入 ⇒ 同一份任务）：
 *  · 第 1 件：**跟一位居民打招呼**（没有居民 ⇒ 如实退回"看看附近有什么"）
 *  · 第 2 件：**给一位居民送样东西**（同上）
 *  · 第 3 件：**去一个地方**（优先"家"；没有家就取一个设施/地点）
 * 选谁/选哪儿：用 `dayHash(day + kind + 候选 id)` 取模 ⇒ **每天换人换地方，但当天固定**。
 * **跨天**：`prev.day !== 今天` ⇒ 全部重置为未完成（并保留新任务）。
 * 取不到的项：**如实写进 `missing`**（不写 0 冒充）。
 */
export function planDaily(opts: PlanDailyOpts): { state: DailyState; missing: string[]; why: string } {
  const now = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const day = dayKeyOf(now);
  const residents = (opts.residents || []).filter((r) => r && r.id && r.name);
  const spots = (opts.spots || []).filter((s) => s && s.id && s.name);
  const missing: string[] = [];
  if (residents.length === 0) missing.push("没有居民（角色）⇒ 前两件只能退成'走走看看'");
  if (spots.length === 0 && !opts.homeName) missing.push("没有地点/家 ⇒ 第三件只能退成'随便逛逛'");

  const pickOf = <T extends { id: string }>(arr: readonly T[], kind: string): T | null =>
    arr.length ? arr[dayHash(day + "|" + kind) % arr.length] : null;

  const r1 = pickOf(residents, "greet");
  const r2 = pickOf(residents, "gift");
  const s1 = pickOf(spots, "visit");

  const tasks: DailyTask[] = [
    r1
      ? { id: `greet:${r1.id}`, kind: "greet", targetId: r1.id, done: false, text: `跟 ${r1.name} 打个招呼` }
      : { id: "greet:none", kind: "greet", targetId: null, done: false, text: "在附近走走，看看有什么" },
    r2
      ? { id: `gift:${r2.id}`, kind: "gift", targetId: r2.id, done: false, text: `送一样东西给 ${r2.name}` }
      : { id: "gift:none", kind: "gift", targetId: null, done: false, text: "找一样喜欢的东西带上" },
    (opts.homeName || s1)
      ? { id: `visit:${opts.homeName || s1!.id}`, kind: "visit", targetId: s1 ? s1.id : null, done: false,
          text: opts.homeName ? `回一趟 ${opts.homeName}` : `去一次 ${s1!.name}` }
      : { id: "visit:none", kind: "visit", targetId: null, done: false, text: "随便逛逛" },
  ];

  /* 同一天 ⇒ 继承完成状态（按 id 对齐；新任务从"未完成"开始） */
  const prev = opts.prev;
  if (prev && prev.day === day) {
    const doneMap = new Map(prev.tasks.map((t) => [t.id, t.done]));
    for (const t of tasks) if (doneMap.get(t.id) === true) t.done = true;
  }
  const doneN = tasks.filter((t) => t.done).length;
  return {
    state: { day, tasks },
    missing,
    why: `今日三件事（${day}）：完成 ${doneN}/3`
      + (prev && prev.day !== day ? ` · **已跨天重置**（上次 ${prev.day}）` : "")
      + (missing.length ? ` · 缺件：${missing.join("；")}` : ""),
  };
}

/** 勾选/取消一件（返回新状态；不改入参） */
export function toggleTask(state: DailyState, taskId: string, done?: boolean): DailyState {
  const tasks = state.tasks.map((t) => (t.id === taskId ? { ...t, done: done === undefined ? !t.done : !!done } : t));
  return { day: state.day, tasks };
}
