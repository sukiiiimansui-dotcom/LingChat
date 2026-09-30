<div align="center">

# 世界模拟 · LingChat 个人实验分支

**这不是官方仓库。** 官方项目在 [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)，下载和反馈问题都去那边。

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-feat%2Fworldsim-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20尚不完善-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

</div>

---

## 这是什么

LingChat 的个人实验分支。想试试给聊天加一层「世界」—— 角色不只在聊天框里，还能在一张**真实的地图**上活动。

- 官方项目：**[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)**（想玩官方的去这里）
- 本仓库在改的分支：[`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
- 进度都记在：**[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)**

## 改了什么

|  | 原来 | 现在 |
|---|---|---|
| 地图 | 五层下钻 + AI 实时生成街区 | **真实 2.5D 地图** |
| 建筑 | AI 画 | **真实 3D 建筑** |
| 数据 | 靠联网生成 | **离线数据包**，城市由用户自己选 |

原来那套方案（[issue #804](https://github.com/SlimeBoyOwO/LingChat/issues/804)）的文件还在。实测下来 AI 实时画出来的不太行，就换成了真实地图 + 真实建筑。

## 现在能玩吗

**还不能。** 只有网页预览里跑得起来（真实路网、水域、楼房都看得到），界面也还比较糙。

- 这条分支没有安装包、没有下载，也没有公开的试用入口。
- 只有稳定、能玩的版本才会更新到 [issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)；暂时不会往上游提 PR。

## 分支说明

本仓库只留三条分支：

| 分支 | 用途 |
|---|---|
| [`main`](https://github.com/sukiiiimansui-dotcom/LingChat) | 仓库首页说明 |
| [`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim) | 世界模拟开发分支（**现在在改的**） |
| [`dev`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/dev) | 跟着上游，方便对齐 |

其它分支 9 月 30 号清掉了。想找旧内容，去标签页看 `attic/*`，每个 tag 的说明里写了它原来是哪条分支、怎么恢复。

## 许可与致谢

- LingChat 是 [SlimeBoyOwO](https://github.com/SlimeBoyOwO) 和贡献者们做的，许可 **AGPL-3.0**。
- 这边只是在它基础上做实验性改动，改动量比官方希望的单个 PR（1k 行以内）大不少，所以先放自己仓库里改，稳了再拆开提。
- 素材版权和免责声明以官方为准（气泡、音效、立绘这些请勿商用）；官方那套完整说明也还在官方仓库。

---

_本页是 `feat/worldsim` 分支的首页（`.github/README.md`）；`main` 上放的是同一套说明。_
