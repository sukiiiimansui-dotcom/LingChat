/**
 * useWsCountUp —— 「数字滚动」（MG 动效切片 C，2026-09-19）
 *
 * ## 为什么需要它
 * 界面上有一堆**会突然跳变**的数字：天气温度（0 → 23）、行程百分比（0% → 47%）、
 * 楼房数、好感值…… 数据一到就"啪"地换成新值，用户根本来不及意识到"它变了"。
 * 数字从旧值**滚**到新值，变化的幅度就变成了看得见的信息 —— 这就是 count-up。
 *
 * ## 它的边界（很重要，别拿它当万能动画）
 * · **只负责一个数字**。不要拿它驱动进度条（那是 `transform: scaleX()` 的活）；
 * · **只在值真的变了才动**（差 0 就直接返回，不会白跑一帧）；
 * · 跑一次约 0.42 秒就结束，**不是循环动画** —— 不占常驻合成层，不烧电；
 * · 走 `requestAnimationFrame`（浏览器原生，零依赖）。
 *
 * ## 三条降级（本项目纪律）
 * 1. `prefers-reduced-motion: reduce` → **直接跳到终值**（不做滚动）；
 * 2. 低端机（`.ws-root.ws-perf-low`）→ 同样直接跳（每次开始时查一次，开销可忽略）；
 * 3. 组件卸载 → 立刻 `cancelAnimationFrame`（不然会对着已经销毁的 ref 写值）。
 *
 * ## 用它的时候记得配 `font-variant-numeric: tabular-nums`
 * 数字滚动每帧都在改文本宽度：`23` → `9` 会让那一格变窄、把旁边的字挤一下。
 * 等宽数字（tabular-nums）能让每个数字占一样宽，滚动时那一行就不会左右抖。
 *
 * ## 用法
 * ```ts
 * const tempC = computed(() => (typeof s.value?.tempC === "number" ? Math.round(s.value.tempC) : null));
 * const tempShown = useWsCountUp(tempC);          // Ref<number | null>
 * const tempText = computed(() => (tempShown.value === null ? "—" : `${tempShown.value}°C`));
 * ```
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";

/** 默认时长（毫秒）。150~300ms 是 MD3 的"微交互"档，数字滚动略长一点更好读，但不超过 500ms。 */
export const COUNT_UP_MS = 420;

/** 数字滚动的缓动：快起慢停（跟界面上其它进入动画同一口径，视觉上是一家人） */
export function easeOutCubic(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - x, 3);
}

/**
 * 纯函数：这一帧该显示哪个数？（抽出来是为了能被 node 自检直接调，不用开浏览器）
 * @param from 起始值  @param to 终值  @param t 进度 0~1  @param decimals 保留几位小数
 */
export function countUpAt(from: number, to: number, t: number, decimals = 0): number {
  const v = from + (to - from) * easeOutCubic(t);
  const f = Math.pow(10, Math.max(0, Math.min(6, Math.round(decimals))));
  return Math.round(v * f) / f;
}

/** 纯函数：这次变化值不值得做动画？（0 差、降级、系统关了动画 —— 都不值得） */
export function shouldCountUp(prev: number | null, next: number | null, disabled = false): boolean {
  if (disabled) return false;
  if (prev === null || next === null) return false;
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  return prev !== next;
}

/** 系统设置里关了动画吗？（每次调用现查：用户可能中途改设置） */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * 低端机档位吗？—— `.ws-perf-low` 由 `wsPerf` 打在 `.ws-root` 上。
 * 这里**刻意不 import wsPerf**：那个模块带 localStorage 与帧率采样，为了读一个布尔值
 * 把整条依赖链拖进手机 App 的小组件里不划算。每次开始动画时查一次 DOM，开销可忽略。
 */
export function isPerfLow(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(".ws-root.ws-perf-low");
}

export interface CountUpOptions {
  /** 时长（毫秒），默认 `COUNT_UP_MS` */
  ms?: number;
  /** 保留小数位，默认 0（整数滚动） */
  decimals?: number;
  /** 手动禁用（比如父级明确知道这一档不该动） */
  disabled?: boolean;
  /** 第一次拿到值时是否也从 0 滚上去（默认 true —— 这才是"数字滚动"该有的样子） */
  animateFirst?: boolean;
}

/**
 * @param src 数字来源（ref 或 getter 都行）；`null` / `undefined` = 没有数据（原样返回 null）
 * @returns 当前**该显示**的数字（滚动过程中是中间值）
 */
export function useWsCountUp(
  src: Ref<number | null | undefined> | (() => number | null | undefined),
  opts: CountUpOptions = {}
): Ref<number | null> {
  const get = typeof src === "function" ? src : () => src.value;
  const ms = Math.max(0, opts.ms ?? COUNT_UP_MS);
  const decimals = opts.decimals ?? 0;
  const animateFirst = opts.animateFirst !== false;

  const shown = ref<number | null>(null);
  let raf = 0;
  let first = true;

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function settle(v: number | null) {
    stop();
    shown.value = v;
  }

  function start(from: number, to: number) {
    stop();
    if (ms === 0) return settle(to);
    const t0 =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const step = () => {
      const now =
        typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const t = (now - t0) / ms;
      if (t >= 1) {
        shown.value = countUpAt(from, to, 1, decimals);
        raf = 0;
        return;
      }
      shown.value = countUpAt(from, to, t, decimals);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  watch(
    get,
    (raw) => {
      const next =
        typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw * 10 ** decimals) / 10 ** decimals : null;
      // 没有数据：原样返回 null（**不要拿 0 冒充** —— 与本项目"不编假数据"的口径一致）
      if (next === null) return settle(null);

      const from = shown.value;
      const isFirst = first;
      first = false;

      // 降级：系统关了动画 / 低端机 → 直接给终值
      const disabled = opts.disabled || prefersReducedMotion() || isPerfLow();
      if (disabled || (isFirst && !animateFirst) || from === null) {
        // 第一次（且允许动画）从 0 滚上来；否则直接落定
        if (isFirst && animateFirst && !disabled) return start(0, next);
        return settle(next);
      }
      if (!shouldCountUp(from, next)) return settle(next);
      start(from, next);
    },
    { immediate: true }
  );

  // 卸载就把下一帧掐掉：不然回调还会对着已销毁的 ref 写值（Vue 会警告，且白烧一帧）
  onBeforeUnmount(stop);
  return shown;
}
