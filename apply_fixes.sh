#!/usr/bin/env bash
# Stichai — apply all fixes from the review + DST analysis. Run from repo root.
set -e
[ -f lib/stitch.js ] && [ -f routes/index.js ] || { echo "!! Run from ~/stichai-bot (repo root). Aborting."; exit 1; }

TS=$(date +%Y%m%d-%H%M%S); BK=".fixbak-$TS"; mkdir -p "$BK"
for f in lib/stitch.js lib/export.js lib/image.js routes/index.js public/index.html; do
  [ -f "$f" ] && cp "$f" "$BK/$(echo "$f" | tr / _)"
done
echo "Backups -> $BK/   (rollback: git checkout -- <file>  OR  cp $BK/lib_stitch.js lib/stitch.js)"

python3 - <<'PY'
import io
def edit(path, pairs):
    try: t=open(path,encoding='utf-8').read()
    except FileNotFoundError: print(f"  -- {path}: not found, skipped"); return
    orig=t; applied=[]; skipped=[]
    for label, old, new, marker in pairs:
        if marker and marker in t: skipped.append(label+" (already applied)"); continue
        if old in t: t=t.replace(old,new,1); applied.append(label)
        else: skipped.append(label+" (ANCHOR NOT FOUND)")
    if t!=orig: open(path,'w',encoding='utf-8').write(t)
    print(f"  {path}")
    for a in applied: print("    + "+a)
    for s in skipped: print("    . "+s)

# ---------- lib/stitch.js ----------
edit("lib/stitch.js", [
 ("4mm fill cap (v72)",
  "  const maxStitch = Math.max(20, Math.round(35 * pxScale * 0.75));",
  "  const maxStitch = Math.max(20, Math.round(4.0 * pxPerMm)); // FIX: fixed 4mm cap (was canvas-scaled ~6.7mm)",
  "Math.round(4.0 * pxPerMm)"),
 ("fragment merge wiring (v72)",
  "  const regions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);\n  console.log(`[v72] Per-component regions: ${regions.length}`);",
  "  let regions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);\n"
  "  regions = v72_mergeSameColorFragments(regions, Math.max(2, Math.round(0.8 * pxPerMm))); // FIX: bridge fragments split by dark outlines\n"
  "  console.log(`[v72] Per-component regions (merged): ${regions.length}`);",
  "regions (merged)"),
 ("travel-stitch planner (v72)",
  '  const _trimGap = 7 * pxPerMm;  // gap (px) beyond which a transition trims instead of stitching\n'
  '  const _trimIfFar = (nx, ny, color) => {\n'
  '    if (_lastPt) {\n'
  '      const d = Math.hypot(nx - _lastPt.x, ny - _lastPt.y);\n'
  '      if (d > _trimGap) out.push({ x: _lastPt.x, y: _lastPt.y, color, type: "trim" });\n'
  '    }\n'
  '  };',
  '  const _trimGap = 7 * pxPerMm;  // above this gap -> real trim/jump\n'
  '  const _travelStep = Math.max(8, Math.round(2.0 * pxPerMm)); // running-stitch pitch for sewn travel\n'
  '  // FIX: short hops sewn as small running stitches (pro files ~0.3% jumps), only long moves trim\n'
  '  const _travelTo = (nx, ny, color) => {\n'
  '    if (!_lastPt) return;\n'
  '    const d = Math.hypot(nx - _lastPt.x, ny - _lastPt.y);\n'
  '    if (d <= 1) return;\n'
  '    if (d > _trimGap) { out.push({ x: _lastPt.x, y: _lastPt.y, color, type: "trim" }); return; }\n'
  '    const n = Math.max(1, Math.ceil(d / _travelStep));\n'
  '    for (let k = 1; k <= n; k++) {\n'
  '      out.push({ x: _lastPt.x + (nx - _lastPt.x) * k / n,\n'
  '                 y: _lastPt.y + (ny - _lastPt.y) * k / n, color, type: "running" });\n'
  '    }\n'
  '    _lastPt = { x: nx, y: ny };\n'
  '  };',
  "_travelTo = (nx, ny, color)"),
 ("legacy fill 4mm cap",
  "  const pLen      = Math.max(8, Math.round((P.tatamiLen !== undefined ? P.tatamiLen : 30) * _resScale));",
  "  const pLen      = Math.max(8, Math.min(40, Math.round((P.tatamiLen !== undefined ? P.tatamiLen : 30) * _resScale))); // FIX: cap 4mm",
  "Math.min(40, Math.round((P.tatamiLen !== undefined"),
 ("v70 fill 4mm cap",
  "  const pSubdiv   = Math.max(20, Math.round((P.tatamiLen || 35) * pxScale * 0.75));  /* ~3.5mm target */",
  "  const pSubdiv   = Math.max(20, Math.min(40, Math.round((P.tatamiLen || 35) * pxScale * 0.75)));  /* FIX: capped 4mm */",
  "Math.min(40, Math.round((P.tatamiLen || 35)"),
])

# rename the 4 _trimIfFar call sites in stitch.js -> _travelTo (only if planner applied)
try:
    t=open("lib/stitch.js",encoding='utf-8').read()
    if "_travelTo = (nx, ny, color)" in t and "_trimIfFar(" in t:
        c=t.count("_trimIfFar("); t=t.replace("_trimIfFar(","_travelTo(")
        open("lib/stitch.js",'w',encoding='utf-8').write(t)
        print(f"    + renamed {c} _trimIfFar call site(s) -> _travelTo")
except FileNotFoundError: pass

# ---------- lib/export.js ----------
edit("lib/export.js", [
 ("import hexToRgb + MACHINE_LIMITS fallback (fixes JEF/PES/batch crash)",
  "\nfunction dstEncodeXY(dx, dy, isJump) {",
  '\nconst { hexToRgb } = require("./image"); // FIX: used but never imported\n'
  'const MACHINE_LIMITS = { generic: { maxJump: 121, minStitch: 3 } }; // FIX: fallback for encodeDST default\n\n'
  'function dstEncodeXY(dx, dy, isJump) {',
  'require("./image"); // FIX: used but never imported'),
])

# ---------- lib/image.js ----------
edit("lib/image.js", [
 ("color-extraction bucket bug (loop key)",
  "  for (const [, freq] of bucketFreq) {",
  "  for (const [key, freq] of bucketFreq) {",
  "for (const [key, freq] of bucketFreq)"),
 ("color-extraction bucket bug (lookup)",
  "    const s   = bucketSums.get(Array.from(bucketFreq.keys()).find(k => bucketFreq.get(k) === freq));",
  "    const s   = bucketSums.get(key); // FIX: was re-finding by frequency value (wrong bucket on ties)",
  "bucketSums.get(key); // FIX"),
])

# ---------- routes/index.js ----------
edit("routes/index.js", [
 ("engine-output diagnostic log (which branch + jump rate)",
  '      progressCb(70, "Adding basting…");',
  '      const _trimN = stitches.filter(s => s.type === "trim" || s.type === "jump").length;\n'
  '      console.log(`[${rid}] engine output: ${stitches.length} stitches, ${_trimN} trims/jumps (${(100*_trimN/Math.max(1,stitches.length)).toFixed(1)}%)`);\n'
  '      progressCb(70, "Adding basting…");',
  "engine output: ${stitches.length} stitches"),
])

# ---------- public/index.html ----------
edit("public/index.html", [
 ("batch download sends auth header (was window.open, 401 when logged in)",
  "  window.open(`/download-batch/${jid}`, '_blank');",
  "  fetch(`/download-batch/${jid}`,{headers:getAuthHeaders()}).then(r=>r.blob()).then(b=>{var u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=`stichai-batch-${jid}.zip`;a.click();URL.revokeObjectURL(u);}).catch(e=>alert('Download failed: '+e.message));",
  "fetch(`/download-batch/${jid}`,{headers:getAuthHeaders()})"),
])
PY

# delete the stale duplicate module
if [ -f lib/image-2.js ]; then
  (git rm -f lib/image-2.js >/dev/null 2>&1 && echo "  git rm lib/image-2.js") || (rm -f lib/image-2.js && echo "  rm lib/image-2.js")
fi

echo "Syntax check:"
ERR=0
for f in lib/stitch.js lib/export.js lib/image.js routes/index.js; do
  if node --check "$f" 2>/dev/null; then echo "  ok  $f"; else echo "  !! SYNTAX ERROR $f  -> restore: cp $BK/$(echo $f|tr / _) $f"; ERR=1; fi
done
[ "$ERR" = "0" ] && echo "ALL FIXES APPLIED. Test a cartoon generation; check logs for the jump %." || echo "Fix the syntax error above before deploying."
