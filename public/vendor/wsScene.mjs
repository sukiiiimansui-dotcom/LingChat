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
export {
  BUILDING_LAYER_ID,
  ROAD_LAYER_PREFIXES,
  ROAD_PALETTE_DARK,
  ROAD_RANK_STYLE,
  ROAD_STYLE_FALLBACK,
  TF_CAPS,
  TF_LAYER_IDS,
  TF_LAYER_ID_LIST,
  TF_LAYER_STYLE,
  TF_LOW_TIER_KINDS,
  TF_RULES,
  art3Summary,
  buildSkyGeometry,
  buildTransport,
  contrastRatio,
  contrastReport,
  horizonYOf,
  junctions,
  layerOrderHud,
  nearestOnLine,
  planEnsureRoadOrder,
  relLuminance,
  ringAreaM2,
  roadCountHud,
  roadCountVerdict,
  roadLayerSpecs,
  roadLayersOf,
  roadStatsLine,
  roadStyleOf,
  toLngLat,
  toMeters,
  transportHudLine,
  visibleRoadCount
};
