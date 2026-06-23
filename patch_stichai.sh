#!/usr/bin/env bash
# Stichai engine patch — render-parity (FIX0) + jump reduction (FIX1/2/3).
# Run from repo root:  bash patch_stichai.sh
set -e
[ -f lib/stitch.js ] && [ -f tools/render_dst.py ] || { echo "ERROR: run from repo root"; exit 1; }

python3 - <<'PY'
import re, sys, os, shutil
EDITS = {
  "tools/render_dst.py": [
    (r"travels, stitch_count = 0, 0",
     "travels, stitch_count = 0, 0\n    travel_segs = []", 1),
    (r'if last is not None and show_travels and mode not in \("viewer", "inf", "embmod"\):',
     "if last is not None and show_travels:", 1),
    (r"d\.line\(\[P\(\*last\), P\(x, y\)\], fill=\(230, 0, 0\), width=1\)\n(\s*)travels \+= 1",
     r"travel_segs.append((P(*last), P(x, y), c))\n\1travels += 1", 1),
    (r"\n    img\.save\(outp\)",
     "\n    for _a, _b, _c in travel_segs:\n"
     "        d.line([_a, _b], fill=(0, 60, 255), width=2)\n"
     "        if _c == pe.TRIM:\n"
     "            d.ellipse([_b[0]-3, _b[1]-3, _b[0]+3, _b[1]+3], outline=(230, 0, 0), width=2)\n"
     "    img.save(outp)", 1),
  ],
  "lib/stitch.js": [
    (r"(\n(\s*))// Reorder each type-run separately",
     r"\1for (const sh of group) { if (!sh._start) { const _p = v70_traceOutline(sh.mask, sh.w, sh.h);"
     r" sh._path = _p; sh._start = _p.length ? { x: _p[0][0] + sh.offX, y: _p[0][1] + sh.offY }"
     r" : { x: sh.offX + sh.w/2, y: sh.offY + sh.h/2 }; } }\1// Reorder each type-run separately", 1),
    (r"const c = _centroid\(remaining\[k\]\);",
     "const c = remaining[k]._start || _centroid(remaining[k]);", 1),
    (r"const c = _centroid\(next\); cx = c\.x; cy = c\.y;",
     "const c = (next._start || _centroid(next)); cx = c.x; cy = c.y;", 1),
    (r"/\* Trim if moving far \*/\n(\s*)const path = v70_traceOutline\(sh\.mask, sh\.w, sh\.h\);",
     r"/* Trim if moving far */\n\1const path = sh._path || v70_traceOutline(sh.mask, sh.w, sh.h);", 1),
    (r"const m = v70_buildMask\(pts\);\n(\s*)shapes\.push\(\{",
     r'const m = v70_buildMask(pts);\n\1{ const _e=(m.offX<=1)+(m.offY<=1)+((m.offX+m.w-1)>=canvasSize-2)'
     r'+((m.offY+m.h-1)>=canvasSize-2); const _f=(m.w*m.h)/(canvasSize*canvasSize);'
     r' if(process.env.STICHAI_SKIP_BG!=="0" && _f>0.30 && _e>=2){ continue; } }\n\1shapes.push({', 2),
    (r"v70_findRegions\(pixMap, canvasSize, canvasSize, minAreaPx\)",
     'v70_findRegions((process.env.STICHAI_CLOSE_MASKS!=="0"?v70_closeColorMasks(pixMap,colors,canvasSize):pixMap), canvasSize, canvasSize, minAreaPx)', 1),
    (r"v70_findRegions\(fillSrc, canvasSize, canvasSize, minAreaPx\)",
     'v70_findRegions((process.env.STICHAI_CLOSE_MASKS!=="0"?v70_closeColorMasks(fillSrc,colors,canvasSize):fillSrc), canvasSize, canvasSize, minAreaPx)', 1),
  ],
}
fail=False
for path, edits in EDITS.items():
    src=open(path,encoding="utf-8").read(); new=src
    for i,(pat,repl,want) in enumerate(edits):
        n=len(re.findall(pat,new))
        if n!=want:
            print(f"  ! {path} edit#{i}: expected {want}, found {n} (already patched?) — SKIP FILE"); fail=True; new=None; break
        new=re.sub(pat,repl,new,count=want)
    if new is None: continue
    if new!=src:
        shutil.copyfile(path,path+".prebak"); open(path,"w",encoding="utf-8").write(new)
        print(f"  ✓ patched {path}  (backup {path}.prebak)")
    else: print(f"  = {path} already patched")
sys.exit(1 if fail else 0)
PY
PATCH_RC=$?

echo "--- syntax check ---"
node --check lib/stitch.js && echo "stitch.js OK"
python3 -m py_compile tools/render_dst.py && echo "render_dst.py OK"
echo "--- changed ---"; git diff --stat 2>/dev/null | tail -4
echo
echo "Toggles (all ON by default):"
echo "  STICHAI_SKIP_BG=0       disable background suppression"
echo "  STICHAI_CLOSE_MASKS=0   disable defrag close"
echo "  STICHAI_DIRECTIONAL_FILL=0  (existing)"
[ $PATCH_RC -eq 0 ] && echo "DONE — regen a DST, then: python3 tools/dst_metrics.py design.dst  (target jumps>10mm=0)" || echo "NOTE: some edits skipped (see ! lines)."
