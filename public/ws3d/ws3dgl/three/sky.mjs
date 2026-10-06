// sky.mjs —— 天空穹顶（渐变着色器 + 太阳 + 星星）与环境贴图（PMREM）。
//
// 为什么要渐变而不是"纯色 + 雾"：主人真机截图里「天空几乎纯白、楼只是灰剪影」就是这么来的。
// 这里天顶到地平线是两段不同色，太阳位置有一团光晕，夜里还有星点 —— 都是**同一套几何**，
// 切昼夜只改 uniform（跟 v1 的 gl.mjs 一个思路，只是换成 three 的 ShaderMaterial）。
import {
  SphereGeometry, ShaderMaterial, Mesh, BackSide, Color, Vector3,
  PMREMGenerator, Scene as ThreeScene, NoToneMapping,
} from '../vendor/three.min.js';
import { toRgb } from './palette.mjs';

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uGround, uSunColor, uSunDir, uDisc;
uniform float uStars, uSunSize, uHaze;
float h13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  // 天顶 → 地平线：两次幂让地平线附近压得更紧（真实天空的梯度不是线性的）
  float t = pow(clamp(up, 0.0, 1.0), 0.62);
  vec3 col = mix(uHorizon, uZenith, t);
  // 地平线以下：地面色（远处地面与天空的过渡带）
  col = mix(col, uGround, clamp(-up * 4.0, 0.0, 1.0));
  // 太阳：光晕 + 本体
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sd, 8.0) * 0.28 * uHaze;
  col += uSunColor * pow(sd, 900.0) * 2.2;
  col = mix(col, uDisc, smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, sd));
  // 星星（夜里）
  if (uStars > 0.001 && up > 0.02) {
    vec3 g = floor(d * 340.0);
    float h = h13(g);
    float s = step(0.9975, h) * (0.5 + 0.5 * h13(g + 3.7));
    col += vec3(s) * uStars * clamp(up * 3.0, 0.0, 1.0);
  }
  gl_FragColor = vec4(col, 1.0);
  // 跟着 three 的标准输出链走：渲染到画布时做色调映射 + sRGB 编码，
  // 渲染到 composer 的线性 RT 时 three 会自动把这两步让给 OutputPass（同一份着色器两条路都对）
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky() {
  const uniforms = {
    uZenith: { value: new Color('#2a6ed0') },
    uHorizon: { value: new Color('#cfe0ee') },
    uGround: { value: new Color('#6b6f70') },
    uSunColor: { value: new Color('#fff4e2') },
    uSunDir: { value: new Vector3(0.42, 0.72, 0.55).normalize() },
    uDisc: { value: new Color('#fff6e0') },
    uStars: { value: 0 },
    uSunSize: { value: 0.045 },
    uHaze: { value: 1 },
  };
  const mat = new ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    side: BackSide, depthWrite: false, fog: false,
  });
  const mesh = new Mesh(new SphereGeometry(4000, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  mesh.renderOrder = -1;

  /** 按风格改 uniform（切昼夜只调这里，几何与材质不动） */
  const setStyle = (style, sunDir) => {
    uniforms.uZenith.value.set(style.zenith);
    uniforms.uHorizon.value.set(style.horizon);
    uniforms.uGround.value.set(style.skyGround);
    uniforms.uSunColor.value.set(style.sunColor);
    uniforms.uDisc.value.set(style.sunDisc);
    uniforms.uStars.value = style.stars;
    uniforms.uSunSize.value = style.sunSize;
    uniforms.uHaze.value = style.key === 'dusk' ? 0.55 : 1.0;
    if (sunDir) uniforms.uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
  };
  return { mesh, uniforms, setStyle, material: mat };
}

/**
 * 用天空生成环境贴图（PMREM）——玻璃幕墙/金属没有环境贴图会死黑，
 * 有了它连半球光都能省一半。失败（无 GPU/无头）就返回 null，绝不让它把启动流程带崩。
 */
export function buildEnvironment(renderer, sky) {
  try {
    const pmrem = new PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader && pmrem.compileEquirectangularShader();
    const tmp = new ThreeScene();
    const clone = new Mesh(sky.mesh.geometry, sky.material.clone());
    clone.material.uniforms = sky.material.uniforms;      // 共享 uniform：切风格时环境贴图跟着更新
    tmp.add(clone);
    const rt = pmrem.fromScene(tmp, 0, 0.1, 5000);
    pmrem.dispose();
    clone.material.dispose();
    return rt.texture;
  } catch (e) {
    return null;
  }
}

export { NoToneMapping, toRgb };
