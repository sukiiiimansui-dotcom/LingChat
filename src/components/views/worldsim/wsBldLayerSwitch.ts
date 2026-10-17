/* wsBldLayerSwitch.ts —— **楼房图层的建/拆开关**（结构性：楼房只允许 three.js 渲染）。
 *
 * ## 为什么单独一个模块
 * 真机 2026-10-17：地图那套 `bld-*` 图层反复出现"写进去、读回来又 visible"（样式重建/实例替换），
 * 用户一直看到地图自己那套楼。结构性的做法是：**叠加层是楼房渲染者时，这些图层一条都不存在**
 * （源 `bld` 保留 —— three 要从源里取数），切回地图时再建回来。
 *
 * ## 边界（不改别人的东西）
 * - **规格只从这里已有的导出拿**（`bldLayerSpecsFor` / `mvtBldLayerSpecs`），本文件**不写任何规格**；
 * - **不 import `wsBldLanding`**（那条线正在改它）：重建走本模块自己的 `addLayer`，与落图管线互不影响；
 * - 移除按**样式层列表**枚举（`getLayer` 说"不在"的也要试着删），逐条记账。
 *
 * ## 可恢复性（这是"移除"能成立的前提）
 * 叠加层画不出来时，调用方必须立刻 `ensureBldLayers(map, "map")` ⇒ 屏幕回到地图那套，
 * **不会出现"一栋都没有且回不来"**。所以这个开关是**双向**的，不是单向删除。
 */

/** 楼房图层的层名前缀（与 `wsOverlayBackend` 的 `BLD_LAYER_PREFIX` 同口径） */
export const BLD_PREFIX = "bld";

/** 只读形状：够用就好，不引引擎类型 */
type MapLike = {
  getStyle?: () => { layers?: Array<{ id?: unknown }> } | undefined;
  getLayer?: (id: string) => unknown;
  addLayer?: (spec: Record<string, unknown>, before?: string) => void;
  removeLayer?: (id: string) => void;
  getSource?: (id: string) => unknown;
};

/** 这个 call（一次 ensure）删了哪些层 / 建了哪些层（给调用方记账，别静默） */
export interface SwitchFacts {
  removed: string[];
  added: string[];
  mode: "map" | "overlay";
}

/** 现在样式里还剩几条 `bld*` 层（**判据用**：0 = 结构性目标达成） */
export function hasBldLayers(map: unknown): number {
  const m = map as MapLike | null;
  if (!m?.getStyle) return -1;
  try {
    const all = m.getStyle()?.layers || [];
    return all.filter((l) => String((l as { id?: unknown })?.id ?? "").startsWith(BLD_PREFIX)).length;
  } catch {
    return -1;
  }
}

/** 按样式层列表枚举并移除全部 `bld*`（返回删掉的 id） */
function removeAll(map: MapLike): string[] {
  const out: string[] = [];
  if (!map.removeLayer || !map.getStyle) return out;
  let all: unknown[] = [];
  try {
    all = map.getStyle()?.layers || [];
  } catch {
    return out;
  }
  for (const l of all) {
    const id = String((l as { id?: unknown })?.id ?? "");
    if (!id.startsWith(BLD_PREFIX)) continue;
    try {
      map.removeLayer(id);
      out.push(id);
    } catch {
      /* 单层失败不影响其它层（下一轮再来） */
    }
  }
  return out;
}

/** 建层用的规格（**只取已有导出**，不在这里写规格） */
export type SpecsProvider = () => Array<Record<string, unknown>>;

/**
 * 楼房图层的**建/拆开关**（幂等）。
 *
 * @param map  地图实例（假地图也行：只要有 getStyle/addLayer/removeLayer）
 * @param mode `"overlay"` = 楼房由 three 渲染 ⇒ **移除**（源保留）；
 *             `"map"`     = 楼房由地图渲染 ⇒ **建回来**（已存在就一条都不动）
 * @param specs 建层规格的来源；不传就**不建**（调用方必须在能拿到规格时才请求重建）
 */
export function ensureBldLayers(map: unknown, mode: "map" | "overlay", specs?: SpecsProvider): SwitchFacts {
  const m = map as MapLike | null;
  const facts: SwitchFacts = { removed: [], added: [], mode };
  if (!m) return facts;
  if (mode === "overlay") {
    facts.removed = removeAll(m);
    return facts;
  }
  /* mode === "map"：缺哪条建哪条（**幂等**：已存在的一个字节都不动） */
  if (!m.addLayer || !specs) return facts;
  let list: Array<Record<string, unknown>> = [];
  try {
    list = specs() || [];
  } catch {
    return facts;
  }
  /* 插入锚点与既有落图管线同口径：有 `ref` 就插在它之前，没有就追加 */
  const before = (() => {
    try {
      return m.getLayer?.("ref") ? "ref" : undefined;
    } catch {
      return undefined;
    }
  })();
  for (const spec of list) {
    const id = String((spec as { id?: unknown })?.id ?? "");
    if (!id) continue;
    let exists = false;
    try {
      exists = !!m.getLayer?.(id);
    } catch {
      exists = false;
    }
    if (exists) continue;
    try {
      m.addLayer(spec, before);
      facts.added.push(id);
    } catch {
      /* 单条失败不影响其它条 */
    }
  }
  return facts;
}
