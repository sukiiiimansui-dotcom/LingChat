#!/usr/bin/env python3
"""数一遍仓库的代码行数，写成 shields.io 能直接读的徽章 JSON。

为什么自己数而不用第三方服务：口径要**可复算**（同一个脚本本地与 CI 跑出来必须一样），
数字要**可审计**（哪几个目录、算不算注释，都写在下面）。官方仓库那份也用它数 —— 只有同口径的数字才能相减。

口径（README 里也写着同一份）：
  · 只数源码：Rust / TypeScript / Vue / JavaScript / CSS / HTML / Python / Shell
  · **不含空行、不含整行注释**（行内注释算代码）
  · 排除依赖与产物：node_modules / dist* / target / public/vendor / gen / temp / build

「我们新增」怎么算：**同口径相减**（本仓 − 官方）。它是**净增**，不是"写过的总行数" ——
重构把一万行从 A 搬到 B 在净增里是 0，但在"累计插入行数"里会算两万，所以后者没有意义。

用法：
    python3 scripts/loc-badge.py                          # 只打印本仓
    python3 scripts/loc-badge.py --out <目录>              # 写徽章 JSON 到该目录
    python3 scripts/loc-badge.py --root <别的树>            # 数另一棵树
    python3 scripts/loc-badge.py --upstream <官方树> --out <目录>
                                                          # 三格一起：本仓 / 官方 / 净增
    python3 scripts/loc-badge.py --json                    # 机器可读
"""
import argparse
import glob
import json
import os
import pathlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(HERE)

# 要数的目录（相对树根）
SCAN = ["src", "src-tauri/src", "crates", "scripts", "public", "wsbench"]

# 另外还要数树根目录下的自用页面（wsfx.html / wsgame.html 那些）
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

# 整行注释的前缀（strip 之后以它开头 ⇒ 记作注释行，不计入代码）
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


def count_tree(root):
    """数一棵树，返回 {语言: {files, code, comment, blank}}"""
    per_lang = {}

    def add(lang, path):
        code, comment, blank = count_file(path)
        slot = per_lang.setdefault(lang, {"files": 0, "code": 0, "comment": 0, "blank": 0})
        slot["files"] += 1
        slot["code"] += code
        slot["comment"] += comment
        slot["blank"] += blank

    for pat in ROOT_GLOBS:
        for path in sorted(glob.glob(os.path.join(root, pat))):
            lang = EXT_LANG.get(os.path.splitext(path)[1].lower())
            if lang:
                add(lang, path)

    for base in SCAN:
        start = os.path.join(root, base)
        if not os.path.isdir(start):
            continue
        for dirpath, dirnames, filenames in os.walk(start):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
            for fn in filenames:
                lang = EXT_LANG.get(os.path.splitext(fn)[1].lower())
                if lang:
                    add(lang, os.path.join(dirpath, fn))
    return per_lang


def total_of(per_lang):
    return sum(v["code"] for v in per_lang.values())


def lang_of(per_lang, *names):
    return sum(per_lang.get(n, {}).get("code", 0) for n in names)


def human(n):
    """给徽章用：219334 → 21.9 万行；负数带号；<10000 直接给数字"""
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 10000:
        return f"{sign}{n / 10000:.1f} 万行"
    return f"{sign}{n} 行"


def badge(label, message, color):
    return {"schemaVersion": 1, "label": label, "message": message, "color": color}


def write_badges(out, per_lang, upstream=None):
    os.makedirs(out, exist_ok=True)
    total = total_of(per_lang)
    rust = lang_of(per_lang, "Rust")
    frontend = lang_of(per_lang, "TypeScript", "Vue")

    badges = {
        "loc.json": badge("代码行数", human(total), "blue"),
        "loc-rust.json": badge("Rust", human(rust), "dea584"),
        "loc-frontend.json": badge("前端 TS + Vue", human(frontend), "3178c6"),
        "loc-other.json": badge("其它语言", human(total - rust - frontend), "9cf"),
    }

    if upstream is not None:
        up_total, up_rust, up_front = total_of(upstream), lang_of(upstream, "Rust"), lang_of(upstream, "TypeScript", "Vue")
        badges.update({
            "loc-upstream.json": badge("官方代码行数", human(up_total), "lightgrey"),
            "loc-added.json": badge("我们净增", human(total - up_total), "brightgreen" if total >= up_total else "red"),
            "loc-added-rust.json": badge("净增 · Rust", human(rust - up_rust), "dea584"),
            "loc-added-frontend.json": badge("净增 · 前端", human(frontend - up_front), "3178c6"),
        })

    for name, data in badges.items():
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")

    # 人类可读的明细表（挂在 badges 分支上，README 链过去）
    langs = sorted(set(per_lang) | set(upstream or {}),
                   key=lambda k: -max(per_lang.get(k, {}).get("code", 0), (upstream or {}).get(k, {}).get("code", 0)))
    lines = [
        "# 代码量（自动生成，别手改）",
        "",
        f"本仓 **{total}** 行代码" + (f"；官方 **{total_of(upstream)}** 行；**净增 {total - total_of(upstream):+d}** 行。"
                                     if upstream is not None else "。"),
        "",
        "口径：不含空行与整行注释；排除依赖与产物（`node_modules` / `dist*` / `target` / `public/vendor` / `gen` / `temp`）。",
        "统计脚本 `scripts/loc-badge.py`（同一份脚本数两棵树，所以相减有意义）。",
        "",
    ]
    if upstream is not None:
        lines += ["| 语言 | 本仓 | 官方 | 净增 |", "|---|---:|---:|---:|"]
        for lang in langs:
            mine, up = per_lang.get(lang, {}).get("code", 0), upstream.get(lang, {}).get("code", 0)
            lines.append(f"| {lang} | {mine} | {up} | {mine - up:+d} |")
        lines.append(f"| **合计** | **{total}** | **{total_of(upstream)}** | **{total - total_of(upstream):+d}** |")
    else:
        lines += ["| 语言 | 代码 | 注释 | 空行 | 文件 |", "|---|---:|---:|---:|---:|"]
        for lang, v in sorted(per_lang.items(), key=lambda kv: -kv[1]["code"]):
            lines.append(f"| {lang} | {v['code']} | {v['comment']} | {v['blank']} | {v['files']} |")
        lines.append(f"| **合计** | **{total}** | | | |")
    lines.append("")
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return badges



README_BEGIN = "<!-- LOC-BADGE:BEGIN（这段由 .github/workflows/loc-badge.yml 每天重写，别手改） -->"
README_END = "<!-- LOC-BADGE:END -->"


def readme_block(per_lang, upstream=None):
    """首页里那段（取代原来的 shields 实时徽章）：一张小表格。

    有官方那棵树时给三列（本仓 / 官方 dev / 净增）；没有就给四列（代码 / 注释 / 空行 / 文件）。
    """
    total = total_of(per_lang)

    def n(x):
        return f"{x:,}"

    if upstream is not None:
        up_total = total_of(upstream)
        langs = sorted(set(per_lang) | set(upstream),
                       key=lambda k: -max(per_lang.get(k, {}).get("code", 0), upstream.get(k, {}).get("code", 0)))
        lines = [
            "| 代码量（不含空行与整行注释） | 本仓 | 官方 `dev` | 净增 |",
            "|---|---:|---:|---:|",
        ]
        for lang in langs:
            mine = per_lang.get(lang, {}).get("code", 0)
            up = upstream.get(lang, {}).get("code", 0)
            lines.append(f"| {lang} | {n(mine)} | {n(up)} | {mine - up:+,} |")
        lines.append(f"| **合计** | **{n(total)}**（{human(total)}） | **{n(up_total)}**（{human(up_total)}） | **{total - up_total:+,}** |")
        return "\n".join(lines)

    lines = ["| 代码量（不含空行与整行注释） | 代码 | 注释 | 空行 | 文件 |", "|---|---:|---:|---:|---:|"]
    for lang, v in sorted(per_lang.items(), key=lambda kv: -kv[1]["code"]):
        lines.append(f"| {lang} | {n(v['code'])} | {n(v['comment'])} | {n(v['blank'])} | {n(v['files'])} |")
    lines.append(f"| **合计** | **{n(total)}**（{human(total)}） | | | |")
    return "\n".join(lines)


def write_readme(path, per_lang, upstream=None):
    """只重写 BEGIN/END 之间那一行；标记不在就报错（不猜、不新建）。"""
    p = pathlib.Path(path)
    t = p.read_text(encoding="utf-8")
    i, j = t.find(README_BEGIN), t.find(README_END)
    if i < 0 or j < 0 or j < i:
        raise SystemExit(f"❌ {path} 里找不到 LOC-BADGE 标记（BEGIN/END），拒绝改写")
    new = f"{README_BEGIN}\n{readme_block(per_lang, upstream)}\n{README_END}"
    p.write_text(t[:i] + new + t[j + len(README_END):], encoding="utf-8")
    return readme_block(per_lang, upstream)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT, help="要数的树（默认本仓库）")
    ap.add_argument("--upstream", help="官方那棵树；给了就同时出「官方」与「净增」徽章")
    ap.add_argument("--out", help="写徽章 JSON 的目录（不存在就建）")
    ap.add_argument("--json", action="store_true", help="打印机器可读结果")
    ap.add_argument("--readme", help="把首页里 LOC-BADGE 标记之间那段重写成静态数字")
    args = ap.parse_args()

    per_lang = count_tree(args.root)
    upstream = count_tree(args.upstream) if args.upstream else None

    # 🔴 守门：上游那棵树要是没数到东西（路径写错、克隆失败、目录是空的），
    # **宁可报错也不要**出一个「官方 0 行 ⇒ 净增 = 本仓全部」的假数字。
    if upstream is not None and total_of(upstream) < 1000:
        print(f"❌ 官方树 `{args.upstream}` 只数到 {total_of(upstream)} 行 —— 路径不对或没拉下来，拒绝出数。", file=sys.stderr)
        return 2

    total = total_of(per_lang)

    if args.json:
        print(json.dumps({
            "ours": {"total": total, "per_lang": per_lang},
            "upstream": ({"total": total_of(upstream), "per_lang": upstream} if upstream else None),
            "added": (total - total_of(upstream)) if upstream else None,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"本仓：{total} 行（{human(total)}）")
        if upstream is not None:
            up = total_of(upstream)
            print(f"官方：{up} 行（{human(up)}） ⇒ 净增 {total - up:+d} 行")
        if upstream is not None:
            print(f"  {'语言':<12s} {'本仓':>9s} {'官方':>9s} {'净增':>9s}")
        else:
            print(f"  {'语言':<12s} {'代码':>9s} {'注释':>9s} {'空行':>9s} {'文件':>6s}")
        for lang in sorted(set(per_lang) | set(upstream or {}),
                           key=lambda k: -max(per_lang.get(k, {}).get("code", 0), (upstream or {}).get(k, {}).get("code", 0))):
            mine = per_lang.get(lang, {}).get("code", 0)
            if upstream is not None:
                up = upstream.get(lang, {}).get("code", 0)
                print(f"  {lang:<12s} {mine:>9d} {up:>9d} {mine - up:>+9d}")
            else:
                v = per_lang[lang]
                print(f"  {lang:<12s} {v['code']:>9d} {v['comment']:>9d} {v['blank']:>9d} {v['files']:>6d}")

    if args.readme:
        line = write_readme(args.readme, per_lang, upstream)
        print(f"\n已重写 {args.readme} 的代码量段：\n  {line}")

    if args.out:
        write_badges(args.out, per_lang, upstream)
        print(f"\n已写入 {args.out}/（{len(os.listdir(args.out))} 个文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
