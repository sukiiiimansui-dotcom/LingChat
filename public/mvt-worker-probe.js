/*
 * 能力探针 worker：只回答一个问题 —— **worker 线程里有没有 `DecompressionStream`**。
 *
 * 为什么要问：`?mvt=1` 走协议那条路（R1）时，解压发生在 **worker** 里（主线程那份只兜底）。
 * 若 worker 没有解压器，worker 侧就**不能注册协议**（注册了也解不开，而 `makeRequest` 查到协议
 * 就不会回退主线程 ⇒ 瓦片全丢）。宿主据此**在运行期选路**：
 *   · 有解压器 ⇒ 走协议（`mvt://…`，磁盘可以保持 gzip）
 *   · 没有     ⇒ **不注册协议**，直接用普通 URL 源（`/mvt/…`；靠 HTTP 的 Content-Encoding，
 *                或真机用不压缩落盘的包）—— 并**计数**，不静默。
 *
 * 这就是"运行期自适应"，它让 `?mvt=1` 在两种发货口径下都能落地（发货口径由主对话定）。
 */
postMessage({
  hasDecompressionStream: typeof DecompressionStream === "function",
  hasAddProtocol: !!(self && typeof self.addProtocol === "function"),
  hasBlob: typeof Blob === "function",
  ua: String((self.navigator && self.navigator.userAgent) || "").slice(0, 120),
});
self.close();
