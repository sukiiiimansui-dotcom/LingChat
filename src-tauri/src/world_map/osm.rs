//! osm.rs — 从 OpenStreetMap(Overpass) 拉取真实建筑/道路/设施（移植自 Python `osm_fetch.py`）
//!
//! 为什么需要它：小区/区县地图由 LLM 虚构生成，但纯虚构会「不像那个地方」。
//! 拉一份该坐标周边的真实 OSM 摘要塞进 prompt，AI 画出来的街廓就带上了当地特征
//! （南方骑楼密度、北方院子尺度、有没有水系），这是「LLM 虚构 + 真实地理参考」的核心。
//!
//! 为什么必须缓存：
//!   · Overpass 公共端点一次查询要 ~19 秒，还会 502/限流；
//!   · 而「同一个小区」在地图里会被反复打开 → 按 ~200m 网格做缓存键，同格复用。
//! 为什么多端点回退：三个公共镜像轮流试，全失败就返回 None，
//!   调用方降级为「纯 LLM 生成」——地图功能绝不能因为外部服务挂了就整条链路失败。
//!
//! 与 Python 的对应关系：`_grid_key` → [`grid_key`]、`_query` → [`overpass_query`]、
//! `fetch_area` → [`fetch_area`]、`summarize` → [`summarize`]、`describe_for_llm` → [`describe_for_llm`]。
//! 摘要的 JSON 结构必须与 Python 完全一致，因为 `sketch::OsmHint::from_summary` 直接消费它。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 公共 Overpass 端点，按顺序回退（前一个失败才试下一个）。
///
/// ## ⚠️ 加端点前必读：**公共镜像的覆盖范围不一样**
///
/// Overpass 有一堆公共镜像，但**不是每个都装全球数据**。有的只装某个国家/地区
/// （典型：`overpass.osm.ch` 只装瑞士）。这类"局部镜像"对中国的表现是：
///
/// ```text
/// HTTP 200  {"version":0.6, ..., "elements": []}     ← 1 秒就返回，看起来很"成功"
/// ```
///
/// 而本文件的回退循环只判 `elements` **字段在不在**（`if j.get("elements").is_none() { continue; }`），
/// 所以这份空结果会被**当成最终答案**、后续端点根本没机会跑。
/// **这比"请求失败"危险得多**：失败会 `continue` 去试下一个，返回空则会被当成
/// 「这里真的没有水系/建筑」，一路静默传到 LLM 提示词里，谁也不报错。
///
/// ⇒ **只加"全球覆盖"的端点**；拿不准就先按下面那套实测方法验一遍。
///
/// ## 实测方法（2026-09-13 用的就是这套）
///
/// ⚠️ **必须用调用方的真实参数**测。`world_map_osm_summary` 的默认半径是 **300m**，
/// 子句是 `DEFAULT_KINDS` 的 5 类 × (way+node) = 10 个。
/// 用 3000m 测会得到完全不同的结论（那规模在 `.de` 上要跑 180s+、在 `maps.mail.ru` 上直接 504），
/// 容易误判成"端点都坏了"。
///
/// 最省事的办法：**用代码自己生成的查询**去打，别手写 ——
/// ```bash
/// # 临时 bin：打印 overpass_query(23.129,113.264,300.0,&DEFAULT_KINDS)
/// curl -s --max-time 30 -A 'LSYuki-maps/1.0' \
///      -H 'Content-Type: application/x-www-form-urlencoded' \
///      --data-urlencode "data=$Q" <端点> | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["elements"]))'
/// ```
/// 广州越秀 300m 的正确答案是 **326 个要素**。返回 0 = 该端点没有中国数据，**别加**。
/// 顺带：`overpass-api.de` 的 `/api/status` 通 **不代表** interpreter 能用（实测会 504）。
///
/// ## 当前三个（2026-09-13 本机实测，**真实参数**：广州越秀 300m / 10 子句）
///
/// | 端点 | 实测 | 适用 |
/// |---|---|---|
/// | `maps.mail.ru` | **200 / 5.7s / 326 要素** | 全球。**当前最快最稳**，放第一 |
/// | `overpass-api.de` | **200 / 3.3~10.3s / 326 要素**，但同日另有连续 504 | 官方，全球。**会抖**，所以不再放第一 |
/// | `overpass.private.coffee` | 200 / **29.2s** / 316 要素 | 全球，**慢**（超过调用方 25s 超时），仅作最后兜底；数据快照略旧 |
///
/// ## 已移除的两个（**勿加回**，都是实测踩过的）
///
/// · `overpass.kumi.systems` —— **已死**：多次探测全部 `000`（连接都建不起来），
///   是 `osm.rs` 原来的第 2 端点。加回它只会白白多等一次超时。
/// · `overpass.osm.ch` —— **只覆盖瑞士**：广州返回 `200 / 1.9s / {"elements":[]}`
///   （同一查询 `overpass-api.de` 返回 326 个），苏黎世则返回 428 个。
///   即上面说的"静默返回空"，是原来的第 3 端点 —— **这次修的就是它**。
pub const ENDPOINTS: [&str; 3] = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

/// 摘要里要分桶统计的 5 类标签（顺序即 Python 里的出现顺序）
pub const BUCKET_KEYS: [&str; 5] = ["building", "highway", "amenity", "leisure", "landuse"];

/// 默认关心这 5 类标签（建筑/道路/设施/休闲/用地）
pub const DEFAULT_KINDS: [&str; 5] = ["building", "highway", "amenity", "leisure", "landuse"];

// ── 真实楼房（2.5D 挤出的输入）──────────────────────────────────────────
//
// 上面那套「按种类取」的查询**拿不到楼高**（`out center tags` 只给中心点，
// 连轮廓都没有），所以楼房要单开一条查询：`out geom` 拿整条 way 的几何。

/// `building:levels` → 米 的层高。**这是 OSM 的通用约定值**，不是我们编的：
/// OSM wiki 明确写 "building:levels … 3 metres per level" 是缺省换算。
pub const LEVEL_METERS: f64 = 3.0;

/// 既无高度也无层数时的默认楼高（米）。
///
/// ⚠️ **这个值必须随数据一起返回给前端**（`stats.default_height_m`）——
/// 让前端自己写一个 8 就会两边不一致，"哪些楼是猜的"也就说不清了。
pub const DEFAULT_HEIGHT_M: f64 = 8.0;

/// 楼高上限（米）。OSM 里偶见明显错值（民房上写 `levels=100`）。
/// 不夹的话，一台相机被一栋 300 米的"民房"顶穿是很难查的现场。
pub const MAX_HEIGHT_M: f64 = 500.0;

/// 建筑缓存键前缀。
///
/// 🔴 **必须与摘要缓存分开**：两者用的是同一个 200m 网格 `grid_key`，
/// 若共用文件名，`fetch_area`（按种类取）与 `fetch_buildings`（取轮廓）
/// 会**互相覆盖同一份缓存** —— 表现为"楼房时有时无、摘要里出现 geometry 字段"，
/// 而且两份数据都"看起来是对的"，极难定位。加前缀后键空间互不相交。
pub const BUILDINGS_KEY_PREFIX: &str = "bldg_";

/// 缓存网格边长：0.002° ≈ 200m。同一个小区反复打开时命中同一份缓存。
const GRID: f64 = 0.002;

/// Python 的 `round()` 是「四舍六入五取偶」，Rust 的 `f64::round()` 是「五入」。
/// 缓存键要和 Python 侧共用同一份文件，所以这里必须复刻 Python 的行为，
/// 否则恰好落在 .5 边界的坐标会在两边算出不同的键、各存一份缓存。
fn py_round(x: f64) -> f64 {
    let f = x.floor();
    let diff = x - f;
    if (diff - 0.5).abs() < 1e-12 {
        // 正好在半点 → 取偶数侧
        if (f as i64) % 2 == 0 {
            f
        } else {
            f + 1.0
        }
    } else if diff > 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// 按 ~200m 网格生成缓存键（与 Python `_grid_key` 完全一致：`{lat}_{lng}_{radius}`）
pub fn grid_key(lat: f64, lng: f64, radius_m: f64) -> String {
    format!(
        "{}_{}_{}",
        py_round(lat / GRID) as i64,
        py_round(lng / GRID) as i64,
        radius_m as i64
    )
}

/// 构造 Overpass QL：半径内指定类型的 way/node 都取，带 center 便于画多边形
pub fn overpass_query(lat: f64, lng: f64, radius_m: f64, kinds: &[String]) -> String {
    let mut parts = String::new();
    for k in kinds {
        parts.push_str(&format!("way[\"{k}\"](around:{radius_m},{lat},{lng});"));
        parts.push_str(&format!("node[\"{k}\"](around:{radius_m},{lat},{lng});"));
    }
    format!("[out:json][timeout:40];({parts});out center tags;")
}

/// 极简 `application/x-www-form-urlencoded` 编码。
///
/// 为什么不用 `reqwest` 的 `.form()`：reqwest 0.13 把它挪到了 `form` feature 后面，
/// 而宿主工程（LingChat）没有开这个 feature —— 为一行请求去改官方依赖不值得，
/// 而 Overpass 的请求体本来就只有一个 `data=` 字段，自己编码更省事也更可控。
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let pct = |s: &str| -> String {
        let mut o = String::new();
        for b in s.as_bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    o.push(*b as char)
                }
                b' ' => o.push('+'),
                _ => o.push_str(&format!("%{b:02X}")),
            }
        }
        o
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", pct(k), pct(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 缓存文件路径
pub fn cache_path(dir: impl AsRef<Path>, key: &str) -> PathBuf {
    dir.as_ref().join(format!("{key}.json"))
}

/// 读缓存。小于 50 字节的文件视为「写坏了的半截文件」，当作没有。
/// （Python 侧同样判断 `getsize(cf) > 50`——曾因为一次中断留下 3 字节文件导致解析失败）
pub fn load_cached(dir: impl AsRef<Path>, key: &str) -> Option<Value> {
    let p = cache_path(dir, key);
    let meta = std::fs::metadata(&p).ok()?;
    if meta.len() <= 50 {
        return None;
    }
    let raw = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把一条 Overpass 查询按 [`ENDPOINTS`] 顺序逐个试，返回**第一个带 `elements` 字段**的响应
/// 以及命中的端点。
///
/// 抽出来给 `fetch_area`（按种类取摘要）和 `fetch_buildings`（取楼房轮廓）共用：
/// 两处的失败语义**必须完全一致**，否则会重演下面这个坑 ——
/// 回退循环只判 `elements` **字段在不在**（`if j.get("elements").is_none() { continue; }`），
/// 因为局部镜像（如 `overpass.osm.ch`）对没有数据的地区返回的是
/// `200 + {"elements": []}`：这份空结果会被**当成最终答案**，后续端点根本没机会跑。
/// 所以「字段不在」= 这次不算数、继续试；「字段在但为空」= 这就是答案（真的是空的）。
async fn post_overpass(client: &reqwest::Client, q: &str) -> Option<(Value, &'static str)> {
    for ep in ENDPOINTS {
        let resp = client
            .post(ep)
            .header("User-Agent", "LSYuki-maps/1.0")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form_encode(&[("data", q)]))
            .send()
            .await;
        let j = match resp {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                Ok(v) => v,
                Err(_) => continue,
            },
            _ => continue,
        };
        if j.get("elements").is_none() {
            continue;
        }
        return Some((j, ep));
    }
    None
}

/// 拉取区域 OSM 数据。缓存优先；所有端点都失败返回 None（调用方降级为纯 LLM）。
///
/// 返回值里会附 `_meta`（坐标、半径、时间戳、命中的端点）便于排障与增量刷新。
pub async fn fetch_area(
    client: &reqwest::Client,
    dir: impl AsRef<Path>,
    lat: f64,
    lng: f64,
    radius_m: f64,
    kinds: Option<Vec<String>>,
    force: bool,
) -> Option<Value> {
    let kinds = kinds.unwrap_or_else(|| DEFAULT_KINDS.iter().map(|s| s.to_string()).collect());
    let dir = dir.as_ref();
    let key = grid_key(lat, lng, radius_m);

    if !force {
        if let Some(v) = load_cached(dir, &key) {
            return Some(v);
        }
    }

    let q = overpass_query(lat, lng, radius_m, &kinds);
    let (mut j, ep) = post_overpass(client, &q).await?;
    j["_meta"] = json!({
        "lat": lat, "lng": lng, "radius_m": radius_m,
        "ts": now_secs(), "endpoint": ep,
    });
    let _ = std::fs::create_dir_all(dir);
    if let Ok(txt) = serde_json::to_string(&j) {
        let _ = std::fs::write(cache_path(dir, &key), txt);
    }
    Some(j)
}

// ══════════════════════════════════════════════════════════════════════
// 真实楼房：Overpass → GeoJSON（给 MapLibre `fill-extrusion` 挤成 2.5D）
// ══════════════════════════════════════════════════════════════════════
//
// 这一段与上面的 `fetch_area`/`summarize` 是**两条独立通路**：
//   · `fetch_area` 的产物是"给 LLM 看的一句话摘要"（只要种类与计数）；
//   · 这一段产出的是**几何**（`out geom`，整条 way 的轮廓）+ 楼高，给渲染用。
// 所以它们**不共用缓存**（见 `BUILDINGS_KEY_PREFIX` 的注释）。

/// 取楼房的 Overpass QL。
///
/// 与 `overpass_query` 的三点不同：
///   · `out geom` —— 要**整条轮廓**（`out center` 只有中心点，挤不出体块）；
///   · 单条件 `["building"]` —— 楼高不在"种类"维度上，是"每个要素的标签"；
///   · 带上 `["building"!="no"]` —— OSM 里 `building=no` 是"这里不是楼"的显式否，
///     有些编辑器会用它压掉误标，不该被画成一栋楼。
///
/// ⚠️ **`building:part` 不会被匹配**（键名不同），这是对的：它是"楼的一部分"，
/// 与父要素同时渲染会**双重挤出**（部件从楼里穿出来）。真要细分体块得另开一条路。
///
/// ⚠️ `relation["building"]` 也取回来了，但 [`buildings_geojson`] **只解析 way**：
/// 多边形的环组装（outer/inner 配对、洞）是另一件事，草率地"取点数最多的 outer"
/// 会把带内院的楼画成实心块，且**不报任何错**。所以关系被**计数但不渲染**
/// （`stats.skipped.relation`）—— 数据缺口必须看得见，不能悄悄少画。
pub fn buildings_query(lat: f64, lng: f64, radius_m: f64) -> String {
    format!(
        "[out:json][timeout:40];(\
         way[\"building\"][\"building\"!=\"no\"](around:{radius_m},{lat},{lng});\
         relation[\"building\"][\"building\"!=\"no\"](around:{radius_m},{lat},{lng});\
         );out geom;"
    )
}

/// 楼房缓存的键（**带前缀**，与摘要缓存隔离；理由见 `BUILDINGS_KEY_PREFIX`）
pub fn buildings_cache_key(lat: f64, lng: f64, radius_m: f64) -> String {
    format!("{BUILDINGS_KEY_PREFIX}{}", grid_key(lat, lng, radius_m))
}

/// 取楼房数据（Overpass → 原始 JSON），缓存优先。
///
/// 与 `fetch_area` 同款语义：**没缓存就真去抓**，三个端点全失败返回 None。
/// 磁盘增长与"别接到自动路径上"的告警见 `mod.rs` 的 `world_map_buildings` 文档。
pub async fn fetch_buildings(
    client: &reqwest::Client,
    dir: impl AsRef<Path>,
    lat: f64,
    lng: f64,
    radius_m: f64,
    force: bool,
) -> Option<Value> {
    let dir = dir.as_ref();
    let key = buildings_cache_key(lat, lng, radius_m);

    if !force {
        if let Some(v) = load_cached(dir, &key) {
            return Some(v);
        }
    }

    let q = buildings_query(lat, lng, radius_m);
    let (mut j, ep) = post_overpass(client, &q).await?;
    j["_meta"] = json!({
        "lat": lat, "lng": lng, "radius_m": radius_m,
        "ts": now_secs(), "endpoint": ep, "kind": "buildings",
    });
    let _ = std::fs::create_dir_all(dir);
    if let Ok(txt) = serde_json::to_string(&j) {
        let _ = std::fs::write(cache_path(dir, &key), txt);
    }
    Some(j)
}

/// 解析一个 OSM 长度值 → 米。
///
/// OSM 的约定：**不带单位就是米**（`height=25` = 25 米）。但也真的存在
/// `82 ft` / `250 cm` 这类写法，所以按单位后缀换算，而不是"把数字抠出来就算"。
///
/// 返回 `None` 的三种情况（都要让调用方落到下一优先级，而不是当成 0）：
/// 空串、开头没有数字、数字不是正有限值（`0` 与负数都不是"高度"）。
pub fn parse_len_m(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let b = s.as_bytes();
    let mut i = if b[0] == b'+' { 1 } else { 0 };
    let start = i;
    let mut dot = false;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_digit() {
            i += 1;
        } else if c == b'.' && !dot {
            dot = true;
            i += 1;
        } else {
            break;
        }
    }
    if i == start {
        return None; // 开头就没有数字（"约 20 米" 这种中文前缀）
    }
    let num: f64 = s[start..i].parse().ok()?;
    if !num.is_finite() {
        return None;
    }
    // 单位只看数字后面那截（大小写无关）
    let unit = s[i..].trim().to_ascii_lowercase();
    let m = if unit.starts_with("ft") || unit.starts_with('\'') {
        num * 0.3048
    } else if unit.starts_with("km") {
        num * 1000.0
    } else if unit.starts_with("cm") {
        num / 100.0
    } else if unit.starts_with("in") || unit.starts_with('"') {
        num * 0.0254
    } else {
        num // 无单位 = 米（OSM 默认）
    };
    if m.is_finite() && m > 0.0 {
        Some(m)
    } else {
        None
    }
}

/// 一栋楼的楼高判定结果
#[derive(Debug, Clone, PartialEq)]
pub struct HeightPick {
    /// 楼高（米，已夹到 `MAX_HEIGHT_M`）
    pub height_m: f64,
    /// 底座高（米，`min_height`/`building:min_level`；没有就是 0）
    pub min_height_m: f64,
    /// 高度**来源**：`"height"` | `"levels"` | `"default"`
    pub source: &'static str,
    /// 具体是哪个标签给的（`"building:height"` | `"height"` | `"building:levels"` | `"default"`）
    pub tag: &'static str,
    /// 层数（只有 `levels` 来源才有）
    pub levels: Option<f64>,
    /// 高度被 `MAX_HEIGHT_M` 夹过
    pub clamped: bool,
    /// 写了高度标签但解析不出来（数据质量指标）
    pub bad_height: bool,
    /// 写了层数标签但解析不出来（数据质量指标）
    pub bad_levels: bool,
}

fn tag_str<'a>(tags: &'a serde_json::Map<String, Value>, k: &str) -> Option<&'a str> {
    tags.get(k)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

/// 底座高：`building:min_height` → `min_height` → `building:min_level` × 层高
fn min_height_of(tags: &serde_json::Map<String, Value>) -> f64 {
    for k in ["building:min_height", "min_height"] {
        if let Some(v) = tag_str(tags, k).and_then(parse_len_m) {
            return v;
        }
    }
    if let Some(v) = tag_str(tags, "building:min_level").and_then(parse_len_m) {
        return v * LEVEL_METERS;
    }
    0.0
}

/// 楼高判定（**优先级是这一段的契约，别改顺序**）：
///
/// 1. `building:height` —— 建筑专用标签，最可信
/// 2. `height` —— 通用高度标签（OSM 里**比 ①更常见**，同样是显式高度，
///    所以它与 ① 归成同一个 `source="height"`，但 `tag` 分开记，便于看数据来源）
/// 3. `building:levels` × [`LEVEL_METERS`]（3m/层）
/// 4. 都没有 → [`DEFAULT_HEIGHT_M`]（8m）
///
/// 单位换算与"解析不出来怎么办"都在 [`parse_len_m`]：**解析失败要落到下一档**，
/// 绝不能当成 0 —— 0 高的楼在地图上等于不存在，而"数据脏"会被伪装成"这里没楼"。
pub fn building_height(tags: &serde_json::Map<String, Value>) -> HeightPick {
    let mut bad_height = false;
    for tag in ["building:height", "height"] {
        if let Some(raw) = tag_str(tags, tag) {
            match parse_len_m(raw) {
                Some(h) => {
                    let (h, clamped) = if h > MAX_HEIGHT_M {
                        (MAX_HEIGHT_M, true)
                    } else {
                        (h, false)
                    };
                    let min_h = min_height_of(tags).min(h);
                    let levels = tag_str(tags, "building:levels").and_then(parse_len_m);
                    return HeightPick {
                        height_m: h,
                        min_height_m: min_h,
                        source: "height",
                        tag,
                        levels,
                        clamped,
                        bad_height,
                        bad_levels: false,
                    };
                }
                // 标签在、值读不出来 → 记一笔，继续往下一档走
                None => bad_height = true,
            }
        }
    }

    let mut bad_levels = false;
    if let Some(raw) = tag_str(tags, "building:levels") {
        match parse_len_m(raw) {
            Some(lv) => {
                let raw_h = lv * LEVEL_METERS;
                let (h, clamped) = if raw_h > MAX_HEIGHT_M {
                    (MAX_HEIGHT_M, true)
                } else {
                    (raw_h, false)
                };
                let min_h = min_height_of(tags).min(h);
                return HeightPick {
                    height_m: h,
                    min_height_m: min_h,
                    source: "levels",
                    tag: "building:levels",
                    levels: Some(lv),
                    clamped,
                    bad_height,
                    bad_levels,
                };
            }
            None => bad_levels = true,
        }
    }

    HeightPick {
        height_m: DEFAULT_HEIGHT_M,
        min_height_m: 0.0,
        source: "default",
        tag: "default",
        levels: None,
        clamped: false,
        bad_height,
        bad_levels,
    }
}

/// 保留 2 位小数（JSON 里的高度不需要更多精度，少几个字节 × 几百栋也可观）
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// 坐标保留 7 位（≈1cm，远超渲染需要，但能把 payload 压下来）
fn round7(x: f64) -> f64 {
    (x * 1e7).round() / 1e7
}

/// 把 `out geom` 给的一条 way 几何变成**闭合的 GeoJSON 环**（`[[lng,lat],…]`）。
///
/// 返回 `None` = 这条几何**整条不可用**（宁可少画一栋，也不要画一个畸形的块）：
///   · 有空点 / 坐标不是有限数 / 经纬度越界；
///   · 去重后不足 3 个不同点（构不成面）。
///
/// 去重是必须的：OSM 的 way 首尾是**同一个节点**（闭合环），
/// 直接转 GeoJSON 会得到一个首尾重复的 4 点环 —— 多数渲染器能忍，
/// 但退化到"首尾节点重合且只有 2 个不同点"时就不是面了。
fn ring_of(geom: &[Value]) -> Option<Vec<Value>> {
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(geom.len() + 1);
    for p in geom {
        let lat = p.get("lat")?.as_f64()?;
        let lon = p.get("lon")?.as_f64()?;
        if !lat.is_finite() || !lon.is_finite() {
            return None;
        }
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return None; // 越界坐标：宁可不要，也不要把地图拉飞
        }
        let q = (round7(lon), round7(lat)); // GeoJSON 是 [lng, lat]
        match pts.last() {
            Some(last) if (last.0 - q.0).abs() < 1e-9 && (last.1 - q.1).abs() < 1e-9 => {}
            _ => pts.push(q),
        }
    }
    if pts.len() < 3 {
        return None;
    }
    // 闭合环：首 != 尾就补一个（首 == 尾说明本来就是闭合 way）
    let first = pts[0];
    let last = *pts.last().unwrap();
    if (first.0 - last.0).abs() > 1e-9 || (first.1 - last.1).abs() > 1e-9 {
        pts.push(first);
    }
    Some(pts.into_iter().map(|(x, y)| json!([x, y])).collect())
}

/// Overpass 原始 JSON → `(GeoJSON FeatureCollection, 统计)`
///
/// **两个返回值都要**：
///   · FC 是给 MapLibre 的（保持成**纯 GeoJSON**，不掺自定义字段，
///     免得哪天渲染器对多余成员挑食）；
///   · 统计是给人看的 —— 「多少栋楼的高度是真数据、多少栋是我猜的」必须可回答，
///     否则"地图上楼房看起来挺对"这件事无法与"其实全是默认 8 米"区分开。
///
/// 每个要素的 `properties`：
/// `{ osm_id, height, min_height, height_src, height_tag, levels, kind, name }`
/// —— `height_src` 逐栋带上，前端做图例/排查时不用回头猜。
pub fn buildings_geojson(osm: &Value) -> (Value, Value) {
    let empty: Vec<Value> = Vec::new();
    let els = osm
        .get("elements")
        .and_then(|e| e.as_array())
        .unwrap_or(&empty);

    let mut feats: Vec<Value> = Vec::new();
    let mut heights: Vec<f64> = Vec::new();
    let (mut n_height, mut n_levels, mut n_default) = (0u64, 0u64, 0u64);
    let (mut tag_bh, mut tag_h) = (0u64, 0u64);
    let (mut bad_h, mut bad_lv) = (0u64, 0u64);
    let (mut clamped, mut min_used) = (0u64, 0u64);
    let (mut skip_geom, mut skip_rel, mut skip_other) = (0u64, 0u64, 0u64);

    for e in els {
        match e.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "way" => {}
            // 关系（multipolygon）：计数但不渲染 —— 理由见 `buildings_query` 的文档
            "relation" => {
                skip_rel += 1;
                continue;
            }
            _ => {
                skip_other += 1;
                continue;
            }
        }

        let ring = match e.get("geometry").and_then(|g| g.as_array()) {
            Some(g) => match ring_of(g) {
                Some(r) => r,
                None => {
                    skip_geom += 1;
                    continue;
                }
            },
            None => {
                skip_geom += 1;
                continue;
            }
        };

        let no_tags = serde_json::Map::new();
        let tags = e
            .get("tags")
            .and_then(|t| t.as_object())
            .unwrap_or(&no_tags);
        let pick = building_height(tags);

        match pick.source {
            "height" => {
                n_height += 1;
                if pick.tag == "building:height" {
                    tag_bh += 1;
                } else {
                    tag_h += 1;
                }
            }
            "levels" => n_levels += 1,
            _ => n_default += 1,
        }
        if pick.bad_height {
            bad_h += 1;
        }
        if pick.bad_levels {
            bad_lv += 1;
        }
        if pick.clamped {
            clamped += 1;
        }
        if pick.min_height_m > 0.0 {
            min_used += 1;
        }
        heights.push(pick.height_m);

        let osm_id = format!(
            "{}/{}",
            e.get("type").and_then(|v| v.as_str()).unwrap_or("way"),
            e.get("id").and_then(|v| v.as_i64()).unwrap_or(0)
        );
        let name = tag_str(tags, "name").unwrap_or("");
        let kind = tag_str(tags, "building").unwrap_or("yes");

        feats.push(json!({
            "type": "Feature",
            "id": osm_id,
            "properties": {
                "osm_id": osm_id,
                "height": round2(pick.height_m),
                "min_height": round2(pick.min_height_m),
                "height_src": pick.source,
                "height_tag": pick.tag,
                "levels": pick.levels,
                "kind": kind,
                "name": if name.is_empty() { Value::Null } else { Value::String(name.to_string()) },
            },
            "geometry": { "type": "Polygon", "coordinates": [ring] },
        }));
    }

    let count = feats.len() as u64;
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let max_h = heights.last().copied().unwrap_or(0.0);
    // 上中位数（偶数个取偏大的那个）—— 只用来描述数据质量，不参与渲染
    let median_h = if heights.is_empty() {
        0.0
    } else {
        heights[heights.len() / 2]
    };

    let fc = json!({ "type": "FeatureCollection", "features": feats });
    let stats = json!({
        "count": count,
        // 「高度来源分布」——本功能最该被追问的一个数：有多少是真数据
        "height_source": { "height": n_height, "levels": n_levels, "default": n_default },
        // 更细一档：具体吃的是哪个标签（三项之和 == count）
        "height_tag": {
            "building:height": tag_bh,
            "height": tag_h,
            "building:levels": n_levels,
            "default": n_default,
        },
        // 数据质量：写了标签但读不出来（这些楼最后落到了 default）
        "unparsable": { "height": bad_h, "levels": bad_lv },
        "clamped": clamped,
        "min_height_used": min_used,
        // 没画出来的（必须可见，不然"少画了"会被读成"这里没有"）
        "skipped": { "geometry": skip_geom, "relation": skip_rel, "other": skip_other },
        // 换算常量随数据一起返回 —— 前端**不要**自己写 8 和 3
        "levels_meters": LEVEL_METERS,
        "default_height_m": DEFAULT_HEIGHT_M,
        "max_height_m": round2(max_h),
        "median_height_m": round2(median_h),
    });

    (fc, stats)
}

// ════════════════════════════════════════════════════════════════════════════
// 道路：Overpass → GeoJSON（给 MapLibre 画线 + 给"行人沿路走"当路网）
//
// 为什么和楼房是**两条独立通路**（不复用 `buildings_query`）：
//   · 楼是**面**（`out geom` 拿整条轮廓），路是**线**（只要折线，不需要闭合）；
//   · 路的属性维度完全不同（`highway` 等级 / 单行 / 桥隧 / 车道数），
//     混进楼房那套 `height_src` 口径里只会互相干扰；
//   · 缓存前缀分开（`road_`），免得一次改查询把两边的缓存都毒掉。
//
// 谁用它：`DESIGN-AUTONOMY.md`（角色自主生活）需要"**可走的路网**" ——
// 10 分钟没人说话就自己出门，得先知道"路在哪、往哪走"。
// ════════════════════════════════════════════════════════════════════════════

/// 道路缓存的键前缀（与 `BUILDINGS_KEY_PREFIX` 隔离，理由同上）
pub const ROADS_KEY_PREFIX: &str = "road_";

/// 我们要的路等级 → **渲染/寻路用的"档次"**（0 最粗 ~ 4 最细）。
///
/// 为什么要在后端就归一化：前端要按档次分线宽/亮度，寻路要按档次给**通行代价**
/// （走主干道比钻小巷快）。这两件事都需要一张"等级表"，
/// 放在 Rust 里算一次、随数据一起返回，前端就不用再维护第二份 `match`（迟早漂移）。
///
/// 取值依据：中国城市路网的常见分级（快速路/主干/次干/支路），
/// 加上步行道（`footway`/`path`/`steps`）——角色是**走**的，步道必须算路。
pub fn road_rank(highway: &str) -> u8 {
    match highway {
        "motorway" | "motorway_link" | "trunk" | "trunk_link" => 0,
        "primary" | "primary_link" => 1,
        "secondary" | "secondary_link" => 2,
        "tertiary" | "tertiary_link" | "unclassified" => 3,
        "residential" | "living_street" | "service" | "pedestrian" => 4,
        "footway" | "path" | "steps" | "cycleway" | "track" => 5,
        _ => 4, // 认不出来的当"支路"——比当主干道安全（画细一点不会喧宾夺主）
    }
}

/// 取路的 Overpass QL。
///
/// ⚠️ 三个刻意的取舍：
///   1. **只取 `way`**：道路在 OSM 里就是 way（关系是路线的集合，没有自己的几何）；
///   2. **用正则一次列全**而不是 `way["highway"]` 全收 —— 后者会把
///      `bus_stop` 的站台、`platform`、`construction` 甚至 `proposed`（**规划中、根本不存在**）
///      都当成路画出来：屏幕上多出一堆"幽灵路"，而且**不报错**；
///   3. `out geom`（要折线），不是 `out center`（那只有一个中心点，画不出路）。
pub fn roads_query(lat: f64, lng: f64, radius_m: f64) -> String {
    format!(
        "[out:json][timeout:40];\
         way[\"highway\"~\"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|steps|cycleway|track)$\"](around:{radius_m},{lat},{lng});\
         out geom;"
    )
}

/// 道路缓存的键（**带前缀**）
pub fn roads_cache_key(lat: f64, lng: f64, radius_m: f64) -> String {
    format!("{ROADS_KEY_PREFIX}{}", grid_key(lat, lng, radius_m))
}

/// 取道路数据（Overpass → 原始 JSON），缓存优先。语义与 [`fetch_buildings`] 完全一致。
pub async fn fetch_roads(
    client: &reqwest::Client,
    dir: impl AsRef<Path>,
    lat: f64,
    lng: f64,
    radius_m: f64,
    force: bool,
) -> Option<Value> {
    let dir = dir.as_ref();
    let key = roads_cache_key(lat, lng, radius_m);

    if !force {
        if let Some(v) = load_cached(dir, &key) {
            return Some(v);
        }
    }

    let q = roads_query(lat, lng, radius_m);
    let (mut j, ep) = post_overpass(client, &q).await?;
    j["_meta"] = json!({
        "lat": lat, "lng": lng, "radius_m": radius_m,
        "ts": now_secs(), "endpoint": ep, "kind": "roads",
    });
    let _ = std::fs::create_dir_all(dir);
    if let Ok(txt) = serde_json::to_string(&j) {
        let _ = std::fs::write(cache_path(dir, &key), txt);
    }
    Some(j)
}

/// Overpass 原始 JSON → `(GeoJSON FeatureCollection(LineString), 统计)`
///
/// 每个要素的 `properties`：
/// `{ osm_id, kind, rank, name, oneway, bridge, tunnel, lanes, layer, surface }`
/// —— `rank` 是**归一化过的档次**（见 [`road_rank`]），前端按它画粗细/亮度，不用再 match 一遍。
///
/// 统计里 `by_rank` / `named` / `oneway` 都要给：前端 HUD 要如实写"本视野 N 条路"，
/// 而"N 条里有几条是主干、几条有名字"正是**数据质量**的答案（一眼看出这片 OSM 画得细不细）。
pub fn roads_geojson(osm: &Value) -> (Value, Value) {
    let empty: Vec<Value> = Vec::new();
    let els = osm.get("elements").and_then(|e| e.as_array()).unwrap_or(&empty);

    let mut feats: Vec<Value> = Vec::new();
    let mut by_rank: HashMap<String, u64> = HashMap::new();
    let (mut named, mut oneway, mut bridges, mut tunnels) = (0u64, 0u64, 0u64, 0u64);
    let (mut skip_geom, mut skip_other, mut skip_short) = (0u64, 0u64, 0u64);

    for e in els {
        match e.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "way" => {}
            _ => {
                skip_other += 1;
                continue;
            }
        }
        let tags = match e.get("tags").and_then(|v| v.as_object()) {
            Some(t) => t,
            None => {
                skip_other += 1;
                continue;
            }
        };
        let kind = tags.get("highway").and_then(|v| v.as_str()).unwrap_or("");
        if kind.is_empty() {
            skip_other += 1;
            continue;
        }
        /* `out geom` 给的是 `geometry: [{lat, lon}, …]`。少于两点连不成线 ⇒ 跳过并**计数** */
        let geom = match e.get("geometry").and_then(|v| v.as_array()) {
            Some(g) if g.len() >= 2 => g,
            _ => {
                skip_geom += 1;
                continue;
            }
        };
        let coords: Vec<Value> = geom
            .iter()
            .filter_map(|p| {
                let lat = p.get("lat")?.as_f64()?;
                let lon = p.get("lon")?.as_f64()?;
                if lat.is_finite() && lon.is_finite() {
                    Some(json!([round7(lon), round7(lat)])) // GeoJSON 是 [lng, lat]，别写反
                } else {
                    None
                }
            })
            .collect();
        if coords.len() < 2 {
            skip_short += 1;
            continue;
        }

        let rank = road_rank(kind);
        *by_rank.entry(rank.to_string()).or_insert(0) += 1;
        let name = tags.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() {
            named += 1;
        }
        let ow = match tags.get("oneway").and_then(|v| v.as_str()) {
            Some("yes") | Some("1") | Some("true") => {
                oneway += 1;
                true
            }
            _ => false,
        };
        let br = tag_str(tags, "bridge").map(|v| v != "no").unwrap_or(false);
        let tn = tag_str(tags, "tunnel").map(|v| v != "no").unwrap_or(false);
        if br {
            bridges += 1;
        }
        if tn {
            tunnels += 1;
        }

        feats.push(json!({
            "type": "Feature",
            "id": format!("way/{}", e.get("id").and_then(|v| v.as_i64()).unwrap_or(0)),
            "properties": {
                "osm_id": format!("way/{}", e.get("id").and_then(|v| v.as_i64()).unwrap_or(0)),
                "kind": kind,
                "rank": rank,
                "name": if name.is_empty() { Value::Null } else { json!(name) },
                "oneway": ow,
                "bridge": br,
                "tunnel": tn,
                "lanes": tag_str(tags, "lanes").and_then(|v| v.parse::<f64>().ok()),
                "layer": tag_str(tags, "layer").and_then(|v| v.parse::<f64>().ok()),
                "surface": tag_str(tags, "surface"),
            },
            "geometry": { "type": "LineString", "coordinates": coords },
        }));
    }

    let n = feats.len() as u64;
    let fc = json!({ "type": "FeatureCollection", "features": feats });
    let stats = json!({
        "count": n,
        "by_rank": by_rank,
        "named": named,
        "oneway": oneway,
        "bridge": bridges,
        "tunnel": tunnels,
        // 没画出来的必须可见（同楼房那套纪律：少画了不能读成"这里没有"）
        "skipped": { "geometry": skip_geom, "short": skip_short, "other": skip_other },
    });
    (fc, stats)
}

/// 按出现次数排序取前 n（同数保持「首次出现」顺序，与 Python 的稳定排序一致）
fn top(counts: &HashMap<String, u32>, order: &[String], n: usize) -> Vec<Value> {
    let mut items: Vec<(&String, u32)> = order
        .iter()
        .filter_map(|k| counts.get(k).map(|c| (k, *c)))
        .collect();
    items.sort_by_key(|a| std::cmp::Reverse(a.1)); // 稳定排序：同数保持插入顺序
    items
        .into_iter()
        .take(n)
        .map(|(k, c)| json!([k, c]))
        .collect()
}

/// 把 OSM 原始数据压缩成 LLM 可读的摘要（控制 token）
///
/// 注意：这个结构是 `sketch::OsmHint::from_summary` 的输入契约，
/// `building_types` / `highway_types` 必须是 `[[名字, 次数], ...]` 形式。
pub fn summarize(osm: &Value) -> Option<Value> {
    let el = osm.get("elements").and_then(|e| e.as_array())?;

    let mut counts: HashMap<String, u32> = HashMap::new();
    // 每个桶单独记一份「首次出现顺序」，用于同数时的稳定排序
    let mut orders: HashMap<&str, Vec<String>> = HashMap::new();
    for key in BUCKET_KEYS {
        orders.insert(key, Vec::new());
    }

    for e in el {
        let t = match e.get("tags") {
            Some(t) => t,
            None => continue,
        };
        let obj = match t.as_object() {
            Some(o) => o,
            None => continue,
        };
        for key in BUCKET_KEYS {
            if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                let ck = format!("{key}\u{1}{v}");
                let c = counts.entry(ck).or_insert(0);
                if *c == 0 {
                    orders.get_mut(key).unwrap().push(v.to_string());
                }
                *c += 1;
            }
        }
    }

    let bucket = |key: &str| -> Vec<Value> {
        let order = orders.get(key).cloned().unwrap_or_default();
        let scoped: HashMap<String, u32> = order
            .iter()
            .map(|v| (v.clone(), *counts.get(&format!("{key}\u{1}{v}")).unwrap_or(&0)))
            .collect();
        top(&scoped, &order, 6)
    };

    Some(json!({
        "total_elements": el.len(),
        "building_types": bucket("building"),
        "highway_types": bucket("highway"),
        "amenities": bucket("amenity"),
        "leisure": bucket("leisure"),
        "landuse": bucket("landuse"),
        "meta": osm.get("_meta").cloned().unwrap_or_else(|| json!({})),
    }))
}

/// 把摘要转成一句中文描述，塞进 LLM prompt
pub fn describe_for_llm(osm: &Value) -> String {
    let s = match summarize(osm) {
        Some(s) => s,
        None => return String::new(),
    };
    let fmt = |k: &str| -> String {
        let arr = s.get(k).and_then(|v| v.as_array());
        match arr {
            Some(a) if !a.is_empty() => a
                .iter()
                .filter_map(|it| {
                    let name = it.get(0)?.as_str()?;
                    let n = it.get(1)?.as_u64()?;
                    Some(format!("{name}×{n}"))
                })
                .collect::<Vec<_>>()
                .join("、"),
            _ => "无".to_string(),
        }
    };
    format!(
        "该区域真实 OSM 数据：共 {} 个地物；建筑类型 {}；道路 {}；设施 {}；休闲 {}；用地 {}。",
        s.get("total_elements").and_then(|v| v.as_u64()).unwrap_or(0),
        fmt("building_types"),
        fmt("highway_types"),
        fmt("amenities"),
        fmt("leisure"),
        fmt("landuse"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **端点表的回归哨兵**（2026-09-13 加）。
    ///
    /// 这组断言不联网，守的是「别再踩同一个坑」：
    ///
    /// · `kumi.systems` **已死**（三次探测全是连接失败）—— 加回它只会白白拖长超时；
    /// · `osm.ch` **只覆盖瑞士**，对中国返回 `200 + {"elements":[]}`。因为回退循环只判
    ///   `elements` 字段在不在，这份空结果会被**当成成功答案**，后续端点没机会跑，
    ///   比"失败"危险得多（失败会 `continue`，返回空会被当成事实）。
    ///
    /// 所以这两个名字一旦再出现在表里，这条测试就红 —— 逼后来人去读上面的模块文档。
    #[test]
    fn endpoints_are_global_and_well_formed() {
        // 已知不合格的端点：不许出现在表里
        const BANNED: [&str; 2] = [
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.osm.ch/api/interpreter",
        ];
        for bad in BANNED {
            assert!(
                !ENDPOINTS.contains(&bad),
                "{bad} 不该在端点表里 —— 它要么已死、要么只覆盖局部地区（会静默返回空），详见 ENDPOINTS 的文档注释"
            );
        }
        // 实测最快最稳的那个必须在（它是中国可用性的主要保障）
        assert!(
            ENDPOINTS.iter().any(|e| e.contains("maps.mail.ru")),
            "maps.mail.ru 是实测最稳的端点，不该被拿掉"
        );
        // 形状统一：https + interpreter 路径，且不重复
        for ep in ENDPOINTS {
            assert!(ep.starts_with("https://"), "端点必须是 https：{ep}");
            assert!(ep.ends_with("/api/interpreter"), "端点路径不标准：{ep}");
            assert!(!ep.contains(' '), "端点不该含空格：{ep}");
        }
        let uniq: std::collections::HashSet<&&str> = ENDPOINTS.iter().collect();
        assert_eq!(uniq.len(), ENDPOINTS.len(), "端点表里有重复：{ENDPOINTS:?}");
        assert!(
            !ENDPOINTS.is_empty(),
            "端点表不能为空，否则 OSM 永远拿不到数据"
        );
    }

    /// 测试用临时目录：Android/Termux 上 /tmp 不可写，优先 TMPDIR，退到 $HOME/.cache
    fn tmp(tag: &str) -> PathBuf {
        let base = if let Ok(t) = std::env::var("TMPDIR") {
            let p = PathBuf::from(t);
            if p.is_dir() {
                p
            } else {
                PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache")
            }
        } else {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache")
        };
        let d = base.join(format!("wm_osm_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn grid_key_matches_python_format() {
        // Python: f'{round(lat/0.002)}_{round(lng/0.002)}_{int(radius)}'
        // 29.7524 / 0.002 = 14876.2 → 14876；107.2779 / 0.002 = 53638.95 → 53639
        assert_eq!(grid_key(29.7524, 107.2779, 400.0), "14876_53639_400");
        assert_eq!(grid_key(23.1291, 113.2644, 500.0), "11565_56632_500");
    }

    #[test]
    fn grid_key_uses_bankers_rounding() {
        // 恰好在 .5 上：Python round(2.5)=2、round(3.5)=4（取偶），Rust 原生 round 会给 3、4
        assert_eq!(py_round(2.5), 2.0);
        assert_eq!(py_round(3.5), 4.0);
        assert_eq!(py_round(-0.5), 0.0);
        assert_eq!(py_round(-1.5), -2.0);
        assert_eq!(py_round(-2.5), -2.0);
        assert_eq!(py_round(2.4), 2.0);
        assert_eq!(py_round(2.6), 3.0);
    }

    #[test]
    fn query_contains_all_kinds_and_around() {
        let kinds: Vec<String> = DEFAULT_KINDS.iter().map(|s| s.to_string()).collect();
        let q = overpass_query(29.75, 107.28, 400.0, &kinds);
        assert!(q.starts_with("[out:json][timeout:40];("));
        assert!(q.ends_with(");out center tags;"));
        for k in DEFAULT_KINDS {
            assert!(q.contains(&format!("way[\"{k}\"](around:400,29.75,107.28);")), "缺 way {k}");
            assert!(q.contains(&format!("node[\"{k}\"](around:400,29.75,107.28);")), "缺 node {k}");
        }
    }

    fn fixture() -> Value {
        json!({
            "elements": [
                {"type": "way", "tags": {"building": "apartments"}},
                {"type": "way", "tags": {"building": "apartments"}},
                {"type": "way", "tags": {"building": "house"}},
                {"type": "way", "tags": {"highway": "residential"}},
                {"type": "node", "tags": {"amenity": "restaurant"}},
                {"type": "node", "tags": {"leisure": "park"}},
                {"type": "way", "tags": {"landuse": "grass"}},
                {"type": "node", "tags": {}},
                {"type": "node"}
            ],
            "_meta": {"lat": 29.75, "lng": 107.28, "radius_m": 400}
        })
    }

    #[test]
    fn summarize_counts_and_orders() {
        let s = summarize(&fixture()).unwrap();
        assert_eq!(s["total_elements"], json!(9));
        // apartments 出现 2 次排第一，house 1 次第二
        assert_eq!(s["building_types"][0], json!(["apartments", 2]));
        assert_eq!(s["building_types"][1], json!(["house", 1]));
        assert_eq!(s["highway_types"][0], json!(["residential", 1]));
        assert_eq!(s["amenities"][0], json!(["restaurant", 1]));
        assert_eq!(s["leisure"][0], json!(["park", 1]));
        assert_eq!(s["landuse"][0], json!(["grass", 1]));
        assert_eq!(s["meta"]["radius_m"], json!(400));
    }

    #[test]
    fn summarize_empty_and_malformed() {
        assert!(summarize(&json!({})).is_none(), "没有 elements 应返回 None");
        assert!(summarize(&json!({"elements": []})).is_some(), "空数组仍是有效摘要");
        let s = summarize(&json!({"elements": [{"type": "node"}]})).unwrap();
        assert_eq!(s["total_elements"], json!(1));
        assert_eq!(s["building_types"], json!([]));
    }

    #[test]
    fn describe_is_chinese_and_lists_types() {
        let d = describe_for_llm(&fixture());
        assert!(d.contains("该区域真实 OSM 数据"));
        assert!(d.contains("共 9 个地物"));
        assert!(d.contains("apartments×2"));
        assert!(d.contains("residential×1"));
        assert!(describe_for_llm(&json!({})).is_empty(), "无数据时给空串而不是半句话");
    }

    #[test]
    fn summary_feeds_sketch_osm_hint() {
        // 摘要结构的真正消费者是 sketch::OsmHint——契约在这里被钉住
        let s = summarize(&fixture()).unwrap();
        let hint = crate::world_map::sketch::OsmHint::from_summary(&s);
        assert_eq!(hint.building_kinds, 2, "apartments/house 两类建筑");
        assert_eq!(hint.highway_kinds, 1, "residential 一类道路");
        assert!(!hint.has_water, "样本里没有 water");
        assert!(hint.has_park, "leisure=park 应判定为有公园");
    }

    #[test]
    fn cache_roundtrip_and_tiny_file_ignored() {
        let dir = tmp("cache");
        let key = grid_key(29.7524, 107.2779, 400.0);
        assert!(load_cached(&dir, &key).is_none(), "还没写就该是 None");

        std::fs::write(cache_path(&dir, &key), serde_json::to_string(&fixture()).unwrap()).unwrap();
        let back = load_cached(&dir, &key).unwrap();
        assert_eq!(back["elements"].as_array().unwrap().len(), 9);

        // 半截文件（<50 字节）必须当作没有，否则解析失败会一路冒到 LLM 调用
        std::fs::write(cache_path(&dir, &key), "{\"elements\":[]}").unwrap();
        assert!(load_cached(&dir, &key).is_none(), "小于 50 字节的残file应忽略");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn form_encode_escapes_overpass_query() {
        // Overpass 的查询里有 [] " ; : , 这些字符，编码错就会被 400 拒掉
        let q = "[out:json][timeout:40];(way[\"building\"](around:400,29.75,107.28););out center tags;";
        let body = form_encode(&[("data", q)]);
        assert!(body.starts_with("data="));
        assert!(body.contains("%5Bout%3Ajson%5D"), "方括号与冒号要转义: {body}");
        assert!(body.contains("%22building%22"), "引号要转义");
        assert!(!body.contains(' '), "空格不能原样出现");
        // 空格按 form 规则编码成 +（%20 也合法，但 + 更省字节）
        assert_eq!(form_encode(&[("a", "b c")]), "a=b+c");
        assert_eq!(form_encode(&[("a", "1"), ("b", "2")]), "a=1&b=2");
    }

    #[test]
    fn cache_path_is_inside_dir() {
        let p = cache_path("/data/x/osm", "1_2_3");
        assert!(p.ends_with("1_2_3.json"));
        assert!(p.starts_with("/data/x/osm"));
    }

    // ══════════════════════════════════════════════════════════════════
    // 真实楼房（2.5D 挤出）
    // ══════════════════════════════════════════════════════════════════

    fn tags(o: Value) -> serde_json::Map<String, Value> {
        o.as_object().unwrap().clone()
    }

    /// 一条闭合的 way 几何（正方形），四角 + 回到起点（OSM 的真实形状）
    fn square_geom(lat: f64, lon: f64) -> Value {
        json!([
            {"lat": lat, "lon": lon},
            {"lat": lat, "lon": lon + 0.0005},
            {"lat": lat + 0.0005, "lon": lon + 0.0005},
            {"lat": lat + 0.0005, "lon": lon},
            {"lat": lat, "lon": lon}
        ])
    }

    #[test]
    fn buildings_query_asks_for_geometry_not_centers() {
        let q = buildings_query(29.5630, 106.5516, 300.0);
        assert!(q.starts_with("[out:json][timeout:40];("), "{q}");
        // 🔴 这条是本查询存在的理由：`out center` 只有中心点，挤不出体块
        assert!(q.ends_with(");out geom;"), "必须用 out geom：{q}");
        assert!(!q.contains("out center"), "不能退回 out center：{q}");
        assert!(q.contains("way[\"building\"][\"building\"!=\"no\"](around:300,29.563,106.5516);"));
        assert!(q.contains("relation[\"building\"]"));
        // `building:part` 不该被匹配（键名不同）——匹配了会与父要素双重挤出
        assert!(!q.contains("building:part"), "不该查 building:part：{q}");
    }

    #[test]
    fn buildings_cache_key_never_collides_with_summary() {
        // 同一个网格、同一个半径：两条通路的键必须不同，否则互相覆盖缓存
        let k_sum = grid_key(29.5630, 106.5516, 300.0);
        let k_bld = buildings_cache_key(29.5630, 106.5516, 300.0);
        assert_ne!(k_sum, k_bld);
        assert_eq!(k_bld, format!("bldg_{k_sum}"));
        assert!(k_bld.starts_with(BUILDINGS_KEY_PREFIX));
    }

    #[test]
    fn parse_len_units() {
        // 无单位 = 米（OSM 约定）
        assert_eq!(parse_len_m("25"), Some(25.0));
        assert_eq!(parse_len_m(" 25 "), Some(25.0));
        assert_eq!(parse_len_m("+25"), Some(25.0));
        assert_eq!(parse_len_m("25.5"), Some(25.5));
        assert_eq!(parse_len_m("25 m"), Some(25.0));
        assert_eq!(parse_len_m("25 meters"), Some(25.0));
        // 英制/其它单位要换算，不能把数字直接当米
        assert_eq!(parse_len_m("82 ft"), Some(24.9936));
        assert_eq!(parse_len_m("82'"), Some(24.9936));
        assert_eq!(parse_len_m("250 cm"), Some(2.5));
        assert_eq!(parse_len_m("0.25 km"), Some(250.0));
        assert_eq!(parse_len_m("120 in"), Some(3.048));
        assert_eq!(parse_len_m("15 M"), Some(15.0), "单位大小写无关");
        // 读不出来的一律 None（**绝不能是 0**：0 高的楼等于不存在）
        assert_eq!(parse_len_m(""), None);
        assert_eq!(parse_len_m("   "), None);
        assert_eq!(parse_len_m("约 20 米"), None, "中文前缀不该被抠出 20");
        assert_eq!(parse_len_m("abc"), None);
        assert_eq!(parse_len_m("0"), None);
        assert_eq!(parse_len_m("-3"), None);
        assert_eq!(parse_len_m("."), None);
    }

    #[test]
    fn height_priority_is_building_height_then_height_then_levels_then_default() {
        // ① building:height 胜过一切
        let p = building_height(&tags(json!({
            "building": "yes", "building:height": "30", "height": "99", "building:levels": "100"
        })));
        assert_eq!((p.height_m, p.source, p.tag), (30.0, "height", "building:height"));

        // ② 只有通用 height → 仍算显式高度，但 tag 记下来（数据来源要能区分）
        let p = building_height(&tags(json!({
            "building": "yes", "height": "18", "building:levels": "6"
        })));
        assert_eq!((p.height_m, p.source, p.tag), (18.0, "height", "height"));

        // ③ 只有层数 → × 3m
        let p = building_height(&tags(json!({"building": "yes", "building:levels": "7"})));
        assert_eq!((p.height_m, p.source, p.levels), (21.0, "levels", Some(7.0)));

        // ④ 什么都没有 → 默认 8m，且**来源如实标 default**（不许让前端以为是真数据）
        let p = building_height(&tags(json!({"building": "apartments"})));
        assert_eq!((p.height_m, p.source, p.tag), (DEFAULT_HEIGHT_M, "default", "default"));
    }

    #[test]
    fn height_falls_through_on_garbage_values() {
        // 高度标签是脏的 → 落到层数（而不是当成 0）
        let p = building_height(&tags(json!({
            "building": "yes", "height": "很高", "building:levels": "4"
        })));
        assert_eq!((p.height_m, p.source), (12.0, "levels"));
        assert!(p.bad_height, "脏的高度标签要被记下来");

        // 层数也是脏的 → 落到默认
        let p = building_height(&tags(json!({
            "building": "yes", "height": "unknown", "building:levels": "?"
        })));
        assert_eq!((p.height_m, p.source), (DEFAULT_HEIGHT_M, "default"));
        assert!(p.bad_height && p.bad_levels);

        // 高度是脏的、层数是好的，但层数标签本身也脏时不能把 bad_levels 丢掉
        let p = building_height(&tags(json!({"building": "yes", "building:levels": "3.5"})));
        assert_eq!(p.height_m, 10.5, "小数层数要能用");
    }

    #[test]
    fn height_is_clamped_and_min_height_supported() {
        // levels=100 → 300m，**没到**上限，是"离谱但合法"的数据，必须原样保留
        let p = building_height(&tags(json!({"building": "yes", "building:levels": "100"})));
        assert_eq!(p.height_m, 300.0);
        assert!(!p.clamped);

        // levels=200 → 600m > 500m 上限 → 夹住并标记
        let p = building_height(&tags(json!({"building": "yes", "building:levels": "200"})));
        assert_eq!(p.height_m, MAX_HEIGHT_M, "超过上限的楼高要被夹住");
        assert!(p.clamped);

        // 显式高度同样受夹
        let p = building_height(&tags(json!({"building": "yes", "height": "900"})));
        assert_eq!(p.height_m, MAX_HEIGHT_M);
        assert!(p.clamped);

        let p = building_height(&tags(json!({
            "building": "yes", "height": "60", "min_height": "12"
        })));
        assert_eq!((p.height_m, p.min_height_m), (60.0, 12.0));

        let p = building_height(&tags(json!({
            "building": "yes", "height": "60", "building:min_level": "2"
        })));
        assert_eq!(p.min_height_m, 6.0, "min_level × 层高");

        // 底座比楼还高是脏数据 → 夹到楼高（否则挤出体块会翻过来）
        let p = building_height(&tags(json!({
            "building": "yes", "height": "10", "min_height": "80"
        })));
        assert_eq!(p.min_height_m, 10.0);
    }

    #[test]
    fn ring_is_closed_deduped_and_lng_lat_ordered() {
        // OSM 的闭合 way：首尾同点 → GeoJSON 环必须**只有一份**首点，且首尾相同
        let r = ring_of(square_geom(29.563, 106.5516).as_array().unwrap()).unwrap();
        assert_eq!(r.len(), 5, "4 个角 + 闭合点");
        assert_eq!(r[0], r[4], "环必须闭合");
        assert_eq!(r[0], json!([106.5516, 29.563]), "GeoJSON 是 [lng, lat]");
        assert_eq!(r[1], json!([106.5521, 29.563]));
    }

    #[test]
    fn ring_rejects_broken_geometry() {
        let bad = |v: Value| ring_of(v.as_array().unwrap()).is_none();
        // 点太少
        assert!(bad(json!([{"lat": 1.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}])));
        // 去重后不足 3 个不同点
        assert!(bad(json!([
            {"lat": 1.0, "lon": 2.0}, {"lat": 1.0, "lon": 2.0}, {"lat": 1.0, "lon": 2.0}
        ])));
        // 缺字段 / 非数字
        assert!(bad(json!([{"lat": 1.0}, {"lat": 1.1, "lon": 2.1}, {"lat": 1.2, "lon": 2.2}])));
        assert!(bad(json!([
            {"lat": "1.0", "lon": 2.0}, {"lat": 1.1, "lon": 2.1}, {"lat": 1.2, "lon": 2.2}
        ])));
        // 越界（把地图拉飞的那种）
        assert!(bad(json!([
            {"lat": 91.0, "lon": 2.0}, {"lat": 1.1, "lon": 2.1}, {"lat": 1.2, "lon": 2.2}
        ])));
        assert!(bad(json!([
            {"lat": 1.0, "lon": 181.0}, {"lat": 1.1, "lon": 2.1}, {"lat": 1.2, "lon": 2.2}
        ])));
        // 空几何
        assert!(ring_of(&[]).is_none());
    }

    #[test]
    fn geojson_shape_and_stats_add_up() {
        let osm = json!({"elements": [
            {"type": "way", "id": 1, "geometry": square_geom(29.563, 106.5516),
             "tags": {"building": "apartments", "building:height": "30", "name": "测试楼"}},
            {"type": "way", "id": 2, "geometry": square_geom(29.564, 106.5526),
             "tags": {"building": "yes", "building:levels": "5"}},
            {"type": "way", "id": 3, "geometry": square_geom(29.565, 106.5536),
             "tags": {"building": "house"}},
            // 关系（multipolygon）：计数但不渲染
            {"type": "relation", "id": 9, "tags": {"building": "yes"}},
            // 几何坏掉的 way
            {"type": "way", "id": 4, "geometry": [{"lat": 1.0, "lon": 2.0}], "tags": {"building": "yes"}},
            // 不是建筑的要素（不该混进来）
            {"type": "node", "id": 5, "tags": {"amenity": "cafe"}},
        ]});

        let (fc, st) = buildings_geojson(&osm);
        assert_eq!(fc["type"], "FeatureCollection");
        let feats = fc["features"].as_array().unwrap();
        assert_eq!(feats.len(), 3, "只有 3 条是能画的 way");
        assert_eq!(st["count"], json!(3));

        // 🔴 关键不变量：三档来源之和 == 画出来的栋数（分布不能自己骗自己）
        let h = st["height_source"]["height"].as_u64().unwrap();
        let l = st["height_source"]["levels"].as_u64().unwrap();
        let d = st["height_source"]["default"].as_u64().unwrap();
        assert_eq!((h, l, d), (1, 1, 1));
        assert_eq!(h + l + d, st["count"].as_u64().unwrap());

        // 细一档的标签分布同样是"可加"的
        let t = &st["height_tag"];
        assert_eq!(
            t["building:height"].as_u64().unwrap()
                + t["height"].as_u64().unwrap()
                + t["building:levels"].as_u64().unwrap()
                + t["default"].as_u64().unwrap(),
            st["count"].as_u64().unwrap()
        );
        assert_eq!(t["building:height"], json!(1));
        assert_eq!(t["height"], json!(0), "样本里没有通用 height 标签");

        // 没画出来的必须被计数（"少画了"不能伪装成"这里没有"）
        assert_eq!(st["skipped"]["relation"], json!(1));
        assert_eq!(st["skipped"]["geometry"], json!(1));
        assert_eq!(st["skipped"]["other"], json!(1));

        // 换算常量随数据返回 —— 前端不该自己写 8 / 3
        assert_eq!(st["default_height_m"], json!(DEFAULT_HEIGHT_M));
        assert_eq!(st["levels_meters"], json!(LEVEL_METERS));
        assert_eq!(st["max_height_m"], json!(30.0));
        assert_eq!(st["median_height_m"], json!(15.0), "15(默认8/层数15/高度30) 的上中位数");

        // 逐栋的属性：高度 + 来源 + 原始标签都要带上
        let f0 = &feats[0]["properties"];
        assert_eq!(f0["height"], json!(30.0));
        assert_eq!(f0["height_src"], json!("height"));
        assert_eq!(f0["height_tag"], json!("building:height"));
        assert_eq!(f0["kind"], json!("apartments"));
        assert_eq!(f0["name"], json!("测试楼"));
        assert_eq!(f0["osm_id"], json!("way/1"));
        assert_eq!(feats[2]["properties"]["height"], json!(DEFAULT_HEIGHT_M));
        assert_eq!(feats[2]["properties"]["height_src"], json!("default"));
        assert_eq!(feats[2]["properties"]["name"], Value::Null, "没名字就给 null 不是空串");
        assert_eq!(feats[1]["properties"]["levels"], json!(5.0));

        // 每条几何都是**闭合的 Polygon**
        for f in feats {
            assert_eq!(f["geometry"]["type"], json!("Polygon"));
            let ring = f["geometry"]["coordinates"][0].as_array().unwrap();
            assert!(ring.len() >= 4);
            assert_eq!(ring[0], ring[ring.len() - 1], "环必须闭合：{f}");
        }
    }

    #[test]
    fn geojson_tolerates_junk_input() {
        // 没有 elements：给空 FC + 全 0 的统计，**不 panic、也不返回 None**
        let (fc, st) = buildings_geojson(&json!({}));
        assert_eq!(fc["features"].as_array().unwrap().len(), 0);
        assert_eq!(st["count"], json!(0));
        assert_eq!(st["max_height_m"], json!(0.0));
        assert_eq!(st["median_height_m"], json!(0.0));

        // elements 不是数组
        let (fc, _) = buildings_geojson(&json!({"elements": 5}));
        assert_eq!(fc["features"].as_array().unwrap().len(), 0);

        // 元素不是对象
        let (fc, st) = buildings_geojson(&json!({"elements": [1, "x", null]}));
        assert_eq!(fc["features"].as_array().unwrap().len(), 0);
        assert_eq!(st["skipped"]["other"], json!(3));

        // way 没有 tags：仍然要画出来（默认高度），不能因为没标签就丢
        let (fc, st) = buildings_geojson(&json!({"elements": [
            {"type": "way", "id": 7, "geometry": square_geom(29.5, 106.5)}
        ]}));
        assert_eq!(fc["features"].as_array().unwrap().len(), 1);
        assert_eq!(st["height_source"]["default"], json!(1));
        assert_eq!(fc["features"][0]["properties"]["kind"], json!("yes"));
    }

    /// 端到端形状：真缓存文件（如果本机有）也要能被解析成合法 GeoJSON。
    /// 没有缓存就跳过断言（不联网 —— 单测绝不依赖 Overpass 可用性）。
    #[test]
    fn parses_real_cached_payload_if_present() {
        let dir = PathBuf::from(
            std::env::var("WM_OSM_DIR").unwrap_or_else(|_| {
                format!(
                    "{}/rikka/Dsh-SYuki/world_map/worlddata/osm",
                    std::env::var("HOME").unwrap_or_default()
                )
            }),
        );
        let mut checked = 0;
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.starts_with(BUILDINGS_KEY_PREFIX) || !name.ends_with(".json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(e.path()) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let (fc, st) = buildings_geojson(&v);
                let n = fc["features"].as_array().unwrap().len() as u64;
                assert_eq!(n, st["count"].as_u64().unwrap(), "{name}: count 与实际要素数不符");
                for f in fc["features"].as_array().unwrap() {
                    let h = f["properties"]["height"].as_f64().unwrap();
                    assert!(h > 0.0 && h <= MAX_HEIGHT_M, "{name}: 楼高出界 {h}");
                    let ring = f["geometry"]["coordinates"][0].as_array().unwrap();
                    assert_eq!(ring[0], ring[ring.len() - 1], "{name}: 环未闭合");
                }
                checked += 1;
            }
        }
        // 只是提示，不是失败：本机没有缓存是正常状态
        eprintln!("[osm::tests] 真缓存解析检查了 {checked} 份 bldg_*.json");
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// 真实楼体 → 草图生成器的输入（B 方案的地基，2026-09-19 自主轮次 16）
//
// 为什么需要（实测结论，别再回头试 A）：渝中区 400m 的 **152 栋真实楼体**量出来，
// 真实城市肌理**主朝向 ≈30~40°**（渝中区顺江岸斜着长），而 `make_sketch` 生成的是
// **轴对齐（0°/90°）井字路网**，差 30~40°；更致命的是草图楼体位置是 **RNG 生成**
// ⇒ **逐栋对齐在数学上不可能**。所以不是"把草图贴到真实地图上"，而是
// **反过来：让草图按真实数据长出来**（按真实朝向排路网、楼放在真实相对位置）。
//
// 这个函数只做第一件事：**从真实楼体的边里估出主朝向**。
// ⚠️ 用**边长加权**而不是"数边"：长边（临街立面）才代表街区走向，短边多是阳台/凹凸。
// ⚠️ 角度取**模 90°**：矩形街区的两个方向等价（0° 与 90° 是同一套肌理）。
// ══════════════════════════════════════════════════════════════════════════════

/// 从一组多边形环里估主朝向：返回 `(度数 0~90, 强度 0~1)`。
/// 强度 = 峰值桶（5° 宽）的边长占比 —— 越高说明城市肌理越规整。
pub fn dominant_orientation_deg(rings: &[Vec<[f64; 2]>]) -> (f64, f64) {
    let mut bins = [0.0f64; 18];
    let mut total = 0.0f64;
    for ring in rings {
        if ring.len() < 2 {
            continue;
        }
        for i in 0..ring.len() - 1 {
            let dx = ring[i + 1][0] - ring[i][0];
            let dy = ring[i + 1][1] - ring[i][1];
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-12 {
                continue;
            }
            let ang = dy.atan2(dx).to_degrees();
            // 模 90°（负数也要落进 [0,90)）
            let m = ((ang % 90.0) + 90.0) % 90.0;
            let idx = ((m / 5.0) as usize).min(17);
            bins[idx] += len;
            total += len;
        }
    }
    if total <= 0.0 {
        return (0.0, 0.0);
    }
    let mut best = 0usize;
    for i in 1..bins.len() {
        if bins[i] > bins[best] {
            best = i;
        }
    }
    (best as f64 * 5.0 + 2.5, bins[best] / total)
}

/// 把 Overpass 的建筑 `way`（`out geom` 的 `geometry: [{lat,lon},…]`）转成环。
/// 只取闭合主环；点少于 4 个（含首尾重复）直接丢。
pub fn building_rings(osm: &serde_json::Value) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let els = match osm.get("elements").and_then(|e| e.as_array()) {
        Some(a) => a,
        None => return out,
    };
    for el in els {
        let geom = match el.get("geometry").and_then(|g| g.as_array()) {
            Some(a) => a,
            None => continue,
        };
        let mut ring: Vec<[f64; 2]> = Vec::with_capacity(geom.len());
        for p in geom {
            let lat = p.get("lat").and_then(|v| v.as_f64());
            let lon = p.get("lon").and_then(|v| v.as_f64());
            if let (Some(la), Some(lo)) = (lat, lon) {
                ring.push([lo, la]); // 统一成 [经度, 纬度]，与前端 wsBuildingHint 一致
            }
        }
        if ring.len() >= 4 {
            out.push(ring);
        }
    }
    out
}

#[cfg(test)]
mod orientation_tests {
    use super::*;
    use serde_json::json;

    /// 造一个旋转 θ 度的矩形环（度为单位，尺度不影响朝向估计）
    fn rect(cx: f64, cy: f64, w: f64, h: f64, deg: f64) -> Vec<[f64; 2]> {
        let t = deg.to_radians();
        let (c, s) = (t.cos(), t.sin());
        let pts = [
            (-w / 2.0, -h / 2.0),
            (w / 2.0, -h / 2.0),
            (w / 2.0, h / 2.0),
            (-w / 2.0, h / 2.0),
            (-w / 2.0, -h / 2.0),
        ];
        pts.iter()
            .map(|(x, y)| [cx + x * c - y * s, cy + x * s + y * c])
            .collect()
    }

    #[test]
    fn 轴对齐矩形的主朝向是零度附近() {
        let (deg, strength) = dominant_orientation_deg(&[rect(0.0, 0.0, 0.001, 0.0004, 0.0)]);
        assert!(deg <= 5.0, "deg={deg}");
        assert!(strength > 0.8, "strength={strength}");
    }

    #[test]
    fn 旋转三十五度能估出来() {
        let (deg, _) = dominant_orientation_deg(&[rect(0.0, 0.0, 0.001, 0.0004, 35.0)]);
        assert!((deg - 35.0).abs() <= 5.0, "deg={deg}");
    }

    #[test]
    fn 近似九十度也算轴对齐的那条轴() {
        // 模 90° 之后 88° 仍落在 88 附近（= 90° 那条轴），**不是** 2.5
        let (deg, _) = dominant_orientation_deg(&[rect(0.0, 0.0, 0.001, 0.0004, 88.0)]);
        let to_axis = deg.min(90.0 - deg);
        assert!(to_axis <= 5.0, "deg={deg}");
    }

    #[test]
    fn 两个正交方向会把强度摊薄() {
        let rings = vec![
            rect(0.0, 0.0, 0.001, 0.0004, 10.0),
            rect(0.0, 0.0, 0.001, 0.0004, 60.0),
        ];
        let (_, mixed) = dominant_orientation_deg(&rings);
        let (_, single) = dominant_orientation_deg(&[rect(0.0, 0.0, 0.001, 0.0004, 10.0)]);
        assert!(mixed < single, "mixed={mixed} single={single}");
    }

    #[test]
    fn 空输入不炸() {
        assert_eq!(dominant_orientation_deg(&[]), (0.0, 0.0));
        assert_eq!(dominant_orientation_deg(&[vec![]]), (0.0, 0.0));
    }

    #[test]
    fn 从_overpass_建筑里抽环_经纬度顺序是经度在前() {
        let osm = json!({"elements": [
            {"type":"way","id":1,"geometry":[
                {"lat":29.1,"lon":106.1},{"lat":29.1,"lon":106.2},
                {"lat":29.2,"lon":106.2},{"lat":29.2,"lon":106.1}
            ]},
            {"type":"node","id":2},
            {"type":"way","id":3,"geometry":[{"lat":29.1,"lon":106.1}]}
        ]});
        let rings = building_rings(&osm);
        assert_eq!(rings.len(), 1, "只有一条合法闭合环（node 与点太少的 way 被丢）");
        assert_eq!(rings[0][0], [106.1, 29.1], "必须是 [经度, 纬度]");
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// 真实楼体 → 草图生成器的「相对坐标 + 高度」清单（B 方案第 2 块，自主轮次 17）
//
// 上一步已能从真实楼体估出**主朝向**；这一步把楼体本身整理成生成器能直接吃的形式：
//   · 坐标**归一化到 0~1**（相对包围盒），与草图的 `size×size` 网格解耦 ——
//     生成器乘一下 size 就能用，不必知道经纬度；
//   · 每栋带 `height_m` 与 `src`（height / levels / default 三态留痕），
//     让"楼高覆盖率低"这件事在**生成阶段**就可量化，而不是等画出来才发现一片 8m；
//   · 按占地**降序**并截断（生成器只画得下前 N 栋；地标/大楼优先）。
//
// ⚠️ 高度 fallback 链与前端 `wsBuildingHint.ts` 同口径：height → levels×3 → 默认 8m。
// ══════════════════════════════════════════════════════════════════════════════

/// 一栋真实楼（归一化坐标 + 高度）
#[derive(Debug, Clone, PartialEq)]
pub struct HintBuilding {
    /// 占地中心的归一化坐标（0~1，左上为原点；与草图网格同向）
    pub x: f64,
    pub y: f64,
    /// 占地面积的**相对值**（用于排序与"这栋大不大"的判断，非平方米）
    pub area: f64,
    pub height_m: f64,
    /// "height" / "levels" / "default"
    pub src: &'static str,
    /// OSM 名字（地标优先用），没有就是空串
    pub name: String,
}

/// 多边形环的面积（平面 shoelace；坐标是经纬度，只作**相对**比较）
fn ring_area_rel(ring: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len().saturating_sub(1) {
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    (a / 2.0).abs()
}

/// 面积质心（**不用顶点平均**：密集顶点会把中心带跑 —— 前端 wsgame 上真踩过这个坑）
fn ring_centroid(ring: &[[f64; 2]]) -> Option<(f64, f64)> {
    if ring.len() < 3 {
        return None;
    }
    let mut a = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..ring.len() - 1 {
        let (x0, y0) = (ring[i][0], ring[i][1]);
        let (x1, y1) = (ring[i + 1][0], ring[i + 1][1]);
        let cross = x0 * y1 - x1 * y0;
        a += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    if a.abs() < 1e-15 {
        // 退化（共线/面积≈0）→ 退回顶点平均，至少给个位置
        let n = (ring.len() - 1).max(1) as f64;
        let sx: f64 = ring[..ring.len() - 1].iter().map(|p| p[0]).sum();
        let sy: f64 = ring[..ring.len() - 1].iter().map(|p| p[1]).sum();
        return Some((sx / n, sy / n));
    }
    Some((cx / (3.0 * a), cy / (3.0 * a)))
}

/// 由 OSM 元素取"高度 + 来源"（与前端同口径）
fn height_of(tags: &serde_json::Map<String, serde_json::Value>) -> (f64, &'static str) {
    if let Some(h) = tags.get("height").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok())) {
        if h > 0.0 {
            return (h, "height");
        }
    }
    if let Some(l) = tags.get("building:levels").and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok())) {
        if l > 0.0 {
            return (l * 3.0, "levels");
        }
    }
    (8.0, "default")
}

/// 把 Overpass 建筑整理成生成器输入：`(主朝向度, 强度, 归一化楼体清单)`
///
/// @param max_n 最多返回多少栋（按占地降序；生成器画不下的部分直接丢，**但调用方应把
///              `total` 与实际返回数的差值显示出来**，别悄悄少画）
pub fn hint_buildings(osm: &serde_json::Value, max_n: usize) -> (f64, f64, Vec<HintBuilding>, usize) {
    let rings = building_rings(osm);
    let (deg, strength) = dominant_orientation_deg(&rings);

    // 归一化的包围盒（只由**有效环**决定；没有楼就返回空）
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for r in &rings {
        for p in r {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
            min_y = min_y.min(p[1]);
            max_y = max_y.max(p[1]);
        }
    }
    if !min_x.is_finite() || max_x <= min_x || max_y <= min_y {
        return (deg, strength, Vec::new(), 0);
    }
    let w = max_x - min_x;
    let h = max_y - min_y;

    let els = osm.get("elements").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let mut out: Vec<HintBuilding> = Vec::new();
    for el in &els {
        let geom = match el.get("geometry").and_then(|g| g.as_array()) {
            Some(a) => a,
            None => continue,
        };
        let mut ring: Vec<[f64; 2]> = Vec::with_capacity(geom.len());
        for p in geom {
            if let (Some(la), Some(lo)) = (
                p.get("lat").and_then(|v| v.as_f64()),
                p.get("lon").and_then(|v| v.as_f64()),
            ) {
                ring.push([lo, la]);
            }
        }
        if ring.len() < 4 {
            continue;
        }
        let Some((cx, cy)) = ring_centroid(&ring) else { continue };
        let tags = el.get("tags").and_then(|t| t.as_object()).cloned().unwrap_or_default();
        let (h_m, src) = height_of(&tags);
        let name = tags.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        out.push(HintBuilding {
            x: (cx - min_x) / w,
            // ⚠️ y 轴翻转：纬度向上、网格向下（与前端 wsGridGeo 的约定一致；写错整张图上下颠倒）
            y: (max_y - cy) / h,
            area: ring_area_rel(&ring) / (w * h),
            height_m: h_m,
            src,
            name,
        });
    }
    let total = out.len();
    out.sort_by(|a, b| b.area.partial_cmp(&a.area).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(max_n);
    (deg, strength, out, total)
}

#[cfg(test)]
mod hint_buildings_tests {
    use super::*;
    use serde_json::json;

    fn way(id: u64, lng: f64, lat: f64, side: f64, tags: serde_json::Value) -> serde_json::Value {
        json!({"type":"way","id":id,"tags":tags,"geometry":[
            {"lon":lng,"lat":lat},
            {"lon":lng+side,"lat":lat},
            {"lon":lng+side,"lat":lat+side},
            {"lon":lng,"lat":lat+side},
            {"lon":lng,"lat":lat}
        ]})
    }

    #[test]
    fn 归一化坐标落在零到一之间且_y_轴翻转正确() {
        // 左下角那栋应在 y≈1（网格向下），右上角那栋应在 y≈0
        let osm = json!({"elements": [
            way(1, 106.0, 29.0, 0.001, json!({"height": 30})),
            way(2, 106.009, 29.009, 0.001, json!({"height": 30}))
        ]});
        let (_, _, list, total) = hint_buildings(&osm, 10);
        assert_eq!(total, 2);
        assert_eq!(list.len(), 2);
        let low_left = list.iter().find(|b| b.x < 0.5).expect("左下");
        let up_right = list.iter().find(|b| b.x > 0.5).expect("右上");
        assert!(low_left.y > 0.9, "左下角 y 应接近 1，实际 {}", low_left.y);
        assert!(up_right.y < 0.1, "右上角 y 应接近 0，实际 {}", up_right.y);
        for b in &list {
            assert!((0.0..=1.0).contains(&b.x) && (0.0..=1.0).contains(&b.y), "越界: {:?}", b);
        }
    }

    #[test]
    fn 高度三态留痕() {
        let osm = json!({"elements": [
            way(1, 106.0, 29.0, 0.001, json!({"height": 120, "name": "高塔"})),
            way(2, 106.002, 29.0, 0.001, json!({"building:levels": 10})),
            way(3, 106.004, 29.0, 0.001, json!({}))
        ]});
        let (_, _, list, _) = hint_buildings(&osm, 10);
        let by = |n: &str| list.iter().find(|b| b.name == n).cloned();
        assert_eq!(by("高塔").unwrap().height_m, 120.0);
        assert_eq!(by("高塔").unwrap().src, "height");
        assert_eq!(list.iter().find(|b| b.src == "levels").unwrap().height_m, 30.0);
        assert_eq!(list.iter().find(|b| b.src == "default").unwrap().height_m, 8.0);
    }

    #[test]
    fn 按占地降序并截断但_total_如实() {
        let osm = json!({"elements": [
            way(1, 106.000, 29.000, 0.001, json!({})),
            way(2, 106.005, 29.005, 0.004, json!({})),   // 更大
            way(3, 106.002, 29.002, 0.002, json!({}))
        ]});
        let (_, _, list, total) = hint_buildings(&osm, 2);
        assert_eq!(total, 3, "total 必须是真实总数（别让调用方以为只有 2 栋）");
        assert_eq!(list.len(), 2, "截断到 max_n");
        assert!(list[0].area >= list[1].area, "必须按占地降序");
    }

    #[test]
    fn 空与退化输入不炸() {
        assert_eq!(hint_buildings(&json!({}), 5).3, 0);
        assert_eq!(hint_buildings(&json!({"elements":[]}), 5).3, 0);
        // 只有 3 个点（不闭合、不成面）→ 丢
        let bad = json!({"elements":[{"type":"way","id":9,"geometry":[
            {"lon":106.0,"lat":29.0},{"lon":106.1,"lat":29.0},{"lon":106.1,"lat":29.1}]}]});
        assert_eq!(hint_buildings(&bad, 5).3, 0);
    }
}
