// skinned.mjs —— glTF **骨骼角色**工厂（character.mjs 的平替，两者可互换）。
//
// 为什么另起一个文件：立绘纸片人是"永远面向相机的一张图"，骨骼角色是"有朝向、有动画状态机、
// 要贴地缩放的实体"，塞进同一个文件只会互相绊脚。但**对外形状刻意与 character.mjs 的工厂对齐**：
//
//   const ch = createSkinnedCharacter({ model: '...glb', height: 1.7 });
//   scene.add(ch.object3D);
//   ch.update(dt, { pos, heading, speed, moving, third, camPos, sunDir, groundY });
//   ch.setEmotion('Walking'); ch.next(); ch.dispose();
//
// 开启方式：页面挂 `?char=skinned`。**不挂就是老的 billboard ⇒ 默认路径一个字节都不变。**
//
// 能纯算的东西全抽成纯函数放在文件上半部（GLB 容器解析 / 包围盒→缩放·贴地 / 最短弧插值 /
// clip 挑名字）—— 这些在 node 里就能断言，不用开浏览器（见 selftest.mjs 第 7 节）。
//
// ⚠️ 出厂的那个 glTF 里有 14 段动画，走 / 跑 / 站的名字见 CLIP_WANT；
//    模型是"骨架节点 + 两块真蒙皮手掌"，不是全身 SkinnedMesh —— 详见 three/README.md 的模型一节。
import {
  Group, Mesh, PlaneGeometry, MeshBasicMaterial, CanvasTexture, Color, Vector3, Box3,
  AnimationMixer, GLTFLoader, SRGBColorSpace,
} from '../vendor/three.min.js';

/** 出厂模型：4.6m 的机器人，自带 14 段动画（Idle / Walking / Running 都在）。路径相对 8788 的文档根。 */
export const DEFAULT_MODEL = './ws3dgl/assets/models/RobotExpressive.glb';
/** 站立高度（米）：与纸片人、摇杆、门洞（3~4m）同一套尺度 */
export const STAND_H = 1.7;
/** 动画状态 → 候选 clip 名（按顺序取第一个存在的；真名以 GLB 里解析出来的为准） */
export const CLIP_WANT = {
  idle: ['Idle', 'idle', 'IDLE', 'Standing', 'TPose'],
  walk: ['Walking', 'Walk', 'walk', 'WALK', 'Jog'],
  run: ['Running', 'Run', 'run', 'RUN', 'Sprint'],
};
/** 走路/跑步 clip 在 timeScale=1 时"一步跨多快"（米/秒）—— 用来让播放速度跟着真速度走，减少脚底打滑。
 *  ⚠️ 这是**估的**（本机没有真 GPU，看不到画面），真机上对着 ?strideWalk= / ?strideRun= 调。 */
export const STRIDE = { walk: 2.2, run: 5.6 };
/** 超过这个速度算跑（player.mjs：走 5.2 m/s，跑 = 5.2 × 2.3） */
export const RUN_AT = 7.0;
/** 交叉淡入淡出时长（秒） */
export const FADE = 0.22;

// ── 纯函数区（node 可测，不碰 DOM / 不碰 GL）───────────────────────────────────
const GLB_MAGIC = 0x46546c67;    // 'glTF'
const CHUNK_JSON = 0x4e4f534a;   // 'JSON'
const CHUNK_BIN = 0x004e4942;    // 'BIN\0'

/**
 * 解析 GLB 容器（12 字节头 + 若干 chunk），返回 { version, declared, json, bin, chunks }。
 * 坏输入**直接抛**（带人话原因）；调它的工厂会把异常转成 state.error，不让页面崩。
 */
export function parseGlbContainer(buf) {
  if (!buf) throw new Error('GLB 是空的');
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < 12) throw new Error(`GLB 太短（${u8.byteLength} 字节，光文件头就要 12）`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error(`不是 GLB（magic=0x${magic.toString(16).padStart(8, '0')}，应为 0x46546c67）`);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF 容器版本 ${version}，只认 2`);
  const declared = dv.getUint32(8, true);
  if (declared !== u8.byteLength) throw new Error(`GLB 头声明 ${declared} 字节，实际 ${u8.byteLength}（下载被截断？）`);
  let off = 12, json = null, bin = null;
  const chunks = [];
  while (off + 8 <= u8.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > u8.byteLength) throw new Error(`chunk 越界（off=${off} len=${len} 总长=${u8.byteLength}）`);
    const kind = type === CHUNK_JSON ? 'JSON' : type === CHUNK_BIN ? 'BIN' : `0x${type.toString(16)}`;
    chunks.push({ kind, len });
    if (type === CHUNK_JSON) {
      if (json) throw new Error('GLB 里有不止一个 JSON chunk');
      json = JSON.parse(new TextDecoder().decode(u8.subarray(start, start + len)));
    } else if (type === CHUNK_BIN) {
      bin = u8.subarray(start, start + len);
    }
    off = start + len + ((4 - (len % 4)) % 4);   // chunk 按 4 字节对齐
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk');
  return { version, declared, json, bin, chunks };
}

/** 从 glTF JSON 里数出"这个模型有什么"（动画名 / 蒙皮 / 关节 / 贴图）——纯读，不做几何运算。 */
export function glbInfo(json) {
  const g = json || {};
  const nodes = g.nodes || [], meshes = g.meshes || [], skins = g.skins || [];
  const clips = (g.animations || []).map((a, i) => a.name || `clip${i}`);
  const skinnedNodes = nodes.filter((n) => n.skin !== undefined);
  let prims = 0, skinnedPrims = 0, joints = 0;
  for (const n of nodes) {
    if (n.mesh === undefined || !meshes[n.mesh]) continue;
    for (const p of meshes[n.mesh].primitives || []) {
      prims++;
      if (p.attributes && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) skinnedPrims++;
    }
  }
  for (const s of skins) joints = Math.max(joints, (s.joints || []).length);
  return {
    clips, clipCount: clips.length,
    skinnedNodes: skinnedNodes.length, skinnedNames: skinnedNodes.map((n) => n.name || '(无名)'),
    skins: skins.length, joints, nodes: nodes.length, meshes: meshes.length,
    prims, skinnedPrims, materials: (g.materials || []).length,
    textures: (g.textures || []).length, images: (g.images || []).length,
    bones: nodes.filter((n) => n.isBone === true).length,
    generator: (g.asset || {}).generator || null,
  };
}

/** 一步到位：字节 → { 容器, 信息 }（selftest 与诊断面板都用它） */
export function parseGlbInfo(buf) {
  const c = parseGlbContainer(buf);
  return { container: { version: c.version, declared: c.declared, chunks: c.chunks }, info: glbInfo(c.json), json: c.json };
}

// 列主序 4×4 乘法（glTF 的 matrix 就是列主序）
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 节点的局部矩阵（有 matrix 就用 matrix，否则 TRS 合成） */
export function nodeMatrix(n) {
  if (!n) return IDENTITY4.slice();
  if (n.matrix) return n.matrix.slice();
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * 从 glTF JSON 算**绑定姿态下的包围盒**（accessor 的 min/max 过一遍节点变换）。
 * 这是纯 node 侧的"模型有多高、脚在哪"的判据（运行时更准的那份由 three 的 Box3 给）。
 * 返回 { min:[x,y,z], max:[x,y,z], nodes:参与统计的节点数 }；一个网格都没有就 min/max 全 null。
 */
export function boxFromGlbJson(json) {
  const g = json || {};
  const nodes = g.nodes || [], meshes = g.meshes || [], accessors = g.accessors || [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let used = 0;
  const walk = (i, parent) => {
    const n = nodes[i];
    if (!n) return;
    const M = mul4(parent, nodeMatrix(n));
    if (n.mesh !== undefined && meshes[n.mesh]) {
      for (const p of meshes[n.mesh].primitives || []) {
        const acc = accessors[p.attributes && p.attributes.POSITION];
        if (!acc || !acc.min || !acc.max) continue;
        used++;
        for (let cx = 0; cx < 2; cx++) {
          for (let cy = 0; cy < 2; cy++) {
            for (let cz = 0; cz < 2; cz++) {
              const v = [cx ? acc.max[0] : acc.min[0], cy ? acc.max[1] : acc.min[1], cz ? acc.max[2] : acc.min[2], 1];
              for (let r = 0; r < 3; r++) {
                const w = M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + M[12 + r] * v[3];
                if (w < min[r]) min[r] = w;
                if (w > max[r]) max[r] = w;
              }
            }
          }
        }
      }
    }
    for (const c of n.children || []) walk(c, M);
  };
  const roots = ((g.scenes || [])[g.scene || 0] || {}).nodes || [];
  for (const i of roots) walk(i, IDENTITY4);
  return used ? { min, max, nodes: used } : { min: null, max: null, nodes: 0 };
}

/**
 * 包围盒 → "缩放 + 贴地"的解（**本模块的核心数学**）。
 * 约定：脚底 = y 最小处贴到 0，身高 = targetH，水平方向按包围盒中心归零（围着自身中心转身）。
 * 返回的 offset* 是**缩放后**的净位移，可以直接塞给 `inner.position`；
 * centerX / centerZ / minY 是原始单位，塞给 `root.position.sub(...)` 用。
 */
export function fitToGround(min, max, targetH = STAND_H) {
  if (!min || !max) throw new Error('没有包围盒：算不出缩放（模型里一个网格都没有？）');
  const rawH = max[1] - min[1];
  if (!(rawH > 1e-6)) throw new Error(`包围盒高度是 ${rawH}（模型塌了？）`);
  if (!(targetH > 1e-6)) throw new Error(`目标身高 ${targetH} 不合法`);
  const scale = targetH / rawH;
  const centerX = (min[0] + max[0]) / 2, centerZ = (min[2] + max[2]) / 2;
  return {
    scale, height: targetH, rawHeight: rawH,
    minY: min[1], centerX, centerZ,
    offsetX: -centerX * scale, offsetY: -min[1] * scale, offsetZ: -centerZ * scale,
  };
}

/** 角度按最短弧插值（a→b，t∈[0,1]）—— 转身不能走远路（会原地转一整圈） */
export function angleLerp(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * Math.max(0, Math.min(1, t));
}

/** 从 clip 名单里按候选表挑一个（大小写不敏感；挑不到返回 null） */
export function pickClip(names, want) {
  const list = names || [];
  const cands = Array.isArray(want) ? want : CLIP_WANT[want] || [];
  for (const c of cands) {
    const hit = list.find((n) => n === c) || list.find((n) => String(n).toLowerCase() === String(c).toLowerCase());
    if (hit) return hit;
  }
  for (const c of cands) {
    const hit = list.find((n) => String(n).toLowerCase().includes(String(c).toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** 数值兜底：URL 参数写歪时 main.mjs 的 num() 会给 NaN —— 不许让一个手滑的参数把角色算没了 */
const finite = (v, d) => (Number.isFinite(v) ? v : d);

/** 加载失败时给人看的一句话（不抛异常 —— 失败也要"优雅"，页面继续跑） */
export function loadErrorText(url, err) {
  const why = err && (err.message || err.statusText || err.type || String(err));
  return `模型取不到或解析不了：${url}（${why || '未知原因'}）`;
}

// ── 工厂 ─────────────────────────────────────────────────────────────────────
/** 脚下软阴影贴图（径向渐变）—— 和纸片人同一套观感；node 里没 canvas 就返回 null */
function blobTexture() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new CanvasTexture(c);
}

/** 默认加载器：GLTFLoader 取字节 → onOk(gltf) / onErr(错误对象)。裁剪产物里没有它就直接报错，不抛。 */
function gltfLoad(url, onOk, onErr) {
  if (typeof GLTFLoader !== 'function') {
    onErr(new Error('这份 three 裁剪产物里没有 GLTFLoader（重跑 vendor/build-three.sh 就有了）'));
    return;
  }
  try {
    new GLTFLoader().load(url, onOk, undefined, (e) => onErr(e || new Error('GLTFLoader 报错')));
  } catch (e) { onErr(e); }
}

/**
 * 建一个骨骼角色。返回的东西与 character.mjs 的工厂**同形**：
 *   { object3D, update, setEmotion, setIndex, dispose, state, next, current, kinds }
 * 额外多一个 `mixer`（探针要看 mixer.time 有没有推进）。
 *
 * @param {object} opts
 *   model       GLB 路径（默认 DEFAULT_MODEL）
 *   height      站立高度（米，默认 1.7）
 *   name        显示名（默认取文件名）
 *   yawOffset   模型自身朝向修正（弧度）：模型正面不是 +Z 时用它掰（默认 0）
 *   strideWalk / strideRun  走路·跑步 clip 的"基准速度"（米/秒），用来算 timeScale
 *   load        注入加载器（签名 (url, onOk, onErr)）—— selftest 用假加载器，不联外网
 */
export function createSkinnedCharacter(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  // 这几个数是从 URL 参数来的：charH / charYaw / strideWalk / strideRun 写歪了就是 NaN（parseFloat 的锅）
  const H = Math.max(0.1, finite(opts.height, STAND_H));
  const name = opts.name || String(model).split('/').pop().replace(/\.glb$/i, '') || 'skinned';
  const yawOffset = finite(opts.yawOffset, 0);
  const stride = { walk: Math.max(0.1, finite(opts.strideWalk, STRIDE.walk)), run: Math.max(0.1, finite(opts.strideRun, STRIDE.run)) };
  const load = opts.load || gltfLoad;

  const group = new Group();
  group.name = 'character';
  const inner = new Group();          // 缩放 + 转身放这一层（软阴影别跟着缩）
  inner.name = 'characterInner';
  group.add(inner);

  const blob = blobTexture();
  let shadow = null, shadowMat = null;
  if (blob) {
    shadowMat = new MeshBasicMaterial({
      map: blob, transparent: true, opacity: 0.4, depthWrite: false, color: new Color('#0a0f18'),
    });
    shadow = new Mesh(new PlaneGeometry(1, 1), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    group.add(shadow);
  }

  const state = {
    kind: 'skinned', index: 0, name, emotion: '', url: model,
    height: H, width: 0.62, layers: 1, loaded: false, error: null,
    faceCam: false, clips: [], clip: null, clipCount: 0, mixerTime: 0,
    slots: { idle: null, walk: null, run: null }, slot: 'idle',
    skinnedMeshes: 0, bones: 0, meshes: 0,
    scale: 1, rawHeight: 0, rawBox: null, stride, yawOffset, heading: 0, shadow: !!blob,
  };

  let mixer = null;
  const actions = Object.create(null);
  let active = null;
  let root = null;

  /** 交叉淡入淡出：旧 action fadeOut、新 action fadeIn（walk↔run 之间把相位对齐，避免换档时跳一下） */
  const fadeTo = (want, dur = FADE) => {
    const next = actions[want];
    if (!next || next === active) return false;
    const prev = active;
    next.reset();
    next.setEffectiveWeight(1);
    next.enabled = true;
    if (prev && (want === 'run' || want === 'walk')) {
      const a = prev.getClip().duration, b = next.getClip().duration;
      if (a > 0 && b > 0) next.time = (prev.time % a) / a * b;   // 同相位换档
    }
    // 首帧那次用 dur=0（直接满权重）—— fadeIn(0) 会写出一条零宽度的插值区间，three 那边会算出 NaN
    if (dur > 0) next.fadeIn(dur); else next.setEffectiveWeight(1);
    next.play();
    if (prev) { if (dur > 0) prev.fadeOut(dur); else prev.setEffectiveWeight(0); }
    active = next;
    state.clip = want;
    return true;
  };

  const onLoaded = (gltf) => {
    try {
      root = gltf && (gltf.scene || (gltf.scenes || [])[0]);
      if (!root) { state.error = loadErrorText(model, new Error('glTF 里没有 scene')); return; }
      // ① 数一数拿到了什么（探针要这几个数）
      root.traverse((o) => {
        if (o.isSkinnedMesh) { state.skinnedMeshes++; o.frustumCulled = false; }   // 蒙皮网格的包围球不跟着骨骼走，关掉视锥剔除免得走两步就消失
        else if (o.isMesh) state.meshes++;
        if (o.isBone) state.bones++;
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
      });
      // ② 绑定姿态下的包围盒 → 缩放 + 贴地（**脚 y=0、身高 1.7、绕着自身中心转**）
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      const raw = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
      state.rawBox = { min: raw.min.map((v) => +v.toFixed(4)), max: raw.max.map((v) => +v.toFixed(4)) };
      const fit = fitToGround(raw.min, raw.max, H);
      root.position.sub(new Vector3(fit.centerX, fit.minY, fit.centerZ));   // 原始单位下归零：脚在 0、中心在原点
      inner.scale.setScalar(fit.scale);
      inner.add(root);
      state.scale = fit.scale;
      state.rawHeight = fit.rawHeight;
      // ③ 动画状态机
      mixer = new AnimationMixer(root);
      for (const clip of gltf.animations || []) actions[clip.name] = mixer.clipAction(clip);
      state.clips = Object.keys(actions);
      state.clipCount = state.clips.length;
      // 状态 → clip 名 的映射（**必须按名字查**：actions 的键是 clip 名 'Walking'，不是状态键 'walk'）
      state.slots = {
        idle: pickClip(state.clips, 'idle'), walk: pickClip(state.clips, 'walk'), run: pickClip(state.clips, 'run'),
      };
      const start = state.slots.idle || state.clips[0] || null;
      if (start) fadeTo(start, 0);
      state.loaded = true;
      state.error = null;
    } catch (e) {
      state.error = loadErrorText(model, e);   // 解析/装配炸了也不许把页面带走
      state.loaded = false;
    }
  };
  const onFailed = (err) => { state.error = loadErrorText(model, err); state.loaded = false; };
  load(model, onLoaded, onFailed);

  /**
   * 每帧更新，`s` 与 character.mjs 完全同一套：
   *   { pos:{x,z}, heading, speed, moving, third, camPos:{x,y,z}, sunDir:[x,y,z], groundY }
   */
  const update = (dt, s = {}) => {
    const step = Math.max(0, Math.min(0.25, finite(dt, 0)));   // dt 也可能是 NaN/离谱值（切后台回来那种）
    const p = s.pos || { x: 0, z: 0 };
    group.position.set(finite(p.x, 0), finite(s.groundY, 0), finite(p.z, 0));
    const speed = Math.max(0, finite(s.speed, 0));
    const moving = s.moving !== undefined ? !!s.moving : speed > 0.25;

    // 朝向：player.mjs 的 bodyYaw 已经用 turnToward 平滑过了 ⇒ 这里直接用，不再叠一层迟滞（会变成双倍延迟）
    if (moving && Number.isFinite(s.heading)) {
      state.heading = s.heading;
      inner.rotation.y = s.heading + yawOffset;
    }

    // 动画状态：站 / 走 / 跑 三档交叉淡入；播放速度跟真速度走
    if (mixer) {
      const slot = !moving ? 'idle' : (speed >= RUN_AT && state.slots.run ? 'run' : 'walk');
      const use = state.slots[slot] || state.slots.walk || state.slots.idle || state.clips[0];
      if (use && use !== state.clip) fadeTo(use);
      state.slot = slot;
      if (active) {
        const base = slot === 'run' ? stride.run : stride.walk;
        active.setEffectiveTimeScale(slot === 'idle' ? 1 : Math.max(0.35, Math.min(2.2, speed / Math.max(0.1, base))));
      }
      mixer.update(step);
      state.mixerTime = mixer.time;
    }

    // 脚下软阴影：跟 billboard 同一套（跟着太阳偏一点、起伏时缩一点）
    if (shadow) {
      const sd = s.sunDir || [0.4, 0.7, 0.5];
      const flat = Math.max(0.15, Math.hypot(sd[0], sd[2]) || 0.5);
      shadow.position.set(-sd[0] / flat * 0.3, 0.02, -sd[2] / flat * 0.3);
      const w = state.width * (state.loaded ? 1 : 0.7) * (H / STAND_H);
      shadow.scale.set(w * 0.72, w * 0.5, 1);
      shadowMat.opacity = 0.24 + 0.22 * (1 - Math.min(1, Math.abs(sd[1] || 0.7)));
    }
    // 第一人称：整个隐藏（和纸片人一致，别把后脑勺糊在镜头上）
    group.visible = s.third !== false;
    return state;
  };

  const setIndex = (i) => {
    if (!state.clips.length) return null;
    const n = state.clips.length;
    const idx = ((i % n) + n) % n;
    state.index = idx;
    fadeTo(state.clips[idx]);
    state.emotion = state.clips[idx];
    return { name, clip: state.clips[idx] };
  };
  /** 换表情 → 对骨骼角色就是**换动画**（名字对得上就切，对不上返回 false，不炸） */
  const setEmotion = (clipName) => (actions[clipName] ? (fadeTo(clipName), state.emotion = clipName, true) : false);

  const dispose = () => {
    try { if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); } } catch { /* 已经拆过就算了 */ }
    if (root) root.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) { if (m.map && m.map.dispose) m.map.dispose(); if (m.dispose) m.dispose(); }
    });
    if (shadow) { shadow.geometry.dispose(); shadowMat.dispose(); }
    if (blob) blob.dispose();
    group.clear();
  };

  return {
    object3D: group, group, inner, shadow,
    get mixer() { return mixer; },
    update, setEmotion, setIndex, dispose, state,
    next: () => setIndex(state.index + 1),
    current: () => ({ id: name, name, model, clips: state.clips.slice() }),
    kinds: ['skinned'],
  };
}
