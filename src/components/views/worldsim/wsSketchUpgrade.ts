/**
 * wsSketchUpgrade.ts —— 「草图异步补齐」的**决策逻辑**（B 方案阶段 D 的第一步，纯函数）
 *
 * ## 背景（这是上一轮查出来的缺口）
 * B 链现在是「数据就绪 + 渲染就绪，但没人把真实楼体喂进生成」：
 * `OsmHint::with_real_buildings()` 只有测试在调，生产路径给 `make_sketch` 传的是 `None`。
 *
 * **而不能顺手接上**：Overpass 首取实测 **15~90 秒**（渝中区 24.9s、北京国贸 91.7s 后失败），
 * 而草图是**"秒出"**的招牌体验 ⇒ 同步取会把首屏拖死。
 *
 * ## 所以要有这个模块
 * 「先用现有草图秒出 → 后台取真实楼体 → 拿到后用带 `rot` 的版本重新生成并淡入替换」。
 * 但"什么时候去取、什么时候必须忍住"是个**容易做错**的判断（每次打开小区图都打一次 Overpass
 * 会被限流、也会把手机流量与电量烧掉）。**判断逻辑放纯函数里，可单测**：
 *
 * - 已经升级过（`rot ≠ 0` 且有楼）→ **skip**（别重复取）；
 * - 有缓存 → **upgrade**（毫秒级，直接用）；
 * - 没有缓存、但最近尝试过（在 `RETRY_COOLDOWN_MS` 内）→ **defer**（**别打**，Overpass 很贵）；
 * - 没有缓存、冷却已过 → **fetch**（这一次真的去打，成功即升级、失败也只等一次）。
 *
 * ## 明确不做
 * 不发请求、不碰 DOM、不管淡入动画 —— 这里只回答"现在该做什么"。
 */

/** 升级决策 */
export type UpgradeAction =
  /** 不用做（已升级 / 无需升级） */
  | "skip"
  /** 有缓存：直接重新生成并淡入替换（快） */
  | "upgrade"
  /** 没缓存但冷却未到：**先别打 Overpass** */
  | "defer"
  /** 没缓存且冷却已过：可以打一次 */
  | "fetch";

export interface UpgradeInput {
  /** 当前草图是否已经带真实楼体（`rot != 0` 或已有楼体清单） */
  upgraded: boolean;
  /** `/api/buildings` 的缓存是否命中（命中就是毫秒级，可以放心升级） */
  cacheHit: boolean;
  /** 缓存里的楼栋数（0 = 拿到过但那一带没楼，**这也是有效信息**，不该反复重取） */
  buildingCount: number;
  /** 上次尝试取数的时间戳（ms；0 = 从没试过） */
  lastTriedAt: number;
  /** 现在（ms；**注入而不是内部读时钟**，否则没法测） */
  nowMs: number;
  /** 这个区域是否值得升级（例如面积太小/太偏，或用户明确关掉了真实数据） */
  enabled: boolean;
}

/** 冷却：多久之内不再去打 Overpass（实测一次 15~90 秒，且会被限流） */
export const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** 决策：现在该做什么？（顺序即优先级，第一条命中即返回） */
export function decideUpgrade(i: UpgradeInput): UpgradeAction {
  if (!i.enabled) return "skip";
  if (i.upgraded) return "skip";
  // 拿到过数据（哪怕 0 栋）也算"这一带已经问过了" —— 反复重取既无用又慢
  if (i.cacheHit) return "upgrade";
  const since = i.nowMs - Math.max(0, i.lastTriedAt || 0);
  if (i.lastTriedAt > 0 && since < RETRY_COOLDOWN_MS) return "defer";
  return "fetch";
}

/** 冷却剩余毫秒（0 = 可以打了）；给 UI 显示"稍后自动补齐"用 */
export function cooldownLeftMs(i: Pick<UpgradeInput, "lastTriedAt" | "nowMs">): number {
  const t = Math.max(0, i.lastTriedAt || 0);
  if (!t) return 0;
  return Math.max(0, RETRY_COOLDOWN_MS - (i.nowMs - t));
}

/**
 * 升级后该怎么呈现 —— **只给判断，不实现动画**。
 * `crossfade`：有真实数据时淡入替换（复用现有"草图 → AI 精绘淡入"的机制）；
 * `keep`：没有真实数据（0 栋）就**保持原样**，而不是换成一张"其实没变"的图（避免闪一下）。
 */
export function presentAfterUpgrade(buildingCount: number): "crossfade" | "keep" {
  return buildingCount > 0 ? "crossfade" : "keep";
}

/** 给界面/日志的一行说明（**如实**：别把"这一带没有楼"说成"升级失败"） */
export function describeUpgrade(action: UpgradeAction, i: UpgradeInput): string {
  switch (action) {
    case "skip":
      return i.upgraded ? "已按真实楼体生成" : "未开启真实楼体";
    case "upgrade":
      return i.buildingCount > 0 ? `用真实楼体重新生成（${i.buildingCount} 栋）` : "这一带没有楼房数据，保持草图";
    case "defer":
      return `稍后自动补齐（还有 ${Math.ceil(cooldownLeftMs(i) / 1000)} 秒冷却）`;
    case "fetch":
      return "正在后台取真实楼体（首次可能十几秒）";
  }
}
