#!/usr/bin/env node
/* build-bld-assets.mjs —— 构建期的「资产派生引擎」：把 Kenney City Kit（CC0）的基础楼
 * 程序化改造成一组有差异的近景资产，并压成运行时一个请求就够的紧凑包。
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
 * ## 派生（本文件第三、四节）
 * 每个基础资产派生 2 个变体，名字带后缀（`building-a@awning`），`class` 继承基础资产：
 *   · `@awning`  —— 中楼：基座外扩一圈（程序化盒）+ 立面 2~4 个雨棚（焊接 Kenney detail-awning）；
 *   · `@roofbox` —— 中/矮楼：顶面 1~3 个设备箱（程序化盒）；
 *   · `@parasol` —— 矮楼：底商前 1~2 把伞（焊接 detail-parasol）；
 *   · `@overhang`—— 高楼：顶部一圈挑檐（程序化盒）+ 底层两座门廊（焊接 detail-overhang）；
 *   · `@setback` —— 高楼：上部再叠一个小一号的盒，形成退台轮廓（程序化盒）。
 *
 * 细节焊接的**朝向约定**（实测这些 GLB 的几何）：detail 的局部 **+z 是贴墙那一面**，
 * 顶棚从 +z 往外斜下；所以 `bbox[5]`（maxZ）就是贴墙面、`-bbox[2]` 是外挑量。
 * 贴到 ±x / ±z 四个立面时按「局部 -z → 立面外法线」绕 Y 旋转，再按包围盒把贴墙面推到墙面。
 *
 * 颜色不另调色：程序化构件的 UV 取**这栋楼自己**用得最多的贴图格（墙面色/屋面色/底商色），
 * 于是每栋楼的加建部分天然与它同色系（colormap 是调色板，格子中心就是一格纯色）。
 *
 * ## 顶点块按「族」共享
 * 变体 = 楼体 + 加建。楼体顶点在同族三个资产里完全一样，所以 **每族只存一份顶点块**，
 * 各资产只带自己的索引段（`pack.json` 的 `assets[].family` 标出所属族；`pos/uv/shade`
 * 偏移在同族内相同）。105 个资产因此只多花索引与加建顶点，不会把 35 份楼体抄三遍。
 * 代价：`assets[].size/bbox` 描述的是**该资产自己索引到的三角形**（变体的真实轮廓），
 * 而顶点块里还留着同族其它变体的加建顶点（运行时只按索引取，不会画到）。
 *
 * ## 产出（`public/ws3d/bldassets/`）
 *   pack.json    资产清单（名字/分类/族/顶点/三角/包围盒/bin 内字节偏移）
 *   pack.bin     所有资产拼成一个 ArrayBuffer（pos → uv → shade → idx，段首 4 字节对齐）
 *   colormap.png 共享贴图（512×512，11 KB，直接拷）
 *   LICENSE.txt  来源与许可（CC0）
 *
 * ## 纪律
 * · 不引第三方依赖：只用 node 内置（fs/path/os/crypto）；
 * · 输出是**生成物**：重复跑必须逐字节相同（不写时间戳、不写随机数、键序与遍历序固定；
 *   变体的取舍全部用名字哈希派生，见 `hashOf`）。`--verify` 会连跑两遍比 sha256；
 * · 源目录默认 `$HOME/chk/_bldlab/kk`，可用 `--src` 指过去；`--out` 改输出目录；`--dry` 只打表。
 *
 * 用法：`node scripts/build-bld-assets.mjs [--src DIR] [--out DIR] [--only main|all|names] [--dry] [--verify]`
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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

/* ── 包体上限（超了就报错，不做静默截断） ─────────────────────────────────────
 * 预算 3.2 MB（按十进制算，最严口径）：顶点块共享后实测约 2.3 MB，余量是给后续加变体的。 */
const MAX_PACK_BYTES = 3.2 * 1000 * 1000;
/** 单个资产（含变体）的三角上限 */
const MAX_ASSET_TRIS = 6000;

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
 * 二、一个 GLB → 一份几何（顶点已烘成世界坐标、再平移到"占地中心 + 底面 0"）
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
 * 三、派生引擎：细节焊接 + 程序化构件
 * ══════════════════════════════════════════════════════════════════════════ */

/** 确定性哈希（FNV-1a 32 位；与运行时 `wsBldFacade.hashId` 同族）。
 *  变体的取舍/摆放只由**资产名**派生 ⇒ 同一份源码重复跑，输出逐字节相同。 */
function hashOf(s) {
  let h = 0x811c9dc5;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const unitOf = (s) => hashOf(s) / 4294967296;
const lerp = (a, b, t) => a + (b - a) * t;

/** 派生参数（一个地方调形状；比例都相对**楼体自己的**包围盒，换资产不用改） */
const C = {
  /** @awning：每块雨棚宽 = 立面宽 × 该值 */
  awningW: 0.40,
  /** @awning：雨棚高 = 楼高 × 该值（再按拉伸上下限夹住） */
  awningH: 0.28,
  /** 立面宽 ≥ 单块宽 × 该值时才并排两块 ⇒ 每立面 1~2 块、两立面合计 2~4 块 */
  awningTwo: 2.35,
  /** 并排两块的横向位置（立面宽的 ±比例） */
  awningSpread: 0.24,
  /** @overhang 门廊：宽/高相对立面宽与楼高（每个立面一座） */
  overhangW: 0.46,
  overhangH: 0.20,
  /** @parasol：伞宽 = 立面宽 × 该值；高 = 楼高 × 该值 */
  parasolW: 0.38,
  parasolH: 0.26,
  /** @awning 的基座：外扩 = min(宽,深) × 该值；高 = 楼高 × 该值 */
  podiumOut: 0.07,
  podiumH: 0.13,
  /** @overhang 的顶部挑檐：外挑 = 宽/深 × 该值；厚 = 楼高 × 该值 */
  corniceOut: 0.035,
  corniceH: 0.022,
  /** @setback：上部盒的占地系数（每边内缩）与高度占楼高比例 */
  setbackScale: 0.60,
  setbackH: 0.14,
  /** @setback 的退台檐口：外挑/厚度 */
  ledgeOut: 0.03,
  ledgeH: 0.018,
  /** @roofbox：单箱的宽/深（相对**顶层平台**）与高（相对楼高） */
  roofBoxW: [0.34, 0.52],
  roofBoxD: [0.34, 0.52],
  roofBoxH: [0.05, 0.09],
  /** 细节竖向拉伸的夹子（雨棚照楼层高等比例拉长会失真） */
  stretchMin: 0.7,
  stretchMax: 1.35,
  /** 高楼门廊允许更长的"柱"（它的高宽比比商业楼大得多） */
  overhangStretch: 1.5,
};

/** 细节素材（Kenney City Kit 的 detail-*；局部 +z 贴墙） */
const DETAIL_NAMES = {
  awning: "detail-awning",
  awningWide: "detail-awning-wide",
  overhang: "detail-overhang",
  overhangWide: "detail-overhang-wide",
  parasolA: "detail-parasol-a",
  parasolB: "detail-parasol-b",
};

function pushAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/** 绕 Y 旋转 + 各轴缩放 + 平移；法线按逆转置（1/s）再旋转、归一化 */
function transformGeo(g, t) {
  const rot = t.rotY || 0;
  const c = Math.cos(rot), sn = Math.sin(rot);
  const sx = t.sx ?? 1, sy = t.sy ?? 1, sz = t.sz ?? 1;
  const out = { pos: [], nrm: [], uv: g.uv.slice(), idx: g.idx.slice() };
  const n = g.pos.length;
  for (let i = 0; i < n; i += 3) {
    const x = g.pos[i] * sx, y = g.pos[i + 1] * sy, z = g.pos[i + 2] * sz;
    out.pos.push(x * c + z * sn + (t.tx || 0), y + (t.ty || 0), -x * sn + z * c + (t.tz || 0));
  }
  for (let i = 0; i < n; i += 3) {
    const x = g.nrm[i] / sx, y = g.nrm[i + 1] / sy, z = g.nrm[i + 2] / sz;
    const nx = x * c + z * sn, ny = y, nz = -x * sn + z * c;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.nrm.push(nx / l, ny / l, nz / l);
  }
  return out;
}

/** 立面 → 绕 Y 的旋转（把细节局部的 -z 转到该立面的外法线） */
function rotOfFace(face) {
  const axis = face[1];
  const sign = face[0] === "+" ? 1 : -1;
  if (axis === "z") return sign > 0 ? Math.PI : 0;
  return sign > 0 ? -Math.PI / 2 : Math.PI / 2;
}

/**
 * 把细节**贴到立面**：`bbox[5]`（局部 +z）那一面推到 `surface`（立面到楼体中心的距离）。
 * `along` 是沿立面方向的坐标（±z 立面时是 x，±x 立面时是 z）；`baseY` 是细节底面高度。
 */
function placeOnFace(detail, face, surface, along, baseY, s, stretchY = 1) {
  const axis = face[1];
  const sign = face[0] === "+" ? 1 : -1;
  const t = detail.bbox[5] * s;
  const off = sign * (surface + t);
  return transformGeo(detail.geo, {
    rotY: rotOfFace(face),
    sx: s, sy: s * stretchY, sz: s,
    tx: axis === "z" ? along : off,
    ty: baseY,
    tz: axis === "z" ? off : along,
  });
}

/** 把细节**自由摆**（伞这类不需要贴墙的）：局部原点（占地中心）放到距中心 `dist` 处 */
function placeFree(detail, face, dist, along, baseY, s) {
  const axis = face[1];
  const sign = face[0] === "+" ? 1 : -1;
  const off = sign * dist;
  return transformGeo(detail.geo, {
    rotY: rotOfFace(face),
    sx: s, sy: s, sz: s,
    tx: axis === "z" ? along : off,
    ty: baseY,
    tz: axis === "z" ? off : along,
  });
}

/** 长方体（24 顶点 / 12 三角，四个侧面一个色、顶面一个色）；中心 (cx,cy,cz) */
function boxGeo(w, h, d, cx, cy, cz, uvSide, uvTop) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const pos = [], nrm = [], uv = [], idx = [];
  const face = (n, corners, uvUse) => {
    const base = pos.length / 3;
    for (const p of corners) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0], n[1], n[2]);
      uv.push(uvUse[0], uvUse[1]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  face([1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], uvSide);
  face([-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], uvSide);
  face([0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], uvTop);
  face([0, -1, 0], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], uvSide);
  face([0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], uvSide);
  face([0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], uvSide);
  return { pos, nrm, uv, idx };
}

/**
 * 楼体自己用得最多的那一格贴图（返回该格中心的 UV，取不到返回 null）。
 * 程序化构件沿用它 ⇒ 加建部分与这栋楼同色系，而不是另调一个颜色。
 * 判定用的 `pred(中心x, 中心y, 中心z, 平均法线y)`；票数相同按格子坐标定序（无随机）。
 */
function dominantUv(a, pred) {
  const TEX = 512; // colormap 是 512×512 的 16×16 调色板（每格 32px）
  const q = (v) => Math.floor(Math.min(0.999999, Math.max(0, v)) * TEX);
  const count = new Map();
  for (let t = 0; t < a.tris; t++) {
    const i0 = a.idx[t * 3], i1 = a.idx[t * 3 + 1], i2 = a.idx[t * 3 + 2];
    const cx = (a.pos[i0 * 3] + a.pos[i1 * 3] + a.pos[i2 * 3]) / 3;
    const cy = (a.pos[i0 * 3 + 1] + a.pos[i1 * 3 + 1] + a.pos[i2 * 3 + 1]) / 3;
    const cz = (a.pos[i0 * 3 + 2] + a.pos[i1 * 3 + 2] + a.pos[i2 * 3 + 2]) / 3;
    const ny = (a.nrm[i0 * 3 + 1] + a.nrm[i1 * 3 + 1] + a.nrm[i2 * 3 + 1]) / 3;
    if (!pred(cx, cy, cz, ny)) continue;
    for (const i of [i0, i1, i2]) {
      const k = q(a.uv[i * 2]) * TEX + q(a.uv[i * 2 + 1]);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  let best = -1, bestN = -1;
  for (const [k, n] of count) {
    if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
  }
  if (best < 0) return null;
  return [(Math.floor(best / TEX) + 0.5) / TEX, ((best % TEX) + 0.5) / TEX];
}

/** 取 UV：先按 pred 找主体色；找不到就退到全楼主体色；再找不到用白色格中心 */
function uvOr(a, pred, dflt = null) {
  return dominantUv(a, pred) || (dflt ? dflt : dominantUv(a, () => true)) || [0.5, 0.5];
}

/** 变体几何的包围盒 / 尺寸（只看**该变体索引到**的顶点，所以退台/屋顶箱会真的变高） */
function statsOf(cluster, idx) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k] * 3;
    const x = cluster.pos[i], y = cluster.pos[i + 1], z = cluster.pos[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (Math.abs(minY) < 1e-6) minY = 0;
  return {
    bbox: [minX, minY, minZ, maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** 顶层平台（最高那一小块水平面）的矩形：设备箱要**坐在真屋面上**，
 *  不能按整栋占地摆 —— 带塔冠的楼那样会把箱子摆到半空中。 */
function roofTopRect(base) {
  const H = base.size[1];
  const yTop = H - Math.max(0.004, 0.02 * H);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
  for (let i = 0; i < base.verts; i++) {
    const y = base.pos[i * 3 + 1];
    if (y < yTop) continue;
    const x = base.pos[i * 3], z = base.pos[i * 3 + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    n += 1;
  }
  if (n < 3 || !(x1 - x0 > 1e-3) || !(z1 - z0 > 1e-3)) return null;
  return { x0, x1, z0, z1 };
}

/** 屋顶设备箱：顶层平台内缩的 1~3 个小盒（槽位/尺寸按名字哈希取，定序） */
function addRoofBoxes(idx, base, uvRoof, uvWall) {
  const H = base.size[1];
  const W = base.size[0], D = base.size[2];
  const rect = roofTopRect(base) || { x0: -0.25 * W, x1: 0.25 * W, z0: -0.25 * D, z1: 0.25 * D };
  const rw = rect.x1 - rect.x0, rd = rect.z1 - rect.z0;
  const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
  const slots = [[-0.22, -0.20], [0.22, -0.20], [-0.20, 0.22], [0.20, 0.22]];
  const k = 1 + (hashOf(base.name + "|roofbox-n") % 3);
  const start = hashOf(base.name + "|roofbox-slot") % slots.length;
  const notes = [];
  for (let i = 0; i < k; i++) {
    const sl = slots[(start + i) % slots.length];
    const w = rw * lerp(C.roofBoxW[0], C.roofBoxW[1], unitOf(base.name + "|roofbox-w" + i));
    const d = rd * lerp(C.roofBoxD[0], C.roofBoxD[1], unitOf(base.name + "|roofbox-d" + i));
    const h = H * lerp(C.roofBoxH[0], C.roofBoxH[1], unitOf(base.name + "|roofbox-h" + i));
    addRaw(idx, boxGeo(w, h, d, cx + sl[0] * rw, H + h / 2, cz + sl[1] * rd, uvWall, uvRoof));
    notes.push(Math.round((100 * w) / Math.max(1e-3, rw)) + "%台");
  }
  return notes;
}

/* 顶点追加的统一入口：`add()` 依赖族 cluster，这里用一个可替换的当前簇引用（单线程、构建期） */
let CUR_CLUSTER = null;
function addRaw(idxList, g) {
  const cl = CUR_CLUSTER;
  const start = cl.pos.length / 3;
  pushAll(cl.pos, g.pos);
  pushAll(cl.nrm, g.nrm);
  pushAll(cl.uv, g.uv);
  for (let i = 0; i < g.idx.length; i++) idxList.push(start + g.idx[i]);
}

/**
 * 一个基础资产 → `{ cluster, assets[] }`（base + 2 个变体）。
 * 变体共享同一个顶点块（见文件头），各自只记录自己的索引。
 */
function deriveFamily(base, details) {
  const W = base.size[0], H = base.size[1], D = base.size[2];
  /* 立面朝向：挑**更长的那一对**立面（底商更多、雨棚排得下） */
  const longZ = W >= D;
  const faceW = longZ ? W : D;
  const faceDist = (longZ ? D : W) / 2;
  const faces = longZ ? ["+z", "-z"] : ["+x", "-x"];

  const cluster = { pos: Array.from(base.pos), nrm: Array.from(base.nrm), uv: Array.from(base.uv) };
  CUR_CLUSTER = cluster;
  const baseIdx = Array.from(base.idx);
  const variants = []; // [{suffix, idx, notes[]}]

  const uvWall = uvOr(base, (x, y, z, ny) => Math.abs(ny) < 0.5 && y > 0.25 * H && y < 0.85 * H);
  const uvGround = uvOr(base, (x, y, z, ny) => Math.abs(ny) < 0.5 && y < 0.3 * H, uvWall);
  const uvRoof = uvOr(base, (x, y, z, ny) => ny > 0.7, uvWall);

  /* ── 中楼：@awning（基座加宽 + 雨棚） / @roofbox ── */
  if (base.class === "mid") {
    {
      const idx = baseIdx.slice();
      const notes = [];
      /* 基座加宽：底部 1 层外扩一圈（底商立面取楼体自己的底层色） */
      const podOut = C.podiumOut * Math.min(W, D);
      const podH = C.podiumH * H;
      addRaw(idx, boxGeo(W + 2 * podOut, podH, D + 2 * podOut, 0, podH / 2, 0, uvWall, uvRoof));
      notes.push("基座+" + (podOut * 2 / W * 100).toFixed(0) + "%");
      /* 雨棚：立面 1~2 块 × 两侧立面 ⇒ 2~4 块 */
      const src = faceW >= 1.25 ? details.awningWide : details.awning;
      const awW = faceW * C.awningW;
      const s = Math.max(0.05, Math.min(awW / Math.max(1e-3, src.size[0]), (H * C.awningH) / Math.max(1e-3, src.size[1])));
      const stretch = Math.min(C.stretchMax, Math.max(C.stretchMin, (H * C.awningH) / (src.size[1] * s)));
      const two = faceW >= awW * C.awningTwo;
      const along = two ? [-faceW * C.awningSpread, faceW * C.awningSpread] : [0];
      let n = 0;
      for (const f of faces) {
        for (const al of along) {
          /* 贴到**基座外表面**而不是楼体墙面：基座比楼体宽，贴墙会把雨棚的柱子埋进基座里 */
          addRaw(idx, placeOnFace(src, f, faceDist + podOut, al, 0, s, stretch));
          n += 1;
        }
      }
      notes.push(n + "雨棚");
      variants.push({ suffix: "@awning", idx, notes });
    }
    {
      const idx = baseIdx.slice();
      const notes = ["屋顶箱"];
      const boxes = addRoofBoxes(idx, base, uvRoof, uvWall);
      notes.push(boxes.length + "个");
      variants.push({ suffix: "@roofbox", idx, notes });
    }
  }

  /* ── 矮楼：@parasol（底商前的伞） / @roofbox ── */
  if (base.class === "low") {
    {
      const idx = baseIdx.slice();
      const notes = [];
      const src = hashOf(base.name + "|parasol-src") % 2 ? details.parasolB : details.parasolA;
      const pw = faceW * C.parasolW;
      const s = Math.max(0.05, Math.min(pw / Math.max(1e-3, src.size[0]), (H * C.parasolH) / Math.max(1e-3, src.size[1])));
      const two = hashOf(base.name + "|parasol-n") % 2 === 0;
      const along = two ? [-faceW * 0.22, faceW * 0.22] : [0];
      /* 伞心摆在外墙面外一点：伞面内侧刚好压住墙，不悬空 */
      const dist = faceDist + 0.45 * src.size[2] * s;
      for (const al of along) addRaw(idx, placeFree(src, faces[0], dist, al, 0, s));
      notes.push(along.length + "把伞");
      variants.push({ suffix: "@parasol", idx, notes });
    }
    {
      const idx = baseIdx.slice();
      const notes = ["屋顶箱"];
      const boxes = addRoofBoxes(idx, base, uvRoof, uvWall);
      notes.push(boxes.length + "个");
      variants.push({ suffix: "@roofbox", idx, notes });
    }
  }

  /* ── 高楼：@overhang（顶部挑檐 + 底层门廊） / @setback（退台） ── */
  if (base.class === "tall") {
    {
      const idx = baseIdx.slice();
      const notes = [];
      /* 顶部一圈挑檐：外扩一圈的薄板（压住屋面外沿） */
      const cw = W + 2 * C.corniceOut * W;
      const cd = D + 2 * C.corniceOut * D;
      const ch = C.corniceH * H;
      addRaw(idx, boxGeo(cw, ch, cd, 0, H - 0.008 * H + ch / 2, 0, uvRoof, uvRoof));
      notes.push("挑檐");
      /* 底层门廊：每个立面正中一座（并排两座会缩成"脚手架"，2026-10-25 离线对照图实测） */
      const src = details.overhang;
      const ow = faceW * C.overhangW;
      const s = Math.max(0.05, Math.min(ow / Math.max(1e-3, src.size[0]), (H * C.overhangH) / Math.max(1e-3, src.size[1])));
      const stretch = Math.min(C.overhangStretch, Math.max(C.stretchMin, (H * C.overhangH) / (src.size[1] * s)));
      let n = 0;
      for (const f of faces) {
        addRaw(idx, placeOnFace(src, f, faceDist, 0, 0, s, stretch));
        n += 1;
      }
      notes.push(n + "门廊");
      variants.push({ suffix: "@overhang", idx, notes });
    }
    {
      const idx = baseIdx.slice();
      const notes = [];
      /* 退台檐口：比楼体宽一圈的薄板，标出"上一层"的分界 */
      const lw = W * (1 + 2 * C.ledgeOut);
      const ld = D * (1 + 2 * C.ledgeOut);
      const lh = C.ledgeH * H;
      const ledgeTop = H - 0.006 * H + lh;
      addRaw(idx, boxGeo(lw, lh, ld, 0, H - 0.006 * H + lh / 2, 0, uvRoof, uvRoof));
      notes.push("檐口");
      /* 上部小一号的盒：形成收分轮廓（侧面用楼体墙面色，顶面用屋面色） */
      const tw = W * C.setbackScale;
      const td = D * C.setbackScale;
      const th = C.setbackH * H;
      addRaw(idx, boxGeo(tw, th, td, 0, ledgeTop + th / 2, 0, uvWall, uvRoof));
      notes.push("退台+16%");
      variants.push({ suffix: "@setback", idx, notes });
    }
  }

  if (!variants.length) throw new Error(base.name + "：没有派生任何变体（class=" + base.class + "）");

  /* ── 组装：base + 变体，全部共享同一个顶点块 ── */
  const verts = cluster.pos.length / 3;
  const assets = [];
  {
    const st = statsOf(cluster, baseIdx);
    assets.push({
      name: base.name,
      class: base.class,
      family: base.name,
      idx: Uint32Array.from(baseIdx),
      tris: baseIdx.length / 3,
      bbox: st.bbox,
      size: st.size,
      pos: cluster.pos,
      nrm: cluster.nrm,
      uv: cluster.uv,
      verts,
      textureUri: base.textureUri,
      notes: ["基础"],
    });
  }
  for (const v of variants) {
    const st = statsOf(cluster, v.idx);
    assets.push({
      name: base.name + v.suffix,
      class: base.class,
      family: base.name,
      idx: Uint32Array.from(v.idx),
      tris: v.idx.length / 3,
      bbox: st.bbox,
      size: st.size,
      pos: cluster.pos,
      nrm: cluster.nrm,
      uv: cluster.uv,
      verts,
      textureUri: base.textureUri,
      notes: v.notes,
    });
  }
  return { cluster, assets };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、打成一个包
 * ══════════════════════════════════════════════════════════════════════════ */

const align4 = (n) => (n + 3) & ~3;

function packAssets(assets) {
  /* 段序：pos(f32) → uv(u16 归一化) → shade(u8) → idx(u16)。
     顶点段**每族一份**（同族资产引用同一段），索引段每个资产一份。 */
  const blocks = new Map();
  const blockList = [];
  for (const a of assets) {
    if (blocks.has(a.family)) continue;
    const b = { family: a.family, pos: a.pos, nrm: a.nrm, uv: a.uv, verts: a.verts };
    blocks.set(a.family, b);
    blockList.push(b);
  }

  let off = 0;
  const posOff = new Map();
  for (const b of blockList) { off = align4(off); posOff.set(b.family, off); off += b.verts * 3 * 4; }
  const uvOff = new Map();
  for (const b of blockList) { off = align4(off); uvOff.set(b.family, off); off += b.verts * 2 * 2; }
  const shadeOff = new Map();
  for (const b of blockList) { off = align4(off); shadeOff.set(b.family, off); off += b.verts; }
  const idxOff = new Map();
  for (const a of assets) { off = align4(off); idxOff.set(a.name, off); off += a.idx.length * 2; }
  const total = align4(off);
  const buf = new ArrayBuffer(total);

  for (const b of blockList) {
    if (b.verts > 65535) throw new Error(b.family + "：顶点超过 65535，u16 索引装不下");
    /* 位置：原样 float32 */
    const f32 = new Float32Array(buf, posOff.get(b.family), b.verts * 3);
    for (let k = 0; k < b.verts * 3; k++) f32[k] = b.pos[k];
    /* UV：0..1 → uint16 归一化 */
    const u16 = new Uint16Array(buf, uvOff.get(b.family), b.verts * 2);
    for (let k = 0; k < b.verts * 2; k++) u16[k] = Math.round(Math.min(1, Math.max(0, b.uv[k])) * 65535);
    /* 明暗：1 字节（与 wsBldMesh 同一套 Lambert；顶面 1.0） */
    const shade = new Uint8Array(buf, shadeOff.get(b.family), b.verts);
    for (let k = 0; k < b.verts; k++) {
      const nx = b.nrm[k * 3], ny = b.nrm[k * 3 + 1], nz = b.nrm[k * 3 + 2];
      const d = nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2];
      const kk = ny > 0.7 ? 1 : AMBIENT_K + SUN_K * Math.max(0, d);
      shade[k] = Math.round(Math.min(1, Math.max(0, kk)) * 255);
    }
  }

  const meta = [];
  for (const a of assets) {
    const idxCount = a.idx.length;
    if (a.verts <= 0) throw new Error(a.name + "：没有顶点");
    let maxIdx = 0;
    for (let k = 0; k < idxCount; k++) if (a.idx[k] > maxIdx) maxIdx = a.idx[k];
    if (maxIdx >= a.verts) throw new Error(a.name + "：索引越界 " + maxIdx + " ≥ " + a.verts);
    const idx = new Uint16Array(buf, idxOff.get(a.name), idxCount);
    for (let k = 0; k < idxCount; k++) idx[k] = a.idx[k];
    meta.push({
      name: a.name,
      class: a.class,
      /** 顶点块所属的族（同族资产共享 pos/uv/shade 段） */
      family: a.family,
      verts: a.verts,
      tris: a.tris,
      pos: posOff.get(a.family),
      uv: uvOff.get(a.family),
      shade: shadeOff.get(a.family),
      idx: idxOff.get(a.name),
      idxCount,
      /** [minX, minY, minZ, maxX, maxY, maxZ]（已平移到占地中心 / 底面 0；只覆盖本资产索引到的三角形） */
      bbox: a.bbox.map((x) => Math.round(x * 1000) / 1000),
      /** 占地尺寸 [w, h, d]（米/资产单位：Kenney 1 单位 ≈ 1 米，运行时再缩） */
      size: a.size.map((x) => Math.round(x * 1000) / 1000),
      /** 该资产用到的贴图（共享 colormap） */
      tex: a.textureUri ? path.basename(a.textureUri) : null,
    });
  }
  return { buf, meta, total, blocks: blockList.map((b) => ({ family: b.family, verts: b.verts })) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 五、CLI
 * ══════════════════════════════════════════════════════════════════════════ */

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : dflt;
}

function loadDetails(src) {
  const out = {};
  for (const [key, name] of Object.entries(DETAIL_NAMES)) {
    const file = path.join(src, name + ".glb");
    if (!fs.existsSync(file)) throw new Error("找不到细节素材：" + file);
    const a = extractAsset(fs.readFileSync(file), name);
    out[key] = {
      name,
      size: a.size,
      bbox: a.bbox,
      geo: { pos: Array.from(a.pos), nrm: Array.from(a.nrm), uv: Array.from(a.uv), idx: Array.from(a.idx) },
    };
  }
  return out;
}

/** 纯构建（不写盘）：两次调用必须逐字节相同（`--verify` 用它比较） */
function buildPack(src, wanted) {
  const all = fs.readdirSync(src).filter((f) => f.endsWith(".glb")).map((f) => f.replace(/\.glb$/, ""));
  const list = wanted.filter((n) => all.includes(n));
  if (!list.length) throw new Error("源目录里找不到要的 GLB：" + src);
  const details = loadDetails(src);

  const assets = [];
  const families = [];
  for (const name of list) {
    const base = extractAsset(fs.readFileSync(path.join(src, name + ".glb")), name);
    /* 共享贴图断言：所有资产必须引用同一张 colormap（不然运行时一张纹理画不了全部） */
    if (base.textureUri && path.basename(base.textureUri) !== "colormap.png") {
      throw new Error(name + "：贴图不是 colormap.png（" + base.textureUri + "），运行时只带一张");
    }
    const fam = deriveFamily(base, details);
    families.push({ base, assets: fam.assets });
    for (const a of fam.assets) assets.push(a);
  }
  /* 单资产三角上限（超了说明派生参数失控） */
  for (const a of assets) {
    if (a.tris > MAX_ASSET_TRIS) throw new Error(a.name + "：三角 " + a.tris + " 超过上限 " + MAX_ASSET_TRIS);
  }
  const packed = packAssets(assets);
  return { ...packed, assets, families };
}

function main() {
  const src = path.resolve(argOf("--src", path.join(os.homedir(), "chk/_bldlab/kk")));
  const out = path.resolve(argOf("--out", path.join(REPO, "public/ws3d/bldassets")));
  const only = argOf("--only", "main");
  const dry = process.argv.includes("--dry");
  const verify = process.argv.includes("--verify");

  const all = fs.readdirSync(src).filter((f) => f.endsWith(".glb")).map((f) => f.replace(/\.glb$/, "")).sort();
  const wanted = only === "all" ? all : only === "main" ? MAIN_ASSETS.filter((n) => all.includes(n)) : only.split(",");
  if (!wanted.length) throw new Error("源目录里找不到要的 GLB：" + src);

  const p = buildPack(src, wanted);
  const texPath = path.join(src, "Textures", "colormap.png");
  if (!fs.existsSync(texPath)) throw new Error("找不到共享贴图：" + texPath);
  const texBytes = fs.readFileSync(texPath);
  const png = pngSize(texBytes);

  let tris = 0, verts = 0, blockVerts = 0;
  for (const m of p.meta) { tris += m.tris; verts += m.verts; }
  for (const b of p.blocks) blockVerts += b.verts;

  const pack = {
    v: 1,
    generator: "scripts/build-bld-assets.mjs",
    source: "Kenney City Kit Commercial 2.1 (CC0-1.0)",
    license: "CC0-1.0",
    texture: "colormap.png",
    textureSize: png,
    bin: "pack.bin",
    binBytes: p.total,
    /** 资产数/三角数是**逐资产**的合计；`verts` 也是逐资产合计（同族重复计），
     *  `blockVerts` 才是 bin 里真实存了多少个顶点（顶点块按族共享）。 */
    counts: { assets: p.meta.length, verts, blockVerts, blocks: p.blocks.length, tris },
    /** 段布局：每顶点 pos=12B float32 / uv=4B uint16 归一化 / shade=1B；索引 uint16 = 2B
     *  （顶点段按 `blocks` 一族一份；`assets[].family` 说明它用哪一段） */
    layout: { pos: "f32x3", uv: "u16x2 normalized", shade: "u8", idx: "u16" },
    blocks: p.blocks,
    assets: p.meta,
  };
  const json = JSON.stringify(pack, null, 2) + "\n";
  const jsonBytes = Buffer.byteLength(json);
  const packBytes = p.total + texBytes.length + jsonBytes;

  console.log("── 资产包（派生后）──");
  for (const fam of p.families) {
    const block = p.blocks.find((b) => b.family === fam.base.name);
    const head = fam.assets[0];
    console.log(
      `  ${head.name.padEnd(28)} ${String(block ? block.verts : head.verts).padStart(6)} v ` +
        `${String(head.tris).padStart(6)} tri  w×h×d=${head.size.map((x) => x.toFixed(2)).join(" × ")}`
    );
    for (const v of fam.assets.slice(1)) {
      console.log(
        `    ${v.name.slice(fam.base.name.length).padEnd(10)} ${String("").padStart(6)}   ` +
          `${String(v.tris).padStart(6)} tri  w×h×d=${v.size.map((x) => x.toFixed(2)).join(" × ")}  ` +
          `[${v.notes.join(" ")}]`
      );
    }
  }
  console.log(
    `  合计 ${p.meta.length} 个资产（${p.blocks.length} 族 · ${blockVerts} 个**唯一**顶点 / 逐资产合计 ${verts}）· ` +
      `${tris} 三角 · bin ${(p.total / 1024).toFixed(0)} KB · 贴图 ${(texBytes.length / 1024).toFixed(0)} KB ${png[0]}×${png[1]}`
  );
  console.log(`  包总计 ${(packBytes / 1048576).toFixed(2)} MiB（${packBytes} B，上限 ${MAX_PACK_BYTES} B）`);
  const worst = p.meta.reduce((m, x) => (x.tris > m.tris ? x : m), p.meta[0]);
  console.log(`  单栋最大三角：${worst.name} ${worst.tris} tri（上限 ${MAX_ASSET_TRIS}）`);
  if (packBytes > MAX_PACK_BYTES) throw new Error("包体超过上限：" + packBytes + " > " + MAX_PACK_BYTES);

  if (verify) {
    /* 确定性自检：同一份源码连跑两遍，边与清单都必须逐字节相同 */
    const p2 = buildPack(src, wanted);
    const pack2 = { ...pack, counts: pack.counts, blocks: p2.blocks, assets: p2.meta, binBytes: p2.total };
    const json2 = JSON.stringify(pack2, null, 2) + "\n";
    const h = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const hb1 = h(Buffer.from(p.buf)), hb2 = h(Buffer.from(p2.buf));
    const hj1 = h(Buffer.from(json)), hj2 = h(Buffer.from(json2));
    console.log("  确定性自检（两次构建）：");
    console.log(`    pack.bin  ${hb1}`);
    console.log(`    pack.bin  ${hb2}`);
    console.log(`    pack.json ${hj1}`);
    console.log(`    pack.json ${hj2}`);
    if (hb1 !== hb2 || hj1 !== hj2) {
      console.log("  ✗ 两次构建不一致");
      process.exitCode = 1;
      return;
    }
    console.log("  ✓ 逐字节一致");
  }

  if (dry) {
    console.log("（--dry：不写盘）");
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "pack.bin"), Buffer.from(p.buf));
  fs.writeFileSync(path.join(out, "pack.json"), json);
  fs.writeFileSync(path.join(out, "colormap.png"), texBytes);
  fs.writeFileSync(
    path.join(out, "LICENSE.txt"),
    [
      "Kenney City Kit Commercial 2.1",
      "Source: https://kenney.nl/assets/city-kit-commercial",
      "License: CC0-1.0（公共领域；可商用、署名非必需）",
      "本目录只保留运行时需要的几何（pack.bin）与共享贴图（colormap.png）。",
      "基础模型与 detail-* 细节件由 scripts/build-bld-assets.mjs 解析后程序化派生变体",
      "（基座加宽 / 雨棚 / 挑檐 / 退台 / 屋顶设备箱 / 遮阳伞），派生结果仍属 CC0 衍生作品。",
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
