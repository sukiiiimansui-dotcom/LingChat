//! 世界地图 Rust 后端（T6-5）
//!
//! 模块本体来自独立真源工程 `~/rikka/Dsh-SYuki/world_map_rs/src/`（纯 Rust、无 Tauri 依赖，
//! 在那边能单独编译并跑单元测试）。搬进来时只做了两件事：
//!   1. 模块之间的跨模块引用加 `world_map::` 前缀（`crate::coord` → `crate::world_map::coord`）
//!   2. 真源 `main.rs` 的 axum 路由**没有**搬 —— 那是独立调试 HTTP 服务的入口，不是 Tauri 的东西
//!
//! 分层：coord（坐标/几何） · geo（地理数据与区块） · sketch/details/render（小区生成与渲染）
//!      · render_geo（行政区划渲染） · stats（统计） · stream（流式生成） · maplib（地图库）
//!      · osm（Overpass 真实地物） · transport（交通） · schedule（日程 → 地图位置）
//! 前端通过 `world_map_*` 命令调用；Python 侧车仍可并存（前端 `USE_RUST` 决定走哪边）。
// 应用内实时绘制通路（Tauri 命令 + Channel）—— 只做「搬运」，生成逻辑仍复用 `stream`
pub mod bridge;
pub mod coord;
pub mod details;
// P4-1：AI 位置指令（⟦wm:{…}⟧）的剥离器。纯函数 + 流式状态机，不依赖 tauri，
// 由 `ai_service/message_system/producer.rs` 在**切句之前**调用（选型理由见文件头）。
pub mod directive;
// 真实地形着色（分层设色，SRTM 90m 采样成 1° 网格内嵌）。纯函数模块、不碰网络，
// 被 `render_geo` 消费，把「全国级真实地理」里的**高度**画进行政区划图。
pub mod elevation;
// P5-2 / P5-3：事件引擎的**接线层**（3 条 Tauri 命令 + `world_map:event` 广播 +
// 待写记忆队列）。上游是纯函数模块 `events.rs`，下游是前端与记忆管线。
// 组上下文 / 闸门 / drain 这些判定逻辑都抽成了不依赖 `AppHandle` 的纯函数
// （能脱离工程 `rustc --test` 真跑单测，理由见 event_cmd.rs 文件头）。
// 注册必须带全路径：`world_map::event_cmd::world_map_tick`（命令宏在定义处生成，
// 写短了会 E0433 —— 本项目踩过）。
pub mod event_cmd;
// P5-1：现实事件引擎（10 类 · 41 条事件 · 加权随机 + 冷却 + 全局节流 + 四通道文案）。
// 与 directive/summary 同属**纯函数模块**：不 import tauri、不读系统时间、不取随机数
// （now_secs / roll / rng 全从参数进来），所以能脱离工程 `rustc --test` 跑单测。
// **本文件自己不暴露 Tauri 命令**：命令在 `event_cmd.rs`，那边负责组 `EventContext`、
// 落 MapRuntime 并广播给前端。
pub mod events;
pub mod facilities;
pub mod geo;
// 真实水系图层（河流/湖泊，Natural Earth 1:50m 内嵌）。纯函数模块、不碰网络，
// 被 `render_geo` 消费，用来把「全国级真实地理」画进行政区划图。
pub mod hydro;
// AI 精绘布局的几何净化（剔重叠 / 夹越界 / 丢退化）。纯函数模块，
// 挂在 `stream::assemble_layout` 出口，补上「提示词要求了但没人执行」的那道闸。
pub mod layout_clean;
// 实时数据通路：定位（world_map_location）+ 天气（world_map_weather）。
// 同样要按**完整路径**注册：world_map::live::world_map_location —— 命令宏在定义处
// （本文件的子模块 live.rs）生成，写 world_map::world_map_location 会 E0433。
pub mod live;
// Android 真实定位桥（`world_map_location` 的第 ② 条路，见 live.rs 的优先级说明）。
// 它**不暴露任何 Tauri 命令**，只有一个要在 lib.rs 的 Builder 上注册的 Tauri 插件
// （`world_map::loc_android::init()`）—— 所以不用加进 invoke_handler。
// 非 Android 平台上这个模块是空转的（`locate()` 直接返回 Unavailable），
// 桌面端行为与改动前完全一致。
pub mod loc_android;
pub mod maplib;
// P4-2 / P4-3：移动状态机。
//   · `r#move`（文件是 move.rs，`move` 是 Rust 关键字，模块名只能写原生标识符）
//     —— 纯逻辑：出行方式速度表、按时间戳插值、进程级行程注册表。**不依赖 tauri**，
//        所以能脱离工程单独 `rustc --test` 跑单测（手机上没有编译预算）。
//   · `move_cmd` —— Tauri 命令层 + 派发胶水（读 MapRuntime 快照 → 起行程 → 落事件）。
//     四条命令注册时必须带 `world_map::move_cmd::` 前缀（命令宏在定义处生成，
//     理由同下面的 bridge/live/state，写短了会 E0433）：
//     `world_map_trip_status` / `world_map_trip_start` /
//     `world_map_trip_cancel` / `world_map_trip_speedup`
pub mod r#move;
pub mod move_cmd;
pub mod osm;
pub mod render;
pub mod render_geo;
pub mod schedule;
pub mod sketch;
// P3 的两个新模块（世界模拟：运行时状态 → AI 工具 → 对话注入）：
//   · state   —— 进程内共享的地图运行时状态（内含 `world_map_update_runtime` /
//                `world_map_runtime` 两条命令，注册同样要带 `world_map::state::` 前缀）
//   · summary —— 注入摘要 + 字段级合并的**纯函数**层：不依赖 tauri/tokio/reqwest，
//                可以脱离工程单独 `rustc --test` 跑单测（注入点在 game_status 锁内，
//                绝不能 await 网络，所以往外拆一层反而更好验证）
pub mod state;
pub mod stats;
// T5-1：城市级**真拼接**大图 —— 把一个市下辖各区县的**街区图**按经纬度网格拼成一张大图。
// 与 `geo_svg`/`bigmap`（行政区划总览）是两件事：那边画区县轮廓，这边每块都是街区图。
//   · `stitch`     —— 纯逻辑：选块（重要性 + 分页）→ 定格距（候选里挑方位错最少的）
//                     → 落格（撞格外扩 + 成对交换精修）→ 由画布上限反推块像素与网格数
//                     → 逐块渲染 → 拼装（外框 + 编号/区县名 + 裁掉块内标题条）→ 走 maplib 缓存。
//                     **不依赖 tauri**，可脱离工程 `rustc --test` 跑单测（手机上没编译预算）。
//   · `stitch_cmd` —— Tauri 命令层（`world_map_bigmap_svg` / `world_map_bigmap_plan`）。
//                     注册必须带全路径：`world_map::stitch_cmd::world_map_bigmap_svg`
//                     （命令宏在定义处生成，写短了会 E0433 —— 本项目踩过）。
pub mod stitch;
pub mod stitch_cmd;
pub mod stream;
pub mod summary;
pub mod transport;

// ── P 系列补齐的两个**纯函数**模块（不 import tauri，可脱离工程 rustc --test 真跑）──
//   · bookmark —— P3-1 地图存档书签：adcode 链路 / 小区 seed / 地图库 key 的
//                 抽取、恢复 patch 与老存档兼容（`#[serde(default)]`）。
//                 放在这里而不是 game_status.rs：存档兼容性不该只能靠"看代码"验证。
//   · offline  —— P5-4 离线可用性：本地缓存有什么、要看的区域能不能离线命中。
//                 判据只有"本地有没有这份缓存"，**从不 ping 网络**
//                 （最需要离线的时候不该再等一次超时）。
pub mod bookmark;
pub mod offline;

// 注意：`bridge` 里的两个命令要按**完整路径**注册进 lib.rs 的 invoke_handler：
//   world_map::bridge::world_map_district_stream / ..._cancel
// 不能写 `world_map::world_map_district_stream` —— 命令宏除了函数本体，还会在
// **定义它的模块里**生成 `pub use {__cmd__xxx, __tauri_command_name_xxx}`（见
// tauri-macros/src/command/wrapper.rs 末尾「allow the macro to be resolved with the
// same path as the command function」），generate_handler 就是拿这条路径去找宏的。
// 在 mod.rs 里 `pub use bridge::world_map_district_stream;` **只导出函数、不导出宏**，
// 那样写编译期直接 E0433（已用 rustc 复现验证）。

use chrono::{Datelike, Timelike};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::AppHandle;

/// 世界模拟在应用数据目录下的**根目录**（`geo/`、`maplib/`、`osm/`、`events.json` 都在它下面）。
///
/// ## 为什么是点开头的 `.world_map`（而别的数据都是 `data/<名字>/`）
///
/// `lan_sync` 的同步语义是**镜像 + 删除**：`manifest.rs` 递归扫 `data_dir()`，
/// 凡是「本地有、对端没有」的文件，pull 时会 `rename` 进 `data/.trash/`
/// （`sync_engine.rs`），push 时还会通知对端删。而它的 `scan_dir` **跳过所有点开头的条目**
/// （`lan_sync/manifest.rs:64`）—— 点前缀就是"不参与同步"的官方开关。
///
/// 地图的这些东西全是**本地生成物**：geojson 缓存、地图库（AI 生成的小区布局）、
/// OSM 快照、事件流。它们不该因为用户开了一次局域网同步就被搬进回收站。
/// 改个目录名就能让整套同步逻辑看不见它们，**零主干改动**（比去改排除表安全得多）。
///
/// `WM_MAPLIB_DIR` / `WM_OSM_DIR` 仍可单独覆盖（测试隔离用），优先级高于这里。
fn world_root() -> PathBuf {
    crate::api::data_dir().join(".world_map")
}

/// 地理数据缓存目录（应用数据目录下）
pub fn cache_dir(_app: &AppHandle) -> PathBuf {
    world_root().join("geo")
}

/// 额外的**只读**地理数据目录：开发期沿用已经下好的缓存，避免重复下载。
///
/// 只认环境变量 `WM_EXTRA_DIRS`（用 `:` 或 `;` 分隔多个路径），**不猜任何机器上的路径**。
///
/// ⚠️ 这里原先硬编码过 `$HOME/rikka/Dsh-SYuki/world_map/worlddata/cn` 之类的候选目录 ——
/// 那是开发机的私有布局，写进上游仓库等于让每个用户的启动路径都去 stat 一串
/// 根本不存在的目录（移动端 `$HOME` 更是应用私有目录，永远不命中）。
/// 现在不设这个变量就返回空表，行为与没有这段逻辑完全一致；
/// 需要预热的开发者在自己的 shell 里 `export WM_EXTRA_DIRS=...` 即可。
fn extra_dirs() -> Vec<PathBuf> {
    let Some(raw) = std::env::var_os("WM_EXTRA_DIRS") else {
        return Vec::new();
    };
    raw.to_string_lossy()
        .split(|c| c == ':' || c == ';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
}

/// 建一个地理数据源：主缓存目录 + 额外只读目录（后者会按需复制进主缓存）
fn make_source(app: &AppHandle) -> geo::GeoSource {
    let dir = cache_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    // 把只读目录里的缓存预热进来（已存在的不覆盖）
    for src in extra_dirs() {
        if let Ok(rd) = std::fs::read_dir(&src) {
            for e in rd.flatten() {
                let name = e.file_name();
                let dst = dir.join(&name);
                if !dst.exists() {
                    let _ = std::fs::copy(e.path(), &dst);
                }
            }
        }
    }
    geo::GeoSource::new(dir)
}

/// 世界地图数据根目录：`geo/`（geojson 缓存）、`maplib/`、`osm/`、`events.json` 都在它下面。
///
/// 注意：`docs/world-map/07` 里规划的是 `<data_dir>/game_data/world_map/`，
/// 而这里是 [`world_root`]（`<data_dir>/.world_map/`，点前缀是为了不被 `lan_sync` 同步，
/// 理由见那个函数的文档）。新模块跟着**已有代码**走，避免同一个功能出现两个数据根。
fn world_dir(_app: &AppHandle) -> PathBuf {
    world_root()
}

/// 地图库根目录（索引 index.json + 布局 layouts/*.json）。
/// `WM_MAPLIB_DIR` 可覆盖：测试/自检必须走隔离目录，绝不能碰真实地图库。
fn maplib_root(app: &AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("WM_MAPLIB_DIR") {
        return PathBuf::from(p);
    }
    world_dir(app).join("maplib")
}

/// Overpass（OSM）缓存目录。`WM_OSM_DIR` 可覆盖，同样是为了测试隔离。
fn osm_dir(app: &AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("WM_OSM_DIR") {
        return PathBuf::from(p);
    }
    world_dir(app).join("osm")
}

/// 前端可能直接给对象、也可能给 JSON 字符串（invoke 的参数有时是序列化过的），两种都认。
fn normalize_layout(v: Option<Value>) -> Option<Value> {
    match v? {
        Value::String(s) => serde_json::from_str::<Value>(&s).ok(),
        Value::Null => None,
        other => Some(other),
    }
}

/// 取一份可直接渲染/统计的 layout（已经挂好街道细节），三种来源按优先级：
/// `layout` 参数 → 地图库布局缓存 `key` → 本地规则草图 `area/size/seed`。
fn resolve_layout(
    app: &AppHandle,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
) -> Result<Value, String> {
    let mut lay = if let Some(v) = normalize_layout(layout) {
        v
    } else if let Some(k) = key.filter(|k| !k.trim().is_empty()) {
        let lib = maplib::MapLib::new(maplib_root(app));
        lib.get_layout(&k)
            .ok_or_else(|| format!("地图库里没有布局缓存：{k}"))?
    } else {
        sketch::make_sketch(
            area.as_deref().unwrap_or("广州市·越秀区"),
            size.unwrap_or(20),
            seed,
            None,
        )
    };
    if !lay.is_object() {
        return Err("layout 必须是一个 JSON 对象".to_string());
    }
    details::enrich(&mut lay);
    Ok(lay)
}

/// 把 LingChat 的真实数据目录告诉 `schedule` 模块。
///
/// `schedule.rs` 的数据目录发现逻辑是「按 `$HOME/...` 候选路径猜」（在真源工程里够用），
/// 而 Tauri 应用的真实数据目录由平台决定（Android 上是应用私有目录），猜不到。
/// 它支持 `WM_LINGCHAT_DATA` 显式指定，所以这里把已知的正确路径喂进去；
/// 用户/测试已经设过就绝不覆盖（测试要靠它锁定数据源）。
fn bridge_lingchat_data_dir() {
    if std::env::var_os("WM_LINGCHAT_DATA").is_some() {
        return;
    }
    let d = crate::api::data_dir();
    if d.join("game_data").is_dir() {
        std::env::set_var("WM_LINGCHAT_DATA", &d);
    }
}

/// 从 `{lat, lng}` / `{lat, lon}` / `[lng, lat]` 里取一个分量（transport 参数的兼容层）
fn point_part(p: &Value, key: &str) -> Option<f64> {
    let names: &[&str] = if key == "lat" {
        &["lat", "latitude"]
    } else {
        &["lng", "lon", "longitude"]
    };
    if let Some(o) = p.as_object() {
        for n in names {
            if let Some(v) = o.get(*n).and_then(|x| x.as_f64()) {
                return Some(v);
            }
        }
    }
    if let Some(a) = p.as_array() {
        let idx = if key == "lat" { 1 } else { 0 };
        return a.get(idx).and_then(|x| x.as_f64());
    }
    None
}

/// 时段（与 Python 侧 `/api/time` 的 period 字段同一张表）
fn period_of(h: i32) -> &'static str {
    match h {
        5..=7 => "dawn",
        8..=10 => "morning",
        11..=13 => "noon",
        14..=16 => "afternoon",
        17..=18 => "dusk",
        19..=22 => "evening",
        _ => "night",
    }
}

/// 主块 + 远处块（T1-3）
#[tauri::command]
pub async fn world_map_blocks(
    app: AppHandle,
    ad: Option<String>,
    remote: Option<String>,
    style: Option<String>,
    scale: Option<u32>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let src = make_source(&app);
    let main_ad = ad.unwrap_or_else(|| "440100".to_string());
    let remotes = remote
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<String>| !v.is_empty());
    // 风格要在调用前定下来：新版 build_blocks 会把它写进 img/img_url
    let style = style.unwrap_or_else(|| "gaode".to_string());
    let mut out = geo::build_blocks(
        &src,
        &main_ad,
        remotes,
        limit.unwrap_or(6),
        80.0,
        // 新版 build_blocks 多了一个 style 参数（它会把 style 写进 img/img_url）
        &style,
    )
    .await?;
    // 风格/缩放回填到图片地址里（scale 只有这里知道，所以要覆盖一次）
    let scale = scale.unwrap_or(1).clamp(1, 3);
    if let Some(m) = out.get_mut("main") {
        if let Some(o) = m.as_object_mut() {
            let adc = o
                .get("adcode")
                .and_then(|v| v.as_str())
                .unwrap_or(&main_ad)
                .to_string();
            o.insert(
                "img".into(),
                Value::String(format!("/api/bigmap?ad={adc}&style={style}&scale={scale}")),
            );
            o.insert(
                "img_url".into(),
                Value::String(format!("/api/bigmap_img?ad={adc}&style={style}&scale={scale}")),
            );
            o.insert("style".into(), Value::String(style.clone()));
        }
    }
    if let Some(rs) = out.get_mut("remotes").and_then(|v| v.as_array_mut()) {
        for r in rs.iter_mut() {
            if let Some(o) = r.as_object_mut() {
                let adc = o.get("adcode").and_then(|v| v.as_str()).unwrap_or("").to_string();
                o.insert(
                    "img".into(),
                    Value::String(format!("/api/map?ad={adc}&style={style}")),
                );
            }
        }
    }
    Ok(out)
}

/// 按坐标定主块（用于「按定位」）
#[tauri::command]
pub async fn world_map_blocks_at(
    app: AppHandle,
    lat: f64,
    lng: f64,
    style: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let src = make_source(&app);
    let (ad, _d) = geo::nearest_cached(&src, lng, lat)
        .ok_or_else(|| "本地地理缓存里没有覆盖该坐标的区域".to_string())?;
    world_map_blocks(app, Some(ad), None, style, Some(1), limit).await
}

/// 地理数据状态（调试/自检用）
#[tauri::command]
pub async fn world_map_geo_status(app: AppHandle) -> Result<Value, String> {
    let src = make_source(&app);
    let codes = src.cached_adcodes();
    Ok(serde_json::json!({
        "cacheDir": cache_dir(&app).to_string_lossy(),
        "cachedCount": codes.len(),
        "cached": codes,
        "extraDirs": extra_dirs().iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "source": "rust",
    }))
}

/// 坐标自检（前端/CI 可一键验证几何正确性）
#[tauri::command]
pub async fn world_map_coord_selftest() -> Result<Value, String> {
    let mut checks: Vec<Value> = Vec::new();
    let mut pass = 0usize;
    let mut fail = 0usize;
    let mut check = |name: &str, ok: bool, detail: String| {
        if ok {
            pass += 1;
        } else {
            fail += 1;
        }
        checks.push(serde_json::json!({ "name": name, "ok": ok, "detail": detail }));
    };

    // 往返
    let (lng, lat) = (113.264, 23.129);
    let (x, y) = coord::lng_lat_to_world(lng, lat);
    let (lng2, lat2) = coord::world_to_lng_lat(x, y);
    check(
        "经纬度往返",
        (lng - lng2).abs() < 1e-9 && (lat - lat2).abs() < 1e-9,
        format!("{lng},{lat} → {lng2},{lat2}"),
    );

    // 网格往返
    let (gx, gy) = coord::world_to_grid(x, y, lng, lat, 20.0);
    check("网格往返", gx.abs() < 1e-6 && gy.abs() < 1e-6, format!("{gx},{gy}"));

    // 距离
    let d = coord::haversine_m((113.2644, 23.1291), (114.0579, 22.5431));
    check(
        "广州→深圳约 100km",
        d > 90_000.0 && d < 110_000.0,
        format!("{:.1} km", d / 1000.0),
    );

    // 方位
    let (nx, ny) = coord::edge_point(0.0, 4.0 / 3.0, 0.06);
    check(
        "正北落在顶部中间",
        (nx - 0.5).abs() < 0.02 && ny < 0.1,
        format!("{nx:.3},{ny:.3}"),
    );
    let (ex, ey) = coord::edge_point(90.0, 4.0 / 3.0, 0.06);
    check(
        "正东落在右侧中间",
        ex > 0.9 && (ey - 0.5).abs() < 0.02,
        format!("{ex:.3},{ey:.3}"),
    );

    // 点在多边形内
    let sq = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
    check(
        "射线法判点在多边形内",
        coord::point_in_poly((1.0, 1.0), &sq) && !coord::point_in_poly((3.0, 1.0), &sq),
        "正方形内外各一例".into(),
    );

    Ok(serde_json::json!({
        "pass": pass, "fail": fail, "total": checks.len(),
        "checks": checks, "source": "rust",
    }))
}

/// 渲染某区域为 SVG（T1-2 的 Rust 版）
///
/// 返回 SVG 文本，前端可直接 `<img src="data:image/svg+xml;utf8,...">` 或用 innerHTML 内联。
///
/// 实现已换成真源工程里更完整的 `render_geo.rs`（顶点抽稀、按行政级别配色、区划可点击），
/// 参数与返回值保持不变（`world_map_render_svg(fc, style, w, h, pad, labels)` 的老实现对得上）。
#[tauri::command]
pub async fn world_map_render_svg(
    app: AppHandle,
    ad: String,
    style: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    pad: Option<f64>,
    labels: Option<bool>,
) -> Result<String, String> {
    let src = make_source(&app);
    let fc = src.fetch(&ad).await?;
    let opts = render_geo::GeoOpts {
        level: geo::level_of(&ad).to_string(),
        style: style.unwrap_or_else(|| "gaode".to_string()),
        width: width.unwrap_or(1200.0),
        height: height.unwrap_or(900.0),
        pad: pad.unwrap_or(30.0),
        labels: labels.unwrap_or(true),
        ..Default::default()
    };
    render_geo::render_geo_svg(&fc, &opts)
}

/// 世界事件落盘（T6-3）：地图里的重大事件写到 app 数据目录，
/// LingChat 的主动系统可以读它来决定「要不要拿这件事主动搭话」。
#[tauri::command]
pub async fn world_map_push_events(app: AppHandle, events: Vec<Value>) -> Result<usize, String> {
    if events.is_empty() {
        return Ok(0);
    }
    let p = world_dir(&app).join("events.json");
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut all: Vec<Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default();
    all.extend(events);
    if all.len() > 200 {
        let drop_n = all.len() - 200;
        all.drain(0..drop_n);
    }
    std::fs::write(&p, serde_json::to_string(&all).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(all.len())
}

/// 读最近的世界事件（主动系统 / 调试用）
#[tauri::command]
pub async fn world_map_recent_events(app: AppHandle, limit: Option<usize>) -> Result<Vec<Value>, String> {
    let p = world_dir(&app).join("events.json");
    let all: Vec<Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default();
    let n = limit.unwrap_or(20).min(all.len());
    Ok(all[all.len() - n..].to_vec())
}

// ═══════════════════════════════════════════════════════════════════
//  真源模块搬入后新暴露的命令
//
//  参数命名：Rust 侧是 snake_case，Tauri 按惯例给 JS 转成 camelCase ——
//  单词参数两侧同名（ad / style / limit / now / area / layout / key …），
//  多词参数 JS 要写驼峰：`max_mb` → `maxMb`、`dry_run` → `dryRun`、
//  `from_lng` → `fromLng`。每个命令的注释里都标了。
// ═══════════════════════════════════════════════════════════════════

/// 小区 SVG（`sketch` + `details` + `render`）
///
/// 取 layout 的优先级：`layout`（前端给，通常是 AI 流式生成的结果）→ `key`（地图库布局缓存）
/// → `area`+`size`+`seed`（本地规则草图，确定性随机）。
/// 返回**裸 SVG 文本**（与老 `world_map_render_svg`、以及 HTTP 版 `/api/render` 一致）。
///
/// `mode` 支持 `2d` / `3d`；`charts=true` 会画角落的数据卡片；`zoom`/`layers` 只影响
/// SVG 里的类名与 `data-zoom`，显隐交给前端 CSS。
#[tauri::command]
pub async fn world_map_render(
    app: AppHandle,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    style: Option<String>,
    mode: Option<String>,
    zoom: Option<i32>,
    charts: Option<bool>,
    animate: Option<bool>,
    layers: Option<bool>,
    width: Option<f64>,
    height: Option<f64>,
    pad: Option<f64>,
) -> Result<String, String> {
    let lay = resolve_layout(&app, layout, key, area, size, seed)?;
    let opts = render::Opts {
        style: style.unwrap_or_else(|| "gaode".to_string()),
        width: width.unwrap_or(900.0),
        height: height.unwrap_or(900.0),
        pad: pad.unwrap_or(48.0),
        zoom: zoom.unwrap_or(3),
        animate: animate.unwrap_or(true),
        layers: layers.unwrap_or(true),
        mode: mode.unwrap_or_else(|| "2d".to_string()),
        charts: charts.unwrap_or(false),
    };
    Ok(render::render_svg(&lay, &opts))
}

/// 行政区划 SVG（`render_geo`）：全国 (`100000`) / 省 / 市 / 区县，区划带 adcode 可点击下钻
///
/// 与老命令 `world_map_render_svg` 是同一个渲染器，只是这里多暴露了 `zoom`/`dots`/`stats`。
/// `stats=true` 会在图上标注顶点抽稀统计（开发用）。
#[tauri::command]
pub async fn world_map_geo_svg(
    app: AppHandle,
    ad: Option<String>,
    style: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    pad: Option<f64>,
    zoom: Option<i32>,
    labels: Option<bool>,
    dots: Option<bool>,
    stats: Option<bool>,
    hydro: Option<bool>,
    elevation: Option<bool>,
) -> Result<String, String> {
    let ad = ad.unwrap_or_else(|| "100000".to_string());
    let src = make_source(&app);
    let fc = src.fetch(&ad).await?;
    let opts = render_geo::GeoOpts {
        level: geo::level_of(&ad).to_string(),
        style: style.unwrap_or_else(|| "gaode".to_string()),
        width: width.unwrap_or(1000.0),
        height: height.unwrap_or(760.0),
        pad: pad.unwrap_or(26.0),
        zoom: zoom.unwrap_or(2),
        labels: labels.unwrap_or(true),
        dots: dots.unwrap_or(true),
        // 真实水系默认开：它是「全国级真实地理」的主要视觉来源。
        // 传 false 可退回加图层之前的样子（不白屏、不报错）。
        hydro: hydro.unwrap_or(true),
        // 真实地形默认开。⚠️ 它和水系是**两个独立功能域**，各自可单独关：
        // 只想要河流不要地形，传 `elevation: false, hydro: true` 即可。
        //
        // 📌 上游重构提示：本命令现在注册在 `lib.rs` 的 `generate_handler!` 里；
        // 上游已把所有命令注册搬到 `app/commands.rs`，将来 rebase 时**应把它一并挪过去**，
        // 不要再往 `lib.rs` 里加东西（维护者在 PR #802 评审里点名过这个习惯）。
        elevation: elevation.unwrap_or(true),
        show_stats: stats.unwrap_or(false),
    };
    render_geo::render_geo_svg(&fc, &opts)
}

/// 小区统计指标（`stats.rs` + `details.rs`）
///
/// 取 layout 的方式与 `world_map_render` 相同（`layout` / `key` / `area`+`size`+`seed`）。
/// 返回 `{ detail, stats, series }`：
///   · `detail` = 街道细节计数（树/车位/路灯/人行道…，来自 `details::stats`）
///   · `stats`  = 建筑/道路/公园/水域的数量、面积、层数、人口估算（`stats::compute`）
///   · `series` = 按建筑类型聚合的序列，方便前端直接画饼图/柱图
#[tauri::command]
pub async fn world_map_stats(
    app: AppHandle,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
) -> Result<Value, String> {
    let lay = resolve_layout(&app, layout, key, area, size, seed)?;
    let detail = details::stats(&lay);
    let computed = stats::compute(&lay);
    let series = stats::type_series(&computed)
        .into_iter()
        .map(|(t, zh, count, area_m2)| {
            json!({ "type": t, "typeZh": zh, "count": count, "areaM2": area_m2 })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "detail": detail,
        "stats": computed,
        "series": series,
        "source": "rust",
    }))
}

/// 地图库统计（条数/体积/按类型与城市分布）
///
/// 根目录：`$WM_MAPLIB_DIR`（测试隔离用）→ 否则 `<data_dir>/world_map/maplib`。
#[tauri::command]
pub async fn world_map_maplib_stats(app: AppHandle) -> Result<Value, String> {
    let lib = maplib::MapLib::new(maplib_root(&app));
    Ok(lib.stats())
}

/// 地图库列表（可按 `kind` / `ad` 过滤，`sort` 支持 `recent` 等，见 `maplib.rs`）
///
/// 返回 `{ stats, entries }`，与 HTTP 版 `/api/maplib/list` 一致。
#[tauri::command]
pub async fn world_map_maplib_list(
    app: AppHandle,
    kind: Option<String>,
    ad: Option<String>,
    limit: Option<usize>,
    sort: Option<String>,
) -> Result<Value, String> {
    let lib = maplib::MapLib::new(maplib_root(&app));
    let kind = kind.filter(|s| !s.trim().is_empty());
    let ad = ad.filter(|s| !s.trim().is_empty());
    let sort = sort.filter(|s| !s.trim().is_empty());
    let items = lib.list(
        kind.as_deref(),
        ad.as_deref(),
        limit,
        sort.as_deref().unwrap_or("recent"),
    );
    Ok(json!({ "stats": lib.stats(), "entries": items }))
}

/// 地图库容量清理（LRU）。**默认干跑**，只有显式 `dryRun=false`（或 `dry=false`）才真删。
///
/// 为什么默认干跑：Python 侧在真实删除路径上误删过 119 张地图缓存，
/// 这个开关是那次事故换来的纪律 —— 想真删必须自己写清楚。
/// `maxMb` 不传就用地图库自己的上限（默认 300MB）。
///
/// 默认值的解析挪进了 `maplib::resolve_dry_run`（纯函数）：这条纪律最需要被单测钉住，
/// 而命令层要 `AppHandle`、手机上跑不了 —— 留在这一层等于永远测不到。
///
/// 返回见 `maplib::MapLib::enforce_limit` 的文档（干跑与真删**同形**：
/// `removed` / `freed` / `victims` / `victims_detail`，真删额外附 `stats`）。
#[tauri::command]
pub async fn world_map_maplib_cleanup(
    app: AppHandle,
    max_mb: Option<f64>,
    dry_run: Option<bool>,
    dry: Option<bool>,
) -> Result<Value, String> {
    let lib = maplib::MapLib::new(maplib_root(&app));
    let max_bytes = max_mb.map(|m| (m * 1048576.0) as u64);
    Ok(lib.enforce_limit(max_bytes, maplib::resolve_dry_run(dry_run, dry)))
}

/// **离线可用清单**（P5-4）：现在有哪些区域可以离线看、占了多少空间。
///
/// 纯读本地（`geo/` 的 geojson 缓存 + `maplib/` 的地图与布局），
/// **本命令不发任何网络请求** —— 判据只有"本地有没有这份缓存"，
/// 绝不用"ping 一下看通不通"来判在线（最需要离线的时候不该再等一次超时）。
///
/// 返回结构见 `offline::summary`：
/// ```text
/// { offline: true, note,
///   geo:  { count, bytes, mb, adcodes:[{adcode,level,full,bytes,mtime}] },
///   maps: { count, bytes, mb, adcodes:[…], kinds:{…}, styles:{…} },
///   layouts: { count, keys:[…] },
///   areas: [{ adcode, level, offline, coverage, covered_by, has_geo, geo_full,
///             geo_bytes, maps, kinds, styles, last_access }],
///   totals: { areas, offline_areas, geojson, maps, layouts } }
/// ```
/// `areas` 是 geo 缓存与地图库的并集（按 adcode 升序）；`coverage` =
/// `exact`（自己有缓存）/ `ancestor`（上级有，`covered_by` 指出是哪一级）/ `none`。
#[tauri::command]
pub async fn world_map_offline_available(app: AppHandle) -> Result<Value, String> {
    // 主缓存目录 + 只读预热目录都算"本地有什么"：`make_source` 会做只读目录预热，
    // 这里不建 source（那会构造 reqwest client），只按目录名扫。
    let mut geo = offline::scan_geo_dir(&cache_dir(&app));
    for extra in extra_dirs() {
        geo.extend(offline::scan_geo_dir(&extra));
    }
    geo.sort_by(|a, b| a.adcode.cmp(&b.adcode).then(b.full.cmp(&a.full)));
    geo.dedup_by(|a, b| a.adcode == b.adcode && a.full == b.full);

    let lib = maplib::MapLib::new(maplib_root(&app));
    let maps = lib.list(None, None, None, "recent");
    let layouts = lib.list_layouts(Some(200));
    Ok(offline::summary(&geo, &maps, &layouts))
}

/// 日程 → 角色此刻在做什么、该出现在地图的哪个位置（`schedule.rs`）
///
/// `now` 可以是 `"HH:MM"`、分钟数，或不传（用设备本地时间）。
/// `area` 只影响生成的地名文案；`facilities` 传了就能落到具体设施点
/// （不传就退化为「只有类型」，等 facilities 模块落地后由调用方接上）。
///
/// 数据源：LingChat 的 `<data_dir>/game_data/schedules.json`
/// （已存在的 `characters/settings.yml` 也会读，读不到就用内置默认日程，保证地图不空白）。
#[tauri::command]
pub async fn world_map_schedule(
    now: Option<Value>,
    area: Option<String>,
    facilities: Option<Vec<Value>>,
) -> Result<Value, String> {
    bridge_lingchat_data_dir();
    let now_min = match now {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(other) => schedule::parse_time(&other),
    };
    Ok(schedule::payload(
        now_min,
        facilities.as_deref(),
        area.as_deref(),
    ))
}

/// 交通设施层上下文（T2-2 step2）—— 把「路径规划器」与「地图上那些车站」接到同一份设施表上。
///
/// ## 为什么需要它
/// `transport.rs` 在没有上下文时会用 `offset_point()` **几何猜**上下车点：从起点朝终点挪一小段
/// （`access_km`）。那个点通常落在街区内部（= 卡片里说的"空地"），文案也只能写通用名「接驳到公交站」。
/// 把 [`facilities`] 生成的真实交通节点喂进去后，上下车点 = **最近的真实站点**的经纬度，
/// 文案带真实站名（「接驳到人民路站」）。
///
/// ## 与地图同源（关键）
/// 站点的身份 = `(area, size, seed, level)` 四元组（`facilities::generate_all` 内部按
/// `sha256("{area}|{size}|{salt}")` 播种）。所以**要与地图上那枚图标逐一对应**，调用方必须传
/// **与 T2-1 设施图层相同的四个值**（前端是 `area=区域名`、`size=28`、`seed=hash32(area)`）。
/// 只给坐标不给这四个值时也能吸附（以起点为中心、用默认区名生成一份草图），
/// 位置仍在合理街区上，但**未必与地图上画的那枚图标重合** —— 这一点在 `source` 字段里如实标出
/// （`explicit`/`maplib`/`sketch`）。
#[derive(Default)]
struct TransitOpts {
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    level: Option<String>,
    /// 网格原点（格 (0,0)）的经纬度 —— 优先级最高，调用方自己算好了锚点就用它
    anchor: Option<(f64, f64)>,
    /// 网格**中心**的经纬度（「我人在哪」就是这个）→ 内部换算成原点
    center: Option<(f64, f64)>,
    /// 兜底中心（算路时用起点）：只在前面都没给时才用
    fallback_center: Option<(f64, f64)>,
}

/// 交通上下文的构造结果：喂给规划器的那份 + 给前端/自检看的那份
struct TransitCtx {
    /// 送进 `transport::api_plan_with_ctx` 的上下文（含完整 facilities 数组）
    ctx: Value,
    /// 回给调用方的摘要（**不含** facilities 全量，只带节点要点，免得响应肥一圈）
    report: Value,
    /// 这份上下文用的布局与锚点 —— 三级对比（社区/区县/城市）必须复用**同一份布局**，
    /// 否则三档之间连"网格大小/空地分布"都变了，比出来的数量差没有意义
    layout: Value,
    /// 锚点；`None` = 调用方没给任何地理位置 → **节点照给，但不编经纬度**（`geo:false`）
    anchor: Option<(f64, f64)>,
    grid: i64,
}

/// 由「布局 + 锚点 + 层级」生成交通节点与规划上下文。
///
/// 与 T2-1 的设施图层走**同一条生成链**（`facilities::generate_all` 内部用 `seed + 1`
/// 生成交通节点），所以这里的站点与 `/api/facilities` 返回的 `transport` 数组是**同一批** ——
/// 地图上画的那枚图标，就是规划器用来当上下车点的那一个（前提是 `area/size/seed` 传得一样）。
fn transit_nodes_of(
    layout: &Value,
    area: &str,
    level: &str,
    seed: Option<u64>,
    anchor: Option<(f64, f64)>,
) -> Option<(Value, Value)> {
    let all = facilities::generate_all(layout, area, None, level, seed.map(|s| s as i64));
    let nodes = all.get("transport").and_then(|v| v.as_array()).cloned()?;
    if nodes.is_empty() {
        return None;
    }
    let grid = layout
        .get("size")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
        .unwrap_or(28);
    let mpc = facilities::DEFAULT_CELL_METERS;
    // 没有锚点就没有"规划上下文"（`station_in_grid` 本来也要求 anchor）——
    // 这时**节点照给**，只是不带经纬度：地图图层用的是格点坐标，够画；
    // 而规划那条路本来就必须有锚点，缺了就如实退回几何估计。
    let ctx = match anchor {
        Some(a) => transport::makes_context(&nodes, a, mpc, Some(grid as f64)),
        None => Value::Null,
    };
    // 节点也带上经纬度：前端要画"我上车的那个站"，自检要量"上车点离真实站点多远"。
    // ⚠️ 换算公式必须与 `transport.rs::station_in_grid` 逐字一致
    //    （`grid_to_world(gx, gy, anchor, mpc)` → `world_to_lng_lat`），
    //    否则"画出来的图标"与"规划器认定的站点"会差一点，验收就对不上了。
    let with_ll: Vec<Value> = nodes
        .iter()
        .map(|n| {
            let mut n2 = n.clone();
            if let Some((alng, alat)) = anchor {
                let gx = n.get("gx").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let gy = n.get("gy").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let (wx, wy) = coord::grid_to_world(gx, gy, alng, alat, mpc);
                let (lng, lat) = coord::world_to_lng_lat(wx, wy);
                if let Some(m) = n2.as_object_mut() {
                    m.insert("lng".into(), json!((lng * 1e6).round() / 1e6));
                    m.insert("lat".into(), json!((lat * 1e6).round() / 1e6));
                }
            }
            n2
        })
        .collect();
    Some((ctx, Value::Array(with_ll)))
}

/// 构造交通上下文。**任何一步失败都返回 `None`**（规划退回几何估计），
/// 绝不让"算不出站点"变成"算不出路线"。
fn transit_context(app: &AppHandle, o: TransitOpts) -> Option<TransitCtx> {
    let area = o
        .area
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "广州市·越秀区".to_string());
    let level = o
        .level
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "community".to_string());
    // 与 T2-1 的设施图层默认值保持一致（`WsDistrict` 的 SKETCH_SIZE = 28）
    let size = o.size.unwrap_or(28).clamp(8, 200);
    // 地图库布局的 meta 里带 lat/lng，可以当中心用（这是「与地图库那张图同源」的路径）
    let key_center = o.key.as_deref().and_then(|k| {
        let lib = maplib::MapLib::new(maplib_root(app));
        lib.list_layouts(Some(200)).into_iter().find_map(|it| {
            if it.get("key").and_then(|v| v.as_str()) != Some(k) {
                return None;
            }
            let m = it.get("meta")?;
            Some((m.get("lng")?.as_f64()?, m.get("lat")?.as_f64()?))
        })
    });
    // ── 锚点从哪来（**来源与取值分开记**，绝不为了"看起来完整"编一个 (0,0)）──
    // 优先级：显式锚点 → 显式中心 → 地图库 meta 的经纬度 → 算路起点（只有规划路径才有）。
    // 四个都没有 → `None`：节点照给、不带经纬度、不进规划器。
    let (center, anchor, anchor_source) = if let Some(a) = o.anchor {
        (None, Some(a), "explicit-anchor")
    } else if let Some(c) = o.center.or(key_center) {
        (
            Some(c),
            Some(transport::anchor_for_center(
                c.0,
                c.1,
                size as f64,
                facilities::DEFAULT_CELL_METERS,
            )),
            if o.center.is_some() { "center" } else { "maplib-meta" },
        )
    } else if let Some(c) = o.fallback_center {
        (
            Some(c),
            Some(transport::anchor_for_center(
                c.0,
                c.1,
                size as f64,
                facilities::DEFAULT_CELL_METERS,
            )),
            "trip-origin",
        )
    } else {
        (None, None, "none")
    };
    // 布局来源（与 world_map_render 同一条链：layout → 地图库 key → 本地草图）
    let source = if o.layout.is_some() {
        "layout"
    } else if o.key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
        "maplib"
    } else {
        "sketch"
    };
    let layout = match o.layout.clone() {
        Some(v) => normalize_layout(Some(v))?,
        None => {
            // 有 key 就用地图库那份（真源），否则用草图
            let keyed = o
                .key
                .clone()
                .filter(|k| !k.trim().is_empty())
                .and_then(|k| maplib::MapLib::new(maplib_root(app)).get_layout(&k));
            match keyed {
                Some(l) => l,
                None => sketch::make_sketch(&area, size, o.seed, None),
            }
        }
    };
    if !layout.is_object() {
        return None;
    }
    let grid = layout
        .get("size")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
        .unwrap_or(size as i64);
    let (ctx, with_ll) = transit_nodes_of(&layout, &area, &level, o.seed, anchor)?;
    let count = with_ll.as_array().map(|a| a.len()).unwrap_or(0);
    let report = json!({
        "source": source,
        "area": area,
        "level": level,
        "grid": grid,
        "cell_meters": facilities::DEFAULT_CELL_METERS,
        // `geo=false` 是**如实标注**：没有锚点就没有经纬度，前端别拿格点当经纬度用
        "geo": anchor.is_some(),
        "anchor": anchor.map(|a| json!({"lng": a.0, "lat": a.1})).unwrap_or(Value::Null),
        // 锚点是从哪儿来的（显式 / 中心 / 地图库 meta / 算路起点）—— 与"布局来源"是两件事
        "anchor_source": anchor_source,
        "center": center.map(|c| json!({"lng": c.0, "lat": c.1})).unwrap_or(Value::Null),
        "count": count,
        "nodes": with_ll,
    });
    Some(TransitCtx { ctx, report, layout, anchor, grid })
}

/// 两点之间的交通方案（`transport.rs`，9 种交通工具 + 接驳）
///
/// 坐标两种给法都行（前端 `worldMap.ts` 用的是前一种）：
///   · `from`/`to` = `{lat, lng}`（也认 `{lat, lon}` 与 `[lng, lat]`）
///   · 或者平铺的 `fromLng`/`fromLat`/`toLng`/`toLat`（对应 HTTP 版 `?from_lng=…`）
/// `prefer` 是交通方式偏好（bus/subway/train/…，别名见 `transport.rs` 的 ALIASES）。
///
/// **T2-2 step2 起多了"站点吸附"**（见 [`TransitOpts`] 的整段说明）：
/// 传了 `area`/`key`/`anchorLng…` 就吸附到真实站点，上下车点落在站点上而不是空地；
/// `stations=0` 可以显式退回旧行为（逐字节一致，给回归用）。
/// 返回 `{ ok, route, options, modes, stations? }` —— `stations` 里如实写着用了哪份布局、
/// 锚点在哪、以及每个站点的经纬度（前端画"我上车的那个站"要用）。
#[tauri::command]
pub async fn world_map_transport_plan(
    app: AppHandle,
    from: Option<Value>,
    to: Option<Value>,
    prefer: Option<String>,
    from_lng: Option<f64>,
    from_lat: Option<f64>,
    to_lng: Option<f64>,
    to_lat: Option<f64>,
    water: Option<bool>,
    urban: Option<bool>,
    stations: Option<bool>,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    level: Option<String>,
    anchor_lng: Option<f64>,
    anchor_lat: Option<f64>,
    center_lng: Option<f64>,
    center_lat: Option<f64>,
) -> Result<Value, String> {
    let mut q = serde_json::Map::new();
    let pick = |flat: Option<f64>, p: &Option<Value>, k: &str| -> Option<f64> {
        flat.or_else(|| p.as_ref().and_then(|v| point_part(v, k)))
    };
    let flng = pick(from_lng, &from, "lng");
    let flat = pick(from_lat, &from, "lat");
    let tlng = pick(to_lng, &to, "lng");
    let tlat = pick(to_lat, &to, "lat");
    if let Some(v) = flng {
        q.insert("from_lng".into(), json!(v));
    }
    if let Some(v) = flat {
        q.insert("from_lat".into(), json!(v));
    }
    if let Some(v) = tlng {
        q.insert("to_lng".into(), json!(v));
    }
    if let Some(v) = tlat {
        q.insert("to_lat".into(), json!(v));
    }
    if let Some(v) = prefer.filter(|s| !s.trim().is_empty()) {
        q.insert("prefer".into(), json!(v));
    }
    if let Some(v) = water {
        q.insert("water".into(), json!(v));
    }
    if let Some(v) = urban {
        q.insert("urban".into(), json!(v));
    }
    // T2-2 step2：站点吸附。`stations=0` 显式退回旧行为（几何估计的虚拟站点）。
    let use_stations = stations.unwrap_or(true);
    let tc = if use_stations {
        transit_context(
            &app,
            TransitOpts {
                layout,
                key,
                area,
                size,
                seed,
                level,
                anchor: match (anchor_lng, anchor_lat) {
                    (Some(a), Some(b)) => Some((a, b)),
                    _ => None,
                },
                center: match (center_lng, center_lat) {
                    (Some(a), Some(b)) => Some((a, b)),
                    _ => None,
                },
                // 兜底：以**起点**为中心建网格（"我在自己小区里叫车/坐公交"这个真实场景）
                fallback_center: match (flng, flat) {
                    (Some(a), Some(b)) => Some((a, b)),
                    _ => None,
                },
            },
        )
    } else {
        None
    };
    let mut out = transport::api_plan_with_ctx(
        &Value::Object(q),
        tc.as_ref().map(|c| &c.ctx).filter(|c| !c.is_null()),
    );
    if let (Some(c), Some(o)) = (tc.as_ref(), out.as_object_mut()) {
        o.insert("stations".into(), c.report.clone());
    }
    Ok(out)
}

/// 交通设施节点（T2-2 step2）—— 只取 `facilities.rs` 生成的那 7 类交通设施。
///
/// 与 `world_map_facilities` 的关系：那个命令一次给「生活 + 交通」，
/// 这个只给交通，并且多带两样前端画图/切换要用的东西：
///   · `nodes` 里每个站点都算了 **lng/lat**（用 `anchor` + `cell_meters` 换算，
///     与 `transport.rs` 的 `station_in_grid` 用**同一个公式**，所以画出来的图标位置
///     与规划器认为的站点位置逐位一致）；
///   · `levels` 给出社区/区县/城市三级的**实际数量与种类**（卡片要求"能看出差别"，
///     前后端不该各写一份 LEVEL_PLAN）。
///
/// `level` 不传时默认 `community`（与规划器、设施图层的默认值一致）。
#[tauri::command]
pub async fn world_map_transport_nodes(
    app: AppHandle,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    level: Option<String>,
    anchor_lng: Option<f64>,
    anchor_lat: Option<f64>,
    center_lng: Option<f64>,
    center_lat: Option<f64>,
    all_levels: Option<bool>,
) -> Result<Value, String> {
    let area_s = area
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "广州市·越秀区".to_string());
    let level_s = level
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "community".to_string());
    let size_i = size.unwrap_or(28);
    let anchor = match (anchor_lng, anchor_lat) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => match (center_lng, center_lat) {
            (Some(a), Some(b)) => Some(transport::anchor_for_center(
                a,
                b,
                size_i as f64,
                facilities::DEFAULT_CELL_METERS,
            )),
            _ => None,
        },
    };
    let tc = transit_context(
        &app,
        TransitOpts {
            layout,
            key,
            area: Some(area_s.clone()),
            size: Some(size_i),
            seed,
            level: Some(level_s.clone()),
            anchor,
            center: match (center_lng, center_lat) {
                (Some(a), Some(b)) => Some((a, b)),
                _ => None,
            },
            fallback_center: None,
        },
    );
    let Some(tc) = tc else {
        // 构造不出来就如实说"没有"，**不返回空数组假装"这里没有车站"**
        return Ok(json!({
            "ok": false,
            "error": "这份布局生成不出交通节点（布局不合法或没有可用空格）",
            "level": level_s, "area": area_s,
        }));
    };
    let mut out = tc.report.clone();
    if let Some(o) = out.as_object_mut() {
        o.insert("ok".into(), json!(true));
        o.insert("types".into(), facilities::types_payload());
        // 三级对比：**同一份布局**跑三档，只带数量/种类。
        // 卡片要求"社区级/区县级/城市级要能看出差别"，而差别来自 `facilities.rs` 的 LEVEL_PLAN
        // —— 前端不该再写一份（两份必然漂移），所以由后端一次算好。
        if all_levels.unwrap_or(true) {
            let mut lv: Vec<Value> = Vec::new();
            for l in ["community", "district", "city"] {
                let (cnt, kinds) = match transit_nodes_of(&tc.layout, &area_s, l, seed, tc.anchor) {
                    Some((_ctx, nodes)) => {
                        let mut ks: Vec<String> = nodes
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|n| n.get("type").and_then(|t| t.as_str()))
                                    .map(String::from)
                                    .collect()
                            })
                            .unwrap_or_default();
                        ks.sort();
                        ks.dedup();
                        (nodes.as_array().map(|a| a.len()).unwrap_or(0), ks)
                    }
                    None => (0, Vec::new()),
                };
                lv.push(json!({"level": l, "zh": level_zh_of(l), "count": cnt, "kinds": kinds}));
            }
            o.insert("levels".into(), Value::Array(lv));
        }
    }
    Ok(out)
}

/// 层级中文名（`facilities.rs` 的 `level_zh` 是私有的，这里给命令层用一份同样的表）
fn level_zh_of(level: &str) -> &'static str {
    match level {
        "community" => "小区",
        "district" => "区县",
        "city" => "城市",
        _ => "小区",
    }
}

/// 区域 OSM（Overpass）摘要（`osm.rs`）
///
/// **默认只读缓存**（按 200m 网格缓存，key = `grid_key(lat,lng,radius)`）：
/// 生成路径绝不能被 Overpass 的几十秒拖住，想真去抓必须显式 `force=true`。
/// `text=true` 时额外返回给 LLM 看的一段中文描述（`osm::describe_for_llm`）。
/// 返回 `{ ok, key, cached, count, summary, text, meta }`；
/// 没缓存且没 `force` 时 `ok=false` + `hint`，让调用方降级为纯 LLM 生成。
///
/// ⚠️ **不要把 `force=true` 接到「平移 / 缩放 / 进页面」这类自动路径上。**
///
/// 这是本命令唯一会**写盘**的分支。缓存键是 200m 网格（`osm.rs` 的 `GRID = 0.002`），
/// 而网格数随「访问过的地理位置」增长 —— 也就是说**键空间实际上是无界的**：
/// 自动抓取 = 用户每挪 200m 就落一个文件，落盘量随浏览行为线性上涨，且没有上限。
/// 本机实测单条 0.4 KB ~ 95 KB（n=2，只能看量级），几百个文件就是几十 MB。
///
/// 现状是安全的（只有显式调用才会写），这条注释是**防将来有人图方便把它接到自动路径上** ——
/// 那会从一个「有硬天花板的正当缓存」变成一个真正无界的写盘源。
#[tauri::command]
pub async fn world_map_osm_summary(
    app: AppHandle,
    lat: f64,
    lng: f64,
    radius: Option<f64>,
    force: Option<bool>,
    kinds: Option<Vec<String>>,
    text: Option<bool>,
) -> Result<Value, String> {
    let dir = osm_dir(&app);
    let radius = radius.unwrap_or(300.0);
    let force = force.unwrap_or(false);
    let key = osm::grid_key(lat, lng, radius);
    let mut cached = false;
    let mut data = None;
    if !force {
        data = osm::load_cached(&dir, &key);
        cached = data.is_some();
    }
    if data.is_none() && force {
        // ⚠️ 必须注入预配置的 TLS 后端：reqwest 0.13 默认走 rustls-platform-verifier，
        // 而本仓从不初始化它 → 裸 builder 在 Android 上发请求时 panic（见 `src/utils/tls.rs`）。
        // 与 `stream.rs` 那处是同一类漏配，两处一起补。
        let tls = crate::utils::tls::build_tls_config()?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .tls_backend_preconfigured(tls)
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
        data = osm::fetch_area(&client, &dir, lat, lng, radius, kinds, true).await;
    }
    match data {
        Some(v) => {
            let count = v
                .get("elements")
                .and_then(|e| e.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            Ok(json!({
                "ok": true,
                "key": key,
                "cached": cached,
                "count": count,
                "summary": osm::summarize(&v),
                "text": if text.unwrap_or(false) {
                    Value::String(osm::describe_for_llm(&v))
                } else {
                    Value::Null
                },
                "meta": v.get("_meta").cloned().unwrap_or(Value::Null),
                "source": "rust",
            }))
        }
        None => Ok(json!({
            "ok": false,
            "key": key,
            "cached": false,
            "error": "本地没有这份 OSM 缓存",
            "hint": "要真去抓请传 force=true（走 Overpass，可能几十秒）",
            "source": "rust",
        })),
    }
}

/// **真实楼房轮廓 + 楼高 → GeoJSON**（给 MapLibre 的 `fill-extrusion` 挤成 2.5D）
///
/// 与 [`world_map_osm_summary`] 的分工：
///   · 那个产出的是**给 LLM 看的一句话摘要**（只有种类与计数，没有几何）；
///   · 这个产出的是**几何**：每栋楼的闭合多边形 + 米制楼高，直接喂渲染器。
/// 两条通路**各用各的磁盘缓存**（`osm::BUILDINGS_KEY_PREFIX`），不会互相覆盖。
///
/// 高度优先级（`osm::building_height`，逐栋带 `height_src` 回到前端）：
/// `building:height` → `height` → `building:levels`×3m → 默认 8m。
/// 换算常量随数据返回（`stats.default_height_m` / `stats.levels_meters`），
/// **前端不要自己写 8 和 3** —— 两边写死就会"哪些楼是猜的"说不清。
///
/// 返回 `{ ok, lat, lng, radius, key, cached, count, geojson, stats, meta, source }`；
/// 取不到时 `ok=false` + `error`/`hint`（**不返回 Err**：前端要能显示"取不到 + 原因"，
/// 而不是一个异常）。这个形状与调试服务 `/api/buildings` **逐字段一致**，
/// 所以浏览器里验过的渲染代码，换成 Tauri 通路不用改一行。
///
/// ## ⚠️ 磁盘增长：这是本命令第二条会写盘的通路
///
/// 与 `world_map_osm_summary` 一样按 200m 网格落盘，键空间随"访问过的地点"无界增长。
/// 这里**刻意**与那条不同：缓存未命中就真去抓（否则页面第一次打开永远是空的，
/// 那这个功能没有意义）。⇒ 代价是**调用方必须只在"相机停稳后"调它**
/// （比如 `moveend` + 去抖），**绝不能每帧/每次 mousemove 调** ——
/// 那会从"有天花板的正当缓存"变成真正无界的写盘源 + Overpass 限流。
/// 需要强制刷新时传 `force=true`。
#[tauri::command]
pub async fn world_map_buildings(
    app: AppHandle,
    lat: f64,
    lng: f64,
    radius: Option<f64>,
    force: Option<bool>,
) -> Result<Value, String> {
    let radius = radius.unwrap_or(300.0);
    let force = force.unwrap_or(false);

    // 参数校验：宁可明确报错，也不要把 NaN/越界坐标丢给 Overpass（那边会返回空，
    // 于是"参数写错了"会被显示成"这里没有楼房"）
    if !lat.is_finite() || !lng.is_finite() || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng)
    {
        return Ok(json!({
            "ok": false, "lat": lat, "lng": lng, "radius": radius, "count": 0,
            "error": "坐标非法", "hint": "lat ∈ [-90,90]、lng ∈ [-180,180]", "source": "rust",
        }));
    }
    if !radius.is_finite() || radius <= 0.0 || radius > 2000.0 {
        return Ok(json!({
            "ok": false, "lat": lat, "lng": lng, "radius": radius, "count": 0,
            "error": "半径非法", "hint": "radius ∈ (0, 2000] 米（再大楼房数量会让手机端渲染垮掉）",
            "source": "rust",
        }));
    }

    let dir = osm_dir(&app);
    let key = osm::buildings_cache_key(lat, lng, radius);
    let mut cached = false;
    let mut data = None;
    if !force {
        data = osm::load_cached(&dir, &key);
        cached = data.is_some();
    }
    if data.is_none() {
        // ⚠️ 必须注入预配置的 TLS 后端（与 `world_map_osm_summary` 同一处坑，见其注释）
        let tls = crate::utils::tls::build_tls_config()?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .tls_backend_preconfigured(tls)
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
        data = osm::fetch_buildings(&client, &dir, lat, lng, radius, force).await;
    }

    match data {
        Some(v) => {
            let (geojson, stats) = osm::buildings_geojson(&v);
            Ok(json!({
                "ok": true,
                "lat": lat,
                "lng": lng,
                "radius": radius,
                "key": key,
                "cached": cached,
                "count": stats.get("count").cloned().unwrap_or(json!(0)),
                "geojson": geojson,
                "stats": stats,
                "meta": v.get("_meta").cloned().unwrap_or(Value::Null),
                "source": "rust",
            }))
        }
        None => Ok(json!({
            "ok": false,
            "lat": lat,
            "lng": lng,
            "radius": radius,
            "key": key,
            "cached": false,
            "count": 0,
            "error": "Overpass 三个端点都没取到楼房数据",
            "hint": "公共 Overpass 会限流/502，隔一会儿重试；已成功的区域会缓存在 osm/ 目录",
            "source": "rust",
        })),
    }
}

/// 设备本地时间 + 时段（前端 `worldMapApi.time()` 调的就是它）
///
/// LingChat 用真实时间、没有游戏内时间，所以这里取的是**设备时区**的本地时间
/// （`chrono::Local`，与 `schedule.rs` 内部取的是同一份设备本地时间）。
#[tauri::command]
pub async fn world_map_time() -> Result<Value, String> {
    let now = chrono::Local::now();
    let h = now.hour() as i32;
    let weekday = now.weekday().num_days_from_monday();
    let names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    Ok(json!({
        "iso": now.format("%Y-%m-%dT%H:%M:%S").to_string(),
        "date": now.format("%Y-%m-%d").to_string(),
        "time": now.format("%H:%M:%S").to_string(),
        "hour": h,
        "minute": now.minute(),
        "weekday": weekday,
        "weekday_name": names[weekday as usize],
        "period": period_of(h),
        "is_day": (6..18).contains(&h),
        "timestamp": now.timestamp(),
        "source": "rust",
    }))
}

// ══════════════════════════════════════════════════════════════════════
// T2-1/T2-2 · 设施图层（生活 7 类 + 交通 7 类）
// ══════════════════════════════════════════════════════════════════════
//
// `facilities.rs` 早就移植完了（含 18 个单测），但一直**没有任何命令暴露它** ——
// 前端拿不到设施数据，地图上也就没有设施图层。下面三个命令把它接出来。
//
// 坐标约定（前端最容易踩的一条）：设施坐标 `gx/gy` 是**小区图的格点**，
// 与 `WorldSim.vue` 的 `WS_GRID = 28` / `WsDistrict` 的 `SKETCH_SIZE = 28` 是同一套，
// **不是**经纬度。所以设施图层要铺在 `.ws-neigh__pan` 那个手势变换容器里
// （与 WsAvatarLayer/WsVehicleMark 同一个 `#pin` 插槽），不要往 GeoJSON 画布上画。
//
// 确定性（卡片明确要求「刷新后位置不变」）：设施由 `sha256("{area}|{size}|{salt}")` 播种，
// 同 `area` + 同 `size` + 同 `seed` 永远同一批落点。前端只要每次都传同一个种子
// （`WsDistrict` 用的是 `hash32(area)`，已实测与 `sketch::make_sketch` 的取图一致）
// 就不会每次刷新换位置。
//
// 与前端的对应关系见 `src/api/services/worldMap.ts` 的三个 `*Auto()` 包装。

/// 设施清单的**统一返回壳**（Tauri 命令与 8791 的 `/api/facilities` 返回同一个形状，
/// 所以 `worldMap.ts` 两条通路可以共用一套类型）。
///
/// 为什么不把这层壳放进 `facilities.rs`：那个模块是逐行对照 Python 原型的移植件，
/// 改它会破坏「两边结构逐字段相同」这条对拍前提 —— 组装 JSON 是「接口层」的事，
/// 归命令层（本文件）与调试服务（`world_map_rs/src/main.rs`）各自负责。
///
/// ⚠️ 刻意**不放**耗时字段（曾经有 `gen_ms`，已删）：这份返回必须是输入的纯函数
/// （同 area/size/seed/key → 逐字节相同），否则「刷新后设施位置不变」就没法用
/// 「两次请求 sha256 相等」来证明 —— 掺进去一个毫秒数，两次请求必然不同。
fn facilities_payload(lay: &Value, area: &str, level: &str, seed: Option<i64>, source: &str) -> Value {
    let all = facilities::generate_all(lay, area, None, level, seed);
    // `size` 以**布局自己的**为准（调用方给的 size 只用来生成草图，草图可能自带 size）
    let grid = all.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
    let life = all.get("facilities").cloned().unwrap_or_else(|| json!([]));
    let trans = all.get("transport").cloned().unwrap_or_else(|| json!([]));
    let n_life = life.as_array().map(|a| a.len()).unwrap_or(0);
    let n_trans = trans.as_array().map(|a| a.len()).unwrap_or(0);
    let out = json!({
        "ok": true,
        "area": all.get("area").cloned().unwrap_or_else(|| json!(area)),
        "level": all.get("level").cloned().unwrap_or_else(|| json!(level)),
        "grid": grid,
        "cell_meters": facilities::DEFAULT_CELL_METERS,
        "layout_name": lay.get("name").cloned().unwrap_or(Value::Null),
        "layout_source": source,
        "life_count": n_life,
        "transport_count": n_trans,
        "facilities": life,
        "transport": trans,
        "stats": all.get("stats").cloned().unwrap_or(Value::Null),
    });
    out
}

/// 生成/返回设施清单（生活 + 交通）。
///
/// 取布局的优先级与 `world_map_render` 完全一致（`resolve_layout`）：
/// `layout` → 地图库布局缓存 `key` → 本地规则草图 `area`+`size`+`seed`。
/// 传 `key`（地图库里那份 AI 精绘布局）时，设施会落在**玩家实际看到的那张图**的空地上；
/// 只给 `area/size/seed` 时落在本地草图上（网格相同，但 AI 精绘后建筑可能不同）。
///
/// * `seed`：同时喂给草图与设施播种（同一个数字，避免两处取图对不上）。
///   JS 侧传 `hash32(area)`（与 `WsDistrict` 画草图用的是同一个），刷新后位置不变。
///
/// 设施条数按网格面积估算（`generate_all` 内部 `max(4, size²/26)`），所以**没有** `count` 参数；
/// 卡片里提过它，但 `generate_all` 不接收（只有 `generate_facilities` 收）。
/// 与其在这里假装能调，不如不暴露 —— 要调密度得先改 `facilities.rs` 的签名（属另一个功能域）。
#[tauri::command]
pub async fn world_map_facilities(
    app: AppHandle,
    layout: Option<Value>,
    key: Option<String>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    level: Option<String>,
) -> Result<Value, String> {
    let area_s = area.unwrap_or_else(|| "广州市·越秀区".to_string());
    let level_s = level.unwrap_or_else(|| "community".to_string());
    let src = if layout.is_some() {
        "layout"
    } else if key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
        "maplib"
    } else {
        "sketch"
    };
    let lay = resolve_layout(&app, layout, key, Some(area_s.clone()), size, seed)?;
    // seed 统一成 i64 传给设施播种：hash32 的结果是 32 位无符号，转 i64 不会溢出
    Ok(facilities_payload(
        &lay,
        &area_s,
        &level_s,
        seed.map(|s| s as i64),
        src,
    ))
}

/// 设施类型的元数据表（中文名/图标/配色/分组/占地尺寸 + 各层级计划）——
/// 前端图例与「按类别过滤」的开关直接用这张表，不自己写死一份颜色。
///
/// 返回 `{ types, levels, level_plan, cell_meters }`，与 Python 原型 `facilities.types_payload()` 同形。
#[tauri::command]
pub async fn world_map_facilities_types() -> Result<Value, String> {
    Ok(facilities::types_payload())
}

/// 「这个角色现在在哪个设施里」—— 按格点坐标查设施。
///
/// 两级语义（都试，结果里用 `source` 如实说明是哪一级命中的）：
///   1. `cell`：该格点**落在某个设施的占地范围**内（`facility_at`，角色站在图书馆里）；
///   2. `near`：范围外则找 `radius` 格内最近的设施（`find_facilities` 的 near 语义，
///      结果带 `dist` 字段）——「他就在便利店旁边」。
///
/// `facilities` 传了就**不重新生成**（与 `world_map_schedule` 同一个约定：
/// 前端已经把设施表拿在手上了，再生成一次既浪费又可能与它显示的那份不是同一批）；
/// 不传则按 `area/size/seed/level` 从草图重新生成。
///
/// ⚠️ 若前端的设施来自地图库布局（`key`），这里必须把 `facilities` 数组传回来 ——
/// 本命令没有 `key` 参数，重新生成只会得到草图上的那一批。
#[tauri::command]
pub async fn world_map_facility_at(
    facilities: Option<Vec<Value>>,
    gx: i64,
    gy: i64,
    radius: Option<f64>,
    area: Option<String>,
    size: Option<i32>,
    seed: Option<u64>,
    level: Option<String>,
) -> Result<Value, String> {
    let area_s = area.unwrap_or_else(|| "广州市·越秀区".to_string());
    let level_s = level.unwrap_or_else(|| "community".to_string());
    let list = match facilities {
        Some(v) if !v.is_empty() => Value::Array(v),
        _ => {
            let lay = sketch::make_sketch(&area_s, size.unwrap_or(28), seed, None);
            facilities::generate_all(&lay, &area_s, None, &level_s, seed.map(|s| s as i64))
                .get("facilities")
                .cloned()
                .unwrap_or_else(|| json!([]))
        }
    };
    let hit = facilities::facility_at(&list, gx, gy);
    if !hit.is_null() {
        return Ok(json!({
            "ok": true, "gx": gx, "gy": gy, "source": "cell", "facility": hit,
        }));
    }
    // 范围外：找最近的（radius 默认 3 格；传 0 表示「只要精确命中」）
    let r = radius.unwrap_or(3.0).max(0.0);
    if r <= 0.0 {
        return Ok(json!({
            "ok": true, "gx": gx, "gy": gy, "source": "none", "facility": Value::Null,
        }));
    }
    let near = facilities::find_facilities(&list, None, None, Some((gx as f64, gy as f64)), Some(r), None, Some(1));
    let first = near.as_array().and_then(|a| a.first()).cloned();
    Ok(json!({
        "ok": true, "gx": gx, "gy": gy,
        "source": if first.is_some() { "near" } else { "none" },
        "facility": first.unwrap_or(Value::Null),
    }))
}
