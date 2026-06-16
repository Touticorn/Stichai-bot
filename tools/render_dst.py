#!/usr/bin/env python3
"""
render_dst.py — render a DST with thread-accurate or viewer-matching colors.

Modes:
  thread   — thick lines, fabric-coverage check
  wire     — 1px wireframe
  viewer   — thin lines, neutral bg (generic)
  inf      — real thread colors from .inf file (if present)
  embmod   — match Embroidermodder Android default palette (best-effort)

Usage: python3 render_dst.py IN.dst OUT.png [scale_px_per_mm] [mode] [show_travels]
"""
import sys, os, re
import pyembroidery as pe
from PIL import Image, ImageDraw

# ── Palettes ──────────────────────────────────────────────────────────

# Actual digitizer colors from INF file (override with real thread data)
# Read dynamically from companion .inf

# Embroidermodder-style viewer palette: high-contrast block identifiers.
# These are NOT real thread colors — just visually distinct so you can
# tell blocks apart when comparing before/after code changes.
EMBMOD_PALETTE = [
    (220,  60,  60),   # 0  red           — Block 0
    ( 60, 100, 220),   # 1  blue          — Block 1
    ( 60, 180,  80),   # 2  bright green  — Block 2
    (240, 220, 100),   # 3  yellow        — Block 3
    ( 40,  40,  40),   # 4  charcoal      — Block 4
    (160, 100,  60),   # 5  brown         — Block 5
    (220, 200, 220),   # 6  light grey    — Block 6
    (180,  60, 180),   # 7  purple        — Block 7
]

# Generic fallback palette (when nothing else available)
FALLBACK_PALETTE = [
    (0,0,0), (255,255,255), (180,30,30), (220,150,0), (220,200,0),
    (20,160,60), (30,120,220), (150,40,200), (180,100,40), (220,180,140),
    (230,90,160), (120,90,40), (90,90,90), (0,170,170), (180,180,0),
    (200,120,80),
]

# ── Helpers ───────────────────────────────────────────────────────────

def parse_inf(inf_path):
    """Parse .inf file for thread colors and names."""
    if not os.path.exists(inf_path):
        return []
    colors = []
    with open(inf_path) as f:
        text = f.read()
    for m in re.finditer(r'Color=(\d+),(\d+),(\d+)', text):
        colors.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    if not colors:
        for m in re.finditer(r'Hex=#([0-9A-Fa-f]{6})', text):
            h = m.group(1)
            colors.append((int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)))
    return colors


def render(inp, outp, ppmm=8.0, mode="thread", show_travels=True):
    patt = pe.read(inp)
    cmds = patt.stitches

    stitch_pts = [(c[0], c[1]) for c in cmds if c[2] == pe.STITCH]
    if not stitch_pts:
        print("No stitches found")
        return
    xs, ys = zip(*stitch_pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)

    sc = ppmm / 10.0
    W, H = int((maxx - minx) * sc) + 40, int((maxy - miny) * sc) + 40

    bg = (214, 230, 245) if mode in ("viewer", "inf", "embmod") else (244, 242, 238)
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    def P(x, y):
        return (int((x - minx) * sc) + 20, int((y - miny) * sc) + 20)

    thread = (max(1, round(0.10 * ppmm)) if mode in ("viewer", "inf", "embmod")
              else max(1, round(0.35 * ppmm)) if mode == "thread"
              else 1)

    inf_colors = parse_inf(os.path.splitext(inp)[0] + ".inf")
    if mode == "embmod":
        palette, label = EMBMOD_PALETTE, "EMBMOD"
    elif mode == "inf" and inf_colors:
        palette, label = inf_colors, "INF"
    elif inf_colors:
        palette, label = inf_colors, "INF"
    else:
        palette, label = FALLBACK_PALETTE, "FALLBACK"

    ci, last, lastcmd = 0, None, None
    travels, stitch_count = 0, 0

    for x, y, c in cmds:
        if c == pe.COLOR_CHANGE:
            ci += 1; last = None; lastcmd = c; continue

        if c == pe.STITCH:
            stitch_count += 1
            if last is not None and lastcmd == pe.STITCH:
                col = palette[ci % len(palette)]
                a, b = P(*last), P(x, y)
                d.line([a, b], fill=col, width=thread)
                if mode == "thread" and thread >= 3:
                    r = thread // 2
                    for px, py in (a, b):
                        d.ellipse([px - r, py - r, px + r, py + r], fill=col)
            last = (x, y); lastcmd = c

        elif c in (pe.JUMP, pe.TRIM):
            if last is not None and show_travels and mode not in ("viewer", "inf", "embmod"):
                d.line([P(*last), P(x, y)], fill=(230, 0, 0), width=1)
                travels += 1
            last = (x, y); lastcmd = c
        else:
            last = (x, y); lastcmd = c

    img.save(outp)
    print(f"rendered {outp}  ({W}x{H}px, {ppmm}px/mm, mode={mode}/{label}, "
          f"thread={thread}px)  blocks={ci+1}  stitches={stitch_count}  travels={travels}")


if __name__ == "__main__":
    inp = sys.argv[1]
    outp = sys.argv[2]
    if os.path.basename(outp) == outp:
        outp = os.path.join("/storage/emulated/0/Download/", outp)
    ppmm = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
    mode = sys.argv[4] if len(sys.argv) > 4 else "thread"
    show_travels = (sys.argv[5] != "0") if len(sys.argv) > 5 else True
    render(inp, outp, ppmm, mode, show_travels)
