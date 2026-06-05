"use strict";

/**
 * Image preprocessing, pixel-map building, background removal and preview rendering.
 * Color utilities (hexToRgb, rgbToLab, dE, normHex, isNearWhite, isNearBlack) are
 * also defined here and exported for use by other modules.
 */

const sharp = require("sharp");

/* ── Color utilities ────────────────────────────────────── */
function hexToRgb(hex) {
  const m = (hex || "").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
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

function dE(a, b) {
  return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

function normHex(h) {
  const m = (h || "").match(/^#?([0-9a-fA-F]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : "#000000";
}

function isNearWhite(hex) { const { r, g, b } = hexToRgb(hex); return r > 230 && g > 230 && b > 230; }
function isNearBlack(hex) { const { r, g, b } = hexToRgb(hex); return r < 40  && g < 40  && b < 40;  }

/* ── Image preprocessing ────────────────────────────────── */
async function preprocessImage(buffer, canvasSize, mode) {
  // For cartoons the background is chroma-key magenta; pad with the SAME magenta
  // so portrait letterbox bars get dropped by the background remover (not filled).
  const padColor = (mode === "cartoon")
    ? { r: 255, g: 0, b: 255, alpha: 1 }
    : { r: 255, g: 255, b: 255, alpha: 1 };
  let pipeline = sharp(buffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: padColor });

  if (mode === "cartoon") {
    pipeline = pipeline
      .median(3)
      .blur(0.5)
      .modulate({ saturation: 1.7, brightness: 1.05 })
      .sharpen({ sigma: 2.0 })
      .linear(1.5, -28);
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const LEVELS = 5;
    const step   = 255 / (LEVELS - 1);
    for (let i = 0; i < data.length; i += info.channels) {
      data[i]     = Math.round(data[i]     / step) * step;
      data[i + 1] = Math.round(data[i + 1] / step) * step;
      data[i + 2] = Math.round(data[i + 2] / step) * step;
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .toFormat("png").toBuffer();
  }

  return pipeline.median(2).sharpen({ sigma: 1.0 }).linear(1.2, -15).toBuffer();
}

/* ── Mask-aware diversity color extraction ──────────────── */
async function extractColorsFromUnmasked(imageBuffer, maskBuffer, canvasSize, maxColors) {
  const SIZE   = 200;
  const BUCKET = 16;
  const MIN_DIST = 22;

  const imgRaw = await sharp(imageBuffer)
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw().toBuffer({ resolveWithObject: true });

  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer({ resolveWithObject: true }) : null;

  const { data: iData, info: iInfo } = imgRaw;
  const iCh  = iInfo.channels;
  const mData = maskRaw ? maskRaw.data  : null;
  const mCh   = maskRaw ? maskRaw.info.channels : 0;

  const bucketFreq = new Map();
  const bucketSums = new Map();
  let totalUnmasked = 0;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const iOff = i * iCh;
    if (mData) {
      const mOff = i * mCh;
      if (mData[mOff] > 140 && mData[mOff + 1] < 90 && mData[mOff + 2] < 90 && (mCh < 4 || mData[mOff + 3] > 30)) continue;
    }
    totalUnmasked++;
    const r = iData[iOff], g = iData[iOff + 1], b = iData[iOff + 2];
    const br = Math.min(255, Math.round(r / BUCKET) * BUCKET);
    const bg = Math.min(255, Math.round(g / BUCKET) * BUCKET);
    const bb = Math.min(255, Math.round(b / BUCKET) * BUCKET);
    const key = (br << 16) | (bg << 8) | bb;
    bucketFreq.set(key, (bucketFreq.get(key) || 0) + 1);
    if (!bucketSums.has(key)) bucketSums.set(key, { r: 0, g: 0, b: 0, n: 0 });
    const s = bucketSums.get(key);
    s.r += r; s.g += g; s.b += b; s.n++;
  }

  if (totalUnmasked === 0) return ["#000000"];

  const allBuckets = [];
  for (const [, freq] of bucketFreq) {
    const s   = bucketSums.get(Array.from(bucketFreq.keys()).find(k => bucketFreq.get(k) === freq));
    if (!s) continue;
    const avgR = Math.round(s.r / s.n);
    const avgG = Math.round(s.g / s.n);
    const avgB = Math.round(s.b / s.n);
    const hex  = "#" + [avgR, avgG, avgB].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    allBuckets.push({ hex: normHex(hex), lab: rgbToLab({ r: avgR, g: avgG, b: avgB }), freq, pct: freq / totalUnmasked });
  }
  allBuckets.sort((a, b) => b.freq - a.freq);

  const selected = [];
  for (const bucket of allBuckets) {
    if (selected.length >= maxColors) break;
    if (!selected.some(s => dE(bucket.lab, s.lab) < MIN_DIST)) selected.push(bucket);
  }

  const result = selected.map(s => s.hex);

  // Ensure white/black are represented if they cover >1% of unmasked pixels
  let brightCount = 0, darkCount = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (mData) {
      const mOff = i * mCh;
      if (mData[mOff] > 140 && mData[mOff + 1] < 90 && mData[mOff + 2] < 90 && (mCh < 4 || mData[mOff + 3] > 30)) continue;
    }
    const iOff = i * iCh;
    if (iData[iOff] > 240 && iData[iOff + 1] > 240 && iData[iOff + 2] > 240) brightCount++;
    if (iData[iOff] < 30  && iData[iOff + 1] < 30  && iData[iOff + 2] < 30)  darkCount++;
  }
  if (!result.some(c => isNearWhite(c)) && brightCount / totalUnmasked > 0.01) {
    result.unshift("#FFFFFF");
    if (result.length > maxColors) result.pop();
  }
  if (!result.some(c => isNearBlack(c)) && darkCount / totalUnmasked > 0.01) {
    result.push("#000000");
    if (result.length > maxColors) result.shift();
  }

  console.log(`Extracted ${result.length}/${maxColors} colors: ${result.join(", ")}`);
  return result.length ? result : ["#000000"];
}

/* ── Pixel map (mask-aware, full resolution) ────────────── */
async function buildPixelMap(imageBuffer, maskBuffer, colors, canvasSize) {
  const imgRaw = await sharp(imageBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw().toBuffer({ resolveWithObject: true });

  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer({ resolveWithObject: true }) : null;

  const { data: iData, info: iInfo } = imgRaw;
  const iCh  = iInfo.channels;
  const mData = maskRaw ? maskRaw.data  : null;
  const mCh   = maskRaw ? maskRaw.info.channels : 0;

  const labC   = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixMap = new Int16Array(canvasSize * canvasSize).fill(-1);

  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      const idx  = y * canvasSize + x;
      const iOff = idx * iCh;
      if (mData) {
        const mOff = idx * mCh;
        if (mData[mOff] > 140 && mData[mOff + 1] < 90 && mData[mOff + 2] < 90 && (mCh < 4 || mData[mOff + 3] > 30)) continue;
      }
      const lab  = rgbToLab({ r: iData[iOff], g: iData[iOff + 1], b: iData[iOff + 2] });
      let best = 0, bestD = Infinity;
      for (let c = 0; c < labC.length; c++) {
        const d = dE(lab, labC[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      pixMap[idx] = best;
    }
  }
  return pixMap;
}

/* ── imgly background removal ───────────────────────────── */
let _imglyLib = undefined;
async function loadImglyBgRemoval() {
  // Disabled on Railway — model download blocks thread on cold start
  // Set ENABLE_IMGLY=1 to re-enable
  if (process.env.ENABLE_IMGLY !== "1") { _imglyLib = null; return null; }
  if (_imglyLib !== undefined) return _imglyLib;
  try {
    _imglyLib = require("@imgly/background-removal-node");
    console.log("[imgly] loaded OK");
    return _imglyLib;
  } catch (e) {
    console.warn("[imgly] not installed — falling back to Gemini grid");
    _imglyLib = null;
    return null;
  }
}

async function removeBackgroundImgly(imageBuffer, mime) {
  const lib = await loadImglyBgRemoval();
  if (!lib) return null;
  try {
    const { Blob } = require("buffer");
    const blob   = new Blob([imageBuffer], { type: mime || "image/jpeg" });
    const result = await lib.removeBackground(blob, { model: "small", output: { format: "image/png", quality: 1.0 } });
    return Buffer.from(await result.arrayBuffer());
  } catch (e) {
    console.error("[imgly] error:", e.message);
    return null;
  }
}

/* ── Fast preview render ────────────────────────────────── */
async function renderPreviewFast(regions, colors, canvasSize) {
  const size   = Math.min(canvasSize, 800);
  const scale  = size / canvasSize;
  const fabric = { r: 245, g: 240, b: 232 };

  let preview = await sharp({
    create: { width: size, height: size, channels: 3, background: fabric }
  }).png().toBuffer();

  const layers = [];
  for (const reg of regions) {
    const { r, g, b } = hexToRgb(reg.color);
    const left   = Math.round(reg.mnx * scale);
    const top    = Math.round(reg.mny * scale);
    const width  = Math.max(1, Math.round((reg.mxx - reg.mnx + 1) * scale));
    const height = Math.max(1, Math.round((reg.mxy - reg.mny + 1) * scale));
    const colorBuf = await sharp({
      create: { width, height, channels: 3, background: { r, g, b } }
    }).png().toBuffer();
    layers.push({ input: colorBuf, left, top, blend: "over" });
  }

  if (layers.length) {
    preview = await sharp(preview).composite(layers).png().toBuffer();
  }
  return preview;
}

module.exports = {
  hexToRgb,
  rgbToLab,
  dE,
  normHex,
  isNearWhite,
  isNearBlack,
  preprocessImage,
  extractColorsFromUnmasked,
  buildPixelMap,
  removeBackgroundImgly,
  renderPreviewFast,
};
