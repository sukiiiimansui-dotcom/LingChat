<!--
  「世界模拟」T4-2：天气视觉层 —— 雨/雪/雾粒子 + 天气色调 + 角标

  ── 三层叠在一起，顺序不能换（照搬老线 `WeatherLayer._frame`）─────────────
    ① `applyWeatherTint`  —— 天气的整体色（雨=灰蓝压暗、雪=提亮偏白、雾=低对比）；
    ② 昼夜色调            —— **压在天气色之上**（夜里该暗就得暗，不能被雪的提亮顶回来）；
    ③ 粒子                —— 雨丝 / 雪花 / 雾团，最后画，压在两层色上面。
    老线的注释写得很直白：「夜间压暗应覆盖天气提亮」。继承这个顺序。

  ── 为什么用 canvas，不用 DOM 粒子 ────────────────────────────────────────
    ① 老线的粒子算法（位置由 `t` 与索引哈希即时算出、帧间不存数组 → 零 GC）
       就是照着 canvas 写的，DOM 版本要几百个节点 + 每帧写 transform，
       手机上必掉帧；
    ② 一层 canvas 的合成代价是常数，粒子数只影响主线程里的几次 `path` 调用；
    ③ 天气色调要用 `globalCompositeOperation = "screen"`（提亮），
       canvas 里是一行，CSS 里得靠 `mix-blend-mode`（还得担心 WebView 支持度）。

  ── 与昼夜层的关系 ────────────────────────────────────────────────────────
    这一层的包含块也是 `.ws-stage`（`position: relative`），盖在地图上；
    昼夜层（`WsTimeLayer`）是**同一块区域的另一层 CSS 色**，z-index 都归 1、
    谁后挂谁在上面 —— 两者叠出来的就是 ①+②，与老线一致。
    昼夜色调在这层**再涂一遍**是因为它必须压在天气色之上；覆盖层那一份负责
    「没有天气时的白昼/夜晚」，这一份负责「有天气时的正确顺序」。两者的色值
    都来自同一个 `wsTime.ts::timeTint()`，不会漂。

  ── 什么天气不画粒子 ──────────────────────────────────────────────────────
    晴/多云/阴：没有粒子，只有①的色调。降级态（拿不到天气）：什么都不画，
    角标显示「天气不可用」—— 不编一个假天气出来。
-->
<template>
  <div class="ws-wx" aria-hidden="true" data-ws-wx>
    <canvas ref="cv" class="ws-wx__cv" />
  </div>
</template>

<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref, watch } from "vue";
  import { drawWeather, getPuff, weatherTint, type WsWeatherState } from "./wsWeather";
  import { timeTint, type WsTimeTint } from "./wsTime";

  const props = withDefaults(
    defineProps<{
      /** 当前天气（`wsWeather.ts::normalize` / `degradedState` 的产出） */
      weather: WsWeatherState;
      /** 当前昼夜色调（`wsTime.ts::timeTint`）；给了才叠第②层 */
      tint?: WsTimeTint | null;
      /** 低端机（`ws-perf-low`）：降帧 + 减粒子 */
      low?: boolean;
      /** 是否驱动动画。默认 true；`false` 时只画一帧静态图（自检/演示页用） */
      animate?: boolean;
    }>(),
    { tint: null, low: false, animate: true }
  );

  const cv = ref<HTMLCanvasElement | null>(null);

  /** Dpr 上限 2（照搬老线 `maxDpr`）：再高手机上只是白烧像素 */
  const MAX_DPR = 2;
  /** 帧率上限：常规 30，低端机 15（雨雪是低频运动，30 够；60 只是多烧电） */
  const FPS_NORMAL = 30;
  const FPS_LOW = 15;

  /**
   * 昼夜色在这层里的强度系数。
   *
   * ⚠️ 为什么不是 1：昼夜色在**页面里还有一个 CSS 覆盖层**（`WsTimeLayer`），
   *    那一层已经把这层色涂过一遍了。这里再涂一遍是为了让它压在**天气色之上**
   *    （老线的顺序）。两遍各用满强度，深夜就会暗到看不清地图
   *    （0.56 + 0.56 叠起来 ≈ 0.81）。所以这里的第二遍只出 55%。
   */
  const TIME_LAYER_SCALE = 0.55;

  let ctx: CanvasRenderingContext2D | null = null;
  let raf: number | null = null;
  let ro: ResizeObserver | null = null;
  let last = 0;
  let acc = 0;
  let cssW = 0;
  let cssH = 0;
  /** 上一帧画了什么（用于"静止画面只画一帧"的短路，省掉整个 RAF 循环） */
  let lastKey = "";

  function frameKey(): string {
    const w = props.weather;
    return [
      w.kind,
      w.degraded ? "d" : "",
      Math.round(w.intensity * 20),
      props.tint ? Math.round(props.tint.a * 100) : -1,
      props.tint ? Math.round(props.tint.hour * 60) : -1,
      cssW,
      cssH,
      props.low ? "L" : "",
    ].join("|");
  }

  function resize() {
    const c = cv.value;
    if (!c) return;
    const parent = c.parentElement;
    const w = Math.max(1, Math.round(parent?.clientWidth || c.clientWidth || 800));
    const h = Math.max(1, Math.round(parent?.clientHeight || c.clientHeight || 600));
    if (w === cssW && h === cssH) return;
    cssW = w;
    cssH = h;
    const dpr = Math.min(
      MAX_DPR,
      (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1) || 1
    );
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    ctx = c.getContext("2d");
    if (ctx?.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 单帧：清屏 → 天气色 → 昼夜色 → 粒子（顺序照搬老线 `WeatherLayer._frame`） */
  function paint(t: number) {
    const c = cv.value;
    if (!c || !ctx) return;
    const w = cssW;
    const h = cssH;
    ctx.clearRect(0, 0, w, h);
    const st = props.weather;

    // ① 天气色（`screen` 提亮 / `source-over` 压暗）
    const wt = weatherTint({ kind: st.kind, intensity: st.intensity });
    if (wt.a > 0) {
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = wt.mode;
      ctx.fillStyle = wt.css;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = prevOp;
    }

    // ② 昼夜色压在天气色之上（老线：「夜间压暗应覆盖天气提亮」）
    const tint = props.tint;
    if (tint && tint.a > 0) {
      ctx.fillStyle = timeTint(tint.hour).css;
      ctx.globalAlpha = TIME_LAYER_SCALE;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // ③ 粒子（降级态没有 kind，`drawWeather` 自然什么都不画）
    if (!st.degraded) {
      drawWeather(
        ctx as unknown as Parameters<typeof drawWeather>[0],
        st,
        w,
        h,
        t,
        props.low ? { maxRain: 120, maxSnow: 100 } : { maxRain: 260, maxSnow: 220 }
      );
    }
  }

  function loop(ts: number) {
    raf = null;
    const now = ts || (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (!last) last = now;
    const dt = now - last;
    last = now;
    acc += dt;
    const minGap = 1000 / (props.low ? FPS_LOW : FPS_NORMAL);
    if (acc < minGap) {
      schedule();
      return;
    }
    acc = 0;
    // 页面不可见时**不画**（后台标签页的 canvas 动画纯属烧电），但要继续排队，
    // 否则回到前台就再也不动了。
    if (typeof document === "undefined" || !document.hidden) paint(now);
    schedule();
  }

  function schedule() {
    if (!props.animate || raf !== null) return;
    raf = requestAnimationFrame(loop);
  }

  /** 静止模式（`animate=false`）：只画一帧 */
  function paintOnce() {
    resize();
    paint(typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  onMounted(() => {
    resize();
    lastKey = frameKey();
    if (props.animate) {
      schedule();
    } else {
      paintOnce();
    }
    if (typeof ResizeObserver !== "undefined" && cv.value?.parentElement) {
      ro = new ResizeObserver(() => {
        resize();
        if (!props.animate) paintOnce();
      });
      ro.observe(cv.value.parentElement);
    } else {
      window.addEventListener("resize", paintOnce);
    }
    // 雾团贴图惰性生成（只做一次，之后每帧只 drawImage）
    getPuff([214, 220, 228]);
  });

  onBeforeUnmount(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    ro?.disconnect();
    ro = null;
    window.removeEventListener("resize", paintOnce);
  });

  /**
   * 天气或昼夜变了 → 若在静止模式，重画一帧。
   * 动画模式下不需要（循环每帧都会读最新的 props），所以这里刻意只处理静止模式，
   * 免得每 30 分钟一次的天气刷新去打断 RAF 循环。
   */
  watch(
    () => frameKey(),
    () => {
      lastKey = frameKey();
      if (!props.animate) paintOnce();
    }
  );
</script>

<style scoped>
  /* 与 `WsTimeLayer` 同一块区域（`.ws-stage` 的 padding box），z-index 也是 1：
     两者谁在上都无所谓（色是叠加的），粒子在最上面由 canvas 内部顺序保证。 */
  .ws-wx {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    overflow: hidden;
  }
  .ws-wx__cv {
    display: block;
  }
</style>
