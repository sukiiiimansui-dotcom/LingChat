// 「世界模拟」T4-3：**头像缓存** —— 纯逻辑（不 import vue / 不碰网络 / 不碰 DOM）
//
// 卡片第 4 条的原话：「头像缓存：同一角色同表情不要重复取（内存 Map），表情变化时再取」。
//
// 为什么值得单独一个文件（而不是就地在 useWsActors 里用一个 Map）：
//   `useWsActors` 里原来那个 `Map<string,string>` 是**对**的，但它没有任何可测的语义 ——
//   「命中了没有」「什么时候该重新取」「缓存会不会无限涨」全是隐式的，改了也看不出来。
//   这里把三件事变成**可断言**的：
//     ① **键的构成**：`folder|情绪文件名|服装|档位`。少任何一个都会串图 ——
//        少情绪 = 切表情不换脸；少服装 = 换装后还是旧脸；少档位 = 小方图与情绪立绘互相顶掉。
//     ② **命中率可观察**：`stats()` 给出 hit/miss/size，真机上"头像取不到"能一眼定位。
//     ③ **容量有界**：超上限按 LRU 淘汰（长时间挂机 + 角色多时，不会无限涨）。
//
// ⚠️ 一条重要语义：**「解析过但拿不到图」也要缓存**（值是空串）。
//   否则每刷新一次地图，每个没有头像的角色都要再走两趟 `invoke`（失败也是有成本的：
//   真壳里一次 IPC + 一次文件系统探测）。用 `has()` 判「问过没有」，`get()` 判「拿到没有」。

/** 头像档位：`small` = 角色自带的头像小方图；`emotion` = 情绪立绘（退路） */
export type AvatarSlot = "small" | "emotion";

/** 缓存键的三要素（+ 档位）。**顺序固定**，不许随手调整（自检里断言了拼接结果） */
export function avatarKeyOf(
  folder: string,
  emotionFile: string,
  clothes: string,
  slot: AvatarSlot
): string {
  const f = String(folder ?? "").trim();
  const e = String(emotionFile ?? "").trim();
  const c = String(clothes ?? "").trim();
  const s = slot === "emotion" ? "emotion" : "small";
  return `${f}|${e}|${c}|${s}`;
}

export interface AvatarCacheStats {
  size: number;
  hit: number;
  miss: number;
  /** `hit / (hit + miss)`；一次都没查过时是 0（不是 NaN —— 界面要显示它） */
  rate: number;
  evict: number;
}

/**
 * 有界 LRU 缓存（用的是 `Map` 的插入顺序：删了再塞就跑到末尾）。
 *
 * @param max 容量上限。默认 [`AVATAR_CACHE_MAX`]：12 个角色 × 2 档位 = 24 条，
 *            再给情绪变体留点余量 —— 一个人的情绪来回切十几次也不会把别人挤掉。
 */
export const AVATAR_CACHE_MAX = 64;

export class AvatarCache {
  private map = new Map<string, string>();
  private hit = 0;
  private miss = 0;
  private evict = 0;
  private cap: number;

  constructor(max = AVATAR_CACHE_MAX) {
    this.cap = Math.max(1, Math.trunc(Number(max) || AVATAR_CACHE_MAX));
  }

  /**
   * 查一次。
   *
   * `undefined` = **没问过**（调用方该去 invoke）；
   * `""`       = 问过了，**拿不到**（调用方别再去 invoke，直接画占位）。
   */
  get(key: string): string | undefined {
    const k = String(key ?? "");
    if (!this.map.has(k)) {
      this.miss++;
      return undefined;
    }
    this.hit++;
    const v = this.map.get(k) as string;
    // LRU：命中的挪到末尾（Map 的迭代顺序 = 插入顺序）
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  /** 问过没有（含值为空串的"问过但拿不到"） */
  has(key: string): boolean {
    return this.map.has(String(key ?? ""));
  }

  /** 写一条（空串也要写 —— 见文件头那条语义） */
  set(key: string, url: string): void {
    const k = String(key ?? "");
    if (!k) return;
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, String(url ?? ""));
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evict++;
    }
  }

  /** 清空（重新解析全部头像时用）；**不清统计**（统计是给排障看的，跨清空保留才有意义） */
  clear(): void {
    this.map.clear();
  }

  /** 读数（真机上"头像取不到"排障用） */
  stats(): AvatarCacheStats {
    const total = this.hit + this.miss;
    return {
      size: this.map.size,
      hit: this.hit,
      miss: this.miss,
      rate: total > 0 ? this.hit / total : 0,
      evict: this.evict,
    };
  }
}

