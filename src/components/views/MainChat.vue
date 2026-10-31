<template>
  <div class="main-box">
    <!-- 主界面始终渲染，加载动画期间在后台初始化 -->
    <FreeModeTools />
    <!-- 悬浮手机**不在这里**：2026-09-18 明确「手机是仅在地图里的功能」，
         所以它挂在 `/worldsim`（见 WsCityEntry.vue）。聊天页保持干净。 -->
    <div class="main-status-panel">
      <div class="main-status-row">
        <StatusInfoBar />
      </div>
      <FullAccessWarning />
    </div>
    <GameBackground></GameBackground>
    <!-- <GameAvatar ref="gameAvatarRef" @audio-ended="handleAudioFinished" />  -->
    <GameRolesStage
      ref="gameAvatarRef"
      @audio-ended="handleAudioFinished"
      @audio-started="handleAudioStarted"
    />
    <GameDialog
      ref="gameDialogRef"
      :relation-ready="relationReady"
      @player-continued="manualTriggerContinue"
    />

    <RelationGuardModal
      :visible="relationModalVisible"
      :roles="blockedRoleList"
      :me-name="meName"
      @close="closeRelationModal"
      @goto-edit="gotoRelationEdit"
    />

    <!-- 菜单按钮 -->
    <div id="menu-panel" ref="menuPanelRef">
      <ToolActivityStatus v-if="!(gameStore.runningScript && gameStore.runningScript.isRunning)" />
      <Button
        type="nav"
        icon="play"
        @click="switchAutoMode"
        :active="uiStore.autoMode"
        v-show="uiStore.showSettings !== true"
      >
        <h3 class="hidden xl:block">{{ $t("views.mainChat.auto") }}</h3>
      </Button>
      <!-- 桌宠模式依赖 Windows 透明置顶窗口，移动端不可用 -->
      <Button
        v-if="!isMobile()"
        type="nav"
        icon="character"
        @click="goToPetMode"
        v-show="uiStore.showSettings !== true"
      >
        <h3 class="hidden xl:block">{{ $t("views.mainChat.pet") }}</h3>
      </Button>
      <Button type="nav" icon="text" @click="openSettings" v-show="uiStore.showSettings !== true">
        <h3 class="hidden xl:block">{{ $t("views.mainChat.menu") }}</h3>
      </Button>
    </div>
    <GameExtraUI />

    <!-- Android 拍照 / 相册来源选择 sheet，仅 chat 路由可见 -->
    <ImageSourcePicker />

    <!-- 首次加载过渡动画 -->
    <LoadingTransition v-if="showLoading" @complete="onLoadingComplete" />
  </div>
</template>

<script setup lang="ts">
import { getEnvConfigByKey } from "@/api/services/config";
import { wsToast } from "@/components/views/worldsim/wsToast";
import FreeModeTools from "@/components/tools/FreeModeTools.vue";
import StatusInfoBar from "@/components/tools/StatusInfoBar.vue";
import ToolActivityStatus from "@/components/tools/ToolActivityStatus.vue";
import { eventQueue } from "@/core/events/event-queue";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGameStore } from "../../stores/modules/game";
import { useUIStore } from "../../stores/modules/ui/ui";
import { Button } from "../base";
import { GameBackground, GameDialog, GameRolesStage } from "../game/standard";
import LoadingTransition from "./LoadingTransition.vue";

import FullAccessWarning from "@/components/tools/FullAccessWarning.vue";
import ImageSourcePicker from "@/components/ui/ImageSourcePicker.vue";
import RelationGuardModal from "@/components/ui/RelationGuardModal.vue";
import { isMobile, isWindows } from "@/utils/platform";
import { useAutoAdvance } from "@/composables/chat/useAutoAdvance";
import { useRelationGuard } from "@/composables/chat/useRelationGuard";
import GameExtraUI from "../game/standard/GameExtraUI.vue";

/* T5-1 的 8 个应用位：T5-2~T5-8 各自接进来之前，**如实提示"还没接"**，不假装能用。
   用项目里已有的 wsToast（世界模拟那套轻提示），不新造 API。
   后来手机入口整体搬到地图页（`d5b0a9bb`），这里只留标签表与回调。 */
const PHONE_APP_LABEL: Record<string, string> = {
  map: "地图/导航（T5-2）",
  taxi: "打车（T5-3）",
  transit: "公交地铁（T5-4）",
  chat: "通讯（T5-5）",
  plan: "日程待办（T5-6）",
  weather: "天气（T5-7）",
  music: "音乐（T5-8）",
  me: "我的",
};
function onPhoneApp(key: string) {
  wsToast(`${PHONE_APP_LABEL[key] || key} 还没接进来`, "info");
}

const LOADING_STORAGE_KEY = "lingchat_loading_shown";

let loadingShownThisSession = false;

const router = useRouter();
const uiStore = useUIStore();
const gameStore = useGameStore();

// 首次加载过渡状态：仅当本次 session 未播放过且 localStorage 未标记时播放
const showLoading = ref(!loadingShownThisSession && !localStorage.getItem(LOADING_STORAGE_KEY));

function onLoadingComplete() {
  loadingShownThisSession = true;
  showLoading.value = false;
  localStorage.setItem(LOADING_STORAGE_KEY, "1");
  // 加载动画结束，恢复事件队列消费
  eventQueue.resume();
  gameStore.setLoadingComplete(true);
}

getEnvConfigByKey("display.disable_splash_animation")
  .then((setting) => {
    if (setting.value === "true" && showLoading.value) {
      onLoadingComplete();
    }
  })
  .catch(() => {
    // 读取失败（键不存在等）按默认行为播放开屏动画
  });

const goToPetMode = () => {
  router.push("/pet");
};

const gameDialogRef = ref<InstanceType<typeof GameDialog> | null>(null);
const menuPanelRef = ref<HTMLElement | null>(null);

const openSettings = async () => {
  gameStore.captureScreenshot();
  if (isWindows()) {
    (async () => {
      try {
        uiStore.toggleSettings(true);
        uiStore.setSettingsTab("text");
      } catch (e) {
        console.warn("[MainChat] settings snapshot failed:", e);
        // 失败也需打开设置，避免阻塞
        uiStore.toggleSettings(true);
        uiStore.setSettingsTab("text");
      } finally {
      }
    })();
    return;
  }
  uiStore.toggleSettings(true);
  uiStore.setSettingsTab("text");
};

const runInitialization = async () => {
  try {
    await gameStore.initializeGame();
  } catch (error) {
    console.error("[MainChat] 初始化游戏失败:", error);
    uiStore.showWarning({ title: "初始化失败", message: "请尝试重新进入自由对话" });
  }
};

// 关系就绪门：未就绪时禁用输入框、输入区上方提示条 + 引导模态
const {
  ready: relationReady,
  missingSide: relationMissingSide,
  blockedRoleId,
  blockedRoles,
  modalVisible: relationModalVisible,
  refresh: refreshRelationReady,
  closeModal: closeRelationModal,
} = useRelationGuard();

const blockedRoleList = computed(() =>
  blockedRoles.value.map((item) => ({
    name: gameStore.getGameRole(item.roleId)?.roleName || uiStore.showCharacterTitle,
    missingSide: item.missingSide,
  })),
);

const meName = computed(() => gameStore.userName || "我");

watch(
  [() => gameStore.mainRoleId, () => gameStore.playerIdentityId],
  ([roleId]) => void refreshRelationReady(roleId),
  { immediate: true },
);

// 关闭设置后重新判定：用户很可能刚去补关系
watch(
  () => uiStore.showSettings,
  (open) => {
    if (!open) void refreshRelationReady(gameStore.mainRoleId);
  },
);

// 「去填写」：记录待处理意图（缺哪一侧），打开设置并定位到角色列表页
const gotoRelationEdit = () => {
  const roleId = blockedRoleId.value;
  if (roleId && roleId > 0) {
    const kind = relationMissingSide.value === "identity" ? "identity" : "role";
    uiStore.setPendingRelationGuide({ kind, roleId });
  }
  closeRelationModal();
  uiStore.toggleSettings(true);
  uiStore.setSettingsTab("character");
};

// 初始化游戏信息
onMounted(() => {
  if (!showLoading.value) {
    eventQueue.resume();
  }
  if (!gameStore.initialized) {
    runInitialization();
  }
});

const {
  onAudioStarted: handleAudioStarted,
  onAudioFinished: handleAudioFinished,
  manualTriggerContinue,
  toggleAutoMode: switchAutoMode,
} = useAutoAdvance({
  dialog: () => gameDialogRef.value,
  mergeEnabled: true,
});
</script>

<style>
.main-box {
  position: absolute;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  overflow: hidden;
}

.main-status-panel {
  position: fixed;
  top: calc(15px + var(--safe-area-inset-top));
  left: 50%;
  z-index: 1001;
  display: flex;
  width: min(44rem, calc(100vw - 2rem));
  transform: translateX(-50%);
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.main-status-row {
  display: flex;
  /* 窄屏隐藏时间、天气时，仍为两侧导航按钮保留第一行。 */
  min-height: 48px;
  align-items: center;
  justify-content: center;
}

#menu-panel {
  display: flex;
  position: fixed;
  top: calc(15px + var(--safe-area-inset-top));
  right: 20px;
  z-index: 1000;
}
</style>
