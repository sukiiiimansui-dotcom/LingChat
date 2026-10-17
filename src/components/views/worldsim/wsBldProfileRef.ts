/**
 * wsBldProfileRef.ts —— profile 的 **Vue 读写入口**（模块级单例 ref；芯片/设置页只调这里）。
 *
 * 纯逻辑在 `wsBldProfile.ts`（无 vue 依赖，Node/离线包管道直接 import 那一份）。
 * 本文件只做三件事：一个 ref、`setProfile`（归一 + 落盘）、`toggleProfile`。
 *
 * ⚠️ **切换后要刷新页面**（`BLD_PROFILE_RELOAD_HINT`）：瓦片协议在建图前注册、离线包目录在
 * 第一次读索引时缓存；热切无法保证"瓦片与包一起换"。本入口**不自动 reload** —— UI 负责提示。
 */
import { ref, type Ref } from "vue";
import {
  BLD_PROFILE_RELOAD_HINT,
  WS_BLD_PROFILE_FULL,
  WS_BLD_PROFILE_SLIM,
  bldProfileOf,
  readBldProfile,
  writeBldProfile,
  type WsBldProfile,
} from "./wsBldProfile";

let profileRef: Ref<WsBldProfile> | null = null;

export function useWsBldProfile(): {
  profile: Ref<WsBldProfile>;
  /** 归一 + 落盘；返回真正生效的档位（UI 拿它决定提示什么） */
  setProfile: (p: unknown) => WsBldProfile;
  toggleProfile: () => WsBldProfile;
  /** 切换后给用户看的一句话（UI 自己决定放哪；不自动 reload） */
  reloadHint: string;
} {
  if (!profileRef) profileRef = ref<WsBldProfile>(readBldProfile());
  const profile = profileRef;

  function setProfile(p: unknown): WsBldProfile {
    const next = writeBldProfile(bldProfileOf(p));
    profile.value = next;
    return next;
  }
  function toggleProfile(): WsBldProfile {
    return setProfile(profile.value === WS_BLD_PROFILE_FULL ? WS_BLD_PROFILE_SLIM : WS_BLD_PROFILE_FULL);
  }
  return { profile, setProfile, toggleProfile, reloadHint: BLD_PROFILE_RELOAD_HINT };
}
