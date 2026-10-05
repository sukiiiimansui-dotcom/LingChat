import { invoke } from "@tauri-apps/api/core";
import { createI18n } from "vue-i18n";
import OpenCC from "opencc-js";
import { useSettingsStore } from "@/stores/modules/settings";
import zhCN from "./zh-CN";
import { BUNDLE_VERSION } from "./bundleVersion.generated";

/** 支持的界面语言 */
export const SUPPORTED_LOCALES = [
  { value: "zh-CN", label: "中文" },
  { value: "zh-HK", label: "繁體中文（香港）" },
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]["value"];

/**
 * 内置词条（打包进前端，作为兜底与播种源）。
 * 只有默认语言 zh-CN 静态进主包；en / zh-HK / ja 走下面的 import() 各自成独立 chunk，
 * 启动时只拉当前语言那一份（实测三种语言合计省 ~148 KB gzip）。
 */
const ZH_CN_BUNDLED = zhCN as Record<string, unknown>;

/** 动态 import() 的返回形状（各语言目录都是 export default 一个词条对象） */
type LocaleModule = { default: Record<string, unknown> };

/**
 * 各语言内置词条的加载器。用 import() 而不是静态 import ⇒ 每个语言单独一个 chunk，
 * 不进主包、启动不下载。浏览器按模块缓存 import() 结果，重复调用不会重复下载。
 */
const BUNDLED_LOADERS: Record<AppLocale, () => Promise<LocaleModule>> = {
  "zh-CN": () => Promise.resolve({ default: ZH_CN_BUNDLED }),
  "zh-HK": () => import("./zh-HK"),
  ja: () => import("./ja"),
  en: () => import("./en"),
};

/** 已经取到的内置词条（取过一次就不再 await） */
const bundledCache = new Map<AppLocale, Record<string, unknown>>();

async function bundledMessages(locale: AppLocale): Promise<Record<string, unknown>> {
  const hit = bundledCache.get(locale);
  if (hit) return hit;
  const mod = await BUNDLED_LOADERS[locale]();
  const msgs = mod.default;
  bundledCache.set(locale, msgs);
  return msgs;
}

/*
 * 内置词条版本（BUNDLE_VERSION）：对**全部四种**内置词条做轻量 hash。
 * 后端据它与 data/locales/*.json 里的版本比对——版本不一致（即词条有更新）
 * 时自动用新内置词条重新播种，避免用户环境里早期播种的旧词条永远覆盖新词条。
 * 用户手动编辑词条不改变内置版本，编辑内容仍会被保留。
 *
 * ⚠️ 语言包改成动态加载后，这里已经拿不到另外三份词条，所以值改成**构建期**算好的常量
 * （scripts/gen-locale-version.mjs 生成 src/locales/bundleVersion.generated.ts）。
 * 算法与参与 hash 的词条集合与改动前完全一致，新值与旧值逐字相同：
 * 值一变，后端就会把所有用户的本地词条文件重新覆盖一遍
 * （src-tauri/src/api/locale.rs 是 fs::write）。改过任何一份词条后必须重新生成。
 */

/** 与 stores/plugins/persist.ts 一致的统一设置存储键 */
const SETTINGS_STORAGE_KEY = "lingchat-settings";

/** 从统一设置存储（stores/modules/settings，persist 插件）读取已保存的语言 */
function detectLocale(): AppLocale {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw)?.display?.locale as string | undefined) : undefined;
    if (SUPPORTED_LOCALES.some((l) => l.value === saved)) return saved as AppLocale;
  } catch {
    /* 解析失败退回默认语言 */
  }
  return "zh-CN";
}

type MessageSchema = typeof zhCN;

export const i18n = createI18n<[MessageSchema], AppLocale>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "zh-CN",
  // 各语言词条以 zh-CN 为基准 schema；缺失键运行时经 fallbackLocale 回落中文。
  // ⚠️ 这里只放默认语言的**真词条** —— 另外三种在启动/切换时 import() 到之后
  //    setLocaleMessage 挂进来；它们静态进主包的话这一刀就白做了。
  //    三个空壳是给 createI18n 的类型签名占位（它要求 AppLocale 的键齐全），
  //    运行时在 chunk 落地前它们恰好就是"没有词条、整片回落 zh-CN"。
  messages: {
    "zh-CN": zhCN,
    "zh-HK": {} as MessageSchema,
    ja: {} as MessageSchema,
    en: {} as MessageSchema,
  },
});

/** 全局 composer 的 locale 引用（legacy:false 下运行时为可写 Ref） */
const globalLocale = i18n.global.locale as unknown as { value: AppLocale };

document.documentElement.lang = globalLocale.value;

/** 深合并：override 覆盖 base（嵌套对象递归，其余直接覆盖，不修改 base） */
function deepMergeMessages(base: any, override: any): any {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      out[k] = deepMergeMessages(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 从数据目录 data/locales/<locale>.json 加载语言文件并与内置词条深合并。
 * 文件不存在时后端会用内置词条播种；用户编辑过的内容优先，缺失键用内置兜底。
 * 播种内容带 __locale_version 标记：后端发现内置词条版本变化时会自动重新播种，
 * 修复旧版本残留词条覆盖新词条的问题（详见后端 api/locale.rs）。
 *
 * 内置词条本身要走 import()（zh-CN 除外），所以这里是"先取内置、再拉用户文件"两步。
 */
async function loadLocaleMessages(locale: AppLocale) {
  let bundled: Record<string, unknown>;
  try {
    bundled = await bundledMessages(locale);
  } catch (e) {
    // 动态 chunk 拉不到（离线包缺文件等）：界面继续回落 zh-CN，不让它冒泡成未捕获异常
    console.warn(`加载内置语言包失败（界面回落 zh-CN）: ${locale}`, e);
    return;
  }
  // 内置词条一到就先挂上：当前语言在 chunk 落地那一刻即可用，不必再等下面这趟 invoke
  // （动态 import 的词条是 Record<string, unknown>，这里按 createI18n 的 schema 类型收口）
  i18n.global.setLocaleMessage(locale, bundled as MessageSchema);
  try {
    const json = await invoke<string>("get_locale_messages", {
      locale,
      // 缩进格式播种，方便用户直接编辑；__locale_version 仅供后端版本比对
      seedContent: JSON.stringify(
        { __locale_version: BUNDLE_VERSION, ...bundled },
        null,
        2
      ),
    });
    const fileMsgs = JSON.parse(json);
    // 版本标记是内部字段，不进界面词条
    delete fileMsgs.__locale_version;
    i18n.global.setLocaleMessage(locale, deepMergeMessages(bundled, fileMsgs));
  } catch (e) {
    console.warn(`加载语言文件失败（使用内置词条）: ${locale}`, e);
  }
}

// 启动只加载当前语言的词条：zh-CN 在主包里、这里只是把用户编辑过的内容合并进来；
// en / zh-HK / ja 走动态 chunk。当前语言先排队，让它的 chunk 第一个开始下载。
const startupLocale = globalLocale.value;
void loadLocaleMessages(startupLocale);
if (startupLocale !== "zh-CN") void loadLocaleMessages("zh-CN");

/** 切换界面语言：立即生效，经统一设置 store 持久化（persist 插件自动写 localStorage） */
export function setLocale(locale: AppLocale) {
  globalLocale.value = locale;
  document.documentElement.lang = locale;
  try {
    useSettingsStore().setUiLocale(locale);
  } catch (e) {
    console.warn("写入统一设置存储失败（非致命）:", e);
  }
  // 切语言时重读语言文件，用户刚编辑的内容立即生效
  void loadLocaleMessages(locale);
}

/** 当前是否为日文界面（对话内容显示日语译文的开关） */
export function isJaLocale(): boolean {
  return globalLocale.value === "ja";
}

/** 简→繁（港）转换器：繁体（香港）界面下把对话内容转繁体显示（仅显示层，不改数据） */
const toHk = OpenCC.Converter({ from: "cn", to: "hk" });

/** 繁体（香港）界面下将文本转为繁体；其他界面或空文本原样返回 */
export function hkify<T extends string | undefined>(text: T): T {
  if (!text || globalLocale.value !== "zh-HK") return text;
  return toHk(text) as T;
}
