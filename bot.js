// ========================================================================
// Stichai Bot v6.0 — Hybrid Embroidery Digitization
// Real stitch generation + binary file encoding + Canvas preview
// ========================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const express = require("express");
const axios = require("axios");
const QRCode = require("qrcode");
const NodeCache = require("node-cache");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");

// ========================================================================
// CONFIG
// ========================================================================
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

// ========================================================================
// EXPRESS + MULTER
// ========================================================================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// ========================================================================
// DB + CACHE
// ========================================================================
const msgCache = new NodeCache({ stdTTL: 300 });
const jobCache = new NodeCache({ stdTTL: 3600 });

let db = null;
let whSocket = null;

// ========================================================================
// DB HELPERS
// ========================================================================
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
  await db?.run("INSERT INTO jobs (id,phone,image,settings,status,created) VALUES (?,?,?,?,?)",
    [id,phone,image||"",JSON.stringify(settings||{}), new Date().toISOString()]);
  return id;
}

// ========================================================================
// WHATSAPP BAILEYS
// ========================================================================
async function initBaileys() {
  const authDir = "/app/.baileys_auth";
  try { fs.rmSync(authDir, { recursive: true }); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  whSocket = makeWASocket({ auth: state });

  whSocket.ev.on("creds.update", saveCreds);
  whSocket.ev.on("connection.update", ({ connection, qr }) => {
    if (qr) { qrcode.generate(qr, { small: true }); console.log("Scan QR"); }
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

// ========================================================================
// LANGUAGE
// ========================================================================
const TRANSLATIONS = {
  en: { welcome:"Welcome!", upload:"Upload image", analyze:"Analyze", stitch:"Stitch", price:"Price", order:"Order", thanks:"Thank you!" },
  fr: { welcome:"Bienvenue!", upload:"Télécharger", analyze:"Analyser", stitch:"Point", price:"Prix", order:"Commander", thanks:"Merci!" },
  ar: { welcome:"مرحباً!", upload:"رفع صورة", analyze:"تحليل", stitch:"غرزة", price:"السعر", order:"طلب", thanks:"شكراً!" }
};
function getLang(phone) { return "en"; }
function t(phone, key) { return TRANSLATIONS[getLang(phone)]?.[key] || key; }

// ========================================================================
// GEMINI HELPERS
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

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[
        { inline_data:{mime_type:mime,data:b64} },
        { text:`You are an expert embroidery digitizer. Analyze this image and output ONLY valid JSON.

CRITICAL RULES:
1. Output ONLY a JSON object. No markdown, no explanations.
2. Simplify complex images to basic geometric shapes.
3. Identify the dominant visual elements.

Required JSON structure:
{
  "complexity": "simple|medium|complex",
  "dominant_colors": ["#RRGGBB", "#RRGGBB"],
  "suggested_stitch_type": "satin|fill|running|mixed",
  "estimated_stitch_count": number,
  "width_mm": number (50-200),
  "height_mm": number (50-200),
  "has_text": boolean,
  "has_logo": boolean,
  "description": "brief description",
  "simplified_shapes": [
    {
      "type": "rect|circle|polygon|text_path|line",
      "label": "what this shape represents",
      "bounds": {"x": 0, "y": 0, "w": 100, "h": 100},
      "color": "#RRGGBB",
      "stitch_type": "fill|satin|running"
    }
  ]
}

Shape simplification rules:
- Photos → reduce to 2-5 dominant color regions
- Text → one text_path shape
- Logos → bounding shapes + outline
- Gradients/shadows → IGNORE, use flat dominant color
- Background → only include if it's a distinct design element` }
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
// STITCH ENGINE — Real coordinate generation
// ========================================================================
function generateStitches(analysis) {
  const shapes = analysis.simplified_shapes || [];
  const colors = analysis.dominant_colors || ["#c41e3a"];
  const width = (analysis.width_mm || 80) * 3;  // 3px per mm
  const height = (analysis.height_mm || 80) * 3;
  const allStitches = [];
  let currentColor = colors[0];

  // If no shapes provided, generate from dominant colors as fills
  if (shapes.length === 0) {
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

  // Process each shape
  for (const shape of shapes) {
    const color = shape.color || colors[shapes.indexOf(shape) % colors.length];
    const type = shape.stitch_type || "fill";
    const b = shape.bounds || { x: 0, y: 0, w: width, h: height };

    if (type === "fill") {
      allStitches.push(...rectFill(b.x, b.y, b.w, b.h, color));
    } else if (type === "satin") {
      allStitches.push(...satinBorder(b.x, b.y, b.w, b.h, color));
    } else if (type === "running") {
      allStitches.push(...runningOutline(b.x, b.y, b.w, b.h, color));
    }
  }

  return { stitches: allStitches, width, height, colors, scale: 3 };
}

// Rectangle fill — horizontal rows
function rectFill(x, y, w, h, color) {
  const stitches = [];
  const spacing = 2; // 0.67mm between rows
  const rows = Math.max(3, Math.floor(h / spacing));

  for (let r = 0; r < rows; r++) {
    const rowY = y + (r / rows) * h;
    stitches.push({ x, y: rowY, color, type: "jump" });
    const step = 3;
    for (let cx = x; cx <= x + w; cx += step) {
      stitches.push({ x: cx, y: rowY, color, type: "stitch" });
    }
  }
  return stitches;
}

// Satin zigzag — border between inner and outer
function satinBorder(x, y, w, h, color) {
  const stitches = [];
  const inset = 2;
  const outer = [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }
  ];
  const inner = [
    { x: x + inset, y: y + inset }, { x: x + w - inset, y: y + inset },
    { x: x + w - inset, y: y + h - inset }, { x: x + inset, y: y + h - inset },
    { x: x + inset, y: y + inset }
  ];
  const density = Math.max(10, Math.floor((w + h) * 2));
  for (let i = 0; i < density; i++) {
    const t = i / density;
    const side = Math.floor(t * 4);
    const st = (t * 4) - side;
    const p1 = outer[side];
    const p2 = outer[(side + 1) % 4];
    const ox = p1.x + (p2.x - p1.x) * st;
    const oy = p1.y + (p2.y - p1.y) * st;
    const p3 = inner[side];
    const p4 = inner[(side + 1) % 4];
    const ix = p3.x + (p4.x - p3.x) * st;
    const iy = p3.y + (p4.y - p3.y) * st;
    if (i % 2 === 0) {
      stitches.push({ x: ox, y: oy, color, type: i === 0 ? "jump" : "stitch" });
      stitches.push({ x: ix, y: iy, color, type: "stitch" });
    } else {
      stitches.push({ x: ix, y: iy, color, type: "stitch" });
      stitches.push({ x: ox, y: oy, color, type: "stitch" });
    }
  }
  return stitches;
}

// Running stitch — simple outline
function runningOutline(x, y, w, h, color) {
  const stitches = [];
  const perimeter = 2 * (w + h);
  const count = Math.max(20, Math.floor(perimeter / 2));
  const points = [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }
  ];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * 4;
    const side = Math.floor(t) % 4;
    const st = t - Math.floor(t);
    const p1 = points[side];
    const p2 = points[(side + 1) % 4];
    stitches.push({
      x: p1.x + (p2.x - p1.x) * st,
      y: p1.y + (p2.y - p1.y) * st,
      color,
      type: i === 0 ? "jump" : "stitch"
    });
  }
  return stitches;
}

// ========================================================================
// DST BINARY ENCODER — Real machine file
// ========================================================================
function encodeDST(stitchData) {
  const stitches = stitchData.stitches || [];
  const colors = stitchData.colors || ["#c41e3a"];

  // Find bounds
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const s of stitches) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }
  const stitchCount = stitches.length;
  const colorCount = colors.length;

  // Build header (512 bytes)
  const h = (label, len) => Buffer.from(label.padEnd(len, " "), "ascii");
  let header = Buffer.concat([
    h("LA:Stichai", 20),
    h("ST:" + stitchCount, 10),
    h("CO:" + colorCount, 10),
    h("+X:" + Math.abs(maxX), 10),
    h("-X:" + Math.abs(minX), 10),
    h("+Y:" + Math.abs(maxY), 10),
    h("-Y:" + Math.abs(minY), 10),
    h("AX:+", 10), h("AY:+", 10), h("MX:", 10), h("MY:", 10),
    h("PD:******", 10),
    Buffer.alloc(512 - 120) // pad to 512
  ]);

  // Stitch records (3 bytes each)
  const records = [];
  let prevX = 0, prevY = 0;
  let currentColorIdx = 0;

  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i];
    const colorIdx = colors.indexOf(s.color);

    // Color change
    if (colorIdx !== -1 && colorIdx !== currentColorIdx) {
      currentColorIdx = colorIdx;
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
    }

    // Jump or stitch
    const dx = Math.round(s.x - prevX);
    const dy = Math.round(s.y - prevY);
    prevX += dx; prevY += dy;

    // DST uses signed bytes: -121 to +121 for normal, extend with special codes for larger
    const encodeDelta = (d) => {
      if (d >= -121 && d <= 121) return [d >= 0 ? d : 256 + d, false];
      // Extended: use multiple steps (simplified — for small designs this works)
      const steps = Math.ceil(Math.abs(d) / 121);
      return [d >= 0 ? 121 : 135, true]; // 135 = -121 unsigned
    };

    const [yByte, yExt] = encodeDelta(dy);
    const [xByte, xExt] = encodeDelta(dx);
    const flags = s.type === "jump" ? 0x83 : 0x03;

    records.push(Buffer.from([yByte, xByte, flags]));
  }

  // End
  records.push(Buffer.from([0x00, 0x00, 0xF3]));

  return Buffer.concat([header, ...records]);
}

// ========================================================================
// PES/JEF/EXP/VP3 — For now: DST with extension mapped
// Real format support can be added later
// ========================================================================
function encodeFile(stitchData, format) {
  if (format === "dst") return { data: encodeDST(stitchData), ext: "dst" };
  // Other formats: return DST with mapped extension for now
  // Users can use converter software, or we add pyembroidery later
  const formatMap = { pes: "pes", jef: "jef", exp: "exp", vp3: "vp3" };
  return { data: encodeDST(stitchData), ext: formatMap[format] || "dst" };
}

// ========================================================================
// FILE SERVING
// ========================================================================
const fileStore = new Map(); // jobId -> { buffer, ext, filename }

function storeFile(jobId, buffer, ext) {
  const filename = `embroidery_${Date.now()}.${ext}`;
  fileStore.set(jobId, { buffer, ext, filename, created: Date.now() });
  // Auto-cleanup after 1 hour
  setTimeout(() => fileStore.delete(jobId), 3600000);
  return filename;
}

// ========================================================================
// API ROUTES
// ========================================================================

// 1. Image Analysis → Returns shapes + stitch data
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";

    // Step 1: Gemini analyzes and returns simplified shapes
    const analysis = await analyzeImage(b64, mime);

    // Step 2: Generate real stitch coordinates from shapes
    const stitchData = generateStitches(analysis);

    res.json({
      ...analysis,
      stitch_data: stitchData,
      preview_image: null  // No fake image — real stitch data instead
    });
  } catch(e) {
    console.error("Analyze error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 2. Convert → Generate binary file
app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    const settings = JSON.parse(req.body.settings || "{}");
    const format = settings.fileType || "dst";
    const phone = req.body.phone || "web_" + Date.now();

    // Create job
    const jobId = await addJob(phone, b64, settings, "processing");
    jobCache.set(jobId, { status: "processing", progress: 10 });

    // Analyze
    const analysis = await analyzeImage(b64, mime);
    jobCache.set(jobId, { status: "processing", progress: 40, analysis });

    // Generate stitches
    const stitchData = generateStitches(analysis);
    jobCache.set(jobId, { status: "processing", progress: 70, stitchData });

    // Encode file
    const encoded = encodeFile(stitchData, format);
    const filename = storeFile(jobId, encoded.data, encoded.ext);

    // Build result
    const result = {
      stitch_count: stitchData.stitches.length,
      estimated_stitch_count: stitchData.stitches.length,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ["#c41e3a"],
      suggested_stitch_type: analysis.suggested_stitch_type || "fill",
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
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

// 3. Job Status
app.get("/api/status/:jobId", async (req, res) => {
  const cached = jobCache.get(req.params.jobId);
  if (cached) return res.json({ status: cached.status, progress: cached.progress, result: cached.result });

  const row = await db?.get("SELECT * FROM jobs WHERE id=?", [req.params.jobId]);
  if (!row) return res.status(404).json({ error: "Job not found" });

  res.json({
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null
  });
});

// 4. File Download
app.get("/api/download/:jobId", (req, res) => {
  const file = fileStore.get(req.params.jobId);
  if (!file) return res.status(404).json({ error: "File expired" });

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
});

// 5. Gemini Test
app.get("/api/test", async (req, res) => {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: "hi" }] }] },
      { timeout: 10000 }
    );
    res.json({ ok: true, text: r.data?.candidates?.[0]?.content?.parts?.[0]?.text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. Static HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 7. Health
app.get("/health", (req, res) => res.json({ status: "ok", version: "6.0" }));

// ========================================================================
// WHATSAPP MESSAGE PROCESSING
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
  try {
    const buffer = await whSocket.downloadMediaMessage(msg);
    return buffer;
  } catch { return null; }
}

async function processAndDeliver(phone, b64, analysis, settings) {
  const stitchData = generateStitches(analysis);
  const encoded = encodeFile(stitchData, settings.fileType || "dst");
  const jobId = "wa_" + Date.now().toString(36);
  const filename = storeFile(jobId, encoded.data, encoded.ext);

  const result = {
    stitch_count: stitchData.stitches.length,
    colors: analysis.dominant_colors?.length || 1,
    estimated_time: Math.ceil(stitchData.stitches.length / 300) + "m"
  };

  const modelLabel = analysis._model?.includes("pro") ? "Pro" : "Flash";
  const summary = {
    ar:`غرز: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} ألوان | Gemini ${modelLabel}`,
    fr:`Points: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} couleurs | Gemini ${modelLabel}`,
    en:`Stitches: ~${result.stitch_count.toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${result.colors} colors | Gemini ${modelLabel}`,
  };

  const lang = (await getUser(phone))?.lang || "en";
  await sendMsg(phone, `✅ ${t(phone,"thanks")}\n${summary[lang] || summary.en}`);

  // Send file via WhatsApp
  try {
    const fileBuffer = encoded.data;
    await whSocket.sendMessage(phone + "@s.whatsapp.net", {
      document: fileBuffer,
      fileName: filename,
      mimetype: "application/octet-stream"
    });
  } catch(e) {
    console.error("File send failed:", e.message);
    await sendMsg(phone, `📎 Download: ${CONFIG.BASE_URL}/api/download/${jobId}`);
  }

  await addOrder(phone, b64, (analysis.dominant_colors || []).join(","), "completed", "", `${CONFIG.BASE_URL}/api/download/${jobId}`);
}

async function sendMsg(phone, text) {
  try {
    if (whSocket) {
      await whSocket.sendMessage(phone + "@s.whatsapp.net", { text });
    } else {
      await axios.get(`${CONFIG.WEBHOOK}?phone=${encodeURIComponent(CONFIG.PHONE)}&text=${encodeURIComponent(text)}&apikey=1252877`);
    }
  } catch(e) { console.error("Send error:", e.message); }
}

// ========================================================================
// START SERVER
// ========================================================================
const PORT = process.env.PORT || 8080;

(async () => {
  try {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Stichai Bot v6.0 on port ${PORT}`);
      console.log(`URL: ${CONFIG.BASE_URL}`);
    });

    await initDB().catch(err => { console.error("DB error:", err.message); });
    await initBaileys().catch(err => { console.error("Baileys error:", err.message); });

    process.on("SIGTERM", () => { server.close(); process.exit(0); });
  } catch(e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
