const express = require("express");
const axios = require("axios");
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

function storeFile(jobId, buffer, ext) {
  const fn = `embroidery_${Date.now()}.${ext}`;
  fileStore.set(jobId, { buffer, ext, filename: fn });
  setTimeout(() => fileStore.delete(jobId), 3600000);
  return fn;
}

// Gemini analyze
async function analyzeImage(b64, mime) {
  try {
    const prompt = `You are an expert embroidery digitizer. Analyze this image and output ONLY valid JSON.
    
CRITICAL: Convert the image to simplified EMBROIDERY SHAPES (polygons with exact corner points).
- Text = polygon shapes (trace letter outlines)
- Logos = polygon parts
- Background shapes = only if distinct color blocks
- IGNORE gradients, shadows, photo effects
- Use flat dominant colors only

Output JSON:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB"],
  "estimated_stitch_count": number,
  "width_mm": 80,
  "height_mm": 80,
  "simplified_shapes": [
    {
      "type": "polygon",
      "label": "description",
      "points": [[x1,y1], [x2,y2], ...],
      "color": "#RRGGBB",
      "stitch_type": "fill|satin|running",
      "thread_angle": 0,
      "density": "normal"
    }
  ]
}

Scale: x and y are 0-100 (percentage of design size).`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[ { inlineData:{mimeType:mime,data:b64} }, { text: prompt } ] }] },
      { timeout: 60000 }
    );
    const c = r.data?.candidates?.[0];
    const p = c?.content?.parts?.[0];
    const text = p?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch(e) {
    console.error("Gemini:", e.message);
    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, simplified_shapes:[] };
  }
}

// Stitch generation
function generateStitches(analysis) {
  const shapes = analysis.simplified_shapes || [];
  const colors = analysis.dominant_colors || ["#c41e3a"];
  const w = (analysis.width_mm || 80) * 3;
  const h = (analysis.height_mm || 80) * 3;
  const all = [];

  if (shapes.length === 0) {
    for (let r = 0; r < 100; r++) {
      const color = colors[r % colors.length];
      const y = (r / 100) * h;
      all.push({ x: 0, y, color, type: "jump" });
      for (let x = 0; x < w; x += 3) all.push({ x, y, color, type: "stitch" });
    }
    return { stitches: all, width: w, height: h, colors };
  }

  for (const shape of shapes) {
    const color = shape.color || colors[0];
    const pts = (shape.points || []).map(p => ({ x: (p[0]/100)*w, y: (p[1]/100)*h }));
    if (pts.length < 2) continue;
    
    // Simple fill: scanline
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    
    const step = 2;
    const rows = Math.floor((maxY - minY) / step);
    for (let r = 0; r < rows; r++) {
      const rowY = minY + r * step;
      const ints = [];
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i], p2 = pts[(i+1)%pts.length];
        if ((p1.y <= rowY && p2.y > rowY) || (p1.y > rowY && p2.y <= rowY)) {
          const t = (rowY - p1.y) / (p2.y - p1.y);
          ints.push(p1.x + t * (p2.x - p1.x));
        }
      }
      ints.sort((a,b) => a - b);
      for (let i = 0; i < ints.length - 1; i += 2) {
        const sx = ints[i], ex = ints[i+1];
        if (ex - sx < 1) continue;
        all.push({ x: sx, y: rowY, color, type: "jump" });
        for (let x = sx; x <= ex; x += step) all.push({ x, y: rowY, color, type: "stitch" });
      }
    }
  }
  return { stitches: all, width: w, height: h, colors };
}

// DST encoder
function encodeDST(data) {
  const stitches = data.stitches || [];
  const colors = data.colors || ["#c41e3a"];
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }
  
  const pad = (s, n) => Buffer.from(s.padEnd(n, " "), "ascii");
  let header = Buffer.concat([
    pad("LA:Stichai", 20), pad("ST:"+stitches.length, 10), pad("CO:"+colors.length, 10),
    pad("+X:"+Math.abs(maxX), 10), pad("-X:"+Math.abs(minX), 10),
    pad("+Y:"+Math.abs(maxY), 10), pad("-Y:"+Math.abs(minY), 10),
    pad("AX:+", 10), pad("AY:+", 10), pad("MX:", 10), pad("MY:", 10), pad("PD:******", 10),
    Buffer.alloc(512 - 120)
  ]);

  const records = [];
  let prevX = 0, prevY = 0, currentColor = 0;
  for (const s of stitches) {
    const ci = colors.indexOf(s.color);
    if (ci !== -1 && ci !== currentColor) { currentColor = ci; records.push(Buffer.from([0x00, 0x00, 0xC3])); }
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX += dx; prevY += dy;
    const clamp = v => Math.max(-121, Math.min(121, v));
    const yb = clamp(dy) >= 0 ? clamp(dy) : 256 + clamp(dy);
    const xb = clamp(dx) >= 0 ? clamp(dx) : 256 + clamp(dx);
    records.push(Buffer.from([yb, xb, s.type === "jump" ? 0x83 : 0x03]));
  }
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  return Buffer.concat([header, ...records]);
}

// Routes
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const analysis = await analyzeImage(b64, req.file.mimetype || "image/jpeg");
    const stitchData = generateStitches(analysis);
    res.json({ ...analysis, stitch_data: stitchData, preview_image: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";
    const jobId = "job_" + Date.now().toString(36);
    
    const analysis = await analyzeImage(b64, mime);
    const stitchData = generateStitches(analysis);
    const fileData = encodeDST(stitchData);
    storeFile(jobId, fileData, format === "dst" ? "dst" : format);
    
    const result = {
      stitch_count: stitchData.stitches.length,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ["#c41e3a"],
      width_mm: analysis.width_mm, height_mm: analysis.height_mm,
      stitch_data: stitchData,
      dst_url: format === "dst" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      pes_url: format === "pes" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      jef_url: format === "jef" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      exp_url: format === "exp" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      vp3_url: format === "vp3" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
    };
    
    jobCache.set(jobId, { status: "completed", result });
    res.json({ jobId, status: "completed", result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/status/:jobId", (req, res) => {
  const j = jobCache.get(req.params.jobId);
  if (j) return res.json(j);
  res.status(404).json({ error: "Not found" });
});

app.get("/api/download/:jobId", (req, res) => {
  const f = fileStore.get(req.params.jobId);
  if (!f) return res.status(404).json({ error: "Expired" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
  res.send(f.buffer);
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

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.2" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stichai v6.2 on port ${PORT}`);
});