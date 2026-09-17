/**
 * usePhoneGeo.ts —— 手机应用共用的「定位 + 目的地候选 + 面积质心」
 *
 * ## 为什么抽出来
 * T5-2（地图/导航）先写了这套逻辑；T5-3（打车）要用**一模一样**的东西，
 * 而第三处（T5-4 公交/地铁）已经在排队 —— 与其抄两遍再分叉，不如现在就抽。
 *
 * ## 四个坑（都在这里，别在下游再踩）
 * 1. **没有「区县中心坐标」接口**：实测 `/api/blocks?ad=` 返回 `{ok:false}`、
 *    `/api/location?ad=` 会**忽略 ad** 直接返回本机定位 → 坐标只能由 GeoJSON 的**面积质心**算。
 * 2. **质心不能用顶点平均**：区县顶点分布极不均匀（海岸线密、内陆疏、还有小岛），
 *    顶点平均会被密集处**拽跑**（`wsgame` 的标注锚点就栽在这上面）。
 * 3. **目的地候选要逐级往上找**：`location()` 的 `path` 倒数第二级可能是中间层
 *    （实测 `"500100"`，它只有 1 个下级）→ 固定取那一级会让下拉框只剩一项、等于不可用。
 * 4. `location()` 的 `area` 对没反查到名字的层级会**原样吐 adcode**
 *    （`"中国·重庆市·500100·500102"`）→ 必须过滤纯数字段。
 *
 * ⚠️ 一切网络访问都走 `worldMap.ts` 的**双通路**（真壳 invoke / 浏览器 HTTP）。
 *    **绝不在这里直连 8791** —— 那是本地调试端口，装进 APK 必然失败。
 */
import { ref } from "vue";
import worldMapApi, { geoChildren, geoJson } from "@/api/services/worldMap";

export interface PhoneMe {
  lat: number;
  lng: number;
  area: string;
  leafAd: string;
}
export interface PhoneDest {
  name: string;
  adcode: string;
}

/** 多边形面积（带符号；取绝对值用于挑「最大的那个环」） */
function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    a += r[j] * r[i + 1] - r[i] * r[j + 1];
  }
  return a / 2;
}

/** GeoJSON 的环是 [[lng,lat],...] → 拍平成 [lng,lat,lng,lat,...] */
function flat(ring: number[][]): number[] {
  return ring.flatMap(([lng, lat]) => [lng, lat]);
}

/**
 * 取 GeoJSON 里**面积最大那个环**的**面积质心**（标准公式，不是顶点平均）。
 * @returns `[lng, lat]`；取不到返回 null
 */
export function centroid(geo: unknown): [number, number] | null {
  const g = (geo as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> })
    ?.features?.[0]?.geometry;
  if (!g?.coordinates) return null;
  const polys =
    g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]) || [];
  let best: number[] | null = null;
  let bestA = 0;
  for (const poly of polys) {
    for (const ring of poly) {
      const f = flat(ring);
      const a = Math.abs(ringArea(f));
      if (a > bestA) {
        bestA = a;
        best = f;
      }
    }
  }
  if (!best) return null;
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = best.length - 2; i < best.length; j = i, i += 2) {
    const f = best[j] * best[i + 1] - best[i] * best[j + 1];
    a2 += f;
    cx += (best[j] + best[i]) * f;
    cy += (best[j + 1] + best[i + 1]) * f;
  }
  a2 /= 2;
  if (Math.abs(a2) < 1e-12) return null;
  return [cx / (6 * a2), cy / (6 * a2)];
}

/** 显示用的地名：过滤掉纯数字段（那是没反查到名字的 adcode） */
export function prettyArea(area: unknown): string {
  const parts = String(area || "")
    .split("·")
    .map((x) => x.trim())
    .filter((x) => x && !/^\d+$/.test(x) && x !== "中国");
  return parts.join("·");
}

/**
 * 目的地候选：**从最近一级往上找**，取第一个能给出 ≥2 个下级的层级。
 * （固定取 `path` 倒数第二级会只剩 1 项 —— 见文件头第 3 条坑）
 */
export async function loadDestList(
  path: Array<{ adcode?: string }>,
  leaf: string
): Promise<PhoneDest[]> {
  for (let i = path.length - 1; i >= 0; i--) {
    const ad = String(path[i]?.adcode || "");
    if (!ad || ad === leaf) continue;
    try {
      const kids = (await geoChildren(ad)).filter((x) => String(x.adcode) !== leaf);
      if (kids.length >= 2) return kids;
    } catch {
      /* 这一级拿不到就继续往上。真壳里命令还没注册（见 worldMap.ts 的说明）→ 会一路走到空列表，
         此时界面显示「目的地列表拿不到」，不卡住、不白屏 */
    }
  }
  return [];
}

/** 手机应用通用的「定位 + 目的地候选」。 */
export function usePhoneGeo() {
  const me = ref<PhoneMe | null>(null);
  const destList = ref<PhoneDest[]>([]);
  const err = ref("");

  /** 一次性：定位 + 拉候选列表。失败写进 `err`，**不抛**（面板要能显示原因）。 */
  async function load(): Promise<void> {
    err.value = "";
    try {
      const loc = (await worldMapApi.location({ fast: true } as never)) as {
        lat?: number;
        lng?: number;
        area?: string;
        error?: string;
        path?: Array<{ adcode?: string; name?: string }>;
        leaf?: { adcode?: string };
      };
      if (loc?.error || !Number.isFinite(loc?.lat)) {
        err.value = "定位没结果（可以先用 IP 估测）";
        return;
      }
      const path = loc.path || [];
      const leaf = String(loc.leaf?.adcode || path[path.length - 1]?.adcode || "");
      me.value = {
        lat: loc.lat as number,
        lng: loc.lng as number,
        area: prettyArea(loc.area),
        leafAd: leaf,
      };
      destList.value = await loadDestList(path, leaf);
    } catch (e) {
      err.value = `定位失败：${e instanceof Error ? e.message : e}`;
    }
  }

  /** 目的地坐标（GeoJSON 面积质心）。 */
  async function destLatLng(ad: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const c = centroid(await geoJson(ad));
      return c ? { lng: c[0], lat: c[1] } : null;
    } catch {
      return null;
    }
  }

  return { me, destList, err, load, destLatLng };
}
