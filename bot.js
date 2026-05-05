const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3-flash-preview";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const jobs = new Map();

/* ========================
   POINT IN POLYGON (ray casting)
   ======================== */
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/* ========================
   GEMINI ANALYSIS — polygon shapes
   ======================== */
async function analyzeImage(b64, mime) {
  const prompt = `You are an expert embroidery digitizer. Analyze this photo and extract the flat design as geometric polygons.

CRITICAL: Return ONLY valid compact JSON. No markdown, no spaces, no extra text.

Format: {"shapes":[{"type":"fill","color":"#RRGGBB","points":[[x,y],[x,y],[x,y]]}],"width":300,"height":300}

Rules:
- 8 to 15 shapes max
- "points" is array of [x,y] coordinates forming a closed polygon
- type: fill=solid area, satin=narrow border, running=thin outline
- Only use colors actually visible in the design
- Background must be a shape too
- Canvas 300x300. Keep coordinates within 0-300.
- Every shape must have at least 3 points
- Return ONLY the JSON. Nothing else.`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mime, data: b64 } }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
  };

  const res = await axios.post(API_URL, body, { timeout: 60000 });
  const candidate = res.data?.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidate");

  const text = candidate.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini returned empty text");

  // Extract JSON
  let jsonStr = text.replace(/```json|```/g, "").trim();
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  let analysis;
  try {
    analysis = JSON.parse(jsonStr);
  } catch (parseErr) {
    const repaired = repairJSON(jsonStr);
    analysis = JSON.parse(repaired);
  }

  if (!analysis.shapes || !Array.isArray(analysis.shapes)) {
    throw new Error("Missing shapes array");
  }

  // Normalize points to arrays
  for (const s of analysis.shapes) {
    if (!s.points || !Array.isArray(s.points)) {
      s.points = [[0,0], [10,0], [10,10], [0,10]];
    }
    s.points = s.points.map(p => Array.isArray(p) ? p : [p.x || 0, p.y || 0]);
  }

  return analysis;
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
  // If mid-array element, close it
  const trimmed = repaired.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === ',') {
    // Mid-array or mid-object, close the last element
    repaired += '"x":0}';
  } else if (lastChar !== '}' && lastChar !== ']') {
    // Mid-value, close current key-value then close object
    repaired += '0}';
  }
  for (let i = 0; i < openBraces; i++) repaired += '}';
  for (let i = 0; i < openBrackets; i++) repaired += ']';
  return repaired;
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
  const spacing = 6;
  const len = Math.max(bounds.width, bounds.height) * 1.5;
  const baseX = bounds.minX, baseY = bounds.minY;

  for (let i = -len; i < len; i += spacing) {
    const sx = baseX + i;
    const sy = baseY - i;
    const ex = sx + len * 0.7;
    const ey = sy + len * 0.7;

    // Test center of segment
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    if (pointInPolygon(mx, my, points)) {
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

  let inset = 0;
  let pass = 0;
  const maxPasses = 8;

  while (inset < Math.min(bounds.width, bounds.height) / 2 && pass < maxPasses) {
    const yStart = bounds.minY + inset;
    const yEnd = bounds.maxY - inset;
    const xStart = bounds.minX + inset;
    const xEnd = bounds.maxX - inset;

    for (let y = yStart; y < yEnd; y += rowSpacing) {
      const ry = y + (pass % 2) * (rowSpacing * 0.5);
      if (ry > yEnd) break;

      // Find intersections of this horizontal line with polygon edges
      const intersections = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((y1 <= ry && y2 > ry) || (y2 <= ry && y1 > ry)) {
          const t = (ry - y1) / (y2 - y1);
          const ix = x1 + t * (x2 - x1);
          intersections.push(ix);
        }
      }
      intersections.sort((a, b) => a - b);

      // Draw segments between pairs of intersections
      for (let k = 0; k + 1 < intersections.length; k += 2) {
        const segStart = Math.max(intersections[k], xStart);
        const segEnd = Math.min(intersections[k + 1], xEnd);
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
      // Find y range inside polygon at this x
      const yIntersections = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((x1 <= x && x2 > x) || (x2 <= x && x1 > x)) {
          const t = (x - x1) / (x2 - x1);
          yIntersections.push(y1 + t * (y2 - y1));
        }
      }
      if (yIntersections.length >= 2) {
        yIntersections.sort((a, b) => a - b);
        const top = yIntersections[0];
        const bot = yIntersections[yIntersections.length - 1];
        stitches.push({ x: Math.round(x), y: Math.round(top), color, type: "satin" });
        stitches.push({ x: Math.round(x), y: Math.round(bot), color, type: "satin" });
      }
    }
  } else {
    for (let y = bounds.minY; y <= bounds.maxY; y += step) {
      const xIntersections = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          const t = (y - y1) / (y2 - y1);
          xIntersections.push(x1 + t * (x2 - x1));
        }
      }
      if (xIntersections.length >= 2) {
        xIntersections.sort((a, b) => a - b);
        const left = xIntersections[0];
        const right = xIntersections[xIntersections.length - 1];
        stitches.push({ x: Math.round(left), y: Math.round(y), color, type: "satin" });
        stitches.push({ x: Math.round(right), y: Math.round(y), color, type: "satin" });
      }
    }
  }
  return stitches;
}

function runningPolygon(points, color) {
  const stitches = [];
  const dash = 2.5;
  const perimeter = points.length * 10; // rough estimate
  const steps = Math.max(points.length * 2, Math.floor(perimeter / dash));

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

function generateStitches(analysis) {
  let all = [];
  const shapes = analysis.shapes || [];
  const designW = analysis.width || 300;
  const designH = analysis.height || 300;

  for (const s of shapes) {
    const points = s.points || [[0,0],[10,0],[10,10],[0,10]];
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

  // Global basting box
  all = all.concat(runningPolygon([[-2,-2],[designW+2,-2],[designW+2,designH+2],[-2,designH+2]], "#333333"));
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
  let lastColor = null;
  let prevX = 0, prevY = 0;

  for (const s of stitches) {
    if (s.color !== lastColor && lastColor !== null) {
      stitchRecords.push(Buffer.from([0x00, 0x00, 0xC3]));
    }
    lastColor = s.color;

    const dx = Math.round(s.x - prevX);
    const dy = Math.round(s.y - prevY);
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

    const analysis = await analyzeImage(b64, mime);
    const result = generateStitches(analysis);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(id, result);

    return res.json({
      success: true,
      id,
      previewUrl: `/preview/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      shapes: result.shapes.map(s => ({
        type: s.type,
        color: s.color,
        points: s.points
      }))
    });
  } catch (e) {
    console.error("/generate-embroidery error:", e.message);
    return res.status(500).json({ error: "Analysis failed: " + e.message });
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
