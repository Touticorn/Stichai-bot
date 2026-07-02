#!/usr/bin/env python3
"""
autotune_pipeline.py — Optimize engine params using the test pipeline.

Uses coordinate descent: start from default params, try each param
independently, keep the value that improves the combined score most.

Usage:
  python3 tools/autotune_pipeline.py <input-image> <mode> <colorCount> <canvasMm>

Output:
  - Best tune JSON printed
  - Score progression printed
  - Best DST + render saved to tools/_work/
"""
import sys, os, json, copy, itertools

# Import the pipeline
sys.path.insert(0, os.path.dirname(__file__))
from test_pipeline import run_pipeline

# Reduced params for faster autotune (most impactful only)
TUNE_PARAMS = {
    "potraceTurdSize":   [100, 300, 500, 1000],
    "darkTurdSize":      [500, 1000, 2000],
    "tatamiRow":         [2, 3, 4],
    "bridgeMaxGap":      [4, 8],
    "absorbMinArea":     [100, 250, 500],
}

def coordinate_descent(input_img, mode, colors, mm, max_iters=2):
    """Coordinate descent: tune each param independently, repeat."""
    best_tune = {}
    baseline = run_pipeline(input_img, mode, colors, mm, json.dumps(best_tune))
    best_score = baseline["combined"] if baseline else 0
    print(f"\n[autotune] Baseline score: {best_score:.3f}")
    print(f"[autotune] Baseline tune: {json.dumps(best_tune)}\n")
    
    history = [{"iter": 0, "param": "baseline", "value": None, "score": best_score, "tune": copy.deepcopy(best_tune)}]
    
    for iteration in range(max_iters):
        print(f"\n[autotune] === Iteration {iteration+1}/{max_iters} ===")
        improved = False
        
        for param, values in TUNE_PARAMS.items():
            print(f"\n[autotune] Testing {param}: {values}")
            param_best_val = best_tune.get(param)
            param_best_score = best_score
            
            for val in values:
                if param_best_val == val:
                    continue  # skip current value
                trial_tune = copy.deepcopy(best_tune)
                trial_tune[param] = val
                
                # Skip rendering for intermediate runs (3x faster)
                result = run_pipeline(input_img, mode, colors, mm, json.dumps(trial_tune), skip_render=True)
                if not result:
                    continue
                
                score = result["combined"]
                print(f"  {param}={val}: qa_score={score:.3f} (best={param_best_score:.3f})")
                
                if score > param_best_score:
                    param_best_score = score
                    param_best_val = val
                    print(f"  ↑ NEW BEST for {param}: {val}")
            
            if param_best_val is not None and param_best_score > best_score:
                best_tune[param] = param_best_val
                best_score = param_best_score
                improved = True
                history.append({
                    "iter": iteration + 1,
                    "param": param,
                    "value": param_best_val,
                    "score": best_score,
                    "tune": copy.deepcopy(best_tune)
                })
                print(f"[autotune] Updated {param}={param_best_val}, score={best_score:.3f}")
        
        if not improved:
            print(f"\n[autotune] No improvement in iteration {iteration+1}. Stopping.")
            break
    
    print(f"\n[autotune] === FINAL ===")
    print(f"Best score: {best_score:.3f}")
    print(f"Best tune: {json.dumps(best_tune, indent=2)}")
    print(f"\n[autotune] History:")
    for h in history:
        print(f"  iter={h['iter']} param={h['param']} value={h['value']} score={h['score']:.3f}")
    
    return best_tune, best_score, history

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python3 tools/autotune_pipeline.py <input> <mode> <colors> <mm>")
        sys.exit(1)
    inp = sys.argv[1]
    mode = sys.argv[2]
    colors = int(sys.argv[3])
    mm = int(sys.argv[4])
    
    best_tune, best_score, history = coordinate_descent(inp, mode, colors, mm)
    
    # Save results
    out_path = os.path.join(os.path.dirname(__file__), "_work", "autotune_result.json")
    with open(out_path, "w") as f:
        json.dump({"best_tune": best_tune, "best_score": best_score, "history": history}, f, indent=2)
    print(f"\nResults saved to {out_path}")
