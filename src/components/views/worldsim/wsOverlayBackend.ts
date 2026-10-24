/* wsOverlayBackend.ts —— **地图之上那一层**（契约里的 `overlay`）：地图照常在下层画，three 只把楼立体地叠上去。
 *
 * ## 口径（`world_map/PLAN-OVERLAY-BACKEND.md` 是施工图，这里照它实现）
 * · **不接管输入**：叠加层画布 `pointer-events: none` —— 拖/捏/滚轮/旋转/俯仰**全部**仍归地图。
 *   相机只有一条输入链路，不会出现两个后端抢手势。
 * · **相机每帧从地图读**：本文件**不存相机状态**，每帧 `map.getCenter()/getZoom()/getBearing()/getPitch()`
 *   + `map.getCanvas()` 的 CSS 尺寸 → 契约那两个纯函数 → `wsThreeCam` 的相机模型。
 *   （相机单一真源的纪律：绝不自己积分，见 `reference/2026-10-04-camera-single-truth-and-basemap-flat.md`。）
 * · **楼与 2D 同源**：几何由 `wsBldMesh.buildBldMeshData()` 算 —— 与 `three` 那条路**同一份**实现；
 *   数据来源是舞台交进来的那份 `bld`（地图 source 里那一份），叠加层不自己挑楼。
 * · **路网这类后到的数据**：叠加层挂在**地图的 `sourcedata`** 上，落图之后自己补（地图一直在，
 *   不像 `three` 那条路只能拿一次快照）。
 * · 失败即回退、开关默认关由舞台负责（本文件起不来就抛，走既有那条回退路）。
 *
 * ## 这一版不做什么（照实写）
 * · 只画**楼**（动态物是 O2）；
 * · 不做深度遮挡的假象（2D 底图在下面，楼压在它上面）；
 * · 没有命中/卡片（P3）。
 */

import { BLD_CAP, buildBldMeshData, outerRingsOf, urlLodMpp, type BldMeshData } from "./wsBldMesh";
import {
  ASSET_CAP,
  ASSET_FADE_MS,
  BLD_ASSET_BASE,
  assetFadeStep,
  assetTierStep,
  buildBldAssetLayer,
  loadBldAssetPack,
  loadBldAssetTexture,
  type BldAssetLayer,
  type BldAssetPack,
} from "./wsBldAssets";
import { ringCenter } from "./wsBuildingHint";
import {
  contractTheme,
  ledgerMark,
  ledgerPush,
  saneRadius,
  viewRadiusOf,
  type WsRenderActor,
  type WsRenderBackend,
  type WsRenderFc,
  type WsRenderSelection,
  type WsRenderState,
  type WsRenderStats,
  type WsRenderWorld,
} from "./wsRenderBackend";
import { FOV_Y, NEAR_M, camFrameOf, farOf, nearOf } from "./wsThreeCam";
import { matEq, projectPoint, projectPointY } from "./wsMatMul";
import { wsBuildingsHost, wsDrawnBld, wsLiveMap } from "./wsRenderBackend";
import { ensureBldLayers, hasBldLayers } from "./wsBldLayerSwitch";
import { bldLayerSpecsFor, mvtBldLayerSpecs } from "./wsDistrictScene";
import { mvtEnabled } from "./wsMvtTiles";
import { mapMvtBldFeatures } from "./wsMvtBldMap";
import { drawFacadeAtlas } from "./wsBldFacade";
import { OUTLINE_FRAG, OUTLINE_VERT, outlineRtBytes, outlineTexel } from "./wsOutline";
import { fpsMark } from "./wsFpsProbe";
import { createOvProbe, type OvProbeMapLike } from "./wsOvProbe";

const THREE_PATH = "/ws3d/ws3dgl/vendor/three.min.js";
/** 每度多少米（与 `wsThreeCam.M_PER_DEG` 同口径；这里只用它做锚点漂移判断） */
const M_PER_DEG = 111319.49079327358;
/** 地图中心离锚点超过这个米数就重锚（局部平面框架的近似误差随距离平方涨） */
const REANCHOR_M = 2000;
/**
 * 地图自己那套楼的图层前缀（`wsDistrictScene.ts` 里逐字是 `bld-foot` / `bld-ext` /
 * `bld-roof` / `bld-equip` / `bld-line` 五个）。**只碰这一组**：底图/水面/绿地/路网/标签一律不碰。
 */
const BLD_LAYER_PREFIX = "bld";

/**
 * 像素取证的**绝对值下限**（真机 2026-10-17：`pix.alive = 1` 也放行过 ⇒ 闸太弱）。
 * 采样框 20×20（缓冲像素，最多 4 个点 + 2 条兜底横带 = 最多 2400 px）；
 * 真画出楼时读到的是几百~几千，1~2 个只是噪点/边角。比例那条见闸的第 ⑤ 条（`cover`）。
 */
const PIX_MIN_ALIVE = 40;

/**
 * **叠加层画布的 dpr 上限**（`?ovldpr=`，默认 2）。
 *
 * 为什么要有：真机 2026-10-17「一拖动帧率就从 40 掉到 5-15」。叠加层画布在 dpr=3 时是
 * **3840×1734** 的缓冲，**填充率随 dpr² 走**（9 倍像素）；拖动时它每帧重画一遍。
 * 默认取 2：3→2 把叠加层填充率降到 **1/2.25**，画面只是略软 —— 移动端 3D 叠层的常见取舍。
 * 要逐像素看细节用 `?ovldpr=3`；想更省用 `?ovldpr=1.5`。
 */
function dprCapOf(): number {
  try {
    const v = Number(new URLSearchParams(location.search).get("ovldpr"));
    if (Number.isFinite(v) && v > 0.5 && v <= 4) return v;
  } catch {
    /* 读不到就用默认 */
  }
  return 2;
}

/** `sourcedata` 之后的补建防抖（毫秒） */
const REFRESH_DEBOUNCE_MS = 400;

/* ══════════════════════════════════════════════════════════════════════════
 * 🔧 自用对齐探针（`?wsalign=1`）—— **给真机用的量具**，不是产品功能
 * ══════════════════════════════════════════════════════════════════════════
 * 本机量不到"拖动时叠加层与地图差多少像素"（一个页面只能建一次 WebGL 上下文，叠加层常常
 * 起不来）⇒ 把这把尺子装进页面，让**真机**把数带回来：
 *   · 固定一栋楼的一个角（开的时候选一次、经纬度冻住，绝不每帧换目标）；
 *   · 每次地图 `render` 算一次屏幕空间像素差：`map.project(角)` vs 叠加层
 *     **上一次真的画出去那一帧**的投影（`projectFromLastDraw`）；
 *   · 记 `cur / max / 中位`（近 N 次）+ 当时的 `center/zoom/bearing/pitch` + 计数；
 *   · **停手 1 秒**再记一组（静止基准）；回传走 `<img>` beacon 到 8795 的 `__wslog`，
 *     `moveend` 必发一条、其余**最多每 2 秒一条**（不刷屏）。
 *   · 顺带把"米每像素口径"的比值一起带回去（用 `map.unproject` 在屏幕横轴上量 200 px
 *     对应多少米 —— **不动地图、不借内部字段**）。
 *
 * 🔴 纪律：① **只读**（不碰渲染、不改地图状态）② 默认不装（没这个参数 ⇒ 这段代码一步都不跑）
 *   ③ 这一段属**自用层**：将来给上游提 PR 时要**整段剔除**（连 `?wsalign=` 的判定一起）。
 */

/* 回传拼装 / 取证 / 计数已搬到 `wsOvProbe.ts`（Phase 2 第 1 步）：
   量具身份、`?ovlpix=0` 开关、beacon、对齐探针、像素取证、覆盖面 strikes 都在那边；
   本文件只负责把渲染/数据路径的读数**递快照**过去（见下面的 `probe`），以及调用。 */

export { alignProbeWanted } from "./wsOvProbe";

/** 只写用得到的形状（**不 import maplibre 的类型**：引擎结构不许泄进这里） */
type OverlayMapLike = OvProbeMapLike;

export function createOverlayBackend(): WsRenderBackend {
  let THREE: Record<string, any> | null = null;
  let renderer: any = null;
  let scene: any = null;
  let camera: any = null;
  let host: HTMLElement | null = null;
  let map: OverlayMapLike | null = null;
  let bldMesh: any = null;
  let data: BldMeshData | null = null;

  /* ── 近景资产（S8：Kenney CC0）─────────────────────────────────────────────
     两套几何**同 id / 同高 / 同占地**（`data.places` 与程序化那栋用同一批外环点）：
     远景画程序化（含几何变体），近景画资产；档位由 `mpp` + **迟滞**决定，切换时
     透明度此消彼长（`ASSET_FADE_MS`），资产懒加载，加载好之前一直画程序化。 */
  let assetPack: BldAssetPack | null = null;
  let assetTex: unknown = null;
  let assetLayer: BldAssetLayer | null = null;
  /** 迟滞后的档位（0 = 程序化，1 = 资产）——**不是**当前透明度 */
  let assetState: 0 | 1 = 0;
  /** 当前交叉淡入淡出进度（0 = 全程序化，1 = 全资产） */
  let assetFade = 0;
  let assetFadeTarget: 0 | 1 = 0;
  let assetLastAt = 0;
  let assetRaf = 0;
  let assetLoading = false;
  let assetPrefetchQueued = false;
  let assetLoadMs = 0;
  let assetError = "";
  /** 视野内楼数超预算时不给进资产档的理由（给探针/诊断读） */
  let assetBlocked = "";
  let assetMpp = 0;
  /** 只读读数（diag 用）：本帧资产画了几栋 / 几个 draw / 多少三角 */
  let assetDrawn = 0;
  let assetDrawCalls = 0;
  let assetDrawnTris = 0;
  /** `?bldassets=0` 关掉这一档（回退/对拍用；默认开） */
  const assetOn = (() => {
    try { return !/[?&]bldassets=0\b/.test(location.search); } catch { return true; }
  })();
  /** `?bldperf=1`：画完调一次 `gl.finish()` 并把同步毫秒记进 diag（默认关，别拖帧率） */
  const assetPerf = (() => {
    try { return /[?&]bldperf=1\b/.test(location.search); } catch { return false; }
  })();
  let syncMs = 0;
  let syncMsMax = 0;
  /** `?bldfade=<ms>`：只给取证用（把 260ms 的过渡放慢到能抓到中间帧），默认就是常量 */
  const assetFadeMs = (() => {
    try {
      const v = Number(new URLSearchParams(location.search).get("bldfade"));
      return Number.isFinite(v) && v >= 80 && v <= 8000 ? v : ASSET_FADE_MS;
    } catch {
      return ASSET_FADE_MS;
    }
  })();

  /** 局部平面框架的锚点（地图中心漂太远就重锚） */
  let anchor: { lat: number; lng: number; cos: number } | null = null;
  let state: "created" | "running" | "paused" | "destroyed" | "failed" = "created";
  /** 生命周期台账的那一行（与 map / three 两个后端同一口径；探针读 `ledger` 判"谁在跑"） */
  let instance = 0;
  let raf = 0;
  /** 重建后补画的那串 RAF（把"连续非空帧"稳定窗口跑满；见 `kickStableDraws`） */
  let stableRaf = 0;
  let frames = 0;
  /** **累计画出去多少帧**（`drawOnce` 每次 +1；地图驱动的 `frames` 只数 map render，别混） */
  let drawsTotal = 0;
  /** 其中多少帧是**重建后补画**的（不是地图 render 驱动）——`overlayFrames>mapFrames` 的来源 */
  let drawsFromRebuild = 0;
  /* ── 立面图集（2026-10-17）──
     一张 512 图集 + `aFacade`(格矩形) + `aRep`(重复次数) + `aUv2`(格内 0..1)，
     **一个材质一个纹理**，draw call 不变。补丁失效/纹理生成失败都**退回纯色**并记账。 */
  let facadePatchFailed = 0;
  let facadeTextureFailed = 0;
  let facadeApplied = 0;
  /* ── 屏幕空间描边（2026-10-17）──
     手写全屏 pass（不引 EffectComposer），默认关、`?outline=1` 才开。
     失败一律**退回无描边**并记账，不许白屏。 */
  const outlineOn = (() => {
    try { return /[?&]outline=1\b/.test(location.search); } catch { return false; }
  })();
  let outlineApplied = 0;
  let outlineFailed = 0;
  /** 运行期开关（pass 抛错后关掉它，别每帧都试） */
  let outlineOnRef = outlineOn;
  let outlineFrameMs = 0;
  let outlineRt: { setSize?: (w: number, h: number) => void; dispose?: () => void; depthTexture?: unknown } | null = null;
  let outlineQuad: { material?: { uniforms?: Record<string, { value: unknown }> }; geometry?: unknown } | null = null;
  let outlineScene: unknown = null;
  let outlineCam: unknown = null;
  let outlineDirty = false;
  let facadeTex: unknown = null;
  /* **默认关**（2026-10-17 真机"帧率下降"止血）：`?facade=1` 才开。
     贴图是"观感换帧率"的开关，先保帧率；等真机 A/B 有了结论再决定默认值。 */
  const facadeOn = (() => {
    try { return /[?&]facade=1\b/.test(location.search); } catch { return false; }
  })();

  /** 懒加载：首次重建后生成图集（别拖慢首屏）；失败记 `facadeTextureFailed` 并退回纯色 */
  function facadeTexture(): unknown {
    if (facadeTex) return facadeTex;
    try {
      const size = { w: 512, h: 512 };
      const cv = document.createElement("canvas");
      cv.width = size.w;
      cv.height = size.h;
      const ctx = cv.getContext("2d") as unknown as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void } | null;
      if (!ctx) { facadeTextureFailed = 1; return null; }
      const r = drawFacadeAtlas(ctx);
      if (!r.ok) { facadeTextureFailed = 1; return null; }
      const T = THREE as unknown as { CanvasTexture?: new (c: unknown) => { flipY: boolean } } | null;
      if (!T?.CanvasTexture) { facadeTextureFailed = 1; return null; }
      const tex = new T.CanvasTexture(cv);
      tex.flipY = false;
      facadeTex = tex;
      return tex;
    } catch {
      facadeTextureFailed = 1;
      return null;
    }
  }

  /**
   * `MeshBasicMaterial` 的**最小补丁**（不换材质类型）：把图集乘进漫反射色。
   * 先检测锚点是否在（three 版本不同会对不上）⇒ 不在就记 `facadePatchFailed`、**保持纯色**。
   */
  function patchFacade(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }): void {
    try {
      const vAnchor = "void main() {";
      const fAnchor = "vec4 diffuseColor = vec4( diffuse, opacity );";
      if (!shader.vertexShader.includes(vAnchor) || !shader.fragmentShader.includes(fAnchor)) {
        facadePatchFailed = 1;
        return;
      }
      const tex = facadeTexture();
      if (!tex) return;                       /* 纹理失败：不补丁 = 纯色 */
      shader.uniforms.facadeMap = { value: tex };
      shader.vertexShader =
        "attribute vec2 aUv2;\nattribute vec4 aFacade;\nattribute vec2 aRep;\nvarying vec2 vUv2;\nvarying vec4 vFacade;\nvarying vec2 vRep;\n" +
        shader.vertexShader.replace(vAnchor, vAnchor + "\n  vUv2 = aUv2; vFacade = aFacade; vRep = aRep;");
      shader.fragmentShader =
        "uniform sampler2D facadeMap;\nvarying vec2 vUv2;\nvarying vec4 vFacade;\nvarying vec2 vRep;\n" +
        shader.fragmentShader.replace(
          fAnchor,
          fAnchor +
            "\n  { vec2 l2 = fract(vUv2 * vRep); vec2 cuv = vFacade.xy + clamp(l2, vec2(0.001953125), vec2(0.998046875)) * vFacade.zw; diffuseColor.rgb *= texture2D(facadeMap, cuv).rgb; }"
        );
      facadeApplied = 1;
    } catch {
      facadePatchFailed = 1;
    }
  }

  let draws = 0;
  let fps = 0;
  let fpsAt = 0;
  let fpsFrames = 0;
  /** 每帧从地图读到的四量（**只是读数的缓存**，不是"我们的相机状态"） */
  let lastSeen: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null = null;
  let refreshTimer = 0;
  /** 重锚正在异步重建（别叠加第二次；也保证"锚点与网格同一刻切"） */
  let reanchorInFlight = false;
  /** 上一次重锚尝试的时刻（失败也别每帧重试：getData 是整份源，每帧拉一次会拖垮帧率） */
  let lastReanchorAt = 0;
  let reanchors = 0;
  let reanchorFails = 0;
  const errors: string[] = [];

  /* ── 上下文与降级计数（`?wsalign=1` 的回传要带着它们：真机"划着划着变成 2D 自绘路"要有账）── */
  /** 叠加层自己的 WebGL 上下文：建了几次、我们自己丢了几次、收到几个 lost/restored 事件 */
  let ovlCtxCreated = 0;
  let ovlCtxLost = 0;
  let ovlCtxLostEvents = 0;
  let ovlCtxRestoredEvents = 0;

  /** 页面上现在有几个画布（"越堆越多"是这台机器上出现过的故障形状） */
  function canvasCountNow(): number {
    try {
      return document.querySelectorAll("canvas").length;
    } catch {
      return -1;
    }
  }

  const runtimeUrl = (path: string): string =>
    new URL(path, typeof location !== "undefined" ? location.href : "http://127.0.0.1/").href;

  function sizeOf(): { w: number; h: number } {
    const w = host?.clientWidth || host?.getBoundingClientRect().width || 800;
    const h = host?.clientHeight || host?.getBoundingClientRect().height || 600;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  /** 经纬度 → 局部米（锚点固定；`[x, z]`，x 东、z 南） */
  function toLocal(lng: number, lat: number): [number, number] {
    const a = anchor as { lat: number; lng: number; cos: number };
    return [(lng - a.lng) * M_PER_DEG * a.cos, (a.lat - lat) * M_PER_DEG];
  }

  /** 锚点离地图中心多远（米，等距近似） */
  function anchorDriftM(c: { lat: number; lng: number }): number {
    if (!anchor) return 0;
    const a = anchor as { lat: number; lng: number; cos: number };
    const dx = (c.lng - a.lng) * M_PER_DEG * a.cos;
    const dz = (c.lat - a.lat) * M_PER_DEG;
    return Math.hypot(dx, dz);
  }

  /** 从地图读四量（**唯一真源**；读不到就给 null，绝不编） */
  function readMapView(): { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null {
    if (!map?.getCenter || !map.getZoom) return null;
    try {
      const c = map.getCenter();
      const zoom = map.getZoom();
      const cv = map.getCanvas?.() as { clientHeight?: number; height?: number } | undefined;
      const h = Number(cv?.clientHeight) || Number(cv?.height) || sizeOf().h;
      return {
        center: { lat: Number(c.lat), lng: Number(c.lng) },
        radius: saneRadius(viewRadiusOf(Number(c.lat), Number(zoom), h)),
        bearing: Number(map.getBearing?.() ?? 0),
        pitch: Number(map.getPitch?.() ?? 0),
      };
    } catch {
      return null;
    }
  }

  function fovYDeg(): number {
    return (FOV_Y * 180) / Math.PI;
  }

  /** 把"当前视野"写进一台相机（`syncCamera` 与量具的模型相机**共用这一份公式**） */
  function applyCamFrame(cam: Record<string, any>, v: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number }, w: number, h: number): void {
    const [cx, cz] = toLocal(v.center.lng, v.center.lat);
    const f = camFrameOf(cx, cz, v.radius, v.bearing, v.pitch);
    cam.position?.set?.(f.pos[0], f.pos[1], f.pos[2]);
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(f.xAxis[0], f.xAxis[1], f.xAxis[2]),
      new THREE!.Vector3(f.yAxis[0], f.yAxis[1], f.yAxis[2]),
      new THREE!.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2])
    );
    cam.quaternion?.setFromRotationMatrix?.(m);
    cam.near = nearOf(f.dist);
    cam.far = farOf(f.dist, v.radius);
    if (cam.aspect !== w / h) cam.aspect = w / h;
    cam.updateProjectionMatrix?.();
    cam.updateMatrixWorld?.(true);
  }

  /** 每帧：把地图的相机搬进 three（正解走 `wsThreeCam`，与独立那条路同一个模型） */
  function syncCamera(): void {
    if (!camera) return;
    const v = readMapView();
    if (!v) return;
    lastSeen = v;
    const { w, h } = sizeOf();
    applyCamFrame(camera as unknown as Record<string, any>, v, w, h);
  }

  /**
   * 地图自己那套楼的**图层 id 名单**（按样式里的真实顺序，只取 `bld` 打头的）。
   * 先 `getLayer` 确认层真的在 —— 不在的**不记**，免得出场时对一个不存在的层发指令。
   */
  function mapBldLayerIds(): string[] {
    const m = map as unknown as {
      getStyle?: () => { layers?: Array<{ id?: unknown }> } | undefined;
      getLayer?: (id: string) => unknown;
    } | null;
    if (!m?.getStyle || !m?.getLayer) return [];
    let all: unknown[] = [];
    try {
      all = m.getStyle()?.layers || [];
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const l of all) {
      const id = String((l as { id?: unknown })?.id ?? "");
      if (!id || !id.startsWith(BLD_LAYER_PREFIX)) continue;
      try {
        if (!m.getLayer(id)) continue;
      } catch {
        continue;
      }
      out.push(id);
    }
    return out;
  }

  /** 只认可见性四种合法值；拿不到（自定义样式/假地图）就当 `visible` */
  function normVisibility(v: unknown): string {
    return v === "none" || v === "visible" || v === "inherit" ? String(v) : "visible";
  }

  /**
   * 叠加层活着的时候把**地图自己那套楼**藏起来。
   *
   * 为什么：两套楼画的是同一批数据（同一份 `bld` 源、同一份高度口径），叠在一起就是
   * **同一栋楼画两遍** —— 边缘描边加深、颜色偏暗，镜头一动两套的**刷新时机也不一致**
   * （地图跟着瓦片走，叠加层要等 `sourcedata` + 防抖再重建），看上去就是"错位/走不一样远"。
   * 楼只留一套，另一套（three 那套）才有意义。
   *
   * 边界：**只碰 `bld` 打头的层**。底图、水面、绿地、路网、标签一律不动 —— 那些是叠加层
   * 不画的东西，藏了就是黑屏。每层进名单前先 `getLayer`，出场时逐项**照原值**还回去。
   */
  /** 延迟复读的定时器（同一时刻只挂一个） */
  let hideVerifyTimer = 0;
  /**
   * **1 秒后再读一遍**：真机上"写后立刻是 none、之后又 visible"说明**当时的复读不够**
   * （样式重载把层重建 / 读写不是同一个 style 对象）。这里 1 秒后复读全部已藏的层：
   * 全部仍 none ⇒ 这一轮算生效；任一层不是 ⇒ `hideDrift++`、记 ids、**重试一轮**。
   */
  function scheduleHideVerify(ms: number): void {
    if (hideVerifyTimer) return;                 /* 只挂一个 */
    hideVerifyTimer = window.setTimeout(() => {
      hideVerifyTimer = 0;
      const m = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
      if (!m?.getLayoutProperty || state === "destroyed") return;
      const bad: string[] = [];
      for (const id of hiddenLayers.keys()) {
        try {
          const v = m.getLayoutProperty?.(id, "visibility");
          const vs = v === undefined || v === null ? null : String(v);
          if (vs !== "none") bad.push(id);
        } catch {
          bad.push(id);
        }
      }
      if (!bad.length) return;
      hideDrift += 1;
      hideDriftIds = bad.slice(0, 8);
      if (hideRounds < 3) {
        hideRounds += 1;
        /* 重试：清掉这几层的记录（让补藏重新记原值），下一帧补藏会再写一次 */
        for (const id of bad) hiddenLayers.delete(id);
        hideSyncAt = 0;
        try { hideMapBuildings(); } catch { /* 下一帧再来 */ }
      }
    }, ms);
  }

  /**
   * **确认手里是屏幕当前那张地图**（真机 2026-10-17：`mapAlive.sameCanvas:false` ⇒
   * 我们的补藏全打在**旧实例**上，屏幕上那张图的楼一直没藏 ⇒ 用户看到"怪楼"）。
   * 判定：`wsLiveMap.get()` 给出的实例（宿主每次拿到/重建实例都登记）若与我们手里这个不同、
   * 且它有 `setLayoutProperty` ⇒ **重绑**：旧实例上尽力还原 → 换引用 → 订阅改挂 → 计数。
   */
  function ensureLiveMap(): boolean {
    let live: unknown = null;
    try { live = wsLiveMap.get(); } catch { live = null; }
    const cand = live as { setLayoutProperty?: unknown; on?: unknown; off?: unknown } | null;
    if (!cand || cand === (map as unknown) || typeof cand.setLayoutProperty !== "function") return true;
    /* 先摘旧实例的订阅 + 尽力还原（旧实例可能已经死了，失败不抛） */
    try { map?.off?.("sourcedata", onSourceData); map?.off?.("styledata", onStyleData); } catch { /* 旧实例可能已死 */ }
    try { restoreMapBuildings("rebind"); } catch { /* 旧实例可能已死 */ }
    hiddenLayers.clear();
    hidCount = 0;
    map = cand as unknown as OverlayMapLike;
    try { map.on?.("sourcedata", onSourceData); map.on?.("styledata", onStyleData); } catch { /* 新实例挂不上就下帧再试 */ }
    mapRebinds += 1;
    return true;
  }

  function hideMapBuildings(): void {
    ensureLiveMap();
    const m = map as unknown as {
      getLayoutProperty?: (id: string, k: string) => unknown;
      setLayoutProperty?: (id: string, k: string, v: unknown) => void;
    } | null;
    if (!m?.setLayoutProperty || state === "destroyed") return;
    /* 🔴 硬要求：**只有叠加层真的在画楼才允许藏**；否则立刻把地图那套还原（不许把画面弄空）。 */
    const gate = probe.meshDrawingOk(false);
    hideGateOk = gate.ok;
    hideGateWhy = gate.why;
    if (!gate.ok) {
      restoreMapBuildings("guard:" + gate.why);
      return;
    }
    const now = new Set(mapBldLayerIds());
    /* ① 已经不在样式里的条目退掉（层被移走了，还它没意义） */
    for (const id of [...hiddenLayers.keys()]) if (!now.has(id)) hiddenLayers.delete(id);
    for (const id of now) {
      let prev = hiddenLayers.get(id);
      const known = hiddenLayers.has(id);
      try {
        const cur = m.getLayoutProperty?.(id, "visibility");
        const curS = cur === undefined || cur === null ? null : normVisibility(cur);
        if (known && curS === "none") continue;   /* 已经藏好了：一次写都不做 */
        if (!known) prev = curS;                  /* 头一次见：记下原值 */
        m.setLayoutProperty(id, "visibility", "none");
        /* **写完读回**（真机 2026-10-17：`hidLive` 报 5 层全 visible 而 `hideSyncs=35`
           —— 两个数不可能同时为真 ⇒ 加自校验：没生效就重试一次，再不行如实计数） */
        let back = m.getLayoutProperty?.(id, "visibility");
        let backS = back === undefined || back === null ? null : String(back);
        if (backS !== "none") {
          hideRetries += 1;
          m.setLayoutProperty(id, "visibility", "none");
          back = m.getLayoutProperty?.(id, "visibility");
          backS = back === undefined || back === null ? null : String(back);
          if (backS !== "none") {
            hideVerifyFailed += 1;
            continue;                            /* 没藏上：**不记进名单**（免得出场还原一个假账） */
          }
        }
      } catch {
        /* 单层失败不影响其它层（也不记进名单，免得还的时候报错）—— 但要计数，不许静默 */
        hideErrors += 1;
        continue;
      }
      if (!known) hiddenLayers.set(id, prev === undefined ? null : prev);
    }
    hidCount = hiddenLayers.size;
    hideSyncs += 1;
    lastHideAt = performance.now();
    hidesSinceStyle += 1;
    scheduleHideVerify(1000);
  }

  /** 出场：**倒序**把藏起来的楼逐项还原（与藏的顺序相反，成对出现；失败路径也走它） */
  function restoreMapBuildings(reason = "unspecified"): void {
    if (!hiddenLayers.size) return;
    restoreReasons[reason] = (restoreReasons[reason] || 0) + 1;
    const m = map as unknown as {
      setLayoutProperty?: (id: string, k: string, v: unknown) => void;
    } | null;
    const rows = [...hiddenLayers.entries()].reverse();
    if (m?.setLayoutProperty) {
      for (const [id, prev] of rows) {
        try {
          m.setLayoutProperty(id, "visibility", prev === null ? "visible" : prev);
        } catch {
          /* 单层失败不阻断其余还原 */
        }
      }
      restoredCount = rows.length;
    }
    hiddenLayers.clear();
    hidCount = 0;
  }

  function disposeMesh(): void {
    if (!bldMesh) return;
    try {
      scene?.remove(bldMesh);
      bldMesh.geometry?.dispose?.();
      const mats = Array.isArray(bldMesh.material) ? bldMesh.material : [bldMesh.material];
      for (const mm of mats) mm?.dispose?.();
    } catch {
      /* 释放失败不影响后续（它已经不在场景里了） */
    }
    bldMesh = null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 近景资产：懒加载 → 建实例 → 双档切换（迟滞 + 交叉淡入淡出）
   * ══════════════════════════════════════════════════════════════════════════ */

  /** 资产包只取一次；失败把原因留在 `assetError`（下一次视图变化再试，不刷屏） */
  function kickAssetLoad(): void {
    if (assetLoading || assetPack || !assetOn || !THREE) return;
    assetLoading = true;
    const t0 = performance.now();
    void (async () => {
      try {
        const pack = await loadBldAssetPack(BLD_ASSET_BASE);
        const tex = await loadBldAssetTexture(
          THREE as Record<string, any>,
          runtimeUrl(BLD_ASSET_BASE + pack.texture)
        );
        assetPack = pack;
        assetTex = tex;
        assetLoadMs = Math.round(performance.now() - t0);
        assetError = "";
      } catch (e) {
        assetError = String((e as Error)?.message || e).slice(0, 160);
      } finally {
        assetLoading = false;
      }
    })();
  }

  /** 建资产层（几何只建一次；`data.places` 变了就重建实例） */
  function ensureAssetLayer(): boolean {
    if (assetLayer) return true;
    if (!assetPack || !assetTex || !data || !data.places || !data.places.length) return false;
    if (!THREE || !scene) return false;
    try {
      const layer = buildBldAssetLayer(THREE as Record<string, any>, assetPack, assetTex, data.places, {
        ids: data.featureIds,
        cap: ASSET_CAP,
      });
      scene.add(layer.group);
      assetLayer = layer;
      /* 新建的层先按**当前**透明度摆好（重建时可能正处在全资产档） */
      layer.applyFade(assetFade, assetFadeTarget === 1);
      return true;
    } catch (e) {
      assetError = String((e as Error)?.message || e).slice(0, 160);
      assetLayer = null;
      return false;
    }
  }

  /** 网格要换（数据变了）⇒ 连资产层一起重来（几何共享，重建很便宜） */
  function disposeAssets(): void {
    if (assetRaf) {
      cancelAnimationFrame(assetRaf);
      assetRaf = 0;
    }
    if (assetLayer) {
      try { assetLayer.dispose(); } catch { /* 释放失败不影响后续 */ }
      assetLayer = null;
    }
    assetDrawn = 0;
    assetDrawCalls = 0;
    assetDrawnTris = 0;
    assetLastAt = 0;
  }

  /** 程序化那层恢复成"正常不透明"（退出资产档 / 没有资产时） */
  function restoreProcMat(): void {
    const mat = bldMesh?.material;
    if (!mat) return;
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthTest = true;
    mat.depthWrite = true;
    bldMesh.renderOrder = 0;
  }

  /**
   * 每帧（`drawOnce` 开头）跑一次：算 mpp → 迟滞定档 → 推透明度 → 摆资产实例。
   *
   * 三条硬口径：
   *  · **没加载好就继续画程序化**（`assetFadeTarget` 停在 0，绝不闪空）；
   *  · **视野内楼数超预算就不进资产档**（宁可不换，也不留空洞）；
   *  · 资产是**进入方**时不透明、程序化是退出方时半透明盖在上面 —— 合成的永远是两套的加权和。
   */
  function updateAssets(): void {
    if (!assetOn || state !== "running") return;
    const now = performance.now();
    const dt = assetLastAt ? Math.min(120, now - assetLastAt) : 16;
    assetLastAt = now;
    const v = lastSeen;
    if (!v) return;
    const { h } = sizeOf();
    /* `?z=`/`?mpp=` 是既有排查口（与程序化 LOD 同一口径）；否则用真机视野 */
    const mppRaw = urlLodMpp() ?? (v.radius * 2) / Math.max(1, h);
    assetMpp = mppRaw;
    assetState = assetTierStep(assetState, mppRaw);

    let target: 0 | 1 = 0;
    if (assetState === 1) {
      if (!assetPack) {
        kickAssetLoad();
        assetBlocked = assetLoading ? "资产加载中（先画程序化）" : assetError ? "资产加载失败：" + assetError : "";
      } else if (!ensureAssetLayer()) {
        assetBlocked = "资产层建不起来：" + (assetError || "未知");
      } else {
        const [cx, cz] = toLocal(v.center.lng, v.center.lat);
        /* 投影筛：用**上一次真的画出去那一帧**的矩阵（滞后一帧，边距兜住）
           —— 比按距离猜准：屏幕最上沿的远楼不会被漏掉，屏幕外那批也不用白付三角。 */
        const acc = assetScreenFilter();
        assetLayer!.update(cx, cz, v.radius, acc);
        if (assetLayer!.overBudget()) {
          assetBlocked = "视野内 " + assetLayer!.visible() + " 栋 > 实例预算 " + ASSET_CAP;
        } else {
          assetBlocked = "";
          target = 1;
        }
      }
    } else {
      assetBlocked = "";
      /* 还没进近景时也提前把包取好（空闲），第一次推近=已经就绪，不闪 */
      if (!assetPack && !assetLoading) prefetchAssetsIdle();
    }
    assetFadeTarget = target;
    if (assetFade !== assetFadeTarget) {
      /* 按**真实经过时间**推进：掉帧/长帧也不会跳变（目标中途翻转时从当前值继续走） */
      assetFade = assetFadeStep(assetFade, assetFadeTarget, dt, assetFadeMs);
    }

    if (assetLayer) {
      if (assetFade > 0) {
        assetLayer.applyFade(assetFade, assetFadeTarget === 1);
        assetLayer.group.visible = true;
        assetDrawn = assetLayer.count();
        assetDrawCalls = assetLayer.draws();
        assetDrawnTris = assetLayer.tris();
      } else {
        assetLayer.group.visible = false;
        assetDrawn = 0;
        assetDrawCalls = 0;
        assetDrawnTris = 0;
      }
    }

    /* 程序化那层：资产全显 ⇒ 藏起来；正在过渡 ⇒ 当"退出方"半透明盖在资产上 */
    if (bldMesh) {
      const mat = bldMesh.material;
      if (assetFade >= 1 && assetFadeTarget === 1) {
        bldMesh.visible = false;
        if (mat) { mat.transparent = true; mat.opacity = 0; }
      } else if (assetFade > 0 && assetFadeTarget === 0) {
        /* 资产是退出方（自己半透明、不测深度）；程序化是进入方 ⇒ 不透明、先画 */
        restoreProcMat();
        bldMesh.visible = true;
      } else if (assetFade > 0) {
        /* 资产是进入方、程序化是退出方 ⇒ 程序化半透明、不测深度、后画（盖在资产上） */
        bldMesh.visible = true;
        if (mat) {
          mat.transparent = true;
          mat.opacity = 1 - assetFade;
          mat.depthTest = false;
          mat.depthWrite = false;
          bldMesh.renderOrder = 2;
        }
      } else {
        restoreProcMat();
        bldMesh.visible = true;
      }
    }

    /* 过渡没走完 ⇒ 自己补帧（地图静止时不会再有 render 事件） */
    if (assetFade !== assetFadeTarget && !assetRaf) kickAssetFade();
  }

  /**
   * 「这栋楼会不会在屏幕上」的投影筛（局部米 x/z → 屏幕像素）。
   * 边距 140 px：楼有高度，楼心在屏外时楼身也可能压进来一截。
   * 拿不到上一帧矩阵 ⇒ 返回 null（调用方退回按距离筛）。
   */
  function assetScreenFilter(): ((x: number, z: number) => boolean) | null {
    const ld = lastDraw;
    if (!ld) return null;
    const W = ld.w, H = ld.h;
    return (x: number, z: number): boolean => {
      const p = projectPoint(ld.mwInv, ld.proj, [x, z], W, H);
      if (!p) return false;
      return p[0] > -140 && p[0] < W + 140 && p[1] > -140 && p[1] < H + 140;
    };
  }

  /** 空闲预取：`requestIdleCallback` 有就用，没有就 setTimeout 兜底（不抢首屏） */
  function prefetchAssetsIdle(): void {
    if (assetPrefetchQueued) return;
    assetPrefetchQueued = true;
    try {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number }).requestIdleCallback;
      if (typeof ric === "function") ric(() => { assetPrefetchQueued = false; kickAssetLoad(); }, { timeout: 4000 });
      else window.setTimeout(() => { assetPrefetchQueued = false; kickAssetLoad(); }, 2500);
    } catch {
      window.setTimeout(() => { assetPrefetchQueued = false; kickAssetLoad(); }, 2500);
    }
  }

  /** 过渡期间的补帧环（每帧仍是 `syncCamera` + `drawOnce`，计数/闸全都照常走） */
  function kickAssetFade(): void {
    if (assetRaf) return;
    const step = (): void => {
      assetRaf = 0;
      if (state !== "running") return;
      if (assetFade === assetFadeTarget) return;
      syncCamera();
      drawOnce();
      /* ⚠️ `drawOnce → updateAssets → kickAssetFade` 会**自己把这根链续上**（那时 `assetRaf` 还是 0）。
         这里必须再判一次 `!assetRaf`：否则一帧里续两根链 ⇒ 指数级并发 rAF
         （实测：8000ms 的过渡 1 秒就跑完了、而且每帧画好几遍）。 */
      if (state === "running" && assetFade !== assetFadeTarget && !assetRaf) assetRaf = requestAnimationFrame(step);
    };
    assetRaf = requestAnimationFrame(step);
  }

  /**
   * 逐要素的**占地中心**（`id` → `[lng, lat]`；退化时退回主环第一个顶点）。
   *
   * 为什么要有：叠加层画出去的是 three 网格，地图那套 `bld-*` 图层已被拆掉
   * ⇒ 要素既没有 `geometry`、也查不到渲染命中，点选/卡片要的坐标只能在建网格时顺手算一份。
   * 口径与卡片/导出同一条（`wsBuildingHint.ringCenter`），不另写一套质心。
   */
  function centersOfFeatures(fc: WsRenderFc | null): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (const f of fc?.features ?? []) {
      const id = String((f as { id?: unknown }).id ?? "");
      if (!id || out.has(id)) continue;
      try {
        const { rings } = outerRingsOf((f as { geometry?: unknown }).geometry);
        const ring = rings[0];
        if (!ring) continue;
        const c = ringCenter(ring);
        if (c) out.set(id, c);
        else out.set(id, [ring[0]![0], ring[0]![1]]);
      } catch {
        /* 单栋几何坏了就跳过（它照样会被画，只是点选时没有代表点） */
      }
    }
    return out;
  }

  /** 用一份 `bld` 要素重建楼（几何走共用模块 ⇒ 与 three 那条路画的是同一批） */
  function rebuild(themeId: string, fcIn: WsRenderFc | null, nextAnchor: { lat: number; lng: number; cos: number } | null = null): void {
    /* 帧率采集的行为打点：几何重建是本模块最贵的一段（覆盖层低帧率窗口要能归因到这里） */
    fpsMark("overlay-rebuild");
    const fc = fcIn;
    /* 🔴 2026-10-17 真机"楼会变掉/多出奇怪的楼"：**锚点必须与网格同一刻切**。
       原来是先换全局 `anchor`、再异步重建 ⇒ 重建那几十~几百毫秒里，**旧网格（旧锚点坐标）**
       配着**新锚点相机**画，整体按锚点位移（最多 2 km）瞬移。
       现在：建网格用 `useAnchor`（目标锚点），建好换上网格的那一刻才 `anchor = nextAnchor`。 */
    const useAnchor = nextAnchor ?? anchor;
    const toLocalForBuild = (lng: number, lat: number): [number, number] => {
      const a = useAnchor;
      if (!a) return [0, 0];
      return [(lng - a.lng) * M_PER_DEG * a.cos, -(lat - a.lat) * M_PER_DEG];
    };
    /* 🔴 2026-10-16 真机"楼会变掉"那条：重建**必须是原子的** ——
       旧网格一直画着，新网格**先在本地建好**再一次性换上；只有"新网格是空的/建不出来"
       才允许把地图那套还原。原来先 `disposeMesh()`（屏幕上一瞬间没楼）+ 先 `restoreMapBuildings()`
       （地图那套又冒出来）⇒ 每次数据落图都闪一下，看起来就是"楼会变掉"。 */
    const next = fc
      ? buildBldMeshData({
          features: fc.features,
          toLocal: toLocalForBuild,
          themeId,
          cap: BLD_CAP,
          /* S7：几何变体（三种立面节奏/顶部/角部）；远景档由 LOD 自己挡掉 */
          variant: true,
        })
      : null;
    if (!THREE || !scene || !next || !next.triangles) {
      /* 新网格建不出来 ⇒ 老实换掉旧网格，并把地图那套**还回去**（宁可两套里少一套，也不许整屏没楼） */
      disposeMesh();
      data = null;
      hideGateOk = false;
      hideGateWhy = "重建出来是空的";
      restoreMapBuildings("rebuild-empty");
      return;
    }
    rebuildCount += 1;
    /* 排查口（只读、不影响渲染）：把「期望色」与「实际顶点色」各抽几个放进全局，
       页面里 eval `__WS_MESHCOLORS__` 就能看出颜色是在哪一层被改掉的。 */
    try {
      (window as unknown as { __WS_MESHCOLORS__?: unknown }).__WS_MESHCOLORS__ = {
        meta: next.featureMeta.slice(0, 8).map((m) => m.color),
        colors: Array.from(next.colors.slice(0, 24)).map((x) => Math.round(x * 255)),
        tris: next.triangles,
        themeId,
      };
    } catch { /* 排查口失败不影响渲染 */ }
    /* 落图数据确实到过（启动时间线 / 拆层稳定窗口的判据）：`sourcedata` 只在**新瓦片**落地时来，
       冷启动时瓦片很可能在本后端订阅之前就下完了 ⇒ 只靠事件会让 `tlLandingAt` 永远为 0、
       拆层判据永远不放行（地图那套 `bld-*` 一直留在屏上）。这里在"真建出非空网格"时补记。 */
    if (!tlLandingAt) tlLandingAt = Math.round(performance.now() - T0);
    /* 一次性换上：先建好 three 对象，再掐掉旧的（中间没有"两个都不在"的帧） */
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(next.positions), 3));
    g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(next.colors), 3));
    /* 立面图集三个属性（缺任何一组就退回纯色，不许崩） */
    try {
      if (facadeOn && next.uvs?.length) {
        g.setAttribute("aUv2", new THREE.BufferAttribute(Float32Array.from(next.uvs), 2));
        g.setAttribute("aFacade", new THREE.BufferAttribute(Float32Array.from(next.facadeRect), 4));
        g.setAttribute("aRep", new THREE.BufferAttribute(Float32Array.from(next.facadeRep), 2));
      }
    } catch { /* 属性失败就当没有，纯色照画 */ }
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    if (facadeOn) {
      mat.onBeforeCompile = (sh: unknown) => patchFacade(sh as { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> });
    }
    const newer = new THREE.Mesh(g, mat);
    newer.name = "ws-overlay-buildings";
    scene.add(newer);
    disposeMesh();                  /* 旧的这时候才退场（同一帧里完成） */
    /* 楼记录换了 ⇒ 资产实例也要按新记录重摆（几何共享，重建只是重设矩阵） */
    disposeAssets();
    fpsMark("mesh-swap");
    bldMesh = newer;
    data = next;
    /* 把"画出去的这批楼"登记给名字层（id + 高度；瓦片路径没有 name，名字由名字索引补）。
       `lng/lat`（占地中心）**必带**：叠加层负责画楼时地图那套 `bld-*` 图层已被拆掉
       ⇒ 点选只能按屏幕距离找最近的已画楼、卡片坐标也只能从这一份取。 */
    try {
      const ids = data?.featureIds ?? [];
      const metas = data?.featureMeta ?? [];
      const centers = centersOfFeatures(fc);
      const list = ids.map((id, i) => {
        const c = centers.get(String(id));
        return {
          id: String(id),
          properties: { h3d: Number(metas[i]?.h3d ?? 0), h_base: Number(metas[i]?.hBase ?? 0) },
          ...(c ? { lng: c[0], lat: c[1] } : {}),
        };
      });
      wsDrawnBld.set(list);
      drawnPublished = list.length;
    } catch { /* 登记失败不影响渲染 */ }
    /* 网格换好了 ⇒ 这一刻才切锚点（相机与网格从此又是同一个局部框架） */
    if (nextAnchor) anchor = nextAnchor;
    /* 网格帧采样点（最多 6 条）：楼心局部坐标（网格帧）+ 真实经纬度 */
    if (fc) {
    try {
      meshPts = [];
      const ids = next.featureIds.slice(0, 6);
      const byId = new Map<string, { lng: number; lat: number }>();
      for (const f3 of fc.features) {
        const g3 = (f3 as { geometry?: unknown }).geometry;
        const { rings } = outerRingsOf(g3);
        const p3 = rings[0]?.[0];
        if (p3) byId.set(String((f3 as { id?: unknown }).id ?? ""), { lng: p3[0], lat: p3[1] });
      }
      for (let i = 0; i < ids.length; i++) {
        const ll = byId.get(ids[i]!);
        const bx0 = next.boxes[i * 4]!, bz0 = next.boxes[i * 4 + 1]!, bx1 = next.boxes[i * 4 + 2]!, bz1 = next.boxes[i * 4 + 3]!;
        if (!ll || !(bx0 <= bx1) || !(bz0 <= bz1)) continue;
        meshPts.push({ id: ids[i]!, lng: ll.lng, lat: ll.lat, local: [(bx0 + bx1) / 2, (bz0 + bz1) / 2] });
      }
    } catch { meshPts = []; }
    }
    /* 覆盖面：**同一份 fc、同一个视野**两边各数一遍（楼少的根因要能一眼看出来） */
    if (fc) {
    try {
      const v = lastSeen || readMapView();
      const r2 = v ? v.radius * 1.25 : Number.POSITIVE_INFINITY;
      const inView = (x: number, z: number): boolean => Math.hypot(x, z) <= r2;
      let exp = 0;
      for (const f2 of fc.features) {
        const g = (f2 as { geometry?: unknown }).geometry;
        const { rings } = outerRingsOf(g);
        const p0 = rings[0]?.[0];
        if (!p0) continue;
        const xy = toLocal(p0[0], p0[1]);
        if (inView(xy[0], xy[1])) exp += 1;
      }
      let act = 0;
      const bx = next.boxes;
      for (let i = 0; i + 3 < bx.length; i += 4) {
        const cx = (bx[i]! + bx[i + 2]!) / 2;
        const cz = (bx[i + 1]! + bx[i + 3]!) / 2;
        if (inView(cx, cz)) act += 1;
      }
      cover.expected = exp;
      cover.actual = act;
      cover.srcAll = fc.features.length;
      cover.meshAll = next.stats.buildings;
      cover.thinDropped = next.stats.thinDropped;
      cover.shapeDropped = next.stats.shapeDropped;
      cover.judgedAt = performance.now();
      /* 视野外（我们画了、但不在当前视野半径内）—— 真机"多出奇怪的楼"先看这两个数：
         `meshOut` = 网格里落在视野外的栋数（跨视野累积仓库的主要来源），
         `srcOut` = 源里视野外的要素数（它不为 0 是**累积仓库的设计**，不是 bug）。 */
      cover.meshOut = Math.max(0, next.stats.buildings - act);
      cover.srcOut = Math.max(0, fc.features.length - exp);
      try {
        const hs = next.featureMeta.map((m) => Number(m.h3d)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
        const q = (pp: number): number => (hs.length ? hs[Math.min(hs.length - 1, Math.max(0, Math.floor(hs.length * pp)))]! : 0);
        meshHeights = { n: hs.length, p10: Number(q(0.1).toFixed(2)), p50: Number(q(0.5).toFixed(2)), p90: Number(q(0.9).toFixed(2)), flat: Number((hs.filter((h) => h < 3).length / Math.max(1, hs.length)).toFixed(3)) };
      } catch { meshHeights = null; }
    } catch {
      /* 数不出来就不判（宁可漏，不误判） */
      cover.expected = 0;
      cover.actual = 0;
    }
    }
    /* 数据是**后到**的 ⇒ 重建完立刻画一帧：渲染是"地图画完一帧"驱动的，地图静止时不会再来
       render，等它就等于这一批楼不显示。这一帧是**必要**的（新网格），要单独计数。 */
    drawsFromRebuild += 1;
    drawOnce();
    /* 地图静止时不会再来 `render` ⇒ 拆层稳定窗口靠这里自己补满（见 `kickStableDraws`） */
    kickStableDraws();
  }

  /** 最近一次从瓦片查询取到的：原始条数（含部件）/ 唯一 id 数 / 被丢掉的部件条数 */
  let bldQueryFeatures = 0;
  let mvtRawFeatures = 0;
  let mvtUniqueIds = 0;
  let mvtPartsDropped = 0;
  let mvtQueryMs = 0;
  let mvtQueryMaxMs = 0;
  let mvtQueries = 0;
  /** 叠加层自己的重建次数（与落图线的 refreshDone 不是一回事） */
  let rebuildCount = 0;
  /** 最近一次登记给名字层的楼数（回传用） */
  let drawnPublished = 0;

  /**
   * 从**瓦片（矢量源）**取当前视野的楼。
   *
   * 为什么不是 `getData()`：矢量源**没有 `getData`**（那正是旧护栏 `overlay-needs-geojson` 的由来）。
   * 矢量源的官方读取入口是 `querySourceFeatures`：它返回**当前已加载瓦片里**的要素，
   * 带 `geometry` 与 `properties`（`h/hb/c/zt/p` 或 GeoJSON 的 `h3d/h_base/color3d`）。
   * 注意：`wsMvtDecode.decodeMvtFeatures` 只解出 `id + properties`（**没有几何**），
   * 所以几何只能从源里拿 —— 这不是第二条数据路，而是读同一份 MVT 瓦片的入口。
   */
  function grabMvt(): WsRenderFc | null {
    const m = map as unknown as {
      getSource?: (id: string) => { type?: string; setData?: unknown } | undefined;
      querySourceFeatures?: (id: string, opts?: { sourceLayer?: string }) => Array<{
        id?: unknown;
        type?: string;
        geometry?: { type?: string; coordinates?: unknown };
        properties?: Record<string, unknown>;
      }>;
    } | null;
    if (!m?.querySourceFeatures) return null;
    const src = m.getSource?.("bld") as { type?: string } | undefined;
    /* 矢量源才走这条（GeoJSON 源继续用 getData，行为不变） */
    if (!src || src.type === "geojson") return null;
    let feats: ReturnType<NonNullable<typeof m.querySourceFeatures>> = [];
    const tq = performance.now();
    try {
      /* **必须给 `sourceLayer`**：MapLibre 的 `querySourceFeatures(sourceId, {sourceLayer})` 在
         矢量源上按**源图层名**取要素，不给就是查空串那一层（实测返回 0 条，静默）。
         瓦片产物只有一个源图层 `bld`（`mvt-spike/tools/gen_mvt.mjs` 的 `LAYER`），
         楼与拆件都在这一层里（用属性 `p` 区分）。 */
      feats = m.querySourceFeatures("bld", { sourceLayer: "bld" }) || [];
    } catch {
      return null;
    }
    /* 帧率排查用：这一次全量扫花了多少毫秒（真机 1158 栋 + 部件时它可能很贵） */
    mvtQueryMs = Math.round((performance.now() - tq) * 10) / 10;
    mvtQueryMaxMs = Math.max(mvtQueryMaxMs, mvtQueryMs);
    mvtQueries += 1;
    /* 映射规则（主体优先 / zt 只来自 zt / 一栋一条）在 `wsMvtBldMap.ts`，**唯一实现**，
       闸直接测那个纯函数（真机"带凸起的小楼"就是这里早先按 id 先到先得造成的）。 */
    const mapped = mapMvtBldFeatures(feats as never);
    mvtRawFeatures = mapped.raw;
    mvtUniqueIds = mapped.unique;
    mvtPartsDropped = mapped.partsDropped;
    if (!mapped.features.length) return null;
    bldQueryFeatures = mapped.features.length;
    /* 形状必须与 `grabBld` 的 GeoJSON 那条**同一份**（`WsRenderFc` = `{type, features}`）：
       `rebuild()` 读的是 `fc.features`，包成 `{buildings:{…}}` 会被当成空网格。 */
    return { type: "FeatureCollection", features: mapped.features } as unknown as WsRenderFc;
  }

  async function grabBld(): Promise<WsRenderFc | null> {
    /* ① 矢量源（MVT 默认开）：`vector` 源**没有 `getData`**，官方入口是 `querySourceFeatures`
       （见 `grabMvt`）。不先走这条，叠加层拿到的是 `null` ⇒ 0 栋楼 ⇒ 藏楼闸不放行 ⇒
       屏幕上只剩地图那套平板。`?mvt=0` 时源是 GeoJSON，`grabMvt` 直接返回 null，走 ②。 */
    const mvtFc = grabMvt();
    if (mvtFc) {
      lastSource = "mvt";
      return mvtFc;
    }
    /* ② GeoJSON 源：原来那条 `getData` 路（行为不变）
       ⚠️ 拿不到**不改** `lastSource`：它是"屏幕上这批楼从哪儿来"，不是"上一次取数成没成"。
       拆层之后源没有图层消费者 ⇒ 后续 refresh 会取空，把来源改成 `none` 就成了假读数
       （实测：137 栋在画，`diag.source` 却是 `none`）。 */
    try {
      const src = map?.getSource?.("bld");
      if (!src?.getData) return null;
      getDataCalls += 1;
      const d = (await src.getData()) as WsRenderFc | null;
      if (!d || !Array.isArray(d.features)) return null;
      lastSource = "source";
      return { type: "FeatureCollection", features: d.features };
    } catch {
      return null;
    }
  }

  /** 后到的数据自己补上（`bld` 落图 ⇒ 重建）；防抖，别在一次落图里重建十遍 */
  function scheduleRefresh(): void {
    refreshScheduled += 1;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          rebuild(curThemeId, fc);
          refreshDone += 1;
          lastRefreshMs = performance.now();
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
  }

  const onSourceData = (e: { sourceId?: string }): void => {
    if (e?.sourceId !== "bld") return;
    srcDataEvents += 1;
    if (!tlLandingAt) tlLandingAt = Math.round(performance.now() - T0);
    /* 楼图层可能**刚刚才建出来**（冷启动直接进叠加层），也可能被"源在层缺"的看门狗补回来
       ⇒ 每一次落图都补一次藏（幂等：已经藏好时一次写都不做）。 */
    hideMapBuildings();
    scheduleRefresh();
  };

  /**
   * 样式变了（含**上下文丢失后的样式重建**、主题切换）：楼图层可能整批换新 ⇒ 补藏一次。
   * 我们自己 `setLayoutProperty` 也会触发它 —— 那种情况下层已经是 `none`，补藏是空转，不会自激。
   */
  const onStyleData = (): void => {
    styleDataEvents += 1;
    lastStyleAt = performance.now();
    styleDataStamps.push(Math.round(lastStyleAt));
    if (styleDataStamps.length > 20) styleDataStamps.shift();
    /* 事件里**立刻**补藏一次（hidesSinceStyle 会在补藏末尾 +1 ⇒ 能看出"补藏在事件之后"） */
    hidesSinceStyle = 0;
    hideMapBuildings();
  };

  let curThemeId = "anime";
  /**
   * 这一次 overlay 活着期间**藏起来的**地图楼图层：`id → 原值`（`null` = 原来没设过）。
   * 用 `Map` 而不是数组：楼图层会**后到**（冷启动 `?renderer=overlay` 时样式里还没有它们，
   * 上下文丢失后的看门狗还会把它们补回来）⇒ 需要"随时再查一遍、只补新出现的"这种幂等操作。
   * 插入顺序 = 藏的顺序 ⇒ 还原时倒着走。
   */
  const hiddenLayers = new Map<string, string | null>();
  /** 藏/还原各几层（进 `stats`：**不许静默**） */
  let hidCount = 0;
  let restoredCount = 0;
  /**
   * **藏楼闸**：只有"叠加层真的在画楼"才允许藏地图那套楼。
   *
   * 为什么（2026-10-16 真机事故）：藏楼原来只与"overlay 是当前后端"绑定 ⇒ 叠加层起不来 /
   * 数据没到 / 网格建不出来 / 着色器编不过（本机靶场实测过 `MeshBasicMaterial`
   * `VALIDATE_STATUS false`）/ 画了 0 栋 —— 任何一种都会让**屏幕上一栋楼都没有**
   * （地图那套被藏了、叠加层这套又没画出来）。这条闸把它绑到"**有效绘制**"上。
   */
  let hideGateOk = false;
  let hideGateWhy = "还没画过";
  /** 上一次"补藏/补还原"的时间（节流：别每帧走一遍 `getStyle()`） */
  let hideSyncAt = 0;
  /**
   * **覆盖面**（2026-10-17 真机："整屏只有一栋楼"）：`actual` 是我们网格里**落在视野内**的楼数，
   * `expected` 是地图源里**落在视野内**的要素数（同一份数据、同一个视野）。
   * 楼少到 `actual*2 < expected` 就当作"没画够" ⇒ 还原地图那套（不许静默：数进 note 与回传）。
   */
  /** 网格里每栋楼的高度分布（给名字层"楼顶投影 vs 楼本来就是平的"那条判据） */
  let meshHeights: { n: number; p10: number; p50: number; p90: number; flat: number } | null = null;
  /**
   * "网格帧采样点"：建网格时记下**几条**楼心的局部坐标（网格自己的帧）与它们的真实经纬度。
   * 用途（重锚窗口闸）：同一时刻用**画出去那一帧**的矩阵分别投这两个坐标 ——
   * 网格帧与相机帧一致时两者重合；锚点被提前切了就会差出锚点位移（最多 2 km）。
   */
  let meshPts: Array<{ id: string; lng: number; lat: number; local: [number, number] }> = [];
  const cover: { expected: number; actual: number; srcAll: number; meshAll: number; thinDropped: number; shapeDropped: number; judgedAt: number; meshOut: number; srcOut: number } =
    { expected: 0, actual: 0, srcAll: 0, meshAll: 0, thinDropped: 0, shapeDropped: 0, judgedAt: 0, meshOut: 0, srcOut: 0 };
  /** 数据通道的账（"为什么只画出一栋"要能查：调度了几次 / 完成几次 / 取了几次数） */
  let refreshScheduled = 0;
  let refreshDone = 0;
  /** 地图事件来的次数（真机"藏了又被显示"要查是不是 style/data 事件在反复触发重建） */
  let srcDataEvents = 0;
  let styleDataEvents = 0;
  let getDataCalls = 0;
  let lastRefreshMs = -1;
  /** 藏/还原各发生了多少次、**为什么**（真机上"楼会变掉"要能查账） */
  let hideSyncs = 0;
  /** 藏楼自校验的账：重试几次 / 写完读回仍不是 none 的层数 / 写入抛错次数（都不许静默） */
  let hideRetries = 0;
  /** 结构性拆层：累计删了几条、实际"发现还有层并删掉"的轮数、恢复（调落图线 flush）几次 */
  let layersRemovedTotal = 0;
  let layersRecovered = 0;
  let removePasses = 0;
  let lastRemoveAt = 0;
  /** `gate.ok` 连续失败次数（**只用来触发失败恢复**，不再用来阻止拆除） */
  let gateFailStreak = 0;
  /* ── 启动时间线（自用，随第一次回传带上；单位 = 相对 `performance.now()` 的毫秒）──
     用途：真机"刷新后有时没楼"要看**是不是拆层早于首绘 / 落图没回来就拆了**。 */
  const T0 = performance.now();
  let tlPrefAt = 0;          /* 渲染者偏好决定（本后端 init 开始） */
  let tlLandingAt = 0;       /* 落图第一次把数据交进来（sourcedata / 首次 rebuild 拿到数据） */
  let tlRunningAt = 0;       /* 叠加层 state=running */
  let tlFirstDrawAt = 0;     /* 第一次**非空**绘制 */
  let tlFirstRemoveAt = 0;   /* 第一次拆层 */
  let tlFirstRecoverAt = 0;  /* 第一次失败恢复 */
  /** **连续**非空绘制帧数（拆层稳定窗口用：≥ `REMOVE_STABLE_FRAMES` 才允许拆） */
  let nonEmptyFrames = 0;
  const REMOVE_STABLE_FRAMES = 10;
  /** 最近一次非空绘制的时刻（空屏兜底用） */
  let lastNonEmptyAt = 0;
  /** 空屏兜底的上一次动作时刻（冷却，别每帧 flush） */
  let lastEmptyGuardAt = 0;
  /** 上一次的楼房渲染模式（`map` / `overlay`）—— 只在**切换**时动作，避免拉锯 */
  let bldMode: "map" | "overlay" = "map";
  /** 重绑次数（地图实例/画布被换过 ⇒ 重新绑到屏幕当前那张上） */
  let mapRebinds = 0;
  /** 名字层 DOM 写入次数（MutationObserver，只读）；名字节点现数在回传时取 */
  let labelWrites = 0;
  /** 拆开：名字节点自身的写入 vs 容器（跟手 translate3d）的写入 */
  let labelNodeWrites = 0;
  let labelContainerWrites = 0;
  let labelObs: MutationObserver | null = null;
  /**
   * **藏楼"漂移"**（真机 2026-10-17：写后立刻读是 none，之后又变 visible）
   * —— 写后立刻复读只能证明"那一刻"，证不了"之后"。所以再挂一次**延迟复读**（1 秒后）：
   * 任一层不是 none ⇒ `hideDrift++`、记下是哪几层、并**重试**（最多 3 轮，防死循环）。
   */
  let hideDrift = 0;
  let hideDriftIds: string[] = [];
  let hideRounds = 0;
  /** 样式/数据事件的最近时刻与"补藏发生在事件之后"的计数（判"补藏在事件序列里的位置"） */
  let lastStyleAt = 0;
  let lastHideAt = 0;
  let hidesSinceStyle = 0;
  let styleDataStamps: number[] = [];
  let hideVerifyFailed = 0;
  let hideErrors = 0;
  const restoreReasons: Record<string, number> = {};

  /**
   * 回传/取证/计数的宿主快照（`wsOvProbe` 每次调用现取；这里只读，不写）。
   * 渲染/数据路径的计数仍写在本文件，探针自己的计数在 `wsOvProbe` 里。
   */
  const probe = createOvProbe(() => ({
    map,
    renderer,
    data,
    bldMesh,
    frames,
    draws,
    drawsTotal,
    drawsFromRebuild,
    fps,
    hiddenLayers,
    hidCount,
    restoredCount,
    cover,
    hideGateOk,
    hideGateWhy,
    gateFailStreak,
    lastDrawAt,
    reanchors,
    reanchorFails,
    reanchorInFlight,
    lastReanchorAt,
    mapRebinds,
    lastSource,
    mvtRawFeatures,
    mvtUniqueIds,
    mvtPartsDropped,
    mvtQueryMs,
    mvtQueryMaxMs,
    mvtQueries,
    rebuildCount,
    drawnPublished,
    refreshScheduled,
    refreshDone,
    getDataCalls,
    srcDataEvents,
    styleDataEvents,
    lastRefreshMs,
    facadeOn,
    facadeApplied,
    facadePatchFailed,
    facadeTextureFailed,
    assetOn,
    assetState,
    assetFade,
    assetFadeTarget,
    assetMpp,
    assetDrawn,
    assetDrawCalls,
    assetDrawnTris,
    assetBlocked,
    assetLoadMs,
    assetError,
    assetPack,
    assetLayer,
    syncMs,
    syncMsMax,
    assetPerf,
    outlineOn,
    outlineOnRef,
    outlineApplied,
    outlineFailed,
    outlineFrameMs,
    tlPrefAt,
    tlLandingAt,
    tlRunningAt,
    tlFirstDrawAt,
    tlFirstRemoveAt,
    tlFirstRecoverAt,
    nonEmptyFrames,
    removeStableFrames: REMOVE_STABLE_FRAMES,
    bldMode,
    T0,
    labelWrites,
    labelNodeWrites,
    labelContainerWrites,
    hideSyncs,
    restoreReasons,
    hideRetries,
    hideVerifyFailed,
    hideErrors,
    hideDrift,
    hideDriftIds,
    hideRounds,
    lastStyleAt,
    lastHideAt,
    hidesSinceStyle,
    styleDataStamps,
    layersRemovedTotal,
    layersRecovered,
    removePasses,
    ovlCtxCreated,
    ovlCtxLost,
    ovlCtxLostEvents,
    ovlCtxRestoredEvents,
    meshHeights,
    bldLayerPrefix: BLD_LAYER_PREFIX,
    sizeOf,
    w0,
    h0,
    mapBldLayerIds,
    projectFromLastDrawLocalAt,
    this_projectFromLastDraw,
    scheduleRefresh,
    grabBld,
    dprCapOf,
    outlineTexel,
    outlineRtBytes,
    fpsMark,
  }));

  /** 局部米坐标（可带高度）→ 屏幕像素（用**画出去那一帧**的矩阵；只给像素取证的采样点算位置） */
  function projectFromLastDrawLocalAt(x: number, z: number, y: number = 0): [number, number] | null {
    if (!lastDraw) return null;
    return projectPointY(lastDraw.mwInv, lastDraw.proj, [x, z], y, lastDraw.w, lastDraw.h);
  }

  /** 画布 CSS 尺寸（`sizeOf` 是函数声明，这里给闸用同一份） */
  function w0(): number { return sizeOf().w; }
  function h0(): number { return sizeOf().h; }

  /**
   * 怎么跟地图对齐（**这是"拖动时位移不一致"那条的头号嫌疑**）：
   *   · `render`（默认）：挂 `map.on('render')` —— 地图画完一帧就叫我们，**同一帧**用它的相机画叠加层；
   *   · `raf`：自己的 `requestAnimationFrame`（老行为）。地图与叠加层各跑各的节奏，
   *     拖动时相机读数可能差一帧 ⇒ **静止看不出来、一动就按速度成比例地错开**。
   * 保留两种是为了让探针在**同一页面、同一段拖动**里 A/B 对比（不是靠讲道理）。
   */
  let alignMode: "render" | "raf" = "render";
  /** 上一次**真的画出去**那一帧的相机矩阵（逐帧对拍要看"屏幕上是什么"，不是"现在是什么"） */
  let lastDraw: { mwInv: number[]; proj: number[]; w: number; h: number } | null = null;
  /** 上面那组快照是**哪一刻**取的（毫秒，`performance.now()`）—— 判"读数是不是旧帧"要用它 */
  let lastDrawAt = 0;
  /** 这一帧那批楼**从哪儿来**（`world` = 舞台交进来的那份 / `source` = 从地图 source 现捞的） */
  let lastSource = "none";

  /** 真的画一帧（并把"画的时候"的相机矩阵快照下来 —— 逐帧对拍读的就是它） */
  /** 懒建描边的 RT 与全屏 quad（失败就记 failed，退回无描边） */
  function ensureOutline(w: number, h: number): boolean {
    if (!outlineOn) return false;
    try {
      const T = THREE as unknown as {
        WebGLRenderTarget?: new (w: number, h: number, o?: unknown) => { setSize?: (w: number, h: number) => void; dispose?: () => void; depthTexture?: unknown; texture?: unknown };
        DepthTexture?: new (w: number, h: number) => unknown;
        Scene?: new () => unknown;
        OrthographicCamera?: new (l: number, r: number, t: number, b: number, n: number, f: number) => unknown;
        PlaneGeometry?: new (w: number, h: number) => unknown;
        ShaderMaterial?: new (o: unknown) => { uniforms?: Record<string, { value: unknown }> };
        Mesh?: new (g: unknown, m: unknown) => unknown;
      } | null;
      if (!T?.WebGLRenderTarget || !T.Scene || !T.ShaderMaterial || !T.Mesh || !T.PlaneGeometry || !T.OrthographicCamera) {
        outlineFailed = 1;
        return false;
      }
      if (!outlineRt) {
        const rt = new T.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), { depthBuffer: true, stencilBuffer: false });
        try {
          if (T.DepthTexture) (rt as { depthTexture?: unknown }).depthTexture = new T.DepthTexture(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
        } catch { /* 没有深度纹理就退回亮度 Sobel */ }
        outlineRt = rt;
        const quad: { material?: { uniforms?: Record<string, { value: unknown }> }; geometry?: unknown } = {};
        const uniforms: Record<string, { value: unknown }> = {
          uColor: { value: rt.texture },
          uDepth: { value: (rt as { depthTexture?: unknown }).depthTexture ?? rt.texture },
          uTexel: { value: [0.001, 0.001] },
          uUseDepth: { value: (rt as { depthTexture?: unknown }).depthTexture ? 1 : 0 },
          uLineColor: { value: [0.16, 0.18, 0.22] },
        };
        const mat = new T.ShaderMaterial({ uniforms, vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG, transparent: true, depthTest: false });
        quad.material = mat;
        quad.geometry = new T.PlaneGeometry(2, 2);
        outlineScene = new T.Scene();
        outlineCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mesh = new T.Mesh(quad.geometry, mat);
        (outlineScene as { add?: (m: unknown) => void }).add?.(mesh);
        outlineQuad = quad;
        outlineApplied = 1;
      } else {
        outlineRt.setSize?.(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
      }
      return true;
    } catch {
      outlineFailed = 1;
      return false;
    }
  }

  function drawOnce(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    /* 近景资产那一档：定档 / 推透明度 / 摆实例（**在 render 之前**，改的是材质与可见性） */
    try { updateAssets(); } catch { /* 资产那条路坏了就继续画程序化，别把整帧拖垮 */ }
    const { w, h } = sizeOf();
    lastDrawAt = performance.now();
    try {
      lastDraw = {
        mwInv: Array.from(camera.matrixWorldInverse.elements as number[]) as number[],
        proj: Array.from(camera.projectionMatrix.elements as number[]) as number[],
        w,
        h,
      } as { mwInv: number[]; proj: number[]; w: number; h: number };
    } catch {
      lastDraw = null;
    }
    if (outlineOn && ensureOutline(w, h) && outlineRt && outlineScene && outlineCam) {
      const t0 = performance.now();
      try {
        const R = renderer as unknown as { setRenderTarget?: (t: unknown) => void; render: (s: unknown, c: unknown) => void };
        R.setRenderTarget?.(outlineRt);
        renderer.render(scene, camera);
        R.setRenderTarget?.(null);
        /* 线宽随缓冲尺寸走（dpr 只改缓冲，不改线宽） */
        const texel = outlineTexel(w, h);
        const uni = (outlineQuad as { material?: { uniforms?: Record<string, { value: unknown }> } })?.material?.uniforms;
        if (uni?.uTexel) uni.uTexel.value = [texel.x, texel.y];
        renderer.render(outlineScene as never, outlineCam as never);
        outlineFrameMs = Math.round((performance.now() - t0) * 100) / 100;
      } catch {
        outlineFailed = 1;
        outlineOnRef = false;
        try { renderer.render(scene, camera); } catch { /* 退回这一帧没有描边 */ }
      }
    } else {
      renderer.render(scene, camera);
    }
    /* `?bldperf=1`：同步等到 GPU 真画完再出时间（默认关 —— `finish()` 会掐掉异步流水线） */
    if (assetPerf) {
      try {
        const gl = (renderer as { getContext?: () => { finish?: () => void } }).getContext?.();
        gl?.finish?.();
        const ms = Math.round((performance.now() - lastDrawAt) * 100) / 100;
        syncMs = ms;
        if (ms > syncMsMax) syncMsMax = ms;
      } catch {
        /* 拿不到上下文就不量 */
      }
    }
    drawsTotal += 1;
    draws = renderer.info?.render?.calls ?? 0;
    assetDrawCalls = assetLayer && assetLayer.group.visible ? assetLayer.draws() : 0;
    /* 启动时间线：**非空**绘制才算数（空网格/0 栋不算"画出来了"） */
    try {
      const nonEmpty = !!data && data.triangles > 0 && draws > 0;
      if (nonEmpty) {
        nonEmptyFrames += 1;
        const t1 = performance.now();
        lastNonEmptyAt = t1;
        if (!tlFirstDrawAt) tlFirstDrawAt = Math.round(t1 - T0);
      } else {
        nonEmptyFrames = 0;
      }
    } catch { /* 时间线出错不影响渲染 */ }
    /* 画完立刻过一遍藏楼闸：**首帧、重建后、以及"还一层都没藏"时**都要查（节流在闸里） */
    try {
      if (draws > 0) {
        /* 每帧先确认"手里是屏幕当前那张地图"（比较一次，开销可忽略；不同才重绑）。
           否则闸会判"实例已换" ⇒ 软失败 ⇒ 永远走不到补藏 ⇒ 也就永远不重绑（自锁）。 */
        ensureLiveMap();
        const gate = probe.meshDrawingOk(true);
        hideGateOk = gate.ok;
        hideGateWhy = gate.why;
        /* 🔴 2026-10-17（拉锯 + 语义修正）：
           · **拆除**只看稳态判据：叠加层是当前楼房渲染者、且**已经画出过非空的一帧**
             （`drawsTotal>0 && 网格有三角`）—— **不再看 `gate.ok`**。
             真机 `gate.ok` 命中率 96%，但它会瞬时抖动；用它决定拆/建就是"建一下拆一下"。
           · 像素太少/比例不足（`gate.ok=false`）**只用于失败恢复**：**连续 2 次**才回调
             落图线既有入口 `bldFlush` 把地图那套建回来（一次性，不反复）。
           · 拆除还做**变化驱动**：只有"还发现 bld 层存在"时才动手，并计 `removePasses`
             （修好拉锯后它应停在 1~2，而不是每 1.2 秒都涨）。 */
        try {
          /* 稳定窗口：**连续 ≥ REMOVE_STABLE_FRAMES 帧非空绘制**、且**落图数据已经回来过**
             （`tlLandingAt > 0`）才允许拆 —— 页面刚起/落图还没回来时拆，就是"刷新后没楼"。 */
          const canRenderBuildings =
            state === "running" &&
            nonEmptyFrames >= REMOVE_STABLE_FRAMES &&
            tlLandingAt > 0 &&
            !!data &&
            data.triangles > 0;
          if (!gate.ok) gateFailStreak += 1;
          else gateFailStreak = 0;
          if (canRenderBuildings) {
            bldMode = "overlay";
            if (performance.now() - lastRemoveAt > 1200) {
              lastRemoveAt = performance.now();
              const f = ensureBldLayers(map, "overlay");
              if (f.removed.length) {
                layersRemovedTotal += f.removed.length;
                removePasses += 1;
                if (!tlFirstRemoveAt) tlFirstRemoveAt = Math.round(performance.now() - T0);
              }
            }
          } else if (
            bldMode === "overlay" &&
            lastNonEmptyAt > 0 &&
            performance.now() - lastNonEmptyAt >= 2000 &&
            performance.now() - lastEmptyGuardAt >= 2000
          ) {
            /* **空屏兜底**（真机 2026-10-17「刷新后要么没楼」）：叠加层负责画楼、却已经 ≥2 秒
               没有非空绘制，而地图那套 `bld*` 又不存在 ⇒ 屏幕是空的 ⇒ 立刻走落图线既有入口
               把地图那套建回来（冷却 2 秒，不反复）。 */
            lastEmptyGuardAt = performance.now();
            if (wsBuildingsHost.flush("overlay-empty")) {
              layersRecovered += 1;
              if (!tlFirstRecoverAt) tlFirstRecoverAt = Math.round(performance.now() - T0);
              bldMode = "map";
            }
          } else if (gateFailStreak >= 2 && bldMode === "overlay") {
            /* 叠层画不出楼（连续两次）⇒ 回到地图那套（走落图线既有入口） */
            if (wsBuildingsHost.flush("overlay-failed")) {
              layersRecovered += 1;
              if (!tlFirstRecoverAt) tlFirstRecoverAt = Math.round(performance.now() - T0);
            }
            bldMode = "map";
            gateFailStreak = 0;
          }
        } catch { /* 拆/恢复失败下一帧再来 */ }
        const now2 = performance.now();
        /* ❗"立刻还原"这条**不受节流约束**（画面变空必须当帧处理）；补藏才节流 */
        /* 两类"可先往前修"的判据（**两振出局**），其余条件仍是当帧立刻还原：
           · `pix`：单次读空/偏少可能只是采样点没落上（我原来靠字符串子串判，消息一改就失效，
             真机上因此**单次 0 就读成"立刻还原"**，7 次还原 = 楼闪 7 次）；
           · `cover`：源刚长出来、网格还没跟上时也会短暂偏少。 */
        const soft = !gate.ok && ((gate.kind === "pix" && probe.pixStrikes() < 2) || (gate.kind === "cover" && probe.coverStrikes() < 2));
        if (!gate.ok && !soft) {
          if (hiddenLayers.size) restoreMapBuildings("guard-draw:" + gate.why);
        } else if (gate.ok && now2 - hideSyncAt > 400) {
          hideSyncAt = now2;
          if (hiddenLayers.size !== mapBldLayerIds().length) hideMapBuildings();
        }
      }
    } catch {
      /* 闸自己抛错不许影响渲染；下一次再来 */
    }
    /* 自用对齐探针：**画完**才采（采的就是"屏幕上这一帧"）—— 没开开关时一步不跑 */
    if (probe.alignOn() && probe.alignCorner()) {
      try {
        probe.alignSample();
      } catch {
        /* 量具自己抛错不许影响渲染 */
      }
    }
  }

  /**
   * 重建后**自己补画几帧**，把拆层那条"连续 ≥ `REMOVE_STABLE_FRAMES` 帧非空绘制"的稳定窗口跑满。
   *
   * 为什么需要（2026-10-18 实测）：默认驱动是地图的 `render` 事件；地图**静止时不重绘**
   * ⇒ 重建后只画了 1 帧，`nonEmptyFrames` 永远到不了 10 ⇒ `ensureBldLayers(…, "overlay")`
   * 那条**结构性拆层**永远不放行（地图那套 `bld-*` 只被藏成 `visibility:none`、一直留在样式里）。
   * 这里用真实 RAF 补画（不是伪造计数器）：每帧仍是 `syncCamera()` + `drawOnce()`，
   * 计数、像素闸、`hideMapBuildings()` 全都照常走。有上限（40 帧）防"画不出非空帧"时自锁。
   */
  function kickStableDraws(): void {
    if (stableRaf) return;
    let tries = 0;
    const step = (): void => {
      stableRaf = 0;
      if (state !== "running" || !data || !data.triangles) return;
      if (nonEmptyFrames >= REMOVE_STABLE_FRAMES) return;
      if (++tries > 40) return;
      syncCamera();
      drawOnce();
      if (state === "running" && nonEmptyFrames < REMOVE_STABLE_FRAMES) {
        stableRaf = requestAnimationFrame(step);
      }
    };
    stableRaf = requestAnimationFrame(step);
  }

  /* 自用对齐探针（`?wsalign=1`）已整段搬到 `wsOvProbe.ts`：选角 / 逐帧采样 / 拟合 / 回传 / 徽标。 */

  /* 回传拼装 / 发送在 `wsOvProbe.beaconJson()` / `alignFlush()`；这里不再拼行。 */


  /** `projectFromLastDraw` 的本地实现（对象方法只是转发；自用探针也要调它） */
  function this_projectFromLastDraw(lng: number, lat: number): [number, number] | null {
    if (!lastDraw) return null;
    const xy = toLocal(Number(lng), Number(lat));
    const v = [xy[0], 0, xy[1], 1];
    /* 🔴 矩阵必须按**列主序**读：three 的 `Matrix4.elements` 是列主序（`e[i*4+j]` = 第 j 行第 i 列），
       `Vector3.applyMatrix4` 算的是 `e[0]x + e[4]y + e[8]z + e[12]w`。
       这里原来按**行主序**读（`m[i*4+0..3]`）⇒ 实际乘的是 `Mᵀ·v`，量出来的位置整个是转置的
       （本机实测：同一台相机同一个点，转置口径与原口径差 1071 px，形状就是"镜像 + 放大"）。
       渲染不受影响（那是 three 自己算的），**错的是读数** —— 真机那批 `cur 261 / centerErr 1210`
       就是这么来的。修好之后这个函数必须与 `camera.project()` 逐位一致（有闸盯着）。 */
    return projectPoint(lastDraw.mwInv, lastDraw.proj, [xy[0], xy[1]], lastDraw.w, lastDraw.h);
  }

  /** 地图画完一帧 ⇒ 同一帧把叠加层也画了（`alignMode === 'render'` 时的唯一驱动） */
  function onMapRender(): void {
    if (state !== "running") return;
    const now = performance.now();
    maybeReanchor();          /* render 模式（默认）也要重锚 */
    syncCamera();
    drawOnce();
    frames++;
    /* fps 两种模式都要数：`render` 模式原来只 `frames++`，`stats().fps` 恒为 0
       ⇒ "它到底在不在出帧"这条判据在叠加层上读不出东西（2026-10-11 真页面探针实测）。 */
    fpsFrames++;
    if (!fpsAt) fpsAt = now;
    if (now - fpsAt >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsFrames = 0;
    }
  }

  function tick(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const now = performance.now();
    fpsFrames++;
    if (!fpsAt) fpsAt = now;
    if (now - fpsAt >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsFrames = 0;
    }
    maybeReanchor();
    syncCamera();
    drawOnce();
    raf = requestAnimationFrame(tick);
  }

  /**
   * 地图中心漂太远 ⇒ **重锚 + 重建**（局部平面框架的近似误差随距离平方涨）。
   * 🔴 2026-10-17：这段原来只写在 `tick()`（`raf` 模式）里 —— 而**默认是 `render` 模式**
   * （挂地图的 `render` 事件、RAF 循环根本不跑）⇒ **默认模式下永远不重锚**：
   * 网格一直用最初那个锚点，长距离拖动后局部坐标越漂越大、墨卡托畸变累积
   * （"移动时楼的位移与地图不一致"就有它的一份）⇒ 现在两个驱动**都调**这一个函数。
   */
  function maybeReanchor(): void {
    if (reanchorInFlight) return;
    /* 冷却 1500ms：`getData()` 是整份源，失败时若每帧重试会把帧率打下去 */
    if (lastReanchorAt && performance.now() - lastReanchorAt < 1500) return;
    const v = readMapView();
    if (!v || !anchor || anchorDriftM(v.center) <= REANCHOR_M) return;
    /* 先记下目标锚点；异步取数据、用目标锚点建网格，**建好那一刻**由 `rebuild` 与网格一起切
       （提前切 = 旧实现：旧网格配新相机，整体瞬移）。 */
    reanchorInFlight = true;
    lastReanchorAt = performance.now();
    reanchors += 1;
    const nextAnchor = { lat: v.center.lat, lng: v.center.lng, cos: Math.cos((v.center.lat * Math.PI) / 180) };
    void (async () => {
      try {
        const fc = await grabBld();
        if (fc) {
          rebuild(curThemeId, fc, nextAnchor);
        } else {
          reanchorFails += 1;
        }
      } finally {
        reanchorInFlight = false;
      }
    })();
  }

  /** 挂驱动：`render` 模式挂地图的帧回调，`raf` 模式自己数帧 */
  function attachDrive(): void {
    if (alignMode === "render" && map?.on) {
      map.on("render", onMapRender);
      drawOnce();          // 先画一帧（地图可能暂时不重绘）
    } else if (!raf) {
      raf = requestAnimationFrame(tick);
    }
  }
  function detachDrive(): void {
    try {
      map?.off?.("render", onMapRender);
    } catch {
      /* ignore */
    }
    stopLoop();
  }

  function stopLoop(): void {
    if (raf) {
      try {
        cancelAnimationFrame(raf);
      } catch {
        /* ignore */
      }
      raf = 0;
    }
    if (stableRaf) {
      try {
        cancelAnimationFrame(stableRaf);
      } catch {
        /* ignore */
      }
      stableRaf = 0;
    }
  }

  return {
    id: "overlay",

    async init(h: HTMLElement, s: WsRenderState, world: WsRenderWorld | null): Promise<void> {
      host = h;
      state = "created";
      instance = ledgerPush("overlay", "created");
      let cv: HTMLCanvasElement | null = null;
      try {
        THREE = (await import(/* @vite-ignore */ runtimeUrl(THREE_PATH))) as Record<string, any>;
        const { w, h: hh } = sizeOf();
        cv = document.createElement("canvas");
        cv.className = "ws-overlay-canvas";
        /* 🔴 不接管输入：这一条就是那一条（详见文件头） */
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
        h.appendChild(cv);
        renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: true, powerPreference: "high-performance" });
        ovlCtxCreated++;
        /* 自己这块画布的生死也记账：真机上"划着划着掉回 2D"必须能看出掉的是哪一个上下文 */
        try {
          cv.addEventListener("webglcontextlost", () => { ovlCtxLostEvents++; }, false);
          cv.addEventListener("webglcontextrestored", () => { ovlCtxRestoredEvents++; }, false);
        } catch {
          /* 挂不上监听不影响渲染（计数少一个而已） */
        }
        renderer.setClearAlpha(0);
        /* 名字层的 DOM 写入计数（只读观察，不改它的行为）：
           `?fpshud=1` 那条 fps 采样按标签分桶，但"拖动时标签到底写了多少次"要有个数。 */
        try {
          const labRoot = document.querySelector(".ws-labs");
          const MO = (window as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
          if (labRoot && MO) {
            labelObs = new MO((list) => {
              for (const rec of list) {
                const t = rec.target as Element | null;
                const isNode = !!t && typeof (t as Element).classList?.contains === "function" && (t as Element).classList.contains("ws-lab");
                if (rec.type === "attributes") {
                  labelWrites += 1;
                  if (isNode) labelNodeWrites += 1; else labelContainerWrites += 1;
                } else {
                  const n = rec.addedNodes.length + rec.removedNodes.length;
                  labelWrites += n;
                  labelContainerWrites += n;
                }
              }
            });
            labelObs.observe(labRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
          }
        } catch { labelObs = null; }
        renderer.setPixelRatio(Math.min(dprCapOf(), window.devicePixelRatio || 1));
        renderer.setSize(w, hh, false);
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(fovYDeg(), w / hh, NEAR_M, 8000);
        anchor = { lat: s.center.lat, lng: s.center.lng, cos: Math.cos((s.center.lat * Math.PI) / 180) };
        curThemeId = s.theme || contractTheme.value.theme || "anime";
        /* 楼：先用舞台交进来的那份世界数据（拿不到就去地图 source 里捞一次） */
        const fc = world?.buildings ?? (await grabBld());
        /* `grabBld` 自己记这次的来路（`world` / `mvt` / `source` / `none`）；只有舞台真的交了
           世界数据时才盖成 `world`。原写法 `fc ? "source"` 会把矢量源标成 `source`（假读数）。 */
        if (world?.buildings) lastSource = "world";
        syncCamera();
        if (fc) rebuild(world?.themeId || curThemeId, fc);
        map?.on?.("sourcedata", onSourceData);
        map?.on?.("styledata", onStyleData);
        /* 楼只留一套：地图自己那套先藏起来（名单逐项记下，走的时候还回去） */
        hideMapBuildings();
        state = "running";
        ledgerMark(instance, "running");
        tlRunningAt = Math.round(performance.now() - T0);
        attachDrive();
        /* 自用对齐探针（`?wsalign=1`）：选一次固定角 + 画个徽标；没开开关时这两句都是空转 */
        if (probe.alignOn()) {
          void probe.alignPickCorner();
          probe.alignBadgePaint();
        }
      } catch (e) {
        const msg = "叠加层起不来：" + String((e as Error)?.message || e);
        errors.push(msg);
        try {
          cv?.remove();
        } catch {
          /* 摘不掉不影响回退 */
        }
        stopLoop();
        /* 起不来就把藏过的楼还回去：**失败路径也不许把地图的楼留在隐藏状态** */
        restoreMapBuildings("init-fail");
        renderer = null;
        scene = null;
        camera = null;
        host = null;
        state = "failed";
        ledgerMark(instance, "failed", msg);
        throw new Error(msg);
      }
    },

    /** 舞台把地图实例递进来（地图**一直在**，这就是与 `three` 那条路最大的不同） */
    bindMap(m: unknown): void {
      map = (m as OverlayMapLike) || null;
      map?.on?.("sourcedata", onSourceData);
      map?.on?.("styledata", onStyleData);
      /* 地图后到（先 init 后 bind）⇒ 补藏一次；已经藏过的话这一步是幂等的 */
      if (state === "running") hideMapBuildings();
    },
    unbindMap(): void {
      try {
        map?.off?.("sourcedata", onSourceData);
        map?.off?.("styledata", onStyleData);
      } catch {
        /* ignore */
      }
      map = null;
    },

    applyView(): void {
      /* 叠加层的视野**只从地图读**（这条是它的定义）⇒ 舞台推过来的状态不写相机 */
      syncCamera();
    },

    readView(): WsRenderState | null {
      const v = lastSeen || readMapView();
      if (!v) return null;
      return {
        center: v.center,
        radius: v.radius,
        bearing: v.bearing,
        pitch: v.pitch,
        theme: curThemeId,
        timeOfDay: contractTheme.value.timeOfDay,
        clock: contractTheme.value.clock,
        actors: [],
        selection: null,
      };
    },

    setTheme(theme: string, _timeOfDay: number): void {
      curThemeId = theme || curThemeId;
    },

    setActors(_actors: readonly WsRenderActor[]): void {
      /* 叠加层不画立绘：角色仍由地图那层（2D 立绘/钉子）负责 —— 「除了渲染不一样，其他全一样」 */
    },

    setSelection(_sel: WsRenderSelection | null): void {
      /* 同 `three`：选择只搬运，不在这里画 */
    },

    async captureWorld(): Promise<WsRenderWorld | null> {
      /* 叠加层**不拥有世界数据**（地图一直在）⇒ 由地图后端去交接（舞台那边判） */
      return null;
    },

    pause(): void {
      detachDrive();
      if (assetRaf) {
        cancelAnimationFrame(assetRaf);
        assetRaf = 0;
      }
      state = "paused";
      ledgerMark(instance, "paused");
    },

    resume(): void {
      if (!renderer) return;
      state = "running";
      ledgerMark(instance, "running");
      attachDrive();
    },

    destroy(): void {
      detachDrive();
      probe.dispose();
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      try { labelObs?.disconnect(); } catch { /* ignore */ }
      try { wsDrawnBld.set(null); } catch { /* ignore */ }
      labelObs = null;
      disposeAssets();
      disposeMesh();
      /* 先**摘掉事件**再还原：`setLayoutProperty` 会同步触发 `styledata`，
         监听器还在的话就会把刚还原的楼又藏回去（自己跟自己打架）。 */
      try {
        map?.off?.("sourcedata", onSourceData);
        map?.off?.("styledata", onStyleData);
      } catch {
        /* ignore */
      }
      /* 出场：把地图自己那套楼**逐项还原**（顺序与藏的时候相反） */
      restoreMapBuildings("destroy");
      try {
        renderer?.dispose?.();
        const gl = (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null;
        const lose = gl?.getExtension?.("WEBGL_lose_context") as { loseContext?: () => void } | null;
        if (lose?.loseContext) {
          ovlCtxLost++;
          lose.loseContext();
        }
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
      map = null;
      state = "destroyed";
      ledgerMark(instance, "destroyed");
    },

    /**
     * **局部经纬度 → 屏幕像素**（§1.3 那条"同楼四角 ≤1.5 px"的判据要用它）。
     *
     * 为什么要有：叠加层的楼与 2D 底图必须**对得齐**，而"看着齐"不算判据 —— 得拿同一栋楼的
     * 同一个角，在地图那边 `map.project()` 与这边 `camera.project()` 各算一遍、比像素。
     * 这里投的是**地面点（y=0）**：底图上那个经纬度就在地面上。
     */
    projectLngLat(lng: number, lat: number): [number, number] | null {
      if (!THREE || !camera) return null;
      try {
        const { w, h } = sizeOf();
        const [x, z] = toLocal(Number(lng), Number(lat));
        const v = new THREE.Vector3(x, 0, z).project(camera);
        return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
      } catch {
        return null;
      }
    },

    /**
     * 给探针看的原始读数（**只读**）：这一帧叠加层实际画的那批楼是哪一批。
     *
     * 为什么要它：真机反馈"地图与叠加层的楼不是同一批、明显错位"。要判定是"同一批但投影错位"
     * 还是"两套不同的楼"，就得把**两边各自的 id 表**摆出来做差集 —— 猜没有意义。
     */
    diag(): {
      buildings: number;
      triangles: number;
      ids: string[];
      idsCapped: boolean;
      source: string;
      /** 近景资产那一档：档位/透明度/实际画了多少（不画资产时全 0，不编） */
      asset: {
        on: boolean;
        state: number;
        fade: number;
        /** 楼记录总数 / 视野内可进资产层的栋数（判断"有没有楼被漏在资产层外"） */
        places: number;
        visible: number;
        /** 提亮补丁挂上了没有（1 = 挂上，0 = 走单乘兜底） */
        lift: number;
        mpp: number;
        drawn: number;
        draws: number;
        tris: number;
        pack: { assets: number; verts: number; tris: number; binBytes: number } | null;
        loadMs: number;
        error: string;
        blocked: string;
        syncMs: number;
        syncMsMax: number;
      };
    } {
      const ids = data?.featureIds ?? [];
      return {
        buildings: data?.stats.buildings ?? 0,
        triangles: data?.triangles ?? 0,
        ids,
        idsCapped: false,
        source: lastSource,
        asset: {
          on: assetOn,
          state: assetState,
          fade: Math.round(assetFade * 1000) / 1000,
          places: data ? Math.floor(data.places.length / 8) : 0,
          visible: assetLayer ? assetLayer.visible() : 0,
          lift: assetLayer ? assetLayer.lifted() : 0,
          mpp: Math.round(assetMpp * 1000) / 1000,
          drawn: assetDrawn,
          draws: assetLayer && assetLayer.group.visible ? assetLayer.draws() : 0,
          tris: assetDrawnTris,
          pack: assetPack
            ? {
                assets: assetPack.counts.assets,
                verts: assetPack.counts.verts,
                tris: assetPack.counts.tris,
                binBytes: assetPack.binBytes,
              }
            : null,
          loadMs: assetLoadMs,
          error: assetError,
          blocked: assetBlocked,
          syncMs,
          syncMsMax,
        },
      };
    },

    /**
     * **上一次真的画出去那一帧**里，某个经纬度（地面 y=0）落在屏幕的哪儿。
     * 逐帧对拍要读的是"屏幕上是什么"，不是"现在是什么" —— 所以用快照矩阵手算，
     * 不借 three 的 `project()`（它算的是**当下**的相机）。
     */
    projectFromLastDraw(lng: number, lat: number): [number, number] | null {
      return this_projectFromLastDraw(lng, lat);
    },

    /**
     * 藏/还原的**账**（只读）：名单 + 计数，外加**现在**回地图上读一遍的真实可见性。
     *
     * 为什么带 `live`：只报自己记的数就是自说自话 —— 判据要读**地图那边**的实际状态。
     */
    hiddenInfo(): {
      hid: number;
      restored: number;
      rebinds: number;
      ids: string[];
      prev: Array<string | null>;
      live: Array<{ id: string; vis: string | null }>;
      drift: number;
      rounds: number;
      timerArmed: boolean;
    } {
      const m = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
      const live = mapBldLayerIds().map((id) => {
        let vis: string | null = null;
        try {
          const v = m?.getLayoutProperty?.(id, "visibility");
          vis = v === undefined || v === null ? null : String(v);
        } catch {
          vis = null;
        }
        return { id, vis };
      });
      return {
        hid: hidCount,
        restored: restoredCount,
        rebinds: mapRebinds,
        ids: [...hiddenLayers.keys()],
        prev: [...hiddenLayers.values()],
        drift: hideDrift,
        rounds: hideRounds,
        timerArmed: hideVerifyTimer !== 0,
        live,
      };
    },

    /**
     * **逐项 dump 三组矩阵 + 同一个测试点在四种口径下的像素**（2026-10-14）。
     *
     * 为什么要它：真机那批回传说"叠加层实际画出去那一帧 vs 地图"差 844~1210 px，而纯数学那张表
     * 说两套投影逐点 ≤0.005 px ⇒ 两者不是同一条路。把三组摆出来两两比，就能分开：
     *   · `drawn` = **上次真的画出去那一帧**的快照（`ageMs` 告诉你是多久以前的）；
     *   · `live`  = 查的这一刻相机对象上的矩阵；
     *   · `model` = 用**同一份相机公式**（`camFrameOf`）现建一台相机算出来的矩阵；
     *   · `test`  = 同一个经纬度在 地图 / 画出去那帧 / 现读相机 / 模型相机 下的像素。
     * 口径本身由 `wsMatMul` 与那条对拍闸看着（生产代码里不留"错误口径对照"）。
     */
    frameDump(lng: number, lat: number): Record<string, unknown> {
      const { w, h } = sizeOf();
      const els = (m: unknown): number[] | null => {
        try {
          const e = (m as { elements?: ArrayLike<number> })?.elements;
          return e ? Array.from(e) : null;
        } catch {
          return null;
        }
      };
      const local = toLocal(Number(lng), Number(lat));
      const drawn = lastDraw ? { mwInv: lastDraw.mwInv, proj: lastDraw.proj, w: lastDraw.w, h: lastDraw.h } : null;
      const live = camera ? { mwInv: els((camera as unknown as { matrixWorldInverse?: unknown }).matrixWorldInverse), proj: els((camera as unknown as { projectionMatrix?: unknown }).projectionMatrix) } : null;
      /* 模型相机：与 `syncCamera` 同一份公式（`applyCamFrame`）现建一台，独立于当前相机对象 */
      let model: { mwInv: number[] | null; proj: number[] | null } | null = null;
      const v = lastSeen || readMapView();
      try {
        if (THREE && v) {
          const mc = new THREE.PerspectiveCamera(fovYDeg(), w / h, NEAR_M, 8000);
          applyCamFrame(mc as unknown as Record<string, any>, v, w, h);
          model = { mwInv: els((mc as unknown as { matrixWorldInverse?: unknown }).matrixWorldInverse), proj: els((mc as unknown as { projectionMatrix?: unknown }).projectionMatrix) };
        }
      } catch {
        model = null;
      }
      const mapP = (() => {
        try {
          const p = (map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null)?.project?.([Number(lng), Number(lat)]);
          return p ? [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))] : null;
        } catch {
          return null;
        }
      })();
      return {
        w,
        h,
        drawnAgeMs: lastDrawAt ? Number((performance.now() - lastDrawAt).toFixed(1)) : null,
        drawnProj: drawn?.proj ?? null,
        drawnMwInv: drawn?.mwInv ?? null,
        liveProj: live?.proj ?? null,
        liveMwInv: live?.mwInv ?? null,
        modelProj: model?.proj ?? null,
        modelMwInv: model?.mwInv ?? null,
        drawnEqLive: matEq(drawn?.mwInv ?? null, live?.mwInv ?? null) === true && matEq(drawn?.proj ?? null, live?.proj ?? null) === true,
        liveEqModel: matEq(live?.mwInv ?? null, model?.mwInv ?? null) === true && matEq(live?.proj ?? null, model?.proj ?? null) === true,
        test: {
          lng: Number(lng),
          lat: Number(lat),
          mapPx: mapP,
          drawnPx: projectPoint(drawn?.mwInv ?? null, drawn?.proj ?? null, local, drawn?.w ?? w, drawn?.h ?? h),
          livePx: projectPoint(live?.mwInv ?? null, live?.proj ?? null, local, w, h),
          modelPx: projectPoint(model?.mwInv ?? null, model?.proj ?? null, local, w, h),
        },
      };
    },

    /**
     * 自用对齐探针的读数（没开开关就是 null）。
     *
     * `centerErr` 与 HUD 徽标上那个"中心"**是同一个量**（同一处代码路径、同一个变量）——
     * 真机那次两边差得远，是因为徽标逐帧刷、回传每 2 秒才发，读的不是同一刻。
     * 现在 `alignFlush()` 发车前会**现算一遍**中心误差，这条读数就与回传里的 `centerErr` 对齐了。
     */
    alignStats(): { on: boolean; cur: number; max: number; n: number; reports: number; centerErr: number | null; offScreen: number; fit: { a: number; b: number; n: number } | null } | null {
      return probe.alignStats();
    },

    /** 探针用：切换对齐模式（`render` = 同帧；`raf` = 各跑各的）——A/B 对比用 */
    setAlignMode(m: string): string {
      const want = m === "raf" ? "raf" : "render";
      if (want === alignMode) return alignMode;
      alignMode = want;
      detachDrive();
      attachDrive();
      return alignMode;
    },

    stats(): WsRenderStats {
      const st = data?.stats;
      return {
        backend: "overlay",
        draws,
        dpr: renderer?.getPixelRatio?.() ?? 1,
        fps: Math.round(fps * 10) / 10,
        rendering: state === "running",
        note:
          `${st?.buildings ?? 0} 栋（叠加在地图上） / ${data?.triangles ?? 0} 三角` +
          (hidCount ? ` / 藏起地图楼 ${hidCount} 层` : ` / 没藏地图楼（${hideGateWhy}）`) +
          ` / 覆盖 源${cover.expected}:实画${cover.actual}（视野外 网格${cover.meshOut}·源${cover.srcOut}）` +
          (cover.thinDropped || cover.shapeDropped ? `（丢扁 ${cover.thinDropped}·丢形 ${cover.shapeDropped}）` : "") +
          (restoredCount ? ` / 已还原 ${restoredCount} 层` : "")
          + ` / 相机跟地图：${lastSeen ? "在跟" : "还没读到"}`
          + (errors.length ? ` / ⚠️ ${errors[0]}` : "")
          + probe.alignNote(),
      };
    },
  } as WsRenderBackend & { bindMap(m: unknown): void; unbindMap(): void };
}
