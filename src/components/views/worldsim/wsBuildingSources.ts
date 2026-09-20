/**
 * wsBuildingSources.ts —— **楼房第二数据源的合并规则**（纯函数，可单测）。
 *
 * ## 为什么需要它（机主 2026-09-20：「换源我看看效果喵」）
 * 楼房一直只有 OSM 一个源，而 OSM 在中国的覆盖**极不均**（同一个后端实测）：
 *   渝中区驻地 400m → **152 栋**（成片）；涪陵区驻地 400m → **0 栋**、1400m → 29。
 * 机主人在涪陵 ⇒ 他看到的就是"零星几栋"。**这是数据问题，不是渲染问题。**
 *
 * 第二源 = **Overture Maps Buildings（ODbL）**。同一个涪陵城区 bbox 实测：
 *   OSM 0~29 栋 **vs** Overture **13,811 栋**。
 *
 * ## 合并规则（机主定的口径：「有真数据用真的」「OSM 有高度时用 OSM」）
 * ① **OSM 一律保留**，一条都不丢 —— 它是我们唯一有 `height`/`levels` 的源，
 *    也是既有的出处与署名；第二源的角色是**补缺**，不是替换。
 * ② Overture 只补 OSM **没有**的地方 ⇒ 判定"重复"的办法：两个脚印的**中心点**
 *    距离小于 `dedupeM`（默认 18m）就算同一栋，丢掉 Overture 那条。
 *    为什么用中心点而不是算多边形相交：相交判定要引入几何库（手机上几十 MB），
 *    而"中心点靠得很近"对"同一栋楼"这个判断已经足够 —— 且**误判的代价是可控的**
 *    （最多多画或少画一栋，不会画到错的城市去）。
 * ③ 结果里**分开计数**（`osm` / `overture` / `dropped`）—— HUD 要如实写出两个来源各多少，
 *    不许混成一个数报出去（`DESIGN-3D-MODES.md` §八 的红线：不许把不同出处的东西说成一个）。
 *
 * ## ⚠️ 高度：Overture 这批**没有高度**
 * 涪陵实测 13,811 栋里 `height` / `num_floors` **全是 null**（纯脚印）。
 * 所以补进来的楼**必须**落在 `height_src=default`（按类型估）那一档，
 * **绝不许**进 HUD 的"真高"计数。本模块给它们打 `src="overture"` + `height_src="default"`，
 * 渲染侧据此走"估计"色阶。
 */

/** 楼房要素的最小形状（OSM 与 Overture 都满足） */
export interface BldFeature {
  type?: string;
  /* ⚠️ 别给它加 `| null`：项目里 `decorateBuildings()`（wsBuildingLook）吃的是
     `properties?: Record<string, unknown>`，多一个 null 就整条链路对不上类型。
     后端确实可能给 null，所以**取值处一律写 `f.properties || {}`**（本文件里都是这么写的）。 */
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

export interface MergeResult {
  features: BldFeature[];
  /** 来自 OSM 的条数（**全是原样保留的**） */
  osm: number;
  /** 真正被采纳的 Overture 条数（已扣掉重复） */
  overture: number;
  /** 因为"和 OSM 那栋是同一栋"而丢掉的 Overture 条数 */
  dropped: number;
}

/**
 * 几何的**中心点**（用外环的 bbox 中心，不是重心 —— 重心要遍历所有点，且凹多边形会跑偏）。
 * 拿不到坐标就返回 null（**不猜**）。
 */
export function geomCenter(geom: BldFeature["geometry"]): [number, number] | null {
  if (!geom) return null;
  const t = geom.type;
  if (t !== "Polygon" && t !== "MultiPolygon") return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (v: unknown): void => {
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
      const x = v[0] as number;
      const y = v[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x);
  };
  walk(geom.coordinates);
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX < minX || maxY < minY) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * 两个经纬度点之间的**近似**距离（米）。
 *
 * 为什么可以用近似：我们只拿它跟一个十几米的阈值比，而且比的是**同一个城市里**的两栋楼
 * （纬度差极小）⇒ 用等距圆柱投影就够，不必上 Haversine。
 * ⚠️ 但**经度必须乘 cos(纬度)**：漏了它，涪陵（29.7°N）会横向差 13%，
 * 在阈值边界上的判定就会飘。
 */
export function metersBetween(a: [number, number], b: [number, number]): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111320 * Math.max(0.05, Math.cos(lat));
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * 合并两个源。**OSM 优先**：OSM 全留，Overture 只补 OSM 没有的。
 *
 * @param osm      OSM 的要素（先来，权威）
 * @param overture  Overture 的要素（补缺）。null/空 = 第二源没取到，**原样返回 OSM**（不报错）
 * @param dedupeM   两栋楼中心点小于这个距离（米）就算同一栋，丢 Overture 那条
 */
export function mergeBuildingSources(
  osm: readonly BldFeature[] | null | undefined,
  overture: readonly BldFeature[] | null | undefined,
  dedupeM = 18
): MergeResult {
  const a = (osm || []).filter((f) => f && f.geometry);
  const b = (overture || []).filter((f) => f && f.geometry);
  if (!b.length) return { features: a.slice(), osm: a.length, overture: 0, dropped: 0 };

  /* OSM 的中心点先算好一遍（O(n)），别在双层循环里重复算 */
  const centers: Array<[number, number]> = [];
  for (const f of a) {
    const c = geomCenter(f.geometry);
    if (c) centers.push(c);
  }

  const keep: BldFeature[] = [];
  let dropped = 0;
  for (const f of b) {
    const c = geomCenter(f.geometry);
    if (!c) continue; // 中心点都算不出来的，宁可不要（画出来会是一团无法定位的东西）
    if (centers.some((x) => metersBetween(x, c) < dedupeM)) {
      dropped++;
      continue;
    }
    keep.push({
      type: f.type || "Feature",
      /* 出处如实标：`src` 给 HUD 分来源计数，`height_src` 保证它进"按类型估"那一档 */
      properties: {
        ...(f.properties || {}),
        src: "overture",
        height_src: f.properties?.height ? "height" : "default",
      },
      geometry: f.geometry,
    });
  }
  return { features: [...a, ...keep], osm: a.length, overture: keep.length, dropped };
}

/**
 * 该不该去问第二源。
 *
 * **只在 OSM 稀疏时才问** —— 这条不是省钱，是**别把密集区的画面搞坏**：
 * 渝中区 400m 就有 152 栋真楼（还带高度），再叠一层没有高度的补缺楼
 * 只会把它们淹掉；而且那一问要 12MB/17 秒（实测），对已经够看的地方纯属浪费。
 */
export function shouldAskSecondSource(osmCount: number, threshold = 40): boolean {
  return Number.isFinite(osmCount) && osmCount < threshold;
}
