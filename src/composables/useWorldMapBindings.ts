// 把 LingChat 的角色名单接到世界界面（T6-4）
//
// 目标（用户明确要求）：
//   · 角色名单 = LingChat 角色列表（`characterGetAll` → 头像转 asset URL）
//   · 拿不到 Tauri 接口时退回后端的角色目录（`/api/schedule/chars`），两级兜底
//
// ⚠️ 这个文件原来是「角色名单 + 往世界地图的老 JS 模块里灌数据」的合体，
//    2026-10-06 拆开了（S9b5-B）：**注入那半已退役**（`useWorldModules.ts` 连同
//    `public/world_map/*.js` 的 5 个脚本、284 KB 一起不再加载），只留下角色名单这半——
//    它在 `useWsActors.ts` 里是地图上「人」的名单真源，是活的那半。
//    老 JS 模块当年吃的是 `NPC_SYS.setNamedCharacters()` / `PHONE.setContacts()` 这套 window 全局，
//    现在世界界面是 Vue 自己的组件，名单直接进 `useWsActors`，不再经过 window。
import { convertFileSrc } from '@tauri-apps/api/core'
import { characterGetAll, getCharacterFilePath } from '@/api/services/character'
import type { Character } from '@/types'
import worldMapApi from '@/api/services/worldMap'

export interface WorldCharacter {
  id: string
  name: string
  persona: string
  avatarUrl: string
  folder: string
}

let cachedCharacters: WorldCharacter[] | null = null

/** 读 LingChat 角色列表，并把头像转成可显示的 asset URL */
export async function loadWorldCharacters(force = false): Promise<WorldCharacter[]> {
  if (cachedCharacters && !force) return cachedCharacters
  const out: WorldCharacter[] = []
  try {
    const res = await characterGetAll(1, 50)
    for (const c of (res?.items || []) as Character[]) {
      const folder = c.resource_folder || c.title || c.name || ''
      let avatarUrl = ''
      try {
        const rel = (c as any).avatar_path
        if (rel) {
          const abs = await getCharacterFilePath(rel)
          if (abs) avatarUrl = convertFileSrc(abs)
        }
      } catch {
        avatarUrl = ''
      }
      out.push({
        id: String(c.character_id ?? folder),
        name: c.name || c.title || folder,
        persona: (c.info || '').slice(0, 200),
        avatarUrl,
        folder,
      })
    }
  } catch (e) {
    // 不在 Tauri 环境（纯浏览器调试）或接口异常：退回用后端的角色目录
    try {
      const r = await fetch(`${worldMapApi.apiBase}/api/schedule/chars`, { cache: 'no-store' })
      const d = await r.json()
      for (const c of d?.characters || []) {
        out.push({
          id: c.folder || c.name,
          name: c.name,
          persona: (c.info || '').slice(0, 200),
          avatarUrl: '',
          folder: c.folder || '',
        })
      }
    } catch {
      /* 两边都拿不到就保持空 */
    }
  }
  cachedCharacters = out
  return out
}
