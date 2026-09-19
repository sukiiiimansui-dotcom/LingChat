<!--
  WsPhonePlan.vue —— 手机里的「日程 / 待办」（T5-6）

  ## 卡片要求
  - 「接地图联动」← 本组件做到：每个角色的**当前所在地点**（`now.kindZh`，如「住宅」）
    旁给一个「在地图上找他 ▸」，点了跳 `/worldsim`。**不做假跳转**：真跳路由。
  - 数据全部来自 `/api/schedule`（真壳走 `world_map_schedule`），**不是假数据**。

  ## 一个值得记的发现
  `/api/schedule` 里**已经带了角色清单**（`characters[]`：name / folder / subtitle /
  avatarCount / hasAvatar / info）—— 这正是 T5-5（手机·通讯）卡在"拿不到角色列表"时缺的东西。
  ⚠️ 但注意：这里给的是**元数据**，**头像图片本身**仍要 `get_avatar_file`（真壳命令），
  浏览器通路拿不到 → 所以本组件显示 `avatarCount` 这类可得的真实信息，**不画假头像**。

  ## 空结果如实
  `todos` / `importantDays` 目前返回空数组 → 界面显示「暂无」，**不编内容**。
-->
<template>
  <div class="pl">
    <!-- 现在几点 / 在哪个区域 -->
    <div class="pl__now">
      <span class="pl__clock">{{ data?.now || "--:--" }}</span>
      <span class="pl__area">{{ data?.area || "未指定区域" }}</span>
    </div>

    <!-- 每个角色：此刻在做什么、接下来做什么、在哪 -->
    <div v-for="(r, i) in roles" :key="r.name" class="pl__role" :style="{ '--pl-i': String(Math.min(i, 7)) }">
      <div class="pl__head">
        <span class="pl__nm">{{ r.name }}</span>
        <span class="pl__kind">{{ r.now?.kindZh || "—" }}</span>
      </div>
      <div class="pl__cur">
        <b>{{ r.now?.name || "—" }}</b>
        <span class="pl__t">{{ r.now?.time || "" }}</span>
        <span class="pl__c">{{ r.now?.content || "" }}</span>
      </div>
      <!-- MG 切片 C：占比条改用 `transform: scaleX()`。
           原来动的是 `width`（布局属性）—— 每变一次，卡片里所有东西都要重新排版一次。
           scaleX 只走合成器，视觉一模一样。 -->
      <div v-if="r.progress != null" class="pl__bar">
        <i :style="{ transform: `scaleX(${barOf(r.progress)})` }" />
      </div>
      <div class="pl__next">
        接着 <b>{{ r.next?.name || "—" }}</b>
        <span v-if="r.next?.time"> · {{ r.next.time }}</span>
        <span v-if="r.next?.content" class="pl__c"> · {{ r.next.content }}</span>
      </div>
      <!-- 地图联动：真实路由跳转，不是假按钮 -->
      <button class="pl__go" type="button" @click="goMap">在地图上找他 ▸</button>
    </div>

    <!-- 待办 -->
    <div class="pl__sec">
      <div class="pl__sech">待办</div>
      <ul v-if="todos.length" class="pl__list">
        <li v-for="(t, i) in todos" :key="i">{{ t }}</li>
      </ul>
      <div v-else class="pl__empty">暂无（日程文件里没有待办项）</div>
    </div>

    <!-- 重要日子 -->
    <div class="pl__sec">
      <div class="pl__sech">重要日子</div>
      <ul v-if="days.length" class="pl__list">
        <li v-for="(d, i) in days" :key="i">{{ d }}</li>
      </ul>
      <div v-else class="pl__empty">暂无</div>
    </div>

    <!-- 角色清单（元数据；头像图片需要真壳命令，浏览器拿不到，如实说明） -->
    <div class="pl__sec">
      <div class="pl__sech">角色（{{ chars.length }}）</div>
      <div v-for="c in chars" :key="c.folder" class="pl__char">
        <span class="pl__cnm">{{ c.name }}</span>
        <span class="pl__csub">{{ c.subtitle || "" }}</span>
        <span class="pl__cav">{{ c.hasAvatar ? `${c.avatarCount} 张头像` : "无头像" }}</span>
      </div>
      <div class="pl__note">头像图片需要真壳命令 <code>get_avatar_file</code>，浏览器通路拿不到（T5-5 的同一个阻塞）</div>
    </div>

    <div v-if="err" class="pl__err">{{ err }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref } from "vue";
  import { useRouter } from "vue-router";
  import worldMapApi from "@/api/services/worldMap";

  interface SchRole {
    name?: string;
    now?: { name?: string; time?: string; content?: string; kindZh?: string };
    next?: { name?: string; time?: string; content?: string };
    progress?: number;
  }
  interface SchChar {
    name?: string;
    folder?: string;
    subtitle?: string;
    avatarCount?: number;
    hasAvatar?: boolean;
  }
  interface SchData {
    now?: string;
    area?: string;
    roles?: SchRole[];
    characters?: SchChar[];
    todos?: unknown[];
    importantDays?: unknown[];
  }

  const router = useRouter();
  const data = ref<SchData | null>(null);
  const err = ref("");
  const roles = computed<SchRole[]>(() => data.value?.roles || []);
  const chars = computed<SchChar[]>(() => data.value?.characters || []);
  /** 把"可能是字符串、也可能是对象"的列表项统一成一行文本（模板里对 unknown 取属性会报 TS18046） */
  function fmtItem(x: unknown, keys: string[]): string {
    if (typeof x === "string") return x;
    const o = (x || {}) as Record<string, unknown>;
    const parts = keys.map((k) => String(o[k] ?? "").trim()).filter(Boolean);
    return parts.join(" ") || JSON.stringify(x);
  }
  const todos = computed<string[]>(() => (data.value?.todos || []).map((t) => fmtItem(t, ["text", "title"])));
  const days = computed<string[]>(() => (data.value?.importantDays || []).map((d) => fmtItem(d, ["date", "name", "title"])));

  /** 把进度夹到 0~1（`scaleX` 只认比例；越界会让条子长出格子外面） */
  function barOf(p: unknown): string {
    const n = Number(p);
    if (!Number.isFinite(n)) return "0";
    return String(Math.min(1, Math.max(0, n)));
  }

  /** 地图联动：跳真实路由（`/worldsim` 是世界模拟页的实际 path） */
  function goMap() {
    void router.push("/worldsim");
  }

  void (async () => {
    try {
      const d = (await worldMapApi.schedule()) as unknown as SchData & { ok?: boolean };
      if ((d as { ok?: boolean })?.ok === false) throw new Error("日程接口返回失败");
      data.value = d;
    } catch (e) {
      err.value = `日程取不到：${e instanceof Error ? e.message : e}`;
    }
  })();
</script>

<style scoped>
  .pl { display: flex; flex-direction: column; gap: 8px; color: #fff; font-size: 12px; }
  .pl__now { display: flex; align-items: baseline; gap: 8px; }
  .pl__clock { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
  .pl__area { font-size: 11px; color: rgba(255,255,255,.5); }

  .pl__role {
    display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 12px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
  }
  .pl__head { display: flex; align-items: center; justify-content: space-between; }
  .pl__nm { font-size: 13px; font-weight: 600; }
  .pl__kind { font-size: 10.5px; color: #35d39a; background: rgba(53,211,154,.14); padding: 1px 7px; border-radius: 7px; }
  .pl__cur { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .pl__t { font-size: 10.5px; color: rgba(255,255,255,.45); }
  .pl__c { font-size: 11px; color: rgba(255,255,255,.6); }
  .pl__bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; }
  .pl__bar i {
    display: block; height: 100%; background: #35d39a;
    /* transform-origin 必须是 0 50%：默认在中心，条子会从中间往两边长（反的） */
    transform-origin: 0 50%;
    /* 「生长」用 0.32s 的缓出：数据是异步来的，直接从 0 跳到 60% 看不出"它涨了" */
    transition: transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .pl__next { font-size: 11px; color: rgba(255,255,255,.7); }
  .pl__go {
    margin-top: 2px; height: 30px; border: 1px solid rgba(53,211,154,.45); border-radius: 10px;
    background: rgba(53,211,154,.12); color: #35d39a; font-size: 11.5px; cursor: pointer;
  }
  .pl__go:hover { background: rgba(53,211,154,.2); }

  .pl__sec { display: flex; flex-direction: column; gap: 3px; }
  .pl__sech { font-size: 11px; color: rgba(255,255,255,.45); }
  .pl__list { margin: 0; padding-left: 16px; font-size: 11.5px; line-height: 1.7; color: rgba(255,255,255,.8); }
  .pl__empty { font-size: 11px; color: rgba(255,255,255,.35); }

  .pl__char { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: baseline; font-size: 11.5px; }
  .pl__cnm { color: rgba(255,255,255,.88); }
  .pl__csub { color: rgba(255,255,255,.45); font-size: 10.5px; }
  .pl__cav { color: rgba(255,255,255,.5); font-size: 10.5px; }
  .pl__note { font-size: 10px; color: rgba(255,215,120,.72); line-height: 1.5; }
  .pl__err { font-size: 11.5px; color: #ffb4b4; line-height: 1.5; }

  /* ── MG 切片 C：角色卡**依次**浮现（错峰 45ms）───────────────────────────
     日程是异步来的：数据一到，几张卡一起"啪"地出现，很像页面刷新。
     错峰之后读起来是"一个个角色被点亮"，同时给人一点时间看清顺序。
     只动 opacity/transform；超过 7 张不再累加延迟。 */
  .pl__role {
    animation: pl-role-in 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(var(--pl-i, 0) * 45ms);
  }
  @keyframes pl-role-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  /* 降级：低端机 / 系统关了动画 → 卡片直接出现（信息一点不少） */
  .ws-root.ws-perf-low .pl__role { animation: none; }
  .ws-root.ws-perf-low .pl__bar i { transition: none; }
  @media (prefers-reduced-motion: reduce) {
    .pl__role { animation: none; }
    .pl__bar i { transition: none; }
  }
</style>
