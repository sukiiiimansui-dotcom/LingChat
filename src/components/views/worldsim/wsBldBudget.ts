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
 *   · `maxDrawn` = **栋数上限**，与两个代价预算**同时**生效、谁也替不了谁；
 *   · 默认档 `WS_BLD_MAX_DRAWN`（严格档）；用户自己开"多楼房模式"才用
 *     `WS_BLD_MAX_DRAWN_MANY`（不推荐，更卡）；
 *   · 档位是**用户的选择**（存 `localStorage`，见 `wsBldMode.ts`），**不是**按帧率/设备自动缩
 *     （机主红线：不许自动降级）。
 * ⚠️ **这一条的两个数后来被改过两次**（第三条按 zoom 分档 → 第五条按格取前 K）：
 *    现在的值见下面那两个 `export const` 的注释，**别照这段历史照抄数字**。
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
 * 机主的决定（原话意思）：「**z<14 画"足迹"（平面，看得见城市肌理）；z≥14 画立体**」
 * ⇒ **z=14 这条分界线（`WS_BLD_FOOTPRINT_MAXZOOM`）今天仍然有效，但它只管"画法"**
 *   （哪几条图层可见：足迹 `fill` ↔ 立体挤出；`bld-foot`/`bld-ext`/`bld-line` 的 min/maxzoom）。
 * 🔴 **"按 zoom 换栋数上限"（`bldMaxDrawnFor`）已在第五条里删除** —— 那是"集合随缩放变"的病根。
 * ⚠️ 两个**代价**预算（Σ投影 px² / Σ顶点）任何时候都同时生效（见文件头第五节）。
 * ⚠️ 这一层分档**只跟 zoom 走**：不读帧率、不读设备、不看候选多少（机主红线：不许自动降级）。
 *
 * ## 🆕 2026-10-03（第四条）· **低缩放改按「与相机无关的静态重要度」取前 K**
 * 方案：`world_map/PLAN-BLD-LOWZOOM.md`（机主已批准的**唯一方案**）§0 结论 / §2 量化表 / §4 ⒝。
 * 病根（方案 §1③）：低缩放每轮 flush 对**每个候选**逐点调 `map.project()`（z13 实测 **107,098 次**），
 * 且顶点预算被打满（39,995/40,000）⇒ 贪心落在背包边界，仓库每入库一格就换一批 + 整份 `setData`。
 * 做法：
 *   · 排序键换成**静态分** = `h3d`（渲染高度，米）× 脚印 bbox 面积（m²）——**不含任何相机量**，
 *     按要素对象记忆化（同一栋楼只算一次）；
 *   · 两个代价预算照旧兜底（px² 由 `metersPerPixel` 换算，**不投影**）；
 *   · 跨 14 加 `WS_BLD_TIER_HYSTERESIS`（0.25）滞回（`bldTierOfZoom`）。
 * ⚠️ `h3d` 在**挑楼那一刻**还没上妆（`flushBldStore` 是先挑后妆）⇒ 用共享真源
 *    `wsBuildingLook.renderHeight()` 算出**将要画的那个高度**（`dressBase` 写进 `h3d` 的就是它）
 *    —— 不是第二份口径，也不是"编高度"：同一个纯函数的同一份规则。
 * 🔴 **本条的"候选仍是视野内"已被第五条取代**（见下）——留在这里只为说明"第四条为什么还不够"。
 *
 * ## 🆕 2026-10-03（第五条）· **候选池改成「按离线包格取前 K」：与相机、与缩放全都无关**
 * 机主原话：「部分楼房在放大缩小过程中不断变化喵，能不能将楼房具体显示哪些**直接定下来**喵喵」。
 * 为什么第四条还不够：它只把**排序键**换成静态分，**候选池仍是"视野内"** ⇒ 一放大视野就变小、
 *   静态分前 K 名跟着重排 ⇒ **集合照样随相机变**（机主报的就是这一条）。
 * 第五条把候选池也钉在**数据**上（**这一处就是全部口径**）：
 *   · 候选池 = **按离线包格（cell）分组的、仓库里已经加载的楼**——**不做任何视野过滤**；
 *     `getBounds()` 只剩一个用处：**如实数**"其中多少在视野外"（`stats.outOfView`，`why` 里念出来），
 *     **一个候选都不因此被筛掉**；
 *   · 每格按静态重要度排**全序**（分↓ → id↑）取前 `K` 栋；
 *   · `K` **只有一处来源**（`WS_BLD_MAX_DRAWN` / `WS_BLD_MAX_DRAWN_MANY`，取值口 `bldMaxDrawnOf`），
 *     且**与 zoom、与形体档都无关** ⇒ 跨 z=14 **只换画法（足迹↔立体），不换集合**；
 *   · 输出顺序 = **格键升序**、格内按分序 ⇒ 同一批数据逐字节可复现；**新格加载只增加它自己那一段**，
 *     已选中的格一个字节都不动；
 *   · 顶点/像素预算仍是**安全闸**：拦下来的**如实计数**（`gateDropped` / `cellsCapped`）并写进判词，
 *     **不静默丢**。
 *
 * ### K = 3，是怎么算出来的（真包读数，不是拍的）
 * 量法：`node world_map/tools_bld_k_measure.mjs`（只读真包 `public/bldbundle-002`，格 0.01°）。
 * 典型视野 = **z13 · 1280×578 CSS**（16.62 m/px ⇒ 一屏 21.3km × 9.6km），中心 = 页面 `SPOT`：
 *   · 一屏覆盖 **230 格 / 80,050 栋**；
 *   · 按取数管道的同一套预算（计划 ≤150 格 · 每轮 16 格 / 1.5MB · 仓库上限 30,000 栋 ·
 *     保留半径 2.2×视野半对角线）**取满之后，仓库里是 30,000 栋 = 69~70 格**（密区里仓库上限先生效）；
 *   · 于是 `Σ_格 min(K, 该格已加载栋数)`：**K=2 ⇒ 138~140 · K=3 ⇒ 207~210 · K=4 ⇒ 276~280**。
 * ⇒ 取 **K = 3**（落在 100~300 的**中段**，且与改造前 z13 那个数 200 几乎相同 ⇒ 观感不跳）。
 *   K=4 已贴近上界 280，而"稀疏地带"格数还能涨到取数计划的上限（150 格 ⇒ K=4 = 600、K=3 = 450、
 *   K=2 才恒 ≤300）—— 上下界都写在这里，**谁改 K 谁先看这一段**。
 * 实测（`tools_bld_k_measure.mjs --cost`：**真包 + 真挑选函数**，不是模型估算）：
 *   · z13 · 取满 69 格（30,007 栋在库里）⇒ K=1 **69 栋** · K=2 **138 栋** · **K=3 207 栋** ·
 *     K=4 276 栋；K=3 那一档 **Σ顶点 15,775/40,000（39%）· Σpx² 11,811/400,000（3%）** ⇒
 *     两个安全闸**都没咬住**（拦住过：只有「每格上限」），顶点侧离打满（v95 的 39,995）很远；
 *   · z13 **首轮**（一次 moveend 只取 16 格）⇒ 48 栋；
 *   · z13.9 / z14.1 / z15 ⇒ 保留半径还罩得住那 69 格 ⇒ **同样 207 栋**（跨 14 **集合不变**）；
 *   · z16.4（保留半径 2.4km ⇒ 池 18 格）⇒ **54 栋**。
 * ⚠️ 与 v96 的差别是**有意的**：v96 的 z≥14 走"投影预算路 + 整屏 100 栋"、z<14 走"整屏前 200"，
 *    两条都会随相机变；现在**全档一条口径**（每格 K）⇒ z16.4 从 100 变成 ~54（少了，但**不再变**）。
 *
 * ### 三条不变式（`ws_bld_cap_selftest.mjs` 第 ⑩ 组逐条离线钉着）
 *   ① 同一批已加载数据 ⇒ 选中 id 列表在**任何**相机状态下（缩放 / 平移 / 旋转 / 倾角 / bounds 缺失）
 *      **逐字节相同**；
 *   ② **跨 z=14 只换画法、不换集合**（档位**不进**挑选函数 ⇒ 结构上不可能换集合）；
 *   ③ 新格加载只**增加**新格的选中项，已选中的格**不重排**（格键升序 + 每格独立取前 K）。
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
/* 🧮 **离线包格数学只有那一份**（`bundleCellOf` / `bundleCellKey` / 兜底格边长）：
   第五条的"按格取前 K"必须与取数管道、导出脚本**同一套格键**（`floor(x/size)*size` + `toFixed(5)`），
   否则"该格已经加载的楼"会被算成另一格 —— 本项目 2026-09-25 栽过一次"两套口径 ⇒ 把有数据说成没数据"。
   ⚠️ `wsFeatureStore` **不 import 任何东西**（实测）⇒ 不成环。 */
import { BLD_BUNDLE_CELL_DEG, bundleCellKey, bundleCellOf } from "./wsFeatureStore";

/** Σ投影面积预算（CSS 像素²）—— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_PX2 = 400_000;

/** Σ顶点预算 —— 见文件头"为什么是这个数" */
export const WS_BLD_BUDGET_VERTS = 40_000;

/**
 * 🏙 **严格档（默认）：每格取前几栋（K = 3）**。
 *
 * 🔴 2026-10-03 第五条起，这个数的语义是「**离线包格**（cell）的每格上限」——
 * 不再是"整屏最多画几栋"（那是会随相机变的口径，机主正是不许它变）。
 * 取值理由（真包读数、算法与命令见文件头「K = 3，是怎么算出来的」）：
 *   · 典型视野 z13 · 1280×578 ⇒ 取满后仓库 30,000 栋 = 69~70 格；
 *     `Σ_格 min(K, 该格栋数)`：K=2 ⇒ 138~140 · **K=3 ⇒ 207~210（取它）** · K=4 ⇒ 276~280；
 *   · 落在机主要的 **100~300** 区间中段，且与改造前 z13 画出来的 200 栋几乎相同（观感不跳）；
 *   · 稀疏地带格数能涨到取数计划的上限 150 格（那时 K=4 ⇒ 600、K=3 ⇒ 450、K=2 才恒 ≤300）——
 *     上界如实记在这里。
 */
export const WS_BLD_MAX_DRAWN = 3;

/**
 * 🚨 **多楼房模式（不推荐）**的每格上限：4000 栋/格。
 *
 * 语义（第五条起）：**每格**上限 = 4000 ⇒ 事实上**等于"不设每格上限"**
 * （真包里最密的格也就 ~1,000 栋）⇒ 这一档画的就是"仓库里已加载的楼，每格能画多少画多少"，
 * 真正的闸门是下面两个**代价预算**。
 * ⚠️ **不推荐**不是客套话：这个档位下框选/填充率/JS 侧上传都回到"几千个盒子"的量级，
 * 低 zoom 时尤其卡 —— UI 的 `title` 必须把这句话写出来（见 `WsCityEntry.vue`）。
 */
export const WS_BLD_MAX_DRAWN_MANY = 4000;

/**
 * 🆕 📍 **就近补齐的默认栋数（`nearK` = 10）** —— 2026-10-04 第六条。
 *
 * 机主原话（真机验收报的问题）：
 *   「为什么其他角色不见了喵，**放大到最大后楼就没了喵**」；追问后补充：
 *   「**将楼的位置固定啊喵（包括名字），保证地图上绝对有楼就行**，我是在楼不见后还缩小了看了的，还是没有楼喵」。
 * 根因（父代理用真浏览器探针量过，**不是猜**）：相机 38°~64° 俯角下"看得见的地面"只是**一条窄带**，
 *   而第五条那个挑选（每格静态前 K）**完全不看相机** ⇒ 画出去的 12 栋大多落在窗口外
 *   （z16.4 实测 12 栋锚点全在 932×557 窗口外），z19 更直接是**空集**（挑楼给出 0 栋 ⇒ `setData` 空集合）。
 * ⇒ 单开一层「**就近补齐**」：base 之后，把"离**相机中心**最近、又还没入选"的那几栋追加到结果尾部。
 *
 * **为什么是 10**：这不是新拍的数 —— 机主 2026-09-26 就拍过「**还要保证视野内最少有十栋房**」
 *   （那个 `WS_BLD_INVIEW_DEFAULT = 10` 现在还在 `wsBldPickStore.ts` 里当总量下限）。
 *   本常量与它**同量级同出处**，只是换成"按**相机中心**算距离"（旧那条下限不读相机 ⇒ 治不了这个病）。
 *   ⚠️ 两个 10 之间**没有 import 关系**（`wsBldPickStore` → 本模块，反向就成环）⇒ 只在这里写清出处。
 *
 * 🔴 **它不进冻结集**（与 `floorAdded` 同款）：冻结/确定性管的是 base，补齐件每轮按相机中心重算。
 */
export const WS_BLD_NEAR_K = 10;

/**
 * 🌆 **足迹档 / 立体档的分界线**（2026-10-03 机主真机验收后拍板）。
 *
 * `z < 14` ⇒ 画**足迹**（平面 `fill`，看得见城市肌理）· `z ≥ 14` ⇒ 画**立体**（挤出楼体）。
 * 🔴 第五条起它**只管画法**（哪几条图层可见），**不再影响"画哪些楼"**（集合与 zoom 无关）。
 * 为什么是 14：**它不是新定的数** —— 与既有的 `WS_BLD_DETAIL_ROOF_ZOOM`（女儿墙那一档）是
 * **同一条分界线**（机主 2026-10-02 点名 `<14` 平顶 / `14–16` 女儿墙）⇒ 这里**不再写第二个 14**，
 * 直接引用那一份（两边各写一份，改一处漏一处 —— 本项目栽过）。实测依据见文件头那张像素表：
 * z13 时一栋 30m 楼只有 1.8px（画立体=看不见），z14 有 3.6px（画立体=分得开）。
 */
export const WS_BLD_FOOTPRINT_MAXZOOM = WS_BLD_DETAIL_ROOF_ZOOM;

/**
 * 🌆 **跨 14 的滞回宽度**（zoom）—— 方案 `PLAN-BLD-LOWZOOM.md` §0/§4 ⒝ 的「0.25 滞回」。
 *
 * 病根（方案 §1c）：`tier !== bldFlushedTier` 就重挑 ⇒ 13.9↔14.1 来回 10 次就重挑 10 次。
 * 加上 0.25 之后：足迹档要涨到 **14.25** 才转立体、立体档要跌回 **13.75** 才转足迹
 * ⇒ 那 10 次来回**一次都不重挑**（方案 §验收 5）。代价是"可见性↔数据"最多差 0.25 zoom
 * （方案 §2 表已如实写明那一档），这是机主批过的取舍。
 * 🔴 第五条起它**只管画法**（哪几条图层可见）——挑选**不读档位**，所以滞回不可能换集合。
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
 * 🏙 **K 的唯一取值口**：档位 → **每格取前几栋**。
 *
 * 🔴 2026-10-03 第五条起它是**唯一的**入口 —— 原来那个"档位 × zoom"的第二入口
 *    （`bldMaxDrawnFor`）**已删除**：K 与 zoom/形体档无关，多一个入口就是多一处能漂的地方
 *    （机主要"集合定下来"，而"按 zoom 换 K"正是"集合随缩放变"的旧病根）。
 *
 * | 输入 | 结果 | 为什么 |
 * |---|---|---|
 * | `mode === "many"` | `WS_BLD_MAX_DRAWN_MANY`（4000/格） | 用户明确开了"多楼房模式" ⇒ 事实上不设每格上限（真闸是两个代价预算） |
 * | 其它一切（含 `undefined`/`null`/对象/数字/大小写不符） | `WS_BLD_MAX_DRAWN`（3/格） | **坏数据退回默认严格档**，与 `wsRelation.ts`/`wsDailyStore.ts` 同一口径（绝不抛） |
 *
 * ⚠️ 它是**纯函数**：不读地图/`window`/`localStorage`/zoom —— "每格几栋"这件事**只由用户的选择决定**。
 * ⚠️ 严格档**不是"整屏上限"**：整屏画几栋 = `Σ_格 min(K, 该格已加载栋数)`，
 *    典型视野的真包读数见文件头（z13 ⇒ 207 栋）。
 *
 * @param mode 档位（`"many"` / 其它；归一规则只有这一处）
 */
export function bldMaxDrawnOf(mode: unknown): number {
  return mode === "many" ? WS_BLD_MAX_DRAWN_MANY : WS_BLD_MAX_DRAWN;
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
  /**
   * 经纬度 → 屏幕 CSS 像素。
   *
   * 🔴 **2026-10-03 第五条起，挑楼一次都不调它**（"与相机无关"的可数证据：自检包一层计数 ⇒ 恒 0）。
   * 它在接口里留着有两个用处：① `bldScreenCost`（下面那个纯函数）仍用它算**投影代价**，
   * 自检/回证要拿它当"旧口径"的对照物；② 宿主照旧传 `map.project` 的包装 ——
   * 万一将来有谁要用，也不必改接线。**它不是死字段，但它不再是挑选的输入。**
   */
  project: (lng: number, lat: number) => [number, number];
  /** 1 米楼高 = 多少屏幕像素（`bldPxPerMeter(zoom, lat, pitch)`；页面/HUD 读数也用同一份） */
  pxPerMeter: number;
  /**
   * **1 CSS 像素 = 多少米**（`bldMetersPerCssPixel(zoom, lat)`）——挑楼的**唯一**屏幕尺子。
   *
   * 为什么要有它：候选池与排序键都与相机无关（第五条），屏幕量（px²）只用这把尺子换算
   * （米数 ÷ 它 = 屏幕 px）⇒ **`map.project()` 一次都不调**。
   * 缺了/非正数 ⇒ px² 数不出来（如实记 `stats.staticMpp = 0` + 判词里写明），
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
 * ⚠️ 2026-10-03 第五条起**挑楼不再走这一支**（它要逐点 `ctx.project`，那是"与相机无关"的反面）；
 *    它在挑选之后由**米数 ÷ `metersPerPixel`** 换算（`bldStaticScreenCost`，公式与这里逐字同式）。
 *    保留它是为了：① 自检拿它当**旧口径**的对照物（证明"变化是真的"）；② 宿主的 `screen.project`
 *    仍然有个公开的用武之地（`wsPageVendor` 也导出它）。
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
  /** 🆕 环顶点均值经度（**离线包格的分格依据**，见 `bldStaticMeasureOf` 的注释） */
  cLng: number;
  /** 🆕 环顶点均值纬度 */
  cLat: number;
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
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, latSum = 0, lngSum = 0, n = 0;
  for (const pt of ring) {
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (lng < x0) x0 = lng;
    if (lng > x1) x1 = lng;
    if (lat < y0) y0 = lat;
    if (lat > y1) y1 = lat;
    latSum += lat; lngSum += lng; n += 1;
  }
  if (!(x1 >= x0) || !(y1 >= y0) || n === 0) return null;
  /* 米制换算用环上纬度均值（与 `bldFootprintAreaM2` 同一口径：同一栋楼两处算出来的米数同阶） */
  const kx = WS_BLD_M_PER_DEG_LNG * Math.cos(((latSum / n) * Math.PI) / 180);
  const wM = (x1 - x0) * kx;
  const hM = (y1 - y0) * WS_BLD_M_PER_DEG_LAT;
  const h3d = bldDrawHeightOf(f);
  /* 🔴 **分格点 = 环顶点均值**（`cLng`/`cLat`）—— 与导出脚本 `export_bld_bundle.py` 的
     `centroid(ring)`（`sum(xs)/len(xs)`，用在**闭合环**上）**逐字同式**：
     离线包按它把楼分进 `<格>.json`，所以"该格已经加载的楼"才**真的是那一格文件里的楼**。
     ⚠️ 不用"首点"也不用"bbox 中心"：那两者与导出脚本不同 ⇒ 挑选的格与文件格错位，
     "按格取前 K"就退化成"按另一套网格取前 K"（本项目 2026-09-25 栽过两套格口径的坑）。 */
  const m: BldStaticMeasure = {
    score: h3d * (wM * hM), wM, hM, h3d, ringPoints: ring.length,
    cLng: lngSum / n, cLat: latSum / n,
  };
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
   * 🔴 **每格取前几栋（K）**（默认 `WS_BLD_MAX_DRAWN` = 3，严格档）——
   * 第五条起它是**每格**上限（不再是整屏上限）。档位由用户选（`bldMaxDrawnOf(mode)`），
   * 宿主把它的结果传进来；不传 = 严格档。
   */
  maxDrawn?: number;
  /**
   * 🧮 **离线包格边长（度）** —— 第五条"按格取前 K"的那张网格。
   *
   * 由宿主给**包自报**的 `index.json.cellSize`（`feed.facts().cellDeg`；页面/App 都是这一份）；
   * 不给 / 给坏值 ⇒ 退回 `BLD_BUNDLE_CELL_DEG`（0.05，老包那一个）。
   * 🔴 它**只决定"怎么分格"**，不决定"画多少"（画多少由 K × 格数决定）——
   *    而格数由**仓库里已经加载了哪些格**决定，与相机无关。
   */
  cellDeg?: number;
  /** **总量**下限（机主 2026-09-26：「视野内最少有十栋房」）；0 = 不启用。
   *  ⚠️ 第五条起它是**总量**下限（**不读视野**）—— 读视野的下限会随相机变，正是机主否掉的那类口径。 */
  minInView?: number;
  /**
   * 🆕 📍 **相机中心**（2026-10-04 第六条「就近补齐」的参照点）—— 宿主**每轮 pick 取一次**
   * （`map.getCenter()`；页面与 App 各一处接线，**不是每帧**）。
   *
   * 语义（三条，一条都不能少）：
   *   · **给了四个有限数** ⇒ 开启补齐：base 之后追加"离它最近、又还没入选"的 `nearK` 栋；
   *   · **没给 / `null`** ⇒ **老口径**（不补、判词一字不加）—— 与 `nearK: 0` **逐字节相同**，
   *     这是"关掉就回到改动前"的那条口子（自检两条判据都钉着：`nearK: 0` ⇔ `nearCenter: null`，
   *     以及"抠掉本功能源码的副本"逐字节对拍）；
   *   · **给了但不是有限数**（NaN / ±Infinity / 非对象）⇒ **数不出来**：判词明写原因，
   *     一栋都不补（**不许拿 0 冒充"补了 0 栋"**，也不许静默退回老口径）。
   *
   * ⚠️ 它**只进补齐件**：base（每格静态前 K / 排序 / 两个代价预算 / 总量下限）一个字节都不读它。
   */
  nearCenter?: { lng: number; lat: number } | null;
  /**
   * 🆕 **就近补齐的栋数**（默认 `WS_BLD_NEAR_K` = 10）。
   * `0` = **关闭补齐**（= 逐字段回到改动前的老口径）；坏值（NaN / 非数）⇒ 退回默认档，不猜。
   */
  nearK?: number;
}

/** 双预算挑楼的统计（**HUD 与自检的唯一读数口**；字段全部是有限数/布尔/字符串） */
export interface BldBudgetStats {
  /** 仓库里一共有多少栋（事实口径） */
  total: number;
  /** 🆕 仓库里**参与挑选的离线包格数**（有可用外环的格；"这一屏的楼来自哪些格"就看它） */
  cells: number;
  /** 🆕 真出了楼的格数（被 K 截掉之后仍有选中项的格；≤ `cells`） */
  cellsChosen: number;
  /** 🆕 真有选中项的格键（**格键升序**，与 `features` 的顺序同源；HUD/自检回证"哪些格"） */
  cellKeys: string[];
  /** 有可用外环、进了排序的候选数（**不再做视野过滤** ⇒ 它就是"仓库里能算分的那些"） */
  considered: number;
  /** 视野外的（**只如实计**，不影响挑选；`viewCounted=false` ⇒ 这一栏数不出来，见下） */
  outOfView: number;
  /**
   * 🆕 **视野计数可不可数**：`bounds` 给了且是四个有限数 ⇒ `true`；
   * 没给/给坏 ⇒ `false`（此时 `outOfView` 是 0 但**不是"视野外没有"**，是"数不出来"——
   * 判词里会写明，别把它读成 0）。
   */
  viewCounted: boolean;
  /** **没有外环**（不是 Polygon / 点数不足）⇒ 进不了成本模型的（如实计） */
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
   * 真是被**每格上限 K** 截过的（否则 false —— 不谎报"上限起作用了"）。
   * 口径：**任何一格**的可量候选数 > K ⇒ true（那一格的尾巴没被画，如实说）。
   */
  countBound: boolean;
  /** 🆕 被 K 截过的格数（`countBound` 的可数版本：HUD 要能读出"70 格里有 12 格被截"） */
  cellsCapped: number;
  /** 🆕 本轮的**每格上限 K**（回证用：HUD 要能读出"这一屏是按每格几栋挑的"） */
  maxDrawn: number;
  /** 🆕 本轮的**离线包格边长**（度；回证用） */
  cellDeg: number;
  /**
   * 🆕 **安全闸（两个代价预算）丢掉的候选数**——"不许静默丢"的落地：
   * 贪心里因 Σpx²/Σ顶点 塞不下而被跳过的**个数**（像素/顶点哪一边拦的都算，见 `px2Bound`/`vertsBound`）。
   */
  gateDropped: number;
  /**
   * 本轮的**米每 CSS 像素**（`screen.metersPerPixel`）。
   * `0` = 宿主没给/给了坏值 ⇒ Σpx² **数不出来**（判词里如实写，不冒充 0 面积），
   * 此时像素预算不咬（只剩顶点预算在管）。
   */
  staticMpp: number;
  /** **总量**下限（`minInView`） */
  minInView: number;
  /** 为了凑够下限而**破例**补进来的栋数（0 = 没破例） */
  floorAdded: number;
  /**
   * 🆕 📍 **就近补齐补了几栋**（本次，有限整数；关掉/没给相机中心 = 0）。
   * ⚠️ 它与 `floorAdded` **不是一回事**：`floorAdded` 凑的是"总量下限"（不读相机），
   *    它凑的是"**屏幕上得有楼**"（读相机中心，米制距离排序）——两个数各自如实报，不许合并。
   * ⚠️ 三态：**数不出来**时（相机中心给了但坏了）它仍是 0，而**判词**里写着"数不出来（原因）"
   *    （不许拿 0 冒充"量过了，附近没有"）。
   */
  nearAdded: number;
  /**
   * 🆕 补进去那批里**最远**一栋的地面米数（四舍五入）；没补 = `null`。
   * ⚠️ `null` 有两种含义，判词里会分开写：① 关掉/数量为 0（已量）；② 数不出来（给了坏中心）。
   */
  nearDistM: number | null;
  /**
   * 有没有**超出预算**。正常恒 false；只有一种情况会 true：
   * 候选本身不足 `minInView` 栋之后的**兜底破例**（见 `floorAdded`）。
   * ⚠️ 如实报，不许把它藏进"应该是不会发生的"里。
   * ⚠️ 每格上限 K **不在此列**：它任何时候都不破（下限补齐也先受它约束）。
   */
  overBudget: boolean;
  /** 人话判词（**只由本模块产出**，宿主不许再拼第二份） */
  why: string;
}

export interface BldBudgetOutcome<T> {
  /** 挑中的那批 —— **顺序 = 格键升序 × 格内静态分序**（不是入参顺序），可逐字节复现 */
  features: T[];
  stats: BldBudgetStats;
}

/**
 * 🏙 **按离线包格取前 K 栋**（纯函数、无状态、确定性）——**与相机、与缩放全都无关**。
 *
 * 规则（五条，缺一条就不是机主要的那条口径）：
 *  ① **候选池 = 仓库里已经加载的楼，按离线包格（`cellDeg`）分组** ——
 *     **不做任何视野过滤**（`bounds` 只用来如实数"其中多少在视野外"，一个候选都不因此被筛掉）；
 *  ② 每格按**静态重要度**排全序（分↓ → id↑）取前 `K`（= `maxDrawn`）；
 *     **静态分不含任何相机量**（`h3d` × 脚印 bbox m²，见 `bldStaticMeasureOf`）；
 *  ③ 输出顺序 = **格键升序**、格内按分序 ⇒ 同一批数据逐字节可复现，
 *     且**新格加载只增加它自己那一段**（已选中的格不重排）；
 *  ④ 两个**代价预算**（Σ投影 px² / Σ顶点）是**安全闸**：塞不下的**跳过并计数**
 *     （`gateDropped` + `px2Bound`/`vertsBound`），**不静默丢**；绝不按帧率/设备自动缩（机主红线）；
 *  ⑤ 总量下限（`minInView`）：扫完之后若不足，从**同一顺序**的剩余候选里**破例补**，
 *     并把 `floorAdded` / `overBudget` 如实写进统计。⚠️ 它**不读视野**（读视野会随相机变）。
 *
 * 🔴 **`screen.project` 一次都不会被调用**（屏幕量只用 `metersPerPixel` 换算）——
 *    这也是"与相机无关"的可数证据：自检里包一层计数，任何档位下都必须是 0。
 *    `bounds` 缺失**不再**让挑选变成空集（旧版会返回"数不出来：没给视野"）——
 *    候选池本来就不依赖它。
 */
export function pickBuildingsByBudget<T extends { id?: unknown }>(
  input: BldBudgetInput<T>
): BldBudgetOutcome<T> {
  const feats = input.features || [];
  const budgetPx2 = Number.isFinite(input.budgetPx2 as number) ? Number(input.budgetPx2) : WS_BLD_BUDGET_PX2;
  const budgetVerts = Number.isFinite(input.budgetVerts as number) ? Number(input.budgetVerts) : WS_BLD_BUDGET_VERTS;
  /* 每格上限 K：**非有限数一律退回严格档**（不猜、不当作"无上限"——"没给"的语义是默认档，不是放开）。
     负数/0 照收：0 = 一栋不画（与 `?bldn=0` 同语义），负数等价 0。 */
  const maxDrawn = Number.isFinite(input.maxDrawn as number)
    ? Math.max(0, Math.floor(Number(input.maxDrawn)))
    : WS_BLD_MAX_DRAWN;
  /* 离线包格边长：坏值/没给 ⇒ 退回老包那一个（`BLD_BUNDLE_CELL_DEG`，与取数管道同一份常量） */
  const cellDegIn = Number(input.cellDeg);
  const cellDeg = Number.isFinite(cellDegIn) && cellDegIn > 0 ? cellDegIn : BLD_BUNDLE_CELL_DEG;
  const minInView = Number.isFinite(input.minInView as number) ? Math.max(0, Number(input.minInView)) : 0;
  const b = input.bounds;
  /* 🌆 屏幕量的那把尺子（**不投影**）：米每 CSS 像素 + 1 米楼高几像素。
     坏值/没给 ⇒ px² **数不出来**（如实报 `staticMpp = 0`，判词里写明），绝不偷偷退回投影。 */
  const mpp = Number.isFinite(input.screen?.metersPerPixel as number) && (input.screen!.metersPerPixel as number) > 0
    ? Number(input.screen!.metersPerPixel)
    : 0;
  const ppm = Number.isFinite(input.screen?.pxPerMeter) && (input.screen!.pxPerMeter as number) > 0
    ? Number(input.screen!.pxPerMeter)
    : 0;

  const stats: BldBudgetStats = {
    total: feats.length, cells: 0, cellsChosen: 0, cellKeys: [],
    considered: 0, outOfView: 0, viewCounted: false, noRing: 0, chosen: 0,
    px2: 0, verts: 0, px2Budget: budgetPx2, vertsBudget: budgetVerts,
    px2Bound: false, vertsBound: false, countBound: false, cellsCapped: 0, maxDrawn,
    cellDeg, gateDropped: 0, staticMpp: mpp,
    minInView, floorAdded: 0, nearAdded: 0, nearDistM: null, overBudget: false, why: "",
  };

  /* 视野只用来**如实数**（不参与挑选）：给了且是四个有限数 ⇒ `viewCounted = true`。
     🔴 这里**没有**"没给视野就挑不出楼"那一支了 —— 候选池与视野无关（第五条）。 */
  let w = 0, s = 0, e = 0, n = 0;
  if (b) {
    try {
      w = Number(b.getWest()); s = Number(b.getSouth()); e = Number(b.getEast()); n = Number(b.getNorth());
      stats.viewCounted = [w, s, e, n].every((v) => isFinite(v));
    } catch {
      stats.viewCounted = false;      /* 读视野抛错 ⇒ "数不出来"，**不是**"视野外 0 栋" */
    }
  }

  /* ① 按**离线包格**分桶（格键与取数管道同一份格数学：`bundleCellOf` / `bundleCellKey`）。
     🌆 屏幕量全部由 `metersPerPixel` 换算（`ctx.project` **一次都不调**）。
     🔴 **上限 0 那一支在算代价之前短路**：一栋不画 ⇒ 不必付分格/算分那笔钱；
        但**清点照做**（`noRing`/`outOfView`/`considered` 仍如实报 —— "统计照报、不静默"是项目纪律）。 */
  type Cand = { f: T; c: BldCost; score: number; key: string };
  const byCell = new Map<string, Cand[]>();
  const zeroCap = maxDrawn === 0;
  for (const f of feats) {
    const ring = outerRingOf(f);
    /* 判视野用环首点（拿不到环就退回"第一个坐标点"的兜底）——**只计数**，一个候选都不筛 */
    const p0 = ring ? ring[0] : readFirstPoint(f);
    if (stats.viewCounted) {
      const inView = !!p0 && p0[0]! >= w && p0[0]! <= e && p0[1]! >= s && p0[1]! <= n;
      if (!inView) stats.outOfView += 1;
    }
    if (!ring) { stats.noRing += 1; continue; }
    if (zeroCap) { stats.considered += 1; continue; }
    const m = bldStaticMeasureOf(f);
    if (!m) { stats.noRing += 1; continue; }
    stats.considered += 1;
    const id = String((f as { id?: unknown }).id ?? "");
    const cell = bundleCellOf(m.cLng, m.cLat, cellDeg);
    const key = bundleCellKey(cell.w, cell.s, cellDeg);
    const cand: Cand = { f, c: bldStaticScreenCost(m, id, mpp, ppm), score: m.score, key };
    const arr = byCell.get(key);
    if (arr) arr.push(cand); else byCell.set(key, [cand]);
  }
  /* 上限 0 + 真有候选 ⇒ **是"被每格上限拦住"**（与旧行为同判）；一栋候选都没有 ⇒ false。 */
  if (zeroCap && stats.considered > 0) stats.countBound = true;

  /* ② 每格内部：**静态分降序 → id 升序**（全序 ⇒ 等值也有定序），取前 K。
     ⚠️ 排序键里**没有任何相机量**（`h3d` × 脚印 bbox m²，见 `bldStaticMeasureOf`）——
        这是"换相机不改集合"的根据。 */
  const cellKeys: string[] = [];
  for (const k of byCell.keys()) cellKeys.push(k);
  cellKeys.sort();                          /* 格键升序（键里是定长 `toFixed(5)` ⇒ 字典序 = 经纬序） */
  /** **全池**（顺序 = 格键升序 × 格内分序）—— 它同时决定"每格前 K"与"下限破例补"的先后 */
  const pool: Cand[] = [];
  /** `pool[i]` 是不是"每格前 K"里的一员（false = 只可能被下限破例补进来） */
  const inK: boolean[] = [];
  for (const k of cellKeys) {
    const arr = byCell.get(k)!;
    arr.sort((A, B) => (B.score !== A.score ? B.score - A.score : A.c.id < B.c.id ? -1 : A.c.id > B.c.id ? 1 : 0));
    if (arr.length > maxDrawn) { stats.countBound = true; stats.cellsCapped += 1; }
    for (let i = 0; i < arr.length; i++) { pool.push(arr[i]!); inK.push(i < maxDrawn); }
  }
  stats.cells = byCell.size;

  /* ③ 两个代价预算 = **安全闸**：塞不下的**跳过并如实计数**（`gateDropped`），不静默丢。
     ⚠️ 跳过而不是停手（老口径：继续找还塞得下的小楼）——顺序是**数据顺序**（格键 × 分），
        与相机无关 ⇒ 跳过谁也照样可复现。 */
  const chosen: Cand[] = [];
  const taken = new Array<boolean>(pool.length).fill(false);
  let sumPx = 0, sumV = 0;
  for (let i = 0; i < pool.length; i++) {
    if (!inK[i]) continue;                 /* 每格前 K 之外的不进主循环（只可能被下限破例补） */
    const c = pool[i]!;
    const overPx = sumPx + c.c.px > budgetPx2;
    const overV = sumV + c.c.verts > budgetVerts;
    if (overPx || overV) {
      if (overPx) stats.px2Bound = true;
      if (overV) stats.vertsBound = true;
      stats.gateDropped += 1;
      continue;
    }
    taken[i] = true;
    chosen.push(c);
    sumPx += c.c.px;
    sumV += c.c.verts;
  }

  /* ④ 总量下限：不足 `minInView` ⇒ 按**同一顺序**（格键 × 分）**破例补**（含"被安全闸跳过"与
     "每格 K 之外"的候选），并如实记 `floorAdded`（补进来的会超预算 ⇒ `overBudget` 也如实为 true）。
     🔴 它**不读视野**（读视野就会随相机变，正是机主否掉的那类口径）。
     ⚠️ 这是"总量 < 下限"的**唯一**一支例外：此时某些格会超过 K 栋（判词里 `floorAdded` 写着）。 */
  if (chosen.length < minInView) {
    for (let i = 0; i < pool.length && chosen.length < minInView; i++) {
      if (taken[i]) continue;
      const c = pool[i]!;
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
  /* 真出了楼的格键（顺序 = 格键升序 × 格内分序 ⇒ 首次出现序就是格键序） */
  {
    const seen = new Set<string>();
    for (const c of chosen) if (!seen.has(c.key)) { seen.add(c.key); stats.cellKeys.push(c.key); }
    stats.cellsChosen = stats.cellKeys.length;
  }

  const bd: string[] = [];
  if (stats.px2Bound) bd.push("像素");
  if (stats.vertsBound) bd.push("顶点");
  stats.why =
    "格 " + stats.cells + " 个" +
    (stats.cellKeys.length > 1
      ? "（" + stats.cellKeys[0] + " … " + stats.cellKeys[stats.cellKeys.length - 1] + "）"
      : (stats.cellKeys.length === 1 ? "（" + stats.cellKeys[0] + "）" : "")) +
    " ⇒ 画 " + stats.chosen + " 栋（" + stats.cellsChosen + " 格出楼）" +
    /* 🔴 口径自报家门（页面把 `why` 直接显示出来，宿主不许再拼第二份）：
       "每格取前 K、按静态重要度、**挑选**与相机无关、0 次投影"。
       ⚠️ 2026-10-04 第六条起措辞从「与相机/缩放无关」改成「**挑选与相机无关**」——
          因为同一轮里**新增了唯一一处读相机的东西**（就近补齐，见本函数末尾那一段），
          旧措辞在新口径下会变成假话。挑了哪些楼仍然与相机/缩放无关（base 的根据没变），
          变的是"base 之外还补了几栋离相机中心最近的"。 */
    " · 每格取前 " + maxDrawn + "（静态重要度 · 挑选与相机无关 · 0 次投影）" +
    /* 被 K 截过的格数如实报（"上限起作用了"要与"楼就这么少"分得开） */
    (stats.countBound ? " · 每格上限截过 " + stats.cellsCapped + " 格" : "") +
    " · Σ投影 " + stats.px2 + "px²/" + budgetPx2 + " · Σ顶点 " + stats.verts + "/" + budgetVerts +
    /* 安全闸：拦下来的**个数**也念出来（不许静默丢） */
    (bd.length ? " · 安全闸拦住过：" + bd.join("+") + "（跳过 " + stats.gateDropped + " 栋）" : " · 两个预算都没咬住") +
    (!(mpp > 0) ? " · ⚠️ 没给 metersPerPixel：px² 数不出来（只剩顶点预算在管）" : "") +
    (minInView ? " · 下限 " + minInView + " 栋" : "") +
    (stats.floorAdded ? " · 破例补 " + stats.floorAdded + " 栋（凑下限）" : "") +
    (stats.overBudget ? " · ⚠️ 已超预算（下限破例）" : "") +
    /* 视野：**只报不改**（数不出来时不写 0 冒充"视野外没有"） */
    (stats.viewCounted
      ? (stats.outOfView ? " · 视野外 " + stats.outOfView + "（不影响挑选）" : "")
      : " · 视野计数：数不出来（没给视野）") +
    (stats.noRing ? " · 无外环 " + stats.noRing : "");

  /* ══════════════ 🆕 📍 **就近补齐**（2026-10-04 第六条；机主「保证地图上绝对有楼」）══════════════
     上面那些**一个字都不改**：base（每格静态前 K → 格内全序 → 两个代价预算 → 总量下限）先照旧算完，
     这里只做一件事 —— 把「**离相机中心最近、又还没入选**」的 `nearK` 栋**追加到结果尾部**。

     为什么必须有它（父代理真浏览器探针量过的事实，不是推测）：相机 38°~64° 俯角下"看得见的地面"
     只是**一条窄带**，而上面那套挑选（静态重要度）**完全不看相机** ⇒ 挑出来的那 12 栋锚点
     在 z16.4 实测**全落在 932×557 窗口外**；z19（放大到最大）更直接给出**空集**（0 栋 ⇒ `setData` 空）。
     机主看到的就是"楼没了"，缩回去也还是看不到。

     🔴 三条纪律（缺一条就不是机主要的那个口径）：
       ① **不进冻结集**：它读相机 ⇒ 每轮重算（与 `floorAdded` 同款"补齐件永不冻结"）；
          base 那一段仍逐字节可复现（同数据 + 同用户档位 ⇒ 同一批，见第五条）；
       ② **不调 `map.project`**：距离是**纯算术**的地面米数（同一栋楼的静态量早就记忆在 WeakMap 里，
          分格点 `cLng/cLat` 就是它的代表点）—— 与"与相机无关"那条红线的唯一交汇点只是 `nearCenter` 这一个点；
       ③ **不静默、不冒充**：补了几栋 / 最远多少米如实报；数不出来（中心给了但坏了）就写"数不出来（原因）"，
          **不许写 0 冒充**；`nearK: 0` 或没给中心 ⇒ **判词一字不加**（逐字段回到改动前）。

     ⚠️ 排序键 = 「距离升序 → id 升序」：距离相同时靠 id 定序 ⇒ 不存在"等值不定序"（同一条确定性纪律）。
     ⚠️ 它是**破例**：补齐件直接入列、不过两个代价预算（否则"绝对有楼"会被预算一口否掉）——
        它们的像素/顶点**照实计进 Σ**，`overBudget` 也因此如实翻真，并在判词里写明是这一次破例。
     ⚠️ `maxDrawn === 0`（`?bldn=0` 那条 A/B 逃生口）⇒ **候选池是空的**，补齐件不复活它（判词写明原因）。 */
  /* ┄┄┄ 就近补齐 BEGIN（自检 `ws_bld_cap_selftest.mjs` 的影子对拍按这一对标记**整段抠除**：
         抠掉之后跑 `nearK: 0` 必须与带本段的 `nearK: 0` **逐字节相同** —— 那就是"关掉 = 回到改动前"的机器证明。
         ⇒ 本段之外**不许**依赖段内任何声明；段内也不许声明段外要用的东西。）┄┄┄ */
  {
    const nearKIn = input.nearK;
    const nearKOn = nearKIn === undefined || nearKIn === null
      ? WS_BLD_NEAR_K
      : (Number.isFinite(Number(nearKIn)) ? Math.max(0, Math.floor(Number(nearKIn))) : WS_BLD_NEAR_K);
    const nc = input.nearCenter as { lng?: unknown; lat?: unknown } | null | undefined;
    const ncGiven = !!nc && typeof nc === "object";
    const ncLng = ncGiven ? Number((nc as { lng?: unknown }).lng) : NaN;
    const ncLat = ncGiven ? Number((nc as { lat?: unknown }).lat) : NaN;
    const ncOk = ncGiven && isFinite(ncLng) && isFinite(ncLat);
    /* 三态（顺序即口径）：`nearK: 0` = 用户关掉（先说关）；没给中心 = 老口径；给了但坏 = 数不出来。 */
    if (nearKOn > 0 && ncGiven && !ncOk) {
      stats.why += " · 就近补齐：数不出来（相机中心不是有限数）";
    } else if (nearKOn > 0 && ncOk) {
      const cosLat = Math.cos((ncLat * Math.PI) / 180);
      const kx = WS_BLD_M_PER_DEG_LNG * (isFinite(cosLat) ? cosLat : 1);
      const cands: Array<{ cand: Cand; i: number; d: number }> = [];
      for (let i = 0; i < pool.length; i++) {
        if (taken[i]) continue;                       /* 已入选的不再补（判据：补齐件 = 尚未入选的那批） */
        const m2 = bldStaticMeasureOf(pool[i]!.f);
        if (!m2) continue;
        const dx = (m2.cLng - ncLng) * kx;
        const dy = (m2.cLat - ncLat) * WS_BLD_M_PER_DEG_LAT;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (!isFinite(d)) continue;
        cands.push({ cand: pool[i]!, i, d });
      }
      cands.sort((A, B) => (A.d !== B.d ? A.d - B.d : (A.cand.c.id < B.cand.c.id ? -1 : A.cand.c.id > B.cand.c.id ? 1 : 0)));
      const take = Math.min(nearKOn, cands.length);
      const overBefore = sumPx > budgetPx2 || sumV > budgetVerts;
      let farM = 0;
      for (let i = 0; i < take; i++) {
        const it = cands[i]!;
        taken[it.i] = true;
        chosen.push(it.cand);
        sumPx += it.cand.c.px;
        sumV += it.cand.c.verts;
        if (it.d > farM) farM = it.d;
      }
      stats.nearAdded = take;
      stats.nearDistM = take > 0 ? Math.round(farM) : null;
      if (take > 0) {
        /* 画出去的变了 ⇒ 那几个**可数**的字段全部跟着重算（不许留旧数：`chosen`/`px2`/`verts`/出楼格） */
        stats.chosen = chosen.length;
        stats.px2 = Math.round(sumPx);
        stats.verts = Math.round(sumV);
        stats.overBudget = sumPx > budgetPx2 || sumV > budgetVerts;
        const seen = new Set<string>();
        const keys: string[] = [];
        for (const c of chosen) if (!seen.has(c.key)) { seen.add(c.key); keys.push(c.key); }
        stats.cellKeys = keys;
        stats.cellsChosen = keys.length;
      }
      stats.why +=
        " · 就近补齐 " + take + " 栋（相机中心" +
        (take > 0 ? "，最远 " + stats.nearDistM + " m）" : (zeroCap ? "·每格上限 0 ⇒ 候选池为空，不复活）" : "·没有未入选的候选）")) +
        (!overBefore && stats.overBudget ? " · ⚠️ 已超预算（就近补齐破例）" : "");
    }
  }
  /* ┄┄┄ 就近补齐 END ┄┄┄ */

  return { features: chosen.map((c) => c.f), stats };
}
