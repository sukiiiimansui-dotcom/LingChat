/**
 * wsPreviewAssets.ts —— **浏览器预览**里的角色素材回退（只服务预览，真机不走这条路）。
 *
 * ## 为什么需要它（2026-10-03 机主真机验收后）
 * 地图上的角色钉子与面板立绘，真机走的是 Tauri 命令 `get_avatar_file` + `convertFileSrc`
 * （`useWsActors.ts` / `useWsPortrait.ts`）——那条路在浏览器里**恒为空**（`isTauriRuntime()` 为假），
 * 于是预览里只能画"名字首字色块"、面板没有立绘。机主的验收环境**只有 5212 浏览器预览**
 * （手机上装的是官方原版 APK，看不到我们的改动）⇒ 他要求「把地图中的角色头像立绘全部换上」。
 *
 * ## 这条路是怎么通的（**零字节搬运**）
 * 预览服务 `~/chk/webdev-preview-server.py` 已经有一条**只读直通**：
 *   `GET /char/<角色目录>/avatar/[<服装>/]<情绪>.webp`  → 直接读官方素材目录
 *   （根目录硬编码 `~/companion_new/lingchat-data/game_data/characters`，与 fork 的 `data/game_data/characters` 同内容）
 * 原型页 `public/ws3dshow.html` 一直用的就是它。所以**不用把 36MB 素材拷进 `public/`**
 * （拷了会被编进 `.so`/APK，白胖 36MB），这里只把 URL 拼出来。
 *
 * ## 两条纪律
 * ① **认不出来就不给 URL**（返回 `""`）——钉子会退回"首字色块"，不会留一个 404 的破图；
 * ② 这套映射**只对预览生效**（调用方用 `isTauriRuntime()` 分流），真机的解析规则**仍只有 Rust 一份**
 *    （`src-tauri/src/api/character.rs`），本文件**不重写**真机规则。
 *
 * ## 名单从哪来
 * `PREVIEW_CHAR_FOLDERS` = 官方素材包里**真实存在**的三个目录（实测：`data.7z` 73,529,925 B 里
 * 只有 `DeepSeek` / `诺一钦灵` / `风雪`）。目录名 ≠ 角色名（`诺一钦灵` 的 `ai_name` 是「钦灵」），
 * 所以下面那张别名表是**必需的**，不是偷懒。
 */

/** 预览直通的前缀（`webdev-preview-server.py` 提供；原型页用的是同一条） */
export const PREVIEW_ASSET_ROOT = "/char";

/** 官方素材包里真实存在的角色目录（写死：浏览器里读不到文件系统，多写一个就是 404） */
export const PREVIEW_CHAR_FOLDERS: readonly string[] = ["DeepSeek", "诺一钦灵", "风雪"];

/**
 * 角色名 → 素材目录名。
 *
 * 规则（**确定性，按顺序取第一个命中**）：
 *   ① 名字本身就是目录名 ⇒ 原样（`风雪` / `DeepSeek`）
 *   ② 否则找**唯一一个以该名字结尾**的目录（`钦灵` ⇒ `诺一钦灵`）
 *   ③ 都不中 ⇒ 返回 `""`（调用方据此画占位，**不猜目录名**）
 */
export function previewCharFolderOf(name: unknown): string {
  const want = String(name ?? "").trim();
  if (!want) return "";
  if (PREVIEW_CHAR_FOLDERS.includes(want)) return want;
  const ends = PREVIEW_CHAR_FOLDERS.filter((f) => f.length > want.length && f.endsWith(want));
  return ends.length === 1 ? ends[0] : "";
}

/**
 * 拼一张素材 URL（`/char/<目录>/avatar/[<服装>/]<情绪>.webp`）。
 *
 * 认不出目录、或情绪为空 ⇒ 返回 `""`（**绝不编一个路径出来**）。
 * `clothes` 给空/`default` ⇒ 不带服装那一段（官方目录里默认服装就在 `avatar/` 根下）。
 */
export function previewCharAssetUrl(nameOrFolder: unknown, emotion: unknown, clothes?: unknown): string {
  const folder = previewCharFolderOf(nameOrFolder);
  const emo = String(emotion ?? "").trim();
  const cloth = String(clothes ?? "").trim();
  if (!folder || !emo) return "";
  const useClothes = cloth && cloth !== "default" ? `${encodeURIComponent(cloth)}/` : "";
  return `${PREVIEW_ASSET_ROOT}/${encodeURIComponent(folder)}/avatar/${useClothes}${encodeURIComponent(emo)}.webp`;
}
