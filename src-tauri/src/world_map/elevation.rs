//! elevation.rs — 真实地形着色（高程分层设色），给行政区划图（`render_geo`）用
//!
//! ## 数据来源
//!
//! **SRTM 90m**（NASA / USGS，**public domain**），经 `opentopodata.org` 采样成
//! **中国域 1° 网格**（64×38 = 2432 点），预切后编译期内嵌（见 [`ASSET`]）。
//! 抽取脚本：`~/rikka/Dsh-SYuki/world_map/recon/elev/otd_fetch.py`（保留以便更新/复现）。
//!
//! ## 为什么内嵌，而不是运行时调 opentopodata（**这是本模块最重要的决策**）
//!
//! 这个 API 本身是**稳定的**（实测：单点 9/10、2° 全量 7/7、1° 全量 25/25），
//! 所以「稳定就运行时拉」看起来成立。**但真正致命的是配额，不是稳定性**：
//!
//! · 官方配额：**100 点/请求 · 1 请求/秒 · 1000 请求/天（全局共享）**；
//! · 1° 中国网格 = **25 个请求** ⇒ **40 个用户/天就把公共配额打满**；
//! · 超配额**不是干净的错误**：实测连打 12 次 → 4 次失败，全是 `000`（连接层直接断），
//!   **没有 429、没有 `Retry-After`、响应头里也没有配额字段**
//!   ⇒ 客户端**既不能优雅退避，也看不到剩余额度**；
//! · 25 个请求挂 2 个 → 图上就是**两条缺失的地形带**（部分失败比全失败更难看）。
//!
//! 而代价对比是：**内嵌只要 10.8KB**（gzip 4.4KB）。
//! 对比 A 的水系资产（70KB），这个几乎免费。
//! 再加上「高程**永远不会变**，没有新鲜度问题」+「离线首装即可用」+「每个用户看到的地形完全一致」，
//! 内嵌是明显更优的选择。
//!
//! ⚠️ 顺带更正一个我早期报错的数字：我曾在方案评估里写「2° 网格 = 16KB」——
//! 那是 **SVG 渲染成本**，不是**数据体积**。数据只有 2.7KB(2°) / 10.8KB(1°)。
//! 把两者混为一谈会高估"运行时拉"的收益。
//!
//! ## 渲染：分层设色 + 两项关键优化
//!
//! ### ① 纵向 RLE 合并（成本从 190KB 压到 29KB）
//!
//! 朴素画法是「一格一个矩形」：1° 网格 2432 格 → 光矩形就 ~190KB。
//! 但同色带的相邻格子视觉上就是一块，**同列内连续的同一色带可以合并成一个矩形**。
//! 实测合并后 **1007 个矩形（压缩 41%）**，path 数据 **29KB**（对基线 +4.3%）。
//! 高原、平原这种大片同带区域合并率极高，正是地形的典型形态。
//!
//! ### ② 用「格点中点」当格子边界，而不是「中心 ± 半宽」
//!
//! 后者在浮点四舍五入后会留下**肉眼可见的白缝**（相邻格子边缘差 0.05px 就露底色）——
//! 这是瓦片式渲染的经典坑，我在 Python 原型里踩到并复现了（第一版截图上一条条横纹）。
//! 用中点当边界是**天然无缝**的：格 i 的右边界 = 格 i+1 的左边界，同一个数。
//!
//! ## 数据质量（实测）
//!
//! · 海拔 **-1 ~ 5890 m**，分布合理：0–200m 23.5% / 200–1000m 34.2% / 1000–2000m 23.3%
//!   / 2000–3000m 5.4% / 3000–4000m 3.8% / 4000–5000m 6.6% / >5000m 3.1%
//! · **null（无数据）点全部是海面** —— SRTM 不测水体；逐点核对过**没有内陆空洞**
//!
//! 本模块是**纯函数**：不碰网络、不碰文件、不碰 `AppHandle`，可以直接 `cargo test`。

use serde_json::Value;
use std::sync::OnceLock;

/// 编译期内嵌的中国域高程网格（SRTM 90m 采样，紧凑 JSON）。
///
/// 10.8KB / 64×38 = 2432 点 / 1° 步长。路径相对本文件：`src-tauri/src/world_map/` → `src-tauri/assets/`。
pub const ASSET: &str = include_str!("../../assets/elev_cn.json");

/// 无数据的哨兵值（JSON 里用它表示"海面 / SRTM 无覆盖"）。
///
/// ⚠️ 用 `-9999` 而不是 `null`：JSON 里 2432 个 `null` 比 `-9999` 占更多字节，
/// 而且解析成 `Vec<i32>` 比 `Vec<Option<i32>>` 简单。转成 [`Option`] 只在 [`band_of`] 一处做。
pub const NO_DATA: i32 = -9999;

/// **色带之间（以及色带与陆地兜底色之间）至少要有这么大的「通道差」才允许**。
///
/// 定义：`|ΔR| + |ΔG| + |ΔB|`（0~765）。见 [`channel_diff`]。
///
/// ## 为什么用「通道差」而不是「亮度差」
///
/// 因为**亮度差会漏判色相差异**，而这里要防的恰恰就是色相撞车。实测反例：
///
/// | 组合 | 通道差 | 亮度差 |
/// |---|---|---|
/// | 暖白 `#efe9e2` vs gaode 陆地 `#e9e7dc`（**必须判为不可区分**） | 14 | 3.7 |
/// | 冰蓝白 `#e8f1f8` vs water 主题陆地 `#f4efe3`（**必须判为可区分**） | 35 | **0.0** |
///
/// 第二行两组颜色的亮度几乎完全一样、只是冷暖不同 —— 亮度判据会把它误判成"看不清"，
/// 而它其实分得很开。所以用通道差。
///
/// ## 阈值为什么是 24
///
/// · 老配色（暖白 vs 陆地）实测 **14**，看起来就是"没渲染出来的洞" → 必须判红；
/// · 现配色里最低的一对实测 **35**（冰蓝白 vs water 主题陆地）→ 必须判绿。
/// 24 落在这两者之间，且离两边都有余量（不会被微调轻易踩线）。
pub const MIN_BAND_SEPARATION: i32 = 24;

/// `#rrggbb` → `(r, g, b)`；格式不对返回 `None`（不 panic）。
pub fn hex_rgb(c: &str) -> Option<(i32, i32, i32)> {
    let h = c.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        i32::from_str_radix(&h[0..2], 16).ok()?,
        i32::from_str_radix(&h[2..4], 16).ok()?,
        i32::from_str_radix(&h[4..6], 16).ok()?,
    ))
}

/// 两个颜色的「通道差」`|ΔR| + |ΔG| + |ΔB|`（0~765）。
///
/// 任一色值格式不对返回 `None` —— 测试应当把它当成**失败**，
/// 而不是当成 0（那样"色值写错了"会伪装成"颜色太接近"）。
pub fn channel_diff(a: &str, b: &str) -> Option<i32> {
    let (r1, g1, b1) = hex_rgb(a)?;
    let (r2, g2, b2) = hex_rgb(b)?;
    Some((r1 - r2).abs() + (g1 - g2).abs() + (b1 - b2).abs())
}

/// **高程色带表**（分层设色）—— 抽成常量就是为了**方便调色**，改这里即可，别改渲染代码。
///
/// 语义：`(该色带的起始海拔 m, 颜色)`，**按海拔升序**。
/// 查表规则见 [`band_of`]：取**最后一个 `起始海拔 <= e`** 的条目。
/// 最低那条同时兜住"海平面以下"（吐鲁番盆地 -154m 这种）。
///
/// ## 调色的硬约束（**有单测守着，别凭手感改**）
///
/// ① **相邻色带的通道差 ≥ [`MIN_BAND_SEPARATION`]** —— 否则分层看不出来；
/// ② **每一档与「陆地兜底色」的通道差也要 ≥ [`MIN_BAND_SEPARATION`]** ——
///    见 `render_geo::tests::snow_band_is_distinguishable_from_land_base`。
///    这条**尤其重要**，因为撞色的症状极具误导性：**看起来像"没渲染出来的洞"**，
///    会被误判成数据缺失（我们真踩过，见下）。
///
/// ## ⚠️ 最高一档（雪线）为什么是**冰蓝白** `#e8f1f8`，而不是暖白
///
/// 原来用的是暖白 `#efe9e2`，它和 gaode 主题的陆地兜底色 `#e9e7dc` 只差 **14**（通道差）——
/// 于是青藏高原那 65 个 ≥5000m 的格子**看着像一块块没渲染出来的空洞**。
/// 当时我第一反应是"数据缺失"，逐点核对 65 格（5000~5890m，全在西藏/青海）之后
/// 才确认**数据没问题、纯粹是配色撞车**。这个误判方向很危险，所以现在用单测钉死。
///
/// 换成冰蓝白（通道差 **39**）后：冷暖分明，一眼就是雪山/冰川；
/// 同时它比近纯白（`#f7fafc`）离省界描边的纯白 `#ffffff` 更远，不会和行政区划线混。
pub const ELEV_RAMP: &[(f64, &str)] = &[
    (-500.0, "#bcd9c0"), // 海平面以下（吐鲁番盆地等）—— 比平原那档深一点，拉出可见台阶
    (0.0, "#d3e4c6"),    // 平原
    (200.0, "#c6dcac"),
    (500.0, "#b9d394"),
    (1000.0, "#ddcf9c"), // 这里是绿→黄的过渡，第二、三级阶梯的分界
    (2000.0, "#dcbc86"),
    (3000.0, "#d0a671"),
    (4000.0, "#c19066"),
    (5000.0, "#e8f1f8"), // 雪线：**冰蓝白**（不是暖白！理由见上），也刻意避开省界描边的纯白
];

/// 一个已投影到画布坐标的着色矩形（同色带、同列、连续行合并后的结果）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    /// 在 [`ELEV_RAMP`] 里的下标
    pub band: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 高程网格（原始经纬度，**未投影**）。
#[derive(Debug, Clone)]
pub struct Grid {
    /// `(min_lng, min_lat, max_lng, max_lat)`
    pub bbox: (f64, f64, f64, f64),
    /// 网格步长（度）
    pub step: f64,
    pub nx: usize,
    pub ny: usize,
    /// 行优先，**纬度从南到北**（`idx = j * nx + i`，`j=0` 是最南一行）
    pub elev: Vec<i32>,
}

impl Grid {
    /// 第 `(i, j)` 格点的高程；`None` = 无数据（海面）
    pub fn at(&self, i: usize, j: usize) -> Option<i32> {
        if i >= self.nx || j >= self.ny {
            return None;
        }
        let v = self.elev[j * self.nx + i];
        if v == NO_DATA { None } else { Some(v) }
    }

    /// 第 `(i, j)` 格点的经纬度
    pub fn lnglat(&self, i: usize, j: usize) -> (f64, f64) {
        (
            self.bbox.0 + i as f64 * self.step,
            self.bbox.1 + j as f64 * self.step,
        )
    }
}

/// 高程 → 色带下标；`None`（海面/无数据）返回 `None`（**不画**）。
///
/// 规则：取 [`ELEV_RAMP`] 里**最后一个 `起始海拔 <= e`** 的条目；
/// 比第一条还低就归第一条；比最后一条还高就归最后一条（雪线以上仍是雪线）。
///
/// ⚠️ **哨兵值必须先挡掉**：`NO_DATA`（-9999）如果不判，会一路走到循环里 ——
/// 它比所有色带起点都低，于是 `hit` 停在初值 0，**海面会被画成"海平面以下"那一档**，
/// 整片海都上了色。所以这里显式拒绝它，不依赖调用方一定传 `None`。
pub fn band_of(e: Option<i32>) -> Option<usize> {
    let e = e?;
    if e == NO_DATA {
        return None;
    }
    let e = e as f64;
    let mut hit = 0usize;
    for (i, (lo, _)) in ELEV_RAMP.iter().enumerate() {
        if *lo <= e {
            hit = i;
        } else {
            break;
        }
    }
    Some(hit)
}

/// 解析内嵌/任意高程网格 JSON。
///
/// **容错**：任何字段缺失 / 类型不对 / 数组长度与 `nx*ny` 对不上，一律返回 `None`，
/// 绝不 panic —— 地形只是叠加层，坏了也不能影响行政边界那张主图。
pub fn parse(text: &str) -> Option<Grid> {
    let v: Value = serde_json::from_str(text).ok()?;
    let b = v.get("bbox")?.as_array()?;
    if b.len() != 4 {
        return None;
    }
    let bbox = (
        b[0].as_f64()?,
        b[1].as_f64()?,
        b[2].as_f64()?,
        b[3].as_f64()?,
    );
    let step = v.get("step")?.as_f64()?;
    let nx = v.get("nx")?.as_u64()? as usize;
    let ny = v.get("ny")?.as_u64()? as usize;
    if nx == 0 || ny == 0 || !step.is_finite() || step <= 0.0 {
        return None;
    }
    if bbox.0 >= bbox.2 || bbox.1 >= bbox.3 {
        return None;
    }
    let raw = v.get("elev")?.as_array()?;
    if raw.len() != nx * ny {
        return None; // 长度对不上 = 资产坏了，宁可不画
    }
    let elev: Vec<i32> = raw
        .iter()
        .map(|x| {
            x.as_i64()
                .unwrap_or(NO_DATA as i64)
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32
        })
        .collect();
    Some(Grid {
        bbox,
        step,
        nx,
        ny,
        elev,
    })
}

/// 内嵌资产（进程内只解析一次）。
///
/// `OnceLock` 是 std（1.70+ 稳定），**零新增依赖**。
pub fn grid() -> Option<&'static Grid> {
    static CACHE: OnceLock<Option<Grid>> = OnceLock::new();
    CACHE.get_or_init(|| parse(ASSET)).as_ref()
}

/// 把网格变成一组**可画的矩形**：投影 → 分色带 → 同列纵向 RLE 合并。
///
/// `proj` 把经纬度投到画布像素（由调用方传入，保证与行政区划**同一套投影/拟合**）。
///
/// ## 为什么边界要用「格点中点」
/// 格 `i` 的左/右边界取 `proj(i)` 与相邻格点连线的中点。
/// 这样格 `i` 的右边界与格 `i+1` 的左边界是**同一个数**，拼起来天然无缝。
/// 若改成「中心 ± 半宽（用步长算）」，浮点四舍五入会让相邻格子差零点几像素，
/// 渲染出来就是一条条白缝（Python 原型里实测复现过）。
///
/// ## 视口裁剪
/// 完全落在画布外（含 `margin`）的格子直接丢，[`Cell`] 数量随之下降 ——
/// 这是下钻到省/市时地形层几乎不花成本的原因。
pub fn cells(
    g: &Grid,
    proj: impl Fn(f64, f64) -> (f64, f64),
    w: f64,
    h: f64,
    margin: f64,
) -> Vec<Cell> {
    if g.nx == 0 || g.ny == 0 {
        return Vec::new();
    }
    // 格点的投影坐标
    let mut xs = Vec::with_capacity(g.nx);
    let mut ys = Vec::with_capacity(g.ny);
    for i in 0..g.nx {
        xs.push(proj(g.lnglat(i, 0).0, g.bbox.1).0);
    }
    for j in 0..g.ny {
        ys.push(proj(g.bbox.0, g.lnglat(0, j).1).1);
    }
    // 格子边界 = 相邻格点的中点（首尾按半格外推）
    let edges = |v: &Vec<f64>| -> Vec<f64> {
        let n = v.len();
        let mut e = Vec::with_capacity(n + 1);
        if n == 1 {
            e.push(v[0] - 0.5);
            e.push(v[0] + 0.5);
            return e;
        }
        e.push(v[0] - (v[1] - v[0]) / 2.0);
        for i in 0..n - 1 {
            e.push((v[i] + v[i + 1]) / 2.0);
        }
        e.push(v[n - 1] + (v[n - 1] - v[n - 2]) / 2.0);
        e
    };
    let xe = edges(&xs);
    let ye = edges(&ys);

    let mut out = Vec::new();
    for i in 0..g.nx {
        let (xa, xb) = (xe[i], xe[i + 1]);
        // 整列都在画布外就跳过（快路径）
        if xa.max(xb) < -margin || xa.min(xb) > w + margin {
            continue;
        }
        let mut j = 0usize;
        while j < g.ny {
            let Some(b) = band_of(g.at(i, j)) else {
                j += 1; // 无数据（海面）→ 不画，也不参与合并
                continue;
            };
            let mut k = j;
            while k + 1 < g.ny && band_of(g.at(i, k + 1)) == Some(b) {
                k += 1;
            }
            let (ya, yb) = (ye[j], ye[k + 1]);
            // ⚠️ **必须用 min/max 归一化**：render_geo 的投影 y 轴是**向下**的
            // （Web Mercator 的 y 随纬度升高而减小），而本网格 j 是从南往北排的，
            // 所以 `ye[j] > ye[k+1]` 是常态。直接相减会得到**负高度**的矩形 —— 画不出来。
            // 这个 bug 是被 `same_band_runs_are_merged` 测试抓到的。
            let (x0, x1) = (xa.min(xb), xa.max(xb));
            let (y0, y1) = (ya.min(yb), ya.max(yb));
            if y1 >= -margin && y0 <= h + margin {
                out.push(Cell {
                    band: b,
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                });
            }
            j = k + 1;
        }
    }
    out
}

/// 把一组 [`Cell`] 按色带拼成 SVG path 的 `d` 字符串。
///
/// **每个色带一条 path**（而不是一格一个 `<rect>`）：色带只有 9 条，
/// 元素数从上千降到 9，DOM 与字符串体积都省。
/// 每格用 `M x y h w v h Z` 这种相对指令，比 `M…L…L…L…Z` 短得多。
///
/// 返回 `(band, d)`，按 band 升序；空色带不出现在结果里。
pub fn band_paths(cells: &[Cell]) -> Vec<(usize, String)> {
    let mut by_band: Vec<Vec<&Cell>> = vec![Vec::new(); ELEV_RAMP.len()];
    for c in cells {
        if c.band < by_band.len() {
            by_band[c.band].push(c);
        }
    }
    by_band
        .into_iter()
        .enumerate()
        .filter(|(_, v)| !v.is_empty())
        .map(|(b, v)| {
            let mut d = String::new();
            for c in v {
                // 相对指令：M 定位 → h 右 → v 下 → h 左（负）→ Z 闭合
                d.push_str(&format!(
                    "M{:.1} {:.1}h{:.1}v{:.1}h{:.1}Z",
                    c.x, c.y, c.w, c.h, -c.w
                ));
            }
            (b, d)
        })
        .collect()
}

/// 统计口径：`(格点数, 有数据格点数, 用到的色带数, 合并后矩形数)` —— 给自检/诊断用。
pub fn counts(g: &Grid, cells: &[Cell]) -> (usize, usize, usize, usize) {
    let total = g.nx * g.ny;
    let with_data = g.elev.iter().filter(|v| **v != NO_DATA).count();
    let mut used = [false; ELEV_RAMP.len()];
    for c in cells {
        if c.band < used.len() {
            used[c.band] = true;
        }
    }
    (
        total,
        with_data,
        used.iter().filter(|b| **b).count(),
        cells.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 一份小的合成网格（3×3，纬度从南到北）
    fn small() -> Grid {
        parse(
            &json!({
                "bbox":[100.0, 20.0, 102.0, 22.0], "step":1.0, "nx":3, "ny":3,
                "elev":[
                    0,    150,  NO_DATA,   // j=0 最南
                    600,  1500, NO_DATA,   // j=1
                    4500, 6000, NO_DATA    // j=2 最北
                ]
            })
            .to_string(),
        )
        .unwrap()
    }

    // ───────────────────────── 资产 ─────────────────────────

    #[test]
    fn embedded_asset_parses_and_is_china_scale() {
        let g = grid().expect("内嵌高程资产必须能解析");
        assert_eq!((g.nx, g.ny), (64, 38), "1° 中国网格应为 64×38");
        assert_eq!(g.elev.len(), 64 * 38);
        assert!((g.step - 1.0).abs() < 1e-9);
        let (x0, y0, x1, y1) = g.bbox;
        assert!(x0 >= 70.0 && x1 <= 140.0, "经度范围不像中国：{x0}~{x1}");
        assert!(y0 >= 15.0 && y1 <= 56.0, "纬度范围不像中国：{y0}~{y1}");
    }

    /// 数据质量的**回归哨兵**：海拔范围、有效点数、以及"珠峰那一带确实很高"。
    #[test]
    fn asset_elevation_range_is_plausible() {
        let g = grid().unwrap();
        let vals: Vec<i32> = g.elev.iter().copied().filter(|v| *v != NO_DATA).collect();
        assert!(vals.len() > 1800, "有效点太少：{}", vals.len());
        let lo = *vals.iter().min().unwrap();
        let hi = *vals.iter().max().unwrap();
        assert!(
            lo >= -200 && lo <= 10,
            "最低点不像中国（吐鲁番约 -154m）：{lo}"
        );
        assert!(
            hi >= 5000 && hi <= 9000,
            "最高点不像中国（珠峰 8848m）：{hi}"
        );
        // 有相当比例的高原/高山，否则说明取数取错了区域
        let high = vals.iter().filter(|v| **v >= 3000).count();
        assert!(high > 100, "3000m 以上的点太少（{high}），青藏高原没进来？");
    }

    /// 无数据点必须**只在海面**，内陆不能有空洞（否则地形会破洞）。
    #[test]
    fn no_data_points_are_all_at_sea() {
        let g = grid().unwrap();
        // 粗判：中国陆地大致在 lng 73~135 / lat 18~54，
        // 且东部海域(lng>121 且 lat<41)、南部海域(lat<22) 算海。
        let mut inland = Vec::new();
        for j in 0..g.ny {
            for i in 0..g.nx {
                if g.at(i, j).is_some() {
                    continue;
                }
                let (lng, lat) = g.lnglat(i, j);
                let is_sea = lat < 22.0 || (lng > 121.0 && lat < 41.0);
                if !is_sea {
                    inland.push((lng, lat));
                }
            }
        }
        // 允许极少数边界点（取样框略大于国界），但不能成片
        assert!(
            inland.len() < 40,
            "内陆出现 {} 个无数据点（地形会有洞）：{:?}",
            inland.len(),
            &inland[..inland.len().min(8)]
        );
    }

    // ───────────────────────── 色带 ─────────────────────────

    #[test]
    fn ramp_is_ascending_and_nonempty() {
        assert!(ELEV_RAMP.len() >= 5, "色带太少，分不出层次");
        for w in ELEV_RAMP.windows(2) {
            assert!(
                w[0].0 < w[1].0,
                "色带必须按海拔升序：{} !< {}",
                w[0].0,
                w[1].0
            );
        }
        for (lo, c) in ELEV_RAMP {
            assert!(c.starts_with('#') && c.len() == 7, "色值格式不对：{lo} {c}");
        }
    }

    /// 雪线不能是**纯白** —— 省界描边就是 `#ffffff`，会和它糊成一片。
    #[test]
    fn snow_is_not_pure_white() {
        let snow = ELEV_RAMP.last().unwrap().1.to_ascii_lowercase();
        assert_ne!(
            snow, "#ffffff",
            "雪线用了纯白，会和省界描边（#ffffff）分不清"
        );
        assert_ne!(snow, "#fff", "雪线用了纯白");
    }

    /// 相邻色带必须有**可计算**的可见差异（不是"看着不一样"）。
    ///
    /// 用 [`channel_diff`] 而不是 `assert_ne!`：色值改一个字符就算"不等"，
    /// 但肉眼根本看不出来 —— 那种守门是假的。
    #[test]
    fn adjacent_bands_are_measurably_distinct() {
        for w in ELEV_RAMP.windows(2) {
            let d = channel_diff(w[0].1, w[1].1)
                .unwrap_or_else(|| panic!("色值格式不对：{} / {}", w[0].1, w[1].1));
            assert!(
                d >= MIN_BAND_SEPARATION,
                "相邻色带太接近（通道差 {d} < {MIN_BAND_SEPARATION}）：{} vs {}",
                w[0].1,
                w[1].1
            );
        }
    }

    // ───────── 配色判据的自身测试 ─────────

    #[test]
    fn hex_rgb_parses_and_rejects_garbage() {
        assert_eq!(hex_rgb("#ffffff"), Some((255, 255, 255)));
        assert_eq!(hex_rgb("#000000"), Some((0, 0, 0)));
        assert_eq!(hex_rgb("#e8f1f8"), Some((232, 241, 248)));
        // 大小写都认
        assert_eq!(hex_rgb("#E8F1F8"), Some((232, 241, 248)));
        // 坏输入一律 None（不能 panic，也不能当成黑色）
        for bad in ["", "#", "fff", "#ffff", "#gggggg", "#1234567", "e8f1f8"] {
            assert_eq!(hex_rgb(bad), None, "坏色值应返回 None：{bad}");
        }
    }

    #[test]
    fn channel_diff_is_symmetric_and_rejects_garbage() {
        assert_eq!(channel_diff("#ffffff", "#000000"), Some(765));
        assert_eq!(channel_diff("#000000", "#ffffff"), Some(765), "必须对称");
        assert_eq!(channel_diff("#e8f1f8", "#e8f1f8"), Some(0));
        assert_eq!(
            channel_diff("#e8f1f8", "#zzzzzz"),
            None,
            "坏色值必须 None，不能当 0"
        );
    }

    /// **守门判据的自证**：用真实踩过的两组颜色验证 [`MIN_BAND_SEPARATION`] 选得对。
    ///
    /// 这条测试保证阈值不是拍脑袋来的 —— 它两侧都有真实样本。
    #[test]
    fn separation_threshold_separates_known_good_from_known_bad() {
        // 反面样本：老的暖白雪线 vs gaode 陆地兜底色 —— 实测就是它让人误判成"数据缺失"
        let bad = channel_diff("#efe9e2", "#e9e7dc").expect("色值合法");
        assert!(
            bad < MIN_BAND_SEPARATION,
            "这个反面样本必须被判红，否则阈值太低：{bad}"
        );
        // 正面样本：现用的冰蓝白 vs water 主题陆地（亮度几乎相同、只有色相不同）
        let good = channel_diff("#e8f1f8", "#f4efe3").expect("色值合法");
        assert!(
            good >= MIN_BAND_SEPARATION,
            "这个正面样本必须被判绿，否则阈值太高：{good}"
        );
        // 顺带钉死"亮度判据在这里不好使"这个结论
        let lum = |a: &str, b: &str| -> f64 {
            let (r1, g1, b1) = hex_rgb(a).unwrap();
            let (r2, g2, b2) = hex_rgb(b).unwrap();
            (0.299 * (r1 - r2) as f64 + 0.587 * (g1 - g2) as f64 + 0.114 * (b1 - b2) as f64).abs()
        };
        assert!(
            lum("#e8f1f8", "#f4efe3") < 2.0,
            "正面样本的亮度差应当极小（这正是不能用亮度判据的原因）"
        );
    }

    #[test]
    fn band_of_maps_boundaries() {
        let n = ELEV_RAMP.len();
        assert_eq!(band_of(None), None, "无数据不画");
        assert_eq!(band_of(Some(NO_DATA)), None, "哨兵值也算无数据");
        assert_eq!(band_of(Some(-600)), Some(0), "比第一条更低 → 归第一条");
        assert_eq!(band_of(Some(-100)), Some(0), "海平面以下");
        assert_eq!(band_of(Some(0)), Some(1), "0m 起是平原带");
        assert_eq!(band_of(Some(199)), Some(1));
        assert_eq!(band_of(Some(200)), Some(2), "边界值归上一档（左闭）");
        assert_eq!(band_of(Some(4999)), Some(n - 2));
        assert_eq!(band_of(Some(5000)), Some(n - 1), "雪线");
        assert_eq!(band_of(Some(9000)), Some(n - 1), "超出上界仍是雪线");
    }

    // ───────────────────────── 解析容错 ─────────────────────────

    #[test]
    fn malformed_input_is_none_not_panic() {
        for bad in [
            "",
            "not json",
            "{}",
            "[]",
            "null",
            r#"{"bbox":[1,2,3]}"#,
            r#"{"bbox":[1,2,3,4],"step":0,"nx":1,"ny":1,"elev":[0]}"#, // step 非法
            r#"{"bbox":[1,2,3,4],"step":1,"nx":0,"ny":1,"elev":[]}"#,  // nx=0
            r#"{"bbox":[5,2,3,4],"step":1,"nx":1,"ny":1,"elev":[0]}"#, // bbox 反了
            r#"{"bbox":[1,2,3,4],"step":1,"nx":2,"ny":2,"elev":[0,1]}"#, // 长度对不上
            r#"{"bbox":[1,2,3,4],"step":1,"nx":1,"ny":1}"#,            // 缺 elev
        ] {
            assert!(parse(bad).is_none(), "坏输入应返回 None：{bad}");
        }
    }

    #[test]
    fn non_numeric_elevations_become_no_data() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,1.0,1.0],"step":1.0,"nx":2,"ny":1,
                    "elev":[100, null]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(g.at(0, 0), Some(100));
        assert_eq!(g.at(1, 0), None, "null 应变成无数据");
    }

    #[test]
    fn grid_at_and_lnglat_index_correctly() {
        let g = small();
        assert_eq!(g.at(0, 0), Some(0), "j=0 是最南一行");
        assert_eq!(g.at(0, 2), Some(4500), "j=2 是最北一行");
        assert_eq!(g.at(2, 0), None, "第 3 列是无数据（海）");
        assert_eq!(g.at(9, 9), None, "越界返回 None");
        assert_eq!(g.lnglat(0, 0), (100.0, 20.0));
        assert_eq!(g.lnglat(1, 2), (101.0, 22.0));
    }

    // ───────────────────────── RLE 合并 ─────────────────────────

    /// 同列连续同带 → 必须合并成一个矩形（这是把成本压下来的关键）。
    #[test]
    fn same_band_runs_are_merged() {
        // 4 行同带（都在 200~500）+ 1 行另一带
        let g = parse(
            &json!({"bbox":[0.0,0.0,1.0,4.0],"step":1.0,"nx":1,"ny":5,
                    "elev":[250, 300, 400, 260, 1500]})
            .to_string(),
        )
        .unwrap();
        // 投影：经纬度直接当像素（够验证合并逻辑）
        let cells = cells(
            &g,
            |lng, lat| (lng * 100.0, 400.0 - lat * 100.0),
            200.0,
            500.0,
            0.0,
        );
        assert_eq!(cells.len(), 2, "5 格应合并成 2 个矩形：{cells:?}");
        assert_eq!(cells[0].band, cells[1].band.min(cells[0].band));
        // 第一个矩形高 4 格
        let tall = cells
            .iter()
            .max_by(|a, b| a.h.partial_cmp(&b.h).unwrap())
            .unwrap();
        assert!(tall.h > 380.0, "4 格应合并成约 400px 高：{:?}", tall);
    }

    #[test]
    fn band_changes_split_the_run() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,1.0,2.0],"step":1.0,"nx":1,"ny":3,
                    "elev":[100, 1500, 100]})
            .to_string(),
        )
        .unwrap();
        let cells = cells(&g, |lng, lat| (lng, lat), 10.0, 10.0, 0.0);
        assert_eq!(cells.len(), 3, "带变化必须断开：{cells:?}");
    }

    #[test]
    fn no_data_breaks_the_run_and_is_not_drawn() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,1.0,2.0],"step":1.0,"nx":1,"ny":3,
                    "elev":[100, NO_DATA, 150]})
            .to_string(),
        )
        .unwrap();
        let cells = cells(&g, |lng, lat| (lng, lat), 10.0, 10.0, 0.0);
        assert_eq!(
            cells.len(),
            2,
            "海面那一格不画，且把上下两段断开：{cells:?}"
        );
    }

    /// ★ 相邻格子的边界必须落在**同一个 SVG 坐标**上 —— 否则渲染出白缝。
    ///
    /// 比较要在**实际输出精度**上做：`band_paths` 用 `{:.1}` 格式化坐标，
    /// 所以只要四舍五入到 1 位小数后一致，就**不可能**看出缝。
    /// 直接比浮点原值会因 `x + (x2-x) != x2` 的舍入误差误报
    /// （实测差了 1 个 ULP：82.22215 vs 82.22215000000001）。
    #[test]
    fn adjacent_cells_share_exact_edges() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,2.0,1.0],"step":1.0,"nx":3,"ny":2,
                    "elev":[100, 300, 600, 100, 300, 600]})
            .to_string(),
        )
        .unwrap();
        // 一个会引入浮点误差的投影（模拟真实的手续费）
        let proj = |lng: f64, lat: f64| (lng * 137.7777 + 13.3333, lat * 91.1111 + 7.7777);
        let cs = cells(&g, proj, 1000.0, 1000.0, 1e9);
        let q = |v: f64| (v * 10.0).round(); // 与 {:.1} 同精度
        let mut checked = 0;
        for a in &cs {
            for b in &cs {
                if (a.y - b.y).abs() > 1e-9 {
                    continue; // 只看同一行
                }
                let gap = b.x - (a.x + a.w);
                if gap.abs() > 1e-6 {
                    continue; // 只看"本应相接"的那一对（不是随便两个格子）
                }
                assert_eq!(
                    q(a.x + a.w),
                    q(b.x),
                    "相邻格子边界在 0.1px 精度上不等 → 会出现白缝：{} vs {}",
                    a.x + a.w,
                    b.x
                );
                checked += 1;
            }
        }
        assert!(checked > 0, "没找到相邻格子对，测试没测到东西");

        // 更强的一条：**同一列**的格子必须共用逐位相同的 x/w
        // （实现上它们都取自同一个 `xe[i]`/`xe[i+1]`，这条守住"不要各算各的"）
        let mut by_col: std::collections::HashMap<u64, (f64, f64)> =
            std::collections::HashMap::new();
        for c in &cs {
            let key = c.x.to_bits();
            match by_col.get(&key) {
                Some((w, _)) => assert_eq!(*w, c.w, "同一列的格子 w 必须逐位相同"),
                None => {
                    by_col.insert(key, (c.w, c.x));
                },
            }
        }
        assert!(by_col.len() >= 2, "至少该有 2 列");
    }

    #[test]
    fn out_of_view_cells_are_culled() {
        let g = small();
        // 投影到一个远离画布的位置
        let far = cells(
            &g,
            |lng, lat| (lng + 10000.0, lat + 10000.0),
            100.0,
            100.0,
            5.0,
        );
        assert!(far.is_empty(), "全在画布外应被裁掉：{far:?}");
        // margin 放大到足够大时又会出现
        let near = cells(
            &g,
            |lng, lat| (lng + 10000.0, lat + 10000.0),
            100.0,
            100.0,
            1e6,
        );
        assert!(!near.is_empty(), "margin 够大时不该裁掉");
    }

    #[test]
    fn empty_grid_yields_nothing() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,1.0,1.0],"step":1.0,"nx":1,"ny":1,"elev":[NO_DATA]})
                .to_string(),
        )
        .unwrap();
        let cells = cells(&g, |lng, lat| (lng, lat), 100.0, 100.0, 10.0);
        assert!(cells.is_empty(), "全无数据 → 一个矩形都不该有");
        assert!(band_paths(&cells).is_empty());
    }

    /// 全部为 0（全平原）也要能画出来，不能因为"值都一样"就漏掉。
    #[test]
    fn all_zero_elevation_still_draws() {
        let g = parse(
            &json!({"bbox":[0.0,0.0,3.0,3.0],"step":1.0,"nx":4,"ny":4,
                    "elev":[0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]})
            .to_string(),
        )
        .unwrap();
        let cells = cells(&g, |lng, lat| (lng * 10.0, lat * 10.0), 100.0, 100.0, 0.0);
        assert_eq!(cells.len(), 4, "4 列 × 全同带 → 4 个矩形：{cells:?}");
        assert!(cells.iter().all(|c| c.band == band_of(Some(0)).unwrap()));
    }

    // ───────────────────────── path 生成 ─────────────────────────

    #[test]
    fn band_paths_group_by_band() {
        let cells = vec![
            Cell {
                band: 1,
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 5.0,
            },
            Cell {
                band: 1,
                x: 0.0,
                y: 5.0,
                w: 10.0,
                h: 5.0,
            },
            Cell {
                band: 8,
                x: 10.0,
                y: 0.0,
                w: 4.0,
                h: 9.0,
            },
        ];
        let paths = band_paths(&cells);
        assert_eq!(paths.len(), 2, "两个色带 → 两条 path");
        assert_eq!(paths[0].0, 1);
        assert_eq!(paths[1].0, 8);
        // 同带的两格在同一条 path 里
        assert_eq!(paths[0].1.matches('M').count(), 2);
        assert_eq!(paths[1].1.matches('M').count(), 1);
        // 每条子路径都要闭合
        for (_, d) in &paths {
            assert_eq!(
                d.matches('M').count(),
                d.matches('Z').count(),
                "每个子路径都要 Z 闭合"
            );
        }
    }

    #[test]
    fn band_paths_are_empty_for_no_cells() {
        assert!(band_paths(&[]).is_empty());
    }

    #[test]
    fn counts_reports_used_bands() {
        let g = small();
        // 投影要**落在画布内**（否则全被视口裁掉，统计恒为 0 —— 第一版测试就踩了这个）
        let cs = cells(
            &g,
            |lng, lat| ((lng - 100.0) * 40.0, (22.0 - lat) * 40.0),
            200.0,
            200.0,
            0.0,
        );
        let (total, with_data, bands, rects) = counts(&g, &cs);
        assert_eq!(total, 9);
        assert_eq!(with_data, 6, "3 格是海面（无数据）");
        assert!(bands >= 2, "至少用到 2 个色带，实际 {bands}：{cs:?}");
        assert!(rects > 0);
    }
}
