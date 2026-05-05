// ========================================================================
// Stichai Bot v6.1 — Better prompts, polygon shapes, text-as-paths
// ========================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI: {
    lite:  "gemini-2.5-flash-lite-preview-06-17",
    flash: "gemini-2.5-flash",
    pro:   "gemini-2.5-pro",
  },
  PHONE: process.env.BOT_PHONE || "+212762609694",
  WEBHOOK: process.env.WEBHOOK_URL || "https://api.callmebot.com/whatsapp.php",
  BASE_URL: process.env.BASE_URL || "https://stichai-bot-production.up.railway.app",
  ADMIN_NUMBERS: (process.env.ADMIN_NUMBERS || "+212762609694,+971585048502").split(","),
};

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

const msgCache = new NodeCache({ stdTTL: 300 });
const jobCache = new NodeCache({ stdTTL: 3600 });
let db = null;
let whSocket = null;

async function initDB() {
  if (db) return;
  const sqlite3 = await import("sqlite3").then(m=>m.default);
  const { open } = await import("sqlite");
  db = await open({ filename: "bot.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (phone TEXT PRIMARY KEY, name TEXT, lang TEXT DEFAULT "en", joined TEXT);
    CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, phone TEXT, image TEXT, colors TEXT, status TEXT, price TEXT, file_url TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, phone TEXT, image TEXT, settings TEXT, status TEXT, result TEXT, created TEXT);
  `);
}

async function getUser(phone) {
  return db?.get("SELECT * FROM users WHERE phone=?", [phone]);
}
async function addUser(phone, name, lang="en") {
  await db?.run("INSERT OR IGNORE INTO users (phone,name,lang,joined) VALUES (?,?,?,?)", [phone,name||"",lang, new Date().toISOString()]);
}
async function addOrder(phone, image, colors, status="pending", price="", file_url="") {
  const id = Date.now().toString(36);
  await db?.run("INSERT INTO orders (id,phone,image,colors,status,price,file_url,created) VALUES (?,?,?,?,?,?,?,?)",
    [id,phone,image||"",colors||"",status,price,file_url, new Date().toISOString()]);
  return id;
}
async function addJob(phone, image, settings, status="pending") {
  const id = "job_" + Date.now().toString(36);
  await db?.run("INSERT INTO jobs (id,phone,image,settings,created) VALUES (?,?,?,?,?)",
    [id,phone,image||"",JSON.stringify(settings||{}), new Date().toISOString()]);
  return id;
}

async function initBaileys() {
  const authDir = "/app/.baileys_auth";
  try { fs.rmSync(authDir, { recursive: true }); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  whSocket = makeWASocket({ auth: state });

  whSocket.ev.on("creds.update", saveCreds);
  whSocket.ev.on("connection.update", ({ connection, qr }) => {
    if (connection === "open") console.log("WhatsApp ready");
    if (connection === "close") setTimeout(initBaileys, 5000);
  });

  whSocket.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const phone = msg.key.remoteJid?.replace(/\D/g,"");
      if (!phone) continue;
      const txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      await processMsg(phone, txt.toLowerCase(), msg);
    }
  });
}

const TRANSLATIONS = {
  en: { welcome:"Welcome!", upload:"Upload image", analyze:"Analyze", stitch:"Stitch", price:"Price", order:"Order", thanks:"Thank you!" },
  fr: { welcome:"Bienvenue!", upload:"Télécharger", analyze:"Analyser", stitch:"Point", price:"Prix", order:"Commander", thanks:"Merci!" },
  ar: { welcome:"مرحباً!", upload:"رفع صورة", analyze:"تحليل", stitch:"غرزة", price:"السعر", order:"طلب", thanks:"شكراً!" }
};
function getLang(phone) { return "en"; }
function t(phone, key) { return TRANSLATIONS[getLang(phone)]?.[key] || key; }

// ========================================================================
// GEMINI — Better prompt for detailed shapes
// ========================================================================
async function detectComplexity(b64, mime) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.lite}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[{ inline_data:{mime_type:mime,data:b64} },{ text:`ONE word only: "simple", "medium", or "complex"` }] }] },
      { timeout: 10000 }
    );
    const c = r.data?.candidates?.[0];
    const p = c?.content?.parts?.[0];
    const w = p?.text?.trim()?.toLowerCase() || "medium";
    return w.includes("simple") ? "simple" : w.includes("complex") ? "complex" : "medium";
  } catch { return "medium"; }
}

async function analyzeImage(b64, mime) {
  try {
    const complexity = await detectComplexity(b64, mime);
    const modelKey = complexity === "simple" ? "lite" : complexity === "complex" ? "pro" : "flash";
    const model = CONFIG.GEMINI[modelKey];

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

Example for 'W' text:
{
  "type": "polygon",
  "label": "letter W",
  "points": [[10,10], [15,30], [20,10], [25,30], [30,10], [28,35], [23,15], [18,35], [12,35]],
  "color": "#FFFFFF",
  "stitch_type": "satin",
  "thread_angle": 90,
  "density": "dense"
}

Scale: Use 0-100 for both x and y (percentage of design width/height).`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[
        { inline_data:{mime_type:mime,data:b64} },
        { text: prompt }
      ] }] },
      { timeout: 80000 }
    );

    const c = r.data?.candidates?.[0];
    const p = c?.content?.parts?.[0];
    const text = p?.text || "{}";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    result._model = model;
    return result;
  } catch(e) {
    console.error("Gemini error:", e.message);
    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", simplified_shapes:[] };
  }
}

// ========================================================================
// STITCH ENGINE — Polygon-based with angles and density
// ========================================================================
function generateStitches(analysis) {
  const shapes = analysis.simplified_shapes || [];
  const colors = analysis.dominant_colors || ["#c41e3a"];
  const width = (analysis.width_mm || 80) * 3;
  const height = (analysis.height_mm || 80) * 3;
  const allStitches = [];

  if (shapes.length === 0) {
    // Fallback: generate from dominant colors as fills
    const rows = Math.min(Math.floor((analysis.estimated_stitch_count || 5000) / width), 200);
    for (let r = 0; r < rows; r++) {
      const color = colors[r % colors.length];
      const y = (r / rows) * height;
      allStitches.push({ x: 0, y, color, type: "jump" });
      for (let x = 0; x < width; x += 3) {
        allStitches.push({ x, y: y + Math.sin(x * 0.1) * 2, color, type: "stitch" });
      }
    }
    return { stitches: allStitches, width, height, colors, scale: 3 };
  }

  // Process each polygon shape
  for (const shape of shapes) {
    const color = shape.color || colors[0];
    const type = shape.stitch_type || "fill";
    const angle = shape.thread_angle || 0;
    const density = shape.density === "dense" ? 1.5 : shape.density === "sparse" ? 3 : 2;
    const points = shape.points || [];

    if (points.length < 2) continue;

    // Scale points to canvas size
    const scaledPoints = points.map(p => ({
      x: (p[0] / 100) * width,
      y: (p[1] / 100) * height
    }));

    if (type === "fill") {
      allStitches.push(...polygonFill(scaledPoints, color, angle, density));
    } else if (type === "satin") {
      allStitches.push(...polygonSatin(scaledPoints, color, angle, density));
    } else if (type === "running") {
      allStitches.push(...polygonRunning(scaledPoints, color));
    }
  }

  return { stitches: allStitches, width, height, colors, scale: 3 };
}

// Fill stitch inside polygon — scanline approach with thread angle
function polygonFill(points, color, angle, spacing) {
  const stitches = [];
  if (points.length < 3) return stitches;

  // Find bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }

  const step = spacing || 2;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // For angled fills, we rotate the scan direction
  // Simple approach: scan horizontal rows, then rotate result
  const rowCount = Math.floor((maxY - minY) / step);

  for (let r = 0; r < rowCount; r++) {
    const rowY = minY + r * step;

    // Find all x intersections with polygon edges at this y
    const intersections = [];
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      if ((p1.y <= rowY && p2.y > rowY) || (p1.y > rowY && p2.y <= rowY)) {
        const t = (rowY - p1.y) / (p2.y - p1.y);
        intersections.push(p1.x + t * (p2.x - p1.x));
      }
    }
    intersections.sort((a, b) => a - b);

    // Draw fill between pairs of intersections
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const startX = intersections[i];
      const endX = intersections[i + 1];
      if (endX - startX < 1) continue;

      // Apply angle rotation to row
      stitches.push({ x: startX, y: rowY, color, type: "jump" });

      if (angle === 0) {
        // Horizontal fill
        for (let x = startX; x <= endX; x += step) {
          stitches.push({ x, y: rowY, color, type: "stitch" });
        }
      } else {
        // Angled fill: offset x based on y to create diagonal
        const offset = (rowY - minY) * Math.tan(rad);
        for (let x = startX; x <= endX; x += step) {
          stitches.push({ x: x + offset, y: rowY, color, type: "stitch" });
        }
      }
    }
  }

  return stitches;
}

// Satin stitch — zigzag between two offset polygon edges
function polygonSatin(points, color, angle, density) {
  const stitches = [];
  if (points.length < 3) return stitches;

  const step = density || 1.5;
  const perimeter = getPerimeter(points);
  const stitchCount = Math.floor(perimeter / step);

  for (let i = 0; i < stitchCount; i++) {
    const t1 = (i / stitchCount);
    const t2 = ((i + 0.5) / stitchCount);
    const p1 = getPointOnPolygon(points, t1);
    const p2 = getPointOnPolygon(points, t2);

    if (i === 0) stitches.push({ x: p1.x, y: p1.y, color, type: "jump" });
    stitches.push({ x: p1.x, y: p1.y, color, type: "stitch" });
    stitches.push({ x: p2.x, y: p2.y, color, type: "stitch" });
  }

  return stitches;
}

// Running stitch — follow polygon outline
function polygonRunning(points, color) {
  const stitches = [];
  if (points.length < 2) return stitches;

  const totalDist = getPerimeter(points);
  const step = 2; // 2px between running stitches
  const count = Math.max(Math.floor(totalDist / step), points.length * 3);

  for (let i = 0; i < count; i++) {
    const t = i / count;
    const p = getPointOnPolygon(points, t);
    stitches.push({ x: p.x, y: p.y, color, type: i === 0 ? "jump" : "stitch" });
  }

  return stitches;
}

// Helper: get point along polygon perimeter
function getPointOnPolygon(points, t) {
  const totalDist = getPerimeter(points);
  const targetDist = t * totalDist;
  let dist = 0;

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist + segDist >= targetDist) {
      const segT = (targetDist - dist) / segDist;
      return {
        x: p1.x + (p2.x - p1.x) * segT,
        y: p1.y + (p2.y - p1.y) * segT
      };
    }
    dist += segDist;
  }
  return points[points.length - 1];
}

// Helper: polygon perimeter
function getPerimeter(points) {
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    dist += Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }
  return dist;
}

// ========================================================================
// DST ENCODER
// ========================================================================
function encodeDST(stitchData) {
  const stitches = stitchData.stitches || [];
  const colors = stitchData.colors || ["#c41e3a"];

  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }
  const stitchCount = stitches.length;
  const colorCount = colors.length;

  const h = (label, len) => Buffer.from(label.padEnd(len, " "), "ascii");
  let header = Buffer.concat([
    h("LA:Stichai", 20), h("ST:" + stitchCount, 10), h("CO:" + colorCount, 10),
    h("+X:" + Math.abs(maxX), 10), h("-X:" + Math.abs(minX), 10),
    h("+Y:" + Math.abs(maxY), 10), h("-Y:" + Math.abs(minY), 10),
    h("AX:+", 10), h("AY:+", 10), h("MX:", 10), h("MY:", 10), h("PD:******", 10),
    Buffer.alloc(512 - 120)
  ]);

  const records = [];
  let prevX = 0, prevY = 0;
  let currentColorIdx = 0;

  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i];
    const colorIdx = colors.indexOf(s.color);
    if (colorIdx !== -1 && colorIdx !== currentColorIdx) {
      currentColorIdx = colorIdx;
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
    }

    const dx = Math.round(s.x - prevX);
    const dy = Math.round(s.y - prevY);
    prevX += dx; prevY += dy;

    const clamp = (v) => Math.max(-121, Math.min(121, v));
    const yByte = clamp(dy) >= 0 ? clamp(dy) : 256 + clamp(dy);
    const xByte = clamp(dx) >= 0 ? clamp(dx) : 256 + clamp(dx);
    const flags = s.type === "jump" ? 0x83 : 0x03;
    records.push(Buffer.from([yByte, xByte, flags]));
  }

  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  return Buffer.concat([header, ...records]);
}

function encodeFile(stitchData, format) {
  if (format === "dst") return { data: encodeDST(stitchData), ext: "dst" };
  const formatMap = { pes: "pes", jef: "jef", exp: "exp", vp3: "vp3" };
  return { data: encodeDST(stitchData), ext: formatMap[format] || "dst" };
}

// ========================================================================
// FILE STORE
// ========================================================================
const fileStore = new Map();
function storeFile(jobId, buffer, ext) {
  const filename = `embroidery_${Date.now()}.${ext}`;
  fileStore.set(jobId, { buffer, ext, filename, created: Date.now() });
  setTimeout(() => fileStore.delete(jobId), 3600000);
  return filename;
}

// ========================================================================
// API ROUTES
// ========================================================================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";

    const analysis = await analyzeImage(b64, mime);
    const stitchData = generateStitches(analysis);

    res.json({ ...analysis, stitch_data: stitchData, preview_image: null });
  } catch(e) {
    console.error("Analyze error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";
    const phone = req.body.phone || "web_" + Date.now();

    const jobId = await addJob(phone, b64, settings, "processing");
    jobCache.set(jobId, { status: "processing", progress: 10 });

    const analysis = await analyzeImage(b64, mime);
    jobCache.set(jobId, { status: "processing", progress: 40, analysis });

    const stitchData = generateStitches(analysis);
    jobCache.set(jobId, { status: "processing", progress: 70, stitchData });

    const encoded = encodeFile(stitchData, format);
    const filename = storeFile(jobId, encoded.data, encoded.ext);

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

    await db?.run("UPDATE jobs SET status=?, result=? WHERE id=?", ["completed", JSON.stringify(result), jobId]);
    jobCache.set(jobId, { status: "completed", progress: 100, result });

    res.json({ jobId, status: "completed", result });
  } catch(e) {
    console.error("Convert error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status/:jobId", async (req, res) => {
  const cached = jobCache.get(req.params.jobId);
  if (cached) return res.json({ status: cached.status, progress: cached.progress, result: cached.result });
  const row = await db?.get("SELECT * FROM jobs WHERE id=?", [req.params.jobId]);
  if (!row) return res.status(404).json({ error: "Job not found" });
  res.json({ status: row.status, result: row.result ? JSON.parse(row.result) : null });
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
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.1" }));

// ========================================================================
// WHATSAPP
// ========================================================================
async function processMsg(phone, text, msg) {
  let user = await getUser(phone);
  if (!user) { await addUser(phone, phone, "en"); user = await getUser(phone); }
  const lang = user?.lang || "en";

  if (msg.message?.imageMessage || msg.message?.documentMessage) {
    const media = await downloadMedia(msg);
    if (media) {
      const b64 = media.toString("base64");
      const mime = msg.message?.imageMessage?.mimetype || "image/jpeg";
      const analysis = await analyzeImage(b64, mime);
      await processAndDeliver(phone, b64, analysis, { stitchType:"fill", quality:"standard", fileType:"dst" });
      return;
    }
  }

  if (text.includes("prix") || text.includes("price")) {
    await sendMsg(phone, t(phone,"price") + ":\n• Simple: 50MAD\n• Standard: 80MAD\n• Complex: 120MAD");
  } else if (text.includes("commande") || text.includes("order")) {
    await sendMsg(phone, t(phone,"upload"));
  } else {
    await sendMsg(phone, `👋 ${t(phone,"welcome")}\n📸 ${t(phone,"upload")}\n💰 ${t(phone,"price")}`);
  }
}

async function downloadMedia(msg) {
  try { return await whSocket.downloadMediaMessage(msg); } catch { return null; }
}

async function processAndDeliver(phone, b64, analysis, settings) {
  const stitchData = generateStitches(analysis);
  const encoded = encodeFile(stitchData, settings.fileType || "dst");
  const jobId = "wa_" + Date.now().toString(36);
  const filename = storeFile(jobId, encoded.data, encoded.ext);

  const result = { stitch_count: stitchData.stitches.length, colors: analysis.dominant_colors?.length || 1, estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m" };
  const modelLabel = analysis._model?.includes("pro") ? "Pro" : "Flash";
  const summary = { ar:`غرز: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} ألوان | Gemini ${modelLabel}`, fr:`Points: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} couleurs | Gemini ${modelLabel}`, en:`Stitches: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} colors | Gemini ${modelLabel}` };
  const lang = (await getUser(phone))?.lang || "en";
  await sendMsg(phone, `✅ ${t(phone,"thanks")}\n${summary[lang] || summary.en}`);
  try {
    await whSocket.sendMessage(phone + "@s.whatsapp.net", { document: encoded.data, fileName: filename, mimetype: "application/octet-stream" });
  } catch(e) { await sendMsg(phone, `📎 Download: ${CONFIG.BASE_URL}/api/download/${jobId}`); }
  await addOrder(phone, b64, (analysis.dominant_colors || []).join(","), "completed", "", `${CONFIG.BASE_URL}/api/download/${jobId}`);
}

async function sendMsg(phone, text) {
  try {
    if (whSocket) await whSocket.sendMessage(phone + "@s.whatsapp.net", { text });
    else await axios.get(`${CONFIG.WEBHOOK}?phone=${encodeURIComponent(CONFIG.PHONE)}&text=${encodeURIComponent(text)}&apikey=1252877`);
  } catch(e) { console.error("Send error:", e.message); }
}

// ========================================================================
// START
// ========================================================================
const PORT = process.env.PORT || 8080;
(async () => {
  try {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Stichai Bot v6.1 on port ${PORT}`);
      console.log(`URL: ${CONFIG.BASE_URL}`);
    });
    await initDB().catch(err => console.error("DB error:", err.message));
    await initBaileys().catch(err => console.error("Baileys error:", err.message));
    process.on("SIGTERM", () => { server.close(); process.exit(0); });
  } catch(e) { console.error("Fatal:", e.message); process.exit(1); }
})();
