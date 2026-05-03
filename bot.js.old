// ============================================================
// 🧵 STICHAI EMBROIDERY BOT v5.3 — Clean Start
// ============================================================

global.crypto = require("crypto");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const crypto = require("crypto");
const pino = require("pino");
const fs = require("fs");

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  GEMINI_API_KEY:        process.env.GEMINI_API_KEY,
  STRIPE_SECRET_KEY:     process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  CMI_MERCHANT_ID:       process.env.CMI_MERCHANT_ID,
  DATABASE_URL:          process.env.DATABASE_URL,
  ADMIN_SECRET:          process.env.ADMIN_SECRET || "change_me",
  ADMIN_PHONE:           process.env.ADMIN_PHONE  || "212675823517",
  BASE_URL:              process.env.BASE_URL      || "https://stichai.pro",
  AUTH_DIR:              process.env.AUTH_DIR || "/app/.baileys_auth",

  PLANS: {
    basic: { price_mad: 50,  price_usd: 5,  files_per_day: 1,    label: { ar: "الأساسي - 50 درهم/شهر",   fr: "Basique - 50 MAD/mois",  en: "Basic - 50 MAD/month"  } },
    pro:   { price_mad: 350, price_usd: 35, files_per_day: 9999, label: { ar: "المحترف - 350 درهم/شهر", fr: "Pro - 350 MAD/mois",      en: "Pro - 350 MAD/month"   } },
    trial: { price_mad: 0,   price_usd: 0,  files_per_day: 3,    label: { ar: "تجريبي مجاني",             fr: "Essai gratuit",           en: "Free trial"            } },
  },

  GEMINI: {
    lite:  "gemini-2.5-flash-lite-preview-06-17",
    flash: "gemini-2.5-flash",
    pro:   "gemini-2.5-pro",
  },
};

// ============================================================
// DATABASE
// ============================================================
const db = new Pool({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  if (!CONFIG.DATABASE_URL) {
    console.log("No DATABASE_URL, skipping DB init");
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone           VARCHAR(20)  PRIMARY KEY,
      language        VARCHAR(5)   DEFAULT 'fr',
      plan            VARCHAR(10)  DEFAULT NULL,
      plan_start      TIMESTAMP    DEFAULT NULL,
      plan_end        TIMESTAMP    DEFAULT NULL,
      files_today     INT          DEFAULT 0,
      files_total     INT          DEFAULT 0,
      last_file_date  DATE         DEFAULT NULL,
      created_at      TIMESTAMP    DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trial_codes (
      code        VARCHAR(20)  PRIMARY KEY,
      plan        VARCHAR(10)  DEFAULT 'trial',
      days        INT          DEFAULT 7,
      max_uses    INT          DEFAULT 1,
      used_count  INT          DEFAULT 0,
      created_at  TIMESTAMP    DEFAULT NOW(),
      expires_at  TIMESTAMP    DEFAULT NOW() + INTERVAL '30 days',
      active      BOOLEAN      DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS code_uses (
      id      SERIAL PRIMARY KEY,
      code    VARCHAR(20),
      phone   VARCHAR(20),
      used_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id         SERIAL PRIMARY KEY,
      phone      VARCHAR(20),
      plan       VARCHAR(10),
      amount_mad INT,
      method     VARCHAR(20),
      status     VARCHAR(20) DEFAULT 'pending',
      reference  VARCHAR(100),
      created_at TIMESTAMP   DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversions (
      id           SERIAL PRIMARY KEY,
      phone        VARCHAR(20),
      plan         VARCHAR(10),
      stitch_count INT,
      created_at   TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Database ready");
}

// ============================================================
// DB HELPERS
// ============================================================
function cleanPhone(phone) {
  return phone.replace(/[@:c.us\s]/g, "").replace(/^(\d+)$/, "$1");
}

async function getUser(phone) {
  const p = cleanPhone(phone);
  const r = await db.query("SELECT * FROM users WHERE phone = $1", [p]);
  if (!r.rows.length) {
    await db.query("INSERT INTO users (phone) VALUES ($1)", [p]);
    return { phone: p, language: "fr", plan: null, files_today: 0, files_total: 0 };
  }
  return r.rows[0];
}

async function updateUser(phone, fields) {
  const p = cleanPhone(phone);
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE users SET ${set} WHERE phone = $1`, [p, ...vals]);
}

async function isSubActive(user) {
  if (!user.plan || !user.plan_end) return false;
  return new Date(user.plan_end) > new Date();
}

async function canConvert(user) {
  if (!await isSubActive(user)) return { ok: false, reason: "no_sub" };
  const today = new Date().toISOString().split("T")[0];
  const last  = user.last_file_date ? new Date(user.last_file_date).toISOString().split("T")[0] : null;
  if (last !== today) { await updateUser(user.phone, { files_today: 0 }); user.files_today = 0; }
  const plan = CONFIG.PLANS[user.plan];
  if (!plan) return { ok: false, reason: "no_sub" };
  if (user.files_today >= plan.files_per_day) return { ok: false, reason: "limit" };
  return { ok: true };
}

async function activatePlan(phone, plan, months = 1) {
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  await updateUser(phone, { plan, plan_start: new Date(), plan_end: end, files_today: 0 });
}

async function recordConversion(phone, plan, stitchCount = 0) {
  const today = new Date().toISOString().split("T")[0];
  const p = cleanPhone(phone);
  await db.query(`UPDATE users SET files_today = files_today+1, files_total = files_total+1, last_file_date=$2 WHERE phone=$1`, [p, today]);
  await db.query("INSERT INTO conversions (phone,plan,stitch_count) VALUES ($1,$2,$3)", [p, plan, stitchCount]);
}

// ============================================================
// TRIAL CODES
// ============================================================
async function createCode({ plan="trial", days=7, maxUses=1, prefix="EMB" } = {}) {
  const code = `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  await db.query(
    `INSERT INTO trial_codes (code,plan,days,max_uses,expires_at) VALUES ($1,$2,$3,$4,NOW()+($3||' days')::INTERVAL)`,
    [code, plan, days, maxUses]
  );
  return code;
}

async function redeemCode(code, phone) {
  const p = cleanPhone(phone);
  const used = await db.query("SELECT id FROM code_uses WHERE code=$1 AND phone=$2", [code, p]);
  if (used.rows.length) return { ok: false, reason: "already_used" };
  const row = await db.query(
    `SELECT * FROM trial_codes WHERE code=$1 AND active=TRUE AND used_count<max_uses AND expires_at>NOW()`,
    [code.toUpperCase()]
  );
  if (!row.rows.length) return { ok: false, reason: "invalid" };
  const c = row.rows[0];
  const end = new Date();
  end.setDate(end.getDate() + c.days);
  await updateUser(p, { plan: c.plan, plan_start: new Date(), plan_end: end, files_today: 0 });
  await db.query("INSERT INTO code_uses (code,phone) VALUES ($1,$2)", [code, p]);
  await db.query("UPDATE trial_codes SET used_count=used_count+1 WHERE code=$1", [code]);
  return { ok: true, days: c.days, plan: c.plan };
}

// ============================================================
// SESSION
// ============================================================
const sessions = {};
function sess(phone) {
  const p = cleanPhone(phone);
  if (!sessions[p]) sessions[p] = { step: "start", mediaMsg: null, selectedPlan: null, paymentCode: null, orderId: null };
  return sessions[p];
}

// ============================================================
// MESSAGES
// ============================================================
const MSG = {
  welcome: {
    ar: `🧵 *أهلاً في Stichai!*
بوت التطريز المغربي

اختر لغتك:
1️⃣ العربية
2️⃣ Français
3️⃣ English`,
    fr: `🧵 *Bienvenue sur Stichai!*
Bot broderie marocain

Choisissez votre langue:
1️⃣ العربية
2️⃣ Français
3️⃣ English`,
    en: `🧵 *Welcome to Stichai!*
Moroccan embroidery bot

Choose your language:
1️⃣ العربية
2️⃣ Français
3️⃣ English`,
  },
  menu: {
    ar: `📋 *القائمة*

1️⃣ تحويل صورة 🖼️
2️⃣ اشتراكي 📊
3️⃣ الخطط 💎
4️⃣ كود تجريبي 🎟️
5️⃣ مساعدة ❓`,
    fr: `📋 *Menu*

1️⃣ Convertir image 🖼️
2️⃣ Mon abonnement 📊
3️⃣ Plans 💎
4️⃣ Code d'essai 🎟️
5️⃣ Aide ❓`,
    en: `📋 *Menu*

1️⃣ Convert image 🖼️
2️⃣ My subscription 📊
3️⃣ Plans 💎
4️⃣ Trial code 🎟️
5️⃣ Help ❓`,
  },
  plans: {
    ar: `💎 *الخطط*

🟢 *الأساسي - 50 درهم/شهر*
• ملف يومياً • DST+PES+JEF

🔵 *المحترف - 350 درهم/شهر*
• ملفات غير محدودة • أولوية

1️⃣ الأساسي
2️⃣ المحترف
3️⃣ كود تجريبي
0️⃣ رجوع`,
    fr: `💎 *Plans*

🟢 *Basique - 50 MAD/mois*
• 1 fichier/jour • DST+PES+JEF

🔵 *Pro - 350 MAD/mois*
• Illimité • Prioritaire

1️⃣ Basique
2️⃣ Pro
3️⃣ Code d'essai
0️⃣ Retour`,
    en: `💎 *Plans*

🟢 *Basic - 50 MAD/month*
• 1 file/day • DST+PES+JEF

🔵 *Pro - 350 MAD/month*
• Unlimited • Priority

1️⃣ Basic
2️⃣ Pro
3️⃣ Trial code
0️⃣ Back`,
  },
  askCode:      { ar:"🎟️ أرسل كودك:", fr:"🎟️ Envoyez votre code:", en:"🎟️ Send your code:" },
  codeOk:       { ar:(d,p)=>`✅ تم! ${p==="pro"?"المحترف":"الأساسي"} — ${d} يوم`, fr:(d,p)=>`✅ Activé! ${p==="pro"?"Pro":"Basique"} — ${d} jours`, en:(d,p)=>`✅ Activated! ${p==="pro"?"Pro":"Basic"} — ${d} days` },
  codeBad:      { ar:"❌ كود غير صحيح أو منتهي", fr:"❌ Code invalide ou expiré", en:"❌ Invalid or expired code" },
  codeUsed:     { ar:"⚠️ استخدمت هذا الكود من قبل", fr:"⚠️ Code déjà utilisé", en:"⚠️ Code already used" },
  askImage:     { ar:"🖼️ أرسل الصورة (PNG/JPG)", fr:"🖼️ Envoyez l'image (PNG/JPG)", en:"🖼️ Send the image (PNG/JPG)" },
  noSub:        { ar:"⚠️ لا اشتراك نشط
1️⃣ الخطط
2️⃣ كود تجريبي", fr:"⚠️ Pas d'abonnement
1️⃣ Plans
2️⃣ Code d'essai", en:"⚠️ No subscription
1️⃣ Plans
2️⃣ Trial code" },
  limitReached: { ar:"⛔ وصلت للحد اليومي
أرسل *ترقية* للمحترف", fr:"⛔ Limite atteinte
Envoyez *upgrade* pour Pro", en:"⛔ Daily limit reached
Send *upgrade* for Pro" },
  processing:   { ar:"⏳ جاري التحليل والمعالجة... 🎨", fr:"⏳ Analyse en cours... 🎨", en:"⏳ Analyzing your design... 🎨" },
  done:         { ar:"✅ *تم! إليك ملفاتك* 🎉", fr:"✅ *Terminé! Vos fichiers* 🎉", en:"✅ *Done! Your files* 🎉" },
  error:        { ar:"❌ خطأ. حاول مجدداً أو أرسل *مساعدة*", fr:"❌ Erreur. Réessayez ou envoyez *aide*", en:"❌ Error. Try again or send *help*" },
  help: {
    ar:`❓ *مساعدة*
🔹 أرسل صورة للتحويل
🔹 الأساسي: 50 درهم/شهر
🔹 المحترف: 350 درهم/شهر
📞 ${CONFIG.ADMIN_PHONE}

0️⃣ القائمة`,
    fr:`❓ *Aide*
🔹 Envoyez image pour convertir
🔹 Basique: 50 MAD/mois
🔹 Pro: 350 MAD/mois
📞 ${CONFIG.ADMIN_PHONE}

0️⃣ Menu`,
    en:`❓ *Help*
🔹 Send image to convert
🔹 Basic: 50 MAD/month
🔹 Pro: 350 MAD/month
📞 ${CONFIG.ADMIN_PHONE}

0️⃣ Menu`,
  },
  payOpts: {
    ar:(l)=>`💳 *الدفع* — ${l}
1️⃣ CashPlus
2️⃣ CMI
3️⃣ تحويل بنكي
4️⃣ Stripe
0️⃣ رجوع`,
    fr:(l)=>`💳 *Paiement* — ${l}
1️⃣ CashPlus
2️⃣ CMI
3️⃣ Virement
4️⃣ Stripe
0️⃣ Retour`,
    en:(l)=>`💳 *Payment* — ${l}
1️⃣ CashPlus
2️⃣ CMI
3️⃣ Bank Transfer
4️⃣ Stripe
0️⃣ Back`,
  },
  myPlan: {
    ar:(u,d)=>`📊 *اشتراكي*
📦 ${u.plan==="pro"?"المحترف 🔵":u.plan==="basic"?"الأساسي 🟢":u.plan==="trial"?"تجريبي 🎁":"لا يوجد"}
📅 ${d} يوم متبقي
🧵 اليوم: ${u.files_today||0}
📁 الإجمالي: ${u.files_total||0}`,
    fr:(u,d)=>`📊 *Abonnement*
📦 ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basique 🟢":u.plan==="trial"?"Essai 🎁":"Aucun"}
📅 ${d} jours restants
🧵 Aujourd'hui: ${u.files_today||0}
📁 Total: ${u.files_total||0}`,
    en:(u,d)=>`📊 *Subscription*
📦 ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basic 🟢":u.plan==="trial"?"Trial 🎁":"None"}
📅 ${d} days left
🧵 Today: ${u.files_today||0}
📁 Total: ${u.files_total||0}`,
  },
  activated: {
    ar:(l)=>`✅ خطتك *${l}* مفعّلة! 🎉`,
    fr:(l)=>`✅ Plan *${l}* activé! 🎉`,
    en:(l)=>`✅ Plan *${l}* activated! 🎉`,
  },
};

function m(key, lang, ...args) {
  const l = ["ar","fr","en"].includes(lang) ? lang : "fr";
  const v = MSG[key]?.[l] ?? MSG[key]?.fr;
  return typeof v === "function" ? v(...args) : (v || "");
}

// ============================================================
// GEMINI SMART ROUTING
// ============================================================
async function detectComplexity(b64, mime) {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.lite}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[{ inline_data:{mime_type:mime,data:b64} },{ text:`ONE word only: "simple", "medium", or "complex"` }] }] },
      { timeout: 10000 }
    );
    const w = r.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return w.includes("simple") ? "simple" : w.includes("complex") ? "complex" : "medium";
  } catch { return "medium"; }
}

async function analyzeImage(b64, mime) {
  try {
    const complexity = await detectComplexity(b64, mime);
    const modelKey   = complexity === "simple" ? "lite" : complexity === "complex" ? "pro" : "flash";
    const model      = CONFIG.GEMINI[modelKey];
    console.log(`🤖 ${complexity} → ${model}`);
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[{ inline_data:{mime_type:mime,data:b64} },{ text:`Expert embroidery digitizer. Return ONLY JSON:
{"complexity":"simple|medium|complex","colors":["#hex"],"width_mm":80,"height_mm":80,"stitch_count":5000,"stitch_type":"satin|fill|run|mixed","description":"brief"}` }] }] },
      { timeout: 20000 }
    );
    const result = JSON.parse(r.data.candidates[0].content.parts[0].text.replace(/```json|```/g,"").trim());
    result._model = model;
    return result;
  } catch(e) {
    console.error("Gemini:", e.message);
    return { complexity:"medium", colors:["#000000"], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", _model:CONFIG.GEMINI.flash };
  }
}

// ============================================================
// PAYMENT FLOWS
// ============================================================
async function payCashplus(phone, plan, lang) {
  const code = Math.floor(100000 + Math.random() * 900000);
  const amt  = CONFIG.PLANS[plan].price_mad;
  sess(phone).paymentCode = code;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cashplus',$4)", [cleanPhone(phone), plan, amt, String(code)]);
  return { ar:`💵 *CashPlus*
💰 ${amt} درهم
🔑 *${code}*
أرسل: *تم ${code}*`, fr:`💵 *CashPlus*
💰 ${amt} MAD
🔑 *${code}*
Envoyez: *payé ${code}*`, en:`💵 *CashPlus*
💰 ${amt} MAD
🔑 *${code}*
Send: *paid ${code}*` }[lang] || `💵 CashPlus: ${amt} MAD — Code: ${code}`;
}

async function payCMI(phone, plan, lang) {
  const oid = `EMB-${Date.now()}-${phone.slice(-4)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).orderId = oid;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cmi',$4)", [cleanPhone(phone), plan, amt, oid]);
  const url = `https://payment.cmi.co.ma/fim/est3Dgate?clientid=${CONFIG.CMI_MERCHANT_ID}&amount=${amt}.00¤cy=504&oid=${oid}&okUrl=${CONFIG.BASE_URL}/payment/cmi/success&callbackUrl=${CONFIG.BASE_URL}/payment/cmi/callback`;
  return { ar:`💳 *CMI*
💰 ${amt} درهم
${url}`, fr:`💳 *CMI*
💰 ${amt} MAD
${url}`, en:`💳 *CMI*
💰 ${amt} MAD
${url}` }[lang] || url;
}

async function payTransfer(phone, plan, lang) {
  const ref = `EMB${Date.now().toString().slice(-8)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).transferRef = ref;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'transfer',$4)", [cleanPhone(phone), plan, amt, ref]);
  return {
    ar:`🏦 *تحويل بنكي*
🏛️ Attijariwafa Bank - كنيترة
👤 *M OUDILI ANASS*
RIB: *007 330 0010509000302103 43*
SWIFT: *BCMAMAMC*
💰 ${amt} درهم
📝 المرجع: *${ref}*
أرسل صورة الإيصال`,
    fr:`🏦 *Virement bancaire*
🏛️ Attijariwafa Bank - Kénitra
👤 *M OUDILI ANASS*
RIB: *007 330 0010509000302103 43*
SWIFT: *BCMAMAMC*
💰 ${amt} MAD
📝 Réf: *${ref}*
Envoyez photo du reçu`,
    en:`🏦 *Bank Transfer*
🏛️ Attijariwafa Bank - Kenitra
👤 *M OUDILI ANASS*
RIB: *007 330 0010509000302103 43*
SWIFT: *BCMAMAMC*
💰 ${amt} MAD
📝 Ref: *${ref}*
Send receipt photo`,
  }[lang] || `Bank transfer: ${amt} MAD — Ref: ${ref}`;
}

async function payStripe(phone, plan, lang) {
  const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  const s = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price_data: { currency:"usd", product_data:{ name:`Stichai - ${CONFIG.PLANS[plan].label.en}` }, unit_amount: CONFIG.PLANS[plan].price_usd * 100 }, quantity:1 }],
    mode: "payment",
    success_url: `${CONFIG.BASE_URL}/payment/stripe/success?phone=${cleanPhone(phone)}`,
    cancel_url: `${CONFIG.BASE_URL}/payment/stripe/cancel`,
    metadata: { phone: cleanPhone(phone), plan },
  });
  return { ar:`💳 *Stripe*
${s.url}`, fr:`💳 *Stripe*
${s.url}`, en:`💳 *Stripe*
${s.url}` }[lang] || s.url;
}

// ============================================================
// BAILEYS WHATSAPP — QR CODE EDITION
// ============================================================
let sock = null;
let connectionState = "disconnected";
let qrShown = false;

async function sendMsg(jid, text) {
  if (!sock || !sock.user) {
    console.error("Cannot send message: WhatsApp not connected");
    return;
  }
  try {
    const id = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    await sock.sendMessage(id, { text });
  } catch(e) { console.error("Send error:", e.message); }
}

async function initBaileys() {
  // CLEAR CORRUPTED AUTH from previous failed attempts
  if (fs.existsSync(CONFIG.AUTH_DIR)) {
    try {
      console.log("Clearing previous auth state...");
      fs.rmSync(CONFIG.AUTH_DIR, { recursive: true, force: true });
    } catch(e) {
      console.log("Auth clear error:", e.message);
    }
  }

  if (!fs.existsSync(CONFIG.AUTH_DIR)) fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: true,
    browser: ["Stichai Bot", "Chrome", "120.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !qrShown) {
      qrShown = true;
      console.log("QR CODE AVAILABLE - Scan with WhatsApp");
    }

    if (connection === "close") {
      connectionState = "disconnected";
      qrShown = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Status:", statusCode, "Reconnect:", shouldReconnect);

      // Always reconnect unless explicitly logged out
      if (shouldReconnect || statusCode === 515 || statusCode === 411 || statusCode === 408) {
        console.log("Reconnecting in 5s...");
        setTimeout(initBaileys, 5000);
      }
    }
    if (connection === "open") {
      connectionState = "connected";
      qrShown = false;
      console.log("WhatsApp connected!");
    }
    if (connection === "connecting") {
      connectionState = "connecting";
    }
  });

// ============================================================
// WEB API ENDPOINTS (Added for Web Interface)
// ============================================================

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Store web conversion jobs
const webJobs = {};

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const settings = JSON.parse(req.body.settings || "{}");
    const phone = req.body.phone || "web_" + Date.now();

    // Create job
    const jobId = "job_" + Date.now();
    webJobs[jobId] = {
      status: "processing",
      progress: 0,
      result: null,
      error: null,
      phone: phone,
      settings: settings
    };

    // Process in background
    processWebJob(jobId, req.file, settings, phone);

    res.json({ 
      jobId: jobId, 
      status: "processing",
      message: "Conversion started. Check /api/status/" + jobId
    });

  } catch(e) {
    console.error("API convert error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status/:jobId", async (req, res) => {
  const job = webJobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

app.get("/api/download/:jobId/:format", async (req, res) => {
  const job = webJobs[req.params.jobId];
  if (!job || !job.result) {
    return res.status(404).json({ error: "File not ready" });
  }

  const format = req.params.format;
  const fileUrl = job.result[format + "_url"];

  if (!fileUrl) {
    return res.status(404).json({ error: "Format not available" });
  }

  res.redirect(fileUrl);
});

async function processWebJob(jobId, file, settings, phone) {
  try {
    const job = webJobs[jobId];

    // Convert file to base64
    const b64 = file.buffer.toString("base64");
    const mime = file.mimetype || "image/jpeg";

    job.progress = 20;

    // Analyze with Gemini
    const analysis = await analyzeImage(b64, mime);

    // Override with user settings
    if (settings.width) analysis.width_mm = parseInt(settings.width);
    if (settings.height) analysis.height_mm = parseInt(settings.height);
    if (settings.maxColors) analysis.colors = analysis.colors.slice(0, parseInt(settings.maxColors));

    job.progress = 60;

    // Generate files (placeholder - implement actual generation)
    let files = null;
    try {
      const r = await axios.post(`${CONFIG.BASE_URL}/generate-embroidery`, { 
        image_b64: b64, 
        mime_type: mime, 
        analysis, 
        phone,
        settings 
      }, { timeout: 120000 });
      files = r.data;
    } catch(e) {
      console.log("Generation service not available:", e.message);
    }

    job.progress = 90;

    // Store result
    job.result = {
      stitch_count: files?.stitch_count || analysis.stitch_count || 5000,
      colors: analysis.colors?.length || 1,
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.stitch_count || 5000) / 300) + "m"
    };

    job.status = "completed";
    job.progress = 100;

    // Send WhatsApp notification if phone provided
    if (phone && !phone.startsWith("web_")) {
      await sendMsg(phone, `Your embroidery file is ready! Stitches: ${job.result.stitch_count}. Download at: ${CONFIG.BASE_URL}/api/download/${jobId}/dst`);
    }

  } catch(e) {
    console.error("Web job error:", e.message);
    webJobs[jobId].status = "failed";
    webJobs[jobId].error = e.message;
  }
}

// Serve web app
app.get("/web", (_, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

  sock.e
