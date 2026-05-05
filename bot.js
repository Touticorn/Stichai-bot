const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const app = express();

let Jimp;
try { ({ Jimp } = require("jimp")); } catch { Jimp = require("jimp"); }

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3-flash-preview";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const jobs = new Map();

/* ========================
   STEP 1: COLOR DETECTION (Gemini)
   Ask only for the color palette
   ======================== */
async function detectColors(b64, mime) {
  const prompt = `Look at this photo of a design. List the 3-8 main solid colors used in the actual design (ignore shadows, reflections, lighting).

Return ONLY compact JSON: {"colors":["#RRGGBB","#RRGGBB"]}

No other text. No markdown.`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mime, data: b64 } }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  const res = await axios.post(API_URL, body, { timeout: 45000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonStr = text.replace(/```json|```/g, "").trim();
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  const clean = (firstBrace !== -1 && lastBrace > firstBrace) ? jsonStr.slice(firstBrace, lastBrace + 1) : jsonStr;
  const parsed = JSON.parse(clean);
  return parsed.colors || ["#FF0000", "#FFFFFF", "#0000FF"];
}

/* ========================
   STEP 2: PIXEL-LEVEL SHAPE EXTRACTION (Jimp)
   Trace real pixels to create polygon shapes
   ======================== */
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16)
  };
}

function colorDistance(c1, c2) {
  const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
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
    const [sx, sy] = points[start];
    const [ex, ey] = points[end];
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

async function extractShapesFromImage(buffer, colors) {
  const image = await Jimp.read(buffer);
  const origW = image.getWidth(), origH = image.getHeight();
  const procSize = 250;
  const scale = Math.min(procSize / origW, procSize / origH);
  const pw = Math.max(1, Math.round(origW * scale));
  const ph = Math.max(1, Math.round(origH * scale));
  image.resize(pw, ph);

  const rgbColors = colors.map(hexToRgb);
  const pixelColors = new Int16Array(pw * ph);
  // -1 = unassigned, 0..N-1 = color index
  for (let i = 0; i < pw * ph; i++) pixelColors[i] = -1;

  // Assign each pixel to nearest palette color
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const rgba = Jimp.intToRGBA(image.getPixelColor(x, y));
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < rgbColors.length; c++) {
        const d = colorDistance(rgba, rgbColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestDist < 80) pixelColors[y * pw + x] = bestIdx;
    }
  }

  const visited = new Uint8Array(pw * ph);
  const shapes = [];

  for (let ci = 0; ci < rgbColors.length; ci++) {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = y * pw + x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        // BFS connected component
        const component = [];
        const queue = [idx];
        visited[idx] = 1;
        while (queue.length) {
          const ci2 = queue.shift();
          component.push(ci2);
          const cx = ci2 % pw, cy = Math.floor(ci2 / pw);
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
              const ni = ny * pw + nx;
              if (pixelColors[ni] === ci && !visited[ni]) {
                visited[ni] = 1;
                queue.push(ni);
              }
            }
          }
        }

        if (component.length < 15) continue; // Skip noise specks

        // Build mask for this component
        const mask = new Uint8Array(pw * ph);
        for (const i of component) mask[i] = 1;

        // Find top-left boundary pixel for Moore tracing
        let startX = -1, startY = -1;
        outer: for (let by = 0; by < ph; by++) {
          for (let bx = 0; bx < pw; bx++) {
            const bidx = by * pw + bx;
            if (!mask[bidx]) continue;
            const isBoundary = (
              bx === 0 || !mask[bidx - 1] ||
              bx === pw - 1 || !mask[bidx + 1] ||
              by === 0 || !mask[bidx - pw] ||
              by === ph - 1 || !mask[bidx + pw]
            );
            if (isBoundary) { startX = bx; startY = by; break outer; }
          }
        }
        if (startX === -1) continue;

        // Moore-neighbor contour tracing
        const contour = [];
        const neighbors = [[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1]];
        let cx = startX, cy = startY, dir = 7;
        let safety = 0;
        do {
          contour.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (dir + i) % 8;
            const nx = cx + neighbors[d][0], ny = cy + neighbors[d][1];
            if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
              if (mask[ny * pw + nx]) {
                cx = nx; cy = ny;
                dir = (d + 5) % 8;
                found = true;
                break;
              }
            }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 5000);

        if (contour.length < 4) continue;

        // Simplify contour
        const simplified = ramerDouglasPeucker(contour, 1.5);

        // Scale to stitch space (300x300)
        const stitchScale = 300 / Math.max(pw, ph);
        const points = simplified.map(([px, py]) => [
          Math.round(px * stitchScale),
          Math.round(py * stitchScale)
        ]);

        // Ensure closed polygon
        if (points.length >= 3) {
          const first = points[0], last = points[points.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            points.push([...first]);
          }
        }

        shapes.push({
          type: component.length > pw * ph * 0.3 ? "fill" : "fill",
          color: colors[ci],
          points: points
        });
      }
    }
  }

  return shapes;
}

/* ========================
   FALLBACK: Gemini shape extraction if Jimp fails
   ======================== */
async function extractShapesWithGemini(b64, mime) {
  const prompt = `Extract flat-color shapes from this design. Return ONLY compact JSON: {"shapes":[{"type":"fill","color":"#RRGGBB","points":[[x,y],[x,y],[x,y]]}],"width":300,"height":300}. 8-15 shapes max. No other text.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
  };

  const res = await axios.post(API_URL, body, { timeout: 60000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const fb = jsonStr.indexOf("{"), lb = jsonStr.lastIndexOf("}");
  if (fb !== -1 && lb > fb) jsonStr = jsonStr.slice(fb, lb + 1);

  let analysis;
  try { analysis = JSON.parse(jsonStr); }
  catch (e) {
    const repaired = repairJSON(jsonStr);
    analysis = JSON.parse(repaired);
  }

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
  const trimmed = repaired.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === ',') repaired += '"x":0}';
  else if (lastChar !== '}' && lastChar !== ']') repaired += '0}';
  for (let i = 0; i < openBraces; i++) repaired += '}';
  for (let i = 0; i < openBrackets; i++) repaired += ']';
  return repaired;
}

/* ========================
   POINT IN POLYGON
   ======================== */
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/* ========================
   STITCH GENERATION — polygon-based
   ======================== */
function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

function underlayPolygon(points, color) {
  const stitches = [];
  const bounds = polygonBounds(points);
  const spacing = 5;
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
  const stitches = [];
  const bounds = polygonBounds(points);
  const stitchLen = 2.5;
  const rowSpacing = 3.0;

  let inset = 0, pass = 0;
  const maxPasses = 8;
  while (inset < Math.min(bounds.width, bounds.height) / 2 && pass < maxPasses) {
    const yStart = bounds.minY + inset;
    const yEnd = bounds.maxY - inset;

    for (let y = yStart; y < yEnd; y += rowSpacing) {
      const ry = y + (pass % 2) * (rowSpacing * 0.5);
      if (ry > yEnd) break;

      // Find x-intersections with polygon edges
      const intersections = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((y1 <= ry && y2 > ry) || (y2 <= ry && y1 > ry)) {
          const t = (ry - y1) / (y2 - y1);
          intersections.push(x1 + t * (x2 - x1));
        }
      }
      intersections.sort((a, b) => a - b);

      for (let k = 0; k + 1 < intersections.length; k += 2) {
        const segStart = intersections[k];
        const segEnd = intersections[k + 1];
        if (segEnd <= segStart) continue;
        const steps = Math.max(1, Math.floor((segEnd - segStart) / stitchLen));
        const dir = (Math.floor(y / rowSpacing) % 2 === 0) ? 1 : -1;
        const startX = dir === 1 ? segStart : segEnd;
        const endX = dir === 1 ? segEnd : segStart;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const ix = startX + (endX - startX) * t;
          stitches.push({ x: Math.round(ix), y: Math.round(ry), color, type: "fill" });
        }
      }
    }
    inset += rowSpacing * 1.5;
    pass++;
  }
  return stitches;
}

function satinPolygon(points, color) {
  const stitches = [];
  const bounds = polygonBounds(points);
  const step = 1.5;
  const isHorizontal = bounds.width >= bounds.height;

  if (isHorizontal) {
    for (let x = bounds.minX; x <= bounds.maxX; x += step) {
      const yInts = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((x1 <= x && x2 > x) || (x2 <= x && x1 > x)) {
          const t = (x - x1) / (x2 - x1);
          yInts.push(y1 + t * (y2 - y1));
        }
      }
      if (yInts.length >= 2) {
        yInts.sort((a, b) => a - b);
        stitches.push({ x: Math.round(x), y: Math.round(yInts[0]), color, type: "satin" });
        stitches.push({ x: Math.round(x), y: Math.round(yInts[yInts.length - 1]), color, type: "satin" });
      }
    }
  } else {
    for (let y = bounds.minY; y <= bounds.maxY; y += step) {
      const xInts = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          const t = (y - y1) / (y2 - y1);
          xInts.push(x1 + t * (x2 - x1));
        }
      }
      if (xInts.length >= 2) {
        xInts.sort((a, b) => a - b);
        stitches.push({ x: Math.round(xInts[0]), y: Math.round(y), color, type: "satin" });
        stitches.push({ x: Math.round(xInts[xInts.length - 1]), y: Math.round(y), color, type: "satin" });
      }
    }
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [];
  const dash = 2.5;
  const totalLen = points.length * 8;
  const steps = Math.max(points.length * 2, Math.floor(totalLen / dash));

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * points.length;
    const idx = Math.floor(t) % points.length;
    const nextIdx = (idx + 1) % points.length;
    const frac = t - Math.floor(t);
    const x = points[idx][0] + (points[nextIdx][0] - points[idx][0]) * frac;
    const y = points[idx][1] + (points[nextIdx][1] - points[idx][1]) * frac;
    stitches.push({ x: Math.round(x), y: Math.round(y), color, type: "running" });
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
      all = all.concat(satinPolygon(points, color));
      all = all.concat(runningPolygon(points, color));
    } else if (type === "running") {
      all = all.concat(runningPolygon(points, color));
    }
  }

  all = all.concat(runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
  return { stitches: all, designW, designH, shapes };
}

/* ========================
   FILE ENCODERS
   ======================== */
function encodeDST(data) {
  const { stitches, designW, designH } = data;
  const header = Buffer.alloc(512);
  const label = "STICHAI";
  for (let i = 0; i < label.length; i++) header[i] = label.charCodeAt(i);

  const stitchRecords = [];
  let lastColor = null, prevX = 0, prevY = 0;
  for (const s of stitches) {
    if (s.color !== lastColor && lastColor !== null) stitchRecords.push(Buffer.from([0x00, 0x00, 0xC3]));
    lastColor = s.color;
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX = s.x; prevY = s.y;
    const clamp = (v) => Math.max(-121, Math.min(121, v));
    const cdx = clamp(dx), cdy = clamp(dy);
    const b1 = cdy >= 0 ? cdy : 0x100 + cdy;
    const b2 = cdx >= 0 ? cdx : 0x100 + cdx;
    stitchRecords.push(Buffer.from([b1, b2, 0x03]));
  }
  stitchRecords.push(Buffer.from([0x00, 0x00, 0xF3]));
  return Buffer.concat([header, ...stitchRecords]);
}

function encodePES(data) { const dst = encodeDST(data); const h = Buffer.alloc(8); h.write("#PES0001", 0, "ascii"); return Buffer.concat([h, dst]); }
function encodeJEF(data) { const dst = encodeDST(data); const h = Buffer.alloc(8); h.write("JEF0001\x00", 0, "ascii"); return Buffer.concat([h, dst]); }
function encodeEXP(data) { const dst = encodeDST(data); const h = Buffer.alloc(8); h.write("EXP0001\x00", 0, "ascii"); return Buffer.concat([h, dst]); }
function encodeVP3(data) { const dst = encodeDST(data); const h = Buffer.alloc(8); h.write("VP30001\x00", 0, "ascii"); return Buffer.concat([h, dst]); }

function encodeFile(format, data) {
  switch (format.toLowerCase()) {
    case "dst": return { buf: encodeDST(data), ext: "dst" };
    case "pes": return { buf: encodePES(data), ext: "pes" };
    case "jef": return { buf: encodeJEF(data), ext: "jef" };
    case "exp": return { buf: encodeEXP(data), ext: "exp" };
    case "vp3": return { buf: encodeVP3(data), ext: "vp3" };
    default: return { buf: encodeDST(data), ext: "dst" };
  }
}

/* ========================
   EXPRESS ROUTES
   ======================== */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-embroidery", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype;

    // Step 1: Detect colors with Gemini (cheap, reliable)
    const colors = await detectColors(b64, mime);
    console.log("Detected colors:", colors);

    // Step 2: Extract polygon shapes from actual pixels
    let shapes;
    try {
      shapes = await extractShapesFromImage(req.file.buffer, colors);
      console.log("Pixel-extracted shapes:", shapes.length);
    } catch (pixelErr) {
      console.error("Pixel extraction failed, falling back to Gemini:", pixelErr.message);
      shapes = await extractShapesWithGemini(b64, mime);
    }

    if (!shapes.length) {
      return res.status(500).json({ error: "No shapes could be extracted from the image" });
    }

    // Step 3: Generate stitches
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
      colors: colors,
      shapes: result.shapes.map(s => ({
        type: s.type,
        color: s.color,
        points: s.points
      }))
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

app.get("/download/:id/:format", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  const fmt = req.params.format || "dst";
  const { buf, ext } = encodeFile(fmt, data);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stichai running on port ${PORT}`));
