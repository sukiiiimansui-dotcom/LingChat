//! 行政区划级 SVG 渲染（移植自 Python `svg_geo.py`）
//!
//! 与 `render.rs`（小区级）共用同一套视觉语言，保证从全国缩到小区是连续的：
//!   country 全国  → 省界 + 省会点 + 省名
//!   province 省   → 市界 + 市中心点 + 市名
//!   city 市       → 区县界 + 区名
//!   district 区县 → 街镇边界
//!
//! 每个区划包在 `<g class="geo-region" data-adcode data-name>` 里 —— 前端据此做**点击下钻**。
use serde_json::Value;

use crate::world_map::hydro;

// ── 三套配色（与 render.rs 对齐；RPG 风已按需求移除）──
pub struct GeoStyle {
    pub bg: &'static str,
    pub land: &'static str,
    pub land_alt: &'static str,
    pub border: &'static str,
    pub border2: &'static str,
    pub inner: &'static str,
    pub text: &'static str,
    pub text_halo: &'static str,
    pub sub_text: &'static str,
    pub dot: &'static str,
    /// 湖泊填充色（真实水系图层，见 `hydro.rs`）
    pub water: &'static str,
    /// 河流描边色 / 湖泊描边色
    pub water_edge: &'static str,
}

pub const STYLE_NAMES: [&str; 3] = ["gaode", "dark", "water"];

pub fn style_of(name: &str) -> GeoStyle {
    match name {
        "dark" => GeoStyle {
            bg: "#0a1420", land: "#182636", land_alt: "#1d2d3f",
            border: "#5a8cbe", border2: "#2a4055", inner: "rgba(0,0,0,.35)",
            text: "#c8dcf0", text_halo: "#0a1420", sub_text: "#6d87a8", dot: "#ff8a5a",
            // 夜底上的水：比陆地更暗、更蓝，靠描边提亮才看得见（纯填充会和陆地糊在一起）
            water: "#12314f", water_edge: "#3d6f9f",
        },
        "water" => GeoStyle {
            bg: "#dfeaf2", land: "#f4efe3", land_alt: "#f8f4ea",
            border: "#b9c8d4", border2: "#d6cec0", inner: "rgba(140,130,110,.16)",
            text: "#6a6252", text_halo: "#faf6ec", sub_text: "#9a9080", dot: "#c88a6a",
            water: "#b6d3e6", water_edge: "#8fb4cf",
        },
        _ => GeoStyle {
            bg: "#cfe3f5", land: "#e9e7dc", land_alt: "#eeece2",
            border: "#ffffff", border2: "#d8d4c6", inner: "rgba(120,130,150,.20)",
            text: "#3c4b5f", text_halo: "#ffffff", sub_text: "#7b8698", dot: "#e05a6a",
            // 高德风的陆地上，水体是比海洋底色（#cfe3f5）更饱和一档的蓝，
            // 这样「海」和「湖」不会被看成同一种东西
            water: "#a3cbe8", water_edge: "#6fa8d0",
        },
    }
}

/// 各行政级别的线宽/字号基准
struct LevelStyle {
    border: f64,
    border2: f64,
    dot_r: f64,
    fs: f64,
    min_area: f64,
    show_dot: bool,
}

fn level_style(level: &str) -> LevelStyle {
    match level {
        "country" => LevelStyle { border: 1.6, border2: 0.8, dot_r: 3.4, fs: 13.5, min_area: 4e-6, show_dot: true },
        "province" => LevelStyle { border: 1.4, border2: 0.7, dot_r: 2.8, fs: 12.0, min_area: 2e-6, show_dot: true },
        "city" => LevelStyle { border: 1.1, border2: 0.55, dot_r: 2.2, fs: 11.0, min_area: 6e-7, show_dot: true },
        _ => LevelStyle { border: 0.9, border2: 0.45, dot_r: 1.8, fs: 10.5, min_area: 3e-7, show_dot: false },
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn est_width(text: &str, size: f64) -> f64 {
    text.chars().map(|c| if (c as u32) > 0x2E80 { size } else { size * 0.55 }).sum()
}

fn project(lng: f64, lat: f64) -> (f64, f64) {
    let x = (lng + 180.0) / 360.0;
    let s = (lat.to_radians()).sin().clamp(-0.9999, 0.9999);
    let y = 0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * std::f64::consts::PI);
    (x, y)
}

/// 把 geometry 统一成 [[ring, hole...], ...]
fn rings(geom: &Value) -> Vec<Vec<Vec<(f64, f64)>>> {
    let t = geom.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let c = match geom.get("coordinates").and_then(|v| v.as_array()) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let parse_ring = |r: &Value| -> Vec<(f64, f64)> {
        r.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let pa = p.as_array()?;
                        Some((pa.first()?.as_f64()?, pa.get(1)?.as_f64()?))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    match t {
        "Polygon" => vec![c.iter().map(parse_ring).collect()],
        "MultiPolygon" => c
            .iter()
            .map(|poly| {
                poly.as_array().map(|rs| rs.iter().map(parse_ring).collect()).unwrap_or_default()
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// 像素级抽稀：相邻点太近就丢弃（0.6px 容差肉眼无感，但能砍掉大量冗余顶点）
fn simplify(ring: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if ring.len() < 4 {
        return ring.to_vec();
    }
    let mut out = Vec::with_capacity(ring.len());
    out.push(ring[0]);
    for pt in &ring[1..ring.len() - 1] {
        let last = out[out.len() - 1];
        if (pt.0 - last.0).abs() + (pt.1 - last.1).abs() >= tol {
            out.push(*pt);
        }
    }
    out.push(ring[ring.len() - 1]);
    if out.len() >= 3 { out } else { ring.to_vec() }
}

/// 水系层的抽稀容差：**比行政区划松**（0.6px）。
///
/// 水是背景装饰，1px 的抖动肉眼看不出来，但能砍掉约 19% 的顶点
/// （全国视图实测 75KB → 61KB）。行政区划不能被这么简化 —— 它决定点击命中的轮廓。
const HYDRO_TOL: f64 = 1.0;

/// 视口裁剪的宽容边距（px）：环的**全部**点都跑出「画布 + 这个边距」才丢弃。
/// 留边距是为了不让贴着画布边缘的河在边界处突然断掉。
const HYDRO_MARGIN: f64 = 40.0;

/// 按河流等级分三档线宽 —— 对应 Natural Earth `scalerank`（1 最大）。
/// 索引即分桶号，见 [`river_bucket`]。
const RIVER_WIDTHS: [f64; 3] = [2.0, 1.4, 1.0];

/// `scalerank` → 线宽分桶（同桶合并进同一条 `<path>`，减少元素数）
fn river_bucket(rank: i64) -> usize {
    match rank {
        ..=2 => 0,
        3..=4 => 1,
        _ => 2,
    }
}

/// 生成水系图层：`(河流 path d × 3 档, 湖泊 path d, 原始顶点数, 抽稀后顶点数)`
///
/// ## 为什么合并成最多 4 条 path，而不是一要素一条
/// 资产有 144 个要素。一要素一条 path 会把元素数抬到 ~150（现有区划才 102 条），
/// 而水层是**纯背景**（`pointer-events="none"`，没有逐要素交互需求），
/// 所以按「线宽档位」把河流并成 3 条、湖泊并成 1 条，元素数与体积都最省。
/// 湖泊的外环与洞必须留在**同一条 path** 里，`fill-rule="evenodd"` 才能把洞挖出来。
///
/// ## 视口裁剪
/// `proj` 把经纬度投到画布像素。若某个环的**所有**点都在画布外（含 [`HYDRO_MARGIN`]），
/// 整环丢弃 —— 这是下钻到市/区时水层几乎不花成本的原因
/// （实测：全国 +75KB → 省 +2KB → 市 +1KB → 区 0KB）。
fn hydro_layers(
    feats: &[hydro::Feature],
    proj: impl Fn(f64, f64) -> (f64, f64),
    w: f64,
    h: f64,
) -> (Vec<String>, String, usize, usize) {
    let mut rivers = vec![String::new(); RIVER_WIDTHS.len()];
    let mut lakes = String::new();
    let (mut raw, mut kept) = (0usize, 0usize);

    for f in feats {
        // 先投影整个要素的所有环，再决定去留（逐环裁剪）
        for ring in &f.rings {
            let px: Vec<(f64, f64)> = ring.iter().map(|&(lng, lat)| proj(lng, lat)).collect();
            if px.len() < 2 {
                continue;
            }
            // 全部点都在画布外 → 这个环看不见，省掉
            if px.iter().all(|&(x, y)| {
                x < -HYDRO_MARGIN
                    || x > w + HYDRO_MARGIN
                    || y < -HYDRO_MARGIN
                    || y > h + HYDRO_MARGIN
            }) {
                continue;
            }
            raw += px.len();
            let px = simplify(&px, HYDRO_TOL);
            if px.len() < 2 {
                continue;
            }
            kept += px.len();

            let d = match f.kind {
                hydro::Kind::River => &mut rivers[river_bucket(f.scalerank)],
                hydro::Kind::Lake => &mut lakes,
            };
            for (k, (x, y)) in px.iter().enumerate() {
                d.push(if k == 0 { 'M' } else { 'L' });
                d.push_str(&format!("{x:.1} {y:.1}"));
            }
            // 湖泊是面，必须闭合；河流是线，绝不能 Z（会画出一条回头的闭合线）
            if f.kind == hydro::Kind::Lake {
                d.push('Z');
            }
        }
    }
    (rivers, lakes, raw, kept)
}

pub struct GeoOpts {
    pub level: String,
    pub style: String,
    pub width: f64,
    pub height: f64,
    pub pad: f64,
    pub zoom: i32,
    pub labels: bool,
    pub dots: bool,
    /// 是否叠加**真实水系**（河流 / 湖泊，Natural Earth 1:50m 内嵌，见 `hydro.rs`）。
    ///
    /// 做成开关的理由：这是唯一会显著增加 SVG 体积的图层（全国视图实测 +75KB / +11%），
    /// 万一在某些设备上成为负担，调用方可以一键关掉，不必回滚代码。
    /// 关掉 = 退回加这个图层之前的渲染结果（不会白屏）。
    pub hydro: bool,
    /// 是否标注顶点抽稀统计（开发用）
    pub show_stats: bool,
}

impl Default for GeoOpts {
    fn default() -> Self {
        Self {
            level: "province".into(), style: "gaode".into(),
            width: 1000.0, height: 760.0, pad: 26.0, zoom: 2,
            labels: true, dots: true, hydro: true, show_stats: false,
        }
    }
}

/// 渲染行政区划 SVG
pub fn render_geo_svg(fc: &Value, o: &GeoOpts) -> Result<String, String> {
    let st = style_of(&o.style);
    let ls = level_style(&o.level);
    let (w, h, pad) = (o.width, o.height, o.pad);

    struct Feat {
        name: String,
        adcode: String,
        polys: Vec<Vec<Vec<(f64, f64)>>>,
        wpts: Vec<(f64, f64)>,
    }
    // 一次遍历同时拿到「多边形几何」和「投影后的点」（避免两次解析导致索引错位）
    let empty = vec![];
    let raw = fc.get("features").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut feats: Vec<Feat> = Vec::new();
    let mut all: Vec<(f64, f64)> = Vec::new();
    for rf in raw {
        let props = match rf.get("properties") {
            Some(p) => p,
            None => continue,
        };
        let name = props.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue; // 没名字的要素不画（也点不中）
        }
        let adcode = match props.get("adcode") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        let polys = match rf.get("geometry") {
            Some(g) => rings(g),
            None => continue,
        };
        let mut wpts: Vec<(f64, f64)> = Vec::new();
        for poly in &polys {
            for ring in poly {
                for &(lng, lat) in ring {
                    wpts.push(project(lng, lat));
                }
            }
        }
        if wpts.is_empty() {
            continue;
        }
        all.extend_from_slice(&wpts);
        feats.push(Feat { name, adcode, polys, wpts });
    }
    if all.is_empty() {
        return Ok(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#.to_string());
    }

    let minx = all.iter().map(|p| p.0).fold(f64::MAX, f64::min);
    let maxx = all.iter().map(|p| p.0).fold(f64::MIN, f64::max);
    let miny = all.iter().map(|p| p.1).fold(f64::MAX, f64::min);
    let maxy = all.iter().map(|p| p.1).fold(f64::MIN, f64::max);
    let bw = (maxx - minx).max(1e-12);
    let bh = (maxy - miny).max(1e-12);
    let aw = (w - 2.0 * pad).max(1.0);
    let ah = (h - 2.0 * pad).max(1.0);
    let scale = (aw / bw).min(ah / bh);
    let oxp = pad + (aw - bw * scale) / 2.0;
    let oyp = pad + (ah - bh * scale) / 2.0;
    let s = |wx: f64, wy: f64| (oxp + (wx - minx) * scale, oyp + (wy - miny) * scale);
    let total_area = bw * bh;

    let mut p: Vec<String> = Vec::new();
    p.push(format!(r#"<rect width="{w}" height="{h}" fill="{}"/>"#, st.bg));
    let mut stats = (0usize, 0usize); // (原始顶点, 保留顶点)

    // 陆地 + 三层边界
    p.push(r#"<g class="z1">"#.to_string());
    // 每个真正画出来的陆地填充 path 的 id（水系靠它做 clipPath，见下）
    let mut land_ids: Vec<usize> = Vec::new();
    for (i, f) in feats.iter().enumerate() {
        if f.polys.is_empty() {
            continue;
        }
        let mut d = String::new();
        for poly in &f.polys {
            for ring in poly {
                if ring.len() < 3 {
                    continue;
                }
                let px: Vec<(f64, f64)> = ring.iter().map(|&(lng, lat)| s(project(lng, lat).0, project(lng, lat).1)).collect();
                stats.0 += px.len();
                let px = simplify(&px, 0.6);
                stats.1 += px.len();
                for (k, (x, y)) in px.iter().enumerate() {
                    d.push(if k == 0 { 'M' } else { 'L' });
                    d.push_str(&format!("{x:.1} {y:.1}"));
                }
                if !px.is_empty() {
                    d.push('Z');
                }
            }
        }
        if d.is_empty() {
            continue;
        }
        let fill = if i % 2 == 0 { st.land } else { st.land_alt };
        p.push(format!(
            r#"<g class="geo-region" data-adcode="{}" data-name="{}" role="button" tabindex="0">"#,
            esc(&f.adcode), esc(&f.name)
        ));
        // ⚠️ 既有代码的唯一改动：给陆地填充 path 加一个 `id`。
        // 纯增量属性，不改变任何渲染结果；前端 `wsGeo.parseGeoRegions` 只读
        // `<g class="geo-region">` 上的 data-* 属性，不看这里。
        // 加它是为了让水系能用 `<clipPath><use href="#..."/></clipPath>` 复用同一份几何，
        // 而**不必把区划路径数据再抄一遍**（抄一遍全国视图要多 235KB）。
        land_ids.push(i);
        p.push(format!(
            r#"<path id="wm-geo-{i}" class="geo-fill" d="{d}" fill="{fill}" fill-rule="evenodd" stroke="{}" stroke-width="{}" stroke-linejoin="round"/>"#,
            st.border, ls.border
        ));
        p.push(format!(
            r#"<path class="z3 geo-inner" d="{d}" fill="none" fill-rule="evenodd" stroke="{}" stroke-width="2.4" stroke-linejoin="round"/>"#,
            st.inner
        ));
        p.push(format!(
            r#"<path class="z2 geo-border" d="{d}" fill="none" fill-rule="evenodd" stroke="{}" stroke-width="{}" stroke-linejoin="round" pointer-events="none"/>"#,
            st.border2, ls.border2
        ));
        p.push("</g>".to_string());
    }
    p.push("</g>".to_string());

    // ── 真实水系（河流 / 湖泊）：铺在陆地之上、标签之下 ──
    //
    // 为什么放在**行政区划组之后**：陆地填充是不透明的，水必须后画才看得见。
    // 代价是水会盖住一点省界（河流横穿省界处）—— 这与多数真实地图的观感一致，可接受。
    // `pointer-events="none"` 是必须的：区划组带 `role="button"`，水层要是吃掉了点击，
    // 「点省份下钻」就坏了。
    let mut hstats = (0usize, 0usize); // (原始顶点, 抽稀后)
    if o.hydro {
        let (rivers, lakes, raw, kept) = hydro_layers(
            hydro::features(),
            |lng, lat| {
                let q = project(lng, lat);
                s(q.0, q.1)
            },
            w,
            h,
        );
        hstats = (raw, kept);
        if !lakes.is_empty() || rivers.iter().any(|r| !r.is_empty()) {
            // 把水系**裁到当前视图真正画出来的陆地范围内**。
            //
            // 为什么需要：行政区划图只画「当前这一级」的陆地，别处是海的底色。
            // 不裁的话，下钻到广东时会看到西江从广西那段**漂在海面上**
            // （全国视图因为整块都是中国，看不出来；一钻下去就露馅）。
            //
            // 用 `<use>` 引用已经画出去的陆地 path，而**不是把 d 再抄一遍**：
            // 全国视图的区划路径有 235KB，抄一遍等于凭空多 1/3 体积；
            // 34 个 `<use>` 只有几百字节。
            // （已在 chromium/WebDriver 实测 `<clipPath><use href>` 生效。）
            p.push(r#"<clipPath id="wm-hydro-clip">"#.to_string());
            for id in &land_ids {
                p.push(format!(r##"<use href="#wm-geo-{id}"/>"##));
            }
            p.push("</clipPath>".to_string());

            p.push(
                r#"<g class="z1" pointer-events="none" clip-path="url(#wm-hydro-clip)">"#
                    .to_string(),
            );
            for (i, d) in rivers.iter().enumerate() {
                if d.is_empty() {
                    continue;
                }
                p.push(format!(
                    r#"<path class="wm-hydro-river" d="{d}" fill="none" stroke="{}" stroke-width="{:.1}" stroke-linecap="round" stroke-linejoin="round" opacity=".92"/>"#,
                    st.water_edge,
                    RIVER_WIDTHS[i]
                ));
            }
            if !lakes.is_empty() {
                p.push(format!(
                    r#"<path class="wm-hydro-lake" d="{lakes}" fill="{}" fill-rule="evenodd" stroke="{}" stroke-width="0.8" stroke-linejoin="round" opacity=".95"/>"#,
                    st.water, st.water_edge
                ));
            }
            p.push("</g>".to_string());
        }
    }

    // 标签与中心点
    if o.labels || o.dots {
        for f in &feats {
            // 面积（用 bbox 面积近似）
            let (mut fx0, mut fy0, mut fx1, mut fy1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for &(x, y) in &f.wpts {
                if x < fx0 { fx0 = x; }
                if y < fy0 { fy0 = y; }
                if x > fx1 { fx1 = x; }
                if y > fy1 { fy1 = y; }
            }
            let area = ((fx1 - fx0) * (fy1 - fy0)).max(0.0);
            if area < ls.min_area {
                continue;
            }
            let (cx, cy) = s((fx0 + fx1) / 2.0, (fy0 + fy1) / 2.0);
            if cx <= 0.0 || cx >= w || cy <= 0.0 || cy >= h {
                continue;
            }
            if o.dots && ls.show_dot {
                p.push(format!(
                    r#"<g class="z1"><circle cx="{cx:.1}" cy="{cy:.1}" r="{:.1}" fill="{}" stroke="{}" stroke-width="1.2"/></g>"#,
                    ls.dot_r, st.dot, st.text_halo
                ));
            }
            if !o.labels || f.name.trim().is_empty() {
                continue;
            }
            // 字号随面积微调（大省名牌更大）
            let rel = ((area / total_area.max(1e-12)).powf(0.18)).clamp(0.75, 1.6);
            let fs = ls.fs * rel;
            let show = if rel > 1.05 { "z1" } else { "z2" };
            let ty = cy + if ls.show_dot { ls.dot_r + fs * 0.85 } else { fs * 0.36 };
            p.push(format!(
                r#"<text class="{show}" x="{cx:.1}" y="{ty:.1}" font-size="{fs:.1}" text-anchor="middle" fill="{}" stroke="{}" stroke-width="3" paint-order="stroke" font-weight="{}">{}</text>"#,
                st.text, st.text_halo, if rel > 1.05 { 700 } else { 600 }, esc(&f.name)
            ));
        }
    }

    // 标题
    let title = match o.level.as_str() {
        "country" => "全国",
        "province" => "省域",
        "city" => "市域",
        _ => "区县",
    };
    p.push(format!(
        r#"<text class="z1" x="{:.0}" y="{:.0}" font-size="16" font-weight="700" fill="{}" stroke="{}" stroke-width="3" paint-order="stroke">{title} · {} 个区划</text>"#,
        pad - 6.0, pad - 10.0, st.text, st.text_halo, feats.len()
    ));
    let keep = if stats.0 > 0 { stats.1 as f64 / stats.0 as f64 * 100.0 } else { 100.0 };
    // 水系成本单独报：它是唯一会明显加体积的图层，开发时要能一眼看到自己花了多少
    let htail = if o.show_stats && hstats.0 > 0 {
        let hkeep = hstats.1 as f64 / hstats.0 as f64 * 100.0;
        format!(" · 水系 {}/{}（保留 {hkeep:.0}%）", hstats.1, hstats.0)
    } else {
        String::new()
    };
    let tail = if o.show_stats {
        format!(" · 顶点 {}/{}（保留 {keep:.0}%）{htail}", stats.1, stats.0)
    } else {
        String::new()
    };
    p.push(format!(
        r#"<text class="z2" x="{:.0}" y="{:.0}" font-size="11.5" text-anchor="end" fill="{}">{} · SVG{tail}</text>"#,
        w - pad + 6.0, pad - 10.0, st.sub_text, o.level
    ));

    let css = format!(
        "text{{font-family:system-ui,-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif}}\
.geo-fill{{transition:fill .16s,filter .16s;cursor:pointer}}\
.geo-region:hover .geo-fill{{filter:brightness(1.07) saturate(1.15)}}\
.geo-region:hover .geo-border{{stroke-width:2.2;stroke:#79d9ff}}\
svg[data-zoom=\"1\"] .z2,svg[data-zoom=\"1\"] .z3{{display:none}}\
svg[data-zoom=\"2\"] .z3{{display:none}}"
    );

    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0}" height="{h:.0}" viewBox="0 0 {w:.0} {h:.0}" data-zoom="{}" font-family="system-ui,sans-serif"><style>{css}</style>{}</svg>"#,
        o.zoom, p.join("")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fc() -> Value {
        json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"甲区","adcode":440103},
             "geometry":{"type":"Polygon","coordinates":[[[113.20,23.10],[113.25,23.10],[113.25,23.15],[113.20,23.15],[113.20,23.10]]]}},
            {"type":"Feature","properties":{"name":"乙区","adcode":440104},
             "geometry":{"type":"MultiPolygon","coordinates":[[[[113.25,23.10],[113.30,23.10],[113.30,23.15],[113.25,23.15],[113.25,23.10]]]]}}
        ]})
    }

    /// **全国尺度**的行政区划（覆盖中国 bbox）—— 只有视野这么大，内嵌水系才看得见。
    ///
    /// 小框的 `fc()` 特意不用来测水系：那一片（广州荔湾一带）在 NE 1:50m 里就是 0 环
    /// （实测），拿它测「水系画出来了」会永远失败，且失败原因跟渲染无关。
    fn fc_national() -> Value {
        json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"甲省","adcode":"110000"},
             "geometry":{"type":"Polygon","coordinates":[[[75.0,20.0],[134.0,20.0],[134.0,52.0],[75.0,52.0],[75.0,20.0]]]}},
            {"type":"Feature","properties":{"name":"乙省","adcode":"120000"},
             "geometry":{"type":"Polygon","coordinates":[[[90.0,25.0],[120.0,25.0],[120.0,45.0],[90.0,45.0],[90.0,25.0]]]}}
        ]})
    }

    #[test]
    fn renders_valid_svg_with_regions() {
        let o = GeoOpts { level: "city".into(), ..Default::default() };
        let svg = render_geo_svg(&fc(), &o).unwrap();
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
        assert_eq!(svg.matches(r#"class="geo-region""#).count(), 2, "两个区划各一个可点击组");
        assert!(svg.contains(r#"data-adcode="440103""#), "必须带 adcode 供下钻");
        assert!(svg.contains("甲区") && svg.contains("乙区"));
    }

    #[test]
    fn zoom_layers_present() {
        let svg = render_geo_svg(&fc(), &GeoOpts::default()).unwrap();
        assert!(svg.contains("data-zoom="));
        assert!(svg.contains("svg[data-zoom=\"1\"] .z2"), "应有缩放分层的 CSS");
        assert!(svg.contains("class=\"z1\"") || svg.contains("class=\"z2\""));
    }

    #[test]
    fn all_three_styles_distinct() {
        let mut bgs = std::collections::HashSet::new();
        for s in STYLE_NAMES {
            let o = GeoOpts { style: s.into(), ..Default::default() };
            let svg = render_geo_svg(&fc(), &o).unwrap();
            assert!(svg.contains(style_of(s).bg), "风格 {s} 底色应出现");
            bgs.insert(style_of(s).bg);
        }
        assert_eq!(bgs.len(), 3);
    }

    #[test]
    fn simplification_reduces_points() {
        // 一条密集直线（100 个几乎重合的点）
        let ring: Vec<(f64, f64)> = (0..100).map(|i| (i as f64 * 0.01, 0.0)).collect();
        let out = simplify(&ring, 0.6);
        assert!(out.len() < ring.len(), "抽稀应减少顶点：{} → {}", ring.len(), out.len());
        assert!(out.len() >= 3, "抽稀后仍应是合法多边形");
        // 首尾必须保留（闭合形状不能变形）
        assert_eq!(out[0], ring[0]);
        assert_eq!(*out.last().unwrap(), *ring.last().unwrap());
    }

    #[test]
    fn stats_line_when_requested() {
        let a = render_geo_svg(&fc(), &GeoOpts::default()).unwrap();
        let b = render_geo_svg(&fc(), &GeoOpts { show_stats: true, ..Default::default() }).unwrap();
        assert!(!a.contains("顶点"));
        assert!(b.contains("顶点"));
    }

    #[test]
    fn labels_and_dots_toggle() {
        // 用真实尺度的省域轮廓（约 5°×4°）：fc() 里的 0.05° 小区划会被
        // min_area 防糊阈值过滤掉标签，那是刻意的策略，本测试只验开关
        let big = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"甲区","adcode":440103},
             "geometry":{"type":"Polygon","coordinates":[[[110.0,20.0],[115.0,20.0],[115.0,24.0],[110.0,24.0],[110.0,20.0]]]}},
            {"type":"Feature","properties":{"name":"乙区","adcode":440104},
             "geometry":{"type":"Polygon","coordinates":[[[115.0,20.0],[120.0,20.0],[120.0,24.0],[115.0,24.0],[115.0,20.0]]]}}
        ]});
        let with = render_geo_svg(&big, &GeoOpts { level: "province".into(), ..Default::default() }).unwrap();
        let without = render_geo_svg(&big, &GeoOpts { level: "province".into(), labels: false, dots: false, ..Default::default() }).unwrap();
        assert!(with.contains(">甲区<"), "开标签时应画出区划名文字");
        // data-name 是点击下钻必需的属性，即便关标签也要保留；
        // 这里断言的是「不再画名字文字」
        assert!(!without.contains(">甲区<"), "关掉标签后不该有区划名文字");
        assert!(without.contains(r#"data-name="甲区""#), "下钻属性必须保留");
    }

    #[test]
    fn empty_fc_is_safe() {
        let empty = json!({"type":"FeatureCollection","features":[]});
        let svg = render_geo_svg(&empty, &GeoOpts::default()).unwrap();
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn names_escaped() {
        let bad = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"A&B<C>","adcode":1},
             "geometry":{"type":"Polygon","coordinates":[[[113.2,23.1],[113.3,23.1],[113.3,23.2],[113.2,23.1]]]}}]});
        let svg = render_geo_svg(&bad, &GeoOpts::default()).unwrap();
        assert!(svg.contains("A&amp;B&lt;C&gt;"));
    }

    // ───────────────────────── 真实水系图层 ─────────────────────────

    #[test]
    fn hydro_is_drawn_on_national_view() {
        let svg = render_geo_svg(&fc_national(), &GeoOpts::default()).unwrap();
        assert!(svg.contains(r#"class="wm-hydro-river""#), "全国视图该画出河流");
        assert!(svg.contains(r#"class="wm-hydro-lake""#), "全国视图该画出湖泊");
        assert!(svg.contains("fill-rule=\"evenodd\""), "湖泊要能挖洞（湖心岛）");
    }

    /// 开关必须真的能关：关掉后**一条水系 path 都没有**，但主图仍然完整可用。
    #[test]
    fn hydro_switch_off_falls_back_to_previous_output() {
        let on = render_geo_svg(&fc_national(), &GeoOpts { hydro: true, ..Default::default() }).unwrap();
        let off = render_geo_svg(&fc_national(), &GeoOpts { hydro: false, ..Default::default() }).unwrap();
        assert!(on.contains("wm-hydro-river"));
        assert!(!off.contains("wm-hydro-"), "关掉后不该有任何水系 path");
        // 退回老行为 ≠ 坏图：区划、下钻属性、结构一个都不能少
        assert_eq!(off.matches(r#"class="geo-region""#).count(), 2);
        assert!(off.contains(r#"data-adcode="110000""#));
        assert!(off.starts_with("<svg") && off.ends_with("</svg>"));
        // 而且关掉确实更小（这就是把它做成开关的意义）
        assert!(off.len() < on.len(), "关掉水系后 SVG 应当更小：{} vs {}", off.len(), on.len());
    }

    /// 水系必须**不吃点击** —— 否则「点省份下钻」全被河盖住。
    ///
    /// 同时验证裁剪：水层要挂 `clip-path` 指向那个引用陆地 path 的 `<clipPath>`，
    /// 而**不是**把区划路径数据抄一遍（抄一遍全国要多 235KB）。
    #[test]
    fn hydro_does_not_swallow_clicks() {
        let svg = render_geo_svg(&fc_national(), &GeoOpts::default()).unwrap();
        let hit = svg
            .split("<g class=\"z1\" pointer-events=\"none\" clip-path=\"url(#wm-hydro-clip)\">")
            .nth(1)
            .expect("水系应当包在 pointer-events=none + clip-path 的组里");
        let group = &hit[..hit.find("</g>").expect("组要闭合")];
        assert!(group.contains("wm-hydro-river") || group.contains("wm-hydro-lake"));
        // 区划组仍然是可点的，数量不变
        assert_eq!(svg.matches(r#"role="button""#).count(), 2, "区划仍要可点");

        // clipPath 必须**引用**陆地 path，而不是复制它们的几何
        let clip = &svg[svg.find(r#"<clipPath id="wm-hydro-clip">"#).expect("要有 clipPath")..];
        let clip = &clip[..clip.find("</clipPath>").expect("clipPath 要闭合")];
        assert!(
            clip.contains(r##"<use href="#wm-geo-0"/>"##),
            "clipPath 要引用陆地 path"
        );
        assert!(!clip.contains("<path"), "clipPath 里不该复制几何（会凭空多出体积）");
        // 每个画出来的陆地 path 都要有 id，否则 clipPath 引不到
        assert_eq!(svg.matches(r#"class="geo-fill""#).count(), 2);
        assert_eq!(svg.matches(r#"id="wm-geo-"#).count(), 2, "陆地 path 都要有 id");
    }

    /// 视野里没有水时，**不该硬画**（也不能报错）——这是下钻到市/区时的常态。
    #[test]
    fn hydro_absent_when_view_has_no_water() {
        let far = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"name":"远省","adcode":"990000"},
             "geometry":{"type":"Polygon","coordinates":[[[-60.0,-40.0],[-50.0,-40.0],[-50.0,-30.0],[-60.0,-30.0],[-60.0,-40.0]]]}}]});
        let svg = render_geo_svg(&far, &GeoOpts::default()).unwrap();
        assert!(!svg.contains("wm-hydro-"), "南大西洋那块不该冒出中国的水系");
        assert!(svg.starts_with("<svg") && svg.contains("远省"));
    }

    /// 河流是**线**：路径里不能出现 `Z`（闭合会把河画成一个圈）。
    /// 湖泊是**面**：每个环都必须 `Z` 收口。
    #[test]
    fn rivers_are_open_lines_lakes_are_closed_rings() {
        let svg = render_geo_svg(&fc_national(), &GeoOpts::default()).unwrap();
        // 取出每条河流 path 的 d
        let mut checked_rivers = 0;
        for seg in svg.split(r#"class="wm-hydro-river" d=""#).skip(1) {
            let d = &seg[..seg.find('"').expect("d 属性要闭合")];
            assert!(!d.contains('Z'), "河流不该闭合：{d:.80}");
            // 一条 path 里可以有多条折线（多次 M），但每条折线至少要有一个 L 才成线
            let ms = d.matches('M').count();
            let ls = d.matches('L').count();
            assert!(ms >= 1, "河流 path 至少要有一个 M");
            assert!(ls >= ms, "每条折线至少一个 L：M={ms} L={ls}");
            checked_rivers += 1;
        }
        assert!(checked_rivers > 0, "至少要画出一条河流");
        // 湖泊：每个子路径都要 Z
        let seg = &svg[svg.find(r#"class="wm-hydro-lake" d=""#).expect("要有湖泊")..];
        let d = &seg[seg.find("d=\"").unwrap() + 3..];
        let d = &d[..d.find('"').unwrap()];
        assert_eq!(d.matches('M').count(), d.matches('Z').count(), "湖泊每个环都要闭合");
        assert!(d.matches('M').count() >= 1);
    }

    /// 全国视图的水系体积成本要落在**实测预算**内（防止哪天换了数据源悄悄膨胀）。
    ///
    /// 实测基线：行政区划 3 遍约 705KB，水系 1 遍约 75KB（+11%）。
    /// 这里放宽到 200KB 做**回归哨兵**：真超了说明资产或抽稀参数出了问题。
    #[test]
    fn hydro_stays_within_size_budget() {
        let on = render_geo_svg(&fc_national(), &GeoOpts::default()).unwrap();
        let off = render_geo_svg(&fc_national(), &GeoOpts { hydro: false, ..Default::default() }).unwrap();
        let added = on.len() - off.len();
        assert!(added > 1000, "水系应当确实画了东西（只多了 {added} 字节）");
        assert!(added < 200_000, "水系体积超预算：+{added} 字节");
    }

    /// 三套主题都要有水色，且**水色互不相同**（夜底上和陆地的区分度全靠它）。
    #[test]
    fn all_styles_have_distinct_water_colors() {
        let mut seen = std::collections::HashSet::new();
        for s in STYLE_NAMES {
            let st = style_of(s);
            assert!(!st.water.is_empty() && !st.water_edge.is_empty(), "{s} 缺水体配色");
            assert_ne!(st.water, st.land, "{s} 的水色不能等于陆色，否则看不见");
            seen.insert(st.water);
        }
        assert_eq!(seen.len(), 3, "三套主题的水色应当各不相同");
        // 每个主题都必须真的把水色画出来
        for s in STYLE_NAMES {
            let svg = render_geo_svg(&fc_national(), &GeoOpts { style: s.into(), ..Default::default() }).unwrap();
            assert!(svg.contains(style_of(s).water), "{s} 主题没画湖泊填充色");
        }
    }

    /// `river_bucket` 的分档边界（线宽层次全靠它）
    #[test]
    fn river_bucket_splits_by_scalerank() {
        assert_eq!(river_bucket(1), 0);
        assert_eq!(river_bucket(2), 0);
        assert_eq!(river_bucket(3), 1);
        assert_eq!(river_bucket(4), 1);
        assert_eq!(river_bucket(5), 2);
        assert_eq!(river_bucket(9), 2);
        // 三档线宽必须递减，否则"分级"没意义
        assert!(RIVER_WIDTHS[0] > RIVER_WIDTHS[1]);
        assert!(RIVER_WIDTHS[1] > RIVER_WIDTHS[2]);
    }

    /// `hydro_layers` 的视口裁剪与容差：空输入安全、框外丢弃、框内保留。
    #[test]
    fn hydro_layers_culls_out_of_view() {
        let feats = hydro::parse(
            &json!({"type":"FeatureCollection","features":[
                {"type":"Feature","properties":{"k":"r","n":"框内","s":1},
                 "geometry":{"type":"LineString","coordinates":[[10.0,10.0],[11.0,10.0]]}},
                {"type":"Feature","properties":{"k":"r","n":"框外","s":1},
                 "geometry":{"type":"LineString","coordinates":[[500.0,500.0],[510.0,500.0]]}}
            ]})
            .to_string(),
        );
        // 投影：把经纬度直接当像素用（够验证裁剪逻辑），画布 100×100
        let (rivers, lakes, raw, kept) = hydro_layers(&feats, |lng, lat| (lng, lat), 100.0, 100.0);
        assert!(lakes.is_empty());
        assert_eq!(rivers.iter().filter(|r| !r.is_empty()).count(), 1, "只该留下框内那条");
        assert!(rivers[0].contains("M10"), "留下的应该是 10 那条：{}", rivers[0]);
        assert_eq!(raw, 2, "只有框内的环计入统计");
        assert_eq!(kept, 2);
        // 稍微出界但仍在 HYDRO_MARGIN 内 → 要保留（否则贴边的河会在画布边缘断掉）
        let edge = hydro::parse(
            &json!({"type":"FeatureCollection","features":[
                {"type":"Feature","properties":{"k":"r","n":"贴边","s":1},
                 "geometry":{"type":"LineString","coordinates":[[-10.0,50.0],[50.0,50.0]]}}]})
            .to_string(),
        );
        let (er, _, _, _) = hydro_layers(&edge, |lng, lat| (lng, lat), 100.0, 100.0);
        assert_eq!(er.iter().filter(|r| !r.is_empty()).count(), 1, "边距内的河要保留");
        // 空输入
        let (r2, l2, raw2, kept2) = hydro_layers(&[], |a, b| (a, b), 100.0, 100.0);
        assert!(r2.iter().all(|d| d.is_empty()) && l2.is_empty());
        assert_eq!((raw2, kept2), (0, 0));
    }

    /// 真实资产的分档必须**三档都用上** —— 否则「按等级分线宽」是摆设。
    #[test]
    fn real_asset_fills_all_three_width_buckets() {
        let mut per_bucket = [0usize; 3];
        for f in hydro::features().iter().filter(|f| f.kind == hydro::Kind::River) {
            per_bucket[river_bucket(f.scalerank)] += 1;
        }
        for (i, n) in per_bucket.iter().enumerate() {
            assert!(*n > 0, "第 {i} 档线宽没有任何要素：{per_bucket:?}");
        }
    }
}
