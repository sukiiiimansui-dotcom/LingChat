#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把烘好的正立面 PNG 拼成 2048² 图集（≤1.5 MB），并输出运行时用的归一化 UV 矩形。

输入：~/chk/_facade_cells/<asset>.png + .json（scripts/bake-bld-facades.py 产物）
产物：public/ws3d/bldfacades/atlas.png
      public/ws3d/bldfacades/atlas.json（像素矩形，留档）
      stdout：TS 常量片段（class → {u,v,du,dv}，已做 flipY 修正）

坐标系：three 的 Texture 默认 flipY=true ⇒ 图集里 (u,v) 的 v 从**下**往上数；
  这里直接把像素矩形换算成 three 的 UV 空间，运行时不用再翻。
"""
import json, os, glob
import numpy as np
from PIL import Image, ImageFilter

HOME = os.path.expanduser("~")
CELLS = os.path.join(HOME, "chk/_facade_cells")
REPO = os.path.join(HOME, "lingchat-fork/v052")
OUTDIR = os.path.join(REPO, "public/ws3d/bldfacades")
ATLAS = 2048
GAP = 4
MAX_W = 960           # 单张立面在拼图集里的最大宽度（宽立面按比例缩）
CELL_H = 480          # 统一高度（4 行 × 480 + 间隙才装得进 2048²）
BG = (0.80, 0.81, 0.82)   # 立面以外的空隙合成中性墙色（材质不透明，图的 alpha 不参与）


def load(asset):
    p = os.path.join(CELLS, asset + ".png")
    if not os.path.exists(p):
        return None
    im = Image.open(p).convert("RGBA")
    a = np.asarray(im)
    ys, xs = np.nonzero(a[..., 3] > 8)
    if not len(xs):
        return None
    im = im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    # 合成到中性墙色上：材质是不透明的，透明区（天空/退台）会露出底色
    bg = Image.new("RGBA", im.size, (int(BG[0] * 255), int(BG[1] * 255), int(BG[2] * 255), 255))
    bg.alpha_composite(im)
    im = bg.convert("RGB")
    w, h = im.size
    s = min(CELL_H / h, MAX_W / w)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    im = im.resize((nw, nh), Image.LANCZOS)
    # 轻微模糊：去掉降噪后的残余梯度噪声，PNG 体积小一半以上（立面细节不受影响）
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    return im


def main():
    assets = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(CELLS, "bld_*.png"))
                    if not p.endswith("_chk.png"))
    imgs = []
    for a in assets:
        im = load(a)
        if im is not None:
            imgs.append((a, im))
    if not imgs:
        print("没有可用的立面 PNG")
        return 1
    # shelf packing：按高度降序排，行高取该行最高
    imgs.sort(key=lambda t: -t[1].height)
    placed = []
    x = y = 0
    row_h = 0
    for a, im in imgs:
        if x + im.width + GAP > ATLAS:
            x = 0
            y += row_h + GAP
            row_h = 0
        if y + im.height > ATLAS:
            print("放不下：", a)
            return 2
        placed.append((a, im, x, y))
        x += im.width + GAP
        row_h = max(row_h, im.height)
    atlas = Image.new("RGB", (ATLAS, ATLAS), (int(BG[0] * 255), int(BG[1] * 255), int(BG[2] * 255)))
    for a, im, px, py in placed:
        atlas.paste(im, (px, py))
    os.makedirs(OUTDIR, exist_ok=True)
    png = os.path.join(OUTDIR, "atlas.png")
    # 调色板量化（224 色）：立面都是平涂 + 软阴影，肉眼无损，但 PNG 体积掉到 1/3
    # （不量化时 2048² 的 Render 结果约 1.8 MB，超预算）
    q = atlas.quantize(colors=224, method=Image.Quantize.MEDIANCUT)
    q.save(png, optimize=True)
    if os.path.getsize(png) > 1_500_000:
        q2 = atlas.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        q2.save(png, optimize=True)
    size = os.path.getsize(png)

    rects = {}
    for a, im, px, py in placed:
        cls = a.split("_")[1]
        u0 = px / ATLAS
        du = im.width / ATLAS
        dv = im.height / ATLAS
        v1 = 1.0 - py / ATLAS           # 上边缘 → v 大
        v0 = v1 - dv
        rects[cls] = {"u": round(u0, 6), "v": round(v0, 6), "du": round(du, 6), "dv": round(dv, 6),
                      "px": [px, py, im.width, im.height], "asset": a}
    meta = {"atlas": ATLAS, "bytes": size, "cells": rects}
    open(os.path.join(OUTDIR, "atlas.json"), "w").write(json.dumps(meta, ensure_ascii=False, indent=1))

    print("ATLAS_BYTES", size, "cells", len(rects))
    lines = []
    for cls, r in sorted(rects.items()):
        lines.append('  %s: { u: %s, v: %s, du: %s, dv: %s },' % (cls, r["u"], r["v"], r["du"], r["dv"]))
    print("=== TS ===")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
