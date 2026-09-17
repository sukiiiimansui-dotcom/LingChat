<!--
  WsPhoneChat.vue —— 手机里的「通讯」（T5-5）· **方案 B：可验证的入口骨架**

  ## 为什么是"骨架"而不是完整实现
  卡片四条要求全部落在**真壳 Tauri 命令**上（`get_avatar_file` / `list_saves` / `load_save` /
  对话与语音管线）。浏览器预览里 web-mock 对非 `world_map_*` 命令返回 `undefined`
  → **那四条一条都验不了**。机主选定 **B**：先做**能验证的入口骨架**，
  **发送/呼叫/切会话一律如实提示"未接入"**，等 T6-4 与真壳能力齐了再把提示换成真调用。

  ## 哪些是**真的**（浏览器可验）
  - **联系人列表**：`/api/schedule` 的 `characters[]` —— 真实角色（name / subtitle / info /
    头像张数），不是假数据。这条通路在浏览器里是通的。
  - **跳转到对话页**：`router.push("/chat")` —— **真实路由跳转**。

  ## 哪些是**如实标注为未接入**（不假装）
  - **头像图片**：需要 `get_avatar_file`（真壳命令）→ 这里用**首字母圆形占位**，
    并在标题里写明「头像需真壳命令」。**不画假头像、不伪造角色图**。
  - **发消息 / 呼叫**：需要接 LingChat 的对话管线 → 点击只给**明确提示**，
    绝不显示"已发送"这种假状态。
  - **切到该角色的会话**：需要 `gameStore` 的 load_save 通路 → 只跳对话页，**不谎称已切人**。
-->
<template>
  <div class="ch">
    <div class="ch__tip">
      方案 B：**联系人真实**（来自日程接口的角色清单）；
      <b>头像 / 发送 / 呼叫 / 切人**需要真壳命令，尚未接入**</b>——点它们会如实提示，不会假装成功。
    </div>

    <div v-for="c in chars" :key="c.folder" class="ch__row">
      <!-- 头像位：首字母占位（真头像要 get_avatar_file，浏览器拿不到） -->
      <div class="ch__av" :title="`头像需真壳命令 get_avatar_file（该角色有 ${c.avatarCount || 0} 张）`">
        {{ (c.name || "?").slice(0, 1) }}
      </div>
      <div class="ch__info">
        <div class="ch__nm">{{ c.name }}</div>
        <div class="ch__sub">{{ c.subtitle || "" }}</div>
        <div v-if="c.info" class="ch__bio">{{ c.info }}</div>
      </div>
      <div class="ch__ops">
        <button class="ch__btn" type="button" @click="jump">去对话 ▸</button>
        <button class="ch__btn ch__btn--ghost" type="button" @click="notWired('发消息')">发消息</button>
      </div>
    </div>

    <div v-if="!chars.length && !err" class="ch__empty">联系人列表还没回来…</div>
    <div v-if="note" class="ch__note">{{ note }}</div>
    <div v-if="err" class="ch__err">{{ err }}</div>

    <!-- 电话：做成"呼叫角色"的入口，但**如实说明触发的是真壳能力** -->
    <button class="ch__call" type="button" @click="notWired('呼叫角色（语音）')">📞 呼叫角色</button>
  </div>
</template>

<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter } from "vue-router";
  import worldMapApi from "@/api/services/worldMap";
  import { wsToast } from "@/components/views/worldsim/wsToast";

  interface SchChar {
    name?: string;
    folder?: string;
    subtitle?: string;
    avatarCount?: number;
    hasAvatar?: boolean;
    info?: string;
  }

  const router = useRouter();
  const chars = ref<SchChar[]>([]);
  const err = ref("");
  const note = ref("");

  /** 未接入的能力：一律**明确提示**，绝不显示"已发送/已接通"这种假状态 */
  function notWired(what: string) {
    note.value = `${what}需要接入 LingChat 的${
      what.includes("呼叫") ? "语音/对话管线" : "对话管线"
    }（真壳命令），**当前未接入** —— 已记为 T5-5 的后续项，不假装成功。`;
    try {
      wsToast(`${what}：需要真壳命令，尚未接入`, "warn");
    } catch {
      /* toast 不可用也不影响提示（面板里已经写了） */
    }
  }

  /** 真实路由跳转（这条是真的） */
  function jump() {
    note.value = "已跳到对话页；**切换到该角色的会话**需要 gameStore 的 load_save 通路（真壳），尚未接入。";
    void router.push("/chat");
  }

  void (async () => {
    try {
      const d = (await worldMapApi.schedule()) as unknown as { characters?: SchChar[] };
      chars.value = d?.characters || [];
      if (!chars.value.length) note.value = "日程接口没有返回角色清单。";
    } catch (e) {
      err.value = `联系人取不到：${e instanceof Error ? e.message : e}`;
    }
  })();
</script>

<style scoped>
  .ch { display: flex; flex-direction: column; gap: 8px; color: #fff; font-size: 12px; }
  .ch__tip {
    font-size: 10.5px; line-height: 1.6; color: rgba(255,215,120,.8);
    padding: 7px 9px; border-radius: 10px; background: rgba(255,215,120,.08);
    border: 1px solid rgba(255,215,120,.2);
  }
  .ch__row {
    display: grid; grid-template-columns: 34px 1fr; gap: 8px; align-items: start;
    padding: 8px 10px; border-radius: 12px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
  }
  .ch__av {
    width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center;
    background: rgba(53,211,154,.16); color: #35d39a; font-weight: 700; font-size: 15px;
  }
  .ch__info { min-width: 0; }
  .ch__nm { font-size: 13px; font-weight: 600; }
  .ch__sub { font-size: 10.5px; color: rgba(255,255,255,.5); }
  .ch__bio {
    font-size: 10.5px; color: rgba(255,255,255,.55); line-height: 1.5; margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .ch__ops { grid-column: 2; display: flex; gap: 6px; margin-top: 4px; }
  .ch__btn {
    height: 28px; padding: 0 10px; border: 0; border-radius: 9px; cursor: pointer;
    background: #35d39a; color: #06231a; font-size: 11.5px; font-weight: 700;
  }
  .ch__btn--ghost { background: rgba(255,255,255,.1); color: rgba(255,255,255,.8); font-weight: 500; }
  .ch__btn--ghost:hover { background: rgba(255,255,255,.16); }
  .ch__call {
    height: 38px; border: 1px solid rgba(255,255,255,.16); border-radius: 12px;
    background: transparent; color: rgba(255,255,255,.8); font-size: 12.5px; cursor: pointer;
  }
  .ch__empty, .ch__note { font-size: 11px; line-height: 1.6; color: rgba(255,255,255,.6); }
  .ch__err { font-size: 11.5px; color: #ffb4b4; line-height: 1.5; }
</style>
