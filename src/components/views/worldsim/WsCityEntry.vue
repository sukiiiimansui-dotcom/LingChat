<!--
  WsCityEntry.vue —— `/worldsim` 的**新入口**（2026-09-26 机主拍板：「**彻底替掉官方那套 UI**」）

  ## 这一屏是什么
  「世界模拟」入口 = **代拍页那一屏（MapLibre 3D 地图）**，外加一层**首次引导**
  （选城市 → 下载该城市的楼房数据 → 进地图）。上游那套 DataV 全国 SVG 下钻
  （`WorldSim.vue`：顶栏 ⋯ 抽屉 / 34 个区划 / 「点『进入』才下钻」/ 未读角标 / 小地图 /
  「选别的地方」）**不再是被引用的入口**（文件留着，路由里一行可回退）。

  ## 为什么地图是"常驻"而不是"引导完再挂"
  · 机主要的是「进 `/worldsim` **直接是地图**」—— 这一屏**始终**是一张 3D 地图；
  · 引导是**盖在它上面的一张 sheet**：首屏不白等，关掉 sheet 立刻就是可用地图；
  · 装过城市（`localStorage` 里有记录）⇒ **sheet 根本不出现**（机主：「装过就直接进地图，别每次问」）。
  · 「仍然进入地图」这条**必须在**（机主认过）：清单/包取不到时引导不能变成死路。

  ## 共享真源（PR 门禁 C1：App 侧不许第二份实现）
  这一屏**一行地图逻辑都没有**：地图本体与交通设施都在 `WsSceneView`（→ `WsDistrictMapLibre`），
  层/主题/相机/取数全走 `wsScene` / `wsMapTheme` / `wsOfflineFeed` / `wsGwLayer` … 那套共享真源。
  本文件只做三件：**挂地图 + 决定引导开不开 + 决定顶栏显示什么**。

  ## 顶栏的取舍（机主：「多余的UI，按钮」）
  只留一行、常驻元素 ≤3（`UI-DESIGN-SPEC.md` 的浮块上限）：
    · `←`            回主菜单（老入口也有，**不是**新造的）
    · `🌏 世界模拟 + 城市名`  唯一的状态显示（当前在用哪座城市的数据）
    · `🗺 城市数据`   打开引导 sheet（改选/重下/删除城市都在这张 sheet 里）
  去掉的：`⋯ 抽屉`（地图主题/皮肤/深浅 —— 3D 地图自己那套主题在 HUD 的 🎨 里，
  "重新引导"被"城市数据"取代）· 未读角标 · 小地图 · 缩放按钮 · 「选别的地方」·
  DataV 的 34 个区划与「进入」按钮 · `WsPhone` 悬浮手机（老入口在小区级本来也不显示它）。
-->
<template>
  <div class="wsce">
    <!-- 🗺 地图常驻（新入口 = 直接进 3D 地图）。
         `chrome=false` 只关掉底栏那三个按钮（「← 回到区县」在没有区县这一级时是死按钮）；
         `tf=false` 关掉交通设施那条接线 —— 它会发一条 `/api/roads`（真机冷查分钟级、必超时），
         而新入口要**默认 0 条 `/api/*`**（与代拍页默认口径一致）。两个开关都只改"显示/接线"，
         地图本体、层序、取数一行不动（那些仍是同一份共享真源）。 -->
    <WsSceneView :key="sceneKey" :area="areaLabel" adcode="" :chrome="false" :tf="false" />

    <!-- ── 顶栏（一行三件；引导开着时让位给 sheet）───────────────────────── -->
    <header v-if="!guideOpen" class="wsce__top">
      <button class="wsce__btn" type="button" :title="t('worldsim.back')" @click="goMenu">←</button>
      <div class="wsce__brand">
        <span aria-hidden="true">🌏</span>
        <span class="wsce__name">{{ t("worldsim.title") }}</span>
        <span class="wsce__tag">{{ cityLabel }}</span>
      </div>
      <button class="wsce__btn" type="button" @click="openGuide">🗺 {{ t("worldsim.city.data") }}</button>
    </header>

    <!-- 没装过城市数据时的**常驻提示**（点了就开引导）——"少了一整座城市的楼房"这种事
         不能只躺在控制台里；它是可点的一条，不弹窗、不挡地图。 -->
    <button v-if="!guideOpen && !installedCount" class="wsce__chip" type="button" @click="openGuide">
      ⚠️ {{ t("worldsim.city.noCity") }}
    </button>

    <!-- ── 首次引导（一张 sheet；装过就不出现）────────────────────────── -->
    <WsCityGuide v-if="guideOpen" :store="store" @enter="closeGuide" />
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, ref } from "vue";
  import { useRouter } from "vue-router";
  import { useI18n } from "vue-i18n";
  import WsSceneView from "./WsSceneView.vue";
  import WsCityGuide from "./WsCityGuide.vue";
  import { type InstalledCity, cityStore } from "./wsCityStore";

  const router = useRouter();
  const { t } = useI18n();
  const store = cityStore();

  /** 已经装好的城市（`[]` = 确实一个都没装 —— 这是"已量"，不是"读不到"） */
  const installed = ref<InstalledCity[]>([]);
  const guideOpen = ref(false);
  /** 装过城市后**不重挂地图**：本片只是"选 + 下 + 记住"，让地图用上这份数据是下一片的事 */
  const sceneKey = ref(0);

  const installedCount = computed(() => installed.value.length);

  /** 当前在用哪座城市的数据（HUD 之外唯一的一处状态显示） */
  const cityLabel = computed(() => {
    if (!installed.value.length) return t("worldsim.city.noCityTag");
    return installed.value.map((c) => c.name).join("、");
  });

  /** 地图"区域名"（`WsSceneView` 只把它当显示名用；真实机位仍由地图自己的默认值决定） */
  const areaLabel = computed(() => (installed.value.length ? installed.value[0].name : ""));

  /* 「别每次问」：跳过过一次就记住（但**常驻提示不会消失** —— 上面那条 chip 仍在，
     点它随时能回来装）。装过城市 ⇒ 本来就不会自动开。 */
  const SKIP_KEY = "ws.cityguide.skipped.v1";

  function skipped(): boolean {
    try {
      return localStorage.getItem(SKIP_KEY) === "1";
    } catch {
      return false; // 读不到 localStorage ⇒ 当没跳过（宁可问一次，也别让引导永远不出现）
    }
  }

  function rememberSkip(): void {
    try {
      localStorage.setItem(SKIP_KEY, "1");
    } catch {
      /* 记不住就算了：最多下次再问一遍 */
    }
  }

  function openGuide(): void {
    guideOpen.value = true;
  }

  function closeGuide(): void {
    installed.value = store.installed();
    if (!installed.value.length) rememberSkip();
    guideOpen.value = false;
  }

  function goMenu(): void {
    router.push("/");
  }

  onMounted(() => {
    installed.value = store.installed();
    /* 首次引导的开屏判据（**唯一一处**）：没装过任何城市 + 没跳过过 ⇒ 开。
       ⚠️ 这里**不读清单**：读清单是 sheet 自己的事（它要显示三态与原因）。
       入口只关心"要不要问"，这样清单服务挂了也不影响进地图。 */
    guideOpen.value = !installed.value.length && !skipped();
    sceneKey.value += 0;
  });
</script>

<style scoped>
  /* 铺满整屏（与老入口 `.ws-root` 同一套定位口径：`fixed + inset:0 + z-index:50`）——
     地图组件自己是 `position:absolute; inset:0`，需要一个有定位的满屏父容器。 */
  .wsce {
    position: fixed;
    inset: 0;
    z-index: 50;
    overflow: hidden;
    background: #0a0f16;
  }

  .wsce__top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    /* 只让**这一条**吃手势，其余地方照旧留给地图（拖动/捏合不能被顶栏吃掉） */
    pointer-events: none;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .wsce__top > * {
    pointer-events: auto;
  }
  .wsce__btn {
    padding: 6px 10px;
    border-radius: 10px;
    border: 1px solid rgba(121, 217, 255, 0.28);
    background: rgba(7, 11, 17, 0.66);
    color: #eaf6ff;
    font: inherit;
    cursor: pointer;
  }
  .wsce__brand {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px 10px;
    border-radius: 10px;
    background: rgba(7, 11, 17, 0.5);
    color: #eaf6ff;
  }
  .wsce__name {
    font-weight: 700;
  }
  .wsce__tag {
    max-width: 42vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(121, 217, 255, 0.16);
    color: #9fd8ef;
    font-size: 11px;
  }
  .wsce__chip {
    position: absolute;
    left: 8px;
    top: 46px;
    z-index: 30;
    padding: 5px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 207, 138, 0.42);
    background: rgba(7, 11, 17, 0.62);
    color: #ffcf8a;
    font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: pointer;
  }
</style>
