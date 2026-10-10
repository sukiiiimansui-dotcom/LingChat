/* wsBundleParseWorker.ts —— **离线包解析 Worker**（2026-10-10；「解析搬离主线程」那一片）。
 *
 * ## 它是什么
 * 一个**只做一件事**的 Worker：收到 `{id, kind, text}` ⇒ `JSON.parse` + `parseBundleJson(kind, …)`
 * ⇒ 把要素数组回传。**解析规则一行都不在这里**（调的是 `wsOfflineFeed.parseBundleJson`，
 * 与主线程那条同步路**同一个函数** ⇒ 不可能有第二份口径，PR 门禁 C1）。
 *
 * ## 为什么值得搬（读数，不是感觉）
 * 单格离线包实测 **1.78MB / `JSON.parse` 中位 350ms**（见 `wsOfflineFeed` 里 `parsedCacheCells`
 * 那一段的注释）——那是**主线程**的 350ms，正是"每次计算楼房都卡一下"的主干。
 *
 * ## 纪律
 * · **不静默**：解析失败把原因原样回传（主线程那边会退回同步路并计数，见
 *   `feed.facts().parseWorker.fallback`）；
 * · **不带任何宿主状态**：无 DOM、无 Vue、无 `window`（本文件只 import 纯模块）；
 * · **一次一条**（`self.onmessage` 里同步做完再回）——解析是纯 CPU，排队没有意义；
 *   真正的并发控制（epoch / 超时 / 退回）全在客户端 `wsBundleParseClient.ts` 那一侧。
 *
 * 用法（Vite）：`new Worker(new URL("./wsBundleParseWorker.ts", import.meta.url), { type: "module" })`
 * —— 只由 `wsBundleParseClient.ts` 一处创建。
 */
import { parseBundleJson, type BundleKind } from "./wsOfflineFeed";

/** 主线程 → Worker */
export interface BundleParseRequest {
  t: "parse";
  /** 请求序号（客户端用它丢弃迟到的回包） */
  id: number;
  kind: BundleKind;
  /** 响应正文（**文本**：`JSON.parse` 也一起搬过来，那才是 350ms 的大头） */
  text: string;
}

/** Worker → 主线程（成功带要素，失败带原文；两种情况都必须回） */
export type BundleParseResponse =
  | { t: "parsed"; id: number; ok: true; feats: unknown[] }
  | { t: "parsed"; id: number; ok: false; why: string };

self.onmessage = (e: MessageEvent<BundleParseRequest>) => {
  const m = e.data;
  if (!m || m.t !== "parse") return;
  try {
    const json = JSON.parse(m.text);
    const feats = parseBundleJson(m.kind, json);
    /* `feats` 是**新建的对象数组**（解析产物）⇒ 结构化克隆回主线程即可，不需要 transfer。 */
    (self as unknown as Worker).postMessage({ t: "parsed", id: m.id, ok: true, feats } satisfies BundleParseResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      t: "parsed", id: m.id, ok: false,
      why: String((err as Error)?.message || err).slice(0, 120),
    } satisfies BundleParseResponse);
  }
};
