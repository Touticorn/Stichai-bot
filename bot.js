/**
 * Stichai v62 — Fix color index crash + mask aspect ratio
 * ═══════════════════════════════════════════════════════════════════
 *  FIXES FROM v47
 *  ──────────────────────────────────────────────────────────────
 *  1. When selectedColors < full palette, regions' ci is re-indexed
 *     to match the new shortened palette before stitch generation.
 *  2. Frontend initMask uses contain-fit with white background,
 *     matching server preprocessing exactly.
 */

"use strict";

const express  = require("express");
const multer   = require("multer");
const axios    = require("axios");
const path     = require("path");
const sharp    = require("sharp");
const admin    = require("firebase-admin");
const Stripe   = require("stripe");

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

/* ═══════════════════════════════════════════════════════════
   FIREBASE ADMIN  — verifies Google / Facebook / Email JWT
   Env var: FIREBASE_SERVICE_ACCOUNT = the full JSON string
   from Firebase Console → Project Settings → Service Accounts
   ═══════════════════════════════════════════════════════════ */
let fbReady = false;
let db = null;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
    db = admin.firestore();
    fbReady = true;
    console.log("Firebase Admin ready");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT not set — auth disabled");
  }
} catch(e) { console.error("Firebase init error:", e.message); }

/* ═══════════════════════════════════════════════════════════
   STRIPE  — subscription billing
   Env vars:
     STRIPE_SECRET_KEY          sk_live_...
     STRIPE_WEBHOOK_SECRET      whsec_...
     STRIPE_PRICE_SIMPLE_M / _Y
     STRIPE_PRICE_PRO_M / _Y
     STRIPE_PRICE_PROMAX_M / _Y
     APP_URL                    https://stichai.pro
   ═══════════════════════════════════════════════════════════ */
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ─── PLANS ─────────────────────────────────────────────────
   period = day | week | month
   downloadsPerPeriod = null means unlimited
   ─────────────────────────────────────────────────────────── */
const PLANS = {
  none:    { label:"No plan",  downloadsPerPeriod: 0,    period:"day"  },
  trial:   { label:"Trial",    downloadsPerPeriod: 1,    period:"day",  trialDays:7 },
  simple:  { label:"Simple",   downloadsPerPeriod: 7,    period:"week" },
  pro:     { label:"Pro",      downloadsPerPeriod: 30,   period:"week" },
  promax:  { label:"Pro Max",  downloadsPerPeriod: null, period:"month"},
};

/* Price key → { stripeId, plan, label, price } */
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
   USER HELPERS  (Firestore)
   ═══════════════════════════════════════════════════════════ */

function getPeriodStart(period) {
  const now = new Date();
  if (period === "day") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  if (period === "week") {
    const d = now.getUTCDay();               // 0=Sun … 6=Sat; Monday=1
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
  if (plan.downloadsPerPeriod === null) return;       // unlimited — nothing to track
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
  if (!fbReady) return next();          // auth disabled in dev mode
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
  if (!fbReady) return next();          // auth disabled in dev mode
  const result = checkQuota(req.userDoc);
  if (!result.allowed) {
    return res.status(403).json({ error:result.reason, upgrade:true });
  }
  req.quotaRemaining = result.remaining;
  next();
}

/* Stripe webhook needs raw body — register BEFORE express.json() */
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

    /* Update user plan on subscription events */
    const handleSub = async (sub, active) => {
      if (!db) return;
      // Find user by stripeCustomerId
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
const DST_MAX      = 121;
const SMART_TRIM   = 30;
const MIN_AREA     = 25;
const PREVIEW_MAX  = 1200;

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

/* ─── SPEC TUNING ─────────────────────────────────────────*/
function getStitchParams(specs) {
  const s = specs || {};
  const fabric     = (s.fabric     || "cotton" ).toLowerCase();
  const density    = (s.density    || "medium" ).toLowerCase();
  const machine    = (s.machine    || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();
  const hoop       = (s.hoop       || "5x7"   ).toLowerCase();

  const p = {
    tatamiRow: 4, tatamiLen: 30, tatamiUl: 40, pull: 2, pullComp: 2,
    maxJumpMm: 12, minStitchMm: 0.3,
    machine, fabric, stabilizer, density, hoop, maxStitchLen: 121
  };

  // ── Fabric presets ──────────────────────────────────────────
  const fabricMap = {
    cotton:  { pull: 2, pullComp: 2, tatamiRow: 4, tatamiUl: 40, tatamiLen: 30 },
    denim:   { pull: 4, pullComp: 3, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    fleece:  { pull: 5, pullComp: 4, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
    pique:   { pull: 3, pullComp: 2, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    twill:   { pull: 4, pullComp: 3, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    satin:   { pull: 1, pullComp: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    leather: { pull: 1, pullComp: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    towel:   { pull: 6, pullComp: 5, tatamiRow: 2, tatamiUl: 20, tatamiLen: 20 },
    canvas:  { pull: 4, pullComp: 3, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    knit:    { pull: 5, pullComp: 4, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
  };
  Object.assign(p, fabricMap[fabric] || fabricMap.cotton);

  // ── Density ─────────────────────────────────────────────────
  const densityMap = {
    low:  { tatamiRow: 6, tatamiLen: 40, tatamiUl: 60 },
    high: { tatamiRow: 2, tatamiLen: 20, tatamiUl: 25, pullComp: Math.max(1, p.pullComp - 1) },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  // ── Stabilizer ──────────────────────────────────────────────
  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull     = Math.max(1,  p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }
  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(2, p.tatamiRow);
    p.tatamiUl  = Math.max(20, p.tatamiUl);
  }

  // ── Machine brand ────────────────────────────────────────────
  // Each machine has different jump handling and stitch speed limits.
  // These affect the optimizer thresholds and small-stitch filter.
  const machineMap = {
    tajima:  { maxJumpMm: 12.1, minStitchMm: 0.3, maxStitchLen: 121 },
    brother: { maxJumpMm: 12.7, minStitchMm: 0.4, maxStitchLen: 127 },  // PE-series
    barudan: { maxJumpMm: 12.1, minStitchMm: 0.3, maxStitchLen: 121 },
    janome:  { maxJumpMm: 12.7, minStitchMm: 0.4, maxStitchLen: 127 },
    singer:  { maxJumpMm: 10.0, minStitchMm: 0.5, maxStitchLen: 100 },
    generic: { maxJumpMm: 12.0, minStitchMm: 0.4, maxStitchLen: 120 },
  };
  Object.assign(p, machineMap[machine] || machineMap.generic);

  // ── Hoop size — clamp pull comp to avoid over-expansion ──────
  // Larger hoops tolerate more pull; smaller hoops need tighter control
  const hoopMap = {
    "4x4":  { pullComp: Math.min(p.pullComp, 1) },   // tiny hoop — minimal expansion
    "5x7":  { },                                       // default — no change
    "6x10": { pullComp: Math.min(p.pullComp + 1, 5) },
    "8x8":  { pullComp: Math.min(p.pullComp + 1, 5) },
    "8x12": { pullComp: Math.min(p.pullComp + 1, 6) },
  };
  if (hoopMap[hoop]) Object.assign(p, hoopMap[hoop]);

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

/* ─── MASK-AWARE DIVERSITY COLOR EXTRACTION ──────────────*/
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
  
  const MIN_DIST = 15;
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
  
  if (selected.length < maxColors) {
    const paletteLabs = selected.map(s => s.lab);
    const outliers = [];
    
    for (let i = 0; i < analysisSize * analysisSize; i++) {
      const iOff = i * iCh;
      if (mData) {
        const mOff = i * mCh;
        if (mData[mOff] > 140 && mData[mOff+1] < 90 && mData[mOff+2] < 90 && (mCh < 4 || mData[mOff+3] > 30)) continue;
      }
      
      const r = iData[iOff], g = iData[iOff+1], b = iData[iOff+2];
      const lab = rgbToLab({r, g, b});
      const minDist = Math.min(...paletteLabs.map(pl => dE(lab, pl)));
      
      if (minDist > 25) {
        outliers.push({ r, g, b, dist: minDist });
      }
    }
    
    const outlierGroups = new Map();
    for (const o of outliers) {
      const key = (Math.round(o.r/32)*32 << 16) | (Math.round(o.g/32)*32 << 8) | Math.round(o.b/32)*32;
      if (!outlierGroups.has(key)) outlierGroups.set(key, { r: 0, g: 0, b: 0, n: 0, maxDist: 0 });
      const g = outlierGroups.get(key);
      g.r += o.r; g.g += o.g; g.b += o.b; g.n++;
      if (o.dist > g.maxDist) g.maxDist = o.dist;
    }
    
    const outlierBuckets = [...outlierGroups.entries()]
      .map(([_, v]) => ({
        hex: normHex("#" + [Math.round(v.r/v.n), Math.round(v.g/v.n), Math.round(v.b/v.n)]
          .map(c => c.toString(16).padStart(2,"0")).join("")),
        lab: rgbToLab({r: Math.round(v.r/v.n), g: Math.round(v.g/v.n), b: Math.round(v.b/v.n)}),
        maxDist: v.maxDist
      }))
      .filter(b => !selected.some(s => dE(b.lab, s.lab) < MIN_DIST))
      .sort((a, b) => b.maxDist - a.maxDist);
    
    for (const bucket of outlierBuckets) {
      if (selected.length >= maxColors) break;
      selected.push(bucket);
    }
  }
  
  let brightCount = 0, darkCount = 0;
  for (let i = 0; i < analysisSize * analysisSize; i++) {
    if (mData) {
      const mOff = i * mCh;
      if (mData[mOff] > 140 && mData[mOff+1] < 90 && mData[mOff+2] < 90 && (mCh < 4 || mData[mOff+3] > 30)) continue;
    }
    const iOff = i * iCh;
    if (iData[iOff] > 240 && iData[iOff+1] > 240 && iData[iOff+2] > 240) brightCount++;
    if (iData[iOff] < 30 && iData[iOff+1] < 30 && iData[iOff+2] < 30) darkCount++;
  }
  
  const result = selected.map(s => s.hex);
  
  if (!result.some(c => isNearWhite(c)) && brightCount / totalUnmasked > 0.01) {
    result.unshift('#FFFFFF');
    if (result.length > maxColors) result.pop();
  }
  if (!result.some(c => isNearBlack(c)) && darkCount / totalUnmasked > 0.01) {
    result.push('#000000');
    if (result.length > maxColors) result.shift();
  }
  
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

/* ─── GEMINI (metadata only) ─────────────────────────────*/
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
Analyze this image for embroidery. The user wants approximately ${colorCount} thread colors.
Return ONLY valid JSON, no markdown.

{"is_logo":true,"is_text":true,"complexity":"moderate","recommended_angle":0,"notes":"brief note"}`;

  const res = await geminiPost({
    contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
    generationConfig:{temperature:0.0,maxOutputTokens:1024}
  });
  if(!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    let js = raw.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    return JSON.parse(js);
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

/* ─── REGION EXTRACTION ──────────────────────────────────*/
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

        if(area<MIN_AREA)continue;

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
        if(area < MIN_AREA * 3) type = "running";
        else if(aspectRatio > 2.5 && avgRunW <= 18 && solidity > 0.4) type = "satin";
        else if(avgRunW > 3 && avgRunW <= 14 && solidity > 0.5 && aspectRatio > 1.5) type = "satin";
        else type = "fill";

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity,avgRunW});
      }
    }
  }

  console.log(`Regions (raw): ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  return regions;
}

/* ─── MERGE ADJACENT FRAGMENTS ───────────────────────────*/
function mergeAdjacentRegions(regions) {
  if(!regions.length) return regions;
  const merged = [];
  const used = new Set();

  for(let i=0;i<regions.length;i++){
    if(used.has(i)) continue;
    const base = regions[i];
    let mnx=base.mnx, mny=base.mny, mxx=base.mxx, mxy=base.mxy, area=base.area;
    let totalRunW = base.avgRunW * base.bh;
    let runCount = base.bh;
    used.add(i);

    for(let j=i+1;j<regions.length;j++){
      if(used.has(j)) continue;
      const other = regions[j];
      if(other.color !== base.color) continue;

      const gap = 1;
      const overlapX = !(mxx + gap < other.mnx || other.mxx + gap < mnx);
      const overlapY = !(mxy + gap < other.mny || other.mxy + gap < mny);

      if(overlapX && overlapY){
        mnx = Math.min(mnx, other.mnx);
        mny = Math.min(mny, other.mny);
        mxx = Math.max(mxx, other.mxx);
        mxy = Math.max(mxy, other.mxy);
        area += other.area;
        totalRunW += other.avgRunW * other.bh;
        runCount += other.bh;
        used.add(j);
      }
    }

    const newBw = mxx-mnx+1, newBh = mxy-mny+1;
    const newAvgRunW = runCount > 0 ? totalRunW / runCount : newBw;
    const newAspect = newBh / Math.max(newBw, 1);
    const newSolidity = area / (newBw * newBh);

    let newType;
    if(area < MIN_AREA * 3) newType = "running";
    else if(newAspect > 2.5 && newAvgRunW <= 18 && newSolidity > 0.4) newType = "satin";
    else if(newAvgRunW > 3 && newAvgRunW <= 14 && newSolidity > 0.5 && newAspect > 1.5) newType = "satin";
    else newType = "fill";

    merged.push({
      ci: base.ci, color: base.color, type: newType,
      mnx, mny, mxx, mxy,
      bw: newBw, bh: newBh, area,
      aspectRatio: newAspect, solidity: newSolidity, avgRunW: newAvgRunW
    });
  }

  console.log(`Regions (merged): ${merged.length}`);
  return merged;
}

/* ─── BRIDGE CONNECTOR (v60) ─────────────────────────────*/
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
  const steps = Math.max(1, Math.ceil(dist / 8)); // 0.8mm bridge stitches
  const stitches = [];
  for (let i = 1; i <= steps; i++) {
    const fx = Math.round(fromX + dx * i / steps);
    const fy = Math.round(fromY + dy * i / steps);
    stitches.push({x: fx, y: fy, color, type: "bridge"});
  }
  return stitches;
}

/* ─── STITCH GENERATION (v60 — absolute coordinates) ───────*/
/* ─── COLUMN-WISE SCANNING (for vertical fill of tall regions) ──── */
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

/* ─── EDGE WALK UNDERLAY: trace perimeter at offset inward ─────── */
function generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, stepPx, insetPx) {
  // Sample edge pixels around perimeter and order them as a walking path
  const {mnx, mny, mxx, mxy} = reg;
  const edges = [];
  // Walk perimeter by raster-scanning rows, picking left+right edges per row
  for (let y = mny; y <= mxy; y += 2) {
    const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
    for (const {x1, x2} of runs) {
      edges.push({x: x1 + insetPx, y});
      if (x2 - x1 > 2 * insetPx) edges.push({x: x2 - insetPx, y});
    }
  }
  if (edges.length === 0) return [];
  // Order edges into a single walk path (top edge L->R, right edge T->B, bottom R->L, left B->T)
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const sorted = edges.slice().sort((a, b) => {
    const aa = Math.atan2(a.y - cy, a.x - cx);
    const ab = Math.atan2(b.y - cy, b.x - cx);
    return aa - ab;
  });
  // Downsample so stitches are roughly stepPx apart
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

/* ─── ZIGZAG CENTER-WALK UNDERLAY at 45° ─────────────────────────── */
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
      if (w < 6) continue;          // too narrow for useful underlay
      const sx = rev ? x2 - 2 : x1 + 2;
      const ex = rev ? x1 + 2 : x2 - 2;
      // Break long spans into stitches at stitchLen intervals
      const dist = Math.abs(ex - sx);
      const steps = Math.max(1, Math.round(dist / stitchLen));
      for (let s = 0; s <= steps; s++) {
        const fx = Math.round(sx + (ex - sx) * s / steps);
        // Apply 45° zigzag (offset y by sin)
        const zy = y + ((s % 2) ? 2 : -2);
        out.push({x: fx, y: zy, color, type: "underlay"});
      }
    }
    rowI++;
  }
  return out;
}

/* ─── TIE-IN / TIE-OFF: 3 short anchor stitches ─────────────────── */
function generateTieStitches(x, y, color, dirX, dirY) {
  const stitches = [];
  // 3 short alternating stitches in the dir direction (forward / back / forward, ~1.5mm)
  const off = 15;  // 1.5mm in 0.1mm units
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  stitches.push({x: x - dirX * off / 2, y: y - dirY * off / 2, color, type: "tie"});
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  return stitches;
}

/* ═══════════════════════════════════════════════════════════════════
   PROFESSIONAL STITCH GENERATOR  (v66)
   • Edge walk underlay (running stitch around perimeter)
   • Zigzag center-walk underlay at offset angle
   • Pull compensation (expand fill bounds)
   • Vertical fill for tall regions, horizontal for wide
   • Tie-in / tie-off stitches at color changes
   ═══════════════════════════════════════════════════════════════════ */
function generateStitchesFromRegions(pixMap, regions, colors, params, canvasSize) {
  const stitches = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));

  const P = params || {};
  const pRow      = P.tatamiRow !== undefined ? P.tatamiRow : 4;
  const pLen      = P.tatamiLen !== undefined ? P.tatamiLen : 30;
  const pPull     = P.pull      !== undefined ? P.pull      : 2;
  const pPullComp = P.pullComp  !== undefined ? P.pullComp  : 2;   // pull compensation in 0.1mm units
  const pEdgeUL   = 18;  // edge walk underlay step (~1.8mm between stitches)
  const pZigUL    = 28;  // zigzag underlay row spacing (~2.8mm)
  const pZigLen   = 40;  // zigzag underlay stitch length (~4mm)

  // Precompute edge pixels per region for bridge logic
  const edgePixels = new Map();
  for (const reg of regions) {
    edgePixels.set(reg, getEdgePixels(pixMap, reg, canvasSize));
  }

  // Group regions by COLOR first, then type within each color.
  // Critical: machine must finish ALL regions of one color before switching thread.
  // Wrong order forces operator to re-thread colors they already finished.
  // Order within each color: fill → satin → running (underlay before detail work).
  const byColor = new Map();
  for (const reg of regions) {
    const ck = normHex(reg.color);
    if (!byColor.has(ck)) byColor.set(ck, []);
    byColor.get(ck).push(reg);
  }
  const ordered = [];
  // Respect the user's color selection order from the UI
  const colorOrder = colors.map(c => normHex(c));
  for (const ck of colorOrder) {
    const regsForColor = byColor.get(ck);
    if (!regsForColor) continue;
    for (const type of ['fill', 'satin', 'running']) {
      const grp = regsForColor.filter(r => r.type === type);
      if (grp.length) ordered.push(...sortRegionsNearestNeighbor(grp));
    }
  }
  // Safety: catch any regions whose color wasn't in the palette
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
    const isColorChange = prevColor !== null && normHex(prevColor) !== normHex(color);
    let lastX = globalLastX, lastY = globalLastY;

    // ─── Move to entry point of region ─────────────────────────
    if (lastX !== -1 && ri > 0) {
      const prevReg = ordered[ri - 1];
      if (normHex(prevReg.color) === normHex(reg.color)) {
        // Same color — bridge between closest edges
        const pair = findClosestPair(edgePixels.get(prevReg), edgePixels.get(reg));
        const bridge = generateBridgeStitches(lastX, lastY, pair.to.x, pair.to.y, color);
        stitches.push(...bridge);
        lastX = pair.to.x; lastY = pair.to.y;
      } else {
        // Color change — TIE-OFF previous + trim + TIE-IN new
        stitches.push(...generateTieStitches(lastX, lastY, prevColor, -1, 0));
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        const entryEdge = edgePixels.get(reg);
        const entry = entryEdge[Math.floor(entryEdge.length / 2)];
        const bridge = generateBridgeStitches(lastX, lastY, entry.x, entry.y, color);
        stitches.push(...bridge);
        lastX = entry.x; lastY = entry.y;
        // TIE-IN at start of new color
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    } else {
      const entryEdge = edgePixels.get(reg);
      const entry = entryEdge[Math.floor(entryEdge.length / 2)];
      lastX = entry.x; lastY = entry.y;
      if (ri === 0) {
        // TIE-IN on first stitch of design
        stitches.push(...generateTieStitches(lastX, lastY, color, 1, 0));
      }
    }

    // ─── UNDERLAY for fill regions (edge walk + zigzag) ────────
    if (type === "fill") {
      // 1. Edge walk — outline runner
      const edgeWalk = generateEdgeWalkUnderlay(pixMap, reg, ci, canvasSize, color, pEdgeUL, Math.max(2, pPull));
      if (edgeWalk.length) {
        // Bridge from current pos to start of edge walk
        const start = edgeWalk[0];
        if (Math.hypot(start.x - lastX, start.y - lastY) > 30) {
          stitches.push(...generateBridgeStitches(lastX, lastY, start.x, start.y, color));
        }
        stitches.push(...edgeWalk);
        lastX = edgeWalk[edgeWalk.length - 1].x;
        lastY = edgeWalk[edgeWalk.length - 1].y;
        colorCounts[ci].underlay += edgeWalk.length;
      }
      // 2. Zigzag center walk
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

    // ─── DECIDE FILL DIRECTION based on region aspect ─────────
    // Tall narrow region → scan vertically (90° fill angle)
    // Wide region → scan horizontally (0° fill angle, default)
    const useVerticalScan = (type === "fill") && (regH > regW * 1.4);

    // Reset lastX/lastY tracking so first stitch is the entry, not chained from underlay
    let lx = lastX, ly = lastY;

    if (useVerticalScan) {
      // ─── VERTICAL FILL (column-by-column scan) ──────────────
      let colIdx = 0;
      for (let x = mnx; x <= mxx; x += pRow) {
        const runs = getRunsInCol(pixMap, ci, x, mny, mxy, canvasSize);
        if (!runs.length) continue;
        const rev = colIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;
        for (const {y1, y2} of ord) {
          const ay1 = y1 + pPull - pPullComp;     // pull compensation: extend slightly
          const ay2 = y2 - pPull + pPullComp;
          const brickOff = colIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
          const ly1 = ay1 + brickOff;
          if (ay2 <= ly1) {
            stitches.push({x, y: Math.round((y1 + y2) / 2), color, type: "fill"});
            colorCounts[ci].fill++;
            lx = x; ly = Math.round((y1 + y2) / 2);
          } else {
            const steps = Math.max(1, Math.round((ay2 - ly1) / pLen));
            const sy = rev ? ay2 : ly1, ey = rev ? ly1 : ay2;
            for (let s = 0; s <= steps; s++) {
              const fy = Math.round(sy + (ey - sy) * s / steps);
              stitches.push({x, y: fy, color, type: "fill"});
              colorCounts[ci].fill++;
            }
            lx = x; ly = Math.round(ey);
          }
        }
        colIdx++;
      }
    } else {
      // ─── HORIZONTAL FILL / SATIN / RUNNING ─────────────────
      let rowIdx = 0;
      for (let y = mny; y <= mxy; y += pRow) {
        const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
        if (!runs.length) continue;
        const rev = rowIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;

        for (const {x1, x2} of ord) {
          const jx = rev ? x2 : x1;

          if (type === "running") {
            const rx = Math.round((x1 + x2) / 2);
            stitches.push({x: rx, y, color, type: "running"});
            colorCounts[ci].running++;
            lx = rx; ly = y;

          } else if (type === "satin") {
            // Satin with pull compensation
            const sx = rev ? x2 - pPull + pPullComp : x1 + pPull - pPullComp;
            const ex = rev ? x1 + pPull - pPullComp : x2 - pPull + pPullComp;
            if (Math.abs(ex - sx) > 1) {
              stitches.push({x: sx, y, color, type: "satin"});
              stitches.push({x: ex, y, color, type: "satin"});
              colorCounts[ci].satin += 2;
              lx = ex; ly = y;
            } else {
              const rx = Math.round((x1 + x2) / 2);
              stitches.push({x: rx, y, color, type: "satin"});
              colorCounts[ci].satin++;
              lx = rx; ly = y;
            }

          } else {
            // FILL with pull compensation and brick pattern
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
            } else {
              stitches.push({x: Math.round((x1 + x2) / 2), y, color, type: "fill"});
              colorCounts[ci].fill++;
              lx = Math.round((x1 + x2) / 2); ly = y;
            }
          }
        }
        rowIdx++;
      }
    }

    globalLastX = lx;
    globalLastY = ly;
    prevColor = color;
  }

  // Final tie-off at end of design
  if (globalLastX !== -1 && prevColor !== null) {
    stitches.push(...generateTieStitches(globalLastX, globalLastY, prevColor, -1, 0));
  }

  console.log("Stitches:", colors.map((c, i) => {
    const k = colorCounts[i];
    return `${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running} ul:${k.underlay}`;
  }).join(" | "));

  return {stitches, colorCounts};
}
/* ═══════════════════════════════════════════════════════════════════
   POST-PROCESSING PASSES (v68)
   • optimizeJumps     — convert short jumps to stitches, split long jumps
   • filterSmallStitch — drop stitches < 3 DST units (0.3mm)
   • addBastingBox     — running-stitch rectangle around design
   ═══════════════════════════════════════════════════════════════════ */

/* Small-stitch filter: drops consecutive stitches closer than minDist (in 0.1mm units).
   Critical for Tajima — sub-0.3mm stitches cause needle bunching and thread breaks. */
function filterSmallStitches(stitches, minDist) {
  if (!minDist || minDist <= 0) return stitches;
  const out = [];
  let prev = null;
  for (const s of stitches) {
    // Always keep trims, color changes, and ties
    if (s.type === "trim" || s.type === "tie" || s.type === "bridge" || s.type === "jump") {
      out.push(s); prev = s; continue;
    }
    if (!prev) { out.push(s); prev = s; continue; }
    // Different color = effectively a color-change boundary, keep it
    if (s.color !== prev.color) { out.push(s); prev = s; continue; }
    const d = Math.hypot(s.x - prev.x, s.y - prev.y);
    if (d < minDist) continue;           // drop this stitch
    out.push(s); prev = s;
  }
  return out;
}

/* Jump optimizer: classify every gap between consecutive same-color stitches.
   • gap < shortMm  → convert any "trim/bridge/jump" to regular stitch (no thread cut)
   • gap > longMm   → mark as explicit "trim" (machine cuts thread)
   • intermediate gaps stay as-is. Different-color transitions always trim. */
function optimizeJumps(stitches, shortMm, longMm) {
  const shortPx = shortMm * 10;
  const longPx  = longMm  * 10;
  const out = [];
  let prev = null;
  for (const s of stitches) {
    if (!prev) { out.push(s); prev = s; continue; }
    const dx = s.x - prev.x, dy = s.y - prev.y;
    const d  = Math.hypot(dx, dy);
    const isColorChange = s.color !== prev.color;

    if (isColorChange) {
      // Color change always needs explicit trim
      if (s.type !== "trim") out.push({...s, type: "trim"});
      else out.push(s);
      prev = s; continue;
    }

    // Same-color gap
    if (d < shortPx) {
      // Short hop — strip jump/trim/bridge flag, make it a normal stitch
      if (s.type === "trim" || s.type === "bridge" || s.type === "jump") {
        out.push({...s, type: "stitch"});
      } else {
        out.push(s);
      }
    } else if (d > longPx) {
      // Long gap that wasn't already a trim — force a trim
      if (s.type !== "trim") out.push({...s, type: "trim"});
      else out.push(s);
    } else {
      out.push(s);
    }
    prev = s;
  }
  return out;
}

/* Basting box: running-stitch rectangle around the entire design extents.
   Stitched FIRST, in the first color of the design, then trimmed before
   real stitching starts. Allows operator to verify hoop placement & attach
   stabilizer cleanly. Offset = 5mm outside the design bounds.
   stepMm = stitch length along the perimeter (4mm default). */
function addBastingBox(stitches, offsetMm, stepMm) {
  if (!stitches.length) return stitches;
  // Compute design bounds
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const s of stitches) {
    if (s.type === "trim") continue;
    if (s.x < mnx) mnx = s.x;
    if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y;
    if (s.y > mxy) mxy = s.y;
  }
  if (mnx === Infinity) return stitches;

  const off  = offsetMm * 10;
  const step = stepMm * 10;
  const x1 = Math.round(mnx - off), y1 = Math.round(mny - off);
  const x2 = Math.round(mxx + off), y2 = Math.round(mxy + off);
  const color = stitches[0].color;

  const box = [];
  const seg = (sx, sy, ex, ey) => {
    const dist = Math.hypot(ex - sx, ey - sy);
    const n = Math.max(1, Math.round(dist / step));
    for (let i = 0; i <= n; i++) {
      box.push({
        x: Math.round(sx + (ex - sx) * i / n),
        y: Math.round(sy + (ey - sy) * i / n),
        color, type: "basting"
      });
    }
  };
  // Move to start corner with a jump
  box.push({x: x1, y: y1, color, type: "trim"});
  seg(x1, y1, x2, y1);   // top
  seg(x2, y1, x2, y2);   // right
  seg(x2, y2, x1, y2);   // bottom
  seg(x1, y2, x1, y1);   // left
  // Trim before main design starts
  box.push({x: x1, y: y1, color, type: "trim"});
  return [...box, ...stitches];
}

/* ═══════════════════════════════════════════════════════════════════
   PES ENCODER (Brother / Babylock)
   Format spec: PES v6 wrapper around a PEC stitch block.
   PEC uses the SAME bit layout idea as DST but with different opcodes:
     • Each stitch = 2 bytes (one for X, one for Y) when |dx|,|dy| ≤ 63
     • Otherwise 4 bytes with two flag bits in the high nibble
   This implementation produces a minimal but valid v1 PES that all
   modern Brother/Babylock machines (PE-Design, PE800, V3+) accept.
   ═══════════════════════════════════════════════════════════════════ */

// Brother 64-color thread palette (subset — closest match by RGB)
const PEC_PALETTE = [
  null, [0x14,0x16,0x21], [0x21,0x39,0x44], [0xff,0xff,0xff], [0xed,0xed,0xed],
  [0xb4,0xb4,0xb4], [0x73,0x73,0x73], [0x33,0x33,0x33], [0xff,0xff,0xff],
  [0xed,0xed,0xed], [0xb4,0xb4,0xb4], [0x73,0x73,0x73], [0x33,0x33,0x33],
  [0xff,0x00,0x00], [0xc4,0x18,0x18], [0x77,0x14,0x18], [0xff,0xa0,0x00],
  [0xff,0xee,0x00], [0xff,0xff,0x00], [0xe6,0xff,0x00], [0x99,0xcc,0x33],
  [0x00,0x80,0x00], [0x00,0x40,0x00], [0x00,0xff,0x00], [0x33,0xee,0x33],
  [0x00,0x99,0x66], [0x00,0xff,0xff], [0x00,0x99,0xff], [0x00,0x66,0xff],
  [0x00,0x00,0xff], [0x00,0x00,0x99], [0x99,0x00,0xff], [0xff,0x00,0xff],
  [0xff,0x66,0xcc], [0xcc,0x66,0x99], [0xff,0xcc,0xcc], [0x99,0x66,0x33],
  [0x66,0x33,0x00], [0xcc,0x99,0x66], [0xff,0xcc,0x99],
];
function nearestPecColor(hex) {
  const {r, g, b} = hexToRgb(hex);
  let bi = 1, bd = Infinity;
  for (let i = 1; i < PEC_PALETTE.length; i++) {
    const c = PEC_PALETTE[i]; if (!c) continue;
    const d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

function encodePEC_stitches(stitches) {
  // Compute bounds in image coords
  let mnx=Infinity, mxx=-Infinity, mny=Infinity, mxy=-Infinity;
  for (const s of stitches) {
    if (s.x < mnx) mnx = s.x; if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y; if (s.y > mxy) mxy = s.y;
  }
  if (mnx === Infinity) { mnx=mxx=mny=mxy=0; }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;

  const out = [];
  let px = 0, py = 0;
  let lastColor = null;

  const emitMove = (dx, dy, isJump) => {
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx >= -63 && dx <= 63 && dy >= -63 && dy <= 63 && !isJump) {
      // Short form: 1 byte each
      out.push(dx & 0x7F);
      out.push(dy & 0x7F);
    } else {
      // Long form: 12-bit signed packed in 2 bytes each, with flag bit
      const writeLong = (v, isJumpFlag) => {
        v = Math.max(-2048, Math.min(2047, v));
        const high = ((v >> 8) & 0x0F) | 0x80;     // high nibble + bit 7 set
        const low  = v & 0xFF;
        out.push(high | (isJumpFlag ? 0x20 : 0));
        out.push(low);
      };
      writeLong(dx, isJump);
      writeLong(dy, isJump);
    }
  };

  for (const s of stitches) {
    if (s.color !== lastColor && lastColor !== null) {
      // Color change: 0xFE 0xB0 <palette_idx>
      out.push(0xFE, 0xB0, 0x01);
    }
    lastColor = s.color;
    const tx = Math.round(s.x - cx);
    const ty = Math.round(-(s.y - cy));       // PEC y-axis inverted
    const dx = tx - px;
    const dy = ty - py;
    const isJump = (s.type === "trim" || s.type === "jump" || s.type === "bridge");
    emitMove(dx, dy, isJump);
    px = tx; py = ty;
  }
  // End marker
  out.push(0xFF, 0x00);
  return { stitchBytes: Buffer.from(out), bounds: {mnx, mxx, mny, mxy} };
}

function encodePES(stitches) {
  // Compute color list (unique colors in order they appear)
  const colorList = [];
  const seen = new Set();
  for (const s of stitches) {
    if (!seen.has(s.color)) { seen.add(s.color); colorList.push(s.color); }
  }

  const { stitchBytes, bounds } = encodePEC_stitches(stitches);
  const width  = Math.round(bounds.mxx - bounds.mnx);
  const height = Math.round(bounds.mxy - bounds.mny);

  // ── PES header (v1 minimal) ───────────────────────────
  const pesHdr = Buffer.alloc(48 + colorList.length);
  pesHdr.write("#PES0001", 0, "ascii");
  // PEC start offset — placeholder, will fix after we know section sizes
  pesHdr.writeUInt32LE(0, 8);     // PEC start (filled later)
  // Minimal section markers
  pesHdr.writeUInt16LE(0x0001, 12);  // 1 hoop
  pesHdr.writeUInt16LE(0x0001, 14);  // CSewSeg count
  // Padding bytes (zeros are fine for minimal valid v1)

  // ── PEC section ──────────────────────────────────────
  const labelStr = "Stichai".padEnd(16, " ");
  // PEC header is 512 bytes (palette + padding) + body offset structure (40 bytes)
  const pecHdrSize = 540;

  const pecHdr = Buffer.alloc(pecHdrSize, 0x20);
  pecHdr.write("LA:" + labelStr, 0, "ascii");
  pecHdr[19] = 0x0D;
  // Bytes 48-49: color count, then list of palette indices
  pecHdr.writeUInt8(colorList.length - 1, 48);
  for (let i = 0; i < colorList.length && i < 462; i++) {
    pecHdr.writeUInt8(nearestPecColor(colorList[i]), 49 + i);
  }
  // PEC body offset within PEC header section (relative to PEC start)
  pecHdr.writeUInt16LE(0x0000, 520);
  pecHdr.writeUInt16LE(0x0000, 522);
  pecHdr.writeUInt16LE(0x07D0, 524);          // 2000 (placeholder)
  pecHdr.writeUInt16LE(0x07D0, 526);
  pecHdr.writeUInt16LE(width,  528);
  pecHdr.writeUInt16LE(height, 530);
  pecHdr.writeUInt16LE(0x01E0, 532);          // hoop W 480
  pecHdr.writeUInt16LE(0x01B0, 534);          // hoop H 432
  pecHdr.writeUInt16LE(0x9000, 536);
  pecHdr.writeUInt16LE(0x9000, 538);

  // ── Assemble ─────────────────────────────────────────
  const pecStart = pesHdr.length;
  pesHdr.writeUInt32LE(pecStart, 8);
  return Buffer.concat([pesHdr, pecHdr, stitchBytes]);
}

/* ═══════════════════════════════════════════════════════════════════
   JEF ENCODER (Janome)
   Format: 116-byte header + thread palette + stitch records.
   Each stitch = 2 signed bytes (dx, dy) in 0.1mm units.
   Jump/trim/color use opcodes: 0x80 0x02 (jump), 0x80 0x01 (color change).
   ═══════════════════════════════════════════════════════════════════ */

// Janome 79-color thread palette (subset)
const JEF_PALETTE = [
  null, [0,0,0], [0,0,255], [51,204,102], [255,0,0], [0,255,0], [255,255,0],
  [255,128,0], [255,255,255], [254,46,128], [255,153,204], [102,51,153],
  [128,128,128], [192,192,192], [255,140,0], [255,215,0], [50,205,50],
  [0,128,0], [0,255,255], [0,191,255], [70,130,180], [25,25,112],
  [148,0,211], [255,20,147], [165,42,42], [139,69,19], [255,222,173],
];
function nearestJefColor(hex) {
  const {r, g, b} = hexToRgb(hex);
  let bi = 1, bd = Infinity;
  for (let i = 1; i < JEF_PALETTE.length; i++) {
    const c = JEF_PALETTE[i]; if (!c) continue;
    const d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

function encodeJEF(stitches) {
  // Unique colors
  const colorList = [];
  const seen = new Set();
  for (const s of stitches) {
    if (!seen.has(s.color)) { seen.add(s.color); colorList.push(s.color); }
  }
  const colorCount = Math.max(1, colorList.length);

  // Compute bounds & center
  let mnx=Infinity, mxx=-Infinity, mny=Infinity, mxy=-Infinity;
  for (const s of stitches) {
    if (s.x < mnx) mnx = s.x; if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y; if (s.y > mxy) mxy = s.y;
  }
  if (mnx === Infinity) { mnx=mxx=mny=mxy=0; }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;

  // ── Build stitch body ────────────────────────────────
  const body = [];
  let px = 0, py = 0, lastColor = null;
  let stitchCount = 0;

  const emit = (dx, dy, isJump) => {
    dx = Math.max(-127, Math.min(127, Math.round(dx)));
    dy = Math.max(-127, Math.min(127, Math.round(dy)));
    if (isJump) body.push(0x80, 0x02);
    body.push(dx & 0xFF, (-dy) & 0xFF);     // JEF y-axis inverted
    stitchCount++;
  };

  for (const s of stitches) {
    if (s.color !== lastColor && lastColor !== null) {
      body.push(0x80, 0x01);
      stitchCount++;
    }
    lastColor = s.color;
    const tx = Math.round(s.x - cx);
    const ty = Math.round(s.y - cy);
    let dx = tx - px, dy = ty - py;
    const isJump = (s.type === "trim" || s.type === "jump" || s.type === "bridge");
    // Split if delta exceeds 127
    while (Math.abs(dx) > 127 || Math.abs(dy) > 127) {
      const step = Math.max(Math.abs(dx), Math.abs(dy));
      const f = 127 / step;
      const sx = dx * f, sy = dy * f;
      emit(sx, sy, true);
      dx -= sx; dy -= sy;
    }
    emit(dx, dy, isJump);
    px = tx; py = ty;
  }
  // End marker
  body.push(0x80, 0x10);

  // ── JEF header (116 bytes + palette + thread types) ──
  const headerSize = 116 + colorCount * 4 * 2;   // 4 bytes per color × 2 (palette + types)
  const totalSize  = headerSize + body.length;
  const hdr = Buffer.alloc(headerSize, 0);
  hdr.writeInt32LE(headerSize, 0);          // offset to stitch data
  hdr.writeInt32LE(0x14, 4);                // JEF version
  hdr.writeInt32LE(1, 8);                   // hoop code (5x7 = 1)
  hdr.writeInt32LE(stitchCount, 12);
  hdr.writeInt32LE(colorCount, 16);
  // Date string at offset 20 (14 chars)
  const dateStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  hdr.write(dateStr, 20, "ascii");
  // Bounds in 0.1mm signed at offsets 60-75 (left, top, right, bottom)
  hdr.writeInt32LE(Math.round(mnx - cx), 60);
  hdr.writeInt32LE(Math.round(mny - cy), 64);
  hdr.writeInt32LE(Math.round(mxx - cx), 68);
  hdr.writeInt32LE(Math.round(mxy - cy), 72);
  // Color palette starting at byte 116
  for (let i = 0; i < colorCount; i++) {
    hdr.writeInt32LE(nearestJefColor(colorList[i]), 116 + i * 4);
  }
  for (let i = 0; i < colorCount; i++) {
    hdr.writeInt32LE(0x0D, 116 + colorCount * 4 + i * 4);   // thread type
  }

  return Buffer.concat([hdr, Buffer.from(body)]);
}

/* ─── QUALITY VALIDATION ─────────────────────────────────*/
function validateQuality(stitches){
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,trimCount=0,prev=null;
  for(const s of stitches){
    if(s.type==="trim"){trimCount++;prev=null;continue;}
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>DST_MAX)longJ++;
      if(s.type!=="underlay"){tot+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?tot/cnt:0;
  if(avg>50)w.push(`Long avg ${(avg/10).toFixed(1)}mm`);
  if(maxJ>DST_MAX)w.push(`Jump ${(maxJ/10).toFixed(1)}mm > 12.1mm`);
  if(longJ>30)    w.push(`${longJ} oversized jumps`);
  if(cnt>80000)   w.push(`High stitch count ${cnt}`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,trimCount,warnings:w,passed:!w.length};
}

/* ─── SEW TIME CALCULATOR ────────────────────────────────*/
function calculateSewTime(stitchCount, trimCount, colorCount, machine) {
  const spm = { tajima: 800, brother: 650, barudan: 850, generic: 750 };
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

/* ─── PREVIEW RENDERER ───────────────────────────────────*/
async function renderPreview(pixMap, colors, stitches, params, canvasSize) {
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

  const scaledStitches = stitches.map(s => ({
    ...s,
    x: s.x * scale,
    y: s.y * scale
  }));

  const byColor = new Map();
  for (const s of scaledStitches) {
    if (s.type === "trim") continue;
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
/* ============================================================
 *  DST ENCODER (Tajima specification)
 *  Bit assignments verified against a known-good hand-made DST file
 *  (KKK1111) — design header says 156.1mm × 488.3mm, decoded
 *  coordinates match EXACTLY.
 *
 *  BYTE 0 (1-unit and 9-unit range):
 *    0x01: x+1   0x02: x-1   0x04: x+9   0x08: x-9
 *    0x10: y-9   0x20: y+9   0x40: y-1   0x80: y+1
 *  BYTE 1 (3-unit and 27-unit range):
 *    0x01: x+3   0x02: x-3   0x04: x+27  0x08: x-27
 *    0x10: y-27  0x20: y+27  0x40: y-3   0x80: y+3
 *  BYTE 2 (81-unit range + flag bits):
 *    0x01: base  0x02: base  0x04: x+81  0x08: x-81
 *    0x10: y-81  0x20: y+81  0x40: COLOR-CHANGE  0x80: JUMP
 *
 *  HEADER format (also verified against KKK1111):
 *    "LA:<name padded with spaces to 16 chars>\r"   (20 bytes)
 *    "ST:%7d\r"      (stitch count, 7-digit right-aligned)
 *    "CO:%3d\r"      (color count, 3-digit right-aligned)
 *    "+X:%5d\r"      (extent, 2-digit minimum then padded to 5)
 *    "-X:%5d\r"
 *    "+Y:%5d\r"
 *    "-Y:%5d\r"
 *    "AX:+%5d\r" "AY:+%5d\r" "MX:+%5d\r" "MY:+%5d\r"
 *    "PD:******\r"
 *    0x1A                                    (EOF marker)
 *    spaces up to byte 511                  (header is 512 bytes total)
 * ============================================================ */

// Encode (dx, dy) into 3 DST bytes. `isJump` true → set the JUMP flag.
// dx, dy are in IMAGE COORDINATES (y increases downward).
// DST machine coords have y UP positive, so we invert y here.
function dstEncodeXY(dx, dy, isJump) {
  let x = dx;
  let y = -dy;            // machine y is up-positive
  let b0 = 0, b1 = 0, b2 = 0x03;   // base bits always set

  // Decompose into ±1, ±3, ±9, ±27, ±81 — greedy from largest
  // X ±81
  if (x >  40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x08; x += 81; }
  // Y ±81  (note bit positions differ from X)
  if (y >  40) { b2 |= 0x20; y -= 81; }
  if (y < -40) { b2 |= 0x10; y += 81; }

  // X ±27
  if (x >  13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x08; x += 27; }
  // Y ±27
  if (y >  13) { b1 |= 0x20; y -= 27; }
  if (y < -13) { b1 |= 0x10; y += 27; }

  // X ±9
  if (x >   4) { b0 |= 0x04; x -=  9; }
  if (x <  -4) { b0 |= 0x08; x +=  9; }
  // Y ±9
  if (y >   4) { b0 |= 0x20; y -=  9; }
  if (y <  -4) { b0 |= 0x10; y +=  9; }

  // X ±3
  if (x >   1) { b1 |= 0x01; x -=  3; }
  if (x <  -1) { b1 |= 0x02; x +=  3; }
  // Y ±3
  if (y >   1) { b1 |= 0x80; y -=  3; }
  if (y <  -1) { b1 |= 0x40; y +=  3; }

  // X ±1
  if (x >   0) { b0 |= 0x01; }
  if (x <   0) { b0 |= 0x02; }
  // Y ±1
  if (y >   0) { b0 |= 0x80; }
  if (y <   0) { b0 |= 0x40; }

  if (isJump) b2 |= 0x80;          // JUMP flag, bit 7 of byte 2
  return Buffer.from([b0, b1, b2]);
}

// Format a numeric extent: at least 2 digits, right-aligned in 5 chars
// (matches Tajima reference: 0 → "   00", 1561 → " 1561")
function fmtExtent(n) {
  const abs = Math.max(0, Math.round(Math.abs(n)));
  let digits = String(abs);
  if (digits.length < 2) digits = "0" + digits;     // min 2 digits
  return digits.padStart(5, " ");
}

// Build the 512-byte ASCII Tajima header
function dstHeader(stitchCount, colorCount, minX, maxX, minY, maxY, name) {
  const buf = Buffer.alloc(512, 0x20);
  let off = 0;
  const write = (txt) => {
    buf.write(txt, off, "ascii");
    off += txt.length;
    buf[off++] = 0x0D;          // CR after each field
  };
  // LA:<name padded with spaces to 16 chars>
  const safeName = (name || "Stichai").substring(0, 16).padEnd(16, " ");
  write("LA:" + safeName);
  // Stitch & color counts — right-aligned in their width
  write("ST:" + String(stitchCount).padStart(7, " "));
  write("CO:" + String(colorCount).padStart(3, " "));
  // Extents in machine coords (y inverted from image coords):
  //   image y range [minY, maxY] → machine y range [-maxY, -minY]
  //   +X = max(machine x reached) = max(image x, 0)
  //   -X = abs(min(machine x reached)) = abs(min(image x), 0)
  //   +Y = max(machine y reached) = max(-image_y, 0) = max(0, -minY)
  //   -Y = abs(min(machine y reached)) = abs(min(-image_y), 0) = max(0, maxY)
  write("+X:" + fmtExtent(Math.max(0,  maxX)));
  write("-X:" + fmtExtent(Math.max(0, -minX)));
  write("+Y:" + fmtExtent(Math.max(0, -minY)));
  write("-Y:" + fmtExtent(Math.max(0,  maxY)));
  // Last-stitch and multi-volume offsets — all zero for single design
  write("AX:+" + String(0).padStart(5, " "));
  write("AY:+" + String(0).padStart(5, " "));
  write("MX:+" + String(0).padStart(5, " "));
  write("MY:+" + String(0).padStart(5, " "));
  write("PD:******");
  buf[off++] = 0x1A;            // EOF marker
  // Remainder already 0x20 (space)
  return buf;
}

function encodeDST(stitches) {
  const recs = [];
  let lastColor = null;
  let px = 0, py = 0;
  let stitchCount = 0;
  let colorChanges = 0;
  // Track image-coordinate extents
  let mnx =  Infinity, mxx = -Infinity, mny =  Infinity, mxy = -Infinity;

  // Split a long move into multiple records of max ±121 each
  const emitLong = (dx, dy, isJump) => {
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(dx) / 121),
      Math.ceil(Math.abs(dy) / 121)
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

  for (const s of stitches) {
    // Color change: emit zero-motion COLOR record (0xC3 = bits 6+7+base)
    if (s.color !== lastColor && lastColor !== null) {
      recs.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChanges++;
      stitchCount++;
    }
    lastColor = s.color;

    const dx = Math.round(s.x - px);
    const dy = Math.round(s.y - py);
    px = s.x;
    py = s.y;

    const isTrimOrBridge = s.type === "trim" || s.type === "bridge" || s.type === "jump";

    if (Math.abs(dx) > 121 || Math.abs(dy) > 121) {
      emitLong(dx, dy, isTrimOrBridge);
    } else {
      recs.push(dstEncodeXY(dx, dy, isTrimOrBridge));
      stitchCount++;
    }

    // Track extents based on actual positions reached
    if (s.x < mnx) mnx = s.x;
    if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y;
    if (s.y > mxy) mxy = s.y;
  }

  // End-of-design marker: byte 2 = 0xF3 (jump+color+base = all flag bits set)
  recs.push(Buffer.from([0x00, 0x00, 0xF3]));

  if (mnx === Infinity) { mnx = mxx = mny = mxy = 0; }

  const header = dstHeader(stitchCount, colorChanges + 1, mnx, mxx, mny, mxy, "Stichai");
  return Buffer.concat([header, ...recs]);
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

/* ─── ROUTES ─────────────────────────────────────────────*/
/* ═══════════════════════════════════════════════════════════
   AUTH & SUBSCRIPTION ROUTES
   ═══════════════════════════════════════════════════════════ */

/* GET /api/user/status */
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

/* POST /api/checkout — create Stripe checkout session */
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

/* POST /api/portal — Stripe customer portal */
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

/* POST /api/admin/grant — give any user any plan for free
   Header: x-admin-secret: <ADMIN_SECRET env var> */
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

    const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize);
    
    const colors = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
    
    const gem = await analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png", colorCount);

    const pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
    const rawRegions = extractRegions(pixMap, colors, canvasSize);
    const regions = mergeAdjacentRegions(rawRegions);

    if(!regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:0});
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
      
      const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize);
      colors = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
      
      const gem = await analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png", colorCount);
      
      pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
      const rawRegions = extractRegions(pixMap, colors, canvasSize);
      regions = mergeAdjacentRegions(rawRegions);
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

    /* ─── COLOR MERGES (v68.1) ────────────────────────────────
       Frontend sends colorMerges = {"#sourceHex":"#targetHex", ...}
       For each merge, we remap pixMap indices from source CI to target CI,
       and update regions to use the target color. Source colors are then
       removed from the palette by the selectedColors filter below. */
    let colorMerges = {};
    try {
      if (body.colorMerges) {
        const parsed = typeof body.colorMerges === 'string' ? JSON.parse(body.colorMerges) : body.colorMerges;
        if (parsed && typeof parsed === 'object') {
          for (const k of Object.keys(parsed)) {
            colorMerges[normHex(k)] = normHex(parsed[k]);
          }
        }
      }
    } catch(e){ console.warn("colorMerges parse:", e.message); }

    if (Object.keys(colorMerges).length > 0) {
      pixMap = new Int16Array(pixMap);   // clone before remapping
      // Build CI-level merge map: sourceCi → targetCi
      const ciMerges = {};
      colors.forEach((c, ci) => {
        const src = normHex(c);
        if (colorMerges[src]) {
          const targetHex = colorMerges[src];
          const targetCi = colors.findIndex(tc => normHex(tc) === targetHex);
          if (targetCi >= 0 && targetCi !== ci) ciMerges[ci] = targetCi;
        }
      });
      if (Object.keys(ciMerges).length > 0) {
        // Remap pixMap pixels
        for (let i = 0; i < pixMap.length; i++) {
          const v = pixMap[i];
          if (v >= 0 && ciMerges[v] !== undefined) pixMap[i] = ciMerges[v];
        }
        // Remap region colors so they pass the selectedColors filter
        filteredRegions = filteredRegions.map(r => {
          const srcHex = normHex(r.color);
          if (colorMerges[srcHex]) {
            return { ...r, color: colorMerges[srcHex] };
          }
          return r;
        });
        console.log(`Merged ${Object.keys(ciMerges).length} color(s):`, colorMerges);
      }
    }

    if(selectedColors.length < colors.length){
      // FIX v49: Clone pixMap so we don't corrupt the detection cache,
      // AND remap remaining color indices to match the new selectedColors array.
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

    if(!filteredRegions.length){
      return res.status(400).json({error:"No regions left after selection — select more colors/shapes"});
    }

    const{stitches:rawStitches,colorCounts}=generateStitchesFromRegions(pixMap,filteredRegions,selectedColors,params,canvasSize);

    // ── POST-PROCESSING PASSES (v68) ─────────────────────────
    // 1. Filter sub-minStitchMm stitches — threshold per machine brand
    const minStitchPx = (params.minStitchMm || 0.3) * 10;
    let stitches = filterSmallStitches(rawStitches, minStitchPx);

    // 2. Optimize jumps — thresholds per machine brand
    stitches = optimizeJumps(stitches, 2, params.maxJumpMm || 12);

    // 3. Optional basting box (frontend sends bastingBox=1)
    if (req.body.bastingBox === '1' || req.body.bastingBox === 'true') {
      stitches = addBastingBox(stitches, 5, 4);
    }
    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5){
      return res.status(500).json({error:"Not enough stitches — select more shapes or check contrast"});
    }

    let previewBuf = null;
    try {
      previewBuf = await renderPreview(pixMap, selectedColors, stitches, params, canvasSize);
    } catch(e) {
      console.error("Preview pre-render failed:", e.message);
    }

    const qa=validateQuality(stitches);
    const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);
    const designMm = canvasSize / 10;

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,{
      stitches,pixMap,colors:selectedColors,params,
      designW:canvasSize,designH:canvasSize,designMm,
      ts:Date.now(),previewBuf,sewTime,mode,canvasSize
    });

    const shapes=[];
    for(const r of filteredRegions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      const sc=stitches.filter(s=>s.color===r.color&&s.type!=="trim"&&s.type!=="underlay"&&s.x>=r.mnx&&s.x<=r.mxx&&s.y>=r.mny&&s.y<=r.mxy).length;
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:sc});
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
      sewTime,mode
    });
  }catch(e){
    console.error(`[${rid}] CRASH:`,e.message,"\n",e.stack);
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
  
  if(d.previewBuf){
    res.setHeader("Content-Type","image/png");
    res.setHeader("Cache-Control","public,max-age=300");
    return res.send(d.previewBuf);
  }
  
  return res.status(500).json({error:"Preview not ready"});
});

app.get("/download/:id", requireAuth, checkDownloadQuota, async(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});
  if(req.firebaseUser) await recordDownload(req.firebaseUser.uid);

  // Format from query (?fmt=pes|jef|dst), defaults to dst
  const fmt = (req.query.fmt || "dst").toLowerCase();
  let buf, ext, mime = "application/octet-stream";
  try {
    if (fmt === "pes") {
      buf = encodePES(d.stitches);  ext = "pes";
    } else if (fmt === "jef") {
      buf = encodeJEF(d.stitches);  ext = "jef";
    } else {
      buf = encodeDST(d.stitches);  ext = "dst";
    }
  } catch (e) {
    console.error(`Encoder error (${fmt}):`, e.message);
    return res.status(500).json({error:`Failed to encode ${fmt.toUpperCase()}: ${e.message}`});
  }
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"68.2",features:"machine-aware+hoop+merges+pes+jef"}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v68 | :${PORT} | PES+JEF+Optimizer`));
server.timeout=120000;
server.keepAliveTimeout=65000;
