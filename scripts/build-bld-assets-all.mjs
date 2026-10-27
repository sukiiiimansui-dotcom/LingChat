#!/usr/bin/env node
/* build-bld-assets-all.mjs —— 把 Blender 批量资产（bldcom / bldres / prop / vehicle / road）
 * 压成**一个**运行时资产包 v3（顶点色、无贴图），并带上挑模型的元数据。
 *
 * ## 与 v2（`build-bld-assets-godot.mjs`）的关系
 * 顶点烘焙、材质基色→sRGB 顶点色、平移到「占地中心/底面 y=0」全部复用 v2 的 `extractAsset`；
 * 本文件只多做三件事：
 *   ① 按类别目录读入，从各批 `manifest.json` 取 `height_m / footprint_w_m / footprint_d_m /
 *      floors / kind`（运行时按**真实楼高**挑模型，不做等比拉高）；
 *   ② 建筑超过 6k 三角的做**顶点聚类减面**（确定性，不用第三方库）；
 *   ③ 包体预算 6 MB（十进制）；`--verify` 连跑两遍比 sha256。
 *
 * ## 产出（默认 `public/ws3d/bldassets_all/`）
 *   pack.bin   pos(f32×3) → color(u8×3 sRGB) → idx(u32)，段首 4 字节对齐
 *   pack.json  v=3、layout、counts（含分类合计）、assets[]（category/kind/height_m/…）
 *
 * 用法：
 *   node scripts/build-bld-assets-all.mjs [--src DIR] [--out DIR] [--dry] [--verify]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractAsset } from "./build-bld-assets-godot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_SRC = process.env.BLD_ASSETS_SRC || path.join(process.env.HOME || "", "chk/_blender_assets");
const DEFAULT_OUT = path.join(REPO, "public/ws3d/bldassets_all");

/** 包体上限 6 MB（十进制） */
const MAX_PACK_BYTES = 6 * 1000 * 1000;
/** 建筑单件上限（超过就减面） */
const BLD_TRIS_MAX = 6000;
/** 其它类别的单件上限（只是护栏；这批素材都远低于它） */
const ITEM_TRIS_MAX = 20000;

/* ══════════════════════════════════════════════════════════════════════════
 * 一、减面：按三角形面积从小到大丢（确定性；不动大面，因此立面轮廓基本不变）
 *
 * 为什么不用顶点聚类：这批楼的管线/窗框顶点很密，聚类一格就会把 7k 直接砍到 2.5k ——
 * 超预算的只有 7%~23%，只需要丢"最小的那一点"，面积排序更接近"肉眼看不出"。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 丢掉面积最小的 (tris - maxTris) 个三角形，并把没用到的顶点压紧 */
export function decimate(pos, color, idx, maxTris) {
  const tris = idx.length / 3;
  if (tris <= maxTris) return { pos, color, idx, tris };
  const order = [];
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    order.push([Math.hypot(cx, cy, cz), t]);
  }
  order.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const drop = new Uint8Array(tris);
  for (let i = 0; i < tris - maxTris; i++) drop[order[i][1]] = 1;
  const keep = [];
  for (let t = 0; t < tris; t++) if (!drop[t]) keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  /* 压紧顶点：只保留还被索引到的顶点（保持原顺序，确定性） */
  const used = new Int32Array(pos.length / 3).fill(-1);
  const np = [];
  const nc = [];
  const ni = new Uint32Array(keep.length);
  for (let i = 0; i < keep.length; i++) {
    const v = keep[i];
    let nv = used[v];
    if (nv < 0) {
      nv = np.length / 3;
      used[v] = nv;
      np.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      nc.push(color[v * 3], color[v * 3 + 1], color[v * 3 + 2]);
    }
    ni[i] = nv;
  }
  return { pos: Float32Array.from(np), color: Uint8Array.from(nc), idx: ni, tris: ni.length / 3 };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、读入（每类一批；目录固定，清单字段各批不同）
 * ══════════════════════════════════════════════════════════════════════════ */

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * 批次归一化：用「manifest 层数 × 目标层高」反推这一批整体的比例。
 * 目标：首层（底商）3.9 m，其余每层 3.15 m；单层也按 4.0 m 算。
 * 一批的系数取该批所有楼 `expected/height` 的**中位数**，夹在 0.7~1.4。
 * 写进 pack.json 的 `norm`，转换器里直接作用到顶点与元数据（地图侧不再乱拉）。
 */
export function batchFactors(inputs) {
  const per = {};
  for (const it of inputs) {
    if (it.category !== "bld" || !(it.height_m > 0)) continue;
    const floors = Math.max(1, Number(it.floors) || 1);
    const expected = floors <= 1 ? 4.0 : 3.9 + (floors - 1) * 3.15;
    (per[it.batch] ||= []).push(expected / it.height_m);
  }
  const med = (a) => {
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)];
  };
  const out = {};
  for (const [k, a] of Object.entries(per)) out[k] = Math.round(Math.min(1.4, Math.max(0.7, med(a))) * 1000) / 1000;
  return out;
}

/** 只读审计：量一份 GLB 的玻璃（窗）竖向高度（没有语义节点，只能用材质名） */
export function glassStatsOf(file) {
  try {
    const buf = fs.readFileSync(file);
    /* 直接读 JSON/BIN（与 extractAsset 同一套容器解析） */
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
    const meshes = json.meshes || [];
    const mats = json.materials || [];
    let off = 20 + jl;
    let bin = null;
    const total = buf.readUInt32LE(8);
    while (off + 8 <= total) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
      off += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!bin) return null;
    const glassIdx = new Set();
    mats.forEach((m, i) => { if (/glass/i.test(String(m.name || ""))) glassIdx.add(i); });
    if (!glassIdx.size) return null;
    let minY = Infinity, maxY = -Infinity, n = 0;
    for (const mesh of meshes) {
      for (const p of mesh.primitives || []) {
        if (!glassIdx.has(p.material)) continue;
        const acc = json.accessors[p.attributes.POSITION];
        const bv = json.bufferViews[acc.bufferView];
        const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const stride = bv.byteStride || 12;
        for (let i = 0; i < acc.count; i++) {
          const y = bin.readFloatLE(base + i * stride + 4);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          n += 1;
        }
      }
    }
    return n ? { h: Math.round((maxY - minY) * 1000) / 1000, minY: Math.round(minY * 1000) / 1000, verts: n } : null;
  } catch {
    return null;
  }
}

/** 一批的输入清单：返回 `[{name, file, category, kind, height_m, w, d, floors, variant}]` */
function collectInputs(src) {
  const out = [];

  /* 商业楼 / 住宅楼：都放 bld 类，kind 用清单里的英文类别（cafe/retail/…） */
  for (const [dir, cat] of [["bldcom", "bld"], ["bldres", "bld"]]) {
    const mf = path.join(src, dir, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    const m = readJson(mf);
    for (const it of m.models || []) {
      const file = path.join(src, dir, "glb", it.name + ".glb");
      if (!fs.existsSync(file)) throw new Error("缺 GLB：" + file);
      out.push({
        name: it.name,
        file,
        category: cat,
        kind: String(it.kind || (it.name.match(/^bld_([a-z]+)_/) || [])[1] || "building"),
        height_m: Number(it.height_m) || 0,
        w: Number(it.footprint_w_m) || 0,
        d: Number(it.footprint_d_m) || 0,
        floors: Number(it.floors) || 0,
        variant: Number(it.variant) || 0,
        batch: dir,
      });
    }
  }

  /* 街道设施：清单里每个 prop 的 type/dims_m */
  {
    const mf = path.join(src, "prop/manifest.json");
    if (fs.existsSync(mf)) {
      const m = readJson(mf);
      for (const it of m.props || []) {
        const file = path.join(src, "prop", it.name + ".glb");
        if (!fs.existsSync(file)) throw new Error("缺 GLB：" + file);
        const dm = it.dims_m || {};
        out.push({
          name: it.name,
          file,
          category: "prop",
          kind: String(it.type || "prop"),
          height_m: Number(dm.h) || 0,
          w: Number(dm.w) || 0,
          d: Number(dm.d) || 0,
          floors: 0,
          variant: Number(it.variant) || 0,
          batch: "prop",
        });
      }
    }
  }

  /* 车辆：清单里每个 model 的 category/size_m */
  {
    const mf = path.join(src, "vehicle/manifest.json");
    if (fs.existsSync(mf)) {
      const m = readJson(mf);
      for (const it of m.models || []) {
        const file = path.join(src, "vehicle", it.name + ".glb");
        if (!fs.existsSync(file)) throw new Error("缺 GLB：" + file);
        const s = it.size_m || [];
        out.push({
          name: it.name,
          file,
          category: "vehicle",
          kind: String(it.category || "veh"),
          height_m: Number(s[1]) || 0,
          w: Number(s[0]) || 0,
          d: Number(s[2]) || 0,
          floors: 0,
          variant: 0,
          batch: "vehicle",
        });
      }
    }
  }

  /* 道路块：只入包、默认不画（等交互/瓦片方案定了再开） */
  {
    const mf = path.join(src, "road/manifest.json");
    if (fs.existsSync(mf)) {
      const m = readJson(mf);
      for (const it of m.pieces || []) {
        const file = path.join(src, "road", it.name + ".glb");
        if (!fs.existsSync(file)) throw new Error("缺 GLB：" + file);
        const sz = (it.bbox && it.bbox.size) || [];
        out.push({
          name: it.name,
          file,
          category: "road",
          kind: String(it.kind || "road").split(",")[0],
          height_m: Number(sz[1]) || 0,
          w: Number(sz[0]) || 0,
          d: Number(sz[2]) || 0,
          floors: 0,
          variant: 0,
          batch: "road",
        });
      }
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、拼包（确定性：按名字排序；pos → color → idx，段首 4 字节对齐）
 * ══════════════════════════════════════════════════════════════════════════ */

const align4 = (n) => (n + 3) & ~3;

function buildPack(src) {
  const inputs = collectInputs(src);
  if (!inputs.length) throw new Error("没读到任何 GLB：" + src);
  const factors = batchFactors(inputs);
  const glassCache = new Map();
  const assets = [];
  const blocks = [];
  let total = 0;
  for (const it of inputs) {
    const raw = extractAsset(fs.readFileSync(it.file), it.name);
    const limit = it.category === "bld" ? BLD_TRIS_MAX : ITEM_TRIS_MAX;
    const dec0 = decimate(raw.pos, raw.color, raw.idx, limit);
    if (dec0.tris > limit) throw new Error(it.name + "：减面后仍 " + dec0.tris + " 三角 > " + limit);
    /* 批次归一化：整批偏大/偏小在这里修正（地图侧只做 0.7~1.4 的等比缩放） */
    const f = factors[it.batch] ?? 1;
    let dec = dec0;
    if (f !== 1) {
      const scaled = new Float32Array(dec0.pos.length);
      for (let i = 0; i < dec0.pos.length; i++) scaled[i] = dec0.pos[i] * f;
      dec = { pos: scaled, color: dec0.color, idx: dec0.idx, tris: dec0.tris };
    }
    if (!glassCache.has(it.file)) glassCache.set(it.file, glassStatsOf(it.file));
    const glass = glassCache.get(it.file);
    const a = {
      name: it.name,
      category: it.category,
      kind: it.kind,
      variant: it.variant,
      batch: it.batch,
      norm_f: f,
      height_m: round3((it.height_m || raw.size[1]) * f),
      footprint_w_m: round3((it.w || raw.size[0]) * f),
      footprint_d_m: round3((it.d || raw.size[2]) * f),
      floors: it.floors,
      /* 审计用：每层层高、玻璃（窗）竖向高度（没有语义节点，只能按材质名量） */
      floor_h_m: it.floors > 0 ? round3(((it.height_m || raw.size[1]) * f) / it.floors) : 0,
      glass_h_m: glass ? round3(glass.h * f) : null,
      verts: dec.pos.length / 3,
      tris: dec.tris,
      source_tris: raw.tris,
      decimated: dec.tris < raw.tris,
      bbox: [],
      size: [],
    };
    /* 减面后 bbox/size 以实际写入的顶点为准 */
    const box = bboxOf(dec.pos);
    a.bbox = box.bbox;
    a.size = box.size;
    const pts = dec.pos.length / 3;
    const posOff = align4(total);
    total = posOff + pts * 12;
    const colOff = total;
    total = colOff + pts * 3;
    const idxOff = align4(total);
    total = idxOff + dec.idx.length * 4;
    a.pos = posOff;
    a.color = colOff;
    a.idx = idxOff;
    a.idxCount = dec.idx.length;
    assets.push(a);
    blocks.push({ posOff, colOff, idxOff, a, geo: dec });
  }

  const buf = Buffer.alloc(total);
  for (const b of blocks) {
    Buffer.from(b.geo.pos.buffer, b.geo.pos.byteOffset, b.geo.pos.byteLength).copy(buf, b.posOff);
    Buffer.from(b.geo.color.buffer, b.geo.color.byteOffset, b.geo.color.byteLength).copy(buf, b.colOff);
    for (let i = 0; i < b.geo.idx.length; i++) buf.writeUInt32LE(b.geo.idx[i], b.idxOff + i * 4);
  }

  const byCategory = {};
  let verts = 0, tris = 0;
  for (const a of assets) {
    verts += a.verts;
    tris += a.tris;
    const c = (byCategory[a.category] ||= { assets: 0, verts: 0, tris: 0, source_tris: 0 });
    c.assets += 1;
    c.verts += a.verts;
    c.tris += a.tris;
    c.source_tris += a.source_tris;
  }
  return { buf, assets, total, factors, counts: { assets: assets.length, verts, tris, byCategory } };
}

function round3(x) {
  return Math.round(Number(x) * 1000) / 1000;
}

function bboxOf(pos) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    bbox: [round3(minX), 0, round3(minZ), round3(maxX), round3(maxY - minY), round3(maxZ)],
    size: [round3(maxX - minX), round3(maxY - minY), round3(maxZ - minZ)],
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、命令行
 * ══════════════════════════════════════════════════════════════════════════ */

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function sha256(b) {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function main() {
  const src = path.resolve(argOf("--src", DEFAULT_SRC));
  const out = path.resolve(argOf("--out", DEFAULT_OUT));
  const dry = process.argv.includes("--dry");
  const verify = process.argv.includes("--verify");
  if (!fs.existsSync(src)) throw new Error("源目录不存在：" + src);

  const p = buildPack(src);
  const pack = {
    v: 3,
    generator: "scripts/build-bld-assets-all.mjs",
    source: "Blender 4.5 asset batches（bldcom / bldres / prop / vehicle / road）",
    units: "metres",
    bin: "pack.bin",
    binBytes: p.total,
    counts: p.counts,
    /** per-batch 归一化系数（转换器里已作用到顶点；地图侧只做等比缩放） */
    norm: p.factors,
    /** 每顶点 pos=12B f32×3 / color=3B u8×3（sRGB）/ idx=4B u32；段首 4 字节对齐 */
    layout: { pos: "f32x3", color: "u8x3 sRGB", idx: "u32" },
    assets: p.assets,
  };
  const json = JSON.stringify(pack, null, 2) + "\n";
  const jsonBytes = Buffer.byteLength(json);
  const packBytes = p.total + jsonBytes;

  console.log("── 尺寸审计（批次归一化后）──");
  for (const [b, f] of Object.entries(p.factors)) console.log("  " + b + " 归一化系数 = " + f);
  const audit = p.assets.filter((a) => a.category === "bld");
  const badFloor = audit.filter((a) => a.floor_h_m > 0 && (a.floor_h_m < 3.0 || a.floor_h_m > 3.3));
  console.log("  建筑 " + audit.length + " 件，层高不在 3.0~3.3 m 的 " + badFloor.length + " 件" +
    (badFloor.length ? "：" + badFloor.map((a) => a.name + "(" + a.floor_h_m + ")").join(", ") : ""));
  const glassVals = audit.filter((a) => a.glass_h_m != null).map((a) => a.glass_h_m);
  if (glassVals.length) {
    const sorted = glassVals.slice().sort((x, y) => x - y);
    console.log("  玻璃（窗）竖向高度：min " + sorted[0] + " / 中位 " + sorted[Math.floor(sorted.length / 2)] + " / max " + sorted[sorted.length - 1] + " m（" + glassVals.length + " 件可量）");
  }
  console.log("── 资产包 v3（Blender 全量）──");
  let curCat = "";
  for (const a of p.assets) {
    if (a.category !== curCat) {
      curCat = a.category;
      console.log("  [" + curCat + "]");
    }
    console.log(
      "  " + a.name.padEnd(22) + " " + String(a.kind).padEnd(16) +
        " " + String(a.verts).padStart(6) + " v " + String(a.tris).padStart(6) + " tri" +
        (a.decimated ? "（源 " + a.source_tris + "，已减面）" : "") +
        "  h=" + a.height_m.toFixed(2) + "  w×d=" + a.footprint_w_m.toFixed(2) + "×" + a.footprint_d_m.toFixed(2)
    );
  }
  console.log("  分类合计：" + Object.entries(p.counts.byCategory).map(([k, v]) => k + " " + v.assets + "件/" + v.tris + " tri").join(" · "));
  console.log(
    "  总合计 " + p.counts.assets + " 件 · " + p.counts.verts + " 顶点 · " + p.counts.tris + " 三角 · " +
      "bin " + (p.total / 1024).toFixed(1) + " KB · json " + (jsonBytes / 1024).toFixed(1) + " KB"
  );
  console.log("  包总计 " + packBytes + " B（" + (packBytes / 1000).toFixed(2) + " KB，上限 " + MAX_PACK_BYTES + " B）");
  if (packBytes > MAX_PACK_BYTES) throw new Error("包体超过上限：" + packBytes + " > " + MAX_PACK_BYTES);

  if (verify) {
    const p2 = buildPack(src);
    const pack2 = { ...pack, binBytes: p2.total, counts: p2.counts, assets: p2.assets };
    const json2 = JSON.stringify(pack2, null, 2) + "\n";
    const hb1 = sha256(p.buf), hb2 = sha256(p2.buf);
    const hj1 = sha256(Buffer.from(json)), hj2 = sha256(Buffer.from(json2));
    console.log("  确定性自检（两次构建）：");
    console.log("    pack.bin  " + hb1);
    console.log("    pack.bin  " + hb2);
    console.log("    pack.json " + hj1);
    console.log("    pack.json " + hj2);
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
