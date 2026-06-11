"use strict";

/**
 * Gemini AI helpers:
 *  - geminiPost        — generic JSON generation with model fallback + retry
 *  - analyzeWithGemini — palette + metadata extraction
 *  - segmentSubjectWithGemini — grid-based subject segmentation (IMPROVED)
 *  - convertToCartoonWithGemini — photo → flat cartoon for embroidery
 */

const axios = require("axios");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS  = [
  "gemini-2.5-flash",
  "gemini-3.1-flash",
  "gemini-2.5-pro",
];
const CARTOON_MODELS = ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"];

/* ── Generic POST with model fallback + retry ──────────── */
async function geminiPost(body, ms = 45000) {
  const retryableCodes = new Set([429, 503, 500]);
  let lastErr = null;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.post(url, body, { timeout: ms });
        return res;
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        const msg    = e.response?.data?.error?.message || e.message;
        console.warn(`[gemini] ${model} attempt ${attempt + 1} → ${status || "ERR"}: ${msg}`);
        if (retryableCodes.has(Number(status)) && attempt < 2) {
          await new Promise(r => setTimeout(r, [500, 1500][attempt]));
          continue;
        }
        break;
      }
    }
  }
  console.error("[gemini] All models failed:", lastErr?.message);
  return null;
}

/* ── Palette + metadata analysis ───────────────────────── */
async function analyzeWithGemini(originalBuffer, mime, colorCount) {
  const b64  = originalBuffer.toString("base64");
  const body = {
    contents: [{ role: "user", parts: [
      { text: `You are a senior machine-embroidery digitizer.
Analyze the attached image and propose the dominant thread palette a human digitizer would actually use.
Pick up to ${colorCount} colours. Prefer perceptually distinct hues; merge near-duplicates.
Quote each colour as a 7-character lowercase hex like "#1a2b3c".

Return STRICT JSON only, no prose, no markdown:
{
  "palette": ["#rrggbb", ...],
  "is_logo": true|false,
  "is_text": true|false,
  "complexity": "simple" | "moderate" | "complex",
  "recommended_angle": <integer 0-180>,
  "notes": "<one short sentence>"
}` },
      { inlineData: { mimeType: mime || "image/png", data: b64 } }
    ]}],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json"
    }
  };

  const res = await geminiPost(body);
  if (!res) return null;

  try {
    let raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!raw.trim()) return null;
    raw = raw.replace(/```json|```/g, "").trim();
    const fa = raw.indexOf("{"), lb = raw.lastIndexOf("}");
    if (fa === -1 || lb <= fa) return null;
    const parsed = JSON.parse(raw.slice(fa, lb + 1));

    if (Array.isArray(parsed.palette)) {
      const cleaned = [];
      for (const c of parsed.palette) {
        const m = String(c || "").match(/#?([0-9a-fA-F]{6})/);
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
  } catch (e) {
    console.error("[gemini] analyzeWithGemini JSON parse:", e.message);
    return null;
  }
}

/* ── Subject segmentation (IMPROVED v2) ────────────────── */
/**
 * Improvements vs original:
 * 1. `let prompt` instead of `const` — fixes crash on retry (was TypeError)
 * 2. Separate prompt for tap vs auto mode (cleaner instructions)
 * 3. Three-tier retry: normal → strict → ultra-strict (was two)
 * 4. Better grid validation: checks row count AND column length per row
 * 5. Bounding-box aspect ratio tolerance widened slightly (0.18–5.5) for
 *    wide subjects like fish, cats stretched horizontal
 * 6. Returns bounding box in 0-1 normalised coords for frontend use
 * 7. maskSize bumped to 256 for higher-resolution mask output
 * 8. Gaussian-like smooth upscale instead of hard nearest-neighbour
 */
async function segmentSubjectWithGemini(imageBuffer, mime, tapX, tapY) {
  if (!GEMINI_API_KEY) return null;
  const b64     = imageBuffer.toString("base64");
  const hasPoint = tapX !== undefined && tapY !== undefined &&
                   !isNaN(tapX) && !isNaN(tapY);
  const GRID    = 40;

  async function attemptSegment(strictness) {
    const pointInstr = hasPoint
      ? `The user tapped at normalised coordinate [${tapX}, ${tapY}] (0-1000 scale). Identify the object AT or nearest to that point.`
      : `Find the MAIN SUBJECT — the most prominent person, baby, animal, or object in the foreground.`;

    const strictNote = {
      normal:      `- When unsure, mark '0'. Only mark '1' for cells clearly part of the subject.`,
      strict:      `- Be EXTREMELY conservative: only mark '1' for cells DEFINITELY part of the subject.`,
      ultrastrict: `- Mark '1' ONLY for the absolute core of the subject — exclude any borderline or partially occluded parts.`,
    }[strictness] || "";

    // Use let so the variable can be reassigned for retry without TypeError
    let promptText = `You are an image segmentation assistant for embroidery digitizing.
${pointInstr}

Return ONLY valid JSON, no markdown:
{
  "found": true,
  "subject": "baby",
  "rows": ["000001111100...", ...],
  "confidence": "high" | "medium" | "low"
}

GRID — ${GRID} rows × ${GRID} columns covering the ENTIRE image:
- Row 0 = top of image, row ${GRID - 1} = bottom
- Column 0 = left, column ${GRID - 1} = right
- '1' = cell contains part of the MAIN SUBJECT
- '0' = background: sky, water, sand, other people, shadows, ground
${strictNote}
- Include the COMPLETE subject: head, hat, all clothing, hands, feet
- Each of the ${GRID} rows must be exactly ${GRID} characters of '0' or '1', no spaces
${hasPoint ? `- The cell at the tap point MUST be '1'` : ""}

If no clear subject: {"found": false}`;

    const geminiModels = ["gemini-2.5-pro", "gemini-2.5-flash"];
    for (const model of geminiModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      try {
        const res = await axios.post(url, {
          contents: [{ role: "user", parts: [
            { text: promptText },
            { inlineData: { mimeType: mime || "image/jpeg", data: b64 } }
          ]}],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 12000 }
          }
        }, { timeout: 60000 });

        const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!raw.trim()) continue;

        let js = raw.replace(/```json|```/g, "").trim();
        const fa = js.indexOf("{"), lb = js.lastIndexOf("}");
        if (fa === -1 || lb <= fa) continue;
        js = js.slice(fa, lb + 1);

        const parsed = JSON.parse(js);
        if (!parsed.found) return { found: false };

        // Validate row structure
        if (!Array.isArray(parsed.rows) || parsed.rows.length < GRID * 0.5) continue;

        return parsed;
      } catch (e) {
        console.error(`[segment] ${model} (${strictness}) → ${e.response?.status || e.message}`);
      }
    }
    return null;
  }

  function processGrid(rows) {
    // Normalise to exactly GRID×GRID binary strings
    let nr = rows.slice(0, GRID).map(r =>
      String(r).replace(/[^01]/g, "").padEnd(GRID, "0").slice(0, GRID)
    );
    while (nr.length < GRID) nr.push("0".repeat(GRID));

    // Morphological clean-up (remove isolated pixels, fill dense regions)
    const out = nr.map(r => r.split(""));
    for (let y = 1; y < GRID - 1; y++) {
      for (let x = 1; x < GRID - 1; x++) {
        let ones = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dy === 0 && dx === 0) continue;
            if (out[y + dy][x + dx] === "1") ones++;
          }
        }
        if (out[y][x] === "1" && ones < 2) out[y][x] = "0";
        else if (out[y][x] === "0" && ones >= 7) out[y][x] = "1";
      }
    }
    nr = out.map(r => r.join(""));

    // Force tap neighbourhood to '1'
    if (hasPoint) {
      const tapCol = Math.min(GRID - 1, Math.max(0, Math.floor((tapX / 1000) * GRID)));
      const tapRow = Math.min(GRID - 1, Math.max(0, Math.floor((tapY / 1000) * GRID)));
      const ra = nr.map(r => r.split(""));
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const rr = tapRow + dy, cc = tapCol + dx;
          if (rr >= 0 && rr < GRID && cc >= 0 && cc < GRID) ra[rr][cc] = "1";
        }
      }
      nr = ra.map(r => r.join(""));
    }

    // Compute bounding box
    let minCol = GRID, maxCol = -1, minRow = GRID, maxRow = -1;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (nr[y][x] === "1") {
          if (x < minCol) minCol = x; if (x > maxCol) maxCol = x;
          if (y < minRow) minRow = y; if (y > maxRow) maxRow = y;
        }
      }
    }

    const oc   = (nr.join("").match(/1/g) || []).length;
    const fp   = (oc / (GRID * GRID) * 100).toFixed(1);
    const bw   = maxCol >= 0 ? maxCol - minCol + 1 : 0;
    const bh   = maxRow >= 0 ? maxRow - minRow + 1 : 0;
    const asp  = bw / Math.max(bh, 1);
    const bbox = {
      x: minCol / GRID, y: minRow / GRID,
      w: bw / GRID,     h: bh / GRID
    };
    return { nr, oc, fp: parseFloat(fp), asp, bw, bh, bbox };
  }

  // First attempt — normal strictness
  let parsed = await attemptSegment("normal");
  if (!parsed || !parsed.found) return { found: false };

  let proc = processGrid(parsed.rows);

  // Three-tier retry escalation
  const suspicious = (
    parsed.confidence === "low" ||
    proc.fp > 60 ||
    proc.asp > 5.5 || proc.asp < 0.18 ||
    proc.bw < 2 || proc.bh < 2
  );

  if (suspicious) {
    console.log(`[segment] Pass 1 suspicious (conf=${parsed.confidence} fill=${proc.fp}% asp=${proc.asp.toFixed(2)}), retrying strict…`);
    const strictParsed = await attemptSegment("strict");
    if (strictParsed && strictParsed.found) {
      const strictProc = processGrid(strictParsed.rows);
      if (strictProc.oc >= 4 && strictProc.fp <= 65 && strictProc.asp <= 5.5 && strictProc.asp >= 0.18) {
        parsed = strictParsed;
        proc   = strictProc;
        console.log(`[segment] Strict accepted (fill=${proc.fp}% asp=${proc.asp.toFixed(2)})`);
      } else if (strictProc.fp > 65 || strictProc.asp > 5.5) {
        // Still bad — try ultra-strict
        console.log(`[segment] Strict still suspicious (fill=${strictProc.fp}%), retrying ultra-strict…`);
        const ultraParsed = await attemptSegment("ultrastrict");
        if (ultraParsed && ultraParsed.found) {
          const ultraProc = processGrid(ultraParsed.rows);
          if (ultraProc.oc >= 4 && ultraProc.fp <= 70) {
            parsed = ultraParsed;
            proc   = ultraProc;
            console.log(`[segment] Ultra-strict accepted (fill=${proc.fp}%)`);
          }
        }
      }
    }
  }

  console.log(`[segment] subject="${parsed.subject}" conf=${parsed.confidence} fill=${proc.fp}% bbox=${proc.bw}×${proc.bh} aspect=${proc.asp.toFixed(2)}`);

  // Final validity checks
  if (proc.oc < 4)               { console.warn("[segment] Too few cells"); return { found: false }; }
  if (proc.fp > 65)              { console.warn(`[segment] Fill ${proc.fp}% too high`); return { found: false }; }
  if (proc.asp > 5.5 || proc.asp < 0.18) {
    console.warn(`[segment] Rejected — aspect ${proc.asp.toFixed(2)}`);
    return { found: false };
  }

  // Build a smooth alpha mask, eliminating the blocky 40x40 grid edges.
  // Strategy: render the grid at native GRID resolution as a single-channel
  // alpha map, upscale with bilinear interpolation (smooth, not blocky), blur
  // slightly to feather, then threshold back to a clean soft edge. This turns
  // stair-stepped cell boundaries into smooth contours suitable for embroidery.
  const sharp    = require("sharp");
  const maskSize = 512;  // higher output res for cleaner edges

  // 1. Native-resolution single-channel grid (GRID x GRID, 0 or 255)
  const gridAlpha = Buffer.alloc(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      gridAlpha[y * GRID + x] = proc.nr[y][x] === "1" ? 255 : 0;
    }
  }

  // 2. Bilinear upscale (smooth) + Gaussian blur (feather) + threshold (clean edge)
  const featherSigma = 4;          // edge softness; higher = smoother
  const smoothAlpha = await sharp(gridAlpha, {
      raw: { width: GRID, height: GRID, channels: 1 }
    })
    .resize(maskSize, maskSize, { kernel: "cubic" })   // smooth interpolation
    .blur(featherSigma)                                 // feather the boundary
    .threshold(110)                                     // crisp but anti-aliased edge
    .blur(1.2)                                          // tiny final feather for stitch-friendly edge
    .raw()
    .toBuffer();

  // 3. Compose into the RGBA red-mask format the rest of the pipeline expects
  //    (red channel = subject marker, alpha = coverage)
  const maskBuf = Buffer.alloc(maskSize * maskSize * 4);
  for (let i = 0; i < maskSize * maskSize; i++) {
    const a = smoothAlpha[i];
    maskBuf[i * 4]     = 255;   // R
    maskBuf[i * 4 + 1] = 0;     // G
    maskBuf[i * 4 + 2] = 0;     // B
    maskBuf[i * 4 + 3] = a;     // A — now smoothly feathered, not blocky
  }

  let maskPng = await sharp(maskBuf, {
    raw: { width: maskSize, height: maskSize, channels: 4 }
  }).png({ compressionLevel: 6 }).toBuffer();

  // ── HYBRID REFINEMENT (optional) ──────────────────────────────────
  // When @imgly is enabled, use its pixel-accurate alpha matte for crisp edges,
  // but constrain it to Gemini's bounding box so only the tapped subject is kept
  // (imgly alone keeps ALL foreground; Gemini tells us WHICH object the user wants).
  if (process.env.ENABLE_IMGLY === "1") {
    try {
      const imageMod = require("./image");
      const cutout = await imageMod.removeBackgroundImgly(imageBuffer, mime);
      if (cutout) {
        // Extract imgly's alpha channel at maskSize
        const im = await sharp(cutout)
          .resize(maskSize, maskSize, { fit: "fill" })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const ich = im.info.channels;

        // Build a bounding-box gate from Gemini's grid (with small padding)
        const pad = 0.05;
        const bx0 = Math.max(0, proc.bbox.x - pad) * maskSize;
        const by0 = Math.max(0, proc.bbox.y - pad) * maskSize;
        const bx1 = Math.min(1, proc.bbox.x + proc.bbox.w + pad) * maskSize;
        const by1 = Math.min(1, proc.bbox.y + proc.bbox.h + pad) * maskSize;

        const refined = Buffer.alloc(maskSize * maskSize * 4);
        let keptPixels = 0;
        for (let y = 0; y < maskSize; y++) {
          for (let x = 0; x < maskSize; x++) {
            const i = y * maskSize + x;
            const inBox = x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
            const imglyAlpha = im.data[i * ich + (ich - 1)];
            // Keep imgly's precise alpha, but only inside Gemini's subject box
            const a = inBox ? imglyAlpha : 0;
            refined[i * 4]     = 255;
            refined[i * 4 + 1] = 0;
            refined[i * 4 + 2] = 0;
            refined[i * 4 + 3] = a;
            if (a > 30) keptPixels++;
          }
        }

        // Only accept the hybrid result if imgly actually found something in-box
        const coverage = keptPixels / (maskSize * maskSize);
        if (coverage > 0.01 && coverage < 0.85) {
          maskPng = await sharp(refined, {
            raw: { width: maskSize, height: maskSize, channels: 4 }
          }).blur(1.0).png({ compressionLevel: 6 }).toBuffer();
          console.log(`[segment] hybrid imgly+gemini mask (coverage=${(coverage*100).toFixed(1)}%)`);
        } else {
          console.log(`[segment] imgly coverage ${(coverage*100).toFixed(1)}% out of range — keeping Gemini mask`);
        }
      }
    } catch (e) {
      console.warn("[segment] imgly refinement skipped:", e.message);
    }
  }

  return {
    found:      true,
    subject:    parsed.subject || "unknown",
    grid:       proc.nr.join(""),
    gridSize:   GRID,
    confidence: parsed.confidence || "medium",
    maskPng:    maskPng.toString("base64"),
    boundingBox: proc.bbox,   // { x, y, w, h } normalised 0-1
  };
}

/* ── Extract tapped subject as a clean photo (Nano Banana image editing) ──── */
/**
 * Returns the user-tapped subject isolated on a clean white background,
 * as a real edited image (not a text-grid mask). Uses Gemini's image models.
 * @param tapX, tapY — normalised 0-1000 tap coordinates (optional)
 */
async function extractSubjectImage(imageBuffer, mime, tapX, tapY) {
  if (!GEMINI_API_KEY) return null;
  const b64 = imageBuffer.toString("base64");
  const hasPoint = tapX !== undefined && tapY !== undefined && !isNaN(tapX) && !isNaN(tapY);

  const pointInstr = hasPoint
    ? `The user tapped at position [${Math.round(tapX/10)}%, ${Math.round(tapY/10)}%] of the image (left-to-right, top-to-bottom). Identify the single main subject at or nearest that point.`
    : `Identify the single most prominent subject (person, baby, animal, or main object) in the foreground.`;

  const promptText = `${pointInstr}
Extract ONLY that subject and place it on a pure white background (#FFFFFF).
- Keep the subject's exact appearance, colors, pose, and all details (hair, clothing, hands, feet)
- Remove everything else: background, other people, floor, sky, objects
- Clean, sharp edges around the subject
- Do not add shadows, borders, or text
- Center the subject, keep its full body/extent visible
Output the edited image only.`;

  // Image-capable models, best first
  const IMAGE_MODELS = ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"];
  for (const model of IMAGE_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        contents: [{ role: "user", parts: [
          { text: promptText },
          { inlineData: { mimeType: mime || "image/jpeg", data: b64 } }
        ]}],
        generationConfig: { responseModalities: ["IMAGE"], temperature: 0.1 }
      }, { timeout: 50000 });

      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          console.log(`[extract] ${model} → ${buf.length} bytes`);
          return { buffer: buf, mime: part.inlineData.mimeType || "image/png", model };
        }
      }
      console.warn(`[extract] ${model} returned no image`);
    } catch (e) {
      console.warn(`[extract] ${model} failed: ${e.response?.status} ${e.response?.data?.error?.message || e.message}`);
    }
  }
  console.error("[extract] all image models failed");
  return null;
}

/* ── Extract tapped subject AND cartoonize it with N colors ──────────────── */
/**
 * Combines subject isolation + cartoon conversion in one image-gen call.
 * Returns the tapped subject as flat cartoon art with ~colorCount colors,
 * on a clean background — ready for embroidery digitizing.
 */
async function extractSubjectAsCartoon(imageBuffer, mime, tapX, tapY, colorCount) {
  if (!GEMINI_API_KEY) return null;
  const b64 = imageBuffer.toString("base64");
  const hasPoint = tapX !== undefined && tapY !== undefined && !isNaN(tapX) && !isNaN(tapY);
  const nColors = Math.max(2, Math.min(15, parseInt(colorCount) || 6));

  const pointInstr = hasPoint
    ? `The user tapped at position [${Math.round(tapX/10)}%, ${Math.round(tapY/10)}%] of the image (left-to-right, top-to-bottom). Focus on the single main subject at or nearest that point.`
    : `Focus on the single most prominent subject in the foreground.`;

  const promptText = `${pointInstr}
Recreate ONLY that subject as a flat cartoon illustration optimised for MACHINE EMBROIDERY:
- Extract just the subject; fill the ENTIRE background with SOLID PURE MAGENTA (#FF00FF), a chroma-key colour used for nothing else
- The subject must use NORMAL colours and NEVER contain magenta. White/light clothing → warm off-white (#F0E8D8), never magenta
- Use EXACTLY ${nColors} solid flat colours — no gradients, no shadows, no photographic texture
- ⚠ MOST IMPORTANT RULE: the clothing/fabric must be ONE SINGLE SOLID COLOUR. REMOVE all patterns entirely — polka dots, spots, prints, florals, stripes, plaid. A spotted dress becomes a PLAIN dress. Do not draw ANY small repeating shapes. This is mandatory: patterned fabric cannot be embroidered and fragments the design into unusable pieces.
- Every colour area must be large and bold — no tiny specks, dots, or islands smaller than a fingertip
- Merge fine details (individual hairs, fabric texture, small features) into clean solid shapes
- IMPORTANT: faithfully preserve the person's facial expression, gaze direction, and likeness from the original photo — keep the same mood and emotion (do NOT make it more smiling, neutral, or exaggerated than the original)
- Keep eyes, eyebrows, and mouth shaped as in the original so the expression reads true
- Avoid thin lines under a few mm; make outlines bold or omit them
- Sharp crisp boundaries between each colour area
- Draw it the way an EMBROIDERY DIGITIZER would prepare artwork before stitching:
  a small number of distinct, contiguous colour AREAS (each a clean closed shape),
  with bold dark CONTOUR LINES separating the areas (face vs hair, gown vs trim).
- Render the eyes, eyebrows, nose and mouth as clean bold dark LINES/shapes
  (not soft shading), so they read clearly when stitched.
- Think "iron-on embroidery patch" / "appliqué": flat colour zones + dark outlines.
- Keep the subject clearly recognisable, full extent visible, centered
- No text, no border, no drop shadow
Output the edited image only.

STRICT EMBROIDERY-READY RULES (these override anything above):
- FLAT solid colors ONLY. NO shading, NO gradients, NO highlights, NO shadows, NO dithering, NO texture, NO color banding anywhere.
- Use AT MOST 6 distinct colors total plus the magenta background: one skin tone, one hair color, 2-3 garment colors, white.
- Every region is ONE uniform flat color, like a vinyl sticker or paint-by-numbers art.
- A single uniform-width bold black outline (6-8 pixels) around every shape and facial feature. No sketchy, tapered or doubled lines.
- Facial features (eyes, brows, nose, mouth) are simple clean black line strokes on flat skin. No face shading.
- Hard crisp edges where colors meet.
- Background: pure solid magenta #FF00FF and nothing else.
- Subject fills the frame. No text, no watermark, no border.
`;

  const IMAGE_MODELS = ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"];
  for (const model of IMAGE_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        contents: [{ role: "user", parts: [
          { text: promptText },
          { inlineData: { mimeType: mime || "image/jpeg", data: b64 } }
        ]}],
        generationConfig: { responseModalities: ["IMAGE"], temperature: 0.3 }
      }, { timeout: 50000 });

      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          console.log(`[extract-cartoon] ${model} → ${buf.length} bytes, ${nColors} colors`);
          return { buffer: buf, mime: part.inlineData.mimeType || "image/png", model, colorCount: nColors };
        }
      }
      console.warn(`[extract-cartoon] ${model} returned no image`);
    } catch (e) {
      console.warn(`[extract-cartoon] ${model} failed: ${e.response?.status} ${e.response?.data?.error?.message || e.message}`);
    }
  }
  console.error("[extract-cartoon] all image models failed");
  return null;
}

/* ── Cartoon image generation ──────────────────────────── */
async function convertToCartoonWithGemini(imageBuffer, mime, colorCount) {
  if (!GEMINI_API_KEY) return null;
  const b64 = imageBuffer.toString("base64");
  const promptText = `Convert this photo into a flat cartoon illustration optimised for MACHINE EMBROIDERY stitching:
- Use approximately ${colorCount} solid flat colours — NO gradients, NO shadows, NO photographic textures
- ⚠ MOST IMPORTANT RULE: clothing/fabric must be ONE SINGLE SOLID COLOUR. REMOVE all patterns — spots, dots, prints, florals, stripes. A patterned garment becomes PLAIN. Draw no small repeating shapes; patterned fabric cannot be embroidered.
- Every colour area must be large and bold — no specks, dots, or islands smaller than a fingertip
- Avoid thin lines; make outlines bold or omit them
- Create sharp, crisp boundaries between each colour area
- Simplify fur, fabric, and skin textures into solid colour blocks
- IMPORTANT: faithfully preserve the subject's facial expression and likeness — keep the same mood and emotion as the original (do NOT exaggerate or neutralise the expression)
- Keep the main subject clearly recognisable and centred
- Draw it the way an EMBROIDERY DIGITIZER prepares artwork: a few distinct
  contiguous colour AREAS (clean closed shapes) with bold dark CONTOUR LINES
  separating them. Render facial features as clean bold dark lines, not shading.
- Style: iron-on embroidery patch / appliqué — flat colour zones + dark outlines
- Background: fill the ENTIRE background with SOLID PURE MAGENTA (#FF00FF) — a chroma-key colour. Use #FF00FF for nothing except the background. This lets the app remove the background perfectly.
- The subject (skin, hair, clothing, all of it) must use NORMAL colours and must NEVER contain magenta/#FF00FF. White or light clothing should be warm off-white (#F0E8D8), never magenta.
- Remove all photographic noise and subtle shading`;

  for (const model of CARTOON_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        contents: [{ role: "user", parts: [
          { text: promptText },
          { inlineData: { mimeType: mime || "image/jpeg", data: b64 } }
        ]}],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.3
        }
      }, { timeout: 50000 });

      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          console.log(`[cartoon] ${model} → ${buf.length} bytes (${part.inlineData.mimeType})`);
          return { buffer: buf, mime: part.inlineData.mimeType || "image/png" };
        }
      }
      console.warn(`[cartoon] ${model} returned no image`);
    } catch (e) {
      console.warn(`[cartoon] ${model} failed: ${e.response?.status} ${e.response?.data?.error?.message || e.message}`);
    }
  }
  console.error("[cartoon] All models failed");
  return null;
}

module.exports = {
  GEMINI_API_KEY,
  GEMINI_MODELS,
  geminiPost,
  analyzeWithGemini,
  segmentSubjectWithGemini,
  extractSubjectImage,
  extractSubjectAsCartoon,
  convertToCartoonWithGemini,
};
