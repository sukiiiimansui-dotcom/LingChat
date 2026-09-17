/**
 * wsGeoMap.ts —— 「世界模拟」的**客户端 GeoJSON 矢量渲染器**（2026-09-18 全面 UI 改造的地基）
 *
 * ── 为什么不再用后端现画的 SVG ──────────────────────────────────────────────
 * 旧通路是 `/api/geo_svg?ad=…&w=…&h=…&zoom=…` → 拿一张 SVG 字符串 `v-html` 插进 DOM：
 *   · 每次缩放/换级 = **一次服务端请求 + 一次重画** ⇒ 物理上不可能丝滑（机主要的"丝滑缩放"）；
 *   · 配色写死在 Rust 里 ⇒ 换主题要改后端；
 *   · 命中判定要解析 SVG 字符串 ⇒ 脆。
 * 本模块改成"**一次取数、本地矢量渲染**"：缩放/平移只改变换矩阵，不再发请求。
 *
 * ── 三条实现要点（都是踩过坑才这么写的）────────────────────────────────────
 * ① **Path2D 用世界坐标建一次，靠 `ctx.setTransform` 缩放** ——
 *    这样缩放不需要重建路径（重建 = 每帧 new 几十个 Path2D，必掉帧）；
 *    代价是线宽会被一起放大，所以描边时把 `lineWidth` 设成 `px / k` 保持屏幕像素恒定。
 * ② **经度必须转成弧度**（`lng * π / 180`）—— 墨卡托的 y 也是弧度量纲；
 *    混着用会把地图压成一条线（`wsgame.html` 上真踩过）。
 * ③ **画布按 devicePixelRatio 放大**，否则 Retina/高分屏上线条发虚。
 *
 * ── 依赖 ──────────────────────────────────────────────────────────────────
 * 只依赖 DOM + Canvas2D，**不依赖 Vue / 不依赖 WebGL**（Android WebView 上 WebGL 会丢上下文，
 * 见 `wsgame.html` 的实测：SwiftShader 下第 2 帧 `isContextLost() === true`）。
 */

/** 一个要素（只保留渲染/命中要用的字段） */
export interface GeoFeat {
  adcode: string;
  name: string;
  /** 圆心 [lng, lat]（GeoJSON 的 `properties.center`，没有就用 bbox 中心） */
  center: [number, number];
  /** MultiPolygon：polygons → rings → points（[lng, lat]） */
  polys: number[][][][];
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
}

export interface GeoTheme {
  /** 陆地填充 */
  land: string;
  /** 陆地描边（行政边界） */
  line: string;
  /** 高亮填充（选中/下钻目标）—— 用 LingChat 主色 */
  accent: string;
  /** 高亮描边 */
  accentLine: string;
  /** 标注文字 */
  label: string;
  /** 标注描边（压在图上也要读得清） */
  labelHalo: string;
  /** 海/底 */
  sea: string;
}

export const THEME_DARK: GeoTheme = {
  sea: "#0b1017",
  land: "#1e2937",
  line: "rgba(255,255,255,0.30)",
  accent: "rgba(121,217,255,0.34)",
  accentLine: "#79d9ff",
  label: "rgba(255,255,255,0.92)",
  labelHalo: "rgba(0,0,0,0.55)",
};
export const THEME_LIGHT: GeoTheme = {
  sea: "#d7e5f0",
  land: "#ffffff",
  line: "rgba(28,48,68,0.45)",
  accent: "rgba(41,150,200,0.26)",
  accentLine: "#1f7fb8",
  label: "rgba(22,34,46,0.92)",
  labelHalo: "rgba(255,255,255,0.75)",
};

/** 全国视图的**大区锚点**（规格：全国只留 5~8 个，不再标 32 个省名）
 *  —— 定点而不是"每个省标一次"，所以永远不会互相重叠。 */
const MACRO_ANCHORS: Array<{ name: string; lng: number; lat: number }> = [
  { name: "西北", lng: 86.5, lat: 42.0 },
  { name: "华北", lng: 114.5, lat: 39.5 },
  { name: "东北", lng: 126.5, lat: 45.5 },
  { name: "华东", lng: 119.0, lat: 31.5 },
  { name: "华中", lng: 112.5, lat: 29.5 },
  { name: "西南", lng: 101.5, lat: 27.5 },
  { name: "华南", lng: 110.5, lat: 22.5 },
];

const D2R = Math.PI / 180;
/** 经度 → 墨卡托 x（弧度量纲；与 y 同量纲，见文件头 ② ） */
const mx = (lng: number) => lng * D2R;
/** 纬度 → 墨卡托 y（弧度）；屏幕 y 向下增长，所以取负号（北在上）。
 *
 *  ⚠️ 这个函数被写错过两次，都表现为「全国地图塌成一条水平细线」：
 *    · 第一次：把经度按**度**、纬度按**弧度**混用（`wsgame.html` 上踩过）；
 *    · 第二次（2026-09-18）：给 `(1+s)/(1-s)` 加了错的上界 `min(1 - 1e-9, …)` ——
 *      而该比值对**所有北纬都 > 1**（φ=18° 时已是 1.894）→ 全被夹到 1 → `ln(1)=0`。
 *  真正的边界只在两极（比值 → ∞），所以**夹纬度**而不是夹比值（±85.05° 是 Web 墨卡托的定义域）。 */
function my(lat: number): number {
  const phi = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
  return -Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

export interface WsGeoMapOpts {
  canvas: HTMLCanvasElement;
  theme?: GeoTheme;
  /** 点中某个要素（命中判定在本地做，不依赖 DOM） */
  onPick?: (f: GeoFeat | null) => void;
  /** 悬停（鼠标派；触屏不会触发） */
  onHover?: (f: GeoFeat | null) => void;
  /** 视图变化（缩放/平移后），给外部同步 UI（例如"复位"按钮可用性） */
  onView?: (v: { zoom: number }) => void;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}

/**
 * 渲染器。生命周期：`new` → `setFeatures()`（可多次，换级）→ `layout()`（尺寸变化）→ `destroy()`。
 */
export class WsGeoMap {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private theme: GeoTheme;
  private feats: GeoFeat[] = [];
  private paths: Path2D[] = [];
  /** 高亮集合（adcode） */
  private hi = new Set<string>();
  private view: View = { k: 1, tx: 0, ty: 0 };
  /** 基准视图（"复位"用）：把当前要素铺满画布 */
  private base: View = { k: 1, tx: 0, ty: 0 };
  private raf = 0;
  private anim: { from: View; to: View; t0: number; ms: number } | null = null;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private opts: WsGeoMapOpts;
  private showMacro = true;
  /** 标注模式：`auto`（默认，全国自动用大区锚点、下钻后画要素名）/ `macro` 强制大区锚点 / `none` 不画 */
  private labelMode: "macro" | "none" | "auto" = "auto";
  private disposed = false;

  constructor(opts: WsGeoMapOpts) {
    this.opts = opts;
    this.cv = opts.canvas;
    const ctx = this.cv.getContext("2d");
    if (!ctx) throw new Error("Canvas2D 不可用");
    this.ctx = ctx;
    this.theme = opts.theme || THEME_DARK;
    this.layout();
    this.bindPointer();
  }

  // ── 数据 ───────────────────────────────────────────────────────────────
  /** 换一级要素。`animate` 时做 **300ms 视图补间**（机主要的"丝滑"）。 */
  setFeatures(feats: GeoFeat[], o: { animate?: boolean; keepView?: boolean; hi?: string[] } = {}) {
    this.feats = feats;
    this.hi = new Set(o.hi || []);
    this.paths = feats.map((f) => buildPath(f));
    // 全国视图才画大区锚点；下钻后画这一级的要素名
    this.showMacro = feats.length > 20;
    const to = this.fitView();
    if (o.keepView) {
      this.base = to;
    } else if (o.animate) {
      this.base = to;
      this.animateTo(to, 300);
    } else {
      this.base = to;
      this.view = { ...to };
      this.draw();
    }
  }

  /** 数值上"铺满画布"的视图：contain + 6% 边距 */
  private fitView(): View {
    const pad = 0.94;
    if (!this.feats.length) return { k: 1, tx: 0, ty: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const f of this.feats) {
      const x0 = mx(f.bbox[0]);
      const x1 = mx(f.bbox[2]);
      const y0 = my(f.bbox[3]); // 纬度越大 y 越小
      const y1 = my(f.bbox[1]);
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y1);
    }
    const bw = Math.max(1e-9, maxX - minX);
    const bh = Math.max(1e-9, maxY - minY);
    const k = Math.min(this.cssW / bw, this.cssH / bh) * pad;
    return {
      k,
      tx: this.cssW / 2 - ((minX + maxX) / 2) * k,
      ty: this.cssH / 2 - ((minY + maxY) / 2) * k,
    };
  }

  /** 高亮哪些 adcode（选中态；**永远画在最上层** —— 规格里的"用户内容最上"） */
  setHighlight(ads: string[]) {
    this.hi = new Set(ads);
    this.draw();
  }

  /** 标注模式（设置抽屉里可切；自动化验证也用它） */
  setLabelMode(m: "macro" | "none" | "auto") {
    this.labelMode = m;
    this.draw();
  }

  setTheme(t: GeoTheme) {
    this.theme = t;
    this.draw();
  }

  // ── 视图操作 ───────────────────────────────────────────────────────────
  /** 缩放（`f` > 1 放大）。`at` 给屏幕坐标则以其为锚点，否则画布中心。 */
  zoomBy(f: number, at?: { x: number; y: number }) {
    const p = at || { x: this.cssW / 2, y: this.cssH / 2 };
    const k2 = clamp(this.view.k * f, this.base.k * 0.6, this.base.k * 8);
    const real = k2 / this.view.k;
    this.view = {
      k: k2,
      tx: p.x - (p.x - this.view.tx) * real,
      ty: p.y - (p.y - this.view.ty) * real,
    };
    this.draw();
    this.opts.onView?.({ zoom: this.view.k / this.base.k });
  }

  /** 平滑缩放到指定倍数（按钮/双击用；300ms，Decelerate） */
  animateZoomTo(f: number, ms = 300) {
    const target = clamp(this.base.k * f, this.base.k * 0.6, this.base.k * 8);
    const p = { x: this.cssW / 2, y: this.cssH / 2 };
    const real = target / this.view.k;
    this.animateTo(
      {
        k: target,
        tx: p.x - (p.x - this.view.tx) * real,
        ty: p.y - (p.y - this.view.ty) * real,
      },
      ms
    );
  }

  /** 复位到"铺满" */
  reset(ms = 300) {
    if (ms > 0) this.animateTo(this.base, ms);
    else {
      this.view = { ...this.base };
      this.draw();
    }
  }

  /** 经纬度 → 屏幕坐标（角色点/车辆标记/自动化测试都要用） */
  project(lng: number, lat: number): { x: number; y: number } {
    return { x: mx(lng) * this.view.k + this.view.tx, y: my(lat) * this.view.k + this.view.ty };
  }

  /** 当前相对基准的缩放倍数 */
  get zoom(): number {
    return this.view.k / this.base.k;
  }

  private animateTo(to: View, ms: number) {
    if (prefersReducedMotion()) {
      this.view = { ...to };
      this.draw();
      this.opts.onView?.({ zoom: this.view.k / this.base.k });
      return;
    }
    this.anim = { from: { ...this.view }, to, t0: performance.now(), ms };
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (t: number) => {
    this.raf = 0;
    const a = this.anim;
    if (!a || this.disposed) return;
    const p = Math.min(1, (t - a.t0) / a.ms);
    // 进入用 Decelerate（快起慢停）—— 规格里的标准缓动
    const e = 1 - Math.pow(1 - p, 3);
    this.view = {
      k: a.from.k + (a.to.k - a.from.k) * e,
      tx: a.from.tx + (a.to.tx - a.from.tx) * e,
      ty: a.from.ty + (a.to.ty - a.from.ty) * e,
    };
    this.draw();
    if (p < 1) this.raf = requestAnimationFrame(this.tick);
    else {
      this.anim = null;
      this.opts.onView?.({ zoom: this.view.k / this.base.k });
    }
  };

  // ── 尺寸 ───────────────────────────────────────────────────────────────
  layout() {
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = w;
    this.cssH = h;
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    // 尺寸变了 → 重新按"铺满"计算基准，并把当前视图按比例挪过去（保持视觉连续）
    const oldBase = this.base;
    this.base = this.fitView();
    if (oldBase.k > 0 && this.view.k > 0) {
      const rel = this.view.k / oldBase.k;
      this.view = { k: this.base.k * rel, tx: this.base.tx, ty: this.base.ty };
    } else {
      this.view = { ...this.base };
    }
    this.draw();
  }

  // ── 绘制 ───────────────────────────────────────────────────────────────
  private draw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme.sea;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const v = this.view;
    ctx.setTransform(this.dpr * v.k, 0, 0, this.dpr * v.k, this.dpr * v.tx, this.dpr * v.ty);
    // ① 陆地 + 行政边界（低对比 = 第 3、4 层）
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.8 / v.k;
    for (let i = 0; i < this.paths.length; i++) {
      const f = this.feats[i];
      const on = this.hi.has(f.adcode);
      ctx.fillStyle = on ? this.theme.accent : this.theme.land;
      ctx.strokeStyle = on ? this.theme.accentLine : this.theme.line;
      ctx.fill(this.paths[i]);
      ctx.stroke(this.paths[i]);
    }
    // ② 标注（屏幕空间画，字号不随缩放变化）
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLabels();
  }

  private drawLabels() {
    const { ctx } = this;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const v = this.view;
    const toScreen = (lng: number, lat: number) => ({
      x: mx(lng) * v.k + v.tx,
      y: my(lat) * v.k + v.ty,
    });
    const put = (txt: string, x: number, y: number, size: number, weight: string) => {
      if (x < 18 || y < 10 || x > this.cssW - 18 || y > this.cssH - 10) return;
      ctx.font = `${weight} ${size}px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.theme.labelHalo;
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = this.theme.label;
      ctx.fillText(txt, x, y);
    };
    if (this.labelMode === "none") return;
    if (this.labelMode === "macro" || this.showMacro) {
      // 全国：只画 7 个大区锚点（规格：≤8，且定点不会互相重叠）
      for (const a of MACRO_ANCHORS) {
        const p = toScreen(a.lng, a.lat);
        put(a.name, p.x, p.y, 13, "600");
      }
      return;
    }
    // 下钻后：要素名（不重叠检查 + 上限，免得又糊成一团）
    const placed: Array<{ x: number; y: number; w: number }> = [];
    const list = [...this.feats].sort((a, b) => areaOf(b) - areaOf(a));
    for (const f of list) {
      if (placed.length >= 12) break;
      const p = toScreen(f.center[0], f.center[1]);
      ctx.font = `600 12px -apple-system, system-ui, sans-serif`;
      const w = ctx.measureText(f.name).width;
      const box = { x: p.x - w / 2 - 4, y: p.y - 9, w: w + 8 };
      if (box.x < 4 || box.x + box.w > this.cssW - 4) continue;
      if (placed.some((q) => !(box.x + box.w < q.x || box.x > q.x + q.w || box.y + 18 < q.y || box.y > q.y + 18)))
        continue;
      placed.push(box);
      put(f.name, p.x, p.y, 12, "600");
    }
  }

  // ── 交互 ───────────────────────────────────────────────────────────────
  private bindPointer() {
    const cv = this.cv;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const sig = ctrl.signal;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; k: number } | null = null;
    const local = (e: PointerEvent | MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    cv.addEventListener(
      "pointerdown",
      (e) => {
        cv.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, local(e));
        if (pts.size === 1) drag = { ...local(e), moved: false };
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.view.k };
          drag = null;
        }
      },
      { signal: sig }
    );

    cv.addEventListener(
      "pointermove",
      (e) => {
        if (pts.has(e.pointerId)) pts.set(e.pointerId, local(e));
        if (pinch && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch.d > 0) {
            const want = clamp(pinch.k * (d / pinch.d), this.base.k * 0.6, this.base.k * 8);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const real = want / this.view.k;
            this.view = {
              k: want,
              tx: mid.x - (mid.x - this.view.tx) * real,
              ty: mid.y - (mid.y - this.view.ty) * real,
            };
            this.draw();
          }
          return;
        }
        if (drag) {
          const p = local(e);
          const dx = p.x - drag.x;
          const dy = p.y - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          drag = { ...p, moved: drag.moved };
          this.view = { ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy };
          this.draw();
          return;
        }
        // 悬停（鼠标）
        if (e.pointerType === "mouse") this.opts.onHover?.(this.hit(local(e)));
      },
      { signal: sig }
    );

    const up = (e: PointerEvent) => {
      const wasDrag = drag?.moved;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) drag = null;
      if (!wasDrag && pts.size === 0) this.opts.onPick?.(this.hit(local(e)));
    };
    cv.addEventListener("pointerup", up, { signal: sig });
    cv.addEventListener("pointercancel", up, { signal: sig });

    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, local(e));
      },
      { signal: sig, passive: false }
    );
  }

  /** 命中判定：屏幕点 → 世界坐标 → 点在哪个多边形里（从上层要素往下找） */
  private hit(p: { x: number; y: number }): GeoFeat | null {
    const wx = (p.x - this.view.tx) / this.view.k;
    const wy = (p.y - this.view.ty) / this.view.k;
    for (let i = this.feats.length - 1; i >= 0; i--) {
      if (inFeature(this.feats[i], wx, wy)) return this.feats[i];
    }
    return null;
  }

  private ctrl: AbortController | null = null;

  destroy() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ctrl?.abort();
  }
}

// ── 纯函数（可单测）──────────────────────────────────────────────────────

/** GeoJSON 的 FeatureCollection → 本模块的 GeoFeat[] */
export function parseFeatures(fc: unknown): GeoFeat[] {
  const out: GeoFeat[] = [];
  const arr = (fc as { features?: unknown[] })?.features;
  if (!Array.isArray(arr)) return out;
  for (const raw of arr) {
    const f = raw as {
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    };
    const p = f.properties || {};
    const g = f.geometry || {};
    const polys = normalizePolys(g.type, g.coordinates);
    if (!polys.length) continue;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const poly of polys)
      for (const ring of poly)
        for (const pt of ring) {
          minLng = Math.min(minLng, pt[0]);
          maxLng = Math.max(maxLng, pt[0]);
          minLat = Math.min(minLat, pt[1]);
          maxLat = Math.max(maxLat, pt[1]);
        }
    const c = Array.isArray(p.center) ? (p.center as number[]) : null;
    out.push({
      adcode: String(p.adcode ?? ""),
      name: String(p.name ?? p.adcode ?? ""),
      center: c && c.length >= 2 ? [Number(c[0]), Number(c[1])] : [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
      polys,
      bbox: [minLng, minLat, maxLng, maxLat],
    });
  }
  return out;
}

/** MultiPolygon / Polygon → 统一成 polygons → rings → points */
function normalizePolys(type: string | undefined, coords: unknown): number[][][][] {
  if (!Array.isArray(coords)) return [];
  if (type === "Polygon") return [coords as number[][][]];
  if (type === "MultiPolygon") return coords as number[][][][];
  return [];
}

/** 一个要素 → Path2D（**世界坐标**，投影用墨卡托；建一次可反复用） */
function buildPath(f: GeoFeat): Path2D {
  const p = new Path2D();
  for (const poly of f.polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const x = mx(ring[i][0]);
        const y = my(ring[i][1]);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
    }
  }
  return p;
}

/** 点是否在要素内（射线法，even-odd；孔洞会被后续环自动排除） */
export function inFeature(f: GeoFeat, x: number, y: number): boolean {
  for (const poly of f.polys) {
    let inside = false;
    for (const ring of poly) {
      let j = ring.length - 1;
      for (let i = 0; i < ring.length; i++) {
        const xi = mx(ring[i][0]);
        const yi = my(ring[i][1]);
        const xj = mx(ring[j][0]);
        const yj = my(ring[j][1]);
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi) inside = !inside;
        j = i;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** 面积（度²，只用于排序/标注优先级） */
export function areaOf(f: GeoFeat): number {
  const [x0, y0, x1, y1] = f.bbox;
  return Math.abs((x1 - x0) * (y1 - y0));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
