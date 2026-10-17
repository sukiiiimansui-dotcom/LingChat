/* wsOvProbe.ts —— 叠加层的**回传拼装 / 取证 / 计数**（自用层，从 `wsOverlayBackend.ts` 搬出）。
 *
 * ## 这一段是什么
 * 真机排查用的量具与账本，**不是产品功能**：对齐像素差、藏/还原账、覆盖面、像素取证、
 * 每帧分解、启动时间线，最后拼成一条 `<img>` beacon 回传。
 *
 * ## 边界（Phase 2 第 1 步）
 * · 本模块**只读**宿主递进来的只读快照（`OvProbeView`，每调用一次现取，不是缓存），
 *   以及 `wsRenderBackend` 那几个既有登记处；**不碰渲染路径**。
 * · 渲染/数据路径里的计数仍写在宿主（`drawOnce` / `rebuild` / 藏楼那几段一个字没动），
 *   这里只做**汇总与拼装**；探针自己的计数（像素取证、覆盖 strikes、对齐样本）归本模块。
 * · 搬出来的是**函数体逐字**：唯一的改动是每个函数开头把宿主快照解构成本地同名变量
 *   （`const { map, renderer, data, ... } = view();`），以及 `alignFlush` 拆成
 *   `beaconJson()`（拼装、返回行）+ `alignFlush()`（发送）。
 */

import { alignProbeOn, metersPerPixelAt, wsDiag, wsLiveMap } from "./wsRenderBackend";
import type { BldMeshData } from "./wsBldMesh";

/**
 * **量具身份**：这把尺子自己改一次就 +1。
 *
 * 为什么非要它：真机回传是异步、跨版本混在一起看的 —— 没有版本号时，
 * "这条读数是新尺子量的还是旧尺子量的"只能靠猜，而两者的字段含义并不一样
 * （旧尺子的 `corner` 不过滤屏外点，读数不可比）。
 *   1 = 初版（`corner` 不过滤屏外点，无 `offScreen`/`fit`/`geom`）
 *   2 = 过滤屏外点 + `offScreen`/`centerErr`/`fit`/`raw`/`geom`
 *   3 = 叠加层藏起地图那套楼（读数含义随之变：屏上只剩一套楼）+ 回传带 `ver`/`search`
 *   4 = **矩阵口径修正**（"画出去那一帧"的投影原先按行主序读 = 转置口径，量出来的位置
 *       整个是错的，真机那批 844~1210 px 就是这么来的）+ `centerErr` 改成**发车前现算**
 *       + 回传带上下文/降级账（`ctx`/`engine`）。⚠️ **≤3 的读数与 ≥4 不可比。**
 *   5 = 加 `nameBind`（名字↔楼 id / 楼顶锚点 / 回退账）。⚠️ **≤4 没有这一栏**（不是 0）。
 */
const ALIGN_VER = 5;

/**
 * 自用开关：`?ovlpix=0` **关掉"像素取证"那一道**（默认开）。
 *
 * 为什么需要它：本机无头没有可用的 GPU（SwiftShader 下 `MeshBasicMaterial` 编译失败），
 * 叠加层**一像素都画不出来** ⇒ 像素取证永远不过 ⇒ 藏楼这套逻辑在**本机**就没法被闸驱动
 * （真机上它是过的：2026-10-16 真机回传 `hidLayers: 5` 就是证据）。
 * 关掉之后仍要求"几何建出来了 + 真的发过绘制调用 + 材质没有着色器诊断"三条，
 * 只是少了最后那道像素兜底；**默认开**，也只在自用闸里用。
 */
function pixProbeOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("ovlpix") === "0";
  } catch {
    return false;
  }
}

/** 自用开关：`?wsalign=1` 才装 */
export function alignProbeWanted(): boolean {
  /* 判定只在 `wsRenderBackend.alignProbeOn` 一处（名字层回传也读它，别写第二份） */
  return alignProbeOn();
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
export interface OvProbeMapLike {
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  getCanvas: () => { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
  getSource?: (id: string) => { getData?: () => Promise<unknown> } | undefined;
  on?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
  off?: (ev: string, cb: (e: { sourceId?: string }) => void) => void;
}

/** 覆盖面账（宿主在 `rebuild` 里写；这里只读） */
export interface OvProbeCover {
  expected: number;
  actual: number;
  srcAll: number;
  meshAll: number;
  thinDropped: number;
  shapeDropped: number;
  judgedAt: number;
  meshOut: number;
  srcOut: number;
}

/**
 * 宿主快照 —— **每次调用现取**（闭包里读的是宿主当下的变量，不是缓存值）。
 *
 * 为什么不是宿主把状态搬进来：渲染/数据路径的计数归宿主写入（`drawOnce` / `rebuild` /
 * 藏楼），搬进来就要改那条路；这里只要读。
 */
export interface OvProbeView {
  map: OvProbeMapLike | null;
  renderer: any;
  data: BldMeshData | null;
  bldMesh: any;
  frames: number;
  draws: number;
  drawsTotal: number;
  drawsFromRebuild: number;
  fps: number;
  hiddenLayers: Map<string, string | null>;
  hidCount: number;
  restoredCount: number;
  cover: OvProbeCover;
  hideGateOk: boolean;
  hideGateWhy: string;
  gateFailStreak: number;
  lastDrawAt: number;
  reanchors: number;
  reanchorFails: number;
  reanchorInFlight: boolean;
  lastReanchorAt: number;
  mapRebinds: number;
  lastSource: string;
  mvtRawFeatures: number;
  mvtUniqueIds: number;
  mvtPartsDropped: number;
  mvtQueryMs: number;
  mvtQueryMaxMs: number;
  mvtQueries: number;
  rebuildCount: number;
  drawnPublished: number;
  refreshScheduled: number;
  refreshDone: number;
  getDataCalls: number;
  srcDataEvents: number;
  styleDataEvents: number;
  lastRefreshMs: number;
  facadeOn: boolean;
  facadeApplied: number;
  facadePatchFailed: number;
  facadeTextureFailed: number;
  outlineOn: boolean;
  outlineOnRef: boolean;
  outlineApplied: number;
  outlineFailed: number;
  outlineFrameMs: number;
  tlPrefAt: number;
  tlLandingAt: number;
  tlRunningAt: number;
  tlFirstDrawAt: number;
  tlFirstRemoveAt: number;
  tlFirstRecoverAt: number;
  nonEmptyFrames: number;
  removeStableFrames: number;
  bldMode: "map" | "overlay";
  T0: number;
  labelWrites: number;
  labelNodeWrites: number;
  labelContainerWrites: number;
  hideSyncs: number;
  restoreReasons: Record<string, number>;
  hideRetries: number;
  hideVerifyFailed: number;
  hideErrors: number;
  hideDrift: number;
  hideDriftIds: string[];
  hideRounds: number;
  lastStyleAt: number;
  lastHideAt: number;
  hidesSinceStyle: number;
  styleDataStamps: number[];
  layersRemovedTotal: number;
  layersRecovered: number;
  removePasses: number;
  ovlCtxCreated: number;
  ovlCtxLost: number;
  ovlCtxLostEvents: number;
  ovlCtxRestoredEvents: number;
  meshHeights: { n: number; p10: number; p50: number; p90: number; flat: number } | null;
  bldLayerPrefix: string;
  /* ── 宿主函数（值语义：调用时现取） ── */
  sizeOf: () => { w: number; h: number };
  w0: () => number;
  h0: () => number;
  mapBldLayerIds: () => string[];
  projectFromLastDrawLocalAt: (x: number, z: number, y?: number) => [number, number] | null;
  this_projectFromLastDraw: (lng: number, lat: number) => [number, number] | null;
  scheduleRefresh: () => void;
  grabBld: () => Promise<any>;
  dprCapOf: () => number;
  outlineTexel: (w: number, h: number) => { x: number; y: number };
  outlineRtBytes: (w: number, h: number) => unknown;
  fpsMark: (label: "pixel-probe") => void;
}

export interface OvProbeGate {
  ok: boolean;
  why: string;
  kind: "ok" | "geom" | "draws" | "shader" | "pix" | "cover";
}

export interface OvProbeApi {
  alignOn: () => boolean;
  alignCorner: () => [number, number] | null;
  alignPickCorner: () => Promise<void>;
  alignSample: () => void;
  alignNote: () => string;
  alignBadgePaint: () => void;
  alignStats: () => { on: boolean; cur: number; max: number; n: number; reports: number; centerErr: number | null; offScreen: number; fit: { a: number; b: number; n: number } | null } | null;
  beaconJson: (kind: string) => Record<string, unknown> | null;
  alignFlush: (kind: string) => void;
  meshDrawingOk: (probePixels: boolean) => OvProbeGate;
  pixStrikes: () => number;
  coverStrikes: () => number;
  dispose: () => void;
}

export function createOvProbe(view: () => OvProbeView): OvProbeApi {
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

  /** 上一次像素取证的时间（节流：别每帧都 readPixels） */
  let pixProbeAt = 0;
  /** 上一次像素读数（给报告/探针看：本机到底有没有画出像素） */
  let pixAlive = -1;
  /** 像素取证连续判空几次（**两振才出局**：单次读空可能只是抖动，立刻还原会造成"楼会变掉"的闪） */
  let pixStrikes = 0;
  /** 覆盖面连续判短几次（**两振才出局**：源刚长出来、网格还没跟上时会短暂偏短） */
  let coverStrikes = 0;
  let pixEverProbed = false;
  /** 像素取证**真跑了几次**（帧预算闸用它证"没有每帧 readPixels"） */
  let pixProbesRun = 0;
  /** 像素取证的 **last good result**（节流期间复用；`ok=false` 时 why 用于还原原因） */
  let pixOk = false;
  let pixWhy = "还没量";
  const PIX_PROBE_START_MS = 500;
  const PIX_PROBE_STEADY_MS = 5000;

  /** 页面上现在有几个画布（"越堆越多"是这台机器上出现过的故障形状） */
  function canvasCountNow(): number {
    try {
      return document.querySelectorAll("canvas").length;
    } catch {
      return -1;
    }
  }

  /**
   * 叠加层"真的画出了东西"吗 —— 四个条件都过才算数（任一不过 ⇒ **不藏 / 立刻还原**）：
   *   ① 几何建出来了（`buildings > 0 && triangles > 0`）；
   *   ② 真的发出过绘制调用（`draws > 0`）；
   *   ③ 材质**没有**着色器诊断（three 在编译/链接失败时会给 material 挂 `.diagnostics`）；
   *   ④ 像素取证：抽两条横带 `readPixels`，看得见非透明像素（这是"屏幕上真有东西"的地面真值）。
   * 读不出来的 API（老 three / 假地图）不当作通过 —— 宁可**不藏**，也不许把画面弄空。
   */
  function meshDrawingOk(probePixels: boolean): OvProbeGate {
    const { map, data, bldMesh, draws, cover, hideGateOk, renderer, w0, h0, projectFromLastDrawLocalAt, scheduleRefresh, fpsMark } = view();
    /* ①②③ 纯 JS、每帧都可以判（很便宜） */
    if (!data || !(data.stats.buildings > 0) || !(data.triangles > 0)) {
      return { ok: false, why: "叠加层还没建出楼（0 栋）", kind: "geom" };
    }
    if (!(draws > 0)) return { ok: false, why: "叠加层还没发出绘制调用", kind: "draws" };
    /* ④' **实例校验**：手里不是屏幕当前那张地图 ⇒ 不许继续藏（藏的可能是旧画布）。
       先尝试重绑；重绑后由下一次补藏在新实例上重做。 */
    try {
      const live = wsLiveMap.get();
      if (live && live !== (map as unknown) && typeof (live as { setLayoutProperty?: unknown }).setLayoutProperty === "function") {
        return { ok: false, why: "地图实例已换（手里是旧的，先重绑）", kind: "pix" };
      }
    } catch { /* 登记处读不到就不判 */ }
    const mat = (bldMesh as unknown as { material?: { diagnostics?: unknown } } | null)?.material;
    if (mat && (mat as { diagnostics?: unknown }).diagnostics) {
      return { ok: false, why: "叠加层着色器报错（材料诊断有内容）", kind: "shader" };
    }
    /* ⑤ **画得够不够**（比例判据）：同一份源、同一个视野，源内要素数 vs 网格内楼数。
       实画×2 < 源（且源≥4）⇒ 先"往前修"（补一次数据重建），连续两次仍短 ⇒ 才真还原。
       阈值取一半的理由：两套读同一份源，我们只能合法丢掉"建不出体块"的（扁到 top-base<0.4 /
       轮廓退化），正常比例很低（夹具 135 栋实测 0 栋）；掉到一半以下就是结构性少（1 对 40）。 */
    if (cover.expected >= 4 && cover.actual * 2 < cover.expected) {
      coverStrikes += 1;
      if (coverStrikes === 1) {
        scheduleRefresh();
        return { ok: false, why: "画得太少（源 " + cover.expected + " / 实画 " + cover.actual + "）· 已补一次数据", kind: "cover" };
      }
      return { ok: false, why: "画得太少（源 " + cover.expected + " / 实画 " + cover.actual + " · 第 " + coverStrikes + " 次）", kind: "cover" };
    }
    coverStrikes = 0;
    /* ④ 像素取证（**最贵**的一条）：只在 `drawOnce` 刚画完那一刻读，并且**节流**。
       `readPixels` 是同步 GPU 读回 —— 每帧一次就能把手机打到个位数 fps（真机 2026-10-17 实测）。 */
    if (!probePixels) {
      if (!pixEverProbed) return { ok: false, why: "还没在画完那一刻取过像素证据", kind: "pix" };
      return { ok: pixOk, why: pixWhy, kind: pixOk ? "ok" : "pix" };
    }
    const nowMs = performance.now();
    const due = nowMs - pixProbeAt >= (hideGateOk ? PIX_PROBE_STEADY_MS : PIX_PROBE_START_MS);
    if (pixEverProbed && !due) return { ok: pixOk, why: pixWhy, kind: pixOk ? "ok" : "pix" };
    pixProbeAt = nowMs;
    pixEverProbed = true;
    pixProbesRun += 1;
    if (pixProbeOff()) {
      pixAlive = -2;                     /* -2 = 没量（自用开关关掉） */
      pixStrikes = 0;
      pixOk = true;
      pixWhy = "画了（像素取证=关 ?ovlpix=0）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    const gl = (() => { try { return (renderer?.getContext?.() ?? null) as WebGLRenderingContext | null; } catch { return null; } })();
    if (!gl?.readPixels) {
      pixOk = true;
      pixWhy = "画了（像素取证不可用）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    let alive = 0;
    /* 帧率采集的行为打点：同步 GPU 读回是整帧里最贵的一步，单独打一个标签 */
    fpsMark("pixel-probe");
    try {
      const dpr = renderer?.getPixelRatio?.() ?? 1;
      const bw = Math.max(1, Math.round(w0() * dpr));
      const bh = Math.max(1, Math.round(h0() * dpr));
      const readRect = (x: number, y: number, w2: number, h2: number): number => {
        const buf = new Uint8Array(w2 * h2 * 4);
        gl.readPixels(x, y, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let n = 0;
        for (let i = 3; i < buf.length; i += 4) if (buf[i]! > 8) n++;
        return n;
      };
      /* 按**我们自己的网格**采样：楼在屏幕上稀疏（地面透明），横带容易扫空 ⇒
         拿每栋楼的 XZ 包围盒中心，用"画出去那一帧"的矩阵投到屏幕，在投出来的点周围读一小块。
         🔴 采样点是 **CSS 像素**、`readPixels` 要**缓冲像素** ⇒ 必须乘 dpr（真机 dpr=3 时
         不乘就偏到 1/3 处，常年只读到 1 个像素——真机序列 1,1,1,1100,1,… 就是这个形状）。 */
      const step = Math.max(1, Math.ceil(((data?.boxes?.length ?? 0) / 4) / 1)) || 1;
      const samplePts: Array<[number, number]> = [];
      try {
        const boxes = data?.boxes ?? [];
        const metas = data?.featureMeta ?? [];
        for (let i = 0; i + 3 < boxes.length && samplePts.length < 4; i += 4 * step) {
          const fi = i / 4;
          const cx2 = (boxes[i]! + boxes[i + 2]!) / 2;
          const cz2 = (boxes[i + 1]! + boxes[i + 3]!) / 2;
          /* 🔴 采样点取**楼顶**（`y = h3d`），不是地面：俯角下地面点常落在楼体下方的空地/天空，
             实测两个 20×20 框只命中 118px ⇒ 会被误判"画不出来"（真机 pix.strikes=2 就是这个形状）。 */
          const topY = Number(metas[fi]?.h3d ?? 0);
          const p = projectFromLastDrawLocalAt(cx2, cz2, Math.max(0, topY * 0.5));
          if (p && p[0] >= 12 && p[0] <= bw - 12 && p[1] >= 12 && p[1] <= bh - 12) samplePts.push(p);
        }
      } catch {
        /* 采样点算不出来就走兜底横带 */
      }
      /* **最多 2 个** 20×20 的框（400 px/框）；不读整条横带（dpr=3 时一条 61 KB）。 */
      let probes = 0;
      for (const [x, y] of samplePts) {
        const bxp = Math.round(x * dpr);
        const byp = bh - Math.round(y * dpr);
        alive += readRect(bxp - 10, byp - 10, 20, 20);
        probes += 1;
        if (alive >= PIX_MIN_ALIVE || probes >= 2) break;
      }
      /* 兜底：采样点一个都没投出来时，读**一条**窄横带（1~2 行） */
      if (alive <= 0 && !samplePts.length) {
        const rows = Math.max(1, Math.min(2, Math.floor(bh / 200)));
        const y = Math.max(0, Math.min(bh - rows, Math.round(bh * 0.5)));
        alive += readRect(0, y, bw, rows);
      }
    } catch {
      pixOk = true;
      pixWhy = "画了（像素取证抛错）";
      return { ok: true, why: pixWhy, kind: "ok" };
    }
    if (alive < PIX_MIN_ALIVE) {
      pixStrikes += 1;
      pixOk = false;
      pixWhy = "像素太少（" + alive + " < " + PIX_MIN_ALIVE + " · 第 " + pixStrikes + " 次）";
      return { ok: false, why: pixWhy, kind: "pix" };
    }
    pixStrikes = 0;
    pixAlive = alive;
    pixOk = true;
    pixWhy = "画了（" + alive + " 个非空像素）";
    return { ok: true, why: pixWhy, kind: "ok" };
  }

  /**
   * 像素取证的**绝对值下限**（真机 2026-10-17：`pix.alive = 1` 也放行过 ⇒ 闸太弱）。
   * 采样框 20×20（缓冲像素，最多 4 个点 + 2 条兜底横带 = 最多 2400 px）；
   * 真画出楼时读到的是几百~几千，1~2 个只是噪点/边角。比例那条见闸的第 ⑤ 条（`cover`）。
   */
  const PIX_MIN_ALIVE = 40;

  /* ── 自用对齐探针（只在 `?wsalign=1` 时真跑） ───────────────────────────────── */
  /** 选一个"固定的角"：拿地图 `bld` 源里第一栋的第一个环点，投票到屏幕中心最近的那个 —— **只选一次** */
  async function alignPickCorner(): Promise<void> {
    const { map, sizeOf, grabBld } = view();
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
    const { map, sizeOf, this_projectFromLastDraw } = view();
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
    const row = beaconJson(kind);
    if (row) beacon(row);
  }

  /** 回传**拼装**：返回一条回传行（不开量具/还没选到角时返回 null） */
  function beaconJson(kind: string): Record<string, unknown> | null {
    const { map, renderer, data, frames, draws, drawsTotal, drawsFromRebuild, fps, hiddenLayers, hidCount, cover, hideGateOk, hideGateWhy, gateFailStreak, lastDrawAt, reanchors, reanchorFails, reanchorInFlight, lastReanchorAt, mapRebinds, lastSource, mvtRawFeatures, mvtUniqueIds, mvtPartsDropped, mvtQueryMs, mvtQueryMaxMs, mvtQueries, rebuildCount, drawnPublished, refreshScheduled, refreshDone, getDataCalls, srcDataEvents, styleDataEvents, lastRefreshMs, facadeOn, facadeApplied, facadePatchFailed, facadeTextureFailed, outlineOn, outlineOnRef, outlineApplied, outlineFailed, outlineFrameMs, tlPrefAt, tlLandingAt, tlRunningAt, tlFirstDrawAt, tlFirstRemoveAt, tlFirstRecoverAt, nonEmptyFrames, removeStableFrames, bldMode, T0, labelWrites, labelNodeWrites, labelContainerWrites, hideSyncs, restoreReasons, hideRetries, hideVerifyFailed, hideErrors, hideDrift, hideDriftIds, hideRounds, lastStyleAt, lastHideAt, hidesSinceStyle, styleDataStamps, layersRemovedTotal, layersRecovered, removePasses, ovlCtxCreated, ovlCtxLost, ovlCtxLostEvents, ovlCtxRestoredEvents, meshHeights, bldLayerPrefix: BLD_LAYER_PREFIX, sizeOf, mapBldLayerIds, this_projectFromLastDraw, dprCapOf, outlineTexel, outlineRtBytes } = view();
    if (!alignOn || !alignCorner) return null;
    /* 中心误差**在发车前现算一遍**：徽标上的 `中心` 是逐帧刷的，回传是每 2 秒/moveend 才发，
       两个数差得远时无从判断"是不是同一个量"。这里钉死：回传里的 `centerErr` 就是**这一刻**的值。 */
    try {
      const mm = map as unknown as { project?: (c: [number, number]) => { x: number; y: number }; getCenter?: () => { lat: number; lng: number } } | null;
      const c = mm?.getCenter?.();
      if (c) {
        const p0 = mm?.project?.([c.lng, c.lat]);
        const p1 = this_projectFromLastDraw(c.lng, c.lat);
        if (p0 && p1) alignCenterErr = Math.hypot(p0.x - p1[0], p0.y - p1[1]);
      }
    } catch {
      /* 现算失败就沿用上一次的（如实：它仍是个数，只是不是这一刻的） */
    }
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
    /* 藏楼之后**地图的命中查询还答不答得出来**（"点楼"会不会哑）—— 成对读数：
       ① `hid`：现在的状态（楼藏着）在屏幕正中查一次；
       ② `shown`：**当场把藏起来的楼放回来**再查一次，然后立刻按原值藏回去
          （三步都在同一个 JS 任务里 ⇒ 中间不会渲染出一帧 ⇒ 不会露楼）。
       两个数一比就能分开："藏楼把命中弄哑了"（hid=0 而 shown>0）还是"地图自己就答不出来"
       （两个都是 0 ⇒ 是样式/渲染那边的事，不是藏楼）。 */
    let pick: Record<string, unknown> | null = null;
    try {
      const { w, h } = sizeOf();
      const m = map as unknown as {
        queryRenderedFeatures?: (p: [number, number], o?: unknown) => Array<{ layer?: { id?: string } }>;
        setLayoutProperty?: (id: string, k: string, v: unknown) => void;
      };
      if (m?.queryRenderedFeatures) {
        const at: [number, number] = [w / 2, h / 2];
        const count = (feats: Array<{ layer?: { id?: string } }>): { n: number; bld: number; byLayer: Record<string, number> } => {
          const byLayer: Record<string, number> = {};
          let bld = 0;
          for (const f of feats) {
            const id = String(f?.layer?.id ?? "?");
            byLayer[id] = (byLayer[id] || 0) + 1;
            if (id.startsWith(BLD_LAYER_PREFIX)) bld++;
          }
          return { n: feats.length, bld, byLayer };
        };
        const hid = count(m.queryRenderedFeatures(at) || []);
        let shown: Record<string, unknown> | null = null;
        const ids = [...hiddenLayers.keys()];
        if (ids.length && m.setLayoutProperty) {
          let err = "";
          for (const id of ids) { try { m.setLayoutProperty(id, "visibility", "visible"); } catch (e) { err += String((e as Error)?.message || e) + ";"; } }
          try {
            shown = count(m.queryRenderedFeatures(at) || []);
          } catch (e) {
            shown = { n: null, err: String((e as Error)?.message || e) };
          }
          /* 立刻按**原值**藏回去（倒序，与出场同一套口径） */
          for (const [id, prev] of [...hiddenLayers.entries()].reverse()) {
            try { m.setLayoutProperty(id, "visibility", prev === null ? "visible" : prev); } catch { /* 单层失败不阻断 */ }
          }
          if (err) shown = { ...(shown || {}), err };
        }
        /* 源侧交叉确认（真机 2026-10-17：`shown.n=0` ⇒ 要分清"藏楼把命中弄哑"还是"源/渲染本身没东西"） */
        let srcQ: number | null = null;
        try {
          const q = (map as unknown as { querySourceFeatures?: (id: string) => unknown[] })?.querySourceFeatures?.("bld");
          srcQ = Array.isArray(q) ? q.length : null;
        } catch { srcQ = null; }
        pick = { hid, shown, at, hiddenIds: ids, srcQuerySource: srcQ, srcAll: cover.srcAll, meshAll: cover.meshAll };
      } else {
        pick = { hid: null, why: "no-query" };
      }
    } catch (e) {
      pick = { hid: null, err: String((e as Error)?.message || e) };
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
    return {
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
      /* 藏了地图哪几层楼（"两层楼叠着"那件事真机上到底成没成，看这一栏） */
      hidLayers: hidCount,
      hidIds: [...hiddenLayers.keys()],
      /* 藏楼闸的现况（真机事故：藏了地图那套、叠加层又没画出来 ⇒ 整屏没楼） */
      /* ⚠️ `draws` 是**上一帧的绘制调用数**（three 的 `info.render.calls` 每帧重置），
         **不是累计值** —— 真机那 23 条"draws 恒为 1"就是这么来的（一帧画 1 次）。
         要知道"到底在不在出帧"看 `frames`（累计）与 `drawGapMs`（距上次画多久）。 */
      /* `frames` = **地图驱动的帧**（map render 回调）；`drawsTotal` = **累计真画了几帧**
         （含重建后补画的那一帧）—— 两者别混。 */
      hidGate: { ok: hideGateOk, why: hideGateWhy, draws: draws, frames, drawsTotal, failStreak: gateFailStreak, drawGapMs: lastDrawAt ? Math.round(performance.now() - lastDrawAt) : null },
      /* 重锚账（默认模式下重锚是新接上的路：跑了几次、失败几次） */
      reanchor: { count: reanchors, fails: reanchorFails, inFlight: reanchorInFlight, lastAgoMs: lastReanchorAt ? Math.round(performance.now() - lastReanchorAt) : null },
      /* 藏/还原各发生几次、为什么（真机"楼会变掉"要能查账） */
      pix: { alive: pixAlive, probed: pixEverProbed, strikes: pixStrikes },
      /* 覆盖面（"整屏只有一栋楼"那条：源里有几个 vs 我们画了几个） */
      cover: { expected: cover.expected, actual: cover.actual, srcAll: cover.srcAll, meshAll: cover.meshAll, thinDropped: cover.thinDropped, shapeDropped: cover.shapeDropped, meshOut: cover.meshOut, srcOut: cover.srcOut, strikes: coverStrikes },
      /* 数据通道的账（"为什么只画出一栋"：调度几次 / 完成几次 / 取了几次数） */
      feed: {
        source: lastSource,
        mvtFeatures: mvtRawFeatures,
        mvtUniqueIds,
        mvtPartsDropped,
        mvtQueryMs,
        mvtQueryMaxMs,
        mvtQueries,
        rebuilds: rebuildCount,
        /* 名字绑定用：叠加层画出去的这批（宿主读"已画楼"时会优先用它） */
        drawnSource: "overlay",
        drawnIds: drawnPublished, refreshScheduled, refreshDone, getDataCalls, srcDataEvents, styleDataEvents, lastRefreshMs: lastRefreshMs < 0 ? null : Math.round(performance.now() - lastRefreshMs) },
      meshStats: data?.stats ?? null,
      /* 立面图集：on = 开关；applied = 补丁真的挂上了；patchFailed = 着色器锚点对不上（退回纯色） */
      facade: { on: facadeOn, applied: facadeApplied, patchFailed: facadePatchFailed, textureFailed: facadeTextureFailed },
      /* 描边（默认关）：on/applied/failed + 每帧 pass 耗时 + RT 字节（代价两数） */
      outline: (() => {
        const dpr = renderer?.getPixelRatio?.() ?? 1;
        const sz = (() => { try { return sizeOf(); } catch { return { w: 1, h: 1 }; } })();
        const bw = Math.round(sz.w * dpr), bh = Math.round(sz.h * dpr);
        return { on: outlineOn && outlineOnRef, applied: outlineApplied, failed: outlineFailed, frameMs: outlineFrameMs, rtBytes: outlineRtBytes(bw, bh), texel: outlineTexel(bw, bh) };
      })(),
      /* **每帧分解**（拖动期间"谁在花时间"）：`mapFrames` = 地图 render 回调次数，
         `overlayFrames` = 我们真画了几帧，`labelWrites` = 名字层 DOM 写入次数，
         `labelNodes` = 这个名字层现有多少节点（10 个 vs 500 个代价差一个量级）。 */
      /* 启动时间线（自用）：拆层是否早于首绘、落图是否还没回来就拆了，一眼可判 */
      timeline: {
        pref: tlPrefAt,
        landing: tlLandingAt,
        running: tlRunningAt,
        firstDraw: tlFirstDrawAt,
        firstRemove: tlFirstRemoveAt,
        firstRecover: tlFirstRecoverAt,
        nonEmptyFrames,
        stableFrames: removeStableFrames,
        mode: bldMode,
        now: Math.round(performance.now() - T0),
      },
      perFrame: {
        mapFrames: frames,
        overlayFrames: drawsTotal,
        rebuildFrames: drawsFromRebuild,
        labelWrites,
        labelNodeWrites,
        labelContainerWrites,
        labelNodes: (() => { try { return document.querySelectorAll(".ws-labs *").length; } catch { return -1; } })(),
        dpr: renderer?.getPixelRatio?.() ?? null,
        dprCap: dprCapOf(),
      },
      /* **叠加层那块画布到底在不在屏幕最上层**（像素取证读的是自己的缓冲，
         证明不了"它有没有被地图画布盖住"——"楼没了"还可能是这层被盖） */
      layer: (() => {
        try {
          const ovl = renderer?.domElement as HTMLCanvasElement | undefined;
          if (!ovl) return null;
          const mapCv = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
          const idx = (el: Element | null): number => {
            if (!el) return -1;
            const all = Array.from(document.querySelectorAll("canvas"));
            return all.indexOf(el as HTMLCanvasElement);
          };
          const cs = getComputedStyle(ovl);
          const ms = mapCv ? getComputedStyle(mapCv) : null;
          return {
            ovlIndex: idx(ovl),
            mapIndex: idx(mapCv),
            ovlZ: cs.zIndex, mapZ: ms ? ms.zIndex : null,
            ovlOpacity: cs.opacity, ovlVisibility: cs.visibility, ovlDisplay: cs.display,
            ovlInDom: document.contains(ovl),
            parentCls: String((ovl.parentElement?.className as string) || "").slice(0, 40),
          };
        } catch { return null; }
      })(),
      meshHeights,
      pixProbesRun,
      /* 结构性拆层读数：present = 现在还剩几条 bld*（0 = 目标达成），removedTotal / recovered */
      bldLayers: {
        mode: bldMode,
        removePasses,
        present: (() => {
          try {
            const all = (map as unknown as { getStyle?: () => { layers?: Array<{ id?: unknown }> } })?.getStyle?.()?.layers || [];
            return all.filter((l) => String((l as { id?: unknown })?.id ?? "").startsWith(BLD_LAYER_PREFIX)).length;
          } catch {
            return -1;
          }
        })(),
        removedTotal: layersRemovedTotal,
        recovered: layersRecovered,
      },
      hidCounters: { hideSyncs, restoreTotal: Object.values(restoreReasons).reduce((a, b) => a + b, 0), restoreReasons, hideRetries, hideVerifyFailed, hideErrors, mapRebinds, hideDrift, hideDriftIds, hideRounds },
      /* **事件序列位置**（判"补藏到底在 styledata 之后还是之前"）：
         lastStyleAgoMs = 最近一次 styledata 距今；lastHideAgoMs = 最近一次补藏距今；
         hidesSinceStyle = 最近一次 styledata 之后补藏了几次（>0 ⇒ 补藏确实发生在事件之后） */
      hidTiming: {
        lastStyleAgoMs: lastStyleAt ? Math.round(performance.now() - lastStyleAt) : null,
        lastHideAgoMs: lastHideAt ? Math.round(performance.now() - lastHideAt) : null,
        hidesSinceStyle,
        styleDataStamps: styleDataStamps.slice(-6),
        now: Math.round(performance.now()),
      },
      /* 地图那套楼到底藏上没藏上：**写进去的**与**读回来的**并排（真机那两个数打架时要能一眼分开） */
      hidWrote: [...hiddenLayers.keys()],
      /* 手里这台地图还活着吗（"读回全 visible"还有一个可能是**我们握的是旧实例**） */
      /* `sameCanvas` = 我们手里那张的 canvas 与屏幕上的 `.maplibregl-canvas` 是不是同一块 */
      mapAlive: (() => {
        try {
          const cv = (map as unknown as { getCanvas?: () => Element | null })?.getCanvas?.() ?? null;
          const st = (map as unknown as { getStyle?: () => unknown })?.getStyle?.() ?? null;
          return { hasStyle: !!st, canvasInDom: cv ? document.contains(cv as unknown as Node) : null, sameCanvas: cv ? cv === renderer?.domElement?.parentElement?.querySelector?.(".maplibregl-canvas") : null };
        } catch { return null; }
      })(),
      /* **当场回读**地图那 5 层的真实可见性（判据读它，不读我自己的记账） */
      hidLive: (() => {
        const mm = map as unknown as { getLayoutProperty?: (id: string, k: string) => unknown } | null;
        return mapBldLayerIds().map((id) => {
          let v: string | null = null;
          try { const x = mm?.getLayoutProperty?.(id, "visibility"); v = x === undefined || x === null ? null : String(x); } catch { v = "?"; }
          return { id, vis: v };
        });
      })(),
      /* 屏幕正中那一圈：地图还能不能答出要素（`bld` 计数 = 藏起来的楼还答不答） */
      pick,
      /* 名字↔楼绑定（2026-10-17）：每节点锚点/楼顶/地面投影差 + 未绑分类；没装/没算过 = null */
      nameBind: wsDiag.nameBind,
      /* ── 上下文与降级账（2026-10-14）：真机"划着划着掉回 2D 自绘路"要有账可查 ── */
      ctx: {
        ovlCreated: ovlCtxCreated,
        ovlLostByUs: ovlCtxLost,
        ovlLostEvents: ovlCtxLostEvents,
        ovlRestoredEvents: ovlCtxRestoredEvents,
        canvases: canvasCountNow(),
      },
      engine: {
        renderKind: wsDiag.renderKind,
        fallbackWhy: wsDiag.fallbackWhy,
        watchdogFires: wsDiag.watchdogFires,
        styleDeadFires: wsDiag.styleDeadFires,
        mapCtxLost: wsDiag.mapCtxLost,
        mapCtxRestored: wsDiag.mapCtxRestored,
        draws: draws,
        fps: Math.round(fps * 10) / 10,
      },
    };
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

  return {
    alignOn: () => alignOn,
    alignCorner: () => alignCorner,
    alignPickCorner,
    alignSample,
    alignNote,
    alignBadgePaint,
    alignStats: () => {
      if (!alignOn) return null;
      return {
        on: true,
        cur: Number(alignCur.toFixed(3)),
        max: Number(alignMax.toFixed(3)),
        n: alignErrs.length,
        reports: alignReports,
        centerErr: alignCenterErr === null ? null : Number(alignCenterErr.toFixed(3)),
        offScreen: alignOffScreen,
        fit: alignFit(),
      };
    },
    beaconJson,
    alignFlush,
    meshDrawingOk,
    pixStrikes: () => pixStrikes,
    coverStrikes: () => coverStrikes,
    dispose: () => {
      if (alignStaticTimer) window.clearTimeout(alignStaticTimer);
      alignStaticTimer = 0;
      try {
        alignBadge?.remove?.();
      } catch {
        /* ignore */
      }
      alignBadge = null;
    },
  };
}

