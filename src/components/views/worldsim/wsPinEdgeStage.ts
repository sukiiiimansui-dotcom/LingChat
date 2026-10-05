/* wsPinEdgeStage.ts —— S13：把宿主里「屏外角色箭头」那一族（`pinEdgeOn` / `pinEdgeGeom` /
 * `pinEdgeInsetsOf` / `pinEdgeMeasure` / `pinEdgeAvoid` / `pinEdgeSync` / `pinEdgeMetersOf`）
 * **整块搬出来**，宿主同名解构回去 ⇒ 下游调用点一个字都不改。
 *
 * ## 这个文件是什么
 * 📍 角色「屏外方向指示」的**宿主那一半**：量容器几何（含 `env(safe-area-inset-*)` 探针）、
 * 把屏外的钉子夹进安全矩形并躲开三块禁区、每颗钉子算一次屏幕点、**只在变了才写 DOM**。
 * 纯算术那一半（夹取 / 角度 / 距离文案）**不在这里**，在共享真源 `wsPinEdge.ts`（本模块只 import）。
 *
 * ## 两条红线（本片一个字都没动）
 * ① **DOM 契约**：`ws-pin-edge` / `is-off` / `data-ws-pin-edge` 与"只在屏内屏外翻转、
 *    或角度/距离变了才写"那套**逐字不变**（模板与 CSS 仍在宿主，节点由 M7 的 `pinEl` 建）。
 * ② **一份实现**：`pinEdgeMeasure` / `pinEdgeSync` 现在是 M7（`wsPickInteract`）、
 *    M9（`wsEngineGuard`）、M11（`wsStageEvents`）、M5（`wsJoystickStage`）的 ctx 的一部分 ——
 *    宿主从**本工厂的返回值**同名解构，再往下传给它们 ⇒ 全程只有一份实现（没有第二份）。
 *
 * ## ctx 的落法（与 S2~S11 同一套）
 * ① `host` / `map` / `pins` 都是宿主那面**会重新赋值/会被别人写**的东西 ⇒
 *    `host`（那个 `ref` 本身，容器节点是同一个）按值、`mapNow()` / `pinsNow()` 走**取值器**；
 * ② `pinEdgeOn`（`?edge=0` 开关）与 `pinEdgeGeom`（量一次就缓存的那份几何）**只有本族读/写**
 *    ⇒ 连同声明一起搬进来，宿主那边一个读者都没有（模块自持，**不是**第二份真源）。
 * ③ 除下面那两处别名，本片**没有**别的正文改动：分支 / 阈值 / 顺序 / DOM 契约逐字不变。
 *
 * ## 🔴 唯一的两处别名（逐类可数；对拍闸归一化后逐行比 ⇒ diff = 0）
 * 只有 `pinEdgeSync` 改了：**函数体首行**各现读一次 —— `const pins = pinsNow();` /
 * `const map = mapNow();`（宿主那面两个都是 `let`：新增/移除钉子、建图/销毁都会重写它们，
 * 数组/对象没法按引用共享 ⇒ 与 S4 的 `alive`、S5 的 `map` 同一条落法）。
 * `pinEdgeSync` 全程同步、两处读之间没有任何东西会重写它们 ⇒ 体首一次与逐处现读**逐条等价**。
 * ⚠️ 另外五个函数（`pinEdgeInsetsOf` / `pinEdgeMeasure` / `pinEdgeAvoid` / `pinEdgeMetersOf`
 * 与两个声明）**一个字节都没动**；`pinEdgeMetersOf` 只吃四个入参、一个宿主状态都不读。
 *
 * ## 装配点与依赖方向
 * 宿主在原位置（`roadLayerSpecsForMap` 之后）`createPinEdgeStage({…})` + 同名解构 ——
 * 它要的 `joyHomeBoxesOf`（import 的）、`host`（宿主 :733 的 `ref`）、`pins`（:1004 的 `let`）
 * 在那个位置**都已声明**（本工厂只定义函数、装配那一刻一次都不调，所以 `map` 那一刻是不是 null 无关）。
 * 依赖方向：本模块**不 import 宿主**，只 import 纯真源 `wsPinEdge`（+ 它转引的 `wsJoystick` 的
 * `joyHomeBoxesOf`）与 `wsStageTypes` 的类型。
 */
import { ref } from "vue";
import { PIN_EDGE_MARGIN_PX, PIN_EDGE_MIN_GAP_PX, pinDistText, pinEdgeOf, pinEdgeRotateDegOf } from "./wsPinEdge";
import { joyHomeBoxesOf } from "./wsJoystick";
import type { PinEdgeStageCtx } from "./wsStageTypes";

/**
 * 装配 S13（屏外方向指示）—— 返回值与原宿主闭包变量**同名**，宿主解构回去即可。
 */
export function createPinEdgeStage(ctx: PinEdgeStageCtx) {
  const { host, pinsNow, mapNow } = ctx;

  /* ══════════ 📍 **屏外方向指示**（2026-10-04 第七条）══════════════════════════════════
     机主原话：「**为什么其他角色不见了喵**，放大到最大后楼就没了喵」（前半句归本段）；他自己点的方案：
     「**屏外加方向指示（小箭头 + 距离）**」。病根：角色钉子走地图库 `Marker` ⇒ **出了视口就是真的没有**。

     ## 三个"只在变了才写"（与 `joyAimWrite` 同款；写点数**可数**，写在这里备查）
       · 一颗钉子从"屏内"翻到"屏外"（或翻回来）⇒ **1 次 class 写**（`is-off`），显隐交给 CSS 过渡；
       · 屏外时每轮：**≤2 次 `transform`**（容器位移 + 箭头 `rotate`）+ **≤1 次 `textContent`**（距离文案）；
         三者的合成串（`edgeKey`）**没变就一次都不写** —— 相机不动时稳态是 **0 次/轮**。
       · 屏内时：**0 次**（只有翻转那一轮那 1 次 class）。
     ## 时点：跟着**相机事件**走（`move` / `moveend` / `zoom`），**不在 rAF 里**（红线：不进每帧循环）
       · 摇杆推着的时候与其它 handler 一样**早退**（`joyActive`）—— 拉近期间整层都在早退，
         收尾由 `onJoyHalt()` 那**恰好一次**重算带上（与名字层同一套时点，判据 3/6 的红线）；
       · 新钉子建出来时（`syncPins` 末尾）与容器尺寸变化时（resize）各补一次。
     ## 几何：**只在挂载 / resize 量一次**（读 `clientWidth` 是强制布局，红线）
       · 安全区（刘海/手势条）用 `env(safe-area-inset-*)` 探针量一次 ⇒ 折成一个**内缩后的子矩形**，
         再把结果平移回去（纯函数只认一个标量 margin ⇒ 这里做的是仿射平移，**不是第二份几何**）；
       · 三块禁区（HUD 让位带 / 📱 / 🔬）用摇杆那一份 `joyHomeBoxesOf()`（**同一份矩形、同一个间距**
         `PIN_EDGE_MIN_GAP_PX = JOY_GAP_PX`）⇒ 箭头绝不会压在 HUD 上。 */
  /** 📍 开关（**默认开**）：唯一的关法是 `?edge=0`（与 `?names=0`/`?joy=0` 同一族写法） */
  const pinEdgeOn = ref(!/[?&]edge=0\b/.test(String(typeof location !== "undefined" ? location.search : "")));
  /** 量一次就缓存：容器 CSS 尺寸 + 四边安全区（`measured=false` ⇒ 数不出来，一颗箭头都不写） */
  const pinEdgeGeom = { w: 0, h: 0, l: 0, t: 0, r: 0, b: 0, measured: false };
  /** `env(safe-area-inset-*)` 探针：读**一次**就拆掉（量不到 ⇒ 四边 0，与"没有刘海"同义） */
  function pinEdgeInsetsOf(): { l: number; t: number; r: number; b: number } {
    const zero = { l: 0, t: 0, r: 0, b: 0 };
    try {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;" +
        "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);";
      (host.value || document.body).appendChild(probe);
      const cs = getComputedStyle(probe);
      const v = {
        t: parseFloat(cs.paddingTop) || 0,
        r: parseFloat(cs.paddingRight) || 0,
        b: parseFloat(cs.paddingBottom) || 0,
        l: parseFloat(cs.paddingLeft) || 0,
      };
      probe.remove();
      return v;
    } catch {
      return zero;   /* 读不出来 ⇒ 当"没有安全区"（**不改**任何其它判定；不是把"数不出来"写成别的数） */
    }
  }
  function pinEdgeMeasure(): void {
    const el = host.value;
    const w = el?.clientWidth || 0;
    const h = el?.clientHeight || 0;
    if (w <= 0 || h <= 0) return;             /* 量不到 ⇒ 保持 `measured=false`（数不出来，不编坐标） */
    const ins = pinEdgeInsetsOf();
    pinEdgeGeom.w = w;
    pinEdgeGeom.h = h;
    pinEdgeGeom.l = ins.l;
    pinEdgeGeom.t = ins.t;
    pinEdgeGeom.r = ins.r;
    pinEdgeGeom.b = ins.b;
    pinEdgeGeom.measured = true;
  }
  /**
   * 把一个点从三块禁区里**往上推**出去（与摇杆的"家"同一套矩形、同一个间距 ⇒ 不会打架）。
   * 为什么是"往上推"：三块禁区全部贴在**下缘**（HUD / 📱 / 🔬），推一次就走开。
   * 推完仍夹回安全矩形 —— 返回的点一定在屏内（含边）。
   */
  function pinEdgeAvoid(x: number, y: number): { x: number; y: number } {
    const G = pinEdgeGeom;
    const loX = G.l + PIN_EDGE_MARGIN_PX, hiX = G.w - G.r - PIN_EDGE_MARGIN_PX;
    const loY = G.t + PIN_EDGE_MARGIN_PX, hiY = G.h - G.b - PIN_EDGE_MARGIN_PX;
    let px = Math.max(loX, Math.min(hiX, x));
    let py = Math.max(loY, Math.min(hiY, y));
    const boxes = joyHomeBoxesOf(G.w, G.h);
    for (let pass = 0; pass < 4; pass++) {
      let hit = false;
      for (const b of boxes) {
        const inside = px > b.l - PIN_EDGE_MIN_GAP_PX && px < b.r + PIN_EDGE_MIN_GAP_PX &&
          py > b.t - PIN_EDGE_MIN_GAP_PX && py < b.b + PIN_EDGE_MIN_GAP_PX;
        if (!inside) continue;
        py = b.t - PIN_EDGE_MIN_GAP_PX;
        hit = true;
      }
      if (!hit) break;
      py = Math.max(loY, Math.min(hiY, py));
    }
    return { x: px, y: py };
  }
  /**
   * 📍 **一轮**：每颗"别人"的钉子算一次屏幕点 ⇒ 屏外画边缘箭头 + 距离，回到屏内就藏起来。
   * 规则（夹取/角度/文案）全在纯函数 `wsPinEdge.ts`；这里只做三件事：投影、写 DOM、**只在变了才写**。
   */
  function pinEdgeSync(): void {
    const pins = pinsNow();
    const map = mapNow();
    if (!pinEdgeOn.value) return;
    const m = map as unknown as { project?: (c: [number, number]) => { x: number; y: number } } | null;
    if (!m || typeof m.project !== "function") return;
    if (!pinEdgeGeom.measured) return;        /* 容器还没量过 ⇒ 数不出来（不编坐标、不写 DOM） */
    const G = pinEdgeGeom;
    const vw = G.w - G.l - G.r;
    const vh = G.h - G.t - G.b;
    /* 相机中心**一轮读一次**（距离那一行要用它；不是每颗钉子读一次相机） */
    let cLng = NaN, cLat = NaN;
    try {
      const c = (map as unknown as { getCenter?: () => { lng: number; lat: number } } | null)?.getCenter?.();
      cLng = Number(c?.lng);
      cLat = Number(c?.lat);
    } catch {
      cLng = NaN; cLat = NaN;
    }
    for (const p of pins) {
      const edge = p.edge;
      /* 「我」那颗钉子**没有这三个节点**（相机跟着他，"屏外"对他没意义 —— 机主点的是"其他角色"） */
      if (!edge || !p.edgeArrow || !p.edgeDist) continue;
      let px = NaN, py = NaN, lng = NaN, lat = NaN;
      try {
        const ll = p.mk.getLngLat ? p.mk.getLngLat() : null;
        lng = Number(ll?.lng);
        lat = Number(ll?.lat);
        const q = m.project([lng, lat]);
        px = Number(q?.x);
        py = Number(q?.y);
      } catch {
        px = NaN; py = NaN;
      }
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;   /* 数不出来 ⇒ 这一颗本轮一个字都不写 */
      /* 折算进"安全子矩形"再交给纯函数（仿射平移：先减左上安全区，算完再加回去） */
      const r = pinEdgeOf({ x: px - G.l, y: py - G.t }, { w: vw, h: vh });
      if (r.note) continue;
      if (!r.off) {
        /* 屏内：**只翻转一次 class**（显隐交给 CSS 过渡），位置/角度一个字都不写 */
        if (p.edgeKey !== "off") {
          p.edgeKey = "off";
          edge.classList.remove("is-off");
        }
        continue;
      }
      const at = pinEdgeAvoid(r.ex + G.l, r.ey + G.t);
      const rot = pinEdgeRotateDegOf(r.angleDeg);
      const text = pinDistText(pinEdgeMetersOf(lng, lat, cLng, cLat));
      const key = "1|" + at.x.toFixed(1) + "|" + at.y.toFixed(1) + "|" + rot.toFixed(1) + "|" + text;
      if (key === p.edgeKey) continue;         /* 三个写点全都一样 ⇒ 这一轮 **0 次** DOM 写 */
      p.edgeKey = key;
      edge.classList.add("is-off");
      edge.style.transform =
        `translate3d(${(at.x - px).toFixed(1)}px, ${(at.y - py).toFixed(1)}px, 0) translate(-50%, -50%)`;
      p.edgeArrow.style.transform = `rotate(${rot}deg)`;
      if (p.edgeDist.textContent !== text) p.edgeDist.textContent = text;
    }
  }
  /**
   * 📏 **"离我多远"**：相机中心 → 这一颗钉子的**地面米数**（纯算术，与挑楼那把尺子同一对常数
   * `111320·cos(lat)` / `110540`；**一次投影都不做** —— 两个点本来就是经纬度）。
   *
   * 口径：相机锁着「我」（近景那条口径）⇒ 中心就是「我」；两者不重合时以**相机中心**为准
   *   —— 这行字答的是"屏幕上那颗箭头指的那个人，离你现在看的地方多远"。
   * 三态：任一输入不是有限数 ⇒ `null` ⇒ 文案写「—」（**不许**写 `0 m` 冒充"就在我脚下"）。
   */
  function pinEdgeMetersOf(lng: number, lat: number, cLng: number, cLat: number): number | null {
    if (![lng, lat, cLng, cLat].every((v) => Number.isFinite(v))) return null;
    const lat0 = (lat + cLat) / 2;
    const dx = (lng - cLng) * 111320 * Math.cos((lat0 * Math.PI) / 180);
    const dy = (lat - cLat) * 110540;
    const d = Math.sqrt(dx * dx + dy * dy);
    return Number.isFinite(d) ? d : null;
  }

  return { pinEdgeInsetsOf, pinEdgeMeasure, pinEdgeAvoid, pinEdgeSync, pinEdgeMetersOf };
}
