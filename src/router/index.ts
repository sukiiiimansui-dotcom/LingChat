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
//   · `/worldsim` —— 玩家实际用的**主线**页面。2026-09-26 机主拍板「**彻底替掉官方那套 UI**」
//     ⇒ 它现在是 `WsCityEntry.vue`：**直接进 MapLibre 3D 地图**（与代拍页同一份共享真源）
//     + 首次引导「选城市 → 下载该城市楼房数据 → 进地图」。
// 全部懒加载：自带一套皮肤和若干子组件，工具页各自上千行，
// 不该进主 chunk（本项目没配 manualChunks）。
const WorldMap = () => import("../components/views/WorldMap.vue");
const WorldDistrictLive = () => import("../components/views/worldmap/DistrictLive.vue");
const WorldDistrictViz = () => import("../components/views/worldmap/DistrictViz.vue");
const WorldMapLibrary = () => import("../components/views/worldmap/MapLibrary.vue");
const WorldPhoneOverlay = () => import("../components/views/worldmap/PhoneOverlay.vue");
const WsCityEntry = () => import("../components/views/worldsim/WsCityEntry.vue");
// 🗄 老入口（DataV 全国 SVG 下钻那一套，`WorldSim.vue`）**已退役**（2026-10-04 死代码清理，
//    2 058 行）：它自 2026-09-26 起就没有任何路由/组件引用（`/worldsim` 走上面这行 WsCityEntry），
//    全仓只剩注释提到它。要回退请看 git 历史（清理前一版），别在这里留一行指向不存在文件的 import。

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
  // 世界模拟主线页面：与上面的 /world/* 是两回事。
  // 2026-09-26 起 = 「3D 地图 + 城市数据引导」（`WsCityEntry.vue`），不再是 DataV 下钻那一屏。
  // ⚠️ 路由 **name 保持 `WorldSim`** 不动：别处是按 path 跳的（`/worldsim`），改 name 没有收益、
  //    只会让"老代码里按名字跳"变成运行期 404（搜索过一次：全仓 0 处按 name 跳）。
  {
    path: "/worldsim",
    name: "WorldSim",
    component: WsCityEntry,
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
