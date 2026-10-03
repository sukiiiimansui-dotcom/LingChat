// 「世界模拟」→ Rust `MapRuntime` 的**状态回推**（P3-3 的接线点）。
//
// ── 为什么需要这个文件（这是整条链上最容易漏的一环）────────────────────────
// Rust 侧的 `world_map/state.rs` 是**被动**的：它只提供一个 `world_map_update_runtime(patch)`
// 让人把「现在在哪个区、谁站在哪、我离他多远」推上来。而在这次接线之前，全仓**只有
// `useWorldTrips.ts` 在推**（推移动中的角色位置）—— 也就是说：
//   · `MapRuntime.scene` 一直是空的 → `world_sim_enabled()` 恒为 false
//     → `producer.rs` 里的位置指令剥离器**永不启用**（AI 说的 `⟦wm:…⟧` 会漏进正文）
//   · 注入摘要 `injection_for()` 恒返回空串 → 角色根本不知道自己在哪
// 所以凡「进到小区图 / 人物名单变化 / 离开世界模拟」都必须推一次。
//
// ── 契约（数据形状以 Rust 侧为准，改之前先读 `src-tauri/src/world_map/summary.rs`
//    头部的「数据契约」注释）────────────────────────────────────────────────
// ```jsonc
// {
//   "scene":   {"area": "广州市·越秀区·东山口", "place": "便利店", "adcode": "440104"},
//   "me":      {"lat": 23.13, "lng": 113.29, "source": "gps", "area": "广州市·越秀区",
//               "gx": 3.5, "gy": 4.0},
//   "actors":  {"小满": {"facility": "便利店", "type": "commercial", "x": 3, "y": 4,
//                        "since": "19:20", "mood": 0.42, "energy": 0.31}},
//   "facilities": [{"name": "咖啡馆", "type": "commercial", "grid": [6, 7]}],
//   "cell_m": 30
// }
// ```
// 三个必须记住的口径：
//   ① `actors` 的**键必须是角色的 `display_name`**（= `settings.yml` 的 `ai_name`），
//      不是 roleId、不是文件夹名 —— Rust 侧 `role_manager.rs` 是拿说话人的 display_name
//      去查的，键不对只会少掉「·便利店里」那一截（场景行还在，所以很难发现）。
//   ② 坐标 `x`/`y` 就是小区图的**格点坐标**（与 `WorldSim.vue` 的 `WS_GRID=28` 同一套），
//      Rust 的 `summary::cell_xy` 认 `x`/`y` 也认 `gx`/`gy`。
//   ③ **退出世界模拟必须推 `{scene: null}`**：注入的开关就是「有没有 scene」，
//      不退的话会一直带着上次的地图上下文跟模型说话。
//
// ── 测试性 ────────────────────────────────────────────────────────────────
// `buildPatch()` 是**纯函数**（不 import vue、不调 invoke），
// 所以能在 node 里直接跑断言（见 `~/rikka/Dsh-SYuki/world_map/frontend_selftest_worldsim_p1.mjs`）。

import { invoke } from "@tauri-apps/api/core";
import type { MapActor } from "./wsActors";

/* ══════════════════════════════════════════════════════════════════
 * 一、纯逻辑：把界面状态拼成 patch
 * ══════════════════════════════════════════════════════════════════ */

/** 角色在 runtime 里的位置记录（键是角色名，值是它） */
export interface RuntimeActorRecord {
  /** 所在地点/设施名（注入里「你在：…·便利店里」的那一截） */
  facility?: string;
  /** 设施类型（`commercial` / `transport` …），有的地方会拿它当兜底 */
  type?: string;
  /** 格点坐标 */
  x?: number;
  y?: number;
  /** 经纬度（有就带上，Rust 侧算距离优先用经纬度） */
  lng?: number;
  lat?: number;
  /** 什么时候到这儿的（`"19:20"` 这种展示用字符串） */
  since?: string;
  /**
   * 心情 / 体力（**0–1，含端点**）—— 期 2「因果通电」。
   *
   * 契约真源 = `src-tauri/src/world_map/event_cmd.rs` 头部的字段映射表：
   * `mood ← actors[role].mood`、`energy ← actors[role].energy`（别名 `stamina`），
   * **须落在 0–1**；读它的地方是 `events.rs::weight_for` 的权重修正 ④⑤
   * （心情 < 0.35 ⇒ 情绪类 ×2.2；体力 < 0.30 ⇒ 健康 ×1.6 / 工作学习 ×0.6）。
   * 取不到就**不写这两个键**（Rust 侧得到 `None` = "不知道"，与"0.0 = 很累"是两件事）。
   */
  mood?: number;
  energy?: number;
}

export interface RuntimePatchInput {
  /** 行政区链路，如 `"广州市·越秀区·东山口"` */
  area?: string;
  /** 场景地点名（小区名/地点名），进注入的 `scene.place` */
  place?: string;
  /** 区县 adcode（有就带，便于后端识别层级） */
  adcode?: string;
  /** 地图上的人（含玩家） */
  actors?: MapActor[];
  /** 玩家自己（`actors` 里 `isMe` 的那位）；不传就从 actors 里找 */
  me?: MapActor | null;
  /** 玩家位置来源（`gps` / `ip` / `manual` …）—— 注入里会如实标注 */
  meSource?: string;
  /** 当前正在说话的角色名（用于 `get_my_location` / `move_to` 知道「我是谁」） */
  currentRole?: string;
  /** 地图数据里的设施清单（`{name, type, grid:[x,y]}` 或带 `x`/`y`） */
  facilities?: unknown[];
  /** 一个格子等于多少米（Rust 侧兜底 30） */
  cellM?: number;
  /**
   * 心情 / 体力：**角色名 → 两个 0–1 的数**（期 2）。
   *
   * 只给**真有这两项的那个角色**（当前对话角色）—— 别人的数值我们没有任何真实输入，
   * 编一套出来等于"给所有人写同一个数"（本仓铁律：数不出来就写数不出来）。
   * 键名与 `actors` 同一套（= 角色的 `display_name`，见文件头契约 ①）。
   */
  needs?: Record<string, { mood?: number; energy?: number }> | null;
}

/** 非空字符串才算数（前端常把没值的字段写成 `''`） */
function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}

/** 有限数字才算数（`NaN` / `Infinity` / `null` 一律丢掉，别让 JSON 里出现 null） */
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 一个 `MapActor` → runtime 的 actors 记录。
 * 返回 `undefined` = 这个人没有任何可用信息，不必占位（省得把空对象堆进去）。
 */
export function actorRecordOf(a: MapActor): RuntimeActorRecord | undefined {
  const name = str(a?.name);
  if (!name) return undefined;
  const rec: RuntimeActorRecord = {};
  const facility = str(a.place);
  if (facility) rec.facility = facility;
  const type = str((a as { placeType?: unknown }).placeType);
  if (type) rec.type = type;
  const x = num(a.gx);
  const y = num(a.gy);
  if (x !== undefined && y !== undefined) {
    rec.x = x;
    rec.y = y;
  }
  // 位置来源要如实带上：只有真·runtime / 日程推出来的位置才值得让 AI 知道，
  // 本地散点（scatter）是**画给你看的**，推上去反而会让模型以为那是真的。
  if (a.posSource === "runtime" || a.posSource === "schedule") {
    const since = str(a.nowText);
    if (since) rec.since = since;
  }
  return Object.keys(rec).length ? rec : undefined;
}

/**
 * 组装 `world_map_update_runtime` 的 patch。**纯函数**。
 *
 * 只放「有值」的键：`MapRuntime` 是字段级合并，塞 `undefined` 会把上一次的值抹掉。
 */
export function buildPatch(input: RuntimePatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const area = str(input.area);
  const place = str(input.place);
  const adcode = str(input.adcode);
  const scene: Record<string, unknown> = {};
  if (area) scene.area = area;
  if (place) scene.place = place;
  if (adcode) scene.adcode = adcode;
  // 有 area 才算「有场景」——`world_sim_enabled()` 的判据就是 scene 在不在
  if (area) patch.scene = scene;

  const actors: Record<string, RuntimeActorRecord> = {};
  for (const a of input.actors || []) {
    const name = str(a?.name);
    if (!name || name === "——") continue;
    const rec = actorRecordOf(a);
    if (rec) actors[name] = rec;
  }
  /* 期 2：心情/体力按**角色名**贴到已存在的那条记录上。
     三条刻意的取舍（都是为了"别造数据"）：
       ① 只贴给**已经在 `actors` 里的人** —— 凭空插入一条只有 mood 的记录，
          Rust 那边会当成"有这么个角色站在那儿"，而我们并不知道他在哪；
       ② 只认 **0–1 的有限数**（与 `event_cmd.rs::actor_unit` 的判据逐字对齐）——
          越界/NaN 一律**不写这个键**（写了也会被 Rust 当"不知道"，但让 JSON 说谎更糟）；
       ③ 一个键都不写就不塞 `needs` 对象（`buildPatch` 的"只放有值的键"口径）。 */
  const needs = input.needs;
  if (needs && typeof needs === "object") {
    for (const [name, pair] of Object.entries(needs)) {
      const rec = actors[name];
      if (!rec || !pair) continue;
      const mood = num(pair.mood);
      const energy = num(pair.energy);
      if (mood !== undefined && mood >= 0 && mood <= 1) rec.mood = mood;
      if (energy !== undefined && energy >= 0 && energy <= 1) rec.energy = energy;
    }
  }
  if (Object.keys(actors).length) patch.actors = actors;

  const me = input.me ?? (input.actors || []).find((a) => a?.isMe) ?? null;
  if (me) {
    const m: Record<string, unknown> = {};
    const gx = num(me.gx);
    const gy = num(me.gy);
    if (gx !== undefined && gy !== undefined) {
      m.gx = gx;
      m.gy = gy;
    }
    const src = str(input.meSource);
    if (src) m.source = src;
    if (area) m.area = area;
    if (Object.keys(m).length) patch.me = m;
  }

  const role = str(input.currentRole);
  if (role) patch.current_role = role;

  if (Array.isArray(input.facilities) && input.facilities.length) {
    patch.facilities = input.facilities;
  }
  const cell = num(input.cellM);
  if (cell !== undefined && cell > 0) patch.cell_m = cell;

  return patch;
}

/* ══════════════════════════════════════════════════════════════════
 * 二、副作用：真正 invoke（在浏览器预览里静默跳过）
 * ══════════════════════════════════════════════════════════════════ */

/** 只有在真壳（Tauri）里才发命令；web 预览的 mock 对 world_map_* 一律返回 undefined */
function inShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 回推结果：`changed` 是后端真正改掉的字段名（便于排障） */
export interface PushResult {
  ok: boolean;
  changed?: string[];
  error?: string;
}

/** 推一个 patch 上去。**空 patch 直接返回**（不打扰后端，也不产生无意义日志）。 */
export async function pushPatch(patch: Record<string, unknown>): Promise<PushResult> {
  if (!patch || Object.keys(patch).length === 0) return { ok: true, changed: [] };
  if (!inShell()) return { ok: true, changed: [] };
  try {
    const r = await invoke<{ ok?: boolean; changed?: string[] }>("world_map_update_runtime", {
      patch,
    });
    return { ok: r?.ok !== false, changed: r?.changed || [] };
  } catch (e) {
    // 推状态失败**绝不能打断界面**（地图照常用，只是 AI 那边少一段上下文）
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 便捷：一步到位组 patch 并推上去 */
export async function pushRuntime(input: RuntimePatchInput): Promise<PushResult> {
  return pushPatch(buildPatch(input));
}

/**
 * 退出世界模拟：**必须**调这个。
 *
 * ⚠️ 清空要用 **`null`**，不能用空对象 —— `state.rs::apply_patch` 的语义是：
 *   · `scene: null` / `me: null` / `actors: null` / `facilities: null` / `current_role: null`
 *     → **清空**该字段
 *   · `actors: {}` → 字段级合并时空对象**什么都不做**（不是清空！）
 * 这一条很容易写错，而且写错了不报错、只是「上次的地图上下文一直挂着」。
 */
export async function clearRuntime(): Promise<PushResult> {
  return pushPatch({
    scene: null,
    actors: null,
    me: null,
    current_role: null,
    facilities: null,
  });
}
