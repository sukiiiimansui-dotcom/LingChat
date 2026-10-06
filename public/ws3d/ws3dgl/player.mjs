// player.mjs —— 角色移动 / 碰撞 / 相机（第三人称跟随 + 第一人称漫游，一键切）。
// 输入：键盘 WASD/方向键 + 鼠标拖拽 + 触屏虚拟摇杆（左半屏拖动=走，右半屏拖动=看）。
//
// 摇杆这一层只**算状态**，不碰 DOM：拖动时把 {active,x,y,ox,oy,dx,dy,mag} 通过 opts.onStick
// 抛出去，页面拿它去画底盘环 + 拇指钮（就是下面 createInput 里那份 onStick 协议）。
// 之前 onStick 有调用、全仓没有消费者 ⇒ 真机上"拖有反应、屏幕上零反馈"，这轮补上了消费者。
import { clamp, worldToLocal } from './util.mjs';

/** 高度差小于这个值的东西**不参与碰撞**：路缘石只有 0.15m，抬脚就上，不该挡人 */
export const STEP_OVER = 0.3;

export function createInput(el, opts = {}) {
  const keys = new Set();
  const state = {
    move: { x: 0, z: 0 },        // 摇杆/键盘合成的移动向量（-1..1）
    look: { dx: 0, dy: 0 },      // 本帧累计的视角增量
    zoom: 0,                     // 滚轮/捏合
    run: false,
    keyMove: { f: 0, b: 0, l: 0, r: 0 },
    touches: new Map(),
    onKey: opts.onKey || (() => {}),
  };
  const onKeyDown = (e) => {
    if (e.repeat) { return; }
    keys.add(e.key.toLowerCase());
    state.run = e.shiftKey || keys.has('shift');
    state.onKey(e.key, e);
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
  };
  const onKeyUp = (e) => { keys.delete(e.key.toLowerCase()); state.run = e.shiftKey; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());

  // 触屏：左半屏=摇杆，右半屏=视角
  //
  // 摇杆底盘两档（都跟手、松手回中）：
  //   · 手指落在"静止底盘"附近 ⇒ 用固定底盘（左下角那个环），拇指钮跟手指走；
  //   · 落在左半屏别处             ⇒ 底盘浮到手指下（不然钮不在手指下面，手感很怪）。
  // 状态一律经 opts.onStick(payload) 抛给页面，由页面画（DOM 在 ws3dgl.html）。
  const R = 64;                                 // 摇杆最大拖动半径（CSS px，跟视觉环一致）
  const DEFAULT_ANCHOR = () => ({ x: 104, y: (window.innerHeight || 720) - 104, r: 78 });
  const anchorOf = () => {
    try { const a = opts.stickAnchor ? opts.stickAnchor() : null; if (a && isFinite(a.x) && isFinite(a.y)) return a; } catch { /* 拿不到就用默认位 */ }
    return DEFAULT_ANCHOR();
  };
  let stickId = null;
  state.stick = { active: false, x: 0, y: 0, ox: 0, oy: 0, dx: 0, dy: 0, mag: 0, floated: false };
  const emitStick = () => { if (opts.onStick) opts.onStick(state.stick); };
  /** 点在按钮/面板上（带 data-ui 的）就既不摇杆也不转视角 —— 否则按按钮会顺手把镜头甩飞 */
  const isUi = (t) => !!(t.target && t.target.closest && t.target.closest('[data-ui]'));

  const onTouchStart = (e) => {
    // 🔴 只有"我们真的接手了这根手指"才阻止默认行为。
    //    原来无条件 preventDefault ⇒ 点在按钮上时浏览器**不再合成 click** ⇒ 所有屏幕按钮点不动。
    let handled = false;
    for (const t of e.changedTouches) {
      if (isUi(t)) continue;
      handled = true;
      const p = { x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY, stick: false, sx: t.clientX, sy: t.clientY };
      if (t.clientX < window.innerWidth * 0.45 && stickId === null) {
        p.stick = true;
        stickId = t.identifier;
        const a = anchorOf();
        const near = Math.hypot(t.clientX - a.x, t.clientY - a.y) <= (a.r || 78) + 46;
        const ox = near ? a.x : clamp(t.clientX, R + 10, window.innerWidth - R - 10);
        const oy = near ? a.y : clamp(t.clientY, R + 10, window.innerHeight - R - 10);
        p.ox = ox; p.oy = oy;
        Object.assign(state.stick, { active: true, ox, oy, x: t.clientX, y: t.clientY, dx: 0, dy: 0, mag: 0, floated: !near });
        emitStick();
      }
      state.touches.set(t.identifier, p);
    }
    if (handled) e.preventDefault();
  };
  const onTouchMove = (e) => {
    let handled = false;
    for (const t of e.changedTouches) {
      const p = state.touches.get(t.identifier);
      if (!p) continue;
      handled = true;
      const dx = t.clientX - p.x, dy = t.clientY - p.y;
      if (p.stick) {
        const jx = t.clientX - p.ox, jy = t.clientY - p.oy;
        const L = Math.hypot(jx, jy) || 1;
        const k = Math.min(1, L / R) / L;
        state.move.x = jx * k; state.move.z = jy * k;
        const mag = Math.min(1, L / R);
        Object.assign(state.stick, { active: true, x: t.clientX, y: t.clientY, dx: (jx * k) * R, dy: (jy * k) * R, mag });
        emitStick();
      } else {
        state.look.dx += dx; state.look.dy += dy;
      }
      p.x = t.clientX; p.y = t.clientY;
    }
    if (handled) e.preventDefault();
  };
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      const p = state.touches.get(t.identifier);
      if (p && p.stick) {
        state.move.x = 0; state.move.z = 0;
        if (stickId === t.identifier) stickId = null;
        Object.assign(state.stick, { active: false, dx: 0, dy: 0, mag: 0 });   // 松手回中
        emitStick();
      }
      state.touches.delete(t.identifier);
    }
  };
  el.addEventListener('touchstart', onTouchStart, { passive: false });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', endTouch);
  el.addEventListener('touchcancel', endTouch);
  window.addEventListener('blur', () => {
    if (state.stick.active || stickId !== null) {
      stickId = null; state.move.x = 0; state.move.z = 0;
      Object.assign(state.stick, { active: false, dx: 0, dy: 0, mag: 0 });
      emitStick();
    }
  });

  // 鼠标拖拽视角 + 滚轮缩放
  // 与触屏同一套口径：按在按钮/面板（data-ui）上的鼠标操作**不抢**——
  // 否则"按住按钮拖一下"照样把镜头甩飞（触屏那条早就这么判，鼠标这条一直漏着）。
  let dragging = false, lastX = 0, lastY = 0;
  el.addEventListener('mousedown', (e) => { if (isUi(e)) return; dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    state.look.dx += e.clientX - lastX; state.look.dy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
  });
  /** 指针底下那个 data-ui 面板**自己能滚**吗（HUD / 诊断面板都是 max-height + overflow:auto） */
  const overScrollableUi = (e) => {
    const p = e.target && e.target.closest ? e.target.closest('[data-ui]') : null;
    return !!(p && p.scrollHeight > p.clientHeight + 1);
  };
  // 滚轮同理：面板滚得动就让它滚 —— 原来无条件 preventDefault ⇒ 展开后的 HUD / 诊断面板在桌面上滚不动
  el.addEventListener('wheel', (e) => {
    if (overScrollableUi(e)) return;
    state.zoom += e.deltaY; e.preventDefault();
  }, { passive: false });

  state.sample = () => {
    const k = state.keyMove;
    k.f = keys.has('w') || keys.has('arrowup') ? 1 : 0;
    k.b = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
    k.l = keys.has('a') || keys.has('arrowleft') ? 1 : 0;
    k.r = keys.has('d') || keys.has('arrowright') ? 1 : 0;
    const out = {
      mx: clamp(state.move.x + (k.r - k.l), -1, 1),
      mz: clamp(state.move.z + (k.b - k.f), -1, 1),
      lookX: state.look.dx, lookY: state.look.dy, zoom: state.zoom, run: state.run || keys.has('shift'),
    };
    state.look.dx = 0; state.look.dy = 0; state.zoom = 0;
    return out;
  };
  state.keys = keys;
  state.dispose = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
  return state;
}

/** 建筑空间哈希（32m 格）：碰撞只查身边几格 */
export function buildCollider(city) {
  const S = 32;
  const map = new Map();
  let skipped = 0, counted = 0;
  const add = (b) => {
    // 高度差 < STEP_OVER（0.15m 的路缘石、台阶）**不进碰撞体**：抬脚就上去，不该挡人。
    // 现在城里最矮的实体是路缘石（0.15m）和井盖（贴地），楼都远高于 0.3m。
    if (Number.isFinite(b.h) && b.h < STEP_OVER) { skipped++; return; }
    counted++;
    const r = Math.hypot(b.w, b.d) / 2 + 1;
    for (let i = Math.floor((b.x - r) / S); i <= Math.floor((b.x + r) / S); i++) {
      for (let j = Math.floor((b.z - r) / S); j <= Math.floor((b.z + r) / S); j++) {
        const k = i * 100000 + j;
        let a = map.get(k); if (!a) map.set(k, (a = []));
        a.push(b);
      }
    }
  };
  for (const b of city.buildings) { add(b); if (b.wing) add(b.wing); }
  return {
    stepOver: STEP_OVER, solids: counted, lowSkipped: skipped,
    near(x, z) {
      const i = Math.floor(x / S), j = Math.floor(z / S);
      const out = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const arr = map.get((i + a) * 100000 + (j + b));
        if (arr) out.push(...arr);
      }
      return out;
    },
  };
}

/** 圆 vs 旋转矩形：把角色推到楼外面（简单但够用，不会穿墙）。
 *  info（可选，会被填）用来做"卡住脱困"：{ hit, deep, nx, nz } —— deep = 最深穿透（米），
 *  (nx,nz) = 最近那个面的**外法线**（世界坐标，单位向量）。 */
export function resolve(pos, r, buildings, info) {
  let hit = false, deep = 0, nx = 0, nz = 0;
  for (const b of buildings) {
    if (Number.isFinite(b.h) && b.h < STEP_OVER) continue;    // 路缘石/矮台：走上去，不挡
    const l = worldToLocal(b, pos.x - b.x, pos.z - b.z);
    const hx = b.w / 2, hz = b.d / 2;
    const cx = clamp(l.x, -hx, hx), cz = clamp(l.z, -hz, hz);
    let dx = l.x - cx, dz = l.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) continue;
    hit = true;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const push = r - d;
      const ux = dx / d, uz = dz / d;
      // ⚠️ 本地方向 → 世界：用 localToWorld 那一套（`x cos − z sin, x sin + z cos`）。
      // 原来这里套的是 worldToLocal 的符号（转置），rot≈0 时看不出来，rot 一大推的方向就偏了。
      const wx = ux * b.cos - uz * b.sin, wz = ux * b.sin + uz * b.cos;
      pos.x += wx * push; pos.z += wz * push;
      if (push > deep) { deep = push; nx = wx; nz = wz; }
    } else {
      // 圆心在楼里：沿最小穿透轴推出去（本地算完再转回世界）
      const px = hx - Math.abs(l.x), pz = hz - Math.abs(l.z);
      let nlx, nlz;
      if (px < pz) { nlx = (hx + r) * (l.x >= 0 ? 1 : -1) - l.x; nlz = 0; }
      else { nlx = 0; nlz = (hz + r) * (l.z >= 0 ? 1 : -1) - l.z; }
      const wx = nlx * b.cos - nlz * b.sin, wz = nlx * b.sin + nlz * b.cos;
      pos.x += wx; pos.z += wz;
      const pen = Math.hypot(wx, wz);
      if (pen > deep) { deep = pen; const L = pen || 1; nx = wx / L; nz = wz / L; }
    }
  }
  if (info) { info.hit = hit; info.deep = deep; info.nx = nx; info.nz = nz; }
  return hit;
}

/** 角度按最短方向靠拢（限步长） —— 转身插值用，别用裸的 lerp（会绕远路/瞬移） */
export function turnToward(a, b, maxStep) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));    // 归一到 (-π, π]
  return a + clamp(d, -maxStep, maxStep);
}

export function createPlayer(opts = {}) {
  const p = {
    pos: { x: 0, z: 0 }, y: 1.68,
    yaw: opts.yaw !== undefined ? opts.yaw : Math.PI, pitch: -0.06,
    // 本体朝向：跟相机分开。移动方向相对相机算，角色自己朝**移动方向**平滑转过去。
    bodyYaw: opts.yaw !== undefined ? opts.yaw : Math.PI,
    vel: { x: 0, z: 0 },                 // 惯性：速度不是直接赋值，按加速度靠拢
    accel: 26, decel: 17,                // 起步比刹车快一点（走路的手感）
    turnRate: 6.5,                       // 转身角速度 rad/s（≈372°/s，看得见"转过去"而不是瞬移）
    speed: 5.2, runMul: 2.3, radius: 0.45,
    third: true, camDist: 11, camHeight: 5.2,
    bob: 0, speedNow: 0, blocked: false, stuck: 0, escape: null, escapeCd: 0,
    escapeSpeed: 2.4, escapeTime: 0.4,   // 脱困：沿最近面外法线推 0.4s（2.4m/s → 约 0.96m）
  };
  /** dir = 相机朝向（单位向量） */
  const dirOf = () => {
    const cp = Math.cos(p.pitch);
    return { x: cp * Math.sin(p.yaw), y: Math.sin(p.pitch), z: cp * Math.cos(p.yaw) };
  };
  p.update = (dt, input, collider) => {
    p.yaw += input.lookX * 0.0032;
    p.pitch = clamp(p.pitch - input.lookY * 0.0026, -1.15, 0.85);
    p.camDist = clamp(p.camDist + input.zoom * 0.02, 3.5, 42);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const rx = -fz, rz = fx;                      // 右手方向
    let mx = rx * input.mx + fx * -input.mz;      // 移动方向 = 相机朝向 + 摇杆/键盘（相对相机）
    let mz = rz * input.mx + fz * -input.mz;
    const L = Math.hypot(mx, mz);
    if (L > 1) { mx /= L; mz /= L; }
    const wish = Math.hypot(mx, mz);              // 0..1 想走的强度（摇杆是模拟量：推多少走多快）
    const sp = p.speed * (input.run ? p.runMul : 1);

    // ① 加减速：速度向目标速度靠拢（有限加速度）⇒ 有惯性，不是瞬间起停
    const tx = mx * sp, tz = mz * sp;
    const dvx = tx - p.vel.x, dvz = tz - p.vel.z;
    const dv = Math.hypot(dvx, dvz);
    const rate = (wish > 0.02 ? p.accel : p.decel) * dt;
    if (dv > rate && dv > 1e-9) { p.vel.x += (dvx / dv) * rate; p.vel.z += (dvz / dv) * rate; }
    else { p.vel.x = tx; p.vel.z = tz; }

    // ② 本体朝向：朝移动方向平滑转（最短角差 + 限角速度）
    if (wish > 0.02) p.bodyYaw = turnToward(p.bodyYaw, Math.atan2(mx, mz), p.turnRate * dt);

    // ③ 位移（含上一帧挂上的脱困推力）
    const bx = p.pos.x, bz = p.pos.z;
    const ex = p.escape ? p.escape.nx * p.escapeSpeed * dt : 0;
    const ez = p.escape ? p.escape.nz * p.escapeSpeed * dt : 0;
    const dx = p.vel.x * dt + ex, dz = p.vel.z * dt + ez;
    p.pos.x += dx; p.pos.z += dz;
    p.speedNow = Math.hypot(p.vel.x, p.vel.z);
    p.bob += dt * p.speedNow * 1.5;

    if (collider) {
      const info = p.hitInfo || (p.hitInfo = { hit: false, deep: 0, nx: 0, nz: 0 });
      resolve(p.pos, p.radius, collider.near(p.pos.x, p.pos.z), info);
      const want = Math.hypot(dx, dz), got = Math.hypot(p.pos.x - bx, p.pos.z - bz);
      p.blocked = want > 0.004 && got < want * 0.45;
      p.stuck = p.blocked ? p.stuck + dt : Math.max(0, p.stuck - dt * 3);
      p.escapeCd = Math.max(0, p.escapeCd - dt);
      // 脱困的判据：**一帧被推开 > 25cm** 才算"陷进去了"。
      // 走路撞墙时每帧最多扎进去 speed*dt ≈ 8.7cm（跑起来 20cm）⇒ 不会误触发；
      // 真陷进楼里/被夹在两栋楼之间时，resolve 一帧要推几十厘米甚至几米。
      // （之前拿"卡住 1.2 秒 + 有穿透"当条件，实测顶着墙走 3 秒就会误触发一次 —— 那会变悠悠球。）
      const deepNow = info.deep > 0.25;
      p.deepHits = deepNow ? Math.min(4, (p.deepHits || 0) + 1) : Math.max(0, (p.deepHits || 0) - 1);
      const wedged = deepNow || p.deepHits >= 3;
      if (wedged && !p.escape && p.escapeCd <= 0) {
        const n = Math.hypot(info.nx, info.nz);
        const vl = Math.hypot(p.vel.x, p.vel.z) || 1;
        p.escape = n > 1e-6
          ? { nx: info.nx / n, nz: info.nz / n, t: p.escapeTime }
          : { nx: -p.vel.x / vl, nz: -p.vel.z / vl, t: p.escapeTime };   // 没记到面法线：原路退一步
        p.escapeCd = 1.5; p.stuck = 0; p.deepHits = 0;
        p.escapes = (p.escapes || 0) + 1;
      }
      if (p.escape) { p.escape.t -= dt; if (p.escape.t <= 0) p.escape = null; }
    }
    return p;
  };
  p.camera = () => {
    const d = dirOf();
    const head = { x: p.pos.x, y: p.y + Math.sin(p.bob * 2) * 0.035 * (p.third ? 0 : 1), z: p.pos.z };
    if (p.third) {
      const back = p.camDist;
      const eye = {
        x: head.x - d.x * back, y: Math.max(1.2, head.y + p.camHeight - d.y * back * 0.65),
        z: head.z - d.z * back,
      };
      return { pos: [eye.x, eye.y, eye.z], target: [head.x + d.x * 5, head.y + d.y * 5 - 0.4, head.z + d.z * 5], fov: 58 };
    }
    return { pos: [head.x, head.y, head.z], target: [head.x + d.x * 10, head.y + d.y * 10, head.z + d.z * 10], fov: 72 };
  };
  return p;
}
