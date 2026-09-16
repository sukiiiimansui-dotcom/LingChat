// ⚠️ 自用层文件（不进 PR）—— 把 `webdev.html` 打成**生产包**，给机主一个「不卡」的验证入口。
//
// 为什么要这个（2026-09-15 实测数据，`~/chk/page-perf.mjs`）：
//   vite **dev** 模式下，首页要发 **250 个请求 / 10.1 MB** 未打包的模块，
//   `DOMContentLoaded` 5.4s、`load` 10.7s —— **第二次加载（服务端已热）一模一样**，
//   所以不是缓存问题，是「模块太多 + 逐个转换」的结构性开销。手机上就是「很卡」。
//   生产包把这些合成少数几个文件，加载应该快一个数量级。
//
// 分工：
//   · `vite.config.ts` + `npm run dev`（5210）→ **开发**用，热更新、能改代码立即见效；
//   · 本配置（5212，见 `~/chk/webdev-preview.sh`）→ **看效果**用，快，是机主验收的入口。
//
// ⚠️ 本文件与 `webdev.html` / `src/web-mock.ts` 同属自用层，**不要进 PR 切片**。
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 这里刻意**不加** VueDevTools：预览包要的是小和快。
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist-webdev",
    emptyOutDir: true,
    // 手机上看效果不需要 sourcemap（体积会翻倍）
    sourcemap: false,
    // 入口是自用的两个页面，不是上游的 index.html：
    //   · webdev.html —— 主应用（带 Tauri 垫片，走 8791 的 HTTP 通路）
    //   · wsfx.html   —— T4-1/T4-2（昼夜 / 天气）的独立预览页，一页出齐
    //                    白天/黄昏/夜晚 + 晴/雨/雪/雾 + 降级档
    //   · wsux.html   —— 「世界模拟」HUD 风格板（3 套候选，1:1 真实舞台 932×430）。
    //                    ⚠️ 它是**纯静态**页（无 script / 无 import，三张地图以 data URI 内嵌），
    //                    列在这里只是让它进同一条验证管道（会被 5212 服务到）；
    //                    rollup 对它只做原样拷贝，不产 chunk。
    rollupOptions: {
      input: {
        webdev: path.resolve(__dirname, "webdev.html"),
        wsfx: path.resolve(__dirname, "wsfx.html"),
        wsux: path.resolve(__dirname, "wsux.html"),
      },
    },
  },
});
