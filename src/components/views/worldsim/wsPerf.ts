// 「世界模拟」P5-5：性能档位（perfTier）——**真的省算力**的那一半
//
// ── 为什么新开一个文件，而不是把逻辑塞进已有文件 ────────────────────────────
//   · 判定/持久化/帧率采样全是**纯逻辑 + 一个模块级单例**，拆出来才能被 node 自检覆盖
//     （见 ~/rikka/Dsh-SYuki/world_map/frontend_selftest_worldsim_p1.mjs 的【P5-5】段）；
//   · 只依赖 `./wsCaps`（2026-09-19 收敛前是 `./wsGeo`）与 `vue`，**不 import 任何 `@/` 别名**，
//     这样自检里 `bundle()` 不需要额外别名就能把它打成 mjs（少一个坑）。
//
// ── 与既有实现的关系（别重造）──────────────────────────────────────────────
//   `wsGeo.ts` 里那个 `detectLowPerf()`（只看核数 / 设备内存）**已于 2026-09-19 收敛**：
//   判定搬进 `wsCaps.detectDeviceLow()`，wsGeo 那份只剩一个零调用的转发壳。
//   本文件在它之上补齐了完整的一套：
//     ① 三信号判定（核数 / 设备内存 / **实测帧率**）→ `detectTier()`
//     ② 落 localStorage（`wsm:v1:perf`：自动档结果 + 手动覆盖 + fps 开关）
//     ③ 允许手动覆盖（事件流面板里的三档：自动 / 高 / 低）
//     ④ 对外给出**降级系数**（气泡上限 / zoom 量化 / 错开精度），不是给个类名就完事
//
// ── 口径（写死在这里，别处别再抄一遍）──────────────────────────────────────
//   · 目标：中端机 45+ fps。实测 **< 30fps → low**；30~45fps → 记一笔「偏弱」，
//     和另一个偏弱信号（核数 ≤6 / 内存 ≤6GB）凑够两条才降级（避免一次抖动就误降级）。
//   · 拿不到任何信号 → high（宁可多开动画，也别把好机器误降级）。
//   · **自动档只降不升**：一次坏采样不该被下一次好采样洗掉（用户可以在面板里手动切回高）。
//
// ── 🆕 2026-09-19 收敛（去屎山）────────────────────────────────────────────
//   · "这台机器弱不弱"（核数/内存）已搬到 `wsCaps.detectDeviceLow()` —— **全仓唯一一份**；
//     本文件过去自己又判一次、口径还不一样（≤6 核 / ≤6GB）⇒ 就是机主说的「降级乱降」。
//   · 本文件算出的**最终档位**会写进 `wsCaps`（`setPerfTier`）——
//     依赖方向是 **wsPerf → wsCaps 单向**，反过来会成环。
//     这样"CSS 用的 `.ws-perf-low`"与"JS 用的气泡上限"永远来自同一个档位。

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
/* 为什么 `detectWebgl` 要排在这里：它**是值**（函数），不能混进下面 `type` 那一串 ——
   上一轮就是在这里写成 `type PerfTier, detectWebgl }` 的，**整个模块直接语法错**
   （`Identifier expected.`），页面连加载都过不去。改这一行务必跑一次
   `node -e 'require("typescript").createSourceFile(...).parseDiagnostics'` 自检。 */
import {
  detectDeviceLow,
  detectWebgl,
  readDeviceSignals,
  setPerfTier,
  type PerfTier,
} from "./wsCaps";

/* ══════════════════════════════════════════════════════════════════
 * 一、常量与类型
 * ══════════════════════════════════════════════════════════════════ */

/** 持久化键：`{"tier":"auto|high|low","fps":false,"auto":"high|low"}` */
export const WS_PERF_KEY = "wsm:v1:perf";

/**
 * 性能档：只有两档（需求就是两档，多一档就多一份没人维护的分支）。
 *
 * 🆕 2026-09-19 收敛：**类型的定义搬到了 `wsCaps`**（能力矩阵那份），这里只做转发。
 * 收敛前 `wsCaps.ts` 与 `wsPerf.ts` **各写了一份 `"high" | "low"`** ——
 * 值域虽然一样，但两份定义就会各自漂（哪天加一档"中"，必然漏改一处）。
 * 现在是「一份定义 + 一处转发」，所以 `import { type PerfTier } from "./wsPerf"` 的调用方**不用改**。
 */
export type { PerfTier };

/** 用户可选的三档：auto = 用自动判定结果 */
export type PerfTierPref = "auto" | PerfTier;

export interface WsPerfPrefs {
  /** 手动覆盖（默认 auto） */
  tier: PerfTierPref;
  /** fps 显示开关（默认关） */
  fps: boolean;
  /** 自动判定出来的档位（落盘，省得每次进来都要重新采样） */
  auto: PerfTier;
}

export const WS_PERF_DEFAULTS: WsPerfPrefs = { tier: "auto", fps: false, auto: "high" };

/** 实测帧率的两个门槛：低于 floor 直接降级，低于 target 记一条「偏弱」 */
export const FPS_FLOOR = 30;
export const FPS_TARGET = 45;

/** 采样窗口（毫秒）与最少帧数：样本太少（刚进页面卡一下）不下结论 */
export const FPS_SAMPLE_MS = 1200;
export const FPS_SAMPLE_MIN_FRAMES = 12;

/** 低档同时显示的气泡上限（高档沿用 useWorldEvents 的 WS_BUBBLE_MAX = 4） */
export const WS_BUBBLE_MAX_HIGH = 4;
export const WS_BUBBLE_MAX_LOW = 2;

/** 头像层 zoom 的量化步长：手势期间 zoom 每帧都在变，量化后重算次数从「每帧」掉到「几十次」 */
export const ZOOM_STEP_HIGH = 0.02;
export const ZOOM_STEP_LOW = 0.25;

/** 错开散点的候选点数（低档少试几次；64 → 12 是 O(N²) 里的那个 N） */
export const SPREAD_CANDIDATES_HIGH = 64;
export const SPREAD_CANDIDATES_LOW = 12;

/* ══════════════════════════════════════════════════════════════════
 * 二、纯函数（自检直接调，不碰 DOM / 不碰 navigator）
 * ══════════════════════════════════════════════════════════════════ */

function bool(v: unknown): boolean {
  return v === true;
}

/** 读持久化（坏 JSON / 坏字段一律退回默认值，绝不抛） */
export function parsePerfPrefs(raw: string | null): WsPerfPrefs {
  const out: WsPerfPrefs = { ...WS_PERF_DEFAULTS };
  if (!raw) return out;
  let o: unknown = null;
  try {
    o = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!o || typeof o !== "object") return out;
  const rec = o as Record<string, unknown>;
  // 只认显式枚举值：写歪了就用默认（"false" 这种字符串不算数）
  if (rec.tier === "high" || rec.tier === "low" || rec.tier === "auto") out.tier = rec.tier;
  if (rec.auto === "high" || rec.auto === "low") out.auto = rec.auto;
  if (typeof rec.fps === "boolean") out.fps = bool(rec.fps);
  return out;
}

/** 写持久化 */
export function serializePerfPrefs(p: Partial<WsPerfPrefs> | null | undefined): string {
  const base = p || {};
  return JSON.stringify({
    tier: base.tier === "high" || base.tier === "low" ? base.tier : "auto",
    fps: bool(base.fps),
    auto: base.auto === "low" ? "low" : "high",
  });
}

/** 最终档位：手动覆盖优先，auto 时用自动判定结果 */
export function resolveTier(p: WsPerfPrefs | null | undefined): PerfTier {
  const prefs = p || WS_PERF_DEFAULTS;
  if (prefs.tier === "high" || prefs.tier === "low") return prefs.tier;
  return prefs.auto === "low" ? "low" : "high";
}

/** 判定输入（都可缺省；缺省 = 没有这个信号） */
export interface PerfEnv {
  /** `navigator.hardwareConcurrency` */
  cores?: number;
  /** `navigator.deviceMemory`（单位 GB，浏览器封顶 8） */
  memGB?: number;
  /** 实测帧率（没有就传 0/undefined） */
  fps?: number;
}

/**
 * 三信号判定。**纯函数**，自检把各种组合喂进来。
 *
 * 规则（写在文件头的「口径」里，改这里要同步改那段注释）：
 *   · 核数 ≤4 或 内存 ≤4GB → 直接 low
 *   · 核数 ≤6 或 内存 ≤6GB 或 帧率 <45 → 记一条「偏弱」
 *   · 帧率 <30 → 直接 low
 *   · 偏弱 ≥2 条 → low；否则 high
 */
export function detectTier(env: PerfEnv = {}): PerfTier {
  const cores = Number(env.cores) || 0;
  const mem = Number(env.memGB) || 0;
  const fps = Number(env.fps) || 0;
  // 设备硬底线（核数 / 内存）⇐ **只有 `wsCaps.detectDeviceLow` 一处说了算**。
  // 这里过去自己写着 `cores<=4 / mem<=4`，而 `wsGeo.detectLowPerf` 写着 `mem<=3`
  // ⇒ 4GB 手机拿到两个答案（就是"降级乱降"）。收敛后以本函数这份（真正生效的那份）为准。
  if (detectDeviceLow({ hardwareConcurrency: cores, deviceMemory: mem })) return "low";
  /* 🔴 2026-09-20：**无 WebGL ⇒ 必然走 2D 软渲染**，那条路天生重（实测小区级只有 6~7fps，
     而"内存/核数"完全够格）⇒ 直接判低档。
     过去档位只看硬件，结果"软渲染还按满血 60fps 跑"（雨/小地图/头像/车辆全部逐帧），
     这就是"低端降级路 6fps"的根因；也是机主说"降级乱降"的最后一环。
     注意：`detectWebgl` 是 `wsCaps` 里的**唯一**实现（别在这里再探一次，否则两边会不一致）。 */
  if (!detectWebgl()) return "low";
  if (fps > 0 && fps < FPS_FLOOR) return "low";
  let weak = 0;
  if (cores > 0 && cores <= 6) weak++;
  if (mem > 0 && mem <= 6) weak++;
  if (fps > 0 && fps < FPS_TARGET) weak++;
  return weak >= 2 ? "low" : "high";
}

/** 读设备信号（拿不到就是 undefined，交给 detectTier 当「没有这个信号」） */
export function readPerfEnv(): PerfEnv {
  // 读 `navigator` 的那段收敛进 `wsCaps.readDeviceSignals()`（唯一一份），这里只做转发
  const { cores, memGB } = readDeviceSignals();
  const env: PerfEnv = {};
  if (cores > 0) env.cores = cores;
  if (memGB > 0) env.memGB = memGB;
  return env;
}

/**
 * zoom 量化。
 *
 * 为什么必须量化：头像/车辆/气泡都是「位置跟着地图走、尺寸抵消地图缩放」，
 * 所以每次 zoom 变化都要让**每个**标记重算一次 style —— 捏合时 zoom 逐帧在变，
 * 20 个人就是 20 次/帧的 Vue 更新 + DOM 写入。量化后同一档内 props 不变，
 * Vue 的 computed 不重算、DOM 不重写（视觉误差 ≤ 半个步长，肉眼看不出）。
 */
export function quantizeZoom(z: number, low: boolean): number {
  const n = Number.isFinite(z) && z > 0 ? z : 1;
  const step = low ? ZOOM_STEP_LOW : ZOOM_STEP_HIGH;
  return Math.round(n / step) * step;
}

/** 同时显示的气泡上限（低档下调，见 WsEventBubble 的 max 参数） */
export function bubbleMaxOf(low: boolean): number {
  return low ? WS_BUBBLE_MAX_LOW : WS_BUBBLE_MAX_HIGH;
}

/** 错开散点的降级参数（直接喂给 `spreadCrowd` 的第 4 个参数） */
export function spreadOptsOf(low: boolean): { candidates: number; crowd: "exact" | "bucket" } {
  return low
    ? { candidates: SPREAD_CANDIDATES_LOW, crowd: "bucket" }
    : { candidates: SPREAD_CANDIDATES_HIGH, crowd: "exact" };
}

/* ══════════════════════════════════════════════════════════════════
 * 三、模块级单例（页面与面板共用同一份状态；不进 pinia —— 只在世界模拟里活着）
 * ══════════════════════════════════════════════════════════════════ */

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* 写不进去就只在本次会话生效，页面绝不因此报错 */
  }
}

const prefs = ref<WsPerfPrefs>(parsePerfPrefs(readLS(WS_PERF_KEY)));
const fpsNow = ref(0);
/** 自动采样是否已经做过（一次会话只做一次；结果落盘） */
let sampled = false;

/**
 * 🔴 「**我们已经在走软渲染路了**」—— 非空即低档（值是原因，给 HUD 如实显示用）。
 *
 * 为什么需要这一路（2026-09-20 实测，这是本任务的关键）：
 * 档位判定此前全是**预测**（猜这台机器弱不弱），而真正决定"重不重"的是
 * **实际走了哪条渲染路**。这两件事会不一致 —— 无头/软渲染环境下
 * `hasWebGL()` 探针可能返回真（SwiftShader 软件 WebGL），地图库 `new Map()` 也成功，
 * 但 `load` 事件永远不触发 ⇒ 看门狗到点把它降到 **Canvas2D 软渲染**。
 * 结果：**页面在跑最重的那条路，档位却还是"高档"**，雨/雪、小地图、头像、车辆
 * 全部按满血跑（实测小区级 7fps）。
 *
 * 所以这里不猜了：谁说"我降级了"（`WsDistrictMapLibre.fallback2d()`），谁就把这个
 * 置成低档 —— **因果**而不是**预测**。探针猜错也不会漏。
 *
 * ⚠️ 必须声明在 `tierRef` **之前**：下面那个 `watch(..., { immediate: true })` 会立刻
 *    求值一次 `tierRef`，写到后面就是 TDZ（`Cannot access before initialization`）。
 */
const softPath = ref<string>("");

/**
 * 由**实际渲染路**强制压到低档（一次性、不可逆）。
 *
 * 用 `ref` + `computed` 而不是直接改 `prefs`：`prefs` 是**用户偏好**（要落 localStorage、
 * 面板上要显示"自动/高/低"），把它改掉会让用户看到自己的设置被悄悄篡改。
 * 而"这条路就是慢"是**事实**，不是偏好 —— 事实单独存一份。
 */
export function forceLowTier(reason: string): void {
  if (!reason) return;
  // 只记第一条原因：第一条才是"为什么走到这条路上"，后面的都是它的后果
  if (!softPath.value) softPath.value = reason;
}

/** 现在为什么是低档（空串 = 不是被强制压的）。HUD 如实显示它 */
export function lowTierReason(): string {
  return softPath.value;
}

/**
 * 最终档位（手动覆盖优先）。
 *
 * 🔴 为什么是**模块级**而不是写在 `useWsPerf()` 里：`wsCaps` 的同步不能依赖某个组件的生命周期 ——
 * 写在 composable 里的话，调它的那个组件一卸载 watch 就没了，能力矩阵会**悄悄停在旧档位**
 * （正是"降级乱降"最爱长的形状：状态看起来对，其实早就不更新了）。
 * 模块级单例 + 模块级 watch ⇒ 与组件生死无关。
 */
const tierRef = computed<PerfTier>(() => (softPath.value ? "low" : resolveTier(prefs.value)));

// 单向同步：wsPerf（唯一算档位的人）→ wsCaps（唯一存能力矩阵的地方）
watch(tierRef, (t) => setPerfTier(t), { immediate: true });

/** rAF 表（**同时只允许一个**：重复调 start 不会叠加） */
let rafId: number | null = null;
let visibleBound = false;

function raf(cb: FrameRequestCallback): number | null {
  if (typeof window === "undefined" || !window.requestAnimationFrame) return null;
  return window.requestAnimationFrame(cb);
}
function cancelRaf(id: number | null) {
  if (id !== null && typeof window !== "undefined" && window.cancelAnimationFrame)
    window.cancelAnimationFrame(id);
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export interface PerfApi {
  /** 最终档位（手动覆盖优先） */
  tier: ComputedRef<PerfTier>;
  /** 是不是低档（= tier === 'low'，代码里判这一个就够） */
  low: ComputedRef<boolean>;
  /** 原始偏好（面板上要显示「自动/高/低」与 fps 开关） */
  prefs: Ref<WsPerfPrefs>;
  /** 实测帧率（0 = 还没测出来） */
  fps: Ref<number>;
  /** 手动切档 */
  setTier: (t: PerfTierPref) => void;
  /** 手动开关 fps 显示 */
  setFps: (on: boolean) => void;
  /** 自动判定结果（只降不升），落盘 */
  noteAuto: (t: PerfTier) => void;
  /** 由**实际渲染路**强制压到低档（谁说"我降级了"谁调它，见 `forceLowTier`） */
  forceLow: (reason: string) => void;
  /** 被强制压低的**原因**（空串 = 没被强制）。HUD 要如实显示 */
  lowReason: ComputedRef<string>;
  /** 进小区图时调：按需启动 fps 表 + 补一次自动采样 */
  bootstrap: () => void;
  /** 离开页面时调：停表、摘监听 */
  teardown: () => void;
}

/**
 * 拿性能档位（模块级单例）。
 *
 * ⚠️ 所有 rAF 都在这里集中管：页面隐藏时**立刻停**（`visibilitychange`），
 *    回前台再启动 —— 与 `useWorldTrips` / `WsTripCard` / `WsVehicleMark` 同款纪律，
 *    **不要**在别处再写一个 fps 循环。
 */
export function useWsPerf(): PerfApi {
  const tier = tierRef; // 模块级单例（见上面的 `tierRef`，别在这里再 computed 一次）
  const low = computed(() => tier.value === "low");

  function setTier(t: PerfTierPref) {
    prefs.value = { ...prefs.value, tier: t };
    writeLS(WS_PERF_KEY, serializePerfPrefs(prefs.value));
  }
  function setFps(on: boolean) {
    prefs.value = { ...prefs.value, fps: !!on };
    writeLS(WS_PERF_KEY, serializePerfPrefs(prefs.value));
    if (on) startMeter();
    else stopMeter();
  }
  function noteAuto(t: PerfTier) {
    // 只降不升：一次坏采样不该被下一次好采样洗掉（用户想升可以在面板里手动切）
    if (t !== "low" || prefs.value.auto === "low") return;
    prefs.value = { ...prefs.value, auto: "low" };
    writeLS(WS_PERF_KEY, serializePerfPrefs(prefs.value));
  }

  /* ── 帧率表（显示用；0.5 秒才更新一次 ref，别让表本身变成每帧一次渲染）── */
  let frames = 0;
  let t0 = 0;
  function meterLoop(ts: number) {
    rafId = null;
    if (hidden()) return;
    if (!t0) t0 = ts;
    frames++;
    const dt = ts - t0;
    if (dt >= 500) {
      fpsNow.value = Math.round((frames * 1000) / dt);
      frames = 0;
      t0 = ts;
    }
    rafId = raf(meterLoop);
  }
  function startMeter() {
    if (!prefs.value.fps || rafId !== null || hidden()) return;
    frames = 0;
    t0 = 0;
    rafId = raf(meterLoop);
  }
  function stopMeter() {
    cancelRaf(rafId);
    rafId = null;
  }

  /* ── 一次性自动采样：给「实测帧率」那个信号用 ─────────────────────────── */
  function sampleFps(ms = FPS_SAMPLE_MS): Promise<number> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !window.requestAnimationFrame || hidden()) {
        resolve(0);
        return;
      }
      const start = performance.now();
      let count = 0;
      const step = () => {
        count++;
        const dt = performance.now() - start;
        if (dt >= ms) {
          resolve(count >= FPS_SAMPLE_MIN_FRAMES ? Math.round((count * 1000) / dt) : 0);
          return;
        }
        raf(step);
      };
      raf(step);
    });
  }

  function onVisibility() {
    if (hidden()) stopMeter();
    else startMeter();
  }
  function bindVisibility() {
    if (visibleBound || typeof document === "undefined") return;
    visibleBound = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  function unbindVisibility() {
    if (!visibleBound || typeof document === "undefined") return;
    visibleBound = false;
    document.removeEventListener("visibilitychange", onVisibility);
  }

  /** 进小区图：启动显示表 + 补一次自动采样（手动选了高/低就不再采样，尊重用户） */
  function bootstrap() {
    bindVisibility();
    if (prefs.value.fps) startMeter();
    if (sampled || prefs.value.tier !== "auto") return;
    sampled = true;
    /* 🔴 这一段必须**同步**判完，不能只靠下面那个异步采样：
       `detectTier()` 里也有「无 WebGL ⇒ low / 帧率 <30 ⇒ low」两条，但它只在
       `sampleFps()` 拿到 >0 的结果之后才被调用 —— 而**软渲染/无头环境恰恰是最可能
       连帧率都采不准的地方**（主线程长期被占，2 秒窗口内可能连
       `FPS_SAMPLE_MIN_FRAMES` 帧都不到 ⇒ 返回 0 ⇒ 整条判定被跳过，档位静默停在"高档"）。
       实测教训：规则写对了、模块却是语法错 / 或压根没被调用 ⇒ 白改。
       所以「设备弱」与「没有 WebGL」两条**都在这里同步落地**。 */
    if (detectDeviceLow()) noteAuto("low"); // 核数/内存这一路（`wsCaps` 的唯一判定）
    if (!detectWebgl()) noteAuto("low"); // 没有 WebGL ⇒ 必然软渲染（`wsCaps` 的唯一探针）
    void sampleFps().then((fps) => {
      if (fps > 0) {
        fpsNow.value = fps;
        noteAuto(detectTier({ ...readPerfEnv(), fps }));
      }
    });
  }

  function teardown() {
    stopMeter();
    unbindVisibility();
  }

  const lowReason = computed<string>(() => softPath.value);

  return {
    tier,
    low,
    prefs,
    fps: fpsNow,
    setTier,
    setFps,
    noteAuto,
    forceLow: forceLowTier,
    lowReason,
    bootstrap,
    teardown,
  };
}

export type WsPerf = ReturnType<typeof useWsPerf>;
