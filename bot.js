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
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(makeUrl(primaryModel), body, { timeout: timeoutMs });
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const jobs = new Map();
const previewCache = new Map();

/* ============================================================
   STAGE 1: GEMINI ANALYSIS — color detection + design understanding
   ============================================================ */
async function analyzeImage(b64, mime) {
  const prompt = `You are a professional embroidery digitizer. Analyze this image.

Return ONLY a JSON object, no markdown, no explanation:
{
  "background": "#RRGGBB",
  "colors": ["#RRGGBB", "#RRGGBB", ...],
  "is_text": true or false,
  "is_logo": true or false
}

Rules:
- background: the paper/surface behind the design
- colors: 3-6 distinct thread colors in the actual design
- Include WHITE if it's a design element (not just background)
- Include GOLD/YELLOW for metallic elements, crowns, emblems
- Include BLACK for any dark text or elements
- Include RED, BLUE, GREEN for vibrant design colors
- is_text: true if image has readable text/letters
- is_logo: true if image has emblems, crowns, shields, or brand marks`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.02, maxOutputTokens: 1024 }
  };

  const res = await geminiPost(body, 25000, FLASH_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);
  
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { parsed = JSON.parse(repairJSON(jsonStr)); }
  
  return {
    background: parsed.background || "#FFFFFF",
    colors: deduplicateColors(parsed.colors || []),
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo
  };
}

/* ============================================================
   STAGE 2: GEMINI SHAPE EXTRACTION — for complex images with logos
   ============================================================ */
async function extractGeminiShapes(b64, mime, analysis) {
  const colorList = analysis.colors.join(", ");
  const hasLogo = analysis.is_logo ? "This image contains a LOGO/EMBLEM. Pay special attention to crowns, shields, and small decorative elements." : "";
  
  const prompt = `You are a professional embroidery digitizer.

Image characteristics: ${analysis.is_text ? 'contains text' : ''} ${analysis.is_logo ? 'contains logo/emblem' : ''}
${hasLogo}

Thread colors available: ${colorList}

Extract ALL shapes from this image. For each shape provide:
- "type": "satin" for thin strokes and letters, "fill" for wide solid areas
- "color": exact hex from the color list
- "points": polygon boundary as [[x,y],[x,y],...] in 0-300 coordinate space

CRITICAL RULES:
1. Every letter in text = SEPARATE shape
2. Crown/emblem = MULTIPLE shapes (each color region is a shape)
3. Thin strokes = "satin", thick blocks = "fill"
4. Points must be DETAILED (20-80 per shape)
5. Close every polygon (last point = first point)
6. SMALL shapes matter — include even tiny crown dots and accents
7. Maximum 60 shapes total

Return ONLY:
{"shapes":[{"type":"fill|satin","color":"#hex","points":[[x,y],[x,y],...]},...]}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.03, maxOutputTokens: 8192 }
  };

  const res = await geminiPost(body, 90000, PRO_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  console.log(`Gemini raw output (first 300 chars): ${text.substring(0, 300)}`);
  
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);

  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { 
    console.log(`Gemini JSON parse failed, attempting repair`);
    parsed = JSON.parse(repairJSON(jsonStr)); 
  }

  const shapes = [];
  for (const s of parsed.shapes || []) {
    if (!s.points || !Array.isArray(s.points) || s.points.length < 3) continue;
    
    const points = s.points.map(p => 
      Array.isArray(p) ? [Math.round(p[0]), Math.round(p[1])] : 
      [Math.round(p.x || 0), Math.round(p.y || 0)]
    );
    
    const first = points[0], last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    
    const b = polygonBounds(points);
    if (b.width < 1 || b.height < 1) continue;
    if (points.length < 4) continue;
    
    shapes.push({
      type: s.type === "satin" ? "satin" : "fill",
      color: s.color || analysis.colors[0],
      points,
      pixelCount: Math.round(b.width * b.height)
    });
  }
  
  console.log(`Gemini extracted ${shapes.length} shapes`);
  return shapes;
}

/* ============================================================
   PREPROCESSING — enhanced pipeline for clean images
   ============================================================ */
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

/* ============================================================
   PIXEL TRACING — fallback for simple images
   ============================================================ */
function ramerDouglasPeucker(points, epsilon) {
  if (points.length <= 3) return points;
  const lineDist = (px, py, sx, sy, ex, ey) => {
    const len = Math.sqrt((ex-sx)**2 + (ey-sy)**2);
    if (len === 0) return Math.sqrt((px-sx)**2 + (py-sy)**2);
    return Math.abs((ey-sy)*px - (ex-sx)*py + ex*sy - ey*sx) / len;
  };
  const stack = [[0, points.length-1]];
  const keep = new Set([0, points.length-1]);
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start+1) continue;
    const [sx, sy] = points[start], [ex, ey] = points[end];
    let maxDist = 0, maxIdx = -1;
    for (let i = start+1; i < end; i++) {
      const d = lineDist(points[i][0], points[i][1], sx, sy, ex, ey);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) { keep.add(maxIdx); stack.push([start, maxIdx], [maxIdx, end]); }
  }
  return Array.from(keep).sort((a,b) => a-b).map(i => points[i]);
}

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

  const data = image.bitmap.data;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y*pw + x) << 2;
      const pixLab = rgbToLab({ r: data[i], g: data[i+1], b: data[i+2] });
      let bestIdx = -1, bestDist = 45;
      for (let c = 0; c < labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestIdx >= 0) pixelColors[y*pw + x] = bestIdx;
    }
  }

  for (let y = 1; y < ph-1; y++) {
    for (let x = 1; x < pw-1; x++) {
      const idx = y*pw + x;
      if (pixelColors[idx] !== -1) continue;
      const n4 = [pixelColors[idx-1], pixelColors[idx+1], pixelColors[idx-pw], pixelColors[idx+pw]];
      const valid = n4.filter(n => n !== -1);
      if (valid.length >= 3) {
        const freq = {};
        for (const n of valid) freq[n] = (freq[n]||0) + 1;
        let best = -1, bestCnt = 0;
        for (const [k,v] of Object.entries(freq)) { if (v > bestCnt) { bestCnt = v; best = parseInt(k); } }
        if (bestCnt >= 3) pixelColors[idx] = best;
      }
    }
  }

  const shapes = [];
  const minComponentSize = 8;
  let currentMaskId = 1;

  for (let ci = 0; ci < labColors.length; ci++) {
    const visited = new Uint8Array(pw*ph);
    const maskIds = new Uint32Array(pw*ph);

    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = y*pw + x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        const q = [idx];
        let qPtr = 0, pixelCount = 0;
        let startX = -1, startY = -1;
        visited[idx] = 1;
        maskIds[idx] = currentMaskId;

        while (qPtr < q.length) {
          const ci2 = q[qPtr++];
          pixelCount++;
          const cx = ci2 % pw, cy = (ci2 / pw) | 0;

          if (startX === -1) {
            if (cx === 0 || pixelColors[ci2-1] !== ci || cx === pw-1 || pixelColors[ci2+1] !== ci ||
                cy === 0 || pixelColors[ci2-pw] !== ci || cy === ph-1 || pixelColors[ci2+pw] !== ci) {
              startX = cx; startY = cy;
            }
          }

          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dy === 0 && dx === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
                const ni = ny*pw + nx;
                if (!visited[ni] && pixelColors[ni] === ci) {
                  visited[ni] = 1;
                  maskIds[ni] = currentMaskId;
                  q.push(ni);
                }
              }
            }
          }
        }

        if (pixelCount < minComponentSize || startX === -1) { currentMaskId++; continue; }

        const contour = [];
        const n8 = [[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1]];
        let cx = startX, cy = startY, dir = 7, safety = 0;
        const inMask = (mx, my) => mx>=0 && mx<pw && my>=0 && my<ph && maskIds[my*pw+mx]===currentMaskId;

        do {
          contour.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (dir + i) & 7;
            const nx = cx + n8[d][0], ny = cy + n8[d][1];
            if (inMask(nx, ny)) { cx = nx; cy = ny; dir = (d+5)&7; found = true; break; }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 500000);

        currentMaskId++;
        if (contour.length < 4) continue;

        const simplified = ramerDouglasPeucker(contour, 0.25);
        const stitchScale = 300 / Math.max(pw, ph);
        const points = simplified.map(([px, py]) => [Math.round(px*stitchScale), Math.round(py*stitchScale)]);

        if (points.length >= 3) {
          const first = points[0], last = points[points.length-1];
          if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        }
        const bw = maxX - minX, bh = maxY - minY;
        const isNarrow = (bw < 12 || bh < 12) && (bw*bh) < 13500;

        shapes.push({ type: isNarrow ? "satin" : "fill", color: colors[ci], points, pixelCount });
      }
    }
  }

  shapes.sort((a, b) => b.pixelCount - a.pixelCount);

  const filtered = [];
  for (const s of shapes) {
    const b = polygonBounds(s.points);
    if (b.width < 2 || b.height < 2) continue;
    if (s.pixelCount < 20) continue;
    if (s.points.length < 4) continue;
    let contained = false;
    for (const other of shapes) {
      if (other === s || other.color !== s.color) continue;
      const ob = polygonBounds(other.points);
      if (ob.area <= b.area) continue;
      let allIn = true;
      for (const [px, py] of s.points) {
        if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) { allIn = false; break; }
      }
      if (allIn) { contained = true; break; }
    }
    if (!contained) filtered.push(s);
  }

  if (isText && filtered.length > 3) {
    for (const s of filtered) {
      const b = polygonBounds(s.points);
      const narrow = Math.min(b.width, b.height) < 20;
      s.type = (!narrow && s.pixelCount > 200) ? "fill" : "satin";
    }
  }

  return filtered;
}

/* ============================================================
   COLOR UTILITIES
   ============================================================ */
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16)
  };
}

function rgbToLab({ r, g, b }) {
  let R = r/255, G = g/255, B = b/255;
  R = R > 0.04045 ? Math.pow((R+0.055)/1.055, 2.4) : R/12.92;
  G = G > 0.04045 ? Math.pow((G+0.055)/1.055, 2.4) : G/12.92;
  B = B > 0.04045 ? Math.pow((B+0.055)/1.055, 2.4) : B/12.92;
  const X = R*0.4124 + G*0.3576 + B*0.1805;
  const Y = R*0.2126 + G*0.7152 + B*0.0722;
  const Z = R*0.0193 + G*0.1192 + B*0.9505;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116;
  return { l: 116*f(Y)-16, a: 500*(f(X/0.95047)-f(Y)), b: 200*(f(Y)-f(Z/1.08883)) };
}

function colorDistanceLab(c1, c2) {
  return Math.sqrt((c1.l-c2.l)**2 + (c1.a-c2.a)**2 + (c1.b-c2.b)**2);
}

function deduplicateColors(colors) {
  const unique = [];
  const labs = colors.map(c => rgbToLab(hexToRgb(c)));
  for (let i = 0; i < colors.length; i++) {
    let dup = false;
    for (let j = 0; j < unique.length; j++) {
      if (colorDistanceLab(labs[i], rgbToLab(hexToRgb(unique[j]))) < 20) { dup = true; break; }
    }
    if (!dup) unique.push(colors[i]);
  }
  return unique;
}

function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
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
  const trimmed = repaired.trim(), lastChar = trimmed[trimmed.length-1];
  if (lastChar === ',') repaired += '"x":0}';
  else if (lastChar !== '}' && lastChar !== ']') repaired += '0}';
  for (let i=0; i<openBraces; i++) repaired += '}';
  for (let i=0; i<openBrackets; i++) repaired += ']';
  return repaired;
}

/* ============================================================
   STITCH GENERATION — proximity-ordered
   ============================================================ */
function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX-minX, height: maxY-minY, area: (maxX-minX)*(maxY-minY) };
}

function polygonCentroid(points) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = points.length-1; i < points.length; j = i++) {
    const [x1, y1] = points[i], [x2, y2] = points[j];
    const cross = x1*y2 - x2*y1;
    cx += (x1+x2)*cross; cy += (y1+y2)*cross; a += cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 0.001) {
    let sx = 0, sy = 0;
    for (const [x, y] of points) { sx += x; sy += y; }
    return [sx/points.length, sy/points.length];
  }
  return [cx/(6*a), cy/(6*a)];
}

function computeFillAngle(points) {
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= points.length; cy /= points.length;
  let mxx = 0, myy = 0, mxy = 0;
  for (const [x, y] of points) {
    const dx = x-cx, dy = y-cy;
    mxx += dx*dx; myy += dy*dy; mxy += dx*dy;
  }
  return Math.abs(mxy) < 0.001 ? 0 : Math.atan2(2*mxy, mxx-myy)/2;
}

function underlayFillPolygon(points, color) {
  const stitches = [];
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i+1)%points.length];
    const dx = x2-x1, dy = y2-y1;
    const len = Math.hypot(dx, dy) || 1;
    inner.push([x1 - dy/len*1.5, y1 + dx/len*1.5]);
  }
  const totalLen = inner.reduce((s, p, i) => s + Math.hypot(inner[(i+1)%inner.length][0]-p[0], inner[(i+1)%inner.length][1]-p[1]), 0);
  const steps = Math.max(inner.length, Math.floor(totalLen/6));
  for (let i = 0; i <= steps; i++) {
    const t = (i/steps)*inner.length;
    const idx = Math.floor(t)%inner.length;
    const frac = t - Math.floor(t);
    const next = (idx+1)%inner.length;
    stitches.push({
      x: Math.round(inner[idx][0] + (inner[next][0]-inner[idx][0])*frac),
      y: Math.round(inner[idx][1] + (inner[next][1]-inner[idx][1])*frac),
      color, type: "underlay"
    });
  }
  return stitches;
}

function contourFillPolygon(points, color) {
  const stitches = [];
  const angle = computeFillAngle(points);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const rowSpacing = 3.5, stitchSpacing = 3.0;

  function toLocal(x, y) { return [x*cosA + y*sinA, -x*sinA + y*cosA]; }
  function toGlobal(lx, ly) { return [lx*cosA - ly*sinA, lx*sinA + ly*cosA]; }

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
      let segStart = ints[k] + 0.5, segEnd = ints[k+1] - 0.5;
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

function satinColumnPolygon(points, color) {
  const stitches = [];
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i+1)%points.length];
    const dx = x2-x1, dy = y2-y1;
    const len = Math.hypot(dx, dy) || 1;
    inner.push([x1 - dy/len*1.25, y1 + dx/len*1.25]);
  }
  const totalLen = points.reduce((s, p, i) => s + Math.hypot(points[(i+1)%points.length][0]-p[0], points[(i+1)%points.length][1]-p[1]), 0);
  const steps = Math.max(points.length*2, Math.floor(totalLen/3.5));
  for (let i = 0; i <= steps; i++) {
    const t = (i/steps)*points.length;
    const idx = Math.floor(t)%points.length;
    const frac = t - Math.floor(t);
    const next = (idx+1)%points.length;
    if (i%2 === 0) {
      stitches.push({ x: Math.round(points[idx][0] + (points[next][0]-points[idx][0])*frac), y: Math.round(points[idx][1] + (points[next][1]-points[idx][1])*frac), color, type: "satin" });
    } else {
      stitches.push({ x: Math.round(inner[idx][0] + (inner[next][0]-inner[idx][0])*frac), y: Math.round(inner[idx][1] + (inner[next][1]-inner[idx][1])*frac), color, type: "satin" });
    }
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [];
  let cumLen = 0;
  const segs = points.map((p, i) => {
    const len = Math.hypot(points[(i+1)%points.length][0]-p[0], points[(i+1)%points.length][1]-p[1]);
    const s = { start: cumLen, len, idx: i };
    cumLen += len;
    return s;
  });
  if (cumLen < 1) return stitches;
  const steps = Math.max(1, Math.floor(cumLen/3));
  for (let s = 0; s <= steps; s++) {
    const target = (s/steps)*cumLen;
    const seg = segs.find(sg => target >= sg.start && target < sg.start+sg.len) || segs[segs.length-1];
    const frac = seg.len > 0 ? (target-seg.start)/seg.len : 0;
    const [x1, y1] = points[seg.idx], [x2, y2] = points[(seg.idx+1)%points.length];
    stitches.push({ x: Math.round(x1+(x2-x1)*frac), y: Math.round(y1+(y2-y1)*frac), color, type: "running" });
  }
  return stitches;
}

function generateStitches(shapes) {
  const all = [], designW = 300, designH = 300;
  for (const s of shapes) s.centroid = polygonCentroid(s.points);

  const groups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color);
    if (!groups[c]) groups[c] = [];
    groups[c].push({ ...s, color: c });
  }

  // Order color groups by proximity
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
    let group = groups[color];
    // NN order within group by start point proximity to previous end point
    for (let i = 0; i < group.length; i++) {
      if (i === 0) {
        let bestIdx = 0, bestDist = Infinity;
        for (let j = 0; j < group.length; j++) {
          const [sx, sy] = group[j].points[0];
          const d = Math.hypot(sx - lastX, sy - lastY);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        [group[0], group[bestIdx]] = [group[bestIdx], group[0]];
      } else {
        const prevLast = group[i-1].points[group[i-1].points.length - 1];
        let bestIdx = i, bestDist = Infinity;
        for (let j = i; j < group.length; j++) {
          const [sx, sy] = group[j].points[0];
          const d = Math.hypot(sx - prevLast[0], sy - prevLast[1]);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        [group[i], group[bestIdx]] = [group[bestIdx], group[i]];
      }

      const s = group[i];
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
   QUALITY VALIDATION
   ============================================================ */
function validateQuality(stitches) {
  const warnings = [];
  let totalLen = 0, stitchCount = 0, maxJump = 0, longJumps = 0, prev = null;
  for (const s of stitches) {
    if (prev) {
      const d = Math.hypot(s.x-prev.x, s.y-prev.y);
      if (d > maxJump) maxJump = d;
      if (d > 10) longJumps++;
      if (s.type !== "trim" && prev.type !== "trim") { totalLen += d; stitchCount++; }
    }
    prev = s;
  }
  const avgLen = stitchCount > 0 ? totalLen/stitchCount : 0;
  if (avgLen > 4) warnings.push(`Long stitches (${avgLen.toFixed(1)}mm)`);
  if (avgLen < 1.5) warnings.push(`Dense stitches (${avgLen.toFixed(1)}mm)`);
  if (maxJump > 30) warnings.push(`Long jump (${maxJump.toFixed(1)}mm)`);
  if (longJumps > 30) warnings.push(`${longJumps} long jumps`);
  if (stitchCount > 50000) warnings.push(`High count (${stitchCount})`);
  return { avgStitchLength: avgLen.toFixed(1), maxJump: maxJump.toFixed(1), longJumpCount: longJumps, stitchCount, warnings, passed: !warnings.length };
}

/* ============================================================
   DST ENCODER
   ============================================================ */
function encodeDST(data) {
  const h = Buffer.alloc(512, 0x20);
  h.write("Stichai", 0, "ascii");
  const records = [];
  let lastColor = null, px = 0, py = 0, stitchCount = 0, colorCount = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0, absX = 0, absY = 0;

  for (const s of data.stitches) {
    absX += s.x-px; absY += s.y-py;
    if (absX < minX) minX = absX; if (absX > maxX) maxX = absX;
    if (absY < minY) minY = absY; if (absY > maxY) maxY = absY;

    if (s.color !== lastColor && lastColor !== null) { records.push(Buffer.from([0,0,0xC3])); colorCount++; }
    lastColor = s.color;

    if (s.type === "trim") {
      records.push(Buffer.from([0,0,0xC3]), Buffer.from([0,0,0xC3]), Buffer.from([0,0,0xC3]));
      const dx = s.x-px, dy = s.y-py;
      px = s.x; py = s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      for (let i = 1; i <= steps; i++) {
        const f = i/steps;
        const cdx = Math.max(-121, Math.min(121, Math.round(dx*f)));
        const cdy = Math.max(-121, Math.min(121, Math.round(dy*f)));
        records.push(Buffer.from([cdy>=0?cdy:0x100+cdy, cdx>=0?cdx:0x100+cdx, 3]));
      }
      continue;
    }
    const dx = Math.round(s.x-px), dy = Math.round(s.y-py);
    px = s.x; py = s.y;
    const cdx = Math.max(-121, Math.min(121, dx));
    const cdy = Math.max(-121, Math.min(121, dy));
    records.push(Buffer.from([cdy>=0?cdy:0x100+cdy, cdx>=0?cdx:0x100+cdx, 3]));
    stitchCount++;
  }
  records.push(Buffer.from([0,0,0xF3]));
  stitchCount++;

  h.writeInt32LE(stitchCount, 20);
  h.writeInt32LE(colorCount, 24);
  h.writeInt16LE(Math.round((maxX-minX)*10), 28);
  h.writeInt16LE(Math.round((maxY-minY)*10), 32);
  h.writeInt16LE(Math.round(minX*10), 36);
  h.writeInt16LE(Math.round(maxX*10), 40);
  h.writeInt16LE(Math.round(minY*10), 44);
  h.writeInt16LE(Math.round(maxY*10), 48);
  h.write("(c)Stichai", 56, "ascii");
  h.writeInt16LE(colorCount+1, 88);

  return Buffer.concat([h, ...records]);
}

function encodeFile(format, data) {
  const d = encodeDST(data);
  switch ((format||"dst").toLowerCase()) {
    case "dst": return { buf: d, ext: "dst" };
    case "pes": { const h = Buffer.alloc(8); h.write("#PES0001", 0, "ascii"); return { buf: Buffer.concat([h,d]), ext: "pes" }; }
    case "jef": { const h = Buffer.alloc(8); h.write("JEF0001\x00", 0, "ascii"); return { buf: Buffer.concat([h,d]), ext: "jef" }; }
    case "exp": { const h = Buffer.alloc(8); h.write("EXP0001\x00", 0, "ascii"); return { buf: Buffer.concat([h,d]), ext: "exp" }; }
    case "vp3": { const h = Buffer.alloc(8); h.write("VP30001\x00", 0, "ascii"); return { buf: Buffer.concat([h,d]), ext: "vp3" }; }
    default: return { buf: d, ext: "dst" };
  }
}

/* ============================================================
   PREVIEW RENDERER
   ============================================================ */
async function renderStitchesToPng(stitches, dw, dh) {
  const s = 2, w = Math.round(dw*s), h = Math.round(dh*s);
  const buf = Buffer.alloc(w*h*4);
  for (let i = 0; i < w*h*4; i += 4) { buf[i] = 245; buf[i+1] = 242; buf[i+2] = 235; buf[i+3] = 255; }

  const sp = (x, y, r, g, b) => {
    const px = Math.round(x), py = Math.round(y);
    if (px<0||px>=w||py<0||py>=h) return;
    const i = (py*w+px)*4; buf[i]=r; buf[i+1]=g; buf[i+2]=b; buf[i+3]=255;
  };

  let prev = null;
  for (const st of stitches) {
    if (st.type === "trim") { prev = null; continue; }
    if (prev && prev.color === st.color && prev.type !== "trim") {
      const dist = Math.hypot(st.x-prev.x, st.y-prev.y);
      if (dist < 15 && st.color !== "#333333") {
        const m = st.color.match(/^#([0-9a-fA-F]{6})$/);
        const [cr, cg, cb] = m ? [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)] : [0,0,0];
        const sw = st.type === "satin" ? 2 : 1;
        const dx = Math.abs(st.x-prev.x)*s, dy = Math.abs(st.y-prev.y)*s;
        const sx = prev.x < st.x ? 1 : -1, sy = prev.y < st.y ? 1 : -1;
        let err = dx-dy, x = prev.x*s, y = prev.y*s;
        const half = Math.ceil(sw/2);
        while (true) {
          for (let ox = -half; ox <= half; ox++) for (let oy = -half; oy <= half; oy++) sp(x+ox, y+oy, cr, cg, cb);
          if (Math.abs(x-st.x*s) < .5 && Math.abs(y-st.y*s) < .5) break;
          const e2 = 2*err;
          if (e2 > -dy) { err -= dy; x += sx; }
          if (e2 < dx) { err += dx; y += sy; }
        }
      }
    }
    prev = st;
  }
  return await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/* ============================================================
   ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-embroidery", upload.single("image"), async (req, res) => {
  res.setTimeout(0);
  const reqId = Math.random().toString(36).slice(2,6);
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    // Preprocess
    console.time(`preprocess-${reqId}`);
    const enhanced = await preprocessImage(req.file.buffer);
    console.timeEnd(`preprocess-${reqId}`);

    // Gemini analyzes original image for colors + design understanding
    const originalB64 = req.file.buffer.toString("base64");
    console.time(`analyze-${reqId}`);
    let analysis;
    try {
      analysis = await analyzeImage(originalB64, req.file.mimetype || "image/png");
    } catch (e) {
      console.log(`Analysis failed: ${e.message}`);
      analysis = { background: "#FFFFFF", colors: ["#CC0000", "#000000", "#FFFFFF", "#FFD700"], is_text: true, is_logo: true };
    }
    console.timeEnd(`analyze-${reqId}`);
    console.log(`Colors: ${analysis.colors.join(", ")}, Text: ${analysis.is_text}, Logo: ${analysis.is_logo}`);

    // Ensure black for text
    if (analysis.is_text && !analysis.colors.some(c => {
      const rgb = hexToRgb(c);
      return (rgb.r + rgb.g + rgb.b) < 120;
    })) {
      analysis.colors.push("#000000");
    }

    // Shape extraction — smart routing based on design complexity
    console.time(`shapes-${reqId}`);
    let shapes = [];
    let method = "pixel";

    // For logos/emblems, Gemini understands the design better than pixel tracing
    if (analysis.is_logo) {
      try {
        shapes = await extractGeminiShapes(originalB64, req.file.mimetype || "image/png", analysis);
        if (shapes.length >= 5) {
          method = "gemini";
        } else {
          console.log(`Gemini only returned ${shapes.length} shapes, falling back to pixel`);
          shapes = [];
        }
      } catch (e) {
        console.log(`Gemini extraction failed: ${e.message}`);
      }
    }

    // Pixel tracer fallback for simple images or if Gemini failed
    if (shapes.length < 3) {
      shapes = await extractPixelShapes(enhanced, analysis.colors, analysis.is_text);
      method = "pixel";
    }
    console.timeEnd(`shapes-${reqId}`);
    console.log(`${method} extracted ${shapes.length} shapes`);

    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });

    const result = generateStitches(shapes);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    jobs.set(id, result);

    const v = validateQuality(result.stitches);
    console.log(`${result.stitches.length} stitches, ${shapes.length} shapes, ${method}`);
    for (const w of v.warnings) console.log(`  ⚠ ${w}`);

    return res.json({
      success: true, id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors: analysis.colors,
      extraction: { method },
      audit: v,
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, pointCount: s.points.length }))
    });
  } catch (e) {
    console.error(`Error [${reqId}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/preview/:id", (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: d.stitches, designW: d.designW, designH: d.designH });
});

app.get("/preview-image/:id", async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  const c = previewCache.get(req.params.id);
  if (c && Date.now()-c.ts < 60000) {
    res.setHeader("Content-Type", "image/png");
    return res.send(c.buf);
  }
  try {
    const png = await Promise.race([
      renderStitchesToPng(d.stitches, d.designW, d.designH),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))
    ]);
    previewCache.set(req.params.id, { buf: png, ts: Date.now() });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(png);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/download/:id/:format", (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  const { buf, ext } = encodeFile(req.params.format||"dst", d);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health", (_req, res) => res.json({ status: "ok", version: "24.0" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v24 running on port ${PORT}`));
server.timeout = 180000;
