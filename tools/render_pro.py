#!/usr/bin/env python3
"""
render_pro.py — render a DST like a pro embroidery viewer (solid satin look).

Strategy:
- pyembroidery parses the stitch list
- Detect dominant row-spacing from stitch-distance histogram.
  Use that as the visual fill-row width.
- Group consecutive stitches by color, split at trim/jump or color change.
- For each run: draw an overlapped stroke at row-matching thickness so
  neighboring parallel rows fuse into continuous fill (pro-viewer look).
- Default: thread = row_spacing * 1.4 (40% overlap for solid coverage).

Usage:
  python3 tools/render_pro.py IN.dst OUT.png [px_per_mm] [thread_mm]
"""
import sys
import os
import pyembroidery as pe
from PIL import Image, ImageDraw
from collections import Counter


def detect_row_spacing(stitches, bins_per_mm=4):
    """Median of short stitch distances = row-spacing in mm."""
    short = []
    for a, b in zip(stitches, stitches[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = (dx * dx + dy * dy) ** 0.5 / 10.0  # 0.1mm -> mm
        if 0.4 <= d <= 8.0:  # ignore trims (huge) and locks (tiny)
            short.append(round(d * bins_per_mm) / bins_per_mm)
    if not short:
        return 1.5  # fallback
    c = Counter(short)
    # Two most-common: usually 1.0mm satin + 4.0mm weft row
    top2 = sorted(c.items(), key=lambda x: -x[1])[:2]
    # If 4mm present (open weave / satin row pitch), prefer it
    for k, _ in top2:
        if abs(k - 4.0) < 0.6:
            return k
    return top2[0][0]


def render(inp, outp, ppmm=12.0, thread_mm=0.0):
    patt = pe.read(inp)
    cmds = patt.stitches
    if not cmds:
        print("No stitches found")
        return

    stitch_pts = [(c[0], c[1]) for c in cmds if c[2] == pe.STITCH]
    xs, ys = zip(*stitch_pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    h_mm = (maxy - miny) / 10.0
    w_mm = (maxx - minx) / 10.0

    pad_mm = 2.0
    W = int((w_mm + 2 * pad_mm) * ppmm)
    H = int((h_mm + 2 * pad_mm) * ppmm)
    bg = (235, 230, 220)  # fabric-tone background
    img = Image.new("RGB", (W, H), bg)

    def P(x, y):
        return (int((x / 10.0 + pad_mm) * ppmm),
                int((y / 10.0 + pad_mm) * ppmm))

    # Auto thread width: dominant row-spacing * 1.4 for solid coverage
    row_pitch = detect_row_spacing(stitch_pts)
    if thread_mm <= 0:
        thread_mm = row_pitch * 1.4
    thread_px = max(2, int(round(thread_mm * ppmm)))

    palette = [
        (40, 40, 40),     # dark
        (245, 245, 245),
        (200, 170, 60),
        (220, 100, 40),
        (180, 40, 50),
        (130, 30, 50),
        (240, 150, 180),
        (255, 230, 100),
        (160, 100, 60),
        (90, 80, 70),
        (90, 130, 80),
        (60, 150, 80),
        (30, 90, 60),
        (110, 170, 220),
        (140, 200, 230),
        (40, 80, 180),
        (40, 50, 110),
        (130, 80, 180),
        (180, 130, 200),
        (200, 190, 220),
        (180, 180, 190),
        (130, 130, 140),
        (80, 80, 90),
        (200, 180, 150),
        (230, 210, 180),
        (180, 140, 100),
        (255, 200, 100),
    ]

    ci = 0
    last = None
    lastcmd = None
    current_run = []
    runs_by_color = {}

    def flush():
        nonlocal current_run
        if current_run and len(current_run) >= 2:
            runs_by_color.setdefault(ci, []).append(current_run)
        current_run = []

    for x, y, c in cmds:
        if c == pe.COLOR_CHANGE:
            flush()
            ci += 1
            last = None
            lastcmd = c
            continue
        if c == pe.STITCH:
            if last is not None and lastcmd == pe.STITCH:
                current_run.append((x, y))
            elif last is not None and lastcmd in (pe.TRIM, pe.JUMP):
                flush()
                current_run = [(last[0], last[1]), (x, y)]
            else:
                current_run.append((x, y))
            last = (x, y)
            lastcmd = c
        elif c in (pe.TRIM, pe.JUMP):
            flush()
            last = (x, y)
            lastcmd = c

    flush()

    for ci, runs in runs_by_color.items():
        col_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(col_img)
        col = palette[ci % len(palette)]
        for run in runs:
            if len(run) < 2:
                continue
            pts = [P(x, y) for (x, y) in run]
            d.line(pts, fill=col + (255,), width=thread_px)
            r = thread_px // 2
            for px, py in pts:
                d.ellipse([px - r, py - r, px + r, py + r], fill=col + (255,))
        # Slight blur to mimic thread pile
        try:
            from PIL import ImageFilter
            col_img = col_img.filter(ImageFilter.GaussianBlur(radius=max(1, thread_px // 6)))
        except Exception:
            pass
        layers_append = img.convert("RGBA")
        layers_append.alpha_composite(col_img)
        img = layers_append.convert("RGB")

    img.save(outp)

    total_runs = sum(len(r) for r in runs_by_color.values())
    colors_used = len(runs_by_color)
    print(f"rendered {outp}  ({W}x{H}px, {ppmm}px/mm, "
          f"thread={thread_mm:.2f}mm={thread_px}px, row_pitch={row_pitch:.2f}mm)  "
          f"colors={colors_used}  runs={total_runs}  size={w_mm:.1f}x{h_mm:.1f}mm")


if __name__ == "__main__":
    inp = sys.argv[1]
    outp = sys.argv[2]
    if os.path.basename(outp) == outp:
        outp = os.path.join("/storage/emulated/0/Download/", outp)
    ppmm = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
    thread_mm = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0  # auto
    render(inp, outp, ppmm, thread_mm)
