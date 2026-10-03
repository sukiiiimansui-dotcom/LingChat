// 🕹 **摇杆输入 + 漫游位置真源 + 近景（角色第一视角）常量与开关**（2026-10-03 机主裁决：
// 「街景不要了喵，直接给我们的地图做一个近景（角色第一视角）」，见 `world_map/PROJECT-STATE.md` 轮 51）。
//
// ## 这个文件里有什么（四块，其余一律不做）
//   ① **一个向量**：把指针位置变成推杆向量（死区 / 归一化 / 夹紧 / 松手归零），全是纯函数
//      ⇒ 能在 Node 里钉字面量断言（`world_map/ws_joystick_selftest.mjs`），不用开浏览器；
//   ② **唯一驱动点**：`createJoyDriver()` —— 指针事件**只写 `setVector()` 这一个向量**，
//      真正的相机更新只发生在**一个 rAF** 里（pointermove 1000 次/秒 ⇒ 相机最多 60 次/秒）。
//      rAF/时钟/屏宽全部可注入 ⇒ 离线也能数帧数。
//   ③ **「我」的漫游位置真源**：`roamStore`。🔴 语义是**漫游（演示）**，**不是 GPS**：
//      · **不写进 `wsRuntimePush`**（推给 Rust 的 me 只允许是真定位，否则模型会真以为玩家在那儿）；
//      · 也**不当** gameplay 的距离依据（期 3「走近说话」12/20 米那条判词的口径是"真坐标"，
//        拿演示位置去算会得出"你离他 8 米"这种编出来的结论 ⇒ 要接必须先给判词加第四态，见 `ROAM_NOTE`）。
//   ④ **开关与持久化**：**默认关** + 玩家面板里的开关 + `wsm:v1:joy` 记忆 + `?joy=1/0` 逃生口（见第 五 节）。
//      ⚠️ 机主 2026-10-03 改过一次口径：不再默认开、也不做常驻摇杆 ⇒ **改开关先读第 五 节**。
//
// ## 两条红线（写在这里，因为最容易在"顺手优化"时破掉）
//   · **不写第二份米/像素换算**：满推速度按「**屏宽/秒**」给 —— 真实步行 1.4 m/s（`move.rs` Walk）
//     换算到 z16.4 只有 **0.89 px/s**（1.5746 m/px，与 `bldMetersPerCssPixel` 同一把尺子），
//     横穿一屏要 **7.5 分钟**，那种摇杆没法用（PLAN §2.1 实测口径）。
//     相机的实际位移只交给 `map.panBy([dx,dy],{duration:0})`（库内已处理 pitch/bearing），
//     位置再由 `map.getCenter()` **反写**回来 ⇒ 全程一行投影数学都没有，也不碰 zoom。
//   · **不 import vue / 不 import 地图库 / 不碰 `document`/`window`**：本文件必须能在 node 里直接跑。
//     唯一的浏览器 IO 是 `localStorage`（`readJoyStored`/`writeJoyStored` 两个函数、全程 try/catch，
//     与 `wsBldMode.ts` 同款）—— 在 node 里 `typeof localStorage === "undefined"` ⇒ 退回默认（关）。

/* ══════════════════════════════════════════════════════════════════
 * 一、几何与手感常量（**唯一真源**：组件 CSS 从 CSS 变量取、HUD 让位也从这里算）
 * ══════════════════════════════════════════════════════════════════ */

/** 底盘直径（px）——`PLAN-JOYSTICK-STREETVIEW.md` §2.2 / `UI-DESIGN-SPEC.md:112` */
export const JOY_BASE_PX = 112;
/** 可见杆头直径（px）——同上（杆头只影响观感，**不**决定命中区） */
export const JOY_THUMB_PX = 52;
/** 命中区下限（px）——触控红线 ≥44×44（`UI-DESIGN-SPEC.md:112`）；底盘 112 就是命中区 */
export const JOY_HIT_MIN_PX = 44;
/** 距屏幕左边/下边（px）——与 HUD 同一条 8px 边距（左下拇指区，见 §2.2） */
export const JOY_INSET_PX = 8;
/** 摇杆顶边与 HUD 之间的缝（px）——HUD 让位 = 底盘 + 两个 8px */
export const JOY_GAP_PX = 8;
/**
 * HUD 要抬高多少（px）= 底盘 + 边距 + 缝。
 * 🔴 **让位是必须的**：HUD 也在 `left:8 bottom:8`（`WsDistrictMapLibre.vue` 的 `.ws-dml__hud`），
 * 不让位就正好压住 HUD 最左一格（"街区视野…"那一格）。无摇杆路 `--ws-joy-h` = 0 ⇒ HUD 逐字不变。
 */
export const JOY_HUD_LIFT_PX = JOY_BASE_PX + JOY_INSET_PX + JOY_GAP_PX;
/** 杆头能走的半径（px）——由上面两个常量推出，组件**不再写第二份** */
export const JOY_THUMB_TRAVEL_PX = (JOY_BASE_PX - JOY_THUMB_PX) / 2;

/** 死区（占半径的比例）：手指按住不动时的抖动不该让画面漂 */
export const JOY_DEADZONE = 0.12;
/** 满推速度：**0.6 屏宽/秒**（PLAN §2.1 建议值；与 zoom 无关，放大后不会变龟速） */
export const JOY_SCREEN_PER_SEC = 0.6;
/** 单帧最大步长（ms）：掉帧/后台回来时**不许**一次跳出去（64 ≈ 15.6fps 的一帧） */
export const JOY_MAX_DT_MS = 64;
/** 近景倾角（度）：机主裁决 **60~70**；`maxPitch` = 70（`wsScene.CAMERA_DEFAULTS`）⇒ 取 64 留余量 */
export const JOY_PITCH_DEG = 64;

/** 推杆向量：**屏幕坐标**（x 右为正、y 下为正），与 `panBy` 同一套，省一次符号换算 */
export interface JoyVector {
  /** 方向 × 推出量（含死区已扣）；范围 [-1,1] */
  x: number;
  /** 同上（下为正） */
  y: number;
  /** 推出量 0..1（= hypot(x,y)）：0 = 没推/死区内 ⇒ 相机一次都不更新 */
  mag: number;
}
/** 归零向量（松手 / 死区内 / 还没按下）——**冻结**：地图组件把它当只读用 */
export const JOY_ZERO: Readonly<JoyVector> = Object.freeze({ x: 0, y: 0, mag: 0 });

/* ══════════════════════════════════════════════════════════════════
 * 二、纯函数：指针位置 → 向量 → 每帧屏幕位移
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 推杆向量（纯函数）。
 * @param dx     指针相对**底盘中心**的横向位移（px，右为正）
 * @param dy     纵向位移（px，**下为正**）
 * @param radius 底盘半径（px）——手指推出底盘也算"满推"（夹紧到 1，不按超出比例放大）
 *
 * 三件事一起做完：**死区内归零** → **线性去死区并归一化到 0..1** → **方向保持**。
 * ⚠️ 边界口径（自检钉着）：`|r| ≤ 死区` ⇒ **0**（含恰好等于死区）；
 *    `|r| ≥ 半径` ⇒ `mag = 1`（方向不变）。
 */
export function joyVectorOf(dx: number, dy: number, radius: number): JoyVector {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const len = Math.hypot(dx, dy);
  if (!r || !Number.isFinite(len) || len <= 0) return { ...JOY_ZERO };
  const raw = len / r; // 0..∞（可以 > 1）
  const mag = raw >= 1 ? 1 : raw <= JOY_DEADZONE ? 0 : (raw - JOY_DEADZONE) / (1 - JOY_DEADZONE);
  if (!mag) return { ...JOY_ZERO };
  return { x: (dx / len) * mag, y: (dy / len) * mag, mag };
}

/** 指针事件 → 向量（组件只调这个；中心与半径在**按下那一刻**量一次，见组件里的说明） */
export function joyVectorFromPointer(
  p: { clientX: number; clientY: number },
  box: { cx: number; cy: number; radius: number }
): JoyVector {
  return joyVectorOf(p.clientX - box.cx, p.clientY - box.cy, box.radius);
}

/**
 * 杆头的视觉位移（px；相对底盘中心，右/下为正）。
 *
 * 🔴 与**相机**的那份向量故意不同口径：死区是给"手按住不动时画面别漂"用的，
 * 而杆头必须**老老实实跟着手指**（死区内也是）—— 否则按住轻推时杆头像卡住了，手感是坏的。
 * 所以这里只做"比例 × 行程 + 夹紧"，与 `joyVectorOf` 的死区无关。
 */
export function joyThumbOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const len = Math.hypot(dx, dy);
  if (!r || !Number.isFinite(len) || len <= 0) return { x: 0, y: 0 };
  const k = (Math.min(1, len / r) / len) * JOY_THUMB_TRAVEL_PX;
  return { x: dx * k, y: dy * k };
}

/**
 * 一帧的屏幕位移（px，**右/下为正**，直接喂 `map.panBy`）。
 *
 * 🔴 为什么是"屏宽/秒"而不是米/秒：见文件头红线（真实步行在这一档只有 0.89 px/s）。
 * ⚠️ `dtMs` 在这里**夹到 `JOY_MAX_DT_MS`**（只此一处夹 —— 掉帧时不许跳变）。
 */
export function joyScreenDelta(v: JoyVector, screenW: number, dtMs: number): { dx: number; dy: number } {
  const w = Number.isFinite(screenW) && screenW > 0 ? screenW : 0;
  const dt = Number.isFinite(dtMs) ? Math.min(JOY_MAX_DT_MS, Math.max(0, dtMs)) : 0;
  if (!w || !dt || !v || !v.mag) return { dx: 0, dy: 0 };
  const k = (w * JOY_SCREEN_PER_SEC * dt) / 1000;
  return { dx: v.x * k, dy: v.y * k };
}

/* ══════════════════════════════════════════════════════════════════
 * 三、唯一驱动点：一个 rAF（可注入 ⇒ 离线能数帧数）
 * ══════════════════════════════════════════════════════════════════ */

export interface JoyFrameDelta {
  dx: number;
  dy: number;
}
export interface JoyDriverDeps {
  /** 每帧**最多一次**（向量为 0 的帧根本不回调）——相机更新只许挂在这里 */
  onFrame: (d: JoyFrameDelta, v: JoyVector) => void;
  /** 松手：**恰好一次**（清 `joyActive` + 一次重算都挂这里；没按下过就不会回调） */
  onHalt: () => void;
  /** 屏宽（px）——"屏宽/秒"那把尺子；组件在**按下那一刻**量一次后缓存（每帧读 clientWidth = 每帧强制布局） */
  screenW: () => number;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}
export interface JoyDriver {
  /** 按下（pointerdown）：开一次会话，向量归零（按住不动 ⇒ 0 次相机更新） */
  begin(): void;
  /** 指针移动：**只写这一个向量**（无 DOM 写、无相机调用） */
  setVector(v: JoyVector): void;
  /** 松手 / pointercancel：归零 + **恰好一次** `onHalt`（重复调用是空操作） */
  release(): void;
  /** 卸载 / 关开关：停 rAF，**不**回调 `onHalt`（那是"松手"，不是"走了"） */
  cancel(): void;
  /** 自持标志（= 地图组件里那个 `joyActive` 的输入侧） */
  readonly active: boolean;
  /** 跑过多少帧（自检读数；生产留着是 0 成本） */
  readonly frames: number;
}

/**
 * 摇杆驱动（**唯一 rAF**）。
 * 生命周期：`begin()` → N × `setVector()` → `release()`；`cancel()` 用于组件卸载。
 * 不变量（自检钉着）：
 *   ① `setVector()` 一次都不触发相机回调 —— 它只写向量 + 确保 rAF 在跑；
 *   ② 一帧内 `onFrame` **至多 1 次**，且只在该帧向量非零时；
 *   ③ 向量归零 ⇒ rAF 链**自己停**（不空转）；`release()` ⇒ `onHalt` 恰好 1 次、之后一帧都不再回调。
 */
export function createJoyDriver(deps: JoyDriverDeps): JoyDriver {
  const now = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const raf =
    deps.raf ||
    ((cb: (t: number) => void) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(() => cb(now()), 16) as unknown as number));
  const caf =
    deps.caf || ((id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id as never)));

  let v: JoyVector = { ...JOY_ZERO };
  let active = false;
  let frameId = 0;
  let last = 0;
  let frames = 0;

  function kick(): void {
    if (!active || frameId) return;
    last = now();
    frameId = raf(frame);
  }
  function frame(t: number): void {
    frameId = 0;
    if (!active) return;
    const dt = t - last;
    last = t;
    frames += 1;
    const d = joyScreenDelta(v, deps.screenW(), dt);
    /* 死区内/位移为 0 ⇒ **不回调**（"没推就不更新相机"，判据 1 的前提） */
    if (d.dx || d.dy) deps.onFrame(d, v);
    /* 还推着才续帧：松手/回中 ⇒ 链自己断（不空转、不残留定时器） */
    if (active && v.mag > 0) frameId = raf(frame);
  }

  return {
    get active() {
      return active;
    },
    get frames() {
      return frames;
    },
    begin() {
      active = true;
      v = { ...JOY_ZERO };
      last = now();
      kick();
    },
    setVector(nv) {
      if (!active) return;
      v = nv || { ...JOY_ZERO };
      kick();
    },
    release() {
      if (!active) return; // 没按下过 ⇒ 不是"松手"，一次重算都不该有
      active = false;
      v = { ...JOY_ZERO };
      if (frameId) {
        caf(frameId);
        frameId = 0;
      }
      deps.onHalt();
    },
    cancel() {
      active = false;
      v = { ...JOY_ZERO };
      if (frameId) {
        caf(frameId);
        frameId = 0;
      }
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、「我」的漫游位置真源（**不是 GPS**；见文件头 🔴）
 * ══════════════════════════════════════════════════════════════════ */

/** 位置的**来源标注**：只有一个合法值 —— 免得将来有人顺手写成 `"gps"` */
export const ROAM_SOURCE = "roam" as const;
/** 给人和 UI 的那句实话（HUD / 判词要引用就引这一份，不许各写一版） */
export const ROAM_NOTE = "漫游位置（演示，不是 GPS）";
/** 近景那一句（HUD 上要看得见：这是**倾斜俯视的跟随**，不是眼睛高度的实景） */
export const JOY_MODE_NOTE = "漫游视角（不是步行模拟）";
/** 2D 降级路的实话（没有相机 ⇒ 摇杆不出现，但要**写出原因**，不静默消失） */
export const JOY_2D_NOTE = "2D 降级路没有相机，摇杆不适用";

export interface RoamPos {
  lng: number;
  lat: number;
  /** 朝向（度，正北为 0）—— 真源就是**相机 bearing**（我们从不改它，只如实记录） */
  headingDeg: number;
  /** 永远 `"roam"`：这一份位置**不许**冒充定位（类型上就写死） */
  source: typeof ROAM_SOURCE;
  /** 写入时刻（ms，`Date.now()`）—— 判"这份位置还新不新"用 */
  t: number;
}
export interface RoamStore {
  get(): RoamPos | null;
  /** **唯一写入点**（地图组件每帧从 `map.getCenter()` 反写；这里不做任何换算） */
  write(lng: number, lat: number, headingDeg: number, t?: number): RoamPos;
  clear(): void;
}
export function createRoamStore(): RoamStore {
  let pos: RoamPos | null = null;
  return {
    get: () => pos,
    write(lng, lat, headingDeg, t = Date.now()) {
      pos = { lng, lat, headingDeg, source: ROAM_SOURCE, t };
      return pos;
    },
    clear() {
      pos = null;
    },
  };
}
/** 本屏共用那一份（App 侧单例；**不进 Rust**、不参与 gameplay 距离，见文件头） */
export const roamStore = createRoamStore();

/* ══════════════════════════════════════════════════════════════════
 * 五、开关：**默认关** + 面板开关 + 本地记忆 + URL 逃生口
 * （机主 2026-10-03 改的口径：「摇杆改成点击玩家头像，在面板里选择开启喵！」）
 * ══════════════════════════════════════════════════════════════════
 * 四层，优先级从高到低：
 *   ① `?joy=1` / `?joy=0`：**URL 显式给了就覆盖**存储值（逃生口，排查与 A/B 用）；
 *   ② 本地记忆 `localStorage["wsm:v1:joy"]`（值 `"1"` / `"0"`）—— 玩家面板里点的那一下；
 *   ③ 默认 **关**：不写 URL、也没存过 ⇒ **连摇杆 DOM 都没有**，而且初始俯角/中心与改造前**逐字一致**
 *      （"默认关不许有副作用"是机主的硬要求 —— 所以 `pitch 64` 只允许出现在 `joy === true` 那一路）；
 *   ④ 读不出来 / 坏数据（`"{}"`/`"true"`/`null`/隐私模式抛错）⇒ **关**：与 `wsBldMode`/`wsRelation`
 *      同款口径 —— **绝不抛、绝不猜**（坏数据不该让整屏白掉，也不该替他打开一个功能）。 */

/** 本地记忆的键（**唯一一处定义**；`wsm:v1:` 前缀与本项目其它世界模拟存储一致） */
export const JOY_STORE_KEY = "wsm:v1:joy";

/**
 * URL 那一位：`?joy=1` ⇒ `true`、`?joy=0` ⇒ `false`、**没写 ⇒ `null`**（= 没表态，交给下一层）。
 * ⚠️ `\b` 边界：`?joy=01` / `?joy=0x` **不算表态**（与仓里 `?names=0` / `?wsfallback=1` 同一套写法）。
 */
export function joyUrlChoiceOf(query: string): boolean | null {
  const s = String(query || "");
  if (/[?&]joy=1\b/.test(s)) return true;
  if (/[?&]joy=0\b/.test(s)) return false;
  return null;
}

/**
 * 从**当前地址**读 URL 那一位。
 * ⚠️ App 是 hash 路由（`#/worldsim?joy=1`）⇒ 查询串可能在 hash 里，两处都要看
 * （与 `WsDistrictMapLibre.wsQuery()` 同一口径；`?joy=1` 那种也照样认）。
 * 读不到地址（无 location）⇒ `null`（不表态），**不是** true —— 默认关这条不许被这里绕过去。
 */
export function joyUrlChoiceFromLocation(): boolean | null {
  try {
    return joyUrlChoiceOf(String(location.search || "") + "&" + String(location.hash || ""));
  } catch {
    return null;
  }
}

/** 本地存的那一位：**只有 `"1"` 算开**，其余（没存过 / `"0"` / 坏数据）一律 **关** */
export function joyStoredOf(raw: unknown): boolean {
  return raw === "1";
}

/** 落在哪一边：**URL 显式 > 本地记忆 > 默认（关）** */
export function joyResolveOf(input: { url: boolean | null; stored: boolean }): boolean {
  return input.url === null ? !!input.stored : !!input.url;
}

/** 读盘：坏了/没有/读不动 ⇒ **关**，绝不抛（隐私模式下 `localStorage` 本身就会抛） */
export function readJoyStored(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return joyStoredOf(localStorage.getItem(JOY_STORE_KEY));
  } catch {
    return false;
  }
}

/** 落盘：写不进去不影响本次会话（与 `wsBldMode.writeBldMode()` 同一口径） */
export function writeJoyStored(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(JOY_STORE_KEY, on ? "1" : "0");
  } catch {
    /* 写不进去就只活这一次会话 */
  }
}

/** 进这一屏时该不该开（`WsCityEntry` **只调这一个**）：URL 显式 > 存储 > 关 */
export function joyInitialOn(): boolean {
  return joyResolveOf({ url: joyUrlChoiceFromLocation(), stored: readJoyStored() });
}

/**
 * 摇杆该不该出现在 DOM 里 + HUD 要写哪句话（**唯一判据**，两条都钉着自检）。
 *
 * 判据 9：`?joy=0` ⇒ `show:false`（DOM 里不出现）+ **0 次相机更新**（组件不在 ⇒ 没人建驱动）；
 * 判据 10：2D 降级路（无 WebGL ⇒ 没有相机）⇒ `show:false` + HUD 写明原因（**不静默消失**）。
 * 🔴 这条同时挡住"第二份实现"（C1）：降级路**不装摇杆**，而不是"装了但不生效"。
 */
export function joyGateOf(input: { joy: boolean; fallback2d: boolean }): { show: boolean; hudNote: string } {
  if (!input.joy) return { show: false, hudNote: "" };
  if (input.fallback2d) return { show: false, hudNote: JOY_2D_NOTE };
  return { show: true, hudNote: JOY_MODE_NOTE };
}

/* ══════════════════════════════════════════════════════════════════
 * 六、相机快照 / 还原（"关掉 ⇒ 逐字还原"的那一半，纯函数）
 * ══════════════════════════════════════════════════════════════════
 * 机主的要求：关闭 ⇒ 相机/俯角**还原到接管之前的值**，不许留残留状态。
 * 于是有两件事必须离线可判（自检钉着）：
 *   ① 快照里**四个值一个都不能少**（缺一个 ⇒ `null`：宁可**不动相机**，也不写一个编出来的中心/俯角）；
 *   ② 没有快照 ⇒ `joyCamRestoreArgs()` 返回 `null` ⇒ 宿主**一次 `jumpTo` 都不许发**。 */

/** 接管前的相机（中心/缩放/俯角/朝向 —— 四个都要，缺一不可） */
export interface JoyCamSnapshot {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/** 从"读相机"的结果里取一份快照；任何一项缺失/非有限 ⇒ `null`（= 没有可信的还原点） */
export function joyCamSnapshotOf(
  read:
    | {
        center?: { lng?: unknown; lat?: unknown } | [unknown, unknown] | null;
        zoom?: unknown;
        pitch?: unknown;
        bearing?: unknown;
      }
    | null
    | undefined
): JoyCamSnapshot | null {
  if (!read) return null;
  const c = read.center;
  const lng = Array.isArray(c) ? Number(c[0]) : Number((c as { lng?: unknown } | null | undefined)?.lng);
  const lat = Array.isArray(c) ? Number(c[1]) : Number((c as { lat?: unknown } | null | undefined)?.lat);
  const zoom = Number(read.zoom);
  const pitch = Number(read.pitch);
  const bearing = Number(read.bearing);
  if (![lng, lat, zoom, pitch, bearing].every((n) => Number.isFinite(n))) return null;
  return { center: [lng, lat], zoom, pitch, bearing };
}

/**
 * 关闭时要喂给 `map.jumpTo` 的参数（**无快照 ⇒ `null`** ⇒ 宿主不许动相机）。
 * `duration: 0` 是刻意的：还原是"回到原处"，不是一段动画（有过渡反而像"被弹回去"）。
 */
export function joyCamRestoreArgs(prev: JoyCamSnapshot | null): (JoyCamSnapshot & { duration: number }) | null {
  if (!prev) return null;
  const ok = [...prev.center, prev.zoom, prev.pitch, prev.bearing].every((n) => Number.isFinite(n));
  if (!ok) return null;
  return { center: [prev.center[0], prev.center[1]], zoom: prev.zoom, pitch: prev.pitch, bearing: prev.bearing, duration: 0 };
}
