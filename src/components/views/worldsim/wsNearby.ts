/**
 * wsNearby.ts —— 「走近了没有」的**距离滞回**（`PLAN-GAMEPLAY.md:69-76` · 期 3「走近说话」第一节）。
 *
 * ## 为什么需要单独一层（而不是"在页面里比一下距离"）
 * 这一屏要的不是「距离 < 12 米 ⇒ 显示对话入口」这一条判断，而是**不打扰**：
 *   · 阈值附近来回走一步，入口不能一闪一闪（玩家站着不动，界面却在抖 = 最廉价的不信任感）；
 *   · 同一个人**连续弹两次**抽屉是打扰（要走开再回来才该再弹）；
 *   · 数不出来的时候（没定位 / 名单还没装配上）**不许假装"附近 0 人"** —— 那是本仓铁律
 *     （三态：正数 / 0（已量） / 数不出来 + 原因，`ROUTE.md:102`）。
 * 所以判定写成**纯函数**：不读系统时间、不碰 localStorage、不 import vue，
 * 同一份输入跑两次**逐字节相同**（自检直接对拍 JSON）。
 *
 * ## 两个阈值（**唯一定义处**；`PLAN-GAMEPLAY.md:72,75` 明写是"我们自己定的"）
 * - `NEAR_ENTER_M = 12`：进带。上一次判"远"的人，**≤12 米**才翻成"近"；
 * - `NEAR_EXIT_M = 20`：出带。已经判"近"的人，**>20 米**才翻回"远"。
 * ⇒ 12~20 米是**滞回带**：在这一带里距离怎么变，状态**一次都不翻**。
 * 为什么是这两个数：12 米 ≈ 面对面两三步（"走到他跟前"），20 米 ≈ 一条街宽（"走开了"）；
 * 两个数**不许改成同一个**（改了就没有滞回，滞回带宽度 = 8 米）。
 * ⚠️ 真正的手感只能真机判（`PLAN-GAMEPLAY.md:165`），这里是"先能数出来、能复现"的那一步。
 *
 * ## 两个输入口径（**别在这里另造第三套**）
 * - **格点坐标**：与地图/日程/行程同一套（`MapActor.gx/gy`）；
 * - **格边长** `cellM`：默认取 `wsIntervene.DEFAULT_CELL_M`（= 后端 `trip::DEFAULT_CELL_M` = 30），
 *   换算**直接调** `wsIntervene.estimateTrip()` —— 全仓"格点 → 米"只有那一份实现
 *   （PR 门禁 C1：不许第二份）。传进来的 `cellM` 不合法时按它的既有口径回落默认值。
 *
 * ## 滞回状态由调用方拿着（本模块无状态）
 * `nearbyOf()` 返回的 `state` 要**原样喂回下一次调用**的 `prev`。
 * 存哪儿是调用方的事（页面用 `ref`，自检用局部变量）—— 纯函数不许有模块级可变状态。
 */

import { DEFAULT_CELL_M, estimateTrip } from "./wsIntervene";

/* ══════════════════════════════════════════════════════════════════
 * 一、阈值与冷却（唯一定义处）
 * ══════════════════════════════════════════════════════════════════ */

/** 进带（米）：上一次是"远"的人，≤ 这个距离才算"近" */
export const NEAR_ENTER_M = 12;
/** 出带（米）：已经"近"的人，> 这个距离才翻回"远" */
export const NEAR_EXIT_M = 20;
/**
 * 同一个人的**冷却**（毫秒）：刚自动弹过一次抽屉，这么久之内**不再自动弹**。
 *
 * 为什么需要它：滞回只保证"状态不抖"，不保证"不重复打扰" —— 玩家关掉抽屉仍站在原地，
 * 状态一直是"近"，若没有冷却就会立刻再弹一次。15 秒 ≈ 够他看完一句话/走开，
 * 又不至于"人还在旁边却再也不弹"（离开出带之后 `openedAt` 自然失效）。
 * ⚠️ 冷却只压**自动弹**：入口本身照常显示（想说话随时能点）。
 */
export const NEAR_COOLDOWN_MS = 15_000;

/* ══════════════════════════════════════════════════════════════════
 * 二、滞回本体（自检直接驱动的一步）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一步滞回：给上一次的判定与这一帧的距离（米），返回这一次的判定。
 *
 * 判据（**这就是全部规则**）：
 * ```
 * prev = 近  →  距离 ≤ NEAR_EXIT_M  ? 近 : 远
 * prev = 远  →  距离 ≤ NEAR_ENTER_M ? 近 : 远
 * ```
 * 于是 12 < d ≤ 20 这一带里**任何原地抖动都不改变结果**（翻转次数 = 0）。
 *
 * 非法距离（NaN / Infinity / 负无穷）一律**判远**：量不出来时不许把人算成"在跟前"
 * （"数不出来"由 `nearbyOf()` 的 `verdict` 负责表达，不是这一层的事）。
 */
export function stepNear(
  prev: boolean | undefined,
  meters: number,
  enterM = NEAR_ENTER_M,
  exitM = NEAR_EXIT_M
): boolean {
  const d = Number(meters);
  if (!Number.isFinite(d)) return false;
  return prev === true ? d <= exitM : d <= enterM;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、一次判定（含三态判词）
 * ══════════════════════════════════════════════════════════════════ */

/** 一个候选（**必须是真人**：调用方负责把玩家自己剔出去，这里不猜名字） */
export interface NearActor {
  id: string;
  name: string;
  /** 格点坐标（与地图/日程同一套；runtime 位置可以是小数） */
  gx: number;
  gy: number;
  /** 位置从哪来（如实带出去；`scatter` = 本地散开，不是真位置） */
  posSource?: string;
}

export interface NearInput {
  /** 我在哪（格点）。`null` / 坐标非有限数 = **还没拿到我的位置**（不是 0,0） */
  me?: { gx: number; gy: number } | null;
  /** 候选名单。`undefined` = **名单还没读到**（与"读到了、就是没人" `[]` 是两件事） */
  actors?: readonly NearActor[] | null;
  /** 每格米数；不传/非法 ⇒ 回落 `DEFAULT_CELL_M`（与 `estimateTrip` 同一口径） */
  cellM?: number | null;
  /** 上一次的滞回状态（键 = id）；不传 = 全部当"远" */
  prev?: Readonly<Record<string, boolean>> | null;
  /** 现在（毫秒）。与 `openedAt` **同时**给才判冷却；不传 = 不判冷却（纯函数不读钟） */
  nowMs?: number | null;
  /** 各人**上一次自动弹**的时刻（键 = id，毫秒） */
  openedAt?: Readonly<Record<string, number>> | null;
}

/** 一次命中的读数（判词与日志直接用） */
export interface NearHit {
  id: string;
  name: string;
  /** 直线距离（米，按 `cellM` 折算；与 `estimateTrip` 同源） */
  meters: number;
  /** 直线距离（格） */
  cells: number;
  gx: number;
  gy: number;
  posSource: string;
}

/** 三态：有 / 已量确实没有 / 数不出来 */
export type NearVerdict = "some" | "none" | "unknown";

export interface NearResult {
  verdict: NearVerdict;
  /** 判"近"的人（由近到远；`unknown` 时**必为空数组**，但**不许**把它读成 0 人） */
  near: NearHit[];
  /** 三态计数：`some`/`none` 是数字；`unknown` 是 **`null`**（数不出来，不写 0） */
  count: number | null;
  /** 这一次**新**翻进"近"、且不在冷却里的人（"只弹一次"的入口判据） */
  entered: NearHit[];
  /** 最近的那个人（谁都不在附近 / 数不出来 = `null`） */
  nearest: NearHit | null;
  /** 新的滞回状态（**原样喂回下一次**的 `prev`） */
  state: Record<string, boolean>;
  /** 这一刻正在冷却里的人（日志用；他们照样算"近"，只是不自动弹） */
  cooling: string[];
  /** 坐标读不出/没有 id 而被跳过的候选人数 */
  skipped: number;
  /** 这一次实际用的格边长（回显，便于日志对账） */
  cellM: number;
  /** 人读判词（三态各一句；可直接上屏/进日志） */
  why: string;
  /** `verdict === "unknown"` 的原因（非空即 unknown；只写"缺什么"，不写结论） */
  missing: string[];
}

/** 就近排序：先比距离，再比 id（同距离时顺序也**确定**，不许随对象键序漂移） */
function byDistance(a: NearHit, b: NearHit): number {
  return a.meters - b.meters || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 判一次「谁在附近」。
 *
 * 三条硬口径（自检钉住）：
 *  ① **确定性**：同一份输入跑两次 ⇒ `JSON.stringify` 逐字节相同（含排序与 `state` 的键序）；
 *  ② **滞回**：`prev` 里已经是"近"的人，只在 **>20 米**时掉出去；12~20 米之间抖动**不翻转**；
 *  ③ **三态不退化**：`me` 或 `actors` 拿不到 ⇒ `verdict:"unknown"` + `count:null` + `near:[]` + `why`，
 *     **绝不**用 `count: 0` 冒充"附近没人"；`actors: []`（真的读到了、就是没人）才是 `count: 0`。
 */
export function nearbyOf(input: NearInput = {}): NearResult {
  const missing: string[] = [];

  /* ── 格边长：非法就回落（口径与 `estimateTrip` 逐字一致，不另造一套）── */
  const rawCell = input.cellM;
  const cellOk = rawCell === undefined || rawCell === null || (Number.isFinite(Number(rawCell)) && Number(rawCell) > 0);
  const cellM = cellOk && rawCell !== undefined && rawCell !== null ? Number(rawCell) : DEFAULT_CELL_M;

  /* ── 我在哪：`me` 缺失/坐标非法 = 没定位（**不是** (0,0)）── */
  const me = input.me || null;
  const mx = Number(me?.gx);
  const my = Number(me?.gy);
  const meOk = !!me && Number.isFinite(mx) && Number.isFinite(my);
  if (!meOk) missing.push("me（还没拿到你的位置）");

  /* ── 名单：`undefined`（没读到）与 `[]`（读到 0 个人）是两件事 ── */
  const list = input.actors;
  const listOk = Array.isArray(list);
  if (!listOk) missing.push("actors（角色名单还没读到）");

  const whyOfMissing = (): string =>
    `数不出来：${missing.join("、")} —— 这不是「附近 0 人」，是**量不出来**`;

  if (missing.length) {
    return {
      verdict: "unknown",
      near: [],
      count: null, // 🔴 不写 0
      entered: [],
      nearest: null,
      state: {},
      cooling: [],
      skipped: 0,
      cellM,
      why: whyOfMissing(),
      missing,
    };
  }

  /* ── 逐个人算距离 + 走一步滞回 ── */
  const prev = input.prev || {};
  const openedAt = input.openedAt || {};
  const nowMs = Number(input.nowMs);
  const canCooldown = Number.isFinite(nowMs);
  const measured: NearHit[] = [];
  const state: Record<string, boolean> = {};
  let skipped = 0;

  for (const a of list as readonly NearActor[]) {
    const id = String(a?.id ?? "").trim() || String(a?.name ?? "").trim();
    const gx = Number(a?.gx);
    const gy = Number(a?.gy);
    // 坐标读不出 / 连个身份都没有 ⇒ 跳过并**计数**（判词里如实说，不静默）
    if (!id || !Number.isFinite(gx) || !Number.isFinite(gy)) {
      skipped += 1;
      continue;
    }
    const est = estimateTrip({ gx: mx, gy: my }, { gx, gy }, cellM);
    state[id] = stepNear(prev[id], est.meters);
    measured.push({
      id,
      name: String(a?.name ?? "").trim() || id,
      meters: est.meters,
      cells: est.cells,
      gx,
      gy,
      posSource: String(a?.posSource ?? ""),
    });
  }

  /* 每个人的距离**只算一次**（上面那一趟），判定与判词都读这一份 */
  measured.sort(byDistance);
  const hits = measured.filter((h) => state[h.id] === true);
  const nearest = hits.length ? hits[0]! : null;

  /* ── 冷却：只压"自动弹"，不压"算不算近" ── */
  const cooling: string[] = [];
  const entered: NearHit[] = [];
  for (const h of hits) {
    const at = Number(openedAt[h.id]);
    const inCooldown = canCooldown && Number.isFinite(at) && nowMs - at < NEAR_COOLDOWN_MS;
    if (inCooldown) {
      cooling.push(h.id);
      continue;
    }
    if (prev[h.id] !== true) entered.push(h);
  }

  /* ── 判词：三态各写清"这是量出来的还是量不出来" ── */
  const skippedNote = skipped ? `；另有 ${skipped} 人坐标读不出（已跳过，未计入）` : "";
  const bandNote = `（进带 ${NEAR_ENTER_M} 米 / 出带 ${NEAR_EXIT_M} 米）`;
  let verdict: NearVerdict;
  let why: string;
  if (hits.length) {
    verdict = "some";
    const who = nearest ? `「${nearest.name}」约 ${nearest.meters} 米` : "";
    why = `附近 ${hits.length} 人${bandNote}：最近 ${who}${skippedNote}`;
  } else if ((list as readonly NearActor[]).length === 0) {
    verdict = "none";
    why = `附近 0 人（已量：名单里 0 个角色）${skippedNote}`;
  } else {
    verdict = "none";
    const closest = measured.length ? `：${measured.length} 个角色里最近「${measured[0]!.name}」约 ${measured[0]!.meters} 米` : "";
    why = `附近 0 人（已量${closest}，超出 ${NEAR_EXIT_M} 米出带）${skippedNote}`;
  }
  if (cooling.length) why += `；其中 ${cooling.length} 人刚弹过（冷却 ${Math.round(NEAR_COOLDOWN_MS / 1000)} 秒内不再自动弹）`;

  return {
    verdict,
    near: hits,
    count: hits.length,
    entered,
    nearest,
    state,
    cooling,
    skipped,
    cellM,
    why,
    missing,
  };
}

/**
 * 从后端 runtime 快照里取「我在哪个格子 / 我这一带叫什么」——**proximity 这条路唯一的一处归一**。
 *
 * 为什么单独写在这里：`MapRuntime.me` 的字段名历史上有两套（`gx/gy` 与 `x/y`），
 * 现有读法在 `useWsActors.ts:406-408`。本模块不 import vue，所以不能调那边；
 * 但**也不许**让每个调用方各写一遍 `gx ?? x` —— 就地收在这里，口径与那边逐字一致。
 * `place` 一起返回：约他出门要拿"我这一带"当地名（老宿主 `WorldSim.vue:1391` 的用法）。
 *
 * 🔴 为什么不能让调用方拿 `actors.placed` 里 `isMe` 那一个：
 * `useWsActors.ts:418` 在**没有定位**时把玩家摆在 `grid/2`（地图正中，`posSource` 仍写 `"me"`）。
 * 那是给画面用的兜底，**不是位置** —— 拿它算距离会得出"你就站在市中心、离他 8 米"，
 * 然后自动弹出一个对话抽屉（编出来的因果）。所以这里只认 runtime 里**真有坐标**的那份。
 */
export interface MeSpot {
  gx: number;
  gy: number;
  /** 我这一带的地点名（`runtime.me.place`；拿不到就是空串，**不编**） */
  place: string;
}

export function meSpotOf(runtime: unknown): MeSpot | null {
  const me = (runtime as { me?: Record<string, unknown> } | null | undefined)?.me || null;
  const gx = Number(me?.gx ?? me?.x);
  const gy = Number(me?.gy ?? me?.y);
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
  return { gx, gy, place: String(me?.place ?? "").trim() };
}
