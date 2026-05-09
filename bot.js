const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
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
        console.log(`Gemini ${primaryModel} ${status}, retry ${i+1}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else throw e;
    }
  }
  throw lastErr;
}

const jobs = new Map();
const previewCache = new Map();

/* ============================================================
   STAGE 1: PROFESSIONAL POSTERIZATION PIPELINE
   ============================================================ */
async function posterizeImage(buffer, colorCount = 8) {
  const denoised = await sharp(buffer)
    .median(3)
    .sharpen({ sigma: 2.5, m1: 2, m2: 5 })
    .toBuffer();

  const posterized = await sharp(denoised)
    .png({ colours: colorCount, dither: 0 })
    .toBuffer();

  const { data, info } = await sharp(posterized)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const colorMap = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const hex = '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('').toUpperCase();
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }

  const sorted = [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);

  const designColors = sorted.filter(hex => {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return (r + g + b) < 700;
  }).slice(0, 6);

  if (designColors.length < 2) {
    designColors.push(...sorted.slice(1, 5));
  }

  return {
    buffer: posterized,
    colors: designColors,
    posterized: true
  };
}

/* ============================================================
   STAGE 2: TWO‑PROMPT GEMINI PIPELINE
   Prompt 1: Color Analysis (Flash, fast)
   Prompt 2: Shape Extraction (Pro, accurate)
   ============================================================ */

async function analyzeImagePro(b64, mime) {
  const prompt = `Analyze this image for embroidery digitizing.

Return ONLY a JSON object:
{
  "background": "#RRGGBB",
  "colors": ["#RRGGBB", "#RRGGBB", ...],
  "elements": ["red bold text KING", "gold crown emblem above text", "black text SIZE", "black script text Winstor"],
  "is_text": true,
  "is_logo": true
}

RULES:
- Find exactly 4-8 thread colors (include black for dark text, gold for metallic elements)
- "elements": list every distinct design element you see (crown, each word, borders, shields)
- "is_text": true if ANY readable letters/words exist
- "is_logo": true if emblem/crown/shield/brand mark exists
- Be specific in "elements" — "gold crown with red interior" not just "emblem"`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.02, maxOutputTokens: 512 }
  };

  const res = await geminiPost(body, 25000, FLASH_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);
  
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { parsed = JSON.parse(repairJSON(jsonStr)); }
  
  let colors = deduplicateColors(parsed.colors || []);
  
  if (parsed.is_text && !colors.some(c => {
    const rgb = hexToRgb(c);
    return (rgb.r + rgb.g + rgb.b) < 120;
  })) {
    colors.push("#000000");
  }
  
  return {
    background: parsed.background || "#FFFFFF",
    colors,
    elements: parsed.elements || [],
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo,
  };
}

async function extractShapesFromAnalysis(b64, mime, analysis) {
  const elementsList = analysis.elements.length > 0 
    ? `Design elements I can see: ${analysis.elements.join(", ")}`
    : '';
  
  const prompt = `You are a professional embroidery digitizer.

${elementsList}

Thread colors available: ${analysis.colors.join(", ")}

Extract ALL shapes from this image. For each shape provide:
- "type": "satin" for thin strokes/letters (< 8mm wide), "fill" for wide solid areas
- "color": exact hex from the list above
- "points": polygon boundary as [[x,y],[x,y],...] in 0-300 coordinate space

CRITICAL:
- Each letter in a word = SEPARATE shape (e.g., "K", "I", "N", "G" = 4 shapes)
- Crown/emblem = MULTIPLE shapes (one per color region)
- Thin text strokes = satin, thick block letters = fill
- Every element from the list above MUST appear in the output
- Points must be DETAILED (20-60 points per shape, not 5)
- Close every polygon (last point = first point)

Return ONLY:
{"shapes":[{"type":"fill|satin","color":"#hex","points":[[x,y],...]},...]}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.03, maxOutputTokens: 8192 }
  };

  const res = await geminiPost(body, 90000, PRO_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);

  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (e) { parsed = JSON.parse(repairJSON(jsonStr)); }

  const shapes = [];
  for (const s of parsed.shapes || []) {
    if (!s.points || !Array.isArray(s.points) || s.points.length < 3) continue;
    const points = s.points.map(p => Array.isArray(p) ? [Math.round(p[0]), Math.round(p[1])] : [Math.round(p.x || 0), Math.round(p.y || 0)]);
    const first = points[0], last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    
    const b = polygonBounds(points);
    if (b.width < 2 || b.height < 2) continue;
    if (points.length < 4) continue;
    
    shapes.push({
      type: s.type === "satin" ? "satin" : "fill",
      color: s.color || analysis.colors[0],
      points,
      pixelCount: Math.round(b.width * b.height)
    });
  }
  
  return shapes;
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
   PIXEL TRACING — works on posterized image
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
    for (let i=start+1; i<end; i++) {
      const d = lineDist(points[i][0], points[i][1], sx, sy, ex, ey);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      keep.add(maxIdx);
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return Array.from(keep).sort((a,b) => a-b).map(i => points[i]);
}

async function extractPixelShapes(buffer, colors, isText = false) {
  const jimpModule = require("jimp");
  const Jimp = jimpModule.Jimp || jimpModule;

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
  console.time(`pixel-${tid}`);
  const data = image.bitmap.data;
  
  for (let y=0; y<ph; y++) {
    const rowOff = y*pw*4;
    const outOff = y*pw;
    for (let x=0; x<pw; x++) {
      const i = rowOff + (x<<2);
      const pixLab = rgbToLab({ r: data[i], g: data[i+1], b: data[i+2] });
      let bestIdx = 0, bestDist = Infinity;
      for (let c=0; c<labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestDist < 45) pixelColors[outOff+x] = bestIdx;
    }
  }

  for (let y=1; y<ph-1; y++) {
    const row = y*pw;
    for (let x=1; x<pw-1; x++) {
      const idx = row+x;
      if (pixelColors[idx] !== -1) continue;
      const c0 = pixelColors[idx-1], c1 = pixelColors[idx+1];
      const c2 = pixelColors[idx-pw], c3 = pixelColors[idx+pw];
      let best = -1, bestCnt = 0;
      if (c0 !== -1) { const n = 1+(c0===c1)+(c0===c2)+(c0===c3); if (n>bestCnt){bestCnt=n;best=c0;} }
      if (c1 !== -1 && c1 !== c0) { const n = 1+(c1===c0)+(c1===c2)+(c1===c3); if (n>bestCnt){bestCnt=n;best=c1;} }
      if (c2 !== -1 && c2 !== c0 && c2 !== c1) { const n = 1+(c2===c0)+(c2===c1)+(c2===c3); if (n>bestCnt){bestCnt=n;best=c2;} }
      if (c3 !== -1 && c3 !== c0 && c3 !== c1 && c3 !== c2) { const n = 1+(c3===c0)+(c3===c1)+(c3===c2); if (n>bestCnt){bestCnt=n;best=c3;} }
      if (bestCnt >= 3) pixelColors[idx] = best;
    }
  }

  const shapes = [];
  const minComponentSize = 10;
  let currentMaskId = 1;

  for (let ci=0; ci<labColors.length; ci++) {
    const visited = new Uint8Array(pw*ph);
    const maskIds = new Uint32Array(pw*ph);

    for (let y=0; y<ph; y++) {
      for (let x=0; x<pw; x++) {
        const idx = y*pw+x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        const q = [idx];
        let qPtr = 0, pixelCount = 0;
        let startX = -1, startY = -1;
        visited[idx] = 1;
        maskIds[idx] = currentMaskId;

        while (qPtr < q.length) {
          const ci2 = q[qPtr++];
          pixelCount++;
          const cx = ci2%pw, cy = (ci2/pw)|0;

          if (startX === -1) {
            if (cx === 0 || pixelColors[ci2-1] !== ci || cx === pw-1 || pixelColors[ci2+1] !== ci ||
                cy === 0 || pixelColors[ci2-pw] !== ci || cy === ph-1 || pixelColors[ci2+pw] !== ci) {
              startX = cx; startY = cy;
            }
          }

          for (let dy=-2; dy<=2; dy++) {
            for (let dx=-2; dx<=2; dx++) {
              if (dy===0 && dx===0) continue;
              const nx = cx+dx, ny = cy+dy;
              if (nx>=0 && nx<pw && ny>=0 && ny<ph) {
                const ni = ny*pw+nx;
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
          for (let i=1; i<=8; i++) {
            const d = (dir+i)&7;
            const nx = cx+n8[d][0], ny = cy+n8[d][1];
            if (inMask(nx, ny)) { cx = nx; cy = ny; dir = (d+5)&7; found = true; break; }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 500000);

        currentMaskId++;
        if (contour.length < 4) continue;

        const simplified = ramerDouglasPeucker(contour, 0.25);
        const stitchScale = 300/Math.max(pw, ph);
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
        const bw = maxX-minX, bh = maxY-minY;
        const isNarrow = (bw<12 || bh<12) && (bw*bh)<13500;

        shapes.push({ type: isNarrow ? "satin" : "fill", color: colors[ci], points, pixelCount });
      }
    }
  }
  console.timeEnd(`pixel-${tid}`);

  shapes.sort((a,b) => b.pixelCount - a.pixelCount);

  const filtered = [];
  for (const s of shapes) {
    const b = polygonBounds(s.points);
    if (b.width < 2 || b.height < 2) continue;
    if (s.pixelCount < 15) continue;
    if (s.points.length < 4) continue;
    
    let contained = false;
    for (const other of shapes) {
      if (other === s || other.color !== s.color) continue;
      const ob = polygonBounds(other.points);
      if (ob.area <= b.area) continue;
      let allInside = true;
      for (const [px, py] of s.points) {
        if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) { allInside = false; break; }
      }
      if (allInside) { contained = true; break; }
    }
    if (!contained) filtered.push(s);
  }

  if (isText && filtered.length > 3) {
    const byColor = {};
    for (const s of filtered) {
      if (!byColor[s.color]) byColor[s.color] = [];
      byColor[s.color].push(s);
    }
    for (const color of Object.keys(byColor)) {
      const list = byColor[color];
      list.sort((a,b) => b.pixelCount - a.pixelCount);
      for (let i=0; i<list.length; i++) {
        if (list[i].pixelCount > 200) {
          list[i].type = "fill";
        } else {
          list[i].type = "satin";
        }
      }
    }
  }

  console.log(`Pixel: ${filtered.filter(s=>s.type==='satin').length} satin, ${filtered.filter(s=>s.type==='fill').length} fill, ${filtered.length} total`);
  return filtered;
}

/* ============================================================
   STITCH GENERATION — professional density 0.4mm
   ============================================================ */
function polygonBounds(points) {
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const [x,y] of points) {
    minX=Math.min(minX,x); maxX=Math.max(maxX,x);
    minY=Math.min(minY,y); maxY=Math.max(maxY,y);
  }
  return { minX, minY, maxX, maxY, width: maxX-minX, height: maxY-minY, area: (maxX-minX)*(maxY-minY) };
}

function polygonCentroid(points) {
  let cx=0, cy=0, a=0;
  for (let i=0, j=points.length-1; i<points.length; j=i++) {
    const [x1,y1]=points[i], [x2,y2]=points[j];
    const cross = x1*y2 - x2*y1;
    cx += (x1+x2)*cross; cy += (y1+y2)*cross; a += cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 0.001) {
    let sx=0, sy=0;
    for (const [x,y] of points) { sx+=x; sy+=y; }
    return [sx/points.length, sy/points.length];
  }
  return [cx/(6*a), cy/(6*a)];
}

function computeFillAngle(points) {
  const n = points.length;
  if (n<3) return 0;
  let cx=0, cy=0;
  for (const [x,y] of points) { cx+=x; cy+=y; }
  cx/=n; cy/=n;
  let mxx=0, myy=0, mxy=0;
  for (const [x,y] of points) {
    const dx=x-cx, dy=y-cy;
    mxx+=dx*dx; myy+=dy*dy; mxy+=dx*dy;
  }
  if (Math.abs(mxy)<0.001) return 0;
  return Math.atan2(2*mxy, mxx-myy)/2;
}

function underlayFillPolygon(points, color) {
  const stitches = [];
  const inset = 1.5;
  const inner = [];
  for (let i=0; i<points.length; i++) {
    const [x1,y1]=points[i], [x2,y2]=points[(i+1)%points.length];
    const dx=x2-x1, dy=y2-y1;
    const len = Math.hypot(dx,dy)||1;
    const nx = -dy/len*inset, ny = dx/len*inset;
    inner.push([x1+nx, y1+ny]);
  }
  const totalLen = inner.reduce((sum,p,i)=>sum+Math.hypot(inner[(i+1)%inner.length][0]-p[0], inner[(i+1)%inner.length][1]-p[1]), 0);
  const steps = Math.max(inner.length, Math.floor(totalLen/6));
  for (let i=0; i<=steps; i++) {
    const t = (i/steps)*inner.length;
    const idx = Math.floor(t)%inner.length;
    const frac = t-Math.floor(t);
    const nextIdx = (idx+1)%inner.length;
    stitches.push({
      x: Math.round(inner[idx][0]+(inner[nextIdx][0]-inner[idx][0])*frac),
      y: Math.round(inner[idx][1]+(inner[nextIdx][1]-inner[idx][1])*frac),
      color, type: "underlay"
    });
  }
  return stitches;
}

function contourFillPolygon(points, color) {
  const stitches = [];
  const fillAngle = computeFillAngle(points);
  const cosA=Math.cos(fillAngle), sinA=Math.sin(fillAngle);
  const rowSpacing = 3.2;
  const stitchSpacing = 3.0;
  function toLocal(x,y){ return [x*cosA+y*sinA, -x*sinA+y*cosA]; }
  function toGlobal(lx,ly){ return [lx*cosA-ly*sinA, lx*sinA+ly*cosA]; }
  const localPts = points.map(([x,y])=>toLocal(x,y));
  const lBounds = polygonBounds(localPts);

  let rowIdx=0;
  for (let ly=lBounds.minY; ly<=lBounds.maxY; ly+=rowSpacing) {
    const ints = [];
    for (let i=0, j=localPts.length-1; i<localPts.length; j=i++) {
      const [x1,y1]=localPts[i], [x2,y2]=localPts[j];
      if ((y1<=ly && y2>ly) || (y2<=ly && y1>ly)) {
        ints.push(x1 + (ly-y1)/(y2-y1)*(x2-x1));
      }
    }
    if (ints.length<2) continue;
    ints.sort((a,b)=>a-b);

    for (let k=0; k+1<ints.length; k+=2) {
      let segStart=ints[k], segEnd=ints[k+1];
      if (segEnd-segStart<2) continue;
      if (rowIdx%2===1) {
        const stagger = Math.min(rowSpacing*0.3, (segEnd-segStart)*0.25);
        segStart+=stagger; segEnd+=stagger;
      }
      const steps = Math.max(1, Math.floor((segEnd-segStart)/stitchSpacing));
      const dir = rowIdx%2===0?1:-1;
      const startX = dir===1?segStart:segEnd, endX = dir===1?segEnd:segStart;
      for (let s=0; s<=steps; s++) {
        const t = s/steps;
        const [gx,gy] = toGlobal(startX + (endX-startX)*t, ly);
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
  for (let i=0; i<points.length; i++) {
    const [x1,y1]=points[i], [x2,y2]=points[(i+1)%points.length];
    const dx=x2-x1, dy=y2-y1;
    const len = Math.hypot(dx,dy)||1;
    const nx=-dy/len*(width/2), ny=dx/len*(width/2);
    inner.push([x1+nx, y1+ny]);
  }
  const totalLen = points.reduce((sum,p,i)=>sum+Math.hypot(points[(i+1)%points.length][0]-p[0], points[(i+1)%points.length][1]-p[1]), 0);
  const steps = Math.max(points.length*2, Math.floor(totalLen/2.5));
  for (let i=0; i<=steps; i++) {
    const t = (i/steps)*points.length;
    const idx = Math.floor(t)%points.length;
    const frac = t-Math.floor(t);
    const nextIdx = (idx+1)%points.length;
    if (i%2===0) {
      stitches.push({ x: Math.round(points[idx][0]+(points[nextIdx][0]-points[idx][0])*frac), y: Math.round(points[idx][1]+(points[nextIdx][1]-points[idx][1])*frac), color, type: "satin" });
    } else {
      stitches.push({ x: Math.round(inner[idx][0]+(inner[nextIdx][0]-inner[idx][0])*frac), y: Math.round(inner[idx][1]+(inner[nextIdx][1]-inner[idx][1])*frac), color, type: "satin" });
    }
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [];
  if (points.length<2) return stitches;
  const segLens=[];
  let cumLen=0;
  for (let i=0; i<points.length; i++) {
    const len = Math.hypot(points[(i+1)%points.length][0]-points[i][0], points[(i+1)%points.length][1]-points[i][1]);
    segLens.push({start:cumLen, len, idx:i});
    cumLen+=len;
  }
  if (cumLen<1) return stitches;
  const steps = Math.max(1, Math.floor(cumLen/3.0));
  for (let s=0; s<=steps; s++) {
    const target = (s/steps)*cumLen;
    let seg = segLens[0];
    for (const c of segLens) {
      if (c.start<=target && target<c.start+c.len){seg=c;break;}
      if (s===steps && target>=c.start) seg=c;
    }
    const frac = seg.len>0?(target-seg.start)/seg.len:0;
    const [x1,y1]=points[seg.idx];
    const [x2,y2]=points[(seg.idx+1)%points.length];
    stitches.push({ x:Math.round(x1+(x2-x1)*frac), y:Math.round(y1+(y2-y1)*frac), color, type:"running" });
  }
  return stitches;
}

function generateStitches(shapes) {
  const all = [];
  const designW=300, designH=300;

  for (const s of shapes) s.centroid = polygonCentroid(s.points);

  const colorGroups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color||"#FF0066");
    if (!colorGroups[c]) colorGroups[c] = [];
    colorGroups[c].push({...s, color: c});
  }

  function nnOrder(group, entryX, entryY) {
    if (group.length<=1) return group;
    let startIdx=0, startDist=Infinity;
    for (let i=0; i<group.length; i++) {
      const d = Math.hypot(group[i].centroid[0]-entryX, group[i].centroid[1]-entryY);
      if (d<startDist){startDist=d; startIdx=i;}
    }
    const ordered=[group[startIdx]];
    const remaining=group.filter((_,i)=>i!==startIdx);
    while (remaining.length) {
      let bestIdx=0, bestDist=Infinity;
      const [lx,ly]=ordered[ordered.length-1].centroid;
      for (let i=0; i<remaining.length; i++) {
        const d=Math.hypot(remaining[i].centroid[0]-lx, remaining[i].centroid[1]-ly);
        if (d<bestDist){bestDist=d; bestIdx=i;}
      }
      ordered.push(remaining.splice(bestIdx,1)[0]);
    }
    return ordered;
  }

  const groupColors = Object.keys(colorGroups);
  const orderedColors = [];
  let entryX=0, entryY=0;
  while (groupColors.length) {
    let bestIdx=0, bestDist=Infinity;
    for (let i=0; i<groupColors.length; i++) {
      for (const s of colorGroups[groupColors[i]]) {
        const d=Math.hypot(s.centroid[0]-entryX, s.centroid[1]-entryY);
        if (d<bestDist){bestDist=d; bestIdx=i;}
      }
    }
    const color = groupColors.splice(bestIdx,1)[0];
    const ordered = nnOrder(colorGroups[color], entryX, entryY);
    colorGroups[color] = ordered;
    orderedColors.push(color);
    const lastShape = ordered[ordered.length-1];
    const lastPt = lastShape.points[lastShape.points.length-1]||lastShape.centroid;
    entryX=lastPt[0]; entryY=lastPt[1];
  }

  let lastX=0, lastY=0;
  const maxJump=25;

  for (const color of orderedColors) {
    for (const s of colorGroups[color]) {
      const points = s.points||[[0,0],[10,0],[10,10],[0,10]];
      const type = s.type||"fill";
      const [sx,sy] = points[0]||[0,0];
      const jump = Math.hypot(sx-lastX, sy-lastY);

      if (jump>maxJump && all.length>0) {
        all.push({ x:Math.round(lastX), y:Math.round(lastY), color, type:"trim" });
        const steps = Math.ceil(jump/maxJump);
        for (let i=1; i<steps; i++) {
          const f=i/steps;
          all.push({ x:Math.round(lastX+(sx-lastX)*f), y:Math.round(lastY+(sy-lastY)*f), color, type:"trim" });
        }
      } else if (jump>10 && all.length>0) {
        all.push({ x:Math.round(sx), y:Math.round(sy), color, type:"trim" });
      }

      if (type==="fill") {
        all.push(...underlayFillPolygon(points, color));
        all.push(...contourFillPolygon(points, color));
      } else {
        all.push(...underlayFillPolygon(points, color).slice(0, Math.floor(points.length*0.4)));
        all.push(...satinColumnPolygon(points, color));
      }

      if (all.length) { const last=all[all.length-1]; lastX=last.x; lastY=last.y; }
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
  let totalLen=0, stitchCount=0, maxJump=0, longJumps=0;
  let prev=null;
  
  for (const s of stitches) {
    if (prev) {
      const d = Math.hypot(s.x-prev.x, s.y-prev.y);
      if (d>maxJump) maxJump=d;
      if (d>10) longJumps++;
      if (s.type!=="trim" && prev.type!=="trim") { totalLen+=d; stitchCount++; }
    }
    prev=s;
  }
  
  const avgLen = stitchCount>0 ? totalLen/stitchCount : 0;
  if (avgLen>4.0) warnings.push(`Stitches too long (avg ${avgLen.toFixed(1)}mm)`);
  if (avgLen<1.5) warnings.push(`Stitches too dense (avg ${avgLen.toFixed(1)}mm)`);
  if (maxJump>30) warnings.push(`Very long jump (${maxJump.toFixed(1)}mm)`);
  if (longJumps>20) warnings.push(`${longJumps} long jumps`);
  if (stitchCount>50000) warnings.push(`High stitch count (${stitchCount})`);
  if (stitchCount<100) warnings.push(`Low stitch count (${stitchCount})`);
  
  return { avgStitchLength: avgLen.toFixed(1), maxJump: maxJump.toFixed(1), longJumpCount: longJumps, stitchCount, density: (avgLen>0?1/avgLen:0).toFixed(2), warnings, passed: warnings.length===0 };
}

/* ============================================================
   FILE ENCODERS
   ============================================================ */
function stitchRecord(dx, dy) {
  const cdx = Math.max(-121, Math.min(121, Math.round(dx)));
  const cdy = Math.max(-121, Math.min(121, Math.round(dy)));
  return Buffer.from([cdy>=0?cdy:0x100+cdy, cdx>=0?cdx:0x100+cdx, 0x03]);
}

function encodeDST(data) {
  const { stitches } = data;
  const header = Buffer.alloc(512, 0x20);
  header.write("StichaiPro", 0, "ascii");
  const records = [];
  let lastColor=null, prevX=0, prevY=0;
  let stitchCount=0, colorChangeCount=0;
  let minX=0, maxX=0, minY=0, maxY=0, absX=0, absY=0;

  for (const s of stitches) {
    absX+=s.x-prevX; absY+=s.y-prevY;
    if (absX<minX) minX=absX; if (absX>maxX) maxX=absX;
    if (absY<minY) minY=absY; if (absY>maxY) maxY=absY;

    if (s.color!==lastColor && lastColor!==null) { records.push(Buffer.from([0x00,0x00,0xC3])); colorChangeCount++; }
    lastColor=s.color;

    if (s.type==="trim") {
      records.push(Buffer.from([0x00,0x00,0xC3]));
      records.push(Buffer.from([0x00,0x00,0xC3]));
      records.push(Buffer.from([0x00,0x00,0xC3]));
      const dx=s.x-prevX, dy=s.y-prevY;
      prevX=s.x; prevY=s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      for (let i=1; i<=steps; i++){ const f=i/steps; records.push(stitchRecord(dx*f, dy*f)); }
      continue;
    }
    const dx=Math.round(s.x-prevX), dy=Math.round(s.y-prevY);
    prevX=s.x; prevY=s.y;
    records.push(stitchRecord(dx, dy));
    stitchCount++;
  }
  records.push(Buffer.from([0x00,0x00,0xF3]));
  stitchCount++;

  header.writeInt32LE(stitchCount, 20);
  header.writeInt32LE(colorChangeCount, 24);
  header.writeInt16LE(Math.round((maxX-minX)*10), 28);
  header.writeInt16LE(Math.round((maxY-minY)*10), 32);
  header.writeInt16LE(Math.round(minX*10), 36);
  header.writeInt16LE(Math.round(maxX*10), 40);
  header.writeInt16LE(Math.round(minY*10), 44);
  header.writeInt16LE(Math.round(maxY*10), 48);
  header.write("(c)StichaiPro", 56, "ascii");
  header.writeInt16LE(colorChangeCount+1, 88);

  return Buffer.concat([header, ...records]);
}

function encodeFile(format, data) {
  const d = encodeDST(data);
  switch ((format||"dst").toLowerCase()) {
    case "dst": return { buf: d, ext: "dst" };
    case "pes": { const h=Buffer.alloc(8); h.write("#PES0001",0,"ascii"); return { buf: Buffer.concat([h,d]), ext: "pes" }; }
    case "jef": { const h=Buffer.alloc(8); h.write("JEF0001\x00",0,"ascii"); return { buf: Buffer.concat([h,d]), ext: "jef" }; }
    case "exp": { const h=Buffer.alloc(8); h.write("EXP0001\x00",0,"ascii"); return { buf: Buffer.concat([h,d]), ext: "exp" }; }
    case "vp3": { const h=Buffer.alloc(8); h.write("VP30001\x00",0,"ascii"); return { buf: Buffer.concat([h,d]), ext: "vp3" }; }
    default: return { buf: d, ext: "dst" };
  }
}

/* ============================================================
   PREVIEW RENDERER
   ============================================================ */
async function renderStitchesToPng(stitches, designW, designH) {
  const scale=2;
  const w=Math.round(designW*scale), h=Math.round(designH*scale);
  const buf = Buffer.alloc(w*h*4);
  for (let i=0; i<w*h*4; i+=4) { buf[i]=245; buf[i+1]=242; buf[i+2]=235; buf[i+3]=255; }

  function setPixel(x, y, r, g, b) {
    const px=Math.round(x), py=Math.round(y);
    if (px<0||px>=w||py<0||py>=h) return;
    const i=(py*w+px)*4;
    buf[i]=r; buf[i+1]=g; buf[i+2]=b; buf[i+3]=255;
  }

  function drawLine(x0, y0, x1, y1, r, g, b, stroke) {
    const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
    const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
    let err=dx-dy, x=x0, y=y0;
    const half=Math.ceil(stroke/2);
    while (true) {
      for (let ox=-half; ox<=half; ox++)
        for (let oy=-half; oy<=half; oy++)
          setPixel(x+ox, y+oy, r, g, b);
      if (Math.abs(x-x1)<0.5 && Math.abs(y-y1)<0.5) break;
      const e2=2*err;
      if (e2>-dy){err-=dy;x+=sx;}
      if (e2<dx){err+=dx;y+=sy;}
    }
  }

  let prev=null;
  for (const s of stitches) {
    if (s.type==="trim"){prev=null; continue;}
    if (prev && prev.color===s.color && prev.type!=="trim") {
      const dist=Math.hypot(s.x-prev.x, s.y-prev.y);
      if (dist<15) {
        const m=s.color.match(/^#([0-9a-fA-F]{6})$/);
        const [cr,cg,cb]=m?[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)]:[0,0,0];
        const sw=s.type==='satin'?2.0:(s.type==='underlay'?0.5:1.0);
        drawLine(prev.x*scale, prev.y*scale, s.x*scale, s.y*scale, cr, cg, cb, sw);
      }
    }
    prev=s;
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
    
    // === STAGE 1: POSTERIZATION ===
    console.time(`posterize-${reqId}`);
    const posterized = await posterizeImage(req.file.buffer, 8);
    console.timeEnd(`posterize-${reqId}`);
    console.log(`Posterized: ${posterized.colors.join(", ")}`);
    
    const analysisB64 = posterized.buffer.toString("base64");
    
    // === STAGE 2: TWO-PROMPT GEMINI PIPELINE ===
    
    // Prompt 1: Color Analysis
    console.time(`analyze-${reqId}`);
    let analysis;
    try {
      analysis = await analyzeImagePro(analysisB64, "image/png");
      console.log(`Gemini: ${analysis.colors.length} colors, ${analysis.elements.length} elements`);
      console.log(`  Colors: ${analysis.colors.join(", ")}`);
      console.log(`  Elements: ${analysis.elements.join(", ")}`);
    } catch (e) {
      console.log(`Analysis failed: ${e.message}, using posterize`);
      analysis = {
        background: "#FFFFFF",
        colors: posterized.colors,
        elements: [],
        is_text: true,
        is_logo: true,
      };
    }
    console.timeEnd(`analyze-${reqId}`);
    
    // Force black for text
    if (analysis.is_text && !analysis.colors.some(c => {
      const rgb = hexToRgb(c);
      return (rgb.r + rgb.g + rgb.b) < 120;
    })) {
      analysis.colors.push("#000000");
    }
    
    // Prompt 2: Shape Extraction — try Gemini first, fallback to pixel
    console.time(`extract-${reqId}`);
    let shapes = [];
    let method = "pixel";
    
    try {
      shapes = await extractShapesFromAnalysis(analysisB64, "image/png", analysis);
      if (shapes.length >= 3) {
        method = "gemini";
        console.log(`Gemini extracted: ${shapes.length} shapes`);
      }
    } catch (e) {
      console.log(`Gemini extraction failed: ${e.message}`);
    }
    
    if (shapes.length < 3) {
      shapes = await extractPixelShapes(posterized.buffer, analysis.colors, analysis.is_text);
      console.log(`Pixel extracted: ${shapes.length} shapes`);
    }
    console.timeEnd(`extract-${reqId}`);
    
    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });
    
    const result = generateStitches(shapes);
    const id = Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    jobs.set(id, result);
    
    const validation = validateQuality(result.stitches);
    console.log(`AUDIT: ${result.stitches.length} stitches, ${shapes.length} shapes, method: ${method}`);
    for (const w of validation.warnings) console.log(`  ⚠ ${w}`);
    
    return res.json({
      success: true, id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors: analysis.colors,
      extraction: { method },
      audit: validation,
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, pointCount: s.points.length }))
    });
  } catch (e) {
    console.error(`Error [${reqId}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/preview/:id", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: data.stitches, designW: data.designW, designH: data.designH });
});

app.get("/preview-image/:id", async (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  
  const cached = previewCache.get(req.params.id);
  if (cached && Date.now()-cached.ts < 60000) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(cached.buf);
  }
  
  try {
    const png = await Promise.race([
      renderStitchesToPng(data.stitches, data.designW, data.designH),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Preview timeout")), 8000))
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
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  const { buf, ext } = encodeFile(req.params.format||"dst", data);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health", (_req, res) => res.json({ status: "ok", version: "19.0" }));

const PORT = process.env.PORT||3000;
const server = app.listen(PORT, () => console.log(`Stichai Pro v19.0 running on port ${PORT}`));
server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
