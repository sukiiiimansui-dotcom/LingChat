/* wsPickInteract.ts —— S7（M7）：**交互命中**（钉子 / 吸附 / 锚点 / AI 示意层 / 信息卡点选）。
 *
 * ## 这个文件是什么
 * 从 `WsDistrictMapLibre.vue` **整块搬出来**的那一段（锚点 = **函数名 / 标识符**，不按行号）。
 * 搬了两段：
 *   ① `gridToLngLat` · `pinEl` · `removeAiLayers` · `syncAiLayers` · `SNAP_MAX_M` / `snapPin` ·
 *      `ensurePinAnchor` · `syncPins`（连同 `SNAP_MAX_M` 这个只有 `snapPin` 读的常量、
 *      以及 AI 示意层那一段说明与"两个 watcher 都关掉"那条注释）；
 *   ② 信息卡那一族：`cardData` / `cardOpen` / `openCard` / `closeCard` / `indexFactOfNames` /
 *      `openCardFromNode` / `panel`（`useWsPanel()` 那个模块级单例）/ `bldClickLayersNow` /
 *      `onMapClick` / `nearestDrawnBuilding` / `firstCoordOf`。
 * ⚠️ `gridToLngLat` / `removeAiLayers` / `closeCard` / `indexFactOfNames` / `bldClickLayersNow` /
 *    `panel` / `cardData` / `cardOpen` **不在任务书 §0.1 那张锚点表里**，但它们在两段的**范围之内**、
 *    且消费者全在这两段里（`gridToLngLat` 只被 `syncPins` 调、`indexFactOfNames` 只被 `openCard` 调、
 *    `bldClickLayersNow` 只被 `onMapClick` 调、`panel` 只被 `onMapClick` 读、`closeCard` 只被模板读）
 *    ⇒ 按"整段搬、不切岛"处理，名字**一个字都没改**（宿主那边同名解构回去）。
 *
 * ## 没搬的（照实留痕；§1.4「迁不动的就别搬并写清理由」）
 * · `domPins`（任务书 §0.1 把它列进 M7 了）—— **留在宿主**。理由：它唯一的同步消费点
 *   `createFallback2d({ … domPins … })` 在宿主第 2669 行，而**本工厂的装配点必须在
 *   `nameLayer` / `labRootEl`（2825）与 `panel`（2964）之后**（它们是 `const`，早引必踩 TDZ）
 *   ⇒ 把 `domPins` 搬进来就成了"M6 要 M7 的产出、M7 又排在 M6 之后"的环。
 *   它还有两个宿主读者（模板 `v-for="p in domPins"` 与 2552 那个 watch），留在宿主一处都不改。
 * · AI 示意层的**两个 `watch`**：本来就已经被注释关掉了（2251–2256 那段注释跟着本段搬走，
 *   因为它讲的就是这两个 watcher 为什么关）—— 关着的东西没有代码可搬。
 *
 * ## ctx 的落法（与 S2~S6 同一套）
 * 宿主构造一份只读 ctx，本工厂在开头**解构一次**，解构出来的名字与搬走前宿主里的闭包变量**同名**
 * ⇒ 下面这些函数的函数体几乎一个字节都不用改（对拍闸 `ws_pickinteract_move_selftest.mjs` 断言 diff = 0）。
 *
 * ## 🔴 只有六类别名（逐类可数；对拍闸把每一类都机器化，多一处少一处都红）
 * ① `map` → `mapNow()`（**5 处**，全是内联）：宿主那面是 `let`（建图时赋值、降级/卸载时置 null），
 *    布尔/对象没法按引用共享 ⇒ 与 S4/S5/S6 同一条落法，**每处现读**（它们都在函数体里同步读一次，
 *    与原实现读的时刻完全相同）。
 * ② `mlMod` → `const mlMod = mlModNow();`（**1 处 hoist**，写进 `syncPins` 体首）：
 *    `new mlMod.Marker(...)` 里的 `new` 对箭头调用有优先级坑（`new mlModNow().Marker()` 会被解析成
 *    `new (mlModNow())().Marker()`）⇒ 体首现读一次、下面两处逐字不动。`syncPins` **全程同步**，
 *    两处读之间没有任何东西会重写 `mlMod` ⇒ 与逐处现读逐条等价。
 * ③ `pins` → `const pins = pinsNow();`（**1 处 hoist**，同一个体首）：`pins` 既读又写
 *    （`pins = pins.filter(…)` 是**重新赋值**），宿主是唯一拥有者（`pinEdgeSync` 与 M5 的 ctx 都在读它）
 *    ⇒ 体首取一次、写回走写入器，模块不养第二份。
 * ④ `pins = …` → `setPins(…)`（**1 处**）：同上，写入器与 S6 的 `setRoadSegs` / `setDrawnBld` 同款。
 * ⑤ `roadSegs` → `roadSegsNow()`（**2 处**）：宿主那个 `let` 由 M3（`setRoadSegs`）写，这里只读。
 * ⑥ `drawnBld` → `drawnBldNow()`（**1 处**）：宿主那个 `let` 每轮由 `afterDraw` 重写 ⇒ 取值器。
 * ⚠️ 除这六类，**没有**任何别的正文改动：分支 / 阈值 / 调用顺序 / DOM 契约（`data-ws-*` / 类名 / `id`）
 *    逐字不变。`syncPins` 里那个 `const alive = new Set<string>()` 是**块内局部量**，
 *    与宿主那面 `alive` 旗无关 ⇒ 一个字都没动。
 *
 * ## 装配位置（TDZ）与依赖方向
 * 宿主那处 `createPickInteract({…})` 落在原来"信息卡那一族"的位置（`panel` 声明之后）：
 * 它要的 `nameLayer` / `labRootEl` 是 2825 那一行 M4 解构出来的 `const` ⇒ 早于它必踩 TDZ。
 * 下游调用点（宿主 1547 / 2559 / 2610 / 3891、模板 101、M5 的 ctx）**一个字都没改**
 * —— 它们读的是宿主同名解构出来的**同一个函数**（本文件是唯一实现，没有第二份）。
 * 依赖方向（§2.2）：本模块属 L2，**不 import 宿主**，也不与任何 M* 横向 import（共享量全由宿主注入）。
 */
import { ref } from "vue";
import { aiFeatureCollection } from "./wsAiLayers";
import type { WsDistrictPin } from "./wsActors";
import { snapToRoad } from "./wsSnap";
import { buildingCardData, type CardData } from "./wsBuildingCard";
import { bldTierOfZoom } from "./wsBldBudget";
import { ROAM_PIN_ID, roamStore } from "./wsJoystick";
import type { NameRenderNode } from "./wsNameLayer";
import { useWsPanel } from "@/composables/useWsPanel";
import type { PickInteractCtx } from "./wsStageTypes";

/**
 * 装配 M7（交互命中：钉子 / 吸附 / 锚点 / AI 示意层 / 信息卡点选）。
 * ⚠️ 位置与理由见文件头「装配位置（TDZ）与依赖方向」那一段。
 */
export function createPickInteract(ctx: PickInteractCtx) {
  /* 解构出来的名字**与搬走前宿主里的闭包变量同名** ⇒ 下面函数体一个字都不用动（见文件头）。 */
  const { props, stats, theme, aiOn, aiDrawn, aiBboxRef, bboxRef, emit } = ctx;
  const { labRootEl, nameLayer, pinEdgeMeasure, pinEdgeSync } = ctx;
  const { mapNow, mlModNow, pinsNow, setPins, roadSegsNow, drawnBldNow } = ctx;

  /**
   * 网格 → 经纬度（**示意映射**）：把 28×28 的草图网格线性铺到区界 bbox 上。
   *
   * 为什么这里会有问题？因为严格来说这个映射**没有物理意义** —— 草图是程序生成的虚构街区，
   * 它和真实经纬度之间从来没有过换算关系（这是当初"想把草图贴到真实地图上"失败的根因）。
   * 现在这么做的语义是"**人在这个区里的相对位置**"：看得出谁在区的东边、谁在江对岸，
   * 但别指望它能对上某条具体街道。真正要精确，得让角色位置本身带经纬度（另一张卡）。
   */
  function gridToLngLat(gx: number, gy: number): [number, number] | null {
    const b = bboxRef.value;
    if (!b) return null;
    const g = Math.max(2, Math.round(props.grid || 28));
    const [w, s, e, n] = b;
    const lng = w + ((gx + 0.5) / g) * (e - w);
    /* 纬度要翻转：网格 y 向下增大，纬度向北增大（当年第一次写这个就忘了翻，人全跑到海里去了…） */
    const lat = n - ((gy + 0.5) / g) * (n - s);
    return [lng, lat];
  }

  /**
   * 造一个"人"的 DOM（用行内样式：scoped CSS 管不到运行时 new 出来的元素）。
   *
   * 🎯 切片②（2026-10-01）：**命中区 ≥44×44，视觉尺寸一点不变**——
   *   外面套一个 44×44 的**透明**盒（`hit`），原来那个 26/30px 的圆照旧居中。
   *   手法是项目既有的"透明外扩"（HUD 的 `.ws-dml__theme::after{inset:-12px -6px}`）；
   *   `min-width/height:44px` 那套（`WsCityEntry.vue:423-424`）会把底板也放大，这里不能用。
   *   ⚠️ 交给 `Marker` 的**必须是外层这个 `hit`**：`anchor:"center"` 与探针读的
   *   `.maplibregl-marker`（数量 / `title`）都落在它上面。
   */
  function pinEl(a: WsDistrictPin): HTMLElement {
    const hit = document.createElement("div");
    hit.style.cssText = [
      "width:44px",
      "height:44px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:transparent",
      "pointer-events:auto",
      /* 🔴 2026-10-01（切片② 真页面验收代理发现）：**「我」那颗钉不要压在别人身上**。
         `districtPinsOf` 把 me 排在最后 ⇒ 同 z-index 时它后画、盖在最上面；
         而没定位时 me 落在格心、只有一个角色时散点也在格心 ⇒ 那颗角色钉的 44×44 里
         **每一点都打到 me**（实测 `blockedBy: me`、点谁都是自己）。
         这里只给 z-index 排个序（角色 2 > 我 1）：命中判定看的是**最上面**那个元素，
         所以点下去先落到角色身上；视觉上也是"别人站在我前面"，与直觉一致。 */
      a.isMe ? "z-index:1" : "z-index:2",
    ].join(";");
    /* 钉子 id 落在**命中区**上（这是产品自己的 DOM 契约，不是调试出口）：
       自动化点外层任意一处都算点到这个人。 */
    hit.dataset.wsPinId = a.id;
    hit.addEventListener("click", (ev) => {
      /* 🔴 `stopPropagation()` 不能省：同一个点击会冒泡到地图容器 ⇒ 顺带把楼卡也弹出来
         （`onMapClick` 把任意落点当"点楼"，还有 `nearestDrawnBuilding` 兜底）。 */
      ev.stopPropagation();
      emit("pick-actor", a.id);
    });
    const el = document.createElement("div");
    const size = a.isMe ? 30 : 26;
    el.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      "border-radius:50%",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "font-size:12px",
      "color:#06222e",
      "font-weight:600",
      "box-shadow:0 2px 6px rgba(0,0,0,.45)",
      "border:2px solid rgba(255,255,255,.85)",
      a.isMe ? "background:#79d9ff" : "background:#cfe8f5",
      "overflow:hidden",
      "pointer-events:auto",
    ].join(";");
    if (a.avatarUrl) {
      const img = document.createElement("img");
      img.src = a.avatarUrl;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
      el.appendChild(img);
    } else {
      el.textContent = (a.name || "我").slice(0, 1);
    }
    hit.appendChild(el);
    /* 🕹 漫游（近景）时才写的两个子节点 —— **只有「我」有**，别人一颗都不多花：
       · `data-ws-roam-face`：朝向箭头（§4「朝向跟随移动方向」）—— 挂在 `hit` 上而**不是** `el` 里，
         因为 `el` 有 `overflow:hidden` 会把伸出去的箭头剪掉；
       · `data-ws-roam-body`：身体（就是那个圆），踏步动画只写它的 `transform`（§4「就地行走」）。
       ⚠️ 两个都**只在 transform 上动**（位置由 `Marker` 管、布局属性一个字不写）；
       具体每帧写不写由 `joyWalkAnimOn()` 判（`low` 档 / `prefers-reduced-motion` ⇒ 不写）。 */
    if (a.id === ROAM_PIN_ID) {
      el.dataset.wsRoamBody = "";
      const face = document.createElement("i");
      face.dataset.wsRoamFace = "";
      /* 朝向箭头 = 盖满整个 44×44 命中区的一层**透明** overlay，靠 `clip-path` 在正中上方
         画一个小矢头。为什么用"整层 + 裁剪"而不是"一个小三角"：`rotate` 的旋转中心必须是
         **身体中心**（= 这层 overlay 的中心），否则推杆时箭头会绕着身体乱甩；overlay 铺满 hit
         就天然是中心对齐，不用去算 `transform-origin` 的像素偏移。
         `clip-path` 是**绘制属性**（不参与布局），与"每帧只写 transform/opacity"同一条红线。 */
      face.style.cssText = [
        "position:absolute",
        "left:0",
        "top:0",
        "width:100%",
        "height:100%",
        "background:rgba(233,244,255,.95)",
        "clip-path:polygon(50% 2%, 62% 22%, 50% 15%, 38% 22%)",
        /* 朝向箭头**不吃事件**（命中区还是那个 44×44 的 hit） */
        "pointer-events:none",
        /* 提升为独立图层 ⇒ 每帧那次 `rotate` 只走合成器，不重新栅格化（`filter`/`box-shadow`
           一概不加：浮在地图上、每帧都在转的东西，画得越简单越稳） */
        "will-change:transform",
      ].join(";");
      hit.appendChild(face);
      /* 🎯 **预走线**（2026-10-04 第四轮；机主：「能给移动加预走线吗…动画要好看喵！」）——
         结构三件，**每一件每帧最多写一个 transform**（详见 `wsJoystick.ts` 第九节）：
           · `data-ws-roam-aim` 容器：只吃 `rotate(朝向)`（**角度真变了才写**，直着走通常 0 次）；
           · `.ws-aim__dash`    虚线：吃 `scaleX(线长 ÷ 满长)`（每帧 1 次）——里面那层 `.ws-aim__flow`
                                的"流动"是**纯 CSS 动画**（平移恰好一个周期 ⇒ 无缝循环，研究 §12.4），JS 一次都不写；
           · `.ws-aim__tip`     箭头：吃 `translate3d(线长, 0, 0)`（每帧 1 次）。
         ⚠️ 挂在 `hit` 上（与 face 同层）：**位置由 `Marker` 管**，我们一个布局属性都不写；
         它在**钉子自己的 DOM 里** ⇒ 名字层一个节点都不碰（"不与标签打架"的第一条）。
         ⚠️ 显隐**不是**每帧写 `opacity`：`hit` 上的 `is-aim` class 只翻转一次，剩下交给 CSS 过渡
         （入场 140ms / 淡出 320ms ease-out，见文件末尾那段全局样式）—— 这就是"停下优雅淡出"，
         也是"每帧 0 次 opacity 写"的来源。 */
      hit.dataset.wsRoamPin = "";
      const aim = document.createElement("span");
      /* 🔴 2026-10-04 第六轮（机主：「**预走线的轴心不在角色**」）—— **这一行是那一句的全部真因**：
         下面那段全局样式挂在 `.ws-aim` 这个**类**上（`position:absolute; left:50%; top:50%`，
         `transform-origin: 0 0`），而这里原来只写了 `data-ws-roam-aim` 属性、**类名一个字没写**
         ⇒ 那三条定位一条都没生效 ⇒ 这个 span 退回**普通文档流**，而它的父节点 `hit` 是
         `display:flex` 的 44×44（`justify-content:center`）⇒ 它成了**第二个 flex 项**，
         与 30px 的身体圆并排居中 ⇒ 轴心落在 `(44−30)/2 = **15px**` 的**右侧**（= 身体圆的右边缘），
         而不是身体圆心；`rotate()` 于是绕着"身体右边 15px"那一根轴转（"轴心不在角色"就是这个）。
         同一个漏写还让 `opacity:0`（静止时不可见）与 `is-aim` 的淡入淡出**整条失效**。
         ⇒ 补上类名一处即可：轴心回到 `hit` 正中 = **Marker 的锚点** = 角色世界坐标的屏幕投影。 */
      aim.className = "ws-aim";
      aim.dataset.wsRoamAim = "";
      const dash = document.createElement("span");
      dash.className = "ws-aim__dash";
      const flow = document.createElement("span");
      flow.className = "ws-aim__flow";
      dash.appendChild(flow);
      const tip = document.createElement("span");
      tip.className = "ws-aim__tip";
      aim.appendChild(dash);
      aim.appendChild(tip);
      hit.appendChild(aim);
    }
    /* 📍 **屏外方向指示**（2026-10-04 第七条；机主：「其他角色不见了喵」+ 他自己点的「屏外加方向指示」）。
       结构：一个定位容器 + 里面两件（转的箭头 / 不转的距离文案）。
       🔴 三条都是**硬约束**，改它的人先读这三行：
         ① `position:absolute` —— 外层 `hit` 是 `display:flex` 的 44×44，**多一个普通子节点就会变成第二个
            flex 项**、把身体圆挤走（`.ws-aim` 当年就是这么栽的，见它上面那段注释）；
         ② `pointer-events:none` —— 箭头只是指示，**不许**吃掉地图手势、也不许抢 `hit` 的点击；
         ③ 每颗钉子**建一次、之后只复用**（`pinEdgeSync` 只写 `transform` / `textContent` / 一个 class）。
       ⚠️ 「我」那颗钉子**不建**（相机跟着他，"屏外"对他没有意义 —— 机主点的是"其他角色"）。
       ⚠️ 这里只建节点：**位置/朝向/文案一个字都不在这里算**（那些在 `wsPinEdge.ts`，纯函数）。 */
    if (!a.isMe) {
      const edge = document.createElement("span");
      edge.className = "ws-pin-edge";
      edge.dataset.wsPinEdge = "";
      const arrow = document.createElement("i");
      arrow.className = "ws-pin-edge__arrow";
      const dist = document.createElement("em");
      dist.className = "ws-pin-edge__dist";
      edge.appendChild(arrow);
      edge.appendChild(dist);
      hit.appendChild(edge);
    }
    /* 标题里如实带出"位置是怎么来的"：吸附到路上（`road`）和网格示意位置，
       精度完全不是一回事 —— 以后排查"怎么站到江里了"就靠这一行。
       （挂在 `hit` 上 = 挂钩子的那个元素上，`syncPins` 更新 title 时也是它。） */
    hit.title =
      `${a.name || "我"}` +
      (a.posSource === "affinity" ? "（特地来找你）" : "") +
      (a.posSource === "road" ? "（在路上）" : a.posSource === "facility" ? "（在设施旁）" : "");
    return hit;
  }

  /**
   * 把 `markers` 同步到地图上：新增的建 Marker、已有的挪位置、消失的移除。
   * 好累～ 每次 moveend 都要重算一遍吗？不用 —— 网格→经纬度只依赖区界 bbox，
   * 与相机无关，所以只在"人变了 / 区界到了"时同步。
   */
  /* 🧱 缩放那三个（`zoomOnce` 150ms 节流 / `fitDistrict` 全区 / `zoomBy` 按钮缩放）搬进了
     `wsMapCamera.ts`（S3 / M1）。它们**目前没有任何调用点**（模板里 `＋ / － / 全区` 早已整块移除）
     —— 是死代码这件事不在本片处理（§3 把删死代码排在 S9），搬的时候一个字没改。 */

  /**
   * 把 AI 的产出同步到地图上（楼 → 挤出、路 → 线、公园/水系 → 面）。
   *
   * ## 什么时候画（机主 2026-09-20 定）
   * 由 `aiOn` 决定 —— **真数据优先**：真楼 ≥ 40 栋就整层摘掉，稀疏（含 0 栋）才画。
   * 所以这个函数是**双向**的：开的时候建图层，关的时候**必须把图层删掉**。
   * （以前这里只在 `!props.showAi` 时 `return` ⇒ 先开过后关会留下一层摘不掉的暖色楼。
   *  假数据留在画面上不发声明，比不画更坏。）
   *
   * ## 铺在哪（重要）
   * 用 `aiBboxRef`（**小区尺度的正方形**，边长 `AI_SPAN_M`），**不是**区县 bbox。
   * 原因见 `AI_SPAN_M` 的注释：涪陵区 bbox 有 75km 宽，28 格铺上去一格就 2.7km，
   * 那是薄饼不是楼。铺在驻地的 700m 方块里，一格 ≈ 25m，才和真楼同一个量级。
   *
   * ## 尺度是编的、位置也是编的 —— 所以 HUD 必须标"非事实"
   * 颜色口径照旧：真楼冰蓝 / 示意暖色（`#d9a06b`），两条路一眼分得开。
   */
  function removeAiLayers(m: {
    getLayer(id: string): unknown;
    removeLayer(id: string): void;
    getSource(id: string): unknown;
    removeSource(id: string): void;
  }): void {
    /* 顺序不能反：**先删图层再删源**（源还被图层引用时删不掉，且会抛错） */
    for (const id of ["ai-road", "ai-bld", "ai-area"]) {
      try {
        if (m.getLayer(id)) m.removeLayer(id);
      } catch {
        /* 已经没了 */
      }
    }
    try {
      if (m.getSource("ai")) m.removeSource("ai");
    } catch {
      /* 已经没了 */
    }
    aiDrawn.value = 0;
  }

  function syncAiLayers(): void {
    const m = mapNow() as unknown as {
      getSource(id: string): { setData(d: unknown): void } | undefined;
      addSource(id: string, spec: Record<string, unknown>): void;
      addLayer(spec: Record<string, unknown>, beforeId?: string): void;
      getLayer(id: string): unknown;
      removeLayer(id: string): void;
      removeSource(id: string): void;
    } | null;
    if (!m || !bboxRef.value) return;
    /* 真数据够了 ⇒ 把示意层摘干净（"真数据优先"的落地动作） */
    if (!aiOn.value) {
      removeAiLayers(m);
      return;
    }
    const bbox = aiBboxRef.value || bboxRef.value;
    const fc = aiFeatureCollection(props.aiItems || [], bbox, props.grid || 28);
    /* 如实记账：AI 还没吐出东西时 `aiDrawn` 就是 0，HUD 那句会写"待生成"而不是"已叠加" */
    aiDrawn.value = fc.features.length;
    if (!fc.features.length) return;
    const src = m.getSource("ai");
    if (src) {
      src.setData(fc);
      return;
    }
    m.addSource("ai", { type: "geojson", data: fc });
    /* 面（公园/水系）在楼之下；楼用暖色挤出；路最上 */
    m.addLayer({
      id: "ai-area",
      type: "fill",
      source: "ai",
      filter: ["in", ["get", "kind"], ["literal", ["park", "water"]]],
      paint: {
        /* 配色跟主题走（二次元的水是**明亮青蓝**）：原来这里是写死的 rgba，
           换主题时它不会跟着变 ⇒ 两套风格打架。 */
        "fill-color": ["match", ["get", "kind"], "park", theme.value.ai.park, theme.value.ai.water],
      },
    });
    m.addLayer({
      id: "ai-bld",
      type: "fill-extrusion",
      source: "ai",
      filter: ["==", ["get", "kind"], "building"],
      paint: {
        "fill-extrusion-color": "#d9a06b",
        "fill-extrusion-height": ["coalesce", ["get", "height"], 12],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.9,
      },
    });
    m.addLayer({
      id: "ai-road",
      type: "line",
      source: "ai",
      filter: ["==", ["get", "kind"], "road"],
      paint: { "line-color": "rgba(255, 226, 170, 0.55)", "line-width": 1.6 },
    });
  }

  /* 🗄 2026-09-24 机主裁定「App 页现在只准保留代拍页代码」⇒ **AI 示意层两个 watcher 都关掉**
     （`syncAiLayers()` 本身留在文件里，随时可恢复）。原文如下，恢复时按它改回：
       · 「AI 产出变了就同步（流式生成时每来一批都会调）」→ `watch(() => props.aiItems, …)`
       · 「真楼数变了 ⇒ `aiOn` 可能翻转 ⇒ 自动叠上 / 摘掉示意层」→ `watch(aiOn, …)`
     ⚠️ 只关"画到地图上"这一半：`aiOn` 这个 computed 仍然照旧（HUD 那句"真楼 N 栋（稀疏）…"
        读的就是它 —— 别把"计数"和"上屏"混为一谈）。 */

  /**
   * 把"示意位置"吸附到**真实路网**上（`wsSnap.snapToRoad`）。
   *
   * 这一步是"把行人挪到路上"的**实际落点**：网格坐标是草图空间的示意值，
   * 直接画到地图上会**落在楼里/江里**；吸附到最近的路段上（投影点，不是顶点）之后，
   * 位置才与底图/路网自洽 —— `DESIGN-AUTONOMY.md` 的"角色自己出门"也才有意义。
   *
   * ⚠️ 超过 `SNAP_MAX_M` 就**不吸**（返回 null ⇒ 保持原位）：
   * 路网在 2km 外时硬吸过去就是**瞬移**，比"位置不精确"糟糕得多。
   */
  const SNAP_MAX_M = 220;
  function snapPin(pos: [number, number]): { pos: [number, number]; snapped: boolean; segName?: string | null } {
    if (!props.snapPins || !roadSegsNow().length) return { pos, snapped: false };
    const hit = snapToRoad(pos, roadSegsNow(), SNAP_MAX_M);
    if (!hit) return { pos, snapped: false };
    return { pos: hit.point, snapped: true, segName: hit.seg.name ?? null };
  }

  /**
   * 🧭 **没有 adcode 时的锚点**（新入口 `/worldsim` 就是这一种：城市包没有"区县"这一级）。
   *
   * 为什么必须有：`markers` → 屏幕位置的换算要一个 bbox（`gridToLngLat`）。没有它，
   * 角色**一个都画不出来** —— 而原来那条 `return` 是**静默**的（见下面 `syncPins`）。
   * 口径（**我们选的**，不是"行业标准"）：
   *   · 只在**还没有锚点**时用**当前视野**兜一次（`map.getBounds()`），**设一次就固定** ——
   *     否则每拖一次地图人就跟着重排一次（那正是"鬼影"的观感来源）；
   *   · 网格坐标本来就是**示意**位置（`posSource:"scatter"`/`"schedule"`），
   *     "人在当前城市视野里"与既有语义一致；
   *   · 有 adcode 时**一行都不走这里**（官方那条管线逐字不变）。
   * ⚠️ 第一版把它写在 `map.on("load")` 之前 ⇒ 那时 `map` **还是 null**（`map = m` 在这一段之后），
   *    于是这段代码**永远不会执行**、而 HUD 只显示"没有锚点"（探针一眼看出 0 个角色）。
   *    放在这里（`syncPins` 的入口）是**唯一**能保证"map 一定在"的位置。
   */
  function ensurePinAnchor(): boolean {
    if (bboxRef.value) return true;
    if (props.adcode) return false;                 // 有 adcode ⇒ 走官方那条（geoJson → bbox）
    const m = mapNow() as unknown as { getBounds?: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } } | null;
    try {
      const bb = m?.getBounds?.();
      const w = bb?.getWest(), s0 = bb?.getSouth(), e = bb?.getEast(), n = bb?.getNorth();
      if ([w, s0, e, n].every((v) => Number.isFinite(Number(v))) && Number(e) > Number(w) && Number(n) > Number(s0)) {
        bboxRef.value = [Number(w), Number(s0), Number(e), Number(n)];
        stats.pinsAnchor = "视野兜底（无 adcode）";
        /* 锚点是**视线兜底**出来的 ⇒ 位置上屏必须如实标出来（不许冒充真实经纬度） */
        return true;
      }
    } catch {
      /* 拿不到就保持 null —— 下面会如实写"数不出来：没有锚点" */
    }
    return false;
  }

  function syncPins(): void {
    const m = mapNow();
    const mlMod = mlModNow();
    const pins = pinsNow();
    if (!m || !mlMod?.Marker) return;
    ensurePinAnchor();
    if (!bboxRef.value) {
      /* 🔴 **不静默**：这条 `return` 以前什么都不说，于是"没有锚点 ⇒ 一个钉子都画不出"
         在屏幕上与"名单是空的"长得一模一样（机主看到"地图上没人"，无从判断是哪一种）。
         三态如实写：锚点没有 ⇒ 数不出来 + 原因。 */
      stats.pinsNote = "数不出来：还没有锚点 bbox（adcode 为空且视野也拿不到）⇒ 一个人都放不下";
      stats.pins = 0;
      return;
    }
    const list = props.markers || [];
    const alive = new Set<string>();
    /* 🕹 漫游期间「我」的位置真源是 `roamStore`（不是网格坐标）：**这期间谁来同步都不许把它挪走**。
       不特判的话，松手那一次重算（`refreshBundles` 换了 `markers` 数组）就会走到这里，
       把刚走了几步的「我」一把打回格心 —— 机主看到的就是"走了两步又弹回去"。 */
    const roam = roamStore.get();
    for (const a of list) {
      let pos: [number, number];
      if (a.id === ROAM_PIN_ID && roam) {
        pos = [roam.lng, roam.lat];
      } else {
        const raw = gridToLngLat(a.gx, a.gy);
        if (!raw) continue;
        pos = snapPin(raw).pos;
      }

      alive.add(a.id);
      const hit = pins.find((x) => x.id === a.id);
      if (hit) {
        hit.mk.setLngLat(pos);
        hit.el.title = `${a.name || "我"}${a.posSource === "affinity" ? "（特地来找你）" : ""}`;
      } else {
        const el = pinEl(a);
        /* 🔴 `subpixelPositioning: true` **不是调参，是消抖的必需项**（研究 §11.1，2026-10-04 第四轮）：
           MapLibre 官方源码 `Marker._update()` 逐字 —— "because rounding the coordinates at every `move`
           event causes stuttered zooming, we only round them when `_update` is called with `moveend`
           or when its called with **no arguments** (when the Marker is initialized or **`Marker#setLngLat`
           is invoked**)" ⇒ 默认（`@defaultValue false`）下**我们每帧那次 `setLngLat` 都会把钉子
           `.round()` 到整数 CSS 像素**：地图以亚像素连续滚动、钉子却一格一格跳。
           官方为此专门提供了 `subpixelPositioning`，文档原话是"**If true, rounding is disabled for
           placement of the marker, allowing for subpixel positioning and smoother movement when the
           marker is translated**"。游标只影响"要不要 `.round()`"，对静止的钉子零代价。 */
        const mk = new mlMod.Marker({ element: el, anchor: "center", subpixelPositioning: true }).setLngLat(pos).addTo(m);
        pins.push({
          id: a.id,
          el,
          mk,
          face: el.querySelector<HTMLElement>("[data-ws-roam-face]"),
          body: el.querySelector<HTMLElement>("[data-ws-roam-body]"),
          aim: el.querySelector<HTMLElement>("[data-ws-roam-aim]"),
          dash: el.querySelector<HTMLElement>(".ws-aim__dash"),
          tip: el.querySelector<HTMLElement>(".ws-aim__tip"),
          /* 📍 三件（只有"别人"的钉子上有 ⇒ 「我」那三栏恒 null，`pinEdgeSync` 据此跳过它） */
          edge: el.querySelector<HTMLElement>("[data-ws-pin-edge]"),
          edgeArrow: el.querySelector<HTMLElement>(".ws-pin-edge__arrow"),
          edgeDist: el.querySelector<HTMLElement>(".ws-pin-edge__dist"),
          edgeKey: "",
        });
      }
    }
    for (const p of pins) {
      if (alive.has(p.id)) continue;
      try {
        p.mk.remove();
      } catch {
        /* 已经没了就算了（地图销毁时会一起走） */
      }
    }
    setPins(pins.filter((p) => alive.has(p.id)));
    stats.pins = pins.length;
    /* 📍 新钉子刚建出来 ⇒ **立刻补一次**屏外指示（不补的话，屏外的那个人要等到下一次相机事件才长出箭头）。
       ⚠️ 这里调的两个函数是**函数声明**（提升可见），而它们读的 `pinEdgeGeom` 是 setup 里的 `const` ——
          本函数的所有调用点都在 setup 跑完之后（watch 回调 / map 事件 / 异步 load）⇒ 不会踩 TDZ。 */
    pinEdgeMeasure();
    pinEdgeSync();
  }

  /* ── 🪪 信息卡：三条入口（点楼体 / 点名字 / 点区名）⇒ 同一张卡 ───────────────── */
  const cardData = ref<CardData | null>(null);
  const cardOpen = ref(false);
  /** 打开卡片：**唯一入口** —— 三条点击路径都走它，卡片数据只由 `buildingCardData` 生成 */
  function openCard(input: Parameters<typeof buildingCardData>[0], click?: { x: number; y: number } | null): void {
    try {
      const rect = { x: 0, y: 0, w: 0, h: 0 };
      /* 卡片最终矩形：与 `WsBuildingCard.vue` 的 CSS 同一口径（min(88%, 420px) 宽、居中） */
      const host = labRootEl.value?.parentElement;
      const W = host?.clientWidth || 0, H = host?.clientHeight || 0;
      rect.w = Math.min(W * 0.88, 420);
      rect.h = Math.min(H * 0.76, 260);
      rect.x = (W - rect.w) / 2;
      rect.y = (H - rect.h) / 2;
      cardData.value = buildingCardData({ ...input, click: click || input.click || null, cardRect: rect, index: indexFactOfNames() });
      cardOpen.value = true;
      stats.card = `${cardData.value.kind}/${cardData.value.state}`;
    } catch (e) {
      stats.note = stats.note ? `${stats.note} · 卡片：${String((e as Error)?.message || e).slice(0, 40)}` : `卡片：${e}`;
    }
  }
  function closeCard(): void { cardOpen.value = false; stats.card = ""; }
  /** 署名（ODbL）原句：**只念包索引里的**（取不到 = null ⇒ 卡片如实写"署名取不到"） */
  function indexFactOfNames(): { attribution: string | null; real: boolean | null } | null {
    const f = nameLayer.facts();
    return f.attribution ? { attribution: f.attribution, real: true } : (f.state === "counted" ? { attribution: null, real: null } : null);
  }

  /** 点**标签**（真名 / 区名）—— 与点楼体弹**同一张卡** */
  function openCardFromNode(n: NameRenderNode): void {
    const p = n.pick;
    if (p.kind === "zone") { openCard({ kind: "zone", zone: p.zone }); return; }
    if (p.kind === "place") { openCard({ kind: "place", place: p.place }); return; }
    openCard({ kind: "building", building: { id: p.buildingId, lng: p.lng, lat: p.lat, properties: { name: p.name, osm_id: p.buildingId } } });
  }

  /** 🧑 切片②（2026-10-01）：面板开关（模块级单例）—— 本组件**只用它判断"面板开着吗"**
      （见 `onMapClick` 开头那句早退）。开面板/画面板/好感全在宿主的 `WsCharPanel.vue` 那条路上。 */
  const panel = useWsPanel();

  /** 🏙🌆 **点楼要查哪几条层**（按**当前 zoom** 选；同一条点选路，不是两套逻辑）。
   *  · `z < WS_BLD_FOOTPRINT_MAXZOOM`(14) ⇒ 屏上只有**足迹层**（`bld-foot`，平面 `fill`）；
   *  · `z ≥ 14` ⇒ 三条挤出层（主体 / 女儿墙 / 设备箱+天线）。
   *  ⚠️ zoom 读不出来（`null`）⇒ 按**两条都查**（点选是"用户明确点了一下"，宁可不命中也不能漏掉
   *     一栋明明画着的楼；层不存在时 `queryRenderedFeatures` 会抛 ⇒ 由调用处照旧降级到屏幕距离）。 */
  function bldClickLayersNow(m: { getZoom?: () => number } | null): string[] {
    const tier = bldTierOfZoom(m && typeof m.getZoom === "function" ? m.getZoom() : null);
    if (tier === 0) return ["bld-foot"];
    if (tier === 1) return ["bld-ext", "bld-roof", "bld-equip"];
    return ["bld-foot", "bld-ext", "bld-roof", "bld-equip"];
  }

  /** 点**楼体**（地图上的挤出层 / 足迹层）—— 与点标签弹**同一张卡** */
  function onMapClick(e: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number }; features?: unknown[] }): void {
    /* 🧑 切片②（2026-10-01）：角色面板开着时，点地图**先关面板**再 return ——
       否则点空处会顺手在面板背后弹一张楼卡（面板没关、楼卡还盖上来）。
       纪律：**只加这一句早退，不新开第二条 click 监听**（地图级 click 仍然只有 `m.on("click")` 一处）。
       面板状态读的是模块级单例（`useWsPanel`），与本组件同一次会话里是同一份。 */
    if (panel.open.value) {
      panel.closePanel();
      return;
    }
    try {
      /* `getZoom` 是 2026-10-03「按 zoom 分层」后点选要用的（`z<14` 查足迹层、`z≥14` 查三条挤出层）——
         这里必须一起声明，否则 `bldClickLayersNow(m)` 报 TS2559（两个类型没有共同属性）。 */
      const m = mapNow() as unknown as {
        queryRenderedFeatures?: (p: unknown, o?: unknown) => Array<{ properties?: Record<string, unknown>; id?: unknown }>;
        getZoom?: () => number;
      } | null;
      const pt = e?.point;
      let feats: Array<{ properties?: Record<string, unknown>; id?: unknown }> = [];
      if (m?.queryRenderedFeatures && pt) {
        /* 🏢 三条挤出层**都要查**（2026-10-02 B1 按 zoom 分了三条：主体 / 女儿墙 / 设备箱+天线）——
           只查 `bld-ext` 会让"点屋顶件"落空（虽然下面还有屏幕距离兜底，但那是降级不是正常路径）。
           多条命中时**按档位升序取第一条**（`zt` 小的 = 主体优先，卡片信息最全）。
           🌆 2026-10-03 **按 zoom 分层**后：`z<14` 屏上是**足迹层**（`bld-foot`，平面）——
           这时 `bld-ext` 整层不可见（`minzoom` = 14），查它必然空。所以层名**按当前 zoom 选**，
           走的是**同一条** `queryRenderedFeatures` 路（不是两套点选逻辑），只是换一批层名。 */
        const hitLayers = bldClickLayersNow(m);
        try {
          const hit = m.queryRenderedFeatures(pt, { layers: hitLayers }) || [];
          feats = hit.slice().sort((a, b) => {
            const za = Number((a.properties || {}).zt ?? 0), zb = Number((b.properties || {}).zt ?? 0);
            return (isFinite(za) ? za : 0) - (isFinite(zb) ? zb : 0);
          });
        } catch { feats = []; }
      }
      /* 🔴 无头/无 WebGL 下 `queryRenderedFeatures` 恒空（本项目栽过的**假阴性闸**）⇒ 如实降级：
         用**屏幕距离**在"这一轮真画出去的那批楼"里找最近的一栋（锚点来自 `afterDraw`，不是猜的）。 */
      if (!feats.length) {
        const nearest = nearestDrawnBuilding(pt);
        if (nearest) feats = [{ properties: nearest.properties, id: nearest.id }];
      }
      const f = feats[0];
      if (!f) return;                                   // 点到空处：什么都不弹（不编一栋楼出来）
      openCard({ kind: "building", building: { id: String((f.properties || {}).osm_id || f.id || ""), properties: (f.properties || {}) as Record<string, unknown> }, click: pt || null });
    } catch (err) {
      stats.note = stats.note ? `${stats.note} · 点楼：${String((err as Error)?.message || err).slice(0, 40)}` : `点楼：${err}`;
    }
  }

  /** 屏幕距离最近的一栋**已画**的楼（`queryRenderedFeatures` 拿不到时的**可见降级**，不编数据） */
  function nearestDrawnBuilding(pt: { x?: number; y?: number } | undefined): { id: string; properties: Record<string, unknown> } | null {
    const m = mapNow() as unknown as { project?: (c: [number, number]) => { x: number; y: number }; getZoom?: () => number } | null;
    if (!m?.project || !pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) return null;
    const zoom = m.getZoom ? m.getZoom() : 16;
    if (zoom < 13) return null;                          // 远景下楼是亚像素，不该被点到
    const maxPx = 26;                                    // 命中半径（≈ 一栋近景楼的屏幕上尺寸）
    let best: { id: string; properties: Record<string, unknown> } | null = null;
    let bestD = maxPx;
    for (const raw of drawnBldNow()) {
      const f = raw as { id?: unknown; properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };
      const props = f.properties || {};
      if (String(props.part || "body") !== "body") continue;   // 只认主体（屋顶/天线不该被点）
      const ll = firstCoordOf(f.geometry);
      if (!ll) continue;
      const p = m.project(ll);
      if (!p || !Number.isFinite(p.x)) continue;
      const d = Math.hypot(p.x - Number(pt.x), p.y - Number(pt.y));
      if (d < bestD) { bestD = d; best = { id: String(props.osm_id || f.id || ""), properties: props }; }
    }
    return best;
  }
  function firstCoordOf(g: { coordinates?: unknown } | null | undefined): [number, number] | null {
    let v: unknown = g?.coordinates;
    for (let i = 0; i < 6 && Array.isArray(v); i++) {
      if (typeof v[0] === "number" && typeof v[1] === "number") return [v[0] as number, v[1] as number];
      v = v[0];
    }
    return null;
  }

  /* 宿主还要用的那几个（其余在宿主**一个调用点都没有** ⇒ 不解构；删除按 §3 留给 S9）。 */
  return { cardData, cardOpen, closeCard, onMapClick, openCardFromNode, syncPins };
}
