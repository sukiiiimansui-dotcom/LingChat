/**
 * 楼的稳定 id —— **唯一的规范化点**。
 *
 * 为什么要有这个文件：MVT 瓦片里的 `feature.id` 是 **48bit 数字**（`gen_mvt` 把源数据那 12 位 hex 转成数字，
 * 见 `world_map/mvt-spike/REPORT-MVT-SPIKE.md`），而站内既有的 id 口径一律是 **12 位小写 hex 字符串**
 * （`wsOfflineFeed.bldIdOf` / `wsFeatureStore` 去重 / `wsBuildingLook` 的观感种子 / 三处拾取 / 楼卡）。
 * 只要在**边界**转一次，下游一处都不用改。
 *
 * 本文件**不 import 任何东西**（纯函数）⇒ 谁都能用、也能在 Node 里单测。
 */

/** 规范 hex 的长度（源数据实测恒为 12：全 7,676 格 720,087 栋） */
export const BLD_HEX_ID_LEN = 12;

/** 48bit 上限（超过它说明不是我们生成的 id ⇒ 拒绝，不静默截断） */
export const BLD_MAX_NUM_ID = 0xffffffffffff;

/** 12 位 hex 的正则（小写口径；大写会被 `bldIdOfFeature` 归一） */
const HEX12 = /^[0-9a-f]{12}$/;

/**
 * 体块/分片后缀：`<楼 id>#body` / `#tower-t1` / `#equip-0`，
 * 以及离线包里多环楼的 `<楼 id>#0`（见 `wsOfflineFeed.bundleBuildingsOf`）。
 *
 * 为什么要在这里剥：落图用的是**拆件后的要素**（`buildingPartSet` 给每块加了后缀），
 * 而"是哪一栋"的答案只有一个 id；调用方（名字层/点选/楼卡）必须拿到同一个。
 * 只在这个文件里剥 —— 下游一处都不许再写第二份规则。
 */
const PART_SUFFIX = /^(.*)#(?:body|podium|tower|setback|parapet|equip|antenna|roof|\d+)(?:-[a-z0-9]+)*$/i;

/** 剥掉体块/分片后缀（最多两层：`<id>#0#body`）；没有后缀原样返回 */
export function bldIdBase(s: string): string {
  let out = String(s || "").trim();
  for (let i = 0; i < 3; i++) {
    const m = PART_SUFFIX.exec(out);
    if (!m) break;
    out = m[1].trim();
  }
  return out;
}

/** 数字 → 12 位小写 hex；非法（负数/小数/超 48bit）⇒ `null` */
export function bldHexOfNumber(n: unknown): string | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > BLD_MAX_NUM_ID) return null;
  return v.toString(16).padStart(BLD_HEX_ID_LEN, "0");
}

/** 12 位 hex（或十进制数字串）→ 48bit 数字；非法 ⇒ `null` */
export function bldNumberOfHex(h: unknown): number | null {
  if (typeof h === "number") return Number.isInteger(h) && h >= 0 && h <= BLD_MAX_NUM_ID ? h : null;
  if (typeof h !== "string") return null;
  const s = h.trim().toLowerCase();
  if (/^[0-9a-f]{1,12}$/.test(s)) { const v = parseInt(s, 16); return Number.isFinite(v) && v <= BLD_MAX_NUM_ID ? v : null; }
  if (/^\d+$/.test(s)) return bldHexOfNumber(Number(s)) ? Number(s) : null;
  return null;
}

/**
 * 要素 → 规范 12 位 hex。三种入口都收：
 *   ① MVT：数字 `feature.id`；② 离线包：字符串 `osm_id` / `i`；③ 数字属性。
 * 字符串入口会先剥掉体块/分片后缀（`#body` / `#0` / `#tower-t1`）——
 *   落图要素是拆件后的，同一栋楼的所有体块必须归一到**同一个** id。
 * 认不出来 ⇒ `null`（**不编 id**；调用方照旧走"无 id"那条降级路）。
 */
export function bldIdOfFeature(f: { id?: unknown; properties?: Record<string, unknown> } | null | undefined): string | null {
  if (!f || typeof f !== "object") return null;
  if (typeof f.id === "number") { const h = bldHexOfNumber(f.id); if (h) return h; }
  const p = (f.properties || {}) as Record<string, unknown>;
  for (const v of [p.osm_id, p.store_id, p.id, (f as { i?: unknown }).i, p.i, (f as { id?: unknown }).id]) {
    if (typeof v === "string") {
      const s = bldIdBase(v);
      if (HEX12.test(s.toLowerCase())) return s.toLowerCase();
      if (/^\d+$/.test(s)) { const h = bldHexOfNumber(Number(s)); if (h) return h; }
      continue;
    }
    if (typeof v === "number") { const h = bldHexOfNumber(v); if (h) return h; }
  }
  return null;
}

/**
 * 去重/冻结用的键：**优先稳定 id**，没有 id 的要素退回对象本身
 * （`?live=1` 那条路可能没有 id；退回对象同一性 = 改动前的行为，逐字节不变）。
 */
export function bldKeyOfFeature(f: unknown): unknown {
  if (f && typeof f === "object") {
    const id = bldIdOfFeature(f as { id?: unknown; properties?: Record<string, unknown> });
    if (id) return id;
  }
  return f;
}
