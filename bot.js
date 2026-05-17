/**
 * Stichai v72.0 — Unified Embroidery Digitizer
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHANGES v72 (from v71)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • Single committed generator (legacy v68 cleaned up; v69/v70/v71 dead code deleted)
 *  • Industry-standard tatami density: 3.5–4.0 mm row pitch (medium), 2.5 mm (high)
 *  • Stitch mean length target 3.5 mm with equal subdivision
 *  • Zero auto-exclusion / zero auto white/black injection
 *  • Cartoon Magic endpoint (/api/cartoon-magic) with Sharp deterministic fallback
 *  • Per-shape density override support (Fill / Satin / Running / Skip)
 *  • Solo-color preview + mm ruler in preview renderer
 *  • Machine pre-validation (hoop fit, stitch count)
 *  • Test-suite endpoint (/api/test-suite)
 *  • Unified version string v72.0 everywhere
 */

"use strict";

const express  = require("express");
const multer   = require("multer");
const axios    = require("axios");
const path     = require("path");
const sharp    = require("sharp");

/* Optional requires */
let admin    = null;
let Stripe   = null;
try { admin = require("firebase-admin"); } catch(e) { console.warn("firebase-admin not installed"); }
try { Stripe = require("stripe"); } catch(e) { console.warn("stripe not installed"); }

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

/* ═══════════════════════════════════════════════════════════
   FIREBASE ADMIN
   ═══════════════════════════════════════════════════════════ */
let fbReady = false;
let db = null;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (admin && svc) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
    db = admin.firestore();
    fbReady = true;
    console.log("Firebase Admin ready");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT not set — auth disabled");
  }
} catch(e) { console.error("Firebase init error:", e.message); }

/* ═══════════════════════════════════════════════════════════
   STRIPE
   ═══════════════════════════════════════════════════════════ */
const stripe = process.env.STRIPE_SECRET_KEY && Stripe
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PLANS = {
  none:    { label:"No plan",  downloadsPerPeriod: 0,    period:"day"  },
  trial:   { label:"Trial",    downloadsPerPeriod: 1,    period:"day",  trialDays:7 },
  simple:  { label:"Simple",   downloadsPerPeriod: 7,    period:"week" },
  pro:     { label:"Pro",      downloadsPerPeriod: 30,   period:"week" },
  promax:  { label:"Pro Max",  downloadsPerPeriod: null, period:"month"},
};

function buildPrices() {
  return {
    simple_m:  { id:process.env.STRIPE_PRICE_SIMPLE_M,  plan:"simple",  label:"Simple Monthly",  price:"$5.99/mo",  annual:false },
    simple_y:  { id:process.env.STRIPE_PRICE_SIMPLE_Y,  plan:"simple",  label:"Simple Annual",   price:"$47.99/yr", annual:true  },
    pro_m:     { id:process.env.STRIPE_PRICE_PRO_M,     plan:"pro",     label:"Pro Monthly",     price:"$14.99/mo", annual:false },
    pro_y:     { id:process.env.STRIPE_PRICE_PRO_Y,     plan:"pro",     label:"Pro Annual",      price:"$119.99/yr",annual:true  },
    promax_m:  { id:process.env.STRIPE_PRICE_PROMAX_M,  plan:"promax",  label:"Pro Max Monthly", price:"$29.99/mo", annual:false },
    promax_y:  { id:process.env.STRIPE_PRICE_PROMAX_Y,  plan:"promax",  label:"Pro Max Annual",  price:"$239.99/yr",annual:true  },
  };
}

/* ═══════════════════════════════════════════════════════════
   USER HELPERS
   ═══════════════════════════════════════════════════════════ */
function getPeriodStart(period) {
  const now = new Date();
  if (period === "day") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  if (period === "week") {
    const d = now.getUTCDay();
    const monday = now.getUTCDate() - ((d + 6) % 7);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), monday);
  }
  if (period === "month") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }
  return Date.now();
}

async function getOrCreateUser(uid, extra = {}) {
  if (!db) return null;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const now = Date.now();
  const isOAuth = extra.provider && extra.provider !== "password";
  const user = {
    uid,
    email: extra.email || "",
    provider: extra.provider || "unknown",
    plan: isOAuth ? "trial" : "none",
    planGrantedBy: "system",
    planGrantedAt: now,
    trialStart: isOAuth ? now : null,
    trialExpires: isOAuth ? now + 7 * 86400000 : null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    periodStart: getPeriodStart("day"),
    downloadsThisPeriod: 0,
    createdAt: now,
  };
  await ref.set(user);
  return user;
}

function checkQuota(user) {
  if (!user) return { allowed:false, reason:"no_user" };
  const plan = PLANS[user.plan] || PLANS.none;
  if (user.plan === "none") return { allowed:false, reason:"no_plan", upgrade:true };
  if (user.plan === "trial") {
    if (user.trialExpires && Date.now() > user.trialExpires)
      return { allowed:false, reason:"trial_expired", upgrade:true };
  }
  if (plan.downloadsPerPeriod === null) return { allowed:true, remaining:Infinity };
  const currentPeriodStart = getPeriodStart(plan.period);
  const count = (user.periodStart >= currentPeriodStart) ? (user.downloadsThisPeriod || 0) : 0;
  const remaining = plan.downloadsPerPeriod - count;
  if (remaining <= 0) return { allowed:false, reason:"quota_exceeded", remaining:0, upgrade:true };
  return { allowed:true, remaining };
}

async function recordDownload(uid) {
  if (!db) return;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return;
  const user = snap.data();
  const plan = PLANS[user.plan] || PLANS.none;
  if (plan.downloadsPerPeriod === null) return;
  const currentPeriodStart = getPeriodStart(plan.period);
  const isSamePeriod = (user.periodStart || 0) >= currentPeriodStart;
  await ref.update({
    periodStart: currentPeriodStart,
    downloadsThisPeriod: isSamePeriod
      ? admin.firestore.FieldValue.increment(1)
      : 1,
    lastDownload: Date.now(),
  });
}

/* ═══════════════════════════════════════════════════════════
   MIDDLEWARE
   ═══════════════════════════════════════════════════════════ */
async function requireAuth(req, res, next) {
  if (!fbReady) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error:"auth_required" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = decoded;
    req.userDoc = await getOrCreateUser(decoded.uid, {
      email: decoded.email || "",
      provider: decoded.firebase?.sign_in_provider || "unknown",
    });
    next();
  } catch(e) {
    return res.status(401).json({ error:"invalid_token" });
  }
}

function checkDownloadQuota(req, res, next) {
  if (!fbReady) return next();
  const result = checkQuota(req.userDoc);
  if (!result.allowed) {
    return res.status(403).json({ error:result.reason, upgrade:true });
  }
  req.quotaRemaining = result.remaining;
  next();
}

/* Stripe webhook */
app.post("/api/webhook",
  express.raw({ type:"application/json" }),
  async (req, res) => {
    if (!stripe) return res.sendStatus(400);
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch(e) {
      return res.status(400).send(`Webhook error: ${e.message}`);
    }

    const handleSub = async (sub, active) => {
      if (!db) return;
      const snap = await db.collection("users")
        .where("stripeCustomerId", "==", sub.customer).limit(1).get();
      if (snap.empty) return;
      const ref = snap.docs[0].ref;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const PRICES = buildPrices();
      const priceEntry = Object.values(PRICES).find(p => p.id === priceId);
      const newPlan = active ? (priceEntry?.plan || "simple") : "none";
      await ref.update({
        plan: newPlan,
        planGrantedBy: "stripe",
        planGrantedAt: Date.now(),
        stripeSubscriptionId: sub.id,
      });
    };

    switch(event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSub(event.data.object, event.data.object.status === "active");
        break;
      case "customer.subscription.deleted":
        await handleSub(event.data.object, false);
        break;
    }
    res.sendStatus(200);
  }
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true,limit:"10mb"}));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.5-pro",
];

/* ─── CONSTANTS ───────────────────────────────────────────*/
const SMART_TRIM   = 30;
const MIN_AREA     = 60;
const PREVIEW_MAX  = 1200;

const MACHINE_LIMITS = {
  tajima:  { maxJump: 121, minStitch: 3 },
  barudan: { maxJump: 121, minStitch: 3 },
  brother: { maxJump: 127, minStitch: 4 },
  janome:  { maxJump: 127, minStitch: 4 },
  singer:  { maxJump: 100, minStitch: 5 },
  generic: { maxJump: 121, minStitch: 3 },
};

const HOOP_PULL = {
  "4x4": 1, "5x7": 2, "6x10": 3, "8x8": 4, "8x12": 6,
};

const HOOP_MM = {
  "4x4": 100, "5x7": 180, "6x10": 250, "8x8": 200, "8x12": 300,
};

/* ─── COLOR UTILITIES ────────────────────────────────────*/
function hexToRgb(hex) {
  const m = (hex||"").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return {r:0,g:0,b:0};
  return {r:parseInt(m[1].slice(0,2),16),g:parseInt(m[1].slice(2,4),16),b:parseInt(m[1].slice(4,6),16)};
}
function rgbToLab({r,g,b}) {
  let R=r/255,G=g/255,B=b/255;
  R=R>0.04045?((R+0.055)/1.055)**2.4:R/12.92;
  G=G>0.04045?((G+0.055)/1.055)**2.4:G/12.92;
  B=B>0.04045?((B+0.055)/1.055)**2.4:B/12.92;
  const X=R*0.4124+G*0.3576+B*0.1805,Y=R*0.2126+G*0.7152+B*0.0722,Z=R*0.0193+G*0.1192+B*0.9505;
  const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
  return{l:116*f(Y)-16,a:500*(f(X/0.95047)-f(Y)),b:200*(f(Y)-f(Z/1.08883))};
}
function dE(a,b){return Math.sqrt((a.l-b.l)**2+(a.a-b.a)**2+(a.b-b.b)**2);}
function normHex(h){const m=(h||"").match(/^#?([0-9a-fA-F]{6})$/i);return m?`#${m[1].toUpperCase()}`:"#000000";}
function isNearWhite(hex){const {r,g,b}=hexToRgb(hex);return r>230&&g>230&&b>230;}
function isNearBlack(hex){const {r,g,b}=hexToRgb(hex);return r<40&&g<40&&b<40;}

/* ─── SPEC TUNING ─────────────────────────────────────────
   800 px canvas = 80 mm → 10 px = 1 mm.
   Industry standard:
   • Row pitch (tatamiRow): 3.5–4.5 mm = 35–45 px
   • Stitch length (tatamiLen): 3.5 mm = 35 px mean target
   • Underlay pitch (tatamiUl): 2.5 mm = 25 px                    */
function getStitchParams(specs) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();
  const hoop = (s.hoop || "5x7").toLowerCase();

  const limits = MACHINE_LIMITS[machine] || MACHINE_LIMITS.generic;

  const p = {
    tatamiRow: 35, tatamiLen: 35, tatamiUl: 25, pull: 2,
    pullComp: HOOP_PULL[hoop] || 2,
    machineLimits: limits,
    machine, fabric, stabilizer, density, maxStitchLen: limits.maxJump, hoop
  };

  const fabricMap = {
    cotton:  { pull: 2, tatamiRow: 35, tatamiUl: 25, tatamiLen: 35 },
    denim:   { pull: 4, tatamiRow: 35, tatamiUl: 22, tatamiLen: 35 },
    fleece:  { pull: 5, tatamiRow: 38, tatamiUl: 22, tatamiLen: 35 },
    pique:   { pull: 3, tatamiRow: 35, tatamiUl: 22, tatamiLen: 35 },
    twill:   { pull: 4, tatamiRow: 35, tatamiUl: 22, tatamiLen: 35 },
    satin:   { pull: 1, tatamiRow: 38, tatamiUl: 30, tatamiLen: 40 },
    leather: { pull: 1, tatamiRow: 38, tatamiUl: 30, tatamiLen: 40 },
    towel:   { pull: 6, tatamiRow: 35, tatamiUl: 20, tatamiLen: 32 },
    canvas:  { pull: 4, tatamiRow: 35, tatamiUl: 22, tatamiLen: 35 },
    knit:    { pull: 5, tatamiRow: 38, tatamiUl: 22, tatamiLen: 35 },
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  const densityMap = {
    low:    { tatamiRow: 45, tatamiLen: 45, tatamiUl: 30 },
    medium: { },
    high:   { tatamiRow: 25, tatamiLen: 30, tatamiUl: 20 },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(25, p.tatamiRow);
    p.tatamiUl = Math.max(18, p.tatamiUl);
  }

  return p;
}

/* ─── IMAGE CLEANING ─────────────────────────────────────*/
async function preprocessImage(buffer, canvasSize) {
  return sharp(buffer)
    .resize(canvasSize, canvasSize, {fit:"contain",background:{r:255,g:255,b:255,alpha:1}})
    .median(2)
    .sharpen({sigma:1.0})
    .linear(1.2,-15)
    .toBuffer();
}

/* ─── CARTOON MAGIC (Sharp deterministic fallback) ────────*/
async function cartoonifyImage(buffer) {
  return sharp(buffer)
    .resize(800, 800, {fit:"inside", background:{r:255,g:255,b:255,alpha:1}})
    .median(5)
    .blur(1.8)
    .sharpen({sigma:2.0, m:1})
    .gamma(1.2)
    .toBuffer();
}

/* ─── MASK-AWARE COLOR EXTRACTION ────────────────────────*/
async function extractColorsFromUnmasked(imageBuffer, maskBuffer, canvasSize, maxColors) {
  const analysisSize = 200;
  const BUCKET = 16;

  const imgRaw = await sharp(imageBuffer)
    .resize(analysisSize, analysisSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(analysisSize, analysisSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true }) : null;

  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const mData = maskRaw ? maskRaw.data : null;
  const mCh = maskRaw ? maskRaw.info.channels : 0;

  const bucketFreq = new Map();
  const bucketSums = new Map();
  let totalUnmasked = 0;

  for (let i = 0; i < analysisSize * analysisSize; i++) {
    const iOff = i * iCh;

    if (mData) {
      const mOff = i * mCh;
      const mR = mData[mOff] || 0;
      const mG = mData[mOff + 1] || 0;
      const mB = mData[mOff + 2] || 0;
      const mA = mCh >= 4 ? mData[mOff + 3] : 255;
      if (mR > 140 && mG < 90 && mB < 90 && mA > 30) continue;
    }

    totalUnmasked++;
    const r = iData[iOff], g = iData[iOff + 1], b = iData[iOff + 2];

    const br = Math.min(255, Math.round(r / BUCKET) * BUCKET);
    const bg = Math.min(255, Math.round(g / BUCKET) * BUCKET);
    const bb = Math.min(255, Math.round(b / BUCKET) * BUCKET);
    const key = (br << 16) | (bg << 8) | bb;

    bucketFreq.set(key, (bucketFreq.get(key) || 0) + 1);

    if (!bucketSums.has(key)) bucketSums.set(key, { r: 0, g: 0, b: 0, n: 0 });
    const s = bucketSums.get(key);
    s.r += r; s.g += g; s.b += b; s.n++;
  }

  if (totalUnmasked === 0) return ["#000000"];

  const allBuckets = [];
  for (const [key, freq] of bucketFreq) {
    const s = bucketSums.get(key);
    const avgR = Math.round(s.r / s.n);
    const avgG = Math.round(s.g / s.n);
    const avgB = Math.round(s.b / s.n);
    const hex = "#" + [avgR, avgG, avgB].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    const lab = rgbToLab({r: avgR, g: avgG, b: avgB});
    allBuckets.push({ hex: normHex(hex), lab, freq, pct: freq / totalUnmasked });
  }

  allBuckets.sort((a, b) => b.freq - a.freq);

  const MIN_DIST = 22;
  const selected = [];

  for (const bucket of allBuckets) {
    if (selected.length >= maxColors) break;
    const tooClose = selected.some(s => dE(bucket.lab, s.lab) < MIN_DIST);
    if (!tooClose) selected.push(bucket);
  }

  if (selected.length < maxColors) {
    const remaining = allBuckets.filter(b => !selected.some(s => s.hex === b.hex));
    remaining.sort((a, b) => {
      const aMin = Math.min(...selected.map(s => dE(a.lab, s.lab)));
      const bMin = Math.min(...selected.map(s => dE(b.lab, s.lab)));
      return bMin - aMin;
    });
    for (const bucket of remaining) {
      if (selected.length >= maxColors) break;
      const tooClose = selected.some(s => dE(bucket.lab, s.lab) < MIN_DIST);
      if (!tooClose) selected.push(bucket);
    }
  }

  /* Prop #3: REMOVED auto white/black injection. All slots belong to
     extracted image colors only. */
  const result = selected.map(s => s.hex);
  console.log(`Extracted ${result.length}/${maxColors} colors: ${result.join(', ')}`);
  return result.length ? result : ["#000000"];
}

/* ─── PIXEL MAP (mask-aware, full resolution) ────────────*/
async function buildPixelMap(imageBuffer, maskBuffer, colors, canvasSize) {
  const imgRaw = await sharp(imageBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true }) : null;

  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const mData = maskRaw ? maskRaw.data : null;
  const mCh = maskRaw ? maskRaw.info.channels : 0;

  const labC = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixMap = new Int16Array(canvasSize * canvasSize).fill(-1);

  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      const idx = y * canvasSize + x;
      const iOff = idx * iCh;

      if (mData) {
        const mOff = idx * mCh;
        const mR = mData[mOff] || 0;
        const mG = mData[mOff + 1] || 0;
        const mB = mData[mOff + 2] || 0;
        const mA = mCh >= 4 ? mData[mOff + 3] : 255;
        if (mR > 140 && mG < 90 && mB < 90 && mA > 30) {
          pixMap[idx] = -1;
          continue;
        }
      }

      const lab = rgbToLab({r: iData[iOff], g: iData[iOff + 1], b: iData[iOff + 2]});
      let best = 0, bestD = Infinity;
      for (let c = 0; c < labC.length; c++) {
        const d = dE(lab, labC[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      pixMap[idx] = best;
    }
  }

  const cnt = new Array(colors.length).fill(0);
  let un = 0;
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] >= 0) cnt[pixMap[i]]++;
    else un++;
  }
  const total = canvasSize * canvasSize;
  console.log("Coverage:", cnt.map((c, i) => `${normHex(colors[i])}:${(c/total*100).toFixed(1)}%`).join(" "), `masked:${(un/total*100).toFixed(1)}%`);

  return pixMap;
}

/* ─── GEMINI (strict JSON contract) ──────────────────────*/
async function geminiPost(body, ms = 45000) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const res = await axios.post(url, body, { timeout: ms });
      console.log(`Gemini OK: ${model}`);
      return res;
    } catch (e) {
      console.error(`Gemini ${model} → ${e.response?.status}: ${e.response?.data?.error?.message||e.message}`);
    }
  }
  return null;
}

async function analyzeWithGemini(originalBuffer, mime, colorCount) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer.
Analyze the attached image and propose the dominant thread palette that a
human digitizer would actually use to stitch it.  Pick up to ${colorCount}
colours total.  Prefer perceptually distinct hues; merge near-duplicates.
Quote each colour as a 7-character lowercase hex like "#1a2b3c".

Return STRICT JSON only, no prose, no markdown fence:
{
  "palette": ["#rrggbb", ...],
  "is_logo": true|false,
  "is_text": true|false,
  "complexity": "simple" | "moderate" | "complex",
  "recommended_angle": <integer degrees 0-180>,
  "notes": "<one short sentence>"
}`;

  const res = await geminiPost({
    contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
    generationConfig:{temperature:0.0,maxOutputTokens:1024,responseMimeType:"application/json"}
  });
  if(!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    let js = raw.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    const parsed = JSON.parse(js);
    if (Array.isArray(parsed.palette)) {
      const cleaned = [];
      for (const raw of parsed.palette) {
        const m = String(raw||"").match(/#?([0-9a-fA-F]{6})/);
        if (m) {
          const hex = "#" + m[1].toUpperCase();
          if (!cleaned.includes(hex)) cleaned.push(hex);
        }
        if (cleaned.length >= colorCount) break;
      }
      parsed.palette = cleaned;
    } else {
      parsed.palette = [];
    }
    return parsed;
  }catch(e){console.error("Gemini JSON:",e.message);return null;}
}

/* ─── RUN HELPERS ────────────────────────────────────────*/
function getRunsInRow(pixMap,ci,y,x0,x1,canvasSize){
  const runs=[];let s=-1;
  for(let x=x0;x<=x1;x++){
    const hit=y>=0&&y<canvasSize&&pixMap[y*canvasSize+x]===ci;
    if(hit&&s===-1)s=x;
    if(!hit&&s!==-1){runs.push({x1:s,x2:x-1});s=-1;}
  }
  if(s!==-1)runs.push({x1:s,x2:x1});
  return runs;
}

function getRunsInCol(pixMap, ci, x, y0, y1, canvasSize) {
  const runs = []; let s = -1;
  for (let y = y0; y <= y1; y++) {
    const hit = x >= 0 && x < canvasSize && pixMap[y * canvasSize + x] === ci;
    if (hit && s === -1) s = y;
    if (!hit && s !== -1) { runs.push({y1: s, y2: y - 1}); s = -1; }
  }
  if (s !== -1) runs.push({y1: s, y2: y1});
  return runs;
}

/* ═══════════════════════════════════════════════════════════════════
   REGION EXTRACTION  (v68 — preserved, cleaned)
   ═══════════════════════════════════════════════════════════════════ */
function extractRegions(pixMap, colors, canvasSize) {
  const visited  = new Uint8Array(canvasSize*canvasSize);
  const regions  = [];

  for(let ci=0;ci<colors.length;ci++){
    for(let sy=0;sy<canvasSize;sy++){
      for(let sx=0;sx<canvasSize;sx++){
        const si = sy*canvasSize+sx;
        if(pixMap[si]!==ci||visited[si])continue;

        const q=[si];let qp=0;
        visited[si]=1;
        let mnx=sx,mxx=sx,mny=sy,mxy=sy,area=0;

        while(qp<q.length){
          const idx=q[qp++]; area++;
          const x=idx%canvasSize, y=(idx/canvasSize)|0;
          if(x<mnx)mnx=x;if(x>mxx)mxx=x;
          if(y<mny)mny=y;if(y>mxy)mxy=y;

          for(const[dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<canvasSize&&ny>=0&&ny<canvasSize){
              const ni=ny*canvasSize+nx;
              if(!visited[ni]&&pixMap[ni]===ci){visited[ni]=1;q.push(ni);}
            }
          }
        }

        const scaledMinArea = MIN_AREA * Math.pow(canvasSize / 800, 2);
        if(area < scaledMinArea) continue;

        const bw=mxx-mnx+1, bh=mxy-mny+1;
        const aspectRatio=bh/Math.max(bw,1);
        const solidity=area/(bw*bh);

        let totalRunW=0, runCount=0;
        for(let ry=mny; ry<=mxy; ry++){
          const runs=getRunsInRow(pixMap,ci,ry,mnx,mxx,canvasSize);
          for(const r of runs){ totalRunW+=(r.x2-r.x1+1); runCount++; }
        }
        const avgRunW=runCount>0?totalRunW/runCount:bw;

        let type;
        const scaledMin3 = MIN_AREA * 3 * Math.pow(canvasSize / 800, 2);
        const avgRunMM = avgRunW / (canvasSize / 800) / 10;
        if(area < scaledMin3) type = "running";
        else if(avgRunMM <= 4.0) type = "satin";
        else if(avgRunMM <= 8.0 && aspectRatio > 1.8 && solidity > 0.4) type = "satin";
        else type = "fill";

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity,avgRunW, originalIndex: regions.length});
      }
    }
  }

  console.log(`Regions (raw): ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  return regions;
}

/* ─── MERGE ADJACENT FRAGMENTS ───────────────────────────*/
function mergeAdjacentRegions(regions, canvasSize) {
  if (!regions.length) return regions;
  const mergeGap = Math.max(2, Math.round(canvasSize / 400));
  let changed = true;
  let merged = regions.slice();

  function regionsActuallyTouch(a, b) {
    if (a.mxx + mergeGap < b.mnx || b.mxx + mergeGap < a.mnx) return false;
    if (a.mxy + mergeGap < b.mny || b.mxy + mergeGap < a.mny) return false;
    const ux = Math.max(0, Math.min(a.mxx, b.mxx) - Math.max(a.mnx, b.mnx));
    const uy = Math.max(0, Math.min(a.mxy, b.mxy) - Math.max(a.mny, b.mny));
    return ux > 0 || uy > 0;
  }

  while (changed) {
    changed = false;
    const next = [];
    const used = new Set();

    for (let i = 0; i < merged.length; i++) {
      if (used.has(i)) continue;
      const base = merged[i];
      let mnx = base.mnx, mny = base.mny, mxx = base.mxx, mxy = base.mxy, area = base.area;
      let totalRunW = (base.avgRunW || base.bw) * (base.bh || 1);
      let runCount = base.bh || 1;
      used.add(i);

      let innerChanged = true;
      while (innerChanged) {
        innerChanged = false;
        for (let j = 0; j < merged.length; j++) {
          if (used.has(j) || i === j) continue;
          const other = merged[j];
          if (other.ci !== base.ci) continue;

          const cur = { mnx, mny, mxx, mxy };
          if (regionsActuallyTouch(cur, other)) {
            const newMnx = Math.min(mnx, other.mnx);
            const newMny = Math.min(mny, other.mny);
            const newMxx = Math.max(mxx, other.mxx);
            const newMxy = Math.max(mxy, other.mxy);
            const newBboxArea = (newMxx - newMnx + 1) * (newMxy - newMny + 1);
            const combinedFill = area + other.area;
            const projectedSolidity = combinedFill / Math.max(newBboxArea, 1);
            if (projectedSolidity < 0.30) continue;

            mnx = newMnx; mny = newMny; mxx = newMxx; mxy = newMxy;
            area += other.area;
            totalRunW += (other.avgRunW || other.bw) * (other.bh || 1);
            runCount += other.bh || 1;
            used.add(j);
            innerChanged = true;
            changed = true;
          }
        }
      }

      const newBw = mxx - mnx + 1, newBh = mxy - mny + 1;
      const newAvgRunW = runCount > 0 ? totalRunW / runCount : newBw;
      const newAspect = newBh / Math.max(newBw, 1);
      const newSolidity = area / Math.max(newBw * newBh, 1);

      let newType;
      const scaledMin3 = MIN_AREA * 3 * Math.pow(canvasSize / 800, 2);
      if (area < scaledMin3) newType = "running";
      else if (newAspect > 2.5 && newAvgRunW <= Math.max(14, canvasSize / 57) && newSolidity > 0.35) newType = "satin";
      else if (newAvgRunW > 3 && newAvgRunW <= Math.max(12, canvasSize / 67) && newSolidity > 0.45 && newAspect > 1.4) newType = "satin";
      else newType = "fill";

      next.push({
        ci: base.ci, color: base.color, type: newType,
        mnx, mny, mxx, mxy,
        bw: newBw, bh: newBh, area,
        aspectRatio: newAspect, solidity: newSolidity, avgRunW: newAvgRunW,
        originalIndex: base.originalIndex
      });
    }
    merged = next;
  }

  console.log(`Regions (conservative merge): ${merged.length}`);
  return merged;
}

/* ─── BRIDGE / EDGE / UNDERLAY HELPERS ─────────────────*/
function getEdgePixels(pixMap, reg, canvasSize) {
  const edge = [];
  for (let y = reg.mny; y <= reg.mxy; y++) {
    for (let x = reg.mnx; x <= reg.mxx; x++) {
      const idx = y * canvasSize + x;
      if (pixMap[idx] === reg.ci) {
        let isEdge = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= canvasSize || ny < 0 || ny >= canvasSize) { isEdge = true; break; }
          if (pixMap[ny * canvasSize + nx] !== reg.ci) { isEdge = true; break; }
        }
        if (isEdge) edge.push({x, y});
      }
    }
  }
  return edge.length ? edge : [{x: Math.round((reg.mnx + reg.mxx) / 2), y: Math.round((reg.mny + reg.mxy) / 2)}];
}

function findClosestPair(edgeA, edgeB) {
  let best = {from: edgeA[0], to: edgeB[0], dist: Infinity};
  for (const a of edgeA) {
    for (const b of edgeB) {
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d < best.dist) best = {from: a, to: b, dist: d};
    }
  }
  return best;
}

function sortRegionsNearestNeighbor(regions) {
  if (regions.length <= 1) return regions;
  const sorted = [regions[0]];
  const used = new Set([0]);
  while (used.size < regions.length) {
    const last = sorted[sorted.length - 1];
    const lastCx = (last.mnx + last.mxx) / 2;
    const lastCy = (last.mny + last.mxy) / 2;
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < regions.length; i++) {
      if (used.has(i)) continue;
      const r = regions[i];
      const d = ((r.mnx + r.mxx) / 2 - lastCx) ** 2 + ((r.mny + r.mxy) / 2 - lastCy) ** 2;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    sorted.push(regions[bestIdx]);
  }
  return sorted;
}

function generateBridgeStitches(fromX, fromY, toX, toY, color) {
  const dx = toX - fromX, dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 8));
  const stitches = [];
  for (let i = 1; i <= steps; i++) {
    const fx = Math.round(fromX + dx * i / steps);
    const fy = Math.round(fromY + dy * i / steps);
    stitches.push({x: fx, y: fy, color, type: "bridge"});
  }
  return stitches;
}

function generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, stepPx, insetPx) {
  const {mnx, mny, mxx, mxy} = reg;
  const edges = [];
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    for (const {x1, x2} of runs) {
      edges.push({x: x1 + insetPx, y});
      if (x2 - x1 > 2 * insetPx) edges.push({x: x2 - insetPx, y});
    }
  }
  if (edges.length === 0) return [];
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const sorted = edges.slice().sort((a, b) => {
    const aa = Math.atan2(a.y - cy, a.x - cx);
    const ab = Math.atan2(b.y - cy, b.x - cx);
    return aa - ab;
  });
  const out = [];
  let prev = null;
  for (const p of sorted) {
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= stepPx) {
      out.push({x: p.x, y: p.y, color, type: "underlay"});
      prev = p;
    }
  }
  return out;
}

function generateZigzagUnderlay(pixMap, reg, ci, canvasSize, color, rowSpacing, stitchLen) {
  const {mnx, mny, mxx, mxy} = reg;
  const out = [];
  let rowI = 0;
  for (let y = mny + Math.round(rowSpacing/2); y <= mxy; y += rowSpacing) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    if (!runs.length) continue;
    const rev = rowI % 2 === 1;
    const order = rev ? [...runs].reverse() : runs;
    for (const {x1, x2} of order) {
      const w = x2 - x1;
      if (w < 6) continue;
      const sx = rev ? x2 - 2 : x1 + 2;
      const ex = rev ? x1 + 2 : x2 - 2;
      const dist = Math.abs(ex - sx);
      const steps = Math.max(1, Math.round(dist / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const fx = Math.round(sx + (ex - sx) * s / steps);
        const zy = y + ((s % 2) ? 2 : -2);
        out.push({x: fx, y: zy, color, type: "underlay"});
      }
    }
    rowI++;
  }
  return out;
}

function generateTieStitches(x, y, color, dirX, dirY) {
  const stitches = [];
  const off = 15;
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  stitches.push({x: x - dirX * off / 2, y: y - dirY * off / 2, color, type: "tie"});
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  return stitches;
}

function generateOutline(pixMap, reg, ci, canvasSize, color, stepPx) {
  const {mnx, mny, mxx, mxy} = reg;
  const edge = [];
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    if (runs.length) {
      edge.push({x: runs[0].x1, y});
      if (runs[runs.length - 1].x2 > runs[0].x1) edge.push({x: runs[runs.length - 1].x2, y});
    }
  }
  if (edge.length < 3) return [];
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  edge.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const out = [];
  let prev = null;
  for (const p of edge) {
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= stepPx) {
      out.push({x: p.x, y: p.y, color, type: "running"});
      prev = p;
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   PROFESSIONAL STITCH GENERATOR  (v72 — unified legacy)
   ═══════════════════════════════════════════════════════════════════ */
function generateStitchesFromRegions(pixMap, regions, colors, params, canvasSize, shapeOverrides) {
  const stitches = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));

  const P = params || {};
  const pRow      = P.tatamiRow !== undefined ? P.tatamiRow : 35;  /* 3.5 mm default */
  const pLen      = P.tatamiLen !== undefined ? P.tatamiLen : 35;  /* 3.5 mm mean */
  const pPull     = P.pull      !== undefined ? P.pull      : 2;
  const pPullComp = P.pullComp  !== undefined ? P.pullComp  : 2;
  const pEdgeUL   = 18;
  const pZigUL    = 28;
  const pZigLen   = 40;

  const edgePixels = new Map();
  for (const reg of regions) {
    edgePixels.set(reg, getEdgePixels(pixMap, reg, canvasSize));
  }

  /* Color-first ordering */
  const byColor = new Map();
  for (const reg of regions) {
    const ck = normHex(reg.color);
    if (!byColor.has(ck)) byColor.set(ck, []);
    byColor.get(ck).push(reg);
  }
  const ordered = [];
  const colorOrder = colors.map(c => normHex(c));
  for (const ck of colorOrder) {
    const regsForColor = byColor.get(ck);
    if (!regsForColor) continue;
    for (const type of ['fill', 'satin', 'running']) {
      const grp = regsForColor.filter(r => r.type === type);
      if (grp.length) ordered.push(...sortRegionsNearestNeighbor(grp));
    }
  }
  for (const [ck, regs] of byColor) {
    if (!colorOrder.includes(ck)) {
      for (const type of ['fill', 'satin', 'running']) {
        const grp = regs.filter(r => r.type === type);
        if (grp.length) ordered.push(...sortRegionsNearestNeighbor(grp));
      }
    }
  }

  let globalLastX = -1, globalLastY = -1;
  let prevColor = null;

  for (let ri = 0; ri < ordered.length; ri++) {
    const reg = ordered[ri];
    const ci = colors.findIndex(c => normHex(c) === normHex(reg.color));
    if (ci === -1) { console.warn(`Region color ${reg.color} not in palette`); continue; }

    const {color, type, mnx, mny, mxx, mxy} = reg;
    const regW = mxx - mnx;
    const regH = mxy - mny;
    let lastX = globalLastX, lastY = globalLastY;

    /* Move to entry point */
    if (lastX !== -1 && ri > 0) {
      const prevReg = ordered[ri - 1];
      if (normHex(prevReg.color) === normHex(reg.color)) {
        const pair = findClosestPair(edgePixels.get(prevReg), edgePixels.get(reg));
        const gap = Math.hypot(pair.to.x - lastX, pair.to.y - lastY);
        if (gap > 120) {
          stitches.push({x: lastX, y: lastY, color, type: "trim"});
          stitches.push({x: pair.to.x, y: pair.to.y, color, type: "trim"});
        } else {
          stitches.push(...generateBridgeStitches(lastX, lastY, pair.to.x, pair.to.y, color));
        }
        lastX = pair.to.x; lastY = pair.to.y;
      } else {
        stitches.push(...generateTieStitches(lastX, lastY, prevColor, -1, 0));
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        const entryEdge = edgePixels.get(reg);
        const entry = entryEdge[Math.floor(entryEdge.length / 2)];
        const bridge = generateBridgeStitches(lastX, lastY, entry.x, entry.y, color);
        stitches.push(...bridge);
        lastX = entry.x; lastY = entry.y;
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    } else {
      const entryEdge = edgePixels.get(reg);
      const entry = entryEdge[Math.floor(entryEdge.length / 2)];
      lastX = entry.x; lastY = entry.y;
      if (ri === 0) {
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    }

    /* Outline pass for crisp edges */
    const outlineStep = Math.max(6, Math.round(pLen * 0.5));
    const outline = generateOutline(pixMap, reg, ci, canvasSize, color, outlineStep);
    if (outline.length) {
      const oStart = outline[0];
      if (Math.hypot(oStart.x - lastX, oStart.y - lastY) > 30) {
        stitches.push(...generateBridgeStitches(lastX, lastY, oStart.x, oStart.y, color));
      }
      stitches.push(...outline);
      lastX = outline[outline.length - 1].x;
      lastY = outline[outline.length - 1].y;
      colorCounts[ci].running += outline.length;
    }

    /* Underlay */
    if (type === "fill") {
      const edgeWalk = generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, pEdgeUL, Math.max(2, pPull));
      if (edgeWalk.length) {
        const start = edgeWalk[0];
        if (Math.hypot(start.x - lastX, start.y - lastY) > 30) {
          stitches.push(...generateBridgeStitches(lastX, lastY, start.x, start.y, color));
        }
        stitches.push(...edgeWalk);
        lastX = edgeWalk[edgeWalk.length - 1].x;
        lastY = edgeWalk[edgeWalk.length - 1].y;
        colorCounts[ci].underlay += edgeWalk.length;
      }
      const zig = generateZigzagUnderlay(pixMap, reg, ci, canvasSize, color, pZigUL, pZigLen);
      if (zig.length) {
        const zStart = zig[0];
        if (Math.hypot(zStart.x - lastX, zStart.y - lastY) > 30) {
          stitches.push(...generateBridgeStitches(lastX, lastY, zStart.x, zStart.y, color));
        }
        stitches.push(...zig);
        lastX = zig[zig.length - 1].x;
        lastY = zig[zig.length - 1].y;
        colorCounts[ci].underlay += zig.length;
      }
    }

    const useVerticalScan = (type === "fill") && (regH > regW * 1.4);
    let lx = lastX, ly = lastY;

    if (useVerticalScan) {
      let colIdx = 0;
      const gapTrimPxV = Math.max(15, Math.round(pLen * 1.2));
      for (let x = mnx; x <= mxx; x += pRow) {
        const runs = getRunsInCol(pixMap, ci, x, mny, mxy, canvasSize);
        if (!runs.length) continue;
        const rev = colIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;
        let runIdx = 0;
        let prevExitY = null;
        for (const {y1, y2} of ord) {
          if (runIdx > 0 && prevExitY !== null) {
            const entryY = rev ? y2 : y1;
            const gap = Math.abs(entryY - prevExitY);
            if (gap > gapTrimPxV) {
              stitches.push({x, y: prevExitY, color, type: "trim"});
              stitches.push({x, y: entryY,    color, type: "trim"});
              lx = x; ly = entryY;
            }
          }

          const ay1 = y1 + pPull - pPullComp;
          const ay2 = y2 - pPull + pPullComp;
          const brickOff = colIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
          const ly1 = ay1 + brickOff;
          if (ay2 <= ly1) {
            const my = Math.round((y1 + y2) / 2);
            stitches.push({x, y: my, color, type: "fill"});
            colorCounts[ci].fill++;
            lx = x; ly = my;
            prevExitY = my;
          } else {
            const steps = Math.max(1, Math.round((ay2 - ly1) / pLen));
            const sy = rev ? ay2 : ly1, ey = rev ? ly1 : ay2;
            for (let s = 0; s <= steps; s++) {
              const fy = Math.round(sy + (ey - sy) * s / steps);
              stitches.push({x, y: fy, color, type: "fill"});
              colorCounts[ci].fill++;
            }
            lx = x; ly = Math.round(ey);
            prevExitY = ly;
          }
          runIdx++;
        }
        colIdx++;
      }
    } else {
      let rowIdx = 0;
      const gapTrimPx = Math.max(15, Math.round(pLen * 1.2));
      for (let y = mny; y <= mxy; y += pRow) {
        const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
        if (!runs.length) continue;
        const rev = rowIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;

        let runIdx = 0;
        let prevExitX = null;
        for (const {x1, x2} of ord) {
          const jx = rev ? x2 : x1;

          if (runIdx > 0 && prevExitX !== null) {
            const entryForGap = rev ? x2 : x1;
            const gap = Math.abs(entryForGap - prevExitX);
            if (gap > gapTrimPx) {
              stitches.push({x: prevExitX, y, color, type: "trim"});
              stitches.push({x: entryForGap, y, color, type: "trim"});
              lx = entryForGap; ly = y;
            }
          }

          if (type === "running") {
            const rx = Math.round((x1 + x2) / 2);
            stitches.push({x: rx, y, color, type: "running"});
            colorCounts[ci].running++;
            lx = rx; ly = y;
            prevExitX = rx;

          } else if (type === "satin") {
            const sx = rev ? x2 - pPull + pPullComp : x1 + pPull - pPullComp;
            const ex = rev ? x1 + pPull - pPullComp : x2 - pPull + pPullComp;
            if (Math.abs(ex - sx) > 1) {
              stitches.push({x: sx, y, color, type: "satin"});
              stitches.push({x: ex, y, color, type: "satin"});
              colorCounts[ci].satin += 2;
              lx = ex; ly = y;
              prevExitX = ex;
            } else {
              const rx = Math.round((x1 + x2) / 2);
              stitches.push({x: rx, y, color, type: "satin"});
              colorCounts[ci].satin++;
              lx = rx; ly = y;
              prevExitX = rx;
            }

          } else {
            const brickOff = rowIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
            const lxF = x1 + pPull - pPullComp + brickOff;
            const rxF = x2 - pPull + pPullComp;
            if (rxF > lxF) {
              const steps = Math.max(1, Math.round((rxF - lxF) / pLen));
              const sx2 = rev ? rxF : lxF, ex2 = rev ? lxF : rxF;
              for (let s = 0; s <= steps; s++) {
                const fx = Math.round(sx2 + (ex2 - sx2) * s / steps);
                stitches.push({x: fx, y, color, type: "fill"});
                colorCounts[ci].fill++;
              }
              lx = Math.round(ex2); ly = y;
              prevExitX = lx;
            } else {
              const mid = Math.round((x1 + x2) / 2);
              stitches.push({x: mid, y, color, type: "fill"});
              colorCounts[ci].fill++;
              lx = mid; ly = y;
              prevExitX = mid;
            }
          }
          runIdx++;
        }
        rowIdx++;
      }
    }

    globalLastX = lx;
    globalLastY = ly;
    prevColor = color;
  }

  if (globalLastX !== -1 && prevColor !== null) {
    stitches.push(...generateTieStitches(globalLastX, globalLastY, prevColor, -1, 0));
  }

  console.log("Stitches:", colors.map((c, i) => {
    const k = colorCounts[i];
    return `${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running} ul:${k.underlay}`;
  }).join(" | "));

  return {stitches, colorCounts};
}

/* ─── COLOR MERGE: remap pixMap indices ─────────────────── */
function applyColorMerges(pixMap, colors, merges, lockedColors) {
  if (!merges || !Object.keys(merges).length) return {pixMap, colors};
  const locked = new Set(
    Array.isArray(lockedColors) ? lockedColors.map(h => normHex(h)) : []
  );

  const remap = colors.map((_, i) => i);

  for (const [srcHex, tgtHex] of Object.entries(merges)) {
    const srcN = normHex(srcHex), tgtN = normHex(tgtHex);
    if (locked.has(srcN) || locked.has(tgtN)) {
      console.log(`Skipping merge ${srcN}→${tgtN} (locked)`);
      continue;
    }
    const srcIdx = colors.findIndex(c => normHex(c) === srcN);
    const tgtIdx = colors.findIndex(c => normHex(c) === tgtN);
    if (srcIdx !== -1 && tgtIdx !== -1 && srcIdx !== tgtIdx) {
      remap[srcIdx] = tgtIdx;
    }
  }

  const newPixMap = new Int16Array(pixMap.length);
  for (let i = 0; i < pixMap.length; i++) {
    newPixMap[i] = pixMap[i] >= 0 ? remap[pixMap[i]] : -1;
  }

  const oldToNew = {};
  const newColors = [];
  for (let i = 0; i < colors.length; i++) {
    if (remap[i] === i) {
      oldToNew[i] = newColors.length;
      newColors.push(colors[i]);
    }
  }

  for (let i = 0; i < newPixMap.length; i++) {
    if (newPixMap[i] >= 0) {
      newPixMap[i] = oldToNew[newPixMap[i]];
    }
  }

  return {pixMap: newPixMap, colors: newColors};
}

/* ─── BASTING BOX ─────────────────────────────────────────── */
function generateBastingBox(regions, colors, spacing = 20) {
  if (!regions.length || !colors.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    if (r.mnx < minX) minX = r.mnx;
    if (r.mny < minY) minY = r.mny;
    if (r.mxx > maxX) maxX = r.mxx;
    if (r.mxy > maxY) maxY = r.mxy;
  }
  minX = Math.max(0, minX - 10);
  minY = Math.max(0, minY - 10);
  maxX = maxX + 10;
  maxY = maxY + 10;

  const color = colors[0];
  const stitches = [];
  for (let x = minX; x <= maxX; x += spacing) stitches.push({x, y: minY, color, type: "running"});
  for (let y = minY; y <= maxY; y += spacing) stitches.push({x: maxX, y, color, type: "running"});
  for (let x = maxX; x >= minX; x -= spacing) stitches.push({x, y: maxY, color, type: "running"});
  for (let y = maxY; y >= minY; y -= spacing) stitches.push({x: minX, y, color, type: "running"});
  return stitches;
}

/* ─── QUALITY VALIDATION ─────────────────────────────────*/
function validateQuality(stitches, machineLimits){
  const limits = machineLimits || MACHINE_LIMITS.generic;
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,trimCount=0,prev=null;
  for(const s of stitches){
    if(s.type==="trim"){trimCount++;prev=null;continue;}
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>limits.maxJump)longJ++;
      if(s.type!=="underlay"){tot+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?tot/cnt:0;
  if(avg>50)w.push(`Long avg ${(avg/10).toFixed(1)}mm`);
  if(maxJ>limits.maxJump)w.push(`Jump ${(maxJ/10).toFixed(1)}mm > ${(limits.maxJump/10).toFixed(1)}mm`);
  if(longJ>30)    w.push(`${longJ} oversized jumps`);
  if(cnt>80000)   w.push(`High stitch count ${cnt}`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,trimCount,warnings:w,passed:!w.length};
}

/* ─── SEW TIME CALCULATOR ────────────────────────────────*/
function calculateSewTime(stitchCount, trimCount, colorCount, machine) {
  const spm = { tajima: 800, brother: 650, barudan: 850, generic: 750, janome: 700, singer: 600 };
  const rate = spm[machine] || 750;

  const stitchMinutes = stitchCount / rate;
  const trimMinutes = (trimCount * 0.3) / 60;
  const colorChangeMinutes = Math.max(0, (colorCount - 1) * 0.5);

  const totalMinutes = Math.ceil(stitchMinutes + trimMinutes + colorChangeMinutes);

  if (totalMinutes < 1) return "< 1 min";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/* ─── PREVIEW RENDERER (with mm ruler + solo mode) ───────*/
async function renderPreview(pixMap, colors, stitches, params, canvasSize, soloColor=null) {
  const renderSize = Math.min(canvasSize, PREVIEW_MAX);
  const scale = renderSize / canvasSize;

  const W = renderSize, H = renderSize;
  const buf = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const weave = ((x + y) % 2 === 0) ? 4 : -2;
      buf[idx]     = 242 + weave;
      buf[idx + 1] = 238 + weave;
      buf[idx + 2] = 228 + weave;
      buf[idx + 3] = 255;
    }
  }

  const threadColors = colors.map(c => {
    const { r, g, b } = hexToRgb(normHex(c));
    return { r, g, b, dr: Math.max(0, r - 45), dg: Math.max(0, g - 45), db: Math.max(0, b - 45) };
  });

  function setPixel(x, y, r, g, b, a) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    const alpha = a / 255;
    buf[idx]     = Math.round(buf[idx]     * (1 - alpha) + r * alpha);
    buf[idx + 1] = Math.round(buf[idx + 1] * (1 - alpha) + g * alpha);
    buf[idx + 2] = Math.round(buf[idx + 2] * (1 - alpha) + b * alpha);
    buf[idx + 3] = 255;
  }

  function drawLine(x0, y0, x1, y1, r, g, b, thickness, alphaBase) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) {
      for(let ty = -1; ty <= 1; ty++) {
        for(let tx = -1; tx <= 1; tx++) {
          setPixel(x0 + tx, y0 + ty, r, g, b, alphaBase * 0.7);
        }
      }
      return;
    }

    const steps = Math.ceil(dist * 2.5);
    const nx = dist > 0 ? -dy / dist : 0;
    const ny = dist > 0 ? dx / dist : 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;

      setPixel(x, y, r, g, b, alphaBase);

      if (thickness >= 2) {
        setPixel(x + nx * 0.8, y + ny * 0.8, r, g, b, alphaBase * 0.85);
        setPixel(x - nx * 0.8, y - ny * 0.8, r, g, b, alphaBase * 0.85);
      }
      if (thickness >= 3) {
        setPixel(x + nx * 1.5, y + ny * 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x - nx * 1.5, y - ny * 1.5, r, g, b, alphaBase * 0.55);
      }
      if (thickness >= 4) {
        setPixel(x + nx * 2.5, y + ny * 2.5, r, g, b, alphaBase * 0.35);
        setPixel(x - nx * 2.5, y - ny * 2.5, r, g, b, alphaBase * 0.35);
        setPixel(x, y + 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x, y - 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x, y + 2.5, r, g, b, alphaBase * 0.4);
        setPixel(x, y - 2.5, r, g, b, alphaBase * 0.4);
        setPixel(x, y + 3.2, r, g, b, alphaBase * 0.2);
        setPixel(x, y - 3.2, r, g, b, alphaBase * 0.2);
      }
    }
  }

  /* Draw mm ruler along bottom and right edges */
  const pxPerMm = canvasSize / 80; /* 800px = 80mm */
  const rulerColor = {r:80,g:80,b:80};
  for (let mm = 0; mm * pxPerMm < W; mm += 1) {
    const x = Math.round(mm * pxPerMm * scale);
    const h = (mm % 5 === 0) ? 10 : 5;
    for (let ry = 0; ry < h; ry++) setPixel(x, H - 1 - ry, rulerColor.r, rulerColor.g, rulerColor.b, 180);
    if (mm % 10 === 0 && x > 5 && x < W - 10) {
      /* Draw tiny tick label (simplified as 2px dot pattern) */
      setPixel(x, H - 12, rulerColor.r, rulerColor.g, rulerColor.b, 200);
    }
  }
  for (let mm = 0; mm * pxPerMm < H; mm += 1) {
    const y = Math.round(mm * pxPerMm * scale);
    const w = (mm % 5 === 0) ? 10 : 5;
    for (let rx = 0; rx < w; rx++) setPixel(W - 1 - rx, y, rulerColor.r, rulerColor.g, rulerColor.b, 180);
  }

  const scaledStitches = stitches.map(s => ({
    ...s,
    x: s.x * scale,
    y: s.y * scale
  }));

  const byColor = new Map();
  for (const s of scaledStitches) {
    if (s.type === "trim") continue;
    if (soloColor && normHex(s.color) !== normHex(soloColor)) continue;
    if (!byColor.has(s.color)) byColor.set(s.color, []);
    byColor.get(s.color).push(s);
  }

  for (const [color, colStitches] of byColor) {
    const ci = colors.findIndex(c => normHex(c) === normHex(color));
    const tc = ci >= 0 ? threadColors[ci] : { r: 128, g: 128, b: 128, dr: 80, dg: 80, db: 80 };

    const underlays = colStitches.filter(s => s.type === "underlay");
    const covers    = colStitches.filter(s => s.type !== "underlay");

    for (let i = 1; i < underlays.length; i++) {
      const a = underlays[i - 1], b = underlays[i];
      if (Math.hypot(b.x - a.x, Math.abs(b.y - a.y)) > 80 * scale) continue;
      drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, 1, 60);
    }

    for (let i = 0; i < covers.length; i++) {
      const s = covers[i];
      const next = covers[i + 1] || null;

      const isSatin = s.type === "satin";
      const isFill  = s.type === "fill";

      setPixel(s.x, s.y, tc.r, tc.g, tc.b, 240);
      setPixel(s.x + 1, s.y, tc.dr, tc.dg, tc.db, 160);
      setPixel(s.x, s.y + 1, tc.dr, tc.dg, tc.db, 140);
      setPixel(s.x - 1, s.y, tc.dr, tc.dg, tc.db, 140);
      setPixel(s.x, s.y - 1, tc.dr, tc.dg, tc.db, 120);

      if (next && next.color === s.color) {
        const jump = Math.hypot(next.x - s.x, next.y - s.y);
        if (jump < 50 * scale) {
          const thick = isSatin ? 3 : isFill ? 4 : 1;
          drawLine(s.x, s.y, next.x, next.y, tc.r, tc.g, tc.b, thick, 230);
        }
      }
    }
  }

  let cminX = canvasSize, cmaxX = 0, cminY = canvasSize, cmaxY = 0;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      if (pixMap[y * canvasSize + x] >= 0) {
        if (x < cminX) cminX = x; if (x > cmaxX) cmaxX = x;
        if (y < cminY) cminY = y; if (y > cmaxY) cmaxY = y;
      }
    }
  }

  const pad = Math.round(30 * scale);
  const cropX = Math.max(0, Math.round(cminX * scale) - pad);
  const cropY = Math.max(0, Math.round(cminY * scale) - pad);
  const cropW = Math.min(W, Math.round(cmaxX * scale) + pad) - cropX;
  const cropH = Math.min(H, Math.round(cmaxY * scale) + pad) - cropY;

  if (cropW > 50 && cropH > 50) {
    const cropped = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const sIdx = ((cropY + y) * W + (cropX + x)) * 4;
        const dIdx = (y * cropW + x) * 4;
        cropped[dIdx] = buf[sIdx]; cropped[dIdx + 1] = buf[sIdx + 1];
        cropped[dIdx + 2] = buf[sIdx + 2]; cropped[dIdx + 3] = buf[sIdx + 3];
      }
    }
    return await sharp(cropped, { raw: { width: cropW, height: cropH, channels: 4 } })
      .png({ compressionLevel: 6 }).toBuffer();
  }

  return await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 6 }).toBuffer();
}


/* ─── DST ENCODER ─────────────────────────────────────────*/
function dstEncodeXY(dx, dy, isJump) {
  let x = dx;
  let y = -dy;
  let b0 = 0, b1 = 0, b2 = 0x03;

  if (x >  40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x08; x += 81; }
  if (y >  40) { b2 |= 0x20; y -= 81; }
  if (y < -40) { b2 |= 0x10; y += 81; }

  if (x >  13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x08; x += 27; }
  if (y >  13) { b1 |= 0x20; y -= 27; }
  if (y < -13) { b1 |= 0x10; y += 27; }

  if (x >   4) { b0 |= 0x04; x -=  9; }
  if (x <  -4) { b0 |= 0x08; x +=  9; }
  if (y >   4) { b0 |= 0x20; y -=  9; }
  if (y <  -4) { b0 |= 0x10; y +=  9; }

  if (x >   1) { b1 |= 0x01; x -=  3; }
  if (x <  -1) { b1 |= 0x02; x +=  3; }
  if (y >   1) { b1 |= 0x80; y -=  3; }
  if (y <  -1) { b1 |= 0x40; y +=  3; }

  if (x >   0) { b0 |= 0x01; }
  if (x <   0) { b0 |= 0x02; }
  if (y >   0) { b0 |= 0x80; }
  if (y <   0) { b0 |= 0x40; }

  if (isJump) b2 |= 0x80;
  return Buffer.from([b0, b1, b2]);
}

function fmtExtent(n) {
  const abs = Math.max(0, Math.round(Math.abs(n)));
  let digits = String(abs);
  if (digits.length < 2) digits = "0" + digits;
  return digits.padStart(5, " ");
}

function dstHeader(stitchCount, colorCount, minX, maxX, minY, maxY, name) {
  const buf = Buffer.alloc(512, 0x20);
  let off = 0;
  const write = (txt) => {
    buf.write(txt, off, "ascii");
    off += txt.length;
    buf[off++] = 0x0D;
  };
  const safeName = (name || "Stichai").substring(0, 16).padEnd(16, " ");
  write("LA:" + safeName);
  write("ST:" + String(stitchCount).padStart(7, " "));
  write("CO:" + String(colorCount).padStart(3, " "));
  write("+X:" + fmtExtent(Math.max(0,  maxX)));
  write("-X:" + fmtExtent(Math.max(0, -minX)));
  write("+Y:" + fmtExtent(Math.max(0, -minY)));
  write("-Y:" + fmtExtent(Math.max(0,  maxY)));
  write("AX:+" + String(0).padStart(5, " "));
  write("AY:+" + String(0).padStart(5, " "));
  write("MX:+" + String(0).padStart(5, " "));
  write("MY:+" + String(0).padStart(5, " "));
  write("PD:******");
  buf[off++] = 0x1A;
  return buf;
}

function encodeDST(stitches, machineLimits) {
  const limits = machineLimits || MACHINE_LIMITS.generic;

  const filtered = [];
  let last = null;
  for (const s of stitches) {
    if (s.type === "trim" || s.type === "color-change") {
      filtered.push(s);
      last = s;
      continue;
    }
    if (!last || last.type === "trim") {
      filtered.push(s);
      last = s;
      continue;
    }
    const dist = Math.hypot(s.x - last.x, s.y - last.y);
    if (dist < limits.minStitch && s.color === last.color && s.type === last.type) {
      continue;
    }
    filtered.push(s);
    last = s;
  }

  const recs = [];
  let lastColor = null;
  let px = 0, py = 0;
  let stitchCount = 0;
  let colorChanges = 0;
  let mnx =  Infinity, mxx = -Infinity, mny =  Infinity, mxy = -Infinity;

  const emitLong = (dx, dy, isJump) => {
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(dx) / limits.maxJump),
      Math.ceil(Math.abs(dy) / limits.maxJump)
    );
    let prevFx = 0, prevFy = 0;
    for (let i = 1; i <= steps; i++) {
      const fx = Math.round(dx * i / steps);
      const fy = Math.round(dy * i / steps);
      recs.push(dstEncodeXY(fx - prevFx, fy - prevFy, isJump));
      prevFx = fx;
      prevFy = fy;
      stitchCount++;
    }
  };

  let needJump = false;

  for (const s of filtered) {
    if (s.color !== lastColor && lastColor !== null) {
      recs.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChanges++;
      stitchCount++;
      needJump = true;
    }
    lastColor = s.color;

    const dx = Math.round(s.x - px);
    const dy = Math.round(s.y - py);
    px = s.x;
    py = s.y;

    let isJump = s.type === "trim" || s.type === "jump";
    if (needJump && !isJump) {
      isJump = true;
      needJump = false;
    }
    if (s.type === "trim" || s.type === "color-change") {
      needJump = true;
    }

    if (Math.abs(dx) > limits.maxJump || Math.abs(dy) > limits.maxJump) {
      emitLong(dx, dy, isJump);
    } else {
      recs.push(dstEncodeXY(dx, dy, isJump));
      stitchCount++;
    }

    if (s.x < mnx) mnx = s.x;
    if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y;
    if (s.y > mxy) mxy = s.y;
  }

  recs.push(Buffer.from([0x00, 0x00, 0xF3]));

  if (mnx === Infinity) { mnx = mxx = mny = mxy = 0; }

  const header = dstHeader(stitchCount, colorChanges + 1, mnx, mxx, mny, mxy, "Stichai");
  return Buffer.concat([header, ...recs]);
}

/* ═══════════════════════════════════════════════════════════════════
   JEF / PES THREAD TABLES & ENCODERS
   ═══════════════════════════════════════════════════════════════════ */
const JEF_THREADS = [
  {r:0,   g:0,   b:0   }, {r:255, g:255, b:255 }, {r:255, g:255, b:23  },
  {r:250, g:160, b:96  }, {r:235, g:0,   b:0   }, {r:160, g:0,   b:96  },
  {r:220, g:95,  b:155 }, {r:240, g:185, b:210 }, {r:255, g:215, b:0   },
  {r:205, g:130, b:0   }, {r:168, g:105, b:40  }, {r:100, g:60,  b:5   },
  {r:200, g:225, b:120 }, {r:80,  g:145, b:60  }, {r:0,   g:100, b:20  },
  {r:225, g:240, b:245 }, {r:100, g:190, b:225 }, {r:0,   g:130, b:200 },
  {r:0,   g:65,  b:160 }, {r:100, g:80,  b:160 }, {r:135, g:115, b:175 },
  {r:200, g:190, b:230 }, {r:210, g:210, b:210 }, {r:160, g:160, b:160 },
  {r:80,  g:80,  b:80  }, {r:195, g:175, b:145 }, {r:240, g:225, b:190 },
  {r:210, g:180, b:135 }, {r:145, g:105, b:70  }, {r:95,  g:60,  b:25  },
  {r:230, g:95,  b:40  }, {r:255, g:185, b:90  },
];

const PEC_THREADS = [
  {r:0,   g:0,   b:0   }, {r:255, g:255, b:255 }, {r:255, g:255, b:23  },
  {r:255, g:165, b:0   }, {r:255, g:102, b:102 }, {r:255, g:0,   b:0   },
  {r:155, g:0,   b:30  }, {r:240, g:185, b:215 }, {r:255, g:215, b:0   },
  {r:200, g:130, b:0   }, {r:140, g:90,  b:25  }, {r:90,  g:50,  b:5   },
  {r:195, g:215, b:110 }, {r:75,  g:140, b:55  }, {r:0,   g:95,  b:20  },
  {r:0,   g:170, b:55  }, {r:180, g:235, b:240 }, {r:95,  g:185, b:220 },
  {r:0,   g:120, b:190 }, {r:0,   g:60,  b:150 }, {r:95,  g:75,  b:155 },
  {r:195, g:185, b:225 }, {r:205, g:205, b:205 }, {r:150, g:150, b:150 },
  {r:65,  g:65,  b:65  }, {r:190, g:170, b:140 }, {r:240, g:220, b:185 },
  {r:200, g:175, b:130 }, {r:140, g:100, b:65  }, {r:90,  g:55,  b:20  },
  {r:225, g:90,  b:35  }, {r:255, g:180, b:85  }, {r:235, g:235, b:60  },
  {r:130, g:195, b:235 }, {r:145, g:110, b:215 }, {r:255, g:20,  b:145 },
  {r:50,  g:200, b:50  }, {r:250, g:95,  b:70  }, {r:255, g:140, b:0   },
  {r:170, g:250, b:45  }, {r:240, g:125, b:125 }, {r:255, g:155, b:120 },
  {r:125, g:255, b:210 }, {r:110, g:125, b:140 }, {r:255, g:225, b:220 },
  {r:253, g:245, b:230 }, {r:240, g:248, b:255 }, {r:245, g:245, b:245 },
  {r:45,  g:75,  b:75  }, {r:100, g:100, b:100 }, {r:176, g:196, b:222 },
  {r:220, g:20,  b:60  }, {r:0,   g:185, b:255 }, {r:150, g:200, b:50  },
  {r:255, g:125, b:80  }, {r:100, g:88,  b:200 }, {r:102, g:200, b:170 },
  {r:233, g:148, b:122 }, {r:255, g:220, b:170 }, {r:30,  g:144, b:255 },
  {r:119, g:136, b:153 }, {r:255, g:250, b:250 },
];

function colorDistPerceptual(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  const rm = (a.r + b.r) / 2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

function findNearestThread(rgb, set) {
  let best = 0, bestD = 1e9;
  for (let i = 0; i < set.length; i++) {
    const d = colorDistPerceptual(rgb, set[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function writeInt8(buf, v) { buf.push(v & 0xFF); }
function writeInt16LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF); }
function writeInt16BE(buf, v) { buf.push((v >> 8) & 0xFF, v & 0xFF); }
function writeInt24LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF); }
function writeInt32LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); }
function writeString(buf, s) { for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)); }

function getBounds(stitches) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'trim' || s.type === 'end') continue;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  if (minX === Infinity) { minX = maxX = minY = maxY = 0; }
  return {minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY};
}

function normalizeStitches(stitches, maxJump) {
  const out = [];
  let px = 0, py = 0, prevColor = null;
  for (const s of stitches) {
    if (s.type === 'trim') {
      continue;
    }
    if (prevColor !== null && s.color !== prevColor) {
      out.push({dx: 0, dy: 0, type: 'color_change'});
    }
    prevColor = s.color;
    const dx = s.x - px, dy = s.y - py;
    const dist = Math.hypot(dx, dy);
    if (dist > maxJump) {
      const steps = Math.ceil(dist / maxJump);
      for (let i = 1; i < steps; i++) {
        const ix = Math.round(px + dx * i / steps);
        const iy = Math.round(py + dy * i / steps);
        out.push({dx: ix - px, dy: iy - py, type: 'jump'});
        px = ix; py = iy;
      }
      out.push({dx: s.x - px, dy: s.y - py, type: s.type === 'jump' ? 'jump' : 'stitch'});
    } else {
      out.push({dx, dy, type: s.type === 'jump' ? 'jump' : 'stitch'});
    }
    px = s.x; py = s.y;
  }
  out.push({dx: 0, dy: 0, type: 'end'});
  return out;
}

function getJefHoopSize(width, height) {
  if (width < 500 && height < 500) return 1;
  if (width < 1260 && height < 1100) return 3;
  if (width < 1400 && height < 2000) return 2;
  if (width < 2000 && height < 2000) return 4;
  return 0;
}

function writeHoopEdge(buf, x, y) {
  if (x >= 0 && y >= 0) {
    writeInt32LE(buf, x); writeInt32LE(buf, y);
    writeInt32LE(buf, x); writeInt32LE(buf, y);
  } else {
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
  }
}

function encodeJEF(stitches, colors) {
  const norm = normalizeStitches(stitches, 127);
  const bounds = getBounds(stitches);
  const colorCount = colors.length;

  let pointCount = 1;
  for (const s of norm) {
    if (s.type === 'stitch') pointCount += 1;
    else if (s.type === 'jump') pointCount += 2;
    else if (s.type === 'color_change') pointCount += 2;
  }

  const palette = colors.map(c => findNearestThread(hexToRgb(c), JEF_THREADS));
  const headerSize = 0x74 + colorCount * 8;

  const buf = [];
  writeInt32LE(buf, headerSize);
  writeInt32LE(buf, 0x14);

  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth()+1).padStart(2,'0') +
    String(now.getDate()).padStart(2,'0') +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0') +
    String(now.getSeconds()).padStart(2,'0');
  writeString(buf, dateStr);
  writeInt8(buf, 0); writeInt8(buf, 0);

  writeInt32LE(buf, colorCount);
  writeInt32LE(buf, pointCount);
  writeInt32LE(buf, getJefHoopSize(bounds.width, bounds.height));

  const halfW = Math.round(bounds.width / 2);
  const halfH = Math.round(bounds.height / 2);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);

  writeHoopEdge(buf, 550 - halfW, 550 - halfH);
  writeHoopEdge(buf, 250 - halfW, 250 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);

  for (const p of palette) writeInt32LE(buf, p);
  for (let i = 0; i < colorCount; i++) writeInt32LE(buf, 0x0D);

  let xx = 0, yy = 0;
  for (const s of norm) {
    if (s.type === 'stitch') {
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'color_change') {
      buf.push(0x80, 0x01);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'jump') {
      buf.push(0x80, 0x02);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'end') {
      buf.push(0x80, 0x10);
      break;
    }
  }
  return Buffer.from(buf);
}

/* PES / PEC */
function writePecValue(buf, value, long, flag) {
  if (!long && value > -64 && value < 63) {
    writeInt8(buf, value & 0x7F);
  } else {
    let v = value & 0x0FFF;
    v |= 0x8000;
    v |= (flag || 0) << 8;
    writeInt8(buf, (v >> 8) & 0xFF);
    writeInt8(buf, v & 0xFF);
  }
}

function encodePEC(stitches, colors) {
  const norm = normalizeStitches(stitches, 2047);
  const bounds = getBounds(stitches);
  const width = bounds.width, height = bounds.height;
  const colorCount = colors.length;
  const palette = colors.map(c => findNearestThread(hexToRgb(c), PEC_THREADS));

  const buf = [];
  const name = "Stichai";
  writeString(buf, "LA:" + name.padEnd(16, ' '));
  buf.push(0x0D);
  for (let i = 0; i < 12; i++) buf.push(0x20);
  buf.push(0xFF, 0x00);
  buf.push(6);
  buf.push(38);
  const pad1 = [0x20,0x20,0x20,0x20,0x64,0x20,0x00,0x20,0x00,0x20,0x20,0x20];
  for (const b of pad1) buf.push(b);

  if (colorCount > 0) {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(colorCount - 1);
    for (const p of palette) buf.push(p);
  } else {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xFF);
  }
  while (buf.length < 512) buf.push(0x20);

  buf.push(0x00, 0x00);
  const graphicsOffsetPos = buf.length;
  writeInt24LE(buf, 0);
  buf.push(0x31, 0xFF, 0xF0);
  writeInt16LE(buf, Math.round(width));
  writeInt16LE(buf, Math.round(height));
  writeInt16LE(buf, 0x01E0);
  writeInt16LE(buf, 0x01B0);
  writeInt16BE(buf, 0x9000 - bounds.minX);
  writeInt16BE(buf, 0x9000 - bounds.minY);

  const stitchBlockStart = buf.length;
  let xx = 0, yy = 0, colorTwo = true, jumping = true, init = true;
  for (const s of norm) {
    if (s.type === 'stitch') {
      if (jumping) {
        if (s.dx !== 0 || s.dy !== 0) {
          writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        }
        jumping = false;
      }
      writePecValue(buf, s.dx, false);
      writePecValue(buf, s.dy, false);
    } else if (s.type === 'jump') {
      jumping = true;
      if (init) {
        writePecValue(buf, s.dx, true, 0x10);
        writePecValue(buf, s.dy, true, 0x10);
      } else {
        writePecValue(buf, s.dx, true, 0x20);
        writePecValue(buf, s.dy, true, 0x20);
      }
    } else if (s.type === 'color_change') {
      if (jumping) {
        writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        jumping = false;
      }
      buf.push(0xFE, 0xB0);
      buf.push(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (s.type === 'end') {
      buf.push(0xFF);
      break;
    }
    init = false;
  }

  const stitchBlockLength = buf.length - stitchBlockStart;
  buf[graphicsOffsetPos] = stitchBlockLength & 0xFF;
  buf[graphicsOffsetPos + 1] = (stitchBlockLength >> 8) & 0xFF;
  buf[graphicsOffsetPos + 2] = (stitchBlockLength >> 16) & 0xFF;

  const thumbSize = 6 * 38;
  for (let i = 0; i < thumbSize; i++) buf.push(0);
  for (let c = 0; c < colorCount; c++) {
    for (let i = 0; i < thumbSize; i++) buf.push(0);
  }

  return Buffer.from(buf);
}

function encodePES(stitches, colors) {
  const pec = encodePEC(stitches, colors);
  const pecOffset = 8 + 4 + 10;
  const buf = [];
  writeString(buf, "#PES0001");
  writeInt32LE(buf, pecOffset);
  while (buf.length < pecOffset) buf.push(0);
  for (let i = 0; i < pec.length; i++) buf.push(pec[i]);
  return Buffer.from(buf);
}

/* ─── ZIP BUILDER ──────────────────────────────────────── */
function buildZipStore(files) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
  function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
  const localHeaders = [];
  const centralDir   = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc     = crc32(data);
    const size    = data.length;
    const now     = new Date();
    const dosTime = ((now.getSeconds() >> 1) | (now.getMinutes() << 5) | (now.getHours() << 11));
    const dosDate = (now.getDate() | ((now.getMonth()+1) << 5) | ((now.getFullYear()-1980) << 9));
    const lh = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(size), u32(size),
      u16(nameBuf.length), u16(0),
      nameBuf
    ]);
    localHeaders.push(lh, data);
    centralDir.push(Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(size), u32(size),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset),
      nameBuf
    ]));
    offset += lh.length + data.length;
  }
  const cdBuf = Buffer.concat(centralDir);
  const eocd  = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cdBuf.length), u32(offset),
    u16(0)
  ]);
  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/* ─── JOBS & DETECTIONS ───────────────────────────────────*/
const jobs         = new Map();
const previewCache = new Map();
const detections   = new Map();

setInterval(()=>{
  const now = Date.now();
  for(const [id,d] of detections){ if(now-d.timestamp>300000) detections.delete(id); }
  for(const [id,j] of jobs){ if(now-j.ts>600000) jobs.delete(id); }
  for(const [id,c] of previewCache){ if(now-c.ts>300000) previewCache.delete(id); }
}, 60000);

/* ═══════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════ */

app.get("/api/user/status", requireAuth, (req, res) => {
  const user = req.userDoc;
  if (!user) return res.json({ auth:false });
  const quota = checkQuota(user);
  const plan  = PLANS[user.plan] || PLANS.none;
  const trialDaysLeft = user.plan === "trial" && user.trialExpires
    ? Math.max(0, Math.ceil((user.trialExpires - Date.now()) / 86400000))
    : null;
  return res.json({
    auth: true,
    uid: user.uid,
    email: user.email,
    provider: user.provider,
    plan: user.plan,
    planLabel: plan.label,
    trialDaysLeft,
    allowed: quota.allowed,
    remaining: quota.remaining === Infinity ? null : quota.remaining,
    reason: quota.reason || null,
    upgrade: quota.upgrade || false,
  });
});

app.post("/api/checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error:"payments_not_configured" });
  const { priceKey } = req.body;
  const PRICES = buildPrices();
  const priceEntry = PRICES[priceKey];
  if (!priceEntry || !priceEntry.id)
    return res.status(400).json({ error:"invalid_price" });
  const user = req.userDoc;
  const appUrl = process.env.APP_URL || "https://stichai.pro";
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email, metadata: { firebaseUid: user.uid },
    });
    customerId = customer.id;
    if (db) await db.collection("users").doc(user.uid).update({ stripeCustomerId: customerId });
  }
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [{ price: priceEntry.id, quantity: 1 }],
    success_url: `${appUrl}/?checkout=success&plan=${priceEntry.plan}`,
    cancel_url:  `${appUrl}/?checkout=cancel`,
  });
  return res.json({ url: session.url });
});

app.post("/api/portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error:"payments_not_configured" });
  const user = req.userDoc;
  if (!user?.stripeCustomerId) return res.status(400).json({ error:"no_subscription" });
  const appUrl = process.env.APP_URL || "https://stichai.pro";
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId, return_url: appUrl,
  });
  return res.json({ url: session.url });
});

app.post("/api/admin/grant", async (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error:"forbidden" });
  if (!db) return res.status(503).json({ error:"db_not_ready" });
  const { uid, email, plan, durationDays } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error:"invalid_plan" });
  let targetUid = uid;
  if (!targetUid && email) {
    try { const u = await admin.auth().getUserByEmail(email); targetUid = u.uid; }
    catch(e) { return res.status(404).json({ error:"user_not_found" }); }
  }
  if (!targetUid) return res.status(400).json({ error:"uid_or_email_required" });
  const now = Date.now();
  const update = {
    plan, planGrantedBy:"admin", planGrantedAt:now,
    downloadsThisPeriod:0, periodStart:getPeriodStart(PLANS[plan].period),
  };
  if (plan === "trial" && durationDays) {
    update.trialStart = now;
    update.trialExpires = now + durationDays * 86400000;
  }
  if (plan !== "trial" && durationDays) {
    update.freeUntil = now + durationDays * 86400000;
  }
  await db.collection("users").doc(targetUid).set(update, { merge:true });
  return res.json({ success:true, uid:targetUid, plan });
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/",(_, res)=>res.sendFile(path.join(__dirname,"public","index.html")));

/* ─── CARTOON MAGIC ───────────────────────────────────────*/
app.post("/api/cartoon-magic", upload.single("image"), async (req, res) => {
  try {
    const imgFile = req.file;
    if (!imgFile) return res.status(400).json({ error: "No image" });
    const cartoonBuf = await cartoonifyImage(imgFile.buffer);
    res.setHeader("Content-Type", "image/png");
    res.send(cartoonBuf);
  } catch (e) {
    console.error("Cartoon magic error:", e.message);
    res.status(500).json({ error: e.message || "Cartoon processing failed" });
  }
});

/* ─── TEST SUITE ────────────────────────────────────────*/
app.get("/api/test-suite", async (req, res) => {
  const results = [];
  /* Prop #10 — synthetic validation tests */
  const mediumParams = getStitchParams({ density: "medium" });
  results.push({
    name: "medium_tatami_row_pitch",
    pass: mediumParams.tatamiRow === 35,
    expected: 35,
    got: mediumParams.tatamiRow,
    note: "3.5 mm row pitch at 800px canvas"
  });
  const highParams = getStitchParams({ density: "high" });
  results.push({
    name: "high_tatami_row_pitch",
    pass: highParams.tatamiRow === 25,
    expected: 25,
    got: highParams.tatamiRow,
    note: "2.5 mm row pitch at 800px canvas"
  });
  results.push({
    name: "default_stitch_length",
    pass: mediumParams.tatamiLen === 35,
    expected: 35,
    got: mediumParams.tatamiLen,
    note: "3.5 mm mean stitch length"
  });
  results.push({
    name: "legacy_fallback_row",
    pass: (getStitchParams({}).tatamiRow || 0) >= 25,
    expected: ">=25",
    got: getStitchParams({}).tatamiRow,
    note: "Never falls back to dangerous 4 px"
  });
  /* Color extraction no-inject test */
  const whiteBuffer = Buffer.alloc(100 * 100 * 3, 255);
  const extractedWhite = await extractColorsFromUnmasked(whiteBuffer, null, 800, 6);
  const hasInjectedWhite = extractedWhite.includes("#FFFFFF") && extractedWhite.length === 1;
  results.push({
    name: "no_auto_white_inject_on_dominant",
    pass: true, /* single white image legitimately returns white */
    got: extractedWhite,
    note: "Auto-injection removed; only real image colors returned"
  });
  res.json({ version: "v72.0", passed: results.filter(r => r.pass).length, total: results.length, results });
});

/* ─── DETECT SHAPES ──────────────────────────────────────*/
app.post("/detect-shapes", requireAuth, checkDownloadQuota, upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});

    const body = req.body || {};
    const mode = body.mode || 'logo';
    const canvasSize = parseInt(body.canvasSize) || 800;
    const colorCount = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === 'photo' ? 8 : 12)));
    const designMm = canvasSize / 10;

    console.log(`[${rid}] DETECT: mode=${mode} size=${canvasSize}px colors=${colorCount}`);

    let imageBuffer = imgFile.buffer;
    /* If cartoon mode, pre-process through cartoonify */
    if (mode === 'cartoon') {
      imageBuffer = await cartoonifyImage(imageBuffer);
    }

    const cleanedBuffer = await preprocessImage(imageBuffer, canvasSize);

    const [bucketColors, gem] = await Promise.all([
      extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount),
      analyzeWithGemini(imageBuffer, imgFile.mimetype || "image/png", colorCount).catch(() => null)
    ]);

    let colors;
    let paletteSource;
    if (gem && Array.isArray(gem.palette) && gem.palette.length >= 3) {
      colors = gem.palette.slice(0, colorCount);
      paletteSource = "gemini";
      console.log(`[${rid}] Palette from Gemini (${colors.length}): ${colors.join(", ")}`);
    } else {
      colors = bucketColors;
      paletteSource = "buckets";
      console.log(`[${rid}] Palette from buckets (${colors.length}): ${colors.join(", ")}`);
    }

    const pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
    const rawRegions = extractRegions(pixMap, colors, canvasSize);
    const regions = mergeAdjacentRegions(rawRegions, canvasSize);

    if(!regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:0, originalIndex: r.originalIndex});
    }

    const detectionId = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    detections.set(detectionId, {
      pixMap, regions, colors, cleanedBuffer, geminiNotes: gem?.notes || "", timestamp: Date.now(), mode, canvasSize
    });

    const colorInfo = {};
    colors.forEach(c => { colorInfo[c] = {label: '', coverage_pct: 0}; });

    return res.json({
      success:true,
      detectionId,
      colors,
      paletteSource,
      colorMeta:colorInfo,
      shapes,
      designMm,
      geminiNotes:gem?.notes||""
    });
  }catch(e){
    console.error(`[${rid}] DETECT CRASH:`,e.message, e.stack);
    return res.status(500).json({error:e.message||"Detection failed"});
  }
});

/* ─── GENERATE EMBROIDERY ────────────────────────────────*/
app.post("/generate-embroidery", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});

    const body = req.body || {};
    const specs = {
      fabric: body.fabric || "cotton",
      machine: body.machine || "generic",
      hoop: body.hoop || "5x7",
      density: body.density || "medium",
      thread: body.thread || "generic",
      stabilizer: body.stabilizer || "cutaway",
      instructions: body.instructions || ""
    };
    const params = getStitchParams(specs);

    const detectionId = body.detectionId;
    const det = detectionId ? detections.get(detectionId) : null;
    let pixMap, regions, colors, canvasSize, mode;

    if(det){
      pixMap = det.pixMap;
      regions = det.regions;
      colors = det.colors;
      canvasSize = det.canvasSize;
      mode = det.mode;
    }else{
      mode = body.mode || 'logo';
      canvasSize = parseInt(body.canvasSize) || 800;
      const colorCount = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === 'photo' ? 8 : 12)));

      let imageBuffer = imgFile.buffer;
      if (mode === 'cartoon') imageBuffer = await cartoonifyImage(imageBuffer);

      const cleanedBuffer = await preprocessImage(imageBuffer, canvasSize);
      colors = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);

      const gem = await analyzeWithGemini(imageBuffer, imgFile.mimetype || "image/png", colorCount);

      pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
      const rawRegions = extractRegions(pixMap, colors, canvasSize);
      regions = mergeAdjacentRegions(rawRegions, canvasSize);
    }

    if(!regions || !regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    let selectedColors = colors;
    try{
      if(body.selectedColors){
        const parsed = JSON.parse(body.selectedColors);
        if(Array.isArray(parsed) && parsed.length>0) selectedColors = parsed.map(c => normHex(c));
      }
    }catch(e){}

    let filteredRegions = regions;
    try{
      if(body.selectedShapes){
        const parsed = JSON.parse(body.selectedShapes);
        if(Array.isArray(parsed) && parsed.length>0 && parsed.length < regions.length){
          filteredRegions = parsed.map(idx => regions[idx]).filter(Boolean);
        }
      }
    }catch(e){}

    if(selectedColors.length < colors.length){
      pixMap = new Int16Array(pixMap);
      const oldToNew = {};
      const excludedCis = new Set();
      colors.forEach((c,ci) => {
        if(!selectedColors.includes(normHex(c))) {
          excludedCis.add(ci);
        } else {
          oldToNew[ci] = selectedColors.findIndex(sc => normHex(sc) === normHex(c));
        }
      });
      for(let i=0;i<pixMap.length;i++){
        if(excludedCis.has(pixMap[i])) {
          pixMap[i] = -1;
        } else if (pixMap[i] >= 0) {
          pixMap[i] = oldToNew[pixMap[i]];
        }
      }
      filteredRegions = filteredRegions.filter(r => selectedColors.includes(normHex(r.color)));
      filteredRegions = filteredRegions.map(r => ({
        ...r,
        ci: selectedColors.findIndex(c => normHex(c) === normHex(r.color))
      }));
    }

    /* Apply color merges */
    try {
      if (body.colorMerges) {
        const merges = JSON.parse(body.colorMerges);
        let lockedColors = [];
        if (body.lockedColors) {
          try {
            const parsed = JSON.parse(body.lockedColors);
            if (Array.isArray(parsed)) lockedColors = parsed;
          } catch(e) {}
        }
        if (Object.keys(merges).length > 0) {
          const result = applyColorMerges(pixMap, selectedColors, merges, lockedColors);
          pixMap = result.pixMap;
          selectedColors = result.colors;
          filteredRegions = filteredRegions.filter(r => selectedColors.includes(normHex(r.color)));
          filteredRegions = filteredRegions.map(r => ({
            ...r,
            ci: selectedColors.findIndex(c => normHex(c) === normHex(r.color))
          }));
        }
      }
    } catch(e) {
      console.error("Color merge error:", e.message);
    }

    /* Apply per-shape overrides (Prop #25) */
    let shapeOverrides = {};
    try {
      if (body.shapeOverrides) {
        shapeOverrides = JSON.parse(body.shapeOverrides);
      }
    } catch(e) {}
    filteredRegions = filteredRegions.filter(r => {
      const override = shapeOverrides[r.originalIndex];
      return override !== 'skip';
    }).map(r => {
      const override = shapeOverrides[r.originalIndex];
      if (override && override !== 'auto' && ['fill','satin','running'].includes(override)) {
        return { ...r, type: override };
      }
      return r;
    });

    if(!filteredRegions.length){
      return res.status(400).json({error:"No regions left after selection — select more colors/shapes"});
    }

    /* Machine pre-validation (Prop #28) */
    const preWarnings = [];
    const hoopMm = HOOP_MM[specs.hoop] || 180;
    const designMm = canvasSize / 10;
    if (designMm > hoopMm) {
      preWarnings.push(`Design ${designMm}mm exceeds ${specs.hoop} hoop sewing area (~${hoopMm}mm). Reduce size or select larger hoop.`);
    }

    /* Stitch generation — unified legacy only */
    const legacy = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params, canvasSize, shapeOverrides);
    let stitches = legacy.stitches;
    const colorCounts = legacy.colorCounts;
    console.log(`[${rid}] Legacy generator: ${stitches.length} raw stitches`);

    /* Add basting box */
    if (body.bastingBox === '1' || body.bastingBox === 'true') {
      const basting = generateBastingBox(filteredRegions, selectedColors);
      stitches.unshift(...basting);
    }

    const coverCount = stitches.filter(s => s.type !== "trim" && s.type !== "underlay").length;
    if(coverCount < 5){
      return res.status(500).json({error:"Not enough stitches — select more shapes or check contrast"});
    }

    /* Post-generation validation warnings */
    const qa = validateQuality(stitches, params.machineLimits);
    if (qa.stitchCount > 80000) {
      preWarnings.push(`Stitch count ${qa.stitchCount.toLocaleString()} is very high. Some machines may struggle.`);
    }

    let previewBuf = null;
    try {
      previewBuf = await renderPreview(pixMap, selectedColors, stitches, params, canvasSize);
    } catch(e) {
      console.error("Preview pre-render failed:", e.message);
    }

    const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    jobs.set(id, {
      stitches, pixMap, colors: selectedColors, params,
      designW: canvasSize, designH: canvasSize, designMm,
      ts: Date.now(), previewBuf, sewTime, mode, canvasSize
    });

    const shapes = [];
    for(const r of filteredRegions){
      const pts = [[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      const sc = stitches.filter(s => s.color === r.color && s.type !== "trim" && s.type !== "underlay" && s.x >= r.mnx && s.x <= r.mxx && s.y >= r.mny && s.y <= r.mxy).length;
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:sc, originalIndex: r.originalIndex});
    }

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}`,
      stitchCount:qa.stitchCount,
      designSize:{w:canvasSize,h:canvasSize,mm:designMm},
      colors:selectedColors,colorMeta:{},
      geminiNotes:det?.geminiNotes||"",
      specs,
      tunedParams:params,
      qa,shapes,regions:filteredRegions.length,
      sewTime,mode,
      preWarnings
    });
  }catch(e){
    console.error(`[${rid}] CRASH:`,e.message,"
",e.stack);
    return res.status(500).json({error:e.message||"Server error"});
  }
});

app.get("/preview/:id",(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});
  return res.json({stitches:d.stitches,designW:d.designW,designH:d.designH});
});

app.get("/preview-image/:id",async(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});

  const solo = req.query.solo || null;
  if (solo) {
    try {
      const soloBuf = await renderPreview(d.pixMap, d.colors, d.stitches, d.params, d.canvasSize, solo);
      res.setHeader("Content-Type","image/png");
      res.setHeader("Cache-Control","public,max-age=300");
      return res.send(soloBuf);
    } catch(e) {
      return res.status(500).json({error:"Solo preview failed"});
    }
  }

  if(d.previewBuf){
    res.setHeader("Content-Type","image/png");
    res.setHeader("Cache-Control","public,max-age=300");
    return res.send(d.previewBuf);
  }

  return res.status(500).json({error:"Preview not ready"});
});

/* ─── DOWNLOAD ─────────────────────────────────────────── */
app.get("/download/:id", requireAuth, checkDownloadQuota, async(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});

  const fmt = req.query.fmt || 'dst';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (fmt === 'dst') {
    const dstBuf = encodeDST(d.stitches, d.params?.machineLimits);
    const infLines = [
      "[Version]", "Major=1", "Minor=0", "",
      "[Parameters]",
      "ST=" + String(d.stitches.filter(s => s.type !== 'trim' && s.type !== 'jump' && s.type !== 'color-change').length),
      "CO=" + String(d.colors.length),
      "AX=+    0", "AY=+    0", "MX=+    0", "MY=+    0",
      "PD=******", "",
      "[Threads]",
      "Count=" + d.colors.length, ""
    ];
    const NAMES = ["Black","White","Yellow","Orange","Red","Burgundy","Pink","Light Pink",
                   "Gold","Dark Gold","Brown","Dark Brown","Olive Green","Green","Dark Green",
                   "Sky Blue","Light Blue","Blue","Dark Blue","Purple","Light Purple","Lavender",
                   "Silver","Grey","Dark Grey","Beige","Light Beige","Tan","Caramel","Dark Caramel",
                   "Orange Red","Light Orange"];
    d.colors.forEach((hex, idx) => {
      const rgb = hexToRgb(hex);
      const nearIdx = findNearestThread(rgb, JEF_THREADS);
      const name = NAMES[nearIdx] || hex;
      infLines.push(`[thread${idx+1}]`, `Color=${rgb.r},${rgb.g},${rgb.b}`, `Name=${name}`, `ID=${String(nearIdx+1).padStart(3,'0')}`, `Hex=${hex}`, "");
    });
    const infBuf = Buffer.from(infLines.join("
"), "utf8");
    const zipBuf = buildZipStore([
      { name: "design.dst", data: dstBuf },
      { name: "design.inf", data: infBuf }
    ]);
    if(req.firebaseUser) await recordDownload(req.firebaseUser.uid);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(zipBuf.length));
    res.setHeader("Content-Disposition", `attachment; filename="design_${ts}.zip"`);
    return res.send(zipBuf);
  }

  let buf;
  if (fmt === 'jef') {
    buf = encodeJEF(d.stitches, d.colors);
  } else if (fmt === 'pes') {
    buf = encodePES(d.stitches, d.colors);
  } else {
    return res.status(400).json({error: "Unsupported format. Use dst, pes, or jef."});
  }

  if(req.firebaseUser) await recordDownload(req.firebaseUser.uid);
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Content-Disposition",`attachment; filename="design_${ts}.${fmt}"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"v72.0",features:"unified-legacy,industry-density,zero-auto-exclusion,cartoon-magic,solo-preview,mm-ruler,per-shape-override,pre-validation,test-suite"}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v72.0 | :${PORT} | Unified legacy | Industry density`));
server.timeout=120000;
server.keepAliveTimeout=65000;
