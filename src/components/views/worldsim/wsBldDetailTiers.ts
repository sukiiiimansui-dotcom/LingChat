/**
 * wsBldDetailTiers.ts —— 🏢 **楼房拆件的「按 zoom 空间分档」唯一真源**（2026-10-02）。
 *
 * ## 这是什么（机主 2026-10-02 拍板的那一条）
 * 机主原话（经父代理转述，**照这个做**）：
 *   「**B1 可以按 zoom 分层**（他明确点头）：`<14` 平顶 / `14–16` 女儿墙一档 / `≥16` 设备箱+天线一档。
 *    ⚠️ 必须是**固定阈值的空间 LOD**，**绝对不许**按实测帧率自动缩（那才是他不批的"性能档位降级"）。」
 *
 * 所以本文件只做三件事，**一件都不许多**：
 *   ① 两个**固定数字**（`WS_BLD_DETAIL_ROOF_ZOOM` / `WS_BLD_DETAIL_EQUIP_ZOOM`）—— 全项目只有这一份；
 *   ② 体块 `part` → 档位（0/1/2）的**纯查表**（`bldTierOfPart`）—— 拆件时写进要素属性 `zt`；
 *   ③ 某档在某个 zoom 上**画不画**的判定（`bldLayerVisibilityAt`）—— 离线可数，用来做结构断言。
 *
 * ## 🔴 为什么"档位"要写进**要素属性**（`zt`），而不是在图层的 `filter` 里拼表达式
 * 项目已经为"表达式报错是静默的"付过代价（`wsBuildingLook` 文件头、`bld-win` 的注释）：
 * `fill-extrusion-*` 的 paint/filter 写错一个字段名 ⇒ **图层直接不画，控制台偶尔才吭一声**。
 * 所以在 JS 里把 `zt` 算好、图层只做**等值比较**（`["==", ["get","zt"], 1]`），与 `small`/`win` 同一条路。
 *
 * ## 🔴 为什么"visibility:none"是**离线判定**而不是写进图层属性
 * 需求原话是「z 低于某档阈值时，那一档的层 `visibility: "none"` ⇒ 0 顶点 / 0 draw call（离线可数）」。
 * MapLibre GL JS **v6.10.0 的 `layout.visibility` 不接受 zoom 表达式**——本机 vendor 里那份
 * style-spec 原文是：
 *   `visibility:{type:`enum`,values:{visible:{},none:{}},default:`visible`,expression:{interpolated:!1,parameters:[`global-state`]}}`
 * （`public/vendor/maplibre/maplibre-gl-shared.mjs`；`parameters` 只有 `global-state` ⇒ **写 `["step",["zoom"],…]`
 * 会让整份 style 校验失败 ⇒ 地图永远不 load**，这个坑项目也踩过："往 style 塞未知键 ⇒ load 永不触发"）。
 * ⇒ 真正让渲染器"这一档一帧都不画"的闸是 **`minzoom`**（图层级开关，等价于该档 `visibility:none`）；
 *    本文件的 `bldLayerVisibilityAt()` 就是**按 minzoom 语义**做的离线判定，
 *    自检拿它断言"z<阈值 ⇒ 该档 visibility=none ⇒ 0 顶点 / 0 draw call"。
 *    **不改图层属性、不加第二套机制**：一条闸（minzoom），一份判定（本文件），一处真源（这两个常量）。
 *
 * ## 与其它模块的分工
 * · `wsBuildingLook.ts`：拆件时给每个体块写 `part` 与 `zt`（`zt = bldTierOfPart(part)`）；
 * · `wsDistrictScene.ts`：出三条挤出层（`bld-ext` / `bld-roof` / `bld-equip`），各自 `minzoom` 取这里的数；
 * · `public/ws3dshow.html`：**经 vendor 读同一份**（`bldDetailTierZoom()`），页面**不许**再写死这两个数。
 *
 * 本文件**不 import 任何东西**（纯常量 + 纯函数）：`wsBuildingLook` 与 `wsDistrictScene` 都要用它，
 * 一旦它反向依赖任何一个，就会成环。
 */

/**
 * 🏠 **女儿墙那一档从哪一级开始画**（`14`）。
 *
 * 取值理由（不是拍脑袋）：
 *  ① 机主 2026-10-02 点名 `<14` 平顶 / `14–16` 女儿墙 ⇒ **这个数是他给的**；
 *  ② 与项目里已有的空间闸**同一档**：`?bst=2` 的 `bld-contact` 用的是 `minzoom: 15`、
 *     预渲染瓦片服务 `z<11`、`WS_BLD_VECTOR_MINZOOM = 11`（`wsDistrictScene.ts`）——
 *     本机默认机位是 **z16.4**（`wsScene.ts` 的默认相机）⇒ 女儿墙在**默认机位上是看得见的**，
 *     而 z14 以下（整片俯瞰）只画平顶主体，与改造前的画法**逐字节相同**；
 *  ③ 独立于**任何**运行时测量：这里只跟 zoom 走，**不读帧率、不读 deviceMemory、不看 fps**（机主红线）。
 */
export const WS_BLD_DETAIL_ROOF_ZOOM = 14;

/**
 * 🛠 **设备箱 + 天线那一档从哪一级开始画**（`16`）。
 *
 * 取值理由：
 *  ① 机主 2026-10-02 点名 `≥16` 设备箱+天线 ⇒ 这个数也是他给的；
 *  ② z16 是本项目默认机位（16.4）所在的那一级 ⇒ 打开页面就能看到这一档，
 *     而它**只在近景出现**：z16 时一个 0.01° 数据格（≈1.1km）在屏上约 600px 宽，
 *     一栋 20m 的楼约 12px 宽 —— 设备箱（1.5~4m）这时才够 1~3px、肉眼可辨；
 *     再远（z14~16）它就是亚像素噪点（同源教训：预渲染里"小楼不许描边"）。
 */
export const WS_BLD_DETAIL_EQUIP_ZOOM = 16;

/**
 * 体块 `part` → **zoom 档位**（0 = 一直画 / 1 = z≥14 / 2 = z≥16）。
 *
 * | 档 | 体块 | 为什么在这一档 |
 * |---|---|---|
 * | 0 | `body` / `podium` / `tower` / `setback` | 它们是**楼的轮廓本身**：`z<14` 也必须有楼（不许为了快少画楼） |
 * | 1 | `parapet`（女儿墙）、`roof`（基准档的屋顶压顶） | 屋顶**一圈薄墙**，0.6m 高，远景只有亚像素 |
 * | 2 | `equip`（设备箱）、`antenna`（天线） | 楼顶上 1.5~4m 的小体块与 12m 细杆，远景纯噪点 |
 *
 * ⚠️ `roof` 归第 1 档（它与 `parapet` 是同一件事的两代实现：`base` 档做压顶、`detail` 档做女儿墙）。
 * ⚠️ 查不到的一律落 **0**（"不确定就照旧画"—— 宁可多画一个体块，也不许因为查表失败**少画楼**）。
 */
export const BLD_PART_TIER: Readonly<Record<string, 0 | 1 | 2>> = Object.freeze({
  body: 0,
  podium: 0,
  tower: 0,
  setback: 0,
  roof: 1,
  parapet: 1,
  equip: 2,
  antenna: 2,
});

/** `part` 字符串 → 档位（查不到 = 0；见上表下的 ⚠️） */
export function bldTierOfPart(part: unknown): 0 | 1 | 2 {
  const t = BLD_PART_TIER[String(part ?? "")];
  return t === 0 || t === 1 || t === 2 ? t : 0;
}

/**
 * 楼房矢量层的起点（第 0 档）—— **镜像** `wsDistrictScene.WS_BLD_VECTOR_MINZOOM`。
 *
 * 🔴 为什么是"镜像"而不是 import：直接 import 会成环（`wsDistrictScene` → 本文件 → `wsDistrictScene`）。
 * 而 `WS_BLD_VECTOR_MINZOOM` 的**声明位置也不能搬**：`ws_lod_selftest.mjs:172` 是
 * **源码级正则**读 `wsDistrictScene.ts` 里那行 `WS_BLD_VECTOR_MINZOOM = <数字>` 的
 * （搬走 ⇒ 那条基线 408/0 直接红）。
 * ⇒ 处置：这里镜像一个数，**并用离线断言钉死它**——`ws_bld_detail_selftest.mjs` 第①组断言
 *   `bldDetailTierZoom(0) === wsDistrictScene.WS_BLD_VECTOR_MINZOOM`（读真源模块，不是读源码），
 *   谁改了一边而忘了另一边，**自检当场红**。这满足"阈值只许有一份"的实质（唯一可执行的数字在
 *   `wsDistrictScene`，这里是它的受检镜像），而不是嘴上说说。
 */
const WS_BLD_VECTOR_MINZOOM_MIRROR = 11;

/**
 * 档位 → 该档图层的 `minzoom`（**两页唯一的取数口**：页面经 vendor 调它，App 直接调它）。
 *
 * @param tier 0 / 1 / 2
 * @returns 该档的 minzoom；档位不认识 ⇒ `null`（调用方应当**不建**那一层，并在 HUD 写明原因 ——
 *          三态判词纪律：正数 / 0（已量）/ **数不出来**）
 */
export function bldDetailTierZoom(tier: number): number | null {
  if (tier === 0) return WS_BLD_VECTOR_MINZOOM_MIRROR;
  if (tier === 1) return WS_BLD_DETAIL_ROOF_ZOOM;
  if (tier === 2) return WS_BLD_DETAIL_EQUIP_ZOOM;
  return null;
}

/**
 * 🧮 **离线判定：某一档图层在 zoom `z` 上画不画**（MapLibre 的 `minzoom`/`maxzoom` 语义，逐条同式）。
 *
 * 判据来自 MapLibre 自己的 `Layer.getZoomRange()` / `StyleLayer.isHidden(zoom)`：
 *   图层可见 ⇔ `minzoom ≤ z < (maxzoom 未设 ⇒ +∞)`；否则**整层不出现在这一帧的渲染列表里**
 *   ⇒ 它不产 draw call、它的顶点一个都不进 GPU 管线。
 *
 * ⚠️ 这是**模型**，不是我去改渲染器：真源是图层规格里那一个 `minzoom` 数字，
 *    本函数只是把同一个数字按官方语义判一遍 ⇒ 自检可以**离线**断言结构（不需要 GL、不需要真机）。
 *
 * @param minzoom 图层下界（不给 / 非有限数 ⇒ 0，与 MapLibre 默认一致）
 * @param maxzoom 图层上界（不给 / 非有限数 ⇒ 无上界）
 * @param z       当前 zoom
 * @returns `"visible"` 或 `"none"`（`"none"` ⇒ 0 顶点 / 0 draw call）
 */
export function bldLayerVisibilityAt(minzoom: unknown, maxzoom: unknown, z: number): "visible" | "none" {
  const lo = typeof minzoom === "number" && isFinite(minzoom) ? minzoom : 0;
  const hi = typeof maxzoom === "number" && isFinite(maxzoom) ? maxzoom : Infinity;
  const zz = typeof z === "number" && isFinite(z) ? z : 0;
  return zz >= lo && zz < hi ? "visible" : "none";
}

/**
 * 🏢 **拆件要素在 zoom `z` 上实际会被画出的体块数**（离线可数；用来做"近景多画了 N 个顶点"的证据）。
 *
 * 语义：给一份"这栋楼生成了哪些 part"的清单，返回在 `z` 上**真的会进渲染**的那些 part。
 * 不许按帧率、不许按设备能力 —— 只看 zoom（机主红线）。
 */
export function bldPartsVisibleAt(parts: readonly string[], z: number): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const t = bldTierOfPart(p);
    const mz = bldDetailTierZoom(t);
    if (mz === null) continue;
    if (bldLayerVisibilityAt(mz, null, z) === "visible") out.push(String(p));
  }
  return out;
}
