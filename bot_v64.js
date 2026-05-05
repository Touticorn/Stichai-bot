const express = require("express");
const axios = require("axios");
const multer = require("multer");

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI: {
    flash: "gemini-3-flash-preview",
    image: "gemini-3.1-flash-image-preview"
  },
  BASE_URL: process.env.BASE_URL || "https://stichai-bot-production.up.railway.app",
};

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

const fileStore = new Map();

function storeFile(jobId, buffer, ext) {
  const fn = `embroidery_${Date.now()}.${ext}`;
  fileStore.set(jobId, { buffer, ext, filename: fn });
  setTimeout(() => fileStore.delete(jobId), 3600000);
  return fn;
}

// =====================================================================
// STEP 1: Clean photo with Gemini 3 image model
// =====================================================================
async function cleanImage(b64, mime) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.image}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: `Transform this photo into a clean, flat 2D illustration.

REQUIREMENTS:
- Remove ALL shadows, reflections, gradients, and 3D effects
- Convert to solid flat colors only
- Make it look like a clean vector graphic or logo
- Preserve the design elements (text, logos, shapes) clearly
- Use a clean white or transparent background
- Output as a clean illustration image` }
          ]
        }]
      },
      { timeout: 120000 }
    );

    const parts = r.data?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        return { success: true, mimeType: part.inlineData.mimeType, data: part.inlineData.data };
      }
    }
    return { success: false, error: "No image in response" };
  } catch(e) {
    console.error("Clean image error:", e.message);
    return { success: false, error: e.message };
  }
}

// =====================================================================
// STEP 2: Analyze shapes from cleaned image
// =====================================================================
async function analyzeImage(b64, mime) {
  try {
    const prompt = `Analyze this clean flat design for embroidery digitization.

Return ONLY JSON:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB", "#RRGGBB"],
  "estimated_stitch_count": number,
  "width_mm": 80,
  "height_mm": 80,
  "shapes": [
    {
      "label": "description",
      "color": "#RRGGBB",
      "x": 0, "y": 0, "w": 100, "h": 100,
      "stitch_type": "fill|satin|running"
    }
  ]
}

Break into 2-6 color regions. x,y,w,h are 0-100 scale. stitch_type: fill=large areas, satin=borders, running=thin lines. Output ONLY JSON.`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }] },
      { timeout: 60000 }
    );

    const p = r.data?.candidates?.[0]?.content?.parts?.[0];
    const text = p?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch(e) {
    console.error("Analyze:", e.message);
    return { complexity: "medium", dominant_colors: ["#C41E3A", "#FFD700", "#FFFFFF"], estimated_stitch_count: 5000, width_mm: 80, height_mm: 80, shapes: [{ label: "Main", color: "#C41E3A", x: 5, y: 5, w: 90, h: 90, stitch_type: "fill" }] };
  }
}

// =====================================================================
// STEP 3: Generate stitches
// =====================================================================
function generateStitches(analysis) {
  const shapes = analysis.shapes || [];
  const colors = analysis.dominant_colors || ["#C41E3A"];
  const w = (analysis.width_mm || 80) * 3;
  const h = (analysis.height_mm || 80) * 3;
  const stitches = [];

  if (shapes.length === 0) {
    for (let r = 0; r < 100; r++) {
      const color = colors[r % colors.length];
      const rowY = (r / 100) * h;
      stitches.push({ x: 0, y: rowY, color, type: "jump" });
      for (let x = 0; x < w; x += 3) stitches.push({ x, y: rowY, color, type: "stitch" });
    }
    return { stitches, width: w, height: h, colors, shapes: [] };
  }

  for (const shape of shapes) {
    const color = shape.color || colors[0];
    const sx = (shape.x / 100) * w;
    const sy = (shape.y / 100) * h;
    const sw = (shape.w / 100) * w;
    const sh_ = (shape.h / 100) * h;

    if (shape.stitch_type === "satin") {
      const count = Math.floor((sw + sh_) * 2 / 2);
      for (let i = 0; i < count; i++) {
        const t = (i / count) * 4;
        const side = Math.floor(t) % 4;
        const st = t - Math.floor(t);
        let ox, oy;
        if (side === 0) { ox = sx + sw * st; oy = sy; }
        else if (side === 1) { ox = sx + sw; oy = sy + sh_ * st; }
        else if (side === 2) { ox = sx + sw * (1 - st); oy = sy + sh_; }
        else { ox = sx; oy = sy + sh_ * (1 - st); }
        const ix = ox + (side % 2 === 0 ? 2 : -2);
        const iy = oy + (side < 2 ? 2 : -2);
        if (i === 0) stitches.push({ x: ox, y: oy, color, type: "jump" });
        stitches.push({ x: ox, y: oy, color, type: "stitch" });
        stitches.push({ x: ix, y: iy, color, type: "stitch" });
      }
    } else if (shape.stitch_type === "running") {
      const count = Math.floor((sw + sh_) * 2 / 3);
      for (let i = 0; i < count; i++) {
        const t = (i / count) * 4;
        const side = Math.floor(t) % 4;
        const st = t - Math.floor(t);
        let px, py;
        if (side === 0) { px = sx + sw * st; py = sy; }
        else if (side === 1) { px = sx + sw; py = sy + sh_ * st; }
        else if (side === 2) { px = sx + sw * (1 - st); py = sy + sh_; }
        else { px = sx; py = sy + sh_ * (1 - st); }
        stitches.push({ x: px, y: py, color, type: i === 0 ? "jump" : "stitch" });
      }
    } else {
      // Fill
      const spacing = 2;
      const rows = Math.max(3, Math.floor(sh_ / spacing));
      for (let r = 0; r < rows; r++) {
        const rowY = sy + (r / rows) * sh_;
        const ints = [];
        const pts = [{ x: sx, y: sy }, { x: sx + sw, y: sy }, { x: sx + sw, y: sy + sh_ }, { x: sx, y: sy + sh_ }, { x: sx, y: sy }];
        for (let i = 0; i < 4; i++) {
          const p1 = pts[i], p2 = pts[i + 1];
          if ((p1.y <= rowY && p2.y > rowY) || (p1.y > rowY && p2.y <= rowY)) {
            const t = (rowY - p1.y) / (p2.y - p1.y);
            ints.push(p1.x + t * (p2.x - p1.x));
          }
        }
        ints.sort((a, b) => a - b);
        for (let i = 0; i < ints.length - 1; i += 2) {
          const startX = ints[i], endX = ints[i + 1];
          if (endX - startX < 1) continue;
          stitches.push({ x: startX, y: rowY, color, type: "jump" });
          for (let x = startX; x <= endX; x += 3) stitches.push({ x, y: rowY, color, type: "stitch" });
        }
      }
    }
  }

  return { stitches, width: w, height: h, colors, shapes };
}

// =====================================================================
// DST Encoder
// =====================================================================
function encodeDST(data) {
  const stitches = data.stitches || [];
  const colors = data.colors || ["#000000"];
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }

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

// =====================================================================
// API ROUTES
// =====================================================================

// Clean image
app.post("/api/clean-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const result = await cleanImage(req.file.buffer.toString("base64"), req.file.mimetype || "image/jpeg");
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Analyze + generate stitches
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const analysis = await analyzeImage(b64, req.file.mimetype || "image/jpeg");
    const stitchData = generateStitches(analysis);
    res.json({ ...analysis, stitch_data: stitchData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Full convert → file
app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";

    const analysis = await analyzeImage(b64, mime);
    const stitchData = generateStitches(analysis);
    const fileData = encodeDST(stitchData);
    const jobId = "job_" + Date.now().toString(36);
    storeFile(jobId, fileData, format);

    res.json({
      jobId,
      status: "completed",
      result: {
        stitch_count: stitchData.stitches.length,
        colors: analysis.dominant_colors?.length || 1,
        dominant_colors: analysis.dominant_colors,
        width_mm: analysis.width_mm,
        height_mm: analysis.height_mm,
        shapes: analysis.shapes,
        stitch_data: stitchData,
        dst_url: `${CONFIG.BASE_URL}/api/download/${jobId}`,
        estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.4" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Stichai v6.4 on port " + PORT);
});
