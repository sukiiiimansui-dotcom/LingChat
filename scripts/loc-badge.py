#!/usr/bin/env python3
"""数一遍仓库的代码行数，写成 shields.io 能直接读的徽章 JSON。

为什么自己数而不用第三方服务：口径要**可复算**（同一个脚本本地与 CI 跑出来必须一样），
数字要**可审计**（哪几个目录、算不算注释，都写在下面）。

口径（README 里也写着同一份）：
  · 只数源码：Rust / TypeScript / Vue / JavaScript / CSS / HTML / Python / Shell
  · **不含空行、不含整行注释**（行内注释算代码）
  · 排除依赖与产物：node_modules / dist* / target / public/vendor / gen / temp / build

用法：
    python3 scripts/loc-badge.py                     # 只打印
    python3 scripts/loc-badge.py --out <目录>         # 顺便写徽章 JSON 到该目录
    python3 scripts/loc-badge.py --json              # 打印机器可读结果
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 要数的目录（相对仓库根）
SCAN = ["src", "src-tauri/src", "crates", "scripts", "public", "wsbench"]

# 另外还要数仓库根目录下的自用页面（wsfx.html / wsgame.html / ws3dshow 那些）
ROOT_GLOBS = ["*.html"]

# 排除的目录名（任何一层命中就跳过）
EXCLUDE_DIRS = {
    "node_modules", ".git", "target", "dist", "dist-webdev", "dist-namesverify",
    "vendor", "gen", "temp", "build", "Pods", ".cargo", ".pnpm", "citypacks-sample",
}

# 扩展名 → 语言
EXT_LANG = {
    ".rs": "Rust",
    ".ts": "TypeScript",
    ".vue": "Vue",
    ".js": "JavaScript",
    ".mjs": "JavaScript",
    ".css": "CSS",
    ".scss": "CSS",
    ".html": "HTML",
    ".py": "Python",
    ".sh": "Shell",
}

# 整行注释的前缀（strip 之后以它开头 ⇒ 记作注释行，不计入）
COMMENT_PREFIXES = ("//", "/*", "*", "*/", "#", "<!--", "--", ";")


def count_file(path):
    """返回 (代码行, 注释行, 空行)"""
    code = comment = blank = 0
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for raw in f:
                s = raw.strip()
                if not s:
                    blank += 1
                elif s.startswith(COMMENT_PREFIXES):
                    comment += 1
                else:
                    code += 1
    except OSError:
        return 0, 0, 0
    return code, comment, blank


def walk():
    per_lang = {}

    def add(lang, path):
        code, comment, blank = count_file(path)
        slot = per_lang.setdefault(lang, {"files": 0, "code": 0, "comment": 0, "blank": 0})
        slot["files"] += 1
        slot["code"] += code
        slot["comment"] += comment
        slot["blank"] += blank

    # 仓库根目录下的页面（只按 glob 取，不递归）
    import glob as _glob
    for pat in ROOT_GLOBS:
        for path in sorted(_glob.glob(os.path.join(ROOT, pat))):
            ext = os.path.splitext(path)[1].lower()
            if EXT_LANG.get(ext):
                add(EXT_LANG[ext], path)

    for base in SCAN:
        start = os.path.join(ROOT, base)
        if not os.path.isdir(start):
            continue
        for dirpath, dirnames, filenames in os.walk(start):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                lang = EXT_LANG.get(ext)
                if not lang:
                    continue
                add(lang, os.path.join(dirpath, fn))
    return per_lang


def human(n):
    """给徽章用：287041 → 28.7 万行；<10000 就直接给数字"""
    if n >= 10000:
        return f"{n / 10000:.1f} 万行"
    return f"{n} 行"


def badge(label, message, color):
    return {"schemaVersion": 1, "label": label, "message": message, "color": color}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="写徽章 JSON 的目录（不存在就建）")
    ap.add_argument("--json", action="store_true", help="打印机器可读结果")
    args = ap.parse_args()

    per_lang = walk()
    total = sum(v["code"] for v in per_lang.values())
    rust = per_lang.get("Rust", {}).get("code", 0)
    frontend = per_lang.get("TypeScript", {}).get("code", 0) + per_lang.get("Vue", {}).get("code", 0)
    other = total - rust - frontend

    if args.json:
        print(json.dumps({"total": total, "per_lang": per_lang}, ensure_ascii=False, indent=2))
    else:
        print(f"代码行数（非空、非整行注释）：{total} 行 · {human(total)}")
        print(f"  {'语言':<12s} {'代码':>9s} {'注释':>9s} {'空行':>9s} {'文件':>6s}")
        for lang, v in sorted(per_lang.items(), key=lambda kv: -kv[1]["code"]):
            print(f"  {lang:<12s} {v['code']:>9d} {v['comment']:>9d} {v['blank']:>9d} {v['files']:>6d}")
        print(f"  {'合计':<12s} {total:>9d}")

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        badges = {
            "loc.json": badge("代码行数", human(total), "blue"),
            "loc-rust.json": badge("Rust", human(rust), "dea584"),
            "loc-frontend.json": badge("前端 TS + Vue", human(frontend), "3178c6"),
            "loc-other.json": badge("其它语言", human(other), "9cf"),
        }
        for name, data in badges.items():
            with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
                f.write("\n")
        # 顺带留一份人类可读的表（挂在 badges 分支上，README 可以链过去）
        lines = [
            "# 代码量（自动生成，别手改）",
            "",
            f"合计 **{total}** 行代码（不含空行与整行注释）。由 `scripts/loc-badge.py` 统计，",
            "每次推送源码后由 `.github/workflows/loc-badge.yml` 重新生成。",
            "",
            "| 语言 | 代码 | 注释 | 空行 | 文件 |",
            "|---|---:|---:|---:|---:|",
        ]
        for lang, v in sorted(per_lang.items(), key=lambda kv: -kv[1]["code"]):
            lines.append(f"| {lang} | {v['code']} | {v['comment']} | {v['blank']} | {v['files']} |")
        lines.append(f"| **合计** | **{total}** | | | |")
        lines.append("")
        with open(os.path.join(args.out, "README.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"\n已写入 {args.out}/：{', '.join(list(badges) + ['README.md'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
