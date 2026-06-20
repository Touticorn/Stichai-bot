#!/usr/bin/env python3
"""render_viewer.py — render DST to match Embroidermodder Android viewer appearance"""
import sys, os, re
import pyembroidery as pe
from PIL import Image, ImageDraw

# Embroidermodder Android default block palette (approximate)
VIEWER_PALETTE = [
    (220,  60,  60),   # 0  red
    ( 60, 100, 220),   # 1  blue
    ( 60, 180,  80),   # 2  green
    (240, 220, 100),   # 3  yellow
    ( 40,  40,  40),   # 4  charcoal
    (160, 100,  60),   # 5  brown
    (220, 200, 220),   # 6  light grey
    (180,  60, 180),   # 7  purple
    (255, 140,  60),   # 8  orange
    (100, 200, 200),   # 9  teal
]

def render(inp, outp, ppmm=12.0, show_jumps=False):
    patt = pe.read(inp)
    cmds = patt.stitches
    if not cmds:
        return

    # Get stitch points for bounds
    stitch_pts = [(c[0], c[1]) for c in cmds if c[2] == pe.STITCH]
    if not stitch_pts:
        return
    xs, ys = zip(*stitch_pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)

    # Calculate dimensions
    w_mm = (maxx - minx) / 10.0
    h_mm = (maxy - miny) / 10.0
    pad_mm = 2.0
    W = int((w_mm + 2 * pad_mm) * ppmm)
    H = int((h_mm + 2 * pad_mm) * ppmm)

    # Light blue background like viewer
    bg = (214, 230, 245)
    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)

    def P(x, y):
        return (int((x - minx) / 10.0 * ppmm + pad_mm * ppmm),
                int((y - miny) / 10.0 * ppmm + pad_mm * ppmm))

    # Thread thickness (viewer uses ~0.4mm)
    thread_px = max(2, int(round(0.4 * ppmm)))

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
            if show_jumps and last is not None:
                # Draw jump as thin line
                a, b = P(*last), P(x, y)
                draw.line([a, b], fill=(200, 200, 200), width=1)
            last = (x, y)
            lastcmd = c
    flush()

    # Render all runs with thick antialiased lines
    for ci_key, runs in runs_by_color.items():
        col = VIEWER_PALETTE[ci_key % len(VIEWER_PALETTE)]
        for run in runs:
            for i in range(1, len(run)):
                p1 = P(run[i-1][0], run[i-1][1])
                p2 = P(run[i][0], run[i][1])
                draw.line([p1, p2], fill=col, width=thread_px)

    img.save(outp, quality=95)
    print(f"rendered {outp}  ({W}x{H}px, {ppmm}px/mm)  colors={len(runs_by_color)}  size={w_mm:.1f}x{h_mm:.1f}mm")

if __name__ == "__main__":
    inp = sys.argv[1]
    outp = sys.argv[2]
    ppmm = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
    show_jumps = len(sys.argv) > 4 and sys.argv[4] == "jumps"
    render(inp, outp, ppmm, show_jumps)
