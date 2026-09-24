#!/usr/bin/env bash
# 生成物：把交通设施的**入口**（`wsPageVendor.ts` = 两个模块的 re-export）打成页面能引的 ESM
# （**只做这一件事**的小步骤，秒级；⚠️ 入口必须打 re-export 那个文件，否则规则模块的导出会被漏掉）。
#
# 为什么需要：`public/ws3dshow.html` 是静态页，**引不到 TS**；而规则/生成逻辑必须**只有一份**
# （`wsTransportRules.ts` + `wsTransport.ts`）。做法与先例 `public/wstheme.json` 同款：
# **生成物落 public/ + 提交进仓库 + 自检兜漂移**（`ws_transport_selftest.mjs` 会重新生成并逐字节比对）。
#
# ⚠️ 授权范围：主会话只授权**这一个**脚本；App 预览包/闸门等其它构建仍由主会话做。
set -euo pipefail
cd "$(dirname "$0")/.."
ESB="node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild"
OUT="public/vendor/wsScene.mjs"
mkdir -p public/vendor
"$ESB" src/components/views/worldsim/wsPageVendor.ts \
  --bundle --format=esm --platform=browser --target=es2020 --charset=utf8 \
  --alias:@=src --outfile="$OUT"

# 🔴 2026-09-25：**把"内容版本"落成一个文件**（`public/vendor/wsScene.ver` = 产物的 sha256 前 16 位）。
# 为什么：页面用 `VENDOR_VER` 当缓存键（`?<ver>`），而它过去取的是**页面版本戳** `BUILD`
# —— 于是"改了模块但忘了换戳"时，浏览器 immutable 缓存里的旧副本会一直生效。
# 这个坑**已经栽过三次**（2026-09-24 `?bld=2` 什么都没变、2026-09-25 机主截图的
# `LOD 重取后仍缺`、以及 `ed8fdf6` 换 vendor 未换戳）。⇒ 现在**由产物自身决定**：
# 内容一变，哈希就变，URL 必换，**不依赖任何人记得**。
VER="public/vendor/wsScene.ver"
node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' "$OUT" > "$VER"
echo "✅ 生成 $OUT（$(wc -c < "$OUT") 字节）· 内容版本 $VER = $(cat "$VER")"
