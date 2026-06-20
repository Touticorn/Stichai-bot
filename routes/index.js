"use strict";

/**
 * All Express routes for Stichai.
 * Depends on lib/ modules; services injected from bot.js via module singletons.
 */

const express = require("express");
const multer  = require("multer");
const router  = express.Router();
const upload  = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const { requireAuth, checkDownloadQuota, checkQuota, recordDownload, buildPrices, PLANS, getOrCreateUser, getPeriodStart } = require("../lib/auth");
const { enqueueJob, cancelJob, activeJobs }                = require("../lib/jobs");
const { segmentSubjectWithGemini, convertToCartoonWithGemini, analyzeWithGemini, extractSubjectImage, extractSubjectAsCartoon } = require("../lib/gemini");
const { analyzeWithQwen, convertToCartoonWithQwen } = require("../lib/fireworks-qwen");

/**
 * Tier-AI: Gemini → Qwen fallback chain.
 * - When STICHAI_AI_BACKEND === "gemini": Gemini primary, Qwen on null/deplete
 * - When STICHAI_AI_BACKEND === "qwen":   Qwen primary, Gemini silent (kept for prod failure mode)
 * - When unset / "auto": same as gemini
 */
const AI_BACKEND = (process.env.STICHAI_AI_BACKEND || "auto").toLowerCase();
async function analyzeWithAI(buf, mime, colorCount) {
  if (AI_BACKEND === "qwen") return await analyzeWithQwen(buf, mime, colorCount);
  try {
    const r = await analyzeWithGemini(buf, mime, colorCount);
    if (r) return r;
  } catch (_) { /* fall through */ }
  console.warn("[ai] Gemini null/depleted → Qwen fallback");
  return await analyzeWithQwen(buf, mime, colorCount);
}
async function cartoonizeWithAI(buf, mime, colorCount) {
  if (AI_BACKEND === "qwen") return await convertToCartoonWithQwen(buf, mime, colorCount);
  try {
    const r = await convertToCartoonWithGemini(buf, mime, colorCount);
    if (r) return r;
  } catch (_) { /* fall through */ }
  console.warn("[ai] Gemini cartoon null/depleted → Qwen fallback (local Sharp posterize)");
  return await convertToCartoonWithQwen(buf, mime, colorCount);
}
const { preprocessImage, extractColorsFromUnmasked, buildPixelMap, buildOutlineMask, removeBackgroundImgly, renderPreviewFast, hexToRgb, rgbToLab, dE, normHex } = require("../lib/image");
const { vectorizeToDST } = require("../lib/vectorize");
const { simplifyFaceDetail } = require("../lib/face-simplify");

// DEBUG: stash the last cartoon PNG so it can be downloaded for offline pipeline testing
let _lastCartoonBuf = null, _lastCartoonMime = "image/png";
let _lastJobId = null;
const { getStitchParams, generateStitchesFromRegions, v70_buildShapes, v70_generateStitches, v71_generatePhotoStitch, v72_buildAndGenerate, validateQuality, calculateSewTime, extractRegions, mergeAdjacentRegions, applyColorMerges, generateBastingBox } = require("../lib/stitch");
const { encodeDST, encodeJEF, encodePES, buildZipStore, generateColorChartPdf, findNearestThread, JEF_THREADS } = require("../lib/export");
const { LRUMap } = require("../lib/lru");

/* ── Shared caches ──────────────────────────────────────── */
const CACHE_MAX_SIZE = 50;
const jobs       = new LRUMap(CACHE_MAX_SIZE);   // completed job results
const detections = new LRUMap(CACHE_MAX_SIZE);   // detect-shapes results
const MAX_CANVAS_SIZE = 2400;

/* ── Drop background regions ──────────────────────────────────────────────
   NUCLEAR OPTION: the Gemini prompt reserves pure white (#FFFFFF) for
   background ONLY and uses warm off-white (#F0E8D8) for white clothing.
   So we simply drop any region whose colour is very close to pure white.
   No geometry checks, no edge-counting, no fillRatio — just colour.
   This eliminates the entire class of "gown vs backdrop" heuristic bugs. */
function spreadPalette(colors, targetCount) {
  if (!Array.isArray(colors) || colors.length === 0) return colors;
  if (!Array.isArray(colors) || colors.length >= targetCount) return colors;
  const out = [colors[0]];
  const minDE = 25; // dE76 threshold for "visually distinct"
  for (let i = 1; i < colors.length; i++) {
    const c = colors[i];
    const lab = rgbToLab(hexToRgb(c));
    let tooClose = false;
    for (const o of out) {
      const d = dE(lab, rgbToLab(hexToRgb(o)));
      if (d < minDE) { tooClose = true; break; }
    }
    if (tooClose) continue;
    out.push(c);
    if (out.length >= targetCount) break;
  }
  if (out.length < targetCount) {
    // Pad with darker/lighter/hue-rotated variants of the dominant
    const dom = colors[0];
    const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(dom);
    const baseR = m ? parseInt(m[1], 16) : 255;
    const baseG = m ? parseInt(m[2], 16) : 0;
    const baseB = m ? parseInt(m[3], 16) : 255;
    const variants = [
      [0, 0, 0],
      [255, 255, 255],
      [Math.round(baseR*0.7), Math.round(baseG*0.7), Math.round(baseB*0.7)],
      [Math.round(baseR*0.85), Math.round(baseG*0.85), Math.round(baseB*0.85)],
      [Math.min(255, Math.round(baseR*1.15)), Math.min(255, Math.round(baseG*1.15)), Math.min(255, Math.round(baseB*1.15))],
      [Math.min(255, Math.round(baseR*1.3)), Math.min(255, Math.round(baseG*1.3)), Math.min(255, Math.round(baseB*1.3))],
      [Math.min(255, baseR+30), Math.max(0, baseG-30), Math.max(0, baseB-30)],
      [Math.max(0, baseR-30), Math.min(255, baseG+30), Math.max(0, baseB-30)],
    ];
    for (const [rr, gg, bb] of variants) {
      if (out.length >= targetCount) break;
      const hex = "#" + [rr,gg,bb].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
      if (!out.includes(hex)) out.push(hex);
    }
  }
  return out.slice(0, targetCount);
}

function dropBackgroundRegions(regions, canvasSize, dropWhite) {
  if (!Array.isArray(regions) || !regions.length) return regions;
  const dominated = regions.filter(r => {
    const { r: rr, g: gg, b: bb } = hexToRgb(r.color || "#000000");
    // Chroma-key magenta: green channel far below both red and blue. (Redundant
    // with the pixel-level drop in buildPixelMap, kept as defense-in-depth.)
    const isMagenta = gg < rr - 55 && gg < bb - 55 && rr > 110 && bb > 110;
    // Pure white is the background only in non-cartoon modes. In cartoon mode the
    // background is magenta, so pure white is a real subject colour (e.g. a gown).
    const isPureWhite = dropWhite && rr >= 248 && gg >= 248 && bb >= 248;
    return !(isMagenta || isPureWhite);
  });
  const dropped = regions.length - dominated.length;
  if (dropped > 0) console.log(`[bg-drop] removed ${dropped} background region(s) (magenta${dropWhite ? "/white" : ""})`);
  return dominated;
}

/* ── Helpers ────────────────────────────────────────────── */
let admin = null;
let db    = null;
let stripe = null;
try { admin  = require("firebase-admin"); } catch (_) {}

// Lazily resolve admin/db/stripe from auth module's shared state
function getAdmin()  { return admin; }
function getDb()     { return db; }
function getStripe() { return stripe; }

// Allow bot.js to inject db and stripe after init
function setServices(s) { admin = s.admin; db = s.db; stripe = s.stripe; }

/* ── Stripe webhook ─────────────────────────────────────── */
router.post("/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.sendStatus(400);
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      return res.status(400).send(`Webhook error: ${e.message}`);
    }

    const handleSub = async (sub, active) => {
      if (!db) return;
      const snap = await db.collection("users")
        .where("stripeCustomerId", "==", sub.customer).limit(1).get();
      if (snap.empty) return;
      const priceId   = sub.items?.data?.[0]?.price?.id;
      const PRICES    = buildPrices();
      const priceEntry = Object.values(PRICES).find(p => p.id === priceId);
      await snap.docs[0].ref.update({
        plan:                 active ? (priceEntry?.plan || "simple") : "none",
        planGrantedBy:        "stripe",
        planGrantedAt:        Date.now(),
        stripeSubscriptionId: sub.id,
      });
    };

    switch (event.type) {
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

/* ── Job status ─────────────────────────────────────────── */
router.get("/job-status/:jobId", (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "done")      return res.json({ status: "done",      result:   job.result });
  if (job.status === "failed")    return res.json({ status: "failed",    error:    job.error  });
  if (job.status === "cancelled") return res.json({ status: "cancelled" });
  return res.json({ status: "processing", progress: job.progress, message: job.message });
});

/* ── Detect shapes ──────────────────────────────────────── */
router.post("/detect-shapes",
  requireAuth,
  checkDownloadQuota,
  upload.fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]),
  async (req, res) => {
    res.setTimeout(120000);
    const rid = Math.random().toString(36).slice(2, 6);
    let detectCrashStep = "init";
    try {
      let cleanedBuffer; // Tier-5+ requires this declared in outer scope
      const imgFile  = req.files?.image?.[0];
      const maskFile = req.files?.mask?.[0];
      if (!imgFile) return res.status(400).json({ error: "No image uploaded" });

      const body          = req.body || {};
      const mode          = body.mode || "logo";
      const effectiveMode = mode === "cartoon" ? "logo" : mode;
      const canvasSize    = parseInt(body.canvasSize) || 800;
      if (canvasSize > MAX_CANVAS_SIZE)
        return res.status(400).json({ error: `Canvas too large. Max ${MAX_CANVAS_SIZE}px.` });

      const colorCount = Math.min(16, Math.max(3, parseInt(body.colorCount) || (effectiveMode === "photo" ? 8 : 12)));
      console.log(`[${rid}] DETECT: mode=${mode} size=${canvasSize}px colors=${colorCount}`);

      let sourceBuffer = imgFile.buffer;
      let sourceMime   = imgFile.mimetype || "image/jpeg";
      let cartoonOk    = false;

      if (mode === "cartoon") {
        // direct mode: input is already a flat cartoon -> skip Gemini regeneration
        let alreadyFlat = false;
        try {
          const _sharp = require("sharp");
          const small = await _sharp(imgFile.buffer).resize(64,64,{fit:"fill"}).removeAlpha().raw().toBuffer();
          const h = new Map();
          for (let i=0;i<small.length;i+=3){
            const k=((small[i]>>4)<<8)|((small[i+1]>>4)<<4)|(small[i+2]>>4);
            h.set(k,(h.get(k)||0)+1);
          }
          const counts=[...h.values()].sort((x,y)=>y-x);
          const tot=counts.reduce((s,c)=>s+c,0);
          const mass=counts.slice(0,10).reduce((s,c)=>s+c,0)/tot;
          alreadyFlat = mass >= 0.60;
          console.log(`[${rid}] flatness: top-10 mass ${(100*mass).toFixed(0)}% -> ${alreadyFlat?"DIRECT (skip Gemini)":"regenerate"}`);
        } catch(e) {}
        const cartoon = alreadyFlat
          ? { buffer: imgFile.buffer, mime: sourceMime }
          : await cartoonizeWithAI(imgFile.buffer, sourceMime, colorCount);
        if (cartoon) {
          // Lock the cartoon palette deterministically. Gemini cartoon
          // regeneration is non-deterministic — colors drift per run, so
          // downstream palette extraction produces wildly different
          // "random color" outputs every request. Quantize here collapses
          // the regenerator output to a fixed number of flat blocks.
          try {
            const { quantizeBuffer } = require("../lib/quantize");
            const qq = await quantizeBuffer(cartoon.buffer, colorCount + 1);
            cartoon.buffer = qq.buffer;
            console.log(`[${rid}] Cartoon quantized to ${colorCount + 1} colors (${qq.centroids.length} centroids)`);
          } catch (e) { console.warn(`[${rid}] cartoon quantize skipped:`, e.message); }

          // Tier-1: strip magenta letterbox bars before the cartoon hits
          // preprocessImage. Without this the magenta pad bleeds into the
          // posterize step and reappears as solid bars in the final stitch
          // file (the "green/blue vertical strips beside the figures"
          // complaint). Subjects get 25-40% more canvas real estate.
          try {
            const { cropMagentaLetterbox } = require("../lib/image");
            const before = cartoon.buffer.length;
            cartoon.buffer = await cropMagentaLetterbox(cartoon.buffer);
            console.log(`[${rid}] Cartoon letterbox cropped (${before}->${cartoon.buffer.length} bytes)`);
          } catch (e) { console.warn(`[${rid}] letterbox crop skipped:`, e.message); }
          sourceBuffer = cartoon.buffer;
          sourceMime   = cartoon.mime || "image/png";
          cartoonOk    = true;
          console.log(`[${rid}] Cartoon generated OK`);
          _lastCartoonBuf = cartoon.buffer; _lastCartoonMime = cartoon.mime || "image/png";
        } else {
          console.warn(`[${rid}] Cartoon regeneration failed — posterize fallback`);
        }
      }

      // Tier-5c: photo-mode luminance sigmoid pre-pass lifts shadows so
      // posterize doesn't collapse them to background.
      if (mode === "photo") {
        try {
          const { preprocessPhotoImage } = require("../lib/image");
          cleanedBuffer = await preprocessPhotoImage(sourceBuffer, canvasSize);
          console.log(`[${rid}] photo luminance LUT applied`);
          if (cartoonOk) {
            try { cleanedBuffer = await simplifyFaceDetail(cleanedBuffer); }
            catch (e) { console.warn(`[${rid}] face-simplify skipped: ${e.message}`); }
          }
        } catch (e) {
          console.warn(`[${rid}] photo LUT skipped: ${e.message}`);
          cleanedBuffer = await preprocessImage(sourceBuffer, canvasSize, mode);
        }
      } else {
        cleanedBuffer = await preprocessImage(sourceBuffer, canvasSize, mode);
        if (cartoonOk) {
          try { cleanedBuffer = await simplifyFaceDetail(cleanedBuffer); }
          catch (e) { console.warn(`[${rid}] face-simplify skipped: ${e.message}`); }
        }
      }

      const skipGeminiPalette = mode === "cartoon" && !cartoonOk;
      const [bucketColors, gem] = await Promise.all([
        extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount),
        skipGeminiPalette
          ? Promise.resolve(null)
          : analyzeWithAI(sourceBuffer, sourceMime, colorCount).catch(() => null),
      ]);

      let colors, paletteSource;
      if (gem && Array.isArray(gem.palette) && gem.palette.length >= 3) {
        const wantsLabel = AI_BACKEND === "qwen" ? "qwen" : "gemini";
        colors       = gem.palette.slice(0, colorCount);
        paletteSource = wantsLabel;
        const gemLabs = colors.map(c => rgbToLab(hexToRgb(c)));
        for (const b of bucketColors) {
          if (colors.length >= colorCount) break;
          const bLab   = rgbToLab(hexToRgb(b));
          const minDist = Math.min(...gemLabs.map(g => dE(bLab, g)));
          if (minDist > 22 && !colors.some(c => normHex(c) === normHex(b))) {
            colors.push(b);
            gemLabs.push(bLab);
          }
        }
      } else if (bucketColors?.length >= 3) {
        colors       = bucketColors;
        paletteSource = "buckets";
      } else {
        // Bucket extraction collapsed (e.g. magenta-heavy cartoon with mask skipped
        // every pixel, or photo that fills 200x200 with one gradient). Fall back
        // to the median-cut quantized centroids from quantize.js so we still get
        // a usable palette instead of the generic 5-color guess.
        let quantColors = null;
        let qbForOverride = null;
        try {
          const { quantizeBuffer } = require("../lib/quantize");
          // sample centroids by running quantize on the *cartoon* buffer
          // (post-letterbox + post-quantize). The cartoon path stores it in _lastCartoonBuf.
          // Use centroids directly so N cluster heads are always represented,
          // even if pixel-walk would have missed small clusters.
          const qq = await quantizeBuffer(
            (typeof _lastCartoonBuf !== "undefined" && _lastCartoonBuf) || sourceBuffer,
            colorCount + 1
          );
          qbForOverride = qq.buffer;
          const centerHexes = (qq.centroids || []).map(([r,g,b]) =>
            "#" + [r,g,b].map(c => c.toString(16).padStart(2,"0")).join("").toUpperCase()
          );
          // Order by pixel frequency descending so most common becomes colors[0].
          const qRaw = await require("sharp")(qq.buffer).raw().toBuffer({ resolveWithObject: true });
          const hexCounts = new Map();
          const { data, info: qinfo } = qRaw;
          const ch = qinfo.channels;
          for (let i = 0; i < data.length; i += ch) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const hex = "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
            hexCounts.set(hex, (hexCounts.get(hex) || 0) + 1);
          }
          centerHexes.sort((a, b) => (hexCounts.get(b) || 0) - (hexCounts.get(a) || 0));
          quantColors = centerHexes.slice(0, colorCount);
        } catch (e) {
          console.warn(`[${rid}] centroid fallback failed:`, e.message);
        }
        if (quantColors && quantColors.length >= 3) {
          // Hue-spread: if all N centroids cluster too tightly (median-cut
          // snapped subtle RGB variants of the same hue), each pixel-mapped
          // region would similarly snap to one color, yielding "N shapes
          // with 1 color". Force a minimum dE between adjacent palette
          // entries by adding light/dark/hue-rotated siblings.
          const spread = spreadPalette(quantColors, colorCount);
          colors       = spread;
          paletteSource = "centroids";
          if (qbForOverride) {
            cleanedBuffer = qbForOverride;
            console.log(`[${rid}] centroid fallback overriding cleanedBuffer with ${colorCount + 1}-color quantized cartoon`);
          }
          console.log(`[${rid}] centroid fallback produced ${colors.length} colors from quantized cartoon (top: ${colors.slice(0,4).join(",")})`);
        } else if (quantColors && quantColors.length >= 1) {
          // Accept even 1 saturated magenta-dominant color: pad to colorCount
          // by darker/lighter variants so downstream regions per-region
          // detection has real color variation (prevents "N shapes with 1 color").
          const dom = quantColors[0];
          const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(dom);
          const baseR = m ? parseInt(m[1], 16) : 255;
          const baseG = m ? parseInt(m[2], 16) : 0;
          const baseB = m ? parseInt(m[3], 16) : 255;
          const padded = [...quantColors];
          const variants = [
            [0,    0,    0   ],       // pure black
            [255,  255,  255 ],       // pure white
            [Math.round(baseR*0.7), Math.round(baseG*0.7), Math.round(baseB*0.7)], // 70% darker
            [Math.round(baseR*0.85),Math.round(baseG*0.85),Math.round(baseB*0.85)],// 85% darker
            [Math.min(255, Math.round(baseR*1.15)), Math.min(255, Math.round(baseG*1.15)), Math.min(255, Math.round(baseB*1.15))], // 115% lighter
            [Math.min(255, Math.round(baseR*1.3)),  Math.min(255, Math.round(baseG*1.3)),  Math.min(255, Math.round(baseB*1.3))], // 130% lighter
            [Math.min(255, baseR+30), Math.max(0, baseG-30), Math.max(0, baseB-30)], // shifted toward red
            [Math.max(0, baseR-30), Math.min(255, baseG+30), Math.max(0, baseB-30)], // shifted toward green
          ];
          for (const [rr, gg, bb] of variants) {
            if (padded.length >= colorCount) break;
            const hex = "#" + [rr,gg,bb].map(c=>c.toString(16).padStart(2,"0")).join("").toUpperCase();
            if (!padded.includes(hex)) padded.push(hex);
          }
          colors       = padded.slice(0, colorCount);
          paletteSource = "centroids-partial";
          if (qbForOverride) cleanedBuffer = qbForOverride;
          console.log(`[${rid}] centroid partial: ${quantColors.length} unique, padded to ${colors.length} (top: ${quantColors.slice(0,2).join(",")})`);
        } else {
          colors       = ["#000000", "#FFFFFF", "#FF0000", "#0000FF", "#FFFF00"];
          paletteSource = "fallback";
        }
      }
      console.log(`[${rid}] Palette ${paletteSource} (${colors.length}): ${colors.join(", ")}`);

      // Cartoon face-palette: detect face rectangles in source image and
      // prepend extra colors so facial features survive quantization.
      if (mode === "cartoon" && !body.skipFacePalette) {
        try {
          const { extractFacePalette } = require("../lib/face-palette");
          const faces = await extractFacePalette(sourceBuffer, { colorsPerFace: 3, scanWidth: 256 });
          const seenHex = new Set(colors.map(c => (c || "").toLowerCase()));
          const added = [];
          for (const f of faces) {
            for (const c of f.colors) {
              const k = c.toLowerCase();
              if (seenHex.has(k) || added.includes(k)) continue;
              added.push(c);
              seenHex.add(k);
            }
          }
          if (added.length) {
            // HARD CAP: never grow palette past user-requested colorCount.
            // Face colors take priority over body colors.
            colors = added.concat(colors).slice(0, colorCount);
            console.log(`[${rid}] face-palette added ${Math.min(added.length, colorCount)} (kept total=${colors.length}/${colorCount})`);
          }
          // Safety net: any downstream addition that slipped past.
          if (colors.length > colorCount) {
            console.warn(`[${rid}] clamp palette ${colors.length}->${colorCount}`);
            colors = colors.slice(0, colorCount);
          }
        } catch (e) {
          console.warn(`[${rid}] face-palette skipped:`, e.message);
        }
      }

      detectCrashStep = "buildPixelMap";
      const pixMap    = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
      detectCrashStep = "extractRegions";
      const rawRegions = extractRegions(pixMap, colors, canvasSize, effectiveMode);
      let regions     = mergeAdjacentRegions(rawRegions, canvasSize);
      if (body.extractedSubject === "1" || body.extractedSubject === true || mode === "cartoon") {
        const _b = regions.length;
        regions = dropBackgroundRegions(regions, canvasSize, mode !== "cartoon");
        if (regions.length !== _b) console.log(`[${rid}] dropped ${_b - regions.length} background region(s)`);
      }

      if (!regions.length) return res.status(500).json({ error: "No stitchable regions found" });

      const shapes = regions.map(r => ({
        type:   r.type,
        color:  normHex(r.color),
        points: [[r.mnx, r.mny], [r.mxx, r.mny], [r.mxx, r.mxy], [r.mnx, r.mxy], [r.mnx, r.mny]],
        bounds: { x: r.mnx, y: r.mny, w: r.mxx - r.mnx, h: r.mxy - r.mny },
        stitchCount: 0,
      }));

      const detectionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      detections.set(detectionId, { pixMap, regions, colors, cleanedBuffer, geminiNotes: gem?.notes || "", timestamp: Date.now(), mode, canvasSize });

      const colorInfo = {};
      colors.forEach(c => { colorInfo[c] = { label: "", coverage_pct: 0 }; });

      return res.json({
        success: true, detectionId, colors, paletteSource,
        colorMeta: colorInfo, shapes, designMm: canvasSize / 10,
        geminiNotes: gem?.notes || "",
      });
    } catch (e) {
      console.error(`[${rid}] DETECT crash:`, e.message);
      console.error(`[${rid}] DETECT stack:`, e.stack);
      return res.status(500).json({ error: e.message || "Detection failed", step: detectCrashStep });
    }
  }
);

/* ── Generate embroidery ────────────────────────────────── */
router.post("/generate-embroidery",
  requireAuth,                // FIX: was missing auth — security hole patched
  checkDownloadQuota,
  upload.fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]),
  async (req, res) => {
    const rid     = Math.random().toString(36).slice(2, 8);
    const jobId   = Date.now().toString(36) + rid;
    const socketId = req.headers["x-socket-id"] || null;

    const generateFn = async (progressCb) => {
      const imgFile  = req.files?.image?.[0];
      const maskFile = req.files?.mask?.[0];
      if (!imgFile) throw new Error("No image uploaded");

      const body  = req.body || {};
      const specs = {
        fabric:      body.fabric      || "cotton",
        machine:     body.machine     || "generic",
        hoop:        body.hoop        || "5x7",
        density:     body.density     || "medium",
        thread:      body.thread      || "generic",
        stabilizer:  body.stabilizer  || "cutaway",
        instructions: body.instructions || "",
      };
      let canvasSize = parseInt(body.canvasSize) || 800;
      const params   = getStitchParams(specs, canvasSize);
      progressCb(5, "Preparing image…");

      const det = body.detectionId ? detections.get(body.detectionId) : null;
      let pixMap, regions, colors, mode, cleanedBuffer;

      if (det) {
        ({ pixMap, regions, colors, canvasSize, mode } = det); cleanedBuffer = det.cleanedBuffer;
        // Honor step-3 slider: if the user's requested colorCount is smaller
        // than the cached detection's palette, slice [0..reqColorCount] and
        // remap pixMap/regions to keep hex values consistent with the
        // frontend's selectedColors (which was keyed on the cached hex).
        // NEVER re-extract here: that would replace hex codes mid-flight and
        // break ALL downstream features (merge, shape selection, color
        // selection). Hex preservation is the contract.
        let reqColorCount;
        try {
          const raw = parseInt(body.colorCount);
          reqColorCount = !Number.isNaN(raw) && raw >= 2 && raw <= 16
            ? raw
            : (mode === "photo" ? 8 : 12);
        } catch (_) { reqColorCount = (mode === "photo" ? 8 : 12); }
        if (colors.length > reqColorCount) {
          console.log(`[${rid}] trim palette ${colors.length}->${reqColorCount} (hex-preserving)`);
          colors = colors.slice(0, reqColorCount);
          for (let i = 0; i < pixMap.length; i++) {
            if (pixMap[i] >= reqColorCount) pixMap[i] = -1;
          }
          if (regions) regions = regions.filter(r => r.ci < reqColorCount);
        }
      } else {
        mode = body.mode || "logo";
        const colorCount    = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === "photo" ? 8 : 12)));
        cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize, mode);
        colors              = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
        // Hard cap 1: extractColorsFromUnmasked can return < colorCount but never > colorCount.
        // Defense: enforce strictly here in case a future loosening lets it overshoot.
        if (colors.length > colorCount) colors = colors.slice(0, colorCount);

        // Cartoon face-palette pre-pass: detect face rectangles and prepend
        // additional skin/lip colors so facial features survive quantization.
        // Only cheap for cartoon mode (which is when this matters).
        if (mode === "cartoon" && !body.skipFacePalette) {
          try {
            const { extractFacePalette } = require("../lib/face-palette");
            const faces = await extractFacePalette(imgFile.buffer, { colorsPerFace: 3, scanWidth: 256 });
            const seenHex = new Set(colors.map(c => c.toLowerCase()));
            const added = [];
            for (const f of faces) {
              for (const c of f.colors) {
                const k = c.toLowerCase();
                if (seenHex.has(k) || added.includes(k)) continue;
                // Round to nearest of available thread colors to avoid palette explosion
                added.push(c);
                seenHex.add(k);
              }
            }
            if (added.length) {
              // HARD CAP: total palette must NEVER exceed user-requested colorCount.
              // Face colors first (priority for facial features), then drop excess body colors.
              colors = added.concat(colors).slice(0, colorCount);
              console.log(`[${rid}] face-palette added ${Math.min(added.length, colorCount)} colors (kept total=${colors.length}/${colorCount})`);
              // Rebuild pixMap to include the new colors
              pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
            } else {
              pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
            }
          } catch (e) {
            console.warn(`[${rid}] face-palette skipped:`, e.message);
            pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
          }
        } else {
          pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
        }
        // Hard cap 2: final safety net in case any downstream path added more.
        if (colors.length > colorCount) {
          console.warn(`[${rid}] clamp palette ${colors.length}->${colorCount}`);
          colors = colors.slice(0, colorCount);
        }

        const rawRegions    = extractRegions(pixMap, colors, canvasSize, mode);
        regions             = mergeAdjacentRegions(rawRegions, canvasSize);
      }
      progressCb(10, "Processing regions…");

      const effectiveMode = mode === "cartoon" ? "logo" : mode;
      if (!regions?.length) throw new Error("No stitchable regions found");

      // Apply selected colors
      let selectedColors = colors;
      try {
        if (body.selectedColors) {
          const parsed = JSON.parse(body.selectedColors);
          if (Array.isArray(parsed) && parsed.length > 0) selectedColors = parsed.map(c => normHex(c));
        }
      } catch (_) {}
      console.log(`[${rid}] SELECTED_COLORS: count=${selectedColors.length}/${colors.length} sample=[${selectedColors.slice(0,3).join(',')}...] all=${colors.map(c=>`${c}->${selectedColors.includes(c)?'on':'off'}`).join(' ')}`);

      // Apply color merges
      try {
        if (body.colorMerges) {
          const merges = JSON.parse(body.colorMerges);
          let lockedColors = [];
          if (body.lockedColors) {
            try { const p = JSON.parse(body.lockedColors); if (Array.isArray(p)) lockedColors = p; } catch (_) {}
          }
          if (Object.keys(merges).length > 0) {
            const result  = applyColorMerges(pixMap, selectedColors, merges, lockedColors);
            pixMap        = result.pixMap;
            selectedColors = result.colors;
            const rawR    = extractRegions(pixMap, selectedColors, canvasSize, effectiveMode);
            regions       = mergeAdjacentRegions(rawR, canvasSize);
          }
        }
      } catch (e) { console.error("Color merge error:", e.message); }

      // Filter selected shapes
      let filteredRegions = regions;
      let userPickedShapes = false;
      try {
        if (body.selectedShapes) {
          const parsed = JSON.parse(body.selectedShapes);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed.length < regions.length) {
            const mapped = parsed.map(idx => regions[idx]).filter(Boolean);
            // v73.0 — guard: the applyColorMerges() path above may rebuild
            // the regions array, after which the cached DETECT indices are
            // stale. If too few survive the lookup, fall back to "use all
            // regions for the chosen colors" instead of producing empty
            // filteredRegions and 500-ing downstream.
            if (mapped.length === 0 || mapped.length < parsed.length / 2) {
              console.warn(`[${rid}] selectedShapes index-lookup stale (${mapped.length}/${parsed.length}); falling back to full regions`);
              filteredRegions  = regions;
              userPickedShapes = false;
            } else {
              filteredRegions  = mapped;
              userPickedShapes = true;
            }
          }
        }
      } catch (_) {}
      console.log(`[${rid}] SELECTED_SHAPES: indices=${(function(){try{return JSON.parse(body.selectedShapes||'[]');}catch(_){return 'ERR';}})()} resolved=${filteredRegions.length}/${regions.length} sample=[${filteredRegions.slice(0,3).map(r=>r&&r.color).join(',')}]`);

      // Rebuild pixMap for excluded colors
      // FIX v73.0: If user picked individual shapes (filteredRegions is a
      // subset of regions by index), don't run the full re-extract rebuild
      // — that path would replace filteredRegions with the union of regions
      // for the kept colors, silently discarding the user's shape pick.
      //
      // Two safer paths:
      //   • userPickedShapes=false → old rebuild (full re-extract = correct)
      //   • userPickedShapes=true  → fold-color-filter into existing regions
      //     only (drop regions whose color isn't in selectedColors, keep
      //     remaining regions and their original ci/colors intact).
      if (selectedColors.length < colors.length) {
        if (userPickedShapes) {
          // Drop regions whose color was filtered out — preserves shape pick.
          filteredRegions = filteredRegions.filter(r => selectedColors.includes(normHex(r.color)));
          // Re-index each kept region's .ci so colors[reg.ci] resolves into
          // selectedColors downstream (vx_find, v72 stitch colors[reg.ci]).
          filteredRegions.forEach(r => {
            r.ci = selectedColors.findIndex(sc => sc.toLowerCase() === (r.color || "").toLowerCase());
            if (r.ci < 0) r.ci = 0; // safety: should never happen — we only kept matches
          });
        } else {
          pixMap = new Int16Array(pixMap);
          const excludedCis = new Set();
          const oldToNew    = {};
          colors.forEach((c, ci) => {
            if (!selectedColors.includes(normHex(c))) excludedCis.add(ci);
            else oldToNew[ci] = selectedColors.findIndex(sc => normHex(sc) === normHex(c));
          });
          for (let i = 0; i < pixMap.length; i++) {
            if (excludedCis.has(pixMap[i])) pixMap[i] = -1;
            else if (pixMap[i] >= 0) pixMap[i] = oldToNew[pixMap[i]];
          }
          const rawR  = extractRegions(pixMap, selectedColors, canvasSize, effectiveMode);
          filteredRegions = mergeAdjacentRegions(rawR, canvasSize);
        }
      }

      if (!filteredRegions.length) {
        // v73.0 — last-resort bounce: if shape+colour together wiped
        // filteredRegions, recover by using every region whose colour is
        // still in selectedColors. Better than a 500.
        const fallback = regions.filter(r => selectedColors.includes(normHex(r.color)));
        if (fallback.length === 0) throw new Error("No regions left after selection");
        console.warn(`[${rid}] filteredRegions empty — recovered with ${fallback.length} colour-matched regions`);
        filteredRegions = fallback;
      }
      progressCb(30, "Generating stitches…");

      // Wrap the entire STITCH-GENERATION block so any throw inside
      // vector pipeline / v72 / v70 / legacy surfaces with a tagged
      // stack trace instead of being swallowed by an outer route catch.
      let stitches, colorCounts, _engineStage = "init";
      try {
      const useV71 = body.useV71 === "1" || body.useV71 === "true";
      // Cartoon mode now uses the V70 generator (proper PCA fill angles, cleaner
      // fills on complex/concave shapes) instead of the legacy generator, which
      // produced fan/starburst artefacts on cartoon subjects.
      const useV70ForCartoon = (mode === "cartoon");
      _engineStage = "route-pick";
      console.log(`[${rid}] engine route: photo+useV71=${mode === "photo" && useV71} cartoon=${useV70ForCartoon} vec-pipe=${!!cleanedBuffer} regions=${filteredRegions.length} colors=${selectedColors.length}`);
      if (mode === "photo" && useV71) {
        const filtPm = buildFilteredPixMap(filteredRegions, selectedColors, canvasSize, pixMap, colors);
        const result = v71_generatePhotoStitch(filtPm, selectedColors, canvasSize, params);
        stitches     = result.stitches;
        colorCounts  = result.colorCounts;
      } else if (useV70ForCartoon || (effectiveMode !== "logo" && useV71)) {
        const filtPm   = buildFilteredPixMap(filteredRegions, selectedColors, canvasSize, pixMap, colors);
        // v72 unified portrait engine: outline-removal → whole-region fills +
        // underlay + tie-offs + back-to-front order + outline on top.
        let result;
        if (cleanedBuffer) { // vec-all-modes
          try {
            console.log(`[${rid}] using vector pipeline (potrace)`);
            result = await vectorizeToDST(cleanedBuffer, selectedColors, canvasSize, 10, params);
          } catch (e) {
            console.warn(`[${rid}] vectorize failed (${e.message}), falling back to v72`);
            if (cleanedBuffer) { try { params._outlineMask = await buildOutlineMask(cleanedBuffer, canvasSize, 70); } catch {} }
            result = v72_buildAndGenerate(filtPm, selectedColors, canvasSize, 10, params);
          }
        } else {
          result = v72_buildAndGenerate(filtPm, selectedColors, canvasSize, 10, params);
        }
        if (result.stitches && result.stitches.filter(s => s.type === "fill").length > 200) {
          stitches    = result.stitches;
          colorCounts = result.colorCounts;
          console.log(`[${rid}] used vector engine (potrace)`);
        } else {
          // Fallback to v70 if v72 somehow under-produced
          const v70Shapes = v70_buildShapes(filtPm, selectedColors, canvasSize, 10);
          if (v70Shapes.length > 0) {
            const r70 = v70_generateStitches(v70Shapes, selectedColors, params, canvasSize);
            stitches    = r70.stitches;
            colorCounts = r70.colorCounts;
            console.log(`[${rid}] V72 under-produced, used V70 (${v70Shapes.length} shapes)`);
          } else {
            const legacy = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params, canvasSize);
            stitches    = legacy.stitches;
            colorCounts = legacy.colorCounts;
            console.log(`[${rid}] V72+V70 found nothing, fell back to legacy`);
          }
        }
      } else {
        const legacy = generateStitchesFromRegions(pixMap, filteredRegions, selectedColors, params, canvasSize);
        stitches     = legacy.stitches;
        colorCounts  = legacy.colorCounts;
      }
      _engineStage = "engine-done";
      const _trimN = stitches.filter(s => s.type === "trim" || s.type === "jump").length;
      console.log(`[${rid}] engine output: ${stitches.length} stitches, ${_trimN} trims/jumps (${(100*_trimN/Math.max(1,stitches.length)).toFixed(1)}%), regions=${filteredRegions.length}, colors=${selectedColors.length}`);
      } catch (e) {
        _engineStage = _engineStage || "unknown";
        console.error(`[${rid}] STITCH-ENGINE failed at stage="${_engineStage}":`, e.stack || e.message);
        throw new Error(`stitch-engine[${_engineStage}]: ${e.message}`);
      }
      // Wrap the post-engine pipeline so any failure inside engine-output -> response
      // surfaces a tagged line in the logs (was previously opaque: "Job failed")
      try {
        progressCb(70, "Adding basting…");

        if (body.bastingBox === "1" || body.bastingBox === "true") {
          stitches.unshift(...generateBastingBox(filteredRegions, selectedColors));
        }

        const coverCount = stitches.filter(s => s.type !== "trim" && s.type !== "underlay").length;
        if (coverCount < 5) {
          // v73.0 — don't hard-fail when stitch count drops after shape
          // filtering+colour re-indexing. Surface it as a user-facing
          // warning and continue down the post-engine pipeline. The
          // warned output is still downloadable.
          console.warn(`[${rid}] low coverage: ${coverCount} cover stitches (${filteredRegions.length} regions, ${selectedColors.length} colours) — proceeding without throwing`);
        }
      progressCb(85, "Rendering preview…");

      let previewBuf = null;
      try { previewBuf = await renderPreviewFast(filteredRegions, selectedColors, canvasSize, pixMap); }
      catch (e) { console.error("Preview render failed:", e.message); }

      const qa      = validateQuality(stitches, params.machineLimits);
      const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);

      jobs.set(jobId, { stitches, pixMap, colors: selectedColors, params, designW: canvasSize, designH: canvasSize, designMm: canvasSize / 10, ts: Date.now(), previewBuf, sewTime, mode, canvasSize, sourceImageBuffer: imgFile.buffer, processedImageBuffer: cleanedBuffer });
      _lastJobId = jobId;  // debug/last pointer
      progressCb(100, "Complete");

      // Tier-5a: brand-thread lookup. Map each Stichai palette hex to the
      // nearest brand reference color so the user can buy physical thread.
      let threadList;
      try {
        const { buildThreadList } = require("../lib/thread-brand");
        threadList = buildThreadList(selectedColors, "madeira");
      } catch (e) {
        console.warn(`[${rid}] thread list skipped:`, e.message);
        threadList = selectedColors.map((hex, index) => ({ index, hex, code: null, name: null }));
      }

      // Tier-5d: region labels — name each color by likely role
      // (skin-warm, clothing-blue, background-light, etc.).
      let regionLabels;
      try {
        const { buildRegionLabels } = require("../lib/region-labels");
        regionLabels = buildRegionLabels(selectedColors);
      } catch (e) {
        console.warn(`[${rid}] region labels skipped:`, e.message);
        regionLabels = selectedColors.map((hex, index) => ({ index, hex, role: "midtone", label: `Color ${index + 1}` }));
      }

      const shapes = filteredRegions.map(r => {
        const sc = stitches.filter(s => s.color === r.color && s.type !== "trim" && s.type !== "underlay" && s.x >= r.mnx && s.x <= r.mxx && s.y >= r.mny && s.y <= r.mxy).length;
        return { type: r.type, color: normHex(r.color), points: [[r.mnx, r.mny], [r.mxx, r.mny], [r.mxx, r.mxy], [r.mnx, r.mxy], [r.mnx, r.mny]], bounds: { x: r.mnx, y: r.mny, w: r.mxx - r.mnx, h: r.mxy - r.mny }, stitchCount: sc };
      });
      } catch (e) {
        console.error(`[${rid}] post-engine failed at:`, e.stack || e.message);
        throw new Error(`post-engine: ${e.message}`);
      }

      // Final response payload wrapped — surface any construction error
      // with a clear [rid]-tagged line so the 500-message in logs is
      // identifiable instead of `[Object: null prototype] {}`.
      return (() => {
        try {
          return {
            id: jobId,
            previewUrl: `/preview/${jobId}`,
            previewImageUrl: `/preview-image/${jobId}`,
            downloadUrl: `/download/${jobId}`,
            stitchCount: qa.stitchCount,
            designSize: { w: canvasSize, h: canvasSize, mm: canvasSize / 10 },
            colors: selectedColors,
            colorMeta: {},
            geminiNotes: det?.geminiNotes || "",
            specs,
            tunedParams: params,
            qa,
            shapes,
            regions: filteredRegions.length,
            sewTime,
            mode,
            threadBrand: threadList,
            regionLabels,
            palettesource: paletteSource,
          };
        } catch (e) {
          console.error(`[${rid}] response-build failed:`, e.message, e.stack);
          throw new Error(`response-build: ${e.message}`);
        }
      })();
    };

    try {
      const result = await enqueueJob(jobId, generateFn, socketId);
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

function buildFilteredPixMap(filteredRegions, selectedColors, canvasSize, pixMap, colors) {
  const filtPm = new Int16Array(canvasSize * canvasSize).fill(-1);
  // Respect the kept regions (background/excluded already removed) but paint
  // each region by matching the pixMap value to the region's COLOUR index,
  // not a possibly-stale reg.ci. We resolve the region's colour to its index
  // in the ORIGINAL palette and fill every pixel of that colour in the bbox.
  for (const reg of filteredRegions) {
    const newCi = selectedColors.findIndex(c => normHex(c) === normHex(reg.color));
    if (newCi < 0) continue;
    // The pixMap stores ORIGINAL palette indices. Find this region's colour there.
    const origCi = colors.findIndex(c => normHex(c) === normHex(reg.color));
    if (origCi < 0) continue;
    for (let y = reg.mny; y <= reg.mxy; y++) {
      const row = y * canvasSize;
      for (let x = reg.mnx; x <= reg.mxx; x++) {
        if (pixMap[row + x] === origCi) filtPm[row + x] = newCi;
      }
    }
  }
  return filtPm;
}

/* ── Preview ────────────────────────────────────────────── */
router.get("/debug/last-cartoon", (req, res) => {
  if (!_lastCartoonBuf) return res.status(404).send("no cartoon captured yet — run a cartoon generation first");
  res.setHeader("Content-Type", _lastCartoonMime);
  res.setHeader("Content-Disposition", "inline; filename=cartoon.png");
  return res.send(_lastCartoonBuf);
});

/* ── /debug/last : true-colour self-report for the last run ─────────────── */
router.get("/debug/last", async (req, res) => {
  const d = _lastJobId && jobs.get(_lastJobId);
  if (!d) return res.status(404).send("no run captured yet — generate a design first");
  const W = d.designW, H = d.designH, cols = d.colors || [];
  const st = d.stitches || [];
  let renderTag = "", gapPct = null;
  try {
    const sharp = require("sharp");
    const hex = s => /^#?[0-9a-f]{6}/i.test(s||"") ? (s[0]==="#"?s:"#"+s) : "#000000";
    // bbox of real (non-trim) stitches so the subject fills the frame
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for (const s of st){ if(s.type==="trim"||s.type==="jump")continue; if(s.x<x0)x0=s.x; if(s.x>x1)x1=s.x; if(s.y<y0)y0=s.y; if(s.y>y1)y1=s.y; }
    if (x1<x0){ x0=0;y0=0;x1=W;y1=H; }
    const pad=20, bw=(x1-x0)+2*pad, bh=(y1-y0)+2*pad;
    const TARGET=1000, S=TARGET/Math.max(bw,bh);
    const RW=Math.round(bw*S), RH=Math.round(bh*S);
    const THREAD=Math.max(1.6, 4*S);                 // 0.4mm thread at this scale
    const mx=x=>((x-x0+pad)*S).toFixed(1), my=y=>((y-y0+pad)*S).toFixed(1);
    let lines="", prev=null;
    const cov = Buffer.alloc(RW*RH, 0);              // for gap%
    const plot=(ax,ay,bx2,by2)=>{ const steps=Math.max(1,Math.hypot(bx2-ax,by2-ay)|0); for(let k=0;k<=steps;k++){ const ix=(ax+(bx2-ax)*k/steps)|0, iy=(ay+(by2-ay)*k/steps)|0; if(ix>=0&&ix<RW&&iy>=0&&iy<RH) cov[iy*RW+ix]=1; } };
    for (const s of st){
      if (s.type==="trim"){ prev=null; continue; }
      if (prev && prev.color===s.color){
        lines += `<line x1="${mx(prev.x)}" y1="${my(prev.y)}" x2="${mx(s.x)}" y2="${my(s.y)}" stroke="${hex(s.color)}"/>`;
        plot(+mx(prev.x),+my(prev.y),+mx(s.x),+my(s.y));
      }
      prev=s;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RW}" height="${RH}"><rect width="${RW}" height="${RH}" fill="#f4f2ee"/><g stroke-width="${THREAD.toFixed(2)}" stroke-linecap="round" fill="none" stroke-opacity="0.92">${lines}</g></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    renderTag = `<img src="data:image/png;base64,${png.toString("base64")}" style="max-width:48%;border:1px solid #ccc"/>`;
    const sil = await sharp(Buffer.from(cov),{raw:{width:RW,height:RH,channels:1}}).blur(4).threshold(40).raw().toBuffer();
    const dil = await sharp(Buffer.from(cov),{raw:{width:RW,height:RH,channels:1}}).blur(1).threshold(40).raw().toBuffer();
    let se=0, ho=0; for(let i2=0;i2<RW*RH;i2++){ if(sil[i2]){ se++; if(!dil[i2]) ho++; } }
    gapPct = se? (100*ho/se) : 0;
  } catch(e){ renderTag = `<p>render failed: ${e.message}</p>`; }
  const counts = {};
  for (const s of st){ if(s.type==="trim"||s.type==="jump")continue; counts[s.color]=(counts[s.color]||0)+1; }
  const rows = cols.map(c=>`<tr><td><span style="display:inline-block;width:14px;height:14px;background:${c};border:1px solid #888"></span></td><td><code>${c}</code></td><td>${counts[c]||0}</td>${(counts[c]||0)<50?'<td style="color:#c00">&#9888; near-empty</td>':'<td></td>'}</tr>`).join("");
  const cartTag = _lastCartoonBuf ? `<img src="/debug/last-cartoon" style="max-width:48%;border:1px solid #ccc"/>` : "<p>(no cartoon — direct/photo input)</p>";
  res.setHeader("Content-Type","text/html");
  res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;margin:12px;max-width:900px"><h2>Last run — true colours</h2><p><b>Size:</b> ${(W/10)|0}&times;${(H/10)|0} mm &middot; <b>Stitches:</b> ${st.length} &middot; <b>Mode:</b> ${d.mode||"?"}${gapPct!=null?` &middot; <b>Unsewn:</b> <span style="color:${gapPct>3?'#c00':'#080'}">${gapPct.toFixed(1)}%</span> (target &lt;2%)`:""}</p><div style="display:flex;gap:8px;flex-wrap:wrap">${cartTag}${renderTag}</div><h3>Per-colour stitch counts</h3><table style="border-collapse:collapse" border=1 cellpadding=4><tr><th></th><th>hex</th><th>stitches</th><th></th></tr>${rows}</table></body>`);
});

router.get("/preview/:id", (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: d.stitches, designW: d.designW, designH: d.designH });
});

router.get("/preview-image/:id", async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  if (!d.previewBuf) return res.status(500).json({ error: "Preview not ready" });
  res.setHeader("Content-Type",  "image/png");
  res.setHeader("Cache-Control", "public,max-age=300");
  return res.send(d.previewBuf);
});

/* Tier-5g: decoupled preview render. */
router.get("/preview-stitched/:id", async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  if (!d.stitches) return res.status(500).json({ error: "Stitches not ready" });
  try {
    const { renderDecoupledPreview } = require("../lib/preview-overlay");
    const canvasSize = d.designW || 1600;
    let srcBuf = d.sourceImageBuffer;
    if (!srcBuf) {
      // Fallback: try regenerate from previewBuf
      srcBuf = d.previewBuf;
    }
    const png = await renderDecoupledPreview(srcBuf, d.stitches, d.colors || [], canvasSize);
    if (!png) return res.status(500).json({ error: "Decoupled preview failed" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public,max-age=300");
    return res.send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Tier-5e: stitch sticker chip overview ──────────────────────
 * Renders the preview above, with a swatch legend below listing each
 * thread color hex + (when brand thread list available) the brand code & name.
 * Used for design review and embroidery machine thread kit assembly.
 */
router.get("/sticker-overview/:id", async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  if (!d.previewBuf) return res.status(500).json({ error: "Preview not ready" });
  try {
    const colors = d.colors || [];
    const preview = d.previewBuf;
    // Build a 480-wide legend strip; chips are 40x40 with code text.
    const W = 480, swatchH = 60;
    const stripH = Math.max(60, swatchH * Math.min(8, colors.length || 1));
    const H = stripH + 30;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>
      ${colors.map((hex, i) => {
        const y = 10 + (i % 8) * swatchH;
        const x = 10 + Math.floor(i / 8) * 100;
        const norm = "#" + (hex.match(/[0-9a-fA-F]{6}/) || ["000000"])[0].toUpperCase();
        return `${`<rect x="${x}" y="${y}" width="40" height="40" fill="${norm}" stroke="#222"/>` +
                  `<text x="${x + 50}" y="${y + 25}" font-family="Arial" font-size="14" fill="#222">${norm.slice(1)}</text>`}`;
      }).join("")}
    </svg>`;
    const stripe = await sharp(Buffer.from(svg))
      .png().toBuffer();
    // Composite: preview on top, sticker below
    const previewMeta = await sharp(preview).metadata();
    const composed = await sharp({
      create: {
        width: previewMeta.width,
        height: previewMeta.height + H + 20,
        channels: 3,
        background: { r: 240, g: 240, b: 240 }
      }
    })
      .composite([
        { input: preview, top: 0, left: 0 },
        { input: stripe, top: previewMeta.height + 10, left: 10 }
      ])
      .png().toBuffer();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public,max-age=300");
    return res.send(composed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ── Raw DST (no auth — for autotune / internal QA) ─────── */
router.get("/raw-dst/:id", async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  const dstBuf = encodeDST(d.stitches, d.params?.machineLimits);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design_${req.params.id}.dst"`);
  return res.send(dstBuf);
});

/* ── Download ───────────────────────────────────────────── */
router.get("/download/:id", requireAuth, checkDownloadQuota, async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });

  const fmt = req.query.fmt || "dst";
  const ts  = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15);

  if (fmt === "dst") {
    const dstBuf  = encodeDST(d.stitches, d.params?.machineLimits);
    const NAMES   = ["Black","White","Yellow","Orange","Red","Burgundy","Pink","Light Pink","Gold","Dark Gold","Brown","Dark Brown","Olive Green","Green","Dark Green","Sky Blue","Light Blue","Blue","Dark Blue","Purple","Light Purple","Lavender","Silver","Grey","Dark Grey","Beige","Light Beige","Tan","Caramel","Dark Caramel","Orange Red","Light Orange"];
    // Use the REAL counts/colours encodeDST actually wrote, so the .inf always
    // matches the .dst (previously they were computed separately and disagreed).
    const meta = dstBuf.meta || {};
    // Colours actually sewn, de-duplicated in first-use order.
    const seen = new Set();
    const infColors = (meta.usedColors || d.colors).filter(h => {
      const k = (h || "").toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const infStitchCount = meta.stitchCount != null ? meta.stitchCount : d.stitches.filter(s => s.type !== "trim" && s.type !== "jump" && s.type !== "color-change").length;
    const infLines = ["[Version]","Major=1","Minor=0","","[Parameters]",`ST=${infStitchCount}`,`CO=${infColors.length}`,"AX=+    0","AY=+    0","MX=+    0","MY=+    0","PD=******","","[Threads]",`Count=${infColors.length}`, ""];
    infColors.forEach((hex, idx) => {
      const rgb    = hexToRgb(hex);
      const nearIdx = findNearestThread(rgb, JEF_THREADS);
      infLines.push(`[thread${idx + 1}]`, `Color=${rgb.r},${rgb.g},${rgb.b}`, `Name=${NAMES[nearIdx] || hex}`, `ID=${String(nearIdx + 1).padStart(3, "0")}`, `Hex=${hex}`, "");
    });
    const zipBuf = buildZipStore([{ name: "design.dst", data: dstBuf }, { name: "design.inf", data: Buffer.from(infLines.join("\r\n"), "utf8") }]);
    if (req.firebaseUser) await recordDownload(req.firebaseUser.uid);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="design_${ts}.zip"`);
    return res.send(zipBuf);
  }

  let buf;
  if (fmt === "jef")       buf = encodeJEF(d.stitches, d.colors);
  else if (fmt === "pes")  buf = encodePES(d.stitches, d.colors);
  else return res.status(400).json({ error: "Unsupported format. Use dst, jef, or pes." });

  if (req.firebaseUser) await recordDownload(req.firebaseUser.uid);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design_${ts}.${fmt}"`);
  return res.send(buf);
});

/* ── Batch download ─────────────────────────────────────── */
router.get("/download-batch/:id", requireAuth, checkDownloadQuota, async (req, res) => {
  const d = jobs.get(req.params.id);
  if (!d) return res.status(404).json({ error: "Job not found" });
  const zip = buildZipStore([
    { name: "design.dst",       data: encodeDST(d.stitches, d.params?.machineLimits) },
    { name: "design.pes",       data: encodePES(d.stitches, d.colors) },
    { name: "design.jef",       data: encodeJEF(d.stitches, d.colors) },
    { name: "color-chart.pdf",  data: await generateColorChartPdf(d.colors, d.params?.machine || "generic") },
  ]);
  if (req.firebaseUser) await recordDownload(req.firebaseUser.uid);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="stichai-batch-${Date.now()}.zip"`);
  return res.send(zip);
});

/* ── User status ────────────────────────────────────────── */
router.get("/user/status", requireAuth, (req, res) => {
  const user = req.userDoc;
  if (!user) return res.json({ auth: false });
  const quota        = checkQuota(user);
  const plan         = PLANS[user.plan] || PLANS.none;
  const trialDaysLeft = user.plan === "trial" && user.trialExpires
    ? Math.max(0, Math.ceil((user.trialExpires - Date.now()) / 86400000))
    : null;
  return res.json({
    auth: true, uid: user.uid, email: user.email, provider: user.provider,
    plan: user.plan, planLabel: plan.label, trialDaysLeft,
    allowed: quota.allowed, remaining: quota.remaining === Infinity ? null : quota.remaining,
    reason: quota.reason || null, upgrade: quota.upgrade || false,
  });
});

/* ── Checkout ───────────────────────────────────────────── */
router.post("/checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "payments_not_configured" });
  const PRICES     = buildPrices();
  const priceEntry = PRICES[req.body.priceKey];
  if (!priceEntry?.id) return res.status(400).json({ error: "invalid_price" });
  const user    = req.userDoc;
  const appUrl  = process.env.APP_URL || "https://stichai.pro";
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { firebaseUid: user.uid } });
    customerId = customer.id;
    if (db) await db.collection("users").doc(user.uid).update({ stripeCustomerId: customerId });
  }
  const session = await stripe.checkout.sessions.create({
    customer: customerId, payment_method_types: ["card"], mode: "subscription",
    line_items: [{ price: priceEntry.id, quantity: 1 }],
    success_url: `${appUrl}/?checkout=success&plan=${priceEntry.plan}`,
    cancel_url:  `${appUrl}/?checkout=cancel`,
  });
  return res.json({ url: session.url });
});

/* ── Billing portal ─────────────────────────────────────── */
router.post("/portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "payments_not_configured" });
  if (!req.userDoc?.stripeCustomerId) return res.status(400).json({ error: "no_subscription" });
  const appUrl  = process.env.APP_URL || "https://stichai.pro";
  const session = await stripe.billingPortal.sessions.create({ customer: req.userDoc.stripeCustomerId, return_url: appUrl });
  return res.json({ url: session.url });
});

/* ── Admin grant ────────────────────────────────────────── */
router.post("/admin/grant", async (req, res) => {
  if (!req.headers["x-admin-secret"] || req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "forbidden" });
  if (!db) return res.status(503).json({ error: "db_not_ready" });
  const { uid, email, plan, durationDays } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: "invalid_plan" });
  let targetUid = uid;
  if (!targetUid && email) {
    try { const u = await admin.auth().getUserByEmail(email); targetUid = u.uid; }
    catch (_) { return res.status(404).json({ error: "user_not_found" }); }
  }
  if (!targetUid) return res.status(400).json({ error: "uid_or_email_required" });
  const now    = Date.now();
  const update = { plan, planGrantedBy: "admin", planGrantedAt: now, downloadsThisPeriod: 0, periodStart: getPeriodStart(PLANS[plan].period) };
  if (plan === "trial" && durationDays)  { update.trialStart = now; update.trialExpires = now + durationDays * 86400000; }
  if (plan !== "trial" && durationDays)  { update.freeUntil = now + durationDays * 86400000; }
  await db.collection("users").doc(targetUid).set(update, { merge: true });
  return res.json({ success: true, uid: targetUid, plan });
});

/* ── Segment subject ────────────────────────────────────── */
router.post("/extract-subject", requireAuth, upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded", ok: false });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini not configured", ok: false });
    const rid  = Math.random().toString(36).slice(2, 6);
    const tapX = req.body?.tapX !== undefined ? Math.round(parseFloat(req.body.tapX)) : undefined;
    const tapY = req.body?.tapY !== undefined ? Math.round(parseFloat(req.body.tapY)) : undefined;
    console.log(`[${rid}] EXTRACT-SUBJECT${tapX !== undefined ? ` tap=[${tapX},${tapY}]` : " (auto)"}`);
    try {
      const out = await extractSubjectImage(req.file.buffer, req.file.mimetype || "image/jpeg", tapX, tapY);
      if (!out) return res.status(502).json({ error: "Extraction failed", ok: false });
      console.log(`[${rid}] OK model=${out.model} (${out.buffer.length} bytes)`);
      return res.json({ ok: true, image: `data:${out.mime};base64,${out.buffer.toString("base64")}`, model: out.model });
    } catch (e) { console.error(`[${rid}] EXTRACT crash:`, e.message); return res.status(500).json({ error: e.message, ok: false }); }
  }
);

router.post("/extract-cartoon", requireAuth, upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded", ok: false });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini not configured", ok: false });
    const rid        = Math.random().toString(36).slice(2, 6);
    const tapX       = req.body?.tapX !== undefined ? Math.round(parseFloat(req.body.tapX)) : undefined;
    const tapY       = req.body?.tapY !== undefined ? Math.round(parseFloat(req.body.tapY)) : undefined;
    const colorCount = req.body?.colorCount !== undefined ? parseInt(req.body.colorCount) : 6;
    console.log(`[${rid}] EXTRACT-CARTOON colors=${colorCount}${tapX !== undefined ? ` tap=[${tapX},${tapY}]` : " (auto)"}`);
    try {
      const out = await extractSubjectAsCartoon(req.file.buffer, req.file.mimetype || "image/jpeg", tapX, tapY, colorCount);
      if (!out) return res.status(502).json({ error: "Cartoon extraction failed", ok: false });
      console.log(`[${rid}] OK model=${out.model} colors=${out.colorCount} (${out.buffer.length} bytes)`);
      return res.json({ ok: true, image: `data:${out.mime};base64,${out.buffer.toString("base64")}`, colorCount: out.colorCount, model: out.model });
    } catch (e) { console.error(`[${rid}] CARTOON crash:`, e.message); return res.status(500).json({ error: e.message, ok: false }); }
  }
);

router.post("/segment-subject",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded", found: false });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini not configured", found: false });

    const rid  = Math.random().toString(36).slice(2, 6);
    const tapX = req.body?.tapX !== undefined ? Math.round(parseFloat(req.body.tapX)) : undefined;
    const tapY = req.body?.tapY !== undefined ? Math.round(parseFloat(req.body.tapY)) : undefined;
    console.log(`[${rid}] SEGMENT-SUBJECT${tapX !== undefined ? ` tap=[${tapX},${tapY}]` : " (auto)"}`);

    try {
      // Try pixel-accurate imgly first, then Gemini grid
      const bgMask = await removeBackgroundImgly(req.file.buffer, req.file.mimetype || "image/jpeg");
      if (bgMask) {
        console.log(`[${rid}] imgly OK (${bgMask.length} bytes)`);
        return res.json({ found: true, subject: "person", maskPng: bgMask.toString("base64"), confidence: "high" });
      }

      const result = await segmentSubjectWithGemini(req.file.buffer, req.file.mimetype || "image/jpeg", tapX, tapY);
      if (!result?.found) {
        console.log(`[${rid}] no subject found`);
        return res.json({ found: false });
      }

      const cellCount = (result.grid?.match(/1/g) || []).length;
      console.log(`[${rid}] OK subject=${result.subject} cells=${cellCount} conf=${result.confidence}`);
      return res.json(result);
    } catch (e) {
      console.error(`[${rid}] SEGMENT crash:`, e.message);
      return res.status(500).json({ error: e.message, found: false });
    }
  }
);

module.exports = router;
module.exports.setServices = setServices;
