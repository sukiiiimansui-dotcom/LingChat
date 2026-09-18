// 「世界模拟」T4-3：**重大事件聚焦** —— 纯逻辑部分（不 import vue / 不碰网络 / 不碰 DOM）
//
// 为什么单独一个文件（与 wsActors.ts / wsGeo.ts 同样的理由）：
//   ① 「这条事件算不算重大」「该聚焦到谁」「镜头要挪多少」全是**纯函数**，
//      拆出来才能用 node 直接跑自检（见 ~/rikka/Dsh-SYuki/world_map/ws_focus_selftest_t4_3.mjs）；
//   ② 组件（WsEventFocus）只负责画，页面（WorldSim）只负责在事件到达时**调一次**。
//
// ── 背景：这一步补的是什么缺口（卡片 t-mty27ghw-zjjfw2 的原话）──────────────
//   「重大事件聚焦：事件发生时镜头/高亮要真的动起来（现在是数据层有、视觉未验证）」
//   数据层（useWorldEvents 的 tick 轮询 + `world_map:event` 广播）早就在跑，
//   但事件到了之后**画面上什么都不会动** —— 气泡只是一个小方块飘一下，
//   镜头、高亮、指向全部没有。这个文件定义「聚焦」这件事的全部判据与几何。
//
// ── 与气泡（P5-2 / WsEventBubble）的分工，改之前先读 ─────────────────────
//   气泡 = **每一件**事都冒一下（轻量、不打扰、4 秒自己消失）。
//   聚焦 = **只有**「会把人从日常里拽出来」的那几类（意外/节日/健康/交通）
//          才动画面：压暗全场 + 聚光灯 + 铭牌 + 放大那一枚头像。
//   所以 `focusLevelOf()` 是个**收窄**判据：默认 `none`，只有够格的才升上去。
//   两者互斥不重叠：聚焦中的那条事件**不再**冒气泡（否则同一条事说两遍，反而乱）。
//
// ── 镜头（camera）为什么只算「建议值」────────────────────────────────────
//   `cameraOffsetFor()` 返回把目标角色挪到视口中央所需的**平移量**（屏幕像素）。
//   真正把地图挪过去是手势层（useWorldSimGestures 的 tx/ty）的事，而那个实例
//   在 WsDistrict 内部、**没有对外暴露 setter**（只有 reset/zoomBy）。
//   ⇒ 这里只算「该挪多少」，由页面在接线时决定怎么用（见交回说明）。
//   本文件不 import 手势层，也不写死任何 DOM 结构 —— 这条边界不许越。

import { onBeforeUnmount, ref, type Ref } from "vue";
// 依赖方向：wsFocus → useWorldEvents（单向）。只用它的**纯函数 / 常量**，
// 不碰它的任何状态 —— 这样自检里可以整体打包本文件而不拖进 Tauri API 的运行时。
import { bubbleAnchorOf, WS_EVENT_CATEGORIES } from "@/composables/useWorldEvents";
// 自检脚本要拿它跟 `focusAnchorOf` **对拍**（证明聚光灯与头像同心），所以在这里转出去。
// 转出去而不是让自检各自去 import useWorldEvents：那会把「打包一份还是两份」的问题
// 留给测试脚本（两份实例在同一个进程里并存，将来出分歧没人看得出来）。
export { bubbleAnchorOf };

/** 事件类别（与 useWorldEvents 的 `WsEventCategory` 逐字对齐；这里不 import 它，避免循环依赖） */
export type FocusCategory =
  | "weather"
  | "traffic"
  | "social"
  | "work"
  | "health"
  | "money"
  | "accident"
  | "festival"
  | "mood"
  | "luck";

/**
 * 聚焦等级。
 *
 * · `none`  = 不值得动画面（没人在场 / 系统通知 / 认不出的类别）
 * · `bubble`= 走原有的气泡通道就够（日常小事的绝大多数）
 * · `focus` = **重大事件**：压暗 + 聚光灯 + 铭牌 + 放大头像
 */
export type FocusLevel = "none" | "bubble" | "focus";

/**
 * 够格触发聚焦的类别（**判据写死在这里，只此一处**）。
 *
 * 为什么是这四类：其余六类要么是「环境自己变」（weather 本来就整天在变，
 * 为它反复拉镜头会晕）、要么是「日常」（work/money/social/mood/luck ——
 * 它们是氛围，不是事件）。这四类的共同点是**会把人从日常里拽出来**：
 *   · accident 意外   · festival 节日   · health 健康   · traffic 交通
 * ⚠️ 调这张表就等于调「镜头什么时候动」，改完请同步跑自检脚本。
 */
export const FOCUS_CATEGORIES: FocusCategory[] = ["accident", "festival", "health", "traffic"];

/**
 * 类别 → 徽章 emoji。
 *
 * ⚠️ 与 `useWorldEvents.WS_CATEGORY_META` 的对应项**必须逐字一致**（自检里有一条断言
 * 专门查这个）—— 同一个类别在气泡上是 ⚡、在聚光灯铭牌上却是别的，会让人以为是两件事。
 * 为什么不直接 import 那张表：本模块要能在 node 里整体打包自检，
 * 而 useWorldEvents 会拖进 `@tauri-apps/api`（自检环境没有它）。
 */
export const FOCUS_CATEGORY_EMOJI: Record<FocusCategory, string> = {
  weather: "🌦",
  traffic: "🚦",
  social: "👥",
  work: "💼",
  health: "🩺",
  money: "💰",
  accident: "⚡",
  festival: "🎉",
  mood: "🌤",
  luck: "🍀",
};

/**
 * 聚焦态存活时长（毫秒）。
 *
 * 为什么 6 秒：气泡是 4.2 秒，聚焦是「让人看清是谁」——太短来不及看名字，
 * 太长会挡住下一次聚焦（同屏只留 `FOCUS_MAX` 条）。
 * 与气泡一样由纯函数给出，组件不许另写一个数。
 */
export const FOCUS_MS = 6_000;

/**
 * 同屏最多几条聚焦。
 *
 * 为什么是 2 而不是 4（气泡那个数）：聚焦会**压暗全场**，
 * 两条同时压已经是上限；再多就不是「聚焦」而是「满屏黑」。
 */
export const FOCUS_MAX = 2;

/**
 * 同一件事件在多长时间内不许重复触发聚焦（毫秒）。
 *
 * tick 轮询与 `world_map:event` 广播是**同一件事的两条通路**（useWorldEvents 里
 * 已有 `seenKeys` 去重），这里再兜一道是按 `类别|角色` 去重：
 * 弱网下同一件事重放时，镜头不该被拽来拽去。
 */
export const FOCUS_DEDUP_MS = 20_000;

/** 认不出的类别（老事件/脏数据）；不 import 事件层，写一份等价的即可 */
const FOCUS_CATEGORY_SET = new Set<string>(FOCUS_CATEGORIES);
/** 后端认得的十类（用来区分「日常」与「认不出」——两者的处置完全不同） */
const KNOWN_CATEGORY_SET = new Set<string>(WS_EVENT_CATEGORIES);

/**
 * 这条事件值不值得动画面。
 *
 * @param category 事件类别（脏数据一律当认不出）
 * @param hasActor 这条事件**在场上有没有对应的人**（没有就不聚焦 —— 镜头不能指向空处）
 * @returns `focus` / `bubble` / `none`
 *
 * 三档的判据顺序**不能颠倒**：
 *   ① 认不出（不在后端的十类里）→ `none`（绝不猜，也不为脏数据动画面）
 *   ② 认得出但类别不够格 → `bubble`（走原有的气泡通道，**行为一字不变**）
 *   ③ 够格但没人在场 → `bubble`（**降级而不是硬聚焦**：宁可只冒个泡，
 *      也不把镜头拉到一个空坐标上 —— 那是"看起来坏了"最典型的样子）
 *
 * ⚠️ ① 与 ② 必须分开：把「work 这类日常」也判成 `none` 的话，调用方如果拿
 * `none` 当"这件事不用管"，就会**连气泡都不冒**了 —— 那就把 P5-2 已有的通知通道
 * 悄悄砍掉了。本函数只回答"要不要**额外**动画面"。
 */
export function focusLevelOf(category: unknown, hasActor: boolean): FocusLevel {
  const c = String(category ?? "").trim();
  if (!c || !KNOWN_CATEGORY_SET.has(c)) return "none";
  if (!FOCUS_CATEGORY_SET.has(c)) return "bubble";
  if (!hasActor) return "bubble";
  return "focus";
}

/* ══════════════════════════════════════════════════════════════════
 * 一、聚焦态（数据形状 + 队列语义，全部纯函数）
 * ══════════════════════════════════════════════════════════════════ */

/** 一个正在聚焦的条目（组件按它画） */
export interface WsFocusItem {
  /** 去重键（同一件事只聚焦一次） */
  key: string;
  /** 聚焦到谁（角色名；解析不到人时为空串 —— 那种情况压根不会进队列） */
  role: string;
  /** 事件标题（铭牌上那行；空则只显示类别） */
  title: string;
  category: FocusCategory;
  /** 队列里放的**时刻**（ms）—— TTL 从这一刻算起，不是从事件发生时刻算 */
  atMs: number;
}

/** 队列 + 判定所需的全部上下文 */
export interface FocusQueueState {
  items: WsFocusItem[];
  /** 按 `key` 记的最近一次进入时刻（去重窗口用） */
  seen: Record<string, number>;
}

export const EMPTY_FOCUS_QUEUE: FocusQueueState = { items: [], seen: {} };

/** 事件 → 去重键。**只按 类别|角色|标题**，不带时间** —— 带时间就永远去重不掉了 */
export function focusKeyOf(ev: { category?: unknown; title?: unknown; role?: unknown }): string {
  const c = String(ev?.category ?? "").trim();
  const r = String(ev?.role ?? "").trim();
  const t = String(ev?.title ?? "").trim();
  return `${c}|${r}|${t}`;
}

export interface PushFocusInput {
  key: string;
  role: string;
  title?: string;
  category: FocusCategory;
  /** 现实时刻（ms）；不传取 Date.now()（自检里一律显式传，保证可复现） */
  nowMs?: number;
  /** 去重窗口（默认 [`FOCUS_DEDUP_MS`]） */
  dedupMs?: number;
  /** 同屏上限（默认 [`FOCUS_MAX`]） */
  max?: number;
}

/**
 * 把一个聚焦条目放进队列（**纯函数**：返回新状态，不改入参）。
 *
 * 三条语义（少一条都会出「镜头乱跳」或「事件丢了」）：
 *   ① 同一 `key` 在去重窗口内 → **原样返回**（调用方据此判「没变化，不用重画」）；
 *   ② 已存在同 `key` 的条目 → 只把它的 `atMs` **续期**（重新计时，不重复入队）；
 *   ③ 超过 `max` → 砍**最旧**的那条（新的更值得看），保持「最新在最后」的顺序。
 *
 * 顺序固定为「旧 → 新」：组件按顺序错开叠放（新的在上面），
 * 与 `pushBubble` 的 `slice(-cap)` 同款，避免两处顺序不一致。
 */
export function pushFocus(state: FocusQueueState | null, input: PushFocusInput): FocusQueueState {
  const cur = state || EMPTY_FOCUS_QUEUE;
  const key = String(input?.key ?? "").trim();
  if (!key || !input?.category) return cur;
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const dedup = Math.max(0, Math.trunc(Number(input.dedupMs ?? FOCUS_DEDUP_MS) || 0));
  const max = Math.max(1, Math.trunc(Number(input.max ?? FOCUS_MAX) || FOCUS_MAX));

  const last = cur.seen?.[key];
  const alive = cur.items.some((i) => i.key === key);
  // ① 去重窗口内且已经不在队列里 → 当作「这条刚放过」，不重复
  if (typeof last === "number" && nowMs - last < dedup && !alive) return cur;

  const seen: Record<string, number> = { ...(cur.seen || {}) };
  seen[key] = nowMs;
  // `seen` 别无限长：只留去重窗口内的（否则长时间挂机后这个对象会一直涨）
  for (const k of Object.keys(seen)) {
    if (nowMs - seen[k] > Math.max(dedup, FOCUS_DEDUP_MS)) delete seen[k];
  }

  const item: WsFocusItem = {
    key,
    role: String(input.role ?? "").trim(),
    title: String(input.title ?? "").trim(),
    category: input.category,
    atMs: nowMs,
  };
  // ② 同一个 key 还在队列里 → 续期（放在末尾 = 最新）
  const rest = cur.items.filter((i) => i.key !== key);
  const items = [...rest, item];
  // ③ 超上限砍最旧的
  while (items.length > max) items.shift();
  return { items, seen };
}

/**
 * 按 TTL 清掉过期的聚焦条目（**纯函数**）。
 *
 * `nowMs` 必须由调用方给：纯函数里读时钟就不能测「6 秒后到底会不会消失」。
 */
export function pruneFocus(
  state: FocusQueueState | null,
  nowMs: number,
  ttlMs = FOCUS_MS
): FocusQueueState {
  const cur = state || EMPTY_FOCUS_QUEUE;
  const ttl = Math.max(1, Math.trunc(Number(ttlMs) || FOCUS_MS));
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const items = cur.items.filter((i) => now - i.atMs < ttl);
  // 引用不变 = 没变化：下游（组件）据此省一轮 diff（与 spreadCrowdMemo 同一个思路）
  if (items.length === cur.items.length) return cur;
  return { items, seen: cur.seen };
}

/** 队列里最该被聚焦的那一条（**最后进来的** = 最新的事件）；空队列返回 null */
export function topFocus(state: FocusQueueState | null): WsFocusItem | null {
  const items = state?.items || [];
  return items.length ? items[items.length - 1] : null;
}

/** 该角色的聚焦态（可能是 null = 没被聚焦）；组件用它决定「这一枚头像要不要放大」 */
export function focusOfRole(state: FocusQueueState | null, role: string): WsFocusItem | null {
  const who = String(role || "").trim();
  if (!who) return null;
  return (state?.items || []).find((i) => i.role === who) || null;
}

/* ══════════════════════════════════════════════════════════════════
 * 二、画在哪（复用气泡那套信箱数学，绝不自己再写一遍）
 * ══════════════════════════════════════════════════════════════════ */

/** 一个聚焦条目的落点（盒子内 CSS 像素 + 缩放 + 半径） */
export interface FocusAnchor {
  x: number;
  y: number;
  /** 元素自己要写的 `1/zoom`（抵消地图手势的放大） */
  scale: number;
  /** 聚光灯亮圈的半径（**屏幕像素**，写进 CSS 变量前不参与元素缩放） */
  radius: number;
  /** 找到对应角色了吗（false → 组件退回「屏幕中央」并如实标注） */
  found: boolean;
}

/** 聚光灯亮圈占短边的比例（0.17 ≈ 932×430 的盒子里半径 ≈ 36px：正好裹住一枚 2.1em 的头像） */
export const FOCUS_RADIUS_RATIO = 0.17;

/**
 * 聚焦条目该画在哪。
 *
 * **为什么直接用 `bubbleAnchorOf`**：气泡尖压的就是头像中心（那套数学已经过
 * 三处一致性校验），聚光灯要盖的也是同一枚头像 —— 复制一份数学必然会在
 * 某次改动后与气泡错位（而且是只在非正方形盒子上错，最难查的那种）。
 * `gap = 0` 让锚点正好落在头像中心（气泡默认的 16px 上抬是给气泡尖留的）。
 */
export function focusAnchorOf(
  actor: { gx?: unknown; gy?: unknown; px?: unknown; py?: unknown } | null | undefined,
  boxW: number,
  boxH: number,
  grid = 28,
  zoom = 1,
  ratio = FOCUS_RADIUS_RATIO
): FocusAnchor {
  const w = Math.max(1, Number(boxW) || 1);
  const h = Math.max(1, Number(boxH) || 1);
  const k = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1;
  const r = Math.max(8, Math.min(w, h) * (Number.isFinite(ratio) ? Number(ratio) : FOCUS_RADIUS_RATIO));
  const base = bubbleAnchorOf(actor, w, h, grid, k, 0);
  return { x: base.x, y: base.y, scale: base.scale, radius: r, found: base.found };
}

/* ══════════════════════════════════════════════════════════════════
 * 三、镜头（只算「该挪多少」，不负责真挪）
 * ══════════════════════════════════════════════════════════════════ */

export interface CameraOffset {
  /** 想让目标落到视口中央所需的平移量（屏幕像素；正数 = 内容往右/下挪） */
  dx: number;
  dy: number;
  /** 目标此刻在视口外吗（组件据此画「指向箭头」，让人知道人在画面外） */
  offscreen: boolean;
}

/** 视口外扩多少就算「在画面外」（像素）——留点余量，压边的头像也算看得见 */
export const VIEW_PAD_PX = 24;

/**
 * 把目标点挪到视口中央需要平移多少。
 *
 * @param target 目标在**视口坐标**里的位置（`getBoundingClientRect` 那种）
 * @param viewport 视口尺寸
 * @param pad 边缘余量（默认 [`VIEW_PAD_PX`]）
 *
 * ⚠️ 返回 `{dx:0, dy:0}` 的两种情况**在下游要区别对待**：
 *   · `offscreen:false` = 本来就在画面里 → **不挪**（镜头老是动会晕，这是产品口径）；
 *   · `offscreen:true` 且 dx/dy 都是 0 = 视口尺寸量不出来（退化态）→ 也别挪。
 *   两者都返回 0 是**故意**的：宁可不动，也不要基于错数据乱动。
 */
export function cameraOffsetFor(
  target: { x: number; y: number } | null | undefined,
  viewport: { w: number; h: number },
  pad = VIEW_PAD_PX
): CameraOffset {
  const w = Number(viewport?.w);
  const h = Number(viewport?.h);
  const tx = Number(target?.x);
  const ty = Number(target?.y);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { dx: 0, dy: 0, offscreen: false };
  }
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return { dx: 0, dy: 0, offscreen: false };
  const p = Math.max(0, Number(pad) || 0);
  const inside = tx >= -p && tx <= w + p && ty >= -p && ty <= h + p;
  if (inside) return { dx: 0, dy: 0, offscreen: false };
  return { dx: Math.round(w / 2 - tx), dy: Math.round(h / 2 - ty), offscreen: true };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、头像：真壳命令 vs 浏览器降级（P2-1 的缺口，T4-3 必须如实说清）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这一枚头像长什么样。
 *   · `image`  = 真的拿到了图（只有真壳的 `get_avatar_file` 能走到）
 *   · `letter` = LingChat 角色，但**图拿不到** → 首字母色块占位（浏览器预览就是这一档）
 *   · `plain`  = 路人：一个纯色圆点，**不假装有头像**
 */
export type AvatarMode = "image" | "letter" | "plain";

/** 头像为什么是占位（只有 `letter` 档有意义；用于 title/角标文案） */
export type AvatarFallback = "" | "nofile" | "browser";

export interface AvatarPlan {
  mode: AvatarMode;
  initial: string;
  fallback: AvatarFallback;
  /** 视觉区分：LingChat 角色点要略大 + 有描边（卡片第 2 条硬要求） */
  ring: "char" | "plain";
}

/** 取显示名的首字母/首字（空名 → `?`；emoji/代理对不会被切半） */
export function initialOf(name: unknown): string {
  const s = String(name ?? "").trim();
  if (!s) return "?";
  // `Array.from` 按码点切，不会把 emoji 劈成两半（`s[0]` 会）
  return Array.from(s)[0] || "?";
}

/**
 * 这一枚头像该怎么画（**纯函数**，卡片第 2 条要求的判据全在这里）。
 *
 * @param actor 至少有 `isMe` / `folder` 两个字段（`MapActor` 的形状）
 * @param hasAvatarUrl 传进来的 `avatarUrl` 是不是**真的**有值（非空白字符串）
 * @param tauri 当前是不是真壳（`isTauriRuntime()`）；浏览器预览为 false
 *
 * 三档的判据（顺序不能反）：
 *   ① 有 URL → `image`（不管是不是真壳：玩家自己上传的 data URL 在浏览器里就有）
 *   ② 是 LingChat 角色（有 `folder`）但没 URL：
 *        · 真壳 → `nofile`（**这个角色确实没有头像文件**，不是我们拿不到）
 *        · 浏览器 → `browser`（**通路限制**：`get_avatar_file` 是真壳命令）
 *      两者都必须画首字母占位 + 在界面上说清原因，**绝不画假头像**。
 *   ③ 其余（路人）→ `plain`：一个纯色圆点。
 *
 * ⚠️ 玩家自己（`isMe`）永远走 ②/③ 的**占位**分支，不套 `plain` 的「路人」语义
 *    （玩家没有头像文件是正常状态，不是"这个人不存在"）。
 */
export function avatarPlanOf(
  actor: { isMe?: boolean; folder?: string; name?: string } | null | undefined,
  hasAvatarUrl: boolean,
  tauri: boolean
): AvatarPlan {
  const initial = initialOf(actor?.name);
  if (hasAvatarUrl) return { mode: "image", initial, fallback: "", ring: "char" };
  const isMe = !!actor?.isMe;
  const isChar = isMe || !!String(actor?.folder || "").trim();
  if (!isChar) return { mode: "plain", initial, fallback: "", ring: "plain" };
  return tauri
    ? { mode: "letter", initial, fallback: "nofile", ring: "char" }
    : { mode: "letter", initial, fallback: "browser", ring: "char" };
}

/**
 * 占位原因 → 给 `title` 用的一句话（**结构化返回，不在这里拼 i18n 键**）。
 *
 * 为什么不让纯函数返回中文：模板纪律是"一个中文都不许有"（见 WsEventFeed 头注释）。
 * 所以这里只给 `{ key, fallback }`：键给 i18n 用，`fallback` 是**兜底文案**，
 * 万一词条还没加（T4-3 不许改 locale 文件）也不会空着 —— 界面上必须说清原因。
 */
export function avatarFallbackText(fb: AvatarFallback): { key: string; fallback: string } {
  if (fb === "browser")
    return { key: "worldsim.avatar.needShell", fallback: "头像需真壳命令 get_avatar_file（浏览器通路拿不到）" };
  if (fb === "nofile")
    return { key: "worldsim.avatar.noFile", fallback: "这个角色没有头像文件（真壳命令已试过）" };
  return { key: "", fallback: "" };
}

/* ══════════════════════════════════════════════════════════════════
 * 五、Vue 侧薄壳（composable）—— 只有「什么时候调纯函数」的编排，没有逻辑
 * ══════════════════════════════════════════════════════════════════ */

export interface UseWsFocusOptions {
  /** 同屏上限（默认 [`FOCUS_MAX`]） */
  max?: number;
  /** 存活时长（默认 [`FOCUS_MS`]） */
  ttlMs?: number;
  /**
   * 浏览器验证钩子：监听 `window` 上的 `ws:focus-demo` 自定义事件，
   * 用**假角色名**点亮一次聚焦态。
   *
   * 为什么需要它（不是给用户用的）：web 预览里 `world_map_tick` 一律不存在
   * （`useWorldEvents.supported === false`）⇒ 浏览器里**永远不会**有真事件，
   * 「聚光灯光学对不对、铭牌会不会被裁掉」就一条都验不了 —— 与机主
   * 「所有改动都要能第一时间在浏览器验证」直接冲突。
   * 这个钩子**只在预览里手动派发**（真壳里没人会派发这个事件），
   * 且它点亮的每一个条目都带 `demo: true` 标记 → 组件会如实标注「演示」。
   */
  demo?: boolean;
}

/**
 * 聚焦态的状态机（薄壳）。
 *
 * 只做三件事：① 收 `focusEvent()` 调用 → 过纯函数队列；② 起一个 TTL 定时器
 * 把过期的清掉；③ 把队列暴露成响应式。
 * 判定（`focusLevelOf`）、几何（`focusAnchorOf`）全在纯函数里 —— 这一层不许长逻辑。
 */
export function useWsFocus(opts: UseWsFocusOptions = {}) {
  const queue = ref<FocusQueueState>({ items: [], seen: {} });
  const ttlMs = Math.max(1, Math.trunc(Number(opts.ttlMs ?? FOCUS_MS) || FOCUS_MS));
  const max = Math.max(1, Math.trunc(Number(opts.max ?? FOCUS_MAX) || FOCUS_MAX));

  let timer: number | null = null;
  function arm() {
    if (timer !== null) window.clearTimeout(timer);
    // 到点就 prune；若是清空了队列，就自然停表（有下一件事时再武装）
    timer = window.setTimeout(() => {
      timer = null;
      const next = pruneFocus(queue.value, Date.now(), ttlMs);
      if (next !== queue.value) queue.value = next;
      if (queue.value.items.length) arm();
    }, ttlMs + 32);
  }
  function disarm() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  /**
   * 一条事件到了。
   *
   * @returns 真的聚焦了吗（`false` = 这条不够格/没人在场/在去重窗口里）
   *
   * ⚠️ `hasActor` 由调用方给（页面知道名单里有没有这个人 —— 纯函数不碰名单）。
   */
  function focusEvent(ev: {
    category: unknown;
    role?: string;
    title?: string;
    hasActor: boolean;
    nowMs?: number;
  }): boolean {
    if (focusLevelOf(ev?.category, !!ev?.hasActor) !== "focus") return false;
    const before = queue.value;
    const next = pushFocus(before, {
      key: focusKeyOf(ev),
      role: String(ev.role || ""),
      title: String(ev.title || ""),
      category: ev.category as FocusCategory,
      nowMs: ev.nowMs,
      max,
    });
    if (next === before) return false;
    queue.value = next;
    arm();
    return true;
  }

  /** 立即清空（离开页面/换地图时用，别让上一张图的聚焦态飘到下一张） */
  function clearFocus() {
    disarm();
    if (queue.value.items.length) queue.value = { items: [], seen: queue.value.seen };
  }

  /* ── 浏览器验证钩子（见 UseWsFocusOptions.demo 的说明）────────────────── */
  if (opts.demo && typeof window !== "undefined") {
    const onDemo = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const role = String(d.role || "").trim();
      if (!role) return;
      // 演示一律按「够格的类别」注入：验的是光学，不是判据（判据由自检脚本覆盖）
      const cat = (FOCUS_CATEGORY_SET.has(String(d.category))
        ? String(d.category)
        : "accident") as FocusCategory;
      const next = pushFocus(queue.value, {
        key: `demo|${role}|${String(d.title || "")}`,
        role,
        title: String(d.title || ""),
        category: cat,
        max,
      });
      queue.value = next;
      arm();
    };
    window.addEventListener("ws:focus-demo", onDemo);
    onBeforeUnmount(() => window.removeEventListener("ws:focus-demo", onDemo));
  }

  onBeforeUnmount(disarm);

  return {
    /** 聚焦队列（旧 → 新） */
    queue: queue as Ref<FocusQueueState>,
    focusEvent,
    clearFocus,
    /** 给模板用的派生值（模板只对顶层 ref 自动解包） */
    top: () => topFocus(queue.value),
    ofRole: (role: string) => focusOfRole(queue.value, role),
  };
}
