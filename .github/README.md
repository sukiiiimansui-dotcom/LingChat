<div align="center">

# 世界模拟 · LingChat 个人实验分支

**这不是官方仓库。** 官方项目是 [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)，下载与问题反馈都在那边。

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-feat%2Fworldsim-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20尚不完善-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

</div>

---

## 这是什么

LingChat 的个人实验分支，用来尝试给聊天加一层「世界」：让角色不只在聊天框里，还能在一张**真实的地图**上活动。

- 上游项目：**[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)**（想玩官方的请去这里）
- 本仓库（开发中的分支）：[`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
- 进度记录：**[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)**

## 改了什么

|  | 原来的方案 | 现在的方案 |
|---|---|---|
| 地图 | 五层下钻 + AI 实时生成街区 | **真实 2.5D 地图** |
| 建筑 | AI 绘制 | **真实 3D 建筑** |
| 数据 | 依赖联网生成 | **离线数据包**：用户自行选择下载哪个城市 |

原来那套方案（[issue #804](https://github.com/SlimeBoyOwO/LingChat/issues/804)）的文件仍然保留；实测下来 AI 实时绘制的效果不太理想，所以改成了真实地图 + 真实建筑。

## 现在能玩吗

**还不能。** 目前只有网页预览里能跑起来（真实路网、水域、楼房都看得到），界面也还很粗糙。

- 本分支没有安装包、没有下载，也没有公开的试用入口。
- 只有稳定的、可玩的版本才会更新到 [issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)；暂时不会向上游提交 PR。

## 分支说明

本仓库只保留三条分支：

| 分支 | 用途 |
|---|---|
| [`main`](https://github.com/sukiiiimansui-dotcom/LingChat) | 仓库首页说明（**本页**） |
| [`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim) | 世界模拟开发分支（**当前正在改的**） |
| [`dev`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/dev) | 跟随上游，便于对齐 |

其余分支已于 **2026-09-30** 清理；如需查看旧内容，可到标签页查找 `attic/*`，每个 tag 的说明里写明了它对应哪条分支、以及恢复方法。

## 许可与致谢

- LingChat 由 [SlimeBoyOwO](https://github.com/SlimeBoyOwO) 与贡献者们开发，许可 **AGPL-3.0**。
- 本分支只是在此基础上做实验性改动。改动量远大于官方希望的单个 PR 规模（1k 行以内），因此先在自己的 fork 里迭代，稳定后再考虑切片提交。
- 素材版权与免责声明以官方说明为准（气泡、音效、立绘等**请勿商用**）；官方的完整说明仍在官方仓库。

---

_本页（`.github/README.md`）在 `main` 与 `feat/worldsim` 两条分支上都是这套说明。_
