// ============================================================
// 🧵 STICHAI EMBROIDERY BOT v4.1
// ============================================================


const { Boom } = require("@hapi/boom");
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const crypto = require("crypto");
const pino = require("pino");
const path = require("path");
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
    console.log("⚠️ No DATABASE_URL, skipping DB init");
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
  console.log("✅ Database ready");
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
    ar: `🧵 *أهلاً في Stichai!*\nبوت التطريز المغربي\n\nاختر لغتك:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    fr: `🧵 *Bienvenue sur Stichai!*\nBot broderie marocain\n\nChoisissez votre langue:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    en: `🧵 *Welcome to Stichai!*\nMoroccan embroidery bot\n\nChoose your language:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
  },
  menu: {
    ar: `📋 *القائمة*\n\n1️⃣ تحويل صورة 🖼️\n2️⃣ اشتراكي 📊\n3️⃣ الخطط 💎\n4️⃣ كود تجريبي 🎟️\n5️⃣ مساعدة ❓`,
    fr: `📋 *Menu*\n\n1️⃣ Convertir image 🖼️\n2️⃣ Mon abonnement 📊\n3️⃣ Plans 💎\n4️⃣ Code d'essai 🎟️\n5️⃣ Aide ❓`,
    en: `📋 *Menu*\n\n1️⃣ Convert image 🖼️\n2️⃣ My subscription 📊\n3️⃣ Plans 💎\n4️⃣ Trial code 🎟️\n5️⃣ Help ❓`,
  },
  plans: {
    ar: `💎 *الخطط*\n\n🟢 *الأساسي - 50 درهم/شهر*\n• ملف يومياً • DST+PES+JEF\n\n🔵 *المحترف - 350 درهم/شهر*\n• ملفات غير محدودة • أولوية\n\n1️⃣ الأساسي\n2️⃣ المحترف\n3️⃣ كود تجريبي\n0️⃣ رجوع`,
    fr: `💎 *Plans*\n\n🟢 *Basique - 50 MAD/mois*\n• 1 fichier/jour • DST+PES+JEF\n\n🔵 *Pro - 350 MAD/mois*\n• Illimité • Prioritaire\n\n1️⃣ Basique\n2️⃣ Pro\n3️⃣ Code d'essai\n0️⃣ Retour`,
    en: `💎 *Plans*\n\n🟢 *Basic - 50 MAD/month*\n• 1 file/day • DST+PES+JEF\n\n🔵 *Pro - 350 MAD/month*\n• Unlimited • Priority\n\n1️⃣ Basic\n2️⃣ Pro\n3️⃣ Trial code\n0️⃣ Back`,
  },
  askCode:      { ar:"🎟️ أرسل كودك:", fr:"🎟️ Envoyez votre code:", en:"🎟️ Send your code:" },
  codeOk:       { ar:(d,p)=>`✅ تم! ${p==="pro"?"المحترف":"الأساسي"} — ${d} يوم`, fr:(d,p)=>`✅ Activé! ${p==="pro"?"Pro":"Basique"} — ${d} jours`, en:(d,p)=>`✅ Activated! ${p==="pro"?"Pro":"Basic"} — ${d} days` },
  codeBad:      { ar:"❌ كود غير صحيح أو منتهي", fr:"❌ Code invalide ou expiré", en:"❌ Invalid or expired code" },
  codeUsed:     { ar:"⚠️ استخدمت هذا الكود من قبل", fr:"⚠️ Code déjà utilisé", en:"⚠️ Code already used" },
  askImage:     { ar:"🖼️ أرسل الصورة (PNG/JPG)", fr:"🖼️ Envoyez l'image (PNG/JPG)", en:"🖼️ Send the image (PNG/JPG)" },
  noSub:        { ar:"⚠️ لا اشتراك نشط\n1️⃣ الخطط\n2️⃣ كود تجريبي", fr:"⚠️ Pas d'abonnement\n1️⃣ Plans\n2️⃣ Code d'essai", en:"⚠️ No subscription\n1️⃣ Plans\n2️⃣ Trial code" },
  limitReached: { ar:"⛔ وصلت للحد اليومي\nأرسل *ترقية* للمحترف", fr:"⛔ Limite atteinte\nEnvoyez *upgrade* pour Pro", en:"⛔ Daily limit reached\nSend *upgrade* for Pro" },
  processing:   { ar:"⏳ جاري التحليل والمعالجة... 🎨", fr:"⏳ Analyse en cours... 🎨", en:"⏳ Analyzing your design... 🎨" },
  done:         { ar:"✅ *تم! إليك ملفاتك* 🎉", fr:"✅ *Terminé! Vos fichiers* 🎉", en:"✅ *Done! Your files* 🎉" },
  error:        { ar:"❌ خطأ. حاول مجدداً أو أرسل *مساعدة*", fr:"❌ Erreur. Réessayez ou envoyez *aide*", en:"❌ Error. Try again or send *help*" },
  help: {
    ar:`❓ *مساعدة*\n🔹 أرسل صورة للتحويل\n🔹 الأساسي: 50 درهم/شهر\n🔹 المحترف: 350 درهم/شهر\n📞 ${CONFIG.ADMIN_PHONE}\n\n0️⃣ القائمة`,
    fr:`❓ *Aide*\n🔹 Envoyez image pour convertir\n🔹 Basique: 50 MAD/mois\n🔹 Pro: 350 MAD/mois\n📞 ${CONFIG.ADMIN_PHONE}\n\n0️⃣ Menu`,
    en:`❓ *Help*\n🔹 Send image to convert\n🔹 Basic: 50 MAD/month\n🔹 Pro: 350 MAD/month\n📞 ${CONFIG.ADMIN_PHONE}\n\n0️⃣ Menu`,
  },
  payOpts: {
    ar:(l)=>`💳 *الدفع* — ${l}\n1️⃣ CashPlus\n2️⃣ CMI\n3️⃣ تحويل بنكي\n4️⃣ Stripe\n0️⃣ رجوع`,
    fr:(l)=>`💳 *Paiement* — ${l}\n1️⃣ CashPlus\n2️⃣ CMI\n3️⃣ Virement\n4️⃣ Stripe\n0️⃣ Retour`,
    en:(l)=>`💳 *Payment* — ${l}\n1️⃣ CashPlus\n2️⃣ CMI\n3️⃣ Bank Transfer\n4️⃣ Stripe\n0️⃣ Back`,
  },
  myPlan: {
    ar:(u,d)=>`📊 *اشتراكي*\n📦 ${u.plan==="pro"?"المحترف 🔵":u.plan==="basic"?"الأساسي 🟢":u.plan==="trial"?"تجريبي 🎁":"لا يوجد"}\n📅 ${d} يوم متبقي\n🧵 اليوم: ${u.files_today||0}\n📁 الإجمالي: ${u.files_total||0}`,
    fr:(u,d)=>`📊 *Abonnement*\n📦 ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basique 🟢":u.plan==="trial"?"Essai 🎁":"Aucun"}\n📅 ${d} jours restants\n🧵 Aujourd'hui: ${u.files_today||0}\n📁 Total: ${u.files_total||0}`,
    en:(u,d)=>`📊 *Subscription*\n📦 ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basic 🟢":u.plan==="trial"?"Trial 🎁":"None"}\n📅 ${d} days left\n🧵 Today: ${u.files_today||0}\n📁 Total: ${u.files_total||0}`,
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
      { contents:[{ parts:[{ inline_data:{mime_type:mime,data:b64} },{ text:`Expert embroidery digitizer. Return ONLY JSON:\n{"complexity":"simple|medium|complex","colors":["#hex"],"width_mm":80,"height_mm":80,"stitch_count":5000,"stitch_type":"satin|fill|run|mixed","description":"brief"}` }] }] },
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
  return { ar:`💵 *CashPlus*\n💰 ${amt} درهم\n🔑 *${code}*\nأرسل: *تم ${code}*`, fr:`💵 *CashPlus*\n💰 ${amt} MAD\n🔑 *${code}*\nEnvoyez: *payé ${code}*`, en:`💵 *CashPlus*\n💰 ${amt} MAD\n🔑 *${code}*\nSend: *paid ${code}*` }[lang] || `💵 CashPlus: ${amt} MAD — Code: ${code}`;
}

async function payCMI(phone, plan, lang) {
  const oid = `EMB-${Date.now()}-${phone.slice(-4)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).orderId = oid;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cmi',$4)", [cleanPhone(phone), plan, amt, oid]);
  const url = `https://payment.cmi.co.ma/fim/est3Dgate?clientid=${CONFIG.CMI_MERCHANT_ID}&amount=${amt}.00&currency=504&oid=${oid}&okUrl=${CONFIG.BASE_URL}/payment/cmi/success&callbackUrl=${CONFIG.BASE_URL}/payment/cmi/callback`;
  return { ar:`💳 *CMI*\n💰 ${amt} درهم\n${url}`, fr:`💳 *CMI*\n💰 ${amt} MAD\n${url}`, en:`💳 *CMI*\n💰 ${amt} MAD\n${url}` }[lang] || url;
}

async function payTransfer(phone, plan, lang) {
  const ref = `EMB${Date.now().toString().slice(-8)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).transferRef = ref;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'transfer',$4)", [cleanPhone(phone), plan, amt, ref]);
  return {
    ar:`🏦 *تحويل بنكي*\n🏛️ Attijariwafa Bank - كنيترة\n👤 *M OUDILI ANASS*\nRIB: *007 330 0010509000302103 43*\nSWIFT: *BCMAMAMC*\n💰 ${amt} درهم\n📝 المرجع: *${ref}*\nأرسل صورة الإيصال`,
    fr:`🏦 *Virement bancaire*\n🏛️ Attijariwafa Bank - Kénitra\n👤 *M OUDILI ANASS*\nRIB: *007 330 0010509000302103 43*\nSWIFT: *BCMAMAMC*\n💰 ${amt} MAD\n📝 Réf: *${ref}*\nEnvoyez photo du reçu`,
    en:`🏦 *Bank Transfer*\n🏛️ Attijariwafa Bank - Kenitra\n👤 *M OUDILI ANASS*\nRIB: *007 330 0010509000302103 43*\nSWIFT: *BCMAMAMC*\n💰 ${amt} MAD\n📝 Ref: *${ref}*\nSend receipt photo`,
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
  return { ar:`💳 *Stripe*\n${s.url}`, fr:`💳 *Stripe*\n${s.url}`, en:`💳 *Stripe*\n${s.url}` }[lang] || s.url;
}

// ============================================================
// BAILEYS WHATSAPP
// ============================================================
let sock = null;
let qrShown = false;
let connectionState = "disconnected";

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
  if (!fs.existsSync(CONFIG.AUTH_DIR)) fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: true,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });printQRInTerminal: true,
    browser: ["Stichai Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  // PAIRING CODE - shows 8-digit code in logs
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode("212675823517");
        console.log("\n\n========================================");
        console.log("📱 PAIRING CODE: " + code);
        console.log("========================================");
        console.log("WhatsApp → Settings → Linked Devices");
        console.log("→ Link a Device → Link with phone number");
        console.log("→ Enter this code");
        console.log("========================================\n\n");
      } catch(e) { console.error("Pairing code error:", e.message); }
    }, 3000);
  }

cd ~/stichai
nano bot.js  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("
📱 SCAN THIS QR WITH WHATSAPP:
");
      const qrcode = require("qrcode-terminal");
      qrcode.generate(qr, { small: true }, (q) => console.log(q));
    }
    if (connection === "close") {
      connectionState = "disconnected";
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) setTimeout(initBaileys, 5000);
    }
    if (connection === "open") {
      connectionState = "connected";
    }
    if (connection === "connecting") connectionState = "connecting";
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.includes("@g.us")) continue;
      try {
        await handleMessage(msg);
      } catch(e) {
        console.error("Message handler error:", e.message);
      }
    }
  });
}

// ============================================================
// PROCESS AND DELIVER
// ============================================================
async function processAndDeliver(phone, user, msg) {
  const lang = user.language || "fr";
  await sendMsg(phone, m("processing", lang));

  try {
    let b64, mime;
    const imgMsg = msg.message?.imageMessage || msg.message?.documentMessage;

    if (imgMsg) {
      const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const buffer = await downloadMediaMessage(msg, "buffer", {});
b64  = buffer.toString("base64");
      mime = imgMsg.mimetype || "image/jpeg";
    } else {
      throw new Error("No image found in message");
    }

    const analysis = await analyzeImage(b64, mime);

    let files = null;
    try {
      const r = await axios.post(`${CONFIG.BASE_URL}/generate-embroidery`, { image_b64: b64, mime_type: mime, analysis, phone }, { timeout: 60000 });
      files = r.data;
    } catch(e) {
      console.log("Python service not available:", e.message);
    }

    await recordConversion(phone, user.plan, files?.stitch_count || 0);
    await sendMsg(phone, m("done", lang));

    if (files?.dst_url) {
      await sendMsg(phone, `📁 DST (Tajima): ${files.dst_url}\n📁 PES (Brother): ${files.pes_url}`);
    }

    const modelLabel = analysis._model?.includes("lite") ? "Flash-Lite ⚡" : analysis._model?.includes("pro") ? "Pro 🎯" : "Flash ✨";
    const summary = {
      ar:`📊 الغرز: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}×${analysis.height_mm}mm | ${analysis.colors?.length||1} لون | 🤖 Gemini ${modelLabel}`,
      fr:`📊 Points: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}×${analysis.height_mm}mm | ${analysis.colors?.length||1} couleur(s) | 🤖 Gemini ${modelLabel}`,
      en:`📊 Stitches: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}×${analysis.height_mm}mm | ${analysis.colors?.length||1} color(s) | 🤖 Gemini ${modelLabel}`,
    };
    await sendMsg(phone, summary[lang]);
    sess(phone).step = "menu";
    await sendMsg(phone, m("menu", lang));

  } catch(e) {
    console.error("Deliver error:", e.message);
    await sendMsg(phone, m("error", lang));
  }
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
async function handleMessage(msg) {
  const jid   = msg.key.remoteJid;
  const phone = jid.replace("@s.whatsapp.net", "");
  const body  = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
  const hasImage = !!(msg.message?.imageMessage || msg.message?.documentMessage);

  const user = await getUser(phone);
  const lang = user.language || "fr";
  const s    = sess(phone);
  const t    = body.trim();
  const tl   = t.toLowerCase();

  if (["0","menu","قائمة","retour","back"].includes(tl)) { s.step="menu"; return sendMsg(jid, m("menu",lang)); }
  if (["help","aide","مساعدة"].includes(tl)) return sendMsg(jid, m("help",lang));
  if (["upgrade","ترقية"].includes(tl)) { s.step="plans"; return sendMsg(jid, m("plans",lang)); }

  switch(s.step) {
    case "start":
      await sendMsg(jid, MSG.welcome.fr);
      s.step = "choose_language";
      break;

    case "choose_language":
      if (["1","2","3"].includes(t)) {
        const lmap = {"1":"ar","2":"fr","3":"en"};
        await updateUser(phone, { language: lmap[t] });
        s.step = "menu";
        return sendMsg(jid, m("menu", lmap[t]));
      }
      await sendMsg(jid, MSG.welcome.fr);
      break;

    case "menu":
      if (t==="1") {
        const check = await canConvert(user);
        if (!check.ok) {
          if (check.reason==="limit") return sendMsg(jid, m("limitReached",lang));
          s.step = "no_sub";
          return sendMsg(jid, m("noSub",lang));
        }
        s.step = "waiting_image";
        return sendMsg(jid, m("askImage",lang));
      }
      if (t==="2") {
        const active = await isSubActive(user);
        if (!active) { s.step="no_sub"; return sendMsg(jid, m("noSub",lang)); }
        const days = Math.ceil((new Date(user.plan_end)-new Date())/86400000);
        return sendMsg(jid, m("myPlan",lang,user,days));
      }
      if (t==="3") { s.step="plans"; return sendMsg(jid, m("plans",lang)); }
      if (t==="4") { s.step="enter_code"; return sendMsg(jid, m("askCode",lang)); }
      if (t==="5") return sendMsg(jid, m("help",lang));
      await sendMsg(jid, m("menu",lang));
      break;

    case "no_sub":
      if (t==="1") { s.step="plans"; return sendMsg(jid, m("plans",lang)); }
      if (t==="2") { s.step="enter_code"; return sendMsg(jid, m("askCode",lang)); }
      await sendMsg(jid, m("noSub",lang));
      break;

    case "enter_code": {
      const result = await redeemCode(t, phone);
      if (result.ok) {
        s.step="menu";
        await sendMsg(jid, m("codeOk",lang,result.days,result.plan));
        return sendMsg(jid, m("menu",lang));
      }
      if (result.reason==="already_used") return sendMsg(jid, m("codeUsed",lang));
      return sendMsg(jid, m("codeBad",lang));
    }

    case "plans":
      if (t==="1") { s.selectedPlan="basic"; s.step="choose_payment"; return sendMsg(jid, m("payOpts",lang,CONFIG.PLANS.basic.label[lang])); }
      if (t==="2") { s.selectedPlan="pro";   s.step="choose_payment"; return sendMsg(jid, m("payOpts",lang,CONFIG.PLANS.pro.label[lang])); }
      if (t==="3") { s.step="enter_code"; return sendMsg(jid, m("askCode",lang)); }
      await sendMsg(jid, m("plans",lang));
      break;

    case "choose_payment": {
      const pl = s.selectedPlan;
      let reply;
      if (t==="1") { s.step="waiting_cashplus"; reply = await payCashplus(phone,pl,lang); }
      else if (t==="2") { s.step="waiting_cmi"; reply = await payCMI(phone,pl,lang); }
      else if (t==="3") { s.step="waiting_transfer"; reply = await payTransfer(phone,pl,lang); }
      else if (t==="4") { s.step="waiting_stripe"; reply = await payStripe(phone,pl,lang); }
      else reply = m("payOpts",lang,CONFIG.PLANS[pl].label[lang]);
      await sendMsg(jid, reply);
      break;
    }

    case "waiting_cashplus": {
      const code = s.paymentCode?.toString();
      if (t.includes(code) && (t.includes("تم")||t.includes("paid")||t.includes("payé"))) {
        await activatePlan(phone, s.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='cashplus' AND status='pending'", [cleanPhone(phone)]);
        s.step = "menu";
        await sendMsg(jid, m("activated",lang,CONFIG.PLANS[s.selectedPlan].label[lang]));
        return sendMsg(jid, m("menu",lang));
      }
      await sendMsg(jid, { ar:`⏳ أرسل: *تم ${s.paymentCode}*`, fr:`⏳ Envoyez: *payé ${s.paymentCode}*`, en:`⏳ Send: *paid ${s.paymentCode}*` }[lang]);
      break;
    }

    case "waiting_transfer":
      if (hasImage) {
        await activatePlan(phone, s.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='transfer' AND status='pending'", [cleanPhone(phone)]);
        s.step = "menu";
        await sendMsg(jid, m("activated",lang,CONFIG.PLANS[s.selectedPlan].label[lang]));
        return sendMsg(jid, m("menu",lang));
      }
      break;

    case "waiting_image":
      if (hasImage) {
        const freshUser = await getUser(phone);
        return processAndDeliver(jid, freshUser, msg);
      }
      await sendMsg(jid, m("askImage",lang));
      break;

    default:
      s.step = "menu";
      await sendMsg(jid, m("menu",lang));
  }
}

// ============================================================
// EXPRESS ROUTES
// ============================================================
app.post("/payment/stripe/callback", express.raw({ type:"application/json" }), async (req, res) => {
  const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], CONFIG.STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const { phone, plan } = event.data.object.metadata;
      await activatePlan(phone, plan);
      await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='stripe' AND status='pending'", [phone]);
      const user = await getUser(phone);
      await sendMsg(`${phone}@s.whatsapp.net`, m("activated", user.language||"fr", CONFIG.PLANS[plan].label[user.language||"fr"]));
      await sendMsg(`${phone}@s.whatsapp.net`, m("menu", user.language||"fr"));
    }
    res.json({ received: true });
  } catch(e) { res.status(400).send(e.message); }
});

app.post("/payment/cmi/callback", async (req, res) => {
  const { oid, Response } = req.body;
  if (Response === "Approved") {
    const r = await db.query("SELECT * FROM payments WHERE reference=$1", [oid]);
    if (r.rows.length) {
      const { phone, plan } = r.rows[0];
      await activatePlan(phone, plan);
      await db.query("UPDATE payments SET status='confirmed' WHERE reference=$1", [oid]);
      const user = await getUser(phone);
      await sendMsg(`${phone}@s.whatsapp.net`, m("activated", user.language||"fr", CONFIG.PLANS[plan].label[user.language||"fr"]));
    }
  }
  res.send("ACTION=POSTAUTH");
});

app.get("/payment/stripe/success", (_, res) =>
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">✅ Payment Successful!</h1><p>Check WhatsApp — your subscription is now active! 🧵</p></body></html>`)
);

app.get("/", (_, res) => {
  try { res.sendFile(path.join(__dirname, "index.html")); } catch { res.send("🧵 Stichai Embroidery Bot"); }
});

function adminAuth(req, res) {
  const s = req.body?.secret || req.query?.secret;
  if (s !== CONFIG.ADMIN_SECRET) { res.status(401).json({ error:"Unauthorized" }); return false; }
  return true;
}

app.post("/admin/code", async (req,res) => {
  if (!adminAuth(req,res)) return;
  const { plan="trial", days=7, maxUses=1, prefix="EMB" } = req.body;
  const code = await createCode({ plan, days, maxUses, prefix });
  res.json({ code, plan, days, maxUses });
});

app.post("/admin/codes/bulk", async (req,res) => {
  if (!adminAuth(req,res)) return;
  const { count=10, plan="trial", days=7, maxUses=1, prefix="EMB" } = req.body;
  const codes = [];
  for (let i=0; i<count; i++) codes.push(await createCode({ plan, days, maxUses, prefix }));
  res.json({ codes, count: codes.length });
});

app.post("/admin/send-code", async (req,res) => {
  if (!adminAuth(req,res)) return;
  const { phone, plan="trial", days=7 } = req.body;
  const code = await createCode({ plan, days, maxUses:1 });
  const user = await getUser(phone);
  const lang = user.language||"fr";
  const t = {
    ar:`🎁 *هدية من Stichai!*\n🎟️ *${code}*\n✨ ${days} أيام — ${plan==="pro"?"المحترف":"الأساسي"}`,
    fr:`🎁 *Cadeau de Stichai!*\n🎟️ *${code}*\n✨ ${days} jours — ${plan==="pro"?"Pro":"Basique"}`,
    en:`🎁 *Gift from Stichai!*\n🎟️ *${code}*\n✨ ${days} days — ${plan==="pro"?"Pro":"Basic"}`,
  };
  await sendMsg(`${cleanPhone(phone)}@s.whatsapp.net`, t[lang]||t.fr);
  res.json({ success:true, code, phone });
});

app.get("/admin/codes", async (req,res) => {
  if (!adminAuth(req,res)) return;
  const r = await db.query("SELECT * FROM trial_codes ORDER BY created_at DESC LIMIT 100");
  res.json(r.rows);
});

app.get("/admin/stats", async (req,res) => {
  if (!adminAuth(req,res)) return;
  const [users,revenue,conversions,codes] = await Promise.all([
    db.query(`SELECT COUNT(*) total, COUNT(CASE WHEN plan='basic' AND plan_end>NOW() THEN 1 END) basic, COUNT(CASE WHEN plan='pro' AND plan_end>NOW() THEN 1 END) pro, COUNT(CASE WHEN plan='trial' AND plan_end>NOW() THEN 1 END) trial FROM users`),
    db.query("SELECT SUM(amount_mad) total_mad, COUNT(*) total_payments FROM payments WHERE status='confirmed'"),
    db.query("SELECT COUNT(*) total, SUM(stitch_count) total_stitches FROM conversions"),
    db.query("SELECT COUNT(*) total, SUM(used_count) used FROM trial_codes WHERE active=TRUE"),
  ]);
  res.json({ users:users.rows[0], revenue:revenue.rows[0], conversions:conversions.rows[0], trial_codes:codes.rows[0] });
});

app.get("/health", (_,res) => {
  res.json({ 
    status: "ok", 
    uptime: process.uptime(), 
    version: "4.1", 
    whatsapp: connectionState,
    timestamp: new Date().toISOString()
  });
});

app.post("/generate-embroidery", async (req, res) => {
  const { analysis } = req.body;
  res.json({
    stitch_count: analysis?.stitch_count || 5000,
    dst_url: null,
    pes_url: null,
    jef_url: null,
    note: "Stub endpoint — implement actual embroidery generation"
  });
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  if (sock) {
    sock.ev.removeAllListeners();
    sock.ws?.close();
  }
  db.end().then(() => {
    console.log("Database pool closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================
// BOOT
// ============================================================
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    // Start server IMMEDIATELY
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🧵 Stichai Bot v4.1 on port ${PORT}`);
      console.log(`🌐 ${CONFIG.BASE_URL}`);
    });

    // Init DB (non-blocking)
    initDB().catch(err => {
      console.error("DB init failed:", err.message);
    });

    // Init Baileys (non-blocking)
    initBaileys().catch(err => {
      console.error("Baileys init error:", err.message);
    });

  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
})();
