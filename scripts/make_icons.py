#!/usr/bin/env python3
"""Build extension icons.

If extension/assets/logo.png exists (your Joker / Hanuman artwork, square,
>= 512 px), it is used for every size. Otherwise a placeholder mark is drawn.
"""
import pathlib
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "extension" / "icons"
out.mkdir(parents=True, exist_ok=True)
logo = root / "extension" / "assets" / "logo.png"
SIZES = (16, 32, 48, 128)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def placeholder(size=512):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = Image.new("RGBA", (s, s), (14, 28, 54, 255))
    img.paste(bg, (0, 0), rounded_mask(s, int(s * 0.22)))
    d = ImageDraw.Draw(img)
    cyan = (27, 231, 255, 255)
    amber = (245, 166, 35, 255)
    # Hexagonal shield
    import math
    cx, cy, r = s / 2, s / 2, s * 0.36
    pts = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]
    d.polygon(pts, outline=cyan, width=int(s * 0.035))
    # Jester crown: three points with amber tips
    w = s * 0.34
    base_y = cy + s * 0.08
    top_y = cy - s * 0.16
    left = cx - w / 2
    crown = [(left, base_y), (left, top_y), (cx - w / 4, cy - s * 0.02), (cx, top_y - s * 0.04),
             (cx + w / 4, cy - s * 0.02), (left + w, top_y), (left + w, base_y)]
    d.polygon(crown, fill=cyan)
    for x, y in ((left, top_y), (cx, top_y - s * 0.04), (left + w, top_y)):
        rr = s * 0.035
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=amber)
    d.rectangle([left, base_y + s * 0.03, left + w, base_y + s * 0.07], fill=cyan)
    return img


src = Image.open(logo).convert("RGBA") if logo.exists() else placeholder()
for size in SIZES:
    im = src.resize((size, size), Image.LANCZOS)
    if logo.exists():
        rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rounded.paste(im, (0, 0), rounded_mask(size, max(2, int(size * 0.22))))
        im = rounded
    im.save(out / f"icon-{size}.png")
print("icons written from", "assets/logo.png" if logo.exists() else "placeholder")
