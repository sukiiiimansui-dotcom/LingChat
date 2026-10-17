<div align="center">

# 世界模拟 · LingChat 个人实验分支

**这不是官方仓库**　官方项目在这 → [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)　要下载、要反馈都去那边

[![官方仓库](https://img.shields.io/badge/官方仓库-SlimeBoyOwO%2FLingChat-blue?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat)
[![开发分支](https://img.shields.io/badge/开发分支-dev-green?style=flat-square)](https://github.com/sukiiiimansui-dotcom/LingChat/tree/feat/worldsim)
[![状态](https://img.shields.io/badge/状态-实验性%20·%20仍在完善-orange?style=flat-square)](https://github.com/SlimeBoyOwO/LingChat/issues/858)

**简体中文** · [English](README.en.md) · [日本語](README.ja.md)

</div>

<!-- LOC-BADGE:BEGIN（这段由 .github/workflows/loc-badge.yml 每天重写，别手改） -->
| 代码量（不含空行与整行注释） | 本仓 | 官方 `dev` | 净增 |
|---|---:|---:|---:|
| Rust | 77,822 | 66,393 | +11,429 |
| TypeScript | 62,825 | 32,706 | +30,119 |
| Vue | 56,132 | 45,067 | +11,065 |
| JavaScript | 11,134 | 1,057 | +10,077 |
| HTML | 10,614 | 247 | +10,367 |
| CSS | 4,769 | 454 | +4,315 |
| Python | 694 | 461 | +233 |
| Shell | 107 | 98 | +9 |
| **合计** | **224,097**（22.4 万行） | **146,483**（14.6 万行） | **+77,614** |
<!-- LOC-BADGE:END -->

---
## 当前阶段

- **正在尝试将maplibre几何挤出楼房替换为three.js**


- **地图正在尝试自写 MVT 瓦片 用数字id取楼房数据**


- **名字id正在与楼房绑定**

## 这是什么

LingChat 的个人实验分支：想给聊天加一层「世界」，让角色不只在聊天框里，还能在一张**真实的地图**上活动喵。

- 官方项目：**[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)**（想玩官方的去这里）
- 本仓库在改的分支：[`dev`](https://github.com/sukiiiimansui-dotcom/LingChat/tree/dev)
- 进度都记在：**[issue #858](https://github.com/SlimeBoyOwO/LingChat/issues/858)**

> 下面两节摘自官方 README（随 `upstream/dev` 同步）；本分叉自己的改动见后文。

## LingChat 是如何和你沟通的？

![alt text](image-1.png)

---

## 核心功能列表

我们致力于提供最沉浸、最自由的 AI 陪伴体验。

1. 🧠 永久记忆与独立存档：每个存档拥有独立永久记忆，可自由体验不同对话风格。
2. 💓 自研情绪识别模型：自动判定 AI 每次对话的情绪，告别机械式回复。
3. 👀 视觉感受与主动窥屏：自动识别桌面状态（工作/游戏/挂机），AI 会主动关心你。
4. 🐱 完全自定义角色：支持导入自己的 OC 或喜欢的游戏人物，支持静态图片或 Live2D
5. 🌸 服装切换与互动：支持切换角色服装，并加入摸摸角色等趣味互动功能。
6. ✨ 动态 UI 与沉浸式体验：表情、动作、气泡随 AI 情绪改变，搭配不同背景与音乐聊天。
7. 🎧 真实语音与音效陪伴：支持接入绝大部分语音服务或对话音效
8. 📜 多角色剧本与羁绊系统：支持导入剧本进行多角色对话，为角色编写羁绊剧情并解锁成就，支持Skill自动创作。
9. 🍅 内置效率工具：自带日程、待办清单，AI 会根据状态贴心提醒。
10. 📚 支持编写插件，接入其他软件如 QQ，Minecraft 等，实现更多功能。

## 当前进行方案与过去方案对比

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

