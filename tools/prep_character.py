"""AI-Secretary 角色素材管线 · 阶段 1：抠图 + 面部特征定位 + 调试图

输入  assets/character/source-850.png
输出  build/base.png        透明背景整图
      build/debug-face.png  带检测框与网格的调试图
      build/report.json     检测结果（眼睛/嘴/脖子/主体 bbox）
"""
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = r"D:\AI-Secretary"
SRC = os.path.join(ROOT, "assets", "character", "source-850.png")
BUILD = os.path.join(ROOT, "assets", "character", "build")
os.makedirs(BUILD, exist_ok=True)


def log(*a):
    print(*a, flush=True)


def load_rgb():
    im = Image.open(SRC).convert("RGB")
    return np.asarray(im, dtype=np.int16), im.size


def estimate_bg(arr):
    h, w, _ = arr.shape
    patches = []
    for (y0, x0) in [(0, 0), (0, w - 40), (h - 40, 0), (h - 40, w - 40), (0, w // 2)]:
        patches.append(arr[y0:y0 + 40, x0:x0 + 40].reshape(-1, 3))
    p = np.concatenate(patches, axis=0)
    return np.median(p, axis=0)


def flood_bg(is_bg_candidate, seed_mask):
    """从边缘种子出发，在候选背景像素上做 4 连通 BFS。"""
    h, w = is_bg_candidate.shape
    out = np.zeros((h, w), bool)
    q = deque()
    ys, xs = np.nonzero(seed_mask & is_bg_candidate)
    for y, x in zip(ys, xs):
        if not out[y, x]:
            out[y, x] = True
            q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not out[ny, nx] and is_bg_candidate[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out


def largest_components(mask, keep):
    """保留面积最大的 keep 个 4 连通块。"""
    h, w = mask.shape
    label = np.zeros((h, w), np.int32)
    areas = []
    cur = 0
    for sy in range(h):
        row = mask[sy]
        for sx in range(w):
            if not row[sx] or label[sy, sx]:
                continue
            cur += 1
            q = deque([(sy, sx)])
            label[sy, sx] = cur
            n = 0
            while q:
                y, x = q.popleft()
                n += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not label[ny, nx]:
                        label[ny, nx] = cur
                        q.append((ny, nx))
            areas.append((n, cur))
    areas.sort(reverse=True)
    keep_ids = {c for _, c in areas[:keep]}
    return np.isin(label, list(keep_ids)), areas[:6]


def fill_holes(mask):
    """把不与边框连通的背景区域填回前景（救回被轮廓包住的白色蕾丝）。"""
    h, w = mask.shape
    outside = flood_bg(~mask, np.zeros((h, w), bool) | _border(w, h))
    return mask | ~outside


def _border(w, h):
    b = np.zeros((h, w), bool)
    b[0, :] = b[-1, :] = True
    b[:, 0] = b[:, -1] = True
    return b


def main():
    arr, (w, h) = load_rgb()
    bg = estimate_bg(arr)
    log(f"size={w}x{h} bg={bg.tolist()}")

    dist = np.abs(arr - bg).sum(axis=2)
    for tol in (10, 14, 18, 24, 30):
        cand = dist < tol * 3
        bgmask = flood_bg(cand, _border(w, h))
        fg = ~bgmask
        log(f"tol={tol:3d} bg={bgmask.mean()*100:5.1f}% fg={fg.mean()*100:5.1f}%")

    tol = int(os.environ.get("TOL", "14"))
    cand = dist < tol * 3
    bgmask = flood_bg(cand, _border(w, h))
    fg = ~bgmask
    fg = fill_holes(fg)
    fg, areas = largest_components(fg, 1)
    log(f"components: {areas}")

    a = (fg * 255).astype(np.uint8)
    alpha = np.asarray(Image.fromarray(a).filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32)
    rgba = np.dstack([np.asarray(Image.open(SRC).convert("RGB"), np.uint8), alpha.clip(0, 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(os.path.join(BUILD, "base.png"))

    ys, xs = np.nonzero(fg)
    bbox = dict(x=int(xs.min()), y=int(ys.min()), x2=int(xs.max()), y2=int(ys.max()))
    bbox["w"] = bbox["x2"] - bbox["x"] + 1
    bbox["h"] = bbox["y2"] - bbox["y"] + 1
    log(f"bbox={bbox}")

    # ---- 面部特征：在主体上部 12%~30% 高度里找两眼 + 嘴 ----
    top = bbox["y"]
    face_top = top + int(bbox["h"] * 0.075)
    face_bot = top + int(bbox["h"] * 0.20)
    band = arr[face_top:face_bot, bbox["x"]:bbox["x2"]]
    lum = band.sum(axis=2) / 3.0
    dark = lum < 120
    dark = fill_holes(dark)
    fgl = fg[face_top:face_bot, bbox["x"]:bbox["x2"]]
    dark &= fgl

    lbl, n = _label(dark)
    blobs = []
    for i in range(1, n + 1):
        m = lbl == i
        area = int(m.sum())
        if area < 120:
            continue
        yy, xx = np.nonzero(m)
        blobs.append(dict(area=area, x=int(xx.min()) + bbox["x"], y=int(yy.min()) + face_top,
                          x2=int(xx.max()) + bbox["x"], y2=int(yy.max()) + face_top,
                          cx=int(xx.mean()) + bbox["x"], cy=int(yy.mean()) + face_top))
    blobs.sort(key=lambda b: -b["area"])
    log("dark blobs:", [(b["area"], b["cx"], b["cy"]) for b in blobs[:8]])

    eyes = [b for b in blobs if b["area"] >= 300][:4]
    eyes.sort(key=lambda b: b["cx"])
    if len(eyes) > 2:
        eyes = eyes[:2] if abs(eyes[0]["cy"] - eyes[1]["cy"]) < 60 else [max(eyes[:2], key=lambda b: b["area"]), max(eyes[2:4], key=lambda b: b["area"])]
    log("eyes:", [(e["cx"], e["cy"], e["area"]) for e in eyes])

    # ---- 调试图 ----
    dbg = Image.open(SRC).convert("RGBA")
    on_alpha = Image.new("RGBA", dbg.size, (18, 22, 34, 255))
    dbg = Image.alpha_composite(on_alpha, Image.fromarray(rgba, "RGBA"))
    d = ImageDraw.Draw(dbg)
    d.rectangle([bbox["x"], bbox["y"], bbox["x2"], bbox["y2"]], outline=(0, 255, 120, 255), width=2)
    for i, e in enumerate(eyes):
        d.rectangle([e["x"], e["y"], e["x2"], e["y2"]], outline=(255, 60, 60, 255), width=2)
        d.text((e["x"], e["y"] - 14), f"eye{i}", fill=(255, 90, 90, 255))
    for gx in range(0, w, 50):
        d.line([(gx, face_top - 40), (gx, face_bot + 40)], fill=(255, 255, 0, 90))
        d.text((gx + 2, face_top - 40), str(gx), fill=(255, 255, 0, 255))
    for gy in range(face_top - 40, face_bot + 40, 25):
        d.line([(bbox["x"], gy), (bbox["x2"], gy)], fill=(0, 200, 255, 90))
        d.text((bbox["x"] + 2, gy), str(gy), fill=(0, 220, 255, 255))
    dbg.save(os.path.join(BUILD, "debug-face.png"))

    report = dict(size=[w, h], bg=[int(v) for v in bg], tol=tol, bbox=bbox,
                  faceBand=[face_top, face_bot], eyes=eyes[:2], blobs=blobs[:8])
    with open(os.path.join(BUILD, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    log("wrote build/base.png debug-face.png report.json")


def _label(mask):
    h, w = mask.shape
    label = np.zeros((h, w), np.int32)
    cur = 0
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or label[sy, sx]:
                continue
            cur += 1
            q = deque([(sy, sx)])
            label[sy, sx] = cur
            while q:
                y, x = q.popleft()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not label[ny, nx]:
                        label[ny, nx] = cur
                        q.append((ny, nx))
    return label, cur


if __name__ == "__main__":
    sys.exit(main())
