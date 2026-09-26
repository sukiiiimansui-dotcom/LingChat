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
  const R3 = roads.map((r) => ({ cls: typeof r.cls === "number" ? r.cls : 3, name: r.name || "", pts: r.pts.map((p) => toMeters(p, O)) })).filter((r) => r.pts.length >= 2);
  const B = buildings.map((b) => ({ kind: String(b.kind || "").toLowerCase(), name: b.name || "", ring: b.ring.map((p) => toMeters(p, O)) })).filter((b) => b.ring.length >= 3);
  const J = junctions(
    R3.map((r) => ({ pts: r.pts, cls: r.cls, name: r.name })),
    18
  );
  const features = [];
  const push = (f) => {
    features.push(f);
  };
  if (!low || true) {
    const busRoads = R3.filter((r) => r.cls <= TF_RULES.bus.maxCls);
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
      for (const r of R3) {
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
      for (const r of R3) {
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
var PRERENDER_DEMO_TILE_PATH = "/prerender-demo/{z}/{x}/{y}.png";
var PRERENDER_DEMO_MANIFEST_PATH = "/prerender-demo/manifest.json";
var PRERENDER_TILE_SIZE = 512;
var PRERENDER_TILE_MAXZOOM = 13;
var LOD_FAR_ZOOM = 10;
var LOD_NEAR_ZOOM = 11;
var PRERENDER_ATTRIBUTION = "预渲染瓦片（自产）· 数据署名见清单 manifest.attribution";
var PRERENDER_DEMO_ATTRIBUTION = "预渲染瓦片（示意/占位，非真实楼·路数据）";
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
var LOD_OPACITY_ZERO_ZOOM = 11;
var LOD_OPACITY_STOPS = [
  /* 🔴 2026-09-26 机主决定：**预渲染瓦片层（那些"白蓝方片"）不再作为主力**，
     楼改由**矢量层一直显示**（`WS_BLD_VECTOR_MINZOOM` 同步降到 11）。
     ⇒ 瓦片只服务 z<11 的远景，**在 11 严格归零**（与矢量层起点仍然严格对齐，
     自检那条"归零 zoom === 楼房矢量 minzoom"的不变量**继续成立**，没有"两层都不管"的空档）。 */
  [8, 1],
  [9, 1],
  [10, 1],
  [LOD_OPACITY_ZERO_ZOOM, 0]
];
function lodOpacityAt(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : LOD_OPACITY_STOPS[LOD_OPACITY_STOPS.length - 1][0];
  const st = LOD_OPACITY_STOPS;
  if (z <= st[0][0]) return st[0][1];
  for (let i = 1; i < st.length; i++) {
    if (z <= st[i][0]) {
      const [z0, o0] = st[i - 1], [z1, o1] = st[i];
      if (z1 === z0) return o1;
      return +(o0 + (o1 - o0) * (z - z0) / (z1 - z0)).toFixed(4);
    }
  }
  return st[st.length - 1][1];
}
function lodOpacityExpression() {
  const flat = [];
  for (const [z, o] of LOD_OPACITY_STOPS) flat.push(z, o);
  return ["interpolate", ["linear"], ["zoom"], ...flat];
}
function prerenderSourceOf(src = "real") {
  if (src === "demo") {
    return {
      src: "demo",
      tilePath: PRERENDER_DEMO_TILE_PATH,
      manifestPath: PRERENDER_DEMO_MANIFEST_PATH,
      attribution: PRERENDER_DEMO_ATTRIBUTION,
      kind: "placeholder"
    };
  }
  return {
    src: "real",
    tilePath: PRERENDER_TILE_PATH,
    manifestPath: PRERENDER_MANIFEST_PATH,
    attribution: PRERENDER_ATTRIBUTION,
    kind: "real"
  };
}
function lodSourceSpec(src = "real") {
  const s = prerenderSourceOf(src);
  return {
    type: "raster",
    tiles: [s.tilePath],
    tileSize: PRERENDER_TILE_SIZE,
    maxzoom: PRERENDER_TILE_MAXZOOM,
    attribution: s.attribution
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
function lodPlan(src = "real") {
  const entry = SCENE_LAYER_ORDER.find((e) => e.group === "prerender");
  const s = prerenderSourceOf(src);
  return {
    group: "prerender",
    layerId: PRERENDER_LAYER_ID,
    sourceId: PRERENDER_SOURCE_ID,
    beforeId: entry ? entry.beforeId : null,
    src: s.src,
    srcKind: s.kind,
    tilePath: s.tilePath,
    manifestPath: s.manifestPath,
    tileSize: PRERENDER_TILE_SIZE,
    tileMaxzoom: PRERENDER_TILE_MAXZOOM,
    layerMaxzoom: LOD_NEAR_ZOOM,
    far: LOD_FAR_ZOOM,
    near: LOD_NEAR_ZOOM,
    source: lodSourceSpec(src),
    layer: lodLayerSpec()
  };
}
var WS_FETCH_R_MIN = 2e3;
var WS_FETCH_R_MAX = 8e3;
var WS_FETCH_R_BACKEND_MAX = 2e3;
var WS_FETCH_R_SOURCE_MAX = 2e3;
var WS_ROADS_R_MAX = 600;
var WS_ROADS_CHUNKING_VERDICT = "分块实测不划算：冷块 17.6~56.2s、4 块里 1 块 ok:false；只有缓存命中那块 0.13s（视野一平移就换冷格子） ⇒ 不做分块，live 层一个 600m 圆，远处的路靠预渲染瓦片";
var WS_ROADS_LIMIT_WHY = "后端实测：取路 r≥800m 会跑 79~100s 后返回空（800→0/99s、1200→0/79s、2000→0/94s；600 才有 197 条）⇒ 单次封顶 600m，远处的路看预渲染瓦片";
function roadsRadiusFor(buildingsRadius) {
  const want = Number.isFinite(buildingsRadius) ? Math.max(0, Number(buildingsRadius)) : WS_ROADS_R_MAX;
  const capped = want > WS_ROADS_R_MAX;
  return { radius: WS_ROADS_R_MAX, wanted: capped ? want : WS_ROADS_R_MAX, capped, why: capped ? WS_ROADS_LIMIT_WHY : null };
}
var WS_ROADS_LIVE_DEFAULT = false;
var WS_ROADS_LIVE_VERDICT = "默认不发 /api/roads：现场 Overpass 冷查是分钟级（分块实测 17.6~56.2s/块、4 块 1 失败），600m 只有**缓存命中**才 0.1~1s ⇒ 默认 0 条，路走离线路面包 + 预渲染瓦片；要现场取数加 ?live=1";
function roadsLiveDecision(input) {
  if (input && input.forceLive === true) {
    return { live: true, why: "URL 显式 ?live=1 ⇒ 现场取数（明知冷查可能撞 12s 超时，失败会如实报出来）" };
  }
  return { live: false, why: WS_ROADS_LIVE_VERDICT };
}
var WS_BLD_LIVE_DEFAULT = false;
var WS_BLD_LIVE_VERDICT = "默认不发 /api/buildings：现场一次只有 R≤2000m（后端硬闸）且冷查 27~33s（最慢 91.7s） ⇒ 默认 0 条，楼走离线楼房包（实测 373 格 / 720,087 栋 / 102.6MB，单格中位 205KB）；要现场取数加 ?live=1";
function bldLiveDecision(input) {
  if (input && input.forceLive === true) {
    return { live: true, why: "URL 显式 ?live=1 ⇒ 现场取数（R≤2000m、冷查可能几十秒，失败会如实报出来）" };
  }
  return { live: false, why: WS_BLD_LIVE_VERDICT };
}
function bldVerdictText(input) {
  const n = input.n === null || input.n === void 0 ? "数不出来" : String(input.n);
  if (input.state === "off") return "🏢 未开（?bld=0）";
  if (input.state === "sizemismatch") {
    const pkg = input.pkgCell === null || input.pkgCell === void 0 ? "?" : input.pkgCell + "°";
    const fe = input.feCell === null || input.feCell === void 0 ? "?" : input.feCell + "°";
    return `🏢 ❌ **格尺寸口径不符**（包 ${pkg} / 前端 ${fe}）⇒ 拒绝取数 —— **不是「包外」、不是「取数失败」、更不是「这里没有楼」**（修包或改前端常量后重试）`;
  }
  if (input.state === "pending") return "🏢 离线格取数中…";
  if (input.state === "failed") return `🏢 取数**失败**：${input.err || "原因未知"} —— 不是「这一带没有楼」`;
  if (input.state === "outside") {
    return "🏢 **包外**（这一带没有离线楼房格；默认不发 /api/buildings ⇒ 要现场取数加 ?live=1） —— 这是「我们没这个包」，**不是**「这里没有楼」";
  }
  const cells = input.cells === null || input.cells === void 0 ? "数不出来" : String(input.cells);
  const cap = input.cap ? `，上限 ${input.cap}` : "";
  return `🏢 离线包 offline-first（仓库 ${n} 栋${cap}；已取 ${cells} 格；**默认不发 /api/buildings** ⇒ 要现场取数加 ?live=1）`;
}
function roadsVerdictText(input) {
  const r = input.radius === null || input.radius === void 0 ? "?" : String(Math.round(input.radius));
  const cap = input.capped ? `（半径已封顶；本想要 ${Math.round(Number(input.wanted) || 0)}m —— ${input.why || ""}）` : "";
  if (input.state === "off") return "🛣 未开（?roads=0）";
  if (input.state === "bundle") {
    const nb = input.n === null || input.n === void 0 ? "数不出来" : String(input.n);
    return `🛣 离线包 offline-first（仓库 ${nb} 条；**默认不发 /api/roads**：冷查分钟级 ⇒ 要现场取数加 ?live=1）`;
  }
  if (input.state === "pending") return `🛣 取数中…（r=${r}m${cap}）`;
  if (input.state === "failed") return `🛣 取数**失败**：${input.err || "原因未知"}（r=${r}m${cap}）—— 不是「这一带没有路」`;
  const n = input.n === null || input.n === void 0 ? "数不出来" : input.n === 0 ? "0（已量：后端返回 0 条）" : String(input.n);
  const ch = input.cached === true ? " · 缓存命中" : input.cached === false ? " · 实时取数" : "";
  const secs = Number.isFinite(input.ms) ? ` · ${(Number(input.ms) / 1e3).toFixed(1)}s` : "";
  return `🛣 ${n} 条（r=${r}m${cap}${ch}${secs}）`;
}
function pixelRatioForTier(perfTier, dpr) {
  const d = Number.isFinite(dpr) ? Number(dpr) : 1;
  const base = Math.min(2, Math.max(1, d));
  return String(perfTier) === "low" ? Math.min(1.5, base) : base;
}
var WS_FETCH_R_LIMIT_WHY = "Overpass 公共实例实测：R=2000 起常 504、R=8000 会静默截断 ⇒ 远景改用预渲染瓦片";
function wsFetchRadiusMax() {
  return Math.min(WS_FETCH_R_MAX, WS_FETCH_R_SOURCE_MAX, WS_FETCH_R_BACKEND_MAX);
}
var WS_FETCH_R_LADDER = [
  [15, 2e3],
  [14, 3e3],
  [13, 4e3],
  [12, 6e3],
  [11, 8e3]
];
function fetchRadiusRound(r) {
  return Math.round(r / 50) * 50;
}
function viewHalfMetersOf(bounds, lat) {
  if (!bounds) return null;
  const w = Number(bounds.west), s = Number(bounds.south), e = Number(bounds.east), n = Number(bounds.north);
  if (![w, s, e, n, lat].every((v) => Number.isFinite(v))) return null;
  const mx = Math.abs(e - w) / 2 * 111320 * Math.cos(lat * Math.PI / 180);
  const my = Math.abs(n - s) / 2 * 110540;
  return Math.round(Math.hypot(mx, my));
}
function fetchRadiusForZoom(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : 15;
  for (const [z0, r] of WS_FETCH_R_LADDER) if (z >= z0) return r;
  return WS_FETCH_R_LADDER[WS_FETCH_R_LADDER.length - 1][1];
}
function fetchRadiusForView(zoom, viewHalfMeters) {
  const zoomRadius = fetchRadiusForZoom(zoom);
  const viewRadius = Number.isFinite(viewHalfMeters) ? fetchRadiusRound(Number(viewHalfMeters)) : null;
  const hardMax = wsFetchRadiusMax();
  const want = Math.max(zoomRadius, viewRadius === null ? 0 : viewRadius);
  const radius = Math.min(hardMax, Math.max(WS_FETCH_R_MIN, want));
  const decidedBy = want > hardMax ? "cap" : viewRadius !== null && viewRadius > zoomRadius ? "view" : "zoom";
  return { radius, decidedBy, zoomRadius, viewRadius, want, limitWhy: want > hardMax ? WS_FETCH_R_LIMIT_WHY : null };
}
function fetchRadiusLadder(zoom, viewHalfMeters) {
  const hardMax = wsFetchRadiusMax();
  const r0 = fetchRadiusForView(zoom, viewHalfMeters).radius;
  const out = [r0];
  while (out[out.length - 1] < hardMax) {
    const next = Math.min(hardMax, fetchRadiusRound(out[out.length - 1] * 2));
    if (next === out[out.length - 1]) break;
    out.push(next);
  }
  return out;
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
    real: null,
    placeholder: null,
    unknownKind: null,
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
  const raw = input.inventory === null || input.inventory === void 0 ? null : input.inventory;
  const inv = raw === null ? null : raw instanceof Set ? raw : Array.isArray(raw) ? new Set(raw) : new Set(Object.keys(raw));
  const kindOf = (k) => {
    if (raw === null || raw instanceof Set || Array.isArray(raw)) return "unknown";
    return lodTileKindOf(raw[k]);
  };
  const view = input.view;
  if (!view) {
    return { state: "unknown", ...empty, why: "数不出来：拿不到视野/zoom（地图还没就绪）" };
  }
  const keys = view.keys;
  const inInv = inv === null ? null : keys.filter((k) => inv.has(k)).length;
  const absent = inInv === null ? null : keys.length - inInv;
  const real = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "real").length;
  const placeholder = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "placeholder").length;
  const unknownKind = inv === null ? null : keys.filter((k) => inv.has(k) && kindOf(k) === "unknown").length;
  const st = input.states || null;
  const hit = st ? st.loaded : input.loaded === null ? null : input.loaded.length;
  const hitGauge = st ? "cache" : input.loaded === null ? "unknown" : "events";
  const fail = st ? st.errored : input.failed === null ? null : input.failed.length;
  const failGauge = st ? "cache" : input.failed === null ? "unknown" : "events";
  const why = [];
  if (inv === null) why.push("清单没取到 ⇒ 「本区应有/清单缺」数不出来");
  if (unknownKind !== null && unknownKind > 0) why.push(`视野里有 ${unknownKind} 张清单记录**没标种类**（老清单）⇒ 真/占位分不出来`);
  if (hit === null) why.push("拿不到瓦片状态、事件里也没有 tile 坐标 ⇒ 命中数不出来");
  if (absent !== null && absent > 0) why.push(`视野里有 ${absent} 张**清单里没有** ⇒ 它们必然取不到（这是确定性证据，不依赖事件）`);
  if (view.capped) why.push(`视野瓦片数超过上限 ${LOD_VIEW_TILE_CAP} ⇒ 只数了一部分（不能说"共 N 张"）`);
  if (keys.length === 0) why.push("视野里一张都算不出来（边界异常？）");
  const state = absent !== null && absent > 0 ? "missing" : hit === null || inv === null || keys.length === 0 ? "unknown" : "ok";
  return {
    state,
    real,
    placeholder,
    unknownKind,
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
function lodTileKindOf(entry) {
  if (entry === null || entry === void 0) return "unknown";
  if (typeof entry === "number") return "placeholder";
  const k = entry.kind;
  return k === "real" || k === "placeholder" ? k : "unknown";
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
var LOD_LIVE_LAYER_PREFIXES = ["bld-", "road-casing-", "road-line-", "road-glow-"];
var LOD_LIVE_SOURCE_IDS = ["bld", "roads"];
function lodLiveLayerIds(layerIds) {
  return (layerIds || []).filter((id) => LOD_LIVE_LAYER_PREFIXES.some((p) => String(id).startsWith(p)));
}
function lodTileStatesOf(map, sourceId = PRERENDER_SOURCE_ID) {
  try {
    const tm = map && map.style && map.style.tileManagers ? map.style.tileManagers[sourceId] : null;
    const cache = tm && tm._inViewTiles;
    if (!cache || typeof cache.getTileByID !== "function") return null;
    const ids = typeof cache.getAllIds === "function" ? cache.getAllIds() : typeof cache.getRenderableIds === "function" ? cache.getRenderableIds() : null;
    if (!ids) return null;
    const out = { loaded: 0, errored: 0, loading: 0, total: 0 };
    for (const id of ids) {
      const t = cache.getTileByID(id);
      const s = t && t.state;
      out.total++;
      if (s === "loaded") out.loaded++;
      else if (s === "errored") out.errored++;
      else if (s === "loading" || s === "reloading") out.loading++;
    }
    return out;
  } catch {
    return null;
  }
}
function lodLiveVerdictOf(map) {
  if (!map || typeof map.getStyle !== "function") return null;
  let layers = [];
  try {
    const st = map.getStyle();
    layers = lodLiveLayerIds((st && st.layers || []).map((l) => String(l && l.id || "")));
  } catch {
    layers = [];
  }
  let rendered = null;
  let source = null;
  let tilesLoaded = null;
  try {
    if (layers.length && typeof map.queryRenderedFeatures === "function") {
      const r = map.queryRenderedFeatures({ layers });
      rendered = Array.isArray(r) ? r.length : null;
    }
  } catch {
    rendered = null;
  }
  try {
    if ((rendered === null || rendered === 0) && typeof map.querySourceFeatures === "function") {
      let n = 0;
      let anyOk = false;
      for (const sid of LOD_LIVE_SOURCE_IDS) {
        try {
          const f = map.querySourceFeatures(sid);
          if (Array.isArray(f)) {
            n += f.length;
            anyOk = true;
          }
        } catch {
        }
      }
      source = anyOk ? n : null;
    }
  } catch {
    source = null;
  }
  try {
    if (typeof map.areTilesLoaded === "function") tilesLoaded = !!map.areTilesLoaded();
  } catch {
    tilesLoaded = null;
  }
  return lodLiveVerdict({ layerCount: layers.length, rendered, source, tilesLoaded });
}
function lodHudLine(input) {
  if (!input.enabled) return "🛰 LOD 未启用（URL 加 `?lod=1`；当前未建预渲染层）";
  const t = lodTierOf(input.zoom);
  const v = input.tiles;
  const tileTxt = `瓦片 命中 ${lodNum(v.hit)}（口径=${v.hitGauge}） · 失败 ${lodNum(v.fail)}（口径=${v.failGauge}） · 本区 **真 ${lodNum(v.real)} / 占位 ${lodNum(v.placeholder)} / 缺 ${lodNum(v.absent, "0（已量）")}**` + (v.unknownKind ? `（另有 ${v.unknownKind} 张未标种类）` : "") + ` · 应有 ${lodNum(v.view)}` + (v.capped ? " ⚠️被上限截断" : "");
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

// src/components/views/worldsim/wsMapTheme.ts
function rampExpression(theme) {
  const stops = [];
  for (const [h, c] of theme.ramp) stops.push(h, c);
  return ["interpolate", ["linear"], ["coalesce", ["get", "h3d"], 8], ...stops];
}
function themeForTier(theme, low) {
  if (!low) return { sky: theme.sky, outlineWidth: theme.outline.width, tint: theme.tint };
  return {
    sky: theme.low.dropSky ? null : theme.sky,
    outlineWidth: theme.low.outlineWidth,
    tint: theme.low.dropTint ? null : theme.tint
  };
}
function themeStyleParts(theme, low = false, transitionMs = 0) {
  const tier = themeForTier(theme, low);
  const sources = {
    base: { type: "raster", ...theme.sources.base, tileSize: 256, crossOrigin: "anonymous" },
    ref: { type: "raster", ...theme.sources.ref, tileSize: 256, crossOrigin: "anonymous" }
  };
  const layers = [
    {
      id: "bg",
      type: "background",
      paint: {
        "background-color": theme.bg,
        ...transitionMs > 0 ? { "background-color-transition": { duration: transitionMs, delay: 0 } } : {}
      }
    },
    {
      id: "base",
      type: "raster",
      source: "base",
      /* 🔴 高 zoom 淡出（治「地面太糊」）：二次元的亮灰底图最高只到 z16，
         小区级放大到 17~18 就是"把 z16 放大 4 倍" ⇒ 必糊。
         淡出后露出 `bg` + `tint` 合成出来的纯色地面（和"有瓦片时"只差 0.002 亮度）
         + 我们自己的路网 + 楼体 ⇒ 全是矢量，任何缩放都锐利。
         ⚠️ `baseFade` 只覆盖 `raster-opacity` 这一个字段，**不动**主题里写的
            saturation/contrast/brightness（那些在淡出区间里照样按 zoom 生效）。 */
      paint: theme.baseFade ? {
        ...theme.raster.base,
        "raster-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          theme.baseFade.from,
          1,
          theme.baseFade.to,
          0
        ]
      } : theme.raster.base
    }
  ];
  if (theme.sources.hi && theme.raster.hi) {
    sources.hi = { type: "raster", ...theme.sources.hi, tileSize: 256, crossOrigin: "anonymous" };
    layers.push({ id: "hi", type: "raster", source: "hi", minzoom: 14.5, paint: theme.raster.hi });
  }
  if (tier.tint) {
    layers.push({
      id: "tint",
      type: "background",
      paint: {
        "background-color": tier.tint.color,
        "background-opacity": tier.tint.opacity,
        ...transitionMs > 0 ? {
          "background-color-transition": { duration: transitionMs, delay: 0 },
          "background-opacity-transition": { duration: transitionMs, delay: 0 }
        } : {}
      }
    });
  }
  layers.push({ id: "ref", type: "raster", source: "ref", paint: theme.raster.ref });
  return { sky: tier.sky || void 0, sources, layers };
}

// src/components/views/worldsim/wsBuildingPick.ts
var WS_BLD_VIEW_CAP = 100;
function bboxArea(f) {
  const g = f.geometry;
  if (!g || !g.coordinates) return 0;
  const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const ring of rings) {
    for (const pt of ring || []) {
      const x = Number(pt?.[0]), y = Number(pt?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      n += 1;
    }
  }
  if (!n) return 0;
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}
function hasName(f) {
  const p = f.properties || {};
  const nm = p.name ?? p["name:zh"] ?? p.n ?? p.ref;
  return typeof nm === "string" ? nm.trim().length > 0 : nm != null && String(nm).trim().length > 0;
}
function firstPoint(f) {
  const g = f.geometry;
  if (!g || !g.coordinates) return null;
  const c = g.type === "Polygon" ? g.coordinates[0]?.[0] : g.type === "MultiPolygon" ? (g.coordinates[0] || [])[0]?.[0] : void 0;
  const x = Number(c?.[0]), y = Number(c?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
var DERIVED = /* @__PURE__ */ new WeakMap();
function derivedOf(f, size) {
  if (!f || typeof f !== "object") return { pt: null, area: 0, named: 0, key: "", ckSize: -1, ck: "" };
  let d = DERIVED.get(f);
  if (!d) {
    d = { pt: firstPoint(f), area: bboxArea(f), named: hasName(f) ? 1 : 0, key: String(f.id ?? ""), ckSize: -1, ck: "" };
    DERIVED.set(f, d);
  }
  if (size > 0 && d.pt && d.ckSize !== size) {
    const w = Math.floor(d.pt[0] / size) * size;
    const s = Math.floor(d.pt[1] / size) * size;
    d.ck = `${w.toFixed(5)}_${s.toFixed(5)}_${size}`;
    d.ckSize = size;
  }
  return d;
}
function pickBuildingsForView(feats, input) {
  const cap = Math.max(0, Math.floor(input.cap ?? WS_BLD_VIEW_CAP));
  const nb = Math.max(1, Math.min(32, Math.floor(input.buckets ?? 8)));
  const considered = feats.length;
  const b = input.bounds;
  const hasBounds = !!(b && [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].every((v) => Number.isFinite(v)));
  const west = hasBounds ? b.getWest() : 0;
  const south = hasBounds ? b.getSouth() : 0;
  const east = hasBounds ? b.getEast() : 0;
  const north = hasBounds ? b.getNorth() : 0;
  const spanX = east - west;
  const spanY = north - south;
  const items = [];
  let inView = 0;
  let noPoint = 0;
  for (const f of feats) {
    const dv = derivedOf(f, 0);
    const pt = dv.pt;
    let bucket = -1;
    if (hasBounds && !pt) {
      noPoint += 1;
      continue;
    }
    if (hasBounds && pt) {
      const inside = pt[0] >= west && pt[0] <= east && pt[1] >= south && pt[1] <= north;
      if (!inside) continue;
      inView += 1;
      const bx = spanX > 0 ? Math.min(nb - 1, Math.max(0, Math.floor((pt[0] - west) / spanX * nb))) : 0;
      const by = spanY > 0 ? Math.min(nb - 1, Math.max(0, Math.floor((pt[1] - south) / spanY * nb))) : 0;
      bucket = by * nb + bx;
    } else {
      bucket = 0;
    }
    items.push({
      f,
      bucket,
      named: dv.named,
      area: dv.area,
      key: dv.key
      // ← 记忆过的 id 字符串（不再每次 String()）
    });
  }
  const byBucket = /* @__PURE__ */ new Map();
  for (const it of items) {
    const arr = byBucket.get(it.bucket);
    if (arr) arr.push(it);
    else byBucket.set(it.bucket, [it]);
  }
  for (const arr of byBucket.values()) {
    arr.sort((a, z) => z.named - a.named || z.area - a.area || (a.key < z.key ? -1 : a.key > z.key ? 1 : 0));
  }
  const buckets = [...byBucket.keys()].sort((a, z) => a - z);
  const chosen = [];
  const perBucket = hasBounds ? new Array(nb * nb).fill(0) : [];
  for (let round = 0; chosen.length < cap; round++) {
    let tookAny = false;
    const order = buckets.slice().sort((b1, b2) => {
      const x = byBucket.get(b1), y = byBucket.get(b2);
      if (round >= x.length) return round >= y.length ? b1 - b2 : 1;
      if (round >= y.length) return -1;
      const a1 = x[round], a2 = y[round];
      return a2.named - a1.named || a2.area - a1.area || b1 - b2;
    });
    for (const bk of order) {
      const arr = byBucket.get(bk);
      if (round >= arr.length) continue;
      if (chosen.length >= cap) break;
      chosen.push(arr[round].f);
      if (hasBounds && perBucket[bk] !== void 0) perBucket[bk] += 1;
      tookAny = true;
    }
    if (!tookAny) break;
  }
  const stats = {
    considered,
    inView: hasBounds ? inView : null,
    noPoint,
    chosen: chosen.length,
    cap,
    buckets: nb,
    byBucket: hasBounds ? perBucket : null,
    why: `显示 ${chosen.length} / ${hasBounds ? "视野内 " + inView : "视野内 **数不出来**（没有 bounds）"} 栋（仓库 ${considered} · 上限 ${cap} · ${nb}×${nb} 分桶轮转：有名字优先、底面大的优先` + (noPoint ? ` · **定位不到点 ${noPoint} 栋未画**` : "") + `）`
  };
  return { features: chosen, stats };
}
var WS_BLD_CELL_CAP = 100;
var WS_BLD_CELL_DEG = 0.02;
function capBuildingsPerCell(feats, input = {}) {
  const size = Number.isFinite(input.cellDeg) && input.cellDeg > 0 ? input.cellDeg : WS_BLD_CELL_DEG;
  const cap = Math.max(0, Math.floor(input.cap ?? WS_BLD_CELL_CAP));
  const rawMin = Number(input.minInView ?? 0);
  const minInView = Number.isFinite(rawMin) ? Math.max(0, Math.floor(rawMin)) : 0;
  const b = input.bounds ?? null;
  const hasBounds = !!(b && typeof b.getWest === "function" && typeof b.getSouth === "function" && typeof b.getEast === "function" && typeof b.getNorth === "function" && [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].every((v) => Number.isFinite(v)));
  const byCell = /* @__PURE__ */ new Map();
  let noPoint = 0;
  for (const f of feats) {
    const dv = derivedOf(f, size);
    const pt = dv.pt;
    if (!pt) {
      noPoint++;
      continue;
    }
    const cell = dv.ck;
    const it = { f, named: dv.named, area: dv.area, key: dv.key, pt };
    const arr = byCell.get(cell);
    if (arr) arr.push(it);
    else byCell.set(cell, [it]);
  }
  const base = [];
  const wantFloor = hasBounds && minInView > 0;
  const leftovers = [];
  const rows = [];
  let dropped = 0;
  for (const cell of [...byCell.keys()].sort()) {
    const arr = byCell.get(cell);
    arr.sort((a, z) => z.named - a.named || z.area - a.area || (a.key < z.key ? -1 : a.key > z.key ? 1 : 0));
    const take = arr.slice(0, cap);
    for (const x of take) base.push(x);
    if (wantFloor) leftovers.push(arr.slice(cap));
    rows.push({ cell, drawn: take.length, dropped: arr.length - take.length });
    dropped += arr.length - take.length;
  }
  let inView = null;
  let floorAdded = 0;
  let floorShort = null;
  const added = [];
  if (hasBounds) {
    const west = b.getWest(), south = b.getSouth(), east = b.getEast(), north = b.getNorth();
    const inside = (pt) => pt[0] >= west && pt[0] <= east && pt[1] >= south && pt[1] <= north;
    inView = 0;
    for (const x of base) if (inside(x.pt)) inView += 1;
    let need = Math.max(0, minInView - inView);
    if (wantFloor) {
      for (const arr of leftovers) {
        if (need <= 0) break;
        for (const x of arr) {
          if (!inside(x.pt)) continue;
          added.push(x.f);
          floorAdded += 1;
          need -= 1;
          if (need <= 0) break;
        }
      }
    }
    floorShort = need;
  }
  const baseFeats = base.map((x) => x.f);
  const out = floorAdded > 0 ? baseFeats.concat(added) : baseFeats;
  const viewSeg = hasBounds ? ` · 视野内 ${inView}（下限 ${minInView} · 补 +${floorAdded} / 仍差 ${floorShort}）` : minInView > 0 ? ` · 视野内 **数不出来**（没给 bounds ⇒ 补不了，一栋没补）` : "";
  return {
    features: out,
    stats: {
      considered: feats.length,
      cells: byCell.size,
      cap,
      cellDeg: size,
      byCell: rows,
      chosen: out.length,
      baseChosen: baseFeats.length,
      dropped,
      noPoint,
      inView,
      minInView,
      floorAdded,
      floorShort,
      why: `每块 ≤${cap} 栋 · ${byCell.size} 块 / 画 ${out.length} 栋` + (floorAdded > 0 ? `（冻结 ${baseFeats.length} + 视野补 ${floorAdded}）` : "") + `（输入 ${feats.length} · 块内超出 ${dropped}` + (noPoint ? ` · 定位不到 ${noPoint}` : "") + `）· 区块 ${size}° ≈ ${(size * 111).toFixed(1)}km` + viewSeg
    }
  };
}

// src/components/views/worldsim/wsDistrictScene.ts
function districtStyleOf(theme, low, fadeMs) {
  const parts = themeStyleParts(theme, low, fadeMs);
  return {
    version: 8,
    name: `ws-district-${theme.id}`,
    /* `sky` 可能没有（低端档会关掉它）—— 用展开而不是写 `sky: undefined`，
       免得给 style 里塞一个值为 undefined 的键（校验器会当它存在）。 */
    ...parts.sky ? { sky: parts.sky } : {},
    sources: parts.sources,
    /* ⚠️ 顺序有意义（自下而上）：bg → base → [hi] → [tint] → ref。
       楼房的图层由 `addLayer(l, "ref")` 插到 **ref 之前** ⇒ 自动落在线罩**之上**。
       `ref` 必须留在最后一条：它是楼房层的插入锚点。 */
    layers: parts.layers
  };
}
var WS_BLD_VECTOR_MINZOOM = 11;
var WS_BLD_OUTLINE_FULL_ZOOM = 15;
function bldLayerSpecsFor(theme, tier) {
  const th = theme;
  const common = {
    /* 主题/时间切换要**平滑**而不是「啪」一下：本构建的 paint 属性带 `transition: true`（spec 实测），
       写上 `*-transition` 就由 MapLibre 自己做时长插值 —— **别自己写 rAF 插值动画**（那是重复劳动且更贵）。
       三层（bld-ext / bld-roof / bld-antenna）共用这个对象 ⇒ 改一处覆盖三层。
       900ms 是手感取值：太短像瞬变、太长像卡住。 */
    "fill-extrusion-color-transition": { duration: 900, delay: 0 },
    "fill-extrusion-opacity-transition": { duration: 900, delay: 0 },
    "fill-extrusion-height": ["coalesce", ["get", "h3d"], 8],
    /* 底座统一读 `h_base`（拆件时每条都写了；老数据没有就退回 `min_height`） */
    "fill-extrusion-base": ["coalesce", ["get", "h_base"], ["get", "min_height"], 0],
    /* 远景褪色（#8）：远处楼淡一点，近处实（曲线由主题给，见 `wsMapTheme.extrudOpacity`） */
    "fill-extrusion-opacity": th.extrudOpacity,
    /* 竖向渐变：楼顶比楼底亮一点 —— **写实**要它（墙面有明暗、体块才"立"得起来）；
       **二次元要关掉它**（平涂/cell-shading：楼是一块纯色板，有渐变就不"动画"了）。
       MapLibre 默认就是 true，但我们**显式写死**：默认值会随版本改，而这一条直接决定观感。 */
    "fill-extrusion-vertical-gradient": th.verticalGradient
  };
  const showOutline = tier.outlineWidth !== null;
  return [
    {
      id: "bld-ext",
      type: "fill-extrusion",
      source: "bld",
      /* 性能（机主 2026-09-19：「能玩」优先）：
         `fill-extrusion` 的开销**随要素数线性增长**（见 MapLibre 官方性能指南 /
         Bavaria 矢量瓦片 3D 经验），而整区视野下楼只有亚像素 ⇒ 这一档**整层不画**。
         取楼本来也要 zoom ≥ 13.5，两层阈值对齐（12.8 留一点余量，免得来回抖）。 */
      minzoom: WS_BLD_VECTOR_MINZOOM,
      /* 只画主体 —— 屋顶/天线是另外两条层（拆件后同一个源里有三种 `part`） */
      filter: ["==", ["get", "part"], "body"],
      paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], rampExpression(th)] }
    },
    {
      /* 屋顶压顶：同一轮廓内缩 + 更深色 ⇒ 楼顶多一圈"女儿墙"的层次（#4）
         ⚠️ 只在 `h3d ≥ 15m` 的楼上生成（`wsBuildingLook.ROOF_MIN_H`）——
         矮平房压顶只会显脏，还白翻一倍要素数。 */
      id: "bld-roof",
      type: "fill-extrusion",
      source: "bld",
      minzoom: 14.5,
      // 远景看不出这一层，不白画
      filter: ["==", ["get", "part"], "roof"],
      paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], th.roofFallback] }
    },
    {
      /* 天线：>60m 的楼顶一根细挤出（#6）—— 城市轮廓里最抓眼的一档，要素数极少 */
      id: "bld-antenna",
      type: "fill-extrusion",
      source: "bld",
      minzoom: 14.5,
      filter: ["==", ["get", "part"], "antenna"],
      paint: { ...common, "fill-extrusion-color": ["coalesce", ["get", "color3d"], th.antennaFallback] }
    },
    ...showOutline ? [
      {
        id: "bld-line",
        type: "line",
        source: "bld",
        minzoom: WS_BLD_VECTOR_MINZOOM,
        // 与 bld-ext 同档（轮廓线也是按要素数算的，别在整区视野白画）
        /* 只描主体的边：屋顶/天线也描的话，楼顶会糊成一团线（它们本来就是靠色差读的） */
        filter: ["==", ["get", "part"], "body"],
        /* 二次元这层是"动画感"的主要来源（平涂 + 深藏青细线）；
           暗色这层只是淡淡一圈，低端档直接不建。 */
        /* 🖊 **描边宽度随 zoom 长起来**（2026-09-25 机主「黑色一坨」的真因）：
           12.8~15 之间从 0 平滑到正常宽 —— 小比例下每栋 1~3px，深色描边会把填充整个盖住，
           整片楼就变成"黑点地毯"；到 15+ 楼够大了，描边才恢复它该有的"动画感"分隔作用。 */
        paint: {
          "line-color": th.outline.color,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            WS_BLD_VECTOR_MINZOOM,
            0,
            WS_BLD_OUTLINE_FULL_ZOOM,
            tier.outlineWidth ?? th.outline.width
          ]
        }
      }
    ] : []
  ];
}
var planConsumed = false;
function scenePlanConsumed() {
  return planConsumed;
}
function resetScenePlanConsumed() {
  planConsumed = false;
}
function planBeforeOf(m, group) {
  try {
    const e = sceneLayerPlan().find((x) => x.group === group);
    if (!e) return void 0;
    planConsumed = true;
    return e.beforeId && m.getLayer(e.beforeId) ? e.beforeId : void 0;
  } catch {
    return void 0;
  }
}
function applyBuildingsTo(m, data, specs) {
  if (m.getSource("bld")) {
    m.getSource("bld").setData(data);
    return;
  }
  m.addSource("bld", { type: "geojson", data });
  const before = planBeforeOf(m, "buildings") ?? (m.getLayer("ref") ? "ref" : void 0);
  for (const l of specs) m.addLayer(l, before);
}
function flushBldStore(opts, why = "flush") {
  let drawn = opts.features();
  if (opts.pickNearView) {
    const r = pickBuildingsForView(drawn, opts.pickNearView);
    drawn = r.features;
    try {
      opts.onPicked?.(r.stats);
    } catch {
    }
  }
  const data = opts.dress(drawn);
  opts.beforeDraw?.(why, data);
  const m = opts.map();
  if (!m) {
    opts.onNoMap?.(data);
    return;
  }
  applyBuildingsTo(m, data, opts.specs());
  opts.afterDraw?.(why, data);
}
function flushRoadsStore(opts, why = "flush") {
  const data = { type: "FeatureCollection", features: opts.features() };
  opts.beforeDraw?.(why, data);
  const m = opts.map();
  if (!m) return;
  if (m.getLayer("road-line-0")) {
    m.getSource("roads")?.setData(data);
  } else {
    m.addSource("roads", { type: "geojson", data });
    const before = m.getLayer("bld-ext") ? "bld-ext" : m.getLayer("ref") ? "ref" : void 0;
    for (const l of opts.specs()) if (!m.getLayer(l.id)) m.addLayer(l, before);
  }
  opts.afterDraw?.(why, data);
}

// src/components/views/worldsim/wsFeatureStore.ts
function metersBetween(a, b) {
  const kx = 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
  const ky = 110540;
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
}
function createFeatureStore(opts) {
  const cap = Math.max(1, Math.floor(opts.cap));
  const byId = /* @__PURE__ */ new Map();
  let noIdList = [];
  let added = 0, dupes = 0, dropped = 0, merges = 0, lastMergeMs = null;
  const sources = /* @__PURE__ */ new Set();
  let sourcesDropped = 0;
  const srcOf = /* @__PURE__ */ new WeakMap();
  function all() {
    return noIdList.length ? [...byId.values(), ...noIdList] : [...byId.values()];
  }
  return {
    merge(features, sourceKey) {
      const t0 = Date.now();
      let a = 0, d = 0, nid = 0;
      for (const f of features) {
        const id = opts.idOf(f);
        if (!id) {
          noIdList.push(f);
          nid++;
          a++;
          if (sourceKey && f && typeof f === "object") srcOf.set(f, sourceKey);
          continue;
        }
        if (byId.has(id)) {
          dupes++;
          d++;
          continue;
        }
        byId.set(id, f);
        a++;
        if (sourceKey && f && typeof f === "object") srcOf.set(f, sourceKey);
      }
      added += a;
      merges++;
      if (sourceKey) sources.add(sourceKey);
      lastMergeMs = Date.now() - t0;
      return { added: a, dupes: d, noId: nid, total: byId.size + noIdList.length, ms: lastMergeMs };
    },
    retainNear(center, keepRadiusM) {
      const droppedSourcesBefore = sourcesDropped;
      let droppedFar = 0, droppedOverCap = 0;
      const keep = [];
      const far = [];
      for (const f of all()) {
        const pt = opts.pointOf(f);
        if (!pt) {
          keep.push([0, f]);
          continue;
        }
        const dist2 = metersBetween(pt, center);
        (dist2 <= keepRadiusM ? keep : far).push([dist2, f]);
      }
      droppedFar = far.length;
      let over = [];
      if (keep.length > cap) {
        const sorted = [...keep].sort((x, y) => x[0] - y[0]);
        over = sorted.slice(cap);
        keep.length = 0;
        keep.push(...sorted.slice(0, cap));
        droppedOverCap = over.length;
      }
      if (droppedFar + droppedOverCap > 0) {
        const alive = /* @__PURE__ */ new Set();
        for (const [, f] of keep) {
          if (f && typeof f === "object") {
            const k = srcOf.get(f);
            if (k) alive.add(k);
          }
        }
        for (const k of [...sources]) {
          if (alive.has(k)) continue;
          sources.delete(k);
          sourcesDropped += 1;
        }
      }
      const keepSet = new Set(keep.map(([, f]) => f));
      const nextById = /* @__PURE__ */ new Map();
      const nextNoId = [];
      for (const [id, f] of byId) if (keepSet.has(f)) nextById.set(id, f);
      for (const f of noIdList) if (keepSet.has(f)) nextNoId.push(f);
      byId.clear();
      for (const [id, f] of nextById) byId.set(id, f);
      noIdList = nextNoId;
      dropped += droppedFar + droppedOverCap;
      const droppedSourcesNow = droppedSourcesBefore === sourcesDropped ? 0 : sourcesDropped - droppedSourcesBefore;
      return { droppedFar, droppedOverCap, n: byId.size + noIdList.length, droppedSources: droppedSourcesNow };
    },
    features: all,
    has: (k) => sources.has(k),
    stats() {
      return {
        n: byId.size + noIdList.length,
        noId: noIdList.length,
        added,
        dupes,
        dropped,
        merges,
        sources: sources.size,
        sourcesDropped,
        lastMergeMs,
        cap
      };
    },
    /* ⚠️ `clear()` 必须**连来源键一起清**：`has()` 的语义现在是"仓库里确实还有这一格的要素"
       （见 `retainNear` 的 `dirtySources`）—— 只清要素不清来源键，就会又变回"说已经取过、其实没有"。 */
    clear() {
      byId.clear();
      noIdList = [];
      sources.clear();
    }
  };
}
var ROADS_BUNDLE_CELL_DEG = 0.05;
var BLD_BUNDLE_CELL_DEG = 0.05;
var PLACES_BUNDLE_CELL_DEG = 0.05;
function bundleCellOf(lng, lat, size) {
  const w = Math.floor(lng / size) * size;
  const s = Math.floor(lat / size) * size;
  return { w: +w.toFixed(5), s: +s.toFixed(5) };
}
function bundleCellKey(w, s, size) {
  return `${w.toFixed(5)}_${s.toFixed(5)}_${size}`;
}
function roadsBundleCellOf(lng, lat, size = ROADS_BUNDLE_CELL_DEG) {
  return bundleCellOf(lng, lat, size);
}
function roadsBundleCellKey(w, s, size = ROADS_BUNDLE_CELL_DEG) {
  return bundleCellKey(w, s, size);
}
function bldBundleCellOf(lng, lat, size = BLD_BUNDLE_CELL_DEG) {
  return bundleCellOf(lng, lat, size);
}
function bldBundleCellKey(w, s, size = BLD_BUNDLE_CELL_DEG) {
  return bundleCellKey(w, s, size);
}
function bundleCellsForView(bounds, center, maxCells, size) {
  if (!bounds || !center) return null;
  const w0 = bounds.getWest(), e0 = bounds.getEast(), s0 = bounds.getSouth(), n0 = bounds.getNorth();
  if (![w0, e0, s0, n0, center.lng, center.lat].every((v) => Number.isFinite(v))) return null;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const i0 = Math.floor(w0 / size), i1 = Math.floor(e0 / size);
  const j0 = Math.floor(s0 / size), j1 = Math.floor(n0 / size);
  const steps = i1 - i0 + 1, stepn = j1 - j0 + 1;
  if (steps * stepn > 4096) return null;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < stepn; j++) {
      const w = +((i0 + i) * size).toFixed(5), s = +((j0 + j) * size).toFixed(5);
      const key = bundleCellKey(w, s, size);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, w, s, d: metersBetween([w + size / 2, s + size / 2], [center.lng, center.lat]) });
    }
  }
  out.sort((a, b) => a.d - b.d);
  const capped = out.length > maxCells;
  return { cells: out.slice(0, maxCells).map(({ key, w, s }) => ({ key, w, s })), wanted: out.length, capped };
}
function roadsBundleCellsForView(bounds, center, maxCells = 6, size = ROADS_BUNDLE_CELL_DEG) {
  return bundleCellsForView(bounds, center, maxCells, size);
}
function placesBundleCellsForView(bounds, center, maxCells = 6, size = PLACES_BUNDLE_CELL_DEG) {
  return bundleCellsForView(bounds, center, maxCells, size);
}
function bldBundleCellsForView(bounds, center, maxCells = 6, size = BLD_BUNDLE_CELL_DEG) {
  return bundleCellsForView(bounds, center, maxCells, size);
}

// src/components/views/worldsim/wsPerfMeter.ts
var PM_SAMPLE_CAP = 2e3;
var PM_LONG_TASK_KEEP = 12;
var PM_LONG_TASK_MS = 50;
var spans = /* @__PURE__ */ new Map();
var marks = [];
var bootT = null;
var context = {};
var ltObserving = false;
var ltSupported = null;
var ltCount = 0;
var ltTotal = 0;
var ltMax = null;
var ltTop = [];
function pmAvailable() {
  return typeof performance !== "undefined" && typeof performance.now === "function";
}
function pmNow() {
  if (pmAvailable()) return performance.now();
  return typeof Date !== "undefined" && Date.now ? Date.now() : 0;
}
function bootOnce() {
  if (bootT === null) bootT = pmNow();
  return bootT;
}
function pmMark(name, extra = null) {
  const b = bootOnce();
  const t = pmNow();
  marks.push({ name: String(name), t, sinceBoot: Math.round((t - b) * 100) / 100, extra: extra || null });
  if (marks.length > 400) marks = marks.slice(-400);
}
function pmSpan(label, ms, bytes, note) {
  const k = String(label);
  const v = Number(ms);
  if (!Number.isFinite(v)) return;
  let b = spans.get(k);
  if (!b) {
    b = { n: 0, total: 0, max: 0, samples: [], bytes: null, note: null };
    spans.set(k, b);
  }
  b.n += 1;
  b.total += v;
  if (v > b.max) b.max = v;
  b.samples.push(v);
  if (b.samples.length > PM_SAMPLE_CAP) b.samples.splice(0, b.samples.length - PM_SAMPLE_CAP);
  if (typeof bytes === "number" && Number.isFinite(bytes)) b.bytes = (b.bytes || 0) + bytes;
  if (note !== void 0 && note !== null) b.note = String(note).slice(0, 200);
}
function pmTime(label, fn, bytesOf) {
  const t0 = pmNow();
  try {
    const r = fn();
    let by = null;
    try {
      const x = bytesOf ? bytesOf(r) : null;
      if (typeof x === "number" && Number.isFinite(x)) by = x;
    } catch {
      by = null;
    }
    pmSpan(label, pmNow() - t0, by);
    return r;
  } catch (e) {
    pmSpan(label, pmNow() - t0, null, "抛错(" + String(e?.message || e).slice(0, 60) + ")");
    throw e;
  }
}
async function pmTimeAsync(label, fn) {
  const t0 = pmNow();
  try {
    const r = await fn();
    pmSpan(label, pmNow() - t0);
    return r;
  } catch (e) {
    pmSpan(label, pmNow() - t0, null, "抛错(" + String(e?.message || e).slice(0, 60) + ")");
    throw e;
  }
}
function pmPercentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const q = Math.min(1, Math.max(0, p));
  const idx = Math.max(0, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[Math.min(sortedAsc.length - 1, idx)];
}
function pmSnapshot() {
  const out = [];
  for (const [label, b] of spans) {
    const s = b.samples.slice().sort((a, z) => a - z);
    out.push({
      label,
      n: b.n,
      total: Math.round(b.total * 100) / 100,
      max: Math.round(b.max * 100) / 100,
      kept: s.length,
      median: s.length ? Math.round(pmPercentile(s, 0.5) * 100) / 100 : null,
      p90: s.length ? Math.round(pmPercentile(s, 0.9) * 100) / 100 : null,
      bytes: b.bytes,
      note: b.note
    });
  }
  out.sort((a, z) => z.total - a.total);
  return {
    available: pmAvailable(),
    now: pmAvailable() ? Math.round(pmNow() * 100) / 100 : null,
    bootT: bootT === null ? null : Math.round(bootT * 100) / 100,
    marks: marks.slice(),
    spans: out,
    longTasks: {
      observing: ltObserving,
      supported: ltSupported,
      count: ltCount,
      total: Math.round(ltTotal * 100) / 100,
      max: ltMax === null ? null : Math.round(ltMax * 100) / 100,
      top: ltTop.slice()
    },
    context: { ...context }
  };
}
function pmReset() {
  spans.clear();
  marks = [];
  bootT = null;
  for (const k of Object.keys(context)) delete context[k];
  ltCount = 0;
  ltTotal = 0;
  ltMax = null;
  ltTop = [];
}
function pmObserveLongTasks() {
  if (ltObserving) return true;
  if (typeof PerformanceObserver === "undefined") {
    ltSupported = false;
    return false;
  }
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const dur = Number(e.duration) || 0;
        const start = Math.round(Number(e.startTime) * 100) / 100;
        ltCount += 1;
        ltTotal += dur;
        if (ltMax === null || dur > ltMax) ltMax = dur;
        ltTop.push({ start, dur: Math.round(dur * 100) / 100, name: String(e.name || "task") });
        ltTop.sort((a, z) => z.dur - a.dur);
        if (ltTop.length > PM_LONG_TASK_KEEP) ltTop = ltTop.slice(0, PM_LONG_TASK_KEEP);
      }
    });
    po.observe({ entryTypes: ["longtask"], buffered: true });
    ltObserving = true;
    ltSupported = true;
    return true;
  } catch {
    ltSupported = false;
    return false;
  }
}
function pmSetContext(k, v) {
  context[String(k)] = v;
}

// src/components/views/worldsim/wsOfflineFeed.ts
function netBytesOf(url) {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null;
    const es = performance.getEntriesByName(url);
    const e = es && es.length ? es[es.length - 1] : null;
    if (!e) return null;
    const n = Number(e.decodedBodySize || e.transferSize || 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
var BUNDLE_TIMEOUT_MS = 6e3;
var BLD_BUNDLE_PER_REFRESH = 2;
var ROADS_BUNDLE_PER_REFRESH = 2;
var BLD_BUNDLE_MAX_CELLS = 6;
var ROADS_BUNDLE_MAX_CELLS = 8;
var PLACES_BUNDLE_PER_REFRESH = 4;
var PLACES_BUNDLE_MAX_CELLS = 6;
var PLACES_STORE_CAP = 3e3;
var BUNDLE_BYTES_PER_ROUND = 1.5 * 1048576;
var BUNDLE_REQ_PER_ROUND_MAX = 16;
var BLD_STORE_CAP = 3e4;
var BLD_STORE_CAP_RECOMMENDED = 3e4;
var BLD_STORE_CAP_MAX = 5e4;
function resolveBldStoreCap(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return BLD_STORE_CAP;
  return Math.max(2e3, Math.min(BLD_STORE_CAP_MAX, Math.floor(n)));
}
var ROADS_STORE_CAP = 6e3;
var GW_BUNDLE_CELL_DEG = 0.05;
var GW_BUNDLE_PER_REFRESH = 6;
var GW_BUNDLE_MAX_CELLS = 6;
var GW_STORE_CAP = 4e3;
function bundleCellUrl(kind, cellKey, dir) {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${dir || dirsOf(spec)[0]}/${cellKey}.json`;
}
function bundleIndexUrl(kind, dir) {
  const spec = SPECS[kind];
  if (!spec) throw new Error("未知的离线包类型：" + String(kind));
  return `/${dir || dirsOf(spec)[0]}/index.json`;
}
function dirsOf(spec) {
  const list = (spec.dirs && spec.dirs.length ? spec.dirs : [spec.dir]).slice();
  try {
    if (typeof location !== "undefined" && location.search) {
      const m = /[?&]bdir=([A-Za-z0-9._-]+)/.exec(location.search);
      if (m && list.indexOf(m[1]) >= 0) return [m[1]].concat(list.filter((d) => d !== m[1]));
    }
  } catch {
  }
  return list;
}
async function fetchWithTimeout(fetchImpl, url, ms = BUNDLE_TIMEOUT_MS) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    return await fetchImpl(url, ctl ? { signal: ctl.signal } : void 0);
  } catch (e) {
    const why = e?.name === "AbortError" ? `超时 ${Math.round(ms / 1e3)}s` : String(e);
    throw new Error(why);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bundleBuildingsOf(json) {
  const arr = json?.bld;
  if (!Array.isArray(arr)) throw new Error("bldbundle 里没有 bld 数组");
  const out = [];
  for (const raw of arr) {
    const b = raw;
    if (!b) continue;
    const id = String(b.i ?? "");
    if (!id) continue;
    const parts = Array.isArray(b.p) ? b.p : [];
    for (let k = 0; k < parts.length; k++) {
      const ring = parts[k];
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const fid = parts.length > 1 ? `${id}#${k}` : id;
      const h = num(b.h);
      const floors = num(b.f);
      const props = {
        osm_id: fid,
        /* 出处如实标：`src` = 来自离线包；`bsrc` = 上游是 Overture（ODbL，署名随数据走） */
        src: "bundle",
        bsrc: "overture",
        kind: b.c === void 0 || b.c === null ? "yes" : String(b.c),
        name: b.n === void 0 || b.n === null ? "" : String(b.n)
      };
      if (h !== null && h > 0) {
        props.height = h;
        props.height_src = "height";
      } else if (floors !== null && floors > 0) {
        props.height = Math.min(500, Math.round(floors * 3 * 10) / 10);
        props.height_src = "levels";
      } else {
        props.height_src = "default";
      }
      if (floors !== null && floors > 0) props.levels = floors;
      out.push({
        type: "Feature",
        id: fid,
        properties: props,
        geometry: { type: "Polygon", coordinates: [ring] }
      });
    }
  }
  return out;
}
function bundleRoadsOf(json) {
  const arr = json?.roads;
  if (!Array.isArray(arr)) throw new Error("roadsbundle 里没有 roads 数组");
  const out = [];
  for (const raw of arr) {
    const x = raw;
    if (!x || !Array.isArray(x.p) || x.p.length < 2) continue;
    const id = String(x.i ?? "");
    if (!id) continue;
    out.push({
      type: "Feature",
      id,
      properties: {
        osm_id: id,
        rank: num(x.r),
        name: x.n === void 0 || x.n === null ? "" : String(x.n),
        src: "bundle",
        bsrc: "osm"
      },
      geometry: { type: "LineString", coordinates: x.p }
    });
  }
  return out;
}
function isRing(v) {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]) && typeof v[0][0] === "number";
}
function closeRing(ring) {
  const first = ring[0], last = ring[ring.length - 1];
  return first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice() : ring.concat([first]);
}
function bundleGwOf(json) {
  const j = json;
  const arr = j?.f;
  if (!Array.isArray(arr)) throw new Error("gwbundle 里没有 f 数组");
  const cs = j?.cellSize;
  if (cs !== void 0 && cs !== null && Math.abs(Number(cs) - GW_BUNDLE_CELL_DEG) > 1e-9) {
    throw new Error(`gwbundle 格尺寸口径不符：包 ${cs}° / 前端 ${GW_BUNDLE_CELL_DEG}°`);
  }
  const cell = typeof j?.key === "string" && j.key ? j.key : "";
  const out = [];
  for (let fi = 0; fi < arr.length; fi++) {
    const raw = arr[fi];
    if (!raw) continue;
    const kind = raw.k === "water" ? "water" : "green";
    const rings = Array.isArray(raw.r) ? raw.r : [];
    const name = raw.n === void 0 || raw.n === null ? null : String(raw.n);
    const props = { name, kind, src: "bundle", bsrc: "osm" };
    const nested = rings.length > 0 && !isRing(rings[0]);
    const groups = nested ? rings : rings.map((r) => [r]);
    for (let gi = 0; gi < groups.length; gi++) {
      const parts = groups[gi].filter((r) => isRing(r) && r.length >= 3);
      if (!parts.length) continue;
      out.push({
        type: "Feature",
        /* 稳定 id 用**包自己的格键** + 位置 ⇒ 同一格重取时能去重（仓库 `merge` 靠它），
           且不同格之间不会撞（撞了就会被当成重复要素丢掉 —— 那是**少画**，属于"把有说成没有"）。 */
        id: cell ? `${cell}#${fi}:${gi}` : `${kind}|${parts[0].length}|${parts[0][0][0]},${parts[0][0][1]}`,
        properties: props,
        geometry: { type: "Polygon", coordinates: parts.map(closeRing) }
      });
    }
  }
  return out;
}
function gwIdOf(f) {
  return f && f.id ? String(f.id) : null;
}
function gwPointOf(f) {
  const ring = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  for (const q of ring) {
    if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) {
      x += q[0];
      y += q[1];
      n++;
    }
  }
  return n ? [x / n, y / n] : null;
}
function bundlePlacesOf(json) {
  const arr = json?.places;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const o = it;
    const name = String(o?.n ?? "").trim();
    if (!name) continue;
    const pt = o?.p;
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    out.push({ n: name, k: String(o?.k ?? ""), p: [Number(pt[0]), Number(pt[1])], i: String(o?.i ?? name) });
  }
  return out;
}
function placesIdOf(f) {
  return String(f?.i || (f?.k ? f.k + ":" + f.n : f?.n) || "") || null;
}
function placesPointOf(f) {
  const p = f?.p;
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
}
function bldIdOf(f) {
  const p = f && f.properties || {};
  const id = p.store_id || p.osm_id || p.id || f && f.id;
  return id ? String(id) : null;
}
var PT_CACHE = /* @__PURE__ */ new WeakMap();
function memoPoint(f, calc) {
  if (!f || typeof f !== "object") return null;
  const k = f;
  if (PT_CACHE.has(k)) return PT_CACHE.get(k) ?? null;
  const v = calc(f);
  PT_CACHE.set(k, v);
  return v;
}
function bldPointOf(f) {
  return memoPoint(f, bldPointOfRaw);
}
function bldPointOfRaw(f) {
  const ring = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  for (const q of ring) {
    if (Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) {
      x += q[0];
      y += q[1];
      n++;
    }
  }
  return n ? [x / n, y / n] : null;
}
function roadsIdOf(f) {
  const p = f && f.properties || {};
  const id = p.osm_id || p.id || f && f.id;
  return id ? String(id) : null;
}
function roadsPointOf(f) {
  return memoPoint(f, roadsPointOfRaw);
}
function roadsPointOfRaw(f) {
  const c = f?.geometry?.coordinates || [];
  const m = c[Math.floor(c.length / 2)];
  return m && Number.isFinite(m[0]) && Number.isFinite(m[1]) ? [m[0], m[1]] : null;
}
var SPECS = {
  bld: {
    dir: "bldbundle",
    /* 📦 **分片包优先**：`bldbundle-002`（细子格，格尺寸以它自己的 `index.cellSize` 为准）在就在前面，
       不在就退回老包 `bldbundle`（0.05°，**唯一被端到端验过的一版**，先别删）。 */
    dirs: ["bldbundle-002", "bldbundle"],
    cellDeg: BLD_BUNDLE_CELL_DEG,
    plan: (b, c, maxCells, size) => bldBundleCellsForView(b, c, maxCells, size),
    parse: bundleBuildingsOf,
    perRefresh: BLD_BUNDLE_PER_REFRESH,
    maxCells: BLD_BUNDLE_MAX_CELLS,
    sourceKey: (k) => `bldbundle:${k}`,
    unit: "栋"
  },
  places: {
    dir: "placesbundle",
    cellDeg: PLACES_BUNDLE_CELL_DEG,
    plan: (b, c, maxCells, size) => placesBundleCellsForView(b, c, maxCells, size),
    parse: bundlePlacesOf,
    perRefresh: PLACES_BUNDLE_PER_REFRESH,
    maxCells: PLACES_BUNDLE_MAX_CELLS,
    sourceKey: (k) => `placesbundle:${k}`,
    unit: "个"
  },
  roads: {
    dir: "roadsbundle",
    cellDeg: ROADS_BUNDLE_CELL_DEG,
    plan: (b, c, maxCells, size) => roadsBundleCellsForView(b, c, maxCells, size),
    parse: bundleRoadsOf,
    perRefresh: ROADS_BUNDLE_PER_REFRESH,
    maxCells: ROADS_BUNDLE_MAX_CELLS,
    sourceKey: (k) => `bundle:${k}`,
    unit: "条"
  },
  /* 🌊🌳 **水/绿地**（第四种包）：目录 `gwbundle`、格边长 `GW_BUNDLE_CELL_DEG`（= 0.05°）、
     计划走**同一个** `bundleCellsForView` —— 也就是说"取哪些格"与楼/路/片区名是同一套格数学，
     差别只有"格边长"这一个参数（口径要漂就一起漂，不会各漂一半）。 */
  gw: {
    dir: "gwbundle",
    cellDeg: GW_BUNDLE_CELL_DEG,
    plan: (b, c, maxCells) => bundleCellsForView(b, c, maxCells, GW_BUNDLE_CELL_DEG),
    parse: bundleGwOf,
    perRefresh: GW_BUNDLE_PER_REFRESH,
    maxCells: GW_BUNDLE_MAX_CELLS,
    sourceKey: (k) => `gwbundle:${k}`,
    unit: "面"
  }
};
function createBundleFeed(opts) {
  const spec = SPECS[opts.kind];
  const have = /* @__PURE__ */ new Set();
  const missing = /* @__PURE__ */ new Set();
  const failed = /* @__PURE__ */ new Set();
  let pending = 0;
  let got = 0;
  let wanted = null;
  let capped = false;
  let asked = false;
  let busy = false;
  let queued = false;
  let refused = false;
  let bytesThisRound = 0;
  let activeDir = null;
  let effCellDeg = null;
  let evictedSources = 0;
  let indexFact = null;
  let indexState = "未读";
  let indexWhy = null;
  let indexPromise = null;
  const coalesceMs = Math.max(0, Math.floor(Number(opts.flushCoalesceMs || 0)));
  let flushTimer = null;
  let pendingFlushWhy = "";
  let coalescedFlushes = 0;
  let flushDone = 0;
  function doFlush(why) {
    const t = pmNow();
    flushDone += 1;
    try {
      opts.flush(why);
    } finally {
      pmSpan(`feed.flush:${spec.dir}`, pmNow() - t, null, why);
    }
  }
  function requestFlush(why) {
    if (coalesceMs <= 0 || flushDone === 0) {
      doFlush(why);
      return;
    }
    pendingFlushWhy = pendingFlushWhy ? pendingFlushWhy + "+" + why : why;
    if (flushTimer) {
      coalescedFlushes += 1;
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const w = pendingFlushWhy;
      pendingFlushWhy = "";
      try {
        doFlush(w);
      } catch {
      }
    }, coalesceMs);
  }
  const cacheCells = Math.max(0, Math.floor(Number(opts.parsedCacheCells || 0)));
  const parsedCache = /* @__PURE__ */ new Map();
  let cacheHits = 0;
  function cacheTake(k) {
    const v = parsedCache.get(k);
    if (!v) return null;
    parsedCache.delete(k);
    parsedCache.set(k, v);
    return v;
  }
  function cachePut(k, v) {
    if (cacheCells <= 0) return;
    parsedCache.delete(k);
    parsedCache.set(k, v);
    while (parsedCache.size > cacheCells) {
      const first = parsedCache.keys().next();
      if (first.done) break;
      parsedCache.delete(first.value);
    }
  }
  function cacheStats() {
    let feats = 0;
    for (const v of parsedCache.values()) feats += v.length;
    return { cells: parsedCache.size, feats, hits: cacheHits, maxCells: cacheCells };
  }
  if (cacheCells > 0) pmSetContext(`feed.parsedCache:${spec.dir}`, cacheCells);
  if (coalesceMs > 0) pmSetContext(`feed.flushCoalesce:${spec.dir}`, coalesceMs);
  function ensureIndex() {
    if (indexPromise) return indexPromise;
    indexState = "读取中";
    const dirs = dirsOf(spec);
    indexPromise = (async () => {
      let last = null;
      let tried = 0;
      for (const d of dirs) {
        tried += 1;
        const f = await pmTimeAsync(`feed.index:${spec.dir}`, () => loadBundleIndex(opts.fetchCell, opts.kind, d));
        last = f;
        if (!f.cells) continue;
        activeDir = d;
        indexFact = f;
        const rawSize = f.cellSize;
        const pkg = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null;
        effCellDeg = pkg === null ? spec.cellDeg : pkg;
        const pin = Number(opts.expectCellDeg);
        if (pkg === null) {
          indexState = "已读";
          indexWhy = "包里没有可用的 cellSize（缺字段 / 坏值）⇒ 按兜底常量 " + spec.cellDeg + "° 算（数不出来就说不出来）";
          return f;
        }
        if (Number.isFinite(pin) && Math.abs(pkg - pin) > 1e-9) {
          indexState = "口径不符";
          refused = true;
          indexWhy = `包（${d}）按 ${pkg}° 分格、但这一趟**钉住**了 ${pin}° ⇒ 格键与索引零交集，拒绝取数（否则会把有数据的格说成「包外」）`;
          opts.onError?.(`${spec.dir}@${d} 格尺寸口径不符：包 ${pkg}° / 钉住 ${pin}° ⇒ 本轮一个格都不取`);
          return f;
        }
        indexState = "已读";
        indexWhy = null;
        return f;
      }
      indexState = "失败";
      indexWhy = `索引没读到（试过 ${tried} 个目录：${dirs.join(" / ")}）⇒ 退回试格子`;
      opts.onError?.(`index ${spec.dir} 没读到（试过 ${tried} 个目录），退回试格子`);
      return last || { kind: opts.kind, url: bundleIndexUrl(opts.kind, dirs[0]), source: null, cellCount: null, cells: null, attribution: null, real: null, cellSize: null, cellBytes: null, cellBld: null };
    })();
    return indexPromise;
  }
  function effectiveDeg() {
    return effCellDeg === null ? spec.cellDeg : effCellDeg;
  }
  function scaleOf() {
    const d = effectiveDeg();
    if (!Number.isFinite(d) || d <= 0) return 1;
    return Math.max(1, Math.pow(BLD_BUNDLE_CELL_DEG / d, 2));
  }
  function maxCellsEff() {
    return Math.min(400, Math.max(spec.maxCells, Math.round(spec.maxCells * scaleOf())));
  }
  function perRefreshEff() {
    return Math.min(BUNDLE_REQ_PER_ROUND_MAX, Math.max(spec.perRefresh, Math.round(spec.perRefresh * scaleOf())));
  }
  function counters() {
    let n = null;
    let cap = null;
    try {
      const st = opts.store.stats();
      n = Number.isFinite(st.n) ? st.n : null;
      cap = Number.isFinite(st.cap) ? st.cap : null;
    } catch {
      n = null;
    }
    return {
      n,
      have: have.size,
      missing: missing.size,
      failed: failed.size,
      pending,
      cap,
      wanted,
      capped,
      got,
      asked,
      refused,
      cellDeg: effectiveDeg(),
      cellDegPin: Number.isFinite(Number(opts.expectCellDeg)) ? Number(opts.expectCellDeg) : null,
      dir: activeDir || dirsOf(spec)[0],
      dirs: dirsOf(spec),
      /* 📐 跟着格尺寸走的三个预算（报告/排查要能回答"为什么一轮取这么多"） */
      budget: { cellDeg: effectiveDeg(), scale: Math.round(scaleOf() * 100) / 100, maxCells: maxCellsEff(), perRefresh: perRefreshEff(), bytesPerRound: Math.round(bytesThisRound) },
      evictedSources,
      cache: cacheStats(),
      coalesce: { ms: coalesceMs, merged: coalescedFlushes },
      index: {
        state: indexState,
        cellSize: indexFact ? indexFact.cellSize : null,
        cells: indexFact && indexFact.cellCount !== null ? indexFact.cellCount : null,
        keys: indexFact && indexFact.cells ? indexFact.cells.size : null,
        why: indexWhy,
        attribution: indexFact && (indexFact.attribution || indexFact.source) || null,
        real: indexFact ? indexFact.real : null
      }
    };
  }
  function planned() {
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, maxCellsEff(), effectiveDeg());
    if (!p) return null;
    return { keys: p.cells.map((c) => c.key), wanted: p.wanted, capped: p.capped };
  }
  async function runOnce(why) {
    const idx = await ensureIndex();
    const v = opts.view();
    const p = spec.plan(v.bounds, v.center, maxCellsEff(), effectiveDeg());
    if (!p) return { planned: false, batch: 0, got: 0, capped: false };
    asked = true;
    wanted = p.wanted;
    capped = p.capped;
    if (refused) return { planned: true, batch: 0, got: 0, capped: p.capped, refused: true };
    const todo = [];
    for (const c of p.cells) {
      if (opts.store.has(spec.sourceKey(c.key))) continue;
      if (missing.has(c.key)) continue;
      if (idx.cells) {
        if (idx.cells.has(c.key)) todo.push(c);
        else missing.add(c.key);
        continue;
      }
      todo.push(c);
    }
    const byteBudget = Number.isFinite(Number(opts.bytesPerRound)) && Number(opts.bytesPerRound) >= 0 ? Number(opts.bytesPerRound) : BUNDLE_BYTES_PER_ROUND;
    const cap0 = todo.slice(0, perRefreshEff());
    const batch = [];
    let bytesPicked = 0;
    for (const c of cap0) {
      const by = idx.cellBytes ? idx.cellBytes.get(c.key) || 0 : 0;
      if (batch.length > 0 && byteBudget > 0 && bytesPicked + by > byteBudget) break;
      batch.push(c);
      bytesPicked += by;
    }
    bytesThisRound = bytesPicked;
    if (!batch.length) return { planned: true, batch: 0, got: 0, capped: p.capped };
    pending += batch.length;
    let n = 0;
    for (const cell of batch) {
      const url = bundleCellUrl(opts.kind, cell.key, activeDir || dirsOf(spec)[0]);
      const t0 = pmNow();
      try {
        const hit = cacheTake(cell.key);
        if (hit) {
          opts.store.merge(hit, spec.sourceKey(cell.key));
          cacheHits += 1;
          have.add(cell.key);
          got += hit.length;
          n += hit.length;
          pmSpan(`feed.cacheHit:${spec.dir}`, pmNow() - t0, null, `${hit.length} 个要素`);
          continue;
        }
        const r = await opts.fetchCell(url, BUNDLE_TIMEOUT_MS);
        const tNet = pmNow();
        if (r.status === 404) {
          missing.add(cell.key);
          pmSpan(`feed.net:${spec.dir}`, tNet - t0, null, "404 包外");
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const by = netBytesOf(url);
        pmSpan(`feed.net:${spec.dir}`, tNet - t0, by);
        const j = await r.json();
        const tJson = pmNow();
        pmSpan(`feed.json:${spec.dir}`, tJson - tNet, by);
        const feats = spec.parse(j);
        const tParse = pmNow();
        pmSpan(`feed.parse:${spec.dir}`, tParse - tJson, by);
        opts.store.merge(feats, spec.sourceKey(cell.key));
        pmSpan(`feed.merge:${spec.dir}`, pmNow() - tParse, by);
        cachePut(cell.key, feats);
        if (have.size === 0) pmMark(`feed.firstCell:${spec.dir}`, { cell: cell.key, bytes: by, n: feats.length });
        have.add(cell.key);
        got += feats.length;
        n += feats.length;
      } catch (e) {
        failed.add(cell.key);
        const why0 = String(e?.message || e || "取数失败").slice(0, 60);
        pmSpan(`feed.net:${spec.dir}`, pmNow() - t0, null, "失败:" + why0);
        opts.onError?.(`${spec.dir} ${cell.key} ${why0}`);
      } finally {
        pending -= 1;
      }
    }
    try {
      const c = opts.view().center;
      if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
        const ev = opts.store.retainNear([c.lng, c.lat], opts.retainRadiusM());
        const ds = ev?.droppedSources;
        if (ds) evictedSources += Number(ds) || 0;
      }
    } catch {
    }
    requestFlush(`${why}+${batch.length}`);
    return { planned: true, batch: batch.length, got: n, capped: p.capped };
  }
  return {
    async refresh(why = "view") {
      if (busy) {
        queued = true;
        return { planned: false, batch: 0, got: 0, capped };
      }
      busy = true;
      try {
        const r = await runOnce(why);
        if (queued) {
          queued = false;
          const r2 = await runOnce(why);
          return { planned: r.planned || r2.planned, batch: r.batch + r2.batch, got: r.got + r2.got, capped: r2.capped || r.capped };
        }
        return r;
      } finally {
        busy = false;
      }
    },
    facts: counters,
    plan: planned
  };
}
async function loadBundleIndex(fetchCell, kind, dir) {
  const url = bundleIndexUrl(kind, dir);
  try {
    const r = await fetchCell(url, BUNDLE_TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const rawCells = j?.cells && typeof j.cells === "object" ? Object.keys(j.cells) : null;
    let cellBytes = null;
    let cellBld = null;
    if (rawCells) {
      for (const k of rawCells) {
        const meta = j.cells[k] || {};
        const by = num(meta.bytes), bd = num(meta.bld);
        if (by !== null && by > 0) {
          if (!cellBytes) cellBytes = /* @__PURE__ */ new Map();
          cellBytes.set(k, by);
        }
        if (bd !== null && bd > 0) {
          if (!cellBld) cellBld = /* @__PURE__ */ new Map();
          cellBld.set(k, bd);
        }
      }
    }
    return {
      kind,
      url,
      source: typeof j?.source === "string" && j.source ? j.source : null,
      cellCount: num(j?.cellCount),
      cells: rawCells ? new Set(rawCells) : null,
      attribution: typeof j?.attribution === "string" && j.attribution ? j.attribution : null,
      real: typeof j?.real === "boolean" ? j.real : null,
      /* ⚠️ `cellSize` **不走 `num()`**：`num(null)` 会回 0（`Number(null) === 0`），
         而 0 是坏值（格键除零 ⇒ 一个格都取不到），必须如实归成 **null = 数不出来**。 */
      cellSize: typeof j?.cellSize === "number" && Number.isFinite(j.cellSize) && j.cellSize > 0 ? j.cellSize : null,
      cellBytes,
      cellBld
    };
  } catch {
    return { kind, url, source: null, cellCount: null, cells: null, attribution: null, real: null, cellSize: null, cellBytes: null, cellBld: null };
  }
}
function bundleCountsLine(f, icon, unit) {
  if (!f.asked && f.have === 0 && f.missing === 0 && f.failed === 0) {
    return `${icon} 离线格 未取（还没要数据）`;
  }
  if (f.refused) {
    const pkgC = f.index && f.index.cellSize !== null && f.index.cellSize !== void 0 ? f.index.cellSize + "°" : "?";
    return `${icon} ❌ **格尺寸口径不符**（包 ${pkgC} / 前端 ${f.cellDeg}°）⇒ **本轮一个格都不取**（取格会把有数据的格说成「包外」；修包或改前端常量后重试）`;
  }
  const idx = f.index ? f.index.state === "已读" ? `（索引 ${f.index.cells === null ? "?" : f.index.cells} 格）` : f.index.state === "失败" ? "（索引失败：退回试格子）" : `（索引${f.index.state}）` : "";
  const head = `${icon} 离线格 已取 ${f.have} / 包外 ${f.missing} / 失败 ${f.failed}${idx}`;
  const pend = f.pending > 0 ? ` / 待取 ${f.pending}` : "";
  const store = f.n === null ? "数不出来" : String(f.n);
  const cap = f.capped ? `（视野共需 ${f.wanted === null ? "?" : f.wanted} 格，只取了最近的）` : "";
  return `${head}${pend} · 仓库 ${store} ${unit}${cap}`;
}
function bldVerdictState(f) {
  if (f.refused) return "sizemismatch";
  if (f.pending > 0 && f.n === 0 && f.have === 0) return "pending";
  if (f.n === 0 && f.have === 0 && f.missing > 0) return "outside";
  if (f.n === 0 && f.have === 0 && f.failed > 0 && f.missing === 0) return "failed";
  return "bundle";
}
function roadsVerdictState(f) {
  if (f.pending > 0 && f.n === 0 && f.have === 0) return "pending";
  if (f.n === 0 && f.have === 0 && f.failed > 0 && f.missing === 0) return "failed";
  return "bundle";
}

// src/components/views/worldsim/wsGwLayer.ts
var GW_KINDS = ["water", "green"];
var GW_LAYER_ID_OF = { water: "gw-water", green: "gw-green" };
var GW_LAYER_IDS = [GW_LAYER_ID_OF.water, GW_LAYER_ID_OF.green];
var GW_BUNDLE_DIR = "gwbundle";
var GW_SOURCE_KEY_PREFIX = GW_BUNDLE_DIR + ":";
function gwSourceKeyOf(cellKey) {
  return GW_SOURCE_KEY_PREFIX + cellKey;
}
var GW_RETAIN_RADIUS_M = 12e3;
function gwRetainRadiusM(bounds) {
  try {
    if (!bounds) return GW_RETAIN_RADIUS_M;
    const w = bounds.getWest(), e = bounds.getEast(), s = bounds.getSouth(), n = bounds.getNorth();
    if (![w, e, s, n].every((v) => Number.isFinite(v))) return GW_RETAIN_RADIUS_M;
    const viewDiag = metersBetween([w, s], [e, n]);
    const cellDiag = metersBetween([0, 0], [GW_BUNDLE_CELL_DEG, GW_BUNDLE_CELL_DEG]);
    return Math.max(GW_RETAIN_RADIUS_M, Math.round(viewDiag * 1.2 + cellDiag));
  } catch {
    return GW_RETAIN_RADIUS_M;
  }
}
var GW_COLOR_PATHS = {
  water: ["themes.anime.ai.water", "ai.water", "look.ai.water", "themes.night.ai.water"],
  green: ["themes.anime.ai.park", "ai.park", "look.ai.park", "themes.night.ai.park"]
};
function pickString(o, path) {
  let cur = o;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[seg];
  }
  return typeof cur === "string" && cur ? cur : null;
}
function gwColorsOf(theme) {
  const first = (paths) => {
    for (const p of paths) {
      const v = pickString(theme, p);
      if (v) return v;
    }
    return null;
  };
  return { water: first(GW_COLOR_PATHS.water), green: first(GW_COLOR_PATHS.green) };
}
function gwMissingColors(c) {
  const miss = [];
  if (!c.water) miss.push("water");
  if (!c.green) miss.push("green");
  return miss;
}
function gwBeforeIdOf(m) {
  try {
    const ls = m.getStyle?.()?.layers || [];
    for (const l of ls) {
      const id = String(l?.id ?? "");
      if (id.indexOf("bld") === 0) return id;
    }
    return void 0;
  } catch {
    return void 0;
  }
}
function applyGwLayers(opts) {
  const out = { added: [], updated: [], layers: [], sources: [], errs: [] };
  const m = opts.m;
  if (!m) return out;
  for (const k of GW_KINDS) {
    const id = GW_LAYER_ID_OF[k];
    const color = opts.colors[k];
    if (!color) continue;
    const fc = { type: "FeatureCollection", features: opts.data[k] };
    try {
      const src = m.getSource(id);
      if (src) {
        src.setData(fc);
        out.updated.push(id);
      } else {
        m.addSource(id, { type: "geojson", data: fc });
        m.addLayer(
          { id, type: "fill", source: id, paint: { "fill-color": color, "fill-outline-color": color } },
          opts.beforeId
        );
        out.added.push(id);
      }
      out.layers.push(id);
      out.sources.push(id);
    } catch (e) {
      out.errs.push(`${id} ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  return out;
}
function gwAttributionOf(index) {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}
function gwPlanForView(indexCells, bounds, center) {
  const p = bundleCellsForView(bounds, center, GW_BUNDLE_MAX_CELLS, GW_BUNDLE_CELL_DEG);
  if (!p) return null;
  const keys = indexCells ? p.cells.map((c) => c.key).filter((k) => indexCells.has(k)) : p.cells.map((c) => c.key);
  return { keys, wanted: p.wanted, capped: p.capped };
}
function gwVerdictLine(f) {
  if (!f.on) return "🌊🌳 水/绿地 关（?gw=0）";
  if (f.state === "no-index") {
    return "🌊🌳 水/绿地 数不出来：索引取不到（" + String(f.why || "index.json 没读到").slice(0, 60) + "）";
  }
  if (f.state === "size-mismatch") {
    return "🌊🌳 水/绿地 数不出来：格尺寸口径不符（包 " + String(f.cellSize) + "° / 前端 " + GW_BUNDLE_CELL_DEG + "°）⇒ **本轮一个格都不取**（取格会把有数据的格说成「包外」）";
  }
  if (f.state === "no-color") return "🌊🌳 水/绿地 数不出来：主题里没有 ai.water / ai.park（不硬编码色号）";
  if (f.state === "uncounted") {
    return "🌊🌳 水/绿地 数不出来：这一轮 0 格取到（格 " + f.hit + "/" + f.cells + (f.failed ? " · 失败 " + f.failed : "") + "）";
  }
  return "🌊🌳 水 " + f.water + " 面 · 绿 " + f.green + " 面（真数据 · 格 " + f.hit + "/" + f.cells + (f.failed ? " · 失败 " + f.failed : "") + "）";
}
function gwSnapshotOf(f) {
  return {
    on: f.on,
    /* 与页面历史口径一致：`cellCount || null`（0 也写 null） */
    index: f.indexCells || null,
    attribution: f.attribution,
    cells: f.cells,
    hit: f.hit,
    err: f.failed,
    water: f.water,
    green: f.green
  };
}
function emptyFacts(on) {
  return {
    on,
    state: "uncounted",
    water: null,
    green: null,
    cells: 0,
    hit: 0,
    failed: 0,
    indexCells: null,
    cellSize: null,
    attribution: null,
    why: null,
    layers: [],
    sources: []
  };
}
function nextFacts(prev, on, patch) {
  return Object.assign(emptyFacts(on), { layers: prev.layers.slice(), sources: prev.sources.slice() }, patch);
}
function createGwLayer(host) {
  const store = createFeatureStore({
    cap: GW_STORE_CAP,
    idOf: gwIdOf,
    pointOf: gwPointOf
  });
  let last = emptyFacts(host.enabled ? host.enabled() : true);
  let indexFact = null;
  let indexDone = false;
  function draw() {
    const colors = gwColorsOf(host.theme());
    if (gwMissingColors(colors).length) return;
    const feats = store.features();
    const res = applyGwLayers({
      m: host.map(),
      colors,
      data: {
        water: feats.filter((f) => f.properties?.kind === "water"),
        green: feats.filter((f) => f.properties?.kind === "green")
      },
      beforeId: beforeIdOf()
    });
    last.layers = res.layers;
    last.sources = res.sources;
    for (const e of res.errs) host.onError?.("gw " + e);
  }
  function beforeIdOf() {
    const m = host.map();
    if (!m) return void 0;
    if (host.beforeId) {
      try {
        return host.beforeId(m);
      } catch {
        return void 0;
      }
    }
    return gwBeforeIdOf(m);
  }
  function recount() {
    const feats = store.features();
    last.water = feats.reduce((n, f) => n + (f.properties?.kind === "water" ? 1 : 0), 0);
    last.green = feats.reduce((n, f) => n + (f.properties?.kind === "green" ? 1 : 0), 0);
  }
  function emit() {
    const line = gwVerdictLine(last);
    try {
      host.onHud?.(line, last);
    } catch {
    }
    try {
      host.onSnapshot?.(gwSnapshotOf(last), last);
    } catch {
    }
    return last;
  }
  const feed = createBundleFeed({
    kind: "gw",
    store,
    view: host.view,
    fetchCell: host.fetchCell,
    flush: () => {
      draw();
    },
    retainRadiusM: host.retainRadiusM || (() => gwRetainRadiusM(host.view().bounds)),
    onError: (why) => host.onError?.(why)
  });
  async function refresh(why = "view") {
    const on = host.enabled ? host.enabled() : true;
    if (!on) {
      last = nextFacts(last, false, { state: "off" });
      return emit();
    }
    try {
      if (!indexDone) {
        indexDone = true;
        const f = await loadBundleIndex(host.fetchCell, "gw");
        indexFact = f;
        if (f.cellCount === null && f.cells === null) {
          last = nextFacts(last, true, { state: "no-index", why: "index.json 没读到", cellSize: f.cellSize });
          return emit();
        }
      }
      const idx = indexFact;
      if (idx.cellSize !== null && Math.abs(idx.cellSize - GW_BUNDLE_CELL_DEG) > 1e-9) {
        last = nextFacts(last, true, {
          state: "size-mismatch",
          cellSize: idx.cellSize,
          indexCells: idx.cellCount,
          attribution: gwAttributionOf(idx),
          why: "包 " + idx.cellSize + "° / 前端 " + GW_BUNDLE_CELL_DEG + "°"
        });
        return emit();
      }
      const colors = gwColorsOf(host.theme());
      if (gwMissingColors(colors).length) {
        last = nextFacts(last, true, {
          state: "no-color",
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "主题缺 " + gwMissingColors(colors).join("/")
        });
        return emit();
      }
      await feed.refresh(why);
      if (!last.layers.length) draw();
      const view = host.view();
      const plan = gwPlanForView(idx.cells, view.bounds, view.center);
      const facts = feed.facts();
      if (!plan) {
        last = nextFacts(last, true, {
          state: "uncounted",
          cells: 0,
          hit: 0,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "视野拿不到（地图还没就绪）"
        });
        return emit();
      }
      const keys = plan.keys;
      const hit = keys.reduce((n, k) => n + (store.has(gwSourceKeyOf(k)) ? 1 : 0), 0);
      const uncounted = keys.length > 0 && hit === 0;
      if (uncounted) {
        last = nextFacts(last, true, {
          state: "uncounted",
          cells: keys.length,
          hit,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: "视野里的格一格都没取到"
        });
      } else {
        last = nextFacts(last, true, {
          state: "counted",
          cells: keys.length,
          hit,
          failed: facts.failed,
          indexCells: idx.cellCount,
          cellSize: idx.cellSize,
          attribution: gwAttributionOf(idx),
          why: null
        });
        recount();
      }
      return emit();
    } catch (e) {
      last = nextFacts(last, true, {
        state: "uncounted",
        why: String(e?.message || e).slice(0, 60)
      });
      host.onError?.("gw " + last.why);
      return emit();
    }
  }
  return {
    refresh,
    facts: () => last,
    index: () => indexFact,
    storeCount: () => {
      try {
        const s = store.stats();
        return Number.isFinite(s.n) ? s.n : null;
      } catch {
        return null;
      }
    }
  };
}

// src/components/views/worldsim/wsLabels.ts
var PLACE_AREA_TYPES = ["suburb", "quarter", "borough"];
var PLACE_LOCAL_TYPES = ["neighbourhood"];
function placeTierOf(placeType) {
  const t = String(placeType || "").trim().toLowerCase();
  if (PLACE_AREA_TYPES.indexOf(t) >= 0) return "area";
  if (PLACE_LOCAL_TYPES.indexOf(t) >= 0) return "local";
  return null;
}
function labelPlanFor(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : 14;
  return {
    zoom: z,
    admin: true,
    // 行政名任何 zoom 都要（它就是"这是哪儿"）
    /* `place` = "这一档**有没有**片区名可见"。因为**区片**名任何 zoom 都显示 ⇒ 恒 true；
       真正的**分档**在 `labelItemAllowed()` 里按类型判（区片=placeArea / 小区=placeLocal）。 */
    place: true,
    placeArea: true,
    // **区片**名：任何 zoom 都显示（"这是哪一片"）
    placeLocal: z >= 11,
    // **小区/街区**名：z≥11 才显示
    roadTrunk: z >= 11,
    // 主干道名
    roadSecondary: z >= 13,
    // 次干道名
    building: z >= 13,
    // 楼名（真实数据只有 ~5% 有名字，别期待满屏）
    cap: z >= 16 ? 26 : z >= 13 ? 20 : z >= 11 ? 12 : 6
  };
}
function labelPriorityOf(it) {
  switch (it.kind) {
    case "admin":
      return 100 + (3 - Math.min(3, Math.max(1, it.adminLevel || 3)));
    case "road_trunk":
      return 60;
    case "road_secondary":
      return 40;
    /* 片区：**区片**（suburb/quarter/borough）比**小区**（neighbourhood）高一点点 ——
       两者同属 `place` 档，但视野里同时有"渝中区/上清寺街道"和"某某小区"时，先保大的。
       注意仍然低于次干道（40）—— 父代理定的顺序：行政 > 主干 > 次干 > 片区 > 楼名。 */
    case "place":
      return placeTierOf(it.placeType) === "area" ? 34 : 30;
    case "building":
      return 20;
    default:
      return 0;
  }
}
function labelItemAllowed(it, plan) {
  if (!labelKindAllowed(it.kind, plan)) return false;
  if (it.kind !== "place") return true;
  const tier = placeTierOf(it.placeType);
  if (tier === "area") return plan.placeArea;
  if (tier === "local") return plan.placeLocal;
  return false;
}
function labelKindAllowed(kind, plan) {
  switch (kind) {
    case "admin":
      return plan.admin;
    case "place":
      return plan.place;
    case "road_trunk":
      return plan.roadTrunk;
    case "road_secondary":
      return plan.roadSecondary;
    case "building":
      return plan.building;
    default:
      return false;
  }
}
var CHAR_W = 6.5;
function labelBox(name, kind) {
  const n = Array.from(String(name)).length;
  const pad = kind === "building" ? 6 : 8;
  const h = kind === "admin" ? 18 : 14;
  return { w: Math.max(16, Math.round(n * CHAR_W) + pad), h };
}
function pickLabels(items, project, viewport, plan, opts = {}) {
  const grid = Math.max(8, opts.gridPx || 48);
  const margin = Number.isFinite(opts.margin) ? Number(opts.margin) : 24;
  const allowSketch = !!opts.allowSketch;
  const out = {
    shown: [],
    candidates: 0,
    droppedByCollision: 0,
    droppedByCap: 0,
    skippedNoName: 0,
    skippedSketch: 0,
    skippedOffscreen: 0,
    capped: false
  };
  const W = Number(viewport && viewport.width), H = Number(viewport && viewport.height);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return out;
  const cands = [];
  for (const it of items) {
    if (!it || String(it.name || "").trim() === "") {
      out.skippedNoName++;
      continue;
    }
    if (!allowSketch && it.source === "sketch") {
      out.skippedSketch++;
      continue;
    }
    if (!labelItemAllowed(it, plan)) continue;
    const pt = project(it.lng, it.lat);
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      out.skippedOffscreen++;
      continue;
    }
    if (pt.x < -margin || pt.y < -margin || pt.x > W + margin || pt.y > H + margin) {
      out.skippedOffscreen++;
      continue;
    }
    const box = labelBox(it.name, it.kind);
    cands.push({
      id: it.id,
      kind: it.kind,
      name: String(it.name).trim(),
      source: it.source,
      priority: labelPriorityOf(it),
      x: Math.round(pt.x),
      y: Math.round(pt.y),
      w: box.w,
      h: box.h
    });
  }
  out.candidates = cands.length;
  cands.sort((a, b) => b.priority - a.priority || Array.from(a.name).length - Array.from(b.name).length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const occupied = /* @__PURE__ */ new Set();
  for (const c of cands) {
    if (out.shown.length >= plan.cap) {
      out.droppedByCap++;
      out.capped = true;
      continue;
    }
    const x0 = Math.floor((c.x - c.w / 2) / grid), x1 = Math.floor((c.x + c.w / 2) / grid);
    const y0 = Math.floor((c.y - c.h / 2) / grid), y1 = Math.floor((c.y + c.h / 2) / grid);
    let hit = false;
    for (let gx = x0; gx <= x1 && !hit; gx++) for (let gy = y0; gy <= y1 && !hit; gy++) if (occupied.has(gx + "," + gy)) hit = true;
    if (hit) {
      out.droppedByCollision++;
      continue;
    }
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) occupied.add(gx + "," + gy);
    out.shown.push(c);
  }
  return out;
}
function roadLabelsFrom(features, kindOfRank) {
  const seen = /* @__PURE__ */ new Map();
  for (const f of features || []) {
    const props = f && f.properties || {};
    const name = String(props.name || "").trim();
    if (!name) continue;
    const kind = kindOfRank(Number(props.rank));
    if (kind !== "road_trunk" && kind !== "road_secondary") continue;
    if (seen.has(name)) continue;
    const coords = f.geometry && f.geometry.coordinates || [];
    const mid = coords[Math.floor(coords.length / 2)];
    if (!mid || !Number.isFinite(mid[0])) continue;
    seen.set(name, {
      id: "road:" + name,
      kind,
      name,
      lng: mid[0],
      lat: mid[1],
      source: "real"
      // 路网来自真 OSM（离线包/live 都是）
    });
  }
  return [...seen.values()];
}
function buildingLabelsFrom(features) {
  const out = [];
  for (const f of features || []) {
    const props = f && f.properties || {};
    const name = String(props.name || "").trim();
    if (!name) continue;
    const g = f.geometry || {};
    const ring = (g.coordinates || [])[0] || [];
    if (!ring.length) continue;
    let sx = 0, sy = 0;
    for (const p of ring) {
      sx += p[0];
      sy += p[1];
    }
    out.push({
      id: "bld:" + (props.osm_id || f.id || name),
      kind: "building",
      name,
      lng: sx / ring.length,
      lat: sy / ring.length,
      source: "real"
    });
  }
  return out;
}
function placeLabelsFrom(list) {
  const out = [];
  for (const it of list || []) {
    const name = String(it && (it.n !== void 0 ? it.n : it.name) || "").trim();
    if (!name) continue;
    const type = String(it && (it.k !== void 0 ? it.k : it.kind) || "").trim().toLowerCase();
    if (placeTierOf(type) === null) continue;
    const lng = it && it.p && Number.isFinite(it.p[0]) ? Number(it.p[0]) : Number((it || {}).lng);
    const lat = it && it.p && Number.isFinite(it.p[1]) ? Number(it.p[1]) : Number((it || {}).lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push({
      id: "place:" + (it.i || it.id || type + ":" + name),
      kind: "place",
      name,
      lng,
      lat,
      source: "real",
      placeType: type
    });
  }
  return out;
}
function adminLabelsFrom(list) {
  const out = [];
  for (const it of list || []) {
    const name = String(it && it.name || "").trim();
    if (!name || !Number.isFinite(it.lng) || !Number.isFinite(it.lat)) continue;
    out.push({ id: "admin:" + (it.id || name), kind: "admin", name, lng: it.lng, lat: it.lat, source: "real", adminLevel: it.level || 3 });
  }
  return out;
}

// src/components/views/worldsim/wsLog.ts
var LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
function safeStr(v, maxStr = 400) {
  if (v === void 0) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > maxStr ? v.slice(0, maxStr) + `…(+${v.length - maxStr})` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return String(v) + "n";
  if (typeof v === "function") return `[fn ${v.name || "anonymous"}]`;
  try {
    const seen = /* @__PURE__ */ new WeakSet();
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      if (typeof val === "bigint") return String(val) + "n";
      if (typeof val === "function") return `[fn ${val.name || "anonymous"}]`;
      return val;
    });
    if (s === void 0) return String(v);
    return s.length > maxStr ? s.slice(0, maxStr) + `…(+${s.length - maxStr})` : s;
  } catch (e) {
    return `[数不出来：${e?.message || String(e)}]`;
  }
}
function hhmmss(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function createWsLog(opts = {}) {
  const cap = Math.max(50, opts.cap ?? 1500);
  const maxStr = Math.max(40, opts.maxStr ?? 400);
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const buf = [];
  const counts = { total: 0, debug: 0, info: 0, warn: 0, error: 0, dropped: 0, cap };
  const min = LEVEL_ORDER[opts.minLevel ?? "debug"];
  let seq = 0;
  const repeats = /* @__PURE__ */ new Map();
  function push(lvl, tag, msg, data) {
    if (LEVEL_ORDER[lvl] < min) return null;
    const key = lvl + "|" + tag + "|" + msg;
    const n = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, n);
    if (n > 5 && n % 50 !== 0) {
      counts.dropped += 1;
      return null;
    }
    const e = {
      seq: ++seq,
      dt: now() - t0,
      at: hhmmss(now()),
      lvl,
      tag,
      msg: n > 5 ? `${msg}（同类第 ${n} 次）` : msg,
      ...data === void 0 ? {} : { data: typeof data === "string" ? safeStr(data, maxStr) : data }
    };
    counts.total += 1;
    counts[lvl] += 1;
    buf.push(e);
    if (buf.length > cap) {
      buf.splice(0, buf.length - cap);
      counts.dropped += 1;
    }
    try {
      opts.sink?.(e);
    } catch {
    }
    return e;
  }
  function text(env = {}) {
    const head = [
      `📋 wsLog 报告 · ${opts.tag || "page"} · 生成于 ${hhmmss(now())}`,
      `条数 ${counts.total}（debug ${counts.debug} / info ${counts.info} / warn ${counts.warn} / error ${counts.error}） · 缓冲上限 ${cap} · **丢弃 ${counts.dropped}**${counts.dropped ? "（日志不完整，重复行或超上限）" : ""}`
    ];
    const envLines = Object.keys(env).length ? ["── 环境 ──", ...Object.keys(env).map((k) => `  ${k} = ${safeStr(env[k], maxStr)}`)] : [];
    const body = buf.map((e) => {
      const d = e.data === void 0 ? "" : `  ${typeof e.data === "string" ? e.data : safeStr(e.data, maxStr)}`;
      const mark = e.lvl === "error" ? "❌" : e.lvl === "warn" ? "⚠️" : e.lvl === "info" ? "·" : "◦";
      return `${mark} [${String(e.dt).padStart(7)}ms] ${e.tag}: ${e.msg}${d}`;
    });
    return [...head, ...envLines, "── 事件 ──", ...body].join("\n");
  }
  return {
    tag: opts.tag || "page",
    log: push,
    debug: (tag, msg, data) => push("debug", tag, msg, data),
    info: (tag, msg, data) => push("info", tag, msg, data),
    warn: (tag, msg, data) => push("warn", tag, msg, data),
    error: (tag, msg, data) => push("error", tag, msg, data),
    entries: () => buf.slice(),
    counts: () => ({ ...counts }),
    text,
    json: (env = {}) => ({ tag: opts.tag || "page", at: now(), counts: { ...counts }, env, entries: buf.slice() }),
    clear: () => {
      buf.length = 0;
      repeats.clear();
    },
    /**
     * 包住 `fetch`：每条请求记 **url / status / ms / 字节数 / 错误**（字节数只有真读到 body 才有，
     * 拿不到就是 `null` —— 不许写 0）。返回 `restore()`。
     */
    patchFetch(target = globalThis) {
      const orig = target.fetch;
      if (typeof orig !== "function") {
        push("warn", "log", "patchFetch：没有 fetch 可包");
        return () => {
        };
      }
      target.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : input?.url || String(input);
        const t = now();
        try {
          const r = await orig.call(this, input, init);
          push(r.ok ? "debug" : "warn", "fetch", `${r.status} ${url}`, { ms: now() - t, ct: r.headers?.get?.("content-type") || null });
          return r;
        } catch (e) {
          push("error", "fetch", `失败 ${url}`, { ms: now() - t, err: safeStr(e?.message || e, 200) });
          throw e;
        }
      };
      return () => {
        target.fetch = orig;
      };
    },
    /** `window.onerror` + `unhandledrejection` 全收（返回 `restore()`） */
    installErrors(target = globalThis) {
      const prevOnError = target.onerror;
      const onErr = (ev) => {
        const e = ev;
        push("error", "window", e?.message || safeStr(e?.reason ?? ev, 200), {
          at: `${e?.filename || "?"}:${e?.lineno ?? "?"}:${e?.colno ?? "?"}`,
          stack: e?.error?.stack ? safeStr(e.error.stack, 300) : null
        });
        return false;
      };
      const onRej = (ev) => {
        const e = ev;
        const r = e?.reason;
        push("error", "promise", r?.message || safeStr(e?.reason, 200), { stack: r?.stack ? safeStr(r.stack, 300) : null });
      };
      try {
        target.onerror = onErr;
      } catch {
      }
      const ae = target.addEventListener;
      try {
        ae?.call(target, "unhandledrejection", onRej);
      } catch {
      }
      return () => {
        try {
          target.onerror = prevOnError;
        } catch {
        }
        try {
          target.removeEventListener?.call(target, "unhandledrejection", onRej);
        } catch {
        }
      };
    }
  };
}
function envSnapshot(extra = {}) {
  const nav = globalThis.navigator;
  const mem = performance?.memory;
  const conn = nav?.connection;
  return {
    ua: nav?.userAgent ?? null,
    lang: nav?.language ?? null,
    dpr: globalThis.devicePixelRatio ?? null,
    viewport: globalThis.innerWidth ? `${globalThis.innerWidth}×${globalThis.innerHeight ?? "?"}` : null,
    url: globalThis.location?.href ?? null,
    heapMB: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    heapLimitMB: mem?.jsHeapSizeLimit ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
    conn: conn?.effectiveType ?? null,
    ...extra
  };
}

// src/components/views/worldsim/wsBldGl.ts
var R = 6378137;
var D2R = Math.PI / 180;
function mercatorXOf(lng) {
  return (lng + 180) / 360;
}
function mercatorYOf(lat) {
  return (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))) / 360;
}
function metersToMercator(lat) {
  return 1 / (2 * Math.PI * R * Math.cos(lat * D2R));
}
function hexToRgb(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^#/, "");
  if (t.length === 3) t = t.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return null;
  return [parseInt(t.slice(0, 2), 16) / 255, parseInt(t.slice(2, 4), 16) / 255, parseInt(t.slice(4, 6), 16) / 255];
}
function ringBBox(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, k = 0;
  for (const p of ring || []) {
    const x = Number(p?.[0]), y = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < w) w = x;
    if (y < s) s = y;
    if (x > e) e = x;
    if (y > n) n = y;
    k++;
  }
  return k >= 3 ? { w, s, e, n } : null;
}
function buildBldBoxes(features, opts = {}) {
  const fallbackH = Number.isFinite(opts.fallbackHeight) ? opts.fallbackHeight : 8;
  const minM2 = Number.isFinite(opts.minFootprintM2) ? opts.minFootprintM2 : 30;
  const cap = opts.cap == null ? Infinity : Math.max(0, Math.floor(opts.cap));
  const ramp = (opts.ramp || []).map(([h, c]) => [h, hexToRgb(c) || [0.7, 0.8, 0.9]]);
  const center = [], size = [], color = [];
  const st = { considered: features.length, boxes: 0, skippedSmall: 0, skippedCap: 0, fallbackHeight: 0, noRing: 0, why: "" };
  for (const f of features) {
    if (st.boxes >= cap) {
      st.skippedCap++;
      continue;
    }
    const bb = f?.ring ? ringBBox(f.ring) : null;
    if (!bb) {
      st.noRing++;
      continue;
    }
    const lat0 = (bb.s + bb.n) / 2, lng0 = (bb.w + bb.e) / 2;
    const mx = metersToMercator(lat0);
    const wM = Math.abs(bb.e - bb.w) * 111320 * Math.cos(lat0 * D2R);
    const dM = Math.abs(bb.n - bb.s) * 110540;
    if (wM * dM < minM2) {
      st.skippedSmall++;
      continue;
    }
    let h = Number(f.h3d);
    if (!Number.isFinite(h) || h <= 0) {
      h = fallbackH;
      st.fallbackHeight++;
    }
    const c = hexToRgb(f.color) || (ramp.length ? ramp.reduce((acc, [hh, cc]) => h >= hh ? cc : acc, ramp[0][1]) : [0.62, 0.75, 0.88]);
    center.push(mercatorXOf(lng0), mercatorYOf(lat0), 0);
    size.push(Math.max(2, wM) * mx, Math.max(2, dM) * mx, h * mx);
    color.push(c[0], c[1], c[2]);
    st.boxes++;
  }
  st.why = `方盒 ${st.boxes} 栋 / 输入 ${st.considered}（跳过：太小 ${st.skippedSmall} · 超上限 ${st.skippedCap} · 无外环 ${st.noRing} · **用兜底高度 ${st.fallbackHeight}**）`;
  return {
    count: st.boxes,
    center: new Float32Array(center),
    size: new Float32Array(size),
    color: new Float32Array(color),
    stats: st
  };
}
var VS = `#version 300 es
in vec3 a_local;
in vec3 a_normal;
in vec3 a_center;
in vec3 a_size;
in vec3 a_color;
uniform mat4 u_matrix;
out vec3 v_color;
out vec3 v_n;
void main() {
  vec3 world = a_center + a_local * a_size;
  gl_Position = u_matrix * vec4(world, 1.0);
  /* 固定光（左上）；够便宜、也够把盒子"立"起来 —— 观感细节以后再说，这一版只要"看得出是 3D" */
  vec3 L = normalize(vec3(-0.45, -0.6, 0.8));
  v_n = a_normal;
  v_color = a_color * (0.62 + 0.38 * max(dot(a_normal, L), 0.0));
}`;
var FS = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec3 v_n;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;
function unitBox() {
  const p = [], n = [], idx = [];
  const faces = [
    [[-0.5, -0.5, 0.5], [0, 0, 1]],
    [[0.5, -0.5, 0.5], [0, 0, 1]],
    [[0.5, 0.5, 0.5], [0, 0, 1]],
    [[-0.5, 0.5, 0.5], [0, 0, 1]],
    [[0.5, -0.5, -0.5], [0, 0, -1]],
    [[-0.5, -0.5, -0.5], [0, 0, -1]],
    [[-0.5, 0.5, -0.5], [0, 0, -1]],
    [[0.5, 0.5, -0.5], [0, 0, -1]],
    [[-0.5, -0.5, -0.5], [-1, 0, 0]],
    [[-0.5, -0.5, 0.5], [-1, 0, 0]],
    [[-0.5, 0.5, 0.5], [-1, 0, 0]],
    [[-0.5, 0.5, -0.5], [-1, 0, 0]],
    [[0.5, -0.5, 0.5], [1, 0, 0]],
    [[0.5, -0.5, -0.5], [1, 0, 0]],
    [[0.5, 0.5, -0.5], [1, 0, 0]],
    [[0.5, 0.5, 0.5], [1, 0, 0]],
    [[-0.5, 0.5, 0.5], [0, 1, 0]],
    [[0.5, 0.5, 0.5], [0, 1, 0]],
    [[0.5, 0.5, -0.5], [0, 1, 0]],
    [[-0.5, 0.5, -0.5], [0, 1, 0]],
    [[-0.5, -0.5, -0.5], [0, -1, 0]],
    [[0.5, -0.5, -0.5], [0, -1, 0]],
    [[0.5, -0.5, 0.5], [0, -1, 0]],
    [[-0.5, -0.5, 0.5], [0, -1, 0]]
  ];
  for (const [pp, nn] of faces) {
    p.push(...pp);
    n.push(...nn);
  }
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  return { pos: new Float32Array(p), nrm: new Float32Array(n), idx: new Uint16Array(idx) };
}
function createBldGlLayer(opts) {
  let gl = null;
  let prog = null;
  let vao = null;
  let vboBox = null, vboNrm = null, ebo = null;
  let vboC = null, vboS = null, vboCol = null;
  let uni = null;
  let cur = opts.boxes;
  const stats = {
    draws: 0,
    lastInstances: 0,
    errors: 0,
    lastError: "",
    /* 🔍 诊断（2026-09-25 首跑 draw=0 / 错误 3 时加的）：把 GL 版本与**每个 shader 的编译日志**都留下来，
       否则只知道"失败了"、不知道为什么 —— 今天已经因为"没有回执"栽过好几次。 */
    glVersion: "",
    isWebGL2: null,
    logs: []
  };
  function upload() {
    if (!gl || !vboC) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vboC);
    gl.bufferData(gl.ARRAY_BUFFER, cur.center, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboS);
    gl.bufferData(gl.ARRAY_BUFFER, cur.size, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, cur.color, gl.DYNAMIC_DRAW);
    stats.lastInstances = cur.count;
  }
  return {
    id: opts.id || "bld-gl",
    type: "custom",
    renderingMode: "3d",
    /** 自检/HUD 用：层自己报的可数口径（不是我们从外面猜的） */
    glStats: () => ({ ...stats, instances: cur.count }),
    update(boxes) {
      cur = boxes;
      upload();
    },
    onAdd(_map, g) {
      gl = g;
      try {
        stats.glVersion = String(g.getParameter(g.VERSION) || "?");
        stats.isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && g instanceof WebGL2RenderingContext;
      } catch (e) {
        stats.logs.push("取 VERSION 失败：" + String(e).slice(0, 80));
      }
      const box = unitBox();
      const mk = (type, src) => {
        const s = g.createShader(type);
        if (!s) {
          stats.errors++;
          stats.logs.push("createShader 返回 null（type=" + type + "）");
          stats.lastError = "createShader null";
          return s;
        }
        g.shaderSource(s, src);
        g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
          stats.errors++;
          const log = String(g.getShaderInfoLog(s) ?? "(空日志)").slice(0, 220);
          stats.lastError = log;
          stats.logs.push((type === g.VERTEX_SHADER ? "VS: " : "FS: ") + log);
        }
        return s;
      };
      prog = g.createProgram();
      g.attachShader(prog, mk(g.VERTEX_SHADER, VS));
      g.attachShader(prog, mk(g.FRAGMENT_SHADER, FS));
      g.linkProgram(prog);
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
        stats.errors++;
        const pl = String(g.getProgramInfoLog(prog) ?? "(空日志)").slice(0, 220);
        stats.lastError = pl;
        stats.logs.push("LINK: " + pl);
      }
      uni = g.getUniformLocation(prog, "u_matrix");
      vao = g.createVertexArray();
      g.bindVertexArray(vao);
      const attr = (name) => g.getAttribLocation(prog, name);
      const bind = (buf, loc, size, div = 0) => {
        g.bindBuffer(g.ARRAY_BUFFER, buf);
        g.enableVertexAttribArray(loc);
        g.vertexAttribPointer(loc, size, g.FLOAT, false, 0, 0);
        if (div) g.vertexAttribDivisor(loc, div);
      };
      vboBox = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, vboBox);
      g.bufferData(g.ARRAY_BUFFER, box.pos, g.STATIC_DRAW);
      bind(vboBox, attr("a_local"), 3);
      vboNrm = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, vboNrm);
      g.bufferData(g.ARRAY_BUFFER, box.nrm, g.STATIC_DRAW);
      bind(vboNrm, attr("a_normal"), 3);
      ebo = g.createBuffer();
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ebo);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, box.idx, g.STATIC_DRAW);
      vboC = g.createBuffer();
      bind(vboC, attr("a_center"), 3, 1);
      vboS = g.createBuffer();
      bind(vboS, attr("a_size"), 3, 1);
      vboCol = g.createBuffer();
      bind(vboCol, attr("a_color"), 3, 1);
      upload();
      g.bindVertexArray(null);
    },
    render(g, matrix) {
      if (!prog || !vao || cur.count === 0) return;
      g.useProgram(prog);
      g.uniformMatrix4fv(uni, false, new Float32Array(matrix));
      g.bindVertexArray(vao);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.enable(g.CULL_FACE);
      g.cullFace(g.BACK);
      g.drawElementsInstanced(g.TRIANGLES, 36, g.UNSIGNED_SHORT, 0, cur.count);
      stats.draws++;
      stats.lastInstances = cur.count;
      g.bindVertexArray(null);
    },
    onRemove() {
      stats.errors = stats.errors;
      gl = null;
    }
  };
}

// src/components/views/worldsim/wsDaily.ts
var R2 = 63710088e-1;
var D2R2 = Math.PI / 180;
function distM(a, b) {
  const dLat = (b.lat - a.lat) * D2R2;
  const dLng = (b.lng - a.lng) * D2R2;
  const la1 = a.lat * D2R2, la2 = b.lat * D2R2;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function pickHome(places, opts) {
  const maxM = Number.isFinite(opts.maxM) ? opts.maxM : 3e3;
  const prefer = opts.preferKinds || ["neighbourhood", "quarter", "suburb"];
  const valid = (places || []).filter((p) => p && typeof p.name === "string" && p.name.trim() && Number.isFinite(p.lng) && Number.isFinite(p.lat));
  if (!opts.center || !Number.isFinite(opts.center.lng) || !Number.isFinite(opts.center.lat)) {
    return { home: null, why: "没有地图中心 ⇒ 数不出来（不能瞎挑一个家）", candidates: null, distM: null };
  }
  const c = opts.center;
  const inRange = valid.map((p) => ({ p, d: distM(c, p) })).filter((x) => x.d <= maxM);
  if (inRange.length === 0) {
    return {
      home: null,
      why: `半径 ${maxM}m 内没有**有名字**的片区（有名点共 ${valid.length} 个）⇒ 不编一个家`,
      candidates: 0,
      distM: null
    };
  }
  const rank = (k) => {
    const i = prefer.indexOf(String(k || ""));
    return i < 0 ? prefer.length : i;
  };
  inRange.sort((a, b) => rank(a.p.kind) - rank(b.p.kind) || a.d - b.d || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0));
  const best = inRange[0];
  return {
    home: best.p,
    why: `家 = ${best.p.name}（${best.p.kind || "片区"} · 距中心 ${Math.round(best.d)}m · 半径内有名点 ${inRange.length} 个）`,
    candidates: inRange.length,
    distM: best.d
  };
}
function dayKeyOf(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function planDaily(opts) {
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const day = dayKeyOf(now);
  const residents = (opts.residents || []).filter((r) => r && r.id && r.name);
  const spots = (opts.spots || []).filter((s) => s && s.id && s.name);
  const missing = [];
  if (residents.length === 0) missing.push("没有居民（角色）⇒ 前两件只能退成'走走看看'");
  if (spots.length === 0 && !opts.homeName) missing.push("没有地点/家 ⇒ 第三件只能退成'随便逛逛'");
  const pickOf = (arr, kind) => arr.length ? arr[dayHash(day + "|" + kind) % arr.length] : null;
  const r1 = pickOf(residents, "greet");
  const r2 = pickOf(residents, "gift");
  const s1 = pickOf(spots, "visit");
  const tasks = [
    r1 ? { id: `greet:${r1.id}`, kind: "greet", targetId: r1.id, done: false, text: `跟 ${r1.name} 打个招呼` } : { id: "greet:none", kind: "greet", targetId: null, done: false, text: "在附近走走，看看有什么" },
    r2 ? { id: `gift:${r2.id}`, kind: "gift", targetId: r2.id, done: false, text: `送一样东西给 ${r2.name}` } : { id: "gift:none", kind: "gift", targetId: null, done: false, text: "找一样喜欢的东西带上" },
    opts.homeName || s1 ? {
      id: `visit:${opts.homeName || s1.id}`,
      kind: "visit",
      targetId: s1 ? s1.id : null,
      done: false,
      text: opts.homeName ? `回一趟 ${opts.homeName}` : `去一次 ${s1.name}`
    } : { id: "visit:none", kind: "visit", targetId: null, done: false, text: "随便逛逛" }
  ];
  const prev = opts.prev;
  if (prev && prev.day === day) {
    const doneMap = new Map(prev.tasks.map((t) => [t.id, t.done]));
    for (const t of tasks) if (doneMap.get(t.id) === true) t.done = true;
  }
  const doneN = tasks.filter((t) => t.done).length;
  return {
    state: { day, tasks },
    missing,
    why: `今日三件事（${day}）：完成 ${doneN}/3` + (prev && prev.day !== day ? ` · **已跨天重置**（上次 ${prev.day}）` : "") + (missing.length ? ` · 缺件：${missing.join("；")}` : "")
  };
}
function toggleTask(state, taskId, done) {
  const tasks = state.tasks.map((t) => t.id === taskId ? { ...t, done: done === void 0 ? !t.done : !!done } : t);
  return { day: state.day, tasks };
}

// src/components/views/worldsim/wsNameGen.ts
var WS_GEN_TAG = "生成·示意";
var PREFIX = [
  "老街",
  "巷口",
  "三元",
  "李家",
  "张记",
  "王姐",
  "陈氏",
  "转角",
  "南门",
  "北巷",
  "桥头",
  "半边街",
  "小院",
  "新华",
  "民主",
  "建设",
  "和平",
  "长江",
  "嘉陵",
  "山城"
];
var SHOP = [
  "小面",
  "抄手",
  "火锅",
  "串串",
  "茶馆",
  "理发",
  "药房",
  "烟酒",
  "五金",
  "裁缝",
  "文具",
  "水果",
  "早餐",
  "卤味",
  "凉菜",
  "炒货",
  "糖水",
  "奶茶",
  "糕点",
  "照相",
  "洗衣",
  "快递代收",
  "杂货",
  "粮油",
  "修车",
  "锁匠",
  "钟表",
  "花店",
  "布艺",
  "家电维修"
];
var STALL = [
  "烤红薯",
  "糖炒栗子",
  "凉粉",
  "豆花",
  "冰粉",
  "煎饼",
  "油茶",
  "锅盔",
  "串串香",
  "酸辣粉",
  "手工糍粑",
  "鲜榨果汁",
  "烤玉米",
  "卤鸭脖",
  "炸洋芋",
  "抄手皮",
  "麻花",
  "糍粑块",
  "凉虾",
  "棉花糖"
];
var SUFFIX = ["店", "铺", "馆", "行", "坊", "屋", "站"];
function hash32(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}
function genName(id, kind = "shop") {
  const h = hash32(String(id ?? "") + "|" + kind);
  const p = PREFIX[h % PREFIX.length];
  if (kind === "stall") {
    const s2 = STALL[(h >>> 8) % STALL.length];
    return p + s2;
  }
  const s = SHOP[(h >>> 8) % SHOP.length];
  const suf = SUFFIX[(h >>> 16) % SUFFIX.length];
  return p + s + suf;
}
function planGenNames(ids, cap, kind = "shop") {
  const list = (ids || []).map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  if (n === 0 || list.length === 0) return [];
  const uniq = Array.from(new Set(list));
  const sorted = uniq.map((id) => ({ id, k: hash32(id + "|pick|" + kind) })).sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = [];
  const take = Math.min(n, sorted.length);
  for (let i = 0; i < take; i++) {
    const idx = Math.floor(i * sorted.length / take);
    const it = sorted[idx];
    out.push({ id: it.id, name: genName(it.id, kind), kind });
  }
  return out;
}
function planStalls(roads, cap, perRoad = 2) {
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  if (n === 0) return [];
  const per = Math.max(1, Math.trunc(perRoad) || 1);
  const picked = [];
  for (const r of roads || []) {
    const cs = (r?.coords || []).filter((c) => Array.isArray(c) && c.length >= 2);
    if (cs.length < 2) continue;
    for (let j = 0; j < per; j++) {
      const h = hash32(`${r.id}|stall|${j}`);
      const t = h % 1e3 / 1e3 * 0.9 + 0.05;
      const seg = Math.min(cs.length - 2, Math.floor(t * (cs.length - 1)));
      const local = t * (cs.length - 1) - seg;
      const a = cs[seg], b = cs[seg + 1];
      const lng = Number(a[0]) + (Number(b[0]) - Number(a[0])) * local;
      const lat = Number(a[1]) + (Number(b[1]) - Number(a[1])) * local;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const dLat = 4 / 110540;
      const dLng = 4 / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
      const sign = (h >>> 12) % 2 ? 1 : -1;
      const id = `${r.id}#s${j}`;
      picked.push({ id, name: genName(id, "stall"), lng: lng + nx * sign * dLng, lat: lat + ny * sign * dLat, k: hash32(id + "|pick") });
    }
  }
  picked.sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const take = Math.min(n, picked.length);
  const out = [];
  for (let i = 0; i < take; i++) {
    const it = picked[Math.floor(i * picked.length / take)];
    out.push({ id: it.id, name: it.name, lng: it.lng, lat: it.lat });
  }
  return out;
}
function genCountsLine(realShown, genShown, stallsShown) {
  const r = Number.isFinite(realShown) ? String(realShown) : "数不出来";
  const g = Number.isFinite(genShown) ? String(genShown) : "数不出来";
  const s = Number.isFinite(stallsShown) ? String(stallsShown) : "数不出来";
  return `🏷 真名 ${r} · ${WS_GEN_TAG} 楼名 ${g} · ${WS_GEN_TAG} 小摊 ${s}`;
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
function hash322(s) {
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
    const k2 = hash322(seed + "#unk") % 101;
    const h2 = UNKNOWN_KIND_BAND_M[0] + (UNKNOWN_KIND_BAND_M[1] - UNKNOWN_KIND_BAND_M[0]) * k2 / 100;
    return { h: Math.min(MAX_RENDER_H, Math.max(3, Math.round(h2 * 10) / 10)), from: "kind" };
  }
  const base = KIND_HEIGHT_M[kind] ?? FALLBACK_HEIGHT_M;
  const k = hash322(seed) % 31;
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
  const k = 0.9 + hash322(seed || "x") % 21 / 100;
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
      const s = hash322(`${seed}#eq${i}:${cand}`);
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
  BLD_BUNDLE_CELL_DEG,
  BLD_BUNDLE_MAX_CELLS,
  BLD_BUNDLE_PER_REFRESH,
  BLD_STORE_CAP,
  BLD_STORE_CAP_MAX,
  BLD_STORE_CAP_RECOMMENDED,
  BUILDING_LAYER_ID,
  BUNDLE_BYTES_PER_ROUND,
  BUNDLE_REQ_PER_ROUND_MAX,
  BUNDLE_TIMEOUT_MS,
  CAMERA_DEFAULTS,
  EQUIP_MIN_AREA_M2,
  EQUIP_SIDE_MIN,
  EQUIP_SIDE_STEPS,
  EQUIP_SIDE_STEP_M,
  FALLBACK_HEIGHT_M,
  GW_BUNDLE_CELL_DEG,
  GW_BUNDLE_DIR,
  GW_BUNDLE_MAX_CELLS,
  GW_BUNDLE_PER_REFRESH,
  GW_KINDS,
  GW_LAYER_IDS,
  GW_LAYER_ID_OF,
  GW_RETAIN_RADIUS_M,
  GW_SOURCE_KEY_PREFIX,
  GW_STORE_CAP,
  HEIGHT_COLOR_RAMP,
  KIND_HEIGHT_M,
  KIND_JITTER,
  LOD_FAR_ZOOM,
  LOD_LIVE_LAYER_PREFIXES,
  LOD_LIVE_SOURCE_IDS,
  LOD_NEAR_ZOOM,
  LOD_OPACITY_STOPS,
  LOD_OPACITY_ZERO_ZOOM,
  LOD_VIEW_TILE_CAP,
  MAX_RENDER_H,
  PAN_MAX_SPEED,
  PARAPET_H,
  PARAPET_MIN_H,
  PARAPET_THICK_M,
  PITCH_SOFT,
  PLACES_BUNDLE_CELL_DEG,
  PLACES_BUNDLE_MAX_CELLS,
  PLACES_BUNDLE_PER_REFRESH,
  PLACES_STORE_CAP,
  PLACE_AREA_TYPES,
  PLACE_LOCAL_TYPES,
  PM_LONG_TASK_KEEP,
  PM_LONG_TASK_MS,
  PM_SAMPLE_CAP,
  PODIUM_H_MAX,
  PODIUM_H_MIN,
  PODIUM_H_RATIO,
  PODIUM_INSET,
  PODIUM_MIN_AREA_M2,
  PODIUM_MIN_H,
  PRERENDER_ATTRIBUTION,
  PRERENDER_DEMO_ATTRIBUTION,
  PRERENDER_DEMO_MANIFEST_PATH,
  PRERENDER_DEMO_TILE_PATH,
  PRERENDER_LAYER_ID,
  PRERENDER_MANIFEST_PATH,
  PRERENDER_SOURCE_ID,
  PRERENDER_TILE_MAXZOOM,
  PRERENDER_TILE_PATH,
  PRERENDER_TILE_SIZE,
  ROADS_BUNDLE_CELL_DEG,
  ROADS_BUNDLE_MAX_CELLS,
  ROADS_BUNDLE_PER_REFRESH,
  ROADS_STORE_CAP,
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
  WS_BLD_CELL_CAP,
  WS_BLD_CELL_DEG,
  WS_BLD_LIVE_DEFAULT,
  WS_BLD_LIVE_VERDICT,
  WS_BLD_OUTLINE_FULL_ZOOM,
  WS_BLD_VECTOR_MINZOOM,
  WS_BLD_VIEW_CAP,
  WS_FETCH_R_BACKEND_MAX,
  WS_FETCH_R_LADDER,
  WS_FETCH_R_LIMIT_WHY,
  WS_FETCH_R_MAX,
  WS_FETCH_R_MIN,
  WS_FETCH_R_SOURCE_MAX,
  WS_GEN_TAG,
  WS_ROADS_CHUNKING_VERDICT,
  WS_ROADS_LIMIT_WHY,
  WS_ROADS_LIVE_DEFAULT,
  WS_ROADS_LIVE_VERDICT,
  WS_ROADS_R_MAX,
  WS_SCENE_SOURCE,
  adminLabelsFrom,
  applyBuildingsTo,
  applyGwLayers,
  applyPitchGuard,
  art3Summary,
  bldBundleCellKey,
  bldBundleCellOf,
  bldBundleCellsForView,
  bldIdOf,
  bldLayerSpecsFor,
  bldLiveDecision,
  bldPointOf,
  bldPointOfRaw,
  bldVerdictState,
  bldVerdictText,
  buildBldBoxes,
  buildSkyGeometry,
  buildTransport,
  buildingColor,
  buildingLabelsFrom,
  buildingMasses,
  buildingPartSet,
  buildingParts,
  bundleBuildingsOf,
  bundleCellKey,
  bundleCellOf,
  bundleCellUrl,
  bundleCellsForView,
  bundleCountsLine,
  bundleGwOf,
  bundleIndexUrl,
  bundlePlacesOf,
  bundleRoadsOf,
  cameraDefaults,
  capBuildingsPerCell,
  contrastRatio,
  contrastReport,
  createBldGlLayer,
  createBundleFeed,
  createFeatureStore,
  createGwLayer,
  createWsLog,
  dayHash,
  dayKeyOf,
  decorateBuildings,
  distM,
  districtStyleOf,
  envSnapshot,
  equipBoxes,
  fetchRadiusForView,
  fetchRadiusForZoom,
  fetchRadiusLadder,
  fetchRadiusRound,
  fetchWithTimeout,
  flushBldStore,
  flushRoadsStore,
  fmtCount,
  footprintMetrics,
  genCountsLine,
  genName,
  gwAttributionOf,
  gwBeforeIdOf,
  gwColorsOf,
  gwIdOf,
  gwMissingColors,
  gwPlanForView,
  gwPointOf,
  gwRetainRadiusM,
  gwSnapshotOf,
  gwSourceKeyOf,
  gwVerdictLine,
  hash322 as hash32,
  heightColorExpression,
  hexRgb,
  hexToRgb,
  horizonYOf,
  insetRing,
  insetRingMeters,
  junctions,
  labelBox,
  labelItemAllowed,
  labelKindAllowed,
  labelPlanFor,
  labelPriorityOf,
  layerOrderHud,
  loadBundleIndex,
  lodEventTileKey,
  lodHudLine,
  lodLayerSpec,
  lodLiveLayerIds,
  lodLiveVerdict,
  lodLiveVerdictOf,
  lodNum,
  lodOpacityAt,
  lodOpacityExpression,
  lodPlan,
  lodSourceSpec,
  lodTierLabel,
  lodTierOf,
  lodTileKey,
  lodTileKindOf,
  lodTileStatesOf,
  lodTileVerdict,
  lodTileX,
  lodTileY,
  lodViewTiles,
  mercatorXOf,
  mercatorYOf,
  metersBetween,
  metersToMercator,
  nearestOnLine,
  panDamping,
  pickBuildingsForView,
  pickHome,
  pickLabels,
  pitchGuardParams,
  pixelRatioForTier,
  placeLabelsFrom,
  placeTierOf,
  placesBundleCellsForView,
  placesIdOf,
  placesPointOf,
  planBeforeOf,
  planDaily,
  planEnsureRoadOrder,
  planGenNames,
  planStalls,
  pmAvailable,
  pmMark,
  pmNow,
  pmObserveLongTasks,
  pmPercentile,
  pmReset,
  pmSetContext,
  pmSnapshot,
  pmSpan,
  pmTime,
  pmTimeAsync,
  pointInRing,
  prerenderSourceOf,
  rampColorOf,
  relLuminance,
  renderHeight,
  resetScenePlanConsumed,
  resolveBldStoreCap,
  ringAreaM2,
  ringBand,
  ringCentroid,
  roadCountHud,
  roadCountVerdict,
  roadLabelsFrom,
  roadLayerSpecs,
  roadLayersOf,
  roadStatsLine,
  roadStyleOf,
  roadsBundleCellKey,
  roadsBundleCellOf,
  roadsBundleCellsForView,
  roadsIdOf,
  roadsLiveDecision,
  roadsPointOf,
  roadsPointOfRaw,
  roadsRadiusFor,
  roadsVerdictState,
  roadsVerdictText,
  safeStr,
  sceneGroupOf,
  sceneLayerPlan,
  sceneOrderViolations,
  scenePlanConsumed,
  sceneSelfReport,
  shade,
  shapeCountRows,
  shapeCountsLine,
  toLngLat,
  toMeters,
  toggleTask,
  transportHudLine,
  viewHalfMetersOf,
  visibleRoadCount,
  windowPatternSpec,
  wsFetchRadiusMax
};
