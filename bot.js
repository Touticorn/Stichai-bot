const express = require("express");
const axios = require("axios");
const multer = require("multer");

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI: {
    flash: "gemini-2.5-flash",
    pro: "gemini-2.5-pro",
    image: "gemini-2.0-flash-exp"  // For image generation
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

// =====================================================================
// STAGE 1: Clean the image — Remove shadows, flatten colors
// =====================================================================
async function cleanImage(b64, mime) {
  try {
    // Ask Gemini to redraw the design as clean flat illustration
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.image}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: `Redraw this design as a clean, flat vector-style illustration. 

RULES:
- Remove all shadows, reflections, gradients, and photo effects
- Use only solid, flat colors
- Make it look like a clean scanned design or logo
- Preserve all text and logos clearly
- Output as a clean illustration with transparent or white background
- Return ONLY the generated image.` }
          ]
        }]
      },
      { timeout: 120000, responseType: "json" }
    );

    // Extract generated image
    const candidate = r.data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        return {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
          success: true
        };
      }
    }
    return { success: false, error: "No image generated" };
  } catch(e) {
    console.error("Clean image error:", e.message);
    return { success: false, error: e.message };
  }
}

// =====================================================================
// STAGE 2: Analyze cleaned design for embroidery
// =====================================================================
async function analyzeForEmbroidery(b64, mime) {
  try {
    const prompt = `You are an expert embroidery digitizer. Analyze this clean flat design.

Return ONLY JSON with:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB", "#RRGGBB"],
  "estimated_stitch_count": number,
  "width_mm": number,
  "height_mm": number,
  "description": "brief",
  "regions": [
    {
      "id": 1,
      "type": "background|logo|text|border|accent",
      "color": "#RRGGBB",
      "position": {"x": 0, "y": 0, "w": 100, "h": 100},
      "stitch_type": "fill|satin|running|skip",
      "priority": 1,
      "label": "description"
    }
  ]
}

Region rules:
- Break design into logical color regions (background, main logo, text, borders)
- Position uses 0-100 scale
- stitch_type: fill for large areas, satin for borders, running for thin lines, skip if not needed
- priority: 1 = first (background), higher = sewn later (accents on top)`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }] },
      { timeout: 60000 }
    );

    const c = r.data?.candidates?.[0];
    const p = c?.content?.parts?.[0];
    const text = p?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch(e) {
    console.error("Analyze error:", e.message);
    return { complexity: "medium", dominant_colors: ["#000000"], width_mm: 80, height_mm: 80, estimated_stitch_count: 5000, regions: [] };
  }
}

// =====================================================================
// STAGE 3: Generate stitches from regions
// =====================================================================
function generateStitches(analysis) {
  const regions = analysis.regions || [];
  const colors = analysis.dominant_colors || ["#000000"];
  const w = (analysis.width_mm || 80) * 3;
  const h = (analysis.height_mm || 80) * 3;
  const stitches = [];

  // Sort by priority
  regions.sort((a, b) => (a.priority || 1) - (b.priority || 1));

  for (const region of regions) {
    const color = region.color || colors[0];
    const type = region.stitch_type || "fill";
    const pos = region.position || { x: 0, y: 0, w: 100, h: 100 };
    const x = (pos.x / 100) * w;
    const y = (pos.y / 100) * h;
    const rw = (pos.w / 100) * w;
    const rh = (pos.h / 100) * h;

    if (type === "skip") continue;

    if (type === "fill") {
      // Horizontal fill rows
      const spacing = 2;
      const rows = Math.max(3, Math.floor(rh / spacing));
      for (let r = 0; r < rows; r++) {
        const rowY = y + (r / rows) * rh;
        stitches.push({ x: x, y: rowY, color, type: "jump" });
        for (let cx = x; cx <= x + rw; cx += 3) {
          stitches.push({ x: cx, y: rowY, color, type: "stitch" });
        }
      }
    } else if (type === "satin") {
      // Zigzag border
      const density = 1.5;
      const count = Math.floor((rw + rh) * 2 / density);
      for (let i = 0; i < count; i++) {
        const t = i / count;
        // Simple rectangle border for now
        const side = Math.floor(t * 4);
        const st = (t * 4) - side;
        let ox, oy;
        if (side === 0) { ox = x + rw * st; oy = y; }
        else if (side === 1) { ox = x + rw; oy = y + rh * st; }
        else if (side === 2) { ox = x + rw * (1 - st); oy = y + rh; }
        else { ox = x; oy = y + rh * (1 - st); }
        const ix = ox + (side % 2 === 0 ? 1 : -1) * 2;
        const iy = oy + (side < 2 ? 1 : -1) * 2;
        if (i === 0) stitches.push({ x: ox, y: oy, color, type: "jump" });
        stitches.push({ x: ox, y: oy, color, type: "stitch" });
        stitches.push({ x: ix, y: iy, color, type: "stitch" });
      }
    } else if (type === "running") {
      // Single outline
      const count = Math.floor((rw + rh) * 2 / 2);
      for (let i = 0; i < count; i++) {
        const t = (i / count) * 4;
        const side = Math.floor(t) % 4;
        const st = t - Math.floor(t);
        let px, py;
        if (side === 0) { px = x + rw * st; py = y; }
        else if (side === 1) { px = x + rw; py = y + rh * st; }
        else if (side === 2) { px = x + rw * (1 - st); py = y + rh; }
        else { px = x; py = y + rh * (1 - st); }
        stitches.push({ x: px, y: py, color, type: i === 0 ? "jump" : "stitch" });
      }
    }
  }

  return { stitches, width: w, height: h, colors };
}

// =====================================================================
// DST Encoder
// =====================================================================
function encodeDST(data) {
  const stitches = data.stitches || [];
  const colors = data.colors || ["#000000"];
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }

  const pad = (s, n) => Buffer.from(s.padEnd(n, " "), "ascii");
  let header = Buffer.concat([
    pad("LA:Stichai", 20), pad("ST:" + stitches.length, 10), pad("CO:" + colors.length, 10),
    pad("+X:" + Math.abs(maxX), 10), pad("-X:" + Math.abs(minX), 10),
    pad("+Y:" + Math.abs(maxY), 10), pad("-Y:" + Math.abs(minY), 10),
    pad("AX:+", 10), pad("AY:+", 10), pad("MX:", 10), pad("MY:", 10), pad("PD:******", 10),
    Buffer.alloc(512 - 120)
  ]);

  const records = [];
  let prevX = 0, prevY = 0, currentColor = 0;
  for (const s of stitches) {
    const ci = colors.indexOf(s.color);
    if (ci !== -1 && ci !== currentColor) {
      currentColor = ci;
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
    }
    const dx = Math.round(s.x - prevX);
    const dy = Math.round(s.y - prevY);
    prevX += dx; prevY += dy;
    const clamp = v => Math.max(-121, Math.min(121, v));
    const yb = clamp(dy) >= 0 ? clamp(dy) : 256 + clamp(dy);
    const xb = clamp(dx) >= 0 ? clamp(dx) : 256 + clamp(dx);
    records.push(Buffer.from([yb, xb, s.type === "jump" ? 0x83 : 0x03]));
  }
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  return Buffer.concat([header, ...records]);
}

// =====================================================================
// API ROUTES
// =====================================================================

// Stage 1: Clean the image
app.post("/api/clean-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const result = await cleanImage(b64, req.file.mimetype || "image/jpeg");
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Stage 2: Analyze cleaned image
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const analysis = await analyzeForEmbroidery(b64, req.file.mimetype || "image/jpeg");
    const stitchData = generateStitches(analysis);
    res.json({ ...analysis, stitch_data: stitchData });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Convert to file
app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";
    const b64 = req.file.buffer.toString("base64");

    const analysis = await analyzeForEmbroidery(b64, req.file.mimetype || "image/jpeg");
    const stitchData = generateStitches(analysis);
    const fileData = encodeDST(stitchData);
    const jobId = "job_" + Date.now().toString(36);
    storeFile(jobId, fileData, format);

    const result = {
      stitch_count: stitchData.stitches.length,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors,
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      dst_url: format === "dst" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      pes_url: format === "pes" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
    };
    jobCache.set(jobId, { status: "completed", result });
    res.json({ jobId, status: "completed", result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.3" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Stichai v6.3 on port " + PORT);
});