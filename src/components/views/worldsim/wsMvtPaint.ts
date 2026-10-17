/**
 * `?mvt=1` 那条路的 **paint 表达式构造**（零依赖 ⇒ 本机可直接单测、逐档对拍）。
 *
 * 为什么要单独一份：旧路的五条楼房层由 `bldLayerSpecsFor(theme, tier, opts)` 产，取参来自
 * `wsArtParams.bldArtParamsOf()`（`rampColor` / `vgrad` / `opacity` / `lineWidth` / `outline.color`）。
 * 瓦片路的层如果自己写死颜色与不透明度，两条路**必然漂移**（实测就是：瓦片路没有竖向渐变、
 * 部件没有明暗差、描边宽写死 0.6）。所以这里只做"把同一份取参翻译成瓦片源的表达式"：
 *
 *   · 颜色 = `coalesce(瓦片里的 color3d, 取参给的 rampColor)` —— **与旧路同一个结构**
 *     （旧路是 `coalesce(要素的 color3d, P.rampColor)`）；差别只有字段名（`c` vs `color3d`）与
 *     色阶读的字段（瓦片里是 `h`，旧路是 `h3d`，因为瓦片只带渲染高度）。
 *   · 竖向渐变 / 不透明度 / 描边宽 / 描边色 —— 一律取 `P` 的同名字段，**不写第二份常量**。
 *   · 挤出基座 = `coalesce(get hb, 0)`（旧路是 `coalesce(get h_base, coalesce(get min_height, 0))`；
 *     瓦片里 `hb` 就是那个基座，主体恒 0、部件是楼面高）。
 */

/** 主题取参里瓦片路要用的那几项（= `bldArtParamsOf` 结果的子集） */
export interface MvtArtParams {
  rampColor?: unknown;
  vgrad?: boolean;
  opacity?: number;
  lineWidth?: unknown;
  outline?: { color?: unknown } | null;
}

/** 把表达式里所有 `["get", from]` 换成 `["get", to]`（深拷贝，不改入参）。**只认这两个字面量**。 */
export function swapField(expr: unknown, from: string, to: string): unknown {
  if (Array.isArray(expr)) {
    if (expr.length === 2 && expr[0] === "get" && expr[1] === from) return ["get", to];
    return expr.map((x) => swapField(x, from, to));
  }
  return expr;
}

/** 颜色：瓦片自带的 `c`（= 运行时的 color3d）优先，缺了走取参色阶（已把 `h3d` 换成 `h`）。 */
export function colorExpr(rampExpr: unknown): unknown[] {
  return ["coalesce", ["to-color", ["get", "c"]], rampExpr];
}

/** 三条挤出层共用的 paint（与旧路 `detailPaint` 逐字段对应） */
export function extrusionPaint(opts: { rampExpr: unknown; vgrad?: boolean; opacity?: number }): Record<string, unknown> {
  return {
    "fill-extrusion-height": ["coalesce", ["get", "h"], 8],
    "fill-extrusion-base": ["coalesce", ["get", "hb"], 0],
    "fill-extrusion-opacity": typeof opts.opacity === "number" ? opts.opacity : 0.95,
    "fill-extrusion-vertical-gradient": !!opts.vgrad,
    "fill-extrusion-color": colorExpr(opts.rampExpr),
  };
}

/** 足迹层（平面）：颜色同一条口径，不透明度取旧路那个常量 */
export function footPaint(opts: { rampExpr: unknown; opacity: number }): Record<string, unknown> {
  return { "fill-color": colorExpr(opts.rampExpr), "fill-opacity": opts.opacity };
}

/** 描边层：颜色与宽度都取旧路同一份取参 */
export function outlinePaint(opts: { color?: unknown; width?: unknown; fallbackRamp: unknown }): Record<string, unknown> {
  return {
    "line-color": opts.color === undefined || opts.color === null ? colorExpr(opts.fallbackRamp) : opts.color,
    "line-width": opts.width === undefined || opts.width === null ? 0.6 : opts.width,
  };
}
