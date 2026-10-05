#!/usr/bin/env node
/**
 * 生成 `src/locales/bundleVersion.generated.ts`。
 *
 * 为什么要在构建期生成：`en` / `ja` / `zh-HK` 改成动态 `import()` 之后，主包里不再
 * 持有四份内置词条，但 `BUNDLE_VERSION` 必须**仍然等于**「四份内置词条全量
 * JSON.stringify 后的 31 进制轻量 hash」——它一变，后端就会把所有用户的
 * `data/locales/*.json` 重新播种一次（`src-tauri/src/api/locale.rs` 是 `fs::write` 覆盖），
 * 用户手改的词条会丢。
 *
 * 所以这里的 hash 算法与参与 hash 的词条集合，**逐字照抄改动前的 `src/locales/index.ts`**：
 *
 *     let h = 0;
 *     const s = JSON.stringify({ "zh-CN": zhCN, "zh-HK": zhHK, ja, en });
 *     for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
 *     h.toString(36);
 *
 * 对象字面量的键序（zh-CN / zh-HK / ja / en）会原样进入 `JSON.stringify`，**不许重排**。
 *
 * Node 不能直读 TS，所以先用 esbuild 把四种语言打成一个临时 mjs，再交给 node 跑。
 *
 * 用法：
 *   node scripts/gen-locale-version.mjs          重新生成（写 src/locales/bundleVersion.generated.ts）
 *   node scripts/gen-locale-version.mjs --check   只校验，与已提交的值不一致则退出码 1
 *   node scripts/gen-locale-version.mjs --print   只打印算出来的值（JSON，给自检读）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TS = path.join(ROOT, "src/locales/bundleVersion.generated.ts");

/** 四种语言的入口（键序 = 参与 hash 的顺序，别动） */
const LOCALE_ENTRIES = [
  ["zh-CN", "src/locales/zh-CN/index.ts"],
  ["zh-HK", "src/locales/zh-HK/index.ts"],
  ["ja", "src/locales/ja/index.ts"],
  ["en", "src/locales/en/index.ts"],
];

/**
 * 找 esbuild 可执行文件。
 * 实测（Termux，pnpm 布局）：`node_modules/.bin/esbuild` 与 `npx esbuild` 都不可用，
 * 真的存在的是 pnpm 隐藏提升目录下那一个。
 */
function findEsbuild() {
  const candidates = [
    path.join(ROOT, "node_modules/.pnpm/node_modules/.bin/esbuild"),
    path.join(ROOT, "node_modules/.bin/esbuild"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "找不到 esbuild 可执行文件（试过：\n  " +
      candidates.join("\n  ") +
      "\n先 pnpm install，或改本脚本的候选路径）"
  );
}

/** 用 esbuild 打包 + node 实跑，算出与改动前完全同源的版本值 */
function computeVersion() {
  const esbuild = findEsbuild();
  // /tmp 在 Termux 上不可写 ⇒ 临时文件放 node_modules/.cache（既在仓库内、又不会进 git）
  const tmp = path.join(ROOT, "node_modules/.cache/locale-version");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const entry = path.join(tmp, "entry.mjs");
  const bundle = path.join(tmp, "bundle.mjs");
  const imports = LOCALE_ENTRIES.map(
    ([, rel], i) => `import loc${i} from ${JSON.stringify(path.join(ROOT, rel))};`
  ).join("\n");
  const pairs = LOCALE_ENTRIES.map(([key], i) => `${JSON.stringify(key)}: loc${i}`).join(", ");
  writeFileSync(
    entry,
    `${imports}
const BUNDLED = { ${pairs} };
let h = 0;
const s = JSON.stringify(BUNDLED);
for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
process.stdout.write(JSON.stringify({ version: h.toString(36), chars: s.length }));
`,
    "utf8"
  );

  execFileSync(esbuild, [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`, "--log-level=warning"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const out = execFileSync(process.execPath, [bundle], { cwd: ROOT, encoding: "utf8" });
  const parsed = JSON.parse(out);
  rmSync(tmp, { recursive: true, force: true });
  return parsed;
}

function generatedSource(version) {
  return `// 本文件由 scripts/gen-locale-version.mjs 生成，别手改。
// 它等于「四份内置词条（zh-CN / zh-HK / ja / en）全量 JSON.stringify 后的 31 进制轻量 hash」，
// 与语言包是否静态进主包无关 —— 后端拿它判断要不要重新播种用户的 data/locales/*.json。
// 改过任何一份语言词条后，跑：node scripts/gen-locale-version.mjs
export const BUNDLE_VERSION = ${JSON.stringify(version)};
`;
}

function readCommitted() {
  if (!existsSync(OUT_TS)) return null;
  const m = readFileSync(OUT_TS, "utf8").match(/^export const BUNDLE_VERSION = "([^"]*)";$/m);
  return m ? m[1] : null;
}

const argv = process.argv.slice(2);
const { version, chars } = computeVersion();
const committed = readCommitted();

if (argv.includes("--print")) {
  process.stdout.write(JSON.stringify({ version, chars }) + "\n");
  process.exit(0);
}

if (argv.includes("--check")) {
  if (committed === version) {
    console.log(`✅ 语言包版本值一致：${version}（参与 hash 的 JSON 长度 ${chars}）`);
    process.exit(0);
  }
  console.log(`❌ 语言包版本值不一致：算出来 ${version}，src/locales/bundleVersion.generated.ts 里是 ${committed}`);
  console.log("   跑 node scripts/gen-locale-version.mjs 重新生成。");
  process.exit(1);
}

writeFileSync(OUT_TS, generatedSource(version), "utf8");
console.log(`已写入 src/locales/bundleVersion.generated.ts：BUNDLE_VERSION = ${version}（JSON 长度 ${chars}）`);
if (committed !== null && committed !== version) {
  console.log(`⚠️ 旧值是 ${committed}，已更新。`);
}
