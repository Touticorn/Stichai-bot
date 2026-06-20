#!/usr/bin/env python3
"""
render_score.py — score a rendered embroidery PNG for visual quality (no scipy)

Metrics:
- vertical_bar: detects high-contrast vertical line on right edge (0=good, 1=bad)
- fragmentation: counts small isolated regions via PIL flood fill (lower=better)
- halo_strands: detects thin pixels via erosion (lower=better)
- color_count: deviation from expected number of colors (lower=better)
- edge_density: ratio of edge pixels to total (lower=better)

Usage: python3 tools/render_score.py RENDER.png [--target N_COLORS]
"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter

def score_vertical_bar(img_array, right_margin_pct=0.05):
    """Detect high-contrast vertical line on right edge."""
    h, w, _ = img_array.shape
    margin_w = max(1, int(w * right_margin_pct))
    right_strip = img_array[:, w-margin_w:w, :]
    gray = np.mean(right_strip, axis=2)
    if gray.shape[1] < 2:
        return 0.0
    grad_x = np.abs(np.diff(gray, axis=1))
    max_grad = np.max(grad_x)
    mean_grad = np.mean(grad_x)
    if mean_grad > 0:
        bar_score = min(1.0, max_grad / (mean_grad * 10 + 1))
    else:
        bar_score = 0.0
    return bar_score

def _label_regions(mask):
    """Connected-component labeling on boolean mask using BFS (4-connected)."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    label_id = 0
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or labels[y, x]:
                continue
            label_id += 1
            stack = [(y, x)]
            labels[y, x] = label_id
            while stack:
                cy, cx = stack.pop()
                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                    ny, nx = cy+dy, cx+dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = label_id
                        stack.append((ny, nx))
    return labels, label_id

def score_fragmentation(img_array, min_region_size=100):
    """Count small isolated non-background regions."""
    gray = np.mean(img_array, axis=2)
    bg_color = np.median(gray)
    mask = np.abs(gray - bg_color) > 30
    labels, num_features = _label_regions(mask)
    small_count = 0
    for i in range(1, num_features + 1):
        if np.sum(labels == i) < min_region_size:
            small_count += 1
    total_pixels = img_array.shape[0] * img_array.shape[1]
    frag_score = small_count / max(1, total_pixels / 10000)
    return min(1.0, frag_score / 10)

def _erode_bool(mask):
    """Binary erosion by 1 pixel (4-connected)."""
    h, w = mask.shape
    out = np.zeros_like(mask)
    for y in range(1, h-1):
        for x in range(1, w-1):
            if mask[y, x] and mask[y-1, x] and mask[y+1, x] and mask[y, x-1] and mask[y, x+1]:
                out[y, x] = True
    return out

def score_halo_strands(img_array):
    """Detect thin pixels extending from main shape."""
    gray = np.mean(img_array, axis=2)
    bg_color = np.median(gray)
    mask = np.abs(gray - bg_color) > 30
    eroded = _erode_bool(mask)
    strands = mask & ~eroded
    total_pixels = np.sum(mask)
    if total_pixels > 0:
        strand_ratio = np.sum(strands) / total_pixels
    else:
        strand_ratio = 0.0
    return min(1.0, strand_ratio * 5)

def score_color_count(img_array, target_colors):
    """Compare dominant non-background colors to expected count."""
    pixels = img_array.reshape(-1, 3)
    bg_color = np.median(pixels, axis=0)
    fg_mask = np.linalg.norm(pixels - bg_color, axis=1) > 30
    fg_pixels = pixels[fg_mask]
    if len(fg_pixels) == 0:
        return 0.0
    quantized = (fg_pixels // 32) * 32
    unique_colors = len(np.unique(quantized, axis=0))
    color_diff = abs(unique_colors - target_colors)
    return min(1.0, color_diff / max(1, target_colors))

def score_edge_density(img_array):
    """Sobel edge detection (numpy only)."""
    gray = np.mean(img_array, axis=2)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1, 1:-1] = gray[1:-1, 2:] - gray[1:-1, :-2]
    gy[1:-1, 1:-1] = gray[2:, 1:-1] - gray[:-2, 1:-1]
    edges = np.hypot(gx, gy)
    edge_mask = edges > np.percentile(edges, 90)
    edge_ratio = np.sum(edge_mask) / edge_mask.size
    return min(1.0, edge_ratio * 3)

def score_render(png_path, target_colors=None, max_width=800):
    """Score a rendered embroidery PNG."""
    img = Image.open(png_path)
    # Resize for faster scoring if image is large
    if img.width > max_width:
        ratio = max_width / img.width
        new_size = (max_width, int(img.height * ratio))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
    img_array = np.array(img)
    if target_colors is None:
        target_colors = 7
    scores = {
        'vertical_bar': score_vertical_bar(img_array),
        'fragmentation': score_fragmentation(img_array),
        'halo_strands': score_halo_strands(img_array),
        'color_count': score_color_count(img_array, target_colors),
        'edge_density': score_edge_density(img_array),
    }
    weights = {
        'vertical_bar': 3.0,
        'fragmentation': 2.0,
        'halo_strands': 2.5,
        'color_count': 1.5,
        'edge_density': 1.0,
    }
    total = sum(scores[k] * weights[k] for k in scores)
    max_total = sum(weights.values())
    scores['total'] = total / max_total
    scores['file'] = os.path.basename(png_path)
    return scores

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 tools/render_score.py RENDER.png [--target N_COLORS]")
        sys.exit(1)
    png_path = sys.argv[1]
    target_colors = 7
    if '--target' in sys.argv:
        idx = sys.argv.index('--target')
        if idx + 1 < len(sys.argv):
            target_colors = int(sys.argv[idx + 1])
    scores = score_render(png_path, target_colors)
    print(f"Render score: {scores['file']}")
    print(f"  vertical_bar:  {scores['vertical_bar']:.3f}")
    print(f"  fragmentation: {scores['fragmentation']:.3f}")
    print(f"  halo_strands:  {scores['halo_strands']:.3f}")
    print(f"  color_count:   {scores['color_count']:.3f}")
    print(f"  edge_density:  {scores['edge_density']:.3f}")
    print(f"  TOTAL:         {scores['total']:.3f} (lower=better)")
