/* wsBldFacadeAtlas.ts —— T1 立面图集（Blender/Cycles 烤的正立面卡）。

 * ## 为什么
 * T1 档的"楼"是一个 12 三角的单位盒子 —— 换个机位看就是一片纯色饼干盒（"只有盒子"）。
 * 这里把资产包里 `bldcom` / `bldres` 各**一个变体**的正立面用 Cycles 烤成 PNG，
 * 拼进一张 2048² 图集：T1 的盒子侧面按类别取样该类的立面，顶面仍是屋面材质
 * （盒子的侧/顶是两个材质组，所以还是**每类一次 draw**）。
 *
 * ## 与 `wsBldFacade.ts` 的分工
 * 那一份是 canvas 2D 画的**程序化**图集（v1/v2 那条路在用，8 格 128px、纯色矩形）；
 * 本文件是**真模型烤出来的**图集（10 类、无 UI 依赖、只给 v3 的 T1 用）。
 *
 * ## 一张图集怎么用
 * 每类的矩形是**不等宽**的（底商 10.9 m × 4.5 m 的正立面，硬塞进 256×512 会把窗压成竖条），
 * 所以每个实例带一个 `aUvRect`（u0,v0,du,dv）属性，顶点着色器里把盒子侧面的 uv 映射到该类矩形。
 * 顶/底面走另一个材质（屋面），不参与取样。
 *
 * ## 验收口径（未验的照实写）
 * · 图集 ≤ 1.5 MB、2048²；每类立面无拉伸（矩形按真实宽高比）；
 * · 缺图集（404 / 解码失败）⇒ 调用方传 `null`，T1 退回纯色盒，不报错。
 */

/** 图集文件（相对站点根；与 `public/ws3d/bldfacades/atlas.png` 对应） */
export const FACADE_ATLAS_URL = "/ws3d/bldfacades/atlas.png";
/** 图集边长（像素） */
export const FACADE_ATLAS_PX = 2048;

/** 一类立面在图集里的归一化矩形（three 的 UV 空间：v 从下往上，已做 flipY 修正） */
export interface FacadeUvRect {
  u: number;
  v: number;
  du: number;
  dv: number;
}

/**
 * 类别 → 图集矩形。**由 `~/chk/pack_facade_atlas.py` 生成**（数字来自图集实际摆位，
 * 改图集就要重生成；`atlas.json` 是同一份数据的留档）。
 */
export const FACADE_UV_RECTS: Record<string, FacadeUvRect> = {
  apartment: { u: 0.0, v: 0.765625, du: 0.200195, dv: 0.234375 },
  cafe: { u: 0.470703, v: 0.116699, du: 0.46875, dv: 0.195801 },
  highrise: { u: 0.202148, v: 0.765625, du: 0.138184, dv: 0.234375 },
  house: { u: 0.342285, v: 0.765625, du: 0.344238, dv: 0.234375 },
  midrise: { u: 0.688477, v: 0.765625, du: 0.148438, dv: 0.234375 },
  pharm: { u: 0.470703, v: 0.316406, du: 0.46875, dv: 0.210938 },
  rest: { u: 0.0, v: 0.103516, du: 0.46875, dv: 0.208984 },
  salon: { u: 0.292969, v: 0.529785, du: 0.46875, dv: 0.233887 },
  super: { u: 0.0, v: 0.314453, du: 0.46875, dv: 0.212891 },
  townhouse: { u: 0.0, v: 0.529297, du: 0.291016, dv: 0.234375 },
};

/** 没有该类立面时的兜底（取第一类，避免整层退回纯色） */
export function facadeRectOf(key: string): FacadeUvRect | null {
  const r = FACADE_UV_RECTS[key];
  if (r) return r;
  const first = Object.keys(FACADE_UV_RECTS)[0];
  return first ? FACADE_UV_RECTS[first]! : null;
}

/** 资产名 → 图集类别键：`bld_cafe_0` → `cafe`（拿不到返回空串） */
export function facadeKeyOf(assetName: string): string {
  const m = /^bld_([a-z]+)_\d+$/.exec(String(assetName ?? ""));
  return m ? m[1]! : "";
}

/** 加载图集纹理（失败返回 null；调用方退回纯色盒，不抛） */
export function loadFacadeAtlas(
  THREE: Record<string, any>,
  url: string
): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (tex: any) => {
          try {
            if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            tex.needsUpdate = true;
          } catch {
            /* 纹理参数失败不影响使用 */
          }
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    } catch {
      resolve(null);
    }
  });
}
