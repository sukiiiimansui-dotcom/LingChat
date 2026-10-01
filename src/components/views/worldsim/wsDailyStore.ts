/**
 * wsDailyStore.ts —— 「我的家 + 今日三件事」在 **App 里**的**落盘 + 跨天重置 + 编排**（切片③，2026-10-01）。
 *
 * ## 这一层只做三件事（**规则一行不写**）
 *   ① 读盘 / 落盘（`localStorage["wsDaily.v1"]`，键名与形状与代拍页**逐字同名**）；
 *   ② 编排：`pickHome()` → `planDaily()` → 落盘（调用形状与顺序照抄 `ws3dshow.html:4514-4531`）；
 *   ③ 勾选：`toggleTask()` → 落盘。
 * `pickHome` / `planDaily` / `toggleTask` / `dayKeyOf` **全部 import 自共享真源 `wsDaily.ts`**
 * （PR 门禁 C1：App 侧不许有第二份实现；页面侧经 `wsPageVendor.ts:65` 的 `export *` 进产物）。
 *
 * ## 为什么有这一层（而不是把原型页那段内联 JS 抄进 `.vue`）
 * 原型页的 `wsBuildDaily()` 直接读自己的 `placesStoreOf()` / 全局 `map.getCenter()` / `window.__WSD__`，
 * 这三样 App 里**一样都没有**（`WsCityEntry.vue:174-177` 已把 `window.__*` 全否过）。
 * ⇒ 把"从哪拿输入、把状态放哪"抽成这个**可注入**的 store：
 *   · `storage` 注入 ⇒ 自检不碰真 `localStorage`（照 `wsCityStore.ts:280/314/332` 那套后端注入的形状，不新造一套）；
 *   · `now` 注入 ⇒ 跨天可测（`wsDaily.ts:113-114` 的 `nowMs` 入参本来就是"为了可测"设计的；
 *     **这不是新调试出口** —— App 里没有 `window.__*`）。
 *
 * ## 诚实口径（与本仓一致）
 *   · 取名点为空 / 没有地图中心 ⇒ `home()` 是 `null`，`verdict()` 里写「数不出来（原因）」——**绝不编一个家**；
 *   · 盘上只存 `day` + 每条任务的 `id`/`done`（**不存 text/kind/targetId** ⇒ 不存任何可能编造的内容）；
 *   · 盘读不动 / 写不进（隐私模式、配额满）⇒ **不抛**，只是"记不住"（下次重来）。
 */
import {
  dayKeyOf,
  pickHome,
  planDaily,
  toggleTask,
  type DailyState,
  type DailyTask,
  type PlacePoint,
  type Resident,
  type Spot,
} from "./wsDaily";

/** 落盘键（与代拍页**同名同形**：`ws3dshow.html:4443` 的 `DAILY_KEY`） */
export const WS_DAILY_KEY = "wsDaily.v1";

/** 「家」的取数半径（米）——与代拍页**同值**（`ws3dshow.html:4520` 的 `maxM: 3000`） */
export const WS_DAILY_HOME_MAX_M = 3000;

/**
 * 存储后端（注入的那道缝）。
 * ⚠️ 只有 `get`/`set` 两个方法（照施工图的签名清单）：清盘用 `set(KEY, "null")` ——
 *    那正是原型页"没有状态"时写下去的那个值（`ws3dshow.html:4505` 的三元）。
 */
export interface DailyStorage {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

function ls(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式/被禁 ⇒ 只是"记不住"，功能照走
  }
}

/** 浏览器后端：`localStorage`。**读不动 ⇒ null，不抛**（写不进也吞掉，见 `save()`） */
export function browserDailyStorage(): DailyStorage {
  return {
    get(k) {
      try {
        return ls()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        ls()?.setItem(k, v);
      } catch {
        /* 配额满/被禁：不抛（界面照走，只是下次重新开始） */
      }
    },
  };
}

/** 纯内存后端（自检用；**不碰 `localStorage`**）。`seed` = 盘上原来的那份 JSON 原文。 */
export function memoryDailyStorage(seed: string | null = null): DailyStorage {
  let v: string | null = seed;
  return {
    get: () => v,
    set: (_k, s) => {
      v = s;
    },
  };
}

export interface DailyStoreOptions {
  /** 时钟（毫秒）。默认 `Date.now()`；注入是为了**跨天可测**（不靠改系统时间） */
  now?: () => number;
  /** 存储后端。默认 `browserDailyStorage()` */
  storage?: DailyStorage;
}

export interface DailyBuildInput {
  /** 有名片区（`placesbundle` 来的真名点）；空数组 = **确实一个都没有**（不是"读不到"） */
  places: readonly PlacePoint[];
  /** 地图中心；`null` = 拿不到（⇒ `candidates: null`，"数不出来"而不是"已量到 0"） */
  center: { lng: number; lat: number } | null;
  /** 居民（对话对象） */
  residents: readonly Resident[];
  /** 设施/地点（"去一次 X"用） */
  spots: readonly Spot[];
}

export interface DailyStore {
  /** **唯一入口**：读盘 → `pickHome` → `planDaily` → 落盘 → 返回今日状态 */
  build(i: DailyBuildInput): DailyState;
  /** 挑到的家；`null` = 数不出来（原因在 `why()`） */
  home(): PlacePoint | null;
  /** `pickHome` 的 `why` **原文**（HUD 直念，宿主不许改写） */
  why(): string;
  /** 今日三件事（没 build 过 ⇒ 空数组，不是"三件空的"） */
  tasks(): readonly DailyTask[];
  /** 本地日期键 `YYYY-MM-DD`（= 盘上那份任务所属的那天；没 build 过就是"今天"） */
  day(): string;
  /** 一行三态判词：挑到了 / 数不出来（原因）。**逐字照抄**原型页 `ws3dshow.html:4483` */
  verdict(): string;
  /** `planDaily` 的 `why` 原文（跨天重置/缺件都在这一句里；HUD 放 `title`，不改可见文案） */
  note(): string;
  /** 勾选/取消一件（调真源 `toggleTask`，然后落盘） */
  toggle(id: string, done?: boolean): DailyState;
  /** 清盘（切城/退出时用） */
  reset(): void;
}

export function createDailyStore(o: DailyStoreOptions = {}): DailyStore {
  const now = o.now || (() => Date.now());
  const storage = o.storage || browserDailyStorage();

  let state: DailyState | null = null;
  let home: PlacePoint | null = null;
  let homeWhy = "";
  let planNote = "";

  /**
   * 读盘 → `prev`。
   * 🔴 **只回读 `id` + `done`**：文本按 id 由 `planDaily` 重算（`wsDaily.ts:178-181` 按 id 对齐完成态），
   *    所以这里喂**占位字段**（照抄原型页 `ws3dshow.html:4525` 的喂法）。
   * 坏数据（不是 JSON / `day` 不是字符串）⇒ 当"没存过"（下一次 `build` 会覆盖），**不抛**。
   */
  function readPrev(): DailyState | null {
    let raw: string | null = null;
    try {
      raw = storage.get(WS_DAILY_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const p = parsed as { day?: unknown; tasks?: unknown } | null;
    if (!p || typeof p !== "object" || typeof p.day !== "string" || !p.day) return null;
    const rawTasks = Array.isArray(p.tasks) ? p.tasks : [];
    const tasks: DailyTask[] = [];
    for (const t of rawTasks) {
      const id = (t as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !id) continue;
      tasks.push({
        id,
        text: "",
        kind: "greet",
        targetId: null,
        done: (t as { done?: unknown }).done === true,
      });
    }
    return { day: p.day, tasks };
  }

  /** 落盘：形状**逐字照抄** `ws3dshow.html:4505`（只存 `day` + `id`/`done`；无状态写 `null` 那个字符串） */
  function save(): void {
    const v = state
      ? JSON.stringify({ day: state.day, tasks: state.tasks.map((t) => ({ id: t.id, done: !!t.done })) })
      : "null";
    try {
      storage.set(WS_DAILY_KEY, v);
    } catch {
      /* 记不住就算了：最多下次重新开始（与 `browserDailyStorage` 同一口径） */
    }
  }

  return {
    build(i) {
      const prev = readPrev();
      /* 家：从**已有的片区名**里挑最近的一个；没有名字/没有中心 ⇒ `home:null` + `why`（真源自己会给） */
      const ph = pickHome(i?.places || [], { center: i?.center || null, maxM: WS_DAILY_HOME_MAX_M });
      home = ph.home;
      homeWhy = ph.why;
      const r = planDaily({
        nowMs: now(),
        prev,
        residents: i?.residents || [],
        spots: i?.spots || [],
        homeName: home ? home.name : null,
      });
      state = r.state;
      planNote = r.why;
      save();
      return state;
    },

    home: () => home,
    why: () => homeWhy,
    tasks: () => (state ? state.tasks : []),
    day: () => (state ? state.day : dayKeyOf(now())),
    note: () => planNote,

    verdict() {
      if (home) return `我的家：${home.name}${home.kind ? `（${home.kind}）` : ""}`;
      /* 三态里"数不出来"那一支：**原因原样念出来**（原型页的兜底句 + 本 store 自己的"还没数过"）。
         ⚠️ "还没数过"与"数过了、确实没有"是两件事，不许混成一句（本仓的三态纪律）。 */
      const why = homeWhy || (state ? "附近没有有名片区" : "还没数过（地图中心/片区名还没到）");
      return `我的家：数不出来（${why}）`;
    },

    toggle(id, done) {
      if (!state) {
        /* 还没 build 过 ⇒ 没有可勾的项：如实返回"当天空状态"，**不写盘**（不假装记下了什么） */
        return { day: dayKeyOf(now()), tasks: [] };
      }
      state = toggleTask(state, id, done);
      save();
      return state;
    },

    reset() {
      state = null;
      home = null;
      homeWhy = "";
      planNote = "";
      /* 清盘 = 写回"无状态"那个编码（`DailyStorage` 只有 get/set，见接口上的说明） */
      try {
        storage.set(WS_DAILY_KEY, "null");
      } catch {
        /* 同上：清不掉也只是"下次还看得见旧进度"，不抛 */
      }
    },
  };
}
