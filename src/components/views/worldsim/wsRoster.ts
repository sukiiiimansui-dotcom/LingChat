// 「世界模拟」T4-3：**角色名单的浏览器兜底**（+ 纯函数），让"只有 LingChat 角色带头像"这条
// 在浏览器里也能被看到。
//
// ## 为什么需要这个文件（真问题，不是造数据）
// 卡片第 2 条：「只有 LingChat 角色列表里的角色显示头像，路人保持圆点（视觉区分）」。
// 要验这一条，**地图上必须同时有角色与路人**。而实测（2026-09-18）：
//   · 真壳通路 `characterGetAll()`（`list_characters` 命令）→ `useWsActors` 拿到真名单 ✅
//   · 浏览器通路 `loadWorldCharacters()` 的兜底 URL 是 `/api/schedule/chars`
//     —— **8791（Rust 调试服务）上没有这条路由**（实测 404），只有 `/api/schedule`。
//     ⇒ 浏览器里角色名单恒为空 ⇒ 地图上只有玩家一个人 ⇒ 本卡两条都**看不到**。
//
// 这个文件**不改** `useWorldMapBindings.ts`（不是本卡的文件），而是：
//   ① 给 `WsAvatarLayer` 一个**只在"一个角色都没有"时**才生效的兜底名单；
//   ② 数据源仍是**本机真实服务**的 `/api/schedule`（与真壳 `world_map_schedule` 同形，
//      里面本来就有 `characters`）——**不是伪造的角色**，姓名/目录都来自真实数据；
//   ③ `posSource` 如实标成 `scatter`（"本地散开（暂无位置数据）"），
//      所以界面上不会假装他们站在某个真实设施里。
//
// 交回：真正该修的是 `useWorldMapBindings.loadWorldCharacters()` 的浏览器兜底 URL
//   （`/api/schedule/chars` → `/api/schedule` 的 `characters` 字段）。
//   那一处修好之后，本文件的兜底会**自动不再触发**（有角色就不兜底），可以整块删掉。

import { onBeforeUnmount, ref, type Ref } from "vue";
import worldMapApi, { isTauriRuntime } from "@/api/services/worldMap";
import type { MapActor } from "./wsActors";

/** 兜底名单里的一个人（只保留画点需要的字段） */
export interface RosterChar {
  name: string;
  folder: string;
  subtitle: string;
}

/**
 * 从 `/api/schedule` 的返回里取出角色名单（**纯函数**，可单测）。
 *
 * 为什么自己解析而不是复用 `SchedulePayload` 的类型：那层的类型没声明 `characters`
 * （它是后端 payload 里"顺手带上的"一段），这里只需要两个字符串字段，
 * 写成纯函数能顺手覆盖「字段缺失/类型不对」这些脏数据处理。
 */
export function rosterFromSchedule(raw: unknown): RosterChar[] {
  const o = (raw || {}) as Record<string, unknown>;
  const list = Array.isArray(o.characters) ? o.characters : [];
  const out: RosterChar[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    const c = (it || {}) as Record<string, unknown>;
    const folder = String(c.folder || "").trim();
    const name = String(c.name || folder || "").trim();
    if (!name && !folder) continue;
    const key = name || folder;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || folder, folder, subtitle: String(c.subtitle || "").trim() });
  }
  return out;
}

export interface UseWsRosterOptions {
  /**
   * 要不要去问服务（默认 true）。
   *
   * 传 false 的场合：真壳里名单走 `characterGetAll`，这条路**根本不该发请求**
   * （多一次 IPC/HTTP 是白费）—— 所以只在浏览器通路启用。
   */
  enabled?: boolean;
  /** 已经有多少个**非玩家**角色了：> 0 就不再兜底（这是"只在空名单时生效"的开关） */
  existing?: Ref<number> | (() => number);
}

/**
 * 拉一次兜底名单。
 *
 * **只在浏览器通路**发请求（真壳有自己的名单通路，见文件头）。
 * 拿不到就返回空数组并**不抛**：地图没有角色也要能用（与 loadWorldCharacters 同款纪律）。
 */
export function useWsRoster(opts: UseWsRosterOptions = {}) {
  const chars = ref<RosterChar[]>([]);
  const loading = ref(false);
  const error = ref("");
  let started = false;

  function existingCount(): number {
    const v = opts.existing;
    if (!v) return 0;
    return typeof v === "function" ? Number(v()) || 0 : Number(v.value) || 0;
  }

  async function load(): Promise<RosterChar[]> {
    if (opts.enabled === false || isTauriRuntime()) return chars.value;
    // 已经有角色了就不再兜底（真名单优先，兜底只填"空场"）
    if (existingCount() > 0) return chars.value;
    if (started) return chars.value;
    started = true;
    loading.value = true;
    error.value = "";
    try {
      const r = await fetch(`${worldMapApi.apiBase}/api/schedule`, { cache: "no-store" });
      if (!r.ok) throw new Error(`/api/schedule 返回 ${r.status}`);
      const d = (await r.json()) as unknown;
      chars.value = rosterFromSchedule(d);
      if (!chars.value.length) error.value = "服务返回的角色列表是空的";
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      chars.value = [];
    } finally {
      loading.value = false;
    }
    return chars.value;
  }

  // 组件卸载后不要再写状态（fetch 是异步的，弱网下很容易晚于卸载）
  let alive = true;
  onBeforeUnmount(() => {
    alive = false;
  });

  /** 组装成 `MapActor` 形状（**只用于显示**；坐标由调用方按散点算，posSource 如实标 scatter） */
  function toActors(
    grid: number,
    place: (i: number, total: number, grid: number) => { x: number; y: number }
  ): MapActor[] {
    if (!alive) return [];
    const list = chars.value || [];
    const n = list.length;
    return list.map((c, i) => {
      const p = place(i, n, grid);
      return {
        id: `roster:${c.folder || c.name}`,
        roleId: 0,
        name: c.name,
        subtitle: c.subtitle,
        folder: c.folder,
        emotion: "",
        avatarUrl: "",
        isMe: false,
        gx: p.x,
        gy: p.y,
        // ⚠️ 如实标注：这些人的位置是**本地散开**推的，不是 runtime 也不是日程给的
        posSource: "scatter",
        place: "",
        nowText: "",
      } satisfies MapActor;
    });
  }

  return { chars, loading, error, load, toActors, rosterFromSchedule };
}
