"use strict";

/**
 * Tier-5g: decoupled preview render.
 *
 * Renders the source image first, then sharp-composites a thin
 * stroke-line visualisation of the stitch file on top. The result is
 * useful for design review — the user can see how the cartoon
 * silhouette "becomes" the embroidery result.
 *
 * The current preview is region-based (sharp-painted RGB stoplight):
 * looks printed, not embroidered. Decoupled shows the actual cartoon
 * image as a backdrop, with stitch stroke lines overlaid in 90 %
 * opacity so they hover over the cartoon without doubling-up.
 */

async function renderDecoupledPreview(srcImageBuffer, stitches, colors, canvasSize) {
  try {
    const sharp = require("sharp");

    // 1. Resize source image to overlay dims. If source is the cleaned
    //    cartoon (maguenta-pad), the result will reflect what the engine
    //    actually operated on — better for design review.
    const base = await sharp(srcImageBuffer)
      .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png().toBuffer();

    // 2. Build SVG stroke overlay (line segments, no fill).
    // Downsample to ~4x reduction for performance.
    const scale = canvasSize / 1600;
    const lines = stitches
      .filter(s => s.type !== "trim" && s.type !== "running" && s.type !== "underlay")
      .slice(0, 50000); // hard cap
    const svgNS = "http://www.w3.org/2000/svg";
    let pathByColor = new Map();
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1], b = lines[i];
      if (a.color !== b.color) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 30) continue;
      const c = a.color;
      if (!pathByColor.has(c)) pathByColor.set(c, "");
      pathByColor.set(c, pathByColor.get(c) + `M${(a.x * scale).toFixed(1)},${(a.y * scale).toFixed(1)} L${(b.x * scale).toFixed(1)},${(b.y * scale).toFixed(1)} `);
    }

    const STITCH_W = Math.max(0.6, 1.0 * scale);
    const paths = Array.from(pathByColor.entries())
      .map(([c, d]) => `<path d="${d}" stroke="${c}" stroke-width="${STITCH_W}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>`).join("");

    const overlayW = canvasSize * scale;
    const overlayH = canvasSize * scale;
    const svg = `<svg xmlns="${svgNS}" width="${overlayW}" height="${overlayH}" viewBox="0 0 ${overlayW} ${overlayH}">${paths}</svg>`;
    const overlay = await sharp(Buffer.from(svg)).png().toBuffer();

    // 3. Resize base to match overlay dims, composite.
    const baseResized = await sharp(base).resize(overlayW, overlayH).png().toBuffer();
    const composed = await sharp(baseResized)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png().toBuffer();
    return composed;
  } catch (e) {
    console.warn(`[v5g-preview] ${e?.message || e}; caller should fall back.`);
    return null;
  }
}

module.exports = { renderDecoupledPreview };
