/* wsFallback2d.ts —— M6：**2D 降级路整块**（`PLAN-REFACTOR.md` §2.1 的 M6 / §3 的 S2）。
 *
 * ## 这个文件收什么
 * 从宿主 `WsDistrictMapLibre.vue` **整块搬出来**的那条路（锚点 = 函数名，不按行号）：
 *   · `ALLOW_2D`（默认不自动降级；`?wsfallback=1` 与自动化环境是仅有的两个入口）
 *   · `styleNow` / `bboxOfGeometry` / `classify` / `dressBld` / `rampColor`
 *   · `draw2d`（Canvas2D 自绘俯视图）/ `drawContours`（DEM 等高线）
 *   · `fallback2d`（三条路共用的那个兜底：无 WebGL / 地图库加载失败 / `load` 一直不来）
 *
 * ## 搬迁纪律（这一片**零行为变化**）
 * 搬迁 = **移动 + 加签名**：分支、阈值、调用顺序、写进画布的那几行字、DOM 契约
 * （`data-ws-*` / `ws-labs` / 各 `id`）**逐字不变**。所以本文件里每个函数体都是
 * 从宿主**逐字节复制**过来的（对拍闸 `ws_fallback2d_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 为什么要 `createFallback2d(ctx)` 这个工厂，而不是 `fn(ctx, …)`
 * 这些函数**闭包着宿主的一大堆 setup 期局部量**（`theme` / `stats` / `cv` / `host` /
 * `aiOn` / `aiBboxRef` / `draw2dBbox` / `domPins` / `phase` / `perf` / `props` …）。
 * 若改成"每次调用都传 ctx"，函数体里每一处 `theme.value` 都得改写成 `ctx.theme.value`
 * —— 那就不再是"只搬不改"，而是顺手重构（本片禁止）。
 * ⇒ 依赖倒置的落法：**宿主构造一份只读 ctx 递进来，工厂在这里解构一次**，
 *    函数体于是**一个字都不用动**。ctx 的形状在 `wsStageTypes.ts`（L0.5，纯类型）。
 * ⚠️ 本模块**不许 import 宿主**（`PLAN-REFACTOR.md` §2.2 规则③）：只 import L0 叶子模块
 *    与 L0.5 类型，方向永远向下。
 *
 * ## 为什么 `map` 是形参，而不是 ctx 字段
 * 宿主那份 `map` 是 `let`（建图/销毁时会被**重新赋值**），把它解构进闭包只会拿到快照。
 * ⇒ 只有真正读它的两个函数（`dressBld` / `fallback2d`）多收一个形参，由宿主在调用点把
 *    **当时**的 `map` 递进来 —— 与原实现读到的时刻**完全一致**（同一个同步点）。
 *
 * ## S2 没搬的（照实留痕）
 * · `drawContours` 目前**没有任何调用点**（宿主里只有定义处 + 一处注释提到它）；
 *   本片照样整块搬过来，一个字没改 —— 它是死代码这件事**不在本片处理**（§3 把删死代码排在 S9）。
 * · `renderKind` / `fallbackWhy` / `fallbackKind` 这些**状态**仍留在宿主（M8/M9 的地盘），
 *   本模块只读它们、不改它们的所有权。
 */

import { aiFeatures } from "./wsAiLayers";
import { decorateBuildings, renderHeight } from "./wsBuildingLook";
import { districtStyleOf, dressBase } from "./wsDistrictScene";
import {
  DEM_TILE_SIZE,
  DEM_TILE_Z,
  contourFeatureCollection,
  demTileUrl,
  lngLatToTile,
  readDemGrid,
  tileContours,
} from "@/composables/wsContour";
import type { BldFeature } from "./wsBuildingSources";
import type { BldMapLike, Fallback2dCtx } from "./wsStageTypes";

/**
 * 装配 2D 降级路：宿主把只读 ctx 递进来，拿回这条路的全部函数。
 *
 * ⚠️ 调用点必须在**所有被闭包捕获的 ref/computed 都声明之后**（宿主里放在 `domPins` 之后）：
 * 这些量是 `const`，声明前引用会踩 TDZ（本仓有过前科）。
 */
export function createFallback2d(ctx: Fallback2dCtx) {
  const { stats, theme, perf, cv, host, aiOn, aiBboxRef, draw2dBbox } = ctx;
  const { mapAvailable, fallbackKind, show2d, domPins, phase, props } = ctx;
  const { NIGHT_FADE_MS, WS_BLD_MODE } = ctx;
  const { dprCap2d, stopTimer, startRecoverPoll, maybeAppSelfShot } = ctx;
  const { isAutomation, artTheme } = ctx;

  /**
   * 🔴 2026-09-21 机主硬要求：「**要求别降级了，直接全面迭代（最新）**」+「App 整个地图感觉像落后好多」。
   *
   * ⇒ **默认不再自动降到 2D 自绘路**（那条路又卡、又像静态图、又没有手势 ——
   *   而机主的机器**有** WebGL，代拍页 `ws3dshow.html` 实测顺滑）。
   * 手动逃生阀 `?wsfallback=1`（真机确实没有 WebGL 时才用）保留，默认关。
   * ⚠️ 例外：**自动化/无头**（`navigator.webdriver`）保留 2D 兜底 ——「能玩」闸门跑的就是那条路，
   * 关掉它等于把闸门变成假失败（它量不到任何东西）。
   */
  const ALLOW_2D = (() => {
    try {
      if (/[?&]wsfallback=1\b/.test(location.search)) return true;
    } catch {
      /* 无 location ⇒ 看下面的 automation 判定 */
    }
    return isAutomation();
  })();

  /**
   * 自建 style —— **装配在共享真源里**（`wsDistrictScene.districtStyleOf()`）。
   *
   * 🔴 2026-09-25（PR 标准门禁 C1）：这里原来有一份本地 `makeStyle()`，与原型页那份并存 ⇒
   * "运行期逻辑必须在共享单一真源"（`ROUTE.md §五.1`）不达标。现在**搬家**到
   * `wsDistrictScene.ts`（行为逐字不变），宿主只把主题/档位/过渡时长递进去。
   * 回退：`git revert <本 commit>`。
   */
  function styleNow(): Record<string, unknown> {
    return districtStyleOf(theme.value, !!perf.low.value, perf.low.value ? 0 : NIGHT_FADE_MS);
  }

  function bboxOfGeometry(g: { type?: string; coordinates?: unknown } | null | undefined): [number, number, number, number] | null {
    if (!g) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const walk = (v: unknown): void => {
      if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
        const x = v[0] as number;
        const y = v[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      if (Array.isArray(v)) for (const x of v) walk(x);
    };
    walk(g.coordinates);
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
    return [minX, minY, maxX, maxY];
  }

  /**
   * 楼高来源分类（与 Rust/前端别处的口径一致：height → levels×3 → **按 OSM 类型估**）。
   *
   * ⚠️ 三档必须分得开（`DESIGN-3D-MODES.md` §八 的红线）：
   * OSM 在中国的楼高覆盖率很低（渝中区实测 800m 内 232 栋里 **166 栋没有高度**），
   * 那 166 栋的高度是**我们按 `building=*` 类型猜的**，HUD 里单独一列，
   * 绝不能混进"真高" —— 混在一起报一个数就是把估计值当真数据。
   */
  function classify(fc: { features?: BldFeature[] }) {
    let h = 0;
    let l = 0;
    let d = 0;
    for (const f of fc.features || []) {
      const s = String((f.properties || {}).height_src || "default");
      if (s === "height") h++;
      else if (s === "levels") l++;
      else d++;
    }
    stats.height = h;
    stats.levels = l;
    stats.default = d;
    stats.count = (fc.features || []).length;
  }

  /**
   * 给后端给的真楼房"上妆"：补上渲染字段 `h3d`（渲染高度）与 `h_from`（高度凭什么），
   * 顺手把 HUD 的三档计数更新掉。
   *
   * **只在这里算一次**，后面所有 `addSource/setData` 都用这份结果 ——
   * 画面用的高度和 HUD 报的数于是**必然是同一个数**（两边各算一次迟早漂移，漂移了没人会发现）。
   */
  function dressBld(fc: { features?: BldFeature[] } | null, map: BldMapLike | null): {
    type: "FeatureCollection";
    features: unknown[];
  } {
    /* 🏢 **默认档 = 主体 + 屋顶系（按 zoom 固定分档）** —— 机主拍板 **(a′)：App 向代拍页看齐**
       （原话「**我的要求是代拍页和App页完全一样喵**」）+ **2026-10-02 B1**（`<14` 平顶 /
       `14–16` 女儿墙 / `≥16` 设备箱+天线）。
       两页默认档走**同一个** `dressBase()`（共享真源 `wsDistrictScene`）：
       `h3d`/`h_from`/`color3d`/`h_base`/`part`/`zt`/`fp`/`small`，拆件口径 = `mode:"roof"`。
       ⚠️ 这里要把**当前 zoom** 喂进去：生成侧与图层侧用**同一份固定阈值**（`wsBldDetailTiers`），
       `z<14` 连女儿墙体块都不生成 ⇒ `setData` 的解析量与改造前**同样轻**。
       🔴 **不许**把 zoom 换成"实测帧率/设备能力"（机主红线：那是他不批的性能档位降级）。
       🏢 **`?bld=2` = 拆件档**（与代拍页同一个开关）：走 `decorateBuildings(..., {mode:"detail"})`，
       多出裙楼/塔楼/退台/窗格；颜色写进要素属性 `color3d` ⇒ 图层读它。 */
    if (WS_BLD_MODE === 2) {
      const { features, count } = decorateBuildings(fc, artTheme(theme.value).ramp, { mode: "detail" });
      stats.count = count.n;
      stats.height = count.real;
      stats.levels = count.levels;
      stats.default = count.kind; // HUD 里这一列叫「按类型估」
      stats.parts = count.parts;
      return { type: "FeatureCollection", features };
    }
    const { features, counts } = dressBase(fc?.features as readonly BldFeature[] | undefined, {
      ramp: artTheme(theme.value).ramp,
      zoom: map ? map.getZoom() : null,
    });
    stats.count = counts.n;
    stats.height = counts.real;
    stats.levels = counts.levels;
    stats.default = counts.kind; // HUD 里这一列叫「按类型估」
    stats.parts = features.length;
    return { type: "FeatureCollection", features };
  }

  /** 渲染高度 → 颜色（2D 降级路用；与 3D 的色阶**同一张表**，免得两条路观感不一致）。
   *  表来自当前主题 —— 二次元主题下连 2D 降级也是那套淡天蓝。 */
  function rampColor(h: number): string {
    const ramp = theme.value.ramp;
    let c = ramp[0]![1];
    for (const [stop, col] of ramp) {
      if (h >= stop) c = col;
    }
    return c;
  }

  /**
   * Canvas2D 降级：把真实楼房画成**俯视图**。
   * 不引任何东西 —— 经纬度按包围盒线性映射到画布，y 轴翻转（纬度向上、画布向下）。
   */
  function draw2d(fc: { features?: BldFeature[] } | null) {
    const c = cv.value;
    if (!c) return;
    /* 🎨 2D 降级路的调色板**从主题取**（2026-09-20 主会话截图发现：主题只写在 MapLibre 的
       style 上，而低端机走的是这条 Canvas2D 自绘路 ⇒ 底色是写死的深色，
       结果一台低端机上是"浅蓝界面 + 黑地图"的半截子观感）。
       这一刀把 `bg / empty / 描边 / 示意层投影` 全部改成读 `theme.canvas`。
       ⚠️ 这块画布**没有自己的 CSS 底色**（`.ws-dml__cv` 只有 position/inset），
          所以下面那次 fillRect 就是"地面"本身，改它才有效。 */
    const pal = theme.value.canvas;
    // ⚠️ 别把局部变量叫 `host`：会遮蔽外层的 ref，TS 直接报"自引用"（TS7022/TS2448）
    const el = host.value;
    const w = Math.max(64, el?.clientWidth || 320);
    const h = Math.max(64, el?.clientHeight || 240);
    /* 🔴 2026-09-21：降级路的画布**像素数封顶 1.5×**（原来是 `min(2, dpr)`）。
       机主的证据把这条钉死了：「**在小区级很卡**（那可能降级后的是，在那个代拍里的用 webgl
       却一点都不卡）」—— 同一台手机，WebGL 那条路不卡 ⇒ **贵的是这条路**。
       它贵在**填充率**：真机 1080×2400 @dpr2.4 的画布，按 dpr=2 建 = **1080×2400 像素**
       （原来 `min(2, 2.4)` 就是 2），每一次自绘（底色 + 网格 + 楼 + 等高线 + 示意层）
       都要把这么多像素写一遍；封到 1.5 ⇒ 810×1800 = **少 44% 的像素**，观感几乎无差别
       （这块画布画的是平面俯视图，不是要抠细节的写实图）。
       逃生阀：`?wsdpr=2`（低端机想对照/想更清楚时用，与 `?wsnight=off` 同一套口径）。 */
    let dpr = Math.min(dprCap2d(), window.devicePixelRatio || 1);
    /* 再按**总像素**封一道（机主/主会话要的"降级路画布尺寸封顶"）：
       大屏（平板/横屏）上 `w×h` 本来就大，DPR 1.5 也能堆到几百万像素。
       1.4M 像素 ≈ 1440×960 的 2D 自绘量：够看清街区轮廓，又不会让每次自绘去写几百万像素。 */
    const MAX_PX_2D = 1_400_000;
    const px = w * h * dpr * dpr;
    if (px > MAX_PX_2D) dpr = Math.max(1, dpr * Math.sqrt(MAX_PX_2D / px));
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    const feats = fc?.features || [];
    /* 🆕 2026-09-20：**降级路也要能"看到城市"**。
       以前这里只画真楼 ⇒ 涪陵（真楼 0~29 栋）在低端机上就是一片空 + 一行
       「这一带没有楼房数据」，和机主要的"成片"完全相反。
       现在把同一份示意图元也画进来（同一条 `aiOn` 判据：真数据够就不画）。
       ⚠️ 位置仍然是示意（线性映射），所以这一层用**暖色**画，和真楼的冰蓝分得开。 */
    const aiFc = aiOn.value && aiBboxRef.value ? aiFeatures(props.aiItems || [], aiBboxRef.value, props.grid || 28) : [];
    const aiPolys: Array<{ pts: number[][]; kind: string }> = [];
    for (const f of aiFc) {
      if (f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (ring?.length) aiPolys.push({ pts: ring as number[][], kind: String(f.properties.kind) });
    }
    if (!feats.length && !aiPolys.length) {
      /* 🔴🔴 **这里曾经就是机主看到的「纯色屏」**（2026-09-21 定案）。
         原来这个分支只做两件事：铺满 `pal.bg` + 在左上角写一行 12px 的
         「这一带没有楼房数据」⇒ 一屏**只有底色**（二次元主题下是 `#DCEFF7` 一片浅蓝），
         远看/缩略图看**就是一张纯色图**；而机主 21:54 那两张"逐字节相同"的截图
         量出来正是 `std=0.00` 的单色。

         为什么会走到这儿：看门狗把"地图库 8 秒内没画出第一帧"判成降级 ⇒ 2D 路，
         而 2D 路的楼栋要**放大到街区**才会去取 ⇒ 全区视野下 `feats` 是空的。
         两个"如实"叠在一起，结果是一屏什么都没有。

         ⇒ 纪律改成：**降级路永远不许留一整片纯色**。没有数据就画一个**明确的等待态**：
           浅网格（看得出"这是一块地，不是坏了"）+ 两行字（在等什么、为什么）。
         代价是几十条线，**只画一次**（`draw2d` 不是逐帧调用）⇒ 低档帧率不受影响；
         真正的"呼吸"动效交给 DOM/CSS（见模板里那块 `.ws-dml__wait`），不开 canvas 逐帧。
         ⚠️ 网格颜色从**主题**取（`pal.empty` + 低透明度）而不是写死灰色：
           夜色/暗色主题下写死的灰线会变成"亮底上的白线"（看不见），这条踩过。 */
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = pal.empty;
      ctx.lineWidth = 1;
      const step = 28;
      ctx.beginPath();
      for (let x = step; x < w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = step; y < h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = pal.empty;
      ctx.font = "13px system-ui";
      ctx.fillText("降级预览 · 楼栋还没取到", 12, 24);
      ctx.globalAlpha = 0.75;
      ctx.font = "11px system-ui";
      /* 🔴 这两行必须**逐字为真**（原来那行「这一带没有楼房数据」是在替后端下结论，
         而真相常常只是"这一档根本没去取"）。
         为什么不能写「放大到街区会自动加载」：**2D 降级路上缩放是死的** ——
         `zoomBy`/`fitDistrict` 都要 `map`（MapLibre 实例），而降级时 `map = null`
         ⇒ 楼栋永远不会再取。写在画布上的承诺必须是我们真做得到的。 */
      ctx.fillText("地图库没起来，走的是自绘路；HUD 里有原因", 12, 42);
      ctx.globalAlpha = 1;
      /* 这一屏**什么都没画**（连楼都没有）⇒ 也就没有"范围内"可言：把范围清空，
         让 `domPins` 空着并在 HUD 如实写"数不出来"，而不是把人撒在一块没画的画布上。 */
      draw2dBbox.value = null;
      return;
    }
    // 包围盒（真楼 + 示意图元一起算，否则示意层会被算到画布外）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rings: Array<{ pts: number[][]; col: string }> = [];
    for (const f of feats) {
      const g = (f.geometry || {}) as { type?: string; coordinates?: unknown };
      const polys: number[][][][] =
        g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
      /* 颜色按**渲染高度**取（与 3D 路同一张色阶表）—— 降级路也看得出高低。
         拆件（屋顶/天线）在 2D 俯视图里只会重影，所以**只画主体**。 */
      if ((f.properties || {}).part && (f.properties || {}).part !== "body") continue;
      const col = rampColor(renderHeight(f.properties).h);
      for (const poly of polys) {
        const ring = poly[0];
        if (!ring?.length) continue;
        rings.push({ pts: ring as number[][], col });
        for (const p of ring) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        }
      }
    }
    for (const a of aiPolys) {
      for (const p of a.pts) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;
    /* 🧭 把这份范围**留给降级路的人**（`domPins` 要用同一份，人才会站在画出来的楼上）。 */
    draw2dBbox.value = [minX, minY, maxX, maxY];
    const pad = 10;
    const k = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    const ox = (w - k * (maxX - minX)) / 2;
    const oy = (h - k * (maxY - minY)) / 2;
    const X = (lng: number) => ox + (lng - minX) * k;
    const Y = (lat: number) => oy + (maxY - lat) * k; // y 翻转
    for (const r of rings) {
      ctx.beginPath();
      r.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.closePath();
      ctx.fillStyle = r.col;
      ctx.fill();
      /* 描边跟主题走：二次元是**深藏青**（浅底上才看得见），暗色是淡白细线 */
      ctx.strokeStyle = pal.bldStroke;
      ctx.lineWidth = pal.bldStrokeW;
      ctx.stroke();
    }
    /* 示意层（暖色，和真楼的冰蓝分得开）。俯视图里没有"高度"，
       所以给每栋楼往右下**偏移一小块**当投影 —— 一眼能看出这是"有体量的楼"，
       而不是一块平贴的色块（机主要的"成片楼房"在 2D 降级路上也要成立）。 */
    for (const a of aiPolys) {
      const hex = a.kind === "park" ? theme.value.ai.park : a.kind === "water" ? theme.value.ai.water : "#d9a06b";
      ctx.beginPath();
      a.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.closePath();
      if (a.kind === "park" || a.kind === "water") {
        /* 和上面 3D 的 `ai-area` 用**同一对颜色**（`theme.ai`），别再写第二套 rgba */
        ctx.fillStyle = a.kind === "park" ? theme.value.ai.park : theme.value.ai.water;
        ctx.fill();
        continue;
      }
      /* 投影：往右下挪 6% 的楼宽，紫黑半透明 */
      const dx = Math.max(1.5, (Math.max(...a.pts.map((p) => p[0])) - Math.min(...a.pts.map((p) => p[0]))) * k * 0.12);
      ctx.save();
      ctx.translate(dx, dx * 0.7);
      ctx.fillStyle = pal.aiShadow;
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = hex;
      ctx.fill();
      ctx.strokeStyle = pal.aiStroke;
      ctx.lineWidth = pal.aiStrokeW;
      ctx.stroke();
    }
  }

  /**
   * 取中心那张 DEM 瓦片 → 算等高线 → 挂成一层线（放在楼房**之下**，不抢主体）。
   * ⚠️ 失败一律如实写进 HUD 的 note，**不画假等高线**；`stats.contour` 记 -1。
   */
  async function drawContours(m: {
    getCenter(): { lng: number; lat: number };
    getSource(id: string): { setData(d: unknown): void } | undefined;
    getLayer(id: string): unknown;
    addSource(id: string, spec: Record<string, unknown>): void;
    addLayer(spec: Record<string, unknown>, beforeId?: string): void;
  }): Promise<void> {
    try {
      const c = m.getCenter();
      const t = lngLatToTile(c.lng, c.lat, DEM_TILE_Z);
      const tx = Math.floor(t.x);
      const ty = Math.floor(t.y);
      const grid = await readDemGrid(demTileUrl(DEM_TILE_Z, tx, ty));
      const feats = tileContours({
        grid,
        w: DEM_TILE_SIZE,
        h: DEM_TILE_SIZE,
        z: DEM_TILE_Z,
        tx,
        ty,
        interval: 20,
        maxLevels: 40,
      });
      if (!feats.length) {
        stats.contour = 0;
        return;
      }
      const data = contourFeatureCollection(feats);
      const src = m.getSource("dem");
      if (src) {
        src.setData(data);
      } else {
        m.addSource("dem", { type: "geojson", data });
        /* ⚠️ `addLayer(spec, beforeId)` 里的 beforeId **不存在会直接抛**
           （`Layer with id "bld-ext" does not exist`）。
           而"这一带没有楼房"时 `bld-ext` 根本不会被建出来（涪陵实测 400m 就是 0 栋）
           ⇒ 等高线会连带整层失败、HUD 只显示"等高线不可用"。
           所以这里**逐级回退**：楼 → 注记层 → 直接追加。 */
        const before = m.getLayer("bld-ext") ? "bld-ext" : m.getLayer("ref") ? "ref" : undefined;
        m.addLayer(
          {
            id: "dem-line",
            type: "line",
            source: "dem",
            paint: {
              /* 每整 100m 计曲线加粗提亮（地形图惯例：一眼读数） */
              "line-color": [
                "case",
                ["==", ["%", ["get", "ele"], 100], 0],
                "#ffd28a",
                "rgba(121, 217, 255, 0.55)",
              ],
              "line-width": ["case", ["==", ["%", ["get", "ele"], 100], 0], 1.2, 0.5],
              "line-opacity": 0.8,
            },
          },
          before
        );
      }
      stats.contour = feats.length;
    } catch (e) {
      stats.contour = -1;
      const why = String((e as Error)?.message || e).slice(0, 24);
      stats.note = stats.note ? `${stats.note} · 等高线取不到` : `等高线取不到（${why}）`;
    }
  }

  /**
   * 兜底：放弃地图库，改用 Canvas2D 画俯视图 + DOM 钉子画人。
   *
   * **三条路共用一份**（无 WebGL / 地图库加载失败 / **地图库起来了但 `load` 一直不来**）：
   * 写三遍迟早漂移；而第三条**以前根本不存在** ——
   * 结果是玩家永远停在「初始化…」：没有楼、没有人、没有解释，只有一行小字。
   * （2026-09-19 实测：无头环境下 `hasWebGL()` 返回真、`new Map()` 也成功，
   *  但 `load` **永远不触发** ⇒ HUD 就卡在初值。这正是"能玩"闸门第③条挂掉的原因。）
   */
  function fallback2d(
    mode: string,
    fc: { features?: BldFeature[] } | null,
    why = "",
    kind: "temp" | "perm" = "perm",
    map: BldMapLike | null = null
  ): void {
    stats.mode = mode;
    mapAvailable.value = false;
    /* 🔴🔴 **这条是本次 fps 修复的核心一行**（2026-09-20）：
       走到这里 = 我们已经确定在用 **Canvas2D 软渲染**（不管是因为探针说没 WebGL、
       地图库加载失败，还是地图库 `load` 一直不来被看门狗砍掉）。软渲染天生重 ——
       实测小区级只有 7fps。
       而**档位判定此前完全不知道这件事**：它只看核数/内存/WebGL 探针，于是
       "页面在跑最重的路、档位还是高档"，雨/雪、小地图、头像、车辆全套满血跑。
       ⇒ 谁降级，谁负责把档位压下去（**因果**，不是**预测**）。
       用 `perf.low` 的地方会自动跟着变：`ws-perf-low` 类、天气层、车辆/行程卡全部生效。 */
    perf.forceLow(mode);
    /* HUD 上如实写清两件事：**为什么被压到低档** + **2D 画布的 DPR 封顶**
       （机主的三个症状里"很卡"就是这条路的填充率；写出来他才看得出我们为此做了什么） */
    stats.perf = `已因「${mode}」压到低档（2D 画布 DPR 封顶 ${dprCap2d()}，真机 dpr=${typeof devicePixelRatio === "number" ? devicePixelRatio : "?"}）`;
    /* 🔴 **降级前必须换一块新画布**：`cv` 可能已经被 WebGL 占过（MapLibre 在它上面建了
       webgl 上下文），而按 HTML 规范，`canvas.getContext("2d")` 在**已经有 webgl 上下文**
       的画布上会返回 `null` ⇒ `draw2d()` 里 `if (!ctx) return;` 直接**静默不画**。
       症状："已经降级了，HUD 也说了原因，但画布是**空白**的"，而且**零报错**。
       （同一张画布不能有两种上下文，这是规范行为，不是 bug —— 但极容易踩。） */
    const oldCv = cv.value;
    const hostEl = host.value;
    /* 🔴 P0：**临时类降级不换画布、也不销毁地图** —— 直接在原来那块上面**盖**一块新的 2D 画布。
       为什么这样就绕开了"一个 canvas 不能同时有 webgl 和 2d 上下文"这条规范限制：
       **2D 画的是另一块 canvas**，WebGL 那块原封不动留在 DOM 里（只是藏起来），
       MapLibre 继续拿它渲染 ⇒ 它一出帧，把上面这块摘掉、把下面那块显示回来 = **切回 WebGL**
       （零重建、零换画布、相机与图层全都在）。这正是上一轮写在注释里"列入未做"的那件事。 */
    const keepAlive = kind === "temp" && !!map && !!oldCv;
    fallbackKind.value = kind;
    if (keepAlive) {
      try {
        (oldCv as HTMLCanvasElement).style.visibility = "hidden";
        (oldCv as HTMLCanvasElement).style.pointerEvents = "none";
      } catch {
        /* 样式写不上也不影响"盖一块新的"这件事 */
      }
    }
    /* 两种都要新建一块：
       ① 旧画布拿不到 2D 上下文（它被 WebGL 占过）；
       ② **旧画布压根不存在**（WebGL 路下模板那块被 `v-if` 关掉了）—— 这一条是这次加上的，
          少了它，降级路会"什么都不画"（`draw2d` 里 `if (!c) return`）且**零报错**。 */
    if (!oldCv || !oldCv.getContext("2d")) {
      show2d.value = true; // 让 `v-if` 打开（下一帧生效；这一帧我们直接用新建的这块）
      const fresh = document.createElement("canvas");
      /* ⚠️ 要连**所有属性**一起搬（`class` 之外还有 Vue 的 scoped 标记 `data-v-xxxx`）——
         漏了它，新画布就丢掉了 `position:absolute; width:100%; height:100%`，
         会缩回浏览器默认的 300×150 跑到左上角：**又是一次"降级了但看着是坏的"**。 */
      /* 旧画布在不在都要能走通：不在就照**模板那块的类名**补上（`ws-dml__cv` 的定位/铺满规则靠它） */
      if (oldCv) for (const at of Array.from(oldCv.attributes)) fresh.setAttribute(at.name, at.value);
      else fresh.className = "ws-dml__cv";
      if (keepAlive && oldCv?.parentElement) {
        /* 盖在**上面**（`afterend`）：下面那块 WebGL 画布继续存在、继续渲染，只是看不见 */
        oldCv.parentElement.insertBefore(fresh, oldCv.nextSibling);
        fresh.classList.add("ws-dml__cv--2d");
      } else if (oldCv?.parentElement) {
        oldCv.replaceWith(fresh);
      } else if (hostEl) {
        /* `map.remove()` 会把画布**从 DOM 里摘掉**（我们把它交给了地图库管），
           这时 `replaceWith` 是空操作 ⇒ 必须自己插回去，否则又是"画在一块不在页面上的画布"。 */
        hostEl.insertBefore(fresh, hostEl.firstChild);
      }
      cv.value = fresh;
    }
    stats.pins = domPins.value.length;
    if (why) stats.note = stats.note ? `${stats.note} · ${why}` : why;
    draw2d(fc);
    phase.value = "done";
    stopTimer();
    /* 临时类：**后台继续等它出帧**，出来了就切回 WebGL（每 4 秒看一次，见 `startRecoverPoll`） */
    if (keepAlive) startRecoverPoll();
    /* 🧪 App 自拍：**降级路更要拍** —— "整屏纯色"那类事故就发生在这条路上（闸门只跑这条路，
       所以这条路正是"agent 以为验过了"的那条）。`why` 原样带进诊断图，别让图上写着"2D"却没有原因。 */
    maybeAppSelfShot("fallback2d", why || "未说明原因");
  }

  return { ALLOW_2D, styleNow, bboxOfGeometry, classify, dressBld, draw2d, drawContours, fallback2d };
}
