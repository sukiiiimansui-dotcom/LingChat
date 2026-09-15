// 「世界模拟」T4-2：天气的**纯逻辑层** —— 判定 / 强度 / 色调 / 粒子
//
// 为什么单独一个纯 TS 文件（而不是塞进组件里）：
//   · 判定（`desc`/`desc_en`/云量/`is_*` 六个信号 → 十种天气）与强度（文字等级 + 降水量
//     加权）是**业务规则**，写在组件里就只能靠肉眼验；
//   · 粒子位置全部由 `t` 与索引哈希即时算出（帧间不存粒子数组 → 零 GC 压力），
//     这是纯函数里最容易写错、也最值得单测的一块；
//   · 于是 `node weather_selftest.mjs` 用 esbuild 打包后能秒级跑断言，不用开浏览器。
//
// ── 与老线的关系（`public/world_map/world_weather.js`，625 行裸 JS）────────────
//   判定优先级、强度公式、色调表、四套粒子的画法**逐值照搬**老线
//   （那套已经在老线的 canvas 上跑过一轮）。变了的是**调用方式**：
//   老线自己 `fetch(API_BASE + '/api/weather')`（写死 8790），这里**不碰网络** ——
//   数据由上层用 `worldMapApi.weather()` 拿（真壳 invoke / 浏览器 HTTP 双通路），
//   这一层只做「原始 payload → 视觉」。
//
// ── 优雅降级（T4-2 的硬要求）──────────────────────────────────────────────
//   拿不到天气时**不猜、不编、不留空白**：
//   `degradedState(reason)` 给出一个明确的「天气不可用」中性状态，
//   角标据此显示「天气不可用」而不是一个空框或上一次的陈旧值。

/** 十种天气 */
export type WsWeatherKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "overcast"
  | "rain"
  | "thunder"
  | "snow"
  | "fog"
  | "haze"
  | "unknown";

/** 中文名（照搬老线 `KIND_LABEL`） */
export const KIND_LABEL: Record<WsWeatherKind, string> = {
  clear: "晴",
  partly: "局部多云",
  cloudy: "多云",
  overcast: "阴",
  rain: "雨",
  thunder: "雷雨",
  snow: "雪",
  fog: "雾",
  haze: "霾",
  unknown: "未知",
};

/** 图标（照搬老线 `KIND_ICON`；霾那个 ZWJ 表情照抄，别"手打"成两个字符） */
export const KIND_ICON: Record<WsWeatherKind, string> = {
  clear: "☀️",
  partly: "🌤️",
  cloudy: "⛅",
  overcast: "☁️",
  rain: "🌧️",
  thunder: "⛈️",
  snow: "❄️",
  fog: "🌫️",
  haze: "😶‍🌫️",
  unknown: "❔",
};

/** 天气状态（`normalize()` 的产出；视觉层与角标都只认它） */
export interface WsWeatherState {
  kind: WsWeatherKind;
  kindLabel: string;
  label: string;
  icon: string;
  desc: string;
  /**
   * `desc` 是不是**接口真给的**。
   * false = `desc` 只是按云量推出来的中文类型名（老线的兜底行为），
   * 此时角标不该把它当成"数据"念出来（会变成「晴 5℃」这种假精确）。
   */
  descFromData: boolean;
  descEn: string;
  city: string;
  tempC: number | null;
  feelsLikeC: number | null;
  humidity: number | null;
  windKmph: number;
  cloudcover: number;
  /** 云量 0..1 */
  cover: number;
  precipMm: number;
  visibilityKm: number | null;
  /** 降水/雾的视觉强度 0..1 */
  intensity: number;
  isRain: boolean;
  isSnow: boolean;
  isFog: boolean;
  isThunder: boolean;
  /** 需要"湿地面"效果 */
  isWet: boolean;
  /** true = 这次没拿到真实天气（降级态，见 `degradedState`） */
  degraded: boolean;
  /** 降级原因（给角标的 title 用，人工可读；拿不到就说拿不到，不编） */
  reason: string;
  /** 原始 payload 里的 error 字段（有就原样带出来，便于真机排障） */
  error: string | null;
  fetchedAt: number;
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/**
 * 取第一个**有值**（不是 undefined/null/空串）的字段。
 *
 * 为什么需要它：`温度 = 0℃` 是合法数据，而 `pick` 之前的写法是
 * `num(cur.temp_c ?? cur.tempC) ?? 兜底` —— `??` 只在 null/undefined 时跳，
 * 但下面的 `desc` 兜底用的是 `cur.desc ?? 类型名`，遇到 `desc` 是空串就会
 * 把「晴」写进描述里，于是角标显示成「晴 5°C」而不是「5°C」。
 * 一个 helper 把「有没有值」这件事收口，两处都不用再各自判断。
 */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** 索引哈希 → [0,1)：帧间稳定、无需保存随机数（照搬老线 `hash1`） */
export function hash1(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** `[r,g,b]` + alpha → `rgba(...)`（照搬老线 `rgba`） */
export function rgba(c: readonly [number, number, number], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${Math.round(a * 1000) / 1000})`;
}

/** 宽松取数：字符串数字也认（`world_map_weather` 的 `temp_C` 就是字符串） */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 判定与强度（照搬老线 `classify` / `levelFromText` / `intensityOf`）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 判定天气类型。优先级：雪 > 雷雨 > 雨 > 雾 > 霾 > 阴/多云/晴。
 *
 * 顺序不能调：`"Light rain"` 同时命中 `rain` 与 `light`，`"Partly cloudy"` 同时命中
 * `partly` 与 `cloud` —— 先判重灾、再判云量，是老线踩出来的顺序。
 */
export function classify(d: Record<string, unknown> | null | undefined): WsWeatherKind {
  const o = d || {};
  const en = String(o.desc_en || "").toLowerCase();
  const zh = String(o.desc || "");
  const cc = Number(o.cloudcover || 0);
  if (o.is_snow || /snow|blizzard|sleet/.test(en) || zh.includes("雪")) return "snow";
  if (/thunder/.test(en) || zh.includes("雷")) return "thunder";
  if (o.is_rain || /rain|drizzle|shower/.test(en) || zh.includes("雨")) return "rain";
  if (o.is_fog || /fog|mist/.test(en) || zh.includes("雾")) return "fog";
  if (/haze|smog|sand|dust/.test(en) || zh.includes("霾")) return "haze";
  if (/overcast/.test(en) || zh.includes("阴") || cc >= 88) return "overcast";
  // 文本判定要**早于**纯云量阈值（"Partly cloudy" 同时含 partly 与 cloud）
  if (/partly|mostly sunny|scattered|few cloud/.test(en) || zh.includes("局部")) return "partly";
  if (/cloud/.test(en) || zh.includes("多云") || cc >= 55) return "cloudy";
  if (/sunny|clear/.test(en) || zh.includes("晴")) return "clear";
  if (cc >= 25) return "partly";
  return cc < 25 ? "clear" : "cloudy";
}

/** 文字等级：毛毛雨 0.25 / 小 0.4 / 中 0.6 / 大 0.85 / 暴 1.0（照搬老线） */
export function levelFromText(text: unknown): number | null {
  const s = String(text || "").toLowerCase();
  if (/torrential|blizzard|暴/.test(s)) return 1.0;
  if (/heavy|violent|大/.test(s)) return 0.85;
  if (/moderate|中/.test(s)) return 0.6;
  if (/light|small|patchy|drizzle|毛毛|小|零星/.test(s)) return 0.4;
  if (/possible|nearby|附近|可能/.test(s)) return 0.3;
  return null;
}

/** 降水强度 0..1（文字等级 7 : 降水量 3 加权；无降水为 0）（照搬老线） */
export function intensityOf(kind: WsWeatherKind, d: Record<string, unknown> | null): number {
  const o = d || {};
  const precip = Number(o.precip_mm || 0);
  const pLevel =
    precip <= 0 ? 0 : precip < 0.5 ? 0.3 : precip < 2.5 ? 0.5 : precip < 7.6 ? 0.75 : 1.0;
  if (kind === "rain" || kind === "thunder" || kind === "snow") {
    const lvEn = levelFromText(o.desc_en);
    const lv = lvEn != null ? lvEn : levelFromText(o.desc);
    let base = lv != null ? 0.7 * lv + 0.3 * pLevel : pLevel || 0.35;
    if (kind === "thunder") base = Math.max(base, 0.6);
    return clamp(base, 0.22, 1);
  }
  if (kind === "fog" || kind === "haze") {
    const v = Number(o.visibility_km);
    if (!Number.isFinite(v) || v <= 0) return 0.6;
    if (v <= 1) return 1.0;
    if (v <= 2) return 0.85;
    if (v <= 5) return 0.68;
    if (v <= 10) return 0.45;
    return 0.3;
  }
  return 0; // 晴/阴：无降水强度
}

/** 各字段的兜底取值（`current` / `weather` / 顶层 三种形状都认） */
function pickRoot(raw: unknown): Record<string, unknown> {
  const o = (raw || {}) as Record<string, unknown>;
  const cur = o.current || o.weather;
  return (cur && typeof cur === "object" ? cur : o) as Record<string, unknown>;
}

/**
 * 原始 payload → 统一天气状态。
 *
 * ⚠️ 与老线的一处**有意差异**：老线 `normalize` 只吃 `current` 那一层，
 *    而真机回来的形状有三种（`{current:{...}}` / `{weather:{...}}` / 顶层就是），
 *    `useWsActors.ts::describeWeather` 已经在处理这件事了 —— 这里收口成一处，
 *    免得角标显示「未知」而角色面板显示「小雨」（同一份数据两个口径）。
 */
export function normalize(raw: unknown): WsWeatherState {
  const o = (raw || {}) as Record<string, unknown>;
  const cur = pickRoot(raw);
  const kind = classify(cur);
  const clouds = clamp(num(cur.cloudcover) ?? 0, 0, 100);
  /* 描述：**原始 payload 里到底有没有给**要留痕。
   * 为什么：`desc` 兜底成中文类型名（照搬老线）之后，角标就没法区分
   * 「接口说今天晴」和「接口没给描述，我们按云量推的晴」—— 于是角标会显示
   * 「晴 5°C」这种把推断当数据的文案。`descFromData` 就是那一条留痕，
   * 供电台/角标决定"要不要把那句话说出来"（自检里踩到过，见 weather_selftest_t2 ⑧）。 */
  const rawDesc = pick(cur, "desc", "weather_desc", "text");
  const descFromData = String(rawDesc ?? "").trim() !== "";
  const desc = descFromData ? String(rawDesc) : KIND_LABEL[kind];
  return {
    kind,
    kindLabel: KIND_LABEL[kind],
    label: KIND_LABEL[kind],
    icon: KIND_ICON[kind],
    // ⚠️ `temp_C`（大写 C）是 Rust 侧 `world_map_weather` 的字段名，别漏
    desc,
    descFromData,
    descEn: String(pick(cur, "desc_en") ?? ""),
    city: String(pick(cur, "city") ?? ""),
    tempC: num(pick(cur, "temp_c", "tempC", "temp_C", "temp")),
    feelsLikeC: num(pick(cur, "feels_like_c", "feelsLikeC", "FeelsLikeC")),
    humidity: num(pick(cur, "humidity")),
    windKmph: num(pick(cur, "wind_kmph", "windKmph", "windspeedKmph")) ?? 0,
    cloudcover: clouds,
    cover: clouds / 100,
    precipMm: num(pick(cur, "precip_mm", "precipMm", "precipMM")) ?? 0,
    visibilityKm: num(pick(cur, "visibility_km", "visibilityKm", "visibility")),
    intensity: intensityOf(kind, cur),
    isRain: kind === "rain" || kind === "thunder",
    isSnow: kind === "snow",
    isFog: kind === "fog" || kind === "haze",
    isThunder: kind === "thunder",
    isWet: kind === "rain" || kind === "thunder",
    degraded: false,
    reason: "",
    error: cur.error ? String(cur.error) : null,
    fetchedAt: Date.now(),
  };
}

/**
 * 降级态：**拿不到天气**时用它。
 *
 * 为什么不直接返回 `normalize(null)`：那会得到一个 `kind = "clear"`（云量 0 → 晴）的
 * 状态 —— 也就是**把「拿不到」显示成「晴天」**。机主明确讨厌假数据，所以降级态是
 * 独立的：`degraded = true` + `kind = "unknown"`，角标据此显示「天气不可用」。
 *
 * @param reason 人工可读的原因（角标 hover/title 会显示它，便于真机排障）
 */
export function degradedState(reason: string): WsWeatherState {
  const s = normalize({ kind: "unknown" });
  return {
    ...s,
    kind: "unknown",
    kindLabel: "天气不可用",
    label: "天气不可用",
    icon: "🌐",
    desc: "",
    descFromData: false,
    degraded: true,
    reason: String(reason || ""),
  };
}

/** 角标一行文字：`小雨 18°C`；降级时是「天气不可用」；没温度就只给描述 */
export function weatherLine(w: WsWeatherState): string {
  if (w.degraded) return "天气不可用";
  const t = w.tempC;
  const hasT = typeof t === "number" && Number.isFinite(t);
  // 只念**接口真给的**描述；推断出来的类型名不算数据（见 `descFromData` 的注释）
  const desc = w.descFromData ? String(w.desc || "").trim() : "";
  if (desc && hasT) return `${desc} ${Math.round(t)}°C`;
  if (desc) return desc;
  if (hasT) return `${Math.round(t)}°C`;
  return KIND_LABEL[w.kind] || "未知";
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 天气色调（照搬老线 `WEATHER_TINT` / `weatherTint`）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 每种天气对地图整体的一层色（mode: source-over 压暗 / screen 提亮） */
export const WEATHER_TINT: Record<
  WsWeatherKind,
  { c: readonly [number, number, number]; a: number; mode: "screen" | "source-over"; label: string }
> = {
  clear: { c: [255, 236, 188], a: 0.12, mode: "screen", label: "晴·暖亮" },
  partly: { c: [216, 230, 244], a: 0.07, mode: "screen", label: "局部多云·轻提亮" },
  cloudy: { c: [142, 158, 178], a: 0.13, mode: "source-over", label: "多云·偏灰" },
  overcast: { c: [104, 118, 138], a: 0.21, mode: "source-over", label: "阴·压暗" },
  rain: { c: [58, 84, 116], a: 0.27, mode: "source-over", label: "雨·灰蓝" },
  thunder: { c: [36, 46, 70], a: 0.36, mode: "source-over", label: "雷雨·沉重" },
  snow: { c: [228, 240, 255], a: 0.26, mode: "screen", label: "雪·高亮偏白" },
  fog: { c: [196, 204, 212], a: 0.36, mode: "source-over", label: "雾·低对比" },
  haze: { c: [198, 184, 164], a: 0.3, mode: "source-over", label: "霾·泛黄" },
  unknown: { c: [128, 128, 128], a: 0.0, mode: "source-over", label: "未知" },
};

/** 取某天气对应的 RGBA 叠加色（alpha 随强度缩放；无降水保持基准） */
export function weatherTint(weather: { kind?: string; intensity?: number } | string): {
  kind: string;
  r: number;
  g: number;
  b: number;
  a: number;
  mode: "screen" | "source-over";
  label: string;
  css: string;
} {
  const w = typeof weather === "string" ? { kind: weather, intensity: 1 } : weather || {};
  const k = (w.kind || "unknown") as WsWeatherKind;
  const p = WEATHER_TINT[k] || WEATHER_TINT.unknown;
  const it = Number(w.intensity || 0);
  const scale =
    k === "rain" || k === "thunder" || k === "snow" || k === "fog" || k === "haze"
      ? 0.55 + 0.45 * clamp(it, 0, 1) // 降水类：强度越高色越重
      : 1;
  const a = Math.round(p.a * scale * 1000) / 1000;
  return {
    kind: k,
    r: p.c[0],
    g: p.c[1],
    b: p.c[2],
    a,
    mode: p.mode,
    label: p.label,
    css: rgba(p.c, a),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 粒子（照搬老线 `drawRain` / `drawSnow` / `drawFog` / `drawLightning`）
 *
 * 两条性能约定（老线的文件头写过，这里必须继承）：
 *   · 所有粒子的位置由 `t` 与索引哈希**即时算出**，帧间不保存粒子数组 → 零 GC；
 *   · 粒子总数有硬上限（雨 260 / 雪 220），雾用一次性生成的离屏软边贴图复用。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 画布的最小接口（Node 自检时给个假 ctx 也能跑，不必真的开 canvas） */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "ellipse"
  | "fill"
  | "stroke"
  | "fillRect"
  | "drawImage"
  | "createRadialGradient"
  | "save"
  | "restore"
  | "canvas"
> & {
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
};

const TAU = Math.PI * 2;

/** 雨丝：斜线，密度随强度（照搬老线；3 档粗细批量描边，减少状态切换） */
export function drawRain(
  ctx: Ctx2D,
  w: number,
  h: number,
  intensity: number,
  t: number,
  opts: {
    maxParticles?: number;
    slant?: number;
    speed?: number;
    color?: readonly [number, number, number];
  } = {}
): number {
  const it = clamp(Number(intensity) || 0, 0, 1);
  if (it <= 0.01 || !ctx) return 0;
  const maxN = opts.maxParticles || 260; // 粒子硬上限
  const n = Math.round(maxN * it); // 密度 ∝ 强度
  const slant = opts.slant == null ? 0.26 : opts.slant; // 斜线斜率（风偏）
  const speed = opts.speed || 1;
  const col = opts.color || [198, 220, 240];
  const ts = (t || 0) / 1000;
  const buckets = [
    { lw: 1.0, a: 0.2, len: 13 },
    { lw: 1.4, a: 0.32, len: 21 },
    { lw: 1.8, a: 0.44, len: 30 },
  ];
  let drawn = 0;
  for (let b = 0; b < buckets.length; b++) {
    const bk = buckets[b]!;
    ctx.beginPath();
    for (let i = b; i < n; i += buckets.length) {
      const s1 = hash1(i * 3.1 + 1);
      const s2 = hash1(i * 7.3 + 2);
      const s3 = hash1(i * 11.7 + 3);
      const len = bk.len * (0.65 + s3 * 0.75) * (0.75 + 0.45 * it);
      const spd = (620 + s2 * 560) * (0.55 + 0.65 * it) * speed; // px/s
      const x = s1 * (w + 160) - 80;
      const y = ((s2 * 4096 + ts * spd) % (h + 90)) - 45;
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * slant, y + len);
      drawn++;
    }
    ctx.strokeStyle = rgba(col, clamp(bk.a * (0.7 + 0.5 * it), 0, 1));
    ctx.lineWidth = bk.lw;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  return drawn;
}

/** 雪花：正弦横摆 + 分档大小，批量填充（照搬老线） */
export function drawSnow(
  ctx: Ctx2D,
  w: number,
  h: number,
  intensity: number,
  t: number,
  opts: { maxParticles?: number; color?: readonly [number, number, number] } = {}
): number {
  const it = clamp(Number(intensity) || 0, 0, 1);
  if (it <= 0.01 || !ctx) return 0;
  const maxN = opts.maxParticles || 220;
  const n = Math.round(maxN * it);
  const ts = (t || 0) / 1000;
  const col = opts.color || [255, 255, 255];
  const buckets = [
    { r: 1.0, a: 0.85 },
    { r: 1.9, a: 0.68 },
    { r: 3.1, a: 0.5 },
  ];
  let drawn = 0;
  for (let b = 0; b < buckets.length; b++) {
    const bk = buckets[b]!;
    ctx.beginPath();
    for (let i = b; i < n; i += buckets.length) {
      const s1 = hash1(i * 5.1 + 1);
      const s2 = hash1(i * 13.3 + 2);
      const s3 = hash1(i * 17.9 + 3);
      const s4 = hash1(i * 19.1 + 4);
      const spd = (34 + s2 * 76) * (0.6 + 0.6 * it); // 下落 px/s
      const sway = (10 + s3 * 26) * (0.5 + it);
      const x = s1 * (w + 40) - 20 + Math.sin(ts * (0.5 + s4) + s4 * TAU) * sway;
      const y = ((s4 * 4096 + ts * spd) % (h + 30)) - 15;
      const r = bk.r * (0.8 + s3 * 0.4);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
      drawn++;
    }
    ctx.fillStyle = rgba(col, clamp(bk.a * (0.65 + 0.4 * it), 0, 1));
    ctx.fill();
  }
  return drawn;
}

/** 雾/霾：大尺寸柔边雾团横向缓慢漂移（照搬老线；离屏软边贴图惰性生成一次） */
export function drawFog(
  ctx: Ctx2D,
  w: number,
  h: number,
  intensity: number,
  t: number,
  opts: {
    puffs?: number;
    color?: readonly [number, number, number];
    sprite?: CanvasImageSource | null;
  } = {}
): number {
  const it = clamp(Number(intensity) || 0, 0, 1);
  if (it <= 0.01 || !ctx) return 0;
  const count = opts.puffs || Math.round(7 + 7 * it);
  const col = opts.color || [214, 220, 228];
  const ts = (t || 0) / 1000;
  const sprite = opts.sprite ?? null;
  const prevA = ctx.globalAlpha;
  for (let i = 0; i < count; i++) {
    const s1 = hash1(i * 23.7 + 7);
    const s2 = hash1(i * 29.3 + 11);
    const s3 = hash1(i * 31.1 + 13);
    const R = (0.3 + s1 * 0.45) * Math.max(w, h) * (0.65 + 0.55 * it);
    const x = ((ts * (6 + 10 * s3) + s1 * w * 1.7) % (w + 2 * R)) - R; // 缓慢横移
    const y = h * (0.15 + s2 * 0.8) + Math.sin(ts * 0.18 + i) * h * 0.035;
    ctx.globalAlpha = clamp((0.08 + 0.2 * s2) * (0.45 + 0.75 * it), 0, 0.6);
    if (sprite) {
      ctx.drawImage(sprite, x - R, y - R, R * 2, R * 2);
    } else {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, R);
      rg.addColorStop(0, rgba(col, 0.5));
      rg.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = prevA;
  return count;
}

/** 雷雨闪电：按 5 秒一个时隙随机触发，双次闪烁（照搬老线） */
export function drawLightning(
  ctx: Ctx2D,
  w: number,
  h: number,
  t: number,
  opts: { slotSec?: number; chance?: number } = {}
): number {
  if (!ctx) return 0;
  const slotSec = opts.slotSec || 5;
  const chance = opts.chance == null ? 0.6 : opts.chance;
  const ts = (t || 0) / 1000;
  const slot = Math.floor(ts / slotSec);
  if (hash1(slot * 3.7 + 1) > chance) return 0; // 约 60% 的时隙有闪电
  const local = ts % slotSec;
  let k = 0;
  if (local < 0.12) k = 1 - local / 0.12;
  else if (local > 0.22 && local < 0.3) k = ((0.3 - local) / 0.08) * 0.7;
  if (k <= 0) return 0;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = `rgba(214,232,255,${(0.45 * k).toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = prevOp;
  return 1;
}

/**
 * 离屏软边雾团贴图：惰性生成一次，之后每帧只 `drawImage`。
 * 没有 DOM（node 自检）时返回 null，`drawFog` 会自动退回径向渐变。
 */
let puffCache: { key: string; cv: HTMLCanvasElement } | null = null;

export function getPuff(color: readonly [number, number, number]): HTMLCanvasElement | null {
  if (typeof document === "undefined" || !document.createElement) return null;
  const key = color.join(",");
  if (puffCache && puffCache.key === key) return puffCache.cv;
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d");
  if (!g) return null;
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, rgba(color, 0.55)); // 中心柔和、边缘全透明 → 自带"模糊感"
  rg.addColorStop(0.45, rgba(color, 0.28));
  rg.addColorStop(0.75, rgba(color, 0.09));
  rg.addColorStop(1, rgba(color, 0));
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  puffCache = { key, cv };
  return cv;
}

/** 统一入口：按天气类型画粒子（雨/雪/雾/雷雨闪光） */
export function drawWeather(
  ctx: Ctx2D,
  weather: WsWeatherState | { kind: string; intensity?: number },
  w: number,
  h: number,
  t: number,
  opts: { maxRain?: number; maxSnow?: number } = {}
): { kind: string; particles: number; fx: number } {
  const w0 = weather as WsWeatherState;
  const kind = String(w0.kind || "unknown");
  const it = w0.intensity == null ? 1 : w0.intensity;
  const out = { kind, particles: 0, fx: 0 };
  if (kind === "rain" || kind === "thunder") {
    out.particles = drawRain(ctx, w, h, it, t, { maxParticles: opts.maxRain ?? 260 });
    if (kind === "thunder") out.fx = drawLightning(ctx, w, h, t);
  } else if (kind === "snow") {
    out.particles = drawSnow(ctx, w, h, it, t, { maxParticles: opts.maxSnow ?? 220 });
  } else if (kind === "fog" || kind === "haze") {
    out.particles = drawFog(ctx, w, h, it, t, { sprite: getPuff([214, 220, 228]) });
  }
  return out;
}
