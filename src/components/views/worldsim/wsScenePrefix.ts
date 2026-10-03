/**
 * wsScenePrefix.ts —— 发出门前**给消息加的那一截世界状态**（`PLAN-GAMEPLAY.md:72` · 期 3 第三节）。
 *
 * ## 为什么需要它，以及**为什么它只有这么短**
 * 角色**已经知道**自己在哪、现在几点、天气如何 —— 那是 Rust 侧注入的活：
 * `state.rs::injection_text()` 每轮给出一段
 * `【当前场景】\n你在：广州市·越秀区·东山口·便利店里\n时间/天气：19:20（晚上）`
 * （逐字见 `state.rs:1017-1034` 的单测）。
 * 所以这一层**绝不重复**场景/时间/天气 —— 重复一遍不但没信息量，还会让"注入里那句话"
 * 与"消息里那句话"变成两份口径（真源一分家，迟早互相打架）。
 *
 * 它只补**注入里没有的那一件事**：**玩家此刻就站在他旁边**。
 * 那一句只有玩家点下"说话"的这一瞬间才知道（注入是每轮拼的、不知道距离），
 * 也正是"走近说话"这件事在对话里留下的唯一痕迹。
 *
 * ## 三条纪律
 * ① **不编**：每个片段都来自传进来的真实读数；缺什么就少写什么，并且**记进 `missing`**
 *    （调用方可以据此在界面上如实说一句，而不是静默发出一句像模像样的话）。
 * ② **不读环境**：纯函数 —— 不读 `Date.now()`、不碰 localStorage、不 import vue
 *    ⇒ 同一份输入两次**逐字节相同**。
 * ③ **不设第二套判词**：距离的三态（正数 / 0（已量） / 数不出来）由 `wsNearby` 判，
 *    这里只按 `verdict` 选一句话说；`needsNote` 之类的外来判词**原样透传**，一个字都不改写。
 *
 * ⚠️ 静态代拍页（`public/ws3dshow.html`）目前**没有任何"发消息"的入口**（它的抽屉里只有诊断区），
 *    所以"页面与 App 共用一份"这件事当下落在 App 内部的两处（宿主 + 抽屉）——
 *    页面**将来**若要发消息，必须 import 这一份（那会动到 vendor 生成物，见 `wsPageVendor.ts`）。
 */

/** 前缀的记号（唯一定义处；判词与自检都认它） */
export const SCENE_PREFIX_TAG = "【走近】";

export interface ScenePrefixInput {
  /** 距离（米）—— 来自 `wsNearby` 的 `nearest.meters`；`null` = 量不出来 */
  meters?: number | null;
  /** `wsNearby` 的三态判词（`verdict === "unknown"` 时用它说明"为什么说不清"） */
  nearWhy?: string | null;
  /** 我在哪儿（`runtime.me.place` 或区域名；拿不到就不写这一截） */
  myPlace?: string | null;
  /** 附近还有谁（真名；空数组/不传 = 不写这一句） */
  alsoNear?: readonly string[] | null;
}

export interface ScenePrefixResult {
  /** 要加在消息前面的那一截（**可能为空串**：什么都没拿到时不硬凑一句话） */
  text: string;
  /** 用上了哪几段（日志/自检读数用） */
  parts: string[];
  /** 没拿到、因而没写进去的那几项（**不是**"写成了 0"） */
  missing: string[];
}

/** 地点名去空白 + 去掉换行（它要进一行消息文本） */
function cleanPlace(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 拼前缀。**返回空串是合法结果**（调用方就原样发玩家那句话，不许自己补一句"我在你旁边"）。
 *
 * 三种情况分别长这样（`meters` 的三态）：
 * ```
 * 有距离    【走近】我在你旁边（约 8 米，就在「便利店」这一带）。
 * 0（已量） 【走近】我朝你这边来了（刚量到约 24 米 —— 你走开了几步）。
 * 数不出来  【走近】我来找你了（说不清多远：me（还没拿到你的位置））。
 * ```
 */
export function scenePrefixOf(input: ScenePrefixInput = {}): ScenePrefixResult {
  const parts: string[] = [];
  const missing: string[] = [];

  const m = Number(input.meters);
  const hasMeters = input.meters !== undefined && input.meters !== null && Number.isFinite(m);
  const place = cleanPlace(input.myPlace);

  if (hasMeters) {
    parts.push(`我在你旁边（约 ${Math.max(0, Math.round(m))} 米${place ? `，就在「${place}」这一带` : ""}）`);
  } else if (input.nearWhy) {
    // 数不出来：**原样**把原因带上（不缩写成"附近"、更不写 0 米）
    parts.push(`我来找你了（说不清多远：${cleanPlace(input.nearWhy)}）`);
    missing.push("meters（距离读不出来）");
  } else {
    missing.push("meters（没传距离）");
  }

  const also = (input.alsoNear || []).map(cleanPlace).filter(Boolean);
  if (also.length) parts.push(`还有 ${also.join("、")} 也在附近`);
  else missing.push("alsoNear（附近没有别人 / 名单没读到）");

  if (!parts.length) return { text: "", parts, missing };
  return { text: `${SCENE_PREFIX_TAG}${parts.join("；")}。`, parts, missing };
}
