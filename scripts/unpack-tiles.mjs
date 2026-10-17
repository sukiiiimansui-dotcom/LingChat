// unpack-tiles.mjs —— 出包前把归档的楼房瓦片解开。
//
// 为什么：瓦片以压缩包形式进仓（`public/mvt-slim.tgz` / `public/mvt-full.tgz`），
// 解包目录不进仓库 —— 每换一次瓦片集，仓库里只该动一两个二进制文件，
// 而不是三百到六百个 `.pbf`。
//
// 幂等：目录已存在且非空就跳过；解包用系统 `tar`（Linux/macOS/Windows 10+ 都有）。
// 解包失败**不许静默**：直接退出非零，别让构建出一个没有楼的包。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const SETS = ["mvt-slim", "mvt-full"];

/** 目录里有没有 `.pbf`（只看一层就够：瓦片按 z/x/y 铺开，至少有一层） */
function hasTiles(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

let extracted = 0;
for (const name of SETS) {
  const dir = join(PUBLIC, name);
  const tgz = join(PUBLIC, `${name}.tgz`);
  if (hasTiles(dir)) {
    continue;
  }
  if (!existsSync(tgz)) {
    console.error(`[tiles] ❌ 缺归档 ${tgz}，且解包目录 ${dir} 为空`);
    process.exit(1);
  }
  console.log(`[tiles] 解包 ${name}.tgz → public/${name}/`);
  try {
    execFileSync("tar", ["-xzf", tgz, "-C", PUBLIC], { stdio: "inherit" });
    extracted += 1;
  } catch (e) {
    console.error(`[tiles] ❌ 解包失败：${e?.message || e}`);
    process.exit(1);
  }
}

console.log(
  extracted > 0
    ? `[tiles] ✅ 解包 ${extracted} 套瓦片`
    : "[tiles] 已解包（跳过）",
);
