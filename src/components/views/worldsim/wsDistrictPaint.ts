// 「世界模拟」小区增量画笔（自己写的一小份，不 import worldmap/** 里的页面与模块）
//
// 为什么自己写、而不是直接复用 `worldmap/DistrictLive.vue` 那套：
//   ① 那个文件是**页面**，import 页面等于把它的样式、状态、连接管理一起拖进来；
//   ② 它在 worldmap/** 目录下 —— 本次改动的文件所有权把那个目录划给了另一个 agent，
//      「不修改」也意味着不该依赖它的内部函数（它一改我就崩）；
//   ③ 我这边要的画法其实更简单：把流式收到的元素攒起来，重算一份 SVG 文本即可
//      （Vue 用 v-html 渲染，新增的图元靠 CSS 自己「弹」出来，见 worldsim.css 的 ws-pop）。
//
// 数据形状与后端 `DistrictStreamEvent` 完全一致（x/y/w/h/type/name/floors、道路两端点），
// 所以两条通路（Tauri Channel / 浏览器 EventSource）都直接吃。

/** 建筑 / 绿地 / 水域的图元（坐标系：0..size 的格子） */
export interface PaintItem {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  type?: string;
  name?: string;
  floors?: number | string;
  /**
   * 入列时间戳（**内部字段**，由 DistrictPaint 自己打，调用方不用管）。
   *
   * ⚠️ 现在**只用于诊断**，不参与任何层序判断：增量画布的层序完全由**类别**决定
   *    （绿地 → 水域 → 道路 → 建筑），与 `toSvg` 逐点一致。曾经拿它做过
   *    「按到达先后归并绿地/水域」，结果与 `toSvg` 的类分层不一致，实测像素差 11%，
   *    已经改掉 —— 别再把它捡回来做排序。
   */
  at?: number;
}

/** 道路图元 */
export interface PaintRoad {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  type?: string;
  name?: string;
  /** 同 PaintItem.at */
  at?: number;
}

/** 一套配色（值抄自 Rust `render.rs::style_of`，保证 AI 精绘与草图/行政区划是同一套视觉语言） */
export interface PaintPalette {
  bg: string;
  blockbg: string;
  park: string;
  parkEdge: string;
  water: string;
  waterEdge: string;
  roadMain: string;
  roadSec: string;
  roadPath: string;
  roadEdge: string;
  text: string;
  textHalo: string;
  bldEdge: string;
  shadow: string;
  /** 建筑类型 → 填充色 */
  bld: Record<string, string>;
}

/** 三个主题的配色（键名与 Rust 侧 style 名一致：gaode / dark / water） */
export function paletteOf(style: string): PaintPalette {
  if (style === "dark") {
    return {
      bg: "#121a26",
      blockbg: "#18222f",
      park: "#1e4637",
      parkEdge: "#2a5c48",
      water: "#19375a",
      waterEdge: "#2a5a8c",
      roadMain: "#3c5070",
      roadSec: "#2a3a52",
      roadPath: "#232f42",
      roadEdge: "#26364e",
      text: "#c8dcf0",
      textHalo: "#0e1620",
      bldEdge: "#5a8cbe",
      shadow: "rgba(0,0,0,.35)",
      bld: {
        residential: "#283c58",
        office: "#374665",
        commercial: "#3c4b46",
        shop: "#46503f",
        restaurant: "#554442",
        cafe: "#504640",
        school: "#32506e",
        hospital: "#5a3c46",
        civic: "#3a4254",
        leisure: "#483c54",
      },
    };
  }
  if (style === "water") {
    return {
      bg: "#f4efe3",
      blockbg: "#faf5e8",
      park: "#dce8cc",
      parkEdge: "#bcd0a8",
      water: "#cfe3ef",
      waterEdge: "#a8c8dc",
      roadMain: "#fdfaf2",
      roadSec: "#f6f0e2",
      roadPath: "#f0ead8",
      roadEdge: "#e0d8c4",
      text: "#6a6252",
      textHalo: "#fdfaf2",
      bldEdge: "#a89c88",
      shadow: "rgba(120,110,90,.18)",
      bld: {
        residential: "#e0d8c8",
        office: "#d4d4cc",
        commercial: "#e8d8b8",
        shop: "#eee0c4",
        restaurant: "#e8d0b0",
        cafe: "#e4d4bc",
        school: "#d0dce4",
        hospital: "#e8d0d0",
        civic: "#dcd8d0",
        leisure: "#e0d4dc",
      },
    };
  }
  return {
    bg: "#e9e7dc",
    blockbg: "#f2f0e8",
    park: "#c8e1be",
    parkEdge: "#a9cf9c",
    water: "#bed7f0",
    waterEdge: "#93b8e0",
    roadMain: "#ffffff",
    roadSec: "#fbfaf5",
    roadPath: "#f5f3ec",
    roadEdge: "#e2dfd4",
    text: "#3c4b5f",
    textHalo: "#ffffff",
    bldEdge: "#9aa7b8",
    shadow: "rgba(60,75,95,.18)",
    bld: {
      residential: "#d6dce6",
      office: "#d2dae8",
      commercial: "#e6d7be",
      shop: "#ebdec3",
      restaurant: "#eed6ba",
      cafe: "#e8d6c4",
      school: "#c8dcf0",
      hospital: "#f0d2d2",
      civic: "#d8d6d0",
      leisure: "#e2d0e2",
    },
  };
}

export interface PaintCounts {
  buildings: number;
  roads: number;
  parks: number;
  water: number;
}

/** 上限：AI 输出不可控，攒到一定量就不再收（超出的只计数不画，进度卡上如实说明） */
const MAX_BUILDINGS = 900;
const MAX_ROADS = 400;
const MAX_PARK = 80;
const MAX_WATER = 80;

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 图元规格（spec）：字符串路径与 DOM 路径的**唯一事实来源**
 *
 * 为什么要把「一个图元有哪些属性」抽出来：
 *   P5-6 给 AI 精绘层加了**增量 DOM** 渲染（见文件末尾的 DistrictCanvas），
 *   于是同一批图元有了两条出口 —— `toSvg()` 出字符串（给 v-html / 自检用），
 *   `DistrictCanvas` 出真 DOM。两条路若各写一份属性表，迟早会漂移出
 *   「跑起来和自检里不一样」这种最难查的 bug。
 *   所以属性只在这里写一次：`toSvg` 把 spec 拼成字符串，Canvas 把 spec 转成属性。
 *
 * ⚠️ 属性顺序有意义：`toSvg` 的输出被自检逐字断言，重排顺序会让自检失败。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个图元的规格：标签名 + 有序属性（值已字符串化）+ 可选文本内容 */
export interface ElSpec {
  tag: string;
  /** `[名, 值]` 有序对 —— 顺序即输出顺序 */
  attrs: [string, string][];
  /** 元素文本（只有 <text> 用；走 textContent，转义由 DOM 负责） */
  text?: string;
}

/** 把 spec 拼成 SVG 文本（自闭合，与原来手拼的字符串逐字一致） */
export function specToText(spec: ElSpec): string {
  let s = `<${spec.tag}`;
  for (const [k, v] of spec.attrs) s += ` ${k}="${v}"`;
  if (spec.text !== undefined) return s + `>${spec.text}</${spec.tag}>`;
  return s + "/>";
}

/** 把 spec 转成真 DOM 节点（SVG 树里一律 SVG 命名空间） */
export function specToNode(spec: ElSpec, doc: Document): Element {
  const el = doc.createElementNS("http://www.w3.org/2000/svg", spec.tag);
  for (const [k, v] of spec.attrs) el.setAttribute(k, v);
  if (spec.text !== undefined) el.textContent = spec.text;
  return el;
}

/** 网格边长 → 绝对长度（原来散在 toSvg 里，现在两边共用） */
function unit(size: number) {
  return (k: number) => Math.max(0.05, size * k);
}

/** 建筑填充色（原来是 `p.bld[type] || p.bld.residential || 兜底`） */
function bldFill(p: PaintPalette, type?: string): string {
  return p.bld[String(type || "residential")] || p.bld.residential || "#d6dce6";
}

/**
 * 建筑图元的属性组（1~3 个 spec：投影 + 本体 + 可选名字）。
 *
 * 名字只给够大的楼：小楼上写字只会糊成一团 —— 阈值 `w*h >= 5.5` 是原实现写死的。
 */
export function buildingSpecs(
  b: PaintItem,
  p: PaintPalette,
  size: number,
  showNames: boolean
): ElSpec[] {
  const w0 = unit(size);
  const x = num(b.x);
  const y = num(b.y);
  const w = Math.max(0.35, num(b.w, 1));
  const h = Math.max(0.35, num(b.h, 1));
  const out: ElSpec[] = [
    {
      tag: "rect",
      attrs: [
        ["x", (x + w0(0.012)).toFixed(3)],
        ["y", (y + w0(0.012)).toFixed(3)],
        ["width", String(w)],
        ["height", String(h)],
        ["fill", p.shadow],
        ["rx", String(w0(0.01))],
      ],
    },
    {
      tag: "rect",
      attrs: [
        ["class", "ws-b"],
        ["x", String(x)],
        ["y", String(y)],
        ["width", String(w)],
        ["height", String(h)],
        ["fill", bldFill(p, b.type)],
        ["stroke", p.bldEdge],
        ["stroke-width", String(w0(0.008))],
        ["rx", String(w0(0.01))],
      ],
    },
  ];
  const name = String(b.name || "").trim();
  if (showNames && name && w * h >= 5.5) {
    const fs = Math.max(0.42, Math.min(w0(0.032), w / (name.length * 0.62)));
    out.push({
      tag: "text",
      attrs: [
        ["x", (x + w / 2).toFixed(3)],
        ["y", (y + h / 2 + fs * 0.36).toFixed(3)],
        ["font-size", fs.toFixed(3)],
        ["text-anchor", "middle"],
        ["fill", p.text],
        ["stroke", p.textHalo],
        ["stroke-width", String(w0(0.006))],
        ["paint-order", "stroke"],
      ],
      text: esc(name.slice(0, 8)),
    });
  }
  return out;
}

/** 道路图元的属性组（2 个 spec：描边打底 + 路面色，叠出「路缘」） */
export function roadSpecs(r: PaintRoad, p: PaintPalette, size: number): ElSpec[] {
  const w0 = unit(size);
  const x1 = num(r.x1);
  const y1 = num(r.y1);
  const x2 = num(r.x2);
  const y2 = num(r.y2);
  const w = r.type === "main" ? w0(0.055) : r.type === "secondary" ? w0(0.034) : w0(0.018);
  const face = r.type === "main" ? p.roadMain : r.type === "secondary" ? p.roadSec : p.roadPath;
  const base = [
    ["x1", String(x1)],
    ["y1", String(y1)],
    ["x2", String(x2)],
    ["y2", String(y2)],
  ];
  return [
    {
      tag: "line",
      attrs: [
        ["class", "ws-t"],
        ...(base as [string, string][]),
        ["stroke", p.roadEdge],
        ["stroke-width", (w + w0(0.012)).toFixed(3)],
        ["stroke-linecap", "round"],
      ],
    },
    {
      tag: "line",
      attrs: [
        ["class", "ws-t"],
        ...(base as [string, string][]),
        ["stroke", face],
        ["stroke-width", w.toFixed(3)],
        ["stroke-linecap", "round"],
      ],
    },
  ];
}

/** 绿地 / 水域的图元（1 个 spec；水域圆角更大） */
export function areaSpec(
  k: PaintItem,
  p: PaintPalette,
  size: number,
  kind: "park" | "water"
): ElSpec {
  const w0 = unit(size);
  const w = Math.max(0.4, num(k.w, 1));
  const h = Math.max(0.4, num(k.h, 1));
  return {
    tag: "rect",
    attrs: [
      ["class", "ws-b"],
      ["x", String(num(k.x))],
      ["y", String(num(k.y))],
      ["width", String(w)],
      ["height", String(h)],
      ["rx", String(kind === "water" ? w0(0.08) : w0(0.05))],
      ["fill", kind === "water" ? p.water : p.park],
      ["stroke", kind === "water" ? p.waterEdge : p.parkEdge],
      ["stroke-width", String(w0(0.012))],
    ],
  };
}

/** 底色 + 街区底（两个固定 rect） */
export function baseSpecs(p: PaintPalette, size: number): ElSpec[] {
  const s = size;
  return [
    {
      tag: "rect",
      attrs: [
        ["x", "0"],
        ["y", "0"],
        ["width", String(s)],
        ["height", String(s)],
        ["fill", p.bg],
      ],
    },
    {
      tag: "rect",
      attrs: [
        ["x", String(s * 0.04)],
        ["y", String(s * 0.04)],
        ["width", String(s * 0.92)],
        ["height", String(s * 0.92)],
        ["rx", String(s * 0.02)],
        ["fill", p.blockbg],
      ],
    },
  ];
}

/**
 * 增量绘制模型：一条流对应一个实例。
 *
 * 用**可变对象 + 计数**而不是响应式数组：流可能一次推几百条，
 * 让 Vue 逐条 diff 反而慢；这里由页面按帧节流调用 `toSvg()` 整份重建
 * （SVG 文本本身很小，重建一次是微秒级）。
 */
export class DistrictPaint {
  /** 网格边长（后端 size，20/28/36…） */
  readonly size: number;
  buildings: PaintItem[] = [];
  roads: PaintRoad[] = [];
  parks: PaintItem[] = [];
  water: PaintItem[] = [];
  /** 因为超过上限被丢掉的条数（如实报给用户，不假装全画了） */
  dropped = 0;

  constructor(size = 28) {
    this.size = Math.max(8, num(size, 28));
  }

  addBuilding(it: PaintItem) {
    if (this.buildings.length >= MAX_BUILDINGS) {
      this.dropped++;
      return;
    }
    this.buildings.push(this.stamp(it));
  }
  addRoad(it: PaintRoad) {
    if (this.roads.length >= MAX_ROADS) {
      this.dropped++;
      return;
    }
    this.roads.push(this.stamp(it));
  }
  addPark(it: PaintItem) {
    if (this.parks.length >= MAX_PARK) {
      this.dropped++;
      return;
    }
    this.parks.push(this.stamp(it));
  }
  addWater(it: PaintItem) {
    if (this.water.length >= MAX_WATER) {
      this.dropped++;
      return;
    }
    this.water.push(this.stamp(it));
  }

  /**
   * 给图元打上入列时间戳（见 PaintItem.at；**只用于诊断**，不影响渲染）。
   *
   * 为什么在这里补、而不是在调用方：调用方有三处（三条流事件 + `loadLayout`），
   * 漏一处就会出现「有的图元没时间戳」这种只在特定流程下复现的缺口。
   */
  private stamp<T extends PaintItem | PaintRoad>(it: T): T {
    if (it && typeof it === "object" && it.at === undefined) it.at = Date.now();
    return it;
  }

  counts(): PaintCounts {
    return {
      buildings: this.buildings.length,
      roads: this.roads.length,
      parks: this.parks.length,
      water: this.water.length,
    };
  }

  get total(): number {
    return this.buildings.length + this.roads.length + this.parks.length + this.water.length;
  }

  clear() {
    this.buildings = [];
    this.roads = [];
    this.parks = [];
    this.water = [];
    this.dropped = 0;
  }

  /**
   * 换成一份完整布局（`done` 事件里的那份）。
   *
   * 为什么要换：流式收的过程中偶尔会丢片段（网络/解析），最终布局才是权威。
   * 直接替换而不是「合并」，避免出现两份重复的楼。
   */
  loadLayout(layout: {
    size?: number;
    buildings?: PaintItem[];
    roads?: PaintRoad[];
    parks?: PaintItem[];
    water?: PaintItem[];
  }) {
    this.clear();
    for (const b of layout?.buildings || []) this.addBuilding(b);
    for (const r of layout?.roads || []) this.addRoad(r);
    for (const p of layout?.parks || []) this.addPark(p);
    for (const w of layout?.water || []) this.addWater(w);
  }

  /**
   * 生成整份 SVG 文本（给 v-html 与**自检**用）。
   *
   * viewBox 用 `0 0 size size`，坐标 1:1 —— 这样流里给的格子坐标不用任何换算，
   * 缩放交给 CSS（`width:100%`），手机上也是清晰的矢量。
   *
   * ⚠️ P5-6 起这个函数**不再是页面的渲染路径**（页面走 DistrictCanvas 增量 DOM），
   *    但它是自检的基准与降级实现，且与 DOM 路径共用同一批 spec builder，
   *    所以两者输出必然一致 —— 别把属性表改回「只在这个函数里写一份」。
   */
  toSvg(p: PaintPalette, opts: { showNames?: boolean } = {}): string {
    const s = this.size;
    const showNames = opts.showNames !== false;
    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" class="ws-paint" role="img">`
    );
    // 底色 + 街区底
    for (const spec of baseSpecs(p, s)) parts.push(specToText(spec));
    // 绿地 / 水域（先画，压在路和楼下面）
    for (const k of this.parks) parts.push(specToText(areaSpec(k, p, s, "park")));
    for (const k of this.water) parts.push(specToText(areaSpec(k, p, s, "water")));
    // 道路：先描边色打底（宽一点），再盖一层路面色 —— 就有「路缘」了
    for (const r of this.roads) for (const spec of roadSpecs(r, p, s)) parts.push(specToText(spec));
    // 建筑：投影 + 本体 + 名字
    for (const b of this.buildings)
      for (const spec of buildingSpecs(b, p, s, showNames)) parts.push(specToText(spec));

    parts.push("</svg>");
    return parts.join("");
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * P5-6：增量 DOM 画布 —— AI 精绘层的正式渲染路径
 *
 * ── 为什么要有它（实测数据）──────────────────────────────────────────────
 *   原来的做法是每帧 `aiSvgInner.value = paint.toSvg(...)`，再由 `<div v-html>`
 *   整份替换。实测（同结构人造 DOM，1002 个 SVG 节点 / 69KB HTML）：
 *       每帧 innerHTML = markup ：186.81ms/帧，5.4fps，jank 100%
 *       同样 DOM 只建一次       ： 16.67ms/帧，60.0fps，jank 0%
 *   **11.2 倍**，而且代价不在「节点多」，在「每帧重新解析 69KB 文本并重建整棵树」。
 *
 * ── 顺便修掉一个一直没生效的动画 ─────────────────────────────────────────
 *   `worldsim.css:735-737` 给 `.ws-neigh__ai svg .ws-b/.ws-t` 挂了 `ws-pop 0.34s`
 *   （「新画上去的建筑轻微弹出」）。但整棵树每帧被重建 → 每个元素每帧都是新的
 *   → 那个 0.34s 动画**每帧重启一次、永远播不完**，实际观感是「所有元素一直在淡入」。
 *   改成增量之后，`ws-pop` 才真的是「新增的那几个元素弹一下」，与注释里的意图一致。
 *   → **这是修好，不是改观感**：初次加载的最终画面两者完全一样。
 *
 * ── 与 `WorldMap/DistrictLive.vue` 的关系 ────────────────────────────────
 *   那边用的是同一套思路（每条事件 createElementNS 造一个节点直接 append）。
 *   这里**不 import 那个文件**：它是 worldmap/** 下的页面，import 页面等于把它的
 *   样式与状态一起拖进来（原 wsDistrictPaint 文件头已说明过这个边界）。
 *   所以照同样的思路、用这边自己的 spec builder 重写一份小的。
 * ══════════════════════════════════════════════════════════════════════════ */

export class DistrictCanvas {
  /** 根 <svg>（由本类创建并持有；外面只管把它塞进容器） */
  readonly root: SVGSVGElement;
  private readonly doc: Document;
  /** 已落 DOM 的条数（按类别）—— 用它算「这一帧新增了哪几条」，只 append 增量 */
  private n: PaintCounts = { buildings: 0, roads: 0, parks: 0, water: 0 };
  /** 当前配色。换配色 = 整体重画（本类不再复用，外面会 new 一个新的） */
  private palette: PaintPalette;
  private readonly showNames: boolean;
  /**
   * 三个**分层标记**（空注释节点），把根 svg 切成四段固定层带：
   *
   *    底色 → [绿地] waterMark → [水域] roadMark → [道路] bldMark → [建筑(append)]
   *
   * 每个标记的位置在整块画布的生命周期里**永不移动**：新元素一律
   * `insertBefore(..., 本层带的右边界标记)`，于是**层序完全由类别决定，
   * 与到达顺序无关**，也就与 `toSvg` 的分组顺序逐点一致。
   *
   * 为什么非这样不可（都是实测踩出来的）：
   *   · 按「到达即 append」→ 若建筑先到、道路后到，路就**盖在楼上**，
   *     与 `toSvg` 正好相反（像素对比 A/B 层序相反，差异 11%）。
   *   · 拿一个会移动的节点（如「最后一个低层节点」）当锚点 → 顺序被逐帧倒过来。
   *   · 逐元素 `insertBefore` 到同一锚点 → 整批被倒序，必须先装 DocumentFragment。
   * 用注释节点而不是元素：不参与渲染、不影响选择器、不会被 CSS 命中。
   */
  private readonly waterMark: ChildNode;
  private readonly roadMark: ChildNode;
  private readonly bldMark: ChildNode;

  constructor(palette: PaintPalette, size: number, doc: Document = document, showNames = true) {
    this.doc = doc;
    this.palette = palette;
    this.showNames = showNames;
    const s = Math.max(8, Math.floor(size) || 28);
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    // 与 toSvg 的根元素逐项一致（viewBox / class / role；xmlns 在 DOM 里由命名空间承载）
    svg.setAttribute("viewBox", `0 0 ${s} ${s}`);
    svg.setAttribute("class", "ws-paint");
    svg.setAttribute("role", "img");
    for (const spec of baseSpecs(palette, s)) svg.appendChild(specToNode(spec, doc));
    // 三个标记一次排好，此后位置永不改变（层带右边界）：
    //   底色 → [绿地] waterMark → [水域] roadMark → [道路] bldMark → [建筑]
    // 绿地与水域分开标记，因为 `toSvg` 里**绿地永远在水域下面**（两层，不是一个混排带）。
    // 绿地带的左边界就是底色末尾，不需要单独一个标记。
    this.waterMark = doc.createComment("ws-water");
    this.roadMark = doc.createComment("ws-roads");
    this.bldMark = doc.createComment("ws-buildings");
    for (const m of [this.waterMark, this.roadMark, this.bldMark]) svg.appendChild(m);
    this.root = svg;
  }

  /** 网格边长（从 viewBox 反推，外面不用再记一份） */
  private get size(): number {
    const vb = this.root.getAttribute("viewBox") || "";
    return Number(vb.split(/\s+/)[2]) || 28;
  }

  /**
   * 把「画笔里现有的全部图元」对齐到 DOM。
   *
   * 只做 **append**：已落 DOM 的节点一个都不碰。
   * ⚠️ 前提：各类图元只增不减（`loadLayout` 会先 clear 再加，那种情况外面重建画布）。
   *   若某一类**变少**了，说明状态被换过，这里会保守地整体重来。
   */
  sync(paint: DistrictPaint) {
    // 变少 = 状态被换过（loadLayout / new DistrictPaint）：整体重来，保证不会残留旧节点
    if (
      paint.buildings.length < this.n.buildings ||
      paint.roads.length < this.n.roads ||
      paint.parks.length < this.n.parks ||
      paint.water.length < this.n.water
    ) {
      this.clear();
    }
    const p = this.palette;
    const s = this.size;
    const doc = this.doc;

    // 绿地 / 水域：必须在道路与建筑**下面**。正常顺序下它们本来就是先到的；
    // 万一晚到，就插在「建筑层第一条」之前，而不是无脑 append 到最上面。
    // 绿地 / 水域：必须在道路与建筑**下面**，且两者之间保持 `toSvg` 的分层 ——
    // **所有绿地在下、所有水域在上**（`toSvg` 就是先遍历 parks 再遍历 water）。
    //
    // ⚠️ 这里**不能**按「到达先后」混排。踩过的坑（实测量化）：
    //    原来按 `at` 归并，绿地与水域的上下关系就变成「谁先到谁在下」，
    //    而产品是「绿地永远在水域下面」。两者在**互相重叠**时z序相反 →
    //    实测像素对比出现 11.0% 的颜色差异（19433/176400 个像素）。
    //    所以这里按**类别**定位，与 toSvg 的分层逐点一致：
    //      · 新绿地 → 插在「第一个水域」之前（没有水域就插在低层带末尾）
    //      · 新水域 → 追加到低层带末尾（后面就是道路/建筑，天然压在它们下面）
    //    标记节点 lowMark 固定在低层带末尾，是这一切的锚点。
    const parkEls: Element[] = [];
    for (let i = this.n.parks; i < paint.parks.length; i++)
      parkEls.push(specToNode(areaSpec(paint.parks[i], p, s, "park"), doc));
    const waterEls: Element[] = [];
    for (let i = this.n.water; i < paint.water.length; i++)
      waterEls.push(specToNode(areaSpec(paint.water[i], p, s, "water"), doc));

    // 绿地插在自己的层带里（waterMark 之前），水域插在 waterMark 之前。
    // 两个标记位置固定 → 无论两类谁先到，都是「绿地在下、水域在上」。
    // ⚠️ 必须先装 DocumentFragment 再一次性插：逐元素 insertBefore 到同一锚点会把整批倒序。
    if (parkEls.length) {
      const band = doc.createDocumentFragment();
      for (const el of parkEls) band.appendChild(el);
      this.root.insertBefore(band, this.waterMark);
    }
    if (waterEls.length) {
      const band = doc.createDocumentFragment();
      for (const el of waterEls) band.appendChild(el);
      this.root.insertBefore(band, this.roadMark);
    }

    // 道路：插在 **bldMark 之前**（= 道路层带的末尾）。
    //
    // ⚠️ 各层带必须插在**自己的右边界标记**之前，不能都图省事插到同一个标记前：
    //    那样三个层带的元素会被**倒序压进同一个栈**里 —— 实测（同一份数据：
    //    `toSvg` 的楼名字是「楼5 楼11 … 楼119」，而栽进去的 DOM 变成
    //    「楼113 楼119 楼107 … 楼5」这种严格倒序），像素差 59%。
    if (this.n.roads < paint.roads.length) {
      const band = doc.createDocumentFragment();
      for (let i = this.n.roads; i < paint.roads.length; i++) {
        for (const spec of roadSpecs(paint.roads[i], p, s)) band.appendChild(specToNode(spec, doc));
      }
      this.root.insertBefore(band, this.bldMark);
    }

    // 建筑：建筑带是最后一层，插在末尾（= append）。用 insertBefore 会对**倒序** ——
    // 这正是上面那个「楼113 楼119 楼107…」bug 的一半原因。
    if (this.n.buildings < paint.buildings.length) {
      const band = doc.createDocumentFragment();
      for (let i = this.n.buildings; i < paint.buildings.length; i++) {
        for (const spec of buildingSpecs(paint.buildings[i], p, s, this.showNames))
          band.appendChild(specToNode(spec, doc));
      }
      this.root.appendChild(band);
    }

    this.n = {
      buildings: paint.buildings.length,
      roads: paint.roads.length,
      parks: paint.parks.length,
      water: paint.water.length,
    };
  }

  /** 清空全部图元（保留根 svg、底色与 lowMark 标记） */
  clear() {
    // 只删**元素**节点：lowMark 是注释节点，必须留下（它是低层带的插入点）。
    // 所以按元素个数判断，而不是数 childNodes（注释也算 childNodes）。
    while (this.root.querySelectorAll("*").length > baseSpecs(this.palette, this.size).length) {
      let lastEl: ChildNode | null = this.root.lastChild;
      while (lastEl && lastEl.nodeType !== 1) lastEl = lastEl.previousSibling;
      if (!lastEl) break;
      this.root.removeChild(lastEl);
    }
    this.n = { buildings: 0, roads: 0, parks: 0, water: 0 };
  }

  /** 已落 DOM 的条数（自检/诊断用） */
  rendered(): PaintCounts {
    return { ...this.n };
  }
}
