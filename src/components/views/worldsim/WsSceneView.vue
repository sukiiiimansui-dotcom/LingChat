<!--
  WsSceneView.vue —— App 的「世界模拟 · 小区级」= **代拍页 `public/ws3dshow.html` 那一屏**（2026-09-24）

  ## 机主的原话与这一刀的范围
  「**将 App 页的所有全部重做，把没有的全部去掉**」+「**全部删完，然后暂时只在上面构建代拍页的内容**」。
  ⇒ 本轮**只挂这一屏**：地图本体（外观/相机/层序都来自 `wsScene` + `wsMapTheme` 那套真源）
     + **交通设施**（代拍页 `?tf=1` 的内容）。
     其余叠加（头像层/天气/时间/窗光/事件/行程卡/车辆/小地图/等高线/区界/AI 示意层/AI 精绘卡/天气 pill/±全区按钮）
     在 `WorldSim.vue` 里**停挂但保留**（一步一 commit，随时可 `git revert` 切回）。
     台账见 `~/rikka/Dsh-SYuki/world_map/REMOVED-CODE.md`。

  ## 它为什么是"薄壳"
  机主的纪律：**不许复制第二份逻辑**。所以这里**一行渲染逻辑都没有**：
    · 地图本体 → 直接渲染 `WsDistrictMapLibre.vue`（它已经是"代拍页那条外观真源 + wsScene 相机/层序"）；
    · props → **原样透传**（`area/adcode/pitch/markers/night/locSource/worldTime/…`）；
    · 交通设施 → 调 `wsTransportLayer`（同一份规则/样式/生成逻辑，与代拍页共用，**不是第二份**）。
  ⚠️ 所以改观感请去 `wsMapTheme` / `wsScene` / `wsTransportRules`，**不要改这里**。

  ## 两个"眼睛"必须留着（机主硬要求）
  `?wsverify=1` 验证面板与 `?selfshot=1` 自拍都长在 `WsDistrictMapLibre` 内部 ⇒
  只要这里**照常渲染它**，两个入口就都还在（实测地址：`…/webdev.html?wsverify=1`、`?selfshot=1`）。

  ## 没做什么（如实写，别当成"做好了"）
  · 等高线 / 区界 / AI 示意层仍然由 `WsDistrictMapLibre` 自己挂（它们是那一屏的一部分，
    本轮**没有**开关；要停挂得改那个组件，不在这里假装关掉）；
  · `±/全区` 按钮同理仍在该组件里（见 `WorldSim.vue` 顶部那一段说明）。
-->
<template>
  <div class="ws-sceneview">
    <!-- 地图本体：外观/相机/层序/验证面板/自拍全在 `WsDistrictMapLibre` 里（**只调它，不复制**） -->
    <WsDistrictMapLibre
      :area="area"
      :adcode="adcode"
      :radius="radius"
      :pitch="pitch"
      :markers="markers"
      :night="night"
      :loc-source="locSource"
      :world-time="worldTime"
      @scene-ready="onSceneReady"
    />

    <!-- 🚌 交通设施那一行（代拍页 `?tf=1` 的 HUD 位置）。
         **只读诊断**：显示 `wsTransport.transportHudLine()` 的原文（含「示意，非事实」与各计数）。
         没有设施（或还没算出来）时**不占地方**；层序自愈/路网缺失也如实写出来，绝不静默。
         ⚠️ 新入口传 `:tf="false"` ⇒ 这一行连同整条交通设施接线一起不出现（见下面 `tf` 的说明）。 -->
    <div v-if="tf && (layerNote || tfHud)" class="ws-sceneview__tf">
      <span v-if="tfHud">{{ tfHud }}</span>
      <span v-if="layerNote" class="is-warn">{{ layerNote }}</span>
    </div>

    <!-- 底部两个动作（与 `WsDistrict` 那一屏**同一组按钮、同一套类名**）：
         机主要"进这个世界"的入口不能因为重做而消失。
         ⚠️ 类名复用，但样式**必须在本文件里重写一份** —— `WsDistrict.vue` 是 `<style scoped>`，
         那些 `.ws-dist__*` 规则不会作用到本组件（见下面 style 块里的说明）。

         🆕 2026-09-26（App 入口替换）：`chrome` 开关（**默认 true ⇒ 老路径逐字不变**）。
         为什么需要它：机主拍板「/worldsim **直接进 3D 地图**，去掉多余按钮」，而这条底栏里
         「← 回到区县」在没有"区县"这一级的新入口里是**死按钮**、「小区」这个级别标签也不再成立
         ⇒ 新入口（`WsCityEntry.vue`）传 `:chrome="false"` 只隐藏这条底栏，
         **交通设施接线/地图本体一行都不动**（那些还是这一份，不是第二份）。 -->
    <div v-if="chrome" class="ws-dist__foot">
      <div class="ws-dist__area">
        <span class="ws-dist__pin" aria-hidden="true">🏘</span>
        <span class="ws-dist__name">{{ area || "未知区域" }}</span>
        <span class="ws-tag">小区</span>
      </div>
      <div class="ws-dist__ops2">
        <button class="ws-btn ws-btn--ghost" type="button" @click="emit('back')">← 回到区县</button>
        <button class="ws-btn" type="button" @click="emit('done')">进入这个世界</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref } from "vue";
  import WsDistrictMapLibre from "./WsDistrictMapLibre.vue";
  import type { WsDistrictPin } from "./wsActors";
  import {
    drawTransport,
    buildTransportFor,
    executeLayerOps,
    type TfBuildingsFc,
    type TfMapLike,
    type TfRoadsFc,
  } from "./wsTransportLayer";
  import { planEnsureRoadOrder } from "./wsLayerOrder";
  import worldMapApi from "@/api/services/worldMap";
  import { useWsPerf } from "./wsPerf";

  const props = withDefaults(
    defineProps<{
      /** 区域名（如"重庆市·渝中区"）—— 只透传，地图用 */
      area?: string;
      /** 用户确认过的区县 adcode —— **必须透传**（取楼/取区界的唯一正确来源，见组件内注释） */
      adcode?: string;
      /** 取楼半径（米） */
      radius?: number;
      /** 初始倾角（度） */
      pitch?: number;
      /** 地图上的人（示意位置；本轮**保留**透传，是否显示由机主验收决定） */
      markers?: WsDistrictPin[];
      /** 天黑程度 0..1（由 `WorldSim` 一路传下来） */
      night?: number;
      /** 定位来源（gps/ip/manual/restored）—— 验证面板要显示 */
      locSource?: string;
      /** 世界时间（如 `23:41`）—— 验证面板要显示 */
      worldTime?: string;
      /**
       * 底栏开关（**默认 true**）。
       *
       * 🆕 2026-09-26（App 入口替换）：新入口 `WsCityEntry.vue` 直接进 3D 地图、没有"区县"上一级，
       * 底栏里的「← 回到区县」会是死按钮 ⇒ 它传 `false`。
       * 默认 `true` 是刻意的：老调用点（`WorldSim.vue` 的引导主线）**一个字都不用改**，
       * 行为与本改动前逐字相同。
       */
      chrome?: boolean;
      /**
       * 交通设施开关（**默认 true**）。
       *
       * 🔴 2026-09-26（App 入口替换，父代理裁定）：新入口默认**不要**交通设施 ——
       * 原因是这条接线里有一次真请求 `worldMapApi.roads()`（`/api/roads`，半径 600），
       * 而真机上这条路"冷查分钟级、必超时"（机主报的"路时有时无"旧病根），
       * 且代拍页默认（不带 `?tf=1`）也没有这一层 ⇒ 新入口要**默认 0 条 `/api/*`**。
       *
       * ⚠️ 用 prop 分流而不是"新入口直接渲染 `WsDistrictMapLibre`"：
       * 后者会让新老两条路各有一份宿主接线（第二份实现，PR 门禁 C1 要防的正是这个）。
       * 默认 `true` ⇒ 老调用点（`WorldSim.vue` 的引导主线）**逐字不变**。
       */
      tf?: boolean;
    }>(),
    { area: "", adcode: "", radius: 600, pitch: 38, markers: () => [], night: 0, locSource: "", worldTime: "", chrome: true, tf: true }
  );

  const emit = defineEmits<{ (e: "back"): void; (e: "done"): void }>();

  /** 交通设施的 HUD 原文（来自 `transportHudLine`，**不改写**） */
  const tfHud = ref("");
  /** 层序自愈/路网缺失这类"必须说出来"的话（空串 = 没话说） */
  const layerNote = ref("");

  const perf = useWsPerf();
  /** 路网只取一次就留着（代拍页也是这个节奏）；`moveend` 重画时不再打后端 */
  let roads: TfRoadsFc | null = null;
  let roadsTried = false;
  /** 层序自愈累计（如实显示，不显示就等于没做） */
  let heals = 0;
  /** 已经挂上的地图（来自 `WsDistrictMapLibre` 的 `scene-ready`） */
  let scene: (TfMapLike & { moveLayer?(id: string, before?: string): void }) | null = null;
  /** 楼栋（交通设施的停车场/出入口要按楼脚印算）—— 由地图组件在"楼到齐"时交给我们 */
  let buildings: TfBuildingsFc | null = null;

  /** 取一次路网（中心用地图当前中心；半径与地图的取数口径一致，交给后端默认即可） */
  async function loadRoadsOnce(m: TfMapLike): Promise<void> {
    if (roadsTried) return;
    roadsTried = true;
    try {
      const c = m.getCenter();
      const fc = await worldMapApi.roads({ lat: c.lat, lng: c.lng, r: props.radius });
      roads = (fc as unknown as TfRoadsFc) || null;
    } catch {
      /* 取不到就如实说（下面 HUD 里写"路网缺失"），**不编点位** */
      roads = null;
    }
  }

  /**
   * 地图就绪 / 每次视野变化 → 重画交通设施。
   *
   * 为什么"每次 moveend 重画"：设施是按**当前中心**的米平面算出来的（代拍页同款），
   * 视野一变，同一个点在地图上的位置就不该还停在旧中心上。
   * 代价可控：纯函数 + 最多几十个点（低档只画两类），比一次 Overpass 便宜几个数量级。
   */
  async function refreshTransport(): Promise<void> {
    const m = scene;
    if (!m) return;
    if (!roads) await loadRoadsOnce(m);
    const c = m.getCenter();
    const res = buildTransportFor(roads, buildings, [c.lng, c.lat], !!perf.low.value);
    /* 插在楼体之前（`bld-ext`）⇒ 设施在楼之下、路网之上（层序计划 `wsScene` 就是这么定的） */
    const before = m.getLayer("bld-ext") ? "bld-ext" : undefined;
    const out = drawTransport(m, res, before);
    if (out.drawn) tfHud.value = out.hud;
    /* 🛣 层序**事后断言**（代拍页 2026-09-22 真机回归的解药）：路网被交通设施/楼体压住就移回。
       这里只执行 `move`；`add-roads`（路网整个缺失）**只计数**——取数是上面那个组件的职责，
       越权重取会把 Overpass 打第二遍（它下一次视野变化会自己补）。 */
    try {
      const ops = planEnsureRoadOrder({
        hasSource: (id) => !!m.getSource(id),
        hasLayer: (id) => !!m.getLayer(id),
        layerIds: () =>
          ((m as unknown as { getStyle?: () => { layers?: Array<{ id: string }> } }).getStyle?.()?.layers || []).map(
            (l) => l.id
          ),
      });
      const done = executeLayerOps(m, ops);
      heals += done.moved;
      if (done.needRoads) layerNote.value = "路网缺失：等下一次视野变化自动补（取数归地图组件，不在这里重取）";
      else if (heals) layerNote.value = `层序自愈 ${heals} 次（路网曾被压在设施/楼体之上）`;
    } catch {
      /* 断言失败不影响地图（它只是"顺序保险"） */
    }
  }

  /**
   * `WsDistrictMapLibre` 的 `scene-ready`：地图与楼栋都到位了 ⇒ 接交通设施。
   *
   * ⚠️ 入参形状**照抄那个组件的 emit 声明**（`{ map: unknown; buildings: { features?: unknown[] } | null }`）
   * —— 不在这里另写一份类型：两份形状描述迟早漂移（`BldFeature` 只在那个模块里定义）。
   */
  function onSceneReady(p: { map: unknown; buildings: { features?: unknown[] } | null }): void {
    /* 🚫 `tf=false`（新入口的默认）：**在这里就退**——不挂监听、不取路网、不画设施。
       放在最前面是有意的：这条接线的第一件事就是 `worldMapApi.roads()`，
       晚一步退就等于还是发了那条请求。 */
    if (!props.tf) return;
    buildings = (p?.buildings as TfBuildingsFc) || null;
    const m = p?.map as (TfMapLike & { on?(ev: string, cb: () => void): void }) | null;
    if (!m) return;
    /* 只在第一次挂监听（重挂地图时旧监听随旧实例一起消失） */
    if (m !== scene) {
      m.on?.("moveend", () => void refreshTransport());
    }
    scene = m;
    void refreshTransport();
  }
</script>

<style scoped>
  /* 薄壳自己不画地图：尺寸交给 `WsDistrictMapLibre` 的宿主样式（`.ws-dml` 铺满父容器） */
  .ws-sceneview {
    position: absolute;
    inset: 0;
  }

  /* 交通设施 HUD：与代拍页同一个位置感（左下角），**只读诊断**，不参与任何渲染逻辑 */
  .ws-sceneview__tf {
    position: absolute;
    left: 8px;
    bottom: 44px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 62vw;
    padding: 4px 8px;
    border-radius: 10px;
    background: rgba(7, 11, 17, 0.62);
    color: #eaf6ff;
    font-size: 11px;
    line-height: 1.5;
    pointer-events: none;
  }
  .ws-sceneview__tf .is-warn {
    color: #ffcf8a;
  }

  /* ── 底部两个动作（复刻 `WsDistrict.vue` 里 `.ws-dist__*` 那一组）──
     ⚠️ 为什么**必须在这里再写一份**：`WsDistrict.vue` 的样式是 `<style scoped>`，
     只作用于那个组件自己的元素 —— 换到本组件后那些类名**一个样式都吃不到**
     （第一版我直接复用了类名 ⇒ 底栏会变成"贴着顶部的一行字"，而且会挡住地图顶部）。
     口径照抄（间距/换行/省略号都一样），但**位置改成浮在地图下沿**（这一屏是整屏地图）。 */
  .ws-sceneview .ws-dist__foot {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6em;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-radius: var(--ws-radius, 12px);
    background: rgba(7, 11, 17, 0.62);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #eaf6ff;
  }
  .ws-sceneview .ws-dist__area {
    display: flex;
    align-items: center;
    gap: 0.4em;
    min-width: 0;
  }
  .ws-sceneview .ws-dist__pin {
    font-size: 1.1em;
  }
  .ws-sceneview .ws-dist__name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ws-sceneview .ws-dist__ops2 {
    display: flex;
    gap: 0.5em;
  }
</style>
