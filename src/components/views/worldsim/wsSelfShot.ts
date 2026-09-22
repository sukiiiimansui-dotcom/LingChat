/**
 * wsSelfShot.ts —— 「**代拍**」：让页面**自己**把 WebGL 画布导成 PNG 回传。
 *
 * ## 为什么非得这样（2026-09-19 定下来的两条硬约束）
 * ① **agent 侧看不到 WebGL**：本机（Termux/Android）自动化 Chromium 的 GPU 上下文
 *    「首帧后必丢」—— 六种图形栈（headless_shell / 完整 Chromium / in-process-gpu /
 *    关看门狗 / Xvfb+ANGLE-GL / Xvfb+EGL / Xvfb+ANGLE-Vulkan）实测全一样。
 *    所以"好不好看"这件事，**agent 自己截不出来**。
 * ② **真机截屏通道被机主关闭**：机主 2026-09-19 原话「**不准让代理用 ADB！**」——
 *    因为 `adb screencap` 截的是**整屏**，会看到他屏幕上的一切（实测确实看到过他的
 *    未发送草稿，这就是那条红线的由来）。
 *
 * ⇒ 唯一同时满足"看得到真 GPU 画面"和"不侵犯隐私"的路：
 *    **页面自己 `canvas.toDataURL()`，POST 给本机收图服务**（`~/chk/shotd.py`，127.0.0.1:8789）。
 *
 * ## 两个前置条件（少一个就静默失败，都踩过）
 * · 地图必须 `preserveDrawingBuffer: true`（否则 toDataURL 拿到**空白**）；
 * · 跨域瓦片必须声明 `crossOrigin: "anonymous"`（否则画布被**污染**、toDataURL 抛 SecurityError）。
 */

/** 本机收图服务（`~/chk/shotd.py`） */
export const SHOTD = "http://127.0.0.1:8789/shot";

/**
 * 代拍的**开关**放在 `localStorage` 里，而不是 URL 参数。
 *
 * 为什么：小区级藏在 App 里（进入世界 → 选到小区级要点好几下），
 * URL 上带参数意味着"每一次跳转都要把参数传下去"；而 localStorage 是**跨页面、跨跳转**的
 * —— 机主只要事先打开一次带 `?autoshot=1` 的地址，之后**走到小区级就会自动拍**，
 * 不用为截图多做一个动作（他只要走到那儿就行）。
 */
export const AUTOSHOT_KEY = "wsm:v1:autoshot";

/**
 * 「**App 自拍**」的开关（`?selfshot=1`）—— 2026-09-21 加的**主 App 页**自拍通道。
 *
 * 和代拍页的区别（一句话）：代拍页是"**agent 给一个 URL，机主点开、拍完关掉**"；
 * App 自拍是"**机主在自己本来就在看的那个页面（`webdev.html` 那条路由）上刷新一次**"，
 * 走到小区级就自动拍 —— 把"点代拍页"这一步降成"刷新"。
 *
 * 为什么单独一个 key（不复用 `AUTOSHOT_KEY`）：两条通道要能**分别**开关，
 * 否则机主开着代拍页的开关时，App 页也会莫名其妙往服务器灌图。
 */
export const APPSHOT_KEY = "wsm:v1:selfshot";

/** 代拍开启了吗？（读失败一律当"没开" —— 隐私模式里 localStorage 会抛） */
export function selfShotArmed(): boolean {
  try {
    return !!localStorage.getItem(AUTOSHOT_KEY);
  } catch {
    return false;
  }
}

/** 关掉代拍：拍完就关，免得每次进出小区级都往服务器灌图 */
export function selfShotDisarm(): void {
  try {
    localStorage.removeItem(AUTOSHOT_KEY);
  } catch {
    /* 读不到就无所谓 */
  }
}

/** URL 里带了 `?autoshot=1` 就**顺手开启**代拍（机主只需要打开这一个网址） */
export function selfShotMaybeArmFromUrl(search?: string): boolean {
  try {
    const s = search ?? (typeof location !== "undefined" ? location.search : "");
    if (!/[?&]autoshot=1\b/.test(s)) return false;
    localStorage.setItem(AUTOSHOT_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一张 `data:image/png;base64,...` 发回收图服务。
 * 返回**是否成功**（失败不抛：截图只是验证手段，不该把页面搞崩）。
 */
export async function postShot(dataUrl: string, name: string): Promise<boolean> {
  try {
    if (!dataUrl.startsWith("data:image/png")) return false;
    const blob = await (await fetch(dataUrl)).blob();
    const r = await fetch(`${SHOTD}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: blob,
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 把一份 JSON **也**发到同一个收图服务（`~/chk/shotd.py`，落盘 `~/chk/live/*.json`）。
 *
 * 用途：光有图**说不清"样式到底加载成了什么样"**（图层有没有、paint 是什么值、
 * 地图库报没报错）—— 那些只有页面自己知道。图 + JSON 一起回来，agent 才不用猜。
 * 与图片同样的纪律：**失败不抛**（诊断设施不该把页面搞崩）。
 */
export async function postJson(obj: unknown, name: string): Promise<boolean> {
  try {
    if (!name.endsWith(".json")) name += ".json";
    const r = await fetch(`${SHOTD}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj, null, 2),
    });
    return r.ok;
  } catch {
    return false;
  }
}


/**
 * 时间戳（`MMDD-HHMMSS`，本机时区）—— 自拍的名字里要带它。
 * 为什么不用 `toISOString()`：文件名里出现 `:` 和 `T`/`Z` 又长又要转义，而 agent
 * 拿到文件第一眼想看的是"这是刚拍的还是十分钟前的"。
 */
export function shotStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** App 自拍图的名字：`app-selfshot-<时间戳>` */
export function appShotName(d: Date = new Date()): string {
  return `app-selfshot-${shotStamp(d)}`;
}

/** 样式自检 JSON 的名字：`style-<时间戳>.json` */
export function styleReportName(d: Date = new Date()): string {
  return `style-${shotStamp(d)}.json`;
}

/** 「App 自拍」开着吗？（与代拍同一套纪律：读失败一律当"没开"） */
export function appSelfShotArmed(): boolean {
  try {
    return !!localStorage.getItem(APPSHOT_KEY);
  } catch {
    return false;
  }
}

/** 拍完就关（`?selfshot=1` 的 URL 还在 ⇒ 下次刷新会重新开，这就是"刷新即拍"） */
export function appSelfShotDisarm(): void {
  try {
    localStorage.removeItem(APPSHOT_KEY);
  } catch {
    /* 读不到就无所谓 */
  }
}

/**
 * URL 里带了 `?selfshot=1` 就**顺手开启** App 自拍，并返回是否开了。
 *
 * 为什么和代拍一样把开关落进 localStorage：小区级藏在 App 里（进世界 → 走到小区要点好几下），
 * URL 参数在一次路由跳转后就没了；而 localStorage 是**跨页面、跨跳转**的
 * ⇒ 机主只要在**任意一页**带着 `?selfshot=1` 刷新一次，之后走到小区级就会自动拍。
 */
export function appSelfShotMaybeArmFromUrl(search?: string): boolean {
  try {
    const s = search ?? (typeof location !== "undefined" ? location.search : "");
    if (!/[?&]selfshot=1\b/.test(s)) return false;
    localStorage.setItem(APPSHOT_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** 睡一会儿（截图序列要等镜头动画停、瓦片补齐） */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 等"真的画完了"再按快门。
 *
 * 🔴 两条都是真踩过的：
 * ① `map.on("idle")` 只代表**瓦片/样式就绪**，WebGL 是双缓冲 —— 立刻 `toDataURL`
 *    可能拿到**还没提交的那一帧**（读出来是上一帧甚至空白）；
 * ② 所以 idle 之后**再等两帧 rAF**，让浏览器真的把这一帧合成出去。
 */
export async function settleForShot(
  m: { once(ev: string, cb: () => void): void; getCanvas(): HTMLCanvasElement },
  extraMs = 600
): Promise<void> {
  await new Promise<void>((res) => {
    let done = false;
    const fin = (): void => {
      if (!done) {
        done = true;
        res();
      }
    };
    try {
      m.once("idle", fin);
    } catch {
      /* 没有 idle 事件就直接往下走 */
    }
    setTimeout(fin, 5000); // 兜底：idle 一直不来也不能卡死
  });
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await sleep(extraMs);
}

/**
 * 画布是不是"**空白**"（近乎单色 / 全透明）？
 *
 * 为什么要自己判：`toDataURL` **不会**因为画面是空的而失败 —— 它老老实实给你一张
 * 全透明的 PNG，POST 也成功。于是"代拍成功"看起来一切正常，
 * 而 agent 收到的是三张纯白图（**2026-09-19 真的发生过，机主白点了一次**）。
 * ⇒ 空白**必须自己判出来**，并且**不许**把空白图当成功。
 */
export function canvasIsBlank(cv: HTMLCanvasElement): { blank: boolean; note: string } {
  return sampleCanvas(cv);
}

/**
 * 采样一块画布（8×8，**解码后的字节**）：给空白判定 + **alpha 统计**。
 *
 * 为什么要 alpha 统计：判"这块覆盖层是不是**不透明实心**、会不会挡住地图"要用它
 * （2026-09-21 两块覆盖层：`cursor-trail` 全透明属正常；天气那块"有内容"但要看清透不透）。
 */
export function sampleCanvas(cv: HTMLCanvasElement): {
  blank: boolean;
  note: string;
  aMin: number;
  aMax: number;
} {
  try {
    const s = 8; // 缩到 8×8 采样就够了（看的是"有没有内容"，不是细节）
    const t = document.createElement("canvas");
    t.width = s;
    t.height = s;
    const ctx = t.getContext("2d");
    if (!ctx) return { blank: false, note: "拿不到 2D 上下文，跳过空白判定", aMin: -1, aMax: -1 };
    ctx.drawImage(cv, 0, 0, s, s);
    const d = ctx.getImageData(0, 0, s, s).data;
    const v = blankFromSamples(d);
    let aMin = 255;
    let aMax = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]! < aMin) aMin = d[i]!;
      if (d[i]! > aMax) aMax = d[i]!;
    }
    return { ...v, aMin, aMax };
  } catch (e) {
    /* 抛 SecurityError = 画布被跨域瓦片污染（`crossOrigin` 没生效） */
    return {
      blank: false,
      note: `画布读取失败：${String((e as Error)?.name || e)}（多半是跨域污染）`,
      aMin: -1,
      aMax: -1,
    };
  }
}

/**
 * 空白判定的**唯一实现**（`canvasIsBlank` / `blankOfDataUrl` 都走这里，别各写一套）。
 *
 * 输入是一小片**解码后的 RGBA 字节**（8×8 就够：看的是"有没有内容"，不是细节）。
 * 判据两条，覆盖两种真的见过的空白：
 *   · `alpha` 全 0 —— 一帧都没渲染过（样式校验失败 ⇒ `load` 从未触发，实测过）；
 *   · RGB 极差 < 3（`alpha` 非 0）—— 不透明纯色（"整屏纯色"那次事故就是这条）。
 */
export function blankFromSamples(d: ArrayLike<number>): { blank: boolean; note: string } {
  let mn = 255;
  let mx = 0;
  let aMax = 0;
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (d[i + 3]! > aMax) aMax = d[i + 3]!;
    for (let k = 0; k < 3; k++) {
      const v = d[i + k]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (aMax === 0) return { blank: true, note: "整张画布 alpha=0（一帧都没渲染过）" };
  if (mx - mn < 3) return { blank: true, note: `近乎单色（RGB 极差只有 ${mx - mn}）` };
  return { blank: false, note: "" };
}

/**
 * 对**要发出去的那串字节**（`data:image/png;base64,...`）判空白 —— 解码回来再缩到 8×8 采样。
 *
 * 🔴 为什么不能只采样"活的画布"（`canvasIsBlank`）：**"画布上有内容"和"`toDataURL` 导出的是什么"
 * 可能不是同一帧** —— 2026-09-20 机主那次就是活的画布看着正常、导出的 PNG 全透明，
 * 自检漏判、三张白图照发（白点一次）。判据必须落在**真正要发出去的字节**上。
 */
export async function blankOfDataUrl(dataUrl: string): Promise<{ blank: boolean; note: string }> {
  if (!dataUrl || !dataUrl.startsWith("data:image/png")) {
    return { blank: true, note: "抓帧失败（没拿到 PNG）" };
  }
  return new Promise((res) => {
    const img = new Image();
    img.onerror = () => res({ blank: true, note: "抓到的数据不是能解码的 PNG" });
    img.onload = () => {
      try {
        const s = 8;
        const t = document.createElement("canvas");
        t.width = s;
        t.height = s;
        const g = t.getContext("2d");
        if (!g) return res({ blank: false, note: "拿不到 2D 上下文，跳过空白判定" });
        g.drawImage(img, 0, 0, s, s);
        res(blankFromSamples(g.getImageData(0, 0, s, s).data));
      } catch (e) {
        res({ blank: false, note: `解码/采样失败：${String((e as Error)?.name || e)}` });
      }
    };
    img.src = dataUrl;
  });
}

/**
 * 空白时回传一张**诊断图**（把状态写成字画在 2D canvas 上）。
 *
 * 为什么值得：白图什么都说明不了，而"诊断图"能让 agent 一眼看出卡在哪一步
 * （样式没加载？瓦片没到？取楼失败？）。机主只要点一次页面，信息量就够定位了。
 */
export function diagnosticPng(lines: readonly string[], title = "代拍空白 · 诊断"): string {
  const w = 900;
  const h = Math.max(200, 46 + lines.length * 30);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#0b1017";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#79d9ff";
  g.font = "bold 22px monospace";
  g.fillText(String(title).slice(0, 42), 18, 34);
  g.font = "17px monospace";
  lines.forEach((s, i) => {
    g.fillStyle = i === 0 ? "#ffcf8a" : "#eaf6ff";
    g.fillText(String(s).slice(0, 78), 18, 68 + i * 30);
  });
  return c.toDataURL("image/png");
}
