/**
 * wsCaps.ts —— 「世界模拟」的**唯一能力矩阵**（single source of truth）
 *
 * ## 为什么会有这个文件（机主原话：「降级乱降」）
 * 2026-09-19 体检实测：同一件事——「要不要降级」——在仓库里被**七套互不相干的开关**各判一次：
 *
 * | 开关 | 处数 | 在哪判 |
 * |---|---|---|
 * | `USE_MAPLIBRE` | 6 | `WsDistrict.vue`（写死 true） |
 * | `SKETCH_DISABLED` | 3 | `WsDistrict.vue`（写死 true） |
 * | `districtUnderlayVisible` | 2 | `WorldSim.vue`（写死 false） |
 * | `showAi` | 6 | `WsDistrictMapLibre.vue`（默认 false） |
 * | `perfLow` | 9 | `WorldSim.vue` ← `wsPerf` |
 * | `ws-perf-low`（CSS 类） | 18 | `worldsim.css` / `worldsim-loading.css` |
 * | `fallback` | 26 | 到处都是（头像/高度/天气各一套） |
 *
 * 后果：**任何一处都能把另一处关掉，而且没人知道为什么关的**。用户看到的就是
 * 「明明有 WebGL 却被降级」「明明低端机却没降级」「图层忽有忽无」。
 *
 * 本文件把这七套收敛成**一个只读状态** `WsCaps`，分两块：
 * - `render`：**设备能力**（有没有 WebGL / 性能档 / 要不要减动效）—— 机器说了算，人不插手；
 * - `layers`：**每个图层走哪条路**（`maplibre` / `legacy` / `off`）—— 按层表达，**不是一个全局布尔**。
 *
 * ## 🔴 为什么图层必须"按层"说，不能用一个大开关（这条别改回去）
 * 小区级有**两套坐标系**：
 *   · 新路 = MapLibre + **真实经纬度**（`WsDistrictMapLibre.vue`）；
 *   · 老路 = 小区草图网格 → **CSS transform**（`#pin` 槽里的那五层）。
 * 两者**不是一回事**。所以在 MapLibre 底图上直接打开老路的图层，它们会画在**对不上的位置**
 * （"浮在空处 / 位置漂移"）—— 那比不画更糟。
 * ⇒ 规矩：**一个图层只有"已经迁移成真实经纬度"了，才允许在 `maplibre` 模式下打开；
 *   没迁移的，在 `maplibre` 模式下必须是 `off`，并在下面的 `WS_LAYERS` 里如实标注。**
 *   迁移清单看 `world_map/AUDIT-STINK.md`（P1b 图层搬迁）。
 *
 * ## 设计约束（为了能被 node 自检覆盖）
 * · **纯逻辑**：不 import `vue`、不 import 任何 `@/` 别名、不碰网络；
 * · 所有"读环境"的地方都**可以注入**（`detectDeviceLow(env)` / `detectWebgl(probe)`），
 *   这样自检里能喂假数据，不需要真的开浏览器；
 * · 单向依赖：`wsPerf → wsCaps`（`wsPerf` 把实测帧率算出的档位**写进来**），
 *   **反过来不行**（会成环）。
 */

/* ══════════════════════════════════════════════════════════════════
 * 一、类型
 * ══════════════════════════════════════════════════════════════════ */

/** 性能档：只有两档（多一档就多一份没人维护的分支） */
export type PerfTier = "high" | "low";

/** 渲染引擎：小区级地图本体由谁画 */
export type Engine = "maplibre" | "sketch";

/**
 * 单个图层的走法。
 * - `maplibre` —— 走真实经纬度（地图库图层或 `map.project()` 定位的 Marker）；
 * - `legacy`   —— 走老路（草图网格 → CSS transform，只在 `sketch` 引擎下位置才正确）；
 * - `off`      —— 不画。**每一个 `off` 都必须能说清理由**（见 `layerReason`）。
 */
export type LayerMode = "maplibre" | "legacy" | "off";

/** 图层 id —— 只列"有降级问题"的那些，不是全部图层 */
export type LayerId =
  | "avatar"
  | "facility"
  | "transit"
  | "windowLight"
  | "vehicle"
  | "ai"
  | "sketch";

/** 设备能力（机器说了算，用户不能直接改；用户只能通过 `wsPerf` 的档位选择影响 `perf`） */
export interface CapsRender {
  /** 有没有可用的 WebGL（没有 ⇒ 只能走老路，这是真需求不是猜） */
  webgl: boolean;
  /** 性能档（由 `wsPerf` 写入：设备档位 + 实测帧率） */
  perf: PerfTier;
  /** 系统是否要求"减少动态效果"（无障碍，不是性能） */
  reducedMotion: boolean;
}

export interface WsCaps {
  render: CapsRender;
  /** 小区级地图本体由谁画：`webgl ? "maplibre" : "sketch"` */
  engine: Engine;
  layers: Record<LayerId, LayerMode>;
}

/** 一个图层的静态事实（写死在这里，改一处全局生效） */
export interface LayerSpec {
  id: LayerId;
  /** 中文名 —— 自检失败信息与调试面板里用它，别让报错只有英文 id */
  zh: string;
  /** 是否**已经**有"真实经纬度"实现（决定能不能在 `maplibre` 模式下开） */
  migrated: boolean;
  /** 是否还有老路实现（`#pin` 槽里的那套 CSS transform 图层） */
  legacyAvailable: boolean;
}

/* ══════════════════════════════════════════════════════════════════
 * 二、图层事实表（**唯一**一份；别再在组件里写 `v-if` 常量）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 这张表就是「P1b 图层搬迁」的进度表。
 * `migrated: false` 的图层在 `maplibre` 模式下**必须**是 `off` —— 打开就是位置漂移。
 * 迁移完一层，把这里改成 `true`（**只改这一个地方**），对该层的开关就自动全程生效。
 */
export const WS_LAYERS: readonly LayerSpec[] = [
  // 头像：已经迁移成地图库 Marker（`WsDistrictMapLibre` 的 `markers`/`syncPins`），
  // 且无 WebGL 时也有 DOM 钉子（`domPins`）⇒ 两条路都对，是**样板层**。
  { id: "avatar", zh: "人物头像", migrated: true, legacyAvailable: true },
  // 下面四层仍只有老路（草图网格 → CSS transform）⇒ 在 maplibre 模式下必须关。
  // 机主反馈「全区点不动/人物看不到」时不要急着打开它们 —— 先按 P1b 逐层迁移。
  { id: "facility", zh: "生活设施", migrated: false, legacyAvailable: true },
  { id: "transit", zh: "交通站点", migrated: false, legacyAvailable: true },
  { id: "windowLight", zh: "窗户光", migrated: false, legacyAvailable: true },
  { id: "vehicle", zh: "交通工具", migrated: false, legacyAvailable: true },
  // AI 精绘：产出用的是"28×28 草图网格 → 整个区县 bbox"的**示意映射**，
  // 一栋"楼"落到真地图上有几百米宽 ⇒ 盖在真楼房上只会弄脏画面（机主：「这个 ai 2d 小区好丑」）。
  // 所以只有 `sketch` 引擎（无 WebGL 的示意模式）下才允许开。
  { id: "ai", zh: "AI 精绘示意", migrated: false, legacyAvailable: true },
  // 老草图底图本体：整张 78KB 的 SVG data-url，手势变换时每次都要重新合成 ⇒ 卡顿主因。
  // 已下线（原 `SKETCH_DISABLED = true`）；保留这个 id 是为了让"为什么没草图"有个能回答的地方。
  { id: "sketch", zh: "本地草图底图", migrated: false, legacyAvailable: true },
] as const;

/* ══════════════════════════════════════════════════════════════════
 * 三、设备能力探测（全部可注入 ⇒ 可被自检覆盖）
 * ══════════════════════════════════════════════════════════════════ */

/** 探测用的环境快照（默认取真实 `navigator`，自检里喂假值） */
export interface DeviceEnv {
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

/** 读真实环境；拿不到就给空对象（**不抛错**，拿不到信号时按"不降级"走） */
export function readDeviceEnv(): DeviceEnv {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    hardwareConcurrency: Number(nav.hardwareConcurrency || 0),
    deviceMemory: Number(nav.deviceMemory || 0),
  };
}

/**
 * 核数 / 内存这一路的"这台机器是不是弱"判定。
 *
 * ⚠️ **这是全仓库唯一一份**。历史上同一个问题有两个答案（这就是"降级乱降"的根）：
 *   · `wsGeo.detectLowPerf()`（2026-09-14）：**≤4 核 或 ≤3GB** ⇒ 弱；
 *   · `wsPerf.detectTier()`（2026-09-19）：**≤4 核 或 ≤4GB** ⇒ 弱。
 *   ⇒ **一台 4GB 内存的手机（很常见的那一档）会同时得到"弱"和"不弱"两个答案。**
 *
 * ## 收敛时取了哪个值：**≤4GB**（= `detectTier` 那份）
 * 依据是"**谁真正生效**"，不是"谁写得早"：
 *   · 用户看得见的降级（`.ws-perf-low` 那个 CSS 类、气泡上限、zoom 量化）全部来自
 *     `wsPerf` 算出的档位 ⇒ 生效的是 **≤4GB** 那份；
 *   · `wsGeo.detectLowPerf()` 在收敛前就已经**只剩 1 个调用点**（`useWorldSimGeo` 的兜底），
 *     而那个兜底在 `WorldSim` 里被 `perf.low` 覆盖掉了 ⇒ 它那份 ≤3GB 基本没生效过。
 * ⇒ 取 ≤4GB 才能**不改变机主现在看到的行为**（去屎山的第一条纪律：不许顺手改行为）。
 *
 * ## 与 fps 那一半的分工（别混）
 * 本函数只看**设备静态信号**（核数/内存），**不看实测帧率** ——
 * "设备弱 + 实测帧率"两路合成最终档位是 `wsPerf.detectTier()` 的活，
 * 它会把结果通过 `setPerfTier()` 写回这里。**单向：wsPerf → wsCaps。**
 *
 * 拿不到任何信号（0）⇒ **不判弱**（宁可多开动画，也别把好机器误降级）。
 */
export function detectDeviceLow(env: DeviceEnv = readDeviceEnv()): boolean {
  const cores = Number(env.hardwareConcurrency || 0);
  const mem = Number(env.deviceMemory || 0);
  if (cores > 0 && cores <= 4) return true;
  if (mem > 0 && mem <= 4) return true;
  return false;
}

/**
 * 读设备静态信号，换成 `{ cores, memGB }` 这套命名（`wsPerf.PerfEnv` 用的就是它）。
 *
 * ⚠️ **这是全仓库唯一一处读 `navigator.hardwareConcurrency / deviceMemory`**。
 * 过去 `wsGeo` 与 `wsPerf.readPerfEnv()` 各写了一遍同样的
 * `navigator as Navigator & { deviceMemory?: number }` 强转 —— 抄两遍就会漂。
 */
export function readDeviceSignals(): { cores: number; memGB: number } {
  const env = readDeviceEnv();
  return {
    cores: Number(env.hardwareConcurrency || 0),
    memGB: Number(env.deviceMemory || 0),
  };
}

/** 探测 WebGL 用的最小接口（自检里喂一个假 canvas 就行） */
export interface WebglProbe {
  getContext(type: string): unknown;
}

/**
 * 有没有 WebGL。
 *
 * ⚠️ **这是全仓库唯一一份**：`WsDistrictMapLibre.vue` 里原本自己 new 一个 canvas 探一次
 * （`t.getContext("webgl2") || t.getContext("webgl")`），别处再探一次就会两边不一致
 * ⇒ 出现"组件 A 以为有 WebGL、组件 B 以为没有"的鬼故事。
 *
 * @param probe 不给就自己造一个 canvas（在非浏览器环境返回 false，不抛错）
 */
export function detectWebgl(probe?: WebglProbe): boolean {
  try {
    let p = probe;
    if (!p) {
      if (typeof document === "undefined") return false;
      p = document.createElement("canvas") as unknown as WebglProbe;
    }
    const gl = p.getContext("webgl2") || p.getContext("webgl");
    return !!gl;
  } catch {
    // 有些 WebView 在"软渲染禁用"时会直接抛错而不是返回 null
    return false;
  }
}

/** 系统是否要求"减少动态效果"（无障碍偏好，不是性能档） */
export function detectReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 四、仲裁：设备能力 → 每个图层走哪条路（**纯函数**，自检直接打这里）
 * ══════════════════════════════════════════════════════════════════ */

/** 仲裁输入：只要这三样，其它都是推出来的 */
export interface CapsInput {
  webgl: boolean;
  perf: PerfTier;
  reducedMotion: boolean;
}

/**
 * 单个图层的走法。规则**按优先级**从上往下判，第一条命中就返回：
 *
 * ① **窗户光 + 低端机 ⇒ off**：几百个节点在合成器上排队，是纯装饰，省下来给地图；
 * ② **没有 WebGL ⇒ legacy**（若该层有老路）—— 低端机/无 WebGL 的降级路**必须仍然可用**，
 *    这是真需求：不能让角色整批消失；
 * ③ **`maplibre` 引擎 + 该层没迁移 ⇒ off** —— 老投影 ≠ 真实经纬度，画上去就是位置漂移，
 *    **宁可不画**（详见本文件开头的"按层说"那段）；
 * ④ **`maplibre` 引擎 + 已迁移 + 该层的老路在真地图上无意义（`ai`/`sketch`）⇒ off**；
 * ⑤ 其余 ⇒ 该层在 `maplibre` 下就是 `maplibre`。
 */
export function resolveLayerMode(
  spec: LayerSpec,
  caps: Pick<WsCaps, "engine"> & { render: CapsInput }
): LayerMode {
  const { webgl, perf } = caps.render;
  const ml = caps.engine === "maplibre";

  // ① 低端机省算力：纯装饰层先关（有老路也关 —— 它的价值就是好看）
  if (spec.id === "windowLight" && perf === "low") return "off";

  // ② 无 WebGL：只能走老路。没有老路实现就如实"不画"，而不是假装画了
  if (!webgl) return spec.legacyAvailable ? "legacy" : "off";

  // ③ 真地图 + 未迁移 ⇒ 关（打开就是漂移）
  if (!spec.migrated) return "off";

  // ④⑤ 已迁移的层走地图库
  return ml ? "maplibre" : "off";
}

/** 由设备能力合成完整能力矩阵（**纯函数**：同样的输入永远同样的输出） */
export function resolveCaps(input: CapsInput): WsCaps {
  const engine: Engine = input.webgl ? "maplibre" : "sketch";
  const layers = {} as Record<LayerId, LayerMode>;
  for (const spec of WS_LAYERS) {
    layers[spec.id] = resolveLayerMode(spec, { engine, render: input });
  }
  return {
    render: { webgl: input.webgl, perf: input.perf, reducedMotion: input.reducedMotion },
    engine,
    layers,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 五、模块级单例（组件/composable 读它；`wsPerf` 往里写档位）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 初始能力矩阵。**模块加载时算一次**：
 * - `webgl` / `reducedMotion` 是设备事实，进来就不再变（页面运行中变不了）；
 * - `perf` 先按**设备档位**给个初值，随后由 `wsPerf` 用"设备档位 + 实测帧率"覆盖
 *   （`setPerfTier`）—— 这是唯一允许被改写的字段。
 */
function initialCaps(): WsCaps {
  return resolveCaps({
    webgl: detectWebgl(),
    perf: detectDeviceLow() ? "low" : "high",
    reducedMotion: detectReducedMotion(),
  });
}

let current: WsCaps = initialCaps();

/** 读当前能力矩阵（**只读用途**；别改返回对象，改了不生效还会骗人） */
export function readCaps(): WsCaps {
  return current;
}

/** 覆盖性能档（`wsPerf` 专用：设备档位 / 实测帧率 / 用户手动选择都从这一个口进来） */
export function setPerfTier(tier: PerfTier): WsCaps {
  current = resolveCaps({ ...current.render, perf: tier });
  return current;
}

/** 仅测试用：把单例重置回"刚进页面"的状态 */
export function resetCapsForTest(input?: Partial<CapsInput>): WsCaps {
  const base: CapsInput = {
    webgl: detectWebgl(),
    perf: detectDeviceLow() ? "low" : "high",
    reducedMotion: detectReducedMotion(),
  };
  current = resolveCaps({ ...base, ...input });
  return current;
}

/* ══════════════════════════════════════════════════════════════════
 * 六、"为什么关了"—— 每个 off 都要能回答（这是防"乱降"的最后一道闸）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 给图层当前状态一句人话解释。**调试面板与自检都该用它**。
 * 有了它，"某个图层不见了"就不再需要翻代码猜 —— 页面能直接把原因写在脸上。
 */
export function layerReason(id: LayerId): string {
  const spec = WS_LAYERS.find((s) => s.id === id);
  if (!spec) return `没有这个图层：${id}`;
  const { render, engine, layers } = current;
  const mode = layers[id];
  const head = `${spec.zh}：${mode}`;

  if (mode === "off") {
    if (id === "windowLight" && render.perf === "low") {
      return `${head} —— 低端机档位，窗户光是纯装饰，省算力给地图`;
    }
    if (!render.webgl) {
      return `${head} —— 这台机器没有 WebGL，且这层没有老路实现（不画假的）`;
    }
    if (!spec.migrated) {
      return `${head} —— 「${spec.zh}」还没迁移到真实经纬度；在真地图上开它会位置漂移，等 P1b 逐层迁移（见 AUDIT-STINK.md）`;
    }
    return `${head} —— 当前引擎是 ${engine}，这层没实现这条路`;
  }
  if (mode === "legacy") {
    return `${head} —— 没有 WebGL，走老路（草图网格 → CSS transform），位置对得上`;
  }
  return `${head} —— 走真实经纬度（地图库）`;
}

/** 一次性拿到"哪个图层为什么是什么状态"的整张表（调试面板 / 自检失败信息用） */
export function explainLayers(): Array<{ id: LayerId; zh: string; mode: LayerMode; why: string }> {
  return WS_LAYERS.map((s) => ({ id: s.id, zh: s.zh, mode: current.layers[s.id], why: layerReason(s.id) }));
}
