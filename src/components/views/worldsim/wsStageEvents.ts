/* wsStageEvents.ts —— S11：把宿主 `onMounted` 里那 13 处 `m.on(...)` 与它们的回调体整块搬出来。
 *
 * ## 这个文件是什么
 * `WsDistrictMapLibre.vue` 的 `onMounted` 里，建图之后有一整段**地图事件接线**。本片把那 13 处
 * `m.on(...)`（含回调体与贴在它们身上的注释）**整块**搬到这里，宿主只留 8 处调用：
 *   ① `registerPitchGuard`   `pitch`
 *   ② `registerMapErrors`    `error` ×2
 *   ③ `registerRenderFlag`   `render`
 *   ④ `registerMapLoad`      `load`（最大的一处）
 *   ⑤ `registerCameraMotion` `movestart` / `move` / `click`
 *   ⑥ `registerViewMoveEnd`  `moveend`
 *   ⑦ `registerViewZoomEnd`  `zoomend`
 *   ⑧ `registerPinEdge`      `move` / `moveend` / `zoom`（屏外方向指示）
 * 事件名与**注册顺序逐字不变**（闸里按 `m.on("x")` 序列机器化对拍）。
 *
 * ⚠️ 任务书 §0 写的是「14 处 `m.on(...)`」，实测（`d9d3a872`）是 **13 处** —— 它那张表本身也只列了
 *    13 行（`pitch` / `error`×2 / `render` / `load` / `movestart` / `move` / `click` / `moveend` /
 *    `zoomend` / `move` / `moveend` / `zoom`）。另有 2 处 `m.once("style.load" / "load")`，
 *    按纪律**留在宿主**（见下面「没搬的」）。
 *
 * ## 🔴 为什么拆成 8 个注册函数，而不是一个 `registerAll(m)`
 * 那 13 处注册**不是连着的**：它们中间夹着**必须按原顺序执行**的宿主代码 ——
 * `removeStrayCanvases()`、给 `m.addLayer`/`m.addSource` 套"样式没就绪就排队"的包装
 * （含 `m.once("style.load", flushPending)` / `m.once("load", flushPending)`）、`kickResize(m)`、
 * 以及看门狗那个 `window.setTimeout`。若把 13 处注册整串提前到这一段开头，`load` 上
 * **我们的监听器就会跑到 `flushPending` 前面**（`m.once` 是在原处先注册的）⇒ 补层的先后变了，
 * 图层次序也跟着变 —— 那就不是"零行为变化"了。⇒ 注册点与顺序**逐字留在原地**：
 * 宿主在原来的位置调这 8 个函数，函数内部再逐条 `m.on(...)`。
 *
 * ## 没搬的（照实留痕）
 * · `m.once("style.load", flushPending)` / `m.once("load", flushPending)` / `setTimeout(flushPending, 4000)`
 *   与那两个 `addLayer`/`addSource` 包装 —— **留在宿主**（本片只搬 `m.on(...)` 与回调体；
 *   它们与 `pendingStyleOps` 是同一块局部结构，搬进来就会把 `pendingStyleOps` 一起拖走）。
 * · `kickResize(m)` / `watchdog = window.setTimeout(...)` / `removeStrayCanvases()` / `applyPitchGuard(m)`
 *   —— 都不是 `m.on`，原地不动。看门狗那段长注释（讲 `watchdog` 的）也留在宿主（它讲的是宿主那段代码）。
 * · `m` 本身 —— 建图与销毁都在宿主；本模块只**按参数**收它，回调闭包着同一份引用。
 *
 * ## ctx 的落法与别名（逐类可数，闸里机器化）
 * 与 S2~S7 同一套：宿主构造只读 ctx → 本工厂开头解构一次 ⇒ 回调体除下面这些别名外一个字节不动。
 * ① `alive` → `aliveNow()`（**3 处**：`load` 的 `refreshBundles("init")` 那一句、`moveend`、`zoomend`）；
 * ② `joyActive` → `joyActiveNow()`（**8 处**：`movestart` / `move` / `click` / `moveend` / `zoomend`
 *    与屏外那三条）—— 它是宿主 `let`（`onBeforeUnmount` 也写它）⇒ 每处现读；
 * ③ `sawRender` → `setSawRender(true)`（**1 处写**；`m.on("render")` 是它唯一的写者）；
 * ④ `watchdog` → `watchdogNow()`（**1 处读**：`load` 里 `clearTimeout`；它先于注册被赋值，之后还会被重写）；
 * ⑤ `bldTimer` → `bldTimerNow()`（1 读）+ `setBldTimer(...)`（2 写，`moveend` 那个去抖）；
 * ⑥ `zoomNameTimer` → `zoomNameTimerNow()`（1 读）+ `setZoomNameTimer(...)`（2 写，`zoomend`）。
 *
 * 按值递进来的那几个是**已经定稿**的 `onMounted` 局部量：`fc` / `seat` / `districtBbox` /
 * `districtFeat` / `maplibregl`（都在 `try` 里赋完值、装配点之后再没人改）。
 * 它们走取值器反而更糟：`if (fc?.features?.length) { ... fc.features ... }` 那处靠 TS 的
 * **控制流窄化**，改成 `fcNow()` 之后窄化会丢（TS18047），就得往被搬走的正文里加一行
 * `const fc = fcNow();` —— 那是改名以外的改动。按值递进来，正文一个字都不用动，语义也完全相同。
 * ⚠️ 宿主 `onMounted:2036` 那条「这两个必须声明在 try 之外」指的就是 `districtFeat` / `districtBbox`：
 * 它们的归属**没变**（声明仍在宿主、仍在 try 之外）—— 搬走 `load` 回调之后，try 之外那个
 * 消费者从"回调里读它们"变成了"装配 ctx 时按值收它们"，所以那条注释的结论**照旧成立**；
 * 本片一个字都没改它（它字面上还写着 `m.on("load")`，那是搬迁后的陈旧指代，照实留痕）。
 *
 * ## 装配点
 * **在 `onMounted` 里**（`map = m;` 之后、第一次注册之前），不是 setup 作用域 ——
 * 因为 ctx 要按值收上面那五个 `onMounted` 局部量。宿主那面 `alive` / `joyActive` / `watchdog` /
 * `sawRender` / `bldTimer` / `zoomNameTimer` 是活状态 ⇒ 一律取值器/写入器（真源只有宿主一份）。
 * 依赖方向：本模块**不 import 宿主**，只 import `wsStageTypes` 的类型与 `wsOfflineFeed` 的一个要素类型。
 */
import type { BldMapLike, StageEventsCtx } from "./wsStageTypes";
import type { BundleBuildingFeature } from "./wsOfflineFeed";
export function createStageEvents(ctx: StageEventsCtx) {
  /* 解构出来的名字与宿主里原来的闭包变量**同名** ⇒ 下面这些回调体除别名之外一个字节都不用动
     （对拍闸 `ws_stageevents_move_selftest.mjs` 断言 diff = 0；别名逐类见文件头）。 */
  const {
    props, stats, phase, emit, mapErrs,
    fc, seat, districtBbox, districtFeat, maplibregl,
    initPitch, basePitch, joyGate,
    applyPitchGuard, onMoveStart, onMove, onMoveEndNames, onMapClick,
    reprojectNow, refreshNames, refreshBundles, stopTimer, syncPins, pinEdgeSync, pinEdgeMeasure,
    loadBuildingsForView, loadRoadsForView, loadFacilities, loadBundleAttribution,
    bldStore, bldFlush, bldTierCrossedFlush, bldLive, roadsLive,
    placesGetter, selfShotArmed, runSelfShot, maybeAppSelfShot,
    joyCalibrate, joyApplyRoam, joyReadCam, prevCamNow, setPrevCam, originNow, moveNow, scaleNow,
    roamStore, joyMeasureVh,
    aliveNow, joyActiveNow, setSawRender, watchdogNow,
    bldTimerNow, setBldTimer, zoomNameTimerNow, setZoomNameTimer,
  } = ctx;

  /** ① `pitch`：侧视角护栏每次改俯角重设一次（`applyPitchGuard` 的真源在 `wsScene`）。 */
  function registerPitchGuard(m: any): void {
    m.on("pitch", () => {
      applyPitchGuard(m);
    });
  }

  /** ② `error` ×2：一条写 HUD note（坏掉要看得见），一条只记不改（自检 JSON 要原文）。 */
  function registerMapErrors(m: any): void {
    /* 🔴 **必须有这个监听器**（2026-09-19 用一次真实事故换来的）：
       地图库的错误**不会**冒泡成 JS 异常 —— 样式校验失败时它只发一个 `error` 事件，
       然后 `load` **永远不触发**：底图不画、楼不画、连瓦片都不请求，
       屏幕上是一块**全透明的空画布**，而页面**零报错**（控制台也干干净净）。
       代拍回来的三张"纯白"就是这么来的（白 = α=0 的透明图）。
       ⇒ 把它接到 HUD 的 note 上：**坏掉要看得见**，而不是让人猜"是不是没做好"。 */
    m.on("error", (e: { error?: { message?: string } }) => {
      const msg = String(e?.error?.message || e || "").slice(0, 60);
      if (msg) stats.note = stats.note ? `${stats.note} · 地图库：${msg}` : `地图库报错：${msg}`;
    });
    /* 📊 **另挂一个只记不改的**（不动上面那条的语义）：`stats.note` 会被后来的写入覆盖，
       而样式自检 JSON 要的是"从头到现在一共报过哪些错"。最多留 20 条（自检包不灌水）。 */
    m.on("error", (e: { error?: { message?: string } }) => {
      const msg = String(e?.error?.message || e || "").slice(0, 160);
      if (msg && mapErrs.length < 20) mapErrs.push(msg);
    });
  }

  /** ③ `render`：真出过帧 ⇒ 看门狗"别只看时间"（唯一的写入点）。 */
  function registerRenderFlag(m: any): void {
    m.on("render", () => {
      setSawRender(true);
    });
  }

  /** ④ `load`：首帧之后的整条落地通路（这一处最大，注释逐条跟着搬）。 */
  function registerMapLoad(m: any): void {
    m.on("load", () => {
      /* 第一帧真的出来了 ⇒ 撤掉看门狗（它不是"超时就算失败"，是"到点还没好才算失败"） */
      window.clearTimeout(watchdogNow());
      if (fc?.features?.length) {
        /* `?live=1` 的首批（或老路径）：**并进同一个累积仓库**再 flush ——
           落图通路只有一条（`bldFlush` → 真源 `flushBldStore`），一次 `setData`，换视野不减。 */
        bldStore.merge(fc.features as unknown as BundleBuildingFeature[], "live:init");
        bldFlush("live+init");
        // 用真实楼房的范围收一下相机（取不到就保持默认中心）
        try {
          const b = new (maplibregl as unknown as { LngLatBounds: new () => unknown }).LngLatBounds();
          for (const f of (fc as { features?: Array<{ geometry?: { coordinates?: unknown } }> }).features || []) {
            const g = f.geometry || {};
            const walk = (v: unknown): void => {
              if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
                (b as { extend: (c: [number, number]) => void }).extend([v[0] as number, v[1] as number]);
              } else if (Array.isArray(v)) {
                for (const x of v) walk(x);
              }
            };
            walk(g.coordinates);
          }
          m.fitBounds(b as never, { padding: 24, pitch: initPitch.value, duration: 0 });
        } catch {
          /* 收不了相机就用默认视野，不影响可用性 */
        }
      }
      /* ④ **整区视野**：先按区县 bbox 铺满（"像省级地图一样显示整个区"）。
         楼栋在整区尺度上只是几个像素点，所以**放大到街区再取**（见下面的 moveend）。 */
      /* 🔴 默认视野 = **街道级 + 倾斜**（机主 2026-09-19：「这个小区怎么是 2d 的，我的 3d 建筑呢」）。
         之前我为了让"整区铺满"生效，一进来就 `fitBounds(整个区)`（zoom≈10）——
         那个缩放下楼栋是亚像素的，加上"放大到街区才取楼"的规则 ⇒ **一栋楼都看不见、看着就是 2D**。
         现在反过来：默认落在**区驻地**的街道级（zoom 15.2 + pitch），楼栋立刻可取 ⇒ 3D 马上可见；
         "看整个区"降级成右上角那个「全区」按钮（想广角时点一下）。 */
      if (seat || districtBbox) {
        try {
          const c: [number, number] = seat
            ? [seat.lng, seat.lat]
            : [(districtBbox![0] + districtBbox![2]) / 2, (districtBbox![1] + districtBbox![3]) / 2];
          /* 🔴 2026-09-19 再把默认缩放**推近一档**（15.2 → 16.4）。
             为什么：zoom 15.2 在手机横屏上**一眼 4km 宽**（分辨率约 3.6m/px），
             一栋 20m 的楼只有 5~6 个像素 —— 这不是"小区级"，是"城区全景"，
             而且取楼半径按视野算会落到 1.4km 上限，Overpass 更容易拖挂。
             16.4 ≈ 1.6m/px：同样的楼有 12~13 像素，成片的街区才真的"成片"。 */
          m.jumpTo({ center: c, zoom: 16.4, pitch: initPitch.value, bearing: 0 } as never);
          /* 🕹 **启动时摇杆就是开**（存储值/URL 显式打开）⇒ 把"没有摇杆时的机位"记下来：
             关了开关要**逐字还原**到这一份（俯角 = `basePitch`，不是 64）。
             ⚠️ 只有这一处能在建图期填快照：此刻相机已经是 64 了，现读只会读到"接管后"的值。 */
          if (props.joy) {
            setPrevCam({ center: [c[0], c[1]], zoom: 16.4, pitch: basePitch.value, bearing: 0 });
          }
          stats.mode = "街区视野（街道级）";
          stats.view = "街区视野";
          /* 🆕 建图这一刻就**主动取一次楼**（以前只靠 `moveend` 触发）。
             为什么必须补这一下：`jumpTo` 之后如果视野没变（或 moveend 在监听器挂上之前就发过了），
             `moveend` 根本不会来 ⇒ 屏幕上永远没有楼、HUD 永远 `🏢 0`。
             用户看到的是"这功能坏了"，而不是"还差一次移动"。 */
          void loadBuildingsForView(m as unknown as BldMapLike);
          void loadRoadsForView(m as unknown as BldMapLike); // 路网与楼并行取（互不阻塞）
          void loadFacilities(m as unknown as BldMapLike); // 设施一次就够（不随视野重取）
        } catch {
          /* 收不了相机就保持默认视野 */
        }
      } else {
        /* 🆕 2026-09-26（父代理批准的一行，**读数诚实**问题）：
           上面那段只在"给了 adcode"（有驻地/区界 bbox）时才跑，而**新入口 `/worldsim`
           故意不传 adcode**（城市数据按城市包来，没有"区县"这一级）⇒ `stats.mode` 会一直停在
           初值「初始化…」，尽管地图早就跑起来了（离线格/楼/水绿都在动）。
           用户与探针都会把「初始化…」读成"还没就绪" —— 那是一句**会骗人的读数**。
           这里如实换一句：默认机位、没有指定区县。**不改任何行为**（只是给读数赋值）。 */
        stats.mode = "默认机位（未指定区县）";
      }
      /* 🕹 **启动时摇杆就是开**（存储值/`?joy=1`）⇒ 记下"没有摇杆时的机位"，关了开关要逐字还原。
         上面那条分支（有驻地/区界 bbox）已经在 `jumpTo` 那行旁边填过快照了；这里是**兜底**：
         没有 bbox 时相机停在建图默认值上，center/zoom/bearing 现读即可（近景只改过俯角），
         `pitch` 用 `basePitch`（= 关着时该有的那个 38）。
         ⚠️ 读不齐就**不填**（`joyPrevCam` 留 null）⇒ 关闭时一次相机都不动 —— 宁可不动，也不编一个机位。 */
      if (props.joy && !prevCamNow()) {
        const cam0 = joyReadCam();
        if (cam0) setPrevCam({ ...cam0, pitch: basePitch.value });
      }
      /* 📍 **屏外方向指示的几何**（容器尺寸 + 四边安全区）在这里量一次 —— **与摇杆无关**
         （摇杆关着也照样要有"其他角色在哪"的指示），resize/转屏时在 `onWinResize()` 里重量。 */
      pinEdgeMeasure();
      /* 🕹 启动时摇杆就是开（存储值/`?joy=1`）⇒ 在这里把**漫游会话**也建起来，与运行期打开走同一条语义：
         ① `joyCalibrate()` 量「屏幕 px → 经纬度」（此刻俯角已经是 64 ⇒ 量的是近景那把尺子）；
         ② 位置真源 +「我」那颗钉子一起落到画面中心 —— 不这么做的话，"启动就开摇杆"这条路上
            `joyEnter()` 不会被调用（`watch` 只在**变化**时触发），标尺是空的 ⇒ 人推杆只有相机动、
            角色还是不动（同一句"太杂鱼"再犯一次）。
         ⚠️ 判据用 `joyGate.show`（= 摇杆到底在不在）而不是 `props.joy`：2D 降级路 DOM 里没有摇杆，
            那条路一个字都不许动（判据 9/10）。 */
      if (joyGate.value.show) {
        joyMeasureVh();     // 🕹 §15：底盘尺寸按容器高度定（建图这一刻量一次；resize 时再量）
        joyCalibrate();
        /* 🧱 S5（M5）：`joyOrigin` / `joyMove` 是摇杆会话自己的状态（已搬进 `wsJoystickStage.ts`）
           ⇒ 这里经那两个出口**现读**（`o0` 与 `moveNow()` 都是同一刻的值，与原实现逐字同序）。 */
        const o0 = originNow();
        if (o0) roamStore.write(o0.lng, o0.lat, moveNow().headingDeg);
        joyApplyRoam(moveNow());
      }
      /* 🗄 2026-09-24 已移除：区县边界（`dist-fill` / `dist-line`，"整区铺满"的可读性）。
         代拍页那一屏没有它；机主要"只留代拍页代码"⇒ 这一层不挂。
         `districtFeat` 仍然照旧取（相机中心/驻地/取楼半径都靠它），只是不再画边界。
         恢复：`git revert <本 commit>`。 */
      if (false && districtFeat) {
        try {
          m.addSource("dist", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [districtFeat] },
          });
          const below = m.getLayer("bld-ext") ? "bld-ext" : undefined;
          m.addLayer(
            { id: "dist-fill", type: "fill", source: "dist", paint: { "fill-color": "#79d9ff", "fill-opacity": 0.06 } },
            below
          );
          m.addLayer(
            {
              id: "dist-line",
              type: "line",
              source: "dist",
              paint: { "line-color": "#79d9ff", "line-width": 1.4, "line-opacity": 0.9 },
            },
            below
          );
        } catch {
          /* 画不上就算了：区界只是更好读，不该影响主流程 */
        }
      }

      /* 🗄 2026-09-24 机主裁定「App 页现在只准保留代拍页代码」⇒ 三样不再挂：
         ① **等高线**（`drawContours`，代拍页没有这一层）；② **AI 示意层**（`syncAiLayers`，
         楼栋稀疏时叠的暖色示意图元）；③ 下面的**区县边界**（`dist-fill`/`dist-line`）。
         ⚠️ `syncPins()` **保留**：它是地图上的人（`markers`），代拍页之外但属"同一屏"的地图图层，
            机主没点它；要停就传 `:markers="[]"`（`WorldSim` 那边一行的事）。
         恢复：`git revert <本 commit>`（备份 tag `attic/pre-sceneview2-20260924`）。 */
      syncPins();
      phase.value = "done";
      stopTimer();
      /* 🧱🏢🛣 **离线包首刷**（切片 A）：地图一就绪就按视野补格（后台、串行、每格独立超时）。
         放在 `phase=done` 之后 ⇒ **不阻塞首屏**（这正是治"加载慢"的那一刀：以前要等
         `/api/buildings` 十几秒到 91.7s，现在首屏一出来楼就一批批补进来）。
         ⚠️ 楼/路走同一条管道（`refreshBundles`），live 只在 `?live=1` 时另外打。
         🔴 2026-09-28 **删掉了一次重复调用**：这里原来先 `void refreshBundles("init")`，
         下一行又 `void refreshBundles("init").then(名字层)` —— 两次调用会让首屏的
         楼/路/水绿**每条管道多跑一整轮**（第二次撞上 feed 的 `busy` 守卫 ⇒ `queued=true`
         ⇒ 本轮结束后**再跑一轮 `runOnce`**；楼每轮还要吃 `BLD_BUNDLE_PER_REFRESH` 格预算）。
         名字层只需要**挂在第一份 promise 上**（下面那一行就是），不需要第二个 kick。
         ⇒ 现在只留下面那一行：**一轮取数 + 取完挂名字**。 */
      /* 🏷🗺 **名字层首刷**（与楼同一个道理：只挂 `moveend` 会"开页没有名字"——本项目栽过三次的
         「挂钩只在用户事件上 ⇒ 首屏空白」）⇒ 这里 kick 一次，成功即停、不常驻轮询。
         放在取包之后：先有楼（锚点只认**画出去的那批**），再挂名字。 */
      void refreshBundles("init").then(() => (aliveNow() ? refreshNames("init") : undefined));
      /* 🔴 署名（ODbL）**随数据一起显示**：句子取自包里的 `index.json`（导出脚本那句原话） */
      void loadBundleAttribution();
      /* 🎬 场景就绪 ⇒ 把地图与**真楼栋**交给外层（交通设施要用楼脚印；见 `emit` 的说明）。
         放在 `phase` 之后：这时 loading 已收起、楼体图层已 addLayer，外层加图层不会插进加载态。 */
      emit("scene-ready", {
        map: m,
        buildings: (fc as { features?: unknown[] } | null) || null,
        /* 🏠 切片③：把「我的家」的取名点取值器**一起**递出去（与楼栋同一次事件 —— 外层不必再取一遍） */
        places: placesGetter,
      });
      /* 代拍：`?autoshot=1` 开了开关才跑，没开就是一次 boolean 判断（零开销） */
      if (selfShotArmed()) void runSelfShot(m as unknown as Parameters<typeof runSelfShot>[0]);
      /* 🧪 App 自拍（`?selfshot=1`）：这是 **WebGL 路**的触发点（降级路的在 `fallback2d` 末尾） */
      maybeAppSelfShot("webgl");
      /* 🕹 标尺的**兜底量法**：极少数情况下建图那一刻容器还没排版（0×0 ⇒ `project`/`unproject`
         会给出非有限值），`joyCalibrate()` 会如实退回 `null`（⇒ 只有相机走、角色不动）。
         `load` 时版面已经有了 ⇒ 在这里补量一次。**只在还没量到时**才调（正常路径 0 次调用），
         而且同样**不在帧里** —— "移动中 0 次投影"那条红线不受影响。 */
      if (joyGate.value.show && !scaleNow()) {
        joyCalibrate();
        /* 🧱 S5（M5）：`joyOrigin` / `joyMove` 是摇杆会话自己的状态（已搬进 `wsJoystickStage.ts`）
           ⇒ 这里经那两个出口**现读**（`o0` 与 `moveNow()` 都是同一刻的值，与原实现逐字同序）。 */
        const o0 = originNow();
        if (o0) roamStore.write(o0.lng, o0.lat, moveNow().headingDeg);
        joyApplyRoam(moveNow());
      }
    });
  }

  /** ⑤ 相机运动那三条：`movestart` / `move` / `click`（摇杆期间一律早退）。 */
  function registerCameraMotion(m: any): void {
    /* 🏷🗺 **名字层的相机联动**（`DESIGN-MG-MOTION.md` §4.0/§4.2 —— 这一段的每一条都是红线）
       · `movestart`：容器加 `is-camera-moving`（**一次 class + 一次 opacity**，整层 1 → 0.25）；
       · `move`（每帧）：**只写 1 个容器**的 `translate3d`（跟手），N 个节点一个字都不写；
       · `moveend`：容器归零 + 节点位置**批量重排一次**（在 `refreshNames` 里）；
       · `click`：点楼体 ⇒ 与点名字**同一张卡**（`queryRenderedFeatures` 拿不到时走"最近已画楼"降级）。 */
    /* 🕹 **摇杆期间四个 handler 一律早退**（`joyActive` = 自持标志，见 `onJoyDrive` 那段）：
       `panBy({duration:0})` 每帧都会发一轮 movestart/move/moveend，不早退就是"每帧重投影 +
       每帧起一条 600ms 去抖 + 每帧重排标签"。跟手由 `joyNamesFollow()` 自己写**一个容器**，
       松手由 `onJoyHalt()` **恰好一次**重算 —— 判据 3/4/5/6 都钉在这里。 */
    m.on("movestart", () => { if (joyActiveNow()) return; onMoveStart(); });
    m.on("move", () => { if (joyActiveNow()) return; onMove(); });
    /* 移动中点击**丢弃**（不排队、不 `queryRenderedFeatures`）：相机在动，射线命中的楼已经移走，
       "点中"本身没意义；排队又会在松手时弹卡（判据 5）。 */
    m.on("click", (e: unknown) => {
      if (joyActiveNow()) return;
      onMapClick(e as { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } });
    });
  }

  /** ⑥ `moveend`：按需补数据（去抖 600ms）。 */
  function registerViewMoveEnd(m: any): void {
    /* 视野变化 → 按需补数据（去抖 600ms，避免拖动时把后端/磁盘打爆）。
       · **默认**：只补**离线格**（静态文件 ⇒ 不打 Overpass；换视野要素数**不减**：并进累积仓库）；
       · `?live=1`：另外走现场取数（楼/路各一条），失败照旧**可见**。 */
    m.on("moveend", () => {
      /* 🕹 摇杆推着的时候这一发是**每帧都有**的（`panBy({duration:0})` 每次都走完一轮 ease）
         ⇒ 必须早退：不早退就会"每帧重投影 + 每帧起一条 600ms 去抖 + 每帧重取离线包"。
         松手那一次重算归 `onJoyHalt()`（**恰好一次**）。 */
      if (joyActiveNow()) return;
      /* 🔴 容器位移**必须**在这里归零：节点自身马上要被写成新位置，容器再留着旧位移就是"错位"
         （机主真机报过的「名字显示是滑动刷新一次，不能跟随，**错位严重**」就是这一层没对齐）。 */
      onMoveEndNames();
      /* 🆕 2026-10-01 **就地重投影**（治机主说的"松手卡一下/弹回"）：
         容器刚归零，而节点还钉在**上一台相机**的坐标上 —— 原来要等 600ms 去抖 + 取包之后才重排，
         那 600ms 里整层是错位的（真因是"重投影排在了重排后面"，不是算得慢）。
         现在：`reproject()` **只重投影、不重排**（O(N)，N ≤ 26；集合/避让/上限/batch 一律不动）
         ⇒ 同一 tick 内 Vue 就把 transform 落下去（微任务先于下一帧绘制）⇒ 看不到跳变。
         ⚠️ 它**不替代** `refreshNames`：600ms 后那一轮仍照跑（该重算时重算、该增删时增删）。 */
      reprojectNow();
      if (bldTimerNow()) window.clearTimeout(bldTimerNow());
      setBldTimer(window.setTimeout(() => {
        setBldTimer(0);
        void refreshBundles("move").then(() => (aliveNow() ? refreshNames("move") : undefined));
        if (bldLive.live) void loadBuildingsForView(m as unknown as BldMapLike);
        if (roadsLive.live) void loadRoadsForView(m as unknown as BldMapLike);
      }, 600));
    });
  }

  /** ⑦ `zoomend`：重排 + 跨档重挑。 */
  function registerViewZoomEnd(m: any): void {
    /* 缩放结束也要重排：zoom 变了 ⇒ 避让网格的候选/撞掉**全变**（区名模式的迟滞信号就是它）
       🔴 2026-10-03 第三轮**必须加这一句早退**：摇杆拉近期间宿主每帧写一次 `easeTo({zoom})`
       （`onJoyDrive`），而 `duration: 0` 的 ease 会**同步**发一轮 zoomstart/zoom/zoomend
       （与 `panBy` 同一族，vendored 源码见判据 ⑧）⇒ 不早退的话，拉近的每一帧都会在这里
       跑一次 `reprojectNow()`（重投影）+ 起一个 160ms 的 `refreshNames("zoom")` + 可能一次
       `bldTierCrossedFlush()`（重挑楼）—— 正是判据 3/6 的"移动期间 0 次重投影 / 0 次重挑"那条红线。
       收尾那**一次**重算仍由 `onJoyHalt()` 在画面停稳之后做（那时 zoom 已经回到出发值）。 */
    m.on("zoomend", () => {
      if (joyActiveNow()) return;
      onMoveEndNames();
      /* 🆕 同 `moveend`：先**就地重投影**（缩放不是刚体平移，容器跟手只是近似），
         160ms 后那一轮 `refreshNames("zoom")` 照旧（跨档才重算，档内复用 —— 见 `wsNameLayer`）。 */
      reprojectNow();
      if (zoomNameTimerNow()) window.clearTimeout(zoomNameTimerNow());
      setZoomNameTimer(window.setTimeout(() => { setZoomNameTimer(0); if (aliveNow()) void refreshNames("zoom"); }, 160));
      /* 🌆 **跨过足迹/立体分界线 ⇒ 重挑一次**（走既有的 `bldFlush` 通路，见 `bldTierCrossedFlush`）：
         分界线两边画法与栋数上限都不同，不重挑就会一直按旧档画到下一次 `moveend`。 */
      bldTierCrossedFlush();
    });
  }

  /** ⑧ 屏外方向指示的三个相机钩子（单独一组，早退条件与上面逐字相同）。 */
  function registerPinEdge(m: any): void {
    /* ══ 📍 **屏外方向指示**的相机钩子（2026-10-04 第七条）════════════════════════════════
       为什么是**单独一组监听**而不是塞进上面那五个 handler：那五个是摇杆红线的判据对象
       （`ws_joystick_selftest.mjs` ⑦ 逐字钉着它们的形状），把新功能混进去会让"改一处、红一片"；
       单独注册一条，**早退条件与它们逐字相同**（`if (joyActive) return;`）⇒ 时点也完全相同。
       时点 = **相机事件**（不是 rAF、不是每帧循环）；写点数与开关见 `pinEdgeSync` 上方那段说明。
       ⚠️ 只挂 `move` / `moveend` / `zoom` 三个（`zoomend` **故意不挂** —— 它是摇杆那条"唯一入口"
         判据的对象，且 `zoom` 已经在跟了；多挂一条就是给那条红线添一个新的解释空间）。 */
    m.on("move", () => { if (joyActiveNow()) return; pinEdgeSync(); });
    m.on("moveend", () => { if (joyActiveNow()) return; pinEdgeSync(); });
    m.on("zoom", () => { if (joyActiveNow()) return; pinEdgeSync(); });
  }

  return {
    registerPitchGuard, registerMapErrors, registerRenderFlag, registerMapLoad,
    registerCameraMotion, registerViewMoveEnd, registerViewZoomEnd, registerPinEdge,
  };
}
