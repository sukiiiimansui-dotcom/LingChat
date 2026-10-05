//! 流式小区生成（移植自 Python `stream_gen.py`）
//!
//! 目标：**让 AI 画图的过程可见** —— 不是等两分钟蹦出一张图，
//! 而是建筑一栋栋冒出来（Python 侧实测：总耗时 129s → 18.6s，快 7 倍）。
//!
//! 关键点：
//!   1. `stream: true` 调 LLM，token 一到就处理
//!   2. **增量 JSON 解析**：从半截 JSON 里抠出已经闭合的 `{...}` 对象
//!      （不能等整个文档解析成功 —— 那时图早画完了）
//!   3. 按元素逐条推送，前端收到一条画一栋
//!
//! 与 Python 侧的差别：Python 因 Termux 的 SSL 长连接 bug 用了 curl 子进程，
//! Rust 直接用 reqwest 的 `bytes_stream()`，干净得多。
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// 流式事件
#[derive(Debug, Clone)]
pub enum Event {
    Start { area: String, size: i32, model: String },
    Meta { name: String },
    Size { size: i32 },
    Item { kind: String, item: Value, index: usize, elapsed: f64 },
    Warn { message: String },
    /// 一轮生成结束后的流统计 + 诊断。
    ///
    /// `retries` / `preview` 是「空输出」排查用的（T3-1 step2）：前者说明这条流里
    /// 重试过几次，后者是**原始输出**的前若干字符 —— 空输出时它就是空的，格式漂移时
    /// 一眼能看出模型吐了什么，不用再重跑一轮去复现。
    Debug {
        chunks: usize,
        chars: usize,
        lines: usize,
        /// 本轮的自动重试次数（0 = 一次成功；SSE 路不做重试，恒为 0）
        retries: usize,
        /// 原始输出前缀（截断后），供前端打进绘制日志
        preview: String,
    },
    Done { layout: Value, elapsed: f64 },
    Error { message: String },
}

impl Event {
    pub fn to_json(&self) -> Value {
        match self {
            Event::Start { area, size, model } => json!({"type":"start","area":area,"size":size,"model":model}),
            Event::Meta { name } => json!({"type":"meta","name":name}),
            Event::Size { size } => json!({"type":"size","size":size}),
            Event::Item { kind, item, index, elapsed } => json!({
                "type": kind, "item": item, "index": index, "elapsed": elapsed
            }),
            Event::Warn { message } => json!({"type":"warn","message":message}),
            Event::Debug {
                chunks,
                chars,
                lines,
                retries,
                preview,
            } => json!({
                "type":"debug","stats":{"chunks":chunks,"chars":chars,"lines":lines},
                "retries": retries,
                "preview": preview,
            }),
            Event::Done { layout, elapsed } => {
                let c = layout_counts(layout);
                json!({
                    "type":"done","layout":layout,"elapsed":elapsed,
                    "counts": {
                        "buildings": c.buildings,
                        "roads": c.roads,
                        "parks": c.parks,
                        "water": c.water,
                    }
                })
            }
            Event::Error { message } => json!({"type":"error","message":message}),
        }
    }
}

// ───────────────────────── 增量 JSON 解析（纯函数，重点单测）─────────────────────────

/// 从缓冲区里抠出 `"key": [ ... ]` 中**已经闭合**的对象。
///
/// 返回 (新对象列表, 新的扫描起点)。`from` 之后的 `{` 才开始扫描，
/// 这样已处理过的不会重复产出。
pub fn extract_new_objects(buf: &str, key: &str, from: usize) -> (Vec<Value>, usize) {
    let kpos = match buf.find(&format!("\"{key}\"")) {
        Some(i) => i,
        None => return (Vec::new(), from),
    };
    let lb = match buf[kpos..].find('[') {
        Some(i) => kpos + i,
        None => return (Vec::new(), from),
    };
    let bytes = buf.as_bytes();
    let start_scan = (lb + 1).max(from);
    let mut objs = Vec::new();
    let (mut depth, mut start, mut k) = (0i32, -1i32, start_scan);
    let mut consumed = start_scan;
    while k < bytes.len() {
        match bytes[k] {
            b'{' => {
                if depth == 0 {
                    start = k as i32;
                }
                depth += 1;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 && start >= 0 {
                        let frag = &buf[start as usize..k + 1];
                        if let Ok(v) = serde_json::from_str::<Value>(frag) {
                            objs.push(v);
                            consumed = k + 1;
                        }
                        start = -1;
                    }
                }
            }
            b']' if depth == 0 => {
                consumed = k + 1;
                break;
            }
            _ => {}
        }
        k += 1;
    }
    (objs, consumed)
}

/// 从半截 JSON 里取一个字符串标量（如 `"name":"xxx"`）
pub fn extract_scalar(buf: &str, key: &str) -> Option<Value> {
    let pat = format!("\"{key}\"");
    let mut search = 0usize;
    while let Some(rel) = buf[search..].find(&pat) {
        let i = search + rel + pat.len();
        let rest = buf[i..].trim_start();
        let rest = rest.strip_prefix(':').map(|s| s.trim_start())?;
        if let Some(stripped) = rest.strip_prefix('"') {
            // 字符串：找到未转义的收尾引号
            let mut out = String::new();
            let mut chars = stripped.chars();
            let mut escaped = false;
            while let Some(c) = chars.next() {
                if escaped {
                    out.push(c);
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    return Some(Value::String(out));
                } else {
                    out.push(c);
                }
            }
            return None; // 还没读完
        }
        // 数字
        let numstr: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.').collect();
        if !numstr.is_empty() {
            if let Ok(n) = numstr.parse::<i64>() {
                return Some(json!(n));
            }
            if let Ok(f) = numstr.parse::<f64>() {
                return Some(json!(f));
            }
        }
        search = i;
    }
    None
}

/// 把流式收到的碎片组装成最终布局（保证与前端逐条看到的一致）
///
/// ## 出口处的几何净化（路线图 ②）
///
/// `assemble_layout` 是 **AI 精绘布局的唯一产地**，而这份布局是「权威版本」——
/// 前端收到 `done` 时用它 `loadLayout()` **整份替换**画布（`WsDistrict.vue`），
/// 地图库落盘的也是它。所以净化挂在这里，一处生效、两条通路都覆盖。
///
/// 为什么必须有：提示词写了「建筑不要重叠」（`build_prompt` 规则 1），但**没有任何东西执行它**，
/// 模型偶尔会吐重叠/越界/退化的图元，而这些会原样画到用户眼前。详见 `layout_clean.rs`。
///
/// 净化是**保守**的（宁可少剔不可误删）且**幂等**的，正常布局一个图元都不会动。
/// 结果统计既打日志、也以 `_clean` 键写回布局，事后可查「为什么这栋楼不见了」。
pub fn assemble_layout(buf: &str, area: &str, fallback_size: i32) -> Value {
    let mut layout = json!({
        "name": extract_scalar(buf, "name").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_else(|| area.to_string()),
        "size": extract_scalar(buf, "size").and_then(|v| v.as_i64()).unwrap_or(fallback_size as i64),
        "buildings": [], "roads": [], "parks": [], "water": [],
        "_streamed": true,
    });
    for key in ["buildings", "roads", "parks", "water"] {
        let (objs, _) = extract_new_objects(&format!("{buf}]"), key, 0);
        if let Some(o) = layout.as_object_mut() {
            o.insert(key.to_string(), json!(objs));
        }
    }
    // AI 布局出口净化：剔重叠 / 夹越界 / 丢退化。没改动时不打日志，免得刷屏。
    let clean_stats = crate::world_map::layout_clean::clean(&mut layout, fallback_size as f64);
    if clean_stats.touched() {
        tracing::info!("AI 精绘布局净化：{}", clean_stats.summary());
    }
    layout
}

/// 一份布局里四类元素各有多少。
///
/// 判「这一轮是不是空输出」与 `Done` 事件里的 counts 必须是**同一套口径**，
/// 所以只此一份实现：bridge.rs 的重试判定与 stream.rs 的 `to_json` 都用它。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LayoutCounts {
    pub buildings: usize,
    pub roads: usize,
    pub parks: usize,
    pub water: usize,
}

impl LayoutCounts {
    /// 四类相加。判空一律用它，别在调用方各写各的加法（漏一类就是 bug）。
    pub fn total(self) -> usize {
        self.buildings + self.roads + self.parks + self.water
    }
}

/// 数组长度；键不存在 / 不是数组都算 0（半截布局里缺键很正常）。
fn arr_len(layout: &Value, key: &str) -> usize {
    layout
        .get(key)
        .and_then(Value::as_array)
        .map_or(0, |a| a.len())
}

/// 数一份布局里的元素（见 [`LayoutCounts`]）。
pub fn layout_counts(layout: &Value) -> LayoutCounts {
    LayoutCounts {
        buildings: arr_len(layout, "buildings"),
        roads: arr_len(layout, "roads"),
        parks: arr_len(layout, "parks"),
        water: arr_len(layout, "water"),
    }
}

/// 原始输出前缀（诊断用）：**空输出记 `<空>`**，非空截前 `PREVIEW_CHARS` 个字符。
///
/// 为什么要这个：真机实测 4 次里有 2 次「流正常结束但 0 个元素」，光看计数分不清
/// 是「模型一个字没吐」「吐了半截没闭合」还是「吐了完整 JSON 但解析不出来」——
/// 把原文前一段带上，下次一测就能定性，不用再重跑一轮去复现。
pub const PREVIEW_CHARS: usize = 160;

/// 见 [`PREVIEW_CHARS`]。两条通路（SSE / Tauri）共用同一份实现，避免口径不一致。
pub fn preview_of(buf: &str) -> String {
    if buf.trim().is_empty() {
        return "<空>".to_string();
    }
    let head: String = buf.chars().take(PREVIEW_CHARS).collect();
    if buf.chars().count() > PREVIEW_CHARS {
        format!("{head}…")
    } else {
        head
    }
}

// ───────────────────────── LLM 配置与请求 ─────────────────────────

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub url: String,
    pub model: String,
    pub api_key: String,
}

impl LlmConfig {
    /// 从环境变量读（独立验证项目用）；
    /// 集成到 LingChat 后这里改成复用 `ai_service::llm::slot_snapshot`，其余逻辑不变。
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("WM_LLM_KEY").ok()?;
        Some(Self {
            url: std::env::var("WM_LLM_URL")
                .unwrap_or_else(|_| "https://api.deepseek.com/v1/chat/completions".into()),
            model: std::env::var("WM_LLM_MODEL").unwrap_or_else(|_| "deepseek-flash".into()),
            api_key,
        })
    }

    /// 从 Python 项目的 config.local.js 里读（开发期省事）
    pub fn from_legacy_config(path: &str) -> Option<Self> {
        let txt = std::fs::read_to_string(path).ok()?;
        let grab = |key: &str| -> Option<String> {
            let pat = format!("{key}:");
            let i = txt.find(&pat)?;
            let rest = &txt[i + pat.len()..];
            let q1 = rest.find('"')?;
            let rest2 = &rest[q1 + 1..];
            let q2 = rest2.find('"')?;
            Some(rest2[..q2].to_string())
        };
        Some(Self {
            url: grab("base_url")?,
            model: grab("model").unwrap_or_else(|| "deepseek-flash".into()),
            api_key: grab("api_key")?,
        })
    }
}

/// 构造生成小区的 prompt（与 Python 侧保持同一套要求）
pub fn build_prompt(area: &str, context: &str, base: i32, osm_hint: Option<&str>) -> (String, String) {
    let sys_p = format!(
        "你是城市规划师，为一个二维世界地图生成小区(街区)布局JSON。只返回JSON，格式:\n\
{{\"name\":\"小区名\",\"size\":{base},\
\"buildings\":[{{\"x\":0,\"y\":0,\"w\":3,\"h\":2,\"type\":\"residential\",\"name\":\"3号楼\",\"floors\":6}}],\
\"roads\":[{{\"x1\":0,\"y1\":0,\"x2\":{base},\"y2\":0,\"type\":\"main\",\"name\":\"中山路\"}}],\
\"parks\":[{{\"x\":5,\"y\":5,\"w\":4,\"h\":3,\"name\":\"中心公园\"}}],\
\"water\":[{{\"x\":10,\"y\":10,\"w\":3,\"h\":2,\"name\":\"人工湖\"}}]}}\n\
规则:\n\
1) size 是网格边长(用 {base}), 所有坐标 0..size; 建筑不要重叠。\n\
2) building.type ∈ residential/office/commercial/shop/restaurant/cafe/school/hospital/civic/leisure。\n\
3) **每栋建筑都必须有 name**，中文，具体有辨识度、贴合该区域与剧情设定。\n\
4) residential 用栋号(如「3号楼」); 其余用店名/楼名。每栋都要有 floors(楼层数)。\n\
5) 每条主干道/次干道都要有 name(路名)。\n\
6) parks/water 也要有 name。\n\
7) 建筑数量约 size*0.7 栋，沿道路两侧排布。\n\
先输出 name 和 size，再依次输出 buildings（一栋接一栋）、roads、parks、water。只返回JSON，不要多余文字。"
    );
    let mut usr = format!("区域: {area}。");
    if !context.is_empty() {
        usr.push_str(&format!("剧情: {context}。"));
    }
    if let Some(h) = osm_hint {
        if !h.is_empty() {
            usr.push_str(h);
            usr.push_str("请参考上述真实地物类型与数量分布来设计小区，使其贴近真实。");
        }
    }
    usr.push_str(&format!("请生成这个小区的地图布局（网格 {base}x{base}）。"));
    (sys_p, usr)
}

/// 流式生成：把事件推给 channel，调用方边收边转发（SSE / Tauri Channel）
///
/// 返回接收端；后台任务会在流结束后关闭它。
pub fn spawn_stream(
    cfg: LlmConfig,
    area: String,
    context: String,
    expand: i32,
    osm_hint: Option<String>,
    timeout_secs: u64,
) -> mpsc::Receiver<Event> {
    let (tx, rx) = mpsc::channel::<Event>(256);
    tokio::spawn(async move {
        let t0 = std::time::Instant::now();
        let base = 20 + expand.max(0) * 8;
        let (sys_p, usr) = build_prompt(&area, &context, base, osm_hint.as_deref());
        let _ = tx.send(Event::Start { area: area.clone(), size: base, model: cfg.model.clone() }).await;

        let payload = json!({
            "model": cfg.model,
            "messages": [
                {"role":"system","content": sys_p},
                {"role":"user","content": usr}
            ],
            "temperature": 0.8,
            "max_tokens": 6000,
            "enable_thinking": false,
            "response_format": {"type": "json_object"},
            "stream": true
        });

        // ⚠️ 必须注入预配置的 TLS 后端（见 `src/utils/tls.rs` 的模块说明）：
        // reqwest 0.13 默认用 rustls-platform-verifier 验证系统证书，而本仓**从不初始化它**
        // → 裸 `Client::builder().build()` 在 Android 上发请求时会 **panic**（不是返回 Err）：
        //   thread 'tokio-rt-worker' panicked at rustls-platform-verifier-0.7.0/src/android.rs:90:
        //   Expect rustls-platform-verifier to be initialized
        // 这条路径就是「AI 精绘小区」，也就是说**小区图在真机上根本画不出来**。
        // 本机（Termux 同为 android target）已复现：走裸客户端的请求返回 HTTP 000 + 上面那行 panic。
        let tls = match crate::utils::tls::build_tls_config() {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(Event::Error { message: format!("TLS 配置失败: {e}") }).await;
                return;
            }
        };
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .tls_backend_preconfigured(tls)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Event::Error { message: format!("HTTP 客户端创建失败: {e}") }).await;
                return;
            }
        };
        let resp = client
            .post(&cfg.url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .bearer_auth(&cfg.api_key)
            .json(&payload)
            .send()
            .await;
        let mut resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let _ = tx.send(Event::Error { message: format!("LLM 返回 HTTP {}", r.status()) }).await;
                return;
            }
            Err(e) => {
                let _ = tx.send(Event::Error { message: format!("请求失败: {e}") }).await;
                return;
            }
        };

        let mut buf = String::new();
        let mut pending = String::new(); // 未凑成完整行的尾巴
        let mut consumed: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for k in ["buildings", "roads", "parks", "water"] {
            consumed.insert(k.into(), 0);
            counts.insert(k.into(), 0);
        }
        let mut name_sent = false;
        let mut dbg = (0usize, 0usize, 0usize); // chunks, chars, lines

        loop {
            let bytes = match resp.chunk().await {
                Ok(Some(b)) => b,
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Event::Warn { message: format!("读流异常: {e}") }).await;
                    break;
                }
            };
            dbg.0 += 1;
            let text = String::from_utf8_lossy(&bytes);
            pending.push_str(&text);

            // 按行切（最后一段可能不完整，留到下一轮）
            while let Some(nl) = pending.find('\n') {
                let line: String = pending.drain(..=nl).collect();
                let line = line.trim();
                if !line.starts_with("data:") {
                    continue;
                }
                dbg.2 += 1;
                let data = line[5..].trim();
                if data == "[DONE]" {
                    break;
                }
                // 【临时诊断】把前 3 个 data 行原样报给前端，定位「chars=0」的成因
                if dbg.2 <= 3 {
                    let _ = tx.send(Event::Warn {
                        message: format!("RAW#{} {}", dbg.2, &data.chars().take(220).collect::<String>()),
                    }).await;
                }
                let obj: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(e) => {
                        if dbg.2 <= 3 {
                            let _ = tx.send(Event::Warn { message: format!("PARSE-FAIL {e}") }).await;
                        }
                        continue;
                    }
                };
                let delta = obj
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                    .and_then(|c| c.get("delta"));
                let piece = delta
                    .and_then(|d| d.get("content").or_else(|| d.get("reasoning_content")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if piece.is_empty() {
                    continue;
                }
                dbg.1 += piece.len();
                buf.push_str(piece);

                // 小区名 / 规模（最先出现）
                if !name_sent {
                    if let Some(Value::String(n)) = extract_scalar(&buf, "name") {
                        name_sent = true;
                        let _ = tx.send(Event::Meta { name: n }).await;
                    }
                    if let Some(sz) = extract_scalar(&buf, "size").and_then(|v| v.as_i64()) {
                        let _ = tx.send(Event::Size { size: sz as i32 }).await;
                    }
                }

                // 逐类增量取元素
                for (key, ev) in [
                    ("buildings", "building"),
                    ("roads", "road"),
                    ("parks", "park"),
                    ("water", "water"),
                ] {
                    let from = *consumed.get(key).unwrap_or(&0);
                    let (objs, next) = extract_new_objects(&buf, key, from);
                    consumed.insert(key.into(), next);
                    for o in objs {
                        let c = counts.entry(key.into()).or_insert(0);
                        *c += 1;
                        if tx
                            .send(Event::Item {
                                kind: ev.into(),
                                item: o,
                                index: *c,
                                elapsed: (t0.elapsed().as_millis() as f64) / 1000.0,
                            })
                            .await
                            .is_err()
                        {
                            return; // 接收端已关闭（前端断开）
                        }
                    }
                }
            }
        }

        // SSE 路不做自动重试（浏览器调试用，重试语义留给 Tauri 正路），
        // 但把同样的诊断字段报出去，两条通路的前端处理逻辑保持一致。
        let _ = tx
            .send(Event::Debug {
                chunks: dbg.0,
                chars: dbg.1,
                lines: dbg.2,
                retries: 0,
                preview: preview_of(&buf),
            })
            .await;
        let layout = assemble_layout(&buf, &area, base);
        let _ = tx
            .send(Event::Done { layout, elapsed: (t0.elapsed().as_millis() as f64) / 1000.0 })
            .await;
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_objects_only_complete_ones() {
        let buf = r#"{"name":"测试","buildings":[{"x":1,"y":2,"w":3,"h":2,"name":"1号楼"},{"x":5,"#;
        let (objs, _) = extract_new_objects(buf, "buildings", 0);
        assert_eq!(objs.len(), 1, "只有第一个对象闭合了，应只抠出它");
        assert_eq!(objs[0]["name"], "1号楼");
    }

    #[test]
    fn extract_objects_incremental_no_duplicates() {
        let part1 = r#"{"buildings":[{"name":"A"},{"name":"B"}]"#;
        let (a, pos) = extract_new_objects(part1, "buildings", 0);
        assert_eq!(a.len(), 2);
        // 再喂同样的内容，从上次位置继续 → 不该重复
        let (b, _) = extract_new_objects(part1, "buildings", pos);
        assert!(b.is_empty(), "已处理过的不应重复产出");
        // 追加一个新对象
        let part2 = r#"{"buildings":[{"name":"A"},{"name":"B"},{"name":"C"}]"#;
        let (c, _) = extract_new_objects(part2, "buildings", pos);
        assert_eq!(c.len(), 1, "只应产出新增的那个");
        assert_eq!(c[0]["name"], "C");
    }

    #[test]
    fn extract_objects_handles_nested() {
        // 对象里带嵌套数组/对象，括号计数必须正确
        let buf = r#"{"buildings":[{"name":"A","tags":{"a":[1,2]},"pts":[{"x":1}]},{"na"#;
        let (objs, _) = extract_new_objects(buf, "buildings", 0);
        assert_eq!(objs.len(), 1, "嵌套结构不应打断计数");
        assert_eq!(objs[0]["tags"]["a"][1], 2);
    }

    #[test]
    fn extract_objects_missing_key_returns_empty() {
        let (o, p) = extract_new_objects(r#"{"name":"x"}"#, "buildings", 0);
        assert!(o.is_empty());
        assert_eq!(p, 0);
    }

    #[test]
    fn extract_scalar_string_and_number() {
        assert_eq!(extract_scalar(r#"{"name":"越秀小区","size":20}"#, "name").unwrap(), json!("越秀小区"));
        assert_eq!(extract_scalar(r#"{"name":"甲","size":20}"#, "size").unwrap(), json!(20));
        // 半截字符串 → 还没读完，返回 None
        assert!(extract_scalar(r#"{"name":"越秀小"#, "name").is_none());
        assert!(extract_scalar(r#"{"size":"#, "size").is_none());
    }

    #[test]
    fn extract_scalar_escaped_quote() {
        let v = extract_scalar(r#"{"name":"a\"b"}"#, "name").unwrap();
        assert_eq!(v, json!("a\"b"), "转义引号不应提前结束");
    }

    #[test]
    fn assemble_layout_from_partial_stream() {
        let buf = r#"{"name":"测试小区","size":18,"buildings":[{"x":1,"y":1,"w":2,"h":2,"type":"residential","name":"1号楼"},{"x":5,"y":5,"w":3,"h":2,"type":"office","name":"云顶大厦"}],"roads":[{"x1":0,"y1":0,"x2":18,"y2":0,"type":"main","name":"中山路"}],"parks":[{"x":8,"y":8,"w":3,"h":3,"name":"中心公园"}],"water":[]}"#;
        let lay = assemble_layout(buf, "越秀区", 20);
        assert_eq!(lay["name"], json!("测试小区"));
        assert_eq!(lay["size"], json!(18));
        assert_eq!(lay["buildings"].as_array().unwrap().len(), 2);
        assert_eq!(lay["roads"].as_array().unwrap().len(), 1);
        assert_eq!(lay["parks"].as_array().unwrap().len(), 1);
        assert_eq!(lay["_streamed"], json!(true));
    }

    /// **集成**：`assemble_layout` 出口的净化确实生效（路线图 ②）。
    ///
    /// 这条是 wiring 测试：光有 `layout_clean` 的单测不够，得证明它真的挂在了
    /// AI 布局的出口上 —— 否则模块再正确也是死代码。
    #[test]
    fn assemble_layout_cleans_ai_output() {
        // 模型吐了：一栋重复的楼、一栋越界、一栋退化，外加一条零长度路
        let buf = r#"{"name":"测试小区","size":20,"buildings":[
            {"x":2,"y":2,"w":4,"h":3,"type":"residential","name":"1号楼","floors":6},
            {"x":2,"y":2,"w":4,"h":3,"type":"residential","name":"1号楼","floors":6},
            {"x":18,"y":1,"w":5,"h":2,"type":"shop","name":"越界铺","floors":1},
            {"x":1,"y":1,"w":0,"h":2,"type":"shop","name":"退化铺","floors":1}
        ],"roads":[{"x1":5,"y1":5,"x2":5,"y2":5,"type":"main","name":"零长路"}],"parks":[],"water":[]}"#;
        let lay = assemble_layout(buf, "越秀区", 20);
        let bs = lay["buildings"].as_array().unwrap();
        assert_eq!(bs.len(), 2, "重复的剔掉、退化的剔掉、越界的夹回保留：{bs:?}");
        // 保住先出现的那栋
        assert_eq!(bs[0]["name"], json!("1号楼"));
        assert_eq!(bs[0]["x"], json!(2));
        // 越界那栋被夹进画布
        let clamped = bs.iter().find(|b| b["name"] == json!("越界铺")).expect("越界铺应保留");
        assert_eq!(clamped["w"], json!(2), "18+5=23 → 夹到 20");
        // 零长度路被剔
        assert_eq!(lay["roads"].as_array().unwrap().len(), 0);
        // 统计要写回布局，事后可查
        assert_eq!(lay["_clean"]["buildings"]["overlap"], json!(1));
        assert_eq!(lay["_clean"]["buildings"]["degenerate"], json!(1));
        assert_eq!(lay["_clean"]["buildings"]["clamped"], json!(1));
        assert_eq!(lay["_clean"]["roads"]["degenerate"], json!(1));
        assert_eq!(lay["_clean"]["removed"], json!(3));
    }

    /// 净化必须是**保守**的：模型老老实实画的时候，一栋都不能动。
    #[test]
    fn assemble_layout_keeps_clean_ai_output_intact() {
        let buf = r#"{"name":"临江苑","size":20,"buildings":[
            {"x":1,"y":1,"w":3,"h":2,"type":"residential","name":"1号楼","floors":6},
            {"x":5,"y":1,"w":3,"h":2,"type":"office","name":"云顶大厦","floors":12}
        ],"roads":[{"x1":0,"y1":4,"x2":20,"y2":4,"type":"main","name":"中山路"}],
        "parks":[{"x":8,"y":8,"w":3,"h":3,"name":"中心公园"}],"water":[]}"#;
        let lay = assemble_layout(buf, "越秀区", 20);
        assert_eq!(lay["buildings"].as_array().unwrap().len(), 2);
        assert_eq!(lay["roads"].as_array().unwrap().len(), 1);
        assert_eq!(lay["parks"].as_array().unwrap().len(), 1);
        assert_eq!(lay["_clean"]["removed"], json!(0), "合法布局不该剔任何东西");
        // 位置与字段原样
        assert_eq!(lay["buildings"][1]["name"], json!("云顶大厦"));
        assert_eq!(lay["buildings"][1]["floors"], json!(12));
        assert_eq!(lay["buildings"][1]["x"], json!(5));
    }

    #[test]
    fn assemble_layout_falls_back_to_area_name() {
        let lay = assemble_layout("{}", "广州市·越秀区", 20);
        assert_eq!(lay["name"], json!("广州市·越秀区"));
        assert_eq!(lay["size"], json!(20));
        assert!(lay["buildings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn prompt_contains_requirements() {
        let (sys_p, usr) = build_prompt("广州市·越秀区", "雨天", 20, Some("该区域真实 OSM 数据：建筑 yes×145。"));
        for kw in ["每栋建筑都必须有 name", "floors", "路名", "size 是网格边长"] {
            assert!(sys_p.contains(kw), "prompt 应含要求: {kw}");
        }
        assert!(usr.contains("广州市·越秀区"));
        assert!(usr.contains("雨天"));
        assert!(usr.contains("真实 OSM 数据"), "OSM 参考应拼进 prompt");
    }

    #[test]
    fn event_serialization() {
        let e = Event::Item { kind: "building".into(), item: json!({"name":"1号楼"}), index: 3, elapsed: 1.5 };
        let j = e.to_json();
        assert_eq!(j["type"], json!("building"));
        assert_eq!(j["index"], json!(3));
        assert_eq!(j["item"]["name"], json!("1号楼"));
        // Done 事件要带 counts，前端据此显示统计
        let d = Event::Done { layout: json!({"buildings":[1,2],"roads":[1]}), elapsed: 9.9 };
        let dj = d.to_json();
        assert_eq!(dj["counts"]["buildings"], json!(2));
        assert_eq!(dj["counts"]["roads"], json!(1));
        assert_eq!(dj["counts"]["water"], json!(0));
    }

    #[test]
    fn preview_marks_empty_and_truncates() {
        // 空输出必须能被一眼认出（这是「空输出 vs 格式错」的判定依据）
        assert_eq!(preview_of(""), "<空>");
        assert_eq!(preview_of("   \n "), "<空>");
        // 非空：原样带出
        assert_eq!(preview_of(r#"{"buildings":[]}"#), r#"{"buildings":[]}"#);
        // 超长：截断并加省略号，且按**字符**截（中文不能截出半个字）
        let long = "汉".repeat(PREVIEW_CHARS + 50);
        let p = preview_of(&long);
        assert_eq!(p.chars().count(), PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn layout_counts_totals_all_four_kinds() {
        let c = layout_counts(&json!({"buildings":[1,2],"roads":[1],"parks":[],"water":[1,2,3]}));
        assert_eq!(c.buildings, 2);
        assert_eq!(c.roads, 1);
        assert_eq!(c.parks, 0);
        assert_eq!(c.water, 3);
        assert_eq!(c.total(), 6);
        // 键缺失 / 值不是数组 → 0，不能 panic
        assert_eq!(layout_counts(&json!({"buildings": "oops"})).total(), 0);
        assert_eq!(layout_counts(&json!({})).total(), 0);
    }

    #[test]
    fn debug_event_carries_retry_diagnostics() {
        let e = Event::Debug {
            chunks: 7,
            chars: 120,
            lines: 3,
            retries: 1,
            preview: "<空>".into(),
        };
        let j = e.to_json();
        assert_eq!(j["type"], json!("debug"));
        // 老字段原样保留（两条通路的前端都在读它）
        assert_eq!(j["stats"]["chunks"], json!(7));
        assert_eq!(j["stats"]["chars"], json!(120));
        assert_eq!(j["stats"]["lines"], json!(3));
        // 新字段：重试次数 + 原始输出前缀（空输出时是 <空>）
        assert_eq!(j["retries"], json!(1));
        assert_eq!(j["preview"], json!("<空>"));
    }

    #[test]
    fn legacy_config_parsing() {
        let dir = std::env::temp_dir().join(format!("wm_cfg_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let fp = dir.join("config.local.js");
        std::fs::write(
            &fp,
            "export default {\n  base_url: \"https://api.deepseek.com/v1/chat/completions\",\n  model: \"deepseek-flash\",\n  api_key: \"sk-test\"\n}\n",
        )
        .unwrap();
        let cfg = LlmConfig::from_legacy_config(fp.to_str().unwrap()).unwrap();
        assert_eq!(cfg.model, "deepseek-flash");
        assert_eq!(cfg.api_key, "sk-test");
        assert!(cfg.url.contains("deepseek.com"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
