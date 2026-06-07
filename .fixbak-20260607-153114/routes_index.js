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
const { preprocessImage, extractColorsFromUnmasked, buildPixelMap, removeBackgroundImgly, renderPreviewFast, hexToRgb, rgbToLab, dE, normHex } = require("../lib/image");

// DEBUG: stash the last cartoon PNG so it can be downloaded for offline pipeline testing
let _lastCartoonBuf = null, _lastCartoonMime = "image/png";
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
    try {
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
        const cartoon = await convertToCartoonWithGemini(imgFile.buffer, sourceMime, colorCount);
        if (cartoon) {
          sourceBuffer = cartoon.buffer;
          sourceMime   = cartoon.mime;
          cartoonOk    = true;
          console.log(`[${rid}] Cartoon generated OK`);
          _lastCartoonBuf = cartoon.buffer; _lastCartoonMime = cartoon.mime || "image/png";
        } else {
          console.warn(`[${rid}] Cartoon generation failed — posterize fallback`);
        }
      }

      const cleanedBuffer = await preprocessImage(sourceBuffer, canvasSize, mode);

      const skipGeminiPalette = mode === "cartoon" && !cartoonOk;
      const [bucketColors, gem] = await Promise.all([
        extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount),
        skipGeminiPalette
          ? Promise.resolve(null)
          : analyzeWithGemini(sourceBuffer, sourceMime, colorCount).catch(() => null),
      ]);

      let colors, paletteSource;
      if (gem && Array.isArray(gem.palette) && gem.palette.length >= 3) {
        colors       = gem.palette.slice(0, colorCount);
        paletteSource = "gemini";
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
        colors       = ["#000000", "#FFFFFF", "#FF0000", "#0000FF", "#FFFF00"];
        paletteSource = "fallback";
      }
      console.log(`[${rid}] Palette ${paletteSource} (${colors.length}): ${colors.join(", ")}`);

      const pixMap    = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
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
      return res.status(500).json({ error: e.message || "Detection failed" });
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
      let pixMap, regions, colors, mode;

      if (det) {
        ({ pixMap, regions, colors, canvasSize, mode } = det);
      } else {
        mode = body.mode || "logo";
        const colorCount    = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === "photo" ? 8 : 12)));
        const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize, mode);
        colors              = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
        pixMap              = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
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
      try {
        if (body.selectedShapes) {
          const parsed = JSON.parse(body.selectedShapes);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed.length < regions.length)
            filteredRegions = parsed.map(idx => regions[idx]).filter(Boolean);
        }
      } catch (_) {}

      // Rebuild pixMap for excluded colors
      if (selectedColors.length < colors.length) {
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

      if (!filteredRegions.length) throw new Error("No regions left after selection");
      progressCb(30, "Generating stitches…");

      // Stitch generation
      let stitches, colorCounts;
      const useV71 = body.useV71 === "1" || body.useV71 === "true";
      // Cartoon mode now uses the V70 generator (proper PCA fill angles, cleaner
      // fills on complex/concave shapes) instead of the legacy generator, which
      // produced fan/starburst artefacts on cartoon subjects.
      const useV70ForCartoon = (mode === "cartoon");
      if (mode === "photo" && useV71) {
        const filtPm = buildFilteredPixMap(filteredRegions, selectedColors, canvasSize, pixMap, colors);
        const result = v71_generatePhotoStitch(filtPm, selectedColors, canvasSize, params);
        stitches     = result.stitches;
        colorCounts  = result.colorCounts;
      } else if (useV70ForCartoon || (effectiveMode !== "logo" && useV71)) {
        const filtPm   = buildFilteredPixMap(filteredRegions, selectedColors, canvasSize, pixMap, colors);
        // v72 unified portrait engine: outline-removal → whole-region fills +
        // underlay + tie-offs + back-to-front order + outline on top.
        const result = v72_buildAndGenerate(filtPm, selectedColors, canvasSize, 10, params);
        if (result.stitches && result.stitches.filter(s => s.type === "fill").length > 200) {
          stitches    = result.stitches;
          colorCounts = result.colorCounts;
          console.log(`[${rid}] used V72 unified engine`);
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
      progressCb(70, "Adding basting…");

      if (body.bastingBox === "1" || body.bastingBox === "true") {
        stitches.unshift(...generateBastingBox(filteredRegions, selectedColors));
      }

      const coverCount = stitches.filter(s => s.type !== "trim" && s.type !== "underlay").length;
      if (coverCount < 5) throw new Error("Not enough stitches — select more shapes or check contrast");
      progressCb(85, "Rendering preview…");

      let previewBuf = null;
      try { previewBuf = await renderPreviewFast(filteredRegions, selectedColors, canvasSize, pixMap); }
      catch (e) { console.error("Preview render failed:", e.message); }

      const qa      = validateQuality(stitches, params.machineLimits);
      const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);

      jobs.set(jobId, { stitches, pixMap, colors: selectedColors, params, designW: canvasSize, designH: canvasSize, designMm: canvasSize / 10, ts: Date.now(), previewBuf, sewTime, mode, canvasSize });
      progressCb(100, "Complete");

      const shapes = filteredRegions.map(r => {
        const sc = stitches.filter(s => s.color === r.color && s.type !== "trim" && s.type !== "underlay" && s.x >= r.mnx && s.x <= r.mxx && s.y >= r.mny && s.y <= r.mxy).length;
        return { type: r.type, color: normHex(r.color), points: [[r.mnx, r.mny], [r.mxx, r.mny], [r.mxx, r.mxy], [r.mnx, r.mxy], [r.mnx, r.mny]], bounds: { x: r.mnx, y: r.mny, w: r.mxx - r.mnx, h: r.mxy - r.mny }, stitchCount: sc };
      });

      return { id: jobId, previewUrl: `/preview/${jobId}`, previewImageUrl: `/preview-image/${jobId}`, downloadUrl: `/download/${jobId}`, stitchCount: qa.stitchCount, designSize: { w: canvasSize, h: canvasSize, mm: canvasSize / 10 }, colors: selectedColors, colorMeta: {}, geminiNotes: det?.geminiNotes || "", specs, tunedParams: params, qa, shapes, regions: filteredRegions.length, sewTime, mode };
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
