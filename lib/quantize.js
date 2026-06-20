/* ─── DETERMINISTIC PALETTE LOCK ────────────────────────────────
 *
 * Locks an image to exactly N flat colors so subsequent palette
 * extraction is deterministic across runs. Avoids sharp.palette()
 * because that method is missing on certain sharp builds on Railway.
 *
 * Algorithm: pure-JS median-cut on raw RGBA pixels.
 *  - 4-channel RGBA raw decode via sharp
 *  - 1024-pixel sub-sample for speed
 *  - median-cut binning into N color clusters
 *  - map each cluster centroid back to ALL pixels (full res)
 *  - re-encode as flat RGBA PNG (no palette)
 *
 * Returns the rewritten PNG buffer.
 */
const sharp = require("sharp");

function medianCut(pixels, n) {
  // pixels: Float32Array of RGBA quadruples, length = N*4
  const bins = [{ pixels, idx: 0 }];
  // we keep them as arrays of indices into the original buffer
  const indices = pixels.length / 4;
  const indexArr = new Uint32Array(indices);
  for (let i = 0; i < indices; i++) indexArr[i] = i;

  let binsArr = [indexArr];
  while (binsArr.length < n) {
    // find bin with widest channel range
    let bestBin = -1, bestRange = -1;
    let bestCh = 0;
    for (let i = 0; i < binsArr.length; i++) {
      const bin = binsArr[i];
      if (bin.length < 2) continue;
      let rMin = 256, rMax = -1, gMin = 256, gMax = -1, bMin = 256, bMax = -1;
      for (let k = 0; k < bin.length; k++) {
        const o = bin[k] * 4;
        const r = pixels[o], g = pixels[o+1], b = pixels[o+2];
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
      }
      const ranges = [rMax - rMin, gMax - gMin, bMax - bMin];
      let ch = 0, range = ranges[0];
      if (ranges[1] > range) { ch = 1; range = ranges[1]; }
      if (ranges[2] > range) { ch = 2; range = ranges[2]; }
      if (range > bestRange) { bestRange = range; bestBin = i; bestCh = ch; }
    }
    if (bestBin < 0 || bestRange <= 0) break;
    const split = binsArr[bestBin];
    // sort indexes by chosen channel
    const chOff = bestCh;
    const arr = Array.from(split);
    arr.sort((a, b) => pixels[a*4+chOff] - pixels[b*4+chOff]);
    const mid = arr.length >> 1;
    const left = new Uint32Array(arr.slice(0, mid));
    const right = new Uint32Array(arr.slice(mid));
    binsArr.splice(bestBin, 1, left, right);
  }
  // compute centroid per bin
  const centroids = [];
  for (const bin of binsArr) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < bin.length; k++) {
      const o = bin[k] * 4;
      r += pixels[o];
      g += pixels[o+1];
      b += pixels[o+2];
      a += pixels[o+3];
    }
    const n = Math.max(1, bin.length);
    centroids.push([Math.round(r/n), Math.round(g/n), Math.round(b/n), Math.round(a/n)]);
  }
  return centroids;
}

async function quantizeBuffer(imageBuffer, nColors = 8) {
  if (!imageBuffer || !nColors || nColors < 2 || nColors > 30) return imageBuffer;

  try {
    // 1) sample subset for statistic-only pass (median-cut)
    const sampleMax = 320;
    const meta = await sharp(imageBuffer).metadata();
    const ratio = Math.min(1.0, sampleMax / Math.max(meta.width || sampleMax, meta.height || sampleMax));
    const sampleW = Math.max(1, Math.round((meta.width  || sampleMax) * ratio));
    const sampleH = Math.max(1, Math.round((meta.height || sampleMax) * ratio));
    const { data: sampleRaw, info } = await sharp(imageBuffer)
      .resize({ width: sampleW, height: sampleH, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sampLen = info.width * info.height;
    const sampleFiltered = [];
    for (let i = 0; i < sampLen; i++) {
      sampleFiltered.push(sampleRaw[i*3], sampleRaw[i*3+1], sampleRaw[i*3+2], 255);
    }
    if (sampleFiltered.length < 16) return imageBuffer;

    const centroids = medianCut(Uint8Array.from(sampleFiltered), nColors);
    if (!centroids.length) return imageBuffer;

    // 2) full-resolution pass: snap each pixel to its nearest centroid,
    //    then re-encode as flat RGBA PNG at ORIGINAL dims.
    const fullRes = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const FR = fullRes.info;
    const out = Buffer.from(fullRes.data);
    const oTotal = fullRes.data.length;
    const oChan = FR.channels;

    const centroidsRGB = centroids.map(c => [c[0], c[1], c[2]]);
    for (let i = 0; i < oTotal; i += oChan) {
      const r = out[i], g = out[i+1], b = out[i+2];
      let bd = Infinity, bi = 0;
      for (let k = 0; k < centroidsRGB.length; k++) {
        const c = centroidsRGB[k];
        const dr = r - c[0], dg = g - c[1], db = b - c[2];
        const d  = dr*dr + dg*dg + db*db;
        if (d < bd) { bd = d; bi = k; }
      }
      const c = centroidsRGB[bi];
      out[i]   = c[0];
      out[i+1] = c[1];
      out[i+2] = c[2];
      // alpha untouched
    }

    return await sharp(out, {
      raw: { width: FR.width, height: FR.height, channels: oChan },
    }).png({ palette: false, compressionLevel: 9 }).toBuffer();
  } catch (e) {
    console.warn(`quantize failed (${e.message}) — using input buffer`);
    return imageBuffer;
  }
}

module.exports = { quantizeBuffer };
