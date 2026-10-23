// src/components/views/worldsim/wsTransportRules.ts
var TF_RULES = {
  bus: {
    /** 只沿 class ≤ 2 的路设站 */
    maxCls: 2,
    /** 站间目标间隔（米）：350~500 ⇒ 生成时用 `spacing` 做步长，落点会因路口吸附而落在区间内 */
    spacing: 250,
    // 2026-09-22 太稀 ⇒ 420 → 250（一处改，生成逻辑跟着变）
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
  const box = roads.map((r) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of r.pts) {
      if (!Array.isArray(p)) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      minX,
      maxX,
      minY,
      maxY,
      ok: Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    };
  });
  const xsorted = roads.map((r) => {
    const arr = r.pts.map((p, i) => ({ x: Number(p?.[0]), y: Number(p?.[1]), i }));
    arr.sort((a, b) => a.x - b.x);
    return arr;
  });
  const segboxes = roads.map((r) => {
    const out2 = [];
    for (let k = 1; k < r.pts.length; k++) {
      const a = r.pts[k - 1];
      const b = r.pts[k];
      const ax = Number(a?.[0]);
      const ay = Number(a?.[1]);
      const bx = Number(b?.[0]);
      const by = Number(b?.[1]);
      const ok = [ax, ay, bx, by].every((v) => Number.isFinite(v));
      out2.push({
        idx: k,
        minX: Math.min(ax, bx),
        maxX: Math.max(ax, bx),
        minY: Math.min(ay, by),
        maxY: Math.max(ay, by),
        ok
      });
    }
    return out2;
  });
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i];
      const B = roads[j];
      const ba = box[i];
      const bb = box[j];
      if (ba.ok && bb.ok && (ba.maxX + withinM < bb.minX || bb.maxX + withinM < ba.minX || ba.maxY + withinM < bb.minY || bb.maxY + withinM < ba.minY)) {
        continue;
      }
      let hit = null;
      const boxesOverlap = !(ba.ok && bb.ok) || !(ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY);
      if (boxesOverlap) {
        const ovMinX = Math.max(ba.minX, bb.minX);
        const ovMaxX = Math.min(ba.maxX, bb.maxX);
        const ovMinY = Math.max(ba.minY, bb.minY);
        const ovMaxY = Math.min(ba.maxY, bb.maxY);
        const sa = segboxes[i];
        const sb = segboxes[j];
        const candA = [];
        for (const s of sa) {
          if (!s.ok) {
            candA.push(s.idx);
            continue;
          }
          if (s.maxX < ovMinX || s.minX > ovMaxX || s.maxY < ovMinY || s.minY > ovMaxY) continue;
          candA.push(s.idx);
        }
        const candB = [];
        for (const s of sb) {
          if (!s.ok) {
            candB.push(s.idx);
            continue;
          }
          if (s.maxX < ovMinX || s.minX > ovMaxX || s.maxY < ovMinY || s.minY > ovMaxY) continue;
          candB.push(s.idx);
        }
        for (const ai of candA) {
          if (hit) break;
          for (const bi of candB) {
            hit = segIntersect(A.pts[ai - 1], A.pts[ai], B.pts[bi - 1], B.pts[bi]);
            if (hit) break;
          }
        }
      }
      if (!hit) {
        const bx = xsorted[j];
        for (const a2 of A.pts) {
          const ax = Number(a2[0]);
          let lo = 0;
          let hi = bx.length;
          while (lo < hi) {
            const mid = lo + hi >> 1;
            if (bx[mid].x < ax - withinM) lo = mid + 1;
            else hi = mid;
          }
          let best = -1;
          for (let k = lo; k < bx.length && bx[k].x <= ax + withinM; k++) {
            const b2 = B.pts[bx[k].i];
            if (Math.abs(Number(a2[1]) - Number(b2[1])) > withinM) continue;
            if (dist(a2, b2) <= withinM && (best < 0 || bx[k].i < best)) best = bx[k].i;
          }
          if (best >= 0) {
            const b2 = B.pts[best];
            hit = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
            break;
          }
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
var FOOTPRINT_LAYER_ID = "bld-foot";
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
  const footIdx = idx(FOOTPRINT_LAYER_ID);
  const blockers = [];
  const lowestTf = tfIdx.length ? Math.min(...tfIdx) : -1;
  if (lowestTf >= 0 && firstRoad > lowestTf) blockers.push("交通设施");
  if (bldIdx >= 0 && firstRoad > bldIdx) blockers.push("楼体");
  if (footIdx >= 0 && firstRoad < footIdx) blockers.push("足迹层");
  if (!blockers.length) return ops;
  let before = "";
  if (lowestTf >= 0 && bldIdx >= 0) before = lowestTf < bldIdx ? ids[lowestTf] : ids[bldIdx];
  else if (lowestTf >= 0) before = ids[lowestTf];
  else if (bldIdx >= 0) before = ids[bldIdx];
  else if (footIdx >= 0) before = ids[footIdx + 1] || "";
  if (!before) return ops;
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
  /* **足迹层**（`bld-foot`，2026-10-03「按 zoom 分层」）：`z<14` 时屏上的"楼"就是这一层。
     它是**贴在地面上的平面**（`fill`），与路网/水绿同一档 —— 也就是**在它们之下**。
     单列一组（而不是塞进 `buildings`）：混进去会让下面那条"路网被楼体压住"的判据**误报**
     （2026-10-03 加这一层时实测到：`firstOf("buildings")` 取到的是最下面那条 `bld-foot`）。 */
  { group: "footprint", idPrefixes: ["bld-foot"], beforeId: "bld-ext", why: "足迹是地面上的平面（在路网/水绿之下、楼体之下）" },
  { group: "roads", idPrefixes: ["road-casing-", "road-line-"], beforeId: "bld-ext", why: "路是地面上的东西，压在楼上会像从楼顶穿过" },
  { group: "transport", idPrefixes: ["tf-"], beforeId: "bld-ext", why: "交通设施**贴在路之上**（先插路网、后插设施 ⇒ 设施在上）" },
  { group: "buildings", idPrefixes: ["bld-"], excludePrefixes: ["bld-foot"], beforeId: null, why: "楼体在最上（数据层，交互载体）" },
  /* LOD 第 1 步（2026-09-24）：预渲染瓦片层。**它在矢量层之上**是刻意的 ——
     远景（z≤12）要让瓦片**盖住**实时层，中间靠 `raster-opacity` 随 zoom 淡到 0 把画面交还矢量层；
     反过来放（瓦片在下）就得给 12 条路网 + 楼体各写一份"淡入"，那才是新造一套机制。
     这条"在上"由 `sceneOrderViolations` 守着（被矢量层压住 = 远景会露出实时层）。 */
  { group: "prerender", idPrefixes: ["prerender"], beforeId: "ref", why: "预渲染瓦片 = 远景替身，压在矢量层之上、注记之下（靠 zoom 淡出把近景交还实时层）" }
];
function sceneLayerPlan() {
  return SCENE_LAYER_ORDER.map((e) => ({ ...e }));
}
function planEntryHas(e, id) {
  if (!e.idPrefixes.some((p) => id.startsWith(p))) return false;
  return !(e.excludePrefixes || []).some((p) => id.startsWith(p));
}
function sceneGroupOf(layerId) {
  const id = String(layerId || "");
  for (const e of SCENE_LAYER_ORDER) if (planEntryHas(e, id)) return e.group;
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
    const positions = layerIds.map((id, i) => planEntryHas(e, id) ? i : -1).filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : -1;
  };
  const foot = firstOf("footprint");
  const roads = firstOf("roads");
  const tf = firstOf("transport");
  const bld = firstOf("buildings");
  const pre = firstOf("prerender");
  if (foot >= 0 && roads >= 0 && foot > roads) out.push("足迹层被路网压在上面（它是地面肌理，应在路网之下）");
  if (foot >= 0 && tf >= 0 && foot > tf) out.push("足迹层被交通设施压在上面（应在下方）");
  if (foot >= 0 && bld >= 0 && foot > bld) out.push("足迹层被楼体压在上面（应在下方）");
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
  /* 2026-09-26 用户决定：**预渲染瓦片层（那些"白蓝方片"）不再作为主力**，
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
function lodTileStatesOf(map2, sourceId = PRERENDER_SOURCE_ID) {
  try {
    const tm = map2 && map2.style && map2.style.tileManagers ? map2.style.tileManagers[sourceId] : null;
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
function lodLiveVerdictOf(map2) {
  if (!map2 || typeof map2.getStyle !== "function") return null;
  let layers = [];
  try {
    const st = map2.getStyle();
    layers = lodLiveLayerIds((st && st.layers || []).map((l) => String(l && l.id || "")));
  } catch {
    layers = [];
  }
  let rendered = null;
  let source = null;
  let tilesLoaded = null;
  try {
    if (layers.length && typeof map2.queryRenderedFeatures === "function") {
      const r = map2.queryRenderedFeatures({ layers });
      rendered = Array.isArray(r) ? r.length : null;
    }
  } catch {
    rendered = null;
  }
  try {
    if ((rendered === null || rendered === 0) && typeof map2.querySourceFeatures === "function") {
      let n = 0;
      let anyOk = false;
      for (const sid of LOD_LIVE_SOURCE_IDS) {
        try {
          const f = map2.querySourceFeatures(sid);
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
    if (typeof map2.areTilesLoaded === "function") tilesLoaded = !!map2.areTilesLoaded();
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
function applyPitchGuard(map2) {
  try {
    const p = map2 && typeof map2.getPitch === "function" ? map2.getPitch() : 0;
    const { damping, maxSpeed, wheelZoomRate } = pitchGuardParams(p);
    if (map2 && map2.dragPan && typeof map2.dragPan.enable === "function") map2.dragPan.enable({ maxSpeed });
    if (map2 && map2.scrollZoom && typeof map2.scrollZoom.setWheelZoomRate === "function") map2.scrollZoom.setWheelZoomRate(wheelZoomRate);
    return damping;
  } catch {
    return 1;
  }
}

// src/components/views/worldsim/wsMapTheme.ts
var ANIME = {
  id: "anime",
  label: "二次元（蔚蓝档案）",
  hud: "二次元 · 平涂",
  separation: "outline",
  sky: {
    /* 2026-09-20 二轮（"① 颜色再鲜 ② 整体更亮"）：
       天空换成**彩度更高**的蓝（亮度基本不变、纯度和蓝味都上去了）。 */
    "sky-color": "#72C8F7",
    // 明亮天蓝（比上一版 #7EC8F0 更纯）
    "horizon-color": "#E8F8FF",
    // 近白的地平线（略偏青，和地面同调）
    "fog-color": "#D6EEFC",
    // 淡蓝白雾，**不是暗雾**：远景要"化开"成亮的
    /* 二轮+（"要能看见天空（基沃托斯的天空）"）：
       把**地平线那圈白雾带**调明显 —— `horizon-fog-blend` 抬到 0.65 让近白的雾色
       往天上多铺一点，`fog-ground-blend` 抬到 0.75 让雾和地面交界更"化开"。
       **没验**：MapLibre 文档写着 `fog-color` 需要 **3D 地形**（"Requires 3D terrain"），
          而**没接 terrain** ⇒ 这圈雾带到底画不画得出来，**没有真机图不敢说**。
          真正一定生效的是 `sky-color`/`horizon-color` 那条天空渐变（天空层本身）。 */
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.65,
    "atmosphere-blend": 0.85,
    "fog-ground-blend": 0.75
  },
  bg: "#E8F8FF",
  // 近白兜底：`sky` 万一没生效，背景也不会是黑的
  sources: {
    /* 「亮灰底图」而不是卫星：卫星照片再调都是**写实**，跟平涂天生打架。
       实测这套服务 z14/z16 是**真内容**（7265/5753B，亮度 0.937），z17 变 2521B 占位图
       ⇒ 所以 maxzoom 必须钉在 16（让地图库放大复用 z16，别去要占位图）。 */
    base: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      ],
      maxzoom: 16,
      attribution: "Sources: Esri, HERE, Garmin, © OpenStreetMap contributors"
    },
    hi: null,
    // ← 二次元**没有高分层**（不用卫星）。少一层 = 少一份流量，低端档也轻松
    ref: {
      /* 注记要和底图配套：亮底必须用**浅灰系列**的注记（深字），
         继续用 `Dark_Gray_Reference`（浅字）会变成"白字压白底"= 等于没字。
         实测（涪陵 z16）：这套注记瓦片是 **872B 全透明**（那个点位本来就没标注）
         ⇒ "有没有字"这件事**这一轮没验成**，别当成"标签已修好"。 */
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
      ],
      maxzoom: 16
    }
  },
  raster: {
    /* 底图源本身已经 0.937（很亮），所以这里**不再上提**，只用对比度拉一点层次：
       0.937 →(对比度 0.08, 绕 0.5)→ 0.975 →(×0.96 压一点点)→ **0.936**。
       为什么要压：不压的话地面跟最亮的楼（`#E8F6FF`）一样白，画面会"过曝"。
       色罩再叠上去 → 最终地面 **0.919**（见 `tint` 的注释）。 */
    base: {
      /* 二轮：亮度**拉满到 1.0**（上一版 0.96 还压着一档）、对比再降一点（更平更干净）、
         彩度 0.15 → 0.55。底图是灰度的，"加彩度"加不出颜色来（灰上加饱和还是灰）——
         真正给地面**上色**的是下面那层 `tint`；这里加彩度是为了让瓦片里本来就有色的部分
         （绿地/水面在灰度图里也带一点点色偏）更明显。 */
      "raster-opacity": 1,
      "raster-saturation": 0.55,
      "raster-contrast": 0.06,
      "raster-brightness-max": 1
    },
    hi: null,
    ref: { "raster-opacity": 0.85 }
  },
  /* 色罩：`background` 图层 + **冷青** + 0.55 不透明度（2026-10-10 之前是 0.45 的 `#BCE7F8`）。
       "去灰"靠的就是这一层：底图是灰的，**只有盖颜色才上得了色**
       （在灰度上做色相旋转是空操作）。
  
       2026-10-10 客观硬伤修复（依据 `world-map/ART-PLAYBOOK.md` §1.1 的明度阶梯 + §8 第 3 条）：
         旧值坏在哪（现算，不是感觉）：地面合成色 `#DCEFF7` 的 CIE L* = **93.3**，而矮楼
           `#BCE4F9` = 88.5、中楼 `#A2D8F6` = 83.7 ⇒ **楼比脚下的地面暗**，对比只有 1.14:1 / 1.30:1
           （WCAG 1.4.11 对非文字图形要求 ≥ 3:1）。明度阶梯一塌，楼能"立起来"就只剩 1.8px 描边
           这一条边缘线索 —— 这是"静态图片感"的机制，不是审美分歧。
         新值算式（自检直接跑公式，不认嘴）：底图 0.937 →(对比度 0.06)→ 0.965 →(×1.0)→ 0.965，
           再叠 55% 的 `#8FC3DA`（伽马亮度 0.728）⇒ 地面 = 0.965×0.45 + 0.728×0.55 = **0.8345**，
           合成色 `#BDDAE7`、**CIE L* = 85.4**（落进目标带 84~87，旧值 93.3 在带外）。
         注意：地面**变暗**了，这推翻了 2026-09-20 那轮"整体更亮（地面 ≥0.92）"的口径 ——
           那一轮的判据已按新基准改写（自检里那条钉的是 84~87 这条带，不是"越亮越好"）。
  
       A/B 逃生口（改前那套配色仍可取到）：`?wstheme=anime-old`
         （`parseWsMapThemeParam` 认这个 id，取到的是 `ANIME_OLD` —— 地面回到 L* 93.3 / `#DCEFF7`、
          色阶回到改前那 8 档）。
         可达范围要如实说：App 侧（`WsDistrictMapLibre` 的 `resolveThemeId`）走 URL 参数这条路可用；
         代拍页 `public/ws3dshow.html` 的主题 id 白名单是写死的 `night|anime`（那一页不在本轮改动范围）
         ⇒ 在那一页上要 A/B 得先给它的白名单补一个 id。 */
  tint: { color: "#8FC3DA", opacity: 0.55 },
  /* 平涂分档：矮 → 中 → 高（高楼**更白更亮**，像 BA 里打了高光的塔楼）。
  
       2026-10-10 客观硬伤修复（依据 `ART-PLAYBOOK.md` §1.4 + §8 第 4 条）——旧色阶两个硬伤：
         ① **重复档**：`[3]` 与 `[45]` 是同一个 hex `#BCE4F9` ⇒ 3 层楼和 15 层楼一个颜色；
         ② **非单调**：L* 88.5 → 85.7 → 83.7 → 88.5 → 93.0 → …，中段往下走，
            "越高越亮"这个语义被自己打断（而且最暗的 25m 档 0.810 **比地面 0.834 还暗**）。
  
       新色阶的口径（全部能在本机用 `node ws_map_theme_selftest.mjs` 复算，不靠观感）：
         · **8 档严格单调**：CIE L* 86.7 → 100.0、伽马亮度 0.845 → 1.000，逐档递增；
         · **无重复 hex**；彩度逐档下降（0.282 → 0.000），读起来就是"越高越白"；
         · **相邻档最小可辨差**：ΔL* ≥ 1.7 **且** CIE76 ΔE*ab ≥ 3.0（现测 1.77 / 3.20）。
           为什么口径不是 ΔL* ≥ 3：8 档有 7 个间隔，可用的明度区间只有地面到纯白
           （L* 85.4 → 100 = 14.6）⇒ 均匀步长的数学上限是 14.6 / 7 = **2.09**（实测 1.77 是因为
           8 位色只有 256 级，取不到理想的均匀点）；ΔL* ≥ 3 需要跨度 21，**做不到**。
           真正以**硬边色块**出现在屏幕上的那三档（`wsGameLook` 抽 pick(0)/pick(2)/pick(5)）
           另守 ΔL* ≥ 3（现测 3.87 / 5.63）。
         · **最低档仍在地面之上**：0.845 / 地面 0.834 = **1.013 倍**（旧值最暗档是 0.810，比地面暗）；
         · 档数与高度停靠点**一个都没动**（仍是 8 档 / 3,12,25,45,70,110,200,320）⇒
           派生件（`?look=2` 的 cel 三档、预渲染瓦片取色位置）逐字不变。
       A/B 逃生口：`?wstheme=anime-old`（口径与可达范围见上面 `tint` 那段注释）。 */
  /* 2026-10-18：**整族压深一档**（原来最暗 86.7、最亮 100，与地面 85.4 几乎零差 ⇒ 屏上发白、
     楼与地分不开）。现在 53→80：比地面（85.4）暗 5–32，楼"立"得起来；
     色相仍在同一蓝族里，8 档/停靠点不动（派生件不必重算）。 */
  ramp: [
    [3, "#5E88B0"],
    [12, "#6A93B9"],
    [25, "#78A0C4"],
    [45, "#86ADCF"],
    [70, "#95BAD9"],
    [110, "#A5C8E4"],
    [200, "#B5D6EE"],
    [320, "#C6E3F7"]
  ],
  roofFallback: "#7FA0BE",
  /* 屋顶压顶在 BA 风里**不能压暗**（那套做法是写实的"女儿墙"）——
     改成**更浅**的一档，读起来就是"楼顶被光照到"，还是平涂。 */
  antennaFallback: "#C6E3F7",
  /* 描边：**二轮加重**（用户 ③）—— 1.2px → **1.8px**、颜色更深（`#2C4A63` → `#1B3550`）。
     为什么敢加重：BA 风里**这是楼与地的主要分隔手段**（加重时地面 0.924 本来就比矮楼亮，
     明度差是负的）⇒ 描边越清楚，"楼立起来"的感觉越强。自检按 WCAG 1.4.11
     （非文字图形 ≥ 3:1）算：**加重当时**对地面是 10.6:1；
     2026-10-10 地面压到 L* 85.4（`#BDDAE7`）之后是 **8.6:1**（自检钉 ≥5:1）—— 余量仍然很大，
     所以"再重一点"直接调 `outline.width` 到 2.2 也不会糊成一片。 */
  outline: { color: "#1B3550", width: 1.8 },
  /* AI 示意层：水体换成**明亮青蓝**（用户 ④"水体换色"），公园淡绿。
     只有"示意水体"能这么染；**真实江面在灰度底图里，染不了**（见 `ai` 字段的说明）。
     2026-09-29 透明度 **0.5 → 0.8**：真机报「江没变化」——
     查出来是两件事叠加：① `wsGwLayer` 有个并发 bug（`null.cellSize`）让水/绿层**每轮都不画**（已修）；
     ② 就算画出来，alpha 0.5 压在这层浅青地面上合成色 ≈ `#92DAF3`、对地对比度只有 **1.30**
     （观感审计算过：0.8 ⇒ `#6FC1E7`、**1.61**；更深的 `rgba(56,150,200,.8)` ⇒ 2.0）。
     ⇒ 现在换成 0.8（**只动透明度、不动色相**，与"二次元浅底"方向不冲突）。
     注：这条同时影响"示意水体"与 gw 真水（**两处用的是同一个 `ai.water`**）——真水是 OSM 多边形、
     样式仍与示意件可区分（示意件另有暖色调与描边口径），没有把示意混成事实。 */
  ai: { park: "rgba(126, 200, 138, 0.60)", water: "rgba(46, 158, 214, 0.92)" },
  /* 2026-10-04 地图是**纯色**的，观感差——
     推翻的就是本节原来那条「治地面太糊 ⇒ z13.6 起淡出、z14.8 起完全不用照片」。
     旧值坏在哪：小区级**默认机位 z16.4** 早就过了 `to=14.8` ⇒ 底图整层 `raster-opacity = 0`
     ⇒ 屏上只剩 `bg` + `tint` 合成出来的**单色地面**（≈ `#D4F0FC`，亮度 0.921、**方差 0**）——
     屏幕上的那块"纯色"就是它，不是瓦片坏、也不是取色错。
     现在把窗口整体抬到**源的真实细节上限之上**：
       · `from = 16.6` ⇒ z ≤ 16.6 底图**全不透明**（默认机位 16.4 落在里面 ⇒ 真瓦片回来了）；
       · `to = 18.0`  ⇒ 只在**放大复用区**（源 maxzoom = 16，z17 起是 2~4 倍拉伸，那一段才是真会糊的）
                        淡出；终点处与 `bg`+`tint` 单色的亮度**只差 0.002** ⇒ 不"咔"一下跳色
                        （`tint` 的不透明度就是为这件事定的；自检里有一条钉这个 Δ）。
     `to = 18` **只影响 `raster-opacity` 这一条表达式**：底图源的取瓦片上限由 `baseMaxZoomFor`
        夹在 **16**（= 主题自己声明的 `sources.base.maxzoom`）⇒ **永远不去要 z17 那张 2521B 占位图**。
     观感（瓦片够不够清楚、和自己的矢量路网叠一起会不会花）**只能在真机上判**；
        这里就是**一对常量**：他说"再淡一点 / 再清楚一点"，只动这一行，别的都不用碰。 */
  baseFade: { from: 16.6, to: 18 },
  /* 路网：浅底那一套 —— **路芯近白 + 蓝灰描边**（BA/地图 App 的常见做法：
     靠描边把路"勾"出来，而不是靠路芯比地面亮）。描边比地面暗一档 ⇒ 看得见。
     2026-10-02 用户「**道路清晰**」这一刀：**只动下面两个值**（幅度按"一档"取，保守）——
       · `casing` `#8FBBD4` → `#6FA6C8`：对地面 `#DCEFF7` 的伽马亮度差 **0.220 → 0.309**、
         WCAG 对比 **1.73:1 → 2.23:1**（2026-10-10 地面压到 L* 85.4 之后同样是 Δ=0.220 /
          **1.80:1** —— 结论不变：描边仍比地面暗一档，且过自检钉的 ≥1.5:1）；描边是这条路上唯一"勾边"的手段，它越清楚路越好读。
       · `casingOpacity` **0.9 → 0.95**：压掉描边与底图混出来的那层灰。
       路芯（`rankColors`）2026-10-02 没动（当时这条要求只管"更清晰"）；
       2026-10-17 的明度结构 pass 才把它压进 88–92 带（见下面 `rankColors` 的注释）。
       **路网这几个值都是预渲染瓦片配色指纹的输入**（`wsPrerenderPalette` → 管线 `load_theme`）
          ⇒ 改了就必须重跑 离线数据生成脚本 重画瓦片；漏跑会让
          `ws_lod_selftest` / `ws_prerender_selftest` 的**指纹对拍变红**（那是刻意的抓手）。
          （2026-10-01 这条改过一次又撤回：重跑时 Overpass 全线 504 ⇒ 清单自报 `roads=0`，
           整次重跑作废。本轮 Overpass 已恢复，瓦片随主题一起重画。） */
  road: {
    casing: "#6FA6C8",
    casingOpacity: 0.95,
    rankColors: {
      /* 2026-10-17 明度结构 pass（`ART-PLAYBOOK.md` §1.1③）：rank0 `#FFFFFF` = L* 100 是全屏
         最亮的一档（地面 85.4 之上 +14.6），手册给路芯的目标带是 **88–92**（地面 +3~+6）。
         ⇒ rank0 压到 `#DAEAF6` = **L* 91.9**，rank1..4 **同向下移**收进带内（91.1/90.0/89.2/88.7），
         逐档仍递减、rank4 仍高于地面 +3.3 L*。**rank5 不动**（干线强调色，手册 §2.4 第 7 条）。 */
      0: "#DAEAF6",
      1: "#D6E8F5",
      2: "#D2E5F4",
      3: "#CEE3F3",
      4: "#CBE2F2",
      5: "#7FD4F0"
    }
  },
  /* 2D 降级路：底色取**和 3D 地面同一个色**（`#BDDAE7`，就是 `groundHex(anime)` 算出来的那个；
     色罩改过一次，这里**必须跟着改** —— 自检钉的就是"两条路同色"，不然低端机是另一个世界），
     描边取和 3D 同族的深藏青 —— 这样低端机看到的和满血机是"同一座城"，
     而不是"浅蓝界面 + 黑地图"。 */
  canvas: {
    bg: "#BDDAE7",
    empty: "rgba(27,53,80,.75)",
    bldStroke: "#1B3550",
    bldStrokeW: 1.2,
    aiShadow: "rgba(44,74,99,.22)",
    aiStroke: "rgba(27,53,80,.5)",
    aiStrokeW: 0.8
  },
  verticalGradient: false,
  // ← 平涂的关键：关掉竖向渐变，楼是一块纯色板
  extrudOpacity: ["interpolate", ["linear"], ["zoom"], 12.8, 0.8, 15, 0.92, 17, 1],
  low: {
    dropSky: true,
    /* 这里和任务书"低端关描边"**故意不一致**，理由要写清楚：
       色区别的是楼与地，靠描边当主要线索（2026-10-10 地面压暗后楼比地亮了，
       但明度差仍不足 WCAG 的 3:1，见自检里那组对比度）⇒ **描边仍是主分隔手段**。
       低端档真把描边关了，楼会整片"化"进地面（比掉几帧难看多了）。
       所以低端只把它**变细到 0.6px**（同样是一条 line 层，要素数没变，省的是像素填充）。 */
    outlineWidth: 0.6,
    dropTint: true
  },
  measuredLuma: { base: 0.937, hi: null },
  /** 二次元：明度比这条不变量**不设阈值**（1.0 = 只要不比地暗就行）。
      2026-10-10 之后它不再是空条件：色阶最低档 0.845 / 地面 0.834 = **1.013**，
      真正在承重（改回旧色阶那版 0.810 会直接跌破 1.0）。 */
  minGroundContrast: 1
};
var ANIME_OLD = {
  ...ANIME,
  id: "anime-old",
  label: "二次元（改前配色，A/B 用）",
  hud: "二次元 · 平涂（改前配色）",
  tint: { color: "#BCE7F8", opacity: 0.45 },
  ramp: [
    [3, "#BCE4F9"],
    [12, "#AEDDF7"],
    [25, "#A2D8F6"],
    [45, "#BCE4F9"],
    [70, "#D6EFFC"],
    [110, "#EBF7FE"],
    [200, "#F6FCFF"],
    [320, "#FFFFFF"]
  ]
};
function baseMaxZoomFor(theme) {
  const f = theme && theme.baseFade;
  if (!f || typeof f.to !== "number" || !Number.isFinite(f.to)) return void 0;
  const want = Math.ceil(f.to);
  const cap = theme && theme.sources && theme.sources.base ? theme.sources.base.maxzoom : void 0;
  return typeof cap === "number" && Number.isFinite(cap) && cap < want ? cap : want;
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
  const baseCap = baseMaxZoomFor(theme);
  const baseSrc = sources.base;
  if (baseCap !== void 0 && (typeof baseSrc.maxzoom !== "number" || baseCap < baseSrc.maxzoom)) baseSrc.maxzoom = baseCap;
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
      /* 高 zoom 淡出（原来的理由「治地面太糊」，2026-10-04 用户**推翻**：他要看得见底图）：
         二次元的亮灰底图**最高只到 z16**，z17~18 就是"把 z16 放大 2~4 倍" ⇒ 那一段才是真会糊的。
         所以窗口抬到 `16.6 → 18.0`：**默认机位 16.4 处底图全不透明**（真瓦片回来了，不再是一块纯色），
         只在放大复用区淡出，终点处露出 `bg` + `tint` 合成的浅青地面 + 自己的路网/楼体（矢量，任何缩放都锐利）。
         `baseFade` 只覆盖 `raster-opacity` 这一个字段，**不动**主题里写的
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

// src/components/views/worldsim/wsArtParams.ts
var WS_ART_RAMP_HI = ["#CFEDFF", "#E2F6FF", "#F2FCFF", "#FFFFFF"];
var WS_BLD_FALLBACK_RAMP = [
  [3, "#23323e"],
  [8, "#2d4356"],
  [16, "#3a586f"],
  [30, "#4a7290"],
  [60, "#5f93b0"],
  [110, "#7fbcd4"],
  [200, "#b6e2f2"],
  [320, "#e8f7ff"]
];
var WS_BLD_FALLBACK_OUTLINE = { color: "rgba(190,235,255,0.22)", width: 0.5 };
var WS_BLD_FALLBACK_OPACITY = 0.97;
var WS_BLD_OUTLINE_STOPS = [
  [13, 0.5],
  [15, 1.6],
  [16.5, 3.4],
  [18, 4.2]
];
var WS_ART_PATCHES = [
  /* art=3：底图整体往"水青"推（**没有水系矢量数据** —— 河/湖是栅格底图里的像素，
     所以只能调 raster 的整体饱和度/亮度，**不能假装给水体单独上色**） */
  { id: "base", key: "raster-saturation", art2: 0.34, art3: 0.6, why: "底图更青（**保守**：0.72 洗掉了路与注记）" },
  { id: "base", key: "raster-brightness-max", art2: 0.98, art3: 0.94, why: "底图更亮但**不顶到 1**（顶到 1 吃掉层次）" },
  { id: "tint", key: "background-color", art2: "#EEF9FF", why: "地面色罩更近白" },
  { id: "tint", key: "background-opacity", art2: 0.5, why: "色罩**保守值**：0.8 会把地面糊成一片白" },
  { id: "bg", key: "background-color", art2: "#F7FCFF", why: "底色更亮" },
  { id: "base", key: "raster-opacity", art2: 0.52, why: "照片更淡但**底图承载路与注记**：0.32 就「没有路」了" }
];
function parseArtParam(search) {
  const s = String(search ?? "");
  if (/[?&]art=3\b/.test(s)) return 3;
  if (/[?&]art=2\b/.test(s)) return 2;
  return 1;
}
function parseLookParam(search) {
  const s = String(search ?? "");
  return /[?&]look=2\b/.test(s) ? 2 : 1;
}
function lookIdOf(look) {
  return look === 2 ? "game" : null;
}
function artRamp(ramp, art) {
  if (art !== 2 || !ramp || !ramp.length) return ramp;
  const r = ramp.map((p) => [p[0], p[1]]);
  const hi = WS_ART_RAMP_HI;
  for (let i = 0; i < hi.length && i < r.length; i++) r[r.length - 1 - i][1] = hi[hi.length - 1 - i];
  return r;
}
function outlineWidthAt(z) {
  const st = WS_BLD_OUTLINE_STOPS;
  if (z <= st[0][0]) return st[0][1];
  for (let i = 1; i < st.length; i++) {
    if (z <= st[i][0]) {
      const [z0, w0] = st[i - 1], [z1, w1] = st[i];
      return +(w0 + (w1 - w0) * (z - z0) / (z1 - z0)).toFixed(2);
    }
  }
  return st[st.length - 1][1];
}
function outlineWidthExpr() {
  const out = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, w] of WS_BLD_OUTLINE_STOPS) out.push(z, w);
  return out;
}
function bldRampColorExpr(stops, ramp, look) {
  if (look === 2 && ramp && ramp.length >= 2) {
    const out = ["step", ["get", "h3d"], ramp[0][1]];
    for (let i = 1; i < ramp.length; i++) out.push(ramp[i][0], ramp[i][1]);
    return out;
  }
  return ["interpolate", ["linear"], ["get", "h3d"], ...stops];
}
function artPatchValueOf(row, art) {
  if (art < 2) return null;
  return art === 3 && row.art3 !== void 0 ? row.art3 : row.art2;
}
function bldArtParamsOf(theme, opts) {
  const art = opts?.art ?? 1;
  const look = opts?.look ?? 1;
  const fallbackRamp = opts?.fallbackRamp ?? WS_BLD_FALLBACK_RAMP;
  const ramp = artRamp(theme && theme.ramp || fallbackRamp, art);
  const outline = theme && theme.outline || WS_BLD_FALLBACK_OUTLINE;
  const vgrad = theme ? theme.verticalGradient : true;
  const opacity = theme && theme.extrudOpacity || WS_BLD_FALLBACK_OPACITY;
  const stops = [];
  for (const [h, c] of ramp) stops.push(h, c);
  return {
    art,
    look,
    ramp,
    /* **原样透传**（不补默认值）：页面旧实现就是 `THEME?.outline || 兜底` 两步，
       这里多补一次 `??` 就会让"主题缺 width"时与旧实现不同 ⇒ 逐字段对拍会红。 */
    outline,
    vgrad,
    opacity,
    stops,
    lineWidth: art >= 2 ? outlineWidthExpr() : outline.width,
    rampColor: bldRampColorExpr(stops, ramp, look)
  };
}

// src/components/views/worldsim/wsMvtPaint.ts
function swapField(expr, from, to) {
  if (Array.isArray(expr)) {
    if (expr.length === 2 && expr[0] === "get" && expr[1] === from) return ["get", to];
    return expr.map((x) => swapField(x, from, to));
  }
  return expr;
}
function colorExpr(rampExpr) {
  return ["coalesce", ["to-color", ["get", "c"]], rampExpr];
}
function extrusionPaint(opts) {
  return {
    "fill-extrusion-height": ["coalesce", ["get", "h"], 8],
    "fill-extrusion-base": ["coalesce", ["get", "hb"], 0],
    "fill-extrusion-opacity": typeof opts.opacity === "number" ? opts.opacity : 0.95,
    "fill-extrusion-vertical-gradient": !!opts.vgrad,
    "fill-extrusion-color": colorExpr(opts.rampExpr)
  };
}
function footPaint(opts) {
  return { "fill-color": colorExpr(opts.rampExpr), "fill-opacity": opts.opacity };
}
function outlinePaint(opts) {
  return {
    "line-color": opts.color === void 0 || opts.color === null ? colorExpr(opts.fallbackRamp) : opts.color,
    "line-width": opts.width === void 0 || opts.width === null ? 0.6 : opts.width
  };
}

// src/components/views/worldsim/wsBldDetailTiers.ts
var WS_BLD_DETAIL_ROOF_ZOOM = 14;
var WS_BLD_DETAIL_EQUIP_ZOOM = 16;
var BLD_PART_TIER = Object.freeze({
  body: 0,
  podium: 0,
  tower: 0,
  setback: 0,
  roof: 1,
  parapet: 1,
  equip: 2,
  antenna: 2
});
function bldTierOfPart(part) {
  const t = BLD_PART_TIER[String(part ?? "")];
  return t === 0 || t === 1 || t === 2 ? t : 0;
}
var WS_BLD_VECTOR_MINZOOM_MIRROR = 11;
function bldDetailTierZoom(tier) {
  if (tier === 0) return WS_BLD_VECTOR_MINZOOM_MIRROR;
  if (tier === 1) return WS_BLD_DETAIL_ROOF_ZOOM;
  if (tier === 2) return WS_BLD_DETAIL_EQUIP_ZOOM;
  return null;
}
function bldLayerVisibilityAt(minzoom, maxzoom, z) {
  const lo = typeof minzoom === "number" && isFinite(minzoom) ? minzoom : 0;
  const hi = typeof maxzoom === "number" && isFinite(maxzoom) ? maxzoom : Infinity;
  const zz = typeof z === "number" && isFinite(z) ? z : 0;
  return zz >= lo && zz < hi ? "visible" : "none";
}
function bldPartsVisibleAt(parts, z) {
  const out = [];
  for (const p of parts) {
    const t = bldTierOfPart(p);
    const mz = bldDetailTierZoom(t);
    if (mz === null) continue;
    if (bldLayerVisibilityAt(mz, null, z) === "visible") out.push(String(p));
  }
  return out;
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
    /* 默认档位 = `base`（App 侧不传 opts ⇒ 行为与这一版之前**逐字节相同**）。
       `roof` = 默认档的屋顶系（2026-10-02 B1）；`detail` 只在代拍页 `?bld=2` 打开。 */
    mode: opts.mode === "detail" ? "detail" : opts.mode === "roof" ? "roof" : "base",
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
  for (const [stop2, col] of ramp) if (h >= stop2) c = col;
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
    /* `zt` = 这个体块属于哪一档（0 一直画 / 1 z≥14 女儿墙 / 2 z≥16 设备箱+天线）。
       写进属性而不是在图层的 filter 里拼表达式 —— 表达式报错是静默的（见文件头）。 */
    properties: { ...src.properties || {}, part, zt: bldTierOfPart(part), h3d: top, h_base: base, color3d: color, ...extra },
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
      zt: bldTierOfPart("body"),
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
  if ((opts.mode ?? "base") === "roof") {
    const parts2 = [body];
    const topH2 = base + h;
    if (h >= PARAPET_MIN_H) {
      const fm = footprintMetrics(ring);
      const t = Math.max(0.2, Math.min(PARAPET_THICK_M, fm.minSideM * 0.18));
      parts2.push(partFeature(f, ringBand(ring, insetRingMeters(ring, t)), topH2, topH2 + PARAPET_H, "parapet", shade(color, 1.08), { wallThickM: +t.toFixed(2), win: 0 }));
      const eq = equipBoxes(ring, seed, topH2);
      info.equipWanted = eq.wanted;
      info.equipPlaced = eq.boxes.length;
      info.equipSkipped = eq.skipped;
      for (let i = 0; i < eq.boxes.length; i++) {
        const b = eq.boxes[i];
        parts2.push(partFeature(f, b.ring, b.base, b.top, "equip", shade(color, 0.72), { side: b.side, idx: i, win: 0 }));
      }
    }
    if (h >= ANTENNA_MIN_H) {
      parts2.push(partFeature(f, antennaRing(ring), topH2, topH2 + ANTENNA_M, "antenna", shade(color, 1.25), { win: 0 }));
    }
    return { parts: parts2, info };
  }
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
    /* `clear` 必须**连来源键一起清**：`has` 的语义现在是"仓库里确实还有这一格的要素"
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

// src/components/views/worldsim/wsBldBudget.ts
var WS_BLD_BUDGET_PX2 = 4e5;
var WS_BLD_BUDGET_VERTS = 4e4;
var WS_BLD_MAX_DRAWN = 6;
var WS_BLD_MAX_DRAWN_MANY = 4e3;
var WS_BLD_NEAR_K = 10;
var WS_BLD_WALK_K = 10;
var WS_BLD_WALK_BUF_MAX = 80;
function bldWalkKOf(walkK) {
  const n = Number(walkK);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
var WS_BLD_FOOTPRINT_MAXZOOM = WS_BLD_DETAIL_ROOF_ZOOM;
var WS_BLD_TIER_HYSTERESIS = 0.25;
function bldTierOfZoom(zoom, prevTier) {
  const v = typeof zoom === "number" && isFinite(zoom) ? zoom : NaN;
  if (!isFinite(v)) return null;
  const line = WS_BLD_FOOTPRINT_MAXZOOM;
  if (prevTier === 0) return v < line + WS_BLD_TIER_HYSTERESIS ? 0 : 1;
  if (prevTier === 1) return v < line - WS_BLD_TIER_HYSTERESIS ? 0 : 1;
  return v < line ? 0 : 1;
}
function bldNearKOf(nearK) {
  return nearK === void 0 || nearK === null ? WS_BLD_NEAR_K : Number.isFinite(Number(nearK)) ? Math.max(0, Math.floor(Number(nearK))) : WS_BLD_NEAR_K;
}
function bldMaxDrawnOf(mode) {
  return mode === "many" ? WS_BLD_MAX_DRAWN_MANY : WS_BLD_MAX_DRAWN;
}
function bldKPinOf(search) {
  const m = /[?&]k=(\d+)\b/.exec(String(search || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
function bldResolvedCellDeg(cellDeg) {
  const v = Number(cellDeg);
  return Number.isFinite(v) && v > 0 ? v : BLD_BUNDLE_CELL_DEG;
}
var WS_BLD_VERTS_PER_SEGMENT = 4;
function bldRingVertices(ringPoints) {
  const n = Number(ringPoints);
  if (!isFinite(n) || n < 4) return 0;
  return 5 * (n - 1);
}
function bldMetersPerCssPixel(zoom, lat) {
  const z = isFinite(zoom) ? zoom : 0;
  const la = isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
  return 40075016686e-3 / 512 * Math.cos(la * Math.PI / 180) / Math.pow(2, z);
}
function bldPxPerMeter(zoom, lat, pitchDeg) {
  const mpp = bldMetersPerCssPixel(zoom, lat);
  if (!(mpp > 0)) return 0;
  const p = isFinite(pitchDeg) ? Math.max(0, Math.min(85, pitchDeg)) : 0;
  return Math.sin(p * Math.PI / 180) / mpp;
}
function outerRingOf(f) {
  const g = f?.geometry;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = g.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}
function h3dOf(f) {
  const p = f?.properties || {};
  const h = Number(p.h3d);
  return isFinite(h) && h > 0 ? h : 0;
}
function readFirstPoint(f) {
  const c = f?.geometry?.coordinates;
  let cur = c;
  for (let i = 0; i < 6 && Array.isArray(cur); i++) {
    if (typeof cur[0] === "number" && typeof cur[1] === "number") return cur;
    cur = cur[0];
  }
  return null;
}
function bldScreenCost(f, ctx, outCost) {
  const ring = outerRingOf(f);
  if (!ring) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    let xy;
    try {
      xy = ctx.project(lng, lat);
    } catch {
      continue;
    }
    const x = Number(xy[0]), y = Number(xy[1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return null;
  const w = x1 - x0, h = y1 - y0;
  const h3d = h3dOf(f);
  const ppm = isFinite(ctx.pxPerMeter) && ctx.pxPerMeter > 0 ? ctx.pxPerMeter : 0;
  const roofPx = w * h;
  const wallPx = (w + h) * (h3d * ppm);
  const verts = bldRingVertices(ring.length);
  const cost = {
    id: String(f?.id ?? ""),
    roofPx,
    wallPx,
    px: roofPx + wallPx,
    verts,
    ringPoints: ring.length,
    h3d
  };
  if (outCost) outCost.v = cost;
  return cost;
}
var WS_BLD_M_PER_DEG_LNG = 111320;
var WS_BLD_M_PER_DEG_LAT = 110540;
var staticMemo = /* @__PURE__ */ new WeakMap();
function bldDrawHeightOf(f) {
  const h = h3dOf(f);
  if (h > 0) return h;
  try {
    const r = renderHeight(f?.properties);
    return r && isFinite(r.h) && r.h > 0 ? r.h : 0;
  } catch {
    return 0;
  }
}
function bldStaticMeasureOf(f) {
  const ring = outerRingOf(f);
  if (!ring) return null;
  const key = f;
  if (key && typeof key === "object") {
    const hit = staticMemo.get(key);
    if (hit) return hit;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, latSum = 0, lngSum = 0, n = 0;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (lng < x0) x0 = lng;
    if (lng > x1) x1 = lng;
    if (lat < y0) y0 = lat;
    if (lat > y1) y1 = lat;
    latSum += lat;
    lngSum += lng;
    n += 1;
  }
  if (!(x1 >= x0) || !(y1 >= y0) || n === 0) return null;
  const kx = WS_BLD_M_PER_DEG_LNG * Math.cos(latSum / n * Math.PI / 180);
  const wM = (x1 - x0) * kx;
  const hM = (y1 - y0) * WS_BLD_M_PER_DEG_LAT;
  const h3d = bldDrawHeightOf(f);
  const m = {
    score: h3d * (wM * hM),
    wM,
    hM,
    h3d,
    ringPoints: ring.length,
    cLng: lngSum / n,
    cLat: latSum / n
  };
  if (key && typeof key === "object") staticMemo.set(key, m);
  return m;
}
function bldStaticScoreOf(f) {
  const m = bldStaticMeasureOf(f);
  return m ? m.score : null;
}
function bldStaticOrderCompare(aScore, aId, bScore, bId) {
  return bScore !== aScore ? bScore - aScore : aId < bId ? -1 : aId > bId ? 1 : 0;
}
function bldStaticScreenCost(m, id, mpp, pxPerMeter) {
  const canPx = isFinite(mpp) && mpp > 0;
  const w = canPx ? m.wM / mpp : 0;
  const h = canPx ? m.hM / mpp : 0;
  const ppm = isFinite(pxPerMeter) && pxPerMeter > 0 ? pxPerMeter : 0;
  const roofPx = w * h;
  const wallPx = (w + h) * (m.h3d * ppm);
  return {
    id,
    roofPx,
    wallPx,
    px: roofPx + wallPx,
    verts: bldRingVertices(m.ringPoints),
    ringPoints: m.ringPoints,
    h3d: m.h3d
  };
}
function pickBuildingsByBudget(input) {
  const feats = input.features || [];
  const budgetPx2 = Number.isFinite(input.budgetPx2) ? Number(input.budgetPx2) : WS_BLD_BUDGET_PX2;
  const budgetVerts = Number.isFinite(input.budgetVerts) ? Number(input.budgetVerts) : WS_BLD_BUDGET_VERTS;
  const maxDrawn = Number.isFinite(input.maxDrawn) ? Math.max(0, Math.floor(Number(input.maxDrawn))) : WS_BLD_MAX_DRAWN;
  const cellDeg = bldResolvedCellDeg(input.cellDeg);
  const minInView = Number.isFinite(input.minInView) ? Math.max(0, Number(input.minInView)) : 0;
  const b = input.bounds;
  const mpp = Number.isFinite(input.screen?.metersPerPixel) && input.screen.metersPerPixel > 0 ? Number(input.screen.metersPerPixel) : 0;
  const ppm = Number.isFinite(input.screen?.pxPerMeter) && input.screen.pxPerMeter > 0 ? Number(input.screen.pxPerMeter) : 0;
  const stats = {
    total: feats.length,
    cells: 0,
    cellsChosen: 0,
    cellKeys: [],
    considered: 0,
    outOfView: 0,
    viewCounted: false,
    noRing: 0,
    chosen: 0,
    px2: 0,
    verts: 0,
    px2Budget: budgetPx2,
    vertsBudget: budgetVerts,
    px2Bound: false,
    vertsBound: false,
    countBound: false,
    cellsCapped: 0,
    maxDrawn,
    cellDeg,
    gateDropped: 0,
    staticMpp: mpp,
    minInView,
    floorAdded: 0,
    /* 补齐件那几个数**在字面量里就有初值**（第七条起多了 `nearAnchors` / `nearRestored` /
       `nearAddedPerAnchor`）：① 关掉时逐字节等于改动前；② 影子对拍（把补齐件整段抠掉再编译）
       两边都带这几个字段 ⇒ 对拍比的仍是"同一份形状"。 */
    nearAnchors: 0,
    nearAdded: 0,
    nearRestored: 0,
    nearPicked: 0,
    nearAddedPerAnchor: [],
    nearDistM: null,
    /* 行走缓冲同理（关掉时逐字节等于改动前；影子对拍两边带同一份形状） */
    walkOn: false,
    walkRestored: 0,
    walkAdded: 0,
    walkDistM: null,
    walkScanned: 0,
    overBudget: false,
    why: ""
  };
  let w = 0, s = 0, e = 0, n = 0;
  if (b) {
    try {
      w = Number(b.getWest());
      s = Number(b.getSouth());
      e = Number(b.getEast());
      n = Number(b.getNorth());
      stats.viewCounted = [w, s, e, n].every((v) => isFinite(v));
    } catch {
      stats.viewCounted = false;
    }
  }
  const byCell = /* @__PURE__ */ new Map();
  const zeroCap = maxDrawn === 0;
  for (const f of feats) {
    const ring = outerRingOf(f);
    const p0 = ring ? ring[0] : readFirstPoint(f);
    if (stats.viewCounted) {
      const inView = !!p0 && p0[0] >= w && p0[0] <= e && p0[1] >= s && p0[1] <= n;
      if (!inView) stats.outOfView += 1;
    }
    if (!ring) {
      stats.noRing += 1;
      continue;
    }
    if (zeroCap) {
      stats.considered += 1;
      continue;
    }
    const m = bldStaticMeasureOf(f);
    if (!m) {
      stats.noRing += 1;
      continue;
    }
    stats.considered += 1;
    const id = String(f.id ?? "");
    const cell = bundleCellOf(m.cLng, m.cLat, cellDeg);
    const key = bundleCellKey(cell.w, cell.s, cellDeg);
    const cand = { f, c: bldStaticScreenCost(m, id, mpp, ppm), score: m.score, key };
    const arr = byCell.get(key);
    if (arr) arr.push(cand);
    else byCell.set(key, [cand]);
  }
  if (zeroCap && stats.considered > 0) stats.countBound = true;
  const cellKeys = [];
  for (const k of byCell.keys()) cellKeys.push(k);
  cellKeys.sort();
  const pool = [];
  const inK = [];
  for (const k of cellKeys) {
    const arr = byCell.get(k);
    arr.sort((A, B) => bldStaticOrderCompare(A.score, A.c.id, B.score, B.c.id));
    if (arr.length > maxDrawn) {
      stats.countBound = true;
      stats.cellsCapped += 1;
    }
    for (let i = 0; i < arr.length; i++) {
      pool.push(arr[i]);
      inK.push(i < maxDrawn);
    }
  }
  stats.cells = byCell.size;
  const chosen = [];
  const taken = new Array(pool.length).fill(false);
  let sumPx = 0, sumV = 0;
  for (let i = 0; i < pool.length; i++) {
    if (!inK[i]) continue;
    const c = pool[i];
    const overPx = sumPx + c.c.px > budgetPx2;
    const overV = sumV + c.c.verts > budgetVerts;
    if (overPx || overV) {
      if (overPx) stats.px2Bound = true;
      if (overV) stats.vertsBound = true;
      stats.gateDropped += 1;
      continue;
    }
    taken[i] = true;
    chosen.push(c);
    sumPx += c.c.px;
    sumV += c.c.verts;
  }
  if (chosen.length < minInView) {
    for (let i = 0; i < pool.length && chosen.length < minInView; i++) {
      if (taken[i]) continue;
      const c = pool[i];
      taken[i] = true;
      chosen.push(c);
      sumPx += c.c.px;
      sumV += c.c.verts;
      stats.floorAdded += 1;
    }
  }
  stats.chosen = chosen.length;
  stats.px2 = Math.round(sumPx);
  stats.verts = Math.round(sumV);
  stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;
  {
    const seen = /* @__PURE__ */ new Set();
    for (const c of chosen) if (!seen.has(c.key)) {
      seen.add(c.key);
      stats.cellKeys.push(c.key);
    }
    stats.cellsChosen = stats.cellKeys.length;
  }
  const bd = [];
  if (stats.px2Bound) bd.push("像素");
  if (stats.vertsBound) bd.push("顶点");
  stats.why = "格 " + stats.cells + " 个" + (stats.cellKeys.length > 1 ? "（" + stats.cellKeys[0] + " … " + stats.cellKeys[stats.cellKeys.length - 1] + "）" : stats.cellKeys.length === 1 ? "（" + stats.cellKeys[0] + "）" : "") + " ⇒ 画 " + stats.chosen + " 栋（" + stats.cellsChosen + " 格出楼） · 每格取前 " + maxDrawn + "（静态重要度 · 挑选与相机无关 · 0 次投影）" + /* 被 K 截过的格数如实报（"上限起作用了"要与"楼就这么少"分得开） */
  (stats.countBound ? " · 每格上限截过 " + stats.cellsCapped + " 格" : "") + " · Σ投影 " + stats.px2 + "px²/" + budgetPx2 + " · Σ顶点 " + stats.verts + "/" + budgetVerts + /* 安全闸：拦下来的**个数**也念出来（不许静默丢） */
  (bd.length ? " · 安全闸拦住过：" + bd.join("+") + "（跳过 " + stats.gateDropped + " 栋）" : " · 两个预算都没咬住") + (!(mpp > 0) ? " · ⚠️ 没给 metersPerPixel：px² 数不出来（只剩顶点预算在管）" : "") + (minInView ? " · 下限 " + minInView + " 栋" : "") + (stats.floorAdded ? " · 破例补 " + stats.floorAdded + " 栋（凑下限）" : "") + (stats.overBudget ? " · ⚠️ 已超预算（下限破例）" : "") + /* 视野：**只报不改**（数不出来时不写 0 冒充"视野外没有"） */
  (stats.viewCounted ? stats.outOfView ? " · 视野外 " + stats.outOfView + "（不影响挑选）" : "" : " · 视野计数：数不出来（没给视野）") + (stats.noRing ? " · 无外环 " + stats.noRing : "");
  {
    const nearKOn = bldNearKOf(input.nearK);
    const listRaw = input.nearAnchors;
    const listGiven = Array.isArray(listRaw) && listRaw.length > 0;
    const nc = input.nearCenter;
    const ncGiven = !!nc && typeof nc === "object";
    const raw = listGiven ? listRaw.slice() : ncGiven ? [nc] : [];
    if (nearKOn > 0 && raw.length > 0) {
      const anchors = [];
      let badN = 0;
      for (const a of raw) {
        const o = a;
        const ok = !!o && typeof o === "object";
        const lng = ok ? Number(o.lng) : NaN;
        const lat = ok ? Number(o.lat) : NaN;
        if (ok && isFinite(lng) && isFinite(lat)) {
          anchors.push({ lng, lat, frozenOnly: o.frozenOnly === true });
        } else badN += 1;
      }
      if (badN > 0) {
        stats.why += " · 就近补齐：数不出来（" + (listGiven ? "锚点 " + raw.length + " 个里有 " + badN + " 个不是有限坐标" : "相机中心不是有限数") + "）";
      } else {
        const frozenList = input.nearFrozen;
        const overBefore = sumPx > budgetPx2 || sumV > budgetVerts;
        const poolMeasure = pool.map((c) => bldStaticMeasureOf(c.f));
        const idSeen = /* @__PURE__ */ new Set();
        for (const c of chosen) if (c.c.id !== "") idSeen.add(c.c.id);
        const perAnchor = [];
        let added = 0, restored = 0, farM = 0, picked = 0;
        for (let ai = 0; ai < anchors.length; ai++) {
          const a = anchors[ai];
          const cosLat = Math.cos(a.lat * Math.PI / 180);
          const kx = WS_BLD_M_PER_DEG_LNG * (isFinite(cosLat) ? cosLat : 1);
          const cands = [];
          if (a.frozenOnly !== true) {
            picked += 1;
            for (let i = 0; i < pool.length; i++) {
              if (taken[i]) continue;
              const m2 = poolMeasure[i];
              if (!m2) continue;
              const dx = (m2.cLng - a.lng) * kx;
              const dy = (m2.cLat - a.lat) * WS_BLD_M_PER_DEG_LAT;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (!isFinite(d)) continue;
              cands.push({ cand: pool[i], i, d });
            }
            cands.sort((A, B) => A.d !== B.d ? A.d - B.d : A.cand.c.id < B.cand.c.id ? -1 : A.cand.c.id > B.cand.c.id ? 1 : 0);
          }
          const take = Math.min(nearKOn, cands.length);
          const batch2 = [];
          const seenObj = /* @__PURE__ */ new Set();
          for (let k = 0; k < take; k++) {
            const it = cands[k];
            seenObj.add(it.cand.f);
            batch2.push({ cand: it.cand, f: it.cand.f, i: it.i, d: it.d, frozen: false, c: it.cand.c, id: it.cand.c.id });
          }
          const fr = !Array.isArray(frozenList) ? null : frozenList[ai];
          if (Array.isArray(fr)) {
            for (const f of fr) {
              if (!f || typeof f !== "object" || seenObj.has(f)) continue;
              seenObj.add(f);
              const m2 = bldStaticMeasureOf(f);
              if (!m2) continue;
              const dx = (m2.cLng - a.lng) * kx;
              const dy = (m2.cLat - a.lat) * WS_BLD_M_PER_DEG_LAT;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (!isFinite(d)) continue;
              const id = String(f.id ?? "");
              batch2.push({ cand: null, f, i: -1, d, frozen: true, c: bldStaticScreenCost(m2, id, mpp, ppm), id });
            }
          }
          batch2.sort((A, B) => A.d !== B.d ? A.d - B.d : A.id < B.id ? -1 : A.id > B.id ? 1 : 0);
          perAnchor.push(0);
          for (const it of batch2) {
            if (it.i >= 0 && taken[it.i]) continue;
            if (it.id !== "" && idSeen.has(it.id)) continue;
            if (it.id !== "") idSeen.add(it.id);
            if (it.i >= 0) taken[it.i] = true;
            if (it.cand) {
              chosen.push(it.cand);
            } else {
              const m2 = bldStaticMeasureOf(it.f);
              const cell = bundleCellOf(m2.cLng, m2.cLat, cellDeg);
              chosen.push({ f: it.f, c: it.c, score: m2.score, key: bundleCellKey(cell.w, cell.s, cellDeg) });
            }
            sumPx += it.c.px;
            sumV += it.c.verts;
            if (it.d > farM) farM = it.d;
            perAnchor[ai] += 1;
            added += 1;
            if (it.frozen) restored += 1;
          }
        }
        stats.nearAnchors = anchors.length;
        stats.nearAdded = added;
        stats.nearRestored = restored;
        stats.nearPicked = picked;
        stats.nearAddedPerAnchor = perAnchor;
        stats.nearDistM = added > 0 ? Math.round(farM) : null;
        if (added > 0) {
          stats.chosen = chosen.length;
          stats.px2 = Math.round(sumPx);
          stats.verts = Math.round(sumV);
          stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;
          const seen = /* @__PURE__ */ new Set();
          const keys = [];
          for (const c of chosen) if (!seen.has(c.key)) {
            seen.add(c.key);
            keys.push(c.key);
          }
          stats.cellKeys = keys;
          stats.cellsChosen = keys.length;
        }
        stats.why += " · 就近补齐 " + added + " 栋 · 锚点 " + anchors.length + " 个" + (added > 0 ? "（最远 " + stats.nearDistM + " m" + (restored > 0 ? " · 冻结还原 " + restored + " 栋" : "") + "）" : zeroCap ? "（每格上限 0 ⇒ 候选池为空，不复活）" : "（没有未入选的候选）") + (!overBefore && stats.overBudget ? " · ⚠️ 已超预算（就近补齐破例）" : "");
      }
    }
  }
  {
    const walkKOn = bldWalkKOf(input.walkK);
    const ws0 = input.walkSeed;
    const wsOk = !!ws0 && typeof ws0 === "object";
    const wsLng = wsOk ? Number(ws0.lng) : NaN;
    const wsLat = wsOk ? Number(ws0.lat) : NaN;
    if (walkKOn > 0 && wsOk && isFinite(wsLng) && isFinite(wsLat)) {
      stats.walkOn = true;
      const cosLat = Math.cos(wsLat * Math.PI / 180);
      const wkx = WS_BLD_M_PER_DEG_LNG * (isFinite(cosLat) ? cosLat : 1);
      const walkIds = /* @__PURE__ */ new Set();
      const walkObjs = /* @__PURE__ */ new Set();
      for (const c of chosen) {
        if (c.c.id !== "") walkIds.add(c.c.id);
        walkObjs.add(c.f);
      }
      const distOf = (m) => {
        const dx = (m.cLng - wsLng) * wkx;
        const dy = (m.cLat - wsLat) * WS_BLD_M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
      };
      const frozenRaw = Array.isArray(input.walkBuf) ? input.walkBuf : [];
      let farM = 0;
      for (const f of frozenRaw) {
        if (!f || typeof f !== "object") continue;
        if (walkObjs.has(f)) continue;
        const id = String(f.id ?? "");
        if (id !== "" && walkIds.has(id)) continue;
        const m2 = bldStaticMeasureOf(f);
        if (!m2) continue;
        const d = distOf(m2);
        if (!isFinite(d)) continue;
        const cost = bldStaticScreenCost(m2, id, mpp, ppm);
        if (id !== "") walkIds.add(id);
        walkObjs.add(f);
        const cell = bundleCellOf(m2.cLng, m2.cLat, cellDeg);
        chosen.push({ f, c: cost, score: m2.score, key: bundleCellKey(cell.w, cell.s, cellDeg) });
        sumPx += cost.px;
        sumV += cost.verts;
        if (d > farM) farM = d;
        stats.walkRestored += 1;
      }
      const cands = [];
      const scanSrc = Array.isArray(input.walkCandidates) ? null : pool;
      if (scanSrc) {
        for (let i = 0; i < scanSrc.length; i++) {
          if (taken[i]) continue;
          const c = scanSrc[i];
          if (c.c.id !== "" && walkIds.has(c.c.id)) continue;
          if (walkObjs.has(c.f)) continue;
          const m2 = bldStaticMeasureOf(c.f);
          if (!m2) continue;
          const d = distOf(m2);
          if (!isFinite(d)) continue;
          cands.push({ cand: c, i, d, id: c.c.id });
        }
      } else {
        for (const f0 of input.walkCandidates) {
          if (!f0 || typeof f0 !== "object") continue;
          const id0 = String(f0.id ?? "");
          if (id0 !== "" && walkIds.has(id0)) continue;
          if (walkObjs.has(f0)) continue;
          const m2 = bldStaticMeasureOf(f0);
          if (!m2) continue;
          const d = distOf(m2);
          if (!isFinite(d)) continue;
          const cell0 = bundleCellOf(m2.cLng, m2.cLat, cellDeg);
          cands.push({
            cand: { f: f0, c: bldStaticScreenCost(m2, id0, mpp, ppm), score: m2.score, key: bundleCellKey(cell0.w, cell0.s, cellDeg) },
            i: -1,
            d,
            id: id0
          });
        }
      }
      cands.sort((A, B) => A.d !== B.d ? A.d - B.d : A.id < B.id ? -1 : A.id > B.id ? 1 : 0);
      const take = Math.min(walkKOn, cands.length);
      for (let k = 0; k < take; k++) {
        const it = cands[k];
        if (it.i >= 0 && taken[it.i]) continue;
        if (it.id !== "" && walkIds.has(it.id)) continue;
        if (it.id !== "") walkIds.add(it.id);
        walkObjs.add(it.cand.f);
        if (it.i >= 0) taken[it.i] = true;
        chosen.push(it.cand);
        sumPx += it.cand.c.px;
        sumV += it.cand.c.verts;
        if (it.d > farM) farM = it.d;
        stats.walkAdded += 1;
      }
      stats.walkDistM = stats.walkRestored + stats.walkAdded > 0 ? Math.round(farM) : null;
      stats.walkScanned = Array.isArray(input.walkCandidates) ? input.walkCandidates.length : pool.length;
      if (stats.walkRestored + stats.walkAdded > 0) {
        stats.chosen = chosen.length;
        stats.px2 = Math.round(sumPx);
        stats.verts = Math.round(sumV);
        stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;
        const seen = /* @__PURE__ */ new Set();
        const keys = [];
        for (const c of chosen) if (!seen.has(c.key)) {
          seen.add(c.key);
          keys.push(c.key);
        }
        stats.cellKeys = keys;
        stats.cellsChosen = keys.length;
      }
      stats.why += " · 行走补 " + stats.walkAdded + " 栋" + (stats.walkRestored > 0 ? "（保住 " + stats.walkRestored + " 栋）" : "") + (stats.walkDistM !== null ? "（最远 " + stats.walkDistM + " m）" : "");
    }
  }
  return { features: chosen.map((c) => c.f), stats };
}

// node_modules/.pnpm/@vue+shared@3.5.34/node_modules/@vue/shared/dist/shared.esm-bundler.js
// @__NO_SIDE_EFFECTS__
function makeMap(str2) {
  const map2 = /* @__PURE__ */ Object.create(null);
  for (const key of str2.split(",")) map2[key] = 1;
  return (val) => val in map2;
}
var EMPTY_OBJ = true ? Object.freeze({}) : {};
var EMPTY_ARR = true ? Object.freeze([]) : [];
var NOOP = () => {
};
var NO = () => false;
var extend = Object.assign;
var remove = (arr, el) => {
  const i = arr.indexOf(el);
  if (i > -1) {
    arr.splice(i, 1);
  }
};
var hasOwnProperty = Object.prototype.hasOwnProperty;
var hasOwn = (val, key) => hasOwnProperty.call(val, key);
var isArray = Array.isArray;
var isMap = (val) => toTypeString(val) === "[object Map]";
var isSet = (val) => toTypeString(val) === "[object Set]";
var isFunction = (val) => typeof val === "function";
var isString = (val) => typeof val === "string";
var isSymbol = (val) => typeof val === "symbol";
var isObject = (val) => val !== null && typeof val === "object";
var isPromise = (val) => {
  return (isObject(val) || isFunction(val)) && isFunction(val.then) && isFunction(val.catch);
};
var objectToString = Object.prototype.toString;
var toTypeString = (value) => objectToString.call(value);
var toRawType = (value) => {
  return toTypeString(value).slice(8, -1);
};
var isPlainObject = (val) => toTypeString(val) === "[object Object]";
var isIntegerKey = (key) => isString(key) && key !== "NaN" && key[0] !== "-" && "" + parseInt(key, 10) === key;
var cacheStringFunction = (fn) => {
  const cache = /* @__PURE__ */ Object.create(null);
  return ((str2) => {
    const hit = cache[str2];
    return hit || (cache[str2] = fn(str2));
  });
};
var camelizeRE = /-\w/g;
var camelize = cacheStringFunction(
  (str2) => {
    return str2.replace(camelizeRE, (c) => c.slice(1).toUpperCase());
  }
);
var hyphenateRE = /\B([A-Z])/g;
var hyphenate = cacheStringFunction(
  (str2) => str2.replace(hyphenateRE, "-$1").toLowerCase()
);
var capitalize = cacheStringFunction((str2) => {
  return str2.charAt(0).toUpperCase() + str2.slice(1);
});
var toHandlerKey = cacheStringFunction(
  (str2) => {
    const s = str2 ? `on${capitalize(str2)}` : ``;
    return s;
  }
);
var hasChanged = (value, oldValue) => !Object.is(value, oldValue);
var def = (obj, key, value, writable = false) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: false,
    writable,
    value
  });
};
var _globalThis;
var getGlobalThis = () => {
  return _globalThis || (_globalThis = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
};
var specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`;
var isBooleanAttr = /* @__PURE__ */ makeMap(
  specialBooleanAttrs + `,async,autofocus,autoplay,controls,default,defer,disabled,hidden,inert,loop,open,required,reversed,scoped,seamless,checked,muted,multiple,selected`
);

// node_modules/.pnpm/@vue+reactivity@3.5.34/node_modules/@vue/reactivity/dist/reactivity.esm-bundler.js
function warn(msg, ...args) {
  console.warn(`[Vue warn] ${msg}`, ...args);
}
var activeEffectScope;
function getCurrentScope() {
  return activeEffectScope;
}
var activeSub;
var pausedQueueEffects = /* @__PURE__ */ new WeakSet();
var ReactiveEffect = class {
  constructor(fn) {
    this.fn = fn;
    this.deps = void 0;
    this.depsTail = void 0;
    this.flags = 1 | 4;
    this.next = void 0;
    this.cleanup = void 0;
    this.scheduler = void 0;
    if (activeEffectScope) {
      if (activeEffectScope.active) {
        activeEffectScope.effects.push(this);
      } else {
        this.flags &= -2;
      }
    }
  }
  pause() {
    this.flags |= 64;
  }
  resume() {
    if (this.flags & 64) {
      this.flags &= -65;
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this);
        this.trigger();
      }
    }
  }
  /**
   * @internal
   */
  notify() {
    if (this.flags & 2 && !(this.flags & 32)) {
      return;
    }
    if (!(this.flags & 8)) {
      batch(this);
    }
  }
  run() {
    if (!(this.flags & 1)) {
      return this.fn();
    }
    this.flags |= 2;
    cleanupEffect(this);
    prepareDeps(this);
    const prevEffect = activeSub;
    const prevShouldTrack = shouldTrack;
    activeSub = this;
    shouldTrack = true;
    try {
      return this.fn();
    } finally {
      if (activeSub !== this) {
        warn(
          "Active effect was not restored correctly - this is likely a Vue internal bug."
        );
      }
      cleanupDeps(this);
      activeSub = prevEffect;
      shouldTrack = prevShouldTrack;
      this.flags &= -3;
    }
  }
  stop() {
    if (this.flags & 1) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link);
      }
      this.deps = this.depsTail = void 0;
      cleanupEffect(this);
      this.onStop && this.onStop();
      this.flags &= -2;
    }
  }
  trigger() {
    if (this.flags & 64) {
      pausedQueueEffects.add(this);
    } else if (this.scheduler) {
      this.scheduler();
    } else {
      this.runIfDirty();
    }
  }
  /**
   * @internal
   */
  runIfDirty() {
    if (isDirty(this)) {
      this.run();
    }
  }
  get dirty() {
    return isDirty(this);
  }
};
var batchDepth = 0;
var batchedSub;
var batchedComputed;
function batch(sub, isComputed = false) {
  sub.flags |= 8;
  if (isComputed) {
    sub.next = batchedComputed;
    batchedComputed = sub;
    return;
  }
  sub.next = batchedSub;
  batchedSub = sub;
}
function startBatch() {
  batchDepth++;
}
function endBatch() {
  if (--batchDepth > 0) {
    return;
  }
  if (batchedComputed) {
    let e = batchedComputed;
    batchedComputed = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      e = next;
    }
  }
  let error;
  while (batchedSub) {
    let e = batchedSub;
    batchedSub = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      if (e.flags & 1) {
        try {
          ;
          e.trigger();
        } catch (err) {
          if (!error) error = err;
        }
      }
      e = next;
    }
  }
  if (error) throw error;
}
function prepareDeps(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    link.version = -1;
    link.prevActiveLink = link.dep.activeLink;
    link.dep.activeLink = link;
  }
}
function cleanupDeps(sub) {
  let head;
  let tail = sub.depsTail;
  let link = tail;
  while (link) {
    const prev = link.prevDep;
    if (link.version === -1) {
      if (link === tail) tail = prev;
      removeSub(link);
      removeDep(link);
    } else {
      head = link;
    }
    link.dep.activeLink = link.prevActiveLink;
    link.prevActiveLink = void 0;
    link = prev;
  }
  sub.deps = head;
  sub.depsTail = tail;
}
function isDirty(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (link.dep.version !== link.version || link.dep.computed && (refreshComputed(link.dep.computed) || link.dep.version !== link.version)) {
      return true;
    }
  }
  if (sub._dirty) {
    return true;
  }
  return false;
}
function refreshComputed(computed2) {
  if (computed2.flags & 4 && !(computed2.flags & 16)) {
    return;
  }
  computed2.flags &= -17;
  if (computed2.globalVersion === globalVersion) {
    return;
  }
  computed2.globalVersion = globalVersion;
  if (!computed2.isSSR && computed2.flags & 128 && (!computed2.deps && !computed2._dirty || !isDirty(computed2))) {
    return;
  }
  computed2.flags |= 2;
  const dep = computed2.dep;
  const prevSub = activeSub;
  const prevShouldTrack = shouldTrack;
  activeSub = computed2;
  shouldTrack = true;
  try {
    prepareDeps(computed2);
    const value = computed2.fn(computed2._value);
    if (dep.version === 0 || hasChanged(value, computed2._value)) {
      computed2.flags |= 128;
      computed2._value = value;
      dep.version++;
    }
  } catch (err) {
    dep.version++;
    throw err;
  } finally {
    activeSub = prevSub;
    shouldTrack = prevShouldTrack;
    cleanupDeps(computed2);
    computed2.flags &= -3;
  }
}
function removeSub(link, soft = false) {
  const { dep, prevSub, nextSub } = link;
  if (prevSub) {
    prevSub.nextSub = nextSub;
    link.prevSub = void 0;
  }
  if (nextSub) {
    nextSub.prevSub = prevSub;
    link.nextSub = void 0;
  }
  if (dep.subsHead === link) {
    dep.subsHead = nextSub;
  }
  if (dep.subs === link) {
    dep.subs = prevSub;
    if (!prevSub && dep.computed) {
      dep.computed.flags &= -5;
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        removeSub(l, true);
      }
    }
  }
  if (!soft && !--dep.sc && dep.map) {
    dep.map.delete(dep.key);
  }
}
function removeDep(link) {
  const { prevDep, nextDep } = link;
  if (prevDep) {
    prevDep.nextDep = nextDep;
    link.prevDep = void 0;
  }
  if (nextDep) {
    nextDep.prevDep = prevDep;
    link.nextDep = void 0;
  }
}
var shouldTrack = true;
var trackStack = [];
function pauseTracking() {
  trackStack.push(shouldTrack);
  shouldTrack = false;
}
function resetTracking() {
  const last = trackStack.pop();
  shouldTrack = last === void 0 ? true : last;
}
function cleanupEffect(e) {
  const { cleanup } = e;
  e.cleanup = void 0;
  if (cleanup) {
    const prevSub = activeSub;
    activeSub = void 0;
    try {
      cleanup();
    } finally {
      activeSub = prevSub;
    }
  }
}
var globalVersion = 0;
var Link = class {
  constructor(sub, dep) {
    this.sub = sub;
    this.dep = dep;
    this.version = dep.version;
    this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0;
  }
};
var Dep = class {
  // TODO isolatedDeclarations "__v_skip"
  constructor(computed2) {
    this.computed = computed2;
    this.version = 0;
    this.activeLink = void 0;
    this.subs = void 0;
    this.map = void 0;
    this.key = void 0;
    this.sc = 0;
    this.__v_skip = true;
    if (true) {
      this.subsHead = void 0;
    }
  }
  track(debugInfo) {
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return;
    }
    let link = this.activeLink;
    if (link === void 0 || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this);
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link;
      } else {
        link.prevDep = activeSub.depsTail;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
      }
      addSub(link);
    } else if (link.version === -1) {
      link.version = this.version;
      if (link.nextDep) {
        const next = link.nextDep;
        next.prevDep = link.prevDep;
        if (link.prevDep) {
          link.prevDep.nextDep = next;
        }
        link.prevDep = activeSub.depsTail;
        link.nextDep = void 0;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
        if (activeSub.deps === link) {
          activeSub.deps = next;
        }
      }
    }
    if (activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub
          },
          debugInfo
        )
      );
    }
    return link;
  }
  trigger(debugInfo) {
    this.version++;
    globalVersion++;
    this.notify(debugInfo);
  }
  notify(debugInfo) {
    startBatch();
    try {
      if (true) {
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & 8)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub
                },
                debugInfo
              )
            );
          }
        }
      }
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          ;
          link.sub.dep.notify();
        }
      }
    } finally {
      endBatch();
    }
  }
};
function addSub(link) {
  link.dep.sc++;
  if (link.sub.flags & 4) {
    const computed2 = link.dep.computed;
    if (computed2 && !link.dep.subs) {
      computed2.flags |= 4 | 16;
      for (let l = computed2.deps; l; l = l.nextDep) {
        addSub(l);
      }
    }
    const currentTail = link.dep.subs;
    if (currentTail !== link) {
      link.prevSub = currentTail;
      if (currentTail) currentTail.nextSub = link;
    }
    if (link.dep.subsHead === void 0) {
      link.dep.subsHead = link;
    }
    link.dep.subs = link;
  }
}
var targetMap = /* @__PURE__ */ new WeakMap();
var ITERATE_KEY = /* @__PURE__ */ Symbol(
  true ? "Object iterate" : ""
);
var MAP_KEY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  true ? "Map keys iterate" : ""
);
var ARRAY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  true ? "Array iterate" : ""
);
function track(target, type, key) {
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target);
    if (!depsMap) {
      targetMap.set(target, depsMap = /* @__PURE__ */ new Map());
    }
    let dep = depsMap.get(key);
    if (!dep) {
      depsMap.set(key, dep = new Dep());
      dep.map = depsMap;
      dep.key = key;
    }
    if (true) {
      dep.track({
        target,
        type,
        key
      });
    } else {
      dep.track();
    }
  }
}
function trigger(target, type, key, newValue, oldValue, oldTarget) {
  const depsMap = targetMap.get(target);
  if (!depsMap) {
    globalVersion++;
    return;
  }
  const run = (dep) => {
    if (dep) {
      if (true) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget
        });
      } else {
        dep.trigger();
      }
    }
  };
  startBatch();
  if (type === "clear") {
    depsMap.forEach(run);
  } else {
    const targetIsArray = isArray(target);
    const isArrayIndex = targetIsArray && isIntegerKey(key);
    if (targetIsArray && key === "length") {
      const newLength = Number(newValue);
      depsMap.forEach((dep, key2) => {
        if (key2 === "length" || key2 === ARRAY_ITERATE_KEY || !isSymbol(key2) && key2 >= newLength) {
          run(dep);
        }
      });
    } else {
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key));
      }
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY));
      }
      switch (type) {
        case "add":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          } else if (isArrayIndex) {
            run(depsMap.get("length"));
          }
          break;
        case "delete":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          }
          break;
        case "set":
          if (isMap(target)) {
            run(depsMap.get(ITERATE_KEY));
          }
          break;
      }
    }
  }
  endBatch();
}
function reactiveReadArray(array) {
  const raw = /* @__PURE__ */ toRaw(array);
  if (raw === array) return raw;
  track(raw, "iterate", ARRAY_ITERATE_KEY);
  return /* @__PURE__ */ isShallow(array) ? raw : raw.map(toReactive);
}
function shallowReadArray(arr) {
  track(arr = /* @__PURE__ */ toRaw(arr), "iterate", ARRAY_ITERATE_KEY);
  return arr;
}
function toWrapped(target, item) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return /* @__PURE__ */ isReactive(target) ? toReadonly(toReactive(item)) : toReadonly(item);
  }
  return toReactive(item);
}
var arrayInstrumentations = {
  __proto__: null,
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, (item) => toWrapped(this, item));
  },
  concat(...args) {
    return reactiveReadArray(this).concat(
      ...args.map((x) => isArray(x) ? reactiveReadArray(x) : x)
    );
  },
  entries() {
    return iterator(this, "entries", (value) => {
      value[1] = toWrapped(this, value[1]);
      return value;
    });
  },
  every(fn, thisArg) {
    return apply(this, "every", fn, thisArg, void 0, arguments);
  },
  filter(fn, thisArg) {
    return apply(
      this,
      "filter",
      fn,
      thisArg,
      (v) => v.map((item) => toWrapped(this, item)),
      arguments
    );
  },
  find(fn, thisArg) {
    return apply(
      this,
      "find",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findIndex(fn, thisArg) {
    return apply(this, "findIndex", fn, thisArg, void 0, arguments);
  },
  findLast(fn, thisArg) {
    return apply(
      this,
      "findLast",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findLastIndex(fn, thisArg) {
    return apply(this, "findLastIndex", fn, thisArg, void 0, arguments);
  },
  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement
  forEach(fn, thisArg) {
    return apply(this, "forEach", fn, thisArg, void 0, arguments);
  },
  includes(...args) {
    return searchProxy(this, "includes", args);
  },
  indexOf(...args) {
    return searchProxy(this, "indexOf", args);
  },
  join(separator) {
    return reactiveReadArray(this).join(separator);
  },
  // keys() iterator only reads `length`, no optimization required
  lastIndexOf(...args) {
    return searchProxy(this, "lastIndexOf", args);
  },
  map(fn, thisArg) {
    return apply(this, "map", fn, thisArg, void 0, arguments);
  },
  pop() {
    return noTracking(this, "pop");
  },
  push(...args) {
    return noTracking(this, "push", args);
  },
  reduce(fn, ...args) {
    return reduce(this, "reduce", fn, args);
  },
  reduceRight(fn, ...args) {
    return reduce(this, "reduceRight", fn, args);
  },
  shift() {
    return noTracking(this, "shift");
  },
  // slice could use ARRAY_ITERATE but also seems to beg for range tracking
  some(fn, thisArg) {
    return apply(this, "some", fn, thisArg, void 0, arguments);
  },
  splice(...args) {
    return noTracking(this, "splice", args);
  },
  toReversed() {
    return reactiveReadArray(this).toReversed();
  },
  toSorted(comparer) {
    return reactiveReadArray(this).toSorted(comparer);
  },
  toSpliced(...args) {
    return reactiveReadArray(this).toSpliced(...args);
  },
  unshift(...args) {
    return noTracking(this, "unshift", args);
  },
  values() {
    return iterator(this, "values", (item) => toWrapped(this, item));
  }
};
function iterator(self2, method, wrapValue) {
  const arr = shallowReadArray(self2);
  const iter = arr[method]();
  if (arr !== self2 && !/* @__PURE__ */ isShallow(self2)) {
    iter._next = iter.next;
    iter.next = () => {
      const result = iter._next();
      if (!result.done) {
        result.value = wrapValue(result.value);
      }
      return result;
    };
  }
  return iter;
}
var arrayProto = Array.prototype;
function apply(self2, method, fn, thisArg, wrappedRetFn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  const methodFn = arr[method];
  if (methodFn !== arrayProto[method]) {
    const result2 = methodFn.apply(self2, args);
    return needsWrap ? toReactive(result2) : result2;
  }
  let wrappedFn = fn;
  if (arr !== self2) {
    if (needsWrap) {
      wrappedFn = function(item, index) {
        return fn.call(this, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 2) {
      wrappedFn = function(item, index) {
        return fn.call(this, item, index, self2);
      };
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg);
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result;
}
function reduce(self2, method, fn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  let wrappedFn = fn;
  let wrapInitialAccumulator = false;
  if (arr !== self2) {
    if (needsWrap) {
      wrapInitialAccumulator = args.length === 0;
      wrappedFn = function(acc, item, index) {
        if (wrapInitialAccumulator) {
          wrapInitialAccumulator = false;
          acc = toWrapped(self2, acc);
        }
        return fn.call(this, acc, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 3) {
      wrappedFn = function(acc, item, index) {
        return fn.call(this, acc, item, index, self2);
      };
    }
  }
  const result = arr[method](wrappedFn, ...args);
  return wrapInitialAccumulator ? toWrapped(self2, result) : result;
}
function searchProxy(self2, method, args) {
  const arr = /* @__PURE__ */ toRaw(self2);
  track(arr, "iterate", ARRAY_ITERATE_KEY);
  const res = arr[method](...args);
  if ((res === -1 || res === false) && /* @__PURE__ */ isProxy(args[0])) {
    args[0] = /* @__PURE__ */ toRaw(args[0]);
    return arr[method](...args);
  }
  return res;
}
function noTracking(self2, method, args = []) {
  pauseTracking();
  startBatch();
  const res = (/* @__PURE__ */ toRaw(self2))[method].apply(self2, args);
  endBatch();
  resetTracking();
  return res;
}
var isNonTrackableKeys = /* @__PURE__ */ makeMap(`__proto__,__v_isRef,__isVue`);
var builtInSymbols = new Set(
  /* @__PURE__ */ Object.getOwnPropertyNames(Symbol).filter((key) => key !== "arguments" && key !== "caller").map((key) => Symbol[key]).filter(isSymbol)
);
function hasOwnProperty2(key) {
  if (!isSymbol(key)) key = String(key);
  const obj = /* @__PURE__ */ toRaw(this);
  track(obj, "has", key);
  return obj.hasOwnProperty(key);
}
var BaseReactiveHandler = class {
  constructor(_isReadonly = false, _isShallow = false) {
    this._isReadonly = _isReadonly;
    this._isShallow = _isShallow;
  }
  get(target, key, receiver) {
    if (key === "__v_skip") return target["__v_skip"];
    const isReadonly2 = this._isReadonly, isShallow2 = this._isShallow;
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return isShallow2;
    } else if (key === "__v_raw") {
      if (receiver === (isReadonly2 ? isShallow2 ? shallowReadonlyMap : readonlyMap : isShallow2 ? shallowReactiveMap : reactiveMap).get(target) || // receiver is not the reactive proxy, but has the same prototype
      // this means the receiver is a user proxy of the reactive proxy
      Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)) {
        return target;
      }
      return;
    }
    const targetIsArray = isArray(target);
    if (!isReadonly2) {
      let fn;
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn;
      }
      if (key === "hasOwnProperty") {
        return hasOwnProperty2;
      }
    }
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res;
    }
    if (!isReadonly2) {
      track(target, "get", key);
    }
    if (isShallow2) {
      return res;
    }
    if (/* @__PURE__ */ isRef(res)) {
      const value = targetIsArray && isIntegerKey(key) ? res : res.value;
      return isReadonly2 && isObject(value) ? /* @__PURE__ */ readonly(value) : value;
    }
    if (isObject(res)) {
      return isReadonly2 ? /* @__PURE__ */ readonly(res) : /* @__PURE__ */ reactive(res);
    }
    return res;
  }
};
var MutableReactiveHandler = class extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(false, isShallow2);
  }
  set(target, key, value, receiver) {
    let oldValue = target[key];
    const isArrayWithIntegerKey = isArray(target) && isIntegerKey(key);
    if (!this._isShallow) {
      const isOldValueReadonly = /* @__PURE__ */ isReadonly(oldValue);
      if (!/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
        oldValue = /* @__PURE__ */ toRaw(oldValue);
        value = /* @__PURE__ */ toRaw(value);
      }
      if (!isArrayWithIntegerKey && /* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
        if (isOldValueReadonly) {
          if (true) {
            warn(
              `Set operation on key "${String(key)}" failed: target is readonly.`,
              target[key]
            );
          }
          return true;
        } else {
          oldValue.value = value;
          return true;
        }
      }
    }
    const hadKey = isArrayWithIntegerKey ? Number(key) < target.length : hasOwn(target, key);
    const result = Reflect.set(
      target,
      key,
      value,
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (target === /* @__PURE__ */ toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, "add", key, value);
      } else if (hasChanged(value, oldValue)) {
        trigger(target, "set", key, value, oldValue);
      }
    }
    return result;
  }
  deleteProperty(target, key) {
    const hadKey = hasOwn(target, key);
    const oldValue = target[key];
    const result = Reflect.deleteProperty(target, key);
    if (result && hadKey) {
      trigger(target, "delete", key, void 0, oldValue);
    }
    return result;
  }
  has(target, key) {
    const result = Reflect.has(target, key);
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, "has", key);
    }
    return result;
  }
  ownKeys(target) {
    track(
      target,
      "iterate",
      isArray(target) ? "length" : ITERATE_KEY
    );
    return Reflect.ownKeys(target);
  }
};
var ReadonlyReactiveHandler = class extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(true, isShallow2);
  }
  set(target, key) {
    if (true) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      );
    }
    return true;
  }
  deleteProperty(target, key) {
    if (true) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      );
    }
    return true;
  }
};
var mutableHandlers = /* @__PURE__ */ new MutableReactiveHandler();
var readonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler();
var shallowReadonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler(true);
var toShallow = (value) => value;
var getProto = (v) => Reflect.getPrototypeOf(v);
function createIterableMethod(method, isReadonly2, isShallow2) {
  return function(...args) {
    const target = this["__v_raw"];
    const rawTarget = /* @__PURE__ */ toRaw(target);
    const targetIsMap = isMap(rawTarget);
    const isPair = method === "entries" || method === Symbol.iterator && targetIsMap;
    const isKeyOnly = method === "keys" && targetIsMap;
    const innerIterator = target[method](...args);
    const wrap = isShallow2 ? toShallow : isReadonly2 ? toReadonly : toReactive;
    !isReadonly2 && track(
      rawTarget,
      "iterate",
      isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
    );
    return extend(
      // inheriting all iterator properties
      Object.create(innerIterator),
      {
        // iterator protocol
        next() {
          const { value, done } = innerIterator.next();
          return done ? { value, done } : {
            value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
            done
          };
        }
      }
    );
  };
}
function createReadonlyMethod(type) {
  return function(...args) {
    if (true) {
      const key = args[0] ? `on key "${args[0]}" ` : ``;
      warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        /* @__PURE__ */ toRaw(this)
      );
    }
    return type === "delete" ? false : type === "clear" ? void 0 : this;
  };
}
function createInstrumentations(readonly2, shallow) {
  const instrumentations = {
    get(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "get", key);
        }
        track(rawTarget, "get", rawKey);
      }
      const { has } = getProto(rawTarget);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key));
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey));
      } else if (target !== rawTarget) {
        target.get(key);
      }
    },
    get size() {
      const target = this["__v_raw"];
      !readonly2 && track(/* @__PURE__ */ toRaw(target), "iterate", ITERATE_KEY);
      return target.size;
    },
    has(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "has", key);
        }
        track(rawTarget, "has", rawKey);
      }
      return key === rawKey ? target.has(key) : target.has(key) || target.has(rawKey);
    },
    forEach(callback, thisArg) {
      const observed = this;
      const target = observed["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      !readonly2 && track(rawTarget, "iterate", ITERATE_KEY);
      return target.forEach((value, key) => {
        return callback.call(thisArg, wrap(value), wrap(key), observed);
      });
    }
  };
  extend(
    instrumentations,
    readonly2 ? {
      add: createReadonlyMethod("add"),
      set: createReadonlyMethod("set"),
      delete: createReadonlyMethod("delete"),
      clear: createReadonlyMethod("clear")
    } : {
      add(value) {
        const target = /* @__PURE__ */ toRaw(this);
        const proto = getProto(target);
        const rawValue = /* @__PURE__ */ toRaw(value);
        const valueToAdd = !shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value) ? rawValue : value;
        const hadKey = proto.has.call(target, valueToAdd) || hasChanged(value, valueToAdd) && proto.has.call(target, value) || hasChanged(rawValue, valueToAdd) && proto.has.call(target, rawValue);
        if (!hadKey) {
          target.add(valueToAdd);
          trigger(target, "add", valueToAdd, valueToAdd);
        }
        return this;
      },
      set(key, value) {
        if (!shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
          value = /* @__PURE__ */ toRaw(value);
        }
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        } else if (true) {
          checkIdentityKeys(target, has, key);
        }
        const oldValue = get.call(target, key);
        target.set(key, value);
        if (!hadKey) {
          trigger(target, "add", key, value);
        } else if (hasChanged(value, oldValue)) {
          trigger(target, "set", key, value, oldValue);
        }
        return this;
      },
      delete(key) {
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        } else if (true) {
          checkIdentityKeys(target, has, key);
        }
        const oldValue = get ? get.call(target, key) : void 0;
        const result = target.delete(key);
        if (hadKey) {
          trigger(target, "delete", key, void 0, oldValue);
        }
        return result;
      },
      clear() {
        const target = /* @__PURE__ */ toRaw(this);
        const hadItems = target.size !== 0;
        const oldTarget = true ? isMap(target) ? new Map(target) : new Set(target) : void 0;
        const result = target.clear();
        if (hadItems) {
          trigger(
            target,
            "clear",
            void 0,
            void 0,
            oldTarget
          );
        }
        return result;
      }
    }
  );
  const iteratorMethods = [
    "keys",
    "values",
    "entries",
    Symbol.iterator
  ];
  iteratorMethods.forEach((method) => {
    instrumentations[method] = createIterableMethod(method, readonly2, shallow);
  });
  return instrumentations;
}
function createInstrumentationGetter(isReadonly2, shallow) {
  const instrumentations = createInstrumentations(isReadonly2, shallow);
  return (target, key, receiver) => {
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_raw") {
      return target;
    }
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target ? instrumentations : target,
      key,
      receiver
    );
  };
}
var mutableCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, false)
};
var readonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, false)
};
var shallowReadonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, true)
};
function checkIdentityKeys(target, has, key) {
  const rawKey = /* @__PURE__ */ toRaw(key);
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target);
    warn(
      `Reactive ${type} contains both the raw and reactive versions of the same object${type === `Map` ? ` as keys` : ``}, which can lead to inconsistencies. Avoid differentiating between the raw and reactive versions of an object and only use the reactive version if possible.`
    );
  }
}
var reactiveMap = /* @__PURE__ */ new WeakMap();
var shallowReactiveMap = /* @__PURE__ */ new WeakMap();
var readonlyMap = /* @__PURE__ */ new WeakMap();
var shallowReadonlyMap = /* @__PURE__ */ new WeakMap();
function targetTypeMap(rawType) {
  switch (rawType) {
    case "Object":
    case "Array":
      return 1;
    case "Map":
    case "Set":
    case "WeakMap":
    case "WeakSet":
      return 2;
    default:
      return 0;
  }
}
function getTargetType(value) {
  return value["__v_skip"] || !Object.isExtensible(value) ? 0 : targetTypeMap(toRawType(value));
}
// @__NO_SIDE_EFFECTS__
function reactive(target) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return target;
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,
    mutableCollectionHandlers,
    reactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function readonly(target) {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReadonly(target) {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  );
}
function createReactiveObject(target, isReadonly2, baseHandlers, collectionHandlers, proxyMap) {
  if (!isObject(target)) {
    if (true) {
      warn(
        `value cannot be made ${isReadonly2 ? "readonly" : "reactive"}: ${String(
          target
        )}`
      );
    }
    return target;
  }
  if (target["__v_raw"] && !(isReadonly2 && target["__v_isReactive"])) {
    return target;
  }
  const targetType = getTargetType(target);
  if (targetType === 0) {
    return target;
  }
  const existingProxy = proxyMap.get(target);
  if (existingProxy) {
    return existingProxy;
  }
  const proxy = new Proxy(
    target,
    targetType === 2 ? collectionHandlers : baseHandlers
  );
  proxyMap.set(target, proxy);
  return proxy;
}
// @__NO_SIDE_EFFECTS__
function isReactive(value) {
  if (/* @__PURE__ */ isReadonly(value)) {
    return /* @__PURE__ */ isReactive(value["__v_raw"]);
  }
  return !!(value && value["__v_isReactive"]);
}
// @__NO_SIDE_EFFECTS__
function isReadonly(value) {
  return !!(value && value["__v_isReadonly"]);
}
// @__NO_SIDE_EFFECTS__
function isShallow(value) {
  return !!(value && value["__v_isShallow"]);
}
// @__NO_SIDE_EFFECTS__
function isProxy(value) {
  return value ? !!value["__v_raw"] : false;
}
// @__NO_SIDE_EFFECTS__
function toRaw(observed) {
  const raw = observed && observed["__v_raw"];
  return raw ? /* @__PURE__ */ toRaw(raw) : observed;
}
function markRaw(value) {
  if (!hasOwn(value, "__v_skip") && Object.isExtensible(value)) {
    def(value, "__v_skip", true);
  }
  return value;
}
var toReactive = (value) => isObject(value) ? /* @__PURE__ */ reactive(value) : value;
var toReadonly = (value) => isObject(value) ? /* @__PURE__ */ readonly(value) : value;
// @__NO_SIDE_EFFECTS__
function isRef(r) {
  return r ? r["__v_isRef"] === true : false;
}
// @__NO_SIDE_EFFECTS__
function ref(value) {
  return createRef(value, false);
}
function createRef(rawValue, shallow) {
  if (/* @__PURE__ */ isRef(rawValue)) {
    return rawValue;
  }
  return new RefImpl(rawValue, shallow);
}
var RefImpl = class {
  constructor(value, isShallow2) {
    this.dep = new Dep();
    this["__v_isRef"] = true;
    this["__v_isShallow"] = false;
    this._rawValue = isShallow2 ? value : /* @__PURE__ */ toRaw(value);
    this._value = isShallow2 ? value : toReactive(value);
    this["__v_isShallow"] = isShallow2;
  }
  get value() {
    if (true) {
      this.dep.track({
        target: this,
        type: "get",
        key: "value"
      });
    } else {
      this.dep.track();
    }
    return this._value;
  }
  set value(newValue) {
    const oldValue = this._rawValue;
    const useDirectValue = this["__v_isShallow"] || /* @__PURE__ */ isShallow(newValue) || /* @__PURE__ */ isReadonly(newValue);
    newValue = useDirectValue ? newValue : /* @__PURE__ */ toRaw(newValue);
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue;
      this._value = useDirectValue ? newValue : toReactive(newValue);
      if (true) {
        this.dep.trigger({
          target: this,
          type: "set",
          key: "value",
          newValue,
          oldValue
        });
      } else {
        this.dep.trigger();
      }
    }
  }
};
function unref(ref2) {
  return /* @__PURE__ */ isRef(ref2) ? ref2.value : ref2;
}
var shallowUnwrapHandlers = {
  get: (target, key, receiver) => key === "__v_raw" ? target : unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key];
    if (/* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
      oldValue.value = value;
      return true;
    } else {
      return Reflect.set(target, key, value, receiver);
    }
  }
};
function proxyRefs(objectWithRefs) {
  return /* @__PURE__ */ isReactive(objectWithRefs) ? objectWithRefs : new Proxy(objectWithRefs, shallowUnwrapHandlers);
}
var INITIAL_WATCHER_VALUE = {};
var cleanupMap = /* @__PURE__ */ new WeakMap();
var activeWatcher = void 0;
function onWatcherCleanup(cleanupFn, failSilently = false, owner = activeWatcher) {
  if (owner) {
    let cleanups = cleanupMap.get(owner);
    if (!cleanups) cleanupMap.set(owner, cleanups = []);
    cleanups.push(cleanupFn);
  } else if (!failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher to associate with.`
    );
  }
}
function watch(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, once, scheduler, augmentJob, call } = options;
  const warnInvalidSource = (s) => {
    (options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, a reactive object, or an array of these types.`
    );
  };
  const reactiveGetter = (source2) => {
    if (deep) return source2;
    if (/* @__PURE__ */ isShallow(source2) || deep === false || deep === 0)
      return traverse(source2, 1);
    return traverse(source2);
  };
  let effect2;
  let getter;
  let cleanup;
  let boundCleanup;
  let forceTrigger = false;
  let isMultiSource = false;
  if (/* @__PURE__ */ isRef(source)) {
    getter = () => source.value;
    forceTrigger = /* @__PURE__ */ isShallow(source);
  } else if (/* @__PURE__ */ isReactive(source)) {
    getter = () => reactiveGetter(source);
    forceTrigger = true;
  } else if (isArray(source)) {
    isMultiSource = true;
    forceTrigger = source.some((s) => /* @__PURE__ */ isReactive(s) || /* @__PURE__ */ isShallow(s));
    getter = () => source.map((s) => {
      if (/* @__PURE__ */ isRef(s)) {
        return s.value;
      } else if (/* @__PURE__ */ isReactive(s)) {
        return reactiveGetter(s);
      } else if (isFunction(s)) {
        return call ? call(s, 2) : s();
      } else {
        warnInvalidSource(s);
      }
    });
  } else if (isFunction(source)) {
    if (cb) {
      getter = call ? () => call(source, 2) : source;
    } else {
      getter = () => {
        if (cleanup) {
          pauseTracking();
          try {
            cleanup();
          } finally {
            resetTracking();
          }
        }
        const currentEffect = activeWatcher;
        activeWatcher = effect2;
        try {
          return call ? call(source, 3, [boundCleanup]) : source(boundCleanup);
        } finally {
          activeWatcher = currentEffect;
        }
      };
    }
  } else {
    getter = NOOP;
    warnInvalidSource(source);
  }
  if (cb && deep) {
    const baseGetter = getter;
    const depth = deep === true ? Infinity : deep;
    getter = () => traverse(baseGetter(), depth);
  }
  const scope = getCurrentScope();
  const watchHandle = () => {
    effect2.stop();
    if (scope && scope.active) {
      remove(scope.effects, effect2);
    }
  };
  if (once && cb) {
    const _cb = cb;
    cb = (...args) => {
      _cb(...args);
      watchHandle();
    };
  }
  let oldValue = isMultiSource ? new Array(source.length).fill(INITIAL_WATCHER_VALUE) : INITIAL_WATCHER_VALUE;
  const job = (immediateFirstRun) => {
    if (!(effect2.flags & 1) || !effect2.dirty && !immediateFirstRun) {
      return;
    }
    if (cb) {
      const newValue = effect2.run();
      if (deep || forceTrigger || (isMultiSource ? newValue.some((v, i) => hasChanged(v, oldValue[i])) : hasChanged(newValue, oldValue))) {
        if (cleanup) {
          cleanup();
        }
        const currentWatcher = activeWatcher;
        activeWatcher = effect2;
        try {
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            oldValue === INITIAL_WATCHER_VALUE ? void 0 : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE ? [] : oldValue,
            boundCleanup
          ];
          oldValue = newValue;
          call ? call(cb, 3, args) : (
            // @ts-expect-error
            cb(...args)
          );
        } finally {
          activeWatcher = currentWatcher;
        }
      }
    } else {
      effect2.run();
    }
  };
  if (augmentJob) {
    augmentJob(job);
  }
  effect2 = new ReactiveEffect(getter);
  effect2.scheduler = scheduler ? () => scheduler(job, false) : job;
  boundCleanup = (fn) => onWatcherCleanup(fn, false, effect2);
  cleanup = effect2.onStop = () => {
    const cleanups = cleanupMap.get(effect2);
    if (cleanups) {
      if (call) {
        call(cleanups, 4);
      } else {
        for (const cleanup2 of cleanups) cleanup2();
      }
      cleanupMap.delete(effect2);
    }
  };
  if (true) {
    effect2.onTrack = options.onTrack;
    effect2.onTrigger = options.onTrigger;
  }
  if (cb) {
    if (immediate) {
      job(true);
    } else {
      oldValue = effect2.run();
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true);
  } else {
    effect2.run();
  }
  watchHandle.pause = effect2.pause.bind(effect2);
  watchHandle.resume = effect2.resume.bind(effect2);
  watchHandle.stop = watchHandle;
  return watchHandle;
}
function traverse(value, depth = Infinity, seen) {
  if (depth <= 0 || !isObject(value) || value["__v_skip"]) {
    return value;
  }
  seen = seen || /* @__PURE__ */ new Map();
  if ((seen.get(value) || 0) >= depth) {
    return value;
  }
  seen.set(value, depth);
  depth--;
  if (/* @__PURE__ */ isRef(value)) {
    traverse(value.value, depth, seen);
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen);
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v) => {
      traverse(v, depth, seen);
    });
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], depth, seen);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key], depth, seen);
      }
    }
  }
  return value;
}

// node_modules/.pnpm/@vue+runtime-core@3.5.34/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js
var stack = [];
function pushWarningContext(vnode) {
  stack.push(vnode);
}
function popWarningContext() {
  stack.pop();
}
var isWarning = false;
function warn$1(msg, ...args) {
  if (isWarning) return;
  isWarning = true;
  pauseTracking();
  const instance = stack.length ? stack[stack.length - 1].component : null;
  const appWarnHandler = instance && instance.appContext.config.warnHandler;
  const trace = getComponentTrace();
  if (appWarnHandler) {
    callWithErrorHandling(
      appWarnHandler,
      instance,
      11,
      [
        // eslint-disable-next-line no-restricted-syntax
        msg + args.map((a) => {
          var _a, _b;
          return (_b = (_a = a.toString) == null ? void 0 : _a.call(a)) != null ? _b : JSON.stringify(a);
        }).join(""),
        instance && instance.proxy,
        trace.map(
          ({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`
        ).join("\n"),
        trace
      ]
    );
  } else {
    const warnArgs = [`[Vue warn]: ${msg}`, ...args];
    if (trace.length && // avoid spamming console during tests
    true) {
      warnArgs.push(`
`, ...formatTrace(trace));
    }
    console.warn(...warnArgs);
  }
  resetTracking();
  isWarning = false;
}
function getComponentTrace() {
  let currentVNode = stack[stack.length - 1];
  if (!currentVNode) {
    return [];
  }
  const normalizedStack = [];
  while (currentVNode) {
    const last = normalizedStack[0];
    if (last && last.vnode === currentVNode) {
      last.recurseCount++;
    } else {
      normalizedStack.push({
        vnode: currentVNode,
        recurseCount: 0
      });
    }
    const parentInstance = currentVNode.component && currentVNode.component.parent;
    currentVNode = parentInstance && parentInstance.vnode;
  }
  return normalizedStack;
}
function formatTrace(trace) {
  const logs = [];
  trace.forEach((entry, i) => {
    logs.push(...i === 0 ? [] : [`
`], ...formatTraceEntry(entry));
  });
  return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
  const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
  const isRoot = vnode.component ? vnode.component.parent == null : false;
  const open = ` at <${formatComponentName(
    vnode.component,
    vnode.type,
    isRoot
  )}`;
  const close = `>` + postfix;
  return vnode.props ? [open, ...formatProps(vnode.props), close] : [open + close];
}
function formatProps(props) {
  const res = [];
  const keys = Object.keys(props);
  keys.slice(0, 3).forEach((key) => {
    res.push(...formatProp(key, props[key]));
  });
  if (keys.length > 3) {
    res.push(` ...`);
  }
  return res;
}
function formatProp(key, value, raw) {
  if (isString(value)) {
    value = JSON.stringify(value);
    return raw ? value : [`${key}=${value}`];
  } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return raw ? value : [`${key}=${value}`];
  } else if (isRef(value)) {
    value = formatProp(key, toRaw(value.value), true);
    return raw ? value : [`${key}=Ref<`, value, `>`];
  } else if (isFunction(value)) {
    return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
  } else {
    value = toRaw(value);
    return raw ? value : [`${key}=`, value];
  }
}
var ErrorTypeStrings$1 = {
  ["sp"]: "serverPrefetch hook",
  ["bc"]: "beforeCreate hook",
  ["c"]: "created hook",
  ["bm"]: "beforeMount hook",
  ["m"]: "mounted hook",
  ["bu"]: "beforeUpdate hook",
  ["u"]: "updated",
  ["bum"]: "beforeUnmount hook",
  ["um"]: "unmounted hook",
  ["a"]: "activated hook",
  ["da"]: "deactivated hook",
  ["ec"]: "errorCaptured hook",
  ["rtc"]: "renderTracked hook",
  ["rtg"]: "renderTriggered hook",
  [0]: "setup function",
  [1]: "render function",
  [2]: "watcher getter",
  [3]: "watcher callback",
  [4]: "watcher cleanup function",
  [5]: "native event handler",
  [6]: "component event handler",
  [7]: "vnode hook",
  [8]: "directive hook",
  [9]: "transition hook",
  [10]: "app errorHandler",
  [11]: "app warnHandler",
  [12]: "ref function",
  [13]: "async component loader",
  [14]: "scheduler flush",
  [15]: "component update",
  [16]: "app unmount cleanup function"
};
function callWithErrorHandling(fn, instance, type, args) {
  try {
    return args ? fn(...args) : fn();
  } catch (err) {
    handleError(err, instance, type);
  }
}
function callWithAsyncErrorHandling(fn, instance, type, args) {
  if (isFunction(fn)) {
    const res = callWithErrorHandling(fn, instance, type, args);
    if (res && isPromise(res)) {
      res.catch((err) => {
        handleError(err, instance, type);
      });
    }
    return res;
  }
  if (isArray(fn)) {
    const values = [];
    for (let i = 0; i < fn.length; i++) {
      values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
    }
    return values;
  } else if (true) {
    warn$1(
      `Invalid value type passed to callWithAsyncErrorHandling(): ${typeof fn}`
    );
  }
}
function handleError(err, instance, type, throwInDev = true) {
  const contextVNode = instance ? instance.vnode : null;
  const { errorHandler, throwUnhandledErrorInProduction } = instance && instance.appContext.config || EMPTY_OBJ;
  if (instance) {
    let cur = instance.parent;
    const exposedInstance = instance.proxy;
    const errorInfo = true ? ErrorTypeStrings$1[type] : `https://vuejs.org/error-reference/#runtime-${type}`;
    while (cur) {
      const errorCapturedHooks = cur.ec;
      if (errorCapturedHooks) {
        for (let i = 0; i < errorCapturedHooks.length; i++) {
          if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
            return;
          }
        }
      }
      cur = cur.parent;
    }
    if (errorHandler) {
      pauseTracking();
      callWithErrorHandling(errorHandler, null, 10, [
        err,
        exposedInstance,
        errorInfo
      ]);
      resetTracking();
      return;
    }
  }
  logError(err, type, contextVNode, throwInDev, throwUnhandledErrorInProduction);
}
function logError(err, type, contextVNode, throwInDev = true, throwInProd = false) {
  if (true) {
    const info = ErrorTypeStrings$1[type];
    if (contextVNode) {
      pushWarningContext(contextVNode);
    }
    warn$1(`Unhandled error${info ? ` during execution of ${info}` : ``}`);
    if (contextVNode) {
      popWarningContext();
    }
    if (throwInDev) {
      throw err;
    } else {
      console.error(err);
    }
  } else if (throwInProd) {
    throw err;
  } else {
    console.error(err);
  }
}
var queue = [];
var flushIndex = -1;
var pendingPostFlushCbs = [];
var activePostFlushCbs = null;
var postFlushIndex = 0;
var resolvedPromise = /* @__PURE__ */ Promise.resolve();
var currentFlushPromise = null;
var RECURSION_LIMIT = 100;
function nextTick(fn) {
  const p = currentFlushPromise || resolvedPromise;
  return fn ? p.then(this ? fn.bind(this) : fn) : p;
}
function findInsertionIndex(id) {
  let start = flushIndex + 1;
  let end = queue.length;
  while (start < end) {
    const middle = start + end >>> 1;
    const middleJob = queue[middle];
    const middleJobId = getId(middleJob);
    if (middleJobId < id || middleJobId === id && middleJob.flags & 2) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}
function queueJob(job) {
  if (!(job.flags & 1)) {
    const jobId = getId(job);
    const lastJob = queue[queue.length - 1];
    if (!lastJob || // fast path when the job id is larger than the tail
    !(job.flags & 2) && jobId >= getId(lastJob)) {
      queue.push(job);
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job);
    }
    job.flags |= 1;
    queueFlush();
  }
}
function queueFlush() {
  if (!currentFlushPromise) {
    currentFlushPromise = resolvedPromise.then(flushJobs);
  }
}
function queuePostFlushCb(cb) {
  if (!isArray(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb);
    } else if (!(cb.flags & 1)) {
      pendingPostFlushCbs.push(cb);
      cb.flags |= 1;
    }
  } else {
    pendingPostFlushCbs.push(...cb);
  }
  queueFlush();
}
function flushPostFlushCbs(seen) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b)
    );
    pendingPostFlushCbs.length = 0;
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped);
      return;
    }
    activePostFlushCbs = deduped;
    if (true) {
      seen = seen || /* @__PURE__ */ new Map();
    }
    for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
      const cb = activePostFlushCbs[postFlushIndex];
      if (checkRecursiveUpdates(seen, cb)) {
        continue;
      }
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      if (!(cb.flags & 8)) cb();
      cb.flags &= -2;
    }
    activePostFlushCbs = null;
    postFlushIndex = 0;
  }
}
var getId = (job) => job.id == null ? job.flags & 2 ? -1 : Infinity : job.id;
function flushJobs(seen) {
  if (true) {
    seen = seen || /* @__PURE__ */ new Map();
  }
  const check = true ? (job) => checkRecursiveUpdates(seen, job) : NOOP;
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job && !(job.flags & 8)) {
        if (check(job)) {
          continue;
        }
        if (job.flags & 4) {
          job.flags &= ~1;
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? 15 : 14
        );
        if (!(job.flags & 4)) {
          job.flags &= ~1;
        }
      }
    }
  } finally {
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job) {
        job.flags &= -2;
      }
    }
    flushIndex = -1;
    queue.length = 0;
    flushPostFlushCbs(seen);
    currentFlushPromise = null;
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen);
    }
  }
}
function checkRecursiveUpdates(seen, fn) {
  const count = seen.get(fn) || 0;
  if (count > RECURSION_LIMIT) {
    const instance = fn.i;
    const componentName = instance && getComponentName(instance.type);
    handleError(
      `Maximum recursive updates exceeded${componentName ? ` in component <${componentName}>` : ``}. This means you have a reactive effect that is mutating its own dependencies and thus recursively triggering itself. Possible sources include component template, render function, updated hook or watcher source function.`,
      null,
      10
    );
    return true;
  }
  seen.set(fn, count + 1);
  return false;
}
var isHmrUpdating = false;
var hmrDirtyComponents = /* @__PURE__ */ new Map();
if (true) {
  getGlobalThis().__VUE_HMR_RUNTIME__ = {
    createRecord: tryWrap(createRecord),
    rerender: tryWrap(rerender),
    reload: tryWrap(reload)
  };
}
var map = /* @__PURE__ */ new Map();
function createRecord(id, initialDef) {
  if (map.has(id)) {
    return false;
  }
  map.set(id, {
    initialDef: normalizeClassComponent(initialDef),
    instances: /* @__PURE__ */ new Set()
  });
  return true;
}
function normalizeClassComponent(component) {
  return isClassComponent(component) ? component.__vccOpts : component;
}
function rerender(id, newRender) {
  const record = map.get(id);
  if (!record) {
    return;
  }
  record.initialDef.render = newRender;
  [...record.instances].forEach((instance) => {
    if (newRender) {
      instance.render = newRender;
      normalizeClassComponent(instance.type).render = newRender;
    }
    instance.renderCache = [];
    isHmrUpdating = true;
    if (!(instance.job.flags & 8)) {
      instance.update();
    }
    isHmrUpdating = false;
  });
}
function reload(id, newComp) {
  const record = map.get(id);
  if (!record) return;
  newComp = normalizeClassComponent(newComp);
  updateComponentDef(record.initialDef, newComp);
  const instances = [...record.instances];
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    const oldComp = normalizeClassComponent(instance.type);
    let dirtyInstances = hmrDirtyComponents.get(oldComp);
    if (!dirtyInstances) {
      if (oldComp !== record.initialDef) {
        updateComponentDef(oldComp, newComp);
      }
      hmrDirtyComponents.set(oldComp, dirtyInstances = /* @__PURE__ */ new Set());
    }
    dirtyInstances.add(instance);
    instance.appContext.propsCache.delete(instance.type);
    instance.appContext.emitsCache.delete(instance.type);
    instance.appContext.optionsCache.delete(instance.type);
    if (instance.ceReload) {
      dirtyInstances.add(instance);
      instance.ceReload(newComp.styles);
      dirtyInstances.delete(instance);
    } else if (instance.parent) {
      queueJob(() => {
        if (!(instance.job.flags & 8)) {
          isHmrUpdating = true;
          instance.parent.update();
          isHmrUpdating = false;
          dirtyInstances.delete(instance);
        }
      });
    } else if (instance.appContext.reload) {
      instance.appContext.reload();
    } else if (typeof window !== "undefined") {
      window.location.reload();
    } else {
      console.warn(
        "[HMR] Root or manually mounted instance modified. Full reload required."
      );
    }
    if (instance.root.ce && instance !== instance.root) {
      instance.root.ce._removeChildStyle(oldComp);
    }
  }
  queuePostFlushCb(() => {
    hmrDirtyComponents.clear();
  });
}
function updateComponentDef(oldComp, newComp) {
  extend(oldComp, newComp);
  for (const key in oldComp) {
    if (key !== "__file" && !(key in newComp)) {
      delete oldComp[key];
    }
  }
}
function tryWrap(fn) {
  return (id, arg) => {
    try {
      return fn(id, arg);
    } catch (e) {
      console.error(e);
      console.warn(
        `[HMR] Something went wrong during Vue component hot-reload. Full reload required.`
      );
    }
  };
}
var currentRenderingInstance = null;
function inject(key, defaultValue, treatDefaultAsFactory = false) {
  const instance = getCurrentInstance();
  if (instance || currentApp) {
    let provides = currentApp ? currentApp._context.provides : instance ? instance.parent == null || instance.ce ? instance.vnode.appContext && instance.vnode.appContext.provides : instance.parent.provides : void 0;
    if (provides && key in provides) {
      return provides[key];
    } else if (arguments.length > 1) {
      return treatDefaultAsFactory && isFunction(defaultValue) ? defaultValue.call(instance && instance.proxy) : defaultValue;
    } else if (true) {
      warn$1(`injection "${String(key)}" not found.`);
    }
  } else if (true) {
    warn$1(`inject() can only be used inside setup() or functional components.`);
  }
}
var ssrContextKey = /* @__PURE__ */ Symbol.for("v-scx");
var useSSRContext = () => {
  {
    const ctx = inject(ssrContextKey);
    if (!ctx) {
      warn$1(
        `Server rendering context not provided. Make sure to only call useSSRContext() conditionally in the server build.`
      );
    }
    return ctx;
  }
};
function doWatch(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, flush, once } = options;
  if (!cb) {
    if (immediate !== void 0) {
      warn$1(
        `watch() "immediate" option is only respected when using the watch(source, callback, options?) signature.`
      );
    }
    if (deep !== void 0) {
      warn$1(
        `watch() "deep" option is only respected when using the watch(source, callback, options?) signature.`
      );
    }
    if (once !== void 0) {
      warn$1(
        `watch() "once" option is only respected when using the watch(source, callback, options?) signature.`
      );
    }
  }
  const baseWatchOptions = extend({}, options);
  if (true) baseWatchOptions.onWarn = warn$1;
  const runsImmediately = cb && immediate || !cb && flush !== "post";
  let ssrCleanup;
  if (isInSSRComponentSetup) {
    if (flush === "sync") {
      const ctx = useSSRContext();
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = []);
    } else if (!runsImmediately) {
      const watchStopHandle = () => {
      };
      watchStopHandle.stop = NOOP;
      watchStopHandle.resume = NOOP;
      watchStopHandle.pause = NOOP;
      return watchStopHandle;
    }
  }
  const instance = currentInstance;
  baseWatchOptions.call = (fn, type, args) => callWithAsyncErrorHandling(fn, instance, type, args);
  let isPre = false;
  if (flush === "post") {
    baseWatchOptions.scheduler = (job) => {
      queuePostRenderEffect(job, instance && instance.suspense);
    };
  } else if (flush !== "sync") {
    isPre = true;
    baseWatchOptions.scheduler = (job, isFirstRun) => {
      if (isFirstRun) {
        job();
      } else {
        queueJob(job);
      }
    };
  }
  baseWatchOptions.augmentJob = (job) => {
    if (cb) {
      job.flags |= 4;
    }
    if (isPre) {
      job.flags |= 2;
      if (instance) {
        job.id = instance.uid;
        job.i = instance;
      }
    }
  };
  const watchHandle = watch(source, cb, baseWatchOptions);
  if (isInSSRComponentSetup) {
    if (ssrCleanup) {
      ssrCleanup.push(watchHandle);
    } else if (runsImmediately) {
      watchHandle();
    }
  }
  return watchHandle;
}
function instanceWatch(source, value, options) {
  const publicThis = this.proxy;
  const getter = isString(source) ? source.includes(".") ? createPathGetter(publicThis, source) : () => publicThis[source] : source.bind(publicThis, publicThis);
  let cb;
  if (isFunction(value)) {
    cb = value;
  } else {
    cb = value.handler;
    options = value;
  }
  const reset = setCurrentInstance(this);
  const res = doWatch(getter, cb.bind(publicThis), options);
  reset();
  return res;
}
function createPathGetter(ctx, path) {
  const segments = path.split(".");
  return () => {
    let cur = ctx;
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]];
    }
    return cur;
  };
}
var requestIdleCallback = getGlobalThis().requestIdleCallback || ((cb) => setTimeout(cb, 1));
var cancelIdleCallback = getGlobalThis().cancelIdleCallback || ((id) => clearTimeout(id));
function injectHook(type, hook, target = currentInstance, prepend = false) {
  if (target) {
    const hooks = target[type] || (target[type] = []);
    const wrappedHook = hook.__weh || (hook.__weh = (...args) => {
      pauseTracking();
      const reset = setCurrentInstance(target);
      const res = callWithAsyncErrorHandling(hook, target, type, args);
      reset();
      resetTracking();
      return res;
    });
    if (prepend) {
      hooks.unshift(wrappedHook);
    } else {
      hooks.push(wrappedHook);
    }
    return wrappedHook;
  } else if (true) {
    const apiName = toHandlerKey(ErrorTypeStrings$1[type].replace(/ hook$/, ""));
    warn$1(
      `${apiName} is called when there is no active component instance to be associated with. Lifecycle injection APIs can only be used during execution of setup(). If you are using async setup(), make sure to register lifecycle hooks before the first await statement.`
    );
  }
}
var createHook = (lifecycle) => (hook, target = currentInstance) => {
  if (!isInSSRComponentSetup || lifecycle === "sp") {
    injectHook(lifecycle, (...args) => hook(...args), target);
  }
};
var onBeforeMount = createHook("bm");
var onMounted = createHook("m");
var onBeforeUpdate = createHook(
  "bu"
);
var onUpdated = createHook("u");
var onBeforeUnmount = createHook(
  "bum"
);
var onUnmounted = createHook("um");
var onServerPrefetch = createHook(
  "sp"
);
var onRenderTriggered = createHook("rtg");
var onRenderTracked = createHook("rtc");
var getPublicInstance = (i) => {
  if (!i) return null;
  if (isStatefulComponent(i)) return getComponentPublicInstance(i);
  return getPublicInstance(i.parent);
};
var publicPropertiesMap = (
  // Move PURE marker to new line to workaround compiler discarding it
  // due to type annotation
  /* @__PURE__ */ extend(/* @__PURE__ */ Object.create(null), {
    $: (i) => i,
    $el: (i) => i.vnode.el,
    $data: (i) => i.data,
    $props: (i) => true ? shallowReadonly(i.props) : i.props,
    $attrs: (i) => true ? shallowReadonly(i.attrs) : i.attrs,
    $slots: (i) => true ? shallowReadonly(i.slots) : i.slots,
    $refs: (i) => true ? shallowReadonly(i.refs) : i.refs,
    $parent: (i) => getPublicInstance(i.parent),
    $root: (i) => getPublicInstance(i.root),
    $host: (i) => i.ce,
    $emit: (i) => i.emit,
    $options: (i) => __VUE_OPTIONS_API__ ? resolveMergedOptions(i) : i.type,
    $forceUpdate: (i) => i.f || (i.f = () => {
      queueJob(i.update);
    }),
    $nextTick: (i) => i.n || (i.n = nextTick.bind(i.proxy)),
    $watch: (i) => __VUE_OPTIONS_API__ ? instanceWatch.bind(i) : NOOP
  })
);
var isReservedPrefix = (key) => key === "_" || key === "$";
var hasSetupBinding = (state, key) => state !== EMPTY_OBJ && !state.__isScriptSetup && hasOwn(state, key);
var PublicInstanceProxyHandlers = {
  get({ _: instance }, key) {
    if (key === "__v_skip") {
      return true;
    }
    const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
    if (key === "__isVue") {
      return true;
    }
    if (key[0] !== "$") {
      const n = accessCache[key];
      if (n !== void 0) {
        switch (n) {
          case 1:
            return setupState[key];
          case 2:
            return data[key];
          case 4:
            return ctx[key];
          case 3:
            return props[key];
        }
      } else if (hasSetupBinding(setupState, key)) {
        accessCache[key] = 1;
        return setupState[key];
      } else if (__VUE_OPTIONS_API__ && data !== EMPTY_OBJ && hasOwn(data, key)) {
        accessCache[key] = 2;
        return data[key];
      } else if (hasOwn(props, key)) {
        accessCache[key] = 3;
        return props[key];
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        accessCache[key] = 4;
        return ctx[key];
      } else if (!__VUE_OPTIONS_API__ || shouldCacheAccess) {
        accessCache[key] = 0;
      }
    }
    const publicGetter = publicPropertiesMap[key];
    let cssModule, globalProperties;
    if (publicGetter) {
      if (key === "$attrs") {
        track(instance.attrs, "get", "");
        markAttrsAccessed();
      } else if (key === "$slots") {
        track(instance, "get", key);
      }
      return publicGetter(instance);
    } else if (
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) && (cssModule = cssModule[key])
    ) {
      return cssModule;
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      accessCache[key] = 4;
      return ctx[key];
    } else if (
      // global properties
      globalProperties = appContext.config.globalProperties, hasOwn(globalProperties, key)
    ) {
      {
        return globalProperties[key];
      }
    } else if (currentRenderingInstance && (!isString(key) || // #1091 avoid internal isRef/isVNode checks on component instance leading
    // to infinite warning loop
    key.indexOf("__v") !== 0)) {
      if (data !== EMPTY_OBJ && isReservedPrefix(key[0]) && hasOwn(data, key)) {
        warn$1(
          `Property ${JSON.stringify(
            key
          )} must be accessed via $data because it starts with a reserved character ("$" or "_") and is not proxied on the render context.`
        );
      } else if (instance === currentRenderingInstance) {
        warn$1(
          `Property ${JSON.stringify(key)} was accessed during render but is not defined on instance.`
        );
      }
    }
  },
  set({ _: instance }, key, value) {
    const { data, setupState, ctx } = instance;
    if (hasSetupBinding(setupState, key)) {
      setupState[key] = value;
      return true;
    } else if (setupState.__isScriptSetup && hasOwn(setupState, key)) {
      warn$1(`Cannot mutate <script setup> binding "${key}" from Options API.`);
      return false;
    } else if (__VUE_OPTIONS_API__ && data !== EMPTY_OBJ && hasOwn(data, key)) {
      data[key] = value;
      return true;
    } else if (hasOwn(instance.props, key)) {
      warn$1(`Attempting to mutate prop "${key}". Props are readonly.`);
      return false;
    }
    if (key[0] === "$" && key.slice(1) in instance) {
      warn$1(
        `Attempting to mutate public property "${key}". Properties starting with $ are reserved and readonly.`
      );
      return false;
    } else {
      if (key in instance.appContext.config.globalProperties) {
        Object.defineProperty(ctx, key, {
          enumerable: true,
          configurable: true,
          value
        });
      } else {
        ctx[key] = value;
      }
    }
    return true;
  },
  has({
    _: { data, setupState, accessCache, ctx, appContext, props, type }
  }, key) {
    let cssModules;
    return !!(accessCache[key] || __VUE_OPTIONS_API__ && data !== EMPTY_OBJ && key[0] !== "$" && hasOwn(data, key) || hasSetupBinding(setupState, key) || hasOwn(props, key) || hasOwn(ctx, key) || hasOwn(publicPropertiesMap, key) || hasOwn(appContext.config.globalProperties, key) || (cssModules = type.__cssModules) && cssModules[key]);
  },
  defineProperty(target, key, descriptor) {
    if (descriptor.get != null) {
      target._.accessCache[key] = 0;
    } else if (hasOwn(descriptor, "value")) {
      this.set(target, key, descriptor.value, null);
    }
    return Reflect.defineProperty(target, key, descriptor);
  }
};
if (true) {
  PublicInstanceProxyHandlers.ownKeys = (target) => {
    warn$1(
      `Avoid app logic that relies on enumerating keys on a component instance. The keys will be empty in production mode to avoid performance overhead.`
    );
    return Reflect.ownKeys(target);
  };
}
function normalizePropsOrEmits(props) {
  return isArray(props) ? props.reduce(
    (normalized, p) => (normalized[p] = null, normalized),
    {}
  ) : props;
}
var shouldCacheAccess = true;
function resolveMergedOptions(instance) {
  const base = instance.type;
  const { mixins, extends: extendsOptions } = base;
  const {
    mixins: globalMixins,
    optionsCache: cache,
    config: { optionMergeStrategies }
  } = instance.appContext;
  const cached = cache.get(base);
  let resolved;
  if (cached) {
    resolved = cached;
  } else if (!globalMixins.length && !mixins && !extendsOptions) {
    {
      resolved = base;
    }
  } else {
    resolved = {};
    if (globalMixins.length) {
      globalMixins.forEach(
        (m) => mergeOptions(resolved, m, optionMergeStrategies, true)
      );
    }
    mergeOptions(resolved, base, optionMergeStrategies);
  }
  if (isObject(base)) {
    cache.set(base, resolved);
  }
  return resolved;
}
function mergeOptions(to, from, strats, asMixin = false) {
  const { mixins, extends: extendsOptions } = from;
  if (extendsOptions) {
    mergeOptions(to, extendsOptions, strats, true);
  }
  if (mixins) {
    mixins.forEach(
      (m) => mergeOptions(to, m, strats, true)
    );
  }
  for (const key in from) {
    if (asMixin && key === "expose") {
      warn$1(
        `"expose" option is ignored when declared in mixins or extends. It should only be declared in the base component itself.`
      );
    } else {
      const strat = internalOptionMergeStrats[key] || strats && strats[key];
      to[key] = strat ? strat(to[key], from[key]) : from[key];
    }
  }
  return to;
}
var internalOptionMergeStrats = {
  data: mergeDataFn,
  props: mergeEmitsOrPropsOptions,
  emits: mergeEmitsOrPropsOptions,
  // objects
  methods: mergeObjectOptions,
  computed: mergeObjectOptions,
  // lifecycle
  beforeCreate: mergeAsArray,
  created: mergeAsArray,
  beforeMount: mergeAsArray,
  mounted: mergeAsArray,
  beforeUpdate: mergeAsArray,
  updated: mergeAsArray,
  beforeDestroy: mergeAsArray,
  beforeUnmount: mergeAsArray,
  destroyed: mergeAsArray,
  unmounted: mergeAsArray,
  activated: mergeAsArray,
  deactivated: mergeAsArray,
  errorCaptured: mergeAsArray,
  serverPrefetch: mergeAsArray,
  // assets
  components: mergeObjectOptions,
  directives: mergeObjectOptions,
  // watch
  watch: mergeWatchOptions,
  // provide / inject
  provide: mergeDataFn,
  inject: mergeInject
};
function mergeDataFn(to, from) {
  if (!from) {
    return to;
  }
  if (!to) {
    return from;
  }
  return function mergedDataFn() {
    return extend(
      isFunction(to) ? to.call(this, this) : to,
      isFunction(from) ? from.call(this, this) : from
    );
  };
}
function mergeInject(to, from) {
  return mergeObjectOptions(normalizeInject(to), normalizeInject(from));
}
function normalizeInject(raw) {
  if (isArray(raw)) {
    const res = {};
    for (let i = 0; i < raw.length; i++) {
      res[raw[i]] = raw[i];
    }
    return res;
  }
  return raw;
}
function mergeAsArray(to, from) {
  return to ? [...new Set([].concat(to, from))] : from;
}
function mergeObjectOptions(to, from) {
  return to ? extend(/* @__PURE__ */ Object.create(null), to, from) : from;
}
function mergeEmitsOrPropsOptions(to, from) {
  if (to) {
    if (isArray(to) && isArray(from)) {
      return [.../* @__PURE__ */ new Set([...to, ...from])];
    }
    return extend(
      /* @__PURE__ */ Object.create(null),
      normalizePropsOrEmits(to),
      normalizePropsOrEmits(from != null ? from : {})
    );
  } else {
    return from;
  }
}
function mergeWatchOptions(to, from) {
  if (!to) return from;
  if (!from) return to;
  const merged = extend(/* @__PURE__ */ Object.create(null), to);
  for (const key in from) {
    merged[key] = mergeAsArray(to[key], from[key]);
  }
  return merged;
}
function createAppContext() {
  return {
    app: null,
    config: {
      isNativeTag: NO,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: void 0,
      warnHandler: void 0,
      compilerOptions: {}
    },
    mixins: [],
    components: {},
    directives: {},
    provides: /* @__PURE__ */ Object.create(null),
    optionsCache: /* @__PURE__ */ new WeakMap(),
    propsCache: /* @__PURE__ */ new WeakMap(),
    emitsCache: /* @__PURE__ */ new WeakMap()
  };
}
var currentApp = null;
var accessedAttrs = false;
function markAttrsAccessed() {
  accessedAttrs = true;
}
var queuePostRenderEffect = queueEffectWithSuspense;
function queueEffectWithSuspense(fn, suspense) {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn);
    } else {
      suspense.effects.push(fn);
    }
  } else {
    queuePostFlushCb(fn);
  }
}
var emptyAppContext = createAppContext();
var currentInstance = null;
var getCurrentInstance = () => currentInstance || currentRenderingInstance;
var internalSetCurrentInstance;
var setInSSRSetupState;
{
  const g = getGlobalThis();
  const registerGlobalSetter = (key, setter) => {
    let setters;
    if (!(setters = g[key])) setters = g[key] = [];
    setters.push(setter);
    return (v) => {
      if (setters.length > 1) setters.forEach((set) => set(v));
      else setters[0](v);
    };
  };
  internalSetCurrentInstance = registerGlobalSetter(
    `__VUE_INSTANCE_SETTERS__`,
    (v) => currentInstance = v
  );
  setInSSRSetupState = registerGlobalSetter(
    `__VUE_SSR_SETTERS__`,
    (v) => isInSSRComponentSetup = v
  );
}
var setCurrentInstance = (instance) => {
  const prev = currentInstance;
  internalSetCurrentInstance(instance);
  instance.scope.on();
  return () => {
    instance.scope.off();
    internalSetCurrentInstance(prev);
  };
};
function isStatefulComponent(instance) {
  return instance.vnode.shapeFlag & 4;
}
var isInSSRComponentSetup = false;
function getComponentPublicInstance(instance) {
  if (instance.exposed) {
    return instance.exposeProxy || (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
      get(target, key) {
        if (key in target) {
          return target[key];
        } else if (key in publicPropertiesMap) {
          return publicPropertiesMap[key](instance);
        }
      },
      has(target, key) {
        return key in target || key in publicPropertiesMap;
      }
    }));
  } else {
    return instance.proxy;
  }
}
var classifyRE = /(?:^|[-_])\w/g;
var classify = (str2) => str2.replace(classifyRE, (c) => c.toUpperCase()).replace(/[-_]/g, "");
function getComponentName(Component, includeInferred = true) {
  return isFunction(Component) ? Component.displayName || Component.name : Component.name || includeInferred && Component.__name;
}
function formatComponentName(instance, Component, isRoot = false) {
  let name = getComponentName(Component);
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/);
    if (match) {
      name = match[1];
    }
  }
  if (!name && instance) {
    const inferFromRegistry = (registry) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key;
        }
      }
    };
    name = inferFromRegistry(instance.components) || instance.parent && inferFromRegistry(
      instance.parent.type.components
    ) || inferFromRegistry(instance.appContext.components);
  }
  return name ? classify(name) : isRoot ? `App` : `Anonymous`;
}
function isClassComponent(value) {
  return isFunction(value) && "__vccOpts" in value;
}
function initCustomFormatter() {
  if (typeof window === "undefined") {
    return;
  }
  const vueStyle = { style: "color:#3ba776" };
  const numberStyle = { style: "color:#1677ff" };
  const stringStyle = { style: "color:#f5222d" };
  const keywordStyle = { style: "color:#eb2f96" };
  const formatter = {
    __vue_custom_formatter: true,
    header(obj) {
      if (!isObject(obj)) {
        return null;
      }
      if (obj.__isVue) {
        return ["div", vueStyle, `VueInstance`];
      } else if (isRef(obj)) {
        pauseTracking();
        const value = obj.value;
        resetTracking();
        return [
          "div",
          {},
          ["span", vueStyle, genRefFlag(obj)],
          "<",
          formatValue(value),
          `>`
        ];
      } else if (isReactive(obj)) {
        return [
          "div",
          {},
          ["span", vueStyle, isShallow(obj) ? "ShallowReactive" : "Reactive"],
          "<",
          formatValue(obj),
          `>${isReadonly(obj) ? ` (readonly)` : ``}`
        ];
      } else if (isReadonly(obj)) {
        return [
          "div",
          {},
          ["span", vueStyle, isShallow(obj) ? "ShallowReadonly" : "Readonly"],
          "<",
          formatValue(obj),
          ">"
        ];
      }
      return null;
    },
    hasBody(obj) {
      return obj && obj.__isVue;
    },
    body(obj) {
      if (obj && obj.__isVue) {
        return [
          "div",
          {},
          ...formatInstance(obj.$)
        ];
      }
    }
  };
  function formatInstance(instance) {
    const blocks = [];
    if (instance.type.props && instance.props) {
      blocks.push(createInstanceBlock("props", toRaw(instance.props)));
    }
    if (instance.setupState !== EMPTY_OBJ) {
      blocks.push(createInstanceBlock("setup", instance.setupState));
    }
    if (instance.data !== EMPTY_OBJ) {
      blocks.push(createInstanceBlock("data", toRaw(instance.data)));
    }
    const computed2 = extractKeys(instance, "computed");
    if (computed2) {
      blocks.push(createInstanceBlock("computed", computed2));
    }
    const injected = extractKeys(instance, "inject");
    if (injected) {
      blocks.push(createInstanceBlock("injected", injected));
    }
    blocks.push([
      "div",
      {},
      [
        "span",
        {
          style: keywordStyle.style + ";opacity:0.66"
        },
        "$ (internal): "
      ],
      ["object", { object: instance }]
    ]);
    return blocks;
  }
  function createInstanceBlock(type, target) {
    target = extend({}, target);
    if (!Object.keys(target).length) {
      return ["span", {}];
    }
    return [
      "div",
      { style: "line-height:1.25em;margin-bottom:0.6em" },
      [
        "div",
        {
          style: "color:#476582"
        },
        type
      ],
      [
        "div",
        {
          style: "padding-left:1.25em"
        },
        ...Object.keys(target).map((key) => {
          return [
            "div",
            {},
            ["span", keywordStyle, key + ": "],
            formatValue(target[key], false)
          ];
        })
      ]
    ];
  }
  function formatValue(v, asRaw = true) {
    if (typeof v === "number") {
      return ["span", numberStyle, v];
    } else if (typeof v === "string") {
      return ["span", stringStyle, JSON.stringify(v)];
    } else if (typeof v === "boolean") {
      return ["span", keywordStyle, v];
    } else if (isObject(v)) {
      return ["object", { object: asRaw ? toRaw(v) : v }];
    } else {
      return ["span", stringStyle, String(v)];
    }
  }
  function extractKeys(instance, type) {
    const Comp = instance.type;
    if (isFunction(Comp)) {
      return;
    }
    const extracted = {};
    for (const key in instance.ctx) {
      if (isKeyOfType(Comp, key, type)) {
        extracted[key] = instance.ctx[key];
      }
    }
    return extracted;
  }
  function isKeyOfType(Comp, key, type) {
    const opts = Comp[type];
    if (isArray(opts) && opts.includes(key) || isObject(opts) && key in opts) {
      return true;
    }
    if (Comp.extends && isKeyOfType(Comp.extends, key, type)) {
      return true;
    }
    if (Comp.mixins && Comp.mixins.some((m) => isKeyOfType(m, key, type))) {
      return true;
    }
  }
  function genRefFlag(v) {
    if (isShallow(v)) {
      return `ShallowRef`;
    }
    if (v.effect) {
      return `ComputedRef`;
    }
    return `Ref`;
  }
  if (window.devtoolsFormatters) {
    window.devtoolsFormatters.push(formatter);
  } else {
    window.devtoolsFormatters = [formatter];
  }
}

// node_modules/.pnpm/vue@3.5.34_typescript@5.6.3/node_modules/vue/dist/vue.runtime.esm-bundler.js
function initDev() {
  {
    initCustomFormatter();
  }
}
if (true) {
  initDev();
}

// src/components/views/worldsim/wsBldMode.ts
var WS_BLD_MODE_KEY = "wsm:v1:bldmode";
var WS_BLD_MODE_LEAN = "lean";
var WS_BLD_MODE_MANY = "many";
function bldModeOf(raw) {
  return raw === WS_BLD_MODE_MANY ? WS_BLD_MODE_MANY : WS_BLD_MODE_LEAN;
}
function readBldMode() {
  try {
    if (typeof localStorage === "undefined") return WS_BLD_MODE_LEAN;
    return bldModeOf(localStorage.getItem(WS_BLD_MODE_KEY));
  } catch {
    return WS_BLD_MODE_LEAN;
  }
}
function writeBldMode(mode) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WS_BLD_MODE_KEY, mode);
  } catch {
  }
}
var modeRef = null;
function useWsBldMode() {
  if (!modeRef) modeRef = ref(readBldMode());
  const mode = modeRef;
  function setMode(m) {
    const next = bldModeOf(m);
    mode.value = next;
    writeBldMode(next);
    return next;
  }
  function toggleMode() {
    return setMode(mode.value === WS_BLD_MODE_MANY ? WS_BLD_MODE_LEAN : WS_BLD_MODE_MANY);
  }
  return { mode, setMode, toggleMode };
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
    /* 顺序有意义（自下而上）：bg → base → [hi] → [tint] → ref。
       楼房的图层由 `addLayer(l, "ref")` 插到 **ref 之前** ⇒ 自动落在线罩**之上**。
       `ref` 必须留在最后一条：它是楼房层的插入锚点。 */
    layers: parts.layers
  };
}
var WS_BLD_VECTOR_MINZOOM = 11;
var WS_BLD_FOOTPRINT_OPACITY = 0.35;
var WS_BLD_OUTLINE_FULL_ZOOM = 15;
var WS_BLD_SMALL_M2 = 220;
function bldFootprintAreaM2(f) {
  const g = f && f.geometry || {};
  const ring = (g.coordinates || [])[0] || [];
  if (ring.length < 3) return 0;
  let lat0 = 0;
  for (const q of ring) lat0 += q[1];
  lat0 /= ring.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(a) / 2;
}
function dressBase(features, opts = {}) {
  const counts = { n: 0, real: 0, levels: 0, kind: 0 };
  const out = [];
  const ramp = opts.ramp ?? HEIGHT_COLOR_RAMP;
  const zoom = typeof opts.zoom === "number" && isFinite(opts.zoom) ? opts.zoom : null;
  const roofOn = zoom === null || bldLayerVisibilityAt(WS_BLD_DETAIL_ROOF_ZOOM, null, zoom) === "visible";
  const equipOn = zoom === null || bldLayerVisibilityAt(WS_BLD_DETAIL_EQUIP_ZOOM, null, zoom) === "visible";
  const mode = "roof";
  for (const f of features || []) {
    const fp = bldFootprintAreaM2(f);
    const set = buildingPartSet(
      f,
      ramp,
      { mode }
    );
    counts.n += 1;
    if (set.parts[0]) {
      const from = set.parts[0].properties?.h_from;
      if (from === "real") counts.real += 1;
      else if (from === "levels") counts.levels += 1;
      else counts.kind += 1;
    }
    for (const part of set.parts) {
      const p = part.properties || {};
      const zt = bldTierOfPart(p.part);
      if (zt === 1 && !roofOn) continue;
      if (zt === 2 && !equipOn) continue;
      out.push({
        ...part,
        properties: { ...p, fp: Math.round(fp), small: fp < WS_BLD_SMALL_M2 ? 1 : 0 }
      });
    }
  }
  return { features: out, counts };
}
function bldLayerSpecsFor(theme, tier, opts = {}) {
  const th = theme;
  const P = bldArtParamsOf(th, { art: opts.art ?? 1, look: opts.look ?? 1 });
  const tierFilter = (t) => t === 0 ? ["==", ["coalesce", ["get", "zt"], 0], 0] : ["==", ["get", "zt"], t];
  const bldColorExpr = ["coalesce", ["get", "color3d"], P.rampColor];
  const detailPaint = {
    "fill-extrusion-height": ["get", "h3d"],
    "fill-extrusion-base": ["coalesce", ["get", "h_base"], ["coalesce", ["get", "min_height"], 0]],
    "fill-extrusion-opacity": P.opacity,
    "fill-extrusion-vertical-gradient": P.vgrad,
    "fill-extrusion-color": bldColorExpr
  };
  const footLayer = {
    id: "bld-foot",
    type: "fill",
    source: "bld",
    minzoom: WS_BLD_VECTOR_MINZOOM,
    maxzoom: WS_BLD_FOOTPRINT_MAXZOOM,
    filter: tierFilter(0),
    paint: {
      "fill-color": bldColorExpr,
      "fill-opacity": WS_BLD_FOOTPRINT_OPACITY
    }
  };
  const roofLayer = {
    id: "bld-roof",
    type: "fill-extrusion",
    source: "bld",
    minzoom: WS_BLD_DETAIL_ROOF_ZOOM,
    filter: tierFilter(1),
    paint: { ...detailPaint }
  };
  const equipLayer = {
    id: "bld-equip",
    type: "fill-extrusion",
    source: "bld",
    minzoom: WS_BLD_DETAIL_EQUIP_ZOOM,
    filter: tierFilter(2),
    paint: { ...detailPaint }
  };
  const outlineLayers = tier.outlineWidth !== null ? [{
    id: "bld-line",
    type: "line",
    source: "bld",
    /* 2026-10-03（§4 表那一笔）：**低缩放不再给同一批要素画第二遍**。
       足迹档（z<14）已经有一层 `fill`（`bld-foot`）在画同一批要素，再叠一层描边就是方案 §1②
       里那片"深色小面/灯芯绒"（每栋 1~2px，描边把填充整个盖掉）。
       **闸开在 `minzoom` 这一侧**（= 描边只在立体档 `z ≥ WS_BLD_FOOTPRINT_MAXZOOM` 画）。
          方案 §4 表把这一步写成"加 `maxzoom`"，但按 MapLibre 语义（`minzoom ≤ z < maxzoom`，
          见上面 `bld-foot` 那段注释）`maxzoom: 14` 是**把 z≥14 的描边整层关掉** —— 那既治不了
          低缩放（z<14 照样两层），又违反同一个方案 §验收 6「**`bld-line` 行为与 v95 同
          （近景是已确认的，不许动）**」。⇒ 取**能满足两边意图**的那一侧：低缩放不画、
          z≥14 与 v95 逐字节同（`?bldn=`/`?bld=2`/低端档那几条路都不受影响）。
       代拍页 `bldLineLayer` 必须同一份规格（`ws_pages_consistency.mjs` ④b 盯着 minzoom）。 */
    minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
    /* **描边宽度 = 共享取参给的那一个**（`P.lineWidth`）：`art=1` ⇒ 主题给的**固定宽**；
       `art≥2` ⇒ `WS_BLD_OUTLINE_STOPS` 的 zoom 插值。**与代拍页逐字段相同**。 */
    paint: {
      "line-color": P.outline.color,
      "line-width": P.lineWidth
    }
  }] : [];
  if ((opts.mode ?? "base") === "base") {
    return [
      footLayer,
      {
        id: "bld-ext",
        type: "fill-extrusion",
        source: "bld",
        minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
        filter: tierFilter(0),
        paint: { ...detailPaint }
      },
      roofLayer,
      equipLayer,
      ...outlineLayers
    ];
  }
  return [
    footLayer,
    {
      id: "bld-ext",
      type: "fill-extrusion",
      source: "bld",
      minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
      filter: tierFilter(0),
      paint: { ...detailPaint }
    },
    roofLayer,
    equipLayer,
    ...outlineLayers
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
var bldDataSig = /* @__PURE__ */ new WeakMap();
function bldDataSigOf(data) {
  const feats = data?.features;
  if (!Array.isArray(feats)) return null;
  let sig = feats.length + "|";
  for (const f of feats) sig += String(f?.id ?? "") + ",";
  return sig;
}
function applyBuildingsTo(m, data, specs) {
  const sig = bldDataSigOf(data);
  if (m.getSource("bld")) {
    if (sig !== null && bldDataSig.get(m) === sig) return;
    if (sig !== null) bldDataSig.set(m, sig);
    m.getSource("bld").setData(data);
    return;
  }
  m.addSource("bld", { type: "geojson", data });
  if (sig !== null) bldDataSig.set(m, sig);
  const before = planBeforeOf(m, "buildings") ?? (m.getLayer("ref") ? "ref" : void 0);
  for (const l of specs) m.addLayer(l, before);
}
function mvtHeightColorExpression(art) {
  const base = art && art.rampColor ? art.rampColor : heightColorExpression();
  return swapField(base, "h3d", "h");
}
function mvtArtFromLegacySpecs(specs) {
  if (!Array.isArray(specs) || !specs.length) return void 0;
  const find = (id) => specs.find((l) => l && l.id === id);
  const ext = find("bld-ext"), line = find("bld-line");
  const ep = ext && ext.paint || {};
  const col = ep["fill-extrusion-color"];
  const ramp = Array.isArray(col) && col[0] === "coalesce" && col.length >= 3 ? col[2] : void 0;
  const lp = line && line.paint || {};
  const out = {
    rampColor: ramp,
    vgrad: ep["fill-extrusion-vertical-gradient"] === true,
    opacity: typeof ep["fill-extrusion-opacity"] === "number" ? ep["fill-extrusion-opacity"] : void 0,
    lineWidth: lp["line-width"],
    outline: lp["line-color"] === void 0 ? null : { color: lp["line-color"] }
  };
  return out;
}
var MVT_BLD_LAYER_IDS = ["bld-foot", "bld-ext", "bld-roof", "bld-equip", "bld-line"];
var MVT_BLD_LAYER_TIER = {
  "bld-foot": 0,
  "bld-ext": 0,
  "bld-roof": 1,
  "bld-equip": 2,
  "bld-line": 0
};
function mvtTierFilter(t) {
  return t === 0 ? ["==", ["coalesce", ["get", "zt"], 0], 0] : ["==", ["get", "zt"], t];
}
function mvtKNow() {
  let pin = null;
  try {
    pin = typeof location !== "undefined" ? bldKPinOf(location.search) : null;
  } catch {
    pin = null;
  }
  if (pin !== null) return pin;
  return bldMaxDrawnOf(useWsBldMode().mode.value);
}
function mvtBldRkFilter(k) {
  const n = Number.isFinite(Number(k)) ? Math.max(0, Math.floor(Number(k))) : 0;
  return ["<", ["get", "rk"], n];
}
function mvtBldLayerFilter(t, k) {
  return ["all", mvtTierFilter(t), mvtBldRkFilter(k)];
}
var mvtKApplied = /* @__PURE__ */ new WeakMap();
function applyMvtBldKFilter(m, k) {
  if (!m || typeof m.setFilter !== "function") return 0;
  const n = Number.isFinite(Number(k)) ? Math.max(0, Math.floor(Number(k))) : 0;
  if (mvtKApplied.has(m) && mvtKApplied.get(m) === n) return 0;
  let wrote = 0;
  for (const id of MVT_BLD_LAYER_IDS) {
    if (!m.getLayer(id)) continue;
    const t = MVT_BLD_LAYER_TIER[id] ?? 0;
    try {
      m.setFilter(id, mvtBldLayerFilter(t, n));
      wrote += 1;
    } catch {
    }
  }
  if (wrote > 0) mvtKApplied.set(m, n);
  return wrote;
}
function mvtBldLayerSpecs(k, useRk, art) {
  const kk = k !== void 0 ? Math.max(0, Math.floor(Number(k)) || 0) : useRk === true ? mvtKNow() : 0;
  const withRk = useRk === true;
  const filterOf = (t) => withRk ? mvtBldLayerFilter(t, kk) : mvtTierFilter(t);
  const ramp = mvtHeightColorExpression(art);
  const extPaint = extrusionPaint({ rampExpr: ramp, vgrad: art ? art.vgrad : false, opacity: art ? art.opacity : 0.95 });
  const footPaintSpec = footPaint({ rampExpr: ramp, opacity: WS_BLD_FOOTPRINT_OPACITY });
  const linePaint = outlinePaint({ color: art && art.outline ? art.outline.color : void 0, width: art ? art.lineWidth : void 0, fallbackRamp: ramp });
  const src = { source: "bld", "source-layer": "bld" };
  return [
    {
      id: "bld-foot",
      type: "fill",
      ...src,
      minzoom: WS_BLD_VECTOR_MINZOOM,
      maxzoom: WS_BLD_FOOTPRINT_MAXZOOM,
      filter: filterOf(0),
      paint: { ...footPaintSpec }
    },
    {
      id: "bld-ext",
      type: "fill-extrusion",
      ...src,
      minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
      filter: filterOf(0),
      paint: { ...extPaint }
    },
    {
      id: "bld-roof",
      type: "fill-extrusion",
      ...src,
      minzoom: WS_BLD_DETAIL_ROOF_ZOOM,
      filter: filterOf(1),
      paint: { ...extPaint }
    },
    {
      id: "bld-equip",
      type: "fill-extrusion",
      ...src,
      minzoom: WS_BLD_DETAIL_EQUIP_ZOOM,
      filter: filterOf(2),
      paint: { ...extPaint }
    },
    {
      id: "bld-line",
      type: "line",
      ...src,
      minzoom: WS_BLD_FOOTPRINT_MAXZOOM,
      paint: { ...linePaint },
      filter: filterOf(0)
    }
  ];
}
function applyMvtTo(m, template, art) {
  if (!m.getSource("bld")) {
    m.addSource("bld", { type: "vector", tiles: [template], minzoom: WS_BLD_VECTOR_MINZOOM, maxzoom: 16 });
  }
  const before = planBeforeOf(m, "buildings") ?? (m.getLayer("ref") ? "ref" : void 0);
  for (const l of mvtBldLayerSpecs(void 0, void 0, art)) if (!m.getLayer(l.id)) m.addLayer(l, before);
}
function bldLayersPresent(m) {
  try {
    if (!m) return false;
    return !!(m.getSource("bld") && m.getLayer("bld-ext"));
  } catch {
    return false;
  }
}
function ensureBldLayers(m, specs) {
  if (!m) return 0;
  let added = 0;
  try {
    const before = planBeforeOf(m, "buildings") ?? (m.getLayer("ref") ? "ref" : void 0);
    for (const l of specs) {
      const id = String(l.id ?? "");
      if (!id || m.getLayer(id)) continue;
      m.addLayer(l, before);
      added += 1;
    }
  } catch {
  }
  return added;
}
function flushBldStore(opts, why = "flush") {
  const mvt = opts.mvt ? opts.mvt() : null;
  if (mvt) {
    const raw = opts.features();
    const data2 = { type: "FeatureCollection", features: raw };
    opts.beforeDraw?.(why, data2);
    const mm = opts.map();
    if (!mm) {
      opts.onNoMap?.(data2);
      return;
    }
    let art;
    try {
      art = mvtArtFromLegacySpecs(opts.specs());
    } catch {
      art = void 0;
    }
    applyMvtTo(mm, mvt.template, art);
    opts.afterDraw?.(why, data2);
    opts.afterMvtRegister?.();
    return;
  }
  let drawn = opts.features();
  if (opts.pick) {
    const r = opts.pick(drawn);
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
  opts.afterMvtRegister?.();
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

// src/components/views/worldsim/wsBldProfile.ts
var WS_BLD_PROFILE_KEY = "wsm:v1:profile";
var WS_BLD_PROFILE_SLIM = "slim";
var WS_BLD_PROFILE_FULL = "full";
function bldProfileOf(raw) {
  return raw === WS_BLD_PROFILE_FULL ? WS_BLD_PROFILE_FULL : WS_BLD_PROFILE_SLIM;
}
function readBldProfile() {
  try {
    if (typeof localStorage === "undefined") return WS_BLD_PROFILE_SLIM;
    return bldProfileOf(localStorage.getItem(WS_BLD_PROFILE_KEY));
  } catch {
    return WS_BLD_PROFILE_SLIM;
  }
}
function bldProfileFromSearch(search) {
  let q = search;
  if (q === void 0) {
    try {
      q = typeof location !== "undefined" ? location.search : "";
    } catch {
      q = "";
    }
  }
  const m = /[?&]profile=(slim|full)\b/i.exec(String(q || ""));
  return m ? bldProfileOf(m[1].toLowerCase()) : null;
}
function effectiveBldProfile(search) {
  return bldProfileFromSearch(search) ?? readBldProfile();
}
function bldBundleDirOf(profile) {
  return profile === WS_BLD_PROFILE_FULL ? "bldbundle-002" : "bldbundle-002-slim";
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
var DEFAULT_FLUSH_COALESCE_MS = 300;
var DEFAULT_PARSED_CACHE_CELLS = 3;
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
  let list = (spec.dirs && spec.dirs.length ? spec.dirs : [spec.dir]).slice();
  if (spec.dir === "bldbundle") {
    const slim = bldBundleDirOf("slim");
    const full = bldBundleDirOf("full");
    const prof = effectiveBldProfile();
    if (prof === "slim" && list.indexOf(slim) >= 0) list = [slim, ...list.filter((d) => d !== slim)];
    else if (prof === "full") list = list.filter((d) => d !== slim || d === full);
  }
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
function parseBundleJson(kind, json) {
  return SPECS[kind].parse(json);
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
    /* **分片包优先**：`bldbundle-002`（细子格，格尺寸以它自己的 `index.cellSize` 为准）在就在前面，
       不在就退回老包 `bldbundle`（0.05°，**唯一被端到端验过的一版**，先别删）。 */
    dirs: ["bldbundle-002", "bldbundle-002-slim", "bldbundle"],
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
  /* **水/绿地**（第四种包）：目录 `gwbundle`、格边长 `GW_BUNDLE_CELL_DEG`（= 0.05°）、
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
  let pinDeg = null;
  const coalesceMs = Math.max(0, Math.floor(Number(
    opts.flushCoalesceMs === void 0 || opts.flushCoalesceMs === null ? DEFAULT_FLUSH_COALESCE_MS : opts.flushCoalesceMs
  )));
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
  const cacheCells = Math.max(0, Math.floor(Number(
    opts.parsedCacheCells === void 0 || opts.parsedCacheCells === null ? DEFAULT_PARSED_CACHE_CELLS : opts.parsedCacheCells
  )));
  const parsedCache = /* @__PURE__ */ new Map();
  let cacheHits = 0;
  let parseWorkerFallback = 0;
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
        const callerPin = Number(opts.expectCellDeg);
        const pin = Number.isFinite(callerPin) && callerPin > 0 ? callerPin : NaN;
        pinDeg = Number.isFinite(pin) ? pin : null;
        if (pkg === null) {
          indexState = "已读";
          if (Number.isFinite(pin) && pin > 0) {
            effCellDeg = pin;
            indexWhy = `包里没有可用的 cellSize（缺字段 / 坏值）⇒ 按调用方**钉住的** ${pin}° 算格键`;
          } else {
            effCellDeg = spec.cellDeg;
            indexWhy = "包里没有可用的 cellSize（缺字段 / 坏值）⇒ 按兜底常量 " + spec.cellDeg + "° 算（数不出来就说不出来）";
          }
          return f;
        }
        if (Number.isFinite(pin) && Math.abs(pkg - pin) > 1e-9) {
          indexState = "口径不符";
          refused = true;
          indexWhy = `包（${d}）按 ${pkg}° 分格、但调用方**显式钉住**的是 ${pin}° ⇒ 格键与索引零交集，拒绝取数（否则会把有数据的格说成「包外」）`;
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
      return last || {
        kind: opts.kind,
        url: "",
        source: null,
        cellCount: null,
        cells: null,
        attribution: null,
        real: null,
        cellSize: null,
        cellBytes: null,
        cellBld: null,
        cellSizeByLayer: null,
        layerCellSizeSole: null,
        ok: false,
        why: `试过 ${tried} 个目录都没读到索引`
      };
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
      /* 钉住的值走**同一套校验**（有限且 > 0）——  2026-10-01 抓到：旧写法用
         `Number(opts.expectCellDeg)`，`?cell=0` 时 `Number(null)===0` 会被当成合法值 ⇒
         facts 里印「钉 0°」而 `cellDegExpect=null`，同一条回证自相矛盾。 */
      refused,
      cellDeg: effectiveDeg(),
      cellDegPin: pinDeg,
      /* 解析搬 Worker 的实况（2026-10-10）：开没开 + 退回同步过几次（**不静默降级**要能读出来） */
      parseWorker: { on: !!opts.parseAsync, fallback: parseWorkerFallback },
      /* 这一场**实际拿去对拍**的期望值（= 调用方显式钉；没钉 = null）——
         判词里的「前端 X°」必须念它，不能拿包自报的 `cellDeg` 冒充「前端的期望」。 */
      cellDegExpect: pinDeg,
      dir: activeDir || dirsOf(spec)[0],
      dirs: dirsOf(spec),
      /* 跟着格尺寸走的三个预算（报告/排查要能回答"为什么一轮取这么多"） */
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
  function pruneAroundView() {
    try {
      const c = opts.view().center;
      if (c && Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
        const ev = opts.store.retainNear([c.lng, c.lat], opts.retainRadiusM());
        const ds = ev?.droppedSources;
        if (ds) evictedSources += Number(ds) || 0;
      }
    } catch {
    }
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
    const batch2 = [];
    let bytesPicked = 0;
    for (const c of cap0) {
      const by = idx.cellBytes ? idx.cellBytes.get(c.key) || 0 : 0;
      if (batch2.length > 0 && byteBudget > 0 && bytesPicked + by > byteBudget) break;
      batch2.push(c);
      bytesPicked += by;
    }
    bytesThisRound = bytesPicked;
    if (!batch2.length) {
      pruneAroundView();
      requestFlush(`${why}+0`);
      return { planned: true, batch: 0, got: 0, capped: p.capped };
    }
    pending += batch2.length;
    let n = 0;
    for (const cell of batch2) {
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
        let j;
        let tJson;
        let feats;
        let rawText = null;
        if (typeof r.text === "function") {
          rawText = await r.text();
          const tText = pmNow();
          pmSpan(`feed.read:${spec.dir}`, tText - tNet, by, "读响应流");
        }
        if (opts.parseAsync && rawText !== null) {
          try {
            const t0w = pmNow();
            feats = await opts.parseAsync(opts.kind, rawText);
            pmSpan(`feed.json+parse:${spec.dir}`, pmNow() - t0w, by, "Worker 解析（主线程只读文本）");
            tJson = 0;
          } catch (eW) {
            parseWorkerFallback += 1;
            opts.onError?.(`${spec.dir} ${cell.key} 解析 Worker 退回同步：${String(eW?.message || eW).slice(0, 40)}`);
            feats = spec.parse(JSON.parse(rawText));
            tJson = pmNow();
            pmSpan(`feed.json:${spec.dir}`, tJson - tNet, by, "退回同步解析（Worker 失败）");
          }
        } else if (rawText !== null) {
          j = JSON.parse(rawText);
          tJson = pmNow();
          pmSpan(`feed.json:${spec.dir}`, tJson - tNet, by, "纯 JSON.parse");
          feats = spec.parse(j);
        } else {
          j = await r.json();
          tJson = pmNow();
          pmSpan(`feed.json:${spec.dir}`, tJson - tNet, by, "读流+解析（适配器没给 text()）");
          feats = spec.parse(j);
        }
        const tParse = pmNow();
        pmSpan(`feed.parse:${spec.dir}`, tParse - (tJson || tNet), by);
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
    pruneAroundView();
    requestFlush(`${why}+${batch2.length}`);
    return { planned: true, batch: batch2.length, got: n, capped: p.capped };
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
    plan: planned,
    /* **F6（2026-10-01 性能审计 §5.5）**：把**本管道自己那条**索引 promise 露出来。
       宿主（`wsGwLayer`）原来**自己直连** `loadBundleIndex(fetchCell, "gw")`，而 `refresh()` 里
       还有一条 —— 两条各自独立 ⇒ 实测 `gwbundle/index.json` **被取了两次**（@7028.1 / @7130.1）。
       这里**只增加一个入口**：拿到的就是 `ensureIndex()` 内部**同一个** `indexPromise`（谁先到谁发起、
       后来的 await 同一份），**判词 / 去重口径 / 缓存策略 / 目录候选顺序一律没动** ——
       不调它的宿主看到的字节与本条改动之前**完全相同**。
       不许拿它当"预取"：它等于"把本来就要读的那一次提前到期"，不是多读一次。 */
    ensureIndex
  };
}
async function loadBundleIndex(fetchCell, kind, dir) {
  let url = "";
  try {
    url = bundleIndexUrl(kind, dir);
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
    let cellSizeByLayer = null;
    let layerCellSizeSole = null;
    const rawLayers = j?.cellSizeByLayer;
    if (rawLayers && typeof rawLayers === "object") {
      for (const [k, v] of Object.entries(rawLayers)) {
        const n = num(v);
        if (n === null || n <= 0) continue;
        if (!cellSizeByLayer) cellSizeByLayer = {};
        cellSizeByLayer[k] = n;
      }
      const vals = cellSizeByLayer ? Object.values(cellSizeByLayer) : [];
      layerCellSizeSole = vals.length === 1 ? vals[0] : null;
    }
    const okCells = !!(rawCells && rawCells.length);
    return {
      kind,
      url,
      source: typeof j?.source === "string" && j.source ? j.source : null,
      cellCount: num(j?.cellCount),
      cells: rawCells ? new Set(rawCells) : null,
      attribution: typeof j?.attribution === "string" && j.attribution ? j.attribution : null,
      real: typeof j?.real === "boolean" ? j.real : null,
      /* `cellSize` **不走 `num`**：`num(null)` 会回 0（`Number(null) === 0`），
         而 0 是坏值（格键除零 ⇒ 一个格都取不到），必须如实归成 **null = 数不出来**。 */
      cellSize: typeof j?.cellSize === "number" && Number.isFinite(j.cellSize) && j.cellSize > 0 ? j.cellSize : null,
      cellBytes,
      cellBld,
      cellSizeByLayer,
      layerCellSizeSole,
      ok: okCells,
      why: okCells ? null : "索引里没有 cells（取到了文件但内容不像清单）"
    };
  } catch (e) {
    return {
      kind,
      url,
      source: null,
      cellCount: null,
      cells: null,
      attribution: null,
      real: null,
      cellSize: null,
      cellBytes: null,
      cellBld: null,
      cellSizeByLayer: null,
      layerCellSizeSole: null,
      ok: false,
      why: String(e?.message || e || "索引读取失败").slice(0, 120)
    };
  }
}
function bundleCountsLine(f, icon, unit) {
  if (!f.asked && f.have === 0 && f.missing === 0 && f.failed === 0) {
    return `${icon} 离线格 未取（还没要数据）`;
  }
  if (f.refused) {
    const pkgC = f.index && f.index.cellSize !== null && f.index.cellSize !== void 0 ? f.index.cellSize + "°" : "?";
    const expC = f.cellDegExpect !== null && f.cellDegExpect !== void 0 ? f.cellDegExpect + "°" : `${f.cellDeg}°`;
    return `${icon} ❌ **格尺寸口径不符**（包 ${pkgC} / 前端 ${expC}）⇒ **本轮一个格都不取**（取格会把有数据的格说成「包外」；修包或改前端常量后重试）`;
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
    let lastBase = -1;
    ls.forEach((l, i) => {
      const id = String(l?.id ?? "");
      if (id === "bg" || id === "base" || id === "tint") lastBase = i;
    });
    if (lastBase >= 0) {
      const next = ls[lastBase + 1];
      const nextId = next ? String(next.id ?? "") : "";
      return nextId || void 0;
    }
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
  let before = opts.beforeId;
  try {
    const get = m.getLayer;
    if (before && typeof get === "function" && !get.call(m, before)) before = void 0;
  } catch {
    before = void 0;
  }
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
        const spec = {
          id,
          type: "fill",
          source: id,
          paint: { "fill-color": color, "fill-outline-color": color }
        };
        try {
          m.addLayer(spec, before);
        } catch (e0) {
          if (before === void 0) throw e0;
          m.addLayer(spec);
          out.errs.push(`${id} 锚点 "${before}" 不存在 ⇒ 已退到追加（顺序可能与其它层不同）`);
        }
        out.added.push(id);
      }
      out.layers.push(id);
      out.sources.push(id);
    } catch (e) {
      out.errs.push(`${id} ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  try {
    const ls = m.getStyle?.()?.layers || [];
    let lastBase = -1;
    let minGw = Number.POSITIVE_INFINITY;
    ls.forEach((l, i) => {
      const id = String(l?.id ?? "");
      if (id === "bg" || id === "base" || id === "tint") lastBase = i;
      if (out.layers.indexOf(id) >= 0) minGw = Math.min(minGw, i);
    });
    if (lastBase >= 0 && Number.isFinite(minGw) && minGw < lastBase) {
      const next = ls[lastBase + 1];
      const anchor = next ? String(next.id ?? "") : "";
      for (const id of out.layers) {
        try {
          const mv = m.moveLayer;
          if (typeof mv === "function") mv.call(m, id, anchor || void 0);
        } catch {
        }
      }
    }
  } catch {
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
  let indexInflight = null;
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
      if (!indexFact) {
        if (!indexInflight) {
          indexInflight = feed.ensureIndex().then((f2) => {
            indexFact = f2;
            return f2;
          });
        }
        const f = await indexInflight;
        if (f.cellCount === null && f.cells === null) {
          last = nextFacts(last, true, { state: "no-index", why: "index.json 没读到", cellSize: f.cellSize });
          return emit();
        }
      }
      const idx = indexFact;
      if (!idx) {
        last = nextFacts(last, true, { state: "uncounted", why: "索引还没读回来（并发 refresh）" });
        return emit();
      }
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
function labelTierOf(zoom) {
  const z = Number.isFinite(zoom) ? Number(zoom) : 14;
  return z >= 16 ? 3 : z >= 13 ? 2 : z >= 11 ? 1 : 0;
}
var LABEL_PLAN_DRIFT_RATIO = 0.25;
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
var LABEL_DOM_BOX = {
  /** 盒子左边在锚点左侧多少 px（= margin-left: -10px） */
  padLeft: 10,
  /** 盒子上边在锚点上方多少 px（= margin-top: -14px） */
  top: 14,
  /** 盒子高度 px（line-height 14 + padding 12×2） */
  height: 38,
  /** 文字左右 padding 合计 px（10×2） */
  padX: 20
};
var WIDE_CHAR = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
function labelTextWidth(name) {
  let w = 0;
  for (const ch of String(name)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 65535 || WIDE_CHAR.test(ch) ? 11 : CHAR_W;
  }
  return w;
}
function labelDomRect(name, x, y) {
  const w = Math.max(16, Math.round(labelTextWidth(name)) + LABEL_DOM_BOX.padX);
  const left = x - LABEL_DOM_BOX.padLeft;
  const top = y - LABEL_DOM_BOX.top;
  return { left, top, right: left + w, bottom: top + LABEL_DOM_BOX.height };
}
function labelDomFits(name, x, y, vw, vh, inset = 0) {
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return false;
  const r = labelDomRect(name, x, y);
  return r.left >= inset && r.top >= inset && r.right <= vw - inset && r.bottom <= vh - inset;
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
function planDriftPx(base, next) {
  const spanLng = Math.abs(Number(next.spanLng));
  const spanLat = Math.abs(Number(next.spanLat));
  const w = Number(next.viewW) > 0 ? Number(next.viewW) : 0;
  const h = Number(next.viewH) > 0 ? Number(next.viewH) : 0;
  if (!(spanLng > 0) || !(spanLat > 0) || !(w > 0) || !(h > 0)) return Infinity;
  const dx = Math.abs(Number(next.centerLng) - Number(base.centerLng)) / spanLng * w;
  const dy = Math.abs(Number(next.centerLat) - Number(base.centerLat)) / spanLat * h;
  const d = Math.max(dx, dy);
  return Number.isFinite(d) ? d : Infinity;
}
function labelItemsSig(items) {
  const keys = [];
  for (const it of items || []) {
    if (!it) continue;
    const lng = Number(it.lng), lat = Number(it.lat);
    keys.push([
      String(it.id),
      String(it.kind),
      String(it.name),
      (Number.isFinite(lng) ? lng : 0).toFixed(5),
      (Number.isFinite(lat) ? lat : 0).toFixed(5)
    ].join(""));
  }
  keys.sort();
  let h = 2166136261;
  for (const k of keys) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 31;
    h = Math.imul(h, 16777619);
  }
  return `n=${keys.length};h=${(h >>> 0).toString(16)}`;
}
function createLabelPlanCache(opts = {}) {
  const ratio = Number.isFinite(Number(opts.driftRatio)) ? Math.max(0, Number(opts.driftRatio)) : LABEL_PLAN_DRIFT_RATIO;
  const reasons = { cold: 0, tier: 0, drift: 0, data: 0, viewport: 0, reuse: 0 };
  let base = null;
  let result = null;
  let computes = 0;
  let reuses = 0;
  let lastReason = "cold";
  function reasonFor(key) {
    if (!base || result === null) return "cold";
    if (Number(key.tier) !== Number(base.tier)) return "tier";
    if (Math.abs(Number(key.viewW) - Number(base.viewW)) > 0.5 || Math.abs(Number(key.viewH) - Number(base.viewH)) > 0.5) return "viewport";
    if (String(key.dataSig) !== String(base.dataSig)) return "data";
    const limit = ratio * Math.min(Number(key.viewW) > 0 ? Number(key.viewW) : 0, Number(key.viewH) > 0 ? Number(key.viewH) : 0);
    if (!(planDriftPx(base, key) <= limit)) return "drift";
    return "reuse";
  }
  return {
    reasonFor,
    run(key, work) {
      const r = reasonFor(key);
      lastReason = r;
      reasons[r]++;
      if (r === "reuse") {
        reuses++;
        return result;
      }
      const out = work();
      computes++;
      base = { ...key };
      result = out;
      return out;
    },
    last: () => result,
    stats: () => ({ computes, reuses, lastReason, reasons: { ...reasons }, base: base ? { ...base } : null }),
    reset() {
      base = null;
      result = null;
      computes = 0;
      reuses = 0;
      lastReason = "cold";
      for (const k of Object.keys(reasons)) reasons[k] = 0;
    }
  };
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

// src/components/views/worldsim/wsBldIdKey.ts
var BLD_HEX_ID_LEN = 12;
var BLD_MAX_NUM_ID = 281474976710655;
var HEX12 = /^[0-9a-f]{12}$/;
var PART_SUFFIX = /^(.*)#(?:body|podium|tower|setback|parapet|equip|antenna|roof|\d+)(?:-[a-z0-9]+)*$/i;
function bldIdBase(s) {
  let out = String(s || "").trim();
  for (let i = 0; i < 3; i++) {
    const m = PART_SUFFIX.exec(out);
    if (!m) break;
    out = m[1].trim();
  }
  return out;
}
function bldHexOfNumber(n) {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > BLD_MAX_NUM_ID) return null;
  return v.toString(16).padStart(BLD_HEX_ID_LEN, "0");
}
function bldIdOfFeature(f) {
  if (!f || typeof f !== "object") return null;
  if (typeof f.id === "number") {
    const h = bldHexOfNumber(f.id);
    if (h) return h;
  }
  const p = f.properties || {};
  for (const v of [p.osm_id, p.store_id, p.id, f.i, p.i, f.id]) {
    if (typeof v === "string") {
      const s = bldIdBase(v);
      if (HEX12.test(s.toLowerCase())) return s.toLowerCase();
      if (/^\d+$/.test(s)) {
        const h = bldHexOfNumber(Number(s));
        if (h) return h;
      }
      continue;
    }
    if (typeof v === "number") {
      const h = bldHexOfNumber(v);
      if (h) return h;
    }
  }
  return null;
}
function bldKeyOfFeature(f) {
  if (f && typeof f === "object") {
    const id = bldIdOfFeature(f);
    if (id) return id;
  }
  return f;
}

// src/components/views/worldsim/wsBldPickStore.ts
var WS_BLD_CELL_CAP_REF_DEG = 0.05;
var WS_BLD_INVIEW_DEFAULT = 10;
function parseBldnParam(search) {
  try {
    const m = /[?&]bldn=(\d+)/.exec(String(search ?? ""));
    return m ? Math.max(0, Math.min(5e3, parseInt(m[1], 10))) : null;
  } catch {
    return null;
  }
}
function bldCapForCellDeg(cellDeg, pin) {
  if (pin !== null && pin !== void 0 && Number.isFinite(pin)) return Math.max(0, Math.floor(pin));
  const deg = Number(cellDeg);
  return Math.max(1, Math.round(100 * Math.pow(deg / WS_BLD_CELL_CAP_REF_DEG, 2)));
}
function parseInViewParam(search, def2 = WS_BLD_INVIEW_DEFAULT) {
  try {
    const m = new RegExp("[?&]inview=(-?[0-9.]+)").exec(String(search ?? ""));
    if (!m) return def2;
    const v = Number(m[1]);
    return isFinite(v) && v >= 0 ? v : def2;
  } catch {
    return def2;
  }
}
function pointOfFeature(f) {
  const p = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0] && f.geometry.coordinates[0][0] || null;
  return p;
}
function bldRingOf(bounds, pad) {
  const p = Number(pad);
  if (!bounds || !Number.isFinite(p) || p < 0) return null;
  try {
    const w = Number(bounds.getWest()), s = Number(bounds.getSouth());
    const e = Number(bounds.getEast()), n = Number(bounds.getNorth());
    if (![w, s, e, n].every((v) => Number.isFinite(v)) || !(e > w) || !(n > s)) return null;
    const dx = (e - w) / 2 * p, dy = (n - s) / 2 * p;
    return { w: w - dx, s: s - dy, e: e + dx, n: n + dy };
  } catch {
    return null;
  }
}
function bldInRingOf(f, ring) {
  if (!ring) return true;
  const pt = pointOfFeature(f);
  if (!pt) return true;
  const x = Number(pt[0]), y = Number(pt[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return x >= ring.w && x <= ring.e && y >= ring.s && y <= ring.n;
}
function createBldPickStore(opts) {
  const frozen = opts?.frozen ?? {};
  const nearAnchors = [];
  const nearFeat = /* @__PURE__ */ new Map();
  const walkFrozen = [];
  let lastPoolKeys = null;
  let lastPoolRev = void 0;
  let freshFeats = [];
  let nearCurrentKey = null;
  return {
    pick(input) {
      const ring = bldRingOf(input.bounds, input.ringPad);
      let ringPoolDropped = 0, ringFrozenDropped = 0;
      const poolIn = ring ? input.features.filter((f) => {
        const keep = bldInRingOf(f, ring);
        if (!keep) ringPoolDropped += 1;
        return keep;
      }) : input.features;
      if (ring) {
        for (const k of Object.keys(frozen)) {
          const arr = frozen[k];
          const keep = arr.filter((f) => bldInRingOf(f, ring));
          if (keep.length === arr.length) continue;
          ringFrozenDropped += arr.length - keep.length;
          if (keep.length) frozen[k] = keep;
          else delete frozen[k];
        }
      }
      const r = capBuildingsPerCell(poolIn, {
        cap: input.cap,
        cellDeg: input.cellDeg,
        bounds: input.bounds ?? null,
        minInView: input.minInView
      });
      const size = r.stats.cellDeg;
      const cap = r.stats.cap;
      const ckey = size + "|" + cap;
      const baseN = typeof r.stats.baseChosen === "number" ? r.stats.baseChosen : r.features.length;
      const baseFeats = r.features.slice(0, baseN);
      const addedNow = r.features.slice(baseN);
      const byCellNow = /* @__PURE__ */ new Map();
      for (const f of baseFeats) {
        const pt = pointOfFeature(f);
        if (!pt) continue;
        const w = Math.floor(pt[0] / size) * size, s = Math.floor(pt[1] / size) * size;
        const k = ckey + "@" + w.toFixed(5) + "_" + s.toFixed(5);
        const arr = byCellNow.get(k);
        if (arr) arr.push(f);
        else byCellNow.set(k, [f]);
      }
      const stableFeats = [];
      let frozenCells = 0, newCells = 0;
      for (const [k, arr] of byCellNow) {
        const fr = frozen[k];
        if (fr) {
          frozenCells++;
          for (const f of fr) stableFeats.push(f);
        } else {
          frozen[k] = arr;
          newCells++;
          for (const f of arr) stableFeats.push(f);
        }
      }
      const stats = {
        ...r.stats,
        frozenCells,
        newCells,
        frozenBase: stableFeats.length,
        /* 只有**真给了 ringPad**才写这三个键：关掉时 `stats` 的形状与改动前逐字节相同。 */
        ...ring ? { ringPad: Number(input.ringPad), ringPoolDropped, ringFrozenDropped } : {}
      };
      return { features: stableFeats.concat(addedNow), stats };
    },
    frozenTotal() {
      return Object.keys(frozen).length;
    },
    /* **双预算挑楼** —— 规则一行都不在这里（在 `wsBldBudget.pickBuildingsByBudget`）。
       本方法之所以存在：页面与 App **都只认 `createBldPickStore()` 这一个口**
       （2026-09-26 抽真源的初衷），新口径不该让宿主去 import 第二个模块。 */
    pickBudget(input) {
      const deg = bldResolvedCellDeg(input.cellDeg);
      const seed = input.nearCenter;
      const seedGiven = !!seed && typeof seed === "object";
      const seedLng = seedGiven ? Number(seed.lng) : NaN;
      const seedLat = seedGiven ? Number(seed.lat) : NaN;
      if (bldNearKOf(input.nearK) > 0 && seedGiven && isFinite(seedLng) && isFinite(seedLat)) {
        const cell = bundleCellOf(seedLng, seedLat, deg);
        const key = bundleCellKey(cell.w, cell.s, deg);
        if (!nearFeat.has(key)) {
          nearAnchors.push({ lng: seedLng, lat: seedLat, key });
          nearFeat.set(key, []);
        }
        nearCurrentKey = key;
      }
      const ring = bldRingOf(input.bounds, input.ringPad);
      let ringPoolDropped = 0, ringFrozenDropped = 0;
      let poolIn = input.features;
      if (ring) {
        poolIn = input.features.filter((f) => {
          const keep = bldInRingOf(f, ring);
          if (!keep) ringPoolDropped += 1;
          return keep;
        });
        for (const a of nearAnchors) {
          const arr = nearFeat.get(a.key);
          if (!arr) continue;
          const keep = arr.filter((f) => bldInRingOf(f, ring));
          if (keep.length === arr.length) continue;
          ringFrozenDropped += arr.length - keep.length;
          nearFeat.set(a.key, keep);
        }
        if (walkFrozen.length) {
          const keepW = walkFrozen.filter((f) => bldInRingOf(f, ring));
          if (keepW.length !== walkFrozen.length) {
            ringFrozenDropped += walkFrozen.length - keepW.length;
            walkFrozen.length = 0;
            for (const f of keepW) walkFrozen.push(f);
          }
        }
      }
      const anchorsOut = nearAnchors.map((a) => ({
        lng: a.lng,
        lat: a.lat,
        frozenOnly: a.key !== nearCurrentKey
      }));
      const frozenOut = nearAnchors.map((a) => nearFeat.get(a.key) || []);
      const out = pickBuildingsByBudget({
        /* 候选池 = 环内那一份（`ringPad` 没给时就是原样全量） */
        features: poolIn,
        bounds: input.bounds,
        screen: input.screen,
        budgetPx2: input.budgetPx2,
        budgetVerts: input.budgetVerts,
        /* 每格上限 K **原样透传**（`undefined` 也有意义：规则模块按默认严格档处理 —— 这里别"顺手补个默认值"，
           否则两处各写一份默认数，改一处漏一处） */
        maxDrawn: input.maxDrawn,
        /* 格边长同样**原样透传**（分格的那张网格 = 离线包自己的格 ⇒ 只有一份格数学）。
           本模块**不判 0.01/0.05**、也不给 `cellDeg` 打默认值（默认值只在规则模块那一处）；
             上面播种用的是 `bldResolvedCellDeg`（**同一个解析口**，不是第二份默认值）。 */
        cellDeg: input.cellDeg,
        minInView: input.minInView,
        /* 2026-10-04 第七条：传的是**锚点表 + 各锚点的冻结集**（不再是每轮现读的相机中心）；
           `nearK`（栋数）与"关掉"的语义仍归规则模块那一处说了算。 */
        nearAnchors: anchorsOut,
        nearFrozen: frozenOut,
        nearK: input.nearK,
        /* **行走缓冲**（2026-10-10）：参照点 = `input.nearCenter`（**当前相机中心**，每轮现读，
           与上面那张"按格冻结的锚点表"**不是同一件事** —— 那一条只认"进格那一刻"的点）。
           冻结集是本实例持有的那批**引用**（`walkFrozen`）⇒ 离线包淘汰也不消失。 */
        walkSeed: input.nearCenter,
        walkK: input.walkK,
        walkBuf: walkFrozen,
        /* **近带增量**：行走补只扫「这一轮新到的要素 + 继承集」（`walkScanned` 可数）。
           池没变（`poolRev` 同值）⇒ `freshFeats` 沿用上一轮算好的那批，**不重算**。 */
        walkCandidates: (() => {
          const cur = poolIn;
          if (input.poolRev !== void 0 && input.poolRev !== null && input.poolRev === lastPoolRev) {
            return freshFeats.length ? freshFeats : walkFrozen;
          }
          const prev = lastPoolKeys;
          const fresh = prev ? cur.filter((f) => !prev.has(bldKeyOfFeature(f))) : cur;
          lastPoolKeys = new Set(cur.map((f) => bldKeyOfFeature(f)));
          lastPoolRev = input.poolRev;
          freshFeats = fresh;
          return fresh.concat(walkFrozen);
        })()
      });
      const stats = {
        ...out.stats,
        nearAnchorTotal: nearAnchors.length,
        nearFrozenBatches: 0,
        walkBufN: 0,
        walkDropped: 0,
        /* 只有**真给了 ringPad**才写这三个键（关掉时 `stats` 形状逐字节不变）。 */
        ...ring ? { ringPad: Number(input.ringPad), ringPoolDropped, ringFrozenDropped } : {}
      };
      const per = Array.isArray(out.stats.nearAddedPerAnchor) ? out.stats.nearAddedPerAnchor : [];
      const addedN = Math.max(0, Number(out.stats.nearAdded) || 0);
      if (addedN > 0 && out.features.length >= addedN) {
        const tail = out.features.slice(out.features.length - addedN);
        let off = 0;
        for (let i = 0; i < nearAnchors.length && off < tail.length; i++) {
          const cnt = Math.max(0, Number(per[i]) || 0);
          if (cnt <= 0) continue;
          const arr = nearFeat.get(nearAnchors[i].key);
          for (let j = 0; j < cnt && off < tail.length; j++, off++) {
            const f = tail[off];
            const fk = bldKeyOfFeature(f);
            if (!arr.some((x) => bldKeyOfFeature(x) === fk)) arr.push(f);
          }
        }
      }
      for (const a of nearAnchors) if ((nearFeat.get(a.key) || []).length > 0) stats.nearFrozenBatches += 1;
      if (out.stats.walkOn) {
        const tailN = Math.max(0, Number(out.stats.walkRestored) || 0) + Math.max(0, Number(out.stats.walkAdded) || 0);
        const next = tailN > 0 && out.features.length >= tailN ? out.features.slice(out.features.length - tailN) : [];
        walkFrozen.length = 0;
        for (const f of next) walkFrozen.push(f);
        if (walkFrozen.length > WS_BLD_WALK_BUF_MAX) {
          const seed2 = input.nearCenter;
          const sl = seed2 && isFinite(Number(seed2.lng)) && isFinite(Number(seed2.lat)) ? [Number(seed2.lng), Number(seed2.lat)] : null;
          if (sl) {
            const kx = 111320 * Math.cos(sl[1] * Math.PI / 180);
            const withD = walkFrozen.map((f) => {
              const p = pointOfFeature(f);
              const d = p ? Math.hypot((p[0] - sl[0]) * kx, (p[1] - sl[1]) * 110540) : Infinity;
              return { f, d: isFinite(d) ? d : Infinity };
            });
            withD.sort((a, b) => b.d - a.d);
            const keep = withD.slice(0, WS_BLD_WALK_BUF_MAX);
            stats.walkDropped = withD.length - keep.length;
            walkFrozen.length = 0;
            const keepKeys = new Set(keep.map((x) => bldKeyOfFeature(x.f)));
            for (const f of next) if (keepKeys.has(bldKeyOfFeature(f))) walkFrozen.push(f);
            stats.why += " · 行走缓冲超上限：丢 " + stats.walkDropped + " 栋（离中心最远的那几栋）";
          }
        }
        stats.walkBufN = walkFrozen.length;
      }
      return { features: out.features, stats };
    },
    frozenObject() {
      return frozen;
    },
    snapshot() {
      const keys = Object.keys(frozen);
      const cells = [];
      for (const k of keys) {
        const arr = frozen[k];
        cells.push({ key: k, n: arr.length, ids: arr.map((f) => String(f.id ?? "")) });
      }
      return { frozenTotal: keys.length, keys, cells };
    },
    clear() {
      for (const k of Object.keys(frozen)) delete frozen[k];
    }
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
    /* 诊断（2026-09-25 首跑 draw=0 / 错误 3 时加的）：把 GL 版本与**每个 shader 的编译日志**都留下来，
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
    /** 自检/HUD 用：层自己报的可数口径（不是从外面猜的） */
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
function hash322(s) {
  let h = 2166136261;
  const str2 = String(s ?? "");
  for (let i = 0; i < str2.length; i++) {
    h ^= str2.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}
function genName(id, kind = "shop") {
  const h = hash322(String(id ?? "") + "|" + kind);
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
  const sorted = uniq.map((id) => ({ id, k: hash322(id + "|pick|" + kind) })).sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      const h = hash322(`${r.id}|stall|${j}`);
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
      picked.push({ id, name: genName(id, "stall"), lng: lng + nx * sign * dLng, lat: lat + ny * sign * dLat, k: hash322(id + "|pick") });
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

// src/components/views/worldsim/wsFpsProbe.ts
var FPS_TAGS = [
  "idle",
  "moving",
  "overlay-rebuild",
  "mesh-swap",
  "name-layer-update",
  "mvt-tiles-fetch",
  "pixel-probe",
  "style-reload",
  "hidden-tab",
  /* 2026-10-17 追加（wire 下标只能追加）：页面刚起的那 30 秒单独打这个标签，
     别把初始化/首屏算进 idle —— 真机那批"17.6s 起连续 8 个 0fps 窗 · tag=idle"
     就是标签密度不足造成的**没法归因**。 */
  "page-load"
];
var FPS_TAG_COUNT = FPS_TAGS.length;
var TAG_INDEX = (() => {
  const m = {};
  for (let i = 0; i < FPS_TAGS.length; i++) m[FPS_TAGS[i]] = i;
  return m;
})();
var IDLE_TAG = TAG_INDEX.idle;
var HIDDEN_TAG = TAG_INDEX["hidden-tab"];
var active = null;
function fpsMark(tag) {
  if (active) active.core.mark(tag);
}

// src/components/views/worldsim/wsZoneNames.ts
var WS_ZONE_SUB_DEG = 0.01;
var WS_ZONE_MIN_COUNT = 5;
var WS_ZONE_DOMINANCE = 0.5;
var WS_ZONE_GEN_TAG = "示意";
var WS_ZONE_DERIVED_SUFFIX = "区";
var WS_ZONE_COARSE_KINDS = [
  "food",
  "retail",
  "commercial",
  "lodging",
  "education",
  "medical",
  "transport",
  "landmark",
  "park",
  "culture",
  "industrial",
  "other"
];
var WS_ZONE_KIND_LABEL = {
  food: "美食",
  retail: "零售",
  commercial: "商业",
  lodging: "住宿",
  education: "教育",
  medical: "医疗",
  transport: "交通",
  landmark: "地标",
  park: "公园",
  culture: "文化",
  industrial: "工业",
  /* 「没类别」那一档（真包 24 条 = 1.3%）：**不进主导类统计**（它不构成"以什么为主"），
     但仍然计入 `total`（分母），并如实出现在 `unclassified` 里。 */
  other: "其他"
};
var WS_ZONE_UNCLASSIFIED = "other";
function coarseKindOf(k) {
  const s = String(k ?? "").trim().toLowerCase();
  if (!s) return WS_ZONE_UNCLASSIFIED;
  return WS_ZONE_COARSE_KINDS.indexOf(s) >= 0 ? s : WS_ZONE_UNCLASSIFIED;
}
function zoneKindLabelOf(k) {
  return WS_ZONE_KIND_LABEL[coarseKindOf(k)];
}
function zonePointLngLat(it) {
  if (!it) return null;
  const p = it.p;
  if (p && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) return [Number(p[0]), Number(p[1])];
  if (Number.isFinite(Number(it.lng)) && Number.isFinite(Number(it.lat))) return [Number(it.lng), Number(it.lat)];
  return null;
}
function zonePointsFrom(list) {
  const out = { points: [], skippedNoName: 0, skippedNoPoint: 0, unknownKinds: 0, considered: 0 };
  for (const it of list || []) {
    out.considered++;
    const name = String(it && (it.n !== void 0 ? it.n : it.name) || "").trim();
    if (!name) {
      out.skippedNoName++;
      continue;
    }
    const ll = zonePointLngLat(it);
    if (!ll) {
      out.skippedNoPoint++;
      continue;
    }
    const raw = String(it && (it.k !== void 0 ? it.k : it.kind) || "").trim().toLowerCase();
    if (raw && WS_ZONE_COARSE_KINDS.indexOf(raw) < 0) out.unknownKinds++;
    out.points.push(it);
  }
  return out;
}
var WS_ZONE_REAL_TIER_RANK = { admin: 3, area: 2, local: 1 };
function zoneRealNamesFromPlaces(list) {
  const out = [];
  for (const it of list || []) {
    const name = String(it && (it.n !== void 0 ? it.n : it.name) || "").trim();
    if (!name) continue;
    const raw = String(it && (it.k !== void 0 ? it.k : it.kind) || "").trim().toLowerCase();
    const t = placeTierOf(raw);
    if (t === null) continue;
    const ll = zonePointLngLat(it);
    if (!ll) continue;
    out.push({
      id: "place:" + String(it.i || it.id || raw + ":" + name),
      name,
      lng: ll[0],
      lat: ll[1],
      tier: t === "area" ? "area" : "local",
      from: "place",
      rawKind: raw
    });
  }
  return out;
}
function zoneRealNamesFromAdmins(list) {
  const out = [];
  for (const it of list || []) {
    const name = String(it && it.name || "").trim();
    if (!name || !Number.isFinite(Number(it.lng)) || !Number.isFinite(Number(it.lat))) continue;
    out.push({
      id: "admin:" + String(it.id || name),
      name,
      lng: Number(it.lng),
      lat: Number(it.lat),
      tier: "admin",
      from: "admin"
    });
  }
  return out;
}
function num2(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function containerSetOf(v) {
  if (!v) return null;
  const s = v instanceof Set ? v : new Set(v);
  return s.size ? s : null;
}
function zoneContainerKeyOf(lng, lat, containerDeg) {
  const c = bundleCellOf(lng, lat, containerDeg);
  return bundleCellKey(c.w, c.s, containerDeg);
}
function zoneGridCompatible(subDeg, containerDeg) {
  const a = num2(subDeg, WS_ZONE_SUB_DEG), b = num2(containerDeg, a);
  if (!(a > 0) || !(b > 0)) return false;
  const k = b / a;
  return Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1;
}
function zoneBucketsOf(points, opts = {}) {
  const deg = num2(opts.subDeg, WS_ZONE_SUB_DEG);
  const map2 = /* @__PURE__ */ new Map();
  for (const it of points || []) {
    const ll = zonePointLngLat(it);
    if (!ll) continue;
    const name = String(it && (it.n !== void 0 ? it.n : it.name) || "").trim();
    if (!name) continue;
    const { w, s } = bundleCellOf(ll[0], ll[1], deg);
    const key = bundleCellKey(w, s, deg);
    let e = map2.get(key);
    if (!e) {
      e = {
        b: {
          key,
          w,
          s,
          deg,
          total: 0,
          classified: 0,
          byKind: {},
          unclassified: 0,
          lng: 0,
          lat: 0,
          bbox: [w, s, +(w + deg).toFixed(5), +(s + deg).toFixed(5)]
        },
        pts: []
      };
      map2.set(key, e);
    }
    const b = e.b;
    const k = coarseKindOf(it && (it.k !== void 0 ? it.k : it.kind));
    b.total++;
    if (k === WS_ZONE_UNCLASSIFIED) b.unclassified++;
    else {
      b.classified++;
      b.byKind[k] = (b.byKind[k] || 0) + 1;
    }
    e.pts.push(ll);
  }
  const out = [];
  for (const { b, pts } of map2.values()) {
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p[0];
      sy += p[1];
    }
    b.lng = b.total > 0 ? sx / b.total : +(b.w + deg / 2).toFixed(6);
    b.lat = b.total > 0 ? sy / b.total : +(b.s + deg / 2).toFixed(6);
    const ordered = {};
    for (const k of WS_ZONE_COARSE_KINDS) if (b.byKind[k]) ordered[k] = b.byKind[k];
    b.byKind = ordered;
    out.push(b);
  }
  out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return out;
}
function zoneDominantOf(b) {
  if (!b || !b.total) return null;
  let best = null;
  let bestN = -1;
  let ties = 0;
  for (const k of WS_ZONE_COARSE_KINDS) {
    if (k === WS_ZONE_UNCLASSIFIED) continue;
    const n = b.byKind[k] || 0;
    if (n <= 0) continue;
    if (n > bestN) {
      bestN = n;
      best = k;
      ties = 1;
    } else if (n === bestN) ties++;
  }
  if (best === null) return null;
  return { kind: best, count: bestN, share: bestN / b.total, ties };
}
function realNamesOfCell(realNames, key, deg) {
  const hit = [];
  for (const r of realNames || []) {
    if (!r || !String(r.name || "").trim()) continue;
    if (!Number.isFinite(r.lng) || !Number.isFinite(r.lat)) continue;
    const c = bundleCellOf(r.lng, r.lat, deg);
    if (bundleCellKey(c.w, c.s, deg) !== key) continue;
    hit.push(r);
  }
  hit.sort((a, b) => WS_ZONE_REAL_TIER_RANK[b.tier] - WS_ZONE_REAL_TIER_RANK[a.tier] || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return hit;
}
function derivedZoneNameOf(kind) {
  return zoneKindLabelOf(kind) + WS_ZONE_DERIVED_SUFFIX;
}
function sketchZoneNameOf(kind) {
  return WS_ZONE_GEN_TAG + "·" + zoneKindLabelOf(kind);
}
function zoneNameForCell(cell, opts = {}) {
  const b = cell && cell.bucket;
  if (!b || !b.key) return null;
  const minCount = Math.max(1, Math.trunc(num2(opts.minCount, WS_ZONE_MIN_COUNT)));
  const dominance = num2(opts.dominance, WS_ZONE_DOMINANCE);
  const sketch = opts.sketch !== false;
  const minReal = Math.max(0, Math.trunc(num2(opts.minRealCount, 0)));
  const reals = (cell.realNames || []).filter((r) => r && String(r.name || "").trim());
  if (reals.length && b.total >= minReal) {
    const r = reals[0];
    const also = reals.length - 1;
    return {
      id: "zone:" + b.key,
      key: b.key,
      name: r.name,
      label: r.name,
      source: "real",
      derivedFrom: null,
      realFrom: r.from,
      realId: r.id,
      tier: r.tier,
      count: b.total,
      total: b.total,
      share: null,
      bbox: b.bbox,
      /* 真名的锚点 = **真名自己的点**（不搬家：它的位置就是事实）；聚合名才用格重心 */
      lng: Number(r.lng),
      lat: Number(r.lat),
      style: "real",
      sketch: false,
      why: `🗺 真名「${r.name}」（${r.from === "admin" ? "行政区名" : "片区名"}·${r.tier}）· 格内 ${b.total} 个点` + (also > 0 ? ` · 同格另有真名 ${also} 条` : "")
    };
  }
  const dom = zoneDominantOf(b);
  const base = {
    id: "zone:" + b.key,
    key: b.key,
    bbox: b.bbox,
    lng: b.lng,
    lat: b.lat,
    realFrom: null,
    realId: null,
    tier: null
  };
  if (b.total < minCount || !dom) {
    return null;
  }
  const shareTxt = `${dom.count}/${b.total} = ${(dom.share * 100).toFixed(1)}%`;
  if (dom.share > dominance) {
    return {
      ...base,
      name: derivedZoneNameOf(dom.kind),
      label: derivedZoneNameOf(dom.kind),
      source: "derived",
      derivedFrom: dom.kind,
      count: dom.count,
      total: b.total,
      share: dom.share,
      style: "derived",
      sketch: false,
      why: `🗺 数据驱动：主导「${zoneKindLabelOf(dom.kind)}」 ${shareTxt}（> ${(dominance * 100).toFixed(0)}%）` + (dom.ties > 1 ? ` · ⚠ 并列 ${dom.ties} 类` : "") + ` · 格内 ${b.total} 个点（有类别 ${b.classified}）`
    };
  }
  if (!sketch) return null;
  return {
    ...base,
    name: sketchZoneNameOf(dom.kind),
    label: sketchZoneNameOf(dom.kind),
    source: "generated",
    derivedFrom: dom.kind,
    count: dom.count,
    total: b.total,
    share: dom.share,
    style: "generated",
    sketch: true,
    why: `🗺 **示意**：最多的一类是「${zoneKindLabelOf(dom.kind)}」但只占 ${shareTxt}（没过半 ⇒ 不是数据驱动的区名，只是"这一带这类多一些"）· 格内 ${b.total} 个点`
  };
}
function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function planZoneNames(points, realNames = [], opts = {}) {
  const deg = num2(opts.subDeg, WS_ZONE_SUB_DEG);
  const minCount = Math.max(1, Math.trunc(num2(opts.minCount, WS_ZONE_MIN_COUNT)));
  const containerDeg = num2(opts.containerDeg, deg);
  const containers = containerSetOf(opts.containers);
  const all = zoneBucketsOf(points, opts);
  const buckets = containers ? all.filter((b) => containers.has(zoneContainerKeyOf(b.w + deg / 2, b.s + deg / 2, containerDeg))) : all;
  const zones = [];
  const bySource = { real: 0, derived: 0, generated: 0 };
  const totals = [];
  const shares = [];
  let eligible = 0;
  let overHalf = 0;
  let skippedSparse = 0;
  for (const b of buckets) {
    totals.push(b.total);
    const z = zoneNameForCell({ bucket: b, realNames: realNamesOfCell(realNames, b.key, deg) }, opts);
    if (!z) {
      skippedSparse++;
      continue;
    }
    if (b.total >= minCount) {
      eligible++;
      const dom = zoneDominantOf(b);
      if (dom && dom.share > num2(opts.dominance, WS_ZONE_DOMINANCE)) overHalf++;
      if (dom && z.source !== "real") shares.push(dom.share);
    }
    zones.push(z);
    bySource[z.source]++;
  }
  const rank = { real: 0, derived: 1, generated: 2 };
  zones.sort((a, b) => rank[a.source] - rank[b.source] || b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    zones,
    cells: buckets.length,
    eligible,
    overHalf,
    bySource,
    totalStats: {
      min: totals.length ? Math.min(...totals) : 0,
      median: median(totals) ?? 0,
      max: totals.length ? Math.max(...totals) : 0
    },
    shareMedian: median(shares),
    skippedSparse,
    skippedPartial: all.length - buckets.length
  };
}
function pickZoneNames(zones, cap) {
  const list = [...zones || []];
  const n = Math.max(0, Math.trunc(Number(cap) || 0));
  const bySource = { real: 0, derived: 0, generated: 0 };
  const droppedBySource = { real: 0, derived: 0, generated: 0 };
  const shown = list.slice(0, n);
  const dropped = list.slice(n);
  for (const z of shown) bySource[z.source]++;
  for (const z of dropped) droppedBySource[z.source]++;
  return {
    shown,
    candidates: list.length,
    droppedByCap: dropped.length,
    bySource,
    droppedBySource,
    cap: n,
    capped: dropped.length > 0
  };
}
var WS_ZONE_ENTER_RATIO = 0.45;
var WS_ZONE_EXIT_RATIO = 0.2;
var WS_ZONE_SAMPLES = 2;
var WS_ZONE_SWITCH_MIN_MS = 400;
function zoneDensityOf(pick) {
  if (!pick) return null;
  const c = Number(pick.candidates);
  if (!Number.isFinite(c) || c <= 0) return null;
  const d = Number(pick.droppedByCollision) || 0;
  return Math.max(0, Math.min(1, d / c));
}
function createZoneModeGate(opts = {}) {
  const enter = num2(opts.enter, WS_ZONE_ENTER_RATIO);
  const exit = num2(opts.exit, WS_ZONE_EXIT_RATIO);
  const need = Math.max(2, Math.trunc(num2(opts.samples, WS_ZONE_SAMPLES)));
  const minMs = Math.max(0, num2(opts.minSwitchMs, WS_ZONE_SWITCH_MIN_MS));
  let zoneMode = false;
  let last = null;
  let streakEnter = 0;
  let streakExit = 0;
  let lastSwitchMs = null;
  return {
    sample(density, nowMs) {
      const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      last = Number.isFinite(Number(density)) ? Math.max(0, Math.min(1, Number(density))) : null;
      if (last === null) {
        return { zoneMode, changed: false, reason: "密度数不出来（没候选）⇒ 保持原状" };
      }
      streakEnter = last >= enter ? streakEnter + 1 : 0;
      streakExit = last <= exit ? streakExit + 1 : 0;
      const wantEnter = !zoneMode && streakEnter >= need;
      const wantExit = zoneMode && streakExit >= need;
      if (!wantEnter && !wantExit) {
        return {
          zoneMode,
          changed: false,
          reason: `D=${last.toFixed(3)} ⇒ 保持（进入连 ${streakEnter}/${need} · 退出连 ${streakExit}/${need}${last > exit && last < enter ? " · 死区" : ""}）`
        };
      }
      if (lastSwitchMs !== null && now - lastSwitchMs < minMs) {
        return { zoneMode, changed: false, reason: `D=${last.toFixed(3)} 够格但距上次切换只有 ${now - lastSwitchMs}ms < ${minMs}ms（防抖）` };
      }
      zoneMode = wantEnter;
      lastSwitchMs = now;
      streakEnter = 0;
      streakExit = 0;
      return { zoneMode, changed: true, reason: `D=${last.toFixed(3)} 连续 ${need} 次 ⇒ ${zoneMode ? "进区名模式" : "退出区名模式"}` };
    },
    state: () => ({ zoneMode, density: last, streakEnter, streakExit, lastSwitchMs }),
    reset() {
      zoneMode = false;
      last = null;
      streakEnter = 0;
      streakExit = 0;
      lastSwitchMs = null;
    }
  };
}
function zoneAttributionOf(index) {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}
function zoneVerdictLine(f) {
  if (f.state === "no-index") return `🗺 区名 数不出来：真名包索引没读到（${String(f.why || "index.json 没读到").slice(0, 60)}）`;
  if (f.state === "size-mismatch") {
    return `🗺 区名 数不出来：取数粒度 ${String(f.cellSize)}° 不是划区粒度 ${f.subDeg}° 的整数倍 ⇒ 子格会跨容器，本轮不算`;
  }
  if (f.state === "no-points") return `🗺 区名 0 个（已量：这一轮 ${f.points} 个真名点，格 ${f.cells}）`;
  return `🗺 区名 ${f.bySource.real} 真名 · ${f.bySource.derived} 数据驱动 · ${f.bySource.generated} 示意（格 ${f.eligible}/${f.cells} 够格 · 过半 ${f.overHalf} · 点 ${f.points}` + (f.skippedPartial > 0 ? ` · 边缘半格未算 ${f.skippedPartial}` : "") + `）`;
}
function zoneFactsOf(plan, ctx) {
  const subDeg = num2(ctx.subDeg, WS_ZONE_SUB_DEG);
  const idx = ctx.index;
  const containerDeg = idx && Number.isFinite(Number(idx.cellSize)) ? Number(idx.cellSize) : null;
  const base = {
    state: "counted",
    points: ctx.points,
    cells: plan ? plan.cells : 0,
    eligible: plan ? plan.eligible : 0,
    overHalf: plan ? plan.overHalf : 0,
    bySource: plan ? plan.bySource : { real: 0, derived: 0, generated: 0 },
    subDeg,
    cellSize: containerDeg,
    gridOk: containerDeg === null ? true : zoneGridCompatible(subDeg, containerDeg),
    skippedPartial: plan ? plan.skippedPartial : 0,
    attribution: zoneAttributionOf(idx),
    why: null
  };
  if (!idx || containerDeg === null) {
    return { ...base, state: "no-index", why: ctx.indexError || "index.json 没读到" };
  }
  if (!base.gridOk) {
    return { ...base, state: "size-mismatch", why: `取数 ${containerDeg}° / 划区 ${subDeg}°` };
  }
  if (ctx.points === 0) return { ...base, state: "no-points" };
  return base;
}
function zoneStyleClassOf(z) {
  const s = z && z.source;
  if (s === "real") return "is-real";
  if (s === "derived") return "is-derived";
  return "is-generated";
}
function zoneClickPayload(z) {
  return { zoneId: z.id, zoneKey: z.key, lng: z.lng, lat: z.lat };
}

// src/components/views/worldsim/wsNameLayer.ts
var NAMES_BUNDLE_DIR = "namesbundle";
var NAMES_BUNDLE_CELL_DEG = 0.05;
var NAMES_MAX_CELLS = 6;
var NAMES_PER_REFRESH = 6;
var NAMES_STORE_CAP = 64;
var NAMES_TIMEOUT_MS = 6e3;
var NAMES_MIN_CONF_FALLBACK = 0.5;
var NAMES_ZONE_CAP = 8;
var NAMES_BIG_KEEP = 4;
var NAMES_ZONE_REAL_MAX = 4;
var LABEL_MOTION = {
  /* 三幕（Fade Through）：楼名退 → 40ms 重叠 → 区名进 */
  nameOutMs: 120,
  overlapMs: 40,
  zoneInMs: 200,
  zoneStaggerMs: 25,
  zoneStaggerMax: 4,
  /* 单体（§4.2）：hover 90 / 松开 140 / 被遮挡退让 120（**不动位置**，只 opacity）/ 复现 160 */
  hoverMs: 90,
  releaseMs: 140,
  retreatMs: 120,
  showMs: 160,
  /* 相机运动（§4.2）：整层淡化 = **只写 1 个节点** */
  cameraMs: 80,
  cameraOpacity: 0.25,
  restoreMs: 160,
  /* 同一个切换批的最短间隔（与 `wsZoneNames.WS_ZONE_SWITCH_MIN_MS` 同值；这里给宿主做去抖） */
  minSwitchMs: 400,
  /* 避让网格与上限（**与 `wsLabels` 同值**：48px 是实测出来的，不许缩） */
  gridPx: 48,
  /* 节点阶梯（§5）：≤12 CSS / 13~26 分批 / 27~60 WAAPI / >60 整层 */
  ladder: { l0: 12, l1: 26, l2: 60 },
  /** `>60` 时换手段（整层淡出→重排→淡入），**不是**缩时长 */
  liteAbove: 60,
  easeEnter: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  easeLeave: "cubic-bezier(0.3, 0, 1, 1)"
};
var LABEL_ANIM_PROPS = ["transform", "opacity"];
var LABEL_DOM_CLASS = "ws-lab";
var LABEL_ROOT_CLASS = "ws-labs";
var LABEL_CAMERA_CLASS = "is-camera-moving";
var LABEL_STYLE_CLASS = {
  real: "is-real",
  derived: "is-derived",
  generated: "is-generated"
};
var NAME_BIND_MIN_ZOOM = 14;
var NAME_BIND_HIDE_MIN_BOUND = 5;
function nameVerdictLine(f) {
  if (f.state === "off") return "🏷🗺 名字层 关（?names=0）";
  if (f.state === "no-index") return `🏷🗺 名字 数不出来：真名包索引没读到（${String(f.why || "index.json 没读到").slice(0, 50)}）`;
  if (f.state === "size-mismatch") return `🏷🗺 名字 数不出来：包分格 ${String(f.cellSize)}° 取不到格（本轮不取）`;
  if (f.state === "uncounted") {
    return `🏷🗺 名字 数不出来：这一轮 0 格取到（格 ${f.hit}/${f.cells}${f.failed ? " · 失败 " + f.failed : ""}）`;
  }
  const bindLine = f.bindState === "uncounted" ? ` · 🏢 名字↔楼 数不出来：${f.bindWhy || "没拿到楼几何"}` : ` · 🏢 名字↔楼 绑 ${f.boundNames} / 未绑POI ${f.unboundPoiNames}${f.hiddenUnbound ? `（z≥14 收起 ${f.hiddenUnbound}）` : ""}` + (f.bindClass === "skipped" ? `（未绑分类未算：仅 ?wsalign=1 · 楼顶投影 3D ${f.roof3d}/近似 ${f.roofApprox}/地面 ${f.roofGround}${f.roofNull ? "/投不出 " + f.roofNull : ""}）` : `（没画 ${f.boundButNotDrawn} · 无楼 ${f.noBldNear} · 多义 ${f.ambiguous} · 无id ${f.noBldId} · 重复 ${f.droppedByDupBld} · 楼顶投影 3D ${f.roof3d}/近似 ${f.roofApprox}/地面 ${f.roofGround}${f.roofNull ? "/投不出 " + f.roofNull : ""}）`);
  return `🏷 标签 显示 ${f.pickedShown} / 丢弃(避让) ${f.droppedByCollision} / 超上限 ${f.droppedByCap}（候选 ${f.candidates}${f.capped ? " · 被上限截断" : ""}） · 出框 ${f.droppedByViewport} · 屏上 ${f.labels}（大名字 ${f.bigLabels} · 真名 ${f.realLabels} · 区名 ${f.zoneLabels}=数据驱动 ${f.zoneDerived}+真名区/示意 ${f.zoneSketch}） · 🚫生成名上屏 ${f.generatedOnScreen} · 点 ${f.points} · 格 ${f.hit}/${f.cells} · 子格 ${f.mode === "zones" ? `够格 ${f.zoneEligible}/${f.zoneCells} 过半 ${f.zoneOverHalf}` : "未算（names）"} · D ${f.density === null ? "数不出来" : f.density.toFixed(2)} · ${f.mode === "zones" ? "区名模式" : "名字模式"} · ♻ 复用 ${f.planReuses} / 算 ${f.planComputes}（${f.planReason}）` + bindLine;
}
function emptyFacts2(on) {
  return {
    state: on ? "uncounted" : "off",
    labels: 0,
    pickedShown: 0,
    realLabels: 0,
    zoneLabels: 0,
    bigLabels: 0,
    zoneDerived: 0,
    zoneSketch: 0,
    generatedOnScreen: 0,
    candidates: 0,
    droppedByCollision: 0,
    droppedByCap: 0,
    capped: false,
    skippedNoName: 0,
    skippedOffscreen: 0,
    droppedByViewport: 0,
    density: null,
    mode: "names",
    cells: 0,
    hit: 0,
    missing: 0,
    failed: 0,
    points: 0,
    droppedByConf: 0,
    zoneCells: 0,
    zoneEligible: 0,
    zoneOverHalf: 0,
    attribution: null,
    cellSize: null,
    planComputes: 0,
    planReuses: 0,
    planReason: "cold",
    bindState: "uncounted",
    bindWhy: null,
    bindClass: "counted",
    boundNames: 0,
    unboundPoiNames: 0,
    hiddenUnbound: 0,
    hiddenByRule: 0,
    boundButNotDrawn: 0,
    noBldNear: 0,
    ambiguous: 0,
    droppedByDupBld: 0,
    noBldId: 0,
    roof3d: 0,
    roofApprox: 0,
    roofGround: 0,
    roofNull: 0,
    ms: { fetch: 0, items: 0, grid: 0, bindDrawn: 0, bindPool: 0, poolGrid: 0, poolQuery: 0, zones: 0, pick: 0, nodes: 0, total: 0 },
    drawnSource: "none",
    drawnCount: 0,
    drawnWithHeight: 0,
    fallbackNames: 0,
    poiCandidates: 0,
    poiGated: 0,
    areaCandidates: 0,
    why: null
  };
}
function namesCellUrl(cellKey, dir = NAMES_BUNDLE_DIR) {
  return `/${dir}/${cellKey}.json`;
}
function namesIndexUrl(dir = NAMES_BUNDLE_DIR) {
  return `/${dir}/index.json`;
}
function isLngLatPt(a) {
  return Array.isArray(a) && typeof a[0] === "number" && typeof a[1] === "number";
}
function outerRingsOfGeom(geometry) {
  const cs = geometry?.coordinates;
  if (!Array.isArray(cs) || !cs.length) return [];
  const a = cs;
  if (isLngLatPt(a[0]?.[0])) return cs;
  if (isLngLatPt(a[0]?.[0]?.[0])) {
    return cs.map((p) => p?.[0]).filter((r) => Array.isArray(r) && r.length >= 3);
  }
  return [];
}
function bldRingCentroid(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  const first = ring[0], last = ring[ring.length - 1];
  const closed = ring.length > 2 && isLngLatPt(first) && isLngLatPt(last) && first[0] === last[0] && first[1] === last[1];
  const m = closed ? ring.length - 1 : ring.length;
  let x = 0, y = 0, n = 0;
  for (let i = 0; i < m; i++) {
    const p = ring[i];
    if (isLngLatPt(p)) {
      x += p[0];
      y += p[1];
      n++;
    }
  }
  return n ? [x / n, y / n] : null;
}
function bldRingAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let s = 0;
  const kx = 111319.49079327358 * Math.cos(ring[0][1] * Math.PI / 180);
  const ky = 111319.49079327358;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (!isLngLatPt(a) || !isLngLatPt(b)) continue;
    s += b[0] * kx * (a[1] * ky) - a[0] * kx * (b[1] * ky);
  }
  return Math.abs(s) / 2;
}
function pointInRing2(pt, ring) {
  if (!isLngLatPt(pt) || !Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
var BLD_GEO_CACHE = /* @__PURE__ */ new WeakMap();
function bldGeoOfFeature(f) {
  if (!f || typeof f !== "object") return null;
  const hit = BLD_GEO_CACHE.get(f);
  if (hit !== void 0) return hit;
  const feat = f;
  const rings = outerRingsOfGeom(feat.geometry);
  let geo = null;
  if (rings.length) {
    const ring = rings.reduce((a, b) => bldRingAreaM2(b) > bldRingAreaM2(a) ? b : a, rings[0]);
    const c = bldRingCentroid(ring);
    if (c) {
      const p = feat.properties || {};
      const id = bldIdOfFeature(feat);
      const h3d = Number(p.h3d);
      const tileH = Number(p.h);
      const base = Number(p.h_base ?? p.min_height ?? 0);
      const srcH = Number(p.height);
      const est = renderHeight(p).h;
      const top = Number.isFinite(h3d) && h3d > 0 ? h3d : Number.isFinite(tileH) && tileH > 0 ? tileH : (Number.isFinite(base) ? Math.max(0, base) : 0) + (Number.isFinite(srcH) && srcH > 0 ? srcH : est);
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const q of ring) {
        if (!isLngLatPt(q)) continue;
        if (q[0] < minLng) minLng = q[0];
        if (q[0] > maxLng) maxLng = q[0];
        if (q[1] < minLat) minLat = q[1];
        if (q[1] > maxLat) maxLat = q[1];
      }
      geo = {
        id,
        part: String(p.part || "body"),
        ring,
        cx: c[0],
        cy: c[1],
        area: bldRingAreaM2(ring),
        minLng,
        minLat,
        maxLng,
        maxLat,
        top
      };
    }
  }
  BLD_GEO_CACHE.set(f, geo);
  return geo;
}
function bindPointToBuilding(pt, list) {
  let best = null;
  const seen = /* @__PURE__ */ new Set();
  for (const b of list) {
    if (pt[0] < b.minLng || pt[0] > b.maxLng || pt[1] < b.minLat || pt[1] > b.maxLat) continue;
    if (!pointInRing2(pt, b.ring)) continue;
    const key = b.id || `obj:${b.cx},${b.cy}`;
    seen.add(key);
    if (!best || b.area < best.area || b.area === best.area && key < (best.id || `obj:${best.cx},${best.cy}`)) best = b;
  }
  return best ? { bld: best, ambiguous: seen.size > 1 } : null;
}
var BLD_GRID_CELL = 2e-3;
function buildBldGrid(list) {
  const cell = BLD_GRID_CELL;
  const bins = /* @__PURE__ */ new Map();
  const big = [];
  for (const b of list) {
    const i0 = Math.floor(b.minLng / cell), i1 = Math.floor(b.maxLng / cell);
    const j0 = Math.floor(b.minLat / cell), j1 = Math.floor(b.maxLat / cell);
    if (i1 - i0 > 2 || j1 - j0 > 2) {
      big.push(b);
      continue;
    }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      const arr = bins.get(k);
      if (arr) arr.push(b);
      else bins.set(k, [b]);
    }
  }
  return { cell, bins, big };
}
function bldCandidates(grid, pt) {
  const i = Math.floor(pt[0] / grid.cell), j = Math.floor(pt[1] / grid.cell);
  const out = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const arr = grid.bins.get(`${i + di},${j + dj}`);
    if (arr) out.push(...arr);
  }
  if (grid.big.length) out.push(...grid.big);
  return out;
}
function namePointsOfCell(json, minConf) {
  const list = json?.places;
  const raw = Array.isArray(list) ? list : [];
  const pts = [];
  let dropped = 0;
  for (const it of raw) {
    const n = String(it && (it.n !== void 0 ? it.n : it.name) || "").trim();
    if (!n) continue;
    const p = it?.p;
    const lng = Array.isArray(p) ? Number(p[0]) : Number(it?.lng);
    const lat = Array.isArray(p) ? Number(p[1]) : Number(it?.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const cf = Number(it?.cf);
    if (Number.isFinite(cf) && cf < minConf) {
      dropped++;
      continue;
    }
    pts.push(it);
  }
  return { points: pts, droppedByConf: dropped };
}
var POOL_GRID_CACHE = null;
var POOL_CLASS_CACHE = /* @__PURE__ */ new Map();
function createNameLayer(host) {
  const cells = /* @__PURE__ */ new Map();
  const now = host.now || (() => Date.now());
  const gate = createZoneModeGate();
  let last = emptyFacts2(host.enabled ? host.enabled() : true);
  let lastPlan = { mode: "names", nodes: [], batch: 0, lite: false, cameraOpacity: LABEL_MOTION.cameraOpacity };
  let batch2 = 0;
  let lastBatchSig = "";
  let indexDone = false;
  let indexCells = null;
  let indexFact = null;
  const planCache = createLabelPlanCache();
  let payload = null;
  function projectNode(n) {
    const m = host.map();
    if (!m || !Number.isFinite(n.lng) || !Number.isFinite(n.lat)) return { ...n };
    try {
      const roofH = Number(n.roofH) || 0;
      const roofP = roofH > 0 && host.projectRoof ? host.projectRoof(n.lng, n.lat, roofH) : null;
      const p = roofP ?? m.project([n.lng, n.lat]);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { ...n, x: p.x, y: p.y };
    } catch {
    }
    return { ...n };
  }
  function planFromPayload(p) {
    const vp = viewportOf();
    const nodes = [];
    for (const n of p.nodes) {
      const m = projectNode(n);
      if (!fitsViewport(m, vp)) continue;
      nodes.push(m);
    }
    return {
      plan: {
        mode: p.mode,
        nodes,
        batch: p.batch,
        lite: p.lite,
        cameraOpacity: LABEL_MOTION.cameraOpacity,
        changed: false,
        entered: [],
        exited: []
      },
      dropped: p.nodes.length - nodes.length
    };
  }
  function countNodes(nodes) {
    const zoneLabels = nodes.filter((n) => n.pick.kind === "zone").length;
    return {
      labels: nodes.length,
      realLabels: nodes.filter((n) => n.style === "real").length,
      zoneLabels,
      bigLabels: nodes.length - zoneLabels,
      zoneDerived: nodes.filter((n) => n.style === "derived").length,
      /** 区名里**不是数据驱动**的那些（真名区 + 示意区） */
      zoneSketch: nodes.filter((n) => n.pick.kind === "zone" && n.style !== "derived").length
    };
  }
  function fitsViewport(n, vp) {
    return !vp || labelDomFits(n.text, n.x, n.y, vp.width, vp.height);
  }
  function viewOf() {
    const m = host.map();
    if (!m) return null;
    const b = m.getBounds();
    if (!b) return null;
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    if (![w, s, e, n].every((v) => Number.isFinite(v))) return null;
    return {
      bounds: b,
      center: { lng: (w + e) / 2, lat: (s + n) / 2 }
    };
  }
  let vpKey = "";
  let vpVal = null;
  function viewportOf() {
    const m = host.map();
    const c = m?.getCanvas?.();
    if (!c) return null;
    let w = Number(c.clientWidth);
    let h = Number(c.clientHeight);
    if (!(w > 0) || !(h > 0)) {
      const bw = Number(c.width);
      const bh = Number(c.height);
      const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
      w = bw > 0 ? bw / dpr : 0;
      h = bh > 0 ? bh / dpr : 0;
    }
    const key = `${w}x${h}`;
    if (key === vpKey) return vpVal;
    vpVal = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
    vpKey = key;
    return vpVal;
  }
  async function loadIndex() {
    if (indexDone) return;
    indexDone = true;
    try {
      const r = await host.fetchCell(namesIndexUrl(), NAMES_TIMEOUT_MS);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const keys = j?.cells && typeof j.cells === "object" ? Object.keys(j.cells) : null;
      indexCells = keys ? new Set(keys) : null;
      indexFact = {
        attribution: zoneAttributionOf({ attribution: j?.attribution ?? null, source: null }),
        cellSize: Number.isFinite(Number(j?.cellSize)) ? Number(j?.cellSize) : null,
        minConf: Number.isFinite(Number(j?.minConfidenceRecommended)) ? Number(j?.minConfidenceRecommended) : null,
        cells: keys ? keys.length : null
      };
    } catch (e) {
      indexCells = null;
      indexFact = null;
      host.onError?.(`names index ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  const inflight = /* @__PURE__ */ new Map();
  function fetchCellData(key, minConf) {
    const k = `${key}@${minConf}`;
    const running = inflight.get(k);
    if (running) return running;
    const p = fetchCellDataOnce(key, minConf).finally(() => {
      inflight.delete(k);
    });
    inflight.set(k, p);
    return p;
  }
  async function fetchCellDataOnce(key, minConf) {
    let pts = [];
    let dropped = 0;
    let reals = [];
    let gotAny = false;
    let miss = 0;
    let fail = 0;
    try {
      const r = await host.fetchCell(namesCellUrl(key), NAMES_TIMEOUT_MS);
      if (r.ok) {
        const parsed = namePointsOfCell(await r.json(), minConf);
        pts = parsed.points;
        dropped = parsed.droppedByConf;
        gotAny = true;
      } else if (r.status === 404) miss++;
      else fail++;
    } catch {
      fail++;
    }
    try {
      const r2 = await host.fetchCell(bundleCellUrl("places", key), NAMES_TIMEOUT_MS);
      if (r2.ok) {
        reals = zoneRealNamesFromPlaces(bundlePlacesOf(await r2.json()));
        gotAny = true;
      } else if (r2.status === 404) miss++;
      else fail++;
    } catch {
      fail++;
    }
    if (gotAny) {
      cells.set(key, { points: pts, droppedByConf: dropped, reals, ok: true });
      while (cells.size > NAMES_STORE_CAP) {
        const k = cells.keys().next().value;
        if (k === void 0) break;
        cells.delete(k);
      }
      return "hit";
    }
    if (fail > 0) return "failed";
    cells.set(key, { points: [], droppedByConf: 0, reals: [], ok: false });
    return "missing";
  }
  const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  async function refresh(why = "view") {
    const t0 = clock();
    const on = host.enabled ? host.enabled() : true;
    if (!on) {
      last = { ...emptyFacts2(false) };
      return emit();
    }
    fpsMark("name-layer-update");
    try {
      await loadIndex();
      const cellSize = indexFact?.cellSize ?? null;
      if (indexFact === null) {
        last = { ...emptyFacts2(true), state: "no-index", why: "真名包索引没读到" };
        return emit();
      }
      if (cellSize === null) {
        last = { ...emptyFacts2(true), state: "no-index", why: "索引里没有 cellSize", attribution: indexFact.attribution };
        return emit();
      }
      const view = viewOf();
      if (!view) {
        last = { ...emptyFacts2(true), state: "uncounted", why: "视野拿不到（地图还没就绪）", attribution: indexFact.attribution, cellSize };
        return emit();
      }
      const planCells = bundleCellsForView(view.bounds, view.center, NAMES_MAX_CELLS, cellSize);
      if (!planCells) {
        last = { ...emptyFacts2(true), state: "uncounted", why: "格数学算不出来（视野离谱）", attribution: indexFact.attribution, cellSize };
        return emit();
      }
      const wanted = indexCells ? planCells.cells.filter((c) => indexCells.has(c.key)) : planCells.cells;
      const need = wanted.filter((c) => !cells.has(c.key)).slice(0, NAMES_PER_REFRESH);
      let hit = 0, missing = 0, failed = 0;
      for (const c of need) {
        const r = await fetchCellData(c.key, host.minConf?.() ?? indexFact.minConf ?? NAMES_MIN_CONF_FALLBACK);
        if (r === "hit") hit++;
        else if (r === "missing") missing++;
        else failed++;
      }
      const tFetch = clock();
      const used = wanted.map((c) => cells.get(c.key)).filter(Boolean);
      const hitCells = wanted.filter((c) => cells.get(c.key)?.ok).length;
      const points = [];
      const reals = [];
      let droppedByConf = 0;
      for (const d of used) {
        points.push(...d.points);
        reals.push(...d.reals);
        droppedByConf += d.droppedByConf;
      }
      const minConf = host.minConf?.() ?? indexFact.minConf ?? NAMES_MIN_CONF_FALLBACK;
      fpsMark("name-layer-update");
      const items = [];
      const anchorOf = /* @__PURE__ */ new Map();
      const pickOf = /* @__PURE__ */ new Map();
      for (const p of points) {
        const n = String(p.n ?? p.name ?? "").trim();
        const pp = p.p;
        const lng = Array.isArray(pp) ? Number(pp[0]) : Number(p.lng);
        const lat = Array.isArray(pp) ? Number(pp[1]) : Number(p.lat);
        if (!n || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const id = "poi:" + String(p.i ?? n);
        items.push({ id, kind: "building", name: n, lng, lat, source: "real" });
        anchorOf.set(id, [lng, lat]);
        pickOf.set(id, {
          kind: "place",
          place: {
            n,
            k: String(p.k ?? ""),
            c: String(p.c ?? ""),
            cf: Number.isFinite(Number(p.cf)) ? Number(p.cf) : void 0,
            p: [lng, lat],
            i: String(p.i ?? "")
          }
        });
      }
      const placeItems = placeLabelsFrom(reals.map((r) => ({ n: r.name, k: r.rawKind, p: [r.lng, r.lat], i: r.id })));
      for (const it of placeItems) {
        items.push(it);
        anchorOf.set(it.id, [it.lng, it.lat]);
        pickOf.set(it.id, { kind: "place", place: { n: it.name, k: it.placeType, p: [it.lng, it.lat], i: it.id } });
      }
      const adminItems = adminLabelsFrom(host.admins?.() || []);
      for (const it of adminItems) {
        items.push(it);
        anchorOf.set(it.id, [it.lng, it.lat]);
        pickOf.set(it.id, { kind: "place", place: { n: it.name, k: "admin", p: [it.lng, it.lat], i: it.id } });
      }
      const drawnNow = host.drawnBuildings ? host.drawnBuildings() : null;
      let drawnSource = drawnNow;
      let drawnFallback = false;
      if ((!drawnNow || !drawnNow.length) && host.buildingPool) {
        const pool = host.buildingPool() || [];
        const bb = view.bounds;
        if (!bb) {
          drawnSource = pool;
          drawnFallback = pool.length > 0;
        } else {
          const w0 = bb.getWest() - 0.01, e0 = bb.getEast() + 0.01;
          const s0 = bb.getSouth() - 0.01, n0 = bb.getNorth() + 0.01;
          const inView = [];
          for (const f of pool) {
            try {
              const p = bldPointOf(f);
              if (p && p[0] >= w0 && p[0] <= e0 && p[1] >= s0 && p[1] <= n0) inView.push(f);
            } catch {
            }
          }
          if (inView.length) {
            drawnSource = inView;
            drawnFallback = true;
          }
        }
      }
      if (drawnSource) {
        const namedSeen = /* @__PURE__ */ new Set();
        for (const it of buildingLabelsFrom(drawnSource)) {
          if (namedSeen.has(it.id)) continue;
          namedSeen.add(it.id);
          items.push(it);
          anchorOf.set(it.id, [it.lng, it.lat]);
          pickOf.set(it.id, { kind: "building", buildingId: it.id, name: it.name, lng: it.lng, lat: it.lat });
        }
      }
      const m = host.map();
      const vp = viewportOf();
      const z = m ? m.getZoom() : NaN;
      const tItems = clock();
      const bindOf = /* @__PURE__ */ new Map();
      const boundIds = /* @__PURE__ */ new Set();
      const heightByKey = /* @__PURE__ */ new Map();
      const unboundPoiIds = /* @__PURE__ */ new Set();
      const bindCount = {
        state: drawnSource && drawnSource.length ? "counted" : "uncounted",
        why: drawnSource && drawnSource.length ? null : "没有画出来的楼（仓库在视野内也没有楼）",
        hidden: 0,
        hiddenByRule: 0,
        notDrawn: 0,
        noBld: 0,
        ambiguous: 0,
        dup: 0,
        noId: 0,
        poolGrid: 0,
        poolQuery: 0
      };
      const hKey = (lng, lat) => `${lng.toFixed(7)},${lat.toFixed(7)}`;
      const poiCandidates = items.filter((it) => it.kind === "building").length;
      const areaCandidates = items.length - poiCandidates;
      const lp = labelPlanFor(z);
      const poiAllowed = !!lp.building;
      const poiGated = poiAllowed ? 0 : poiCandidates;
      let tGrid = tItems;
      const drawList = [];
      let drawGrid = null;
      let drawnWithHeight = 0;
      if (poiAllowed && drawnSource && drawnSource.length) {
        const other = [];
        const bodyIds = /* @__PURE__ */ new Set();
        for (const raw of drawnSource) {
          const g2 = bldGeoOfFeature(raw);
          if (!g2) continue;
          if (g2.top > 0) drawnWithHeight++;
          if (g2.part === "body" || !g2.part) {
            drawList.push(g2);
            if (g2.id) bodyIds.add(g2.id);
          } else {
            other.push(g2);
          }
        }
        for (const g2 of other) if (!g2.id || !bodyIds.has(g2.id)) drawList.push(g2);
      }
      drawGrid = buildBldGrid(drawList);
      tGrid = clock();
      const POOL_CELL = 2e-3;
      const poolPointGrid = () => {
        if (!host.buildingPool) return null;
        const pool = host.buildingPool() || [];
        const sig2 = `${pool.length}:${String(pool[0]?.id ?? "")}:${String(pool[pool.length - 1]?.id ?? "")}`;
        if (POOL_GRID_CACHE?.sig === sig2) return POOL_GRID_CACHE.bins;
        const bins = /* @__PURE__ */ new Map();
        for (const f of pool) {
          let p = null;
          try {
            p = bldPointOf(f);
          } catch {
            p = null;
          }
          if (!p) continue;
          const k = `${Math.floor(p[0] / POOL_CELL)},${Math.floor(p[1] / POOL_CELL)}`;
          const arr = bins.get(k);
          if (arr) arr.push({ f, p });
          else bins.set(k, [{ f, p }]);
        }
        if (POOL_GRID_CACHE && POOL_GRID_CACHE.sig !== sig2) POOL_CLASS_CACHE = /* @__PURE__ */ new Map();
        POOL_GRID_CACHE = { sig: sig2, bins };
        return bins;
      };
      const poolCandidates = (bins, pt) => {
        const i = Math.floor(pt[0] / POOL_CELL), j = Math.floor(pt[1] / POOL_CELL);
        const out = [];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const arr = bins.get(`${i + di},${j + dj}`);
          if (!arr) continue;
          for (const c of arr) {
            const g2 = bldGeoOfFeature(c.f);
            if (g2) out.push(g2);
          }
        }
        return out;
      };
      const unboundOnScreen = [];
      const boundItems = [];
      const noIdOnScreen = /* @__PURE__ */ new Set();
      const kept = [];
      for (const it of items) {
        if (it.kind !== "building") {
          kept.push(it);
          continue;
        }
        if (!poiAllowed) continue;
        const pt = [it.lng, it.lat];
        let onScreen = false;
        if (vp) {
          try {
            const p = m?.project(pt);
            onScreen = !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -64 && p.y >= -64 && p.x <= vp.width + 64 && p.y <= vp.height + 64;
          } catch {
            onScreen = false;
          }
        }
        if (!onScreen) continue;
        const hit2 = drawList.length && drawGrid ? bindPointToBuilding(pt, bldCandidates(drawGrid, pt)) : null;
        if (hit2 && hit2.bld.id) {
          const id = hit2.bld.id;
          if (boundIds.has(id)) {
            bindCount.dup++;
            continue;
          }
          boundIds.add(id);
          if (hit2.ambiguous) bindCount.ambiguous++;
          const c = [hit2.bld.cx, hit2.bld.cy];
          anchorOf.set(it.id, c);
          it.lng = c[0];
          it.lat = c[1];
          pickOf.set(it.id, { kind: "building", buildingId: id, name: it.name, lng: c[0], lat: c[1] });
          bindOf.set(it.id, { id, top: hit2.bld.top });
          if (hit2.bld.top > 0) heightByKey.set(hKey(c[0], c[1]), hit2.bld.top);
          boundItems.push(it);
          kept.push(it);
          continue;
        }
        if (hit2) {
          bindCount.noId++;
          noIdOnScreen.add(it.id);
        }
        unboundOnScreen.push(it);
      }
      const tBind = clock();
      const projectAt = (lng, lat) => {
        const h = heightByKey.get(hKey(lng, lat)) || 0;
        if (h > 0 && host.projectRoof) {
          const p = host.projectRoof(lng, lat, h);
          if (p) return { x: p.x, y: p.y };
        }
        const mm = host.map();
        return mm ? mm.project([lng, lat]) : { x: NaN, y: NaN };
      };
      const boundVisible = vp ? boundItems.filter((it) => {
        const p = projectAt(it.lng, it.lat);
        return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= -24 && p.y >= -24 && p.x <= vp.width + 24 && p.y <= vp.height + 24;
      }).length : 0;
      const hideUnbound = Number.isFinite(z) && z >= NAME_BIND_MIN_ZOOM && boundVisible >= NAME_BIND_HIDE_MIN_BOUND && !(host.showUnbound?.() ?? false);
      const classify2 = host.classifyUnbound ? !!host.classifyUnbound() : true;
      if (hideUnbound) {
        bindCount.hiddenByRule = unboundOnScreen.length;
        bindCount.hidden = unboundOnScreen.length;
        const tPoolGrid0 = clock();
        const poolBins = classify2 ? poolPointGrid() : null;
        bindCount.poolGrid = clock() - tPoolGrid0;
        if (poolBins) {
          const tPoolQ0 = clock();
          for (const it of unboundOnScreen) {
            if (noIdOnScreen.has(it.id)) continue;
            const ck = `${it.id}|${it.lng.toFixed(6)},${it.lat.toFixed(6)}`;
            let cat = POOL_CLASS_CACHE.get(ck);
            if (!cat) {
              const ph = bindPointToBuilding([it.lng, it.lat], poolCandidates(poolBins, [it.lng, it.lat]));
              cat = ph?.bld.id ? "notDrawn" : ph ? "noId" : "noBld";
              if (ph?.ambiguous) bindCount.ambiguous++;
              if (POOL_CLASS_CACHE.size > 5e3) POOL_CLASS_CACHE.clear();
              POOL_CLASS_CACHE.set(ck, cat);
            }
            if (cat === "notDrawn") bindCount.notDrawn++;
            else if (cat === "noId") bindCount.noId++;
            else bindCount.noBld++;
          }
          bindCount.poolQuery = clock() - tPoolQ0;
        } else if (classify2) {
          bindCount.why = bindCount.why || "没拿到楼仓库 ⇒ 未绑分类数不出来";
        }
      } else {
        for (const it of unboundOnScreen) {
          unboundPoiIds.add(it.id);
          kept.push(it);
        }
        if (unboundOnScreen.length && !host.showUnbound?.()) {
        }
      }
      const tPool = clock();
      items.splice(0, items.length, ...kept);
      const okCellKeys = wanted.filter((c) => cells.get(c.key)?.ok).map((c) => c.key).sort();
      const bindSig = [...bindOf.entries()].map(([id, b]) => `${id}:${b.id}:${b.top.toFixed(1)}`).join(",");
      const dataSig = `${labelItemsSig(items)}|bind=${bindSig}|w=${wanted.length}|c=${hitCells}|ok=${okCellKeys.join(",")}`;
      let key = null;
      const vb = view.bounds;
      const vc = view.center;
      if (m && vp && vb && vc) {
        key = {
          tier: labelTierOf(z),
          centerLng: vc.lng,
          centerLat: vc.lat,
          /* 视野跨度（度）：用来把中心位移折成**屏幕像素**（判据在 `wsLabels.planDriftPx`）。
             跨度缺失/不为正时 `planDriftPx` 返回 `Infinity` ⇒ 判 `drift` 重算（保守，不静默复用）。 */
          spanLng: vb.getEast() - vb.getWest(),
          spanLat: vb.getNorth() - vb.getSouth(),
          viewW: vp.width,
          viewH: vp.height,
          dataSig
        };
      }
      let gateForced = null;
      if (key && payload && planCache.reasonFor(key) === "reuse") {
        const g0 = gate.sample(payload.facts.density, now());
        if (!g0.changed) {
          planCache.run(key, () => payload.picked);
          const st = planCache.stats();
          const rp = planFromPayload(payload);
          lastPlan = rp.plan;
          last = {
            ...payload.facts,
            ...countNodes(lastPlan.nodes),
            droppedByViewport: (payload.facts.droppedByViewport || 0) + rp.dropped,
            planComputes: st.computes,
            planReuses: st.reuses,
            planReason: st.lastReason,
            ms: { fetch: tFetch - t0, items: tItems - tFetch, grid: tGrid - tItems, bindDrawn: tBind - tGrid, bindPool: 0, poolGrid: 0, poolQuery: 0, zones: 0, pick: 0, nodes: 0, total: clock() - t0 }
          };
          return emit();
        }
        gateForced = g0.zoneMode;
      }
      let picked = null;
      if (m && vp) {
        picked = key ? planCache.run(key, () => pickLabels(items, projectAt, vp, lp, { gridPx: LABEL_MOTION.gridPx })) : pickLabels(items, projectAt, vp, lp, { gridPx: LABEL_MOTION.gridPx });
      }
      const density = picked ? picked.candidates > 0 ? picked.droppedByCollision / picked.candidates : null : null;
      const g = gateForced === null ? gate.sample(density, now()) : { zoneMode: gateForced, changed: true, reason: "复用分支里闸门已切档" };
      const mode = g.zoneMode ? "zones" : "names";
      const tZonesA = clock();
      const zonesPlan = mode === "zones" ? planZoneNames(points, reals, {
        subDeg: WS_ZONE_SUB_DEG,
        /* 容器 = **这一轮真取到的** 0.05° 格（视野边缘的半格不出结论） */
        containerDeg: cellSize,
        containers: okCellKeys
      }) : { zones: [], cells: 0, eligible: 0, overHalf: 0 };
      const tZones = clock();
      const zoneReal = zonesPlan.zones.filter((z2) => z2.source === "real");
      const zoneCalc = zonesPlan.zones.filter((z2) => z2.source !== "real");
      const zonePickReal = pickZoneNames(zoneReal, Math.min(NAMES_ZONE_REAL_MAX, NAMES_ZONE_CAP));
      const zonePickCalc = pickZoneNames(zoneCalc, Math.max(0, NAMES_ZONE_CAP - zonePickReal.shown.length));
      const zoneShown = [...zonePickReal.shown, ...zonePickCalc.shown];
      const tPick = clock();
      const nodes = [];
      let zoneDroppedOffscreen = 0;
      const roofCount = { three: 0, approx: 0, ground: 0, none: 0 };
      const nodeOfLabel = (s) => {
        const a = anchorOf.get(s.id);
        const b = bindOf.get(s.id);
        let x = s.x, y = s.y;
        let roofH = 0;
        if (b && a) {
          roofH = b.top > 0 ? b.top : 0;
          if (roofH > 0 && host.projectRoof) {
            const p = host.projectRoof(a[0], a[1], roofH);
            if (p) {
              x = p.x;
              y = p.y;
              if (p.via === "matrix3d") roofCount.three++;
              else if (p.via === "approx") roofCount.approx++;
              else roofCount.ground++;
            } else roofCount.none++;
          } else if (roofH > 0) {
            roofCount.none++;
          }
        }
        return {
          slot: 0,
          id: s.id,
          text: s.name,
          style: "real",
          sketch: false,
          x,
          y,
          w: s.w,
          h: s.h,
          lng: a ? a[0] : 0,
          lat: a ? a[1] : 0,
          buildingId: b?.id,
          roofH,
          why: b ? `楼名（楼 ${b.id} · 楼顶 ${b.top.toFixed(1)}m）` : `真名（${s.kind} · 优先级 ${s.priority}）`,
          pick: pickOf.get(s.id) || { kind: "building", buildingId: s.id, name: s.name, lng: a ? a[0] : 0, lat: a ? a[1] : 0 }
        };
      };
      if (picked && vp) {
        if (mode === "names") {
          for (const s of picked.shown) nodes.push(nodeOfLabel(s));
        } else {
          const big = picked.shown.filter((s) => s.kind === "admin" || s.kind === "place").slice(0, NAMES_BIG_KEEP);
          for (const s of big) nodes.push(nodeOfLabel(s));
          for (const z2 of zoneShown) {
            const n = nodeOfZone(z2);
            if (vp) {
              const pad = 24;
              const inView = n.x >= -pad && n.y >= -pad && n.x <= vp.width + pad && n.y <= vp.height + pad;
              if (!inView) {
                zoneDroppedOffscreen++;
                continue;
              }
            }
            nodes.push(n);
          }
        }
      }
      let fallbackAdded = 0;
      if (hideUnbound && mode === "names" && !nodes.some((n) => !!n.buildingId) && unboundOnScreen.length) {
        for (const it of unboundOnScreen) {
          if (nodes.length >= lp.cap) break;
          if (unboundPoiIds.has(it.id)) continue;
          const p = projectAt(it.lng, it.lat);
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -24 || p.y < -24 || p.x > (vp?.width ?? 0) + 24 || p.y > (vp?.height ?? 0) + 24) continue;
          const box = labelBox(it.name, "building");
          nodes.push({
            slot: 0,
            id: it.id,
            text: it.name,
            style: "real",
            sketch: false,
            x: p.x,
            y: p.y,
            w: box.w,
            h: box.h,
            lng: it.lng,
            lat: it.lat,
            why: "真名（未绑·补位）",
            pick: pickOf.get(it.id) || { kind: "place", place: { n: it.name, p: [it.lng, it.lat] } }
          });
          unboundPoiIds.add(it.id);
          fallbackAdded++;
        }
        if (fallbackAdded) bindCount.hidden = Math.max(0, bindCount.hidden - fallbackAdded);
      }
      let droppedByViewport = 0;
      if (vp) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          if (labelDomFits(n.text, n.x, n.y, vp.width, vp.height)) continue;
          nodes.splice(i, 1);
          droppedByViewport++;
        }
      }
      nodes.forEach((n, i) => {
        n.slot = i;
      });
      const tNodes = clock();
      const lite = nodes.length > LABEL_MOTION.liteAbove;
      const sig = mode + "|" + nodes.map((n) => n.id + ":" + n.text).join(",");
      const sigChanged = sig !== lastBatchSig;
      if (sigChanged) {
        batch2++;
        lastBatchSig = sig;
      }
      const keyOf = (n) => n.id + "" + n.text;
      const prevNodes = payload ? payload.nodes : [];
      const nextKeys = new Set(nodes.map(keyOf));
      const prevKeys = new Set(prevNodes.map(keyOf));
      const entered = nodes.filter((n) => !prevKeys.has(keyOf(n))).map((n) => n.id);
      const exited = prevNodes.filter((n) => !nextKeys.has(keyOf(n))).map(projectNode);
      lastPlan = {
        mode,
        nodes,
        batch: batch2,
        lite,
        cameraOpacity: LABEL_MOTION.cameraOpacity,
        changed: sigChanged,
        entered,
        exited
      };
      const realLabels = nodes.filter((n) => n.style === "real").length;
      const zoneLabels = nodes.filter((n) => n.pick.kind === "zone").length;
      const bigLabels = nodes.length - zoneLabels;
      last = {
        state: "counted",
        labels: nodes.length,
        pickedShown: picked?.shown.length ?? 0,
        realLabels,
        zoneLabels,
        bigLabels,
        zoneDerived: nodes.filter((n) => n.style === "derived").length,
        /* 区名里**不是数据驱动**的那些（真名区 + 示意区）—— 数据驱动的另有一个数 */
        zoneSketch: nodes.filter((n) => n.pick.kind === "zone" && n.style !== "derived").length,
        generatedOnScreen: 0,
        candidates: picked?.candidates ?? 0,
        droppedByCollision: picked?.droppedByCollision ?? 0,
        droppedByCap: picked?.droppedByCap ?? 0,
        capped: !!picked?.capped,
        skippedNoName: picked?.skippedNoName ?? 0,
        /* **视野外丢弃** = 真名候选被 `pickLabels` 丢的 + 区名锚点在画布外被丢的（同一口径，一个数） */
        skippedOffscreen: (picked?.skippedOffscreen ?? 0) + zoneDroppedOffscreen,
        droppedByViewport,
        density,
        mode,
        cells: wanted.length,
        hit: hitCells,
        missing,
        failed,
        points: points.length,
        droppedByConf,
        zoneCells: zonesPlan.cells,
        zoneEligible: zonesPlan.eligible,
        zoneOverHalf: zonesPlan.overHalf,
        attribution: indexFact.attribution,
        cellSize,
        planComputes: planCache.stats().computes,
        planReuses: planCache.stats().reuses,
        planReason: planCache.stats().lastReason,
        bindState: bindCount.state,
        bindWhy: bindCount.why,
        bindClass: classify2 ? "counted" : "skipped",
        boundNames: nodes.filter((n) => !!n.buildingId).length,
        unboundPoiNames: nodes.filter((n) => unboundPoiIds.has(n.id)).length,
        hiddenUnbound: bindCount.hidden,
        hiddenByRule: bindCount.hiddenByRule,
        boundButNotDrawn: bindCount.notDrawn,
        noBldNear: bindCount.noBld,
        ambiguous: bindCount.ambiguous,
        droppedByDupBld: bindCount.dup,
        noBldId: bindCount.noId,
        roof3d: roofCount.three,
        roofApprox: roofCount.approx,
        roofGround: roofCount.ground,
        roofNull: roofCount.none,
        ms: { fetch: tFetch - t0, items: tItems - tFetch, grid: tGrid - tItems, bindDrawn: tBind - tGrid, bindPool: tPool - tBind, poolGrid: bindCount.poolGrid, poolQuery: bindCount.poolQuery, zones: tZones - tZonesA, pick: tPick - tZones, nodes: tNodes - tPick, total: tNodes - t0 },
        drawnSource: drawnSource && drawnSource.length ? drawnFallback ? "pool" : "drawn" : "none",
        drawnCount: drawnSource ? drawnSource.length : 0,
        drawnWithHeight,
        fallbackNames: fallbackAdded,
        poiCandidates,
        poiGated,
        areaCandidates,
        why: hitCells === 0 && wanted.length > 0 ? "视野里的格一格都没取到" : null
      };
      if (picked) {
        payload = { nodes, facts: last, picked, mode, batch: batch2, lite };
      } else {
        payload = null;
      }
      return emit();
    } catch (e) {
      last = { ...emptyFacts2(true), state: "uncounted", why: String(e?.message || e).slice(0, 60) };
      host.onError?.("names " + last.why);
      return emit();
    }
  }
  function nodeOfZone(z) {
    let x = 0;
    let y = 0;
    try {
      const m = host.map?.();
      if (m && Number.isFinite(z.lng) && Number.isFinite(z.lat)) {
        const p = m.project([z.lng, z.lat]);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          x = p.x;
          y = p.y;
        }
      }
    } catch {
    }
    return {
      slot: 0,
      id: z.id,
      text: z.label,
      style: z.style,
      sketch: z.sketch,
      x,
      y,
      w: 0,
      h: 0,
      lng: z.lng,
      lat: z.lat,
      why: z.why,
      pick: { kind: "zone", zone: z }
    };
  }
  function emit() {
    try {
      host.onPlan?.(lastPlan, last);
    } catch {
    }
    return last;
  }
  function reproject() {
    if (!payload) return null;
    if (host.enabled && !host.enabled()) return null;
    const rp = planFromPayload(payload);
    lastPlan = rp.plan;
    last = { ...last, ...countNodes(lastPlan.nodes), droppedByViewport: (payload.facts.droppedByViewport || 0) + rp.dropped };
    emit();
    return lastPlan;
  }
  return {
    refresh,
    reproject,
    facts: () => last,
    plan: () => lastPlan,
    verdict: () => nameVerdictLine(last)
  };
}

// src/components/views/worldsim/wsBuildingHint.ts
function ringsOf(geometry) {
  const g = geometry || {};
  if (g.type === "Polygon") {
    const c = g.coordinates;
    return c && c[0] ? [c[0]] : [];
  }
  if (g.type === "MultiPolygon") {
    const c = g.coordinates;
    return Array.isArray(c) ? c.map((p) => p[0]).filter(Boolean) : [];
  }
  return [];
}
function ringCenter(ring) {
  if (!ring || ring.length < 3) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length - 1 || ring.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// src/components/views/worldsim/wsBuildingCard.ts
var CARD_MOTION = {
  /* 入场（§4.3 ①） */
  enterMs: 200,
  enterScaleFrom: 0.88,
  /* 内容层（§4.3 ③）：4 层，起于 60ms，每层 140ms，错峰 30ms ⇒ 末层 150→290ms */
  contentMs: 140,
  contentStartMs: 60,
  contentStaggerMs: 30,
  contentLayers: 4,
  contentShiftPx: 6,
  /* 退场（§4.3 ④） */
  exitMs: 160,
  exitScaleTo: 0.96,
  exitShiftPx: 8,
  /* 遮罩（§4.3 ②）：纯色，**禁 backdrop-filter**；退场晚 40ms 收 */
  scrimMs: 160,
  scrimDelayMs: 40,
  scrimOpacity: 0.32,
  /* 生长原点夹紧（§4.3：不夹的话从屏幕角落点开会"飞"很长一段，像贴纸不像生长） */
  originClampPx: 40,
  /* 区名入口 = 底部升起（§4.4：方向可以不同，**节奏不许不同**） */
  sheetEnterY: 24,
  /* 命中区（UI-DESIGN-SPEC §六-5）：标签/楼体的可点区 ≥ 44×44 */
  minHitPx: 44,
  /* 降级（§4.3 降级表）：低档去掉位移、内容不分层；reduced-motion 纯淡入（保留终态） */
  lowEnterMs: 140,
  lowEnterScaleFrom: 0.96,
  lowContentMs: 120,
  lowContentStartMs: 40,
  reducedMs: 120,
  /* 曲线（§3.2 全项目只有两条） */
  easeEnter: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  easeLeave: "cubic-bezier(0.3, 0, 1, 1)"
};
var CARD_ANIM_PROPS = ["transform", "opacity"];
var CARD_DOM_ID = "ws-card";
var CARD_DATA_ATTRS = [
  "data-ws-card",
  "data-ws-card-kind",
  "data-ws-card-source",
  "data-ws-card-id"
];
var CARD_STRINGS = {
  tagReal: "真名",
  tagSketch: WS_GEN_TAG,
  typeUnknown: "类型未登记",
  nameUncountable: "名字数不出来",
  nameUncountableWhy: "这栋楼连 id 都没有 —— 生成名必须由 id 决定（同 id 永远同名），凭空起一个会让每次刷新都换名字",
  heightReal: "真数据（OSM 写了 height）",
  heightLevels: "层数×3（OSM 写了层数，后端已折算）",
  heightKind: "**按类型估**（不是真数据：中国 OSM 楼高覆盖率只有一两成）",
  heightNone: "未登记",
  attrMissing: "署名取不到（包索引里没有 attribution）",
  chatSketchPlaceholder: "（生成·示意名，不入对话）",
  zoneReal: "真名区",
  zoneDerived: "数据驱动区",
  zoneSketch: "示意区"
};
function str(v) {
  return String(v ?? "").trim();
}
function fin(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function cardBuildingId(b) {
  if (!b) return null;
  const p = b.properties || {};
  const canon = bldIdOfFeature({ id: b.id, properties: p });
  if (canon) return canon;
  for (const v of [p.osm_id, p.id, b.id, b.i, p.i]) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}
function cardBuildingPoint(b) {
  if (!b) return null;
  const lng = fin(b.lng), lat = fin(b.lat);
  if (lng !== null && lat !== null) return [lng, lat];
  let rings = [];
  if (b.geometry) rings = ringsOf(b.geometry);
  else if (Array.isArray(b.p)) {
    const p = b.p;
    rings = Array.isArray(p[0]) && Array.isArray(p[0][0]) && Array.isArray(p[0][0][0]) ? p.map((q) => q[0]).filter(Boolean) : p;
  }
  for (const r of rings) {
    const c = ringCenter(r);
    if (c) return c;
  }
  return null;
}
function cardTypeOf(kind, src) {
  if (kind === "zone") {
    const z = src.zone;
    if (!z) return { type: CARD_STRINGS.typeUnknown, known: false, hint: null };
    const how = z.source === "real" ? CARD_STRINGS.zoneReal : z.source === "derived" ? CARD_STRINGS.zoneDerived : CARD_STRINGS.zoneSketch;
    return { type: how, known: true, hint: z.why };
  }
  if (kind === "place") {
    const c = str(src.place?.c);
    const k = str(src.place?.k);
    if (!c && !k) return { type: CARD_STRINGS.typeUnknown, known: false, hint: null };
    return {
      type: c || k,
      known: true,
      hint: c && k ? `Overture 原始类别 ${c} · 粗类 ${k}` : c ? "Overture 原始类别" : "Overture 粗类"
    };
  }
  const p = src.building?.properties || {};
  const kindV = str(p.kind) || str(p.subtype) || str(p.class);
  if (!kindV || kindV === "yes") return { type: CARD_STRINGS.typeUnknown, known: false, hint: kindV === "yes" ? "OSM 只写了 building=yes（没说是什么楼）" : null };
  return { type: kindV, known: true, hint: "来自 OSM `building=*`" };
}
function cardAttributionOf(index) {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}
function buildingCardData(input) {
  const kind = input && input.kind ? input.kind : "building";
  const index = input ? input.index : null;
  const attribution = cardAttributionOf(index);
  const typeInfo = cardTypeOf(kind, { building: input?.building, place: input?.place, zone: input?.zone });
  const realName = kind === "place" ? str(input?.place?.n ?? input?.place?.name) : kind === "zone" ? str(input?.zone?.name) : str((input?.building?.properties || {}).name);
  const id = kind === "place" ? str(input?.place?.i || input?.place?.id) || null : kind === "zone" ? str(input?.zone?.id) || null : cardBuildingId(input?.building);
  let state;
  let title;
  let titleTag = null;
  let sketch = false;
  let why = "";
  if (realName) {
    state = "real";
    title = realName;
    if (kind === "zone") {
      const z = input?.zone;
      sketch = !!z.sketch;
      if (z.source === "real") {
        titleTag = CARD_STRINGS.tagReal;
        why = z.why;
      } else if (z.source === "derived") {
        titleTag = "数据驱动";
        why = z.why;
      } else {
        titleTag = CARD_STRINGS.tagSketch;
        why = z.why;
      }
    } else if (kind === "place") {
      titleTag = CARD_STRINGS.tagReal;
      why = `真名来自 Overture places（${str(input?.place?.k) || "粗类未登记"}）`;
    } else {
      titleTag = CARD_STRINGS.tagReal;
      why = "真名来自 OSM `name`";
    }
  } else if (kind !== "place" && kind !== "zone" && id && !input?.noSketch) {
    state = "generated";
    title = genName(id, input?.genKind || "shop");
    titleTag = CARD_STRINGS.tagSketch;
    sketch = true;
    why = `这栋楼**没有真名**（实测真名覆盖率只有 2.0%）⇒ 这是由 id 决定的**${WS_GEN_TAG}**名（同 id 永远同名），只上屏、不进数据与对话`;
  } else {
    state = "uncountable";
    title = CARD_STRINGS.nameUncountable;
    titleTag = null;
    sketch = false;
    why = input?.noSketch ? "调用方显式禁用生成名（noSketch）" : CARD_STRINGS.nameUncountableWhy;
  }
  let height = null;
  let heightFrom = "none";
  let levels = null;
  if (kind === "building") {
    const p = input?.building?.properties || {};
    const src = str(p.height_src) || "default";
    levels = fin(p.levels);
    if (src === "height" || src === "levels") {
      const rh = renderHeight(p);
      height = Number.isFinite(rh.h) ? rh.h : null;
      heightFrom = src === "height" ? "real" : "levels";
    } else if (levels !== null && levels > 0) {
      heightFrom = "levels";
      height = Math.round(levels * 3 * 10) / 10;
    } else {
      const rh = renderHeight(p);
      height = Number.isFinite(rh.h) ? rh.h : null;
      heightFrom = height === null ? "none" : "kind";
    }
  }
  const heightText = height === null ? CARD_STRINGS.heightNone : heightFrom === "real" ? `${height} m · ${CARD_STRINGS.heightReal}` : heightFrom === "levels" ? `${height} m · ${CARD_STRINGS.heightLevels}` : `${height} m · ${CARD_STRINGS.heightKind}`;
  const ll = kind === "place" ? fin(input?.place?.p?.[0]) !== null && fin(input?.place?.p?.[1]) !== null ? [Number(input?.place?.p?.[0]), Number(input?.place?.p?.[1])] : fin(input?.place?.lng) !== null && fin(input?.place?.lat) !== null ? [Number(input?.place?.lng), Number(input?.place?.lat)] : null : kind === "zone" ? input?.zone && Number.isFinite(input.zone.lng) && Number.isFinite(input.zone.lat) ? [input.zone.lng, input.zone.lat] : null : cardBuildingPoint(input?.building);
  const lng = ll ? +ll[0].toFixed(6) : null;
  const lat = ll ? +ll[1].toFixed(6) : null;
  const fields = [];
  fields.push({ key: "name", label: "名字", value: title, tone: sketch ? "sketch" : state === "real" ? "real" : "muted", hint: why });
  if (titleTag) fields.push({ key: "nameSource", label: "名字来源", value: titleTag, tone: sketch ? "sketch" : "real", hint: why });
  fields.push({ key: "type", label: "类型", value: typeInfo.type, tone: typeInfo.known ? "real" : "muted", hint: typeInfo.hint || void 0 });
  if (kind === "building") fields.push({ key: "height", label: "高度", value: heightText, tone: heightFrom === "kind" ? "warn" : heightFrom === "none" ? "muted" : "real", hint: heightFrom === "kind" ? CARD_STRINGS.heightKind : void 0 });
  if (kind === "building" && levels !== null) fields.push({ key: "levels", label: "层数", value: String(levels), tone: "real", hint: "OSM `building:levels`" });
  if (kind === "place" && Number.isFinite(Number(input?.place?.cf))) {
    fields.push({ key: "cf", label: "置信度", value: Number(input?.place?.cf).toFixed(3), tone: Number(input?.place?.cf) >= 0.5 ? "real" : "warn", hint: "Overture `confidence`；运行期建议阈值 0.5" });
  }
  if (kind === "zone" && input?.zone) {
    const z = input.zone;
    const shareTxt = z.share === null ? "不适用（真名）" : `${z.count}/${z.total} = ${(z.share * 100).toFixed(1)}%`;
    fields.push({ key: "zoneDominant", label: "主导类占比", value: shareTxt, tone: z.source === "derived" ? "real" : z.source === "generated" ? "sketch" : "muted", hint: z.why });
    const spanDeg = +(z.bbox[2] - z.bbox[0]).toFixed(4);
    fields.push({ key: "zoneBbox", label: "范围", value: `[${z.bbox.join(", ")}]（${spanDeg}° 子格）`, tone: "muted", hint: "区名的作用范围 = 一个 0.01° 子格（≈1.1km）" });
  }
  fields.push({ key: "id", label: "id", value: id || "（无 id）", tone: id ? "real" : "warn", hint: id ? "稳定 id（生成名就是由它决定）" : "没有 id ⇒ 生成名也拿不到（第三态）" });
  fields.push({ key: "coord", label: "坐标", value: lng === null || lat === null ? "数不出来" : `${lng}, ${lat}`, tone: lng === null ? "muted" : "real" });
  fields.push({ key: "attribution", label: "署名", value: attribution || CARD_STRINGS.attrMissing, tone: attribution ? "muted" : "warn", hint: "数据合规项：原话来自包索引，不在代码里另写" });
  const origin = cardOriginOf(input?.click, input?.cardRect, kind === "zone");
  return {
    kind,
    id,
    state,
    title,
    titleTag,
    sketch,
    type: typeInfo.type,
    typeKnown: typeInfo.known,
    typeHint: typeInfo.hint,
    height,
    heightText,
    heightFrom,
    levels,
    lng,
    lat,
    fields,
    attribution,
    why,
    origin,
    domId: CARD_DOM_ID,
    dataAttrs: {
      "data-ws-card": kind,
      "data-ws-card-kind": kind,
      "data-ws-card-source": state,
      "data-ws-card-id": id || ""
    }
  };
}
function cardOriginOf(click, cardRect, fromSheet = false) {
  if (!click || !cardRect) return null;
  const cx = Number(cardRect.x) + Number(cardRect.w) / 2;
  const cy = Number(cardRect.y) + Number(cardRect.h) / 2;
  if (![click.x, click.y, cx, cy].every((v) => Number.isFinite(Number(v)))) return null;
  const max = CARD_MOTION.originClampPx;
  const rawX = Number(click.x) - cx;
  const rawY = Number(click.y) - cy;
  const dx = Math.max(-max, Math.min(max, rawX));
  const dy = Math.max(-max, Math.min(max, rawY));
  return {
    dx: +dx.toFixed(2),
    dy: +dy.toFixed(2),
    clamped: Math.abs(rawX) > max || Math.abs(rawY) > max,
    fromSheet: !!fromSheet
  };
}
function cardEnterStyle(o) {
  if (o && o.fromSheet) return { transform: `translate3d(0, ${CARD_MOTION.sheetEnterY}px, 0)` };
  if (o) return { transform: `translate3d(${o.dx}px, ${o.dy}px, 0) scale(${CARD_MOTION.enterScaleFrom})` };
  return { opacity: "0" };
}
var CARD_BASE_TRANSFORM = "translate(-50%, -50%)";
function cardComposeTransform(extra) {
  const e = String(extra || "").trim();
  return e ? `${CARD_BASE_TRANSFORM} ${e}` : `${CARD_BASE_TRANSFORM} translate3d(0, 0, 0)`;
}
function cardRestTransform() {
  return cardComposeTransform("translate3d(0, 0, 0) scale(1)");
}
function cardExitTransform() {
  return cardComposeTransform(`translate3d(0, ${CARD_MOTION.exitShiftPx}px, 0) scale(${CARD_MOTION.exitScaleTo})`);
}
function cardChatText(d, opts = {}) {
  const head = opts.header || (d.kind === "place" ? "地点" : d.kind === "zone" ? "区域" : "楼房");
  const name = d.sketch ? CARD_STRINGS.chatSketchPlaceholder : d.title;
  const lines = [`${head}：${name}（${d.titleTag || "无名"}）`, `类型：${d.type}`];
  if (d.kind === "building") lines.push(`高度：${d.heightText}`);
  lines.push(`id：${d.id || "无"}`);
  if (d.lng !== null && d.lat !== null) lines.push(`坐标：${d.lng}, ${d.lat}`);
  if (d.attribution) lines.push(`署名：${d.attribution}`);
  return lines.join("\n");
}
function cardIsChatSafe(d) {
  return !d.sketch;
}
function cardVerdictLine(d) {
  const tag = d.state === "real" ? "真名" : d.state === "generated" ? WS_GEN_TAG : "数不出来";
  if (d.state === "uncountable") return `🪪 卡片「${d.title}」（${tag}：${d.why.slice(0, 60)}）`;
  return `🪪 卡片「${d.title}」（${tag}）· 类型 ${d.type} · ${d.kind === "building" ? "高 " + d.heightText + " · " : ""}id ${d.id || "无"}`;
}
export {
  ANTENNA_M,
  ANTENNA_MIN_H,
  BLD_BUNDLE_CELL_DEG,
  BLD_BUNDLE_MAX_CELLS,
  BLD_BUNDLE_PER_REFRESH,
  BLD_PART_TIER,
  BLD_STORE_CAP,
  BLD_STORE_CAP_MAX,
  BLD_STORE_CAP_RECOMMENDED,
  BUILDING_LAYER_ID,
  BUNDLE_BYTES_PER_ROUND,
  BUNDLE_REQ_PER_ROUND_MAX,
  BUNDLE_TIMEOUT_MS,
  CAMERA_DEFAULTS,
  CARD_ANIM_PROPS,
  CARD_BASE_TRANSFORM,
  CARD_DATA_ATTRS,
  CARD_DOM_ID,
  CARD_MOTION,
  CARD_STRINGS,
  DEFAULT_FLUSH_COALESCE_MS,
  DEFAULT_PARSED_CACHE_CELLS,
  EQUIP_MIN_AREA_M2,
  EQUIP_SIDE_MIN,
  EQUIP_SIDE_STEPS,
  EQUIP_SIDE_STEP_M,
  FALLBACK_HEIGHT_M,
  FOOTPRINT_LAYER_ID,
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
  LABEL_ANIM_PROPS,
  LABEL_CAMERA_CLASS,
  LABEL_DOM_BOX,
  LABEL_DOM_CLASS,
  LABEL_MOTION,
  LABEL_PLAN_DRIFT_RATIO,
  LABEL_ROOT_CLASS,
  LABEL_STYLE_CLASS,
  LOD_FAR_ZOOM,
  LOD_LIVE_LAYER_PREFIXES,
  LOD_LIVE_SOURCE_IDS,
  LOD_NEAR_ZOOM,
  LOD_OPACITY_STOPS,
  LOD_OPACITY_ZERO_ZOOM,
  LOD_VIEW_TILE_CAP,
  MAX_RENDER_H,
  NAMES_BIG_KEEP,
  NAMES_BUNDLE_CELL_DEG,
  NAMES_BUNDLE_DIR,
  NAMES_MAX_CELLS,
  NAMES_MIN_CONF_FALLBACK,
  NAMES_PER_REFRESH,
  NAMES_STORE_CAP,
  NAMES_TIMEOUT_MS,
  NAMES_ZONE_CAP,
  NAMES_ZONE_REAL_MAX,
  NAME_BIND_HIDE_MIN_BOUND,
  NAME_BIND_MIN_ZOOM,
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
  WS_ART_PATCHES,
  WS_ART_RAMP_HI,
  WS_BLD_BUDGET_PX2,
  WS_BLD_BUDGET_VERTS,
  WS_BLD_CELL_CAP,
  WS_BLD_CELL_CAP_REF_DEG,
  WS_BLD_CELL_DEG,
  WS_BLD_DETAIL_EQUIP_ZOOM,
  WS_BLD_DETAIL_ROOF_ZOOM,
  WS_BLD_FALLBACK_OPACITY,
  WS_BLD_FALLBACK_OUTLINE,
  WS_BLD_FALLBACK_RAMP,
  WS_BLD_FOOTPRINT_MAXZOOM,
  WS_BLD_FOOTPRINT_OPACITY,
  WS_BLD_INVIEW_DEFAULT,
  WS_BLD_LIVE_DEFAULT,
  WS_BLD_LIVE_VERDICT,
  WS_BLD_MAX_DRAWN,
  WS_BLD_MAX_DRAWN_MANY,
  WS_BLD_NEAR_K,
  WS_BLD_OUTLINE_FULL_ZOOM,
  WS_BLD_OUTLINE_STOPS,
  WS_BLD_SMALL_M2,
  WS_BLD_TIER_HYSTERESIS,
  WS_BLD_VECTOR_MINZOOM,
  WS_BLD_VERTS_PER_SEGMENT,
  WS_BLD_VIEW_CAP,
  WS_BLD_WALK_BUF_MAX,
  WS_BLD_WALK_K,
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
  WS_ZONE_COARSE_KINDS,
  WS_ZONE_DERIVED_SUFFIX,
  WS_ZONE_DOMINANCE,
  WS_ZONE_ENTER_RATIO,
  WS_ZONE_EXIT_RATIO,
  WS_ZONE_GEN_TAG,
  WS_ZONE_KIND_LABEL,
  WS_ZONE_MIN_COUNT,
  WS_ZONE_REAL_TIER_RANK,
  WS_ZONE_SAMPLES,
  WS_ZONE_SUB_DEG,
  WS_ZONE_SWITCH_MIN_MS,
  WS_ZONE_UNCLASSIFIED,
  adminLabelsFrom,
  applyBuildingsTo,
  applyGwLayers,
  applyMvtBldKFilter,
  applyMvtTo,
  applyPitchGuard,
  art3Summary,
  artPatchValueOf,
  artRamp,
  bindPointToBuilding,
  bldArtParamsOf,
  bldBundleCellKey,
  bldBundleCellOf,
  bldBundleCellsForView,
  bldCapForCellDeg,
  bldDetailTierZoom,
  bldFootprintAreaM2,
  bldGeoOfFeature,
  bldIdOf,
  bldInRingOf,
  bldKPinOf,
  bldLayerSpecsFor,
  bldLayerVisibilityAt,
  bldLayersPresent,
  bldLiveDecision,
  bldMaxDrawnOf,
  bldMetersPerCssPixel,
  bldNearKOf,
  bldPartsVisibleAt,
  bldPointOf,
  bldPointOfRaw,
  bldPxPerMeter,
  bldRampColorExpr,
  bldResolvedCellDeg,
  bldRingAreaM2,
  bldRingCentroid,
  bldRingOf,
  bldRingVertices,
  bldScreenCost,
  bldStaticMeasureOf,
  bldStaticOrderCompare,
  bldStaticScoreOf,
  bldTierOfPart,
  bldTierOfZoom,
  bldVerdictState,
  bldVerdictText,
  bldWalkKOf,
  buildBldBoxes,
  buildSkyGeometry,
  buildTransport,
  buildingCardData,
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
  cardAttributionOf,
  cardBuildingId,
  cardBuildingPoint,
  cardChatText,
  cardComposeTransform,
  cardEnterStyle,
  cardExitTransform,
  cardIsChatSafe,
  cardOriginOf,
  cardRestTransform,
  cardTypeOf,
  cardVerdictLine,
  coarseKindOf,
  contrastRatio,
  contrastReport,
  createBldGlLayer,
  createBldPickStore,
  createBundleFeed,
  createFeatureStore,
  createGwLayer,
  createLabelPlanCache,
  createNameLayer,
  createWsLog,
  createZoneModeGate,
  dayHash,
  dayKeyOf,
  decorateBuildings,
  derivedZoneNameOf,
  distM,
  districtStyleOf,
  dressBase,
  ensureBldLayers,
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
  hash32,
  heightColorExpression,
  hexRgb,
  hexToRgb,
  horizonYOf,
  insetRing,
  insetRingMeters,
  junctions,
  labelBox,
  labelDomFits,
  labelDomRect,
  labelItemAllowed,
  labelItemsSig,
  labelKindAllowed,
  labelPlanFor,
  labelPriorityOf,
  labelTextWidth,
  labelTierOf,
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
  lookIdOf,
  mercatorXOf,
  mercatorYOf,
  metersBetween,
  metersToMercator,
  mvtArtFromLegacySpecs,
  mvtBldLayerFilter,
  mvtBldLayerSpecs,
  mvtBldRkFilter,
  mvtHeightColorExpression,
  namePointsOfCell,
  nameVerdictLine,
  namesCellUrl,
  namesIndexUrl,
  nearestOnLine,
  outerRingsOfGeom,
  outlineWidthAt,
  outlineWidthExpr,
  panDamping,
  parseArtParam,
  parseBldnParam,
  parseBundleJson,
  parseInViewParam,
  parseLookParam,
  pickBuildingsByBudget,
  pickBuildingsForView,
  pickHome,
  pickLabels,
  pickZoneNames,
  pitchGuardParams,
  pixelRatioForTier,
  placeLabelsFrom,
  placeTierOf,
  placesBundleCellsForView,
  placesIdOf,
  placesPointOf,
  planBeforeOf,
  planDaily,
  planDriftPx,
  planEnsureRoadOrder,
  planGenNames,
  planStalls,
  planZoneNames,
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
  realNamesOfCell,
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
  sketchZoneNameOf,
  toLngLat,
  toMeters,
  toggleTask,
  transportHudLine,
  viewHalfMetersOf,
  visibleRoadCount,
  windowPatternSpec,
  wsFetchRadiusMax,
  zoneAttributionOf,
  zoneBucketsOf,
  zoneClickPayload,
  zoneContainerKeyOf,
  zoneDensityOf,
  zoneDominantOf,
  zoneFactsOf,
  zoneGridCompatible,
  zoneKindLabelOf,
  zoneNameForCell,
  zonePointLngLat,
  zonePointsFrom,
  zoneRealNamesFromAdmins,
  zoneRealNamesFromPlaces,
  zoneStyleClassOf,
  zoneVerdictLine
};
/*! Bundled license information:

@vue/shared/dist/shared.esm-bundler.js:
  (**
  * @vue/shared v3.5.34
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **)

@vue/reactivity/dist/reactivity.esm-bundler.js:
  (**
  * @vue/reactivity v3.5.34
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **)

@vue/runtime-core/dist/runtime-core.esm-bundler.js:
  (**
  * @vue/runtime-core v3.5.34
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **)

vue/dist/vue.runtime.esm-bundler.js:
  (**
  * vue v3.5.34
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **)
*/
