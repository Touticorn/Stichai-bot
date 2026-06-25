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
      .linear(1.2, -15) // step4: was (1.5,-28) — mapped grey (176) to white, losing hair fill;
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

/* ── Tier-5c: photo-mode luminance pre-pass LUT ─────────────────────
 *
 * Photo inputs (mode === "photo") historically look hieroglyphic because
 * the full luminance range gets posterized to N buckets too coarsely.
 * Apply a sigmoid-tone-mapping LUT that boosts shadow detail and pulls
 * highlights down before the main quantize -> posterize pipeline.
 *
 *   lut[i] = 255 / (1 + exp(-(i-128)/24));
 *
 * Pulls midtones out, compresses highlights, lifts shadows enough that
 * face shadow regions (L=20-40) map to ~80-120 instead of black, which
 * means posterize keeps them as their own color bucket (e.g. "warm shadow")
 * instead of collapsing to background.
 */
async function preprocessPhotoImage(buffer, canvasSize) {
  try {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.round(255 / (1 + Math.exp(-(i - 128) / 24)));
    }
    const raw = await sharp(buffer)
      .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .median(2)
      .raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    for (let i = 0; i < data.length; i += info.channels) {
      data[i]     = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
    return await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .png().toBuffer();
  } catch (e) {
    console.warn(`preprocessPhotoImage skipped: ${e?.message || e}`);
    return buffer;
  }
}

/* ── Mask-aware diversity color extraction ──────────────── */
async function extractColorsFromUnmasked(imageBuffer, maskBuffer, canvasSize, maxColors) {
  const SIZE   = 200;
  const BUCKET = 8;       // was 16 — finer buckets keep near-adjacent same-hue skin tones separate
  const MIN_DIST = 18;    // was 22 — lower threshold so similar warm tones don't merge

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
    // Chroma-key magenta (#FF00FF and any saturated magenta variant).
    // Without this, magenta letterbox AND magenta inked ON figures
    // (Stridex-pride hair, magenta clothing) flood the bucket histogram
    // and palette extraction returns just ["#FF00FF"].
    const _pr = iData[iOff], _pg = iData[iOff + 1], _pb = iData[iOff + 2];
    if (_pr > 150 && _pb > 150 && _pg < 90 && Math.abs(_pr - _pb) < 60) continue;
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

  if (totalUnmasked === 0) {
    console.warn(`[extractColors] totalUnmasked===0 after masks — cartoon is fully masked?`);
    return ["#000000"];
  }

  const allBuckets = [];
  for (const [key, freq] of bucketFreq) {
    const s   = bucketSums.get(key); // FIX: was re-finding by frequency value (wrong bucket on ties)
    if (!s) continue;
    const avgR = Math.round(s.r / s.n);
    const avgG = Math.round(s.g / s.n);
    const avgB = Math.round(s.b / s.n);
    const hex  = "#" + [avgR, avgG, avgB].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    allBuckets.push({ hex: normHex(hex), lab: rgbToLab({ r: avgR, g: avgG, b: avgB }), freq, pct: freq / totalUnmasked });
  }
  allBuckets.sort((a, b) => b.freq - a.freq);

  // DEBUG ONLY — opt-in via STICHAI_DEBUG_PALETTE; helps when bucketing collapses to 1 hue
  if (process.env.STICHAI_DEBUG_PALETTE === "1") {
    const topn = allBuckets.slice(0, 8).map(b => `${b.hex}@${(b.pct*100).toFixed(1)}%`);
    console.log(`[extractColors] DEBUG top-8 buckets: ${topn.join(" ")} (total=${allBuckets.length}, unmasked=${totalUnmasked})`);
  }

  // Thin-region-isolation guard: if two adjacent buckets are within MIN_DIST
  // AND both cover >= 4% of the unmasked area, keep them separate. Without this
  // the arms/torso/lips/etc. of similar warm tones all collapse into one bucket.
  const MIN_AREA_PCT = 0.04;
  const selected = [];
  for (const bucket of allBuckets) {
    if (selected.length >= maxColors) break;
    const tooSimilar = selected.find(s => dE(bucket.lab, s.lab) < MIN_DIST);
    if (tooSimilar) {
      if (bucket.pct >= MIN_AREA_PCT && tooSimilar.pct >= MIN_AREA_PCT) {
        selected.push(bucket);  // both significant - keep separate
      }
      continue;
    }
    selected.push(bucket);
  }


  const result = selected.map(s => s.hex);

  // Ensure white/black are stitchable: count bright/dark pixels first, then
  // reserve slots in maxColors BEFORE adding them. This way:
  //   - if user picked 4 colors and image has white AND black → body extracts
  //     up to 2, then white+black fill the remaining 2 slots
  //   - if user picked 4 colors and image has only black → body extracts
  //     up to 3, then black fills the remaining 1 slot
  //   - if user picked 4 colors and image has neither → body extracts up to 4
  let brightCount = 0, darkCount = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (mData) {
      const mOff = i * mCh;
      if (mData[mOff] > 140 && mData[mOff + 1] < 90 && mData[mOff + 2] < 90 && (mCh < 4 || mData[mOff + 3] > 30)) continue;
    }
    const iOff = i * iCh;
    // Skip magenta pixels from brightCount so a magenta-heavy cartoon
    // doesn't artificially nudge white reservation logic.
    const _pr2 = iData[iOff], _pg2 = iData[iOff + 1], _pb2 = iData[iOff + 2];
    if (_pr2 > 150 && _pb2 > 150 && _pg2 < 90 && Math.abs(_pr2 - _pb2) < 60) continue;
    if (iData[iOff] > 240 && iData[iOff + 1] > 240 && iData[iOff + 2] > 240) brightCount++;
    if (iData[iOff] < 30  && iData[iOff + 1] < 30  && iData[iOff + 2] < 30)  darkCount++;
  }
  const wantWhite = !result.some(c => isNearWhite(c)) && brightCount / totalUnmasked > 0.01;
  const wantBlack = !result.some(c => isNearBlack(c)) && darkCount  / totalUnmasked > 0.01;
  const reservedSlots = (wantWhite ? 1 : 0) + (wantBlack ? 1 : 0);

  // Trim body palette so we have room for white/black.
  while (result.length > maxColors - reservedSlots) result.pop();
  if (wantWhite) result.unshift("#FFFFFF");
  if (wantBlack) result.push("#000000");
  // Final safety net: hard cap at exactly maxColors (covers edge cases).
  if (result.length > maxColors) result.length = maxColors;

  console.log(`Extracted ${result.length}/${maxColors} colors: ${result.join(", ")}`);
  return result.length ? result : ["#000000"];
}

/* ── Pixel map (mask-aware, full resolution) ────────────── */
function holdoutBackdrop(pm, N, rgb, ch) {
  if (process.env.STICHAI_SKIP_BG === "0") return;
  const total = N * N;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const seeds = [0, N - 1, (N - 1) * N, N * N - 1];
  const D2 = 60 * 60;
  let removed = 0;
  for (const s0 of seeds) {
    if (seen[s0]) continue;
    const o0 = s0 * ch, cr = rgb[o0], cg = rgb[o0 + 1], cb = rgb[o0 + 2];
    let top = 0; stack[top++] = s0; seen[s0] = 1;
    const comp = [];
    while (top > 0) {
      const i = stack[--top]; comp.push(i);
      const x = i % N, y = (i / N) | 0;
      const tryN = (j) => { if (seen[j]) return; const o = j * ch, dr = rgb[o]-cr, dg = rgb[o+1]-cg, db = rgb[o+2]-cb; if (dr*dr+dg*dg+db*db <= D2) { seen[j]=1; stack[top++]=j; } };
      if (x > 0) tryN(i-1);
      if (x < N-1) tryN(i+1);
      if (y > 0) tryN(i-N);
      if (y < N-1) tryN(i+N);
    }
    if (comp.length > total * 0.05) { for (const i of comp) pm[i] = -1; removed += comp.length; }
  }
  if (removed) console.log(`[bg] backdrop held out: ${removed}px (${(100*removed/total).toFixed(1)}%) corner color-flood`);
}

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
      // Chroma-key magenta background: drop the pixel BEFORE nearest-colour mapping.
      // Otherwise it maps to the nearest palette colour (often red) and survives the
      // region-level background drop. Magenta = green channel far below red AND blue.
      const _pr = iData[iOff], _pg = iData[iOff + 1], _pb = iData[iOff + 2];
      // Drop ONLY true saturated magenta (R&B high, G low, R~B symmetric).
      // The old "green far below red&blue" test also ate anti-aliased PINK and
      // CREAM edges (pink leans magenta), deleting the baby's sandals/gown.
      if (_pr > 150 && _pb > 150 && _pg < 90 && Math.abs(_pr - _pb) < 60) { continue; }
      let best = 0, bestD = Infinity;
      for (let c = 0; c < labC.length; c++) {
        const d = dE(lab, labC[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      pixMap[idx] = best;
    }
  }
  holdoutBackdrop(pixMap, canvasSize, iData, iCh);
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
async function renderPreviewFast(regions, colors, canvasSize, pixMap) {
  const size   = Math.min(canvasSize, 800);
  const scale  = size / canvasSize;
  const fabric = { r: 245, g: 240, b: 232 };

  // ACCURATE PATH: render the actual per-pixel shapes from pixMap.
  // Only pixels belonging to a KEPT region (after background drop) are drawn;
  // everything else (dropped background, unmatched) shows as fabric. This avoids
  // the old behaviour of painting each region's whole bounding-box rectangle,
  // which made a region with a large bbox look like a solid block.
  if (pixMap && pixMap.length === canvasSize * canvasSize) {
    try {
      const ciToRgb = {};
      for (const r of regions) {
        if (r && typeof r.ci === "number") ciToRgb[r.ci] = hexToRgb(r.color || "#000000");
      }
      const buf = Buffer.alloc(size * size * 3);
      const sStep = canvasSize / size;
      for (let y = 0; y < size; y++) {
        const sy = Math.min(canvasSize - 1, Math.floor(y * sStep));
        for (let x = 0; x < size; x++) {
          const sx = Math.min(canvasSize - 1, Math.floor(x * sStep));
          const ci = pixMap[sy * canvasSize + sx];
          const col = (ci >= 0 && ciToRgb[ci]) ? ciToRgb[ci] : fabric;
          const o = (y * size + x) * 3;
          buf[o] = col.r; buf[o + 1] = col.g; buf[o + 2] = col.b;
        }
      }
      return await sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
    } catch (e) {
      // fall through to the bbox renderer below
    }
  }

  // FALLBACK: legacy bounding-box rectangle render (used only if pixMap absent).
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

/* ── Magenta letterbox crop ──────────────────────────────────
 *
 * Cartoon regenerator output comes framed in a magenta (#FF00FF)
 * rectangle. preprocessImage() pads with the same magenta so the
 * background-remover does not paint it — but if cartoon generation
 * FAILED or any step leaves residual magenta, that border shows up
 * as green/blue/purple solid bars in the final stitch file (the
 * "letterbox bars eating canvas" complaint).
 *
 * This pass finds the bounding box of pixels NOT matching #FF00FF
 * and crops tightly. Falls back to no-op when no magenta is found
 * (i.e. the image is normal photo). Adds 6% margin to preserve
 * hoop-edge breathing room.
 */
async function cropMagentaLetterbox(imageBuffer) {
  try {
    if (!imageBuffer) return imageBuffer;
    const targetLab   = rgbToLab({ r: 255, g: 0, b: 255 });
    const SUBJECT_RE  = 240;  // total image side after sharp resize for analysis
    const { data, info } = await sharp(imageBuffer)
      .resize(SUBJECT_RE, SUBJECT_RE, { fit: "fill" })
      .raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, ch = info.channels;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    let magentaCount = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = y * W * ch + x * ch;
        const px = rgbToLab({ r: data[o], g: data[o + 1], b: data[o + 2] });
        if (dE(px, targetLab) < 8) magentaCount++;
        else {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const totalPx = W * H;
    // Need at least 4% magenta for this to be a letterboxed image.
    // Otherwise leave the image alone (probably no border at all).
    if (magentaCount < totalPx * 0.04) return imageBuffer;
    if (maxX < minX || maxY < minY)    return imageBuffer;
    // Apply 4% margin so we don't crop a baby's eyelashes off.
    const padX = Math.max(4, Math.round((maxX - minX) * 0.04));
    const padY = Math.max(4, Math.round((maxY - minY) * 0.04));
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    const x1 = Math.min(W - 1, maxX + padX);
    const y1 = Math.min(H - 1, maxY + padY);
    const cropW = x1 - x0 + 1;
    const cropH = y1 - y0 + 1;
    // Map back to original image coordinates.
    // BUGFIX: scale the 240-space bbox back to ORIGINAL image dims.
    // `info` is the 240x240 analysis buffer, so info.width/W == 1 and the crop
    // was applied unscaled, cropping a backdrop corner and losing the figure.
    const _origMeta = await sharp(imageBuffer).metadata();
    const sx = (_origMeta.width  || W) / W, sy = (_origMeta.height || H) / H;
    const realCrop = {
      left:   Math.round(x0 * sx),
      top:    Math.round(y0 * sy),
      width:  Math.round(cropW * sx),
      height: Math.round(cropH * sy),
    };
    return await sharp(imageBuffer).extract(realCrop).png().toBuffer();
  } catch (e) {
    console.warn(`cropMagentaLetterbox skipped: ${e?.message || e}`);
    return imageBuffer;
  }
}


async function buildOutlineMask(imageBuffer, canvasSize, lumThreshold) {
  const TH = lumThreshold || 70;
  // Erosion radius R: eats through thin outlines (~8-12px) but leaves
  // thick dark fills (hair, shadows, 30px+) intact as proper fill shapes.
  const R = 6, W = canvasSize, H = canvasSize;
  const imgRaw = await sharp(imageBuffer)
    .resize(W, H, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw().toBuffer({ resolveWithObject: true });
  const { data, info } = imgRaw; const ch = info.channels;
  // 1. raw dark mask
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i*ch, r=data[o], g=data[o+1], b=data[o+2];
    if (g < r-55 && g < b-55 && r > 110 && b > 110) continue;
    if (0.299*r + 0.587*g + 0.114*b < TH) dark[i] = 1;
  }
  // 2. 2-D prefix sum for O(1) box queries
  const ps = new Int32Array((W+1)*(H+1));
  for (let y=0;y<H;y++) for (let x=0;x<W;x++)
    ps[(y+1)*(W+1)+(x+1)] = dark[y*W+x] + ps[y*(W+1)+(x+1)] + ps[(y+1)*(W+1)+x] - ps[y*(W+1)+x];
  const bsum=(x0,y0,x1,y1)=>
    ps[(y1+1)*(W+1)+(x1+1)]-ps[y0*(W+1)+(x1+1)]-ps[(y1+1)*(W+1)+x0]+ps[y0*(W+1)+x0];
  // 3. mark only EDGE dark pixels (not fully surrounded = thin outline, not interior thick blob)
  const mask = new Uint8Array(W * H);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    if (!dark[y*W+x]) continue;
    const x0=Math.max(0,x-R),y0=Math.max(0,y-R),x1=Math.min(W-1,x+R),y1=Math.min(H-1,y+R);
    if (bsum(x0,y0,x1,y1) < (x1-x0+1)*(y1-y0+1)) mask[y*W+x] = 1;
  }
  return mask;
}

module.exports = {
  buildOutlineMask,
  hexToRgb,
  rgbToLab,
  dE,
  normHex,
  isNearWhite,
  isNearBlack,
  preprocessImage,
  preprocessPhotoImage,
  extractColorsFromUnmasked,
  buildPixelMap,
  cropMagentaLetterbox,
  removeBackgroundImgly,
  renderPreviewFast,
};
