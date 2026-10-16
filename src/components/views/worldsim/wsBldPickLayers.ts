/**
 * 点楼时"该查哪几条图层"的**纯函数**（零依赖 ⇒ 本机可直接单测 + 变异）。
 *
 * 为什么单独一份：原来这段逻辑写在 `wsPickInteract.bldClickLayersNow` 里，按 zoom 档位直接
 * 返回**写死的层名**。`?mvt=1` 那条路只有 `bld-foot` / `bld-ext`（没有 `bld-roof` / `bld-equip`）⇒
 * 传给 `map.queryRenderedFeatures` 的层名里只要有一条不存在，它会**抛**，调用处 `catch` 之后
 * 一律落到"在原路 store 那批楼里按屏幕距离找"的兜底 —— 而瓦片画出来的那批**远多于** store 那批
 * （实测同一视口 1876 栋 vs 15 栋）⇒ **点到的常常不是看到的那栋，或者什么都不弹**。
 *
 * 口径：**先按 zoom 档位取"应该查哪几条"，再按"这些层在当前样式里真实存在"过滤**。
 * 两条数据路（GeoJSON / 瓦片）因此走**同一条**点选逻辑，差别只在层是否存在。
 */

/** 按 zoom 档位该查的层（0 = 远景足迹档 · 1 = 女儿墙档 · 2 = 设备箱档） */
export const BLD_CLICK_LAYERS_BY_TIER: Readonly<Record<0 | 1 | 2, readonly string[]>> = {
  0: ["bld-foot"],
  1: ["bld-ext", "bld-roof", "bld-equip"],
  2: ["bld-foot", "bld-ext", "bld-roof", "bld-equip"],
};

/**
 * 只做"档位 → 层名"，不碰地图（纯查表）。
 *
 * ⚠️ **档位读不出来（`null`/`undefined`/非有限数）时必须给"全部层"**，不能退成 0：
 * 原实现的语义是「宁可不命中也不能漏掉一栋明明画着的楼」（点选是用户明确点了一下）。
 * 这一点由 `ws_mvt_picklayers_selftest` 的判据①钉住。
 */
export function bldClickLayerNames(tier: number | null | undefined): string[] {
  const t: 0 | 1 | 2 = tier === 0 || tier === 1 || tier === 2 ? tier : 2;
  return [...BLD_CLICK_LAYERS_BY_TIER[t]];
}

/**
 * 再按"层真实存在"过滤。**全都不存在时返回空数组**（调用处的 `queryRenderedFeatures`
 * 会因此被跳过、直接走兜底），**绝不返回不存在的层名**（那会让它抛）。
 */
export function pickableBldLayers(wanted: readonly string[], exists: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const id of wanted) {
    let ok = false;
    try { ok = !!exists(id); } catch { ok = false; }
    if (ok) out.push(id);
  }
  return out;
}
