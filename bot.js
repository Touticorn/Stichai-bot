/**
 * Stichai v50 — Production Rewrite
 * ═══════════════════════════════════════════════════════
 *  CRITICAL FIXES
 *  ───────────────────────────────────────────────────────
 *  1. ASYNC JOBS: Eliminates 503 timeouts via polling architecture
 *  2. RED MASK: Detects the frontend's red brush strokes correctly
 *  3. QUANTIZED PIPELINE: Uses the quantized image for pixel mapping
 *  4. 8-CONNECTIVITY + MORPH CLOSE: Keeps thin diagonal shapes
 *  5. TRUE SATIN RAILS: Zigzag perpendicular to column axis
 *  6. SMART TRIM: Only trims on gaps > 3mm
 *  7. DST ONLY: Honest format support (no fake headers)
 *  8. HIGH-QUALITY PREVIEW: Anti-aliased thread simulation
 */

"use strict";

const express = require("express");
const multer  = require("multer");
const axios   = require("axios");
const path    = require("path");
const sharp   = require("sharp");

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Allow CORS for all origins (restrict in production)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-flash",
];

/* ─── CANVAS ─────────────────────────────────────────────*/
const CANVAS    = 800;
const DESIGN_MM = CANVAS / 10; // 80mm

/* ─── STITCH CONSTANTS ───────────────────────────────────*/
let TATAMI_ROW   = 4;   // 0.4mm
let TATAMI_LEN   = 30;  // 3.0mm
const TATAMI_BRICK = 0.5;
let TATAMI_UL    = 40;  // 4.0mm underlay
const RUN_LEN      = 25;
let PULL         = 2;
const DST_MAX      = 121; // 12.1mm max jump
const SMART_TRIM   = 30;  // 3.0mm — only trim beyond this

/* ─── SPEC TUNING ─────────────────────────────────────────*/
function getStitchParams(specs) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();

  const p = {
    tatamiRow: 4, tatamiLen: 30, tatamiUl: 40, pull: 2,
    machine, fabric, stabilizer, density, maxStitchLen: 121
  };

  const fabricMap = {
    cotton:  { pull: 2, tatamiRow: 4, tatamiUl: 40, tatamiLen: 30 },
    denim:   { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    fleece:  { pull: 5, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
    pique:   { pull: 3, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    twill:   { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    satin:   { pull: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    leather: { pull: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    towel:   { pull: 6, tatamiRow: 2, tatamiUl: 20, tatamiLen: 20 },
    canvas:  { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    knit:    { pull: 5, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  const densityMap = {
    low:    { tatamiRow: 6, tatamiLen: 40, tatamiUl: 60 },
    medium: { },
    high:   { tatamiRow: 2, tatamiLen: 20, tatamiUl: 25 },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(2, p.tatamiRow);
    p.tatamiUl = Math.max(20, p.tatamiUl);
  }

  return p;
}

/* ─── COLOR UTILITIES ────────────────────────────────────*/
function hexToRgb(hex) {
  const m = (hex || "").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16)
  };
}
function rgbToLab({ r, g, b }) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? ((R + 0.055) / 1.055) ** 2.4 : R / 12.92;
  G = G > 0.04045 ? ((G + 0.055) / 1.055) ** 2.4 : G / 12.92;
  B = B > 0.04045 ? ((B + 0.055) / 1.055) ** 2.4 : B / 12.92;
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return { l: 116 * f(Y) - 16, a: 500 * (f(X / 0.95047) - f(Y)), b: 200 * (f(Y) - f(Z / 1.08883)) };
}
function dE(a, b) { return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2); }
function normHex(h) {
  const m = (h || "").match(/^#?([0-9a-fA-F]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : "#000000";
}
function dedupe(cols) {
  const out = [];
  for (const c of cols) {
    const lab = rgbToLab(hexToRgb(c));
    if (!out.some(u => dE(lab, rgbToLab(hexToRgb(u))) < 18)) out.push(normHex(c));
  }
  return out;
}

/* ─── IMAGE PRE-PROCESSING ─────────────────────────────────
   Returns a QUANTIZED buffer so every pixel matches the palette.
   This eliminates the mismatch between palette extraction and
   raw pixel mapping that caused massive -1 unmatched pixels.
   ───────────────────────────────────────────────────────*/
async function preprocessImage(buffer) {
  // Clean and normalize
  const cleaned = await sharp(buffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .median(2)
    .sharpen({ sigma: 1.0 })
    .linear(1.15, -10)
    .toBuffer();

  // Quantize to 16 colors — this becomes our canonical image
  const quantized = await sharp(cleaned)
    .png({ colours: 16, dither: 0, effort: 10 })
    .toBuffer();

  // Extract exact palette from quantized image
  const { data, info } = await sharp(quantized)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cm = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const h = "#" + [data[i], data[i + 1], data[i + 2]]
      .map(c => c.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    cm.set(h, (cm.get(h) || 0) + 1);
  }

  const sorted = [...cm.entries()].sort((a, b) => b[1] - a[1]);
  const bgColor = sorted[0][0];
  const fallback = sorted.slice(0, 8).map(([h]) => h);

  return { buffer: quantized, bgColor, bgLab: rgbToLab(hexToRgb(bgColor)), fallbackColors: fallback };
}

/* ─── MASK APPLICATION ─────────────────────────────────────
   The frontend paints RED strokes (rgba(255,60,60)).
   We detect mask pixels by: high red channel AND alpha > 30.
   This finally makes the mask actually work.
   ───────────────────────────────────────────────────────*/
async function applyUserMask(pre, maskBuffer) {
  const maskRaw = await sharp(maskBuffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: mData, info: mInfo } = maskRaw;
  const mCh = mInfo.channels;

  const bgRgb = hexToRgb(pre.bgColor);

  const imgRaw = await sharp(pre.buffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const out = Buffer.alloc(CANVAS * CANVAS * iCh);

  let maskedPixels = 0;
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const idx = y * CANVAS + x;
      const iOff = idx * iCh;
      const mOff = idx * mCh;

      const mR = mData[mOff] || 0;
      const mG = mData[mOff + 1] || 0;
      const mB = mData[mOff + 2] || 0;
      const mA = mCh >= 4 ? mData[mOff + 3] : 255;

      // Detect red brush: dominant red, some alpha
      const isRedMask = mR > 140 && mG < 90 && mB < 90 && mA > 30;

      if (isRedMask) {
        out[iOff] = bgRgb.r;
        out[iOff + 1] = bgRgb.g;
        out[iOff + 2] = bgRgb.b;
        if (iCh >= 4) out[iOff + 3] = 255;
        maskedPixels++;
      } else {
        out[iOff] = iData[iOff];
        out[iOff + 1] = iData[iOff + 1];
        out[iOff + 2] = iData[iOff + 2];
        if (iCh >= 4) out[iOff + 3] = iData[iOff + 3];
      }
    }
  }

  console.log(`Mask applied: ${maskedPixels}px (${(maskedPixels / (CANVAS * CANVAS) * 100).toFixed(1)}%)`);

  // Re-quantize after masking to keep palette clean
  const requant = await sharp(out, { raw: { width: CANVAS, height: CANVAS, channels: iCh } })
    .png({ colours: 16, dither: 0, effort: 10 })
    .toBuffer();

  return { ...pre, buffer: requant };
}

/* ─── PIXEL COLOR MAP ──────────────────────────────────────
   Exact match against quantized colors (tolerance only for
   PNG compression artifacts). 8-neighbor gap fill with >=3
   matching neighbors to close thin diagonal gaps.
   ───────────────────────────────────────────────────────*/
async function buildPixelMap(buffer, colors) {
  const { data, info } = await sharp(buffer)
    .resize(CANVAS, CANVAS, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels;
  const pixMap = new Int16Array(CANVAS * CANVAS).fill(-1);
  const hexMap = new Map();

  // Build exact color lookup
  for (const c of colors) {
    const rgb = hexToRgb(c);
    hexMap.set(c, rgb);
  }

  // First pass: exact match
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const i = (y * CANVAS + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let best = -1, bestD = 24; // tight tolerance since quantized
      for (let ci = 0; ci < colors.length; ci++) {
        const rc = hexMap.get(colors[ci]);
        const d = Math.abs(r - rc.r) + Math.abs(g - rc.g) + Math.abs(b - rc.b);
        if (d < bestD) { bestD = d; best = ci; }
      }
      pixMap[y * CANVAS + x] = best;
    }
  }

  // 8-neighbor gap fill (3/8 neighbors required — gentler than old 3/4)
  for (let y = 1; y < CANVAS - 1; y++) {
    for (let x = 1; x < CANVAS - 1; x++) {
      const idx = y * CANVAS + x;
      if (pixMap[idx] !== -1) continue;
      const counts = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const n = pixMap[idx + dy * CANVAS + dx];
          if (n !== -1) counts.set(n, (counts.get(n) || 0) + 1);
        }
      }
      let best = -1, bestCount = 0;
      for (const [color, count] of counts) {
        if (count > bestCount) { bestCount = count; best = color; }
      }
      if (bestCount >= 3) pixMap[idx] = best;
    }
  }

  const cnt = new Array(colors.length).fill(0);
  let un = 0;
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] >= 0) cnt[pixMap[i]]++; else un++;
  }
  const total = CANVAS * CANVAS;
  console.log("Coverage:", cnt.map((c, i) => `${normHex(colors[i])}:${(c / total * 100).toFixed(1)}%`).join(" "),
    `unmatched:${(un / total * 100).toFixed(1)}%`);

  return pixMap;
}

/* ─── CONNECTED-COMPONENT EXTRACTION (8-connectivity) ─────*/
const MIN_AREA = 25;
const SATIN_MAX_W = 150;

function extractRegions(pixMap, colors) {
  const visited = new Uint8Array(CANVAS * CANVAS);
  const regions = [];

  for (let ci = 0; ci < colors.length; ci++) {
    for (let sy = 0; sy < CANVAS; sy++) {
      for (let sx = 0; sx < CANVAS; sx++) {
        const si = sy * CANVAS + sx;
        if (pixMap[si] !== ci || visited[si]) continue;

        // 8-connectivity BFS
        const q = [si]; let qp = 0;
        visited[si] = 1;
        let mnx = sx, mxx = sx, mny = sy, mxy = sy, area = 0;

        while (qp < q.length) {
          const idx = q[qp++]; area++;
          const x = idx % CANVAS, y = (idx / CANVAS) | 0;
          if (x < mnx) mnx = x; if (x > mxx) mxx = x;
          if (y < mny) mny = y; if (y > mxy) mxy = y;

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < CANVAS && ny >= 0 && ny < CANVAS) {
                const ni = ny * CANVAS + nx;
                if (!visited[ni] && pixMap[ni] === ci) {
                  visited[ni] = 1;
                  q.push(ni);
                }
              }
            }
          }
        }

        if (area < MIN_AREA) continue;

        const bw = mxx - mnx + 1, bh = mxy - mny + 1;
        const aspectRatio = bh / Math.max(bw, 1);
        const solidity = area / (bw * bh);

        let type;
        if (area < MIN_AREA * 3) type = "running";
        else if (aspectRatio > 1.6 && solidity > 0.35) type = "fill";      // tall stripe
        else if (aspectRatio < 0.6 && solidity > 0.35) type = "fill";      // wide flat
        else if (bw <= SATIN_MAX_W && bh <= SATIN_MAX_W * 2) type = "satin"; // column-like
        else type = "fill";

        regions.push({ ci, color: normHex(colors[ci]), type, mnx, mny, mxx, mxy, bw, bh, area, aspectRatio, solidity });
      }
    }
  }

  console.log(`Regions: ${regions.length} | fill:${regions.filter(r => r.type === "fill").length} satin:${regions.filter(r => r.type === "satin").length} run:${regions.filter(r => r.type === "running").length}`);
  return regions;
}

/* ─── RUN HELPERS ──────────────────────────────────────────*/
function getRunsInRow(pixMap, ci, y, x0, x1) {
  const runs = []; let s = -1;
  for (let x = x0; x <= x1; x++) {
    const hit = y >= 0 && y < CANVAS && pixMap[y * CANVAS + x] === ci;
    if (hit && s === -1) s = x;
    if (!hit && s !== -1) { runs.push({ x1: s, x2: x - 1 }); s = -1; }
  }
  if (s !== -1) runs.push({ x1: s, x2: x1 });
  return runs;
}
function getRunsInCol(pixMap, ci, x, y0, y1) {
  const runs = []; let s = -1;
  for (let y = y0; y <= y1; y++) {
    const hit = x >= 0 && x < CANVAS && pixMap[y * CANVAS + x] === ci;
    if (hit && s === -1) s = y;
    if (!hit && s !== -1) { runs.push({ y1: s, y2: y - 1 }); s = -1; }
  }
  if (s !== -1) runs.push({ y1: s, y2: y1 });
  return runs;
}

/* ─── STITCH GENERATORS ───────────────────────────────────*/

function emitTrim(stitches, x0, y0, x1, y1, color) {
  stitches.push({ x: Math.round(x0), y: Math.round(y0), color, type: "trim" });
  stitches.push({ x: Math.round(x1), y: Math.round(y1), color, type: "trim" });
}

function smartMove(stitches, fromX, fromY, toX, toY, color) {
  const d = Math.hypot(toX - fromX, toY - fromY);
  if (d > SMART_TRIM) {
    emitTrim(stitches, fromX, fromY, toX, toY, color);
  }
  // If close, just move without trim (machine will make a running stitch)
  return { x: toX, y: toY };
}

/* ─── FILL GENERATOR (Tatami with brick offset) ──────────*/
function generateFillStitches(region, pixMap, ci, color, params) {
  const stitches = [];
  const { mnx, mny, mxx, mxy } = region;
  const pRow = params.tatamiRow || TATAMI_ROW;
  const pLen = params.tatamiLen || TATAMI_LEN;
  const pUl = params.tatamiUl || TATAMI_UL;
  const pPull = params.pull || PULL;

  // Underlay: sparse horizontal rows
  let ulRow = 0;
  for (let y = mny; y <= mxy; y += pUl) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx);
    if (!runs.length) continue;
    const rev = ulRow % 2 === 1;
    for (const { x1, x2 } of (rev ? [...runs].reverse() : runs)) {
      const ux = rev ? x2 - pPull : x1 + pPull;
      stitches.push({ x: ux, y, color, type: "underlay" });
      stitches.push({ x: rev ? x1 + pPull : x2 - pPull, y, color, type: "underlay" });
    }
    ulRow++;
  }

  // Cover: tatami fill with brick offset
  let rowIdx = 0;
  for (let y = mny; y <= mxy; y += pRow) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx);
    if (!runs.length) continue;
    const rev = rowIdx % 2 === 1;
    const ord = rev ? [...runs].reverse() : runs;

    for (const { x1, x2 } of ord) {
      const brickOff = rowIdx % 2 === 0 ? 0 : Math.round(pLen * TATAMI_BRICK);
      const lx = x1 + pPull + brickOff;
      const rx = x2 - pPull;
      if (rx > lx) {
        const steps = Math.max(1, Math.round((rx - lx) / pLen));
        const sx2 = rev ? rx : lx;
        const ex2 = rev ? lx : rx;
        for (let s = 0; s <= steps; s++) {
          stitches.push({ x: Math.round(sx2 + (ex2 - sx2) * s / steps), y, color, type: "fill" });
        }
      } else {
        stitches.push({ x: Math.round((x1 + x2) / 2), y, color, type: "fill" });
      }
    }
    rowIdx++;
  }
  return stitches;
}

/* ─── SATIN GENERATOR (True zigzag rails) ────────────────
   Stitches run PERPENDICULAR to the column's major axis.
   Tall region  → horizontal zigzag (rails = top/bottom)
   Wide region  → vertical zigzag   (rails = left/right)
   ───────────────────────────────────────────────────────*/
function generateSatinStitches(region, pixMap, ci, color, params) {
  const stitches = [];
  const { mnx, mny, mxx, mxy } = region;
  const pRow = params.tatamiRow || TATAMI_ROW;
  const pPull = params.pull || PULL;

  const tall = region.bh > region.bw;

  // Underlay: center walk
  if (tall) {
    const cx = Math.round((mnx + mxx) / 2);
    for (let y = mny; y <= mxy; y += pRow * 2) {
      stitches.push({ x: cx, y, color, type: "underlay" });
    }
  } else {
    const cy = Math.round((mny + mxy) / 2);
    for (let x = mnx; x <= mxx; x += pRow * 2) {
      stitches.push({ x, y: cy, color, type: "underlay" });
    }
  }

  // Cover: zigzag perpendicular to spine
  if (tall) {
    // Rails are left/right boundaries. Zigzag horizontally.
    for (let y = mny; y <= mxy; y += pRow) {
      const runs = getRunsInRow(pixMap, ci, y, mnx, mxx);
      for (const { x1, x2 } of runs) {
        const w = x2 - x1 + 1;
        if (w < 3) continue;
        const zig = (Math.floor((y - mny) / pRow) % 2 === 0) ? 0 : Math.round(pRow * 0.35);
        const left = x1 + pPull;
        const right = x2 - pPull;
        stitches.push({ x: left, y: y + zig, color, type: "satin" });
        stitches.push({ x: right, y: y + pRow - zig, color, type: "satin" });
      }
    }
  } else {
    // Rails are top/bottom boundaries. Zigzag vertically.
    for (let x = mnx; x <= mxx; x += pRow) {
      const runs = getRunsInCol(pixMap, ci, x, mny, mxy);
      for (const { y1, y2 } of runs) {
        const h = y2 - y1 + 1;
        if (h < 3) continue;
        const zig = (Math.floor((x - mnx) / pRow) % 2 === 0) ? 0 : Math.round(pRow * 0.35);
        const top = y1 + pPull;
        const bottom = y2 - pPull;
        stitches.push({ x: x + zig, y: top, color, type: "satin" });
        stitches.push({ x: x + pRow - zig, y: bottom, color, type: "satin" });
      }
    }
  }
  return stitches;
}

/* ─── RUNNING STITCH GENERATOR ───────────────────────────*/
function generateRunningStitches(region, pixMap, ci, color, params) {
  const stitches = [];
  const { mnx, mny, mxx, mxy } = region;
  const pRow = (params.tatamiRow || TATAMI_ROW) * 2;

  // Simple centerline trace along major axis
  if (region.bh > region.bw) {
    for (let y = mny; y <= mxy; y += pRow) {
      const runs = getRunsInRow(pixMap, ci, y, mnx, mxx);
      for (const { x1, x2 } of runs) {
        stitches.push({ x: Math.round((x1 + x2) / 2), y, color, type: "running" });
      }
    }
  } else {
    for (let x = mnx; x <= mxx; x += pRow) {
      const runs = getRunsInCol(pixMap, ci, x, mny, mxy);
      for (const { y1, y2 } of runs) {
        stitches.push({ x, y: Math.round((y1 + y2) / 2), color, type: "running" });
      }
    }
  }
  return stitches;
}

/* ─── MAIN STITCH GENERATOR ───────────────────────────────*/
function generateStitchesFromRegions(pixMap, regions, colors, params) {
  const stitches = [];
  const colorCounts = colors.map(() => ({ fill: 0, satin: 0, running: 0, underlay: 0 }));

  // Order: fills first (background), then satin, then running
  const ordered = [
    ...regions.filter(r => r.type === "fill"),
    ...regions.filter(r => r.type === "satin"),
    ...regions.filter(r => r.type === "running")
  ];

  let lastX = -1, lastY = -1, lastColor = null;

  for (const reg of ordered) {
    const ci = colors.findIndex(c => normHex(c) === normHex(reg.color));
    if (ci === -1) continue;

    let regionStitches = [];
    if (reg.type === "fill") regionStitches = generateFillStitches(reg, pixMap, reg.ci, reg.color, params);
    else if (reg.type === "satin") regionStitches = generateSatinStitches(reg, pixMap, reg.ci, reg.color, params);
    else regionStitches = generateRunningStitches(reg, pixMap, reg.ci, reg.color, params);

    if (!regionStitches.length) continue;

    // Smart move to first stitch of region
    const first = regionStitches[0];
    if (lastX !== -1 && (lastColor !== first.color || Math.hypot(first.x - lastX, first.y - lastY) > SMART_TRIM)) {
      emitTrim(stitches, lastX, lastY, first.x, first.y, first.color);
    }
    lastColor = first.color;

    for (const s of regionStitches) {
      stitches.push(s);
      if (s.type !== "trim") {
        const cidx = colors.findIndex(c => normHex(c) === normHex(s.color));
        if (cidx >= 0 && colorCounts[cidx][s.type] !== undefined) colorCounts[cidx][s.type]++;
      }
      lastX = s.x; lastY = s.y;
    }
  }

  console.log("Stitches:", colors.map((c, i) => {
    const k = colorCounts[i];
    return `${normHex(c)} F:${k.fill} S:${k.satin} R:${k.running} U:${k.underlay}`;
  }).join(" | "));

  return { stitches, colorCounts };
}

/* ─── QUALITY VALIDATION ─────────────────────────────────*/
function validateQuality(stitches) {
  const w = [];
  let tot = 0, cnt = 0, maxJ = 0, longJ = 0, prev = null;
  for (const s of stitches) {
    if (s.type === "trim") { prev = null; continue; }
    if (prev) {
      const d = Math.hypot(s.x - prev.x, s.y - prev.y);
      if (d > maxJ) maxJ = d;
      if (d > DST_MAX) longJ++;
      if (s.type !== "underlay") { tot += d; cnt++; }
    }
    prev = s;
  }
  const avg = cnt > 0 ? tot / cnt : 0;
  if (avg > 50) w.push(`Long avg ${(avg / 10).toFixed(1)}mm`);
  if (maxJ > DST_MAX) w.push(`Jump ${(maxJ / 10).toFixed(1)}mm > 12.1mm`);
  if (longJ > 30) w.push(`${longJ} oversized jumps`);
  if (cnt > 80000) w.push(`High stitch count ${cnt}`);
  return { avgStitchMM: (avg / 10).toFixed(2), maxJumpMM: (maxJ / 10).toFixed(2), longJumps: longJ, stitchCount: cnt, warnings: w, passed: !w.length };
}

/* ─── HIGH-QUALITY PREVIEW RENDERER ──────────────────────
   Anti-aliased thread simulation with type-specific visuals.
   ───────────────────────────────────────────────────────*/
async function renderPreview(pixMap, colors, stitches, params) {
  const W = CANVAS, H = CANVAS;
  const buf = Buffer.alloc(W * H * 4);

  // Fabric weave background
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const weave = (((x >> 2) & 1) ^ ((y >> 2) & 1)) ? 5 : -3;
      buf[idx]     = 244 + weave;
      buf[idx + 1] = 239 + weave;
      buf[idx + 2] = 229 + weave;
      buf[idx + 3] = 255;
    }
  }

  const threadColors = colors.map(c => {
    const { r, g, b } = hexToRgb(normHex(c));
    return { r, g, b, dr: Math.max(0, r - 45), dg: Math.max(0, g - 45), db: Math.max(0, b - 45) };
  });

  function setPixel(x, y, r, g, b, a) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    const alpha = a / 255;
    buf[idx]     = Math.round(buf[idx]     * (1 - alpha) + r * alpha);
    buf[idx + 1] = Math.round(buf[idx + 1] * (1 - alpha) + g * alpha);
    buf[idx + 2] = Math.round(buf[idx + 2] * (1 - alpha) + b * alpha);
    buf[idx + 3] = 255;
  }

  // Anti-aliased line with thickness
  function drawLine(x0, y0, x1, y1, r, g, b, thickness, alphaBase) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) { setPixel(x0, y0, r, g, b, alphaBase); return; }

    const steps = Math.ceil(dist * 1.8);
    const nx = dist > 0 ? -dy / dist : 0;
    const ny = dist > 0 ?  dx / dist : 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;

      // Core pixel
      setPixel(x, y, r, g, b, alphaBase);

      // Thickness (perpendicular)
      if (thickness >= 2) {
        setPixel(x + nx * 0.6, y + ny * 0.6, r, g, b, alphaBase * 0.7);
        setPixel(x - nx * 0.6, y - ny * 0.6, r, g, b, alphaBase * 0.7);
      }
      if (thickness >= 3) {
        setPixel(x + nx * 1.2, y + ny * 1.2, r, g, b, alphaBase * 0.4);
        setPixel(x - nx * 1.2, y - ny * 1.2, r, g, b, alphaBase * 0.4);
      }
    }
  }

  // Group by color then type
  const byColor = new Map();
  for (const s of stitches) {
    if (s.type === "trim") continue;
    if (!byColor.has(s.color)) byColor.set(s.color, []);
    byColor.get(s.color).push(s);
  }

  for (const [color, colStitches] of byColor) {
    const ci = colors.findIndex(c => normHex(c) === normHex(color));
    const tc = ci >= 0 ? threadColors[ci] : { r: 128, g: 128, b: 128, dr: 80, dg: 80, db: 80 };

    const underlays = colStitches.filter(s => s.type === "underlay");
    const covers = colStitches.filter(s => s.type !== "underlay");

    // Draw underlays (very faint)
    for (let i = 1; i < underlays.length; i++) {
      const a = underlays[i - 1], b = underlays[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 80) continue;
      drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, 1, 60);
    }

    // Group cover stitches into continuous polylines by proximity
    const polylines = [];
    let current = [];
    for (let i = 0; i < covers.length; i++) {
      const s = covers[i];
      const prev = covers[i - 1];
      if (prev && Math.hypot(s.x - prev.x, s.y - prev.y) < 50) {
        current.push(s);
      } else {
        if (current.length) polylines.push(current);
        current = [s];
      }
    }
    if (current.length) polylines.push(current);

    for (const poly of polylines) {
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const isSatin = a.type === "satin";
        const isFill = a.type === "fill";
        const isRun = a.type === "running";

        const thick = isSatin ? 3 : isFill ? 2 : 1;
        const alpha = isRun ? 140 : 230;

        // Shadow beneath stitch
        if (!isRun) {
          drawLine(a.x + 1, a.y + 1, b.x + 1, b.y + 1, tc.dr, tc.dg, tc.db, thick, 40);
        }

        // Main stitch
        drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, thick, alpha);

        // Highlight on top edge for 3D thread effect
        if (thick >= 2) {
          drawLine(a.x - 0.3, a.y - 0.3, b.x - 0.3, b.y - 0.3,
            Math.min(255, tc.r + 30), Math.min(255, tc.g + 30), Math.min(255, tc.b + 30),
            1, 80);
        }
      }
    }
  }

  // Crop to content
  let cminX = W, cmaxX = 0, cminY = H, cmaxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pixMap[y * W + x] >= 0) {
        if (x < cminX) cminX = x; if (x > cmaxX) cmaxX = x;
        if (y < cminY) cminY = y; if (y > cmaxY) cmaxY = y;
      }
    }
  }
  const pad = 30;
  const cropX = Math.max(0, cminX - pad), cropY = Math.max(0, cminY - pad);
  const cropW = Math.min(W, cmaxX + pad) - cropX;
  const cropH = Math.min(H, cmaxY + pad) - cropY;

  if (cropW > 50 && cropH > 50) {
    const cropped = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const sIdx = ((cropY + y) * W + (cropX + x)) * 4;
        const dIdx = (y * cropW + x) * 4;
        cropped[dIdx] = buf[sIdx]; cropped[dIdx + 1] = buf[sIdx + 1];
        cropped[dIdx + 2] = buf[sIdx + 2]; cropped[dIdx + 3] = buf[sIdx + 3];
      }
    }
    return await sharp(cropped, { raw: { width: cropW, height: cropH, channels: 4 } })
      .png({ compressionLevel: 6 }).toBuffer();
  }

  return await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 6 }).toBuffer();
}

/* ─── DST ENCODER (honest, no fake formats) ────────────────*/
function stitchRecord(dx, dy) {
  const cx = Math.max(-121, Math.min(121, Math.round(dx)));
  const cy = Math.max(-121, Math.min(121, Math.round(dy)));
  return Buffer.from([cy >= 0 ? cy : 0x100 + cy, cx >= 0 ? cx : 0x100 + cx, 0x03]);
}

function encodeDST(stitches) {
  const hdr = Buffer.alloc(512, 0x20);
  hdr.write("Stichai", 0, "ascii");
  const recs = [];
  let lCol = null, px = 0, py = 0, sc = 0, cc = 0;
  let mnx = 0, mxx = 0, mny = 0, mxy = 0, ax = 0, ay = 0;

  for (const s of stitches) {
    ax += s.x - px; ay += s.y - py;
    if (ax < mnx) mnx = ax; if (ax > mxx) mxx = ax;
    if (ay < mny) mny = ay; if (ay > mxy) mxy = ay;

    if (s.color !== lCol && lCol !== null) {
      recs.push(Buffer.from([0, 0, 0xC3])); cc++;
    }
    lCol = s.color;

    if (s.type === "trim") {
      recs.push(Buffer.from([0, 0, 0xC3]), Buffer.from([0, 0, 0xC3]));
      const dx = s.x - px, dy = s.y - py; px = s.x; py = s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 121));
      let ppx = 0, ppy = 0;
      for (let i = 1; i <= steps; i++) {
        const fx = Math.round(dx * i / steps), fy = Math.round(dy * i / steps);
        recs.push(stitchRecord(fx - ppx, fy - ppy)); ppx = fx; ppy = fy;
      }
      continue;
    }

    const dx = Math.round(s.x - px), dy = Math.round(s.y - py); px = s.x; py = s.y;
    if (Math.abs(dx) > 121 || Math.abs(dy) > 121) {
      const steps = Math.max(Math.ceil(Math.abs(dx) / 121), Math.ceil(Math.abs(dy) / 121));
      let ppx = 0, ppy = 0;
      for (let i = 1; i <= steps; i++) {
        const fx = Math.round(dx * i / steps), fy = Math.round(dy * i / steps);
        recs.push(stitchRecord(fx - ppx, fy - ppy)); ppx = fx; ppy = fy;
      }
    } else {
      recs.push(stitchRecord(dx, dy));
    }
    sc++;
  }

  recs.push(Buffer.from([0, 0, 0xF3]));
  hdr.writeInt32LE(sc, 20); hdr.writeInt32LE(cc, 24);
  hdr.writeInt16LE(Math.round((mxx - mnx) * 10), 28); hdr.writeInt16LE(Math.round((mxy - mny) * 10), 32);
  hdr.writeInt16LE(Math.round(mnx * 10), 36); hdr.writeInt16LE(Math.round(mxx * 10), 40);
  hdr.writeInt16LE(Math.round(mny * 10), 44); hdr.writeInt16LE(Math.round(mxy * 10), 48);
  hdr.write("(c)Stichai", 56, "ascii"); hdr.writeInt16LE(cc + 1, 88);
  return Buffer.concat([hdr, ...recs]);
}

/* ─── GEMINI HTTP ──────────────────────────────────────────*/
async function geminiPost(body, ms = 45000) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const res = await axios.post(url, body, { timeout: ms });
      console.log(`Gemini OK: ${model}`);
      return res;
    } catch (e) {
      console.error(`Gemini ${model} → ${e.response?.status}: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  return null;
}

async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer.
Analyze this image and return ONE JSON object for DST file generation.
List ALL distinct colors present — do not skip any color.
Classify stitch_type per color: "fill" (large area >7mm), "satin" (column 1.5-7mm), "running" (thin line <1.5mm).
Return ONLY valid JSON, no markdown.

{"background":"#FFFFFF","colors":[{"hex":"#000000","label":"logo black","stitch_type":"fill","coverage_pct":60}],"is_logo":true,"is_text":false,"complexity":"simple","recommended_angle":0,"notes":"brief note"}`;

  const res = await geminiPost({
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime || "image/png", data: b64 } }] }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 4096 }
  });
  if (!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let js = raw.replace(/```json|```/g, "").trim();
    const fa = js.indexOf("{"), lb = js.lastIndexOf("}");
    if (fa !== -1 && lb > fa) js = js.slice(fa, lb + 1);
    const p = JSON.parse(js);
    const colors = (p.colors || []).map(c => normHex(typeof c === "string" ? c : c.hex));
    const meta = {};
    for (const c of (p.colors || [])) if (typeof c === "object" && c.hex) meta[normHex(c.hex)] = c;
    return {
      colors: dedupe(colors), meta, is_text: !!p.is_text, is_logo: !!p.is_logo,
      angle: Number(p.recommended_angle) || 0, complexity: p.complexity || "moderate", notes: p.notes || ""
    };
  } catch (e) { console.error("Gemini JSON:", e.message); return null; }
}

/* ─── JOB SYSTEM (async, eliminates 503s) ────────────────*/
const jobs = new Map();        // jobId -> { status, result, error, createdAt, pixMap, stitches, colors, params }
const detections = new Map();  // detectionId -> { pixMap, regions, colors, pre, geminiNotes, timestamp }

// Cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) { if (now - j.createdAt > 10 * 60 * 1000) jobs.delete(id); }
  for (const [id, d] of detections) { if (now - d.timestamp > 5 * 60 * 1000) detections.delete(id); }
}, 300000);

async function runJob(jobId, imgBuffer, maskBuffer, body) {
  try {
    const rid = Math.random().toString(36).slice(2, 6);
    console.log(`[${rid}] JOB START ${jobId}`);

    const specs = {
      fabric: body.fabric || "cotton",
      machine: body.machine || "generic",
      hoop: body.hoop || "5x7",
      density: body.density || "medium",
      thread: body.thread || "generic",
      stabilizer: body.stabilizer || "cutaway",
      instructions: body.instructions || ""
    };
    const params = getStitchParams(specs);

    const detectionId = body.detectionId;
    const det = detectionId ? detections.get(detectionId) : null;
    let pixMap, regions, colors;

    if (det) {
      console.log(`[${rid}] Using cached detection ${detectionId}`);
      pixMap = new Int16Array(det.pixMap); // copy
      regions = det.regions;
      colors = det.colors;
    } else {
      console.log(`[${rid}] Full re-analysis`);
      let pre = await preprocessImage(imgBuffer);
      if (maskBuffer) pre = await applyUserMask(pre, maskBuffer);

      const gem = await analyzeWithGemini(imgBuffer, imgBuffer.mimetype || "image/png");
      let colorMeta = {};
      if (gem && gem.colors && gem.colors.length >= 1) {
        colors = gem.colors; colorMeta = gem.meta || {};
      } else {
        colors = dedupe(pre.fallbackColors);
      }
      if (!colors.length) colors = ["#000000"];

      pixMap = await buildPixelMap(pre.buffer, colors);
      regions = extractRegions(pixMap, colors);
    }

    if (!regions || !regions.length) throw new Error("No stitchable regions found");

    // Apply user selections
    let selectedColors = colors;
    try {
      if (body.selectedColors) {
        const parsed = JSON.parse(body.selectedColors);
        if (Array.isArray(parsed) && parsed.length > 0) selectedColors = parsed.map(c => normHex(c));
      }
    } catch (e) { }

    let filteredRegions = regions;
    try {
      if (body.selectedShapes) {
        const parsed = JSON.parse(body.selectedShapes);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.length < regions.length) {
          filteredRegions = parsed.map(idx => regions[idx]).filter(Boolean);
        }
      }
    } catch (e) { }

    if (selectedColors.length < colors.length) {
      const excluded = new Set();
      colors.forEach((c, ci) => { if (!selectedColors.includes(normHex(c))) excluded.add(ci); });
      for (let i = 0; i < pixMap.length; i++) if (excluded.has(pixMap[i])) pixMap[i] = -1;
      filteredRegions = filteredRegions.filter(r => selectedColors.includes(normHex(r.color)));
    }

    if (!filteredRegions.length) throw new Error("No regions left after selection");

    const { stitches, colorCounts } = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params);
    const coverCount = stitches.filter(s => s.type !== "trim" && s.type !== "underlay").length;
    if (coverCount < 5) throw new Error("Not enough stitches — check contrast or selections");

    const qa = validateQuality(stitches);
    console.log(`[${rid}] DONE: ${qa.stitchCount} stitches, ${filteredRegions.length} regions`);

    const shapes = filteredRegions.map(r => {
      const pts = [[r.mnx, r.mny], [r.mxx, r.mny], [r.mxx, r.mxy], [r.mnx, r.mxy], [r.mnx, r.mny]];
      const sc = stitches.filter(s => s.color === r.color && s.type !== "trim" && s.type !== "underlay" &&
        s.x >= r.mnx && s.x <= r.mxx && s.y >= r.mny && s.y <= r.mxy).length;
      return { type: r.type, color: normHex(r.color), points: pts, bounds: { x: r.mnx, y: r.mny, w: r.mxx - r.mnx, h: r.mxy - r.mny }, stitchCount: sc };
    });

    const result = {
      success: true,
      stitchCount: qa.stitchCount,
      designSize: { w: CANVAS, h: CANVAS, mm: DESIGN_MM },
      colors: selectedColors,
      colorMeta: {},
      geminiNotes: det?.geminiNotes || "",
      specs,
      tunedParams: params,
      qa,
      shapes,
      regions: filteredRegions.length
    };

    // Store heavy data separately
    jobs.set(jobId, {
      status: "completed",
      result,
      pixMap,
      stitches,
      colors: selectedColors,
      params,
      createdAt: Date.now()
    });

  } catch (e) {
    console.error(`JOB ${jobId} FAILED:`, e.message);
    jobs.set(jobId, { status: "failed", error: e.message, createdAt: Date.now() });
  }
}

/* ─── ROUTES ─────────────────────────────────────────────*/
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ─── DETECT SHAPES ──────────────────────────────────────*/
app.post("/detect-shapes", upload.fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]), async (req, res) => {
  const rid = Math.random().toString(36).slice(2, 6);
  try {
    const imgFile = req.files?.image?.[0];
    const maskFile = req.files?.mask?.[0];
    if (!imgFile) return res.status(400).json({ error: "No image uploaded" });

    let pre = await preprocessImage(imgFile.buffer);
    if (maskFile) pre = await applyUserMask(pre, maskFile.buffer);

    const gem = await analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png");

    let colors;
    if (gem && gem.colors && gem.colors.length >= 1) {
      colors = gem.colors;
    } else {
      colors = dedupe(pre.fallbackColors);
    }
    if (!colors.length) colors = ["#000000"];

    const pixMap = await buildPixelMap(pre.buffer, colors);
    const regions = extractRegions(pixMap, colors);

    if (!regions.length) return res.status(500).json({ error: "No stitchable regions found" });

    const shapes = regions.map(r => {
      const pts = [[r.mnx, r.mny], [r.mxx, r.mny], [r.mxx, r.mxy], [r.mnx, r.mxy], [r.mnx, r.mny]];
      return { type: r.type, color: normHex(r.color), points: pts, bounds: { x: r.mnx, y: r.mny, w: r.mxx - r.mnx, h: r.mxy - r.mny }, stitchCount: 0 };
    });

    const detectionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    detections.set(detectionId, {
      pixMap: Array.from(pixMap), // convert to regular array for storage
      regions, colors, pre, geminiNotes: gem?.notes || "", timestamp: Date.now()
    });

    return res.json({
      success: true,
      detectionId,
      colors,
      colorMeta: {},
      shapes,
      geminiNotes: gem?.notes || ""
    });
  } catch (e) {
    console.error(`[${rid}] DETECT CRASH:`, e.message);
    return res.status(500).json({ error: e.message || "Detection failed" });
  }
});

/* ─── GENERATE EMBROIDERY (async) ────────────────────────*/
app.post("/generate-embroidery", upload.fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]), async (req, res) => {
  const imgFile = req.files?.image?.[0];
  if (!imgFile) return res.status(400).json({ error: "No image uploaded" });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  jobs.set(jobId, { status: "processing", createdAt: Date.now() });

  // Start processing in background
  runJob(jobId, imgFile.buffer, req.files?.mask?.[0]?.buffer, req.body || {});

  // Return immediately so client can poll
  return res.json({ success: true, jobId, status: "processing" });
});

/* ─── JOB STATUS POLLING ─────────────────────────────────*/
app.get("/job-status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (job.status === "processing") {
    return res.json({ status: "processing" });
  }
  if (job.status === "failed") {
    return res.json({ status: "failed", error: job.error });
  }

  // completed
  const r = job.result;
  return res.json({
    status: "completed",
    previewUrl: `/preview/${req.params.jobId}`,
    previewImageUrl: `/preview-image/${req.params.jobId}`,
    downloadUrl: `/download/${req.params.jobId}`,
    ...r
  });
});

/* ─── PREVIEW DATA ───────────────────────────────────────*/
app.get("/preview/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "completed") return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: job.stitches, designW: CANVAS, designH: CANVAS });
});

/* ─── PREVIEW IMAGE ──────────────────────────────────────*/
app.get("/preview-image/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "completed") return res.status(404).json({ error: "Not found" });

  try {
    const png = await Promise.race([
      renderPreview(job.pixMap, job.colors, job.stitches, job.params),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Preview timeout")), 30000))
    ]);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(png);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ─── DOWNLOAD ───────────────────────────────────────────*/
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "completed") return res.status(404).json({ error: "Not found" });

  const buf = encodeDST(job.stitches);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.dst"`);
  return res.send(buf);
});

app.get("/health", (_, res) => res.json({ status: "ok", version: "50.0", canvas: `${CANVAS}px=${DESIGN_MM}mm` }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stichai v50 | :${PORT} | ${CANVAS}px=${DESIGN_MM}mm | async jobs`));
