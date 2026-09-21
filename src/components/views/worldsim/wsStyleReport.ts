/**
 * wsStyleReport.ts —— 「**样式自检 JSON**」：页面把"我这儿的样式到底加载成了什么样"写成一份
 * JSON，和截图**同一轮**发回收图服务（`127.0.0.1:8789`，落 `~/chk/live/style-<时间戳>.json`）。
 *
 * ## 为什么光有图不够（2026-09-21 定的）
 * 一张图能说明"好不好看"，说不清"**为什么**"：
 *   · 样式加载成功了吗？`load` 触发过吗？
 *   · 那条 `fill-extrusion` 图层的 `color` 到底是什么表达式？栅格底图的不透明度是不是被压到 0 了？
 *   · 地图库偷偷报了错没有？（MapLibre 的错误**不冒泡成 JS 异常** —— 样式校验失败时它只发一个
 *     `error` 事件，然后 `load` **永远不触发**，屏幕全透明而控制台干干净净，我们被骗过一次。）
 *   · 现在走的是 WebGL 路还是 2D 降级路？夜色是哪一档？HUD 上写着什么？
 * ⇒ 这些**只有页面自己知道**，所以让页面自己报。agent 拿到「图 + JSON」才不用猜。
 *
 * ## 边界（重要）
 * 这一份**只读**：只 `getStyle()` / `getPaintProperty()` / 读页面状态，**不写任何样式**
 * （诊断设施绝不能改变被诊断的东西）。取值的动作由调用方通过 `paintOf` 注入 —— 这样
 * 本文件是**纯函数**，能在 Node 里全量自检（见 `ws_selfshot_selftest.mjs`）。
 */

/**
 * 「现在到底走的哪条渲染路」—— **五级共用同一个类型**（2026-09-21 机主：
 * 「要求别降级了，直接全面迭代（最新）」「整个世界模拟都必须最新」）。
 *   · `init`   还没分路（**不许猜**）
 *   · `webgl`  MapLibre 出帧了（正常路）
 *   · `waiting` 地图库还在加载（**没有降级**；页面保持加载态，后台每 5s 复查）
 *   · `failed`  始终没出帧 ⇒ **如实报错**（未降级、未画 2D），给「重试地图」
 *   · `fallback2d` 真的走了 2D 自绘（只应在 `?wsfallback=1` 或自动化兜底时出现）
 */
export type WsRenderPath = "init" | "webgl" | "waiting" | "failed" | "fallback2d";

/** 图层的最小形状（只要 id/type；其余字段不读，免得把整份 style 抄进 JSON） */
export interface StyleLayerLite {
  id?: string;
  type?: string;
}

/** 关键 paint：**看观感时会去查的那几个键**，别的键不抄（JSON 要能一眼读完） */
export const KEY_PAINT_KEYS: Record<string, readonly string[]> = {
  /* 楼体挤出：颜色 + 不透明度（"楼是不是一片死色""远景褪色对不对"就看这两个） */
  "fill-extrusion": ["fill-extrusion-color", "fill-extrusion-opacity", "fill-extrusion-height"],
  /* 栅格底图：不透明度是"地面糊不糊/压没压暗"的总闸（二次元在 z14.8 后把它淡出到 0） */
  raster: ["raster-opacity"],
  /* 路网：配色/线宽/不透明度（地面唯一的结构，主题切换时最容易静默不变） */
  line: ["line-color", "line-width", "line-opacity"],
};

/** 路网图层的 id 前缀（`wsRoads.roadLayerSpecs()` 生成的是 `road-casing-*` / `road-line-*`） */
export const ROAD_LAYER_PREFIX = "road-";

/** 这个图层要不要抄 paint？抄哪几个键？（纯函数 ⇒ 可断言） */
export function wantedPaintKeys(layer: StyleLayerLite): string[] {
  const type = String(layer.type || "");
  const id = String(layer.id || "");
  if (type === "line") {
    /* 线图层只抄**路网**（等高线/区界也在 line 里，全抄进来会把 JSON 灌满噪音） */
    return id.startsWith(ROAD_LAYER_PREFIX) ? [...(KEY_PAINT_KEYS.line || [])] : [];
  }
  return [...(KEY_PAINT_KEYS[type] || [])];
}

export interface StyleReportInput {
  /** 版本戳（与诊断图同一个 —— "是哪一版代码在跑"必须能对上） */
  build?: string;
  /** 页面地址（含 query：`?wstheme=` / `?wsnight=` / `?selfshot=` 都在上面） */
  href?: string;
  /** `map.isStyleLoaded()`（没有地图实例就是 null —— 降级路） */
  isStyleLoaded: boolean | null;
  /** `map.getStyle().layers`（没有地图实例就是空数组） */
  layers: StyleLayerLite[];
  /** 取 paint 值：`(layerId, key) => map.getPaintProperty(layerId, key)`；取不到返回 undefined */
  paintOf?: (layerId: string, key: string) => unknown;
  /** `map.on("error")` 收到的错误（一条一行，最多留 20 条） */
  errors: string[];
  /** 当前主题 id（`anime` / `night`） */
  wstheme: string;
  /** 夜色档：`on` / `off` + **实际生效的天黑程度**（0 = 白天逐字不变） */
  wsnight: { on: boolean; level: number; lowTier?: boolean };
  /** 画布尺寸 + dpr（截图比例那类事故的对照数据；`cssW/cssH` 是**布局尺寸**，两者不等很正常） */
  canvas: { w: number; h: number; dpr: number; cssW?: number; cssH?: number } | null;
  /** 走没走 2D 降级路，以及原因 */
  fallback: { used: boolean; why: string };
  /** 降级的**类别**（`temp` = 只是慢、可恢复；`perm` = 报错/拿不到 WebGL） */
  fallbackKind?: "none" | "temp" | "perm";
  /** 曾经降级、后来恢复回 WebGL 了吗 */
  recovered?: boolean;
  /** 地图库**真的出过一帧**没有（`m.on("render")`） */
  sawRender: boolean;
  /** HUD 上现在写着什么（机主看到的那一行） */
  hud: string;
  /** 组件里的 stats（`mode/count/roads/facilities/pins/note/fps…`） */
  stats?: Record<string, unknown>;
  /** 这一轮自拍的结果（图是不是空白、试了几次、等稳等了多久） */
  shot?: {
    name: string;
    blank: boolean;
    attempts: number;
    waitedMs: number;
    ready: boolean;
    note: string;
    posted: boolean;
  };
}

/** JSON 里不要出现 `undefined`（`JSON.stringify` 会把它**删掉**，读的人分不清"没有"和"没取到"） */
function j(v: unknown): unknown {
  return v === undefined ? null : v;
}

/**
 * 打一份样式自检报告。**纯函数**：同样的输入永远同样的输出（除了 `at` 时间戳）。
 *
 * 原则：**有多少给多少，不知道就写 null** —— 不许拿默认值假装读到了。
 */
export function buildStyleReport(i: StyleReportInput): Record<string, unknown> {
  const layers = Array.isArray(i.layers) ? i.layers : [];
  const ids = layers.map((l) => String(l.id || "?"));
  /** id → type（读 JSON 的人不用回头数图层） */
  const types: Record<string, string> = {};
  for (const l of layers) types[String(l.id || "?")] = String(l.type || "?");

  const keyPaints: Record<string, Record<string, unknown>> = {};
  for (const l of layers) {
    const id = String(l.id || "");
    const keys = wantedPaintKeys(l);
    if (!id || !keys.length) continue;
    const one: Record<string, unknown> = {};
    for (const k of keys) {
      let v: unknown;
      try {
        v = i.paintOf ? i.paintOf(id, k) : undefined;
      } catch (e) {
        v = `取值抛错：${String((e as Error)?.name || e)}`;
      }
      one[k] = j(v);
    }
    keyPaints[id] = one;
  }

  return {
    schema: "ws-style-report/v1",
    at: new Date().toISOString(),
    build: j(i.build ?? null),
    href: j(i.href ?? null),
    /* ① 样式 ② 图层与关键 paint */
    isStyleLoaded: i.isStyleLoaded,
    layers: { count: layers.length, ids, types },
    keyPaints,
    /* ③ 地图库报错（不冒泡成异常的那一类，只能靠这个事件捞） */
    errors: (i.errors || []).slice(0, 20),
    errorCount: (i.errors || []).length,
    /* ④ 主题 / 夜色档位（"我看到的是哪一版配色"） */
    theme: {
      wstheme: i.wstheme,
      wsnight: i.wsnight?.on ? "on" : "off",
      nightLevel: i.wsnight ? Number(i.wsnight.level.toFixed(3)) : null,
      lowTier: !!i.wsnight?.lowTier,
    },
    /* ⑤ 画布 + dpr（截图比例事故的对照数据：`w/h` 是像素、`cssW/cssH` 是布局尺寸，
       两者不一致是正常的（dpr）；但"布局尺寸对不对"决定了一眼能看多宽 —— 见 2026-09-16 那次误判） */
    canvas: i.canvas
      ? {
          w: i.canvas.w,
          h: i.canvas.h,
          dpr: i.canvas.dpr,
          cssW: j(i.canvas.cssW ?? null),
          cssH: j(i.canvas.cssH ?? null),
        }
      : null,
    /* ⑥ 走的哪条路（及原因）/ 首帧 / 降级类别与是否恢复 */
    fallback2d: { used: !!i.fallback?.used, why: String(i.fallback?.why || "") },
    fallbackKind: j(i.fallbackKind ?? "none"),
    recovered: !!i.recovered,
    sawRender: !!i.sawRender,
    /* ⑦ HUD 原话 + stats（机主看到的就是这一行，逐字带回来） */
    hud: String(i.hud || ""),
    stats: j(i.stats ?? null),
    shot: i.shot ? { ...i.shot } : null,
  };
}
