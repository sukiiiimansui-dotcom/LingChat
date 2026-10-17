/* wsMvtBldMap.ts —— **矢量瓦片要素 → 网格要素**的映射（纯函数，无 DOM/无地图依赖）。
 *
 * ## 为什么单独一个文件（真机 2026-10-17 "带凸起的大量小楼"）
 * 瓦片里**同一栋楼有多条要素**：主体（`p = 0`）+ 部件
 * （`p = 1 裙楼 / 2 塔楼 / 3 退台 / 4 女儿墙 / 5 屋顶压顶 / 6 设备箱 / 7 天线`），
 * 每条都带自己的 `h/hb`。`querySourceFeatures` 的返回顺序**不保证主体在前**。
 * 早先的实现在叠加层里"按 id 先到先得" ⇒ **部件先到就把主体顶掉** ⇒ 那栋楼被画成
 * "屋顶上的小盒子"（用户看到的"凸起"）。
 * 另外 `zt`（档位，0/1/2）与 `p`（部件码，1/2/3/4/5/6/7）语义不同，早先写成 `zt: pr.zt ?? pr.p`
 * ⇒ 缺 `zt` 时会把部件码当档位。
 *
 * ## 规则（本文件是唯一实现，闸直接测它）
 * 1. **一栋楼只留一条要素**：优先 `p === 0`（主体）；同 id 再来主体 ⇒ 用**更高**的那条
 *    （同 id 多主体时应是同栋不同片，取 `h` 最大的那条最稳）；只有部件时保留最高的部件。
 * 2. `zt` **只来自** `pr.zt`，缺失即 0；`p` 单独保留（给建模优化用）。
 * 3. `h3d/h_base/color3d` 由 `h/hb/c`（瓦片短名）或原字段给出。
 * 4. 按 id 去重；没有 id 的要素（无主部件）**丢弃**（画不出确定的那栋楼）。
 * 5. **非主体系件原样挂到主体的 `properties.__parts`**（p=1/2/3/4/5/6/7），
 *    不去改几何输出：本文件只负责“别把已经有的拆件丢掉”，用不用由渲染侧决定。
 *    跨瓦片同一栋会重复返回（buffer 重叠）⇒ 按 `p + h + hb` 去重；设备箱（p=6）再加
 *    bbox 中心 0.1 m 量化（同一屋顶上不同箱不能合并）；同键时取环点数最多的一份
 *    （被瓦片边界裁过的通常点更少），点数相同再按几何字符串稳定取一份。
 * 6. 主体是部件（没有 p=0）时，该条**不重复**挂进 `__parts`；渲染侧用主体 + 其余件拼全。
 */

/** 从源里查到的一条要素（只要用得上的字段） */
export interface MvtBldFeatureLike {
  id?: unknown;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
}

/** 瓦片里的一个**非主体**部件（p=1/2/3/4/5/6/7）。几何仍是经纬度、未投影。 */
export interface MvtBldPart {
  /** 部件码：1 裙楼 / 2 塔楼 / 3 退台 / 4 女儿墙 / 5 屋顶压顶 / 6 设备箱 / 7 天线 */
  p: number;
  /** 该件的顶高（米，瓦片 `h`） */
  h: number;
  /** 该件的挤出基座（米，瓦片 `hb`） */
  hb: number;
  /** 该件的颜色（瓦片 `c`，与生成侧 color3d 同源；缺省时渲染侧按主体色推） */
  c?: string;
  /** 档位（0 一直画 / 1 z≥14 / 2 z≥16）——与 `p` 分开，不互相顶替 */
  zt: number;
  /** Polygon/MultiPolygon 几何（经纬度） */
  geometry: { type: string; coordinates: unknown };
}

/** 映射后的网格要素（与 `buildBldMeshData` 吃的那套命名对齐） */
export interface MvtBldMapped {
  features: Array<{
    type: "Feature";
    id?: string;
    properties: Record<string, unknown>;
    geometry: { type?: string; coordinates?: unknown };
  }>;
  /** 源里一共几条要素（含部件） */
  raw: number;
  /** 唯一 id 数（= 应当画出来的栋数） */
  unique: number;
  /** 非主体、且**没有**挂进 `__parts` 的条数（重复件/被更高主体顶掉的/无效件）。
   *  恒等式：`raw = invalidDropped + unique + partsAttached + partsDropped`。 */
  partsDropped: number;
  /** 实际挂进 `__parts` 的唯一部件条数（跨瓦片重复已去重，主体本身不计） */
  partsAttached: number;
  /** 缺几何/缺 id 而丢掉的条数 */
  invalidDropped: number;
}

/**
 * 是否把瓦片里的 `c` 当楼色（默认**不用**）。
 *
 * 为什么默认关：瓦片的 `c` 是旧主题的深蓝灰（`#283a4b` 一族），直接当顶点色会让楼发黑；
 * 默认走 `wsBldMesh` 的主题色阶（浅蓝系）。需要时 `?usec=1` 打开。
 */
function useTileColor(): boolean {
  try {
    return /[?&]usec=1\b/.test(typeof location !== "undefined" ? location.search : "");
  } catch {
    return false;
  }
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** `p` 是不是主体（`0`/缺省按主体算；`"0"`/`"body"` 也认） */
function isBody(p: unknown): boolean {
  if (p === undefined || p === null || p === "") return true;
  const s = String(p).toLowerCase();
  return s === "0" || s === "body" || s === "main";
}

/* ── 拆件去重用的纯工具（只读几何，不改几何） ───────────────────────────── */

type MvtGeom = { type?: string; coordinates?: unknown };

/** 一个 Polygon/MultiPolygon 的**所有环**（外环 + 洞）。
 *  ⚠️ 女儿墙 p=4 不是“两条环”：`wsBuildingLook.ringBand` 把外圈 + 内圈倒序拼成**一条**环带环
 *  （共 2n 点）。S1 只按原样保存；S2 要在这条环的中点 (n) 拆回内外两圈再建环带。 */
function ringsOfGeometry(g: MvtGeom | null | undefined): unknown[][] {
  const cs = g?.coordinates;
  if (!Array.isArray(cs)) return [];
  if (g?.type === "Polygon") return cs.filter((r): r is unknown[] => Array.isArray(r));
  if (g?.type === "MultiPolygon") {
    const out: unknown[][] = [];
    for (const poly of cs) {
      if (!Array.isArray(poly)) continue;
      for (const r of poly) if (Array.isArray(r)) out.push(r);
    }
    return out;
  }
  return [];
}

/** 全部环的点数之和（同键去重时“点多的更像未被裁边的那份”） */
function ringPointCount(g: MvtGeom): number {
  let n = 0;
  for (const r of ringsOfGeometry(g)) n += r.length;
  return n;
}

/** 稳定几何串：点数相同时用它做与输入顺序无关的裁决 */
function geomKey(g: MvtGeom): string {
  let s = "";
  for (const r of ringsOfGeometry(g)) {
    for (const p of r) {
      const a = Array.isArray(p) ? p : [];
      const x = Number(a[0]);
      const y = Number(a[1]);
      s += `${Number.isFinite(x) ? x.toFixed(6) : "x"},${Number.isFinite(y) ? y.toFixed(6) : "y"};`;
    }
  }
  return s;
}

/** bbox 中心（度）量化到 1e-6 ≈ 0.1 m；只给设备箱去重用 */
function bboxCenterKey(g: MvtGeom): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of ringsOfGeometry(g)) {
    for (const p of r) {
      const a = Array.isArray(p) ? p : [];
      const x = Number(a[0]);
      const y = Number(a[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return "0:0";
  return `${Math.round(((minX + maxX) / 2) * 1e6)}:${Math.round(((minY + maxY) / 2) * 1e6)}`;
}

/**
 * 同一个部件的去重键。
 * · 裙楼/塔楼/退台/女儿墙/屋顶/天线：`p + h + hb`（退台不同段 h/hb 不同，会各留一份）；
 * · 设备箱：同一屋顶上不同箱的 h/hb 可能相同，必须再加 bbox 中心（0.1 m 量化）。
 */
function partKey(p: number, h: number, hb: number, g: MvtGeom): string {
  const hq = Math.round(h * 10);
  const hbq = Math.round(hb * 100);
  if (p === 6) return `${p}:${hq}:${hbq}:${bboxCenterKey(g)}`;
  return `${p}:${hq}:${hbq}`;
}

type PartRec = {
  part: MvtBldPart;
  /** 环点数：同键时取最多的一份（瓦片边界裁过的点更少） */
  points: number;
  /** 稳定几何串：点数相同再比，保证与输入顺序无关 */
  gkey: string;
  /** 源要素序号：主体本身是部件时，用它把自己从 `__parts` 排除 */
  seq: number;
};

/** 同键两份取更完整的；完全同分时按几何串稳定取一份 */
function betterPart(a: PartRec, b: PartRec): PartRec {
  if (b.points !== a.points) return b.points > a.points ? b : a;
  return b.gkey < a.gkey ? b : a;
}

/**
 * 把矢量源查到的要素映射成网格要素。
 * **同 id 只留一条**，规则见文件头（主体优先、同为主体取更高者）。
 */
export function mapMvtBldFeatures(list: readonly MvtBldFeatureLike[]): MvtBldMapped {
  const byId = new Map<string, { f: MvtBldMapped["features"][number]; h: number; body: boolean; seq: number }>();
  /** id → (去重键 → 部件)。只收非主体；主体选择逻辑**不受影响**。 */
  const partsById = new Map<string, Map<string, PartRec>>();
  let raw = 0;
  let invalid = 0;
  let seq = 0;
  for (const src of list) {
    const mySeq = seq++;
    raw += 1;
    const pr = (src?.properties || {}) as Record<string, unknown>;
    const id = String(src?.id ?? pr.id ?? "");
    const g = src?.geometry;
    if (!id || !g || (g.type !== "Polygon" && g.type !== "MultiPolygon") || !g.coordinates) {
      invalid += 1;
      continue;
    }
    const h = num(pr.h3d ?? pr.h);
    const hb = num(pr.h_base ?? pr.hb);
    const body = isBody(pr.p);
    const f: MvtBldMapped["features"][number] = {
      type: "Feature",
      id,
      properties: {
        ...pr,
        h3d: h,
        h_base: hb,
        /* 楼色默认**不取瓦片 `c`**（深蓝灰会让楼发黑）：留给 `wsBldMesh` 用主题色阶；
           `?usec=1` 时才把 `c` 当楼色（备用/对拍）。 */
        ...(useTileColor() ? { color3d: pr.color3d ?? pr.c ?? "#c9d4e0" } : {}),
        /* `zt` **只来自 `pr.zt`**：`p` 是部件码，绝不并进来 */
        zt: num(pr.zt),
        /* `p` 单独保留（建模优化要用），缺失记 0 */
        p: pr.p ?? 0,
      },
      geometry: { type: g.type, coordinates: g.coordinates },
    };
    /* 非主体部件先收进 partsById：只读几何、不参与主体选择、不改 f 的几何/属性。
       跨瓦片重复在这里按 partKey 去掉；同键取更完整的一份。 */
    if (!body) {
      const code = Number(pr.p);
      if (Number.isFinite(code)) {
        const geom = { type: g.type, coordinates: g.coordinates };
        const part: MvtBldPart = {
          p: code,
          h,
          hb,
          ...(typeof pr.c === "string" && pr.c ? { c: pr.c } : {}),
          zt: num(pr.zt),
          geometry: geom,
        };
        const key = partKey(code, h, hb, geom);
        const rec: PartRec = { part, points: ringPointCount(geom), gkey: geomKey(geom), seq: mySeq };
        let map = partsById.get(id);
        if (!map) {
          map = new Map();
          partsById.set(id, map);
        }
        const prev = map.get(key);
        map.set(key, prev ? betterPart(prev, rec) : rec);
      }
    }
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, { f, h, body, seq: mySeq });
      continue;
    }
    /* 同 id 再来一条：**主体优先**；两条都是主体取更高者；两条都是部件也取更高者 */
    const takeIt = body ? !cur.body || h > cur.h : !cur.body && h > cur.h;
    if (takeIt) {
      byId.set(id, { f, h, body, seq: mySeq });
    }
  }
  /* 去重后的部件挂到**最终选中的主体**上；主体本身是部件时排除自己，避免双画。 */
  let partsAttached = 0;
  for (const [id, rec] of byId) {
    const map = partsById.get(id);
    if (!map || !map.size) continue;
    const parts = [...map.values()]
      .filter((x) => x.seq !== rec.seq)
      .sort((a, b) =>
        a.part.p - b.part.p ||
        a.part.h - b.part.h ||
        a.part.hb - b.part.hb ||
        (a.gkey < b.gkey ? -1 : a.gkey > b.gkey ? 1 : 0)
      )
      .map((x) => x.part);
    if (!parts.length) continue;
    rec.f.properties.__parts = parts;
    partsAttached += parts.length;
  }
  const features = [...byId.values()].map((x) => x.f);
  /* 恒等式：raw = invalid + unique + partsAttached + partsDropped。
     partsDropped = 同 id 里既没当主体、也没挂成部件的那些（重复主体 / 同键输家 / 无效件）。 */
  const partsDropped = Math.max(0, raw - invalid - byId.size - partsAttached);
  return { features, raw, unique: byId.size, partsDropped, partsAttached, invalidDropped: invalid };
}
