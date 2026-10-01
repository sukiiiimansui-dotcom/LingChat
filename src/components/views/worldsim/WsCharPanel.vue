<template>
  <!--
    P2-2 立绘侧边栏 + P2-3 角色信息面板（7 项）

    为什么两者在**同一个组件**里：
      需求本身就是「点角色 → 从边上滑出立绘，同时能看 7 项信息」。
      拆成两个组件会多出一条「谁是当前角色 / 立绘展开没有」的同步链，
      而那条链一旦不同步，就会出现「面板关了立绘还在加载」这种最要命的性能 bug。

    ⚠️ 性能红线：立绘（3511×5242 webp，解码 ≈73MB）只在 `portraitOpen` 为 true 时
       才由 useWsPortrait 去取，关掉立刻把 src 置空。缩略图是另一张图（头像小方图），
       不碰立绘文件。

    ⚠️ 手势：整个面板挂 `data-no-gesture`（useWorldSimGestures 的 NO_GESTURE_SELECTOR
       认这个属性），并且内部滚动容器自己 stop 掉 pointer/wheel，
       保证在面板上拖动/滚动**不会**把地图拖走或缩放。
  -->
  <div
    class="ws-drawer"
    :class="{ 'is-narrow': narrow }"
    data-no-gesture
  >
    <!-- 窄屏：半透明遮罩（点它 = 关闭）；宽屏不要遮罩（抽屉式，背后地图还能看）。
         🔴 2026-10-01（机主：「点开面板后地图怎么滑动不了喵！」）：**手势的 `.stop` 从根元素挪到真正的面上**。
         根 `.ws-drawer` 是 `inset:0`（全屏）—— 原来在它身上 `.stop` 掉 pointer/wheel/dblclick，
         等于**面板一开，整屏的手势都被吃掉**，地图再也拖不动（宽屏明明写着"背后地图还能看"）。
         现在：根 `pointer-events:none`（见样式），只有**遮罩**与**面板本体**接事件并 stop ——
         在面板/遮罩上拖动照样不会拖走地图，在空白处（宽屏左侧）则照常能拖地图。 -->
    <div
      v-if="narrow"
      class="ws-drawer__mask"
      @click="emit('close')"
      @pointerdown.stop
      @pointerup.stop
      @wheel.stop
    />

    <aside
      class="ws-drawer__panel"
      role="dialog"
      aria-modal="true"
      :aria-label="panelTitle"
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
      @wheel.stop
      @dblclick.stop
    >
      <header class="ws-drawer__head">
        <button
          class="ws-btn ws-btn--ghost"
          type="button"
          :title="t('worldsim.panel.close')"
          @click="emit('close')"
        >
          ←
        </button>
        <div class="ws-drawer__who">
          <div class="ws-drawer__name">{{ actor?.name || "—" }}</div>
          <div v-if="actor?.subtitle" class="ws-drawer__sub">{{ actor.subtitle }}</div>
        </div>
        <span class="ws-spacer" />
        <!-- 情绪：头像与立绘都跟着它走（与聊天里同一张映射表） -->
        <span v-if="actor && !actor.isMe" class="ws-tag">{{ emotionLabel }}</span>
        <span v-if="onStage" class="ws-tag ws-tag--live">{{ t("worldsim.panel.onStage") }}</span>
      </header>

      <div class="ws-drawer__body ws-scroll">
        <!-- ① 立绘 -->
        <section class="ws-sec ws-sec--por">
          <div class="ws-por" :class="{ 'is-loading': pot.loading.value }">
            <img
              v-if="portraitOpen && pot.url.value"
              class="ws-por__img"
              :src="pot.url.value"
              :alt="actor?.name || ''"
              decoding="async"
              @error="onPortraitError"
            />
            <div v-else-if="portraitOpen && pot.loading.value" class="ws-por__state">
              <WsLoading variant="init" size="sm" :text="t('worldsim.panel.portraitLoading')" />
            </div>
            <div v-else-if="portraitOpen" class="ws-por__state">
              <div class="ws-note ws-note--warn">{{ t("worldsim.panel.portraitNone") }}</div>
              <button class="ws-btn" type="button" @click="pot.reload()">
                {{ t("worldsim.retry") }}
              </button>
            </div>
            <!-- 未展开：只显示缩略图（绝不加载那张 73MB 的大图） -->
            <button v-else class="ws-por__thumb" type="button" @click="emit('portrait', true)">
              <img v-if="thumbUrl" :src="thumbUrl" :alt="actor?.name || ''" />
              <span v-else class="ws-por__ph">{{ (actor?.name || "?").slice(0, 1) }}</span>
              <span class="ws-por__hint">{{ t("worldsim.panel.portraitExpand") }}</span>
            </button>
            <button
              v-if="portraitOpen"
              class="ws-por__collapse ws-btn ws-btn--ghost"
              type="button"
              @click="emit('portrait', false)"
            >
              {{ t("worldsim.panel.portraitCollapse") }}
            </button>
          </div>

          <!-- 服装变体：角色目录下若有子目录（泳装/…）就在这里切换；取不到只留「默认」 -->
          <div v-if="clothes.length > 1" class="ws-por__clothes">
            <span class="ws-panel__k">{{ t("worldsim.panel.clothes") }}</span>
            <button
              v-for="c in clothes"
              :key="c"
              class="ws-chip"
              :class="{ 'is-on': c === clothesName }"
              type="button"
              @click="clothesName = c"
            >
              {{ c === "default" ? t("worldsim.panel.clothesDefault") : c }}
            </button>
          </div>
        </section>

        <!-- ② 日程 -->
        <WsCollapse :title="t('worldsim.panel.schedule')" icon="🗓" :count="timeline.length">
          <div v-if="roleSchedule?.now" class="ws-line">
            <span class="ws-panel__k">{{ t("worldsim.panel.scheduleNow") }}</span>
            <span
              >{{ roleSchedule.now.time }}
              {{ roleSchedule.now.content || roleSchedule.now.name }}</span
            >
          </div>
          <div v-if="roleSchedule?.next" class="ws-line">
            <span class="ws-panel__k">{{ t("worldsim.panel.scheduleNext") }}</span>
            <span
              >{{ roleSchedule.next.time }}
              {{ roleSchedule.next.content || roleSchedule.next.name }}</span
            >
          </div>
          <div v-if="timeline.length" class="ws-time">
            <div v-for="(it, i) in timeline" :key="i" class="ws-time__row">
              <span class="ws-time__t">{{ it.time }}</span>
              <span class="ws-time__c">{{ it.content || it.name }}</span>
              <span class="ws-tag">{{ it.kindZh || it.kind }}</span>
            </div>
          </div>
          <div v-else class="ws-empty">{{ t("worldsim.empty.schedule") }}</div>
        </WsCollapse>

        <!-- ③ 位置 -->
        <WsCollapse :title="t('worldsim.panel.location')" icon="📍" :default-open="true">
          <div class="ws-line">
            <span class="ws-panel__k">{{ t("worldsim.panel.area") }}</span>
            <span>{{ areaText || t("worldsim.empty.location") }}</span>
          </div>
          <div class="ws-line">
            <span class="ws-panel__k">{{ t("worldsim.panel.place") }}</span>
            <span>{{ actor?.place || t("worldsim.empty.place") }}</span>
          </div>
          <div class="ws-line">
            <span class="ws-panel__k">{{ t("worldsim.panel.posSource") }}</span>
            <span class="ws-dim">{{ posSourceLabel }}</span>
          </div>
        </WsCollapse>

        <!-- ④ 对话 -->
        <section class="ws-sec">
          <button class="ws-btn ws-btn--primary ws-wide" type="button" @click="goChat">
            💬 {{ t("worldsim.panel.goto") }}
          </button>
          <div class="ws-panel__hint">{{ chatHint }}</div>
        </section>

        <!-- ⑤ P4-4：指挥他 / 干预开关（默认关，开关落 localStorage） -->
        <WsCollapse :title="t('worldsim.cmd.title')" icon="🧭" :default-open="true">
          <div class="ws-cmd">
            <span class="ws-panel__k">{{ t("worldsim.cmd.to") }}</span>
            <input
              v-model="destName"
              class="ws-inp"
              type="text"
              :list="DEST_LIST_ID"
              :placeholder="t('worldsim.cmd.toPlaceholder')"
              :aria-label="t('worldsim.cmd.to')"
              @keyup.enter="sendCommand"
            />
            <datalist :id="DEST_LIST_ID">
              <option v-for="d in dests" :key="d" :value="d" />
            </datalist>
          </div>
          <div class="ws-acts">
            <button
              class="ws-btn ws-btn--primary"
              type="button"
              :disabled="!destName.trim()"
              @click="sendCommand"
            >
              {{ t("worldsim.cmd.go") }}
            </button>
            <button class="ws-btn" type="button" @click="goChat">
              {{ t("worldsim.cmd.viaChat") }}
            </button>
          </div>
          <div class="ws-panel__hint">{{ t("worldsim.cmd.hint") }}</div>

          <label class="ws-switch">
            <input type="checkbox" :checked="interveneOn" @change="onInterveneChange" />
            <span>{{
              interveneOn ? t("worldsim.intervene.on") : t("worldsim.intervene.off")
            }}</span>
          </label>
          <div class="ws-panel__hint">
            {{ interveneOn ? t("worldsim.intervene.dragHint") : t("worldsim.intervene.hint") }}
          </div>
        </WsCollapse>

        <!-- ⑥ 快捷动作（P2-5）
             三个都有落地：
               · 打招呼   → 页面 onQuick('hi') → 复用「去找他聊聊」（跳 /chat，零副作用）
               · 约他出门 → 页面 onQuick('outing') → `world_map_trip_start` 让他动身来找你
               · 送礼物   → 就地打开 `WsGiftSheet`（方案 B：地图商店 → 本机背包 → 送出记账）
             ⚠️ 说明文案不再用 `worldsim.action.hint` —— 那句还写着「送礼物还没定方案」，
                已经不成立了（见 wsGift.ts 顶部的文案口径）。 -->
        <WsCollapse :title="t('worldsim.panel.actions')" icon="⚡" :default-open="true">
          <div class="ws-acts ws-acts--quick">
            <button class="ws-btn" type="button" @click="quick('hi')">
              👋 {{ t("worldsim.action.hi") }}
            </button>
            <!-- 可玩性切片 A：好感是**世界的状态**，不是装饰 —— 送礼会让它涨，面板立刻可见。
                 切片②（2026-10-01）：给这一格加 `data-ws-affinity`（**DOM 契约**，供探针/自动化
                 读数值；App 里不许塞 `window.__*` 调试出口）—— 只有这一个属性，逻辑一行不动。 -->
            <div class="ws-aff" :title="`好感 ${affinity} / 100`" :data-ws-affinity="affinity ?? 0">
              <span class="ws-aff__k">好感</span>
              <span class="ws-aff__v">{{ affinity ?? 0 }}</span>
              <span class="ws-aff__r">{{ affinityRank || "陌生" }}</span>
              <i class="ws-aff__bar"><b :style="{ width: Math.max(0, Math.min(100, affinity ?? 0)) + '%' }" /></i>
            </div>
            <button class="ws-btn" type="button" @click="quick('gift')">
              🎁 {{ t("worldsim.action.gift") }}
            </button>
            <button class="ws-btn" type="button" @click="quick('outing')">
              🚶 {{ t("worldsim.action.outing") }}
            </button>
          </div>
          <div class="ws-panel__hint">{{ gx("actionsHint") }}</div>
        </WsCollapse>
      </div>

      <!-- ⑥.9 送礼物选择器（P2-5）
           弹层挂在抽屉内部：`.ws-drawer` 已有 data-no-gesture 与指针 stop，
           所以这里不会把事件漏给地图手势。真实的扣减/记账在 WsGiftSheet + wsGift.ts 里。 -->
      <WsGiftSheet
        :open="giftOpen"
        :role-name="actor?.name || ''"
        :role-id="actor?.roleId || 0"
        :is-me="!!actor?.isMe"
        :facilities="facilities"
        @close="giftOpen = false"
        @sent="onGiftSent"
      />
    </aside>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import WsCollapse from "./WsCollapse.vue";
  import WsGiftSheet from "./WsGiftSheet.vue";
  import WsLoading from "./WsLoading.vue";
  import { useWsIntervene, facilityNames } from "./wsIntervene";
  import { fillText, GIFT_TEXT } from "./wsGift";
  import { useWsPortrait } from "@/composables/useWsPortrait";
  import { emotionFile, type WsActors } from "@/composables/useWsActors";
  import type { PlacedActor, ActorPosSource } from "./wsActors";
  import { wsToast } from "./wsToast";

  const props = withDefaults(
    defineProps<{
      /** 当前面板对着的人 */
      actor: PlacedActor | null;
      /** 数据层（日程/服装/位置来源都从这儿取） */
      data: WsActors;
      /** 当前行政区文案（「广州市·越秀区」） */
      areaText?: string;
      /** 窄屏（手机）= 全屏 + 遮罩 */
      narrow?: boolean;
      /** 面板是否打开（立绘只在打开时才加载） */
      open?: boolean;
      /** 立绘是否已展开 */
      portraitOpen?: boolean;
      /** 当前正在对话的角色 id（决定「去找他聊聊」是直连还是提醒） */
      currentRoleId?: number;
      /** 好感 0~100（页面从 `wsRelation` 读出来传进来；不传 = 0，面板照旧） */
      affinity?: number;
      /** 好感档位文案（页面用 `rankOf()` 算好传进来，面板不重复实现判据） */
      affinityRank?: string;
    }>(),
    { areaText: "", narrow: false, open: false, portraitOpen: false, currentRoleId: 0 }
  );

  const emit = defineEmits<{
    (e: "close"): void;
    (e: "portrait", v: boolean): void;
    (e: "goto-chat", a: PlacedActor): void;
    (e: "quick", action: string, a: PlacedActor): void;
    /** P2-5：送礼弹层里真的送出了一件（本机已扣减+记账）—— 页面可据此接记忆/事件 */
    (e: "gift", p: { actor: PlacedActor; name: string; icon: string; role: string }): void;
    /** 好感（可玩性切片 A：由页面从 `wsRelation` 读出来传进来；不传 = 0） */
    // 说明：prop 声明在下方 defineProps 里，这里只是事件表的注释锚点
    /** P4-4：下一条「让他去某地」的指令（目的地是地名或设施名） */
    (e: "direct", to: string, a: PlacedActor): void;
  }>();

  const { t, te } = useI18n();

  /* ── 立绘（按需加载 + 关闭释放，全在 useWsPortrait 里）────────────────────── */

  /** 服装：默认那套；用户切换后重取 */
  const clothesName = ref("default");
  const clothes = ref<string[]>(["default"]);

  // 换人 → 服装选择要重置（不然会拿上一个人的「泳装」去取新角色的图）
  watch(
    () => props.actor?.id,
    () => {
      clothesName.value = "default";
      clothes.value = ["default"];
      void loadClothes();
    }
  );

  const pot = useWsPortrait({
    folder: computed(() => props.actor?.folder || ""),
    emotion: computed(() => props.actor?.emotion || ""),
    clothes: clothesName,
    // 红线①：只有「面板打开 + 立绘展开」同时成立才去取图
    open: computed(() => !!props.open && !!props.portraitOpen),
    mapEmotion: emotionFile,
  });

  // 拿到服装变体清单（拿不到就只剩「默认」，不报错）
  async function loadClothes() {
    const folder = props.actor?.folder;
    if (!folder) return;
    try {
      clothes.value = await props.data.clothesVariants(folder);
    } catch {
      clothes.value = ["default"];
    }
  }

  // 某个变体取不到图 → 自动退回「默认」（需求：取不到就只显示默认，不要报错）
  watch(
    () => pot.missingClothes.value,
    (miss) => {
      if (!miss) return;
      clothesName.value = "default";
      wsToast(t("worldsim.panel.clothesMissing"), "warn");
    }
  );

  function onPortraitError() {
    wsToast(t("worldsim.panel.portraitFailed"), "err");
  }

  /** 缩略图：就用地图上那张头像小方图（不碰立绘文件） */
  const thumbUrl = computed(() => props.actor?.avatarUrl || "");

  /* ── ② 日程 ──────────────────────────────────────────────────────────────── */
  const roleSchedule = computed(() =>
    props.actor ? props.data.scheduleOf(props.actor.name) : null
  );
  const timeline = computed(() => roleSchedule.value?.timeline || []);

  /* ── ③ 位置 ──────────────────────────────────────────────────────────────── */
  const posSourceLabel = computed(() => {
    const map: Record<ActorPosSource, string> = {
      runtime: t("worldsim.pos.runtime"),
      schedule: t("worldsim.pos.schedule"),
      scatter: t("worldsim.pos.scatter"),
      me: t("worldsim.pos.me"),
      affinity: t("worldsim.pos.affinity"),
      /* 🆕 2026-09-20：位置是"吸附到真实路网/设施之后"的落点（`wsSnap`）。
         这两档**必须**在这里也有中文名 —— `Record<ActorPosSource, string>` 是**穷尽**映射，
         少一个键 tsc 直接报错（这是好事：加档位时不会漏掉展示它的地方）。
         文案直接内联中文而没走 i18n：`pos.*` 那几条在 zh-CN 词条里，
         而这次改动要尽量小、且**先保证 tsc 0 错**（词条后面统一补，见 CHANGELOG 的"未验"）。 */
      road: "在路上（已吸附路网）",
      facility: "在设施旁（已吸附设施）",
    };
    return map[(props.actor?.posSource || "scatter") as ActorPosSource] || "";
  });

  /* ── ④ 对话 ──────────────────────────────────────────────────────────────── */
  const onStage = computed(
    () =>
      !!props.actor &&
      !props.actor.isMe &&
      props.actor.roleId > 0 &&
      props.actor.roleId === props.currentRoleId
  );
  const chatHint = computed(() =>
    onStage.value ? t("worldsim.panel.gotoNow") : t("worldsim.panel.gotoWarn")
  );
  function goChat() {
    if (!props.actor) return;
    emit("goto-chat", props.actor);
  }

  /* ── ⑤ 快捷动作（P2-5：三个按钮都要有**真**行为或说清楚为什么没有）──────
   *   · 打招呼  → emit('quick','hi')   → 页面里复用「去找他聊聊」那条路（跳 /chat）
   *   · 约他出门 → emit('quick','outing') → 页面里调 world_map_trip_start（角色动身）
   *   · 送礼物  → 就地打开 `WsGiftSheet`（**方案 B**：地图商店 → 本机背包 → 送出记账）；
   *              送出成功后再 emit('gift', …) 给页面，留给主会话接记忆/事件
   *              （前端目前没有"提交自定义事件"的通路，见 wsGift.ts 顶部）。
   * 三个动作的分派点都收在页面的 onQuick 里（一处就能看全，好测也好改）。 */
  const giftOpen = ref(false);

  function quick(action: "hi" | "gift" | "outing") {
    if (!props.actor) return;
    emit("quick", action, props.actor);
    if (action === "gift") giftOpen.value = true;
  }

  /** 送礼弹层里真的送出去了一件 → 转告页面（可选接线：写记忆/触发事件） */
  function onGiftSent(p: { name: string; icon: string; role: string }) {
    if (!props.actor) return;
    emit("gift", { actor: props.actor, name: p.name, icon: p.icon, role: p.role });
  }

  /** runtime 的设施表（送礼弹层据此列出「地图上的商店」；拿不到就只显示空态文案） */
  const facilities = computed(() => props.data.runtime?.value?.facilities ?? null);

  /** 送礼弹层的兜底文案（词条存在用词条，否则用 wsGift.ts 的中文原文 —— 同 schema-i18n 先例） */
  function gx(key: string, params?: Record<string, string | number>): string {
    const k = `worldsim.giftx.${key}`;
    if (te(k)) return params ? t(k, params) : t(k);
    return fillText(GIFT_TEXT[key] || key, params);
  }

  /* ── ⑤.5 P4-4：指挥他 + 干预开关 ──────────────────────────────────────── */
  const DEST_LIST_ID = "ws-dest-list";
  /** 目的地候选：后端 runtime 里的设施表（拿不到就只有一个空建议列表，手输照样能用） */
  const dests = computed(() => facilityNames(props.data.runtime?.value?.facilities));
  const destName = ref("");
  /** 干预开关（模块级单例，与地图页拖拽读的是同一份；默认关） */
  const { on: interveneOn, setOn: setIntervene } = useWsIntervene();

  function onInterveneChange(e: Event) {
    setIntervene(!!(e.target as HTMLInputElement).checked);
  }

  function sendCommand() {
    const to = destName.value.trim();
    if (!props.actor || !to) return;
    emit("direct", to, props.actor);
  }

  const emotionLabel = computed(() => {
    const e = String(props.actor?.emotion || "").trim();
    return e || t("worldsim.emotionNormal");
  });

  const panelTitle = computed(() => props.actor?.name || t("worldsim.panel.title"));
</script>

<style scoped>
  /* 好感条（可玩性切片 A）：细、无边框、主色填充 —— 与 LingChat 的语言一致 */
  .ws-aff {
    display: flex;
    align-items: center;
    gap: 0.4em;
    margin: 0.3em 0 0.5em;
    font-size: 0.9em;
    opacity: 0.95;
  }
  .ws-aff__k { opacity: 0.66; }
  .ws-aff__v { font-weight: 700; font-variant-numeric: tabular-nums; }
  .ws-aff__r {
    padding: 0 0.4em;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    font-size: 0.86em;
  }
  .ws-aff__bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.16);
    overflow: hidden;
  }
  .ws-aff__bar > b {
    display: block;
    height: 100%;
    background: var(--accent-color, #79d9ff);
    transition: width 0.3s cubic-bezier(0, 0, 0, 1);
  }
  .ws-drawer {
    position: absolute;
    inset: 0;
    z-index: 30;
    /* 🔴 2026-10-01：根元素是 `inset:0`（全屏），**它自己不许接事件** ——
       否则面板一开，整屏（含左侧地图）的手势都被这层吃掉（机主：「点开面板后地图滑动不了」）。
       只有遮罩与面板本体 `pointer-events:auto`（见各自规则）。 */
    pointer-events: none;
  }
  .ws-drawer__mask,
  .ws-drawer__panel {
    pointer-events: auto;
  }
  .ws-drawer__mask {
    position: absolute;
    inset: 0;
    background: rgba(20, 30, 32, 0.42);
    /* 🔴 2026-10-01（真机「点了角色直接卡死」的调查结论）：**全屏遮罩上不许有 backdrop-filter**。
       项目自己在 `assets/styles/worldsim.css:198-201` 写过这条规矩：值只要**不是 `none`**，
       浏览器就给这个元素建一层 backdrop 层、**每一帧把底下的像素读回来重合成一次**
       （`blur(0px)` 同样算）。而这一层：① 是全屏（窄屏实测 500×772，真机还要乘 DPR）
       ② 盖在一张**每帧都在重画的 WebGL 地图画布**上 ⇒ 代价最大。
       实测（`~/chk/_freeze_probe.mjs --narrow`，同一台机器）：窄屏有遮罩 rAF 最差 **1025ms**、
       心跳断 **1033ms**、脚本 CPU 0.45s→**1.29s**；宽屏（`narrow=false`、无遮罩）上面这些都没有。
       原来这里用 `blur(var(--ws-blur-low, 1px))`，而 `--ws-blur-low` 只在 `.ws-perf-low` 里定义、
       这一屏又没有 `.ws-root` ⇒ **永远吃 1px 兜底** ⇒ 永远每帧读回。改成显式 `none`。 */
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    animation: ws-fade-in 0.18s ease both;
  }
  /* 宽屏：右侧抽屉（不遮地图，方便边看边点别人） */
  .ws-drawer__panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(24em, 42vw);
    display: flex;
    flex-direction: column;
    background: var(--ws-panel);
    border-left: 1px solid var(--ws-border);
    box-shadow: var(--ws-shadow-lg);
    backdrop-filter: blur(var(--ws-blur));
    -webkit-backdrop-filter: blur(var(--ws-blur));
    animation: ws-slide-in 0.24s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
  /* 窄屏：全屏（盖住地图，避免小手势区里再叠一层可滚动面板） */
  .ws-drawer.is-narrow .ws-drawer__panel {
    width: 100%;
    border-left: 0;
  }
  .ws-drawer__head {
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.6em 0.8em;
    border-bottom: 1px solid var(--ws-border);
  }
  .ws-drawer__who {
    min-width: 0;
  }
  .ws-drawer__name {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-drawer__sub {
    font-size: 0.8em;
    color: var(--ws-fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-drawer__body {
    flex: 1;
    min-height: 0;
    padding: 0.7em 0.8em 1.2em;
    display: flex;
    flex-direction: column;
    gap: 0.7em;
    /* 面板里滚动到底不该带动背后的地图 */
    overscroll-behavior: contain;
  }
  /* 🔴 2026-10-01（机主：「按钮互相遮挡」的**真因**，探针在短视口下量出来）：
     body 是 flex 列，而**子项默认 `flex-shrink:1`** ⇒ 视口一变矮，每个 `.ws-cp`/`.ws-sec`
     就被**压到内容高度以下**；而 `WsCollapse` 的根带 `overflow:hidden` ⇒ 内容被自家裁掉，
     body 的 `scrollHeight` 却**不涨**（实测短视口 500×417：`scrollH 369 = clientH 369`）
     ⇒ **既放不下、又滚不动**：8 个控件排在折线下够不着，标题还压在别行的内容上（视觉顺序错乱）。
     ⇒ 直接子项一律 `flex: none`（保持内容高度）⇒ body 真的溢出 ⇒ 上面 `.ws-scroll` 的
     `overflow-y:auto` 才生效，用户能滚到"送礼物/约他出/干预开关"。
     注：面板本体另有 `.ws-drawer__panel{display:flex;flex-direction:column}`，
     body 自己是 `flex:1; min-height:0`，所以这条不会把面板撑出屏幕。 */
  .ws-drawer__body > * {
    flex: none;
  }
  .ws-sec {
    display: flex;
    flex-direction: column;
    gap: 0.5em;
  }
  .ws-panel__k {
    display: inline-block;
    min-width: 4.2em;
    color: var(--ws-fg-dim);
    font-size: 0.88em;
  }
  .ws-panel__hint {
    font-size: 0.8em;
    color: var(--ws-fg-dim);
    line-height: 1.6;
  }
  .ws-line {
    display: flex;
    gap: 0.4em;
    align-items: baseline;
    font-size: 0.92em;
    line-height: 1.6;
  }
  .ws-dim {
    color: var(--ws-fg-dim);
  }
  .ws-wide {
    width: 100%;
  }

  /* ── 立绘 ─────────────────────────────────────────────────────────────── */
  .ws-sec--por {
    gap: 0.4em;
  }
  .ws-por {
    position: relative;
    min-height: 12em;
    border-radius: var(--ws-radius);
    overflow: hidden;
    background: var(--ws-bg-2);
    border: 1px solid var(--ws-border);
  }
  .ws-por__img {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 62vh;
    object-fit: contain;
  }
  .ws-por__state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6em;
    min-height: 12em;
    padding: 0.8em;
    text-align: center;
  }
  .ws-por__thumb {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5em;
    width: 100%;
    min-height: 12em;
    border: 0;
    background: none;
    color: var(--ws-fg);
    font: inherit;
    cursor: pointer;
  }
  .ws-por__thumb img {
    width: 7.5em;
    height: 7.5em;
    object-fit: cover;
    border-radius: 50%;
    border: 2px solid var(--ws-primary);
  }
  .ws-por__ph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 7.5em;
    height: 7.5em;
    border-radius: 50%;
    font-size: 2em;
    background: var(--ws-primary-soft);
  }
  .ws-por__hint {
    font-size: 0.82em;
    color: var(--ws-fg-dim);
  }
  .ws-por__collapse {
    position: absolute;
    right: 0.5em;
    top: 0.5em;
  }
  .ws-por__clothes {
    display: flex;
    align-items: center;
    gap: 0.35em;
    flex-wrap: wrap;
  }

  /* ── 日程 ─────────────────────────────────────────────────────────────── */
  .ws-time {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    max-height: 12em;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ws-time__row {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    font-size: 0.88em;
    line-height: 1.7;
  }
  .ws-time__t {
    min-width: 3.4em;
    color: var(--ws-fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .ws-time__c {
    flex: 1;
    min-width: 0;
  }

  /* ── 快捷动作 ─────────────────────────────────────────────────────────── */
  .ws-acts {
    display: flex;
    gap: 0.4em;
    flex-wrap: wrap;
  }
  /* P2-5 手感：快捷动作**无边框**（`border: 0`，不是"透明边框" —— 实测透明边框
     的 border-width 仍是 1px，量出来就是"有边框"），默认只有一层主色淡底，
     hover 才浮起来并转主色。 */
  .ws-acts--quick .ws-btn {
    border: 0;
    background: var(--ws-primary-soft);
    font-weight: 600;
  }
  .ws-acts--quick .ws-btn:hover:not(:disabled) {
    color: var(--ws-on-primary);
    background: var(--ws-primary);
    box-shadow: var(--ws-shadow);
  }

  /* ── P4-4：指挥他（目的地输入 + 干预开关）────────────────────────────────── */
  .ws-cmd {
    display: flex;
    align-items: center;
    gap: 0.4em;
  }
  .ws-inp {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.92em;
    color: var(--ws-fg);
    background: var(--ws-panel-2);
    border: 1px solid var(--ws-border);
    border-radius: var(--ws-radius-sm);
    padding: 0.32em 0.5em;
  }
  .ws-inp:focus-visible {
    outline: 2px solid var(--ws-primary);
    outline-offset: 1px;
  }
  /* 干预开关：用原生 checkbox（三套主题下都不会跑版），文字走 i18n */
  .ws-switch {
    display: flex;
    align-items: center;
    gap: 0.4em;
    margin-top: 0.55em;
    font-size: 0.92em;
    cursor: pointer;
  }
  .ws-switch input {
    width: 1.05em;
    height: 1.05em;
    accent-color: var(--ws-primary-deep);
  }

  /* 送礼物弹层的样式已随组件搬进 `WsGiftSheet.vue`（scoped），这里不再重复一份 ——
     两份样式一定会漂移，而且弹层现在要能被手机复用。 */
</style>
