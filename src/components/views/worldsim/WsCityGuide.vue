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
  取数/落盘全部走 `wsCityStore.cityStore()`（`list/installed/install/remove/setBase`）——
  本组件**一行 fetch 都没有**：换下载源走 `store.setBase()`（或 `?citybase=` / 构建期常量），真机落盘只换 backend。

  ## 交接：i18n 现状（**别当成漏译**）
  `worldsim` 命名空间：`zh-CN` / `zh-HK` **全量**；`en` / `ja` **只有 `city` 段**（就是这一屏），
  其余键按 vue-i18n `fallbackLocale` **逐键回落中文**。改文案先改 `zh-CN`（基准）；
  `zh-HK` 用 `~/chk/gen-zh-hk-worldsim.mjs`（OpenCC cn→hk，与 `scripts/generate-zh-hk.mjs` 同口径）同步。

  ## 交接：屏幕上的话**必须与真实状态一致**（机主截图抓到过）
  正文（`leadText`）按「已装/未装 × 清单读到/没读到」分三种；「下载源」同行按 `store.baseInfo.from`
  决定是否提示"未配置/坏值回落"（坏值要把**被拒绝的原值**印出来）。断言在
  `~/chk/ws_guide_text_check.mjs`：不开浏览器，用 Vue 公开 API `createRenderer` 真挂载组件、
  真敲字、真点"保存/清除"，再断言屏幕文本、输入框值与 list 调用次数。
-->
<template>
  <div class="wscg" role="dialog" aria-modal="true" :aria-label="t('worldsim.city.title')">
    <div class="wscg__mask" />
    <section class="wscg__card">
      <header class="wscg__head">
        <h2 class="wscg__title">{{ t("worldsim.city.title") }}</h2>
        <!-- 🔴 正文必须与**真实状态**一致：已装过就不许再说"首次进入需要下载…装过就不再问"
             （2026-09-26 机主截图抓到：底栏写着「已装：重庆」，正文还在说"首次进入需要下载"） -->
        <p class="wscg__lead">{{ leadText }}</p>
        <!-- 🔴 「下载源」这行要能一眼看出"**没配**"：`from === "default"`（占位）时同行补一句
             「原因 + 怎么办」；配过（param/env/option）就不显示（见 srcHint 注释） -->
        <p class="wscg__src">
          {{ t("worldsim.city.source") }}：<code>{{ store.base }}</code>
          <span v-if="srcHint" class="wscg__srcwarn">{{ srcHint }}</span>
        </p>
        <!-- 🔴 下载源**应用内可配**（普通用户唯一需要知道的一条）：存一次就一直用，不用改码/重装。
             保存后**立刻 reload()** 从新源重取清单 —— 不做"填了不生效"那种假绿。 -->
        <div class="wscg__baseset">
          <input
            v-model="baseDraft"
            class="wscg__baseinput"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('worldsim.city.basePlaceholder')"
            :aria-label="t('worldsim.city.baseLabel')"
            @keyup.enter="saveBase"
          />
          <button class="wscg__btn is-mini" type="button" :disabled="!!busy" @click="saveBase">
            {{ t("worldsim.city.baseSave") }}
          </button>
          <button v-if="baseDraft.trim()" class="wscg__btn is-mini is-ghost" type="button" :disabled="!!busy" @click="clearBase">
            {{ t("worldsim.city.baseClear") }}
          </button>
        </div>
        <p v-if="store.baseInfo.from === 'param'" class="wscg__basenote">{{ t("worldsim.city.baseParamNote") }}</p>
        <p v-if="baseNote" class="wscg__basenote">{{ baseNote }}</p>
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
            {{ phase === "ok" ? t("worldsim.city.enterSkip") : t("worldsim.city.enterAnyway") }}
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

  /**
   * 🔴 正文（`lead`）**随真实状态变**，不许自相矛盾：
   *   · 一个都没装 ⇒ 原来那句"首次进入需要下载…装过就直接进地图，不再问"（这一屏的存在理由）；
   *   · **已装过** ⇒ 改成"已装：<城市名> —— …"，并且**分两种**：
   *       - 清单读到了（`ok`）：改选 / 重新下载 / 删除就在下面的列表里（确实"在这张表里"）；
   *       - 清单没读到（`unknown` / `empty`，含正在读）：**不能说"在这张表里"**（那张表根本没渲染），
   *         改说"已装的数据不受影响，可直接进入地图；可选城市列表状态见下方"。
   *   ⇒ 底栏那句 `installedSummary` 与这里说的是**同一件事**，两处不会再打架。
   */
  const leadText = computed(() => {
    if (!installed.value.length) return t("worldsim.city.lead");
    const list = installed.value.map((c) => c.name).join("、");
    return phase.value === "ok"
      ? t("worldsim.city.leadInstalled", { list })
      : t("worldsim.city.leadInstalledNoList", { list });
  });

  /**
   * 🔴 下载源**没配**（默认示例占位）/ 覆盖值坏掉回落时的**同一行**提示 —— 必须**同时**说清
   * ① **原因**（"未配置：占位地址，取不到属预期" / "覆盖值不可用，已回落占位"）
   * ② **怎么办**（在下面输入框里填并保存；或 `?citybase=` / 构建期 `VITE_WS_CITY_PACK_BASE`）
   * ⇒ 不许含糊成"网络错误"：那会把"没人配真源"说成"网络不好"，用户照着修网络永远修不好。
   * 坏值那条还必须带上**被拒绝的原值**（`requested`）与**是哪个覆盖源**配的（在 `why` 里）——
   * 否则用户看到"取不到清单"却不知道是自己填错了。
   * 判断只看 `store.baseInfo.from`：
   *   · `default`（谁都没配）⇒ 显示；· `fallback`（配了但值坏、已回落）⇒ **也显示**（那不是"配好了"）；
   *   · `param` / `stored` / `env` / `option`（配好了）⇒ 不显示、不打扰。
   */
  const srcHint = computed(() => {
    const b = props.store.baseInfo;
    if (b.from === "default") return t("worldsim.city.srcUnset");
    if (b.from === "fallback") return t("worldsim.city.srcFallback", { why: b.why || "", requested: b.requested || "" });
    return "";
  });

  /* ── 下载源输入框（应用内持久层：保存 ⇒ 立刻生效并重取清单）───────────────────── */
  const baseDraft = ref("");
  const baseNote = ref("");

  /** 输入框内容跟随**当前生效值**；坏值回落时**显示被拒绝的原值**（让人能改，而不是显示占位） */
  function syncBaseDraft(): void {
    const b = props.store.baseInfo;
    baseDraft.value = b.from === "fallback" ? b.requested || "" : b.base;
  }

  async function saveBase(): Promise<void> {
    const asked = baseDraft.value;
    const info = props.store.setBase(asked);
    syncBaseDraft();
    baseNote.value =
      info.from === "fallback"
        ? t("worldsim.city.baseBad", { why: info.why || "" })
        : t("worldsim.city.baseSaved", { base: info.base });
    await reload(); // 🔴 保存后**立刻**从新源重取清单（否则就是"填了不生效"）
  }

  async function clearBase(): Promise<void> {
    props.store.setBase(""); // 空值 = 删掉这一层 ⇒ 回落下一层（参数/构建期/占位）
    syncBaseDraft();
    baseNote.value = t("worldsim.city.baseCleared", { base: props.store.baseInfo.base });
    await reload();
  }

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

  onMounted(() => {
    syncBaseDraft();
    void reload();
  });

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
  /* 「下载源」**同一行**的"未配置/覆盖值坏掉"提示：跟警告色，但不抢列表（小字、可换行） */
  .wscg__srcwarn {
    color: #ffd479;
    word-break: break-all;
  }
  /* 下载源输入框那一行（应用内持久层） */
  .wscg__baseset {
    display: flex;
    gap: 6px;
    margin-top: 7px;
  }
  .wscg__baseinput {
    flex: 1;
    min-width: 0;
    padding: 6px 9px;
    border-radius: 9px;
    border: 1px solid rgba(121, 217, 255, 0.28);
    background: rgba(12, 18, 26, 0.92);
    color: #eaf6ff;
    font: inherit;
    font-size: 11.5px;
  }
  .wscg__baseinput::placeholder {
    color: #6c8093;
  }
  .wscg__btn.is-mini {
    padding: 6px 10px;
    border-radius: 9px;
    font-size: 11.5px;
  }
  .wscg__basenote {
    margin: 6px 0 0;
    color: #9fb4c4;
    font-size: 11px;
    word-break: break-all;
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
