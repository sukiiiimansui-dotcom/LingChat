/**
 * wsPageVendor.ts —— **静态页生成物的唯一入口**（只做 re-export，没有自己的逻辑）。
 *
 * 静态页（`public/ws3dshow.html`）引不到 TS ⇒ 走"生成物"这条路（与 `public/wstheme.json` 同款）：
 * `scripts/build-ws-vendor.sh` 打包本文件 → `public/vendor/wsScene.mjs`（提交进仓库 + 自检兜漂移）。
 *
 * 🔴 为什么入口要单独一个 re-export 文件：esbuild 只从入口收依赖 ——
 * 直接打某个实现文件时，**别的模块里没被它 import 的导出不会进产物**
 * （踩过：页面 `TF.TF_LAYER_IDS` 变 undefined）。所以这里把页面要用的**全部**列出来。
 */
export * from "./wsTransport"; // 交通设施：生成逻辑
export * from "./wsTransportRules"; // 交通设施：规则/图层 id/样式/低档名单
export * from "./wsRoads"; // 路网：分级样式 + 计数
export * from "./wsLayerOrder"; // 层序保证（事后断言式自愈）
export * from "./wsArtSky"; // art=3 天空几何（云/山影/雾带，纯函数）
export * from "./wsScene";
/* 🧱 **累积式要素仓库 + 离线路面包**（机主 2026-09-25：「之前的没了…必须保证视野内完整」）：
   `createFeatureStore()` 去重/淘汰/统计 + `roadsBundleCellsForView()` 算"视野需要哪些离线格"。
   ⚠️ 纯逻辑，页面与 App 共用同一份（不许第二套合并/淘汰）。 */
export * from "./wsFeatureStore"; // 场景装配（相机默认值 + 图层序 + 自证） // art=3 天空几何（云/山影/雾带，纯函数） // 层序保证（事后断言式自愈） // 路网：分级样式（roadLayerSpecs）+ 计数（visibleRoadCount / roadStatsLine）
/* 🏢 楼房**形体细化**（2026-09-24）：代拍页 `?bld=2` 用 `decorateBuildings(fc, ramp, {mode:"detail"})`
   生成裙楼/塔楼/退台/女儿墙/设备箱，并拿 `shapeCountsLine()`/`shapeCountRows()` 做回证；
   `windowPatternSpec()` 供 `?win=1` 的窗格层。
   ⚠️ 这里只是**让页面能拿到同一份纯函数**（不在页面里抄第二份几何/计数逻辑）。

   🔴 **2026-09-24 复盘**（机主真机上 `?bld=2` 回退成基准版、截图写着"模块里没有 decorateBuildings"）：
   查下来**不是 tree-shaking** —— 这 20 个符号**本来就在产物里**（`git show HEAD:public/vendor/wsScene.mjs`
   逐个 grep 命中、`import()` 后 `typeof` 全绿、`dist-webdev` 那份同样在，字节数 48694 三份一致）。
   真因是**浏览器缓存**：代拍页用**静态** `import "/vendor/wsScene.mjs"`（URL 无内容哈希），
   而预览服务给它的响应头是 `Cache-Control: public, max-age=31536000, immutable`
   ⇒ `&v=10` 只顶掉了 HTML，**模块仍是旧的**。
   ⇒ 页面侧加了自愈：缺符号就用**带版本号的 URL** 重取一次（`ws3dshow.html` 的 `tfModule()`），
   并把**逐符号在场情况**写进徽标 —— 下次一眼看出是"模块旧"还是"真没有"。

   `export *` 与下面这张显式清单**并存**：前者保证"以后新加的导出自动进产物"，
   后者是**页面依赖契约**（`ws_transport_selftest` 的漂移守卫 + `ws_bld_page_selftest` 会逐个核对，少一个就红）。 */
export * from "./wsBuildingLook";
export {
  /* 页面/HUD 直接调用的（`?bld=2` 全靠它们） */
  decorateBuildings,
  buildingPartSet,
  buildingParts,
  shapeCountsLine,
  shapeCountRows,
  fmtCount,
  windowPatternSpec,
  /* 配色（与 App 同一张色阶；页面用它给窗格层派生颜色，不写第二套配色） */
  HEIGHT_COLOR_RAMP,
  heightColorExpression,
  rampColorOf,
  buildingColor,
  shade,
  renderHeight,
  hash32,
  /* 🔧 估算档位（裸 `building=yes` / 未登记类型 = **15~18m**；机主 2026-09-24 定）：页面徽标要显示它 */
  KIND_HEIGHT_M,
  FALLBACK_HEIGHT_M,
  UNKNOWN_KIND_BAND_M,
  KIND_JITTER,
  /* 几何工具（自检与将来的 App 侧接线都要用） */
  footprintMetrics,
  insetRing,
  insetRingMeters,
  ringBand,
  pointInRing,
  buildingMasses,
  equipBoxes,
  /* 阈值常量（HUD 文案与自检都从这一份取，别在页面里写第二遍） */
  PODIUM_MIN_AREA_M2,
  PODIUM_MIN_H,
  PODIUM_INSET,
  SETBACK_MIN_H,
  SETBACK_TIERS_3_H,
  SETBACK_INSET,
  PARAPET_MIN_H,
  PARAPET_H,
  PARAPET_THICK_M,
  EQUIP_MIN_AREA_M2,
  SLIVER_AREA_M2,
  SLIVER_ASPECT,
  WIN_MIN_H,
  WIN_PATTERN_SIZE,
  ROOF_MIN_H,
  ANTENNA_MIN_H,
  ANTENNA_M,
  MAX_RENDER_H,
} from "./wsBuildingLook";
