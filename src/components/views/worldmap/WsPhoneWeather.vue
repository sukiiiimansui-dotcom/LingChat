<!--
  WsPhoneWeather.vue —— 手机里的「天气」（T5-7）

  ## 卡片要求 → 本组件的做法
  1) **接 world_map_weather（真壳）/ `/api/weather`（浏览器预览）** —— 走 `worldMapApi.weather(city)`
     这条**双通路**，与地图角标（T4-2）**读的是同一个接口**，不是另找一份数据。
  2) **展示**：当前温度 / 体感 / 湿度 / 风 / 能见度 + 中文描述（中文映射在 Rust 侧，前端只显示）。
  3) **与地图联动**：不做"再写一遍天气"——本组件把 payload 交给 `wsWeather.ts::normalize()`
     + `weatherLine()`，**与地图角标同一份纯函数**，所以两边不可能显示成不同的天气
     （这正是 T4-2 里"角标写小雨、地图飘雪"那类 bug 的根治法）。
     另有「在地图上看 ▸」按钮跳真路由 `/worldsim`。
  4) **城市**：默认跟随定位（T0-1 / `usePhoneGeo`）；用户也可以手动指定城市
     （输入框 + 3 个常用城市），选择记进 localStorage（`ws.phone.weather.city`），
     「跟随定位」一键清除。手动指定时才把 city 传给后端，跟随定位时传空 → 后端按定位城市给。

  ## 拿不到就如实说
  `error` 字段 / 请求异常 → 顶部红条写**具体原因**（不写"未知错误"），并给「重试」按钮；
  数值缺失时那一格显示「—」，**不填 0**（0°C 和"没数据"是两件事）。
-->
<template>
  <div class="wx">
    <!-- 城市行：跟随定位 / 手动指定 -->
    <div class="wx__city">
      <span class="wx__citynm">{{ cityLabel }}</span>
      <span v-if="!manualCity" class="wx__badge">跟随定位</span>
      <span v-else class="wx__badge is-manual">手动指定</span>
      <button class="wx__mini" type="button" @click="reload">刷新</button>
    </div>
    <div class="wx__picker">
      <input
        v-model="draft"
        class="wx__input"
        type="text"
        placeholder="城市名（如 重庆 / Chongqing）"
        @keyup.enter="applyCity"
      />
      <button class="wx__mini" type="button" @click="applyCity">用这个</button>
      <button v-if="manualCity" class="wx__mini" type="button" @click="followLoc">跟随定位</button>
    </div>
    <div class="wx__quick">
      <button v-for="c in QUICK" :key="c" class="wx__chip" type="button" @click="pickCity(c)">
        {{ c }}
      </button>
    </div>

    <!-- 拿不到：原因 + 重试（不写"未知错误"） -->
    <div v-if="err" class="wx__err">
      <div class="wx__errh">天气拿不到</div>
      <div class="wx__errm">{{ err }}</div>
      <button class="wx__retry" type="button" @click="reload">重试</button>
    </div>

    <!-- 拿到了：主卡（同一个 normalize()，与地图角标同源） -->
    <div v-else-if="state" class="wx__card" :class="{ 'is-degraded': state.degraded }">
      <div class="wx__big">
        <span class="wx__ico">{{ state.icon }}</span>
        <span class="wx__temp">{{ tempText }}</span>
      </div>
      <div class="wx__desc">{{ state.degraded ? "天气不可用" : state.desc || state.kindLabel }}</div>
      <div class="wx__grid">
        <div
          v-for="(g, i) in grid"
          :key="g.k"
          class="wx__cell"
          :style="{ '--wx-i': String(Math.min(i, 7)) }"
        >
          <div class="wx__k">{{ g.k }}</div>
          <div class="wx__v">{{ g.v }}</div>
        </div>
      </div>
      <div class="wx__src">
        数据源：{{ state.degraded ? "（无）" : "world_map_weather / /api/weather" }}
        <span v-if="state.city"> · {{ state.city }}</span>
      </div>
    </div>
    <div v-else class="wx__loading">读取中…</div>

    <!-- 地图联动（第 3 条）：说明同源 + 真跳转 -->
    <div class="wx__link">
      <div class="wx__linkh">地图上的天气</div>
      <div class="wx__linkm">
        地图角标用的是同一份 payload + 同一个 <code>normalize()</code>，
        所以这里显示什么，地图上就是什么{{ state && !state.degraded ? `（当前：${weatherLine(state)}）` : "" }}。
      </div>
      <button class="wx__go" type="button" @click="goMap">在地图上看 ▸</button>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref } from "vue";
  import { useRouter } from "vue-router";
  import worldMapApi from "@/api/services/worldMap";
  import { normalize, weatherLine, type WsWeatherState } from "@/components/views/worldsim/wsWeather";
  import { useWsCountUp } from "@/composables/useWsCountUp";
  import { usePhoneGeo } from "./usePhoneGeo";

  /** 常用城市（点一下就切；后端用 wttr.in，中文名可用） */
  const QUICK = ["重庆", "北京", "上海", "广州"];
  const KEY = "ws.phone.weather.city";

  const router = useRouter();
  const geo = usePhoneGeo();

  const manualCity = ref(readCity());
  const draft = ref(manualCity.value);
  const err = ref("");
  const state = ref<WsWeatherState | null>(null);

  function readCity(): string {
    try {
      return localStorage.getItem(KEY) || "";
    } catch {
      return "";
    }
  }
  function saveCity(c: string) {
    manualCity.value = c;
    try {
      if (c) localStorage.setItem(KEY, c);
      else localStorage.removeItem(KEY);
    } catch {
      /* 隐私模式写不进去不影响本次会话 */
    }
  }
  /** 跟随定位时用的城市名：取定位 `area` 的最后一段（`中国·重庆市·500100` → `重庆市`）
   *  ⚠️ 只用于**显示**；请求时仍然传空 city，由后端按坐标/默认来给，避免两处各判一次城市。 */
  const locCity = computed(() => {
    const a = String(geo.me.value?.area || "");
    const parts = a.split(/[·・>]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  });
  const cityLabel = computed(() => manualCity.value || locCity.value || "定位中…");

  const tempText = computed(() => {
    const t = tempShown.value;
    return typeof t === "number" && Number.isFinite(t) ? `${Math.round(t)}°C` : "—";
  });
  /**
   * MG 切片 C（2026-09-19）：温度**滚**上去，不要"啪"地跳。
   * 数据是异步来的 —— 从"—"直接跳到 `23°C`，用户根本注意不到它变了；
   * 从 0 滚到 23 就一眼看得出"天气拿到了"。
   * 系统关了动画 / 低端机档位会自动变成直接落定（判断在 `useWsCountUp` 里）。
   */
  const tempC = computed(() => {
    const t = state.value?.tempC;
    return typeof t === "number" && Number.isFinite(t) ? Math.round(t) : null;
  });
  const tempShown = useWsCountUp(tempC);
  /** 数值一律"没有就给 —"，**不拿 0 冒充**（0°C / 0% 与"没数据"是两件事） */
  const nz = (v: unknown, unit = "") =>
    typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}${unit}` : "—";
  const grid = computed(() => {
    const s = state.value;
    if (!s || s.degraded) return [] as Array<{ k: string; v: string }>;
    return [
      { k: "体感", v: nz(s.feelsLikeC, "°C") },
      { k: "湿度", v: nz(s.humidity, "%") },
      { k: "风", v: nz(s.windKmph, " km/h") },
      { k: "能见度", v: nz(s.visibilityKm, " km") },
      { k: "云量", v: nz(s.cloudcover, "%") },
      { k: "降水", v: nz(s.precipMm, " mm") },
    ];
  });

  /** 拉一次天气。city 为空 = 跟随定位（后端决定）。 */
  async function load(): Promise<void> {
    err.value = "";
    try {
      const raw = (await worldMapApi.weather(manualCity.value || undefined)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") throw new Error("接口没有返回数据");
      const e = raw.error;
      if (e) {
        err.value = String(e);
        state.value = null;
        return;
      }
      if (!raw.temp_c && !raw.desc) {
        err.value = "接口返回里没有温度也没有描述";
        state.value = null;
        return;
      }
      state.value = normalize(raw);
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
      state.value = null;
    }
  }

  function reload() {
    void load();
  }
  function applyCity() {
    saveCity(draft.value.trim());
    void load();
  }
  function pickCity(c: string) {
    draft.value = c;
    saveCity(c);
    void load();
  }
  function followLoc() {
    draft.value = "";
    saveCity("");
    void load();
  }
  function goMap() {
    void router.push("/worldsim");
  }

  void (async () => {
    // 先定位（只为显示城市名 + 给"跟随定位"一个可读的值），再拉天气；定位失败也照样拉天气。
    await geo.load();
    await load();
  })();
</script>

<style scoped>
  .wx { display: flex; flex-direction: column; gap: 8px; color: #fff; font-size: 12px; }
  .wx__city { display: flex; align-items: center; gap: 6px; }
  .wx__citynm { font-size: 14px; font-weight: 600; }
  .wx__badge { padding: 1px 6px; border-radius: 8px; background: rgba(255, 255, 255, 0.16); font-size: 10px; opacity: 0.85; }
  .wx__badge.is-manual { background: rgba(255, 214, 102, 0.22); }
  .wx__mini {
    margin-left: auto; padding: 2px 8px; border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 8px; background: transparent; color: #fff; font-size: 11px; cursor: pointer;
  }
  .wx__picker { display: flex; gap: 6px; }
  .wx__input {
    flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 8px; background: rgba(0, 0, 0, 0.25); color: #fff; font-size: 12px;
  }
  .wx__picker .wx__mini { margin-left: 0; }
  .wx__quick { display: flex; flex-wrap: wrap; gap: 6px; }
  .wx__chip {
    padding: 2px 8px; border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 999px;
    background: rgba(255, 255, 255, 0.08); color: #fff; font-size: 11px; cursor: pointer;
  }
  .wx__err { padding: 8px; border-radius: 10px; background: rgba(255, 99, 99, 0.18); }
  .wx__errh { font-weight: 600; margin-bottom: 2px; }
  .wx__errm { opacity: 0.9; word-break: break-all; }
  .wx__retry {
    margin-top: 6px; padding: 3px 10px; border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 8px; background: transparent; color: #fff; cursor: pointer;
  }
  .wx__card {
    display: flex; flex-direction: column; gap: 4px; padding: 10px;
    border-radius: 12px; background: rgba(255, 255, 255, 0.1);
  }
  .wx__card.is-degraded { background: rgba(255, 255, 255, 0.06); }
  .wx__big { display: flex; align-items: center; gap: 8px; }
  .wx__ico { font-size: 26px; line-height: 1; }
  /* tabular-nums：温度在滚动（MG 切片 C），等宽数字才不会把后面的 °C 挤来挤去 */
  .wx__temp { font-size: 30px; font-weight: 700; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
  .wx__desc { font-size: 14px; font-weight: 600; }
  .wx__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; }
  .wx__cell { padding: 4px; border-radius: 8px; background: rgba(0, 0, 0, 0.18); }
  .wx__k { font-size: 10px; opacity: 0.7; }
  .wx__v { font-size: 13px; font-weight: 600; }
  .wx__src { font-size: 10px; opacity: 0.6; margin-top: 2px; }
  .wx__loading { opacity: 0.7; }
  .wx__link { padding: 8px; border-radius: 10px; background: rgba(140, 200, 255, 0.12); }
  .wx__linkh { font-weight: 600; margin-bottom: 2px; }
  .wx__linkm { opacity: 0.85; line-height: 1.5; }
  .wx__go {
    margin-top: 6px; padding: 3px 10px; border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 8px; background: transparent; color: #fff; cursor: pointer;
  }

  /* ── MG 切片 C：六格数据**依次**浮现（错峰 45ms）──────────────────────────
     为什么错峰而不是整块一起淡入：这六格是"数据到了"的证明，
     一格接一格地出现，读起来像仪表在逐项点亮；一起出现就只是一次刷新。
     45ms 的间隔来自 MD3 的 stagger（相关元素 20~40ms），这里略宽一点更从容。
     上限卡在 7（第 8 格起不再延后）—— 不然列表一长，最后一格要等半秒。 */
  .wx__cell {
    animation: wx-cell-in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(var(--wx-i, 0) * 45ms);
  }
  @keyframes wx-cell-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  /* 降级：低端机 → 不做错峰（六格一次性出现，一点信息不丢）；
     系统关了动画 → 同样直接出现。两条都只动 opacity/transform，关掉不影响可读性。 */
  .ws-root.ws-perf-low .wx__cell { animation: none; }
  @media (prefers-reduced-motion: reduce) {
    .wx__cell { animation: none; }
  }
</style>
