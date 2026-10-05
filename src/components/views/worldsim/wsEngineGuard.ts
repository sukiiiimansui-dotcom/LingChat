/* wsEngineGuard.ts —— S7（M9）：**引擎自愈 / 验证 / 自拍**（看门狗 / 画布事实 / resize 自证 /
 * WebGL 回切 / 代拍 · App 自拍 / 验证快照与面板）。
 *
 * ## 这个文件是什么
 * 从 `WsDistrictMapLibre.vue` **整块搬出来**的那一段（锚点 = **函数名 / 标识符**，不按行号）。
 * 按宿主里的先后搬了七段：
 *   ① `WATCHDOG_MS`（环境感知的看门狗期限）+ `watchdogFire`（到点如实降级 / 临时类留在后台等）；
 *   ② `recovered`（曾降级又恢复回 WebGL 了吗）；③ `RECOVER_MS` + `renderLimitSecs`；
 *   ④ `APP_SELF_SHOT_BUILD` + `DPR_CAP_2D`；⑤ `mapSeq` + `resizeLog` + `pushResizeLog`；
 *   ⑥ 画布那一族：`realMapCanvas` / `activeCanvas` / `canvasFacts` / `OVERLAY_CANVAS_HINTS` /
 *      `isOverlayCanvas` / `canvasFactsWithCover` / `removeStrayCanvases` / `hideStrayCanvases` /
 *      `wantCanvasSize` / `doResize` / `kickResize` / `onWinResize` / `forceResizeCanvas` / `dprCap2d`；
 *   ⑦ 自愈与证据那一族：`startRecoverPoll` / `promoteToWebgl` / `retryMap` / `runSelfShot` /
 *      `maybeAppSelfShot` / `appShotCtx` / `verifySnapshot` / `motionFacts` / `panelSnapshot` / `shootNow`。
 *
 * ## 没搬的（照实留痕；§1.4「迁不动的就别搬并写清理由」）
 * · `isAutomation`（Selenium/WebDriver 判定）—— **留在宿主**：M6（`createFallback2d`）在**装配那一刻**
 *   就同步调它（它用回去算 `ALLOW_2D`），而本工厂的装配点在 M6 **之后**（本片要 `fallback2d` /
 *   `ALLOW_2D` / `viewFetch` / `syncPins` 这些**它自己产不出来的**东西）⇒ 搬进来就是"M6 要 M9、M9 又要
 *   M6"的环。它是**函数声明**（提升可见）⇒ 宿主按值把它递进来（对 M6 那处调用点一个字都没改）。
 * · `resizeTimers`（宿主 `const` 数组，`onBeforeUnmount` 要遍历清定时器）· `resizeRo`（宿主 `let`，
 *   卸载要 `disconnect`）· `recoverTimer`（宿主 `let`，卸载要 `clearTimeout`）· `sawRender`（宿主 `let`，
 *   `m.on("render")` 在写）· `map` / `alive` —— 全是**宿主拥有**的活状态（别的段/卸载/事件都在用）
 *   ⇒ 走**取值器/写入器**，模块不养第二份（与 S4~S7 同一条落法）。
 * · `waitForBox`（建图前等容器有尺寸）与本段无关，留在宿主。
 *
 * ## ctx 的落法（与 S2~S7 同一套）
 * 宿主构造一份只读 ctx，本工厂在开头**解构一次**，解构出来的名字与搬走前宿主里的闭包变量**同名**
 * ⇒ 下面这些函数的函数体除了别名之外几乎一个字节都不用改
 * （对拍闸 `ws_engineguard_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 🔴 别名逐类可数（对拍闸把每一类都机器化，多一处少一处都红）
 * ① `alive` → `aliveNow()`（**10 处**，逐处现读：watchdog / 延迟 resize / 轮询 / 屏幕转屏 /
 *    recover 轮询 / 代拍三处 `if (!alive) return` / 自拍的 `aborted`）；
 * ② `map` → `mapNow()`（**12 处读点**）· `map = null` → `setMap(null)`（**1 处写**，watchdogFire 的永久类）；
 * ③ `resizeRo` → `resizeRoNow()`（2 读）+ `setResizeRo(...)`（1 写）；
 * ④ `recoverTimer` → `recoverTimerNow()`（1 读）+ `setRecoverTimer(...)`（3 写）；
 * ⑤ `sawRender` → `sawRenderNow()`（**5 处**，`verifySnapshot` / `panelSnapshot` 里那两个
 *    `sawRender:` **对象键**不算 —— 别名只换取值，不换键名）。
 * ⚠️ `resizeTimers`（宿主 `const` 数组）**按引用**递进来：模块只 `.push`，宿主那边遍历照旧看得见
 *    ⇒ 它不是别名、也不算"第二份"。其余分支 / 阈值 / 调用顺序 / DOM 契约逐字不变。
 * ⚠️ `kickResize` 里那一处 `resizeRo = new ResizeObserver(…);` 换成
 *    `const resizeRo = setResizeRo(new ResizeObserver(…));` —— 宿主那面是 `let`，只给取值器的话
 *    下面两行 `resizeRo.observe(...)` 会被 TS 判"可能为 null"（原来靠"刚赋值"的窄化）。
 *    写入器把引用原样返回，绑成**块内 `const`** 之后那两行**一个字都不用动**、窄化也还在
 *    （对拍闸按"写入器 1 处"把它换回原文）。
 *
 * ## 装配位置（TDZ）与 M6 ⇄ M9 那个环
 * 本工厂的装配点紧跟 M7 那一处解构（同一段末尾）：它要 `nameLayer` 之后才有的东西不多，但要
 * `viewFetch` / `joyMeasureVh` / `bldFeed` / `roadsFeed` / `LIVE_ON` / `syncPins`（M7 的出口）
 * —— 这些都在那之前就位。**M6 在它之前**（`createFallback2d` 那一处）⇒ M6 的 ctx 里那三个出口
 * （`dprCap2d` / `startRecoverPoll` / `maybeAppSelfShot`）改成**宿主侧的惰性转发**（各 1 行箭头），
 * 环就断在这里；箭头只在运行时被调（`fallback2d` 里那条路），**M6 的函数体一个字没改**。
 * 依赖方向（§2.2）：本模块属 L2，**不 import 宿主**，也不与任何 M* 横向 import（共享量全由宿主注入）。
 */
import { computed, ref } from "vue";
import type { BldFeature } from "./wsBuildingSources";
import { themeStyleParts, type WsMapTheme } from "./wsMapTheme";
import { prerenderSourceOf, sceneOrderViolations, sceneSelfReport } from "./wsScene";
/* ⚠️ `scenePlanConsumed` 的**真源在 `wsDistrictScene`**（宿主就是从那 import 的）—— 别写成 `wsScene`。 */
import { scenePlanConsumed } from "./wsDistrictScene";
import type { BundleFeedFacts } from "./wsOfflineFeed";
import { roadLayerSpecs } from "./wsRoads";
import {
  appSelfShotArmed,
  appSelfShotDisarm,
  canvasIsBlank,
  diagnosticPng,
  postShot,
  sampleCanvas,
  selfShotArmed,
  selfShotDisarm,
  settleForShot,
} from "./wsSelfShot";
import { type AppShotCtx, type ShotMapLike, runAppSelfShot } from "./wsAppSelfShot";
import { type StyleLayerLite, buildStyleReport } from "./wsStyleReport";
import type { VerifySnapshot } from "./wsVerifyChecks";
import type { EngineGuardCtx } from "./wsStageTypes";

/**
 * 装配 M9（引擎自愈 / 验证 / 自拍）。
 * ⚠️ 位置与理由见文件头「装配位置（TDZ）与 M6 ⇄ M9 那个环」那一段。
 */
export function createEngineGuard(ctx: EngineGuardCtx) {
  /* 解构出来的名字**与搬走前宿主里的闭包变量同名** ⇒ 下面函数体一个字都不用动（见文件头）。 */
  const { props, stats, theme, perf, cv, host, hudEl, phase } = ctx;
  const { themeId, nightOn, nightLvl, renderKind, fallbackWhy, fallbackKind, mapErrs } = ctx;
  const { ALLOW_2D, fallback2d, viewFetch, LIVE_ON, bldFeed, roadsFeed, mapAvailable } = ctx;
  const { joyMeasureVh, pinEdgeMeasure, pinEdgeSync, syncPins, resizeTimers, isAutomation } = ctx;
  const {
    aliveNow, mapNow, setMap, setResizeRo,
    recoverTimerNow, setRecoverTimer, sawRenderNow,
  } = ctx;

  /**
   * 看门狗期限（**环境感知**，不是一刀切 8 秒）。
   * 写成 computed 而不是常量：低档可能在挂载后才被压下去（`fallback2d` 会 `forceLow`），
   * 读的时候取当时的值才是"这条渲染路真的该等多久"。
   */
  const WATCHDOG_MS = computed(() => {
    if (isAutomation()) return 8000; // 闸门靠这条：到点如实降级，别把闸门拖成假失败
    /* 🔴 2026-09-21（P0）：真机期限**大幅放宽**（低端 30s / 其余 60s）。
       原来 12s/24s 的代价机主已经付过了：冷启动 + 首批瓦片本来就要十几秒到几十秒，
       到点被砍进 2D 路 ⇒ 又卡又没手势。而"等久了"在真机上只有好处（多等 = 少误判）；
       自动化保持 **8s 不变**（闸门靠这条：它要的是"到点如实降级"，等久了会把闸门拖成假失败）。
       ⚠️ 而且现在**判错也不致命**了：临时类降级是可恢复的（见 `watchdogFire` / `promoteToWebgl`）。 */
    return perf.low.value ? 30000 : 60000; // 真机：低端短一档，其余给足冷启动时间
  });

  /**
   * 看门狗到点：**如实降级**到 2D 自绘路，并把**实际期限**写进 HUD。
   *
   * ⚠️ 这里**没有**做"降级后再自动切回 WebGL"：`fallback2d()` 会换掉画布元素
   * （同一个 canvas 不能同时有 webgl 和 2d 上下文，见那里的注释），
   * 要切回来得**重建整张地图 + 换回那块画布**，代价与风险都不小。
   * ⇒ 本轮只做到"别误判 + 如实降级 + 降级路不再是一片纯色"，
   *   **自动回切列入未做**（写在 CHANGELOG 的未验/未做里，别当成已经支持）。
   */
  function watchdogFire(m: { remove(): void } | null, fc: { features?: BldFeature[] } | null, limitMs: number): void {
    if (!aliveNow() || phase.value === "done") return;
    const secs = Math.round(limitMs / 1000);
    /* 🔴 2026-09-21（P0 核心）：**"慢"不等于"坏"**。
       这里以前是**无条件** `m.remove()` + `map = null` —— 等于把"冷启动慢"判成**永久**降级：
       机器明明有 WebGL（代拍页 `ws3dshow.html` 实测顺滑，机主证过），却再也回不去那条路，
       于是又卡（2D 自绘填充率）、又像静态图、又没手势。**三个症状同一个根**。
       ⇒ 现在分两类：
         · **永久类**（`perm`）：地图库**报了错**（style/addLayer 那类，只能靠 `error` 事件捞），
           或者**压根没有实例**（无 WebGL / 地图库加载失败）⇒ 该降级，且把错误原文带进面板；
         · **临时类**（`temp`）：**没报错**，只是没在期限内出帧 ⇒ **不销毁地图**，
           把它留在 DOM 底下（`visibility:hidden`）继续渲染，2D 画在**另一块**画布上盖着它；
           一旦它出帧 ⇒ `promoteToWebgl()` **原地切回**（零重建、零换画布）。 */
    const hasErr = mapErrs.length > 0;
    const kind: "temp" | "perm" = !m || hasErr ? "perm" : "temp";
    const whyBase = `地图库 ${secs} 秒内没画出第一帧（load 未触发）`;
    /* 🆕 机主 2026-09-21：「**要求别降级了**」。没显式开逃生阀时**不画 2D**：
       留在页面上如实说明"还在等"，后台每 5 秒复查，出的帧一到、`load` 一来就照常往下走。
       真等不到了（见 `startRecoverPoll` 的期限）就切 `failed` —— **如实报错，不画假的 2D 图**。 */
    if (!ALLOW_2D) {
      renderKind.value = "waiting";
      fallbackKind.value = kind;
      renderLimitSecs.value = secs;
      stats.mode = `地图库还在加载…（已等 ${secs}s，后台继续等，**未降级**）`;
      stats.note = `${
        hasErr
          ? `地图库报了 ${mapErrs.length} 条错（原文见验证面板 ②）`
          : "地图库没报错，只是还没出帧"
      }｜${whyBase}｜页面保持加载态，出帧即继续；等满 ${Math.round(RECOVER_MS / 1000)}s 仍无 ⇒ 面板如实报错`;
      startRecoverPoll();
      return;
    }
    if (kind === "temp") {
      fallback2d(
        "2D 降级（地图库还在加载 · 会自动切回）",
        fc,
        `${whyBase}｜地图库没报错 ⇒ 判为**临时**：实例留在后台继续渲染，一出帧就切回 WebGL`,
        "temp",
        mapNow()
      );
      return;
    }
    try {
      m?.remove();
    } catch {
      /* 已经没了就算了 */
    }
    setMap(null);
    fallback2d(
      "2D 降级（地图库没起来）",
      fc,
      `${whyBase}${hasErr ? `｜地图库还报了 ${mapErrs.length} 条错（原文见验证面板 ②）` : ""}`,
      "perm",
      mapNow()
    );
  }

  /** 曾经降级、后来恢复回 WebGL 了吗（面板要写出来：不然人以为一直在 2D） */
  const recovered = ref(false);

  /** 后台最多等多久（**只是等**，不影响 2D 可用；到点仍不恢复就如实写"HUD 里说等待超时"） */
  const RECOVER_MS = 180000;
  /** 已等待的秒数（看门狗那一刻的实际期限；面板/HUD 都要如实显示"等了多久"） */
  const renderLimitSecs = ref(0);

  /* 版本戳：App 自拍回传的诊断图/JSON 里带上它，agent 一眼看出"**是哪一版代码在跑**"
     （2026-09-21 那次诊断图不带版本戳，差点把两轮不同的包当同一轮在比）。改这一页的行为就顺手 +1。 */
  const APP_SELF_SHOT_BUILD = "app-selfshot-2026-09-21-v1";

  /** 2D 降级路画布的 DPR 封顶默认值（见 `draw2d` 里那段；`?wsdpr=` 可覆盖） */
  const DPR_CAP_2D = 1.5;

  /** 这一次建图的实例序号（面板里对得上"resize 打在哪个实例上"） */
  let mapSeq = 0;
  /**
   * 🔴 **resize 自证日志**（2026-09-21，机主实测"画布仍是 300×150"之后加的）。
   *
   * 为什么非要它：上一版我只是"该调的时机都调一遍"，结果真机上**画布还是 300×150**，
   * 而**没有任何证据能说明是哪一步没生效**（时机？对象？实例？）—— 只能靠猜。
   * 现在每一次 resize 尝试都留一行：**时间 + 为什么调 + 容器 rect + 调前/调后 canvas + 实例号**，
   * 面板显示最近 5 条 ⇒ 一眼看出"是压根没调到"还是"调了但没生效"。
   */
  const resizeLog = ref<string[]>([]);
  function pushResizeLog(row: string): void {
    resizeLog.value = [...resizeLog.value.slice(-4), row];
  }

  /**
   * 🔴 **真地图那块画布**（`map.getCanvas()`）—— 2026-09-21 起，**所有**画布读数都用它。
   *
   * 为什么：机主的"resize 尝试记录"里同一次 `map.resize()` 一会儿量到 300×150、
   * 一会儿量到 **3759×1287** ⇒ 强烈指向**页面上不止一块 canvas**，而原来我一直量 `cv.value`
   * （模板那块 ref）—— 若 MapLibre 实际用的是它自己建的那块，那我量的就是**另一块**（默认 300×150），
   * 屏幕上那块"浅色矩形"也就有了着落。⇒ 先量对对象，再谈修。
   */
  function realMapCanvas(): HTMLCanvasElement | null {
    try {
      const mc = (mapNow() as { getCanvas?: () => HTMLCanvasElement } | null)?.getCanvas?.();
      return mc || null;
    } catch {
      return null;
    }
  }
  /** 当前该被当作"这张地图的画布"的那块：WebGL 路 = `map.getCanvas()`；降级路 = 2D 覆盖层 */
  function activeCanvas(): HTMLCanvasElement | null {
    const mc = realMapCanvas();
    if (renderKind.value === "webgl" || renderKind.value === "waiting" || renderKind.value === "init") return mc || cv.value;
    return cv.value;
  }
  /** 页面上**所有** canvas 的事实（面板要"几块、哪块是谁"的确定答案） */
  function canvasFacts(): NonNullable<VerifySnapshot["canvases"]> {
    const mc = realMapCanvas();
    try {
      return Array.from(document.querySelectorAll("canvas")).map((el, i) => {
        const c2 = el as HTMLCanvasElement;
        const st = getComputedStyle(c2);
        const par = c2.parentElement;
        return {
          i,
          w: c2.width,
          h: c2.height,
          cls: String(c2.className || "").slice(0, 30),
          parent: par ? `${par.tagName.toLowerCase()}.${String(par.className || "").split(" ")[0] || ""}`.slice(0, 30) : "无父",
          z: String(st.zIndex),
          display: String(st.display),
          visibility: String(st.visibility),
          isMapCanvas: !!mc && c2 === mc,
          isRef: c2 === cv.value,
          /* ⚠️ 判"遮挡"必须用**渲染尺寸**（clientWidth/Height），不能用 buffer（width/height）：
             罪魁那块 `ws-dml__cv` 的 buffer 只有 300×150，但 CSS 被拉满整屏 ⇒ 它照样盖住地图。 */
          cw: c2.clientWidth,
          ch: c2.clientHeight,
          covers: false,
        };
      });
    } catch {
      return [];
    }
  }
  /**
   * **设计上的覆盖层白名单**（判据：**它们本来就该铺在地图上面，且都应该是透明的**）。
   * 命中判据（任一）：class 含这些片段，或父元素 class 含这些片段。
   * ⚠️ 只用来**免掉"遮挡"误报**，绝不隐藏它们；**非白名单**的可见画布照旧要报（真凶就是这么抓到的）。
   */
  const OVERLAY_CANVAS_HINTS = ["cursor-trail", "cursor-effects", "ws-wx", "ws-weather", "ws-particle"];
  function isOverlayCanvas(el: HTMLCanvasElement): boolean {
    const cls = `${String(el.className || "")} ${String(el.parentElement?.className || "")}`;
    return OVERLAY_CANVAS_HINTS.some((h) => cls.includes(h));
  }

  /** 给清单补"是否遮挡"（**渲染面积**判：可见 + 非地图那块 + 面积 ≥ 地图的一半） */
  function canvasFactsWithCover(): NonNullable<VerifySnapshot["canvases"]> {
    const rows = canvasFacts();
    const mc = realMapCanvas();
    const mArea = mc ? Math.max(1, mc.clientWidth * mc.clientHeight) : 0;
    return rows.map((r) => ({
      ...r,
      overlay: (() => {
        try {
          const all = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
          const el = all[r.i];
          return !!el && isOverlayCanvas(el);
        } catch {
          return false;
        }
      })(),
      sample: (() => {
        try {
          const all = Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
          const el = all[r.i];
          if (!el || el === mc) return "";
          const v = sampleCanvas(el);
          const alpha = v.aMin < 0 ? "" : ` α=${v.aMin}~${v.aMax}`;
          return `采样=${v.blank ? `单色/透明（${v.note}）` : "有内容"}${alpha}${
            v.aMax >= 250 && v.aMin >= 250 ? "（**不透明**：会挡住地图，需确认是否该铺在最上层）" : "（透明叠层 ✓）"
          }`;
        } catch {
          return "采样=失败";
        }
      })(),
      covers:
        !!mc &&
        !r.isMapCanvas &&
        !r.overlay &&
        r.display !== "none" &&
        r.visibility !== "hidden" &&
        mArea > 0 &&
        (r.cw || 0) * (r.ch || 0) >= mArea * 0.5,
    }));
  }

  /**
   * 若发现有**非 map.getCanvas() 的画布盖在地图上**（同一父级、可见），把它藏掉 ——
   * 那块多半是历史遗留（换过画布/降级过又切回来），盖在真地图上 ⇒ 屏幕上就是它（一片纯色）。
   * 只做一次、只动"盖在真画布之上"的那块，并且写进 resize 日志（**可回溯**）。
   */
  function removeStrayCanvases(): void {
    const mc = realMapCanvas();
    const box = host.value;
    if (!mc || !box) return;
    try {
      /* 规则（2026-09-21 定案后修正）：**只看"地图容器内部"**、可见、且不是 `map.getCanvas()` 的画布。
         ⚠️ 原来那条"必须与真画布同一父级"是**漏网的原因**：罪魁 `.ws-dml__cv` 的父级是 `div.ws-dml`
         （= 我们的 host），而真画布在 `div.maplibregl-canvas-container` 里 ⇒ 父级不同，规则放过了它。
         ⚠️ 也**不能**无差别删掉页面上所有非地图画布：天气粒子那块（`div.ws-wx` 里）是**该在**的，
         所以作用域限定在 host 内部。 */
      const all = Array.from(box.querySelectorAll("canvas")) as HTMLCanvasElement[];
      for (const el of all) {
        if (el === mc) continue;
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        const cls = String(el.className || "");
        const where = `${el.width}x${el.height} buffer / ${el.clientWidth}x${el.clientHeight} 渲染`;
        el.remove(); // **从 DOM 移除**（只 display:none 会留个空壳，下次判断又要靠运气）
        pushResizeLog(`移除遗留画布（${where} class=${cls}）—— 它盖在真地图上（真=${mc.width}x${mc.height}）`);
      }
    } catch {
      /* 删不掉不影响别的 */
    }
  }
  /** 兼容旧名（kickResize 里调的是它） */
  const hideStrayCanvases = removeStrayCanvases;

  /** 现在画布该有多大（容器 CSS 尺寸 × dpr）—— 判据与面板一致 */
  function wantCanvasSize(cv2: HTMLCanvasElement): string {
    const el = host.value;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    if (!el) return "?";
    return `${Math.round(el.clientWidth * dpr)}x${Math.round(el.clientHeight * dpr)}`;
  }
  /**
   * 调一次 resize 并**记日志**（容器尺寸 + 前后 canvas 尺寸）。
   * `why` 写清是谁触发的（首次 / 延迟 1000ms / ResizeObserver / 轮询兜底 / 强制按钮）。
   */
  function doResize(m: { resize?: () => void }, why: string): void {
    const el = host.value;
    const cv2 = activeCanvas();
    const box = el ? `${el.clientWidth}x${el.clientHeight}` : "无容器";
    const before = cv2 ? `${cv2.width}x${cv2.height}` : "无画布";
    if (!el || !cv2) {
      pushResizeLog(`${why}｜容器=${box}｜画布=${before}｜**没有容器或画布，跳过**`);
      return;
    }
    try {
      m.resize?.();
    } catch (e) {
      pushResizeLog(`${why}｜容器=${box}｜${before}→抛错 ${String((e as Error)?.message || e).slice(0, 24)}`);
      return;
    }
    const after = `${cv2.width}x${cv2.height}`;
    const want = wantCanvasSize(cv2);
    const ok = after === want;
    pushResizeLog(
      `${why}（实例#${mapSeq}）｜容器=${box}｜画布 ${before}→${after}｜期望 ${want}｜${ok ? "✅ 一致" : "❌ 仍不一致"}`
    );
  }
  /** 建图后补 resize：rAF 一次 + 延迟几次 + 观察**容器** + **5 秒内每 500ms 兜底轮询**（尺寸不一致就再调） */
  function kickResize(m: { resize?: () => void }): void {
    mapSeq++;
    doResize(m, "建图后立刻");
    for (const t of [250, 1000, 2500]) {
      resizeTimers.push(
        window.setTimeout(() => {
          if (aliveNow()) doResize(m, `延迟 ${t}ms`);
        }, t)
      );
    }
    /* 兜底轮询：不管前几次是不是"调早了"，只要尺寸还对不上就继续调（最多 5s） */
    const pollEnd = Date.now() + 5000;
    const poll = (): void => {
      if (!aliveNow()) return;
      const cv2 = cv.value;
      const el = host.value;
      if (cv2 && el && `${cv2.width}x${cv2.height}` !== wantCanvasSize(cv2)) {
        doResize(m, "轮询兜底");
        if (Date.now() < pollEnd) resizeTimers.push(window.setTimeout(poll, 500));
        return;
      }
      if (Date.now() < pollEnd) resizeTimers.push(window.setTimeout(poll, 500));
    };
    resizeTimers.push(window.setTimeout(poll, 500));
    /* 顺手清掉"盖在真地图上的遗留画布"（机主那块浅色矩形最可能的来源） */
    resizeTimers.push(window.setTimeout(() => aliveNow() && hideStrayCanvases(), 800));
    try {
      if (typeof ResizeObserver !== "undefined" && host.value) {
        const resizeRo = setResizeRo(new ResizeObserver(() => doResize(m, "ResizeObserver(容器)")));
        resizeRo.observe(host.value);
        /* ⚠️ 也观察**画布自己**：容器没变而画布 CSS 尺寸变了的情况（父级用别的方式撑开）也收得住 */
        if (cv.value) resizeRo.observe(cv.value);
      }
    } catch {
      /* 没有 ResizeObserver 就靠上面的轮询（不影响建图） */
    }
    /* 视口变化/转屏：设备方向一变，`dpr` 与布局尺寸都会变（**必须**再量一次） */
    try {
      window.addEventListener("resize", onWinResize);
      window.addEventListener("orientationchange", onWinResize);
    } catch {
      /* 挂不上就算了（轮询与观察器还在） */
    }
  }
  /** 视口/方向变化 → 延迟一点再量（浏览器改布局是异步的） */
  function onWinResize(): void {
    joyMeasureVh();      // 🕹 §15：转屏/改窗口 ⇒ 底盘尺寸跟着变（同一个 resize 里量，不新开监听）
    /* 📍 屏外指示的几何也在这里重量（容器尺寸 + 安全区）——**同一个 resize 里**，不新开监听；
       量完立刻同步一次：转屏后箭头的落点是按新矩形算的，不补这一下会停在旧位置上。 */
    pinEdgeMeasure();
    pinEdgeSync();
    if (!aliveNow() || !mapNow()) return;
    window.setTimeout(() => doResize(mapNow() as { resize?: () => void }, "窗口/转屏"), 300);
  }
  /**
   * 面板上的「🔄 强制重算画布」：**手动**调一次并回报前后尺寸。
   * 这是最快的判定手段 —— 机主点一下就知道"resize 能不能治好"，也能区分
   * "逻辑没跑到"（日志里没有记录）和"resize 本身无效"（记录了但尺寸不变）。
   */
  function forceResizeCanvas(): string {
    const m = mapNow() as { resize?: () => void } | null;
    const cv2 = cv.value;
    if (!m || !cv2) return "这一级没有地图实例（或没有画布），没法重算";
    const before = `${cv2.width}x${cv2.height}`;
    doResize(m, "面板强制按钮");
    const after = `${cv2.width}x${cv2.height}`;
    return after === before
      ? `点了但画布没变（仍 ${after}）—— 说明 resize() 对当前实例无效，得查容器/实例；日志见面板`
      : `画布 ${before} → ${after}${after === wantCanvasSize(cv2) ? "（✅ 已与容器一致）" : "（仍未一致）"}`;
  }

  /**
   * 读「2D 降级路画布的 DPR 封顶」：`?wsdpr=<数字>` > 默认 1.5（夹在 1~3，脏值不认）。
   * 与 `?wsnight=off` 同一套纪律：**URL 优先**（"我想看另一档"不能被默认值盖掉），读不到不抛。
   */
  function dprCap2d(): number {
    try {
      const v = Number(new URLSearchParams(location.search).get("wsdpr") || NaN);
      if (Number.isFinite(v) && v >= 1 && v <= 3) return v;
    } catch {
      /* 隐私模式/无 location ⇒ 用默认 */
    }
    return DPR_CAP_2D;
  }

  /**
   * 临时类降级后：**每 4 秒问一次"地图库出帧了吗"**，出来就切回 WebGL。
   *
   * 为什么值得（P0）：机主的机器**有** WebGL（代拍页顺滑），App 之所以掉进 2D 只是**慢**。
   * 以前"慢"被当成"坏"——永久判决、而且地图实例当场被销毁 ⇒ 再也回不去。
   * 现在实例留着跑（藏在 2D 画布下面），这里只负责"等它好了把它请回前台"。
   */
  function startRecoverPoll(): void {
    if (recoverTimerNow()) return;
    const t0 = Date.now();
    const tick = (): void => {
      setRecoverTimer(0);
      if (!aliveNow()) return;
      const m = mapNow() as { isStyleLoaded?: () => boolean; loaded?: () => boolean } | null;
      const ready = !!m && !!(m.isStyleLoaded?.() && (sawRenderNow() || m.loaded?.()));
      if (ready) {
        promoteToWebgl(Math.round((Date.now() - t0) / 1000));
        return;
      }
      if (Date.now() - t0 > RECOVER_MS) {
        const waited = Math.round(RECOVER_MS / 1000);
        if (renderKind.value === "waiting") {
          /* 等满了还没来 ⇒ **如实报错**（不降级、不画假图）。面板 + HUD 一起说清：
             为什么、等了多久、错误原文在哪、还有哪两条路可走（重试 / 手动逃生阀）。 */
          renderKind.value = "failed";
          stats.mode = `地图库没起来（已等 ${waited}s，**未降级**）`;
          stats.note = `地图库 ${waited}s 内始终没出帧（${mapErrs.length} 条错误，原文见验证面板）｜可按面板「🔄 重试地图」重建，或加 \`?wsfallback=1\` 用 2D 自绘兜底`;
        } else {
          stats.note = stats.note
            ? `${stats.note} · 后台等了 ${waited}s 仍未出帧`
            : `后台等了 ${waited}s 仍未出帧`;
        }
        return;
      }
      setRecoverTimer(window.setTimeout(tick, 5000));
    };
    setRecoverTimer(window.setTimeout(tick, 5000));
  }

  /**
   * **切回 WebGL**（临时类降级恢复）：把盖在上面的 2D 画布摘掉、把地图那块显示回来。
   * 不做任何重建 —— 地图实例、相机、图层、数据全都在（它们从没被销毁过）。
   */
  function promoteToWebgl(waitedSec = 0): boolean {
    const m = mapNow() as { getCanvas?: () => HTMLCanvasElement } | null;
    const mapCv = m?.getCanvas?.();
    if (!mapCv) return false;
    const twoD = cv.value;
    try {
      mapCv.style.visibility = "";
      mapCv.style.pointerEvents = "";
    } catch {
      /* 样式写不上也继续（至少把它显示回来这一步是对的） */
    }
    if (twoD && twoD !== mapCv) {
      try {
        twoD.remove();
      } catch {
        /* 摘不掉就留着（藏在下面也无害） */
      }
    }
    cv.value = mapCv;
    mapAvailable.value = true;
    renderKind.value = "webgl";
    fallbackKind.value = "none";
    recovered.value = true;
    /* 档位还回去：降级时被 `forceLow` 压过低档，不解除的话"恢复了却还是少描边/关模糊" */
    try {
      perf.clearForce();
    } catch {
      /* 老版本没有这个口子就算了（低档继续，不影响恢复本身） */
    }
    stats.perf = "";
    stats.mode = `街区视野（街道级）· 地图库已恢复${waitedSec ? `（后台等了 ${waitedSec}s）` : ""}`;
    stats.note = stats.note
      ? `${stats.note} · ✅ 地图库出帧了 ⇒ 已自动切回 WebGL（手势可用）`
      : "✅ 地图库出帧了 ⇒ 已自动切回 WebGL（手势可用）";
    try {
      syncPins();
      /* 🗄 2026-09-24：AI 示意层不再挂（机主：App 页是最终结构，但**去掉多余叠加**）
         —— `syncAiLayers()` 留在文件里，两个调用点与两个 watcher 都关掉。 */
    } catch {
      /* 同步失败不影响"画面已经切回 WebGL"这件事 */
    }
    return true;
  }

  /**
   * 面板上的「**重试地图**」：机主手动按一下，做两件事 ——
   *   ① 实例还在 ⇒ **立刻**按恢复判据试一次（很多时候它其实已经好了，只是没人去看）；
   *   ② 实例已经没了（永久类）⇒ 只能重载这一页再试（**会回到主菜单**，如实说出来）。
   */
  async function retryMap(): Promise<string> {
    const m = mapNow() as { isStyleLoaded?: () => boolean; loaded?: () => boolean } | null;
    if (m) {
      const ok = !!(m.isStyleLoaded?.() && (sawRenderNow() || m.loaded?.()));
      if (ok) return promoteToWebgl() ? "✅ 地图库其实已经出帧了 ⇒ 已切回 WebGL（手势可用）" : "拿不到地图画布，切不回去";
      return `地图库实例还在，但**仍未出帧**（样式已加载=${String(m.isStyleLoaded?.())}，出过帧=${sawRenderNow()}）—— 继续等它会自动切回`;
    }
    if (renderKind.value === "fallback2d") {
      try {
        location.reload();
        return "已请求重新加载这一页（会回到主菜单，再进一次小区级）";
      } catch {
        return "这张地图实例已经销毁，得重新进一次小区级（重载也被拦了）";
      }
    }
    return "现在就是 WebGL 路，不用重试";
  }

  /**
   * 「代拍」：页面上有 `?autoshot=1` 时，走到小区级就**自动拍三张**（近/远/侧）回传。
   *
   * 为什么由页面自己拍：agent 侧看不到 WebGL，机主又禁了 ADB 截屏（会看到整屏隐私）。
   * 详见 `wsSelfShot.ts` 的文件头。这里只负责"什么时候按快门"。
   *
   * 三张的机位是**商量好的**：一近（看楼体）、一远（看整片）、一侧（看高低起伏）。
   * 拍完自动关掉开关 —— 不然每次进出小区级都往服务器灌图。
   */
  async function runSelfShot(m: {
    getCanvas(): HTMLCanvasElement;
    easeTo(o: Record<string, unknown>): void;
    once(ev: string, cb: () => void): void;
    isStyleLoaded?: () => boolean;
    getZoom?: () => number;
    loaded?: () => boolean;
  }): Promise<void> {
    /** 拍一张：**先判空白**，空白就回传诊断图（白图什么都不说明，等于白点一次） */
    const snap = async (name: string): Promise<boolean> => {
      const cv = m.getCanvas();
      const { blank, note } = canvasIsBlank(cv);
      if (blank) {
        const diag = diagnosticPng([
          `空白：${note}`,
          `样式已加载=${String(m.isStyleLoaded?.())} 地图loaded=${String(m.loaded?.())}`,
          `画布=${cv.width}x${cv.height} zoom=${m.getZoom?.()}`,
          `取楼=${stats.count} 栋 · 半径档=${stats.view || "-"}`,
          `note=${(stats.note || "无").slice(0, 40)}`,
        ]);
        await postShot(diag || cv.toDataURL("image/png"), `${name}-DIAG`);
        stats.note = `代拍拿到空白（${note}）⇒ 已回传诊断图`;
        return false;
      }
      try {
        return await postShot(cv.toDataURL("image/png"), name);
      } catch (e) {
        stats.note = `代拍失败：${String((e as Error)?.name || e)}`;
        return false;
      }
    };
    /* 等真的画完（`idle` + 两帧 rAF），不是"睡够 4 秒就赌它好了" */
    await settleForShot(m, 800);
    if (!aliveNow()) return;
    let ok = await snap("app-dist-near");
    /* 🎨 「远」这张现在专门用来看**地平线与天空**（pitch 26° ≈ 接近平视）。
       机主要"看得见天空（基沃托斯的天空）"⇒ 三张证据图里必须有一张是抬着头的。 */
    m.easeTo({ zoom: 14.6, pitch: 26, duration: 900 });
    await settleForShot(m, 1200);
    if (!aliveNow()) return;
    ok = (await snap("app-dist-far")) || ok;
    m.easeTo({ zoom: 17.4, pitch: 50, bearing: -30, duration: 900 });
    await settleForShot(m, 1200);
    if (!aliveNow()) return;
    ok = (await snap("app-dist-close")) || ok;
    if (ok && !stats.note.includes("空白")) stats.note = "代拍：已回传 3 张（近/远/侧）";
    selfShotDisarm();
  }

  /**
   * 🧪 **App 自拍**（`?selfshot=1`）：主 App 页走完"进小区级 → 等稳 → 抓帧回传"。
   *
   * 与上面 `runSelfShot`（代拍页那条通道）**不共用机位**：这一条拍的就是**机主正在看的这一屏**
   * ——真主题、真图层、真降级逻辑，一个字都不改，所以它同时是"验收证据"和"故障现场"。
   *
   * 触发点两处（都只加一次调用，**不改任何既有语义**）：
   *   · 地图库 `load` 之后（WebGL 路）；
   *   · `fallback2d()` 末尾（降级路）—— **降级了更要拍**：那些"整屏纯色"的事故就发生在这条路上。
   *
   * 等稳的判据（`sawFirstFrame && dataReady`）：首帧 + 数据到齐，或者**超时照拍**
   * （超时也要给证据，只是会在诊断图/HUD 里如实写 `数据到齐=false`）。
   */
  function maybeAppSelfShot(kind: "webgl" | "fallback2d", why = ""): void {
    /* 🔬 面板要的就是这两个事实（**先记下来再说要不要自拍** —— 没开自拍时面板照样要显示） */
    renderKind.value = kind;
    fallbackWhy.value = why;
    /* 没开就是一次 boolean 判断（零开销）—— 与代拍同一个纪律 */
    if (!appSelfShotArmed()) return;
    appSelfShotDisarm(); // 立刻落闸：这一轮就是这一轮，页面里其它挂载点不要重复发起
    void runAppSelfShot(appShotCtx(kind, why));
  }

  /** 自拍的上下文（**面板的「现在拍一张」按钮也用它** —— 一条路，不是两套） */
  function appShotCtx(kind: "webgl" | "fallback2d", why: string): AppShotCtx {
    return {
      kind,
      fallbackWhy: why,
      /* 画布**现取**：降级路会换掉画布元素（见 `fallback2d` 那段），存下来的引用会拍到旧画布 */
      /* 📸 拍到**真地图那块**（WebGL 路 = `map.getCanvas()`；降级路 = 2D 覆盖层） */
      getCanvas: () => activeCanvas(),
      getMap: () => (kind === "webgl" ? (mapNow() as unknown as ShotMapLike | null) : null),
      sawFirstFrame: () => (kind === "webgl" ? sawRenderNow() : true),
      /* "数据到齐" = 有东西可看（楼/路/设施/人）—— 全区视野下楼栋本来就不取，所以是**或**不是**与** */
      dataReady: () => stats.count + stats.roads + stats.facilities + stats.pins > 0,
      dataNote: () =>
        `🏢${stats.count} 🛣${stats.roads} 🏪${stats.facilities} 👤${stats.pins} · ${stats.note || "无提示"}`,
      /* 真机 Overpass 冷查询实测 20~100s；无头/自动化给短一点（免得把闸门拖成假失败）。
         面板按钮走的是"**机主已经站在这一屏前**"的场景 ⇒ 给 6 秒就够（数据早就在了） */
      waitMs: isAutomation() ? 15000 : 45000,
      /* 等数据的这几十秒里机主可能切走 ⇒ 组件卸载就**什么都不发**（发了就是假证据） */
      aborted: () => !aliveNow(),
      /* 📊 样式自检 JSON：**有多少给多少，不知道写 null**（详见 `wsStyleReport.ts` 的文件头）。
         取值全走"现读"：`map` 可能是 null（降级路）、画布可能被换过 —— 提前存下来的都会失真。 */
      styleReport: (shot) => verifySnapshot(true, shot),
      note: (s) => {
        stats.note = stats.note ? `${stats.note} · ${s}` : s;
      },
      build: APP_SELF_SHOT_BUILD,
    };
  }

  /**
   * 🔬 面板与样式 JSON **共用的那一份快照**（同一件事，两种读者：人看面板、agent 读 JSON）。
   *
   * `full = true` 时给样式 JSON（带 shot 那一轮的细节）；面板走 `full = false`（没有 shot 段）。
   * 一律**现读**：`map` 可能是 null、画布可能被换过、`theme` 可能正在切 —— 提前存下来的都会失真。
   */
  function verifySnapshot(
    full: boolean,
    shot?: { name: string; blank: boolean; attempts: number; waitedMs: number; ready: boolean; why: string; posted: boolean }
  ): Record<string, unknown> {
    const layers = ((mapNow()?.getStyle?.()?.layers as StyleLayerLite[] | undefined) || []).filter((l) => !!l?.id);
    const canvas = cv.value
      ? {
          w: cv.value.width,
          h: cv.value.height,
          dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
          cssW: cv.value.clientWidth,
          cssH: cv.value.clientHeight,
        }
      : null;
    return buildStyleReport({
      build: APP_SELF_SHOT_BUILD,
      href: typeof location !== "undefined" ? location.href : "",
      isStyleLoaded: mapNow()?.isStyleLoaded?.() ?? null,
      layers,
      paintOf: (id, key) => mapNow()?.getPaintProperty?.(id, key),
      errors: mapErrs,
      wstheme: themeId.value,
      wsnight: { on: nightOn.value, level: nightLvl.value, lowTier: !!perf.low.value },
      canvas,
      fallback: { used: renderKind.value === "fallback2d", why: fallbackWhy.value },
      /* P0：**临时还是永久** + 有没有恢复过 —— 图和 JSON 都要带回去（agent 才知道该不该让人重试） */
      fallbackKind: renderKind.value === "fallback2d" ? fallbackKind.value : "none",
      recovered: recovered.value,
      sawRender: renderKind.value === "webgl" ? sawRenderNow() : renderKind.value === "fallback2d",
      hud: hudEl.value?.innerText || "",
      stats: { ...stats },
      ...(full && shot
        ? {
            shot: {
              name: shot.name,
              blank: shot.blank,
              attempts: shot.attempts,
              waitedMs: shot.waitedMs,
              ready: shot.ready,
              note: shot.why,
              posted: shot.posted,
            },
          }
        : {}),
    });
  }

  /**
   * 「**动效状态**」：**当场 DOM 观察**（不猜、不写死）。
   *
   * 机主 2026-09-21 的疑问是"看不到 MG 动画" —— 而"没触发"和"坏了"是两件事：
   * 加载动画播完就收、事件条只在**新事件**来时入场、设施淡入只在小区级且只播一次。
   * ⇒ 把这些事实摆出来，人自己就能分清。
   */
  function motionFacts(): NonNullable<VerifySnapshot["motion"]> {
    const q = (sel: string): Element[] => {
      try {
        return Array.from(document.querySelectorAll(sel));
      } catch {
        return [];
      }
    };
    const facNodes = q(".ws-fac__mark");
    let fadeDone: boolean | null = null;
    if (facNodes.length) {
      try {
        const st = getComputedStyle(facNodes[0] as Element);
        fadeDone = Math.abs(Number(st.opacity) - 1) < 0.05 && (st.transform === "none" || st.transform === "matrix(1, 0, 0, 1, 0, 0)");
      } catch {
        fadeDone = null;
      }
    }
    return {
      phase: String(phase.value),
      facilityNodes: facNodes.length,
      facilityFadeDone: fadeDone,
      eventRows: q(".ws-ef__list > *").length,
      weatherCanvas: q(".ws-wx__cv").length > 0,
      low: !!perf.low.value,
    };
  }

  /** 面板要显示的那份（`VerifySnapshot`；图层 + 关键 paint 从上面那份里取，**不重算**） */
  function panelSnapshot(): VerifySnapshot {
    const rep = verifySnapshot(false) as {
      isStyleLoaded: boolean | null;
      layers: { ids: string[]; types: Record<string, string> };
      keyPaints: Record<string, Record<string, unknown>>;
      errors: string[];
      canvas: { w: number; h: number; dpr: number; cssW: number | null; cssH: number | null } | null;
      fallback2d: { used: boolean; why: string };
      sawRender: boolean;
    };
    const layers = rep.layers.ids.map((id) => ({ id, type: rep.layers.types[id] || "?" }));
    /* "主题期望的图层" —— 与当前档位**同一份来源、同一档位**（`themeStyleParts`），
       少一条就能当场看出来。

       🔴 2026-09-24 修掉一次**假报**（机主真机截图："主题图层齐：实际 8 条 / 期望 4 条 · 缺 tint"）：
       这里原来写死 `low = false`（高档）去算期望，而**实际渲染按当前档位**——
       低档下 `themeForTier()` 会把 `tint` 甚至 `sky` 摘掉（`dropTint`）⇒ 期望里带着 `tint`、
       实际没有 ⇒ 面板年年报"缺 tint"，**而装配其实是正确的**。
       ⇒ 现在两边都用 `perf.low.value`，并**如实标出档位**（差值就是"低档本来就少的那几层"）。 */
    let expected: string[] = [];
    try {
      expected = (themeStyleParts(theme.value, !!perf.low.value, 0).layers || []).map((l: { id?: string }) => String(l.id || ""));
    } catch {
      expected = [];
    }
    if (perf.low.value) {
      const high = (() => {
        try {
          return (themeStyleParts(theme.value, false, 0).layers || []).map((l: { id?: string }) => String(l.id || ""));
        } catch {
          return [];
        }
      })();
      const droppedByTier = high.filter((id) => !expected.includes(id));
      if (droppedByTier.length) {
        /* 记账（HUD 的 note 通道）：**"低档按设计摘掉了这几层"** —— 不是缺装配，别让人去查半天 */
        const msg = `低档按设计摘掉图层：${droppedByTier.join(",")}（不是缺装配）`;
        stats.note = stats.note && stats.note.includes(msg) ? stats.note : stats.note ? `${stats.note} · ${msg}` : msg;
      }
    }
    return {
      kind: renderKind.value,
      build: APP_SELF_SHOT_BUILD,
      href: typeof location !== "undefined" ? location.href : "",
      fallbackWhy: fallbackWhy.value,
      fallbackKind: renderKind.value === "fallback2d" ? fallbackKind.value : "none",
      recovered: recovered.value,
      /* ⚠️ 这一条是**读的那一刻**的原始值（`map.isStyleLoaded()`）：
         它在"瓦片还在下"时会**长时间为 false**，而地图**可能早就画出内容了**
         （本会话真机截图就出现过 `样式已加载=false` 与 `出过首帧=true` **同屏**）。
         ⇒ 不粉饰原值，但在后面把 `sawRender` 一起写出来：**出过帧 = 这份 style 校验通过、
         图层也建起来了**（样式若非法，`load` 永不触发，一帧都不会有）。 */
      isStyleLoaded: rep.isStyleLoaded,
      sawRender: rep.sawRender,
      layers,
      expectedLayerIds: expected.filter(Boolean),
      errors: rep.errors,
      canvas: rep.canvas
        ? {
            w: rep.canvas.w,
            h: rep.canvas.h,
            cw: Number(rep.canvas.cssW || 0),
            ch: Number(rep.canvas.cssH || 0),
            dpr: rep.canvas.dpr,
          }
        : null,
      /* 🎬 场景装配自证（主会话要求：App 里也要能看到"相机/层序取自 wsScene"） */
      sceneSource: (() => {
        try {
          const camOk = true; // 相机默认值在 setup 期就取自 `cameraDefaults()`
          return sceneSelfReport(scenePlanConsumed() || camOk).source;
        } catch {
          return "（页面自带）";
        }
      })(),
      sceneViolations: (() => {
        try {
          const ids = (mapNow()?.getStyle?.()?.layers || []).map((l: { id?: string }) => String(l.id || ""));
          return sceneOrderViolations(ids);
        } catch {
          return [];
        }
      })(),
      /* 2D 路的 DPR 封顶（机主要的"降级路便宜了多少"的数字；WebGL 路不适用 ⇒ null） */
      dprCap2d: renderKind.value === "fallback2d" ? dprCap2d() : null,
      canvasBlank: (() => {
        const c2 = activeCanvas();
        return c2 ? canvasIsBlank(c2) : null;
      })(),
      counts: { buildings: stats.count, roads: stats.roads, facilities: stats.facilities, pins: stats.pins },
      /* 🧱 **离线包 offline-first 的可数回证**（切片 A）：默认发了几条 `/api/*`、取了哪些格、
         包外/失败各几格、仓库里多少要素（**数不出来写 null，不写 0**）、以及署名原句。
         ⚠️ 判词/计数口径**只有一份**（`wsScene.*VerdictText` / `wsOfflineFeed.bundleCountsLine`），
         面板只是把它念出来 —— 不在这里另算一套。 */
      bundle: (() => {
        const bf: BundleFeedFacts = bldFeed.facts();
        const rf: BundleFeedFacts = roadsFeed.facts();
        let pre: { src: string; tilePath: string; kind: string; attribution: string } | undefined;
        try {
          /* 远景预渲染的**路径与署名取自真源**（`wsScene.prerenderSourceOf`）——App 还没挂那一层
             （切片 C），这里只把真源的值念出来，免得以后有人手抄一份路径字面量。 */
          const p = prerenderSourceOf("real");
          pre = { src: p.src, tilePath: p.tilePath, kind: p.kind, attribution: p.attribution };
        } catch {
          pre = undefined;
        }
        return {
          bld: { have: bf.have, missing: bf.missing, failed: bf.failed, pending: bf.pending, n: bf.n, cap: bf.cap, verdict: stats.bldVerdict },
          roads: { have: rf.have, missing: rf.missing, failed: rf.failed, pending: rf.pending, n: rf.n, verdict: stats.roadsVerdict },
          /* 🧱 重构切片 S4（M2）：`bldHits` / `roadHits` / `bldInfo` / `roadInfo` 四个读数的所有者
             现在是 `wsViewFetch`（宿主里那四个 `let` 跟着函数一起搬走了）⇒ 这里换成它的出口。
             `on` 仍由宿主拼（`LIVE_ON` 是宿主自己的开关，不归 M2）。判据一字未改：还是"念出来"。 */
          live: { on: LIVE_ON, ...viewFetch.liveFacts() },
          attribution: stats.attribution,
          ...(pre ? { prerender: pre } : {}),
        };
      })(),
      roadSpecs: (() => {
        try {
          return roadLayerSpecs(theme.value.road).length;
        } catch {
          return 0;
        }
      })(),
      capsLow: !!perf.low.value,
      wstheme: themeId.value,
      wsnight: { on: nightOn.value, level: nightLvl.value },
      locSource: props.locSource || "",
      keyPaints: rep.keyPaints || {},
      worldTime: `${props.worldTime || "（拿不到）"} · 天黑 ${nightLvl.value}${nightOn.value ? "" : "（夜色关）"}`,
      motion: motionFacts(),
      resizeLog: resizeLog.value,
      canvases: canvasFactsWithCover(),
      hud: hudEl.value?.innerText || "",
    };
  }

  /** 面板的「现在拍一张」：**不看开关**（这是机主显式点的），拍完回一句人话 */
  async function shootNow(): Promise<string> {
    /* 还没分路（`init`）时按 WebGL 试：面板按钮多出现在地图已经起来之后，真降级了上面那条早就写了 */
    const kind = renderKind.value === "fallback2d" ? "fallback2d" : "webgl";
    const before = mapErrs.length;
    const r = await runAppSelfShot(appShotCtx(kind, fallbackWhy.value));
    const prefix = r.posted ? "已回传" : "POST 失败";
    const extra = r.blank ? `（空白：${r.why}，试了 ${r.attempts} 次 ⇒ 发的是诊断图）` : `（真画面）`;
    const errs = mapErrs.length > before ? ` · 期间地图库又报了 ${mapErrs.length - before} 条错` : "";
    return `${prefix} ${r.name} ${extra}${errs}`;
  }

  /* 宿主还要用的那几个（`dprCap2d` / `startRecoverPoll` 已在 M6 的 ctx 里惰性转发；
     其余在宿主**一个调用点都没有** ⇒ 不解构；删除按 §3 留给 S9）。 */
  return {
    WATCHDOG_MS, watchdogFire, kickResize, onWinResize, forceResizeCanvas, retryMap, runSelfShot,
    maybeAppSelfShot, removeStrayCanvases, panelSnapshot, shootNow, dprCap2d, startRecoverPoll,
  };
}
