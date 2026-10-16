/**
 * MVT 解码（主线程侧，**给 id 表登记用**）。
 *
 * 为什么需要它：`wsMvtIdTable` 要成为 id→元数据的唯一真源，就必须有人把「瓦片里有什么」告诉它。
 * 落点选在**我们自己的取数路径**上（`wsMvtTiles.protocolHandler` 拿到字节之后），**不依赖
 * `querySourceFeatures` / 渲染器** —— 那条路本机无头里会抛（实测），真机能不能用也未验；
 * 而"数据从我们自己的解码路径进来"这条**本机就能验**（见 `world_map/ws_mvt_loader_selftest.mjs`）。
 *
 * 口径与工具仓那份解码器**同源**（`world_map/mvt-spike/tools/lib/mvt_decode.mjs`，MVT spec 2.1）：
 * Tile.layers = field 3 · Layer{version 15, name 1, features 2, keys 3, values 4, extent 5} ·
 * Feature{id 1, tags 2, type 3, geometry 4} · Value{string 1, float 2, double 3, int 4, uint 5, sint 6, bool 7}。
 *
 * **只解属性和 id，不重建几何**（登记只需要 id 与 h/lv/k/b；几何交给 MapLibre 自己解）。
 */

/** 一块瓦片里的一条要素（登记进 id 表所需的最小信息） */
export interface MvtDecodedFeature {
  id: number;
  properties: { h?: unknown; lv?: unknown; k?: unknown; b?: unknown; p?: unknown; hb?: unknown; [k: string]: unknown };
}

interface Reader {
  pos: number;
  buf: Uint8Array;
  view: DataView;
  len: number;
}

function readVarint(r: Reader): number {
  let result = 0, shift = 0;
  while (r.pos < r.buf.length) {
    const b = r.buf[r.pos++];
    result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * Math.pow(2, shift);
    if (b < 0x80) return result;
    shift += 7;
  }
  return result;
}

function skipField(r: Reader, wire: number): void {
  switch (wire) {
    case 0: readVarint(r); break;
    case 1: r.pos += 8; break;
    case 2: { const l = readVarint(r); r.pos += l; break; }
    case 5: r.pos += 4; break;
    default: r.pos = r.buf.length; break;   // 未知 wire type：**停在原地**而不是编一个值
  }
}

function readValue(r: Reader): unknown {
  /* ⚠️ 必须先读长度、再用**读完之后**的 `r.pos` 起算：写成 `r.pos + readVarint(r)` 会少算长度
     自身占的字节数（长度 varint 通常 1~3 字节）⇒ 每条之后都错位（实测：一块瓦片只解出 1 条）。 */
  const valueLen = readVarint(r);
  const end = r.pos + valueLen;
  let v: unknown = undefined;
  while (r.pos < end) {
    const key = readVarint(r), field = key >> 3, wire = key & 7;
    if (field === 1 && wire === 2) { const l = readVarint(r); v = new TextDecoder().decode(r.buf.subarray(r.pos, r.pos + l)); r.pos += l; }
    else if (field === 2 && wire === 5) { v = r.view.getFloat32(r.pos, true); r.pos += 4; }
    else if (field === 3 && wire === 1) { v = r.view.getFloat64(r.pos, true); r.pos += 8; }
    else if (field === 4 && wire === 0) { v = readVarint(r); }
    else if (field === 5 && wire === 0) { v = readVarint(r); }
    else if (field === 6 && wire === 0) { const n = readVarint(r); v = (n >> 1) ^ -(n & 1); }
    else if (field === 7 && wire === 0) { v = readVarint(r) !== 0; }
    else skipField(r, wire);
  }
  r.pos = end;
  return v;
}

/** 解一块瓦片 → 要素清单（`id > 0` 的才算；id 为 0 说明生成侧没写 id） */
export function decodeMvtFeatures(bytes: Uint8Array): MvtDecodedFeature[] {
  const out: MvtDecodedFeature[] = [];
  const r: Reader = { pos: 0, buf: bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), len: bytes.length };
  while (r.pos < r.buf.length) {
    const key = readVarint(r), field = key >> 3, wire = key & 7;
    if (field !== 3 || wire !== 2) { skipField(r, wire); continue; }     // Tile.layers = 3
    const layerLen = readVarint(r);
    const layerEnd = r.pos + layerLen;
    const keys: string[] = [];
    const values: unknown[] = [];
    const feats: Array<{ id: number; tags: number[] }> = [];
    while (r.pos < layerEnd) {
      const lk = readVarint(r), lf = lk >> 3, lw = lk & 7;
      if (lf === 3 && lw === 2) { const l = readVarint(r); keys.push(new TextDecoder().decode(r.buf.subarray(r.pos, r.pos + l))); r.pos += l; }
      else if (lf === 4 && lw === 2) { values.push(readValue(r)); }
      else if (lf === 2 && lw === 2) {
        const featLen = readVarint(r);
        const fEnd = r.pos + featLen;
        let id = 0; const tags: number[] = [];
        while (r.pos < fEnd) {
          const fk = readVarint(r), ff = fk >> 3, fw = fk & 7;
          if (ff === 1 && fw === 0) id = readVarint(r);
          else if (ff === 2 && fw === 2) { const l = readVarint(r); const stop = r.pos + l; while (r.pos < stop) tags.push(readVarint(r)); }
          else skipField(r, fw);
        }
        r.pos = fEnd;
        feats.push({ id, tags });
      } else skipField(r, lw);
    }
    r.pos = layerEnd;
    for (const f of feats) {
      if (!(f.id > 0)) continue;
      const properties: Record<string, unknown> = {};
      for (let i = 0; i + 1 < f.tags.length; i += 2) properties[keys[f.tags[i]]] = values[f.tags[i + 1]];
      /* `p` = 部件码（0 主体 / 1 裙楼 / 2 塔楼 / 3 退台 / 4 女儿墙 / 5 屋顶 / 6 设备箱 / 7 天线），
         `hb` = 该件的挤出基座。**拆件后同一个 id 会有多件** ⇒ 登记侧必须只取主体（见 wsMvtCoverage）。 */
      out.push({ id: f.id, properties: { h: properties.h, lv: properties.lv, k: properties.k, b: properties.b, p: properties.p, hb: properties.hb } });
    }
  }
  return out;
}
