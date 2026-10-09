/* wsThreeBackend.ts —— **three 后端**：用**同一份世界数据 + 同一套配色**画的那条渲染路。
 *
 * ## 口径（2026-10-07 原话：「three.js 的建筑风格尽量贴近 maplibre … 用户可以选择渲染方式，
 *    **除了渲染不一样，其他全一样**」）
 * 这一版是**最小可视版**（用户在同一轮里给过退路：做不完就把 P1 收敛成"契约 + 开关 +
 * 相机/主题/角色交接 + 用 App 的楼数据与同一主题色画出来，哪怕是盒子 + 同一套 ramp 色阶"）：
 *   · **楼**：来自 `bld` source 的那份 GeoJSON（`WsRenderWorld.buildings`，地图正在画的同一批要素），
 *     每栋按 `h_base → h3d` 挤出，**颜色逐栋取要素自带的 `color3d`**（与 2D 的 `bld-ext` paint
 *     读的是**同一个字段**：`wsDistrictScene.ts:322` 那条 `["coalesce",["get","color3d"], ramp]`）；
 *   · **高度**：同一口径 `renderHeight()`（`wsBuildingLook.ts:135`：真高 → 层数×3 → 按类型估），
 *     `h3d` 就是它的产物 ⇒ 有 `h3d` 用 `h3d`，没有才现算（同一函数，不是第二套）；
 *   · **路**：`roads` source 的那份 GeoJSON，宽度复用 `roadStyleOf(rank).w`、
 *     颜色复用主题的 `road.rankColors`（与 2D 的 `road-line-*` 同一份调色板）；
 *   · **角色**：**2D 立绘 billboard**，直接复用原型那份逐字节拷贝的
 *     `public/ws3d/ws3dgl/three/character.mjs`（用户钦定的 2.5D 形态，原型本来就支持）；
 *   · **相机**：与 MapLibre **同一套针孔模型**（垂直视场角 0.6435011087932844 rad ≈ 36.87°，
 *     `dist = radius / tan(fov/2)`，`cameraToCenterDistance` 的原式）⇒ `center/zoom/bearing/pitch`
 *     是真双射，切过去像"同一视野换了个渲染器"，不是瞬移。
 *
 * ## 这一版**没有**的东西（照实写，别当成做好了）
 *   · 带洞的多边形**只画外环**（洞被填上）—— 差额在 `diag().holesDropped` 里如实报；
 *   · 没有描边/卡通染色/干净贴图/LOD/阴影/泛光（P2 的事，原型那套在 `ws3dgl/three/*` 里还在，
 *     但那一套是"按距离自己造城"，与"同一份数据"冲突 ⇒ 本轮不用它造城，只借它的立绘工厂）；
 *   · 没有命中 → 卡片（P3）；`centerPick()` 只服务于 P1 那条"中心那栋是同一栋"的判据。
 *
 * 依赖是**运行时**从 `public/` 取的（不打包进 App）：`three.min.js` 与 `character.mjs` 都用
 * 运行时拼出来的 URL 动态 import ⇒ 词法上 Vite 分析不到，产物里不会多出 664KB 的 three。
 *
 * ## `public/ws3d/ws3dgl/vendor/three.min.js` 是**裁剪过的构建**（只导出 117 个成员）
 * 2026-10-08 实测（靶场 `ws3dharness.html` 第一次喂真数据就炸）：
 *   · `Float32BufferAttribute` **没有**（只有 `BufferAttribute`）⇒ 原来建楼/建路那两句直接抛
 *     `is not a constructor`，表现是"三后端起来了但一栋楼都没有"；
 *   · `MeshLambertMaterial` **没有**（只有 `MeshBasicMaterial` / `MeshStandardMaterial` / `MeshToonMaterial`）
 *     ⇒ 桥面的明暗改成**建几何时按 Lambert 公式烘进顶点色**（配方见 `shadeOf`），
 *       于是顶面就是 `color3d` 原色、墙面按朝向变暗 —— 与 2D 的 `bld-ext` 同一个观感口径；
 *   · `Raycaster` **没有** ⇒ `centerPick()` 用自带的射线求交（`pickFeatureByRay`）。
 * ⇒ 以后往这个文件里加 three 用法之前，先对着 vendor 那份构建核一遍导出名单。
 */

import { renderHeight } from "./wsBuildingLook";
import { roadStyleOf } from "./wsRoads";
import { wsMapTheme } from "./wsMapTheme";
import {
  contractActors,
  contractTheme,
  ledgerMark,
  ledgerPush,
  metersPerPixelAt,
  saneRadius,
  zoomForMetersPerPixel,
  type WsRenderActor,
  type WsRenderBackend,
  type WsRenderFc,
  type WsRenderSelection,
  type WsRenderState,
  type WsRenderStats,
  type WsRenderWorld,
} from "./wsRenderBackend";
import { triangulateRing } from "./wsShapeTri";

/** three 的地址（**运行时拼**：见文件头最后一段） */
const THREE_PATH = "/ws3d/ws3dgl/vendor/three.min.js";
const CHAR_MOD_PATH = "/ws3d/ws3dgl/three/character.mjs";
/** 立绘根目录（原型 `character.mjs` 的 `assetsBase`） */
const ASSETS_BASE = "/ws3d/ws3dgl/assets/characters/";
/** MapLibre 的相机模型：垂直视场角（弧度）= 36.87°。写在这里是因为**两个后端必须同一个光学模型**，
 *  不然"切过去视野一样"就只是句口号。探针会实测投影残差（见 `centerPick` 与投影对拍那两条断言）。 */
const FOV_Y = 0.6435011087932844;
/** 每度多少米（球面近似，R = 6378137）：局部平面框架用，与 MapLibre 的"地面真米"同口径 */
const M_PER_DEG = 111319.49079327358;
/** 立绘名单（原型 `character.mjs` 的 `CHARACTERS` 顺序；名字对不上的角色用第 0 个的立绘） */
const CHAR_NAMES = ["DeepSeek", "诺一钦灵", "风雪"];
/** 一屏最多画几个立绘（每人一张 512 贴图；超了只画前 N 个并如实报出来） */
const ACTOR_CAP = 24;
/**
 * 一次最多画几栋楼（**离锚点最近的先画**）。
 * 为什么要有上限：`bld` 那份 source 是"取回来的一整批"（可能上万栋），而 three 这边是
 * 一坨合并几何 + 软件渲染时最贵的那条路。超出部分**如实报**（`diag.capped`），不静默丢。
 */
const BLD_CAP = 3500;
/** 近远裁剪面 */
const NEAR_M = 0.6;

export interface WsThreeDiag {
  buildings: number;
  /** 因为超过 `BLD_CAP` 而**没画**的栋数（0 = 全画了） */
  capped: number;
  tris: number;
  holesDropped: number;
  withColor3d: number;
  withH3d: number;
  fromReal: number;
  fromLevels: number;
  fromKind: number;
  roadSegs: number;
  roadRanks: number[];
  actors: number;
  actorsSkipped: number;
  /** 名字对不上原型那三张立绘、按序号轮换的人数（0 = 全都对上了） */
  artFallback: number;
  draws: number;
  frames: number;
  colorPick: { id: string; color: string; h3d: number; hBase: number } | null;
  errors: string[];
}

/** 能不能给出 WebGL2；能就给 `null`，不能就给**一句人话的原因**（要显示在 HUD 上） */
export function webgl2Reason(): string | null {
  if (typeof document === "undefined") return "没有 document（不在浏览器里）";
  let cv: HTMLCanvasElement | null = null;
  try {
    cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2");
    if (!gl) {
      const gl1 = cv.getContext("webgl");
      return gl1 ? "这台设备只有 WebGL1，没有 WebGL2" : "这台设备/浏览器不给 WebGL（可能禁用了硬件加速）";
    }
    return null;
  } catch (e) {
    return "取 WebGL2 上下文时抛错：" + String((e as Error)?.message || e);
  } finally {
    /* 探测用的上下文**两个都要还回去**：只还 webgl2 的话，"只有 WebGL1"那条路上
       每探一次就白占一个 WebGL1 上下文（无头环境实测：上下文是稀缺资源）。 */
    try {
      const g2 = cv?.getContext("webgl2") as WebGL2RenderingContext | null;
      const g1 = g2 || (cv?.getContext("webgl") as WebGLRenderingContext | null);
      (g1 as { getExtension?: (n: string) => { loseContext?: () => void } | null } | null)
        ?.getExtension?.("WEBGL_lose_context")
        ?.loseContext?.();
    } catch {
      /* 释放不掉也无所谓：它只是个探测用的画布 */
    }
  }
}

/** 局部平面框架（等距圆柱近似）：锚点是**交接那一刻的中心**，之后相机在框架里动，几何不动 */
interface Frame {
  lat0: number;
  lng0: number;
  cos0: number;
}
function frameOf(c: { lat: number; lng: number }): Frame {
  return { lat0: c.lat, lng0: c.lng, cos0: Math.cos((c.lat * Math.PI) / 180) };
}
/** 经纬度 → 局部米（x = 东，z = 南；**y 向上**，与 three 一致） */
function toLocal(f: Frame, lng: number, lat: number): [number, number] {
  return [(lng - f.lng0) * M_PER_DEG * f.cos0, (f.lat0 - lat) * M_PER_DEG];
}
/** 局部米 → 经纬度（`toLocal` 的反函数） */
function toLatLng(f: Frame, x: number, z: number): [number, number] {
  return [f.lng0 + x / (M_PER_DEG * f.cos0), f.lat0 - z / M_PER_DEG];
}

/** 主题色阶取色（`color3d` 缺席时的兜底：与 2D 那条 `ramp` 表达式同一个停靠点表） */
function rampHexAt(themeId: string, h: number): string {
  const th = wsMapTheme(themeId) as unknown as { ramp?: Array<[number, string]> };
  const stops = Array.isArray(th.ramp) ? th.ramp : [];
  if (!stops.length) return "#cccccc";
  if (h <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (h <= b[0]) {
      const t = (h - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return mixHexStr(a[1], b[1], t);
    }
  }
  return stops[stops.length - 1]![1];
}
function hexToRgb(hex: string): [number, number, number] {
  const s = String(hex || "").trim().replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const n = Number.parseInt(v.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0.8, 0.8, 0.8];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mixHexStr(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((x, i) => Math.round((x + (cb[i]! - x) * t) * 255));
  return "#" + c.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

/* ── 烘进顶点色的 Lambert（**这个 three 构建没有 MeshLambertMaterial**，见文件头）────────
 * 原来场景里是 `AmbientLight(0.62)` + `DirectionalLight(0.38)` 打在 Lambert 材质上；
 * 现在同一套系数在**建几何时**算进顶点色，材质退成 `MeshBasicMaterial`（不受光）。
 * · 顶面：系数取 **1.0** ⇒ 屋顶颜色就是 `color3d` 原色（与 2D 的 `bld-ext` 逐位一致）；
 * · 墙面：按水平法线吃一次 Lambert（0.62 + 0.38 × max(0, n·L̂)）。 */
const AMBIENT_K = 0.62;
const SUN_K = 0.38;
const SUN_DIR: readonly [number, number, number] = (() => {
  const v: [number, number, number] = [0.35, 1, 0.36];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
})();
/** 某个朝向的漫反射系数（顶面由调用方直接给 1.0） */
function shadeOf(nx: number, ny: number, nz: number): number {
  const d = nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2];
  return AMBIENT_K + SUN_K * Math.max(0, d);
}
/** 把环坐标（可能嵌套）读成 [lng,lat] 数组 */
function ringPts(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Array.isArray(p)) continue;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
  }
  return out;
}

/** 一个（Multi）Polygon 的**外环**列表（洞本轮不画，只计数） */
function outerRingsOf(geom: unknown): { rings: Array<Array<[number, number]>>; holes: number } {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  const rings: Array<Array<[number, number]>> = [];
  let holes = 0;
  if (!g) return { rings, holes };
  if (g.type === "Polygon") {
    const cs = g.coordinates as unknown[];
    if (Array.isArray(cs) && cs.length) {
      rings.push(ringPts(cs[0]));
      holes += Math.max(0, cs.length - 1);
    }
  } else if (g.type === "MultiPolygon") {
    const cs = g.coordinates as unknown[];
    for (const poly of Array.isArray(cs) ? cs : []) {
      const arr = poly as unknown[];
      if (!Array.isArray(arr) || !arr.length) continue;
      rings.push(ringPts(arr[0]));
      holes += Math.max(0, arr.length - 1);
    }
  }
  return { rings, holes };
}

/** 线要素 → 一串折线（LineString / MultiLineString） */
function linesOf(geom: unknown): Array<Array<[number, number]>> {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  if (!g) return [];
  if (g.type === "LineString") return [ringPts(g.coordinates)];
  if (g.type === "MultiLineString") {
    const cs = g.coordinates as unknown[];
    return (Array.isArray(cs) ? cs : []).map((l) => ringPts(l)).filter((l) => l.length >= 2);
  }
  return [];
}

/**
 * 造 three 后端。
 * 模块加载与 WebGL2 探测都在 `init` 里做（不在工厂里做）—— 工厂必须同步返回，
 *    失败要走"抛错 ⇒ 舞台回退"那条路，而不是在 import 期把整个页面带崩。
 */
export function createThreeBackend(): WsRenderBackend {
  let THREE: Record<string, any> | null = null;
  let renderer: any = null;
  let scene: any = null;
  let camera: any = null;
  let host: HTMLElement | null = null;
  let frame: Frame | null = null;
  let bldMesh: any = null;
  let roadMesh: any = null;
  let charMod: any = null;
  const avatars: Array<{ obj: any; actor: WsRenderActor; ch: any }> = [];
  let curActors: WsRenderActor[] = [];
  let curWorld: WsRenderWorld | null = null;
  let curState: WsRenderState | null = null;
  let lastMpp = 0;
  let state: "created" | "running" | "paused" | "destroyed" | "failed" = "created";
  let instance = 0;
  let frames = 0;
  let fps = 0;
  let fpsAt = 0;
  let fpsFrames = 0;
  let lastDt = 0;
  /** 三角形 → 要素下标（`centerPick` 用：命中第几个三角就知道是哪栋楼） */
  let triFeature: Int32Array = new Int32Array(0);
  /** 每个要素的 XZ 包围盒 `[minX,minZ,maxX,maxZ]`（射线求交先过它，见 `pickFeatureByRay`） */
  let featAabb = new Float32Array(0);
  let featureIds: string[] = [];
  let featureMeta: Array<{ color: string; h3d: number; hBase: number }> = [];
  const diag: WsThreeDiag = {
    buildings: 0, capped: 0, tris: 0, holesDropped: 0, withColor3d: 0, withH3d: 0,
    fromReal: 0, fromLevels: 0, fromKind: 0,
    roadSegs: 0, roadRanks: [], actors: 0, actorsSkipped: 0, artFallback: 0,
    draws: 0, frames: 0, colorPick: null, errors: [],
  };

  /** 运行时 URL（**故意**不让打包器静态分析到：见文件头最后一段） */
  const runtimeUrl = (path: string): string =>
    new URL(path, typeof location !== "undefined" ? location.href : "http://127.0.0.1/").href;

  /** `Float32BufferAttribute` 在这个 three 构建里不存在 ⇒ 自己按 `BufferAttribute` 造一个 */
  function attr3(arr: number[]): unknown {
    return new THREE!.BufferAttribute(new Float32Array(arr), 3);
  }

  function sizeOf(): { w: number; h: number } {
    const w = host?.clientWidth || host?.getBoundingClientRect().width || 800;
    const h = host?.clientHeight || host?.getBoundingClientRect().height || 600;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  /* ── 相机：与 MapLibre 同一套模型（正解 + 反解，见文件头） ─────────────────── */
  function applyCameraToThree(s: WsRenderState): void {
    if (!camera || !frame) return;
    const { h } = sizeOf();
    const radius = saneRadius(s.radius);
    const mpp = (2 * radius) / h;
    const dist = radius / Math.tan(FOV_Y / 2);
    const b = (s.bearing * Math.PI) / 180;
    const p = (Math.max(0, Math.min(88, s.pitch)) * Math.PI) / 180;
    const [cx, cz] = toLocal(frame, s.center.lng, s.center.lat);
    const fx = Math.sin(b);
    const fz = -Math.cos(b);                      // 地面上的朝向（bearing 0 = 正北 = -z）
    const dx = fx * Math.sin(p);
    const dz = fz * Math.sin(p);
    const dy = -Math.cos(p);                      // pitch 0 ⇒ 垂直向下看
    const px = cx - dx * dist;
    const py = -dy * dist;
    const pz = cz - dz * dist;
    /* 相机基（**显式给**，不用 `lookAt`：pitch=0 时 up×forward 退化，three 会自己加个 1e-4 的扰动，
       那个扰动决定"屏幕上方是哪边"—— 靠它就等于靠实现细节。这里 x 轴恒为水平、指向屏幕右方。） */
    const zx = -dx, zy = -dy, zz = -dz;           // 相机 +Z = 从目标指向相机
    const xx = Math.cos(b), xy = 0, xz = Math.sin(b);
    // y = z × x
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(xx, xy, xz),
      new THREE!.Vector3(yx, yy, yz),
      new THREE!.Vector3(zx, zy, zz)
    );
    camera.quaternion.setFromRotationMatrix(m);
    camera.position.set(px, py, pz);
    camera.near = Math.max(NEAR_M, dist / 900);
    camera.far = Math.max(4000, dist * 24 + radius * 8);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    lastMpp = mpp;
  }

  /** 反解：three 相机 → 契约（`applyCameraToThree` 的逆） */
  function cameraToView(): { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null {
    if (!camera || !frame) return null;
    const e = camera.matrixWorld.elements;
    const zx = e[8]!, zy = e[9]!, zz = e[10]!;    // 相机 +Z（世界）
    const xx = e[0]!, xz = e[2]!;                 // 相机 +X（世界，恒水平）
    const { h } = sizeOf();
    const y = camera.position.y;
    /* 屏幕中心那条射线打到地面的参数：pos + (-Z) * t，y 分量为 0 ⇒ t = y / zy */
    const t = Math.abs(zy) > 1e-9 ? y / zy : 0;
    const gx = camera.position.x - zx * t;
    const gz = camera.position.z - zz * t;
    const dist = Math.hypot(camera.position.x - gx, y, camera.position.z - gz);
    const radius = saneRadius(dist * Math.tan(FOV_Y / 2));
    const [lng, lat] = toLatLng(frame, gx, gz);
    const bearing = (Math.atan2(xz, xx) * 180) / Math.PI;
    const pitch = (Math.acos(Math.max(-1, Math.min(1, zy))) * 180) / Math.PI;
    void h;
    return { center: { lat, lng }, radius, bearing, pitch };
  }

  function disposeMesh(m: any): void {
    if (!m) return;
    try {
      scene?.remove(m);
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat?.dispose?.();
    } catch {
      /* 释放失败不影响后续（它已经不在场景里了） */
    }
  }

  /* ── 楼：从 `bld` 那份 GeoJSON 挤出（颜色/高度全取要素自带的字段） ───────────── */
  function buildBuildings(fc: WsRenderFc | null, themeId: string): void {
    disposeMesh(bldMesh);
    bldMesh = null;
    diag.buildings = 0;
    diag.capped = 0;
    diag.tris = 0;
    diag.holesDropped = 0;
    diag.withColor3d = 0;
    diag.withH3d = 0;
    diag.fromReal = 0;
    diag.fromLevels = 0;
    diag.fromKind = 0;
    triFeature = new Int32Array(0);
    featAabb = new Float32Array(0);
    featureIds = [];
    featureMeta = [];
    if (!THREE || !scene || !frame || !fc) return;

    const pos: number[] = [];
    const col: number[] = [];
    const triTo: number[] = [];
    const featBox: number[] = [];
    /* 超过上限时**先画离锚点最近的**（近处的楼才是用户真正在看的那一批）。
       排序用要素自己的第一个坐标当代表点 —— 精确到米没必要，这只是"先画谁"的取舍。 */
    let list = fc.features;
    if (list.length > BLD_CAP) {
      const keyed = list.map((f, i) => {
        const g = (f as { geometry?: unknown }).geometry;
        const { rings } = outerRingsOf(g);
        const p0 = rings[0]?.[0];
        const d = p0 && frame ? Math.hypot(...toLocal(frame, p0[0], p0[1])) : Number.POSITIVE_INFINITY;
        return { f, i, d };
      });
      keyed.sort((a, b) => a.d - b.d);
      diag.capped = keyed.length - BLD_CAP;
      list = keyed.slice(0, BLD_CAP).map((k) => k.f);
    }
    for (const raw of list) {
      const f = raw as { id?: unknown; properties?: Record<string, unknown>; geometry?: unknown };
      const props = f.properties || {};
      const { rings, holes } = outerRingsOf(f.geometry);
      if (!rings.length) continue;
      diag.holesDropped += holes;
      const h3dRaw = Number(props.h3d);
      const rh = renderHeight(props);                    // ← 与 2D **同一个函数**
      const top = Number.isFinite(h3dRaw) && h3dRaw > 0 ? h3dRaw : rh.h;
      const baseRaw = Number(props.h_base ?? props.min_height ?? 0);
      const base = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.min(baseRaw, top - 0.4) : 0;
      if (!(top - base >= 0.4)) continue;
      if (Number.isFinite(h3dRaw) && h3dRaw > 0) diag.withH3d++;
      if (typeof props.color3d === "string" && props.color3d) diag.withColor3d++;
      if (rh.from === "real") diag.fromReal++;
      else if (rh.from === "levels") diag.fromLevels++;
      else diag.fromKind++;
      const hex = typeof props.color3d === "string" && props.color3d ? props.color3d : rampHexAt(themeId, top);
      const rgb = hexToRgb(hex);
      const fi = featureIds.length;
      featureIds.push(String(f.id ?? ""));
      featureMeta.push({ color: hex, h3d: top, hBase: base });
      let added = false;
      const box = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      const grow = (x: number, z: number): void => {
        if (x < box[0]) box[0] = x;
        if (z < box[1]) box[1] = z;
        if (x > box[2]) box[2] = x;
        if (z > box[3]) box[3] = z;
      };
      for (const ring of rings) {
        if (ring.length < 3) continue;
        const pts = ring.map(([lng, lat]) => toLocal(frame!, lng, lat));
        for (const p of pts) grow(p[0], p[1]);
        const tris = triangulateRing(pts);
        if (!tris.length) continue;
        added = true;
        /* 顶盖（法线朝上：算一下叉积，朝下就换序，绝不靠"输入一定是逆时针"） */
        for (let i = 0; i < tris.length; i += 3) {
          const a = pts[tris[i]!]!;
          const b = pts[tris[i + 1]!]!;
          const c = pts[tris[i + 2]!]!;
          const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const q = up >= 0 ? [a, b, c] : [a, c, b];
          for (const p of q) {
            pos.push(p[0], top, p[1]);
            col.push(rgb[0], rgb[1], rgb[2]);
          }
          triTo.push(fi, fi, fi);
        }
        /* 墙：每条边一个四边形（不做背面剔除的取舍 —— 材质用 DoubleSide，朝向错了也看得见） */
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[(i + 1) % pts.length]!;
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const quad = [
            [a[0], base, a[1]], [b[0], base, b[1]], [b[0], top, b[1]],
            [a[0], base, a[1]], [b[0], top, b[1]], [a[0], top, a[1]],
          ];
          /* 墙面法线 = 这条边在水平面里转 90°（朝外那一侧由叉积定；DoubleSide 下无所谓正负，
             只要"同一个朝向拿到同一个系数"） */
          const ex = b[0] - a[0];
          const ez = b[1] - a[1];
          const el = Math.hypot(ex, ez) || 1;
          const k = shadeOf(-ez / el, 0, ex / el);
          const wr = rgb[0] * k;
          const wg = rgb[1] * k;
          const wb = rgb[2] * k;
          for (const p of quad) {
            pos.push(p[0]!, p[1]!, p[2]!);
            col.push(wr, wg, wb);
          }
          triTo.push(fi, fi);
        }
      }
      if (added) {
        diag.buildings++;
        featBox.push(box[0], box[1], box[2], box[3]);
      } else {
        /* 没画成的那一栋要**从名单里退掉**，否则 `centerPick` 会指到一栋画不出来的楼上 */
        featureIds.pop();
        featureMeta.pop();
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", attr3(pos));
    g.setAttribute("color", attr3(col));
    g.computeVertexNormals();
    /* 材质不受光：明暗已经在顶点色里（见 `shadeOf` 那一段的说明） */
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    bldMesh = new THREE.Mesh(g, mat);
    bldMesh.name = "ws-buildings";
    scene.add(bldMesh);
    triFeature = Int32Array.from(triTo);
    featAabb = Float32Array.from(featBox);
    diag.tris = triFeature.length;
  }

  /* ── 路：ribbon（宽度按当前 mpp 换算成米——与 2D 的"像素宽"同一个观感） ──────── */
  function buildRoads(fc: WsRenderFc | null, themeId: string, mpp: number): void {
    disposeMesh(roadMesh);
    roadMesh = null;
    diag.roadSegs = 0;
    diag.roadRanks = [];
    if (!THREE || !scene || !frame || !fc) return;
    const th = wsMapTheme(themeId) as unknown as { road?: { casing?: string; rankColors?: Record<string, string> } };
    const casing = th.road?.casing || "#0b1017";
    const ranks = new Set<number>();
    const pos: number[] = [];
    const col: number[] = [];
    const push = (x: number, z: number, y: number, c: [number, number, number]): void => {
      pos.push(x, y, z);
      col.push(c[0], c[1], c[2]);
    };
    const ribbon = (pts: Array<[number, number]>, halfW: number, y: number, c: [number, number, number]): number => {
      let segs = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const vx = b[0] - a[0];
        const vz = b[1] - a[1];
        const len = Math.hypot(vx, vz);
        if (len < 0.5) continue;
        const nx = (-vz / len) * halfW;
        const nz = (vx / len) * halfW;
        const p1: [number, number] = [a[0] + nx, a[1] + nz];
        const p2: [number, number] = [b[0] + nx, b[1] + nz];
        const p3: [number, number] = [b[0] - nx, b[1] - nz];
        const p4: [number, number] = [a[0] - nx, a[1] - nz];
        push(p1[0], p1[1], y, c);
        push(p2[0], p2[1], y, c);
        push(p3[0], p3[1], y, c);
        push(p1[0], p1[1], y, c);
        push(p3[0], p3[1], y, c);
        push(p4[0], p4[1], y, c);
        segs++;
      }
      return segs;
    };
    const casingRgb = hexToRgb(casing);
    const firstPts: Array<{ pts: Array<[number, number]>; half: number; core: [number, number, number] }> = [];
    for (const raw of fc.features) {
      const f = raw as { properties?: Record<string, unknown>; geometry?: unknown };
      const props = f.properties || {};
      const rank = Number(props.rank);
      const st = roadStyleOf(rank);
      ranks.add(Number.isFinite(rank) ? rank : 3);
      const core = hexToRgb(th.road?.rankColors?.[String(Number.isFinite(rank) ? rank : 3)] || st.color);
      for (const line of linesOf(f.geometry)) {
        firstPts.push({ pts: line.map(([lng, lat]) => toLocal(frame!, lng, lat)), half: (st.w * mpp) / 2, core });
      }
    }
    /* 先铺所有底色（宽 1.6px），再铺所有路芯 —— 与 2D 的"两层：casing 在下、line 在上"同一个做法 */
    for (const r of firstPts) diag.roadSegs += ribbon(r.pts, Math.max(0.25, r.half + (1.6 * mpp) / 2), 0.06, casingRgb);
    for (const r of firstPts) ribbon(r.pts, Math.max(0.2, r.half), 0.12, r.core);
    diag.roadRanks = Array.from(ranks).sort((a, b) => a - b);
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", attr3(pos));
    g.setAttribute("color", attr3(col));
    g.computeVertexNormals();
    roadMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    roadMesh.name = "ws-roads";
    scene.add(roadMesh);
  }

  /* ── 角色：2D 立绘 billboard（**原型的工厂**，一行都不重写） ─────────────────── */
  async function rebuildActors(actors: readonly WsRenderActor[]): Promise<void> {
    curActors = actors.map((a) => ({ ...a }));
    for (const av of avatars) {
      try {
        scene?.remove(av.obj);
        av.ch?.dispose?.();
      } catch {
        /* 放不掉就算了 */
      }
    }
    avatars.length = 0;
    diag.actors = 0;
    diag.artFallback = 0;
    diag.actorsSkipped = Math.max(0, actors.length - ACTOR_CAP);
    if (!actors.length || !scene || !frame) return;
    try {
      if (!charMod) charMod = await import(/* @vite-ignore */ runtimeUrl(CHAR_MOD_PATH));
    } catch (e) {
      diag.errors.push("立绘模块加载失败：" + String((e as Error)?.message || e));
      return;
    }
    for (const a of actors.slice(0, ACTOR_CAP)) {
      try {
        /* 立绘选哪一张：名字对得上就用原型里那一位；对不上**按名单序号轮换**，
           而不是 `Math.max(0, indexOf)` —— 那个写法会让所有对不上名字的人**都变成第 0 个**
           （四个角色长得一模一样，且不报错，2026-10-08 读代码时发现）。 */
        const known = CHAR_NAMES.indexOf(a.name);
        const idx = known >= 0 ? known : diag.actors % CHAR_NAMES.length;
        if (known < 0) diag.artFallback++;
        const ch = charMod.createCharacter({ kind: "billboard", assetsBase: ASSETS_BASE, index: idx });
        const [x, z] = toLocal(frame, a.lng, a.lat);
        ch.object3D.position.set(x, 0, z);
        scene.add(ch.object3D);
        avatars.push({ obj: ch.object3D, actor: a, ch });
        diag.actors++;
      } catch (e) {
        diag.errors.push("立绘建不出来：" + String((e as Error)?.message || e));
      }
    }
  }

  function tick(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const now = performance.now();
    const dt = lastDt ? Math.min(0.1, (now - lastDt) / 1000) : 0.016;
    lastDt = now;
    frames++;
    fpsFrames++;
    if (!fpsAt) fpsAt = now;
    if (now - fpsAt >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsFrames = 0;
    }
    for (const av of avatars) {
      try {
        av.ch.update(dt, {
          pos: { x: av.obj.position.x, z: av.obj.position.z },
          heading: ((av.actor.heading || 0) * Math.PI) / 180,
          speed: 0,
          moving: false,
          third: true,
          camPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          sunDir: [0.35, 0.86, 0.36],
          groundY: 0,
        });
      } catch {
        /* 单个人更新失败不该停整帧 */
      }
    }
    renderer.render(scene, camera);
    diag.draws = renderer.info?.render?.calls ?? 0;
    diag.frames = frames;
  }

  function onResize(): void {
    if (!renderer || !host) return;
    const { w, h } = sizeOf();
    renderer.setSize(w, h, false);
    /* 画布尺寸变了 ⇒ mpp 跟着变 ⇒ 路宽（米）要重算，不然路的粗细会漂 */
    if (curState) {
      applyCameraToThree(curState);
      if (curWorld && Math.abs(lastMpp - refMpp) / Math.max(1e-6, refMpp) > 0.2) {
        buildRoads(curWorld.roads, curWorld.themeId, lastMpp);
        refMpp = lastMpp;
      }
    }
  }
  let refMpp = 0;

  /**
   * 把这一摊**拆干净**（`destroy()` 与"起不来的半成品"共用同一份）。
   *
   * 为什么"起不来"也要走这里：`init` 是**先 append 画布、再建渲染器**的顺序，
   *    渲染器建不起来时那块画布会留在宿主里。舞台失败回退后虽然会把整个宿主 div 摘掉，
   *    但那条路依赖 Vue 的下一次渲染 —— 判据（"任何时刻舞台上只有一个后端画布"）不该
   *    建立在"别人等会儿会收拾"上面。起不来就当场拆掉。
   */
  function teardownAll(): void {
    try {
      renderer?.setAnimationLoop?.(null);
    } catch {
      /* ignore */
    }
    window.removeEventListener("resize", onResize);
    for (const av of avatars) {
      try {
        av.ch?.dispose?.();
      } catch {
        /* ignore */
      }
    }
    avatars.length = 0;
    disposeMesh(bldMesh);
    disposeMesh(roadMesh);
    bldMesh = null;
    roadMesh = null;
    try {
      renderer?.dispose?.();
      /* 显式丢上下文：Android WebView 上"两个上下文互相挤"是已知风险（§3），
         能做的那一半就是**走的时候立刻放掉**。
         先问一句扩展在不在：软件栈（SwiftShader）上 `WEBGL_lose_context` 可能根本没有，
         那时 three 的 `forceContextLoss()` 会往控制台打一条 warning —— 而"控制台 0 error/warn"
         是一条硬判据（靶场实测：软件栈上少了这一步就会多一条 warning）。拿不到就只 dispose。 */
      const gl = (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null;
      const lose = gl?.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null;
      if (lose?.loseContext) lose.loseContext();
    } catch {
      /* ignore */
    }
    try {
      renderer?.domElement?.remove?.();
    } catch {
      /* ignore */
    }
    renderer = null;
    scene = null;
    camera = null;
    host = null;
  }

  /**
   * 屏幕坐标（NDC）→ 命中的要素下标 + 命中点（局部米坐标 `[x, y, z]`）。
   *
   * 为什么自己写：这个 three 构建**没有 `Raycaster`**。做法是最朴素的 Möller–Trumbore：
   *   · 射线起点 = 相机位置，方向 = `Vector3(ndcX, ndcY, 0.5).unproject(camera)` 归一化
   *     （与 three 的 `Raycaster.setFromCamera` 同一个式子）；
   *   · 先用每个要素的 XZ 包围盒做一次 slab 测试把绝大多数三角形筛掉；
   *   · 命中的取**最近**那个三角形 ⇒ "屏幕上那一点最前面是哪栋楼"。
   */
  function pickFeatureByRay(ndcX: number, ndcY: number): { fi: number; point: [number, number, number] } | null {
    if (!THREE || !camera || !bldMesh) return null;
    const geo = bldMesh.geometry as { getAttribute?: (n: string) => { array?: ArrayLike<number> } | undefined };
    const pa = geo?.getAttribute?.("position")?.array;
    if (!pa || !triFeature.length) return null;
    const tip = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
    const ox = camera.position.x;
    const oy = camera.position.y;
    const oz = camera.position.z;
    let dx = tip.x - ox;
    let dy = tip.y - oy;
    let dz = tip.z - oz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    let best = Number.POSITIVE_INFINITY;
    let bestFi = -1;
    const nFeat = featAabb.length / 4;
    for (let fi = 0; fi < nFeat; fi++) {
      /* 包围盒预筛（slab 法，只看 XZ；相机在高处俯视时射线在 XZ 上的投影一定有长度） */
      const minX = featAabb[fi * 4]!;
      const minZ = featAabb[fi * 4 + 1]!;
      const maxX = featAabb[fi * 4 + 2]!;
      const maxZ = featAabb[fi * 4 + 3]!;
      let t0 = Number.NEGATIVE_INFINITY;
      let t1 = Number.POSITIVE_INFINITY;
      let miss = Math.abs(dx) < 1e-9;
      if (!miss) {
        const ta = (minX - ox) / dx;
        const tb = (maxX - ox) / dx;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      } else if (ox < minX || ox > maxX) continue;
      miss = Math.abs(dz) < 1e-9;
      if (!miss) {
        const ta = (minZ - oz) / dz;
        const tb = (maxZ - oz) / dz;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      } else if (oz < minZ || oz > maxZ) continue;
      if (t1 < Math.max(0, t0) || t1 < 0) continue;
      if (t0 > best) continue;                       // 已经在更近的命中后面了，别再算三角形
      /* 这个要素的三角形区间：`triFeature` 是逐三角形的要素下标（顶盖 3 个一组、墙 2 个一组） */
      for (let tri = 0; tri * 3 + 2 < triFeature.length; tri++) {
        if (triFeature[tri * 3] !== fi) continue;
        const i0 = tri * 9;
        if (i0 + 8 >= pa.length) break;
        const ax = pa[i0]!;
        const ay = pa[i0 + 1]!;
        const az = pa[i0 + 2]!;
        const e1x = pa[i0 + 3]! - ax;
        const e1y = pa[i0 + 4]! - ay;
        const e1z = pa[i0 + 5]! - az;
        const e2x = pa[i0 + 6]! - ax;
        const e2y = pa[i0 + 7]! - ay;
        const e2z = pa[i0 + 8]! - az;
        /* Möller–Trumbore */
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - ax;
        const ty = oy - ay;
        const tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-4 && t < best) {
          best = t;
          bestFi = fi;
        }
      }
    }
    if (bestFi < 0 || !Number.isFinite(best)) return null;
    return { fi: bestFi, point: [ox + dx * best, oy + dy * best, oz + dz * best] };
  }

  return {
    id: "three",

    async init(h: HTMLElement, s: WsRenderState, world: WsRenderWorld | null): Promise<void> {
      host = h;
      instance = ledgerPush("three", "created");
      state = "created";
      const why = webgl2Reason();
      if (why) {
        diag.errors.push(why);
        state = "failed";
        ledgerMark(instance, "failed", why);
        throw new Error(why);
      }
      try {
        THREE = (await import(/* @vite-ignore */ runtimeUrl(THREE_PATH))) as Record<string, any>;
      } catch (e) {
        const msg = "three 本体加载失败（" + THREE_PATH + "）：" + String((e as Error)?.message || e);
        diag.errors.push(msg);
        state = "failed";
        ledgerMark(instance, "failed", msg);
        throw new Error(msg);
      }
      const { w, h: hh } = sizeOf();
      const canvas = document.createElement("canvas");
      canvas.className = "ws-three-canvas";
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
      host.appendChild(canvas);
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
      } catch (e) {
        /* 建不起来就把画布当场摘掉（不留半死的后端画布），再抛给舞台走"失败即回退" */
        try {
          canvas.remove();
        } catch {
          /* 摘不掉也不影响后面的回退 */
        }
        const msg = "three 建渲染器失败（拿不到可用的 WebGL 上下文）：" + String((e as Error)?.message || e);
        diag.errors.push(msg);
        state = "failed";
        ledgerMark(instance, "failed", msg);
        throw new Error(msg);
      }
      renderer.setPixelRatio(Math.min(3, window.devicePixelRatio || 1));
      renderer.setSize(w, hh, false);
      const th = wsMapTheme(s.theme) as unknown as { canvas?: { bg?: string } };
      scene = new THREE.Scene();
      scene.background = new THREE.Color(th.canvas?.bg || "#0a1018");
      camera = new THREE.PerspectiveCamera((FOV_Y * 180) / Math.PI, w / hh, NEAR_M, 8000);
      /* 这里**不放灯**：明暗在 `buildBuildings` 里按同一套 Lambert 系数烘进顶点色了
         （这个 three 构建没有 `MeshLambertMaterial`，见文件头那一段）。 */
      frame = frameOf(s.center);
      curState = s;
      curWorld = world;
      try {
        if (world) {
          buildBuildings(world.buildings, world.themeId || s.theme);
          buildRoads(world.roads, world.themeId || s.theme, (2 * saneRadius(s.radius)) / hh);
          refMpp = lastMpp;
        }
        applyCameraToThree(s);
        await rebuildActors(contractActors.value.length ? contractActors.value : s.actors);
      } catch (e) {
        /* 后半段（建楼/建路/立绘）中途抛错也要**拆干净再抛**，不然舞台上留一个半死的 3D */
        const msg = "three 初始化中途失败：" + String((e as Error)?.message || e);
        diag.errors.push(msg);
        teardownAll();
        state = "failed";
        ledgerMark(instance, "failed", msg);
        throw new Error(msg);
      }
      window.addEventListener("resize", onResize);
      renderer.setAnimationLoop(tick);
      state = "running";
      ledgerMark(instance, "running");
    },

    applyView(s: WsRenderState): void {
      curState = s;
      if (!renderer) return;
      if (s.theme && curWorld && s.theme !== curWorld.themeId) {
        /* 主题变了 ⇒ 背景与楼色都要跟着变（楼色来自要素自带的 color3d，而那份数据是**上一个主题**
           打扮出来的 ⇒ 只能如实说"要重新捞一份数据才对得上"，不在这里硬改颜色冒充）。 */
        diag.errors.push(`主题已切到 ${s.theme}，但手上这份楼数据是 ${curWorld.themeId} 打的 ⇒ 需要重取`);
      }
      applyCameraToThree(s);
      if (curWorld && Math.abs(lastMpp - refMpp) / Math.max(1e-6, refMpp) > 0.35) {
        buildRoads(curWorld.roads, curWorld.themeId, lastMpp);
        refMpp = lastMpp;
      }
    },

    readView(): WsRenderState | null {
      const v = cameraToView();
      const th = contractTheme.value;
      if (!v) return curState;
      return {
        center: v.center,
        radius: v.radius,
        bearing: v.bearing,
        pitch: v.pitch,
        theme: curWorld?.themeId || th.theme,
        timeOfDay: th.timeOfDay,
        clock: th.clock,
        actors: curActors.map((a) => ({ ...a })),
        selection: null,
      };
    },

    setTheme(theme: string, timeOfDay: number): void {
      if (!THREE || !scene) return;
      const th = wsMapTheme(theme) as unknown as { canvas?: { bg?: string } };
      try {
        scene.background = new THREE.Color(th.canvas?.bg || "#0a1018");
      } catch {
        /* 颜色给不出来就不动背景 */
      }
      void timeOfDay;
    },

    setActors(actors: readonly WsRenderActor[]): void {
      void rebuildActors(actors);
    },

    setSelection(sel: WsRenderSelection | null): void {
      void sel;   // P1 只搬运；3D 的命中与卡片是 P3
    },

    async captureWorld(): Promise<WsRenderWorld | null> {
      return curWorld;
    },

    pause(): void {
      try {
        renderer?.setAnimationLoop(null);
      } catch {
        /* 停不掉也要往下走（下一步就是销毁） */
      }
      state = "paused";
      ledgerMark(instance, "paused");
    },

    resume(): void {
      if (!renderer) return;
      lastDt = 0;
      renderer.setAnimationLoop(tick);
      state = "running";
      ledgerMark(instance, "running");
    },

    destroy(): void {
      teardownAll();
      state = "destroyed";
      ledgerMark(instance, "destroyed");
    },

    stats(): WsRenderStats {
      return {
        backend: "three",
        draws: diag.draws,
        dpr: renderer?.getPixelRatio?.() ?? 1,
        fps: Math.round(fps * 10) / 10,
        rendering: state === "running",
        note: `${diag.buildings} 栋${diag.capped ? `（另有 ${diag.capped} 栋超上限未画）` : ""} / ${diag.tris} 三角 / 路 ${diag.roadSegs} 段 / 立绘 ${diag.actors}${diag.holesDropped ? ` / 洞未画 ${diag.holesDropped}` : ""}`,
      };
    },

    /**
     * 屏幕正中那栋楼：沿屏幕上那一圈（与 2D **同一套环**，见 `WS_CENTER_RING`）打射线，
     * 命中三角形的下标 → 要素下标 → 那份 GeoJSON 里的 `id`。两条引擎各自独立算，比出来相同才算数。
     *
     * 这个 three 构建里**没有 `Raycaster`**（见文件头）⇒ 用自带的 `pickFeatureByRay`
     *    （Möller–Trumbore + 每要素 XZ 包围盒预筛），公式与 `Raycaster.setFromCamera` 同一套。
     */
    centerPick(): { kind: "bld"; id: string; lng: number; lat: number } | null {
      if (!THREE || !camera || !bldMesh || !frame) return null;
      const { w, h } = sizeOf();
      const ring: Array<[number, number]> = [[0, 0]];
      for (const r of [6, 12, 18]) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ring.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
      }
      for (const [dx, dy] of ring) {
        const ndcX = ((w / 2 + dx) / w) * 2 - 1;
        const ndcY = -(((h / 2 + dy) / h) * 2 - 1);
        let hit = null;
        try {
          hit = pickFeatureByRay(ndcX, ndcY);
        } catch {
          hit = null;
        }
        if (!hit) continue;
        const id = featureIds[hit.fi];
        if (!id) continue;
        const meta = featureMeta[hit.fi];
        diag.colorPick = meta ? { id, color: meta.color, h3d: meta.h3d, hBase: meta.hBase } : null;
        return { kind: "bld", id, lng: hit.point[0], lat: hit.point[2] };
      }
      diag.colorPick = null;
      return null;
    },

    /** 给探针看的原始读数（**不进契约**：契约里不许有引擎的东西） */
    diag(): WsThreeDiag {
      return JSON.parse(JSON.stringify(diag)) as WsThreeDiag;
    },
  } as WsRenderBackend & { diag(): WsThreeDiag };
}
