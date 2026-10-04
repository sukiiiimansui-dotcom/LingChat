/* wsHudStats.ts —— M8：**HUD / stats**（`PLAN-REFACTOR.md` §2.1 的 M8 / §3 的 S3）。
 *
 * ## 这个文件收什么
 * 从宿主 `WsDistrictMapLibre.vue` **整块搬出来**的那些"屏幕上的数"（锚点 = 函数名，不按行号）：
 *   · `aiOn`（真数据够不够 ⇒ 要不要叠 AI 示意层）· `stats`（HUD 全部计数的**唯一真源**）
 *   · 长等待可视化的那一段状态与派生量：`STAGE_NAMES` / `waited` / `lastMs` / `t0` / `timer` /
 *     `stageIdx` / `waitText` / `waitSub` / `etaMs` / `progRatio` / `stopTimer`
 *   · `hudMode`（HUD 第一格的原话：`stats.mode` + 近景那一句）
 *   · 离线包那一行：`renderBundleHud` / `refreshBundles` / `attributionOfFeed`
 *   · `startFps`（帧率采样；`raf` 跟着一起搬，宿主卸载时调 `stopFps`）
 *
 * ## 搬迁纪律（这一片**零行为变化**）
 * 搬迁 = **移动 + 加签名**：分支、阈值、调用顺序、拼出来的每一句文案、DOM 契约
 * （`data-ws-*` / `ws-labs` / 各 `id`）**逐字不变**。所以下面每个函数体都是从宿主**逐字节**
 * 复制过来的（对拍闸 `ws_stage_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 为什么要 `createXxx(ctx)` 这个工厂，而不是 `fn(ctx, …)`
 * 这批函数/派生量**闭包着宿主的一堆 setup 期局部量**（`props` / `phase` / `bldFeed` / `gwLayer` /
 * `scheduleBundleHud` …）。若改成"每次调用都传 ctx"，函数体里每一处 `bldFeed.refresh(why)`
 * 都得改写成 `ctx.bldFeed.refresh(why)` —— 那就不再是"只搬不改"，而是顺手重构（本片禁止）。
 * ⇒ 依赖倒置的落法：**宿主构造一份只读 ctx 递进来，工厂在这里解构一次**，
 *    函数体于是**一个字都不用动**。ctx 的形状在 `wsStageTypes.ts`（L0.5，纯类型）。
 * ⚠️ 本模块**不许 import 宿主**（`PLAN-REFACTOR.md` §2.2 规则③）：只 import L0 叶子模块与 L0.5 类型。
 *
 * ## 🔴 为什么是**两个**工厂（S3 现场定的，不是设计洁癖）
 * `stats` / `aiOn` / `stopTimer` 三样**必须在 S2（M6 `wsFallback2d`）的装配点之前就存在** ——
 * 那个装配点在宿主 2800 行附近，它的只读 ctx 里就有这三样（2D 降级路要写 `stats.*`、读 `aiOn`、
 * 收尾调 `stopTimer`）。而离线包那半（`renderBundleHud` / `refreshBundles` / `attributionOfFeed`）
 * 要读的 `bldFeed` / `roadsFeed` / `placesFeed` / `gwLayer` / `fetchCell` 都声明在 3300 行之后
 * ⇒ 同一份 ctx 在 1250 行那次构造里**必然踩 TDZ**（本文件对 TDZ 有过前科，不靠"函数是惰性的"兜）。
 * 所以按**真实依赖时点**切成两半，两半都在本文件里（M8 仍是一个模块）：
 *   · `createHudStats` —— 早装配：stats / aiOn / 长等待 / fps；
 *   · `createBundleHud` —— 晚装配：`hudMode` + 包 HUD + 补格 + 署名取句。
 * `hudMode` 之所以落在晚的那一半：它读 `joyGate`，而 `joyGate` 在 M1（`wsMapCamera`）里，
 * M1 的装配点必须晚于 `labRootEl`（同样为了 TDZ）⇒ `hudMode` 与它同批（模板只在渲染时读它，
 * 声明晚一点**没有任何行为差别**）。
 *
 * ## 没搬的（照实留痕）
 * · `scheduleBundleHud`（脏标记 + 微任务的 HUD 去重器）**留在宿主**：它闭包宿主的 `bundleHudQueued`
 *   与 `alive` 两个 `let`，而 `alive` 只在渲染后读得准（参数会快照）。它调的就是本模块的
 *   `renderBundleHud`（**同一份实现**，不是第二份）。
 * · `loadBundleAttribution`（署名那一句的装配）留在宿主：它是"取句 + 写 `stats.attribution`"的
 *   宿主出口，取句逻辑（`attributionOfFeed`）在本模块。
 * · `K_MS`（localStorage 键名）留在宿主：宿主自己还在写它（`onMounted` 里记上次取数耗时），
 *   这里只按 ctx 只读读它。
 */

import { computed, reactive, ref } from "vue";
import { bldVerdictState, bundleCountsLine, loadBundleIndex, roadsVerdictState } from "./wsOfflineFeed";
import { bldVerdictText, roadsVerdictText } from "./wsScene";
import type { BldMapLike, BundleHudCtx, HudStatsCtx } from "./wsStageTypes";

/**
 * 装配 HUD/stats 的**前半**（早于 S2 的装配点 ⇒ 见文件头那段"为什么是两个工厂"）。
 * ⚠️ 位置必须在 `phase` / `WS_BLD_MODE` / `K_MS` / `BLD_SPARSE` 都声明之后。
 */
export function createHudStats(ctx: HudStatsCtx) {
  const { props, BLD_SPARSE, phase, WS_BLD_MODE, K_MS } = ctx;

  /**
   * 现在到底该不该画示意层。
   *
   * **唯一真源**：`stats.count`（= 上一次真的取回来的真楼栋数，`classify`/`dressBld` 里写的）
   * —— 不另开一个计数器，否则"HUD 说的"和"画的"迟早漂移。
   * 这样它天然满足"真数据优先"：真楼一到 40 栋，`aiOn` 自己变 false，
   * 下面的 watcher 会把已经画上去的图层**摘掉**（不是留着不管）。
   */
  const aiOn = computed(() => props.showAi || (props.aiAuto && stats.count < BLD_SPARSE));

  const stats = reactive({
    mode: "初始化…",
    count: 0,
    height: 0,
    levels: 0,
    default: 0,
    /** 🏷🗺 名字层那一行（**真源判词**：真名 N · 区名 M=数据驱动+示意 · **生成名上屏 0** · 点/格/D/模式）
     *  —— 三档**分开计数**，且"生成名上屏"恒为 0（机主拍板：生成名只进信息卡） */
    names: "",
    /** 🪪 信息卡：当前开着没有（探针读 DOM，不靠调试出口） */
    card: "",
    fps: 0,
    note: "",
    /** 等高线段数：>0 有效、0 还没画、-1 取不到（HUD 上如实显示） */
    contour: 0,
    /** 当前渲染的是**哪个区**（取自 `/api/geo_json` 的 properties.name，如"涪陵区"）—— 验证用 */
    area: "",
    /** 视野档：全区视野 / 街区视野（放大后才取楼栋） */
    view: "",
    /** 画在屏幕上的"人"的数量（WebGL 走地图库 Marker、2D 降级走 DOM；两个都算） */
    pins: 0,
    /** 👤 人的锚点从哪来（`视野兜底（无 adcode）` / `行政区 bbox`）；空 = 还没有锚点 */
    pinsAnchor: "",
    /** 👤 放不下人时的**原因原文**（三态里的"数不出来"；空 = 没这个问题） */
    pinsNote: "",
    /** 🛣 本视野**看得见**的路条数（口径与画法一致：按 zoom 过滤档位，见 `visibleRoadCount`） */
    roads: 0,
    /** 🛣 累积仓库那一行（可数：仓库 N 条 / 已取格 / 包外 / 失败）—— 与 HUD 同源 */
    roadStore: "",
    /** 🏢 离线楼房包那一行（`🏢 离线格 已取 x / 包外 y / 失败 z · 仓库 N 栋`） */
    bldBundle: "",
    /** 🏢 形体档：1 = 原始脚印（默认，与代拍页同源）· 2 = 拆件（`?bld=2`）—— 探针/回证要读它 */
    bldMode: 1,
    /** 🏢 拆件档拆出来几个要素（`ShapeCounts.parts`；默认档也会拆屋顶系 ⇒ 要素数 ≥ 栋数） */
    parts: 0,
    /** 🏙 **挑楼那一行**（真源 `wsBldBudget.stats.why`：视野内 N 栋 / Σ投影 px² / Σ顶点 / 谁拦住了；
     *  宿主在最前面加"现在哪一档形体（足迹/立体/多楼房）+ 栋数上限 + 有没有到上限"，见 `bldPickLine`）
     *  —— 机主在真机上判"卡不卡"时，这一行是**可数**那一半的证据（另一半是 fps） */
    bldPick: "",
    /** 🛣 离线路网包那一行（同式） */
    roadsBundle: "",
    /** 🏢 判词（**真源** `wsScene.bldVerdictText`：包外 / 取数失败 / 正常，三态不混） */
    bldVerdict: "",
    /** 🛣 判词（**真源** `wsScene.roadsVerdictText`；包外只在计数行里如实写） */
    roadsVerdict: "",
    /** 🔴 署名（**原句取自包里的 `index.json`**，不在这里重写第二版）—— ODbL 硬要求 */
    attribution: "",
    /** 🌊🌳 水/绿地那一行（**真源** `wsGwLayer.gwVerdictLine`：正数 / 0（已量）/ 数不出来，三态不混） */
    gwVerdict: "",
    /** 路网统计的一句话（主干几条 / 有几条有名字）—— 数据质量要看得见 */
    roadNote: "",
    /** 🏪 画在地图上的设施点（`/api/facilities` 的生活类 + 交通类） */
    facilities: 0,
    /** 设施统计的一句话（哪几类、共几个；缺的类如实说） */
    facNote: "", 
    /** 低档的原因（被**实际渲染路**压下来的，见 `wsPerf.forceLowTier`）。空串 = 没被压 */
    perf: "",
  });
  /* 🏢 形体档写进 stats：探针/HUD 要能读出"这一屏是默认档还是拆件档"（回证） */
  stats.bldMode = WS_BLD_MODE;

  /* ── 长等待可视化：三段**真实**阶段 + 已等秒数（机主 2026-09-19）────────────
     · `fetch` 是唯一的长尾（Overpass 现取，十秒到一分半都见过）；
     · `lastMs` = **上次同半径成功取数的真实耗时**（localStorage 记忆）——它是唯一
       有资格当"约还需"的数；没有它就**不画进度条**，只转等高线（不装确定）。 */
  /* ⚠️ 别写 `as const`：只读元组不能喂给 `WsLoading` 的 `stages?: string[]`（TS4104，已实测踩到） */
  const STAGE_NAMES: string[] = ["取真实楼栋", "整理数据", "画 2.5D"];
  const waited = ref(0);
  const lastMs = ref(0);
  const t0 = Date.now();
  let timer = 0;
  try {
    lastMs.value = Number(localStorage.getItem(K_MS) || 0) || 0;
  } catch {
    /* 隐私模式读不到就当没记录 */
  }
  const stageIdx = computed(() => {
    const i = STAGE_NAMES.indexOf(
      phase.value === "fetch" ? "取真实楼栋" : phase.value === "build" ? "整理数据" : "画 2.5D"
    );
    return Math.max(0, i);
  });
  const waitText = computed(() =>
    phase.value === "fetch" ? "正在取真实楼栋…" : phase.value === "build" ? "整理楼栋数据…" : "正在画 2.5D…"
  );
  const waitSub = computed(() => {
    const s = (waited.value / 1000).toFixed(1);
    if (phase.value === "fetch" && lastMs.value > 0) {
      return `已等 ${s}s · 上次 ${(lastMs.value / 1000).toFixed(1)}s（估算）`;
    }
    return `已等 ${s}s`;
  });
  const etaMs = computed(() => (phase.value === "fetch" && lastMs.value > 0 ? lastMs.value : undefined));
  const progRatio = computed(() => {
    if (phase.value !== "fetch" || lastMs.value <= 0) return undefined; // 没有分母 → 交给不确定态
    return Math.min(0.9, waited.value / lastMs.value);
  });
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }
  /**
   * 起那条"已等秒数"的心跳（**每 200ms 写一个 ref**）。
   *
   * ⚠️ 时点与原实现逐字相同：`t0` 是**装配那一刻**（不是挂载那一刻）——它和 `waited` / `timer`
   * 一起从宿主搬过来，宿主原来那句 `const t0 = Date.now()` 与本工厂的调用点是同一个 setup 阶段。
   */
  function armTimer(): void {
    timer = window.setInterval(() => {
      waited.value = Date.now() - t0;
    }, 200);
  }

  /** fps 的 rAF 句柄（**搬过来时是宿主的 `let raf`**；宿主卸载时改调 `stopFps()`，行为逐字相同） */
  let raf = 0;

  /**
   * fps 采样（滚动 1 秒窗口，与项目其它地方同一口径）。
   *
   * ⚠️ **必须在"分渲染路"之前启动**：以前它写在 WebGL 路的末尾 ⇒
   * 降级路（2D）的 HUD 永远显示 `0 fps`，看起来像"卡死了"，其实是没人在数。
   * 数字本身也更有意义 —— 它量的是**这个页面**的帧率，不是某条渲染路的。
   */
  function startFps(alive = ctx.aliveNow()): void {
    let last = performance.now();
    let frames = 0;
    let win = 0;
    const tick = (now: number) => {
      if (!alive) return;
      const dt = now - last;
      last = now;
      frames++;
      win += dt;
      if (win >= 1000) {
        stats.fps = Math.round((frames * 1000) / win);
        frames = 0;
        win = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  /** 停掉 fps 采样（宿主 `onBeforeUnmount` 调；原来那两句 `cancelAnimationFrame(raf)` 就是它） */
  function stopFps(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  return { aiOn, stats, STAGE_NAMES, waited, lastMs, stageIdx, waitText, waitSub, etaMs, progRatio, stopTimer, armTimer, startFps, stopFps };
}

/**
 * 装配 HUD/stats 的**后半**（晚于地图/离线包管道 ⇒ 见文件头那段"为什么是两个工厂"）。
 * ⚠️ 位置必须在 `bldFeed` / `roadsFeed` / `placesFeed` / `gwLayer` / `fetchCell` 与 M1 的 `joyGate`
 * 都声明之后（本片放在宿主 3800 行那一段：名字层的 ref 之后）。
 */
export function createBundleHud(ctx: BundleHudCtx) {
  const { stats, joyGate, bldFeed, roadsFeed, placesFeed, gwLayer, fetchCell, BLD_MIN_ZOOM, ROAD_MIN_ZOOM } = ctx;
  const { scheduleBundleHud } = ctx;

  /**
   * HUD **第一格的原话**：`stats.mode` + 近景那一句（文案由 `joyGateOf` 给，**唯一拼法**）。
   *
   * 为什么必须在屏幕上说出来：这一屏现在多了一层"角色第一视角"的观感，不说清楚，
   * 机主与探针都会把它当成"地图改坏了 / 变成街景了" —— 而它是**倾斜俯视的跟随**（不是实景）。
   * 2D 降级路写「2D 降级路没有相机，摇杆不适用」：摇杆不在 DOM 里，但**原因必须看得见**。
   */
  const hudMode = computed(() => `${stats.mode}${joyGate.value.hudNote ? " · " + joyGate.value.hudNote : ""}`);

  /** HUD/面板那一行（**可数口径只有一份**：`wsOfflineFeed.bundleCountsLine`）
   *  · `stats.bldBundle/roadsBundle` = 机主看的**可数一行**（已取/包外/失败 + 仓库数）；
   *  · `stats.bldVerdict/roadsVerdict` = **真源判词**（三态：包外 / 取数失败 / 正常；数不出来照实写）。 */
  function renderBundleHud(): void {
    const bf = bldFeed.facts();
    const rf = roadsFeed.facts();
    stats.bldBundle = bundleCountsLine(bf, "🏢", "栋");
    stats.roadsBundle = bundleCountsLine(rf, "🛣", "条");
    stats.bldVerdict = bldVerdictText({ state: bldVerdictState(bf), n: bf.n, cells: bf.have, cap: bf.cap });
    stats.roadsVerdict = roadsVerdictText({ state: roadsVerdictState(rf), n: rf.n });
  }

  /**
   * 按视野补离线格（**后台、串行、每格独立超时**；一次最多 2 格，不堵首屏）。
   * 楼/路/水绿各一条管道，三条互不阻塞；**都不打 `/api/*`**。
   */
  async function refreshBundles(why = "view", map = ctx.mapNow()): Promise<void> {
    const m = map as BldMapLike | null;
    if (!m) return; // 地图还没建（或 2D 降级路）⇒ 没有视野可算，管道如实不取
    const z = m.getZoom();
    /* 阈值与实时层对齐（楼 z≥13.5、路 z≥12）：整区视野下楼是亚像素，取它只是白花流量 */
    if (z >= BLD_MIN_ZOOM) await bldFeed.refresh(why);
    if (z >= ROAD_MIN_ZOOM) await roadsFeed.refresh(why);
    /* 🌊🌳 水/绿地**不设 zoom 闸门**（远景下它才最有用；判词由真源回填 `stats.gwVerdict`） */
    await gwLayer.refresh(why);
    /* 🏘 片区名**也不设 zoom 闸门**（切片③）：它是「我的家」的取名点，而家是**一进来就要有**的
       —— 开页若停在远景（z<13.5），有闸门就永远挑不到家（表现是 HUD 一直"数不出来"）。
       点很稀、包很小 ⇒ 代价可忽略；取到就进 `placesStore`，由 `placesFlush` 变成取值器的快照。 */
    await placesFeed.refresh(why);
    scheduleBundleHud();
  }

  /**
   * 📦 **取一个包的署名原句** —— **目录由 feed 的候选表决定**，这里不许自己拼路径。
   *
   * 🔴 2026-09-26 修的真 bug：这里原来三处**直连** `loadBundleIndex(fetchCell, kind)`（不传 dir）
   * ⇒ 它只用 `spec.dir`（**老包目录那一个**），而**页面走的是 feed 的候选表**
   * （`bldbundle-002` 细格包在前、退回 `bldbundle`）。
   * ⇒ 后果：**老包一删，App 会"署名取不到"而页面正常**（署名是 ODbL 合规项，不能少）。
   *
   * 现在：① 先读 feed 自己已经读到的索引事实（`facts().index.attribution`，它走的就是候选表，已读 ⇒ 零请求）；
   *      ② feed 还没读（首屏 `refreshBundles` 与署名是**并发**的）⇒ 按 **feed 给出的候选表**
   *         （`facts().dirs`）逐个目录试读 —— 顺序与 feed 完全一致，**不在这里写第二份目录名单**。
   */
  async function attributionOfFeed(
    feed: { facts(): { dirs?: string[]; index: { attribution: string | null } } },
    kind: string
  ): Promise<string> {
    try {
      const a = feed.facts().index.attribution;
      if (a) return a;
    } catch { /* 落 ② */ }
    let dirs: string[] = [];
    try { dirs = feed.facts().dirs || []; } catch { dirs = []; }
    for (const d of dirs) {
      try {
        const f = await loadBundleIndex(fetchCell, kind as never, d);
        const a = f.attribution || f.source;
        if (a) return a;
      } catch { /* 试下一个目录 */ }
    }
    return "";
  }

  return { hudMode, renderBundleHud, refreshBundles, attributionOfFeed };
}
