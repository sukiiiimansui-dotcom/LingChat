//! layout_clean.rs — AI 精绘布局的**几何净化**
//!
//! ## 为什么需要它（路线图 ②「城市建筑去重」的真正落点）
//!
//! 小区布局有两条来源，**只有一条是干净的**：
//!
//! | 来源 | 重叠保证 |
//! |---|---|
//! | 规则草图 `sketch::make_sketch` | ✅ 有 `occ` 占用表 + `overlaps()` 逐栋拒绝重叠 |
//! | **AI 精绘**（LLM 返回的布局） | ❌ **完全没有几何校验** |
//!
//! AI 布局一路走到画布的链路是：
//! `bridge::run_stream` → `stream::assemble_layout` → `Event::Done.layout`
//! → 前端 `WsDistrict.vue` 的 `paint.loadLayout(ev.layout)`（**整份替换**画布）
//!
//! 中间**没有任何一步检查坐标是否合法**。提示词里确实写了「建筑不要重叠」
//! （`stream::build_prompt` 规则 1），但**写了不等于模型会遵守**，
//! 而违反了也没有任何东西拦得住 —— 重叠的楼会原样画出来。
//!
//! 本模块就是那道闸：在 `assemble_layout` 出口处过一遍。
//!
//! ## 设计原则：**宁可少剔，不可误删**
//!
//! 这份数据是 LLM 按剧情画出来的，剔除等于**覆盖模型的意图**。所以：
//!
//! · **只剔「确定是错的」**：退化矩形（w/h ≤ 0）、完全在画布外、零长度道路；
//! · **部分越界一律夹取（clamp）而不是丢弃** —— 越界一两格是最常见的模型失误，
//!   夹回来就对了，丢掉反而少一栋楼；
//! · **重叠要有「够像重复」才剔**：阈值 [`OVERLAP_RATIO`] = 0.65，
//!   即重叠面积达到**较小那栋**的 65% 才算重复。两栋楼贴边蹭到一点点（常见且正常）不会被动。
//!   剔除时**丢掉后出现的那栋**，保住 LLM 先画的那栋 —— 顺序即意图。
//! · **只对 buildings 做重叠剔除**：parks / water 互相压边是正常画法，
//!   建筑压公园也只是观感问题，不值得冒误删的风险。
//!
//! ## 「剔了要能看见」
//!
//! 静默改数据是最难查的一类 bug。所以 [`clean`] 返回 [`CleanStats`]，并且：
//!   · 调用方用 `tracing::info!` 打一行（跑真机时日志里能看见剔了几栋、为什么）；
//!   · 统计还会以 `_clean` 键**写回布局本身**，随 `done` 事件到前端、随地图库落盘，
//!     事后排查「为什么这栋楼不见了」时有据可查。
//!
//! ## 纯函数
//!
//! 不碰网络、不碰文件、不碰 `AppHandle`、不用随机数 —— 同样输入永远同样输出，
//! 可以直接 `cargo test`，也可以在渲染前反复调用（幂等：净化过的布局再净化不会有变化）。

use serde_json::{Value, json};

/// 重叠面积达到**较小那栋面积**的这个比例，就判定为「重复」，去掉后出现的那栋。
///
/// 为什么是 0.65 而不是 0.5：两栋楼贴边或轻微搭接是**正常画法**（LLM 也常这么画），
/// 阈值定低会开始误删合理的布局。0.65 大约等于「同一栋楼被画了两遍（可能略有偏移）」。
const OVERLAP_RATIO: f64 = 0.65;

/// 建筑数量超过这个值就**跳过重叠剔除**（只做退化/越界处理）。
///
/// 重叠剔除是两两比较（O(n²)）。正常布局只有 `size * 0.7` 栋（size ≤ 36 → ≤ 25 栋），
/// 但模型抽风时可能吐出上万条。这个上限保证**永远不会因为一份坏输入卡住渲染线程**；
/// 跳过时会记进 [`CleanStats::overlap_skipped`]，不静默。
const MAX_DEDUP_BUILDINGS: usize = 2000;

/// 净化统计：剔了什么、夹了什么。**这是「让改动可见」的载体**，别把它丢掉。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CleanStats {
    pub buildings_in: usize,
    pub buildings_out: usize,
    /// 退化（w/h ≤ 0、缺字段、NaN/Inf）
    pub buildings_degenerate: usize,
    /// 完全在画布外
    pub buildings_out_of_bounds: usize,
    /// 判定为与前面某栋重复
    pub buildings_overlap: usize,
    /// 部分越界、被夹回画布内（**不是**错误，是修正）
    pub buildings_clamped: usize,
    pub roads_in: usize,
    pub roads_out: usize,
    pub roads_degenerate: usize,
    pub roads_clamped: usize,
    /// parks + water 合计
    pub areas_in: usize,
    pub areas_out: usize,
    pub areas_dropped: usize,
    /// `size` 缺失/非法、被兜底值替换
    pub size_fixed: bool,
    /// 建筑太多、跳过了重叠剔除
    pub overlap_skipped: bool,
}

impl CleanStats {
    /// 一共剔掉了多少个图元（不含「夹取」，夹取是保留）
    pub fn removed(&self) -> usize {
        self.buildings_degenerate
            + self.buildings_out_of_bounds
            + self.buildings_overlap
            + self.roads_degenerate
            + self.areas_dropped
    }

    /// 有没有发生任何改动（调用方据此决定要不要打日志）
    pub fn touched(&self) -> bool {
        self.removed() > 0
            || self.buildings_clamped > 0
            || self.roads_clamped > 0
            || self.size_fixed
            || self.overlap_skipped
    }

    /// 一行中文摘要（给日志与 `_clean` 用）
    pub fn summary(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.buildings_degenerate + self.buildings_out_of_bounds + self.buildings_overlap > 0 {
            parts.push(format!(
                "建筑 {}→{}（退化 {} / 出界 {} / 重复 {}）",
                self.buildings_in,
                self.buildings_out,
                self.buildings_degenerate,
                self.buildings_out_of_bounds,
                self.buildings_overlap
            ));
        }
        if self.buildings_clamped > 0 {
            parts.push(format!("夹回出界建筑 {} 栋", self.buildings_clamped));
        }
        if self.roads_degenerate > 0 || self.roads_clamped > 0 {
            parts.push(format!(
                "道路 {}→{}（退化 {} / 夹回 {}）",
                self.roads_in, self.roads_out, self.roads_degenerate, self.roads_clamped
            ));
        }
        if self.areas_dropped > 0 {
            parts.push(format!("绿地水体 {}→{}", self.areas_in, self.areas_out));
        }
        if self.size_fixed {
            parts.push("size 非法已兜底".to_string());
        }
        if self.overlap_skipped {
            parts.push(format!("建筑超过 {MAX_DEDUP_BUILDINGS} 栋，已跳过重叠剔除"));
        }
        if parts.is_empty() {
            "无需净化".to_string()
        } else {
            parts.join("；")
        }
    }

    /// 写进布局 `_clean` 键的 JSON（中文摘要 + 结构化计数，两边都要）
    pub fn to_json(&self) -> Value {
        json!({
            "summary": self.summary(),
            "removed": self.removed(),
            "buildings": {
                "in": self.buildings_in, "out": self.buildings_out,
                "degenerate": self.buildings_degenerate,
                "outOfBounds": self.buildings_out_of_bounds,
                "overlap": self.buildings_overlap,
                "clamped": self.buildings_clamped,
            },
            "roads": {
                "in": self.roads_in, "out": self.roads_out,
                "degenerate": self.roads_degenerate, "clamped": self.roads_clamped,
            },
            "areas": { "in": self.areas_in, "out": self.areas_out },
            "sizeFixed": self.size_fixed,
            "overlapSkipped": self.overlap_skipped,
        })
    }
}

/// 取数值字段；缺失 / 非数值 / NaN / Inf 一律返回 `None`（**不**用默认值掩盖问题）
fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// 一个矩形 `(x, y, w, h)`，只在**确认四个字段都是有限数**时才有值
fn rect_of(v: &Value) -> Option<(f64, f64, f64, f64)> {
    Some((num(v, "x")?, num(v, "y")?, num(v, "w")?, num(v, "h")?))
}

/// 矩形两两重叠面积（不相交 = 0）
fn overlap_area(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    let (ax0, ay0, aw, ah) = a;
    let (bx0, by0, bw, bh) = b;
    let (ax1, ay1) = (ax0 + aw, ay0 + ah);
    let (bx1, by1) = (bx0 + bw, by0 + bh);
    let ox = ax1.min(bx1) - ax0.max(bx0);
    let oy = ay1.min(by1) - ay0.max(by0);
    if ox > 0.0 && oy > 0.0 { ox * oy } else { 0.0 }
}

/// 净化一个矩形数组（buildings / parks / water 共用）。
///
/// 返回**保留下来**的数组。处理顺序：退化 → 越界（夹取或丢弃）→（可选）重叠剔除。
///
/// `dedup` 只有 buildings 传 `true`：绿地/水体互相压边是正常画法（见模块文档）。
fn clean_rects(items: &[Value], size: f64, dedup: bool, st: &mut CleanStats) -> Vec<Value> {
    let mut kept: Vec<(f64, f64, f64, f64, Value)> = Vec::with_capacity(items.len());
    for it in items {
        let Some((x, y, w, h)) = rect_of(it) else {
            st.buildings_degenerate += 1; // 调用方会按类别把这两类数字搬走
            continue;
        };
        if w <= 0.0 || h <= 0.0 {
            st.buildings_degenerate += 1;
            continue;
        }
        // 与画布求交；完全没有交集 = 彻底在画布外 → 丢
        let x0 = x.max(0.0);
        let y0 = y.max(0.0);
        let x1 = (x + w).min(size);
        let y1 = (y + h).min(size);
        if x1 <= x0 || y1 <= y0 {
            st.buildings_out_of_bounds += 1;
            continue;
        }
        let (nw, nh) = (x1 - x0, y1 - y0);
        if nw < w || nh < h {
            st.buildings_clamped += 1;
        }
        let mut v = it.clone();
        if let Some(o) = v.as_object_mut() {
            // 坐标统一成整数格：渲染侧（render.rs / wsDistrictPaint）本来就是格子坐标，
            // 夹取后可能出现小数（模型给的就是小数），取整避免画出半格宽的建筑。
            // `w`/`h` 至少留 1 格，否则又变成退化矩形。
            o.insert("x".into(), json!(x0.round() as i64));
            o.insert("y".into(), json!(y0.round() as i64));
            o.insert("w".into(), json!((nw.round() as i64).max(1)));
            o.insert("h".into(), json!((nh.round() as i64).max(1)));
        }
        kept.push((x0, y0, nw.max(1.0), nh.max(1.0), v));
    }

    if !dedup || kept.len() <= 1 {
        return kept.into_iter().map(|t| t.4).collect();
    }
    if kept.len() > MAX_DEDUP_BUILDINGS {
        st.overlap_skipped = true;
        return kept.into_iter().map(|t| t.4).collect();
    }

    // 两两比较：重叠达到较小那栋的 OVERLAP_RATIO → 丢掉**后出现**的那栋
    let n = kept.len();
    let mut keep = vec![true; n];
    for i in 0..n {
        if !keep[i] {
            continue;
        }
        let a = (kept[i].0, kept[i].1, kept[i].2, kept[i].3);
        let area_a = a.2 * a.3;
        for j in (i + 1)..n {
            if !keep[j] {
                continue;
            }
            let b = (kept[j].0, kept[j].1, kept[j].2, kept[j].3);
            let ov = overlap_area(a, b);
            if ov <= 0.0 {
                continue;
            }
            let min_area = area_a.min(b.2 * b.3);
            if min_area > 0.0 && ov / min_area >= OVERLAP_RATIO {
                keep[j] = false;
                st.buildings_overlap += 1;
            }
        }
    }
    kept.into_iter()
        .zip(keep)
        .filter_map(|(t, k)| if k { Some(t.4) } else { None })
        .collect()
}

/// 净化道路：两端点必须有限、不能是零长度；坐标夹进 `0..=size`。
///
/// 注意道路的合法范围是 `0..=size`（**含** size）—— 提示词给的样例就是
/// `{"x1":0,"y1":0,"x2":size,"y2":0}`，横穿整条边的路是合法的。
fn clean_roads(items: &[Value], size: f64, st: &mut CleanStats) -> Vec<Value> {
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let (Some(x1), Some(y1), Some(x2), Some(y2)) =
            (num(it, "x1"), num(it, "y1"), num(it, "x2"), num(it, "y2"))
        else {
            st.roads_degenerate += 1;
            continue;
        };
        let cl = |v: f64| v.clamp(0.0, size);
        let (cx1, cy1, cx2, cy2) = (cl(x1), cl(y1), cl(x2), cl(y2));
        if (cx1 - cx2).abs() < 1e-9 && (cy1 - cy2).abs() < 1e-9 {
            st.roads_degenerate += 1; // 夹取后塌成一个点 = 零长度，画不出东西
            continue;
        }
        if (cx1, cy1, cx2, cy2) != (x1, y1, x2, y2) {
            st.roads_clamped += 1;
        }
        let mut v = it.clone();
        if let Some(o) = v.as_object_mut() {
            o.insert("x1".into(), json!(cx1.round() as i64));
            o.insert("y1".into(), json!(cy1.round() as i64));
            o.insert("x2".into(), json!(cx2.round() as i64));
            o.insert("y2".into(), json!(cy2.round() as i64));
        }
        out.push(v);
    }
    out
}

/// 净化一份布局（**就地修改**），返回统计。
///
/// `fallback_size`：布局里 `size` 缺失/非法时的兜底网格边长（调用方传生成时的 `base`）。
///
/// **幂等**：净化过的布局再净化一次，统计为零、内容不变。
/// 任何字段缺失 / 类型不对都只是**跳过**，绝不 panic —— 净化坏了不能连累出图。
pub fn clean(layout: &mut Value, fallback_size: f64) -> CleanStats {
    let mut st = CleanStats::default();
    let Some(obj) = layout.as_object_mut() else {
        return st;
    };

    // ── size：必须是一个正的有限数 ──
    let size = obj
        .get("size")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s > 0.0);
    let size = match size {
        Some(s) => s,
        None => {
            st.size_fixed = true;
            let fb = if fallback_size.is_finite() && fallback_size > 0.0 {
                fallback_size
            } else {
                20.0
            };
            obj.insert("size".into(), json!(fb.round() as i64));
            fb
        },
    };

    // ── buildings（唯一做重叠剔除的一类）──
    let buildings: Vec<Value> = obj
        .get("buildings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    st.buildings_in = buildings.len();
    let cleaned = clean_rects(&buildings, size, true, &mut st);
    st.buildings_out = cleaned.len();
    obj.insert("buildings".into(), json!(cleaned));

    // ── parks / water：只做退化 + 越界，**不做重叠剔除**（见模块文档）──
    for key in ["parks", "water"] {
        let items: Vec<Value> = obj
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let before = items.len();
        st.areas_in += before;
        // 借用 buildings 的三个计数器，跑完再折算回 areas（少一套重复逻辑）
        let mut tmp = CleanStats::default();
        let cleaned = clean_rects(&items, size, false, &mut tmp);
        st.areas_dropped += tmp.buildings_degenerate + tmp.buildings_out_of_bounds;
        st.areas_out += cleaned.len();
        obj.insert(key.to_string(), json!(cleaned));
    }

    // ── roads ──
    let roads: Vec<Value> = obj
        .get("roads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    st.roads_in = roads.len();
    let cleaned = clean_roads(&roads, size, &mut st);
    st.roads_out = cleaned.len();
    obj.insert("roads".into(), json!(cleaned));

    // ── 把统计写回布局，让「剔了什么」跟着数据走 ──
    obj.insert("_clean".into(), st.to_json());
    st
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lay(buildings: Value) -> Value {
        json!({"name":"测试小区","size":20,"buildings":buildings,"roads":[],"parks":[],"water":[]})
    }
    fn n(v: &Value) -> usize {
        v["buildings"].as_array().map_or(0, |a| a.len())
    }

    #[test]
    fn clean_layout_is_left_alone() {
        // 一份完全合法的布局：一栋都不该动（这是最重要的一条 —— 不能误删）
        let mut v = lay(json!([
            {"x":1,"y":1,"w":3,"h":2,"type":"residential","name":"1号楼","floors":6},
            {"x":5,"y":1,"w":3,"h":2,"type":"office","name":"云顶大厦","floors":12},
            {"x":1,"y":5,"w":3,"h":2,"type":"shop","name":"临江商铺","floors":2}
        ]));
        let before = v.clone();
        let st = clean(&mut v, 20.0);
        assert_eq!(st.removed(), 0, "合法布局不该剔任何东西：{st:?}");
        assert!(!st.touched());
        assert_eq!(n(&v), 3);
        // 除了写回 _clean，其余内容逐字不变
        let mut b2 = before;
        b2.as_object_mut().unwrap().remove("_clean");
        let mut v2 = v.clone();
        v2.as_object_mut().unwrap().remove("_clean");
        assert_eq!(b2, v2, "合法布局的内容必须原样保留");
    }

    #[test]
    fn touching_edges_is_not_overlap() {
        // 贴边（共用一条边）重叠面积为 0 → 必须都留下。
        // 阈值定得激进的实现会在这里翻车。
        let mut v = lay(json!([
            {"x":1,"y":1,"w":3,"h":2},
            {"x":4,"y":1,"w":3,"h":2}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 2, "贴边不是重叠");
        assert_eq!(st.buildings_overlap, 0);
    }

    #[test]
    fn slight_overlap_is_tolerated() {
        // 搭接一点点：重叠 1 格 / 较小那栋 6 格 = 16.7% < 65% → 都留
        let mut v = lay(json!([
            {"x":1,"y":1,"w":3,"h":2},
            {"x":3,"y":1,"w":3,"h":2}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 2, "轻微搭接是正常画法，不该剔");
        assert_eq!(st.buildings_overlap, 0);
    }

    #[test]
    fn exact_duplicate_is_deduped() {
        let mut v = lay(json!([
            {"x":2,"y":2,"w":4,"h":3,"name":"甲楼"},
            {"x":2,"y":2,"w":4,"h":3,"name":"甲楼"}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 1, "完全重复要剔掉一栋");
        assert_eq!(st.buildings_overlap, 1);
        assert_eq!(v["buildings"][0]["name"], json!("甲楼"));
    }

    /// 剔除时**丢后面那栋**：顺序即模型意图，先画的那栋更可能是「正主」。
    #[test]
    fn dedup_drops_the_later_one() {
        let mut v = lay(json!([
            {"x":2,"y":2,"w":4,"h":3,"name":"先画的"},
            {"x":2,"y":2,"w":4,"h":3,"name":"后画的"}
        ]));
        clean(&mut v, 20.0);
        assert_eq!(v["buildings"][0]["name"], json!("先画的"));
        assert_eq!(n(&v), 1);
    }

    /// 一栋完全被另一栋包住：重叠 = 小那栋的全部面积 → 剔掉小的（后出现的）。
    #[test]
    fn contained_building_is_deduped() {
        let mut v = lay(json!([
            {"x":1,"y":1,"w":6,"h":6,"name":"大"},
            {"x":2,"y":2,"w":2,"h":2,"name":"小"}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 1);
        assert_eq!(v["buildings"][0]["name"], json!("大"));
        assert_eq!(st.buildings_overlap, 1);
    }

    #[test]
    fn degenerate_rects_are_dropped() {
        let mut v = lay(json!([
            {"x":1,"y":1,"w":0,"h":2},
            {"x":1,"y":1,"w":3,"h":0},
            {"x":1,"y":1,"w":-2,"h":2},
            {"x":1,"y":1,"h":2},
            {"x":1,"y":1,"w":3,"h":2}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 1, "只有最后一条是合法的");
        assert_eq!(st.buildings_degenerate, 4);
    }

    /// 非有限数（NaN / Inf）必须当作退化处理 —— 直接进 SVG 会让整张图坏掉。
    #[test]
    fn non_finite_values_are_dropped() {
        let mut v = json!({"size":20,"buildings":[
            {"x":"abc","y":1,"w":3,"h":2},
            {"x":1,"y":true,"w":3,"h":2},
            {"x":null,"y":1,"w":3,"h":2},
            {"x":1,"y":1,"w":3,"h":2}
        ],"roads":[],"parks":[],"water":[]});
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 1);
        assert_eq!(st.buildings_degenerate, 3);
    }

    #[test]
    fn fully_outside_is_dropped() {
        let mut v = lay(json!([
            {"x":50,"y":50,"w":3,"h":2},
            {"x":-10,"y":1,"w":3,"h":2},
            {"x":1,"y":-10,"w":3,"h":2},
            {"x":1,"y":1,"w":3,"h":2}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 1);
        assert_eq!(st.buildings_out_of_bounds, 3);
    }

    /// 部分越界要**夹回来**而不是丢掉（越界一两格是最常见的模型失误）。
    #[test]
    fn partial_overflow_is_clamped_not_dropped() {
        let mut v = lay(json!([
            {"x":18,"y":1,"w":5,"h":2,"name":"越右"},
            {"x":-2,"y":1,"w":5,"h":3,"name":"越左"},
            {"x":1,"y":18,"w":3,"h":5,"name":"越下"}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(n(&v), 3, "部分越界必须保留");
        assert_eq!(st.buildings_clamped, 3);
        assert_eq!(st.buildings_out_of_bounds, 0);
        // 夹取结果都落在 0..=20 内
        for b in v["buildings"].as_array().unwrap() {
            let (x, y) = (b["x"].as_i64().unwrap(), b["y"].as_i64().unwrap());
            let (w, h) = (b["w"].as_i64().unwrap(), b["h"].as_i64().unwrap());
            assert!(
                x >= 0 && y >= 0 && x + w <= 20 && y + h <= 20,
                "夹取后越界：{b}"
            );
            assert!(w >= 1 && h >= 1);
        }
        assert_eq!(v["buildings"][0]["w"], json!(2), "18+5=23 → 夹到 20，宽 2");
    }

    #[test]
    fn clean_is_idempotent() {
        let mut v = lay(json!([
            {"x":18,"y":1,"w":5,"h":2},
            {"x":18,"y":1,"w":5,"h":2},
            {"x":0,"y":0,"w":0,"h":0},
            {"x":3,"y":3,"w":4,"h":4}
        ]));
        let st1 = clean(&mut v, 20.0);
        assert!(st1.removed() > 0);
        let after_first = v["buildings"].clone();
        let st2 = clean(&mut v, 20.0);
        assert_eq!(st2.removed(), 0, "第二次不该再剔：{st2:?}");
        assert!(!st2.touched());
        assert_eq!(after_first, v["buildings"], "第二次不该改变内容");
    }

    #[test]
    fn parks_and_water_get_bounds_checked_but_not_deduped() {
        // 两块绿地完全重叠：**不剔**（绿地压绿地是正常画法，不值得冒误删的风险）
        let mut v = json!({"size":20,"buildings":[],"roads":[],"parks":[
            {"x":1,"y":1,"w":4,"h":4,"name":"甲园"},
            {"x":1,"y":1,"w":4,"h":4,"name":"乙园"},
            {"x":50,"y":50,"w":4,"h":4,"name":"园外"}
        ],"water":[{"x":0,"y":0,"w":0,"h":0}]});
        let st = clean(&mut v, 20.0);
        assert_eq!(v["parks"].as_array().unwrap().len(), 2, "重叠绿地要都留着");
        assert_eq!(v["water"].as_array().unwrap().len(), 0, "退化水体要剔");
        assert_eq!(st.areas_dropped, 2, "出界绿地 1 + 退化水体 1");
    }

    #[test]
    fn zero_length_road_is_dropped() {
        let mut v = json!({"size":20,"buildings":[],"parks":[],"water":[],"roads":[
            {"x1":5,"y1":5,"x2":5,"y2":5,"name":"点"},
            {"x1":0,"y1":0,"x2":20,"y2":0,"name":"中山路"},
            {"x1":3,"y1":3,"x2":3,"y2":10,"name":"竖路"}
        ]});
        let st = clean(&mut v, 20.0);
        assert_eq!(v["roads"].as_array().unwrap().len(), 2);
        assert_eq!(st.roads_degenerate, 1);
    }

    /// 道路合法范围是 `0..=size`（**含** size）—— 提示词样例就是横穿整条边。
    #[test]
    fn roads_may_span_the_whole_edge() {
        let mut v = json!({"size":20,"buildings":[],"parks":[],"water":[],"roads":[
            {"x1":0,"y1":0,"x2":20,"y2":0,"name":"横穿"}
        ]});
        let st = clean(&mut v, 20.0);
        assert_eq!(
            v["roads"].as_array().unwrap().len(),
            1,
            "0..size 的路必须保留"
        );
        assert_eq!(st.roads_clamped, 0, "本来就在范围内，不该算夹取");
    }

    #[test]
    fn out_of_range_road_is_clamped() {
        let mut v = json!({"size":20,"buildings":[],"parks":[],"water":[],"roads":[
            {"x1":-5,"y1":3,"x2":30,"y2":3,"name":"超长"}
        ]});
        let st = clean(&mut v, 20.0);
        assert_eq!(v["roads"].as_array().unwrap().len(), 1);
        assert_eq!(st.roads_clamped, 1);
        assert_eq!(v["roads"][0]["x1"], json!(0));
        assert_eq!(v["roads"][0]["x2"], json!(20));
    }

    #[test]
    fn bad_size_is_replaced() {
        for bad in [json!(null), json!(0), json!(-5), json!("大")] {
            let mut v = json!({"size":bad,"buildings":[{"x":1,"y":1,"w":3,"h":2}],"roads":[],"parks":[],"water":[]});
            let st = clean(&mut v, 28.0);
            assert!(st.size_fixed, "非法 size 要记一笔");
            assert_eq!(v["size"], json!(28), "要用兜底值（生成时的 base）");
            assert_eq!(n(&v), 1);
        }
    }

    #[test]
    fn missing_arrays_are_tolerated() {
        // 半截布局（流中途）什么键都可能缺
        let mut v = json!({});
        let st = clean(&mut v, 20.0);
        assert!(st.size_fixed);
        assert_eq!(v["size"], json!(20));
        assert_eq!(v["buildings"], json!([]));
        assert_eq!(v["roads"], json!([]));
        assert_eq!(st.removed(), 0);
    }

    #[test]
    fn non_object_layout_is_safe() {
        for bad in [json!(null), json!("字符串"), json!([1, 2, 3]), json!(42)] {
            let mut v = bad;
            let st = clean(&mut v, 20.0);
            assert_eq!(st.removed(), 0, "非对象输入应原样返回、不 panic");
        }
    }

    /// 建筑数超上限时**跳过**重叠剔除，但退化/越界照做，并且**记下来**（不静默）。
    #[test]
    fn too_many_buildings_skips_dedup_but_reports() {
        let many: Vec<Value> = (0..(MAX_DEDUP_BUILDINGS + 10))
            .map(|i| json!({"x": i % 20, "y": (i / 20) % 20, "w": 1, "h": 1}))
            .collect();
        let mut v = json!({"size":20,"buildings":many,"roads":[],"parks":[],"water":[]});
        let st = clean(&mut v, 20.0);
        assert!(st.overlap_skipped, "必须记下「跳过了」");
        assert_eq!(st.buildings_overlap, 0);
        assert!(st.summary().contains("跳过重叠剔除"));
    }

    #[test]
    fn stats_summary_is_human_readable_and_written_back() {
        let mut v = lay(json!([
            {"x":1,"y":1,"w":0,"h":2},
            {"x":2,"y":2,"w":4,"h":3},
            {"x":2,"y":2,"w":4,"h":3},
            {"x":18,"y":1,"w":5,"h":2}
        ]));
        let st = clean(&mut v, 20.0);
        assert_eq!(st.buildings_in, 4);
        assert_eq!(st.buildings_out, 2);
        assert_eq!(st.buildings_degenerate, 1);
        assert_eq!(st.buildings_overlap, 1);
        assert_eq!(st.buildings_clamped, 1);
        assert_eq!(st.removed(), 2);
        assert!(st.touched());
        let s = st.summary();
        assert!(s.contains("4→2"), "摘要要能看出进出：{s}");
        // 统计必须写回布局，事后能查「为什么这栋楼不见了」
        let c = &v["_clean"];
        assert_eq!(c["removed"], json!(2));
        assert_eq!(c["buildings"]["overlap"], json!(1));
        assert_eq!(c["buildings"]["degenerate"], json!(1));
        assert_eq!(c["buildings"]["clamped"], json!(1));
        assert!(c["summary"].as_str().unwrap().contains("重复"));
    }

    /// 净化不该改动**与几何无关**的字段（名字、类型、楼层、剧情字段…）。
    #[test]
    fn non_geometry_fields_survive() {
        // x=18,w=3 → 18+3=21 越出 20 一格：属于「部分越界」，夹回 w=2 保留，
        // 而不是丢掉（丢掉是 x 完全在画布外时才发生）。
        let mut v = json!({"name":"临江苑","size":20,"_streamed":true,"buildings":[
            {"x":18,"y":1,"w":3,"h":2,"type":"office","name":"云顶大厦","floors":12,"id":"b1"}
        ],"roads":[],"parks":[],"water":[]});
        clean(&mut v, 20.0);
        assert_eq!(n(&v), 1, "夹取后应保留");
        let b = &v["buildings"][0];
        assert_eq!(b["type"], json!("office"));
        assert_eq!(b["name"], json!("云顶大厦"));
        assert_eq!(b["floors"], json!(12));
        assert_eq!(b["id"], json!("b1"));
        assert_eq!(b["w"], json!(2), "宽度被夹到 2 格");
        assert_eq!(v["name"], json!("临江苑"));
        assert_eq!(v["_streamed"], json!(true));
    }

    /// 幂等 + 保守：真实形状的布局（沿路两排楼）不该被动。
    #[test]
    fn realistic_layout_survives_untouched() {
        let mut buildings = Vec::new();
        for row in 0..3 {
            for col in 0..4 {
                buildings.push(json!({
                    "x": 1 + col * 5, "y": 1 + row * 6 + 4, "w": 3, "h": 2,
                    "type": "residential", "name": format!("{}号楼", row * 4 + col + 1), "floors": 6
                }));
            }
        }
        let mut v = json!({"name":"临江苑","size":28,"buildings":buildings,
            "roads":[{"x1":0,"y1":4,"x2":28,"y2":4,"type":"main","name":"中山路"},
                     {"x1":0,"y1":16,"x2":28,"y2":16,"type":"secondary","name":"文明路"}],
            "parks":[{"x":20,"y":20,"w":6,"h":5,"name":"中心公园"}],
            "water":[{"x":2,"y":22,"w":5,"h":4,"name":"人工湖"}]});
        let st = clean(&mut v, 28.0);
        assert_eq!(st.removed(), 0, "真实布局不该被剔：{}", st.summary());
        assert_eq!(v["buildings"].as_array().unwrap().len(), 12);
        assert_eq!(v["roads"].as_array().unwrap().len(), 2);
        assert_eq!(v["parks"].as_array().unwrap().len(), 1);
        assert_eq!(v["water"].as_array().unwrap().len(), 1);
    }
}
