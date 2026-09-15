// 「世界模拟」T4-1：昼夜（time-of-day）的**纯逻辑层** —— 时段 / 昼夜色调 / 窗户光
//
// 为什么单独一个纯 TS 文件（而不是塞进组件里）：
//   · 这一层全是**纯函数**（小时 → 时段 / → 色调 / 建筑矩形 → 窗户格子），
//     没有 Vue、没有 DOM，所以 `node xxx.mjs` 用 esbuild 打包后能直接跑断言
//     （与 `wsGeo.ts` / `wsDistrictPaint.ts` 的自检口径一致）；
//   · 页面只负责把结果画出来，逻辑错了能在秒级的自检里发现，不用等浏览器。
//
// ── 与老线的关系（`public/world_map/world_time.js`，449 行裸 JS）──────────────
//   时段边界、时段名/图标、昼夜色调关键帧**逐值照搬**老线的 `periodOf` / `timeTint`
//   （老线那套已经跑过一轮，色值是被看过图定下来的，没有理由重调）。
//   变了的是**应用方式**：老线把色调 `ctx.fillRect` 涂在 canvas 上（`applyTimeTint`），
//   而新线地图是 SVG/DOM —— 这里只产出 CSS 颜色，由覆盖层去涂。
//
// ── 与后端的口径（必须一致，否则前端说「夜晚」后端说「傍晚」）────────────────
//   `src-tauri/src/world_map/mod.rs` 的 `period_of(h)`：边界 5/8/11/14/17/19/23，
//   `is_day = 6 <= h < 18`，时段名 `dawn/morning/noon/afternoon/dusk/evening/night`。
//   本文件与它逐字同界 —— 改这里就必须同时改那里。

/** 七个时段（与后端 `period_of()` 同序同值） */
export type WsPeriod = "dawn" | "morning" | "noon" | "afternoon" | "dusk" | "evening" | "night";

/** 时段顺序（昼夜循环的排列；UI 上要按这个顺序列就别再写第二份） */
export const PERIOD_ORDER: readonly WsPeriod[] = [
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "dusk",
  "evening",
  "night",
];

/** 时段中文名（照搬老线 `PERIOD_LABEL`） */
export const PERIOD_LABEL: Record<WsPeriod, string> = {
  dawn: "黎明",
  morning: "清晨",
  noon: "正午",
  afternoon: "午后",
  dusk: "黄昏",
  evening: "傍晚",
  night: "夜晚",
};

/** 时段图标（照搬老线 `PERIOD_ICON`） */
export const PERIOD_ICON: Record<WsPeriod, string> = {
  dawn: "🌅",
  morning: "🌤️",
  noon: "☀️",
  afternoon: "🌤️",
  dusk: "🌇",
  evening: "🌆",
  night: "🌙",
};

/** 任意小时数 → [0,24)；非数字按 0 处理（照搬老线 `normHour`） */
export function normHour(hour: number): number {
  let h = Number(hour) || 0;
  h = h % 24;
  return h < 0 ? h + 24 : h;
}

/** 取时段（与后端 `period_of` 完全同界） */
export function periodOf(hour: number): WsPeriod {
  const h = Math.floor(normHour(hour));
  if (h >= 5 && h < 8) return "dawn";
  if (h >= 8 && h < 11) return "morning";
  if (h >= 11 && h < 14) return "noon";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 19) return "dusk";
  if (h >= 19 && h < 23) return "evening";
  return "night"; // 23,0,1,2,3,4
}

/** 是否白天（与后端 `is_day` 同界：6 ≤ h < 18） */
export function isDay(hour: number): boolean {
  const h = normHour(hour);
  return h >= 6 && h < 18;
}

/** 时段中文名；未知时段回原样（照搬老线 `periodLabel`） */
export function periodLabel(period: string): string {
  return PERIOD_LABEL[period as WsPeriod] || period || "";
}

/** 时段图标；未知时段给个中性钟表（照搬老线 `periodIcon`） */
export function periodIcon(period: string): string {
  return PERIOD_ICON[period as WsPeriod] || "🕐";
}

/* ══════════════════════════════════════════════════════════════════════════
 * 昼夜色调（照搬老线 `TINT_KEYS` / `timeTint`）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个色调关键帧：`h` 小时 → RGB + 不透明度 */
interface TintKey {
  h: number;
  c: readonly [number, number, number];
  a: number;
}

/** 色调关键帧表（逐值照搬老线 `world_time.js:66-82`） */
const TINT_KEYS: readonly TintKey[] = [
  { h: 0.0, c: [8, 16, 46], a: 0.56 }, // 深夜
  { h: 3.6, c: [8, 16, 46], a: 0.56 },
  { h: 4.8, c: [22, 34, 78], a: 0.5 }, // 拂晓前：蓝紫
  { h: 5.6, c: [78, 62, 108], a: 0.34 }, // 黎明：紫粉
  { h: 6.4, c: [196, 116, 78], a: 0.18 }, // 日出：暖橙
  { h: 7.6, c: [255, 198, 140], a: 0.08 }, // 晨光
  { h: 9.5, c: [255, 255, 255], a: 0.0 }, // 白天：透明
  { h: 15.5, c: [255, 255, 255], a: 0.0 },
  { h: 16.8, c: [255, 206, 150], a: 0.09 }, // 午后偏暖
  { h: 18.0, c: [255, 126, 64], a: 0.26 }, // 黄昏：橙红
  { h: 19.1, c: [150, 62, 96], a: 0.38 }, // 暮色：玫紫
  { h: 20.3, c: [34, 44, 96], a: 0.5 },
  { h: 22.0, c: [10, 20, 56], a: 0.55 },
  { h: 24.0, c: [8, 16, 46], a: 0.56 },
];

/** 某一刻的昼夜色调（关键帧之间线性插值） */
export interface WsTimeTint {
  r: number;
  g: number;
  b: number;
  /** 不透明度 0..1（白天为 0 = 不需要画） */
  a: number;
  /** 与 `a` 同值 —— 老线的 `timeTint` 两个字段都给，这里保留以免调用方改口径 */
  alpha: number;
  /** 可直接用的 CSS 颜色 `rgba(r,g,b,a)` */
  css: string;
  period: WsPeriod;
  isDay: boolean;
  label: string;
  hour: number;
  phase: "am" | "pm";
}

/** 取一个浮点数的近似值（与老线 `Math.round(...*1000)/1000` 同口径，避免 0.5600000000000001） */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 该时刻对地图整体的颜色滤镜（线性插值关键帧）。
 *
 * @param hour 0~24，可带小数（17.5 = 17:30）
 */
export function timeTint(hour: number): WsTimeTint {
  const h = normHour(hour);
  let k0 = TINT_KEYS[0]!;
  let k1 = TINT_KEYS[TINT_KEYS.length - 1]!;
  for (let i = 0; i < TINT_KEYS.length - 1; i++) {
    const a = TINT_KEYS[i]!;
    const b = TINT_KEYS[i + 1]!;
    if (h >= a.h && h <= b.h) {
      k0 = a;
      k1 = b;
      break;
    }
  }
  const span = k1.h - k0.h;
  const u = span > 0 ? (h - k0.h) / span : 0;
  const r = Math.round(k0.c[0] + (k1.c[0] - k0.c[0]) * u);
  const g = Math.round(k0.c[1] + (k1.c[1] - k0.c[1]) * u);
  const b = Math.round(k0.c[2] + (k1.c[2] - k0.c[2]) * u);
  const a = round3(k0.a + (k1.a - k0.a) * u);
  const p = periodOf(h);
  return {
    r,
    g,
    b,
    a,
    alpha: a,
    css: `rgba(${r},${g},${b},${a})`,
    period: p,
    isDay: isDay(h),
    label: periodLabel(p),
    hour: h,
    phase: h < 12 ? "am" : "pm",
  };
}

/**
 * 「天黑程度」0..1 —— 窗户光用它决定亮不亮、亮多少。
 *
 * 为什么不直接复用 `timeTint().a`：
 *   色调的 alpha 是**给整张图上滤镜**用的（正午为 0、深夜 0.56），它是一个观感参数；
 *   「该开灯了吗」是一个语义参数。两者恰好都随天黑单调，但口径不同 ——
 *   黄昏 18:00 色调 alpha 只有 0.26（还不算黑），可 18 点天已经暗到该开灯了。
 *   所以这里按**真实天黑区间**单独定义，并在 18:00~20:00 之间平滑过渡（渐变开灯）。
 *
 * @param hour 0~24，可带小数
 */
export function nightLevel(hour: number): number {
  const h = normHour(hour);
  // 天黑：19:00 起逐步变暗 → 21:00 全黑；天亮：5:00 起逐步熄灯 → 7:00 全灭
  if (h >= 21 || h < 5) return 1;
  if (h >= 19) return round3((h - 19) / 2); // 19→21 渐暗
  if (h < 7) return round3(1 - (h - 5) / 2); // 5→7 渐亮
  return 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 窗户光
 *
 * ⚠️ 老线**没有**这个能力（`public/world_map/world_time.js` 里只有
 *    timeTint / applyTimeTint / sunTimes / FACILITIES，grep「窗」零命中）——
 *    这是 T4-1 的原始要求，属于**新写**，不是移植。
 *
 * 做法：新线小区图的建筑是 `<rect class="ws-b">`，坐标在 `0..size` 的格子里
 *      （`wsDistrictPaint.ts` 的 `buildingSpecs`）。这里给每个建筑算出若干**窗格**，
 *      由 `WsWindowLight.vue` 画成一层跟着地图一起缩放的 SVG 覆盖层。
 *      刻意**不改** `buildingSpecs` 的输出：那份 SVG 文本是自检的基准，
 *      动它等于把一堆断言一起改了（得不偿失）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 建筑矩形（坐标系与 `.ws-b` 一致：`0..size` 的格子） */
export interface WsBuildingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一扇亮着的窗（同坐标系） */
export interface WsWindowCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 亮度（错峰用：有的窗亮、有的暗，避免整栋楼一个色块） */
  lit: number;
}

/* ── 窗格的四个常数，是按**真实的小区图**标定的 ──────────────────────────
 * 小区图的网格是 28×28（`WorldSim.vue` 的 `WS_GRID`），实测的建筑量级是
 * **2×2 格子**（`paint.addBuilding({x,y,w:2,h:2})` 那一路，见 P1 自检）。
 * 一开始按「窗边长 0.62 + 墙厚 0.45」标定 → 2×2 的楼扣掉四周墙只剩 1.1 格子，
 * 一扇窗都放不下（自检里 `2×2 量级的楼也能出窗` 那条直接挂了）。
 * 现在的取值让 2×2 能出 **2×2 扇窗**，1×1 的小棚子没有窗（合理：那是个棚）。 */
/** 窗格边长（格子单位） */
const WIN_SIZE = 0.5;
/** 窗格间距（格子单位）：窗边长 + 窗间墙 */
const WIN_PITCH = 0.82;
/** 建筑四周留的墙厚（格子单位），窗不贴边 */
const WIN_INSET = 0.29;
/** 单栋楼的窗户数上限（超了会有楼变成马赛克，不好看） */
const WIN_PER_BLD = 24;
/** 一层里窗户总数上限（手机上 SVG 节点数要克制；与 `.ws-b` 的 900 上限同一口径） */
export const WIN_TOTAL_CAP = 900;

/** 整数哈希 → [0,1)：同一栋楼每次都得到同一个数（不会每帧闪） */
function hash1(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * 从建筑矩形里算出窗格。
 *
 * @param b   建筑矩形
 * @param idx 建筑序号（错峰/亮灭随机都从它派生 —— 纯函数，同输入同输出）
 * @returns 该建筑的窗格（可能为空：楼太小放不下窗）
 */
export function windowCellsOf(b: WsBuildingRect, idx: number): WsWindowCell[] {
  const x = Number(b.x) || 0;
  const y = Number(b.y) || 0;
  const w = Number(b.w) || 0;
  const h = Number(b.h) || 0;
  if (w <= 0 || h <= 0) return [];
  // 可放窗的区域（扣掉四周墙厚）
  const iw = w - WIN_INSET * 2;
  const ih = h - WIN_INSET * 2;
  if (iw < WIN_SIZE || ih < WIN_SIZE) return [];
  const cols = Math.floor((iw + (WIN_PITCH - WIN_SIZE)) / WIN_PITCH);
  const rows = Math.floor((ih + (WIN_PITCH - WIN_SIZE)) / WIN_PITCH);
  if (cols < 1 || rows < 1) return [];
  // 超上限就抽稀（只画一部分窗，而不是把窗画小到看不清）
  const total = cols * rows;
  const step = total > WIN_PER_BLD ? Math.ceil(total / WIN_PER_BLD) : 1;
  const out: WsWindowCell[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      if (step > 1 && n % step !== 0) continue;
      const seed = idx * 97 + n * 7.3;
      out.push({
        x: round3(x + WIN_INSET + c * WIN_PITCH),
        y: round3(y + WIN_INSET + r * WIN_PITCH),
        w: WIN_SIZE,
        h: WIN_SIZE,
        // 0.55~1：全亮会像贴纸，留一点差异才有「有人在住」的感觉
        lit: round3(0.55 + hash1(seed) * 0.45),
      });
    }
  }
  return out;
}

/**
 * 一批建筑的窗格（带总数上限）。
 *
 * @param rects 建筑矩形（一般直接来自 `.ws-b` 的 x/y/width/height）
 * @param cap   总数上限，默认 `WIN_TOTAL_CAP`
 */
export function windowCells(
  rects: readonly WsBuildingRect[],
  cap: number = WIN_TOTAL_CAP
): WsWindowCell[] {
  const out: WsWindowCell[] = [];
  for (let i = 0; i < rects.length && out.length < cap; i++) {
    const cells = windowCellsOf(rects[i]!, i);
    for (const c of cells) {
      if (out.length >= cap) break;
      out.push(c);
    }
  }
  return out;
}
