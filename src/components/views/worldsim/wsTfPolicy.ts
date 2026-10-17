/**
 * wsTfPolicy.ts —— 交通设施接线的**纯策略**（2026-10-17 · S1 切片）。
 *
 * ## 这个文件解决什么
 * `WsSceneView` 原来那条交通接线有三处"只能靠现场观察"的毛病：
 *   ① 路网来自 `worldMapApi.roads()`（现场 Overpass：冷查分钟级，且和 App 的 offline-first 口径冲突）；
 *   ② 每条 `moveend` 都重算一次（摇杆期间 `panBy({duration:0})` 是**每帧**一轮 moveend）；
 *   ③ 输入不裁剪 —— 实测 633 条路（默认视野实测路数）时 `buildTransportFor` 要 **12.9 s**。
 * ⇒ 这里把"**该不该算 / 拿什么算 / 插哪一层**"三件事抽成纯函数：没有 vue、没有地图库、
 *    没有网络，所以能在 node 里逐条断言（`world_map/ws_tf_policy_selftest.mjs`）。
 *
 * ## 纪律
 * · **不写第二套规则**：路网等级/上限仍读 `wsTransportRules`，裁剪只做"离中心太远的不送进去"；
 * · **不猜数据**：读不到输入 ⇒ 调用方如实写"路网还没落图"，本文件只回答"送不送"；
 * · 数字都在下面这几个常量里，**调用点不许再写字面量**（本仓反复栽过的"两处各写一份"）。
 */

import type { TfBuildingsFc, TfRoadsFc } from "./wsTransportLayer";

/** 只把**离视野中心这么近**的路段送进生成器（米）。理由：交通设施是"眼前这一小片"的东西，
 *  送进整仓路网既慢又没意义；633 条 → 裁剪后通常几十条（实测见自检 ⑤ 组）。 */
export const TF_CLIP_RADIUS_M = 300;
/** 路网条数上限（按等级优先、距离次之）。**不是**产出上限（那个在 `wsTransportRules.TF_CAPS`） */
export const TF_MAX_ROADS = 200;
/** 楼栋条数上限（停车/出入口要楼脚印，同样只吃附近这几栋） */
export const TF_MAX_BUILDINGS = 200;
/** `moveend` 去抖：摇杆/连续拖动时把**每帧一轮**合成一轮（松手 800ms 后才算） */
export const TF_DEBOUNCE_MS = 800;
/** 两次真正计算的**最小间隔**（避免"停一下又动"来回算） */
export const TF_MIN_INTERVAL_MS = 1200;
/** `?live=1` 那条 API 的超时上限：**绝不**让一条 Overpass 请求把这一屏挂住 */
export const TF_LIVE_TIMEOUT_MS = 3000;

const M_PER_DEG_LAT = 111320;

/** 一个 GeoJSON 要素的最小形状（路网/楼栋都满足；不引引擎类型） */
export interface TfGeoFeatureLike {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}
/** GeoJSON FeatureCollection 的最小形状（`wsTransportLayer.TfRoadsFc` / `TfBuildingsFc` 都满足） */
export interface TfGeoFcLike {
  features?: TfGeoFeatureLike[];
}

/** 从任意嵌套的 coordinates 里取经纬度包围盒（LineString / Polygon / Multi* 都能走） */
export function bboxOfCoords(coordinates: unknown): { minLng: number; maxLng: number; minLat: number; maxLat: number } | null {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let seen = 0;
  const walk = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
      const lng = Number(v[0]);
      const lat = Number(v[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      seen += 1;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const x of v) walk(x);
  };
  walk(coordinates);
  return seen ? { minLng, maxLng, minLat, maxLat } : null;
}

/**
 * 要素包围盒到中心点的**平面近似距离**（米；落在包围盒内 = 0）。
 * 与 `wsTransport.toMeters` 用同一套等距近似（111320 m/度、经度乘 cos 纬度）——
 * 这里只做**粗筛**，不承担"距离真值"的职责（真值由生成器在米平面里算）。
 */
export function bboxDistanceM(box: { minLng: number; maxLng: number; minLat: number; maxLat: number }, center: [number, number]): number {
  const [clng, clat] = center;
  const mx = M_PER_DEG_LAT * Math.cos((clat * Math.PI) / 180);
  const dx = Math.max(box.minLng - clng, 0, clng - box.maxLng) * mx;
  const dy = Math.max(box.minLat - clat, 0, clat - box.maxLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** 一条路的等级（`rank` 优先、`class` 兜底、缺省 3）——与 `wsTransportLayer.roadClassOf` 同口径 */
function rankOf(p: Record<string, unknown> | null | undefined): number {
  const props = p || {};
  for (const key of ["rank", "class"]) {
    const v = Number(props[key]);
    if (Number.isFinite(v)) return v;
  }
  return 3;
}

export interface TfClipResult {
  /** 送进生成器的 FeatureCollection（形状不变，只少了远处的） */
  fc: { type: "FeatureCollection"; features: TfGeoFeatureLike[] };
  /** 原输入条数 / 送进去的条数 / 因距离丢掉 / 因上限丢掉 */
  before: number;
  kept: number;
  droppedFar: number;
  droppedCap: number;
  /** 给 HUD 的一句话（空串 = 没有裁剪，不必占地方） */
  note: string;
}

/**
 * 路网裁剪：**只留离中心 ≤ `radiusM` 的路段，再按（等级升序、距离升序）取前 `cap` 条**。
 * 空输入返回空集合（合法：这一带确实没有路），**不编**任何路线。
 */
export function clipRoadsFor(
  roads: TfRoadsFc | TfGeoFcLike | null | undefined,
  center: [number, number],
  opts: { radiusM?: number; cap?: number } = {}
): TfClipResult {
  const radiusM = Number.isFinite(opts.radiusM as number) ? Number(opts.radiusM) : TF_CLIP_RADIUS_M;
  const cap = Number.isFinite(opts.cap as number) ? Number(opts.cap) : TF_MAX_ROADS;
  const all = (roads?.features || []).filter((f): f is TfGeoFeatureLike => !!f);
  const near: Array<{ f: TfGeoFeatureLike; d: number; rank: number }> = [];
  let droppedFar = 0;
  for (const f of all) {
    const box = bboxOfCoords(f?.geometry?.coordinates);
    if (!box) {
      /* 没有可用坐标 ⇒ 送进去也只会被生成器丢掉（它按 `pts.length >= 2` 过滤）⇒ 记在"远处"里 */
      droppedFar += 1;
      continue;
    }
    const d = bboxDistanceM(box, center);
    if (d > radiusM) {
      droppedFar += 1;
      continue;
    }
    near.push({ f, d, rank: rankOf(f.properties) });
  }
  near.sort((a, b) => (a.rank - b.rank) || (a.d - b.d));
  const keptList = near.slice(0, Math.max(0, cap));
  const droppedCap = near.length - keptList.length;
  const notes: string[] = [];
  if (droppedFar) notes.push(`远处 ${droppedFar} 条未送（>${radiusM}m）`);
  if (droppedCap) notes.push(`超上限 ${droppedCap} 条未送（上限 ${cap}）`);
  return {
    fc: { type: "FeatureCollection", features: keptList.map((x) => x.f) },
    before: all.length,
    kept: keptList.length,
    droppedFar,
    droppedCap,
    note: notes.join(" · "),
  };
}

/**
 * 楼栋裁剪：与路网同一套（**只要"楼的轮廓"**）。
 *
 * 为什么必须按 `part` 过滤：默认档上妆会把一栋楼拆成 `body` / `parapet` / `equip` / `antenna`
 * 多个要素（`wsBldDetailTiers.BLD_PART_TIER`），它们的脚印面积一个比一个小 ——
 * 直接送进去会让"停车场 ≥800 m² / 出入口 ≥1500 m²"的规则**判不出来**（恒 0）。
 * ⇒ 只留 `part` 缺失或 `part === "body"` 的那一份（缺失 = 没拆件的旧路/瓦片路，照收）。
 */
export function clipBuildingsFor(
  buildings: TfBuildingsFc | TfGeoFcLike | null | undefined,
  center: [number, number],
  opts: { radiusM?: number; cap?: number } = {}
): TfClipResult & { droppedPart: number } {
  const radiusM = Number.isFinite(opts.radiusM as number) ? Number(opts.radiusM) : TF_CLIP_RADIUS_M;
  const cap = Number.isFinite(opts.cap as number) ? Number(opts.cap) : TF_MAX_BUILDINGS;
  const all = (buildings?.features || []).filter((f): f is TfGeoFeatureLike => !!f);
  const near: Array<{ f: TfGeoFeatureLike; d: number }> = [];
  let droppedFar = 0;
  let droppedPart = 0;
  for (const f of all) {
    const part = String((f?.properties || {}).part ?? "");
    if (part && part !== "body") {
      droppedPart += 1;
      continue;
    }
    const box = bboxOfCoords(f?.geometry?.coordinates);
    if (!box) {
      droppedFar += 1;
      continue;
    }
    const d = bboxDistanceM(box, center);
    if (d > radiusM) {
      droppedFar += 1;
      continue;
    }
    near.push({ f, d });
  }
  near.sort((a, b) => a.d - b.d);
  const keptList = near.slice(0, Math.max(0, cap));
  const droppedCap = near.length - keptList.length;
  const notes: string[] = [];
  if (droppedFar) notes.push(`远处 ${droppedFar} 栋未送（>${radiusM}m）`);
  if (droppedCap) notes.push(`超上限 ${droppedCap} 栋未送（上限 ${cap}）`);
  return {
    fc: { type: "FeatureCollection", features: keptList.map((x) => x.f) },
    before: all.length,
    kept: keptList.length,
    droppedFar,
    droppedCap,
    droppedPart,
    note: notes.join(" · "),
  };
}

/**
 * 交通设施该插到哪个图层之前：`bld-ext` → `ref` → `undefined`（追加上最上层是最后手段）。
 *
 * 为什么不是只认 `bld-ext`：默认渲染后端是**叠加层**（`wsRenderBackend.WS_RENDER_DEFAULT = "overlay"`），
 * 楼由 three 画、地图那套 `bld-*` 图层会被**拆掉**（`wsBldLayerSwitch`）——
 * 这时若还拿 `bld-ext` 当锚点，`addLayer(spec, undefined)` 会把斑马线/红绿灯**追加到注记之上**。
 * 这条链与路网落图用的是同一条（`wsDistrictScene.ts:866`），不新造判据。
 */
export function tfBeforeIdOf(has: (id: string) => boolean): string | undefined {
  if (has("bld-ext")) return "bld-ext";
  if (has("ref")) return "ref";
  return undefined;
}

/** 视野 key：同一格/同一 zoom 档不重算（中心 4 位小数 ≈ 11 m；zoom 取整档） */
export function tfKeyOf(center: { lng: number; lat: number }, zoom: number | null, roadsN: number, bldN: number): string {
  const lng = Number(center?.lng);
  const lat = Number(center?.lat);
  const z = Number.isFinite(zoom as number) ? Math.round(Number(zoom)) : -1;
  /* 输入条数按 50 条一档：新落一格路网会让 key 变（该重算），但相邻两格的零头不会引发抖动 */
  const bucket = (n: number): number => Math.max(0, Math.round((Number(n) || 0) / 50));
  return `${Number.isFinite(lng) ? lng.toFixed(4) : "x"},${Number.isFinite(lat) ? lat.toFixed(4) : "x"},${z},r${bucket(roadsN)},b${bucket(bldN)}`;
}

export interface TfSchedule {
  /** 还要等多久才该算（ms；0 = 现在就可以） */
  waitMs: number;
  /** 最早可算的时刻（`performance.now()` 同源时钟） */
  dueAt: number;
  why: string;
}

/**
 * 调度：**去抖（800ms）+ 最小间隔（1200ms）+ 上一轮没算完就再等**。
 *
 * 为什么不读宿主的 `joyActive`：那是 `WsDistrictMapLibre` 的本地 `let`（本仓纪律：薄壳不许
 * 造第二份真源）。摇杆驱动期间 `panBy({duration:0})` 是**每帧**一轮 moveend
 * （`wsStageEvents.ts:331` 有原话），而这里的去抖会把那一串**合并成一整轮**：
 * 推杆 3 秒 = 0 次计算，松手 800ms 后 1 次（自检 ⑤ 组把它钉成"一串事件 ⇒ 只在末尾算一次"）。
 */
export function tfScheduleOf(input: { now: number; lastEventAt: number; lastBuiltAt: number; busy?: boolean }): TfSchedule {
  const now = Number(input.now) || 0;
  const lastEventAt = Number(input.lastEventAt) || 0;
  const lastBuiltAt = Number(input.lastBuiltAt) || 0;
  if (input.busy) {
    return { waitMs: TF_DEBOUNCE_MS, dueAt: now + TF_DEBOUNCE_MS, why: "上一轮还在算 ⇒ 等它结束再来" };
  }
  const dueAt = Math.max(lastEventAt + TF_DEBOUNCE_MS, lastBuiltAt + TF_MIN_INTERVAL_MS);
  const waitMs = Math.max(0, Math.ceil(dueAt - now));
  const why = waitMs > 0 ? `去抖/最小间隔：还要等 ${waitMs}ms` : "可以算";
  return { waitMs, dueAt, why };
}
