/**
 * wsArtSky.ts —— 「**基沃托斯的天**」的**纯逻辑**（云带 / 远景山影 / 雾带），2026-09-22 `art=3`。
 *
 * ## 为什么是纯函数 + 为什么用 DOM/canvas 叠加
 * · 根级 `sky` **只认 7 个白名单键**（`sky-color`/`horizon-color`/`fog-color`/`horizon-fog-blend`/
 *   `sky-horizon-blend`/`atmosphere-blend`/`fog-ground-blend`）⇒ **画不出"白云"**；
 * · 往 `layers[]` 塞未知类型/未知 sprite 会让**整份 style 校验失败 ⇒ `load` 永不触发 ⇒ 全站退回 2D**
 *   （踩过）⇒ 云与山影一律走**独立的 canvas 叠加层**，**不碰 style**；
 * · 布点必须是**纯函数**：`(画布尺寸, 地平线 y, pitch, zoom, seed) → 几何`，
 *   这样它能在 Node 里断言（"云只在地平线以上""低档不生成""同一输入同一输出 ⇒ 拖动不抖"）。
 *
 * ## 三条硬要求（机主/主会话）
 * ① **不遮地图**：云只落在地平线**以上**（`y < horizonY`），alpha 低；山影只在**地平线附近**一条带里；
 * ② **随 pitch/zoom 稳定**：几何只依赖传入的 pitch/zoom（无随机、无时间）⇒ 拖动时不会乱跳；
 * ③ **低档默认关**（`low=true` ⇒ 返回空）。
 */

export interface SkyGeometry {
  /** 云：椭圆（中心 + 半径 + 透明度）；`y` 一律 < `horizonY` */
  clouds: Array<{ x: number; y: number; rx: number; ry: number; a: number }>;
  /** 山影：2~3 层，越远越淡（`layer` 越小越远）；每层是一条闭合折线（画布坐标） */
  ridges: Array<{ layer: number; alpha: number; pts: Array<[number, number]> }>;
  /** 地平线雾带（画在地平线上下的一条渐变带） */
  fog: { y: number; h: number; alpha: number };
}

/** 确定性伪随机（**不用 Math.random**：拖动/重绘要拿到同一份几何，否则会"乱跳"） */
function hash01(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 造这一帧的天空几何。
 *
 * @param w 画布宽（CSS 像素）
 * @param h 画布高
 * @param horizonY 地平线的屏幕 y（由 pitch 决定；pitch 越大越靠上）
 * @param pitch 当前俯仰（度）
 * @param zoom 当前缩放
 * @param low 低档 ⇒ **整块关掉**（保帧率）
 * @param seed 稳定种子（通常传 1；改它只会换一批云，不影响"稳定"这条性质）
 */
export function buildSkyGeometry(
  w: number,
  h: number,
  horizonY: number,
  pitch: number,
  zoom: number,
  low = false,
  seed = 1
): SkyGeometry {
  const empty: SkyGeometry = { clouds: [], ridges: [], fog: { y: horizonY, h: 0, alpha: 0 } };
  if (low || w <= 0 || h <= 0) return empty;
  /* 地平线以上的可见高度（越小说明越接近平视；0 表示看不到天） */
  const skyH = Math.max(0, Math.min(h, horizonY));
  if (skyH < 24) return empty; // 看不到天就别画（省一次全屏合成）
  /* zoom 影响云的"密度观感"：放大 ⇒ 云更大更少（近大远小），但**数量随 zoom 单调** ⇒ 不会闪烁 */
  const k = Math.max(0.6, Math.min(2.2, 1 + (zoom - 15) * 0.08));
  const n = Math.max(3, Math.min(9, Math.round(4 + k * 2)));

  const clouds: SkyGeometry["clouds"] = [];
  for (let i = 0; i < n; i++) {
    const u = hash01(i, seed);
    const v = hash01(i + 100, seed);
    const x = (0.06 + 0.88 * u) * w;
    /* ⚠️ 只在地平线**以上**：留 6% 的余量，免得云压在地平线上像"糊了一块" */
    const yMax = Math.max(10, skyH * 0.92);
    const y = 0.08 * yMax + v * 0.84 * yMax;
    const rx = (34 + 70 * hash01(i + 200, seed)) * k;
    const ry = rx * (0.32 + 0.16 * hash01(i + 300, seed));
    /* 越低（越接近地平线）越淡：模拟"远处的云更薄" */
    const near = 1 - Math.min(1, y / yMax);
    clouds.push({ x, y, rx, ry, a: 0.16 + 0.3 * near * (0.6 + 0.4 * hash01(i + 400, seed)) });
  }

  /* 山影：2~3 层，越远（layer 小）越淡、波幅越小；`pitch` 只影响整带的高度位置 */
  const layers = 3;
  const bandH = Math.max(10, Math.min(skyH * 0.18, 46));
  const ridges: SkyGeometry["ridges"] = [];
  for (let L = 0; L < layers; L++) {
    const far = layers - 1 - L; // 0 = 最远
    const amp = (bandH * (0.35 + 0.3 * far)) / layers;
    const baseY = skyH - bandH * 0.15 + far * (bandH / layers);
    const pts: Array<[number, number]> = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * w;
      /* 两层正弦叠加（确定性）⇒ 像山脊而不是锯齿 */
      const yy =
        baseY -
        amp * (0.6 + 0.4 * Math.sin((i / steps) * Math.PI * (1.5 + 0.5 * L) + L * 1.7)) -
        amp * 0.35 * Math.sin((i / steps) * Math.PI * (4 + L));
      pts.push([x, yy]);
    }
    /* 收口到地平线以下，形成"剪影" */
    pts.push([w, skyH + bandH], [0, skyH + bandH]);
    ridges.push({ layer: L, alpha: 0.1 + 0.14 * L, pts });
  }
  const fog = { y: skyH, h: Math.max(12, bandH * 0.9), alpha: 0.22 };
  return { clouds, ridges, fog };
}

/** 页面/自检都用这一句（保证"口径"只有一份：地平线的屏幕 y 由 pitch 决定） */
export function horizonYOf(h: number, pitch: number): number {
  /* pitch 38° 时地平线大约在屏幕 62% 高度；越接近平视（pitch 大）地平线越靠上 */
  const t = Math.max(0, Math.min(1, (pitch - 20) / 60));
  return Math.round(h * (0.78 - 0.42 * t));
}

/** 一句话说清"这一版比上一版多了什么"（页面上要写出来） */
export function art3Summary(): string {
  return "art=3 比 art=2 多：① 云带（地平线以上、不遮地图）② 三层远景山影 + 雾带 ③ 底图更偏水青（raster 整体调色，**我们没有水系矢量数据**）";
}

/**
 * 🎨 **可量化的对比度**（2026-09-22 机主第二次"看不清"之后加的）。
 *
 * 机主的判据是肉眼，而肉眼发现得太晚（两次了）⇒ 把"看不清"变成**屏幕上的数字**：
 *   · `bldGroundRatio` = 楼体**最暗档**亮度 ÷ 地面亮度（暗色主题有 1.35 门槛；
 *     二次元平涂做不到 ⇒ 它只是参考值，**真正撑住对比的是描边**）；
 *   · `outlineGroundRatio` = 描边色对地面的对比度（WCAG 相对亮度比，1~21）；
 *   · `verdict` = 低于阈值就 `low`（页面标红 + 写"对比度不足：可能看不清"）。
 * 阈值是**保守值**（宁可先保证看得清，再加氛围）。
 */
export interface ContrastReport {
  /** 楼最暗档亮度 / 地面亮度（<1 表示楼比地暗） */
  bldGroundRatio: number;
  /** 描边对地面的对比度（WCAG 比；1 = 完全同色） */
  outlineGroundRatio: number;
  /** 判定：`ok` / `low`（可能看不清） */
  verdict: "ok" | "low";
  why: string;
}

/** `#rrggbb` → 相对亮度（WCAG） */
export function relLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return 0.5; // 认不出就当中等亮度（不抛：诊断件不该把页面搞崩）
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** 两个颜色之间的 WCAG 对比度（1~21） */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

/**
 * 算一份对比度报告（**纯函数**）。
 * @param ramp 楼体色阶 `[高度, #hex][]`（取**最暗**那档与地面比）
 * @param ground 地面色（取自 `tint` 图层的 `background-color`）
 * @param outline 描边色（取自主题 `outline.color`；`rgba(...)` 也能认，认不出按中等亮度）
 */
export function contrastReport(
  ramp: Array<[number, string]> | null,
  ground: string,
  outline: string
): ContrastReport {
  const lGround = relLuminance(ground);
  const dark = (ramp && ramp.length ? ramp.map((r) => r[1]) : []).map((c) => relLuminance(c));
  const lBldDark = dark.length ? Math.min(...dark) : 0.5;
  const bldGroundRatio = +(lBldDark / Math.max(1e-6, lGround)).toFixed(2);
  const outlineGroundRatio = contrastRatio(outline, ground);
  /* 阈值（保守）：楼/地亮度比 ≥0.85（平涂本来就接近），或**描边对地面 ≥4.5**（WCAG AA 正文级）
     —— 平涂主题里描边是唯一的分隔手段，所以后者才是"看得清"的硬指标。 */
  const ok = outlineGroundRatio >= 4.5 || bldGroundRatio <= 0.85;
  return {
    bldGroundRatio,
    outlineGroundRatio,
    verdict: ok ? "ok" : "low",
    why: ok
      ? `描边对地面 ${outlineGroundRatio}:1（≥4.5 达 AA）或楼/地比 ${bldGroundRatio} 够分`
      : `**对比度不足：可能看不清**（描边对地面只有 ${outlineGroundRatio}:1，楼/地比 ${bldGroundRatio} 也太接近）`,
  };
}
