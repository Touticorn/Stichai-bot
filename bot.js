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
   GEMINI COLOR DETECTION – research-backed prompt
   ============================================================ */
async function detectColors(b64, mime) {
  const prompt = `Examine this image carefully. Your task is to identify ONLY the thread colors that are ACTUALLY VISIBLE in the design.

## Step 1: Describe what you see
- What is the background color?
- What design elements are present? (text, logos, emblems, shapes)
- What colors do those design elements use?

## Step 2: Count the distinct thread colors
A "thread color" is a solid, stitchable color that appears in the design itself (NOT the background). Count how many distinct thread colors are actually visible.

## Step 3: List ONLY those colors
- DO NOT add colors you cannot see
- DO NOT guess or suggest colors that "might look good"
- If the design is black and white, your answer is black and white — nothing else
- White counts as a thread color ONLY if it appears as a design element (not background)
- Gold/yellow counts if metallic elements are visible
- If only 2 colors are present, return 2 colors. Do not inflate to 3.

## Examples:
An Adidas logo on a white background: {"colors":["#000000","#FFFFFF"],"is_text":true,"is_logo":true}
A red and gold emblem: {"colors":["#CC0000","#FFD700"],"is_text":false,"is_logo":true}

Return ONLY JSON, no markdown, no explanation:
{"colors":["#hex","#hex",...],"is_text":true|false,"is_logo":true|false}`;

  try {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 1024 }
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
      return d > 35;
    })
    .map(([hex]) => hex);

  return { buffer: cleaned, fallbackColors };
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

/* ============================================================
   PIXEL TRACING – catches tiny details, adaptive fill classification
   FIXED: Uses area-based fill/satin logic instead of defaulting to satin
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

  const tid = Math.random().toString(36).slice(2,5);
  const data = image.bitmap.data;

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y*pw + x) << 2;
      const pixLab = rgbToLab({ r: data[i], g: data[i+1], b: data[i+2] });
      let bestIdx = -1, bestDist = 38;
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
    if (s.pixelCount < 10) continue;
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

  // FIXED: Use area-based fill/satin classification
  // Wide shapes (>2000 sq units) get fill; narrow shapes get satin
  if (filtered.length > 3) {
    for (const s of filtered) {
      const b = polygonBounds(s.points);
      const area = b.width * b.height;
      if (area > 2000) {
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
  const b = polygonBounds(points);
  const area = b.width * b.height;

  const rowSpacing = area < 2000 ? 2.8 : 3.5;
  const stitchSpacing = area < 2000 ? 2.5 : 3.0;

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
  const steps = Math.max(points.length*2, Math.floor(totalLen/4.0));
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
  if (points.length < 2) return stitches;
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

  // Cross‑group ordering to minimise long jumps
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
function stitchRecord(dx, dy) {
  const cdx = Math.max(-121, Math.min(121, Math.round(dx)));
  const cdy = Math.max(-121, Math.min(121, Math.round(dy)));
  return Buffer.from([cdy>=0?cdy:0x100+cdy, cdx>=0?cdx:0x100+cdx, 0x03]);
}

function encodeDST(data) {
  const { stitches } = data;
  const header = Buffer.alloc(512, 0x20);
  header.write("Stichai", 0, "ascii");
  const records = [];
  let lastColor = null, prevX = 0, prevY = 0;
  let stitchCount = 0, colorChangeCount = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0, absX = 0, absY = 0;

  for (const s of stitches) {
    absX += s.x-prevX; absY += s.y-prevY;
    if (absX < minX) minX = absX; if (absX > maxX) maxX = absX;
    if (absY < minY) minY = absY; if (absY > maxY) maxY = absY;

    if (s.color !== lastColor && lastColor !== null) { records.push(Buffer.from([0,0,0xC3])); colorChangeCount++; }
    lastColor = s.color;

    if (s.type === "trim") {
      records.push(Buffer.from([0,0,0xC3]), Buffer.from([0,0,0xC3]), Buffer.from([0,0,0xC3]));
      const dx = s.x-prevX, dy = s.y-prevY;
      prevX = s.x; prevY = s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      for (let i = 1; i <= steps; i++) { const f = i/steps; records.push(stitchRecord(dx*f, dy*f)); }
      continue;
    }
    const dx = Math.round(s.x-prevX), dy = Math.round(s.y-prevY);
    prevX = s.x; prevY = s.y;
    records.push(stitchRecord(dx, dy));
    stitchCount++;
  }
  records.push(Buffer.from([0,0,0xF3]));
  stitchCount++;

  header.writeInt32LE(stitchCount, 20);
  header.writeInt32LE(colorChangeCount, 24);
  header.writeInt16LE(Math.round((maxX-minX)*10), 28);
  header.writeInt16LE(Math.round((maxY-minY)*10), 32);
  header.writeInt16LE(Math.round(minX*10), 36);
  header.writeInt16LE(Math.round(maxX*10), 40);
  header.writeInt16LE(Math.round(minY*10), 44);
  header.writeInt16LE(Math.round(maxY*10), 48);
  header.write("(c)Stichai", 56, "ascii");
  header.writeInt16LE(colorChangeCount+1, 88);

  return Buffer.concat([header, ...records]);
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
      if (dist < 30 && st.color !== "#333333") {
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

    console.time(`posterize-${reqId}`);
    const posterized = await posterizeImage(req.file.buffer);
    console.timeEnd(`posterize-${reqId}`);

    const originalB64 = req.file.buffer.toString("base64");
    let colors = posterized.fallbackColors;
    let isText = true, isLogo = true;

    const gem = await detectColors(originalB64, req.file.mimetype || "image/png");
    if (gem && gem.colors && gem.colors.length >= 3) {
      colors = deduplicateColors(gem.colors);
      isText = gem.is_text !== false;
      isLogo = gem.is_logo !== false;
      console.log(`Gemini: ${colors.join(", ")}`);
    } else {
      console.log(`Posterize: ${colors.join(", ")}`);
    }

    if (isText && !colors.some(c => { const rgb = hexToRgb(c); return (rgb.r + rgb.g + rgb.b) < 120; })) {
      colors.push("#000000");
      console.log("Added black for text");
    }

    console.log(`Final colors (${colors.length}): ${colors.join(", ")}`);

    console.time(`shapes-${reqId}`);
    const shapes = await extractPixelShapes(posterized.buffer, colors, isText);
    console.timeEnd(`shapes-${reqId}`);

    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });

    const result = generateStitches(shapes);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    jobs.set(id, result);

    const v = validateQuality(result.stitches);
    console.log(`${result.stitches.length} stitches, ${shapes.length} shapes, ${shapes.filter(s=>s.type==="fill").length} fill, ${shapes.filter(s=>s.type==="satin").length} satin`);
    for (const w of v.warnings) console.log(`  ⚠ ${w}`);

    return res.json({
      success: true, id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors,
      extraction: { method: "pixel" },
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

app.get("/health", (_req, res) => res.json({ status: "ok", version: "29.0" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v29 running on port ${PORT}`));
server.timeout = 180000;
