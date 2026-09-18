// 「世界模拟」P2-5「送礼物」——**方案 B（走物品栏）的最保守落地**
//
// ── 机主的口径（卡片 t-mty7jr5l-8joh98 评论 · 2026-09-12 拍板）─────────────────
//   方案 A 走「关系」（凭空造一个后端关系值系统）❌
//   方案 B 走「物品栏」：玩家维护礼物清单，送时挑一件、扣一件、写记忆 + 触发事件 ✅
//   选 B 的理由：地图上本来就有商店类设施（`facilities.rs` 的 `commercial` 等），
//   可以走「**地图商店 → 背包 → 送人**」这条闭环，符合「完全模拟现实」的总体设想。
//
// ── 但**货币**这一条机主还没定（同一张卡上写着「需要机主再定一次」）────────────
//   所以本文件按**最保守**口径落地，并把「没接入的」如实写在 UI 上，绝不假装：
//   ✅ 真的做：
//       ① 本机持久化的礼物清单（localStorage `wsm:v1:gifts`，4 语言文案见 GIFT_TEXT）
//       ② 来源 = **地图上真实的设施表**（runtime.facilities，走 wsIntervene 的解析契约）
//          —— 只认「店」：关键词命中或 commercial/leisure 兜底，医院/学校/派出所不卖礼物
//       ③ 送出 = 扣一件 + 本机记账 + 面板里看得见 + toast 反馈（点了一定有反应）
//   ❌ 未接入（不明说会变成骗人）：
//       · 货币系统（所以这一版是「商店里直接获得」，机主原话给的过渡口径）
//       · 后端物品表 / 背包接口
//       · **写进角色记忆 / 触发现实事件** —— 前端根本没有这条通路：
//         Rust 侧 `commit_event` 只被 `world_map_tick`（随机摇号）调用，
//         没有任何 Tauri 命令或 HTTP 端点能让前端**提交一条自定义事件**。
//         ⇒ 这一步只能等主会话在 `WorldSim.vue` 里接 `WsCharPanel` 的 `@gift`（接线点写在
//           卡片评论里），或者在 Rust 侧加一条 `world_map_gift_send` 命令。
//
// 依赖纪律：只 import `./wsIntervene`（它只 import vue + ./wsActors，都没有 `@/` 别名）
//           ⇒ `wsgift_selftest.mjs` 里 esbuild 直接打包即可，不需要配别名（同 wsPerf.ts）。

import { ref, type Ref } from "vue";
import { facilityList } from "./wsIntervene";

/* ══════════════════════════════════════════════════════════════════
 * 一、形状与常量
 * ══════════════════════════════════════════════════════════════════ */

/** 一件礼物长什么样（只有名字与图标 —— 没有后端物品表，所以这里是唯一的定义处） */
export interface WsGiftDef {
  name: string;
  icon: string;
}

/** 背包里的一行（同名的礼物合成一行，count 是件数） */
export interface WsGiftItem {
  id: string;
  name: string;
  icon: string;
  count: number;
  /** 从哪家店拿的（如实展示来源，别假装是"买的"） */
  from: string;
}

/** 送出记录（本机账本；将来接记忆时它就是"待写记忆"的素材） */
export interface WsGiftSent {
  id: string;
  name: string;
  icon: string;
  /** 收礼的角色名（后端以名字为键，与日程/记忆一致） */
  role: string;
  /** 毫秒时间戳（0 = 没记到） */
  at: number;
}

export interface WsGiftStore {
  v: number;
  items: WsGiftItem[];
  sent: WsGiftSent[];
}

/** 一家能拿礼物的店（设施名 + 它给的礼物） */
export interface WsGiftShop {
  key: string;
  place: string;
  type: string;
  gift: WsGiftDef;
}

/** localStorage 键（与 `wsm:v1:*` 那批同族；`v1` 是形状版本） */
export const WS_GIFT_KEY = "wsm:v1:gifts";
export const GIFT_STORE_V = 1;
/** 背包最多几种（防止一份坏存储把面板撑爆） */
export const GIFT_KIND_MAX = 24;
/** 同一种最多几件 */
export const GIFT_COUNT_MAX = 99;
/** 送出账本最多留几条 */
export const GIFT_SENT_MAX = 20;
/** 面板上回显最近几条 */
export const GIFT_SENT_SHOW = 3;

/* ══════════════════════════════════════════════════════════════════
 * 二、设施 → 礼物（**顺序即优先级**，先命中的赢）
 * ══════════════════════════════════════════════════════════════════ */

const BY_KEYWORD: ReadonlyArray<readonly [string, WsGiftDef]> = [
  ["便利店", { name: "零食大礼包", icon: "🍫" }],
  ["生鲜", { name: "水果篮", icon: "🍎" }],
  ["超市", { name: "水果篮", icon: "🍎" }],
  ["水果", { name: "水果篮", icon: "🍎" }],
  ["百货", { name: "玩偶", icon: "🧸" }],
  ["购物中心", { name: "香水", icon: "🌸" }],
  ["商铺", { name: "小饰品", icon: "🎀" }],
  ["花", { name: "鲜花", icon: "💐" }],
  ["咖啡", { name: "手冲咖啡", icon: "☕" }],
  ["茶馆", { name: "茶叶", icon: "🍵" }],
  ["面包", { name: "面包", icon: "🥐" }],
  ["蛋糕", { name: "蛋糕", icon: "🎂" }],
  ["书店", { name: "一本书", icon: "📖" }],
  ["图书馆", { name: "一本书", icon: "📖" }],
  ["电影", { name: "电影票", icon: "🎬" }],
  ["邮政", { name: "明信片", icon: "✉️" }],
  ["药房", { name: "维生素", icon: "💊" }],
];

/**
 * 没命中关键词时按**设施类型**兜底。
 *
 * ⚠️ 只有 `commercial`（商业）与 `leisure`（休闲娱乐）算「店」——
 * 住宅/教育/医疗/市政/交通一律返回 null（**不卖礼物**）。
 * 这是有意的：派出所、消防站、医院不卖东西，硬塞一件礼物就成假数据了。
 */
const BY_TYPE: Record<string, WsGiftDef> = {
  commercial: { name: "小礼物", icon: "🎁" },
  leisure: { name: "体验券", icon: "🎟" },
};

/**
 * 这家店卖什么（不认识就 null）。
 *
 * 名字为空 → **null**（连名字都没有的东西不该被当成一家店；`shopList` 也在更上游
 * 用 `facilityList` 丢过一遍无名设施，这里再守一道）。
 * 类型兜底只对**有名字**的店生效。
 */
export function giftOfFacility(name: unknown, type: unknown): WsGiftDef | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  for (const [kw, def] of BY_KEYWORD) {
    if (n.includes(kw)) return def;
  }
  return BY_TYPE[String(type ?? "").trim()] || null;
}

/** 背包行的稳定 id（同名 = 同一行） */
export function itemIdOf(name: string): string {
  return "g:" + String(name ?? "").trim();
}

function shopKeyOf(place: string): string {
  return "s:" + String(place ?? "").trim();
}

/**
 * 从 runtime 的设施表里挑出「能拿礼物的店」。
 *
 * 解析契约复用 `wsIntervene.facilityList`（`{"name","type","grid":[x,y]}` 或 `x`/`y`），
 * **不在这里重写一份** —— 两份解析一定会漂移。
 * 同名商店只列一行（地图上常有 3 家「便利店」，列 3 行只会让人疑惑）。
 */
export function shopList(facilities: unknown): WsGiftShop[] {
  const out: WsGiftShop[] = [];
  for (const f of facilityList(facilities)) {
    const gift = giftOfFacility(f.name, f.type);
    if (!gift) continue;
    const key = shopKeyOf(f.name);
    if (out.some((s) => s.key === key)) continue;
    out.push({ key, place: f.name, type: f.type, gift });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、存储（纯函数，可自检）
 * ══════════════════════════════════════════════════════════════════ */

export function emptyStore(): WsGiftStore {
  return { v: GIFT_STORE_V, items: [], sent: [] };
}

/** 件数夹紧：0 = 丢掉这一行；上限 99（坏存储不许把数字撑到 1e9） */
export function clampCount(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(GIFT_COUNT_MAX, n);
}

/**
 * 解析存储。**任何坏输入都退化成空背包**，绝不抛异常 ——
 * 一份坏 JSON 不能让「世界模拟」整页打不开（同 useWorldSim.readSaved 的纪律）。
 */
export function parseStore(raw: string | null | undefined): WsGiftStore {
  const s = String(raw ?? "").trim();
  if (!s) return emptyStore();
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return emptyStore();
  }
  if (!obj || typeof obj !== "object") return emptyStore();
  const o = obj as Record<string, unknown>;

  const items: WsGiftItem[] = [];
  const rawItems = Array.isArray(o.items) ? o.items : [];
  for (const raw of rawItems) {
    if (items.length >= GIFT_KIND_MAX) break;
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const name = String(it.name ?? "").trim();
    const count = clampCount(it.count);
    if (!name || !count) continue;
    const id = String(it.id ?? "").trim() || itemIdOf(name);
    if (items.some((x) => x.id === id)) continue;
    items.push({
      id,
      name,
      icon: String(it.icon ?? "").trim() || "🎁",
      count,
      from: String(it.from ?? "").trim(),
    });
  }

  const sent: WsGiftSent[] = [];
  const rawSent = Array.isArray(o.sent) ? o.sent : [];
  for (const raw of rawSent) {
    if (sent.length >= GIFT_SENT_MAX) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? "").trim();
    const role = String(r.role ?? "").trim();
    if (!name || !role) continue;
    sent.push({
      id: String(r.id ?? "").trim() || itemIdOf(name),
      name,
      icon: String(r.icon ?? "").trim() || "🎁",
      role,
      at: Number(r.at) || 0,
    });
  }

  return { v: GIFT_STORE_V, items, sent };
}

export function serializeStore(store: WsGiftStore): string {
  return JSON.stringify({ v: GIFT_STORE_V, items: store.items, sent: store.sent });
}

/** 拿一件进背包（同名累加；种类到上限时 `reason="full"`，**不做任何写入**） */
export function addItem(
  store: WsGiftStore,
  gift: WsGiftDef,
  from = ""
): { store: WsGiftStore; item: WsGiftItem | null; reason: "" | "full" | "bad" } {
  const name = String(gift?.name ?? "").trim();
  if (!name) return { store, item: null, reason: "bad" };
  const id = itemIdOf(name);
  const items = store.items.map((x) => ({ ...x }));
  const hit = items.find((x) => x.id === id);
  if (hit) {
    hit.count = clampCount(hit.count + 1);
    return { store: { ...store, items }, item: { ...hit }, reason: "" };
  }
  if (items.length >= GIFT_KIND_MAX) return { store, item: null, reason: "full" };
  const item: WsGiftItem = {
    id,
    name,
    icon: String(gift?.icon ?? "").trim() || "🎁",
    count: 1,
    from: String(from ?? "").trim(),
  };
  items.push({ ...item });
  return { store: { ...store, items }, item, reason: "" };
}

/** 扣一件（扣到 0 就把这一行去掉）；`item.count` 恒为 1 = 「扣掉的那一件」 */
export function takeItem(
  store: WsGiftStore,
  id: string
): { store: WsGiftStore; item: WsGiftItem | null } {
  const items = store.items.map((x) => ({ ...x }));
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { store, item: null };
  const it = items[i];
  it.count -= 1;
  if (it.count <= 0) items.splice(i, 1);
  return { store: { ...store, items }, item: { ...it, count: 1 } };
}

/**
 * 送出一件：**先扣后记账**（原子地在纯函数里完成，组件只负责 toast 与文案）。
 *
 * `reason`：`ok` = 送成了；`norole` = 没选角色（含「送给自己」）；
 * `empty` = 背包里已经没有这一件了（并发/连点时会遇到，绝不假装成功）。
 */
export function sendGift(
  store: WsGiftStore,
  id: string,
  role: string,
  at = 0
): { store: WsGiftStore; sent: WsGiftSent | null; reason: "ok" | "empty" | "norole" } {
  const who = String(role ?? "").trim();
  if (!who) return { store, sent: null, reason: "norole" };
  const t = takeItem(store, String(id ?? ""));
  if (!t.item) return { store, sent: null, reason: "empty" };
  const rec: WsGiftSent = {
    id: t.item.id,
    name: t.item.name,
    icon: t.item.icon,
    role: who,
    at: Number(at) || 0,
  };
  const sent = [rec, ...t.store.sent].slice(0, GIFT_SENT_MAX);
  return { store: { ...t.store, sent }, sent: rec, reason: "ok" };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、文案（**兜底表**）
 *
 * 为什么不写进 `src/locales/zh-CN/worldsim.ts`：本轮任务边界只允许改
 * `worldsim/` 下的 Ws* 组件与新建模块（三个代理并行，共享的 locales 是冲突高发区）。
 * 组件里用 `te() ? t() : 兜底` 取值 —— 与 `locales/schema-i18n.ts` 的先例一致：
 * **词条存在就用词条，不存在回落中文原文**。等主会话把 `worldsim.giftx.*` 补进
 * locales 后，这里自动让位（本文件一行都不用改）。
 * ⚠️ 另有两条**旧词条已经不成立**了（`worldsim.gift.title/lead/optA/optB/footer` 还写着
 *   「方案还没定」），本组件一律不再引用它们；`worldsim.action.hint` 同理。
 * ══════════════════════════════════════════════════════════════════ */

export const GIFT_TEXT: Record<string, string> = {
  // 快捷动作那一行下面的说明（替换掉"送礼物还没定方案"那句已经不成立的话）
  actionsHint:
    "打招呼 = 跳到聊天（不动你现有的对话记录）；约他出门 = 他动身来找你；送礼物 = 从地图上的商店拿一件送给他。",
  // 弹层
  title: "送礼物",
  close: "关闭",
  lead: "礼物清单存在本机（只在这台设备上）。货币系统还没定 —— 所以现在从地图上的商店免费拿一件，先不引入货币。",
  bag: "背包",
  bagEmpty: "背包是空的：在下面从地图上的商店拿一件。",
  bagHint:
    "在角色面板的「送礼物」里挑一件送给他；礼物从地图上的商店拿（货币系统还没定，所以现在是免费拿）。已送出 {n} 次（只在本机记账）。",
  shops: "地图上的商店",
  shopsEmpty: "没有拿到商店清单（还没进到小区图？）—— 进了小区，便利店 / 超市这类设施会出现在这里。",
  get: "拿一件",
  send: "送出",
  gotOne: "已放进背包：{icon} {name}",
  bagFull: "背包到上限了（{n} 种），先送掉几件再来拿",
  sentOk: "已送出：{icon} {name} → {role}",
  sentEmpty: "背包里已经没有这一件了",
  sentNoRole: "这一件送不了：先选一个角色（这是你自己）",
  history: "最近送出",
  historyEmpty: "还没送过礼物",
  me: "这是你自己 —— 礼物只能送给别人。",
  noRoleId: "ta 没有角色库 ID：将来接「写记忆」时也写不进去（现在只在本机记账）。",
  notWired:
    "未接入（不假装成功）：货币系统 / 后端物品表 / 写进角色记忆与事件引擎 —— 这三样目前都没有通路，所以送出只在本机记账，角色还不会真的「收到」。",
};

/** `{name}` 这种占位替换（纯函数，自检里有断言；参数缺了就原样留着，别抹成空白） */
export function fillText(text: string, params?: Record<string, string | number>): string {
  const s = String(text ?? "");
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** 毫秒时间戳 → `HH:MM`（0 / 坏值 → 空串，宁可什么都不显示也不显示 1970） */
export function clockText(at: number): string {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ══════════════════════════════════════════════════════════════════
 * 五、模块级单例（角色面板与「我的面板」读到的是同一份）
 * ══════════════════════════════════════════════════════════════════ */

const items = ref<WsGiftItem[]>([]);
const sent = ref<WsGiftSent[]>([]);
let booted = false;

function hasLS(): boolean {
  return typeof localStorage !== "undefined" && !!localStorage;
}
function readLS(key: string): string | null {
  try {
    return hasLS() ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function writeLS(key: string, val: string): void {
  try {
    if (hasLS()) localStorage.setItem(key, val);
  } catch {
    /* 写不进去就只在本次会话生效（同 useWsIntervene 的纪律） */
  }
}

function boot(): void {
  if (booted) return;
  booted = true;
  const s = parseStore(readLS(WS_GIFT_KEY));
  items.value = s.items;
  sent.value = s.sent;
}

function persist(): void {
  writeLS(WS_GIFT_KEY, serializeStore({ v: GIFT_STORE_V, items: items.value, sent: sent.value }));
}

export interface WsGifts {
  /** 背包（响应式；只读语义 —— 改动一律走 obtain/send） */
  items: Ref<WsGiftItem[]>;
  /** 送出账本（最新在前） */
  sent: Ref<WsGiftSent[]>;
  /** 拿一件（`from` = 哪家店） */
  obtain: (
    gift: WsGiftDef,
    from?: string
  ) => { ok: boolean; item: WsGiftItem | null; reason: "" | "full" | "bad" };
  /** 送出一件给 `role` */
  send: (
    role: string,
    id: string
  ) => { ok: boolean; sent: WsGiftSent | null; reason: "ok" | "empty" | "norole" };
  /** 从存储重读（跨标签页/别的组件刚改过时用） */
  reload: () => void;
}

export function useWsGifts(): WsGifts {
  boot();
  const snapshot = (): WsGiftStore => ({
    v: GIFT_STORE_V,
    items: items.value,
    sent: sent.value,
  });
  return {
    items,
    sent,
    obtain(gift, from = "") {
      const r = addItem(snapshot(), gift, from);
      if (!r.reason) {
        items.value = r.store.items;
        persist();
      }
      return { ok: !r.reason, item: r.item, reason: r.reason };
    },
    send(role, id) {
      const r = sendGift(snapshot(), id, role, Date.now());
      items.value = r.store.items;
      sent.value = r.store.sent;
      if (r.reason === "ok") persist();
      return { ok: r.reason === "ok", sent: r.sent, reason: r.reason };
    },
    reload() {
      const s = parseStore(readLS(WS_GIFT_KEY));
      items.value = s.items;
      sent.value = s.sent;
    },
  };
}
