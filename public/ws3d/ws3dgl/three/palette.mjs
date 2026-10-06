// palette.mjs —— 版式与配色（纯数据，node 可测）。
//
// 为什么单独一个文件：v1 的配色是散在 gl.mjs 的着色器常量里的，
// 换渲染层时没法对比"是不是同一套颜色"。这里把**两档风格 + 楼体三档基色**
// 收成一份可被 selftest 断言的纯数据，three 版和手写版可以拿同一份来对色。
//
// 颜色一律写 `#rrggbb` 字符串（canvas 贴图与 THREE.Color 都吃得下）。

/**
 * 楼体材质四档。0/1/2 与 city.mjs 的 b.material 完全对应（v1 也只用这三档），
 * 3 = 抹灰涂料，是 three 版的风格层新加的（style.mjs 的 PAINT_TIER）—— v1 看不到它，A/B 不受影响。
 */
export const TIERS = [
  {
    key: 'brick', name: '暖砖',
    base: '#b8815f', trim: '#96674b', glass: '#2e3a46', sill: '#a97a5c',
    lit: ['#ffd9a0', '#ffc478', '#ffe9c4'],
    roughness: 0.92, metalness: 0.0,
  },
  {
    key: 'concrete', name: '冷混凝土',
    base: '#b3b6ba', trim: '#8e9298', glass: '#35424f', sill: '#c2c5c9',
    lit: ['#ffe6bd', '#ffd79a', '#e8f2ff'],
    roughness: 0.85, metalness: 0.02,
  },
  {
    key: 'paint', name: '抹灰涂料',
    base: '#d3c8a6', trim: '#b3a882', glass: '#333f4b', sill: '#c8bd9c',
    lit: ['#ffe6bd', '#ffd79a', '#e8f2ff'],
    roughness: 0.95, metalness: 0.0,
  },
  {
    key: 'glass', name: '蓝绿玻璃幕墙',
    base: '#7f9dad', trim: '#5b7a8c', glass: '#3a5f74', sill: '#6d8b9b',
    lit: ['#cfe9ff', '#a9d8ff', '#ffe9c4'],
    roughness: 0.22, metalness: 0.45,
  },
];

/** 强调色：白天用暖橙（招牌/遮阳棚），夜里用霓虹青/品红 */
export const ACCENT = { warm: '#ffb454', neon: '#42e8ff', neon2: '#ff4d8d', lamp: '#ffd9a0' };

/** 地面与配景 */
export const GROUND = {
  soil: '#5f5a4f', asphalt: '#3c3f44', sidewalk: '#a09a90', curb: '#c3bdb3',
  paint: '#eae6da', paintY: '#e8c65a', brick: '#8a5a4a', roof: '#6c6a64',
  bark: '#5b4636', leafA: '#4a7136', leafB: '#6d9a45', metal: '#8e9298', rust: '#8a6a52',
};

/**
 * 三档风格：**共用同一套几何**，只切光照/雾/天空/窗自发光/曝光/bloom（+ 半卡通材质与干净贴图）。
 * 字段含义与 v1 的 gl.mjs STYLES 对齐（名字也照抄，方便 A/B 对色），
 * 多出来的是 three 特有的：exposure 之外还有 env（环境光强）、bloom、shadow。
 * 🔴 顺序 = HUD 的循环顺序（main.mjs 遍历 Object.keys(STYLES)）：day → anime → dusk。
 * 🔴 `day` / `dusk` 两档**必须保持原样**（写实基线，A/B 就靠它们）：新档只加字段，
 *    不要往老档里塞 `toon`/`clean` —— 读的时候用 `!!st.xxx`，缺字段就是 false，老路径一个字节不变。
 */
export const STYLES = {
  day: {
    key: 'day', name: '写实白天',
    zenith: '#2a6ed0', horizon: '#cfe0ee', skyGround: '#6b6f70',
    sunDir: [0.42, 0.72, 0.55], sunColor: '#fff4e2', sunIntensity: 3.1, sunDisc: '#fff6e0',
    hemiSky: '#bcd6f5', hemiGround: '#6a6055', hemiIntensity: 0.85,
    ambient: '#9fb4cc', ambientIntensity: 0.25,
    envIntensity: 0.55,
    fogColor: '#b9cfe0', fogDensity: 0.00075,
    windowEmissive: 0.0, lampGlow: 0.0, stars: 0.0,
    exposure: 1.0, bloom: false, bloomStrength: 0.0, sunSize: 0.045,
  },
  /**
   * 二次元 · 日式动画的白天（口径见 ART-PLAN-ANIME.md §1，颜色跟 App 2D 那档 `themes.anime` 同调）。
   * 两个自有的布尔档位（写实两档没有这两个字段 ⇒ 读到 undefined ⇒ 走老路径）：
   *   · `clean`：贴图走"干净鲜艳档"（textures.mjs 去掉雨痕/脏污/裂缝/补丁，提亮加饱和、窗框加粗）；
   *   · `toon` ：楼体五个桶（wall0..3 + shop）换 MeshToonMaterial + 4 级渐变图（半卡通）；
   *   · `outline`：楼体五个桶挂 OutlineEffect 描边（深藏青，与 App 2D 那档同色）。
   * 太阳方向**与写实白天同向**（阴影方向不变 ⇒ 两档能直接 A/B）。
   */
  anime: {
    key: 'anime', name: '二次元白天',
    zenith: '#2e9bea', horizon: '#dff4ff', skyGround: '#8fb7c9',
    sunDir: [0.42, 0.72, 0.55], sunColor: '#fff8e7', sunIntensity: 2.6, sunDisc: '#ffffff',
    hemiSky: '#cfe9ff', hemiGround: '#c9b79a', hemiIntensity: 1.15,
    ambient: '#bfd9f2', ambientIntensity: 0.45,
    envIntensity: 0.7,
    fogColor: '#d8efff', fogDensity: 0.00055,
    windowEmissive: 0.0, lampGlow: 0.0, stars: 0.0,
    exposure: 1.06, bloom: false, bloomStrength: 0.25, sunSize: 0.05,
    clean: true, toon: true, outline: true,
  },
  dusk: {
    key: 'dusk', name: '黄昏→夜晚霓虹',
    zenith: '#080e26', horizon: '#3a2a46', skyGround: '#191d2c',
    sunDir: [-0.62, 0.12, 0.78], sunColor: '#ff8a45', sunIntensity: 0.85, sunDisc: '#ff9d55',
    hemiSky: '#26314f', hemiGround: '#14161d', hemiIntensity: 0.5,
    ambient: '#2a3350', ambientIntensity: 0.3,
    envIntensity: 0.4,
    fogColor: '#141b30', fogDensity: 0.00125,
    windowEmissive: 1.35, lampGlow: 1.6, stars: 0.9,
    exposure: 1.15, bloom: true, bloomStrength: 0.6, sunSize: 0.075,
  },
};

/** HUD 的循环顺序（Object.keys(STYLES) 的插入序就是它；selftest 拿它断言"顺序稳定"） */
export const STYLE_ORDER = Object.keys(STYLES);

/** 描边色：与 App 2D 那档 `themes.anime` 的 outline.color 同色（ART-PLAN-ANIME.md §4） */
export const OUTLINE = { color: '#1b3550', thickness: 0.0025 };

/**
 * 半卡通的**渐变图**（MeshToonMaterial 的 gradientMap）：4 级色阶 0 → 0.45 → 0.72 → 1.0。
 * "半卡通"= 有色阶但不硬边 ⇒ 每一级之间留 `soft` 宽度的平滑过渡（默认 8%，落在 6~10% 这一档）。
 * 纯数据 + 纯函数：node 里能直接断言"级数对不对、过渡软不软"，不用开 GPU。
 */
export const TOON = { levels: [0, 0.45, 0.72, 1.0], soft: 0.08, size: 256 };

/**
 * 生成渐变图的像素（length = n，值 0..255）；x 轴 = 光照点积（0..1）。
 * 每一级的形状 = **平台段 + 平台前一段 `soft` 宽的平滑过渡**（smoothstep，默认 8%）：
 *   · 中间两级（0.45 / 0.72）的平台正好从该级的位置开始；
 *   · 最上面那一级（1.0）在 t=1 处，若照搬会只剩 1 个纹素 ⇒ 把它压到 `1-soft/2` 起平台，
 *     这样"最亮那一级"也有 4% 的宽度（n=256 时 10 个纹素），过渡仍然 8% 宽。
 */
export function toonGradientData({ levels = TOON.levels, soft = TOON.soft, n = TOON.size } = {}) {
  const out = new Uint8Array(n);
  const last = levels.length - 1;
  const edge = (t, a, b, c) => {
    const k = Math.max(0, Math.min(1, (t - (c - soft)) / (soft || 1e-6)));
    return a + (b - a) * (k * k * (3 - 2 * k));
  };
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let v = levels[0];
    for (let k = 1; k < levels.length; k++) {
      const b = levels[k];
      const c = k === last ? Math.min(b, 1 - soft / 2) : b;      // 顶级的平台起点（见函数注释）
      if (t >= c) { v = b; continue; }
      if (t > c - soft) { v = edge(t, levels[k - 1], b, c); continue; }
      break;
    }
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

/** 风格里所有颜色字段的名（selftest 用它确保每档都齐） */
export const STYLE_COLOR_KEYS = ['zenith', 'horizon', 'skyGround', 'sunColor', 'hemiSky', 'hemiGround', 'ambient', 'fogColor', 'sunDisc'];
export const STYLE_NUM_KEYS = ['sunIntensity', 'hemiIntensity', 'ambientIntensity', 'envIntensity', 'fogDensity', 'windowEmissive', 'lampGlow', 'stars', 'exposure', 'bloomStrength', 'sunSize'];

/**
 * 贴图 tile 的"米"尺寸 —— **纯数据，故意放这里而不是 textures.mjs**：
 * textures.mjs 要 import three（CanvasTexture），而 build.mjs / selftest.mjs 必须在 node 里跑得起来。
 * 常量放这份无依赖的文件里，几何那边就不用为了一个数字把 three 拖进 node。
 */
export const TILE = { w: 16, h: 13.2, roof: 8, road: 8, roadWide: 9, walk: 4, ground: 32 };
export const SHOP_H = 4.2;            // 底商层高（米）

/** `#rrggbb` → [r,g,b]（0..1）；也吃 [r,g,b] 与 '#rgb' */
export function toRgb(c) {
  if (Array.isArray(c)) return c.slice(0, 3);
  let s = String(c).trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c2) => c2 + c2).join('');
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 把颜色按 k 调亮/调暗（k>1 亮），clamp 到 0..1，回 [r,g,b] */
export function shade(c, k) {
  const [r, g, b] = toRgb(c);
  return [Math.min(1, r * k), Math.min(1, g * k), Math.min(1, b * k)];
}

export function hex(c) {
  const [r, g, b] = toRgb(c);
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 两个颜色按 k 混合（k=0 取 a，k=1 取 b），回 '#rrggbb' */
export function mix(a, b, k = 0.5) {
  const [r1, g1, b1] = toRgb(a);
  const [r2, g2, b2] = toRgb(b);
  const t = Math.max(0, Math.min(1, k));
  return hex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** 感知亮度（0..1）——自检用它断言"干净档确实更亮" */
export function lumaOf(c) {
  const [r, g, b] = toRgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 彩度（max-min，0..1）：比 HSV 饱和度更适合表达"颜色更艳" —— 提亮会压低 HSV 饱和度、但不压彩度 */
export function chromaOf(c) {
  const [r, g, b] = toRgb(c);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** HSV 饱和度（0..1；max=0 时算 0）——自检用它断言"干净档仍带色相（不是纯灰）" */
export function satOf(c) {
  const [r, g, b] = toRgb(c);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

/**
 * 提亮 + 加饱和（"干净鲜艳档"的基色变换）：先绕亮度轴把颜色拉开，再整体往白提。
 * 日式动画的墙 = 米白/奶油/浅灰蓝 ⇒ 靠这两个旋钮 + 一点点色相偏移就够，
 * **不要去堆贴图细节**（BA 的口径：质感最小化、颜色说话）。
 * @param {string|number[]} c 基色
 * @param {{sat?:number,lift?:number}} o sat>1 更艳、lift>0 更亮（都 clamp 到 0..1）
 */
export function vivid(c, { sat = 1.5, lift = 0.22 } = {}) {
  const [r, g, b] = toRgb(c);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = (v) => Math.max(0, Math.min(1, v + (v - l) * (sat - 1)));
  const f = (v) => Math.max(0, Math.min(1, v + (1 - v) * lift));
  return hex([f(s(r)), f(s(g)), f(s(b))]);
}
