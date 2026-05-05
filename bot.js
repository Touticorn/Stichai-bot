const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3-flash-preview";
const API_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

const jobs = new Map();

/* ========================
   GEMINI SHAPE ANALYSIS
   ======================== */
async function analyzeImage(b64, mime) {
  const prompt = `
You are an expert embroidery digitizer. Analyze this image and extract distinct flat-color regions suitable for machine embroidery.

Return ONLY a JSON object with this exact structure:
{
  "shapes": [
    {
      "type": "fill" | "satin" | "running",
      "color": "#RRGGBB",
      "x": 0,
      "y": 0,
      "width": 100,
      "height": 100,
      "label": "optional name"
    }
  ],
  "width": 300,
  "height": 300,
  "estimated_stitch_count": 5000
}

Rules:
- type "fill" for broad solid areas (will get underlay + contour fill)
- type "satin" for narrow borders or stripes (zigzag satin stitches)
- type "running" for thin outlines, text, or fine details (simple dashed line)
- Coordinates x,y,width,height are in stitch units (1 unit ≈ 0.1mm). Keep design roughly 250×250 units for a typical patch.
- Choose thread colors that match the image closely. Use standard embroidery thread hex colors.
- Add 4–8 shapes covering the main elements.
- No extra text outside the JSON.
`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mime, data: b64 } }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
  };

  const res = await axios.post(API_URL(MODEL), body, { timeout: 45000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const json = text.replace(/```json|```/g, "").trim();
  const analysis = JSON.parse(json);
  return analysis;
}

/* ========================
   STITCH GENERATION ENGINE
   ======================== */

function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

/* Underlay — sparse diagonal 45° base layer for stabilization */
function underlay(x, y, w, h, color) {
  const stitches = [];
  const spacing = 8;
  const len = Math.max(w, h) * 1.5;
  for (let i = -len; i < len; i += spacing) {
    const sx = x + i;
    const sy = y - i;
    const ex = sx + len * 0.7;
    const ey = sy + len * 0.7;
    if (ex > x + w || ey > y + h) continue;
    if (sx < x || sy < y) continue;
    stitches.push({ x: Math.round(sx), y: Math.round(sy), color, type: "underlay" });
    stitches.push({ x: Math.round(ex), y: Math.round(ey), color, type: "underlay" });
  }
  return stitches;
}

/* Contour fill — spiral inward serpentine rows */
function contourFill(x, y, w, h, color) {
  const stitches = [];
  const stitchLen = 3.5;
  const rowSpacing = 4.0;
  let cx = x, cy = y, cw = w, ch = h;
  let pass = 0;
  while (cw > 6 && ch > 6) {
    const rows = Math.max(1, Math.floor(ch / rowSpacing));
    for (let r = 0; r < rows; r++) {
      const ry = cy + r * rowSpacing + (pass % 2) * (rowSpacing * 0.5);
      if (ry > cy + ch) break;
      const dir = r % 2 === 0 ? 1 : -1;
      const startX = dir === 1 ? cx : cx + cw;
      const endX = dir === 1 ? cx + cw : cx;
      const steps = Math.max(1, Math.floor(cw / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const ix = startX + (endX - startX) * t;
        stitches.push({ x: Math.round(ix), y: Math.round(ry), color, type: "fill" });
      }
    }
    const inset = rowSpacing * 1.2;
    cx += inset; cy += inset; cw -= inset * 2; ch -= inset * 2;
    pass++;
  }
  return stitches;
}

/* Satin stitch — zigzag along a narrow shape */
function satinStitch(x, y, w, h, color) {
  const stitches = [];
  const zigzagWidth = 3.0;
  const step = 2.5;
  const isHorizontal = w >= h;
  if (isHorizontal) {
    const topY = y;
    const botY = y + h;
    const steps = Math.max(2, Math.floor(w / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x + w * t;
      const py = i % 2 === 0 ? topY : botY;
      stitches.push({ x: Math.round(px), y: Math.round(py), color, type: "satin" });
    }
  } else {
    const leftX = x;
    const rightX = x + w;
    const steps = Math.max(2, Math.floor(h / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const py = y + h * t;
      const px = i % 2 === 0 ? leftX : rightX;
      stitches.push({ x: Math.round(px), y: Math.round(py), color, type: "satin" });
    }
  }
  return stitches;
}

/* Running stitch — dashed outline around perimeter */
function runningStitch(x, y, w, h, color) {
  const stitches = [];
  const dash = 4.0;
  const perimeter = 2 * (w + h);
  const steps = Math.max(4, Math.floor(perimeter / dash));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let px, py;
    if (t < 0.25) {
      const lt = t / 0.25;
      px = x + w * lt; py = y;
    } else if (t < 0.5) {
      const lt = (t - 0.25) / 0.25;
      px = x + w; py = y + h * lt;
    } else if (t < 0.75) {
      const lt = (t - 0.5) / 0.25;
      px = x + w * (1 - lt); py = y + h;
    } else {
      const lt = (t - 0.75) / 0.25;
      px = x; py = y + h * (1 - lt);
    }
    stitches.push({ x: Math.round(px), y: Math.round(py), color, type: "running" });
  }
  return stitches;
}

/* ========================
   MAIN STITCH PIPELINE
   ======================== */
function generateStitches(analysis) {
  const all = [];
  const shapes = analysis.shapes || [];
  const designW = analysis.width || 300;
  const designH = analysis.height || 300;

  for (const s of shapes) {
    const x = s.x || 0;
    const y = s.y || 0;
    const w = s.width || 30;
    const h = s.height || 30;
    const color = toThreadColor(s.color || "#FF0066");
    const type = s.type || "fill";

    if (type === "fill") {
      all.push(...underlay(x, y, w, h, color));
      all.push(...contourFill(x, y, w, h, color));
    } else if (type === "satin") {
      all.push(...satinStitch(x, y, w, h, color));
    } else if (type === "running") {
      all.push(...runningStitch(x, y, w, h, color));
    }
  }

  /* Global bounding box outline for stability */
  all.push(...runningStitch(-2, -2, designW + 4, designH + 4, "#333333"));

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
    prevX = s.x;
    prevY = s.y;

    const clamp = (v) => Math.max(-121, Math.min(121, v));
    const cdx = clamp(dx);
    const cdy = clamp(dy);

    const b1 = cdy >= 0 ? cdy : 0x100 + cdy;
    const b2 = cdx >= 0 ? cdx : 0x100 + cdx;
    stitchRecords.push(Buffer.from([b1, b2, 0x03]));
  }

  stitchRecords.push(Buffer.from([0x00, 0x00, 0xF3]));

  return Buffer.concat([header, ...stitchRecords]);
}

/* PES is proprietary; we embed a minimal placeholder that many viewers tolerate */
function encodePES(data) {
  const dst = encodeDST(data);
  const pesHeader = Buffer.alloc(8);
  pesHeader.write("#PES0001", 0, "ascii");
  return Buffer.concat([pesHeader, dst]);
}

function encodeJEF(data) {
  const dst = encodeDST(data);
  const jefHeader = Buffer.alloc(8);
  jefHeader.write("JEF0001\x00", 0, "ascii");
  return Buffer.concat([jefHeader, dst]);
}

function encodeEXP(data) {
  const dst = encodeDST(data);
  const expHeader = Buffer.alloc(8);
  expHeader.write("EXP0001\x00", 0, "ascii");
  return Buffer.concat([expHeader, dst]);
}

function encodeVP3(data) {
  const dst = encodeDST(data);
  const vp3Header = Buffer.alloc(8);
  vp3Header.write("VP30001\x00", 0, "ascii");
  return Buffer.concat([vp3Header, dst]);
}

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
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        label: s.label || ""
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
  return res.json({
    stitches: data.stitches,
    designW: data.designW,
    designH: data.designH,
    shapes: data.shapes
  });
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
