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

async function preprocessImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: false })
    .linear(1.15, -10)
    .normalize()
    .modulate({ saturation: 1.7 })
    .median(1)
    .sharpen({ sigma: 1.2, m1: 1.5, m2: 2.5 })
    .toFormat("png")
    .toBuffer();
}

async function detectColors(b64, mime) {
  const prompt = `You are analyzing a design for embroidery digitizing.
List the 4-10 distinct THREAD colors needed. Ignore lighting, shadows, gradients, reflections, paper/background unless it is part of the design.
Return ONLY: {"colors":["#RRGGBB","#RRGGBB"], "is_text": true|false, "is_logo": true|false}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  const res = await geminiPost(body, 45000, FLASH_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  const clean = (fb !== -1 && lb > fb) ? jsonStr.slice(fb, lb + 1) : jsonStr;
  const parsed = JSON.parse(clean);

  return {
    colors: deduplicateColors(parsed.colors || ["#FF0000", "#FFFFFF", "#0000FF"]),
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo,
  };
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
   PIXEL TRACING — optimized single-pass scan + boundary healing
   ============================================================ */
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

  console.time("pixel-classify");
  const data = image.bitmap.data;
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
      if (bestDist < 35) pixelColors[outOff + x] = bestIdx;
    }
  }
  console.timeEnd("pixel-classify");

  console.time("heal");
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
  console.timeEnd("heal");

  const visited = new Uint8Array(pw * ph);
  const maskIds = new Uint32Array(pw * ph);
  const shapes = [];
  const minComponentSize = 6;
  let currentMaskId = 1;

  console.time("contour-extract");
  for (let y = 0; y < ph; y++) {
    const row = y * pw;
    for (let x = 0; x < pw; x++) {
      const idx = row + x;
      const ci = pixelColors[idx];
      if (ci === -1 || visited[idx]) continue;

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

        if (cx > 0) {
          const ni = ci2 - 1;
          if (!visited[ni] && pixelColors[ni] === ci) { visited[ni] = 1; maskIds[ni] = currentMaskId; q.push(ni); }
        }
        if (cx < pw - 1) {
          const ni = ci2 + 1;
          if (!visited[ni] && pixelColors[ni] === ci) { visited[ni] = 1; maskIds[ni] = currentMaskId; q.push(ni); }
        }
        if (cy > 0) {
          const ni = ci2 - pw;
          if (!visited[ni] && pixelColors[ni] === ci) { visited[ni] = 1; maskIds[ni] = currentMaskId; q.push(ni); }
        }
        if (cy < ph - 1) {
          const ni = ci2 + pw;
          if (!visited[ni] && pixelColors[ni] === ci) { visited[ni] = 1; maskIds[ni] = currentMaskId; q.push(ni); }
        }
      }

      if (pixelCount < minComponentSize || startX === -1) {
        currentMaskId++;
        continue;
      }

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

      const simplified = ramerDouglasPeucker(contour, 0.25);
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
        pixelCount,
      });
    }
  }

  shapes.sort((a, b) => b.pixelCount - a.pixelCount);
  console.timeEnd("contour-extract");

  const satinCount = shapes.filter(s => s.type === "satin").length;
  const fillCount = shapes.filter(s => s.type === "fill").length;
  console.log(`Shape types: ${satinCount} satin, ${fillCount} fill`);

  console.log(`Extracted ${shapes.length} shapes from pixels (${pw}x${ph})`);
  return shapes;
}

/* ============================================================
   GEMINI FALLBACK — shape extraction
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

  const res = await geminiPost(body, 60000, PRO_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
   STITCH GENERATION — professional output
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

/* Edge-walk + center-walk underlay */
function underlayPolygon(points, color) {
  const stitches = [];
  const bounds = polygonBounds(points);
  const offset = 2.0;

  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * offset, ny = dx / len * offset;
    const ix1 = x1 + nx, iy1 = y1 + ny;
    const ix2 = x2 + nx, iy2 = y2 + ny;
    if (pointInPolygon((ix1 + ix2) / 2, (iy1 + iy2) / 2, points)) {
      stitches.push({ x: Math.round(ix1), y: Math.round(iy1), color, type: "underlay" });
      stitches.push({ x: Math.round(ix2), y: Math.round(iy2), color, type: "underlay" });
    }
  }

  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  if (pointInPolygon(midX, midY, points)) {
    stitches.push({ x: Math.round(bounds.minX), y: Math.round(midY), color, type: "underlay" });
    stitches.push({ x: Math.round(bounds.maxX), y: Math.round(midY), color, type: "underlay" });
  }
  return stitches;
}

/* Compute optimal fill angle from shape's principal axis */
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

/* Professional Tatami Fill */
function contourFillPolygon(points, color) {
  const stitches = [];
  const fillAngle = computeFillAngle(points);
  const cosA = Math.cos(fillAngle), sinA = Math.sin(fillAngle);
  const stitchLen = 2.8, rowSpacing = 3.2;

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
        const stagger = rowSpacing * 0.35;
        segStart += stagger;
        segEnd += stagger;
      }
      if (segEnd - segStart < 6) continue;
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

  // Inner passes for density — skip for small shapes where they add no value
  const shapeArea = (lBounds.maxX - lBounds.minX) * (lBounds.maxY - lBounds.minY);
  if (shapeArea < 1500) return stitches; // small shape: one pass is enough

  for (let pass = 1; pass <= 2; pass++) {
    const inset = pass * rowSpacing * 0.6;
    const innerBounds = {
      minX: lBounds.minX + inset, maxX: lBounds.maxX - inset,
      minY: lBounds.minY + inset, maxY: lBounds.maxY - inset
    };
    if (innerBounds.maxX <= innerBounds.minX || innerBounds.maxY <= innerBounds.minY) break;

    let innerRowIdx = 0;
    for (let ly = innerBounds.minY; ly <= innerBounds.maxY; ly += rowSpacing) {
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
        if (segEnd <= segStart || segEnd - segStart < 6) continue;
        if ((innerRowIdx + pass) % 2 === 1) {
          segStart += rowSpacing * 0.3;
          segEnd += rowSpacing * 0.3;
        }
        const steps = Math.max(1, Math.floor((segEnd - segStart) / stitchLen));
        const dir = (innerRowIdx % 2 === 0) ? 1 : -1;
        const startX = dir === 1 ? segStart : segEnd, endX = dir === 1 ? segEnd : segStart;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const lx = startX + (endX - startX) * t;
          const [gx, gy] = toGlobal(lx, ly);
          stitches.push({ x: Math.round(gx), y: Math.round(gy), color, type: "fill" });
        }
      }
      innerRowIdx++;
    }
  }

  return stitches;
}

/* REAL SATIN STITCH — zigzag between inner/outer contours */
function satinColumnPolygon(points, color) {
  const stitches = [];
  const width = 2.5; // column width in units

  // Build inner contour by offsetting inward
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

  // Zigzag between outer and inner
  const totalLen = points.length * 10;
  const steps = Math.max(points.length * 4, Math.floor(totalLen / 1.5));
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

/* Running stitch outline */
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

/* Generate stitches with color grouping and NN ordering */
function generateStitches(shapes) {
  const all = [];
  const designW = 300, designH = 300;

  // Group by color
  const colorGroups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color || "#FF0066");
    if (!colorGroups[c]) colorGroups[c] = [];
    colorGroups[c].push({ ...s, color: c });
  }

  // Within each color group, reorder by nearest-neighbor
  for (const color of Object.keys(colorGroups)) {
    const group = colorGroups[color];
    if (group.length <= 1) continue;

    const ordered = [group[0]];
    const remaining = group.slice(1);

    while (remaining.length) {
      let bestIdx = 0, bestDist = Infinity;
      const last = ordered[ordered.length - 1];
      const [lx, ly] = last.points[0] || [0, 0];

      for (let i = 0; i < remaining.length; i++) {
        const [fx, fy] = remaining[i].points[0] || [0, 0];
        const d = Math.hypot(fx - lx, fy - ly);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }
    colorGroups[color] = ordered;
  }

  // Generate stitches for each shape — push in-place, never concat
  for (const color of Object.keys(colorGroups)) {
    for (const s of colorGroups[color]) {
      const points = s.points || [[0, 0], [10, 0], [10, 10], [0, 10]];
      const type = s.type || "fill";

      if (type === "fill") {
        all.push(...underlayPolygon(points, color));
        all.push(...contourFillPolygon(points, color));
        all.push(...runningPolygon(points, color));
      } else if (type === "satin") {
        all.push(...satinColumnPolygon(points, color));
      } else {
        all.push(...runningPolygon(points, color));
      }
    }
  }

  all.push(...runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
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
    const cdx = Math.max(-121, Math.min(121, dx)), cdy = Math.max(-121, Math.min(121, dy));
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
    if (prev && prev.color === s.color) {
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
    console.time("preprocess");
    const cleanBuffer = await preprocessImage(req.file.buffer);
    console.timeEnd("preprocess");
    
    const cleanB64 = cleanBuffer.toString("base64");
    const cleanMime = "image/png";
    
    console.time("gemini-colors");
    const detection = await detectColors(cleanB64, cleanMime);
    console.timeEnd("gemini-colors");
    
    const colors = detection.colors;
    console.log("Colors:", colors, "is_text:", detection.is_text, "is_logo:", detection.is_logo);
    let shapes;
    let extractionMethod = "pixel";
    try {
      shapes = await extractShapesFromImage(cleanBuffer, colors, detection.is_text);
      if (shapes.length < 3 && detection.is_text) {
        console.log("Few pixel shapes for text — supplementing with Gemini");
        const geminiShapes = await extractShapesWithGemini(cleanB64, cleanMime, detection);
        shapes = shapes.concat(geminiShapes);
        extractionMethod = "hybrid";
      }
    } catch (e) {
      console.error("Pixel extraction failed:", e.message);
      shapes = await extractShapesWithGemini(cleanB64, cleanMime, detection);
      extractionMethod = "gemini";
      console.log("Gemini fallback shapes:", shapes.length);
    }
    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });
    const result = generateStitches(shapes);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(id, result);
    return res.json({
      success: true,
      id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors,
      detection: { is_text: detection.is_text, is_logo: detection.is_logo, method: extractionMethod },
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, points: s.points, pointCount: s.points.length }))
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

app.get("/health", (_req, res) => res.json({ status: "ok", version: "9.2" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v9.2 running on port ${PORT}`));
server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
