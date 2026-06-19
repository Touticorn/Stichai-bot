#!/usr/bin/env python3
"""
qc_iterate.py — quality-controlled autotune for Stichai engine parameters.

Reads a set of parameter sweeps, runs each via tools/autotune.py + tools/qa_full.py,
logs composite score to tools/qc_log.jsonl, and reports the best combination.

Each entry in PARAM_SWEEPS:
  name        — short label
  key         — engine-side identifier (used in logs)
  values      — list of discrete values to test

Each value triggers:
  - Set Railway env (manual via dashboard) — NOT automated
  - Push code change (manual `git commit && git push`)
  - Run tools/autotune.py with the test image, fetches DST
  - Run tools/qa_full.py on the DST, extracts flags
  - Compute composite score (higher = better)
  - Append to qc_log.jsonl

Final report:
  - Best parameter set per axis
  - Composite score regression vs baseline
  - Recommended commit message if a winner emerges

Composite scoring (qa_full.py flags):
  +5   if density_hull ∈ [2.0, 2.7]
  +5   if travel_pct ≤ 10
  +5   if long_runs == 0
  +5   if len_max < 7mm
  +3   if 5 ≤ n_colors ≤ 20
  +2   if len_p50 ≤ 1.5mm
  -2   per flag violation
  -3   if MAX-STITCH flag > 10mm
  +bonus: if composite >= 18 → mark as "GOOD"
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

ROOT = Path("/data/data/com.termux/files/home/stichai-bot")
LOG_PATH = ROOT / "tools" / "qc_log.jsonl"
WORKDIR = Path("/data/data/com.termux/files/home/.openclaw/workspace/stichai-view")

# Inputs to test against
DEFAULT_INPUT = WORKDIR / "input17.jpg"
SECOND_INPUT  = WORKDIR / "input5.jpg"


def score(metrics):
    """Composite score: higher is better."""
    s = 0
    d = metrics.get("density_hull", 0) or 0
    s += 5 if 2.0 <= d <= 2.7 else -3
    t = metrics.get("travel_pct", 100) or 100
    s += 5 if t <= 10.0 else -3
    lr = metrics.get("long_runs", 1) or 0
    s += 5 if lr == 0 else -3
    m = metrics.get("len_max", 99) or 99
    s += 5 if m < 7.0 else (-3 if m > 10 else -1)
    nc = metrics.get("n_colors", 0) or 0
    s += 5 if 5 <= nc <= 20 else -3
    med = metrics.get("len_p50", 99) or 99
    s += 2 if med <= 1.5 else 0
    return s


def grade(s):
    if s >= 18: return "GOOD"
    if s >= 12: return "MARGINAL"
    if s >= 6:  return "WEAK"
    return "REJECT"


def run_autotune(image_path, job_tag):
    """Run tools/autotune.py and capture the DST path+results."""
    env = os.environ.copy()
    env["STICHAI_INPUT"] = str(image_path)
    # pert-tag suffix to make this job distinct
    env["STICHAI_AUTOTUNE_TAG"] = job_tag
    out = subprocess.run(
        ["python3", "tools/autotune.py"],
        cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=600
    )
    if out.returncode != 0:
        print(f"autotune failed: {out.stderr[-300:] if out.stderr else 'no stderr'}")
        return None
    # Find the produced DST: tools/autotune.py saves to /tmp/embroidery/<jobid>.dst
    last_line = next((l for l in reversed(out.stdout.splitlines()) if l.startswith("DST written to")), None)
    if not last_line:
        print(f"autotune ran but no DST line: {out.stdout[-300:]}")
        return None
    return last_line.split(":", 1)[1].strip()


def qa_full(dst_path):
    """Run tools/qa_full.py and parse metrics dict."""
    json_path = str(WORKDIR / "_qa_full_latest.json")
    if Path(json_path).exists():
        Path(json_path).unlink()
    out = subprocess.run(
        ["python3", "tools/qa_full.py", dst_path, "--json", json_path],
        cwd=str(ROOT), capture_output=True, text=True, timeout=60
    )
    if out.returncode != 0 or not Path(json_path).exists():
        return None
    try:
        with open(json_path) as f:
            arr = json.load(f)
        return arr[0] if arr else None
    except (json.JSONDecodeError, IndexError):
        return None


def append_log(record):
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(record) + "\n")


def cmd_log_clear():
    if LOG_PATH.exists():
        LOG_PATH.unlink()


def summarize(label, results):
    """Format a tabular summary of results."""
    print(f"\n=== {label} ===")
    print(f"{'val':>14} | {'st':>6} | {'dens':>6} | {'trav':>6} | {'p95':>6} | {'max':>6} | {'lr':>4} | {'nc':>3} | {'sc':>3} | grade")
    print("-" * 88)
    for r in sorted(results, key=lambda x: -x["score"]):
        m = r["metrics"]
        print(f"{r['value']:>14} | {m.get('stitches',0):>6} | "
              f"{m.get('density_hull',0):.2f} | {m.get('travel_pct',0):.1f}% | "
              f"{m.get('len_p95',0):.1f}mm | {m.get('len_max',0):.1f}mm | "
              f"{m.get('long_runs',0):>4} | {m.get('n_colors',0):>3} | {r['score']:>3} | {grade(r['score'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(DEFAULT_INPUT))
    ap.add_argument("--baseline", action="store_true", help="run baseline only")
    ap.add_argument("--axis",    help="iterate just one axis (e.g. tatami, perim)")
    ap.add_argument("--clear-log", action="store_true")
    args = ap.parse_args()

    if args.clear_log:
        cmd_log_clear()
        print(f"cleared {LOG_PATH}")
        return

    # Sweep catalogue: name, axis, list of (label, env_or_code_value)
    # Engine currently live: STICHAI_TATAMI (default on, "0" = off), STICHAI_PERIM_PASS (same)
    # Plus internal JS constants that need code edits.
    SWEEPS = [
        ("TATAMI",         "engine",      ["on", "off"]),
        ("PERIM_PASS",     "engine",      ["on", "off"]),
    ]

    image = args.input
    print(f"== qc_iterate starting on {Path(image).name} ==\n")

    rows = []
    for axis_name, axis_kind, vals in SWEEPS:
        if args.axis and axis_name != args.axis.upper():
            continue
        for v in vals:
            print(f"\n>> sweep {axis_name}={v}")
            job_tag = f"qc_{axis_name.lower()}_{v}_{int(time.time())}"
            # NOTE: requires Railway env to already be set for v on `main`.
            # We cannot push code from this harness, but it WILL read live state.
            dst = run_autotune(image, job_tag)
            if not dst or not Path(dst).exists():
                print(f"  X no dst for {axis_name}={v}")
                continue
            metrics = qa_full(dst) or {}
            sc = score(metrics)
            gr = grade(sc)
            print(f"  -> dst={dst}, score={sc}, grade={gr}")
            record = {
                "axis": axis_name,
                "value": v,
                "image": Path(image).name,
                "dst": dst,
                "metrics": metrics,
                "score": sc,
                "grade": gr,
                "ts": int(time.time()),
            }
            rows.append(record)
            append_log(record)
            summarize(f"running {axis_name}", rows[-1:])
        summarize(f"{axis_name} sweep", [r for r in rows if r["axis"] == axis_name])

    print("\n\n=== FINAL ===")
    summarize("all rows", rows)
    best = max(rows, key=lambda x: x["score"]) if rows else None
    if best:
        print(f"\nBEST: {best['axis']}={best['value']}  (score={best['score']}, grade={best['grade']})")


if __name__ == "__main__":
    main()
