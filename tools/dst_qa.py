#!/usr/bin/env python3
"""
dst_qa.py — independent DST quality harness for Stichai.

Decodes one or more .dst files with pyembroidery (NOT Stichai's own decoder,
so the engine can't grade its own homework) and reports the metrics that
actually separate good embroidery from pro: density, stitch-length
distribution, travel/jump/trim load, and long-stitch ("slash") risk.

Usage:
    python3 dst_qa.py FILE.dst [FILE2.dst ...]
    python3 dst_qa.py --benchmark pro.dst yours.dst   # side-by-side vs a reference

DST native unit = 0.1mm. pyembroidery yields coords in 0.1mm; we convert to mm.
"""
import sys, math, statistics, argparse
import pyembroidery as pe

# pyembroidery command codes
STITCH = pe.STITCH
JUMP   = pe.JUMP
TRIM   = pe.TRIM
COLOR  = pe.COLOR_CHANGE
STOP   = pe.STOP
END    = pe.END

SLASH_MM = 7.0   # a sewn stitch longer than this risks a visible "slash"/snag

def load(path):
    return pe.read(path)

def hull_area_mm2(pts):
    """Convex-hull area (mm^2) of the stitch points — tighter than bbox."""
    P = sorted(set(pts))
    if len(P) < 3:
        return 0.0
    def cross(o, a, b):
        return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lower = []
    for p in P:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(P):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    a = 0.0
    for i in range(len(hull)):
        x1, y1 = hull[i]
        x2, y2 = hull[(i+1) % len(hull)]
        a += x1*y2 - x2*y1
    return abs(a) / 2.0 / 100.0   # /100 -> 0.1mm^2 to mm^2

def analyze(path):
    patt = load(path)
    cmds = patt.stitches  # [x, y, command] in 0.1mm
    real_pts = []         # actual needle penetrations (STITCH)
    seg_len = []          # mm length of each real sewn stitch
    n_stitch = n_jump = n_trim = n_color = n_stop = 0
    last = None
    last_cmd = None
    travel_mm = 0.0
    sew_mm = 0.0
    long_runs = 0
    for x, y, c in cmds:
        if c == STITCH:
            n_stitch += 1
            real_pts.append((x, y))
            if last is not None and last_cmd == STITCH:
                d = math.hypot(x-last[0], y-last[1]) / 10.0
                seg_len.append(d)
                sew_mm += d
                if d > SLASH_MM:
                    long_runs += 1
        elif c == JUMP:
            n_jump += 1
            if last is not None:
                travel_mm += math.hypot(x-last[0], y-last[1]) / 10.0
        elif c == TRIM:
            n_trim += 1
        elif c == COLOR:
            n_color += 1
        elif c == STOP:
            n_stop += 1
        last = (x, y)
        last_cmd = c

    xs = [p[0] for p in real_pts]; ys = [p[1] for p in real_pts]
    if xs:
        w_mm = (max(xs)-min(xs))/10.0
        h_mm = (max(ys)-min(ys))/10.0
    else:
        w_mm = h_mm = 0.0
    bbox_area = max(w_mm*h_mm, 1e-9)
    hull_area = max(hull_area_mm2(real_pts), 1e-9)

    def pct(vals, p):
        if not vals: return 0.0
        vs = sorted(vals)
        k = max(0, min(len(vs)-1, int(round((p/100.0)*(len(vs)-1)))))
        return vs[k]

    return {
        "path": path,
        "stitches": n_stitch, "jumps": n_jump, "trims": n_trim,
        "colors": n_color + 1, "stops": n_stop,
        "w_mm": w_mm, "h_mm": h_mm,
        "bbox_area": bbox_area, "hull_area": hull_area,
        "density_bbox": n_stitch / bbox_area,
        "density_hull": n_stitch / hull_area,
        "len_min": min(seg_len) if seg_len else 0,
        "len_p5":  pct(seg_len, 5),
        "len_p50": statistics.median(seg_len) if seg_len else 0,
        "len_mean": statistics.mean(seg_len) if seg_len else 0,
        "len_p95": pct(seg_len, 95),
        "len_max": max(seg_len) if seg_len else 0,
        "sew_mm": sew_mm, "travel_mm": travel_mm,
        "travel_pct": 100.0*travel_mm/max(sew_mm+travel_mm, 1e-9),
        "long_runs": long_runs,
        "jump_pct": 100.0*n_jump/max(n_stitch+n_jump, 1),
    }

def fmt_row(label, *vals):
    return "  " + label.ljust(24) + "".join(str(v).rjust(16) for v in vals)

def report(results, bench_idx=None):
    cols = [r["path"].split("/")[-1] for r in results]
    print("="*( 24 + 16*len(results) + 2))
    print(fmt_row("METRIC", *cols))
    print("-"*( 24 + 16*len(results) + 2))
    def row(label, key, f="{:.2f}"):
        print(fmt_row(label, *[f.format(r[key]) if isinstance(r[key],float) else r[key] for r in results]))
    row("stitches", "stitches")
    row("jumps", "jumps");  row("trims", "trims");  row("colors", "colors")
    row("width mm", "w_mm"); row("height mm", "h_mm")
    row("hull area mm^2", "hull_area")
    print("-"*( 24 + 16*len(results) + 2))
    row("DENSITY st/mm^2 (hull)", "density_hull")
    row("density st/mm^2 (bbox)", "density_bbox")
    print("-"*( 24 + 16*len(results) + 2))
    row("len min mm", "len_min");  row("len p5 mm", "len_p5")
    row("len median mm", "len_p50"); row("len mean mm", "len_mean")
    row("len p95 mm", "len_p95");  row("len MAX mm", "len_max")
    print("-"*( 24 + 16*len(results) + 2))
    row("sew length mm", "sew_mm"); row("travel length mm", "travel_mm")
    row("travel %", "travel_pct"); row("jump %", "jump_pct")
    row("long runs >7mm", "long_runs")
    print("="*( 24 + 16*len(results) + 2))
    if bench_idx is not None and len(results) >= 2:
        b = results[bench_idx]
        print(f"\nvs benchmark [{cols[bench_idx]}]:")
        for i, r in enumerate(results):
            if i == bench_idx: continue
            dd = r["density_hull"]/max(b["density_hull"],1e-9)
            print(f"  {cols[i]}: density {dd*100:5.0f}% of pro "
                  f"({r['density_hull']:.2f} vs {b['density_hull']:.2f} st/mm^2)  | "
                  f"max-stitch {r['len_max']:.1f}mm vs {b['len_max']:.1f}mm | "
                  f"long-runs {r['long_runs']} vs {b['long_runs']}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--benchmark", help="reference DST to compare against")
    a = ap.parse_args()
    files = list(a.files)
    bench_idx = None
    if a.benchmark:
        files = [a.benchmark] + files
        bench_idx = 0
    results = []
    for f in files:
        try:
            results.append(analyze(f))
        except Exception as e:
            print(f"!! {f}: {e}", file=sys.stderr)
    if results:
        report(results, bench_idx)

if __name__ == "__main__":
    main()
