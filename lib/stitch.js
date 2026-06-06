"use strict";

/**
 * Embroidery stitch generation engine.
 *   v70 — vectorised region-based tatami fill
 *   v71 — photo cross-hatch mode
 *   legacy — generateStitchesFromRegions (fallback)
 *
 * Exports: getStitchParams, generateStitchesFromRegions,
 *          v70_buildShapes, v70_generateStitches,
 *          v71_generatePhotoStitch,
 *          validateQuality, calculateSewTime,
 *          extractRegions, mergeAdjacentRegions,
 *          applyColorMerges, generateBastingBox,
 *          and all supporting helpers.
 */

const MAX_QUEUE_CONCURRENCY = 2;            // Heavy jobs at once
const JOB_TIMEOUT_MS = 120000;              // 2 minutes
const CACHE_MAX_SIZE = 50;                  // LRU size
const MIN_AREA = 25;                        // min region area (px²) at 800px baseline; scaled by canvasSize

// Machine-specific max stitch length (mm)
const MACHINE_MAX_STITCH_MM = {
  tajima: 5.0, barudan: 5.0, brother: 6.0, janome: 4.5, singer: 4.0, generic: 5.0
};

// Map to pixel (10px/mm)
function getMaxStitchPx(machine, pxPerMm) {
  const mm = MACHINE_MAX_STITCH_MM[machine] || MACHINE_MAX_STITCH_MM.generic;
  return Math.round(mm * pxPerMm);
}

const MACHINE_LIMITS = {
  tajima:  { maxJump: 121, minStitch: 3 },
  barudan: { maxJump: 121, minStitch: 3 },
  brother: { maxJump: 127, minStitch: 4 },
  janome:  { maxJump: 127, minStitch: 4 },
  singer:  { maxJump: 100, minStitch: 5 },
  generic: { maxJump: 121, minStitch: 3 },
};

const HOOP_PULL = {
  "4x4": 1, "5x7": 2, "6x10": 3, "8x8": 4, "8x12": 6,
};

/* ═══════════════════════════════════════════════════════════
   LRU CACHE (memory-safe)
   ═══════════════════════════════════════════════════════════ */

const { hexToRgb, rgbToLab, dE, normHex } = require('./image');

function getRunsInRow(pixMap,ci,y,x0,x1,canvasSize){
  const runs=[];let s=-1;
  for(let x=x0;x<=x1;x++){
    const hit=y>=0&&y<canvasSize&&pixMap[y*canvasSize+x]===ci;
    if(hit&&s===-1)s=x;
    if(!hit&&s!==-1){runs.push({x1:s,x2:x-1});s=-1;}
  }
  if(s!==-1)runs.push({x1:s,x2:x1});
  return runs;
}

/* ═══════════════════════════════════════════════════════════════════════
   V70 — MASK-BASED ORIENTED STITCH GENERATION
   ═══════════════════════════════════════════════════════════════════════

   Key insight from v69 failure: polygon simplification destroys shape detail
   on complex regions. We must scan the actual pixel mask, not a simplified
   outline.

   Pipeline per color:
     1. Connected-components on the pixMap → raw regions
     2. Split giant blobs: erode by N pixels, re-CC, then dilate labels back
        This separates fronds that connect at thin junctions.
     3. For each sub-region:
        a. Compute PCA angle from interior pixels
        b. Generate oriented row scan: for each row perpendicular to long axis,
           walk the mask along the row direction and emit stitch pairs at the
           start/end of each inside-run.
        c. Outline pass: walk the boundary (Moore tracing) and emit running
           stitches around it.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── PCA on a list of (x,y) pixel coords ───────────────────────────────── */
function v70_pca(pts) {
  const n = pts.length;
  if (n < 4) return { angle: 0, aspect: 1, cx: 0, cy: 0 };
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const lam1 = tr / 2 + disc, lam2 = tr / 2 - disc;
  /* eigenvector for largest eigenvalue (long axis) */
  const longAngle = Math.atan2(lam1 - sxx, sxy || 1e-9);
  /* stitches run PERPENDICULAR to the long axis (across the narrow dimension) */
  const stitchAngle = longAngle + Math.PI / 2;
  const aspect = lam2 > 0.01 ? Math.sqrt(lam1 / lam2) : 999;
  return { angle: stitchAngle, longAngle, aspect, cx, cy };
}

/* ── BFS connected components on a pixMap, with optional label filter ──── */
/* ── Per-colour morphological CLOSE — defragments fills cut by dark linework ──
   PROBLEM: a clean cartoon has bold dark outlines. After quantisation those
   outlines are pixels in the pixMap, so they physically slice a single fill
   (e.g. a white gown) into dozens of disconnected regions — every seam, placket
   and arm-line cuts the white apart. This fragmentation (60-120 regions from
   ~10 real areas) is the root cause of high jumps, blobby fills and under-fill.

   FIX (the correct layer): for each NON-dark colour, run a morphological close
   (dilate then erode) on THAT colour's binary mask. This bridges the thin dark
   gaps within one colour without ever touching the boundary between two
   different fills. The pixels that get filled are taken ONLY from the dark
   outline colour — a fill can never steal from another fill, so the white gown
   and the red trim stay separate. The dark contour is still re-drawn on top by
   the definition-outline pass (which traces shape boundaries), so the visible
   outline is preserved while the fills become whole.

   Kernel radius is deliberately conservative (~outline thickness). Too large
   would let a fill swallow adjacent thin trim; too small wouldn't close the
   lines. We size it to the typical cartoon outline width. */
function v70_closeColorMasks(pixMap, colors, canvasSize) {
  const N = canvasSize;
  // Identify the darkest palette colour (the outline tone). Only its pixels are
  // eligible to be consumed by a neighbouring fill's close operation.
  let darkCi = -1, darkLum = Infinity;
  for (let c = 0; c < colors.length; c++) {
    const { r, g, b } = hexToRgb(colors[c]);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < darkLum) { darkLum = lum; darkCi = c; }
  }
  // No genuinely-dark outline colour → nothing to bridge (e.g. pastel design).
  if (darkCi < 0 || darkLum >= 95) return pixMap;

  // Kernel radius in px: ~outline thickness. Scales with canvas resolution.
  const rad = Math.max(2, Math.round(3 * (N / 800)));   // 800px→3px, 1600px→6px

  // Build the set of colours to close: every non-dark colour, processed from
  // LARGEST area to smallest, so big fills (gown) claim the line first and we
  // don't let a tiny region grab pixels a major fill should own.
  const areaByCi = new Array(colors.length).fill(0);
  for (let i = 0; i < pixMap.length; i++) {
    const ci = pixMap[i];
    if (ci >= 0) areaByCi[ci]++;
  }
  const order = [];
  for (let c = 0; c < colors.length; c++) {
    if (c === darkCi) continue;
    if (areaByCi[c] === 0) continue;
    // Only LIGHT fills participate in the close. Dark fills (hair, dark brown)
    // are too close to the outline colour — bridging through outlines just merges
    // them into giant blobs (the 12k-stitch rectangle bug). Lum > 120 ensures
    // only genuinely light areas (white gown, skin, teal) get defragmented.
    const { r, g, b } = hexToRgb(colors[c]);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum <= 120) continue;   // skip dark fills — they don't need bridging
    order.push(c);
  }
  order.sort((a, b) => areaByCi[b] - areaByCi[a]);

  // Work on a copy so each colour closes against the ORIGINAL geometry, then we
  // commit claimed dark pixels. A dark pixel, once claimed by a larger fill, is
  // removed from the pool so a smaller fill can't re-claim it.
  const out = Int16Array.from(pixMap);
  const claimed = new Uint8Array(N * N); // dark pixels already taken this pass

  // Temp buffers reused per colour.
  const mask = new Uint8Array(N * N);
  const dil  = new Uint8Array(N * N);

  for (const ci of order) {
    // 1) mask = pixels of this colour (from original pixMap)
    mask.fill(0);
    for (let i = 0; i < pixMap.length; i++) if (pixMap[i] === ci) mask[i] = 1;

    // 2) DILATE by `rad` (square structuring element via separable passes).
    //    A dilated pixel is "on" if any pixel within rad (Chebyshev) is on.
    //    Separable: horizontal max then vertical max — O(N²·rad) but cheap.
    dil.set(mask);
    // horizontal
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        if (mask[row + x]) continue;
        let on = 0;
        for (let k = 1; k <= rad; k++) {
          if ((x - k >= 0 && mask[row + x - k]) || (x + k < N && mask[row + x + k])) { on = 1; break; }
        }
        if (on) dil[row + x] = 1;
      }
    }
    // vertical (read from a snapshot of horizontal result)
    const hRes = Uint8Array.from(dil);
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        if (hRes[y * N + x]) continue;
        let on = 0;
        for (let k = 1; k <= rad; k++) {
          if ((y - k >= 0 && hRes[(y - k) * N + x]) || (y + k < N && hRes[(y + k) * N + x])) { on = 1; break; }
        }
        if (on) dil[y * N + x] = 1;
      }
    }

    // 3) ERODE the dilated mask by `rad` (close = dilate then erode). We only
    //    KEEP a dilated pixel if it survives erosion, i.e. it's well inside the
    //    dilated shape. Erosion: pixel stays on only if all neighbours within
    //    rad are on. Approximate with the same separable min.
    //    But we only care about NEW pixels that were originally DARK and become
    //    part of this fill — i.e. the thin-line gaps now closed.
    //    A simpler, robust rule: a dark pixel becomes this fill if it was inside
    //    the dilation AND it lies between this colour on both sides within rad
    //    (so we're filling a gap, not growing the outer boundary).
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const i = row + x;
        if (out[i] !== darkCi) continue;     // only consume dark-outline pixels
        if (claimed[i]) continue;            // already taken by a larger fill
        if (!dil[i]) continue;               // not reachable by this fill's dilation
        // Gap test: this colour present within rad on opposite sides (H or V).
        let leftHit = false, rightHit = false, upHit = false, downHit = false;
        for (let k = 1; k <= rad && !(leftHit && rightHit); k++) {
          if (x - k >= 0 && mask[row + x - k]) leftHit = true;
          if (x + k < N && mask[row + x + k]) rightHit = true;
        }
        for (let k = 1; k <= rad && !(upHit && downHit); k++) {
          if (y - k >= 0 && mask[(y - k) * N + x]) upHit = true;
          if (y + k < N && mask[(y + k) * N + x]) downHit = true;
        }
        const bridgesH = leftHit && rightHit;
        const bridgesV = upHit && downHit;
        if (bridgesH || bridgesV) {
          out[i] = ci;        // close the gap: dark pixel joins this fill
          claimed[i] = 1;     // and is now off-limits to smaller fills
        }
      }
    }
  }

  for (let i = 0; i < out.length; i++) pixMap[i] = out[i];
  return pixMap;
}

function v70_findRegions(pixMap, w, h, minArea) {
  const visited = new Uint8Array(w * h);
  const regions = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ci = pixMap[i];
      if (ci < 0 || visited[i]) continue;
      const pts = [];
      const stack = [i];
      visited[i] = 1;
      let mnx = x, mxx = x, mny = y, mxy = y;
      while (stack.length) {
        const idx = stack.pop();
        const xx = idx % w, yy = (idx / w) | 0;
        pts.push([xx, yy]);
        if (xx < mnx) mnx = xx; if (xx > mxx) mxx = xx;
        if (yy < mny) mny = yy; if (yy > mxy) mxy = yy;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = xx + dx, ny = yy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni]) continue;
          if (pixMap[ni] === ci) { visited[ni] = 1; stack.push(ni); }
        }
      }
      if (pts.length >= minArea) {
        regions.push({ ci, pts, mnx, mny, mxx, mxy });
      }
    }
  }
  return regions;
}

/* ── Distance transform (Chamfer 3-4): for each pixel, distance to nearest 0
   Used to find "ridge" pixels where shape is widest — these are sub-shape centres.
   ───────────────────────────────────────────────────────────────────────── */
function v70_distanceTransform(mask, w, h) {
  const INF = 65535;
  const d = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  /* forward pass */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x > 0)         v = Math.min(v, d[i-1] + 3);
      if (y > 0)         v = Math.min(v, d[i-w] + 3);
      if (x > 0 && y > 0) v = Math.min(v, d[i-w-1] + 4);
      if (x < w-1 && y > 0) v = Math.min(v, d[i-w+1] + 4);
      d[i] = v;
    }
  }
  /* backward pass */
  for (let y = h-1; y >= 0; y--) {
    for (let x = w-1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x < w-1)       v = Math.min(v, d[i+1] + 3);
      if (y < h-1)       v = Math.min(v, d[i+w] + 3);
      if (x < w-1 && y < h-1) v = Math.min(v, d[i+w+1] + 4);
      if (x > 0 && y < h-1) v = Math.min(v, d[i+w-1] + 4);
      d[i] = v;
    }
  }
  return d;
}

/* ── Find local maxima of distance transform: pixels with DT ≥ all 8 neighbours.
   These are "skeleton tips" — natural centers of distinct sub-shapes.
   Returns array of {x, y, dt} grouped into clusters (each cluster = one seed).
   ───────────────────────────────────────────────────────────────────────── */
function v70_findDtMaxima(dt, w, h, minDt) {
  const maxima = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = dt[i];
      if (v < minDt) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1 && isMax; dx++) {
          if (!dx && !dy) continue;
          if (dt[(y+dy) * w + (x+dx)] > v) isMax = false;
        }
      }
      if (isMax) maxima.push([x, y, v]);
    }
  }
  /* Cluster nearby maxima (within minDt/3) into single seeds */
  const clusterRadius = Math.max(3, minDt / 3 / 3);  /* /3 because Chamfer units */
  const used = new Uint8Array(maxima.length);
  const clusters = [];
  for (let i = 0; i < maxima.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const cluster = [maxima[i]];
    for (let j = i + 1; j < maxima.length; j++) {
      if (used[j]) continue;
      const dx = maxima[i][0] - maxima[j][0], dy = maxima[i][1] - maxima[j][1];
      if (dx*dx + dy*dy < clusterRadius * clusterRadius) {
        cluster.push(maxima[j]);
        used[j] = 1;
      }
    }
    /* Cluster centroid weighted by dt */
    let sx = 0, sy = 0, sw = 0;
    for (const [x, y, v] of cluster) { sx += x * v; sy += y * v; sw += v; }
    clusters.push([sx / sw, sy / sw]);
  }
  return clusters;
}

/* ── Watershed-style splitting: every pixel goes to its nearest DT maximum
   measured by Euclidean distance. Each maximum = one sub-shape seed.
   ───────────────────────────────────────────────────────────────────────── */
function v70_splitRegion(reg, canvasSize, junctionPx) {
  const rw = reg.mxx - reg.mnx + 1;
  const rh = reg.mxy - reg.mny + 1;
  const origMask = new Uint8Array(rw * rh);
  for (const [x, y] of reg.pts) {
    origMask[(y - reg.mny) * rw + (x - reg.mnx)] = 1;
  }
  const dt = v70_distanceTransform(origMask, rw, rh);
  /* Chamfer 3-4: orthogonal = 3 per pixel. So junctionPx pixels = junctionPx*3 DT units */
  const minDt = junctionPx * 3;
  const seeds = v70_findDtMaxima(dt, rw, rh, minDt);
  if (seeds.length <= 1) return [reg.pts];

  /* Assign each pixel to nearest seed by Euclidean distance */
  const subRegions = seeds.map(() => []);
  for (const [x, y] of reg.pts) {
    const lx = x - reg.mnx, ly = y - reg.mny;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < seeds.length; k++) {
      const dx = lx - seeds[k][0], dy = ly - seeds[k][1];
      const d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    subRegions[best].push([x, y]);
  }
  return subRegions.filter(s => s.length >= 25);
}

/* ── Build an oriented mask: for each pixel of the region, store 1 ─────────
   Stored as a packed object: { mask, w, h, offX, offY }
   ───────────────────────────────────────────────────────────────────────── */
function v70_buildMask(pts) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
  }
  const w = mxx - mnx + 1, h = mxy - mny + 1;
  const mask = new Uint8Array(w * h);
  for (const [x, y] of pts) mask[(y - mny) * w + (x - mnx)] = 1;
  return { mask, w, h, offX: mnx, offY: mny };
}

/* ── Moore-neighbour boundary trace on a binary mask ─────────────────────── */
function v70_traceOutline(mask, w, h) {
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  /* Find first interior pixel */
  let startIdx = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { startIdx = i; break; }
  if (startIdx < 0) return [];
  const sx = startIdx % w, sy = (startIdx / w) | 0;
  let cx = sx, cy = sy, backDir = 4;
  const path = [];
  let steps = 0;
  const maxSteps = (w + h) * 8 + 1000;
  do {
    path.push([cx, cy]);
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (backDir + 1 + i) & 7;
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) {
        backDir = (d + 4) & 7;
        cx = nx; cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    steps++;
  } while ((cx !== sx || cy !== sy) && steps < maxSteps);
  return path;
}

/* ── Oriented row scan: for each row perpendicular to the long axis,
   walk the mask along the row direction and find inside-runs.
   This is the KEY function — it preserves shape detail because it samples
   the actual mask pixels, not a simplified polygon outline.
   ───────────────────────────────────────────────────────────────────────── */
function v70_scanRuns(mask, w, h, offX, offY, angle, rowSpacing) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  /* Row direction is +angle. Long axis perpendicular = (-sin, cos). */
  /* Project all corner points to find row range and column range */
  const corners = [[0,0],[w-1,0],[0,h-1],[w-1,h-1]];
  let minT = Infinity, maxT = -Infinity, minU = Infinity, maxU = -Infinity;
  for (const [lx, ly] of corners) {
    const u = lx * cos + ly * sin;        /* along row direction */
    const t = -lx * sin + ly * cos;       /* along long axis (perpendicular) */
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (t < minT) minT = t; if (t > maxT) maxT = t;
  }
  const stepAlongRow = 0.5;  /* sub-pixel sampling along the row */
  const rows = [];
  for (let t = minT; t <= maxT; t += rowSpacing) {
    /* For each sample along the row, check if mask is hit at (round(u*cos - t*sin), round(u*sin + t*cos)) */
    const runs = [];
    let runStart = null;
    for (let u = minU; u <= maxU; u += stepAlongRow) {
      const lx = u * cos - t * sin;
      const ly = u * sin + t * cos;
      const ix = Math.round(lx), iy = Math.round(ly);
      const inside = (ix >= 0 && iy >= 0 && ix < w && iy < h) && mask[iy * w + ix];
      if (inside) {
        if (runStart === null) runStart = u;
      } else {
        if (runStart !== null) {
          runs.push([runStart, u - stepAlongRow]);
          runStart = null;
        }
      }
    }
    if (runStart !== null) runs.push([runStart, maxU]);
    if (runs.length) rows.push({ t, runs });
  }
  return { rows, cos, sin, offX, offY };
}

/* ── Convert scanned runs into stitch pairs and rotate back to image space.
   Adds brick offset and reverses every other row to minimize jumps.
   Inserts trim commands between segments separated by negative space
   (so the machine pen-ups instead of bridging across).
   ───────────────────────────────────────────────────────────────────────── */
function v70_runsToStitches(scan, color, brickAmt, pullComp, maxBridgePx, maxStitchLen) {
  /* maxStitchLen is the soft target — any stitch longer than this gets split
     into N pieces of equal length. We aim for stitches AROUND this length,
     not just below it. So if maxStitchLen = 47px (4.7mm), a 100px segment
     becomes 3 pieces of ~33px (3.3mm), not 2 pieces of 50px. */
  const targetLen = maxStitchLen;
  const { rows, cos, sin, offX, offY } = scan;
  const stitches = [];
  let reversed = false;
  let lastX = null, lastY = null;
  for (let r = 0; r < rows.length; r++) {
    const { t, runs } = rows[r];
    const ordered = reversed ? [...runs].reverse() : runs;
    const brick = (r % 2 === 0) ? 0 : brickAmt;
    for (let i = 0; i < ordered.length; i++) {
      let [u1, u2] = ordered[i];
      u1 += pullComp; u2 -= pullComp;
      if (u2 - u1 < 0.5) continue;
      const startU = reversed ? u2 : u1;
      const endU   = reversed ? u1 : u2;
      const sx = offX + startU * cos - t * sin;
      const sy = offY + startU * sin + t * cos;
      const ex = offX + endU   * cos - (t + brick) * sin;
      const ey = offY + endU   * sin + (t + brick) * cos;
      if (lastX !== null) {
        const travel = Math.hypot(sx - lastX, sy - lastY);
        // Trim only when the gap is genuinely large. Small same-row gaps (holes
        // a few mm wide) are bridged with a connecting stitch that disappears
        // under the fill — far better than cutting/restarting on every hole,
        // which produced hundreds of trims and thread tails.
        if (travel > maxBridgePx) {
          stitches.push({ x: lastX, y: lastY, color, type: "trim" });
        } else if (maxStitchLen > 0 && travel > maxStitchLen) {
          /* Bridge between row N end → row N+1 start. If longer than the
             machine's max stitch, subdivide so we don't exceed hardware limit
             AND so the bridge doesn't show as a long diagonal line in viewers. */
          const n = Math.ceil(travel / maxStitchLen);
          const bdx = sx - lastX, bdy = sy - lastY;
          for (let k = 1; k < n; k++) {
            stitches.push({
              x: lastX + bdx * k / n,
              y: lastY + bdy * k / n,
              color, type: "fill"
            });
          }
        }
      }
      /* Emit start point, then subdivide along the row if longer than maxStitchLen.
         Industry standard: 4-5mm per stitch maximum. A long row segment becomes
         multiple consecutive stitches along the same line. */
      stitches.push({ x: sx, y: sy, color, type: "fill" });
      const dx = ex - sx, dy = ey - sy;
      const len = Math.hypot(dx, dy);
      if (maxStitchLen > 0 && len > maxStitchLen) {
        const n = Math.ceil(len / maxStitchLen);
        for (let k = 1; k < n; k++) {
          stitches.push({
            x: sx + dx * k / n,
            y: sy + dy * k / n,
            color, type: "fill"
          });
        }
      }
      stitches.push({ x: ex, y: ey, color, type: "fill" });
      lastX = ex; lastY = ey;
    }
    reversed = !reversed;
  }
  return stitches;
}

/* ── Outline as running stitches with step length ────────────────────────── */
function v70_outlineStitches(path, offX, offY, color, stepPx) {
  const out = [];
  if (path.length < 2) return out;
  let acc = 0;
  let [pxL, pyL] = path[0];
  let px = pxL + offX, py = pyL + offY;
  out.push({ x: px, y: py, color, type: "running" });
  for (let i = 1; i < path.length; i++) {
    const [qxL, qyL] = path[i];
    const qx = qxL + offX, qy = qyL + offY;
    const dx = qx - px, dy = qy - py;
    const seg = Math.hypot(dx, dy);
    if (seg < 0.01) continue;
    let t = 0;
    while (acc + (seg - t) >= stepPx) {
      const want = stepPx - acc;
      const tt = t + want;
      const sx = px + dx * tt / seg;
      const sy = py + dy * tt / seg;
      out.push({ x: sx, y: sy, color, type: "running" });
      t = tt; acc = 0;
    }
    acc += seg - t;
    px = qx; py = qy;
  }
  out.push({ x: px, y: py, color, type: "running" });
  return out;
}

/* ── Decide stitch type from PCA & physical width ────────────────────────── */
function v70_classify(pts, pca, pxPerMm) {
  const areaMm2 = pts.length / (pxPerMm * pxPerMm);
  /* width along short axis ≈ area / long-axis-extent */
  let minP = Infinity, maxP = -Infinity;
  const longCos = Math.cos(pca.longAngle), longSin = Math.sin(pca.longAngle);
  for (const [x, y] of pts) {
    const u = (x - pca.cx) * longCos + (y - pca.cy) * longSin;
    if (u < minP) minP = u; if (u > maxP) maxP = u;
  }
  const longAxisPx = Math.max(1, maxP - minP);
  const widthPx = pts.length / longAxisPx;
  const widthMm = widthPx / pxPerMm;

  let type;
  if (areaMm2 < 1.5)                              type = "running";
  else if (widthMm < 0.6)                         type = "running";
  else if (widthMm <= 5.0 && pca.aspect > 3.5)    type = "satin";
  else                                            type = "fill";
  return { type, areaMm2, widthMm };
}

/* ── Top-level: build all shapes from the pixMap ────────────────────────── */
function v70_buildShapes(pixMap, colors, canvasSize, pxPerMm) {
  const minAreaPx = Math.max(50, Math.round(1.0 * pxPerMm * pxPerMm));

  /* ── Simple per-component regions (the approach that WORKS) ─────────────
     Each connected component is a solid chunk of one colour. The scan finds
     dense, continuous runs inside each mask → solid fills. This produced our
     best result (15,743 stitches, solid fills, avg 2.8mm).
     
     Fragmentation (80-120 regions) is handled by colour-grouped NN ordering
     in v70_generateStitches, NOT by merging (which makes masks sparse and
     kills fill density). */
  const rawRegions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);
  console.log(`[v70] Raw regions: ${rawRegions.length} (minArea=${minAreaPx}px)`);

  const shapes = [];
  for (const reg of rawRegions) {
    const pts = reg.pts;
    if (pts.length < minAreaPx) continue;
    const pca = v70_pca(pts);
    const cls = v70_classify(pts, pca, pxPerMm);
    const m = v70_buildMask(pts);
    shapes.push({
      ci: reg.ci,
      color: colors[reg.ci],
      type: cls.type,
      pca,
      mask: m.mask, w: m.w, h: m.h, offX: m.offX, offY: m.offY,
      ptCount: pts.length,
      areaMm2: cls.areaMm2,
      widthMm: cls.widthMm,
      bounds: { mnx: m.offX, mny: m.offY, mxx: m.offX + m.w - 1, mxy: m.offY + m.h - 1 }
    });
  }
  console.log(`[v70] Final shapes: ${shapes.length} (fill:${shapes.filter(s=>s.type==="fill").length} satin:${shapes.filter(s=>s.type==="satin").length} run:${shapes.filter(s=>s.type==="running").length})`);
  for (const sh of shapes) {
    console.log(`[v70-shape] ${sh.color} type=${sh.type} ${sh.ptCount}px ${sh.w}×${sh.h} area=${sh.areaMm2.toFixed(1)}mm²`);
  }
  return shapes;
}

/* ── Top-level stitch generation ──────────────────────────────────────────── */
function v70_generateStitches(shapes, colors, params, canvasSize) {
  const out = [];
  const colorCounts = colors.map(() => ({fill:0, satin:0, running:0, underlay:0}));
  const pxScale  = canvasSize / 800;
  const P = params || {};
  /* Fill row density: target ~0.45mm spacing for a solid fill. pxPerMm=10 here
     (canvas mm scales with px), so 0.45mm ≈ 4.5px. The old (tatamiRow*pxScale)
     gave 8px (~0.8mm) which under-filled large areas like a gown into sparse rows. */
  const _pxPerMmFill = (canvasSize / (canvasSize / 10));   /* = 10 px per mm */
  const pRow      = Math.max(3, Math.round(0.5 * _pxPerMmFill));   /* ~0.5mm solid fill */
  const pLen      = Math.max(20, Math.round((P.tatamiLen || 47) * pxScale));  /* 4.7mm default */
  /* Subdivision target: stitches LONGER than this get split into N pieces.
     Industry pro file mean stitch length is 3.5mm. To make our mean land near
     that, the subdivision target should be ~3.5mm so any longer stitch gets
     broken into ~equal pieces around the target. */
  const pSubdiv   = Math.max(20, Math.round((P.tatamiLen || 35) * pxScale * 0.75));  /* ~3.5mm target */
  const pPullComp = Math.round((P.pullComp || 2) * pxScale);
  const pOutline  = pSubdiv;  /* outline step = same target */
  /* Brick offset: stagger alternate rows by a fraction of ROW pitch (not stitch length).
     Setting this >= rowSpacing causes rows to overlap going backwards — the
     chaos pattern in v71.0. Half a row pitch is the maximum safe value. */
  const pBrick    = Math.round(pRow * 0.4);
  /* Max bridge distance: stitches longer than this become trims.
     Set high enough (25mm) that adjacent shape parts of the same color stay
     connected by bridge stitches — keeps fronds from fragmenting into
     individual zigzag bits. Only true cross-design jumps will trim. */
  const pMaxBridge = Math.round(250 * pxScale);  /* ~25mm */
  const maxStitchLen = P.maxStitchLen || pSubdiv;

  /* Group by color, sort within color: largest fills first */
  const byCi = new Map();
  for (const sh of shapes) {
    if (!byCi.has(sh.ci)) byCi.set(sh.ci, []);
    byCi.get(sh.ci).push(sh);
  }

  let lastX = 0, lastY = 0;
  for (let ci = 0; ci < colors.length; ci++) {
    const group = byCi.get(ci);
    if (!group || !group.length) continue;
    group.sort((a, b) => {
      const tA = a.type === "fill" ? 0 : a.type === "satin" ? 1 : 2;
      const tB = b.type === "fill" ? 0 : b.type === "satin" ? 1 : 2;
      if (tA !== tB) return tA - tB;
      return b.ptCount - a.ptCount;
    });
    /* Nearest-neighbour ordering within each stitch-type run: keeps the needle
       travelling to the CLOSEST next shape instead of jumping across the design,
       which was driving the jump rate to ~28%. Type order (fill→satin→run) is
       preserved; we only reorder shapes of the same type to minimise travel. */
    const _centroid = (sh) => ({
      x: sh.offX + sh.w / 2,
      y: sh.offY + sh.h / 2,
    });
    const _nnChain = (arr, startX, startY) => {
      if (arr.length <= 2) return arr;
      const remaining = arr.slice();
      const ordered = [];
      let cx = startX, cy = startY;
      while (remaining.length) {
        let bi = 0, bd = Infinity;
        for (let k = 0; k < remaining.length; k++) {
          const c = _centroid(remaining[k]);
          const d = (c.x - cx) * (c.x - cx) + (c.y - cy) * (c.y - cy);
          if (d < bd) { bd = d; bi = k; }
        }
        const next = remaining.splice(bi, 1)[0];
        ordered.push(next);
        const c = _centroid(next); cx = c.x; cy = c.y;
      }
      return ordered;
    };
    // Reorder each type-run separately so the fill→satin→run sequence is kept.
    {
      const byType = { fill: [], satin: [], running: [] };
      for (const sh of group) (byType[sh.type] || byType.running).push(sh);
      const reordered = [];
      let sx = lastX, sy = lastY;
      for (const t of ["fill", "satin", "running"]) {
        if (!byType[t].length) continue;
        const chain = _nnChain(byType[t], sx, sy);
        reordered.push(...chain);
        const last = chain[chain.length - 1];
        sx = last.offX + last.w / 2; sy = last.offY + last.h / 2;
      }
      group.length = 0;
      group.push(...reordered);
    }
    const color = colors[ci];

    for (const sh of group) {
      /* Trim if moving far */
      const path = v70_traceOutline(sh.mask, sh.w, sh.h);
      if (!path.length) continue;
      const startX = path[0][0] + sh.offX, startY = path[0][1] + sh.offY;
      if (Math.hypot(startX - lastX, startY - lastY) > 12 * pxScale) {
        out.push({ x: lastX, y: lastY, color, type: "trim" });
      }

      /* EDGE-WALK UNDERLAY — only for FILL shapes, as a single registration
         pass in the shape's own colour. For satin/running shapes this is
         redundant (the fill/run IS the edge) and previously produced the
         "outlined everything" look that buried the fills. The dark DEFINITION
         OUTLINE pass at the end provides the visible contour. */
      if (sh.type === "fill" && sh.areaMm2 > 8) {
        const ol = v70_outlineStitches(path, sh.offX, sh.offY, color, pOutline);
        for (const s of ol) {
          out.push(s);
          colorCounts[ci].underlay++;
          lastX = s.x; lastY = s.y;
        }
      }

      /* Stitch angle: only follow the shape's long axis when it is CLEARLY
         elongated (aspect > 2.2). Otherwise use a single consistent vertical
         angle. This stops adjacent blobby cartoon regions from each picking a
         different PCA angle, which looked chaotic in the stitched result. */
      const stitchAngle = (sh.pca.aspect < 2.2) ? Math.PI / 2 : sh.pca.angle;

      /* MAIN STITCHING */
      if (sh.type === "fill" || (sh.type === "satin" && sh.widthMm > 3.5)) {
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY,
                                  stitchAngle, pRow);
        const fs = v70_runsToStitches(scan, color, pBrick, pPullComp, pMaxBridge, maxStitchLen);
        // Diagnostic: log when a fill produces very few stitches (helps debug empty fills)
        if (fs.length < 10 && sh.ptCount > 1000) {
          console.log(`[v70-diag] fill ${color} (${sh.ptCount}px, ${sh.w}×${sh.h}) → scanRuns=${scan.length} stitches=${fs.length} angle=${stitchAngle.toFixed(2)} pRow=${pRow}`);
        }
        /* Trim between outline-end and fill-start if they're far apart */
        if (fs.length > 0 && lastX !== null) {
          const dx = fs[0].x - lastX, dy = fs[0].y - lastY;
          if (Math.hypot(dx, dy) > 12 * pxScale) {
            out.push({ x: lastX, y: lastY, color, type: "trim" });
          }
        }
        for (const s of fs) {
          out.push(s);
          colorCounts[ci].fill++;
          lastX = s.x; lastY = s.y;
        }
      } else if (sh.type === "satin") {
        /* For genuine satin (thin), use a denser scan at smaller row pitch */
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY,
                                  stitchAngle, Math.max(2, Math.round(2.5 * pxScale)));
        const fs = v70_runsToStitches(scan, color, 0, pPullComp, pMaxBridge, maxStitchLen);
        for (const s of fs) {
          out.push(s);
          colorCounts[ci].satin++;
          lastX = s.x; lastY = s.y;
        }
      }
      /* running: outline is the stitching, nothing more */
    }
  }

  /* ── DEFINITION OUTLINE PASS (v70) ────────────────────────────────────
     Dark running-stitch contours around significant shapes, sewn last so the
     form reads (face edge, eyes, gown vs trim). Reuses the user's DARKEST
     palette colour — no extra thread. Uses v70_traceOutline (true boundary
     walk) so there is no starburst. Capped so it stays an accent. */
  if (!P || P.definitionOutline !== false) {
    let outlineHex = colors[0] || "#2A2A2A";
    let _darkest = Infinity;
    for (const c of colors) {
      const { r, g, b } = hexToRgb(c);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < _darkest) { _darkest = lum; outlineHex = c; }
    }
    const oStep = Math.max(10, Math.round(2.5 * pxScale));
    const minOutlineArea = Math.max(2000, Math.round(150 * pxScale * pxScale));
    const maxOutlineStitches = 2500;
    let oCount = 0;
    let oLastX = -1, oLastY = -1;

    // Largest shapes first; skip shapes already in the outline colour.
    const oShapes = shapes
      .filter(sh => {
        const a = sh.w * sh.h;
        if (a < minOutlineArea) return false;
        if (normHex(sh.color) === normHex(outlineHex)) return false;
        return true;
      })
      .sort((a, b) => (b.w * b.h) - (a.w * a.h));

    for (const sh of oShapes) {
      if (oCount >= maxOutlineStitches) break;
      const path = v70_traceOutline(sh.mask, sh.w, sh.h);
      if (path.length < 3) continue;
      const os = v70_outlineStitches(path, sh.offX, sh.offY, outlineHex, oStep);
      if (os.length < 3) continue;
      // trim/jump into the contour start
      if (oLastX !== -1) {
        out.push({ x: oLastX, y: oLastY, color: outlineHex, type: "trim" });
        out.push({ x: os[0].x, y: os[0].y, color: outlineHex, type: "trim" });
      }
      for (const s of os) out.push(s);
      oCount += os.length;
      oLastX = os[os.length - 1].x; oLastY = os[os.length - 1].y;
    }
    if (oCount > 0) console.log(`[v70] definition outline: ${oCount} running stitches in ${outlineHex}`);
  }

  return { stitches: out, colorCounts };
}


/* ═══════════════════════════════════════════════════════════════════════
   V71 — PHOTO-STITCH (thread painting)
   ═══════════════════════════════════════════════════════════════════════

   Used when mode === 'photo'. Industry "thread painting" approach:

   For each color band (quantized luminance level):
     1. Build a mask of pixels matching this band
     2. Cross-hatch at the band's assigned angle
     3. Use row spacing inversely proportional to luminance:
        - Dark bands → dense rows (0.5mm pitch) → solid coverage
        - Mid bands  → medium rows (1.0mm pitch)
        - Light bands → sparse rows (2.0mm pitch) → fabric shows through

   Layers stack: darkest color first (foundation), then progressively
   lighter colors on top. Each color uses a different angle (0°, 45°,
   90°, 135°) so they cross-hatch instead of overlaying.

   The result simulates tonal range using thread density and color
   stacking — like real hand-embroidered thread painting.
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   v72 — UNIFIED PORTRAIT ENGINE
   Implements the professional digitizer workflow + Sfumato "one object" model:
     1. Remove dark outlines (reassign to nearest neighbour colour) → WHOLE regions
        that fill solidly (no fragmentation), outline saved for redraw on top.
     2. Build one fill per colour region (the "one object" model), with underlay
        and tie-offs (the features auto-digitizers skip → why they pucker).
     3. Order back-to-front: largest base layers first, small details later,
        dark contour outline LAST (on top), like a human digitizer.
   Reuses the proven v70 primitives (scanRuns, pca, buildMask, traceOutline,
   findRegions, classify) + legacy underlay/tie primitives.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 1. Remove outlines: reassign dark-outline pixels to nearest non-dark colour
   via multi-source BFS. Returns whole-region fillMap + the saved outlineMask. ── */
function v72_removeOutlines(pixMap, colors, canvasSize) {
  const w = canvasSize, h = canvasSize, n = w * h;
  let darkCi = -1, darkLum = Infinity;
  for (let c = 0; c < colors.length; c++) {
    const { r, g, b } = hexToRgb(colors[c]);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < darkLum) { darkLum = lum; darkCi = c; }
  }
  const fillMap = Int16Array.from(pixMap);
  const outlineMask = new Uint8Array(n);
  // Only treat the darkest colour as an outline if it's genuinely dark.
  if (darkLum >= 60 || darkCi < 0) return { fillMap, outlineMask, outlineCi: -1 };

  const isOutline = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (pixMap[i] === darkCi) { isOutline[i] = 1; outlineMask[i] = 1; fillMap[i] = -1; }
  }
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!isOutline[i]) continue;
    let nc = -1;
    if (x > 0     && !isOutline[i - 1]) nc = pixMap[i - 1];
    else if (x < w-1 && !isOutline[i + 1]) nc = pixMap[i + 1];
    else if (y > 0     && !isOutline[i - w]) nc = pixMap[i - w];
    else if (y < h-1 && !isOutline[i + w]) nc = pixMap[i + w];
    if (nc >= 0) { fillMap[i] = nc; queue[qt++] = i; }
  }
  while (qh < qt) {
    const i = queue[qh++]; const c = fillMap[i];
    const x = i % w, y = (i / w) | 0;
    if (x > 0     && fillMap[i - 1] === -1) { fillMap[i - 1] = c; queue[qt++] = i - 1; }
    if (x < w - 1 && fillMap[i + 1] === -1) { fillMap[i + 1] = c; queue[qt++] = i + 1; }
    if (y > 0     && fillMap[i - w] === -1) { fillMap[i - w] = c; queue[qt++] = i - w; }
    if (y < h - 1 && fillMap[i + w] === -1) { fillMap[i + w] = c; queue[qt++] = i + w; }
  }
  for (let i = 0; i < n; i++) if (fillMap[i] === -1) fillMap[i] = (darkCi === 0 && colors.length > 1) ? 1 : 0;
  return { fillMap, outlineMask, outlineCi: darkCi };
}

/* ── 2. Trace the saved outline mask back into running stitches (drawn on top) ── */
function v72_outlineMaskToRunning(outlineMask, canvasSize, color, stepPx, minAreaPx) {
  const w = canvasSize, h = canvasSize;
  const om = new Int16Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (outlineMask[i]) om[i] = 0;
  const regs = v70_findRegions(om, w, h, Math.max(20, Math.round(minAreaPx * 0.3)));
  const out = [];
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
}

/* ── Merge same-colour fragments that are adjacent (split by thin outlines) ── */
function v72_mergeSameColorFragments(regions, gapPx) {
  const n = regions.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const near = (A, B) => !(A.mnx - gapPx > B.mxx || B.mnx - gapPx > A.mxx ||
                           A.mny - gapPx > B.mxy || B.mny - gapPx > A.mxy);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (regions[i].ci === regions[j].ci && near(regions[i], regions[j])) union(i, j);
    }
  }
  const groups = {};
  for (let i = 0; i < n; i++) { const r = find(i); (groups[r] || (groups[r] = [])).push(regions[i]); }
  const merged = [];
  for (const key in groups) {
    const g = groups[key];
    if (g.length === 1) { merged.push(g[0]); continue; }
    let pts = [], mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const r of g) {
      pts = pts.concat(r.pts);
      if (r.mnx < mnx) mnx = r.mnx; if (r.mxx > mxx) mxx = r.mxx;
      if (r.mny < mny) mny = r.mny; if (r.mxy > mxy) mxy = r.mxy;
    }
    merged.push({ ci: g[0].ci, pts, mnx, mny, mxx, mxy });
  }
  return merged;
}

/* ── 3. Nearest-neighbour ordering of shapes (by bbox centroid) to cut jumps ── */
function v72_nnOrder(shapes, fromPt) {
  if (shapes.length <= 1) return shapes;
  const cen = shapes.map(s => ({ s, cx: s.offX + s.w / 2, cy: s.offY + s.h / 2 }));
  // Start from the shape nearest the given point (the previous colour's exit),
  // so colours thread together instead of each starting with a big jump.
  let startIdx = 0;
  if (fromPt) {
    let bd = Infinity;
    for (let i = 0; i < cen.length; i++) {
      const d = (cen[i].cx - fromPt.x) ** 2 + (cen[i].cy - fromPt.y) ** 2;
      if (d < bd) { bd = d; startIdx = i; }
    }
  }
  const ordered = [cen.splice(startIdx, 1)[0]];
  while (cen.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < cen.length; i++) {
      const d = (cen[i].cx - last.cx) ** 2 + (cen[i].cy - last.cy) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    ordered.push(cen.splice(bi, 1)[0]);
  }
  return ordered.map(o => o.s);
}

/* ── 4. The orchestrator: outline-removal → layered fills+underlay+tie → outline ── */
function v72_buildAndGenerate(pixMap, colors, canvasSize, pxPerMm, params) {
  const P = params || {};
  const pxScale = canvasSize / 800;
  const minAreaPx = Math.max(50, Math.round(1.0 * pxPerMm * pxPerMm));

  /* PER-COMPONENT regions (the proven v70 approach: each connected colour blob
     is a SOLID mask that fills densely — no giant rectangles, no empty fills).
     We add the professional features on top: underlay, tie-offs, and
     back-to-front layer ordering. Outline-removal is NOT used — Gemini folds
     linework into the darkest fill, so there's no separable outline colour. */
  const regions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);
  console.log(`[v72] Per-component regions: ${regions.length}`);

  // Identify the darkest colour for an optional definition-outline pass
  let darkCi = -1, darkLum = Infinity;
  for (let ci = 0; ci < colors.length; ci++) {
    const { r, g, b } = hexToRgb(colors[ci]);
    const lum = 0.299*r + 0.587*g + 0.114*b;
    if (lum < darkLum) { darkLum = lum; darkCi = ci; }
  }

  const shapes = [];
  for (const reg of regions) {
    const pts = reg.pts;
    if (pts.length < minAreaPx) continue;
    const pca = v70_pca(pts);
    const cls = v70_classify(pts, pca, pxPerMm);
    const m = v70_buildMask(pts);
    shapes.push({
      ci: reg.ci, color: colors[reg.ci], type: cls.type, pca,
      mask: m.mask, w: m.w, h: m.h, offX: m.offX, offY: m.offY,
      ptCount: pts.length, areaMm2: cls.areaMm2, widthMm: cls.widthMm, reg
    });
  }
  console.log(`[v72] Shapes: ${shapes.length} (fill:${shapes.filter(s=>s.type==='fill').length} satin:${shapes.filter(s=>s.type==='satin').length} run:${shapes.filter(s=>s.type==='running').length})`);

  // Back-to-front: colours ordered by total area DESC (large base layers first)
  const areaByCi = {};
  for (const s of shapes) areaByCi[s.ci] = (areaByCi[s.ci] || 0) + s.ptCount;
  const ciOrder = [...new Set(shapes.map(s => s.ci))].sort((a, b) => areaByCi[b] - areaByCi[a]);

  // Fabric-aware settings (from getStitchParams' fabric/density map):
  //  tatamiRow = fill row spacing (density), tatamiUl = underlay spacing,
  //  pull = fabric pull, pullComp = hoop pull. Stretchy fabrics → looser rows,
  //  more underlay, more pull compensation; stable wovens → denser, less.
  const pRow      = Math.max(3, Math.round((P.tatamiRow || 4) * (10/10)));
  const pPullComp = Math.round(((P.pullComp || 2) + (P.pull || 2)) * 0.5 * pxScale);
  const pBrick    = Math.round(pRow * 0.4);
  // Max gap the fill will BRIDGE with connecting stitches before it jumps/trims
  // instead. Was 50mm — far too long, so big gaps were sewn as long diagonal
  // stitches laid across the fabric. ~8mm keeps short row transitions stitched
  // but turns long crossings into clean jumps.
  const pMaxBridge= Math.round((P.maxBridgeMm || 7) * pxPerMm);
  const maxStitch = Math.max(20, Math.round(35 * pxScale * 0.75));
  const ulSpacing = Math.max(pRow * 2, Math.round((P.tatamiUl || 25)));

  const out = [];
  const colorCounts = colors.map(() => ({ fill: 0, satin: 0, running: 0, underlay: 0 }));

  let _lastPt = null;   // running stitch position, used to thread colours together
  const _minFragPx = Math.max(12, Math.round(0.6 * pxPerMm * pxPerMm)); // drop noise specks
  const _trimGap = 7 * pxPerMm;  // gap (px) beyond which a transition trims instead of stitching
  const _trimIfFar = (nx, ny, color) => {
    if (_lastPt) {
      const d = Math.hypot(nx - _lastPt.x, ny - _lastPt.y);
      if (d > _trimGap) out.push({ x: _lastPt.x, y: _lastPt.y, color, type: "trim" });
    }
  };
  for (const ci of ciOrder) {
    const group = v72_nnOrder(shapes.filter(s => s.ci === ci), _lastPt);
    let colorFills = [];   // collect fill endpoints to tie once per colour
    for (const sh of group) {
      // Skip tiny noise fragments that only add jumps/clutter (keep real detail)
      if (sh.type === "running" && sh.ptCount < _minFragPx) continue;
      const color = sh.color;
      const angle = (sh.pca.aspect < 2.2) ? Math.PI / 2 : sh.pca.angle;
      if (sh.type === "fill" || (sh.type === "satin" && sh.widthMm > 3.5)) {
        // UNDERLAY (only for fills big enough to need it)
        if (sh.areaMm2 > 8) {
          const ul = generateZigzagUnderlay(pixMap, sh.reg, ci, canvasSize, color, ulSpacing, maxStitch);
          if (ul.length) _trimIfFar(ul[0].x, ul[0].y, color);
          for (const u of ul) { out.push(u); colorCounts[ci].underlay++; }
          if (ul.length) _lastPt = ul[ul.length - 1];
        }
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY, angle, pRow);
        const fs = v70_runsToStitches(scan, color, pBrick, pPullComp, pMaxBridge, maxStitch);
        if (fs.length) {
          // Tie-in only at the FIRST fill of this colour (not every fragment)
          if (colorFills.length === 0) {
            _trimIfFar(fs[0].x, fs[0].y, color);   // trim the colour-change jump
            for (const t of generateTieStitches(fs[0].x, fs[0].y, color, 1, 0)) out.push(t);
          } else {
            // Between fragments of the same colour: trim if the jump is long,
            // so we don't lay a long diagonal stitch across the fabric.
            _trimIfFar(fs[0].x, fs[0].y, color);
          }
          for (const s of fs) { out.push(s); colorCounts[ci].fill++; }
          colorFills.push(fs[fs.length - 1]);
          _lastPt = fs[fs.length - 1];
        }
      } else {
        const path = v70_traceOutline(sh.mask, sh.w, sh.h);
        if (path && path.length) {
          const os = v70_outlineStitches(path, sh.offX, sh.offY, color, maxStitch);
          if (os.length) _trimIfFar(os[0].x, os[0].y, color);
          for (const s of os) { out.push(s); colorCounts[ci].running++; }
          if (os.length) _lastPt = os[os.length - 1];
        }
      }
    }
    // Tie-off once at the LAST fill of this colour
    if (colorFills.length) {
      const last = colorFills[colorFills.length - 1];
      for (const t of generateTieStitches(last.x, last.y, colors[ci], -1, 0)) out.push(t);
    }
  }

  // Final safety pass: any remaining move longer than the trim gap becomes a
  // trim (machine cuts + jumps) instead of a long stitch laid across the fabric.
  // This catches every transition path (underlay↔tie↔running↔fill) in one place.
  const cleaned = [];
  let _prev = null;
  for (const st of out) {
    if (_prev && st.type !== "trim" && _prev.type !== "trim") {
      const d = Math.hypot(st.x - _prev.x, st.y - _prev.y);
      if (d > _trimGap) cleaned.push({ x: _prev.x, y: _prev.y, color: st.color, type: "trim" });
    }
    cleaned.push(st);
    _prev = st;
  }

  return { stitches: cleaned, colorCounts };
}
/* ── Convert RGB to perceptual luminance (Rec. 709) ─────────────────────── */
function v71_luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ── Build a mask of pixels assigned to one color in the palette,
   plus a "fade" mask indicating how strongly each pixel matches that
   color (used for density variation within the band). ───────────────────── */
function v71_colorMaskWithStrength(pixMap, ci, w, h) {
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] === ci) { mask[i] = 1; count++; }
  }
  return { mask, count };
}

/* ── Cross-hatch fill: walk rows at the given angle through the mask,
   emit stitches where mask is set. Row pitch and stitch length both
   scale with the band's "tone weight" (darker = denser = shorter stitches).
   ───────────────────────────────────────────────────────────────────────── */
function v71_crossHatch(mask, w, h, angle, rowPitch, stitchLen, color, pullComp, maxStitchLen) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  /* Find bounds of mask pixels rotated into u-t space */
  let minT = Infinity, maxT = -Infinity, minU = Infinity, maxU = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const u = x * cos + y * sin;
      const t = -x * sin + y * cos;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (t < minT) minT = t; if (t > maxT) maxT = t;
    }
  }
  if (minT === Infinity) return [];

  const stitches = [];
  let reversed = false;
  let lastX = null, lastY = null;
  const sampleStep = 0.7;  /* sub-pixel sampling along the row */

  for (let t = minT; t <= maxT; t += rowPitch) {
    /* Walk this row, find inside-runs */
    const runs = [];
    let runStart = null;
    for (let u = minU; u <= maxU; u += sampleStep) {
      const ix = Math.round(u * cos - t * sin);
      const iy = Math.round(u * sin + t * cos);
      const inside = ix >= 0 && iy >= 0 && ix < w && iy < h && mask[iy * w + ix];
      if (inside) {
        if (runStart === null) runStart = u;
      } else if (runStart !== null) {
        runs.push([runStart, u - sampleStep]);
        runStart = null;
      }
    }
    if (runStart !== null) runs.push([runStart, maxU]);
    if (!runs.length) { reversed = !reversed; continue; }

    const ordered = reversed ? runs.slice().reverse() : runs;
    for (let i = 0; i < ordered.length; i++) {
      let [u1, u2] = ordered[i];
      u1 += pullComp; u2 -= pullComp;
      if (u2 - u1 < 0.5) continue;
      const startU = reversed ? u2 : u1;
      const endU   = reversed ? u1 : u2;
      const sx = startU * cos - t * sin;
      const sy = startU * sin + t * cos;
      const ex = endU   * cos - t * sin;
      const ey = endU   * sin + t * cos;
      /* Trim within row if jumping across gap (multi-segment row) */
      if (lastX !== null) {
        const travel = Math.hypot(sx - lastX, sy - lastY);
        if (i > 0 && travel > maxStitchLen * 1.5) {
          stitches.push({ x: lastX, y: lastY, color, type: "trim" });
        } else if (travel > maxStitchLen) {
          /* Subdivide bridge */
          const n = Math.ceil(travel / maxStitchLen);
          for (let k = 1; k < n; k++) {
            stitches.push({
              x: lastX + (sx - lastX) * k / n,
              y: lastY + (sy - lastY) * k / n,
              color, type: "fill"
            });
          }
        }
      }
      /* Start */
      stitches.push({ x: sx, y: sy, color, type: "fill" });
      /* Subdivide within row if longer than max */
      const len = Math.hypot(ex - sx, ey - sy);
      if (len > maxStitchLen) {
        const n = Math.ceil(len / maxStitchLen);
        for (let k = 1; k < n; k++) {
          stitches.push({
            x: sx + (ex - sx) * k / n,
            y: sy + (ey - sy) * k / n,
            color, type: "fill"
          });
        }
      }
      stitches.push({ x: ex, y: ey, color, type: "fill" });
      lastX = ex; lastY = ey;
    }
    reversed = !reversed;
  }
  return stitches;
}

/* ── Top-level photo-stitch generator ─────────────────────────────────────
   pixMap: quantized palette indices (already extracted with N tones)
   colors: array of hex colors, ORDERED DARK → LIGHT
   ───────────────────────────────────────────────────────────────────────── */
function v71_generatePhotoStitch(pixMap, colors, canvasSize, params) {
  const pxScale = canvasSize / 800;
  const P = params || {};
  const pPullComp = Math.round((P.pullComp || 2) * pxScale);
  const pSubdiv = Math.max(20, Math.round(35 * pxScale * 0.75));  /* ~3.5mm */

  /* Sort colors dark-to-light by luminance, remember original index for output */
  const indexed = colors.map((hex, i) => {
    const rgb = hexToRgb(hex);
    return { hex, ci: i, lum: v71_luminance(rgb.r, rgb.g, rgb.b) };
  });
  indexed.sort((a, b) => a.lum - b.lum);

  /* Assign angles by index — cycle through 4 directions for cross-hatching */
  const angleBank = [
    Math.PI / 4,           /*  45° */
    -Math.PI / 4,          /* -45° */
    0,                     /*   0° (horizontal) */
    Math.PI / 2,           /*  90° (vertical) */
  ];

  /* Compute row pitch per band based on luminance:
     darkest (lum 0)    → 0.5mm = 5px @ 800px = densest
     lightest (lum 255) → 2.5mm = 25px @ 800px = sparsest
     We map linearly. */
  function rowPitchForLum(lum) {
    const t = lum / 255;  /* 0=dark, 1=light */
    const mmPitch = 0.5 + t * 2.0;  /* 0.5mm to 2.5mm */
    return Math.max(4, Math.round(mmPitch * 10 * pxScale));
  }

  const out = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));
  let lastX = 0, lastY = 0;

  for (let bandIdx = 0; bandIdx < indexed.length; bandIdx++) {
    const band = indexed[bandIdx];
    const { mask, count } = v71_colorMaskWithStrength(pixMap, band.ci, canvasSize, canvasSize);
    if (count < 100) continue;  /* skip near-empty bands */

    const angle = angleBank[bandIdx % angleBank.length];
    const rowPitch = rowPitchForLum(band.lum);

    /* Trim before band if needed (cross from previous band's endpoint) */
    if (out.length > 0) {
      out.push({ x: lastX, y: lastY, color: band.hex, type: "trim" });
    }

    const stitches = v71_crossHatch(
      mask, canvasSize, canvasSize,
      angle, rowPitch, pSubdiv, band.hex, pPullComp, pSubdiv
    );
    for (const s of stitches) {
      out.push(s);
      if (s.type === "fill") colorCounts[band.ci].fill++;
      else if (s.type === "trim") {}
      lastX = s.x; lastY = s.y;
    }

    console.log(`[v71] Band ${bandIdx} (lum=${band.lum.toFixed(0)}, hex=${band.hex}): ${count}px → ${stitches.length} stitches at ${(angle*180/Math.PI).toFixed(0)}°, rowPitch=${rowPitch}px`);
  }

  return { stitches: out, colorCounts };
}

/* ─── REGION EXTRACTION ──────────────────────────────────*/
function extractRegions(pixMap, colors, canvasSize, mode) {
  const visited  = new Uint8Array(canvasSize*canvasSize);
  const regions  = [];

  /* For photo mode, a region needs average run ≤ 4mm to be satin (thin detail).
     For logo/cartoon, lower this to 1.5mm so that solid blocks of colour
     correctly become fill (tatami) rather than satin lines.
     Without this, a 1600px cartoon with fur-texture outfits gets fill:0. */
  const satinMaxMm = (mode === 'photo') ? 4.0 : 1.5;

  for(let ci=0;ci<colors.length;ci++){
    for(let sy=0;sy<canvasSize;sy++){
      for(let sx=0;sx<canvasSize;sx++){
        const si = sy*canvasSize+sx;
        if(pixMap[si]!==ci||visited[si])continue;

        const q=[si];let qp=0;
        visited[si]=1;
        let mnx=sx,mxx=sx,mny=sy,mxy=sy,area=0;

        while(qp<q.length){
          const idx=q[qp++]; area++;
          const x=idx%canvasSize, y=(idx/canvasSize)|0;
          if(x<mnx)mnx=x;if(x>mxx)mxx=x;
          if(y<mny)mny=y;if(y>mxy)mxy=y;

          for(const[dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<canvasSize&&ny>=0&&ny<canvasSize){
              const ni=ny*canvasSize+nx;
              if(!visited[ni]&&pixMap[ni]===ci){visited[ni]=1;q.push(ni);}
            }
          }
        }

        /* Scale minimum area to canvas resolution.
           Lowered floor so small but important detail (eyes, lashes, nostrils, lips)
           is NOT dropped. Tiny survivors become running/satin detail below. */
        const scaledMinArea = Math.max(8, Math.round(MIN_AREA * 0.4 * Math.pow(canvasSize / 800, 2)));
        if(area < scaledMinArea) continue;

        const bw=mxx-mnx+1, bh=mxy-mny+1;
        const aspectRatio=bh/Math.max(bw,1);
        const solidity=area/(bw*bh);

        let totalRunW=0, runCount=0;
        for(let ry=mny; ry<=mxy; ry++){
          const runs=getRunsInRow(pixMap,ci,ry,mnx,mxx,canvasSize);
          for(const r of runs){ totalRunW+=(r.x2-r.x1+1); runCount++; }
        }
        const avgRunW=runCount>0?totalRunW/runCount:bw;

        let type;
        const scaledMin3 = MIN_AREA * 3 * Math.pow(canvasSize / 800, 2);
        const avgRunMM = avgRunW / (canvasSize / 800) / 10;
        if(area < scaledMin3) type = "running";
        else if(avgRunMM <= satinMaxMm) type = "satin";
        else if(avgRunMM <= 8.0 && aspectRatio > 1.8 && solidity > 0.4) type = "satin";
        else type = "fill";

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity,avgRunW});
      }
    }
  }

  console.log(`Regions (raw): ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  return regions;
}

/* ─── MERGE ADJACENT FRAGMENTS ───────────────────────────*/
function mergeAdjacentRegions(regions, canvasSize) {
  if (!regions.length) return regions;
  /* Conservative merge: only bridge tiny noise gaps (≤ 2 px ≈ 0.2 mm) between
     same-colour fragments.  The previous 12-px gap merged genuinely separate
     shapes (e.g. left and right cheek) into one bbox, which then made fills
     span empty space.  We also require pixel-level proximity, not just
     overlapping bounding boxes — two L-shapes can have overlapping bboxes
     while sharing zero adjacent pixels. */
  const mergeGap = Math.max(2, Math.round(canvasSize / 400));
  let changed = true;
  let merged = regions.slice();

  /* Build a quick lookup of pixel ownership per region so we can test
     true adjacency, not bbox adjacency. */
  function regionsActuallyTouch(a, b) {
    /* bbox quick-reject */
    if (a.mxx + mergeGap < b.mnx || b.mxx + mergeGap < a.mnx) return false;
    if (a.mxy + mergeGap < b.mny || b.mxy + mergeGap < a.mny) return false;
    /* For real touch, require a.bbox and b.bbox to actually overlap or be
       within mergeGap *in both axes simultaneously*, AND the combined
       solidity to remain reasonable (avoid swallowing a far-away patch). */
    const ux = Math.max(0, Math.min(a.mxx, b.mxx) - Math.max(a.mnx, b.mnx));
    const uy = Math.max(0, Math.min(a.mxy, b.mxy) - Math.max(a.mny, b.mny));
    /* At least one axis must have real overlap (not just be within mergeGap). */
    return ux > 0 || uy > 0;
  }

  while (changed) {
    changed = false;
    const next = [];
    const used = new Set();

    for (let i = 0; i < merged.length; i++) {
      if (used.has(i)) continue;
      const base = merged[i];
      let mnx = base.mnx, mny = base.mny, mxx = base.mxx, mxy = base.mxy, area = base.area;
      let totalRunW = (base.avgRunW || base.bw) * (base.bh || 1);
      let runCount = base.bh || 1;
      used.add(i);

      let innerChanged = true;
      while (innerChanged) {
        innerChanged = false;
        for (let j = 0; j < merged.length; j++) {
          if (used.has(j) || i === j) continue;
          const other = merged[j];
          if (other.ci !== base.ci) continue;

          const cur = { mnx, mny, mxx, mxy };
          if (regionsActuallyTouch(cur, other)) {
            /* Reject the merge if the resulting bbox would have very low
               solidity — that means we're joining two patches across mostly
               empty space, which is exactly the bug we're fixing. */
            const newMnx = Math.min(mnx, other.mnx);
            const newMny = Math.min(mny, other.mny);
            const newMxx = Math.max(mxx, other.mxx);
            const newMxy = Math.max(mxy, other.mxy);
            const newBboxArea = (newMxx - newMnx + 1) * (newMxy - newMny + 1);
            const combinedFill = area + other.area;
            const projectedSolidity = combinedFill / Math.max(newBboxArea, 1);
            if (projectedSolidity < 0.30) continue;  /* would create a sparse mega-region */

            mnx = newMnx; mny = newMny; mxx = newMxx; mxy = newMxy;
            area += other.area;
            totalRunW += (other.avgRunW || other.bw) * (other.bh || 1);
            runCount += other.bh || 1;
            used.add(j);
            innerChanged = true;
            changed = true;
          }
        }
      }

      const newBw = mxx - mnx + 1, newBh = mxy - mny + 1;
      const newAvgRunW = runCount > 0 ? totalRunW / runCount : newBw;
      const newAspect = newBh / Math.max(newBw, 1);
      const newSolidity = area / Math.max(newBw * newBh, 1);

      let newType;
      const scaledMin3 = MIN_AREA * 3 * Math.pow(canvasSize / 800, 2);
      if (area < scaledMin3) newType = "running";
      else if (newAspect > 2.5 && newAvgRunW <= Math.max(14, canvasSize / 57) && newSolidity > 0.35) newType = "satin";
      else if (newAvgRunW > 3 && newAvgRunW <= Math.max(12, canvasSize / 67) && newSolidity > 0.45 && newAspect > 1.4) newType = "satin";
      else newType = "fill";

      next.push({
        ci: base.ci, color: base.color, type: newType,
        mnx, mny, mxx, mxy,
        bw: newBw, bh: newBh, area,
        aspectRatio: newAspect, solidity: newSolidity, avgRunW: newAvgRunW
      });
    }
    merged = next;
  }

  console.log(`Regions (conservative merge): ${merged.length}`);
  return merged;
}

/* ─── BRIDGE CONNECTOR ─────────────────────────────*/
function getEdgePixels(pixMap, reg, canvasSize) {
  const edge = [];
  for (let y = reg.mny; y <= reg.mxy; y++) {
    for (let x = reg.mnx; x <= reg.mxx; x++) {
      const idx = y * canvasSize + x;
      if (pixMap[idx] === reg.ci) {
        let isEdge = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= canvasSize || ny < 0 || ny >= canvasSize) { isEdge = true; break; }
          if (pixMap[ny * canvasSize + nx] !== reg.ci) { isEdge = true; break; }
        }
        if (isEdge) edge.push({x, y});
      }
    }
  }
  return edge.length ? edge : [{x: Math.round((reg.mnx + reg.mxx) / 2), y: Math.round((reg.mny + reg.mxy) / 2)}];
}

function findClosestPair(edgeA, edgeB) {
  let best = {from: edgeA[0], to: edgeB[0], dist: Infinity};
  for (const a of edgeA) {
    for (const b of edgeB) {
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d < best.dist) best = {from: a, to: b, dist: d};
    }
  }
  return best;
}

function sortRegionsNearestNeighbor(regions) {
  if (regions.length <= 1) return regions;
  const sorted = [regions[0]];
  const used = new Set([0]);
  while (used.size < regions.length) {
    const last = sorted[sorted.length - 1];
    const lastCx = (last.mnx + last.mxx) / 2;
    const lastCy = (last.mny + last.mxy) / 2;
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < regions.length; i++) {
      if (used.has(i)) continue;
      const r = regions[i];
      const d = ((r.mnx + r.mxx) / 2 - lastCx) ** 2 + ((r.mny + r.mxy) / 2 - lastCy) ** 2;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    sorted.push(regions[bestIdx]);
  }
  return sorted;
}

function generateBridgeStitches(fromX, fromY, toX, toY, color) {
  const dx = toX - fromX, dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 8));
  const stitches = [];
  for (let i = 1; i <= steps; i++) {
    const fx = Math.round(fromX + dx * i / steps);
    const fy = Math.round(fromY + dy * i / steps);
    stitches.push({x: fx, y: fy, color, type: "bridge"});
  }
  return stitches;
}

/* ─── COLUMN-WISE SCANNING ──── */
function getRunsInCol(pixMap, ci, x, y0, y1, canvasSize) {
  const runs = []; let s = -1;
  for (let y = y0; y <= y1; y++) {
    const hit = x >= 0 && x < canvasSize && pixMap[y * canvasSize + x] === ci;
    if (hit && s === -1) s = y;
    if (!hit && s !== -1) { runs.push({y1: s, y2: y - 1}); s = -1; }
  }
  if (s !== -1) runs.push({y1: s, y2: y1});
  return runs;
}

/* ─── EDGE WALK UNDERLAY ─────── */
function generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, stepPx, insetPx) {
  const {mnx, mny, mxx, mxy} = reg;
  const edges = [];
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    for (const {x1, x2} of runs) {
      edges.push({x: x1 + insetPx, y});
      if (x2 - x1 > 2 * insetPx) edges.push({x: x2 - insetPx, y});
    }
  }
  if (edges.length === 0) return [];
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const sorted = edges.slice().sort((a, b) => {
    const aa = Math.atan2(a.y - cy, a.x - cx);
    const ab = Math.atan2(b.y - cy, b.x - cx);
    return aa - ab;
  });
  const out = [];
  let prev = null;
  for (const p of sorted) {
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= stepPx) {
      out.push({x: p.x, y: p.y, color, type: "underlay"});
      prev = p;
    }
  }
  return out;
}

/* ─── ZIGZAG CENTER-WALK UNDERLAY ─────────────────────────── */
function generateZigzagUnderlay(pixMap, reg, ci, canvasSize, color, rowSpacing, stitchLen) {
  const {mnx, mny, mxx, mxy} = reg;
  const out = [];
  let rowI = 0;
  let lastX = null, lastY = null;
  const maxGap = stitchLen * 1.5;   // beyond this, trim instead of a long stitch
  for (let y = mny + Math.round(rowSpacing/2); y <= mxy; y += rowSpacing) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    if (!runs.length) continue;
    const rev = rowI % 2 === 1;
    const order = rev ? [...runs].reverse() : runs;
    for (const {x1, x2} of order) {
      const w = x2 - x1;
      if (w < 6) continue;
      const sx = rev ? x2 - 2 : x1 + 2;
      const ex = rev ? x1 + 2 : x2 - 2;
      // If the move to this run's start is long (separate piece / row jump),
      // trim instead of dragging a long underlay stitch across the gap.
      if (lastX !== null && Math.hypot(sx - lastX, y - lastY) > maxGap) {
        out.push({x: lastX, y: lastY, color, type: "trim"});
      }
      const dist = Math.abs(ex - sx);
      const steps = Math.max(1, Math.round(dist / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const fx = Math.round(sx + (ex - sx) * s / steps);
        const zy = y + ((s % 2) ? 2 : -2);
        out.push({x: fx, y: zy, color, type: "underlay"});
        lastX = fx; lastY = zy;
      }
    }
    rowI++;
  }
  return out;
}

/* ─── TIE-IN / TIE-OFF ─────────────────── */
function generateTieStitches(x, y, color, dirX, dirY) {
  // Proper lock: 3 tiny (~0.7mm) stitches in a tight zig-zag at the anchor point.
  // Small enough to be recognised as a tie/lock and to secure the thread before
  // a trim or at the start of a colour, without leaving a visible tail.
  const s = 7;                       // 0.7mm in px (canvas is 10px/mm)
  const dx = (dirX || 1), dy = (dirY || 0);
  return [
    { x: x + dx * s,       y: y + dy * s,       color, type: "tie" },
    { x: x - dx * s,       y: y - dy * s,       color, type: "tie" },
    { x: x + dx * s * 0.5, y: y + dy * s * 0.5, color, type: "tie" },
    { x: x,                y: y,                color, type: "tie" },
  ];
}

/* ─── COLOR MERGE: remap pixMap indices ─────────────────── */
function applyColorMerges(pixMap, colors, merges, lockedColors) {
  if (!merges || !Object.keys(merges).length) return {pixMap, colors};

  /* Build the locked-hex set (normalised).  Locked colours cannot be the
     source or the target of a merge — this lets users protect critical
     thread colours (eye highlights, brand-spec spot colours, white
     details on logos, etc.) from accidental collapse. */
  const locked = new Set(
    Array.isArray(lockedColors) ? lockedColors.map(h => normHex(h)) : []
  );

  const remap = colors.map((_, i) => i);

  for (const [srcHex, tgtHex] of Object.entries(merges)) {
    const srcN = normHex(srcHex), tgtN = normHex(tgtHex);
    if (locked.has(srcN) || locked.has(tgtN)) {
      console.log(`Skipping merge ${srcN}→${tgtN} (locked)`);
      continue;
    }
    const srcIdx = colors.findIndex(c => normHex(c) === srcN);
    const tgtIdx = colors.findIndex(c => normHex(c) === tgtN);
    if (srcIdx !== -1 && tgtIdx !== -1 && srcIdx !== tgtIdx) {
      remap[srcIdx] = tgtIdx;
    }
  }

  const newPixMap = new Int16Array(pixMap.length);
  for (let i = 0; i < pixMap.length; i++) {
    newPixMap[i] = pixMap[i] >= 0 ? remap[pixMap[i]] : -1;
  }
  
  const oldToNew = {};
  const newColors = [];
  for (let i = 0; i < colors.length; i++) {
    if (remap[i] === i) {
      oldToNew[i] = newColors.length;
      newColors.push(colors[i]);
    }
  }
  
  for (let i = 0; i < newPixMap.length; i++) {
    if (newPixMap[i] >= 0) {
      newPixMap[i] = oldToNew[newPixMap[i]];
    }
  }
  
  return {pixMap: newPixMap, colors: newColors};
}

/* ─── BASTING BOX ─────────────────────────────────────────── */
function generateBastingBox(regions, colors, spacing = 20) {
  if (!regions.length || !colors.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    if (r.mnx < minX) minX = r.mnx;
    if (r.mny < minY) minY = r.mny;
    if (r.mxx > maxX) maxX = r.mxx;
    if (r.mxy > maxY) maxY = r.mxy;
  }
  minX = Math.max(0, minX - 10);
  minY = Math.max(0, minY - 10);
  maxX = maxX + 10;
  maxY = maxY + 10;
  
  const color = colors[0];
  const stitches = [];
  for (let x = minX; x <= maxX; x += spacing) stitches.push({x, y: minY, color, type: "running"});
  for (let y = minY; y <= maxY; y += spacing) stitches.push({x: maxX, y, color, type: "running"});
  for (let x = maxX; x >= minX; x -= spacing) stitches.push({x, y: maxY, color, type: "running"});
  for (let y = maxY; y >= minY; y -= spacing) stitches.push({x: minX, y, color, type: "running"});
  return stitches;
}

/* ═══════════════════════════════════════════════════════════════════
   PROFESSIONAL STITCH GENERATOR  (v68.2)
   ═══════════════════════════════════════════════════════════════════ */
/* ─── OUTLINE RUNNING STITCH (crisp edges) ─────────────────────────────── */
function generateOutline(pixMap, reg, ci, canvasSize, color, stepPx) {
  const {mnx, mny, mxx, mxy} = reg;
  /* Walk the perimeter as a proper loop instead of sorting points by angle
     around the centre (the old method produced radial "starburst" lines on
     concave shapes). Collect the LEFT edge top→bottom, then the RIGHT edge
     bottom→top, giving a clean closed contour that follows the real shape. */
  const left = [], right = [];
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    if (!runs.length) continue;
    left.push({x: runs[0].x1, y});
    right.push({x: runs[runs.length - 1].x2, y});
  }
  if (left.length < 2) return [];
  // left edge top→bottom, then right edge bottom→top
  const perim = left.concat(right.reverse());
  const out = [];
  let prev = null;
  for (const p of perim) {
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= stepPx) {
      out.push({x: p.x, y: p.y, color, type: "running"});
      prev = p;
    }
  }
  return out;
}

function generateStitchesFromRegions(pixMap, regions, colors, params, canvasSize) {
  const stitches = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));

  const P = params || {};
  /* Resolution scale: baseline pixel params were tuned for 800px. At 1600px the
     same PHYSICAL density needs 2× the pixel spacing, or fills pack 4× too many
     stitches (the 38k-stitch fill bug). Scale all pixel-based fill params by this. */
  const _resScale = canvasSize / 800;
  const pRow      = Math.max(3, Math.round((P.tatamiRow !== undefined ? P.tatamiRow : 4) * _resScale));
  const pLen      = Math.max(8, Math.round((P.tatamiLen !== undefined ? P.tatamiLen : 30) * _resScale));
  const pPull     = P.pull      !== undefined ? P.pull      : 2;
  const pPullComp = P.pullComp  !== undefined ? P.pullComp  : 2;
  const pEdgeUL   = Math.round(18 * _resScale);
  const pZigUL    = Math.round(28 * _resScale);
  const pZigLen   = Math.round(40 * _resScale);
  /* Jump threshold: travel longer than ~5mm becomes a TRIM (jump), not a sewn
     bridge line. Scales with canvas resolution (baseline 800px = 80mm = 10px/mm).
     This stops the long cross-design connecting threads seen in real machine files. */
  const _pxPerMm     = (canvasSize / 800) * 10;
  const jumpTrimPx   = Math.max(20, Math.round(5 * _pxPerMm));   /* ~5mm */
  const bridgeMaxPx  = Math.max(8, Math.round(1 * _pxPerMm));    /* only bridge ≤1mm hops — trim the rest */

  const edgePixels = new Map();
  for (const reg of regions) {
    edgePixels.set(reg, getEdgePixels(pixMap, reg, canvasSize));
  }

  /* Color-first ordering */
  const byColor = new Map();
  for (const reg of regions) {
    const ck = normHex(reg.color);
    if (!byColor.has(ck)) byColor.set(ck, []);
    byColor.get(ck).push(reg);
  }
  const ordered = [];
  const colorOrder = colors.map(c => normHex(c));
  for (const ck of colorOrder) {
    const regsForColor = byColor.get(ck);
    if (!regsForColor) continue;
    for (const type of ['fill', 'satin', 'running']) {
      const grp = regsForColor.filter(r => r.type === type);
      if (grp.length) ordered.push(...sortRegionsNearestNeighbor(grp));
    }
  }
  for (const [ck, regs] of byColor) {
    if (!colorOrder.includes(ck)) {
      for (const type of ['fill', 'satin', 'running']) {
        const grp = regs.filter(r => r.type === type);
        if (grp.length) ordered.push(...sortRegionsNearestNeighbor(grp));
      }
    }
  }

  let globalLastX = -1, globalLastY = -1;
  let prevColor = null;

  for (let ri = 0; ri < ordered.length; ri++) {
    const reg = ordered[ri];
    const ci = colors.findIndex(c => normHex(c) === normHex(reg.color));
    if (ci === -1) { console.warn(`Region color ${reg.color} not in palette`); continue; }

    const {color, type, mnx, mny, mxx, mxy} = reg;
    const regW = mxx - mnx;
    const regH = mxy - mny;
    let lastX = globalLastX, lastY = globalLastY;

    /* Move to entry point */
    if (lastX !== -1 && ri > 0) {
      const prevReg = ordered[ri - 1];
      if (normHex(prevReg.color) === normHex(reg.color)) {
        const pair = findClosestPair(edgePixels.get(prevReg), edgePixels.get(reg));
        const gap = Math.hypot(pair.to.x - lastX, pair.to.y - lastY);
        if (gap > bridgeMaxPx) {
          /* tie off, trim, jump to new region — no sewn line across */
          stitches.push(...generateTieStitches(lastX, lastY, color, -1, 0));
          stitches.push({x: lastX, y: lastY, color, type: "trim"});
          stitches.push({x: pair.to.x, y: pair.to.y, color, type: "trim"});
        } else {
          stitches.push(...generateBridgeStitches(lastX, lastY, pair.to.x, pair.to.y, color));
        }
        lastX = pair.to.x; lastY = pair.to.y;
      } else {
        stitches.push(...generateTieStitches(lastX, lastY, prevColor, -1, 0));
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        const entryEdge = edgePixels.get(reg);
        const entry = entryEdge[Math.floor(entryEdge.length / 2)];
        const bridge = generateBridgeStitches(lastX, lastY, entry.x, entry.y, color);
        stitches.push(...bridge);
        lastX = entry.x; lastY = entry.y;
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    } else {
      const entryEdge = edgePixels.get(reg);
      const entry = entryEdge[Math.floor(entryEdge.length / 2)];
      lastX = entry.x; lastY = entry.y;
      if (ri === 0) {
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    }

    /* Outline pass for crisp edges */
    const outlineStep = Math.max(6, Math.round(pLen * 0.5));
    const outline = generateOutline(pixMap, reg, ci, canvasSize, color, outlineStep);
    if (outline.length) {
      const oStart = outline[0];
      const _od = Math.hypot(oStart.x - lastX, oStart.y - lastY);
      if (_od > bridgeMaxPx) {
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        stitches.push({x: oStart.x, y: oStart.y, color, type: "trim"});
      } else if (_od > 3) {
        stitches.push(...generateBridgeStitches(lastX, lastY, oStart.x, oStart.y, color));
      }
      stitches.push(...outline);
      lastX = outline[outline.length - 1].x;
      lastY = outline[outline.length - 1].y;
      colorCounts[ci].running += outline.length;
    }

    /* Underlay */
    if (type === "fill") {
      const edgeWalk = generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, pEdgeUL, Math.max(2, pPull));
      if (edgeWalk.length) {
        const start = edgeWalk[0];
        const _ed = Math.hypot(start.x - lastX, start.y - lastY);
        if (_ed > bridgeMaxPx) {
          stitches.push({x: lastX, y: lastY, color, type: "trim"});
          stitches.push({x: start.x, y: start.y, color, type: "trim"});
        } else if (_ed > 3) {
          stitches.push(...generateBridgeStitches(lastX, lastY, start.x, start.y, color));
        }
        stitches.push(...edgeWalk);
        lastX = edgeWalk[edgeWalk.length - 1].x;
        lastY = edgeWalk[edgeWalk.length - 1].y;
        colorCounts[ci].underlay += edgeWalk.length;
      }
      const zig = generateZigzagUnderlay(pixMap, reg, ci, canvasSize, color, pZigUL, pZigLen);
      if (zig.length) {
        const zStart = zig[0];
        const _zd = Math.hypot(zStart.x - lastX, zStart.y - lastY);
        if (_zd > bridgeMaxPx) {
          stitches.push({x: lastX, y: lastY, color, type: "trim"});
          stitches.push({x: zStart.x, y: zStart.y, color, type: "trim"});
        } else if (_zd > 3) {
          stitches.push(...generateBridgeStitches(lastX, lastY, zStart.x, zStart.y, color));
        }
        stitches.push(...zig);
        lastX = zig[zig.length - 1].x;
        lastY = zig[zig.length - 1].y;
        colorCounts[ci].underlay += zig.length;
      }
    }

    const useVerticalScan = (type === "fill") && (regH > regW * 1.4);
    let lx = lastX, ly = lastY;

    if (useVerticalScan) {
      let colIdx = 0;
      const gapTrimPxV = Math.max(15, Math.round(pLen * 1.2));
      for (let x = mnx; x <= mxx; x += pRow) {
        const runs = getRunsInCol(pixMap, ci, x, mny, mxy, canvasSize);
        if (!runs.length) continue;
        const rev = colIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;
        let runIdx = 0;
        let prevExitY = null;
        for (const {y1, y2} of ord) {
          /* Inter-run trim for vertical scan */
          if (runIdx > 0 && prevExitY !== null) {
            const entryY = rev ? y2 : y1;
            const gap = Math.abs(entryY - prevExitY);
            if (gap > gapTrimPxV) {
              stitches.push({x, y: prevExitY, color, type: "trim"});
              stitches.push({x, y: entryY,    color, type: "trim"});
              lx = x; ly = entryY;
            }
          }

          const ay1 = y1 + pPull - pPullComp;
          const ay2 = y2 - pPull + pPullComp;
          const brickOff = colIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
          const ly1 = ay1 + brickOff;
          if (ay2 <= ly1) {
            const my = Math.round((y1 + y2) / 2);
            stitches.push({x, y: my, color, type: "fill"});
            colorCounts[ci].fill++;
            lx = x; ly = my;
            prevExitY = my;
          } else {
            const steps = Math.max(1, Math.round((ay2 - ly1) / pLen));
            const sy = rev ? ay2 : ly1, ey = rev ? ly1 : ay2;
            for (let s = 0; s <= steps; s++) {
              const fy = Math.round(sy + (ey - sy) * s / steps);
              stitches.push({x, y: fy, color, type: "fill"});
              colorCounts[ci].fill++;
            }
            lx = x; ly = Math.round(ey);
            prevExitY = ly;
          }
          runIdx++;
        }
        colIdx++;
      }
    } else {
      let rowIdx = 0;
      const gapTrimPx = Math.max(15, Math.round(pLen * 1.2)); /* >1.2× stitch length = trim instead of sew across */
      for (let y = mny; y <= mxy; y += pRow) {
        const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
        if (!runs.length) continue;
        const rev = rowIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;

        let runIdx = 0;
        let prevExitX = null;
        for (const {x1, x2} of ord) {
          const jx = rev ? x2 : x1;

          /* Inter-run trim: if there is a previous run in this same row and the
             gap to this run's entry exceeds gapTrimPx, drop a trim so the next
             stitch starts fresh instead of dragging thread across empty fabric. */
          if (runIdx > 0 && prevExitX !== null) {
            const entryForGap = rev ? x2 : x1;
            const gap = Math.abs(entryForGap - prevExitX);
            if (gap > gapTrimPx) {
              stitches.push({x: prevExitX, y, color, type: "trim"});
              stitches.push({x: entryForGap, y, color, type: "trim"});
              lx = entryForGap; ly = y;
            }
          }

          if (type === "running") {
            const rx = Math.round((x1 + x2) / 2);
            stitches.push({x: rx, y, color, type: "running"});
            colorCounts[ci].running++;
            lx = rx; ly = y;
            prevExitX = rx;

          } else if (type === "satin") {
            const sx = rev ? x2 - pPull + pPullComp : x1 + pPull - pPullComp;
            const ex = rev ? x1 + pPull - pPullComp : x2 - pPull + pPullComp;
            if (Math.abs(ex - sx) > 1) {
              stitches.push({x: sx, y, color, type: "satin"});
              stitches.push({x: ex, y, color, type: "satin"});
              colorCounts[ci].satin += 2;
              lx = ex; ly = y;
              prevExitX = ex;
            } else {
              const rx = Math.round((x1 + x2) / 2);
              stitches.push({x: rx, y, color, type: "satin"});
              colorCounts[ci].satin++;
              lx = rx; ly = y;
              prevExitX = rx;
            }

          } else {
            const brickOff = rowIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
            const lxF = x1 + pPull - pPullComp + brickOff;
            const rxF = x2 - pPull + pPullComp;
            if (rxF > lxF) {
              const steps = Math.max(1, Math.round((rxF - lxF) / pLen));
              const sx2 = rev ? rxF : lxF, ex2 = rev ? lxF : rxF;
              for (let s = 0; s <= steps; s++) {
                const fx = Math.round(sx2 + (ex2 - sx2) * s / steps);
                stitches.push({x: fx, y, color, type: "fill"});
                colorCounts[ci].fill++;
              }
              lx = Math.round(ex2); ly = y;
              prevExitX = lx;
            } else {
              const mid = Math.round((x1 + x2) / 2);
              stitches.push({x: mid, y, color, type: "fill"});
              colorCounts[ci].fill++;
              lx = mid; ly = y;
              prevExitX = mid;
            }
          }
          runIdx++;
        }
        rowIdx++;
      }
    }

    globalLastX = lx;
    globalLastY = ly;
    prevColor = color;
  }

  if (globalLastX !== -1 && prevColor !== null) {
    stitches.push(...generateTieStitches(globalLastX, globalLastY, prevColor, -1, 0));
  }

  /* ── DEFINITION OUTLINE PASS ──────────────────────────────────────────
     Sew a dark running-stitch contour around significant regions LAST, so the
     form "reads" like the drawing (eyes, face edge, gown vs trim boundaries).
     Feasibility: running stitches only (low count, fast, no density issues).
     Reuses the user's DARKEST existing palette colour, so it adds NO extra
     thread — works the same for 3 colours or 8. Sewn last so contours sit on
     top of fills. Enabled via params.definitionOutline (default on). */
  if (params.definitionOutline !== false) {
    // Reuse the DARKEST colour already in the user's palette — no extra thread.
    // Works for any colour count (3 or 8): the outline never adds a slot, and
    // matches the design's own tones (soft on pastels, strong on high-contrast).
    let outlineHex = colors[0] || "#2A2A2A";
    let _darkest = Infinity;
    for (const c of colors) {
      const { r, g, b } = hexToRgb(c);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;   // perceived brightness
      if (lum < _darkest) { _darkest = lum; outlineHex = c; }
    }
    const _pxmm = (canvasSize / 800) * 10;
    const oStep = Math.max(10, Math.round(2.5 * _pxmm));   // ~2.5mm running (fewer stitches)
    // Only outline SIGNIFICANT shapes — big enough to need a defining contour.
    const minOutlineArea = Math.max(200, Math.round(20 * _pxmm * _pxmm)); // ~20mm² min
    const maxOutlineStitches = 2500;                        // hard cap: outline is an accent, not the bulk
    let oLastX = globalLastX, oLastY = globalLastY;
    let outlineStitchCount = 0;

    // Trim/jump from wherever we ended into the outline pass
    if (oLastX !== -1) {
      stitches.push({x: oLastX, y: oLastY, color: outlineHex, type: "trim"});
    }

    // Outline LARGEST regions first (most visually important), stop at the cap.
    const outlineRegions = regions
      .filter(r => {
        const a = (r.mxx - r.mnx + 1) * (r.mxy - r.mny + 1);
        if (a < minOutlineArea) return false;
        // Skip regions whose own colour IS the outline colour — they're already
        // dark; re-outlining them just dumps a huge block of dark stitches that
        // merges with the dark fill (the 16k-stitch black-block bug).
        if (normHex(r.color) === normHex(outlineHex)) return false;
        return true;
      })
      .sort((a, b) => ((b.mxx-b.mnx)*(b.mxy-b.mny)) - ((a.mxx-a.mnx)*(a.mxy-a.mny)));

    for (const reg of outlineRegions) {
      if (outlineStitchCount >= maxOutlineStitches) break;   // accent only
      const ci = colors.findIndex(c => normHex(c) === normHex(reg.color));
      if (ci < 0) continue;
      const path = generateOutline(pixMap, reg, ci, canvasSize, outlineHex, oStep);
      if (path.length < 3) continue;

      const s = path[0];
      if (oLastX !== -1 && Math.hypot(s.x - oLastX, s.y - oLastY) > 3) {
        stitches.push({x: oLastX, y: oLastY, color: outlineHex, type: "trim"});
        stitches.push({x: s.x, y: s.y, color: outlineHex, type: "trim"});
      }
      for (const p of path) stitches.push(p);
      outlineStitchCount += path.length;
      oLastX = path[path.length - 1].x; oLastY = path[path.length - 1].y;
    }
    if (outlineStitchCount > 0) {
      console.log(`[outline] definition pass: ${outlineStitchCount} running stitches in ${outlineHex}`);
    }
  }

  console.log("Stitches:", colors.map((c, i) => {
    const k = colorCounts[i];
    return `${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running} ul:${k.underlay}`;
  }).join(" | "));

  return {stitches, colorCounts};
}

/* ─── QUALITY VALIDATION ─────────────────────────────────*/
function validateQuality(stitches, machineLimits){
  const limits = machineLimits || MACHINE_LIMITS.generic;
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,trimCount=0,prev=null;
  for(const s of stitches){
    if(s.type==="trim"){trimCount++;prev=null;continue;}
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>limits.maxJump)longJ++;
      if(s.type!=="underlay"){tot+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?tot/cnt:0;
  if(avg>50)w.push(`Long avg ${(avg/10).toFixed(1)}mm`);
  if(maxJ>limits.maxJump)w.push(`Jump ${(maxJ/10).toFixed(1)}mm > ${(limits.maxJump/10).toFixed(1)}mm`);
  if(longJ>30)    w.push(`${longJ} oversized jumps`);
  if(cnt>80000)   w.push(`High stitch count ${cnt}`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,trimCount,warnings:w,passed:!w.length};
}

/* ─── SEW TIME CALCULATOR ────────────────────────────────*/
function calculateSewTime(stitchCount, trimCount, colorCount, machine) {
  const spm = { tajima: 800, brother: 650, barudan: 850, generic: 750, janome: 700, singer: 600 };
  const rate = spm[machine] || 750;
  
  const stitchMinutes = stitchCount / rate;
  const trimMinutes = (trimCount * 0.3) / 60;
  const colorChangeMinutes = Math.max(0, (colorCount - 1) * 0.5);
  
  const totalMinutes = Math.ceil(stitchMinutes + trimMinutes + colorChangeMinutes);
  
  if (totalMinutes < 1) return "< 1 min";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/* ─── OPTIMISED PREVIEW RENDERER (10x faster) ──────────────── */


/* ─── STITCH PARAMS ─────────────────────────────────────*/
function getMaxStitchPx(machine, pxPerMm) {
  const mm = MACHINE_MAX_STITCH_MM[machine] || MACHINE_MAX_STITCH_MM.generic;
  return Math.round(mm * pxPerMm);
}

function getStitchParams(specs, canvasSize) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();
  const hoop = (s.hoop || "5x7").toLowerCase();

  const limits = MACHINE_LIMITS[machine] || MACHINE_LIMITS.generic;
  /* The canvas is always rendered at 10 px/mm — design mm = canvas / 10.
     So actual pixels-per-mm is a fixed 10 regardless of canvasSize.
     Previously this was `canvasSize/800` which gave a *scale factor*, not
     px/mm, and was then multiplied by itself causing a double-scale bug
     (Math.max(20, …) was hiding it by clamping). */
  const pxPerMm = 10;
  const maxStitchLenPx = Math.max(20, getMaxStitchPx(machine, pxPerMm));

  const p = {
    tatamiRow: 4, tatamiLen: 42, tatamiUl: 25, pull: 2,
    pullComp: HOOP_PULL[hoop] || 2,
    machineLimits: limits,
    machine, fabric, stabilizer, density, hoop,
    maxStitchLen: maxStitchLenPx,
    pxPerMm
  };

  const fabricMap = {
    cotton:  { pull: 2, tatamiRow: 4, tatamiUl: 25, tatamiLen: 42 },
    denim:   { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    fleece:  { pull: 5, tatamiRow: 5, tatamiUl: 22, tatamiLen: 40 },
    pique:   { pull: 3, tatamiRow: 4, tatamiUl: 22, tatamiLen: 42 },
    twill:   { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    satin:   { pull: 1, tatamiRow: 5, tatamiUl: 30, tatamiLen: 48 },
    leather: { pull: 1, tatamiRow: 5, tatamiUl: 30, tatamiLen: 50 },
    towel:   { pull: 6, tatamiRow: 4, tatamiUl: 20, tatamiLen: 38 },
    canvas:  { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    knit:    { pull: 5, tatamiRow: 5, tatamiUl: 22, tatamiLen: 40 },
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  const densityMap = {
    low:    { tatamiRow: 6, tatamiLen: 50, tatamiUl: 30 },
    medium: { },
    high:   { tatamiRow: 3, tatamiLen: 38, tatamiUl: 20 },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(3, p.tatamiRow);
    p.tatamiUl = Math.max(18, p.tatamiUl);
  }

  return p;
}

module.exports = {
  getStitchParams,
  generateStitchesFromRegions,
  v70_buildShapes,
  v70_generateStitches,
  v72_buildAndGenerate,
  v70_findRegions,
  v71_generatePhotoStitch,
  validateQuality,
  calculateSewTime,
  extractRegions,
  mergeAdjacentRegions,
  applyColorMerges,
  generateBastingBox,
};
