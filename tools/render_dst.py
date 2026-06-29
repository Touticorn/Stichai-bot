#!/usr/bin/env python3
"""
render_dst.py — FAITHFUL embroidery viewer. Shows a DST the way Embroidery
Viewer Pro (EVP) does, so the render is a trustworthy reference: if it looks
messy, the file IS messy. No cosmetic smoothing, no hidden jumps.

Why the old render lied: it drew stitches ~3px thick with bead dots, which
smears a sparse/chaotic fill into a solid clean shape, and it hid jumps in the
comparison modes. This version draws every stitch as a hairline and every
travel (jump/trim) as a thin line on top — exactly what makes EVP honest.

Modes:
  evp     (default) — faithful EVP-style: thin threads, distinct block colors,
                      visible travels, light-blue canvas. USE THIS FOR TESTS.
  thread            — legacy thick cosmetic render (flattering; do NOT trust).
  wire              — 1px monochrome wireframe.

Usage: python3 render_dst.py IN.dst OUT.png [ppmm] [mode] [show_travels]
"""
import sys, os, re, colorsys
from PIL import Image, ImageDraw

# Command constants (mapped from pyembroidery in the loader; kept as plain ints
# so the drawing code is testable without pyembroidery).
STITCH, JUMP, TRIM, COLOR_CHANGE = 0, 1, 2, 3

# ── Palette: distinct saturated hues per block, EVP-like separability ──────
def build_palette(n):
    base = [
        (60, 150, 70), (110, 70, 165), (180, 175, 60), (200, 70, 70),
        (60, 110, 200), (200, 120, 50), (40, 160, 160), (190, 80, 170),
        (120, 95, 60), (90, 90, 95),
    ]
    if n <= len(base):
        return base
    out = list(base)
    for i in range(len(base), n):
        h = (i * 0.61803398875) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 0.62, 0.74)
        out.append((int(r*255), int(g*255), int(b*255)))
    return out

def parse_inf(inf_path):
    if not os.path.exists(inf_path):
        return []
    colors = []
    text = open(inf_path).read()
    for m in re.finditer(r'Color=(\d+),(\d+),(\d+)', text):
        colors.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    if not colors:
        for m in re.finditer(r'Hex=#([0-9A-Fa-f]{6})', text):
            h = m.group(1)
            colors.append((int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)))
    return colors

# ── Loader: pyembroidery → normalized records ─────────────────────────────
def load_records(path):
    import pyembroidery as pe
    patt = pe.read(path)
    cmap = {pe.STITCH: STITCH, pe.JUMP: JUMP, pe.TRIM: TRIM,
            pe.COLOR_CHANGE: COLOR_CHANGE}
    recs = []
    for x, y, c in patt.stitches:
        recs.append((x, y, cmap.get(c, None)))
    return recs

# ── Faithful renderer ──────────────────────────────────────────────────────
def render(records, outp, ppmm=8.0, mode="evp", show_travels=True, inf_colors=None):
    pts = [(x, y) for x, y, c in records if c == STITCH]
    if not pts:
        print("No stitches found"); return
    xs, ys = zip(*pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    sc = ppmm / 10.0

    if mode == "thread":            # legacy thick cosmetic render (do not trust)
        SS = 1
        bg = (244, 242, 238)
        stitch_w = max(1, round(0.35 * ppmm))
        travel_w = 1
    elif mode == "wire":            # 1px monochrome wireframe
        SS = 1
        bg = (255, 255, 255)
        stitch_w = 1
        travel_w = 1
    elif mode == "evp_dense":       # EVP style with realistic thread thickness
        SS = 3
        bg = (214, 230, 245)
        stitch_w = max(SS, round(0.4 * ppmm) * SS)  # ~0.4mm thread width (denser)
        travel_w = SS
    else:                           # evp + any legacy name (inf/viewer/embmod) → faithful
        mode = "evp"
        SS = 3                      # supersample → smooth hairline threads
        bg = (214, 230, 245)        # EVP light-blue canvas
        stitch_w = SS               # 1px effective thread
        travel_w = SS

    pad = 20
    W = int((maxx - minx) * sc) + pad * 2
    H = int((maxy - miny) * sc) + pad * 2
    img = Image.new("RGB", (W * SS, H * SS), bg)
    d = ImageDraw.Draw(img)

    def P(x, y):
        return (int(((x - minx) * sc + pad) * SS),
                int(((y - miny) * sc + pad) * SS))

    n_blocks = sum(1 for _, _, c in records if c == COLOR_CHANGE) + 1
    palette = (inf_colors if (mode == "evp" and inf_colors)
               else build_palette(max(n_blocks, 10)))

    # Pass 1: stitches (thin, per-block color). Pass 2: travels on top.
    ci, last, lastcmd = 0, None, None
    travel_segs, nstitch, ntravel = [], 0, 0
    for x, y, c in records:
        if c == COLOR_CHANGE:
            ci += 1; last = None; lastcmd = c; continue
        if c == STITCH:
            nstitch += 1
            if last is not None and lastcmd == STITCH:
                d.line([P(*last), P(x, y)], fill=palette[ci % len(palette)],
                       width=stitch_w)
            last = (x, y); lastcmd = c
        elif c in (JUMP, TRIM):
            if last is not None and show_travels:
                travel_segs.append((P(*last), P(x, y), c))
                ntravel += 1
            last = (x, y); lastcmd = c
        else:
            last = (x, y); lastcmd = c

    # Travels drawn on TOP — thin, faithful. Jumps slate, trims slightly redder
    # so a trim-heavy file reads as busy exactly like it does in EVP.
    for a, b, c in travel_segs:
        col = (70, 90, 150) if c == JUMP else (150, 70, 90)
        d.line([a, b], fill=col, width=travel_w)

    if SS > 1:
        img = img.resize((W, H), Image.LANCZOS)
    img.save(outp)
    print(f"rendered {outp}  ({W}x{H}px @ {ppmm}px/mm, mode={mode})  "
          f"blocks={n_blocks}  stitches={nstitch}  travels={ntravel}")

if __name__ == "__main__":
    inp, outp = sys.argv[1], sys.argv[2]
    if os.path.basename(outp) == outp:
        outp = os.path.join("/storage/emulated/0/Download/", outp)
    ppmm = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
    mode = sys.argv[4] if len(sys.argv) > 4 else "evp"
    show_travels = (sys.argv[5] != "0") if len(sys.argv) > 5 else True
    inf = parse_inf(os.path.splitext(inp)[0] + ".inf")
    render(load_records(inp), outp, ppmm, mode, show_travels, inf)
