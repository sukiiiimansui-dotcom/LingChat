// toon.mjs —— 二次元档的"动画感"三件：分色染色 / 边缘光 / 描边参数。
//
// 为什么单独一个文件：这三件都得**在 node 里算得出来**（喂已知法线与光向，不看 GPU），
// 而 world.mjs / main.mjs 一 import 就碰 three 与 document ⇒ 判据只能落在无依赖的模块上。
//
// 分工（重要）：
//   · 这里是**纯数据 + 纯函数**：斜坡、三色混色、边缘光、描边取参、以及把着色器补丁**当字符串做**；
//   · world.mjs 只负责"把这里算出来的数塞进 uniform"和"把 patchToonFragment() 接到 onBeforeCompile"。
//   ⇒ 着色器那一边与这里的公式是**同一份数**：级数/软过渡由 palette 的 TOON 生成成 GLSL，
//     混色与边缘光的算式在 tintRimBodyGLSL() 里逐句对应 tintAt()/rimAt()。
//
// 借鉴来源（许可证已核）：
//   三色染色 / 边缘光这两个**思路**来自 mayacoda/toon-shader（MIT）与 Kenton-GMI/sakura-crossing（MIT）
//   的公开做法；本文件是照我们自己的数据（palette 的 TOON 级数）重写的实现，没有拷任何 GLSL 文本。
//   ZaneAtega/Three-js-Anime-Shader **无 LICENSE** ⇒ 一个字符都没用（只在 ART-PLAN 里当思路索引）。
import { TOON, OUTLINE, toRgb } from './palette.mjs';

/** 三色染色的参数名（selftest 拿它断言"每路都齐、都是合法数"） */
export const TINT_KEYS = ['lit', 'litStrength', 'shadow', 'shadowStrength', 'ambient', 'ambientStrength'];
/** 边缘光的参数名 */
export const RIM_KEYS = ['color', 'threshold', 'strength', 'power'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / ((b - a) || 1e-9)); return t * t * (3 - 2 * t); };
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 风格档 → 三色染色参数（没写 toonTint 的档返回 null ⇒ 走恒等，写实两档一个像素都不动） */
export function resolveTint(style) {
  const t = style && style.toonTint;
  if (!t || typeof t !== 'object') return null;
  return {
    lit: isHex(t.lit) ? t.lit : null,
    litStrength: numOr(t.litStrength, 0),
    shadow: isHex(t.shadow) ? t.shadow : null,
    shadowStrength: numOr(t.shadowStrength, 0),
    ambient: isHex(t.ambient) ? t.ambient : null,
    ambientStrength: numOr(t.ambientStrength, 0),
  };
}

/** 风格档 → 边缘光参数（没写 toonRim 的档返回 null） */
export function resolveRim(style) {
  const r = style && style.toonRim;
  if (!r || typeof r !== 'object') return null;
  return {
    color: isHex(r.color) ? r.color : null,
    threshold: clamp01(numOr(r.threshold, 1)),
    strength: numOr(r.strength, 0),
    power: Math.max(0, numOr(r.power, 1)),
  };
}

/**
 * 三色染色与边缘光"要不要开"（**只由风格档决定**，纯函数）。
 * 写实两档没有这两个字段 ⇒ false ⇒ uniform uToonOn=0 ⇒ 着色器里是恒等变换。
 */
export function toonEffectsOn(style) {
  return !!(resolveTint(style) || resolveRim(style));
}

/**
 * 斜坡：t（0..1，= 光照点积映射过来的坐标）→ 0..1。
 * **与 palette.toonGradientData() 逐句同式**（那张图是 MeshToonMaterial 自己用的色阶）：
 * 每一级 = 平台段 + 平台前一段 soft 宽的 smoothstep；最顶那一级压到 1-soft/2 起平台。
 * 自检拿它对拍渐变图的每个纹素（差 ≤1/255），两边一偏就红。
 */
export function toonRampAt(t, { levels = TOON.levels, soft = TOON.soft } = {}) {
  const u = clamp01(t);
  const last = levels.length - 1;
  let v = levels[0];
  for (let k = 1; k < levels.length; k++) {
    const b = levels[k];
    const c = k === last ? Math.min(b, 1 - soft / 2) : b;
    if (u >= c) { v = b; continue; }
    if (u > c - soft) { v = levels[k - 1] + (b - levels[k - 1]) * smoothstep(c - soft, c, u); continue; }
    break;
  }
  return v;
}

/** 光照点积 → 斜坡坐标（three 的 getGradientIrradiance 用的就是 dotNL*0.5+0.5） */
export function rampCoord(dotNL) { return clamp01(dotNL * 0.5 + 0.5); }

/** 法线 × 光向 → 受光比 0..1（两个向量在同一个空间即可，本喵这边都是 view space） */
export function toonRampFor(normal, lightDir, opts) {
  const nl = dot3(normal, lightDir);
  return toonRampAt(rampCoord(nl), opts);
}

function dot3(a, b) {
  const n = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);
  if (!(n > 0)) return 0;
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n;
  return d < -1 ? -1 : d > 1 ? 1 : d;
}

/**
 * 三色染色乘子：`rgb = 环境色×环境强度 + 受光色×受光强度×ramp + 阴影色×阴影强度×(1-ramp)`。
 * 口径（为什么这样定）：受光/阴影两路的强度**相等**，两边加起来都是 1.0 上下
 * ⇒ 只换色相（受光偏暖、背光偏冷）、不整体压暗 —— ART-PLAN §1 要的"暗部亮而不脏"就靠这条。
 * @returns {{ramp:number, rgb:number[]}}
 */
export function tintAt(normal, lightDir, tint, opts) {
  const ramp = toonRampFor(normal, lightDir, opts);
  const lit = toRgb((tint && tint.lit) || '#ffffff');
  const sh = toRgb((tint && tint.shadow) || '#ffffff');
  const am = toRgb((tint && tint.ambient) || '#ffffff');
  const ls = numOr(tint && tint.litStrength, 0);
  const ss = numOr(tint && tint.shadowStrength, 0);
  const as = numOr(tint && tint.ambientStrength, 0);
  const rgb = [0, 1, 2].map((i) => am[i] * as + lit[i] * ls * ramp + sh[i] * ss * (1 - ramp));
  return { ramp, rgb };
}

/**
 * 边缘光（日式动画的"逆光边"）：掠射角越狠越亮。
 * `e = 1 - |dot(法线, 视线)|`，`k = smoothstep(阈值, 1, e)` ⇒ e 不到阈值**一点都不加**（阈值就是干这个的）；
 * 强度与颜色直接乘上去，最终加到自发光那一项（不受阴影影响 —— 逆光边本来就在背光侧）。
 * @returns {{ndv:number, k:number, rgb:number[]}}
 */
export function rimAt(normal, viewDir, rim) {
  const ndv = Math.abs(dot3(normal, viewDir));
  const e = 1 - ndv;
  const th = rim ? clamp01(numOr(rim.threshold, 1)) : 1;
  const k = smoothstep(th, 1, e);
  const col = toRgb((rim && rim.color) || '#ffffff');
  const st = numOr(rim && rim.strength, 0);
  return { ndv, k, rgb: col.map((c) => c * st * k) };
}

/**
 * 风格档 → **uniform 的纯数值**（world.mjs 拿它去写 Vector3；自检直接断言这份，不用碰 three）。
 * 写实两档没有 `toonTint`/`toonRim` ⇒ `on:0` 且所有强度为 0 ⇒ 着色器里是恒等变换。
 */
export function toonUniformValues(style) {
  const t = resolveTint(style);
  const r = resolveRim(style);
  const p = (c) => toRgb(c || '#ffffff');
  return {
    on: (t || r) ? 1 : 0,
    litTint: p(t && t.lit), litStrength: t ? t.litStrength : 0,
    shadowTint: p(t && t.shadow), shadowStrength: t ? t.shadowStrength : 0,
    ambientTint: p(t && t.ambient), ambientStrength: t ? t.ambientStrength : 0,
    rimColor: p(r && r.color), rimThreshold: r ? r.threshold : 1,
    rimStrength: r ? r.strength : 0, rimPower: r ? r.power : 1,
  };
}

// ── 着色器那边：把上面这套公式与级数写成 GLSL（字符串，node 里能直接断言）──────────
/** 数字 → GLSL 浮点字面量（六位小数足够，级数是 0/0.45/0.72/1 这种） */
const glf = (v) => (Math.round(Number(v) * 1e6) / 1e6).toFixed(6);

/**
 * 斜坡函数的 GLSL：级数与软过渡**从 palette 的 TOON 现生成**（改档 ⇒ 着色器跟着变，不用改这里的代码）。
 */
export function toonRampGLSL({ levels = TOON.levels, soft = TOON.soft } = {}) {
  const last = levels.length - 1;
  const lines = ['float wsToonRamp( float u ) {', `  float v = ${glf(levels[0])};`];
  for (let k = 1; k < levels.length; k++) {
    const c = k === last ? Math.min(levels[k], 1 - soft / 2) : levels[k];
    lines.push(
      `  { float a = ${glf(levels[k - 1])}; float b = ${glf(levels[k])}; float c = ${glf(c)}; float s = ${glf(soft)};`,
      '    if ( u >= c ) { v = b; }',
      '    else if ( u > c - s ) { float t = clamp( ( u - ( c - s ) ) / s, 0.0, 1.0 ); v = a + ( b - a ) * ( t * t * ( 3.0 - 2.0 * t ) ); } }',
    );
  }
  lines.push('  return v;', '}');
  return lines.join('\n');
}

/** 要在片元着色器里声明的 uniform（tint 六路 + sunDir + rim 四路 + 一个总开关） */
export function toonUniformGLSL() {
  return [
    'uniform float uToonOn;',
    'uniform vec3 uToonSunDirView;',
    'uniform vec3 uToonLitTint; uniform float uToonLitStrength;',
    'uniform vec3 uToonShadowTint; uniform float uToonShadowStrength;',
    'uniform vec3 uToonAmbientTint; uniform float uToonAmbientStrength;',
    'uniform vec3 uToonRimColor; uniform float uToonRimThreshold; uniform float uToonRimStrength; uniform float uToonRimPower;',
  ].join('\n');
}

/**
 * 落在 `#include <aomap_fragment>` 之后的算式（此时 `normal` 与 `vViewPosition` 都已在作用域里）。
 * ⚠️ 与 tintAt()/rimAt() 是同一套公式：自检拿一对已知向量两边各算一遍对拍。
 */
export function tintRimBodyGLSL() {
  return [
    '{',
    '  float wsU = clamp( dot( normalize( normal ), uToonSunDirView ) * 0.5 + 0.5, 0.0, 1.0 );',
    '  float wsRamp = wsToonRamp( wsU );',
    '  vec3 wsTint = uToonAmbientTint * uToonAmbientStrength',
    '    + uToonLitTint * uToonLitStrength * wsRamp',
    '    + uToonShadowTint * uToonShadowStrength * ( 1.0 - wsRamp );',
    '  vec3 wsTintOn = mix( vec3( 1.0 ), wsTint, uToonOn );',
    '  reflectedLight.directDiffuse *= wsTintOn;',
    '  reflectedLight.indirectDiffuse *= wsTintOn;',
    '  float wsE = 1.0 - clamp( abs( dot( normalize( normal ), normalize( vViewPosition ) ) ), 0.0, 1.0 );',
    '  float wsK = smoothstep( uToonRimThreshold, 1.0, wsE );',
    '  totalEmissiveRadiance += uToonRimColor * ( uToonRimStrength * wsK * uToonOn );',
    '}',
  ].join('\n');
}

/** 两个锚点：`#include <common>`（塞 uniform 与斜坡函数）与 `#include <aomap_fragment>`（塞算式） */
export const TOON_ANCHORS = { pars: '#include <common>', body: '#include <aomap_fragment>' };

/**
 * 把一个片元着色器源码打上二次元补丁（**纯字符串变换**，onBeforeCompile 里调的就是它）。
 * 返回 `missing` 列出没找到的锚点：three 哪天改了 chunk 名，这里会**明着报**而不是悄悄失效
 * （静默失效最难查：画面上只是"染色没了"，没人知道是 upgrade 干的）。
 */
export function patchToonFragment(src, opts) {
  const s = String(src || '');
  const missing = [];
  for (const [k, a] of Object.entries(TOON_ANCHORS)) if (!s.includes(a)) missing.push(k);
  if (missing.length) return { src: s, ok: false, missing };
  const pars = [TOON_ANCHORS.pars, toonUniformGLSL(), toonRampGLSL(opts)].join('\n');
  const body = [TOON_ANCHORS.body, tintRimBodyGLSL()].join('\n');
  return { src: s.replace(TOON_ANCHORS.pars, pars).replace(TOON_ANCHORS.body, body), ok: true, missing: [] };
}

/**
 * 描边取参：**粗细与颜色全部来自风格档**（写实两档没这两个字段 ⇒ 退到 palette.OUTLINE 的默认值）。
 * `width` 是 `?outlineW=` 的覆盖值（给真机调粗细用，改一次不用重发页面）。
 * @returns {{color:string, thickness:number, alpha:number}}
 */
export function outlineSpecFor(style, { width = null } = {}) {
  const s = style || {};
  const w = Number(width);
  const thickness = Number.isFinite(w) && w > 0 ? w
    : (Number.isFinite(Number(s.outlineThickness)) && Number(s.outlineThickness) > 0 ? Number(s.outlineThickness) : OUTLINE.thickness);
  const color = isHex(s.outlineColor) ? s.outlineColor : OUTLINE.color;
  return { color, thickness, alpha: Number.isFinite(Number(OUTLINE.alpha)) ? OUTLINE.alpha : 1 };
}
