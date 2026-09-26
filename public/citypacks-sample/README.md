# 🏙 城市包**样本**（真数据裁剪 · 随 PR 走 · ODbL）

> 这个目录只为一件事存在：**让 reviewer 不用下 24 MB 就能看清 `ws-city-pack` 包的形状**
> （条目顺序 / 层目录 / 字段 / 署名）。格式与导出器见 `world_map/CITY-PACK-FORMAT.md`
> 与 `world_map/export_city_pack.py`。

## 里面是什么

| 项 | 值 |
|---|---|
| 包 | `sample-chongqing-core-4cells.zip` |
| 字节数 | **2,179,841 B**（2.08 MiB；解包后 payload 9,783,565 B，压缩到 22.3%） |
| sha256 | `23e2e256fe214a2384d87badad9efa3cae3df71d6653d1fced772c4201d030dc` |
| 格数 | **4**（0.05° 格；各层并集） |
| 要素 | **55,290**（楼房 46,114 / 路网 8,861 / 片区名 59 / 水系绿地 256） |
| 层 | 四层全在：`bldbundle` `roadsbundle` `placesbundle` `gwbundle` |
| 清单 | `cities.json`（同一个导出器产出的 `ws-city-catalog` v1；`baseUrl` / `url` 是**示例占位**） |
| zip 内条目顺序 | `index.json` → `NOTICE.txt` → 四张层索引 → `gw` → `places` → `roads` → `bld`（**顺序是功能**：装到一半时先有"水绿+片区名+路网"，见格式文档 §2.2） |

## 裁剪口径（真数据裁剪，不是编的）

- **源**：运行期的重庆离线包（全量 **372 格 / 736,926 要素**）。
- **口径**：显式 `--bbox 106.50,29.50,106.60,29.60`（**半开矩形**：`106.50 ≤ 西 < 106.60`、`29.50 ≤ 南 < 29.60`）
  ⇒ 落在里面的 4 个格：`106.50000_29.50000_0.05` · `106.50000_29.55000_0.05` ·
  `106.55000_29.50000_0.05` · `106.55000_29.55000_0.05`。
- **位置**：重庆**主城核心**一带，0.10° × 0.10°（≈ 10 km × 11 km，导出器按每度 97 km / 111 km 粗算）。
  包内 `placesbundle/` 里就有这一带的真地名可核：`解放碑`（106.57337, 29.56011）· `一天门社区` ·
  `响水桥社区` · `罗家院社区` · `五里店街道` …
- **与全量的关系**：**4/372 格（1.1%）**、要素 **55,290/736,926（7.5%）** ——
  要素占比高于格占比，是因为主城核心每格的楼比全城平均密得多。
- **格体一个字节都没改**：包内 `<层目录>/<格键>.json` 是从源离线包**逐字节复制**的
  （导出器只打包，不重导、不重画）。`index.json.bboxNote` 如实写着这是"显式 `--bbox` 裁剪"，
  **不是**从数据自动聚类算出来的。

## ⚠️ 它不是"一个城市"

样本只有 4 格 ⇒ 装上它就是"重庆（4 格）"，不是全城。要看格式请读这个 zip；
要跑全城请自己导出（见下）。

## 署名（ODbL 1.0，**不许改**）

数据来自 **Overture Maps Foundation** 与 **OpenStreetMap 贡献者**，许可 **ODbL 1.0**。
包内 `NOTICE.txt` 与 `index.json.attribution` 是**原话**，分发/展示时必须原样带出
（`cities.json.attributionNote` 同义）。

## 自己跑一遍（可复现）

```bash
# ① 重新导出这个样本（同一输入两次导出**逐字节相同**，实测 sha256 一致）
python3 world_map/export_city_pack.py --city chongqing --bbox 106.50,29.50,106.60,29.60 \
    --out <你的产物目录> --out-name sample-chongqing-core-4cells.zip      # 默认 dry_run：只报真字节/真 sha256
python3 world_map/export_city_pack.py --city chongqing --bbox 106.50,29.50,106.60,29.60 \
    --out <你的产物目录> --out-name sample-chongqing-core-4cells.zip --write
# ② 全量包（重庆 24.39 MiB）：去掉 --bbox 与 --out-name 即是
# ③ 想让客户端真读到它：把 zip 与 cities.json 放进一台静态服务器的 `{BASE}/citypacks/`，
#    并用 WS_CITYPACK_BASE_URL=<你的 base> 重新生成清单
#    （否则清单里的 url 还是下面这个示例占位，客户端会去 example.invalid 拿）
```

`cities.json` 里的 `baseUrl` / `cities[].url` 是**示例占位**（`https://example.invalid/lingchat-citypacks`，
RFC 2606 保留域名，永远不会解析成真服务器）：**真源不随 PR 走**，托管位置由维护者或用户自己定 ——
见 `world_map/CITY-PACK-FORMAT.md` 的「托管与自建」一节。
