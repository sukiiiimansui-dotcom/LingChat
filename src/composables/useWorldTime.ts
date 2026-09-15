// 「世界模拟」T4-1：昼夜状态 —— 真实时间 → 时段 / 昼夜色调 / 窗户光强度
//
// 为什么单独一个 composable（而不是写在 WorldSim.vue 里）：
//   · 这一层要处理「后端时钟 + 本地兜底 + 对齐时段边界 + 回前台补一次」四件事，
//     塞进已经 1400 多行的页面里会淹掉；
//   · 后面的 T4-3/T4-4（路人密度按时段变）也要读同一个时段 —— 从页面里拿不到，
//     从 composable 里拿得到。
//
// ── 时间从哪来 ────────────────────────────────────────────────────────────
//   `worldMapApi.time()`（真壳 `world_map_time` / 浏览器 `/api/time`），它给的是
//   **设备本地时间**（Rust 侧 `chrono::Local`）。拿不到就用浏览器本机时钟 ——
//   本地时钟永远有，绝不空着，也就**不依赖任何网络**（T4-1 的验收不被天气接口卡住）。
//
// ── 为什么不是每秒一个 tick ───────────────────────────────────────────────
//   时段的最小粒度是 1 小时，色调插值是连续的。每秒重算 = 每秒重渲染一次覆盖层，
//   手机上纯属浪费。所以：
//     · 定时器只在**跨过下一个时段边界**时才唤醒（`msToNextPeriod`）；
//     · 另外每 `SYNC_MS` 跟后端对一次表（设备改时间/时区也能跟上）；
//     · 页面回到前台立刻对一次（息屏一晚上回来，时间必须是新的）。

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef } from "vue";
import worldMapApi from "@/api/services/worldMap";
import {
  isDay,
  nightLevel,
  periodIcon,
  periodLabel,
  periodOf,
  timeTint,
  type WsPeriod,
  type WsTimeTint,
} from "@/components/views/worldsim/wsTime";

/** 与后端对表的间隔（5 分钟）。后端那个接口本身就有缓存，不怕问。 */
const SYNC_MS = 5 * 60 * 1000;
/** 对表失败后的重试间隔（别拿失败当常态一直打） */
const RETRY_MS = 60 * 1000;
/** 本地时钟兜底的最小推进粒度：1 分钟（只影响「后端拿不到」这一条路） */
const LOCAL_TICK_MS = 60 * 1000;

/** 小数小时（本地时钟） */
function localHour(): number {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** 距离下一个整点还有多少毫秒（时段边界一律落在整点） */
function msToNextHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const frac = h - Math.floor(h);
  const ms = Math.round((1 - frac) * 3600 * 1000);
  return Math.max(1000, ms);
}

/** 「09:42」这样的短文本（角标用；不需要秒） */
function hhmm(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const m = Math.floor((h % 1) * 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(h))}:${p(m)}`;
}

/** 从 `/api/time` 的返回里抠出小时数（带小数）。取不到返回 null。 */
function hourOf(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const h = Number(o.hour);
  if (!Number.isFinite(h)) return null;
  const mi = Number(o.minute);
  const s = Number(o.second);
  return h + (Number.isFinite(mi) ? mi / 60 : 0) + (Number.isFinite(s) ? s / 3600 : 0);
}

export interface UseWorldTime {
  /** 当前小数小时（0~24） */
  hour: ComputedRef<number>;
  /** 当前时段 */
  period: ComputedRef<WsPeriod>;
  /** 时段中文名（黎明/清晨/…/夜晚） */
  periodText: ComputedRef<string>;
  /** 时段图标 */
  periodIconText: ComputedRef<string>;
  /** 是否白天 */
  daytime: ComputedRef<boolean>;
  /** 昼夜色调（含 `css`，覆盖层直接拿去用） */
  tint: ComputedRef<WsTimeTint>;
  /** 天黑程度 0..1（窗户光用） */
  night: ComputedRef<number>;
  /** 「09:42」 */
  clockText: ComputedRef<string>;
  /** 时间来源：后端 / 本机兜底 */
  source: ComputedRef<"server" | "device">;
  /** 手动覆盖小时数（预览/自检用）；传 null 恢复跟随真实时间 */
  setHourOverride: (h: number | null) => void;
  /** 立刻与后端对一次表 */
  sync: () => Promise<void>;
}

/**
 * 没有"开关"参数：这一层只读时间（5 分钟一次，失败就退回本机时钟），
 * 关掉它没有任何好处 —— 少一个参数就少一条没人走的分支。
 */
export function useWorldTime(): UseWorldTime {
  const hourRef = ref<number>(localHour());
  const source = ref<"server" | "device">("device");
  const override = ref<number | null>(null);

  let timer: number | null = null;
  let syncTimer: number | null = null;
  let alive = true;

  function clearTimers() {
    if (timer !== null) window.clearTimeout(timer);
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    timer = null;
    syncTimer = null;
  }

  /** 排下一次唤醒：只在跨过下一个整点时才重算（时段边界一律在整点） */
  function scheduleBoundary() {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      tickLocal();
      scheduleBoundary();
    }, msToNextHour(hourRef.value));
  }

  /** 本机时钟推进（后端拿不到时也照样走） */
  function tickLocal() {
    if (!alive || override.value !== null) return;
    if (source.value === "device") hourRef.value = localHour();
  }

  /** 每 5 分钟对一次表；失败就 1 分钟后再来 */
  function scheduleSync() {
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(
      () => {
        void sync().finally(() => {
          if (alive) scheduleSync();
        });
      },
      source.value === "server" ? SYNC_MS : RETRY_MS
    );
  }

  async function sync(): Promise<void> {
    if (!alive) return;
    if (override.value !== null) return; // 手动覆盖期间不去打扰后端
    try {
      const h = hourOf(await worldMapApi.time());
      if (!alive) return;
      if (h === null) throw new Error("time payload 没有 hour");
      hourRef.value = h;
      source.value = "server";
    } catch {
      // 拿不到就继续用本机时钟 —— 不报错、不刷屏（这也是「不依赖网络」的实现）
      if (!alive) return;
      source.value = "device";
      hourRef.value = localHour();
    }
  }

  /** 回到前台：息屏一晚上回来，必须立刻对表 */
  function onVisible() {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") {
      tickLocal();
      void sync();
    }
  }

  onMounted(() => {
    alive = true;
    void sync();
    scheduleSync();
    scheduleBoundary();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
  });

  onBeforeUnmount(() => {
    alive = false;
    clearTimers();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  });

  const hour = computed(() => (override.value !== null ? override.value : hourRef.value));
  const tint = computed(() => timeTint(hour.value));

  return {
    hour,
    period: computed(() => periodOf(hour.value)),
    periodText: computed(() => periodLabel(periodOf(hour.value))),
    periodIconText: computed(() => periodIcon(periodOf(hour.value))),
    daytime: computed(() => isDay(hour.value)),
    tint,
    night: computed(() => nightLevel(hour.value)),
    clockText: computed(() => hhmm(hour.value)),
    source: computed(() => source.value),
    setHourOverride: (h: number | null) => {
      override.value = h;
    },
    sync,
  };
}
