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
        const isSameRow = (i > 0);
        const travel = Math.hypot(sx - lastX, sy - lastY);
        if (isSameRow || travel > maxBridgePx) {
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
  /* 1mm² minimum — below this, detail is smaller than a typical stitch and
     becomes noise speckles in the output. Real embroidery needles can't
     resolve features under ~0.5mm anyway. */
  const minAreaPx = Math.max(50, Math.round(1.0 * pxPerMm * pxPerMm));
  const rawRegions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);
  console.log(`[v70] Raw regions: ${rawRegions.length} (minArea=${minAreaPx}px)`);

  /* Splitting is disabled by default — distance-transform based splitting
     works well on compound shapes (2-3 distinct lobes) but fails on
     star-shaped multi-frond clusters where it either over-splits or
     produces wrong seeds. For most embroidery the per-shape PCA angle is
     sufficient. Enable via env var V70_SPLIT=1 if you want experimental
     blob splitting. */
  const enableSplit = process.env.V70_SPLIT === "1";
  const junctionPx = Math.max(4, Math.round(6 * (canvasSize / 800)));

  const shapes = [];
  for (const reg of rawRegions) {
    let subPtsList;
    if (enableSplit && reg.pts.length > 500) {
      subPtsList = v70_splitRegion(reg, canvasSize, junctionPx);
      if (subPtsList.length > 1) {
        console.log(`[v70] Split region (color ${colors[reg.ci]}, ${reg.pts.length}px) into ${subPtsList.length} sub-shapes`);
      }
    } else {
      subPtsList = [reg.pts];
    }

    for (const pts of subPtsList) {
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
  }
  console.log(`[v70] Final shapes: ${shapes.length} (fill:${shapes.filter(s=>s.type==="fill").length} satin:${shapes.filter(s=>s.type==="satin").length} run:${shapes.filter(s=>s.type==="running").length})`);
  return shapes;
}

/* ── Top-level stitch generation ──────────────────────────────────────────── */
function v70_generateStitches(shapes, colors, params, canvasSize) {
  const out = [];
  const colorCounts = colors.map(() => ({fill:0, satin:0, running:0, underlay:0}));
  const pxScale  = canvasSize / 800;
  const P = params || {};
  const pRow      = Math.max(3, Math.round((P.tatamiRow || 4) * pxScale));  /* 0.3-0.5 mm */
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
    const color = colors[ci];

    for (const sh of group) {
      /* Trim if moving far */
      const path = v70_traceOutline(sh.mask, sh.w, sh.h);
      if (!path.length) continue;
      const startX = path[0][0] + sh.offX, startY = path[0][1] + sh.offY;
      if (Math.hypot(startX - lastX, startY - lastY) > 12 * pxScale) {
        out.push({ x: lastX, y: lastY, color, type: "trim" });
      }

      /* OUTLINE pass — running stitches around the boundary.
         Outline before fill is standard practice: it defines a crisp edge
         that the fill can register against, and helps prevent the fill
         from looking ragged. */
      const ol = v70_outlineStitches(path, sh.offX, sh.offY, color, pOutline);
      for (const s of ol) {
        out.push(s);
        colorCounts[ci].running++;
        lastX = s.x; lastY = s.y;
      }

      /* Stitch angle: if shape is near-round (low aspect), use a fixed vertical
         angle (90°) instead of unreliable PCA. Vertical fills look natural and
         the slight pull on horizontal threads helps the shape sit flat. */
      const stitchAngle = (sh.pca.aspect < 1.3) ? Math.PI / 2 : sh.pca.angle;

      /* MAIN STITCHING */
      if (sh.type === "fill" || (sh.type === "satin" && sh.widthMm > 3.5)) {
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY,
                                  stitchAngle, pRow);
        const fs = v70_runsToStitches(scan, color, pBrick, pPullComp, pMaxBridge, maxStitchLen);
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
           At 800px: MIN_AREA=25 → ~0.04mm². At 1600px: use 100px² for same physical size. */
        const scaledMinArea = MIN_AREA * Math.pow(canvasSize / 800, 2);
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
      const dist = Math.abs(ex - sx);
      const steps = Math.max(1, Math.round(dist / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const fx = Math.round(sx + (ex - sx) * s / steps);
        const zy = y + ((s % 2) ? 2 : -2);
        out.push({x: fx, y: zy, color, type: "underlay"});
      }
    }
    rowI++;
  }
  return out;
}

/* ─── TIE-IN / TIE-OFF ─────────────────── */
function generateTieStitches(x, y, color, dirX, dirY) {
  const stitches = [];
  const off = 15;
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  stitches.push({x: x - dirX * off / 2, y: y - dirY * off / 2, color, type: "tie"});
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  return stitches;
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
  const edge = [];
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    if (runs.length) {
      edge.push({x: runs[0].x1, y});
      if (runs[runs.length - 1].x2 > runs[0].x1) edge.push({x: runs[runs.length - 1].x2, y});
    }
  }
  if (edge.length < 3) return [];
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  edge.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const out = [];
  let prev = null;
  for (const p of edge) {
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
  const pRow      = P.tatamiRow !== undefined ? P.tatamiRow : 4;
  const pLen      = P.tatamiLen !== undefined ? P.tatamiLen : 30;
  const pPull     = P.pull      !== undefined ? P.pull      : 2;
  const pPullComp = P.pullComp  !== undefined ? P.pullComp  : 2;
  const pEdgeUL   = 18;
  const pZigUL    = 28;
  const pZigLen   = 40;

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
        if (gap > 120) {
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
      if (Math.hypot(oStart.x - lastX, oStart.y - lastY) > 30) {
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
        if (Math.hypot(start.x - lastX, start.y - lastY) > 30) {
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
        if (Math.hypot(zStart.x - lastX, zStart.y - lastY) > 30) {
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
  v70_findRegions,
  v71_generatePhotoStitch,
  validateQuality,
  calculateSewTime,
  extractRegions,
  mergeAdjacentRegions,
  applyColorMerges,
  generateBastingBox,
};
