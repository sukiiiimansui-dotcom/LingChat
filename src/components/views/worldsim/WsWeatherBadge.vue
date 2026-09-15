<!--
  「世界模拟」T4-2：天气角标 —— 当前天气的图标 + 描述 + 温度

  ── 拿不到天气时显示什么（T4-2 的硬要求：优雅降级）────────────────────────
    显示 `🌐 天气不可用`（`wsWeather.ts::degradedState` 给的），并且：
      · **不显示「晴」** —— 那是把"拿不到"伪装成数据，机主明确讨厌假数据；
      · **不留空白** —— 空白让人以为界面坏了；
      · **不弹错误** —— 拿不到天气不是用户的错，`title` 里写清原因即可（真机排障用），
        控制台只有一条 debug（见 `useWorldWeather`）。
    真源恢复后下一轮刷新自动回到正常态，角标不需要人来点。

  ── 位置 ──────────────────────────────────────────────────────────────────
    舞台右上角。刻意避开：左上角（T4-1 的时段角标）、右下角（既有的 `.ws-zoomctl`
    缩放/复位）、顶栏（那一排是主题/深色/重引导按钮，宽度不可控）。
-->
<template>
  <div class="ws-wxtag" :class="{ 'is-degraded': weather.degraded }" :title="title" data-ws-wxtag>
    <span class="ws-wxtag__ico" aria-hidden="true">{{ weather.icon }}</span>
    <span class="ws-wxtag__txt">{{ text }}</span>
    <span v-if="tempText" class="ws-wxtag__temp">{{ tempText }}</span>
  </div>
</template>

<script setup lang="ts">
  import { computed } from "vue";
  import type { WsWeatherState } from "./wsWeather";

  const props = defineProps<{
    /** 当前天气（`wsWeather.ts::normalize` / `degradedState` 的产出） */
    weather: WsWeatherState;
  }>();

  /** 主文本：降级时说「天气不可用」，正常时给描述（没有描述就用中文类型名） */
  const text = computed(() => {
    if (props.weather.degraded) return "天气不可用";
    const d = String(props.weather.desc || "").trim();
    return d || props.weather.kindLabel || "未知";
  });

  /** 温度单独一格：它是数字，与文字用不同的字重排在一起更好读 */
  const tempText = computed(() => {
    if (props.weather.degraded) return "";
    const t = props.weather.tempC;
    return typeof t === "number" && Number.isFinite(t) ? `${Math.round(t)}°C` : "";
  });

  /** hover 提示：正常时给城市（有的话），降级时把原因原样说出来 */
  const title = computed(() => {
    const w = props.weather;
    if (w.degraded) {
      return w.reason ? `天气不可用：${w.reason}` : "天气不可用";
    }
    const bits: string[] = [];
    if (w.city) bits.push(w.city);
    if (w.windKmph > 0) bits.push(`风 ${Math.round(w.windKmph)} km/h`);
    if (w.humidity != null) bits.push(`湿度 ${Math.round(w.humidity)}%`);
    bits.push(w.kindLabel);
    return bits.join(" · ");
  });
</script>

<!-- 样式在 `src/assets/styles/worldsim-weather.css`（与 T4-1 的 worldsim-tod.css 同一规矩：
     功能域各占一个文件，便于拆成独立的 PR；不往并行改动中的 worldsim.css 里塞）。 -->
