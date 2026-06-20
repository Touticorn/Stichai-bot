/* ─── DETERMINISTIC PALETTE LOCK ────────────────────────────────
 *
 * Locks an image to exactly N flat colors so subsequent palette
 * extraction is deterministic across runs, even when the upstream
 * regenerator (e.g. Gemini cartoon) returns slightly different
 * pixel distributions per call.
 *
 * Step 1: median-cut to N colors via sharp's built-in libimagequant.
 * Step 2: rewrite each distinct flat color as ONE specific lab value
 *         (median color of the bucket) so dither fuzz never bleeds
 *         across boundaries during later posterize steps.
 *
 * Returns the rewritten PNG buffer. Channels stay 4 (RGBA, magenta
 * chroma-key background also locked to transparent flat).
 */
const sharp = require("sharp");

async function quantizeBuffer(imageBuffer, nColors = 8) {
  if (!imageBuffer || !nColors || nColors < 2 || nColors > 30) return imageBuffer;
  try {
    // sharp palette() uses libimagequant; no dither -> flat blocks
    const { data, info } = await sharp(imageBuffer)
      .png()
      .palette({ colors: Math.max(2, Math.min(32, nColors + 1)), quality: 90 })
      .toBuffer({ resolveWithObject: true });
    // rewrite the indexed PNG to a true flat RGBA PNG: same flat colors,
    // no transparency banding, so downstream thresholding step doesn't
    // re-introduce per-pixel variation
    return await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .png({ palette: false })
      .toBuffer();
  } catch (e) {
    console.warn(`quantize failed (${e.message}) — using input buffer`);
    return imageBuffer;
  }
}

module.exports = { quantizeBuffer };
