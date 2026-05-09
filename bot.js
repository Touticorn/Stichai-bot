const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const sharp = require("sharp");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FLASH_MODEL = "gemini-2.5-flash";

function makeUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

async function geminiPost(body, timeoutMs, primaryModel, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(makeUrl(primaryModel), body, { timeout: timeoutMs });
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

const jobs = new Map();
const previewCache = new Map();

/* ============================================================
   GEMINI COLOR DETECTION – no grey, vibrant only
   ============================================================ */
async function detectColors(b64, mime) {
  const prompt = `You are selecting thread colors for machine embroidery.

List only **vibrant, saturated** colors that can actually be stitched.
- DO NOT choose grey, beige, pale, or pastel shades – those are usually background.
- Include WHITE if it appears as a design element (not just background)
- Include GOLD or YELLOW for metallic elements, crowns, emblems
- Include BLACK or very dark colors for any dark text or elements
- Include RED, BLUE, GREEN, or any other vibrant design colors
- Return exactly 3-6 colors

Return ONLY JSON, no markdown, no explanation:
{"colors":["#CC0000","#FFFFFF","#FFD700","#000000"],"is_text":true,"is_logo":true}`;

  try {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
      generationConfig: { temperature: 0.02, maxOutputTokens: 1024 }
    };
    const res = await geminiPost(body, 15000, FLASH_MODEL);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let jsonStr = text.replace(/```json|```/g, "").trim();
    const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
    if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);
    const parsed = JSON.parse(jsonStr);
    return {
      colors: parsed.colors || [],
      is_text: parsed.is_text !== false,
      is_logo: parsed.is_logo !== false
    };
  } catch (e) {
    return null;
  }
}

/* ============================================================
   POSTERIZATION – clean image for pixel tracing
   ============================================================ */
async function posterizeImage(buffer) {
  const cleaned = await sharp(buffer)
    .median(3)
    .sharpen({ sigma: 2.5, m1: 2, m2: 5 })
    .png({ colours: 14, dither: 0 })
    .toBuffer();

  const { data, info } = await sharp(cleaned).raw().toBuffer({ resolveWithObject: true });

  const colorMap = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const hex = '#' + [data[i], data[i+1], data[i+2]]
      .map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }

  const sorted = [...colorMap.entries()].sort((a, b) => b[1] - a[1]);
  const bgColor = sorted[0][0];
  const bgRgb = hexToRgb(bgColor);

  const fallbackColors = sorted.slice(1, 5)
    .filter(([hex]) => {
      const c = hexToRgb(hex);
      const d = Math.sqrt((bgRgb.r - c.r) ** 2 + (bgRgb.g - c.g) ** 2 + (bgRgb.b - c.b) ** 2);
      return d > 35;               // slightly softer to keep white design elements
    })
    .map(([hex]) => hex);

  return { buffer: cleaned, fallbackColors };
}

/* ============================================================
   COLOR UTILITIES
   ============================================================ */
function hexToRgb(hex) { … }         // same as before
function rgbToLab({ r, g, b }) { … }
function colorDistanceLab(c1, c2) { … }
function deduplicateColors(colors) { … }
function toThreadColor(hex) { … }

/* ============================================================
   PIXEL TRACING – catches tiny details, adaptive fill classification
   ============================================================ */
function ramerDouglasPeucker(points, epsilon) { … }   // unchanged

async function extractPixelShapes(buffer, colors, isText) {
  const Jimp = require("jimp");
  const image = await Jimp.read(buffer);
  const origW = image.bitmap.width, origH = image.bitmap.height;
  const procSize = 1600;
  const scale = Math.min(procSize/origW, procSize/origH);
  const pw = Math.max(1, Math.round(origW*scale));
  const ph = Math.max(1, Math.round(origH*scale));
  image.resize(pw, ph);

  const labColors = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixelColors = new Int16Array(pw*ph);
  pixelColors.fill(-1);

  const tid = Math.random().toString(36).slice(2,5);
  const data = image.bitmap.data;

  // Colour matching – slightly tighter to separate white from light grey
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y*pw + x) << 2;
      const pixLab = rgbToLab({ r: data[i], g: data[i+1], b: data[i+2] });
      let bestIdx = -1, bestDist = 38;      // tight enough to keep colours clean
      for (let c = 0; c < labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestIdx >= 0) pixelColors[y*pw + x] = bestIdx;
    }
  }

  // Boundary healing – 4‑neighbor only
  for (let y = 1; y < ph-1; y++) { … }     // unchanged

  const shapes = [];
  const minComponentSize = 8;             // tiny crown / stripes kept
  let currentMaskId = 1;

  // ------------------ contour extraction (same as v27) ------------------
  for (let ci = 0; ci < labColors.length; ci++) { … }      // unchanged

  shapes.sort((a, b) => b.pixelCount - a.pixelCount);

  // Quality filter – keep shapes down to 10 pixels
  const filtered = [];
  for (const s of shapes) {
    const b = polygonBounds(s.points);
    if (b.width < 2 || b.height < 2) continue;
    if (s.pixelCount < 10) continue;        // allow tiny white stripes
    if (s.points.length < 4) continue;
    // … contained check unchanged …
    if (!contained) filtered.push(s);
  }

  // Adaptive fill/satin classification
  if (isText && filtered.length > 3) {
    for (const s of filtered) {
      const b = polygonBounds(s.points);
      const narrow = Math.min(b.width, b.height) < 18;
      if (!narrow && s.pixelCount > 200) {
        s.type = "fill";
      } else {
        s.type = "satin";
      }
    }
  }

  console.log(`Pixel: ${filtered.filter(s=>s.type==='satin').length} satin, ${filtered.filter(s=>s.type==='fill').length} fill, ${filtered.length} total`);
  return filtered;
}

/* ============================================================
   STITCH GENERATION – adaptive fill spacing, cross‑group ordering
   ============================================================ */
function polygonBounds(points) { … }
function polygonCentroid(points) { … }
function computeFillAngle(points) { … }

function underlayFillPolygon(points, color) { … }    // unchanged

function contourFillPolygon(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const b = polygonBounds(points);
  const area = b.width * b.height;

  // Adaptive spacing: small shapes get tighter fill
  const rowSpacing = area < 2000 ? 2.8 : 3.5;
  const stitchSpacing = area < 2000 ? 2.5 : 3.0;

  function toLocal(x, y) { … }
  function toGlobal(lx, ly) { … }

  const localPts = points.map(([x, y]) => toLocal(x, y));
  const lBounds = polygonBounds(localPts);

  let rowIdx = 0;
  for (let ly = lBounds.minY; ly <= lBounds.maxY; ly += rowSpacing) {
    const ints = [];
    for (let i = 0, j = localPts.length-1; i < localPts.length; j = i++) {
      const [x1, y1] = localPts[i], [x2, y2] = localPts[j];
      if ((y1 <= ly && y2 > ly) || (y2 <= ly && y1 > ly)) {
        ints.push(x1 + (ly-y1)/(y2-y1)*(x2-x1));
      }
    }
    if (ints.length < 2) continue;
    ints.sort((a, b) => a-b);

    for (let k = 0; k+1 < ints.length; k += 2) {
      let segStart = ints[k] + 0.2, segEnd = ints[k+1] - 0.2;
      if (segEnd <= segStart) continue;
      if (rowIdx%2 === 1) [segStart, segEnd] = [segEnd, segStart];

      const steps = Math.max(1, Math.round((segEnd-segStart)/stitchSpacing));
      for (let s = 0; s <= steps; s++) {
        const [gx, gy] = toGlobal(segStart + (segEnd-segStart)*(s/steps), ly);
        stitches.push({ x: Math.round(gx), y: Math.round(gy), color, type: "fill" });
      }
    }
    rowIdx++;
  }
  return stitches;
}

function satinColumnPolygon(points, color) { … }    // same 4.0 spacing
function runningPolygon(points, color) { … }

function generateStitches(shapes) {
  const all = [], designW = 300, designH = 300;
  for (const s of shapes) s.centroid = polygonCentroid(s.points);

  const groups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color);
    if (!groups[c]) groups[c] = [];
    groups[c].push({ ...s, color: c });
  }

  // ------ cross‑group ordering to minimise long jumps ------
  const colorList = Object.keys(groups);
  const orderedColors = [];
  let entryX = 0, entryY = 0;
  while (colorList.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < colorList.length; i++) {
      const s = groups[colorList[i]][0];
      const d = Math.hypot(s.points[0][0] - entryX, s.points[0][1] - entryY);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const col = colorList.splice(bestIdx, 1)[0];
    orderedColors.push(col);
    const last = groups[col][groups[col].length - 1];
    const lp = last.points[last.points.length - 1];
    entryX = lp[0]; entryY = lp[1];
  }

  let lastX = 0, lastY = 0;
  for (const color of orderedColors) {
    // Within‑group NN ordering
    const ordered = [groups[color][0]];
    const remaining = groups[color].slice(1);
    while (remaining.length) {
      let bestIdx = 0, bestDist = Infinity;
      const [lx, ly] = ordered[ordered.length - 1].centroid;
      for (let i = 0; i < remaining.length; i++) {
        const [cx, cy] = remaining[i].centroid;
        const d = Math.hypot(cx - lx, cy - ly);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }

    for (const s of ordered) {
      const pts = s.points;
      const [sx, sy] = pts[0];
      const jump = Math.hypot(sx - lastX, sy - lastY);
      if (jump > 20 && all.length) {
        all.push({ x: Math.round(lastX), y: Math.round(lastY), color, type: "trim" });
        all.push({ x: Math.round(sx), y: Math.round(sy), color, type: "trim" });
      }
      if (s.type === "fill") {
        all.push(...underlayFillPolygon(pts, color));
        all.push(...contourFillPolygon(pts, color));
      } else {
        all.push(...satinColumnPolygon(pts, color));
      }
      if (all.length) { const l = all[all.length - 1]; lastX = l.x; lastY = l.y; }
    }
  }

  all.push(...runningPolygon([[-2,-2],[designW+2,-2],[designW+2,designH+2],[-2,designH+2]], "#333333"));
  return { stitches: all, designW, designH, shapes };
}

/* ============================================================
   QUALITY VALIDATION, DST ENCODER, PREVIEW, ROUTES – unchanged
   ============================================================ */
// … same as v27 …
