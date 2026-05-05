const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const sharp = require("sharp");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ============================================================
// MULTI-MODEL FALLBACK CHAIN
// Tries each model in order until one works — handles 503s,
// rate limits, and tier restrictions automatically.
// ============================================================
const FLASH_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
];
const PRO_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.0-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
];

function makeApiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

const jobs = new Map();

/* ============================================================
   SMART RETRY: exponential backoff with model fallback
   ============================================================ */
async function geminiRequest(models, body, timeoutMs = 30000, retries = 2) {
  let lastError = null;

  for (const model of models) {
    const url = makeApiUrl(model);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.log(`  Retry ${attempt}/${retries} for ${model} in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
        console.log(`  -> Trying ${model} (attempt ${attempt + 1})...`);
        const res = await axios.post(url, body, {
          timeout: timeoutMs,
          validateStatus: s => s < 500, // let us handle 5xx manually for retry
        });
        // 429 = rate limited, 503 = overloaded — both retryable
        if (res.status === 429 || res.status === 503) {
          console.log(`  <- ${model} returned ${res.status}, will retry/fallback...`);
          lastError = new Error(`Model ${model} returned ${res.status}`);
          continue; // retry this model
        }
        if (res.status >= 400) {
          // 400 = bad request (bad key, bad model name, etc) — try next model
          console.log(`  <- ${model} returned ${res.status}:`, JSON.stringify(res.data).slice(0, 200));
          lastError = new Error(`Model ${model} returned ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
          break; // try next model
        }
        console.log(`  OK ${model} succeeded`);
        return { data: res.data, modelUsed: model };
      } catch (e) {
        const status = e.response?.status;
        const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
        console.log(`  FAIL ${model} attempt ${attempt + 1}: ${status || e.code} — ${body}`);
        lastError = e;
        // Don't retry on 400/401/403 — these are auth/config errors
        if (status === 400 || status === 401 || status === 403) break;
        // 429, 503, ECONNRESET, ETIMEDOUT — retry
        if (attempt >= retries) break;
      }
    }
  }

  throw lastError || new Error("All Gemini models failed");
}

/* ============================================================
   ADAPTIVE procSize — high floor to preserve fine details
   Original 1600px captured crown prongs, thin text strokes.
   Floor raised to 1200 minimum. Epsilon & minComponent
   also scale with procSize so small details survive.
   ============================================================ */
function pickProcSize(origW, origH, colorCount) {
  const megapixels = (origW * origH) / 1e6;
  const colorFactor = colorCount > 7 ? 0.85 : 1.0;
  let size;
  if (megapixels < 0.3)        size = 1200;
  else if (megapixels < 1.0)   size = 1400;
  else if (megapixels < 3.0)   size = 1600;
  else if (megapixels < 6.0)   size = 1400;
  else                          size = 1200;
  size = Math.round(size * colorFactor);
  return Math.min(1600, Math.max(1200, size));
}

/* ============================================================
   PHOTO PREPROCESSING (sharp)
   ============================================================ */
async function preprocessImage(buffer) {
  const processed = await sharp(buffer)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: false })
    .linear(1.15, -10)
    .normalize()
    .modulate({ saturation: 1.7 })
    .median(1)
    .sharpen({ sigma: 1.2, m1: 1.5, m2: 2.5 })
    .toFormat("png")
    .toBuffer();
  return processed;
}

/* ============================================================
   STEP 1: COLOR DETECTION (Flash model chain)
   ============================================================ */
async function detectColors(b64, mime) {
  const prompt = `You are analyzing a design for embroidery digitizing.
List the 4-10 distinct THREAD colors needed. Ignore lighting, shadows, gradients, reflections, paper/background unless it is part of the design.
Return ONLY: {"colors":["#RRGGBB","#RRGGBB"], "is_text": true|false, "is_logo": true|false}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  const { data } = await geminiRequest(FLASH_MODELS, body, 25000);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  const clean = (fb !== -1 && lb > fb) ? jsonStr.slice(fb, lb + 1) : jsonStr;
  const parsed = JSON.parse(clean);
  return {
    colors: parsed.colors || ["#FF0000", "#FFFFFF", "#0000FF"],
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo,
  };
}

/* ============================================================
   LAB COLOR SPACE
   ============================================================ */
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
}

function rgbToLab({ r, g, b }) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047), fy = f(Y / 1.0), fz = f(Z / 1.08883);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function colorDistanceLab(c1Lab, c2Lab) {
  const dl = c1Lab.l - c2Lab.l;
  const da = c1Lab.a - c2Lab.a;
  const db = c1Lab.b - c2Lab.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

function ramerDouglasPeucker(points, epsilon) {
  if (points.length <= 3) return points;
  const lineDist = (px, py, sx, sy, ex, ey) => {
    const len = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
    if (len === 0) return Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
    return Math.abs((ey - sy) * px - (ex - sx) * py + ex * sy - ey * sx) / len;
  };
  const stack = [[0, points.length - 1]];
  const keep = new Set([0, points.length - 1]);
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    const [sx, sy] = points[start], [ex, ey] = points[end];
    let maxDist = 0, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = lineDist(points[i][0], points[i][1], sx, sy, ex, ey);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      keep.add(maxIdx);
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return Array.from(keep).sort((a, b) => a - b).map(i => points[i]);
}

/* ============================================================
   PIXEL TRACING with adaptive procSize + LAB
   ============================================================ */
async function extractShapesFromImage(buffer, colors) {
  const Jimp = require("jimp");

  const image = await Jimp.read(buffer);
  const origW = image.bitmap.width, origH = image.bitmap.height;

  const procSize = pickProcSize(origW, origH, colors.length);
  console.log(`Adaptive procSize: ${procSize}px (source: ${origW}x${origH}, ${colors.length} colors)`);

  const scale = Math.min(procSize / origW, procSize / origH);
  const pw = Math.max(1, Math.round(origW * scale));
  const ph = Math.max(1, Math.round(origH * scale));
  image.resize(pw, ph);

  const labColors = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixelColors = new Int16Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) pixelColors[i] = -1;

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const idx = image.getPixelIndex(x, y);
      const r = image.bitmap.data[idx];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];
      const pixLab = rgbToLab({ r, g, b });
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestDist < 35) pixelColors[y * pw + x] = bestIdx;
    }
  }

  const visited = new Uint8Array(pw * ph);
  const shapes = [];
  // Scale min component size with procSize — at 1600px a 4px component
  // is tiny detail (crown prong, text serif); at 1200px it's 3px.
  const minComponentSize = Math.max(3, Math.round(4 * (procSize / 1600)));

  for (let ci = 0; ci < labColors.length; ci++) {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = y * pw + x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        const comp = [];
        const q = [idx];
        visited[idx] = 1;
        while (q.length) {
          const ci2 = q.shift();
          comp.push(ci2);
          const cx = ci2 % pw, cy = Math.floor(ci2 / pw);
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
              const ni = ny * pw + nx;
              if (pixelColors[ni] === ci && !visited[ni]) { visited[ni] = 1; q.push(ni); }
            }
          }
        }

        if (comp.length < minComponentSize) continue;

        const mask = new Uint8Array(pw * ph);
        for (const i of comp) mask[i] = 1;

        let startX = -1, startY = -1;
        outer: for (let by = 0; by < ph; by++) {
          for (let bx = 0; bx < pw; bx++) {
            const bidx = by * pw + bx;
            if (!mask[bidx]) continue;
            if (bx === 0 || !mask[bidx - 1] || bx === pw - 1 || !mask[bidx + 1] ||
              by === 0 || !mask[bidx - pw] || by === ph - 1 || !mask[bidx + pw]) {
              startX = bx; startY = by; break outer;
            }
          }
        }
        if (startX === -1) continue;

        const contour = [];
        const n8 = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
        let cx = startX, cy = startY, dir = 7;
        let safety = 0;
        do {
          contour.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (dir + i) % 8;
            const nx = cx + n8[d][0], ny = cy + n8[d][1];
            if (nx >= 0 && nx < pw && ny >= 0 && ny < ph && mask[ny * pw + nx]) {
              cx = nx; cy = ny; dir = (d + 5) % 8; found = true; break;
            }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 32000);

        if (contour.length < 4) continue;

        // Lower epsilon = keep more points on curves = finer detail
        // 0.12 at 1600px captures tiny text serifs and crown prongs
        const epsilon = 0.12 * (procSize / 1600);
        const simplified = ramerDouglasPeucker(contour, epsilon);
        const stitchScale = 300 / Math.max(pw, ph);
        const points = simplified.map(([px, py]) => [Math.round(px * stitchScale), Math.round(py * stitchScale)]);

        if (points.length >= 3) {
          const first = points[0], last = points[points.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
          minX = Math.min(minX, px); minY = Math.min(minY, py);
          maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
        const bw = maxX - minX, bh = maxY - minY;
        const area = bw * bh;
        const isLarge = area > 300 * 300 * 0.15;
        const isNarrow = (bw < 12 || bh < 12) && !isLarge;

        shapes.push({
          type: isNarrow ? "satin" : "fill",
          color: colors[ci],
          points,
          pixelCount: comp.length,
        });
      }
    }
  }

  shapes.sort((a, b) => b.pixelCount - a.pixelCount);
  console.log(`Extracted ${shapes.length} shapes from pixels (procSize=${pw}x${ph})`);
  return shapes;
}

/* ============================================================
   GEMINI SHAPE EXTRACTION FALLBACK (Pro model chain)
   ============================================================ */
async function extractShapesWithGemini(b64, mime, hint = {}) {
  const isText = hint.is_text;

  let prompt;
  if (isText) {
    prompt = `This image contains TEXT/typography. Extract each letter or word as a separate shape with tight bounding polygons.
Return ONLY compact JSON:
{"shapes":[{"type":"satin","color":"#RRGGBB","label":"W","points":[[x,y],[x,y],[x,y],[x,y]]}],"width":300,"height":300}
Coordinates 0-300. Use type:"satin" for thin strokes/text, "fill" for solid blocks. 6-30 shapes acceptable. No other text.`;
  } else {
    prompt = `Extract embroiderable flat-color shapes from this design. Return ONLY compact JSON:
{"shapes":[{"type":"fill","color":"#RRGGBB","points":[[x,y],[x,y],[x,y]]}],"width":300,"height":300}
Coordinates 0-300. type:"fill" for solid areas, "satin" for thin lines/borders. 8-25 shapes max. No other text.`;
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
  };

  const { data } = await geminiRequest(PRO_MODELS, body, 35000);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);

  let analysis;
  try { analysis = JSON.parse(jsonStr); }
  catch (e) { analysis = JSON.parse(repairJSON(jsonStr)); }

  for (const s of analysis.shapes || []) {
    if (!s.points || !Array.isArray(s.points) || s.points.length < 3) {
      const x = s.x || 0, y = s.y || 0, w = s.width || 30, h = s.height || 30;
      s.points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    s.points = s.points.map(p => Array.isArray(p) ? p : [p.x || 0, p.y || 0]);
  }
  return analysis.shapes || [];
}

function repairJSON(str) {
  let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
  for (const ch of str) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }
  let repaired = str;
  const trimmed = repaired.trim(), lastChar = trimmed[trimmed.length - 1];
  if (lastChar === ',') repaired += '"x":0}';
  else if (lastChar !== '}' && lastChar !== ']') repaired += '0}';
  for (let i = 0; i < openBraces; i++) repaired += '}';
  for (let i = 0; i < openBrackets; i++) repaired += ']';
  return repaired;
}

/* ============================================================
   STITCH GENERATION
   ============================================================ */
function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function underlayPolygon(points, color) {
  const stitches = [], bounds = polygonBounds(points), spacing = 5;
  const len = Math.max(bounds.width, bounds.height) * 1.5;
  for (let i = -len; i < len; i += spacing) {
    const sx = bounds.minX + i, sy = bounds.minY - i;
    const ex = sx + len * 0.7, ey = sy + len * 0.7;
    if (pointInPolygon((sx + ex) / 2, (sy + ey) / 2, points)) {
      stitches.push({ x: Math.round(sx), y: Math.round(sy), color, type: "underlay" });
      stitches.push({ x: Math.round(ex), y: Math.round(ey), color, type: "underlay" });
    }
  }
  return stitches;
}

function contourFillPolygon(points, color) {
  const stitches = [], bounds = polygonBounds(points);
  const stitchLen = 2.5, rowSpacing = 3.0;
  let inset = 0, pass = 0, maxPasses = 8;

  while (inset < Math.min(bounds.width, bounds.height) / 2 && pass < maxPasses) {
    const yStart = bounds.minY + inset, yEnd = bounds.maxY - inset;
    for (let y = yStart; y < yEnd; y += rowSpacing) {
      const ry = y + (pass % 2) * (rowSpacing * 0.5);
      if (ry > yEnd) break;
      const ints = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i], [x2, y2] = points[j];
        if ((y1 <= ry && y2 > ry) || (y2 <= ry && y1 > ry)) {
          ints.push(x1 + (ry - y1) / (y2 - y1) * (x2 - x1));
        }
      }
      ints.sort((a, b) => a - b);
      for (let k = 0; k + 1 < ints.length; k += 2) {
        const segStart = ints[k], segEnd = ints[k + 1];
        if (segEnd <= segStart) continue;
        const steps = Math.max(1, Math.floor((segEnd - segStart) / stitchLen));
        const dir = (Math.floor(y / rowSpacing) % 2 === 0) ? 1 : -1;
        const startX = dir === 1 ? segStart : segEnd, endX = dir === 1 ? segEnd : segStart;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          stitches.push({ x: Math.round(startX + (endX - startX) * t), y: Math.round(ry), color, type: "fill" });
        }
      }
    }
    inset += rowSpacing * 1.5; pass++;
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [], dash = 2.5;
  const totalLen = points.length * 8;
  const steps = Math.max(points.length * 2, Math.floor(totalLen / dash));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * points.length;
    const idx = Math.floor(t) % points.length, nextIdx = (idx + 1) % points.length;
    const frac = t - Math.floor(t);
    stitches.push({
      x: Math.round(points[idx][0] + (points[nextIdx][0] - points[idx][0]) * frac),
      y: Math.round(points[idx][1] + (points[nextIdx][1] - points[idx][1]) * frac),
      color, type: "running"
    });
  }
  return stitches;
}

function generateStitches(shapes) {
  let all = [];
  const designW = 300, designH = 300;

  for (const s of shapes) {
    const points = s.points || [[0, 0], [10, 0], [10, 10], [0, 10]];
    const color = toThreadColor(s.color || "#FF0066");
    const type = s.type || "fill";

    if (type === "fill") {
      all = all.concat(underlayPolygon(points, color));
      all = all.concat(contourFillPolygon(points, color));
      all = all.concat(runningPolygon(points, color));
    } else if (type === "satin") {
      all = all.concat(runningPolygon(points, color));
      all = all.concat(runningPolygon(points, color));
    } else {
      all = all.concat(runningPolygon(points, color));
    }
  }

  all = all.concat(runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
  return { stitches: all, designW, designH, shapes };
}

/* ============================================================
   FILE ENCODERS
   ============================================================ */
function encodeDST(data) {
  const { stitches } = data;
  const header = Buffer.alloc(512);
  const label = "STICHAI";
  for (let i = 0; i < label.length; i++) header[i] = label.charCodeAt(i);

  const records = [];
  let lastColor = null, prevX = 0, prevY = 0;
  for (const s of stitches) {
    if (s.color !== lastColor && lastColor !== null) records.push(Buffer.from([0x00, 0x00, 0xC3]));
    lastColor = s.color;
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX = s.x; prevY = s.y;
    const clamp = (v) => Math.max(-121, Math.min(121, v));
    const cdx = clamp(dx), cdy = clamp(dy);
    records.push(Buffer.from([cdy >= 0 ? cdy : 0x100 + cdy, cdx >= 0 ? cdx : 0x100 + cdx, 0x03]));
  }
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  return Buffer.concat([header, ...records]);
}

function encodePES(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("#PES0001", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeJEF(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("JEF0001\x00", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeEXP(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("EXP0001\x00", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeVP3(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("VP30001\x00", 0, "ascii"); return Buffer.concat([h, d]); }

function encodeFile(format, data) {
  switch ((format || "dst").toLowerCase()) {
    case "dst": return { buf: encodeDST(data), ext: "dst" };
    case "pes": return { buf: encodePES(data), ext: "pes" };
    case "jef": return { buf: encodeJEF(data), ext: "jef" };
    case "exp": return { buf: encodeEXP(data), ext: "exp" };
    case "vp3": return { buf: encodeVP3(data), ext: "vp3" };
    default: return { buf: encodeDST(data), ext: "dst" };
  }
}

/* ============================================================
   EXPRESS ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-embroidery", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

    console.log("Preprocessing image...");
    const cleanBuffer = await preprocessImage(req.file.buffer);
    const cleanB64 = cleanBuffer.toString("base64");
    const cleanMime = "image/png";

    console.log("Detecting colors with Gemini (trying models: " + FLASH_MODELS.join(", ") + ")...");
    const detection = await detectColors(cleanB64, cleanMime);
    const colors = detection.colors;
    console.log("Colors:", colors, "is_text:", detection.is_text, "is_logo:", detection.is_logo);

    let shapes;
    let extractionMethod = "pixel";
    try {
      shapes = await extractShapesFromImage(cleanBuffer, colors);
      if (shapes.length < 3 && detection.is_text) {
        console.log("Few pixel shapes for text -- supplementing with Gemini Pro...");
        const geminiShapes = await extractShapesWithGemini(cleanB64, cleanMime, detection);
        shapes = shapes.concat(geminiShapes);
        extractionMethod = "hybrid";
      }
    } catch (e) {
      console.error("Pixel extraction failed:", e.message);
      console.log("Falling back to Gemini Pro shape extraction...");
      shapes = await extractShapesWithGemini(cleanB64, cleanMime, detection);
      extractionMethod = "gemini";
      console.log("Gemini Pro fallback shapes:", shapes.length);
    }

    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });

    const result = generateStitches(shapes);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(id, result);

    return res.json({
      success: true,
      id,
      previewUrl: `/preview/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors,
      detection: { is_text: detection.is_text, is_logo: detection.is_logo, method: extractionMethod },
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, points: s.points, pointCount: s.points.length }))
    });
  } catch (e) {
    console.error("FULL ERROR:", e.message);
    if (e.response) {
      console.error("Response status:", e.response.status);
      console.error("Response data:", JSON.stringify(e.response.data, null, 2).slice(0, 800));
    }
    return res.status(502).json({
      error: e.message,
      hint: e.message.includes("503") ? "Google API is overloaded. Retrying with fallback models should have worked. Check your GEMINI_API_KEY has quota remaining." : e.message
    });
  }
});

app.get("/preview/:id", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: data.stitches, designW: data.designW, designH: data.designH, shapes: data.shapes });
});

app.get("/download/:id/:format", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  const fmt = req.params.format || "dst";
  const { buf, ext } = encodeFile(fmt, data);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: "6.3",
  flashModels: FLASH_MODELS,
  proModels: PRO_MODELS,
  keyConfigured: !!GEMINI_API_KEY,
  keyPreview: GEMINI_API_KEY ? GEMINI_API_KEY.slice(0, 6) + "..." + GEMINI_API_KEY.slice(-4) : null
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stichai v6.3 running on port ${PORT}`));
console.log("Flash fallback chain:", FLASH_MODELS.join(" -> "));
console.log("Pro fallback chain:", PRO_MODELS.join(" -> "));
