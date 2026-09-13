import { createRouter, createWebHistory } from "vue-router";

// 导入你的组件
// 为了性能，这里我们使用路由懒加载 (lazy-loading)
// 这意味着 Credits.vue 组件只会在用户访问 /credit 路径时才会被加载
const Credits = () => import("../components/views/Credits.vue");
const ComapionMode = () => import("../components/views/CompanionMode.vue");
const MainMenu = () => import("../components/views/MainMenu.vue");
const PetMode = () => import("../components/views/PetMode.vue");
const Second = () => import("../components/views/Second.vue");
const LogWindow = () => import("../components/views/LogWindow.vue");
const CastWindow = () => import("../components/views/CastWindow.vue");
// 剧本编辑器体量较大，必须懒加载 —— 项目没有配 manualChunks，
// 非懒加载的 view 会整个进主 chunk
const ScriptEditor = () => import("../components/views/ScriptEditor.vue");
// 云端创意工坊（主菜单「创意工坊」二级菜单进入，原设置页 workshop 标签迁移）
const WorkshopPage = () => import("../components/views/WorkshopPage.vue");

// ── 世界模拟（地图系统）────────────────────────────────────────────
// 分两类，别混：
//   · `/world` + `/world/*` —— 地图**工具页**（总览 / 街区实况 / 街区可视化 /
//     地图库 / 手机悬浮窗）。App.vue 里那个角落小窗的「⛶ 打开世界地图」按钮
//     就是 `router.push('/world')`，所以这条必须存在。
//   · `/worldsim` —— 玩家实际用的**引导主线**页面（选国家 → 省 → 市 → 区县 → 小区）。
// 全部懒加载：WorldSim 自带一套皮肤和四个子组件，工具页各自上千行，
// 不该进主 chunk（本项目没配 manualChunks）。
const WorldMap = () => import("../components/views/WorldMap.vue");
const WorldDistrictLive = () => import("../components/views/worldmap/DistrictLive.vue");
const WorldDistrictViz = () => import("../components/views/worldmap/DistrictViz.vue");
const WorldMapLibrary = () => import("../components/views/worldmap/MapLibrary.vue");
const WorldPhoneOverlay = () => import("../components/views/worldmap/PhoneOverlay.vue");
const WorldSim = () => import("../components/views/worldsim/WorldSim.vue");

// 1. 定义路由表
const routes = [
  {
    path: "/",
    name: "MainMenu",
    component: MainMenu,
  },
  {
    path: "/chat",
    name: "LingChat",
    component: ComapionMode,
  },
  {
    path: "/credit",
    name: "Credits",
    component: Credits,
  },
  {
    path: "/pet",
    name: "PetMode",
    component: PetMode,
  },
  {
    path: "/second",
    name: "Second",
    component: Second,
  },
  {
    path: "/log-window",
    name: "LogWindow",
    component: LogWindow,
  },
  {
    path: "/cast",
    name: "CastWindow",
    component: CastWindow,
  },
  {
    path: "/bubble",
    name: "BubbleWindow",
    component: () => import("../components/views/BubbleWindow.vue"),
  },
  {
    path: "/script-editor",
    name: "ScriptEditor",
    component: ScriptEditor,
  },
  {
    path: "/workshop",
    name: "WorkshopPage",
    component: WorkshopPage,
  },
  // 世界地图工具页总览（角落小窗的 ⛶ 按钮指向这里）
  {
    path: "/world",
    name: "WorldMap",
    component: WorldMap,
  },
  // 用 /world/xxx 前缀挂在既有 /world 下面，语义上是一组页面
  {
    path: "/world/district-live",
    name: "WorldDistrictLive",
    component: WorldDistrictLive,
  },
  {
    path: "/world/district-viz",
    name: "WorldDistrictViz",
    component: WorldDistrictViz,
  },
  {
    path: "/world/maplib",
    name: "WorldMapLibrary",
    component: WorldMapLibrary,
  },
  {
    path: "/world/phone-overlay",
    name: "WorldPhoneOverlay",
    component: WorldPhoneOverlay,
  },
  // 世界模拟主线页面（P1）：与上面的 /world/* 是两回事
  {
    path: "/worldsim",
    name: "WorldSim",
    component: WorldSim,
  },
];

// 2. 创建路由实例
const router = createRouter({
  // 使用 HTML5 History 模式，URL会更美观（例如：http://localhost:5173/credit）
  // 而不是 hash 模式 (http://localhost:5173/#/credit)
  history: createWebHistory(),
  routes, // `routes: routes` 的缩写
});

// 3. 导出路由实例
export default router;
