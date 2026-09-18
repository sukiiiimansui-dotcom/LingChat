<!--
  WsGiftSheet.vue —— P2-5「送礼物」的选择器（**方案 B 走物品栏**的最保守落地）

  ## 为什么单独做成一个组件（而不是继续塞在 WsCharPanel 里）
  原来那张"方案还没定"的说明层是写在 `WsCharPanel.vue` 里的死文案。现在它要
  ① 读模块级单例的背包与账本、② 列出地图上的商店、③ 真的扣减与记账 ——
  再塞在角色面板里，"角色面板"就同时背了背包与商店两件事；而且手机（T5-5）之后
  也要同一个入口。所以抽出来：`WsGiftSheet` 只认 props（角色名 + 设施表）。

  ## 哪些是真的（浏览器可验）
  - **背包**：`localStorage["wsm:v1:gifts"]`，`useWsGifts()` 模块级单例，刷新还在；
  - **商店清单**：来自 `runtime.facilities`（地图上真实的设施表，只认商业/休闲两类店）；
  - **获取 / 送出**：纯函数 `addItem` / `sendGift` 真扣真加，送出后「最近送出」立刻可见。

  ## 哪些**明确写着未接入**（绝不假装成功）
  - 货币系统（机主还没定 ⇒ 这一版是"商店里直接获得"）
  - 后端物品表 / 背包接口
  - 写进角色记忆 / 触发现实事件（前端没有这条通路，见 `wsGift.ts` 顶部说明）
-->
<template>
  <div
    v-if="open"
    class="ws-giftsheet"
    data-no-gesture
    @pointerdown.stop
    @pointermove.stop
    @click.self="emit('close')"
  >
    <div class="ws-giftsheet__card ws-card">
      <div class="ws-giftsheet__head">
        <span class="ws-giftsheet__ico" aria-hidden="true">🎁</span>
        <span class="ws-giftsheet__t">{{ gx("title") }}</span>
        <span class="ws-giftsheet__who">{{ roleName || "—" }}</span>
        <span class="ws-spacer" />
        <button class="ws-btn ws-btn--ghost" type="button" @click="emit('close')">
          {{ gx("close") }}
        </button>
      </div>

      <p class="ws-giftsheet__lead">{{ gx("lead") }}</p>

      <!-- ① 背包 -->
      <div class="ws-giftsheet__sec">
        <span>{{ gx("bag") }}</span>
        <span class="ws-tag">{{ kinds }} 种 / {{ total }} 件</span>
      </div>
      <div v-if="items.length" class="ws-giftlist">
        <div v-for="it in items" :key="it.id" class="ws-giftlist__row">
          <span class="ws-giftlist__ico" aria-hidden="true">{{ it.icon }}</span>
          <span class="ws-giftlist__n">{{ it.name }}</span>
          <span class="ws-giftlist__c">×{{ it.count }}</span>
          <span v-if="it.from" class="ws-giftlist__from">{{ it.from }}</span>
          <button
            class="ws-gift__act"
            type="button"
            :disabled="!canSend"
            :title="canSend ? gx('send') : gx('me')"
            @click="onSend(it)"
          >
            {{ gx("send") }}
          </button>
        </div>
      </div>
      <div v-else class="ws-empty">{{ gx("bagEmpty") }}</div>

      <!-- ② 地图上的商店（来源） -->
      <div class="ws-giftsheet__sec">
        <span>{{ gx("shops") }}</span>
        <span v-if="shops.length" class="ws-tag">{{ shops.length }}</span>
      </div>
      <div v-if="shops.length" class="ws-shoplist">
        <div v-for="s in shops" :key="s.key" class="ws-shoplist__row">
          <span class="ws-shoplist__ico" aria-hidden="true">🛒</span>
          <span class="ws-shoplist__n">{{ s.place }}</span>
          <span class="ws-shoplist__g">{{ s.gift.icon }} {{ s.gift.name }}</span>
          <button class="ws-gift__act" type="button" @click="onGet(s)">{{ gx("get") }}</button>
        </div>
      </div>
      <div v-else class="ws-empty">{{ gx("shopsEmpty") }}</div>

      <!-- ③ 最近送出（本机账本） -->
      <div class="ws-giftsheet__sec">
        <span>{{ gx("history") }}</span>
        <span v-if="sentTotal" class="ws-tag">{{ sentTotal }}</span>
      </div>
      <div v-if="recent.length" class="ws-sentlist">
        <div v-for="(r, i) in recent" :key="`${r.role}-${r.name}-${i}`" class="ws-sentlist__row">
          <span aria-hidden="true">{{ r.icon }}</span>
          <span class="ws-sentlist__n">{{ r.name }}</span>
          <span class="ws-sentlist__a">→ {{ r.role }}</span>
          <span class="ws-sentlist__t">{{ clockText(r.at) }}</span>
        </div>
      </div>
      <div v-else class="ws-empty">{{ gx("historyEmpty") }}</div>

      <p class="ws-giftsheet__note">{{ gx("notWired") }}</p>
      <p v-if="isMe" class="ws-giftsheet__note">{{ gx("me") }}</p>
      <p v-else-if="!roleId" class="ws-giftsheet__note">{{ gx("noRoleId") }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed } from "vue";
  import { useI18n } from "vue-i18n";
  import {
    clockText,
    fillText,
    GIFT_KIND_MAX,
    GIFT_SENT_SHOW,
    GIFT_TEXT,
    shopList,
    useWsGifts,
    type WsGiftItem,
    type WsGiftShop,
  } from "./wsGift";
  import { wsToast } from "./wsToast";

  const props = withDefaults(
    defineProps<{
      /** 是否展开 */
      open?: boolean;
      /** 收礼的角色名（送出的记账就用它） */
      roleName?: string;
      /** 角色的角色库 ID（0 = 没有 → 将来接记忆也写不进去，面板里如实提示） */
      roleId?: number;
      /** 面板对着的是玩家自己（= 不能送） */
      isMe?: boolean;
      /** runtime 的设施表（`runtime.facilities`，原样传进来；解析在 wsGift 里）
       *  ⚠️ 故意**不给默认值**：`unknown` 类型 + `withDefaults` 的默认值会让 vue-tsc 报
       *  「null 不能赋给函数类型」（unknown 含函数签名）。缺省时它就是 undefined，
       *  而 `shopList(undefined)` 本来就会退化成空清单 —— 行为一样，类型干净。 */
      facilities?: unknown;
    }>(),
    { open: false, roleName: "", roleId: 0, isMe: false }
  );

  const emit = defineEmits<{
    (e: "close"): void;
    /** 真的送出去了一件（扣减 + 记账都已完成）—— 页面可以据此接记忆/事件 */
    (e: "sent", p: { name: string; icon: string; role: string }): void;
  }>();

  const { t, te } = useI18n();

  /**
   * 文案：**词条存在就用词条，不存在回落 `GIFT_TEXT` 的中文原文**。
   * 与 `locales/schema-i18n.ts` 同一套先例（未翻译语言自动显示中文）；
   * 好处是本轮不必去改共享的 `locales/*.ts`（三个代理并行，那是冲突高发区）。
   */
  function gx(key: string, params?: Record<string, string | number>): string {
    const k = `worldsim.giftx.${key}`;
    if (te(k)) return params ? t(k, params) : t(k);
    return fillText(GIFT_TEXT[key] || key, params);
  }

  const { items, sent, obtain, send } = useWsGifts();

  const shops = computed(() => shopList(props.facilities));
  const recent = computed(() => sent.value.slice(0, GIFT_SENT_SHOW));
  const sentTotal = computed(() => sent.value.length);
  const kinds = computed(() => items.value.length);
  const total = computed(() => items.value.reduce((n, x) => n + x.count, 0));
  const canSend = computed(() => !props.isMe && !!String(props.roleName || "").trim());

  /** 从地图上的商店拿一件（**不花钱**：货币系统还没定，见文件头） */
  function onGet(s: WsGiftShop) {
    const r = obtain(s.gift, s.place);
    if (r.ok && r.item) {
      wsToast(fillText(GIFT_TEXT.gotOne, { icon: r.item.icon, name: r.item.name }), "ok");
      return;
    }
    wsToast(fillText(GIFT_TEXT.bagFull, { n: GIFT_KIND_MAX }), "warn");
  }

  /** 送出：扣一件 + 本机记账 + toast；**不谎称写进了记忆** */
  function onSend(it: WsGiftItem) {
    if (!canSend.value) {
      wsToast(gx("sentNoRole"), "warn");
      return;
    }
    const r = send(props.roleName, it.id);
    if (r.ok && r.sent) {
      wsToast(
        fillText(GIFT_TEXT.sentOk, { icon: r.sent.icon, name: r.sent.name, role: r.sent.role }),
        "ok"
      );
      emit("sent", { name: r.sent.name, icon: r.sent.icon, role: r.sent.role });
      return;
    }
    wsToast(r.reason === "empty" ? gx("sentEmpty") : gx("sentNoRole"), "warn");
  }
</script>

<style scoped>
  .ws-giftsheet {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.8em;
    background: rgba(20, 30, 32, 0.42);
    animation: ws-fade-in 0.16s ease both;
  }
  .ws-giftsheet__card {
    width: min(24em, 100%);
    max-height: 88%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.9em 1em 1em;
    animation: ws-fade-up 0.2s ease both;
  }
  .ws-giftsheet__head {
    display: flex;
    align-items: center;
    gap: 0.4em;
  }
  .ws-giftsheet__ico {
    font-size: 1.1em;
  }
  .ws-giftsheet__t {
    font-weight: 700;
  }
  .ws-giftsheet__who {
    font-size: 0.9em;
    color: var(--ws-fg-dim);
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-giftsheet__lead {
    margin: 0.55em 0 0.7em;
    font-size: 0.88em;
    line-height: 1.65;
    color: var(--ws-fg);
  }
  .ws-giftsheet__sec {
    display: flex;
    align-items: center;
    gap: 0.4em;
    margin: 0.6em 0 0.35em;
    font-size: 0.9em;
    font-weight: 600;
  }
  .ws-giftsheet__note {
    margin: 0.6em 0 0;
    font-size: 0.78em;
    line-height: 1.6;
    color: var(--ws-fg-dim);
  }

  /* 列表行：**无边框**的整行按钮感（hover 才浮起来），点了一定有反馈 */
  .ws-giftlist,
  .ws-shoplist,
  .ws-sentlist {
    display: flex;
    flex-direction: column;
    gap: 0.22em;
  }
  .ws-giftlist__row,
  .ws-shoplist__row {
    display: flex;
    align-items: center;
    gap: 0.45em;
    padding: 0.26em 0.4em;
    border-radius: var(--ws-radius-sm);
    font-size: 0.9em;
    transition: background-color 0.16s ease;
  }
  .ws-giftlist__row:hover,
  .ws-shoplist__row:hover {
    background: var(--ws-primary-soft);
  }
  .ws-giftlist__ico,
  .ws-shoplist__ico {
    flex: 0 0 auto;
  }
  .ws-giftlist__n,
  .ws-shoplist__n {
    font-weight: 600;
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-giftlist__c {
    color: var(--ws-fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .ws-giftlist__from,
  .ws-shoplist__g {
    flex: 1;
    min-width: 0;
    color: var(--ws-fg-dim);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-shoplist__g {
    flex: 1;
  }
  /* 行内动作：无边框胶囊，hover 变主色（P2-5 的手感要求） */
  .ws-gift__act {
    flex: 0 0 auto;
    padding: 0.24em 0.7em;
    font: inherit;
    font-size: 0.86em;
    font-weight: 600;
    color: var(--ws-primary-deep);
    background: var(--ws-primary-soft);
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition:
      background-color 0.16s ease,
      color 0.16s ease,
      transform 0.16s ease;
  }
  .ws-gift__act:hover:not(:disabled) {
    color: var(--ws-on-primary);
    background: var(--ws-primary);
    transform: translateY(-1px);
  }
  .ws-gift__act:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .ws-sentlist__row {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    font-size: 0.86em;
    color: var(--ws-fg);
  }
  .ws-sentlist__a {
    color: var(--ws-fg-dim);
  }
  .ws-sentlist__t {
    margin-left: auto;
    color: var(--ws-fg-dim);
    font-variant-numeric: tabular-nums;
  }
</style>
