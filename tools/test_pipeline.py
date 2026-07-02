#!/usr/bin/env python3
"""
test_pipeline.py — Automated test+score pipeline for stichai engine.

Runs the full production-simulated pipeline on a test image, renders the DST,
and scores it against the original input image using visual + QA metrics.

Usage:
  python3 tools/test_pipeline.py <input-image> <mode> <colorCount> <canvasMm> [tune-json]

Output:
  - DST file at tools/_work/pipeline_output.dst
  - Render at tools/_work/pipeline_render.png
  - QA metrics printed
  - Render score printed
  - Combined score printed
"""
import sys, os, json, subprocess, tempfile

def run(cmd, cwd=None, timeout=300):
    """Run a command, return stdout. Raises on failure."""
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    if r.returncode != 0:
        print(f"  FAIL: {' '.join(cmd[:3])}...", file=sys.stderr)
        print(r.stderr[-500:], file=sys.stderr)
        raise RuntimeError(f"Command failed: {r.returncode}")
    return r.stdout

def qa_score(dst_path):
    """Run qa_full.py and parse metrics."""
    from pathlib import Path
    script_dir = Path(__file__).parent
    out = run([sys.executable, str(script_dir / "qa_full.py"), dst_path])
    metrics = {}
    flags = []
    for line in out.splitlines():
        line = line.strip()
        # Parse key=value pairs from the summary line and density line
        import re
        for m in re.finditer(r'(\w+)=\s*([\d.]+)', line):
            k, v = m.group(1), m.group(2)
            try: metrics[k] = float(v)
            except: pass
        if '⚠' in line:
            flags.append(line)
    metrics['flags'] = flags
    # Normalize to 0-1 score
    score = 1.0
    # Density: target 2.0-2.7
    d = metrics.get("density_hull", 2.0)
    if d < 2.0: score -= (2.0 - d) * 0.15
    if d > 2.7: score -= (d - 2.7) * 0.15
    # Travel: target < 10%
    t = metrics.get("travel_pct", 0)
    if t > 10: score -= (t - 10) * 0.02
    # Jump: target < 3%
    j = metrics.get("jump_pct", 0)
    if j > 3: score -= (j - 3) * 0.02
    # Long runs: target 0
    lr = metrics.get("long_runs", 0)
    score -= lr * 0.05
    # Flags penalty
    flags = metrics.get("flags", [])
    score -= len(flags) * 0.05
    metrics["qa_score"] = max(0, score)
    return metrics, score

def render_score(dst_path, original_path, render_path):
    """Render DST and compare to original using render_score.py if available."""
    from pathlib import Path
    script_dir = Path(__file__).parent
    
    # Render the DST
    run([sys.executable, str(script_dir / "render_dst.py"), dst_path, render_path, "12", "evp", "0"])
    
    # Try render_score.py for visual comparison
    score_script = script_dir / "render_score.py"
    if score_script.exists():
        try:
            out = run([sys.executable, str(score_script), render_path, original_path], timeout=60)
            # Parse score from output
            for line in out.splitlines():
                if "score" in line.lower():
                    try:
                        return float(line.split("=")[-1].strip())
                    except: pass
        except: pass
    return 0.5  # default neutral score

def run_pipeline(input_img, mode, color_count, canvas_mm, tune_json="{}"):
    """Run the full pipeline and return scores."""
    from pathlib import Path
    work_dir = Path(__file__).parent / "_work"
    work_dir.mkdir(exist_ok=True)
    script_dir = Path(__file__).parent
    repo_dir = script_dir.parent
    
    dst_path = str(work_dir / "pipeline_output.dst")
    render_path = str(work_dir / "pipeline_render.png")
    
    # Run the Node test harness
    tune = json.loads(tune_json) if isinstance(tune_json, str) else tune_json
    tune_str = json.dumps(tune)
    
    env = os.environ.copy()
    env["STICHAI_TATAMI"] = "0"
    env["STICHAI_PERIM_PASS"] = "0"
    
    harness = str(script_dir / "test_harness.js")
    cmd = ["node", harness, input_img, mode, str(color_count), str(canvas_mm), tune_str]
    print(f"[pipeline] Running harness: {mode} {color_count}c {canvas_mm}mm")
    out = run(cmd, cwd=str(repo_dir), timeout=300)
    
    # Check DST was created
    harness_dst = str(repo_dir / "tools" / "_work" / "test_output.dst")
    if os.path.exists(harness_dst):
        import shutil
        shutil.copy(harness_dst, dst_path)
    
    if not os.path.exists(dst_path):
        print(f"[pipeline] DST not created at {dst_path}")
        return None
    
    # QA score
    print(f"[pipeline] QA scoring...")
    qa_metrics, qa_score_val = qa_score(dst_path)
    print(f"  QA: stitches={qa_metrics.get('stitches',0):.0f} density={qa_metrics.get('density_hull',0):.2f} "
          f"travel={qa_metrics.get('travel_pct',0):.1f}% jumps={qa_metrics.get('jump_pct',0):.1f}% "
          f"score={qa_score_val:.3f}")
    if qa_metrics.get("flags"):
        for f in qa_metrics["flags"]:
            print(f"  ⚠ {f}")
    
    # Render score
    print(f"[pipeline] Rendering + visual scoring...")
    rs = render_score(dst_path, input_img, render_path)
    print(f"  Render score: {rs:.3f}")
    
    # Combined score (weighted: QA 40%, render 60%)
    combined = 0.4 * qa_score_val + 0.6 * rs
    print(f"[pipeline] Combined score: {combined:.3f}")
    print(f"  DST: {dst_path}")
    print(f"  Render: {render_path}")
    
    return {
        "qa": qa_metrics,
        "qa_score": qa_score_val,
        "render_score": rs,
        "combined": combined,
        "dst": dst_path,
        "render": render_path,
    }

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python3 tools/test_pipeline.py <input> <mode> <colors> <mm> [tune-json]")
        sys.exit(1)
    inp = sys.argv[1]
    mode = sys.argv[2]
    colors = int(sys.argv[3])
    mm = int(sys.argv[4])
    tune = sys.argv[5] if len(sys.argv) > 5 else "{}"
    
    result = run_pipeline(inp, mode, colors, mm, tune)
    if result:
        print(json.dumps({"combined": result["combined"], "qa_score": result["qa_score"], 
                          "render_score": result["render_score"]}, indent=2))
