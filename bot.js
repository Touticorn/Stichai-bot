const express = require("express");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const xml2js = require("xml2js");
const app = express();

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FLASH_MODEL = "gemini-2.5-flash";
const PRO_MODEL = "gemini-2.5-pro";

const jobs = new Map();

/* ============================================================
   GEMINI API
   ============================================================ */
function makeUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

async function geminiPost(body, timeoutMs, primaryModel, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(makeUrl(primaryModel), body, { timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 503 || status === 429) {
        const delay = 2000 * Math.pow(2, i);
        console.log(`Gemini ${primaryModel} ${status}, retry ${i + 1}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}

/* ============================================================
   VTRACER — uses npm @aspect-build/vtracer or falls back to binary
   ============================================================ */
let vtracerModule = null;
try {
  // Try the WASM-based npm module first
  vtracerModule = require('@aspect-build/vtracer');
} catch (e) {
  console.log("VTracer npm module not available, will try binary");
}

async function vtracerToSvg(pngBuffer) {
  const tmpIn = path.join("/tmp", `vt_in_${Date.now()}.png`);
  const tmpOut = path.join("/tmp", `vt_out_${Date.now()}.svg`);

  try {
    await fs.promises.writeFile(tmpIn, pngBuffer);

    if (vtracerModule) {
      // Use npm module (WASM, no binary needed)
      const svg = await vtracerModule.vtracer({
        input: tmpIn,
        mode: "polygon",
        filterSpeckle: 4,
        colorPrecision: 6,
        layerDifference: 16,
        cornerThreshold: 60,
        lengthThreshold: 4,
        spliceThreshold: 45,
        pathPrecision: 3,
        hierarchical: "stacked"
      });
      await fs.promises.unlink(tmpIn).catch(() => {});
      return svg;
    }

    // Fallback: try binary at multiple possible paths
    const possibleBins = [
      path.join(__dirname, "vtracer"),
      "/usr/local/bin/vtracer",
      "/usr/bin/vtracer",
      "./vtracer"
    ];

    let vtracerBin = null;
    for (const bin of possibleBins) {
      if (fs.existsSync(bin)) { vtracerBin = bin; break; }
    }

    if (!vtracerBin) {
      console.log("VTracer binary not found. Install with: npm install @aspect-build/vtracer");
      await fs.promises.unlink(tmpIn).catch(() => {});
      return null;
    }

    const { stdout, stderr } = await execAsync(
      `"${vtracerBin}" --input "${tmpIn}" --output "${tmpOut}" --colormode color --mode polygon --filter_speckle 4 --color_precision 6 --layer_difference 16 --corner_threshold 60 --length_threshold 4`,
      { timeout: 30000 }
    );

    if (stderr) console.log("VTracer stderr:", stderr);

    const svg = await fs.promises.readFile(tmpOut, "utf-8");
    await fs.promises.unlink(tmpIn).catch(() => {});
    await fs.promises.unlink(tmpOut).catch(() => {});
    return svg;

  } catch (e) {
    console.log(`VTracer failed: ${e.message}`);
    await fs.promises.unlink(tmpIn).catch(() => {});
    await fs.promises.unlink(tmpOut).catch(() => {});
    return null;
  }
}

/* ============================================================
   SVG PARSING — handles both polygon and path elements
   ============================================================ */
async function parseSvgPaths(svgString, colors) {
  const shapes = [];
  if (!svgString || svgString.length < 50) return shapes;

  try {
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const svg = await parser.parseStringPromise(svgString);

    if (!svg || !svg.svg) {
      console.log("SVG parse: no <svg> element found");
      return shapes;
    }

    // Get viewBox or width/height for scaling
    let vbW = 300, vbH = 300;
    if (svg.svg.$.viewBox) {
      const vb = svg.svg.$.viewBox.split(/\s+/).map(Number);
      if (vb.length === 4) { vbW = vb[2]; vbH = vb[3]; }
    } else {
      vbW = parseFloat(svg.svg.$.width) || 300;
      vbH = parseFloat(svg.svg.$.height) || 300;
    }
    const scale = 300 / Math.max(vbW, vbH);

    // Helper to extract color from style or fill attribute
    function extractColor(el, defaultColor) {
      if (!el) return defaultColor;
      // Check style="fill:#RRGGBB"
      if (el.style && el.style.fill) {
        const m = el.style.fill.match(/#[0-9a-fA-F]{6}/);
        if (m) return m[0].toUpperCase();
      }
      // Check fill="#RRGGBB"
      if (el.fill) {
        const m = el.fill.match(/#[0-9a-fA-F]{6}/);
        if (m) return m[0].toUpperCase();
      }
      return defaultColor;
    }

    // Process <path> elements
    const paths = svg.svg.path || [];
    const pathArray = Array.isArray(paths) ? paths : [paths];

    let colorIdx = 0;
    for (const p of pathArray) {
      if (!p || !p.$ || !p.$.d) continue;
      const d = p.$.d;
      if (!d || d.length < 5) continue;

      const color = extractColor(p.$, colors[colorIdx % colors.length]);
      colorIdx++;

      const rawPoints = parseSvgPathData(d);
      if (rawPoints.length < 3) continue;

      const points = rawPoints.map(([x, y]) => [
        Math.round(x * scale),
        Math.round(y * scale)
      ]);
      
      // Close path if needed
      const first = points[0], last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);

      const type = detectSvgPathType(points);
      shapes.push({ type, color, points, pixelCount: points.length * 10 });
    }

    // Process <polygon> elements
    const polys = svg.svg.polygon || [];
    const polyArray = Array.isArray(polys) ? polys : [polys];

    for (const p of polyArray) {
      if (!p || !p.$ || !p.$.points) continue;
      const pts = p.$.points;
      if (!pts || pts.length < 5) continue;

      const color = extractColor(p.$, colors[colorIdx % colors.length]);
      colorIdx++;

      const rawPoints = parseSvgPolygonPoints(pts);
      if (rawPoints.length < 3) continue;

      const points = rawPoints.map(([x, y]) => [
        Math.round(x * scale),
        Math.round(y * scale)
      ]);

      const first = points[0], last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);

      const type = detectSvgPathType(points);
      shapes.push({ type, color, points, pixelCount: points.length * 10 });
    }

    // Process <g> (group) elements that might contain paths
    const groups = svg.svg.g || [];
    const groupArray = Array.isArray(groups) ? groups : [groups];
    
    for (const g of groupArray) {
      if (!g) continue;
      const gPaths = g.path || [];
      const gPathArray = Array.isArray(gPaths) ? gPaths : [gPaths];
      
      for (const p of gPathArray) {
        if (!p || !p.$ || !p.$.d) continue;
        const d = p.$.d;
        if (!d || d.length < 5) continue;

        const color = extractColor(p.$, colors[colorIdx % colors.length]);
        colorIdx++;

        const rawPoints = parseSvgPathData(d);
        if (rawPoints.length < 3) continue;

        const points = rawPoints.map(([x, y]) => [
          Math.round(x * scale),
          Math.round(y * scale)
        ]);

        const first = points[0], last = points[points.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);

        const type = detectSvgPathType(points);
        shapes.push({ type, color, points, pixelCount: points.length * 10 });
      }
    }

    console.log(`SVG parsed: ${shapes.length} shapes from ${pathArray.length} paths + ${polyArray.length} polygons`);
  } catch (e) {
    console.log(`SVG parse error: ${e.message}`);
  }
  
  return shapes;
}

/* Parse SVG path "d" attribute into point array */
function parseSvgPathData(d) {
  const points = [];
  // Tokenize: match command letters followed by numbers
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-\d.]+/g) || [];
  
  let cx = 0, cy = 0;  // current position
  let subPathStartX = 0, subPathStartY = 0;
  let cmd = null;
  let args = [];

  function flushCommand() {
    if (!cmd || args.length === 0) return;
    
    switch (cmd) {
      case 'M':
        cx = args[0]; cy = args[1];
        subPathStartX = cx; subPathStartY = cy;
        points.push([cx, cy]);
        args = args.slice(2);
        // If more args, treat as L
        if (args.length >= 2) cmd = 'L';
        else return;
        break;
      case 'm':
        cx += args[0]; cy += args[1];
        subPathStartX = cx; subPathStartY = cy;
        points.push([cx, cy]);
        args = args.slice(2);
        if (args.length >= 2) cmd = 'l';
        else return;
        break;
      case 'L':
        while (args.length >= 2) {
          cx = args[0]; cy = args[1];
          points.push([cx, cy]);
          args = args.slice(2);
        }
        return;
      case 'l':
        while (args.length >= 2) {
          cx += args[0]; cy += args[1];
          points.push([cx, cy]);
          args = args.slice(2);
        }
        return;
      case 'H':
        cx = args[0];
        points.push([cx, cy]);
        args = args.slice(1);
        if (args.length >= 1) { /* continue H */ } else return;
        break;
      case 'h':
        cx += args[0];
        points.push([cx, cy]);
        args = args.slice(1);
        if (args.length >= 1) { /* continue h */ } else return;
        break;
      case 'V':
        cy = args[0];
        points.push([cx, cy]);
        args = args.slice(1);
        if (args.length >= 1) { /* continue V */ } else return;
        break;
      case 'v':
        cy += args[0];
        points.push([cx, cy]);
        args = args.slice(1);
        if (args.length >= 1) { /* continue v */ } else return;
        break;
      case 'C':
        while (args.length >= 6) {
          // Sample cubic bezier
          for (let t = 0.1; t <= 1; t += 0.2) {
            const t1 = 1 - t;
            const bx = t1 * t1 * t1 * cx + 3 * t1 * t1 * t * args[0] + 3 * t1 * t * t * args[2] + t * t * t * args[4];
            const by = t1 * t1 * t1 * cy + 3 * t1 * t1 * t * args[1] + 3 * t1 * t * t * args[3] + t * t * t * args[5];
            points.push([bx, by]);
          }
          cx = args[4]; cy = args[5];
          args = args.slice(6);
        }
        return;
      case 'c':
        while (args.length >= 6) {
          for (let t = 0.1; t <= 1; t += 0.2) {
            const t1 = 1 - t;
            const bx = t1 * t1 * t1 * cx + 3 * t1 * t1 * t * (cx + args[0]) + 3 * t1 * t * t * (cx + args[2]) + t * t * t * (cx + args[4]);
            const by = t1 * t1 * t1 * cy + 3 * t1 * t1 * t * (cy + args[1]) + 3 * t1 * t * t * (cy + args[3]) + t * t * t * (cy + args[5]);
            points.push([bx, by]);
          }
          cx += args[4]; cy += args[5];
          args = args.slice(6);
        }
        return;
      case 'Q':
        while (args.length >= 4) {
          for (let t = 0.1; t <= 1; t += 0.2) {
            const t1 = 1 - t;
            const bx = t1 * t1 * cx + 2 * t1 * t * args[0] + t * t * args[2];
            const by = t1 * t1 * cy + 2 * t1 * t * args[1] + t * t * args[3];
            points.push([bx, by]);
          }
          cx = args[2]; cy = args[3];
          args = args.slice(4);
        }
        return;
      case 'Z':
      case 'z':
        points.push([subPathStartX, subPathStartY]);
        cx = subPathStartX; cy = subPathStartY;
        return;
    }
    
    // Process remaining args
    if (args.length > 0) {
      const remaining = [...args];
      args = [];
      flushCommand();
      args = remaining;
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(token)) {
      // Flush previous command
      flushCommand();
      cmd = token;
      args = [];
    } else {
      args.push(parseFloat(token));
    }
  }
  flushCommand();

  // Simplify with RDP
  return ramerDouglasPeucker(points, 0.3);
}

function parseSvgPolygonPoints(pts) {
  const coords = pts.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
  const points = [];
  for (let i = 0; i < coords.length; i += 2) {
    if (i + 1 < coords.length) {
      points.push([coords[i], coords[i + 1]]);
    }
  }
  if (points.length > 1) points.push([...points[0]]);
  return points;
}

function detectSvgPathType(points) {
  const b = polygonBounds(points);
  const minDim = Math.min(b.width, b.height);
  const maxDim = Math.max(b.width, b.height);
  // Narrow shapes = satin for textile-quality edge finish
  if (minDim < 15 && maxDim < 120) return "satin";
  if (minDim < 8) return "satin";
  return "fill";
}

/* ============================================================
   ROBUST JSON REPAIR — handles Gemini's malformed output
   ============================================================ */
function robustRepairJSON(str) {
  // Strip markdown fences
  let s = str.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
  
  // Find outer boundaries
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  
  // Determine if it's an object or array
  let start = -1, end = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
    // If it starts with array but contains objects, find end
    if (firstBrace !== -1 && firstBrace < firstBracket) start = firstBrace;
  }
  
  if (start === -1) {
    // No JSON structure found, try adding braces
    return '{"shapes":[]}';
  }

  end = Math.max(lastBrace, lastBracket);
  if (end <= start) end = s.length - 1;

  s = s.substring(start, end + 1);

  // Count braces/brackets
  let openBraces = 0, openBrackets = 0;
  let inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }

  // Close unclosed structures
  // Remove trailing commas before closing
  s = s.replace(/,\s*$/, '');
  
  // If we have a trailing incomplete key-value
  if (s.endsWith('"') || s.endsWith(':') || s.endsWith(',')) {
    s = s.replace(/[:,]\s*$/, '');
  }
  
  // If last char is a number and no closing quote
  if (/\d$/.test(s)) {
    // Check if we're in an unclosed string
    const lastQuote = s.lastIndexOf('"');
    const secondLastQuote = s.lastIndexOf('"', lastQuote - 1);
    if (secondLastQuote !== -1 && (lastQuote - secondLastQuote) % 2 === 0) {
      s += '"';
    }
  }

  // Close braces and brackets
  for (let i = 0; i < openBrackets; i++) s += ']';
  for (let i = 0; i < openBraces; i++) s += '}';

  // Handle numeric edge cases
  s = s.replace(/:\s*,/g, ':0,');  // empty values
  s = s.replace(/:\s*}/g, ':0}');  // empty value before close
  s = s.replace(/,(\s*[}\]])/g, '$1'); // trailing comma
  s = s.replace(/([}\]]){2,}/g, (match) => match[0]); // double close
  
  // If still invalid, try basic structure
  try {
    JSON.parse(s);
    return s;
  } catch (e1) {
    console.log("First repair failed:", e1.message.substring(0, 100));
    
    // Aggressive fallback: extract just the shapes array
    const shapesIdx = s.indexOf('"shapes"');
    if (shapesIdx !== -1) {
      const colonIdx = s.indexOf(':', shapesIdx);
      const bracketIdx = s.indexOf('[', colonIdx);
      if (bracketIdx !== -1) {
        let bracketEnd = bracketIdx + 1;
        let depth = 1;
        let inStr = false, esc = false;
        for (let i = bracketIdx + 1; i < s.length && depth > 0; i++) {
          const ch = s[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[') depth++;
          if (ch === ']') depth--;
          bracketEnd = i;
        }
        const shapesArr = s.substring(bracketIdx, bracketEnd + 1) + ']'.repeat(Math.max(0, depth));
        
        // Try to fix each shape object
        const fixedArr = shapesArr.replace(/\{[^}]*\}/g, (obj) => {
          let fixed = obj;
          // Remove trailing commas
          fixed = fixed.replace(/,(\s*})/g, '$1');
          // Fix missing values (e.g., "points":[[x,y],])
          fixed = fixed.replace(/\[,\s*/g, '[');
          fixed = fixed.replace(/,\s*\]/g, ']');
          // Add missing closing brackets
          const openPts = (fixed.match(/\[/g) || []).length;
          const closePts = (fixed.match(/\]/g) || []).length;
          for (let i = 0; i < openPts - closePts; i++) fixed += ']';
          return fixed;
        });
        
        return `{"shapes":${fixedArr}}`;
      }
    }
    
    return '{"shapes":[]}';
  }
}

/* ============================================================
   GEMINI SHAPE EXTRACTION — with better prompt + JSON repair
   ============================================================ */
async function analyzeImage(b64, mime) {
  const prompt = `You are an embroidery digitizer. Analyze this image.

Return ONLY a JSON object with NO markdown, NO comments, NO extra text:
{
  "background": "#RRGGBB",
  "colors": ["#RRGGBB", "#RRGGBB", ...],
  "is_text": true or false,
  "is_logo": true or false
}

Rules:
- background: the paper/surface color (usually white, off-white, light gray, or transparent)
- colors: 3-8 distinct thread colors in the actual design (NOT the background)
- is_text: true ONLY if image contains readable words/letters (not just shapes)
- is_logo: true if image has a brand emblem or logo marks`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.02, maxOutputTokens: 1024 }
  };

  const res = await geminiPost(body, 45000, FLASH_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  const jsonStr = robustRepairJSON(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.log("Analysis parse failed, using defaults. Raw:", text.substring(0, 200));
    parsed = { background: "#FFFFFF", colors: ["#FF0000", "#FFFFFF", "#0000FF"], is_text: false, is_logo: false };
  }
  
  const colors = deduplicateColors(parsed.colors || ["#FF0000", "#FFFFFF", "#0000FF"]);
  
  return {
    background: parsed.background || "#FFFFFF",
    colors,
    is_text: !!parsed.is_text,
    is_logo: !!parsed.is_logo,
  };
}

async function extractGeminiShapes(b64, mime, colors, isText, isLogo) {
  const colorList = colors.join(", ");
  
  // Simpler prompt that's harder to get wrong
  const prompt = `You are an embroidery digitizer. Extract shapes from this image using ONLY these colors: ${colorList}

Return ONLY a JSON object. No markdown, no comments, no explanation:
{
  "shapes": [
    {
      "type": "fill",
      "color": "#RRGGBB",
      "points": [[100,150],[200,150],[200,250],[100,250]]
    }
  ]
}

Rules:
- "type" is "satin" for narrow strokes/letters, "fill" for wide solid areas
- "color" must match one of the colors listed above EXACTLY
- "points" are [x,y] coordinates in 0-300 space
- Maximum 30 shapes
- Make sure points array has opening [[ and closing ]]
- Order: background shapes first, details on top`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { temperature: 0.02, maxOutputTokens: 8192 }
  };

  const res = await geminiPost(body, 60000, PRO_MODEL);
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  console.log(`Gemini raw output (first 500 chars):`, text.substring(0, 500));
  
  const jsonStr = robustRepairJSON(text);
  
  let analysis;
  try {
    analysis = JSON.parse(jsonStr);
  } catch (e) {
    console.log("Gemini shapes parse failed:", e.message);
    throw new Error("Gemini shapes: invalid JSON");
  }

  const shapes = [];
  const rawShapes = analysis.shapes || [];
  
  for (const s of rawShapes) {
    if (!s.points || !Array.isArray(s.points) || s.points.length < 3) continue;
    
    // Normalize points
    const points = [];
    for (const p of s.points) {
      if (Array.isArray(p) && p.length >= 2) {
        points.push([Math.round(p[0]), Math.round(p[1])]);
      } else if (p && typeof p === 'object' && p.x !== undefined) {
        points.push([Math.round(p.x), Math.round(p.y || 0)]);
      }
    }
    
    if (points.length < 3) continue;
    
    // Close polygon
    const first = points[0], last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      points.push([...first]);
    }
    
    // Validate bounds
    const b = polygonBounds(points);
    if (b.width < 2 || b.height < 2) continue;
    
    shapes.push({
      type: s.type === "satin" ? "satin" : "fill",
      color: s.color || colors[0],
      points,
      pixelCount: Math.round(b.width * b.height)
    });
  }
  
  console.log(`Gemini shapes extracted: ${shapes.length}`);
  return shapes;
}

/* ============================================================
   COLOR UTILITIES — Lab color space for perceptual matching
   ============================================================ */
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
}

function rgbToLab({ r, g, b }) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { l: 116 * f(Y) - 16, a: 500 * (f(X / 0.95047) - f(Y)), b: 200 * (f(Y) - f(Z / 1.08883)) };
}

function colorDistanceLab(c1Lab, c2Lab) {
  return Math.sqrt((c1Lab.l - c2Lab.l) ** 2 + (c1Lab.a - c2Lab.a) ** 2 + (c1Lab.b - c2Lab.b) ** 2);
}

function deduplicateColors(colors) {
  const unique = [];
  const labs = colors.map(c => rgbToLab(hexToRgb(c)));
  for (let i = 0; i < colors.length; i++) {
    let dup = false;
    for (let j = 0; j < unique.length; j++) {
      if (colorDistanceLab(labs[i], rgbToLab(hexToRgb(unique[j]))) < 20) { dup = true; break; }
    }
    if (!dup) unique.push(colors[i]);
  }
  return unique.length ? unique : ["#FF0000", "#FFFFFF", "#0000FF"];
}

function toThreadColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : "#FF0066";
}

/* ============================================================
   PREPROCESSING — optimize for vectorization
   ============================================================ */
async function preprocessImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: false })
    .linear(1.15, -10)
    .normalize()
    .modulate({ saturation: 1.7 })
    .median(1)
    .sharpen({ sigma: 1.2, m1: 1.5, m2: 2.5 })
    .toFormat("png")
    .toBuffer();
}

/* ============================================================
   PIXEL TRACING — nuclear option, always works
   ============================================================ */
function ramerDouglasPeucker(points, epsilon) {
  if (points.length <= 3) return points;
  const lineDist = (px, py, sx, sy, ex, ey) => {
    const len = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
    if (len === 0) return Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
    return Math.abs((ey - sy) * px - (ex - sx) * py + ex * sy - ey * sx) / len;
  };
  const stack = [[0, points.length - 1]];
  const keep = new Set([0, points.length - 1]);
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    const [sx, sy] = points[start], [ex, ey] = points[end];
    let maxDist = 0, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = lineDist(points[i][0], points[i][1], sx, sy, ex, ey);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      keep.add(maxIdx);
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return Array.from(keep).sort((a, b) => a - b).map(i => points[i]);
}

async function extractPixelShapes(buffer, colors, isText = false) {
  const jimpModule = require("jimp");
  const Jimp = jimpModule.Jimp || jimpModule;

  const image = await Jimp.read(buffer);
  const origW = image.bitmap.width, origH = image.bitmap.height;
  const procSize = 1600;
  const scale = Math.min(procSize / origW, procSize / origH);
  const pw = Math.max(1, Math.round(origW * scale));
  const ph = Math.max(1, Math.round(origH * scale));
  image.resize(pw, ph);

  const labColors = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixelColors = new Int16Array(pw * ph);
  pixelColors.fill(-1);

  const tid = Math.random().toString(36).slice(2, 5);
  console.time(`pixel-classify-${tid}`);
  const data = image.bitmap.data;
  for (let y = 0; y < ph; y++) {
    const rowOff = y * pw * 4;
    const outOff = y * pw;
    for (let x = 0; x < pw; x++) {
      const i = rowOff + (x << 2);
      const pixLab = rgbToLab({ r: data[i], g: data[i + 1], b: data[i + 2] });
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < labColors.length; c++) {
        const d = colorDistanceLab(pixLab, labColors[c]);
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (bestDist < 45) pixelColors[outOff + x] = bestIdx;
    }
  }
  console.timeEnd(`pixel-classify-${tid}`);

  console.time(`heal-${tid}`);
  for (let y = 1; y < ph - 1; y++) {
    const row = y * pw;
    for (let x = 1; x < pw - 1; x++) {
      const idx = row + x;
      if (pixelColors[idx] !== -1) continue;
      const neighbors = [
        pixelColors[idx - 1], pixelColors[idx + 1],
        pixelColors[idx - pw], pixelColors[idx + pw],
        pixelColors[idx - pw - 1], pixelColors[idx - pw + 1],
        pixelColors[idx + pw - 1], pixelColors[idx + pw + 1]
      ].filter(n => n !== -1);
      if (neighbors.length >= 5) {
        // Find most common
        const freq = {};
        for (const n of neighbors) freq[n] = (freq[n] || 0) + 1;
        let best = -1, bestCnt = 0;
        for (const [k, v] of Object.entries(freq)) {
          if (v > bestCnt) { bestCnt = v; best = parseInt(k); }
        }
        if (bestCnt >= 4) pixelColors[idx] = best;
      }
    }
  }
  console.timeEnd(`heal-${tid}`);

  const shapes = [];
  const minComponentSize = 15;
  let currentMaskId = 1;

  console.time(`contour-${tid}`);
  for (let ci = 0; ci < labColors.length; ci++) {
    const visited = new Uint8Array(pw * ph);
    const maskIds = new Uint32Array(pw * ph);

    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = y * pw + x;
        if (pixelColors[idx] !== ci || visited[idx]) continue;

        const q = [idx];
        let qPtr = 0;
        let pixelCount = 0;
        let startX = -1, startY = -1;
        visited[idx] = 1;
        maskIds[idx] = currentMaskId;

        while (qPtr < q.length) {
          const ci2 = q[qPtr++];
          pixelCount++;
          const cx = ci2 % pw;
          const cy = (ci2 / pw) | 0;

          if (startX === -1) {
            const left = cx > 0 ? pixelColors[ci2 - 1] : -1;
            const right = cx < pw - 1 ? pixelColors[ci2 + 1] : -1;
            const up = cy > 0 ? pixelColors[ci2 - pw] : -1;
            const down = cy < ph - 1 ? pixelColors[ci2 + pw] : -1;
            if (left !== ci || right !== ci || up !== ci || down !== ci) {
              startX = cx; startY = cy;
            }
          }

          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (dy === 0 && dx === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx >= 0 && nx < pw && ny >= 0 && ny < ph) {
                const ni = ny * pw + nx;
                if (!visited[ni] && pixelColors[ni] === ci) {
                  visited[ni] = 1;
                  maskIds[ni] = currentMaskId;
                  q.push(ni);
                }
              }
            }
          }
        }

        if (pixelCount < minComponentSize || startX === -1) {
          currentMaskId++;
          continue;
        }

        const contour = [];
        const n8 = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
        let cx = startX, cy = startY, dir = 7;
        let safety = 0;
        const inMask = (mx, my) => mx >= 0 && mx < pw && my >= 0 && my < ph && maskIds[my * pw + mx] === currentMaskId;

        do {
          contour.push([cx, cy]);
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const d = (dir + i) & 7;
            const nx = cx + n8[d][0], ny = cy + n8[d][1];
            if (inMask(nx, ny)) { cx = nx; cy = ny; dir = (d + 5) & 7; found = true; break; }
          }
          if (!found) break;
          safety++;
        } while ((cx !== startX || cy !== startY) && safety < 500000);

        currentMaskId++;
        if (contour.length < 4) continue;

        const simplified = ramerDouglasPeucker(contour, 0.3);
        const stitchScale = 300 / Math.max(pw, ph);
        const points = simplified.map(([px, py]) => [Math.round(px * stitchScale), Math.round(py * stitchScale)]);

        if (points.length >= 3) {
          const first = points[0], last = points[points.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of points) {
          minX = Math.min(minX, px); minY = Math.min(minY, py);
          maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
        const bw = maxX - minX, bh = maxY - minY;
        const area = bw * bh;
        const isNarrow = (bw < 12 || bh < 12) && area < 13500;

        shapes.push({ type: isNarrow ? "satin" : "fill", color: colors[ci], points, pixelCount });
      }
    }
  }
  console.timeEnd(`contour-${tid}`);

  // Quality filter: remove tiny shapes, merge same-color overlaps
  const filtered = [];
  const usedForMerge = new Set();
  
  for (let i = 0; i < shapes.length; i++) {
    if (usedForMerge.has(i)) continue;
    const s = shapes[i];
    const b = polygonBounds(s.points);
    if (b.width < 3 || b.height < 3) continue;
    if (s.pixelCount < 25) continue;
    if (s.points.length < 4) continue;
    filtered.push(s);
  }

  // Text-specific reclassification: text shapes default to satin
  if (isText) {
    for (const s of filtered) {
      const b = polygonBounds(s.points);
      const minDim = Math.min(b.width, b.height);
      const maxDim = Math.max(b.width, b.height);
      // Letters are narrow but not too long
      if (minDim < 80 && maxDim < 200) {
        s.type = "satin";
      }
    }
  }

  const satinCount = filtered.filter(s => s.type === "satin").length;
  const fillCount = filtered.filter(s => s.type === "fill").length;
  console.log(`Pixel: ${satinCount} satin, ${fillCount} fill, ${filtered.length} total`);
  
  return filtered;
}

/* ============================================================
   STITCH GENERATION — satin/fill with underlay
   ============================================================ */
function polygonBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, area: (maxX - minX) * (maxY - minY) };
}

function polygonCentroid(points) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x1, y1] = points[i], [x2, y2] = points[j];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross; cy += (y1 + y2) * cross; a += cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 0.001) {
    let sx = 0, sy = 0;
    for (const [x, y] of points) { sx += x; sy += y; }
    return [sx / points.length, sy / points.length];
  }
  const factor = 1 / (6 * a);
  return [cx * factor, cy * factor];
}

function computeFillAngle(points) {
  const n = points.length;
  if (n < 3) return 0;
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let mxx = 0, myy = 0, mxy = 0;
  for (const [x, y] of points) {
    const dx = x - cx, dy = y - cy;
    mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
  }
  if (Math.abs(mxy) < 0.001) return 0;
  return Math.atan2(2 * mxy, mxx - myy) / 2;
}

function underlayFillPolygon(points, color) {
  const stitches = [];
  const inset = 2.0; // inset edge walk
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * inset, ny = dx / len * inset;
    inner.push([x1 + nx, y1 + ny]);
  }
  const totalLen = inner.reduce((sum, p, i) => {
    const [x1, y1] = p, [x2, y2] = inner[(i + 1) % inner.length];
    return sum + Math.hypot(x2 - x1, y2 - y1);
  }, 0);
  const steps = Math.max(inner.length, Math.floor(totalLen / 8));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * inner.length;
    const idx = Math.floor(t) % inner.length;
    const frac = t - Math.floor(t);
    const nextIdx = (idx + 1) % inner.length;
    stitches.push({
      x: Math.round(inner[idx][0] + (inner[nextIdx][0] - inner[idx][0]) * frac),
      y: Math.round(inner[idx][1] + (inner[nextIdx][1] - inner[idx][1]) * frac),
      color, type: "underlay"
    });
  }
  return stitches;
}

function contourFillPolygon(points, color) {
  const stitches = [];
  const fillAngle = computeFillAngle(points);
  const cosA = Math.cos(fillAngle), sinA = Math.sin(fillAngle);
  // Professional density: ~4 lines per mm = 0.25mm spacing at 300 units for ~76mm design
  const rowSpacing = 3.5;  // units in 0-300 space
  
  function toLocal(x, y) { return [x * cosA + y * sinA, -x * sinA + y * cosA]; }
  function toGlobal(lx, ly) { return [lx * cosA - ly * sinA, lx * sinA + ly * cosA]; }
  const localPts = points.map(([x, y]) => toLocal(x, y));
  const lBounds = polygonBounds(localPts);

  let rowIdx = 0;
  for (let ly = lBounds.minY; ly <= lBounds.maxY; ly += rowSpacing) {
    const ints = [];
    for (let i = 0, j = localPts.length - 1; i < localPts.length; j = i++) {
      const [x1, y1] = localPts[i], [x2, y2] = localPts[j];
      if ((y1 <= ly && y2 > ly) || (y2 <= ly && y1 > ly)) {
        ints.push(x1 + (ly - y1) / (y2 - y1) * (x2 - x1));
      }
    }
    if (ints.length < 2) continue;
    ints.sort((a, b) => a - b);

    for (let k = 0; k + 1 < ints.length; k += 2) {
      let segStart = ints[k], segEnd = ints[k + 1];
      if (segEnd - segStart < 2) continue;
      
      // Alternate direction for each row
      if (rowIdx % 2 === 1) {
        [segStart, segEnd] = [segEnd, segStart];
      }
      
      // Stitch spacing (0.4mm equivalent in our 300-unit space)
      const stitchSpacing = 3.0;
      const steps = Math.max(1, Math.floor(Math.abs(segEnd - segStart) / stitchSpacing));
      
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lx = segStart + (segEnd - segStart) * t;
        const [gx, gy] = toGlobal(lx, ly);
        stitches.push({ x: Math.round(gx), y: Math.round(gy), color, type: "fill" });
      }
    }
    rowIdx++;
  }
  return stitches;
}

function satinColumnPolygon(points, color) {
  const stitches = [];
  // Satin column width ~2.5mm in our 300-unit space
  const satinWidth = 2.5;
  
  // Compute inner rail (inset by satinWidth/2)
  const inner = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * (satinWidth / 2);
    const ny = dx / len * (satinWidth / 2);
    inner.push([x1 + nx, y1 + ny]);
  }

  // Interpolate between outer and inner rails
  const totalLen = points.reduce((sum, p, i) => {
    const [x1, y1] = p, [x2, y2] = points[(i + 1) % points.length];
    return sum + Math.hypot(x2 - x1, y2 - y1);
  }, 0);
  
  // ~0.4mm zigzag spacing
  const zigzagSpacing = 2.0;
  const steps = Math.max(points.length * 2, Math.floor(totalLen / zigzagSpacing));
  
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * points.length;
    const idx = Math.floor(t) % points.length;
    const frac = t - Math.floor(t);
    const nextIdx = (idx + 1) % points.length;
    
    // Outer rail position
    const ox = points[idx][0] + (points[nextIdx][0] - points[idx][0]) * frac;
    const oy = points[idx][1] + (points[nextIdx][1] - points[idx][1]) * frac;
    
    // Inner rail position
    const ix = inner[idx][0] + (inner[nextIdx][0] - inner[idx][0]) * frac;
    const iy = inner[idx][1] + (inner[nextIdx][1] - inner[idx][1]) * frac;
    
    // Zigzag: alternate between outer and inner
    if (i % 2 === 0) {
      stitches.push({ x: Math.round(ox), y: Math.round(oy), color, type: "satin" });
    } else {
      stitches.push({ x: Math.round(ix), y: Math.round(iy), color, type: "satin" });
    }
  }
  return stitches;
}

function generateStitches(shapes) {
  const all = [];
  const designW = 300, designH = 300;

  // Compute centroids for ordering
  for (const s of shapes) {
    s.centroid = polygonCentroid(s.points);
  }

  // Group by color
  const colorGroups = {};
  for (const s of shapes) {
    const c = toThreadColor(s.color || "#FF0066");
    if (!colorGroups[c]) colorGroups[c] = [];
    colorGroups[c].push({ ...s, color: c });
  }

  // Nearest-neighbor ordering within each color group
  for (const color of Object.keys(colorGroups)) {
    const group = colorGroups[color];
    if (group.length <= 1) continue;

    const ordered = [group[0]];
    const remaining = group.slice(1);
    while (remaining.length) {
      let bestIdx = 0, bestDist = Infinity;
      const [lx, ly] = ordered[ordered.length - 1].centroid;
      for (let i = 0; i < remaining.length; i++) {
        const [cx, cy] = remaining[i].centroid;
        const d = Math.hypot(cx - lx, cy - ly);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }
    colorGroups[color] = ordered;
  }

  // Generate stitches with improved jump management
  let lastX = 0, lastY = 0;
  const maxJump = 20; // cap jumps at 20 units (~5mm)

  for (const color of Object.keys(colorGroups)) {
    for (const s of colorGroups[color]) {
      const points = s.points || [[0, 0], [10, 0], [10, 10], [0, 10]];
      const type = s.type || "fill";
      const [sx, sy] = points[0] || [0, 0];
      const jump = Math.hypot(sx - lastX, sy - lastY);

      // Add trim and travel stitches for jumps
      if (jump > maxJump && all.length > 0) {
        all.push({ x: Math.round(lastX), y: Math.round(lastY), color, type: "trim" });
        all.push({ x: Math.round(sx), y: Math.round(sy), color, type: "trim" });
      }

      if (type === "fill") {
        all.push(...underlayFillPolygon(points, color));
        all.push(...contourFillPolygon(points, color));
      } else {
        // Satin: underlay + satin column
        all.push(...underlayFillPolygon(points, color));
        all.push(...satinColumnPolygon(points, color));
      }

      if (all.length) {
        const last = all[all.length - 1];
        lastX = last.x;
        lastY = last.y;
      }
    }
  }

  // Bounding box running stitch
  all.push(...runningPolygon([[-2, -2], [designW + 2, -2], [designW + 2, designH + 2], [-2, designH + 2]], "#333333"));
  
  return { stitches: all, designW, designH, shapes };
}

function runningPolygon(points, color) {
  const stitches = [];
  if (points.length < 2) return stitches;
  const segLens = [];
  let cumLen = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segLens.push({ start: cumLen, len, idx: i });
    cumLen += len;
  }
  if (cumLen < 1) return stitches;
  const spacing = 3.0;
  const steps = Math.max(1, Math.floor(cumLen / spacing));
  for (let s = 0; s <= steps; s++) {
    const target = (s / steps) * cumLen;
    let seg = segLens[0];
    for (const candidate of segLens) {
      if (candidate.start <= target && target < candidate.start + candidate.len) { seg = candidate; break; }
      if (s === steps && target >= candidate.start) seg = candidate;
    }
    const frac = seg.len > 0 ? (target - seg.start) / seg.len : 0;
    const [x1, y1] = points[seg.idx];
    const [x2, y2] = points[(seg.idx + 1) % points.length];
    stitches.push({ x: Math.round(x1 + (x2 - x1) * frac), y: Math.round(y1 + (y2 - y1) * frac), color, type: "running" });
  }
  return stitches;
}

/* ============================================================
   QUALITY VALIDATION
   ============================================================ */
function validateQuality(stitches) {
  const warnings = [];
  let totalLen = 0, stitchCount = 0, maxJump = 0, longJumps = 0;
  let prev = null;

  for (const s of stitches) {
    if (prev) {
      const d = Math.hypot(s.x - prev.x, s.y - prev.y);
      if (d > maxJump) maxJump = d;
      if (d > 10) longJumps++;
      if (s.type !== "trim" && prev.type !== "trim") {
        totalLen += d;
        stitchCount++;
      }
    }
    prev = s;
  }

  const avgLen = stitchCount > 0 ? totalLen / stitchCount : 0;
  if (avgLen < 1.5) warnings.push(`Stitches too dense (avg ${avgLen.toFixed(1)}mm)`);
  if (avgLen > 4.0) warnings.push(`Stitches too long (avg ${avgLen.toFixed(1)}mm)`);
  if (maxJump > 30) warnings.push(`Very long jump (${maxJump.toFixed(1)}mm)`);
  if (longJumps > 30) warnings.push(`${longJumps} long jumps`);
  if (stitchCount > 50000) warnings.push(`High stitch count (${stitchCount})`);
  if (stitchCount < 100) warnings.push(`Low stitch count (${stitchCount})`);

  return {
    avgStitchLength: avgLen.toFixed(1),
    maxJump: maxJump.toFixed(1),
    longJumpCount: longJumps,
    stitchCount,
    density: avgLen > 0 ? (1 / avgLen).toFixed(2) : "0",
    warnings,
    passed: warnings.length === 0
  };
}

/* ============================================================
   DST ENCODING — Tajima format with proper headers
   ============================================================ */
function stitchRecord(dx, dy) {
  const cdx = Math.max(-121, Math.min(121, Math.round(dx)));
  const cdy = Math.max(-121, Math.min(121, Math.round(dy)));
  return Buffer.from([cdy >= 0 ? cdy : 0x100 + cdy, cdx >= 0 ? cdx : 0x100 + cdx, 0x03]);
}

function encodeDST(data) {
  const { stitches } = data;
  const header = Buffer.alloc(512, 0x20);
  header.write("Stichai", 0, "ascii");
  
  const records = [];
  let lastColor = null, prevX = 0, prevY = 0;
  let stitchCount = 0, colorChangeCount = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0, absX = 0, absY = 0;

  for (const s of stitches) {
    absX += s.x - prevX;
    absY += s.y - prevY;
    if (absX < minX) minX = absX;
    if (absX > maxX) maxX = absX;
    if (absY < minY) minY = absY;
    if (absY > maxY) maxY = absY;

    if (s.color !== lastColor && lastColor !== null) {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChangeCount++;
    }
    lastColor = s.color;

    if (s.type === "trim") {
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      records.push(Buffer.from([0x00, 0x00, 0xC3]));
      const dx = s.x - prevX, dy = s.y - prevY;
      prevX = s.x; prevY = s.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 121));
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        records.push(stitchRecord(dx * f, dy * f));
      }
      continue;
    }
    
    const dx = Math.round(s.x - prevX), dy = Math.round(s.y - prevY);
    prevX = s.x; prevY = s.y;
    records.push(stitchRecord(dx, dy));
    stitchCount++;
  }
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  stitchCount++;

  header.writeInt32LE(stitchCount, 20);
  header.writeInt32LE(colorChangeCount, 24);
  header.writeInt16LE(Math.round((maxX - minX) * 10), 28);
  header.writeInt16LE(Math.round((maxY - minY) * 10), 32);
  header.writeInt16LE(Math.round(minX * 10), 36);
  header.writeInt16LE(Math.round(maxX * 10), 40);
  header.writeInt16LE(Math.round(minY * 10), 44);
  header.writeInt16LE(Math.round(maxY * 10), 48);
  header.write("(c)Stichai", 56, "ascii");
  header.writeInt16LE(colorChangeCount + 1, 88);

  return Buffer.concat([header, ...records]);
}

function encodePES(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("#PES0001", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeJEF(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("JEF0001\x00", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeEXP(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("EXP0001\x00", 0, "ascii"); return Buffer.concat([h, d]); }
function encodeVP3(data) { const d = encodeDST(data); const h = Buffer.alloc(8); h.write("VP30001\x00", 0, "ascii"); return Buffer.concat([h, d]); }

function encodeFile(format, data) {
  switch ((format || "dst").toLowerCase()) {
    case "dst": return { buf: encodeDST(data), ext: "dst" };
    case "pes": return { buf: encodePES(data), ext: "pes" };
    case "jef": return { buf: encodeJEF(data), ext: "jef" };
    case "exp": return { buf: encodeEXP(data), ext: "exp" };
    case "vp3": return { buf: encodeVP3(data), ext: "vp3" };
    default: return { buf: encodeDST(data), ext: "dst" };
  }
}

/* ============================================================
   PREVIEW RENDERER
   ============================================================ */
function hexToRgbNums(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function setPixel(buf, w, h, x, y, r, g, b) {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || px >= w || py < 0 || py >= h) return;
  const i = (py * w + px) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}

function drawLineOnBuffer(buf, w, h, x0, y0, x1, y1, r, g, b, stroke) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  const half = Math.ceil(stroke / 2);
  while (true) {
    for (let ox = -half; ox <= half; ox++) {
      for (let oy = -half; oy <= half; oy++) {
        setPixel(buf, w, h, x + ox, y + oy, r, g, b);
      }
    }
    if (Math.abs(x - x1) < 0.5 && Math.abs(y - y1) < 0.5) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

async function renderStitchesToPng(stitches, designW, designH) {
  const scale = 4;
  const w = Math.round(designW * scale);
  const h = Math.round(designH * scale);
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    buf[i] = 245; buf[i + 1] = 242; buf[i + 2] = 235; buf[i + 3] = 255;
  }

  let prev = null;
  for (const s of stitches) {
    if (s.type === "trim") { prev = null; continue; }
    if (prev && prev.color === s.color && prev.type !== "trim") {
      const dist = Math.hypot(s.x - prev.x, s.y - prev.y);
      if (dist < 15) {
        const [cr, cg, cb] = hexToRgbNums(s.color);
        const sw = s.type === 'satin' ? 2.0 : (s.type === 'underlay' ? 0.5 : 1.0);
        drawLineOnBuffer(buf, w, h, prev.x * scale, prev.y * scale, s.x * scale, s.y * scale, cr, cg, cb, sw);
      }
    }
    prev = s;
  }
  return await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/* ============================================================
   ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-embroidery", upload.single("image"), async (req, res) => {
  res.setTimeout(0);
  const reqId = Math.random().toString(36).slice(2, 6);

  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    console.time(`preprocess-${reqId}`);
    const cleanBuffer = await preprocessImage(req.file.buffer);
    console.timeEnd(`preprocess-${reqId}`);

    const cleanB64 = cleanBuffer.toString("base64");
    const cleanMime = "image/png";

    // Step 1: Analyze image
    console.time(`analyze-${reqId}`);
    const analysis = await analyzeImage(cleanB64, cleanMime);
    console.timeEnd(`analyze-${reqId}`);
    console.log(`Bg: ${analysis.background}, Colors: ${analysis.colors.join(",")}, Text: ${analysis.is_text}`);

    // Step 2: Shape extraction cascade
    let shapes = [];
    let method = "none";

    // Tier 1: VTracer (clean vectors)
    try {
      console.time(`vt-${reqId}`);
      const svg = await vtracerToSvg(cleanBuffer);
      if (svg) {
        shapes = await parseSvgPaths(svg, analysis.colors);
        console.timeEnd(`vt-${reqId}`);
        if (shapes.length >= 2) {
          method = "vtracer";
          console.log(`VTracer: ${shapes.length} shapes`);
        }
      } else {
        console.timeEnd(`vt-${reqId}`);
      }
    } catch (e) {
      console.log(`VTracer error: ${e.message}`);
    }

    // Tier 2: Gemini shape extraction
    if (shapes.length < 2) {
      try {
        console.time(`gem-${reqId}`);
        shapes = await extractGeminiShapes(cleanB64, cleanMime, analysis.colors, analysis.is_text, analysis.is_logo);
        console.timeEnd(`gem-${reqId}`);
        if (shapes.length >= 2) {
          method = "gemini";
          console.log(`Gemini: ${shapes.length} shapes`);
        }
      } catch (e) {
        console.log(`Gemini error: ${e.message}`);
      }
    }

    // Tier 3: Pixel tracing
    if (shapes.length < 2) {
      console.time(`pix-${reqId}`);
      shapes = await extractPixelShapes(cleanBuffer, analysis.colors, analysis.is_text);
      console.timeEnd(`pix-${reqId}`);
      method = "pixel";
      console.log(`Pixel: ${shapes.length} shapes`);
    }

    if (!shapes.length) return res.status(500).json({ error: "No shapes extracted" });

    // Force text to satin
    if (analysis.is_text) {
      for (const s of shapes) {
        const b = polygonBounds(s.points);
        const minDim = Math.min(b.width, b.height);
        const maxDim = Math.max(b.width, b.height);
        if (minDim < 80 && maxDim < 200 && s.type === "fill") {
          s.type = "satin";
        }
      }
    }

    // Step 3: Stitch generation
    const result = generateStitches(shapes);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(id, result);

    // Step 4: Quality audit
    const validation = validateQuality(result.stitches);
    
    console.log(`AUDIT [${method}]: ${result.stitches.length} stitches, ${shapes.length} shapes, density ${validation.avgStitchLength}mm`);
    for (const w of validation.warnings) console.log(`  ⚠ ${w}`);

    return res.json({
      success: true, id,
      previewUrl: `/preview/${id}`,
      previewImageUrl: `/preview-image/${id}`,
      downloadUrl: `/download/${id}/dst`,
      stitchCount: result.stitches.length,
      designSize: { w: result.designW, h: result.designH },
      colors: [...new Set(shapes.map(s => toThreadColor(s.color)))],
      extraction: { method },
      audit: validation,
      shapes: result.shapes.map(s => ({ type: s.type, color: s.color, pointCount: s.points.length }))
    });

  } catch (e) {
    console.error(`Error [${reqId}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/preview/:id", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  return res.json({ stitches: data.stitches, designW: data.designW, designH: data.designH });
});

app.get("/preview-image/:id", async (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  try {
    const png = await renderStitchesToPng(data.stitches, data.designW, data.designH);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(png);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/download/:id/:format", (req, res) => {
  const data = jobs.get(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  const fmt = req.params.format || "dst";
  const { buf, ext } = encodeFile(fmt, data);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health", (_req, res) => res.json({ status: "ok", version: "15.1" }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Stichai v15.1 running on port ${PORT}`));
server.timeout = 120000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
