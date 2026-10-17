/* wsBldFacade.ts —— **程序化立面图集**的纯函数层（不碰 three / 不碰 DOM）。
 *
 * 设计意图（用户 2026-10-17「楼重复度太高，能搞到贴图吗」）：
 *   楼现在是纯色块、每栋一样。用一张 canvas 生成的**立面图集** + 逐顶点 UV
 *   ⇒ 每栋按 id 选一格、再按 id 抖一点色相：**一个材质、一张纹理、draw call 仍是 1**。
 *
 * 分工（本文件只做**可离线测**的部分）：
 *   · 常量：图集格数/尺寸/留缝/抖动幅度/层高基准
 *   · 纯函数：id 哈希 → 图集格 / 色调抖动 / 竖向与横向重复次数 / 图集 UV 矩形
 *   · 画图集：`drawFacadeAtlas(ctx)` 只调 2D 上下文的 `fillRect`/`fillStyle`（Node 里用假 ctx 可测）
 *   纹理包装（`CanvasTexture`）、材质补丁（`onBeforeCompile`）留在渲染侧，不进本文件。
 *
 * 判据（见 `world_map/ws_bld_facade_selftest.mjs`）：
 *   ① 格子多样性：100 个 id ⇒ 不同格 ≥ 6、最大单格 ≤ 30%
 *   ② 窗格不拉伸：`vRep` 用 `lv`（拿不到才 `round(h/3)`），横竖比 1 ± 10%
 *   ③ 抖动有效：相邻 id 的 tint 差 ΔE ≥ 1（否则抖动是假的）
 *   ④ 变异（所有楼同一格）⇒ ① 红
 */

/** 图集：**4 列 × 2 行 = 8 格**（扩到 16 格只改这两个常量与 `FACADE_CELLS`） */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
/** 每格像素（含留缝前的净尺寸） */
export const ATLAS_CELL_PX = 128;
/** 格间留缝（防 mip 渗色；`drawFacadeAtlas` 会把它算进步长） */
export const ATLAS_GUTTER_PX = 2;
/** 可用立面格数（0..5）；6 = 屋面、7 = 素墙 —— 屋面/素墙**不参与随机** */
export const FACADE_CELLS = 6;
/** 屋面格 / 素墙格的编号（`ATLAS_COLS/ROWS` 变了也要保持一致：按行列算） */
export const ROOF_CELL_INDEX = 6;
export const PLAIN_CELL_INDEX = 7;
/** 色调抖动幅度（±5%） */
export const TINT_JITTER = 0.05;
/** 层高基准（米）；`lv` 优先，拿不到才用它推重复次数 */
export const FLOOR_M = 3;

/** 2D 上下文的最小形状（Node 里用假 ctx 就能测画图集，不需要真 canvas） */
export interface FacadeCtx2D {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  /** 可选：画窗格高光/暗部时用；没有就只画矩形 */
  globalAlpha?: number;
}

/** 一栋楼在"立面图集"上的取样信息 */
export interface FacadeSample {
  /** 图集格编号（0..FACADE_CELLS-1；屋面/素墙由调用方固定） */
  cell: number;
  /** 色调抖动系数（三通道相同，1 ± TINT_JITTER） */
  tint: number;
  /** 横向重复次数（≥1）：`max(1, round(边长/FLOOR_M))` */
  uRep: number;
  /** 竖向重复次数（≥1）：`max(1, lv ?? round(楼高/FLOOR_M))` */
  vRep: number;
}

/** FNV-1a 32 位哈希（稳定、无依赖；同一 id 永远同一格） */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** id → 立面格编号（0..FACADE_CELLS-1；**不返回屋面/素墙**） */
export function cellOf(id: string): number {
  return hashId(`cell:${id}`) % FACADE_CELLS;
}

/** 抖动级数（量化成 21 级：相邻级差 = 2×TINT_JITTER/20 ≈ 0.005 ⇒ 255 口径 1.27 ≥ 1） */
export const TINT_LEVELS = 21;

/**
 * id → 色调抖动系数（1 ± TINT_JITTER，**量化**）。
 * 量化是为了让"相邻两栋颜色差 ≥ 1/255"这条判据**可保证**（纯随机会出现几乎同色的邻居）；
 * 同级碰撞的概率 = 1/21 ≈ 4.8%，由"格子不同"兜底。
 */
export function tintOf(id: string): number {
  const lv = hashId(`tint:${id}`) % TINT_LEVELS;
  const k = lv / (TINT_LEVELS - 1);                    /* 0..1 */
  return 1 + (k * 2 - 1) * TINT_JITTER;
}

/** 竖向/横向重复次数（窗格不能拉伸：横向按边长、竖向按层数） */
export function repeatOf(edgeM: number, heightM: number, lv?: unknown): { uRep: number; vRep: number } {
  const w = Number(edgeM);
  const h = Number(heightM);
  const floors = Number(lv);
  const W = Number.isFinite(w) && w > 0 ? w : FLOOR_M;
  const H = Number.isFinite(h) && h > 0 ? h : FLOOR_M;
  /* 横向：按边长每 `FLOOR_M` 一格；竖向：**`lv` 优先**（瓦片里有真实层数），
     拿不到才退回 `round(楼高/FLOOR_M)`（层高基准 3m）。
     同一栋的窗格因此**不随楼高拉伸**（vRep 与 h 同比例变），小楼的 ±10% 边界见闸里那条。 */
  const uRep = Math.max(1, Math.round(W / FLOOR_M) || 1);
  const vRep = Math.max(
    1,
    Number.isFinite(floors) && (floors as number) > 0 ? Math.round(floors as number) : Math.round(H / FLOOR_M) || 1
  );
  return { uRep, vRep };
}

/** 一栋楼的完整取样（网格生成时**每栋算一次**，逐顶点复用） */
export function facadeSampleOf(id: string, edgeM: number, heightM: number, lv?: unknown): FacadeSample {
  const { uRep, vRep } = repeatOf(edgeM, heightM, lv);
  return { cell: cellOf(id), tint: tintOf(id), uRep, vRep };
}

/**
 * 图集 UV 矩形（左上角原点，v 向上还是向下由调用方决定 —— three 的纹理默认 v 向上，
 * 这里给的是"像素/图集尺寸"口径，调用方按需翻转）。
 */
export function atlasUvOf(cell: number, insetPx = 0.5): { u0: number; v0: number; u1: number; v1: number } {
  const idx = Math.max(0, Math.min(ATLAS_COLS * ATLAS_ROWS - 1, Math.floor(cell)));
  const col = idx % ATLAS_COLS;
  const row = Math.floor(idx / ATLAS_COLS);
  const step = ATLAS_CELL_PX + ATLAS_GUTTER_PX;
  const W = ATLAS_COLS * step - ATLAS_GUTTER_PX;
  const H = ATLAS_ROWS * step - ATLAS_GUTTER_PX;
  const x0 = col * step + insetPx;
  const y0 = row * step + insetPx;
  const x1 = col * step + ATLAS_CELL_PX - insetPx;
  const y1 = row * step + ATLAS_CELL_PX - insetPx;
  return { u0: x0 / W, v0: y0 / H, u1: x1 / W, v1: y1 / H };
}

/** 图集画布尺寸（像素） */
export function atlasSizePx(): { w: number; h: number } {
  const step = ATLAS_CELL_PX + ATLAS_GUTTER_PX;
  return { w: ATLAS_COLS * step - ATLAS_GUTTER_PX, h: ATLAS_ROWS * step - ATLAS_GUTTER_PX };
}

/** 每格的基色（住宅暖灰/米色、办公冷灰/蓝灰、商业浅褐/灰白）与窗色 */
const CELL_STYLE: Array<{ wall: string; band: string; win: string; lit: string }> = [
  { wall: "#cfc6bb", band: "#b3a99c", win: "#5d6b78", lit: "#ffe9b8" },   /* 0 住宅暖灰 */
  { wall: "#d8cdbd", band: "#bfae98", win: "#61707c", lit: "#fff0c8" },   /* 1 住宅米色 */
  { wall: "#c3cbd2", band: "#a7b2bb", win: "#4f6270", lit: "#e8f2ff" },   /* 2 办公冷灰 */
  { wall: "#b9c2cc", band: "#9aa6b3", win: "#465866", lit: "#e2eeff" },   /* 3 办公蓝灰 */
  { wall: "#d2c2ab", band: "#b8a68c", win: "#6a6152", lit: "#ffe7bd" },   /* 4 商业浅褐 */
  { wall: "#dcd8d1", band: "#c2bcb2", win: "#5f6a70", lit: "#f6f6f2" },   /* 5 商业灰白 */
];

/**
 * 画 8 格图集（只依赖 `fillRect`）：0–5 立面、6 屋面、7 素墙。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`（canvas 不可用/绘制抛错时由调用方记 `facadePatchFailed`）
 */
export function drawFacadeAtlas(ctx: FacadeCtx2D, rnd: () => number = mulberry32(0x5eed)): { ok: boolean; reason?: string } {
  try {
    const step = ATLAS_CELL_PX + ATLAS_GUTTER_PX;
    for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
      const col = cell % ATLAS_COLS;
      const row = Math.floor(cell / ATLAS_COLS);
      const x0 = col * step;
      const y0 = row * step;
      if (cell < FACADE_CELLS) {
        const st = CELL_STYLE[cell]!;
        ctx.fillStyle = st.wall;
        ctx.fillRect(x0, y0, ATLAS_CELL_PX, ATLAS_CELL_PX);
        /* 楼层带（顶部 1/8） */
        ctx.fillStyle = st.band;
        ctx.fillRect(x0, y0, ATLAS_CELL_PX, ATLAS_CELL_PX / 8);
        /* **一格一窗**（重复由 UV 做）：窗居中方块 + 窗台，亮/暗随机。
           一格一窗是"单窗宽高比"这条判据能成立的前提（多窗会把口径算错）。 */
        const pad = Math.round(ATLAS_CELL_PX * 0.22);
        const wWin = ATLAS_CELL_PX - pad * 2;
        const hWin = Math.round(ATLAS_CELL_PX * 0.52);
        const wy = y0 + Math.round(ATLAS_CELL_PX * 0.3);
        ctx.fillStyle = st.band;
        ctx.fillRect(x0 + pad, wy + hWin, wWin, Math.max(2, Math.round(ATLAS_CELL_PX * 0.05)));
        ctx.fillStyle = rnd() < 0.35 ? st.lit : st.win;
        ctx.fillRect(x0 + pad, wy, wWin, hWin);
      } else if (cell === ROOF_CELL_INDEX) {
        /* 屋面：深灰 + 细缝 */
        ctx.fillStyle = "#4a4f55";
        ctx.fillRect(x0, y0, ATLAS_CELL_PX, ATLAS_CELL_PX);
        ctx.fillStyle = "#3f4449";
        for (let i = 1; i < 4; i++) ctx.fillRect(x0, y0 + (i * ATLAS_CELL_PX) / 4 - 1, ATLAS_CELL_PX, 2);
      } else {
        /* 素墙 */
        ctx.fillStyle = "#c8c8c4";
        ctx.fillRect(x0, y0, ATLAS_CELL_PX, ATLAS_CELL_PX);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e).slice(0, 80) };
  }
}

/** 确定性随机（图集内容每次一致，便于对拍） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
