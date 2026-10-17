<!--
  WsSceneView.vue —— App 的「世界模拟 · 小区级」= **代拍页 `public/ws3dshow.html` 那一屏**（2026-09-24）

  ## 原话与这一刀的范围
  「**将 App 页的所有全部重做，把没有的全部去掉**」+「**全部删完，然后暂时只在上面构建代拍页的内容**」。
  ⇒ 本轮**只挂这一屏**：地图本体（外观/相机/层序都来自 `wsScene` + `wsMapTheme` 那套真源）
     + **交通设施**（代拍页 `?tf=1` 的内容）。
     其余叠加（头像层/天气/时间/窗光/事件/行程卡/车辆/小地图/等高线/区界/AI 示意层/AI 精绘卡/天气 pill/±全区按钮）
     在 旧入口（WorldSim.vue，已删除）里**停挂但保留**（一步一 commit，随时可 `git revert` 切回）。
     台账见 本仓外的脚本。

  ## 它为什么是"薄壳"
  纪律：**不许复制第二份逻辑**。所以这里**一行渲染逻辑都没有**：
    · 地图本体 → 直接渲染 `WsDistrictMapLibre.vue`（它已经是"代拍页那条外观真源 + wsScene 相机/层序"）；
    · props → **原样透传**（`area/adcode/pitch/markers/night/locSource/worldTime/…`）；
    · 交通设施 → 调 `wsTransportLayer`（同一份规则/样式/生成逻辑，与代拍页共用，**不是第二份**）。
  所以改观感请去 `wsMapTheme` / `wsScene` / `wsTransportRules`，**不要改这里**。

  ## 两个"眼睛"必须留着（用户硬要求）
  `?wsverify=1` 验证面板与 `?selfshot=1` 自拍都长在 `WsDistrictMapLibre` 内部 ⇒
  只要这里**照常渲染它**，两个入口就都还在（实测地址：`…/webdev.html?wsverify=1`、`?selfshot=1`）。

  ## 没做什么（如实写，别当成"做好了"）
  · 等高线 / 区界 / AI 示意层仍然由 `WsDistrictMapLibre` 自己挂（它们是那一屏的一部分，
    本轮**没有**开关；要停挂得改那个组件，不在这里假装关掉）；
  · `±/全区` 按钮同理仍在该组件里（见 旧入口（WorldSim.vue，已删除）顶部那一段说明）。
-->
<template>
  <div ref="rootEl" class="ws-sceneview">
    <!-- 地图本体：外观/相机/层序/验证面板/自拍全在 `WsDistrictMapLibre` 里（**只调它，不复制**）。
         2026-10-07（双引擎并列 ：外面多了一层 `v-if` —— `rendererLive === "map"` 时才是它。
         切到 3D 时它**整个被卸载**（`map.remove()` ⇒ WebGL 上下文当场释放），
         这就是"任何时刻最多一个后端在渲染"那条硬要求的实现方式（见下面 3D 宿主那一段）。 -->
    <WsDistrictMapLibre
      v-if="showMap || showOverlay"
      :area="area"
      :adcode="adcode"
      :radius="radius"
      :pitch="pitch"
      :markers="markers"
      :night="night"
      :loc-source="locSource"
      :world-time="worldTime"
      :joy="joy"
      @scene-ready="onSceneReady"
      @pick-actor="emit('pick-actor', $event)"
    />

    <!-- 🧊 叠加层宿主（`rendererLive === "overlay"`）：地图**照常在下层画**，这里只放一块
         `pointer-events:none` 的透明画布（`wsOverlayBackend` 挂进来）——
         输入全归地图，相机每帧从地图读（见 PLAN-OVERLAY-BACKEND.md）。 -->
    <div v-if="showOverlay" ref="overlayHost" class="ws-sceneview__overlay"></div>

    <!-- 3D 宿主机（`rendererLive === "three"`）：与上面那块地图**互斥**（地图会被卸载），
         three 的画布由 `wsThreeBackend` 挂进来（`init(host, …)`）。 -->
    <div v-if="showThree" ref="threeHost" class="ws-sceneview__three"></div>

    <!-- 失败即回退那句话（§4.5）：3D 起不来时必须**看得见原因**，
         且已经自动回到地图 —— 不许白屏、也不许静默退回。用户点掉它就消失。 -->
    <div v-if="rendererFallback" class="ws-sceneview__note" role="status">
      <span class="ws-sceneview__note-txt">{{ rendererFallback }}</span>
      <button class="ws-sceneview__note-x" type="button" @click="clearFallback">知道了</button>
    </div>

    <!-- 交通设施那一行（代拍页 `?tf=1` 的 HUD 位置）。
         **只读诊断**：显示 `wsTransport.transportHudLine()` 的原文（含「示意，非事实」与各计数）。
         没有设施（或还没算出来）时**不占地方**；层序自愈/裁剪/输入缺失也如实写出来，绝不静默。
         默认（入口不传 `?tf=1`）这一行连同整条交通设施接线一起不出现（见下面 `tf` 的说明）。
         `tfMs` 是**最近一轮的计算耗时**：判断"开交通设施会不会卡"就看这一格（探针也读它）。 -->
    <div v-if="tf && (layerNote || tfHud || tfMs)" class="ws-sceneview__tf">
      <span v-if="tfHud">{{ tfHud }}</span>
      <span v-if="tfMs">构建 {{ tfMs }} ms</span>
      <span v-if="layerNote" class="is-warn">{{ layerNote }}</span>
    </div>

    <!-- 底部两个动作（与 `WsDistrict` 那一屏**同一组按钮、同一套类名**）：
         需要"进这个世界"的入口不能因为重做而消失。
         类名复用，但样式**必须在本文件里重写一份** —— 旧小区页（WsDistrict.vue，已删除）是 `<style scoped>`，
         那些 `.ws-dist__*` 规则不会作用到本组件（见下面 style 块里的说明）。

         2026-09-26（App 入口替换）：`chrome` 开关（**默认 true ⇒ 老路径逐字不变**）。
         为什么需要它：/worldsim **直接进 3D 地图**，去掉多余按钮，而这条底栏里
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

    <!-- toast：`wsToast` 只是往**模块级队列**里推，得有人渲染才看得见。
         实测（无头浏览器探针）：新入口原来没挂这个渲染处 ⇒ 点「音乐」「我的」
         面板行为是对的（不换页），但**页面上一个字都不出现** = 不可接受的"点了没反应"。
         2026-10-10 删掉悬浮手机（右下角那颗）⇒ 这里**去掉那个开关、无条件渲染**：
         本组件现在只有 `WsCityEntry.vue` 一个宿主（老入口 WorldSim.vue 已删除）⇒
         不存在"两边各渲染一份弹两条"的风险；送礼那条"好感 +6"的反馈就靠它。 -->
    <!-- 《悬浮手机》2026-10-10 已按产品决定删除：`WsPhone.vue` 的挂载点、`phone` 开关、
         `onPhoneApp()` 与 `wsPhoneApps` 的 import 都已摘除（见 `ws_phone_selftest.mjs` 的负向判据）。
         `worldmap/WsPhone*.vue` 本体**不动**（那是老 `/world` 页的活）。 -->
    <WsToasts />
  </div>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import WsDistrictMapLibre from "./WsDistrictMapLibre.vue";
  import type { WsDistrictPin } from "./wsActors";
/* 只借**类型**（「我的家」的取名点形状）—— 规则在共享真源 `wsDaily.ts`，这里不实现 */
  import type { PlacePoint } from "./wsDaily";
  import {
    drawTransport,
    buildTransportFor,
    executeLayerOps,
    type TfBuildingsFc,
    type TfMapLike,
    type TfRoadsFc,
  } from "./wsTransportLayer";
  import { planEnsureRoadOrder } from "./wsLayerOrder";
  /* 交通设施接线的**纯策略**（裁剪 / 调度 / 插入点 / 视野 key）—— 本组件只接线，判据全在那个文件里
     （所以 `world_map/ws_tf_policy_selftest.mjs` 能在 node 里逐条钉住它们）。 */
  import {
    TF_CLIP_RADIUS_M,
    TF_LIVE_TIMEOUT_MS,
    clipBuildingsFor,
    clipRoadsFor,
    tfBeforeIdOf,
    tfKeyOf,
    tfScheduleOf,
    type TfGeoFcLike,
  } from "./wsTfPolicy";
  import worldMapApi from "@/api/services/worldMap";
  import { useWsPerf } from "./wsPerf";
  import { wsToast } from "./wsToast";
  /* toast 队列的渲染处（收成组件：**新入口也要弹同一条提示**，见模板里那段注释）。 */
  import WsToasts from "./WsToasts.vue";
  /* 双引擎并列（2026-10-07 · ：契约 + 两个后端。**两个实现只在这里注册一次** ——
     舞台是唯一同时知道两边的那个地方（见文件末尾"双引擎舞台"那一段）。 */
  import { createMapBackend } from "./wsMapBackend";
  import { createOverlayBackend } from "./wsOverlayBackend";
  import { createThreeBackend } from "./wsThreeBackend";
  import {
    clearFallback,
    contractActors,
    contractTheme,
    createRenderBackend,
    noteSwitch,
    registerRenderBackend,
    rendererFallback,
    rendererLastError,
    rendererLive,
    rendererPref,
    setLiveBackend,
    setMapBackendRef,
    type WsRenderBackend,
    type WsRenderBackendId,
    type WsRenderState,
  } from "./wsRenderBackend";

  registerRenderBackend("map", () => createMapBackend({ themeNow: () => contractTheme.value }));
  registerRenderBackend("three", () => createThreeBackend());
  /* 地图之上那一层（透明画布 + 每帧跟地图读相机 + 楼）—— 这是 chip 上的"3D" */
  registerRenderBackend("overlay", () => createOverlayBackend());

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
      /** 地图上的人（示意位置；本轮**保留**透传，是否显示由用户验收决定） */
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
       * 2026-09-26（App 入口替换）：新入口 `WsCityEntry.vue` 直接进 3D 地图、没有"区县"上一级，
       * 底栏里的「← 回到区县」会是死按钮 ⇒ 它传 `false`。
       * 默认 `true` 是刻意的：老调用点（旧入口（WorldSim.vue，已删除）的引导主线）**一个字都不用改**，
       * 行为与本改动前逐字相同。
       */
      chrome?: boolean;
      /**
       * 交通设施开关（**默认 true** —— 老调用点逐字不变；新入口 `WsCityEntry.vue` 显式传
       * `?tf=1` 才开，**默认关**）。
       *
       * 2026-10-17（S1 切片）：这条接线原来有两个坑，现在都不在了：
       *   ① 路网不再现场打 `/api/roads` —— 默认读**地图自己已经落图**的 `roads` source
       *      （离线包，冷查是分钟级）；只有 `tfLive`（`?live=1`）才走 API，且**带 3s 超时**；
       *   ② 不再"每条 moveend 都算" —— 去抖 800ms + 最小间隔 1200ms + 同视野 key 不重算
       *      （摇杆期间每帧一轮 moveend，会被合成一整轮；判据在 `wsTfPolicy.tfScheduleOf`）。
       */
      tf?: boolean;
      /**
       * 交通设施**现场取数**（`?live=1`）—— 默认 `false`。
       *
       * 默认路径 = 离线：路网/楼栋都从**地图上的 source** 读（`roads` / `bld`），一条网络请求都不发。
       * 打开它才允许问 `/api/roads`（补新区域/调试用），且**超时 3s**、失败原因写进 HUD。
       * 入口解析 URL（与 `?joy` 同一个地方），本组件不自己读 URL（薄壳不许有第二份判据）。
       */
      tfLive?: boolean;
      /* 2026-10-10 删掉悬浮手机 ⇒ 原来的 `phone?: boolean` 开关**整体移除**：
         prop、默认值、挂载点、`onPhoneApp()` 与 `wsPhoneApps` 的 import 一起摘；
         `WsToasts` 改成无条件渲染（本组件现在只有 `WsCityEntry.vue` 一个宿主）。
         `worldmap/WsPhone*.vue` 本体不动（老 `/world` 页仍在用）。 */
      /**
       * 摇杆 + 近景（角色第一视角）开关（**默认 false**，2026-10-03 已定）。
       *
       * 为什么默认 **false**：近景是一套**新的操作与观感**（镜头中心 = 「我」的漫游位置、`pitch` 64），
       * 只有新入口 `/worldsim` 显式打开；老调用点（旧入口（WorldSim.vue，已删除）的引导主线）与代拍页
       * **一个字都不用改**、行为逐字不变。
       * 开关的解析（`?joy=0`）在入口那一层（`wsJoystick.joyOnFromLocation`，唯一定义处），
       * 本组件只**原样透传** —— 薄壳不许有第二份判据（PR 门禁 C1）。
       */
      joy?: boolean;
    }>(),
    { area: "", adcode: "", radius: 600, pitch: 38, markers: () => [], night: 0, locSource: "", worldTime: "", chrome: true, tf: true, tfLive: false, joy: false }
  );

  /**
   * （2026-10-01）· `pick-actor`：地图上点了某个人（钉子 id）。
   *
   * 本组件是**薄壳**：只做**原样透传**（`@pick-actor="emit('pick-actor', $event)"`），
   * 不加任何逻辑 —— 开面板/好感/送礼全在宿主 `WsCityEntry.vue`，面板本体在 `WsCharPanel.vue`
   * （PR 门禁 C1：谁都不许在这里再写一份）。
   */
  const emit = defineEmits<{
    (e: "back"): void;
    (e: "done"): void;
    (e: "pick-actor", id: string): void;
    /**
     * **（2026-10-01）·「我的家 + 今日三件事」那条路**：新增事件，`back`/`done` 一个字没动。
     *
     * 为什么必须**新开一条**而不是复用 `scene-ready`：本组件的 `onSceneReady` 在**最前面**就有
     * `if (!props.tf) return;`（那条早退是刻意的 —— 交通设施接线第一件事就是一条 `/api/roads`），
     * 而新入口 `WsCityEntry.vue` 传的正是 `:tf="false"` ⇒ 把三件事挂在那个 handler 的**后半段**
     * 会**永远收不到、也不报错**（表现只是"HUD 一直空着"）。所以本组件在早退**之前**分流一条：
     * `emit("daily-ready", …)`（见 `onSceneReady` 的第一行），`tf` 是真是假都照发。
     * 旧入口（WorldSim.vue，已删除）不监听这个事件 ⇒ 对它零影响。
     */
    (e: "daily-ready", p: { map: unknown; places?: () => readonly PlacePoint[] }): void;
  }>();

  /** 交通设施的 HUD 原文（来自 `transportHudLine`，**不改写**） */
  const tfHud = ref("");
  /** 层序自愈/裁剪/输入缺失这类"必须说出来"的话（空串 = 没话说） */
  const layerNote = ref("");
  /** 最近一次真正计算的耗时（ms；0 = 还没算过）—— 屏幕上的可数判据（探针直接读这一格） */
  const tfMs = ref(0);

  const perf = useWsPerf();
  /** 已经挂上的地图（来自 `WsDistrictMapLibre` 的 `scene-ready`） */
  let scene: (TfMapLike & { moveLayer?(id: string, before?: string): void }) | null = null;
  /** 上一轮用的视野 key（同 key 不重算；见 `wsTfPolicy.tfKeyOf`） */
  let tfKey = "";
  /** 最近一次 moveend/sourcedata 的时刻（去抖基准） */
  let tfLastEventAt = 0;
  /** 最近一次**算完**的时刻（最小间隔基准） */
  let tfLastBuiltAt = 0;
  /** 正在算（防重入；调度器见到它会"等这轮结束"） */
  let tfBusy = false;
  let tfTimer = 0;
  /** 层序自愈累计（如实显示，不显示就等于没做） */
  let heals = 0;
  /** 这一轮的输入为什么是空的（要写进 HUD；不猜） */
  let tfInputWhy = "";

  /** 地图 zoom（拿不到 = null，供 key 用；不编一个档位） */
  function tfZoomOf(m: TfMapLike): number | null {
    const z = (m as unknown as { getZoom?: () => number }).getZoom?.();
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  }

  function isFeatureCollection(v: unknown): boolean {
    return !!v && typeof v === "object" && Array.isArray((v as { features?: unknown }).features);
  }

  /**
   * 从**地图自己的 GeoJSON source** 读数据（路网/楼栋都已经在图上）。
   *
   * 为什么这样读（而不是再问一次后端）：
   *   · App 的口径是 **offline-first**（`wsScene.roadsLiveDecision()` 默认 `live:false`），
   *     路网由离线包一批批落进 `roads` source；楼栋同样在 `bld` source（叠加层只拆图层、**不拆源**）。
   *   · 再打一次 `/api/roads` = 冷查分钟级 + 与离线口径打架（本机实测 8s 没有响应）。
   *
   * 三种读法按"公开 → 私有"排：`serialize().data` → `_data` → `getStyle().sources[id].data`。
   * 之所以留兜底：不同引擎/版本对 `getStyle()` 是否带 `data` 不一致，只认一种会让
   * "换引擎之后静默 0 个设施"——那正是本仓反复栽的假绿。**读不到就返回 null，由 HUD 说原因**。
   */
  function sourceFcOf(m: unknown, id: string): TfGeoFcLike | null {
    try {
      const src = (m as { getSource?: (x: string) => unknown }).getSource?.(id) as
        | { serialize?: () => { data?: unknown }; _data?: unknown }
        | undefined;
      if (!src) return null;
      let data: unknown;
      try {
        data = src.serialize?.()?.data;
      } catch {
        data = undefined;
      }
      if (!isFeatureCollection(data)) data = src._data;
      if (!isFeatureCollection(data)) {
        const style = (m as { getStyle?: () => { sources?: Record<string, { data?: unknown }> } }).getStyle?.();
        data = style?.sources?.[id]?.data;
      }
      return isFeatureCollection(data) ? (data as TfGeoFcLike) : null;
    } catch {
      return null;
    }
  }

  /**
   * `?live=1` 那条路：**带 3s 超时**（`TF_LIVE_TIMEOUT_MS`）。
   * 默认路径根本不进这个函数（`props.tfLive === false`）。
   */
  async function liveRoadsFc(m: TfMapLike): Promise<TfGeoFcLike | null> {
    const c = m.getCenter();
    try {
      const fc = await Promise.race([
        worldMapApi.roads({ lat: c.lat, lng: c.lng, r: TF_CLIP_RADIUS_M }),
        new Promise<never>((_res, rej) => {
          window.setTimeout(() => rej(new Error(`超时 ${TF_LIVE_TIMEOUT_MS}ms`)), TF_LIVE_TIMEOUT_MS);
        }),
      ]);
      return (fc as unknown as TfGeoFcLike) || null;
    } catch (e) {
      tfInputWhy = `路网现场取数失败（${String((e as Error)?.message || e).slice(0, 40)}）`;
      return null;
    }
  }

  /** 排下一次计算（去抖 + 最小间隔 + 上一轮没算完就等；判据在 `wsTfPolicy.tfScheduleOf`）。
   *  `tf` 关着时这里**不早退**：监听本来就没挂（`onSceneReady` 里那条早退在它之前），
   *  而 `tfRefresh` 自己还有一道 `!props.tf`（运行时改 prop 也安全）。
   *  ⚠️ 不在这加同款早退的另一个原因：`ws_daily_hud_selftest` 用**代码 token**
   *  `if (!props.tf) return;` 断言"`emit("daily-ready")` 在它之前"，多一处同名早退会让它假红。 */
  function tfKick(): void {
    const s = tfScheduleOf({ now: performance.now(), lastEventAt: tfLastEventAt, lastBuiltAt: tfLastBuiltAt, busy: tfBusy });
    if (tfTimer) window.clearTimeout(tfTimer);
    tfTimer = window.setTimeout(() => {
      tfTimer = 0;
      void tfRefresh();
    }, Math.max(16, s.waitMs));
  }

  /**
   * 算一轮交通设施。
   *
   * 数据：`roads` / `bld` 两个**已落图**的 source（`bld` 里的一栋楼会被拆成 body/parapet/…，
   *       裁剪时只留 body —— 否则停车/出入口的"脚印面积"规则恒判不成立）；
   * 顺序：`bld-ext` → `ref` → 追加（`tfBeforeIdOf`，与路网落图同一条链）；
   * 代价：裁剪后输入通常几十条，单轮 < 100ms（改前 633 条要 12.9s；对照见自检 ⑤ 组）。
   */
  async function tfRefresh(): Promise<void> {
    const m = scene;
    if (!m || !props.tf) return;
    if (tfBusy) {
      tfKick();
      return;
    }
    const startedAt = performance.now();
    tfBusy = true;
    try {
      tfInputWhy = "";
      const roadsFc = props.tfLive ? await liveRoadsFc(m) : sourceFcOf(m, "roads");
      const bldFc = sourceFcOf(m, "bld");
      const c = m.getCenter();
      const center: [number, number] = [c.lng, c.lat];
      const key = tfKeyOf(c, tfZoomOf(m), roadsFc?.features?.length || 0, bldFc?.features?.length || 0);
      if (key === tfKey) {
        /* 同一个视野：**不算**（但记一次"已处理"，免得每 1.2s 空转一轮） */
        tfLastBuiltAt = performance.now();
        return;
      }
      if (!roadsFc) {
        tfInputWhy = props.tfLive
          ? tfInputWhy || "路网现场取数没有结果"
          : "路网还没落图（source `roads` 不在或没有要素）⇒ 交通设施先不画";
      }
      const clipR = clipRoadsFor(roadsFc, center);
      const clipB = clipBuildingsFor(bldFc, center);
      /* 计时只算**计算**这一段（读 source / `?live=1` 的网络等待不算进去 —— HUD 上那个 ms 是
         "这轮算得多慢"，不是"这轮等了多久"） */
      const built0 = performance.now();
      const res = buildTransportFor(
        clipR.fc as unknown as TfRoadsFc,
        clipB.fc as unknown as TfBuildingsFc,
        center,
        !!perf.low.value
      );
      const before = tfBeforeIdOf((id) => !!m.getLayer(id));
      const out = drawTransport(m, res, before);
      /* **无条件**写 HUD（含 0 条）：留着上一轮的计数会让人以为设施还在 */
      tfHud.value = out.hud;
      tfMs.value = Math.round(performance.now() - built0);
      tfKey = key;
      tfLastBuiltAt = performance.now();
      /* 层序**事后断言**（代拍页 2026-09-22 真机回归的解药）：路网被交通设施/楼体压住就移回。
         这里只执行 `move`；`add-roads`（路网整个缺失）**只计数**——取数是地图组件的职责，
         越权重取会把 Overpass 打第二遍（它下一次视野变化会自己补）。 */
      const notes: string[] = [];
      if (tfInputWhy) notes.push(tfInputWhy);
      if (clipR.note) notes.push(`路网裁剪：${clipR.note}`);
      if (clipB.note) notes.push(`楼栋裁剪：${clipB.note}`);
      if (clipB.kept === 0) notes.push("楼脚印为空 ⇒ 停车/出入口数不出来（不是 0）");
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
        if (done.needRoads) notes.push("路网缺失：等下一次视野变化自动补（取数归地图组件，不在这里重取）");
        else if (heals) notes.push(`层序自愈 ${heals} 次（路网曾被压在设施/楼体之上）`);
      } catch {
        notes.push("层序断言失败（不影响地图）");
      }
      layerNote.value = notes.join(" · ");
    } catch (e) {
      tfInputWhy = `交通设施算不出来：${String((e as Error)?.message || e).slice(0, 60)}`;
      layerNote.value = tfInputWhy;
    } finally {
      tfBusy = false;
      /* 算的时候又来了事件（拖动/落格）⇒ 立刻按调度再排一轮（不丢最后一次视野） */
      if (tfLastEventAt > startedAt) tfKick();
    }
  }

  /**
   * `WsDistrictMapLibre` 的 `scene-ready`：地图到位 ⇒ 接交通设施。
   *
   * 入参形状**照抄那个组件的 emit 声明**（`{ map: unknown; buildings: …; places? }`）
   * —— 不在这里另写一份类型：两份形状描述迟早漂移（`BldFeature` 只在那个模块里定义）。
   * 注意：`buildings` 这个字段**只在 `?live=1` 时有内容**（离线路 `fc` 是 null），所以这里
   * 不再用它，楼栋统一从 `bld` source 读（见 `sourceFcOf`）。
   */
  function onSceneReady(p: {
    map: unknown;
    buildings: { features?: unknown[] } | null;
    places?: () => readonly PlacePoint[];
  }): void {
    /* 双引擎：地图一就绪就把实例交给 map 后端（**必须先做**：切到 3D 时要靠它读视野、捞数据）。
       它只做"读/喂/捞"三件事，不碰这一屏的渲染 ⇒ 放在最前面不会影响下面那条交通设施接线。 */
    adoptMapBackend(p?.map ?? null);
    /* **先把三件事那条路分出去**，再谈交通设施。
       顺序是硬要求：下面的 `if (!props.tf) return;` 是默认关时的必经之路，
       把这一行放到它后面 = 宿主**永远收不到 `daily-ready`**，而且**不报错**（HUD 一直空着）。
       本行只是"转发"：地图与取值器**原样**交给宿主，这里不读它们、更不解析（薄壳纪律）。 */
    emit("daily-ready", { map: p?.map ?? null, places: p?.places });
    /* `tf=false`（默认关）：**在这里就退**——不挂监听、不算、不画。 */
    if (!props.tf) return;
    const m = p?.map as (TfMapLike & { on?(ev: string, cb: (e?: { sourceId?: string }) => void): void }) | null;
    if (!m) return;
    /* 只在第一次挂监听（重挂地图时旧监听随旧实例一起消失；计数器也一起归零） */
    if (m !== scene) {
      tfKey = "";
      tfLastEventAt = 0;
      tfLastBuiltAt = 0;
      m.on?.("moveend", () => {
        tfLastEventAt = performance.now();
        tfKick();
      });
      /* 离线包是**后到**的（路网/楼栋一批批落图）——只在 moveend 上挂就是"开屏一个设施都没有，
         直到用户动一下"（本仓栽过三次的「挂钩只在用户事件上 ⇒ 首屏空白」）。
         `sourcedata` 只做一件事：踢一脚；去抖会把一串合成一轮。 */
      m.on?.("sourcedata", (e) => {
        const id = String(e?.sourceId || "");
        if (id !== "roads" && id !== "bld") return;
        tfLastEventAt = performance.now();
        tfKick();
      });
    }
    scene = m;
    tfLastEventAt = performance.now();
    tfKick();
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════
   * 双引擎舞台（2026-10-07 · —— 「换后端 + 交接状态」这条线**只在这里**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * 它只做四件事：
   *   ① 按 `rendererLive` 决定挂哪一支（模板里那个 `v-if/v-else`）—— 两支互斥 ⇒ 画布最多一个；
   *   ② 切换时先把旧后端的 `readView()` 读回来、`captureWorld()` 捞一份世界数据（地图还在的时候捞）；
   *   ③ `old.pause()` → 换 DOM（旧的**整个卸载**）→ 等两帧 → `new.init()`；
   *   ④ 新后端起不来 ⇒ 记一句 HUD 看得见的原因 + 自动回 map（§4.5）。
   *
   * 为什么"卸载"而不是"藏起来"：地图与 three 各要一个 WebGL 上下文，Android WebView 上
   * 两个上下文互相挤是已知风险（那份 PLAN §3 标的是"推断"）。**藏起来**就只能靠"暂停渲染"
   * 这条软约束；**卸载**是硬的：`map.remove()` / `renderer.dispose()+forceContextLoss()`
   * 之后上下文真的没了 —— 判据也因此可以写成"整页 `<canvas>` 数 ≤1"这种一眼可数的形式。
   *
   * 代价如实记在这里：换回 map 时 MapLibre 要**重新建一次图**（楼与路从模块级仓库
   * `bldStore` 重新落图，不走网络）。实测耗时见 `switchLog`（探针也读它）。 */
  const rootEl = ref<HTMLElement | null>(null);
  const threeHost = ref<HTMLElement | null>(null);
  const overlayHost = ref<HTMLElement | null>(null);
  /** 三条分支在不在（模板读它们；**都是 `rendererLive` 的镜像**，没有第二份状态） */
  const showMap = computed(() => rendererLive.value === "map");
  const showThree = computed(() => rendererLive.value === "three");
  /** 叠加层：地图**留在台上**（`showMap || showOverlay` 都渲染它），上面再加一块透明画布 */
  const showOverlay = computed(() => rendererLive.value === "overlay");

  type MapBound = WsRenderBackend & { bind?: (m: unknown) => void; unbind?: () => void };
  /** 地图实例留一份：叠加层要 `bindMap()` 它（每帧读相机、订阅 `sourcedata`） */
  let mapInstance: unknown = null;
  let mapBackend: MapBound | null = null;
  let active: WsRenderBackend | null = null;
  /** 地图还没就绪时先把"要恢复的视野"存在这儿，`scene-ready` 一到就喂进去 */
  let pendingView: WsRenderState | null = null;
  let swapping = false;
  let queued: WsRenderBackendId | null = null;
  let startupSwapDone = false;

  /** 等两帧（第一帧让 Vue 把 DOM 换掉、第二帧让 GPU 真的回收上下文 —— 与 PLAN §4.2 同口径） */
  const twoFrames = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame !== "function") return resolve();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  /** 地图就绪：把实例绑给 map 后端，并把"欠着的那次 applyView"补上 */
  async function adoptMapBackend(m: unknown): Promise<void> {
    await ensureMapBackend();
    mapInstance = m;
    mapBackend?.bind?.(m);
    /* 叠加层可能已经先起来了（它不等地图 ready）⇒ 实例一到就交给它 */
    if (active && active.id === "overlay") {
      (active as WsRenderBackend & { bindMap?: (x: unknown) => void }).bindMap?.(m);
    }
    active = mapBackend;
    setLiveBackend(active);
    if (pendingView && mapBackend) {
      mapBackend.applyView(pendingView);
      pendingView = null;
    }
    mapBackend?.resume?.();
    /* 上次存的是 three ⇒ 地图一就绪就自动切过去（**不是**开局直接进 3D：那样没有 center 可交接，
       也没有 `bld` 那份数据可捞）。只做一次。 */
    if (!startupSwapDone && rendererPref.value !== rendererLive.value) {
      startupSwapDone = true;
      void nextTick(() => doSwap(rendererPref.value));
    }
  }

  /**
   * 建 map 后端（**幂等**：`onMounted` 与 `scene-ready` 谁先到都只建一个）。
   * 这两条路是**真会抢**的：地图组件挂载与它 emit `scene-ready` 之间只隔几毫秒，
   *    而 `init()` 是 async ⇒ 不做这个闸就会出现两个 map 后端实例（台账里两条 `running`）。
   *
   * 2026-10-08 `seed`：**把要交接的那一眼一起交代给它**。地图实例要等 `scene-ready`
   *    才绑得上来，而"失败即回退"回到 map 的那一刻 `readView()` 就得答得出来
   *    （否则探针读到的 `state` 是 null ⇒ 「center 交接误差 ≤1 m」量不出来）。
   */
  let mapInitPromise: Promise<void> | null = null;
  function ensureMapBackend(seed?: WsRenderState | null): Promise<void> {
    if (mapInitPromise) return mapInitPromise;
    mapInitPromise = (async () => {
      const mb = createRenderBackend("map") as MapBound;
      await mb.init(rootEl.value || document.body, seed ?? fallbackView(), null);
      mapBackend = mb;
      setMapBackendRef(mb);          // §1.3 像素对拍要拿真地图的 `project()`
      if (!active) {
        active = mb;
        setLiveBackend(mb);
      }
    })();
    return mapInitPromise;
  }
  /** 丢掉 map 后端（切到 three 时；下次要用会重新建一个） */
  function dropMapBackend(): void {
    mapBackend = null;
    mapInitPromise = null;
  }

  /** 拿不到任何后端时的"一个能用的视野"（兜底，不编经纬度：用主题 + 一个安全的半径） */
  function fallbackView(): WsRenderState {
    return {
      center: { lat: 0, lng: 0 },
      radius: 300,
      bearing: 0,
      pitch: 0,
      theme: contractTheme.value.theme,
      timeOfDay: contractTheme.value.timeOfDay,
      clock: contractTheme.value.clock,
      actors: contractActors.value.map((a) => ({ ...a })),
      selection: null,
    };
  }

  /** 旧后端是不是叠加层（它不拥有世界数据、也不能被 pause —— 地图还在下面画） */
  const leavingOverlayFrom = (b: WsRenderBackend | null): boolean => !!b && b.id === "overlay";

  async function doSwap(next: WsRenderBackendId): Promise<void> {
    if (next === rendererLive.value) return;
    if (swapping) {
      queued = next;
      return;
    }
    swapping = true;
    const t0 = performance.now();
    const from = rendererLive.value;
    const old = active;
    let view: WsRenderState | null = old?.readView() ?? pendingView ?? null;
    let ok = true;
    let why = "";
    /* 🧊 叠加层这条支的规矩（与另两条**不同**，见 PLAN-OVERLAY-BACKEND.md）：
       · 地图**不卸载、不暂停**（它在下层照常画）；
       · 世界数据从 **map 后端**捞（叠加层自己不拥有数据）；
       · 两个后端同时活着是**设计**，不是违规。 */
    const toOverlay = next === "overlay";
    try {
      const nb = next === "map" ? null : createRenderBackend(next);
      /* ① 旧后端还活着的时候把该拿的拿到手。⚠️ 从叠加层切走时，世界数据要向 **map 后端**要
            （叠加层不拥有它，而且地图还活着，source 也还在）。 */
      const world = leavingOverlayFrom(old) ? await mapBackend?.captureWorld?.() ?? null : old ? await old.captureWorld() : null;
      if (old && !view) view = old.readView();
      if (!toOverlay && !leavingOverlayFrom(old)) old?.pause();
      /* 离开叠加层：把那一层拆掉（放掉它的 WebGL 上下文）；地图那一层不动 */
      if (leavingOverlayFrom(old) && !toOverlay) old?.destroy();
      /* ② 换 DOM。⚠️ 进叠加层时地图**留在台上**（模板里 `showMap || showOverlay` 都渲染它）
            ⇒ 这里只多挂一块透明画布。 */
      rendererLive.value = next;
      setLiveBackend(null);
      if (!leavingOverlayFrom(old) || toOverlay) active = null;
      await nextTick();
      await twoFrames();
      /* ③ 起新的 */
      if (toOverlay) {
        const host = overlayHost.value;
        if (!host) throw new Error("叠加层宿主元素没挂上（模板里缺 .ws-sceneview__overlay）");
        const ob = nb as WsRenderBackend & { bindMap?: (m: unknown) => void };
        ob.bindMap?.(mapInstance);
        await ob.init(host, view ?? fallbackView(), world);
        ob.resume();
        active = ob;
        setLiveBackend(ob);
      } else if (!nb) {
        await ensureMapBackend(view);
        active = mapBackend;             // 真正"在跑"要等 `scene-ready`（`bind` + `resume`）
        setLiveBackend(active);
        pendingView = view;              // 地图一到位就把视野喂回去
      } else {
        const host = threeHost.value;
        if (!host) throw new Error("3D 宿主元素没挂上（模板里缺 .ws-sceneview__three）");
        await nb.init(host, view ?? fallbackView(), world);
        if (view) nb.applyView(view);
        /* 🔴 2026-10-11：用户在 three 里**自己拖/捏/滚轮**改了相机 ⇒ 后端叫一声，舞台把它记成
           `pendingView`（切回地图时喂回去的那一份就是它）。没有这一句，three 里拖到哪儿、
           切回地图都会被弹回切换前那一眼 —— "同一视野"只做了一半。 */
        nb.setViewListener?.((s) => {
          pendingView = s;
        });
        nb.resume();
        active = nb;
        setLiveBackend(nb);
        dropMapBackend();          // 切到 three ⇒ 地图在这一刻被卸载（模板 v-if 换支）
        mapInstance = null;
        pendingView = null;
      }
    } catch (e) {
      ok = false;
      why = String((e as Error)?.message || e || "未知原因");
      rendererLastError.value = why;
      rendererFallback.value = `3D 渲染起不来：${why} —— 已自动回到地图（视野保持切换前那一份）。`;
      /* ④ 回退：回到 map，并把刚才那一份视野补回去（**不许白屏、也不许把用户甩到别处**） */
      if (next !== "map") {
        rendererLive.value = "map";
        pendingView = view;
        setLiveBackend(null);
        active = null;
        /* 🔴 只有"地图组件被卸载过"（切到 `three` 那条路）才需要丢掉旧后端重来：
           那时它手里的 MapLibre 实例**已经被 `map.remove` 了**，留着 `readView()` 读的是死实例。
           ⚠️ 叠加层失败时地图**一直在台上**（模板里 `showMap || showOverlay` 都渲染它、
           我们也没 pause 过它）⇒ 旧后端仍然有效；此时丢掉它，下面那句会建一个新的，
           而新的要等一次**永远不会再来的** `scene-ready`（组件已经挂着了）⇒ 地图后端永远
           不 bind、`stats.rendering` 恒 false（2026-10-11 真页面探针实测到的那条红：
           "切回 map 成功"超时 150 s，live 是 map 但 stats 是 null）。 */
        if (next === "three") dropMapBackend();
      }
      /* 2026-10-08：**当场**把 map 后端重新建起来，并把交接的那一眼交代给它。
         为什么不等 `scene-ready`：地图是异步才绑上来的，中间这段时间 `liveBackend` 是 null
         ⇒ 契约里 `state` 读到 null（探针的「center 交接误差 ≤1 m」就是因此量不出来）。
         这里建的是**同一个**后端实例（`ensureMapBackend` 幂等），`scene-ready` 一到还是绑它。 */
      try {
        await ensureMapBackend(view);
        if (!active && rendererLive.value === "map") {
          active = mapBackend;
          setLiveBackend(active);
        }
      } catch {
        /* 连 map 后端都建不起来：维持 null（探针会如实地读到"数不出来"） */
      }
    } finally {
      swapping = false;
      noteSwitch({ from, to: rendererLive.value, ms: Math.round(performance.now() - t0), ok, why: why || undefined });
      if (queued) {
        const q = queued;
        queued = null;
        void doSwap(q);
      }
    }
  }

  watch(rendererPref, (next) => void doSwap(next));
  /* 角色与主题：宿主推什么，舞台就喂给"当前活着的那个后端"（契约里那一份是两个后端共用的） */
  watch(
    () => contractActors.value,
    (list) => active?.setActors(list)
  );
  watch(
    () => contractTheme.value,
    (t) => {
      active?.setTheme(t.theme, t.timeOfDay);
      if (rendererFallback.value && rendererLive.value === "three") clearFallback();
    }
  );

  onMounted(() => {
    /* 开局**永远先走地图**（默认后端不许变）；存了 three 的偏好在 `scene-ready` 之后自动切过去 */
    void ensureMapBackend();
  });

  onBeforeUnmount(() => {
    /* 交通设施那个定时器必须清掉：它闭包着本组件的 map/ref，卸载后再跑一次就是
       "对已经销毁的地图加图层"（本仓的卸载期异常一律不外抛，但也不许留着跑） */
    if (tfTimer) window.clearTimeout(tfTimer);
    tfTimer = 0;
    tfBusy = false;
    try {
      active?.pause();
      /* 地图那一支的销毁归 `WsDistrictMapLibre` 自己（它 `onBeforeUnmount` 里 `map.remove()`）；
         three 这一支没有别人管 ⇒ 在这里放掉上下文（不然整屏切走会剩一个活着的 WebGL 上下文）。 */
      if (active && (active.id === "three" || active.id === "overlay")) active.destroy();
    } catch {
      /* 卸载期的异常不该再往外抛 */
    }
    setLiveBackend(null);
    active = null;
    dropMapBackend();
  });
</script>

<style scoped>
  /* 薄壳自己不画地图：尺寸交给 `WsDistrictMapLibre` 的宿主样式（`.ws-dml` 铺满父容器） */
  .ws-sceneview {
    position: absolute;
    inset: 0;
  }

  /* 3D 宿主机：与地图那一支**同一个盒子**（`inset: 0`）——
     两个后端的画布尺寸因此逐像素相同 ⇒ 相机换算里那个"画布 CSS 高"才是同一个数。 */
  .ws-sceneview__three {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #0a1018;
  }
  /* 🧊 叠加层宿主：**透明**、且在 HUD 之下（楼压在地图上，HUD 压在楼上面）。
     真正的"不接管输入"写在画布自己的 `pointer-events:none` 上（见 `wsOverlayBackend`）。 */
  .ws-sceneview__overlay {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    background: transparent;
  }

  /* 失败即回退那句话：**必须在屏幕上**（不是 console、不是 title）—— 判据是"看得见原因"。
     位置压在地图下沿之上、`z-index` 高于地图与 HUD；点「知道了」才消失（不自动淡出）。 */
  .ws-sceneview__note {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 8px;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 12px;
    background: rgba(24, 12, 12, 0.88);
    border: 1px solid rgba(255, 170, 120, 0.5);
    color: #ffe6d5;
    font-size: 12px;
    line-height: 1.5;
  }
  .ws-sceneview__note-txt {
    flex: 1 1 auto;
    min-width: 0;
  }
  .ws-sceneview__note-x {
    flex: 0 0 auto;
    min-height: 32px;
    min-width: 64px;
    padding: 4px 10px;
    border-radius: 9px;
    border: 1px solid rgba(255, 200, 160, 0.5);
    background: rgba(255, 200, 160, 0.16);
    color: #ffe6d5;
    font: inherit;
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

  /* ── 底部两个动作（复刻 旧小区页（WsDistrict.vue，已删除）里 `.ws-dist__*` 那一组）──
     为什么**必须在这里再写一份**：旧小区页（WsDistrict.vue，已删除）的样式是 `<style scoped>`，
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
