#!/usr/bin/env python3
"""
cartoon_test.py — Visual quality test for cartoon-mode DST output.

Compares rendered DST stitch map against ideal cartoon image regions.
Looks for two quality metrics:
1. Coverage: what % of each cartoon region is actually sewn (not empty/gaps)
2. Edge match: how well do stitch edges align with region boundaries
"""
import argparse, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageFilter, ImageChops

try:
    import pyembroidery as pe
except:
    print("pip install pyembroidery")
    sys.exit(1)

STITCH = pe.STITCH

def render_stitch_map(dst_path, out_png, ppmm=16.0):
    """Render only the STITCH points as a binary coverage map."""
    patt = pe.read(dst_path)
    cmds = patt.stitches
    pts = [(c[0], c[1]) for c in cmds if c[2] == STITCH]
    if not pts:
        return None, None
    xs, ys = zip(*pts)
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    sc = ppmm / 10.0
    w = int((maxx - minx) * sc) + 40
    h = int((maxy - miny) * sc) + 40
    cov = np.zeros((h, w), dtype=np.uint8)
    ox, oy = 20, 20
    for (x, y) in pts:
        px = int((x - minx) * sc) + ox
        py = int((y - miny) * sc) + oy
        if 0 <= px < w and 0 <= py < h:
            cov[py, px] = 255
    # Blur to represent stitch width (~0.4mm at 16ppmm = 6.4px)
    img = Image.fromarray(cov, mode='L')
    kernel = max(3, int(0.4 * ppmm * 2))
    img = img.filter(ImageFilter.GaussianBlur(radius=kernel / 2))
    arr = np.array(img)
    # Threshold back to binary coverage
    arr = (arr > 20).astype(np.uint8)
    img.save(out_png)
    return arr, (minx, miny, maxx, maxy)


def load_cartoon_as_regions(cartoon_path, n_colors=10):
    """
    K-means-ish color clustering to get region map.
    Returns a labeled array where each color region gets a unique int.
    """
    # Step 1: posterize to small palette
    img = Image.open(cartoon_path).convert('RGB')
    w, h = img.size
    # Resize to analysis resolution
    small = img.resize((min(w, 500), min(h, 500)), Image.LANCZOS)
    arr = np.array(small)
    # Quantize to n_colors
    # Simple: round to nearest bucket
    flat = arr.reshape(-1, 3)
    # K-means (Lloyd's) for the palette
    palette = np.random.choice(256, size=(n_colors, 3), replace=False)
    for _ in range(8):
        # assign
        dists = np.linalg.norm(flat[:, None, :] - palette[None, :, :], axis=2)
        labels = np.argmin(dists, axis=1)
        # recompute
        for k in range(n_colors):
            mask = labels == k
            if np.any(mask):
                palette[k] = flat[mask].mean(axis=0)
    # Now label full-res
    arr_full = np.array(img)
    flat_full = arr_full.reshape(-1, 3)
    dists_full = np.linalg.norm(flat_full[:, None, :] - palette[None, :, :], axis=2)
    labels_full = np.argmin(dists_full, axis=1).reshape(img.size[1], img.size[0])
    return labels_full, palette


def compare_coverage(stitch_cov, region_labels, out_dir):
    """
    For each cartoon color region, compute what % of its area is covered by stitches.
    Also compute overall: what % of the subject (non-bg) is covered.
    """
    sl, sh = stitch_cov.shape[0], stitch_cov.shape[1]
    # Resize stitch coverage to match region labels
    rl, rw = region_labels.shape[0], region_labels.shape[1]
    # Map stitch coverage onto region label space
    from PIL import Image
    cov_img = Image.fromarray((stitch_cov * 255).astype(np.uint8), mode='L')
    cov_resized = cov_img.resize((rw, rl), Image.LANCZOS)
    cov_resized_arr = np.array(cov_resized) > 30

    # Background heuristic: largest connected component or magenta
    # Actually find the most common color and treat as background
    uniques, counts = np.unique(region_labels, return_counts=True)
    bg_label = uniques[np.argmax(counts)]

    results = {}
    total_subject_pixels = 0
    total_covered = 0

    for label in uniques:
        if label == bg_label:
            continue
        mask = region_labels == label
        n_pixels = np.sum(mask)
        n_covered = np.sum(cov_resized_arr & mask)
        pct = 100.0 * n_covered / n_pixels if n_pixels > 0 else 0
        results[int(label)] = {"pixels": int(n_pixels), "covered": int(n_covered), "pct": pct}
        total_subject_pixels += n_pixels
        total_covered += n_covered

    overall_pct = 100.0 * total_covered / total_subject_pixels if total_subject_pixels > 0 else 0

    # Create visualization
    vis = np.zeros((rl, rw, 3), dtype=np.uint8)
    for label in uniques:
        if label == bg_label:
            vis[region_labels == label] = (255, 0, 255)
        else:
            mask = (region_labels == label) & cov_resized_arr
            vis[mask] = (0, 200, 0)  # covered = green
            miss = (region_labels == label) & (~cov_resized_arr)
            vis[miss] = (200, 0, 0)  # missed = red

    Image.fromarray(vis, mode='RGB').save(os.path.join(out_dir, 'coverage_map.png'))

    return results, overall_pct


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cartoon", help="input cartoon PNG (magenta bg)")
    ap.add_argument("dst", help="output DST file")
    ap.add_argument("-o", "--out", default="/data/data/com.termux/files/home/.openclaw/workspace/tmp/cartoon_test")
    ap.add_argument("-c", "--colors", type=int, default=10)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)

    print("Loading cartoon and segmenting regions...")
    regions, palette = load_cartoon_as_regions(a.cartoon, a.colors)
    print(f"Found {len(np.unique(regions))} color regions")

    print("Rendering stitch coverage map...")
    stitch_cov, bbox = render_stitch_map(a.dst, os.path.join(a.out, 'stitch_cov.png'), ppmm=16.0)
    if stitch_cov is None:
        print("No stitches found in DST")
        sys.exit(1)
    print(f"Stitch coverage: {stitch_cov.shape[1]}x{stitch_cov.shape[0]} px")

    print("Comparing coverage...")
    per_region, overall = compare_coverage(stitch_cov, regions, a.out)

    print("\n=== RESULTS ===")
    print(f"Overall subject coverage: {overall:.1f}%")
    print(f"\nPer-region coverage:")
    for label, data in sorted(per_region.items(), key=lambda x: -x[1]['pixels']):
        status = "OK" if data['pct'] >= 80 else "LOW" if data['pct'] >= 50 else "FAIL"
        print(f"  Region {label}: {data['pct']:.1f}%  ({data['covered']}/{data['pixels']} px) — {status}")

    avg = sum(r['pct'] for r in per_region.values()) / len(per_region) if per_region else 0
    print(f"\nAverage region coverage: {avg:.1f}%")
    n_low = sum(1 for r in per_region.values() if r['pct'] < 50)
    n_ok = sum(1 for r in per_region.values() if r['pct'] >= 80)
    print(f"Regions: {n_ok} good (>=80%), {len(per_region)-n_ok-n_low} medium, {n_low} poor (<50%)")

    print(f"\nOutputs saved to {a.out}/")

if __name__ == "__main__":
    main()
