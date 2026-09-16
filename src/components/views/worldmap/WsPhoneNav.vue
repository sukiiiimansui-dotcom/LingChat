<!--
  WsPhoneNav.vue —— 手机里的「地图 / 导航」（T5-2）

  ## 卡片要求（逐条对应）
  1) **手机里的地图视图**：复用 `mapSvgUrl()` 通路（T6-5 的双通路），但**按小屏取图**
     —— 传 264×150 而不是 1000×760。卡片特意点了这一条：小窗里塞大图，字号会被缩没。
  2) **导航**：调 `worldMapApi.transportPlan()`（真壳走 `world_map_transport_plan`，浏览器走
     `/api/transport_plan`）拿方案 → 画/列路线 + 分步提示。
  3) **当前位置**：`worldMapApi.location()`（依赖 T0-1 的命令；浏览器走 HTTP 兜底）。
  4) **小屏可用性**：面板固定 ~264px 宽，地图按可用宽取图。

  ## 一个实现上的取舍（值得写下来）
  后端**没有"区县中心坐标"接口**（实测：`/api/blocks?ad=` 返回 `{ok:false}`，
  `/api/location?ad=` 会忽略 ad 直接返回本机定位）。而 `transport_plan` 要的是 **lat/lng**。
  所以目的地的坐标由**该区县 GeoJSON 的面积质心**算出来（`/api/geo_json?ad=`）。
  与 `wsgame.html` 里修标注锚点用的是同一套数学 —— 那里踩过"顶点平均会被密集处拽跑"的坑，
  这里直接用面积质心，不再重复那个错误。
-->
<template>
  <div class="nav">
    <!-- 地图：小尺寸取图（卡片第 1、4 条） -->
    <div class="nav__map">
      <img v-if="mapSrc" :src="mapSrc" alt="当前区域地图" />
      <div v-else class="nav__mapload">{{ mapErr || "地图加载中…" }}</div>
      <div class="nav__where">
        <span class="nav__pin">◆</span>{{ me?.area || "定位中…" }}
      </div>
    </div>

    <!-- 目的地：从"当前市的同级区县"里选（没有地理编码接口，这是最接近真实的可用路径） -->
    <label class="nav__row">
      <span class="nav__k">去哪</span>
      <select v-model="destAd" class="nav__sel" :disabled="!destList.length">
        <option value="">选择目的地…</option>
        <option v-for="d in destList" :key="d.adcode" :value="d.adcode">{{ d.name }}</option>
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

  const me = ref<{ lat: number; lng: number; area?: string; leafAd?: string; parentAd?: string } | null>(null);
  const destList = ref<Array<{ name: string; adcode: string }>>([]);
  const destAd = ref("");
  const mapSrc = ref("");
  const mapErr = ref("");
  const busy = ref(false);
  const err = ref("");
  const opts = ref<any[]>([]);
  const picked = ref(0);

  /* 面积质心（与 wsgame 的标注锚点同一套）：只取面积最大的环，避免被密集顶点拽跑 */
  function ringArea(r: number[]) {
    let a = 0;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
    return a / 2;
  }
  function centroid(geo: any): [number, number] | null {
    const g = geo?.features?.[0]?.geometry;
    if (!g) return null;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates || [];
    let best: number[] | null = null, bestA = 0;
    for (const poly of polys) for (const ring of poly) {
      const a = Math.abs(ringArea(flat(ring)));
      if (a > bestA) { bestA = a; best = flat(ring); }
    }
    if (!best) return null;
    let a2 = 0, cx = 0, cy = 0;
    for (let i = 0, j = best.length - 2; i < best.length; j = i, i += 2) {
      const f = best[j] * best[i + 1] - best[i] * best[j + 1];
      a2 += f; cx += (best[j] + best[i]) * f; cy += (best[j + 1] + best[i + 1]) * f;
    }
    a2 /= 2;
    if (Math.abs(a2) < 1e-12) return null;
    return [cx / (6 * a2), cy / (6 * a2)]; // [lng, lat]
  }
  const flat = (ring: number[][]) => ring.flatMap(([lng, lat]) => [lng, lat]);

  /** 目的地坐标：抓该区县的 GeoJSON，算面积质心 */
  async function destLatLng(ad: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const r = await fetch(`http://127.0.0.1:8791/api/geo_json?ad=${ad}`);
      const geo = await r.json();
      const c = centroid(geo);
      return c ? { lng: c[0], lat: c[1] } : null;
    } catch {
      return null;
    }
  }

  /** 显示用的地名：`location()` 的 `area` 会把没反查到名字的层级**原样吐 adcode**
   *  （实测 "中国·重庆市·500100·500102"）→ 把纯数字段过滤掉，别让用户看编号。 */
  function prettyArea(area: unknown): string {
    const parts = String(area || "")
      .split("·")
      .map((x) => x.trim())
      .filter((x) => x && !/^\d+$/.test(x) && x !== "中国");
    return parts.join("·");
  }

  /** 目的地候选：**从最近的一级往上找**，取第一个能给出 ≥2 个下级的层级。
   *  踩过的坑：原来固定取 `path` 倒数第二级，实测那是 "500100"（一个中间层），
   *  `geo/children?ad=500100` 只回 1 个 → 下拉框里只有一项，等于没法用。 */
  async function loadDestList(path: any[], leaf: string) {
    for (let i = path.length - 1; i >= 0; i--) {
      const ad = String(path[i]?.adcode || "");
      if (!ad || ad === leaf) continue;
      try {
        const d = await (await fetch(`http://127.0.0.1:8791/api/geo/children?ad=${ad}`)).json();
        const kids = (d?.children || []).filter((x: any) => String(x.adcode) !== leaf);
        if (kids.length >= 2) return kids;
      } catch {
        /* 这一级拿不到就继续往上 */
      }
    }
    return [];
  }

  async function init() {
    try {
      const loc: any = await worldMapApi.location({ fast: true } as any);
      if (loc && !loc.error && Number.isFinite(loc.lat)) {
        const path = loc.path || [];
        const leaf = String(loc.leaf?.adcode || path[path.length - 1]?.adcode || "");
        const parent = String(path[path.length - 2]?.adcode || "");
        me.value = { lat: loc.lat, lng: loc.lng, area: prettyArea(loc.area), leafAd: leaf, parentAd: parent };
        // 地图：**按小屏取图**（264 宽），不是塞 1000px 的大图
        if (leaf) {
          try {
            mapSrc.value = await mapSvgUrl(leaf, "gaode", 264, 150);
          } catch (e) {
            mapErr.value = `地图取不到（${e instanceof Error ? e.message : e}）`;
          }
        }
        // 目的地候选：从最近一级往上找，直到拿到 ≥2 个（见 loadDestList 的注释）
        destList.value = await loadDestList(path, leaf);
      } else {
        err.value = "定位没结果（可以先用 IP 估测）";
      }
    } catch (e) {
      err.value = `定位失败：${e instanceof Error ? e.message : e}`;
    }
  }

  async function plan() {
    if (!me.value || !destAd.value) return;
    busy.value = true;
    err.value = "";
    opts.value = [];
    try {
      const to = await destLatLng(destAd.value);
      if (!to) throw new Error("拿不到目的地坐标");
      const res: any = await worldMapApi.transportPlan(
        { lat: me.value.lat, lng: me.value.lng },
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
    const out = [`从当前位置出发（${me.value?.area || "已定位"}）`];
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
