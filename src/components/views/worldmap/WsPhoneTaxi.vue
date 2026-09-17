<!--
  WsPhoneTaxi.vue —— 手机里的「打车」（T5-3）

  ## 卡片四条对应
  1) **叫车流程接 `transport_plan(prefer=taxi)`** → 车型 / 预估价 / 预计等待
  2) **地图联动** → 本组件在**手机自己的小地图**上画一辆车朝你驶来（车的位置由行程进度驱动）
  3) **行程状态机** → 接 `transport.rs` 的 `start_trip/tick_trip`（**真源码**，不是仿制）：
     真壳走 `world_map_trip_start`；浏览器走 8791 的 `/api/trip_start|tick`，
     而那两条路由**调的也是同一份 `transport::start_trip/tick_trip`**
  4) **行程小结** → 到达后给耗时/距离/费用

  ## 一个必须说清的差别
  真壳里**由 Rust 侧按真实时间推进**（`tick_to_now`）；浏览器里**由客户端推时钟**
  （`tripTick(dt)` 传"推进多少秒"），否则 163 分钟的行程要等两个多小时才看得到结果。
  差别只在**谁打拍子**，状态推进逻辑仍是 Rust 的那一份。
-->
<template>
  <div class="taxi">
    <!-- 小地图 + 车（卡片第 2 条） -->
    <div class="taxi__map">
      <img v-if="mapSrc" :src="mapSrc" alt="当前区域" />
      <div v-else class="taxi__mapload">{{ mapErr || "地图加载中…" }}</div>
      <!-- 车：沿"从目的地驶来"的方向移动，位置完全由 trip.progress 驱动 -->
      <div v-if="trip" class="taxi__car" :style="carStyle">{{ trip.icon || "🚕" }}</div>
      <div class="taxi__me">◆ {{ geo.me.value?.area || "定位中…" }}</div>
    </div>

    <!-- 叫车前 -->
    <template v-if="!trip">
      <label class="taxi__row">
        <span class="taxi__k">去哪</span>
        <select v-model="destAd" class="taxi__sel" :disabled="!geo.destList.value.length">
          <option value="">选择目的地…</option>
          <option v-for="d in geo.destList.value" :key="d.adcode" :value="d.adcode">{{ d.name }}</option>
        </select>
      </label>

      <!-- 报价：来自 transport_plan(prefer=taxi)，不是编的 -->
      <div v-if="quote" class="taxi__quote">
        <span class="taxi__big">{{ quote.icon }} {{ quote.mode_name }}</span>
        <span class="taxi__cost">{{ quote.cost_text || (quote.cost != null ? "¥" + quote.cost.toFixed(2) : "—") }}</span>
        <span class="taxi__sub">约 {{ quote.duration_text }} · {{ quote.distance_text }}</span>
        <span class="taxi__sub">预计等待 {{ Math.round(quote.wait_min ?? 0) }} 分钟</span>
      </div>

      <button class="taxi__go" type="button" :disabled="!destAd || busy" @click="call">
        {{ busy ? "呼叫中…" : quote ? "确认呼叫" : "看报价" }}
      </button>
      <div v-if="quote && !trip" class="taxi__hint">再点一次「确认呼叫」才会真的叫车</div>
    </template>

    <!-- 行程中 / 已到达 -->
    <template v-else>
      <div class="taxi__status">
        <span class="taxi__badge" :class="{ done: trip.finished }">{{ statusText }}</span>
        <span class="taxi__pct">{{ Math.round((trip.progress ?? 0) * 100) }}%</span>
      </div>
      <div class="taxi__bar"><i :style="{ width: Math.round((trip.progress ?? 0) * 100) + '%' }" /></div>
      <div class="taxi__lines">
        <div>剩余 {{ fmtMin(trip.remaining_min) }} · {{ fmtM(trip.remaining_m) }}</div>
        <div class="taxi__dim">已走 {{ fmtMin(trip.elapsed_min) }} / 全程 {{ fmtMin(trip.total_duration_min) }}</div>
      </div>

      <!-- 行程小结（卡片第 4 条） -->
      <div v-if="trip.finished" class="taxi__sum">
        <b>已到达</b>
        <div>耗时 {{ fmtMin(trip.total_duration_min) }} · 距离 {{ fmtM(trip.distance_m) }}</div>
        <div>费用 <span class="taxi__cost">{{ trip.cost_text || (trip.cost != null ? "¥" + trip.cost.toFixed(2) : "—") }}</span></div>
        <button class="taxi__go" type="button" @click="reset">知道了</button>
      </div>
      <button v-else class="taxi__cancel" type="button" @click="cancel">取消行程</button>
    </template>

    <div v-if="err" class="taxi__err">{{ err }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onBeforeUnmount, ref, watch } from "vue";
  import worldMapApi, { mapSvgUrl, tripCancel, tripStart, tripTick, type WsTrip } from "@/api/services/worldMap";
  import { usePhoneGeo } from "./usePhoneGeo";

  const geo = usePhoneGeo();
  const destAd = ref("");
  const busy = ref(false);
  const err = ref("");
  const mapSrc = ref("");
  const mapErr = ref("");
  /** 出租车报价（来自 transport_plan(prefer=taxi) 的 route 字段） */
  interface Quote {
    mode_name?: string;
    icon?: string;
    cost?: number;
    cost_text?: string;
    duration_text?: string;
    distance_text?: string;
    wait_min?: number;
  }
  const quote = ref<Quote | null>(null);
  const trip = ref<WsTrip | null>(null);
  let timer: number | null = null;

  const statusText = computed(() => {
    const t = trip.value;
    if (!t) return "";
    if (t.finished) return "已到达";
    return t.status === "waiting" ? "司机接单中 / 候车" : "行程中";
  });
  const fmtMin = (m?: number) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}小时${Math.round(m % 60)}分` : `${Math.round(m)}分`);
  const fmtM = (m?: number) => (m == null ? "—" : m >= 1000 ? `${(m / 1000).toFixed(1)}公里` : `${Math.round(m)}米`);
  /** 车的位置：progress 0 → 屏幕右侧（驶来），1 → 你自己那儿 */
  const carStyle = computed(() => {
    const p = Math.min(1, Math.max(0, trip.value?.progress ?? 0));
    return { left: `${88 - p * 62}%`, top: `${34 + p * 26}%` };
  });

  async function init() {
    await geo.load();
    err.value = geo.err.value;
    const leaf = geo.me.value?.leafAd;
    if (leaf) {
      try {
        mapSrc.value = await mapSvgUrl(leaf, "gaode", 264, 150);
      } catch (e) {
        mapErr.value = `地图取不到（${e instanceof Error ? e.message : e}）`;
      }
    }
  }

  /** 第一步：看报价（不叫车） */
  async function call() {
    if (!geo.me.value || !destAd.value) return;
    busy.value = true;
    err.value = "";
    try {
      const to = await geo.destLatLng(destAd.value);
      if (!to) throw new Error("拿不到目的地坐标");
      if (!quote.value) {
        const res = (await worldMapApi.transportPlan(
          { lat: geo.me.value.lat, lng: geo.me.value.lng },
          to,
          "taxi"
        )) as unknown as { ok?: boolean; error?: string; route?: Quote };
        if (res?.ok === false) throw new Error(res.error || "算路失败");
        quote.value = res?.route ?? null;
        if (!quote.value) throw new Error("没有可用的出租车方案");
        return; // 这一步只看报价
      }
      // 第二步：真的叫车
      const t = await tripStart({
        from: { lat: geo.me.value.lat, lng: geo.me.value.lng },
        to,
        prefer: "taxi",
        label: `去${geo.destList.value.find((d) => d.adcode === destAd.value)?.name || "目的地"}`,
        scale: 1,
      });
      trip.value = t;
      startTicking();
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  /** 推时钟：每 400ms 推 120 秒 → 163 分钟的行程约 33 秒走完（真壳不用这个） */
  function startTicking() {
    stopTicking();
    timer = window.setInterval(() => {
      void tripTick(120)
        .then((t) => {
          trip.value = t;
          if (t.finished) stopTicking();
        })
        .catch((e) => {
          err.value = e instanceof Error ? e.message : String(e);
          stopTicking();
        });
    }, 400);
  }
  function stopTicking() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  async function cancel() {
    stopTicking();
    try {
      await tripCancel("用户取消");
    } catch {
      /* 取消失败也要让界面能退出来，别卡在行程里 */
    }
    trip.value = null;
    quote.value = null;
  }
  function reset() {
    trip.value = null;
    quote.value = null;
    destAd.value = "";
  }

  watch(destAd, () => {
    quote.value = null;
    err.value = "";
  });
  onBeforeUnmount(stopTicking);
  void init();
</script>

<style scoped>
  .taxi { display: flex; flex-direction: column; gap: 8px; color: #fff; }
  .taxi__map { position: relative; border-radius: 12px; overflow: hidden; background: #0e1621; min-height: 96px; }
  .taxi__map img { display: block; width: 100%; height: auto; }
  .taxi__mapload { display: grid; place-items: center; height: 96px; font-size: 11.5px; color: rgba(255,255,255,.45); }
  .taxi__car {
    position: absolute; font-size: 18px; transform: translate(-50%, -50%);
    transition: left .4s linear, top .4s linear; /* 只动 left/top 的百分比，行程推进本来就是离散的 */
    filter: drop-shadow(0 2px 6px rgba(0,0,0,.6));
  }
  .taxi__me {
    position: absolute; left: 6px; bottom: 6px; padding: 3px 8px; border-radius: 9px;
    background: rgba(10,15,21,.78); font-size: 11px; color: rgba(255,255,255,.88);
    max-width: calc(100% - 12px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .taxi__me::first-letter { color: #35d39a; }

  .taxi__row { display: flex; align-items: center; gap: 8px; }
  .taxi__k { font-size: 12px; color: rgba(255,255,255,.55); flex: none; }
  .taxi__sel {
    flex: 1; min-width: 0; height: 34px; border-radius: 10px; padding: 0 8px;
    background: rgba(255,255,255,.06); color: #fff; font-size: 12.5px;
    border: 1px solid rgba(255,255,255,.12);
  }
  .taxi__quote {
    display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; align-items: center;
    padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.1);
  }
  .taxi__big { font-size: 13px; font-weight: 600; }
  .taxi__cost { color: #35d39a; font-weight: 700; font-size: 14px; }
  .taxi__sub { grid-column: 1 / -1; font-size: 11.5px; color: rgba(255,255,255,.6); }

  .taxi__go {
    height: 40px; border: 0; border-radius: 12px; cursor: pointer;
    background: #35d39a; color: #06231a; font-size: 13px; font-weight: 700;
  }
  .taxi__go:disabled { opacity: .45; cursor: not-allowed; }
  .taxi__hint { font-size: 11px; color: rgba(255,255,255,.45); text-align: center; }
  .taxi__cancel {
    height: 34px; border: 1px solid rgba(255,255,255,.16); border-radius: 11px;
    background: transparent; color: rgba(255,255,255,.7); font-size: 12px; cursor: pointer;
  }

  .taxi__status { display: flex; align-items: center; justify-content: space-between; }
  .taxi__badge { font-size: 12px; padding: 3px 9px; border-radius: 9px; background: rgba(53,211,154,.16); color: #35d39a; }
  .taxi__badge.done { background: rgba(255,255,255,.12); color: #fff; }
  .taxi__pct { font-size: 12px; color: rgba(255,255,255,.65); }
  .taxi__bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.1); overflow: hidden; }
  .taxi__bar i { display: block; height: 100%; background: #35d39a; transition: width .4s linear; }
  .taxi__lines { font-size: 11.5px; line-height: 1.7; color: rgba(255,255,255,.8); }
  .taxi__dim { color: rgba(255,255,255,.45); }

  .taxi__sum {
    display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; border-radius: 12px;
    background: rgba(53,211,154,.1); border: 1px solid rgba(53,211,154,.3); font-size: 12px; line-height: 1.7;
  }
  .taxi__err { font-size: 11.5px; color: #ffb4b4; line-height: 1.5; }
</style>
