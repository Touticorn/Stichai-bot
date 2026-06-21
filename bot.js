/**
 * Stichai v73.0 — Modular production server
 * ═══════════════════════════════════════════
 * Entry point only — business logic lives in lib/
 *
 *  lib/lru.js    — LRUMap cache
 *  lib/jobs.js   — job queue + WebSocket progress
 *  lib/auth.js   — Firebase auth, quota, Stripe billing
 *  lib/gemini.js — Gemini AI helpers (segment, palette, cartoon)
 *  lib/image.js  — image preprocessing + pixel map
 *  lib/stitch.js — stitch generation engine (v70 / v71 / legacy)
 *  lib/export.js — DST / JEF / PES / PDF export
 *  routes/index.js — all Express routes
 */

"use strict";

const express  = require("express");
const path     = require("path");
const socketIO = require("socket.io");

/* ── Optional services ─────────────────────────────────── */
let admin  = null;
let Stripe = null;
try { admin  = require("firebase-admin"); } catch (e) { console.warn("firebase-admin not installed"); }
try { Stripe = require("stripe"); }         catch (e) { console.warn("stripe not installed"); }

/* ── Firebase init ─────────────────────────────────────── */
let db      = null;
let fbReady = false;
try {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (admin && svc) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
    db      = admin.firestore();
    fbReady = true;
    console.log("Firebase Admin ready");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT not set — auth disabled");
  }
} catch (e) { console.error("Firebase init:", e.message); }

/* ── Stripe init ───────────────────────────────────────── */
const stripe = process.env.STRIPE_SECRET_KEY && Stripe
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ── Inject services into auth module ──────────────────── */
const auth = require("./lib/auth");
auth.setServices({ admin, db, stripe, fbReady });

/* ── Job queue: inject IO later ────────────────────────── */
const jobs = require("./lib/jobs");

/* ── Express app ───────────────────────────────────────── */
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ── Routes ────────────────────────────────────────────── */
const routes = require("./routes/index");
app.use(addSecurityHeaders);
app.use("/", routes);

/* ── Static files ──────────────────────────────────────── */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ── Health check ──────────────────────────────────────── */
app.get("/health", (_, res) =>
  res.json({
    status:  "ok",
    version: "73.0",
    queue:   jobs.jobQueue.length,
    running: jobs.runningJobs,
    commit:  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "unknown",
  })
);

/* ── Start server + WebSocket ──────────────────────────── */
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`Stichai v73.0 | :${PORT}`)
);

const io = socketIO(server, { cors: { origin: "*" } });
jobs.setIo(io);

io.on("connection", (socket) => {
  socket.on("subscribe", (jobId)  => socket.join(`job:${jobId}`));
  socket.on("cancel",    (jobId)  => jobs.cancelJob(jobId));
});

server.timeout         = 120000;
server.keepAliveTimeout = 65000;

// Added by supreme: addSecurityHeaders
function addSecurityHeaders(req, res, next) {
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Clickjacking protection
  res.setHeader("X-Frame-Options", "DENY");
  // Explicitly disable the deprecated XSS filter – modern XSS protection comes from CSP
  res.setHeader("X-XSS-Protection", "0");
  // Referrer policy: strip path/query when crossing origins
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions: deny sensitive browser features by default
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // COOP: same-origin-allow-popups – required for Google OAuth popups
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  // Conditional HSTS – emit only for HTTPS (production or proxied)
  if (process.env.NODE_ENV === "production" || req.secure === true || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}
// NOTE: Content-Security-Policy is deliberately omitted pending a full audited allowlist
// (Google Identity, Stripe, Gemini, Socket.IO would be broken otherwise).
// This middleware must be registered with app.use(addSecurityHeaders) after body-parser/CORS/logging
// and before both the static-file middleware and app.use("/", routes).
