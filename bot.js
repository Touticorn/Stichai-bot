const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const sharp = require("sharp");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FLASH_MODEL = "gemini-2.5-flash";
const PRO_MODEL = "gemini-2.5-pro";

function makeUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

async function geminiPost(body, timeoutMs, primaryModel, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(makeUrl(primaryModel), body, { timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 503 || status === 429) {
        const delay = 2000 * Math.pow(2, i);
        console.log(`Gemini ${primaryModel} ${status}, retry ${i + 1}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}

const jobs = new Map();

/* ============================================================
   PROFESSIONAL PREPROCESSING PIPELINE
   ============================================================ */

async function preprocessImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargargement: false })
    .linear(1.15, -10)
    .normalize()
    .modulate({ saturation: 1.7 })
    .median(1)
    .sharpen({ sigma: 1.2, m1: 1.5, m2: 2.5 })
    .toFormat("png")
    .toBuffer();
}

/* Detect background color + thread colors using Gemini */
async function analyzeImage(b64, mime) {
  const prompt = `You are a professional embroidery digitizer. Analyze this image and identify:

1. BACKGROUND color (the paper/surface behind the design) - this will be REMOVED
2. DESIGN colors (the actual thread colors needed for embroidery)

Return ONLY valid JSON:
{"background":"#RRGGBB","colors":["#RRGGBB","#RRGGBB",...],"is_text":true|false,"is_logo":true|false}

Rules:
- Background is usually white, off-white, transparent, or the dominant area surrounding the design
- Colors should be 3-8 distinct thread colors
- Ignore lighting, shadows, reflections
- is_text = true if image contains readable text or lettering
- is_logo = true if image contains a brand logo or emblem`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 2048 }
  };

  const res = await geminiPost(body, 45000, FLASH_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);
  
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { parsed = JSON.parse(repairJSON(jsonStr)); }
  
  const bg = parsed.background || "#FFFFFF";
  const colors = deduplicateColors(parsed.colors || ["#FF0000", "#FFFFFF", "#0000FF"]);
  
  return {
    background: bg,
    colors: colors,
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo,
  };
}

/* ============================================================
   GEMINI SHAPE EXTRACTION — primary path
   ============================================================ */
async function extractShapesWithGemini(b64, mime, colors, isText, isLogo) {
  const colorList = colors.join(", ");
  const prompt = `You are a professional embroidery digitizer using Wilcom/Hatch standards.

Extract ALL distinct embroiderable shapes from this image using these thread colors: ${colorList}

For each shape, provide:
- **type**: "satin" for text, letters, thin strokes, borders (width < 7mm)
- **type**: "fill" for solid blocks, backgrounds, wide areas (width >= 7mm)
- **color**: exact hex from the color list
- **points**: polygon boundary [x,y] in 0-300 coordinate space

CRITICAL RULES:
1. Text/letters → ALWAYS "satin", each letter is a separate shape
2. Large solid backgrounds → ALWAYS "fill"
3. Merge adjacent pieces of the same color into unified shapes
4. Return maximum 25 shapes total
5. Background has already been removed - only return design shapes
6. Return shapes in embroidery order: backgrounds first, then details on top

Return ONLY:
{"shapes":[{"type":"fill|satin","color":"#hex","points":[[x,y],[x,y],...]},...]}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
  };

  const res = await geminiPost(body, 60000, PRO_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);

  let analysis;
  try { analysis = JSON.parse(jsonStr); }
  catch (e) { analysis = JSON.parse(repairJSON(jsonStr)); }

  const shapes = [];
  for (const s of analysis.shapes || []) {
    if (!s.points || !Array.isArray(s.points) || s.points.length < 3) continue;
    const points = s.points.map(p => Array.isArray(p) ? [Math.round(p[0]), Math.round(p[1])] : [Math.round(p.x || 0), Math.round(p.y || 0)]);
    const first = points[0], last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    
    // Quality check: skip tiny or degenerate shapes
    const b = polygonBounds(points);
    if (b.width < 2 || b.height < 2) continue;
    if (points.length < 4) continue;
    
    shapes.push({
      type: s.type === "satin" ? "satin" : "fill",
      color: s.color || colors[0],
      points,
      pixelCount: 100,
    });
  }
  return shapes;
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
   COLOR UTILITIES
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
  return { l: 116 * f(Y) - 16, a: 500 * (f(X / 0.95047) - f(Y)), b: 200 * (f(Y) - f(Z / 1.08883)) };
}

function colorDistanceLab(c1Lab, c2Lab) {
  const dl = c1Lab.l - c2Lab.l;
  const da = c1Lab.a - c2Lab.a;
  const db = c1Lab.b - c2Lab.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

function deduplicateColors(colors) {
  const unique = [];
  const labs = colors.map(c => rgbToLab(hexToRgb(c)));
  for (let i = 0; i < colors.length; i++) {
    let duplicate = false;
    for (let j = 0; j < unique.length; j++) {
      if (colorDistanceLab(labs[i], rgbToLab(hexToRgb(unique[j]))) < 20) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) unique.push(colors[i]);
  }
  return unique.length ? unique : ["#FF0000", "#FFFFFF", "#0000FF"];
}

function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

/* ============================================================
   PIXEL TRACING — fallback with background removal + quantization
   ============================================================ */
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

async function extractShapesFromImage(buffer, colors, isText = false) {
  const jimpModule = require("jimp");
  const Jimp = jimpModule.Jimp || jimpModule;

  const image = await Jimp.read(buffer);
  const origW = image.bitmap.width, origH = image.bitmap.height;

  const procSize = 1600;
  const scale = Math.min(procSize / origW, procSize / origH);
  const pw = Math.max(1, Math.round(origW * scale));
  const ph = Math.max(1, Math.round(origH * scale));
  image.resize(pw, ph);

  const labColors = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixelColors = new Int16Array(pw * ph);
  pixelColors.fill(-1);

  const tid = Math.random().toString(36).slice(2, 5);
  console.time(`pixel-classify-${tid}`);
  const data = image.bitmap.data;
  
  // Classify each pixel to nearest thread color, exclude background
  for (let y = 0; y < ph; y++) {
    const rowOff = y * pw * 4;
    const outOff = y * pw;
    for (let x = 0; x < pw; x++) {
      const i = rowOff + (x << 2);
      const pixLab = rgbToLab({ r: data[i], g: data[i + 1], b: data[i + 2] });
      
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      // Only assign if reasonably close to a thread color
      if (bestDist < 40) pixelColors[outOff + x] = bestIdx;
    }
  }
  console.timeEnd(`pixel-classify-${tid}`);

  // Boundary healing
  console.time(`heal-${tid}`);
  for (let y = 1; y < ph - 1; y++) {
    const row = y * pw;
    for (let x = 1; x < pw - 1; x++) {
      const idx = row + x;
      if (pixelColors[idx] !== -1) continue;
      const c0 = pixelColors[idx - 1];
      const c1 = pixelColors[idx + 1];
      const c2 = pixelColors[idx - pw];
      const c3 = pixelColors[idx + pw];
      let best = -1, bestCnt = 0;
      if (c0 !== -1) { const n = 1 + (c0 === c1) + (c0 === c2) + (c0 === c3); if (n > bestCnt) { bestCnt = n; best = c0; } }
      if (c1 !== -1 && c1 !== c0) { const n = 1 + (c1 === c0) + (c1 === c2) + (c1 === c3); if (n > bestCnt) { bestCnt = n; best = c1; } }
      if (c2 !== -1 && c2 !== c0 && c2 !== c1) { const n = 1 + (c2 === c0) + (c2 === c1) + (c2 === c3); if (n > bestCnt) { bestCnt = n; best = c2; } }
      if (c3 !== -1 && c3 !== c0 && c3 !== c1 && c3 !== c2) { const n = 1 + (c3 === c0) + (c3 === c1) + (c3 === c2); if (n > bestCnt) { bestCnt = n; best = c3; } }
      if (bestCnt >= 3) pixelColors[idx] = best;
    }
  }
  console.timeEnd(`heal-${tid}`);

  // Gap-tolerant BFS + contour extraction
  const shapes = [];
  const minComponentSize = 12;
  let currentMaskId = 1;

  console.time(`contour-extract-${tid}`);
  for (let ci = 0; ci < labColors.length; ci++) {
    const visited = new Uint8Array(pw * ph);
    const maskIds = new Uint32Array(pw * ph);

    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = y * pw + x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        // BFS with 8-connected + 2px gap tolerance
        const q = [idx];
        let qPtr = 0;
        let pixelCount = 0;
        let startX = -1, startY = -1;
        visited[idx] = 1;
        maskIds[idx] = currentMaskId;

        while (qPtr < q.length) {
          const ci2 = q[qPtr++];
          pixelCount++;
          const cx = ci2 % pw;
          const cy = (ci2 / pw) | 0;

          if (startX === -1) {
            if (cx === 0 || pixelColors[ci2 - 1] !== ci || cx === pw - 1 || pixelColors[ci2 + 1] !== ci ||
                cy === 0 || pixelColors[ci2 - pw] !== ci || cy === ph - 1 || pixelColors[ci2 + pw] !== ci) {
              startX = cx; startY = cy;
            }
          }

          // 8-connected with 2px gap tolerance
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dy === 0 && dx === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
                const ni = ny * pw + nx;
                if (!visited[ni] && pixelColors[ni] === ci) {
                  visited[ni] = 1;
                  maskIds[ni] = currentMaskId;
                  q.push(ni);
                }
              }
            }
          }
        }

        if (pixelCount < minComponentSize || startX === -1) {
          currentMaskId++;
          continue;
        }

        // Contour tracing
        const contour = [];
        const n8 = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
        let cx = startX, cy = startY, dir = 7;
        let safety = 0;
        const inMask = (mx, my) => mx >= 0 && mx < pw && my >= 0 && my < ph && maskIds[my * pw + mx] === currentMaskId;

        do {
          contour.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (dir + i) & 7;
            const nx = cx + n8[d][0], ny = cy + n8[d][1];
            if (inMask(nx, ny)) { cx = nx; cy = ny; dir = (d + 5) & 7; found = true; break; }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 500000);

        currentMaskId++;
        if (contour.length < 4) continue;

        const simplified = ramerDouglasPeucker(contour, 0.2);
        const stitchScale = 300 / Math.max(pw, ph);
        const points = simplified.map(([px, py]) => [Math.round(px * stitchScale), Math.round(py * stitchScale)]);

        if (points.length >= 3) {
          const first = points[0], last = points[points.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
        }

        // Bounds + classification
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
          minX = Math.min(minX, px); minY = Math.min(minY, py);
          maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
        const bw = maxX - minX, bh = maxY - minY;
        const area = bw * bh;
        const isNarrow = (bw < 12 || bh < 12) && area < 13500;

        shapes.push({ type: isNarrow ? "satin" : "fill", color: colors[ci], points, pixelCount });
      }
    }
  }

  shapes.sort((a, b) => b.pixelCount - a.pixelCount);
  console.timeEnd(`contour-extract-${tid}`);

  // === QUALITY FILTER ===
  // Remove: tiny shapes, shapes contained in larger same-color shapes, degenerate polygons
  const filtered = [];
  for (const s of shapes) {
    const b = polygonBounds(s.points);
    // Skip tiny shapes
    if (b.width < 3 || b.height < 3) continue;
    if (s.pixelCount < 20) continue;
    if (s.points.length < 4) continue;
    // Skip shapes fully contained within a larger same-color shape
    let contained = false;
    for (const other of shapes) {
      if (other === s) continue;
      if (other.color !== s.color) continue;
      const ob = polygonBounds(other.points);
      if (ob.area <= b.area) continue;
      // Check if s is fully inside other (loose check)
      let allInside = true;
      for (const [px, py] of s.points) {
        if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) {
          allInside = false;
          break;
        }
      }
      if (allInside) { contained = true; break; }
    }
    if (!contained) filtered.push(s);
  }

  // === TEXT RECLASSIFICATION ===
  // When image contains text: largest shapes = background (fill), rest = text (satin)
  if (isText && filtered.length > 3) {
    const byColor = {};
    for (const s of filtered) {
      if (!byColor[s.color]) byColor[s.color] = [];
      byColor[s.color].push(s);
    }
    for (const color of Object.keys(byColor)) {
      const list = byColor[color];
      list.sort((a, b) => b.pixelCount - a.pixelCount);
      // Largest shape = background fill, all others = satin text
      for (let i = 0; i < list.length; i++) {
        list[i].type = (i === 0 && list[i].pixelCount > 500) ? "fill" : "satin";
      }
    }
  }

  const satinCount = filtered.filter(s => s.type === "satin").length;
  const fillCount = filtered.filter(s => s.type === "fill").length;
  console.log(`Pixel shapes: ${satinCount} satin, ${fillCount} fill, ${filtered.length} total (filtered from ${shapes.length})`);

  return filtered;
}

/* ============================================================
   STITCH GENERATION
   ============================================================ */
function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, area: (maxX - minX) * (maxY - minY) };
}

function polygonCentroid(points) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x1, y1] = points[i], [x2, y2] = points[j];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
    a += cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 0.001) {
    let sx = 0, sy = 0;
    for (const [x, y] of points) { sx += x; sy += y; }
    return [sx / points.length, sy / points.length];
  }
  const factor = 1 / (6 * a);
  return [cx * factor, cy * factor];
}

function computeFillAngle(points) {
  const n = points.length;
  if (n < 3) return 0;
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let mxx = 0, myy = 0, mxy = 0;
  for (const [x, y] of points) {
    const dx = x - cx, dy = y - cy;
    mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
  }
  if (Math.abs(mxy) < 0.001) return 0;
  return Math.atan2(2 * mxy, mxx - myy) / 2;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function underlayFillPolygon(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 1.5, ny = dx / len * 1.5;
    const ix1 = x1 + nx, iy1 = y1 + ny;
    const ix2 = x2 + nx, iy2 = y2 + ny;
    if (pointInPolygon((ix1 + ix2) / 2, (iy1 + iy2) / 2, points)) {
      stitches.push({ x: Math.round(ix1), y: Math.round(iy1), color, type: "underlay" });
      stitches.push({ x: Math.round(ix2), y: Math.round(iy2), color, type: "underlay" });
    }
  }
  const b = polygonBounds(points);
  const midX = (b.minX + b.maxX) / 2, midY = (b.minY + b.maxY) / 2;
  if (pointInPolygon(b.minX, midY, points)) {
    stitches.push({ x: Math.round(b.minX), y: Math.round(midY), color, type: "underlay" });
    stitches.push({ x: Math.round(b.maxX), y: Math.round(midY), color, type: "underlay" });
  }
  return stitches;
}

function underlaySatinPolygon(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  function toLocal(x, y) { return [x * cosA + y * sinA, -x * sinA + y * cosA]; }
  function toGlobal(lx, ly) { return [lx * cosA - ly * sinA, lx * sinA + ly * cosA]; }
  const localPts = points.map(([x, y]) => toLocal(x, y));
  const b = polygonBounds(localPts);
  for (let lx = b.minX; lx <= b.maxX; lx += 8.0) {
    const ints = [];
    for (let i = 0, j = localPts.length - 1; i < localPts.length; j = i++) {
      const [x1, y1] = localPts[i], [x2, y2] = localPts[j];
      if ((x1 <= lx && x2 > lx) || (x2 <= lx && x1 > lx)) {
        ints.push(y1 + (lx - x1) / (x2 - x1) * (y2 - y1));
      }
    }
    if (ints.length < 2) continue;
    ints.sort((a, b) => a - b);
    const midY = (ints[0] + ints[ints.length - 1]) / 2;
    const [gx, gy] = toGlobal(lx, midY);
    stitches.push({ x: Math.round(gx), y: Math.round(gy), color, type: "underlay" });
  }
  return stitches;
}

function contourFillPolygon(points, color) {
  const stitches = [];
  const fillAngle = computeFillAngle(points);
  const cosA = Math.cos(fillAngle), sinA = Math.sin(fillAngle);
  /* Professional density: ~1,300-6,000 stitches per inch
     300 units ≈ 3.5", so stitchLen=5.0, rowSpacing=5.0 gives
     ~3,600 stitches per fill shape — matches pro standards */
  const stitchLen = 5.0, rowSpacing = 5.0;
  function toLocal(x, y) { return [x * cosA + y * sinA, -x * sinA + y * cosA]; }
  function toGlobal(lx, ly) { return [lx * cosA - ly * sinA, lx * sinA + ly * cosA]; }
  const localPts = points.map(([x, y]) => toLocal(x, y));
  const lBounds = polygonBounds(localPts);

  let rowIdx = 0;
  for (let ly = lBounds.minY; ly <= lBounds.maxY; ly += rowSpacing) {
    const ints = [];
    for (let i = 0, j = localPts.length - 1; i < localPts.length; j = i++) {
      const [x1, y1] = localPts[i], [x2, y2] = localPts[j];
      if ((y1 <= ly && y2 > ly) || (y2 <= ly && y1 > ly)) {
        ints.push(x1 + (ly - y1) / (y2 - y1) * (x2 - x1));
      }
    }
    if (ints.length < 2) continue;
    ints.sort((a, b) => a - b);

    for (let k = 0; k + 1 < ints.length; k += 2) {
      let segStart = ints[k], segEnd = ints[k + 1];
      if (segEnd <= segStart) continue;
      if (rowIdx % 2 === 1) {
        const stagger = Math.min(rowSpacing * 0.35, (segEnd - segStart) * 0.3);
        segStart += stagger;
        segEnd += stagger;
      }
      if (segEnd - segStart < 3) continue;
      const steps = Math.max(1, Math.floor((segEnd - segStart) / stitchLen));
      const dir = (rowIdx % 2 === 0) ? 1 : -1;
      const startX = dir === 1 ? segStart : segEnd, endX = dir === 1 ? segEnd : segStart;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lx = startX + (endX - startX) * t;
        const [gx, gy] = toGlobal(lx, ly);
        stitches.push({ x: Math.round(gx), y: Math.round(gy), color, type: "fill" });
      }
    }
    rowIdx++;
  }
  return stitches;
}

function satinColumnPolygon(points, color) {
  const stitches = [];
  const width = 2.5;
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * (width / 2);
    const ny = dx / len * (width / 2);
    inner.push([x1 + nx, y1 + ny]);
  }
  /* Professional satin: wider zigzag spacing */
  const totalLen = points.length * 10;
  const steps = Math.max(points.length * 2, Math.floor(totalLen / 2.5));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * points.length;
    const idx = Math.floor(t) % points.length;
    const frac = t - Math.floor(t);
    const nextIdx = (idx + 1) % points.length;
    const ox = points[idx][0] + (points[nextIdx][0] - points[idx][0]) * frac;
    const oy = points[idx][1] + (points[nextIdx][1] - points[idx][1]) * frac;
    const ix = inner[idx][0] + (inner[nextIdx][0] - inner[idx][0]) * frac;
    const iy = inner[idx][1] + (inner[nextIdx][1] - inner[idx][1]) * frac;
    if (i % 2 === 0) {
      stitches.push({ x: Math.round(ox), y: Math.round(oy), color, type: "satin" });
    } else {
      stitches.push({ x: Math.round(ix), y: Math.round(iy), color, type: "satin" });
    }
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [];
  if (points.length < 2) return stitches;
  const segLens = [];
  let cumLen = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segLens.push({ start: cumLen, len, idx: i });
    cumLen += len;
  }
  if (cumLen < 1) return stitches;
  /* Professional running stitch spacing */
  const spacing = 4.0;
  const steps = Math.max(1, Math.floor(cumLen / spacing));
  for (let s = 0; s <= steps; s++) {
    const target = (s / steps) * cumLen;
    let seg = segLens[0];
    for (const candidate of segLens) {
      if (candidate.start <= target && target < candidate.start + candidate.len) { seg = candidate; break; }
      if (s === steps && target >= candidate.start) seg = candidate;
    }
    const frac = seg.len > 0 ? (target - seg.start) / seg.len : 0;
    const [x1, y1] = points[seg.idx];
    const [x2, y2] = points[(seg.idx + 1) % points.length];
    stitches.push({ x: Math.round(x1 + (x2 - x1) * frac), y: Math.round(y1 + (y2 - y1) * frac), color, type: "running" });
  }
  return stitches;
}

/* Generate stitches */
function generateStitches(shapes) {
  const all = [];
  const designW = 300, designH = 300;
  // Precompute centroids
  for (const s of shapes) {
    s.centroid = polygonCentroid(s.points || [[0, 0], [10, 0], [10, 10], [0, 10]]);
  }

  // Group by color
  const colorGroups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color || "#FF0066");
    if (!colorGroups[c]) colorGroups[c] = [];
    colorGroups[c].push({ ...s, color: c });
  }

  // NN order within each color group, starting from shape closest to group entry point
  function nnOrder(group, entryX, entryY) {
    if (group.length <= 1) return group;
    // Find closest to entry point
    let startIdx = 0, startDist = Infinity;
    for (let i = 0; i < group.length; i++) {
      const [cx, cy] = group[i].centroid;
      const d = Math.hypot(cx - entryX, cy - entryY);
      if (d < startDist) { startDist = d; startIdx = i; }
    }
    const ordered = [group[startIdx]];
    const remaining = group.filter((_, i) => i !== startIdx);
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
    return ordered;
  }

  // Order color groups by NN: start from (0,0), find closest group's first shape
  const groupColors = Object.keys(colorGroups);
  const orderedGroups = [];
  let entryX = 0, entryY = 0;
  while (groupColors.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < groupColors.length; i++) {
      const g = colorGroups[groupColors[i]];
      for (const s of g) {
        const [cx, cy] = s.centroid;
        const d = Math.hypot(cx - entryX, cy - entryY);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    }
    const color = groupColors.splice(bestIdx, 1)[0];
    const ordered = nnOrder(colorGroups[color], entryX, entryY);
    colorGroups[color] = ordered;
    orderedGroups.push(color);
    // Entry point for next group = last shape's end
    const lastShape = ordered[ordered.length - 1];
    const lastPt = lastShape.points[lastShape.points.length - 1] || lastShape.centroid;
    entryX = lastPt[0]; entryY = lastPt[1];
  }

  // Generate stitches with jump capping
  let lastX = 0, lastY = 0;
  const maxJump = 25; // cap jumps at 25mm

  for (const color of orderedGroups) {
    for (const s of colorGroups[color]) {
      const points = s.points || [[0, 0], [10, 0], [10, 10], [0, 10]];
      const type = s.type || "fill";
      const [sx, sy] = points[0] || [0, 0];
      const jump = Math.hypot(sx - lastX, sy - lastY);

      if (jump > maxJump && all.length > 0) {
        // Add trim at current position, then break jump into segments
        all.push({ x: Math.round(lastX), y: Math.round(lastY), color, type: "trim" });
        // Intermediate points along the jump
        const steps = Math.ceil(jump / maxJump);
        for (let i = 1; i < steps; i++) {
          const f = i / steps;
          all.push({
            x: Math.round(lastX + (sx - lastX) * f),
            y: Math.round(lastY + (sy - lastY) * f),
            color, type: "trim"
          });
        }
      } else if (jump > 10 && all.length > 0) {
        all.push({ x: Math.round(sx), y: Math.round(sy), color, type: "trim" });
      }

      if (type === "fill") {
        all.push(...underlayFillPolygon(points, color));
        all.push(...contourFillPolygon(points, color));
      } else if (type === "satin") {
        all.push(...underlaySatinPolygon(points, color));
        all.push(...satinColumnPolygon(points, color));
      } else {
        all.push(...runningPolygon(points, color));
      }

      if (all.length) { const last = all[all.length - 1]; lastX = last.x; lastY = last.y; }
    }
  }

  all.push(...runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
  return { stitches: all, designW, designH, shapes };
}

/* ============================================================
   QUALITY VALIDATION — check stitch density, jumps, warnings
   ============================================================ */
function validateQuality(stitches) {
  const warnings = [];
  let totalLen = 0, stitchCount = 0, maxJump = 0, longJumps = 0;
  let prev = null;
  
  for (const s of stitches) {
    if (s.type === "trim") { prev = null; continue; }
    if (prev && prev.type !== "trim") {
      const d = Math.hypot(s.x - prev.x, s.y - prev.y);
      totalLen += d;
      stitchCount++;
      if (d > maxJump) maxJump = d;
      if (d > 10) longJumps++;
    }
    prev = s;
  }
  
  const avgLen = stitchCount > 0 ? totalLen / stitchCount : 0;
  const stitchDensity = avgLen > 0 ? 1 / avgLen : 0; // stitches per mm approx
  
  // Density checks
  if (avgLen > 4.0) warnings.push(`Stitches too long (avg ${avgLen.toFixed(1)}mm) — may gap on fabric`);
  if (avgLen < 1.5) warnings.push(`Stitches too dense (avg ${avgLen.toFixed(1)}mm) — may pucker or break needles`);
  
  // Jump checks
  if (maxJump > 30) warnings.push(`Very long jump (${maxJump.toFixed(1)}mm) — thread may tangle`);
  if (longJumps > 20) warnings.push(`${longJumps} long jumps (>10mm) — add trims or reorder shapes`);
  
  // Count checks
  if (stitchCount > 50000) warnings.push(`Very high stitch count (${stitchCount}) — may exceed machine memory`);
  if (stitchCount < 100) warnings.push(`Very low stitch count (${stitchCount}) — design may be incomplete`);
  
  return {
    avgStitchLength: avgLen.toFixed(1),
    maxJump: maxJump.toFixed(1),
    longJumpCount: longJumps,
    stitchCount,
    density: stitchDensity.toFixed(2),
    warnings,
    passed: warnings.length === 0,
  };
}

/* ============================================================
   FILE ENCODERS
   ============================================================ */
function stitchRecord(dx, dy) {
  const cdx = Math.max(-121, Math.min(121, Math.round(dx)));
  const cdy = Math.max(-121, Math.min(121, Math.round(dy)));
  return Buffer.from([cdy >= 0 ? cdy : 0x100 + cdy, cdx >= 0 ? cdx : 0x100 + cdx, 0x03]);
}

function encodeDST(data) {
  const { stitches, designW, designH } = data;
  const header = Buffer.alloc(512, 0x20); // space-padded
  const label = "Stichai";
  header.write(label.slice(0, 16), 0, "ascii");
  
  // Build records and count stats
  const records = [];
  let lastColor = null, prevX = 0, prevY = 0;
  let stitchCount = 0, colorChangeCount = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  let absX = 0, absY = 0;

  for (const s of stitches) {
    // Track bounds
    absX += s.x - prevX;
    absY += s.y - prevY;
    if (absX < minX) minX = absX;
    if (absX > maxX) maxX = absX;
    if (absY < minY) minY = absY;
    if (absY > maxY) maxY = absY;

    if (s.color !== lastColor && lastColor !== null) {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChangeCount++;
    }
    lastColor = s.color;

    if (s.type === "trim") {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      const dx = s.x - prevX, dy = s.y - prevY;
      prevX = s.x; prevY = s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 121));
      for (let i = 1; i <= steps; i++) { const f = i / steps; records.push(stitchRecord(dx * f, dy * f)); }
      continue;
    }
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX = s.x; prevY = s.y;
    records.push(stitchRecord(dx, dy));
    stitchCount++;
  }
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  stitchCount++;

  // Write proper Tajima header
  header.writeInt32LE(stitchCount, 20);        // stitch count
  header.writeInt32LE(colorChangeCount, 24);   // color changes
  header.writeInt16LE(Math.round(maxX - minX) * 10, 28);  // width * 10
  header.writeInt16LE(Math.round(maxY - minY) * 10, 32);  // height * 10
  header.writeInt16LE(Math.round(minX) * 10, 36);         // min X * 10
  header.writeInt16LE(Math.round(maxX) * 10, 40);         // max X * 10
  header.writeInt16LE(Math.round(minY) * 10, 44);         // min Y * 10
  header.writeInt16LE(Math.round(maxY) * 10, 48);         // max Y * 10
  header.writeInt16LE(0, 52);                   // axis adjust X
  header.writeInt16LE(0, 54);                   // axis adjust Y
  header.write("(c)Stichai", 56, "ascii");      // copyright
  header.writeInt16LE(colorChangeCount + 1, 88); // number of colors

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
   2D PREVIEW RENDERER
   ============================================================ */
function hexToRgbNums(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function setPixel(buf, w, h, x, y, r, g, b) {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || px >= w || py < 0 || py >= h) return;
  const i = (py * w + px) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}

function drawLineOnBuffer(buf, w, h, x0, y0, x1, y1, r, g, b, stroke) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  const half = Math.ceil(stroke / 2);
  while (true) {
    for (let ox = -half; ox <= half; ox++) {
      for (let oy = -half; oy <= half; oy++) {
        setPixel(buf, w, h, x + ox, y + oy, r, g, b);
      }
    }
    if (Math.abs(x - x1) < 0.5 && Math.abs(y - y1) < 0.5) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

async function renderStitchesToPng(stitches, designW, designH) {
  const scale = 4;
  const w = Math.round(designW * scale);
  const h = Math.round(designH * scale);
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    buf[i] = 245; buf[i + 1] = 242; buf[i + 2] = 235; buf[i + 3] = 255;
  }
  let prev = null;
  for (const s of stitches) {
    if (s.type === "trim") { prev = null; continue; }
    if (prev && prev.color === s.color && prev.type !== "trim") {
      const [cr, cg, cb] = hexToRgbNums(s.color);
      const sw = s.type === 'satin' ? 2.0 : (s.type === 'underlay' ? 0.5 : 1.0);
      drawLineOnBuffer(buf, w, h, prev.x * scale, prev.y * scale, s.x * scale, s.y * scale, cr, cg, cb, sw);
    }
    prev = s;
  }
  return await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/* ============================================================
   EXPRESS ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-embroidery", upload.single("image"), async (req, res) => {
  res.setTimeout(0);
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const reqId = Math.random().toString(36).slice(2, 6);
    
    console.time(`preprocess-${reqId}`);
    const cleanBuffer = await preprocessImage(req.file.buffer);
    console.timeEnd(`preprocess-${reqId}`);
    
    const cleanB64 = cleanBuffer.toString("base64");
    const cleanMime = "image/png";
    
    // === STEP 1: PROFESSIONAL ANALYSIS ===
    // Gemini detects: background color, thread colors, text/logo flags
    console.time(`gemini-analyze-${reqId}`);
    const analysis = await analyzeImage(cleanB64, cleanMime);
    console.timeEnd(`gemini-analyze-${reqId}`);
    console.log(`Background: ${analysis.background}, Colors: ${analysis.colors.join(", ")}, Text: ${analysis.is_text}, Logo: ${analysis.is_logo}`);
    
    // === STEP 2: SHAPE EXTRACTION ===
    // PRIMARY: Gemini extracts shapes with proper polygons + types
    // FALLBACK: Pixel tracing with background removal + color quantization
    let shapes = [];
    let extractionMethod = "gemini";
    
    try {
      console.time(`gemini-shapes-${reqId}`);
      shapes = await extractShapesWithGemini(cleanB64, cleanMime, analysis.colors, analysis.is_text, analysis.is_logo);
      console.timeEnd(`gemini-shapes-${reqId}`);
      console.log(`Gemini shapes: ${shapes.length}`);
      
      if (shapes.length < 3) throw new Error("Too few Gemini shapes");
    } catch (e) {
      console.log(`Gemini extraction failed (${e.message}), falling back to pixel tracing`);
      console.time(`pixel-trace-${reqId}`);
      shapes = await extractShapesFromImage(cleanBuffer, analysis.colors, analysis.is_text);
      console.timeEnd(`pixel-trace-${reqId}`);
      extractionMethod = "pixel";
    }
    
    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });
    
    // === STEP 3: STITCH GENERATION ===
    const result = generateStitches(shapes);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(id, result);
    
    // === STEP 4: QUALITY AUDIT ===
    const validation = validateQuality(result.stitches);
    const audit = {
      totalStitches: result.stitches.length,
      shapeCount: shapes.length,
      colorCount: [...new Set(shapes.map(s => toThreadColor(s.color)))].length,
      satinShapes: shapes.filter(s => s.type === "satin").length,
      fillShapes: shapes.filter(s => s.type === "fill").length,
      avgStitchLength: validation.avgStitchLength,
      maxJump: validation.maxJump,
      longJumps: validation.longJumpCount,
      density: validation.density,
      warnings: validation.warnings,
      passed: validation.passed,
    };
    
    console.log(`AUDIT: ${audit.totalStitches} stitches, ${audit.shapeCount} shapes, avg stitch ${audit.avgStitchLength}mm, max jump ${audit.maxJump}mm, warnings: ${audit.warnings.length}`);
    for (const w of audit.warnings) console.log(`  ⚠ ${w}`);
    
    return res.json({
      success: true,
      id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors: [...new Set(shapes.map(s => toThreadColor(s.color)))],
      detection: { method: extractionMethod, background: analysis.background },
      audit,
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, pointCount: s.points.length }))
    });
  } catch (e) {
    console.error("/generate-embroidery error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/preview/:id", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: data.stitches, designW: data.designW, designH: data.designH, shapes: data.shapes });
});

app.get("/preview-image/:id", async (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  try {
    const png = await renderStitchesToPng(data.stitches, data.designW, data.designH);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(png);
  } catch (e) {
    console.error("Preview image error:", e.message);
    return res.status(500).json({ error: e.message });
  }
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

app.get("/health", (_req, res) => res.json({ status: "ok", version: "14.4" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v14.4 running on port ${PORT}`));
server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
