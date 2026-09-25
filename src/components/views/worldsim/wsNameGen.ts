// 「世界模拟」· **生成名层**（示意，非真实）—— 纯逻辑，不 import vue / 不碰 DOM / 不碰网络
//
// 机主 2026-09-26 批准：「每栋楼注明名字（**包括一些小摊**）」，并选了「都要」。
// 🔴 **红线（写在代码里，谁都别绕）**：
//   ① 生成名**不是事实** —— 显示时必须与真名**样式不同**，HUD 要如实写「真名 N / 生成 M」；
//   ② 生成名**绝不进数据层、绝不进对话上下文**（不进 `/namesbundle`、不进发给 LingChat 的消息文本）；
//   ③ 生成名**必须确定性**：同一个 id ⇒ 永远同一个名字（机主对楼房的要求是「永远不变」，
//      名字跟着楼走，不能拖一下地图就换一个）。
//
// 为什么要有这一层：实测**真名根本不够** ——
//   · 我们自己的楼房包 720,087 栋里**一个名字都没有**（源的属性只有 class/height/id/src/subtype）；
//   · OSM/Overpass 在解放碑核心 0.4km² 只有 19 栋有名字，摊位 0；
//   · Overture places 通道的覆盖数字**还没测出来**（见 `world_map/probe_places.py`）。
// ⇒ 「每栋楼都有名字」在真数据下做不到，只能生成 + 如实标注。

/** HUD/文案里统一用的标注词（说明这批名字是生成的） */
export const WS_GEN_TAG = "生成·示意";

/** 名字素材：前缀（地名/姓氏/方位）——**只用通用词**，不影射任何真实商家 */
const PREFIX = [
  "老街", "巷口", "三元", "李家", "张记", "王姐", "陈氏", "转角", "南门", "北巷",
  "桥头", "半边街", "小院", "新华", "民主", "建设", "和平", "长江", "嘉陵", "山城",
];
/** 门店品类 */
const SHOP = [
  "小面", "抄手", "火锅", "串串", "茶馆", "理发", "药房", "烟酒", "五金", "裁缝",
  "文具", "水果", "早餐", "卤味", "凉菜", "炒货", "糖水", "奶茶", "糕点", "照相",
  "洗衣", "快递代收", "杂货", "粮油", "修车", "锁匠", "钟表", "花店", "布艺", "家电维修",
];
/** 摊位品类（比门店更"轻"：无堂食/无门面感） */
const STALL = [
  "烤红薯", "糖炒栗子", "凉粉", "豆花", "冰粉", "煎饼", "油茶", "锅盔", "串串香", "酸辣粉",
  "手工糍粑", "鲜榨果汁", "烤玉米", "卤鸭脖", "炸洋芋", "抄手皮", "麻花", "糍粑块", "凉虾", "棉花糖",
];
const SUFFIX = ["店", "铺", "馆", "行", "坊", "屋", "站"];

/**
 * 稳定哈希（32 位，FNV-1a 变体）——**自己实现**，不用 `Math.random`、不用时间：
 * 同一个 id 在任何设备、任何时刻都必须得到同一个数（生成名的确定性就靠它）。
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export type GenKind = "shop" | "stall";

/** 一个生成出来的名字（带出处 id，便于核验与去重） */
export interface GenNamed {
  id: string;
  name: string;
  kind: GenKind;
}

/**
 * 生成一个名字：`前缀 + 品类 (+ 后缀)`，全部由 `id` 决定（**同 id ⇒ 同名**）。
 * `kind="stall"` 时不加后缀（摊子没门面），并且从摊位品类里取词。
 */
export function genName(id: string, kind: GenKind = "shop"): string {
  const h = hash32(String(id ?? "") + "|" + kind);
  const p = PREFIX[h % PREFIX.length];
  if (kind === "stall") {
    const s = STALL[(h >>> 8) % STALL.length];
    return p + s;
  }
  const s = SHOP[(h >>> 8) % SHOP.length];
  const suf = SUFFIX[(h >>> 16) % SUFFIX.length];
  return p + s + suf;
}

/**
 * 从一批 id 里挑 `cap` 个生成名字。
 *
 * 为什么不是"随便挑 cap 个"：**要铺得开**（同一片地方不能 40 个标签挤在一起），
 * 所以按 id 的哈希排序后**均匀取样**（等价于按哈希分层抽样），并且顺序**只由 id 决定**
 * （视野变了、拖动地图都不会让已显示的名字换人）。
 */
export function planGenNames(ids: readonly string[], cap: number, kind: GenKind = "shop"): GenNamed[] {
  const list = (ids || []).map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  if (n === 0 || list.length === 0) return [];
  const uniq = Array.from(new Set(list));
  const sorted = uniq
    .map((id) => ({ id, k: hash32(id + "|pick|" + kind) }))
    .sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 均匀取样（不是取前 n 个：前 n 个都在哈希空间的一端 ⇒ 空间上会挤在一片）
  const out: GenNamed[] = [];
  const take = Math.min(n, sorted.length);
  for (let i = 0; i < take; i++) {
    const idx = Math.floor((i * sorted.length) / take);
    const it = sorted[idx];
    out.push({ id: it.id, name: genName(it.id, kind), kind });
  }
  return out;
}

/** 一条路（只用到 id 与折线坐标）——小摊沿它铺 */
export interface GenRoad {
  id: string;
  /** 折线：[[lng,lat], …]（至少两个点） */
  coords: readonly (readonly number[])[];
}

/**
 * 沿街面**程序化生成小摊**（摊子在任何公开数据里都不存在 ⇒ 只能生成，且必须标注）。
 *
 * 做法：每条路按 id 决定性地取 `perRoad` 个点（在折线上按比例插值），
 * 左右各偏一点（**退到街边**，别摆到路中间），名字走 `genName(id, "stall")`。
 * 只取前 `cap` 个（同样按哈希抽样，铺得开）。
 */
export function planStalls(roads: readonly GenRoad[], cap: number, perRoad = 2): { id: string; name: string; lng: number; lat: number }[] {
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  if (n === 0) return [];
  const per = Math.max(1, Math.trunc(perRoad) || 1);
  const picked: { id: string; name: string; lng: number; lat: number; k: number }[] = [];
  for (const r of roads || []) {
    const cs = (r?.coords || []).filter((c) => Array.isArray(c) && c.length >= 2);
    if (cs.length < 2) continue;
    for (let j = 0; j < per; j++) {
      const h = hash32(`${r.id}|stall|${j}`);
      const t = ((h % 1000) / 1000) * 0.9 + 0.05;            // 5%~95% 处，避开端点（路口）
      const seg = Math.min(cs.length - 2, Math.floor(t * (cs.length - 1)));
      const local = t * (cs.length - 1) - seg;
      const a = cs[seg], b = cs[seg + 1];
      const lng = Number(a[0]) + (Number(b[0]) - Number(a[0])) * local;
      const lat = Number(a[1]) + (Number(b[1]) - Number(a[1])) * local;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      /* 街边退距：**垂直于该路段**（沿法向偏 ~4m）——
         原来一律偏经度，东西向的路等于"没退开、还摆在路中间"（自检抓到）。 */
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;                    // 单位法向（度空间，本尺度够用）
      const dLat = 4 / 110540;                                 // 4m → 纬度
      const dLng = 4 / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
      const sign = (h >>> 12) % 2 ? 1 : -1;
      const id = `${r.id}#s${j}`;
      picked.push({ id, name: genName(id, "stall"), lng: lng + nx * sign * dLng, lat: lat + ny * sign * dLat, k: hash32(id + "|pick") });
    }
  }
  picked.sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const take = Math.min(n, picked.length);
  const out: { id: string; name: string; lng: number; lat: number }[] = [];
  for (let i = 0; i < take; i++) {
    const it = picked[Math.floor((i * picked.length) / take)];
    out.push({ id: it.id, name: it.name, lng: it.lng, lat: it.lat });
  }
  return out;
}

/** HUD 一行：真名/生成如实分开写（**不许把它们混成一个数**） */
export function genCountsLine(realShown: number, genShown: number, stallsShown: number): string {
  const r = Number.isFinite(realShown) ? String(realShown) : "数不出来";
  const g = Number.isFinite(genShown) ? String(genShown) : "数不出来";
  const s = Number.isFinite(stallsShown) ? String(stallsShown) : "数不出来";
  return `🏷 真名 ${r} · ${WS_GEN_TAG} 楼名 ${g} · ${WS_GEN_TAG} 小摊 ${s}`;
}
