/*
 * 在 **worker 线程**里注册 `mvt` 协议（MapLibre 6.10 的官方用法：`self.addProtocol`）。
 *
 * 为什么必须：`config.REGISTERED_PROTOCOLS` 是**每个线程一份**。只在主线程注册时，worker 的
 * `makeRequest()` 查不到协议，会 `actor.sendAsync({type:"GR", targetMapId:GLOBAL_DISPATCHER_ID})`
 * 绕回主线程取资源 —— 实测（world_map/mvt-spike/FINDING-MVT-ADDPROTOCOL.md）：handler 被调用、
 * 数据也返回，**但瓦片始终不落到 loaded**。在 worker 里注册后，两条路（带编码头 / 无编码头）
 * 都实测能落地（3 块 / vtx 15885，3~4 次复跑）。
 *
 * 两条硬约束（都来自实测）：
 *  ① worker 里一旦注册成功，worker 就**不再回主线程**（`makeRequest` 查到协议就用它，失败也不回退）
 *     ⇒ 本脚本必须**自给自足**，注册了就得能干活。
 *  ② 所以只在 worker 里**同时具备** `DecompressionStream` 与 `self.addProtocol` 时才注册；
 *     缺任一个 ⇒ **不注册**（让 worker 走主线程那条路），免得"注册了个解不开的实现"把瓦片全弄丢。
 *
 * 另：注册时往服务端发一个**一次性探针请求** `/__mvt_worker_facts?ds=…&ap=…&reg=…&ua=…`，
 * 把 worker 内部的事实带出来（无头/真机都读不到 worker 的 console）。失败静默（不影响主逻辑）。
 *
 * 本文件由 `importScriptInWorkers(url)` 以 **classic script** 形式注入（不是 ESM）。
 */
(function () {
  var hasDS = typeof DecompressionStream === "function";
  var hasAP = !!(self && typeof self.addProtocol === "function");
  var willRegister = hasDS && hasAP;

  try {
    fetch("/__mvt_worker_facts?ds=" + hasDS + "&ap=" + hasAP + "&reg=" + willRegister +
      "&ua=" + encodeURIComponent(String((self.navigator && self.navigator.userAgent) || "")).slice(0, 120))
      .catch(function () {});
  } catch (e) { /* 探针失败不影响主逻辑 */ }

  if (!willRegister) return;

  self.addProtocol("mvt", async function (params, abort) {
    var url = String((params && params.url) || "").replace(/^mvt:\/\//, "/");
    var res = await fetch(url, abort ? { signal: abort.signal } : undefined);
    if (res.status === 404 || res.status === 204) return { data: new ArrayBuffer(0) };   /* 空瓦片 */
    var u8 = new Uint8Array(await res.arrayBuffer());
    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
      var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
      return { data: await new Response(stream).arrayBuffer() };
    }
    return { data: u8.buffer };
  });
  self.__MVT_WORKER_PROTOCOL__ = true;
})();
