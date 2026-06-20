/* ─── DETERMINISTIC PALETTE LOCK ────────────────────────────────
 *
 * Locks an image to exactly N flat colors so subsequent palette
 * extraction is deterministic across runs, even when the upstream
 * regenerator (e.g. Gemini cartoon) returns slightly different
 * pixel distributions per call.
 *
 * Step 1: sharp's .palette() pipeline uses libimagequant to bucket
 *         pixels into N flat colors (no dither -> hard borders).
 * Step 2: re-encode as flat RGBA PNG so downstream posterize/threshold
 *         doesn't re-introduce per-pixel fuzz.
 *
 * Returns the rewritten PNG buffer. Channels stay 4 (RGBA).
 */
const sharp = require("sharp");

async function quantizeBuffer(imageBuffer, nColors = 8) {
  if (!imageBuffer || !nColors || nColors < 2 || nColors > 30) return imageBuffer;
  try {
    const colors = Math.max(2, Math.min(32, nColors + 1));
    const pip = sharp(imageBuffer).palette({ colors, quality: 90 });
    const { data, info } = await pip.toBuffer({ resolveWithObject: true });
    // Re-encode the palette output as true RGBA PNG. We don't have raw
    // RGBA, so we re-decode the palette PNG through sharp and emit
    // flat RGBA. This removes any dithering that snuck past libimagequant.
    const flat = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      },
    }).png({ palette: false, compressionLevel: 9 }).toBuffer();
    return flat;
  } catch (e) {
    console.warn(`quantize failed (${e.message}) — using input buffer`);
    return imageBuffer;
  }
}

module.exports = { quantizeBuffer };
