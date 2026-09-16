#!/usr/bin/env python3
"""Add a macOS-style window frame to a screenshot, matching floorvote.org's
`.frame` treatment.

Trims excess background, normalises the background colour, adds uniform
padding, draws the dot-bar, rounds the corners, and adds a 1px border.

Usage:
    python3 scripts/frame-screenshot.py <input.png> [output.png]

If output is omitted, writes to <input>-framed.png next to the input.
"""

import math
import os
import sys

from PIL import Image, ImageDraw

# ── Design tokens (CSS px, doubled for 2× retina) ──────────────────────────

SCALE = 2  # retina

# .frame  border-radius: var(--radius-xl) = 12px
CORNER_R = 12 * SCALE

# .frame  border: 1px solid var(--border) = #e2e8f0
BORDER_W = 1 * SCALE
BORDER_COLOR = (226, 232, 240)

# .frame__bar  padding: 11px 14px; background: var(--surface-muted) = #f5f8fc
#              border-bottom: 1px solid var(--border) = #e2e8f0
BAR_PAD_V = 11 * SCALE
BAR_PAD_H = 14 * SCALE
BAR_BG = (245, 248, 252)
BAR_BORDER = (226, 232, 240)

# .frame__dot  11px × 11px; background: var(--border-strong) = #cbd5e1
DOT_SIZE = 11 * SCALE
DOT_GAP = 7 * SCALE
DOT_COLOR = (203, 213, 225)

# Bar height = top pad + dot + bottom pad + 1px border-bottom
BAR_H = BAR_PAD_V + DOT_SIZE + BAR_PAD_V + BORDER_W

# .frame__body  background: var(--surface-subtle) = #f8fafc
BODY_BG = (248, 250, 252)

# Padding between the screenshot content and the frame edge (inside body)
BODY_PAD = 12 * SCALE
BODY_PAD_TOP = 14 * SCALE  # extra breathing room below the bar

# ── Trim helpers (simplified from normalize-screenshots.py) ─────────────────

BG_TOL = 4
FLAT_TOL = 2
LIGHT_MIN = 238


def corner_bg(px, w, h):
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    return max(set(corners), key=corners.count)


def line_pixels(px, w, h, side, i):
    if side == "top":
        return [px[x, i] for x in range(w)]
    if side == "bottom":
        return [px[x, h - 1 - i] for x in range(w)]
    if side == "left":
        return [px[i, y] for y in range(h)]
    return [px[w - 1 - i, y] for y in range(h)]


def trimmable(vals, bg):
    devs = [max(abs(c[j] - bg[j]) for j in range(3)) for c in vals]
    if sum(1 for d in devs if d <= BG_TOL) >= len(devs) * 0.99:
        return True
    flat = all(
        max(c[j] for c in vals) - min(c[j] for c in vals) <= FLAT_TOL
        for j in range(3)
    )
    light = min(min(c) for c in vals) >= LIGHT_MIN
    return flat and light


def compute_trim(img):
    w, h = img.size
    px = img.load()
    bg = corner_bg(px, w, h)
    trim = {}
    for side in ("top", "bottom", "left", "right"):
        limit = (h if side in ("top", "bottom") else w) // 3
        i = 0
        while i < limit and trimmable(line_pixels(px, w, h, side, i), bg):
            i += 1
        trim[side] = i
    return bg, trim


def recolour(img, bg, target):
    delta = tuple(target[i] - bg[i] for i in range(3))
    if not any(delta):
        return img
    fade = 24
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            dev = max(abs(c[j] - bg[j]) for j in range(3))
            if dev >= fade:
                continue
            weight = 1.0 - dev / fade
            px[x, y] = tuple(
                max(0, min(255, round(c[j] + delta[j] * weight))) for j in range(3)
            )
    return img


# ── Rounded-rectangle mask ──────────────────────────────────────────────────

def rounded_rect_mask(w, h, r):
    """Return an alpha mask (mode 'L') with antialiased rounded corners."""
    # Draw at 4× for antialiasing, then downscale
    ss = 4
    big = Image.new("L", (w * ss, h * ss), 0)
    draw = ImageDraw.Draw(big)
    draw.rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius=r * ss, fill=255)
    return big.resize((w, h), Image.LANCZOS)


# ── Main ────────────────────────────────────────────────────────────────────

def frame(input_path, output_path):
    img = Image.open(input_path).convert("RGB")
    orig_w, orig_h = img.size
    print(f"Input: {orig_w}x{orig_h}")

    # 1. Trim background
    bg, t = compute_trim(img)
    img = img.crop((t["left"], t["top"], orig_w - t["right"], orig_h - t["bottom"]))
    print(
        f"Trim:  T{t['top']} R{t['right']} B{t['bottom']} L{t['left']} "
        f"bg={bg} -> {img.width}x{img.height}"
    )

    # 2. Normalise background colour to BODY_BG
    img = recolour(img, bg, BODY_BG)

    # 3. Compute final dimensions
    content_w, content_h = img.size
    inner_w = content_w + 2 * BODY_PAD
    inner_h = BODY_PAD_TOP + content_h + BODY_PAD  # top and bottom pad
    frame_w = inner_w + 2 * BORDER_W
    frame_h = BORDER_W + BAR_H + inner_h + BORDER_W

    print(f"Frame: {frame_w}x{frame_h}")

    # 4. Build the frame content as a flat rectangle, then mask to rounded corners.
    #    Work in RGB on white — no alpha needed, no dirty-corner artifacts.
    content_img = Image.new("RGB", (frame_w, frame_h), (255, 255, 255))
    draw = ImageDraw.Draw(content_img)

    # Bar background
    bar_top = BORDER_W
    bar_bottom = BORDER_W + BAR_H - BORDER_W
    draw.rectangle(
        [BORDER_W, bar_top, frame_w - 1 - BORDER_W, bar_bottom],
        fill=BAR_BG,
    )

    # Bar border-bottom
    bar_border_y = BORDER_W + BAR_H - BORDER_W
    draw.rectangle(
        [BORDER_W, bar_border_y, frame_w - 1 - BORDER_W, bar_border_y + BORDER_W - 1],
        fill=BAR_BORDER,
    )

    # Body background
    body_top = BORDER_W + BAR_H
    draw.rectangle(
        [BORDER_W, body_top, frame_w - 1 - BORDER_W, frame_h - 1 - BORDER_W],
        fill=BODY_BG,
    )

    # 3 dots
    dot_y = BORDER_W + BAR_PAD_V + DOT_SIZE // 2
    dot_x_start = BORDER_W + BAR_PAD_H + DOT_SIZE // 2
    for i in range(3):
        cx = dot_x_start + i * (DOT_SIZE + DOT_GAP)
        r = DOT_SIZE // 2
        draw.ellipse([cx - r, dot_y - r, cx + r, dot_y + r], fill=DOT_COLOR)

    # 5. Paste the screenshot into the body area
    paste_x = BORDER_W + BODY_PAD
    paste_y = BORDER_W + BAR_H + BODY_PAD_TOP
    content_img.paste(img, (paste_x, paste_y))

    # 6. Draw the frame border as a rounded-rect outline
    draw.rounded_rectangle(
        [0, 0, frame_w - 1, frame_h - 1],
        radius=CORNER_R,
        outline=BORDER_COLOR,
        width=BORDER_W,
    )

    # 7. Mask to rounded corners on a white ground.
    #    Draw the mask at 4× and downscale for clean antialiasing.
    mask = rounded_rect_mask(frame_w, frame_h, CORNER_R)
    out = Image.new("RGB", (frame_w, frame_h), (255, 255, 255))
    out.paste(content_img, mask=mask)
    out.save(output_path, optimize=True)
    print(f"Saved: {output_path} ({out.width}x{out.height})")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input.png> [output.png]")
        sys.exit(1)

    input_path = sys.argv[1]
    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        base, ext = os.path.splitext(input_path)
        output_path = base + "-framed" + ext

    frame(input_path, output_path)


if __name__ == "__main__":
    main()
