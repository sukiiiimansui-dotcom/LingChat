// 「世界模拟」T4-2：天气状态 —— 真实天气 → 判定/强度/降级
//
// 为什么单独一个 composable（而不是写在 WorldSim.vue 里）：
//   · 要处理「真壳 invoke / 浏览器 HTTP 双通路 + 定时刷新 + 拿不到时的降级 + 回前台补一次」
//     四件事，塞进已经 1500 多行的页面里会淹掉；
//   · 天气只有**一个真源**：角标、粒子层、以及将来「雨天路人变少」都读它 ——
//     各拿各的就会出现「角标写小雨、地图上却在飘雪」。
//
// ── 数据从哪来 ────────────────────────────────────────────────────────────
//   `worldMapApi.weather()`：真壳走 `world_map_weather`，浏览器预览走 HTTP
//   （`127.0.0.1:8791/api/weather`）。**这一层不自己 fetch** —— 老线
//   `world_weather.js` 写死了 `fetch(API_BASE + '/api/weather')`（8790），
//   在 APK 里那个服务不存在，所以老线那条路是真机上永远拿不到天气的。
//
// ── 拿不到的时候（T4-2 的硬要求：优雅降级，不伪造）───────────────────────
//   返回 `degradedState(reason)`：角标显示「天气不可用」，**不显示晴天、
//   不留空白、不报错刷屏**，也没有任何粒子。真源恢复后下一轮自动回到正常态。
//
// ── 刷新节奏 ──────────────────────────────────────────────────────────────
//   成功：30 分钟一次（与后端缓存 TTL 一致）。
//   失败：2 分钟一次（真源恢复得快，但也不能打成刷屏）。

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef } from "vue";
import worldMapApi from "@/api/services/worldMap";
import {
  degradedState,
  normalize,
  weatherLine,
  type WsWeatherState,
} from "@/components/views/worldsim/wsWeather";

/** 拿到真数据后的刷新间隔（30 分钟，与后端缓存 TTL 一致） */
const OK_MS = 30 * 60 * 1000;
/** 拿不到时的重试间隔（2 分钟） */
const RETRY_MS = 2 * 60 * 1000;

/** 从接口返回里抠出「可用的天气」；拿不到就给出降级原因（人工可读，不编） */
function usable(raw: unknown): WsWeatherState | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "接口没有返回天气数据" };
  const o = raw as Record<string, unknown>;
  const err = o.error;
  if (err) return { reason: String(err) };
  const cur = (o.current || o.weather || o) as Record<string, unknown>;
  // 判据：至少有温度或描述之一，才算「拿到了天气」。两者都没有 = 空壳响应。
  const hasTemp = cur.temp_c != null || cur.tempC != null || cur.temp != null;
  const hasDesc = String(cur.desc ?? cur.weather_desc ?? cur.text ?? "").trim() !== "";
  if (!hasTemp && !hasDesc) return { reason: "接口返回里没有温度也没有天气描述" };
  return normalize(raw);
}

export interface UseWorldWeather {
  /** 当前天气（拿不到时是 `degraded = true` 的降级态，**不是**晴天） */
  state: ComputedRef<WsWeatherState>;
  /** 角标一行字：`小雨 18°C` / `天气不可用` */
  line: ComputedRef<string>;
  /** 是否降级（没拿到真实天气） */
  degraded: ComputedRef<boolean>;
  /** 降级原因（角标 title 用） */
  reason: ComputedRef<string>;
  /** 拉一次（失败不抛，转成降级态） */
  refresh: () => Promise<void>;
  /**
   * 手动指定天气（**演示页 / 自检**用）。
   * 传 null 恢复跟随真实天气。刻意不做成 URL 参数或全局开关：
   * 主应用里不该存在任何"伪造天气"的入口。
   */
  setManual: (kind: string | null, intensity?: number) => void;
}

/** 演示页要用的：按天气类型直接造一个状态（不经过网络） */
export function manualState(kind: string, intensity = 0.6): WsWeatherState {
  const cloudByKind: Record<string, number> = {
    clear: 5,
    partly: 40,
    cloudy: 70,
    overcast: 95,
    rain: 95,
    thunder: 98,
    snow: 92,
    fog: 88,
    haze: 80,
  };
  return normalize({
    desc: kind,
    kind,
    cloudcover: cloudByKind[kind] ?? 60,
    intensity,
    is_rain: kind === "rain" || kind === "thunder",
    is_snow: kind === "snow",
    is_fog: kind === "fog" || kind === "haze",
  });
}

export function useWorldWeather(): UseWorldWeather {
  const fallback = degradedState("还没开始拉取天气");
  const state = ref<WsWeatherState>(fallback);
  const manual = ref<WsWeatherState | null>(null);

  let timer: number | null = null;
  let alive = true;

  function clearTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (timer !== null) window.clearTimeout(timer);
    const delay = state.value.degraded ? RETRY_MS : OK_MS;
    timer = window.setTimeout(() => {
      void refresh();
    }, delay);
  }

  async function refresh(): Promise<void> {
    if (!alive) return;
    if (manual.value) return; // 手动指定期间不打扰接口（演示页/自检）
    try {
      const got = usable(await worldMapApi.weather());
      if (!alive) return;
      state.value = "reason" in got ? degradedState(got.reason) : got;
    } catch (e) {
      if (!alive) return;
      // 失败**不是异常路径**：转成降级态，角标显示「天气不可用」。
      // 只在控制台留一条 debug（不 warn，免得每次重试都刷一行）。
      state.value = degradedState(String((e as Error)?.message || e));
      if (import.meta.env?.DEV) console.debug("[世界模拟] 天气拉取失败（角标显示不可用）：", e);
    } finally {
      if (alive) schedule();
    }
  }

  function onVisible() {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") void refresh();
  }

  onMounted(() => {
    alive = true;
    void refresh();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
  });

  onBeforeUnmount(() => {
    alive = false;
    clearTimer();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  });

  const current = computed(() => manual.value ?? state.value);

  return {
    state: current,
    line: computed(() => weatherLine(current.value)),
    degraded: computed(() => current.value.degraded),
    reason: computed(() => current.value.reason || current.value.error || ""),
    refresh,
    setManual: (kind: string | null, intensity = 0.6) => {
      manual.value = kind ? manualState(kind, intensity) : null;
      if (!kind) void refresh();
    },
  };
}
