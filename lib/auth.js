"use strict";

/**
 * Auth, quota and billing helpers.
 * Depends on firebase-admin and stripe being initialised in bot.js,
 * then injected via setServices().
 */

let admin  = null;
let db     = null;
let stripe = null;
let fbReady = false;

function setServices(services) {
  admin   = services.admin;
  db      = services.db;
  stripe  = services.stripe;
  fbReady = services.fbReady;
}

/* ── Plans ──────────────────────────────────────────────── */
const PLANS = {
  none:   { label: "No plan",  downloadsPerPeriod: 0,    period: "day"   },
  trial:  { label: "Trial",    downloadsPerPeriod: 1,    period: "day",  trialDays: 7 },
  simple: { label: "Simple",   downloadsPerPeriod: 7,    period: "week"  },
  pro:    { label: "Pro",      downloadsPerPeriod: 30,   period: "week"  },
  promax: { label: "Pro Max",  downloadsPerPeriod: null, period: "month" },
};

function buildPrices() {
  return {
    simple_m: { id: process.env.STRIPE_PRICE_SIMPLE_M,  plan: "simple",  label: "Simple Monthly",  price: "$5.99/mo",   annual: false },
    simple_y: { id: process.env.STRIPE_PRICE_SIMPLE_Y,  plan: "simple",  label: "Simple Annual",   price: "$47.99/yr",  annual: true  },
    pro_m:    { id: process.env.STRIPE_PRICE_PRO_M,     plan: "pro",     label: "Pro Monthly",     price: "$14.99/mo",  annual: false },
    pro_y:    { id: process.env.STRIPE_PRICE_PRO_Y,     plan: "pro",     label: "Pro Annual",      price: "$119.99/yr", annual: true  },
    promax_m: { id: process.env.STRIPE_PRICE_PROMAX_M,  plan: "promax",  label: "Pro Max Monthly", price: "$29.99/mo",  annual: false },
    promax_y: { id: process.env.STRIPE_PRICE_PROMAX_Y,  plan: "promax",  label: "Pro Max Annual",  price: "$239.99/yr", annual: true  },
  };
}

function getPeriodStart(period) {
  const now = new Date();
  if (period === "day")   return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === "week") {
    const monday = now.getUTCDate() - ((now.getUTCDay() + 6) % 7);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), monday);
  }
  if (period === "month") return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return Date.now();
}

async function getOrCreateUser(uid, extra = {}) {
  if (!db) return null;
  const ref  = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const now      = Date.now();
  const isOAuth  = extra.provider && extra.provider !== "password";
  const user = {
    uid,
    email:                extra.email    || "",
    provider:             extra.provider || "unknown",
    plan:                 isOAuth ? "trial" : "none",
    planGrantedBy:        "system",
    planGrantedAt:        now,
    trialStart:           isOAuth ? now : null,
    trialExpires:         isOAuth ? now + 7 * 86400000 : null,
    stripeCustomerId:     null,
    stripeSubscriptionId: null,
    periodStart:          getPeriodStart("day"),
    downloadsThisPeriod:  0,
    createdAt:            now,
  };
  await ref.set(user);
  return user;
}

function checkQuota(user) {
  if (!user) return { allowed: false, reason: "no_user" };
  const plan = PLANS[user.plan] || PLANS.none;
  if (user.plan === "none")  return { allowed: false, reason: "no_plan",       upgrade: true };
  if (user.plan === "trial") {
    if (user.trialExpires && Date.now() > user.trialExpires)
      return { allowed: false, reason: "trial_expired", upgrade: true };
  }
  if (plan.downloadsPerPeriod === null) return { allowed: true, remaining: Infinity };
  const currentStart = getPeriodStart(plan.period);
  const count        = (user.periodStart >= currentStart) ? (user.downloadsThisPeriod || 0) : 0;
  const remaining    = plan.downloadsPerPeriod - count;
  if (remaining <= 0) return { allowed: false, reason: "quota_exceeded", remaining: 0, upgrade: true };
  return { allowed: true, remaining };
}

async function recordDownload(uid) {
  if (!db) return;
  const ref  = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return;
  const user  = snap.data();
  const plan  = PLANS[user.plan] || PLANS.none;
  if (plan.downloadsPerPeriod === null) return;
  const currentStart = getPeriodStart(plan.period);
  const isSamePeriod = (user.periodStart || 0) >= currentStart;
  await ref.update({
    periodStart:           currentStart,
    downloadsThisPeriod:   isSamePeriod
      ? admin.firestore.FieldValue.increment(1)
      : 1,
    lastDownload: Date.now(),
  });
}

/* ── Middleware ─────────────────────────────────────────── */
async function requireAuth(req, res, next) {
  if (!fbReady) return next();
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "auth_required" });
  try {
    const decoded  = await admin.auth().verifyIdToken(token);
    req.firebaseUser = decoded;
    req.userDoc      = await getOrCreateUser(decoded.uid, {
      email:    decoded.email || "",
      provider: decoded.firebase?.sign_in_provider || "unknown",
    });
    next();
  } catch (e) {
    const code = e && e.code;
    if (code === "auth/id-token-expired") return res.status(401).json({ error: "token_expired" });
    return res.status(401).json({ error: "invalid_token" });
  }
}

function checkDownloadQuota(req, res, next) {
  if (!fbReady) return next();
  const result = checkQuota(req.userDoc);
  if (!result.allowed) {
    return res.status(403).json({ error: result.reason, upgrade: true });
  }
  req.quotaRemaining = result.remaining;
  next();
}

module.exports = {
  PLANS,
  buildPrices,
  getPeriodStart,
  getOrCreateUser,
  checkQuota,
  recordDownload,
  requireAuth,
  checkDownloadQuota,
  setServices,
};
