<!--
  WsPhoneTransit.vue —— 手机里的「公交 / 地铁 / 火车查询」（T5-4）

  ## 卡片四条对应
  1) **查询接 `transport_plan(prefer=bus|subway|transit)`** ✅
  2) **展示：线路、换乘点、耗时、票价、步行段** —— 全部来自 `route.steps`（逐段：mode/mode_name/
     icon/duration_min/distance_m/note/from/to），**不是自己拼的假数据**；
     另有 `transfer_text`（"直达"/"换乘 N 次"）、`cost_text`、`fare_note`、`reason`
  3) **依赖 T2-2（站点落在真实交通设施上）** —— 🔴 T2-2 **还在 todo**，所以现在的站点是
     `transport.rs` **几何估计的虚拟站点**（steps 的 `from`/`to` 就是那些估计点）。
     本组件**如实标注**这一点，不假装站点是真的。
  4) **空结果处理** —— 该方式没有方案时，**自动查一次打车做对比建议**（"不通公交 → 建议打车 ¥x / x 分"），
     绝不给一个空白面板。

  ## 复用
  「定位 + 目的地候选 + 面积质心」走 `usePhoneGeo`（T5-2/T5-3 已用，本组件是**第三个**使用者 ——
  上一轮抽它是为了不抄三遍）。
-->
<template>
  <div class="tr">
    <label class="tr__row">
      <span class="tr__k">去哪</span>
      <select v-model="destAd" class="tr__sel" :disabled="!geo.destList.value.length">
        <option value="">选择目的地…</option>
        <option v-for="d in geo.destList.value" :key="d.adcode" :value="d.adcode">{{ d.name }}</option>
      </select>
    </label>

    <!-- 方式切换：就是 prefer 参数，一一对应 -->
    <div class="tr__modes">
      <button
        v-for="m in PREFS"
        :key="m.key"
        class="tr__mode"
        :class="{ on: pref === m.key }"
        type="button"
        @click="pref = m.key"
      >
        {{ m.icon }} {{ m.name }}
      </button>
    </div>

    <button class="tr__go" type="button" :disabled="!destAd || busy" @click="query">
      {{ busy ? "查询中…" : "查线路" }}
    </button>

    <!-- 方案列表（options 可切换） -->
    <div v-if="opts.length > 1" class="tr__opts">
      <button
        v-for="(o, i) in opts"
        :key="i"
        class="tr__opt"
        :class="{ on: i === picked }"
        type="button"
        @click="picked = i"
      >
        <span>{{ o.icon }}</span>
        <span class="tr__onm">{{ o.mode_name }}</span>
        <span class="tr__ot">{{ o.duration_text }}</span>
        <span class="tr__od">{{ o.cost_text }}</span>
      </button>
    </div>

    <!-- 选中方案的详情 -->
    <template v-if="cur">
      <div class="tr__head">
        <span class="tr__big">{{ cur.icon }} {{ cur.mode_name }}</span>
        <span class="tr__price">{{ cur.cost_text }}</span>
        <span class="tr__meta">{{ cur.duration_text }} · {{ cur.distance_text }} · {{ cur.transfer_text }}</span>
        <span v-if="cur.wait_min" class="tr__meta">首段等待约 {{ Math.round(cur.wait_min) }} 分钟</span>
      </div>

      <!-- 逐段线路（线路 / 换乘点 / 步行段都在这） -->
      <!-- MG 切片 C：`:key="picked"` 是**故意的** ——
           换个方案时让这个列表整个重建，那条"线路生长"动画就会重放一次。
           不换 key 的话 Vue 会复用这些 li，动画只在第一次出现时跑，换方案就没反馈了。 -->
      <ol :key="picked" class="tr__steps">
        <li
          v-for="(s, i) in cur.steps || []"
          :key="i"
          :style="{ '--tr-i': String(Math.min(i, 8)) }"
        >
          <span class="tr__ico">{{ s.icon }}</span>
          <span class="tr__nm">{{ s.mode_name }}</span>
          <span class="tr__t">{{ fmtMin(s.duration_min) }}</span>
          <span class="tr__d">{{ fmtM(s.distance_m) }}</span>
          <span v-if="s.note" class="tr__note">{{ s.note }}</span>
          <span v-if="i < (cur.steps?.length || 0) - 1" class="tr__xfer">↓ 换乘</span>
        </li>
      </ol>

      <div v-if="cur.fare_note" class="tr__fare">票价说明：{{ cur.fare_note }}</div>
      <div class="tr__warn">
        ⚠️ 站点为几何估计的**虚拟站点**（T2-2 接入真实交通设施后才准）
      </div>
    </template>

    <!-- 空结果：给对比建议，绝不留白 -->
    <div v-if="fallback" class="tr__fallback">
      <b>这条线没有{{ prefName }}方案</b>
      <div v-if="fallback.ok">{{ fallback.icon }} 建议打车：{{ fallback.duration_text }} · {{ fallback.cost_text }}</div>
      <div v-else>步行距离也超出合理范围，建议换个目的地。</div>
    </div>

    <div v-if="err" class="tr__err">{{ err }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from "vue";
  import worldMapApi from "@/api/services/worldMap";
  import { usePhoneGeo } from "./usePhoneGeo";

  interface Step {
    icon?: string;
    mode_name?: string;
    duration_min?: number;
    distance_m?: number;
    note?: string;
  }
  interface Plan {
    mode?: string;
    icon?: string;
    mode_name?: string;
    duration_text?: string;
    distance_text?: string;
    cost_text?: string;
    cost?: number;
    wait_min?: number;
    transfer_text?: string;
    fare_note?: string;
    steps?: Step[];
  }

  const PREFS = [
    { key: "bus", icon: "🚌", name: "公交" },
    { key: "subway", icon: "🚇", name: "地铁" },
    { key: "transit", icon: "🚄", name: "火车" },
  ] as const;

  const geo = usePhoneGeo();
  const destAd = ref("");
  const pref = ref<string>("bus");
  const busy = ref(false);
  const err = ref("");
  const opts = ref<Plan[]>([]);
  const picked = ref(0);
  const fallback = ref<(Plan & { ok?: boolean }) | null>(null);

  const prefName = computed(() => PREFS.find((p) => p.key === pref.value)?.name || "公交");
  const cur = computed<Plan | null>(() => opts.value[picked.value] ?? null);
  const fmtMin = (m?: number) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}小时${Math.round(m % 60)}分` : `${Math.round(m)}分`);
  const fmtM = (m?: number) => (m == null ? "" : m >= 1000 ? `${(m / 1000).toFixed(1)}公里` : `${Math.round(m)}米`);

  async function query() {
    if (!geo.me.value || !destAd.value) return;
    busy.value = true;
    err.value = "";
    opts.value = [];
    fallback.value = null;
    try {
      const to = await geo.destLatLng(destAd.value);
      if (!to) throw new Error("拿不到目的地坐标");
      const res = (await worldMapApi.transportPlan(
        { lat: geo.me.value.lat, lng: geo.me.value.lng },
        to,
        pref.value
      )) as unknown as { ok?: boolean; error?: string; route?: Plan; options?: Plan[] };
      if (res?.ok === false) throw new Error(res.error || "查询失败");
      /* 🔴 踩过的坑（自测抓到的真 bug）：原来直接取 `res.options` —— 那是后端**自己排名**的前三个，
         与用户选的 `prefer` **无关**：点「公交」结果第一行是「🚄 火车/高铁」。
         尊重用户选择的那个方案在 `route` 里（`prefer` 只作用于它）。
         正确做法：**route 排第一**，后面接上"不同方式"的备选。 */
      const route = res?.route;
      const others = (res?.options || []).filter((o) => o.mode !== route?.mode);
      opts.value = route ? [route, ...others] : res?.options || [];
      picked.value = 0;
      /* 卡片第 4 条：**空结果不能给空白** —— 自动查一次打车做对比建议 */
      if (!opts.value.length) {
        const taxi = (await worldMapApi.transportPlan(
          { lat: geo.me.value.lat, lng: geo.me.value.lng },
          to,
          "taxi"
        )) as unknown as { ok?: boolean; route?: Plan };
        const r = taxi?.route;
        fallback.value = r
          ? { ...r, ok: true }
          : { ok: false };
      }
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  watch([destAd, pref], () => {
    opts.value = [];
    fallback.value = null;
    err.value = "";
  });
  void geo.load().then(() => {
    if (geo.err.value) err.value = geo.err.value;
  });
</script>

<style scoped>
  .tr { display: flex; flex-direction: column; gap: 8px; color: #fff; }
  .tr__row { display: flex; align-items: center; gap: 8px; }
  .tr__k { font-size: 12px; color: rgba(255,255,255,.55); flex: none; }
  .tr__sel {
    flex: 1; min-width: 0; height: 34px; border-radius: 10px; padding: 0 8px;
    background: rgba(255,255,255,.06); color: #fff; font-size: 12.5px;
    border: 1px solid rgba(255,255,255,.12);
  }
  .tr__modes { display: flex; gap: 6px; }
  .tr__mode {
    flex: 1; height: 32px; border-radius: 10px; cursor: pointer; font-size: 12px;
    background: rgba(255,255,255,.05); color: rgba(255,255,255,.7);
    border: 1px solid rgba(255,255,255,.1);
  }
  .tr__mode.on { background: rgba(53,211,154,.16); color: #35d39a; border-color: rgba(53,211,154,.5); }
  /* MG 切片 C：按下去缩一点（只动 transform，切方式时手指有回执） */
  .tr__mode { transition: transform .16s cubic-bezier(.2, 0, 0, 1); }
  .tr__mode:active { transform: scale(.96); }
  .tr__go {
    height: 40px; border: 0; border-radius: 12px; cursor: pointer;
    background: #35d39a; color: #06231a; font-size: 13px; font-weight: 700;
  }
  .tr__go:disabled { opacity: .45; cursor: not-allowed; }

  .tr__opts { display: flex; flex-direction: column; gap: 4px; }
  .tr__opt {
    display: grid; grid-template-columns: 16px 1fr auto auto; gap: 6px; align-items: center;
    padding: 6px 9px; border-radius: 10px; cursor: pointer; text-align: left; font-size: 12px;
    background: rgba(255,255,255,.04); color: #fff; border: 1px solid rgba(255,255,255,.1);
  }
  .tr__opt.on { border-color: rgba(53,211,154,.6); background: rgba(53,211,154,.12); }
  .tr__onm { color: rgba(255,255,255,.86); }
  .tr__ot { color: #35d39a; font-weight: 600; }
  .tr__od { color: rgba(255,255,255,.5); font-size: 11px; }

  .tr__head {
    display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; align-items: center;
    padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.1);
  }
  .tr__big { font-size: 13px; font-weight: 600; }
  .tr__price { color: #35d39a; font-weight: 700; font-size: 14px; }
  .tr__meta { grid-column: 1 / -1; font-size: 11.5px; color: rgba(255,255,255,.6); }

  .tr__steps { list-style: none; margin: 0; padding: 0; font-size: 11.5px; line-height: 1.5; }
  .tr__steps li {
    display: grid; grid-template-columns: 16px 1fr auto auto; gap: 5px; align-items: center;
    padding: 5px 0; border-bottom: 1px dashed rgba(255,255,255,.08);
  }
  .tr__ico { font-size: 13px; }
  .tr__nm { color: rgba(255,255,255,.88); }
  .tr__t { color: rgba(255,255,255,.7); }
  .tr__d { color: rgba(255,255,255,.45); min-width: 52px; text-align: right; }
  .tr__note { grid-column: 2 / -1; font-size: 10.5px; color: rgba(255,255,255,.42); }
  .tr__xfer { grid-column: 2 / -1; font-size: 10.5px; color: #35d39a; opacity: .85; }

  .tr__fare { font-size: 10.5px; color: rgba(255,255,255,.45); }
  .tr__warn { font-size: 10.5px; color: rgba(255,215,120,.75); line-height: 1.5; }
  .tr__fallback {
    padding: 9px 11px; border-radius: 12px; font-size: 12px; line-height: 1.7;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.85);
  }
  .tr__err { font-size: 11.5px; color: #ffb4b4; line-height: 1.5; }

  /* ── MG 切片 C：线路**生长**出来 ─────────────────────────────────────────
     逐段线路原来是一整块瞬间出现的。现在：
      ① 每一段晚 55ms 出现（错峰）—— 读起来像线路一站一站铺过去；
      ② 段与段之间那句「↓ 换乘」再晚 120ms，并且**从无到有地长**（scaleY 0 → 1）。
     只动 opacity/transform；一趟最多 9 段（第 10 段起不再延后），总时长始终 < 0.9s。 */
  .tr__steps li {
    animation: tr-step-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(var(--tr-i, 0) * 55ms);
  }
  @keyframes tr-step-in {
    from { opacity: 0; transform: translateX(-6px); }
    to { opacity: 1; transform: none; }
  }
  /* 换乘标记：等它上面那一段出来之后再"长"出来（transform-origin 在顶端，像从上一站接下去） */
  .tr__xfer {
    transform-origin: top center;
    animation: tr-xfer-grow 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(var(--tr-i, 0) * 55ms + 120ms);
  }
  @keyframes tr-xfer-grow {
    from { opacity: 0; transform: scaleY(0); }
    to { opacity: 0.85; transform: scaleY(1); }
  }
  /* 降级：低端机 / 系统关了动画 → 线路一次性出现（信息一点不少） */
  .ws-root.ws-perf-low .tr__steps li,
  .ws-root.ws-perf-low .tr__xfer,
  .ws-root.ws-perf-low .tr__mode { animation: none; transition: none; }
  @media (prefers-reduced-motion: reduce) {
    .tr__steps li,
    .tr__xfer { animation: none; }
    .tr__mode { transition: none; }
  }
</style>
