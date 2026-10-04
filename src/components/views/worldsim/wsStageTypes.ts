/* wsStageTypes.ts —— L0.5：**舞台层共用的类型**（`PLAN-REFACTOR.md` §2.2）。
 *
 * ## 这个文件是什么
 * 舞台拆分（§2.1 的 M1…M9）之后，各模块与宿主之间要靠类型对齐：模块**不许 import 宿主**
 * （§2.2 规则③），所以"宿主注入的那份上下文"与"从宿主搬出去的地图/快照形状"必须有**中立**的
 * 落脚点 —— 就是这里。它属于 L0.5：在叶子模块（L0）之上、在 M* 之下。
 *
 * ## 两条硬纪律
 * ① **0 运行时代码**：本文件只许出现 `type` / `interface` / `import type` / `export type`。
 *    出现任何一个 `const` / `function` / `enum`（有运行时产物）就是走错了地方 ——
 *    那些属于 L0 的真源模块（`wsScene` / `wsMapTheme` / …）。
 * ② **不许有第二份定义**（`pr_standard_check.py` 的 C1）：这里只做"搬家"与"再导出"，
 *    绝不为同一个形状写第二份 interface —— 两份迟早漂移，而漂移了没人看得出来。
 *
 * ## S1 落在哪一步（照实记）
 * · `BldMapLike`：**从宿主搬来**（原 `WsDistrictMapLibre.vue` 内部 `interface`）。它有真实消费者
 *   （宿主里 10+ 处 `loadBuildingsForView(m)` / `viewHalf(m)` / `m as BldMapLike` 等签名），
 *   搬出来没有任何运行时影响（interface 编译后不存在）。
 * · `VerifySnapshot`：**不复制**，只在这里再导出 —— 真源仍在 `wsVerifyChecks.ts`（`VerifySnapshot`
 *   与产出它的 `runVerifyChecks` 必须待在一起，拆开就是两份）。
 * · `StageCtx`：**本次故意没写**。它的形状由"第一个真正搬出去的 `mountX()` 需要注入什么"决定；
 *   S1 里没有任何模块消费它，先写出来就是**凭空发明 API**（写完没人用 ⇒ 没人能证它对不对）。
 *   它随第一个搬迁切片（S2 起）落地，那时字段是被真实调用点倒逼出来的。
 */

/** 取楼用的地图最小接口（只声明用到的，避免 any）。
 *  ⚠️ 2026-10-04（S1）从 `WsDistrictMapLibre.vue` 原样搬来，**一个字段都没改**；
 *     搬家的理由：`wsViewFetch`（M2）等模块要按这个形状收地图，而模块不许 import 宿主。 */
export interface BldMapLike {
  getZoom(): number;
  getCenter(): { lng: number; lat: number };
  getBounds(): { getEast(): number; getWest(): number; getNorth(): number; getSouth(): number };
  getSource(id: string): { setData(d: unknown): void } | undefined;
  getLayer(id: string): unknown;
  addSource(id: string, spec: Record<string, unknown>): void;
  addLayer(spec: Record<string, unknown>, beforeId?: string): void;
}

/** 验证快照（面板与样式 JSON 吃的那一份）—— **再导出**，真源在 `wsVerifyChecks.ts`。
 *  用 `export type { … } from` 这种写法：它是**纯类型**再导出，编译后不留任何运行时痕迹
 *  （也就不会把 `wsVerifyChecks` 拖进模块依赖图）。 */
export type { VerifySnapshot } from "./wsVerifyChecks";
