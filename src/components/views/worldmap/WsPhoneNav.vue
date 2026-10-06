<!--
  WsPhoneNav.vue —— 手机里的「地图 / 导航」（T5-2）

  ## 卡片要求（逐条对应）
  1) **手机里的地图视图**：复用 `mapSvgUrl()` 通路（T6-5 的双通路），但**按小屏取图**
     —— 传 264×150 而不是 1000×760。卡片特意点了这一条：小窗里塞大图，字号会被缩没。
  2) **导航**：调 `worldMapApi.transportPlan()`（真壳走 `world_map_transport_plan`，浏览器走
     `/api/transport_plan`）拿方案 → 画/列路线 + 分步提示。
  3) **当前位置**：`worldMapApi.location()`（依赖 T0-1 的命令；浏览器走 HTTP 兜底）。
  4) **小屏可用性**：面板固定 ~264px 宽，地图按可用宽取图。

  ## 目的地从哪来（2026-10-06 S9b5-B 复核过）
  「去哪」的下拉框 = **当前所在市的同级区县**，来自 `usePhoneGeo` 的 `destList`
  （`location()` → `path` → 逐级往上找 `geoChildren()`）。它**不是**角落世界地图那条链：
  角落地图吃的是 `/api/bigmap` + `useWorldMapLayer.ts` 那份模块级单例状态（连同
  `WorldMapLayer.vue` / `WorldMap.vue` 一起退役了），本组件吃的是定位 + 区划列表 + 路径规划，
  所以「角落世界地图退役」**没有**带走这个列表（判据与取舍写在本组件的提交信息里）。

  🔴 原来这里自己抄了一份「质心 / 地名美化 / 逐级找候选」的实现，与 `usePhoneGeo.ts` 分叉；
  本次收口到 `usePhoneGeo`（单一真源），顺带把「真壳里命令还没注册」那句**已经不成立**的
  提示去掉 —— `world_map_geo_json` / `world_map_geo_children` 已经在 `lib.rs` 注册。
-->
<template>
  <div class="nav">
    <!-- 地图：小尺寸取图（卡片第 1、4 条） -->
    <div class="nav__map">
      <img v-if="mapSrc" :src="mapSrc" alt="当前区域地图" />
      <div v-else class="nav__mapload">{{ mapErr || "地图加载中…" }}</div>
      <div class="nav__where">
        <span class="nav__pin">◆</span>{{ geo.me.value?.area || "定位中…" }}
      </div>
    </div>

    <!-- 目的地：从"当前市的同级区县"里选（没有地理编码接口，这是最接近真实的可用路径） -->
    <label class="nav__row">
      <span class="nav__k">去哪</span>
      <select v-model="destAd" class="nav__sel" :disabled="!geo.destList.value.length">
        <option value="">选择目的地…</option>
        <option v-for="d in geo.destList.value" :key="d.adcode" :value="d.adcode">{{ d.name }}</option>
      </select>
    </label>

    <button class="nav__go" type="button" :disabled="!destAd || busy" @click="plan">
      {{ busy ? "规划中…" : "查路线" }}
    </button>

    <div v-if="err" class="nav__err">{{ err }}</div>

    <!-- 方案列表 -->
    <div v-if="opts.length" class="nav__opts">
      <button
        v-for="(o, i) in opts"
        :key="i"
        class="nav__opt"
        :class="{ on: i === picked }"
        type="button"
        @click="picked = i"
      >
        <span class="nav__ico">{{ o.icon }}</span>
        <span class="nav__nm">{{ o.mode_name }}</span>
        <span class="nav__t">{{ o.duration_text }}</span>
        <span class="nav__d">{{ o.distance_text }}</span>
      </button>
    </div>

    <!-- 分步提示（卡片第 2 条的"分步"） -->
    <ol v-if="steps.length" class="nav__steps">
      <li v-for="(s, i) in steps" :key="i">{{ s }}</li>
    </ol>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from "vue";
  import worldMapApi, { mapSvgUrl } from "@/api/services/worldMap";
  import { usePhoneGeo } from "./usePhoneGeo";

  /* 定位 / 目的地候选 / 面积质心 / 地名美化 —— 全部走共用 hook（单一真源，别在这儿再抄一份） */
  const geo = usePhoneGeo();

  const destAd = ref("");
  const mapSrc = ref("");
  const mapErr = ref("");
  const busy = ref(false);
  const err = ref("");
  const opts = ref<any[]>([]);
  const picked = ref(0);

  async function init() {
    await geo.load();
    /* 「为什么没有目的地列表」由 hook 给出人话（它知道试过哪一级、错在哪），这里只负责显示 */
    if (geo.err.value) err.value = geo.err.value;
    const leaf = geo.me.value?.leafAd;
    if (!leaf) return;
    // 地图：**按小屏取图**（264 宽），不是塞 1000px 的大图
    try {
      mapSrc.value = await mapSvgUrl(leaf, "gaode", 264, 150);
    } catch (e) {
      mapErr.value = `地图取不到（${e instanceof Error ? e.message : e}）`;
    }
  }

  async function plan() {
    if (!geo.me.value || !destAd.value) return;
    busy.value = true;
    err.value = "";
    opts.value = [];
    try {
      const to = await geo.destLatLng(destAd.value);
      if (!to) throw new Error("拿不到目的地坐标");
      const res: any = await worldMapApi.transportPlan(
        { lat: geo.me.value.lat, lng: geo.me.value.lng },
        to
      );
      if (res?.ok === false) throw new Error(res.error || "规划失败");
      opts.value = res?.options?.length ? res.options : res?.route ? [res.route] : [];
      picked.value = 0;
      if (!opts.value.length) err.value = "没有可用的出行方案";
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  /** 分步提示：由选中方案的实际字段拼出来（不编造换乘细节） */
  const steps = computed(() => {
    const o = opts.value[picked.value];
    if (!o) return [] as string[];
    const out = [`从当前位置出发（${geo.me.value?.area || "已定位"}）`];
    out.push(`乘 ${o.icon} ${o.mode_name}，约 ${o.distance_text}`);
    if (Number.isFinite(o.ride_min)) out.push(`其中乘坐约 ${Math.round(o.ride_min)} 分钟`);
    if (Number.isFinite(o.wait_min) && o.wait_min > 0) out.push(`预计等待约 ${Math.round(o.wait_min)} 分钟`);
    out.push(`全程约 ${o.duration_text}，到达目的地`);
    return out;
  });

  watch(destAd, () => { opts.value = []; err.value = ""; });
  init();
</script>

<style scoped>
  /* 小屏：面板 ~264px 宽（卡片第 4 条），所以这里一切尺寸都按"手机里的小窗"来 */
  .nav { display: flex; flex-direction: column; gap: 8px; color: #fff; }
  .nav__map {
    position: relative; border-radius: 12px; overflow: hidden;
    background: #0e1621; min-height: 96px;
  }
  .nav__map img { display: block; width: 100%; height: auto; }
  .nav__mapload {
    display: grid; place-items: center; height: 96px;
    font-size: 11.5px; color: rgba(255, 255, 255, 0.45);
  }
  .nav__where {
    position: absolute; left: 6px; bottom: 6px; max-width: calc(100% - 12px);
    padding: 3px 8px; border-radius: 9px; font-size: 11px;
    background: rgba(10, 15, 21, 0.78); color: rgba(255, 255, 255, 0.88);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .nav__pin { color: #35d39a; margin-right: 4px; }

  .nav__row { display: flex; align-items: center; gap: 8px; }
  .nav__k { font-size: 12px; color: rgba(255, 255, 255, 0.55); flex: none; }
  .nav__sel {
    flex: 1; min-width: 0; height: 34px; border-radius: 10px; padding: 0 8px;
    background: rgba(255, 255, 255, 0.06); color: #fff; font-size: 12.5px;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .nav__go {
    height: 40px; border: 0; border-radius: 12px; cursor: pointer;
    background: #35d39a; color: #06231a; font-size: 13px; font-weight: 700;
  }
  .nav__go:disabled { opacity: 0.45; cursor: not-allowed; }

  .nav__err { font-size: 11.5px; color: #ffb4b4; line-height: 1.5; }

  .nav__opts { display: flex; flex-direction: column; gap: 5px; }
  .nav__opt {
    display: grid; grid-template-columns: 18px 1fr auto auto; align-items: center; gap: 6px;
    padding: 7px 9px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px;
    background: rgba(255, 255, 255, 0.04); color: #fff; cursor: pointer; text-align: left;
    font-size: 12px;
  }
  .nav__opt.on { border-color: rgba(53, 211, 154, 0.6); background: rgba(53, 211, 154, 0.14); }
  .nav__nm { color: rgba(255, 255, 255, 0.86); }
  .nav__t { color: #35d39a; font-weight: 600; }
  .nav__d { color: rgba(255, 255, 255, 0.45); font-size: 11px; }

  .nav__steps {
    margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.75;
    color: rgba(255, 255, 255, 0.72); max-height: 108px; overflow-y: auto;
  }
</style>
