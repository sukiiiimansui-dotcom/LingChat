/**
 * wsPageVendor.ts —— **静态页生成物的唯一入口**（只做 re-export，没有自己的逻辑）。
 *
 * 静态页（`public/ws3dshow.html`）引不到 TS ⇒ 走"生成物"这条路（与 `public/wstheme.json` 同款）：
 * `scripts/build-ws-vendor.sh` 打包本文件 → `public/vendor/wsScene.mjs`（提交进仓库 + 自检兜漂移）。
 *
 * 🔴 为什么入口要单独一个 re-export 文件：esbuild 只从入口收依赖 ——
 * 直接打某个实现文件时，**别的模块里没被它 import 的导出不会进产物**
 * （踩过：页面 `TF.TF_LAYER_IDS` 变 undefined）。所以这里把页面要用的**全部**列出来。
 */
export * from "./wsTransport"; // 交通设施：生成逻辑
export * from "./wsTransportRules"; // 交通设施：规则/图层 id/样式/低档名单
export * from "./wsRoads"; // 路网：分级样式（roadLayerSpecs）+ 计数（visibleRoadCount / roadStatsLine）
