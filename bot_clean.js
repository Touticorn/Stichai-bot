const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI: {
    lite:  "gemini-2.5-flash-lite-preview-06-17",
    flash: "gemini-2.5-flash",
    pro:   "gemini-2.5-pro",
  },
  BASE_URL: process.env.BASE_URL || "https://stichai-bot-production.up.railway.app",
};

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

const jobCache = new Map();
const fileStore = new Map();

// ========================================================================
// GEMINI ANALYSIS — Polygon shapes from photo
// ========================================================================
async function analyzeImage(b64, mime) {
  try {
    const prompt = `You are an expert embroidery digitizer. Analyze the image and output ONLY valid JSON.

YOUR JOB: Convert this image into simplified embroidery shapes. You must describe EXACT shapes, not just bounding boxes.

CRITICAL RULES:
1. Output ONLY a JSON object. No markdown, no code blocks, no explanations.
2. Every shape must be a polygon — give actual corner coordinates (0-100 scale).
3. TEXT must be converted to polygon shapes (letter outlines as filled shapes).
4. LOGOS and ICONS must be traced as polygons.
5. Gradients/shadows/photo effects: IGNORE. Use flat dominant colors only.
6. Background: only include if it's a distinct design element (solid color blocks).
7. Density: small text = running stitch, medium areas = satin, large areas = fill.
8. Thread angle: specify stitch direction per shape (0=horizontal, 90=vertical, 45=diagonal).

JSON Structure:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB", "#RRGGBB", "#RRGGBB"],
  "suggested_stitch_type": "satin|fill|running|mixed",
  "estimated_stitch_count": number,
  "width_mm": number (50-200),
  "height_mm": number (50-200),
  "has_text": boolean,
  "has_logo": boolean,
  "description": "brief",
  "simplified_shapes": [
    {
      "type": "polygon",
      "label": "what this is (e.g. 'red body', 'gold stripe', 'letter W')",
      "points": [[x1,y1], [x2,y2], [x3,y3], ...],
      "color": "#RRGGBB",
      "stitch_type": "fill|satin|running",
      "thread_angle": number (0-180),
      "density": "dense|normal|sparse"
    }
  ]
}

POLYGON TRACING RULES:
- Rectangles: 4 points
- Triangles: 3 points  
- Circles/ovals: 8-12 points around perimeter
- Text letters: trace the OUTER EDGE as polygon points
- Stripes/chevrons: trace exact points of the zigzag
- Complex logos: break into 2-5 polygon parts

Scale: Use 0-100 for both x and y (percentage of design width/height).`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[ { inlineData:{mimeType:mime,data:b64} }, { text: prompt } ] }] },
      { timeout: 80000 }
    );

    const c = r.data?.candidates?.[0];
    const p = c?.content?.parts?.[0];
    const text = p?.text || "{}";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    return result;
  } catch(e) {
    console.error("Gemini error:", e.message);
    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", simplified_shapes:[] };
  }
}

// ========================================================================
// STITCH ENGINE
// ========================================================================
function generateStitches(analysis) {
  const shapes = analysis.simplified_shapes || [];
  const colors = analysis.dominant_colors || ["#c41e3a"];
  const width = (analysis.width_mm || 80) * 3;
  const height = (analysis.height_mm || 80) * 3;
  const allStitches = [];

  if (shapes.length === 0) {
    const rows = Math.min(Math.floor((analysis.estimated_stitch_count || 5000) / width), 200);
    for (let r = 0; r < rows; r++) {
      const color = colors[r % colors.length];
      const y = (r / rows) * height;
      allStitches.push({ x: 0, y, color, type: "jump" });
      for (let x = 0; x < width; x += 3) allStitches.push({ x, y: y + Math.sin(x * 0.1) * 2, color, type: "stitch" });
    }
    return { stitches: allStitches, width, height, colors, scale: 3 };
  }

  for (const shape of shapes) {
    const color = shape.color || colors[0];
    const type = shape.stitch_type || "fill";
    const angle = shape.thread_angle || 0;
    const density = shape.density === "dense" ? 1.5 : shape.density === "sparse" ? 3 : 2;
    const points = shape.points || [];
    if (points.length < 2) continue;

    const scaled = points.map(p => ({ x: (p[0] / 100) * width, y: (p[1] / 100) * height }));
    if (type === "fill") allStitches.push(...polygonFill(scaled, color, angle, density));
    else if (type === "satin") allStitches.push(...polygonSatin(scaled, color, angle, density));
    else if (type === "running") allStitches.push(...polygonRunning(scaled, color));
  }

  return { stitches: allStitches, width, height, colors, scale: 3 };
}

function polygonFill(points, color, angle, spacing) {
  const stitches = [];
  if (points.length < 3) return stitches;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const step = spacing || 2;
  const rowCount = Math.floor((maxY - minY) / step);
  const rad = (angle * Math.PI) / 180;

  for (let r = 0; r < rowCount; r++) {
    const rowY = minY + r * step;
    const intersections = [];
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i], p2 = points[(i + 1) % points.length];
      if ((p1.y <= rowY && p2.y > rowY) || (p1.y > rowY && p2.y <= rowY)) {
        const t = (rowY - p1.y) / (p2.y - p1.y);
        intersections.push(p1.x + t * (p2.x - p1.x));
      }
    }
    intersections.sort((a,b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const startX = intersections[i], endX = intersections[i+1];
      if (endX - startX < 1) continue;
      stitches.push({ x: startX, y: rowY, color, type: "jump" });
      const offset = angle !== 0 ? (rowY - minY) * Math.tan(rad) : 0;
      for (let x = startX; x <= endX; x += step) stitches.push({ x: x + offset, y: rowY, color, type: "stitch" });
    }
  }
  return stitches;
}

function polygonSatin(points, color, angle, density) {
  const stitches = [];
  if (points.length < 3) return stitches;
  const step = density || 1.5;
  const perim = getPerimeter(points);
  const count = Math.floor(perim / step);
  for (let i = 0; i < count; i++) {
    const t1 = i / count, t2 = ((i + 0.5) / count);
    const p1 = getPointOnPolygon(points, t1), p2 = getPointOnPolygon(points, t2);
    if (i === 0) stitches.push({ x: p1.x, y: p1.y, color, type: "jump" });
    stitches.push({ x: p1.x, y: p1.y, color, type: "stitch" });
    stitches.push({ x: p2.x, y: p2.y, color, type: "stitch" });
  }
  return stitches;
}

function polygonRunning(points, color) {
  const stitches = [];
  if (points.length < 2) return stitches;
  const dist = getPerimeter(points);
  const count = Math.max(Math.floor(dist / 2), points.length * 3);
  for (let i = 0; i < count; i++) {
    const p = getPointOnPolygon(points, i / count);
    stitches.push({ x: p.x, y: p.y, color, type: i === 0 ? "jump" : "stitch" });
  }
  return stitches;
}

function getPointOnPolygon(points, t) {
  const total = getPerimeter(points);
  const target = t * total;
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i], p2 = points[(i+1)%points.length];
    const seg = Math.hypot(p2.x-p1.x, p2.y-p1.y);
    if (dist + seg >= target) {
      const st = (target - dist) / seg;
      return { x: p1.x + (p2.x-p1.x)*st, y: p1.y + (p2.y-p1.y)*st };
    }
    dist += seg;
  }
  return points[points.length-1];
}

function getPerimeter(points) {
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i], p2 = points[(i+1)%points.length];
    d += Math.hypot(p2.x-p1.x, p2.y-p1.y);
  }
  return d;
}

// ========================================================================
// DST ENCODER
// ========================================================================
function encodeDST(stitchData) {
  const stitches = stitchData.stitches || [];
  const colors = stitchData.colors || ["#c41e3a"];
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }

  const h = (label, len) => Buffer.from(label.padEnd(len, " "), "ascii");
  let header = Buffer.concat([
    h("LA:Stichai", 20), h("ST:"+stitches.length, 10), h("CO:"+colors.length, 10),
    h("+X:"+Math.abs(maxX), 10), h("-X:"+Math.abs(minX), 10),
    h("+Y:"+Math.abs(maxY), 10), h("-Y:"+Math.abs(minY), 10),
    h("AX:+", 10), h("AY:+", 10), h("MX:", 10), h("MY:", 10), h("PD:******", 10),
    Buffer.alloc(512-120)
  ]);

  const records = [];
  let prevX = 0, prevY = 0, currentColorIdx = 0;
  for (const s of stitches) {
    const colorIdx = colors.indexOf(s.color);
    if (colorIdx !== -1 && colorIdx !== currentColorIdx) { currentColorIdx = colorIdx; records.push(Buffer.from([0x00,0x00,0xC3])); }
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX += dx; prevY += dy;
    const clamp = v => Math.max(-121, Math.min(121, v));
    const yByte = clamp(dy) >= 0 ? clamp(dy) : 256+clamp(dy);
    const xByte = clamp(dx) >= 0 ? clamp(dx) : 256+clamp(dx);
    const flags = s.type === "jump" ? 0x83 : 0x03;
    records.push(Buffer.from([yByte, xByte, flags]));
  }
  records.push(Buffer.from([0x00,0x00,0xF3]));
  return Buffer.concat([header, ...records]);
}

function encodeFile(stitchData, format) {
  const fm = { dst:"dst", pes:"pes", jef:"jef", exp:"exp", vp3:"vp3" };
  return { data: encodeDST(stitchData), ext: fm[format] || "dst" };
}

function storeFile(jobId, buffer, ext) {
  const fn = `embroidery_${Date.now()}.${ext}`;
  fileStore.set(jobId, { buffer, ext, filename: fn, created: Date.now() });
  setTimeout(() => fileStore.delete(jobId), 3600000);
  return fn;
}

// ========================================================================
// API ROUTES
// ========================================================================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const analysis = await analyzeImage(b64, req.file.mimetype || "image/jpeg");
    const stitchData = generateStitches(analysis);
    res.json({ ...analysis, stitch_data: stitchData, preview_image: null });
  } catch(e) { console.error("Analyze error:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";
    const jobId = "job_" + Date.now().toString(36);
    jobCache.set(jobId, { status: "processing", progress: 10 });

    const analysis = await analyzeImage(b64, mime);
    jobCache.set(jobId, { status: "processing", progress: 50, analysis });

    const stitchData = generateStitches(analysis);
    const encoded = encodeFile(stitchData, format);
    storeFile(jobId, encoded.data, encoded.ext);

    const result = {
      stitch_count: stitchData.stitches.length,
      estimated_stitch_count: stitchData.stitches.length,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ["#c41e3a"],
      suggested_stitch_type: analysis.suggested_stitch_type || "fill",
      width_mm: analysis.width_mm, height_mm: analysis.height_mm,
      description: analysis.description || "",
      stitch_data: stitchData,
      dst_url: format === "dst" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      pes_url: format === "pes" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      jef_url: format === "jef" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      exp_url: format === "exp" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      vp3_url: format === "vp3" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
    };

    jobCache.set(jobId, { status: "completed", progress: 100, result });
    res.json({ jobId, status: "completed", result });
  } catch(e) { console.error("Convert error:", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/api/status/:jobId", (req, res) => {
  const cached = jobCache.get(req.params.jobId);
  if (cached) return res.json({ status: cached.status, progress: cached.progress, result: cached.result });
  res.status(404).json({ error: "Job not found" });
});

app.get("/api/download/:jobId", (req, res) => {
  const file = fileStore.get(req.params.jobId);
  if (!file) return res.status(404).json({ error: "File expired" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
});

app.get("/api/test", async (req, res) => {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: "hi" }] }] }, { timeout: 10000 }
    );
    res.json({ ok: true, text: r.data?.candidates?.[0]?.content?.parts?.[0]?.text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.2" }));

// ========================================================================
// START
// ========================================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stichai v6.2 on port ${PORT}`);
  console.log(`URL: ${CONFIG.BASE_URL}`);
});
