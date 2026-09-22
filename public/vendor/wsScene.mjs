// src/components/views/worldsim/wsTransportRules.ts
var TF_RULES = {
  bus: {
    /** 只沿 class ≤ 2 的路设站 */
    maxCls: 2,
    /** 站间目标间隔（米）：350~500 ⇒ 生成时用 `spacing` 做步长，落点会因路口吸附而落在区间内 */
    spacing: 420,
    minGap: 350,
    maxGap: 500,
    /** 优先落在**路口 40m 内**：在这个半径内若有路口，就把站点挪过去 */
    preferJunctionM: 40,
    /** 上限（超出**按距离取近**，不随机丢） */
    cap: 20
  },
  crosswalk: {
    maxCls: 3,
    /** 交叉口的**每个方向**各 1 条 */
    perApproach: 1,
    /** 路口间距 < 80m ⇒ **合并**（同一条斑马线服务两个路口） */
    mergeWithinM: 80,
    cap: 60
  },
  signal: {
    /** ≥3 条路相交 或 class ≤ 1 相交 ⇒ 设灯 */
    minArms: 3,
    majorCls: 1,
    /** 路口**各角 1 点**（4 个角；三岔口只有 3 个角） */
    perCorner: 1,
    cap: 30
  },
  parking: {
    /** 楼脚印 ≥ 1500 m² 或 商业/办公 ⇒ 配停车场 */
    minAreaM2: 1500,
    /** 触发停车场的用途（**string[] 而不是字面量元组**：调用方的 kind 是任意字符串，
        不然 `includes(b.kind)` 过不了类型检查 —— 这是类型与运行时语义的正当放宽，不是偷懒） */
    kinds: ["commercial", "office", "retail", "supermarket"],
    /** 距路 > 60m ⇒ **跳过**（车开不进去的停车场没有意义） */
    maxDistToRoadM: 60,
    /** 车位数按面积算（每车位 25 m²，含通道） */
    m2PerSpace: 25,
    minSpaces: 4,
    maxSpaces: 20,
    cap: 15
  },
  driveway: {
    /** 楼脚印 ≥ 3000 m² ⇒ 车行出入口 */
    minAreaM2: 3e3,
    /** 楼边界最近点 → 最近路，接入线长 4~8m */
    accessMinM: 4,
    accessMaxM: 8,
    cap: 30
  }
};
var TF_CAPS = {
  bus: TF_RULES.bus.cap,
  crosswalk: TF_RULES.crosswalk.cap,
  signal: TF_RULES.signal.cap,
  parking: TF_RULES.parking.cap,
  driveway: TF_RULES.driveway.cap
};
var TF_LAYER_IDS = {
  bus: "tf-bus",
  crosswalk: "tf-cross",
  signal: "tf-signal",
  parking: "tf-park",
  driveway: "tf-drive"
};
var TF_LAYER_STYLE = {
  bus: {
    type: "circle",
    paint: { "circle-radius": 3.4, "circle-color": "#2F7FD8", "circle-stroke-width": 1.2, "circle-stroke-color": "#FFFFFF" }
  },
  crosswalk: {
    type: "line",
    paint: { "line-color": "#FFFFFF", "line-width": 2.2, "line-opacity": 0.9 }
  },
  signal: {
    type: "circle",
    paint: { "circle-radius": 2.6, "circle-color": "#FFC24B", "circle-stroke-width": 1, "circle-stroke-color": "#1B3550" }
  },
  parking: {
    type: "circle",
    paint: { "circle-radius": 3, "circle-color": "#79D9FF", "circle-stroke-width": 1, "circle-stroke-color": "#FFFFFF" }
  },
  driveway: {
    type: "line",
    paint: { "line-color": "#BFE6FF", "line-width": 2.6, "line-opacity": 0.95 }
  }
};
var TF_LOW_TIER_KINDS = ["bus", "signal"];

// src/components/views/worldsim/wsTransport.ts
var M_PER_DEG_LAT = 111320;
function toMeters(p, origin) {
  const latRad = origin[1] * Math.PI / 180;
  const mx = 111320 * Math.cos(latRad);
  return [(p[0] - origin[0]) * mx, (p[1] - origin[1]) * M_PER_DEG_LAT];
}
function toLngLat(p, origin) {
  const latRad = origin[1] * Math.PI / 180;
  const mx = 111320 * Math.cos(latRad);
  return [origin[0] + p[0] / mx, origin[1] + p[1] / M_PER_DEG_LAT];
}
var dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function sampleAlong(line, step) {
  const out = [];
  let acc = 0;
  let next = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
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
function nearestOnLine(line, p) {
  let best = line[0] || p;
  let bd = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)) : 0;
    const q = [a[0] + vx * t, a[1] + vy * t];
    const d = dist(q, p);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return { at: best, d: bd };
}
function ringAreaM2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
function segIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + d1x * t, p1[1] + d1y * t];
}
function junctions(roads, withinM = 18) {
  const out = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i];
      const B = roads[j];
      let hit = null;
      for (let ai = 1; ai < A.pts.length && !hit; ai++) {
        for (let bi = 1; bi < B.pts.length && !hit; bi++) {
          hit = segIntersect(A.pts[ai - 1], A.pts[ai], B.pts[bi - 1], B.pts[bi]);
        }
      }
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
      const near = out.find((o) => dist(o.at, hit) <= withinM * 1.6);
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
function capByDistance(items, cap, center) {
  if (items.length <= cap) return { kept: items, dropped: 0 };
  const sorted = [...items].sort((a, b) => dist(a.at, center) - dist(b.at, center));
  return { kept: sorted.slice(0, cap), dropped: items.length - cap };
}
function buildTransport(roads, buildings, center, low = false) {
  const notes = [];
  const counts = {
    bus: { made: 0, kept: 0, droppedByCap: 0 },
    crosswalk: { made: 0, kept: 0, droppedByCap: 0 },
    signal: { made: 0, kept: 0, droppedByCap: 0 },
    parking: { made: 0, kept: 0, droppedByCap: 0 },
    driveway: { made: 0, kept: 0, droppedByCap: 0 }
  };
  if (low) notes.push("低档：只画 公交站 + 红绿灯（其余按规则关掉，保帧率）");
  const O = center;
  const R = roads.map((r) => ({ cls: typeof r.cls === "number" ? r.cls : 3, name: r.name || "", pts: r.pts.map((p) => toMeters(p, O)) })).filter((r) => r.pts.length >= 2);
  const B = buildings.map((b) => ({ kind: String(b.kind || "").toLowerCase(), name: b.name || "", ring: b.ring.map((p) => toMeters(p, O)) })).filter((b) => b.ring.length >= 3);
  const J = junctions(
    R.map((r) => ({ pts: r.pts, cls: r.cls, name: r.name })),
    18
  );
  const features = [];
  const push = (f) => {
    features.push(f);
  };
  if (!low || true) {
    const busRoads = R.filter((r) => r.cls <= TF_RULES.bus.maxCls);
    for (const r of busRoads) {
      const samples = sampleAlong(r.pts, TF_RULES.bus.spacing);
      for (const sp of samples) {
        let at = sp.p;
        let why = `沿 class ${r.cls} 路每 ${TF_RULES.bus.spacing}m 设站`;
        const j = J.map((x) => ({ x, d: dist(x.at, sp.p) })).filter((o) => o.d <= TF_RULES.bus.preferJunctionM).sort((a, b) => a.d - b.d)[0];
        if (j) {
          at = j.x.at;
          why = `路口 ${Math.round(j.d)}m 内 ⇒ 站点吸附到路口`;
        }
        push({ kind: "bus", at, why, name: (r.name ? r.name : "公交") + "站" });
      }
    }
    counts.bus.made = features.filter((f) => f.kind === "bus").length;
    const keptBus = [];
    const busByRoad = /* @__PURE__ */ new Map();
    for (const f of features.filter((x) => x.kind === "bus")) {
      const key = String(f.name || "");
      const arr = busByRoad.get(key) || [];
      arr.push(f);
      busByRoad.set(key, arr);
    }
    for (const arr of busByRoad.values()) {
      const mine = [];
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
  {
    const merged = [];
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
            why: `${m.arms} 条 class≤${TF_RULES.crosswalk.maxCls} 的路相交 ⇒ 每方向 1 条（路口 <${TF_RULES.crosswalk.mergeWithinM}m 已合并）`
          });
        }
      }
    }
    counts.crosswalk.made = features.filter((f) => f.kind === "crosswalk").length;
  }
  {
    for (const j of J) {
      const arms = j.arms.length;
      const hasMajor = j.arms.some((a) => (typeof a.cls === "number" ? a.cls : 3) <= TF_RULES.signal.majorCls);
      if (!(arms >= TF_RULES.signal.minArms || hasMajor)) continue;
      const corners = Math.min(arms, 4);
      const radius = 9;
      for (let k = 0; k < corners; k++) {
        const ang = Math.PI / 2 * k + Math.PI / 4;
        push({
          kind: "signal",
          at: [j.at[0] + Math.cos(ang) * radius, j.at[1] + Math.sin(ang) * radius],
          why: `${arms} 条路相交${hasMajor ? "（含 class≤1 主干）" : ""} ⇒ ${corners} 个角各 1 点`
        });
      }
    }
    counts.signal.made = features.filter((f) => f.kind === "signal").length;
  }
  {
    for (const b of B) {
      const area = ringAreaM2(b.ring);
      const kindHit = TF_RULES.parking.kinds.includes(b.kind);
      if (!(area >= TF_RULES.parking.minAreaM2 || kindHit)) continue;
      const cx = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length;
      const cy = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
      let best = null;
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
        why: `楼 ${Math.round(area)}m²${kindHit ? `（${b.kind}）` : ""} ⇒ 最近路边（距楼 ${Math.round(best.d)}m）`
      });
    }
    counts.parking.made = features.filter((f) => f.kind === "parking").length;
  }
  {
    for (const b of B) {
      const area = ringAreaM2(b.ring);
      if (area < TF_RULES.driveway.minAreaM2) continue;
      let bestRoad = null;
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
      let edge = null;
      let roadPt = null;
      for (const p of b.ring) {
        const n = nearestOnLine(bestRoad, p);
        if (!edge || n.d < dist(edge, roadPt || n.at)) {
          edge = p;
          roadPt = n.at;
        }
      }
      if (!edge || !roadPt) continue;
      const d = dist(edge, roadPt);
      const len = Math.max(TF_RULES.driveway.accessMinM, Math.min(TF_RULES.driveway.accessMaxM, d));
      const t = d > 0 ? len / d : 0;
      const end = [edge[0] + (roadPt[0] - edge[0]) * t, edge[1] + (roadPt[1] - edge[1]) * t];
      push({
        kind: "driveway",
        at: edge,
        to: end,
        why: `楼 ${Math.round(area)}m² ≥ ${TF_RULES.driveway.minAreaM2}m² ⇒ 边界最近点接入最近路（线长 ${Math.round(len)}m）`
      });
    }
    counts.driveway.made = features.filter((f) => f.kind === "driveway").length;
  }
  const lowSet = new Set(low ? ["bus", "signal"] : ["bus", "crosswalk", "signal", "parking", "driveway"]);
  const kept = [];
  for (const kind of ["bus", "crosswalk", "signal", "parking", "driveway"]) {
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
  const geo = kept.map((f) => ({
    ...f,
    at: toLngLat(f.at, O),
    ...f.to ? { to: toLngLat(f.to, O) } : {}
  }));
  return { features: geo, counts, notes };
}
function transportHudLine(r) {
  const n = r.features.length;
  const dropped = ["bus", "crosswalk", "signal", "parking", "driveway"].reduce(
    (s, k) => s + r.counts[k].droppedByCap,
    0
  );
  const per = ["bus", "crosswalk", "signal", "parking", "driveway"].map((k) => r.counts[k].kept).join("/");
  return `交通设施 ${n}（示意，非事实）· 公交/斑马线/红绿灯/停车/出入口 = ${per}${dropped ? ` · 上限裁掉 ${dropped}` : ""}`;
}

// src/components/views/worldsim/wsRoads.ts
var ROAD_RANK_STYLE = {
  0: { label: "快速路", w: 4.2, color: "#e8dcc0", minzoom: 11 },
  1: { label: "主干道", w: 3.4, color: "#dfd2b4", minzoom: 11 },
  2: { label: "次干道", w: 2.6, color: "#c8c0ae", minzoom: 12.5 },
  3: { label: "支路", w: 1.8, color: "#a9b3bd", minzoom: 13.5 },
  4: { label: "社区路", w: 1.2, color: "#8fa0b0", minzoom: 14.5 },
  5: { label: "步道", w: 0.8, color: "#79d9ff", minzoom: 15.5 }
};
var ROAD_STYLE_FALLBACK = ROAD_RANK_STYLE[3];
function roadStyleOf(rank) {
  const r = Number(rank);
  return Number.isFinite(r) ? ROAD_RANK_STYLE[r] ?? ROAD_STYLE_FALLBACK : ROAD_STYLE_FALLBACK;
}
var ROAD_PALETTE_DARK = {
  casing: "#0b1017",
  casingOpacity: 0.75,
  rankColors: { 0: "#e8dcc0", 1: "#dfd2b4", 2: "#c8c0ae", 3: "#a9b3bd", 4: "#8fa0b0", 5: "#79d9ff" }
};
function roadLayerSpecs(palette = ROAD_PALETTE_DARK) {
  const out = [];
  for (const key of Object.keys(ROAD_RANK_STYLE).map(Number).sort((a, b) => a - b)) {
    const s = ROAD_RANK_STYLE[key];
    out.push({
      id: `road-casing-${key}`,
      type: "line",
      source: "roads",
      minzoom: s.minzoom,
      filter: ["==", ["get", "rank"], key],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": palette.casing, "line-width": s.w + 1.6, "line-opacity": palette.casingOpacity }
    });
  }
  for (const key of Object.keys(ROAD_RANK_STYLE).map(Number).sort((a, b) => a - b)) {
    const s = ROAD_RANK_STYLE[key];
    out.push({
      id: `road-line-${key}`,
      type: "line",
      source: "roads",
      minzoom: s.minzoom,
      filter: ["==", ["get", "rank"], key],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": palette.rankColors[key] ?? s.color,
        /* 桥隧稍微亮一点：立交/跨江桥在地图上就该比地面路显眼（也是"可走"的强提示） */
        "line-opacity": ["case", ["get", "bridge"], 0.95, ["get", "tunnel"], 0.5, 0.8],
        "line-width": s.w
      }
    });
  }
  return out;
}
function roadStatsLine(stats) {
  const n = Number(stats?.count) || 0;
  if (!n) return "";
  const by = stats?.by_rank || {};
  const main = (Number(by["0"]) || 0) + (Number(by["1"]) || 0) + (Number(by["2"]) || 0);
  const named = Number(stats?.named) || 0;
  return `${n} 条路（主干 ${main} · 有名字 ${named}）`;
}
function visibleRoadCount(fc, zoom) {
  let n = 0;
  for (const f of fc?.features || []) {
    if (roadStyleOf((f.properties || {}).rank).minzoom <= zoom) n++;
  }
  return n;
}
export {
  ROAD_PALETTE_DARK,
  ROAD_RANK_STYLE,
  ROAD_STYLE_FALLBACK,
  TF_CAPS,
  TF_LAYER_IDS,
  TF_LAYER_STYLE,
  TF_LOW_TIER_KINDS,
  TF_RULES,
  buildTransport,
  junctions,
  nearestOnLine,
  ringAreaM2,
  roadLayerSpecs,
  roadStatsLine,
  roadStyleOf,
  toLngLat,
  toMeters,
  transportHudLine,
  visibleRoadCount
};
