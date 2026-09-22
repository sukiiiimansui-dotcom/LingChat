/**
 * wsTransportVendor.ts —— **生成物的入口**（只做 re-export，没有自己的逻辑）。
 *
 * 为什么需要它：`scripts/build-ws-vendor.sh` 用 esbuild 打包时**只从入口出发收依赖**，
 * 而页面要用到两个模块的东西（`wsTransport.ts` 的生成函数 + `wsTransportRules.ts` 的
 * `TF_LAYER_IDS`/`TF_LAYER_STYLE`/`TF_LOW_TIER_KINDS`）。只打 `wsTransport.ts` 的话，
 * 规则模块里那些**没被 import 的导出不会进产物** ⇒ 页面 `TF.TF_LAYER_IDS` 直接是 undefined。
 * ⇒ 用一个只 re-export 的入口，**保证两份都进产物**，而且**不引入第二份逻辑**。
 */
export * from "./wsTransport";
export * from "./wsTransportRules";
