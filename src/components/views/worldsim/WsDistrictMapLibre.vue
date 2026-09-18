<!--
  WsDistrictMapLibre.vue —— 小区级**直接用地图库渲染**（机主 2026-09-19 的决定）

  ## 为什么有这个组件
  机主原话：「在小区草图阶段，会**异常卡顿**，这里**直接用加载动画代替**，后面用**地图库直接使用**」。
  卡顿实测原因：那张草图是**一整张 78KB 的 SVG data-url**，几百个节点（每栋楼一个 `<g>`），
  手机上每次手势变换都要重新合成整张图 ⇒ 必然掉帧（下线后同级实测 **60fps / DOM 110**）。

  ## 这个组件做什么
  用 **vendored MapLibre（零依赖变更）** 画小区：
  · 底图风格**不依赖任何瓦片服务器**（自建 style：背景 + 真楼房 + 边界）；
  · **真实楼房挤出**（`fill-extrusion`，数据来自 `/api/buildings` —— 后端用"最近一次定位坐标"兜底，
    不用前端层层传参）；楼高来源如实区分：`height`（真数据）/ `levels`（层数×3m）/ `default`（默认 8m）；
  · 相机：以小区为中心、`pitch` 可倾斜（MapLibre 原生，我们手写渲染器做不到）。

  ## 纪律
  · **不新引依赖**：MapLibre 走 `public/vendor/maplibre/`（运行时动态 import）；
  · **不可用时如实降级**：无 WebGL / 模块加载失败 / 取不到楼房 ⇒ 显示原因，**不画假数据**；
  · 无头环境 WebGL 会在首帧后丢上下文（已知），所以"截图空白但指标正常"要如实写，不当作 bug。
-->
<template>
  <div ref="host" class="ws-dml">
    <canvas ref="cv" class="ws-dml__cv" />
    <!-- 指标条：验证用（也让人一眼看到"这是真数据还是降级"） -->
    <div class="ws-dml__hud">
      <span>🏢 {{ stats.count }}</span>
      <span :title="`height=${stats.height} / levels=${stats.levels} / default=${stats.default}（OSM 楼高覆盖率低，default 是估的）`">
        真高 {{ stats.height }} · 层数 {{ stats.levels }} · 默认 {{ stats.default }}
      </span>
      <span>{{ stats.fps }} fps</span>
      <span v-if="stats.note" class="is-warn">{{ stats.note }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
  import worldMapApi from "@/api/services/worldMap";

  const props = withDefaults(
    defineProps<{
      /** 区域名（只用于日志/降级提示，坐标由后端按最近定位兜底） */
      area?: string;
      /** 取楼半径（米） */
      radius?: number;
      /** 初始倾角（度）；0 = 俯视。倾斜是"2.5D 感"的一半 */
      pitch?: number;
    }>(),
    { area: "", radius: 600, pitch: 55 }
  );

  const host = ref<HTMLElement | null>(null);
  const cv = ref<HTMLCanvasElement | null>(null);
  // eslint 不需要 map 的类型细节；这里只留一个句柄用于销毁
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  let raf = 0;
  let alive = true;

  const stats = reactive({ count: 0, height: 0, levels: 0, default: 0, fps: 0, note: "" });

  /** 自建 style：**不依赖瓦片服务器**（背景 + 数据层都在这里定义） */
  function makeStyle() {
    return {
      version: 8,
      name: "ws-district",
      sources: {},
      layers: [{ id: "bg", type: "background", paint: { "background-color": "#101820" } }],
    };
  }

  /** 楼高来源分类（与 Rust/前端别处的口径一致：height → levels×3 → 默认 8m） */
  function classify(fc: { features?: Array<{ properties?: Record<string, unknown> }> }) {
    let h = 0;
    let l = 0;
    let d = 0;
    for (const f of fc.features || []) {
      const s = String((f.properties || {}).height_src || "default");
      if (s === "height") h++;
      else if (s === "levels") l++;
      else d++;
    }
    stats.height = h;
    stats.levels = l;
    stats.default = d;
    stats.count = (fc.features || []).length;
  }

  onMounted(async () => {
    if (!cv.value) return;
    // ① WebGL 预检（无头/低端机可能是软件渲染甚至没有）→ **如实降级**，不白屏
    let ok = false;
    try {
      const t = document.createElement("canvas");
      ok = !!(t.getContext("webgl2") || t.getContext("webgl"));
    } catch {
      ok = false;
    }
    if (!ok) {
      stats.note = "无 WebGL，无法用地图库渲染";
      return;
    }

    /* ⚠️ **必须用变量间接**：写成字面量 `import("/vendor/...")` 会让 TS 去解析这个路径
       （`TS2307: Cannot find module`），而它在运行时是 public/ 下的静态文件、根本没有类型。
       用变量之后 TS 不再解析（`any`），Vite 也不参与（public/ 原样发布）—— 两边都干净。 */
    const ML_URL = "/vendor/maplibre/maplibre-gl.mjs";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let maplibregl: any = null;
    try {
      const mod = await import(/* @vite-ignore */ ML_URL);
      maplibregl = mod?.default || mod;
    } catch {
      stats.note = "地图库加载失败（vendor/maplibre 缺失？）";
      return;
    }
    if (!alive || !maplibregl?.Map) return;

    // ② 取真实楼房（后端用"最近一次定位坐标"兜底，不用前端传参）
    let fc: { features?: unknown[]; error?: string } | null = null;
    try {
      const r = await fetch(`${worldMapApi.apiBase}/api/buildings?r=${props.radius}`);
      fc = await r.json();
    } catch {
      fc = null;
    }
    if (!alive) return;
    if (!fc || fc.error || !fc.features?.length) {
      stats.note = fc?.error ? String(fc.error).slice(0, 40) : "这一带没有楼房数据";
    }

    // ③ 建图（注意：样式里**不能写 `glyphs: undefined`** —— 会让样式校验失败且零报错）
    const m = new maplibregl.Map({
      container: host.value as HTMLElement,
      canvas: cv.value as HTMLCanvasElement,
      style: makeStyle(),
      center: [106.569, 29.558],
      zoom: 15.2,
      pitch: props.pitch,
      bearing: 0,
      attributionControl: false,
      // 无头截图需要；真机无影响
      preserveDrawingBuffer: true,
    });
    map = m;

    m.on("load", () => {
      if (fc?.features?.length) {
        classify(fc as { features?: Array<{ properties?: Record<string, unknown> }> });
        m.addSource("bld", { type: "geojson", data: fc });
        // 挤出：真高/层数估算/默认 8m 用**不同颜色**区分 —— 别让人把估计值当真数据
        m.addLayer({
          id: "bld-ext",
          type: "fill-extrusion",
          source: "bld",
          paint: {
            "fill-extrusion-color": [
              "match",
              ["get", "height_src"],
              "height", "#79d9ff",
              "levels", "#4a90b8",
              /* default */ "#3a4a5a",
            ],
            "fill-extrusion-height": ["*", 1, ["coalesce", ["get", "height"], 8]],
            "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
            "fill-extrusion-opacity": 0.95,
          },
        });
        m.addLayer({
          id: "bld-line",
          type: "line",
          source: "bld",
          paint: { "line-color": "rgba(255,255,255,0.25)", "line-width": 0.6 },
        });
        // 用真实楼房的范围收一下相机（取不到就保持默认中心）
        try {
          const b = new (maplibregl as unknown as { LngLatBounds: new () => unknown }).LngLatBounds();
          for (const f of (fc as { features?: Array<{ geometry?: { coordinates?: unknown } }> }).features || []) {
            const g = f.geometry || {};
            const walk = (v: unknown): void => {
              if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") {
                (b as { extend: (c: [number, number]) => void }).extend([v[0] as number, v[1] as number]);
              } else if (Array.isArray(v)) {
                for (const x of v) walk(x);
              }
            };
            walk(g.coordinates);
          }
          m.fitBounds(b as never, { padding: 24, pitch: props.pitch, duration: 0 });
        } catch {
          /* 收不了相机就用默认视野，不影响可用性 */
        }
      }
    });

    // ④ fps（滚动 1 秒窗口，与项目其它地方同一口径）
    let last = performance.now();
    let frames = 0;
    let win = 0;
    const tick = (now: number) => {
      if (!alive) return;
      const dt = now - last;
      last = now;
      frames++;
      win += dt;
      if (win >= 1000) {
        stats.fps = Math.round((frames * 1000) / win);
        frames = 0;
        win = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  onBeforeUnmount(() => {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    try {
      map?.remove?.();
    } catch {
      /* 已经没了就算了 */
    }
    map = null;
  });
</script>

<style scoped>
  .ws-dml {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #101820;
  }
  /* ⚠️ canvas 是替换元素（默认 300×150），只给 inset 不会拉伸 → 必须显式 100% */
  .ws-dml__cv {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .ws-dml__hud {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    gap: 8px;
    padding: 3px 8px;
    border-radius: 8px;
    background: rgba(10, 16, 24, 0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #fff;
    font-size: 11px;
    line-height: 1.6;
    pointer-events: none;
  }
  .ws-dml__hud .is-warn {
    color: #ffd28a;
  }
</style>
