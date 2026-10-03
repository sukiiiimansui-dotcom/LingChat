/**
 * wsBldMode.ts —— 🏙 **「画多少栋楼」的档位存储**（App 侧，2026-10-03）。
 *
 * ## 为什么要有它（机主原话）
 * 上一轮把挑楼换成"双预算"（`wsBldBudget.pickBuildingsByBudget`）之后，机主真机验收报：
 * 「楼一会少一会多，一会直接不见」—— 低 zoom 时每栋只有几 px² ⇒ 40 万 px² 的预算能塞下
 * **成千上万**个小盒子（太多）；高 zoom 时几栋大楼就吃满（太少）。
 * 机主的决定（原话）：「我想要一开始直接**固定可显示的楼房数据，严格限制**，但是要求用户
 * **可在选择是否启用多楼房模式（不推荐）**」⇒ 默认严格档，另外给一个**默认关闭**的开关。
 *
 * ## 三个数各在哪（别搞混，改的时候只改一处）
 * · **上限是多少** → `wsBldBudget.ts` 的 `WS_BLD_MAX_DRAWN`（100）/ `WS_BLD_MAX_DRAWN_MANY`（4000）
 *   与 `bldMaxDrawnOf(mode)`；本文件**一个数字都不写**（否则就会出现第二份默认值）。
 * · **用户选了哪一档** → **本文件**（`localStorage["wsm:v1:bldmode"]`，值 `"lean"` / `"many"`）。
 * · **怎么用这一档** → 宿主（`WsDistrictMapLibre.vue` 把它算成 `maxDrawn` 传进挑楼；
 *   `WsCityEntry.vue` 的 chip 负责让用户改）。
 *
 * ## IO 口径（与 `wsRelation.ts` / `wsDailyStore.ts` 同款，一条都不能松）
 * · 键：`wsm:v1:bldmode`（`wsm:v1:` 前缀与本项目其它世界模拟存储一致；`v1` 是格式版本）；
 * · 值：`"lean"`（默认严格档）/ `"many"`（多楼房模式）；
 * · **读不出来一律当 `"lean"`**：没存过 / 隐私模式下 `localStorage` 抛错 / 存了个
 *   `"{}"`/`"MANY"`/`null` 这类不认识的东西 —— 全是"退回默认"，**绝不抛**（坏数据不该让整屏白掉）；
 * · 写不进去也吞掉（本次会话照样生效，只是下次开页回到默认）：与 `wsRelation.writeStore()` 同款。
 *
 * ## 为什么是"用户开关"而不是"自动降档"
 * 机主红线：**不许按帧率/设备能力自动缩**。这一档是**用户自己**选的（并且明确写着"不推荐"），
 * 代码里没有任何 `fps` / `deviceMemory` / 随机输入 —— 同一档 + 同一相机 ⇒ 同一批楼。
 */

import { ref, type Ref } from "vue";

/** 存储键（别改名：改名等于把用户的选择丢掉一次） */
export const WS_BLD_MODE_KEY = "wsm:v1:bldmode";
/** 默认严格档（机主要的那一档） */
export const WS_BLD_MODE_LEAN = "lean";
/** 多楼房模式（**不推荐**：更卡；用户主动开才用） */
export const WS_BLD_MODE_MANY = "many";

/** 档位（只有这两个值，其它一律归一成 `lean`） */
export type WsBldMode = typeof WS_BLD_MODE_LEAN | typeof WS_BLD_MODE_MANY;

/**
 * 把**任意**读到的值归一成档位（纯函数，自检可钉）。
 * 只认字符串 `"many"` 那一个值 —— 大小写/空格/对象/数字一概按默认严格档（不猜用户想说什么）。
 */
export function bldModeOf(raw: unknown): WsBldMode {
  return raw === WS_BLD_MODE_MANY ? WS_BLD_MODE_MANY : WS_BLD_MODE_LEAN;
}

/** 读盘：**坏了/没有/读不动 ⇒ `lean`，绝不抛**（隐私模式下 `localStorage` 本身就会抛） */
export function readBldMode(): WsBldMode {
  try {
    if (typeof localStorage === "undefined") return WS_BLD_MODE_LEAN;
    return bldModeOf(localStorage.getItem(WS_BLD_MODE_KEY));
  } catch {
    return WS_BLD_MODE_LEAN;
  }
}

/** 落盘：写不进去不影响本次会话（与 `wsRelation.writeStore()` 同一口径） */
function writeBldMode(mode: WsBldMode): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WS_BLD_MODE_KEY, mode);
  } catch {
    /* 写不进去就只活这一次会话 */
  }
}

/**
 * 模块级单例：**同一屏里两个组件读的是同一份** —— 顶栏的 chip（`WsCityEntry.vue`）改一下，
 * 地图那边（`WsDistrictMapLibre.vue`）的 `watch` 立刻收到 ⇒ 重挑 + 重绘。
 * （`ref` 是 Vue 现成的依赖，本文件**不引入任何新依赖**；与 `useWsRelation()` 的模块级缓存同一套做法。）
 */
let modeRef: Ref<WsBldMode> | null = null;

/** 取档位（Vue 侧最小 API：一个 `mode` ref + 一个 `setMode` + 一个 `toggleMode`） */
export function useWsBldMode(): {
  mode: Ref<WsBldMode>;
  setMode: (m: unknown) => WsBldMode;
  toggleMode: () => WsBldMode;
} {
  if (!modeRef) modeRef = ref<WsBldMode>(readBldMode());
  const mode = modeRef;

  /** 改档：**归一 + 落盘 + 返回真正生效的那一档**（调用方拿它做提示，不许自己猜） */
  function setMode(m: unknown): WsBldMode {
    const next = bldModeOf(m);
    mode.value = next;
    writeBldMode(next);
    return next;
  }

  /** 一键切换（chip 点一下就走它）：严格档 ⇄ 多楼房模式 */
  function toggleMode(): WsBldMode {
    return setMode(mode.value === WS_BLD_MODE_MANY ? WS_BLD_MODE_LEAN : WS_BLD_MODE_MANY);
  }

  return { mode, setMode, toggleMode };
}
