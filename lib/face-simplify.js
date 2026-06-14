/**
 * face-simplify.js -- Post-process a flat cartoon PNG to clean up busy faces.
 *
 * Algorithm:
 *  1. Classify pixels: SKIN (warm tones) | DARK (near-black) | OTHER
 *  2. "Interior dark" = dark pixels mostly surrounded by skin (face detail, not contour)
 *  3. Connected-component labelling on interior dark pixels
 *  4. Keep large components (eyes, brows, mouth) -- remove small ones (wrinkles, shading)
 *  5. Dilate kept features by 1px into surrounding skin -> bolder eyes & mouth
 *  6. Replace removed pixels with the dominant skin colour
 */
const sharp = require("sharp");

function isSkin(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 60 || lum > 235) return false;
  if (r > 200 && b > 200 && g < 100) return false;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 15) return false;
  if (r < g || r < b) return false;
  if (g <= b) return false;
  if (g < r * 0.35) return false;
  return true;
}

async function simplifyFaceDetail(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const N = W * H;
  const out = Buffer.from(data);

  const SKIN = 1, DARK = 2;
  const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 55)                cls[i] = DARK;
    else if (isSkin(r, g, b))    cls[i] = SKIN;
  }

  const interior = new Uint8Array(N);
  const R = 3;
  for (let y = R; y < H - R; y++) {
    for (let x = R; x < W - R; x++) {
      const i = y * W + x;
      if (cls[i] !== DARK) continue;
      let sc = 0, tot = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) { tot++; if (cls[(y + dy) * W + (x + dx)] === SKIN) sc++; }
      if (sc >= tot * 0.25) interior[i] = 1;
    }
  }

  const labels = new Int32Array(N);
  const areas = {};
  let nextLabel = 1;

  for (let i = 0; i < N; i++) {
    if (!interior[i] || labels[i]) continue;
    const L = nextLabel++;
    const stack = [i];
    let area = 0;
    while (stack.length) {
      const j = stack.pop();
      if (labels[j] || !interior[j]) continue;
      labels[j] = L;
      area++;
      const x = j % W, y = (j - x) / W;
      if (x > 0)     stack.push(j - 1);
      if (x < W - 1) stack.push(j + 1);
      if (y > 0)     stack.push(j - W);
      if (y < H - 1) stack.push(j + W);
    }
    areas[L] = area;
  }

  const MIN_FEATURE = Math.max(80, Math.round(N * 0.00004));
  const keep = new Set();
  for (const [L, area] of Object.entries(areas))
    if (area >= MIN_FEATURE) keep.add(+L);

  const skinBucket = {};
  for (let i = 0; i < N; i++) {
    if (cls[i] !== SKIN) continue;
    const k = ((data[i * C] >> 4) << 8) | ((data[i * C + 1] >> 4) << 4) | (data[i * C + 2] >> 4);
    skinBucket[k] = (skinBucket[k] || { count: 0, r: 0, g: 0, b: 0 });
    skinBucket[k].count++;
    skinBucket[k].r += data[i * C];
    skinBucket[k].g += data[i * C + 1];
    skinBucket[k].b += data[i * C + 2];
  }
  let bestK = null, bestC = 0;
  for (const [k, v] of Object.entries(skinBucket)) { if (v.count > bestC) { bestC = v.count; bestK = k; } }
  const dsc = bestK ? skinBucket[bestK] : null;
  const skinR = dsc ? Math.round(dsc.r / dsc.count) : 210;
  const skinG = dsc ? Math.round(dsc.g / dsc.count) : 170;
  const skinB = dsc ? Math.round(dsc.b / dsc.count) : 140;

  let removed = 0;
  for (let i = 0; i < N; i++) {
    if (interior[i] && labels[i] && !keep.has(labels[i])) {
      out[i * C]     = skinR;
      out[i * C + 1] = skinG;
      out[i * C + 2] = skinB;
      removed++;
    }
  }

  let bolded = 0;
  const isKept = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (interior[i] && keep.has(labels[i])) isKept[i] = 1;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cls[i] !== SKIN) continue;
      if (isKept[i]) continue;
      if (isKept[i - 1] || isKept[i + 1] || isKept[i - W] || isKept[i + W]) {
        out[i * C] = 0; out[i * C + 1] = 0; out[i * C + 2] = 0;
        bolded++;
      }
    }
  }

  const totalComps = Object.keys(areas).length;
  console.log(`[face-simplify] ${totalComps} interior components, kept ${keep.size} (>=${MIN_FEATURE}px), removed ${removed}px, bolded ${bolded}px`);

  return sharp(out, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}

module.exports = { simplifyFaceDetail };
