/* wsMapCenter.ts —— **初始地图中心的覆盖口**（`?lat/?lng`、`?city=<id>`）。
 *
 * ## 为什么有它
 * 建图中心原来写死在 `WsDistrictMapLibre.vue`（`[106.569, 29.558]`，渝中）。换城市验收
 * （例如北京包）没法把地图开到别处 ⇒ 只能在 URL 上留一个口子。解析/取值规则独立成这一份，
 * 是为了能脱离 DOM 单测（本仓库的纯函数自检口径：不碰 Vue / MapLibre）。
 *
 * ## 口径
 *   · `?lat=&lng=`：直接钉中心（WGS-84 十进制度，两者都必须合法才生效）；
 *   · `?city=<id>`：读 `{base}/citypacks/cities.json` 里 `cities[].bbox`，取 bbox 中心
 *     （清单是城市包的既有产物，不另造一份城市坐标表）；
 *   · 都没有 / 非法 / 取不到 ⇒ **历史默认** `[106.569, 29.558]`，行为与接入前逐字一致。
 *
 * ## 纪律
 * 失败一律静默回默认，**绝不阻塞建图**；返回值带 `source`（default/latlng/city），
 * 便于 HUD/探针区分"这次是不是故意换了中心"。
 */

/** 历史默认中心（MapLibre 口径：`[lng, lat]`） */
export const WS_DEFAULT_MAP_CENTER: [number, number] = [106.569, 29.558];

export type InitialCenterSource = "default" | "latlng" | "city";

export interface InitialCenter {
  /** MapLibre `center:` 用的 `[lng, lat]` */
  center: [number, number];
  source: InitialCenterSource;
  /** 本次生效的 URL 参数原值（诊断用；没有就是 undefined） */
  param?: string;
}

export interface ResolveInitialCenterOptions {
  /** `location.search`；非浏览器环境传 `""` */
  search: string;
  /** 城市清单的静态根（`import.meta.env.BASE_URL`；默认 `"/"`） */
  baseUrl?: string;
  /** 注入用（单测/离线）：返回已解析的 JSON；不给就走真实 `fetch` */
  fetchJson?: (url: string) => Promise<unknown>;
  /** `?city=` 查清单的超时（毫秒）；超时按"取不到"处理 */
  timeoutMs?: number;
}

const inRange = (v: number, min: number, max: number): boolean => v >= min && v <= max;

/** 数值合法性：只要有限数且落在经纬度范围内（不替调用方做投影/边界裁决） */
export function validLngLat(lng: unknown, lat: unknown): boolean {
  const x = typeof lng === "number" ? lng : Number(lng);
  const y = typeof lat === "number" ? lat : Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return inRange(x, -180, 180) && inRange(y, -85, 85);
}

/** `?lat=&lng=` → `[lng, lat]`；缺一个、非数、越界都返回 null */
export function centerFromLatLng(search: string): [number, number] | null {
  try {
    const q = new URLSearchParams(search);
    if (!q.has("lat") || !q.has("lng")) return null;
    const lat = Number(q.get("lat"));
    const lng = Number(q.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (!validLngLat(lng, lat)) return null;
    return [lng, lat];
  } catch {
    return null;
  }
}

/** `bbox: [minLng, minLat, maxLng, maxLat]` → 中心 `[lng, lat]`；形状不对返回 null */
export function centerFromBbox(bbox: unknown): [number, number] | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const nums = bbox.map((v) => (typeof v === "number" ? v : Number(v)));
  if (!nums.every((v) => Number.isFinite(v))) return null;
  const [minLng, minLat, maxLng, maxLat] = nums as [number, number, number, number];
  if (minLng > maxLng || minLat > maxLat) return null;
  const lng = (minLng + maxLng) / 2;
  const lat = (minLat + maxLat) / 2;
  if (!validLngLat(lng, lat)) return null;
  return [lng, lat];
}

/** 只做同步解析：`?lat/?lng` 命中就直接给；`?city` 只取 id，查表交给调用方 */
export function parseInitialCenterParams(search: string): {
  latlng: [number, number] | null;
  city: string | null;
} {
  let city: string | null = null;
  try {
    const raw = new URLSearchParams(search).get("city");
    const id = (raw || "").trim();
    city = id.length > 0 && id.length <= 80 ? id : null;
  } catch {
    city = null;
  }
  return { latlng: centerFromLatLng(search), city };
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), Math.max(250, timeoutMs)) : 0;
  try {
    const r = await fetch(url, {
      signal: ctl ? ctl.signal : undefined,
      cache: "no-store",
    } as RequestInit);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 完整解析：先 `?lat/?lng`，再 `?city` 查城市清单，最后回默认。
 * **任何异常都吞掉**（建图不能因为解析中心失败而卡住）。
 */
export async function resolveInitialCenter(
  opts: ResolveInitialCenterOptions,
): Promise<InitialCenter> {
  const { search, baseUrl = "/", fetchJson, timeoutMs = 2500 } = opts;
  const { latlng, city } = parseInitialCenterParams(search);
  if (latlng) {
    return { center: latlng, source: "latlng", param: `lat=${latlng[1]},lng=${latlng[0]}` };
  }
  if (city) {
    try {
      const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const url = `${root}citypacks/cities.json`;
      const json = (await (fetchJson ? fetchJson(url) : fetchJsonWithTimeout(url, timeoutMs))) as {
        cities?: unknown;
      } | null;
      const list = json && Array.isArray(json.cities) ? json.cities : [];
      for (const item of list) {
        const rec = item as { id?: unknown; bbox?: unknown } | null;
        if (!rec || String(rec.id ?? "") !== city) continue;
        const center = centerFromBbox(rec.bbox);
        if (center) return { center, source: "city", param: city };
      }
    } catch {
      /* 清单取不到 → 回默认（建图继续） */
    }
  }
  return { center: WS_DEFAULT_MAP_CENTER, source: "default" };
}
