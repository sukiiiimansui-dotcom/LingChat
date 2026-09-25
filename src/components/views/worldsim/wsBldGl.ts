/**
 * wsBldGl.ts —— **楼房直画 WebGL2**（MapLibre 自定义层，实例化方盒）
 *
 * ## 为什么有它（机主 2026-09-25「去全网搜一下有没有直接调用 webgl 的方法」→「做」）
 * 今天一下午的坑几乎同形：**被 MapLibre 的样式层夹在中间** ——
 * `fill-extrusion-height:["get","h3d"]` 缺字段 → 高度 0 → 一地图**平躺的板**；深色描边在小比例下盖住填充；
 * 阈值两处各写一份；`fill-extrusion` 开销**随要素数线性增长**（官方性能要点也这么说）⇒ 只能"只画 100 栋"兜。
 * 直接写 GL 就把这些决定权拿回来：高度我们自己算（缺就自己兜底）、颜色我们自己定、
 * **实例化**画上万栋也只是几次 draw call、不写样式表达式 ⇒ 不会再撞"样式校验失败 ⇒ load 永不触发"。
 *
 * ## 结构（**纯逻辑与 GL 分离**，前者能在 Node 里自检）
 * · `buildBldBoxes(features, opts)` —— **纯函数**：真脚印 → 外接盒实例（中心/尺寸/颜色），
 *   经纬度→墨卡托换算**自己写**（`mercatorXOf/mercatorYOf/metersToMercator`），
 *   ⇒ 不依赖 maplibre 模块即可单测（浏览器里再与 `MercatorCoordinate` 对拍）。
 * · `createBldGlLayer({...})` —— MapLibre `type:"custom"` + `renderingMode:"3d"` 的层：
 *   24 顶点方盒 + 逐实例 `a_center/a_size/a_color`，`render(gl, matrix)` 里一次 `drawElementsInstanced`。
 *
 * ## 纪律
 * · **默认关**（页面 `?glbld=1` 才建层）；不动现有 `bld-ext/bld-line` 图层 —— 可随时对照/回退。
 * · 只画**方盒**（外接盒，不是精确轮廓）—— 这是**画面**，不是事实：HUD 必须写明"方盒近似"。
 * · 高度来源沿用共享真源 `wsBuildingLook.renderHeight` 的结果（`h3d`），缺了就按 8m 兜底并**计数**，不静默。
 */

export interface BldBoxInput {
  /** 外环（经纬度）；取包围盒 —— 方盒近似 */
  ring?: number[][] | null;
  /** 渲染高度（米）；来自共享真源的上妆结果 `h3d` */
  h3d?: number | null;
  /** 颜色（CSS 十六进制，如 `#9fd8ff`）；没有就按高度分档取色 */
  color?: string | null;
}

export interface BldBoxOpts {
  /** 高度缺失时的兜底（米）——**会记进 stats.fallbackHeight**，不静默 */
  fallbackHeight?: number;
  /** 过小的楼跳过（米²，包围盒面积）——亚像素的盒子纯属浪费 */
  minFootprintM2?: number;
  /** 上限（防一次上传几万个；`null` = 不限） */
  cap?: number | null;
  /** 高度分档取色（低→高）；给了 `color` 的要素优先用它 */
  ramp?: Array<[number, string]>;
}

export interface BldBoxStats {
  /** 输入要素数 */
  considered: number;
  /** 真正生成方盒的栋数 */
  boxes: number;
  /** 因为太小被跳过的 */
  skippedSmall: number;
  /** 因为超过上限被跳过的（**如实报，不静默**） */
  skippedCap: number;
  /** 高度缺失、用了兜底值的（**如实报**） */
  fallbackHeight: number;
  /** 没有有效外环、定位不到而跳过的 */
  noRing: number;
  /** 人读口径（HUD 直接用） */
  why: string;
}

const R = 6378137;
const D2R = Math.PI / 180;

/** 经度 → 墨卡托 x ∈ [0,1]（与 MapLibre `MercatorCoordinate` 同式） */
export function mercatorXOf(lng: number): number { return (lng + 180) / 360; }
/** 纬度 → 墨卡托 y ∈ [0,1]（同式） */
export function mercatorYOf(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))) / 360;
}
/** 米 → 墨卡托单位（同 `MercatorCoordinate.meterInMercatorCoordinateUnits()`） */
export function metersToMercator(lat: number): number { return 1 / (2 * Math.PI * R * Math.cos(lat * D2R)); }

/** `#rgb`/`#rrggbb` → [r,g,b] ∈ [0,1]；解析不出来返回 null（**不瞎猜颜色**） */
export function hexToRgb(s: string | null | undefined): [number, number, number] | null {
  if (!s) return null;
  let t = String(s).trim().replace(/^#/, "");
  if (t.length === 3) t = t.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return null;
  return [parseInt(t.slice(0, 2), 16) / 255, parseInt(t.slice(2, 4), 16) / 255, parseInt(t.slice(4, 6), 16) / 255];
}

function ringBBox(ring: number[][]): { w: number; s: number; e: number; n: number } | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, k = 0;
  for (const p of ring || []) {
    const x = Number(p?.[0]), y = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; k++;
  }
  return k >= 3 ? { w, s, e, n } : null;
}

/**
 * **纯函数**：真脚印 → 实例化方盒。
 * 返回 `{ count, center:Float32Array(3N), size:Float32Array(3N), color:Float32Array(3N), stats }`，
 * 全部按**墨卡托**单位（`center.z` 是盒子**底面**的高度，`size.z` 是高度）。
 */
export function buildBldBoxes(features: readonly BldBoxInput[], opts: BldBoxOpts = {}) {
  const fallbackH = Number.isFinite(opts.fallbackHeight as number) ? (opts.fallbackHeight as number) : 8;
  const minM2 = Number.isFinite(opts.minFootprintM2 as number) ? (opts.minFootprintM2 as number) : 30;
  const cap = opts.cap == null ? Infinity : Math.max(0, Math.floor(opts.cap));
  const ramp = (opts.ramp || []).map(([h, c]) => [h, hexToRgb(c) || [0.7, 0.8, 0.9]] as [number, [number, number, number]]);

  const center: number[] = [], size: number[] = [], color: number[] = [];
  const st: BldBoxStats = { considered: features.length, boxes: 0, skippedSmall: 0, skippedCap: 0, fallbackHeight: 0, noRing: 0, why: "" };

  for (const f of features) {
    if (st.boxes >= cap) { st.skippedCap++; continue; }
    const bb = f?.ring ? ringBBox(f.ring) : null;
    if (!bb) { st.noRing++; continue; }
    const lat0 = (bb.s + bb.n) / 2, lng0 = (bb.w + bb.e) / 2;
    const mx = metersToMercator(lat0);
    const wM = Math.abs(bb.e - bb.w) * 111320 * Math.cos(lat0 * D2R);
    const dM = Math.abs(bb.n - bb.s) * 110540;
    if (wM * dM < minM2) { st.skippedSmall++; continue; }          // 亚像素的盒子不值得传
    let h = Number(f.h3d);
    if (!Number.isFinite(h) || h <= 0) { h = fallbackH; st.fallbackHeight++; }
    const c = hexToRgb(f.color) || (ramp.length
      ? (ramp.reduce((acc, [hh, cc]) => (h >= hh ? cc : acc), ramp[0][1]) as [number, number, number])
      : [0.62, 0.75, 0.88]);
    center.push(mercatorXOf(lng0), mercatorYOf(lat0), 0);
    size.push(Math.max(2, wM) * mx, Math.max(2, dM) * mx, h * mx);
    color.push(c[0], c[1], c[2]);
    st.boxes++;
  }
  st.why = `方盒 ${st.boxes} 栋 / 输入 ${st.considered}（跳过：太小 ${st.skippedSmall} · 超上限 ${st.skippedCap}`
    + ` · 无外环 ${st.noRing} · **用兜底高度 ${st.fallbackHeight}**）`;
  return {
    count: st.boxes,
    center: new Float32Array(center),
    size: new Float32Array(size),
    color: new Float32Array(color),
    stats: st,
  };
}

const VS = `#version 300 es
in vec3 a_local;
in vec3 a_normal;
in vec3 a_center;
in vec3 a_size;
in vec3 a_color;
uniform mat4 u_matrix;
out vec3 v_color;
out vec3 v_n;
void main() {
  vec3 world = a_center + a_local * a_size;
  gl_Position = u_matrix * vec4(world, 1.0);
  /* 固定光（左上）；够便宜、也够把盒子"立"起来 —— 观感细节以后再说，这一版只要"看得出是 3D" */
  vec3 L = normalize(vec3(-0.45, -0.6, 0.8));
  v_n = a_normal;
  v_color = a_color * (0.62 + 0.38 * max(dot(a_normal, L), 0.0));
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec3 v_n;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

/** 24 顶点 / 36 索引的单位方盒（中心在原点，边长 1；`a_local` ∈ [-.5,.5]） */
function unitBox() {
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  const faces: Array<[number[], number[]]> = [
    [[-0.5, -0.5, 0.5], [0, 0, 1]], [[0.5, -0.5, 0.5], [0, 0, 1]], [[0.5, 0.5, 0.5], [0, 0, 1]], [[-0.5, 0.5, 0.5], [0, 0, 1]],
    [[0.5, -0.5, -0.5], [0, 0, -1]], [[-0.5, -0.5, -0.5], [0, 0, -1]], [[-0.5, 0.5, -0.5], [0, 0, -1]], [[0.5, 0.5, -0.5], [0, 0, -1]],
    [[-0.5, -0.5, -0.5], [-1, 0, 0]], [[-0.5, -0.5, 0.5], [-1, 0, 0]], [[-0.5, 0.5, 0.5], [-1, 0, 0]], [[-0.5, 0.5, -0.5], [-1, 0, 0]],
    [[0.5, -0.5, 0.5], [1, 0, 0]], [[0.5, -0.5, -0.5], [1, 0, 0]], [[0.5, 0.5, -0.5], [1, 0, 0]], [[0.5, 0.5, 0.5], [1, 0, 0]],
    [[-0.5, 0.5, 0.5], [0, 1, 0]], [[0.5, 0.5, 0.5], [0, 1, 0]], [[0.5, 0.5, -0.5], [0, 1, 0]], [[-0.5, 0.5, -0.5], [0, 1, 0]],
    [[-0.5, -0.5, -0.5], [0, -1, 0]], [[0.5, -0.5, -0.5], [0, -1, 0]], [[0.5, -0.5, 0.5], [0, -1, 0]], [[-0.5, -0.5, 0.5], [0, -1, 0]],
  ];
  for (const [pp, nn] of faces) { p.push(...pp); n.push(...nn); }
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  return { pos: new Float32Array(p), nrm: new Float32Array(n), idx: new Uint16Array(idx) };
}

export interface BldGlLayerOpts { id?: string; boxes: ReturnType<typeof buildBldBoxes>; }

/**
 * MapLibre 自定义层（`renderingMode:"3d"` ⇒ 进深度缓冲，能和地形/其它楼互相遮挡）。
 * `update(boxes)` 换一批实例（**只重传缓冲，不重建层**）。
 */
export function createBldGlLayer(opts: BldGlLayerOpts) {
  let gl: WebGL2RenderingContext | null = null;
  let prog: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vboBox: WebGLBuffer | null = null, vboNrm: WebGLBuffer | null = null, ebo: WebGLBuffer | null = null;
  let vboC: WebGLBuffer | null = null, vboS: WebGLBuffer | null = null, vboCol: WebGLBuffer | null = null;
  let uni: WebGLUniformLocation | null = null;
  let cur = opts.boxes;
  const stats = { draws: 0, lastInstances: 0, errors: 0, lastError: "" as string,
    /* 🔍 诊断（2026-09-25 首跑 draw=0 / 错误 3 时加的）：把 GL 版本与**每个 shader 的编译日志**都留下来，
       否则只知道"失败了"、不知道为什么 —— 今天已经因为"没有回执"栽过好几次。 */
    glVersion: "" as string, isWebGL2: null as boolean | null, logs: [] as string[] };

  function upload() {
    if (!gl || !vboC) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vboC); gl.bufferData(gl.ARRAY_BUFFER, cur.center, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboS!); gl.bufferData(gl.ARRAY_BUFFER, cur.size, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCol!); gl.bufferData(gl.ARRAY_BUFFER, cur.color, gl.DYNAMIC_DRAW);
    stats.lastInstances = cur.count;
  }

  return {
    id: opts.id || "bld-gl",
    type: "custom" as const,
    renderingMode: "3d" as const,
    /** 自检/HUD 用：层自己报的可数口径（不是我们从外面猜的） */
    glStats: () => ({ ...stats, instances: cur.count }),
    update(boxes: ReturnType<typeof buildBldBoxes>) { cur = boxes; upload(); },
    onAdd(_map: unknown, g: WebGL2RenderingContext) {
      gl = g;
      try {
        stats.glVersion = String(g.getParameter(g.VERSION) || "?");
        stats.isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (g instanceof WebGL2RenderingContext);
      } catch (e) { stats.logs.push("取 VERSION 失败：" + String(e).slice(0, 80)); }
      const box = unitBox();
      const mk = (type: number, src: string) => {
        const s = g.createShader(type);
        if (!s) { stats.errors++; stats.logs.push("createShader 返回 null（type=" + type + "）"); stats.lastError = "createShader null"; return s as unknown as WebGLShader; }
        g.shaderSource(s, src); g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
          stats.errors++;
          const log = String(g.getShaderInfoLog(s) ?? "(空日志)").slice(0, 220);
          stats.lastError = log; stats.logs.push((type === g.VERTEX_SHADER ? "VS: " : "FS: ") + log);
        }
        return s;
      };
      prog = g.createProgram()!;
      g.attachShader(prog, mk(g.VERTEX_SHADER, VS));
      g.attachShader(prog, mk(g.FRAGMENT_SHADER, FS));
      g.linkProgram(prog);
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
        stats.errors++;
        const pl = String(g.getProgramInfoLog(prog) ?? "(空日志)").slice(0, 220);
        stats.lastError = pl; stats.logs.push("LINK: " + pl);
      }
      uni = g.getUniformLocation(prog, "u_matrix");
      vao = g.createVertexArray(); g.bindVertexArray(vao);
      const attr = (name: string) => g.getAttribLocation(prog!, name);
      const bind = (buf: WebGLBuffer, loc: number, size: number, div = 0) => {
        g.bindBuffer(g.ARRAY_BUFFER, buf); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, size, g.FLOAT, false, 0, 0);
        if (div) g.vertexAttribDivisor(loc, div);
      };
      vboBox = g.createBuffer()!; g.bindBuffer(g.ARRAY_BUFFER, vboBox); g.bufferData(g.ARRAY_BUFFER, box.pos, g.STATIC_DRAW); bind(vboBox, attr("a_local"), 3);
      vboNrm = g.createBuffer()!; g.bindBuffer(g.ARRAY_BUFFER, vboNrm); g.bufferData(g.ARRAY_BUFFER, box.nrm, g.STATIC_DRAW); bind(vboNrm, attr("a_normal"), 3);
      ebo = g.createBuffer()!; g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ebo); g.bufferData(g.ELEMENT_ARRAY_BUFFER, box.idx, g.STATIC_DRAW);
      vboC = g.createBuffer()!; bind(vboC, attr("a_center"), 3, 1);
      vboS = g.createBuffer()!; bind(vboS, attr("a_size"), 3, 1);
      vboCol = g.createBuffer()!; bind(vboCol, attr("a_color"), 3, 1);
      upload();
      g.bindVertexArray(null);
    },
    render(g: WebGL2RenderingContext, matrix: number[]) {
      if (!prog || !vao || cur.count === 0) return;
      g.useProgram(prog);
      g.uniformMatrix4fv(uni, false, new Float32Array(matrix));
      g.bindVertexArray(vao);
      g.enable(g.DEPTH_TEST); g.depthFunc(g.LEQUAL);
      g.enable(g.CULL_FACE); g.cullFace(g.BACK);
      g.drawElementsInstanced(g.TRIANGLES, 36, g.UNSIGNED_SHORT, 0, cur.count);
      stats.draws++; stats.lastInstances = cur.count;
      g.bindVertexArray(null);
    },
    onRemove() { stats.errors = stats.errors; gl = null; },
  };
}
