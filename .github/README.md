<div align="center">

# 世界模拟 · LingChat 个人实验分支

**这不是官方仓库喵**　官方项目在这 → [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)　要下载、要反馈都去那边

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-feat%2Fworldsim-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20尚不完善-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

</div>

<!-- LOC-BADGE:BEGIN（这段由 .github/workflows/loc-badge.yml 每天重写，别手改） -->
| 代码量（不含空行与整行注释） | 本仓 | 官方 `dev` | 净增 |
|---|---:|---:|---:|
| Rust | 70,589 | 55,085 | +15,504 |
| TypeScript | 48,751 | 31,132 | +17,619 |
| Vue | 48,273 | 42,136 | +6,137 |
| HTML | 9,665 | 247 | +9,418 |
| JavaScript | 5,663 | 924 | +4,739 |
| CSS | 4,758 | 3,002 | +1,756 |
| Python | 442 | 461 | -19 |
| Shell | 84 | 98 | -14 |
| **合计** | **188,225**（18.8 万行） | **133,085**（13.3 万行） | **+55,140** |
<!-- LOC-BADGE:END -->

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

上面那张表由 [`代码量徽章`](.github/workflows/loc-badge.yml) 这个工作流**每天 02:20（UTC+8）重写一次**
（也可以手动触发）：它用 [`scripts/loc-badge.py`](scripts/loc-badge.py) 数一遍本仓，同时浅克隆官方 `dev` 数一遍官方那份，
把结果写回上面那张表（标记之间，别手改）。想自己复算就本地跑：

```bash
python3 scripts/loc-badge.py --upstream <官方仓库的本地路径>   # 不给 --upstream 就只数本仓
```

统计口径（脚本就是真源，谁都能本地复算）：

- 数这几个地方：`src/` · `src-tauri/src/` · `crates/` · `scripts/` · `public/` ＋ 仓库根目录的自用页面；
- **不含空行、不含整行注释**（行内注释算代码）；
- 排除依赖与产物：`node_modules/` · `dist*` · `target/` · `public/vendor/`（那是打包产物）· `gen/` · `temp/`。

> 所以「代码量」不是「仓库有多大」，而是「我们自己写了多少行」——第三方依赖、字体素材、离线数据包都不算。
> 「净增」是**净增**（本仓 − 官方 `dev`）：重构把一万行从 A 搬到 B，在这里是 0（不是 2 万），否则那个数只反映搬家次数。
> 另外官方 `dev` 也在往前走，所以它是「相对**现在的**官方多出来的部分」，不是「我们历史上写过的总行数」。

