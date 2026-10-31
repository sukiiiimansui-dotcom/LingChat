# ws3d/engine —— 自研 3D 引擎（叠加层）静态资源

本目录是 `world_map/bldpreview/` 里两个页面的**静态副本**，给 App 世界模拟页做
`?engine=1` 实验性叠加层用。**不要在这里直接改代码** —— 改源目录，再按下面的命令整目录同步。

## 来源（真源）

```
~/rikka/Dsh-SYuki/world_map/bldpreview/
  world3d7.html          →  public/ws3d/engine/world3d7.html
  engine_overlay.html    →  public/ws3d/engine/engine_overlay.html
  data/bld.json          →  public/ws3d/engine/data/bld.json
  data/roads.json        →  public/ws3d/engine/data/roads.json
  data/gw.json           →  public/ws3d/engine/data/gw.json
  vendor/three.min.js    →  public/ws3d/engine/vendor/three.min.js
  vendor/maplibre/*.mjs  →  public/ws3d/engine/vendor/maplibre/
```

同步命令（在 `~/lingchat-fork/v052` 下）：

```bash
SRC=~/rikka/Dsh-SYuki/world_map/bldpreview
DST=public/ws3d/engine
mkdir -p "$DST"/data "$DST"/vendor/maplibre
cp -p "$SRC"/world3d7.html "$SRC"/engine_overlay.html "$DST"/
cp -p "$SRC"/data/{bld,roads,gw}.json "$DST"/data/
cp -p "$SRC"/vendor/three.min.js "$DST"/vendor/
cp -p "$SRC"/vendor/maplibre/{maplibre-gl,maplibre-gl-shared,maplibre-gl-worker}.mjs "$DST"/vendor/maplibre/
```

## 体积

| 路径 | 大小 | 说明 |
|---|---:|---|
| `world3d7.html` | 80 KB | 引擎本体（three.js 自研城市） |
| `engine_overlay.html` | 24 KB | MapLibre + iframe 集成 / datum / 相机对齐 / 自检 |
| `data/bld.json` | 1.79 MB | 楼（WGS-84） |
| `data/roads.json` | 634 KB | 路（WGS-84） |
| `data/gw.json` | 65 KB | 水/绿 |
| `vendor/three.min.js` | 649 KB | three.js（裁剪版） |
| `vendor/maplibre/*.mjs` | 1.09 MB | MapLibre 3 个模块（主 / shared / worker） |
| **合计** | **4.3 MB** | 源目录 41 MB 里只带引擎实际读到的文件 |

**没带 `allmodels.json`（7.4 MB）**：`world3d7.html` 本版不加载模型（`?models` 只出现在注释里，
没有 fetch）；叠加层也不开模型，因此不需要。若将来要模型，需要同时带 `allmodels.json` + 模型加载代码。

## 页面参数

`engine_overlay.html`（由 App iframe 载入）：

```
?lon=&lat=        WGS-84 视点（引擎数据坐标系；默认=引擎城市中心 106.5895,29.5855）
&z= &pitch= &bearing=   MapLibre 相机（pitch/bearing 单位度）
&cx= &cz=         引擎本地米坐标的建楼重心（缺省=引擎自己的城市中心）。
                  叠加视点离城市中心 >3.8km 时楼会被距离剔除；App 端按
                  cx=(lon-106.55)*KX、cz=-(lat-29.55)*KZ 传入（KX=111320·cos(29.55°)、KZ=110540）
&engine=0|1       0 = 不加载 3D（只留 MapLibre 底图）
&opacity=1        强制不透明（否则按 zoom 15.2→16.2 淡入）
&hud=0            隐藏页面 HUD
&datum=0|1        GCJ-02→WGS-84 逆变换（默认 1；底图是高德瓦片时必须为 1）
&cam=fit|msg      fit=用引擎相机对齐（默认）；msg=只发 postMessage（降级）
&fx=shadows=0,aces=0   效果开关（默认全开）
&fxover=alpha|opaque|legacy  叠加合成策略（默认 alpha；后两者仅证据对照）
```

`world3d7.html` 可直接打开（`?overlay=1` 为透明叠加模式），但单独打开时没有底图。

## 运行要求

- 必须用 HTTP 提供（页面里 `fetch('./data/*.json')`、`import('./vendor/…')`）；
- 本目录按相对路径组织，**不要改动层级**；
- 无外部依赖（MapLibre / three 都是本地 vendored 文件）。

## 已知限制

- 相机同步：当前 App 端只在**载入时**把 MapLibre 的 center/zoom/pitch/bearing 传给叠加层；
  之后用户拖动底图，叠加层不会逐帧跟随（iframe `pointer-events:none`，手势仍归 App 地图）。
- 建楼重心 `cx/cz` 只在载入时生效，拖出约 3.8 km 后该方向楼会被剔除；
- pitch>0 时像素对齐 >4px（pitch 55° 页面自检 5.89px），pitch=0 时 ≤3.2px；
- 真机 DPR 2/3、连续拖动抖动未验。

## 证据索引

`~/chk/_overlay_align/P1-WORLD3D7.md`（对齐/阴影/ACES 数字与截图）
`~/chk/_overlay_align/P2-APPASSETS.md`（本次搬运的清单与体积）
