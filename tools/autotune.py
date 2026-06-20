#!/usr/bin/env python3
"""
Autotune the Stichai vector engine using render-based scoring.

Modes:
  1. Remote API sweep: --input IMAGE --sweep file.json
     Posts the same image with different tune={...} params, downloads DSTs,
     renders them, scores them, and reports the best tune.

  2. Local sweep: --sweep file.json --local-dst DST_DIR
     Re-renders an already-generated DST with a simulated tune change
     (limited; full effect requires engine API). Useful for evaluating a
     candidate render baseline.

  3. Evaluate existing renders: --evaluate PNG_DIR
     Scores each PNG and reports best/worst metrics.

Usage examples:
  python3 tools/autotune.py --input 45.png --sweep tools/autotune_sweep.json
  python3 tools/autotune.py --evaluate /data/data/com.termux/files/home/.openclaw/workspace
"""
import argparse, json, os, sys, time, urllib.request, urllib.parse, subprocess
import numpy as np
from PIL import Image

API = os.getenv("STICHAI_API", "https://stichai-bot-stichai.up.railway.app")
INPUT_IMG = os.getenv("STICHAI_INPUT", "/data/data/com.termux/files/home/.openclaw/workspace/45.png")

DEFAULT_SWEEP = {
    "bridgeMaxGap": [6, 8, 12],
    "absorbMinArea": [150, 250, 400],
    "absorbMaxArea": [10000, 20000, 40000],
    "absorbPerimRatio": [3.0, 4.0, 6.0],
    "autoZoomMargin": [0.005, 0.01, 0.02],
    "darkUnifyThresh": [80, 95, 120],
    "potraceTurdSize": [5, 10, 20]
}


def api_post(endpoint, data=None, files=None):
    url = f"{API}{endpoint}"
    if files:
        import mimetypes
        boundary = "----FormBoundary" + os.urandom(8).hex()
        body = b""
        for k, v in (data or {}).items():
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        for k, (fname, fdata) in files.items():
            ct = mimetypes.guess_type(fname)[0] or "application/octet-stream"
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\nContent-Type: {ct}\r\n\r\n".encode()
            body += fdata + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        req = urllib.request.Request(url, json.dumps(data or {}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def generate(job_id, img_path, tune=None, canvas_mm=160):
    with open(img_path, "rb") as f:
        img_data = f.read()
    canvas_size = canvas_mm * 10
    data = {"jobId": job_id, "mode": "cartoon", "extractedSubject": "1",
            "canvasSize": str(canvas_size), "hoop": "8x12"}
    if tune:
        data["tune"] = json.dumps(tune)
    r = api_post("/generate-embroidery", data=data,
                 files={"image": ("cartoon.png", img_data)})
    return r


def poll_by_id(job_id, max_wait=300):
    url = f"{API}/job-status/{job_id}"
    for _ in range(max_wait):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                d = json.loads(r.read().decode())
            if d.get("status") in ("done", "failed"):
                return d
        except Exception as e:
            print(f"poll warning: {e}")
        time.sleep(2)
    return {"status": "timeout"}


def download_raw(job_id, out_path):
    url = f"{API}/raw-dst/{job_id}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            with open(out_path, "wb") as f:
                f.write(r.read())
        return True
    except Exception:
        url = f"{API}/download/{job_id}"
        zip_path = out_path + ".zip"
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                with open(zip_path, "wb") as f:
                    f.write(r.read())
            import zipfile
            with zipfile.ZipFile(zip_path, "r") as z:
                members = [n for n in z.namelist() if n.endswith(".dst")]
                if members:
                    z.extract(members[0], path=os.path.dirname(out_path))
                    extracted = os.path.join(os.path.dirname(out_path), members[0])
                    os.rename(extracted, out_path)
            os.remove(zip_path)
        except Exception:
            pass
    return os.path.exists(out_path)


def render(dst_path, out_png, ppmm=12):
    r = subprocess.run(["python3", "tools/render_viewer.py", dst_path, out_png, str(ppmm)],
                       capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(__file__)))
    if r.returncode != 0:
        print(r.stderr.strip())
    return out_png


def score(png_path, target_colors=7):
    import re
    from render_score import score_render
    scores = score_render(png_path, target_colors)
    print(f"Render score: {scores['file']}")
    for k in ['vertical_bar','fragmentation','halo_strands','color_count','edge_density']:
        print(f"  {k:15s} {scores[k]:.3f}")
    print(f"  TOTAL:         {scores['total']:.3f} (lower=better)")
    return scores


def make_grid(sweep):
    """Convert a sweep dict of lists into a list of tune dicts (cartesian product)."""
    keys = list(sweep.keys())
    if not keys:
        return [{}]
    import itertools
    grids = []
    for vals in itertools.product(*[sweep[k] for k in keys]):
        grids.append(dict(zip(keys, vals)))
    return grids


def evaluate_pngs(png_dir, target_colors=7, pattern="*_viewer.png"):
    import glob
    results = []
    # Import scoring function directly to avoid subprocess overhead
    from render_score import score_render
    
    png_files = glob.glob(os.path.join(png_dir, pattern))
    print(f"Scoring {len(png_files)} PNGs matching '{pattern}'...")
    
    for path in png_files:
        fn = os.path.basename(path)
        scores = score_render(path, target_colors)
        results.append({"file": fn, "scores": scores})
    
    results.sort(key=lambda r: r["scores"].get("total", 1.0))
    print("\n=== Ranked by render score (lower=better) ===")
    for r in results[:10]:
        print(f"{r['scores']['total']:.3f}  {r['file']}")
    return results


def remote_sweep(input_path, sweep, work_dir, canvas_mm=160, target_colors=7):
    os.makedirs(work_dir, exist_ok=True)
    grid = make_grid(sweep)
    print(f"Running remote sweep with {len(grid)} tune configs")
    results = []
    for i, tune in enumerate(grid):
        job_id = f"autotune_{i}_{os.urandom(4).hex()}"
        print(f"\n[{i+1}/{len(grid)}] tune={tune}")
        r = generate(job_id, input_path, tune=tune, canvas_mm=canvas_mm)
        api_id = r.get("id")
        if not api_id:
            print(f"  FAILED: {r}")
            continue
        dst_path = os.path.join(work_dir, f"{api_id}.dst")
        png_path = os.path.join(work_dir, f"{api_id}.png")
        d = poll_by_id(api_id)
        if d.get("status") != "done":
            print(f"  job failed: {d}")
            continue
        if not download_raw(api_id, dst_path):
            print(f"  download failed")
            continue
        render(dst_path, png_path)
        scores = score(png_path, target_colors)
        results.append({"tune": tune, "scores": scores, "dst": dst_path, "png": png_path})
    results.sort(key=lambda r: r["scores"].get("total", 1.0))
    print("\n=== Best tunes ===")
    for r in results[:5]:
        print(f"  {r['scores']['total']:.3f}  {r['tune']}")
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=API)
    ap.add_argument("--input", default=INPUT_IMG)
    ap.add_argument("--work-dir", default="/data/data/com.termux/files/home/.openclaw/workspace/tmp/autotune")
    ap.add_argument("--sweep", help="JSON file with parameter grid (default: built-in)")
    ap.add_argument("--evaluate", help="Directory of PNGs to score and rank")
    ap.add_argument("--target-colors", type=int, default=7)
    ap.add_argument("--canvas-mm", type=int, default=160)
    args = ap.parse_args()
    if args.evaluate:
        evaluate_pngs(args.evaluate, args.target_colors)
        return

    sweep = DEFAULT_SWEEP
    if args.sweep:
        with open(args.sweep) as f:
            sweep = json.load(f)

    remote_sweep(args.input, sweep, args.work_dir, args.canvas_mm, args.target_colors)


if __name__ == "__main__":
    main()
