// wsPhoneApps.ts —— 「悬浮手机」没接进来的应用 → 给用户看的**唯一**提示口径（切片①，2026-10-01）
//
// ## 为什么要有这个文件（PR 门禁 C1：App 宿主里不许出现第二份实现）
// 手机的八个应用清单在 `WsPhone.vue` 的 `APPS` 里；**已接的**（那边的 `READY`）由手机自己打开，
// **没接的只 emit `open-app`**，由宿主如实提示。切片①把手机挂回 App 入口后，宿主有两个：
//   · 老宿主 `WorldSim.vue`（孤儿页，仍在编译）
//   · 新宿主 `WsSceneView.vue`（`/worldsim` 那一屏）
// 两边都必须说**同一句话** ⇒ 收在这里一份，别各写各的。
//
// ⚠️ 清单要与 `WsPhone.vue` 的 `APPS` 对齐：那边加了新应用、还没接进来的，这里补一行；
//    接了以后（进 `READY`）宿主这条路**根本不会走到**（手机直接打开应用）。
//
// ⚠️ 为什么不用 i18n 词条：这句提示现在只出现在**未接**的两个应用上，而手机本体那套词条
//    只在 `zh-CN` 里落（`src/locales/zh-CN/worldsim.ts` 顶部注释：fallbackLocale 就是 zh-CN，
//    `en`/`ja`/`zh-HK` 缺键自动回落）⇒ 这里保持与老宿主**逐字相同**的中文，改动面最小。

/** 未接的应用 → 给用户看的名字（键同 `WsPhone.vue` 的 `APPS[].key`） */
export const PHONE_APP_LABEL: Record<string, string> = {
  music: "音乐（T5-8）",
  me: "我的",
};

/**
 * 没接进来的应用被点了以后**唯一**该说的话。
 *
 * 为什么不静默：机主明确讨厌"点了没反应"；这里如实说"还没接进来"，
 * 与手机里那些标着 T5-x 的占位标记是同一套口径（**不假装能用**）。
 */
export function phoneNotWiredText(key: string): string {
  return `${PHONE_APP_LABEL[key] || key} 还没接进来`;
}
