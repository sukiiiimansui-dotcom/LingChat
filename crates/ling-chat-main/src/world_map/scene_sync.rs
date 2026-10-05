//! 世界模拟 → 上游 `scene` 机制：**纯逻辑层**（Step 1）
//!
//! ## 这一层只做三件事，全部是纯函数
//! 1. **幂等键**：由地图状态（`area` / `place` / `adcode`）推出 scene 的 `id` ——
//!    同一个地点必须每次都得到**同一个** id，否则每次进小区都会新建一个场景，
//!    `scenes.json` 会无限膨胀，而且用户存档里记的 id 会指向一个已经不用的场景。
//! 2. **文案**：由地图状态拼出 scene 的 `name` / `description`。
//! 3. **让位规则**：判断 `current_scene_id` 是不是被**用户**动过了 ——
//!    动过就让位，不再抢。
//!
//! ## 为什么单独一层、且**不依赖任何 crate**
//! 本机跑不了 `cargo test`（没有 `target/`，冷编译整棵 Tauri 依赖树 40 分钟起），
//! 但纯 `std` 模块可以脱离工程直接 `rustc --test` 跑（这条技术我们验证过）。
//! 所以**这一层刻意不出现 `use crate::…`、不出现 serde/tauri** ——
//! 这是"能在手机上跑单测"的**唯一前提**，改动前请先想清楚。
//!
//! ## 三条从上游代码反推出来的硬约束（都有出处，别改坏）
//! - **`description` 不能为空**：`generator.rs:230` 是 `if !scene.description.trim().is_empty()`，
//!   空了整条旁白链路会**静默失效**（不报错、不重试 —— 因为 `:245` 会把
//!   `last_processed_scene_id` 无条件记成当前 id，见下条）。
//! - **必须先落盘 scene 再设 `current_scene_id`**：`generator.rs:245` 在 `if let` **之外**，
//!   所以"场景不存在"也会被记成已处理 → **永不重试**。⇒ 本层对空输入**fail closed**
//!   （返回 `None`），让调用方根本不会去设一个查不到的 id。
//! - **id 会被持久化**（写进 `scenes.json`、`session.last_scene_id`、存档快照），
//!   所以 [`MAP_SCENE_ID_PREFIX`] 的拼法与 [`scene_id`] 的算法**是数据格式**，
//!   改动等于让老用户的场景失联 —— 要改就得配迁移。
//!
//! ## 这一层**不做**什么（留给 Step 3）
//! 不写盘、不碰 `SceneStore`、不碰 `game_status`、不发事件。
//! 这里只产出"该不该切、切成什么"，副作用全部由调用方承担。

/// 地图生成的场景 id 前缀。
///
/// 作用有两个：① 一眼看出"这是地图生成的，不是用户建的"；
/// ② 让清理/统计能**精确圈定**自己造的场景（不要去猜名字）。
///
/// ⚠️ 它同时是**已持久化数据的格式**（见模块注释），别随手改。
pub const MAP_SCENE_ID_PREFIX: &str = "worldmap:";

/// 一段描述里最多提几个附近设施。
///
/// 旁白最终进的是 LLM prompt（`generator.rs:231-235`），提太多既费 token
/// 又会把"地点"这件事淹掉 —— 细节本来就该留在我们自己的 addendum 里。
pub const NEARBY_MAX: usize = 3;

/// 地图侧输入 —— 对应 `MapRuntime.scene` 的 `{area, place, adcode}`
/// （形状见 `summary.rs:19` 与 `wsRuntimePush.ts:132-137`）。
///
/// 用借用而不是 `String`：本层是纯函数，不该为了算个 id 去分配一堆字符串。
#[derive(Debug, Clone, Copy, Default)]
pub struct PlaceInput<'a> {
    /// 已拼好的人话路径，如 `"广州市·越秀区·东山口"`（`summary.rs:102`）。
    /// **空 = 还没进任何区域**（= 世界模拟没开），本层据此 fail closed。
    pub area: &'a str,
    /// 设施/建筑名，如 `"便利店"`（`summary.rs:412-414` 的 `actor.place`）。
    pub place: Option<&'a str>,
    /// 行政区划码，如 `"440104"`。有它时 id 更短更稳。
    pub adcode: Option<&'a str>,
    /// 附近设施名（顺序即优先级）。只取前 [`NEARBY_MAX`] 个，且去重。
    pub nearby: &'a [&'a str],
}

/// 一个待写入上游 `SceneStore` 的场景草稿。
///
/// 字段与上游 `Scene`（`scene_store.rs:220-234`）对应，但**刻意不依赖那个类型** ——
/// 那样才能脱离工程编译（见模块注释）。字段映射：
/// `name`→`Scene.name`、`description`→`Scene.description`、`id`→`Scene.id`；
/// `background` / `lighting` / `plugin_id` 本层**不产出**，理由见 Step 3：
/// 背景留空（否则冷启动会顶掉用户背景，`game.rs:486-497`）、
/// `plugin_id` 必须留 `None`（否则被 `plugins.rs:296` 静默清空）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneDraft {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// 不切换的原因（**每一种都要能单独测**，也方便打日志排障）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// `area` 为空：还没进任何区域（或世界模拟没开）。
    NoPlace,
    /// 用户动过 `current_scene_id` → 让位（见 [`should_yield`]）。
    YieldToUser,
    /// 当前已经在我们要去的那个场景上了 → 不必重复写。
    SameScene,
    /// 拼不出合法的场景文案（fail closed，见模块注释第 2 条）。
    NoUsableText,
}

/// 本层的决策结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    Skip(SkipReason),
    Switch(SceneDraft),
}

/// 去掉首尾空白；空白串归一成 `""`。
fn norm(s: &str) -> &str {
    s.trim()
}

/// 取第一个**非空**（去空白后）的候选值。
fn first_non_empty<'a>(cands: &[Option<&'a str>]) -> Option<&'a str> {
    cands
        .iter()
        .flatten()
        .map(|s| norm(s))
        .find(|s| !s.is_empty())
}

/// 把 id 的一段清洗成**不含 `/`、不含空白**的形式。
///
/// 为什么必须做：id 用 `/` 分隔「区域 / 建筑」两段，如果 `area` 自身含 `/`
/// 就会出现歧义（`a/b` + `c` 与 `a` + `b/c` 撞成同一个 id → 两个不同地点共用一个场景）。
/// 空白也要压掉，否则 `" 东山口"` 与 `"东山口"` 会算出两个 id。
fn id_segment(s: &str) -> String {
    norm(s)
        .chars()
        .map(|c| match c {
            '/' | '\\' => '-',
            c if c.is_whitespace() => '-',
            c => c,
        })
        .collect()
}

/// 由地图状态推出**幂等**的场景 id；输入不足以构成一个地点时返回 `None`。
///
/// ## 算法（是**数据格式**，改动需配迁移 —— 见模块注释）
/// ```text
/// base  = adcode(非空) 否则 area        ← 有 adcode 时 id 更短、且不受改名影响
/// id    = "worldmap:" + sanitize(base) [+ "/" + sanitize(place)]
/// ```
/// ## 为什么优先用 `adcode`
/// `area` 是**显示名**，会随定位精度/语言/上游数据变（`useWorldSim.ts:384-397`
/// 那段"把名字补成真名"的逻辑就是证据）；`adcode` 是稳定的行政编码。
/// 用 `area` 当键的话，同一个小区的 id 可能因为名字补全与否而漂移。
///
/// ## `None` 的语义
/// `area` 为空 ⇒ 还没进区域 ⇒ **不产生任何场景**。这条是 fail-closed：
/// 宁可什么都不做，也不要建一个 `worldmap:` 开头、后面空空的垃圾场景。
pub fn scene_id(input: &PlaceInput<'_>) -> Option<String> {
    let area = norm(input.area);
    if area.is_empty() {
        return None;
    }
    let base = first_non_empty(&[input.adcode]).unwrap_or(area);
    let mut id = String::with_capacity(MAP_SCENE_ID_PREFIX.len() + base.len() + 16);
    id.push_str(MAP_SCENE_ID_PREFIX);
    id.push_str(&id_segment(base));
    if let Some(place) = first_non_empty(&[input.place]) {
        id.push('/');
        id.push_str(&id_segment(place));
    }
    Some(id)
}

/// 这个 id 是不是地图生成的（前缀判断，给清理/统计用）。
pub fn is_map_scene(id: &str) -> bool {
    id.starts_with(MAP_SCENE_ID_PREFIX)
}

/// 去重 + 保序 + 砍到 [`NEARBY_MAX`]，并丢掉空白项。
fn clean_nearby(nearby: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in nearby {
        let s = norm(raw);
        if s.is_empty() || s == "——" {
            continue; // `"——"` 是前端"没有设施"的占位（见 `wsRuntimePush.ts:142`）
        }
        if out.iter().any(|x| x == s) {
            continue;
        }
        out.push(s.to_string());
        if out.len() >= NEARBY_MAX {
            break;
        }
    }
    out
}

/// 由地图状态拼出场景草稿；**任何一环拼不出可用文案就返回 `None`**（fail closed）。
///
/// ## 保证（都是单测里断言过的）
/// - `name` 去空白后**非空**
/// - `description` 去空白后**非空** ← `generator.rs:230` 的硬要求
///
/// ## 文案形状
/// - `name`：有 `place` 时用**建筑名**（#813 要的正是"建筑以 scene 传递"），
///   否则退到区域名。
/// - `description`：`area[，place][；附近有 a、b、c]` —— 刻意**说清"在哪"**而不是
///   复述 `name`，因为上游旁白是 `"你们一起去了新的场景 - \"{name}\"，\"{description}\""`
///   （`generator.rs:231-234`），description 再复述一遍名字就是纯噪音。
pub fn scene_draft(input: &PlaceInput<'_>) -> Option<SceneDraft> {
    let id = scene_id(input)?;
    let area = norm(input.area);
    let place = first_non_empty(&[input.place]);
    let nearby = clean_nearby(input.nearby);

    // name：优先建筑名；没有就退区域名。
    // 注意 `area` 在上面已经判过非空，所以这里一定拿得到非空 name —— 这不是巧合，
    // 是 `scene_id` 的 fail-closed 换来的不变量。
    let name = place.unwrap_or(area).to_string();

    let mut desc = String::from(area);
    if let Some(p) = place {
        desc.push('，');
        desc.push_str(p);
    }
    if !nearby.is_empty() {
        desc.push_str("；附近有");
        desc.push_str(&nearby.join("、"));
    }
    desc.push('。');

    // 兜底断言（fail closed）：理论上到不了这里，但 `description` 为空会让上游
    // **静默失效**，是本集成里最贵的一种错 —— 值得用一次判断换"绝不发生"。
    if name.trim().is_empty() || desc.trim().is_empty() {
        return None;
    }

    Some(SceneDraft {
        id,
        name,
        description: desc,
    })
}

/// **让位规则**：我们在世界模拟期间借用了 `current_scene_id`，这个函数判断
/// "现在这个值还是不是我们写的" —— 不是就让位，不要再抢。
///
/// ## 为什么需要它（上游零仲裁）
/// `current_scene_id` 是 `GameStatus` 上的**单一全局槽位**（`game_status.rs:39`），
/// **最后写入者赢**：没有任何版本号、时间戳或来源标记（`game_status.rs:20-65` 里没有这类字段）。
/// 用户随时可能在设置页点一个场景（`SettingsBackground.vue:726`），
/// 而 `game.rs:475-483` 在"没有场景时随机挑一个" —— 所以这个槽位**一直在被人动**。
///
/// ## 真值表（`we_last_wrote` = 我们上次写进去的值）
/// | 我们上次写的 | 当前值 | 让位？ | 含义 |
/// |---|---|---|---|
/// | `None` | 任意 | **否** | 还没写过 → 这次是"借"（先把原值存进书签再覆盖） |
/// | `Some(x)` | `Some(x)` | **否** | 还是我们写的 → 继续同步 |
/// | `Some(x)` | `Some(y)` | **是** | 被别人改了 → 让位 |
/// | `Some(x)` | `None` | **是** | 被别人清空了（例如设置页再点一次取消选中，`SettingsBackground.vue:708-714`）→ 让位 |
///
/// ## 为什么"没写过"不算让位
/// 进入世界模拟的第一次写入**本来就要覆盖**用户当前场景 —— 那是设计的一部分
/// （原值由调用方存进书签，退出时还回去）。让位规则针对的是**写入之后**被抢，
/// 不是"不许第一次写"。这一条如果写反，整个集成就一次都不会生效。
pub fn should_yield(we_last_wrote: Option<&str>, current: Option<&str>) -> bool {
    match we_last_wrote {
        None => false,
        Some(w) => current != Some(w),
    }
}

/// 把三件事串起来：**该不该切、切成什么**。调用方（Step 3）只要执行副作用。
///
/// ## 判定顺序（**顺序本身就是语义，单测里锁住了**）
/// 1. `scene_draft` 拿不到 → [`SkipReason::NoPlace`] / [`SkipReason::NoUsableText`]
/// 2. 需要让位 → [`SkipReason::YieldToUser`]
/// 3. 当前已经在这个场景上 → [`SkipReason::SameScene`]（幂等：高频 patch 不重复写盘）
/// 4. 否则 → [`Plan::Switch`]
///
/// 第 2 步排在第 3 步**前面**是刻意的：如果用户手动切到了**别的**场景，
/// 我们要报的是"让位"，而不是"已经在目标场景上"—— 前者会让我们彻底停止同步，
/// 后者只表示这一次不用动。两者对调用方的后续行为不同，不能混。
pub fn plan(
    current: Option<&str>,
    we_last_wrote: Option<&str>,
    input: &PlaceInput<'_>,
) -> Plan {
    let Some(draft) = scene_draft(input) else {
        // 区分"根本没地点"和"有地点但拼不出文案"，排障时有用
        let reason = if norm(input.area).is_empty() {
            SkipReason::NoPlace
        } else {
            SkipReason::NoUsableText
        };
        return Plan::Skip(reason);
    };
    if should_yield(we_last_wrote, current) {
        return Plan::Skip(SkipReason::YieldToUser);
    }
    if current == Some(draft.id.as_str()) {
        return Plan::Skip(SkipReason::SameScene);
    }
    Plan::Switch(draft)
}

// ═══════════════════════════════════════════════════════════════════
//  单测：纯 std，可脱离工程跑
//    rustc --edition 2021 --test -o scene_sync_test shim.rs && ./scene_sync_test
//  （shim.rs 只有一句 `#[path = "…/scene_sync.rs"] pub mod scene_sync;`）
// ═══════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    fn place<'a>(area: &'a str, p: Option<&'a str>, ad: Option<&'a str>) -> PlaceInput<'a> {
        PlaceInput {
            area,
            place: p,
            adcode: ad,
            nearby: &[],
        }
    }

    // ── 幂等键 ──────────────────────────────────────────────────────

    /// 同一个地点 → 同一个 id。**这是整个方案的地基**：
    /// 不成立的话每次进小区都新建场景，`scenes.json` 会无限涨。
    #[test]
    fn id_is_stable_for_same_place() {
        let a = place("广州市·越秀区·东山口", Some("便利店"), Some("440104"));
        let b = place("广州市·越秀区·东山口", Some("便利店"), Some("440104"));
        assert_eq!(scene_id(&a), scene_id(&b));
        assert!(scene_id(&a).is_some());
    }

    /// 首尾空白不该造成两个 id（前端推上来的字段经常带空格）。
    #[test]
    fn id_ignores_surrounding_whitespace() {
        let clean = place("东山口", Some("便利店"), None);
        let dirty = place("  东山口\t", Some(" 便利店 "), None);
        assert_eq!(scene_id(&clean), scene_id(&dirty));
    }

    /// 不同地点必须得到不同 id —— 否则两个小区会共用同一个场景。
    #[test]
    fn id_differs_for_different_places() {
        let a = place("东山口", Some("便利店"), Some("440104"));
        let b = place("东山口", Some("咖啡馆"), Some("440104")); // 同区域、不同建筑
        let c = place("杨箕村", Some("便利店"), Some("440106")); // 不同区域、同名建筑
        assert_ne!(scene_id(&a), scene_id(&b));
        assert_ne!(scene_id(&a), scene_id(&c));
    }

    /// 有 `adcode` 时优先用它当 base：区域**改名**不该让 id 漂移。
    #[test]
    fn id_prefers_adcode_over_display_name() {
        let named = place("广州市·越秀区·东山口", None, Some("440104"));
        let renamed = place("广州市·越秀区·东山口街道", None, Some("440104"));
        assert_eq!(scene_id(&named), scene_id(&renamed), "adcode 相同 → id 必须相同");
        assert_eq!(scene_id(&named).as_deref(), Some("worldmap:440104"));
    }

    /// 含 `/` 或空白的段必须被清洗：否则 `a/b`+`c` 与 `a`+`b/c` 会撞成同一个 id。
    #[test]
    fn id_sanitizes_separators_so_no_collision() {
        let x = place("a/b", Some("c"), None);
        let y = place("a", Some("b/c"), None);
        assert_ne!(scene_id(&x), scene_id(&y), "斜杠必须被清洗，不能产生歧义 id");

        // 真正的不变量：id 里**最多只有 1 个 `/`**（base 与 place 之间的那个分隔符）。
        // 段内部的斜杠必须已经被清洗掉，否则"段边界"就不唯一了。
        // ⚠️ 别写成 `!contains('/')` —— id 本来就是 `worldmap:<base>[/<place>]`，
        //    那个分隔符是**格式的一部分**（第一版我这里断言错了，是测试的错不是代码的错）。
        for p in [x, y] {
            let id = scene_id(&p).unwrap();
            let rest = &id[MAP_SCENE_ID_PREFIX.len()..];
            assert!(
                rest.split('/').count() <= 2,
                "base/place 两段之间最多一个分隔符，实际: {rest}"
            );
        }
        assert_eq!(scene_id(&x).unwrap(), "worldmap:a-b/c");
        assert_eq!(scene_id(&y).unwrap(), "worldmap:a/b-c");
    }

    /// 空白也要清洗成 `-`：否则 `"东山 口"` 与 `"东山-口"` 会撞成同一个 id。
    #[test]
    fn id_sanitizes_whitespace_inside_segment() {
        let spaced = place("东山 口", None, None);
        let dashed = place("东山-口", None, None);
        assert_eq!(scene_id(&spaced), scene_id(&dashed));
        assert!(!scene_id(&spaced).unwrap().contains(' '));
    }

    /// 区域为空 ⇒ **不产生场景**（fail closed，见模块注释第 2 条）。
    #[test]
    fn empty_area_yields_no_scene() {
        assert_eq!(scene_id(&place("", None, None)), None);
        assert_eq!(scene_id(&place("   \t ", None, None)), None);
        assert_eq!(scene_draft(&place("", Some("便利店"), None)), None);
        // 有 adcode 但没 area 也不行：adcode 单独不构成"一个地点"
        assert_eq!(scene_id(&place("", None, Some("440104"))), None);
    }

    #[test]
    fn prefix_and_detection() {
        let id = scene_id(&place("东山口", None, Some("440104"))).unwrap();
        assert!(id.starts_with(MAP_SCENE_ID_PREFIX));
        assert!(is_map_scene(&id));
        assert!(!is_map_scene("440104"));
        assert!(!is_map_scene("plugin:foo/bar")); // 插件场景不该被当成我们的
    }

    // ── 文案 ────────────────────────────────────────────────────────

    /// `description` 非空是上游硬要求（`generator.rs:230`）—— 对一批输入全量断言。
    #[test]
    fn description_is_never_empty_when_draft_exists() {
        let cases = [
            place("东山口", None, None),
            place("东山口", Some("便利店"), None),
            place("东山口", Some("   "), None), // 空 place 要退化成只有区域
            place("东山口", None, Some("440104")),
            place(" 东山口 ", Some(" 便利店 "), Some(" 440104 ")),
            place("a", Some("b"), None),
        ];
        for c in cases {
            if let Some(d) = scene_draft(&c) {
                assert!(
                    !d.description.trim().is_empty(),
                    "description 空了会让上游旁白静默失效: {:?}",
                    c
                );
                assert!(!d.name.trim().is_empty(), "name 不能为空: {:?}", c);
            }
        }
    }

    /// name 用**建筑名**（#813：「世界网格所属建筑以 scene 的方式传递」）。
    #[test]
    fn name_prefers_building_then_falls_back_to_area() {
        let with = scene_draft(&place("东山口", Some("便利店"), None)).unwrap();
        assert_eq!(with.name, "便利店");
        let without = scene_draft(&place("东山口", None, None)).unwrap();
        assert_eq!(without.name, "东山口");
        // 只有空白的 place 要当成"没有"
        let blank = scene_draft(&place("东山口", Some("   "), None)).unwrap();
        assert_eq!(blank.name, "东山口");
    }

    /// description 要**说清在哪**，而不是复述 name（旁白会同时念这两个）。
    #[test]
    fn description_describes_location_not_name() {
        let d = scene_draft(&place("广州市·越秀区·东山口", Some("便利店"), None)).unwrap();
        assert_eq!(d.description, "广州市·越秀区·东山口，便利店。");
        assert!(d.description.contains("东山口"));
        let plain = scene_draft(&place("广州市·越秀区", None, None)).unwrap();
        assert_eq!(plain.description, "广州市·越秀区。");
    }

    /// 附近设施：保序、去重、砍到上限、丢掉空白与 `"——"` 占位。
    #[test]
    fn nearby_is_deduped_capped_and_cleaned() {
        let mut i = place("东山口", None, None);
        let near = ["咖啡馆", " 咖啡馆 ", "", "   ", "——", "地铁站", "公园", "学校"];
        i.nearby = &near;
        let d = scene_draft(&i).unwrap();
        assert_eq!(
            d.description,
            "东山口；附近有咖啡馆、地铁站、公园。",
            "应保序去重、丢空白与占位、只取前 NEARBY_MAX 个"
        );

        // 上限本身
        let many = ["a", "b", "c", "d", "e"];
        let mut j = place("东山口", None, None);
        j.nearby = &many;
        assert_eq!(scene_draft(&j).unwrap().description, "东山口；附近有a、b、c。");
    }

    /// 全空 nearby 不该留下"；附近有。"这种残句。
    #[test]
    fn empty_nearby_leaves_no_dangling_text() {
        let mut i = place("东山口", None, None);
        i.nearby = &["", "  ", "——"];
        assert_eq!(scene_draft(&i).unwrap().description, "东山口。");
    }

    // ── 让位规则 ────────────────────────────────────────────────────

    /// 真值表逐条锁死（这张表是防"打架"的全部依据）。
    #[test]
    fn yield_truth_table() {
        // 没写过 → 不让位（这次是"借"，原值由调用方存书签）
        assert!(!should_yield(None, None));
        assert!(!should_yield(None, Some("用户选的咖啡厅")));
        // 还是我们写的 → 不让位
        assert!(!should_yield(Some("worldmap:440104"), Some("worldmap:440104")));
        // 被别人改成别的 → 让位
        assert!(should_yield(Some("worldmap:440104"), Some("用户选的咖啡厅")));
        // 被别人清空 → 让位
        assert!(should_yield(Some("worldmap:440104"), None));
    }

    // ── 决策（plan） ────────────────────────────────────────────────

    #[test]
    fn plan_switches_on_first_write_and_is_idempotent_after() {
        let i = place("东山口", Some("便利店"), Some("440104"));
        let id = scene_id(&i).unwrap();

        // 首次（没写过）：借走用户当前场景 → 切
        assert_eq!(
            plan(Some("用户选的咖啡厅"), None, &i),
            Plan::Switch(scene_draft(&i).unwrap())
        );
        // 已经在我们写的场景上 → 不重复写（高频 patch 不刷盘）
        assert_eq!(plan(Some(&id), Some(&id), &i), Plan::Skip(SkipReason::SameScene));
    }

    /// 用户动过之后必须让位 —— 而且报的理由要是 `YieldToUser`，不是 `SameScene`。
    #[test]
    fn plan_yields_after_user_takes_over() {
        let i = place("东山口", Some("便利店"), Some("440104"));
        assert_eq!(
            plan(Some("用户选的咖啡厅"), Some("worldmap:440104"), &i),
            Plan::Skip(SkipReason::YieldToUser)
        );
        // 用户清空也算动过
        assert_eq!(
            plan(None, Some("worldmap:440104"), &i),
            Plan::Skip(SkipReason::YieldToUser)
        );
    }

    /// 让位优先于"已经在目标场景上"：顺序反了会让我们继续抢。
    #[test]
    fn yield_takes_precedence_over_same_scene() {
        let i = place("东山口", Some("便利店"), Some("440104"));
        // 我们上次写的 ≠ 当前（用户切走了）→ 必须是让位，而不是别的理由
        let p = plan(Some("别的场景"), Some("worldmap:440104"), &i);
        assert_eq!(p, Plan::Skip(SkipReason::YieldToUser));
    }

    /// 没地点 → `NoPlace`。
    ///
    /// 注：`NoUsableText` 目前是**防御性分支、到不了** —— `scene_draft` 只可能在
    /// `scene_id` 返回 `None`（= area 为空）时返回 `None`，而 area 非空时
    /// `name`/`description` 必然非空（这条不变量由 `description_is_never_empty_when_draft_exists`
    /// 断言）。保留它是为了"将来有人给 `scene_draft` 加限制条件"时不至于静默走错分支。
    #[test]
    fn plan_yields_no_place_when_area_is_empty() {
        let empty = place("", None, None);
        assert_eq!(plan(None, None, &empty), Plan::Skip(SkipReason::NoPlace));
        let blank = place("   ", None, None);
        assert_eq!(plan(None, None, &blank), Plan::Skip(SkipReason::NoPlace));
        // 就算有 adcode / place，没有 area 也还是不产生场景
        let only_ad = place("", Some("便利店"), Some("440104"));
        assert_eq!(plan(None, None, &only_ad), Plan::Skip(SkipReason::NoPlace));
    }

    /// 用户**没动过**、且换到了新地点 → 正常切（回归：别把让位规则写成"总是不切"）。
    #[test]
    fn plan_switches_when_we_still_own_the_slot_and_place_changed() {
        let old = place("东山口", Some("便利店"), Some("440104"));
        let new = place("杨箕村", Some("咖啡馆"), Some("440106"));
        let old_id = scene_id(&old).unwrap();
        assert_eq!(
            plan(Some(&old_id), Some(&old_id), &new),
            Plan::Switch(scene_draft(&new).unwrap())
        );
    }
}
