// main.mjs —— three 版页面主控：取数 → 生成城 → 风格抽样 → 建世界 → 渲染循环 → HUD/交互/自适应降质。
//
// 与 v1（手写版 main.mjs）的关系：
//   · **复用**：data.mjs（8790 索引 + 8788 真路网）、city.mjs（路网栅格化→街区→地块→楼体规格）、
//     util.mjs、player.mjs（输入/碰撞推离/相机）。
//   · **新写**：urban.mjs（选址 + 补满路网）、style.mjs（风格抽样）、build.mjs（按材质分桶的几何）、
//     world.mjs（three 装配/LOD）、sky.mjs（天空+环境贴图）、character.mjs（手感/摇杆）、validate.mjs（体检+可通行）。
//   · 无 GPU 时的行为跟 v1 一样：**数据这一整套照样跑完**，把"为什么没有 WebGL2 + 数据取到没有"摆出来，不白屏。
import * as THREE from '../vendor/three.min.js';
import { apiGet, indexCache, pickRoadCaches, loadRealRoads } from '../data.mjs';
import { buildCollider, createInput, createPlayer, resolve, STEP_OVER } from '../player.mjs';
import { prepareCity, pickCenter, densityReport } from './urban.mjs';
import { styleCity } from './style.mjs';
import { buildWorld } from './build.mjs';
import { createWorld } from './world.mjs';
import { createSky, buildEnvironment } from './sky.mjs';
import { snapShadowLight } from './shadowsnap.mjs';
import { createCharacter, CHARACTERS } from './character.mjs';
import { validateLayout, sanitizeLayout, walkTest } from './validate.mjs';
import { STYLES, STYLE_ORDER, GROUND, OUTLINE, toRgb } from './palette.mjs';
import { outlineSpecFor } from './toon.mjs';
import {
  LEVELS, DPR_MAX, DPR_PRESETS, MSAA_MODES, SHADOW_AREA, SHADOW_EVERY,
  pickDpr, pickMsaa, pickShadowRes, adaptiveStep, renderPath, dprLabel,
} from './quality.mjs';

const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const flag = (k, d) => (Q.has(k) ? Q.get(k) !== '0' : d);

// 画质策略（dpr / MSAA / 阴影 / LOD / 渲染路径）全在 quality.mjs 里，**纯逻辑、node 可测**：
// 梯子只有 阴影 / LOD / bloom 三项，没有 dpr —— 自适应没法把清晰度降掉（主人要的就是 dpr 3）。
export { LEVELS, DPR_MAX, DPR_PRESETS, MSAA_MODES, SHADOW_AREA } from './quality.mjs';

export const state = {
  t0: Date.now(),
  radius: num('r', 1000),
  seedStr: Q.get('seed') || 'ws3dgl-three',
  api: {}, data: {}, diag: [],
  gl: null, city: null, world: null, mesh: null,
  fps: 0, frameMs: 0, frames: 0,
  style: STYLE_ORDER.includes(Q.get('style')) ? Q.get('style') : 'day',
  shadows: flag('shadow', true),
  // 清晰度：默认 min(devicePixelRatio, 3)；`?dpr=` 覆盖；页面开关只改 state.dprUi（自适应永远不碰它）
  dprQuery: Q.has('dpr') ? parseFloat(Q.get('dpr')) : null,
  dprUi: null,
  // 抗锯齿默认 0（dpr 3 本身就是超采样）；`?msaa=` 保留
  msaaQuery: Q.has('msaa') ? parseFloat(Q.get('msaa')) : null,
  msaaUi: null, msaa: 0,
  shadowEvery: Math.max(1, Math.round(num('shadowEvery', SHADOW_EVERY))),
  sharp: flag('sharp', false),          // `?sharp=1`：渲染分辨率低于原生时才需要，dpr 3 下默认不做
  path: null,
  detail: flag('detail', true),
  bloom: flag('bloom', true),
  variety: num('variety', 1),
  autoQuality: flag('auto', true),
  quality: 0, qualityWhy: '未测',
  outline: Q.has('outline') ? Q.get('outline') !== '0' : null,   // null = 跟风格档（二次元档默认开）；?outline=0/1 覆盖
  // 描边粗细的现场覆盖（`?outlineW=0.004`）：风格档给的是默认值，真机上想细调不用重发页面
  outlineW: Q.has('outlineW') ? parseFloat(Q.get('outlineW')) : null,
  outlineOn: false, outlineCompiled: false,
  errors: [], ready: false,
  layout: null, walk: null, gen: {},
  lod: { near: 0, mid: 0, far: 0 }, draws: 0,
  glLostCount: 0, autoShadowOff: false,
  shadowSnap: null,
};

window.addEventListener('error', (e) => state.errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => state.errors.push('promise: ' + String(e.reason)));

function say(msg) {
  state.diag.push(msg);
  const el = $('#boot');
  if (el) el.textContent = msg;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (a) => (!a ? '未调' : `${a.ok ? 'HTTP ' + a.status : '失败(' + (a.status || a.error) + ')'} ${a.ms}ms`);

/** 无 GL 时的诊断面板：把"为什么"和"数据取到没有"都摆出来（照 v1 的口径） */
function showDiag(reason) {
  const d = $('#diag');
  if (!d) return;
  d.style.display = 'block';
  const r = state;
  const rows = [
    ['渲染', '❌ 拿不到 WebGL2 上下文 —— ' + reason],
    ['浏览器', navigator.userAgent],
    ['8790 /api/time', fmt(r.api.time)],
    ['8790 /api/location', fmt(r.api.location)],
    ['8790 /api/osm_cache', fmt(r.api.osm_cache) + ' ' + (r.data.cacheKeys || '')],
    ['8790 /api/osm_area', fmt(r.api.osm_area) + ' ' + (r.data.osmArea || '')],
    ['8788 真路网文件', r.data.roadFiles ? `${r.data.roadFiles.length} 个 / ${(r.data.roadBytes / 1024 | 0)} KB / ${r.data.realRoads} 条路` : '未取'],
    ['路网覆盖', r.data.roadCoverPct !== undefined ? `真路网缓存覆盖本盘 ${r.data.roadCoverPct}%（补满后合成路 ${r.data.synthRoads || 0} 条）` : '—'],
    ['城市生成', r.city ? `街区 ${r.city.stats.blocks} · 楼 ${r.mesh ? r.mesh.stats.buildings : r.city.stats.buildings} · 树 ${r.city.stats.trees} · 斑马线 ${r.city.stats.crossings}` : '未生成'],
    ['几何', r.mesh ? `三角形 ${r.mesh.stats.trisTotal.toLocaleString()} · 顶点 ${r.mesh.stats.verts.toLocaleString()}` : '未建'],
    ['布局体检', r.layout ? `楼↔路最小净距 ${r.layout.after.minRoadClear}m · 楼间最小间距 ${r.layout.after.minGap}m` : '未测'],
    ['可通行自测', r.walk ? `沿街走 ${r.walk.covered}m / 目标 ${r.walk.target}m · 卡住 ${r.walk.stuck} 次` : '未测'],
    ['报错', r.errors.length ? r.errors.join(' | ') : '无'],
  ];
  d.innerHTML = '<h3>诊断（无头/无 GPU 环境的预期结果）</h3><table>'
    + rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join('') + '</table>'
    + '<p class="hint">这台机器上无头 Chromium 默认拿不到 WebGL2（第 2 帧还会丢上下文，属环境限制）。'
    + '真机（手机浏览器）能拿到 WebGL2，画面才出得来 —— 上面每一行数据都是真取到的。</p>';
}

/** 带重试的取数：/api/location 会触发真定位，后端偶尔要十几秒（实测一次 15s 超时），重试一次即可 */
async function apiGetRetry(path, tries = 2, timeoutMs = 20000) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await apiGet(path, timeoutMs);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

async function fetchAll(center) {
  // /api/location 会触发真定位，冷启动实测能拖到 15s 超时；但它**只影响"用哪个坐标当中心"**，
  // 拿不到就按 ?lat/?lng 或默认坐标继续（页面不能为了一个定位卡住建城）⇒ 它的超时给短的。
  const jobs = [
    ['time', '/api/time', 20000],
    ['location', '/api/location', 6000],
    ['osm_cache', '/api/osm_cache', 20000],
    ['osm_area', `/api/osm_area?lat=${center.lat}&lng=${center.lng}&radius=1000`, 20000],
    ['schedule', '/api/schedule', 20000],
  ];
  const out = await Promise.all(jobs.map(async ([k, p, t]) => [k, await apiGet(p, t)]));
  for (const [k, v] of out) state.api[k] = v;
  return Object.fromEntries(out.map(([k, v]) => [k, v.json]));
}

/** 定位后台补一次：成功了只更新 HUD 那行字（已经建好的城不重建，避免画面突然跳） */
async function retryLocationInBackground() {
  if (state.api.location && state.api.location.ok) return;
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const v = await apiGet('/api/location', 12000);
    if (v.ok) {
      state.api.location = v;
      const l = v.json || {};
      state.data.area = l.area || (l.path || []).map((x) => x.name).join('·') || '—';
      state.data.locationRetried = true;
      hud();
      return;
    }
  }
  state.data.locationRetried = false;
}

// ── 渲染器 ───────────────────────────────────────────────────────────────────
let renderer = null, composer = null, bloomPass = null, sharpenPass = null, scene = null, camera = null, outline = null;
// 每帧要用的临时量（不在渲染循环里 new，免得每帧造垃圾）
const _toonV = new THREE.Vector3(), _toonQ = new THREE.Quaternion();

/**
 * 锐化 pass（`?sharp=1`）：4 抽头 unsharp。**只在"渲染分辨率低于原生"时才有意义** ——
 * dpr 3 已经是原生分辨率（手机上 devicePixelRatio 通常就是 3）⇒ 默认不做，省掉一次全屏。
 * 真机上如果哪天把清晰度降到 2×/1.5×，这个开关就是补清晰度最便宜的一招。
 */
const SharpenShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0.6 }, uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float uAmount; uniform vec2 uTexel; varying vec2 vUv;',
    'void main() {',
    '  vec4 c = texture2D(tDiffuse, vUv);',
    '  vec3 blur = (texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb',
    '             + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;',
    '  gl_FragColor = vec4(c.rgb + (c.rgb - blur) * uAmount, c.a);',
    '}',
  ].join('\n'),
};
let sun = null, hemi = null, amb = null, sky = null, envRT = null, world = null;
let shadowArea = SHADOW_AREA;         // `?shadowArea`：阴影相机半宽（纹素尺寸 = 2*area/mapSize，吸附要靠它）
const shadowSnap = flag('snap', true); // `?snap=0` = 关掉纹素吸附（真机 A/B 用；默认开）

/** 先自己探一次 WebGL2：拿不到就**不建** WebGLRenderer（three 建失败的 console.error 会污染控制台） */
export function probeWebGL2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, reason: '浏览器没给 WebGL2 上下文（无 GPU / 命令行禁用了 3D API）' };
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return { ok: true };
  } catch (e) { return { ok: false, reason: '取 WebGL2 抛错：' + (e && e.message || e) }; }
}

function mountRenderer(withShadows) {
  let canvas = $('#cv');
  // ⚠️ 丢过上下文的画布**不能复用**：在它上面重建 WebGLRenderer 会读到 null.precision 直接抛
  // （v1 的注释里踩过同一个坑：换一张新画布再建）
  if (state.glLostCount > 0 && canvas) {
    const fresh = document.createElement('canvas');
    fresh.id = 'cv';
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  const pre = probeWebGL2();
  if (!pre.ok) { renderer = null; return pre; }
  // ⚠️ 画布 antialias 只在**建渲染器这一下**能定，之后就改不了了；而且只要走 EffectComposer
  //（夜景 bloom / ?sharp=1），画面来自 composer 的 RT ⇒ 画布这一项**被架空**，真正生效的是
  // composer RT 的 `samples`（见 setupScene）。所以默认关：dpr 3 本身就是超采样，MSAA 那笔最贵。
  state.msaa = pickMsaa({ query: state.msaaQuery });
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: state.msaa >= 2,
      preserveDrawingBuffer: Q.get('shot') === '1' || Q.get('preserve') === '1' || navigator.webdriver === true,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    renderer = null;
    return { ok: false, reason: String((e && e.message) || e) };
  }
  const gl = renderer.getContext();
  if (!gl) return { ok: false, reason: 'WebGLRenderer 建起来了但拿不到 context' };
  renderer.shadowMap.enabled = !!withShadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 阴影贴图**不再每帧重算**：默认隔帧（`?shadowEvery=1` 回到每帧），人站着不动时一次都不算。
  // 点这个开关的地方：setShadowSize / applyStyle / mountWorld，以及下面循环里"光源真的挪了"那一下。
  renderer.shadowMap.autoUpdate = false;
  state.shadowDirty = true; state.shadowWait = 0;
  // 着色器编译错的**原文**自己收下来（three 的官方钩子）。为什么不用 info.programs 的 diagnostics：
  // 那个只在"第一次真的画"时才挂上，而且上下文一丢，所有程序的 LINK_STATUS 都会读成 false ⇒
  // 光看 diagnostics 分不清"编不过"和"没上下文"。这里拿到的是驱动给的日志原文。
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const txt = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
      .map((x) => String(x || '').trim()).filter(Boolean).join(' | ');
    (state.shaderErrors || (state.shaderErrors = [])).push(String(txt || '(驱动没给日志)').slice(0, 300));
  };
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = STYLES[state.style].exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0a1018, 1);
  canvas.addEventListener('webglcontextlost', onGlLost, false);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true, attrs: gl.getAttributes ? gl.getAttributes() : {},
    rendererName: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || '未知'),
  };
}

function onGlLost(e) {
  e.preventDefault();
  state.glLostCount++;
  if (state.glLostCount === 1 && state.shadows) {
    state.shadows = false; state.autoShadowOff = true;
    state.diag.push('⚠️ WebGL 上下文丢失 ⇒ 自动关掉阴影继续（本机无头就是这个行为）');
    setTimeout(() => {
      const r = mountRenderer(false);
      if (r.ok) { state.glEverOk = true; state.gl = { ok: true, renderer: r.rendererName, attrs: r.attrs }; applyStyle(); sizeRenderer(); startLoop(); }
      else { state.gl = { ok: false, reason: r.reason }; showDiag(r.reason); }
    }, 60);
    return;
  }
  state.gl = { ok: false, reason: '上下文丢失（第 ' + state.glLostCount + ' 次）', lost: true };
  showDiag(state.gl.reason);
}

function level() { return LEVELS[Math.min(state.quality, LEVELS.length - 1)]; }

function sizeRenderer() {
  if (!renderer) return;
  // 🔴 dpr 只由 查询串 / 页面开关 / 默认满档 三者决定，**画质档与自适应都不参与**
  const native = window.devicePixelRatio || 1;
  const dpr = pickDpr({ devicePixelRatio: native, query: state.dprQuery, ui: state.dprUi });
  // 原生 dpr 原值单独留一份：HUD 上要跟"实际生效的 dpr"并排显示（浏览器报 1.5 时一眼看出是页面缩放而不是手机就这样）。
  // 只读不参与任何计算 —— pickDpr 的取档逻辑一个字都没动。
  state.dprNative = native;
  state.dpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (bloomPass) bloomPass.resolution.set(Math.max(64, window.innerWidth / 4), Math.max(64, window.innerHeight / 4));
  if (sharpenPass && sharpenPass.uniforms.uTexel) {
    sharpenPass.uniforms.uTexel.value.set(1 / Math.max(1, window.innerWidth * dpr), 1 / Math.max(1, window.innerHeight * dpr));
  }
}

/** 请求下一帧重算阴影贴图（贴图尺寸变了、光照变了、换城了都要） */
function requestShadow() { state.shadowDirty = true; state.shadowWait = state.shadowEvery; }

function setShadowSize(px) {
  if (!renderer || !sun) return;
  state.shadowSize = px;
  renderer.shadowMap.enabled = px > 0 && state.shadows;
  sun.castShadow = px > 0 && state.shadows;
  if (px > 0) {
    sun.shadow.mapSize.set(px, px);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  requestShadow();
}

function applyStyle() {
  const st = STYLES[state.style];
  if (!renderer) return;
  renderer.toneMappingExposure = st.exposure;
  if (scene) {
    scene.fog.color.set(st.fogColor);
    scene.fog.density = st.fogDensity;
  }
  if (sun) {
    sun.color.set(st.sunColor);
    sun.intensity = st.sunIntensity;
    const d = st.sunDir;
    sun.position.set(d[0] * 260, d[1] * 260, d[2] * 260);
  }
  if (hemi) { hemi.color.set(st.hemiSky); hemi.groundColor.set(st.hemiGround); hemi.intensity = st.hemiIntensity; }
  if (amb) { amb.color.set(st.ambient); amb.intensity = st.ambientIntensity; }
  if (scene) scene.environmentIntensity = st.envIntensity;
  if (sky) sky.setStyle(st, st.sunDir);
  if (world) { world.setStyle(st); state.texMs = world.texMs ? world.texMs() : null; state.texClean = world.isClean ? world.isClean() : null; }
  const wantBloom = state.bloom && st.bloom && level().bloom;
  if (composer && bloomPass) {
    bloomPass.strength = wantBloom ? st.bloomStrength : 0;
    bloomPass.enabled = wantBloom;
  }
  state.bloomOn = wantBloom;
  if (sharpenPass) sharpenPass.enabled = !!state.sharp;
  requestShadow();
  // 描边：显式 ?outline= 优先，否则跟风格档（day/dusk 没有这字段 ⇒ 关）
  const wantOutline = state.outline === null ? !!st.outline : !!state.outline;
  // 粗细与颜色**从风格档取**（不是硬编码）：anime 档在 palette 里写死了 outlineThickness / outlineColor，
  // `?outlineW=` 覆盖粗细 —— 真机上想现场调粗细不必重发页面。
  const ospec = outlineSpecFor(st, { width: state.outlineW });
  state.outlineThickness = ospec.thickness; state.outlineColor = ospec.color; state.outlineWUsed = state.outlineW;
  if (world && world.setOutline) world.setOutline(wantOutline && !!outline, ospec);
  state.outlineOn = !!(wantOutline && outline);
  hud();
}

function setupScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(STYLES[state.style].fogColor, STYLES[state.style].fogDensity);
  camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.4, 5200);
  sky = createSky();
  scene.add(sky.mesh);
  sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  const A = num('shadowArea', SHADOW_AREA);            // 阴影相机只罩住玩家周围（90m ⇒ 2048 贴图下 8.8cm/纹素）
  shadowArea = A;
  sun.shadow.camera.left = -A; sun.shadow.camera.right = A;
  sun.shadow.camera.top = A; sun.shadow.camera.bottom = -A;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 700;
  // bias / normalBias 这一轮**刻意没动**：它们是"跟画面观感绑死"的两个数（本机无 GPU，看不到实际长啥样），
  // 改它们等于闭着眼睛调参 —— 这轮只治"纹素网格每帧滑动"这一条（见 shadowsnap.mjs 的说明）。
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.5;
  scene.add(sun);
  scene.add(sun.target);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  amb = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(amb);
  envRT = buildEnvironment(renderer, sky);
  if (envRT) scene.environment = envRT;
  // 描边：二次元档的"动画感"。它只在**没有后处理**那条直渲路径上用（夜景 bloom 走 composer，
  // RenderPass 直接调 renderer.render，绕不过去）—— 二次元档本身不开 bloom，所以正好覆盖到。
  try {
    outline = new THREE.OutlineEffect(renderer, { defaultThickness: OUTLINE.thickness, defaultColor: toRgb(OUTLINE.color) });
  } catch (e) { outline = null; state.diag.push('描边不可用（' + e.message + '）'); }
  // 后处理：夜景 bloom（四分一分辨率，手机上这笔最贵，降质第 4 档会关掉）
  try {
    composer = new THREE.EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: state.msaa }));
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), STYLES.dusk.bloomStrength, 0.55, 0.82);
    composer.addPass(bloomPass);
    sharpenPass = new THREE.ShaderPass(SharpenShader);
    sharpenPass.enabled = !!state.sharp;
    composer.addPass(sharpenPass);
    composer.addPass(new THREE.OutputPass());
  } catch (e) {
    composer = null; bloomPass = null; sharpenPass = null;
    state.diag.push('后处理不可用（' + e.message + '）⇒ 直接渲染（夜里少了泛光）');
  }
}

/** 把当前全部着色器程序的编译诊断抓下来（首帧、以及描边首帧各抓一次） */
function capturePrograms(slot = 'programs') {
  if (!renderer) return;
  // 上下文丢了之后拿到的诊断全是 "failed"（那是"没上下文"的余波，不是着色器的问题）⇒ 不覆盖首帧的读数
  const ctx = renderer.getContext();
  if (ctx && ctx.isContextLost && ctx.isContextLost()) { state[slot + 'Skipped'] = '上下文已丢失'; return; }
  try {
    state[slot] = (renderer.info.programs || []).map((p) => ({
      name: p.name || 'unnamed', type: p.shaderType || '',
      // ⚠️ 这里**不要**把空的 programLog 写成 "failed"：three 只在 (runnable=false 或 programLog 非空) 时才挂 diagnostics，
      // 而 programLog 可能只是一条警告。空日志就照实记 'runnable'，别自己造一个失败出来。
      runnable: p.diagnostics ? !!p.diagnostics.runnable : true,
      diag: p.diagnostics ? String(p.diagnostics.programLog || '(空日志)').slice(0, 400) : null,
    }));
    state[slot + 'Ok'] = state[slot].every((p) => p.runnable && (!p.diag || p.diag === '(空日志)'));
  } catch (e) { state[slot] = []; state[slot + 'Ok'] = false; state[slot + 'Error'] = String(e.message || e); }
}

/**
 * 描边只给楼体五个桶：OutlineEffect 的默认行为是"遍历到的每个材质都描一圈"，
 * 所以天空球 / 角色 / 道具这些必须显式打上 `visible:false`（world.mjs 已经给城市那批打好了）。
 * 角色是懒建材质的（换角色/换图层会新建）⇒ 每帧扫一遍，但按材质 uuid 记忆，重复的只查一次。
 */
const outlineMarked = new Set();
function markOutlineExcluded(root) {
  if (!root) return;
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (!m || outlineMarked.has(m.uuid)) continue;
      outlineMarked.add(m.uuid);
      if (m.userData.outlineParameters === undefined) m.userData.outlineParameters = { visible: false };
    }
  });
}

function mountWorld(mesh, city) {
  if (world) { for (const m of world.group.children) scene.remove(m); world.dispose(); }
  // 格边长**不从这里传**：它必须跟 build.mjs 真正用的那个数一致（records 里带着），
  // 这里只允许覆盖滞后带（`?lodHys=1` = 关掉滞后，真机 A/B 用）
  world = createWorld(mesh, {
    maxAniso: renderer ? renderer.capabilities.getMaxAnisotropy() : 1,
    lodHysteresis: num('lodHys', undefined),
    // 起手就按当前风格建对应那一档贴图（否则 ?style=anime 会先建写实档再重建一次，白花一份时间）
    clean: !!STYLES[state.style].clean,
  });
  world.group.name = 'city';
  scene.add(world.group);
  applyStyle();
  requestShadow();
}

// ── 角色 / 输入 / 相机 ───────────────────────────────────────────────────────
let input = null, view = null, char = null, collider = null, avatar = null;   // char = 运动(v1 的 createPlayer)，avatar = 外观(character.mjs 工厂)
/** 外观层的显示名：骨骼角色在 state.name 里自带（billboard 没有 ⇒ 落回角色表，读数逐字不变） */
function charLabel(st) {
  if (!st) return null;
  if (st.name) return st.name;
  const c = CHARACTERS[st.index];
  return c ? c.name : null;
}


// ── HUD ──────────────────────────────────────────────────────────────────────
let hudT = 0;
function hud(now) {
  if (now !== undefined && now - hudT < 200) return;
  hudT = now === undefined ? hudT : now;
  const r = state, m = r.mesh;
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('#h-fps', r.fps || '—');
  set('#h-ms', r.frameMs ? r.frameMs.toFixed(1) + 'ms' : '—');
  set('#h-buildings', m ? m.stats.buildings : '—');
  set('#h-tris', m ? m.stats.trisTotal.toLocaleString() : '—');
  set('#h-draws', r.draws || '—');
  set('#h-radius', (r.radius / 1000).toFixed(2) + ' km');
  set('#h-lod', `${r.lod.near}/${r.lod.mid}/${r.lod.far}`);
  set('#h-pos', r.char ? `${r.char.pos.x.toFixed(0)}, ${r.char.pos.z.toFixed(0)}` : '—');
  set('#h-view', r.third ? '第三人称' : '第一人称');
  set('#h-shadow', r.shadows ? '开 ' + (r.shadowSize || '') + '²' : (r.autoShadowOff ? '关（自动降级）' : '关'));
  set('#h-style', STYLES[r.style].name);
  set('#h-area', r.data.area || '—');
  set('#h-clock', r.data.clock || '—');
  set('#h-sched', r.data.schedule || '—');
  set('#h-roads', r.city ? `真 ${r.city.stats.realRoads} / 合成补 ${r.data.synthRoads || 0} 条（真路网里程 ${r.city.stats.realLenShare}%）` : '—');
  set('#h-blocks', r.city ? `${r.city.stats.blocks} 街区 · 树 ${r.city.stats.trees} · 井盖 ${r.city.stats.manholes} · 斑马线 ${r.city.stats.crossings}` : '—');
  set('#h-gen', r.gen.cityMs !== undefined ? `城 ${r.gen.cityMs}ms · 风格 ${r.gen.styleMs}ms · 几何 ${r.gen.buildMs}ms · 启动 ${r.bootMs}ms` : '—');
  set('#h-render', r.renderName ? String(r.renderName).slice(0, 44) : '—');
  const L = level();
  // 括号里的"原生"是浏览器报的 devicePixelRatio **原值**：它是 1.5 就说明是页面缩放/桌面模式把 dpr 除下去了，
  // 不是手机天生只有 1.5（pickDpr 一个字没动，这里只是把它读出来给人看）。
  set('#qual', `${r.quality}/${LEVELS.length - 1} ${L.name} · ${dprLabel(r.dpr, r.dprNative)} · 阴影 ${r.shadowSize || 0}² · ${r.qualityWhy}`);
  // 按钮上直接写当前档位（主人要求：不要只写快捷键）
  set('#b-view', r.third ? '第三人称' : '第一人称');
  set('#b-style', STYLES[r.style].name);
  set('#b-shadow', r.shadows ? '开' : '关');
  set('#b-detail', r.detail ? '开' : '关');
  set('#b-radius', (r.radius / 1000).toFixed(1) + 'km');
  set('#b-radius2', (r.radius / 1000).toFixed(1) + 'km');
  set('#b-bloom', r.bloomOn ? '开' : '关');
  set('#b-outline', r.outlineOn ? '开' : (r.outline === false ? '关' : '跟风格'));
  set('#b-dpr', (r.dpr || 0).toFixed(2).replace(/\.00$/, '') + '×' + (r.dprUi === null ? '' : ' ·手'));
  set('#b-msaa', r.msaa ? r.msaa + '×' : '关');
  // 骨骼角色在按钮上多带一个当前动画名（纸片人下这段是空串 ⇒ 按钮文字与以前逐字相同）
  const clipTag = r.charState && r.charState.kind === 'skinned' && r.charState.clip ? ' · ' + r.charState.clip : '';
  set('#b-char', (r.charName || (CHARACTERS[0] && CHARACTERS[0].name) || '—') + clipTag);
}

// ── 自适应降质（主人真机实测：dpr 2 → 30fps，1.5 → 60fps；这是最大的一笔）──────
const frameHist = [];
let lastQualChange = 0;
function adaptive(now) {
  if (!state.autoQuality || !renderer) return;
  frameHist.push(state.frameMs);
  if (frameHist.length > 90) frameHist.shift();
  // 判断本身在 quality.mjs 的 adaptiveStep 里（纯函数、node 可测）；这里只管把结果落到实处。
  // 🔴 它返回的只有 quality：阴影 / LOD / bloom 会变，dpr 一次都不会变（那是主人的清晰度）。
  const step = adaptiveStep({ frameMs: frameHist, quality: state.quality, sinceLastChangeMs: now - lastQualChange, levels: LEVELS });
  if (step.why) state.qualityWhy = step.why;
  if (step.changed) {
    state.quality = step.quality;
    lastQualChange = now;
    applyQuality();
  }
}
function applyQuality() {
  const L = level();
  if (Q.has('lodNear')) L.near = parseFloat(Q.get('lodNear'));
  if (Q.has('lodMid')) L.mid = parseFloat(Q.get('lodMid'));
  sizeRenderer();
  setShadowSize(state.shadows ? pickShadowRes({ quality: state.quality, levels: LEVELS, query: Q.has('shadowRes') ? parseFloat(Q.get('shadowRes')) : null }) : 0);
  applyStyle();
}

// ── 摇杆（左半屏）────────────────────────────────────────────────────────────
// player.mjs 只算状态，DOM 由页面画：这里把底盘环摆到"手指落点"（浮起档）或左下角固定位，
// 拇指钮按 dx/dy 跟手。之前 v1 的 onStick 没人消费 ⇒ 真机上拖了没反馈（主人说"连摇杆都没有"）。
const stickState = { active: false, x: 0, y: 0, ox: 0, oy: 0, dx: 0, dy: 0, mag: 0, floated: false };
function onStick(payload) { Object.assign(stickState, payload || {}); }
function stickAnchor() {
  const el = $('#stick');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
}
function updateStick() {
  const el = $('#stick'), knob = $('#knob');
  if (!el || !knob) return;
  if (!stickState.active) {
    el.classList.remove('on');
    el.style.left = ''; el.style.top = '';
    knob.style.transform = '';
    return;
  }
  el.classList.add('on');
  if (stickState.floated) { el.style.left = (stickState.ox - el.offsetWidth / 2) + 'px'; el.style.top = (stickState.oy - el.offsetHeight / 2) + 'px'; }
  else { el.style.left = ''; el.style.top = ''; }
  const R = 64, L = Math.hypot(stickState.dx, stickState.dy) || 1, k = Math.min(1, R / L);
  knob.style.transform = `translate(${stickState.dx * k}px, ${stickState.dy * k}px)`;
}

// ── 热键 / 按钮 ──────────────────────────────────────────────────────────────
/** 下一档风格：**遍历 STYLES 的键**（顺序 = palette.mjs 里的插入序 day → anime → dusk）。
 *  以前这里是 `state.style === 'day' ? 'dusk' : 'day'` 的两档硬编码 ⇒ 加第三档时按一下按钮
 *  会在这两档之间来回跳、新档永远轮不到（HUD 的 #h-style 也会一直显示旧名字）。 */
function nextStyleKey() {
  const i = STYLE_ORDER.indexOf(state.style);
  return STYLE_ORDER[(i + 1) % STYLE_ORDER.length];
}
function onHotkey(key) {
  const k = key.toLowerCase();
  if (k === 'v') { state.third = !state.third; }
  else if (k === 'n') { setStyle(nextStyleKey()); }
  else if (k === 'p') { state.shadows = !state.shadows; setShadowSize(state.shadows ? level().shadow : 0); }
  else if (k === 'l') { state.detail = !state.detail; }
  else if (k === 'b') { state.bloom = !state.bloom; applyStyle(); }
  else if (k === 'o') { state.outline = !state.outlineOn; applyStyle(); }
  else if (k === 'k') { doAction('dpr'); }
  else if (k === 'm') { doAction('msaa'); }
  else if (k === 'c') { nextCharacter(); }
  else if (k === 'h') { $('#help') && $('#help').classList.toggle('show'); }
  else if (k === '[') setRadius(Math.max(300, state.radius - 300));
  else if (k === ']') setRadius(Math.min(2000, state.radius + 300));
  else if (k === 'r') { state.seedStr = 'ws3dgl-three-' + Math.floor(Math.random() * 1e6); regenerate(); }
  hud();
}

/**
 * 改 MSAA。**只有 composer 那个 RT 能在线改**（画布 antialias 是建渲染器时定的，改不了 ——
 * 而且走 composer 时画布那项本来就被架空）。改完 dispose 让它按新 samples 重建。
 */
export function setMsaa(n) {
  const v = pickMsaa({ query: n });
  state.msaaUi = v;
  state.msaa = v;
  if (composer) {
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (rt && rt.samples !== v) { rt.samples = v; rt.dispose(); }
    }
    sizeRenderer();
  }
  hud();
  return v;
}

export function setStyle(s) { state.style = s; applyStyle(); }
export function setRadius(r) { state.radius = r; regenerate(); }
export function setQuality(q) { state.quality = Math.max(0, Math.min(LEVELS.length - 1, q)); applyQuality(); }

export async function regenerate() {
  say('重新生成城市…');
  const c = state.data.center;
  const res = prepareCity({
    lat: c.lat, lng: c.lng, radius: state.radius, realRoads: state.lastRealRoads || [],
    seedStr: state.seedStr, center: state.centerShift, opts: { blockKm: num('blockKm', 1.5) },
  });
  afterCity(res, true);
  say('✅ 换城完成');
}

function afterCity(res, respawn) {
  const t0 = performance.now();
  const styled = styleCity(res.city, { share: state.variety });
  const styleMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const san = sanitizeLayout(styled.buildings, res.city.roads, {});
  const t2 = performance.now();
  const mesh = buildWorld(res.city, { styled: { buildings: san.buildings, vacant: styled.vacant } });
  const buildMs = Math.round(performance.now() - t2);
  state.city = res.city; state.styled = styled; state.sanitize = san; state.mesh = mesh;
  state.data.synthRoads = res.stats.synthRoads;
  state.gen = { cityMs: res.stats.ms, styleMs, buildMs, sanitizeMs: Math.round(t2 - t1) };
  state.layout = { before: validateLayout(styled.buildings, res.city.roads), after: validateLayout(san.buildings, res.city.roads) };
  collider = buildCollider({ buildings: san.buildings });
  if (respawn) {
    char.pos.x = 0; char.pos.z = 0; char.vel.x = 0; char.vel.z = 0;
    if (state.spawn) { char.pos.x = state.spawn.x; char.pos.z = state.spawn.z; }
    resolve(char.pos, char.radius + 0.3, collider.near(char.pos.x, char.pos.z));
  }
  if (renderer) mountWorld(mesh, res.city);
  hud();
}

// ── 循环 ─────────────────────────────────────────────────────────────────────
let last = performance.now(), fpsAcc = 0, fpsN = 0, loopGen = 0, running = false;

function startLoop() {
  const my = ++loopGen;
  running = true;
  const step = (now) => {
    if (my !== loopGen) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt, now);
    if (my === loopGen) requestAnimationFrame(step);
  };
  last = performance.now();
  requestAnimationFrame(step);
}

function tick(dt, now) {
  const t0 = performance.now();
  if (input && view) {
    const s = input.sample();
    // 运动 + 视角**全在 player.mjs 里**（v1 刚升级过：加减速 / 本体转身 bodyYaw / 脱困 / 上台阶）
    view.update(dt, s, collider);
    const cam = view.camera();
    camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
    if (camera.fov !== cam.fov) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
    state.third = view.third;
    if (avatar) {
      avatar.update(dt, {
        pos: view.pos, heading: view.bodyYaw, speed: view.speedNow, moving: view.speedNow > 0.25,
        third: view.third, camPos: camera.position, sunDir: STYLES[state.style].sunDir, groundY: 0,
      });
      state.charState = avatar.state;
    }
    updateStick();
  }
  if (sun && char) {
    // 光源跟着角色走，但**在光空间里吸到阴影纹素网格上**（shadowsnap.mjs）：
    // 连续平移会让同一个地面点每帧落在纹素里的不同位置 ⇒ 阴影边缘"爬/沸"，吸住才是固定点阵。
    const d = STYLES[state.style].sunDir;
    const sn = snapShadowLight({
      px: char.pos.x, pz: char.pos.z, sunDir: d, distance: 260,
      area: shadowArea, mapSize: sun.shadow.mapSize.x, enabled: shadowSnap,
    });
    sun.position.set(sn.position[0], sn.position[1], sn.position[2]);
    sun.target.position.set(sn.target[0], sn.target[1], sn.target[2]);
    sun.target.updateMatrixWorld();
    // 读数只给快照/探针看（每帧原地改，别在渲染循环里造垃圾）
    const ss = state.shadowSnap || (state.shadowSnap = { on: true, texel: 0, area: 0, res: 0, offset: [0, 0] });
    ss.on = sn.snapped; ss.texel = sn.texel; ss.area = shadowArea; ss.res = sun.shadow.mapSize.x;
    ss.offset[0] = sn.offset[0]; ss.offset[1] = sn.offset[1];
    // 阴影贴图节流：光源（吸附后的）位置没变就一次都不重算；变了也最多每 shadowEvery 帧算一次。
    if (renderer.shadowMap.enabled && state.shadowSize > 0) {
      const key = sn.position[0].toFixed(3) + ',' + sn.position[1].toFixed(3) + ',' + sn.position[2].toFixed(3);
      if (key !== state.shadowKey) { state.shadowKey = key; state.shadowDirty = true; state.shadowWait = 0; }
      if (state.shadowDirty) {
        state.shadowWait = (state.shadowWait || 0) + 1;
        if (state.shadowWait >= state.shadowEvery) {
          renderer.shadowMap.needsUpdate = true;
          state.shadowDirty = false; state.shadowWait = 0;
          state.shadowUpdates = (state.shadowUpdates || 0) + 1;
        }
      }
    }
  }
  if (world && char) {
    const L = level();
    const lodNear = Q.has('lodNear') ? parseFloat(Q.get('lodNear')) : L.near;
    const lodMid = Q.has('lodMid') ? parseFloat(Q.get('lodMid')) : L.mid;
    state.lod = world.update(char.pos.x, char.pos.z, lodNear, lodMid, state.detail);
  }
  // 二次元档的分色染色要算"受光比"：着色器里要的是 **view space** 的太阳方向
  // （跟 three 的 `directLight.direction` 同一个空间，不然明暗阶与色阶会对不上）。
  // 相机每帧都在转 ⇒ 每帧转一个向量，代价可忽略；写实两档也照转，只是那边的材质根本不读它。
  if (world && world.setToonSunDirView && camera) {
    const sd = STYLES[state.style].sunDir;
    _toonQ.copy(camera.quaternion).invert();
    _toonV.set(sd[0], sd[1], sd[2]).applyQuaternion(_toonQ).normalize();
    world.setToonSunDirView([_toonV.x, _toonV.y, _toonV.z]);
  }
  // 上下文丢了就别再画（three 自己也会 early-return，但那样会把 draws 读数刷成 0）
  const glLost = renderer && renderer.getContext().isContextLost && renderer.getContext().isContextLost();
  if (renderer && camera && scene && !glLost) {
    // 走哪条路由 quality.mjs 的纯函数定：没有 bloom/锐化就**绝不**进 composer（省一次全屏 blit + 一张 3× RT）
    const bloomOn = !!(composer && bloomPass && bloomPass.enabled);
    const sharpOn = !!(composer && sharpenPass && sharpenPass.enabled);
    const path = renderPath({ hasComposer: !!composer, bloomOn, sharpOn, outlineOn: state.outlineOn && !!outline });
    state.path = path;
    if (path === 'composer') { composer.render(); state.draws = renderer.info.render.calls; }
    else if (path === 'outline') {
      markOutlineExcluded(scene);
      // ⚠️ 读数口径：renderer.info 每调一次 renderer.render 就会重置 ⇒ 直接数"描边那一遍"会丢掉主渲染。
      // 拆成两半自己调（`OutlineEffect.render` 内部就是这两句），两遍的 calls 相加 = 这一帧的总数，
      // 与不开描边那条路的"一帧总数"同口径，才谈得上 before→after。
      renderer.render(scene, camera);
      const mainDraws = renderer.info.render.calls;
      outline.renderOutline(scene, camera);
      state.outlineDraws = renderer.info.render.calls;
      state.draws = mainDraws + state.outlineDraws;
      state.outlineCompiled = true;               // 着色器已经在 boot 里编过并留了读数（programsOutline）
    } else { renderer.render(scene, camera); state.draws = renderer.info.render.calls; }
    // 首帧读数单独留一份：无头第 2 帧就丢上下文，后面的 draws 全是 0/旧值，只有这一份可信
    if (!state.firstFrame && state.draws > 0) state.firstFrame = { draws: state.draws, path, dpr: state.dpr, msaa: state.msaa, shadowSize: state.shadowSize || 0 };
  }
  const ms = performance.now() - t0;
  state.frameMs = state.frameMs ? state.frameMs * 0.8 + ms * 0.2 : ms;
  state.frames++;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { state.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  adaptive(now);
  hud(now);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
export async function boot() {
  const boot0 = performance.now();
  if (Q.get('once') === '1') state.autoQuality = false;
  say('① 建 WebGL 上下文…');
  const r = mountRenderer(state.shadows);
  state.gl = r.ok ? { ok: true, renderer: r.rendererName, attrs: r.attrs } : { ok: false, reason: r.reason };
  if (r.ok) state.glEverOk = true;                 // 丢过上下文之后 gl.ok 会变 false，但"曾经有 GL"这件事要留住
  state.renderName = r.ok ? r.rendererName : null;

  say('② 取 8790 的 API…');
  const center = { lat: num('lat', 29.5689), lng: num('lng', 106.5577) };
  const jsons = await fetchAll(center);
  const loc = jsons.location || {};
  if (!Q.has('lat') && loc.lat) { center.lat = loc.lat; center.lng = loc.lng; }
  state.data.center = center;
  state.data.centerSource = loc.lat ? 'api' : 'fallback';
  retryLocationInBackground();
  state.data.area = loc.area || (loc.path || []).map((p) => p.name).join('·') || '—';
  const t = jsons.time || {};
  state.data.clock = `${t.date || ''} ${t.time || ''} ${t.period || ''}`;
  const sch = jsons.schedule || {};
  const role = (sch.roles || [])[0];
  state.data.schedule = role ? `${role.name}：${(role.now || {}).name || ''}（${(role.now || {}).content || ''}）` : '—';

  const idx = indexCache((jsons.osm_cache || {}).files || []);
  state.data.cacheKeys = `键 ${(jsons.osm_cache || {}).count || 0}（road ${idx.road.length} / bldg ${idx.bldg.length} / 其它 ${idx.other.length}）`;
  state.data.osmArea = jsons.osm_area ? `${jsons.osm_area.cached ? '有缓存' : '无缓存'} ${jsons.osm_area.elements || 0} 元素` : '—';
  const generic = idx.other.filter((k) => !k.key.startsWith('bldg_') && !k.key.startsWith('places_'));
  const roadCand = idx.road.length ? idx.road : generic;
  const pick = pickRoadCaches(roadCand, center.lat, center.lng, state.radius, { maxFiles: 10, maxBytes: 3.5e6 });
  say(`③ 真路网：${roadCand.length} 个候选里挑 ${pick.picked.length} 个文件（${(pick.bytes / 1024 | 0)} KB）…`);
  const net = await loadRealRoads(pick, center.lat, center.lng, {});
  state.lastRealRoads = net.roads;
  state.data.roadFiles = net.files; state.data.roadBytes = net.bytes;
  state.data.realRoads = net.roads.length; state.data.roadErrors = net.errors;
  state.data.roadCoverPct = pick.coveragePct; state.data.roadCandidates = roadCand.length;

  // 出生点选址：真路网稀的地方补满路网也救不了"近处一片空地"，所以先试盖挑中心
  state.centerShift = { x: 0, z: 0 };
  if (flag('pick', true) && net.roads.length) {
    say('④ 挑出生点（真路网最密 + 真能盖出楼的那片）…');
    try {
      const pk = pickCenter({ lat: center.lat, lng: center.lng, radius: state.radius, realRoads: net.roads, seedStr: state.seedStr, opts: { blockKm: num('blockKm', 1.5) } });
      state.pickTried = pk.tried;
      if (pk.best && pk.best.near > 0) state.centerShift = { x: pk.best.x, z: pk.best.z };
    } catch (e) { state.diag.push('选址失败（用原中心）：' + e.message); }
  }

  say('⑤ 生成城市（真路网 + 补满路网 + 风格抽样）…');
  const res = prepareCity({
    lat: center.lat, lng: center.lng, radius: state.radius, realRoads: net.roads,
    seedStr: state.seedStr, center: state.centerShift, opts: { blockKm: num('blockKm', 1.5) },
  });
  state.city = res.city; state.data.synthRoads = res.stats.synthRoads; state.gen.cityMs = res.stats.ms;

  say('⑥ 风格抽样 + 布局体检 + 建几何…');
  const tStyle = performance.now();
  const styled = styleCity(res.city, { share: state.variety });
  const styleMs = Math.round(performance.now() - tStyle);
  const tSan = performance.now();
  const san = sanitizeLayout(styled.buildings, res.city.roads, {});
  const sanitizeMs = Math.round(performance.now() - tSan);
  state.layout = { before: validateLayout(styled.buildings, res.city.roads), after: validateLayout(san.buildings, res.city.roads) };
  state.sanitize = san;
  state.styled = styled;
  const tBuild = performance.now();
  const mesh = buildWorld(res.city, { styled: { buildings: san.buildings, vacant: styled.vacant } });
  state.mesh = mesh;
  state.gen.styleMs = styleMs;
  state.gen.sanitizeMs = sanitizeMs;
  state.gen.buildMs = Math.round(performance.now() - tBuild);

  // 出生点：站在真的路上（离圆心最近的一条），没有就退而求其次
  collider = buildCollider({ buildings: san.buildings });
  view = createPlayer({ yaw: Math.PI });
  char = view;                                   // char 只是个别名：运动全在 player.mjs 里（v1 与 three 版同一套手感）
  const nearestOn = (list) => {
    let best = null;
    for (const rd of list) for (const p of rd.pts) {
      const d = Math.hypot(p.x, p.z);
      if (!best || d < best.d) best = { d, x: p.x, z: p.z };
    }
    return best;
  };
  const realRoads = res.city.roads.filter((r) => !r.synth);
  const sp = nearestOn(realRoads.length && nearestOn(realRoads).d < 900 ? realRoads : res.city.roads);
  if (sp) { state.spawn = { x: +sp.x.toFixed(1), z: +sp.z.toFixed(1), onRealRoad: !!(realRoads.length && sp.d < 900) }; }
  else state.spawn = { x: 0, z: 0 };
  char.pos.x = state.spawn.x; char.pos.z = state.spawn.z;
  resolve(char.pos, char.radius + 0.3, collider.near(char.pos.x, char.pos.z));
  // 初始朝向：朝着"楼最多的那一侧"（免得一睁眼对着空地）
  let vx = 0, vz = 0;
  for (const b of san.buildings) { const d = Math.hypot(b.x, b.z); if (d > 30 && d < 700) { vx += b.x; vz += b.z; } }
  if (vx || vz) view.yaw = Math.atan2(vx, vz);
  view.bodyYaw = view.yaw;
  state.char = char;

  say('⑦ 可通行自测（从出生点沿街走 200m）…');
  state.walk = walkTest(san.buildings, res.city.roads, { target: 200 });

  // 🔴 输入 + 屏幕按钮必须**两条路径都接上**：这套线原来接在 `if (r.ok)` 里面 ⇒
  //    拿不到 WebGL 时（无头、无 GPU 的老手机）**一个按钮都点不动**，连「操作面板」都打不开，
  //    只能干看一块诊断面板 —— 与真机反馈的「按钮都点不了」同一类症状，但与 preventDefault 无关。
  //    下游函数（doAction/setStyle/setShadowSize/sizeRenderer/applyStyle）都已对"没有 renderer"做了空值保护。
  // data-ui 上的触摸不算摇杆/视角（按按钮不会甩镜头）；摇杆底盘位置交给 player.mjs
  input = createInput(document.body, { onKey: onHotkey, onStick, stickAnchor });
  state.input = input;                   // 探针读输入态用（v1 也是 state.input）
  for (const el of document.querySelectorAll('[data-act]')) {
    el.addEventListener('click', (ev) => { ev.preventDefault(); doAction(el.dataset.act); });
  }

  if (r.ok) {
    setupScene();
    setShadowSize(state.shadows ? num('shadowRes', level().shadow) : 0);
    mountWorld(mesh, res.city);
    // 外观层：默认 billboard（老路径，一个字节都没动）；?char=skinned 才去动态 import 骨骼角色模块。
    // 动态 import 的好处：默认路径**连这个请求都不会发**，骨骼那套代码挂了也伤不到默认路径。
    const wantKind = Q.get('char') || 'billboard';
    if (wantKind === 'skinned') {
      try {
        const { createSkinnedCharacter } = await import('./skinned.mjs');
        avatar = createSkinnedCharacter({
          model: Q.get('model') || undefined,
          height: num('charH', 1.7),
          yawOffset: num('charYaw', 0),
          strideWalk: Q.has('strideWalk') ? num('strideWalk', 2.2) : undefined,
          strideRun: Q.has('strideRun') ? num('strideRun', 5.6) : undefined,
        });
      } catch (e) {
        // 骨骼模块没拿到（网络/语法/裁剪产物里没 GLTFLoader）：如实记一笔并退回纸片人，绝不白屏
        state.errors.push('骨骼角色模块加载失败，退回纸片人：' + String(e && e.message || e));
        avatar = null;
      }
    }
    if (!avatar) {
      avatar = createCharacter({
        kind: wantKind,
        assetsBase: Q.get('charBase') || './ws3dgl/assets/characters/',
        height: num('charH', 1.7),
        layers: num('charLayers', 2),
        index: num('charIdx', 0),
      });
    }
    state.avatar = avatar;
    state.charName = charLabel(avatar.state) || (CHARACTERS[0] && CHARACTERS[0].name) || '—';
    scene.add(avatar.object3D);
    const st = STYLES[state.style];
    sun.color.set(st.sunColor); sun.intensity = st.sunIntensity;
    sizeRenderer();
    // 首帧前把着色器全编一遍并**把结果记下来**：本机无头第 2 帧就丢上下文，
    // 后面的 shader 报错全是"上下文没了"的余波 ⇒ 只有这一步的读数能证明我们的着色器本身没问题。
    try { renderer.compile(scene, camera); capturePrograms(); }
    catch (e) { state.programs = []; state.programsOk = false; state.programsError = String(e.message || e); }
    // ⚠️ 这里**故意不**为了"先编一遍描边着色器"多跑一次渲染：本喵试过，在无头 SwiftShader 上
    // 那一下正好把上下文搞丢（丢一次就重建渲染器，读数全乱）。描边材质的编译错由
    // `renderer.debug.onShaderError` 收原文（见 mountRenderer），不靠额外渲染。
    window.addEventListener('resize', () => { sizeRenderer(); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });
    if (Q.get('once') === '1') {
      tick(1 / 60, performance.now());
      state.oneShot = sample();
    } else startLoop();
  } else {
    showDiag(state.gl.reason || 'WebGL2 不可用');
  }
  state.bootMs = Math.round(performance.now() - boot0);
  state.ready = true;
  say(`✅ 就绪（${state.bootMs}ms）${r.ok ? '' : ' —— 但无 WebGL2，画面出不来（诊断见下）'}`);
  hud();
  return state;
}

function doAction(act) {
  if (act === 'more') { const h = $('#hud'); if (h) h.classList.toggle('open'); return; }
  if (act === 'view') { view.third = !view.third; state.third = view.third; }
  else if (act === 'style') setStyle(nextStyleKey());
  else if (act === 'shadow') { state.shadows = !state.shadows; setShadowSize(state.shadows ? level().shadow : 0); }
  else if (act === 'detail') state.detail = !state.detail;
  else if (act === 'radius-') setRadius(Math.max(300, state.radius - 300));
  else if (act === 'radius+') setRadius(Math.min(2000, state.radius + 300));
  else if (act === 'seed') { state.seedStr = 'ws3dgl-three-' + Math.floor(Math.random() * 1e6); regenerate(); }
  else if (act === 'bloom') { state.bloom = !state.bloom; applyStyle(); }
  else if (act === 'outline') { state.outline = !state.outlineOn; applyStyle(); }
  else if (act === 'dpr') {
    // 页面开关：在 3× / 2× / 1.5× / 1× 之间轮换（自适应永远不会自己动这个值）
    const cur = state.dprUi === null ? pickDpr({ devicePixelRatio: window.devicePixelRatio || 1, query: state.dprQuery }) : state.dprUi;
    const i = DPR_PRESETS.findIndex((v) => v <= cur + 1e-6);
    state.dprUi = DPR_PRESETS[(i + 1) % DPR_PRESETS.length];
    sizeRenderer();
  }
  else if (act === 'msaa') {
    const cur = state.msaaUi === null ? state.msaa : state.msaaUi;
    const i = MSAA_MODES.indexOf(cur);
    setMsaa(MSAA_MODES[(i + 1) % MSAA_MODES.length]);
  }
  else if (act === 'char') nextCharacter();
  else if (act === 'help') $('#help') && $('#help').classList.toggle('show');
  hud();
}

export function nextCharacter() {
  if (!avatar) return null;
  const c = avatar.next();
  // 骨骼角色的「角色」按钮 = 换动画（顺手把当前 clip 写在按钮上）；纸片人没有 clip 字段 ⇒ 显示的字符串与以前一模一样
  state.charName = c && c.clip ? `${c.name} · ${c.clip}` : (c && c.name) || state.charName;
  hud();
  return c;
}

/** 无头探针用：把状态吐成 JSON（字段名与 v1 对齐，方便 A/B 同一套断言） */
export function snapshot() {
  try { return buildSnapshot(); } catch (e) {
    // 探针最怕"快照函数自己抛异常"：那边只会看到一堆 undefined，像"页面全挂了"。
    // 所以这里必须把异常原文带出去。
    return { ready: state.ready, errors: (state.errors || []).concat(['snapshot 异常：' + (e && e.stack || e)]), snapshotError: String(e && e.message || e) };
  }
}

function buildSnapshot() {
  const r = state;
  // 描边参数：世界建好就问它要（那才是真正生效的），没建好时退到 palette 的兜底默认值
  const outlineNow = () => ((world && world.outlineSpec) ? world.outlineSpec() : { thickness: OUTLINE.thickness, color: OUTLINE.color });
  return {
    ready: r.ready, errors: r.errors, diag: r.diag,
    gl: r.gl ? { ok: r.gl.ok, reason: r.gl.reason || null, renderer: r.gl.renderer || null, lost: r.glLostCount > 0, lostCount: r.glLostCount, autoShadowOff: !!r.autoShadowOff } : null,
    api: Object.fromEntries(Object.entries(r.api).map(([k, v]) => [k, { ok: v.ok, status: v.status, ms: v.ms, bytes: v.bytes }])),
    data: r.data,
    city: r.city ? r.city.stats : null,
    dens: r.city ? densityReport((r.styled && r.styled.buildings) || [], r.radius) : null,
    mesh: r.mesh ? { tris: r.mesh.stats.trisTotal, verts: r.mesh.stats.verts, stats: r.mesh.stats } : null,
    perf: { fps: r.fps, frameMs: +r.frameMs.toFixed(2), bootMs: r.bootMs, gen: r.gen, draws: r.draws, path: r.path || null, outline: r.outlineOn,
      // 描边的粗细/颜色报**当前实际生效的那份**（来自风格档，world.outlineSpec()），不是 palette 里的兜底常量
      outlineExplicit: r.outline, outlineThickness: outlineNow().thickness, outlineColor: outlineNow().color, outlineWQuery: r.outlineW,
      toonFx: world && world.toonFx ? world.toonFx() : null,
      msaa: r.msaa, msaaUi: r.msaaUi, msaaQuery: r.msaaQuery, dprUi: r.dprUi, dprQuery: r.dprQuery, dprNative: r.dprNative,
      firstFrame: r.firstFrame || null, outlineDraws: r.outlineDraws === undefined ? null : r.outlineDraws,
      programsOutlineOk: r.programsOutlineOk === undefined ? null : r.programsOutlineOk,
      programsOutline: r.programsOutline ? r.programsOutline.length : null, programsOutlineSkipped: r.programsOutlineSkipped || null,
      shadowEvery: r.shadowEvery, shadowUpdates: r.shadowUpdates || 0, shadowArea, sharp: !!r.sharp,
      shadowTexel: +(2 * shadowArea / Math.max(1, (r.shadowSize || 1))).toFixed(4), quality: r.quality, qualityWhy: r.qualityWhy, level: level().name, dpr: r.dpr, shadowSize: r.shadowSize, texMs: r.texMs === undefined ? null : r.texMs, texClean: r.texClean === undefined ? null : r.texClean, stepOver: STEP_OVER, stuck: r.char ? r.char.stuck : null, escapes: r.char ? (r.char.escapes || 0) : null },
    programs: r.programs || null, programsOk: r.programsOk === undefined ? null : r.programsOk, programsError: r.programsError || null,
    shaderErrors: r.shaderErrors || [],
    layout: r.layout, walk: r.walk, sanitize: r.sanitize ? { removed: r.sanitize.removed, shrunk: r.sanitize.shrunk, gapFixed: r.sanitize.gapFixed } : null,
    lod: r.lod, once: Q.get('once') === '1', oneShot: r.oneShot || null,
    view: { style: r.style, third: r.third, bloom: r.bloomOn, pos: r.char ? [+r.char.pos.x.toFixed(1), +r.char.pos.z.toFixed(1)] : null, spawn: r.spawn, heading: r.char ? +((r.char.bodyYaw !== undefined ? r.char.bodyYaw : r.char.yaw) || 0).toFixed(2) : null },
    character: r.charState ? Object.assign({
      kind: r.charState.kind, name: charLabel(r.charState), emotion: r.charState.emotion,
      loaded: r.charState.loaded, width: r.charState.width, height: r.charState.height,
      layers: r.charState.layers, url: r.charState.url, error: r.charState.error,
    }, r.charState.kind === 'skinned' ? {
      // 骨骼角色额外报这几个数（探针的 skinned 断言看的就是它们）；billboard 下**一个字段都不多**，读数逐项不变
      clips: r.charState.clips, clipCount: r.charState.clipCount, clip: r.charState.clip,
      mixerTime: r.charState.mixerTime === undefined ? null : +r.charState.mixerTime.toFixed(3),
      skinnedMeshes: r.charState.skinnedMeshes, bones: r.charState.bones, meshes: r.charState.meshes,
      scale: +(+r.charState.scale).toFixed(4), rawHeight: +(+r.charState.rawHeight).toFixed(3),
      rawBox: r.charState.rawBox, heading: +(+(r.charState.heading || 0)).toFixed(2),
    } : {}) : null,
    shadows: r.shadows, detail: r.detail, variety: r.variety, glEverOk: !!r.glEverOk,
    shadow: r.shadowSnap,
    pick: r.pickTried || null, centerShift: r.centerShift,
  };
}

/** 像素采样：无头/真机都能证明"真的画出了东西"（不是白屏） */
export function sample() {
  if (!renderer) return null;
  const c = renderer.domElement;
  const W = Math.min(180, c.width), H = Math.min(180, c.height);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const t0 = performance.now();
  if (composer && bloomPass && bloomPass.enabled) composer.render(); else renderer.render(scene, camera);
  const renderMs = performance.now() - t0;
  try { ctx.drawImage(c, ((c.width - W) / 2) | 0, ((c.height - H) / 2) | 0, W, H, 0, 0, W, H); } catch (e) { return { error: String(e.message) }; }
  const px = ctx.getImageData(0, 0, W, H).data;
  let sum = [0, 0, 0], dark = 0;
  const uniq = new Set();
  for (let i = 0; i < W * H; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    sum[0] += r; sum[1] += g; sum[2] += b;
    if (r + g + b < 30) dark++;
    if (i % 7 === 0) uniq.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
  }
  const n = W * H;
  return { w: W, h: H, mean: sum.map((v) => +(v / n).toFixed(1)), distinct: uniq.size, darkRatio: +(dark / n).toFixed(3), renderMs: +renderMs.toFixed(2), glError: renderer.getContext().getError() };
}

if (typeof window !== 'undefined') {
  window.__WS3DTHREE__ = {
    state, snapshot, boot, setStyle, setRadius, regenerate, sample, setQuality, setMsaa,
    LEVELS, STYLE_ORDER, DPR_PRESETS, MSAA_MODES,
    help: () => $('#help') && $('#help').classList.add('show'),
  };
}
