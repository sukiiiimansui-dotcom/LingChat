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

import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from "vue";
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

/**
 * 从接口返回里抠出「可用的天气」；拿不到就给出降级原因（人工可读，不编）。
 *
 * 🔴 返回值必须是**能区分成功/失败**的判别式。这里踩过一次：
 *    原来签名是 `WsWeatherState | { reason: string }`，调用方用 `"reason" in got` 判成功 ——
 *    而 `normalize()` 产出的状态**自己就带 `reason: ""` 字段**（见 `wsWeather.ts`），
 *    于是 `"reason" in got` **恒为真** → 每一次成功拿到的天气都被当成失败，
 *    被转成 `degradedState("")` → 角标永远「天气不可用」，连 title 里的原因都是空的。
 *    bug 被 wttr.in 的证书过期（2026-09-15 起，约两天）**掩盖**了：那期间"不可用"恰好是对的。
 *    证书恢复、后端能返回真数据后才在浏览器里量出来（页面确实收到 200 + 霾 23°C，
 *    角标仍是 `is-degraded`、title 只有「天气不可用」）。
 *    自检用例：`~/rikka/Dsh-SYuki/world_map/weather_selftest_t2.mjs`。
 */
function usable(raw: unknown): { state: WsWeatherState } | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "接口没有返回天气数据" };
  const o = raw as Record<string, unknown>;
  const err = o.error;
  if (err) return { reason: String(err) };
  const cur = (o.current || o.weather || o) as Record<string, unknown>;
  // 判据：至少有温度或描述之一，才算「拿到了天气」。两者都没有 = 空壳响应。
  const hasTemp = cur.temp_c != null || cur.tempC != null || cur.temp != null;
  const hasDesc = String(cur.desc ?? cur.weather_desc ?? cur.text ?? "").trim() !== "";
  if (!hasTemp && !hasDesc) return { reason: "接口返回里没有温度也没有天气描述" };
  return { state: normalize(raw) };
}

export interface UseWorldWeather {
  /** 当前天气（拿不到时是 `degraded = true` 的降级态，**不是**晴天） */
  state: Ref<WsWeatherState>;
  /** 角标一行字：`小雨 18°C` / `天气不可用` */
  line: ComputedRef<string>;
  /** 是否降级（没拿到真实天气） */
  degraded: ComputedRef<boolean>;
  /** 降级原因（角标 title 用） */
  reason: ComputedRef<string>;
  /** 拉一次（失败不抛，转成降级态） */
  refresh: () => Promise<void>;
}

/*
 * ⚠️ 这里**刻意没有**「手动指定天气」的入口（曾经有过 `manualState()` + `setManual()`，已删）。
 *
 * 删它的三个理由，缺一都不够：
 *   ① **没有调用方**：全仓 grep（含 `wsfx.html` 与仓库外的自检脚本）只有定义与内部互调，
 *      真实路径永远是 `worldMapApi.weather()`；
 *   ② **它判错过**：它是把 kind 塞回 `normalize({ desc, is_rain, is_fog … })` 让 `classify()`
 *      再判一次，而 `classify` 的优先级是**雨早于雷 / 雾早于霾** → 传 `thunder` 得到 `rain`、
 *      传 `haze` 得到 `fog`（演示页逐 kind 跑出来的事实）。要"手动切天气"就得像
 *      `wsfx.html` 里那样**直接覆盖 kind**，不能过 classify；
 *   ③ **它在要进 PR 的文件里**：为一个自用演示页留 API（且是死代码）不合适 ——
 *      上游的规矩是「一个 PR 一个功能域」，多余导出只会给 reviewer 添问题。
 * 演示页现在自己有一份（页内函数），不依赖这里。
 */

/**
 * @param opts.city 当前应查的城市（跟随定位）。
 *   🔴 为什么必须能传：后端在没有 city 时会**回落到"最近一次定位到的城市"**，
 *   而页面加载时天气请求**早于**定位完成 → 角标会先缓存成默认城市（北京）的天气，
 *   而且要等 30 分钟 TTL 才纠正。实测过：定位行写「当前：重庆市」、角标却是北京的「晴 29°C」。
 *   传了 city 之后，定位一出来（city 变化）就立刻重拉，角标与定位永远一致。
 */
export function useWorldWeather(opts: { city?: () => string } = {}): UseWorldWeather {
  const fallback = degradedState("还没开始拉取天气");
  const state = ref<WsWeatherState>(fallback);

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
    try {
      const got = usable(await worldMapApi.weather(opts.city?.() || undefined));
      if (!alive) return;
      // 用 `"state" in got` 判成功 —— **不能**用 `"reason" in got`（normalize 的产物也带 reason，见 usable 的注释）
      state.value = "state" in got ? got.state : degradedState(got.reason);
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

  /* 定位城市一变就重拉（否则要等 30 分钟 TTL 才纠正 → 角标显示别的城市的天气） */
  watch(
    () => opts.city?.() || "",
    (c, prev) => {
      if (c && c !== prev) void refresh();
    }
  );

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

  return {
    state,
    line: computed(() => weatherLine(state.value)),
    degraded: computed(() => state.value.degraded),
    reason: computed(() => state.value.reason || state.value.error || ""),
    refresh,
  };
}
