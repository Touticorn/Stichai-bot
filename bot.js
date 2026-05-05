const express = require("express");
const axios = require("axios");
const multer = require("multer");

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI: {
    flash: "gemini-2.5-flash",
    image: "gemini-2.0-flash-exp"
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
// STAGE 1: Clean Image — Remove shadows, flatten to solid colors
// =====================================================================
async function cleanImage(b64, mime) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.image}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: "Redraw this as a clean flat design illustration. Remove all shadows, reflections, gradients. Use only solid flat colors. Make it look like a clean logo or icon. Return the generated image." }
          ]
        }]
      },
      { timeout: 120000 }
    );

    const parts = r.data?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        return {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
          success: true
        };
      }
    }
    return { success: false };
  } catch(e) {
    console.error("Clean error:", e.message);
    return { success: false, error: e.message };
  }
}

// =====================================================================
// STAGE 2: Analyze cleaned design for embroidery regions
// =====================================================================
async function analyzeForEmbroidery(b64, mime) {
  try {
    const prompt = `You are an expert embroidery digitizer. Analyze this clean flat design.

Return ONLY JSON:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB"],
  "estimated_stitch_count": number,
  "width_mm": 80,
  "height_mm": 80,
  "regions": [
    {
      "id": 1,
      "label": "what this region is",
      "color": "#RRGGBB",
      "position": {"x": 0, "y": 0, "w": 100, "h": 100},
      "stitch_type": "fill|satin|running",
      "priority": 1
    }
  ]
}

Position uses 0-100 scale. Priority: 1=background first, higher=top layers.`;

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
    return { complexity: "medium", dominant_colors: ["#000000"], width_mm: 80, height_mm: 80, estimated_stitch_count: 5000, regions: [] };
  }
}

// =====================================================================
// STAGE 3: Generate stitches from regions
// =====================================================================
function generateStitches(analysis) {
  const regions = (analysis.regions || []).sort((a, b) => (a.priority || 1) - (b.priority || 1));
  const colors = analysis.dominant_colors || ["#000000"];
  const w = (analysis.width_mm || 80) * 3;
  const h = (analysis.height_mm || 80) * 3;
  const stitches = [];

  for (const region of regions) {
    if (region.stitch_type === "skip") continue;
    const color = region.color || colors[0];
    const pos = region.position || { x: 0, y: 0, w: 100, h: 100 };
    const rx = (pos.x / 100) * w;
    const ry = (pos.y / 100) * h;
    const rw = (pos.w / 100) * w;
    const rh = (pos.h / 100) * h;

    if (region.stitch_type === "fill") {
      const spacing = 2;
      const rows = Math.max(3, Math.floor(rh / spacing));
      for (let r = 0; r < rows; r++) {
        const rowY = ry + (r / rows) * rh;
        stitches.push({ x: rx, y: rowY, color, type: "jump" });
        for (let cx = rx; cx <= rx + rw; cx += 3) {
          stitches.push({ x: cx, y: rowY, color, type: "stitch" });
        }
      }
    } else if (region.stitch_type === "running") {
      const count = Math.floor((rw + rh) * 2 / 2);
      for (let i = 0; i < count; i++) {
        const t = (i / count) * 4;
        const side = Math.floor(t) % 4;
        const st = t - Math.floor(t);
        let px, py;
        if (side === 0) { px = rx + rw * st; py = ry; }
        else if (side === 1) { px = rx + rw; py = ry + rh * st; }
        else if (side === 2) { px = rx + rw * (1 - st); py = ry + rh; }
        else { px = rx; py = ry + rh * (1 - st); }
        stitches.push({ x: px, y: py, color, type: i === 0 ? "jump" : "stitch" });
      }
    }
  }

  return { stitches, width: w, height: h, colors, regions: analysis.regions };
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
// ROUTES
// =====================================================================
app.post("/api/clean-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const result = await cleanImage(req.file.buffer.toString("base64"), req.file.mimetype || "image/jpeg");
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";

    const analysis = await analyzeForEmbroidery(b64, mime);
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
      regions: analysis.regions,
      stitch_data: stitchData,
      dst_url: format === "dst" ? `${CONFIG.BASE_URL}/api/download/${jobId}` : null,
      estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
    };

    res.json({ jobId, status: "completed", result });
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
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.3" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Stichai v6.3 on port " + PORT);
});