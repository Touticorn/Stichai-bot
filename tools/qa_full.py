#!/usr/bin/env python3
"""
qa_full.py — comprehensive DST quality harness for the Stichai engine.

Pure geometry analysis from a DST, no renderer, no color images needed.

Reports:
  * Overall geometry (bbox, hull, density)
  * Stitch-length distribution (min/p5/median/mean/p95/max, CV, >7mm count)
  * Travel / Trim / Jump breakdown
  * **Per-color breakdown**: stitches/region, density, trim count, max stitch len
  * Region count inferred from per-color stitch runs COLOR_CHANGE split

Usage:
    python3 tools/qa_full.py FILE.dst [--json out.json]
"""
import sys, math, statistics, json, argparse
import pyembroidery as pe
from collections import defaultdict, Counter

STITCH = pe.STITCH; JUMP = pe.JUMP; TRIM = pe.TRIM
COLOR  = pe.COLOR_CHANGE

SLASH_MM = 7.0
GOOD_DENSITY_MIN = 2.0
GOOD_DENSITY_MAX = 2.7
GOOD_TRAVEL_MAX = 10.0

def analyze(path):
    p = pe.read(path)
    cmds = p.stitches
    real_pts = []
    seg_len_all = []
    # per-color bookkeeping
    seg_len_by_color = defaultdict(list)
    real_pts_by_color = defaultdict(list)
    trim_by_color = defaultdict(int)
    jump_by_color = defaultdict(int)

    n_stitch = n_jump = n_trim = n_color_change = 0
    sew_mm = 0.0; travel_mm = 0.0
    long_runs_total = 0
    long_runs_by_color = defaultdict(int)
    cur_color = 1
    last = None; last_cmd = None
    for x, y, c in cmds:
        if c == STITCH:
            n_stitch += 1
            real_pts.append((x, y))
            real_pts_by_color[cur_color].append((x, y))
            if last is not None and last_cmd == STITCH:
                d = math.hypot(x-last[0], y-last[1]) / 10.0
                seg_len_all.append(d)
                seg_len_by_color[cur_color].append(d)
                sew_mm += d
                if d > SLASH_MM:
                    long_runs_total += 1
                    long_runs_by_color[cur_color] += 1
            last = (x, y); last_cmd = STITCH
        elif c == JUMP:
            n_jump += 1; jump_by_color[cur_color] += 1
            if last is not None:
                travel_mm += math.hypot(x-last[0], y-last[1]) / 10.0
            last = (x, y); last_cmd = JUMP
        elif c == TRIM:
            n_trim += 1; trim_by_color[cur_color] += 1
            last = (x, y); last_cmd = TRIM
        elif c == COLOR:
            n_color_change += 1
            cur_color += 1  # assuming sequential palette indexing
            last = (x, y); last_cmd = COLOR
        else:
            last = (x, y); last_cmd = c

    xs = [p[0] for p in real_pts]; ys = [p[1] for p in real_pts]
    w_mm = (max(xs)-min(xs))/10.0 if xs else 0.0
    h_mm = (max(ys)-min(ys))/10.0 if ys else 0.0
    bbox_area = max(w_mm*h_mm, 1e-9)
    hull = convex_hull_area_mm2(real_pts)
    hull_area = max(hull, 1e-9)

    cv = (statistics.pstdev(seg_len_all) / statistics.mean(seg_len_all)) if seg_len_all else 0.0

    # per-color summaries
    per_color = {}
    for ci, pts in real_pts_by_color.items():
        n_st = len(pts)
        if n_st < 2:
            per_color[ci] = {"stitches": n_st, "trim": trim_by_color[ci], "jump": jump_by_color[ci],
                              "len_max": 0.0, "len_mean": 0.0, "hull_mm2": 0.0,
                              "density_hull": 0.0, "long_runs": long_runs_by_color[ci]}
            continue
        lx = [q[0] for q in pts]; ly = [q[1] for q in pts]
        cw = (max(lx)-min(lx))/10.0; ch = (max(ly)-min(ly))/10.0
        ch_area = convex_hull_area_mm2(pts)
        lens = seg_len_by_color[ci]
        per_color[ci] = {
            "stitches": n_st,
            "trim": trim_by_color[ci],
            "jump": jump_by_color[ci],
            "w_mm": cw, "h_mm": ch,
            "bbox_area": max(cw*ch, 1e-9),
            "hull_mm2": max(ch_area, 1e-9),
            "density_hull": n_st / max(ch_area, 1e-9),
            "len_mean": statistics.mean(lens) if lens else 0.0,
            "len_max": max(lens) if lens else 0.0,
            "long_runs": long_runs_by_color[ci],
        }

    return {
        "path": path,
        "stitches": n_stitch,
        "jumps": n_jump,
        "trims": n_trim,
        "color_changes": n_color_change,
        "n_colors": n_color_change + 1,
        "w_mm": w_mm, "h_mm": h_mm,
        "bbox_area": bbox_area,
        "hull_area": hull_area,
        "density_bbox": n_stitch / bbox_area,
        "density_hull": n_stitch / hull_area,
        "len_min": min(seg_len_all) if seg_len_all else 0.0,
        "len_p5":  pct(seg_len_all, 5),
        "len_p50": statistics.median(seg_len_all) if seg_len_all else 0.0,
        "len_mean": statistics.mean(seg_len_all) if seg_len_all else 0.0,
        "len_p95": pct(seg_len_all, 95),
        "len_max": max(seg_len_all) if seg_len_all else 0.0,
        "len_cv": cv,
        "sew_mm": sew_mm, "travel_mm": travel_mm,
        "travel_pct": 100.0 * travel_mm / max(sew_mm + travel_mm, 1e-9),
        "long_runs": long_runs_total,
        "jump_pct": 100.0 * n_jump / max(n_stitch + n_jump, 1),
        "per_color": per_color,
    }

def convex_hull_area_mm2(pts):
    P = sorted(set(pts))
    if len(P) < 3: return 0.0
    def cross(o, a, b): return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lo = []
    for p in P:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    up = []
    for p in reversed(P):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    hull = lo[:-1] + up[:-1]
    a = 0.0
    for i in range(len(hull)):
        x1, y1 = hull[i]; x2, y2 = hull[(i+1) % len(hull)]
        a += x1*y2 - x2*y1
    return abs(a) / 2.0 / 100.0

def pct(vals, p):
    if not vals: return 0.0
    vs = sorted(vals)
    k = max(0, min(len(vs)-1, int(round((p/100.0)*(len(vs)-1)))))
    return vs[k]

def report(r):
    print(f"\n== {r['path']}")
    print(f"  stitches={r['stitches']:>6}  jumps={r['jumps']:>4}  trims={r['trims']:>4}  "
          f"colors={r['n_colors']:>3}  w×h={r['w_mm']:.1f}×{r['h_mm']:.1f}mm  "
          f"hull={r['hull_area']:.0f}mm²")
    print(f"  density_bbox={r['density_bbox']:.2f}  density_hull={r['density_hull']:.2f}  "
          f"travel_pct={r['travel_pct']:.1f}%  jump_pct={r['jump_pct']:.1f}%  "
          f"long_runs={r['long_runs']}  len_max={r['len_max']:.2f}mm  cv={r['len_cv']:.2f}")
    print(f"  per-color:")
    print(f"    {'ci':>3} {'stitches':>8} {'trims':>6} {'jumps':>6} "
          f"{'w_mm':>5} {'h_mm':>5} {'hull_mm2':>9} {'density':>8} "
          f"{'mean_mm':>7} {'max_mm':>7} {'long':>4}")
    for ci in sorted(r["per_color"]):
        d = r["per_color"][ci]
        print(f"    {ci:>3} {d['stitches']:>8} {d['trim']:>6} {d['jump']:>6} "
              f"{d.get('w_mm',0):>5.1f} {d.get('h_mm',0):>5.1f} {d['hull_mm2']:>9.1f} "
              f"{d['density_hull']:>8.2f} {d['len_mean']:>7.2f} {d['len_max']:>7.2f} "
              f"{d['long_runs']:>4}")

    flags = []
    if r["density_hull"] < GOOD_DENSITY_MIN: flags.append(f"DENSITY-LOW({r['density_hull']:.2f})")
    if r["density_hull"] > GOOD_DENSITY_MAX: flags.append(f"DENSITY-HIGH({r['density_hull']:.2f})")
    if r["travel_pct"] > GOOD_TRAVEL_MAX:    flags.append(f"TRAVEL-HIGH({r['travel_pct']:.1f}%)")
    if r["long_runs"] > 50:                  flags.append(f"LONG-RUNS({r['long_runs']})")
    if r["len_max"]  > 10.0:                 flags.append(f"MAX-STITCH({r['len_max']:.2f}mm)")
    if r["n_colors"] < 5:                    flags.append(f"COLORS-FEW({r['n_colors']})")
    if r["n_colors"] > 20:                   flags.append(f"COLORS-MANY({r['n_colors']})")
    if flags:
        print(f"  ⚠ flags: {', '.join(flags)}")
    else:
        print(f"  ✓ all checks pass")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    out = []
    for f in a.files:
        try:
            r = analyze(f); out.append(r); report(r)
        except Exception as e:
            print(f"!! {f}: {e}", file=sys.stderr)
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(out, fh, indent=2)
        print(f"# wrote JSON: {a.json}")

if __name__ == "__main__":
    main()
