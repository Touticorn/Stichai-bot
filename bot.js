// ============================================================
// 🧵 STICHAI EMBROIDERY BOT v5.5 — Web + WhatsApp
// ASCII-safe, no special characters
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
const path = require("path");
const multer = require("multer");

const app = express();
app.use(express.json());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
    basic: { price_mad: 50,  price_usd: 5,  files_per_day: 1,    label: { ar: "Basic-50", fr: "Basique-50", en: "Basic-50" } },
    pro:   { price_mad: 350, price_usd: 35, files_per_day: 9999, label: { ar: "Pro-350", fr: "Pro-350", en: "Pro-350" } },
    trial: { price_mad: 0,   price_usd: 0,  files_per_day: 3,    label: { ar: "Trial", fr: "Essai", en: "Trial" } },
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
// MESSAGES — ALL ASCII SAFE
// ============================================================
const MSG = {
  welcome: {
    ar: "Welcome to Stichai! Choose language: 1-Arabic 2-French 3-English",
    fr: "Bienvenue sur Stichai! Choisissez: 1-Arabe 2-Francais 3-Anglais",
    en: "Welcome to Stichai! Choose: 1-Arabic 2-French 3-English",
  },
  menu: {
    ar: "Menu: 1-Convert image 2-My subscription 3-Plans 4-Trial code 5-Help",
    fr: "Menu: 1-Convertir image 2-Abonnement 3-Plans 4-Code essai 5-Aide",
    en: "Menu: 1-Convert image 2-Subscription 3-Plans 4-Trial code 5-Help",
  },
  plans: {
    ar: "Plans: 1-Basic 50MAD/month 2-Pro 350MAD/month 3-Trial code 0-Back",
    fr: "Plans: 1-Basique 50MAD/mois 2-Pro 350MAD/mois 3-Code essai 0-Retour",
    en: "Plans: 1-Basic 50MAD/month 2-Pro 350MAD/month 3-Trial code 0-Back",
  },
  askCode:      { ar: "Send your trial code:", fr: "Envoyez votre code:", en: "Send your code:" },
  codeOk:       { ar: (d,p) => `Activated! ${p} - ${d} days`, fr: (d,p) => `Active! ${p} - ${d} jours`, en: (d,p) => `Activated! ${p} - ${d} days` },
  codeBad:      { ar: "Invalid or expired code", fr: "Code invalide ou expire", en: "Invalid or expired code" },
  codeUsed:     { ar: "Code already used", fr: "Code deja utilise", en: "Code already used" },
  askImage:     { ar: "Send image PNG/JPG", fr: "Envoyez image PNG/JPG", en: "Send image PNG/JPG" },
  noSub:        { ar: "No active subscription. 1-Plans 2-Trial code", fr: "Pas d abonnement. 1-Plans 2-Code essai", en: "No subscription. 1-Plans 2-Trial code" },
  limitReached: { ar: "Daily limit reached. Send upgrade for Pro", fr: "Limite atteinte. Envoyez upgrade pour Pro", en: "Daily limit reached. Send upgrade for Pro" },
  processing:   { ar: "Processing your design...", fr: "Analyse en cours...", en: "Analyzing your design..." },
  done:         { ar: "Done! Your files are ready", fr: "Termine! Vos fichiers", en: "Done! Your files" },
  error:        { ar: "Error. Try again or send help", fr: "Erreur. Reessayez ou envoyez aide", en: "Error. Try again or send help" },
  help: {
    ar: `Help: Send image to convert. Basic: 50MAD/month. Pro: 350MAD/month. Phone: ${CONFIG.ADMIN_PHONE}`,
    fr: `Aide: Envoyez image. Basique: 50MAD/mois. Pro: 350MAD/mois. Tel: ${CONFIG.ADMIN_PHONE}`,
    en: `Help: Send image to convert. Basic: 50MAD/month. Pro: 350MAD/month. Phone: ${CONFIG.ADMIN_PHONE}`,
  },
  payOpts: {
    ar: (l) => `Payment: ${l}. 1-CashPlus 2-CMI 3-Bank transfer 4-Stripe 0-Back`,
    fr: (l) => `Paiement: ${l}. 1-CashPlus 2-CMI 3-Virement 4-Stripe 0-Retour`,
    en: (l) => `Payment: ${l}. 1-CashPlus 2-CMI 3-Bank transfer 4-Stripe 0-Back`,
  },
  myPlan: {
    ar: (u,d) => `Subscription: ${u.plan || "None"}. ${d} days left. Today: ${u.files_today||0}. Total: ${u.files_total||0}`,
    fr: (u,d) => `Abonnement: ${u.plan || "Aucun"}. ${d} jours restants. Auj: ${u.files_today||0}. Total: ${u.files_total||0}`,
    en: (u,d) => `Subscription: ${u.plan || "None"}. ${d} days left. Today: ${u.files_today||0}. Total: ${u.files_total||0}`,
  },
  activated: {
    ar: (l) => `Plan ${l} activated!`,
    fr: (l) => `Plan ${l} active!`,
    en: (l) => `Plan ${l} activated!`,
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
    console.log(`AI: ${complexity} -> ${model}`);
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents:[{ parts:[{ inline_data:{mime_type:mime,data:b64} },{ text: "Analyze this image for embroidery. Return JSON with: dominant_colors (array of hex), suggested_stitch_type (satin/fill/running), estimated_stitch_count (number), width_mm, height_mm." }] }] },
      { timeout: 80000 }
    );
    const result = JSON.parse(r.data.candidates[0].content.parts[0].text.replace(/```json|```/g,"").trim());
    result._model = model;
    return result;
  } catch(e) {
    console.error("Gemini:", e.message);
    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", _model:CONFIG.GEMINI.flash };
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
  return { ar:`CashPlus: ${amt} MAD. Code: ${code}. Send: paid ${code}`, fr:`CashPlus: ${amt} MAD. Code: ${code}. Envoyez: paye ${code}`, en:`CashPlus: ${amt} MAD. Code: ${code}. Send: paid ${code}` }[lang] || `CashPlus: ${amt} MAD - Code: ${code}`;
}

async function payCMI(phone, plan, lang) {
  const oid = `EMB-${Date.now()}-${phone.slice(-4)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).orderId = oid;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cmi',$4)", [cleanPhone(phone), plan, amt, oid]);
  const url = `https://payment.cmi.co.ma/fim/est3Dgate?clientid=${CONFIG.CMI_MERCHANT_ID}&amount=${amt}.00&currency=504&oid=${oid}&okUrl=${CONFIG.BASE_URL}/payment/cmi/success&callbackUrl=${CONFIG.BASE_URL}/payment/cmi/callback`;
  return { ar:`CMI: ${amt} MAD. ${url}`, fr:`CMI: ${amt} MAD. ${url}`, en:`CMI: ${amt} MAD. ${url}` }[lang] || url;
}

async function payTransfer(phone, plan, lang) {
  const ref = `EMB${Date.now().toString().slice(-8)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).transferRef = ref;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'transfer',$4)", [cleanPhone(phone), plan, amt, ref]);
  return {
    ar:`Bank transfer: Attijariwafa Bank Kenitra. M OUDILI ANASS. RIB: 007330001050900030210343. SWIFT: BCMAMAMC. ${amt} MAD. Ref: ${ref}. Send receipt photo`,
    fr:`Virement: Attijariwafa Bank Kenitra. M OUDILI ANASS. RIB: 007330001050900030210343. SWIFT: BCMAMAMC. ${amt} MAD. Ref: ${ref}. Envoyez photo du recu`,
    en:`Bank transfer: Attijariwafa Bank Kenitra. M OUDILI ANASS. RIB: 007330001050900030210343. SWIFT: BCMAMAMC. ${amt} MAD. Ref: ${ref}. Send receipt photo`,
  }[lang] || `Bank transfer: ${amt} MAD - Ref: ${ref}`;
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
  return { ar:`Stripe: ${s.url}`, fr:`Stripe: ${s.url}`, en:`Stripe: ${s.url}` }[lang] || s.url;
}

// ============================================================
// BAILEYS WHATSAPP
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
      const stream = await sock.downloadMediaMessage(msg, "buffer");
      b64  = stream.toString("base64");
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
      await sendMsg(phone, `DST: ${files.dst_url} PES: ${files.pes_url}`);
    }

    const modelLabel = analysis._model?.includes("pro") ? "Pro" : "Flash";
    const summary = {
      ar:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
      fr:`Points: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} couleur | Gemini ${modelLabel}`,
      en:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
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

  if (["0","menu","retour","back"].includes(tl)) { s.step="menu"; return sendMsg(jid, m("menu",lang)); }
  if (["help","aide"].includes(tl)) return sendMsg(jid, m("help",lang));
  if (["upgrade"].includes(tl)) { s.step="plans"; return sendMsg(jid, m("plans",lang)); }

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
      if (t.includes(code) && (t.includes("paid")||t.includes("paye"))) {
        await activatePlan(phone, s.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='cashplus' AND status='pending'", [cleanPhone(phone)]);
        s.step = "menu";
        await sendMsg(jid, m("activated",lang,CONFIG.PLANS[s.selectedPlan].label[lang]));
        return sendMsg(jid, m("menu",lang));
      }
      await sendMsg(jid, { ar:`Send: paid ${s.paymentCode}`, fr:`Envoyez: paye ${s.paymentCode}`, en:`Send: paid ${s.paymentCode}` }[lang]);
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

// ============================================================
// GEMINI IMAGE ANALYSIS (Secure - uses Railway env var)
// ============================================================

const webJobs = {};

app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    
    // STEP 1: Analyze the image
    const analyzeRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: "Expert embroidery digitizer. Analyze this design and return ONLY JSON: {complexity:simple|medium|complex,dominant_colors:[#hex1,#hex2],suggested_stitch_type:satin|fill|running|mixed,estimated_stitch_count:number,width_mm:80,height_mm:80,has_text:boolean,has_logo:boolean,description:brief}" }
          ]
        }]
      },
      { timeout: 30000 }
    );
    
    const text = analyzeRes.data.candidates[0].content.parts[0].text;
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
    
    // STEP 2: Generate stitch preview image
    const previewRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: `Generate an embroidery stitch preview of this design. Show how it would look stitched on fabric. Use these thread colors: ${analysis.dominant_colors?.join(', ') || 'red, gold, white'}. Return ONLY the image.` }
          ]
        }]
      },
      { timeout: 45000 }
    );
    
    // Extract generated image if available
    const parts = previewRes.data.candidates[0].content.parts;
    let previewImage = null;
    
    for (const part of parts) {
      if (part.inlineData) {
        previewImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        break;
      }
    }
    
    res.json({
      ...analysis,
      preview_image: previewImage
    });
    
  } catch(e) {
    console.error("Gemini error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api", (_, res) => {
  res.send("Stichai API v5.6 — <a href='/'>Web Interface</a> — <a href='/health'>Health</a>");
});


app.get("/health", (_,res) => {
  res.json({ 
    status: "ok", 
    uptime: process.uptime(), 
    version: "5.5", 
    whatsapp: connectionState,
    timestamp: new Date().toISOString()
  });
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
    ar:`Gift from Stichai! Code: ${code}. ${days} days - ${plan==="pro"?"Pro":"Basic"}`,
    fr:`Cadeau de Stichai! Code: ${code}. ${days} jours - ${plan==="pro"?"Pro":"Basique"}`,
    en:`Gift from Stichai! Code: ${code}. ${days} days - ${plan==="pro"?"Pro":"Basic"}`,
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
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">Payment Successful!</h1><p>Check WhatsApp - your subscription is now active!</p></body></html>`)
);

// ============================================================
// WEB API
// ============================================================

app.post("/api/convert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const settings = JSON.parse(req.body.settings || "{}");
    const phone = req.body.phone || "web_" + Date.now();
    const jobId = "job_" + Date.now();
    
    webJobs[jobId] = { status: "processing", progress: 0, result: null, error: null, phone, settings };

    processWebJob(jobId, req.file, settings, phone);

    res.json({ jobId, status: "processing", check: `/api/status/${jobId}` });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status/:jobId", (req, res) => {
  const job = webJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/api/download/:jobId/:format", (req, res) => {
  const job = webJobs[req.params.jobId];
  if (!job || !job.result) return res.status(404).json({ error: "File not ready" });
  const url = job.result[req.params.format + "_url"];
  if (!url) return res.status(404).json({ error: "Format not available" });
  res.redirect(url);
});

async function processWebJob(jobId, file, settings, phone) {
  try {
    const job = webJobs[jobId];
    const b64 = file.buffer.toString("base64");
    const mime = file.mimetype || "image/jpeg";
    
    job.progress = 20;
    const analysis = await analyzeImage(b64, mime);
    
    if (settings.width) analysis.width_mm = parseInt(settings.width);
    if (settings.height) analysis.height_mm = parseInt(settings.height);
    
    job.progress = 60;
    
    let files = null;
    try {
      const r = await axios.post(`${CONFIG.BASE_URL}/generate-embroidery`, { 
        image_b64: b64, mime_type: mime, analysis, phone, settings 
      }, { timeout: 120000 });
      files = r.data;
    } catch(e) {
      console.log("Generation service not available:", e.message);
    }
    
    job.progress = 90;
    
    job.result = {
      stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      estimated_stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ['#c41e3a', '#ffd700', '#ffffff'],
      suggested_stitch_type: analysis.suggested_stitch_type || settings.stitchType || 'fill',
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      description: analysis.description || '',
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + "m"
    };
    
    job.status = "completed";
    job.progress = 100;
    
    if (phone && !phone.startsWith("web_")) {
      await sendMsg(phone, `Your file is ready! ${job.result.stitch_count} stitches. Download: ${CONFIG.BASE_URL}/api/download/${jobId}/dst`);
    }
    
  } catch(e) {
    webJobs[jobId].status = "failed";
    webJobs[jobId].error = e.message;
  }
}

app.post("/generate-embroidery", async (req, res) => {
  const { analysis } = req.body;
  res.json({
    stitch_count: analysis?.stitch_count || 5000,
    dst_url: null,
    pes_url: null,
    jef_url: null,
    exp_url: null,
    vp3_url: null,
    note: "Stub endpoint - implement actual embroidery generation"
  });
});

// ============================================================
// BOOT
// ============================================================
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Stichai Bot v5.5 on port ${PORT}`);
      console.log(`URL: ${CONFIG.BASE_URL}`);
    });

    initDB().catch(err => {
      console.error("DB init failed:", err.message);
    });

    initBaileys().catch(err => {
      console.error("Baileys init error:", err.message);
    });

  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
})();

app.get("/api/test", async (req, res) => {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.flash}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: "hi" }] }] },
      { timeout: 10000 }
    );
    res.json({ ok: true, text: r.data.candidates[0].content.parts[0].text });
  } catch(e) {
    res.status(500).json({ 
      error: e.message, 
      status: e.response?.status,
      data: e.response?.data 
    });
  }
});
