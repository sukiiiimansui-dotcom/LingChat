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

import { roadStyleOf } from "./wsRoads";
/* 相机模型（与 MapLibre 同一套针孔）也是共用件：叠加层那条路读地图相机，用的是**同一份**换算 */
import { FOV_Y, M_PER_DEG, NEAR_M, camFrameOf, farOf, nearOf } from "./wsThreeCam";
import { wsMapTheme } from "./wsMapTheme";
/* 楼的几何整块搬去了 `wsBldMesh.ts`（叠加层那条路要用**同一份**，见那个文件头）。
   这里只留"把它产出的扁平数组包成 three 的缓冲"这一步。 */
import { BLD_CAP, buildBldMeshData, hexToRgb, ringPts } from "./wsBldMesh";
import { modelFactsNow } from "./wsBldLod";
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
/** 立绘名单（原型 `character.mjs` 的 `CHARACTERS` 顺序；名字对不上的角色用第 0 个的立绘） */
const CHAR_NAMES = ["DeepSeek", "诺一钦灵", "风雪"];
/** 一屏最多画几个立绘（每人一张 512 贴图；超了只画前 N 个并如实报出来） */
const ACTOR_CAP = 24;

export interface WsThreeDiag {
  buildings: number;
  /** 因为超过 `BLD_CAP` 而**没画**的栋数（0 = 全画了） */
  capped: number;
  /** 三角形总数（= `triFeature.length`：一个三角形一个槽） */
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

/* ── 烘进顶点色的 Lambert（**这个 three 构建没有 MeshLambertMaterial**，见文件头）────────
 * 原来场景里是 `AmbientLight(0.62)` + `DirectionalLight(0.38)` 打在 Lambert 材质上；
 * 现在同一套系数在**建几何时**算进顶点色，材质退成 `MeshBasicMaterial`（不受光）。
 * · 顶面：系数取 **1.0** ⇒ 屋顶颜色就是 `color3d` 原色（与 2D 的 `bld-ext` 逐位一致）；
 * · 墙面：按水平法线吃一次 Lambert（0.62 + 0.38 × max(0, n·L̂)）。 */
/** 朝向归一到 [-180,180)（与 MapLibre 同口径） */
function normBearing(b: number): number {
  let x = ((b + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}
/** 俯仰夹到 [0,70] —— 上界与地图那边 `cameraDefaults().maxPitch` 同口径 */
function clampPitch(p: number): number {
  return Math.max(0, Math.min(70, Number.isFinite(p) ? p : 0));
}

/** 线要素 → 一串折线（LineString / MultiLineString）；`ringPts` 从 `wsBldMesh` 借（同一份实现） */
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
/** S6：把最近一次建模 facts 压成 HUD 一行（真机 note 里能直接读） */
function modelHudNote(): string {
  const mf = modelFactsNow() as {
    modeledBuildings?: number; massingParts?: number; parapetBands?: number;
    roofs?: number; roofDropped?: number; detailDropped?: number;
    lodTiers?: number[]; modelCpuMs?: number;
  } | null;
  if (!mf) return "";
  const tiers = Array.isArray(mf.lodTiers) ? mf.lodTiers.join("/") : "?";
  return ` / 建模 ${mf.modeledBuildings ?? 0} 栋 · 体块 ${mf.massingParts ?? 0} · 女儿墙 ${mf.parapetBands ?? 0} · 坡屋顶 ${mf.roofs ?? 0} · 屋顶丢 ${mf.roofDropped ?? 0} · 细节丢 ${mf.detailDropped ?? 0} · LOD ${tiers} · ${mf.modelCpuMs ?? 0}ms`;
}

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
  function attr3(arr: ArrayLike<number>): unknown {
    return new THREE!.BufferAttribute(Float32Array.from(arr), 3);
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
    const [cx, cz] = toLocal(frame, s.center.lng, s.center.lat);
    /* 相机模型（含"与 MapLibre 同一套针孔"那条式子）在 `wsThreeCam.ts`：叠加层那条路也用同一份，
       两份实现迟早漂成"两个引擎看到的不是同一眼"。 */
    const f = camFrameOf(cx, cz, radius, s.bearing, s.pitch);
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(f.xAxis[0], f.xAxis[1], f.xAxis[2]),
      new THREE!.Vector3(f.yAxis[0], f.yAxis[1], f.yAxis[2]),
      new THREE!.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2])
    );
    camera.quaternion.setFromRotationMatrix(m);
    camera.position.set(f.pos[0], f.pos[1], f.pos[2]);
    camera.near = nearOf(f.dist);
    camera.far = farOf(f.dist, radius);
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
    /* 几何在 `wsBldMesh.ts` 里算（纯函数、不认识 three）：投影口径由这里注入，
       于是叠加层那条路能拿**同一份**几何，不会出现"两个引擎各画一套楼"。 */
    const data = buildBldMeshData({
      features: fc.features,
      toLocal: (lng, lat) => toLocal(frame as Frame, lng, lat),
      themeId,
      cap: BLD_CAP,
      /* S5：three 这条路的相机帧已经算出真实 mpp（512px 瓦片口径），直接喂 LOD */
      lod: lastMpp > 0 ? { mpp: lastMpp } : undefined,
    });
    diag.buildings = data.stats.buildings;
    diag.capped = data.stats.capped;
    diag.holesDropped = data.stats.holesDropped;
    diag.withColor3d = data.stats.withColor3d;
    diag.withH3d = data.stats.withH3d;
    diag.fromReal = data.stats.fromReal;
    diag.fromLevels = data.stats.fromLevels;
    diag.fromKind = data.stats.fromKind;
    featureIds = data.featureIds;
    featureMeta = data.featureMeta;
    if (!data.triangles) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", attr3(data.positions));
    g.setAttribute("color", attr3(data.colors));
    g.computeVertexNormals();
    /* 材质不受光：明暗已经在顶点色里（见 `wsBldMesh.ts` 那段说明） */
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    bldMesh = new THREE.Mesh(g, mat);
    bldMesh.name = "ws-buildings";
    scene.add(bldMesh);
    triFeature = Int32Array.from(data.triFeature);
    featAabb = Float32Array.from(data.boxes);
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

  /** 交接那份数据里"路/楼是空的"就写出来（真机反馈过"只有楼、路大多数时候没有"） */
  function worldNote(): string {
    const c = curWorld?.counts;
    if (!c) return "";
    const parts: string[] = [];
    if (c.roads === 0) parts.push("交接时地图上还没有路网数据（路网是异步落图的）");
    if (c.buildings === 0) parts.push("交接时地图上还没有楼房数据");
    return parts.length ? ` / ⚠️ ${parts.join("；")}` : "";
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
    detachGestures();
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

  /* ══════════════════════════════════════════════════════════════════════════
   * 手势：输入 → 相机（"three 也能像地图一样拖"）
   * ══════════════════════════════════════════════════════════════════════════
   * 这一版给的是 MapLibre 那一套手感的**最小集**：
   *   · 单指拖 / 左键拖 = **平移**（按"拖起来的那块地"算，任何俯仰角都对得上）；
   *   · 滚轮 = **缩放**（**锚在光标下那块地**上，与地图同一种感觉）；
   *   · 双指 = 捏合缩放 + 扭转朝向 + 竖向拖改俯仰（同一手势里一起算）；
   *   · 右键拖 / Ctrl 拖 = 旋转 + 俯仰（桌面端那套）。
   * 每动一下就 `cameraToView()` 反解出契约四量、并**叫一声** `viewListener`
   * （舞台据此记下视野，切回地图时就是同一眼 —— 见 `wsRenderBackend.setViewListener`）。
   *
   * ⚠️ 手感参数（0.4°/px、轮子 0.0015）是**按地图那套数量级取的估计值**，真机手感只能真机判。
   */
  const pointers = new Map<number, { x: number; y: number }>();
  let viewListener: ((s: WsRenderState) => void) | null = null;
  /**
   * 上一次算过的指针几何（中点 / 两指距离 / 两指夹角）。
   *
   * 🔴 为什么是"增量 + 每步回读相机"而不是"起点快照 + 总位移"：后者有个反馈陷阱 ——
   *    相机一动，同一个屏幕点底下的那块地也跟着动，于是总位移会被前一次的修正量污染
   *    （表现是拖到一半开始跟不上手）。这里每步都拿**当前**相机算这两点之间的地面位移，
   *    误差不累积、回读的是真值（与相机那条纪律同源）。
   */
  let last: { x: number; y: number; dist: number; ang: number } | null = null;
  let gestureMode: "pan" | "rotate" = "pan";

  /** 屏幕像素 → 地面（局部框架里 y=0 那个平面）上的点；射线朝天/平行时给 null */
  function groundAtPx(px: number, py: number): [number, number] | null {
    if (!THREE || !camera) return null;
    const { w, h } = sizeOf();
    const tip = new THREE.Vector3(((px / w) * 2 - 1), -(((py / h) * 2 - 1)), 0.5).unproject(camera);
    const ox = camera.position.x;
    const oy = camera.position.y;
    const oz = camera.position.z;
    const dx = tip.x - ox;
    const dy = tip.y - oy;
    const dz = tip.z - oz;
    if (Math.abs(dy) < 1e-9) return null;
    const t = -oy / dy;
    if (!(t > 0)) return null;
    return [ox + dx * t, oz + dz * t];
  }

  /** 从相机反解出**契约状态**（与 `readView()` 同一份实现：手势那边也要用） */
  function readViewNow(): WsRenderState | null {
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
      selection: curState?.selection ?? null,
    };
  }

  /** 把"契约四量"落成相机（手势每步都走它），并叫一声 */
  function applyGesture(next: Partial<WsRenderState>): void {
    if (!curState) return;
    const s: WsRenderState = { ...curState, ...next };
    curState = s;
    applyCameraToThree(s);
    const out = readViewNow();
    if (out && viewListener) viewListener(out);
  }

  /** 当前指针的几何量（单指就是那个点；双指给中点/距离/夹角） */
  function geomOf(): { x: number; y: number; dist: number; ang: number } | null {
    const ps = Array.from(pointers.values());
    if (ps.length >= 2) {
      const dx = ps[1]!.x - ps[0]!.x;
      const dy = ps[1]!.y - ps[0]!.y;
      return {
        x: (ps[0]!.x + ps[1]!.x) / 2,
        y: (ps[0]!.y + ps[1]!.y) / 2,
        dist: Math.max(1, Math.hypot(dx, dy)),
        ang: Math.atan2(dy, dx),
      };
    }
    if (ps.length === 1) return { x: ps[0]!.x, y: ps[0]!.y, dist: 0, ang: 0 };
    return null;
  }

  /** 起手 / 换手：把参照系挪到"现在"（不动相机） */
  function beginGesture(mode: "pan" | "rotate"): void {
    gestureMode = mode;
    last = geomOf();
  }

  function onPointerDown(e: PointerEvent): void {
    if (state !== "running") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      /* 抓不住也还能拖（只是快速划出画布时会丢） */
    }
    const rotate = e.button === 2 || e.ctrlKey || e.metaKey;
    beginGesture(pointers.size >= 2 ? "rotate" : rotate ? "rotate" : "pan");
    e.preventDefault?.();
  }

  function onPointerMove(e: PointerEvent): void {
    if (state !== "running" || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!curState) return;
    const now = geomOf();
    if (!now) return;
    if (!last) {
      last = now;
      return;
    }
    const cur = readViewNow();
    if (!cur) return;
    const g1 = groundAtPx(last.x, last.y);
    const g2 = groundAtPx(now.x, now.y);
    const two = pointers.size >= 2;
    if (two) {
      /* 双指：捏合 + 扭转 + 竖向拖（俯仰）+ 中点平移，一次算全。
         🔴 扭转的**符号**照 MapLibre 抄：它的 `angleWith` 是 `atan2(新.x*旧.y − 新.y*旧.x, 新.x*旧.x + 新.y*旧.y)`
         = 旧角 − 新角，然后 `setBearing(bearing + bearingDelta)`
         ⇒ **bearing 增量 = −(新角 − 旧角)**。原来写成 `+`，真机上双指扭转与地图方向相反。 */
      const radius = saneRadius(cur.radius * (last.dist / now.dist));
      const bearing = normBearing(cur.bearing - ((now.ang - last.ang) * 180) / Math.PI);
      const pitch = clampPitch(cur.pitch + (last.y - now.y) * 0.5);
      const center = g1 && g2 ? shiftCenter(cur.center, g1[0] - g2[0], g1[1] - g2[1]) : cur.center;
      applyGesture({ center, radius, bearing, pitch });
    } else if (gestureMode === "rotate") {
      /* 右键 / Ctrl 拖：MapLibre 那条是 `bearingDelta = (cur.x − 起点.x) * rotateSpeed`（默认 0.8）
         ⇒ 向右拖 = bearing 增大；俯仰那条是 `(两指 dy 平均) * −0.5`，向下拖 = 俯仰减小。 */
      applyGesture({
        bearing: normBearing(cur.bearing + (now.x - last.x) * 0.8),
        pitch: clampPitch(cur.pitch + (last.y - now.y) * 0.5),
      });
    } else if (g1 && g2) {
      /* 平移：两块地之间的位移就是中心要挪的量（正负号见上面那段说明） */
      applyGesture({ center: shiftCenter(cur.center, g1[0] - g2[0], g1[1] - g2[1]) });
    }
    last = now;
  }

  function endPointer(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) {
      last = null;
      return;
    }
    /* 还剩手指 ⇒ 用剩下的重新起一手（不然会突然跳一下） */
    beginGesture(pointers.size >= 2 ? "rotate" : "pan");
  }

  function onWheel(e: WheelEvent): void {
    if (state !== "running" || !curState) return;
    e.preventDefault?.();
    const v = readViewNow();
    if (!v) return;
    /* 缩放锚在光标下的那块地：先记下它、缩完再把它挪回光标底下 */
    const before = groundAtPx(e.clientX, e.clientY);
    const k = Math.exp((e.deltaY || 0) * 0.0015);
    const radius = saneRadius(v.radius * k);
    const s: WsRenderState = { ...curState, radius, center: v.center };
    curState = s;
    applyCameraToThree(s);
    if (before) {
      const after = groundAtPx(e.clientX, e.clientY);
      if (after) applyGesture({ center: shiftCenter(v.center, after[0] - before[0], after[1] - before[1]) });
    } else {
      applyGesture({});
    }
  }

  /** 手挂在**自己那块画布**上（舞台里没有第二个人管输入：见文件头"这一版没有什么"） */
  function attachGestures(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    /* 右键拖 = 旋转/俯仰：把浏览器菜单按掉，不然一拖就弹菜单 */
    canvas.addEventListener("contextmenu", onContextMenu);
  }
  function detachGestures(): void {
    const c = renderer?.domElement as HTMLCanvasElement | undefined;
    if (!c?.removeEventListener) return;
    c.removeEventListener("pointerdown", onPointerDown);
    c.removeEventListener("pointermove", onPointerMove);
    c.removeEventListener("pointerup", endPointer);
    c.removeEventListener("pointercancel", endPointer);
    c.removeEventListener("wheel", onWheel);
    c.removeEventListener("contextmenu", onContextMenu);
    pointers.clear();
    last = null;
  }
  function onContextMenu(e: Event): void {
    if (state === "running") e.preventDefault?.();
  }

  /** 局部米 → 经纬度：在**当前中心**上挪 (dx, dz) 米（东 / 南） */
  function shiftCenter(c: { lat: number; lng: number }, dx: number, dz: number): { lat: number; lng: number } {
    const f = frame || frameOf(c);
    const [lng, lat] = toLatLng(f, ...(() => {
      const [x0, z0] = toLocal(f, c.lng, c.lat);
      return [x0 + dx, z0 + dz] as [number, number];
    })());
    return { lat, lng };
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
      for (let tri = 0; tri < triFeature.length; tri++) {
        if (triFeature[tri] !== fi) continue;
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
      attachGestures(canvas);
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
      return readViewNow();
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
        note: `${diag.buildings} 栋${diag.capped ? `（另有 ${diag.capped} 栋超上限未画）` : ""} / ${diag.tris} 三角 / 路 ${diag.roadSegs} 段 / 立绘 ${diag.actors}${diag.holesDropped ? ` / 洞未画 ${diag.holesDropped}` : ""}${worldNote()}${modelHudNote()}`,
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
        /* 🔴 契约里这个字段是**经纬度**（2D 那条路给的就是经纬度）⇒ 命中点是局部米，
           必须换回去；直接塞 `hit.point[0]/[2]` 是"米当度用"，数值上小得离谱（2026-10-11 修）。 */
        const ll = frame ? toLatLng(frame, hit.point[0], hit.point[2]) : null;
        return { kind: "bld", id, lng: ll ? ll[0] : 0, lat: ll ? ll[1] : 0 };
      }
      diag.colorPick = null;
      return null;
    },

    /** 舞台在切进来之后把它挂上：手势一改相机就叫一声（切回另一个后端时交接那一份视野） */
    setViewListener(cb: ((s: WsRenderState) => void) | null): void {
      viewListener = cb;
    },

    /** 给探针看的原始读数（**不进契约**：契约里不许有引擎的东西） */
    diag(): WsThreeDiag {
      return JSON.parse(JSON.stringify(diag)) as WsThreeDiag;
    },
  } as WsRenderBackend & { diag(): WsThreeDiag };
}
