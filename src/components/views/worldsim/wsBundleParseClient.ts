/* wsBundleParseClient.ts —— **解析 Worker 的客户端**（2026-10-10）。
 *
 * 职责只有四条（其它一律不在这里）：
 *   ① **懒建**一个 Worker（`wsBundleParseWorker.ts`；只在浏览器里、且没被 `?parseworker=0` 关掉时建）；
 *   ② 发请求、按 `id` 认回包，**迟到的回包直接丢**（epoch = 每次请求自增的 id）；
 *   ③ **超时**（`PARSE_WORKER_TIMEOUT_MS`）或 Worker 不可用/报错 ⇒ **扔给调用方退回同步路**
 *      （本模块**不自己兜**：`wsOfflineFeed` 那条同步路只有一份，绕开它就是第二份实现）；
 *   ④ **如实计数**：`facts()` 报 `sent` / `ok` / `timeout` / `err` / `alive` —— 不许静默降级。
 *
 * ⚠️ 本模块**不 import 任何宿主**（无 Vue / 无 DOM 依赖，只有 `Worker` 这一个浏览器全局，
 *    而且取不到就返回 `null` ⇒ node/自检里天然退化成"不存在"）。"关掉"的口径在宿主那一处：
 *    宿主不传 `parseAsync` 就是不搬（`?parseworker=0`）。
 */
import type { BundleKind } from "./wsOfflineFeed";
import type { BundleParseRequest, BundleParseResponse } from "./wsBundleParseWorker";

/**
 * 一次解析的等待上限（ms）。
 *
 * 为什么是 **8s**：单格离线包最大实测 **1.9MB**，主线程冷解析中位 **350ms**（`wsOfflineFeed` 注释），
 * 慢一个数量级也是 3.5s；再算上 Worker 冷启动与结构化克隆，8s 是"明显不正常"与"别误杀慢机器"
 * 之间的取值。**超时不是失败**：调用方退回同步路照样出结果，只是把这一次记为 `timeout`。
 */
export const PARSE_WORKER_TIMEOUT_MS = 8000;

export interface ParseWorkerFacts {
  /** 有没有真的建起 Worker（false = 环境不支持 / 构造失败 ⇒ 一直是同步路） */
  alive: boolean;
  /** 发出去几条 */
  sent: number;
  /** 成功回来几条 */
  ok: number;
  /** 超时几条（**退回同步**，调用方计数） */
  timeout: number;
  /** Worker 报错 / 回包说解析失败几条 */
  err: number;
}

/** 一次性建好的 Worker + 它的读数（模块级单例：全场一个 Worker，别每格建一个） */
let worker: Worker | null = null;
let workerTried = false;
let nextId = 1;
const waiting = new Map<number, { resolve: (f: unknown[]) => void; reject: (e: Error) => void; timer: number }>();
const facts: ParseWorkerFacts = { alive: false, sent: 0, ok: 0, timeout: 0, err: 0 };

function ensureWorker(): Worker | null {
  if (workerTried) return worker;
  workerTried = true;
  try {
    /* 取不到 `Worker`（node / 老 WebView）⇒ 如实返回 null（调用方走同步路） */
    if (typeof Worker === "undefined") return null;
    worker = new Worker(new URL("./wsBundleParseWorker.ts", import.meta.url), { type: "module" });
    facts.alive = true;
    worker.onmessage = (e: MessageEvent<BundleParseResponse>) => {
      const m = e.data;
      if (!m || m.t !== "parsed") return;
      const w = waiting.get(m.id);
      if (!w) return;                       // 迟到的回包（已经超时/作废）⇒ 直接丢，不报错
      waiting.delete(m.id);
      window.clearTimeout(w.timer);
      if (m.ok) { facts.ok += 1; w.resolve(m.feats); }
      else { facts.err += 1; w.reject(new Error(m.why || "Worker 解析失败")); }
    };
    worker.onerror = () => {
      /* Worker 自己崩了：把在等的都拒掉（调用方退回同步路），并如实记一笔 */
      facts.err += 1;
      const all = [...waiting.values()];
      waiting.clear();
      for (const w of all) { window.clearTimeout(w.timer); w.reject(new Error("Worker onerror")); }
    };
    return worker;
  } catch {
    worker = null;
    return null;
  }
}

/**
 * 把一段包正文交给 Worker 解析（`kind` + `text` → 要素数组）。
 *
 * **失败一律抛**（超时 / Worker 不可用 / 回包说失败）—— 调用方（`wsOfflineFeed`）负责退回同步路。
 * 本函数**不返回 null**：`null` 会让"没搬成"与"搬了但空了"长得一样（本项目反复栽的坑）。
 */
export function parseInWorker(kind: BundleKind, text: string): Promise<unknown[]> {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error("这个运行时不支持 Worker（退回同步解析）"));
  const id = nextId++;
  facts.sent += 1;
  return new Promise<unknown[]>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      facts.timeout += 1;
      reject(new Error(`解析 Worker 超时 ${PARSE_WORKER_TIMEOUT_MS}ms`));
    }, PARSE_WORKER_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ t: "parse", id, kind, text } satisfies BundleParseRequest);
    } catch (e) {
      waiting.delete(id);
      window.clearTimeout(timer);
      facts.err += 1;
      reject(new Error(String((e as Error)?.message || e)));
    }
  });
}

/** 只读读数（宿主/自检/探针用；**不是**快照对象，随时现读） */
export function parseWorkerFacts(): ParseWorkerFacts {
  return { ...facts };
}
