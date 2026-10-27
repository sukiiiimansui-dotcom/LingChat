#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 bldcom / bldres 的**正立面**用 Cycles 烤成 PNG（透明背景），供运行时拼图集。

为什么不用 glTF 导出：本机 Blender 缺 draco，导出会崩（见 world_map 交接）；这里只渲 PNG。

用法：
  LD_LIBRARY_PATH=$HOME/osd37/lib blender-4.5 -b -t 4 -P bake_facades.py -- [--probe] [--samples N] [--only a,b]

产物：~/chk/_facade_cells/<asset>.png（渲染原图）+ <asset>.json（占地 w/h，拼图集时用）
下一步：python3 scripts/pack-bld-facade-atlas.py → public/ws3d/bldfacades/atlas.png
（源模型目录默认 ~/chk/_blender_assets，可用 --only 只烤其中几个）
  --probe 只把 cafe 的四个方位各渲一张小图，用来确认"正面朝哪条轴"。
"""
import bpy, os, sys, math, json
from mathutils import Vector

HOME = os.path.expanduser("~")
CELLS = os.path.join(HOME, "chk/_facade_cells")
os.makedirs(CELLS, exist_ok=True)
SRC = os.path.join(HOME, "chk/_blender_assets")

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PROBE = "--probe" in args
SAMPLES = 32
ONLY = None
for i, a in enumerate(args):
    if a == "--samples" and i + 1 < len(args):
        SAMPLES = int(args[i + 1])
    if a == "--only" and i + 1 < len(args):
        ONLY = [s.strip() for s in args[i + 1].split(",") if s.strip()]

# 每个类别用 variant 0 的一份几何：5 个商业底商 + 5 个住宅
ASSETS = [
    ("bldcom", "bld_cafe_0"),
    ("bldcom", "bld_pharm_0"),
    ("bldcom", "bld_rest_0"),
    ("bldcom", "bld_salon_0"),
    ("bldcom", "bld_super_0"),
    ("bldres", "bld_apartment_0"),
    ("bldres", "bld_highrise_0"),
    ("bldres", "bld_house_0"),
    ("bldres", "bld_midrise_0"),
    ("bldres", "bld_townhouse_0"),
]
if ONLY:
    ASSETS = [a for a in ASSETS if a[1] in ONLY]

# 立面高 512 像素；宽按真实宽高比取（宽立面硬压成 256 会把窗压成竖条）
H_PX = 512
W_MAX = 1024
W_MIN = 96


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def setup(samples, wpx):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 3
    sc.cycles.sample_clamp_indirect = 2.0
    sc.render.resolution_x = wpx
    sc.render.resolution_y = H_PX
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.threads_mode = "FIXED"
    sc.render.threads = 4
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    # Standard 而不是 AgX/Filmic：立面颜色要和资产包里的顶点色同口径，别被胶片曲线压暗
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except Exception:
        pass
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.74, 0.80, 0.88, 1.0)
    bg.inputs[1].default_value = 0.55
    return sc


def add_lights():
    # 主光：从**前上方偏左**打（立面最有立体感）；补光弱一点，避免死黑
    d = bpy.data.lights.new("sun", "SUN")
    d.energy = 2.0
    d.angle = math.radians(12)
    o = bpy.data.objects.new("sun", d)
    bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = (math.radians(55), 0, math.radians(25))
    f = bpy.data.lights.new("fill", "SUN")
    f.energy = 0.55
    f.angle = math.radians(40)
    o2 = bpy.data.objects.new("fill", f)
    bpy.context.scene.collection.objects.link(o2)
    o2.rotation_euler = (math.radians(70), 0, math.radians(200))


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def bounds(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return mn, mx


def look_at(cam, target):
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def ortho_cam(center, width_world, height_world):
    cd = bpy.data.cameras.new("cam")
    cd.type = "ORTHO"
    cd.sensor_fit = "HORIZONTAL"
    cd.ortho_scale = max(width_world, height_world * (bpy.context.scene.render.resolution_x / bpy.context.scene.render.resolution_y))
    cam = bpy.data.objects.new("cam", cd)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def probe():
    """四个方位各渲一张：确认正面在哪条轴上（glTF 正面 -Z ⇒ 导入 Blender 后通常朝 +Y）"""
    reset()
    setup(12, 160)
    add_lights()
    objs = import_glb(os.path.join(SRC, "bldcom/glb/bld_cafe_0.glb"))
    mn, mx = bounds(objs)
    c = (mn + mx) / 2
    size = max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z)
    views = {"posY": (0, 1, 0), "negY": (0, -1, 0), "posX": (1, 0, 0), "negX": (-1, 0, 0)}
    for name, (dx, dy, dz) in views.items():
        cam = ortho_cam(c, size * 1.15, size * 1.15)
        cam.location = Vector((c.x + dx * size * 4, c.y + dy * size * 4, c.z + dz * size * 4))
        look_at(cam, c)
        render_to(os.path.join(CELLS, "probe_" + name + ".png"))
    print("PROBE DONE")


def one(folder, asset):
    reset()
    path = os.path.join(SRC, folder, "glb", asset + ".glb")
    # 先量占地（相机框需要），分辨率按真实宽高比定
    # （用 bounds 需要先导入；导入一次即可）
    sc = setup(SAMPLES, 512)
    add_lights()
    objs = import_glb(path)
    mn, mx = bounds(objs)
    w = mx.x - mn.x
    h = mx.z - mn.z
    # 正立面朝 +Y（glTF 正面 -Z → Blender +Y）；相机放在 +Y 一侧朝 -Y 看
    wpx = int(round(H_PX * (w / h)))
    wpx = max(W_MIN, min(W_MAX, wpx))
    sc.render.resolution_x = wpx
    c = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2))
    cam = ortho_cam(c, w * 1.04, h * 1.04)
    cam.location = Vector((c.x, mx.y + max(w, h) * 4, c.z))
    look_at(cam, Vector((c.x, c.y, c.z)))
    out = os.path.join(CELLS, asset + ".png")
    render_to(out)
    meta = {"asset": asset, "folder": folder, "w_m": round(w, 3), "h_m": round(h, 3),
            "d_m": round(mx.y - mn.y, 3), "px": [wpx, H_PX]}
    open(os.path.join(CELLS, asset + ".json"), "w").write(json.dumps(meta, ensure_ascii=False))
    print("BAKED", asset, meta)


if PROBE:
    probe()
else:
    for folder, asset in ASSETS:
        one(folder, asset)
    print("ALL DONE")
