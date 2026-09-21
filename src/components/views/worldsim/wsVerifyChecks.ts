/**
 * wsVerifyChecks.ts —— 「**验证面板**」脚下那套**能在浏览器里真跑**的自检。
 *
 * ## 为什么不是直接跑 `run-all-selftests.sh` 里那 20 多组
 * 那些是 **Node 脚本**（自己用 esbuild 打包 TS、`execFileSync` 起进程、读文件系统）——
 * 浏览器里**跑不了**，假装能跑就是骗人。所以这里只放**浏览器真的能断言**的那些：
 * 当前这张地图的渲染路 / 图层 / paint / 错误 / 画布 / 数据计数 / 定位来源。
 * 其余的（数值算法、后端、Rust）在面板里**如实列出命令**，让人在终端跑 —— 不冒充。
 *
 * ## 和样式自检 JSON 的关系
 * 两者吃**同一份快照**（`wsStyleReport.buildStyleReport` + 面板补的几个字段）：
 * JSON 是给 agent 的，这里是给**机主**看的 —— 同一件事，两种读者，不许各算一套。
 * 所以本文件是**纯函数**（没有 import 任何渲染代码），Node 自检也能直接跑。
 */
import type { StyleLayerLite } from "./wsStyleReport";

export interface VerifyCtx {
  /** 当前渲染路 */
  kind: "webgl" | "fallback2d";
  /** 降级原因**原文**（空串 = 没降级） */
  fallbackWhy: string;
  /** `map.isStyleLoaded()`（没有地图实例就是 null） */
  isStyleLoaded: boolean | null;
  /** 地图库真的出过一帧没有 */
  sawRender: boolean;
  /** 当前图层 */
  layers: StyleLayerLite[];
  /** **主题期望的**图层 id（`themeStyleParts(theme, low, 0).layers`）—— 用来查"图层齐不齐" */
  expectedLayerIds: string[];
  /** `map.on("error")` 收到的每一条（原文） */
  errors: string[];
  /** 画布：像素尺寸 + 布局尺寸 + dpr */
  canvas: { w: number; h: number; cw: number; ch: number; dpr: number } | null;
  /** 2D 降级路的 DPR 封顶（`?wsdpr=` 可覆盖；WebGL 路不适用 ⇒ null） */
  dprCap2d: number | null;
  /** 活画布判空的结果（`canvasIsBlank`） */
  canvasBlank: { blank: boolean; note: string } | null;
  /** 计数（**与 HUD 同源**：同一个 `stats` 对象，不许另开计数器） */
  counts: { buildings: number; roads: number; facilities: number; pins: number };
  /** 主题给的路网图层规格条数（`roadLayerSpecs(theme.road).length`） */
  roadSpecs: number;
  /** 性能低档 */
  capsLow: boolean;
  /** 主题 id（`anime` / `night`）—— 面板要显示"我看到的是哪一版配色" */
  wstheme: string;
  /** 夜色档：开关 + **实际生效的天黑程度**（0 = 白天逐字不变） */
  wsnight: { on: boolean; level: number };
  /** 定位来源（`useWorldSim.locSource`）：gps / ip / manual / restored / "" */
  locSource: string;
}

/** `ok`：true 过 / false 没过 / null **判不了**（"不知道"也是一种结论，不许写成通过） */
export interface VerifyResult {
  name: string;
  ok: boolean | null;
  detail: string;
}

/**
 * 面板要显示的一切（由 `WsDistrictMapLibre` 组装 —— **只有它知道真相**）。
 * 与样式自检 JSON 同源：`buildStyleReport` 那份 + 面板补的这几个字段。
 */
export interface VerifySnapshot extends VerifyCtx {
  /** 图层（带 id/type，缺 id 的不要） */
  layers: Array<StyleLayerLite & { id: string; type: string }>;
  /** 关键 paint：`{ 图层id: { paint键: 值 } }`（与样式 JSON 同一份取法） */
  keyPaints: Record<string, Record<string, unknown>>;
  /** 世界时间（如 `23:41 · 天黑 0.42`）；拿不到就是空串 */
  worldTime: string;
  /** HUD 原话（机主看到的那一行） */
  hud: string;
}

/**
 * 跑一遍面板自检。**逐字为真**：判不了的写 `null` + "判不了"，绝不用默认值凑通过。
 */
export function runVerifyChecks(c: VerifyCtx): VerifyResult[] {
  const R: VerifyResult[] = [];
  const push = (name: string, ok: boolean | null, detail: string): void => {
    R.push({ name, ok, detail });
  };

  /* ① 渲染路 —— **本次要修的那件事**就在这一条上 */
  if (c.kind === "webgl") {
    push("渲染路 = WebGL（MapLibre）", true, `样式已加载=${String(c.isStyleLoaded)} 首帧=${c.sawRender}`);
  } else {
    push(
      "渲染路 = WebGL（MapLibre）",
      false,
      `**走的是 2D 自绘降级路**（原因原文：${c.fallbackWhy || "未记录"}）；` +
        `降级时没有地图实例 ⇒ **拖动/缩放/旋转手势全部不可用**，画面像一张静态图`
    );
  }

  /* ② 地图库错误：**原文照抄**，这是"为什么降级"最常见的根因 */
  push(
    "地图库零错误（map.on('error')）",
    c.errors.length === 0,
    c.errors.length === 0 ? "一条都没报" : `${c.errors.length} 条：${c.errors.slice(0, 3).join(" ｜ ")}`
  );

  /* ③ 首帧 / ④ 样式加载 */
  push("出过首帧（m.on('render')）", c.sawRender, c.sawRender ? "出过" : "**一帧都没出**（画布上什么都可能没有）");
  push(
    "样式已加载（isStyleLoaded）",
    c.isStyleLoaded,
    c.isStyleLoaded === null ? "没有地图实例（降级路），判不了" : c.isStyleLoaded ? "已加载" : "**没加载**"
  );

  /* ⑤ 图层齐不齐（与主题期望对账 —— 少了哪几条直接列出来） */
  const have = new Set(c.layers.map((l) => String(l.id || "")));
  const missing = c.expectedLayerIds.filter((id) => !have.has(id));
  push(
    "主题图层齐（对账 themeStyleParts）",
    c.expectedLayerIds.length === 0 ? null : missing.length === 0,
    c.expectedLayerIds.length === 0
      ? "拿不到主题期望的图层（判不了）"
      : `实际 ${c.layers.length} 条 / 主题期望 ${c.expectedLayerIds.length} 条` +
        (missing.length ? ` · **缺**：${missing.join(",")}` : " · 一条不缺")
  );

  /* ⑥ 楼体挤出图层在不在（"工地只有底图没有楼"最直观的表现） */
  const hasBld = have.has("bld-ext");
  push(
    "楼体图层 bld-ext 在",
    c.kind === "webgl" ? hasBld : null,
    c.kind === "webgl"
      ? hasBld
        ? "在（`load` 里加上的）"
        : "**不在**：要么楼栋数据是 0 栋，要么 `load` 之后这一步抛了"
      : "降级路不建图层（判不了）"
  );

  /* ⑦ 画布非空白（用的是与自拍**同一个**判空实现） */
  push(
    "画布非空白",
    c.canvasBlank ? !c.canvasBlank.blank : null,
    c.canvasBlank ? c.canvasBlank.blank ? `**空白**：${c.canvasBlank.note}` : "有内容" : "拿不到画布"
  );

  /* ⑧ 尺寸 / dpr（截图比例那类事故的护栏；±2px 容忍取整） */
  if (c.canvas) {
    const want = Math.round(c.canvas.cw * c.canvas.dpr);
    const ok = Math.abs(c.canvas.w - want) <= 2;
    push(
      "画布像素 = 布局 × dpr",
      ok,
      `${c.canvas.w}×${c.canvas.h} 像素 / ${c.canvas.cw}×${c.canvas.ch} 布局 / dpr=${c.canvas.dpr}` +
        (ok ? "" : `（期望宽 ${want}）`)
    );
  } else {
    push("画布像素 = 布局 × dpr", null, "拿不到画布");
  }

  /* ⑨ 数据计数（**与 HUD 同源**；0 是合法结果，但要写清"可能是真没有"） */
  const sum = c.counts.buildings + c.counts.roads + c.counts.facilities + c.counts.pins;
  push(
    "地图上有东西（🏢/🛣/🏪/👤）",
    sum > 0,
    `🏢${c.counts.buildings} 🛣${c.counts.roads} 🏪${c.counts.facilities} 👤${c.counts.pins}` +
      (sum > 0 ? "" : " —— **四项全 0**：可能这一带真没有数据，也可能还没取回来（HUD 的 note 里有原因）")
  );

  /* ⑩ 路网规格（主题给的规格条数；0 = 主题侧空手，路一定画不出来） */
  push(
    "主题给出了路网规格",
    c.roadSpecs > 0,
    c.roadSpecs > 0 ? `${c.roadSpecs} 条规格` : "**0 条**：路网配色/线宽规格是空的（画不出来）"
  );

  /* ⑪ 定位来源：**必须写明**，IP 兜底时要说清"可能是 VPN/出口位置" */
  const loc = c.locSource || "";
  const locName =
    loc === "gps"
      ? "系统定位"
      : loc === "ip"
        ? "**IP 估测（城市级）** —— 可能是 VPN/网络出口位置，不一定是你人在的地方"
        : loc === "manual"
          ? "手动选择"
          : loc === "restored"
            ? "上次位置"
            : "**来源未知**（没记录到）";
  push("定位来源标注", loc ? (loc === "ip" ? false : true) : null, locName);

  /* ⑫ 性能档（低档会少画东西，是"如实降级"不是故障，所以只报事实不判失败） */
  push(
    "性能档 / 2D 画布 DPR",
    null,
    (c.capsLow ? "**低档**（软渲染/降级时被压下来的：少画描边、关毛玻璃、动画减半）" : "正常档") +
      (c.kind === "fallback2d"
        ? `；2D 画布 DPR 封顶=${c.dprCap2d ?? "?"}（真机 dpr=${c.canvas?.dpr ?? "?"}）` +
          ` ⇒ 约 ${c.canvas ? Math.round((c.canvas.w * c.canvas.h) / 1000) : "?"} 千像素/次重绘`
        : "")
  );

  return R;
}

/** 面板里"终端能跑、浏览器跑不了"的那部分 —— **如实列命令**，不假装跑过 */
export const TERMINAL_CHECKS: ReadonlyArray<{ name: string; cmd: string }> = [
  { name: "全部前端/Rust 自检（20+ 组）", cmd: "bash ~/chk/run-all-selftests.sh" },
  { name: "TypeScript 全量类型检查", cmd: "cd ~/lingchat-fork/v052 && npx vue-tsc --noEmit --skipLibCheck" },
  { name: "「能玩」闸门（无头，注意：**无 WebGL ⇒ 只跑 2D 降级路**）", cmd: "bash ~/chk/playable-gate.sh" },
];
