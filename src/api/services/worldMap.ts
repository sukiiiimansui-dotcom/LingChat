// 世界地图数据层（T6-1）
//
// 数据来源集中在这里，组件不感知底层：
//   · Tauri 应用内（APK / 桌面）：`invoke` → Rust 本地实现（src-tauri/src/world_map/）
//   · 纯浏览器预览 / 局域网调试：HTTP → Rust 调试服务（127.0.0.1:8791）
// 两条通路的**分流是自动的**（见下面的 isTauriRuntime），不需要再手改常量：
// 打包成 APK 之后手机上根本没有 8791 那个进程，写死 HTTP 必然显示「世界地图服务未启动」。
import { invoke } from "@tauri-apps/api/core";

/**
 * 当前是不是**真的**跑在 Tauri 壳里（而不是浏览器预览）。
 *
 * 判定必须同时满足两条，缺一不可：
 *   ① `window.__TAURI_INTERNALS__` 存在 —— 真壳由 Rust 注入；
 *   ② 没有 `__LINGCHAT_WEB_MOCK__` 标记 —— `src/web-mock.ts` 在纯 web 预览时会**伪造**
 *      一份 `__TAURI_INTERNALS__`，而它的 invoke 对所有 `world_map_*` 一律返回 undefined
 *      （等价于「命令不存在」）。只看 ① 会把 web 预览误判成真壳，
 *      地图请求全打到 mock 上 → 页面永远空白。
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false; // 非浏览器环境（SSR / 测试）兜底
  if (!window.__TAURI_INTERNALS__) return false;
  return !window.__LINGCHAT_WEB_MOCK__;
}

/**
 * 是否走 Rust 本地实现 —— 保留这个既有导出名（别处可能在引用），
 * 值就是上面的自动判别结果，而**不再是写死的 false**。
 *
 * 注意：这是「模块加载那一刻」的快照；接口内部一律用 `isTauriRuntime()` 实时判定，
 * 这样不受模块求值顺序影响（`src/main.ts` 第一行 `import "./web-mock"` 会先执行，
 * 但测试 / 别的入口未必这么排）。
 */
export const USE_RUST = isTauriRuntime();

// 后端地址可用 VITE_WORLD_MAP_API 覆盖（默认指向 Rust 版，见 docs/world-map/07）。
// 两个实现返回结构完全一致，所以换端口不需要改任何组件：
//   · 8791 = Rust 版（world_map_rs，正在成为主线）
//   · 8790 = Python 侧车（原型，已停用，留作对照）
const API_BASE = (import.meta.env?.VITE_WORLD_MAP_API as string) || "http://127.0.0.1:8791";

/**
 * **第二数据源（Overture，ODbL）的服务地址**。
 *
 * 它和 `API_BASE`（Rust 那个 8791）是**两个不同的进程**：这个是 Termux 上的
 * Python 服务（`world_map/overture_api.py`，8792），负责按 bbox 读公开 S3 上的
 * GeoParquet 并落盘缓存。分开是有意的 —— 它挂了不该影响 8791 的任何功能。
 */
const OVERTURE_BASE = (import.meta.env?.VITE_OVERTURE_API as string) || "http://127.0.0.1:8792";

async function httpGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const q = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
  }
  const url = `${API_BASE}${path}${q.toString() ? "?" + q.toString() : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`世界地图接口 ${path} 返回 ${res.status}`);
  return (await res.json()) as T;
}

/**
 * **真实楼栋响应的两种形状统一解包**（2026-09-19 事故）：
 * · HTTP 走 `/api/buildings` 时后端给的是**信封**：`{ ok, lat, lng, radius, key, cached, count,
 *   geojson: { type, features }, stats, meta, source }` —— 楼栋在 **`geojson.features`**；
 * · 真壳（Tauri 命令）那条路给的是**裸 FeatureCollection**。
 * 踩过的坑：两个调用点都直接读顶层 `.features` ⇒ **恒为 0 栋**（后端明明返回了 179 栋、
 * 页面却写"这一带没有楼房数据"）。这个函数就是为此存在，别再手写解析。
 */
export interface BuildingsGeo {
  type: string;
  features: unknown[];
}

export function unwrapBuildingsGeo(raw: unknown): BuildingsGeo | null {
  const o = raw as { geojson?: { type?: string; features?: unknown[] }; type?: string; features?: unknown[] } | null;
  if (!o || typeof o !== "object") return null;
  const g = o.geojson;
  if (g && Array.isArray(g.features)) return { type: g.type || "FeatureCollection", features: g.features };
  if (Array.isArray(o.features)) return { type: o.type || "FeatureCollection", features: o.features };
  return null;
}

// ── 类型 ──
// 🗄 2026-10-06（S9b6 批 A）：这一组 4 个类型（`BlockEdge` / `MainBlock` / `RemoteBlock` /
//   `BlocksPayload`）原本只服务于 `worldMapApi.blocks()` / `.blocksByLatLng()` 那一对前端包装，
//   包装退役后全仓 0 消费者 ⇒ 同批删（本喵逐个 grep 过 `src/` 与 `public/`，确实只剩包装自己在用；
//   留着一个没人用的结构体只会让人以为还有这条通路）。
//   ⚠️ 对端**没退**：Python 侧车 `/api/blocks`（`hier_api.py`）与调试页 `world_map/blocks.html`
//   还在真用这条数据，Rust 侧 `world_map_blocks` / `_at` 与 `lib.rs` 的注册也原样保留。

export interface WorldLocation {
  lat: number;
  lng: number;
  accuracy?: number;
  provider?: string;
  source?: string;
  precision?: string;
  ip_city?: string;
  ip_region?: string;
  error?: string;
  hint?: string;
  path?: { adcode: string; name: string }[];
  leaf?: { adcode: string; name: string } | null;
}

export interface WorldTime {
  [k: string]: unknown;
}

export interface WorldWeather {
  [k: string]: unknown;
}

export interface SchedulePlace {
  kind: string;
  kindZh: string;
  facilityId?: string;
  name?: string;
  label?: string;
  grid?: number[];
}

export interface ScheduleItem {
  name: string;
  time: string;
  content: string;
  kind: string;
  kindZh: string;
}

export interface ScheduleRole {
  name: string;
  group: string;
  title: string;
  now: (ScheduleItem & { place: SchedulePlace | null }) | null;
  next: ScheduleItem | null;
  progress: number;
  timeline: ScheduleItem[];
}

export interface LingChatCharacter {
  name: string;
  folder: string;
  subtitle: string;
  avatarCount: number;
  hasAvatar: boolean;
  info: string;
}

export interface SchedulePayload {
  ok: boolean;
  source: "lingchat" | "default";
  path: string | null;
  now: string;
  nowMinutes: number;
  roles: ScheduleRole[];
  characters: LingChatCharacter[];
  todos: Record<string, unknown>[];
  importantDays: Record<string, unknown>[];
  placeSource: string;
}

export interface TransportPlan {
  ok: boolean;
  error?: string;
  route: Record<string, unknown>;
  options: Record<string, unknown>[];
  modes: Record<string, unknown>[];
  /**
   * T2-2 step2：这次算路用的是哪份站点表（**没有这个字段 = 走的还是几何估计的虚拟站点**）。
   * 前端拿它做两件事：把「我上车的那个站」画出来；以及在界面上如实说明站点来自哪。
   */
  stations?: TransportStations;
}

/** 站点吸附上下文（`transportPlan` 的第 4 个参数；全部可选，给得越多越可能与地图同源） */
export interface TransitPlanCtx {
  /** 区域名「广州市·越秀区」——与地图图层用同一个值才可能同源 */
  area?: string;
  /** 网格边长（前端传 `WS_GRID` = 28） */
  size?: number;
  /** 稳定种子（前端传 `hash32(area)`） */
  seed?: number;
  /** 交通设施层级 community/district/city */
  level?: string;
  /** 地图库布局 key（有 AI 精绘布局时最准） */
  key?: string;
  /** 网格**原点**（格 (0,0)）的经纬度 —— 一般不用给，给 `center*` 更直观 */
  anchorLng?: number;
  anchorLat?: number;
  /** 网格**中心**的经纬度（「我人在哪」就是这个）→ 后端退半张图换算成原点 */
  centerLng?: number;
  centerLat?: number;
  /** `false` = 显式关掉站点吸附（退回旧行为） */
  stations?: boolean;
}

/** 站点吸附的实况（后端 `stations` 字段） */
export interface TransportStations {
  /** `explicit-anchor` / `maplib` / `layout` / `sketch` / `sketch-centered` … */
  source?: string;
  area?: string;
  level?: string;
  grid?: number;
  cell_meters?: number;
  /** `false` = 没有锚点，**节点没有经纬度**（别拿格点当经纬度用） */
  geo?: boolean;
  anchor?: { lng: number; lat: number } | null;
  center?: { lng: number; lat: number } | null;
  count?: number;
  nodes?: TransitNode[];
}

/** HTTP 通路的查询串（Tauri 那条用驼峰形参，不走这里） */
function transitCtxQuery(ctx?: TransitPlanCtx): Record<string, string | number | undefined> {
  if (!ctx) return {};
  return {
    area: ctx.area,
    size: ctx.size,
    seed: ctx.seed,
    level: ctx.level,
    key: ctx.key,
    anchor_lng: ctx.anchorLng,
    anchor_lat: ctx.anchorLat,
    center_lng: ctx.centerLng,
    center_lat: ctx.centerLat,
    stations: ctx.stations === undefined ? undefined : ctx.stations ? 1 : 0,
  };
}

// ── 接口（HTTP 版）──
const http = {
  location: (opts?: { force?: boolean; fast?: boolean; lat?: number; lng?: number }) =>
    httpGet<WorldLocation>("/api/location", {
      force: opts?.force ? 1 : undefined,
      fast: opts?.fast ? 1 : undefined,
      lat: opts?.lat,
      lng: opts?.lng,
    }),
  time: () => httpGet<WorldTime>("/api/time"),
  weather: (city?: string) => httpGet<WorldWeather>("/api/weather", { city }),
  schedule: (now?: string, area?: string) =>
    httpGet<SchedulePayload>("/api/schedule", { now, area }),
  transportPlan: (
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
    prefer?: string,
    ctx?: TransitPlanCtx
  ) =>
    httpGet<TransportPlan>("/api/transport_plan", {
      from_lat: a.lat,
      from_lng: a.lng,
      to_lat: b.lat,
      to_lng: b.lng,
      prefer,
      // T2-2 step2：站点上下文（不传 = 与改造前逐字节一致，仍走几何估计的虚拟站点）
      ...transitCtxQuery(ctx),
    }),
  mapImg: (ad: string, style = "gaode") => `${API_BASE}/api/map?ad=${ad}&style=${style}`,
  bigmapImg: (ad: string, style = "gaode", scale = 1) =>
    `${API_BASE}/api/bigmap_img?ad=${ad}&style=${style}&scale=${scale}`,
  maplibFile: (id: string) => `${API_BASE}/api/maplib/file?id=${encodeURIComponent(id)}`,
};

// ── 降级工具 ──

/**
 * 给 invoke 套一层超时。
 *
 * 为什么需要：命令**没注册**时 Tauri 会立刻 reject（好办，catch 就行），
 * 但如果哪天命令注册了却在 Rust 侧卡住（比如等 GPS / 等网络），
 * 页面会永远停在「加载中…」—— 那比报错更难查。超时后走降级分支，至少页面能继续用。
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 调用超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
// `location` / `weather` 为什么**先 invoke、失败再降级**
//
// 现状（2026-10-06 复核 `src-tauri/src/lib.rs` 的 generate_handler **与命令本体**）：
//   `world_map_location` 与 `world_map_weather` **两条都已经实现并注册** ——
//   注册在 `src-tauri/src/lib.rs:742-743`，本体在 `src-tauri/src/world_map/live.rs:207` / `:516`。
//   ⚠️ 这里原先写「两个命令都还没实现」⇒ **早已不成立**，本次照实更正
//   （那句话与前端这份降级代码是同一个提交引进来的，从落地那天起就没对上过）。
//   Rust 侧目前有的是：render_svg / geo_svg / geo_status / coord_selftest / stats / maplib_* /
//   schedule / transport_plan / osm_summary / time / push_events / recent_events
//   （另有 `blocks` / `blocks_at`：**注册仍在**，但前端出口已于 2026-10-06 的 S9b6 批 A 退役，
//     只剩侧车 `/api/blocks` 与调试页在用；`render` 与 `district_stream(_cancel)` 已先后退役，
//     不再列 —— 这一行是照 `lib.rs` 的 `generate_handler` 现状写的，改注册表时请同步改它）。
//
// 那降级还留不留？**留** —— 但理由不是"命令不存在"，而是**主路会运行期失败**：
//   · 定位：Android 上系统定位权限被拒、或一直拿不到 fix ⇒ 6 秒超时（真机上很常见）；
//   · 天气：后端要现问数据源（冷查询可达数十秒）⇒ 26 秒超时、或断网时直接 `Err`。
//   主路一失败就往下走（HTTP 兜底 → 页面能读懂的兜底值），页面一行都不用改。
//   「命令没注册」（比如谁把注册行摘了）同样会 reject 落到这里 —— 那是**保险丝**，
//   不再是当初写这段时的默认情形。
//
// 因此这里做**数据层降级**（页面一行都不用改）：
//   location：invoke → HTTP 兜底 → `{error,hint}` 让页面走已有的「定位失败」路径
//   weather ：invoke → HTTP 兜底 → 空对象，顶栏少个标签而已
// ═══════════════════════════════════════════════════════════════════

// ── 对外统一出口（真壳 / 浏览器在这里自动分流）──
//
// 每个分支都用 `isTauriRuntime()` 实时判定（而不是读上面那个常量快照），
// 免得判早了或判晚了一格导致整页失效。
export const worldMapApi = {
  /**
   * 真实楼栋（`/api/buildings`）。**返回已解包的 FeatureCollection**（见 `unwrapBuildingsGeo`）。
   * 不传坐标时后端用"最近一次定位"兜底（与组件原来的行为一致）。
   */
  buildings: async (opts: { lat?: number; lng?: number; r?: number } = {}): Promise<BuildingsGeo | null> => {
    const raw = await httpGet<unknown>("/api/buildings", { lat: opts.lat, lng: opts.lng, r: opts.r });
    return unwrapBuildingsGeo(raw);
  },
  /**
   * **真实路网**（`/api/roads`）—— 机主 2026-09-20：「在地图上把道路和设施全部勾出来
   * （方便将行人啥的挪出来）」。
   *
   * 返回**已解包的 FeatureCollection**（`LineString`，`properties.rank` 是归一化档次
   * 0~5，见 Rust `osm::road_rank`）。刻意与 `buildings` **同一个壳**：
   * 同一个 `unwrapBuildingsGeo` 就能解，错误处理也不用再来一套。
   *
   * ⚠️ 后端是**现问 Overpass**（冷查询 15~90 秒，实测涪陵 800m 用了 **14.7 秒**）⇒
   * 调用方必须**自己带超时**，而且**别在拖动过程中反复取**（按中心+半径做去抖与缓存）。
   * 半径上限 2000m（更大后端会直接拒掉）。
   */
  roads: async (opts: { lat?: number; lng?: number; r?: number } = {}): Promise<BuildingsGeo | null> => {
    const raw = await httpGet<unknown>("/api/roads", { lat: opts.lat, lng: opts.lng, r: opts.r });
    return unwrapBuildingsGeo(raw);
  },
  /**
   * **第二数据源：Overture Maps Buildings（ODbL）** —— 只补 OSM 没有的楼。
   *
   * 为什么走 HTTP 而不是 invoke：这个源是 Termux 上的一个 **Python 服务**
   * （`world_map/overture_api.py`，按 bbox 读公开 S3 上的 GeoParquet + 落盘缓存）。
   * 真壳（APK）里**没有 Python** ⇒ 这个请求必然失败 ⇒ 调用方照旧只用 OSM。
   * 这是**有意为之**的降级路径：拿不到就少一层楼，绝不让页面崩。
   *
   * ⚠️ 许可：Overture 是 **ODbL**，返回里带 `meta.attribution`，**前端必须显示**。
   */
  overtureBuildings: async (opts: { lat: number; lng: number; r: number }): Promise<BuildingsGeo | null> => {
    const q = new URLSearchParams({ lat: String(opts.lat), lng: String(opts.lng), r: String(opts.r) });
    const res = await fetch(`${OVERTURE_BASE}/api/overture/buildings?${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Overture 接口返回 ${res.status}`);
    return unwrapBuildingsGeo(await res.json());
  },
  // ── 定位：Rust 侧已有 `world_map_location`（`live.rs:207` / 注册 `lib.rs:742`）；
  //    下面的降级是**运行期兜底**（超时/权限被拒），理由见上方整段说明 ──
  location: async (opts?: {
    force?: boolean;
    fast?: boolean;
    lat?: number;
    lng?: number;
  }): Promise<WorldLocation> => {
    if (!isTauriRuntime()) return http.location(opts);
    // ① 主路：真命令（已实现并注册，见上方整段）。reject / 超时才往下走降级。
    try {
      return await withTimeout(
        invoke<WorldLocation>("world_map_location", { ...opts }),
        6000,
        "定位"
      );
    } catch {
      /* 命令不存在 / 超时 → 往下走降级 */
    }
    // ② 降级一：HTTP 兜底（真机上是「自己连自己」，通常连不上；
    //    但局域网调试、桌面版同时起着 8791 调试服务时仍然可用）。
    try {
      return await http.location(opts);
    } catch {
      /* 两条都不通 → 往下走 ③ */
    }
    // ③ 降级二：返回一个**页面能读懂的结果**（不抛异常）。
    //    WorldMap.vue 里 relocate() 判的是 `loc.error`，拿到 error 就显示 hint 并回到默认城市，
    //    绝不会白屏；用户也可以直接用「刷新」走默认区域。
    return {
      lat: 0,
      lng: 0,
      error: "定位不可用",
      hint: "应用内暂不支持自动定位，请手动选择区域（或直接填区域名）",
      source: "none",
    };
  },
  time: async (): Promise<WorldTime> =>
    isTauriRuntime() ? invoke<WorldTime>("world_map_time") : http.time(),
  // ── 天气：Rust 侧已有 `world_map_weather`（`live.rs:516` / 注册 `lib.rs:743`）；
  //    下面的降级同样是**运行期兜底**（超时/断网），理由见上方整段说明 ──
  weather: async (city?: string): Promise<WorldWeather> => {
    if (!isTauriRuntime()) return http.weather(city);
    try {
      // 26000 > Rust 侧 25 秒：前端若先放弃，Rust 那边跑完虽然会写进 30 分钟缓存，
      // 但用户第一次进页面就是没天气。宁可多等 25 秒拿一次，之后 30 分钟都是秒回。
      return await withTimeout(invoke<WorldWeather>("world_map_weather", { city }), 26000, "天气");
    } catch {
      /* 命令不存在 / 超时 → 降级 */
    }
    try {
      return await http.weather(city);
    } catch {
      // 拿不到天气不是错误：WorldMap.vue 的 loadTimeWeather() 已经把 weatherText 留空，
      // 顶栏少一个标签而已，不打扰主流程。返回空对象比抛异常干净。
      return {};
    }
  },
  /**
   * 日程（谁现在该在哪）。
   *
   * ⚠️ `facilities` **必须传**（从 `world_map_runtime` 里那份设施表原样带回去）：
   * 后端 `schedule::role_place(kind, facilities, seed)` 只有在拿到设施表时才能把
   * "商业区"这种**类型**落到**具体设施点**上（给 `place.name`）。
   * 不传的话后端返回的是 `placeSource: "kind-only"`、`place.name` 为空，于是：
   *   · 地图上角色的「地点」永远是空的 → `wsRuntimePush` 推上去的 `facility` 也是空
   *   · 事件引擎（`event_cmd.rs`）按空 place 判室内外 → 恒为户外
   *     → **停电/停水/失眠/睡过头这批"仅室内"事件永远不会触发**，而且不报错
   *   · "消费场所 ×1.8 / 户外场所 ×1.4" 两条权重修正同样永不生效
   * 也就是说：少传这一个参数，事件引擎就"半边瘫"，而表面上一切正常。
   */
  schedule: async (
    now?: string,
    area?: string,
    facilities?: unknown[]
  ): Promise<SchedulePayload> =>
    isTauriRuntime()
      ? invoke<SchedulePayload>("world_map_schedule", {
          now,
          area,
          // 空数组与 undefined 等价（后端 `facilities.as_deref()` 拿不到就按 kind-only 走），
          // 但传 `[]` 会让后端多做一次无意义的匹配，所以空的时候就别传。
          facilities: facilities && facilities.length ? facilities : undefined,
        })
      : http.schedule(now, area),
  /**
   * 两点之间的交通方案。**T2-2 step2 起第 4 个参数可以给站点上下文**：
   * 给了就把「上下车点」吸附到地图上那些真实站点（公交站/地铁站/停车场…），
   * 不给就还是几何估计的虚拟站点（旧行为，逐字节不变）。
   *
   * 与地图上的图标**逐一对应**的关键：`area`/`size`/`seed`/`level` 四个值要和
   * `WsTransitLayer` / `WsFacilityLayer` 取设施时用的一模一样
   * （前端惯例：`area` = 区域名、`size` = `WS_GRID`、`seed` = `hash32(area)`）。
   * 只给坐标不给这四个值时后端会自动建一份"以起点为中心"的草图 ——
   * 位置仍落在合理街区上，但**未必与你地图上画的那枚图标重合**（响应里 `stations.source` 如实写着）。
   */
  transportPlan: async (
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
    prefer?: string,
    ctx?: TransitPlanCtx
  ): Promise<TransportPlan> => {
    if (isTauriRuntime())
      return invoke<TransportPlan>("world_map_transport_plan", {
        from: a,
        to: b,
        prefer,
        ...(ctx || {}),
        // Tauri 侧形参是 snake_case → JS 必须写驼峰（`anchor_lng` → `anchorLng`）
        anchorLng: ctx?.anchorLng,
        anchorLat: ctx?.anchorLat,
        centerLng: ctx?.centerLng,
        centerLat: ctx?.centerLat,
        // 显式给 `stations: false` 才是关（不传 = 后端默认开）
        stations: ctx?.stations,
      });
    return http.transportPlan(a, b, prefer, ctx);
  },
  // 下面三项**都不是"死代码"三个字能概括的**（2026-10-06 S9b6 批 ⑤ 更正过一次口径，
  // 老注释写「三项全是死代码（全仓 grep 无调用方）」，对第三项是错的）：
  //   · `mapImg` → `/api/map`、`bigmapImg` → `/api/bigmap_img`：页面级消费者 0 个，
  //     这两条 HTTP 路由在 Rust 服务（8791）与打包后的应用内**都没有**（实测 404）——
  //     但 Rust 侧仍在**生成**这两串路径（`geo.rs` 的 `img` / `img_url`、`mod.rs` 的 `remotes[].img`）
  //     ⇒ 留着是为了两端口径对得上。新代码请用文件末尾的 `mapSvgUrl()`（双通路）。
  //   · `maplibFile`：**消费者已于 2026-10-06 的 S9b8 批 F 归零** —— 它唯一的调用者
  //     `maplibFileUrl()` 自己也是 0 消费者（两条互为首尾），那一笔把 `maplibFileUrl` 退掉了
  //     ⇒ 现在它是**死导出**，按项目惯例**留档不删**（对端 `/api/maplib/file` 仍在）。
  mapImg: http.mapImg,
  bigmapImg: http.bigmapImg,
  maplibFile: http.maplibFile,
  apiBase: API_BASE,
};

// ═══════════════════════════════════════════════════════════════════
// 世界地图补充接口（地图库那条链在用）
//
// 🗄 2026-10-06（S9b5-A）：原本这里还有"新页面组"（`views/worldmap/` 下四个页面）
//   专用的 SSE 事件流与 SVG 探针出口，随「AI 实时生成街区」管线一起退役；
//   现在只剩地图库这一组，消费者是 `WsDistrictMapLibre.vue` 一线。
//
// 为什么仍然另起一组函数、而不是往 worldMapApi 里塞：
//   ① 这些接口只有地图库这条链用（按需取 JS/CSS 的资产 URL），
//      塞进公共出口会让老页面共享的类型跟着变，没必要担风险；
//   ② SSE 是「取 URL 交给 EventSource」而不是「fetch JSON」，
//      形状本来就和 worldMapApi 的其它成员不同。
// ═══════════════════════════════════════════════════════════════════

// ── 🗄 AI 实时绘制小区（/api/district_stream，SSE）—— 2026-10-06（S9b5-A）本段已整段退役 ──
//
// 主人裁定「AI 实时生成街区这个玩法不要了」⇒ 这条管线的前端半边一起删：
//   · 类型 `DistrictItem` / `DistrictRoadItem` / `DistrictLayout` / `DistrictCounts` /
//     `DistrictStreamEvent` / `DistrictStreamOpts`；
//   · `districtStreamUrl()`（拼 SSE 地址）· `startDistrictStream()` 与它的两条通路
//     （`startTauriDistrictStream` / `startHttpDistrictStream`）· `probeStreamError()`
//     （这四者在下面「统一入口」那段，同批删）· `districtRenderSvg()`（文件末尾那段）。
// 为什么整条删而不是留着：唯一消费者是 `/world/district-live`（`DistrictLive.vue`）与
//   `/world/district-viz`（`DistrictViz.vue`），这两条路由**全仓 0 个导航来源**（只能手输
//   URL），页面已随本笔一起删 ⇒ 留着就是一对"零消费者 + 没人能到"的死出口。
// 对端（Rust `stream.rs` / `layout_clean.rs` + 两条 `world_map_district_stream*` 命令、
//   Python 侧车 `/api/district_stream`）同批退役，判据见 `frontend_selftest_worldsim_p1.mjs`
//   的【🗄 S9b5】那一段。

// ── 区域主图（/api/bigmap）🗄 2026-10-06（S9b5-B）本段两个出口已退役 ──
//
// 机主裁定「角落世界地图不要了」⇒ 这条链上仅有的两个前端出口一起删了：
//   · `bigmapSvgUrl()` —— 纯 HTTP 拼串，给 `PhoneOverlay.vue` 那种"明确知道自己在浏览器里"的场景；
//   · `bigmapImgUrl()` —— 双通路（真壳 invoke `world_map_bigmap_svg` / 浏览器拼 URL），
//     消费者只有 `views/WorldMap.vue`（角落小窗的「⛶ 打开世界地图」目标页），页面也一并删了。
// 现役的 `mapSvgUrl()` 另有自己的 `/api/bigmap` 兜底（见上面那条 `catch`），不经过这里。
//
// ⚠️ 别把 `/api/bigmap` 与 Rust 的 `world_map_bigmap_svg` 当成已经没用的东西：
//    前者仍被 `mapSvgUrl()` 的浏览器兜底路径用，后者的命令本身也还在 `stitch_cmd.rs` 里注册着 ——
//    这一笔只退前端出口，不动对端（要退对端是另一笔、得先确认再没有别的消费者）。

// 🗄 2026-10-06（S9b5-A）：渲染探针整段退役（`RenderProbeOpts` / `renderProbeUrl()` / `renderProbeSvg()`）。
// 唯一消费者是 `DistrictViz.vue`（`/world/district-viz`，手输 URL 才到得了）经 `districtRenderSvg()`
// 的浏览器分支；页面与路由同批删。
// 🗄 2026-10-06（S9b6 批 B）补完 S9b5-A 漏掉的那半：Tauri 命令 `world_map_render` 已退役
// （注册行从 `lib.rs` 摘掉、命令体从 `world_map/mod.rs` 删掉；前端本来就 0 个 invoke）。
// ⚠️ HTTP 路由 `/api/render/probe` **仍然保留、不是死路** —— 8791 调试服务自己的路由，
//    `world_map_rs/src/main.rs` 首页有入口、`world_map_rs/src/demo.html` 在真 fetch 它。
// ── 地图库（/api/maplib/*）──

export interface MapLibMeta {
  area?: string;
  name?: string;
  size?: number;
  buildings?: number;
  roads?: number;
  parks?: number;
  context?: string;
  scale?: number;
  layoutKey?: string;
  osmUsed?: boolean;
  [k: string]: unknown;
}

export interface MapLibEntry {
  id: string;
  /** region / bigmap / district */
  kind: string;
  adcode: string;
  style: string;
  /** 相对「项目根」的路径，取本体用 maplibFile() */
  path: string;
  bytes: number;
  /** 秒级时间戳 */
  mtime: number;
  createdAt: number;
  lastAccess: number;
  version: number;
  /** generated / user … */
  origin: string;
  meta?: MapLibMeta;
}

export interface MapLibStats {
  count: number;
  bytes: number;
  mb: number;
  by_kind: Record<string, number>;
  max_bytes: number;
  max_mb: number;
}

export interface MapLibListPayload {
  stats: MapLibStats;
  entries: MapLibEntry[];
}

export type MapLibSort = "recent" | "oldest" | "largest";

export interface MapLibListOpts {
  kind?: string;
  ad?: string;
  limit?: number;
  sort?: MapLibSort;
}

/** 地图库列表（顺带返回容量统计，省一次请求） */
export const maplibList = (o: MapLibListOpts = {}): Promise<MapLibListPayload> =>
  httpGet<MapLibListPayload>("/api/maplib/list", {
    kind: o.kind,
    ad: o.ad,
    limit: o.limit,
    sort: o.sort,
  });

/** 只取容量统计（容量条用） */
export const maplibStats = (): Promise<MapLibStats> => httpGet<MapLibStats>("/api/maplib/stats");

export interface MapLibCleanupResult {
  removed: number;
  freed: number;
  freed_mb: number;
  dry_run: boolean;
  /** 被删（或将被删）的条目 id */
  victims?: string[];
  error?: string;
}

/**
 * 容量清理。
 *
 * **默认干跑**：只有显式传 `{ dry: false }` 才真删 ——
 * Python 侧曾在这里误删 119 张缓存图，所以「真删」必须由调用方写出来，
 * 而不是靠某个默认值碰运气。参数顺序也刻意让 dry 是必填语义。
 */
export const maplibCleanup = (o: { maxMb?: number; dry: boolean }): Promise<MapLibCleanupResult> =>
  httpGet<MapLibCleanupResult>("/api/maplib/cleanup", {
    max_mb: o.maxMb,
    // 后端约定 dry=0 才是真删；干跑时干脆不带这个参数（少一个出错机会）
    dry: o.dry ? 1 : 0,
  });

// 🗄 2026-10-06（S9b8 批 F）退役：`maplibFileUrl(id)` 原来长在这里。
// 依据（剥注释后扫 `src`/`public` + 闸目录全部 .mjs + Rust/Python 对端，自己复核过）：
//   · 它自己 **0 个消费者**；而它的被调者 `worldMapApi.maplibFile(id)` 的**唯一**调用者又是它
//     ⇒ 两条互为首尾成环、环外没人进（审计原话"死导出的死导出"）；
//   · 对端**一个字没动**：`http.maplibFile` 仍拼 `/api/maplib/file`，Rust 侧同路由仍在。
// 逐字墓碑：export const maplibFileUrl = (id: string): string => worldMapApi.maplibFile(id);
// 守卫（可执行）：`frontend_selftest_worldsim_p1.mjs` 的 S9b8 段（"不许回来" + 三个纯 HTTP 出口的对照）。

// ── 小工具（新页面共用，纯函数，不碰网络）──

/** 把秒级时间戳格式化成「MM-DD HH:mm」；0/空值给占位符 */
export function fmtStamp(sec: number, withTime = true): string {
  if (!sec || !isFinite(sec)) return "—";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${md} ${p(d.getHours())}:${p(d.getMinutes())}` : md;
}

/** 人类可读体积 */
export function fmtBytes(bytes: number): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

/** 稳定 id → 便于给列表做 key（后端 id 已含冒号，这里只做兜底转义） */
export function safeId(id: string): string {
  return String(id || "").replace(/[^\w:.-]/g, "_");
}

// 🗄 2026-10-06（S9b5-A）：AI 实时绘制小区的**统一入口**已整段退役 ——
//   `DistrictTransport` / `useTauriTransport()` / `startTauriDistrictStream()` /
//   `startHttpDistrictStream()` / `probeStreamError()` / `startDistrictStream()`。
// ⚠️ 同一个块里的 `errText()` **保留** —— `mapSvgUrl()`（现役，B 线那份）还在用它拼错误文案。
// 唯一消费者是 `/world/district-live`（`DistrictLive.vue`），页面与路由同批删（见 `router/index.ts`）。
// 对端同批退役：Rust `bridge.rs` 的两个 `world_map_district_stream*` 命令（Channel 版）、
//   Python 侧车 `/api/district_stream`（SSE 版）。要回退请看 git 历史。

declare global {
  interface Window {
    /** 纯 web 预览标记，由 src/web-mock.ts 打上 */
    __LINGCHAT_WEB_MOCK__?: boolean;
    /** Tauri 壳注入的运行时（真壳由 Rust 注入；web-mock 会伪造一份，见 isTauriRuntime） */
    __TAURI_INTERNALS__?: any;
  }
}

/** invoke 的 reject 有的是 string（Rust 的 `Err(String)`），有的是 Error，统一成人话 */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return e ? String(e) : "未知错误";
}

// ═══════════════════════════════════════════════════════════════════
// 区域主图：**双通路**取图（Tauri 命令 / HTTP），给 `<img src>` 用
//
// 为什么要这层封装：WorldMap.vue / WorldMapLayer.vue 原来直接拼
// `http://127.0.0.1:8791/api/bigmap?...` 塞给 `<img>`。那是**独立调试服务**的地址，
// 打包成 APK 之后手机上没有任何进程监听 8791 → 图片必然加载失败，
// 地图页只剩一句「世界地图服务未启动」和一个空舞台。
//
// 真壳里改走 Tauri 命令 `world_map_geo_svg`（Rust 本地渲染，不需要端口、不需要网络），
// 拿回的 SVG 文本转成 data URL 再塞进 `<img>` —— 组件那套 @error / 刷新逻辑一行都不用改。
//
// **尺寸必须跟着容器走**（机主专门提过）：SVG 里字号是「固定 px」（见 Rust 侧
// render_geo.rs 的 level_style：全国 13.5 / 省 12 / 市 11 / 区县 10.5，再乘各区面积占比
// 0.75~1.6，实测最小 8.2px），跟画布尺寸无关。
// 若固定按 1000×760 画、在手机上被缩到 360px 显示，8~12px 的字实际只剩 3~4px，完全看不清；
// 把容器真实 CSS 像素传下去，画布与显示尺寸 1:1，字号是多少就显示多少（约放大 2.7 倍）。
// ═══════════════════════════════════════════════════════════════════

/** 拿不到容器尺寸时的兜底画布（与 Rust 渲染器 / `/api/bigmap` 的默认值一致） */
export const MAP_SVG_DEFAULT_W = 1000;
export const MAP_SVG_DEFAULT_H = 760;

/** SVG 文本 → 可直接塞进 `<img src>` 的 data URL */
function svgToDataUrl(svg: string): string {
  const text = String(svg || "").trim();
  if (!text.startsWith("<")) throw new Error("后端没有返回 SVG");
  // 用 encodeURIComponent：SVG 里的 `#`（颜色）、中文地名、`<>&` 都会被转义，
  // 否则 data URL 会在第一个 `#` 处被截断成「只画了一半」的图。
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
}

/**
 * 取一份 SVG 文本。后端出错时回的是 JSON（甚至 HTML），
 * 这里提前翻译成人话，免得把 JSON 当图片塞给 `<img>` 后只看到一句「加载失败」。
 */
async function fetchSvgText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`地图接口返回 ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/") && !ct.includes("svg"))
    throw new Error("后端返回的是位图，不是可缩放的 SVG");
  const text = await res.text();
  // 只看开头一段就够：真正的 SVG 一定是 `<svg ...>` 打头（最多前面有 `<?xml ...?>`）
  if (!/<svg[\s>]/i.test(text.slice(0, 400))) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* 不是 JSON 就原样显示前 200 字 */
    }
    throw new Error(msg || "地图渲染失败");
  }
  return text;
}

/**
 * 取区域主图，返回**可直接给 `<img src>` 的 data URL**。
 *
 * @param ad    行政区划 adcode（全国 `100000`；空值时抛错，免得后面拿到一张别的图）
 * @param style gaode（默认）/ dark / water
 * @param w     容器实际 CSS 像素宽（`getBoundingClientRect().width`）
 * @param h     容器实际 CSS 像素高
 *
 * 失败一律 **throw**：调用方（组件）捕获后把 src 置空并走自己已有的错误提示路径，
 * 绝不让一个未捕获的 rejection 冒到控制台、也不让页面卡在「加载中…」。
 */
export async function mapSvgUrl(
  ad: string,
  style = "gaode",
  w: number = MAP_SVG_DEFAULT_W,
  h: number = MAP_SVG_DEFAULT_H
): Promise<string> {
  const code = String(ad || "").trim();
  if (!code) throw new Error("缺少 adcode，取不到地图");
  // 兜底 + 取整：0 / NaN 会让 SVG 的 width/height 属性坏掉，`<img>` 直接空白
  const width = Math.max(64, Math.round(Number(w) || MAP_SVG_DEFAULT_W));
  const height = Math.max(64, Math.round(Number(h) || MAP_SVG_DEFAULT_H));

  // ── ① 真壳：Tauri 命令 ──
  if (isTauriRuntime()) {
    // 命令名与参数名**逐一核对过** src-tauri/src/world_map/mod.rs 的：
    //   pub async fn world_map_geo_svg(app, ad: Option<String>, style: Option<String>,
    //        width: Option<f64>, height: Option<f64>, pad, zoom, labels, dots, stats) -> Result<String, String>
    // Tauri 的 JS 侧参数是 camelCase，这条命令的形参都是单词，所以原样传即可；
    // 其余可选参数（pad/zoom/labels/dots/stats）走 Rust 侧默认值，这里不传。
    const svg = await invoke<string>("world_map_geo_svg", { ad: code, style, width, height });
    return svgToDataUrl(svg);
  }

  // ── ② 浏览器 / 局域网调试：HTTP ──
  // 首选 `/api/geo_svg`：它是 `world_map_geo_svg` 命令在调试服务上的**孪生路由**，
  // 同样认 w/h，所以浏览器预览与真机看到的排版是一致的（字大小不会两套）。
  const geoUrl =
    `${API_BASE}/api/geo_svg?ad=${encodeURIComponent(code)}` +
    `&style=${encodeURIComponent(style)}&w=${width}&h=${height}&zoom=2`;
  try {
    return svgToDataUrl(await fetchSvgText(geoUrl));
  } catch (e) {
    // 兜底：老一些的后端只有 `/api/bigmap`（Rust 调试服务两条都有；Python 侧车只有 bigmap，
    // 而且它回的是 **PNG** → 会在 fetchSvgText 里被识别成位图并报错，这也是预期内的降级终点）。
    // 注意 bigmap **不认 w/h**（只认 scale），所以这条兜底路径忽略尺寸、沿用旧行为。
    try {
      const bigUrl =
        `${API_BASE}/api/bigmap?ad=${encodeURIComponent(code)}` +
        `&style=${encodeURIComponent(style)}&scale=1`;
      return svgToDataUrl(await fetchSvgText(bigUrl));
    } catch (e2) {
      throw new Error(`${errText(e2)}（/api/geo_svg：${errText(e)}）`);
    }
  }
}

export default worldMapApi;

// ═══════════════════════════════════════════════════════════════════
// 地图库（`/api/maplib/*`）：**只剩三个纯 HTTP 出口**（真壳那条「自动分流」已退役）
//
// 🗄 2026-10-06（S9b8 批 F）照实改口径 —— 上面这段原文写着"浏览器预览还在用它们"，
//   那句话随 `views/worldmap/` 那批页面（S9b5 删除）一起失效了。现状：
//     · `maplibList` / `maplibStats` / `maplibCleanup`（本文件上方那三个 `export const`）：
//       `src`/`public` 里**已经没有页面级消费者**，按项目惯例**作为死导出留档**（不连删）；
//     · 曾经追加在文件末尾的三个「自动分流」版本（`maplibListAuto` / `maplibStatsAuto` /
//       `maplibCleanupAuto`：真壳 `invoke`、浏览器走 HTTP）**已退役** ——
//       它们自己的消费者 0 个，留着等于给"地图库面板还活着"的错觉。
//     · 🔴 **对端一个字没动**：Rust 侧三道命令仍在 `src-tauri/src/lib.rs:716-718` 注册着
//       （`world_map_maplib_stats` / `_list` / `_cleanup`），侧车 `/api/maplib/*` 也仍在 ——
//       前端退出口 ≠ 对端退命令。要退那三条命令是**另一笔**，得先确认再没有别的消费者
//       （本轮复核：前端 0 个 invoke；8790/8791 的调试页仍按 HTTP 用那几条路由）。
//   原文（含每条对应的 Rust 签名抄件）见 `git log -p -- src/api/services/worldMap.ts`
//   或 `~/rikka/Dsh-SYuki/world_map/REMOVED-CODE.md` 的 S9b8 条。
//   守卫（可执行）：`frontend_selftest_worldsim_p1.mjs` 的 S9b8 段。
// ═══════════════════════════════════════════════════════════════════

// 🗄 2026-10-06（S9b5-A）：`districtRenderSvg()`（小区渲染 / `world_map_render` 命令的
//   前端出口）已退役 —— 唯一消费者是 `DistrictViz.vue`，页面与路由同批删。
//   命令本体随后由 S9b6 批 B 一并退掉（见上面那条补记）。

// ═══════════════════════════════════════════════════════════════════
// 「世界模拟」首屏要的是**裸 SVG 文本**，不是 data URL —— 所以这里补一个 geoSvgText()
//
// 为什么不能直接用上面的 `mapSvgUrl()`：
//   那个函数把 SVG 转成 data URL 就返回了，**文本就丢了**；而首屏需要从文本里读到
//   `render_geo` 写在每个区划上的 `<g class="geo-region" data-adcode data-name>`，
//   用它来：① 知道这张图上有哪些省/市/区县（三级联动列表的数据源，不必另开接口）；
//          ② 判断定位命中的那个省在图上的哪一块（高亮）。
//   一个请求同时拿到「图」和「图上的区划索引」，比再调一次接口省一次往返。
//
// 与 `mapSvgUrl()` 一样是**双通路**：真壳 invoke Rust 命令（不需要任何本地端口），
// 浏览器走调试服务的孪生路由 `/api/geo_svg`（8791 Rust 服务与 8790 Python 侧车都有这条，
// 都认 w/h/zoom，所以预览与真机排版一致）。
//
// 尺寸仍然必须跟着容器走（理由见 `mapSvgUrl` 上方那段）：字号是固定 px，
// 容器尺寸传下去画布与显示 1:1，手机上字才看得清。
// 另外尺寸还有个副作用是**好事**：抽稀容差是 0.6px，画布越小保留的顶点越少，
// 手机上返回的 SVG 反而更小（全国那张 1000×760 实测 695KB，见交付说明）。
// ═══════════════════════════════════════════════════════════════════

/**
 * 取行政区划 SVG 的**裸文本**（全国 `100000` / 省 / 市 / 区县）。
 *
 * Tauri 侧命令（src-tauri/src/world_map/mod.rs，已逐字核对）：
 *   pub async fn world_map_geo_svg(
 *     app: AppHandle, ad: Option<String>, style: Option<String>,
 *     width: Option<f64>, height: Option<f64>, pad: Option<f64>,
 *     zoom: Option<i32>, labels: Option<bool>, dots: Option<bool>, stats: Option<bool>,
 *   ) -> Result<String, String>
 * 形参都是单词，JS 侧原样传即可（`world_map_geo_svg` 一条命令就够，
 * pad/labels/dots/stats 留给 Rust 默认值）。
 *
 * @param ad    行政区划 adcode（空值按全国处理）
 * @param style gaode / dark / water（三套主题仍由 Rust 渲染器决定，外壳不干预）
 * @param w     容器实际 CSS 像素宽
 * @param h     容器实际 CSS 像素高
 * @param zoom  1=只留主轮廓（省界/市界），2=多一层内阴影，3=全
 * @param hydro 是否叠加**真实水系**（河流/湖泊，Natural Earth 1:50m，Rust 侧编译期内嵌）。
 *              默认 `true`。这是唯一会明显增加 SVG 体积的图层（全国视图实测 +32KB / +4.7%），
 *              万一在低端机上成为负担，调用方传 `false` 即可退回加图层之前的样子
 *              （**不会白屏**：关掉只是少画一层，主图与点击下钻都照常）。
 * @param elevation 是否叠加**真实地形着色**（分层设色，SRTM 90m 采样成 1° 网格内嵌）。
 *              默认 `true`，全国视图实测 +29KB / +4.1%。
 *              **与 `hydro` 完全独立**：四种组合都受支持（比如只想要河流不要地形）。
 *
 * 失败一律 **throw**（空串、不是 SVG 都算失败）：调用方已有 catch → 页面提示 + 重试，
 * 绝不把 JSON 塞进 v-html 变成一屏乱码、也不让页面卡在「加载中…」。
 */
export async function geoSvgText(
  ad: string,
  style = "gaode",
  w: number = MAP_SVG_DEFAULT_W,
  h: number = MAP_SVG_DEFAULT_H,
  zoom = 2,
  hydro = true,
  elevation = true
): Promise<string> {
  const code = String(ad || "").trim() || "100000";
  const width = Math.max(64, Math.round(Number(w) || MAP_SVG_DEFAULT_W));
  const height = Math.max(64, Math.round(Number(h) || MAP_SVG_DEFAULT_H));
  const z = Math.min(3, Math.max(1, Math.round(Number(zoom) || 2)));

  // ── ① 真壳：Tauri 命令（本地渲染，离线可用，只要有 geojson 缓存）──
  if (isTauriRuntime()) {
    const svg = await invoke<string>("world_map_geo_svg", {
      ad: code,
      style,
      width,
      height,
      zoom: z,
      hydro: hydro !== false,
      elevation: elevation !== false,
    });
    const text = String(svg || "");
    if (!/<svg[\s>]/i.test(text.slice(0, 400))) {
      throw new Error(`world_map_geo_svg 没返回 SVG（ad=${code}）`);
    }
    return text;
  }

  // ── ② 浏览器 / 局域网调试：/api/geo_svg ──
  // 这条路由**不认 zoom 之外的东西**也一样能用；出错时 fetchSvgText 会把 JSON 翻译成人话。
  //
  // ⚠️ `hydro` / `elevation` 目前**只有 Rust 侧认**（Python 侧车 `hier_api.py` 的 `/api/geo_svg`
  // 还没实现这两个图层，多传的参数会被它忽略）→ 浏览器预览看不到河湖与地形，真机才看得到。
  // 这是已知差异，不影响真机；要消除得同步改 Python 原型（不在本次范围）。
  const url =
    `${API_BASE}/api/geo_svg?ad=${encodeURIComponent(code)}` +
    `&style=${encodeURIComponent(style)}&w=${width}&h=${height}&zoom=${z}` +
    `&hydro=${hydro !== false ? 1 : 0}` +
    `&elevation=${elevation !== false ? 1 : 0}`;
  return await fetchSvgText(url);
}

// ═══════════════════════════════════════════════════════════════════
// 几何数据（GeoJSON）与下级区划：**双通路**
// ═══════════════════════════════════════════════════════════════════
//
// 为什么需要：手机里的「地图/导航」（T5-2）要**目的地坐标**才能调 `transport_plan`，
// 而后端**没有「区县中心坐标」接口**（实测 `/api/blocks?ad=` 返回 `{ok:false}`、
// `/api/location?ad=` 会忽略 ad）→ 只能拿该区县的 GeoJSON 自己算面积质心。
// 目的地候选则来自下级区划列表。
//
// ✅ 2026-10-06（S9b5-B）**真壳那半补上了**：`world_map_geo_json` / `world_map_geo_children`
//    现在注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里，实现在 `world_map/mod.rs`
//    （数据源与 `world_map_geo_svg` 同一份缓存 + 同一套兜底），与 8791 调试服务的
//    `/api/geo_json`、`/api/geo/children` 孪生、同形。
//
//    🔴 补之前这里**只有浏览器通路能用**：真壳里两条 invoke 直接 reject，而调用方全是
//    `catch {}` / `catch { return null }` 静默降级 —— 页面上一个字都看不出来，但
//    ① 手机导航/打车/公交的目的地列表恒空；② 现役 2.5D 主图（`WsDistrictMapLibre.vue`）
//    拿不到区县 bbox ⇒「整区视野」快路径失效、退回「IP 定位 + 现问 Overpass」的慢路径。
//    ⇒ 口径：**失败一律 throw，调用方必须把原因显示给用户**，不许再留静默 reject 的调用。

/** 取某个 adcode 的 GeoJSON（FeatureCollection）。失败一律 throw。 */
export async function geoJson(ad: string): Promise<unknown> {
  const code = String(ad || "").trim() || "100000";
  if (isTauriRuntime()) {
    return await invoke("world_map_geo_json", { ad: code });
  }
  const r = await fetch(`${API_BASE}/api/geo_json?ad=${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error(`/api/geo_json HTTP ${r.status}`);
  return await r.json();
}

/** 取某个 adcode 的下级区划列表（`{name, adcode}`）。失败一律 throw。 */
export async function geoChildren(ad: string): Promise<Array<{ name: string; adcode: string }>> {
  const code = String(ad || "").trim() || "100000";
  if (isTauriRuntime()) {
    const d = (await invoke("world_map_geo_children", { ad: code })) as { children?: unknown };
    return Array.isArray(d?.children) ? (d.children as Array<{ name: string; adcode: string }>) : [];
  }
  const r = await fetch(`${API_BASE}/api/geo/children?ad=${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error(`/api/geo/children HTTP ${r.status}`);
  const d = (await r.json()) as { children?: unknown };
  return Array.isArray(d?.children) ? (d.children as Array<{ name: string; adcode: string }>) : [];
}

// ═══════════════════════════════════════════════════════════════════
// 行程（打车/出行）状态机：**双通路**
// ═══════════════════════════════════════════════════════════════════
//
// 真壳命令（`src-tauri/src/lib.rs` 已注册，逐字核对过）：
//   world_map_trip_start(req: Value) / world_map_trip_status(role) /
//   world_map_trip_cancel(role, reason) / world_map_trip_speedup(speedup, enabled)
// 浏览器通路：8791 的 `/api/trip_start|trip_tick|trip_status|trip_cancel`
//   —— 那几条路由调的**就是 transport.rs 里同一份 start_trip/tick_trip**，
//      所以「浏览器里验过的行程逻辑」与真壳是同一份代码，不是仿制。
//
// ⚠️ **推进方式不同**：真壳里由 Rust 侧按真实时间推进（`tick_to_now`）；
//    浏览器里由**客户端推时钟**（`tripTick(dt)` 传"推进多少秒"），这样才能几秒走完几小时的行程。
//    这只是"谁来打拍子"的差别，**状态推进逻辑仍是 Rust 的**。

export interface WsTripPhase {
  kind?: string;
  mode_name?: string;
  duration_min?: number;
  distance_m?: number;
  note?: string;
}
export interface WsTrip {
  id?: string;
  label?: string;
  mode?: string;
  mode_name?: string;
  icon?: string;
  status?: string;
  cost?: number;
  cost_text?: string;
  total_duration_min?: number;
  distance_m?: number;
  elapsed_min?: number;
  remaining_min?: number;
  remaining_m?: number;
  progress?: number;
  finished?: boolean;
  phases?: WsTripPhase[];
}

/** 开一次行程（参数与 `transportPlan` 一致，另加 label 与 scale）。失败 throw。 */
export async function tripStart(
  o: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; prefer?: string; label?: string; scale?: number }
): Promise<WsTrip> {
  const req = {
    from_lat: o.from.lat,
    from_lng: o.from.lng,
    to_lat: o.to.lat,
    to_lng: o.to.lng,
    prefer: o.prefer,
    label: o.label || "",
    scale: o.scale ?? 1,
  };
  if (isTauriRuntime()) {
    const r = (await invoke("world_map_trip_start", { req })) as { trip?: WsTrip } | WsTrip;
    return (r as { trip?: WsTrip })?.trip ?? (r as WsTrip);
  }
  const q = new URLSearchParams(Object.entries(req).filter(([, v]) => v !== undefined) as [string, string][]);
  const res = await fetch(`${API_BASE}/api/trip_start?${q}`);
  const d = (await res.json()) as { ok?: boolean; error?: string; trip?: WsTrip };
  if (d?.ok === false) throw new Error(d.error || "开行程失败");
  if (!d?.trip) throw new Error("开行程失败：没有返回 trip");
  return d.trip;
}

/** 推进 `dt` 秒（**仅浏览器通路**；真壳由 Rust 侧自己走时钟）。返回推进后的行程。 */
export async function tripTick(dt: number): Promise<WsTrip> {
  const res = await fetch(`${API_BASE}/api/trip_tick?dt=${encodeURIComponent(String(dt))}`);
  const d = (await res.json()) as { ok?: boolean; error?: string; trip?: WsTrip };
  if (d?.ok === false) throw new Error(d.error || "推进行程失败");
  if (!d?.trip) throw new Error("推进行程失败：没有返回 trip");
  return d.trip;
}

/** 只读当前行程（真壳走 `world_map_trip_status`）。 */
export async function tripStatus(): Promise<WsTrip | null> {
  if (isTauriRuntime()) {
    const r = (await invoke("world_map_trip_status", {})) as { trip?: WsTrip } | WsTrip;
    return (r as { trip?: WsTrip })?.trip ?? (r as WsTrip) ?? null;
  }
  const res = await fetch(`${API_BASE}/api/trip_status`);
  const d = (await res.json()) as { trip?: WsTrip };
  return d?.trip ?? null;
}

/** 结束/清空当前行程。 */
export async function tripCancel(reason = ""): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("world_map_trip_cancel", { reason });
    return;
  }
  await fetch(`${API_BASE}/api/trip_cancel`);
}

// ═══════════════════════════════════════════════════════════════════
// T2-1/T2-2 · 设施图层（生活 7 类 + 交通 7 类）
// ═══════════════════════════════════════════════════════════════════
//
// 背景：`facilities.rs`（110KB、18 个单测、与 Python 对拍过）早就移植完了，
// 但**一条命令都没暴露** —— 前端拿不到数据，地图上也就没有设施图层。这一段就是那扇门。
//
// 三条通路（真壳命令 / 调试服务 HTTP 路由 / 前端的降级）对同一个形状负责：
//   · 真壳：`world_map_facilities` / `world_map_facilities_types` / `world_map_facility_at`
//     （定义在 `src-tauri/src/world_map/mod.rs` 末尾）
//   · 浏览器：`/api/facilities` / `/api/facilities/types` / `/api/facility_at`
//     （定义在 `world_map_rs/src/main.rs`，**与真壳同形**，两边的字段契约由
//      `~/rikka/Dsh-SYuki/world_map/facilities_layer_selftest.mjs` 的断言守着）
//
// ⚠️ 坐标不是经纬度：`gx/gy` 是**小区图的格点**（与 `WorldSim.vue` 的 `WS_GRID=28`、
//    `WsDistrict` 的 `SKETCH_SIZE=28` 同一套）。设施图层要铺在 `#pin` 插槽里
//    （`.ws-neigh__pan` 那个手势变换容器内），**不要**往 GeoJSON 画布上按经纬度投影 ——
//    那是行政区划图的坐标系，两套东西。
//
// ⚠️ 确定性：同 `area`+`size`+`seed` 永远同一批落点（后端 sha256 播种）。
//    前端每次都传同一个 `seed`（`WsDistrict` 画草图用的是 `hash32(area)`），
//    所以「刷新后设施位置不变」；反过来，传 `Date.now()` 会让设施每次刷新乱跳。

/** 一个设施点（`facilities.rs::_mk_fac` 的产物，字段名与 Python 原型逐字相同） */
export interface FacPoint {
  id: string;
  /** 格点坐标（占地**左上角**，单位=格） */
  gx: number;
  gy: number;
  /** 占地尺寸（格） */
  w: number;
  h: number;
  /** 类型 key：residential/commercial/education/medical/leisure/civic/lodging + 7 类交通 */
  type: string;
  /** 类型中文名（后端已给，前端不再自己映射一份） */
  type_zh?: string;
  name: string;
  icon?: string;
  /** `[r,g,b]` */
  color?: number[];
  /** `"life"` | `"transport"` */
  group: string;
  /** 室内/室外（`facilities::indoor_of`） */
  indoor?: boolean;
  cell_meters?: number;
  /** 只有「最近设施」查询才带：与查询点的格距 */
  dist?: number;
}

/** 一类设施的元数据（`facilities::types_payload()` 的一条） */
export interface FacTypeMeta {
  zh: string;
  icon: string;
  color: number[];
  group: string;
  prefix?: string;
  w?: number;
  h?: number;
  group_zh?: string;
}

/** `/api/facilities/types`（= `world_map_facilities_types`）的返回 */
export interface FacTypesPayload {
  /** 14 类：7 生活 + 7 交通 */
  types?: Record<string, FacTypeMeta>;
  /** 层级中文名：community/district/city */
  levels?: Record<string, string>;
  /** 各层级生成哪些交通设施及个数 */
  level_plan?: Record<string, Record<string, number>>;
  cell_meters?: number;
}

/** `/api/facilities`（= `world_map_facilities`）的返回 —— 两条通路**同形** */
export interface FacPayload {
  ok?: boolean;
  area?: string;
  level?: string;
  /** 小区图网格边长；应等于前端的 `WS_GRID`，不等说明两边不是同一张图 */
  grid?: number;
  cell_meters?: number;
  layout_name?: string | null;
  /** 设施落在哪份布局上：`layout` / `maplib` / `sketch`（如实展示，便于判断有没有贴住真建筑） */
  layout_source?: string;
  life_count?: number;
  transport_count?: number;
  /** 生活设施（7 类） */
  facilities?: FacPoint[];
  /** 交通设施（7 类，按 level 出不同组合） */
  transport?: FacPoint[];
  stats?: {
    total?: number;
    by_type?: Record<string, number>;
    by_group?: Record<string, number>;
  } | null;
}

/** 「这个角色现在在哪个设施」的结果（`world_map_facility_at` / `/api/facility_at`） */
export interface FacAtResult {
  ok?: boolean;
  gx?: number;
  gy?: number;
  /** `cell`=格点落在设施占地内；`near`=半径内最近；`none`=附近没有 */
  source?: "cell" | "near" | "none" | string;
  facility?: FacPoint | null;
}

/** 取设施的参数（三项都不传时后端用默认区域 + 28×28 草图） */
export interface FacQuery {
  /** 区域名「广州市·越秀区」——同时决定草图与设施播种 */
  area?: string;
  /** 网格边长（前端固定传 `WS_GRID=28`，与显示的小区图对齐） */
  size?: number;
  /** 随机种子：**必须稳定**。前端传 `hash32(area)`，刷新后位置不变 */
  seed?: number;
  /** 交通设施层级：community（默认）/ district / city */
  level?: string;
  /** 地图库布局缓存 key —— 传了就落在**玩家实际看到的那张图**上（最准） */
  key?: string;
}

/**
 * 取设施清单。真壳 invoke，浏览器 HTTP。
 *
 * 失败一律 **throw**（HTTP 非 2xx、`ok===false`、缺 `facilities` 都算失败）：
 * 调用方（`WsFacilityLayer`）会把它显示成「设施数据取不到 + 原因」，
 * **绝不静默返回空数组** —— 空数组在界面上等于"这里没有设施"，那是假话。
 */
export async function facilitiesAuto(q: FacQuery = {}): Promise<FacPayload> {
  if (isTauriRuntime()) {
    const r = await invoke<FacPayload>("world_map_facilities", {
      area: q.area,
      size: q.size,
      seed: q.seed,
      level: q.level,
      key: q.key,
    });
    return assertFacPayload(r);
  }
  return assertFacPayload(
    await httpGet<FacPayload>("/api/facilities", {
      area: q.area,
      size: q.size,
      seed: q.seed,
      level: q.level,
      key: q.key,
    })
  );
}

/** 取设施类型元数据（中文名/图标/配色/各层级计划）—— 图例与"按类别过滤"的开关用 */
export async function facilitiesTypesAuto(): Promise<FacTypesPayload> {
  const r = isTauriRuntime()
    ? await invoke<FacTypesPayload>("world_map_facilities_types")
    : await httpGet<FacTypesPayload>("/api/facilities/types");
  if (!r || typeof r !== "object" || !r.types || typeof r.types !== "object") {
    throw new Error("设施类型表为空（后端没给 types）");
  }
  return r;
}

/**
 * 按格点查「这个角色现在在哪个设施」。
 *
 * `facilities` 传了就不重新生成（与 `world_map_schedule` 同一个约定）：
 * 前端手上那份才是**与画面一致**的那一份。
 */
export async function facilityAtAuto(o: {
  gx: number;
  gy: number;
  radius?: number;
  facilities?: FacPoint[];
  area?: string;
  size?: number;
  seed?: number;
  level?: string;
}): Promise<FacAtResult> {
  const radius = o.radius === undefined ? 3 : o.radius;
  if (isTauriRuntime()) {
    return await invoke<FacAtResult>("world_map_facility_at", {
      facilities: o.facilities && o.facilities.length ? o.facilities : undefined,
      gx: o.gx,
      gy: o.gy,
      radius,
      area: o.area,
      size: o.size,
      seed: o.seed,
      level: o.level,
    });
  }
  return await httpGet<FacAtResult>("/api/facility_at", {
    gx: o.gx,
    gy: o.gy,
    radius,
    area: o.area,
    size: o.size,
    seed: o.seed,
    level: o.level,
  });
}

/** 校验设施返回的**最低契约**：少了 `facilities` 就是失败，不能当成"没有设施" */
function assertFacPayload(r: unknown): FacPayload {
  const d = r as FacPayload | null;
  if (!d || typeof d !== "object") throw new Error("设施接口没有返回对象");
  if (d.ok === false) throw new Error("设施接口返回 ok=false");
  if (!Array.isArray(d.facilities)) throw new Error("设施接口没有返回 facilities 数组");
  if (!Array.isArray(d.transport)) throw new Error("设施接口没有返回 transport 数组");
  return d;
}

// ═══════════════════════════════════════════════════════════════════
// T2-2 · 交通设施（7 类：公交站/地铁/停车场/加油站/火车站/机场/码头）
// ═══════════════════════════════════════════════════════════════════
//
// 与 T2-1 的设施图层是**同一批数据**（`facilities.rs` 的 `generate_all().transport`），
// 这里单独开一条通路，是因为交通设施多两样前端要用的东西：
//   · 每个站点带 **lng/lat**（用锚点换算，公式与规划器 `transport_in_grid` 逐字一致）
//     → 前端能把「我上车的那个站」画在地图上，且与规划器认为的位置**逐位相同**；
//   · **三级对比**（社区 8 / 区县 13 / 城市 23，种类也不同）—— 卡片要求"能看出差别"，
//     数量与种类由后端按 `LEVEL_PLAN` 算好，前端**不写第二份**（两份必然漂移）。
//
// ⚠️ 坐标：`gx/gy` 是小区图**格点**（图层用这个画）；`lng/lat` 只在给了锚点时才有
//    （`geo === false` 时**一个经纬度字段都没有** —— 这是如实标注，不是缺字段）。
//
// 真壳命令：`world_map_transport_nodes`（src-tauri/src/world_map/mod.rs）
// 浏览器路由：`/api/transport_nodes`（world_map_rs/src/main.rs，同形）

/** 一个交通站点：设施点 + 可选经纬度 */
export interface TransitNode extends FacPoint {
  /** 只在 `geo === true` 时存在 */
  lng?: number;
  lat?: number;
}

/** 某个层级下的交通配置（数量 + 种类） */
export interface TransitLevelRow {
  /** community | district | city */
  level: string;
  /** 小区 / 区县 / 城市 */
  zh: string;
  count: number;
  /** 这一级会出现哪些类型（后端按 LEVEL_PLAN 算的） */
  kinds: string[];
}

/** `/api/transport_nodes`（= `world_map_transport_nodes`）的返回 */
export interface TransitNodesPayload {
  ok?: boolean;
  error?: string;
  area?: string;
  level?: string;
  grid?: number;
  cell_meters?: number;
  /** **布局**来源：maplib / layout / sketch … */
  source?: string;
  /** **锚点**来源：explicit-anchor / center / maplib-meta / trip-origin / none（与布局来源是两件事） */
  anchor_source?: string;
  /** 有没有经纬度（false = 没给锚点，只有格点坐标） */
  geo?: boolean;
  anchor?: { lng: number; lat: number } | null;
  center?: { lng: number; lat: number } | null;
  count?: number;
  nodes?: TransitNode[];
  /** 14 类元数据（含 7 类交通的图标/配色） */
  types?: FacTypesPayload;
  /** 三级对比（`all_levels=0` 时不返回） */
  levels?: TransitLevelRow[];
}

/** 取交通站点的参数 */
export interface TransitQuery {
  area?: string;
  /** 网格边长（前端传 `WS_GRID`） */
  size?: number;
  /** 稳定种子：传 `hash32(area)` 就与 T2-1 图层、与算路吸附**三方同源** */
  seed?: number;
  level?: string;
  key?: string;
  anchorLng?: number;
  anchorLat?: number;
  centerLng?: number;
  centerLat?: number;
  /** `false` = 不要三级对比 */
  allLevels?: boolean;
}

/**
 * 取交通站点。真壳 invoke，浏览器 HTTP。失败一律 throw
 * （调用方显示「取不到 + 原因」，**不静默返回空数组** —— 空数组在界面上等于"这里没有车站"）。
 */
export async function transportNodesAuto(q: TransitQuery = {}): Promise<TransitNodesPayload> {
  const r = isTauriRuntime()
    ? await invoke<TransitNodesPayload>("world_map_transport_nodes", {
        area: q.area,
        size: q.size,
        seed: q.seed,
        level: q.level,
        key: q.key,
        anchorLng: q.anchorLng,
        anchorLat: q.anchorLat,
        centerLng: q.centerLng,
        centerLat: q.centerLat,
        allLevels: q.allLevels,
      })
    : await httpGet<TransitNodesPayload>("/api/transport_nodes", {
        area: q.area,
        size: q.size,
        seed: q.seed,
        level: q.level,
        key: q.key,
        anchor_lng: q.anchorLng,
        anchor_lat: q.anchorLat,
        center_lng: q.centerLng,
        center_lat: q.centerLat,
        all_levels: q.allLevels === undefined ? undefined : q.allLevels ? 1 : 0,
      });
  const d = r as TransitNodesPayload | null;
  if (!d || typeof d !== "object") throw new Error("交通站点接口没有返回对象");
  if (d.ok === false) throw new Error(d.error || "交通站点接口返回 ok=false");
  if (!Array.isArray(d.nodes)) throw new Error("交通站点接口没有返回 nodes 数组");
  return d;
}
