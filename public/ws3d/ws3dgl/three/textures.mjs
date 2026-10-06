// textures.mjs —— 程序化贴图（Canvas2D 画出来，不下载任何素材）。
//
// 一条铁律：**所有贴图都按"米"定义 tile 尺寸**（TILE.w × TILE.h），
// 几何那边把 UV 按 米/tile 缩放 ⇒ 一栋 40m 高的楼贴 7 层窗户，不用给每栋楼单独做贴图。
// 贴图相位（贴图从哪一格开始）由建筑物自己的随机偏移决定，避免整条街窗户一模一样。
//
// 本喵把每张贴图都写成"白天色 + 自发光色"一对：夜里只把 emissiveIntensity 推上去，
// 几何与 UV 一根线都不动 —— 两档风格共用同一套材质，切风格不掉帧、不重建。
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from '../vendor/three.min.js';
import { TIERS, GROUND, ACCENT, TILE, SHOP_H, toRgb, hex, shade } from './palette.mjs';
import { rngOf, hashSeed } from '../util.mjs';

// tile 尺寸与底商层高定义在 palette.mjs（那份不依赖 three，node 里能被 build/selftest 直接用）
export { TILE, SHOP_H };
const BAY = TILE.w / 4;               // 一个开间 4m
const FLOOR = TILE.h / 4;             // 一层 3.3m

const rgba = (c, a = 1) => {
  const [r, g, b] = toRgb(c);
  return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`;
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function tex(cv, { srgb = true, repeat = true } = {}) {
  const t = new CanvasTexture(cv);
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : RepeatWrapping;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  t.userData.canvas = cv;
  return t;
}

/** 撒点噪声（贴图别太干净，干净就假） */
function speckle(ctx, w, h, rng, n, alpha = 0.06, size = 2) {
  for (let i = 0; i < n; i++) {
    const dark = rng.chance(0.5);
    ctx.fillStyle = `rgba(${dark ? 0 : 255},${dark ? 0 : 255},${dark ? 0 : 255},${alpha * rng.range(0.4, 1.3)})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(1, size), rng.range(1, size));
  }
}

/** 竖直渐变（窗玻璃的天空反光） */
function vgrad(ctx, x, y, w, h, top, bottom) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

// ── 楼体贴图 ─────────────────────────────────────────────────────────────────
/** 三层砖墙：砖缝 + 楼层线 + 窗（白天）/ 亮灯窗（自发光） */
function drawBrick(base, rng) {
  const W = 512, H = 512;
  const cv = canvas(W, H), ctx = cv.getContext('2d');
  const ev = canvas(W, H), ectx = ev.getContext('2d');
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);

  ctx.fillStyle = rgba(base.base);
  ctx.fillRect(0, 0, W, H);
  // 砖：0.25m 一层砖（≈9.7px），0.52m 一顺砖（≈16.6px）
  const bh = (0.25 / FLOOR) * (H / 4), bw = (0.52 / BAY) * (W / 4);
  for (let row = 0; row * bh < H; row++) {
    const off = (row % 2) * bw * 0.5;
    for (let col = -1; col * bw < W + bw; col++) {
      ctx.fillStyle = rgba(shade(base.base, rng.range(0.9, 1.1)));
      ctx.fillRect(col * bw + off + 0.8, row * bh + 0.8, bw - 1.6, bh - 1.6);
    }
  }
  speckle(ctx, W, H, rng, 2200, 0.05, 3);

  // 楼层线：每层一道深色带（远看就是"这楼有分层"）
  for (let f = 0; f <= 4; f++) {
    const y = (f / 4) * H;
    ctx.fillStyle = rgba(shade(base.trim, 0.82), 0.85);
    ctx.fillRect(0, y - 3, W, 6);
  }
  return { cv, ev, W, H, ctx, ectx, base, rng };
}

function windowsOn(ctx, ectx, base, rng, geoms, { litShare = 0.5, bottomLit = true } = {}) {
  const lit = base.lit || ['#ffd9a0'];
  for (const g of geoms) {
    const { x, y, w, h } = g;
    // 窗框
    ctx.fillStyle = rgba(base.trim);
    ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
    // 玻璃：上亮下暗（天空反光）
    vgrad(ctx, x, y, w, h, rgba(shade(base.glass, 1.55)), rgba(shade(base.glass, 0.8)));
    // 窗台
    ctx.fillStyle = rgba(base.sill || base.trim);
    ctx.fillRect(x - 7, y + h + 3, w + 14, 5);
    // 中竖梃
    ctx.fillStyle = rgba(base.trim);
    ctx.fillRect(x + w / 2 - 1.5, y, 3, h);

    const isBottom = bottomLit && g.bottom;
    if (isBottom || rng.chance(litShare)) {
      const c = lit[(rng.next() * lit.length) | 0];
      ectx.fillStyle = rgba(c, isBottom ? 0.95 : rng.range(0.55, 1));
      ectx.fillRect(x, y, w, h);
      // 室内阴影：让亮窗不是一块死白
      ectx.fillStyle = 'rgba(0,0,0,0.35)';
      ectx.fillRect(x, y + h * 0.55, w, h * 0.45);
    }
  }
}

function makeFacade(tier, idx) {
  const rng = rngOf(hashSeed('facade-three', tier.key, idx));
  const base = { ...tier, lit: tier.lit };
  const { cv, ev, W, H, ctx, ectx } = drawBrick(base, rng);

  // 窗洞：4 开间 × 4 层
  const geoms = [];
  for (let f = 0; f < 4; f++) {
    for (let b = 0; b < 4; b++) {
      const bx = (b / 4) * W, by = (f / 4) * H;
      const gw = (1.92 / BAY) * (W / 4), gh = (1.5 / FLOOR) * (H / 4);
      geoms.push({ x: bx + (W / 4 - gw) / 2, y: by + (H / 4 - gh) * 0.42, w: gw, h: gh, bottom: f === 0 });
    }
  }
  windowsOn(ctx, ectx, base, rng, geoms, { litShare: tier.key === 'glass' ? 0.62 : 0.48 });
  speckle(ectx, W, H, rngOf(hashSeed('facade-e', tier.key)), 300, 0.05, 2);
  return { map: tex(cv), emissiveMap: tex(ev) };
}

/** 混凝土板楼：板缝 + 窗带 + 竖向分户缝 */
function makeConcrete(tier) {
  const rng = rngOf(hashSeed('concrete-three', tier.key));
  const W = 512, H = 512;
  const cv = canvas(W, H), ctx = cv.getContext('2d');
  const ev = canvas(W, H), ectx = ev.getContext('2d');
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgba(tier.base); ctx.fillRect(0, 0, W, H);
  // 预制板缝：每层一道横缝 + 每开间一道竖缝
  for (let f = 0; f <= 4; f++) {
    ctx.fillStyle = rgba(shade(tier.trim, 0.8), 0.9);
    ctx.fillRect(0, (f / 4) * H - 2, W, 4);
  }
  for (let b = 0; b <= 4; b++) {
    ctx.fillStyle = rgba(shade(tier.trim, 0.88), 0.6);
    ctx.fillRect((b / 4) * W - 1.5, 0, 3, H);
  }
  speckle(ctx, W, H, rng, 2600, 0.05, 3);
  // 雨痕（竖向淡痕，混凝土的"脏"）
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, W);
    ctx.fillStyle = `rgba(60,58,54,${rng.range(0.03, 0.09)})`;
    ctx.fillRect(x, 0, rng.range(2, 9), H);
  }
  const geoms = [];
  for (let f = 0; f < 4; f++) {
    for (let b = 0; b < 4; b++) {
      const bx = (b / 4) * W, by = (f / 4) * H;
      const gw = (2.5 / BAY) * (W / 4), gh = (1.6 / FLOOR) * (H / 4);
      geoms.push({ x: bx + (W / 4 - gw) / 2, y: by + (H / 4 - gh) * 0.4, w: gw, h: gh, bottom: f === 0 });
    }
  }
  windowsOn(ctx, ectx, { ...tier, lit: tier.lit }, rng, geoms, { litShare: 0.5 });
  return { map: tex(cv), emissiveMap: tex(ev) };
}

/** 玻璃幕墙：整片分格 + 竖向天空反光 + 少数整格亮灯 */
function makeCurtain(tier) {
  const rng = rngOf(hashSeed('curtain-three', tier.key));
  const W = 512, H = 512;
  const cv = canvas(W, H), ctx = cv.getContext('2d');
  const ev = canvas(W, H), ectx = ev.getContext('2d');
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgba(tier.base); ctx.fillRect(0, 0, W, H);
  const cw = W / 4, ch = H / 4;
  for (let f = 0; f < 4; f++) {
    for (let b = 0; b < 4; b++) {
      const x = b * cw, y = f * ch;
      // 每格玻璃：天空反光（上亮下暗）+ 层间梁（下面 22% 是实体）
      vgrad(ctx, x, y, cw, ch * 0.78, rgba(shade(tier.glass, 1.9)), rgba(shade(tier.glass, 0.95)));
      ctx.fillStyle = rgba(tier.trim, 0.95);
      ctx.fillRect(x, y + ch * 0.78, cw, ch * 0.22);
      // 斜向高光
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, cw, ch * 0.78); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(x, y + ch * 0.5); ctx.lineTo(x + cw, y); ctx.lineTo(x + cw, y + ch * 0.18); ctx.lineTo(x, y + ch * 0.68);
      ctx.closePath(); ctx.fill(); ctx.restore();
      if (rng.chance(0.55)) {
        ectx.fillStyle = rgba(tier.lit[(rng.next() * tier.lit.length) | 0], rng.range(0.5, 0.95));
        ectx.fillRect(x + 1, y + 1, cw - 2, ch * 0.78 - 2);
      }
    }
  }
  // 幕墙竖梃 / 横梁
  ctx.fillStyle = rgba(shade(tier.trim, 1.05), 0.9);
  for (let b = 0; b <= 4; b++) ctx.fillRect((b / 4) * W - 2, 0, 4, H);
  for (let f = 0; f <= 4; f++) ctx.fillRect(0, (f / 4) * H - 2, W, 4);
  return { map: tex(cv), emissiveMap: tex(ev) };
}

/** 底商：门面玻璃 + 招牌 + 遮阳棚（夜里整排亮起来，霓虹感就靠它） */
function makeShop() {
  const rng = rngOf(hashSeed('shop-three'));
  const W = 512, H = 134;                     // 16m × 4.2m
  const cv = canvas(W, H), ctx = cv.getContext('2d');
  const ev = canvas(W, H), ectx = ev.getContext('2d');
  ctx.fillStyle = rgba('#5d5952'); ctx.fillRect(0, 0, W, H);
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
  const bay = W / 4;
  const pxm = H / SHOP_H;                      // 每米像素
  for (let b = 0; b < 4; b++) {
    const x = b * bay;
    // 店面玻璃（0.5m 到 3.1m 高 → canvas 是 y 反向的：上面是高处）
    const gy = H - 3.1 * pxm, gh = 2.6 * pxm;
    ctx.fillStyle = rgba('#22282f'); ctx.fillRect(x + 6, gy, bay - 12, gh);
    vgrad(ctx, x + 6, gy, bay - 12, gh, 'rgba(255,235,200,0.30)', 'rgba(120,150,190,0.16)');
    const warm = rng.chance(0.6);
    ectx.fillStyle = rgba(warm ? '#ffcf8a' : ACCENT.neon, rng.range(0.55, 0.95));
    ectx.fillRect(x + 6, gy, bay - 12, gh);
    ectx.fillStyle = 'rgba(0,0,0,0.45)';
    ectx.fillRect(x + 6, gy + gh * 0.6, bay - 12, gh * 0.4);
    // 门（每两开间一个）
    if (b % 2 === 0) {
      ctx.fillStyle = rgba('#2c333b'); ctx.fillRect(x + bay * 0.5 - 12, H - 3.0 * pxm, 24, 3.0 * pxm);
      ectx.fillStyle = rgba('#ffd9a0', 0.5); ectx.fillRect(x + bay * 0.5 - 10, H - 2.9 * pxm, 20, 2.9 * pxm);
    }
    // 招牌
    const sy = 4, sh = Math.max(10, 0.75 * pxm);
    ctx.fillStyle = rgba(rng.pick(['#8c3b34', '#2f4d63', '#3c3c3c', '#6b5a3a']));
    ctx.fillRect(x + 8, sy, bay - 16, sh);
    ectx.fillStyle = rgba(rng.pick([ACCENT.warm, ACCENT.neon, ACCENT.neon2, '#fff0c0']), 0.85);
    ectx.fillRect(x + 10, sy + 2, bay - 20, sh - 4);
    // 遮阳棚
    if (rng.chance(0.45)) {
      ctx.fillStyle = rgba(rng.pick([ACCENT.warm, '#8c3b34', '#3f6b52']), 0.9);
      ctx.fillRect(x + 4, sy + sh + 2, bay - 8, Math.max(6, 0.5 * pxm));
    }
  }
  // 底商与楼体之间的腰线
  ctx.fillStyle = rgba('#4a4740'); ctx.fillRect(0, 0, W, 3);
  speckle(ctx, W, H, rng, 700, 0.06, 2);
  return { map: tex(cv), emissiveMap: tex(ev) };
}

/** 抹灰/涂料楼（第 4 套）：平整墙面 + 每层一道分格缝 + 白框窗（国内住宅最常见的那类） */
function makePaint(tier) {
  const rng = rngOf(hashSeed('paint-three', tier.key));
  const W = 512, H = 512;
  const cv = canvas(W, H), ctx = cv.getContext('2d');
  const ev = canvas(W, H), ectx = ev.getContext('2d');
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgba(tier.base); ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rng, 1800, 0.04, 4);
  for (let f = 0; f <= 4; f++) {                       // 层间分格缝（细）
    ctx.fillStyle = rgba(shade(tier.trim, 0.92), 0.7);
    ctx.fillRect(0, (f / 4) * H - 1.5, W, 3);
  }
  for (let i = 0; i < 18; i++) {                       // 墙面雨痕/脏污
    const x = rng.range(0, W);
    ctx.fillStyle = `rgba(90,86,74,${rng.range(0.02, 0.07)})`;
    ctx.fillRect(x, rng.range(0, H * 0.4), rng.range(3, 14), H);
  }
  const geoms = [];
  for (let f = 0; f < 4; f++) {
    for (let b = 0; b < 4; b++) {
      const bx = (b / 4) * W, by = (f / 4) * H;
      const gw = (1.6 / BAY) * (W / 4), gh = (1.45 / FLOOR) * (H / 4);
      geoms.push({ x: bx + (W / 4 - gw) / 2, y: by + (H / 4 - gh) * 0.44, w: gw, h: gh, bottom: f === 0 });
    }
  }
  windowsOn(ctx, ectx, { ...tier, trim: '#e8e6df', sill: '#d8d4c8', lit: tier.lit }, rng, geoms, { litShare: 0.45 });
  return { map: tex(cv), emissiveMap: tex(ev) };
}

// ── 地面 / 屋面 / 配景 ───────────────────────────────────────────────────────
function makeRoof() {
  const rng = rngOf(hashSeed('roof-three'));
  const S = 256, cv = canvas(S, S), ctx = cv.getContext('2d');
  ctx.fillStyle = rgba(GROUND.roof); ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rng, 5200, 0.13, 2);                     // 沥青卷材的颗粒
  for (let i = 0; i < 12; i++) {                              // 补丁
    ctx.fillStyle = `rgba(${rng.chance(0.5) ? '30,30,30' : '150,148,140'},${rng.range(0.05, 0.14)})`;
    ctx.fillRect(rng.range(0, S), rng.range(0, S), rng.range(12, 60), rng.range(10, 44));
  }
  ctx.strokeStyle = 'rgba(40,40,40,0.25)'; ctx.lineWidth = 2;  // 卷材接缝
  for (let i = 0; i < 4; i++) { const y = (i / 4) * S; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
  return tex(cv);
}

function makeAsphalt() {
  const rng = rngOf(hashSeed('asphalt-three'));
  const S = 256, cv = canvas(S, S), ctx = cv.getContext('2d');
  ctx.fillStyle = rgba(GROUND.asphalt); ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rng, 9000, 0.16, 2);
  for (let i = 0; i < 26; i++) {                               // 补丁 / 油渍
    ctx.fillStyle = `rgba(${rng.chance(0.6) ? '22,22,24' : '120,120,124'},${rng.range(0.04, 0.12)})`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, S), rng.range(0, S), rng.range(6, 34), rng.range(4, 22), rng.range(0, 3.14), 0, 6.3);
    ctx.fill();
  }
  for (let i = 0; i < 5; i++) {                                // 裂缝
    ctx.strokeStyle = `rgba(18,18,20,${rng.range(0.2, 0.45)})`; ctx.lineWidth = rng.range(1, 2.4);
    ctx.beginPath();
    let x = rng.range(0, S), y = rng.range(0, S);
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += rng.range(-30, 30); y += rng.range(-30, 30); ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return tex(cv);
}

/** 带车道线的沥青：u∈[0,1] 跨整个路宽（宽路专用），v 沿路每 9m 一循环 ⇒ 虚线正好 3m 线 6m 空 */
function makeAsphaltWide() {
  const rng = rngOf(hashSeed('asphalt-wide-three'));
  const W = 256, H = 256, cv = canvas(W, H), ctx = cv.getContext('2d');
  ctx.fillStyle = rgba(GROUND.asphalt); ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rng, 9000, 0.16, 2);
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = `rgba(${rng.chance(0.6) ? '22,22,24' : '120,120,124'},${rng.range(0.04, 0.12)})`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, W), rng.range(0, H), rng.range(6, 30), rng.range(4, 20), rng.range(0, 3.14), 0, 6.3);
    ctx.fill();
  }
  const px = (m) => (m / 11) * W;                       // 按 11m 路宽折算（宽路都是这个量级）
  // 中线虚线：3m 线 + 6m 空 = 9m 一循环 = 整个 tile
  ctx.fillStyle = rgba(GROUND.paintY, 0.92);
  ctx.fillRect(W / 2 - px(0.08), 0, px(0.16), H / 3);
  // 两条边线（实线）
  ctx.fillStyle = rgba(GROUND.paint, 0.9);
  ctx.fillRect(px(0.35), 0, px(0.15), H);
  ctx.fillRect(W - px(0.5), 0, px(0.15), H);
  // 车道分隔虚线（左右各一条）
  ctx.fillStyle = rgba(GROUND.paint, 0.75);
  for (let k = 0; k < 2; k++) {
    const x = W * (0.3 + k * 0.4);
    ctx.fillRect(x - px(0.07), H * 0.1, px(0.14), H * 0.35);
    ctx.fillRect(x - px(0.07), H * 0.6, px(0.14), H * 0.35);
  }
  speckle(ctx, W, H, rng, 1500, 0.1, 2);
  return tex(cv);
}

function makeSidewalk() {
  const rng = rngOf(hashSeed('walk-three'));
  const S = 256, cv = canvas(S, S), ctx = cv.getContext('2d');   // 4m × 4m = 2×2 块 2m 铺装
  ctx.fillStyle = rgba(GROUND.sidewalk); ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rng, 4200, 0.1, 2);
  const g = S / 2;
  for (let i = 0; i <= 2; i++) {                                 // 分格缝
    ctx.fillStyle = 'rgba(70,68,64,0.5)';
    ctx.fillRect(i * g - 2, 0, 4, S);
    ctx.fillRect(0, i * g - 2, S, 4);
  }
  for (let i = 0; i < 4; i++) {                                  // 每块砖的高光/暗角
    const x = (i % 2) * g, y = ((i / 2) | 0) * g;
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.02, 0.06)})`;
    ctx.fillRect(x + 3, y + 3, g - 6, g * 0.4);
  }
  // 盲道（黄）沿一边
  ctx.fillStyle = rgba('#b9a04a', 0.5);
  ctx.fillRect(0, g - 6, S, 12);
  return tex(cv);
}

function makeGround() {
  const rng = rngOf(hashSeed('ground-three'));
  const S = 256, cv = canvas(S, S), ctx = cv.getContext('2d');
  ctx.fillStyle = rgba(GROUND.soil); ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rng, 6000, 0.12, 3);
  for (let i = 0; i < 30; i++) {                                 // 草地/土斑
    ctx.fillStyle = `rgba(${rng.chance(0.5) ? '74,110,58' : '96,90,80'},${rng.range(0.06, 0.2)})`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, S), rng.range(0, S), rng.range(10, 46), rng.range(8, 32), rng.range(0, 3.1), 0, 6.3);
    ctx.fill();
  }
  return tex(cv);
}

function makeBark() {
  const rng = rngOf(hashSeed('bark-three'));
  const S = 64, cv = canvas(S, S), ctx = cv.getContext('2d');
  ctx.fillStyle = rgba(GROUND.bark); ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${rng.chance(0.5) ? '30,22,16' : '120,96,72'},${rng.range(0.1, 0.3)})`;
    ctx.fillRect(rng.range(0, S), rng.range(0, S), rng.range(1, 4), rng.range(6, 40));
  }
  return tex(cv);
}

/** 灯光辉光贴图（Points 用，加色混合 ⇒ 夜里一盏灯就是一团光） */
export function makeGlowTexture() {
  const S = 64, cv = canvas(S, S), ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,244,220,1)');
  g.addColorStop(0.25, 'rgba(255,226,170,0.55)');
  g.addColorStop(0.6, 'rgba(255,190,120,0.14)');
  g.addColorStop(1, 'rgba(255,180,110,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = tex(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** 一次性把整套贴图建出来（建一次，两档风格共用；切风格只改材质的 emissiveIntensity） */
export function buildTextureSet() {
  const facades = TIERS.map((t, i) => (
    t.key === 'glass' ? makeCurtain(t)
      : t.key === 'concrete' ? makeConcrete(t)
        : t.key === 'paint' ? makePaint(t)
          : makeFacade(t, i)));
  return {
    facades,
    shop: makeShop(),
    roof: makeRoof(),
    asphalt: makeAsphalt(),
    asphaltWide: makeAsphaltWide(),
    sidewalk: makeSidewalk(),
    ground: makeGround(),
    bark: makeBark(),
    glow: makeGlowTexture(),
  };
}
