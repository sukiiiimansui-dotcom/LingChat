/**
 * 纯浏览器预览用的 Tauri 垫片（web-mock）
 * ────────────────────────────────────────────────────────────────────────────
 * ## 为什么需要它
 * LingChat 是一个 Tauri 应用：`main.ts` 第一行就会 `getCurrentWindow()`，
 * 而 `@tauri-apps/api` 依赖 Rust 注入的 `window.__TAURI_INTERNALS__`。
 * 在纯浏览器里这些都不存在 → 模块求值就抛异常 → **应用永不 mount → 白屏**。
 *
 * 这个文件伪造一份最小可用的 `__TAURI_INTERNALS__`，让前端能在浏览器里跑起来，
 * 并打上 `__LINGCHAT_WEB_MOCK__` 标记 —— `worldMap.ts::isTauriRuntime()` 靠它把
 * 「真壳」和「web 预览」区分开，从而**自动切到 HTTP 通路**（`127.0.0.1:8791`）。
 *
 * ## 为什么单独一个入口文件，而不是改 `main.ts`
 * `src/main.ts` 是 PR 保护文件（必须与上游逐字节相同），不能动。
 * 所以用 `webdev.html` 作入口：先加载本文件，再加载 `/src/main.ts`。
 * 访问 `http://127.0.0.1:5219/webdev.html` 即可。
 *
 * ## 边界（重要）
 * · 只伪造**够让前端跑起来**的部分，不假装实现业务逻辑
 * · `world_map_*` 一律返回 `undefined` → 前端据此走 HTTP 通路（这是**故意的**）
 * · 其余命令返回**保守的空值**（空数组/空对象/null），让 UI 走到「无数据」分支
 *   而不是抛异常 —— 这样至少能看到**布局、配色、交互、动画**
 * · 这些假数据**绝不能**被当成真实行为来验证业务逻辑
 */

declare global {
  interface Window {
    // ⚠️ 这里**不能**重新声明 `__TAURI_INTERNALS__` 的类型 ——
    //    `@tauri-apps/api` 已经把它声明成 `any` 了，再声明一次会撞
    //    TS2717（"Subsequent property declarations must have the same type"）。
    //    我们只声明自己新增的那两个。
    /** 前端可读：判断当前是不是 web 预览（供组件显示提示条用） */
    __LINGCHAT_WEB_MOCK_INFO__?: { httpBase: string; startedAt: number };
  }
}

/** web 预览时的 HTTP 后端（就是那个独立 Rust 调试服务） */
const HTTP_BASE =
  (import.meta.env?.VITE_WORLD_MAP_API as string | undefined) || "http://127.0.0.1:8791";

/** 回调登记表：`@tauri-apps/api` 的 listen/Channel 靠它回传 */
const callbacks = new Map<number, (payload: unknown) => void>();
let callbackId = 0;

/**
 * 哪些命令返回「空值」而不是 undefined。
 *
 * 约定：**`world_map_*` 一律返回 undefined** —— 这样 `worldMap.ts` 里
 * 「真壳通路失败 → 回退 HTTP」的逻辑会自然生效（它正是这么设计的）。
 * 其余命令给保守空值，免得 UI 在 `.map()` / `.length` 上炸掉。
 */
const EMPTY_ANSWERS: Record<string, () => unknown> = {
  // ── 剧本列表：`script-info.ts` 读 `.scripts` ──
  list_scripts: () => ({ scripts: [] }),
  list_standalone_scripts: () => ({ scripts: [] }),
  // ── CPU / 画质：`cpu-perf.ts` 读 `.tier`（少了它 `autoConfigurePerformance` 会抛） ──
  get_cpu_info: () => ({ tier: "medium", cores: 8, memory_gb: 8, is_mobile: true }),
  redetect_cpu: () => ({ tier: "medium", cores: 8, memory_gb: 8, is_mobile: true }),
  // ── 角色 / 存档 / 字体等，给空列表 ──
  list_characters: () => [],
  list_saves: () => ({ saves: [], total: 0 }),
  list_system_fonts: () => [],
  list_imported_fonts: () => [],
  // ── 设置树 / 配置，给空对象 ──
  get_settings_tree: () => ({}),
  get_game_info: () => ({}),
  list_llm_providers: () => ({ providers: [], chat_provider_id: null }),
  // ── 状态类 ──
  is_maximized: () => false,
  is_fullscreen: () => false,
};

async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  // ⚠️ 地图相关一律 undefined —— 让前端走 HTTP 通路（`isTauriRuntime()` 也会因
  //    `__LINGCHAT_WEB_MOCK__` 直接判 false，这里只是双保险）
  if (cmd.startsWith("world_map_")) return undefined;

  // 插件命令（`plugin:xxx|yyy`）：一律 undefined，调用方自己兜底
  if (cmd.startsWith("plugin:")) return undefined;

  // ── 语言词条：这是最巧的一处 ──────────────────────────────────────────────
  // `locales/index.ts` 调 `get_locale_messages(locale, seedContent)` 时**自己把
  // 完整的词条 JSON 传了进来**（`seedContent`），期望后端把它落盘再读回。
  // 我们直接回传 seedContent —— 于是浏览器里**四种语言都完整可用**，
  // 不会退化成"加载语言文件失败（使用内置词条）"。
  if (cmd === "get_locale_messages") {
    const seed = args?.seedContent;
    if (typeof seed === "string") return seed;
    return "{}";
  }

  const f = EMPTY_ANSWERS[cmd];
  if (f) return f();

  // 未登记的命令：返回 undefined，调用方自己的 catch 会记录。
  // 打一条可 grep 的日志，方便按需补齐形状。
  if (import.meta.env?.DEV) {
    console.debug(`[web-mock] 未登记的命令 "${cmd}" → undefined`, args);
  }
  return undefined;
}

function installMock(): void {
  if (typeof window === "undefined") return;
  if (window.__TAURI_INTERNALS__) return; // 真壳里绝不覆盖

  window.__TAURI_INTERNALS__ = {
    // `getCurrentWindow()` 读这个拿 label；`main.ts` 会判断 === "main"
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main" } },
    invoke: mockInvoke,
    transformCallback(cb: (payload: unknown) => void): number {
      const id = ++callbackId;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id);
    },
    /**
     * `convertFileSrc` —— 真壳里把绝对路径转成 `asset://` URL（由 Rust 侧协议处理）。
     *
     * 浏览器里没有那个协议，但 **Vite dev server 有 `/@fs/`**：
     * 它能服务项目根之外的绝对路径（实测 `GET /@fs/<abs>` → 200 + 正确的 content-type）。
     * 所以这里映射成 `/@fs<绝对路径>`，让所有 `<img :src="convertFileSrc(p)">` 都能出图。
     *
     * 逐段 encode：保住 `/` 分隔符，同时把空格、中文编码掉（`avatar/头像.webp` 这类路径
     * 直接拼进 URL 会失败）。
     */
    convertFileSrc: (p: unknown): string => {
      if (typeof p !== "string" || !p) return String(p ?? "");
      if (!p.startsWith("/")) return p; // 相对路径/URL 原样返回
      return "/@fs" + p.split("/").map(encodeURIComponent).join("/");
    },
    // 事件系统：假装订阅成功，但永不推送（我们没有真后端）
    plugin: undefined,
  };

  window.__LINGCHAT_WEB_MOCK__ = true;
  window.__LINGCHAT_WEB_MOCK_INFO__ = { httpBase: HTTP_BASE, startedAt: Date.now() };

  // ── ⚠️ 必须做的一步：把 URL 改写成根路径 ──────────────────────────────────
  // `webdev.html` 这个路径**不匹配任何路由**（router 是 history 模式），
  // 结果是 `<router-view>` 渲染空 → 看起来像"白屏"，但其实应用已经起来了。
  // 本文件比 `main.ts` 先执行（见 webdev.html 的加载顺序），所以在这里改写来得及 ——
  // 等 router 创建时看到的就已经是 `/` 了。
  if (typeof location !== "undefined" && /\/webdev\.html$/.test(location.pathname)) {
    const search = location.search || "";
    const hash = location.hash || "";
    history.replaceState(null, "", "/" + search + hash);
  }

  console.info(
    `%c[web-mock] 纯浏览器预览模式`,
    "background:#0ea5e9;color:#fff;padding:2px 6px;border-radius:3px",
    `\n  · isTauriRuntime() → false（走 HTTP 通路）` +
      `\n  · 世界地图后端：${HTTP_BASE}` +
      `\n  · 业务数据是【空值】，只能看布局/交互/动画，不能验证业务逻辑`
  );
}

installMock();

export {};
