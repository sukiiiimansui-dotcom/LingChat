/**
 * wsMapLibreCss.ts —— MapLibre **样式表**的注入点。
 *
 * 为什么单独留这么一个小模块：2026-10-06 清掉 `useWsMapLibre.ts`（1166 行）时，
 * 那个 composable 里**只剩 `injectCss` 一个函数还有活消费者** —— `WsDistrictMapLibre.vue`
 * 走的是"绕过 composable、自己 import 引擎"那条路。把这个函数原样搬出来，
 * 那条路照旧，别处一行不用改。
 *
 * ⚠️ **纯搬运**：下面那段事故记录与函数体一字未改（对拍判据 diff=0）。
 */
import { assetUrl } from "@/components/views/worldsim/wsMapStyle";

const ML_VENDOR_DIR = "/vendor/maplibre";
export const ML_CSS_PATH = `${ML_VENDOR_DIR}/maplibre-gl.css`;
/* 幂等标记：一张页面只插一次 */
let cssInjected = false;

/**
 * 把 vendored 的 MapLibre **样式表**注入 `<head>`（幂等，一次就够）。
 *
 * 🔴 **2026-10-01 导出给"绕过 composable 的宿主"**：机主报「人物位置错位，疑似没有 z 轴，倾斜地图会错位」——
 * 实测（`~/chk/_mlcss_probe.mjs`）：App 入口那一屏**根本没有这张样式表**
 * （`link[data-ws-ml-css]` 不存在、`.maplibregl-marker` 规则 `null`、`getComputedStyle(钉).position === "static"`），
 * 于是角色钉子**掉进文档流**（它们的 `translate(x,y)` 只是叠在流式位置上）⇒ 人整体被推到屏幕外/错位，
 * 间距还恰好等于各自高度（`~/chk/_pins_probe.mjs` 量到 4 个钉子在 y 589~958，视口只有 557 高）。
 * 根因：`WsDistrictMapLibre.vue` 为了不碰 package.json **自己 `import()` 了 `/vendor/maplibre/maplibre-gl.mjs`**，
 * 而这条路上原来只有引擎、没有样式表（引擎由本文件的 `boot()` 载入时才会 `injectCss()`）。
 * ⇒ 谁直接载引擎，谁就必须调这个函数（`wsmaplibre_selftest.mjs` ⑤ 盯着这条）。
 */
export function injectCss(): void {
  if (cssInjected || typeof document === "undefined") return;
  if (document.querySelector("link[data-ws-ml-css]")) {
    cssInjected = true;
    return;
  }
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = assetUrl(ML_CSS_PATH);
  l.setAttribute("data-ws-ml-css", "1");
  document.head.appendChild(l);
  cssInjected = true;
}
