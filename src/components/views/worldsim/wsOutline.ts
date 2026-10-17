/* wsOutline.ts —— **屏幕空间描边**（手写全屏 pass，不引 EffectComposer）。
 *
 * 真机方向（2026-10-17）：卡通渲染 + 描边 + 暖冷双色；描边选**后处理**（宽度稳定、
 * 不随相机距离变），默认关，`?outline=1` 才开。
 *
 * 本文件只放**可离线判**的部分：线宽口径、纹素换算、着色器源码。
 * 渲染侧（`wsOverlayBackend` 的 `drawOnce`）负责建 RT / 全屏 quad / 跑两遍。
 *
 * ## 线宽口径（判据用）
 * 屏幕像素里固定 **1.5 px**：`texel = (1.5 / 分辨率)`，与 dpr **无关**（dpr 只改缓冲尺寸，
 * 不线宽）⇒ 1×/2× dpr 下都是 1.5±0.5 px。Sobel 取样半径 = `texel`（±1 格）。
 *
 * ## 代价（回传里记实数）
 * - 每帧多 1 个全屏 pass（≈0.4–0.8 ms，机型相关）
 * - 1 个 RGBA 全屏 RT：`w*h*4` 字节（dpr2、1280×578 ⇒ ≈12 MB）
 * - draw call +1（全屏 quad）
 */

/** 线宽（屏幕 CSS 像素）：判据 1.5±0.5 px */
export const OUTLINE_W_PX = 1.5;

/** 描边取样的纹素偏移（按**缓冲像素**分辨率算；dpr 由调用方把缓冲尺寸传进来） */
export function outlineTexel(bufW: number, bufH: number): { x: number; y: number } {
  const w = Math.max(1, Math.floor(bufW));
  const h = Math.max(1, Math.floor(bufH));
  return { x: OUTLINE_W_PX / w, y: OUTLINE_W_PX / h };
}

/** 全屏 RT 的字节数（RGBA8；判据"代价"用） */
export function outlineRtBytes(bufW: number, bufH: number): number {
  return Math.max(1, Math.floor(bufW)) * Math.max(1, Math.floor(bufH)) * 4;
}

/** 顶点着色器：全屏三角/quad，只用 uv */
export const OUTLINE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 片元着色器：**深度 Sobel**（若 depth 纹理不可用则由渲染侧退回亮度 Sobel）。
 * 线宽就在 `uTexel` 里（= 1.5 px / 缓冲分辨率），与 dpr 无关。
 */
export const OUTLINE_FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uDepth;
uniform sampler2D uColor;
uniform vec2 uTexel;
uniform float uUseDepth;   /* 1 = 用深度，0 = 用亮度 */
uniform vec3 uLineColor;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float sampleEdge(vec2 uv) {
  if (uUseDepth > 0.5) return texture2D(uDepth, uv).r;
  return lum(texture2D(uColor, uv).rgb);
}

void main() {
  /* Sobel 3x3，半径 = 1 个纹素（线宽由 uTexel 控制） */
  float tl = sampleEdge(vUv + vec2(-uTexel.x, -uTexel.y));
  float t  = sampleEdge(vUv + vec2(0.0,       -uTexel.y));
  float tr = sampleEdge(vUv + vec2( uTexel.x, -uTexel.y));
  float l  = sampleEdge(vUv + vec2(-uTexel.x, 0.0));
  float r  = sampleEdge(vUv + vec2( uTexel.x, 0.0));
  float bl = sampleEdge(vUv + vec2(-uTexel.x,  uTexel.y));
  float b  = sampleEdge(vUv + vec2(0.0,        uTexel.y));
  float br = sampleEdge(vUv + vec2( uTexel.x,  uTexel.y));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  float edge = smoothstep(0.12, 0.32, length(vec2(gx, gy)));
  vec4 base = texture2D(uColor, vUv);
  gl_FragColor = vec4(mix(base.rgb, uLineColor, edge), max(base.a, edge));
}
`;
