/* wsEngineOverlay.ts —— 世界模拟页的**实验性 3D 引擎叠加层**（iframe）开关与地址。
 *
 * ## 它是什么
 * `public/ws3d/engine/engine_overlay.html` 是自研 three 城市引擎的独立页（MapLibre 管底图 +
 * `world3d7.html?overlay=1` 的透明 3D 叠在上面）。这里把它**当 iframe 挂进 App**，
 * 叠在地图之上、`pointer-events:none`，输入仍然全部归 MapLibre。
 *
 * ## 为什么用 iframe 而不是把引擎搬进 src/
 * 引擎页是 ~4.3MB 的独立产物（three + maplibre vendor + data/*.json），它有自己的模块作用域、
 * 自己的 `?fx=` 参数与自己的重建节奏。iframe 把它整块隔开：
 *   · 引擎崩了只崩那一帧 iframe，App 的地图与手势不受影响；
 *   · 关掉开关 = **DOM 里连 iframe 都不存在**（不是 `display:none`），零渲染成本；
 *   · 将来换 `world3d8` 只改 `ENGINE_OVERLAY_VERSION` 注释与页内版本，App 侧不动。
 *
 * ## 开关口径（默认关，这是硬要求）
 * `?engine=1` → 开并记住；`?engine=0` → 关并记住；两者都没有时读 localStorage，缺省 **关**。
 * 关着的时候本模块只读一次 localStorage，模板里 `v-if` 直接不产 DOM ⇒ 行为与接入前完全一致。
 *
 * ## 现在同步到什么程度（如实写）
 * 阶段②：**只做叠加层可见**。引擎 iframe 内的相机仍停在它自己的默认城市中心（渝中），
 * 与宿主地图的 center/zoom **尚未单向同步**（那是阶段③）。所以拖动宿主地图时 3D 不会跟，
 * 这是已知且被记录的行为，不是 bug。
 */

import { ref } from "vue";

/** localStorage 键：与 `wsm:v1:renderer`（地图/3D 后端）区分开，互不影响 */
export const ENGINE_OVERLAY_KEY = "wsm:v1:engine";

/** 引擎页相对 `public/` 的路径 */
const ENGINE_OVERLAY_PAGE = "ws3d/engine/engine_overlay.html";

/**
 * 引擎版本：**先钉 `world3d7`**（稳定、无 rays 抖动）。
 * 换版本 = 换 `engine_overlay.html` 里 iframe 的 src，或按 lead 的裁决整体替换该页；
 * 等 `world3d8` 过 §9.8 再切，App 侧只认这个常量所在的注释。
 */
export const ENGINE_OVERLAY_VERSION = "world3d7";

/**
 * iframe 地址。`base=0` 让引擎**不铺自带的高德底图**（宿主已经有底图了，否则会把地图盖死），
 * `hud=0` 关掉引擎页自己的 HUD（App 有自己的状态栏，两套会打架）。
 */
export function engineOverlaySrc(): string {
  return `${import.meta.env.BASE_URL}${ENGINE_OVERLAY_PAGE}?base=0&hud=0&datum=0`;
}

/** 读开关：URL 优先（并可持久化），否则 localStorage，缺省关 */
function readEngineOverlayPref(): boolean {
  let q: string | null = null;
  try {
    q = new URLSearchParams(location.search).get("engine");
  } catch {
    q = null;
  }
  if (q === "1" || q === "true") {
    saveEngineOverlayPref(true);
    return true;
  }
  if (q === "0" || q === "false") {
    saveEngineOverlayPref(false);
    return false;
  }
  try {
    return localStorage.getItem(ENGINE_OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

function saveEngineOverlayPref(on: boolean): void {
  try {
    localStorage.setItem(ENGINE_OVERLAY_KEY, on ? "1" : "0");
  } catch {
    /* 存不下（隐私模式）就只对本次会话生效 */
  }
}

/** 叠加层开关（页面外壳与舞台共用这一份；改它即时生效，不需要重载） */
export const engineOverlayOn = ref(readEngineOverlayPref());

/** 改开关并持久化（给将来的调试芯片/设置项用） */
export function setEngineOverlay(on: boolean): void {
  engineOverlayOn.value = !!on;
  saveEngineOverlayPref(!!on);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段③：宿主视野 → 引擎 iframe 的**单向**推送
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 方向只有一条：**宿主地图是唯一真源**，引擎侧零自积分（它只做 map.jumpTo + 自己的相机装配）。
 * 这样"用户在引擎里拖不动"是设计而不是缺陷 —— iframe 本身 `pointer-events:none`，
 * 手势永远落在宿主的 MapLibre 上。
 *
 * **坐标系**：App 底图是 Esri/WGS-84，引擎页默认底图是高德/GCJ-02。所以消息里带 `datum:'wgs'`，
 * 让引擎页关掉 `gcj2wgs`（否则会多扣一次 ~400m 的偏移，正是 §5 标定出来的那个量级）。
 *
 * **节流**：宿主每帧读一次，但只有距上次 ≥33.3ms（30Hz）才真的 postMessage。
 * 被丢掉的那些帧**不补发**（下一帧还会有新值）—— 补发只会让队列堆积、手势更跟手变差。
 */
export interface WsEngineHostView {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** 宿主 iframe 的 window（同源，`WsEngineOverlay.vue` 在 iframe load 时登记） */
let frameWindow: Window | null = null;
/** 上次真正发出去的时刻（performance.now） */
let lastPushAt = 0;
let lastSent: WsEngineHostView | null = null;
/** 30Hz 上限 */
const MIN_PUSH_INTERVAL_MS = 1000 / 30;
/** 实际发出去的帧数（验收探针读它，证明"不是只在开图时发一次"） */
export let engineHostViewPushes = 0;

/** iframe 载入/卸载时登记（`null` = 注销） */
export function bindEngineFrame(win: Window | null): void {
  frameWindow = win;
  lastPushAt = 0;
  lastSent = null;
}

/**
 * 推一帧宿主视野。返回 true 表示这一帧真的发出去了（被节流就返回 false）。
 * 任何异常都吞掉：iframe 跨源/已卸载时不能让宿主的手势循环崩掉。
 */
export function pushEngineHostView(v: WsEngineHostView): boolean {
  if (!engineOverlayOn.value || !frameWindow) return false;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - lastPushAt < MIN_PUSH_INTERVAL_MS) return false;
  lastPushAt = now;
  /* 视图没变就不发：宿主静止时一帧都不发，引擎那边也就不会每帧重装相机。
     （引擎侧也有一层去重，两道都在 —— 一道防"白跑 postMessage"，一道防"白跳地图"。） */
  const L = lastSent;
  if (L && Math.abs(L.lng - v.lng) < 1e-7 && Math.abs(L.lat - v.lat) < 1e-7 &&
      Math.abs(L.zoom - v.zoom) < 1e-4 && Math.abs(L.pitch - v.pitch) < 1e-3 &&
      Math.abs(L.bearing - v.bearing) < 1e-3) return false;
  lastSent = { lng: v.lng, lat: v.lat, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing };
  try {
    frameWindow.postMessage(
      { type: "w3d:hostview", datum: "wgs", lng: v.lng, lat: v.lat, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing },
      "*",
    );
    engineHostViewPushes += 1;
    return true;
  } catch {
    return false;
  }
}
