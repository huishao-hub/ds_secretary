"""AI-Secretary 角色素材管线 · 阶段 2：分层 + 表情头部变体 + 特效 + rig.json

为什么是"烘焙表情变体"而不是"叠加眼皮图层"：
  只有一张立绘时，用肤色图层盖眼睛会露出色差边缘，像贴了绷带。
  这里改成直接在整幅分辨率上把眼睛/嘴"修掉"再重画，产出与画风完全一致的表情帧，
  WPF 端用双层 Image 做交叉淡入即可自然切换（眨眼 90ms、表情 200ms）。
  这不是"切换静态图片冒充动画"——连续运动（呼吸/摇摆/点头/浮动）全部由变换驱动，
  表情变体只负责五官状态。

坐标全部基于原图 850x1275。
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = r"D:\AI-Secretary"
CH = os.path.join(ROOT, "assets", "character")
BUILD = os.path.join(CH, "build")
LAYERS = os.path.join(CH, "layers")
os.makedirs(LAYERS, exist_ok=True)

NECK_Y = 285
NECK_PIVOT = (418, 262)

# 眼睛框（含睫毛，略放宽）
EYES = {
    "l": dict(x=350, y=169, w=58, h=35),
    "r": dict(x=408, y=147, w=57, h=44),
}
MOUTH = dict(x=395, y=211, w=54, h=35)


def log(*a):
    print(*a, flush=True)


def load_base():
    return Image.open(os.path.join(BUILD, "base.png")).convert("RGBA")


def skin_patches(arr, boxes):
    """从若干干净区域取肤色中位数。"""
    cols = []
    for (x, y, w, h) in boxes:
        reg = arr[y:y + h, x:x + w].reshape(-1, 3)
        lum = reg.mean(axis=1)
        cols.append(reg[(lum > 175) & (reg[:, 0] >= reg[:, 2] - 12)])
    pool = np.concatenate([c for c in cols if len(c)], axis=0)
    return np.median(pool, axis=0)


def local_skin(img, box, grow=16):
    """取眼睛框外圈的真实肤色中位数 + 上下明暗，作为填充色与渐变。"""
    x, y, w, h = box
    W, H = img.size
    x0, y0 = max(0, x - grow), max(0, y - grow)
    x1, y1 = min(W, x + w + grow), min(H, y + h + grow)
    reg = np.asarray(img.convert("RGB"), np.int16)[y0:y1, x0:x1]
    flat = reg.reshape(-1, 3)
    m = (flat[:, 0] > 195) & (flat[:, 1] > 155) & (flat[:, 1] < flat[:, 0] + 4) & (flat[:, 2] < flat[:, 1] + 18)
    if m.sum() > 200:
        base = np.median(flat[m], axis=0)
    else:
        base = np.median(flat[flat.mean(axis=1) > np.percentile(flat.mean(axis=1), 75)], axis=0)
    skin_mask = m.reshape(reg.shape[0], reg.shape[1]) if m.sum() > 200 else np.ones(reg.shape[:2], bool)
    top = np.median(reg[:max(1, grow)][skin_mask[:max(1, grow)]], axis=0) if skin_mask[:max(1, grow)].sum() else base
    bot = np.median(reg[-max(1, grow):][skin_mask[-max(1, grow):]], axis=0) if skin_mask[-max(1, grow):].sum() else base
    return base.astype(np.float32), top.astype(np.float32), bot.astype(np.float32)


def fill_eye_skin(img, box, strength=1.0):
    """用局部真实肤色做上下渐变填充，椭圆羽化。"""
    x, y, w, h = box
    W, H = img.size
    base, top, bot = local_skin(img, box)
    rgb = np.asarray(img, np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    cx, cy = x + w / 2.0, y + h / 2.0
    rx, ry = w * 0.46, h * 0.48
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    mask = (np.clip((1.04 - d) / 0.22, 0, 1) * strength)[:, :, None]
    g = np.clip((yy - (cy - ry)) / max(1.0, 2 * ry), 0, 1)[:, :, None]
    grad = top.reshape(1, 1, 3) * (1 - g) + bot.reshape(1, 1, 3) * g
    grad = grad * 0.55 + base.reshape(1, 1, 3) * 0.45
    rgb[:, :, :3] = rgb[:, :, :3] * (1 - mask) + grad * mask
    return Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGBA")


def draw_eye_line(img, box, color, mode):
    """4 倍超采样画闭眼线，避免锯齿。"""
    x, y, w, h = box
    s = 4
    cv = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(cv)

    if mode == "half":
        y0 = h * 0.30
        hh = h * 0.70
    else:
        y0, hh = 0.0, h

    pts = []
    n = 32
    for i in range(n + 1):
        t = i / n
        px = (1.5 + t * (w - 3)) * s
        bulge = math.sin(t * math.pi)
        if mode == "happy":
            py = (y0 + hh * 0.58 - bulge * hh * 0.26) * s
        elif mode == "half":
            py = (y0 + hh * 0.46 + bulge * hh * 0.06) * s
        else:
            py = (y0 + hh * 0.62 + bulge * hh * 0.10) * s
        pts.append((px, py))

    d.line(pts, fill=color + (255,), width=int(2.6 * s), joint="curve")
    # 眼尾小挑
    for (tx, ty), sgn in ((pts[0], -1), (pts[-1], 1)):
        d.line([(tx, ty), (tx + sgn * 3.2 * s, ty - 3.0 * s)], fill=color + (235,), width=int(2.2 * s))
    cv = cv.resize((w, h), Image.LANCZOS)
    img.alpha_composite(cv, (x, y))
    return img


def lash_color(img, box):
    arr = np.asarray(img.convert("RGB"), np.int16)
    x, y, w, h = box
    reg = arr[y:y + h, x:x + w].reshape(-1, 3)
    i = int(np.argmin(reg.sum(axis=1)))
    return tuple(int(v) for v in reg[i])


def curve_eye(d, box, color, mode, width=4):
    """在眼睛框里画闭眼曲线。mode: closed=下凸, happy=上凸, half=只到一半。"""
    x, y, w, h = box
    if mode == "half":
        y = y + int(h * 0.18)
        h = int(h * 0.82)
    pts = []
    n = max(8, w // 2)
    for i in range(n + 1):
        t = i / n
        px = x + 2 + t * (w - 4)
        bulge = math.sin(t * math.pi)
        if mode == "happy":
            py = y + h * 0.52 - bulge * h * 0.30
        elif mode == "half":
            py = y + h * 0.34 + bulge * h * 0.10
        else:
            py = y + h * 0.50 + bulge * h * 0.14
        pts.append((px, py))
    d.line(pts, fill=color + (255,), width=width, joint="curve")
    # 外眼角加一小撮睫毛
    tx, ty = pts[0]
    d.line([(tx, ty), (tx - 3, ty - 4)], fill=color + (230,), width=max(2, width - 2))
    tx, ty = pts[-1]
    d.line([(tx, ty), (tx + 3, ty - 4)], fill=color + (230,), width=max(2, width - 2))


def eye_shadow(img, box, mode):
    """闭眼时眼窝的一点阴影，避免看起来太平。"""
    x, y, w, h = box
    sh = Image.new("RGBA", (w + 10, h + 10), (0, 0, 0, 0))
    d = ImageDraw.Draw(sh)
    top = 4 if mode != "half" else int(h * 0.5)
    d.ellipse([4, top, w + 5, top + int(h * 0.5)], fill=(120, 110, 135, 40))
    sh = sh.filter(ImageFilter.GaussianBlur(3.5))
    img.alpha_composite(sh, (x - 5, y - 5))
    return img


def draw_mouth_closed(img, box, color):
    d = ImageDraw.Draw(img)
    x, y, w, h = box
    # 一条浅浅的微笑
    pts = []
    for i in range(21):
        t = i / 20
        pts.append((x + w * 0.22 + t * w * 0.56, y + h * 0.55 + math.sin(t * math.pi) * h * 0.13))
    d.line(pts, fill=color + (215,), width=3, joint="curve")
    # 下唇一点高光
    hi = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse([w * 0.28, h * 0.70, w * 0.72, h * 0.92], fill=(255, 215, 220, 70))
    img.alpha_composite(hi.filter(ImageFilter.GaussianBlur(2.5)), (x, y))
    return img


def draw_blush(img, centers):
    out = img.copy()
    for (cx, cy) in centers:
        w, h = 104, 58
        patch = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(patch)
        for i in range(16, 0, -1):
            a = int(11 * (17 - i) / 16)
            d.ellipse([w / 2 - i * 3.1, h / 2 - i * 1.75, w / 2 + i * 3.1, h / 2 + i * 1.75],
                      fill=(255, 110, 140, a))
        patch = patch.filter(ImageFilter.GaussianBlur(3))
        out.alpha_composite(patch, (int(cx - w / 2), int(cy - h / 2)))
    return out


def make_head_variants(base, palette):
    W, H = base.size
    head_full = base.crop((0, 0, W, NECK_Y)).copy()
    lash_l = (62, 66, 96)
    lash_r = (62, 66, 96)
    mouth_col = (150, 96, 104)
    box_of = {k: (v["x"], v["y"], v["w"], v["h"]) for k, v in EYES.items()}
    mbox = (MOUTH["x"], MOUTH["y"], MOUTH["w"], MOUTH["h"])

    def close_eyes(img, mode):
        out = img.copy()
        for side, box in box_of.items():
            out = fill_eye_skin(out, box)
        for side, box in box_of.items():
            out = draw_eye_line(out, box, lash_l if side == "l" else lash_r, mode)
        return out

    def close_mouth(img):
        out = fill_eye_skin(img, mbox, strength=1.0)
        x, y, w, h = mbox
        s = 4
        cv = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
        d = ImageDraw.Draw(cv)
        pts = []
        for i in range(25):
            t = i / 24
            pts.append(((w * 0.33 + t * w * 0.34) * s,
                        (h * 0.46 + math.sin(t * math.pi) * h * 0.12) * s))
        d.line(pts, fill=mouth_col + (200,), width=int(2.2 * s), joint="curve")
        cv = cv.resize((w, h), Image.LANCZOS)
        out.alpha_composite(cv, (x, y))
        return out

    variants = {}
    variants["talk"] = head_full.copy()
    variants["idle"] = close_mouth(head_full.copy())
    variants["blink"] = close_eyes(close_mouth(head_full.copy()), "closed")
    variants["happy"] = draw_blush(close_eyes(close_mouth(head_full.copy()), "happy"),
                                   [(374, 214), (452, 198)])
    return variants


def make_fx():
    out = {}
    s = Image.new("RGBA", (26, 34), (0, 0, 0, 0))
    d = ImageDraw.Draw(s)
    d.polygon([(13, 2), (23, 20), (13, 32), (3, 20)], fill=(150, 205, 240, 235))
    d.ellipse([7, 16, 13, 24], fill=(255, 255, 255, 170))
    out["sweat"] = (s, (474, 128))

    z = Image.new("RGBA", (74, 62), (0, 0, 0, 0))
    d = ImageDraw.Draw(z)
    for i, (ox, oy, sc) in enumerate([(0, 30, 1.0), (24, 14, 0.72), (44, 2, 0.5)]):
        w, h = int(20 * sc), int(22 * sc)
        d.line([(ox, oy), (ox + w, oy), (ox, oy + h), (ox + w, oy + h)],
               fill=(120, 165, 235, 210 - i * 30), width=max(2, int(3 * sc)), joint="curve")
    out["zzz"] = (z, (498, 90))

    sp = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(sp)
    for (cx, cy, r, col) in [(46, 40, 17, (255, 226, 140, 235)), (20, 62, 9, (255, 240, 190, 200)),
                             (72, 22, 8, (255, 240, 190, 190))]:
        pts = []
        for i in range(8):
            ang = -math.pi / 2 + i * math.pi / 4
            rr = r if i % 2 == 0 else r * 0.42
            pts.append((cx + math.cos(ang) * rr, cy + math.sin(ang) * rr))
        d.polygon(pts, fill=col)
    out["sparkle"] = (sp.filter(ImageFilter.GaussianBlur(0.6)), (596, 112))

    ex = Image.new("RGBA", (26, 46), (0, 0, 0, 0))
    d = ImageDraw.Draw(ex)
    d.rounded_rectangle([8, 2, 18, 30], radius=5, fill=(240, 100, 110, 240))
    d.ellipse([8, 34, 18, 44], fill=(240, 100, 110, 240))
    out["exclaim"] = (ex, (610, 92))

    th = Image.new("RGBA", (60, 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(th)
    for i in range(3):
        d.ellipse([4 + i * 18, 8, 12 + i * 18, 16], fill=(150, 170, 210, 220))
    out["think"] = (th, (556, 116))

    hr = Image.new("RGBA", (44, 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(hr)
    for dx in (-1, 0, 1):
        pts = []
        for i in range(9):
            t = i / 8
            pts.append((6 + dx + t * 30, 14 + math.sin(t * math.pi) * 9))
        d.line(pts, fill=(255, 120, 150, 210), width=2, joint="curve")
    out["anger"] = (hr, (612, 108))

    return out


def main():
    base = load_base()
    W, H = base.size
    log(f"base {W}x{H}")

    body = base.crop((0, NECK_Y - 16, W, H))
    body.save(os.path.join(LAYERS, "body.png"))

    lash_of = {}
    for side, b in EYES.items():
        arr = np.asarray(base.convert("RGB"), np.int16)
        reg = arr[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]].reshape(-1, 3)
        i = int(np.argmin(reg.sum(axis=1)))
        lash_of[side] = tuple(int(v) for v in reg[i])
    marr = np.asarray(base.convert("RGB"), np.int16)
    mreg = marr[MOUTH["y"]:MOUTH["y"] + MOUTH["h"], MOUTH["x"]:MOUTH["x"] + MOUTH["w"]].reshape(-1, 3)
    mouth_col = tuple(int(v) for v in mreg[int(np.argmin(mreg.sum(axis=1)))])
    palette = {f"eye-{k}": dict(lash=list(v)) for k, v in lash_of.items()}
    palette["mouth"] = list(mouth_col)

    arr_rgb = np.asarray(base.convert("RGB"), np.int16)
    skin = skin_patches(arr_rgb, [
        (402, 250, 60, 24),   # 下巴/颈
        (352, 206, 34, 14),   # 左脸颊
        (452, 206, 14, 12),   # 右脸颊
    ])
    log("skin:", [int(v) for v in skin])

    heads = make_head_variants(base, palette)
    head_meta = {}
    for name, img in heads.items():
        fn = f"head-{name}.png"
        img.save(os.path.join(LAYERS, fn))
        head_meta[name] = dict(file=f"layers/{fn}", w=W, h=NECK_Y)

    fx = {}
    for name, (img, pos) in make_fx().items():
        img.save(os.path.join(LAYERS, f"fx-{name}.png"))
        fx[name] = dict(x=pos[0], y=pos[1], w=img.width, h=img.height)

    base.crop((300, 40, 540, 300)).resize((128, 128), Image.LANCZOS).save(os.path.join(CH, "icon.png"))

    rig = dict(
        name="xi", displayName="汐",
        canvas=dict(w=W, h=H),
        neckY=NECK_Y,
        pivot=dict(x=NECK_PIVOT[0], y=NECK_PIVOT[1]),
        parts=[
            dict(id="body", file="layers/body.png", x=0, y=NECK_Y - 16, w=W, h=H - (NECK_Y - 16), z=10),
            dict(id="head", x=0, y=0, w=W, h=NECK_Y, z=20, pivot=dict(x=NECK_PIVOT[0], y=NECK_PIVOT[1]),
                 variants=head_meta, default="idle"),
        ],
        eyes=EYES, mouth=MOUTH, fx=fx, palette=palette,
        anchor=dict(feetY=H - 6, topY=0),
        notes="head 有 5 个表情变体（idle/talk/blink/half/happy），WPF 端双层交叉淡入；身体与头部绕颈部枢轴做连续变换。",
    )
    with open(os.path.join(CH, "rig.json"), "w", encoding="utf-8") as f:
        json.dump(rig, f, ensure_ascii=False, indent=2)
    log("rig.json ok")
    render_sheet(base, rig)


def stack_frames(base, rig, state):
    """把某一状态的头部变体 + 身体合成一帧（供离线预览）。"""
    W, H = base.size
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    body = next(p for p in rig["parts"] if p["id"] == "body")
    out.alpha_composite(Image.open(os.path.join(LAYERS, "body.png")), (body["x"], body["y"]))
    head = next(p for p in rig["parts"] if p["id"] == "head")
    hv = head["variants"][state]
    out.alpha_composite(Image.open(os.path.join(LAYERS, hv["file"].split("/")[-1])), (0, 0))
    return out


def render_sheet(base, rig):
    states = ["idle", "talk", "blink", "happy"]
    panels = []
    for st in states:
        f = stack_frames(base, rig, st)
        for name, fx in rig["fx"].items():
            if (st, name) in (("happy", "sparkle"), ("blink", "zzz")):
                f.alpha_composite(Image.open(os.path.join(LAYERS, f"fx-{name}.png")), (fx["x"], fx["y"]))
        panels.append((st, f))
    big = 400
    small = 180
    band = Image.new("RGBA", (int(base.width * big / base.height) * len(panels), big + small + 30), (30, 34, 48, 255))
    x = 0
    for st, f in panels:
        w1 = int(f.width * big / f.height)
        band.alpha_composite(f.resize((w1, big), Image.LANCZOS), (x, 20))
        w2 = int(f.width * small / f.height)
        band.alpha_composite(f.resize((w2, small), Image.LANCZOS), (x + 10, big + 26))
        ImageDraw.Draw(band).text((x + 6, 4), st, fill=(255, 255, 255, 255))
        x += max(w1, w2) + 12
    band.save(os.path.join(BUILD, "preview-heads.png"))
    log("preview-heads.png ok")


if __name__ == "__main__":
    main()
