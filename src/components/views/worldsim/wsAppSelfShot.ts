/**
 * wsAppSelfShot.ts —— 「**App 页内建自拍**」：主 App 页（`webdev.html` 那条路由）带 `?selfshot=1`
 * 刷新一次，走到**小区级**、等地图**稳了**，页面自己 `toDataURL` 回传。
 *
 * ## 它补的是哪个盲区（2026-09-21）
 * 「能玩」闸门跑的是**无头浏览器** ⇒ 本机无头**没有 WebGL** ⇒ 闸门全程走的是 **2D 降级路**。
 * ⇒ **闸门全绿也看不到 WebGL 那条路的故障**（"整屏纯色"那次事故就是这么放到机主眼前的）。
 * 真机 WebGL 的画面**只有真机浏览器拍得出来**，而页面自己 `toDataURL` 是唯一
 * 既能看到真 GPU 画面、又不碰 `adb screencap`（会拍到机主整屏隐私）的通道 ——
 * 详见 `wsSelfShot.ts` 的文件头。
 *
 * ## 与"代拍页"（`public/ws3dshow.html` + `?autoshot=1`）的分工
 * | | 代拍页 | **App 自拍（本文件）** |
 * |---|---|---|
 * | 机主要做什么 | 打开 `/ws3dshow.html?autoshot=1&v=9` | 在**本来就在看的页面**上刷新一次 |
 * | 拍的是什么 | 调参台（自建 style、自定机位） | **真实产品页**（真主题、真图层、真降级逻辑） |
 * | 覆盖降级路 | ❌ 它自己就是那一页 | ✅ 降级了也拍（并如实标注"这是降级路"） |
 * ⇒ 修观感用代拍页，**验收"真 App 到底画出了什么"用 App 自拍**。
 *
 * ## 三条硬纪律（都在代码里守着）
 * ① **判空白用解码后的字节**（`blankOfDataUrl`），不是采样活画布 —— 两者可能不是同一帧；
 * ② **空白绝不回传纯色图**，回传**诊断图**（`diagnosticPng`），并在图上写明"WebGL 读回失败（第 N 次）"；
 * ③ 空白**同一轮再试一次**（Android 上 WebGL 缓冲区在 `idle`+两帧后常已被清空/未提交）。
 */
import {
  appSelfShotDisarm,
  appShotName,
  blankOfDataUrl,
  diagnosticPng,
  postJson,
  postShot,
  sleep,
  styleReportName,
} from "./wsSelfShot";

/** 地图实例的**最小**形状（只要这几样；写成 `any` 会丢掉"到底用了哪些 API"这条信息） */
export interface ShotMapLike {
  once?(ev: string, cb: () => void): void;
  off(ev: string, cb: () => void): void;
  triggerRepaint?(): void;
  isStyleLoaded?(): boolean;
  loaded?(): boolean;
  getStyle?(): { layers?: Array<{ id?: string; type?: string }> } | null;
  getZoom?(): number;
  getPitch?(): number;
}

/** 抓一张图那一轮的结果（要写进 HUD、诊断图与 JSON） */
export interface AppShotResult {
  /** 这一轮的名字（图 / JSON 用同一个时间戳） */
  name: string;
  /** 回传的图是**真画面**（false）还是**诊断图**（true） */
  blank: boolean;
  /** 试了几次（1 = 一次就成；2 = 空白后重试过） */
  attempts: number;
  /** 空白/失败的原因（成功时为空串） */
  why: string;
  /** 等到"稳"用了多久 */
  waitedMs: number;
  /** 数据到齐了吗（false = 超时照拍） */
  ready: boolean;
  /** 图发出去了吗 */
  posted: boolean;
  /** 📊 样式自检 JSON 发出去了吗（没传 `styleReport` 就是 null） */
  reportPosted: boolean | null;
}

export interface AppShotCtx {
  /** 走的是哪条渲染路 —— **必须如实带回来**（降级路的图和 WebGL 路的图长得完全不一样） */
  kind: "webgl" | "fallback2d";
  /** 降级原因（`kind === "fallback2d"` 时有意义） */
  fallbackWhy?: string;
  /** 取画布：**必须现取**（降级路会**换掉画布元素**，提前存的引用会拍到一块不在页面上的旧画布） */
  getCanvas: () => HTMLCanvasElement | null;
  /** 取地图实例（降级路为 null） */
  getMap: () => ShotMapLike | null;
  /** 出过首帧了吗（`m.on("render")` 记的 `sawRender`；降级路传 `() => true`） */
  sawFirstFrame: () => boolean;
  /** 数据到齐了吗（楼栋/路网/设施/角色 —— "有东西可看"） */
  dataReady: () => boolean;
  /** 数据现状的一句话（写进诊断图/HUD；超时时它就是"为什么图上没东西"的答案） */
  dataNote: () => string;
  /** 等数据的上限（真机 Overpass 冷查询实测 20~100s；无头/自动化短一些，免得拖死闸门） */
  waitMs: number;
  /** 写回 HUD（如实标注"已回传/空白"） */
  note: (s: string) => void;
  /** 版本戳（诊断图上要看得出**是哪一版代码在跑**） */
  build?: string;
  /**
   * 页面/组件还在吗？（`() => !alive`）
   *
   * 🔴 为什么必须有：等数据最长 45 秒，这段时间里机主可能**切走这一页**。
   * 不判它的话，`getCanvas()` 会返回 null ⇒ 走"没有画布"分支 ⇒
   * 回传一张写着"WebGL 读回失败"的诊断图 —— **那是假话**（真相是"这轮不拍了"）。
   * 如实优先：切走了就**什么都不发**，只在 HUD 留一句。
   */
  aborted?: () => boolean;
  /** 📊 样式自检包的输入（返回 null = 这一轮不发 JSON） */
  styleReport?: (shot: AppShotResult) => Record<string, unknown> | null;
}

/**
 * 在**渲染完成的那一刻**抓帧（不是"睡够了再抓"）。
 *
 * 🔴 为什么必须这样（Android 实测）：WebGL 是**双缓冲**，`idle` + 两帧 rAF + 700ms 之后
 * 缓冲区往往已经被清空/未提交 ⇒ `toDataURL` 拿到**全透明**（尺寸完全正常，极难发现）。
 * 做法：`triggerRepaint()` 之后在 `render` 回调里**立刻**抓。
 * 拿不到（没有 render / 超时）⇒ 退回直接 `toDataURL`（两条都失败就当空白，交给上层）。
 */
export async function captureOnRender(
  m: ShotMapLike | null,
  cv: HTMLCanvasElement,
  timeoutMs = 3000
): Promise<string> {
  const url = await new Promise<string>((res) => {
    let done = false;
    let onR: (() => void) | null = null;
    const fin = (v: string): void => {
      if (done) return;
      done = true;
      try {
        if (onR) m?.off?.("render", onR);
      } catch {
        /* 取消失败不影响结果 */
      }
      res(v);
    };
    onR = (): void => {
      try {
        fin(cv.toDataURL("image/png"));
      } catch {
        fin("");
      }
    };
    try {
      if (!m?.once || !m?.triggerRepaint) return fin("");
      m.once("render", onR);
      m.triggerRepaint();
    } catch {
      return fin("");
    }
    setTimeout(() => fin(""), timeoutMs);
  });
  if (url) return url;
  try {
    return cv.toDataURL("image/png");
  } catch {
    return "";
  }
}

/** 等"稳"：**首帧 + 数据到齐**，或者**超时**（超时也照拍，但如实记 `ready=false`） */
async function waitStable(ctx: AppShotCtx): Promise<{ ready: boolean; waitedMs: number }> {
  const t0 = Date.now();
  for (;;) {
    let ready = false;
    try {
      ready = ctx.sawFirstFrame() && ctx.dataReady();
    } catch {
      ready = false;
    }
    const waitedMs = Date.now() - t0;
    if (ready) return { ready: true, waitedMs };
    if (waitedMs >= ctx.waitMs) return { ready: false, waitedMs };
    await sleep(400);
  }
}

/** 诊断图上的几行字（**逐字为真**：不知道的写"未知"，不写"应该是"） */
function diagLines(ctx: AppShotCtx, why: string, attempts: number, r: { waitedMs: number; ready: boolean }): string[] {
  const m = ctx.getMap();
  const cv = ctx.getCanvas();
  const styleLayers = m?.getStyle?.()?.layers?.length;
  const head =
    ctx.kind === "webgl"
      ? `WebGL 读回失败（第 ${attempts} 次）：${why}`
      : `2D 降级路抓帧失败（第 ${attempts} 次）：${why}`;
  return [
    head,
    `渲染路=${ctx.kind}${ctx.fallbackWhy ? "（" + ctx.fallbackWhy + "）" : ""}${ctx.build ? " · 构建=" + ctx.build : ""}`,
    `样式已加载=${String(m?.isStyleLoaded?.() ?? "无地图")} 地图loaded=${String(m?.loaded?.() ?? "-")} 图层=${styleLayers ?? "无"} 条`,
    `画布=${cv ? cv.width + "x" + cv.height : "无"} dpr=${typeof devicePixelRatio === "number" ? devicePixelRatio : "?"}`,
    `首帧=${String(ctx.sawFirstFrame())} 等稳=${Math.round(r.waitedMs / 1000)}s 数据到齐=${String(r.ready)}`,
    `数据：${ctx.dataNote().slice(0, 60)}`,
  ];
}

/**
 * 跑一轮 App 自拍。**调用方必须已经确认开关是开的**（没开就别造这个函数 —— 它对页面零影响）。
 *
 * 顺序：等稳（首帧 + 数据，或超时）→ 抓帧 → **判空（解码后的字节）** →
 * 空白则**同一轮再试一次** → 两次都空白 ⇒ 回传**诊断图**（写明"WebGL 读回失败（第 N 次）"）。
 * 结束后**关掉开关**（不然每次进出小区级都往服务器灌图 —— 机主下次刷新会重新开）。
 */
export async function runAppSelfShot(ctx: AppShotCtx): Promise<AppShotResult> {
  const name = appShotName();
  const out: AppShotResult = {
    name,
    blank: false,
    attempts: 0,
    why: "",
    waitedMs: 0,
    ready: false,
    posted: false,
    reportPosted: null,
  };
  try {
    const stable = await waitStable(ctx);
    out.waitedMs = stable.waitedMs;
    out.ready = stable.ready;
    /* 等数据最长 45 秒 —— 机主可能已经切走了。切走了就**不发任何东西**（发了就是假证据） */
    if (ctx.aborted?.()) {
      out.why = "页面已切走/卸载，本轮不拍";
      ctx.note("自拍：页面已切走，本轮没拍（没发图）");
      appSelfShotDisarm();
      return out;
    }

    let dataUrl = "";
    let why = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      out.attempts = attempt;
      const cv = ctx.getCanvas();
      if (!cv) {
        why = "页面上没有画布";
        break;
      }
      dataUrl = await captureOnRender(ctx.getMap(), cv);
      const verdict = await blankOfDataUrl(dataUrl);
      why = verdict.note;
      if (!verdict.blank) {
        out.blank = false;
        break;
      }
      /* 空白 ⇒ **同一轮再试一次**（先让浏览器真的再合成一帧：两帧 rAF + 500ms）。
         第二次还是空白就不再试了 —— 那已经不是"时机没对上"，是这条读回通道本身拿不到。 */
      out.blank = true;
      if (attempt === 1) {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        await sleep(500);
      }
    }
    out.why = why;
    /* 一个字节都没抓到（没有画布 / toDataURL 抛）也算"空白" —— 语义是
       "**回传的不是真画面，是诊断图**"，调用方（和看 HUD 的人）不该以为拿到的是屏。 */
    if (!dataUrl) out.blank = true;
    if (ctx.aborted?.()) {
      /* 抓图过程中被切走：同样不发（"没有画布"≠"WebGL 读回失败"，别混为一谈） */
      out.why = out.why || "页面已切走";
      ctx.note("自拍：抓图时页面被切走，本轮没发图");
      appSelfShotDisarm();
      return out;
    }

    let payload = dataUrl;
    let payloadName = name;
    if (out.blank || !dataUrl) {
      /* 🔴 绝不把空白当成功：回传**诊断图**（纯色图/白图什么都说明不了，等于让机主白刷新一次） */
      const diag = diagnosticPng(
        diagLines(ctx, why || "没拿到 PNG", out.attempts, stable),
        ctx.kind === "webgl" ? "App 自拍 · 诊断（WebGL 读回失败）" : "App 自拍 · 诊断（2D 降级路）"
      );
      payload = diag;
      payloadName = `${name}-DIAG`;
    }
    out.posted = payload ? await postShot(payload, payloadName) : false;
    ctx.note(
      out.blank
        ? `自拍：空白（${why}，试了 ${out.attempts} 次）⇒ 已回传诊断图${out.posted ? "" : "（POST 失败）"}`
        : `自拍：已回传 ${payloadName}${out.posted ? "" : "（POST 失败）"}`
    );
  } catch (e) {
    out.why = `自拍自身出错：${String((e as Error)?.message || e)}`;
    ctx.note(`自拍失败：${out.why}`);
  }
  /* 📊 样式自检 JSON（与图同一轮、同一个时间戳；图挂了也照发 —— 它正是"图为什么是空的"的答案） */
  if (ctx.styleReport) {
    try {
      const rep = ctx.styleReport(out);
      out.reportPosted = rep ? await postJson(rep, styleReportName()) : null;
      if (rep && out.reportPosted === false) ctx.note("样式自检：POST 失败");
    } catch (e) {
      out.reportPosted = false;
      ctx.note(`样式自检打包失败：${String((e as Error)?.message || e)}`);
    }
  }
  appSelfShotDisarm();
  return out;
}
