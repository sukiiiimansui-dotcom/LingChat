/**
 * wsScene.ts —— 「**场景装配**」的**唯一真源**（2026-09-22，主会话要求：相机与图层装配不许有两份）。
 *
 * ## 为什么单独一个模块
 * 到这一步为止，"外观"已经统一了（`wsMapStyle` + `wsMapTheme`），但**相机默认值与图层装配**
 * 仍是两份：代拍页 `ws3dshow.html` 自己写 `zoom/pitch/bearing/maxPitch` 与 `before="bld-ext"`，
 * App 的小区级组件也各写一份 ⇒ 两边"看着像同一个东西"却会慢慢漂。
 * ⇒ 这里把三样抽出来（**只有数据与纯函数，不碰 DOM**）：
 *   ① `CAMERA_DEFAULTS` / `cameraDefaults()`：相机默认值与边界（含 `maxPitch: 70` —— 侧视角倍率爆炸的护栏）；
 *   ② `SCENE_LAYER_ORDER` / `sceneLayerPlan()`：图层**顺序与 before 关系**（路网 → 楼体 → 设施 → 注记）；
 *   ③ `sceneSelfReport()`：**自证**（面板/自检那一行读它 —— 换用没有生效，页面上一眼可见）。
 *
 * ⚠️ 纪律：**只有一份**。页面/组件**不许**再写 `pitch: 38` 这类字面量；
 *   要改默认相机，改这里的 `CAMERA_DEFAULTS`，两边一起变。
 */

/** 自证标记：谁产出了这份场景装配（面板读它） */
export const WS_SCENE_SOURCE = "wsScene.ts";

/** 相机默认值与边界（**唯一真源**；代拍页与 App 都从这里取） */
export interface SceneCamera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  minZoom: number;
  maxZoom: number;
  /** 🔴 70：能给天空，但到不了"只剩一条线"（侧视角拖动倍率爆炸的护栏） */
  maxPitch: number;
}

export const CAMERA_DEFAULTS: Readonly<SceneCamera> = {
  center: [116.2, 39.9], // 占位中心：真位置由定位/数据 bbox 决定
  zoom: 16.4, // 街区级（能看见楼体体量）
  pitch: 38, // 抬头能看见天空，又不至于把地面压扁
  bearing: -18, // 轻微斜角，楼有立体感
  minZoom: 3,
  maxZoom: 19,
  maxPitch: 70,
};

/** 取一份**可改的**相机默认值（调用方常要覆盖 center） */
export function cameraDefaults(): SceneCamera {
  return { ...CAMERA_DEFAULTS };
}

/** 图层**顺序**（自下而上；`group` 只是给人和自检看的名字） */
export interface SceneLayerPlanEntry {
  group: "roads" | "transport" | "buildings" | "labels";
  /** 该组里图层的 id 前缀（用于自检断言"实际图层属于哪一组"） */
  idPrefixes: readonly string[];
  /** 插到哪个图层**之前**（`null` = 追加到最上） */
  beforeId: string | null;
  why: string;
}

export const SCENE_LAYER_ORDER: readonly SceneLayerPlanEntry[] = [
  { group: "roads", idPrefixes: ["road-casing-", "road-line-"], beforeId: "bld-ext", why: "路是地面上的东西，压在楼上会像从楼顶穿过" },
  { group: "transport", idPrefixes: ["tf-"], beforeId: "bld-ext", why: "交通设施**贴在路之上**（先插路网、后插设施 ⇒ 设施在上）" },
  { group: "buildings", idPrefixes: ["bld-"], beforeId: null, why: "楼体在最上（数据层，交互载体）" },
];

/** 一份**可读的**层序计划（面板/自检显示它 ⇒ "同一份装配"可核对） */
export function sceneLayerPlan(): SceneLayerPlanEntry[] {
  return SCENE_LAYER_ORDER.map((e) => ({ ...e }));
}

/** 按 id 判断某个图层属于计划里的哪一组（`null` = 不在计划内，如底图/色罩/天空） */
export function sceneGroupOf(layerId: string): SceneLayerPlanEntry["group"] | null {
  const id = String(layerId || "");
  for (const e of SCENE_LAYER_ORDER) if (e.idPrefixes.some((p) => id.startsWith(p))) return e.group;
  return null;
}

/**
 * **自证**：这份场景装配来自哪一份实现？
 * @param consumed true = 调用方确实用了本模块（相机取自 `cameraDefaults()` 且层序取自 `sceneLayerPlan()`）
 */
export function sceneSelfReport(consumed: boolean): { source: string; ok: boolean; detail: string } {
  return consumed
    ? { source: WS_SCENE_SOURCE, ok: true, detail: `场景装配真源 = \`${WS_SCENE_SOURCE}\`（相机 + 层序都取自它）` }
    : {
        source: "（页面自带）",
        ok: false,
        detail: "**这一处还没换源**：相机/层序仍是页面里各写一份 —— 换用 `wsScene.ts` 后这行会变 ✅",
      };
}

/** 图层顺序是否**符合计划**（纯函数：拿实际图层 id 列表断言，页面与自检都用它） */
export function sceneOrderViolations(layerIds: readonly string[]): string[] {
  const out: string[] = [];
  const idx = (id: string): number => layerIds.indexOf(id);
  const firstOf = (g: SceneLayerPlanEntry["group"]): number => {
    const e = SCENE_LAYER_ORDER.find((x) => x.group === g)!;
    const positions = layerIds
      .map((id, i) => (e.idPrefixes.some((p) => id.startsWith(p)) ? i : -1))
      .filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : -1;
  };
  const roads = firstOf("roads");
  const tf = firstOf("transport");
  const bld = firstOf("buildings");
  if (roads >= 0 && tf >= 0 && roads > tf) out.push("路网被交通设施压在上面（应在下方）");
  if (roads >= 0 && bld >= 0 && roads > bld) out.push("路网被楼体压在上面（应在下方）");
  if (tf >= 0 && bld >= 0 && tf > bld) out.push("交通设施被楼体压在上面（应在下方）");
  void idx;
  return out;
}
