//! hydro.rs — 真实水系图层（河流 / 湖泊），给行政区划图（`render_geo`）用
//!
//! ## 数据来源
//!
//! Natural Earth 1:50m（**public domain，无版权限制**）的两份矢量：
//!   · `ne_50m_rivers_lake_centerlines` → 河流中心线
//!   · `ne_50m_lakes`                   → 湖泊面
//!
//! 已**预切到中国域**并压成紧凑 GeoJSON，编译期内嵌（见 [`ASSET`]）。
//! 抽取脚本：`~/rikka/Dsh-SYuki/world_map/recon/build_hydro.py`（保留以便更新数据 / 复现）。
//!
//! ## 为什么内嵌（`include_str!`）而不是运行时下载
//!
//! 本机实测（脚本 `recon/stab.sh`）：同一个 raw.githubusercontent.com 的 URL **连测 3 次只成功 1 次**，
//! 另两次 90s 超时；jsDelivr 冷缓存 86s、热缓存 4.3s。
//! **运行时依赖一个 1/3 成功率的服务 = 必然出问题。**
//! 内嵌之后：**零网络请求、零新依赖、首次安装即离线可用**，正好满足「拿不到数据不能白屏」。
//! 代价是 149KB（gzip 后约 52KB）编译进二进制 —— 相比「地图打不开」，这个代价可以接受。
//!
//! 全量 144 个要素 / 7507 个顶点，用 [`OnceLock`] 只解析一次（解析成本约 1ms 量级）。
//!
//! ## ⚠️ 覆盖度：这个图层是「全国级」的增强，不是「到处都有」
//!
//! NE 1:50m 是为**国家 / 大洲**尺度设计的，实测中国域内的可见量：
//!
//! | 视图 | 可见水系 |
//! |---|---|
//! | 全国（34 省级） | 141 环 / 5084 顶点 —— 长江、黄河、青海湖、鄱阳湖、太湖… |
//! | 省 · 广东 | 10 环 / 172 顶点 —— 西江、浔江、红水河 |
//! | 市 · 广州 | 6 环 / 40 顶点 |
//! | 区 · 荔湾 | **0 环** |
//!
//! 所以它是**全国 / 省域视图**的视觉增强。市 / 区级的真实水系要另走 OSM Overpass
//! （实测 7~20s 且会 504，只能生成阶段拉一次落缓存），**留作第二期**，不在本次范围。
//!
//! ## 数据质量抽样（确认「是中国人认得的河湖」）
//!
//! 河流：`Chang Jiang` 长江 / `Yangtze` / `Jinsha` 金沙江 / `Tongtian` 通天河 / `Tuotuo` 沱沱河 /
//!       `Huang` 黄河 / `Lancang` 澜沧江 / `Yakong`… / `Yarlung` 雅鲁藏布 / `Brahmaputra` /
//!       `Xi` 西江 / `Xun` 浔江 / `Hongshui` 红水河 / `Han` 汉江 / `Gan` 赣江 / `Yuan` 沅江
//! 湖泊：`Qinghai Hu` 青海湖 / `Poyang Hu` 鄱阳湖 / `Tai Hu` 太湖 / `Hongze Hu` 洪泽湖 /
//!       `Hulun Nuur` 呼伦湖 / `Nam Co` 纳木错 / `Bosten Hu` 博斯腾湖
//!
//! 名字目前**只解析不渲染**（全国尺度上给河流打标签会糊成一片）；
//! 字段留着，将来要做 hover 提示 / 中文名映射时不用改数据结构。
//!
//! 本模块是**纯函数**：不碰网络、不碰文件、不碰 `AppHandle`，可以直接 `cargo test`。

use serde_json::Value;
use std::sync::OnceLock;

/// 编译期内嵌的中国域水系资产（Natural Earth 1:50m 抽取，紧凑 GeoJSON）。
///
/// 149KB / 144 要素 / 7507 顶点。路径相对本文件：`src-tauri/src/world_map/` → `src-tauri/assets/`。
pub const ASSET: &str = include_str!("../../../../src-tauri/assets/hydro_cn.json");

/// 水系要素类别。
///
/// 这两个类别的**画法不同**，所以必须分开：
///   · [`Kind::River`] 是**线**（中心线），描边不填充；
///   · [`Kind::Lake`] 是**面**，填充 + 描边，且第 0 环是外环、其余是洞（`fill-rule="evenodd"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    River,
    Lake,
}

/// 一个水系要素（坐标是**原始经纬度**，投影由渲染器统一做）。
#[derive(Debug, Clone)]
pub struct Feature {
    pub kind: Kind,
    /// 名称（NE 原文，英/拼音；当前不渲染，留给将来的提示与中文映射）
    pub name: String,
    /// NE 的重要性分级：**0 最大**（越小越主干），数字越大越次要。
    /// 实测资产分布 `{0:49, 1:12, 2:18, 3:12, 4:16, 5:5, 6:32}` —— 注意 **0 是合法值**
    /// （NE 里 0 表示最高等级，比 1 还大），别把它当"没分级"。
    /// 渲染线宽用它分级。
    pub scalerank: i64,
    /// 几何环：
    ///   · 河流 → 若干条折线，每条 ≥2 点；
    ///   · 湖泊 → `[0]` 是外环、`[1..]` 是洞，均已闭合（首尾点相同）。
    pub rings: Vec<Vec<(f64, f64)>>,
    /// 要素自身的经纬度包围盒 `(min_lng, min_lat, max_lng, max_lat)`，用于粗筛。
    pub bbox: (f64, f64, f64, f64),
}

impl Feature {
    /// 折线 / 环的总点数（测试与统计用）
    pub fn vertex_count(&self) -> usize {
        self.rings.iter().map(|r| r.len()).sum()
    }
}

/// 把 `[[lng,lat], ...]` 解析成点列（丢弃非数值 / 残缺的点）
fn parse_ring(v: &Value) -> Vec<(f64, f64)> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let pa = p.as_array()?;
                    Some((pa.first()?.as_f64()?, pa.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 按 GeoJSON 规范展开 geometry → 若干「环」。
///
/// 嵌套深度（已用脚本对资产逐要素核验过，与规范一致）：
///   LineString=2 / MultiLineString=3 / Polygon=3 / MultiPolygon=4
///
/// ⚠️ 构建脚本第一版在**单部件**几何上多包了一层（`Polygon` 写成 `[[ring]]`），
/// 这会让所有湖泊解析成空 —— 已修复并在 `build_hydro.py` 侧复验。
/// 本函数的测试用**两种嵌套**分别覆盖，防止资产再被生成错。
fn rings_of(geom: &Value) -> Vec<Vec<(f64, f64)>> {
    let t = geom.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let c = match geom.get("coordinates") {
        Some(c) => c,
        None => return Vec::new(),
    };
    let arr = match c.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    match t {
        "LineString" => {
            let r = parse_ring(c);
            if r.len() >= 2 {
                out.push(r);
            }
        },
        "MultiLineString" => {
            for ln in arr {
                let r = parse_ring(ln);
                if r.len() >= 2 {
                    out.push(r);
                }
            }
        },
        "Polygon" => {
            // coordinates 直接就是环数组：[ring, hole...]
            for ring in arr {
                let r = parse_ring(ring);
                if r.len() >= 3 {
                    out.push(r);
                }
            }
        },
        "MultiPolygon" => {
            // coordinates 是「多边形数组」，每个多边形是 [ring, hole...]
            for poly in arr {
                if let Some(rings) = poly.as_array() {
                    for ring in rings {
                        let r = parse_ring(ring);
                        if r.len() >= 3 {
                            out.push(r);
                        }
                    }
                }
            }
        },
        _ => {},
    }
    out
}

fn bbox_of(rings: &[Vec<(f64, f64)>]) -> (f64, f64, f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for r in rings {
        for &(lng, lat) in r {
            if lng < x0 {
                x0 = lng;
            }
            if lat < y0 {
                y0 = lat;
            }
            if lng > x1 {
                x1 = lng;
            }
            if lat > y1 {
                y1 = lat;
            }
        }
    }
    if x0 > x1 {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (x0, y0, x1, y1)
}

/// 解析水系 GeoJSON 文本。
///
/// **容错**：任何字段缺失 / 类型不对 / 几何为空，都只是**跳过该要素**，
/// 绝不 panic、绝不返回 Err —— 水系只是叠加层，坏了也不能影响行政边界那张主图。
pub fn parse(text: &str) -> Vec<Feature> {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let empty = vec![];
    let list = v
        .get("features")
        .and_then(|f| f.as_array())
        .unwrap_or(&empty);
    let mut out = Vec::with_capacity(list.len());
    for f in list {
        let props = f.get("properties");
        let kind = match props.and_then(|p| p.get("k")).and_then(|k| k.as_str()) {
            Some("r") => Kind::River,
            Some("l") => Kind::Lake,
            _ => continue,
        };
        let geom = match f.get("geometry") {
            Some(g) => g,
            None => continue,
        };
        let rings = rings_of(geom);
        if rings.is_empty() {
            continue;
        }
        let name = props
            .and_then(|p| p.get("n"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        let scalerank = props
            .and_then(|p| p.get("s"))
            .and_then(|s| s.as_i64())
            .unwrap_or(9);
        let bbox = bbox_of(&rings);
        out.push(Feature {
            kind,
            name,
            scalerank,
            rings,
            bbox,
        });
    }
    out
}

/// 内嵌资产解析结果（进程内只解析一次）。
///
/// 用 `OnceLock`（std，1.70+ 稳定）而不是 `lazy_static` / `once_cell` —— **零新增依赖**是硬约束。
pub fn features() -> &'static [Feature] {
    static CACHE: OnceLock<Vec<Feature>> = OnceLock::new();
    CACHE.get_or_init(|| parse(ASSET)).as_slice()
}

/// 按经纬度范围粗筛「可能出现在图上的」要素。
///
/// **判据是「要素 bbox 与查询 bbox 相交」，不是「要素完全落在框内」** ——
/// 这是刻意的：长江横跨半个中国，要按「完全在框内」筛，全国视图上一条河都剩不下，
/// 或者河流在框边被切断成断头线。相交即保留，完整的一条河看起来才对。
///
/// 这只是**便宜的预筛**，真正精确的裁剪在渲染器里按投影后的像素坐标做（见 `render_geo`）。
pub fn within(feats: &[Feature], bbox: (f64, f64, f64, f64)) -> Vec<&Feature> {
    let (x0, y0, x1, y1) = bbox;
    feats
        .iter()
        .filter(|f| {
            let (a0, b0, a1, b1) = f.bbox;
            a0 <= x1 && a1 >= x0 && b0 <= y1 && b1 >= y0
        })
        .collect()
}

/// 统计口径：`(河流要素数, 湖泊要素数, 顶点数)` —— 给自检 / 诊断用。
pub fn counts(feats: &[Feature]) -> (usize, usize, usize) {
    let r = feats.iter().filter(|f| f.kind == Kind::River).count();
    let l = feats.iter().filter(|f| f.kind == Kind::Lake).count();
    (r, l, feats.iter().map(|f| f.vertex_count()).sum())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_asset_parses_and_is_china_scale() {
        let fs = features();
        let (rivers, lakes, verts) = counts(fs);
        // 资产是**按中国国界裁过**的：数量级不该有剧烈变化。
        // 参考值（第二版国界裁剪后）：河流 47 / 湖泊 36 / 顶点 3316。
        assert!(rivers >= 30, "河流要素太少：{rivers}");
        assert!(lakes >= 20, "湖泊要素太少：{lakes}");
        assert!(verts > 2000, "顶点太少：{verts}");
        assert_eq!(fs.len(), rivers + lakes, "每个要素必须归入河流或湖泊");
        // 所有点都应该在（放宽的）中国域内 —— 资产是预切的
        for f in fs {
            let (x0, y0, x1, y1) = f.bbox;
            assert!(
                x0 >= 70.0 && x1 <= 140.0,
                "经度越界：{} {}（{}）",
                x0,
                x1,
                f.name
            );
            assert!(
                y0 >= 15.0 && y1 <= 60.0,
                "纬度越界：{} {}（{}）",
                y0,
                y1,
                f.name
            );
        }
    }

    /// 国界裁剪的**回归哨兵**：不该再出现「漂在海面上的河」。
    ///
    /// 第一版按 bbox 粗裁，把湄公河 / 伊洛瓦底江在越南、缅甸的河段也留下了，
    /// 而行政区划图只画中国 → 那些河画在「海」的底色上，肉眼可见一片悬空的线。
    /// 这里直接断言「邻国的代表性河流不该出现」（它们的中国段另有名字），
    /// 同时确认中国段没被误砍。
    #[test]
    fn no_foreign_rivers_leaked_in() {
        let fs = features();
        let names: Vec<&str> = fs.iter().map(|f| f.name.as_str()).collect();
        // 这几个名字只在境外段使用；中国境内段叫 Lancang / Yarlung / Dihang。
        // 它们出现 = 国界裁剪失效了。
        for bad in ["Mekong", "Brahmaputra", "Irrawaddy Delta"] {
            assert!(!names.contains(&bad), "境外河段漏进来了：{bad}");
        }
        // 而中国境内的名字必须还在
        for want in ["Lancang", "Yarlung", "Chang Jiang", "Huang"] {
            assert!(names.contains(&want), "国界裁剪把 {want} 也砍掉了");
        }
    }

    #[test]
    fn asset_contains_recognizable_chinese_water() {
        // 数据质量的「哨兵」：这几条/几个是任何中国地图都该有的。
        // 万一将来换数据源换坏了，这条测试会第一时间报出来。
        let fs = features();
        let names: Vec<&str> = fs.iter().map(|f| f.name.as_str()).collect();
        for want in ["Chang Jiang", "Huang", "Qinghai Hu", "Poyang Hu", "Tai Hu"] {
            assert!(
                names.contains(&want),
                "资产里找不到 {want}；现有：{names:?}"
            );
        }
    }

    #[test]
    fn rivers_are_lines_lakes_are_rings() {
        let fs = features();
        let mut saw_river = false;
        let mut saw_lake = false;
        for f in fs {
            for r in &f.rings {
                match f.kind {
                    // 河流是线：至少两个点
                    Kind::River => {
                        assert!(r.len() >= 2, "河流折线至少 2 点：{}", f.name);
                        saw_river = true;
                    },
                    // 湖泊是面：至少 3 点，且必须闭合（首尾相同）
                    Kind::Lake => {
                        assert!(r.len() >= 3, "湖泊环至少 3 点：{}", f.name);
                        assert_eq!(r[0], r[r.len() - 1], "湖泊环必须闭合：{}", f.name);
                        saw_lake = true;
                    },
                }
            }
        }
        assert!(saw_river && saw_lake);
    }

    #[test]
    fn scalerank_is_populated() {
        let fs = features();
        // NE 的 scalerank：0 是最高等级（不是"缺失"），缺字段才落到 9
        assert!(fs.iter().all(|f| f.scalerank >= 0), "scalerank 不该为负");
        assert!(
            fs.iter().any(|f| f.scalerank <= 1),
            "没有任何最高等级河流，线宽分级会失效"
        );
        // 分级要有跨度，否则「按等级分线宽」退化成一种线宽
        let distinct: std::collections::HashSet<i64> = fs.iter().map(|f| f.scalerank).collect();
        assert!(distinct.len() >= 3, "scalerank 取值太单一：{distinct:?}");
    }

    /// 单部件几何**不能多包一层** —— 这正是构建脚本第一版的 bug。
    #[test]
    fn single_part_geometry_nesting_is_correct() {
        let text = json!({"type":"FeatureCollection","features":[
            // LineString：coordinates 直接是点数组
            {"type":"Feature","properties":{"k":"r","n":"甲河","s":1},
             "geometry":{"type":"LineString","coordinates":[[110.0,30.0],[111.0,31.0]]}},
            // Polygon：coordinates 直接是环数组
            {"type":"Feature","properties":{"k":"l","n":"乙湖","s":2},
             "geometry":{"type":"Polygon","coordinates":[[[110.0,30.0],[111.0,30.0],[111.0,31.0],[110.0,30.0]]]}}
        ]})
        .to_string();
        let fs = parse(&text);
        assert_eq!(fs.len(), 2, "两个要素都该解析出来（多包一层会解析成空）");
        assert_eq!(fs[0].kind, Kind::River);
        assert_eq!(fs[0].rings.len(), 1);
        assert_eq!(fs[0].rings[0].len(), 2);
        assert_eq!(fs[1].kind, Kind::Lake);
        assert_eq!(fs[1].rings.len(), 1, "单部件 Polygon 应解析出 1 个环");
        assert_eq!(fs[1].rings[0].len(), 4);
    }

    /// 多部件几何：展开成多个环，且湖泊的**洞**要保留（第 1 环以后）。
    #[test]
    fn multi_part_geometry_expands_rings() {
        let text = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"k":"r","n":"多段河","s":3},
             "geometry":{"type":"MultiLineString","coordinates":[
                [[110.0,30.0],[111.0,30.0]], [[112.0,31.0],[113.0,31.0]]]}},
            {"type":"Feature","properties":{"k":"l","n":"带岛湖","s":2},
             "geometry":{"type":"MultiPolygon","coordinates":[
                [[[110.0,30.0],[112.0,30.0],[112.0,32.0],[110.0,30.0]],
                 [[110.5,30.5],[111.0,30.5],[111.0,31.0],[110.5,30.5]]]]}}
        ]})
        .to_string();
        let fs = parse(&text);
        assert_eq!(fs[0].rings.len(), 2, "MultiLineString 应展开成 2 条折线");
        assert_eq!(
            fs[1].rings.len(),
            2,
            "Polygon 的外环 + 洞都要保留（洞靠 evenodd 挖空）"
        );
    }

    /// 坏数据一律跳过，不 panic —— 水系坏了不能连累主图。
    #[test]
    fn malformed_input_is_skipped_not_panicking() {
        // 完全不是 JSON
        assert!(parse("").is_empty());
        assert!(parse("not json at all").is_empty());
        assert!(parse("{}").is_empty());
        assert!(parse(r#"{"features":[]}"#).is_empty());
        // 各类残缺要素
        let text = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"k":"r"}},                                  // 没 geometry
            {"type":"Feature","properties":{"k":"x"},"geometry":{"type":"Point","coordinates":[1.0,2.0]}}, // 未知 k + 不支持的几何
            {"type":"Feature","properties":{"k":"l"},"geometry":{"type":"Polygon","coordinates":[]}},      // 空几何
            {"type":"Feature","properties":{"k":"r"},"geometry":{"type":"LineString","coordinates":[[1.0]]}}, // 单点
            {"type":"Feature","properties":{"k":"r","n":"好河","s":1},
             "geometry":{"type":"LineString","coordinates":[[110.0,30.0],[111.0,30.0]]}}  // 唯一的有效要素
        ]})
        .to_string();
        let fs = parse(&text);
        assert_eq!(fs.len(), 1, "只有最后那条有效");
        assert_eq!(fs[0].name, "好河");
    }

    /// 缺 name / scalerank 要有兜底，不能整条丢掉。
    #[test]
    fn missing_optional_properties_get_defaults() {
        let text = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"k":"r"},
             "geometry":{"type":"LineString","coordinates":[[110.0,30.0],[111.0,30.0]]}}
        ]})
        .to_string();
        let fs = parse(&text);
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].name, "", "没名字就是空串");
        assert_eq!(fs[0].scalerank, 9, "没分级按最次要处理");
    }

    /// `within` 的判据是**相交**而非包含 —— 横跨半张图的河不能因为「没完全落框」被丢掉。
    #[test]
    fn within_keeps_crossing_features() {
        let text = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"k":"r","n":"横跨河","s":1},
             "geometry":{"type":"LineString","coordinates":[[100.0,30.0],[130.0,30.0]]}},
            {"type":"Feature","properties":{"k":"l","n":"远处湖","s":2},
             "geometry":{"type":"Polygon","coordinates":[[[10.0,10.0],[11.0,10.0],[11.0,11.0],[10.0,10.0]]]}}
        ]})
        .to_string();
        let fs = parse(&text);
        let vis = within(&fs, (110.0, 25.0, 120.0, 35.0));
        assert_eq!(vis.len(), 1, "只该命中横跨的那条河");
        assert_eq!(vis[0].name, "横跨河");
        // 查询框完全在图外
        assert!(within(&fs, (0.0, 0.0, 1.0, 1.0)).is_empty());
        // 查询框覆盖全部
        assert_eq!(within(&fs, (-180.0, -90.0, 180.0, 90.0)).len(), 2);
    }

    #[test]
    fn counts_and_vertex_count_agree() {
        let text = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"k":"r","n":"a","s":1},
             "geometry":{"type":"LineString","coordinates":[[1.0,1.0],[2.0,2.0],[3.0,3.0]]}},
            {"type":"Feature","properties":{"k":"l","n":"b","s":1},
             "geometry":{"type":"Polygon","coordinates":[[[1.0,1.0],[2.0,1.0],[2.0,2.0],[1.0,1.0]]]}}
        ]})
        .to_string();
        let fs = parse(&text);
        assert_eq!(counts(&fs), (1, 1, 7));
    }
}
