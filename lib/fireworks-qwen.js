"use strict";

/**
 * Fireworks (Qwen2-VL) AI helpers — fallback when Gemini is unavailable.
 *
 * Same surface API as lib/gemini.js but routes through Fireworks AI inference.
 * Uses the same env key (FIREWORKS_API_KEY) as the rest of this workspace.
 *
 * Why Qwen2-VL-7B:
 *  - Vision-capable (jpg/png in, structured JSON out)
 *  - Cheap on Fireworks (~ $0.20/1M tokens, free tier 1M/wk)
 *  - Reliable at "extract dominant palette" task (well-documented prompt format)
 *  - Image→image (cartoonize) is NOT supported; we handle cartoonisation
 *    locally with the Sharp+median-cut pipeline + dedup to ~colorCount colors.
 *
 * Exports:
 *   analyzeWithQwen               — palette + metadata extraction
 *   convertToCartoonWithQwen      — image → flat-color PNG via Sharp posterize
 *                                   (returns a flat PNG buffer in a Qwen-shaped wrapper)
 */

const axios = require("axios");

const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;
const FW_BASE           = "https://api.fireworks.ai/inference/v1";
const QWEN_MODEL        = "accounts/fireworks/models/qwen2-vl-7b-instruct";
// alt: "accounts/fireworks/models/llama-vision-3b"  if Qwen is rate-limited

/* ── Generic POST with model fallback + retry ──────────── */
async function qwenPost(body, ms = 45000) {
  if (!FIREWORKS_API_KEY) {
    console.warn("[qwen] FIREWORKS_API_KEY missing — falling through");
    return null;
  }
  const models = [QWEN_MODEL, "accounts/fireworks/models/llama-vision-3b"];
  const retryableCodes = new Set([429, 503, 500, 502, 504]);
  let lastErr = null;

  for (const model of models) {
    const url = `${FW_BASE}/chat/completions`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.post(
          url,
          { ...body, model },
          {
            timeout: ms,
            headers: {
              "Authorization": `Bearer ${FIREWORKS_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );
        return res;
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        const msg    = e.response?.data?.error?.message || e.response?.data?.message || e.message;
        console.warn(`[qwen] ${model} attempt ${attempt + 1} → ${status || "ERR"}: ${msg}`);
        if (retryableCodes.has(Number(status)) && attempt < 2) {
          await new Promise(r => setTimeout(r, [800, 1800][attempt]));
          continue;
        }
        break;
      }
    }
  }
  console.error("[qwen] All models failed:", lastErr?.message);
  return null;
}

/* ── Build the image-url block Qwen expects ───────────── */
function imageBlock(buffer, mime) {
  // Fireworks image inputs: data URI in `image_url.content` or remote URL.
  // We pass as data: URI to avoid juggling remote uploads.
  return {
    type: "image_url",
    image_url: {
      url: `data:${mime || "image/jpeg"};base64,${buffer.toString("base64")}`,
    },
  };
}

/* ── Palette + metadata analysis ───────────────────────── */
async function analyzeWithQwen(originalBuffer, mime, colorCount) {
  const systemMsg = `You are a senior machine-embroidery digitizer.
Analyse the attached image and propose the dominant thread palette a human digitizer would actually use.
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
}`;

  const body = {
    messages: [
      { role: "system", content: systemMsg },
      { role: "user",   content: [
        { type: "text",      text: "Analyse this image and return the JSON palette only." },
        imageBlock(originalBuffer, mime),
      ]},
    ],
    temperature: 0.0,
    max_tokens: 1024,
  };

  const res = await qwenPost(body);
  if (!res) return null;

  try {
    let raw = res.data?.choices?.[0]?.message?.content || "";
    if (!raw.trim()) return null;

    // Qwen sometimes wraps JSON in ```json blocks; strip cleanly.
    raw = raw.replace(/```json|```/g, "").trim();
    const fa = raw.indexOf("{"), lb = raw.lastIndexOf("}");
    if (fa === -1 || lb <= fa) {
      console.warn("[qwen] analyzeWithQwen response had no JSON braces");
      return null;
    }
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
    console.error("[qwen] analyzeWithQwen parse:", e.message);
    return null;
  }
}

/* ── Cartoonize (LOCAL — Qwen is vision, not image-edit) ─ */
async function convertToCartoonWithQwen(imageBuffer, mime, colorCount) {
  // Qwen-VL has no image-output endpoint. Cartoonization is done locally:
  //   1. quantizeBuffer (median-cut) to colorCount+1 colors
  //   2. flatten alpha so the cartoon reads as flat blocks
  //
  // For real cartoon-style photos the right answer is still a generative
  // image model (Gemini, SDXL, Flux). When those are unavailable we deliver
  // a deterministic flat posterize which the embroidery pipeline can stitch.
  try {
    const { quantizeBuffer } = require("./quantize");
    const buf = await quantizeBuffer(imageBuffer, (parseInt(colorCount) || 6) + 1);
    return { buffer: buf, mime: "image/png" };
  } catch (e) {
    console.warn("[qwen] local cartoonize fallback failed:", e.message);
    return null;
  }
}

module.exports = {
  FIREWORKS_API_KEY,
  QWEN_MODEL,
  analyzeWithQwen,
  convertToCartoonWithQwen,
};
