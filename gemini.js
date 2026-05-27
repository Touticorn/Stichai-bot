'use strict';

const axios = require('axios');
const sharp = require('sharp');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash'
];

if (!GEMINI_API_KEY) {
  console.warn('[gemini] GEMINI_API_KEY is not set; Gemini routes may fail.');
}

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToLab({ r, g, b }) {
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? ((rr + 0.055) / 1.055) ** 2.4 : rr / 12.92;
  gg = gg > 0.04045 ? ((gg + 0.055) / 1.055) ** 2.4 : gg / 12.92;
  bb = bb > 0.04045 ? ((bb + 0.055) / 1.055) ** 2.4 : bb / 12.92;
  const x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047;
  const y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.0000;
  const z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : (7.787 * t + 16 / 116));
  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}
function dE(a, b) { return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2); }
function normHex(h) {
  const m = (h || '').match(/^#?([0-9a-fA-F]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : '#000000';
}

async function geminiPost(body, ms = 45000) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await axios.post(url, body, {
        timeout: ms,
        params: { key: GEMINI_API_KEY },
        headers: { 'Content-Type': 'application/json' }
      });
      return res.data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Gemini request failed');
}

async function segmentSubjectWithGemini(imageBuffer, mime, tapX, tapY) {
  const base64 = imageBuffer.toString('base64');
  const prompt = [
    'Segment the main subject.',
    'Return strict JSON only with one of:',
    '{"maskBase64Png":"..."} OR {"polygon":[{"x":0-1,"y":0-1},...]} OR {"grid":{"size":N,"cells":[0/1,...]}}',
    'If a tap point is provided, prioritize that object.',
    `tapX=${typeof tapX === 'number' ? tapX : -1}, tapY=${typeof tapY === 'number' ? tapY : -1}`
  ].join('\n');

  const data = await geminiPost({
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime || 'image/png', data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.1 }
  });

  const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  const cleaned = txt.replace(/```json|```/gi, '').trim();
  let parsed = {};
  try { parsed = JSON.parse(cleaned); } catch (_) {}

  if (parsed.maskBase64Png) return parsed;
  if (Array.isArray(parsed.polygon)) return parsed;
  if (parsed.grid) return parsed;

  // Fallback: transparent mask to keep response contract stable
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width || 800;
  const h = meta.height || 800;
  const emptyPng = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).png().toBuffer();

  return { maskBase64Png: emptyPng.toString('base64') };
}

async function analyzeWithGemini(originalBuffer, mime, colorCount) {
  const base64 = originalBuffer.toString('base64');
  const prompt = [
    'Analyze this image for embroidery conversion.',
    `Return strict JSON with keys: {"colors":["#RRGGBB"],"notes":"...","complexity":"low|medium|high"}`,
    `Limit palette to ${Math.max(1, Number(colorCount || 8))} colors.`
  ].join('\n');

  const data = await geminiPost({
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime || 'image/png', data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.2 }
  });

  const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  const cleaned = txt.replace(/```json|```/gi, '').trim();

  let parsed = {};
  try { parsed = JSON.parse(cleaned); } catch (_) {}

  const colors = Array.isArray(parsed.colors) ? parsed.colors.map(normHex) : [];
  const dedup = [];
  for (const c of colors) {
    const lab = rgbToLab(hexToRgb(c));
    if (!dedup.some((x) => dE(rgbToLab(hexToRgb(x)), lab) < 2)) dedup.push(c);
  }

  return {
    ...parsed,
    colors: dedup.slice(0, Math.max(1, Number(colorCount || 8)))
  };
}

module.exports = {
  GEMINI_API_KEY,
  GEMINI_MODELS,
  geminiPost,
  segmentSubjectWithGemini,
  analyzeWithGemini
};
