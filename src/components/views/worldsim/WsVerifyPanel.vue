<!--
  WsVerifyPanel.vue —— App 页里的「🔬 验证」面板（机主 2026-09-21 的硬要求：
  「**保证我们的全部验证功能在 App 页可全部看到喵！**」）。

  ## 为什么做在 App 页里，而不是再加一个测试页
  机主报的三个症状（「小区缩放竟然是图片」「压根划不了屏幕」「跟代拍页差太多」）
  全在 **App 页**，而当时的验证手段全在**别的页**（代拍页 `ws3dshow.html`）。
  ⇒ 验证必须长在**出问题的那一页**上，否则又是一轮"agent 以为验过了"。

  ## 它显示什么（都有出处，不许写死）
  · **渲染路**：WebGL / 2D 降级 + **降级原因原文**（看门狗期限、`map.on('error')` 文本）；
  · **地图库错误**：`map.on('error')` 每一条**原文**（P0 的根因就在这里）；
  · **图层面板**：图层 id 列表 + 关键 paint（楼体 color/opacity、底图 raster-opacity、路网）；
  · **场景**：wstheme / wsnight（开关 + 天黑程度）/ 世界时间 / 性能档 / DPR / 画布尺寸；
  · **数据计数**：🏢🛣🏪👤 —— 与 HUD **同源**（同一个 stats 对象，不另开计数器）；
  · **定位来源**：系统定位 / 手动选择 / IP 估测（**IP 兜底时明说可能是 VPN 出口**）；
  · **自检**：能在浏览器里真跑的那几条（见 `wsVerifyChecks.ts`），其余**如实列终端命令**；
  · **自拍**：一个按钮（拍到 `~/chk/live/`）+ 最近一次的结果。

  ## 边界
  面板**只读**：不写样式、不改相机、不动任何业务状态。唯一的"动作"是自拍（显式点击）。
-->
<template>
  <div class="wsv" :class="{ 'is-open': open }">
    <!-- 收起时只剩这个按钮（HUD 里的 + 面板的都用它，样式类名不同） -->
    <button class="wsv__fab" type="button" :title="open ? '收起验证面板' : '展开验证面板（🔬）'" @click="toggle">
      🔬<span v-if="!open && warnCount" class="wsv__dot">{{ warnCount }}</span>
    </button>

    <section v-if="open" class="wsv__box" role="region" aria-label="验证面板">
      <header class="wsv__hd">
        <b>🔬 验证面板</b>
        <span class="wsv__sub">{{ snap.level ? snap.level + " · " : "" }}{{ snap.kind === "webgl" ? "WebGL（MapLibre）" : snap.kind === "waiting" ? "等待引擎（未降级）" : snap.kind === "failed" ? "引擎没起来（未降级）" : "2D 降级路" }}</span>
        <button class="wsv__x" type="button" title="收起" @click="toggle">✕</button>
      </header>

      <!-- 🆕 机主 2026-09-21：「**要求别降级了**」⇒ 默认路是"等"和"如实报错"，不是"偷偷画 2D" -->
      <div v-if="snap.kind === 'waiting'" class="wsv__warn">
        <p>⏳ <b>地图库还在加载</b>（<b>没有降级</b>，也没有画 2D 假图）。页面保持加载态，后台每 5 秒复查，出帧即继续。</p>
        <p>① 原因原文：<b>{{ snap.fallbackWhy || "未记录" }}</b></p>
        <p>② 现状：样式已加载={{ String(snap.isStyleLoaded) }} · 出过帧={{ String(snap.sawRender) }} · 地图库错误 {{ snap.errors.length }} 条</p>
      </div>
      <div v-else-if="snap.kind === 'failed'" class="wsv__warn">
        <p>❌ <b>地图库始终没出帧</b>（<b>未降级、未画 2D</b> —— 机主要求"别降级了"）。</p>
        <p>① 原因原文：<b>{{ snap.fallbackWhy || "未记录" }}</b></p>
        <p>② 地图库错误 {{ snap.errors.length }} 条（<b>原文见下</b>）；这也是唯一能修的东西。</p>
        <p>③ 两条路：按「🔄 重试地图」重建；或加 <code>?wsfallback=1</code> 显式用 2D 自绘兜底（默认关）。</p>
        <p class="wsv__row">
          <button class="wsv__btn" type="button" :disabled="retrying" @click="retry">
            {{ retrying ? "重试中…" : "🔄 重试地图" }}
          </button>
        </p>
        <p v-if="retryMsg" class="wsv__none">{{ retryMsg }}</p>
      </div>

      <!-- 降级横幅：机主就是被这条误导过（"像图片""划不动""很卡"）⇒ 必须写在最上面，
           而且**三段都要写全**：①为什么降级 ②临时还是永久 ③手势不可用（主会话 2026-09-21 的硬要求） -->
      <div v-if="snap.kind !== 'webgl'" class="wsv__warn">
        <p>
          ⚠️ 现在走的是 <b>2D 自绘降级路</b>。① 原因：<b>{{ snap.fallbackWhy || "未记录" }}</b>
        </p>
        <p>
          ② 类别：
          <b v-if="snap.fallbackKind === 'temp'">临时类</b>
          <b v-else-if="snap.fallbackKind === 'perm'">永久类</b>
          <b v-else>未知</b>
          <template v-if="snap.fallbackKind === 'temp'">
            —— 地图库**没报错**，只是慢。实例还在后台渲染，**一出帧就自动切回 WebGL**（届时手势恢复），
            不用你做任何事；实在想催一下就按下面「重试地图」。
          </template>
          <template v-else-if="snap.fallbackKind === 'perm'">
            —— 地图库**报了错**（原文见下「地图库错误」）或拿不到 WebGL / 实例，
            这类不会自己好；修掉那个错之前，按「重试地图」也只能重载这一页。
          </template>
        </p>
        <p>③ <b>拖动 / 缩放 / 旋转手势全部不可用</b>（主容器上只有自绘画布），所以看着像一张静态图。</p>
        <p class="wsv__row">
          <button class="wsv__btn" type="button" :disabled="retrying" @click="retry">
            {{ retrying ? "重试中…" : "🔄 重试地图" }}
          </button>
          <span class="wsv__sub">先按恢复判据试一次；实例没了才重载页面</span>
        </p>
        <p v-if="retryMsg" class="wsv__none">{{ retryMsg }}</p>
      </div>
      <p v-else-if="snap.recovered" class="wsv__warn wsv__warn--ok">
        ✅ <b>曾降级到 2D，地图库出帧后已自动切回 WebGL</b>（手势已可用，低档也已解除）。
      </p>

      <!-- ① 自检（浏览器里真跑的） -->
      <h4>自检（本页当场跑）<button class="wsv__btn" type="button" @click="rerun">重跑</button></h4>
      <ul class="wsv__list">
        <li v-for="r in checks" :key="r.name" :class="r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'unk'">
          <span class="wsv__ico">{{ r.ok === true ? "✅" : r.ok === false ? "❌" : "❓" }}</span>
          <span class="wsv__nm">{{ r.name }}</span>
          <span class="wsv__dt">{{ r.detail }}</span>
        </li>
      </ul>

      <!-- 🔄 画布重算（2026-09-21 真机"画布 300×150"事件的**定位工具**：
           点一下就知道 resize 能不能治好，日志能分清"没调到"和"调了没生效"） -->
      <h4>画布重算 <em>实际 vs 期望（布局 × dpr）</em></h4>
      <p class="wsv__row">
        <button class="wsv__btn" type="button" @click="forceResize">🔄 强制重算画布</button>
        <span class="wsv__sub">
          {{ snap.canvas ? `实际 ${snap.canvas.w}×${snap.canvas.h} · 期望 ${Math.round(snap.canvas.cw * snap.canvas.dpr)}×${Math.round(snap.canvas.ch * snap.canvas.dpr)}` : "拿不到画布" }}
        </span>
      </p>
      <p v-if="resizeMsg" class="wsv__none">{{ resizeMsg }}</p>
      <ul v-if="snap.resizeLog && snap.resizeLog.length" class="wsv__list">
        <li v-for="(r, i) in snap.resizeLog" :key="i" class="unk">
          <span class="wsv__ico">📐</span><span class="wsv__dt">{{ r }}</span>
        </li>
      </ul>

      <!-- ①.5 一键复制（机主排障用：**不用截图**，按一下再粘给 agent 就是全部原文） -->
      <h4>复制诊断 <em>降级原因 + 地图库错误原文 + 关键指标</em></h4>
      <p class="wsv__row">
        <button class="wsv__btn" type="button" @click="copyDiag">{{ copied ? "✅ 已复制" : "📋 复制诊断文本" }}</button>
        <span class="wsv__sub">复制不了就在下面框里全选（长按）复制</span>
      </p>
      <textarea ref="diagEl" class="wsv__ta" readonly rows="4" :value="diagText"></textarea>

      <!-- ② 地图库错误（原文） -->
      <h4>地图库错误 <em>map.on('error') 原文</em></h4>
      <p v-if="!snap.errors.length" class="wsv__none">一条都没报（这本身是好消息，但也可能是"错误没接到"）</p>
      <ul v-else class="wsv__list">
        <li v-for="(e, i) in snap.errors" :key="i" class="bad">
          <span class="wsv__ico">❌</span><span class="wsv__dt">{{ e }}</span>
        </li>
      </ul>

      <!-- ③ 渲染路 / 场景 -->
      <h4>渲染路与场景</h4>
      <dl class="wsv__kv">
        <dt>渲染路</dt>
        <dd>{{ snap.kind === "webgl" ? "WebGL（MapLibre）" : "2D 降级路" }}</dd>
        <dt>降级原因原文</dt>
        <dd>{{ snap.fallbackWhy || "（没降级）" }}</dd>
        <dt>样式已加载 / 首帧</dt>
        <dd>{{ String(snap.isStyleLoaded) }} / {{ String(snap.sawRender) }}</dd>
        <dt>主题 / 夜色</dt>
        <dd>{{ snap.wstheme }} / wsnight={{ snap.wsnight.on ? "on" : "off" }}（level={{ snap.wsnight.level }}）</dd>
        <dt>世界时间</dt>
        <dd>{{ snap.worldTime || "（拿不到）" }}</dd>
        <dt>性能档</dt>
        <dd>{{ snap.capsLow ? "低档（少画描边等）" : "正常档" }}</dd>
        <dt>画布 / DPR</dt>
        <dd>{{ snap.canvas ? `${snap.canvas.w}×${snap.canvas.h} 像素 · ${snap.canvas.cw}×${snap.canvas.ch} 布局 · dpr=${snap.canvas.dpr}` : "（拿不到）" }}</dd>
        <dt>数据计数</dt>
        <dd>
          {{ snap.counts ? `🏢${snap.counts.buildings} 🛣${snap.counts.roads} 🏪${snap.counts.facilities} 👤${snap.counts.pins}` : "本级没有计数口径（全国~区县；计数在小区级 HUD）" }}
        </dd>
        <dt>定位来源</dt>
        <dd :class="{ 'wsv__bad': snap.locSource === 'ip' }">{{ locText }}</dd>
        <dt>动效状态</dt>
        <dd>
          {{ snap.motion ? `加载态=${snap.motion.phase} · 设施节点=${snap.motion.facilityNodes}${snap.motion.facilityFadeDone === null ? "" : snap.motion.facilityFadeDone ? "（淡入已播完）" : "（淡入中）"} · 事件条=${snap.motion.eventRows} · 天气粒子=${snap.motion.weatherCanvas ? "在跑" : "无"}` : "（拿不到）" }}
        </dd>
        <dt>HUD 原话</dt>
        <dd class="wsv__hud">{{ snap.hud || "（空）" }}</dd>
      </dl>

      <!-- ④ 图层与关键 paint -->
      <h4>图层（{{ snap.layers.length }} 条）与关键 paint</h4>
      <ul class="wsv__layers">
        <li v-for="l in snap.layers" :key="l.id">
          <code>{{ l.id }}</code><em>{{ l.type }}</em>
          <span v-for="(v, k) in (snap.keyPaints[l.id] || {})" :key="k" class="wsv__paint">
            {{ k }}={{ brief(v) }}
          </span>
        </li>
      </ul>

      <!-- ⑤ 自拍 -->
      <h4>自拍（回传 ~/chk/live/）</h4>
      <p class="wsv__row">
        <button class="wsv__btn" type="button" :disabled="shooting" @click="shoot">
          {{ shooting ? "抓帧中…" : "📸 现在拍一张" }}
        </button>
        <span class="wsv__sub">图 + 样式 JSON 一起发到 127.0.0.1:8789</span>
      </p>
      <p v-if="shotMsg" class="wsv__none">{{ shotMsg }}</p>

      <!-- ⑥ 终端才能跑的（如实列命令，不假装） -->
      <h4>这些只能在终端跑 <em>浏览器跑不了，不冒充</em></h4>
      <ul class="wsv__list">
        <li v-for="t in termChecks" :key="t.cmd" class="unk">
          <span class="wsv__ico">⌨️</span><span class="wsv__nm">{{ t.name }}</span><code class="wsv__cmd">{{ t.cmd }}</code>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref } from "vue";
  import {
    TERMINAL_CHECKS,
    compareThemeWithJson,
    runVerifyChecks,
    type ThemeParity,
    type VerifyResult,
    type VerifySnapshot,
  } from "./wsVerifyChecks";

  const props = withDefaults(
    defineProps<{
      /** 现在是不是展开的（`?wsverify=1` 一进来就展开；🔬 按钮也能切） */
      open?: boolean;
      /** 每次要重算的快照（**函数**：面板只在展开/点重跑时取一次，不逐帧算） */
      snapshot: () => VerifySnapshot;
      /** 点「现在拍一张」时调（返回一句给机主看的结果；空串 = 没结果） */
      onShoot?: () => Promise<string>;
      /** 点「重试地图」时调（P0：临时类降级可以让用户手动催一下；返回一句人话） */
      onRetryMap?: () => Promise<string>;
      /** 点「🔄 强制重算画布」时调（同步返回一句人话：画布前后尺寸） */
      onForceResize?: () => string;
    }>(),
    { open: false }
  );
  const emit = defineEmits<{ (e: "toggle", open: boolean): void }>();

  const open = ref(props.open);
  const snap = ref<VerifySnapshot>(props.snapshot());
  const checks = ref<VerifyResult[]>(runVerifyChecks(snap.value));
  const shooting = ref(false);
  const shotMsg = ref("");
  const retrying = ref(false);
  const resizeMsg = ref("");
  function forceResize(): void {
    if (!props.onForceResize) {
      resizeMsg.value = "这一级没有接重算入口";
      return;
    }
    try {
      resizeMsg.value = props.onForceResize();
    } catch (err) {
      resizeMsg.value = `重算出错：${String((err as Error)?.message || err)}`;
    }
    rerun();
  }
  const retryMsg = ref("");
  const copied = ref(false);
  const diagEl = ref<HTMLTextAreaElement | null>(null);

  /**
   * 排障用的**一段纯文本**（机主按一下就能复制走，不必截图）：
   * 降级三段（为什么/类别/手势）+ 地图库错误**原文** + 关键指标 + HUD 原话。
   * 与 `style-*.json` 同源（同一份快照），只是给人读的形状。
   */
  const diagText = computed(() => {
    const s = snap.value;
    const cat =
      s.fallbackKind === "temp" ? "临时类（只是慢，会自己恢复）" : s.fallbackKind === "perm" ? "永久类（报错/拿不到 WebGL）" : "未降级/未知";
    return [
      `【App 诊断】级别=${s.level || "（未记录）"} ${s.build || ""}`,
      `地址=${s.href || ""}`,
      `渲染路=${s.kind === "webgl" ? "WebGL（MapLibre）" : "2D 降级"}${s.recovered ? "（曾降级，已自动切回 WebGL）" : ""}`,
      `降级原因原文=${s.fallbackWhy || "（无）"}`,
      `降级类别=${cat}；手势可用=${s.kind === "webgl" ? "是" : "**否**"}`,
      `isStyleLoaded=${String(s.isStyleLoaded)} sawRender=${s.sawRender} 图层=${s.layers.length} 条`,
      `画布=${s.canvas ? `${s.canvas.w}x${s.canvas.h}px / ${s.canvas.cw}x${s.canvas.ch}布局 / dpr=${s.canvas.dpr}` : "（拿不到）"}`,
      `2D画布DPR封顶=${s.dprCap2d ?? "不适用"} 性能档=${s.capsLow ? "低档" : "正常"}`,
      `主题=${s.wstheme} 夜色=${s.wsnight.on ? "on" : "off"} level=${s.wsnight.level} 世界时间=${s.worldTime}`,
      s.counts
        ? `计数=🏢${s.counts.buildings} 🛣${s.counts.roads} 🏪${s.counts.facilities} 👤${s.counts.pins}`
        : "计数=（本级没有这套口径）",
      `定位来源=${s.locSource || "未知"}`,
      `地图库错误(${s.errors.length})：`,
      ...(s.errors.length ? s.errors.map((e, i) => `  ${i + 1}. ${e}`) : ["  （无）"]),
      `HUD=${s.hud || "（空）"}`,
    ].join("\n");
  });

  /** 复制到剪贴板：优先 `navigator.clipboard`，不行就**选中 textarea 再 execCommand**（老内核可用） */
  async function copyDiag(): Promise<void> {
    const text = diagText.value;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied.value = true;
        setTimeout(() => (copied.value = false), 2500);
        return;
      }
    } catch {
      /* 没权限/不是安全上下文 ⇒ 走下面的兜底 */
    }
    try {
      const el = diagEl.value;
      if (el) {
        el.focus();
        el.select();
        document.execCommand("copy");
        copied.value = true;
        setTimeout(() => (copied.value = false), 2500);
      }
    } catch {
      /* 两条都不行 ⇒ 让人自己长按选中（框就在上面，这是**如实**的兜底） */
    }
  }

  async function retry(): Promise<void> {
    if (!props.onRetryMap) return;
    retrying.value = true;
    retryMsg.value = "";
    try {
      retryMsg.value = await props.onRetryMap();
    } catch (e) {
      retryMsg.value = `重试出错：${String((e as Error)?.message || e)}`;
    } finally {
      retrying.value = false;
      rerun();
    }
  }
  const termChecks = TERMINAL_CHECKS;
  /**
   * 「App ↔ 代拍页」对账结果（**当场 fetch `/wstheme.json`** —— 代拍页消费的就是这一份）。
   * 拿不到就 `ok:false`（面板如实写"没对成"），**绝不当成"一致"**。
   */
  const parity = ref<ThemeParity | null>(null);
  /** 对账一次（打开面板/点重跑时）：同一份 JSON + App 现在的图层与 paint */
  async function refreshParity(): Promise<void> {
    try {
      const snap0 = props.snapshot();
      const themeId = snap0.wstheme === "night" ? "night" : snap0.wstheme === "anime" ? "anime" : "";
      if (!themeId) {
        parity.value = null; // 阶段舞台还没有主题 id（②要做的就是把四级也接上主题）
        return;
      }
      const r = await fetch("/wstheme.json", { cache: "no-store" });
      const json = r.ok ? await r.json() : null;
      parity.value = compareThemeWithJson(
        json,
        themeId,
        snap0.layers.map((l) => ({ id: l.id, type: l.type })),
        /* paint 从**快照自己**取（`keyPaints` 里就是 App 现在的真实值）——
           不绕 window、不另开一条取值路（少一条路就少一处漂移） */
        (id, key) => snap0.keyPaints?.[id]?.[key] ?? null
      );
    } catch (e) {
      parity.value = {
        source: "/wstheme.json",
        themeId: "?",
        jsonLayers: [],
        missing: [],
        extra: [],
        paintDiffs: [],
        ok: false,
        note: `对账失败：${String((e as Error)?.message || e)}`,
      };
    }
  }
  /** 没过/判不了的条数（收起时挂在 🔬 上，让人知道"里面有事"） */
  const warnCount = ref(0);
  function refreshWarn(): void {
    warnCount.value = checks.value.filter((r) => r.ok !== true).length;
  }
  refreshWarn();

  /** 重取快照 + 重跑自检（只读：不碰样式、不碰相机） */
  function rerun(): void {
    try {
      snap.value = props.snapshot();
      checks.value = runVerifyChecks({ ...snap.value, ...(parity.value ? { parity: parity.value } : {}) });
      void refreshParity().then(() => {
        checks.value = runVerifyChecks({ ...snap.value, ...(parity.value ? { parity: parity.value } : {}) });
      });
    } catch (e) {
      checks.value = [{ name: "取快照", ok: false, detail: `抛错：${String((e as Error)?.message || e)}` }];
    }
    refreshWarn();
  }
  function toggle(): void {
    open.value = !open.value;
    if (open.value) rerun();
    emit("toggle", open.value);
  }

  /** 值太长就截断显示（面板是给人看的；完整值在 JSON 里） */
  function brief(v: unknown): string {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return String(s ?? "null").length > 42 ? String(s).slice(0, 42) + "…" : String(s ?? "null");
  }
  const locText = (): string => {
    const l = snap.value.locSource;
    if (l === "gps") return "系统定位";
    if (l === "ip") return "IP 估测（城市级）—— ⚠️ 可能是 VPN/网络出口位置，不一定是你人在的地方";
    if (l === "manual") return "手动选择";
    if (l === "restored") return "上次位置";
    return "来源未知（没记录到）";
  };

  async function shoot(): Promise<void> {
    if (!props.onShoot) return;
    shooting.value = true;
    shotMsg.value = "";
    try {
      shotMsg.value = (await props.onShoot()) || "已发出（结果见 HUD 与 ~/chk/live/）";
    } catch (e) {
      shotMsg.value = `自拍失败：${String((e as Error)?.message || e)}`;
    } finally {
      shooting.value = false;
      rerun();
    }
  }

  /* 快照/自检只在展开的那一刻算一次；收起时零开销（这是"调试设施不许拖慢被调试的东西"） */
  defineExpose({ rerun, toggle });
</script>

<style scoped>
  .wsv {
    /* 🔴 2026-09-24：容器改成**铺满宿主**，由下面两条分别定位"面板"与"🔬 按钮"——
       为什么：机主真机截图说"**右下两个浮动按钮**（多余 UI）"、面板一开就占右半屏。
       面板本身仍是右上角那个；但**收起时的 🔬 挪到左下角**（不跟地图上的 HUD/手机按钮抢右上）。 */
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    /* 容器铺满但**不吃指针**：只有它自己的按钮/面板可点（否则整屏都点不动地图） */
    pointer-events: none;
  }
  .wsv__box {
    pointer-events: auto;
    margin: 8px 8px 0 0;
  }
  .wsv__fab {
    position: absolute;
    left: 8px;
    bottom: 8px;
    pointer-events: auto;
    width: 40px;
    height: 36px;
    border: none;
    border-radius: 12px;
    background: rgba(7, 11, 17, 0.66);
    color: #eaf6ff;
    font-size: 15px;
    /* 与项目既有口径一致（`.ws-dml__hud` 也这么写）：低档下 `--ws-blur-low` 会被设成 0px
       ⇒ 调试面板自己**不许**成为"降级路上最贵的那一层"。 */
    backdrop-filter: blur(var(--ws-blur-low, 10px));
    -webkit-backdrop-filter: blur(var(--ws-blur-low, 10px));
  }
  /* 收起时挂个数字：里面有几条没过/判不了（不然没人知道要去看） */
  .wsv__dot {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: #ff6b6b;
    color: #1b0b0b;
    font-weight: 700;
    font-size: 10px;
    line-height: 16px;
  }
  .wsv__box {
    width: min(94vw, 560px);
    max-height: min(74vh, 620px);
    overflow: auto;
    padding: 10px 12px 14px;
    border-radius: 14px;
    background: rgba(7, 11, 17, 0.93);
    border: 1px solid rgba(121, 217, 255, 0.28);
    color: #eaf6ff;
    /* 大阴影也是一次合成成本；低档下直接不要（面板是诊断工具，不需要好看） */
    box-shadow: var(--ws-shadow-panel, 0 10px 30px rgba(0, 0, 0, 0.45));
  }
  .wsv__hd {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: -10px;
    padding: 6px 0;
    background: rgba(7, 11, 17, 0.96);
  }
  .wsv__hd b { color: #79d9ff; font-size: 13px; }
  .wsv__sub { color: #9fb3c8; font-weight: 400; }
  .wsv__x {
    margin-left: auto;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    color: #eaf6ff;
  }
  .wsv__warn--ok {
    background: rgba(126, 231, 135, 0.14) !important;
    border-color: rgba(126, 231, 135, 0.45) !important;
    color: #c8f7cd !important;
  }
  .wsv__warn p { margin: 2px 0; }
  .wsv__ta {
    width: 100%;
    box-sizing: border-box;
    border-radius: 8px;
    border: 1px solid rgba(121, 217, 255, 0.25);
    background: rgba(0, 0, 0, 0.35);
    color: #cfe6ff;
    font: 10.5px/1.5 ui-monospace, monospace;
    padding: 6px 7px;
    resize: vertical;
  }
  .wsv__warn {
    margin: 6px 0;
    padding: 7px 9px;
    border-radius: 10px;
    background: rgba(255, 176, 92, 0.16);
    border: 1px solid rgba(255, 176, 92, 0.45);
    color: #ffd9a8;
  }
  h4 {
    margin: 12px 0 5px;
    color: #79d9ff;
    font-size: 11.5px;
  }
  h4 em { color: #7f93a8; font-style: normal; font-weight: 400; }
  .wsv__list { margin: 0; padding: 0; list-style: none; }
  .wsv__list li { display: flex; gap: 6px; padding: 3px 0; align-items: baseline; }
  .wsv__list .ok .wsv__ico { color: #7ee787; }
  .wsv__list .bad .wsv__ico { color: #ff7b72; }
  .wsv__list .unk .wsv__ico { color: #d2a8ff; }
  .wsv__nm { flex: 0 0 auto; max-width: 46%; color: #cfe6ff; }
  .wsv__dt { flex: 1 1 auto; color: #9fb3c8; word-break: break-word; }
  .wsv__list .bad .wsv__dt { color: #ffb4ae; }
  .wsv__kv { display: grid; grid-template-columns: 92px 1fr; gap: 2px 8px; margin: 0; }
  .wsv__kv dt { color: #7f93a8; }
  .wsv__kv dd { margin: 0; color: #e6f2ff; word-break: break-word; }
  .wsv__hud { color: #ffd9a8 !important; }
  .wsv__bad { color: #ffb4ae !important; }
  .wsv__none { margin: 2px 0; color: #7f93a8; }
  .wsv__layers { margin: 0; padding: 0; list-style: none; }
  .wsv__layers li { padding: 3px 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.07); }
  .wsv__layers code { color: #79d9ff; }
  .wsv__layers em { color: #7f93a8; font-style: normal; margin-left: 6px; }
  .wsv__paint { display: inline-block; margin-left: 8px; color: #ffcf8a; }
  .wsv__row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .wsv__btn {
    border: none;
    border-radius: 9px;
    padding: 5px 10px;
    background: #79d9ff;
    color: #06222e;
    font-weight: 700;
    font-size: 11px;
  }
  .wsv__btn:disabled { opacity: 0.6; }
  .wsv__cmd { display: block; color: #ffcf8a; word-break: break-all; }
</style>
