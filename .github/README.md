<div align="center">

# 世界模拟 · LingChat 个人实验分支

**这不是官方仓库喵**　官方项目在这 → [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)　要下载、要反馈都去那边

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-feat%2Fworldsim-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20尚不完善-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

[![代码行数](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc.json&style=flat-square)](#代码量)
[![Rust](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc-rust.json&style=flat-square)](#代码量)
[![前端 TS + Vue](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc-frontend.json&style=flat-square)](#代码量)
[![其它语言](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc-other.json&style=flat-square)](#代码量)
[![官方代码行数](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc-upstream.json&style=flat-square)](#代码量)
[![我们净增](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsukiiiimansui-dotcom%2FLingChat%2Fbadges%2Floc-added.json&style=flat-square)](#代码量)

</div>

---

![当前部分功能演示](docs/worldsim/worldsim-demo-2026-10-03.jpg)

> 上图为当前部分功能演示（重庆 · 渝中半岛一带；右侧是角色面板与立绘）。

## 这是什么

LingChat 的个人实验分支：想给聊天加一层「世界」，让角色不只在聊天框里，还能在一张**真实的地图**上活动喵。

- 官方项目：**[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)**（想玩官方的去这里）
- 本仓库在改的分支：[`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
- 进度都记在：**[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)**

## 改了什么

|  | 原来方案 | 现在方案 |
|---|---|---|
| 地图 | 五层下钻 + AI 实时生成街区 | **真实 2.5D 地图** |
| 建筑 | AI 画 | **真实 3D 建筑** |
| 数据 | 靠联网生成 | **离线数据包**，城市由用户自己选 |

原来那套方案（[issue #804](https://github.com/SlimeBoyOwO/LingChat/issues/804)）的文件还在。实测下来 AI 实时生成的街区效果不理想，于是换成了真实地图 ＋ 真实建筑。

## 当前进度喵

**目前只做完了功能实现喵，可玩性、准确性、稳定性都还在改。**

- 已经跑通的：真实路网 / 水域 / 绿地 / 楼房（离线数据包，按缩放分层显示）、走近说话、角色摇杆移动。
- 可玩性：操作手感、镜头、界面都还比较粗糙；玩法目前只到「世界事件 ＋ 心情体力 ＋ 走近说话」。
- 准确性：建筑高度大部分是按规则推断的（数据源里带真实高度的比例很低，画面上会区分）；片区名与 POI 有示意成分，真数据都带来源署名。
- 稳定性：帧率、内存占用与长时间拖动缩放尚未系统验证。
- 这条分支**没有安装包、没有下载、也没有公开的试用入口**。只有稳定、能玩的版本才会更新到 [issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)；暂时不会往上游提 PR。

## 代码量

徽章上的数字是**实时的**：每次推源码，[`代码量徽章`](.github/workflows/loc-badge.yml) 这个工作流会用
[`scripts/loc-badge.py`](scripts/loc-badge.py) 重新数一遍（同时浅克隆官方 `dev` 数一遍官方那份），
结果推到 **`badges` 分支**（机器维护的孤儿分支，只有几个徽章 JSON + 一张明细表），首页徽章直接读它。
点徽章只会滚到下面这张说明，**不会把你切到那个分支去** —— 那个分支平时不用看。

三个数分别是：

| 徽章 | 意思 |
|---|---|
| **代码行数** / Rust / 前端 / 其它 | 本仓库（`feat/worldsim`）自己有多少行 |
| **官方代码行数** | 官方 [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat) 的 `dev` 分支，同一脚本、同一口径 |
| **我们净增** | 上面两个相减（本仓 − 官方 `dev`） |

统计口径（脚本就是真源，谁都能本地复算 `python3 scripts/loc-badge.py --upstream <官方树>`）：

- 数这几个地方：`src/` · `src-tauri/src/` · `crates/` · `scripts/` · `public/` · `wsbench/` ＋ 仓库根目录的自用页面；
- **不含空行、不含整行注释**（行内注释算代码）；
- 排除依赖与产物：`node_modules/` · `dist*` · `target/` · `public/vendor/`（那是打包产物）· `gen/` · `temp/`。

> 所以「代码行数」不是「仓库有多大」，而是「我们自己写了多少行」——第三方依赖、字体素材、离线数据包都不算。
> 「我们净增」是**净增**：重构把一万行从 A 搬到 B，在这里是 0（不是 2 万），否则那个数只反映搬家次数。
> 另外官方 `dev` 也在往前走，所以这个差值是「相对**现在的**官方多出来的部分」，不是「我们历史上写过的总行数」。

## 分支说明

本仓库只留两条分支喵：

| 分支 | 用途 |
|---|---|
| [`feat/worldsim`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim) | 世界模拟开发分支（**默认分支，现在在改的**） |
| [`dev`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/dev) | 跟着上游，方便对齐 |

`main` 已经删掉了喵（留着没用）。它的历史没丢 —— 删之前按本仓惯例打了标签 `attic/main-20261003`，
要恢复就 `git branch main attic/main-20261003` 再推上来。其它更早的分支 9 月 30 日清掉过，
同样都在标签页的 `attic/*` 里，每个 tag 的说明写了它原来是哪条分支、怎么恢复。

## 许可与致谢

- LingChat 由 [SlimeBoyOwO](https://github.com/SlimeBoyOwO) 和贡献者们开发，许可 **AGPL-3.0**。
- 这里只是在它基础上做实验性改动。改动量比官方期望的单个 PR（1k 行以内）大不少，所以先放在自己仓库里改，稳定之后再拆开提。
- 素材版权与免责声明以官方为准（气泡、音效、立绘等请勿商用）；官方那套完整说明也仍在官方仓库。

---

_本页是 `feat/worldsim` 分支的首页（`.github/README.md`）喵。_
