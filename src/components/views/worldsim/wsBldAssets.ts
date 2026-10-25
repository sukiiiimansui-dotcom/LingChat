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
 *
 * ## 两代包（v1 贴图调色板 / v2 顶点色）
 * v1 = Kenney 那批（105 个程序化派生变体）：每顶点 uv(u16) + shade(u8)，共享一张
 *   colormap.png，材质 `MeshBasicMaterial({ map, vertexColors })`。
 * v2 = Godot 导出的建筑模型（6 类 × 3 变体）：每个 primitive 的 baseColorFactor 烘成
 *   逐顶点 sRGB u8×3，不存 uv / 贴图 / 法线，材质 `MeshBasicMaterial({ vertexColors })`。
 *   构建脚本 `scripts/build-bld-assets-godot.mjs`，产物在 `public/ws3d/bldassets_godot/`。
 *
 * 版本由 URL 选：`?bldassets=2` 或 `?godotbld=1` 走 v2，**默认仍是 v1**（线上验收口径不变，
 * 也方便同一机位对比两代资产）。v2 的顶点色在磁盘上是 sRGB 编码，进 GPU 前解码回线性
 * 工作空间（渲染器会把输出再编码成 sRGB，不解码会整体偏亮一档）。
 */

import { hashId } from "./wsBldFacade";
import { PLACE_STRIDE } from "./wsBldMesh";

/** 资产包目录（运行时从 public 取，与 `vendor/three.min.js` 同一套静态路径口径） */
export const BLD_ASSET_BASE = "/ws3d/bldassets/";
/** v2 资产包目录（Godot 建筑模型：顶点色、无贴图） */
export const BLD_ASSET_BASE_V2 = "/ws3d/bldassets_godot/";

export type BldAssetPackVersion = 1 | 2;

/**
 * 当前用哪一代资产包：`?bldassets=2` 或 `?godotbld=1` → v2；其余（含 `?bldassets=1`）→ v1。
 * 参数可注入（便于单测），默认读 `location.search`；没有 location 时按 v1。
 */
export function bldAssetVersion(search?: string): BldAssetPackVersion {
  let q = search;
  if (q == null) {
    try {
      q = typeof location !== "undefined" ? location.search : "";
    } catch {
      q = "";
    }
  }
  return /[?&](?:bldassets=2|godotbld=1)\b/.test(q) ? 2 : 1;
}

/** 版本 → 包目录 */
export function bldAssetBase(version: BldAssetPackVersion = bldAssetVersion()): string {
  return version === 2 ? BLD_ASSET_BASE_V2 : BLD_ASSET_BASE;
}

/* ── 双档阈值（米/CSS 像素） ─────────────────────────────────────────────────
 * `mpp` 是"一米在屏幕上占几个 CSS 像素"的倒数（与 `wsBldLod` 同一把尺子）。
 * 进入 = 更近（mpp 小），退出 = 更远（mpp 大），**中间那段谁都不翻档** ⇒ 不会来回抖。
 * 换算（纬度 29.56、512px 瓦片口径）：`mppAtZoom` 给出
 *   zoom 16.4 → 0.787（**默认机位**）、0.9 → zoom 16.2、1.15 → zoom 15.85。
 * 原来的 0.42 / 0.54 是 zoom 17.3 / 16.95 —— 比默认机位近了一级多 ⇒ 打开页面永远停在
 * 程序化盒子那一档。现在把门槛放到"**默认机位就在资产档**"（0.9 > 0.787），
 * 退出再往外放一档（1.15）：默认视角附近来回微调不会翻档，拉远到街区级才回程序化。 */
/* 2026-10-25 真机实测：同一机位 **mpp 与设备强相关**（桌面 dpr1 是 0.787，手机 dpr3 是 1.57~1.69）
   —— 因为相机半径按屏幕像素算。旧门槛 0.9/1.15 在手机上几乎永远进不去，而且滑动后掉出去就回不来。
   现在按真机读数抬到 1.9/2.4：默认视角能进资产档，广角（更远）仍退回程序化；实例预算 420 兜底。 */
export const ASSET_ENTER_MPP = 1.9;
export const ASSET_EXIT_MPP = 2.4;
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
  /**
   * 建筑类别。v1 是挑池的分类（`low` / `mid` / `tall`），v2 是模型类别
   * （`conv` / `cafe` / `rest` / `pharm` / `bank` / `house`）。
   */
  class: string;
  /** v2 才有的**挑池**分类（`low` / `mid` / `tall`）；缺省时退回 `class`（v1 的老口径） */
  pool?: string;
  verts: number;
  tris: number;
  /** pack.bin 内的字节偏移（段首 4 字节对齐） */
  pos: number;
  /** 顶点色的段偏移（仅 v2：u8×3 sRGB） */
  color?: number;
  /** v1：uv 段偏移（u16×2 归一化） */
  uv?: number;
  /** v1：明暗段偏移（u8，单分量明度） */
  shade?: number;
  idx: number;
  idxCount: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ]（已平移到占地中心、底面 y=0） */
  bbox: number[];
  /** [宽, 高, 深]（资产单位） */
  size: number[];
  tex?: string | null;
}

/** pack.json 的段布局（v2 明确写出；v1 也有一份） */
export interface BldAssetLayout {
  pos: string;
  color?: string;
  uv?: string;
  shade?: string;
  idx: string;
}

export interface BldAssetPack {
  /** 包代次：1 = 贴图调色板（Kenney），2 = 顶点色（Godot）。按 `layout.color` 也能认出来 */
  v: BldAssetPackVersion;
  layout?: BldAssetLayout;
  meta: BldAssetMeta[];
  /** 所有资产拼成的一个 ArrayBuffer（v1：pos f32 / uv u16 / shade u8 / idx u16；
   *  v2：pos f32 / color u8×3 / idx u32） */
  bin: ArrayBuffer;
  /** v2 没有贴图（`null`）；v1 是共享 colormap 的文件名 */
  texture: string | null;
  counts: { assets: number; verts: number; tris: number };
  binBytes: number;
}

/** `ArrayBuffer` + JSON 清单（构建期产物；v1 见 `scripts/build-bld-assets.mjs`，
 *  v2 见 `scripts/build-bld-assets-godot.mjs`） */
export async function loadBldAssetPack(
  base: string = bldAssetBase(),
  fetchImpl: typeof fetch | null = (typeof fetch !== "undefined" ? fetch : null)
): Promise<BldAssetPack> {
  if (!fetchImpl) throw new Error("没有 fetch：取不了资产包");
  const jr = await fetchImpl(base + "pack.json", { cache: "no-store" } as RequestInit);
  if (!jr.ok) throw new Error("pack.json HTTP " + jr.status);
  const json = (await jr.json()) as Partial<BldAssetPack> & {
    assets?: BldAssetMeta[];
    v?: number;
    layout?: BldAssetLayout;
  };
  if (!Array.isArray(json.assets) || !json.assets.length) throw new Error("pack.json 里没有 assets");
  const br = await fetchImpl(base + (json.bin || "pack.bin"), { cache: "no-store" } as RequestInit);
  if (!br.ok) throw new Error("pack.bin HTTP " + br.status);
  const bin = await br.arrayBuffer();
  const need = Number(json.binBytes || 0);
  if (need > 0 && bin.byteLength < need) throw new Error("pack.bin 长度不对（" + bin.byteLength + " < " + need + "）");
  /* v2 的判据是清单里写了顶点色段（`v` 只是冗余标记；两者任一命中即按 v2 读） */
  const isV2 = Number(json.v) >= 2 || !!(json.layout && json.layout.color);
  return {
    v: isV2 ? 2 : 1,
    layout: json.layout,
    meta: json.assets,
    bin,
    texture: isV2 ? null : json.texture || "colormap.png",
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
 * 候选带宽度（评分单位）：`best` 到这个距离以内的资产都算"一样像"，
 * 再由楼 id 的哈希在**候选集里**挑一个。
 *
 * 为什么要这一层（2026-10-25 实测 `?blddiag=1`）：原来直接取 argmin，评分里
 * "高宽比接近"那项（权重最大）会把选择压到**最像的那一两个资产**上 —— 屏上
 * 80 栋只用到 **10 个**不同模型，加多少变体都没用。改成"先取像的一档、再按 id 散开"后，
 * 同一栋楼依然永远挑同一个资产（哈希只依赖 id），只是把"像它"的那一档均匀用满。
 * 0.34 ≈ 高宽比相差 40% 以内都算一档（非均匀缩放本来就把横向形变夹在
 * `ASSET_MAX_STRETCH` 里，这一档之内不会出现"纸片楼"）。
 */
export const ASSET_PICK_SPREAD = 0.34;

/**
 * 给一栋楼挑资产：**先按高度分池**（高楼用摩天楼），再按"楼体高宽比 vs 资产高宽比"打分，
 * 最后在**最像的那一档候选**里按 id 哈希定一个 —— 同一栋楼永远挑同一个资产（可复算），
 * 不同的楼会散开。
 *
 * 为什么要对高宽比：资产是按楼的包围盒**非均匀缩放**上去的；高宽比差太远，
 * 窗户会被拉成横条/竖条（比"重复"更难看）。所以候选只取"像它"的那一档。
 */
export function pickAssetIndex(meta: readonly BldAssetMeta[], id: string, h: number, w: number, d: number): number {
  if (!meta.length) return -1;
  const foot = Math.max(0.5, Math.sqrt(Math.max(0.25, w * d)));
  const aspect = Math.max(0.05, h) / foot;
  /* 三档池子（2026-10-25 扩池）：矮楼用 low-detail、中楼用商业、高楼用摩天楼。
     池子空了会退回全池（见下面的兜底），所以不会因为缺某档而没模型。 */
  const cls = h >= 45 ? "tall" : h < 14 ? "low" : "mid";
  /* ① 先把本档所有资产的形状分算出来（一次遍历，105 个资产也就一万次乘加） */
  const scores: number[] = [];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i]!;
    /* v1 的 `class` 本身就是池名；v2 的 `class` 是商店类别，池名另写在 `pool` */
    if ((m.pool || m.class) !== cls) { scores.push(Infinity); continue; }
    const a = Math.max(0.05, m.size[1]) / Math.max(0.05, Math.sqrt(Math.max(0.04, m.size[0] * m.size[2])));
    /* 占地长宽比也要像（2026-10-25）：只按"高/底面积"挑，会给长条楼配方盒子，
       再被非均匀缩放压成"纸片楼"。这里用 max(r,1/r) 比较，避免方向偏差。 */
    const fr = Math.max(0.05, w) / Math.max(0.05, d);
    const ar = Math.max(0.05, m.size[0]) / Math.max(0.05, m.size[2]);
    const footScore = Math.abs(Math.log(Math.max(fr, 1 / fr) / Math.max(ar, 1 / ar)));
    const score = Math.abs(Math.log(aspect / a)) + 0.45 * footScore;
    scores.push(score);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  /* 池子空了 ⇒ 退回全池。v1 三档都有人，走不到这里；v2 只有低层商店/住宅，
     中楼/高楼一定走这条。所以这里也要"取像的一档 + 按 id 散开"，
     否则整屏中楼会全落到同一个最像的模型上（v1 当初就是这个毛病）。 */
  if (best < 0) {
    const allScores: number[] = [];
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i]!;
      const a = Math.max(0.05, m.size[1]) / Math.max(0.05, Math.sqrt(Math.max(0.04, m.size[0] * m.size[2])));
      const score = Math.abs(Math.log(aspect / a));
      allScores.push(score);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    let nAll = 0;
    for (const s of allScores) if (s <= bestScore + ASSET_PICK_SPREAD) nAll += 1;
    if (nAll <= 1) return best;
    let kAll = hashId("pick|" + id) % nAll;
    for (let i = 0; i < allScores.length; i++) {
      if (allScores[i]! > bestScore + ASSET_PICK_SPREAD) continue;
      if (kAll === 0) return i;
      kAll -= 1;
    }
    return best;
  }
  /* ② 把"一样像"的那一档收成候选集；③ 由 id 哈希定一个（同 id 恒等，跨会话一致） */
  let n = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i]! <= bestScore + ASSET_PICK_SPREAD) n += 1;
  if (n <= 1) return best;
  let k = hashId("pick|" + id) % n;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! > bestScore + ASSET_PICK_SPREAD) continue;
    if (k === 0) return i;
    k -= 1;
  }
  return best;
}

/** 一栋楼 → 实例矩阵的缩放（纯算术；`stretch` 上限把横向拉伸夹住） */
/**
 * v2（Godot 单层/低层建筑）的等比缩放：**保持模型自身比例**，只按占地适配，
 * 并把比例夹在 0.45~1.8 —— 否则一栋 60m 的楼会把 4.8m 高的便利店纵向拉成 12 倍（2026-10-25 实测）。
 */
export function assetScaleUniform(
  asset: BldAssetMeta,
  w: number,
  d: number
): { sx: number; sy: number; sz: number } {
  const aw = Math.max(1e-3, asset.size[0]);
  const ad = Math.max(1e-3, asset.size[2]);
  const fit = Math.min(Math.max(0.01, w) / aw, Math.max(0.01, d) / ad);
  const s = Math.min(Math.max(fit, 0.45), 1.8);
  return { sx: s, sy: s, sz: s };
}

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
  /* 每个轴单独按目标占地缩放会让"长条楼"变成纸片（2026-10-25 实测"有的非常细"）。
     以 `sy` 为基准给横向形变设上下限：允许拉宽/压窄，但不许细成针。 */
  const lo = sy * 0.45;
  const hi = sy * ASSET_MAX_STRETCH;
  const clampX = (v: number): number => Math.min(Math.max(v, lo), Math.max(hi, lo));
  const sx = clampX(Math.max(0.01, w) / aw);
  const sz = clampX(Math.max(0.01, d) / ad);
  return { sx, sy, sz };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、纹理与顶点色（调用方给 THREE；这份 three 是裁剪构建，只认 TextureLoader）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * sRGB 字节 → 线性字节（255 项查表，u8 精度足够：颜色本身已经是 8 位量化过的）。
 *
 * 为什么需要：v2 包的顶点色按构建口径存的是 **sRGB**（与人眼看图一致），而 three 的
 * 顶点色直接进线性工作空间；渲染器最后会把线性再编码成 sRGB 输出。不在进 GPU 前解码，
 * 就等于把 sRGB 值当线性用 ⇒ 整体亮一档、深色（玻璃/招牌）发灰。
 */
const SRGB8_TO_LINEAR8: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    t[i] = Math.round(lin * 255);
  }
  return t;
})();

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
  /* v2 判据与 `loadBldAssetPack` 同口径：清单写了 `layout.color` 就是顶点色包。
     v2 的每个 primitive 已经把材质基色烘成顶点色，所以**没有 uv / 贴图**可用。 */
  const isV2 = pack.v === 2 || !!(pack.layout && pack.layout.color);
  const geoms: any[] = [];
  for (const m of meta) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(pack.bin, m.pos, m.verts * 3);
    if (isV2) {
      if (m.color == null) throw new Error("v2 资产缺 color 段偏移：" + m.name);
      /* 磁盘上是 sRGB 编码的 u8×3；three 的顶点色按**线性**工作空间参与着色，
         这里先解码（查表），渲染器最后统一编码回 sRGB 输出。 */
      const src = new Uint8Array(pack.bin, m.color, m.verts * 3);
      const col = new Uint8Array(m.verts * 3);
      for (let i = 0; i < col.length; i++) col[i] = SRGB8_TO_LINEAR8[src[i]!]!;
      const vidx = new Uint32Array(pack.bin, m.idx, m.idxCount);
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
      g.setIndex(new THREE.BufferAttribute(vidx, 1));
      g.computeBoundingSphere();
      geoms.push(g);
      continue;
    }
    const uv = new Uint16Array(pack.bin, m.uv!, m.verts * 2);
    const shade = new Uint8Array(pack.bin, m.shade!, m.verts);
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

  /* ── ② 材质：一个共享（同贴图、同明暗口径；v2 是顶点色、无贴图） ── */
  const material = new THREE.MeshBasicMaterial({
    map: isV2 ? null : texture,
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
     锚点缺失（换了 three 版本）⇒ 退回单乘 1.35，并在 `liftApplied` 里如实记一笔。
     v2 不补：顶点色就是导出时的反照率，再提亮会整体发白。 */
  let liftApplied = 0;
  if (!isV2) {
    material.color.setRGB(1.35, 1.35, 1.35);
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
  }

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
  const tintColor = new THREE.Color(1, 1, 1);
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
        /* 用顶高（places[p+3] = metaTop）而不是净高，并且**落地在 y=0**：
           以前用 `metaBase` 当 y、净高当高度，遇到 h_base>0 的楼资产就悬空（2026-10-25 实测）。 */
        const h = places[p + 3]!;
        const w = places[p + 4]!;
        const d = places[p + 5]!;
        const sc = pack.v === 2 ? assetScaleUniform(meta[ai]!, w, d) : assetScaleOf(meta[ai]!, h, w, d);
        v3.set(places[p]!, 0, places[p + 1]!);
        q.setFromAxisAngle(UP, places[p + 6]!);
        s3.set(sc.sx, sc.sy, sc.sz);
        m4.compose(v3, q, s3);
        im.setMatrixAt(k, m4);
        /* 同模型多栋要能区分（2026-10-25 "太太太重复"）：按楼 id 给每实例一点**明度/冷暖**抖动。
           InstancedMesh 的 instanceColor 会乘到 diffuse 上；老 three 没有就跳过（不影响几何）。 */
        if (typeof im.setColorAt === "function") {
          const u = unitOf(hashId("tint|" + String(ids[list[k]!] ?? "")));
          const b = 0.90 + 0.20 * u;          // 明度 0.90~1.10
          const warm = 0.03 * (u - 0.5);      // 冷/暖偏移 ±1.5%
          tintColor.setRGB(b * (1 + warm), b, b * (1 - warm));
          im.setColorAt(k, tintColor);
        }
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
       —— 这样两套几何同位置时，任一帧的合成都是"前者 × (1-fade) + 后者 × fade"，没有空洞也没有重影。
       `fade >= 1` **一律走不透明那支**（哪怕目标已经翻成 0）：目标翻过来的那一帧透明度还没降，
       不该把材质留在"不测深度"上 —— `depthTest=false` 只允许出现在过渡帧，fade=1 必须是实心。 */
    const opaque = toAssets || fade >= 1;
    if (opaque) {
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
