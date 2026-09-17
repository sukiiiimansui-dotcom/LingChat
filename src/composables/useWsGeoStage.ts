/**
 * useWsGeoStage —— 把 `wsGeoMap`（客户端 GeoJSON 矢量渲染）接进「世界模拟」舞台（UI 改造 S2）
 *
 * ── 为什么单独一个 composable ──────────────────────────────────────────────
 * `WorldSim.vue` 已经 1500+ 行，地图这一块又是「取数 → 换级 → 高亮 → 手势 → 兜底」五件事。
 * 收在这里，页面只负责"告诉它现在是哪一级、选中了谁"。
 *
 * ── 与旧通路的关系（重要）──────────────────────────────────────────────────
 * 旧通路是后端现画的 SVG（`sim.stage.markup` + `v-html` + `.geo-region` 事件委托）。
 * **本 composable 不删旧路**：GeoJSON 取不到/Canvas 不可用时 `ok=false`，
 * 页面照旧渲染 SVG —— 新东西坏了不能把地图整个弄没（可回退是硬要求）。
 *
 * ── 为什么缩放是丝滑的 ─────────────────────────────────────────────────────
 * 缩放/平移只改 canvas 的变换矩阵（`ctx.setTransform`），**不发请求、不重建 DOM**。
 * 旧路每次缩放都是一次 `/api/geo_svg?...&w=&h=&zoom=` 往返，物理上做不到连续。
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { geoJson } from "@/api/services/worldMap";
import { parseFeatures, WsGeoMap, THEME_DARK, THEME_LIGHT, type GeoFeat } from "@/components/views/worldsim/wsGeoMap";

export interface WsGeoStagePick {
  adcode: string;
  name: string;
}

export interface UseWsGeoStageOpts {
  /** 舞台容器（量尺寸用） */
  host: Ref<HTMLElement | null>;
  /** 画布 */
  canvas: Ref<HTMLCanvasElement | null>;
  /** 当前级的 adcode（变化即换级） */
  adcode: () => string;
  /** 点了某个区域 */
  onPick: (p: WsGeoStagePick) => void;
  /** 深色主题（跟随世界模拟的深色开关） */
  dark: () => boolean;
}

export function useWsGeoStage(o: UseWsGeoStageOpts) {
  const map = ref<WsGeoMap | null>(null);
  /** Canvas 通路是否可用（false = 页面应回退到 SVG 通路） */
  const ok = ref(false);
  /** 当前画出来的要素（给"点空白处取消选中"之类用） */
  const feats = ref<GeoFeat[]>([]);
  const err = ref("");
  /** 最近一次 pick 出来的要素（高亮用） */
  let ro: ResizeObserver | null = null;
  const cache = new Map<string, GeoFeat[]>();

  function mount() {
    const cv = o.canvas.value;
    const host = o.host.value;
    if (!cv || !host) return;
    try {
      map.value = new WsGeoMap({
        canvas: cv,
        theme: o.dark() ? THEME_DARK : THEME_LIGHT,
        onPick: (f) => {
          if (f) o.onPick({ adcode: f.adcode, name: f.name });
          else o.onPick({ adcode: "", name: "" }); // 点空白 = 取消选中（页面自己判空）
        },
      });
      ro = new ResizeObserver(() => map.value?.layout());
      ro.observe(host);
      ok.value = true;
      // ⚠️ 必须在这里补一次首帧：`watch(adcode, …, {immediate:true})` 在 setup 期就跑过了，
      //    那时 map 还没建（canvas 还没挂载）→ 直接 return，页面会一直空着。
      void load(o.adcode(), false);
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
      ok.value = false;
    }
  }

  /** 换一级：取 GeoJSON → 画。失败就把 `ok` 置回 false（页面回退 SVG）。 */
  async function load(ad: string, animate = true) {
    const m = map.value;
    if (!m || !ad) return;
    try {
      let fs = cache.get(ad);
      if (!fs) {
        fs = parseFeatures(await geoJson(ad));
        if (!fs.length) throw new Error(`${ad} 没有要素`);
        cache.set(ad, fs);
      }
      feats.value = fs;
      m.setFeatures(fs, { animate });
      err.value = "";
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
      // ⚠️ 只在**第一次**就失败时才回退（画到一半失败不该把已经看得见的图撤掉）
      if (!feats.value.length) ok.value = false;
    }
  }

  function highlight(ads: string[]) {
    map.value?.setHighlight(ads.filter(Boolean));
  }

  function setDark(dark: boolean) {
    map.value?.setTheme(dark ? THEME_DARK : THEME_LIGHT);
  }

  function zoomBy(f: number) {
    map.value?.animateZoomTo((map.value?.zoom || 1) * f);
  }
  function reset() {
    map.value?.reset();
  }
  function layout() {
    map.value?.layout();
  }

  // 换级就重画（`adcode` 是函数，所以手动 watch 它算出来的值）
  watch(
    () => o.adcode(),
    (ad) => void load(ad),
    { immediate: true }
  );
  /* ⚠️ 画布/容器**不是**在 setup 那一刻就存在的：舞台上 `v-else-if` 分支会随 `step` 变
     （先「定位中」、再地图）—— 所以不能只在 `onMounted` 里建一次。这里盯着两个 ref，
     谁先到齐就在谁之后建（已建过就只做一次 layout）。 */
  watch(
    [o.host, o.canvas],
    ([h, c]) => {
      if (h && c && !map.value) mount();
      else map.value?.layout();
    },
    { immediate: true, flush: "post" }
  );
  watch(() => o.dark(), (d) => setDark(d));

  onBeforeUnmount(() => {
    ro?.disconnect();
    map.value?.destroy();
    map.value = null;
  });

  return { ok, err, feats, mount, load, highlight, setDark, zoomBy, reset, layout, get map() { return map.value; } };
}
