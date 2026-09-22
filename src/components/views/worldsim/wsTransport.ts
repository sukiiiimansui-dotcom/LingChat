/**
 * wsTransport.ts —— **交通设施 v0 的生成逻辑**（纯函数，可在 Node 里全量自检）。
 *
 * 规则与样式在 `wsTransportRules.ts`（**唯一真源**）；这里只负责"按规则从路网/楼栋算出点位"。
 * 几何全用**等距平面近似**（米）：小范围（一个小区 1~3km）误差可忽略，
 * 而这样所有距离/面积都能用**米**说话，规则里的 350m/1500m² 才是可读的。
 *
 * ## 🔴 产物性质：**全部是示意位置，不是实测坐标**
 * 生成的每一个点都必须经 `labelFacilities()` 打上「示意，非事实」的标记（HUD 要显示）。
 * 只有 OSM 真站点才算事实 —— 而 v0 **不编任何真站点**。
 */
import {
  TF_CAPS,
  TF_RULES,
  type TfBuilding,
  type TfKind,
  type TfRoad,
} from "./wsTransportRules";

/** 一个设施点（经纬度 + 类别 + 为什么在这儿） */
export interface TfFeature {
  kind: TfKind;
  /** `[lng, lat]` */
  at: [number, number];
  /** 人类可读的来源说明（HUD/回证表用；**不许写"实测"**） */
  why: string;
  /** 线状设施（斑马线/出入口）：终点（`at` = 起点） */
  to?: [number, number];
  /** 名称（公交站：最近路名 + "站"；没有路名就叫"公交站"） */
  name?: string;
  /** 附带数量（停车场车位数） */
  count?: number;
}

/** 生成结果 + **数量回证**（生成了几个 / 被上限裁掉几个，都要能报出来） */
export interface TfResult {
  features: TfFeature[];
  /** 每类：生成数（裁剪前）/ 保留数 / 被上限裁掉数 */
  counts: Record<TfKind, { made: number; kept: number; droppedByCap: number }>;
  notes: string[];
}

const M_PER_DEG_LAT = 111_320;

/** 经纬度 → 以 `origin` 为原点的米平面（等距近似；小范围够用） */
export function toMeters(p: [number, number], origin: [number, number]): [number, number] {
  const latRad = (origin[1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(latRad);
  return [(p[0] - origin[0]) * mx, (p[1] - origin[1]) * M_PER_DEG_LAT];
}

/** 米平面 → 经纬度（`toMeters` 的逆） */
export function toLngLat(p: [number, number], origin: [number, number]): [number, number] {
  const latRad = (origin[1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(latRad);
  return [origin[0] + p[0] / mx, origin[1] + p[1] / M_PER_DEG_LAT];
}

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 线上按间距取样（返回米平面上的点 + 累计里程） */
function sampleAlong(line: Array<[number, number]>, step: number): Array<{ p: [number, number]; s: number }> {
  const out: Array<{ p: [number, number]; s: number }> = [];
  let acc = 0;
  let next = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = dist(a, b);
    if (seg <= 0) continue;
    while (next <= acc + seg) {
      const t = (next - acc) / seg;
      out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], s: next });
      next += step;
    }
    acc += seg;
  }
  return out;
}

/** 线上离 `p` 最近的点（米平面） */
export function nearestOnLine(line: Array<[number, number]>, p: [number, number]): { at: [number, number]; d: number } {
  let best: [number, number] = line[0] || p;
  let bd = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)) : 0;
    const q: [number, number] = [a[0] + vx * t, a[1] + vy * t];
    const d = dist(q, p);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return { at: best, d: bd };
}

/** 多边形面积（鞋带公式，米平面；取绝对值 ⇒ 顺逆时针都行） */
export function ringAreaM2(ring: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** 找"路口"：两条路（不同路）的折线在某点附近相交（用顶点距离近似，够 v0 用） */
/** 两条线段的交点（不相交返回 null）—— 路口检测**必须**用它：
    只比"顶点距离"在**稀疏路**（一条直路只有首尾两点）上永远找不到路口，
    于是整条街都没有红绿灯/斑马线（自检里"三路相交 got 0"就是这个 bug）。 */
function segIntersect(
  p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]
): [number, number] | null {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null; // 平行/共线：v0 不当路口
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + d1x * t, p1[1] + d1y * t];
}

export function junctions(roads: TfRoad[], withinM = 18): Array<{ at: [number, number]; arms: TfRoad[] }> {
  const out: Array<{ at: [number, number]; arms: TfRoad[] }> = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i]!;
      const B = roads[j]!;
      let hit: [number, number] | null = null;
      /* 先试线段相交（覆盖"两条直路十字交叉"这种最常见的情形） */
      for (let ai = 1; ai < A.pts.length && !hit; ai++) {
        for (let bi = 1; bi < B.pts.length && !hit; bi++) {
          hit = segIntersect(A.pts[ai - 1]!, A.pts[ai]!, B.pts[bi - 1]!, B.pts[bi]!);
        }
      }
      /* 再退回"顶点足够近"（Y 字路口/端点相接那种，没有真正的交点） */
      if (!hit) {
        for (const a2 of A.pts) {
          for (const b2 of B.pts) {
            if (dist(a2, b2) <= withinM) {
              hit = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
              break;
            }
          }
          if (hit) break;
        }
      }
      if (!hit) continue;
      /* 合并到已发现的路口（同一个路口可能有多对路相交） */
      const near = out.find((o) => dist(o.at, hit!) <= withinM * 1.6);
      if (near) {
        if (!near.arms.includes(A)) near.arms.push(A);
        if (!near.arms.includes(B)) near.arms.push(B);
      } else {
        out.push({ at: hit, arms: [A, B] });
      }
    }
  }
  return out;
}

/** 把超过上限的部分**按到中心的距离取近**裁掉（不随机丢） */
function capByDistance<T extends { at: [number, number] }>(items: T[], cap: number, center: [number, number]): { kept: T[]; dropped: number } {
  if (items.length <= cap) return { kept: items, dropped: 0 };
  const sorted = [...items].sort((a, b) => dist(a.at, center) - dist(b.at, center));
  return { kept: sorted.slice(0, cap), dropped: items.length - cap };
}

/**
 * **生成一套交通设施**（v0 预设）。
 *
 * @param roads 道路中心线（经纬度折线）
 * @param buildings 楼栋足迹
 * @param center 视野中心（**裁剪上限时按"离它近"保留**；同时作为米平面的原点）
 * @param low 低档：只画 `TF_LOW_TIER_KINDS`（公交站 + 红绿灯）
 */
export function buildTransport(roads: TfRoad[], buildings: TfBuilding[], center: [number, number], low = false): TfResult {
  const notes: string[] = [];
  const counts = {
    bus: { made: 0, kept: 0, droppedByCap: 0 },
    crosswalk: { made: 0, kept: 0, droppedByCap: 0 },
    signal: { made: 0, kept: 0, droppedByCap: 0 },
    parking: { made: 0, kept: 0, droppedByCap: 0 },
    driveway: { made: 0, kept: 0, droppedByCap: 0 },
  } as TfResult["counts"];
  if (low) notes.push("低档：只画 公交站 + 红绿灯（其余按规则关掉，保帧率）");

  /* 把输入搬到米平面（原点 = 视野中心） */
  const O = center;
  const R = roads
    .map((r) => ({ cls: typeof r.cls === "number" ? r.cls : 3, name: r.name || "", pts: r.pts.map((p) => toMeters(p, O)) }))
    .filter((r) => r.pts.length >= 2);
  const B = buildings
    .map((b) => ({ kind: String(b.kind || "").toLowerCase(), name: b.name || "", ring: b.ring.map((p) => toMeters(p, O)) }))
    .filter((b) => b.ring.length >= 3);

  const J = junctions(
    R.map((r) => ({ pts: r.pts, cls: r.cls, name: r.name })),
    18
  );

  const features: TfFeature[] = [];
  const push = (f: TfFeature): void => {
    features.push(f);
  };

  /* ── ① 公交站：沿 class ≤ 2，间隔 ~420m，优先落路口 40m 内 ───────────────── */
  if (!low || true) {
    const busRoads = R.filter((r) => r.cls <= TF_RULES.bus.maxCls);
    for (const r of busRoads) {
      const samples = sampleAlong(r.pts, TF_RULES.bus.spacing);
      for (const sp of samples) {
        /* 优先路口：40m 内有路口就挪过去（挪完可能重复 ⇒ 后面按 350m 去重） */
        let at = sp.p;
        let why = `沿 class ${r.cls} 路每 ${TF_RULES.bus.spacing}m 设站`;
        const j = J.map((x) => ({ x, d: dist(x.at, sp.p) }))
          .filter((o) => o.d <= TF_RULES.bus.preferJunctionM)
          .sort((a, b) => a.d - b.d)[0];
        if (j) {
          at = j.x.at;
          why = `路口 ${Math.round(j.d)}m 内 ⇒ 站点吸附到路口`;
        }
        push({ kind: "bus", at, why, name: (r.name ? r.name : "公交") + "站" });
      }
    }
    counts.bus.made = features.filter((f) => f.kind === "bus").length;
    /* 去重：**同一条路**上 350m 内的站合并（吸附到路口后很容易挤在一起）。
       ⚠️ 必须**按路**去重：全局去重会让两条相距几十米的平行街道**互相吃掉站点**
       （自检里 40 条平行路只剩几个站、上限永远裁不到 —— 就是这条写错时的症状）。 */
    const keptBus: TfFeature[] = [];
    const busByRoad = new Map<string, TfFeature[]>();
    for (const f of features.filter((x) => x.kind === "bus")) {
      const key = String(f.name || "");
      const arr = busByRoad.get(key) || [];
      arr.push(f);
      busByRoad.set(key, arr);
    }
    for (const arr of busByRoad.values()) {
      const mine: TfFeature[] = [];
      for (const f of arr) {
        if (mine.some((k) => dist(k.at, f.at) < TF_RULES.bus.minGap)) continue;
        mine.push(f);
        keptBus.push(f);
      }
    }
    for (const f of features.filter((x) => x.kind === "bus")) {
      const i = features.indexOf(f);
      if (i >= 0 && !keptBus.includes(f)) features.splice(i, 1);
    }
  }

  /* ── ② 人行横道：class ≤ 3 的交叉口各方向 1 条；路口间距 < 80m 合并 ─────── */
  {
    const merged: Array<{ at: [number, number]; arms: number }> = [];
    for (const j of J) {
      const arms = j.arms.filter((a) => (typeof a.cls === "number" ? a.cls : 3) <= TF_RULES.crosswalk.maxCls).length;
      if (!arms) continue;
      const near = merged.find((m) => dist(m.at, j.at) < TF_RULES.crosswalk.mergeWithinM);
      if (near) {
        near.arms = Math.max(near.arms, arms);
        continue;
      }
      merged.push({ at: j.at, arms });
    }
    for (const m of merged) {
      if (!low) {
        for (let k = 0; k < Math.min(m.arms, 4) * TF_RULES.crosswalk.perApproach; k++) {
          push({
            kind: "crosswalk",
            at: m.at,
            why: `${m.arms} 条 class≤${TF_RULES.crosswalk.maxCls} 的路相交 ⇒ 每方向 1 条（路口 <${TF_RULES.crosswalk.mergeWithinM}m 已合并）`,
          });
        }
      }
    }
    counts.crosswalk.made = features.filter((f) => f.kind === "crosswalk").length;
  }

  /* ── ③ 红绿灯：≥3 条路相交 或 class ≤ 1 相交 ⇒ 各角 1 点 ─────────────────── */
  {
    for (const j of J) {
      const arms = j.arms.length;
      const hasMajor = j.arms.some((a) => (typeof a.cls === "number" ? a.cls : 3) <= TF_RULES.signal.majorCls);
      if (!(arms >= TF_RULES.signal.minArms || hasMajor)) continue;
      const corners = Math.min(arms, 4);
      const radius = 9; // 角点离路口中心 ~9m（示意）
      for (let k = 0; k < corners; k++) {
        const ang = (Math.PI / 2) * k + Math.PI / 4;
        push({
          kind: "signal",
          at: [j.at[0] + Math.cos(ang) * radius, j.at[1] + Math.sin(ang) * radius],
          why: `${arms} 条路相交${hasMajor ? "（含 class≤1 主干）" : ""} ⇒ ${corners} 个角各 1 点`,
        });
      }
    }
    counts.signal.made = features.filter((f) => f.kind === "signal").length;
  }

  /* ── ④ 停车场：楼 ≥1500m² 或 商业/办公 ⇒ 最近路边；距路 >60m 跳过 ────────── */
  {
    for (const b of B) {
      const area = ringAreaM2(b.ring);
      const kindHit = TF_RULES.parking.kinds.includes(b.kind);
      if (!(area >= TF_RULES.parking.minAreaM2 || kindHit)) continue;
      /* 楼重心 → 最近路 */
      const cx = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length;
      const cy = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
      let best: { at: [number, number]; d: number } | null = null;
      for (const r of R) {
        const n = nearestOnLine(r.pts, [cx, cy]);
        if (!best || n.d < best.d) best = n;
      }
      if (!best) continue;
      if (best.d > TF_RULES.parking.maxDistToRoadM) {
        notes.push(`停车场跳过 1 处：楼面积 ${Math.round(area)}m² 但距路 ${Math.round(best.d)}m > ${TF_RULES.parking.maxDistToRoadM}m`);
        continue;
      }
      const spaces = Math.max(
        TF_RULES.parking.minSpaces,
        Math.min(TF_RULES.parking.maxSpaces, Math.round(area / TF_RULES.parking.m2PerSpace))
      );
      push({
        kind: "parking",
        at: best.at,
        count: spaces,
        why: `楼 ${Math.round(area)}m²${kindHit ? `（${b.kind}）` : ""} ⇒ 最近路边（距楼 ${Math.round(best.d)}m）`,
      });
    }
    counts.parking.made = features.filter((f) => f.kind === "parking").length;
  }

  /* ── ⑤ 车行出入口：楼 ≥3000m² ⇒ 楼边界最近点 → 最近路，4~8m 接入线 ─────── */
  {
    for (const b of B) {
      const area = ringAreaM2(b.ring);
      if (area < TF_RULES.driveway.minAreaM2) continue;
      /* 边界上离最近路最近的那个点（simplify：先找最近路，再在环上取最近点） */
      let bestRoad: Array<[number, number]> | null = null;
      let bestD = Infinity;
      for (const r of R) {
        for (const p of b.ring) {
          const n = nearestOnLine(r.pts, p);
          if (n.d < bestD) {
            bestD = n.d;
            bestRoad = r.pts;
          }
        }
      }
      if (!bestRoad) continue;
      let edge: [number, number] | null = null;
      let roadPt: [number, number] | null = null;
      for (const p of b.ring) {
        const n = nearestOnLine(bestRoad, p);
        if (!edge || n.d < dist(edge, roadPt || n.at)) {
          edge = p;
          roadPt = n.at;
        }
      }
      if (!edge || !roadPt) continue;
      /* 接入线长夹到 4~8m（沿"楼边界→路"方向截取） */
      const d = dist(edge, roadPt);
      const len = Math.max(TF_RULES.driveway.accessMinM, Math.min(TF_RULES.driveway.accessMaxM, d));
      const t = d > 0 ? len / d : 0;
      const end: [number, number] = [edge[0] + (roadPt[0] - edge[0]) * t, edge[1] + (roadPt[1] - edge[1]) * t];
      push({
        kind: "driveway",
        at: edge,
        to: end,
        why: `楼 ${Math.round(area)}m² ≥ ${TF_RULES.driveway.minAreaM2}m² ⇒ 边界最近点接入最近路（线长 ${Math.round(len)}m）`,
      });
    }
    counts.driveway.made = features.filter((f) => f.kind === "driveway").length;
  }

  /* ── 上限裁剪（**按离视野中心的距离取近**，不随机丢）+ 数量回证 ───────────── */
  const lowSet = new Set<TfKind>(low ? (["bus", "signal"] as TfKind[]) : (["bus", "crosswalk", "signal", "parking", "driveway"] as TfKind[]));
  const kept: TfFeature[] = [];
  for (const kind of ["bus", "crosswalk", "signal", "parking", "driveway"] as TfKind[]) {
    const items = features.filter((f) => f.kind === kind);
    if (!items.length) continue;
    if (!lowSet.has(kind)) {
      counts[kind].droppedByCap = items.length;
      counts[kind].kept = 0;
      notes.push(`${kind}: 低档不画（${items.length} 个已生成但按规则关掉）`);
      continue;
    }
    const { kept: k, dropped } = capByDistance(items, TF_CAPS[kind], [0, 0]);
    counts[kind].kept = k.length;
    counts[kind].droppedByCap = dropped;
    for (const f of k) kept.push(f);
  }

  /* 回米平面 → 经纬度 */
  const geo = kept.map((f) => ({
    ...f,
    at: toLngLat(f.at, O),
    ...(f.to ? { to: toLngLat(f.to, O) } : {}),
  }));
  return { features: geo, counts, notes };
}

/** 一句话回证（HUD 直接显示）：`交通设施 N（示意，非事实）· 各 12/3/8/2/5 · 裁掉 4` */
export function transportHudLine(r: TfResult): string {
  const n = r.features.length;
  const dropped = (["bus", "crosswalk", "signal", "parking", "driveway"] as TfKind[]).reduce(
    (s, k) => s + r.counts[k].droppedByCap,
    0
  );
  const per = (["bus", "crosswalk", "signal", "parking", "driveway"] as TfKind[])
    .map((k) => r.counts[k].kept)
    .join("/");
  return `交通设施 ${n}（示意，非事实）· 公交/斑马线/红绿灯/停车/出入口 = ${per}${dropped ? ` · 上限裁掉 ${dropped}` : ""}`;
}
