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
/* 🏙 **小区级 3D 街景装配的真源**（`WS_BLD_VECTOR_MINZOOM` / `bldLayerSpecsFor` / `makeStyle` / `flushBldStore` …）。
   🔴 2026-09-26 补这一行，起因是**一次真机事故**：代拍页要用「楼房矢量层从哪一档开始画」这个数，
   而它住在 `wsDistrictScene` 里，本入口**没导出** ⇒ 页面 `TF.WS_BLD_VECTOR_MINZOOM` 是 `undefined`
   ⇒ 页面**静默退回自己写死的 `minzoom: 14`**（9 处）与挑楼闸门 `12.8`。
   而共享真源已改 11 + 瓦片撤到 z<11 ⇒ **z11~13：瓦片没了、楼也不画 = 整屏空**
   （机主真机截图「12 级」发现；自检 `ws_bld_page_selftest` 的"页面依赖契约"那一条也当场报"缺 WS_BLD_VECTOR_MINZOOM"）。
   ⚠️ 它只 import 同目录兄弟模块（`wsMapTheme`/`wsScene`/`wsBuildingPick`），都已在产物里 ⇒
   这一行是"多一个导出"，不是"多一条依赖链"。 */
export * from "./wsDistrictScene";
/* 🧱 **累积式要素仓库 + 离线路面包**（机主 2026-09-25：「之前的没了…必须保证视野内完整」）：
   `createFeatureStore()` 去重/淘汰/统计 + `roadsBundleCellsForView()` 算"视野需要哪些离线格"。
   ⚠️ 纯逻辑，页面与 App 共用同一份（不许第二套合并/淘汰）。 */
export * from "./wsFeatureStore";
/* 🔌 **离线包管道**（`createBundleFeed` / `bundleCountsLine` / `bundleCellUrl` / `loadBundleIndex` …）：
   **唯一真源**，App 宿主（`WsDistrictMapLibre.vue`）与代拍页都调它 —— 页面里**不许再写第二套**
   "取哪些格 / 索引优先 / 已取·包外·失败怎么数 / 署名从哪来"。
   ⚠️ 页面上一次就是因为没走这里、自己写了一套（`bundleIndexOf`/`splitBundleCells`），
   被 `pr_standard_check.py` 的 C1（单一真源）逮住 —— 别再犯。 */
export * from "./wsOfflineFeed";
/* 🌊🌳 **真水系 / 绿地**（机主选的"自己画"）：`createGwLayer` / `gwVerdictLine` / `gwColorsOf` /
   `applyGwLayers` / `gwPlanForView` —— 取格、归一化、配色、层序、署名、判词的**唯一真源**。
   ⚠️ 页面（`public/ws3dshow.html` 的 `refreshGw()`）与 App 宿主（`WsDistrictMapLibre.vue`）
   共用这一份；页面那一份从内联改成"只接线"就是为了这条（PR 门禁 C1：不许第二份实现）。 */
export * from "./wsGwLayer";
/* 🏷 **地名/楼名标签层**（机主 2026-09-25：「如何实现楼房及区域名字喵」）：分层规则 + 避让 + 优先级 + 只用真名字。
   ⚠️ 纯逻辑；页面只做 DOM 渲染与接线（MapLibre 的 glyphs 文字层在本项目是禁用项）。 */
export * from "./wsLabels";
/* 📋 **超级详细日志上报**（机主 2026-09-25：「在页面做超级详细的日志上报喵」）：
   环形缓冲 + fetch/全局错误自动收 + 截图友好的整份报告 —— 规则只有这一份，页面只接线。 */
export * from "./wsLog";
/* ⏱ **耗时可数口径**（机主 2026-09-26：「现在就是加载慢，且…渲染不全，卡顿喵」）：
   `pmTime/pmSpan/pmMark/pmSnapshot/pmObserveLongTasks` —— 页面与 App 共用同一把尺子
   （时间原点 = `performance.timeOrigin`，与 Resource Timing 的 `startTime` 同量纲，
   所以"首屏 X 秒里 Y 秒花在哪"能直接对上）。页面只接线，**不自己写第二套计时**。 */
export * from "./wsPerfMeter";
export * from "./wsBuildingPick";
/* 🎨🏙 **挑选/冻结编排 + 美术取参**（2026-09-26 抽出的两份新真源，页面与 App 宿主**共用同一份**）：
   · `wsBldPickStore`：`createBldPickStore()` —— 先算 base → **只冻结 base** → 补齐件每帧重算。
     页面原来把这段编排内联在自己身上（`const ckey = …` → `window.__BLD_PICK__`），
     于是 App 宿主拿不到它 ⇒ 机主真机：「**每次滑动建筑都变了**」。
   · `wsArtParams`：`bldArtParamsOf()` / `artRamp` / `outlineWidthAt` / `bldRampColorExpr` /
     `WS_ART_PATCHES` / `WS_BLD_FALLBACK_RAMP` / `WS_BLD_OUTLINE_STOPS` —— 取参（art/look/描边/渐变/
     不透明度/色阶）原来**只长在页面里**（`ws3dshow.html:1314`）⇒ 机主真机：「**不是 art1**」。
   🔴 页面侧新增依赖必须同步进页面的符号清单（`FEED_NEEDED`/`TF_NEEDED`）——
   否则"模块是旧的"只会表现成"这个开关没反应"，而不是报"缺符号"。 */
export * from "./wsBldPickStore";
export * from "./wsArtParams";
/* 🏢 **拆件的 zoom 分档真源**（2026-10-02 机主拍板的 B1）：
   `WS_BLD_DETAIL_ROOF_ZOOM`(14) / `WS_BLD_DETAIL_EQUIP_ZOOM`(16) 两个**固定阈值** +
   `bldTierOfPart`（体块 → 档位）+ `bldDetailTierZoom`（档位 → minzoom，**页面唯一的取数口**）+
   `bldLayerVisibilityAt`（离线判定"某档在某个 zoom 上 visibility=none ⇒ 0 顶点/0 draw call"）。
   ⚠️ 页面只许读，**不许**在自己那边写死 14/16（`?bld=2` 与默认档共用同一份分档）。 */
export * from "./wsBldDetailTiers";
/* 🏙 **双预算挑楼**（2026-10-02 机主拍板的 B2：「每格 4 栋」→ 候选=视野内全部楼，
   预算 = Σ投影 px² + Σ顶点，两个**固定常量**，每次落图重算）：
   `pickBuildingsByBudget` / `WS_BLD_BUDGET_PX2` / `WS_BLD_BUDGET_VERTS` / `bldPxPerMeter` /
   `bldMetersPerCssPixel` / `bldScreenCost` / `bldRingVertices`。
   🔴 `bldPxPerMeter` 是"1 米楼高 = 多少屏幕像素"的**唯一一把尺子**（两页必须同一把，否则同一个机位
   算出来的预算不是一个东西）。 */
export * from "./wsBldBudget";
export * from "./wsBldGl";
export * from "./wsDaily"; // 日常循环（我的家 + 今日三件事）
export * from "./wsNameGen"; // 🏷 生成名层（**示意·非真实**：确定性楼名 + 沿街小摊）
/* 🏷🗺 **名字层**（2026-09-26 机主：「我要求每个显示的楼房都要有名字喵，如果太密集了就根据类型
   划定区域（如经济区，美食区），**每个名字和楼房都能点击查看信息**」）。
   `createNameLayer()` = 取数（真名包 0.05° 格 + 片区包同格键）/ 真名标签（走 `wsLabels.pickLabels`）
   / 区名聚合（走 `wsZoneNames.planZoneNames`）/ 迟滞闸门 / 动效参数 —— **页面与 App 共用同一份**。
   🔴 页面侧**一行规则都不许重写**（PR 门禁 C1）：它只画 DOM（`transform: translate3d`）+ 接事件。 */
export * from "./wsNameLayer";
/* 🗺 区名三源（真名 / 数据驱动 / 示意）+ 判据常量（0.01° 子格 / 够格 5 / 严格过半） */
export * from "./wsZoneNames";
/* 🪪 **信息卡**（点楼体 / 点名字 / 点区名 ⇒ 同一张卡）：卡片字段 + 动效令牌 + 生长原点，
   纯逻辑，页面与 App 的卡片组件共用同一份（`CARD_MOTION` / `cardComposeTransform` / `cardChatText`）。 */
export * from "./wsBuildingCard"; // 场景装配（相机默认值 + 图层序 + 自证） // art=3 天空几何（云/山影/雾带，纯函数） // 层序保证（事后断言式自愈） // 路网：分级样式（roadLayerSpecs）+ 计数（visibleRoadCount / roadStatsLine）
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
