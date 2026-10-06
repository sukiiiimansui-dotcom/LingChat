// world.mjs —— 几何缓冲 → three 对象（材质 / 网格 / 实例化 / LOD 分块）。
//
// 分工：build.mjs 只出平铺数组，这里把它变成 BufferGeometry + 材质并挂进场景。
// **draw call 是这一层的头号 KPI**：每个材质桶一个网格（常显 11 个），细节按 256m 分块（只有近处那几格可见）。
import {
  BufferGeometry, BufferAttribute, Mesh, InstancedMesh, Matrix4, Quaternion, Vector3, Color, Group,
  MeshStandardMaterial, MeshBasicMaterial, PointsMaterial, Points, DoubleSide, FrontSide,
  AdditiveBlending, CanvasTexture, SRGBColorSpace, RepeatWrapping, LinearMipmapLinearFilter,
  CylinderGeometry, IcosahedronGeometry, ConeGeometry, BoxGeometry, CircleGeometry, PlaneGeometry,
  MathUtils,
} from '../vendor/three.min.js';
import { buildTextureSet, TILE } from './textures.mjs';
import { TIERS, GROUND, ACCENT, toRgb, shade } from './palette.mjs';

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
  const tex = buildTextureSet();
  for (const f of tex.facades) { tune(f.map, maxAniso); tune(f.emissiveMap, maxAniso); }
  tune(tex.shop.map, maxAniso); tune(tex.shop.emissiveMap, maxAniso);
  for (const k of ['roof', 'asphalt', 'asphaltWide', 'sidewalk', 'ground', 'bark']) tune(tex[k], maxAniso);
  tex.glow.colorSpace = SRGBColorSpace;

  const materials = {};
  // 楼体四档：贴图 + 自发光贴图（夜里同一张贴图的"亮窗层"被推上来）
  tex.facades.forEach((f, i) => {
    materials['wall' + i] = new MeshStandardMaterial({
      map: f.map, emissiveMap: f.emissiveMap, emissive: new Color(1, 1, 1), emissiveIntensity: 0,
      vertexColors: true, roughness: TIERS[i].roughness, metalness: TIERS[i].metalness,
    });
  });
  materials.shop = new MeshStandardMaterial({
    map: tex.shop.map, emissiveMap: tex.shop.emissiveMap, emissive: new Color(1, 1, 1),
    emissiveIntensity: 0, vertexColors: true, roughness: 0.7, metalness: 0.05,
  });
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

  const group = new Group();
  const meshes = [];
  const casters = new Set(['wall0', 'wall1', 'wall2', 'wall3', 'shop', 'roof', 'prop']);
  const receivers = new Set(['wall0', 'wall1', 'wall2', 'wall3', 'shop', 'roof', 'prop', 'asphalt', 'asphaltWide', 'sidewalk', 'ground', 'paint']);

  for (const [bucket, buf] of Object.entries(meshData.base)) {
    const mat = materials[bucket];
    if (!mat) continue;
    const m = new Mesh(toGeometry(buf), mat);
    m.name = bucket;
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
  const chunks = [];
  for (const c of meshData.chunks) {
    const rec = { key: c.key, cx: c.cx, cz: c.cz, buildings: c.buildings, mid: null, near: null };
    if (c.mid) {
      const m = new Mesh(toGeometry(c.mid), materials.prop);
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix();
      rec.mid = m;
    }
    if (c.near) {
      const m = new Mesh(toGeometry(c.near), materials.prop);
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.updateMatrix();
      rec.near = m;
    }
    chunks.push(rec);
  }

  const all = [...meshes, ...instanced, ...(glowPoints ? [glowPoints] : []),
    ...chunks.flatMap((c) => [c.mid, c.near].filter(Boolean))];

  /** 每帧：按到玩家的距离整格显隐（不重建几何），并统计三档楼数 */
  const lodStats = { near: 0, mid: 0, far: 0 };
  const update = (px, pz, lodNear, lodMid, detail) => {
    lodStats.near = 0; lodStats.mid = 0; lodStats.far = 0;
    for (const c of chunks) {
      const d = Math.hypot(c.cx - px, c.cz - pz) - Math.SQRT1_2 * 256;   // 到格子最近角的距离
      const inNear = detail && d < lodNear;
      const inMid = d < lodMid;
      if (c.near) c.near.visible = inNear;
      if (c.mid) c.mid.visible = inMid;
      if (inNear) lodStats.near += c.buildings;
      else if (inMid) lodStats.mid += c.buildings;
      else lodStats.far += c.buildings;
    }
    return lodStats;
  };

  /** 切风格：只改材质/光照参数，几何一根线都不动 */
  const setStyle = (style) => {
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
    for (const t of Object.values(tex)) {
      if (t && t.isTexture) t.dispose();
      else if (t && t.map) { t.map.dispose(); t.emissiveMap.dispose(); }
    }
  };

  /** 每种材质一个网格：HUD 里要报"实际 draw call 数"就靠它 */
  const drawEstimate = () => meshes.length + instanced.length + (glowPoints ? 1 : 0) + chunks.length * 2;

  group.add(...all);
  return { group, meshes, instanced, chunks, glowPoints, materials, textures: tex, update, setStyle, dispose, lodStats, drawEstimate, tune };
}

export { TILE, toRgb, shade, MathUtils };
