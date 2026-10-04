/* wsNameHost.ts —— M4：**名字层宿主**（`PLAN-REFACTOR.md` §2.1 的 M4 / §3 的 S5）。
 *
 * ## 这个文件收什么
 * 从宿主 `WsDistrictMapLibre.vue` **整块搬出来**的那些"把名字层的渲染计划落到 DOM"的东西
 * （锚点 = 函数名，不按行号）：
 *   · 名字层的装配：`namesOn`（`?names=0`）/ `nameLayer`（`createNameLayer` 接线）
 *   · 屏上节点的状态：`namePlan` / `nameNodes` / `switching` / `labRootEl` / `nameEnter` /
 *     `nameGhosts` / `ghostFading` / `snapping`（+ 四个私有定时器/两帧句柄）
 *   · 落 DOM：`labClassOf` / `applyNamePlan` / `applyNamePlanWithHud` / `fadeInNew` / `fadeOutGone`
 *   · 坐标重投影与重排：`reprojectNow`（就地重投影，**只重投影不重排**）/ `refreshNames`
 *   · 动效降级两问：`perfLow` / `reducedMotion()`（只有这一族函数读它们 —— 见下面"为什么搬"）
 *
 * ## 搬迁纪律（这一片**零行为变化**）
 * 搬迁 = **移动 + 加签名**：分支、阈值、调用顺序、DOM 契约**逐字不变**。所以下面每个函数体
 * 都是从宿主**逐字节**复制过来的（对拍闸 `ws_namejoy_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 为什么是 `createNameHost(ctx)` 这个工厂
 * 这批函数闭包着宿主一堆 setup 期局部量（`stats` / `fetchCell` / `perf` / `renderKind` / `drawnBld`）。
 * 改成"每次调用都传参"就要逐处改写成 `ctx.xxx` ⇒ 那就不是"只搬不改"了。
 * ⇒ 宿主构造只读 ctx 递进来，工厂在这里**解构一次**。
 *
 * ## 🔴 两处**别名**（宿主那面是 `let`，JS 里没法按引用共享 —— 与 S4 的 `alive` 同一条处理）
 * ① `alive` → **每次现读** `ctx.aliveNow()`（8 处）：宿主在 `onBeforeUnmount` 里把它置 false，
 *    而这些函数有的会跑在定时器/rAF/微任务里（`setTimeout` 收尾、`requestAnimationFrame` 摘旗、
 *    `refresh()` 的 await 之后）⇒ **不许在入口冻成快照**（那正是 S4 里逐字写下的理由）。
 * ② `map` → `ctx.mapNow()`（1 处，在喂给 `createNameLayer` 的那个取值器里）：宿主那份是 `let`
 *    （建图时赋值、降级/卸载时置 null）⇒ 解构只会拿到快照，而"降级后名字层不许再要地图"这条
 *    判据就靠它每次现读。
 * ③ `drawnBld` → `ctx.drawnBldNow()`（1 处）：它是宿主 `afterDraw` 每轮重写的 `let`
 *    （"真正画出去的那批楼"），名字层必须读**当下**那一份。
 *
 * ## 本片**没搬**的（照实留痕）
 * · `labRootClass`（模板上那个 `:class`）**故意留在宿主**：它同时读 `cameraMoving`（M1/宿主）
 *   与 `joyZoomPulling`（摇杆那一路）—— 搬进来就要把两个别的域的状态也拖进来。
 * · `drawnBld`（宿主 `afterDraw` 写、`nearestDrawnBuilding` 也读）、`cameraMoving`（M1 与 M5 都在写）、
 *   `stats` / `fetchCell` / `perf` 的所有权仍在宿主。
 * · `applyNamePlan` 目前**没有任何调用点**（2026-10-04 实查：全文件只有定义处）—— 死代码这件事
 *   **不在本片处理**（§3 把删死代码排在 S9），本片照样整块搬过来、一个字没改。
 */

import { computed, ref } from "vue";
import {
  LABEL_MOTION,
  createNameLayer,
  nameVerdictLine,
  type NameMapLike,
  type NameRenderNode,
  type NameRenderPlan,
} from "./wsNameLayer";
import type { NameHostCtx } from "./wsStageTypes";

/**
 * 装配名字层这一层：宿主把只读 ctx 递进来，拿回全部 ref / 函数。
 *
 * ⚠️ 调用点必须在 `stats` / `fetchCell` / `perf` / `renderKind` / `drawnBld` 都声明之后
 * （本片放在宿主原来那段的位置：离线包管道之后、`createMapCamera` 之前）：
 * `createNameLayer` 会**同步**调一次 `host.enabled()` ⇒ 早引必踩 TDZ（本仓对 TDZ 有过前科）。
 */
export function createNameHost(ctx: NameHostCtx) {
  const { stats, fetchCell, perf, renderKind } = ctx;
  const { aliveNow, mapNow, drawnBldNow } = ctx;

  /** 动效降级两问（2026-10-04 从宿主搬来：**只有这一族函数读它们**，见文件头"为什么搬"）。
   *  `perfLow` 原先声明在宿主更靠后的位置，而它在宿主里的**第一个读点就在本文件搬走的那三个
   *  函数里** ⇒ 跟着一起走才不用"入口冻结"或取值器（那两种都要改正文）。 */
  const perfLow = computed(() => !!perf.low.value);
  function reducedMotion(): boolean {
    try {
      return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch { return false; }
  }

  /** 名字层开关：`?names=0` 关（排查用；默认开）。
   *  🔴 **必须声明在 `createNameLayer()` 之前**：`createNameLayer` 里会**同步**调一次
   *  `host.enabled()`（初始化事实）⇒ 声明在后就是 TDZ `ReferenceError`，
   *  而它会**整块炸掉地图的 setup**（真浏览器实测：`Cannot access 'er' before initialization`
   *  ⇒ `.ws-dml` 根本没挂上 ⇒ 整屏只剩顶栏）。这条是探针抓出来的，不是推出来的。 */
  const namesOn = ref(!/[?&]names=0/.test(String(typeof location !== "undefined" ? location.search : "")));
  const nameLayer = createNameLayer({
    map: () => (renderKind.value === "fallback2d" ? null : (mapNow() as unknown as NameMapLike | null)),
    fetchCell,
    enabled: () => namesOn.value,
    /* 行政区名：街区级这一屏**没有**名册（城市包线还没给）⇒ 如实传空（不是"这里没有行政区"） */
    admins: () => [],
    drawnBuildings: () => drawnBldNow(),
    onPlan: (plan, facts) => { applyNamePlanWithHud(plan, nameVerdictLine(facts)); },
    onError: (why) => {
      stats.note = stats.note ? `${stats.note} · ${why}` : why;
    },
  });
  /** 名字层开关：`?names=0` 关（排查用；默认开；**声明见上**，在 `createNameLayer` 之前） */
  const namePlan = ref<NameRenderPlan>({ mode: "names", nodes: [], batch: 0, lite: false, cameraOpacity: LABEL_MOTION.cameraOpacity });
  /** 屏上的节点（**节点池复用**：只在"换批"时替换数组内容） */
  const nameNodes = ref<NameRenderNode[]>([]);
  /** 换批中（"先隐后改字"：整层 opacity≈0 的那一帧才改 textContent） */
  const switching = ref(false);
  const labRootEl = ref<HTMLElement | null>(null);
  /* 🆕 2026-10-01（机主：「换字动画我想要的是**像高德地图那样可以不用重算**的」）──────────────
     两条：① 集合**没变** ⇒ 只更新坐标，**不加任何整层类**；
          ② 集合**真变了** ⇒ 只让**新来的/要走的**那几张各自淡入/淡出（不是整层一起换）。
     数据全来自**共享真源**的 `plan.changed / plan.entered / plan.exited`（宿主不自己算 diff）。 */
  /** 这一批**新进来**的节点 id（给这几张挂 `is-enter`，两帧后摘掉 ⇒ 120ms 淡入） */
  const nameEnter = ref<string[]>([]);
  /** 这一批**要走的**节点（单独一层 DOM：先原样显示，再加 `is-ghost-out` 淡出，随后移除） */
  const nameGhosts = ref<NameRenderNode[]>([]);
  /** 幽灵的淡出态（两帧后才置 true ⇒ 才有一趟真正的过渡，而不是"一挂上就是透明"） */
  const ghostFading = ref(false);
  let enterTimer = 0;
  let ghostTimer = 0;
  /* 🆕 「传送帧」：相机停下时把容器位移烘进节点坐标（`reproject`）—— 那次坐标重写**必须看不见**，
     但它落在 `.ws-lab` 的 `transition: transform 90ms` 上 ⇒ 画面会先退回拖动前再滑过来（实测反向行程 84px）。
     ⇒ 举旗一帧（`.ws-labs.is-snap .ws-lab:not(.is-enter):not(.is-ghost) { transition: none; }`）。 */
  const snapping = ref(false);
  let snapRaf1 = 0;
  let snapRaf2 = 0;
  /** 🏷 换批（"先隐后改字"）的定时器：新的一批到了要把它清掉（旧的不许覆盖新的）；卸载时要清 */
  let switchTimer = 0;

  function labClassOf(style: NameRenderNode["style"]): string {
    return style === "real" ? "is-real" : style === "derived" ? "is-derived" : "is-generated";
  }

  /**
   * 把**渲染计划**落到 DOM。🔴 三条纪律：
   * ① **位置只在此时写一次**（`translate3d`），相机运动期间一个字都不许再写节点；
   * ② 集合**没变** ⇒ **只更新坐标**，不加任何整层类（机主要的"像高德那样跟手滑"，2026-10-01）；
   * ③ 集合**真变了** ⇒ **只让新来的/要走的这几张各自淡入淡出**（`plan.entered/exited`），
   *    不再是整层淡化；**绝不允许"看着旧名字变成新名字"**（节点 key 带 id ⇒ 换名字 = 换元素）。
   */
  function applyNamePlan(plan: NameRenderPlan): void { applyNamePlanWithHud(plan, ""); }
  /**
   * 把**渲染计划**落到 DOM，并**在同一刻**写 HUD 那一行。
   *
   * 🔴 为什么 HUD 必须跟着节点一起写（2026-09-26 真浏览器实测的坑）：
   *   原来是 `refresh()` 里回调落节点（换批时**延迟 120ms** 做"先隐后改字"）、
   *   而 `stats.names` 在 `refresh()` 返回后**立刻**写 ⇒ 有 120ms 的窗口里
   *   **HUD 说的是新一批、屏上是旧一批**（实测抓到 `区名模式` 与"屏上 8 个真名"同时出现，
   *   其实是两批数据）。探针/机主读到的就是这种自相矛盾的一行。
   *   ⇒ 现在 HUD 文本随节点一起赋值，**两者永远描述同一批**。
   *   ⚠️ 同时把"上一批的切换定时器"清掉：否则后到的批会被先到的定时器覆盖（旧覆盖新）。
   */
  function applyNamePlanWithHud(plan: NameRenderPlan, hud: string): void {
    const changed = plan.batch !== namePlan.value.batch;
    namePlan.value = plan;
    if (switchTimer) { window.clearTimeout(switchTimer); switchTimer = 0; }
    const commit = (afterPaint = false): void => {
      nameNodes.value = plan.nodes;
      if (hud) stats.names = hud;                 // ← 与节点同一批（不许 HUD 领先屏上）
      /* 🔴 `switching` **必须在这里也清掉**：新的一批会 `clearTimeout(上一批的定时器)`，
         被清掉的那一批的"收尾 16ms"就永远不会跑 ⇒ 容器永久停在 `is-switching`（opacity 0）
         ⇒ 名字层**看不见了**（真浏览器实测抓到 `rootClass: "ws-labs is-switching"`）。
         现在：只有走了"延迟换字"的路径才需要等一帧再摘类，其余路径立刻摘。 */
      if (afterPaint) window.setTimeout(() => { if (aliveNow()) switching.value = false; }, 16);
      else switching.value = false;
    };
    if (!changed) {
      /* 同一批：数量/名字都没变 ⇒ 只更新坐标（**一次批量写**，moveend 才走到这里） */
      commit();
      return;
    }
    if (perfLow.value || reducedMotion()) {
      /* 降级（§4.1 降级表）：**保留三幕结构但去掉错峰**；reduced-motion 下纯淡入淡出（不缩时长） */
      commit();
      return;
    }
    /* 🆕 2026-10-01 机主：「换字动画我想要的是**像高德地图那样可以不用重算**的」——
       集合真变了时**只让新来的/要走的这几张各自淡入淡出**，屏上其余标签一张都不动。
       ⚠️ 红线不变：节点 key 是 `slot:id` ⇒ 换了 id 就是**换元素**，不会"看着旧名字变成新名字"；
          退场的那张走幽灵层（`span`，不可点），进场的那张从 0 淡到 1。 */
    if (plan.changed !== undefined) {
      commit();                                    // ← 位置/文案先落地（**不整层淡化**）
      fadeInNew(plan.entered || []);
      fadeOutGone(plan.exited || []);
      return;
    }
    /* ⬇️ 兜底：计划没带 `changed`（模块比宿主旧）时，仍走原来的"整层先隐后改字"（逐字保留旧行为） */
    switching.value = true;
    switchTimer = window.setTimeout(() => {
      switchTimer = 0;
      if (!aliveNow()) return;
      commit(true);                                 // ← 换字发生在整层看不见的那一帧
    }, LABEL_MOTION.nameOutMs);
  }

  /**
   * 🆕 **只给新来的那几张**播淡入（`is-enter`：opacity 0 → 1，用 `.ws-lab` 已有的 120ms 过渡）。
   * 两帧后摘类：① 让 Vue 先把带 `is-enter` 的节点挂上去 ② 让浏览器结算这一帧
   * ⇒ 才有"从 0 淡进来"的过渡，而不是"一出现就是全亮"。
   * 降级/减少动效下**不播**（不是缩短时长）。
   */
  function fadeInNew(ids: string[]): void {
    if (!ids.length || perfLow.value || reducedMotion()) return;
    nameEnter.value = ids.slice();
    if (enterTimer) window.clearTimeout(enterTimer);
    enterTimer = window.setTimeout(() => {
      enterTimer = 0;
      if (aliveNow()) nameEnter.value = [];
    }, 32);
  }

  /**
   * 🆕 **只给要走的这几张**播淡出：先按原样挂进幽灵层，两帧后加 `is-ghost-out` 淡到 0，
   * `nameOutMs` 之后移除。**不占** `nameNodes` 的节点池（否则复用池会把它当场改成别人的文案）。
   */
  function fadeOutGone(nodes: NameRenderNode[]): void {
    if (!nodes.length || perfLow.value || reducedMotion()) return;
    nameGhosts.value = nodes.slice();
    ghostFading.value = false;
    if (ghostTimer) window.clearTimeout(ghostTimer);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (aliveNow()) ghostFading.value = true; });
    });
    ghostTimer = window.setTimeout(() => {
      ghostTimer = 0;
      if (!aliveNow()) return;
      nameGhosts.value = [];
      ghostFading.value = false;
    }, LABEL_MOTION.nameOutMs + 40);
  }

  /**
   * 🆕 **就地重投影**（`moveend` / `zoomend` 调）：把容器上那份位移烘进节点坐标，**只重投影、不重排**。
   *
   * 为什么还要举一帧 `is-snap`（2026-10-01 真浏览器逐帧实测）：
   *   这次坐标重写是一次"传送"——容器同时从 `translate3d(Δ)` 归零、节点坐标加上同一个 Δ，
   *   **两者同帧 ⇒ 画面本该一动不动**。但 `.ws-lab` 上有 `transition: transform 90ms`，
   *   浏览器会把节点自己的坐标变化**做成过渡** ⇒ 实测屏幕 x 序列出现
   *   `…273,273,**190**,234,261,280,283…`：先退回拖动前（反向行程 **84px** = 拖动量），再用 ~88ms 滑到位。
   *   ⇒ 举旗一帧把过渡掐掉（**只掐传送**：`:not(.is-enter):not(.is-ghost)` ⇒ 淡入淡出照旧）。
   *
   * 🔴 举旗必须在**同一 tick**、且在 `reproject()` 之前：Vue 的 patch 是微任务，两者会落在同一次 DOM 变更里
   *   （只加类不换坐标 = 白掐；只换坐标不加类 = 又滑一遍）。
   *   摘旗用 **rAF 两帧**（不是 `setTimeout` 猜时长）：第一帧让浏览器带着 `transition:none` 画完这次传送，
   *   第二帧恢复常态；此时 transform 没再变 ⇒ 不会补一次过渡。
   */
  function reprojectNow(): void {
    if (!namesOn.value || !aliveNow()) return;
    snapping.value = true;
    const rp = nameLayer.reproject();                 // → onPlan → 节点新坐标（同一 tick 入队）
    if (!rp) { snapping.value = false; return; }      // 还没算过任何一批 ⇒ 别留一个死类
    if (snapRaf1) cancelAnimationFrame(snapRaf1);
    if (snapRaf2) cancelAnimationFrame(snapRaf2);
    snapRaf1 = requestAnimationFrame(() => {
      snapRaf1 = 0;
      snapRaf2 = requestAnimationFrame(() => {
        snapRaf2 = 0;
        if (aliveNow()) snapping.value = false;
      });
    });
  }

  /** 名字层刷新（moveend / load 之后调；**不阻塞首屏**） */
  async function refreshNames(why = "view"): Promise<void> {
    if (!namesOn.value || !aliveNow()) return;
    try {
      /* 判词由**真源**给；它跟着节点一起落进 HUD（见 `applyNamePlanWithHud`）⇒ 不用再写一次 */
      await nameLayer.refresh(why);
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 名字层：${String((e as Error)?.message || e).slice(0, 40)}` : `名字层：${e}`;
    }
  }

  /**
   * 卸载收尾：把本文件那**五个**定时器/两帧句柄全清掉（宿主 `onBeforeUnmount` 里那五行）。
   *
   * 为什么要有这个出口：这五个句柄都是**本文件私有的 `let`**（换批 / 进场淡入 / 退场幽灵 /
   * 传送帧举旗摘旗）—— 宿主拿不到它们，而卸载时必须清（宿主原来就是在 `onBeforeUnmount`
   * 里逐个 `if (x) clearTimeout(x)` 的）。**五个判据、顺序与原宿主逐字相同**，只是收进一个函数里。
   */
  function cancelMotion(): void {
    if (switchTimer) window.clearTimeout(switchTimer);
    if (enterTimer) window.clearTimeout(enterTimer);
    if (ghostTimer) window.clearTimeout(ghostTimer);
    if (snapRaf1) cancelAnimationFrame(snapRaf1);
    if (snapRaf2) cancelAnimationFrame(snapRaf2);
  }

  return {
    nameLayer,
    namesOn,
    namePlan,
    nameNodes,
    switching,
    labRootEl,
    nameEnter,
    nameGhosts,
    ghostFading,
    snapping,
    perfLow,
    labClassOf,
    applyNamePlan,
    applyNamePlanWithHud,
    fadeInNew,
    fadeOutGone,
    reprojectNow,
    refreshNames,
    cancelMotion,
  };
}
