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
        <span class="wsv__sub">{{ snap.kind === "webgl" ? "WebGL（MapLibre）" : "2D 降级路" }}</span>
        <button class="wsv__x" type="button" title="收起" @click="toggle">✕</button>
      </header>

      <!-- 降级横幅：机主就是被这条误导过（"像图片""划不动"）⇒ 必须写在最上面 -->
      <p v-if="snap.kind !== 'webgl'" class="wsv__warn">
        ⚠️ 现在走的是 <b>2D 自绘降级路</b>：<b>拖动 / 缩放 / 旋转手势全部不可用</b>（没有地图实例），
        所以看着像一张静态图。为什么降级见下面「自检」第 ①/② 条与「地图库错误」。
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
        <dd>🏢{{ snap.counts.buildings }} 🛣{{ snap.counts.roads }} 🏪{{ snap.counts.facilities }} 👤{{ snap.counts.pins }}</dd>
        <dt>定位来源</dt>
        <dd :class="{ 'wsv__bad': snap.locSource === 'ip' }">{{ locText }}</dd>
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
  import { ref } from "vue";
  import {
    TERMINAL_CHECKS,
    runVerifyChecks,
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
    }>(),
    { open: false }
  );
  const emit = defineEmits<{ (e: "toggle", open: boolean): void }>();

  const open = ref(props.open);
  const snap = ref<VerifySnapshot>(props.snapshot());
  const checks = ref<VerifyResult[]>(runVerifyChecks(snap.value));
  const shooting = ref(false);
  const shotMsg = ref("");
  const termChecks = TERMINAL_CHECKS;
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
      checks.value = runVerifyChecks(snap.value);
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
    position: absolute;
    right: 8px;
    top: 8px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .wsv__fab {
    position: relative;
    width: 40px;
    height: 36px;
    border: none;
    border-radius: 12px;
    background: rgba(7, 11, 17, 0.66);
    color: #eaf6ff;
    font-size: 15px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
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
