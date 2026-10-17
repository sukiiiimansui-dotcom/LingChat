/**
 * wsBldProfile.ts —— **「精简 / 完整」产物的唯一 profile 真源**（纯函数，不 import vue）。
 *
 * 一个 profile 同时驱动**两处**（硬要求，别拆成两个开关）：
 *   · 瓦片目录：`mvt-slim` ↔ `mvt-full`（`bldMvtDirOf`）
 *   · 离线包目录：`bldbundle-002-slim` ↔ `bldbundle-002`（`bldBundleDirOf`）
 *
 * 取值优先级：`?profile=slim|full`（调试/分享链接）> `localStorage["wsm:v1:profile"]` > `slim`。
 * **切换需要刷新页面**：瓦片协议在**建图之前**注册（worker 的 `REGISTERED_PROTOCOLS` 每个线程一份），
 * 离线包的 `activeDir` 在第一次读索引时缓存 ⇒ 两处都按"开页时读一次"实现；
 * 切换后请刷新（`BLD_PROFILE_RELOAD_HINT` 是给 UI 的那句人话）。
 *
 * 为什么不做运行时热切：两处必须**一起**换（不许出现"画了 3,078、包里只有 1,158"），
 * 而瓦片源/worker 协议/覆盖登记器/离线包索引缓存各自都有"开页时定下来"的状态；
 * 热切要么漏掉一处，要么得重建整张图 —— 刷新是唯一能保证原子的做法。
 */

/** 偏好键（`wsm:v1:` 前缀与项目其它世界模拟存储一致；改名等于丢一次用户选择） */
export const WS_BLD_PROFILE_KEY = "wsm:v1:profile";
/** 两个合法值 */
export const WS_BLD_PROFILE_SLIM = "slim";
export const WS_BLD_PROFILE_FULL = "full";
/** 档位（其它一律归一成 slim） */
export type WsBldProfile = typeof WS_BLD_PROFILE_SLIM | typeof WS_BLD_PROFILE_FULL;
/** 给 UI 的刷新提示（切换后必读；不自动刷新，交宿主决定怎么提示） */
export const BLD_PROFILE_RELOAD_HINT = "已切换精简/完整，刷新页面后生效（瓦片与离线包会一起切换）";

/** 任意读到的值 → 档位：只认 `"full"` 那一个值（大小写/坏值一概回 slim） */
export function bldProfileOf(raw: unknown): WsBldProfile {
  return raw === WS_BLD_PROFILE_FULL ? WS_BLD_PROFILE_FULL : WS_BLD_PROFILE_SLIM;
}

/** 读盘：坏了/没有/读不动 ⇒ slim（隐私模式下 localStorage 会抛，绝不抛） */
export function readBldProfile(): WsBldProfile {
  try {
    if (typeof localStorage === "undefined") return WS_BLD_PROFILE_SLIM;
    return bldProfileOf(localStorage.getItem(WS_BLD_PROFILE_KEY));
  } catch { return WS_BLD_PROFILE_SLIM; }
}

/** 落盘：写不进去不影响本次会话（返回真正生效的档位） */
export function writeBldProfile(raw: unknown): WsBldProfile {
  const v = bldProfileOf(raw);
  try { if (typeof localStorage !== "undefined") localStorage.setItem(WS_BLD_PROFILE_KEY, v); } catch { /* 只活这一次 */ }
  return v;
}

/** `?profile=` 解析：没有/坏值 ⇒ null（= 不覆盖存储；与"显式钉住"同款，不猜） */
export function bldProfileFromSearch(search?: string): WsBldProfile | null {
  let q = search;
  if (q === undefined) {
    try { q = typeof location !== "undefined" ? location.search : ""; } catch { q = ""; }
  }
  const m = /[?&]profile=(slim|full)\b/i.exec(String(q || ""));
  return m ? bldProfileOf(m[1].toLowerCase()) : null;
}

/** 最终生效的 profile：URL 覆盖 > 存储 > slim */
export function effectiveBldProfile(search?: string): WsBldProfile {
  return bldProfileFromSearch(search) ?? readBldProfile();
}

/** profile → 瓦片目录（**唯一映射**；`wsMvtTiles` 与自检都调它） */
export function bldMvtDirOf(profile: WsBldProfile): "mvt-slim" | "mvt-full" {
  return profile === WS_BLD_PROFILE_FULL ? "mvt-full" : "mvt-slim";
}

/** profile → 离线包目录（**唯一映射**；`wsOfflineFeed` 与自检都调它） */
export function bldBundleDirOf(profile: WsBldProfile): "bldbundle-002-slim" | "bldbundle-002" {
  return profile === WS_BLD_PROFILE_FULL ? "bldbundle-002" : "bldbundle-002-slim";
}
