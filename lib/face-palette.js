"use strict";
/**
 * lib/face-palette.js
 *
 * Detect face rectangles in the input image and return a list of additional
 * thread colors sampled from inside those rectangles. The caller prepends those
 * colors to the global palette used in `extractColorsFromUnmasked`, so facial
 * features (skin tones, lips, eyes, brows, hair near face) are guaranteed to
 * survive the global quantization step.
 *
 * Approach:
 *   1. Downsample input to a small canvas (e.g. 200x200 FPO) for fast scan.
 *   2. Skin-tone mask: HSV with H in [0..40] (red→orange→yellow skin tones) AND
 *      S > 25 AND V > 35, expanded to include a broad set of skin types.
 *   3. Flood-fill the largest connected skin components (max 2 faces).
 *   4. For each bounding box: pull high-res pixels from the original buffer and
 *      run k-means into N colors (default 4). Output hex colors.
 */

const sharp = require("sharp");
const { hexToRgb } = require("./image");

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bb = b / 255;
  const mx = Math.max(rn, gn, bb), mn = Math.min(rn, gn, bb);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === rn) h = ((gn - bb) / d) % 6;
    else if (mx === gn) h = (bb - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx;
  return [h, s * 100, v * 100];
}

function isSkin(r, g, b) {
  // Magenta chroma-key: reject backdrop colors that bleed into face rectangles.
  // Matches the image.js holdoutBackdrop key: high R+B, low G.
  if (r > 150 && b > 150 && g < 90 && Math.abs(r - b) < 60) return false;
  const [h, s, v] = rgbToHsv(r, g, b);
  // Wide skin range: warm hue, modest sat, modest brightness.
  // Includes cartoon-style flat skin tones that may have low saturation.
  if (v < 25 || s < 18) return false;
  // Warm hue: red→orange→yellow (0–55°) ONLY.
  // Removed h>=335 (magenta-red band) — it accepted the magenta backdrop as skin.
  if (h <= 55) return true;
  // Pale/warm-grey skin: low saturation, warm hue, mid brightness
  if (s < 38 && v > 55 && h <= 70) return true;
  return false;
}

function findFaces(rgbaBuf, W, H) {
  // Build skin mask
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (isSkin(rgbaBuf[o], rgbaBuf[o + 1], rgbaBuf[o + 2])) mask[i] = 1;
  }
  // Flood-fill: collect connected components via BFS, find largest (and second-largest)
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !mask[s]) continue;
    let top = 0; stack[top++] = s; seen[s] = 1;
    let x0 = W, x1 = 0, y0 = H, y1 = 0, area = 0;
    while (top > 0) {
      const i = stack[--top];
      area++;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0     && !seen[i - 1] && mask[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && mask[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0     && !seen[i - W] && mask[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (y < H - 1 && !seen[i + W] && mask[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    if (area >= (W * H * 0.01)) comps.push({ area, x0, y0, x1, y1 });
  }
  comps.sort((p, q) => q.area - p.area);
  return comps.slice(0, 2);
}

function kmeansHex(pixels, k, iters = 6) {
  // pixels: array of [r,g,b]
  if (!pixels.length) return [];
  // Init: k-means++ style — first random, rest by distance
  const cents = [];
  const seed = pixels[Math.floor(Math.random() * pixels.length)];
  cents.push([seed[0], seed[1], seed[2]]);
  while (cents.length < k && cents.length < pixels.length) {
    let bestIdx = -1, bestD = -1;
    for (let i = 0; i < pixels.length; i += 8) { // subsample for speed
      let mind = Infinity;
      for (const c of cents) {
        const dr = pixels[i][0] - c[0], dg = pixels[i][1] - c[1], db = pixels[i][2] - c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < mind) mind = d;
      }
      if (mind > bestD) { bestD = mind; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const p = pixels[bestIdx];
    cents.push([p[0], p[1], p[2]]);
  }
  for (let it = 0; it < iters; it++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      let mind = Infinity, bj = 0;
      for (let j = 0; j < cents.length; j++) {
        const dr = p[0] - cents[j][0], dg = p[1] - cents[j][1], db = p[2] - cents[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < mind) { mind = d; bj = j; }
      }
      sums[bj][0] += p[0]; sums[bj][1] += p[1]; sums[bj][2] += p[2]; sums[bj][3] += 1;
    }
    for (let j = 0; j < cents.length; j++) {
      if (sums[j][3] > 0) {
        cents[j][0] = sums[j][0] / sums[j][3];
        cents[j][1] = sums[j][1] / sums[j][3];
        cents[j][2] = sums[j][2] / sums[j][3];
      }
    }
  }
  return cents
    .map((c, i) => {
      const r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
      return "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0");
    });
}

/**
 * Main entry. Input: raw image buffer (any size).
 * Output: array of face-region hex colors.
 */
async function extractFacePalette(buffer, opts = {}) {
  const k = Math.min(6, Math.max(2, parseInt(opts.colorsPerFace) || 4));
  const scanW = Math.min(200, parseInt(opts.scanWidth) || 200);
  // Downsample for face scan
  const { data: scanRaw, info: scanInfo } = await sharp(buffer).resize(scanW, scanW, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const { data: fullRaw, info: fullInfo } = await sharp(buffer).resize(800, 800, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const scanChannels = scanInfo.channels; // raw RGB is 3 channels
  const fullChannels = fullInfo.channels;
  // Build rgba buffer for the scan (skip alpha handling since sharp raw gives RGB)
  const faces = findFaces(scanRaw, scanInfo.width, scanInfo.height);

  // Map scan bbox to full bbox
  const sx = fullInfo.width / scanInfo.width, sy = fullInfo.height / scanInfo.height;
  const out = [];
  for (const f of faces) {
    const fx0 = Math.max(0, Math.floor(f.x0 * sx));
    const fy0 = Math.max(0, Math.floor(f.y0 * sy));
    const fx1 = Math.min(fullInfo.width - 1, Math.ceil(f.x1 * sx));
    const fy1 = Math.min(fullInfo.height - 1, Math.ceil(f.y1 * sy));
    const w = fx1 - fx0 + 1, h = fy1 - fy0 + 1;
    // Pull pixels in that rectangle on the full image
    const pixels = [];
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        const i = (y * fullInfo.width + x) * fullChannels;
        pixels.push([fullRaw[i], fullRaw[i + 1], fullRaw[i + 2]]);
      }
    }
    if (pixels.length < 50) continue;
    const colors = kmeansHex(pixels, k);
    out.push({ rect: { x0: fx0, y0: fy0, x1: fx1, y1: fy1 }, colors });
  }
  return out;
}

module.exports = { extractFacePalette, findFaces, isSkin };
