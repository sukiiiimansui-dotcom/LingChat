// world.mjs —— 几何缓冲 → three 对象（材质 / 网格 / 实例化 / LOD 分块）。
//
// 分工：build.mjs 只出平铺数组，这里把它变成 BufferGeometry + 材质并挂进场景。
// **draw call 是这一层的头号 KPI**：每个材质桶一个网格（常显 11 个），细节按"格"分块
// （格边长取 build.mjs 的真实值 `opts.cell`，默认 256m；只有玩家附近那几格可见，带滞后带）。
import {
  BufferGeometry, BufferAttribute, Mesh, InstancedMesh, Matrix4, Quaternion, Vector3, Color, Group,
  MeshStandardMaterial, MeshToonMaterial, MeshBasicMaterial, PointsMaterial, Points, DoubleSide, FrontSide,
  AdditiveBlending, CanvasTexture, DataTexture, SRGBColorSpace, RepeatWrapping, LinearFilter,
  LinearMipmapLinearFilter, RedFormat, UnsignedByteType,
  CylinderGeometry, IcosahedronGeometry, ConeGeometry, BoxGeometry, CircleGeometry, PlaneGeometry,
  MathUtils,
} from '../vendor/three.min.js';
import { buildTextureSet, TILE } from './textures.mjs';
import { TIERS, GROUND, ACCENT, toRgb, shade, TOON, toonGradientData, OUTLINE } from './palette.mjs';
import { patchToonFragment, toonUniformValues } from './toon.mjs';

/** 半卡通只给"楼体"这五个桶：地面/屋面/道具保持 Standard（大面积色阶容易显脏，量完再说） */
export const TOON_BUCKETS = ['wall0', 'wall1', 'wall2', 'wall3', 'shop'];

/**
 * 桶 × 风格 → 材质种类。**纯函数**：自检直接在 node 里断言（不需要 GPU、不需要贴图）。
 * 只有风格档显式写了 `toon:true`（= 二次元档）且桶在楼体那五个里，才走 MeshToonMaterial。
 */
export function bucketKindFor(bucket, style) {
  return (style && style.toon && TOON_BUCKETS.includes(bucket)) ? 'toon' : 'standard';
}

/** 4 级渐变图（64×1 的 DataTexture）：MeshToonMaterial 靠它出"有色阶但不硬边"的半卡通 */
export function makeToonGradientMap({ levels = TOON.levels, soft = TOON.soft, size = TOON.size } = {}) {
  const data = toonGradientData({ levels, soft, n: size });
  const t = new DataTexture(data, data.length, 1, RedFormat, UnsignedByteType);
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * 半卡通材质的 uniform（**每个材质一套**，所以在按 uuid 缓存程序之后改值仍然生效）。
 * 全部是只在 MeshToonMaterial 上编译进去的东西：写实那两档用的是 MeshStandardMaterial，
 * 连这段 GLSL 都不会被编译 —— "写实档一个字节不变"是从这里开始的。
 */
export function makeToonUniforms() {
  const v3 = (x, y, z) => new Vector3(x, y, z);
  return {
    uToonOn: { value: 0 },
    uToonSunDirView: { value: v3(0, 1, 0) },        // 太阳方向（view space），每帧由 main 更新
    uToonLitTint: { value: v3(1, 1, 1) }, uToonLitStrength: { value: 0 },
    uToonShadowTint: { value: v3(1, 1, 1) }, uToonShadowStrength: { value: 0 },
    uToonAmbientTint: { value: v3(1, 1, 1) }, uToonAmbientStrength: { value: 0 },
    uToonRimColor: { value: v3(1, 1, 1) }, uToonRimThreshold: { value: 1 },
    uToonRimStrength: { value: 0 }, uToonRimPower: { value: 1 },
  };
}

/**
 * 建一个桶的材质（**运行时用的就是这个工厂**，自检拿它断言 instanceof 是哪种）。
 * toon 保留 map / emissiveMap / vertexColors（每栋色偏），但不吃 roughness/metalness（Toon 没有这两项）。
 *
 * toon 这一支额外挂 `onBeforeCompile`：把分色染色与边缘光**补进 three 自己的 toon 片元着色器**
 * （不换 ShaderMaterial ⇒ 光照/阴影/雾/环境贴图/顶点色全都照旧，只多一段算式；
 * 补丁本身在 toon.mjs 里，是纯字符串函数，node 里能断言）。
 */
export function makeBucketMaterial(kind, spec = {}) {
  const base = { map: spec.map || null, vertexColors: true };
  if (spec.emissiveMap) {
    base.emissiveMap = spec.emissiveMap;
    base.emissive = new Color(1, 1, 1);
    base.emissiveIntensity = spec.emissiveIntensity || 0;
  }
  if (kind === 'toon') {
    const m = new MeshToonMaterial(Object.assign(base, { gradientMap: spec.gradientMap || null }));
    const uniforms = makeToonUniforms();
    m.userData.toonUniforms = uniforms;
    m.onBeforeCompile = (shader) => {
      const r = patchToonFragment(shader.fragmentShader);
      // 锚点没找到就**明着记下来**：three 升级换了 chunk 名时，画面上只会"染色悄悄没了"
      if (!r.ok) m.userData.toonPatchMissing = r.missing;
      shader.fragmentShader = r.src;
      Object.assign(shader.uniforms, uniforms);
    };
    // 补丁的开关只跟 uniform 走（不换源码）⇒ 程序缓存键不用带它，但带上更稳妥
    m.customProgramCacheKey = () => 'wsToon';
    return m;
  }
  return new MeshStandardMaterial(Object.assign(base, {
    roughness: spec.roughness === undefined ? 0.9 : spec.roughness,
    metalness: spec.metalness === undefined ? 0 : spec.metalness,
  }));
}

/**
 * 分块显隐的**滞后带**（hysteresis）：进用阈值 T，出用 T*hys。
 * 为什么是 1.12：一个格子 256m，站在阈值线上（真机上就是贴着一条看不见的圈走）时，
 * 0.35m/帧的抖动会把 T 两侧来回跨 —— 没有滞后就是"一块一块地闪"。12% 的带子在近档
 * （270m）上是 32m、在中档（640m）上是 77m，够盖住走位的抖动，又不至于"该消失的还赖着"。
 */
export const LOD_HYSTERESIS = 1.12;

/**
 * 分块记录：meshData.chunks（build.mjs 的产物）→ 带 AABB 与可见状态的记录。
 * **格边长取真的**：`opts.cell` 显式优先，其次读 `buildWorld` 写进 `stats.opts.cell` 的那个数。
 * （以前这里硬编码 256：build 那边一换 cell，距离这把尺子就悄悄错了，画面上只会看到"开关位置不对"。）
 * 纯逻辑、不 import three ⇒ `selftest_shimmer.mjs` 能直接在 node 里量翻转次数。
 */
export function resolveChunkRecords(meshData, opts = {}) {
  const fromStats = meshData && meshData.stats && meshData.stats.opts ? Number(meshData.stats.opts.cell) : NaN;
  const cell = Number(opts.cell) > 0 ? Number(opts.cell) : (fromStats > 0 ? fromStats : 256);
  const chunks = ((meshData && meshData.chunks) || []).map((c) => {
    let i = Number.isFinite(c.i) ? c.i : null;
    let j = Number.isFinite(c.j) ? c.j : null;
    if (i === null || j === null) {                       // 记录里没带 i/j：退回解析 key（形如 "-2_3"）
      const m = /^(-?\d+)_(-?\d+)$/.exec(String(c.key));
      if (m) { i = Number(m[1]); j = Number(m[2]); }
    }
    if (i === null || j === null) { i = Math.floor(c.cx / cell); j = Math.floor(c.cz / cell); }
    return {
      key: c.key, i, j, cx: c.cx, cz: c.cz,
      x0: i * cell, z0: j * cell, x1: (i + 1) * cell, z1: (j + 1) * cell,
      buildings: c.buildings, src: c,
      mid: null, near: null, midVisible: false, nearVisible: false,
      wasNear: false, wasMid: false,
    };
  });
  return { cell, chunks };
}

/** 格子上离这个点最近的那个点（AABB 的 clamp；点在格子里就是它自己） */
export function closestPointOnChunk(c, px, pz) {
  return [Math.min(Math.max(px, c.x0), c.x1), Math.min(Math.max(pz, c.z0), c.z1)];
}

/** 到格子 **AABB** 的距离（点在格子里 = 0）——比"中心距离减 0.707*边长"准：那个是拿对角线钝角当距离用 */
export function chunkDistanceXZ(c, px, pz) {
  const q = closestPointOnChunk(c, px, pz);
  const dx = px - q[0], dz = pz - q[1];
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * 每帧的整格显隐（纯逻辑，不碰 three ⇒ node 里能直接量"翻转次数"）。
 * 滞回：**进**用 lodNear/lodMid，**出**用 lodNear*hys / lodMid*hys ⇒ 站在阈值线上来回走不再反复开关。
 * 返回的三档仍然是**楼数**（HUD `#h-lod` 的口径不许变）。
 */
export function lodPlan(chunks, px, pz, lodNear, lodMid, detail, out = { near: 0, mid: 0, far: 0 }, hys = LOD_HYSTERESIS) {
  out.near = 0; out.mid = 0; out.far = 0;
  for (const c of chunks) {
    const d = chunkDistanceXZ(c, px, pz);
    const inNear = !!(detail && d < (c.wasNear ? lodNear * hys : lodNear));
    const inMid = d < (c.wasMid ? lodMid * hys : lodMid) || inNear;   // "近 ⇒ 中"这条不变式照旧
    c.wasNear = inNear; c.wasMid = inMid;
    c.nearVisible = inNear; c.midVisible = inMid;
    if (c.near) c.near.visible = inNear;
    if (c.mid) c.mid.visible = inMid;
    if (inNear) out.near += c.buildings;
    else if (inMid) out.mid += c.buildings;
    else out.far += c.buildings;
  }
  return out;
}

/** 几何缓冲 → BufferGeometry（顶点色是必须的：一整条街的色差全靠它） */
export function toGeometry(buf) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(buf.position, 3));
  g.setAttribute('normal', new BufferAttribute(buf.normal, 3));
  g.setAttribute('uv', new BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new BufferAttribute(buf.color, 3));
  g.setIndex(new BufferAttribute(buf.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** 贴图统一设置（各向异性由渲染器能力决定；重复平铺 + mipmap） */
function tune(t, maxAniso = 4) {
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * 建世界。
 * @returns {{ group, materials, chunkMeshes, update, setStyle, stats, dispose, pickBuckets }}
 */
export function createWorld(meshData, opts = {}) {
  const maxAniso = opts.maxAniso || 4;
  let texClean = !!opts.clean;          // 当前贴图是哪一档（写实 / 干净鲜艳）；切风格时按需重建
  let texMs = 0;
  const tTex = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  let tex = buildTextureSet({ clean: texClean });

  const materials = {};
  // 楼体五个桶各备**两套材质**（标准 / 半卡通），切风格时只换 mesh.material 指针：
  // 两套都建出来只是几个对象，省掉了"切档时重建材质 + 重编译着色器"的那一下卡顿。
  const gradientMap = makeToonGradientMap();
  const stdMats = {}, toonMats = {};
  // 楼体四档：贴图 + 自发光贴图（夜里同一张贴图的"亮窗层"被推上来）
  tex.facades.forEach((f, i) => {
    const spec = { map: f.map, emissiveMap: f.emissiveMap, roughness: TIERS[i].roughness, metalness: TIERS[i].metalness, gradientMap };
    stdMats['wall' + i] = makeBucketMaterial('standard', spec);
    toonMats['wall' + i] = makeBucketMaterial('toon', spec);
  });
  {
    const spec = { map: tex.shop.map, emissiveMap: tex.shop.emissiveMap, roughness: 0.7, metalness: 0.05, gradientMap };
    stdMats.shop = makeBucketMaterial('standard', spec);
    toonMats.shop = makeBucketMaterial('toon', spec);
  }
  Object.assign(materials, stdMats);
  /**
   * 描边（OutlineEffect）只给楼体五个桶：
   * 它的默认行为是"遍历到的每个材质都描一圈"，所以其余材质必须显式打上 `visible:false`，
   * 否则天空球、树、路灯、地面全会描边。开不开由 setOutline() 翻 `visible`。
   */
  const outlineParams = (visible) => ({ visible, thickness: OUTLINE.thickness, color: toRgb(OUTLINE.color), alpha: 1 });
  for (const bucket of TOON_BUCKETS) {
    for (const set2 of [stdMats, toonMats]) if (set2[bucket]) set2[bucket].userData.outlineParameters = outlineParams(false);
  }
  materials.roof = new MeshStandardMaterial({ map: tex.roof, vertexColors: true, roughness: 0.95, metalness: 0.0 });
  materials.asphalt = new MeshStandardMaterial({ map: tex.asphalt, vertexColors: true, roughness: 0.96, metalness: 0.0 });
  materials.asphaltWide = new MeshStandardMaterial({ map: tex.asphaltWide, vertexColors: true, roughness: 0.96, metalness: 0.0 });
  materials.sidewalk = new MeshStandardMaterial({ map: tex.sidewalk, vertexColors: true, roughness: 0.92, metalness: 0.0 });
  materials.ground = new MeshStandardMaterial({ map: tex.ground, vertexColors: true, roughness: 1.0, metalness: 0.0 });
  materials.paint = new MeshStandardMaterial({
    color: new Color(GROUND.paint), vertexColors: true, roughness: 0.75,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  // 女儿墙/水箱/天线/坡顶/车辆：一种平色材质 + 顶点色（一桶 = 一次 draw call）
  materials.prop = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04, side: FrontSide });
  materials.manhole = new MeshStandardMaterial({
    color: new Color(shade(GROUND.metal, 0.42)), roughness: 0.7, metalness: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  materials.bark = new MeshStandardMaterial({ map: tex.bark, roughness: 1.0 });
  materials.leaf = new MeshStandardMaterial({ color: new Color(GROUND.leafA), vertexColors: false, roughness: 1.0 });
  materials.leaf2 = new MeshStandardMaterial({ color: new Color(GROUND.leafB), roughness: 1.0 });
  materials.lampPole = new MeshStandardMaterial({ color: new Color('#3c4045'), roughness: 0.6, metalness: 0.3 });
  materials.lampHead = new MeshStandardMaterial({
    color: new Color(ACCENT.lamp), emissive: new Color(ACCENT.lamp), emissiveIntensity: 0, roughness: 0.4,
  });
  materials.glow = new PointsMaterial({
    map: tex.glow, size: 7.5, sizeAttenuation: true, transparent: true, opacity: 0,
    blending: AdditiveBlending, depthWrite: false, color: new Color(ACCENT.lamp),
  });

  /**
   * 把某一档贴图接到全部材质上（写实 ↔ 干净鲜艳两档之间切）。
   * 建世界时调一次；之后**只在切到另一档风格时**才调 —— 干净档的贴图是懒生成的，
   * 从没切过去就一个字节都不建（手机内存只留当前这一档）。
   */
  const applyTextures = (set) => {
    for (const f of set.facades) { tune(f.map, maxAniso); tune(f.emissiveMap, maxAniso); }
    tune(set.shop.map, maxAniso); tune(set.shop.emissiveMap, maxAniso);
    for (const k of ['roof', 'asphalt', 'asphaltWide', 'sidewalk', 'ground', 'bark']) tune(set[k], maxAniso);
    set.glow.colorSpace = SRGBColorSpace;
    for (const bucket of TOON_BUCKETS) {                       // 楼体五个桶：两套材质都要换贴图
      const i = bucket === 'shop' ? -1 : Number(bucket.slice(4));
      const src = bucket === 'shop' ? set.shop : set.facades[i];
      for (const set2 of [stdMats, toonMats]) {
        const m = set2[bucket];
        if (!m) continue;
        m.map = src.map; m.emissiveMap = src.emissiveMap; m.needsUpdate = true;
      }
    }
    const pairs = [['roof', 'roof'], ['asphalt', 'asphalt'], ['asphaltWide', 'asphaltWide'],
      ['sidewalk', 'sidewalk'], ['ground', 'ground'], ['bark', 'bark'], ['glow', 'glow']];
    for (const [bucket, key] of pairs) {
      const m = materials[bucket];
      if (!m) continue;
      m.map = set[key];
      m.needsUpdate = true;
    }
  };
  applyTextures(tex);

  const casters = new Set(['wall0', 'wall1', 'wall2', 'wall3', 'shop', 'roof', 'prop']);
  const receivers = new Set(['wall0', 'wall1', 'wall2', 'wall3', 'shop', 'roof', 'prop', 'asphalt', 'asphaltWide', 'sidewalk', 'ground', 'paint']);

  const group = new Group();
  const meshes = [];
  const meshByBucket = new Map();
  for (const [bucket, buf] of Object.entries(meshData.base)) {
    const mat = materials[bucket];
    if (!mat) continue;
    const m = new Mesh(toGeometry(buf), mat);
    m.name = bucket;
    meshByBucket.set(bucket, m);
    m.castShadow = casters.has(bucket);
    m.receiveShadow = receivers.has(bucket);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    meshes.push(m);
  }

  // ── 实例化：树 / 路灯 / 井盖 ────────────────────────────────────────────────
  const inst = meshData.instanced;
  const tmpM = new Matrix4(), tmpQ = new Quaternion(), tmpV = new Vector3(), tmpS = new Vector3();
  const instanced = [];
  const addInstanced = (geo, mat, list, prep, cast = false) => {
    if (!list.length) return null;
    const im = new InstancedMesh(geo, mat, list.length);
    const col = new Color();
    list.forEach((it, i) => {
      prep(it, tmpV, tmpQ, tmpS, col);
      tmpM.compose(tmpV, tmpQ, tmpS);
      im.setMatrixAt(i, tmpM);
      if (col) im.setColorAt(i, col);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = cast;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    im.frustumCulled = true;
    instanced.push(im);
    return im;
  };
  const AXIS_Y = new Vector3(0, 1, 0);
  const setY = (rad) => { tmpQ.setFromAxisAngle(AXIS_Y, rad); };
  // 树干（先平移，让"从地面长出来"这件事由缩放中心决定）
  const trunkGeo = new CylinderGeometry(0.14, 0.22, 1, 5);
  trunkGeo.translate(0, 0.5, 0);
  const leafGeoA = new IcosahedronGeometry(1, 0);
  const leafGeoB = new ConeGeometry(1, 1.6, 7);
  leafGeoB.translate(0, 0.4, 0);
  const treesA = inst.trees.filter((t) => t.species === 0);
  const treesB = inst.trees.filter((t) => t.species === 1);
  addInstanced(trunkGeo, materials.bark, inst.trees, (t, v, q, s, c) => {
    v.set(t.x, 0, t.z); setY(t.rot); s.set(1, t.h * 0.5, 1); c.setRGB(1, 1, 1);
  }, true);
  addInstanced(leafGeoA, materials.leaf, treesA, (t, v, q, s, c) => {
    v.set(t.x, t.h * 0.66, t.z); setY(t.rot); s.set(t.r, t.r * 0.95, t.r);
    const g = t.tint; c.setRGB(0.32 * g, 0.52 * g, 0.24 * g);
  }, true);
  addInstanced(leafGeoB, materials.leaf2, treesB, (t, v, q, s, c) => {
    v.set(t.x, t.h * 0.42, t.z); setY(t.rot); s.set(t.r * 0.92, t.h * 0.62, t.r * 0.92);
    const g = t.tint; c.setRGB(0.26 * g, 0.42 * g, 0.22 * g);
  }, true);
  // 路灯：杆 + 灯头（共用同一批实例矩阵）
  const poleGeo = new CylinderGeometry(0.07, 0.11, 1, 6);
  poleGeo.translate(0, 0.5, 0);
  const headGeo = new BoxGeometry(0.62, 0.16, 0.26);
  headGeo.translate(0, 0, 0.34);
  addInstanced(poleGeo, materials.lampPole, inst.lamps, (l, v, q, s, c) => {
    v.set(l.x, 0, l.z); setY(l.rot); s.set(1, 5.6, 1); c.setRGB(1, 1, 1);
  }, true);
  addInstanced(headGeo, materials.lampHead, inst.lamps, (l, v, q, s, c) => {
    v.set(l.x, 5.5, l.z); setY(l.rot); s.set(1, 1, 1); c.setRGB(1, 1, 1);
  }, false);
  // 井盖
  const mhGeo = new CircleGeometry(1, 8);
  mhGeo.rotateX(-Math.PI / 2);
  addInstanced(mhGeo, materials.manhole, inst.manholes, (m, v, q, s, c) => {
    v.set(m.x, 0.021, m.z); setY(0); s.set(m.r, 1, m.r); c.setRGB(1, 1, 1);
  }, false);
  // 灯头辉光（Points，加色混合；夜里一盏灯就是一团光，配合 bloom 很省）
  let glowPoints = null;
  if (inst.lamps.length) {
    const g = new BufferGeometry();
    const pos = new Float32Array(inst.lamps.length * 3);
    inst.lamps.forEach((l, i) => { pos[i * 3] = l.x; pos[i * 3 + 1] = 5.45; pos[i * 3 + 2] = l.z; });
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.computeBoundingSphere();
    glowPoints = new Points(g, materials.glow);
    glowPoints.frustumCulled = false;
  }

  // ── 细节分块（LOD 靠整格显隐）─────────────────────────────────────────────
  const { cell, chunks } = resolveChunkRecords(meshData, opts);
  for (const c of chunks) {
    if (c.src.mid) {
      const m = new Mesh(toGeometry(c.src.mid), materials.prop);
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix();
      c.mid = m;
    }
    if (c.src.near) {
      const m = new Mesh(toGeometry(c.src.near), materials.prop);
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix();
      c.near = m;
    }
  }

  const all = [...meshes, ...instanced, ...(glowPoints ? [glowPoints] : []),
    ...chunks.flatMap((c) => [c.mid, c.near].filter(Boolean))];

  /** 每帧：按到格子的距离整格显隐（不重建几何），并统计三档楼数 */
  const lodStats = { near: 0, mid: 0, far: 0 };
  const hys = Number(opts.lodHysteresis) >= 1 ? Number(opts.lodHysteresis) : LOD_HYSTERESIS;
  const update = (px, pz, lodNear, lodMid, detail) => lodPlan(chunks, px, pz, lodNear, lodMid, detail, lodStats, hys);

  /** 切"半卡通"：把楼体五个桶的 mesh.material 换成另一套（几何一根线都不动） */
  let toonNow = false;
  const applyBucketKind = (style) => {
    const useToon = TOON_BUCKETS.some((b) => bucketKindFor(b, style) === 'toon');
    if (useToon === toonNow) return;
    toonNow = useToon;
    for (const bucket of TOON_BUCKETS) {
      const m2 = useToon ? toonMats[bucket] : stdMats[bucket];
      if (!m2) continue;
      materials[bucket] = m2;
      const mesh = meshByBucket.get(bucket);
      if (mesh) mesh.material = m2;
    }
  };

  /**
   * 分色染色 / 边缘光的参数：**全部从风格档取**（`toonUniformValues` 是纯函数，自检直接断言它）。
   * 写实两档没有 `toonTint`/`toonRim` ⇒ `on=0` ⇒ 着色器里是恒等变换（乘 1、加 0）。
   */
  const applyToonParams = (style) => {
    const v = toonUniformValues(style);
    for (const m of Object.values(toonMats)) {
      const u = m.userData.toonUniforms;
      if (!u) continue;
      u.uToonOn.value = v.on;
      u.uToonLitTint.value.set(v.litTint[0], v.litTint[1], v.litTint[2]);
      u.uToonLitStrength.value = v.litStrength;
      u.uToonShadowTint.value.set(v.shadowTint[0], v.shadowTint[1], v.shadowTint[2]);
      u.uToonShadowStrength.value = v.shadowStrength;
      u.uToonAmbientTint.value.set(v.ambientTint[0], v.ambientTint[1], v.ambientTint[2]);
      u.uToonAmbientStrength.value = v.ambientStrength;
      u.uToonRimColor.value.set(v.rimColor[0], v.rimColor[1], v.rimColor[2]);
      u.uToonRimThreshold.value = v.rimThreshold;
      u.uToonRimStrength.value = v.rimStrength;
      u.uToonRimPower.value = v.rimPower;
    }
  };
  /** 太阳方向（view space）：着色器里的受光比得跟 three 的 `directLight.direction` 同一个空间，所以每帧更新 */
  const setToonSunDirView = (v) => {
    for (const m of Object.values(toonMats)) {
      const u = m.userData.toonUniforms;
      if (u) u.uToonSunDirView.value.set(v[0], v[1], v[2]);
    }
  };
  /** 动画感三件的读数（纯读）：染色/边缘光开没开、强度多少、补丁锚点是不是还在 */
  const toonFx = () => {
    const mats = Object.values(toonMats).filter(Boolean);
    const u0 = mats.length && mats[0].userData.toonUniforms;
    return {
      on: !!(u0 && u0.uToonOn.value > 0), toon: toonNow,
      patchMissing: (mats.map((m) => m.userData.toonPatchMissing).find((x) => x)) || null,
      litStrength: u0 ? u0.uToonLitStrength.value : null,
      shadowStrength: u0 ? u0.uToonShadowStrength.value : null,
      ambientStrength: u0 ? u0.uToonAmbientStrength.value : null,
      rimStrength: u0 ? u0.uToonRimStrength.value : null,
      rimThreshold: u0 ? u0.uToonRimThreshold.value : null,
    };
  };

  /** 切风格：只改材质/光照参数与贴图指针，几何一根线都不动 */
  const setStyle = (style) => {
    applyBucketKind(style);
    applyToonParams(style);
    const wantClean = !!style.clean;
    if (wantClean !== texClean) {
      const t0 = tTex();
      const next = buildTextureSet({ clean: wantClean });
      const old = tex;
      tex = next; texClean = wantClean;
      applyTextures(next);
      texMs = +(tTex() - t0).toFixed(1);
      // 换掉的贴图必须 dispose（512² 的四张立面 + 立面自发光 ≈ 十几 MB，手机上不能留着）
      for (const t of Object.values(old)) {
        if (t && t.isTexture) t.dispose();
        else if (t && t.map && t.map.isTexture) { t.map.dispose(); t.emissiveMap.dispose(); }
      }
    }
    for (let i = 0; i < 4; i++) if (materials['wall' + i]) materials['wall' + i].emissiveIntensity = style.windowEmissive;
    materials.shop.emissiveIntensity = style.windowEmissive * 1.15;
    materials.lampHead.emissiveIntensity = style.lampGlow;
    materials.glow.opacity = style.lampGlow > 0 ? 0.85 : 0;
    materials.glow.visible = style.lampGlow > 0;
    if (glowPoints) glowPoints.visible = style.lampGlow > 0;
  };

  const dispose = () => {
    for (const m of all) { if (m.geometry) m.geometry.dispose(); }
    for (const m of Object.values(materials)) m.dispose();
    for (const set2 of [stdMats, toonMats]) for (const m of Object.values(set2)) if (!Object.values(materials).includes(m)) m.dispose();
    if (gradientMap) gradientMap.dispose();
    for (const t of Object.values(tex)) {
      if (t && t.isTexture) t.dispose();
      else if (t && t.map && t.map.isTexture) { t.map.dispose(); t.emissiveMap.dispose(); }
    }
  };

  /** 每种材质一个网格：HUD 里要报"实际 draw call 数"就靠它 */
  const drawEstimate = () => meshes.length + instanced.length + (glowPoints ? 1 : 0) + chunks.length * 2;

  group.add(...all);
  // 楼体五个桶之外的材质（屋面/路面/道具/实例化/辉光）一律不描边
  for (const m of Object.values(materials)) {
    if (!m.userData.outlineParameters) m.userData.outlineParameters = { visible: false };
  }
  /**
   * 描边开关 + **参数**：只翻/改楼体五个桶的 `outlineParameters`（两套材质一起改），几何与贴图都不动。
   * 粗细与颜色由调用方从风格档算好传进来（`toon.mjs` 的 `outlineSpecFor()`）：
   * OutlineEffect 每帧在 onBeforeRender 里读这三个值写 uniform ⇒ 切风格当场变，不重建材质。
   * 不传 spec 时退到 palette.OUTLINE（老调用点 `setOutline(true)` 的行为逐字不变）。
   */
  let outlineOn = false;
  // 描边当前实际生效的那份参数（探针/HUD 读它，证明"粗细颜色真的来自风格档"）
  let outlineSpec = { thickness: OUTLINE.thickness, color: OUTLINE.color, alpha: 1 };
  const setOutline = (on, spec = null) => {
    outlineOn = !!on;
    const s = spec || {};
    const thickness = Number.isFinite(Number(s.thickness)) && Number(s.thickness) > 0 ? Number(s.thickness) : OUTLINE.thickness;
    const color = Array.isArray(s.color) ? s.color.slice(0, 3) : toRgb(s.color || OUTLINE.color);
    const alpha = Number.isFinite(Number(s.alpha)) ? Number(s.alpha) : 1;
    for (const bucket of TOON_BUCKETS) {
      for (const set2 of [stdMats, toonMats]) {
        const m = set2[bucket];
        if (m && m.userData.outlineParameters) {
          m.userData.outlineParameters.visible = outlineOn;
          m.userData.outlineParameters.thickness = thickness;
          m.userData.outlineParameters.color = color;
          m.userData.outlineParameters.alpha = alpha;
        }
      }
    }
    outlineSpec = { thickness, color: '#' + color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join(''), alpha };
    return outlineOn;
  };

  return {
    group, meshes, instanced, chunks, cell, glowPoints, materials, textures: tex, update, setStyle, dispose, lodStats, drawEstimate, tune,
    setOutline, isOutline: () => outlineOn,
    outlineSpec: () => ({ ...outlineSpec, on: outlineOn }),
    setToonSunDirView, applyToonParams,
    // 动画感三件的读数（探针/HUD 读）：染色边缘光开没开、补丁锚点找到了没有
    toonFx: () => toonFx(),
    isClean: () => texClean, texMs: () => texMs, applyTextures,
    // 半卡通读数（探针/自检读）：当前是不是 toon、五个桶各自用的哪种材质
    isToon: () => toonNow,
    bucketKinds: () => Object.fromEntries(TOON_BUCKETS.map((b) => [b, materials[b] && materials[b].isMeshToonMaterial ? 'toon' : 'standard'])),
    materialOf: (b) => materials[b],
  };
}

export { TILE, toRgb, shade, MathUtils };
