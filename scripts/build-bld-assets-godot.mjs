#!/usr/bin/env node
/* build-bld-assets-godot.mjs —— 把 Godot（GLTFDocument）导出的建筑 GLB 压成运行时的
 * **资产包 v2**（顶点色、无贴图），供近景资产档加载。
 *
 * 与 `scripts/build-bld-assets.mjs`（v1，Kenney + 贴图调色板）的区别：
 *   · 一个模型只有**一种材质** —— 每个 primitive 的 baseColorFactor 烘成逐顶点 RGB；
 *   · 不存 UV、不存贴图、不存法线：材质是 `MeshBasicMaterial({ vertexColors: true })`，
 *     光照不参与（与程序化那条路同一做法）；
 *   · 顶点可以按 (position, color) 合并（没有逐面法线要保留），所以顶点数远少于源文件。
 *
 * ## 烘法（运行时按这个口径反解）
 *   1. 遍历场景里所有带 mesh 的节点，沿父链把 TRS/matrix 乘成世界矩阵，再烘进顶点；
 *   2. 每个 primitive 取 `materials[i].pbrMetallicRoughness.baseColorFactor`（缺省白色）作为
 *      该 primitive 全部顶点的颜色；贴图（如果有）忽略；
 *   3. glTF 的 baseColorFactor 是**线性**空间的值，这里换算成 **sRGB** 再量化成 u8×3
 *      （sRGB 传输函数：c ≤ 0.0031308 → 12.92c，其余 1.055·c^(1/2.4) − 0.055）；
 *      运行时按 sRGB→线性解码回工作空间（见 `wsBldAssets.ts` 的 `srgbByteToLinear`）；
 *   4. 每个模型平移到「占地中心在原点、底面 y=0」，与 v1 包的约定一致 —— 运行时只做
 *      平移 × 绕 Y 旋转 × 非均匀缩放。
 *
 * ## 产出（默认 `public/ws3d/bldassets_godot/`）
 *   pack.bin   所有模型拼成一个 ArrayBuffer：pos(f32×3) → color(u8×3) → idx(u32)，段首 4 字节对齐
 *   pack.json  清单：v=2、layout、counts、assets[]（name/class/pool/verts/tris/偏移/bbox/size）
 *
 * ## 纪律
 *   · 零第三方依赖（只用 node 内置）；
 *   · 输出确定性：文件按名字排序、偏移按固定顺序累加、不写时间戳/随机数；
 *     `--verify` 连跑两遍比 sha256（bin 与 json 都要逐字节一致）；
 *   · 包体上限 2 MB（十进制，最严口径），超了直接报错，不做静默截断。
 *
 * 用法：
 *   node scripts/build-bld-assets-godot.mjs [--src DIR] [--out DIR] [--only a,b] [--dry] [--verify]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** 源目录：Godot 导出的 18 个 GLB（6 类 × 3 变体）；可用 --src / GODOT_BLD_SRC 覆盖 */
const DEFAULT_SRC = process.env.GODOT_BLD_SRC || "/storage/emulated/0/Documents/godot_blds";
const DEFAULT_OUT = path.join(REPO, "public/ws3d/bldassets_godot");

/** 包体上限（2 MB，十进制） */
const MAX_PACK_BYTES = 2 * 1000 * 1000;
/** 单个模型三角上限（超过说明源文件不是这类近景资产） */
const MAX_ASSET_TRIS = 20000;

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

/** accessor → 紧凑 typed array（尊重 bufferView.byteStride） */
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
  const span = count ? (count - 1) * stride + comps * sizeOf(acc.componentType) : 0;
  const dv = new DataView(bin.buffer, bin.byteOffset + base, span);
  const elem = sizeOf(acc.componentType);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = i * stride + c * elem;
      switch (acc.componentType) {
        case 5120: out[i * comps + c] = dv.getInt8(o); break;
        case 5121: out[i * comps + c] = dv.getUint8(o); break;
        case 5122: out[i * comps + c] = dv.getInt16(o, true); break;
        case 5123: out[i * comps + c] = dv.getUint16(o, true); break;
        case 5125: out[i * comps + c] = dv.getUint32(o, true); break;
        case 5126: out[i * comps + c] = dv.getFloat32(o, true); break;
        default: throw new Error("不认识的 componentType: " + acc.componentType);
      }
    }
  }
  return { data: out, comps, count };
}

/* ── 4×4 矩阵（列主序，与 glTF 一致） ── */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
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

function applyMat4(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、颜色：线性 baseColorFactor → sRGB u8
 * ══════════════════════════════════════════════════════════════════════════ */

const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** 线性分量 → sRGB 字节（u8）。量化前先做 sRGB 传输函数，运行时再解码回线性。 */
export function linearToSrgbByte(c) {
  const v = clamp01(Number.isFinite(c) ? c : 0);
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、单模型提取：烘节点变换 + 烘材质基色 + 顶点合并
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 遍历场景里所有 mesh 节点。返回 `[{ mesh, world }]`（深度优先，顺序固定）。
 * glTF 允许同一 node 被多个父节点引用（skin 之外很少见），这里按"每个节点只走一次"处理。
 */
function collectInstances(json) {
  const out = [];
  const nodes = json.nodes || [];
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes?.length ? scene.nodes : nodes.map((_, i) => i);
  const seen = new Set();
  const walk = (ni, parentMat) => {
    if (ni == null || ni < 0 || ni >= nodes.length) return;
    if (seen.has(ni)) return;
    seen.add(ni);
    const node = nodes[ni];
    const world = mul(parentMat, trsMatrix(node));
    if (node.mesh != null) out.push({ node, mesh: node.mesh, world });
    for (const c of node.children || []) walk(c, world);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of roots) walk(r, I);
  return out;
}

/**
 * 解析一个 GLB → 世界坐标几何（已平移到占地中心/底面 y=0）。
 * 返回 `{ pos: Float32Array, color: Uint8Array, idx: Uint32Array, tris, bbox, size, matCount }`。
 */
export function extractAsset(buf, label) {
  const { json, bin } = parseGlb(buf);
  if (!bin) throw new Error(label + "：没有 BIN chunk");
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const materials = json.materials || [];

  const posList = [];
  const colList = [];
  const idxList = [];
  const vertexKey = new Map();
  let matCount = 0;

  const tmp = [0, 0, 0];
  for (const inst of collectInstances(json)) {
    const mesh = meshes[inst.mesh];
    if (!mesh) throw new Error(label + "：mesh 索引越界 " + inst.mesh);
    for (const prim of mesh.primitives || []) {
      if ((prim.mode ?? 4) !== 4) throw new Error(label + "：只支持三角形（mode=4），拿到 " + prim.mode);
      const posAcc = readAccessor(json, bin, prim.attributes?.POSITION);
      if (!posAcc || posAcc.comps !== 3) throw new Error(label + "：primitive 缺 POSITION");
      /* 材质基色：缺省白色；贴图忽略（Godot 这套实际只有纯色材质） */
      const mat = prim.material != null ? materials[prim.material] : null;
      const f = mat?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
      const cr = linearToSrgbByte(f[0]);
      const cg = linearToSrgbByte(f[1]);
      const cb = linearToSrgbByte(f[2]);
      matCount += 1;

      const vmap = new Int32Array(posAcc.count);
      for (let i = 0; i < posAcc.count; i++) {
        applyMat4(inst.world, posAcc.data[i * 3], posAcc.data[i * 3 + 1], posAcc.data[i * 3 + 2], tmp);
        /* 用 float32 存进去之后的值做键（与写盘的精度一致；避免 -0 与 0 分家已由加法归一） */
        const x = Math.fround(tmp[0] + 0), y = Math.fround(tmp[1] + 0), z = Math.fround(tmp[2] + 0);
        const key = x + "," + y + "," + z + "," + cr + "," + cg + "," + cb;
        let vi = vertexKey.get(key);
        if (vi === undefined) {
          vi = posList.length / 3;
          vertexKey.set(key, vi);
          posList.push(x, y, z);
          colList.push(cr, cg, cb);
        }
        vmap[i] = vi;
      }

      if (prim.indices != null) {
        const ia = readAccessor(json, bin, prim.indices);
        if (ia.comps !== 1) throw new Error(label + "：indices 不是 SCALAR");
        for (let i = 0; i < ia.count; i++) {
          const vi = vmap[ia.data[i]];
          if (vi === undefined) throw new Error(label + "：索引越界");
          idxList.push(vi);
        }
      } else {
        for (let i = 0; i < vmap.length; i++) idxList.push(vmap[i]);
      }
    }
  }
  if (!idxList.length) throw new Error(label + "：没有三角形");
  if (idxList.length % 3 !== 0) throw new Error(label + "：索引数不是 3 的倍数");

  /* 平移到「占地中心在原点、底面 y=0」 */
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posList.length; i += 3) {
    const x = posList[i], y = posList[i + 1], z = posList[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const ox = (minX + maxX) / 2;
  const oy = minY;
  const oz = (minZ + maxZ) / 2;
  const pos = new Float32Array(posList.length);
  for (let i = 0; i < posList.length; i += 3) {
    pos[i] = Math.fround(posList[i] - ox);
    pos[i + 1] = Math.fround(posList[i + 1] - oy);
    pos[i + 2] = Math.fround(posList[i + 2] - oz);
  }
  const color = Uint8Array.from(colList);
  const idx = Uint32Array.from(idxList);

  const bbox = [
    Math.fround(minX - ox), 0, Math.fround(minZ - oz),
    Math.fround(maxX - ox), Math.fround(maxY - minY), Math.fround(maxZ - oz),
  ];
  const size = [
    Math.fround(maxX - minX), Math.fround(maxY - minY), Math.fround(maxZ - minZ),
  ];
  return { pos, color, idx, tris: idx.length / 3, bbox, size, matCount };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、拼包（确定性：资产按名字排序，段按 pos→color→idx 累加，段首 4 字节对齐）
 * ══════════════════════════════════════════════════════════════════════════ */

const align4 = (n) => (n + 3) & ~3;

/** 名字 → 建筑类别（conv/cafe/rest/pharm/bank/house） */
function classOf(name) {
  const m = /^([a-z]+)_\d+$/.exec(name);
  return m ? m[1] : name.replace(/_\d+$/, "");
}

/** 名字/高度 → 运行时挑资产的池子（与 `wsBldAssets.pickAssetIndex` 的三档对齐） */
function poolOf(_cls, h) {
  if (h < 8) return "low";
  if (h < 20) return "mid";
  return "tall";
}

function buildPack(src, wanted) {
  const assets = [];
  const blocks = [];
  let total = 0;
  for (const name of wanted) {
    const file = path.join(src, name + ".glb");
    const a = extractAsset(fs.readFileSync(file), name);
    if (a.tris > MAX_ASSET_TRIS) throw new Error(name + "：三角 " + a.tris + " 超过上限 " + MAX_ASSET_TRIS);
    const pts = a.pos.length / 3;
    const posOff = align4(total);
    total = posOff + pts * 12;
    const colOff = total;
    total = colOff + pts * 3;
    const idxOff = align4(total);
    total = idxOff + a.idx.length * 4;
    const cls = classOf(name);
    assets.push({
      name,
      class: cls,
      pool: poolOf(cls, a.size[1]),
      verts: pts,
      tris: a.tris,
      pos: posOff,
      color: colOff,
      idx: idxOff,
      idxCount: a.idx.length,
      bbox: a.bbox.map((v) => Math.round(v * 1000) / 1000),
      size: a.size.map((v) => Math.round(v * 1000) / 1000),
    });
    blocks.push({ posOff, colOff, idxOff, a });
  }
  const buf = Buffer.alloc(total);
  for (const b of blocks) {
    Buffer.from(b.a.pos.buffer, b.a.pos.byteOffset, b.a.pos.byteLength).copy(buf, b.posOff);
    Buffer.from(b.a.color.buffer, b.a.color.byteOffset, b.a.color.byteLength).copy(buf, b.colOff);
    /* u32 段：逐元素小端写入（不依赖平台字节序） */
    for (let i = 0; i < b.a.idx.length; i++) buf.writeUInt32LE(b.a.idx[i], b.idxOff + i * 4);
  }
  let verts = 0, tris = 0;
  for (const m of assets) { verts += m.verts; tris += m.tris; }
  return { buf, assets, blocks, total, counts: { assets: assets.length, verts, tris } };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 五、命令行
 * ══════════════════════════════════════════════════════════════════════════ */

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function sha256(b) {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function main() {
  let src = path.resolve(argOf("--src", DEFAULT_SRC));
  if (!fs.existsSync(src) && fs.existsSync(ABS_FALLBACK_SRC)) src = ABS_FALLBACK_SRC;
  const out = path.resolve(argOf("--out", DEFAULT_OUT));
  const dry = process.argv.includes("--dry");
  const verify = process.argv.includes("--verify");
  const onlyArg = argOf("--only", "");

  if (!fs.existsSync(src)) throw new Error("源目录不存在：" + src);
  const all = fs
    .readdirSync(src)
    .filter((f) => f.endsWith(".glb"))
    .map((f) => f.replace(/\.glb$/, ""))
    .sort();
  const wanted = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : all;
  const missing = wanted.filter((n) => !all.includes(n));
  if (missing.length) throw new Error("源目录里没有这些 GLB：" + missing.join(", "));
  if (!wanted.length) throw new Error("源目录里没有 GLB：" + src);

  const p = buildPack(src, wanted);
  const pack = {
    v: 2,
    generator: "scripts/build-bld-assets-godot.mjs",
    source: "Godot 4.7.2 GLTFDocument export（程序化建筑模型，6 类 × 3 变体）",
    bin: "pack.bin",
    binBytes: p.total,
    counts: p.counts,
    /** 每顶点 pos=12B f32×3 / color=3B u8×3（sRGB）/ idx=4B u32；段首 4 字节对齐 */
    layout: { pos: "f32x3", color: "u8x3 sRGB", idx: "u32" },
    assets: p.assets,
  };
  const json = JSON.stringify(pack, null, 2) + "\n";
  const jsonBytes = Buffer.byteLength(json);
  const packBytes = p.total + jsonBytes;

  console.log("── 资产包 v2（Godot 建筑模型）──");
  for (const m of p.assets) {
    console.log(
      `  ${m.name.padEnd(9)} ${m.class.padEnd(6)} ${m.pool.padEnd(4)} ` +
        `${String(m.verts).padStart(5)} v ${String(m.tris).padStart(5)} tri  ` +
        `w×h×d=${m.size.map((x) => x.toFixed(2)).join(" × ")}`
    );
  }
  const worst = p.assets.reduce((m, x) => (x.tris > m.tris ? x : m), p.assets[0]);
  console.log(
    `  合计 ${p.assets.length} 个模型 · ${p.counts.verts} 顶点 · ${p.counts.tris} 三角 · ` +
      `bin ${(p.total / 1024).toFixed(1)} KB · json ${(jsonBytes / 1024).toFixed(1)} KB`
  );
  console.log(`  包总计 ${packBytes} B（${(packBytes / 1000).toFixed(2)} KB，上限 ${MAX_PACK_BYTES} B）`);
  console.log(`  单模型最大三角：${worst.name} ${worst.tris} tri（上限 ${MAX_ASSET_TRIS}）`);
  if (packBytes > MAX_PACK_BYTES) throw new Error("包体超过上限：" + packBytes + " > " + MAX_PACK_BYTES);

  if (verify) {
    /* 确定性自检：同一份源码连跑两遍，bin 与清单都要逐字节相同 */
    const p2 = buildPack(src, wanted);
    const pack2 = { ...pack, binBytes: p2.total, counts: p2.counts, assets: p2.assets };
    const json2 = JSON.stringify(pack2, null, 2) + "\n";
    const hb1 = sha256(p.buf);
    const hb2 = sha256(p2.buf);
    const hj1 = sha256(Buffer.from(json));
    const hj2 = sha256(Buffer.from(json2));
    console.log("  确定性自检（两次构建）：");
    console.log(`    pack.bin  ${hb1}`);
    console.log(`    pack.bin  ${hb2}`);
    console.log(`    pack.json ${hj1}`);
    console.log(`    pack.json ${hj2}`);
    if (hb1 !== hb2 || hj1 !== hj2 || p.total !== p2.total) {
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
  fs.writeFileSync(path.join(out, "pack.bin"), p.buf);
  fs.writeFileSync(path.join(out, "pack.json"), json);
  console.log("  写出 → " + path.relative(REPO, out) + "/{pack.json,pack.bin}");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
