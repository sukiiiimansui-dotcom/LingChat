/**
 * wsArtParams.ts —— **楼体美术「取参」的共享真源**（2026-09-26 抽出）。
 *
 * ## 为什么要有它（机主真机原话）
 * 「App 页用的建筑模型**不是 art1**，每次滑动建筑都变了，名字也没有」。
 *
 * 实测（不是猜）：
 * · App 宿主 `WsDistrictMapLibre.vue` 只调 `bldLayerSpecsFor(theme.value, themeTier.value)`（**2 个参数**）；
 * · 代拍页 `public/ws3dshow.html` 调的是自带的一整套：
 *   `artRamp(THEME.ramp)` / `THEME.outline` / `THEME.verticalGradient` / `THEME.extrudOpacity` /
 *   `?art=` 的补丁表 / `?look=` 的插值形式 / `OUTLINE_STOPS` 的描边插值。
 * · 而 **`artRamp` 与 art/look 的选择只存在于页面里**（`public/ws3dshow.html:1314`），App 侧
 *   **连 `?art=` 这个开关都没有** ⇒ 两边喂给同一份装配函数的**输入不同**，观感自然不同。
 *
 * 「观感参数只长在页面里」= 第二份真相（PR 门禁 C1 要防的形状）⇒ 抽到这里，页面/宿主都只调这一份。
 *
 * ## 硬约束（`ws_art_params_selftest.mjs` 钉着）
 * 🔴 **`art=1` 必须恒等返回**：`artRamp(ramp, 1) === ramp`（**同一个引用**，不是"等值"）——
 *    这是"不给参数 = 旧版一个字节都不变"的机器可断言形式。同理 `bldArtParamsOf(theme, {art:1, look:1})`
 *    出来的 `outline/vgrad/opacity/stops/lineWidth/rampColor` 必须与页面旧实现逐字段相同。
 * 🔴 **纯函数**：不读 `location`（`?art=` 的解析单独一个 `parseArtParam(search)`），
 *    不读全局主题，无随机、无时间 —— 同输入同输出。
 *
 * ## 与 `wsDistrictScene.bldLayerSpecsFor` 的分工
 * · 本模块：**参数从哪来**（主题 → ramp/描边/渐变/不透明度/插值形式）；
 * · `bldLayerSpecsFor`：**参数怎么变成图层**（层序、过滤、minzoom、插入锚点）。
 * 现在两边各拿一半 ⇒ 宿主给了不同的参数就出来不同的观感。接线后宿主从本模块取参再喂给 specs。
 */

/** 主题色阶（`[高度m, 颜色]`）——与 `wsMapTheme.WsMapTheme["ramp"]` 同形 */
export type ArtRampPoint = [number, string];

/** `?art=` 档位（1 = 基准，2 = 高调平涂 + 近白高段，3 = 在 2 之上再加天空/raster 调色） */
export type ArtLevel = 1 | 2 | 3;
/** `?look=` 档位（1 = 基准，2 = "游戏过场"派生主题 + 硬边分档 + 接触阴影） */
export type LookLevel = 1 | 2;

/** 楼体色阶要推近白的档数（`artRamp` 用；也进 `artReadback()` 的回证表）——**只在这一处写** */
export const WS_ART_RAMP_HI: readonly string[] = ["#CFEDFF", "#E2F6FF", "#F2FCFF", "#FFFFFF"];

/**
 * 取不到主题时的色阶兜底（页面原来那份 `FALLBACK_RAMP`，**逐字搬过来**）。
 * ⚠️ 这是"主题没到位"时的兜底配方，**不是** `wsMapTheme.ANIME`（两者值不同，别混）。
 */
export const WS_BLD_FALLBACK_RAMP: ArtRampPoint[] = [
  [3, "#23323e"], [8, "#2d4356"], [16, "#3a586f"], [30, "#4a7290"],
  [60, "#5f93b0"], [110, "#7fbcd4"], [200, "#b6e2f2"], [320, "#e8f7ff"],
];

/** 主题没到位时的描边兜底（页面旧实现的字面量，**逐字搬**） */
export const WS_BLD_FALLBACK_OUTLINE = { color: "rgba(190,235,255,0.22)", width: 0.5 };
/** 主题没到位时的不透明度兜底（页面旧实现的字面量，**逐字搬**） */
export const WS_BLD_FALLBACK_OPACITY = 0.97;

/**
 * 描边的 zoom→宽度 **停靠点**（单一真源：样式表达式与 HUD 显示都从这一份来，别写两遍）。
 * 机主反馈"看不出变化" ⇒ 近景放大一档（远景仍保持细）。
 */
export const WS_BLD_OUTLINE_STOPS: ReadonlyArray<readonly [number, number]> = [
  [13, 0.5], [15, 1.6], [16.5, 3.4], [18, 4.2],
];

/**
 * 🎨 **补丁表（单一真源）**：`art≥2` 要改的"图层 → 键 → 值"。
 * `applyArt()` 按它改样式；`artReadback()` 按它读回**实时值**做回证 —— **同一份表**，
 * 所以"改了但没生效"一定会在回证表里露出来（机主第一反馈："这变了个啥"）。
 */
export interface WsArtPatchRow {
  id: string;
  key: string;
  art2: unknown;
  /** `art=3` 专有的值（没写 ⇒ 沿用 `art2`） */
  art3?: unknown;
  why: string;
}
export const WS_ART_PATCHES: readonly WsArtPatchRow[] = [
  /* 🆕 art=3：底图整体往"水青"推（**我们没有水系矢量数据** —— 河/湖是栅格底图里的像素，
     所以只能调 raster 的整体饱和度/亮度，**不能假装给水体单独上色**） */
  { id: "base", key: "raster-saturation", art2: 0.34, art3: 0.6, why: "底图更青（**保守**：0.72 洗掉了路与注记）" },
  { id: "base", key: "raster-brightness-max", art2: 0.98, art3: 0.94, why: "底图更亮但**不顶到 1**（顶到 1 吃掉层次）" },
  { id: "tint", key: "background-color", art2: "#EEF9FF", why: "地面色罩更近白" },
  { id: "tint", key: "background-opacity", art2: 0.5, why: "色罩**保守值**：0.8 会把地面糊成一片白" },
  { id: "bg", key: "background-color", art2: "#F7FCFF", why: "底色更亮" },
  { id: "base", key: "raster-opacity", art2: 0.52, why: "照片更淡但**底图承载路与注记**：0.32 就「没有路」了" },
];

/** `?art=` → 档位（**不给 = 1**；`art=3` 优先于 `art=2` —— 页面旧实现的判定顺序） */
export function parseArtParam(search: string | null | undefined): ArtLevel {
  const s = String(search ?? "");
  if (/[?&]art=3\b/.test(s)) return 3;
  if (/[?&]art=2\b/.test(s)) return 2;
  return 1;
}

/** `?look=` → 档位（**不给 = 1**） */
export function parseLookParam(search: string | null | undefined): LookLevel {
  const s = String(search ?? "");
  return /[?&]look=2\b/.test(s) ? 2 : 1;
}

/** `look` → 主题快照里的派生档 id（`/wstheme.json` 的 `looks.<id>.<theme>`）；`look=1` ⇒ null */
export function lookIdOf(look: number): "game" | null {
  return look === 2 ? "game" : null;
}

/**
 * 楼体色阶：`art=2` 把**高段**推到近白（**不动主题基准值**，只换这一页/这一屏用的那一份拷贝）。
 *
 * 🔴 **`art !== 2` ⇒ 原样返回入参（同一个引用）** —— "不给参数 = 一个字节都不变"。
 * ⚠️ 改写循环里的下标是 `hi[hi.length - 1 - i]`（不是 `hi[i]`）：色阶长度不足 4 档时，
 *    最后几档取的是 `hi` 的**尾部**色。照搬页面旧实现，别"顺手改成看着更对的写法"。
 */
export function artRamp(ramp: ArtRampPoint[], art: number): ArtRampPoint[];
export function artRamp(ramp: ArtRampPoint[] | null | undefined, art: number): ArtRampPoint[] | null | undefined;
export function artRamp(ramp: ArtRampPoint[] | null | undefined, art: number): ArtRampPoint[] | null | undefined {
  if (art !== 2 || !ramp || !ramp.length) return ramp;
  const r: ArtRampPoint[] = ramp.map((p) => [p[0], p[1]]);
  const hi = WS_ART_RAMP_HI;
  for (let i = 0; i < hi.length && i < r.length; i++) r[r.length - 1 - i][1] = hi[hi.length - 1 - i];
  return r;
}

/** 按 zoom 求描边宽度（纯函数；HUD 显示"现在多粗"用，与 `outlineWidthExpr()` 同源） */
export function outlineWidthAt(z: number): number {
  const st = WS_BLD_OUTLINE_STOPS;
  if (z <= st[0][0]) return st[0][1];
  for (let i = 1; i < st.length; i++) {
    if (z <= st[i][0]) {
      const [z0, w0] = st[i - 1], [z1, w1] = st[i];
      return +(w0 + ((w1 - w0) * (z - z0)) / (z1 - z0)).toFixed(2);
    }
  }
  return st[st.length - 1][1];
}

/** 由停靠点生成 MapLibre 的 zoom 插值表达式（与 `outlineWidthAt` 同源） */
export function outlineWidthExpr(): unknown[] {
  const out: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, w] of WS_BLD_OUTLINE_STOPS) out.push(z, w);
  return out;
}

/**
 * 🎮 楼体色阶**表达式**。
 * · 基准版 = 平滑插值（`interpolate`，8 档）；
 * · `look=2` = **硬边 `step`（cel 分档）** —— 抄 cel shading 的"三档之间是硬边"。
 *
 * ⚠️ **停靠点与颜色都来自主题**（`ramp`），这里只决定"**插值形式**" ⇒ 换观感换的是关系，
 *    不是又一份配色（调用方里没有一个楼体色号）。
 *
 * @param stops 已铺平的 `[h, c, h, c, …]`（= `bldArtParamsOf` 产出的 `stops`）
 */
export function bldRampColorExpr(
  stops: readonly unknown[],
  ramp: readonly ArtRampPoint[] | null | undefined,
  look: number,
): unknown[] {
  if (look === 2 && ramp && ramp.length >= 2) {
    const out: unknown[] = ["step", ["get", "h3d"], ramp[0][1]];
    for (let i = 1; i < ramp.length; i++) out.push(ramp[i][0], ramp[i][1]);
    return out;
  }
  return ["interpolate", ["linear"], ["get", "h3d"], ...stops];
}

/** `art` 档下某条补丁该用的值（`art3` 有就优先；`art<2` ⇒ null，表示"不改"） */
export function artPatchValueOf(row: WsArtPatchRow, art: number): unknown {
  if (art < 2) return null;
  return art === 3 && row.art3 !== undefined ? row.art3 : row.art2;
}

/** 取参要的主题面（`wsMapTheme.WsMapTheme` 结构上满足它；也允许传一个从 JSON 来的"松"对象） */
export interface BldArtThemeLike {
  ramp?: ArtRampPoint[] | null;
  outline?: { color?: string; width?: number } | null;
  verticalGradient?: boolean;
  extrudOpacity?: unknown;
}

export interface BldArtParams {
  /** 生效的 art 档（回证表要念它） */
  art: number;
  /** 生效的 look 档 */
  look: number;
  /** `artRamp` 之后的色阶（art=1 ⇒ **入参那一个引用**） */
  ramp: ArtRampPoint[];
  /** 描边（主题给 / 兜底）——**原样透传**，不做补默认值（补了就不是"逐字段相同"了） */
  outline: { color?: string; width?: number };
  /** `fill-extrusion-vertical-gradient`（**平涂要关**；主题没有 ⇒ `true`，与页面旧实现一致） */
  vgrad: boolean | undefined;
  /** `fill-extrusion-opacity`（主题给的是**zoom 插值表达式**，不是数字） */
  opacity: unknown;
  /** 铺平的色阶停靠点 `[h, c, …]` */
  stops: unknown[];
  /** `bld-line` 的 `line-width`：`art≥2` ⇒ zoom 插值表达式；`art=1` ⇒ 主题给的固定宽度 */
  lineWidth: unknown;
  /** `fill-extrusion-color` 的高度色阶表达式（`look` 决定 interpolate / step） */
  rampColor: unknown[];
}

/**
 * **取参**：主题 + art/look 档 → 造楼房图层要用的那一整套观感参数。
 *
 * 🔴 `art=1` 且 `look=1` 时，这里产出的每一项都必须与页面旧实现（`bldLayerSpecs()` 头部那 5 行）
 *    **逐字段相同** —— 自检第②组拿从 git 锚点取出的旧代码原文对拍。
 */
export function bldArtParamsOf(
  theme: BldArtThemeLike | null | undefined,
  opts?: { art?: number; look?: number; fallbackRamp?: ArtRampPoint[] },
): BldArtParams {
  const art = opts?.art ?? 1;
  const look = opts?.look ?? 1;
  const fallbackRamp = opts?.fallbackRamp ?? WS_BLD_FALLBACK_RAMP;

  const ramp = artRamp((theme && theme.ramp) || fallbackRamp, art);
  const outline = (theme && theme.outline) || WS_BLD_FALLBACK_OUTLINE;
  const vgrad = theme ? theme.verticalGradient : true;
  /* ⚠️ `||`（不是 `??`）：页面旧实现就是 `THEME?.extrudOpacity || 0.97` —— 照搬，别换判据 */
  const opacity = (theme && theme.extrudOpacity) || WS_BLD_FALLBACK_OPACITY;
  const stops: unknown[] = [];
  for (const [h, c] of ramp) stops.push(h, c);

  return {
    art,
    look,
    ramp,
    /* ⚠️ **原样透传**（不补默认值）：页面旧实现就是 `THEME?.outline || 兜底` 两步，
       这里多补一次 `??` 就会让"主题缺 width"时与旧实现不同 ⇒ 逐字段对拍会红。 */
    outline,
    vgrad,
    opacity,
    stops,
    lineWidth: art >= 2 ? outlineWidthExpr() : outline.width,
    rampColor: bldRampColorExpr(stops, ramp, look),
  };
}
