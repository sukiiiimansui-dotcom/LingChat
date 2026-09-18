/**
 * wsRelation.ts —— 「关系/好感」的**数值层**（可玩性切片 A 的第一步）
 *
 * ## 为什么需要它（机主 2026-09-18：「这个 map 一点可玩性没有」）
 * 参考清单 `BORROW-LIST.md` 的结论是：**我们缺的不是"再写一个系统"，而是"把已有的零件接起来"**。
 * 现在送礼物**只写了一句 setTimeout 式的 toast 和一条 localStorage 记账**（`wsGift.ts`），
 * 世界不会因为"你送过它东西"而改变 —— 所以玩家做什么都没有后果，自然不好玩。
 *
 * 这一层的职责**只有一件**：把"你和某个角色的关系"变成一个**落盘的数值**，
 * 让下游（日程生成、事件权重、面板显示）有东西可读。
 * **它不生成日程、也不发事件** —— 那是切片 A 的后续步骤，别把逻辑堆在这里。
 *
 * ## 设计（刻意保守）
 * - 存储：`localStorage["wsm:v1:relation"]`，**坏数据一律退回空表**（绝不抛）——与 `wsGift` 同一口径；
 * - 数值：`0~100` 的整数（`affinity`），**没有负数**（厌恶是另一个维度，现在不引入，免得过度设计）；
 * - 来源（`source`）逐笔记账：`gift` / `chat` / `outing` / `manual`，**便于以后调权重时能回溯**；
 * - `lastAt` 记录最近一次互动时间戳（ms）：日程那边要用"最近有没有人对我好"来判断；
 * - 纯函数与 IO 分离：`applyGift()` / `decayOf()` / `rankOf()` 都是纯函数（有自检），
 *   `useWsRelation()` 才是读写 localStorage 的那层。
 *
 * ## 明确不做（防止变成"又一个半成品系统"）
 * - 不做"好感度影响对话内容"（那要接 LingChat 的记忆/提示词，属另一张卡）；
 * - 不做衰减倒计时（`decayOf()` 只提供纯函数与建议值，**要不要用由调用方决定**）。
 */

/** 一条关系记录 */
export interface WsRelationRow {
  /** 角色名（与 `schedule` / `gift` 里用的是同一个名字） */
  role: string;
  /** 好感 0~100 的整数 */
  affinity: number;
  /** 互动次数（送礼/聊天/约出门各算一次） */
  times: number;
  /** 最近一次互动时间戳（ms） */
  lastAt: number;
  /** 各来源的累计贡献（调权重时能回溯，别只留一个总数） */
  by: Partial<Record<WsRelationSource, number>>;
}

export type WsRelationSource = "gift" | "chat" | "outing" | "manual";

export interface WsRelationStore {
  v: 1;
  rows: WsRelationRow[];
}

export const WS_RELATION_KEY = "wsm:v1:relation";
export const RELATION_STORE_V = 1;
/** 好感上下限（上限刻意留 100：面板要显示百分比） */
export const AFFINITY_MIN = 0;
export const AFFINITY_MAX = 100;
/** 各来源的默认权重（**故意写在一处**，以后调平衡只改这张表） */
export const SOURCE_WEIGHT: Record<WsRelationSource, number> = {
  gift: 6,
  chat: 2,
  outing: 10,
  manual: 0,
};
/** 一天没互动掉多少（`decayOf()` 用；**调用方决定要不要用**） */
export const DECAY_PER_DAY = 1;

/** 空表 */
export function emptyStore(): WsRelationStore {
  return { v: RELATION_STORE_V, rows: [] };
}

/** 读出来的东西可能是任何形状（用户手改、旧版本、别的插件写的）→ 一律消毒 */
export function sanitizeStore(raw: unknown): WsRelationStore {
  const o = (raw || {}) as { rows?: unknown };
  const rows: WsRelationRow[] = [];
  if (Array.isArray(o.rows)) {
    for (const r of o.rows) {
      const row = r as Partial<WsRelationRow>;
      const role = String(row?.role ?? "").trim();
      if (!role) continue;
      const affinity = clampAffinity(row?.affinity);
      rows.push({
        role,
        affinity,
        times: Math.max(0, Math.trunc(Number(row?.times) || 0)),
        lastAt: Math.max(0, Math.trunc(Number(row?.lastAt) || 0)),
        by: sanitizeBy(row?.by),
      });
    }
  }
  return { v: RELATION_STORE_V, rows: rows.slice(0, 64) };
}

function sanitizeBy(raw: unknown): Partial<Record<WsRelationSource, number>> {
  const out: Partial<Record<WsRelationSource, number>> = {};
  if (raw && typeof raw === "object") {
    for (const k of ["gift", "chat", "outing", "manual"] as const) {
      const n = Math.trunc(Number((raw as Record<string, unknown>)[k]) || 0);
      if (n) out[k] = n;
    }
  }
  return out;
}

export function clampAffinity(v: unknown): number {
  const n = Math.trunc(Number(v) || 0);
  return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, n));
}

/** 找一行（没有就造一个空行，**不写入存储** —— 纯函数不许有副作用） */
export function rowOf(store: WsRelationStore, role: string): WsRelationRow {
  const hit = store.rows.find((r) => r.role === role);
  return hit || { role, affinity: 0, times: 0, lastAt: 0, by: {} };
}

/**
 * 记一次互动 → 返回**新的 store**（纯函数）。
 *
 * @param source 来源权重见 `SOURCE_WEIGHT`；`manual` 权重 0（给"手动改数值"留的口子）
 * @param delta  显式增量；不传就用来源默认权重（送礼 +6 / 聊天 +2 / 约出门 +10）
 * @param nowMs  时间戳（测试要能注入，**不要在里面读 Date.now()**）
 */
export function applyInteraction(
  store: WsRelationStore,
  role: string,
  source: WsRelationSource,
  nowMs: number,
  delta?: number
): { store: WsRelationStore; row: WsRelationRow } {
  const name = String(role || "").trim();
  if (!name) return { store, row: rowOf(store, "") };
  const step = Math.trunc(Number(delta ?? SOURCE_WEIGHT[source] ?? 0) || 0);
  const before = rowOf(store, name);
  const next: WsRelationRow = {
    role: name,
    affinity: clampAffinity(before.affinity + step),
    times: before.times + 1,
    lastAt: Math.max(0, Math.trunc(nowMs) || 0),
    by: { ...before.by, [source]: (before.by[source] || 0) + step },
  };
  const rows = store.rows.filter((r) => r.role !== name).concat(next);
  // 排序：好感高的在前（面板与小地图列表都直接用这个顺序）
  rows.sort((a, b) => b.affinity - a.affinity || b.lastAt - a.lastAt);
  return { store: { v: RELATION_STORE_V, rows }, row: next };
}

/** 送礼专用（语义化包装，调用方读起来清楚） */
export function applyGift(store: WsRelationStore, role: string, nowMs: number, delta?: number) {
  return applyInteraction(store, role, "gift", nowMs, delta);
}

/**
 * 距上次互动 `nowMs` 后**建议**扣掉多少（纯函数）。
 * ⚠️ **调用方决定要不要用**：我们不自动跑定时器（那会变成"又一个后台系统"）。
 */
export function decayOf(row: WsRelationRow, nowMs: number, perDay = DECAY_PER_DAY): number {
  if (!row.lastAt) return 0;
  const days = Math.floor(Math.max(0, nowMs - row.lastAt) / 86_400_000);
  return Math.max(0, days) * Math.max(0, perDay);
}

/** 好感 → 档位（面板显示用；文案由调用方决定，这里只给稳定的档位 id） */
export function rankOf(affinity: unknown): "陌生" | "认识" | "熟悉" | "亲近" | "挚友" {
  const a = clampAffinity(affinity);
  if (a >= 80) return "挚友";
  if (a >= 55) return "亲近";
  if (a >= 30) return "熟悉";
  if (a >= 10) return "认识";
  return "陌生";
}

/* ── IO 层（浏览器里才有 localStorage；读写都吞异常）────────────────────── */

function readStore(): WsRelationStore {
  try {
    const raw = localStorage.getItem(WS_RELATION_KEY);
    if (!raw) return emptyStore();
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return emptyStore(); // 坏 JSON / 隐私模式 → 空表，不抛
  }
}

function writeStore(s: WsRelationStore): void {
  try {
    localStorage.setItem(WS_RELATION_KEY, JSON.stringify(s));
  } catch {
    /* 写不进去不影响本次会话 */
  }
}

/** 模块级单例（与 `wsGift` 同一套做法：多个组件读同一份，改完立刻可见） */
let cache: WsRelationStore | null = null;

export function useWsRelation() {
  if (!cache) cache = readStore();
  const store = cache;

  function record(role: string, source: WsRelationSource, delta?: number): WsRelationRow {
    const res = applyInteraction(store, role, source, Date.now(), delta);
    cache = res.store;
    writeStore(res.store);
    // 原地替换 rows，保持引用稳定（调用方可能已经拿着 store 了）
    store.rows = res.store.rows;
    return res.row;
  }

  return {
    store,
    /** 送礼 +6（权重在 `SOURCE_WEIGHT` 里，一处改全局生效） */
    gift: (role: string, delta?: number) => record(role, "gift", delta),
    chat: (role: string) => record(role, "chat"),
    outing: (role: string) => record(role, "outing"),
    affinityOf: (role: string) => rowOf(store, role).affinity,
    rankOf: (role: string) => rankOf(rowOf(store, role).affinity),
    /** 测试/重置用 */
    _reload: () => {
      cache = readStore();
      store.rows = cache.rows;
    },
  };
}
