<div align="center">

# 🗺️ 世界模拟 · LingChat 改造版（个人 fork）

**这是 [LingChat](https://github.com/SlimeBoyOwO/LingChat) 的个人实验性 fork —— 不是官方仓库。**

**当前在改的分支：[`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)**（下面讲的「世界模拟」都在那条分支上；本页是仓库首页说明）。

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-feat%2Fworldsim-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20尚粗糙-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

> 想下载、想玩、想反馈问题 👉 **请去官方仓库：[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)**
>
> LingChat 是一个灵动の人工智能聊天陪伴助手（Tauri 2 + Vue 3 + Rust），由 [SlimeBoyOwO](https://github.com/SlimeBoyOwO) 与贡献者们开发。

</div>

---

## 📌 这个 fork 在做什么

给 LingChat 加一层「世界」：让角色不只在聊天框里，还能在一张**真实的地图**上生活。

|  | 早期方案（[#804](https://github.com/SlimeBoyOwO/LingChat/issues/804)） | 现在的方案（[#858](https://github.com/SlimeBoyOwO/LingChat/issues/858)） |
|---|---|---|
| 地图 | 五层下钻 + **AI 实时生成**街区 | **真实 2.5D 地图** |
| 建筑 | AI 画的 | **真实 3D 建筑** |
| 数据 | 全靠联网生成 | **离线数据包**：用户自己选下载哪个城市 |

换方案的原因很朴素：实测下来，AI 实时绘制的地图**属实有点难看**。

## 🚦 现在能玩吗

**还不能。** 地图已经能在网页预览里跑起来（真实路网 + 水域 + 楼房），但离「能正常游玩」还差得远，界面也还很粗糙。

- 本分支**没有提供安装包 / 下载**（fork 里 0 个 release），也没有公开的试用入口。
- 进度都记在一条 issue 里，**不去官方仓库刷屏**：[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)。

## 🔗 去哪看

| 我想…… | 去哪 |
|---|---|
| 看整个仓库（我们 fork 的首页） | [本仓库](https://github.com/sukiiiimansui-dotcom/LingChat) |
| 看正在改的那条分支 | [`feat/worldsim` 分支](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim) |
| 看它要做什么、做到哪了 | **[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)**（进度追踪） |
| 看最早的方案（已关闭） | [issue #804](https://github.com/SlimeBoyOwO/LingChat/issues/804) |
| **玩官方版本 / 反馈官方问题** | [官方仓库](https://github.com/SlimeBoyOwO/LingChat) · [官方下载](https://github.com/SlimeBoyOwO/LingChat/releases) · [官方 issues](https://github.com/SlimeBoyOwO/LingChat/issues) |

> 这里给的都是**仓库 / issue 链接**：点进去就是代码和讨论本身，不放代码副本、也不放打包好的文件。

## 📄 来源与许可

- LingChat 由 [SlimeBoyOwO](https://github.com/SlimeBoyOwO) 与贡献者们开发，许可 **AGPL-3.0**（LICENSE 就在仓库根目录，见 [本仓库首页](https://github.com/sukiiiimansui-dotcom/LingChat)）。
- 本分支只是在此基础上做**实验性改动**：改动量远大于官方要求的「一个 PR 1k 行以内」，所以先在自己的 fork 里迭代，稳定后再考虑按官方要求切片提交。
- 官方那套完整说明（功能介绍、安装、下载、致谢、开发者群等）**原文仍在官方仓库**：[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)。本页只讲「这个分支和官方有什么不同」，所以把它换成了上面这些。
- 免责声明与素材版权说明（气泡 / 音效 / 立绘等，**请勿商用**）同样以官方说明为准。

---

_本页（`.github/README.md`）在 `main` 与 `feat/worldsim` 两条分支上都是这套说明；官方原文仍在官方仓库。_
