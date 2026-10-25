#!/usr/bin/env node
/* build-bld-assets.mjs —— 把 Kenney City Kit（CC0）的 GLB 压成**运行时一个请求就够**的紧凑资产包。
 *
 * ## 为什么要有构建期这一步
 * 运行时那份 three 是裁剪构建；GLB 每栋 95–440 KB、41 个文件 3.7 MB，而且每个 GLB 都自带一份
 * JSON/KHR 扩展、贴图引用同一张 colormap。浏览器端逐个解析不划算 —— 构建期一次性做完：
 *   · 解析 GLB（12 字节头 + JSON chunk + BIN chunk），只认 POSITION / NORMAL / TEXCOORD_0 / indices；
 *   · 节点变换（matrix 或 TRS，沿父链）烘进顶点，输出**世界坐标**；
 *   · 每栋平移到「占地中心在原点、底面 y=0」，运行时只做「平移 + 旋转 + 缩放」；
 *   · 法线**不存**：按平台同一套 Lambert（0.62 + 0.38·max(0, n·L̂)，顶面 1.0）烘成 1 字节明暗，
 *     材质用不受光的 MeshBasicMaterial（与程序化那条路同一种做法，见 wsBldMesh.ts）；
 *   · UV 量化成 uint16（归一化），位置保持 float32（WebGL 原生、不用改 shader）。
 *
 * ## 产出（`public/ws3d/bldassets/`）
 *   pack.json    资产清单（名字/顶点/三角/包围盒/bin 内字节偏移）
 *   pack.bin     所有资产拼成一个 ArrayBuffer（pos → uv → shade → idx，段首 4 字节对齐）
 *   colormap.png 共享贴图（512×512，11 KB，直接拷）
 *   LICENSE.txt  来源与许可（CC0）
 *
 * ## 纪律
 * · 不引第三方依赖：只用 node 内置（fs/path/zlib 都不用 —— GLB 的 BIN chunk 是裸字节）；
 * · 输出是**生成物**：重复跑必须逐字节相同（不写时间戳、不写随机数、键序固定）；
 * · 源目录默认 `$HOME/chk/_bldlab/kk`，可用 `--src` 指过去；`--out` 改输出目录；`--dry` 只打表。
 *
 * 用法：`node scripts/build-bld-assets.mjs [--src DIR] [--out DIR] [--only main|all|names] [--dry]`
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/* ── 与 wsBldMesh.ts 同一套光照（改了那边要同步这里，否则资产与程序化两条路的明暗会打架） ── */
const AMBIENT_K = 0.62;
const SUN_K = 0.38;
const SUN_DIR = (() => {
  const v = [0.35, 1, 0.36];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
})();

/**
 * 主资产（2026-10-25 扩池：原来只有 14 商业 + 5 摩天楼，街区看着太重复）。
 * 加入 Kenney 的 **low-detail** 系列（8 栋 + 2 栋 wide，单栋 150~190 三角）：
 * 它们面数更低、轮廓更不同 ⇒ 变体多、总三角数反而不涨。
 */
const MAIN_ASSETS = [
  "building-a", "building-b", "building-c", "building-d", "building-e",
  "building-f", "building-g", "building-h", "building-i", "building-j",
  "building-k", "building-l", "building-m", "building-n",
  "building-skyscraper-a", "building-skyscraper-b", "building-skyscraper-c",
  "building-skyscraper-d", "building-skyscraper-e",
  "low-detail-building-a", "low-detail-building-b", "low-detail-building-c",
  "low-detail-building-d", "low-detail-building-e", "low-detail-building-f",
  "low-detail-building-g", "low-detail-building-h", "low-detail-building-i",
  "low-detail-building-j", "low-detail-building-k", "low-detail-building-l",
  "low-detail-building-m", "low-detail-building-n",
  "low-detail-building-wide-a", "low-detail-building-wide-b",
];

/** 名字 → 运行时挑资产的粗分类：矮/中/高，三档让同高的楼也能落到不同池子 */
function classOf(name) {
  if (name.includes("skyscraper")) return "tall";
  if (name.startsWith("low-detail")) return "low";
  return "mid";
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、GLB 解析（glTF 2.0 二进制容器）
 * ══════════════════════════════════════════════════════════════════════════ */

const GLB_MAGIC = 0x46546c67; // "glTF"（小端）
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export function parseGlb(buf) {
  if (buf.length < 12) throw new Error("GLB 太短");
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error("不是 GLB（magic 不对）");
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  if (version !== 2) throw new Error("只支持 glTF 2.0，拿到 " + version);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString("utf8"));
    else if (type === CHUNK_BIN) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error("没有 JSON chunk");
  return { json, bin };
}

/** accessor → Float32Array / 整数视图（尊重 bufferView.byteStride） */
function readAccessor(json, bin, index) {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error("accessor 缺失: " + index);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
  if (!comps) throw new Error("不认识的 accessor.type: " + acc.type);
  const bv = json.bufferViews?.[acc.bufferView];
  if (!bv) throw new Error("bufferView 缺失: " + acc.bufferView);
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || comps * sizeOf(acc.componentType);
  const count = acc.count || 0;
  const out = typedFor(acc.componentType, count * comps);
  const dv = new DataView(bin.buffer, bin.byteOffset + base, count ? (count - 1) * stride + comps * sizeOf(acc.componentType) : 0);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = i * stride + c * sizeOf(acc.componentType);
      out[i * comps + c] = readComp(dv, o, acc.componentType);
    }
  }
  return { data: out, comps, count, componentType: acc.componentType, normalized: !!acc.normalized };
}

function sizeOf(ct) {
  switch (ct) {
    case 5120: case 5121: return 1; // BYTE / UNSIGNED_BYTE
    case 5122: case 5123: return 2; // SHORT / UNSIGNED_SHORT
    case 5125: case 5126: return 4; // UINT / FLOAT
    default: throw new Error("不认识的 componentType: " + ct);
  }
}

function typedFor(ct, n) {
  switch (ct) {
    case 5120: return new Int8Array(n);
    case 5121: return new Uint8Array(n);
    case 5122: return new Int16Array(n);
    case 5123: return new Uint16Array(n);
    case 5125: return new Uint32Array(n);
    case 5126: return new Float32Array(n);
    default: throw new Error("不认识的 componentType: " + ct);
  }
}

function readComp(dv, o, ct) {
  switch (ct) {
    case 5120: return dv.getInt8(o);
    case 5121: return dv.getUint8(o);
    case 5122: return dv.getInt16(o, true);
    case 5123: return dv.getUint16(o, true);
    case 5125: return dv.getUint32(o, true);
    case 5126: return dv.getFloat32(o, true);
    default: throw new Error("不认识的 componentType: " + ct);
  }
}

/* ── 4×4 矩阵（列主序，与 glTF 一致） ── */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function trsMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function applyMat4(m, v) {
  const [x, y, z] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** 法线的变换用左上 3×3 的逆转置（非均匀缩放时也对） */
function normalMatrixOf(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  /* 逆矩阵（列主序）后转置 ⇒ 直接按"转置的逆"写 */
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

function applyNrm(nm, v) {
  if (!nm) return v;
  return [
    nm[0] * v[0] + nm[3] * v[1] + nm[6] * v[2],
    nm[1] * v[0] + nm[4] * v[1] + nm[7] * v[2],
    nm[2] * v[0] + nm[5] * v[1] + nm[8] * v[2],
  ];
}

/* ── KHR_texture_transform（offset/scale/rotation） ── */
function uvTransformOf(mat) {
  const t = mat?.pbrMetallicRoughness?.baseColorTexture?.extensions?.KHR_texture_transform;
  if (!t) return { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };
  const ox = Number(t.offset?.[0] ?? 0), oy = Number(t.offset?.[1] ?? 0);
  const sx = Number(t.scale?.[0] ?? 1), sy = Number(t.scale?.[1] ?? 1);
  const rot = Number(t.rotation ?? 0);
  return { ox, oy, sx, sy, rot };
}

function applyUvT(t, u, v) {
  let uu = u, vv = v;
  if (t.rot) {
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    const du = uu - 0.5, dv = vv - 0.5;
    uu = 0.5 + du * c - dv * s;
    vv = 0.5 + du * s + dv * c;
  }
  return [uu * t.sx + t.ox, vv * t.sy + t.oy];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、一个 GLB → 一份资产（顶点已烘成世界坐标、再平移到"占地中心 + 底面 0"）
 * ══════════════════════════════════════════════════════════════════════════ */

export function extractAsset(buf, name) {
  const { json, bin } = parseGlb(buf);
  if (!bin) throw new Error(name + "：没有 BIN chunk");
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  /* 沿 scenes 走一遍，累积世界矩阵（Kenney 是一层，但这里按通用写） */
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i);
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const mats = new Set();
  let seq = 0; // 资产内部顶点基址（每次 primitive 追加后前进）

  const walk = (ni, parentM) => {
    const node = nodes[ni];
    if (!node) return;
    const world = mul(parentM, trsMatrix(node));
    if (node.mesh != null) {
      const mesh = meshes[node.mesh];
      const nm = normalMatrixOf(world);
      for (const prim of mesh?.primitives || []) {
        if ((prim.mode ?? 4) !== 4) throw new Error(name + "：只支持三角形（mode 4），拿到 " + prim.mode);
        const pa = readAccessor(json, bin, prim.attributes.POSITION);
        if (pa.componentType !== 5126 || pa.comps !== 3) throw new Error(name + "：POSITION 不是 float VEC3");
        const na = prim.attributes.NORMAL != null ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
        const ua = prim.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null;
        const mat = json.materials?.[prim.material];
        mats.add(prim.material);
        const uvt = uvTransformOf(mat);
        const base = seq;
        for (let i = 0; i < pa.count; i++) {
          const p = applyMat4(world, [pa.data[i * 3], pa.data[i * 3 + 1], pa.data[i * 3 + 2]]);
          pos.push(p[0], p[1], p[2]);
          if (na) {
            const n0 = applyNrm(nm, [na.data[i * 3], na.data[i * 3 + 1], na.data[i * 3 + 2]]);
            const l = Math.hypot(n0[0], n0[1], n0[2]) || 1;
            nrm.push(n0[0] / l, n0[1] / l, n0[2] / l);
          } else {
            nrm.push(0, 1, 0);
          }
          if (ua) {
            const [u, v] = applyUvT(uvt, ua.data[i * 2], ua.data[i * 2 + 1]);
            uv.push(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
          } else {
            uv.push(0, 0);
          }
        }
        if (prim.indices != null) {
          const ia = readAccessor(json, bin, prim.indices);
          for (let i = 0; i < ia.count; i++) idx.push(base + ia.data[i]);
        } else {
          for (let i = 0; i < pa.count; i++) idx.push(base + i);
        }
        seq += pa.count;
      }
    }
    for (const c of node.children || []) walk(c, world);
  };
  for (const r of roots) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  if (!pos.length) throw new Error(name + "：没解析出顶点");
  if (mats.size > 1) throw new Error(name + "：一个资产只允许一种材质（拿到 " + mats.size + " 种）");
  const material = json.materials?.[[...mats][0]];
  const texIndex0 = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  const image = json.images?.[json.textures?.[texIndex0]?.source];
  const textureUri = image?.uri || "";

  /* 包围盒 → 平移到「占地中心在原点、底面 y=0」 */
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx;
    pos[i + 1] -= minY;
    pos[i + 2] -= cz;
  }
  return {
    name,
    class: classOf(name),
    verts: pos.length / 3,
    tris: idx.length / 3,
    pos: Float32Array.from(pos),
    nrm: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    idx: Uint32Array.from(idx),
    bbox: [minX - cx, 0, minZ - cz, maxX - cx, maxY - minY, maxZ - cz],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    textureUri,
    doubleSided: !!material?.doubleSided,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、打成一个包
 * ══════════════════════════════════════════════════════════════════════════ */

const align4 = (n) => (n + 3) & ~3;

function packAssets(assets) {
  /* 段序：pos(f32) → uv(u16 归一化) → shade(u8) → idx(u16) */
  let off = 0;
  const posOff = [];
  for (const a of assets) { off = align4(off); posOff.push(off); off += a.verts * 3 * 4; }
  const uvOff = [];
  for (const a of assets) { off = align4(off); uvOff.push(off); off += a.verts * 2 * 2; }
  const shadeOff = [];
  for (const a of assets) { off = align4(off); shadeOff.push(off); off += a.verts; }
  const idxOff = [];
  for (const a of assets) { off = align4(off); idxOff.push(off); off += a.idx.length * 2; }
  const total = align4(off);
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const meta = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    /* 位置：原样 float32 */
    new Uint8Array(buf, posOff[i], a.pos.byteLength).set(new Uint8Array(a.pos.buffer, a.pos.byteOffset, a.pos.byteLength));
    /* UV：0..1 → uint16 归一化 */
    const uvs = new Uint16Array(buf, uvOff[i], a.verts * 2);
    for (let k = 0; k < a.verts * 2; k++) uvs[k] = Math.round(Math.min(1, Math.max(0, a.uv[k])) * 65535);
    /* 明暗：1 字节（与 wsBldMesh 同一套 Lambert；顶面 1.0） */
    const shade = new Uint8Array(buf, shadeOff[i], a.verts);
    for (let k = 0; k < a.verts; k++) {
      const nx = a.nrm[k * 3], ny = a.nrm[k * 3 + 1], nz = a.nrm[k * 3 + 2];
      const d = nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2];
      const kk = ny > 0.7 ? 1 : AMBIENT_K + SUN_K * Math.max(0, d);
      shade[k] = Math.round(Math.min(1, Math.max(0, kk)) * 255);
    }
    /* 索引：uint16（超过 65535 顶点就报错 —— 现在最大 8485，留足余量） */
    if (a.verts > 65535) throw new Error(a.name + "：顶点超过 65535，u16 索引装不下");
    const idx = new Uint16Array(buf, idxOff[i], a.idx.length);
    for (let k = 0; k < a.idx.length; k++) idx[k] = a.idx[k];
    meta.push({
      name: a.name,
      class: a.class,
      verts: a.verts,
      tris: a.tris,
      pos: posOff[i],
      uv: uvOff[i],
      shade: shadeOff[i],
      idx: idxOff[i],
      idxCount: a.idx.length,
      /** [minX, minY, minZ, maxX, maxY, maxZ]（已平移到占地中心 / 底面 0） */
      bbox: a.bbox.map((x) => Math.round(x * 1000) / 1000),
      /** 占地尺寸 [w, h, d]（米/资产单位：Kenney 1 单位 ≈ 1 米，运行时再缩） */
      size: a.size.map((x) => Math.round(x * 1000) / 1000),
      /** 该资产用到的贴图（共享 colormap） */
      tex: a.textureUri ? path.basename(a.textureUri) : null,
    });
  }
  void u8;
  return { buf, meta, total };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、CLI
 * ══════════════════════════════════════════════════════════════════════════ */

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : dflt;
}

function main() {
  const src = path.resolve(argOf("--src", path.join(os.homedir(), "chk/_bldlab/kk")));
  const out = path.resolve(argOf("--out", path.join(REPO, "public/ws3d/bldassets")));
  const only = argOf("--only", "main");
  const dry = process.argv.includes("--dry");

  const all = fs.readdirSync(src).filter((f) => f.endsWith(".glb")).map((f) => f.replace(/\.glb$/, "")).sort();
  const wanted = only === "all" ? all : only === "main" ? MAIN_ASSETS.filter((n) => all.includes(n)) : only.split(",");
  if (!wanted.length) throw new Error("源目录里找不到要的 GLB：" + src);

  const assets = [];
  for (const name of wanted) {
    const file = path.join(src, name + ".glb");
    const a = extractAsset(fs.readFileSync(file), name);
    /* 共享贴图断言：所有资产必须引用同一张 colormap（不然运行时一张纹理画不了全部） */
    if (a.textureUri && path.basename(a.textureUri) !== "colormap.png") {
      throw new Error(name + "：贴图不是 colormap.png（" + a.textureUri + "），运行时只带一张");
    }
    assets.push(a);
  }
  const { buf, meta, total } = packAssets(assets);
  const texPath = path.join(src, "Textures", "colormap.png");
  if (!fs.existsSync(texPath)) throw new Error("找不到共享贴图：" + texPath);
  const texBytes = fs.readFileSync(texPath);
  const png = pngSize(texBytes);

  let tris = 0, verts = 0, posBytes = 0;
  for (let i = 0; i < assets.length; i++) {
    tris += meta[i].tris;
    verts += meta[i].verts;
  }
  posBytes = assets.reduce((n, a) => n + a.pos.byteLength, 0);

  const pack = {
    v: 1,
    generator: "scripts/build-bld-assets.mjs",
    source: "Kenney City Kit Commercial 2.1 (CC0-1.0)",
    license: "CC0-1.0",
    texture: "colormap.png",
    textureSize: png,
    bin: "pack.bin",
    binBytes: total,
    counts: { assets: assets.length, verts, tris },
    /** 段布局：每顶点 pos=12B float32 / uv=4B uint16 归一化 / shade=1B；索引 uint16 = 2B */
    layout: { pos: "f32x3", uv: "u16x2 normalized", shade: "u8", idx: "u16" },
    assets: meta,
  };
  const json = JSON.stringify(pack, null, 2) + "\n";

  console.log("── 资产包 ──");
  for (const m of meta) {
    console.log(
      `  ${m.name.padEnd(26)} ${String(m.verts).padStart(6)} v ${String(m.tris).padStart(6)} tri  ` +
        `w×h×d=${m.size.map((x) => x.toFixed(2)).join(" × ")}`
    );
  }
  console.log(
    `  合计 ${assets.length} 个资产 · ${verts} 顶点 · ${tris} 三角 · ` +
      `bin ${(total / 1024).toFixed(0)} KB（位置 ${(posBytes / 1024).toFixed(0)} KB）· ` +
      `贴图 ${(texBytes.length / 1024).toFixed(0)} KB ${png[0]}×${png[1]} · ` +
      `包总计 ${((total + texBytes.length + Buffer.byteLength(json)) / 1048576).toFixed(2)} MB`
  );
  if (dry) {
    console.log("（--dry：不写盘）");
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "pack.bin"), Buffer.from(buf));
  fs.writeFileSync(path.join(out, "pack.json"), json);
  fs.writeFileSync(path.join(out, "colormap.png"), texBytes);
  fs.writeFileSync(
    path.join(out, "LICENSE.txt"),
    [
      "Kenney City Kit Commercial 2.1",
      "Source: https://kenney.nl/assets/city-kit-commercial",
      "License: CC0-1.0（公共领域；可商用、署名非必需）",
      "本目录只保留运行时需要的几何（pack.bin）与共享贴图（colormap.png），",
      "由 scripts/build-bld-assets.mjs 从原始 GLB 生成。",
      "",
    ].join("\n")
  );
  console.log("  写出 → " + path.relative(REPO, out) + "/{pack.json,pack.bin,colormap.png,LICENSE.txt}");
}

/** PNG 宽高（IHDR 前 8 字节之后是大端 u32×2） */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return [0, 0];
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
