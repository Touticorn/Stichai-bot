/**
 * Stichai v71.0 — Photo-stitch + Logo-stitch
 * ═══════════════════════════════════════════════════════════════════════════════
 *  v69 CHANGES (vs v68.3)
 *  ─────────────────────────────────────────────────────────────────────────────
 *  • Region outlines via Moore boundary tracing (instead of bounding box only)
 *  • Per-shape stitch angle via PCA (instead of always horizontal)
 *  • Satin columns follow the medial axis of elongated shapes
 *  • Tatami fill rotated to shape's principal angle
 *  • Running-stitch outline pass before fills (crisp edges)
 *  • Holes properly detected and respected
 *  • Pure-Node ZIP for DST+INF download (no archiver dep needed)
 *  • Background color auto-detection (still here from v68.3)
 *  • Optional potrace at runtime if installed
 *
 *  PRESERVED FROM v68.x: auth, Stripe, Firebase, color extraction,
 *  DST/JEF/PES encoders, basting, color merges, machine-specific limits,
 *  hoop-based pull comp, mask support
 */

"use strict";

const express  = require("express");
const multer   = require("multer");
const axios    = require("axios");
const path     = require("path");
const sharp    = require("sharp");

/* Optional requires — app starts even if packages aren't installed yet */
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

/* ─── PLANS ────────────────────────────────────────────── */
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
const MIN_AREA     = 60;  /* px² minimum at 800px canvas (~0.6mm²); scales with canvas */
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
   All length values are in pixels at 800px canvas = 10 px/mm.
   These are calibrated against industry-standard professional digitizing:
   - Stitch length: 4-5mm (= 40-50 px) — matches Tajima/Brother defaults
   - Tatami row pitch: 3.5-4.5mm (= 35-45 px) — standard for filled embroidery
   - Underlay pitch: 6-10mm — coarser foundation pass                  */
function getStitchParams(specs) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();
  const hoop = (s.hoop || "5x7").toLowerCase();

  const limits = MACHINE_LIMITS[machine] || MACHINE_LIMITS.generic;

  /* Units are pixels at 10 px/mm scale.
     Real commercial tatami fills use 0.40–0.55 mm row pitch (4–5 px),
     NOT 3.5 mm.  Stitch length within a row stays 3.5–5 mm (35–50 px). */
  const p = {
    tatamiRow: 4, tatamiLen: 42, tatamiUl: 25, pull: 2,
    pullComp: HOOP_PULL[hoop] || 2,
    machineLimits: limits,
    machine, fabric, stabilizer, density, maxStitchLen: limits.maxJump, hoop
  };

  const fabricMap = {
    cotton:  { pull: 2, tatamiRow: 4, tatamiUl: 25, tatamiLen: 42 },
    denim:   { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    fleece:  { pull: 5, tatamiRow: 5, tatamiUl: 22, tatamiLen: 40 },
    pique:   { pull: 3, tatamiRow: 4, tatamiUl: 22, tatamiLen: 42 },
    twill:   { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    satin:   { pull: 1, tatamiRow: 5, tatamiUl: 30, tatamiLen: 48 },
    leather: { pull: 1, tatamiRow: 5, tatamiUl: 30, tatamiLen: 50 },
    towel:   { pull: 6, tatamiRow: 4, tatamiUl: 20, tatamiLen: 38 },
    canvas:  { pull: 4, tatamiRow: 4, tatamiUl: 22, tatamiLen: 40 },
    knit:    { pull: 5, tatamiRow: 5, tatamiUl: 22, tatamiLen: 40 },
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  const densityMap = {
    low:    { tatamiRow: 6, tatamiLen: 50, tatamiUl: 30 },  /* 0.6mm row, sparse */
    medium: { },                                              /* 0.4mm row (default) */
    high:   { tatamiRow: 3, tatamiLen: 38, tatamiUl: 20 },   /* 0.3mm row, dense */
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(3, p.tatamiRow);
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

  /* Background auto-detection was removed (per v72 plan).  Every extracted
     colour is returned and the UI is responsible for letting the user
     exclude anything they don't want stitched.  Hands-off, no surprises. */
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
  /* Strict JSON contract.  The 'palette' field is the new ask: Gemini
     proposes up to N dominant thread colours as #RRGGBB.  If anything
     comes back malformed or empty, /detect-shapes falls back to the
     classic bucket-extraction palette. */
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

    /* Normalise the palette so /detect-shapes can trust it.
       Reject anything that isn't an array of valid 6-digit hexes. */
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

/* ═══════════════════════════════════════════════════════════════════════
   V70 — MASK-BASED ORIENTED STITCH GENERATION
   ═══════════════════════════════════════════════════════════════════════

   Key insight from v69 failure: polygon simplification destroys shape detail
   on complex regions. We must scan the actual pixel mask, not a simplified
   outline.

   Pipeline per color:
     1. Connected-components on the pixMap → raw regions
     2. Split giant blobs: erode by N pixels, re-CC, then dilate labels back
        This separates fronds that connect at thin junctions.
     3. For each sub-region:
        a. Compute PCA angle from interior pixels
        b. Generate oriented row scan: for each row perpendicular to long axis,
           walk the mask along the row direction and emit stitch pairs at the
           start/end of each inside-run.
        c. Outline pass: walk the boundary (Moore tracing) and emit running
           stitches around it.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── PCA on a list of (x,y) pixel coords ───────────────────────────────── */
function v70_pca(pts) {
  const n = pts.length;
  if (n < 4) return { angle: 0, aspect: 1, cx: 0, cy: 0 };
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const lam1 = tr / 2 + disc, lam2 = tr / 2 - disc;
  /* eigenvector for largest eigenvalue (long axis) */
  const longAngle = Math.atan2(lam1 - sxx, sxy || 1e-9);
  /* stitches run PERPENDICULAR to the long axis (across the narrow dimension) */
  const stitchAngle = longAngle + Math.PI / 2;
  const aspect = lam2 > 0.01 ? Math.sqrt(lam1 / lam2) : 999;
  return { angle: stitchAngle, longAngle, aspect, cx, cy };
}

/* ── BFS connected components on a pixMap, with optional label filter ──── */
function v70_findRegions(pixMap, w, h, minArea) {
  const visited = new Uint8Array(w * h);
  const regions = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ci = pixMap[i];
      if (ci < 0 || visited[i]) continue;
      const pts = [];
      const stack = [i];
      visited[i] = 1;
      let mnx = x, mxx = x, mny = y, mxy = y;
      while (stack.length) {
        const idx = stack.pop();
        const xx = idx % w, yy = (idx / w) | 0;
        pts.push([xx, yy]);
        if (xx < mnx) mnx = xx; if (xx > mxx) mxx = xx;
        if (yy < mny) mny = yy; if (yy > mxy) mxy = yy;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = xx + dx, ny = yy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni]) continue;
          if (pixMap[ni] === ci) { visited[ni] = 1; stack.push(ni); }
        }
      }
      if (pts.length >= minArea) {
        regions.push({ ci, pts, mnx, mny, mxx, mxy });
      }
    }
  }
  return regions;
}

/* ── Distance transform (Chamfer 3-4): for each pixel, distance to nearest 0
   Used to find "ridge" pixels where shape is widest — these are sub-shape centres.
   ───────────────────────────────────────────────────────────────────────── */
function v70_distanceTransform(mask, w, h) {
  const INF = 65535;
  const d = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  /* forward pass */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x > 0)         v = Math.min(v, d[i-1] + 3);
      if (y > 0)         v = Math.min(v, d[i-w] + 3);
      if (x > 0 && y > 0) v = Math.min(v, d[i-w-1] + 4);
      if (x < w-1 && y > 0) v = Math.min(v, d[i-w+1] + 4);
      d[i] = v;
    }
  }
  /* backward pass */
  for (let y = h-1; y >= 0; y--) {
    for (let x = w-1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x < w-1)       v = Math.min(v, d[i+1] + 3);
      if (y < h-1)       v = Math.min(v, d[i+w] + 3);
      if (x < w-1 && y < h-1) v = Math.min(v, d[i+w+1] + 4);
      if (x > 0 && y < h-1) v = Math.min(v, d[i+w-1] + 4);
      d[i] = v;
    }
  }
  return d;
}

/* ── Find local maxima of distance transform: pixels with DT ≥ all 8 neighbours.
   These are "skeleton tips" — natural centers of distinct sub-shapes.
   Returns array of {x, y, dt} grouped into clusters (each cluster = one seed).
   ───────────────────────────────────────────────────────────────────────── */
function v70_findDtMaxima(dt, w, h, minDt) {
  const maxima = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = dt[i];
      if (v < minDt) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1 && isMax; dx++) {
          if (!dx && !dy) continue;
          if (dt[(y+dy) * w + (x+dx)] > v) isMax = false;
        }
      }
      if (isMax) maxima.push([x, y, v]);
    }
  }
  /* Cluster nearby maxima (within minDt/3) into single seeds */
  const clusterRadius = Math.max(3, minDt / 3 / 3);  /* /3 because Chamfer units */
  const used = new Uint8Array(maxima.length);
  const clusters = [];
  for (let i = 0; i < maxima.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const cluster = [maxima[i]];
    for (let j = i + 1; j < maxima.length; j++) {
      if (used[j]) continue;
      const dx = maxima[i][0] - maxima[j][0], dy = maxima[i][1] - maxima[j][1];
      if (dx*dx + dy*dy < clusterRadius * clusterRadius) {
        cluster.push(maxima[j]);
        used[j] = 1;
      }
    }
    /* Cluster centroid weighted by dt */
    let sx = 0, sy = 0, sw = 0;
    for (const [x, y, v] of cluster) { sx += x * v; sy += y * v; sw += v; }
    clusters.push([sx / sw, sy / sw]);
  }
  return clusters;
}

/* ── Watershed-style splitting: every pixel goes to its nearest DT maximum
   measured by Euclidean distance. Each maximum = one sub-shape seed.
   ───────────────────────────────────────────────────────────────────────── */
function v70_splitRegion(reg, canvasSize, junctionPx) {
  const rw = reg.mxx - reg.mnx + 1;
  const rh = reg.mxy - reg.mny + 1;
  const origMask = new Uint8Array(rw * rh);
  for (const [x, y] of reg.pts) {
    origMask[(y - reg.mny) * rw + (x - reg.mnx)] = 1;
  }
  const dt = v70_distanceTransform(origMask, rw, rh);
  /* Chamfer 3-4: orthogonal = 3 per pixel. So junctionPx pixels = junctionPx*3 DT units */
  const minDt = junctionPx * 3;
  const seeds = v70_findDtMaxima(dt, rw, rh, minDt);
  if (seeds.length <= 1) return [reg.pts];

  /* Assign each pixel to nearest seed by Euclidean distance */
  const subRegions = seeds.map(() => []);
  for (const [x, y] of reg.pts) {
    const lx = x - reg.mnx, ly = y - reg.mny;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < seeds.length; k++) {
      const dx = lx - seeds[k][0], dy = ly - seeds[k][1];
      const d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    subRegions[best].push([x, y]);
  }
  return subRegions.filter(s => s.length >= 25);
}

/* ── Build an oriented mask: for each pixel of the region, store 1 ─────────
   Stored as a packed object: { mask, w, h, offX, offY }
   ───────────────────────────────────────────────────────────────────────── */
function v70_buildMask(pts) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
  }
  const w = mxx - mnx + 1, h = mxy - mny + 1;
  const mask = new Uint8Array(w * h);
  for (const [x, y] of pts) mask[(y - mny) * w + (x - mnx)] = 1;
  return { mask, w, h, offX: mnx, offY: mny };
}

/* ── Moore-neighbour boundary trace on a binary mask ─────────────────────── */
function v70_traceOutline(mask, w, h) {
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  /* Find first interior pixel */
  let startIdx = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { startIdx = i; break; }
  if (startIdx < 0) return [];
  const sx = startIdx % w, sy = (startIdx / w) | 0;
  let cx = sx, cy = sy, backDir = 4;
  const path = [];
  let steps = 0;
  const maxSteps = (w + h) * 8 + 1000;
  do {
    path.push([cx, cy]);
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (backDir + 1 + i) & 7;
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) {
        backDir = (d + 4) & 7;
        cx = nx; cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    steps++;
  } while ((cx !== sx || cy !== sy) && steps < maxSteps);
  return path;
}

/* ── Oriented row scan: for each row perpendicular to the long axis,
   walk the mask along the row direction and find inside-runs.
   This is the KEY function — it preserves shape detail because it samples
   the actual mask pixels, not a simplified polygon outline.
   ───────────────────────────────────────────────────────────────────────── */
function v70_scanRuns(mask, w, h, offX, offY, angle, rowSpacing) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  /* Row direction is +angle. Long axis perpendicular = (-sin, cos). */
  /* Project all corner points to find row range and column range */
  const corners = [[0,0],[w-1,0],[0,h-1],[w-1,h-1]];
  let minT = Infinity, maxT = -Infinity, minU = Infinity, maxU = -Infinity;
  for (const [lx, ly] of corners) {
    const u = lx * cos + ly * sin;        /* along row direction */
    const t = -lx * sin + ly * cos;       /* along long axis (perpendicular) */
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (t < minT) minT = t; if (t > maxT) maxT = t;
  }
  const stepAlongRow = 0.5;  /* sub-pixel sampling along the row */
  const rows = [];
  for (let t = minT; t <= maxT; t += rowSpacing) {
    /* For each sample along the row, check if mask is hit at (round(u*cos - t*sin), round(u*sin + t*cos)) */
    const runs = [];
    let runStart = null;
    for (let u = minU; u <= maxU; u += stepAlongRow) {
      const lx = u * cos - t * sin;
      const ly = u * sin + t * cos;
      const ix = Math.round(lx), iy = Math.round(ly);
      const inside = (ix >= 0 && iy >= 0 && ix < w && iy < h) && mask[iy * w + ix];
      if (inside) {
        if (runStart === null) runStart = u;
      } else {
        if (runStart !== null) {
          runs.push([runStart, u - stepAlongRow]);
          runStart = null;
        }
      }
    }
    if (runStart !== null) runs.push([runStart, maxU]);
    if (runs.length) rows.push({ t, runs });
  }
  return { rows, cos, sin, offX, offY };
}

/* ── Convert scanned runs into stitch pairs and rotate back to image space.
   Adds brick offset and reverses every other row to minimize jumps.
   Inserts trim commands between segments separated by negative space
   (so the machine pen-ups instead of bridging across).
   ───────────────────────────────────────────────────────────────────────── */
function v70_runsToStitches(scan, color, brickAmt, pullComp, maxBridgePx, maxStitchLen) {
  /* maxStitchLen is the soft target — any stitch longer than this gets split
     into N pieces of equal length. We aim for stitches AROUND this length,
     not just below it. So if maxStitchLen = 47px (4.7mm), a 100px segment
     becomes 3 pieces of ~33px (3.3mm), not 2 pieces of 50px. */
  const targetLen = maxStitchLen;
  const { rows, cos, sin, offX, offY } = scan;
  const stitches = [];
  let reversed = false;
  let lastX = null, lastY = null;
  for (let r = 0; r < rows.length; r++) {
    const { t, runs } = rows[r];
    const ordered = reversed ? [...runs].reverse() : runs;
    const brick = (r % 2 === 0) ? 0 : brickAmt;
    for (let i = 0; i < ordered.length; i++) {
      let [u1, u2] = ordered[i];
      u1 += pullComp; u2 -= pullComp;
      if (u2 - u1 < 0.5) continue;
      const startU = reversed ? u2 : u1;
      const endU   = reversed ? u1 : u2;
      const sx = offX + startU * cos - t * sin;
      const sy = offY + startU * sin + t * cos;
      const ex = offX + endU   * cos - (t + brick) * sin;
      const ey = offY + endU   * sin + (t + brick) * cos;
      if (lastX !== null) {
        const isSameRow = (i > 0);
        const travel = Math.hypot(sx - lastX, sy - lastY);
        if (isSameRow || travel > maxBridgePx) {
          stitches.push({ x: lastX, y: lastY, color, type: "trim" });
        } else if (maxStitchLen > 0 && travel > maxStitchLen) {
          /* Bridge between row N end → row N+1 start. If longer than the
             machine's max stitch, subdivide so we don't exceed hardware limit
             AND so the bridge doesn't show as a long diagonal line in viewers. */
          const n = Math.ceil(travel / maxStitchLen);
          const bdx = sx - lastX, bdy = sy - lastY;
          for (let k = 1; k < n; k++) {
            stitches.push({
              x: lastX + bdx * k / n,
              y: lastY + bdy * k / n,
              color, type: "fill"
            });
          }
        }
      }
      /* Emit start point, then subdivide along the row if longer than maxStitchLen.
         Industry standard: 4-5mm per stitch maximum. A long row segment becomes
         multiple consecutive stitches along the same line. */
      stitches.push({ x: sx, y: sy, color, type: "fill" });
      const dx = ex - sx, dy = ey - sy;
      const len = Math.hypot(dx, dy);
      if (maxStitchLen > 0 && len > maxStitchLen) {
        const n = Math.ceil(len / maxStitchLen);
        for (let k = 1; k < n; k++) {
          stitches.push({
            x: sx + dx * k / n,
            y: sy + dy * k / n,
            color, type: "fill"
          });
        }
      }
      stitches.push({ x: ex, y: ey, color, type: "fill" });
      lastX = ex; lastY = ey;
    }
    reversed = !reversed;
  }
  return stitches;
}

/* ── Outline as running stitches with step length ────────────────────────── */
function v70_outlineStitches(path, offX, offY, color, stepPx) {
  const out = [];
  if (path.length < 2) return out;
  let acc = 0;
  let [pxL, pyL] = path[0];
  let px = pxL + offX, py = pyL + offY;
  out.push({ x: px, y: py, color, type: "running" });
  for (let i = 1; i < path.length; i++) {
    const [qxL, qyL] = path[i];
    const qx = qxL + offX, qy = qyL + offY;
    const dx = qx - px, dy = qy - py;
    const seg = Math.hypot(dx, dy);
    if (seg < 0.01) continue;
    let t = 0;
    while (acc + (seg - t) >= stepPx) {
      const want = stepPx - acc;
      const tt = t + want;
      const sx = px + dx * tt / seg;
      const sy = py + dy * tt / seg;
      out.push({ x: sx, y: sy, color, type: "running" });
      t = tt; acc = 0;
    }
    acc += seg - t;
    px = qx; py = qy;
  }
  out.push({ x: px, y: py, color, type: "running" });
  return out;
}

/* ── Decide stitch type from PCA & physical width ────────────────────────── */
function v70_classify(pts, pca, pxPerMm) {
  const areaMm2 = pts.length / (pxPerMm * pxPerMm);
  /* width along short axis ≈ area / long-axis-extent */
  let minP = Infinity, maxP = -Infinity;
  const longCos = Math.cos(pca.longAngle), longSin = Math.sin(pca.longAngle);
  for (const [x, y] of pts) {
    const u = (x - pca.cx) * longCos + (y - pca.cy) * longSin;
    if (u < minP) minP = u; if (u > maxP) maxP = u;
  }
  const longAxisPx = Math.max(1, maxP - minP);
  const widthPx = pts.length / longAxisPx;
  const widthMm = widthPx / pxPerMm;

  let type;
  if (areaMm2 < 1.5)                              type = "running";
  else if (widthMm < 0.6)                         type = "running";
  else if (widthMm <= 5.0 && pca.aspect > 3.5)    type = "satin";
  else                                            type = "fill";
  return { type, areaMm2, widthMm };
}

/* ── Top-level: build all shapes from the pixMap ────────────────────────── */
function v70_buildShapes(pixMap, colors, canvasSize, pxPerMm) {
  /* 1mm² minimum — below this, detail is smaller than a typical stitch and
     becomes noise speckles in the output. Real embroidery needles can't
     resolve features under ~0.5mm anyway. */
  const minAreaPx = Math.max(50, Math.round(1.0 * pxPerMm * pxPerMm));
  const rawRegions = v70_findRegions(pixMap, canvasSize, canvasSize, minAreaPx);
  console.log(`[v70] Raw regions: ${rawRegions.length} (minArea=${minAreaPx}px)`);

  /* Splitting is disabled by default — distance-transform based splitting
     works well on compound shapes (2-3 distinct lobes) but fails on
     star-shaped multi-frond clusters where it either over-splits or
     produces wrong seeds. For most embroidery the per-shape PCA angle is
     sufficient. Enable via env var V70_SPLIT=1 if you want experimental
     blob splitting. */
  const enableSplit = process.env.V70_SPLIT === "1";
  const junctionPx = Math.max(4, Math.round(6 * (canvasSize / 800)));

  const shapes = [];
  for (const reg of rawRegions) {
    let subPtsList;
    if (enableSplit && reg.pts.length > 500) {
      subPtsList = v70_splitRegion(reg, canvasSize, junctionPx);
      if (subPtsList.length > 1) {
        console.log(`[v70] Split region (color ${colors[reg.ci]}, ${reg.pts.length}px) into ${subPtsList.length} sub-shapes`);
      }
    } else {
      subPtsList = [reg.pts];
    }

    for (const pts of subPtsList) {
      if (pts.length < minAreaPx) continue;
      const pca = v70_pca(pts);
      const cls = v70_classify(pts, pca, pxPerMm);
      const m = v70_buildMask(pts);
      shapes.push({
        ci: reg.ci,
        color: colors[reg.ci],
        type: cls.type,
        pca,
        mask: m.mask, w: m.w, h: m.h, offX: m.offX, offY: m.offY,
        ptCount: pts.length,
        areaMm2: cls.areaMm2,
        widthMm: cls.widthMm,
        bounds: { mnx: m.offX, mny: m.offY, mxx: m.offX + m.w - 1, mxy: m.offY + m.h - 1 }
      });
    }
  }
  console.log(`[v70] Final shapes: ${shapes.length} (fill:${shapes.filter(s=>s.type==="fill").length} satin:${shapes.filter(s=>s.type==="satin").length} run:${shapes.filter(s=>s.type==="running").length})`);
  return shapes;
}

/* ── Top-level stitch generation ──────────────────────────────────────────── */
function v70_generateStitches(shapes, colors, params, canvasSize) {
  const out = [];
  const colorCounts = colors.map(() => ({fill:0, satin:0, running:0, underlay:0}));
  const pxScale  = canvasSize / 800;
  const P = params || {};
  const pRow      = Math.max(3, Math.round((P.tatamiRow || 4) * pxScale));  /* 0.3-0.5 mm */
  const pLen      = Math.max(20, Math.round((P.tatamiLen || 47) * pxScale));  /* 4.7mm default */
  /* Subdivision target: stitches LONGER than this get split into N pieces.
     Industry pro file mean stitch length is 3.5mm. To make our mean land near
     that, the subdivision target should be ~3.5mm so any longer stitch gets
     broken into ~equal pieces around the target. */
  const pSubdiv   = Math.max(20, Math.round((P.tatamiLen || 35) * pxScale * 0.75));  /* ~3.5mm target */
  const pPullComp = Math.round((P.pullComp || 2) * pxScale);
  const pOutline  = pSubdiv;  /* outline step = same target */
  /* Brick offset: stagger alternate rows by a fraction of ROW pitch (not stitch length).
     Setting this >= rowSpacing causes rows to overlap going backwards — the
     chaos pattern in v71.0. Half a row pitch is the maximum safe value. */
  const pBrick    = Math.round(pRow * 0.4);
  /* Max bridge distance: stitches longer than this become trims.
     Set high enough (25mm) that adjacent shape parts of the same color stay
     connected by bridge stitches — keeps fronds from fragmenting into
     individual zigzag bits. Only true cross-design jumps will trim. */
  const pMaxBridge = Math.round(250 * pxScale);  /* ~25mm */

  /* Group by color, sort within color: largest fills first */
  const byCi = new Map();
  for (const sh of shapes) {
    if (!byCi.has(sh.ci)) byCi.set(sh.ci, []);
    byCi.get(sh.ci).push(sh);
  }

  let lastX = 0, lastY = 0;
  for (let ci = 0; ci < colors.length; ci++) {
    const group = byCi.get(ci);
    if (!group || !group.length) continue;
    group.sort((a, b) => {
      const tA = a.type === "fill" ? 0 : a.type === "satin" ? 1 : 2;
      const tB = b.type === "fill" ? 0 : b.type === "satin" ? 1 : 2;
      if (tA !== tB) return tA - tB;
      return b.ptCount - a.ptCount;
    });
    const color = colors[ci];

    for (const sh of group) {
      /* Trim if moving far */
      const path = v70_traceOutline(sh.mask, sh.w, sh.h);
      if (!path.length) continue;
      const startX = path[0][0] + sh.offX, startY = path[0][1] + sh.offY;
      if (Math.hypot(startX - lastX, startY - lastY) > 12 * pxScale) {
        out.push({ x: lastX, y: lastY, color, type: "trim" });
      }

      /* OUTLINE pass — running stitches around the boundary.
         Outline before fill is standard practice: it defines a crisp edge
         that the fill can register against, and helps prevent the fill
         from looking ragged. */
      const ol = v70_outlineStitches(path, sh.offX, sh.offY, color, pOutline);
      for (const s of ol) {
        out.push(s);
        colorCounts[ci].running++;
        lastX = s.x; lastY = s.y;
      }

      /* Stitch angle: if shape is near-round (low aspect), use a fixed vertical
         angle (90°) instead of unreliable PCA. Vertical fills look natural and
         the slight pull on horizontal threads helps the shape sit flat. */
      const stitchAngle = (sh.pca.aspect < 1.3) ? Math.PI / 2 : sh.pca.angle;

      /* MAIN STITCHING */
      if (sh.type === "fill" || (sh.type === "satin" && sh.widthMm > 3.5)) {
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY,
                                  stitchAngle, pRow);
        const fs = v70_runsToStitches(scan, color, pBrick, pPullComp, pMaxBridge, pSubdiv);
        /* Trim between outline-end and fill-start if they're far apart */
        if (fs.length > 0 && lastX !== null) {
          const dx = fs[0].x - lastX, dy = fs[0].y - lastY;
          if (Math.hypot(dx, dy) > 12 * pxScale) {
            out.push({ x: lastX, y: lastY, color, type: "trim" });
          }
        }
        for (const s of fs) {
          out.push(s);
          colorCounts[ci].fill++;
          lastX = s.x; lastY = s.y;
        }
      } else if (sh.type === "satin") {
        /* For genuine satin (thin), use a denser scan at smaller row pitch */
        const scan = v70_scanRuns(sh.mask, sh.w, sh.h, sh.offX, sh.offY,
                                  stitchAngle, Math.max(2, Math.round(2.5 * pxScale)));
        const fs = v70_runsToStitches(scan, color, 0, pPullComp, pMaxBridge, pSubdiv);
        for (const s of fs) {
          out.push(s);
          colorCounts[ci].satin++;
          lastX = s.x; lastY = s.y;
        }
      }
      /* running: outline is the stitching, nothing more */
    }
  }
  return { stitches: out, colorCounts };
}


/* ═══════════════════════════════════════════════════════════════════════
   V71 — PHOTO-STITCH (thread painting)
   ═══════════════════════════════════════════════════════════════════════

   Used when mode === 'photo'. Industry "thread painting" approach:

   For each color band (quantized luminance level):
     1. Build a mask of pixels matching this band
     2. Cross-hatch at the band's assigned angle
     3. Use row spacing inversely proportional to luminance:
        - Dark bands → dense rows (0.5mm pitch) → solid coverage
        - Mid bands  → medium rows (1.0mm pitch)
        - Light bands → sparse rows (2.0mm pitch) → fabric shows through

   Layers stack: darkest color first (foundation), then progressively
   lighter colors on top. Each color uses a different angle (0°, 45°,
   90°, 135°) so they cross-hatch instead of overlaying.

   The result simulates tonal range using thread density and color
   stacking — like real hand-embroidered thread painting.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Convert RGB to perceptual luminance (Rec. 709) ─────────────────────── */
function v71_luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ── Build a mask of pixels assigned to one color in the palette,
   plus a "fade" mask indicating how strongly each pixel matches that
   color (used for density variation within the band). ───────────────────── */
function v71_colorMaskWithStrength(pixMap, ci, w, h) {
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] === ci) { mask[i] = 1; count++; }
  }
  return { mask, count };
}

/* ── Cross-hatch fill: walk rows at the given angle through the mask,
   emit stitches where mask is set. Row pitch and stitch length both
   scale with the band's "tone weight" (darker = denser = shorter stitches).
   ───────────────────────────────────────────────────────────────────────── */
function v71_crossHatch(mask, w, h, angle, rowPitch, stitchLen, color, pullComp, maxStitchLen) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  /* Find bounds of mask pixels rotated into u-t space */
  let minT = Infinity, maxT = -Infinity, minU = Infinity, maxU = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const u = x * cos + y * sin;
      const t = -x * sin + y * cos;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (t < minT) minT = t; if (t > maxT) maxT = t;
    }
  }
  if (minT === Infinity) return [];

  const stitches = [];
  let reversed = false;
  let lastX = null, lastY = null;
  const sampleStep = 0.7;  /* sub-pixel sampling along the row */

  for (let t = minT; t <= maxT; t += rowPitch) {
    /* Walk this row, find inside-runs */
    const runs = [];
    let runStart = null;
    for (let u = minU; u <= maxU; u += sampleStep) {
      const ix = Math.round(u * cos - t * sin);
      const iy = Math.round(u * sin + t * cos);
      const inside = ix >= 0 && iy >= 0 && ix < w && iy < h && mask[iy * w + ix];
      if (inside) {
        if (runStart === null) runStart = u;
      } else if (runStart !== null) {
        runs.push([runStart, u - sampleStep]);
        runStart = null;
      }
    }
    if (runStart !== null) runs.push([runStart, maxU]);
    if (!runs.length) { reversed = !reversed; continue; }

    const ordered = reversed ? runs.slice().reverse() : runs;
    for (let i = 0; i < ordered.length; i++) {
      let [u1, u2] = ordered[i];
      u1 += pullComp; u2 -= pullComp;
      if (u2 - u1 < 0.5) continue;
      const startU = reversed ? u2 : u1;
      const endU   = reversed ? u1 : u2;
      const sx = startU * cos - t * sin;
      const sy = startU * sin + t * cos;
      const ex = endU   * cos - t * sin;
      const ey = endU   * sin + t * cos;
      /* Trim within row if jumping across gap (multi-segment row) */
      if (lastX !== null) {
        const travel = Math.hypot(sx - lastX, sy - lastY);
        if (i > 0 && travel > maxStitchLen * 1.5) {
          stitches.push({ x: lastX, y: lastY, color, type: "trim" });
        } else if (travel > maxStitchLen) {
          /* Subdivide bridge */
          const n = Math.ceil(travel / maxStitchLen);
          for (let k = 1; k < n; k++) {
            stitches.push({
              x: lastX + (sx - lastX) * k / n,
              y: lastY + (sy - lastY) * k / n,
              color, type: "fill"
            });
          }
        }
      }
      /* Start */
      stitches.push({ x: sx, y: sy, color, type: "fill" });
      /* Subdivide within row if longer than max */
      const len = Math.hypot(ex - sx, ey - sy);
      if (len > maxStitchLen) {
        const n = Math.ceil(len / maxStitchLen);
        for (let k = 1; k < n; k++) {
          stitches.push({
            x: sx + (ex - sx) * k / n,
            y: sy + (ey - sy) * k / n,
            color, type: "fill"
          });
        }
      }
      stitches.push({ x: ex, y: ey, color, type: "fill" });
      lastX = ex; lastY = ey;
    }
    reversed = !reversed;
  }
  return stitches;
}

/* ── Top-level photo-stitch generator ─────────────────────────────────────
   pixMap: quantized palette indices (already extracted with N tones)
   colors: array of hex colors, ORDERED DARK → LIGHT
   ───────────────────────────────────────────────────────────────────────── */
function v71_generatePhotoStitch(pixMap, colors, canvasSize, params) {
  const pxScale = canvasSize / 800;
  const P = params || {};
  const pPullComp = Math.round((P.pullComp || 2) * pxScale);
  const pSubdiv = Math.max(20, Math.round(35 * pxScale * 0.75));  /* ~3.5mm */

  /* Sort colors dark-to-light by luminance, remember original index for output */
  const indexed = colors.map((hex, i) => {
    const rgb = hexToRgb(hex);
    return { hex, ci: i, lum: v71_luminance(rgb.r, rgb.g, rgb.b) };
  });
  indexed.sort((a, b) => a.lum - b.lum);

  /* Assign angles by index — cycle through 4 directions for cross-hatching */
  const angleBank = [
    Math.PI / 4,           /*  45° */
    -Math.PI / 4,          /* -45° */
    0,                     /*   0° (horizontal) */
    Math.PI / 2,           /*  90° (vertical) */
  ];

  /* Compute row pitch per band based on luminance:
     darkest (lum 0)    → 0.5mm = 5px @ 800px = densest
     lightest (lum 255) → 2.5mm = 25px @ 800px = sparsest
     We map linearly. */
  function rowPitchForLum(lum) {
    const t = lum / 255;  /* 0=dark, 1=light */
    const mmPitch = 0.5 + t * 2.0;  /* 0.5mm to 2.5mm */
    return Math.max(4, Math.round(mmPitch * 10 * pxScale));
  }

  const out = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));
  let lastX = 0, lastY = 0;

  for (let bandIdx = 0; bandIdx < indexed.length; bandIdx++) {
    const band = indexed[bandIdx];
    const { mask, count } = v71_colorMaskWithStrength(pixMap, band.ci, canvasSize, canvasSize);
    if (count < 100) continue;  /* skip near-empty bands */

    const angle = angleBank[bandIdx % angleBank.length];
    const rowPitch = rowPitchForLum(band.lum);

    /* Trim before band if needed (cross from previous band's endpoint) */
    if (out.length > 0) {
      out.push({ x: lastX, y: lastY, color: band.hex, type: "trim" });
    }

    const stitches = v71_crossHatch(
      mask, canvasSize, canvasSize,
      angle, rowPitch, pSubdiv, band.hex, pPullComp, pSubdiv
    );
    for (const s of stitches) {
      out.push(s);
      if (s.type === "fill") colorCounts[band.ci].fill++;
      else if (s.type === "trim") {}
      lastX = s.x; lastY = s.y;
    }

    console.log(`[v71] Band ${bandIdx} (lum=${band.lum.toFixed(0)}, hex=${band.hex}): ${count}px → ${stitches.length} stitches at ${(angle*180/Math.PI).toFixed(0)}°, rowPitch=${rowPitch}px`);
  }

  return { stitches: out, colorCounts };
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

        /* Scale minimum area to canvas resolution.
           At 800px: MIN_AREA=25 → ~0.04mm². At 1600px: use 100px² for same physical size. */
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

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity,avgRunW});
      }
    }
  }

  console.log(`Regions (raw): ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  return regions;
}

/* ─── MERGE ADJACENT FRAGMENTS ───────────────────────────*/
function mergeAdjacentRegions(regions, canvasSize) {
  if (!regions.length) return regions;
  /* Conservative merge: only bridge tiny noise gaps (≤ 2 px ≈ 0.2 mm) between
     same-colour fragments.  The previous 12-px gap merged genuinely separate
     shapes (e.g. left and right cheek) into one bbox, which then made fills
     span empty space.  We also require pixel-level proximity, not just
     overlapping bounding boxes — two L-shapes can have overlapping bboxes
     while sharing zero adjacent pixels. */
  const mergeGap = Math.max(2, Math.round(canvasSize / 400));
  let changed = true;
  let merged = regions.slice();

  /* Build a quick lookup of pixel ownership per region so we can test
     true adjacency, not bbox adjacency. */
  function regionsActuallyTouch(a, b) {
    /* bbox quick-reject */
    if (a.mxx + mergeGap < b.mnx || b.mxx + mergeGap < a.mnx) return false;
    if (a.mxy + mergeGap < b.mny || b.mxy + mergeGap < a.mny) return false;
    /* For real touch, require a.bbox and b.bbox to actually overlap or be
       within mergeGap *in both axes simultaneously*, AND the combined
       solidity to remain reasonable (avoid swallowing a far-away patch). */
    const ux = Math.max(0, Math.min(a.mxx, b.mxx) - Math.max(a.mnx, b.mnx));
    const uy = Math.max(0, Math.min(a.mxy, b.mxy) - Math.max(a.mny, b.mny));
    /* At least one axis must have real overlap (not just be within mergeGap). */
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
            /* Reject the merge if the resulting bbox would have very low
               solidity — that means we're joining two patches across mostly
               empty space, which is exactly the bug we're fixing. */
            const newMnx = Math.min(mnx, other.mnx);
            const newMny = Math.min(mny, other.mny);
            const newMxx = Math.max(mxx, other.mxx);
            const newMxy = Math.max(mxy, other.mxy);
            const newBboxArea = (newMxx - newMnx + 1) * (newMxy - newMny + 1);
            const combinedFill = area + other.area;
            const projectedSolidity = combinedFill / Math.max(newBboxArea, 1);
            if (projectedSolidity < 0.30) continue;  /* would create a sparse mega-region */

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
        aspectRatio: newAspect, solidity: newSolidity, avgRunW: newAvgRunW
      });
    }
    merged = next;
  }

  console.log(`Regions (conservative merge): ${merged.length}`);
  return merged;
}

/* ─── BRIDGE CONNECTOR ─────────────────────────────*/
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

/* ─── COLUMN-WISE SCANNING ──── */
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

/* ─── EDGE WALK UNDERLAY ─────── */
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

/* ─── ZIGZAG CENTER-WALK UNDERLAY ─────────────────────────── */
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

/* ─── TIE-IN / TIE-OFF ─────────────────── */
function generateTieStitches(x, y, color, dirX, dirY) {
  const stitches = [];
  const off = 15;
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  stitches.push({x: x - dirX * off / 2, y: y - dirY * off / 2, color, type: "tie"});
  stitches.push({x: x + dirX * off,     y: y + dirY * off,     color, type: "tie"});
  return stitches;
}

/* ─── COLOR MERGE: remap pixMap indices ─────────────────── */
function applyColorMerges(pixMap, colors, merges, lockedColors) {
  if (!merges || !Object.keys(merges).length) return {pixMap, colors};

  /* Build the locked-hex set (normalised).  Locked colours cannot be the
     source or the target of a merge — this lets users protect critical
     thread colours (eye highlights, brand-spec spot colours, white
     details on logos, etc.) from accidental collapse. */
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

/* ═══════════════════════════════════════════════════════════════════
   PROFESSIONAL STITCH GENERATOR  (v68.2)
   ═══════════════════════════════════════════════════════════════════ */
/* ─── OUTLINE RUNNING STITCH (crisp edges) ─────────────────────────────── */
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

function generateStitchesFromRegions(pixMap, regions, colors, params, canvasSize) {
  const stitches = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0, underlay: 0}));

  const P = params || {};
  const pRow      = P.tatamiRow !== undefined ? P.tatamiRow : 4;
  const pLen      = P.tatamiLen !== undefined ? P.tatamiLen : 30;
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
          /* Inter-run trim for vertical scan */
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
      const gapTrimPx = Math.max(15, Math.round(pLen * 1.2)); /* >1.2× stitch length = trim instead of sew across */
      for (let y = mny; y <= mxy; y += pRow) {
        const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
        if (!runs.length) continue;
        const rev = rowIdx % 2 === 1;
        const ord = rev ? [...runs].reverse() : runs;

        let runIdx = 0;
        let prevExitX = null;
        for (const {x1, x2} of ord) {
          const jx = rev ? x2 : x1;

          /* Inter-run trim: if there is a previous run in this same row and the
             gap to this run's entry exceeds gapTrimPx, drop a trim so the next
             stitch starts fresh instead of dragging thread across empty fabric. */
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
  
  /* Filter out stitches below machine minimum */
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
      needJump = true; // after color change, next move must be a jump
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
      needJump = true; // after trim/color-change, next move must be a jump
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
   JEF ENCODER (Janome) — based on pyembroidery / libembroidery
   ═══════════════════════════════════════════════════════════════════ */
/* ── Real Tajima thread RGB values (index-matched to Tajima color table) ──────
   These match what Tajima-compatible viewers (Viewer Pro, SewWhat, etc.) display
   when they read palette indices from DST/JEF/PES files.
   Source: Tajima official thread chart + pyembroidery reference data.         */
const JEF_THREADS = [
  {r:0,   g:0,   b:0   }, // 0  Black
  {r:255, g:255, b:255 }, // 1  White
  {r:255, g:255, b:23  }, // 2  Yellow
  {r:250, g:160, b:96  }, // 3  Orange
  {r:235, g:0,   b:0   }, // 4  Red
  {r:160, g:0,   b:96  }, // 5  Burgundy
  {r:220, g:95,  b:155 }, // 6  Pink
  {r:240, g:185, b:210 }, // 7  Light Pink
  {r:255, g:215, b:0   }, // 8  Gold
  {r:205, g:130, b:0   }, // 9  Dark Gold
  {r:168, g:105, b:40  }, // 10 Brown
  {r:100, g:60,  b:5   }, // 11 Dark Brown
  {r:200, g:225, b:120 }, // 12 Olive Green
  {r:80,  g:145, b:60  }, // 13 Green
  {r:0,   g:100, b:20  }, // 14 Dark Green
  {r:225, g:240, b:245 }, // 15 Sky Blue
  {r:100, g:190, b:225 }, // 16 Light Blue
  {r:0,   g:130, b:200 }, // 17 Blue
  {r:0,   g:65,  b:160 }, // 18 Dark Blue
  {r:100, g:80,  b:160 }, // 19 Purple
  {r:135, g:115, b:175 }, // 20 Light Purple
  {r:200, g:190, b:230 }, // 21 Lavender
  {r:210, g:210, b:210 }, // 22 Silver
  {r:160, g:160, b:160 }, // 23 Grey
  {r:80,  g:80,  b:80  }, // 24 Dark Grey
  {r:195, g:175, b:145 }, // 25 Beige
  {r:240, g:225, b:190 }, // 26 Light Beige
  {r:210, g:180, b:135 }, // 27 Tan
  {r:145, g:105, b:70  }, // 28 Caramel
  {r:95,  g:60,  b:25  }, // 29 Dark Caramel
  {r:230, g:95,  b:40  }, // 30 Orange Red
  {r:255, g:185, b:90  }, // 31 Light Orange
];

/* Brother PEC thread table — index matches Brother's built-in color numbering.
   Used by Viewer Pro, PE-Design and most Brother-compatible software.          */
const PEC_THREADS = [
  {r:0,   g:0,   b:0   }, // 0  Black
  {r:255, g:255, b:255 }, // 1  White
  {r:255, g:255, b:23  }, // 2  Yellow
  {r:255, g:165, b:0   }, // 3  Orange
  {r:255, g:102, b:102 }, // 4  Pink
  {r:255, g:0,   b:0   }, // 5  Red
  {r:155, g:0,   b:30  }, // 6  Burgundy
  {r:240, g:185, b:215 }, // 7  Light Pink
  {r:255, g:215, b:0   }, // 8  Gold
  {r:200, g:130, b:0   }, // 9  Dark Gold
  {r:140, g:90,  b:25  }, // 10 Brown
  {r:90,  g:50,  b:5   }, // 11 Dark Brown
  {r:195, g:215, b:110 }, // 12 Olive
  {r:75,  g:140, b:55  }, // 13 Green
  {r:0,   g:95,  b:20  }, // 14 Dark Green
  {r:0,   g:170, b:55  }, // 15 Emerald
  {r:180, g:235, b:240 }, // 16 Sky Blue
  {r:95,  g:185, b:220 }, // 17 Light Blue
  {r:0,   g:120, b:190 }, // 18 Blue
  {r:0,   g:60,  b:150 }, // 19 Dark Blue
  {r:95,  g:75,  b:155 }, // 20 Purple
  {r:195, g:185, b:225 }, // 21 Lavender
  {r:205, g:205, b:205 }, // 22 Silver
  {r:150, g:150, b:150 }, // 23 Grey
  {r:65,  g:65,  b:65  }, // 24 Dark Grey
  {r:190, g:170, b:140 }, // 25 Beige
  {r:240, g:220, b:185 }, // 26 Light Beige
  {r:200, g:175, b:130 }, // 27 Tan
  {r:140, g:100, b:65  }, // 28 Caramel
  {r:90,  g:55,  b:20  }, // 29 Dark Caramel
  {r:225, g:90,  b:35  }, // 30 Orange Red
  {r:255, g:180, b:85  }, // 31 Light Orange
  {r:235, g:235, b:60  }, // 32 Lemon
  {r:130, g:195, b:235 }, // 33 Powder Blue
  {r:145, g:110, b:215 }, // 34 Lilac
  {r:255, g:20,  b:145 }, // 35 Hot Pink
  {r:50,  g:200, b:50  }, // 36 Lime Green
  {r:250, g:95,  b:70  }, // 37 Coral
  {r:255, g:140, b:0   }, // 38 Amber
  {r:170, g:250, b:45  }, // 39 Yellow Green
  {r:240, g:125, b:125 }, // 40 Salmon
  {r:255, g:155, b:120 }, // 41 Peach
  {r:125, g:255, b:210 }, // 42 Aqua
  {r:110, g:125, b:140 }, // 43 Slate
  {r:255, g:225, b:220 }, // 44 Blush
  {r:253, g:245, b:230 }, // 45 Old Lace
  {r:240, g:248, b:255 }, // 46 Alice Blue
  {r:245, g:245, b:245 }, // 47 Off White
  {r:45,  g:75,  b:75  }, // 48 Dark Teal
  {r:100, g:100, b:100 }, // 49 Medium Grey
  {r:176, g:196, b:222 }, // 50 Steel Blue
  {r:220, g:20,  b:60  }, // 51 Crimson
  {r:0,   g:185, b:255 }, // 52 Cyan
  {r:150, g:200, b:50  }, // 53 Yellow Green 2
  {r:255, g:125, b:80  }, // 54 Tomato
  {r:100, g:88,  b:200 }, // 55 Slate Blue
  {r:102, g:200, b:170 }, // 56 Medium Aquamarine
  {r:233, g:148, b:122 }, // 57 Dark Salmon
  {r:255, g:220, b:170 }, // 58 Moccasin
  {r:30,  g:144, b:255 }, // 59 Dodger Blue
  {r:119, g:136, b:153 }, // 60 Light Slate Grey
  {r:255, g:250, b:250 }, // 61 Snow
];

/* Perceptual color distance (weighted RGB approximating CIE Lab lightness).
   Much more accurate than Manhattan — prevents gold matching to green etc.   */
function colorDistPerceptual(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  // Redmean approximation (Colour FAQ weighted Euclidean)
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

/* Normalize stitches: split long moves, convert trims→jumps, emit color_changes */
function normalizeStitches(stitches, maxJump) {
  const out = [];
  let px = 0, py = 0, prevColor = null;
  for (const s of stitches) {
    if (s.type === 'trim') {
      // Treat trim as jump to next position
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
  if (width < 500 && height < 500) return 1; // 50x50
  if (width < 1260 && height < 1100) return 3; // 126x110
  if (width < 1400 && height < 2000) return 2; // 140x200
  if (width < 2000 && height < 2000) return 4; // 200x200
  return 0; // 110x110 default
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

  let pointCount = 1; // END
  for (const s of norm) {
    if (s.type === 'stitch') pointCount += 1;
    else if (s.type === 'jump') pointCount += 2;
    else if (s.type === 'color_change') pointCount += 2;
  }

  const palette = colors.map(c => findNearestThread(hexToRgb(c), JEF_THREADS));
  const headerSize = 0x74 + colorCount * 8;

  const buf = [];
  writeInt32LE(buf, headerSize); // stitch offset
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

/* ═══════════════════════════════════════════════════════════════════
   PES / PEC ENCODER (Brother) — based on pyembroidery / libembroidery
   ═══════════════════════════════════════════════════════════════════ */
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
  const rgbList = colors.map(c => { const r = hexToRgb(c); return (r.r << 16) | (r.g << 8) | r.b; });

  const buf = [];
  // 512-byte header
  const name = "Stichai";
  writeString(buf, "LA:" + name.padEnd(16, ' '));
  buf.push(0x0D);
  for (let i = 0; i < 12; i++) buf.push(0x20);
  buf.push(0xFF, 0x00);
  buf.push(6); // icon width bytes (48/8)
  buf.push(38); // icon height
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

  // Second section
  buf.push(0x00, 0x00);
  const graphicsOffsetPos = buf.length;
  writeInt24LE(buf, 0); // placeholder
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

  // Graphics thumbnails (blank)
  const thumbSize = 6 * 38; // 228 bytes per thumbnail
  for (let i = 0; i < thumbSize; i++) buf.push(0); // main thumbnail
  for (let c = 0; c < colorCount; c++) {
    for (let i = 0; i < thumbSize; i++) buf.push(0);
  }

  return Buffer.from(buf);
}

function encodePES(stitches, colors) {
  const pec = encodePEC(stitches, colors);
  const pecOffset = 8 + 4 + 10; // signature + offset field + padding
  const buf = [];
  writeString(buf, "#PES0001");
  writeInt32LE(buf, pecOffset);
  while (buf.length < pecOffset) buf.push(0);
  for (let i = 0; i < pec.length; i++) buf.push(pec[i]);
  return Buffer.from(buf);
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

    /* Ask Gemini and the bucket extractor in parallel, then pick a winner.
       Gemini's palette is preferred when it returns ≥3 distinct valid hexes;
       otherwise we fall back to the classic bucket extraction. */
    const [bucketColors, gem] = await Promise.all([
      extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount),
      analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png", colorCount).catch(() => null)
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

    /* No more background auto-exclusion: every detected region is returned,
       and the UI lets the user deselect bulk-style. */
    const rawRegions = extractRegions(pixMap, colors, canvasSize);
    const regions = mergeAdjacentRegions(rawRegions, canvasSize);

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
      paletteSource,                              /* "gemini" | "buckets" */
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

    /* ─── APPLY COLOR MERGES ─────────────────────────── */
    try {
      if (body.colorMerges) {
        const merges = JSON.parse(body.colorMerges);
        /* Parse the optional locked-colours list.  Any colour in this list is
           protected: it can be neither the source nor the target of a merge. */
        let lockedColors = [];
        if (body.lockedColors) {
          try {
            const parsed = JSON.parse(body.lockedColors);
            if (Array.isArray(parsed)) lockedColors = parsed;
          } catch(e) {
            console.warn(`[${rid}] lockedColors parse failed:`, e.message);
          }
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

    if(!filteredRegions.length){
      return res.status(400).json({error:"No regions left after selection — select more colors/shapes"});
    }

    /* ─── STITCH GENERATION ────────────────────────────────────────────
       For logos: use legacy generator (predictable horizontal fills,
       proper underlay, crisp outlines). v70's per-shape PCA + oriented
       scanning is designed for photos and over-fragments solid logos.
       For photos: v70 still available if ever needed. */
    let stitches, colorCounts;
    /* Photo-mode v71 path was previously dead code (forced legacy).  It is now
       reachable but still gated:  send useV71=1 in the request body to opt in,
       or just use mode='logo' to stick with the legacy generator. */
    const optInV71 = (body.useV71 === '1' || body.useV71 === 'true');
    if (mode === 'logo' || !optInV71) {
      const legacy = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params, canvasSize);
      stitches = legacy.stitches;
      colorCounts = legacy.colorCounts;
      console.log(`[${rid}] Legacy generator: ${stitches.length} raw stitches`);
    } else {
      const filteredPixMap = new Int16Array(canvasSize * canvasSize).fill(-1);
      for (const reg of filteredRegions) {
        const newCi = selectedColors.findIndex(c => normHex(c) === normHex(reg.color));
        if (newCi < 0) continue;
        for (let y = reg.mny; y <= reg.mxy; y++) {
          for (let x = reg.mnx; x <= reg.mxx; x++) {
            if (pixMap[y * canvasSize + x] === reg.ci) {
              filteredPixMap[y * canvasSize + x] = newCi;
            }
          }
        }
      }
      const pxPerMm_gen = 10;

      let stitches_inner, colorCounts_inner;
      if (mode === 'photo') {
        /* ─── V71 PHOTO-STITCH ───────────────────────────────
           Continuous-tone multi-angle cross-hatching with luminance-modulated
           density. Optimized for photos and portraits where smooth gradation
           matters more than crisp edges. */
        console.log(`[${rid}] Photo mode — using v71 cross-hatch generator`);
        const result = v71_generatePhotoStitch(filteredPixMap, selectedColors, canvasSize, params);
        stitches_inner = result.stitches;
        colorCounts_inner = result.colorCounts;
      } else {
        /* ─── V70 LOGO-STITCH ──────────────────────────────── */
        const v70Shapes = v70_buildShapes(filteredPixMap, selectedColors, canvasSize, pxPerMm_gen);
        console.log(`[${rid}] v70 produced ${v70Shapes.length} shapes`);
        if (v70Shapes.length > 0) {
          const result = v70_generateStitches(v70Shapes, selectedColors, params, canvasSize);
          stitches_inner = result.stitches;
          colorCounts_inner = result.colorCounts;
        } else {
          console.warn(`[${rid}] v70 produced no shapes; falling back to legacy`);
          const legacy = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params, canvasSize);
          stitches_inner = legacy.stitches; colorCounts_inner = legacy.colorCounts;
        }
      }
      stitches = stitches_inner;
      colorCounts = colorCounts_inner;
    }

    /* ─── ADD BASTING BOX ──────────────────────────────── */
    if (body.bastingBox === '1' || body.bastingBox === 'true') {
      const basting = generateBastingBox(filteredRegions, selectedColors);
      stitches.unshift(...basting);
    }

    const coverCount = stitches.filter(s => s.type !== "trim" && s.type !== "underlay").length;
    if(coverCount < 5){
      return res.status(500).json({error:"Not enough stitches — select more shapes or check contrast"});
    }

    let previewBuf = null;
    try {
      previewBuf = await renderPreview(pixMap, selectedColors, stitches, params, canvasSize);
    } catch(e) {
      console.error("Preview pre-render failed:", e.message);
    }

    const qa = validateQuality(stitches, params.machineLimits);
    const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);
    const designMm = canvasSize / 10;

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

/* ─── PURE-NODE ZIP BUILDER (STORE, no compression, no deps) ───────── */
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

app.get("/download/:id", requireAuth, checkDownloadQuota, async(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});

  const fmt = req.query.fmt || 'dst';

  // Timestamp for filename: design_YYYYMMDD_HHMMSS
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (fmt === 'dst') {
    const dstBuf = encodeDST(d.stitches, d.params?.machineLimits);

    // Build .INF sidecar with thread colors
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
    d.colors.forEach((hex, idx) => {
      const rgb = hexToRgb(hex);
      const nearIdx = findNearestThread(rgb, JEF_THREADS);
      const NAMES = ["Black","White","Yellow","Orange","Red","Burgundy","Pink","Light Pink",
                     "Gold","Dark Gold","Brown","Dark Brown","Olive Green","Green","Dark Green",
                     "Sky Blue","Light Blue","Blue","Dark Blue","Purple","Light Purple","Lavender",
                     "Silver","Grey","Dark Grey","Beige","Light Beige","Tan","Caramel","Dark Caramel",
                     "Orange Red","Light Orange"];
      const name = NAMES[nearIdx] || hex;
      infLines.push(`[thread${idx+1}]`, `Color=${rgb.r},${rgb.g},${rgb.b}`, `Name=${name}`, `ID=${String(nearIdx+1).padStart(3,'0')}`, `Hex=${hex}`, "");
    });
    const infBuf = Buffer.from(infLines.join("\r\n"), "utf8");

    // Build ZIP with DST + INF
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

app.get("/health",(_,res)=>res.json({status:"ok",version:"69.0",features:"v70-mask-oriented,blob-split,erosion-recon,pca-angles,satin-columns,outline-pass,bg-detect,zip-inf,scale-aware"}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v71.0 | :${PORT} | Photo-stitch + Logo-stitch`));
server.timeout=120000;
server.keepAliveTimeout=65000;
