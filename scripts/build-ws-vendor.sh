#!/usr/bin/env bash
# 生成物：把交通设施的**入口**（`wsTransportVendor.ts` = 两个模块的 re-export）打成页面能引的 ESM
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
OUT="public/vendor/wsTransport.mjs"
mkdir -p public/vendor
"$ESB" src/components/views/worldsim/wsTransportVendor.ts \
  --bundle --format=esm --platform=browser --target=es2020 --charset=utf8 \
  --alias:@=src --outfile="$OUT"
echo "✅ 生成 $OUT（$(wc -c < "$OUT") 字节）"
