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

/* 🧪 App 自拍的开关：**只借这个纯函数**（键名/正则都在那边，别在这里再写一份字面量 —— 会漂移） */
import { appSelfShotMaybeArmFromUrl } from "@/components/views/worldsim/wsSelfShot";

declare global {
  interface Window {
    // ⚠️ 这里**不能**重新声明 `__TAURI_INTERNALS__` 的类型 ——
    //    `@tauri-apps/api` 已经把它声明成 `any` 了，再声明一次会撞
    //    TS2717（"Subsequent property declarations must have the same type"）。
    //    我们只声明自己新增的那两个。
    /** 前端可读：判断当前是不是 web 预览（供组件显示提示条用） */
    __LINGCHAT_WEB_MOCK_INFO__?: { httpBase: string; startedAt: number };
    /**
     * 预览专用：手动派发一个被监听的 Tauri 事件（返回实际投递的回调数）。
     *
     * 例：`__MOCK_FIRE__("scene:switch", { type: "scene_switch", scene: { background: null } })`
     */
    __MOCK_FIRE__?: (event: string, payload: unknown) => number;
  }
}

/** web 预览时的 HTTP 后端（就是那个独立 Rust 调试服务） */
const HTTP_BASE =
  (import.meta.env?.VITE_WORLD_MAP_API as string | undefined) || "http://127.0.0.1:8791";

/** 回调登记表：`@tauri-apps/api` 的 listen/Channel 靠它回传 */
const callbacks = new Map<number, (payload: unknown) => void>();
let callbackId = 0;

/**
 * 事件名 → 回调 id 列表（供 `__MOCK_FIRE__` 手动派发）。
 *
 * `listen()` 最后是 `invoke('plugin:event|listen', { event, handler: <callbackId> })`，
 * 所以能从**参数**里反查出「哪个回调属于哪个事件名」。没有这张表，
 * 事件驱动的分支（例如 `scene:switch` → 背景同步）在浏览器里**永远走不到**，
 * 只能在真机上验 —— 与「所有改动都要能第一时间在浏览器验证」直接冲突。
 */
const eventHandlers = new Map<string, number[]>();

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

  // ── 事件订阅：登记「事件名 → 回调 id」，供 __MOCK_FIRE__ 手动派发 ────────────
  // ⚠️ 必须放在下面 `plugin:` 那条兜底**之前** —— `plugin:event|listen` 也以
  //    `plugin:` 开头，否则会被当成普通插件命令返回 undefined，登记表永远是空的。
  if (cmd === "plugin:event|listen") {
    const ev = args?.event;
    const hid = args?.handler;
    if (typeof ev === "string" && typeof hid === "number") {
      const list = eventHandlers.get(ev) ?? [];
      list.push(hid);
      eventHandlers.set(ev, list);
    }
    return 1; // 假装拿到一个 eventId（unlisten 用不到）
  }
  if (cmd === "plugin:event|unlisten") return null;

  // 插件命令（`plugin:xxx|yyy`）：一律 undefined，调用方自己兜底
  if (cmd.startsWith("plugin:")) return undefined;

  // ── 语言词条：这是最巧的一处 ──────────────────────────────────────────────
  // `locales/index.ts` 调 `get_locale_messages(locale, seedContent)` 时**自己把
  // 完整的词条 JSON 传了进来**（`seedContent`），期望后端把它落盘再读回。
  // 我们直接回传 seedContent —— 于是浏览器里**四种语言都完整可用**，
  // 不会退化成"加载语言文件失败（使用内置词条）"。
  /* 🔴 `get_character_list`：**必须给真数据，不能给空数组**（2026-09-18，P2-5 代理发现的洞）。
   *
   * 现象：浏览器预览里地图上**恒 0 个角色**，所有"点头像开面板"的验证都做不了。
   * 根因：`loadWorldCharacters()` 只在**抛异常**时才往下一级兜底（HTTP `/api/schedule/chars`），
   *       而 mock 对未登记命令返回的是 `undefined`（不抛）→ 名单静默退化成"没人"。
   * 修法：这里直接**按真实后端的数据回**（调试服务 8791 的 `/api/schedule/chars`），
   *       拿不到才回空数组。这样预览里的角色名单与真机/后端**逐字一致**，
   *       不需要每个代理各自在 document-start 打补丁（P2-5 就是被迫这么干的）。
   */
  if (cmd === "get_character_list") {
    const pick = (j: unknown): unknown[] | null => {
      if (Array.isArray(j)) return j;
      const box = j as { characters?: unknown; items?: unknown };
      const arr = box?.characters ?? box?.items;
      return Array.isArray(arr) ? arr : null;
    };
    /* 🔴 形状必须与 `characterGetAll()` 的返回类型**逐字一致**
       （`CharacterPageResult` = `{ items, total, page, page_size, total_pages }`）。
       2026-10-01 实测（切片② 真页面验收代理发现）：这里原来回的是**裸数组**
       ⇒ `loadWorldCharacters()` 读 `res.items` 拿到 undefined ⇒ **预览里角色名单恒空**，
       地图上只剩 `roster:` 兜底钉、点谁都不能开面板（切片② 的 `+6` 因此一度没法验）。
       真机走 Tauri 真命令、**没有这个问题** ⇒ 这是**预览壳**的 bug，修这里不影响真机。 */
    const pageOf = (list: unknown[]) => ({
      items: list,
      total: list.length,
      page: 1,
      page_size: list.length || 6,
      total_pages: 1,
    });
    // ① 先试前端约定的那条（⚠️ 实测调试服务上**是 404**，见本文件末尾备注）
    try {
      const r = await fetch("http://127.0.0.1:8791/api/schedule/chars");
      if (r.ok) {
        const got = pick(await r.json());
        if (got) return pageOf(got);
      }
    } catch {
      /* 后端没起 → 往下试 */
    }
    // ② 兜底：`/api/schedule` 本来就带 `characters[]`（实测 3 个真实角色）
    try {
      const r2 = await fetch("http://127.0.0.1:8791/api/schedule");
      if (r2.ok) {
        const got2 = pick(await r2.json());
        if (got2) return pageOf(got2);
      }
    } catch {
      /* 纯静态预览：维持空名单，调用方的降级照旧 */
    }
    return pageOf([]);
  }

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
    // 事件系统：订阅会被登记（见 mockInvoke 的 `plugin:event|listen` 分支），
    // 真后端不存在，但可以用 `window.__MOCK_FIRE__` **手动**派发。
    plugin: undefined,
  };

  window.__LINGCHAT_WEB_MOCK__ = true;
  window.__LINGCHAT_WEB_MOCK_INFO__ = { httpBase: HTTP_BASE, startedAt: Date.now() };

  /**
   * 手动派发一个被 `listen()` 订阅过的事件。
   *
   * 回调收到的是 `@tauri-apps/api` 约定的完整 `Event` 对象（`{ event, id, payload }`），
   * 所以 `event.payload` 就是调用方传进来的 `payload` —— 与真壳的事件形状一致。
   */
  window.__MOCK_FIRE__ = (event: string, payload: unknown): number => {
    const ids = eventHandlers.get(event) ?? [];
    let delivered = 0;
    for (const id of ids) {
      const cb = callbacks.get(id);
      if (!cb) continue;
      cb({ event, id, payload });
      delivered++;
    }
    if (import.meta.env?.DEV) {
      console.debug(
        `[web-mock] __MOCK_FIRE__("${event}") → 投递 ${delivered}/${ids.length} 个回调`
      );
    }
    return delivered;
  };

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

  /**
   * 🧪 **App 自拍**的开关（`?selfshot=1`）必须在这里"落地"——**在应用启动那一刻**。
   *
   * 为什么不能只靠小区级组件自己读 URL：小区级藏在 App 里（进世界 → 走到小区要点好几下），
   * 而 URL 上的 query 在**一次路由跳转后就没了**。在这里把它写进 `localStorage`（sticky），
   * 机主就只需要"**在任意一页带着 `?selfshot=1` 刷新一次**"，之后走到小区级会自动拍
   * （触发点在 `WsDistrictMapLibre.vue`，两条渲染路都挂了）。
   *
   * ⚠️ 这是**自用层**（本文件只在纯浏览器预览入口 `webdev.html` 里加载，真壳 `index.html` 没有它），
   *    所以"给页面加一个调试开关"不会进 PR、也不影响真壳。
   */
  try {
    if (appSelfShotMaybeArmFromUrl(location.search || "")) {
      console.info(
        "%c[web-mock] App 自拍已开启（?selfshot=1）→ 走到小区级会自动抓一帧回传 127.0.0.1:8789",
        "color:#79d9ff"
      );
    }
  } catch {
    /* 隐私模式读不到 localStorage ⇒ 不自拍，页面照常用 */
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
