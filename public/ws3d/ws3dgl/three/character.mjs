// character.mjs —— 角色**外观**工厂（主人定的第一版：立绘纸片人）。
//
// 接口是刻意做成"可替换"的：以后换 B 体素小人 / C glTF 低模 / D Live2D，
// **只换这个文件**，别处（main.mjs 里的调用点）一行都不用动。
//
//   const ch = createCharacter({ kind: 'billboard', assetsBase: './ws3dgl/assets/characters/' });
//   scene.add(ch.object3D);
//   ch.update(dt, { pos, heading, speed, moving, third, camPos, sunDir, groundY });
//   ch.setEmotion('平静'); ch.next(); ch.dispose();
//
// 纸片人的三条硬要求（主人提的）：只绕 Y 轴朝向相机（保持竖直，不跟着俯仰翻倒）、
// 近大远小按真实尺寸（站立高 ~1.7m，宽度按立绘宽高比算）、第一人称时隐藏（别把立绘糊在脸上）。
import {
  Group, Mesh, PlaneGeometry, MeshBasicMaterial, CanvasTexture, DoubleSide, Color, Vector3, SRGBColorSpace,
} from '../vendor/three.min.js';

/** 可选角色（目录名 / 显示名 / 立绘 / 已知情绪）。素材只从 assets/characters/ 读，不走 fork。 */
export const CHARACTERS = [
  { id: 'DeepSeek', name: 'DeepSeek', dir: 'DeepSeek', art: '正常', emotions: ['正常', '平静', '头像'] },
  { id: '诺一钦灵', name: '诺一钦灵', dir: '诺一钦灵', art: '正常', emotions: ['正常', '头像'] },
  { id: '风雪', name: '风雪', dir: '风雪', art: '正常', emotions: ['正常', '平静', '头像'] },
];

const STAND_H = 1.7;          // 站立高度（米）—— 对着底商门洞（3~4m）一比就知道合不合适

/** 1×1 透明占位贴图：图还没加载完也不会闪一块白 */
function placeholder() {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  c.getContext('2d').clearRect(0, 0, 2, 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;      // 立绘是 sRGB 图：不声明的话颜色会发灰
  return t;
}

/** 脚下软阴影贴图（径向渐变，中间深边缘透明） */
function blobTexture() {
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

/**
 * @param {object} opts
 *   kind        'billboard'（本版唯一实现；体素/glTF/Live2D 以后加在这里）
 *   assetsBase  立绘根目录（HTTP 相对路径，8788 直接服务）
 *   height      站立高度（米）
 *   layers      纸片层数：2 = 前面正常 + 后面一块压暗的（转身时有一点视差，比纯纸片立体一档）
 *   index       初始角色序号
 */
export function createCharacter(opts = {}) {
  const kind = opts.kind || 'billboard';
  const base = opts.assetsBase || './ws3dgl/assets/characters/';
  const H = opts.height || STAND_H;
  const layers = Math.max(1, Math.min(3, opts.layers === undefined ? 2 : opts.layers));
  let index = (opts.index || 0) % CHARACTERS.length;

  const group = new Group();
  group.name = 'character';
  const blob = blobTexture();
  const shadowMat = new MeshBasicMaterial({
    map: blob, transparent: true, opacity: 0.4, depthWrite: false, color: new Color('#0a0f18'),
  });
  const shadow = new Mesh(new PlaneGeometry(1, 1), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 1;
  group.add(shadow);

  const planes = [];
  const textures = [];
  for (let i = 0; i < layers; i++) {
    const tex = placeholder();
    textures.push(tex);
    const mat = new MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.04, side: DoubleSide,
      // 越靠后的层越暗（模拟厚度），最前面那层保持原色
      color: new Color(i === 0 ? 0xffffff : i === 1 ? 0x8a8f99 : 0x5d626b),
      depthWrite: i === 0,
    });
    const m = new Mesh(new PlaneGeometry(1, H), mat);
    m.position.set(0, H / 2, -i * 0.06);         // 沿本地 -Z 叠：本地 -Z 始终背对相机 ⇒ 视差跟视线一致
    planes.push(m);
    group.add(m);
  }

  const state = {
    kind, index, emotions: CHARACTERS[index].emotions.slice(),
    emotion: '正常', height: H, width: H, layers, loaded: false,
    url: '', error: null, faceCam: true,
  };

  /** 换立绘（URL 用相对路径拼，8788 直取；失败保留旧图并把原因记下来） */
  const load = (art) => {
    const ch = CHARACTERS[index];
    const url = `${base}${ch.dir}/${art}${/\.(webp|png|jpg)$/i.test(art) ? '' : '.webp'}`;
    state.url = url;
    state.emotion = art;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const aspect = img.width / Math.max(1, img.height);
      const w = H * aspect;
      state.width = +w.toFixed(3);
      state.loaded = true;
      state.error = null;
      for (const t of textures) { t.image = img; t.needsUpdate = true; }
      for (const p of planes) {
        p.geometry.dispose();
        p.geometry = new PlaneGeometry(w, H);
        p.position.set(0, H / 2, p.position.z);
      }
    };
    img.onerror = () => { state.error = '立绘取不到：' + url; };
    img.src = url;
  };
  load(CHARACTERS[index].art);

  const setEmotion = (name) => {
    if (state.emotions.indexOf(name) < 0) return false;
    load(name);
    return true;
  };
  const setIndex = (i) => {
    index = ((i % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
    state.index = index;
    state.emotions = CHARACTERS[index].emotions.slice();
    load(CHARACTERS[index].art);
    return CHARACTERS[index];
  };

  let t = 0;
  /**
   * 每帧更新。`s` 由 main.mjs 给：
   *   { pos:{x,z}, heading, speed, moving, third, camPos:{x,y,z}, sunDir:[x,y,z], groundY }
   */
  const update = (dt, s) => {
    t += dt;
    const cam = s.camPos || { x: 0, y: 0, z: 0 };
    const p = s.pos || { x: 0, z: 0 };
    group.position.set(p.x, s.groundY || 0, p.z);
    // 只绕 Y 轴朝向相机：立绘永远竖直，镜头俯仰不会把纸片"翻倒"
    if (state.faceCam) {
      const dx = cam.x - p.x, dz = cam.z - p.z;
      if (dx * dx + dz * dz > 1e-4) group.rotation.y = Math.atan2(dx, dz);
      else group.rotation.y = s.heading || 0;
    }
    const sp = Math.min(1, (s.speed || 0) / 4.6);
    const walk = Math.sin(t * 9.5 * Math.max(0.35, sp)) * sp;
    // 走路：上下起伏 + 左右微摆 + 前倾；站着：呼吸
    const bob = s.moving ? Math.abs(walk) * 0.055 : Math.sin(t * 1.7) * 0.012;
    const breathe = s.moving ? 1 : 1 + Math.sin(t * 1.7) * 0.012;
    for (const m of planes) {
      m.position.y = H / 2 + bob;
      m.rotation.z = s.moving ? walk * 0.045 : 0;
      m.rotation.x = s.moving ? -0.10 * sp : 0;
      m.scale.set(1, breathe, 1);
    }
    // 脚下软阴影：跟着光照方向偏一点，起伏大时缩一点
    const sd = s.sunDir || [0.4, 0.7, 0.5];
    const flat = Math.max(0.15, Math.hypot(sd[0], sd[2]) || 0.5);
    shadow.position.set(-sd[0] / flat * 0.3, 0.02, -sd[2] / flat * 0.3);
    const k = 1 - Math.min(0.35, bob);
    shadow.scale.set(state.width * 0.72 * k, state.width * 0.5 * k, 1);
    shadowMat.opacity = 0.24 + 0.22 * (1 - Math.min(1, Math.abs(sd[1] || 0.7)));
    // 第一人称：整个隐藏（别把立绘糊在脸上）
    group.visible = s.third !== false;
    return state;
  };

  const dispose = () => {
    for (const p of planes) { p.geometry.dispose(); p.material.dispose(); }
    for (const t2 of textures) t2.dispose();
    shadow.geometry.dispose(); shadowMat.dispose(); blob.dispose();
  };

  return {
    object3D: group, planes, shadow,
    update, setEmotion, setIndex, dispose, state,
    next: () => setIndex(index + 1),
    current: () => CHARACTERS[index],
    /** 以后加 B/C/D 时在 createCharacter 里分支（main.mjs 不用改） */
    kinds: ['billboard'],
  };
}

export { STAND_H, Vector3 };
