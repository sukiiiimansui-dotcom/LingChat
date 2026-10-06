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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
 * 拿一个**真能跑起来**的 esbuild。
 *
 * 🔴 2026-10-06 的教训（三条原生构建在 CI 上一起红，本地却全绿）：
 * 这里原来 spawn 的是 `node_modules/.pnpm/node_modules/.bin/esbuild` —— 那只是 pnpm 的
 * **shell 垫片**，它内部是 `node <平台原生二进制>`。本地那份 `esbuild/bin/esbuild` 还是 JS
 * 垫片（postinstall 没跑），所以"看着能用"；CI 上 postinstall 把它换成了 ELF / Mach-O，
 * 于是 node 去解析二进制 → `SyntaxError: Invalid or unexpected token`；
 * Windows 上那个无扩展名垫片**根本不存在** → ENOENT。
 *
 * 所以：优先用 esbuild 的 **JS API**（它自己会按平台解析正确的二进制），
 * 只有在实在 import 不到时才退回「**直接** spawn 平台原生二进制」—— 那是真的可执行文件，
 * 不是垫片。四条路依次试，全失败就把试过什么原样报出来（下次别再靠猜）。
 */
async function loadEsbuild() {
  const tried = [];
  const rootRequire = createRequire(path.join(ROOT, "scripts", "gen-locale-version.mjs"));

  // ① 依赖被提升到根 node_modules 时最省事
  try {
    return { kind: "api", mod: await import("esbuild") };
  } catch (e) {
    tried.push(`import("esbuild") → ${e.code || e.message}`);
  }
  // ② 按 Node 解析规则从仓库根找包入口
  try {
    const entry = rootRequire.resolve("esbuild");
    return { kind: "api", mod: await import(pathToFileURL(entry).href) };
  } catch (e) {
    tried.push(`从仓库根 resolve → ${e.code || e.message}`);
  }
  // ③ 借 vite 的位置解析：pnpm 严格布局下 esbuild 是 vite 的依赖，根 node_modules 里没有它
  try {
    const entry = createRequire(rootRequire.resolve("vite")).resolve("esbuild");
    return { kind: "api", mod: await import(pathToFileURL(entry).href) };
  } catch (e) {
    tried.push(`借 vite 的位置 resolve → ${e.code || e.message}`);
  }
  // ④ 兜底：pnpm 虚拟存储里的平台原生二进制（Windows 上是 esbuild.exe）
  const bin = findPlatformBinary();
  if (bin) return { kind: "bin", file: bin };

  throw new Error(
    "找不到可用的 esbuild（依次试过：\n  " +
      tried.join("\n  ") +
      "\n  pnpm 虚拟存储里也没有 @esbuild/*/bin/esbuild）\n先 pnpm install 再跑本脚本。"
  );
}

/** pnpm 虚拟存储里的平台原生二进制（`node_modules/.pnpm/@esbuild+<平台>@<版本>/…`） */
function findPlatformBinary() {
  const store = path.join(ROOT, "node_modules/.pnpm");
  if (!existsSync(store)) return null;
  const exe = process.platform === "win32" ? "esbuild.exe" : "esbuild";
  for (const dir of readdirSync(store)) {
    if (!dir.startsWith("@esbuild+")) continue;
    const inner = path.join(store, dir, "node_modules", "@esbuild");
    if (!existsSync(inner)) continue;
    for (const pkg of readdirSync(inner)) {
      const p = path.join(inner, pkg, "bin", exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 用 esbuild 打包 + node 实跑，算出与改动前完全同源的版本值 */
async function computeVersion() {
  const esbuild = await loadEsbuild();
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

  if (esbuild.kind === "api") {
    // JS API：跨平台不用管垫片/扩展名那套
    await esbuild.mod.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: bundle,
      logLevel: "warning",
      absWorkingDir: ROOT,
    });
  } else {
    // 兜底路：spawn 的是平台原生二进制本身（不是 .bin 垫片）
    execFileSync(
      esbuild.file,
      [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`, "--log-level=warning"],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] }
    );
  }
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
const { version, chars } = await computeVersion();
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
