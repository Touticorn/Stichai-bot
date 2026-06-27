#!/usr/bin/env node
/**
 * test_harness.js — Local test runner for stichai engine.
 * Bypasses Express/auth. Calls engine functions directly.
 *
 * Usage:
 *   node tools/test_harness.js <input-image> <mode> <colorCount> <canvasMm> [tune-json]
 *
 * Output:
 *   - DST file at tools/_work/test_output.dst
 *   - INF sidecar at tools/_work/test_output.inf
 *   - Console: stitch counts, QA metrics, vec-diag
 */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const {
  preprocessImage,
  extractColorsFromUnmasked,
  buildPixelMap,
} = require("../lib/image");
const { vectorizeToDST } = require("../lib/vectorize");
const { encodeDST } = require("../lib/export");

async function run() {
  const [
    , // node
    , // script
    inputPath,
    mode = "cartoon",
    colorCountStr = "5",
    canvasMmStr = "160",
    tuneJson = "{}",
  ] = process.argv;

  if (!inputPath) {
    console.error("Usage: node tools/test_harness.js <input-image> <mode> <colorCount> <canvasMm> [tune-json]");
    process.exit(1);
  }

  const colorCount = parseInt(colorCountStr);
  const canvasMm = parseInt(canvasMmStr);
  const tune = JSON.parse(tuneJson);

  // canvasSize in pixels at the engine's internal resolution
  // engine uses pxPerMm = canvasSize / canvasMm, and canvasSize is typically 800-1600
  // For 160mm: use 1600px → 10px/mm
  const canvasSize = 1600;

  const outDir = path.join(__dirname, "_work");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(`=== STICHAI TEST HARNESS ===`);
  console.log(`Input: ${inputPath}`);
  console.log(`Mode: ${mode}, Colors: ${colorCount}, Canvas: ${canvasMm}mm (${canvasSize}px)`);
  console.log(`Tune: ${JSON.stringify(tune)}`);
  console.log();

  // 1. Load image
  const imgBuffer = fs.readFileSync(inputPath);
  console.log(`[1/5] Image loaded: ${(imgBuffer.length / 1024).toFixed(0)} KB`);

  // 2. Preprocess
  console.log(`[2/5] Preprocessing (mode=${mode})...`);
  const cleanedBuffer = await preprocessImage(imgBuffer, canvasSize, mode);
  console.log(`  → cleaned: ${(cleanedBuffer.length / 1024).toFixed(0)} KB`);

  // 3. Extract colors
  console.log(`[3/5] Extracting ${colorCount} colors...`);
  const colors = await extractColorsFromUnmasked(cleanedBuffer, null, canvasSize, colorCount);
  console.log(`  → colors (${colors.length}): ${colors.join(", ")}`);

  // 4. Build pixel map
  console.log(`[4/5] Building pixel map...`);
  const pixMap = await buildPixelMap(cleanedBuffer, null, colors, canvasSize);
  const colorCounts = colors.map(() => 0);
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] >= 0 && pixMap[i] < colorCounts.length) colorCounts[pixMap[i]]++;
  }
  console.log(`  → pixel counts per color:`);
  colors.forEach((c, i) => {
    const pct = (100 * colorCounts[i] / pixMap.length).toFixed(1);
    console.log(`    ${i}: ${c} = ${colorCounts[i]} px (${pct}%)`);
  });

  // 5. Vectorize
  // Signature: vectorizeToDST(cleanedBuffer, colors, canvasSize, pxPerMm, params)
  // params includes: mode, selectedColors, tune, and stitch params
  const pxPerMm = 10; // matches production route
  console.log(`[5/5] Vectorizing (pxPerMm=${pxPerMm})...`);
  const { stitches, colorCounts: vecColorCounts } = await vectorizeToDST(
    cleanedBuffer,
    colors,
    canvasSize,
    pxPerMm,
    { mode, selectedColors: colors, tune }
  );

  const fillStitches = stitches.filter(s => s.type === "stitch").length;
  const jumps = stitches.filter(s => s.type === "jump" || s.type === "trim").length;
  const colorChanges = stitches.filter(s => s.type === "color-change").length;

  console.log();
  console.log(`=== RESULTS ===`);
  console.log(`Total stitches: ${stitches.length}`);
  console.log(`Fill stitches:  ${fillStitches}`);
  console.log(`Jumps/trims:    ${jumps}`);
  console.log(`Color changes:  ${colorChanges}`);
  console.log(`Colors used:    ${vecColorCounts.filter(c => c.count > 0).length}/${colors.length}`);
  vecColorCounts.forEach((c, i) => {
    if (c.count > 0) console.log(`  ${i}: ${colors[i]} → ${c.count} stitches (${c.type})`);
  });

  // 6. Export DST
  const dstBuffer = encodeDST(stitches);
  const dstPath = path.join(outDir, "test_output.dst");
  fs.writeFileSync(dstPath, dstBuffer);
  console.log();
  console.log(`DST written: ${dstPath} (${(dstBuffer.length / 1024).toFixed(0)} KB)`);
  console.log(`  header ST=${dstBuffer.meta.stitchCount} CO=${dstBuffer.meta.colorBlocks}`);

  // 7. Write INF sidecar with real thread colors
  const infPath = path.join(outDir, "test_output.inf");
  const infContent = generateInf(dstBuffer.meta, colors);
  fs.writeFileSync(infPath, infContent);
  console.log(`INF written: ${infPath}`);

  // 8. Render with our Python renderer
  console.log();
  console.log(`To render: python3 tools/render_dst.py ${dstPath} tools/_work/test_output_render.png 8 evp 1`);

  console.log();
  console.log(`=== DONE ===`);
}

function generateInf(meta, colors) {
  const threads = colors.map((hex, i) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `[thread${i + 1}]
Color=${r},${g},${b}
Name=Color${i + 1}
ID=${String(i + 1).padStart(3, "0")}
Hex=${hex}`;
  }).join("\n");

  return `[Version]
Major=1
Minor=0

[Parameters]
ST=${meta.stitchCount}
CO=${meta.colorBlocks}
AX=+    0
AY=+    0
MX=+    0
MY=+    0
PD=******

[Threads]
Count=${meta.colorBlocks}

${threads}
`;
}

run().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
