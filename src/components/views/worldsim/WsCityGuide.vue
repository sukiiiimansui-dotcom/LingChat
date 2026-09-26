<!--
  WsCityGuide.vue —— 「初始引导：选城市 → 下载楼房数据 → 进地图」（2026-09-26）

  ## 机主原话（这一屏的存在理由）
  「**App页与代拍页完全不一样，多余的UI，按钮，甚至初始显示的城市都不一样
   （加个初始引导，选择下载哪个城市的楼房数据）**」
  「用云端下载路线（真正在安装包里的东西，选择从云端下载哪些城市数据，不过我们自己就用重庆的就行）」

  ## 它在页面上的位置
  **一张盖在 3D 地图上面的 sheet**（不是"先引导、后地图"的两个页面）：
    · 地图在它后面**已经在跑**（`WsCityEntry.vue` 一进来就挂 `WsSceneView`）⇒ 首屏不白等，
      而且 `/worldsim` 这一屏**始终是地图**（机主要的正是这个）；
    · 装过任何城市 ⇒ 这张 sheet **根本不出现**（`localStorage` 里有记录），别每次问。

  ## 三态（机主定的判词纪律，这里是最直接的落点）
  清单/包的任何一步都只有三种结果：**正数 / 0（已量）/ 数不出来（写原因）**。
  所以下面每一处 UI 都按这三种写：`empty` 明说"清单里确实 0 个城市"，
  `unknown` **把原因原文（HTTP 状态、URL、解析错）印出来**，绝不把"没取到"显示成 0。
  🔴 引导**不许变成死路**：清单取不到时也给「仍然进入地图」（机主认过这条）。

  ## 存储接口
  取数/落盘全部走 `wsCityStore.cityStore()`（`list/installed/install/remove`）——
  本组件**一行 fetch 都没有**：换下载源只改 `WS_CITY_PACK_BASE`，真机落盘只换 backend。
-->
<template>
  <div class="wscg" role="dialog" aria-modal="true" :aria-label="t('worldsim.city.title')">
    <div class="wscg__mask" />
    <section class="wscg__card">
      <header class="wscg__head">
        <h2 class="wscg__title">{{ t("worldsim.city.title") }}</h2>
        <p class="wscg__lead">{{ t("worldsim.city.lead") }}</p>
        <p class="wscg__src">{{ t("worldsim.city.source") }}：<code>{{ store.base }}</code></p>
      </header>

      <div class="wscg__body">
        <!-- ① 读清单中 -->
        <div v-if="phase === 'loading'" class="wscg__state">
          <span class="wscg__spin" aria-hidden="true">◌</span> {{ t("worldsim.city.loading") }}
        </div>

        <!-- ② 数不出来（原因原文上屏；**不是** 0） -->
        <div v-else-if="phase === 'unknown'" class="wscg__state is-warn">
          <div class="wscg__warnhead">⚠️ {{ t("worldsim.city.unknown") }}</div>
          <div class="wscg__why">{{ listWhy }}</div>
          <div class="wscg__hint">{{ t("worldsim.city.enterAnywayHint") }}</div>
        </div>

        <!-- ③ 0（已量）—— 清单读到了，里面确实一个城市都没有 -->
        <div v-else-if="phase === 'empty'" class="wscg__state">
          <div>{{ t("worldsim.city.empty") }}</div>
        </div>

        <!-- ④ 正数：城市列表 -->
        <template v-else>
          <div class="wscg__sect">{{ t("worldsim.city.listed") }}</div>
          <ul class="wscg__list">
            <li v-for="c in cities" :key="c.id" class="wscg__row" :class="{ 'is-installed': !!installedOf(c.id) }">
              <div class="wscg__rowmain">
                <div class="wscg__name">
                  {{ c.name }}
                  <span v-if="isDefault(c)" class="wscg__tag">{{ t("worldsim.city.defaultTag") }}</span>
                  <span v-if="installedOf(c.id)" class="wscg__tag is-ok">{{ t("worldsim.city.installedTag") }}</span>
                </div>
                <div class="wscg__meta">
                  <span>{{ t("worldsim.city.size", { s: fmtBytes(c.bytes) }) }}</span>
                  <span v-if="c.cells !== undefined">· {{ t("worldsim.city.cells", { n: num(c.cells) }) }}</span>
                  <span v-if="c.features !== undefined">· {{ t("worldsim.city.features", { n: num(c.features) }) }}</span>
                  <span v-if="c.attribution" class="wscg__attr" :title="c.attribution">· {{ t("worldsim.city.attr") }}</span>
                </div>
                <!-- 已装的那一行：把**装的是什么**如实写出来（格数/sha 校验/是否全驻留） -->
                <div v-if="installedOf(c.id)" class="wscg__inst">
                  {{ installedLine(installedOf(c.id)) }}
                </div>
              </div>
              <div class="wscg__rowops">
                <button
                  class="wscg__btn is-primary"
                  type="button"
                  :disabled="!!busy"
                  @click="install(c)"
                >
                  {{ installedOf(c.id) ? t("worldsim.city.redownload") : t("worldsim.city.download") }}
                </button>
                <button
                  v-if="installedOf(c.id)"
                  class="wscg__btn is-ghost"
                  type="button"
                  :disabled="!!busy"
                  @click="remove(c)"
                >
                  {{ t("worldsim.city.remove") }}
                </button>
              </div>
            </li>
          </ul>
          <div v-if="droppedLine" class="wscg__hint">{{ droppedLine }}</div>
        </template>

        <!-- ⑤ 下载中：阶段 + **真字节**（没有 content-length 就不编分母） -->
        <div v-if="busy" class="wscg__prog">
          <div class="wscg__progline">
            <b>{{ stageLabel }}</b>
            <span>{{ progressLine }}</span>
          </div>
          <div class="wscg__bar" :class="{ 'is-indet': progress.total === null }">
            <i :style="{ width: pct + '%' }" />
          </div>
        </div>

        <!-- ⑥ 失败：原因原文 + 重试（失败原因只来自 store，不在这里编） -->
        <div v-if="err" class="wscg__state is-err">
          <div class="wscg__warnhead">❌ {{ t("worldsim.city.failed") }}</div>
          <div class="wscg__why">{{ err }}</div>
        </div>
      </div>

      <footer class="wscg__foot">
        <div class="wscg__instsum">{{ installedSummary }}</div>
        <div class="wscg__footops">
          <button v-if="phase === 'unknown'" class="wscg__btn" type="button" :disabled="!!busy" @click="reload">
            {{ t("worldsim.city.retry") }}
          </button>
          <button class="wscg__btn" type="button" :disabled="!!busy" @click="emit('enter')">
            {{ t("worldsim.city.enterAnyway") }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, ref } from "vue";
  import { useI18n } from "vue-i18n";
  import {
    type CityStore,
    type InstallProgress,
    type InstalledCity,
  } from "./wsCityStore";
  import { type CityPackInfo, fmtBytes, pickDefaultCity } from "./wsCityPack";

  const props = defineProps<{ store: CityStore }>();
  const emit = defineEmits<{ (e: "enter"): void }>();
  const { t } = useI18n();

  const loading = ref(true);
  const listWhy = ref("");
  const cities = ref<CityPackInfo[]>([]);
  const dropped = ref<string[]>([]);
  /** 判词三态里"清单读到了、里面确实 0 个城市"这一态 */
  const empty = ref(false);
  const installed = ref<InstalledCity[]>([]);
  const busy = ref("");
  const err = ref("");
  const progress = ref<InstallProgress>({ stage: "download", got: 0, total: null });

  const phase = computed<"loading" | "unknown" | "empty" | "ok">(() => {
    if (loading.value) return "loading";
    if (listWhy.value) return "unknown";
    if (empty.value) return "empty";
    return "ok";
  });

  const droppedLine = computed(() =>
    dropped.value.length ? t("worldsim.city.dropped", { n: dropped.value.length }) : ""
  );

  const stageLabel = computed(() => stageName(progress.value.stage));

  /** 阶段名的**唯一**映射（进度条与失败原因都用它，别在两处各写一份中文） */
  function stageName(s: InstallProgress["stage"]): string {
    const m: Record<InstallProgress["stage"], string> = {
      download: t("worldsim.city.stageDownload"),
      verify: t("worldsim.city.stageVerify"),
      unpack: t("worldsim.city.stageUnpack"),
      store: t("worldsim.city.stageStore"),
    };
    return m[s];
  }

  const progressLine = computed(() => {
    const p = progress.value;
    if (p.total) return t("worldsim.city.gotOfTotal", { got: fmtBytes(p.got), total: fmtBytes(p.total) });
    return t("worldsim.city.gotNoTotal", { got: fmtBytes(p.got) });
  });

  /** 有分母才给百分比；没有分母（服务端没给 content-length）**不编** */
  const pct = computed(() => {
    const p = progress.value;
    if (!p.total) return 0;
    return Math.max(0, Math.min(100, Math.round((p.got / p.total) * 100)));
  });

  const num = (n: number): string => n.toLocaleString("en-US");

  function installedOf(id: string): InstalledCity | null {
    return installed.value.find((c) => c.id === id) || null;
  }

  function isDefault(c: CityPackInfo): boolean {
    return defaultCity.value?.id === c.id;
  }

  const defaultCity = computed(() => pickDefaultCity(cities.value));

  /** 已装那行的原话：格数 / sha 校验结果 / 没全驻留的原因（**一个都不省**） */
  function installedLine(it: InstalledCity | null): string {
    if (!it) return "";
    const sha =
      it.sha === "ok"
        ? " · " + t("worldsim.city.shaOk")
        : it.sha === "none"
          ? " · " + t("worldsim.city.shaNone")
          : "";
    const res = it.resident ? " · " + it.resident : "";
    return t("worldsim.city.installedLine", { n: num(it.cells), got: fmtBytes(it.got) }) + sha + res;
  }

  const installedSummary = computed(() => {
    if (!installed.value.length) return t("worldsim.city.installedNone");
    return t("worldsim.city.installedSummary", { list: installed.value.map((c) => c.name).join("、") });
  });

  async function reload(): Promise<void> {
    loading.value = true;
    listWhy.value = "";
    empty.value = false;
    err.value = "";
    installed.value = props.store.installed();
    const st = await props.store.list(true);
    if (st.state === "ok") {
      cities.value = st.cities;
      dropped.value = st.dropped;
    } else if (st.state === "empty") {
      cities.value = [];
      dropped.value = [];
      empty.value = true;
    } else {
      cities.value = [];
      dropped.value = [];
      listWhy.value = st.why;
    }
    loading.value = false;
  }

  onMounted(() => void reload());

  async function install(c: CityPackInfo): Promise<void> {
    if (busy.value) return;
    busy.value = c.id;
    err.value = "";
    progress.value = { stage: "download", got: 0, total: null };
    const out = await props.store.install(c.id, (p) => {
      progress.value = p;
    });
    busy.value = "";
    if (!out.ok) {
      /* 失败原因**原样**上屏（含阶段，阶段名与进度条同一份文案）：谁也不会以为"装好了" */
      err.value = "[" + stageName(out.stage) + "] " + out.why;
      return;
    }
    installed.value = props.store.installed();
    /* 装好就进地图 —— 机主要的"选城市 → 下载 → 进入地图"一条路走完 */
    emit("enter");
  }

  function remove(c: CityPackInfo): void {
    props.store.remove(c.id);
    installed.value = props.store.installed();
  }
</script>

<style scoped>
  /* 配色口径抄的是本页既有的浮动面板（`WsVerifyPanel` / `.ws-dml__hud`）：
     深底 rgba(7,11,17,·) + 冰蓝描边 + 等宽字体小字 —— 不新立美术方向（机主否过擅自改美术）。 */
  .wscg {
    position: absolute;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #eaf6ff;
  }
  .wscg__mask {
    position: absolute;
    inset: 0;
    background: rgba(4, 7, 12, 0.62);
    backdrop-filter: blur(var(--ws-blur-low, 6px));
    -webkit-backdrop-filter: blur(var(--ws-blur-low, 6px));
  }
  .wscg__card {
    position: relative;
    width: min(94vw, 520px);
    max-height: min(88vh, 640px);
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    background: rgba(7, 11, 17, 0.95);
    border: 1px solid rgba(121, 217, 255, 0.28);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .wscg__head {
    padding: 14px 16px 10px;
    border-bottom: 1px solid rgba(121, 217, 255, 0.16);
  }
  .wscg__title {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .wscg__lead {
    margin: 0;
    color: #b8cede;
  }
  .wscg__src {
    margin: 6px 0 0;
    color: #7f95a8;
    font-size: 11px;
    word-break: break-all;
  }
  .wscg__src code {
    color: #9fd8ef;
  }
  .wscg__body {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
  }
  .wscg__state {
    padding: 6px 0;
  }
  .wscg__state.is-warn .wscg__warnhead {
    color: #ffd479;
  }
  .wscg__state.is-err .wscg__warnhead {
    color: #ff8b8b;
  }
  .wscg__warnhead {
    font-weight: 700;
    margin-bottom: 4px;
  }
  .wscg__why {
    color: #cfe3f0;
    word-break: break-all;
  }
  .wscg__hint {
    margin-top: 8px;
    color: #85a0b3;
    font-size: 11.5px;
  }
  .wscg__spin {
    display: inline-block;
    animation: wscg-spin 1.1s linear infinite;
  }
  @keyframes wscg-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .wscg__sect {
    color: #7f95a8;
    font-size: 11px;
    margin: 2px 0 8px;
  }
  .wscg__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wscg__row {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(18, 26, 36, 0.86);
    border: 1px solid rgba(121, 217, 255, 0.14);
  }
  .wscg__row.is-installed {
    border-color: rgba(126, 235, 178, 0.38);
  }
  .wscg__rowmain {
    flex: 1;
    min-width: 0;
  }
  .wscg__name {
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .wscg__tag {
    font-size: 10.5px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(121, 217, 255, 0.16);
    color: #9fd8ef;
  }
  .wscg__tag.is-ok {
    background: rgba(126, 235, 178, 0.18);
    color: #a8f0c8;
  }
  .wscg__meta {
    margin-top: 2px;
    color: #9fb4c4;
    font-size: 11.5px;
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .wscg__attr {
    color: #7f95a8;
  }
  .wscg__inst {
    margin-top: 3px;
    font-size: 11px;
    color: #8fe0b4;
    word-break: break-all;
  }
  .wscg__rowops {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wscg__btn {
    padding: 7px 12px;
    border-radius: 10px;
    border: 1px solid rgba(121, 217, 255, 0.32);
    background: rgba(18, 26, 36, 0.9);
    color: #eaf6ff;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .wscg__btn.is-primary {
    background: rgba(64, 156, 214, 0.9);
    border-color: rgba(121, 217, 255, 0.5);
    color: #04121c;
    font-weight: 700;
  }
  .wscg__btn.is-ghost {
    border-color: rgba(255, 255, 255, 0.18);
    color: #b8cede;
  }
  .wscg__btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .wscg__prog {
    margin-top: 12px;
  }
  .wscg__progline {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 11.5px;
    color: #cfe3f0;
  }
  .wscg__bar {
    margin-top: 6px;
    height: 6px;
    border-radius: 999px;
    background: rgba(121, 217, 255, 0.16);
    overflow: hidden;
  }
  .wscg__bar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #409cd6, #7eebb2);
    transition: width 0.18s linear;
  }
  /* 没有分母 ⇒ 不画"确定进度"，只留一条呼吸的底色（如实：我们不知道还剩多少） */
  .wscg__bar.is-indet i {
    width: 100% !important;
    opacity: 0.35;
    animation: wscg-breathe 1.4s ease-in-out infinite;
  }
  @keyframes wscg-breathe {
    50% {
      opacity: 0.12;
    }
  }
  .wscg__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 16px 12px;
    border-top: 1px solid rgba(121, 217, 255, 0.16);
    font-size: 11.5px;
    color: #9fb4c4;
  }
  .wscg__instsum {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wscg__footops {
    display: flex;
    gap: 8px;
  }
</style>
