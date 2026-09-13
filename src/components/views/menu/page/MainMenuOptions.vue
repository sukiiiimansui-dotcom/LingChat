<template>
  <StartList responsive>
    <StartLine>
      <StartItem @click="() => emit('start-game')">{{ $t("views.menu.startGame") }}</StartItem>
    </StartLine>
    <StartLine>
      <StartItem @click="() => emit('open-settings', 'save')">{{
        $t("views.menu.continueGame")
      }}</StartItem>
    </StartLine>
    <StartLine :mobile="false">
      <StartItem @click="() => emit('open-workshop')">{{
        $t("views.menu.scriptEditor")
      }}</StartItem>
    </StartLine>
    <!-- 「世界模拟」主线入口：选国家 → 省 → 市 → 区县 → 小区，落到一张可交互的街区图。
         文案走 i18n（官方那条线这里是硬编码中文，提 PR 会被挑，我们的新入口从一开始就进 locales）。 -->
    <StartLine>
      <StartItem @click="() => emit('open-world')">{{ $t("worldsim.entry") }}</StartItem>
    </StartLine>
    <StartLine>
      <StartItem @click="() => emit('open-settings')">{{ $t("views.menu.gameConfig") }}</StartItem>
    </StartLine>
    <StartLine>
      <StartItem @click="() => emit('open-credits')">{{ $t("views.menu.credits") }}</StartItem>
    </StartLine>
    <StartLine>
      <StartItem @click="exitGame">{{ $t("views.menu.exitGame") }}</StartItem>
    </StartLine>
  </StartList>
</template>

<script setup lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { useDialogStore } from "@/stores/modules/ui/dialog"; // 保留 Current
  import { StartItem, StartLine, StartList } from "../base"; // 保留 Incoming

  const emit = defineEmits<{
    (e: "start-game"): void;
    (e: "open-settings", tab?: string): void;
    (e: "open-credits"): void;
    (e: "open-workshop"): void;
    (e: "open-world"): void;
  }>();

  // 保留 Current 的退出逻辑
  async function exitGame() {
    const dialogStore = useDialogStore();
    const ok = await dialogStore.confirm("确定要退出游戏吗？", "退出确认");
    if (ok) {
      invoke("exit_app");
    }
  }
</script>
