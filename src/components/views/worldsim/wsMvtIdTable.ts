/**
 * `id → 元数据（h/lv/k/b）` 的**唯一真源**（`?mvt=1` 先导用）。
 *
 * 接口与语义与工具仓里那份**同源**（`world_map/mvt-spike/tools/wsMvtIdTable.mjs`，已过 43 条单测 + 5 条变异证明）：
 *   · **建**：宿主在 `?mvt=1` 时 `createMvtIdTable()`；
 *   · **维护**：只有取瓦片那一层登记（拿到带属性的要素就 `registerTileFromFeatures`）——
 *     本模块**不取数、不解码瓦片、不碰 DOM/MapLibre**（纯逻辑 ⇒ 可在 Node 里单测）；
 *   · **只消费**：去重（`wsFeatureStore` 已有 `Map<id>`）、冻结（`wsBldPickStore`）、拾取三处、楼卡
 *     —— 一律通过 `wsBldIdKey` 的 `bldIdOfFeature` / 本模块的 `metaOf`，**不许自己解析 id**。
 *
 * 规范化只有一处实现：`wsBldIdKey.bldHexOfNumber`（本文件不再写第二份）。
 */
import { bldHexOfNumber, bldIdOfFeature, BLD_HEX_ID_LEN } from "./wsBldIdKey";

export interface BldMvtMeta {
  /** 渲染高度（米，生成侧已按 `renderHeight()` 口径预计算） */
  h: number;
  /** 层数（h/3） */
  lv: number;
  /** 类型（生成侧 `c` 字段，缺省 `yes`） */
  k: string;
  /** 高度颜色分档号 0..7 */
  b: number;
}

export interface BldMvtIdTableFacts {
  tiles: number;
  ids: number;
  noId: number;
  badId: number;
  evictedTiles: number;
  conflicts: number;
}

export interface BldMvtIdTable {
  registerTileFromFeatures(tileKey: string, features: readonly unknown[]): { added: number; skipped: number; ids: number };
  forgetTile(tileKey: string): boolean;
  metaOf(idOrNum: string | number): BldMvtMeta | null;
  facts(): BldMvtIdTableFacts;
  size(): number;
}

export const BLD_MVT_HEX_ID_LEN = BLD_HEX_ID_LEN;

export function createMvtIdTable(opts: { maxTiles?: number } = {}): BldMvtIdTable {
  const maxTiles = Number.isFinite(opts.maxTiles) && (opts.maxTiles as number) > 0 ? Math.floor(opts.maxTiles as number) : 64;
  /** 元数据表：hex → 元数据。**同一 id 一旦登记就不再变**（跨 zoom 一致的落点） */
  const meta = new Map<string, BldMvtMeta>();
  /** 登记来源：tileKey → 该瓦片带来的 id 集合（淘汰簿记用；不删 meta —— 删了会让在画的楼查不到） */
  const tiles = new Map<string, Set<string>>();
  const tileAge: string[] = [];
  const facts: BldMvtIdTableFacts = { tiles: 0, ids: 0, noId: 0, badId: 0, evictedTiles: 0, conflicts: 0 };

  function put(id: string, m: BldMvtMeta): void {
    const prev = meta.get(id);
    if (prev === undefined) { meta.set(id, m); return; }
    /* 同一栋楼跨 zoom/视野必须同一个元数据；不一致 ⇒ **计数**（不静默覆盖成后到的那个） */
    if (prev.h !== m.h || prev.lv !== m.lv || prev.k !== m.k || prev.b !== m.b) facts.conflicts += 1;
  }

  return {
    registerTileFromFeatures(tileKey, features) {
      const arr = Array.isArray(features) ? features : [];
      const set = new Set<string>();
      let added = 0, skipped = 0;
      for (const f of arr) {
        const id = bldIdOfFeature(f as { id?: unknown; properties?: Record<string, unknown> });
        if (!id) { facts.noId += 1; skipped += 1; continue; }
        const p = ((f as { properties?: Record<string, unknown> }).properties || {}) as Record<string, unknown>;
        const h = Number(p.h), lv = Number(p.lv), b = Number(p.b);
        const k = String(p.k ?? "yes");
        if (!Number.isFinite(h) || !Number.isFinite(lv) || !Number.isFinite(b)) { facts.badId += 1; skipped += 1; continue; }
        put(id, { h, lv, k, b });
        set.add(id);
        added += 1;
      }
      const cur = tiles.get(tileKey);
      if (!cur) {
        tiles.set(tileKey, set);
        tileAge.push(tileKey);
        while (tileAge.length > maxTiles) {
          const old = tileAge.shift();
          if (old !== undefined && old !== tileKey) { tiles.delete(old); facts.evictedTiles += 1; }
        }
      } else {
        for (const id of set) cur.add(id);
      }
      facts.tiles = tiles.size;
      facts.ids = meta.size;
      return { added, skipped, ids: meta.size };
    },
    forgetTile(tileKey) {
      if (!tiles.has(tileKey)) return false;
      tiles.delete(tileKey);
      const i = tileAge.indexOf(tileKey);
      if (i >= 0) tileAge.splice(i, 1);
      facts.tiles = tiles.size;
      return true;
    },
    metaOf(idOrNum) {
      const hex = typeof idOrNum === "number" ? bldHexOfNumber(idOrNum) : String(idOrNum || "").trim().toLowerCase();
      if (!hex) return null;
      const m = meta.get(hex);
      return m ? { h: m.h, lv: m.lv, k: m.k, b: m.b } : null;
    },
    facts() { return { ...facts }; },
    size() { return meta.size; },
  };
}
