/* wsBldAssets.ts —— **近景的社区资产**（Kenney City Kit，CC0）与它那一档 LOD 的切换规矩。
 *
 * ## 为什么单独一个文件
 * 程序化那条路（`wsBldMesh` + 变体）与资产这条路要**共用同一份楼记录**：
 * 同一份 `places`（`wsBldMesh.buildBldMeshData()` 用画楼那批外环算出来的
 * `[中心X, 中心Z, 底, 顶, 宽, 深, 旋转, 高]`）⇒ 同 id / 同高 / 同占地。
 * 本文件只做三件事：
 *   ① 取资产包（`public/ws3d/bldassets/`：pack.json + pack.bin + colormap.png，构建期生成）；
 *   ② 按楼记录建 `InstancedMesh`（同资产多栋一个 draw），矩阵 = 平移 × 绕Y旋转 × 缩放；
 *   ③ 双档切换的**纯规则**：迟滞阈值 + 交叉淡入淡出时间线（可单测，不碰 three）。
 *
 * ## 不做什么
 * · 不 import three（运行时那份是裁剪构建，由调用方把 THREE 传进来 —— 与后端同一套做法）；
 * · 不读相机/地图（视图中心与半径由调用方每帧递进来）；
 * · 不碰 DOM（除了 `fetch` 与纹理 URL）。
 *
 * ## 资产包的来源与许可
 * Kenney City Kit Commercial 2.1，CC0-1.0。构建脚本 `scripts/build-bld-assets.mjs`，
 * 产物在 `public/ws3d/bldassets/`（`LICENSE.txt` 一并带上来源）。
 */

import { hashId } from "./wsBldFacade";
import { PLACE_STRIDE } from "./wsBldMesh";

/** 资产包目录（运行时从 public 取，与 `vendor/three.min.js` 同一套静态路径口径） */
export const BLD_ASSET_BASE = "/ws3d/bldassets/";

/* ── 双档阈值（米/CSS 像素） ─────────────────────────────────────────────────
 * `mpp` 是"一米在屏幕上占几个 CSS 像素"的倒数（与 `wsBldLod` 同一把尺子）。
 * 进入 = 更近（mpp 小），退出 = 更远（mpp 大），**中间那段谁都不翻档** ⇒ 不会来回抖。
 * 换算（纬度 29.56、视口高 720）：0.42 ≈ zoom 17.3、0.54 ≈ zoom 16.95，
 * 也就是"摇杆近景推满（+1.18 级）就进资产档"，松手回来才退。 */
export const ASSET_ENTER_MPP = 0.42;
export const ASSET_EXIT_MPP = 0.54;
/** 交叉淡入淡出时长（毫秒）：两套几何同位置，透明度此消彼长 */
export const ASSET_FADE_MS = 260;
/** 一次最多同时画几个资产实例（超了就不进资产档，宁可用程序化，也不留空洞） */
export const ASSET_CAP = 420;
/**
 * 视野中心多大范围内的楼才进资产层（视野半径的倍数）。
 * 为什么远大于 1：`radius` 只是**屏幕半高**对应的地面半径；俯角一抬，屏幕上沿看到的地面
 * 要远得多（俯角 38° 实测是 2~3 倍，70° 还会更远）。取小了，进资产档时程序化那层被藏起来
 * ⇒ **远处那几栋会凭空消失**（就是"空洞"）。所以按 4.5 倍 + 240 米下限筛，
 * 宁可多画几栋（每栋约 2.2k 三角），也不留空洞。 */
export const ASSET_VIEW_MARGIN = 4.5;
/** 视野半径很小时的**距离下限**（米）：近景推到底也不至于把旁边那栋漏掉 */
export const ASSET_VIEW_MIN_M = 240;
/** 水平方向相对竖向的**最大拉伸倍数**（超了宁可窄一点，也不把窗户拉成一条） */
export const ASSET_MAX_STRETCH = 2.8;

export interface BldAssetMeta {
  name: string;
  class: "mid" | "tall";
  verts: number;
  tris: number;
  /** pack.bin 内的字节偏移（段首 4 字节对齐） */
  pos: number;
  uv: number;
  shade: number;
  idx: number;
  idxCount: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ]（已平移到占地中心、底面 y=0） */
  bbox: number[];
  /** [宽, 高, 深]（资产单位） */
  size: number[];
  tex: string | null;
}

export interface BldAssetPack {
  meta: BldAssetMeta[];
  /** 所有资产拼成的一个 ArrayBuffer（位置 f32 / uv u16 归一化 / 明暗 u8 / 索引 u16） */
  bin: ArrayBuffer;
  texture: string;
  counts: { assets: number; verts: number; tris: number };
  binBytes: number;
}

/** `ArrayBuffer` + JSON 清单（构建期产物，见 `scripts/build-bld-assets.mjs`） */
export async function loadBldAssetPack(
  base: string = BLD_ASSET_BASE,
  fetchImpl: typeof fetch | null = (typeof fetch !== "undefined" ? fetch : null)
): Promise<BldAssetPack> {
  if (!fetchImpl) throw new Error("没有 fetch：取不了资产包");
  const jr = await fetchImpl(base + "pack.json", { cache: "force-cache" } as RequestInit);
  if (!jr.ok) throw new Error("pack.json HTTP " + jr.status);
  const json = (await jr.json()) as Partial<BldAssetPack> & { assets?: BldAssetMeta[] };
  if (!Array.isArray(json.assets) || !json.assets.length) throw new Error("pack.json 里没有 assets");
  const br = await fetchImpl(base + (json.bin || "pack.bin"), { cache: "force-cache" } as RequestInit);
  if (!br.ok) throw new Error("pack.bin HTTP " + br.status);
  const bin = await br.arrayBuffer();
  const need = Number(json.binBytes || 0);
  if (need > 0 && bin.byteLength < need) throw new Error("pack.bin 长度不对（" + bin.byteLength + " < " + need + "）");
  return {
    meta: json.assets,
    bin,
    texture: json.texture || "colormap.png",
    counts: json.counts || { assets: json.assets.length, verts: 0, tris: 0 },
    binBytes: bin.byteLength,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、纯规则（可单测；不碰 three / DOM）
 * ══════════════════════════════════════════════════════════════════════════ */

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const unitOf = (x: number): number => (x % 1000) / 1000;

/** 双档迟滞：进入用 `ASSET_ENTER_MPP`、退出用 `ASSET_EXIT_MPP`，中间保持原档 */
export function assetTierStep(prev: 0 | 1, mpp: number): 0 | 1 {
  const m = Number(mpp);
  if (!Number.isFinite(m) || m <= 0) return prev;
  if (prev === 1) return m >= ASSET_EXIT_MPP ? 0 : 1;
  return m <= ASSET_ENTER_MPP ? 1 : 0;
}

/** 交叉淡入淡出的一步：`cur` 0..1，`target` 0/1，按真实经过时间推进（掉帧也不会跳变） */
export function assetFadeStep(cur: number, target: 0 | 1, dtMs: number, durMs: number = ASSET_FADE_MS): number {
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
  const dur = Number.isFinite(durMs) && durMs > 0 ? durMs : ASSET_FADE_MS;
  const c = clamp01(Number.isFinite(cur) ? cur : 0);
  const step = dt / dur;
  return target === 1 ? Math.min(1, c + step) : Math.max(0, c - step);
}

/**
 * 给一栋楼挑资产：**先按高度分池**（高楼用摩天楼），再按"楼体高宽比 vs 资产高宽比"打分，
 * 最后叠一点 id 哈希的抖动 —— 同一栋楼永远挑同一个资产（可复算），不同的楼会散开。
 *
 * 为什么要对高宽比：资产是按楼的包围盒**非均匀缩放**上去的；高宽比差太远，
 * 窗户会被拉成横条/竖条（比"重复"更难看）。所以宁可选一个"像它"的模型。
 */
export function pickAssetIndex(meta: readonly BldAssetMeta[], id: string, h: number, w: number, d: number): number {
  if (!meta.length) return -1;
  const foot = Math.max(0.5, Math.sqrt(Math.max(0.25, w * d)));
  const aspect = Math.max(0.05, h) / foot;
  const tall = h >= 45;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i]!;
    if ((m.class === "tall") !== tall) continue;
    const a = Math.max(0.05, m.size[1]) / Math.max(0.05, Math.sqrt(Math.max(0.04, m.size[0] * m.size[2])));
    const jitter = unitOf(hashId(id + "|" + m.name));
    const score = Math.abs(Math.log(aspect / a)) + 0.22 * jitter;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  /* 池子空了（不该发生：两档都有资产）⇒ 退回全池里挑最像的 */
  if (best < 0) {
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i]!;
      const a = Math.max(0.05, m.size[1]) / Math.max(0.05, Math.sqrt(Math.max(0.04, m.size[0] * m.size[2])));
      const score = Math.abs(Math.log(aspect / a));
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
  }
  return best;
}

/** 一栋楼 → 实例矩阵的缩放（纯算术；`stretch` 上限把横向拉伸夹住） */
export function assetScaleOf(
  asset: BldAssetMeta,
  h: number,
  w: number,
  d: number
): { sx: number; sy: number; sz: number } {
  const ah = Math.max(1e-3, asset.size[1]);
  const aw = Math.max(1e-3, asset.size[0]);
  const ad = Math.max(1e-3, asset.size[2]);
  const sy = Math.max(0.01, h) / ah;
  const sx = Math.min(Math.max(0.01, w) / aw, sy * ASSET_MAX_STRETCH);
  const sz = Math.min(Math.max(0.01, d) / ad, sy * ASSET_MAX_STRETCH);
  return { sx, sy, sz };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、纹理（调用方给 THREE；这份 three 是裁剪构建，只认 TextureLoader）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 取共享 colormap（512×512，11 KB）。glTF 的 UV 原点在左上 ⇒ `flipY = false`。 */
export function loadBldAssetTexture(
  THREE: Record<string, any>,
  url: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const L = THREE?.TextureLoader;
      if (!L) {
        reject(new Error("这个 three 构建没有 TextureLoader"));
        return;
      }
      const loader = new L();
      loader.load(
        url,
        (t: any) => {
          try {
            t.flipY = false;
            t.generateMipmaps = true;
            t.minFilter = THREE.LinearMipmapLinearFilter ?? t.minFilter;
            t.magFilter = THREE.LinearFilter ?? t.magFilter;
            /* 贴图是 sRGB 的调色板；不标 colorSpace 会整体偏亮（与顶点色那条 gamma 坑同源） */
            if (THREE.SRGBColorSpace !== undefined && "colorSpace" in t) t.colorSpace = THREE.SRGBColorSpace;
            t.needsUpdate = true;
          } catch {
            /* 属性设不上不影响"有图可贴" */
          }
          resolve(t);
        },
        undefined,
        (e: unknown) => reject(e instanceof Error ? e : new Error("纹理加载失败"))
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error("纹理加载失败"));
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、资产层（InstancedMesh；同资产多栋一个 draw）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 投影筛选：给出"这栋楼会不会出现在屏幕上"（局部米 → 像素由调用方算；这里只问 yes/no） */
export type BldAssetAccept = (x: number, z: number) => boolean;

export interface BldAssetLayer {
  group: any;
  /**
   * 每帧/每次视野变化：只把**视野内**的楼放进实例（超预算就如实报 `overBudget`）。
   * `accept` 由调用方用**上一帧相机矩阵**做投影筛（比"按距离猜"准：既不漏屏幕最上沿的楼、
   * 也不为屏幕外那批白付三角）；不传就退回按距离。
   * 半径 `radius * 1.2` 以内的楼**无论如何都进**（兜底：投影算不出来时也不留空洞）。
   */
  update(cx: number, cz: number, radius: number, accept?: BldAssetAccept | null, force?: boolean): void;
  /** 交叉淡入淡出的透明度与遮挡顺序：`toAssets` = 目标档是资产 */
  applyFade(fade: number, toAssets: boolean): void;
  /** 本帧实际画出的实例数 / 三角数 / 用到的 draw 数 */
  count(): number;
  tris(): number;
  draws(): number;
  /** 视野内的楼超过实例预算（调用方应放弃进资产档，否则会有空洞） */
  overBudget(): boolean;
  /** 视野内可进资产层的楼数（不超预算时 = `count()` 的期望值） */
  visible(): number;
  /** 提亮补丁是否真的挂上了（0 = 锚点没对上，走的是单乘兜底） */
  lifted(): number;
  dispose(): void;
}

export interface BldAssetLayerOpts {
  ids: readonly string[];
  cap?: number;
  viewMargin?: number;
}

/**
 * 从资产包 + 楼记录建一层资产。**几何只建一次**（每种资产一份，实例共享）；
 * 每栋楼挑一次资产（按 id/高/宽/深，可复算），之后每帧只更新实例矩阵。
 */
export function buildBldAssetLayer(
  THREE: Record<string, any>,
  pack: BldAssetPack,
  texture: any,
  places: Float32Array,
  opts: BldAssetLayerOpts
): BldAssetLayer {
  const n = Math.floor(places.length / PLACE_STRIDE);
  const ids = opts.ids;
  const cap = Math.max(1, Math.min(opts.cap ?? ASSET_CAP, n || 1));
  const margin = opts.viewMargin ?? ASSET_VIEW_MARGIN;
  const meta = pack.meta;

  /* ── ① 几何：每种资产一份（位置/uv/明暗/索引都从同一个 ArrayBuffer 里切视图，不复制） ── */
  const geoms: any[] = [];
  for (const m of meta) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(pack.bin, m.pos, m.verts * 3);
    const uv = new Uint16Array(pack.bin, m.uv, m.verts * 2);
    const shade = new Uint8Array(pack.bin, m.shade, m.verts);
    /* `color` 要 3 个分量：把 1 字节明暗摊成 r=g=b（只在内存里，磁盘上仍是 1 字节/顶点） */
    const col = new Uint8Array(m.verts * 3);
    for (let i = 0; i < m.verts; i++) {
      const v = shade[i]!;
      col[i * 3] = v;
      col[i * 3 + 1] = v;
      col[i * 3 + 2] = v;
    }
    const idx = new Uint16Array(pack.bin, m.idx, m.idxCount);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2, true));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    geoms.push(g);
  }

  /* ── ② 材质：一个共享（同贴图、同明暗口径） ── */
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
  material.name = "ws-bld-asset";
  /* 贴图是 Kenney 的**反照率调色板**（未受光；灰蓝墙那一档约 rgb(90,96,120)）。
     这条路的材质是**不受光**的 `MeshBasicMaterial`（与程序化那条路同一种做法），
     直接画会比主题色阶暗一档 —— 所以补一次**提亮**。
     用"乘 + 加"而不是单乘：单乘（`material.color` = 1.8）会把浅色墙直接顶到 1 而**失去明暗**
     （屋顶/墙面糊成一片白）；加一个底噪能把暗墙抬起来、又留住面与面的差。
     锚点缺失（换了 three 版本）⇒ 退回单乘 1.35，并在 `liftApplied` 里如实记一笔。 */
  material.color.setRGB(1.35, 1.35, 1.35);
  let liftApplied = 0;
  material.onBeforeCompile = (sh: { fragmentShader: string }) => {
    try {
      const anchor = "#include <map_fragment>";
      if (!sh.fragmentShader.includes(anchor)) return;
      sh.fragmentShader = sh.fragmentShader.replace(
        anchor,
        anchor + "\n  diffuseColor.rgb = diffuseColor.rgb * 1.02 + 0.16;"
      );
      material.color.setRGB(1, 1, 1);
      liftApplied = 1;
    } catch {
      /* 补丁失败：保持 1.35 的单乘（暗一点，但不会白屏） */
    }
  };

  /* ── ③ 每种资产一个 InstancedMesh（容量 = min(楼数, 预算)） ── */
  const group = new THREE.Group();
  group.name = "ws-bld-assets";
  group.visible = false;
  group.renderOrder = 0;
  const meshes: any[] = [];
  for (let i = 0; i < meta.length; i++) {
    const im = new THREE.InstancedMesh(geoms[i], material, Math.max(1, cap));
    im.name = "ws-bld-asset:" + meta[i]!.name;
    /* 实例会随视野变；包围球别拿来剔（我们自己按视野距离挑），否则拖一下就整批消失 */
    im.frustumCulled = false;
    im.renderOrder = 0;
    im.count = 0;
    im.visible = false;
    meshes.push(im);
    group.add(im);
  }

  /* 每栋楼挑一次资产（不受视野影响 ⇒ 同一栋楼走到哪都是同一个模型） */
  const assign = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * PLACE_STRIDE;
    const h = places[p + 7]!;
    const w = places[p + 4]!;
    const d = places[p + 5]!;
    if (!(h >= 0.8) || !(w >= 0.4) || !(d >= 0.4)) {
      assign[i] = -1;
      continue;
    }
    assign[i] = pickAssetIndex(meta, String(ids[i] ?? ""), h, w, d);
  }

  let count = 0;
  let tris = 0;
  let over = false;
  let visCount = 0;
  let lastCx = NaN;
  let lastCz = NaN;
  let lastR = NaN;
  const buckets: number[][] = meta.map(() => []);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let fade = 0;

  function update(cx: number, cz: number, radius: number, accept?: BldAssetAccept | null, force = false): void {
    const r = Number.isFinite(radius) && radius > 0 ? radius : 120;
    /* 视野没怎么动就不重算（拖动 40 m 以内实例矩阵不变） */
    if (!force && Number.isFinite(lastCx) && Math.hypot(cx - lastCx, cz - lastCz) < 40 && Math.abs(r - lastR) < r * 0.25) return;
    lastCx = cx;
    lastCz = cz;
    lastR = r;
    const maxD = Math.max(ASSET_VIEW_MIN_M, r * margin);
    const inner = Math.max(60, r * 1.2);
    const inner2 = inner * inner;
    for (const b of buckets) b.length = 0;
    let used = 0;
    let seen = 0;
    over = false;
    for (let i = 0; i < n; i++) {
      const p = i * PLACE_STRIDE;
      const x = places[p]!;
      const z = places[p + 1]!;
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      /* 近处（1.2 倍视野半径内）**必进**；再远就看投影筛（on-screen 才进） */
      if (d2 > inner2) {
        if (!accept) {
          if (d2 > maxD * maxD) continue;
        } else if (!accept(x, z)) {
          continue;
        }
      }
      if (assign[i]! < 0) continue;
      seen += 1;
      if (used >= cap) {
        over = true;
        continue;
      }
      buckets[assign[i]!]!.push(i);
      used += 1;
    }
    visCount = seen;
    let live = 0;
    let liveTris = 0;
    for (let ai = 0; ai < meta.length; ai++) {
      const list = buckets[ai]!;
      const im = meshes[ai]!;
      for (let k = 0; k < list.length; k++) {
        const p = list[k]! * PLACE_STRIDE;
        const h = places[p + 7]!;
        const w = places[p + 4]!;
        const d = places[p + 5]!;
        const sc = assetScaleOf(meta[ai]!, h, w, d);
        v3.set(places[p]!, places[p + 2]!, places[p + 1]!);
        q.setFromAxisAngle(UP, places[p + 6]!);
        s3.set(sc.sx, sc.sy, sc.sz);
        m4.compose(v3, q, s3);
        im.setMatrixAt(k, m4);
      }
      im.count = list.length;
      im.visible = list.length > 0;
      if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true;
      if (list.length) {
        live += list.length;
        liveTris += list.length * meta[ai]!.tris;
      }
    }
    count = live;
    tris = liveTris;
  }

  function applyFade(f: number, toAssets: boolean): void {
    fade = clamp01(f);
    /* 只关整组（子网格的 `visible` 归 `update()` 管：那里按"这栋在不在视野"设，
       这里再去改它会把"视野内有实例的网格"永久关掉 —— 实例矩阵是节流更新的）。 */
    group.visible = fade > 0;
    /* 目标=资产：资产是**进入方** ⇒ 不透明、写深度、先画；
       目标=程序化：资产是**退出方** ⇒ 半透明、不测深度、后画（压在进入方之上，不会露出底图）。
       —— 这样两套几何同位置时，任一帧的合成都是"前者 × (1-fade) + 后者 × fade"，没有空洞也没有重影。 */
    if (toAssets) {
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
    } else {
      material.transparent = true;
      material.opacity = fade;
      material.depthTest = false;
      material.depthWrite = false;
    }
    group.renderOrder = toAssets ? 0 : 2;
    for (const im of meshes) im.renderOrder = group.renderOrder;
  }

  return {
    group,
    update,
    applyFade,
    count: () => count,
    tris: () => tris,
    draws: () => meshes.reduce((k, im) => k + (im.visible && im.count > 0 ? 1 : 0), 0),
    overBudget: () => over,
    visible: () => visCount,
    lifted: () => liftApplied,
    dispose(): void {
      try {
        for (const g of geoms) g.dispose?.();
        for (const im of meshes) {
          im.dispose?.();
          if (im.parent) im.parent.remove(im);
        }
        material.dispose?.();
        if (group.parent) group.parent.remove(group);
      } catch {
        /* 释放失败不影响页面 */
      }
    },
  };
}
