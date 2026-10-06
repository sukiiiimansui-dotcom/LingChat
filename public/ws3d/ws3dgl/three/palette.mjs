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
 * 两档风格：**共用同一套几何与材质**，只切光照/雾/天空/窗自发光/曝光/bloom。
 * 字段含义与 v1 的 gl.mjs STYLES 对齐（名字也照抄，方便 A/B 对色），
 * 多出来的是 three 特有的：exposure 之外还有 env（环境光强）、bloom、shadow。
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
