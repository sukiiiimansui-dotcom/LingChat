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

import { BLD_CAP, buildBldMeshData, type BldMeshData } from "./wsBldMesh";
import {
  contractTheme,
  metersPerPixelAt,
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
import { camFrameOf, farOf, nearOf } from "./wsThreeCam";

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

/**
 * **量具身份**：这把尺子自己改一次就 +1。
 *
 * 为什么非要它：真机回传是异步、跨版本混在一起看的 —— 没有版本号时，
 * "这条读数是新尺子量的还是旧尺子量的"只能靠猜，而两者的字段含义并不一样
 * （旧尺子的 `corner` 不过滤屏外点，读数不可比）。
 *   1 = 初版（`corner` 不过滤屏外点，无 `offScreen`/`fit`/`geom`）
 *   2 = 过滤屏外点 + `offScreen`/`centerErr`/`fit`/`raw`/`geom`
 *   3 = 叠加层藏起地图那套楼（读数含义随之变：屏上只剩一套楼）+ 回传带 `ver`/`search`
 */
const ALIGN_VER = 3;

/** 自用开关：`?wsalign=1` 才装 */
export function alignProbeWanted(): boolean {
  try {
    return new URLSearchParams(location.search).get("wsalign") === "1";
  } catch {
    return false;
  }
}

/** 一行回传（`<img>` beacon；跨端口没问题，不用 fetch ⇒ 不会因 CORS/预检卡住） */
function beacon(row: Record<string, unknown>): void {
  try {
    const j = encodeURIComponent(JSON.stringify(row));
    const img = new Image();
    img.src = `http://127.0.0.1:8795/__wslog?tag=align_phone&j=${j}`;
  } catch {
    /* 回传失败不影响页面（它本来就只是量具） */
  }
}

/** 只写用得到的形状（**不 import maplibre 的类型**：引擎结构不许泄进这里） */
interface OverlayMapLike {
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  getCanvas: () => { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
  getSource?: (id: string) => { getData?: () => Promise<unknown> } | undefined;
  on?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
  off?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
}

export function createOverlayBackend(): WsRenderBackend {
  let THREE: Record<string, any> | null = null;
  let renderer: any = null;
  let scene: any = null;
  let camera: any = null;
  let host: HTMLElement | null = null;
  let map: OverlayMapLike | null = null;
  let bldMesh: any = null;
  let data: BldMeshData | null = null;
  /** 局部平面框架的锚点（地图中心漂太远就重锚） */
  let anchor: { lat: number; lng: number; cos: number } | null = null;
  let state: "created" | "running" | "paused" | "destroyed" | "failed" = "created";
  let raf = 0;
  let frames = 0;
  let draws = 0;
  let fps = 0;
  let fpsAt = 0;
  let fpsFrames = 0;
  /** 每帧从地图读到的四量（**只是读数的缓存**，不是"我们的相机状态"） */
  let lastSeen: { center: { lat: number; lng: number }; radius: number; bearing: number; pitch: number } | null = null;
  let refreshTimer = 0;
  const errors: string[] = [];

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

  /** 每帧：把地图的相机搬进 three（正解走 `wsThreeCam`，与独立那条路同一个模型） */
  function syncCamera(): void {
    if (!camera) return;
    const v = readMapView();
    if (!v) return;
    lastSeen = v;
    const { w, h } = sizeOf();
    const [cx, cz] = toLocal(v.center.lng, v.center.lat);
    const f = camFrameOf(cx, cz, v.radius, v.bearing, v.pitch);
    camera.position.set(f.pos[0], f.pos[1], f.pos[2]);
    const m = new THREE!.Matrix4();
    m.makeBasis(
      new THREE!.Vector3(f.xAxis[0], f.xAxis[1], f.xAxis[2]),
      new THREE!.Vector3(f.yAxis[0], f.yAxis[1], f.yAxis[2]),
      new THREE!.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2])
    );
    camera.quaternion.setFromRotationMatrix(m);
    camera.near = nearOf(f.dist);
    camera.far = farOf(f.dist, v.radius);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
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
  function hideMapBuildings(): void {
    const m = map as unknown as {
      getLayoutProperty?: (id: string, k: string) => unknown;
      setLayoutProperty?: (id: string, k: string, v: unknown) => void;
    } | null;
    if (!m?.setLayoutProperty || state === "destroyed") return;
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
      } catch {
        /* 单层失败不影响其它层（也不记进名单，免得还的时候报错） */
        continue;
      }
      if (!known) hiddenLayers.set(id, prev === undefined ? null : prev);
    }
    hidCount = hiddenLayers.size;
  }

  /** 出场：**倒序**把藏起来的楼逐项还原（与藏的顺序相反，成对出现；失败路径也走它） */
  function restoreMapBuildings(): void {
    if (!hiddenLayers.size) return;
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

  /** 用一份 `bld` 要素重建楼（几何走共用模块 ⇒ 与 three 那条路画的是同一批） */
  function rebuild(themeId: string, fc: WsRenderFc | null): void {
    disposeMesh();
    data = null;
    if (!THREE || !scene || !fc) return;
    data = buildBldMeshData({
      features: fc.features,
      toLocal: (lng: number, lat: number) => toLocal(lng, lat),
      themeId,
      cap: BLD_CAP,
    });
    if (!data.triangles) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(data.positions), 3));
    g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(data.colors), 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    bldMesh = new THREE.Mesh(g, mat);
    bldMesh.name = "ws-overlay-buildings";
    scene.add(bldMesh);
    /* 数据是**后到**的（`sourcedata` / 重锚）⇒ 重建完立刻画一帧：
       渲染是"地图画完一帧"驱动的，地图静止时不会再来 render，等它就等于这一批楼不显示。 */
    drawOnce();
  }

  /** 从地图 source 里捞一份 `bld`（与 `three` 那条路同一条数据通路） */
  async function grabBld(): Promise<WsRenderFc | null> {
    try {
      const src = map?.getSource?.("bld");
      if (!src?.getData) return null;
      const d = (await src.getData()) as WsRenderFc | null;
      if (!d || !Array.isArray(d.features)) return null;
      return { type: "FeatureCollection", features: d.features };
    } catch {
      return null;
    }
  }

  /** 后到的数据自己补上（`bld` 落图 ⇒ 重建）；防抖，别在一次落图里重建十遍 */
  function scheduleRefresh(): void {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc);
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
  }

  const onSourceData = (e: { sourceId?: string }): void => {
    if (e?.sourceId !== "bld") return;
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
    hideMapBuildings();
  };

  let curThemeId = "anime";
  /* ── 自用对齐探针的状态（`?wsalign=1` 才用；默认全是空转） ── */
  const alignOn = alignProbeWanted();
  let alignCorner: [number, number] | null = null;
  const alignErrs: number[] = [];
  /** 逐帧 `(离画布中心多少像素, 误差)` —— 用来分清"误差∝距离(比例差)"与"误差≈常数(整体偏移)" */
  const alignPairs: Array<{ d: number; e: number }> = [];
  /** 屏外 / 相机背后 / 投不出来的样本：**单独计数、不进 cur·med·max** */
  let alignOffScreen = 0;
  /** 地图中心那一点的两边投影差（**基准点**：不为 0 就说明相机/画布基准有问题，不是尺度） */
  let alignCenterErr: number | null = null;
  let alignRaw: Array<{ mx: number; my: number; ox: number; oy: number; d: number; e: number }> = [];
  let alignMax = 0;
  let alignCur = 0;
  let alignReports = 0;
  let alignLastReportAt = 0;
  let alignStaticTimer = 0;
  let alignBadge: HTMLElement | null = null;
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
   * 怎么跟地图对齐（**这是"拖动时位移不一致"那条的头号嫌疑**）：
   *   · `render`（默认）：挂 `map.on('render')` —— 地图画完一帧就叫我们，**同一帧**用它的相机画叠加层；
   *   · `raf`：自己的 `requestAnimationFrame`（老行为）。地图与叠加层各跑各的节奏，
   *     拖动时相机读数可能差一帧 ⇒ **静止看不出来、一动就按速度成比例地错开**。
   * 保留两种是为了让探针在**同一页面、同一段拖动**里 A/B 对比（不是靠讲道理）。
   */
  let alignMode: "render" | "raf" = "render";
  /** 上一次**真的画出去**那一帧的相机矩阵（逐帧对拍要看"屏幕上是什么"，不是"现在是什么"） */
  let lastDraw: { mwInv: number[]; proj: number[]; w: number; h: number } | null = null;
  /** 这一帧那批楼**从哪儿来**（`world` = 舞台交进来的那份 / `source` = 从地图 source 现捞的） */
  let lastSource = "none";

  /** 真的画一帧（并把"画的时候"的相机矩阵快照下来 —— 逐帧对拍读的就是它） */
  function drawOnce(): void {
    if (state !== "running" || !renderer || !scene || !camera) return;
    const { w, h } = sizeOf();
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
    renderer.render(scene, camera);
    draws = renderer.info?.render?.calls ?? 0;
    /* 自用对齐探针：**画完**才采（采的就是"屏幕上这一帧"）—— 没开开关时 alignOn=false，一步不跑 */
    if (alignOn && alignCorner) {
      try {
        alignSample();
      } catch {
        /* 量具自己抛错不许影响渲染 */
      }
    }
  }

  /* ── 自用对齐探针（只在 `?wsalign=1` 时真跑） ───────────────────────────────── */
  /** 选一个"固定的角"：拿地图 `bld` 源里第一栋的第一个环点，投票到屏幕中心最近的那个 —— **只选一次** */
  async function alignPickCorner(): Promise<void> {
    if (!alignOn || alignCorner) return;
    try {
      const fc = await grabBld();
      const feats = (fc?.features || []) as Array<{ geometry?: unknown }>;
      const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
      const { w, h } = sizeOf();
      const cx = w / 2;
      const cy = h / 2;
      let best: [number, number] | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const f of feats) {
        const g = f?.geometry as { type?: string; coordinates?: unknown } | null;
        const cs = g?.coordinates as unknown;
        const first = Array.isArray(cs) && Array.isArray(cs[0]) && Array.isArray((cs[0] as unknown[])[0])
          ? ((cs[0] as unknown[])[0] as unknown[])
          : Array.isArray(cs) && Array.isArray(cs[0])
            ? (cs[0] as unknown[])
            : null;
        if (!first) continue;
        const lng = Number(first[0]);
        const lat = Number(first[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const p = m?.project?.([lng, lat]);
        if (!p) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestD) {
          bestD = d;
          best = [lng, lat];
        }
      }
      alignCorner = best;
      if (best && map) {
        const m2 = map as unknown as { on?: (ev: string, cb: () => void) => void };
        m2.on?.("moveend", () => {
          alignFlush("moveend");
          if (alignStaticTimer) window.clearTimeout(alignStaticTimer);
          /* 停手 1 秒后再记一组（静止基准）—— 真机上"静止对不齐"与"动起来才错"是两回事 */
          alignStaticTimer = window.setTimeout(() => alignFlush("static"), 1000);
        });
      }
    } catch {
      /* 选不到角就不装（如实：量不到就不量，不编一个坐标） */
    }
  }

  /**
   * 当前那一帧的像素差（地图当下 vs 叠加层上次画出去那一帧）。
   *
   * 🔴 2026-10-11 改（真机那 8 条回传暴露的问题）：原来**什么点都计**，而目标角可能早就跑到
   * 屏幕外 1.1 km（真机 `center.lat` 与 `corner.lat` 差 0.0102°），在高俯仰下两套投影只要略有
   * 差异就会被放大成几百像素 ⇒ `cur/med/max` 全被"远点在俯视下的放大"主导，没有意义。
   * 现在：**只统计落在画布内（留边距）的点**；屏外/相机背后/投不出来的**单独计数**（`offScreen`），
   * 不进 cur·med·max。同时记 `dPx`（离画布中心多少像素）与中心基准点误差。
   */
  function alignSample(): void {
    if (!alignOn || !alignCorner || !map) return;
    const m = map as unknown as {
      project?: (c: [number, number]) => { x: number; y: number };
      getCenter?: () => { lat: number; lng: number };
    } | null;
    const { w, h } = sizeOf();
    /* 基准点：地图中心那一点。它必须 ≈0 —— 不为 0 说明相机/画布基准不对，与"尺度/远近"无关。 */
    try {
      const c = m?.getCenter?.();
      if (c) {
        const a0 = m?.project?.([c.lng, c.lat]);
        const b0 = this_projectFromLastDraw(c.lng, c.lat);
        if (a0 && b0) alignCenterErr = Math.hypot(a0.x - b0[0], a0.y - b0[1]);
      }
    } catch {
      /* 基准点量不到就先不算（不影响屏内点那一组） */
    }
    const a = m?.project?.(alignCorner);
    const b = this_projectFromLastDraw(alignCorner[0], alignCorner[1]);
    const cx = w / 2;
    const cy = h / 2;
    const inView = (x: number, y: number): boolean => x >= 8 && x <= w - 8 && y >= 8 && y <= h - 8;
    if (!a || !b) {
      alignOffScreen++;
      return;
    }
    if (!inView(a.x, a.y) || !inView(b[0], b[1])) {
      /* 地图那侧或叠加层那侧把这个点投到屏外/背后 ⇒ 排除（两边都得在屏内才有可比性） */
      alignOffScreen++;
      return;
    }
    const e = Math.hypot(a.x - b[0], a.y - b[1]);
    const dPx = Math.hypot(a.x - cx, a.y - cy);
    alignCur = e;
    alignErrs.push(e);
    alignPairs.push({ d: dPx, e });
    if (alignErrs.length > 240) alignErrs.shift();
    if (alignPairs.length > 240) alignPairs.shift();
    if (e > alignMax) alignMax = e;
    if (alignRaw.length < 3) alignRaw.push({ mx: Number(a.x.toFixed(2)), my: Number(a.y.toFixed(2)), ox: Number(b[0].toFixed(2)), oy: Number(b[1].toFixed(2)), d: Number(dPx.toFixed(2)), e: Number(e.toFixed(2)) });
    alignBadgePaint();
    const now = performance.now();
    if (now - alignLastReportAt > 2000) alignFlush("moving");
  }

  /** 最小二乘拟合 `err ≈ a + b·dPx`：`a` 大 = 整体偏移；`b` 大 = 比例/尺度差 */
  function alignFit(): { a: number; b: number; n: number } | null {
    const ps = alignPairs;
    if (ps.length < 4) return null;
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (const p of ps) { sx += p.d; sy += p.e; sxx += p.d * p.d; sxy += p.d * p.e; }
    const n = ps.length;
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;
    const b = (n * sxy - sx * sy) / den;
    const a = (sy - b * sx) / n;
    return { a: Number(a.toFixed(3)), b: Number(b.toFixed(4)), n };
  }

  /** 回传一条（`moveend` 必发；其余按 2 秒节流） */
  function alignFlush(kind: string): void {
    if (!alignOn || !alignCorner) return;
    const m = map as unknown as {
      getCenter?: () => { lat: number; lng: number };
      getZoom?: () => number;
      getBearing?: () => number;
      getPitch?: () => number;
      unproject?: (p: [number, number]) => { lat: number; lng: number };
    } | null;
    let mppRatio: number | null = null;
    try {
      /* 不动地图、不借内部字段：屏幕横轴上量 200 px 对应多少米（unproject 两次） */
      const { w, h } = sizeOf();
      const c0 = m?.unproject?.([w / 2, h / 2]);
      const c1 = m?.unproject?.([w / 2 + 200, h / 2]);
      if (c0 && c1) {
        const kx = 111320 * Math.cos((((c0.lat + c1.lat) / 2) * Math.PI) / 180);
        const ky = 110540;
        const dMeters = Math.hypot((c1.lng - c0.lng) * kx, (c1.lat - c0.lat) * ky);
        const measured = dMeters / 200;
        const ours = metersPerPixelAt(Number(m?.getCenter?.().lat ?? 0), Number(m?.getZoom?.() ?? 0));
        mppRatio = measured > 0 ? Number((ours / measured).toFixed(4)) : null;
      }
    } catch {
      mppRatio = null;
    }
    const sorted = [...alignErrs].sort((x, y) => x - y);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    /* 🆕 **画布几何**（下一号嫌疑）：两套投影在纯数学上已经逐点 ≤0.005 px（见
       world_map/ws_proj_table_probe.mjs 那张表）⇒ 屏上若真错开，只剩"两块画布不一样大/
       不一样位/不一样 DPR"这类**非数学**因素。这里把它们如实报出去。 */
    let geom: Record<string, unknown> | null = null;
    try {
      const doc = document;
      const mapCv = doc.querySelector(".maplibregl-canvas") || doc.querySelector(".ws-dml__cv");
      const ovlCv = renderer?.domElement as HTMLCanvasElement | undefined;
      const box = (el: Element | null | undefined): unknown => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const c = el as HTMLCanvasElement;
        return {
          cls: String((el as HTMLElement).className || ""),
          rect: [Number(r.left.toFixed(2)), Number(r.top.toFixed(2)), Number(r.width.toFixed(2)), Number(r.height.toFixed(2))],
          buf: [c.width ?? null, c.height ?? null],
          style: [(el as HTMLElement).style?.width || "", (el as HTMLElement).style?.height || ""],
        };
      };
      geom = { dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : null, map: box(mapCv), overlay: box(ovlCv) };
    } catch {
      geom = null;
    }
    alignReports++;
    alignLastReportAt = performance.now();
    beacon({
      /* 量具身份：`ver` = 尺子版本，`search` = 这份读数是在什么参数下取的 */
      ver: ALIGN_VER,
      search: (() => {
        try {
          return String(location.search || "");
        } catch {
          return "";
        }
      })(),
      kind,
      corner: alignCorner,
      cur: Number(alignCur.toFixed(3)),
      max: Number(alignMax.toFixed(3)),
      med: med === null ? null : Number(med.toFixed(3)),
      n: alignErrs.length,
      /* 🆕 屏外计数（**不进 cur·med·max**）+ 中心基准点 + (dPx,err) 拟合 + 至少 3 组原始屏幕坐标 */
      offScreen: alignOffScreen,
      centerErr: alignCenterErr === null ? null : Number(alignCenterErr.toFixed(3)),
      fit: alignFit(),
      raw: alignRaw.slice(-3),
      geom: geom,
      reports: alignReports,
      center: m?.getCenter?.() ?? null,
      zoom: m?.getZoom?.() ?? null,
      bearing: m?.getBearing?.() ?? null,
      pitch: m?.getPitch?.() ?? null,
      mppRatio,
      bld: data?.stats.buildings ?? 0,
      tris: data?.triangles ?? 0,
    });
  }

  /** HUD 上看得见的那一行（自用；关掉开关就没有它） */
  function alignBadgePaint(): void {
    if (!alignOn) return;
    try {
      if (!alignBadge) {
        alignBadge = document.createElement("div");
        alignBadge.className = "ws-align-badge";
        alignBadge.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:9999;background:#000a;color:#8fe;font:12px ui-monospace,monospace;padding:2px 6px;border-radius:4px;pointer-events:none";
        document.body.appendChild(alignBadge);
      }
      const sorted = [...alignErrs].sort((x, y) => x - y);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const f = alignFit();
      alignBadge.textContent = `align: cur ${alignCur.toFixed(2)} / max ${alignMax.toFixed(2)} / med ${med.toFixed(2)} px`
        + ` · 中心 ${alignCenterErr === null ? "?" : alignCenterErr.toFixed(2)}`
        + ` · 拟合 a=${f ? f.a : "?"} b=${f ? f.b : "?"}`
        + ` · 屏外 ${alignOffScreen} · n=${alignErrs.length} · 报 ${alignReports}`;
    } catch {
      /* 徽标画不出来不影响量具 */
    }
  }

  /** 给 `stats().note` 用的那一句（自用；没开开关就是空串） */
  function alignNote(): string {
    if (!alignOn) return "";
    return ` / align(cur ${alignCur.toFixed(2)} max ${alignMax.toFixed(2)} px · n=${alignErrs.length})`;
  }

  /** `projectFromLastDraw` 的本地实现（对象方法只是转发；自用探针也要调它） */
  function this_projectFromLastDraw(lng: number, lat: number): [number, number] | null {
    if (!lastDraw) return null;
    const xy = toLocal(Number(lng), Number(lat));
    const v = [xy[0], 0, xy[1], 1];
    const mul = (m: number[], p: number[]): number[] => {
      const o = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        o[i] = m[i * 4]! * p[0]! + m[i * 4 + 1]! * p[1]! + m[i * 4 + 2]! * p[2]! + m[i * 4 + 3]! * p[3]!;
      }
      return o;
    };
    const cam = mul(lastDraw.mwInv, v);
    const clip = mul(lastDraw.proj, cam);
    if (!Number.isFinite(clip[3]!) || Math.abs(clip[3]!) < 1e-9) return null;
    return [((clip[0]! / clip[3]! + 1) / 2) * lastDraw.w, ((1 - clip[1]! / clip[3]!) / 2) * lastDraw.h];
  }

  /** 地图画完一帧 ⇒ 同一帧把叠加层也画了（`alignMode === 'render'` 时的唯一驱动） */
  function onMapRender(): void {
    if (state !== "running") return;
    const now = performance.now();
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
    /* 地图中心漂太远 ⇒ 重锚 + 重建（局部框架的近似误差随距离平方涨） */
    const v = readMapView();
    if (v && anchor && anchorDriftM(v.center) > REANCHOR_M) {
      anchor = { lat: v.center.lat, lng: v.center.lng, cos: Math.cos((v.center.lat * Math.PI) / 180) };
      void (async () => {
        const fc = await grabBld();
        if (fc) {
          lastSource = "source";
          rebuild(curThemeId, fc);
        }
      })();
    }
    syncCamera();
    drawOnce();
    raf = requestAnimationFrame(tick);
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
  }

  return {
    id: "overlay",

    async init(h: HTMLElement, s: WsRenderState, world: WsRenderWorld | null): Promise<void> {
      host = h;
      state = "created";
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
        renderer.setClearAlpha(0);
        renderer.setPixelRatio(Math.min(3, window.devicePixelRatio || 1));
        renderer.setSize(w, hh, false);
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(36.87, w / hh, 0.6, 8000);
        anchor = { lat: s.center.lat, lng: s.center.lng, cos: Math.cos((s.center.lat * Math.PI) / 180) };
        curThemeId = s.theme || contractTheme.value.theme || "anime";
        /* 楼：先用舞台交进来的那份世界数据（拿不到就去地图 source 里捞一次） */
        const fc = world?.buildings ?? (await grabBld());
        lastSource = world?.buildings ? "world" : fc ? "source" : "none";
        syncCamera();
        if (fc) rebuild(world?.themeId || curThemeId, fc);
        map?.on?.("sourcedata", onSourceData);
        map?.on?.("styledata", onStyleData);
        /* 楼只留一套：地图自己那套先藏起来（名单逐项记下，走的时候还回去） */
        hideMapBuildings();
        state = "running";
        attachDrive();
        /* 自用对齐探针（`?wsalign=1`）：选一次固定角 + 画个徽标；没开开关时这两句都是空转 */
        if (alignOn) {
          void alignPickCorner();
          alignBadgePaint();
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
        restoreMapBuildings();
        renderer = null;
        scene = null;
        camera = null;
        host = null;
        state = "failed";
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
      state = "paused";
    },

    resume(): void {
      if (!renderer) return;
      state = "running";
      attachDrive();
    },

    destroy(): void {
      detachDrive();
      if (alignStaticTimer) window.clearTimeout(alignStaticTimer);
      alignStaticTimer = 0;
      try {
        alignBadge?.remove?.();
      } catch {
        /* ignore */
      }
      alignBadge = null;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = 0;
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
      restoreMapBuildings();
      try {
        renderer?.dispose?.();
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
      map = null;
      state = "destroyed";
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
    diag(): { buildings: number; triangles: number; ids: string[]; idsCapped: boolean; source: string } {
      const ids = data?.featureIds ?? [];
      return {
        buildings: data?.stats.buildings ?? 0,
        triangles: data?.triangles ?? 0,
        ids,
        idsCapped: false,
        source: lastSource,
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
      ids: string[];
      prev: Array<string | null>;
      live: Array<{ id: string; vis: string | null }>;
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
        ids: [...hiddenLayers.keys()],
        prev: [...hiddenLayers.values()],
        live,
      };
    },

    /** 自用对齐探针的读数（没开开关就是 null） */
    alignStats(): { on: boolean; cur: number; max: number; n: number; reports: number } | null {
      if (!alignOn) return null;
      return { on: true, cur: Number(alignCur.toFixed(3)), max: Number(alignMax.toFixed(3)), n: alignErrs.length, reports: alignReports };
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
          (hidCount ? ` / 藏起地图楼 ${hidCount} 层` : "") +
          (restoredCount ? ` / 已还原 ${restoredCount} 层` : "")
          + ` / 相机跟地图：${lastSeen ? "在跟" : "还没读到"}`
          + (errors.length ? ` / ⚠️ ${errors[0]}` : "")
          + alignNote(),
      };
    },
  } as WsRenderBackend & { bindMap(m: unknown): void; unbindMap(): void };
}
