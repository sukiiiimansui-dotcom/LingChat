// src/components/views/worldsim/wsTransportRules.ts
var TF_RULES = {
  bus: {
    /** 只沿 class ≤ 2 的路设站 */
    maxCls: 2,
    /** 站间目标间隔（米）：350~500 ⇒ 生成时用 `spacing` 做步长，落点会因路口吸附而落在区间内 */
    spacing: 250,
    // 机主 2026-09-22：太稀 ⇒ 420 → 250（一处改，生成逻辑跟着变）
    minGap: 220,
    maxGap: 300,
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
    minAreaM2: 800,
    // 2026-09-22：1500 → 800（设施太稀）
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
    minAreaM2: 1500,
    // 2026-09-22：3000 → 1500（同上）
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
var zoomScale = (z0, s0, z1, s1) => [
  "interpolate",
  ["linear"],
  ["zoom"],
  z0,
  s0,
  z1,
  s1
];
var TF_LAYER_STYLE = {
  /* 公交站 = **蓝色圆**（最大，一眼能认出"这是站"） */
  bus: {
    type: "circle",
    paint: {
      "circle-radius": zoomScale(13, 2.4, 18, 6.5),
      "circle-color": "#1E6FD9",
      "circle-stroke-width": 1.4,
      "circle-stroke-color": "#FFFFFF"
    }
  },
  /* 人行横道 = **白色短虚线**（线状：看得出来"横过马路"） */
  crosswalk: {
    type: "line",
    paint: {
      "line-color": "#FFFFFF",
      "line-width": zoomScale(13, 1.6, 18, 4.5),
      "line-opacity": 0.95,
      "line-dasharray": [1.2, 1.2]
    }
  },
  /* 红绿灯 = **红/黄小点**（比公交站小一档，颜色最跳） */
  signal: {
    type: "circle",
    paint: {
      "circle-radius": zoomScale(13, 1.8, 18, 4.2),
      "circle-color": "#FF5A3C",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#FFD24B"
    }
  },
  /* 停车场 = **青色方块**（`circle` + 方角：MapLibre 圆没有方形 ⇒ 用大描边近似"牌"的观感） */
  parking: {
    type: "circle",
    paint: {
      "circle-radius": zoomScale(13, 2.2, 18, 5.2),
      "circle-color": "#20C4C8",
      "circle-stroke-width": 2.2,
      "circle-stroke-color": "#0B3B3D"
    }
  },
  /* 车行出入口 = **浅灰线**（贴着楼边，别抢眼） */
  driveway: {
    type: "line",
    paint: {
      "line-color": "#D8E6F2",
      "line-width": zoomScale(13, 2, 18, 5),
      "line-opacity": 0.95
    }
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
  const extra = r.counts.signal.kept === 0 ? "（红绿灯这一类要求「≥3 条路相交」或含主干路，**当前数据下常常为 0** —— 规则不为此放宽到失真）" : "";
  return `交通设施 ${n}（示意，非事实）· 公交/斑马线/红绿灯/停车/出入口 = ${per}${dropped ? ` · 上限裁掉 ${dropped}` : ""}${extra}`;
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

// src/components/views/worldsim/wsLayerOrder.ts
var TF_LAYER_ID_LIST = ["tf-cross", "tf-drive", "tf-park", "tf-bus", "tf-signal"];
var BUILDING_LAYER_ID = "bld-ext";
var ROAD_LAYER_PREFIXES = ["road-casing-", "road-line-"];
function roadLayersOf(m) {
  return m.layerIds().filter((id) => ROAD_LAYER_PREFIXES.some((p) => id.startsWith(p)));
}
function planEnsureRoadOrder(m) {
  const ops = [];
  const roads = roadLayersOf(m);
  if (!m.hasSource("roads") || !roads.length) {
    return [{ op: "add-roads", why: m.hasSource("roads") ? "路网图层缺失 ⇒ 重新补层" : "roads source 缺失 ⇒ 重建" }];
  }
  const ids = m.layerIds();
  const idx = (id) => ids.indexOf(id);
  const firstRoad = Math.min(...roads.map(idx));
  const tfIdx = TF_LAYER_ID_LIST.map(idx).filter((i) => i >= 0);
  const bldIdx = idx(BUILDING_LAYER_ID);
  const blockers = [];
  const lowestTf = tfIdx.length ? Math.min(...tfIdx) : -1;
  if (lowestTf >= 0 && firstRoad > lowestTf) blockers.push("交通设施");
  if (bldIdx >= 0 && firstRoad > bldIdx) blockers.push("楼体");
  if (!blockers.length) return ops;
  let before = "";
  if (lowestTf >= 0 && bldIdx >= 0) before = lowestTf < bldIdx ? ids[lowestTf] : ids[bldIdx];
  else if (lowestTf >= 0) before = ids[lowestTf];
  else before = ids[bldIdx];
  for (const id of roads) ops.push({ op: "move", id, before, why: `路网被「${blockers.join("+")}」压在上面 ⇒ 显式移到它之下` });
  return ops;
}
function layerOrderHud(heals, roads) {
  return `🛣 ${roads} 条 · 层序自愈 ${heals} 次`;
}
function roadCountVerdict(input) {
  if (!input.hasSource || input.layerCount === 0) {
    return {
      state: "missing",
      n: 0,
      gauge: "unknown",
      why: input.hasSource ? "路网图层 0 个 ⇒ **确实没画上**" : "没有 roads source ⇒ **确实没画上**"
    };
  }
  if (typeof input.rendered === "number" && input.rendered > 0) {
    return { state: "ok", n: input.rendered, gauge: "rendered", why: "屏幕可见要素（queryRenderedFeatures）" };
  }
  if (typeof input.source === "number" && input.source > 0) {
    return { state: "ok", n: input.source, gauge: "source", why: "数据源要素（querySourceFeatures）" };
  }
  const tileTxt = input.tilesLoaded === true ? "瓦片已加载" : input.tilesLoaded === false ? "**瓦片还没加载完**" : "瓦片状态未知";
  return {
    state: "unknown",
    n: null,
    gauge: "unknown",
    why: `图层都在（${input.layerCount} 个）但两种口径都数不出要素（rendered=${String(input.rendered)}、source=${String(input.source)}，${tileTxt}）⇒ **数不出来**，不代表没有路`
  };
}
function roadCountHud(v, layerCount, heals) {
  const nTxt = v.state === "unknown" ? "数不出来" : String(v.n ?? 0);
  const tail = v.state === "missing" ? " · **路网没画上**" : "";
  return `🛣 ${nTxt} 条 · 图层 ${layerCount} 个 · 自愈 ${heals} 次 · 口径=${v.gauge}${tail}`;
}

// src/components/views/worldsim/wsArtSky.ts
function hash01(i, seed) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function buildSkyGeometry(w, h, horizonY, pitch, zoom, low = false, seed = 1) {
  const empty = { clouds: [], ridges: [], fog: { y: horizonY, h: 0, alpha: 0 } };
  if (low || w <= 0 || h <= 0) return empty;
  const skyH = Math.max(0, Math.min(h, horizonY));
  if (skyH < 24) return empty;
  const k = Math.max(0.6, Math.min(2.2, 1 + (zoom - 15) * 0.08));
  const n = Math.max(3, Math.min(9, Math.round(4 + k * 2)));
  const clouds = [];
  for (let i = 0; i < n; i++) {
    const u = hash01(i, seed);
    const v = hash01(i + 100, seed);
    const x = (0.06 + 0.88 * u) * w;
    const yMax = Math.max(10, skyH * 0.92);
    const y = 0.08 * yMax + v * 0.84 * yMax;
    const rx = (34 + 70 * hash01(i + 200, seed)) * k;
    const ry = rx * (0.32 + 0.16 * hash01(i + 300, seed));
    const near = 1 - Math.min(1, y / yMax);
    clouds.push({ x, y, rx, ry, a: 0.16 + 0.3 * near * (0.6 + 0.4 * hash01(i + 400, seed)) });
  }
  const layers = 3;
  const bandH = Math.max(10, Math.min(skyH * 0.18, 46));
  const ridges = [];
  for (let L = 0; L < layers; L++) {
    const far = layers - 1 - L;
    const amp = bandH * (0.35 + 0.3 * far) / layers;
    const baseY = skyH - bandH * 0.15 + far * (bandH / layers);
    const pts = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const x = i / steps * w;
      const yy = baseY - amp * (0.6 + 0.4 * Math.sin(i / steps * Math.PI * (1.5 + 0.5 * L) + L * 1.7)) - amp * 0.35 * Math.sin(i / steps * Math.PI * (4 + L));
      pts.push([x, yy]);
    }
    pts.push([w, skyH + bandH], [0, skyH + bandH]);
    ridges.push({ layer: L, alpha: 0.1 + 0.14 * L, pts });
  }
  const fog = { y: skyH, h: Math.max(12, bandH * 0.9), alpha: 0.22 };
  return { clouds, ridges, fog };
}
function horizonYOf(h, pitch) {
  const t = Math.max(0, Math.min(1, (pitch - 20) / 60));
  return Math.round(h * (0.78 - 0.42 * t));
}
function art3Summary() {
  return "art=3 比 art=2 多：① 云带（地平线以上、不遮地图）② 三层远景山影 + 雾带 ③ 底图更偏水青（raster 整体调色，**我们没有水系矢量数据**）";
}
function relLuminance(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}
function contrastReport(ramp, ground, outline) {
  const lGround = relLuminance(ground);
  const dark = (ramp && ramp.length ? ramp.map((r) => r[1]) : []).map((c) => relLuminance(c));
  const lBldDark = dark.length ? Math.min(...dark) : 0.5;
  const bldGroundRatio = +(lBldDark / Math.max(1e-6, lGround)).toFixed(2);
  const outlineGroundRatio = contrastRatio(outline, ground);
  const ok = outlineGroundRatio >= 4.5 || bldGroundRatio <= 0.85;
  return {
    bldGroundRatio,
    outlineGroundRatio,
    verdict: ok ? "ok" : "low",
    why: ok ? `描边对地面 ${outlineGroundRatio}:1（≥4.5 达 AA）或楼/地比 ${bldGroundRatio} 够分` : `**对比度不足：可能看不清**（描边对地面只有 ${outlineGroundRatio}:1，楼/地比 ${bldGroundRatio} 也太接近）`
  };
}

// src/components/views/worldsim/wsScene.ts
var WS_SCENE_SOURCE = "wsScene.ts";
var CAMERA_DEFAULTS = {
  center: [116.2, 39.9],
  // 占位中心：真位置由定位/数据 bbox 决定
  zoom: 16.4,
  // 街区级（能看见楼体体量）
  pitch: 38,
  // 抬头能看见天空，又不至于把地面压扁
  bearing: -18,
  // 轻微斜角，楼有立体感
  minZoom: 3,
  maxZoom: 19,
  maxPitch: 70
};
function cameraDefaults() {
  return { ...CAMERA_DEFAULTS };
}
var SCENE_LAYER_ORDER = [
  { group: "roads", idPrefixes: ["road-casing-", "road-line-"], beforeId: "bld-ext", why: "路是地面上的东西，压在楼上会像从楼顶穿过" },
  { group: "transport", idPrefixes: ["tf-"], beforeId: "bld-ext", why: "交通设施**贴在路之上**（先插路网、后插设施 ⇒ 设施在上）" },
  { group: "buildings", idPrefixes: ["bld-"], beforeId: null, why: "楼体在最上（数据层，交互载体）" },
  /* 🛰 LOD 第 1 步（2026-09-24）：预渲染瓦片层。**它在矢量层之上**是刻意的 ——
     远景（z≤12）要让瓦片**盖住**实时层，中间靠 `raster-opacity` 随 zoom 淡到 0 把画面交还矢量层；
     反过来放（瓦片在下）就得给 12 条路网 + 楼体各写一份"淡入"，那才是新造一套机制。
     ⚠️ 这条"在上"由 `sceneOrderViolations()` 守着（被矢量层压住 = 远景会露出实时层）。 */
  { group: "prerender", idPrefixes: ["prerender"], beforeId: "ref", why: "预渲染瓦片 = 远景替身，压在矢量层之上、注记之下（靠 zoom 淡出把近景交还实时层）" }
];
function sceneLayerPlan() {
  return SCENE_LAYER_ORDER.map((e) => ({ ...e }));
}
function sceneGroupOf(layerId) {
  const id = String(layerId || "");
  for (const e of SCENE_LAYER_ORDER) if (e.idPrefixes.some((p) => id.startsWith(p))) return e.group;
  return null;
}
function sceneSelfReport(consumed) {
  return consumed ? { source: WS_SCENE_SOURCE, ok: true, detail: `场景装配真源 = \`${WS_SCENE_SOURCE}\`（相机 + 层序都取自它）` } : {
    source: "（页面自带）",
    ok: false,
    detail: "**这一处还没换源**：相机/层序仍是页面里各写一份 —— 换用 `wsScene.ts` 后这行会变 ✅"
  };
}
function sceneOrderViolations(layerIds) {
  const out = [];
  const idx = (id) => layerIds.indexOf(id);
  const firstOf = (g) => {
    const e = SCENE_LAYER_ORDER.find((x) => x.group === g);
    const positions = layerIds.map((id, i) => e.idPrefixes.some((p) => id.startsWith(p)) ? i : -1).filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : -1;
  };
  const roads = firstOf("roads");
  const tf = firstOf("transport");
  const bld = firstOf("buildings");
  const pre = firstOf("prerender");
  if (roads >= 0 && tf >= 0 && roads > tf) out.push("路网被交通设施压在上面（应在下方）");
  if (roads >= 0 && bld >= 0 && roads > bld) out.push("路网被楼体压在上面（应在下方）");
  if (tf >= 0 && bld >= 0 && tf > bld) out.push("交通设施被楼体压在上面（应在下方）");
  if (pre >= 0) {
    if (roads >= 0 && pre < roads) out.push("预渲染瓦片被路网压住（远景会露出实时路网）");
    if (tf >= 0 && pre < tf) out.push("预渲染瓦片被交通设施压住（远景会露出实时设施）");
    if (bld >= 0 && pre < bld) out.push("预渲染瓦片被楼体压住（远景会露出实时楼体）");
  }
  void idx;
  return out;
}
var PRERENDER_LAYER_ID = "prerender";
var PRERENDER_SOURCE_ID = "prerender";
var PRERENDER_TILE_PATH = "/prerender/{z}/{x}/{y}.png";
var PRERENDER_MANIFEST_PATH = "/prerender/manifest.json";
var PRERENDER_TILE_SIZE = 512;
var PRERENDER_TILE_MAXZOOM = 13;
var LOD_FAR_ZOOM = 12;
var LOD_NEAR_ZOOM = 14;
var PRERENDER_ATTRIBUTION = "预渲染瓦片（自产；骨架阶段为示意瓦片，非真实楼/路数据）";
var LOD_VIEW_TILE_CAP = 2048;
function lodTierOf(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_FAR_ZOOM;
  if (z <= LOD_FAR_ZOOM) return "prerender";
  if (z >= LOD_NEAR_ZOOM) return "vector";
  return "crossfade";
}
function lodTierLabel(tier) {
  if (tier === "prerender") return `预渲染（z≤${LOD_FAR_ZOOM}）`;
  if (tier === "vector") return `实时矢量（z≥${LOD_NEAR_ZOOM}）`;
  return `过渡中（${LOD_FAR_ZOOM}~${LOD_NEAR_ZOOM}）`;
}
function lodOpacityAt(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_FAR_ZOOM;
  if (z <= LOD_FAR_ZOOM) return 1;
  if (z >= LOD_NEAR_ZOOM) return 0;
  return +((LOD_NEAR_ZOOM - z) / (LOD_NEAR_ZOOM - LOD_FAR_ZOOM)).toFixed(4);
}
function lodOpacityExpression() {
  return ["interpolate", ["linear"], ["zoom"], LOD_FAR_ZOOM, 1, LOD_NEAR_ZOOM, 0];
}
function lodSourceSpec() {
  return {
    type: "raster",
    tiles: [PRERENDER_TILE_PATH],
    tileSize: PRERENDER_TILE_SIZE,
    maxzoom: PRERENDER_TILE_MAXZOOM,
    attribution: PRERENDER_ATTRIBUTION
  };
}
function lodLayerSpec() {
  return {
    id: PRERENDER_LAYER_ID,
    type: "raster",
    source: PRERENDER_SOURCE_ID,
    /* z ≥ NEAR 整层隐藏（不透明度那时也正好是 0）⇒ 近景**不再请求瓦片**，也不参与绘制 */
    maxzoom: LOD_NEAR_ZOOM,
    paint: { "raster-opacity": lodOpacityExpression() }
  };
}
function lodPlan() {
  const entry = SCENE_LAYER_ORDER.find((e) => e.group === "prerender");
  return {
    group: "prerender",
    layerId: PRERENDER_LAYER_ID,
    sourceId: PRERENDER_SOURCE_ID,
    beforeId: entry ? entry.beforeId : null,
    tilePath: PRERENDER_TILE_PATH,
    manifestPath: PRERENDER_MANIFEST_PATH,
    tileSize: PRERENDER_TILE_SIZE,
    tileMaxzoom: PRERENDER_TILE_MAXZOOM,
    layerMaxzoom: LOD_NEAR_ZOOM,
    far: LOD_FAR_ZOOM,
    near: LOD_NEAR_ZOOM,
    source: lodSourceSpec(),
    layer: lodLayerSpec()
  };
}
function lodTileKey(z, x, y) {
  return `${Math.round(z)}/${Math.round(x)}/${Math.round(y)}`;
}
function lodTileX(lng, z) {
  return Math.floor((Number(lng) + 180) / 360 * Math.pow(2, z));
}
function lodTileY(lat, z) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const r = clamped * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
function lodViewTiles(bounds, zoom, maxzoom = PRERENDER_TILE_MAXZOOM) {
  if (!bounds || typeof bounds.getWest !== "function") return null;
  const z = Math.max(0, Math.min(Math.round(Number.isFinite(zoom) ? zoom : 0), Math.round(maxzoom)));
  const n = Math.pow(2, z);
  const w = Number(bounds.getWest());
  const e = Number(bounds.getEast());
  const s = Number(bounds.getSouth());
  const nn = Number(bounds.getNorth());
  if (![w, e, s, nn].every((v) => Number.isFinite(v))) return null;
  const clampX = (x) => Math.max(0, Math.min(n - 1, x));
  const x0 = clampX(lodTileX(w, z));
  const x1 = clampX(lodTileX(e, z));
  const y0 = clampX(lodTileY(nn, z));
  const y1 = clampX(lodTileY(s, z));
  const wrap = e < w;
  const xRanges = wrap ? [[x0, n - 1], [0, x1]] : [[Math.min(x0, x1), Math.max(x0, x1)]];
  const yLo = Math.min(y0, y1);
  const yHi = Math.max(y0, y1);
  const capacity = xRanges.reduce((acc, [a, b]) => acc + (b - a + 1), 0) * (yHi - yLo + 1);
  const keys = [];
  let capped = capacity > LOD_VIEW_TILE_CAP;
  for (const [xa, xb] of xRanges) {
    for (let x = xa; x <= xb; x++) {
      for (let y = yLo; y <= yHi; y++) {
        if (keys.length >= LOD_VIEW_TILE_CAP) {
          capped = true;
          break;
        }
        keys.push(lodTileKey(z, x, y));
      }
      if (keys.length >= LOD_VIEW_TILE_CAP) break;
    }
    if (keys.length >= LOD_VIEW_TILE_CAP) break;
  }
  return { z, keys, capped };
}
function lodTileVerdict(input) {
  const empty = {
    hit: null,
    hitGauge: "unknown",
    fail: null,
    failGauge: "unknown",
    view: null,
    inInventory: null,
    absent: null,
    capped: false
  };
  if (!input.enabled) {
    return { state: "off", ...empty, why: "未启用（URL 加 `?lod=1` 才建预渲染层）" };
  }
  const inv = input.inventory === null ? null : input.inventory instanceof Set ? input.inventory : new Set(input.inventory);
  const view = input.view;
  if (!view) {
    return { state: "unknown", ...empty, why: "数不出来：拿不到视野/zoom（地图还没就绪）" };
  }
  const keys = view.keys;
  const inInv = inv === null ? null : keys.filter((k) => inv.has(k)).length;
  const absent = inInv === null ? null : keys.length - inInv;
  const st = input.states || null;
  const hit = st ? st.loaded : input.loaded === null ? null : input.loaded.length;
  const hitGauge = st ? "cache" : input.loaded === null ? "unknown" : "events";
  const fail = st ? st.errored : input.failed === null ? null : input.failed.length;
  const failGauge = st ? "cache" : input.failed === null ? "unknown" : "events";
  const why = [];
  if (inv === null) why.push("清单没取到 ⇒ 「本区应有/清单缺」数不出来");
  if (hit === null) why.push("拿不到瓦片状态、事件里也没有 tile 坐标 ⇒ 命中数不出来");
  if (absent !== null && absent > 0) why.push(`视野里有 ${absent} 张**清单里没有** ⇒ 它们必然取不到（这是确定性证据，不依赖事件）`);
  if (view.capped) why.push(`视野瓦片数超过上限 ${LOD_VIEW_TILE_CAP} ⇒ 只数了一部分（不能说"共 N 张"）`);
  if (keys.length === 0) why.push("视野里一张都算不出来（边界异常？）");
  const state = absent !== null && absent > 0 ? "missing" : hit === null || inv === null || keys.length === 0 ? "unknown" : "ok";
  return {
    state,
    hit,
    hitGauge,
    fail,
    failGauge,
    inInventory: inInv,
    absent,
    capped: view.capped,
    view: view.capped ? null : keys.length,
    why: why.length ? why.join("；") : "视野瓦片与清单一致（口径：清单 = 生成脚本写出的键）"
  };
}
function lodEventTileKey(e) {
  const ev = e || {};
  const cands = [ev.coord, ev.tile && ev.tile.tileID, ev.tileID];
  for (const c of cands) {
    if (!c) continue;
    const can = c.canonical || c;
    const z = Number(can.z);
    const x = Number(can.x);
    const y = Number(can.y);
    if (Number.isFinite(z) && Number.isFinite(x) && Number.isFinite(y)) return lodTileKey(z, x, y);
  }
  return null;
}
function lodLiveVerdict(input) {
  if (input.layerCount === 0) {
    return { state: "missing", n: 0, gauge: "unknown", why: "实时矢量层 0 个 ⇒ **确实没有**（不是数不出来）" };
  }
  if (typeof input.rendered === "number" && input.rendered > 0) {
    return { state: "ok", n: input.rendered, gauge: "rendered", why: "屏幕可见要素（queryRenderedFeatures）" };
  }
  if (typeof input.source === "number" && input.source > 0) {
    return { state: "ok", n: input.source, gauge: "source", why: "数据源要素（querySourceFeatures）" };
  }
  const tileTxt = input.tilesLoaded === true ? "瓦片已加载" : input.tilesLoaded === false ? "**瓦片还没加载完**" : "瓦片状态未知";
  return {
    state: "unknown",
    n: null,
    gauge: "unknown",
    why: `图层都在（${input.layerCount} 个）但两种口径都数不出要素（rendered=${String(input.rendered)}、source=${String(input.source)}，${tileTxt}）⇒ **数不出来**，不代表没有`
  };
}
function lodNum(n, measuredZero = "0（已量）") {
  if (n === null || n === void 0) return "数不出来";
  if (n === 0) return measuredZero;
  return String(n);
}
function lodHudLine(input) {
  if (!input.enabled) return "🛰 LOD 未启用（URL 加 `?lod=1`；当前未建预渲染层）";
  const t = lodTierOf(input.zoom);
  const v = input.tiles;
  const tileTxt = `瓦片 命中 ${lodNum(v.hit)}（口径=${v.hitGauge}） · 失败 ${lodNum(v.fail)}（口径=${v.failGauge}） · 清单缺 ${lodNum(v.absent)} · 本区应有 ${lodNum(v.view)}` + (v.capped ? " ⚠️被上限截断" : "");
  const liveTxt = input.live ? `实时层 ${input.live.state === "missing" ? "0（已量：图层没建）" : lodNum(input.live.n)} 要素` : "实时层 数不出来（还没查）";
  return `🛰 LOD[${lodTierLabel(t)} 不透明度 ${lodOpacityAt(input.zoom).toFixed(2)}] ${tileTxt} · ${liveTxt}`;
}
var PITCH_SOFT = 55;
var PAN_MAX_SPEED = 1400;
var WHEEL_ZOOM_RATE = 1 / 450;
function panDamping(pitch) {
  const p = Number.isFinite(pitch) ? pitch : 0;
  return p <= PITCH_SOFT ? 1 : 1 / (1 + (p - PITCH_SOFT) / 25);
}
function pitchGuardParams(pitch) {
  const damping = panDamping(pitch);
  return { damping, maxSpeed: Math.round(PAN_MAX_SPEED * damping), wheelZoomRate: WHEEL_ZOOM_RATE * damping };
}
function applyPitchGuard(map) {
  try {
    const p = map && typeof map.getPitch === "function" ? map.getPitch() : 0;
    const { damping, maxSpeed, wheelZoomRate } = pitchGuardParams(p);
    if (map && map.dragPan && typeof map.dragPan.enable === "function") map.dragPan.enable({ maxSpeed });
    if (map && map.scrollZoom && typeof map.scrollZoom.setWheelZoomRate === "function") map.scrollZoom.setWheelZoomRate(wheelZoomRate);
    return damping;
  } catch {
    return 1;
  }
}

// src/components/views/worldsim/wsBuildingLook.ts
var KIND_HEIGHT_M = {
  house: 7,
  detached: 7,
  semidetached_house: 7,
  terrace: 9,
  bungalow: 4,
  hut: 3,
  shed: 3,
  garage: 3,
  garages: 3,
  carport: 3,
  roof: 3,
  residential: 18,
  dormitory: 15,
  apartments: 21,
  commercial: 15,
  retail: 12,
  office: 45,
  hotel: 40,
  tower: 90,
  hospital: 24,
  school: 12,
  university: 15,
  kindergarten: 9,
  industrial: 10,
  warehouse: 9,
  factory: 10,
  church: 18,
  temple: 10,
  mosque: 15,
  museum: 18,
  construction: 12,
  yes: 16.5
};
var UNKNOWN_KIND_BAND_M = [15, 18];
var FALLBACK_HEIGHT_M = 16.5;
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
var KIND_JITTER = 0.15;
var MAX_RENDER_H = 500;
function renderHeight(props) {
  const p = props || {};
  const raw = Number(p.height);
  const src = String(p.height_src || "default");
  if (Number.isFinite(raw) && raw > 0) {
    if (src === "height") return { h: Math.min(MAX_RENDER_H, raw), from: "real" };
    if (src === "levels") return { h: Math.min(MAX_RENDER_H, raw), from: "levels" };
  }
  const seed = String(p.osm_id || p.name || "x");
  const kind = String(p.kind || "yes").toLowerCase();
  if (kind === "yes" || !Object.prototype.hasOwnProperty.call(KIND_HEIGHT_M, kind)) {
    const k2 = hash32(seed + "#unk") % 101;
    const h2 = UNKNOWN_KIND_BAND_M[0] + (UNKNOWN_KIND_BAND_M[1] - UNKNOWN_KIND_BAND_M[0]) * k2 / 100;
    return { h: Math.min(MAX_RENDER_H, Math.max(3, Math.round(h2 * 10) / 10)), from: "kind" };
  }
  const base = KIND_HEIGHT_M[kind] ?? FALLBACK_HEIGHT_M;
  const k = hash32(seed) % 31;
  const jitter = 1 - KIND_JITTER + 2 * KIND_JITTER * k / 30;
  const h = Math.max(3, Math.round(base * jitter * 10) / 10);
  return { h: Math.min(MAX_RENDER_H, h), from: "kind" };
}
function decorateBuildings(fc, ramp = HEIGHT_COLOR_RAMP, opts = {}) {
  const feats = fc?.features || [];
  const count = {
    n: feats.length,
    real: 0,
    levels: 0,
    kind: 0,
    /* ⚠️ 默认档位 = `base`（App 侧不传 opts ⇒ 行为与这一版之前**逐字节相同**）。
       `detail` 只在代拍页 `?bld=2` 打开。 */
    mode: opts.mode === "detail" ? "detail" : "base",
    low: !!opts.low,
    body: 0,
    podium: 0,
    tower: 0,
    setback: 0,
    roof: 0,
    parapet: 0,
    equip: 0,
    antenna: 0,
    equipSkipped: 0,
    skipped: 0,
    skippedWhy: "",
    parts: 0
  };
  const out = [];
  for (const f of feats) {
    count[renderHeight(f.properties).from]++;
    const set = buildingPartSet(f, ramp, opts);
    for (const part of set.parts) {
      out.push(part);
      const k = String(part.properties.part || "");
      if (k === "body") count.body++;
      else if (k === "podium") count.podium++;
      else if (k === "tower") count.tower++;
      else if (k === "setback") count.setback++;
      else if (k === "roof") count.roof++;
      else if (k === "parapet") count.parapet++;
      else if (k === "equip") count.equip++;
      else if (k === "antenna") count.antenna++;
    }
    if (set.info.skipped) {
      count.skipped++;
      if (!count.skippedWhy) count.skippedWhy = set.info.skipWhy;
    }
    count.equipSkipped += set.info.equipSkipped;
  }
  count.parts = out.length;
  return { features: out, count };
}
var HEIGHT_COLOR_RAMP = [
  [3, "#23323e"],
  [8, "#2d4356"],
  [16, "#3a586f"],
  [30, "#4a7290"],
  [60, "#5f93b0"],
  [110, "#7fbcd4"],
  [200, "#b6e2f2"],
  [320, "#e8f7ff"]
];
function heightColorExpression(ramp = HEIGHT_COLOR_RAMP) {
  const stops = [];
  for (const [h, c] of ramp) stops.push(h, c);
  return ["interpolate", ["linear"], ["coalesce", ["get", "h3d"], 8], ...stops];
}
var ROOF_MIN_H = 15;
var ROOF_INSET = 0.85;
var ROOF_THICK_M = 1.3;
var ANTENNA_MIN_H = 60;
var ANTENNA_M = 12;
function shade(hex, k) {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, "0");
  return `#${ch(n >> 16 & 255)}${ch(n >> 8 & 255)}${ch(n & 255)}`;
}
function rampColorOf(h, ramp = HEIGHT_COLOR_RAMP) {
  let c = ramp[0][1];
  for (const [stop, col] of ramp) if (h >= stop) c = col;
  return c;
}
function buildingColor(h, seed, ramp = HEIGHT_COLOR_RAMP) {
  const k = 0.9 + hash32(seed || "x") % 21 / 100;
  return shade(rampColorOf(h, ramp), k);
}
function outerRing(geom) {
  const g = geom;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = g.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}
function insetRing(ring, k) {
  const n = ring.length - 1;
  if (n < 3) return ring;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i][0];
    cy += ring[i][1];
  }
  cx /= n;
  cy /= n;
  const out = ring.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
  out[out.length - 1] = out[0].slice();
  return out;
}
function ringSpan(ring) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    const x = p[0];
    const y = p[1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
function antennaRing(ring) {
  const n = ring.length - 1;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i][0];
    cy += ring[i][1];
  }
  cx /= n;
  cy /= n;
  const { w, h } = ringSpan(ring);
  const r = Math.max(25e-6, Math.min(w, h) * 0.06);
  return [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx - r, cy - r]
  ];
}
function partFeature(src, ring, base, top, part, color, extra = {}) {
  return {
    type: "Feature",
    id: `${String(src.id || "")}#${part}${extra.tier ? "-t" + String(extra.tier) : ""}${extra.idx !== void 0 ? "-" + String(extra.idx) : ""}`,
    properties: { ...src.properties || {}, part, h3d: top, h_base: base, color3d: color, ...extra },
    geometry: { type: "Polygon", coordinates: [ring] }
  };
}
function buildingParts(f, ramp = HEIGHT_COLOR_RAMP, opts = {}) {
  return buildingPartSet(f, ramp, opts).parts;
}
function buildingPartSet(f, ramp = HEIGHT_COLOR_RAMP, opts = {}) {
  const props = f.properties || {};
  const { h, from } = renderHeight(props);
  const seed = String(props.osm_id || f.id || "");
  const color = buildingColor(h, seed, ramp);
  const base = Number(props.min_height) || 0;
  const info = { skipped: false, skipWhy: "", podium: false, tiers: 1, equipWanted: 0, equipPlaced: 0, equipSkipped: 0 };
  const body = {
    type: "Feature",
    id: `${String(f.id || "")}#body`,
    properties: {
      ...props,
      part: "body",
      h3d: h,
      h_from: from,
      h_base: base,
      color3d: color
    },
    geometry: f.geometry
  };
  const ring = outerRing(f.geometry);
  if (!ring) return { parts: [body], info };
  if (opts.low) return { parts: [body], info };
  const detail = (opts.mode ?? "base") === "detail";
  if (!detail) {
    const parts2 = [body];
    if (h >= ROOF_MIN_H) {
      parts2.push(partFeature(f, insetRing(ring, ROOF_INSET), h, h + ROOF_THICK_M, "roof", shade(color, 0.62)));
    }
    if (h >= ANTENNA_MIN_H) {
      parts2.push(partFeature(f, antennaRing(ring), h, h + ANTENNA_M, "antenna", shade(color, 1.25)));
    }
    return { parts: parts2, info };
  }
  const plan = buildingMasses(ring, h, base, opts);
  info.skipped = plan.skipped;
  info.skipWhy = plan.why;
  info.podium = plan.podium;
  info.tiers = plan.tiers;
  const parts = plan.masses.map((mass) => {
    const wall = mass.top >= base + WIN_MIN_H && !plan.skipped;
    return partFeature(f, mass.ring, mass.base, mass.top, mass.part, massColor(mass, color), {
      shape: plan.skipped ? "sliver" : "mass",
      tier: mass.tier,
      /* 窗格层与色彩层**互补**（同一 source 两层：一层 pattern、一层 color，两者互斥）。
         用 JS 里算好的 0/1 标记，而不是在图层的 filter 里拼表达式 —— 表达式报错是静默的。 */
      win: wall ? 1 : 0
    });
  });
  const topH = base + h;
  const topRing = plan.masses[plan.masses.length - 1].ring;
  if (!plan.skipped && h >= PARAPET_MIN_H) {
    const fm = footprintMetrics(topRing);
    const t = Math.max(0.2, Math.min(PARAPET_THICK_M, fm.minSideM * 0.18));
    parts.push(partFeature(f, ringBand(topRing, insetRingMeters(topRing, t)), topH, topH + PARAPET_H, "parapet", shade(color, 1.08), { wallThickM: +t.toFixed(2), win: 0 }));
    const eq = equipBoxes(topRing, seed, topH);
    info.equipWanted = eq.wanted;
    info.equipPlaced = eq.boxes.length;
    info.equipSkipped = eq.skipped;
    for (let i = 0; i < eq.boxes.length; i++) {
      const b = eq.boxes[i];
      parts.push(partFeature(f, b.ring, b.base, b.top, "equip", shade(color, 0.72), { side: b.side, idx: i, win: 0 }));
    }
  }
  if (!plan.skipped && h >= ANTENNA_MIN_H) {
    parts.push(partFeature(f, antennaRing(topRing), topH, topH + ANTENNA_M, "antenna", shade(color, 1.25), { win: 0 }));
  }
  return { parts, info };
}
var PODIUM_MIN_AREA_M2 = 800;
var PODIUM_MIN_H = 24;
var PODIUM_INSET = 0.8;
var PODIUM_H_RATIO = 0.3;
var PODIUM_H_MIN = 8;
var PODIUM_H_MAX = 21;
var TOWER_MIN_H = 10;
var SETBACK_MIN_H = 60;
var SETBACK_INSET = 0.1;
var SETBACK_TIERS_3_H = 120;
var PARAPET_MIN_H = ROOF_MIN_H;
var PARAPET_H = 0.6;
var PARAPET_THICK_M = 0.7;
var EQUIP_MIN_AREA_M2 = 60;
var EQUIP_SIDE_MIN = 1.5;
var EQUIP_SIDE_STEPS = 6;
var EQUIP_SIDE_STEP_M = 0.5;
var SLIVER_AREA_M2 = 20;
var SLIVER_ASPECT = 6;
var WIN_MIN_H = 40;
var WIN_PATTERN_SIZE = 32;
var M_PER_DEG_LAT2 = 110540;
var M_PER_DEG_LNG = 111320;
function ringCentroid(ring) {
  const n = Math.max(1, ring.length - 1);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i][0];
    cy += ring[i][1];
  }
  return [cx / n, cy / n];
}
function footprintMetrics(ring) {
  const n = ring.length - 1;
  if (n < 3) return { areaM2: 0, aspect: Infinity, minSideM: 0, meanRadiusM: 0 };
  const c = ringCentroid(ring);
  const lat0 = ring[0][1];
  const kx = M_PER_DEG_LNG * Math.cos(lat0 * Math.PI / 180);
  const ky = M_PER_DEG_LAT2;
  let area = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let rSum = 0;
  for (let i = 0; i < n; i++) {
    const px = (ring[i][0] - c[0]) * kx;
    const py = (ring[i][1] - c[1]) * ky;
    const qx = (ring[(i + 1) % n][0] - c[0]) * kx;
    const qy = (ring[(i + 1) % n][1] - c[1]) * ky;
    area += px * qy - qx * py;
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
    rSum += Math.hypot(px, py);
  }
  const w = x1 - x0;
  const hgt = y1 - y0;
  const minSideM = Math.min(w, hgt);
  return {
    areaM2: Math.abs(area) / 2,
    aspect: minSideM > 0.01 ? Math.max(w, hgt) / minSideM : Infinity,
    minSideM,
    meanRadiusM: rSum / n
  };
}
function pointInRing(x, y, ring) {
  const n = ring.length >= 4 ? ring.length - 1 : ring.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insetRingMeters(ring, meters) {
  const n = ring.length - 1;
  if (n < 3 || !(meters > 0)) return ring;
  const c = ringCentroid(ring);
  const lat0 = ring[0][1];
  const kx = M_PER_DEG_LNG * Math.cos(lat0 * Math.PI / 180);
  const ky = M_PER_DEG_LAT2;
  const out = ring.map((p) => {
    const dx = (p[0] - c[0]) * kx;
    const dy = (p[1] - c[1]) * ky;
    const d = Math.hypot(dx, dy);
    if (!(d > 1e-6)) return [p[0], p[1]];
    const k = Math.max(0.08, 1 - meters / d);
    return [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  });
  out[out.length - 1] = out[0].slice();
  return out;
}
function ringBand(outer, inner) {
  const o = outer.slice(0, Math.max(0, outer.length - 1));
  const i = inner.slice(0, Math.max(0, inner.length - 1));
  if (o.length < 3 || i.length !== o.length) return outer;
  const ring = o.concat(i.slice().reverse());
  ring.push(ring[0].slice());
  return ring;
}
function buildingMasses(ring, h, base = 0, opts = {}) {
  const single = { masses: [{ part: "body", ring, base, top: base + h, tier: 1 }], skipped: false, podium: false, tiers: 1, why: "" };
  const detail = (opts.mode ?? "base") === "detail" && !opts.low;
  if (!detail) return single;
  const m = footprintMetrics(ring);
  if (m.areaM2 < SLIVER_AREA_M2 || m.aspect > SLIVER_ASPECT) {
    return {
      ...single,
      skipped: true,
      why: `脚印 ${m.areaM2.toFixed(1)}m² / 长宽比 ${Number.isFinite(m.aspect) ? m.aspect.toFixed(1) : "∞"}`
    };
  }
  const top = base + h;
  const masses = [];
  let curRing = ring;
  let curBase = base;
  let podium = false;
  if (m.areaM2 >= PODIUM_MIN_AREA_M2 && h >= PODIUM_MIN_H) {
    let pH = Math.round(Math.min(PODIUM_H_MAX, Math.max(PODIUM_H_MIN, h * PODIUM_H_RATIO)) * 2) / 2;
    if (pH > h - TOWER_MIN_H) pH = Math.max(2, Math.round((h - TOWER_MIN_H) * 2) / 2);
    masses.push({ part: "podium", ring, base, top: base + pH, tier: 1 });
    curRing = insetRing(ring, PODIUM_INSET);
    curBase = base + pH;
    podium = true;
  }
  const tiers = h >= SETBACK_TIERS_3_H ? 3 : h >= SETBACK_MIN_H ? 2 : 1;
  const slice = (top - curBase) / tiers;
  for (let k = 0; k < tiers; k++) {
    const prev = masses[masses.length - 1];
    const ringK = k === 0 ? curRing : insetRing(prev ? prev.ring : curRing, 1 - SETBACK_INSET);
    masses.push({
      part: k === 0 ? podium ? "tower" : "body" : "setback",
      ring: ringK,
      base: curBase + slice * k,
      top: k === tiers - 1 ? top : curBase + slice * (k + 1),
      // 最后一段封顶 = base+h（不靠浮点累加）
      tier: k + 1
    });
  }
  return { masses, skipped: false, podium, tiers, why: "" };
}
function equipBoxes(ring, seed, roofTop) {
  const m = footprintMetrics(ring);
  if (m.areaM2 < EQUIP_MIN_AREA_M2) return { boxes: [], wanted: 0, skipped: 0 };
  const wanted = m.areaM2 < 400 ? 1 : m.areaM2 < 1500 ? 2 : 3;
  const inner = insetRingMeters(ring, Math.min(PARAPET_THICK_M + 0.6, Math.max(0.5, m.minSideM * 0.12)));
  const c = ringCentroid(inner);
  const im = footprintMetrics(inner);
  const kx = M_PER_DEG_LNG * Math.cos(c[1] * Math.PI / 180);
  const ky = M_PER_DEG_LAT2;
  const boxes = [];
  let skipped = 0;
  for (let i = 0; i < wanted; i++) {
    let placed = false;
    for (let cand = 0; cand < 4 && !placed; cand++) {
      const s = hash32(`${seed}#eq${i}:${cand}`);
      const ang = s % 360 * Math.PI / 180;
      const frac = 0.15 + (s >>> 9) % 40 / 100;
      const side = EQUIP_SIDE_MIN + (s >>> 17) % EQUIP_SIDE_STEPS * EQUIP_SIDE_STEP_M;
      const rot = (s >>> 23) % 90 * Math.PI / 180;
      const r = im.meanRadiusM * frac;
      const cx = c[0] + Math.cos(ang) * r / kx;
      const cy = c[1] + Math.sin(ang) * r / ky;
      const half = side / 2;
      const corners = [];
      const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const sg of signs) {
        const dx = sg[0] * half * Math.cos(rot) - sg[1] * half * Math.sin(rot);
        const dy = sg[0] * half * Math.sin(rot) + sg[1] * half * Math.cos(rot);
        corners.push([cx + dx / kx, cy + dy / ky]);
      }
      if (!corners.every((p) => pointInRing(p[0], p[1], inner))) continue;
      corners.push(corners[0].slice());
      boxes.push({ ring: corners, base: roofTop, top: roofTop + Math.max(1, Math.min(3, side * 0.75)), side });
      placed = true;
    }
    if (!placed) skipped++;
  }
  return { boxes, wanted, skipped };
}
function massColor(mass, baseColor) {
  if (mass.part === "podium") return shade(baseColor, 0.94);
  if (mass.part === "body") return shade(baseColor, 0.97);
  return baseColor;
}
function fmtCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "数不出来";
  if (n === 0) return "0（已量）";
  return String(n);
}
function shapeCountsLine(c) {
  if (!c) return "形体细节：数不出来（没拿到统计）";
  if (c.low) return "形体细节：低档已关（裙楼/退台/女儿墙/设备箱都不生成）";
  if (c.mode !== "detail") return "形体细节：未开（bld=1 基准版：只有主体/压顶/天线）";
  const eqSkip = Number(c.equipSkipped);
  const eqExtra = Number.isFinite(eqSkip) && eqSkip > 0 ? `（另 ${eqSkip} 个放不下）` : "";
  const skipWhy = c.skipped ? `（如 ${String(c.skippedWhy || "未记录原因").slice(0, 40)}）` : "";
  return `形体细节：裙楼 ${fmtCount(c.podium)} · 塔楼 ${fmtCount(c.tower)} · 退台 ${fmtCount(c.setback)} · 女儿墙 ${fmtCount(c.parapet)} · 设备箱 ${fmtCount(c.equip)}${eqExtra} · 跳过纸片楼 ${fmtCount(c.skipped)}${skipWhy} · 要素 ${fmtCount(c.parts)}`;
}
function shapeCountRows(c) {
  if (!c) return [{ k: "统计", v: "数不出来", why: "没拿到 decorateBuildings 的计数" }];
  if (c.low) {
    return [
      { k: "档位", v: "低档（perfLow / ?low=1）", why: "只画主体 + 描边" },
      { k: "细节", v: "已关", why: "裙楼/退台/女儿墙/设备箱/窗格都不生成（保帧率）" }
    ];
  }
  if (c.mode !== "detail") {
    return [
      { k: "档位", v: "基准版（bld=1）", why: "只有主体/压顶/天线 —— 想看新形体请加 ?bld=2" },
      { k: "楼栋", v: fmtCount(c.n), why: "这一屏取到的楼栋数（不是要素数）" },
      { k: "要素", v: fmtCount(c.parts), why: "真正画出去的要素数" }
    ];
  }
  return [
    { k: "档位", v: "普通（detail）", why: "裙楼/塔楼 + 退台 + 女儿墙 + 设备箱 + 天线" },
    { k: "楼栋", v: fmtCount(c.n), why: "这一屏取到的楼栋数（不是要素数）" },
    { k: "裙楼", v: fmtCount(c.podium), why: `脚印 ≥${PODIUM_MIN_AREA_M2}m² 且 h ≥${PODIUM_MIN_H}m 才切` },
    { k: "塔楼", v: fmtCount(c.tower), why: `塔楼相对裙楼内缩 ${Math.round((1 - PODIUM_INSET) * 100)}%` },
    { k: "退台", v: fmtCount(c.setback), why: `h ≥${SETBACK_MIN_H}m 分 2 段 / ≥${SETBACK_TIERS_3_H}m 分 3 段，每段内缩 ${Math.round(SETBACK_INSET * 100)}%` },
    { k: "女儿墙", v: fmtCount(c.parapet), why: `h ≥${PARAPET_MIN_H}m 的楼，屋顶一圈 ${PARAPET_H}m 薄墙` },
    { k: "设备箱", v: fmtCount(c.equip), why: `按楼顶面积 1~3 个；另有 ${fmtCount(c.equipSkipped)} 个放不下` },
    { k: "天线", v: fmtCount(c.antenna), why: `h ≥${ANTENNA_MIN_H}m` },
    { k: "跳过纸片楼", v: fmtCount(c.skipped), why: `脚印 <${SLIVER_AREA_M2}m² 或长宽比 >${SLIVER_ASPECT}（跳过细节，只留主体）${c.skippedWhy ? "；如 " + c.skippedWhy : ""}` },
    { k: "要素", v: fmtCount(c.parts), why: "画出去的要素总数（含主体/裙楼/塔楼/退台/女儿墙/设备箱/天线）" }
  ];
}
function hexRgb(hex) {
  let s = String(hex || "").trim().replace("#", "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function windowPatternSpec(wall, pane, size = WIN_PATTERN_SIZE, cols = 4, rows = 4) {
  const w = hexRgb(wall);
  const p = hexRgb(pane);
  const sill = hexRgb(shade(pane, 0.8));
  const data = new Array(size * size * 4);
  const put = (x, y, c) => {
    const i = (y * size + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, w);
  const cw = Math.floor(size / cols);
  const ch = Math.floor(size / rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cw + 1;
      const y0 = cy * ch + 1;
      for (let y = y0; y < y0 + Math.max(1, ch - 3); y++) {
        for (let x = x0; x < x0 + Math.max(1, cw - 2); x++) put(x, y, p);
      }
      for (let x = x0; x < x0 + Math.max(1, cw - 2); x++) put(x, Math.min(size - 1, y0 + Math.max(1, ch - 3)), sill);
    }
  }
  return { size, wall, pane, cols, rows, data };
}
export {
  ANTENNA_M,
  ANTENNA_MIN_H,
  BUILDING_LAYER_ID,
  CAMERA_DEFAULTS,
  EQUIP_MIN_AREA_M2,
  EQUIP_SIDE_MIN,
  EQUIP_SIDE_STEPS,
  EQUIP_SIDE_STEP_M,
  FALLBACK_HEIGHT_M,
  HEIGHT_COLOR_RAMP,
  KIND_HEIGHT_M,
  KIND_JITTER,
  LOD_FAR_ZOOM,
  LOD_NEAR_ZOOM,
  LOD_VIEW_TILE_CAP,
  MAX_RENDER_H,
  PAN_MAX_SPEED,
  PARAPET_H,
  PARAPET_MIN_H,
  PARAPET_THICK_M,
  PITCH_SOFT,
  PODIUM_H_MAX,
  PODIUM_H_MIN,
  PODIUM_H_RATIO,
  PODIUM_INSET,
  PODIUM_MIN_AREA_M2,
  PODIUM_MIN_H,
  PRERENDER_ATTRIBUTION,
  PRERENDER_LAYER_ID,
  PRERENDER_MANIFEST_PATH,
  PRERENDER_SOURCE_ID,
  PRERENDER_TILE_MAXZOOM,
  PRERENDER_TILE_PATH,
  PRERENDER_TILE_SIZE,
  ROAD_LAYER_PREFIXES,
  ROAD_PALETTE_DARK,
  ROAD_RANK_STYLE,
  ROAD_STYLE_FALLBACK,
  ROOF_INSET,
  ROOF_MIN_H,
  ROOF_THICK_M,
  SCENE_LAYER_ORDER,
  SETBACK_INSET,
  SETBACK_MIN_H,
  SETBACK_TIERS_3_H,
  SLIVER_AREA_M2,
  SLIVER_ASPECT,
  TF_CAPS,
  TF_LAYER_IDS,
  TF_LAYER_ID_LIST,
  TF_LAYER_STYLE,
  TF_LOW_TIER_KINDS,
  TF_RULES,
  TOWER_MIN_H,
  UNKNOWN_KIND_BAND_M,
  WHEEL_ZOOM_RATE,
  WIN_MIN_H,
  WIN_PATTERN_SIZE,
  WS_SCENE_SOURCE,
  applyPitchGuard,
  art3Summary,
  buildSkyGeometry,
  buildTransport,
  buildingColor,
  buildingMasses,
  buildingPartSet,
  buildingParts,
  cameraDefaults,
  contrastRatio,
  contrastReport,
  decorateBuildings,
  equipBoxes,
  fmtCount,
  footprintMetrics,
  hash32,
  heightColorExpression,
  hexRgb,
  horizonYOf,
  insetRing,
  insetRingMeters,
  junctions,
  layerOrderHud,
  lodEventTileKey,
  lodHudLine,
  lodLayerSpec,
  lodLiveVerdict,
  lodNum,
  lodOpacityAt,
  lodOpacityExpression,
  lodPlan,
  lodSourceSpec,
  lodTierLabel,
  lodTierOf,
  lodTileKey,
  lodTileVerdict,
  lodTileX,
  lodTileY,
  lodViewTiles,
  nearestOnLine,
  panDamping,
  pitchGuardParams,
  planEnsureRoadOrder,
  pointInRing,
  rampColorOf,
  relLuminance,
  renderHeight,
  ringAreaM2,
  ringBand,
  ringCentroid,
  roadCountHud,
  roadCountVerdict,
  roadLayerSpecs,
  roadLayersOf,
  roadStatsLine,
  roadStyleOf,
  sceneGroupOf,
  sceneLayerPlan,
  sceneOrderViolations,
  sceneSelfReport,
  shade,
  shapeCountRows,
  shapeCountsLine,
  toLngLat,
  toMeters,
  transportHudLine,
  visibleRoadCount,
  windowPatternSpec
};
