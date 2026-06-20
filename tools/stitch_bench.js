#!/usr/bin/env node
/**
 * stitch_bench.js — Stand-alone stitch-engine benchmark.
 * Builds a synthetic cartoon pixMap, runs v70/v72, exports DST, runs dst_qa.py.
 * No sharp/image processing needed — pure geometry test.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Load modules from lib/
const { getStitchParams, v70_buildShapes, v70_generateStitches, v72_buildAndGenerate, extractRegions, mergeAdjacentRegions } = require(path.join(ROOT, 'lib/stitch'));
const { encodeDST } = require(path.join(ROOT, 'lib/export'));
const { hexToRgb } = require(path.join(ROOT, 'lib/image'));

const CANVAS = 800;          // 80mm design @ 10px/mm
const PX_PER_MM = CANVAS / 80;

/**
 * Build a synthetic cartoon-style pixMap:
 *   - magenta (#FF00FF) background
 *   - large circle skin tone
 *   - smaller circle hair
 *   - rectangle shirt
 *   - two tiny circles eyes
 * This mimics the structure of a cartoon portrait.
 */
function buildSyntheticCartoon() {
  const W = CANVAS, H = CANVAS;
  const pixMap = new Int16Array(W * H).fill(-1);
  const colors = ['#C8A878', '#4A3020', '#CC3333', '#222222', '#FF00FF'];
  // index mapping: 0=skin, 1=hair, 2=shirt, 3=outline, 4=bg

  function drawCircle(ci, cx, cy, r) {
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          pixMap[y * W + x] = ci;
        }
      }
    }
  }

  function drawRect(ci, x0, y0, w, h) {
    for (let y = y0; y < y0 + h && y < H; y++) {
      for (let x = x0; x < x0 + w && x < W; x++) {
        pixMap[y * W + x] = ci;
      }
    }
  }

  // Background already magenta (-1), but explicitly set for clarity
  for (let i = 0; i < W * H; i++) pixMap[i] = 4;

  // Head (skin) - large circle, slightly offset
  drawCircle(0, 400, 300, 180);

  // Hair - covers top of head
  drawCircle(1, 400, 240, 140);

  // Body/shirt - rectangle below head
  drawRect(2, 280, 450, 240, 250);

  // Outline ring around head (thin dark border)
  const rOut = 184, rIn = 180;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d2 = (x - 400) ** 2 + (y - 300) ** 2;
      if (d2 <= rOut * rOut && d2 >= rIn * rIn) {
        pixMap[y * W + x] = 3; // outline
      }
    }
  }

  // Outline around shirt
  for (let y = 448; y <= 452; y++) {
    for (let x = 278; x <= 522; x++) pixMap[y * W + x] = 3;
  }
  for (let y = 698; y <= 702; y++) {
    for (let x = 278; x <= 522; x++) pixMap[y * W + x] = 3;
  }
  for (let y = 450; y <= 700; y++) {
    for (let x = 278; x <= 282; x++) pixMap[y * W + x] = 3;
    for (let x = 518; x <= 522; x++) pixMap[y * W + x] = 3;
  }

  // Eyes - two small dark circles on face
  drawCircle(3, 350, 280, 12);
  drawCircle(3, 450, 280, 12);

  return { pixMap, colors };
}

function buildFilter(pixMap, colors, canvasSize) {
  // Simple filtered pixMap that only includes non-background colors
  const out = new Int16Array(canvasSize * canvasSize).fill(-1);
  const bgIdx = colors.findIndex(c => c.toUpperCase() === '#FF00FF');
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] >= 0 && pixMap[i] !== bgIdx) {
      out[i] = pixMap[i];
    }
  }
  return out;
}

function runV70(pixMap, colors) {
  const params = getStitchParams({ fabric: 'cotton', density: 'medium', machine: 'generic' }, CANVAS);
  const shapes = v70_buildShapes(pixMap, colors, CANVAS, PX_PER_MM);
  const result = v70_generateStitches(shapes, colors, params, CANVAS);
  return result;
}

function runV72(pixMap, colors) {
  const params = getStitchParams({ fabric: 'cotton', density: 'medium', machine: 'generic' }, CANVAS);
  const result = v72_buildAndGenerate(pixMap, colors, CANVAS, PX_PER_MM, params);
  return result;
}

function exportDST(stitches, params, name) {
  const buf = encodeDST(stitches, params.machineLimits);
  const out = path.join(__dirname, '..', '_work', name);
  fs.writeFileSync(out, buf);
  return out;
}

function runQA(dstPath) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`python3 tools/dst_qa.py "${dstPath}"`, { cwd: ROOT, encoding: 'utf8' });
    return out;
  } catch (e) {
    return e.stdout || e.message;
  }
}

async function main() {
  const { pixMap, colors } = buildSyntheticCartoon();

  // Filter out background for the stitch engines
  const filtered = buildFilter(pixMap, colors, CANVAS);

  console.log('=== V70 ENGINE ===');
  const params = getStitchParams({ fabric: 'cotton', density: 'medium', machine: 'generic' }, CANVAS);
  const v70 = runV70(filtered, colors);
  const v70Path = exportDST(v70.stitches, params, 'bench_v70.dst');
  console.log(`V70 stitches: ${v70.stitches.length}`);
  console.log(runQA(v70Path));

  console.log('\n=== V72 ENGINE ===');
  const v72 = runV72(filtered, colors);
  const v72Path = exportDST(v72.stitches, params, 'bench_v72.dst');
  console.log(`V72 stitches: ${v72.stitches.length}`);
  console.log(runQA(v72Path));

  // Also try with pro-style tighter params
  console.log('\n=== V72 TIGHT ENGINE ===');
  const tightParams = getStitchParams({ fabric: 'cotton', density: 'high', machine: 'generic' }, CANVAS);
  const v72t = v72_buildAndGenerate(filtered, colors, CANVAS, PX_PER_MM, { ...tightParams, _outlineMask: null });
  const v72tPath = exportDST(v72t.stitches, tightParams, 'bench_v72_tight.dst');
  console.log(`V72 tight stitches: ${v72t.stitches.length}`);
  console.log(runQA(v72tPath));
}

main().catch(console.error);
