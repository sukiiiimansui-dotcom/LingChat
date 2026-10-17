/* wsMvtBldMap.ts —— **矢量瓦片要素 → 网格要素**的映射（纯函数，无 DOM/无地图依赖）。
 *
 * ## 为什么单独一个文件（真机 2026-10-17 "带凸起的大量小楼"）
 * 瓦片里**同一栋楼有多条要素**：主体（`p = 0`）+ 部件（`p = 1 女儿墙 / 2 设备箱 / 3 天线`），
 * 每条都带自己的 `h/hb`。`querySourceFeatures` 的返回顺序**不保证主体在前**。
 * 早先的实现在叠加层里"按 id 先到先得" ⇒ **部件先到就把主体顶掉** ⇒ 那栋楼被画成
 * "屋顶上的小盒子"（用户看到的"凸起"）。
 * 另外 `zt`（档位，0/1/2）与 `p`（部件码，1/2/3）语义不同，早先写成 `zt: pr.zt ?? pr.p`
 * ⇒ 缺 `zt` 时会把部件码当档位。
 *
 * ## 规则（本文件是唯一实现，闸直接测它）
 * 1. **一栋楼只留一条要素**：优先 `p === 0`（主体）；同 id 再来主体 ⇒ 用**更高**的那条
 *    （同 id 多主体时应是同栋不同片，取 `h` 最大的那条最稳）；只有部件时保留最高的部件。
 * 2. `zt` **只来自** `pr.zt`，缺失即 0；`p` 单独保留（给建模优化用）。
 * 3. `h3d/h_base/color3d` 由 `h/hb/c`（瓦片短名）或原字段给出。
 * 4. 按 id 去重；没有 id 的要素（无主部件）**丢弃**（画不出确定的那栋楼）。
 */

/** 从源里查到的一条要素（只要用得上的字段） */
export interface MvtBldFeatureLike {
  id?: unknown;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
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
  /** 因为"同 id 只留一条"而被丢掉的部件条数 */
  partsDropped: number;
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

/**
 * 把矢量源查到的要素映射成网格要素。
 * **同 id 只留一条**，规则见文件头（主体优先、同为主体取更高者）。
 */
export function mapMvtBldFeatures(list: readonly MvtBldFeatureLike[]): MvtBldMapped {
  const byId = new Map<string, { f: MvtBldMapped["features"][number]; h: number; body: boolean }>();
  let raw = 0;
  let invalid = 0;
  let partsDropped = 0;
  for (const src of list) {
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
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, { f, h, body });
      continue;
    }
    /* 同 id 再来一条：**主体优先**；两条都是主体取更高者；两条都是部件也取更高者 */
    const takeIt = body ? !cur.body || h > cur.h : !cur.body && h > cur.h;
    if (takeIt) {
      byId.set(id, { f, h, body });
      partsDropped += 1;
    } else {
      partsDropped += 1;
    }
  }
  const features = [...byId.values()].map((x) => x.f);
  return { features, raw, unique: byId.size, partsDropped, invalidDropped: invalid };
}
