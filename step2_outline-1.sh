#!/usr/bin/env bash
# Stichai step 2 — outline-aware solid fills (palette-independent outline,
# flood-filled solid colours, one angle per colour, outline stitched on top).
set -e
[ -f lib/stitch.js ] && [ -f lib/image.js ] && [ -f routes/index.js ] || { echo "!! Run from ~/stichai-bot. Aborting."; exit 1; }
BK=".fixbak-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"
for f in lib/stitch.js lib/image.js routes/index.js; do cp "$f" "$BK/$(echo "$f"|tr / _)"; done
echo "Backups -> $BK/"

python3 - <<'PY'
def edit(path, pairs):
    t=open(path,encoding='utf-8').read(); orig=t; ap=[]; sk=[]
    for label,old,new,marker in pairs:
        if marker and marker in t: sk.append(label+" (already applied)"); continue
        if old in t: t=t.replace(old,new,1); ap.append(label)
        else: sk.append(label+" (ANCHOR NOT FOUND)")
    if t!=orig: open(path,'w',encoding='utf-8').write(t)
    print(f"  {path}")
    for a in ap: print("    + "+a)
    for s in sk: print("    . "+s)

# ---- image.js: palette-independent outline detector ----
OL_FN='''
/* \u2500\u2500 Outline mask: dark linework detected straight from the image (palette-independent) \u2500\u2500 */
async function buildOutlineMask(imageBuffer, canvasSize, lumThreshold) {
  const TH = lumThreshold || 70;
  const imgRaw = await sharp(imageBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw().toBuffer({ resolveWithObject: true });
  const { data, info } = imgRaw; const ch = info.channels;
  const mask = new Uint8Array(canvasSize * canvasSize);
  for (let i = 0; i < canvasSize * canvasSize; i++) {
    const o = i * ch; const r = data[o], g = data[o+1], b = data[o+2];
    if (g < r - 55 && g < b - 55 && r > 110 && b > 110) continue;
    if (0.299*r + 0.587*g + 0.114*b < TH) mask[i] = 1;
  }
  return mask;
}
'''
edit("lib/image.js", [
 ("buildOutlineMask + export", "\nmodule.exports = {", OL_FN+"\nmodule.exports = {\n  buildOutlineMask,", "async function buildOutlineMask"),
])

# ---- stitch.js ----
edit("lib/stitch.js", [
 ("outline-aware solid fillSrc",
  '''  let regions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);
  regions = v72_mergeSameColorFragments(regions, Math.max(2, Math.round(0.8 * pxPerMm))); // FIX: bridge fragments split by dark outlines
  console.log(`[v72] Per-component regions (merged): ${regions.length}`);''',
  '''  const outlineMask = P._outlineMask || null;
  let fillSrc = pixMap;
  if (outlineMask && outlineMask.length === canvasSize * canvasSize) {
    const W = canvasSize, H = canvasSize, SENT = -2;
    const fm = Int16Array.from(pixMap);
    for (let i = 0; i < fm.length; i++) if (outlineMask[i] && fm[i] >= 0) fm[i] = SENT;
    const q = new Int32Array(fm.length); let qh = 0, qt = 0;
    for (let i = 0; i < fm.length; i++) {
      if (fm[i] !== SENT) continue;
      const x = i % W, y = (i / W) | 0; let nc = -1;
      if (x > 0     && fm[i-1] >= 0) nc = fm[i-1];
      else if (x < W-1 && fm[i+1] >= 0) nc = fm[i+1];
      else if (y > 0     && fm[i-W] >= 0) nc = fm[i-W];
      else if (y < H-1 && fm[i+W] >= 0) nc = fm[i+W];
      if (nc >= 0) { fm[i] = nc; q[qt++] = i; }
    }
    while (qh < qt) {
      const i = q[qh++], c = fm[i], x = i % W, y = (i / W) | 0;
      if (x > 0     && fm[i-1] === SENT) { fm[i-1] = c; q[qt++] = i-1; }
      if (x < W-1 && fm[i+1] === SENT) { fm[i+1] = c; q[qt++] = i+1; }
      if (y > 0     && fm[i-W] === SENT) { fm[i-W] = c; q[qt++] = i-W; }
      if (y < H-1 && fm[i+W] === SENT) { fm[i+W] = c; q[qt++] = i+W; }
    }
    for (let i = 0; i < fm.length; i++) if (fm[i] === SENT) fm[i] = -1;
    fillSrc = fm;
  }
  let regions = v70_findRegions(fillSrc, canvasSize, canvasSize, minAreaPx);
  if (!outlineMask) regions = v72_mergeSameColorFragments(regions, Math.max(2, Math.round(0.8 * pxPerMm)));
  console.log(`[v72] regions: ${regions.length}${outlineMask ? " (outline-aware)" : ""}`);''',
  "outline-aware SOLID fills" if False else "let fillSrc = pixMap;"),
 ("per-colour fill angle table",
  '''  const ciOrder = [...new Set(shapes.map(s => s.ci))].sort((a, b) => areaByCi[b] - areaByCi[a]);''',
  '''  const ciOrder = [...new Set(shapes.map(s => s.ci))].sort((a, b) => areaByCi[b] - areaByCi[a]);
  const angByCi = new Map(), angPtByCi = new Map();
  for (const s of shapes) {
    if (s.type !== "fill") continue;
    const a = (s.pca.aspect < 2.2) ? Math.PI / 2 : s.pca.angle;
    if (!angPtByCi.has(s.ci) || s.ptCount > angPtByCi.get(s.ci)) { angByCi.set(s.ci, a); angPtByCi.set(s.ci, s.ptCount); }
  }''',
  "const angByCi = new Map()"),
 ("use per-colour angle",
  "      const angle = (sh.pca.aspect < 2.2) ? Math.PI / 2 : sh.pca.angle;",
  '''      const angle = (sh.type === "fill" && angByCi.has(ci)) ? angByCi.get(ci)
                  : ((sh.pca.aspect < 2.2) ? Math.PI / 2 : sh.pca.angle);''',
  'sh.type === "fill" && angByCi.has(ci)'),
 ("underlay reads de-outlined fillSrc",
  "const ul = generateZigzagUnderlay(pixMap, sh.reg, ci, canvasSize, color, ulSpacing, maxStitch);",
  "const ul = generateZigzagUnderlay(fillSrc, sh.reg, ci, canvasSize, color, ulSpacing, maxStitch);",
  "generateZigzagUnderlay(fillSrc,"),
 ("stitch outline on top (last)",
  "  // Final safety pass: any remaining move longer than the trim gap becomes a",
  '''  if (outlineMask) {
    let outlineColor = "#222222", dl = Infinity;
    for (const c of colors) { const { r, g, b } = hexToRgb(c); const L = 0.299*r + 0.587*g + 0.114*b; if (L < dl) { dl = L; if (L < 60) outlineColor = c; } }
    const olStep = Math.max(8, Math.round(1.8 * pxPerMm));
    const ol = v72_outlineMaskToRunning(outlineMask, canvasSize, outlineColor, olStep, minAreaPx, _trimGap);
    if (ol.length) {
      if (_lastPt) out.push({ x: _lastPt.x, y: _lastPt.y, color: outlineColor, type: "trim" });
      for (const s of ol) out.push(s);
    }
  }

  // Final safety pass: any remaining move longer than the trim gap becomes a''',
  "v72_outlineMaskToRunning(outlineMask, canvasSize, outlineColor"),
 ("outline pass: NN-order + sew short hops",
  '''  const out = [];
  let lastX = null, lastY = null;
  for (const r of regs) {
    const m = v70_buildMask(r.pts);
    const path = v70_traceOutline(m.mask, m.w, m.h);
    if (path && path.length) {
      const os = v70_outlineStitches(path, m.offX, m.offY, color, stepPx);
      if (os.length) {
        if (lastX !== null) out.push({ x: os[0].x, y: os[0].y, color, type: "trim" });
        for (const s of os) { out.push(s); lastX = s.x; lastY = s.y; }
      }
    }
  }
  return out;
}''',
  '''  const paths = [];
  for (const r of regs) {
    const m = v70_buildMask(r.pts);
    const path = v70_traceOutline(m.mask, m.w, m.h);
    if (path && path.length) {
      const os = v70_outlineStitches(path, m.offX, m.offY, color, stepPx);
      if (os.length) paths.push(os);
    }
  }
  const gap = trimGapPx || (7 * 10), step = Math.max(8, stepPx);
  const out = []; let last = null; const used = new Array(paths.length).fill(false);
  for (let k = 0; k < paths.length; k++) {
    let bi = -1, bd = Infinity;
    for (let j = 0; j < paths.length; j++) {
      if (used[j]) continue;
      const s = paths[j][0]; const d = last ? (s.x-last.x)**2 + (s.y-last.y)**2 : 0;
      if (d < bd) { bd = d; bi = j; }
    }
    if (bi < 0) break; used[bi] = true;
    const os = paths[bi];
    if (last) {
      const d = Math.hypot(os[0].x - last.x, os[0].y - last.y);
      if (d > gap) out.push({ x: os[0].x, y: os[0].y, color, type: "trim" });
      else { const n = Math.max(1, Math.ceil(d / step)); for (let qq = 1; qq <= n; qq++) out.push({ x: last.x + (os[0].x-last.x)*qq/n, y: last.y + (os[0].y-last.y)*qq/n, color, type: "running" }); }
    }
    for (const s of os) out.push(s);
    last = os[os.length - 1];
  }
  return out;
}''',
  "const paths = [];"),
 ("outline fn signature",
  "function v72_outlineMaskToRunning(outlineMask, canvasSize, color, stepPx, minAreaPx) {",
  "function v72_outlineMaskToRunning(outlineMask, canvasSize, color, stepPx, minAreaPx, trimGapPx) {",
  "minAreaPx, trimGapPx) {"),
 ("bridge concavities up to 12mm (fewer intra-fill jumps)",
  "  const pMaxBridge= Math.round((P.maxBridgeMm || 7) * pxPerMm);",
  "  const pMaxBridge= Math.round((P.maxBridgeMm || 12) * pxPerMm);",
  "P.maxBridgeMm || 12"),
])

# ---- routes/index.js: build & pass the outline mask ----
edit("routes/index.js", [
 ("import buildOutlineMask",
  "const { preprocessImage, extractColorsFromUnmasked, buildPixelMap, removeBackgroundImgly, renderPreviewFast, hexToRgb, rgbToLab, dE, normHex } = require(\"../lib/image\");",
  "const { preprocessImage, extractColorsFromUnmasked, buildPixelMap, buildOutlineMask, removeBackgroundImgly, renderPreviewFast, hexToRgb, rgbToLab, dE, normHex } = require(\"../lib/image\");",
  "buildOutlineMask, removeBackgroundImgly"),
 ("declare cleanedBuffer in scope",
  "      let pixMap, regions, colors, mode;",
  "      let pixMap, regions, colors, mode, cleanedBuffer;",
  "let pixMap, regions, colors, mode, cleanedBuffer;"),
 ("pull cleanedBuffer from detection",
  "        ({ pixMap, regions, colors, canvasSize, mode } = det);",
  "        ({ pixMap, regions, colors, canvasSize, mode } = det); cleanedBuffer = det.cleanedBuffer;",
  "cleanedBuffer = det.cleanedBuffer;"),
 ("reuse cleanedBuffer (not redeclare)",
  "        const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize, mode);",
  "        cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize, mode);",
  "        cleanedBuffer = await preprocessImage(imgFile.buffer"),
 ("build + pass outline mask before v72",
  "        const result = v72_buildAndGenerate(filtPm, selectedColors, canvasSize, 10, params);",
  '''        if (mode === "cartoon" && cleanedBuffer) {
          try { params._outlineMask = await buildOutlineMask(cleanedBuffer, canvasSize, 70); }
          catch (e) { console.warn("[v72] outline mask failed:", e.message); }
        }
        const result = v72_buildAndGenerate(filtPm, selectedColors, canvasSize, 10, params);''',
  "params._outlineMask = await buildOutlineMask"),
])
PY

echo "Syntax check:"
for f in lib/stitch.js lib/image.js routes/index.js; do node --check "$f" && echo "  ok  $f" || { echo "  !! ERROR $f -> restore from $BK"; exit 1; }; done
echo "Step 2 applied."
