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
   GEMINI ANALYSIS
   Analyze photo directly — mentally flatten it
   ======================== */
async function analyzeImage(b64, mime) {
  const prompt = `You are an expert embroidery digitizer. I will show you a photo of a design (logo, text, artwork on fabric, packaging, etc.).

Your task: mentally remove ALL photo artifacts and extract ONLY the underlying flat design.

IMPORTANT — ignore these photo artifacts:
- Shadows, highlights, reflections, glare
- Fabric texture, wrinkles, folds
- 3D depth, lighting gradients
- Photo noise, blur, camera distortion
- Background clutter not part of the design

What to extract:
- The actual design colors (red text, white background, gold stripe, etc.)
- Every distinct flat-color region as a separate shape
- Text elements as individual shapes
- Borders, stripes, logos as separate shapes

Return ONLY compact JSON (no spaces, no markdown, no commentary):
{"shapes":[{"type":"fill","color":"#RRGGBB","x":0,"y":0,"width":100,"height":100}],"width":300,"height":300}

CRITICAL color rules:
- Use ONLY colors that exist in the actual DESIGN, not photo artifacts
- The background of the design is a shape too
- Match colors precisely — red should be red, not pink or orange
- Do NOT invent colors that are not in the design

Shape rules:
- "fill" = broad solid areas (backgrounds, large text blocks, logos)
- "satin" = narrow borders, stripes, thin strokes 2-8 units wide
- "running" = tiny details, text serifs, outlines under 4 units
- Create 12 to 25 shapes covering ALL design elements
- Minimum shape 3x3 units. Canvas 300x300 max.
- Each distinct color region = separate shape`;

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
  if (openBraces > 0) {
    const trimmed = repaired.trim();
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar !== '}' && lastChar !== ']') repaired += '"d":0}';
    for (let i = 0; i < openBraces; i++) repaired += '}';
  }
  for (let i = 0; i < openBrackets; i++) repaired += ']';
  return repaired;
}

/* ========================
   STITCH GENERATION ENGINE
   ======================== */
function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

function underlay(x, y, w, h, color) {
  const stitches = [];
  const spacing = 5;
  const len = Math.max(w, h) * 1.5;
  for (let i = -len; i < len; i += spacing) {
    const sx = x + i, sy = y - i;
    const ex = sx + len * 0.7, ey = sy + len * 0.7;
    if (ex > x + w || ey > y + h) continue;
    if (sx < x || sy < y) continue;
    stitches.push({ x: Math.round(sx), y: Math.round(sy), color, type: "underlay" });
    stitches.push({ x: Math.round(ex), y: Math.round(ey), color, type: "underlay" });
  }
  return stitches;
}

function contourFill(x, y, w, h, color) {
  const stitches = [];
  const stitchLen = 2.0;
  const rowSpacing = 2.5;
  let cx = x, cy = y, cw = w, ch = h;
  let pass = 0;
  while (cw > 3 && ch > 3) {
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

function satinStitch(x, y, w, h, color) {
  const stitches = [];
  const step = 1.5;
  const isHorizontal = w >= h;
  if (isHorizontal) {
    const topY = y, botY = y + h;
    const steps = Math.max(2, Math.floor(w / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x + w * t;
      const py = i % 2 === 0 ? topY : botY;
      stitches.push({ x: Math.round(px), y: Math.round(py), color, type: "satin" });
    }
  } else {
    const leftX = x, rightX = x + w;
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

function runningStitch(x, y, w, h, color) {
  const stitches = [];
  const dash = 2.0;
  const perimeter = 2 * (w + h);
  const steps = Math.max(4, Math.floor(perimeter / dash));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let px, py;
    if (t < 0.25) { const lt = t / 0.25; px = x + w * lt; py = y; }
    else if (t < 0.5) { const lt = (t - 0.25) / 0.25; px = x + w; py = y + h * lt; }
    else if (t < 0.75) { const lt = (t - 0.5) / 0.25; px = x + w * (1 - lt); py = y + h; }
    else { const lt = (t - 0.75) / 0.25; px = x; py = y + h * (1 - lt); }
    stitches.push({ x: Math.round(px), y: Math.round(py), color, type: "running" });
  }
  return stitches;
}

function generateStitches(analysis) {
  let all = [];
  const shapes = analysis.shapes || [];
  const designW = analysis.width || 300;
  const designH = analysis.height || 300;

  for (const s of shapes) {
    const x = s.x || 0, y = s.y || 0;
    const w = s.width || 30, h = s.height || 30;
    const color = toThreadColor(s.color || "#FF0066");
    const type = s.type || "fill";

    if (type === "fill") {
      all = all.concat(underlay(x, y, w, h, color));
      all = all.concat(contourFill(x, y, w, h, color));
      all = all.concat(runningStitch(x - 0.5, y - 0.5, w + 1, h + 1, color));
    } else if (type === "satin") {
      all = all.concat(satinStitch(x, y, w, h, color));
      all = all.concat(runningStitch(x - 0.5, y - 0.5, w + 1, h + 1, color));
    } else if (type === "running") {
      all = all.concat(runningStitch(x, y, w, h, color));
    }
  }

  all = all.concat(runningStitch(-2, -2, designW + 4, designH + 4, "#333333"));
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
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height
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
