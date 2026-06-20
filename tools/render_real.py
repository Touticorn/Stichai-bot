#!/usr/bin/env python3
"""render_real.py — render DST with REAL colors from .inf"""
import sys, re, os
import pyembroidery as pe
from PIL import Image, ImageDraw
from collections import Counter

def parse_inf_colors(inf_path):
    """Return list of (r,g,b) tuples indexed by thread number (0-based)."""
    if not os.path.exists(inf_path):
        return None
    text = open(inf_path, encoding="latin-1").read()
    # [threadN]\nColor=R,G,B
    threads = re.findall(r"\[thread(\d+)\][^\[]*?Color\s*=\s*([\d ,\.]+)", text, flags=re.DOTALL)
    if not threads:
        return None
    palette = [None] * (max(int(n) for n,_ in threads))
    for n, rgb in threads:
        try:
            parts = [int(float(x.strip())) for x in rgb.split(",") if x.strip()]
            r,g,b = parts[0], parts[1], parts[2]
            palette[int(n)-1] = (r,g,b)  # thread1 = index 0
        except (ValueError, IndexError):
            pass
    return [c if c else (180,180,180) for c in palette]

def render(inp, outp, ppmm=12.0, thread_mm=0.0, palette=None):
    patt = pe.read(inp)
    cmds = patt.stitches
    if not cmds:
        return

    stitch_pts = [(c[0], c[1]) for c in cmds if c[2] == pe.STITCH]
    xs, ys = zip(*stitch_pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    cx_st = (minx + maxx) / 2
    cy_st = (miny + maxy) / 2
    h_mm = (maxy - miny) / 10.0
    w_mm = (maxx - minx) / 10.0

    pad_mm = 2.0
    W = int((w_mm + 2 * pad_mm) * ppmm)
    H = int((h_mm + 2 * pad_mm) * ppmm)
    bg = (235, 230, 220)
    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)

    def P(x, y):
        return (int((x - cx_st) / 10.0 * ppmm + W / 2),
                int((y - cy_st) / 10.0 * ppmm + H / 2))

    row_pitch = 2.0
    thread_px = max(2, int(round((thread_mm or 0.4) * ppmm)))
    if palette is None:
        palette = [(40,40,40),(95,90,175),(180,220,240),(200,180,220),
                   (130,105,175),(80,60,160),(240,220,235),(50,40,110),(170,130,195)]

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

    fill_blocks, outline_blocks = [], []
    for ci_key, runs in runs_by_color.items():
        total = sum(len(r) for r in runs)
        is_outline = len(runs) <= 8 and total <= 1500
        (outline_blocks if is_outline else fill_blocks).append((ci_key, runs))

    # Render outlines AFTER fills so outline shows on top
    for ci_key, runs in fill_blocks:
        col = palette[ci_key % len(palette)]
        for run in runs:
            for i in range(1, len(run)):
                p1 = P(run[i-1][0], run[i-1][1])
                p2 = P(run[i][0], run[i][1])
                draw.line([p1,p2], fill=col, width=thread_px)
    for ci_key, runs in outline_blocks:
        col = palette[ci_key % len(palette)]
        for run in runs:
            for i in range(1, len(run)):
                p1 = P(run[i-1][0], run[i-1][1])
                p2 = P(run[i][0], run[i][1])
                draw.line([p1,p2], fill=col, width=max(2,int(thread_px*0.6)))

    img.save(outp)
    print(f"rendered {outp}  ({W}x{H}px, {ppmm}px/mm)  colors={len(runs_by_color)}  size={w_mm:.1f}x{h_mm:.1f}mm")

if __name__ == "__main__":
    inp = sys.argv[1]
    outp = sys.argv[2]
    ppmm = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
    # Auto-find .inf
    inf_guess = os.path.splitext(inp)[0] + ".inf"
    pal = parse_inf_colors(inf_guess)
    if pal:
        print(f"using real palette: {pal}")
    else:
        print(f"no .inf found, using hardcoded")
    render(inp, outp, ppmm, palette=pal)
