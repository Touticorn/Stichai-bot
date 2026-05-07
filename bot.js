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
  const minComponentSize = 20;
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

      /* v9.1 classification: large shapes = always fill, narrow non-large = satin */
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

/* Fix 7: centroid for nearest-neighbor ordering */
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

/* Simple edge-walk underlay — just trace the perimeter inset by 1.5 units */
function edgeWalkUnderlay(points, color) {
  const stitches = [];
  const inset = 1.5;
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * inset;
    const ny = dx / len * inset;
    inner.push([x1 + nx, y1 + ny]);
  }
  const totalLen = inner.reduce((sum, p, i) => {
    const [x1, y1] = p;
    const [x2, y2] = inner[(i + 1) % inner.length];
    return sum + Math.hypot(x2 - x1, y2 - y1);
  }, 0);
  const steps = Math.max(inner.length, Math.floor(totalLen / 3.5));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * inner.length;
    const idx = Math.floor(t) % inner.length;
    const frac = t - Math.floor(t);
    const nextIdx = (idx + 1) % inner.length;
    stitches.push({
      x: Math.round(inner[idx][0] + (inner[nextIdx][0] - inner[idx][0]) * frac),
      y: Math.round(inner[idx][1] + (inner[nextIdx][1] - inner[idx][1]) * frac),
      color, type: "underlay"
    });
  }
  return stitches;
}

/* Simple center-walk underlay for satin — straight line down the middle */
function centerWalkUnderlay(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);

  function toLocal(x, y) { return [x * cosA + y * sinA, -x * sinA + y * cosA]; }
  function toGlobal(lx, ly) { return [lx * cosA - ly * sinA, lx * sinA + ly * cosA]; }

  const localPts = points.map(([x, y]) => toLocal(x, y));
  const b = polygonBounds(localPts);

  for (let lx = b.minX; lx <= b.maxX; lx += 4.0) {
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

/* Fix 3: single-pass tatami fill with tightened rowSpacing */
function contourFillPolygon(points, color) {
  const stitches = [];
  const fillAngle = computeFillAngle(points);
  const cosA = Math.cos(fillAngle), sinA = Math.sin(fillAngle);
  const stitchLen = 2.8, rowSpacing = 2.5;

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
  return stitches;
}

/* Pro satin: perpendicular columns with pull compensation.
   Elongated strokes use principal-axis raycasting.
   Compact shapes fall back to perimeter zigzag. */
function satinColumnPolygon(points, color) {
  const b = polygonBounds(points);
  const bw = b.width, bh = b.height;
  const aspect = Math.max(bw, bh) / Math.min(bw, bh);

  // Compact shapes: perimeter zigzag (bounded, predictable)
  if (aspect < 2.0 || points.length < 8) {
    return satinPerimeterZigzag(points, color);
  }

  // Elongated strokes: perpendicular needle passes
  return satinPerpendicularColumns(points, color);
}

function satinPerimeterZigzag(points, color) {
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

function satinPerpendicularColumns(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const stepSize = 1.5; // stitch density along length
  const pullComp = 0.6; // widen each column by 0.6 units

  function toLocal(x, y) { return [x * cosA + y * sinA, -x * sinA + y * cosA]; }
  function toGlobal(lx, ly) { return [lx * cosA - ly * sinA, lx * sinA + ly * cosA]; }

  const localPts = points.map(([x, y]) => toLocal(x, y));
  const b = polygonBounds(localPts);

  for (let lx = b.minX; lx <= b.maxX; lx += stepSize) {
    const ints = [];
    for (let i = 0, j = localPts.length - 1; i < localPts.length; j = i++) {
      const [x1, y1] = localPts[i], [x2, y2] = localPts[j];
      if ((x1 <= lx && x2 > lx) || (x2 <= lx && x1 > lx)) {
        ints.push(y1 + (lx - x1) / (x2 - x1) * (y2 - y1));
      }
    }
    if (ints.length < 2) continue;
    ints.sort((a, b) => a - b);

    // Find the pair of intersections closest together = stroke width
    let yLeft, yRight, bestGap = Infinity;
    for (let i = 0; i < ints.length - 1; i++) {
      const gap = ints[i + 1] - ints[i];
      if (gap < bestGap && gap > 0.8) {
        bestGap = gap;
        yLeft = ints[i];
        yRight = ints[i + 1];
      }
    }
    if (!yLeft || !yRight) continue;

    // Pull compensation: widen the column
    const mid = (yLeft + yRight) / 2;
    const half = (yRight - yLeft) / 2;
    const compHalf = half + pullComp;
    const outLeft = mid - compHalf;
    const outRight = mid + compHalf;

    const [gx1, gy1] = toGlobal(lx, outLeft);
    const [gx2, gy2] = toGlobal(lx, outRight);
    stitches.push({ x: Math.round(gx1), y: Math.round(gy1), color, type: "satin" });
    stitches.push({ x: Math.round(gx2), y: Math.round(gy2), color, type: "satin" });
  }

  return stitches;
}

/* Fix 6: running stitch walks by true arc length */
function runningPolygon(points, color) {
  const stitches = [];
  if (points.length < 2) return stitches;

  // Build arc-length lookup
  const segLens = [];
  let cumLen = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segLens.push({ start: cumLen, len, idx: i });
    cumLen += len;
  }
  if (cumLen < 1) return stitches;

  const spacing = 2.5;
  const steps = Math.max(1, Math.floor(cumLen / spacing));

  for (let s = 0; s <= steps; s++) {
    const target = (s / steps) * cumLen;
    // Find the segment containing this arc length
    let seg = segLens[0];
    for (const candidate of segLens) {
      if (candidate.start <= target && target < candidate.start + candidate.len) {
        seg = candidate; break;
      }
      // Handle wrap-around at the end
      if (s === steps && target >= candidate.start) seg = candidate;
    }
    const frac = seg.len > 0 ? (target - seg.start) / seg.len : 0;
    const [x1, y1] = points[seg.idx];
    const [x2, y2] = points[(seg.idx + 1) % points.length];
    stitches.push({
      x: Math.round(x1 + (x2 - x1) * frac),
      y: Math.round(y1 + (y2 - y1) * frac),
      color, type: "running"
    });
  }
  return stitches;
}

/* Generate stitches with color grouping, centroid NN, trim logic */
function generateStitches(shapes) {
  const all = [];
  const designW = 300, designH = 300;

  // Precompute centroids (Fix 7)
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

  // Fix 7: nearest-neighbor ordering using centroids
  for (const color of Object.keys(colorGroups)) {
    const group = colorGroups[color];
    if (group.length <= 1) continue;

    const ordered = [group[0]];
    const remaining = group.slice(1);

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
    colorGroups[color] = ordered;
  }

  // Generate stitches — Fix 5: insert trim markers between distant shapes
  let lastX = 0, lastY = 0;

  for (const color of Object.keys(colorGroups)) {
    const group = colorGroups[color];
    for (let gi = 0; gi < group.length; gi++) {
      const s = group[gi];
      const points = s.points || [[0, 0], [10, 0], [10, 10], [0, 10]];
      const type = s.type || "fill";

      // Check jump distance from last stitch to this shape's start
      const [sx, sy] = points[0] || [0, 0];
      const jump = Math.hypot(sx - lastX, sy - lastY);
      if (jump > 10 && all.length > 0) {
        all.push({ x: Math.round(sx), y: Math.round(sy), color, type: "trim" });
      }

      if (type === "fill") {
        all.push(...edgeWalkUnderlay(points, color));
        all.push(...contourFillPolygon(points, color));
      } else if (type === "satin") {
        all.push(...centerWalkUnderlay(points, color));
        all.push(...satinColumnPolygon(points, color));
      } else {
        all.push(...runningPolygon(points, color));
      }

      // Update last position
      if (all.length) {
        const last = all[all.length - 1];
        lastX = last.x; lastY = last.y;
      }
    }
  }

  all.push(...runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
  return { stitches: all, designW, designH, shapes };
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
  const { stitches } = data;
  const header = Buffer.alloc(512);
  const label = "STICHAI";
  for (let i = 0; i < label.length; i++) header[i] = label.charCodeAt(i);
  const records = [];
  let lastColor = null, prevX = 0, prevY = 0;

  for (const s of stitches) {
    // Color change between different colors
    if (s.color !== lastColor && lastColor !== null) {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
    }
    lastColor = s.color;

    // Fix 5: trim = three consecutive color-change bytes (machine cuts thread)
    if (s.type === "trim") {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      // Jump to destination without stitching
      const dx = s.x - prevX, dy = s.y - prevY;
      prevX = s.x; prevY = s.y;
      // Break long jumps into DST-max segments
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 121));
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        records.push(stitchRecord(dx * f, dy * f));
      }
      continue;
    }

    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX = s.x; prevY = s.y;
    records.push(stitchRecord(dx, dy));
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

app.get("/health", (_req, res) => res.json({ status: "ok", version: "11.1" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v11.1 running on port ${PORT}`));
server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
