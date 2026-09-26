/**
 * wsBuildingCard.ts —— 🪪 **信息卡**的唯一真源（数据部分 + 动效令牌）。纯逻辑：不碰 DOM、不碰地图、不联网。
 *
 * ## 为什么有这一份
 * 机主 2026-09-26 原话：「**每个名字和楼房都能点击查看信息**（要求有**精美的 mg 动画**）」。
 * 三条入口 —— **点楼体 / 点楼名 / 点区名** —— 弹的必须是**同一张卡**（`DESIGN-MG-MOTION.md` §4.4：
 * 「两个入口是同一"物种"，只有锚点不同」）。所以"卡片上写什么、字段从哪来、三态怎么判"
 * 只能有一处定义，否则立刻就是两套语言（这正是 PR 门禁 C1 判红的那种"第二份实现"）。
 *
 * ## 三态（机主要求"每栋楼都有名字"，而真名只覆盖 2.0% ⇒ 必须如实分三态）
 * | 态 | 什么时候 | 标题 | `sketch` |
 * |---|---|---|---|
 * | `real` | 有真名字（OSM `name` / Overture places 的 `n`） | **真名原样** | `false` |
 * | `generated` | 没真名，但**有稳定 id** ⇒ 由 `wsNameGen.genName(id)` 生成 | 「老街小面馆」… + 角标 **生成·示意** | `true` |
 * | `uncountable` | **连生成都拿不到**（没有 id） | 「名字数不出来」+ 原因 | `false` |
 * ⇒ 第三态是**必须存在**的：生成名由 `id` 决定（同 id 永远同名），没有 id 就只能如实说"数不出来"，
 *    **不许**退化成"随便起一个"（那会让每次刷新都换一个名字，比没有更糟）。
 *
 * ## 🔴 红线（写在代码里，谁都别绕）
 * 1. **生成名绝不进数据层、绝不进对话上下文** —— 本模块把它做成了**可执行的**：
 *    要喂给 LingChat / 日志 / 任何文本的地方**只准用 `cardChatText(d)`**，
 *    它会把生成名/示意名替换成「（生成·示意名，不入对话）」；`d.title` 只许上屏。
 * 2. 生成名与真名**样式不同 + 分开计数**（`sketch` / `titleTag` / `data-ws-card-source` 三个机器可判的标志位）。
 * 3. 高度三档如实标：`real`（OSM 真写了 height）/ `levels`（层数×3，也是 OSM 写的）/ `kind`（**我们按类型估的，不是真数据**）。
 * 4. 署名（ODbL）**只念包索引里的原话**（`cardAttributionOf`），取不到写"署名取不到"，**绝不编一句**。
 *
 * ## 动效令牌（`DESIGN-MG-MOTION.md` §4.3/§4.4，**只有这一处定义**）
 * 卡片 200ms / 内容 4 层每层 140ms、起于 60ms、错峰 30ms（总 290ms ≤ 450ms 预算）/ 退场 160ms /
 * 遮罩 160ms（退场晚 40ms）/ 生长位移夹紧 ±40px / 区名入口改"底部升起 24px"（时长曲线**同源**）。
 * 🔴 只动 `transform` / `opacity`（`CARD_ANIM_PROPS`）；**禁 `backdrop-filter`**（`worldsim.css` 低档显式 `none`）。
 */

import { ringCenter, ringsOf } from "./wsBuildingHint";
import { renderHeight } from "./wsBuildingLook";
import { WS_GEN_TAG, genName, type GenKind } from "./wsNameGen";
import type { ZoneName } from "./wsZoneNames";

/* ══ ① 动效令牌（**唯一来源**；自检钉：这些数字在别处不许出现第二遍） ═════════════════════ */

export const CARD_MOTION = {
  /* 入场（§4.3 ①） */
  enterMs: 200,
  enterScaleFrom: 0.88,
  /* 内容层（§4.3 ③）：4 层，起于 60ms，每层 140ms，错峰 30ms ⇒ 末层 150→290ms */
  contentMs: 140,
  contentStartMs: 60,
  contentStaggerMs: 30,
  contentLayers: 4,
  contentShiftPx: 6,
  /* 退场（§4.3 ④） */
  exitMs: 160,
  exitScaleTo: 0.96,
  exitShiftPx: 8,
  /* 遮罩（§4.3 ②）：纯色，**禁 backdrop-filter**；退场晚 40ms 收 */
  scrimMs: 160,
  scrimDelayMs: 40,
  scrimOpacity: 0.32,
  /* 生长原点夹紧（§4.3：不夹的话从屏幕角落点开会"飞"很长一段，像贴纸不像生长） */
  originClampPx: 40,
  /* 区名入口 = 底部升起（§4.4：方向可以不同，**节奏不许不同**） */
  sheetEnterY: 24,
  /* 命中区（UI-DESIGN-SPEC §六-5）：标签/楼体的可点区 ≥ 44×44 */
  minHitPx: 44,
  /* 降级（§4.3 降级表）：低档去掉位移、内容不分层；reduced-motion 纯淡入（保留终态） */
  lowEnterMs: 140,
  lowEnterScaleFrom: 0.96,
  lowContentMs: 120,
  lowContentStartMs: 40,
  reducedMs: 120,
  /* 曲线（§3.2 全项目只有两条） */
  easeEnter: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  easeLeave: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

/** 允许出现在动画里的属性（白名单；自检拿它抓"有人偷偷动 left/width/height"） */
export const CARD_ANIM_PROPS: readonly string[] = ["transform", "opacity"];

/** 卡片的 DOM 契约：**两条入口必须产出同一组**（§4.4 可自检项） */
export const CARD_DOM_ID = "ws-card";
export const CARD_DATA_ATTRS: readonly string[] = [
  "data-ws-card", "data-ws-card-kind", "data-ws-card-source", "data-ws-card-id",
];

/** 卡面文案（一处定义；i18n 由接入方统一收，这里先不碰 `src/locales/**`） */
export const CARD_STRINGS = {
  tagReal: "真名",
  tagSketch: WS_GEN_TAG,
  typeUnknown: "类型未登记",
  nameUncountable: "名字数不出来",
  nameUncountableWhy: "这栋楼连 id 都没有 —— 生成名必须由 id 决定（同 id 永远同名），凭空起一个会让每次刷新都换名字",
  heightReal: "真数据（OSM 写了 height）",
  heightLevels: "层数×3（OSM 写了层数，后端已折算）",
  heightKind: "**按类型估**（不是真数据：中国 OSM 楼高覆盖率只有一两成）",
  heightNone: "未登记",
  attrMissing: "署名取不到（包索引里没有 attribution）",
  chatSketchPlaceholder: "（生成·示意名，不入对话）",
  zoneReal: "真名区",
  zoneDerived: "数据驱动区",
  zoneSketch: "示意区",
} as const;

/* ══ ② 输入：一栋楼 / 一个真名点 / 一个区名 ═════════════════════════════════════════════ */

export type CardSubjectKind = "building" | "place" | "zone";

/** 楼：同时认 GeoJSON feature（现场 `/api/buildings`）与离线包记录 `{i,p}`（`bldbundle`） */
export interface CardBuildingInput {
  id?: string;
  properties?: Record<string, unknown> | null;
  /** GeoJSON geometry（Polygon/MultiPolygon）*/
  geometry?: unknown;
  /** 离线包记录的多边形坐标 `p`（`bldbundle` 的 `[[[lng,lat],…]]`） */
  p?: unknown;
  i?: string;
  lng?: number;
  lat?: number;
}

/** 真名点（`namesbundle` 的 `places[]` 单条；字段名逐字相同） */
export interface CardPlaceInput {
  n?: string;
  name?: string;
  k?: string;
  c?: string;
  p?: readonly number[];
  cf?: number;
  i?: string;
  id?: string;
  lng?: number;
  lat?: number;
}

export interface CardInput {
  kind: CardSubjectKind;
  building?: CardBuildingInput | null;
  place?: CardPlaceInput | null;
  /** 区名（`wsZoneNames.planZoneNames` 的产出之一） */
  zone?: ZoneName | null;
  /** 点中的屏幕坐标（算生长原点用；不传 = 不做生长，直接淡入） */
  click?: { x: number; y: number } | null;
  /** 卡片最终矩形（算生长原点用） */
  cardRect?: { x: number; y: number; w: number; h: number } | null;
  /** 包索引（**署名串从这里取原话**；楼包/名字包的 index.json 都认） */
  index?: { attribution?: string | null; source?: string | null; real?: boolean | null } | null;
  /** 生成名用的档（`wsNameGen`）；不传 = `shop` */
  genKind?: GenKind;
  /** 显式禁用生成名（调试/合规开关）；默认 `false` = 按机主要求"每栋都有名字" */
  noSketch?: boolean;
}

/* ══ ③ 输出：卡片字段 ═══════════════════════════════════════════════════════════════════ */

export type CardState = "real" | "generated" | "uncountable";
export type CardFieldTone = "real" | "sketch" | "muted" | "warn";

export interface CardField {
  key: string;
  label: string;
  value: string;
  tone?: CardFieldTone;
  /** 悬停解释（页面/App 都直接塞 `title`） */
  hint?: string;
}

export interface CardData {
  /** 主体类型：楼 / 真名点 / 区名 */
  kind: CardSubjectKind;
  /** 稳定 id（`osm_id` / 包里的 `i` / `zone:<格键>`）；数不出来 = `null` */
  id: string | null;
  state: CardState;
  /** 标题：真名原样 / 生成名 /「名字数不出来」 */
  title: string;
  /** 标题角标：「真名」/「生成·示意」/ null（第三态没有角标，因为它没有名字） */
  titleTag: string | null;
  /** 🔴 机器可判的"这是示意件"标志位（屏上样式必须与真名不同） */
  sketch: boolean;
  /** 类型（有则显示，无则 `CARD_STRINGS.typeUnknown`） */
  type: string;
  typeKnown: boolean;
  typeHint: string | null;
  /** 高度：`null` = 没这个数（不写 0 冒充） */
  height: number | null;
  heightText: string;
  heightFrom: "real" | "levels" | "kind" | "none";
  levels: number | null;
  lng: number | null;
  lat: number | null;
  /** 要渲染的行（顺序即上屏顺序；前 4 行进内容错峰的 4 层） */
  fields: CardField[];
  /** ODbL 署名原句（取不到 = null ⇒ 显示 `CARD_STRINGS.attrMissing`） */
  attribution: string | null;
  /** 一行依据（三态判词；HUD/tooltip 直接念它） */
  why: string;
  /** 卡片的 DOM 契约（两条入口同源） */
  domId: string;
  dataAttrs: Record<string, string>;
  /** 生长原点（有 click+cardRect 才算；否则 null = 纯淡入） */
  origin: CardOrigin | null;
}

export interface CardOrigin {
  dx: number;
  dy: number;
  clamped: boolean;
  /** 区名入口用"底部升起"（无 scale） */
  fromSheet: boolean;
}

/* ══ ④ 取数：id / 坐标 / 类型 / 高度（每个都"取不到就说取不到"） ═══════════════════════ */

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function fin(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 楼的稳定 id：`properties.osm_id` → `feature.id` → 离线记录的 `i` → 显式 `id` */
export function cardBuildingId(b: CardBuildingInput | null | undefined): string | null {
  if (!b) return null;
  const p = (b.properties || {}) as Record<string, unknown>;
  for (const v of [p.osm_id, p.id, b.id, b.i, p.i]) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}

/** 楼的代表点：显式 `lng/lat` → 环质心（`wsBuildingHint.ringCenter`，与挑楼/导出同口径） */
export function cardBuildingPoint(b: CardBuildingInput | null | undefined): [number, number] | null {
  if (!b) return null;
  const lng = fin(b.lng), lat = fin(b.lat);
  if (lng !== null && lat !== null) return [lng, lat];
  let rings: number[][][] = [];
  if (b.geometry) rings = ringsOf(b.geometry);
  else if (Array.isArray(b.p)) {
    const p = b.p as unknown[];
    /* 离线记录 `p` = Polygon 的 coordinates（`[[[lng,lat],…]]`）或 MultiPolygon（`[[[[…]]]]`） */
    rings = Array.isArray(p[0]) && Array.isArray((p[0] as unknown[])[0]) && Array.isArray(((p[0] as unknown[])[0] as unknown[])[0])
      ? (p as number[][][][]).map((q) => q[0]).filter(Boolean) as number[][][]
      : (p as number[][][]);
  }
  for (const r of rings) {
    const c = ringCenter(r);
    if (c) return c;
  }
  return null;
}

/** 类型：有则显示，无则"类型未登记"（**不猜、不硬塞一个"住宅"**） */
export function cardTypeOf(kind: CardSubjectKind, src: { building?: CardBuildingInput | null; place?: CardPlaceInput | null; zone?: ZoneName | null }): { type: string; known: boolean; hint: string | null } {
  if (kind === "zone") {
    const z = src.zone as ZoneName | null | undefined;
    if (!z) return { type: CARD_STRINGS.typeUnknown, known: false, hint: null };
    const how = z.source === "real" ? CARD_STRINGS.zoneReal : z.source === "derived" ? CARD_STRINGS.zoneDerived : CARD_STRINGS.zoneSketch;
    return { type: how, known: true, hint: z.why };
  }
  if (kind === "place") {
    const c = str(src.place?.c);
    const k = str(src.place?.k);
    if (!c && !k) return { type: CARD_STRINGS.typeUnknown, known: false, hint: null };
    return {
      type: c || k, known: true,
      hint: c && k ? `Overture 原始类别 ${c} · 粗类 ${k}` : (c ? "Overture 原始类别" : "Overture 粗类"),
    };
  }
  const p = (src.building?.properties || {}) as Record<string, unknown>;
  const kindV = str(p.kind) || str(p.subtype) || str(p.class);
  if (!kindV || kindV === "yes") return { type: CARD_STRINGS.typeUnknown, known: false, hint: kindV === "yes" ? "OSM 只写了 building=yes（没说是什么楼）" : null };
  return { type: kindV, known: true, hint: "来自 OSM `building=*`" };
}

/** ODbL 署名：**只念包索引里的原话**（取不到 = null，不编） */
export function cardAttributionOf(index: CardInput["index"]): string | null {
  const a = index && typeof index.attribution === "string" && index.attribution ? index.attribution : null;
  if (a) return a;
  const s = index && typeof index.source === "string" && index.source ? index.source : null;
  return s;
}

/* ══ ⑤ 卡片数据（三态 + 字段） ═════════════════════════════════════════════════════════ */

/**
 * 一栋楼 / 一个真名点 / 一个区名 ⇒ 卡片要显示的字段。**纯函数**（同输入同输出，可自检）。
 * 三态在 `state` / `titleTag` / `sketch` 上机器可判；`title` 永远是"屏上该显示的那个名字"。
 */
export function buildingCardData(input: CardInput): CardData {
  const kind: CardSubjectKind = input && input.kind ? input.kind : "building";
  const index = input ? input.index : null;
  const attribution = cardAttributionOf(index);
  const typeInfo = cardTypeOf(kind, { building: input?.building, place: input?.place, zone: input?.zone });

  /* —— 名字三态 —— */
  const realName = kind === "place"
    ? str(input?.place?.n ?? input?.place?.name)
    : kind === "zone"
      ? str(input?.zone?.name)
      : str(((input?.building?.properties || {}) as Record<string, unknown>).name);
  const id = kind === "place"
    ? (str(input?.place?.i || input?.place?.id) || null)
    : kind === "zone"
      ? (str(input?.zone?.id) || null)
      : cardBuildingId(input?.building);

  let state: CardState;
  let title: string;
  let titleTag: string | null = null;
  let sketch = false;
  let why = "";
  if (realName) {
    state = "real";
    title = realName;
    if (kind === "zone") {
      const z = input?.zone as ZoneName;
      sketch = !!z.sketch;
      /* 区名三档：真名 / 数据驱动 / 示意 —— **角标必须分开写** */
      if (z.source === "real") { titleTag = CARD_STRINGS.tagReal; why = z.why; }
      else if (z.source === "derived") { titleTag = "数据驱动"; why = z.why; }
      else { titleTag = CARD_STRINGS.tagSketch; why = z.why; }
    } else if (kind === "place") {
      titleTag = CARD_STRINGS.tagReal;
      why = `真名来自 Overture places（${str(input?.place?.k) || "粗类未登记"}）`;
    } else {
      titleTag = CARD_STRINGS.tagReal;                    // OSM 真的写了名字
      why = "真名来自 OSM `name`";
    }
  } else if (kind !== "place" && kind !== "zone" && id && !input?.noSketch) {
    /* 没真名但有**稳定 id** ⇒ 生成名（机主要求"每栋楼都有名字"；生成名由 id 决定，永远同名） */
    state = "generated";
    title = genName(id, input?.genKind || "shop");
    titleTag = CARD_STRINGS.tagSketch;
    sketch = true;
    why = `这栋楼**没有真名**（实测真名覆盖率只有 2.0%）⇒ 这是由 id 决定的**${WS_GEN_TAG}**名（同 id 永远同名），只上屏、不进数据与对话`;
  } else {
    /* 连生成都拿不到（没有 id）/ 或调用方显式禁用生成名 */
    state = "uncountable";
    title = CARD_STRINGS.nameUncountable;
    titleTag = null;
    sketch = false;
    why = input?.noSketch ? "调用方显式禁用生成名（noSketch）" : CARD_STRINGS.nameUncountableWhy;
  }

  /* —— 高度 / 层数（三档如实标；**没这个数就不写 0**）—— */
  let height: number | null = null;
  let heightFrom: CardData["heightFrom"] = "none";
  let levels: number | null = null;
  if (kind === "building") {
    const p = (input?.building?.properties || {}) as Record<string, unknown>;
    const src = str(p.height_src) || "default";
    levels = fin(p.levels);
    if (src === "height" || src === "levels") {
      const rh = renderHeight(p);
      height = Number.isFinite(rh.h) ? rh.h : null;
      heightFrom = src === "height" ? "real" : "levels";
    } else if (levels !== null && levels > 0) {
      heightFrom = "levels";
      height = Math.round(levels * 3 * 10) / 10;          // 与 `wsBuildingHint.METERS_PER_LEVEL` 同口径（3m）
    } else {
      const rh = renderHeight(p);
      height = Number.isFinite(rh.h) ? rh.h : null;
      heightFrom = height === null ? "none" : "kind";
    }
  }
  const heightText =
    height === null ? CARD_STRINGS.heightNone
      : heightFrom === "real" ? `${height} m · ${CARD_STRINGS.heightReal}`
        : heightFrom === "levels" ? `${height} m · ${CARD_STRINGS.heightLevels}`
          : `${height} m · ${CARD_STRINGS.heightKind}`;

  /* —— 坐标 —— */
  const ll = kind === "place"
    ? (fin(input?.place?.p?.[0]) !== null && fin(input?.place?.p?.[1]) !== null
      ? [Number(input?.place?.p?.[0]), Number(input?.place?.p?.[1])] as [number, number]
      : (fin(input?.place?.lng) !== null && fin(input?.place?.lat) !== null ? [Number(input?.place?.lng), Number(input?.place?.lat)] as [number, number] : null))
    : kind === "zone"
      ? (input?.zone && Number.isFinite(input.zone.lng) && Number.isFinite(input.zone.lat) ? [input.zone.lng, input.zone.lat] as [number, number] : null)
      : cardBuildingPoint(input?.building);
  const lng = ll ? +ll[0].toFixed(6) : null;
  const lat = ll ? +ll[1].toFixed(6) : null;

  /* —— 行（顺序即上屏顺序）—— */
  const fields: CardField[] = [];
  fields.push({ key: "name", label: "名字", value: title, tone: sketch ? "sketch" : state === "real" ? "real" : "muted", hint: why });
  if (titleTag) fields.push({ key: "nameSource", label: "名字来源", value: titleTag, tone: sketch ? "sketch" : "real", hint: why });
  fields.push({ key: "type", label: "类型", value: typeInfo.type, tone: typeInfo.known ? "real" : "muted", hint: typeInfo.hint || undefined });
  if (kind === "building") fields.push({ key: "height", label: "高度", value: heightText, tone: heightFrom === "kind" ? "warn" : heightFrom === "none" ? "muted" : "real", hint: heightFrom === "kind" ? CARD_STRINGS.heightKind : undefined });
  if (kind === "building" && levels !== null) fields.push({ key: "levels", label: "层数", value: String(levels), tone: "real", hint: "OSM `building:levels`" });
  if (kind === "place" && Number.isFinite(Number(input?.place?.cf))) {
    fields.push({ key: "cf", label: "置信度", value: Number(input?.place?.cf).toFixed(3), tone: Number(input?.place?.cf) >= 0.5 ? "real" : "warn", hint: "Overture `confidence`；运行期建议阈值 0.5" });
  }
  if (kind === "zone" && input?.zone) {
    const z = input.zone as ZoneName;
    const shareTxt = z.share === null ? "不适用（真名）" : `${z.count}/${z.total} = ${(z.share * 100).toFixed(1)}%`;
    fields.push({ key: "zoneDominant", label: "主导类占比", value: shareTxt, tone: z.source === "derived" ? "real" : z.source === "generated" ? "sketch" : "muted", hint: z.why });
    fields.push({ key: "zoneBbox", label: "范围", value: `[${z.bbox.join(", ")}]（${z.bbox[2] - z.bbox[0]}° 子格）`, tone: "muted", hint: "区名的作用范围 = 一个 0.01° 子格（≈1.1km）" });
  }
  fields.push({ key: "id", label: "id", value: id || "（无 id）", tone: id ? "real" : "warn", hint: id ? "稳定 id（生成名就是由它决定）" : "没有 id ⇒ 生成名也拿不到（第三态）" });
  fields.push({ key: "coord", label: "坐标", value: lng === null || lat === null ? "数不出来" : `${lng}, ${lat}`, tone: lng === null ? "muted" : "real" });
  fields.push({ key: "attribution", label: "署名", value: attribution || CARD_STRINGS.attrMissing, tone: attribution ? "muted" : "warn", hint: "数据合规项：原话来自包索引，不在代码里另写" });

  const origin = cardOriginOf(input?.click, input?.cardRect, kind === "zone");

  return {
    kind, id, state, title, titleTag, sketch,
    type: typeInfo.type, typeKnown: typeInfo.known, typeHint: typeInfo.hint,
    height, heightText, heightFrom, levels, lng, lat,
    fields, attribution, why, origin,
    domId: CARD_DOM_ID,
    dataAttrs: {
      "data-ws-card": kind,
      "data-ws-card-kind": kind,
      "data-ws-card-source": state,
      "data-ws-card-id": id || "",
    },
  };
}

/* ══ ⑥ 生长原点（§4.3 的 `(dx, dy)`；夹紧 ±40px） ═════════════════════════════════════ */

/**
 * 点击点 → 卡片的生长位移。
 * `dx = click.x − 卡片最终中心.x`，`dy` 同理；**夹紧到 ±`originClampPx`**（不夹的话从屏幕角落点开、
 * 卡片会"飞"很长一段，看起来像贴纸而不是从点击处长出来）。
 * 没有 click 或没有卡片矩形 ⇒ `null`（= 直接淡入，不做生长 —— 宁可少一个效果，不许猜一个原点）。
 */
export function cardOriginOf(
  click: { x: number; y: number } | null | undefined,
  cardRect: { x: number; y: number; w: number; h: number } | null | undefined,
  fromSheet = false,
): CardOrigin | null {
  if (!click || !cardRect) return null;
  const cx = Number(cardRect.x) + Number(cardRect.w) / 2;
  const cy = Number(cardRect.y) + Number(cardRect.h) / 2;
  if (![click.x, click.y, cx, cy].every((v) => Number.isFinite(Number(v)))) return null;
  const max = CARD_MOTION.originClampPx;
  const rawX = Number(click.x) - cx;
  const rawY = Number(click.y) - cy;
  const dx = Math.max(-max, Math.min(max, rawX));
  const dy = Math.max(-max, Math.min(max, rawY));
  return {
    dx: +dx.toFixed(2), dy: +dy.toFixed(2),
    clamped: Math.abs(rawX) > max || Math.abs(rawY) > max,
    fromSheet: !!fromSheet,
  };
}

/** 入场样式（页面/App 都拿它写 inline style；**只含 transform/opacity**） */
export function cardEnterStyle(o: CardOrigin | null): Record<string, string> {
  if (o && o.fromSheet) return { transform: `translate3d(0, ${CARD_MOTION.sheetEnterY}px, 0)` };
  if (o) return { transform: `translate3d(${o.dx}px, ${o.dy}px, 0) scale(${CARD_MOTION.enterScaleFrom})` };
  return { opacity: "0" };
}

/**
 * 卡片的**基准 transform**（居中）。🔴 生长位移是**相对**终态位置的增量，
 * 所以宿主写 inline `transform` 时必须把它拼在基准之后 —— 否则会把居中一起覆盖掉
 * （卡片会跳到屏幕左上角，看起来像"从角落飞出来"）。
 * 页面与 App **必须**都用 `cardComposeTransform()` 拼，别各写一遍字符串（那正是"两套语言"的开端）。
 */
export const CARD_BASE_TRANSFORM = "translate(-50%, -50%)";

/** 把基准居中与生长/升起分量拼成一个 transform（分量缺省 = `translate3d(0,0,0)`） */
export function cardComposeTransform(extra?: string | null): string {
  const e = String(extra || "").trim();
  return e ? `${CARD_BASE_TRANSFORM} ${e}` : `${CARD_BASE_TRANSFORM} translate3d(0, 0, 0)`;
}

/** 终态 transform（生长位移归零；必须显式写出来，否则卡片会停在被夹紧的位置上） */
export function cardRestTransform(): string {
  return cardComposeTransform("translate3d(0, 0, 0) scale(1)");
}

/** 退场 transform（§4.3 ④：`opacity → 0` + `scale → 0.96` + 下移 8px） */
export function cardExitTransform(): string {
  return cardComposeTransform(`translate3d(0, ${CARD_MOTION.exitShiftPx}px, 0) scale(${CARD_MOTION.exitScaleTo})`);
}

/* ══ ⑦ 进对话的文本（🔴 红线的**可执行**版本：生成名在这里被替换掉） ═════════════════ */

/**
 * 供**进对话/日志/上报**的纯文本。与前缀无关，只保证一件事：
 * **生成名/示意名绝不出现**（替换成 `CARD_STRINGS.chatSketchPlaceholder`）。
 * 屏上显示请用 `d.fields` / `d.title`；要喂给 LingChat 的一律走这个函数。
 */
export function cardChatText(d: CardData, opts: { header?: string } = {}): string {
  const head = opts.header || (d.kind === "place" ? "地点" : d.kind === "zone" ? "区域" : "楼房");
  const name = d.sketch ? CARD_STRINGS.chatSketchPlaceholder : d.title;
  const lines = [`${head}：${name}（${d.titleTag || "无名"}）`, `类型：${d.type}`];
  if (d.kind === "building") lines.push(`高度：${d.heightText}`);
  lines.push(`id：${d.id || "无"}`);
  if (d.lng !== null && d.lat !== null) lines.push(`坐标：${d.lng}, ${d.lat}`);
  if (d.attribution) lines.push(`署名：${d.attribution}`);
  return lines.join("\n");
}

/** 这一张卡能不能整体进对话（有生成/示意件 ⇒ 不能原样进，必须先过 `cardChatText`） */
export function cardIsChatSafe(d: CardData): boolean {
  return !d.sketch;
}

/* ══ ⑧ 判词（三态一行；HUD 直接念） ═════════════════════════════════════════════════════ */

export function cardVerdictLine(d: CardData): string {
  const tag = d.state === "real" ? "真名" : d.state === "generated" ? WS_GEN_TAG : "数不出来";
  if (d.state === "uncountable") return `🪪 卡片「${d.title}」（${tag}：${d.why.slice(0, 60)}）`;
  return `🪪 卡片「${d.title}」（${tag}）· 类型 ${d.type} · ${d.kind === "building" ? "高 " + d.heightText + " · " : ""}id ${d.id || "无"}`;
}
