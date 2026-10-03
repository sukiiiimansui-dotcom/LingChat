/**
 * wsBldBudget.ts —— 🏙 **「双预算挑楼」的唯一真源**（2026-10-02）。
 *
 * ## 这是什么（机主 2026-10-02 拍板的那一条）
 * 机主原话（经父代理转述，**照这个做**）：
 *   「**B2 把"每格 4 栋"改成双预算挑楼**（候选=视野内全部楼，预算 = **Σ投影 px² + Σ顶点**，
 *    **固定常量**，`moveend` 重算）。常量自己定，但要在注释里写清**为什么是这个数**。」
 *
 * 被替掉的旧口径：`wsBldPickStore.bldCapForCellDeg()` —— 每 0.05° 格 ≤100 栋，
 * 0.01° 细格按面积等比缩 ⇒ **每格 4 栋**。实测渝中 6 格 2492 栋只画约 24 栋（≈1%），
 * 屏上是"随机丢楼"。本模块把"按个数挑"换成**按代价挑**。
 *
 * ## 代价模型从哪来（不许编，全部可溯源）
 * 外部取经（`world_map/PERF-BUILDINGS-EXTERNAL.md`）里**有官方来源**的两条：
 *  ① 【deck.gl 官方性能指南】渲染时间两项 = **顶点着色器调用数（≈要素数）+ 片元着色器调用数（= 画到的像素总数）**；
 *     并给量级：半径 5px 的点 × 1000 万 = **最多 10 亿次片元调用/帧**、"连新 MacBook Pro 都吃力"；
 *     高 DPI = **4 倍片元**。⇒ **手机上先跪的是填充率**，所以第一个预算按 **px²** 立。
 *  ② 【MapLibre 官方源码·`fill_extrusion_bucket.ts`】每段墙固定 **4 顶点 / 6 索引（2 三角形）**，
 *     屋顶 n 个顶点的环 ⇒ n−2 个三角形；官方 issue 里"一 tile 一 draw call、累计顶点超
 *     `MAX_VERTEX_ARRAY_LENGTH = 2^16−1 = 65535` 才切新 segment"。
 *     ⇒ 【我方推算，与外部文档同式】一栋 **4 顶点**长方形楼 ≈ 墙 4×4 + 屋顶 4 = **20 顶点**
 *       ⇒ 每栋顶点 = `5 × 轮廓点数`（见 `bldRingVertices`）。第二个预算按**顶点**立。
 * ⚠️ 这两条都**不是**实测帧率：本机无头无 WebGL，真机 fps 只有机主能判（外部文档 §5 已如实写明）。
 *
 * ## 为什么是这两个**固定常量**（机主点名的"说清为什么"）
 * **`WS_BLD_BUDGET_PX2 = 400_000`（CSS 像素²）**
 *   · 口径：屏幕空间里"这栋楼可能画到的像素"之和（屋顶投影 + 可见墙面的投影，见 `bldScreenCost`）。
 *   · 锚点：本项目的两个真实视口 —— 宽屏 `932×557 ≈ 519k`、手机宽 `500×772 ≈ 386k`（PROJECT-STATE 实测尺寸）。
 *     取 **400k ≈ 一屏的 0.77~1.04 倍** ⇒ **楼体加起来最多铺满约一屏**：楼体带来的片元开销
 *     在最坏情况下 ≈ 一次全屏 pass —— 与底图栅格/道路**同量级**，不是它的几十倍。
 *   · 留余量：默认机位（z16.4，视野 ≈1.46km×0.87km，渝中密度 ≈342 栋/km²）估出来约 **434 栋 / 12.6 万 px²**
 *     ⇒ 预算是估算值的 **3.2 倍**：**正常视野下这个预算根本不起约束**（这正是"不再随机丢 99%"要的效果），
 *     它只在**拉远**（每栋楼变小、屏上同时几千栋）时才咬住。若它定得刚好卡在默认机位上，
 *     观感会随视野抖动 —— 那是"预算当降级档用"，机主明确不批。
 * **`WS_BLD_BUDGET_VERTS = 40_000`（顶点）**
 *   · 锚点：`65535` 是 MapLibre 切新 segment（= 新 draw call）的硬线，取它的 **61%** 作预算 ⇒
 *     单个 tile 里我们这批楼**不可能**自己把 segment 撑爆（线/水系等其它同源几何也吃同一段余量）。
 *   · 量级：按上面 20 顶点/栋的官方推算，40k 顶点 ≈ **2000 栋**；外部文档实测口径是
 *     "渝中 **2492 栋**全画 ≈ 5 万顶点，**仍 < 65535**、draw call 数不变，GPU 顶点侧是零头"
 *     ⇒ 40k 正好落在**那份调研自己认定的安全量级之内**，且比它小 20%。
 *   · 为什么要有第二个预算：像素预算**管不住顶点**（z12 时一栋楼在屏上只有 1~2px，
 *     12000 栋的 px² 也就 2 万出头，但顶点是 24 万）—— 那是 JS/上传/内存的账，不是填充率的账。
 *
 * ## 🆕 2026-10-03（机主真机验收后的加档）· **默认严格档 + 用户开关**
 * 机主真机报的问题（原话）：「楼一会少一会多，一会直接不见」。真因就是上面那两个**代价**预算
 * 在两端都不合适：低 zoom 时每栋只有几 px² ⇒ 40 万 px² 能塞下**成千上万**个小盒子（太多）；
 * 高 zoom 时几栋大楼就吃满（太少）。
 * 机主的决定（原话）：「我想要一开始直接**固定可显示的楼房数据，严格限制**，但是要求用户
 * **可在选择是否启用多楼房模式（不推荐）**」⇒ 本模块加第三个上限：**栋数**。
 *   · `maxDrawn` = **栋数硬上限**，与两个代价预算**同时**生效、谁也替不了谁；
 *   · 默认档 `WS_BLD_MAX_DRAWN = 100`（严格档）；用户自己开"多楼房模式"才用
 *     `WS_BLD_MAX_DRAWN_MANY = 4000`（不推荐，更卡）；
 *   · 档位是**用户的选择**（存 `localStorage`，见 `wsBldMode.ts`），**不是**按帧率/设备自动缩
 *     （机主红线：不许自动降级）。
 *
 * ## 🆕 2026-10-03（第三条）· **按 zoom 分层：远了画足迹 / 近了画立体**
 * 上一条（固定 100 栋）真机验收又是错的，机主原话：「**什么都没有**」—— 真因是**固定栋数跟 zoom 无关**，
 * 而"一栋楼在屏幕上多大"**只跟 zoom 有关**（本项目实测像素表，1280px 视口 / 纬度 29.56°）：
 *
 * | zoom | 30m 楼在屏上的宽 | 那一档该画什么 |
 * |---|---|---|
 * | z12 | **0.9px** | 足迹（平面）—— 100 个 1px 的点 = 一片空白 |
 * | z13 | **1.8px** | 足迹（平面） |
 * | z14 | **3.6px** | 立体（这一档起楼体分得开） |
 * | z15 | **7.2px** | 立体 |
 * | z16 | **14.4px** | 立体 |
 *
 * 机主的决定（原话意思）：「**z<14 画"足迹"（平面，看得见城市肌理）；z≥14 画立体（严格档 100 栋）**」
 * ⇒ 本模块把"栋数上限"从**只看档位**改成 **档位 × zoom**（`bldMaxDrawnFor`）：
 *   · `z < WS_BLD_FOOTPRINT_MAXZOOM`（= 14，**与 `WS_BLD_DETAIL_ROOF_ZOOM` 同一条分界线**）
 *     ⇒ 走**宽档** `WS_BLD_MAX_DRAWN_MANY`（4000）：足迹要的是"看得见肌理"，1px 的点越多越像城市；
 *   · `z ≥ 14` ⇒ 严格档 `WS_BLD_MAX_DRAWN`（100）：立体楼一栋占几百 px²，100 栋就是"一眼数得清"；
 *   · **多楼房模式**（用户自己开的那个不推荐档）⇒ **全 zoom 一致** 4000（用户明确要"多"，不替他分档）；
 *   · `zoom` **读不出来**（NaN / undefined / 非数）⇒ 按**严格档** 100：宁可少画，不许拿猜的数乱画。
 * ⚠️ 宽档 ≠ 没有上限：两个**代价**预算（Σ投影 px² / Σ顶点）照样同时生效 —— 低 zoom 时真正先咬住的
 *    是**顶点**预算（40k ÷ 20 顶点/栋 ≈ **2000 栋**，见下面那条"如实"注释），栋数上限只是防呆线。
 * ⚠️ 这一层分档**只跟 zoom 走**：不读帧率、不读设备、不看候选多少（机主红线：不许自动降级）。
 *
 * ## 🆕 2026-10-03（第四条）· **低缩放改按「与相机无关的静态重要度」取前 K**
 * 方案：`world_map/PLAN-BLD-LOWZOOM.md`（机主已批准的**唯一方案**）§0 结论 / §2 量化表 / §4 ⒝。
 * 病根（方案 §1③）：低缩放每轮 flush 对**每个候选**逐点调 `map.project()`（z13 实测 **107,098 次**），
 * 且顶点预算被打满（39,995/40,000）⇒ 贪心落在背包边界，仓库每入库一格就换一批 + 整份 `setData`。
 * 做法（**这一处就是全部口径**）：
 *   · 排序键换成**静态分** = `h3d`（渲染高度，米）× 脚印 bbox 面积（m²）——**不含任何相机量**，
 *     按 `id` 记忆化（同一栋楼只算一次）⇒ 同一份 bounds 连调两次，id 列表**逐字节相同**；
 *   · 候选仍是"视野内全部楼"，但**一次都不投影**（判视野只用经纬度比较）；
 *   · 取前 `WS_BLD_STATIC_TOP_K`（200，天花板 `WS_BLD_STATIC_TOP_K_MAX` = 400，见那两个常量）；
 *   · 两个代价预算照旧兜底（px² 由 `metersPerPixel` 换算，**不投影**）；
 *   · 跨 14 加 `WS_BLD_TIER_HYSTERESIS`（0.25）滞回（`bldTierOfZoom`）。
 * ⚠️ `z ≥ 14` 那条路**一个字节都没动**（仍是 `px/verts` 全序 + 两个预算 + 严格档 100 栋）。
 * ⚠️ `h3d` 在**挑楼那一刻**还没上妆（`flushBldStore` 是先挑后妆）⇒ 用共享真源
 *    `wsBuildingLook.renderHeight()` 算出**将要画的那个高度**（`dressBase` 写进 `h3d` 的就是它）
 *    —— 不是第二份口径，也不是"编高度"：同一个纯函数的同一份规则。
 *
 * ## 确定性（项目纪律）
 * 同一输入（视野 + 楼数据 + 三个常量 + **zoom**）⇒ **挑出来的批次逐字节可复现**：
 *   · 没有任何 `Math.random()` / `Date.now()` / 帧率 / 设备能力输入；
 *   · 排序是**全序**：`单位顶点换到的像素`降序 → 像素降序 → `id` 升序（第三键保证不存在"等值不定序"）；
 *   · 输入顺序不影响结果（全序 + 稳定 `Array.sort`），但**同序输入必然同序输出**；
 *   · 🔴 **不达 `maxDrawn` 时行为与"没有这个上限"逐字节相同**（连 `why` 都一字不差）——
 *     新增的第三个上限**只在它真的咬住时**才出现在判词里，别让它变成"到处都多一句"。
 */

/* 🏢 **拆件分档的真源**（`wsBldDetailTiers`，2026-10-02 B1）—— 本模块只借它那**一个**阈值：
   足迹/立体的分界线 = 女儿墙那一档的分界线（机主点名的那条 `<14` / `≥14`）。
   ⚠️ 单向依赖（本文件 → 它），它不 import 任何东西 ⇒ 不成环。 */
import { WS_BLD_DETAIL_ROOF_ZOOM } from "./wsBldDetailTiers";
/* 🌆 静态重要度要 `h3d`，而**上妆还没发生**（`flushBldStore` 先挑后妆）⇒ 借共享真源
   `renderHeight()` 算出"将要画的那个高度"（`dressBase` 随后写进 `h3d` 的就是同一个数）。
   ⚠️ 纯函数、只 import `wsBldDetailTiers` ⇒ 不成环（本文件 → 它 → 那一份阈值）。 */
import { renderHeight } from "./wsBuildingLook";

/** Σ投影面积预算（CSS 像素²）—— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_PX2 = 400_000;

/** Σ顶点预算 —— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_VERTS = 40_000;

/**
 * 🏙 **默认严格档**：一屏**最多画 100 栋**（机主 2026-10-03 拍板："一开始直接固定可显示的楼房数据，
 * 严格限制"）。
 *
 * 为什么是 100：它是**"看得清"**的量，不是性能推出来的数 —— 屏幕上 100 栋楼已经能铺满近景、
 * 一眼能数清"这几栋就是这几栋"，而"一会儿多一会儿少"正是机主否掉的那种观感。
 * 量级上也与旧口径自洽：老的"每格 ≤100 栋"（`bldCapForCellDeg`）就是 100，这里把它从"每格"
 * 提到"整屏"，仍然是同一个数 ⇒ 机主认过的那个密度没有被偷偷改掉。
 */
export const WS_BLD_MAX_DRAWN = 100;

/**
 * 🚨 **多楼房模式（不推荐）**的上限：4000 栋。
 *
 * 为什么是 4000：它是外部取经那份调研里**实测过**的量级（渝中半岛 2492 栋全画 ≈ 5 万顶点、
 * draw call 数不变、GPU 顶点侧是零头）再往上留一点余量 ⇒ "想要多就给到真能多、但不会把
 * 手机直接打死"的那一档。
 * ⚠️ **不推荐**不是客套话：这个档位下框选/填充率/JS 侧上传都回到"几千个盒子"的量级，
 * 低 zoom 时尤其卡 —— UI 的 `title` 必须把这句话写出来（见 `WsCityEntry.vue`）。
 */
export const WS_BLD_MAX_DRAWN_MANY = 4000;

/**
 * 🌆 **足迹档 / 立体档的分界线**（2026-10-03 机主真机验收后拍板）。
 *
 * `z < 14` ⇒ 画**足迹**（平面 `fill`，看得见城市肌理）· `z ≥ 14` ⇒ 画**立体**（挤出楼体，严格档 100 栋）。
 * 为什么是 14：**它不是新定的数** —— 与既有的 `WS_BLD_DETAIL_ROOF_ZOOM`（女儿墙那一档）是
 * **同一条分界线**（机主 2026-10-02 点名 `<14` 平顶 / `14–16` 女儿墙）⇒ 这里**不再写第二个 14**，
 * 直接引用那一份（两边各写一份，改一处漏一处 —— 本项目栽过）。实测依据见文件头那张像素表：
 * z13 时一栋 30m 楼只有 1.8px（画立体=看不见），z14 有 3.6px（画立体=分得开）。
 */
export const WS_BLD_FOOTPRINT_MAXZOOM = WS_BLD_DETAIL_ROOF_ZOOM;

/**
 * 🌆 **足迹档的「静态取前几栋」（K）** —— 方案 `PLAN-BLD-LOWZOOM.md` §2 量化表 / §4 ⒝ 那个 200。
 *
 * 为什么是 200：方案 §2 的同池对照（z13、真包 30,000 栋）实测 —— top-200 = `Σ顶点 15,075`
 * （预算的 38%）·`Σpx² 29,681`（7.4%）⇒ **两个预算都不饱和**，贪心不再落在背包边界上；
 * top-800 会超顶点预算（45,470 > 40,000）。K 只该有一份，所以取值口是 `bldStaticTopK()`。
 */
export const WS_BLD_STATIC_TOP_K = 200;

/**
 * 🌆 **K 的天花板**（方案 §2 那句「**K 的天花板在 400**」）。
 *
 * 400 是"再往上就会把顶点预算顶穿"的那条线（top-400 = 25,725 顶点，已在预算的 64%）——
 * 它不参与选楼，只把 `bldStaticTopK()` 夹住：谁把 K 调到 800，夹完仍然是 400，
 * 不会出现"改一个常量就把低缩放打回打满预算"的旧毛病。
 */
export const WS_BLD_STATIC_TOP_K_MAX = 400;

/**
 * 🌆 **足迹档取前几栋的唯一取值口**（K，夹在天花板之内）。
 * 页面/App/自检都读它，不许各写一份 200（改一处漏一处 —— 本项目栽过）。
 */
export function bldStaticTopK(): number {
  return Math.min(WS_BLD_STATIC_TOP_K_MAX, Math.max(0, Math.floor(WS_BLD_STATIC_TOP_K)));
}

/**
 * 🌆 **跨 14 的滞回宽度**（zoom）—— 方案 `PLAN-BLD-LOWZOOM.md` §0/§4 ⒝ 的「0.25 滞回」。
 *
 * 病根（方案 §1c）：`tier !== bldFlushedTier` 就重挑 ⇒ 13.9↔14.1 来回 10 次就重挑 10 次。
 * 加上 0.25 之后：足迹档要涨到 **14.25** 才转立体、立体档要跌回 **13.75** 才转足迹
 * ⇒ 那 10 次来回**一次都不重挑**（方案 §验收 5）。代价是"可见性↔数据"最多差 0.25 zoom
 * （方案 §2 表已如实写明那一档），这是机主批过的取舍。
 */
export const WS_BLD_TIER_HYSTERESIS = 0.25;

/**
 * 🌆 **足迹档 / 立体档 的档位号**（`0` = 足迹 z<14 · `1` = 立体 z≥14 · `null` = **数不出来**）。
 *
 * 🔴 **全项目只有这一份判据**（宿主/页面都调它，不许各自写 `z < 14`）：
 *   · 三态纪律：`null` 表示"zoom 读不出来"，**不是** 0（0 = 确定在足迹档）；
 *     判据与 `bldMaxDrawnFor` 逐字同式（`typeof === "number"` 且有限）——
 *     `Number(null) === 0` 那种猜法会把"没测出来"当成"确定在足迹档"。
 *   · `prevTier` = **上一次落图**用的档位（`0`/`1`/`null`）；给了就带 `WS_BLD_TIER_HYSTERESIS`
 *     滞回。**上一次是哪一档由宿主存**（本模块无状态、纯函数）。
 *
 * @param zoom     当前 zoom（由宿主在**挑楼那一刻**现读 `map.getZoom()`）
 * @param prevTier 上一次落图的档位；不给/给坏值 ⇒ 按裸阈值判（= 改造前的行为）
 */
export function bldTierOfZoom(zoom: unknown, prevTier?: number | null): number | null {
  const v = typeof zoom === "number" && isFinite(zoom) ? zoom : NaN;
  if (!isFinite(v)) return null;
  const line = WS_BLD_FOOTPRINT_MAXZOOM;
  if (prevTier === 0) return v < line + WS_BLD_TIER_HYSTERESIS ? 0 : 1;
  if (prevTier === 1) return v < line - WS_BLD_TIER_HYSTERESIS ? 0 : 1;
  return v < line ? 0 : 1;
}

/**
 * 档位 → 栋数上限（**唯一映射处**，页面/App/自检都调它，不许各写一套 `mode === "many" ? … : …`）。
 *
 * @param mode 档位；**认不出来的值（含 `undefined`/`null`/对象/数字）一律按默认严格档** ——
 *             坏数据退回默认与 `wsRelation.ts`/`wsDailyStore.ts` 同一口径（绝不抛）。
 */
export function bldMaxDrawnOf(mode: unknown): number {
  return mode === "many" ? WS_BLD_MAX_DRAWN_MANY : WS_BLD_MAX_DRAWN;
}

/**
 * 🏙🌆 **档位 × zoom → 栋数上限**（2026-10-03「按 zoom 分层」的**新入口**；`bldMaxDrawnOf` 是老入口，保留）。
 *
 * | 输入 | 结果 | 为什么 |
 * |---|---|---|
 * | `mode === "many"`（任意 zoom） | `WS_BLD_MAX_DRAWN_MANY`（4000） | 用户明确开了"多楼房模式" ⇒ **全 zoom 一致**，不替他分档 |
 * | 其它档 + **足迹档**（`z < 14`，带 0.25 滞回） | `bldStaticTopK()`（**200**） | 🆕 2026-10-03 第四条：低缩放改按**静态重要度取前 K**（方案 §4 ⒝）——不再是"宽档 4000"（那正是"地毯"） |
 * | 其它档 + 立体档（`z ≥ 14`） | `WS_BLD_MAX_DRAWN`（100） | **立体严格档**：一栋几百 px²，100 栋一眼数得清 |
 * | 其它档 + `zoom` 读不出来 | `WS_BLD_MAX_DRAWN`（100） | **宁可少画，不许乱画**（缺省=严格档，与 `maxDrawn` 的默认同一口径） |
 *
 * ⚠️ 它是**纯函数**：不读地图/`window`/`localStorage` —— zoom 由宿主在**挑楼那一刻**现读
 * （`map.getZoom()`）传进来，否则用户在缩放后切档会用到旧 zoom（"点了没反应"那一类）。
 * ⚠️ **多楼房模式那一支仍然排在最前面**（`z<14` 也是 4000 = 用户明确要的那一档）：
 *    他点开的就是"不推荐的多"，不替他分档 —— 变的只是**挑法**（静态分，见 `pickBuildingsByBudget`）。
 * ⚠️ 足迹档**不是"没有上限"**：两个代价预算（Σ投影 px² / Σ顶点）与它同时生效（见文件头）。
 *
 * @param mode 用户档位（`"many"` / 其它；归一规则与 `bldMaxDrawnOf` 完全相同，只有一份）
 * @param zoom 当前 zoom（**非有限数/非数** ⇒ 按严格档 —— `null`/`undefined`/`NaN` 都算读不出来，
 *             注意 `null < 14` 在 JS 里是 `true`，所以**必须**先判有限性，不能直接比大小）
 * @param prevTier 🆕 上一次落图的形体档（`bldTierOfZoom` 的返回值）；给了就走 0.25 滞回
 */
export function bldMaxDrawnFor(mode: unknown, zoom: unknown, prevTier?: number | null): number {
  /* 多楼房模式：全 zoom 一致（复用 `bldMaxDrawnOf` ⇒ `mode === "many"` 这个判据只有一份） */
  if (bldMaxDrawnOf(mode) === WS_BLD_MAX_DRAWN_MANY) return WS_BLD_MAX_DRAWN_MANY;
  const tier = bldTierOfZoom(zoom, prevTier);
  if (tier === null) return WS_BLD_MAX_DRAWN;
  return tier === 0 ? bldStaticTopK() : WS_BLD_MAX_DRAWN;
}

/** 每段墙固定 4 个顶点（MapLibre `fill_extrusion_bucket` 的 `prepareSegment(4, …)` + 4×`addVertex`） */
export const WS_BLD_VERTS_PER_SEGMENT = 4;

/**
 * 一栋楼的**三角化顶点数**（官方源码口径）：每段墙 4 顶点 + 屋顶每个轮廓点 1 个。
 *
 * @param ringPoints **闭合环的点数**（GeoJSON 首尾同点，所以 4 边形是 5）
 * @returns 顶点数；点太少（<4，不构成面）⇒ 0
 */
export function bldRingVertices(ringPoints: number): number {
  const n = Number(ringPoints);
  if (!isFinite(n) || n < 4) return 0;
  /* 闭合环的最后一点与首点重合 ⇒ 真正的"轮廓顶点"是 n−1 个：
     墙 = (n−1) 段 × 4 顶点、屋顶 = (n−1) 个顶点 ⇒ 5(n−1)。
     对 4 边形：5×4 = **20**，与外部取经里"一栋 4 顶点长方楼 ≈ 20 顶点"逐字对上。 */
  return 5 * (n - 1);
}

/** Web Mercator：**1 CSS 像素代表多少米**（赤道 156543.03392 @ z0，随纬度按 cos 缩） */
export function bldMetersPerCssPixel(zoom: number, lat: number): number {
  const z = isFinite(zoom) ? zoom : 0;
  const la = isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
  return (156543.03392 * Math.cos((la * Math.PI) / 180)) / Math.pow(2, z);
}

/**
 * **竖直方向：1 米楼高 = 多少屏幕像素**（`sin(pitch)` 是俯角带来的压缩）。
 *
 * 为什么要有它：`map.project()` 是**地面**投影，不带高度 ⇒ 墙面的屏幕高度必须自己算。
 * 两页**必须同一把尺子**，所以公式只有这一份（页面经 vendor 调它）。
 */
export function bldPxPerMeter(zoom: number, lat: number, pitchDeg: number): number {
  const mpp = bldMetersPerCssPixel(zoom, lat);
  if (!(mpp > 0)) return 0;
  const p = isFinite(pitchDeg) ? Math.max(0, Math.min(85, pitchDeg)) : 0;
  return Math.sin((p * Math.PI) / 180) / mpp;
}

/** 宿主提供的**屏幕空间投影**（本模块不碰地图对象：纯函数才可离线测） */
export interface BldScreenCtx {
  /** 经纬度 → 屏幕 CSS 像素（宿主给 `map.project` 的包装） */
  project: (lng: number, lat: number) => [number, number];
  /** 1 米楼高 = 多少屏幕像素（`bldPxPerMeter(zoom, lat, pitch)`；页面/HUD 读数也用同一份） */
  pxPerMeter: number;
  /**
   * 🆕 **1 CSS 像素 = 多少米**（`bldMetersPerCssPixel(zoom, lat)`；只给**静态路**用）。
   *
   * 为什么要有它：静态路的全部意义就是"**`map.project()` 一次都不调**"（方案 §1③/§验收 1）
   * ⇒ 屏幕尺寸不能再逐点投影，只能用这把尺子换算（房顶 bbox 米数 ÷ 它 = 屏幕 px）。
   * 读数与相机无关的部分（房顶/墙的**面积**）仍然由它现算 —— 挑谁**不**受它影响。
   * 缺了/非正数 ⇒ 静态路的 px² 数不出来（如实记 `stats.staticMpp = 0` + 判词里写明），
   * **不会**偷偷退回投影路（那会把"0 投影"这条验收变成一句空话）。
   */
  metersPerPixel?: number;
}

/** 一个候选的一次成本测量结果（**中间量，导出给自检/回证用**） */
export interface BldCost {
  id: string;
  /** 屋顶投影面积（屏幕 bbox 面积，px²；保守上界） */
  roofPx: number;
  /** 可见墙面投影面积（px²）：半周长 × 墙高像素 —— 矩形的可见墙 ≈ 周长一半 */
  wallPx: number;
  /** 总投影面积（px²）= roofPx + wallPx */
  px: number;
  /** 顶点数（官方源码口径：5 × 轮廓点数） */
  verts: number;
  /** 轮廓点数（闭合环长度） */
  ringPoints: number;
  /** 渲染高度（`h3d`，米） */
  h3d: number;
}

/** 取要素的**外环**（后端只产 Polygon；拿不到 ⇒ null，绝不猜一个环出来） */
function outerRingOf(f: unknown): number[][] | null {
  const g = (f as { geometry?: { type?: string; coordinates?: unknown } } | null)?.geometry;
  if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = (g.coordinates as number[][][])[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}

/** 读 `h3d`（渲染高度）；没有 ⇒ 0（墙高 0 ⇒ 只算屋顶面积，**不猜高度**——伪造高度是项目红线） */
function h3dOf(f: unknown): number {
  const p = (f as { properties?: Record<string, unknown> } | null)?.properties || {};
  const h = Number(p.h3d);
  return isFinite(h) && h > 0 ? h : 0;
}

/** 第一个坐标点（外环取不到时的**兜底判视野**用；多边形之外的形状也认） */
function readFirstPoint(f: unknown): number[] | null {
  const c = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
  let cur: unknown = c;
  /* 一路下钻到第一个"两个数"的数组（Polygon / MultiPolygon / 其它都成立） */
  for (let i = 0; i < 6 && Array.isArray(cur); i++) {
    if (typeof cur[0] === "number" && typeof cur[1] === "number") return cur as number[];
    cur = cur[0];
  }
  return null;
}

/**
 * 🧮 **一栋楼的屏幕代价**（唯一的成本函数；挑楼与自检都调它，不许各算一套）。
 *
 * 口径：
 *  · 屋顶 = 投影后屏幕 **bbox 面积**（w×h）—— 对任意形状都是**保守上界**（真面积 ≤ bbox 面积）；
 *  · 墙 = **半周长 (w+h) × 墙高像素**（矩形可见墙 ≈ 周长一半；斜视角下墙面被压扁，取上界）；
 *  · 顶点 = `5 × 轮廓点数`（官方源码口径，见 `bldRingVertices`）。
 *
 * @param f          要素（Polygon）
 * @param ctx        屏幕投影上下文
 * @param [outCost]  可选：把中间量写出来（自检/回证用）
 * @returns 代价；**外环拿不到 ⇒ `null`**（调用方如实计"跳过"，不塞进预算里）
 */
export function bldScreenCost(f: unknown, ctx: BldScreenCtx, outCost?: { v?: BldCost }): BldCost | null {
  const ring = outerRingOf(f);
  if (!ring) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    let xy: [number, number];
    try { xy = ctx.project(lng, lat); } catch { continue; }
    const x = Number(xy[0]), y = Number(xy[1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return null; // 一个点都没投影出来
  const w = x1 - x0, h = y1 - y0;
  const h3d = h3dOf(f);
  const ppm = isFinite(ctx.pxPerMeter) && ctx.pxPerMeter > 0 ? ctx.pxPerMeter : 0;
  const roofPx = w * h;
  const wallPx = (w + h) * (h3d * ppm);
  const verts = bldRingVertices(ring.length);
  const cost: BldCost = {
    id: String((f as { id?: unknown } | null)?.id ?? ""),
    roofPx, wallPx, px: roofPx + wallPx, verts, ringPoints: ring.length, h3d,
  };
  if (outCost) outCost.v = cost;
  return cost;
}

/* ══ 🌆 **静态重要度**（低缩放 z<14 的唯一排序键；方案 `PLAN-BLD-LOWZOOM.md` §4 ⒝）════════
 * 🔴 **定义只有这一处**：`静态分 = 将要画的高度 h3d（米）× 脚印外环 bbox 面积（m²）`。
 *     · **与相机无关**：不含 zoom / 屏幕坐标 / pitch / 视野 —— 同一栋楼永远同一个分
 *       ⇒ 同一份 bounds 连调两次，排序后的 id 列表逐字节相同（方案 §验收 2）；
 *     · **不编高度**：`h3d` 优先读要素上已有的（已上妆的输入）；没有就用共享真源
 *       `wsBuildingLook.renderHeight()` 算出**同一个将要画的高度**（`dressBase` 写进 `h3d` 的
 *       就是它）—— 挑楼发生在"先挑后妆"的**挑**那一步，所以要素上还没有 `h3d`；
 *     · **按"同一栋楼"记忆化**（同一栋楼只算一次；z13 视野内近 3 万候选，逐轮全量重算是白工）。
 *       🔴 方案原文写的是"**按 `id` 记忆化**"，这里落成 **`WeakMap` 按要素对象**（同一件事，但更稳）：
 *         仓库里的同一栋楼**恒是同一个对象**（`createFeatureStore` 按 id 去重后保留引用，挑楼每轮
 *         拿到的就是那批对象）⇒ 记忆照样命中；而"同一个 id 换了形状"这种输入**不会**命中旧值
 *         （`id` 记忆表我实测撞过一次：自检里 `grid(6)` 与 `grid(100)` 的 `g000_000` 环长与首尾点
 *         完全相同、形状却不同 ⇒ 只按 id 会把旧形状的分数/顶点数喂给新形状）。
 *         `WeakMap` 还有两个好处：**不占内存**（对象被淘汰就自动释放）、对"没有 id 的要素"同样有效。
 *     · 米制换算用 `111320·cos(lat)` / `110540` —— 与 `wsDistrictScene.bldFootprintAreaM2`
 *       **同一对常数**（全项目只有那一份"经纬度→米"的口径，这里不另立）。
 */
const WS_BLD_M_PER_DEG_LNG = 111320;
const WS_BLD_M_PER_DEG_LAT = 110540;

/** 静态量（相机无关的那几个数）—— 记忆化的单位，也是"静态分"的可回证形状 */
export interface BldStaticMeasure {
  /** 🌆 静态分 = `h3d`（米）× 脚印 bbox 面积（m²）—— 唯一的排序键 */
  score: number;
  /** 脚印 bbox 的东西向米数 */
  wM: number;
  /** 脚印 bbox 的南北向米数 */
  hM: number;
  /** 将要画的渲染高度（米） */
  h3d: number;
  /** 闭合环点数（顶点预算按它算） */
  ringPoints: number;
}

/** 记忆表：**要素对象 → 静态量**（`WeakMap` ⇒ 仓库淘汰谁，这里跟着释放谁） */
const staticMemo = new WeakMap<object, BldStaticMeasure>();

/** 将要画的渲染高度（米）：要素上已有 `h3d` ⇒ 用它；否则走共享真源 `renderHeight()` */
function bldDrawHeightOf(f: unknown): number {
  const h = h3dOf(f);
  if (h > 0) return h;
  try {
    const r = renderHeight((f as { properties?: Record<string, unknown> } | null)?.properties);
    return r && isFinite(r.h) && r.h > 0 ? r.h : 0;
  } catch {
    return 0;
  }
}

/**
 * 🌆 **一栋楼的静态量**（唯一算法处）。
 *
 * @returns 外环取不到 ⇒ `null`（与 `bldScreenCost` 同一处置：调用方如实计 `noRing`，不塞进预算）
 */
export function bldStaticMeasureOf(f: unknown): BldStaticMeasure | null {
  const ring = outerRingOf(f);
  if (!ring) return null;
  const key = f as object | null;
  if (key && typeof key === "object") {
    const hit = staticMemo.get(key);
    if (hit) return hit;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, latSum = 0, n = 0;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (lng < x0) x0 = lng;
    if (lng > x1) x1 = lng;
    if (lat < y0) y0 = lat;
    if (lat > y1) y1 = lat;
    latSum += lat; n += 1;
  }
  if (!(x1 >= x0) || !(y1 >= y0) || n === 0) return null;
  /* 米制换算用环上纬度均值（与 `bldFootprintAreaM2` 同一口径：同一栋楼两处算出来的米数同阶） */
  const kx = WS_BLD_M_PER_DEG_LNG * Math.cos(((latSum / n) * Math.PI) / 180);
  const wM = (x1 - x0) * kx;
  const hM = (y1 - y0) * WS_BLD_M_PER_DEG_LAT;
  const h3d = bldDrawHeightOf(f);
  const m: BldStaticMeasure = { score: h3d * (wM * hM), wM, hM, h3d, ringPoints: ring.length };
  if (key && typeof key === "object") staticMemo.set(key, m);
  return m;
}

/**
 * 🌆 **静态分**（排序键；`h3d` × 脚印 bbox m²）—— 自检/回证读它，规则本体在 `bldStaticMeasureOf`。
 * 外环取不到 ⇒ `null`。
 */
export function bldStaticScoreOf(f: unknown): number | null {
  const m = bldStaticMeasureOf(f);
  return m ? m.score : null;
}

/**
 * 🌆 **静态路的代价**（**不投影**）：把记忆下来的米数，按 `metersPerPixel` 换成屏幕像素。
 *
 * 公式与 `bldScreenCost` **逐字同式**（屋顶 = w×h、墙 = (w+h)×墙高像素），
 * 只是 `w/h` 的来源从"逐点投影的 bbox"换成"米数 ÷ 米每像素" —— 同一把尺子、同一份口径。
 * `mpp ≤ 0`（宿主没给）⇒ 屏幕量数不出来：返回全 0 的代价（判词里如实写 `staticMpp = 0`）。
 */
function bldStaticScreenCost(m: BldStaticMeasure, id: string, mpp: number, pxPerMeter: number): BldCost {
  const canPx = isFinite(mpp) && mpp > 0;
  const w = canPx ? m.wM / mpp : 0;
  const h = canPx ? m.hM / mpp : 0;
  const ppm = isFinite(pxPerMeter) && pxPerMeter > 0 ? pxPerMeter : 0;
  const roofPx = w * h;
  const wallPx = (w + h) * (m.h3d * ppm);
  return {
    id, roofPx, wallPx, px: roofPx + wallPx,
    verts: bldRingVertices(m.ringPoints), ringPoints: m.ringPoints, h3d: m.h3d,
  };
}

/** 视野（与 `wsBuildingPick.PickBounds` 同形：只要这四个 getter，宿主给 `map.getBounds()` 即可） */
export interface BldBudgetBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/** 双预算挑楼的输入（**全部显式**，本模块不读 `window`/`location`/地图对象） */
export interface BldBudgetInput<T> {
  /** 仓库**全量**要素（含视野外）——"画面可以编，事实不许编" */
  features: readonly T[];
  /** 当前视野；不给 ⇒ 拿不到候选（统计里如实报 0 并说明） */
  bounds: BldBudgetBounds | null | undefined;
  /** 屏幕投影上下文（`project` + `pxPerMeter`） */
  screen: BldScreenCtx;
  /** 像素预算（默认 `WS_BLD_BUDGET_PX2`） */
  budgetPx2?: number;
  /** 顶点预算（默认 `WS_BLD_BUDGET_VERTS`） */
  budgetVerts?: number;
  /**
   * 🔴 **栋数硬上限**（默认 `WS_BLD_MAX_DRAWN` = 100，严格档）——第三个上限，与两个代价预算**同时**生效。
   * 档位由用户选（`bldMaxDrawnOf(mode)`），宿主把它的结果传进来；不传 = 严格档。
   */
  maxDrawn?: number;
  /** 视野内**至少**几栋（机主 2026-09-26：「视野内最少有十栋房」）；0 = 不启用 */
  minInView?: number;
  /**
   * 🌆 **形体档**（`bldTierOfZoom()` 的返回值：`0` = 足迹 z<14 / `1` = 立体 z≥14 / `null` = 读不出来）。
   *
   * 🆕 2026-10-03 第四条：**`0` ⇒ 走静态重要度那条路**（`map.project` 一次都不调 + 静态分排序，
   * 方案 §4 ⒝）；`1`/`null`/不给 ⇒ 走**原样**的投影路（`z ≥ 14` 的行为逐字节不变）。
   * 🔴 档位**由宿主用共享真源算**（`bldTierOfZoom(z, prevTier)`，含 0.25 滞回），
   *    这里不许再写一遍 `z < 14`（判据只有那一份）。
   */
  shapeTier?: number | null;
}

/** 双预算挑楼的统计（**HUD 与自检的唯一读数口**；字段全部是有限数/布尔/字符串） */
export interface BldBudgetStats {
  /** 仓库里一共有多少栋（事实口径） */
  total: number;
  /** 落在视野内、且有可用外环的候选数 */
  considered: number;
  /** 视野外的（如实计） */
  outOfView: number;
  /** 视野内但**没有外环**（不是 Polygon / 点数不足）⇒ 进不了成本模型的 */
  noRing: number;
  /** 挑中的栋数 */
  chosen: number;
  /** Σ投影面积（px²，取整） */
  px2: number;
  /** Σ顶点 */
  verts: number;
  /** 像素预算（常量，回证用） */
  px2Budget: number;
  /** 顶点预算（常量，回证用） */
  vertsBudget: number;
  /** 真是被**像素**预算拦住的（否则 false —— 不谎报"预算起作用了"） */
  px2Bound: boolean;
  /** 真是被**顶点**预算拦住的 */
  vertsBound: boolean;
  /**
   * 🆕 真是被**栋数上限**拦住的（否则 false —— 不谎报"上限起作用了"）。
   * 口径：挑选循环**到上限即停**时，后面还有没看过的候选 ⇒ true。
   * 若上限正好在最后一个候选上凑满（后面没货了），不算被拦住 —— 那个数照样画得出来。
   */
  countBound: boolean;
  /** 🆕 本轮的**栋数硬上限**（回证用：HUD 要能读出"这一屏是按 100 栋还是 4000 栋挑的"） */
  maxDrawn: number;
  /**
   * 🆕 本轮走的是不是**静态重要度**那条路（`shapeTier === 0` 的足迹档）——
   * HUD/自检回证用；`false` = 走投影路（`z ≥ 14` 或宿主没给档位）。
   */
  staticPick: boolean;
  /**
   * 🆕 静态路的**米每 CSS 像素**（`screen.metersPerPixel`）。
   * `0` = 宿主没给/给了坏值 ⇒ 静态路的 Σpx² **数不出来**（判词里如实写，不冒充 0 面积）。
   * 投影路恒 `0`（它不需要这个数）。
   */
  staticMpp: number;
  /** 视野下限（`minInView`） */
  minInView: number;
  /** 为了让视野内够 `minInView` 栋而**破例**补进来的栋数（0 = 没破例） */
  floorAdded: number;
  /**
   * 有没有**超出预算**。正常恒 false；只有一种情况会 true：
   * 视野内候选本身不足 `minInView` 栋之后的**兜底破例**（见 `floorAdded`）。
   * ⚠️ 如实报，不许把它藏进"应该是不会发生的"里。
   * ⚠️ 栋数上限**不在此列**：它任何时候都不破（`minInView` 的补齐也越不过它）。
   */
  overBudget: boolean;
  /** 人话判词（**只由本模块产出**，宿主不许再拼第二份） */
  why: string;
}

export interface BldBudgetOutcome<T> {
  /** 挑中的那批 —— **顺序 = 预算顺序**（不是入参顺序），可逐字节复现 */
  features: T[];
  stats: BldBudgetStats;
}

/**
 * 🏙 **双预算挑楼**（纯函数、无状态、确定性）。
 *
 * 规则（四条，缺一条就不是机主批的那个方案）：
 *  ① **候选 = 视野内全部楼**（不再有"每格 N 栋"）；
 *  ② 按「**单位顶点换到的像素**」降序取（`px/verts`；同值比 `px`，再同比 `id`）——
 *     这是外部取经里那句"按投影面积/顶点成本降序取"的落地：同样一个顶点预算，
 *     先保住**看起来最大**的那批；
 *  ③ 两个预算**都是固定常量**，任一超了就换下一个候选（不是停手：继续找还塞得下的小楼）。
 *     **绝不**按帧率/设备自动缩（机主红线）。
 *  ④ 🆕 **栋数硬上限 `maxDrawn`**（默认 100）：**到上限即停**（不是"跳过继续找"——
 *     个数上限的语义是"就画这么多"）。它与③的两个代价预算**同时**生效，谁也替不了谁。
 *
 * 视野下限（`minInView`）：预算扫完之后若不足，按同一顺序**破例补**到下限，并把
 * `floorAdded` / `overBudget` 如实写进统计 —— 机主 2026-09-26 的要求优先于预算，
 * 但**不许**因此谎报"预算成立"。
 * 🔴 **补齐也越不过 `maxDrawn`**（`minInView` 与 `maxDrawn` 打架时，以**先到**的那个为准）：
 *    栋数上限是"严格限制"这条命令本身，任何兜底都不许把它顶掉；
 *    因此真实结果可能是 `chosen < minInView` —— 那是**如实**的（`why` 里两个数都写着）。
 *
 * 🌆 **两条路，按 `shapeTier` 分**（2026-10-03 第四条）：
 *   · `shapeTier === 0`（足迹档 z<14）⇒ **静态路**：候选照筛，但代价由"米数 ÷ `metersPerPixel`"
 *     换算、排序键是**静态分**（`h3d` × 脚印 bbox m²，与相机无关）、`ctx.project` **一次都不调**；
 *   · 其它（立体档 z≥14 / 档位读不出来 / 宿主没给）⇒ **投影路**：与 2026-10-02 那版**逐字节相同**
 *     （`px/verts` 全序 + 两个预算 + 上限；`z ≥ 14` 的行为一个字节都没动）。
 *   两条路的**预算/上限/下限**判据完全共用（同一段贪心、同一份 `stats`），差别只在"排序键"与
 *   "屏幕量从哪来"这两处 —— 所以不存在"第二套挑楼规则"。
 */
export function pickBuildingsByBudget<T extends { id?: unknown }>(
  input: BldBudgetInput<T>
): BldBudgetOutcome<T> {
  const feats = input.features || [];
  const budgetPx2 = Number.isFinite(input.budgetPx2 as number) ? Number(input.budgetPx2) : WS_BLD_BUDGET_PX2;
  const budgetVerts = Number.isFinite(input.budgetVerts as number) ? Number(input.budgetVerts) : WS_BLD_BUDGET_VERTS;
  /* 栋数上限：**非有限数一律退回严格档**（不猜、不当作"无上限"——"没给"的语义是默认档，不是放开）。
     负数/0 照收：0 = 一栋不画（与 `?bldn=0` 同语义），负数等价 0（下面的循环自己会立刻停）。 */
  const maxDrawn = Number.isFinite(input.maxDrawn as number)
    ? Math.max(0, Math.floor(Number(input.maxDrawn)))
    : WS_BLD_MAX_DRAWN;
  const minInView = Number.isFinite(input.minInView as number) ? Math.max(0, Number(input.minInView)) : 0;
  const b = input.bounds;
  /* 🌆 静态路开关：形体档 `0`（足迹 z<14）⇒ **一次都不投影**（方案 §4 ⒝）。
     档位由宿主用共享真源 `bldTierOfZoom()` 算好传进来 —— 这里不写第二份 `z < 14`。 */
  const staticPick = input.shapeTier === 0;
  const mpp = staticPick && Number.isFinite(input.screen?.metersPerPixel as number)
    ? Number(input.screen!.metersPerPixel)
    : 0;
  const ppm = staticPick && Number.isFinite(input.screen?.pxPerMeter) && (input.screen!.pxPerMeter as number) > 0
    ? Number(input.screen!.pxPerMeter)
    : 0;

  const stats: BldBudgetStats = {
    total: feats.length, considered: 0, outOfView: 0, noRing: 0, chosen: 0,
    px2: 0, verts: 0, px2Budget: budgetPx2, vertsBudget: budgetVerts,
    px2Bound: false, vertsBound: false, countBound: false, maxDrawn,
    staticPick, staticMpp: mpp > 0 ? mpp : 0,
    minInView, floorAdded: 0, overBudget: false, why: "",
  };

  if (!b) {
    stats.why = "数不出来：没给视野（bounds），挑不出楼";
    return { features: [], stats };
  }
  let w: number, s: number, e: number, n: number;
  try {
    w = Number(b.getWest()); s = Number(b.getSouth()); e = Number(b.getEast()); n = Number(b.getNorth());
  } catch {
    stats.why = "数不出来：读视野失败（getBounds 抛错）";
    return { features: [], stats };
  }
  if (![w, s, e, n].every((v) => isFinite(v))) {
    stats.why = "数不出来：视野不是四个有限数";
    return { features: [], stats };
  }

  /* ① 筛候选（视野内 + 有外环 + 量得出代价）。**按入参顺序**遍历，结果与顺序无关（后面全序排序）
     🌆 静态路（`shapeTier === 0`）：判视野只比经纬度、代价由**米数 ÷ metersPerPixel** 换算
        ⇒ 这一整轮 `ctx.project` **一次都不调**（方案 §验收 1）。
     🔴 **上限 0 那一支在算代价之前就短路**（方案 §4 表：「`maxDrawn===0` 在扫候选之前短路」）：
        一栋不画 ⇒ 不必付投影/代价那笔钱；但**清点照做**（`outOfView`/`noRing`/`considered`
        仍如实报 —— "统计照报、不静默"是项目纪律，短路不该把它优化掉）。
        口径说明：这一支的 `considered` = "视野内 + 有外环"（**没算代价**）——与正常路只差
        "投影失败"那种极角落的情形（`map.project` 对合法经纬度不会失败）。 */
  type Cand = { f: T; c: BldCost; ratio: number };
  const cands: Cand[] = [];
  const zeroCap = maxDrawn === 0;
  for (const f of feats) {
    /* ⚠️ 先判视野、再判能不能算代价 —— 顺序反了会让视野外那些"没有外环"的要素被计进 `noRing`，
       而 `noRing` 的口径是"**视野内**但进不了成本模型的"，报错了等于判词撒谎。 */
    const ring = outerRingOf(f);
    const p0 = ring ? ring[0] : readFirstPoint(f);
    const inView = !!p0 && p0[0]! >= w && p0[0]! <= e && p0[1]! >= s && p0[1]! <= n;
    if (!inView) { stats.outOfView += 1; continue; }
    if (!ring) { stats.noRing += 1; continue; }
    if (zeroCap) { stats.considered += 1; continue; }
    if (staticPick) {
      const m = bldStaticMeasureOf(f);
      if (!m) { stats.noRing += 1; continue; }
      stats.considered += 1;
      const c = bldStaticScreenCost(m, String((f as { id?: unknown }).id ?? ""), mpp, ppm);
      /* `ratio` 这一栏在静态路装的是**静态分**（排序键），投影路装的是"单位顶点换到的像素" */
      cands.push({ f, c, ratio: m.score });
      continue;
    }
    const c = bldScreenCost(f, input.screen);
    if (!c) { stats.noRing += 1; continue; }
    stats.considered += 1;
    const denom = c.verts > 0 ? c.verts : 1;
    cands.push({ f, c, ratio: c.px / denom });
  }
  /* 上限 0 + 真有候选 ⇒ 与旧行为同判：**是"被栋数拦住"**（旧版是循环第一圈就 break，
     这里在扫候那时短路，判据合一）。真的一栋候选都没有 ⇒ false（不谎报上限起了作用）。 */
  if (zeroCap && stats.considered > 0) stats.countBound = true;

  /* ② 全序排序。
     投影路：单位顶点换到的像素降序 → 像素降序 → id 升序（第三键消除"等值不定序"）。
     🌆 静态路：**静态分降序 → id 升序** —— 排序键里没有相机量 ⇒ 同一份 bounds 连调两次
        得到的 id 列表逐字节相同（方案 §验收 2；换输入顺序也不变，因为它是全序）。 */
  cands.sort((A, B) => {
    if (B.ratio !== A.ratio) return B.ratio - A.ratio;
    if (!staticPick && B.c.px !== A.c.px) return B.c.px - A.c.px;
    return A.c.id < B.c.id ? -1 : A.c.id > B.c.id ? 1 : 0;
  });

  /* ③ 贪心填空：任一预算会超 ⇒ 跳过这个候选、继续找塞得下的小楼 */
  const chosen: Cand[] = [];
  const taken = new Array<boolean>(cands.length).fill(false);
  let sumPx = 0, sumV = 0;
  for (let i = 0; i < cands.length; i++) {
    /* ④ **栋数上限：到量即停**（放在循环最前面 ⇒ 一个候选都不多看，代价最小、也最容易看懂）。
       走到这一步就说明**手上还有没看过的候选**（`cands[i]` 自己就没看）⇒ 它是因为栋数上限
       才没被画的，如实记 `countBound`。反过来，若正好在最后一个候选上凑满，循环自然结束、
       不会走到这行 ⇒ 不算被拦住（那个数照样画得出来）。 */
    if (chosen.length >= maxDrawn) {
      stats.countBound = true;
      break;
    }
    const c = cands[i]!;
    const overPx = sumPx + c.c.px > budgetPx2;
    const overV = sumV + c.c.verts > budgetVerts;
    if (overPx || overV) {
      if (overPx) stats.px2Bound = true;
      if (overV) stats.vertsBound = true;
      continue;
    }
    taken[i] = true;
    chosen.push(c);
    sumPx += c.c.px;
    sumV += c.c.verts;
  }

  /* ⑤ 视野下限：不足 `minInView` ⇒ 按同一顺序破例补，并**如实记破例**
     🔴 **越不过 `maxDrawn`**（两个条件同时成立才补）：栋数上限是"严格限制"本身，
        视野下限这条兜底不许把它顶掉；真补不满就如实少画（`why` 里两个数都写着）。 */
  if (chosen.length < minInView) {
    for (let i = 0; i < cands.length && chosen.length < minInView && chosen.length < maxDrawn; i++) {
      if (taken[i]) continue;
      const c = cands[i]!;
      taken[i] = true;
      chosen.push(c);
      sumPx += c.c.px;
      sumV += c.c.verts;
      stats.floorAdded += 1;
    }
  }

  stats.chosen = chosen.length;
  stats.px2 = Math.round(sumPx);
  stats.verts = Math.round(sumV);
  stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;

  const bd: string[] = [];
  if (stats.px2Bound) bd.push("像素");
  if (stats.vertsBound) bd.push("顶点");
  /* 🆕「栋数」也进这一串：被个数上限拦住与被代价预算拦住**必须分得开**（机主要能一眼看出
     "这一屏是因为我设了 100 栋才只有 100 栋"，而不是"楼就这么少"）。 */
  if (stats.countBound) bd.push("栋数");
  stats.why =
    "视野内 " + stats.considered + " 栋（下限 " + minInView + "）⇒ 画 " + stats.chosen +
    " 栋 · Σ投影 " + stats.px2 + "px²/" + budgetPx2 + " · Σ顶点 " + stats.verts + "/" + budgetVerts +
    /* 🌆 静态路（z<14 足迹档）：**判词本体也由真源给**（页面直接把 `why` 显示出来，
       宿主不许再拼第二份）—— 写明"这一屏是按静态重要度取前 N 挑的、全程没投影"。 */
    (staticPick ? " · 静态重要度取前 " + maxDrawn + "（足迹档 z<14 · 与相机无关 · 0 次投影）" : "") +
    (staticPick && !(mpp > 0) ? " · ⚠️ 没给 metersPerPixel：px² 数不出来（只剩顶点预算在管）" : "") +
    (bd.length ? " · 预算拦住过：" + bd.join("+") : " · 两个预算都没咬住") +
    /* 🔴 人读口径的「上限 N 栋」**只在真被栋数拦住时**出现：不达上限时这一整条判词与
       "没有第三个上限"时**一字不差**（上面那条确定性纪律）。档位名（严格档/多楼房模式）
       由宿主加在最前面 —— 档位是**用户的选择**，不是挑楼规则的一部分。 */
    (stats.countBound ? " · 栋数上限 " + maxDrawn + " 栋" : "") +
    (stats.floorAdded ? " · 破例补 " + stats.floorAdded + " 栋（凑视野下限）" : "") +
    (stats.overBudget ? " · ⚠️ 已超预算（下限破例）" : "") +
    (stats.outOfView ? " · 视野外 " + stats.outOfView : "") +
    (stats.noRing ? " · 无外环 " + stats.noRing : "");

  return { features: chosen.map((c) => c.f), stats };
}
