<template>
  <StartList>
    <StartLine>
      <StartItem class="menu-subitem" @click="startFreeDialogue">{{
        $t("views.menu.freeDialogue")
      }}</StartItem>
    </StartLine>

    <StartLine>
      <StartItem class="menu-subitem" disabled="true">{{ $t("views.menu.storyMode") }}</StartItem>
    </StartLine>

    <StartLine>
      <StartItem class="menu-subitem" disabled="true">{{ $t("views.menu.miniGame") }}</StartItem>
    </StartLine>

    <!-- 第 4 项：世界模拟。插在「返回」之前，与上面三项同属"玩法模式"，层级一致。
         入口在本页 + 主菜单顶层各有一个（机主 2026-09-16 看过 wsenter 原型后保留了两处）。 -->
    <StartLine>
      <StartItem class="menu-subitem" @click="emit('open-world')">{{
        $t("views.menu.worldSim")
      }}</StartItem>
    </StartLine>

    <StartLine>
      <StartItem class="menu-subitem" @click="emit('back')">{{ $t("views.menu.back") }}</StartItem>
    </StartLine>
  </StartList>
</template>

<script setup lang="ts">
import { StartItem, StartLine, StartList } from "../base";
import { useRouter } from "vue-router";
import { useGameStore } from "@/stores/modules/game";

const emit = defineEmits<{
  (e: "back"): void;
  (e: "open-scripts"): void;
  (e: "open-world"): void;
}>();

const router = useRouter();
const gameStore = useGameStore();

const startFreeDialogue = () => {
  gameStore.exitStoryMode();
  router.push("/chat");
};
</script>
