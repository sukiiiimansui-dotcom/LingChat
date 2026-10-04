/* wsViewFetch.ts —— M2：**取数 / 落地**（`PLAN-REFACTOR.md` §2.1 / §2.2 / §3 的 S4 行）。
 *
 * ## 这个文件是什么
 * 从 `WsDistrictMapLibre.vue` **整块搬出来**的那一段：现问 Overpass 的取楼/取路（含超时与重试）、
 * 第二数据源补缺（Overture）、路网与设施的两条 `load*ForView`。锚点（**函数名**，不按行号）：
 * `withTimeout` · `fetchBuildingsWithRetry` · `fetchRoadsWithRetry` · `overtureFill` ·
 * `loadRoadsForView` · `facLngLat` · `loadFacilities` · `loadBuildingsForView`。
 *
 * ## 挪了什么、没挪什么（照实留痕）
 * **搬进来的**：上面那八个函数，加上它们**自己拥有**的那几个量 —— `BLD_FETCH_MS` / `BLD_RETRIES`
 * （取数超时与重试次数）、`bldTries` / `bldFailedWhy` / `roadTries`（诊断读数）、`ovCache`（第二源
 * 前端缓存）、`lastBldKey` / `lastRoadKey`（"同一中心+半径不重复取"的去抖键）、`liveBldHits` /
 * `liveRoadHits` / `liveBldInfo` / `liveRoadInfo`（面板回证）、`FAC_COLOR_FALLBACK`、`BLD_ENOUGH`。
 * **故意留在宿主的**（这里一个字节都没动它们）：
 *   · `roadSegs` —— 路网段是**吸附/寻路**在吃（宿主 `snapToRoad`），`roadsFlush` 在写；不只是取数；
 *   · `LIVE_ON` / `bldLive` / `roadsLive` —— offline-first 的**决策**在真源 `wsScene.*LiveDecision`，
 *     宿主是它的调用者（与本模块无关）；本模块只读 `bldLive.live` / `roadsLive.live` 两个结论；
 *   · `liveRadiusFor` / `viewHalf` —— 半径规则全在真源 `wsScene.fetchRadiusForView`，宿主那两行是
 *     适配器，M2 只**转调**（判据同 §2.3：M* 里不许出现第二份半径规则）；
 *   · `bldStore` / `roadsStore` 与 `bldFlush` / `roadsFlush` —— 累积仓库与落图通路属于 M3
 *     （`wsBldLanding.ts`，S6 才搬）⇒ 本切片按 §2.2 由宿主**注入**，两个模块之间没有横向 import。
 *
 * ## ctx 的落法（与 S2/S3 同一套）
 * 宿主构造一份只读 ctx，本工厂在开头**解构一次**，解构出来的名字与搬走前宿主里的闭包变量**同名**
 * ⇒ 下面这些函数的**函数体一个字节都不用改**（对拍闸 `ws_viewfetch_move_selftest.mjs` 断言 diff = 0）。
 * ⚠️ 取值器而不是快照：`aliveNow()` 每次调用现读宿主那面 `alive` 旗（它是 `let`，卸载时置 false）
 *    —— 解构布尔会拿到**构造那一刻**的快照，之后永远为真（本文件对 TDZ/快照有过前科）。
 *
 * ## 🔴 唯一一处例外：`alive` → `aliveNow()`（10 处，逐处可数）
 * 搬走的函数体里原来直接写 `if (!alive) return;`。**JS 里布尔无法按引用共享**：传给模块的只能是
 * 取值器，而 `!取值器` 恒为 false（对象永真），所以要么改正文、要么在模块里再养一面旗（那是第二份
 * 真源，漂移了没人看得出来）。这里选**改正文**，并且只改这一种：
 *   · 判据（`!alive`）、时刻（同一个 await 之后）、顺序（一行都没挪）**逐字不变**，
 *     只是把"读哪个名字"从闭包变量换成**同一刻现读**的取值器调用 ⇒ 行为与搬走前**逐条等价**；
 *   · **不是**「形参默认值 = 调用那一刻现读」那种写法 —— 那个会把 `alive` 冻结在函数入口，
 *     于是"取数途中页面卸载了"这条早退（下面每一处 `if (!aliveNow()) return;` 就是为了它）
 *     会失效，那才是真的行为变化（S3 的 `startFps` 已经冻过一次，这里不重复）。
 * 对拍闸把这一条**机器化**：把模块侧文本的 `aliveNow()` 换回 `alive` 之后，抽块对拍 **diff 必须 = 0**，
 * 并断言替换处恰好 10 处（多一处少一处都红）。
 *
 * ## 装配位置（TDZ）
 * 宿主那处 `createViewFetch({…})` 必须在 `stats` / `bldLive` / `roadsLive` / `liveRadiusFor` /
 * `bldStore` / `roadsStore` **都声明之后**（它们是 `const`，早引必炸）；各函数只在 `onMounted`
 * 之后才被调用，所以调用点不受影响。
 */
import worldMapApi, { facilitiesAuto } from "@/api/services/worldMap";
import { mergeBuildingSources, shouldAskSecondSource, type BldFeature } from "./wsBuildingSources";
import { hash32 } from "./wsBuildingLook";
import { roadStatsLine } from "./wsRoads";
import { fetchRadiusLadder, WS_FETCH_R_BACKEND_MAX } from "./wsScene";
import { toLngLat, toXY } from "./wsSnap";
import type { BundleBuildingFeature, BundleRoadFeature } from "./wsOfflineFeed";
import type { BldMapLike, ViewFetchCtx } from "./wsStageTypes";

/**
 * 装配 M2（取数/落地）。
 * ⚠️ 位置见文件头「装配位置（TDZ）」那一段。
 */
export function createViewFetch(ctx: ViewFetchCtx) {
  /* 解构出来的名字**与搬走前宿主里的闭包变量同名** ⇒ 下面函数体一个字都不用动（见文件头）。 */
  const {
    stats,
    props,
    BLD_MIN_ZOOM,
    ROAD_MIN_ZOOM,
    BLD_SPARSE,
    bldLive,
    roadsLive,
    liveRadiusFor,
    bldStore,
    roadsStore,
    bldFlush,
    roadsFlush,
    aliveNow,
  } = ctx;

  /** 给现问 Overpass 的调用加超时上限：宁可显示取不到，也不能让界面无限转圈 */
  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_res, rej) => {
        window.setTimeout(() => rej(new Error(`取数超时（${ms / 1000}s）`)), ms);
      }),
    ]);
  }

  /* ── 🔴 取数超时与重试（2026-09-24，父会话定的下一刀）──────────────────────────
     为什么必须动：同一台后端实测**冷查 27~33s**（渝中 600m：buildings 27.3s / roads 32.5s），
     而原来 App 侧一刀切 **20s / 25s 且不重试** ⇒ **冷启动那次几乎必然整批丢**，
     屏幕上就是"一栋楼都没有 / 一条路都没有"，人只会以为"这一带没数据"。
     口径：**等够 + 重试 + 失败必须可见**（三态：失败 / 空数据 / 成功，不许混）。
     ⚠️ 这里只放宽"等多久"，**不改任何观感数值**；代价是冷启动那一次要等更久
        （loading 动画一直在转，且 HUD 会写等了多久）。 */
  const BLD_FETCH_MS = 55_000; // 单次上限（冷查实测最长 33s，留一倍余量）
  const BLD_RETRIES = 2; // 最多再试 2 次（第 2 次起后端多半已在写缓存 ⇒ 命中是毫秒级）
  /** 楼房取数试了几次（HUD/面板如实报 —— 只报"失败"看不出我们为此做了什么） */
  let bldTries = 0;
  /** 楼房取数失败的原因原文（超时/HTTP 码/后端 error） */
  let bldFailedWhy = "";

  /** 带重试的取楼：**失败必须能把原因带出去**（返回 null = 三次都没成） */
  async function fetchBuildingsWithRetry(
    lat: number | undefined,
    lng: number | undefined,
    r: number
  ): Promise<unknown | null> {
    let lastErr: unknown = null;
    for (let i = 0; i <= BLD_RETRIES; i++) {
      bldTries++;
      try {
        return await withTimeout(worldMapApi.buildings({ lat, lng, r }), BLD_FETCH_MS);
      } catch (e) {
        lastErr = e;
        /* 每次失败都写进 HUD 的 note 通道（`stats.note`）—— 面板展开就能看到"第几次、为什么" */
        const msg = String((e as Error)?.message || e || "").slice(0, 60);
        bldFailedWhy = msg;
        if (i < BLD_RETRIES) {
          stats.note = stats.note ? `${stats.note} · 取楼失败重试中（${i + 1}/${BLD_RETRIES}）` : `取楼失败重试中（${i + 1}/${BLD_RETRIES}）：${msg}`;
          /* 等 1.2s 再试：冷查那次后端往往正在写缓存，立刻重试会再排一次队 */
          await new Promise<void>((res) => window.setTimeout(res, 1200));
        }
      }
    }
    throw (lastErr as Error) || new Error("取楼失败（原因未知）");
  }

  /** 路网取数试了几次（HUD/面板如实报） */
  let roadTries = 0;

  /** 带重试的取路：与 `fetchBuildingsWithRetry` **同一口径**（等够 + 重试 + 失败带原因） */
  async function fetchRoadsWithRetry(lat: number, lng: number, r: number): Promise<unknown | null> {
    let lastErr: unknown = null;
    for (let i = 0; i <= BLD_RETRIES; i++) {
      roadTries++;
      try {
        return await withTimeout(worldMapApi.roads({ lat, lng, r }), BLD_FETCH_MS);
      } catch (e) {
        lastErr = e;
        const msg = String((e as Error)?.message || e || "").slice(0, 60);
        if (i < BLD_RETRIES) {
          stats.note = stats.note ? `${stats.note} · 路网取不到重试中（${i + 1}/${BLD_RETRIES}）` : `路网取不到重试中（${i + 1}/${BLD_RETRIES}）：${msg}`;
          await new Promise<void>((res) => window.setTimeout(res, 1200));
        }
      }
    }
    throw (lastErr as Error) || new Error("取路失败（原因未知）");
  }

  /**
   * **第二数据源补缺**（Overture Maps Buildings，ODbL）—— 「换源」那一刀。
   *
   * ## 为什么只在稀疏时才问
   * 渝中区 400m 就有 152 栋**带高度**的真楼；涪陵 400m 有 **0 栋**。
   * 第二源的角色是**补缺**而不是替换（机主原话：「有真数据用真的」）⇒
   * 够看的地方（≥ `BLD_SPARSE`）根本不发这个请求：既省一次 12MB/17s 的取数，
   * 也不会拿一层**没有高度**的脚印把本来有高度的真楼淹掉。
   *
   * ## 拿不到就当没有
   * 这个源是 Termux 上的 Python 服务（8792）。**真壳 APK 里没有 Python** ⇒ 必然失败。
   * 所以这里一律 `catch` 掉、返回 null，调用方照旧只用 OSM：
   * 少一层楼，但页面照常能玩（而且那时 AI 示意层会自动顶上，见 `aiOn`）。
   *
   * ## 缓存
   * 后端按 bbox 落盘缓存（同一 bbox 只打一次 S3），前端再记一层 `Map`：
   * 拖动时来回经过同一个位置不会重复打网络。
   */
  const ovCache = new Map<string, { features: BldFeature[]; note: string }>();

  async function overtureFill(
    lat: number,
    lng: number,
    r: number,
    osmCount: number
  ): Promise<{ features: BldFeature[]; note: string } | null> {
    if (!shouldAskSecondSource(osmCount, BLD_SPARSE)) return null;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(r)}`;
    const hit = ovCache.get(key);
    if (hit) return hit;
    try {
      /* 冷启动要现读 parquet（实测 13.5s 取数 + 建/载索引），给足 60s；
         热缓存是毫秒级。超时就当没有，别拖住整屏。 */
      const geo = await withTimeout(worldMapApi.overtureBuildings({ lat, lng, r }), 60000);
      if (!aliveNow()) return null;
      const feats = (geo?.features || []) as BldFeature[];
      const out = {
        features: feats,
        /* 署名是**硬要求**（ODbL）：不写来源就是违规使用，所以这句话跟着数据一起走 */
        note: `Overture 补缺 ${feats.length} 栋（© Overture Maps, ODbL）`,
      };
      ovCache.set(key, out);
      return out;
    } catch {
      /* 服务没起 / 真壳里没有 Python / 网络抖 —— 都不是错误，只是"没有第二源" */
      ovCache.set(key, { features: [], note: "" });
      return null;
    }
  }

  /* ── 🛣 路网：与楼房**同一套节奏**（视野算半径 / 去抖键 / 超时 / 如实上报）────
     为什么单独一个函数而不是塞进 loadBuildingsForView：
       · 两者的**触发条件不同** —— 楼在 z≥13.5 才取（亚像素没意义），
         而路在**更远**就该画出来（z12 起，路网是"地图的骨架"）；
       · 失败要能分别报（"楼取不到"和"路取不到"是两条不同的坏消息）。
     ⚠️ 后端是**现问 Overpass**（涪陵 800m 冷查询实测 14.7s，缓存命中 95ms）⇒
       必须有超时 + 按"中心+半径"去抖，别在拖动时反复打。 */
  let lastRoadKey = "";

  async function loadRoadsForView(m: BldMapLike): Promise<void> {
    if (!aliveNow()) return;
    /* 🔴 **默认根本不打 live**（offline-first）：决策在真源 `wsScene.roadsLiveDecision()`
       —— 冷查分钟级、600m 只有缓存命中才 0.1~1s，所以默认 0 条，路从**离线路网包**来；
       `?live=1` 才走这条（补新区域/调试），失败照旧**可见**。 */
    if (!roadsLive.live) return;
    const z = m.getZoom();
    if (z < ROAD_MIN_ZOOM) {
      stats.view = stats.view || "全区视野";
      return;
    }
    const c = m.getCenter();
    /* 半径**由真源算**（视野中心→角 与 zoom 档位取大者，夹到可用上限）—— 本组件不再有第二份 */
    const rp = liveRadiusFor(m);
    const r = rp.radius;
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r}`;
    if (key === lastRoadKey) return;
    lastRoadKey = key;
    liveRoadHits += 1; // 可数口径：这一轮真的发了一条 `/api/roads`
    try {
      /* 🔴 2026-09-24：与取楼同一口径 —— **放宽上限（25s → 55s）+ 重试 2 次 + 失败可见**。
         实测 `/api/roads` 渝中 600m **冷查 32.5s**（缓存命中 0.03s）⇒ 25s 那一刀必然砍掉冷查。
         路网是"地图的骨架"，它丢了比楼丢了更明显（父会话的诊断里 App 面板曾有 🛣118，那是缓存命中时）。 */
      const geo = (await fetchRoadsWithRetry(c.lat, c.lng, r)) as { type?: string; features?: unknown[] } | null;
      if (!aliveNow()) return;
      const fc = geo as { type?: string; features?: unknown[] } | null;
      const feats = (fc?.features || []) as BldFeature[];
      if (!feats.length) {
        /* 空结果**必须说出来**（同楼房的纪律：静默 = 让人以为"这里没路"）。
           ⚠️ 仓库里已有的**不清空**（累积语义：live 说的是"这一问回了 0 条"，不是"全都没有"）。 */
        stats.note = stats.note ? `${stats.note} · live 取路回来 0 条（r=${r}m）` : `live 取路回来 0 条（r=${r}m）`;
        liveRoadInfo = `r=${r}m（${rp.decidedBy}）· 0 条（已量）`;
        return;
      }
      /* 🧱 **并进同一个累积仓库**（不是整份替换）：换视野/换来源都不会"新的一来旧的没了" */
      roadsStore.merge(feats as unknown as BundleRoadFeature[], `live:${key}`);
      roadsFlush("live");
      /* `worldMapApi.roads()` 只解包 `geojson`（与 buildings 同一个壳），
         统计在**原始信封**里 ⇒ 这里显式放宽类型读一次；拿不到就给 null（HUD 会少一行统计，
         但**不会**编一个数字出来）。 */
      stats.roadNote = roadStatsLine((geo as { stats?: Record<string, unknown> } | null)?.stats ?? null);
      liveRoadInfo = `r=${r}m（${rp.decidedBy}${rp.limitWhy ? `，策略本想要 ${rp.want}m` : ""}）· ${feats.length} 条 · live 第 ${liveRoadHits} 条`;
    } catch (e) {
      const why = String((e as Error)?.message || e || "后端没响应").slice(0, 60);
      liveRoadInfo = `r=${r}m（${rp.decidedBy}）· 失败：${why} · 已试 ${roadTries} 次`;
      stats.note = stats.note ? `${stats.note} · 路网取不到（${why}，已试 ${roadTries} 次）` : `路网取不到（${why}，已试 ${roadTries} 次）`;
    }
  }
  /** 最近一次 live 取路的实况（面板回证；离线路走 `stats.roadStore` 那一行） */
  let liveRoadInfo = "";

  /* ── 🏪 设施（`/api/facilities`）→ MapLibre 圆点 ────────────────────────────
     机主 2026-09-20：「在地图上把**道路和设施**全部勾出来（方便将行人啥的挪出来）」。
     以前设施由旧的 DOM 层画（`WsFacilityLayer`），而那层在
     `districtUnderlayVisible=false` 的 `v-if` 里 ⇒ **小区级根本看不到**。
     这里把它迁到地图上（同一条渲染通路，缩放/倾斜/遮挡全都自洽）。

     🔴 坐标口径（这是最容易搞错的一步）：`/api/facilities` 给的是
     `gx/gy`（28×28 网格）+ **`cell_meters`（实测 30m）** ⇒ 它描述的是
     **28×30 = 840m 的一块街区**，不是整个区县。
     所以映射是「**以地图中心为原点的 840m 方格**」——
     要是像 AI 示意层那样铺到**区县 bbox**（几十公里）上，一格就是好几公里，
     又变成"一栋楼几百米宽"那类**尺度错**（那个坑已经踩过一次）。
     ⚠️ 由此**设施点是"示意布局"不是实测位置**，HUD 必须这么写（见 `facNote`）。

     ⚠️ 名称标注做不了：`symbol` 图层的 `text-field` **必须有 `glyphs`（字体服务）**，
     而我们的样式是**故意不带 glyphs** 的（引字体＝多一个外部依赖 + 多一次跨域）。
     所以名字走 HUD 的 `title`（悬停可看），地图上只画**分类配色**的圆点。 */
  const FAC_COLOR_FALLBACK = "#9fb4c8";

  /** 网格 → 经纬度（以 `center` 为原点的局部平面；网格 y 向下、纬度向北 ⇒ 要翻） */
  function facLngLat(gx: number, gy: number, center: [number, number], cellM: number, grid: number): [number, number] {
    const [cx, cy] = toXY(center, center[1]);
    const x = (gx + 0.5 - grid / 2) * cellM;
    const y = (grid / 2 - (gy + 0.5)) * cellM;
    return toLngLat([cx + x, cy + y], center[1]);
  }

  async function loadFacilities(m: BldMapLike): Promise<void> {
    if (!aliveNow()) return;
    const c = m.getCenter();
    const center: [number, number] = [c.lng, c.lat];
    try {
      const raw = await withTimeout(
        facilitiesAuto({
          area: props.area,
          size: 28,
          /* 种子**必须稳定**（后端注释里写死的约定）：传 `hash32(area)` ⇒ 刷新后设施位置不变。
             用随机种子的话每次刷新设施都搬家，玩家会以为地图坏了。 */
          seed: hash32(props.area || "ws"),
          level: "district",
        }),
        15000
      );
      if (!aliveNow()) return;
      const items = [...(raw?.facilities || []), ...(raw?.transport || [])] as unknown as Array<Record<string, unknown>>;
      const grid = Math.max(2, Number(raw?.grid) || 28);
      const cellM = Number(raw?.cell_meters) || 30;
      const feats = items
        .map((it) => {
          const gx = Number(it.gx);
          const gy = Number(it.gy);
          if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
          const col = Array.isArray(it.color) && it.color.length >= 3
            ? `rgb(${Number(it.color[0])},${Number(it.color[1])},${Number(it.color[2])})`
            : FAC_COLOR_FALLBACK;
          return {
            type: "Feature" as const,
            properties: {
              id: String(it.id || ""),
              name: String(it.name || ""),
              type: String(it.type || ""),
              typeZh: String(it.type_zh || ""),
              icon: String(it.icon || ""),
              group: String(it.group || "life"),
              color: col,
            },
            geometry: { type: "Point" as const, coordinates: facLngLat(gx, gy, center, cellM, grid) },
          };
        })
        .filter(Boolean);
      if (!feats.length) {
        stats.facNote = "设施：后端没有返回点位（如实说明，不编）";
        return;
      }
      const data = { type: "FeatureCollection", features: feats };
      if (m.getLayer("fac-dot")) {
        (m.getSource("fac") as { setData(d: unknown): void } | undefined)?.setData(data);
      } else {
        m.addSource("fac", { type: "geojson", data });
        /* 插在注记层之前（设施点不该盖住街名） */
        const before = m.getLayer("ref") ? "ref" : undefined;
        m.addLayer(
          {
            id: "fac-dot",
            type: "circle",
            source: "fac",
            /* 低 zoom 只留"主干类"（生活必需 + 交通节点）—— 整区视野下 43 个点会糊成一片 */
            minzoom: 13.2,
            filter: ["in", ["get", "group"], ["literal", ["life", "transport"]]],
            paint: {
              "circle-color": ["get", "color"],
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.2, 3, 15, 5, 17, 7],
              "circle-stroke-color": "#0b1017",
              "circle-stroke-width": 1.2,
              "circle-opacity": 0.95,
            },
          },
          before
        );
      }
      const byType: Record<string, number> = {};
      for (const f of feats) {
        const t = String((f as { properties: Record<string, unknown> }).properties.typeZh || "其他");
        byType[t] = (byType[t] || 0) + 1;
      }
      stats.facilities = feats.length;
      const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);
      /* ⚠️ 必须写"示意布局"：这些点的经纬度是**按 840m 方格摊出来的**，不是实测位置 */
      stats.facNote = `${feats.length} 个（示意布局 ${grid}×${cellM}m 方格）：${top.map(([k, v]) => `${k}${v}`).join(" ")}`;
    } catch {
      stats.facNote = "设施取不到（后端没响应或超时）";
    }
  }

  /**
   * 「像高德那样」的第二半：**放大到街区再取楼**，而且**取少了会自动放大再试**。
   *
   * 三步：
   *   ① 半径从**当前视野**算（见 `radiusForView`）；
   *   ② 楼太少（< `BLD_ENOUGH`）就翻倍再试一次，最多爬到 `BLD_R_MAX`，**命中即停**；
   *   ③ 全都试完还是空 ⇒ **如实写进 HUD**（试过哪些半径），绝不静默 ——
   *      静默正是"HUD 常显示 🏢 0 却没人知道为什么"的成因。
   *
   * ⚠️ 为什么要封顶（现在是 2000m）：**实测**（同一后端）
   *   · 涪陵驻地 400m→0 栋、600m→3、900m→18、1000m→21、1400m→29、**2500m→取不到**；
   *   · 渝中区驻地 400m→56、800m→232、**1200m→查询直接失败（Overpass 拖挂）**。
   *   ⇒ 半径越大越容易整条查询失败，而失败一次要等二十几秒。宁可"多爬两级"，
   *     也不要一次性甩一个 2500m 出去（那是**更慢而且更容易什么都没有**的选择）。
   *   2000m 是"实测能返回的里面最大的那一档"（涪陵 2000m→29 栋），再大就到失败区了。
   *
   * 同一个"中心+半径"不重复取（`lastBldKey`），避免拖动时把 Overpass 打爆。
   */
  async function loadBuildingsForView(m: BldMapLike): Promise<void> {
    if (!aliveNow()) return;
    /* 🔴 **默认根本不打 live**（offline-first）：决策在真源 `wsScene.bldLiveDecision()`
       —— 现场一次只覆盖 R≤2000m 且冷查 27~33s（最慢 91.7s），所以默认 0 条，楼从**离线楼房包**来；
       `?live=1` 才走这条（补新区域/调试），失败照旧**可见**。 */
    if (!bldLive.live) return;
    const z = m.getZoom();
    if (z < BLD_MIN_ZOOM) {
      stats.view = "全区视野";
      return;
    }
    const c = m.getCenter();
    /* 半径与阶梯**都由真源给**（`fetchRadiusForView` / `fetchRadiusLadder`，2km 起、封顶 8km）；
       后端单查还有硬闸 2000m ⇒ 每一级**夹一次**并把差异写进面板（策略要多少 / 源给不了多少）。 */
    const rp = liveRadiusFor(m);
    const r0 = rp.radius;
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${r0}`;
    if (key === lastBldKey) return;
    lastBldKey = key;
    liveBldHits += 1; // 可数口径：这一轮真的发了一条 `/api/buildings`

    const ladder = fetchRadiusLadder(z, rp.halfM);
    const asks: number[] = [];
    for (const r of ladder) {
      const a = Math.min(r, WS_FETCH_R_BACKEND_MAX);
      if (asks.indexOf(a) < 0) asks.push(a);
    }
    const tried: number[] = [];
    /** 一路记着"目前最好的一份"：后面某一级失败/更少时，不至于把手上的楼丢掉 */
    let best: { feats: BldFeature[]; r: number } | null = null;
    let failed = false;
    for (let i = 0; i < asks.length; i++) {
      const r = asks[i]!;
      tried.push(r);
      try {
        const geo = await withTimeout(worldMapApi.buildings({ lat: c.lat, lng: c.lng, r }), 25000);
        if (!aliveNow()) return;
        const feats = (geo?.features || []) as BldFeature[];
        if (feats.length > (best?.feats.length ?? 0)) best = { feats, r };
        if (feats.length >= BLD_ENOUGH) break; // 够看了，别再花时间
      } catch {
        failed = true;
        /* 这一级没拿到（超时/后端抖）就试下一级 —— 不因为一次失败就放弃整屏 */
      }
    }

    let features: BldFeature[] = best?.feats ?? [];
    if (!aliveNow()) return;
    if (!features.length) {
      /* 🔴 空结果**必须说出来**：不然就是"看起来卡住了/什么都没有" */
      stats.view = "街区视野";
      stats.note = failed
        ? `楼房数据取不到（已试 ${tried.join("/")}m）`
        : `OSM 在这一带没有登记楼房（已试 ${tried.join("/")}m）`;
      /* OSM 一栋都没有 = 最稀疏的情况 ⇒ 交给第二源补（拿不到就只留上面那句实话） */
      const fill0 = await overtureFill(c.lat, c.lng, best?.r ?? r0, 0);
      if (!aliveNow() || !fill0?.features.length) {
        liveBldInfo = `r=${r0}m（${rp.decidedBy}）· 0 栋（已量，试过 ${tried.join("/")}m）`;
        return;
      }
      liveBldInfo = `r=${r0}m（${rp.decidedBy}）· Overture 补缺 ${fill0.features.length} 栋`;
      bldStore.merge(fill0.features as unknown as BundleBuildingFeature[], `live:fill:${key}`);
        bldFlush("live-fill");
      stats.note = `${stats.note} · ${fill0.note}`;
      return;
    }
    /* 🆕 第二源补缺：OSM 不够看时才问（够看的地方一次网络都不发） */
    let fillNote = "";
    if (shouldAskSecondSource(features.length, BLD_SPARSE)) {
      /* 先如实说"正在补"，别让人对着不动的画面猜（这一问冷启动要十几秒） */
      stats.note = `真楼只有 ${features.length} 栋，正在取 Overture 补缺…`;
      const fill = await overtureFill(c.lat, c.lng, best!.r, features.length);
      if (!aliveNow()) return;
      if (fill?.features.length) {
        const mg = mergeBuildingSources(features, fill.features);
        features = mg.features as typeof features;
        fillNote = `${fill.note}（去重 ${mg.dropped}）`;
      } else {
        fillNote = "Overture 补缺不可用（只用 OSM）";
      }
    }
    /* 🧱 **并进同一个累积仓库**（不是整份替换）：live 与离线包走同一条落图通路（一次 `setData`） */
    bldStore.merge(features as unknown as BundleBuildingFeature[], `live:${key}`);
    bldFlush("live");
    liveBldInfo = `r=${r0}m（${rp.decidedBy}${rp.limitWhy ? `，策略本想要 ${rp.want}m` : ""}）· ${features.length} 栋 · live 第 ${liveBldHits} 条`;
    stats.view = "街区视野";
    const sparse = best!.feats.length < BLD_ENOUGH ? `楼房稀疏：半径已放大到 ${best!.r}m（试过 ${tried.join("/")}m）` : "";
    stats.note = [sparse, fillNote].filter(Boolean).join(" · ");
  }
  /** 最近一次 live 取楼的实况（面板回证；离线路走 `stats.bldBundle` 那一行） */
  let liveBldInfo = "";
  /**
   * "够看"的楼栋数（**只在 `?live=1` 这条兜底路里用**）：一屏想看到"成片"至少得有这么几栋，
   * 不到就沿阶梯放大再试一级。25 与代拍页 `loadForView` 里那个 `>= 25` **同值**（自检对拍）。
   * ⚠️ 默认路径（离线包）**不看这个数**：包里有多少画多少，格子按视野取。
   */
  const BLD_ENOUGH = 25;

  /** live 取数打了几条（**默认应当是 0**；`?live=1` 才是 1）—— 面板/自检的可数口径 */
  let liveBldHits = 0;
  let liveRoadHits = 0;

  /** 上一次取楼的"中心+半径"缓存键（相同就不重复请求） */
  let lastBldKey = "";

  /* 宿主在别处读/写的那几个读数（M2 是它们的所有者 —— 宿主侧只有"念出来"的出口）：
     · `bldTriesNow` / `bldFailedWhyNow` —— 面板那句"楼房取不到（…，已试 N 次）"；
     · `noteBldFailure` —— 宿主自己那条初始取楼路（`onMounted` 里也用 `fetchBuildingsWithRetry`）
       失败时把原因写进来，与上面那个 catch 用的是**同一个**变量；
     · `liveFacts` —— 面板的 `bundle.live` 那一行（`on` 由宿主自己拼，`LIVE_ON` 留在宿主）。 */
  return {
    withTimeout,
    fetchBuildingsWithRetry,
    fetchRoadsWithRetry,
    overtureFill,
    loadRoadsForView,
    facLngLat,
    loadFacilities,
    loadBuildingsForView,
    bldTriesNow: () => bldTries,
    bldFailedWhyNow: () => bldFailedWhy,
    noteBldFailure: (why: string) => {
      bldFailedWhy = why;
    },
    liveFacts: () => ({ bldHits: liveBldHits, roadHits: liveRoadHits, bldInfo: liveBldInfo, roadInfo: liveRoadInfo }),
  };
}
