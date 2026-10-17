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
         入口在本页 + 主菜单顶层各有一个（2026-09-16 看过 wsenter 原型后保留了两处）。 -->
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
import { useI18n } from "vue-i18n";
import { useGameStore } from "@/stores/modules/game";
import { useDialogStore } from "@/stores/modules/ui/dialog";
import { stopScript } from "@/api/services/script-info";
import { eventQueue } from "@/core/events/event-queue";

const emit = defineEmits<{
  (e: "back"): void;
  (e: "open-scripts"): void;
  (e: "open-world"): void;
}>();

const router = useRouter();
const { t } = useI18n();
const gameStore = useGameStore();
const dialogStore = useDialogStore();

/**
 * 剧本在跑时必须真的把引擎停掉，不能只清前端标记——
 * 否则它会一直阻塞在输入通道上，那段羁绊在本次进程内永远停在「进行中」，
 * 其他剧本也会被互斥守卫挡在门外（issue #700）。
 */
const startFreeDialogue = async () => {
  if (gameStore.runningScript) {
    const confirmed = await dialogStore.confirm(t("views.menu.leaveStoryConfirm"));
    if (!confirmed) return;
    try {
      await stopScript();
    } catch (error) {
      console.error("中止剧本失败:", error);
    }
    // 剧本停了，它还没播完的事件也就成了旧会话残留，一并丢弃（issue #796 同款处理）
    eventQueue.clear();
    eventQueue.resume();
  }
  gameStore.exitStoryMode();
  router.push("/chat");
};
</script>
