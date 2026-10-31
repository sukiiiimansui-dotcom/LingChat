# 地图质量审查（App 侧 · 穿模 / 断片 / 旧模型 / 糊）

> 审查对象：**App 世界模拟页** `/worldsim`（`?engine=0/1`），1500×850 / DPR 1。
> 对照口径：`docs/ART-DIRECTION.md` **§18**（F1 瓦片 / L1–L2 旧层 / C5 双层 / B1–B4 糊 / B5 证据规格）。
> 引擎本体（`world3d7.html`）的画质由 render-engineer 自签，本文只审 **App 侧与叠加层接缝**。
>
> 状态标记：**[已测]** 有数字与图；**[待测]** 尚未取到；**[已修]** 本轮改过并有复测。

---

## 0. 结论速览

| 类别 | 现象 | 根因（定位到层） | 责任文件 | 状态 |
|---|---|---|---|---|
| **旧模型 L1/L2** | 同一栋楼被画两遍：引擎旧体块 + App 资产卡 | **叠加层与 App 自绘 3D 同时在画**（两份建筑数据源） | `WsSceneView.vue` / `WsEngineOverlay.vue` | **[已修]** 叠加层开 → App 3D 暂停并隐藏（见 §2） |
| **断片 F1** | 楼/屋顶整片消失、HUD 报 `source 'bld' not found` | 早先"切后端到 map"把 `bld` 矢量源撤掉，样式里 4 个 `bld-*` 层悬空 | `WsSceneView.vue`（已回退该做法） | **[已修]** 回退 + 保留 bld 源 |
| **穿模 C5** | 近景楼体互穿、贴墙被切 | ① 双层 3D（同上）；② engine 侧 near 面与旧体块尺度 | `WsSceneView.vue` / `wsEngineOverlay.ts` | **[已修]** 单层渲染；近裁剪待 render-engineer 签 |
| **糊 B1/B4** | 整体发糊 | iframe CSS 尺寸 vs 内部 canvas buffer 的放大系数 | `WsEngineOverlay.vue` | **[已测]** 放大系数 **1.000**（≤1.05 达标） |

**一句话**：机主看到的"穿模 + 断片 + 旧模型"是**同一件事的三个说法** —— `?engine=1` 时屏幕上有**两套楼**在画；其中一套（引擎）用的是 10/28 的旧 `bld.json`，所以还额外显得"旧"。

---

## 1. F1 瓦片（404 / 空白 tile）

**[已测] 网络层**
- 采集方式：CDP `Network.enable`，统计 `responseReceived.status ≥ 400` 与 `loadingFailed`。
- 结果（`?engine=1`，1500×850，单次会话）：**404 = 0、loadingFailed = 0**（详见 `~/chk/_engine_app/fin1.log`）。
- **[已测] `?engine=0`**：`netFailures = []`（404=0 / loadingFailed=0），单次会话 ≤200s，1280×720 / DPR1。
（两模式各跑一轮：`~/chk/_engine_app/ev3.log`（engine=1）、`ev4.log`（engine=0）。）

**[已测] 几何层（真正的"断片"来源）**
- 证据：`~/chk/_engine_app/audit/engine1_z17.png` 的 HUD 一次报 **4 条**：
  `layers.bld.ext: source 'bld' not found` / `layers.bld-roof` / `layers.bld-equip` / `layers.bld-line`。
- 含义：样式里仍有这 4 个层，但它们依赖的 `bld` 矢量源没被建立 ⇒ 层静默不画 ⇒ **楼体/屋顶整片缺失**，
  看起来就是"断片"。这不是瓦片没下到，是**源被撤掉**。
- 根因：2026-10-31 我为了让"两套楼"只留一套，把渲染后端强切到 `map`；而 `bld` 源是 **overlay 后端**建的，
  一撤后端源就没了 —— 属于**我的改动制造的问题**，已回退（见 §2）。
- 责任文件：`src/components/views/worldsim/WsSceneView.vue`（后端切换那段）。

**[已测] 瓦片层本身没有失败请求**（两模式都是 0）。真正的"断片"来自**源被撤**（见上），不是瓦片 404。
**[待测]** 空白 tile 判定（≥95% 同色）：需要把 tile 图取回来做像素统计，本轮未做（资源纪律：单次浏览器 ≤300s）。

---

## 2. L1 / L2 旧模型与重复绘制

### 2.1 现在到底有几套楼
| 来源 | 数据 | 谁在画 | 形态 |
|---|---|---|---|
| App 自绘（默认 `overlay` 后端） | MVT 矢量 `bld` + 资产包 | `wsOverlayBackend` / `wsBldAssets` | v1 **Kenney 贴图包**（默认）／v2 Godot／v3 Blender |
| 引擎 iframe（`?engine=1`） | `public/ws3d/engine/data/bld.json`（**2026-10-28**） | `world3d7.html` | 旧体块 + 旧调色 |

⇒ `?engine=1` 时两套**同一机位、同一坐标系**各画一遍 = 穿模/重影的直接来源；引擎那份是旧数据 = "旧模型"。

### 2.2 默认资产版本是旧的（L1 关键）
- `wsBldAssets.ts:47-61`：`?bldassets=1` → v1（Kenney 贴图包）；`2`/`godotbld=1` → v2（Godot）；`3`/`assets=all` → v3（Blender 全量）；**其余 → v1**。
- 也就是说：**不带参数时用的是最早那代 Kenney 资产**，v3（Blender 全量）虽已存在但需要显式带参。
- 责任文件：`src/components/views/worldsim/wsBldAssets.ts`（默认值一行）。
- **[已测]** `map.getStyle().layers`（`?wsdebug=1` → `window.__wsMap`），engine=0 实测 **18 层**：
  `bg, base, tint, road-casing-0..5, road-line-0..5, gw-water, gw-green, ref` —— **`bld-*` 为 0 条**。
  含义：App 的楼不是 MapLibre 图层画的（是 three 叠加层画的），所以样式里本来就没有 `bld-*`；
  早先那 4 条 `source 'bld' not found` 只出现在"后端被切到 map"的那次实验里（已回退）。
  ⚠️ engine=1 那次 dump 返回 `no-map-hook`（URL 少了 `?wsdebug=1`），**未取证**，下轮补。

### 2.3 本轮改了什么（已修）
`WsSceneView.vue`：
- **回退**"切后端到 map"的做法（它会撤掉 `bld` 源 → 断片）。
- 改为：`engineOverlayOn` 为真时 **`active.pause()` + 叠加层宿主 `visibility:hidden`**，
  地图与 `bld` 源原样保留，但 App 那层 3D 不上屏 ⇒ **同一时刻只有一套楼**，也不多烧一份 GPU。
- `?engine=0` 时一行都不执行（行为与接入前一致）。

---

## 3. C5 双层地面 / 天空

- 引擎页在叠加模式下用 `?overlay=1` 且**不画天空/地面**（画布 `alpha=0`，clear 颜色 alpha 0）。
- **[已测]** `engine_overlay.html` 的 `base=0`：不建 `bg` / `amap` 两个图层、容器与 body 透明 ⇒ 叠加层不会带自己的底图上来。
- **[已测]** `?engine=0` 与 `?engine=1` 同机位逐像素差：**48.6% 像素有差**、平均绝对差 50.3
  （`~/chk/_engine_app/final/engine0_default_off.png` vs `engine1_overlay_on.png`）。
  该差分里**没有**第二层地面/天空（engine 侧已透明），差异全部来自建筑体块。
- **[已测] 单层证据（engine=1，1280×720）**：
`overlayHost = {vis:"hidden", canv:1}` ⇒ App 自绘 3D 宿主已隐藏；`iframe css 1280×720 / buffer 1280×720` ⇒ 缩放 1.000。
**[待测]** 同一机位、同 zoom 的严格 A/B（现有 engine=0 的三张因缩放手势没生效而近乎同图，**不作为 A/B 证据**）。

---

## 4. B1 / B4 糊（放大系数）

**[已测]** 叠加层 iframe：
| 项 | 值 |
|---|---|
| iframe CSS 尺寸 | 1500×850（复测 1280×720） |
| iframe 内 canvas buffer | 1500×850（复测 1280×720） |
| **放大系数（buffer / CSS）** | **1.000**（阈值 ≤1.05 ✅） |
| 页面 DPR | 1（浏览器 `deviceScaleFactor=1`） |

- 结论：**糊不是 iframe 缩放造成的**（这一层是 1:1）。
- 待查的其它可能：① 底图瓦片本身的清晰度（Esri 栅格）；② 引擎内 `dpr=min(devicePixelRatio,2)` 在真机 DPR>1 时是否真的生效；③ Bloom/雾。
- 责任文件：`WsEngineOverlay.vue`（无问题）/ 引擎侧 `world3d7.html`（render-engineer 签）。

---

## 5. 阶段③ 相机同步（已实现 + 已量）

**实现**
- 宿主（`WsSceneView.vue`）：`requestAnimationFrame` 每帧读地图真源
  `getCenter()/getZoom()/getPitch()/getBearing()` → `pushEngineHostView()`。
- 节流：**≤30Hz**（`MIN_PUSH_INTERVAL_MS = 1000/30`），且**视图没变就不发**（去重）。
- 引擎页（`engine_overlay.html`）：`w3d:hostview` 消息 → `map.jumpTo(...)`；再做一层去重（`HOST_SKIPS`）。
  **引擎零自积分**：位置只来自宿主消息或用户手势。
- 坐标系：App 底图是 **Esri/WGS-84**，引擎页默认底图是高德/GCJ-02 ⇒ iframe URL 带 **`datum=0`**，
  消息里也声明 `datum:'wgs'`，引擎页据此**跳过 gcj2wgs**（否则多扣 ~354m ≈ 400px）。

**测量（引擎页自带 `selfCheck()`：同一屏幕像素 → unproject → 引擎投影 → 比差）**
| 视口 | zoom | max\|dx\| | max\|dy\| | max r | 判定（≤4px） |
|---|---|---|---|---|---|
| 1280×720 | **16.041** | **2.03 px** | **3.30 px** | **3.87 px** | ✅ 通过 |
| 1500×850 | 16.041 | 2.39 px | 3.87 px | 4.55 px | ⚠ 半径超 0.55px（分轴仍 ≤4） |

- 宿主推送计数：**872 帧**（`frames[0].__ov.hostViews`），证明不是"只在开图时发一次"。
- 残余误差与 **zoom 无关**（16.04 与 16.4 下 dy 都是 3.3–3.9px）⇒ 不是比例尺问题，是引擎世界
  `KZ=110540` 与 Mercator 之间 **0.71%** 的口径差 + 一点点旋转/剪切；对 1500×850 影响略大于 1280×720。
- 证据图：`~/chk/_engine_app/aligned_1280x720_final.png`（引擎 3D 与瓦片同视野）。

---

## 6. 修复清单（按体验影响排序）

| # | 问题 | 修法 | 状态 |
|---|---|---|---|
| 1 | 两套楼重叠（穿模/旧模型） | `engine=1` 时 App 3D `pause()` + 宿主 `visibility:hidden` | **[已修]** |
| 2 | `bld` 源被撤导致 4 层悬空（断片） | 回退"切后端到 map" | **[已修]** |
| 3 | 引擎用的是 10/28 旧 `bld.json` | 引擎数据更新（**render-engineer**） | 待他签 |
| 4 | 默认资产是 v1 Kenney（旧模型） | 默认切 v3（Blender 全量）或按 LOD 混用 | 待产品裁决（改一行 + 回归） |
| 5 | 1500×850 下 max r 4.55px | 引擎世界 KZ 对齐 Mercator（engine 侧） | 待 render-engineer |
| 6 | 瓦片清晰度 / Bloom 雾 | 逐层 A/B（B1 后续） | 待测 |

---

## 7. 取证文件清单

- 阶段②（叠加层可见性）：`~/chk/_engine_app/final/engine0_default_off.png`、`engine1_overlay_on.png`
- 审计（3 zoom × 2 模式）：`~/chk/_engine_app/audit/engine{0,1}_z{17,16,15}.png`
- 阶段③（对齐）：`~/chk/_engine_app/aligned_1280x720_final.png`、日志 `al3/al4.log`
- 构建：`~/chk/_engine_app/build*.log`、typecheck `tsc*.log`
- 复现：`bash ~/chk/ws-lock.sh bash ~/chk/_engine_app/run_probe_align.sh alN`（单次 ≤300s，收尾 `kill_tag.sh`）

---

## 8. 没验 / 没做的（照实写）

1. **空白 tile 像素统计**未做（≥95% 同色判定需要把 tile 下载回来算）。
2. **`map.getStyle().layers` 全量 dump** 未跑出结果（`?wsdebug=1` 的口子已加，dist 尚未重建）。
3. **C5 的严格同机位 A/B** 未做（现有两张机位不同，只能用像素差分 + 覆盖层检查间接判定）。
4. **真机**（Tauri/Android，DPR>1）未验；本轮所有数字都是 Chromium + virgl、DPR=1。
5. 帧率：页面 rAF 在叠加层开时约 **15fps @1500×850**（引擎自报 21.9fps），低于 task-7 的 18fps 线；
   去重优化已加（`HOST_SKIPS` / `lastSent`），**尚未复测**。

---

## 9. 2026-10-31 追加：单一所有权 + 默认资产升 v3（lead 复核后）

### 9.1 单一所有权（已修）
`WsSceneView.vue`：
- `engineOverlayOn` 为真 ⇒ ① App 自绘 3D 后端 `pause()`；② 宿主 `.ws-sceneview__overlay` 绑 `visibility:hidden`；
  ③ 样式里 `bld-ext / bld-roof / bld-equip / bld-line / bld-foot / bld` 六层 `setLayoutProperty('visibility','none')`。
- **隐藏的只有"楼"**：底图、道路、水系、绿植、标注一律不动 —— 地图本体仍在下层，**不是把地图藏了**（复核口径）。
- **已知取舍**：引擎只画它数据范围内的楼（约 2km 级），范围外没有 3D 体块，由底图 + 雾/远景兜底。
- 复测：engine=1 下 `overlayHost.vis = "hidden"`，`[data-ws-engine] iframe` 在，canvas 数 1（App 侧）。

### 9.2 默认资产升 v3（已改）
`wsBldAssets.ts::bldAssetVersion()` 默认从 `1` 改为 `3`（Blender 全量包 `public/ws3d/bldassets_all/`，
`pack.json` 42KB + `pack.bin` 2.27MB，均已存在）；回退口保留 `?bldassets=1`（Kenney）/ `?bldassets=2`（Godot）。
- **[待测]** v3 在页面上的实际表现（是否 404、是否报错）—— 本轮浏览器被 guard 在 40s 处回收，
  只拿到 engine=1 的三张图与数值，**v3 的渲染结果未验**；若下轮发现异常立即回退并在本节写明原因。

### 9.3 本轮实测汇总（1280×720 / DPR1）
| 项 | engine=0 | engine=1 |
|---|---|---|
| 网络失败（404 + loadingFailed） | **0** | **0** |
| 可见层数 `getStyle().layers` | 18（`bld-*` 0 条） | 未取到（URL 缺 `?wsdebug=1`） |
| iframe 放大系数 | — | **1.000** |
| App 3D 宿主 | `visible`（正常） | **`hidden`**（单一所有权） |
| 证据图 | `audit3/ev_engine0_z{17,16,15}.png` | `audit3/ev_engine1_z{17,16,15}.png` |

---

## 10. 2026-10-31 17:0x 补测（脱离进程组启动浏览器后）

用 `bash ~/chk/bg-browser.sh <tag> <port> <url>` 启动（否则工具调用结束即 SIGTERM 整个进程组，
浏览器 40s 被杀 —— 与 `browser-guard` 无关，guard 上限 1/300s 照旧）。

### 10.1 `getStyle().layers`（`?wsdebug=1` → `window.__wsMap`）
| 模式 | 层数 | 层 id |
|---|---|---|
| engine=0 | **16** | `bg, base, tint, road-casing-0..5, road-line-0..5, ref` —— **`bld-*` 0 条** |
| engine=1 | 5（**取样过早**：地图仍在初始化，非"被隐藏"） | `bg, base, tint, road-casing-0, ref` |

- **L1 结论**：样式里**没有** `bld-*` 层，App 的楼不是 MapLibre 图层画的（是 three 叠加层）⇒
  "旧层"问题不在样式层，而在**两套 3D 同时上屏**（已用 pause + hidden + 六层 visibility 处理）。
- engine=1 的 5 条是**时序问题**：dump 发生在 `bld` 矢量源建立之前。下轮应在 `scene-ready` 之后再取。

### 10.2 A/B 缩放（`map.jumpTo` 注入，替代滚轮）
| 模式 | z17 | z16 | z15 | 证据 |
|---|---|---|---|---|
| engine=0 | ✅ 404KB | ✅ 528KB | ✅ 532KB | `audit4/ab_engine0_z{17,16,15}.png` |
| engine=1 | ✅ 456KB（引擎侧 zoom=17） | ✅ 649KB（16） | ✅ 549KB（15） | `audit4/ab_engine1_z{17,16,15}.png` |

- 用 `window.__wsMap.jumpTo({center, zoom})` 注入，**三张确实不同 zoom**（引擎侧读到 17/16/15）。
- engine=1 的宿主 3D：`overlayVis = "hidden"`、iframe `css 1280×720 = buffer 1280×720`、**scale 1.000** ✅

### 10.3 资产包（v3 默认）——**未生效，待查**
- `performance.getEntriesByType('resource')` 里 **`bldassets` 相关请求 = 0 条**（两模式都是）。
- 含义：当前页面**根本没有拉资产包**（v1 Kenney / v3 Blender 都没拉）⇒ "默认升 v3" 目前
  **是个无效改动**；楼的呈现来自其它路径（MVT 体块/程序化）。
- 下轮要查：资产层是否被 `?assets=all` 之外的开关门控、还是被 LOD 阈值挡在 T2（不加载）。

### 10.4 网络失败（**新发现，未定位 URL**）
本轮捕获到 3 条失败：`net::ERR_NAME_NOT_RESOLVED` ×1、`net::ERR_CONNECTION_REFUSED` ×2。
- 探针这一版只记了错误文本、**没记 URL** ⇒ 不能指认是瓦片、API 还是引擎资源。
- 下轮把 `Network.loadingFailed` 的 `requestId → requestWillBeSent.url` 关联起来再报。

---

## 11. 2026-10-31 17:1x 资产层门控与失败 URL（定论）

### 11.1 门控（lead 指出的 `assetOn`）
- 实测 `navigator.maxTouchPoints = **20**` ⇒ `assetOn = false`（触屏默认关）⇒ **默认模式 `bldassets` 请求 0 条**。
- 带 **`?bldassets=3&assets=all`**：`bldassets_all/pack.json` + `pack.bin` **各 1 条、无 404**（`audit5/summary.json`）。
- **但两张图（默认 vs v3）里都没有可见的 3D 楼**：HUD 显示 `真楼 0 栋…`，说明这个 preview 环境里
  **楼根本没有数据可画**（离线楼包为空，HUD 也提示"要现场取数加 `?live=1`"）⇒
  **"v3 是否可见"在本机无法判定**，不能据此把触屏默认打开。
- 结论：**本轮不改触屏默认**（保持 `assetOn` 由 `?bldassets=` 显式打开），
  只在文档记录：资产层在触屏默认关 → 真机上楼是程序化盒子 → 这正是机主说的"旧模型"。

### 11.2 两条失败 URL（已定位，一条已修）
| URL | 错误 | 判定 | 处置 |
|---|---|---|---|
| `http://127.0.0.1:8795/__wslog?tag=fps&…`（×2） | `ERR_CONNECTION_REFUSED` | FPS 探针 beacon 指向"本机量具服务"，普通会话必然拒绝 | **已修**：`wsFpsProbe.ts::beacon()` 现在只有 `?fpslog=1` 才发（见 §11.3） |
| `https://example.invalid/lingchat-citypacks/citypacks/cities.json` | `ERR_NAME_NOT_RESOLVED` | 城市包默认基址是**占位域名**（`wsCityStore.ts:75`），未配置时必然 DNS 失败 | **未修**（需产品给真实基址，或改成"未配置就不请求"；属引导页行为，待裁决） |

### 11.3 已修：FPS beacon 默认不发（`wsFpsProbe.ts`）
- 以前：每次会话都往 `127.0.0.1:8795` 发 `<img>`，没服务就 2 条 `CONNECTION_REFUSED`，
  混进"瓦片 404 统计"里，**本轮 §10.4 就是被它带偏的**。
- 现在：`?fpslog=1` 才发；不带参数零请求。

### 11.4 仍未验
- v3 在**有楼数据**的环境（`?live=1` 或真机）下是否可见、是否有当年 Mali 不可见的问题 —— 本机无法判定。
- 城市包占位域名的处置（要不要改成静默跳过）。

---

## 12. 2026-10-31 17:2x–17:4x：用 `?citybase=` 在本地验 v3（结论：仍然判不了）

### 12.1 本地城市包链路**是通的**
`http://127.0.0.1:4173/worldsim?citybase=http://127.0.0.1:4173&asseton=touch&bldassets=3&dpr=1`

| 请求 | 状态 |
|---|---|
| `/citypacks/cities.json` | **200**（2,010 B，列出「重庆 · 默认 · 包 24 MB · 372 格」） |
| `/ws3d/bldassets_all/pack.json` | **200** |
| `/ws3d/bldassets_all/pack.bin` | **200** |
| 网络失败（排除占位域名） | **0** |

⇒ 城市包与资产包**都取得到**，占位域名也已不再被请求（§11.2 的修法在带 `?citybase=` 时同样生效）。

### 12.2 但**楼仍然一栋都不画**
- 点「下载并进入」后连等 **144 s**，HUD 一直是 **`真楼 0 栋`**；
- 同一会话里 `?bldassets=3` 的 `pack.json/bin` 已 200（包是好的），可 `真楼` 仍是 0；
- 也就是说：**"v3 资产层不可见"与"根本没有楼数据"这两件事在本机分不开** —— 楼那一层从源头就是 0 栋。

### 12.3 判定（按 lead 的分支）
- **不能**据此翻触屏默认（lead 已定：默认保持现状，触屏关）；
- 也**不能**写"触屏不可见 bug 在 virgl 下复现"—— 因为本机连程序化盒子都没有楼，无法把现象归因到资产层；
- 正确写法：**本机 preview 环境楼数据为 0（即使装入城市包、等待 144s），v3 可见性只能真机验。**

### 12.4 已实现的灰度（默认不生效，等真机确认）
`wsOverlayBackend.ts`：
- 新增开关 **`?asseton=touch`**：触屏也把资产层打开（内部走 v3）；
- 建层后 **2 s 自检**：`assetDrawnTris / assetDrawCalls` 都为 0 ⇒ 判定"不可见"，
  **自动 `disposeAssets()` 回退程序化盒子**，并把原因写进 diag 的 `assetProbe` 字段：
  - 通过：`asseton=touch 自检通过（tris N / draws M）`
  - 失败：`asseton=touch 自检失败：2s 内资产层 0 tris / 0 draws ⇒ 判定不可见，已回退程序化盒子`
- 默认值**未翻**（触屏仍关）；手机验证 URL（真机可点）：
  `http://<手机可达的地址>/worldsim?asseton=touch`

### 12.5 城市包占位域名（已修）
`wsCityStore.ts::readList()`：`from === "default"` 且基址等于占位常量时**直接短路**，
返回 `{ state:"unknown", why:"未配置城市包下载源（已跳过请求）…" }`，**不发网络请求、不报错**。

---

## 13. 2026-10-31 17:4x：`真楼 0 栋` 的源头（**修正 §12 的"没有数据"结论**）

### 13.1 数据链路是通的（网络实测）
| 请求 | 结果 |
|---|---|
| `/bldbundle/index.json` | **200** |
| `/bldbundle/106.56000_29.55000_0.01.json` 等 **5 格** | **全部 200** |
| `/roadsbundle/*` | 2 条 200 |
| 网络失败 | **0** |

- 相机默认 `106.5895/29.5855` 落在离线包内：`0.05°` 口径命中 `106.55000_29.55000_0.05.json`，
  `0.01°` 口径命中 `106.56000_29.55000_0.01.json`（两套口径的键格式都已核对：
  `${w.toFixed(5)}_${s.toFixed(5)}_${size}.json`，与包内文件名一致）。

### 13.2 所以 `真楼 0 栋` **不是"没有楼数据"**
数据取到了、格也命中了，但 HUD 计数仍是 0 ⇒ 问题在**计数/上屏那一步**：
- `真楼` 的**唯一真源**是 `wsHudStats.ts` 里的 `stats.count`，注释写明它"由 `classify`/`dressBld` 写"；
- 本轮在 `wsDistrictScene.ts` 里**没 grep 到** `stats.count` 的赋值点 ⇒ 下一步应直接定位 `classify`/`dressBld`
  所在文件，看它在**什么视野档**才累加（HUD 自己有"全区视野 / 街区视野（放大后才取楼栋）"两档）。

### 13.3 城市包装了也不喂地图（代码级铁证）
- `wsCityStore.readCell()` 在 `src/` 里 **零消费者**（`grep -rn "readCell" src/` 只命中定义与门面自身）。
- ⇒ 点「下载并进入」把格装进 IndexedDB 后，**地图取数路径根本不读它**；楼的来源是
  `/bldbundle` + `/roadsbundle`（静态离线包）+ `?live=1`（Overpass，现场取数）。
- 这也解释了 §12.2「装包并等 144 s 仍 0 栋」：**装包与上屏是两条互不相通的路**。

### 13.4 对"v3 可见性"的影响
结论不变（本机判不了），但原因更精确了：**不是没有数据，而是楼没有上屏/没有计数**。
要本地验 v3，先得让楼真的画出来（定位 §13.2 的计数条件，或切到街区视野/开对应开关）。

### 13.5 纪律记录
本轮误用了一次 `pkill -9 -f profile_xxx`，**把自己的 shell 也杀了**（本项目已知坑，`pkill -f` 会匹配自身命令行）。
之后只走 `kill_tag.sh` + `browser-guard --status`，收尾 `browsers=0`。

---

## 14. 2026-10-31 18:0x：默认 zoom 下**到底有没有楼**？（纯读代码 + 上一轮实测）

### 14.1 结论（先给答案）
**默认机位（zoom ≈16.4）在本机实测：没有楼 —— 画面里没有 3D 体块，HUD 同时报 `真楼 0 栋`。**
不是"只错在 HUD 数字"：`stats.count` 与"画出去的那一批"是**同一份要素**（同一处 `dressBld` 返回给 `setData`），
计数为 0 说明那一次落图的要素集就是空的 ⇒ **计数与绘制同时为 0**，属"这一轮没落图/落了空图"，不是纯计数 bug。

### 14.2 `stats.count` 的唯一写入点
| 位置 | 说明 |
|---|---|
| `wsFallback2d.ts:159 / 170` | `dressBld()` 内：`stats.count = counts.n`（`dressBase` / `decorateBuildings` 的返回） |
| `wsFallback2d.ts:133` | `classify()` 里 `stats.count = features.length`（另一条口径） |
| 调用方 | `wsBldLanding.ts:417`：`dress: (feats) => dressBld({features: feats}, map)` —— **落图（flush）时**才调用 |

⇒ 只要"落图"这一轮拿到的 `feats` 为空，`count` 就必然是 0，HUD 与画面同时空。

### 14.3 落图的触发条件（关键）
`bldFlush(why)` 只在下列时机跑（`wsBldLanding.ts:391` 及其调用点）：
- `moveend` / `zoomend` 的 **600ms 去抖**；
- 用户点选（`bldFlush("bldmode")` / `bldFlush("bldtier")` / `bldHeal(...)`）；
- **取数完成（`fetchCell` 的 Promise resolve）没有接任何落图触发**（grep 全文件无此路径）。

⇒ 典型失败序列：**初始 `moveend` 先到 → 落图时仓库还空 → `count=0`、无楼**；随后格子 200 到达、进仓库，
但**只要用户不再挪地图/缩放**，就没有第二次落图 ⇒ 一直是 0。这与实测完全吻合（5 个格 200、`真楼 0`、画面无楼）。

### 14.4 还要注意的一层
`wsBldLanding.ts:423` 的 `specs`：
```ts
specs: () => ((overlayDrawsBuildingsNow() && !forceMapBuild) ? [] : bldSpecsNow())
```
默认后端是 `overlay`（three 画楼）⇒ **MapLibre 那 6 个 `bld-*` 层根本不建**（所以 §10.1 的 16 层里没有 `bld-*`，属正常），
"有没有楼"只能看 three 那层 ⇒ 用截图/HUD 判是唯一的路。

### 14.5 最小修复建议（**未实现**，等拍板）
| # | 方案 | 改动量 | 风险 | 评价 |
|---|---|---|---|---|
| ① | **取数完成 → 去抖触发一次 `bldFlush("cells-arrived")`**（在 feed 的 drop/refresh 回调里） | 几行 | 低（幂等、去抖） | **首选**：同时修好"画面没楼"与"count=0" |
| ② | 首次进入时在 `data ready` 后强制 flush 一次 | 几行 | 低 | 与①重叠，可合并 |
| ③ | 把"街区视野"阈值调低到默认 zoom | 改常量 | 中（影响取数量/帧率） | 不推荐，治标 |
| ④ | 给 `citypack` 接一个消费者（`readCell` 目前零消费者） | 大 | 高 | **只记录，产品决定是否接线** |

### 14.6 城市包死路（补充）
`wsCityStore.readCell()` 在 `src/` 里**零消费者** ⇒ 下载城市包这条路**当前完全不喂地图**（dead path）。
产品需要决定：要么接线（把 `readCell` 接到离线 feed 的 `fetchCell`），要么在 UI 上明确它只是"预下载"而非"取数来源"。

---

## 15. 2026-10-31 18:1x：真因收口（**MVT 分支吃掉了 dress**）

### 15.1 现场数字（`?wsdebug=1`，冷加载不交互，1280×720）
```
flush: {"c":3, "why":"move+0", "n":0, "feedN":283, "got":283}
dress: null            ← dressBld **一次都没被调用**
```
- 离线 feed **本身是好的**：`n=283` 栋、`have=4` 格、`got=283`、`failed=0`、索引 7,676 格已读；
- 但 `bldFlush` 跑了 3 次，`stats.count` 始终 0，且 `dressBld` 从未执行。

### 15.2 原因：`flushBldStore` 的 MVT 分支
`wsDistrictScene.ts:804-824`：
```ts
const mvt = opts.mvt ? opts.mvt() : null;
if (mvt) {                      // ← 瓦片路
  const raw = opts.features();
  ...
  applyMvtTo(mm, mvt.template, art);
  return;                       // **不 pick、不 dress、不 setData**
}
/* GeoJSON 兜底路（?mvt=0）才走 pick + dress */
```
- ⇒ 一旦 `mvt` 为真：**`dress` 不跑 ⇒ `stats.count` 永远 0**（HUD 恒 `真楼 0 栋`），
  楼完全交给矢量瓦片源；
- 本机 preview 里**矢量瓦片源没有数据**（`?mvt` 默认开、`public/` 下没有 mvt 瓦片目录）⇒ **画面也没有楼**。
- 这两件事同时成立，正好等于机主看到的"没楼 + 数字 0"。

### 15.3 与文档里那条护栏的矛盾（要修的点）
`wsMvtTiles.ts:31-38` 写着"**overlay 开着就不启用 MVT**"（护栏），但现场证据显示
`flushBldStore` 确实进了 MVT 分支（`dress` 未调用）⇒ **护栏没有覆盖到 `opts.mvt()` 这条取值路径**，
或该护栏只在某条初始化路上生效。责任文件：`wsBldLanding.ts`（`mvt:` 取值）+ `wsMvtTiles.ts`（护栏）。

### 15.4 已做但**不足以修复**的改动
- `wsBldLanding.ts`：给 feed 的 `flush` 加了 **150ms 去抖合并**（取数到货也触发落图）+ `__wsBldFlush` 探针；
- 该改动本身正确、可留（幂等、并发安全），但它只解决"落图时机"，**解决不了"MVT 分支跳过 dress"**。
- 另加了 `__wsBldDress` 探针（记录进 dress 的栋数 / 仓库栋数 / why）—— 就是它证明了 `dress` 根本没被调用。

### 15.5 下一步（最小修复，待拍板）
1. **让 MVT 分支也更新 `stats.count`**（从 `raw.length` 写），HUD 立刻不再骗人；
2. **把 overlay×MVT 护栏真正落到 `opts.mvt()` 取值处**（overlay 后端 ⇒ 返回 null ⇒ 回到 GeoJSON 路 ⇒ dress 跑、count 正常）；
3. 本机没有 MVT 瓦片源 ⇒ preview 永远看不到"MVT 路的楼"；要本地验证得 `?mvt=0` 走 GeoJSON 路（那是 dress 生效的路）。

---

## 16. 2026-10-31 18:2x：修复落地 + 复测（**默认加载有楼了**）

### 16.1 改了什么（只动 `wsBldLanding.ts`）
1. **overlay×MVT 护栏落到取值处**：`mvt:` getter 在 `rendererLive === "overlay"` 时返回 `null`
   ⇒ 自动落 GeoJSON 路 ⇒ `dress` 跑、count 正常；**overlay 关时照旧返回模板**（原路径不变）；
   `?mvt=1` 仍强制覆盖（取证用），并在 `?wsdebug=1` 下写一行 `__wsBldMvtNote`
   （"强制 MVT：dress 不跑，stats.count 用 raw.length"）。
2. **计数兜底**：合并进已有的 `beforeDraw`（两条路都会调的那一拍），
   按"真正要画的要素数"写 `stats.count` —— 幂等，数字没变就不赋值。

### 16.2 复测（冷加载、**不做任何交互**、1280×720/DPR1）
```
dress : {"n":57, "storeN":283, "why":"move+0"}     ← dress **跑了**（修复前是 null）
flush : {"c":3, "n":254, "feedN":283}              ← countBld **254**（修复前 0）
HUD   : 254 栋（真高 11 · 层数 6 · 按类型估 40）
fps   : 29.9（页面 rAF）
画面  : **有 3D 楼**（截图见下）
```

### 16.3 证据
- `~/chk/_engine_app/audit9/default.png`（1280×720，engine=0，冷加载不交互，**画面有楼**）
- 对照：修复前 `~/chk/_engine_app/audit8/flush_engine0.png`（同类机位，画面无楼、`真楼 0`）

### 16.4 说明（口径）
- 默认（overlay 后端）现在**走 GeoJSON 路**，等价于 `?mvt=0` 的取数/上妆语义；
  这是护栏的直接后果，不是"把 MVT 关掉"。
- 落图次数 **3 次**（冷加载期间），没有出现"连续落图抖动"。
- `?mvt=1` 强制瓦片路时 `dress` 依旧不跑（设计如此），HUD 数字改为 `raw.length`，并留 diag 说明。
