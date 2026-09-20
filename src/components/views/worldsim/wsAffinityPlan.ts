/**
 * wsAffinityPlan.ts —— 可玩性切片 A 的**因果层**：好感（数值）→ 行为 → 地图上看得见
 *
 * ## 它解决什么
 * 机主 2026-09-18 的诊断：「现在感觉整个 map 一点可玩性没有」——**世界是一堆并排的图层，
 * 不是一台会互相影响的机器**。这一步把已经落盘的好感（`wsRelation.ts`）**接进行为**：
 * 好感够高 ⇒ 这个角色**现在真的跑来找你**，地图上位置变了、地点名变了、来源如实标成 `affinity`。
 *
 * ## 纪律（写死在这里，免得以后漂）
 * 1. **纯函数**：不碰 localStorage / 不碰 DOM / 不引其他 composable（自检可脱网跑）；
 * 2. **如实**：只改"位置 + 地点名 + 来源"，**不伪造日程内容**；`posSource` 一定标成 `affinity`，
 *    让任何一处 UI 都能一眼看出"这是好感驱动，不是后端日程"；
 * 3. **不越权**：本模块**不写**任何存储（好感只由 `wsRelation` 写）；
 * 4. ⚠️ 已知语义边界：机主原话是「它**明天**的日程改去你喜欢的地方」，而"明天"需要
 *    **世界时间轴**（`BORROW-LIST.md` §7 的 P1，尚未做）。所以当前实现的是
 *    **「此刻它就来了」+ 日程数据里追加一条今日改道**（两处都留痕），
 *    **不是**真正的"改写明日日程"。这条差异必须一直写在文档与卡片里，不许含糊。
 */

/** 会主动来找你的门槛（与 `wsRelation.rankOf` 的档位口径对齐：≥70 = 亲近） */
export const VISIT_MIN = 70;
/** 熟络门槛（够高但还不会主动上门） */
export const WARM_MIN = 40;

export type AffinityTier = "close" | "warm" | "neutral" | "cold";

/** 好感夹紧到 0~100 的整数（与 `wsRelation` 同口径；这里独立实现以免模块间耦合） */
export function clampAffinity(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function tierOf(affinity: unknown): AffinityTier {
  const a = clampAffinity(affinity);
  if (a >= VISIT_MIN) return "close";
  if (a >= WARM_MIN) return "warm";
  if (a > 0) return "neutral";
  return "cold";
}

export interface VisitDecision {
  /** 会不会主动跑来（只有 close 才是 true） */
  come: boolean;
  /** 地图上显示的地点名（come=false 时为空串） */
  place: string;
  /** 给人看的一句话，**含数值**，便于验收（come=false 时也可为空） */
  note: string;
}

/**
 * 决策：好感 → 会不会来。
 * `name` 只用于文案（没有也不影响判定）。
 */
export function visitDecisionOf(affinity: unknown, name = ""): VisitDecision {
  const a = clampAffinity(affinity);
  const who = name || "对方";
  if (tierOf(a) === "close") {
    return { come: true, place: "在你身边", note: `${who}好感 ${a}：特地跑来找你` };
  }
  if (tierOf(a) === "warm") {
    return { come: false, place: "", note: `${who}好感 ${a}：还没到会主动来找你的程度（≥${VISIT_MIN} 才会）` };
  }
  return { come: false, place: "", note: "" };
}

/**
 * 宽松查好感：**名字对不上是常态**，不该让功能静默失效。
 *
 * 实测（2026-09-19）：日程里的角色叫 `钦灵`，而 LingChat 角色库里的显示名是 `诺一钦灵`
 * ⇒ 精确匹配拿到 0，好感因果**静默不生效**（地图上什么都没发生、也不报错，最难查的一类）。
 * 规则：先精确（归一化后），再双向包含；多个命中取**最大**好感。
 */
export function resolveAffinity(
  rows: ReadonlyArray<{ role?: unknown; affinity?: unknown }> | null | undefined,
  candidates: ReadonlyArray<string | null | undefined>
): number {
  if (!rows?.length || !candidates?.length) return 0;
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
  const cands = candidates.map(norm).filter(Boolean);
  if (!cands.length) return 0;
  let best = 0;
  for (const r of rows) {
    const role = norm(r?.role);
    if (!role) continue;
    if (cands.some((c) => c === role || c.includes(role) || role.includes(c))) {
      best = Math.max(best, clampAffinity(r?.affinity));
    }
  }
  return best;
}

/** 8 个相邻方向（先正交后对角）：站在玩家**旁边**而不是**身上**，避免两个头像叠在一起 */
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/** 字符串 → 稳定下标（同一个名字每次都落在同一侧，避免每一帧换位置） */
function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 站位：玩家所在格旁边的一格（按名字哈希选方向，越界往内收）。
 * 玩家位置未知（`me` 为空）时返回 null —— **不猜**。
 */
export function visitSpot(
  me: { gx: number; gy: number } | null,
  grid: number,
  seed: string
): { gx: number; gy: number } | null {
  if (!me || !Number.isFinite(me.gx) || !Number.isFinite(me.gy)) return null;
  const g = Math.max(2, Math.round(grid) || 28);
  const [dx, dy] = RING[hashOf(seed) % RING.length]!;
  const gx = Math.max(0, Math.min(g - 1, Math.round(me.gx) + dx));
  const gy = Math.max(0, Math.min(g - 1, Math.round(me.gy) + dy));
  return { gx, gy };
}

/** 本模块要处理的角色，只要这几个字段（结构化类型，方便自检里喂假数据） */
export interface AffinityActorLike {
  name: string;
  gx: number;
  gy: number;
  place: string;
  posSource: string;
}

export interface VisitRecord {
  name: string;
  affinity: number;
  note: string;
  from: { gx: number; gy: number };
  to: { gx: number; gy: number };
}

/**
 * 把"好感够高 ⇒ 现在就来"应用到角色列表上（**不改入参**，返回新对象）。
 *
 * · 玩家位置未知 ⇒ **什么都不做**（返回 `visited: []`），绝不瞎放位置；
 * · 已经是 `me`（玩家自己）的条目不处理；
 * · 返回的 `visited` 是给 UI 用的证据（谁来了、好感多少、从哪一格到哪一格）。
 */
export function applyAffinityVisit<T extends AffinityActorLike>(
  list: readonly T[],
  affinityOf: (name: string) => number,
  me: { gx: number; gy: number } | null,
  grid: number
): { list: T[]; visited: VisitRecord[] } {
  const visited: VisitRecord[] = [];
  if (!me || !list?.length) return { list: list ? [...list] : [], visited };
  const out = list.map((a) => {
    if (!a || a.posSource === "me") return a;
    const aff = clampAffinity(affinityOf(a.name));
    const d = visitDecisionOf(aff, a.name);
    if (!d.come) return a;
    const spot = visitSpot(me, grid, a.name);
    if (!spot) return a;
    visited.push({
      name: a.name,
      affinity: aff,
      note: d.note,
      from: { gx: a.gx, gy: a.gy },
      to: spot,
    });
    return { ...a, gx: spot.gx, gy: spot.gy, place: d.place, posSource: "affinity" };
  });
  return { list: out, visited };
}

/**
 * 日程层面的**留痕**：给好感够高的角色在 `timeline` 末尾追加一条"今日改道"。
 *
 * ⚠️ 只动**数据**（让日程界面/后续世界时间轴能读到），不改地图位置 —— 位置由
 * `applyAffinityVisit` 负责。两条都留痕，是为了"因果链每一环都能被看到"。
 */
export interface PlanRoleLike {
  name: string;
  timeline?: Array<Record<string, unknown>>;
}

export function applyAffinityToRoles<T extends PlanRoleLike>(
  roles: readonly T[],
  affinityOf: (name: string) => number,
  nowTime = ""
): { roles: T[]; changed: Array<{ name: string; affinity: number; time: string }> } {
  const changed: Array<{ name: string; affinity: number; time: string }> = [];
  const out = (roles || []).map((r) => {
    const aff = clampAffinity(affinityOf(r?.name || ""));
    if (tierOf(aff) !== "close") return r;
    const item = {
      name: r.name,
      time: nowTime || "今天",
      content: `临时改道：听说你在这儿（好感 ${aff}）`,
      kind: "affinity",
      kindZh: "好感改道",
    };
    changed.push({ name: r.name, affinity: aff, time: String(item.time) });
    return { ...r, timeline: [...(r.timeline || []), item] };
  });
  return { roles: out, changed };
}
