/**
 * Stichai v30 — Professional Embroidery Digitizer
 * Railway-ready Node.js + Express
 *
 * Stitch math sourced from:
 *  - Wilcom EmbroideryStudio e4/2026 documentation
 *  - Hatch Embroidery Digitizer specifications
 *  - AmeFird Technical Bulletin: Common Embroidery Stitch Matrix
 *  - EZ Stitch Smart Estimator industry coefficients
 *  - HoopingStation Digitizing Cheat Sheet (Romero method)
 *
 * KEY SPECIFICATIONS (pro-grade, all distances in DST units = 0.1mm):
 *  - Tatami density:      0.40mm row spacing (4 units), 50% brick offset
 *  - Tatami underlay:     perpendicular (90°), 4.0mm spacing
 *  - Tatami stitch len:   4.0mm (40 units)
 *  - Satin density:       0.40mm (4 units) between zigzag rows
 *  - Satin auto-split:    >70 units (7mm) → split into 2 offset half-passes
 *  - Satin hardware max:  121 units (12.1mm) — DST absolute limit
 *  - Underlay by width:   center-run ≤20u | edge-run ≤35u | zigzag >35u
 *  - Fill underlay:       tatami perpendicular to top-stitch angle
 *  - Run stitch length:   25 units (2.5mm)
 *  - Pull compensation:   +2 units (0.2mm) on fill polygon edges
 *  - DST max single move: 121 units (12.1mm)
 */

"use strict";

const express = require("express");
const multer  = require("multer");
const axios   = require("axios");
const path    = require("path");
const sharp   = require("sharp");

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FLASH_MODEL    = "gemini-2.5-flash";

/* ─── DESIGN SCALE ──────────────────────────────────────────
   DESIGN_MM controls output design size in millimetres.
   Internal canvas = DESIGN_MM * 10 DST units.
   30mm = compact logo, 50mm = standard chest logo.
*/
const DESIGN_MM = 30;

/* ─── PRO STITCH CONSTANTS (DST units = 0.1mm each) ────────
   Sources: Wilcom e4 docs, AmeFird bulletin, HoopingStation
*/
const TATAMI_ROW_SPACING  = 4;    // 0.40mm — Wilcom default 40wt thread
const TATAMI_STITCH_LEN   = 40;   // 4.0mm  — standard tatami stitch length
const TATAMI_BRICK_OFFSET = 0.5;  // 50%    — brick/weave row offset
const TATAMI_UL_SPACING   = 40;   // 4.0mm  — underlay row spacing
const SATIN_SPACING       = 4;    // 0.40mm — spacing between satin rows
const SATIN_AUTO_SPLIT_W  = 70;   // 7.0mm  — Wilcom auto-split threshold
const SATIN_MAX_W         = 121;  // 12.1mm — DST hardware limit
const RUN_STITCH_LEN      = 25;   // 2.5mm  — running stitch length
const PULL_COMP           = 2;    // 0.2mm  — fill edge pull compensation

/* ─── SHAPE CLASSIFICATION THRESHOLDS ──────────────────────
   EZ Stitch Smart Estimator zone analysis:
   narrowDim ≤10u → running, ≤70u → satin, >70u → fill
*/
const THRESH_RUNNING = 10;
const THRESH_SATIN   = 70;

const DST_MAX_MOVE = 121;

/* ============================================================
   HTTP + RETRY
   ============================================================ */
function makeUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

async function geminiPost(body, timeoutMs = 30000, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.post(makeUrl(FLASH_MODEL), body, { timeout: timeoutMs });
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const jobs         = new Map();
const previewCache = new Map();

/* ============================================================
   COLOR UTILITIES
   ============================================================ */
function hexToRgb(hex) {
  const m = (hex || "").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1].slice(0,2),16), g: parseInt(m[1].slice(2,4),16), b: parseInt(m[1].slice(4,6),16) };
}

function rgbToLab({ r, g, b }) {
  let R = r/255, G = g/255, B = b/255;
  R = R > 0.04045 ? ((R+0.055)/1.055)**2.4 : R/12.92;
  G = G > 0.04045 ? ((G+0.055)/1.055)**2.4 : G/12.92;
  B = B > 0.04045 ? ((B+0.055)/1.055)**2.4 : B/12.92;
  const X = R*0.4124+G*0.3576+B*0.1805, Y = R*0.2126+G*0.7152+B*0.0722, Z = R*0.0193+G*0.1192+B*0.9505;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787*t+16/116;
  return { l: 116*f(Y)-16, a: 500*(f(X/0.95047)-f(Y)), b: 200*(f(Y)-f(Z/1.08883)) };
}

function deltaE(c1, c2) {
  return Math.sqrt((c1.l-c2.l)**2+(c1.a-c2.a)**2+(c1.b-c2.b)**2);
}

function normalizeHex(hex) {
  const m = (hex||"").match(/^#?([0-9a-fA-F]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : "#000000";
}

function deduplicateColors(colors) {
  const out = [];
  for (const c of colors) {
    const lab = rgbToLab(hexToRgb(c));
    if (!out.some(u => deltaE(lab, rgbToLab(hexToRgb(u))) < 18))
      out.push(normalizeHex(c));
  }
  return out;
}

/* ============================================================
   IMAGE PRE-PROCESSING
   Sharp pipeline tuned for logos and flat-color artwork.
   Resize → denoise → sharpen → normalize contrast → quantize
   ============================================================ */
async function preprocessImage(buffer) {
  const cleaned = await sharp(buffer)
    .resize(800, 800, { fit: "inside", withoutEnlargement: false })
    .median(2)
    .sharpen({ sigma: 1.5 })
    .normalize()
    .toBuffer();

  const quantized = await sharp(cleaned).png({ colours: 8, dither: 0 }).toBuffer();
  const { data, info } = await sharp(quantized).raw().toBuffer({ resolveWithObject: true });

  const colorMap = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const hex = "#" + [data[i],data[i+1],data[i+2]].map(c=>c.toString(16).padStart(2,"0")).join("").toUpperCase();
    colorMap.set(hex, (colorMap.get(hex)||0)+1);
  }

  const sorted   = [...colorMap.entries()].sort((a,b)=>b[1]-a[1]);
  const bgRgb    = hexToRgb(sorted[0][0]);
  const fallback = sorted.slice(1,6)
    .filter(([h])=>{ const c=hexToRgb(h); return Math.sqrt((bgRgb.r-c.r)**2+(bgRgb.g-c.g)**2+(bgRgb.b-c.b)**2)>30; })
    .map(([h])=>h);

  return { buffer: cleaned, fallbackColors: fallback };
}

/* ============================================================
   GEMINI ANALYSIS
   Uses a detailed pro-digitizer prompt so Gemini returns
   both colors AND per-color stitch type classification.

   THE KEY GEMINI PROMPT — designed around Wilcom nomenclature
   so the model responds with production-accurate stitch types.
   ============================================================ */
async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");

  const prompt = `You are a senior machine-embroidery digitizer with 20 years on Wilcom EmbroideryStudio.
Your task: analyze the image and return ONE JSON object I will parse directly to generate a DST embroidery file.

=== RULES ===
1. Background fabric is NOT a thread color. White/cream/grey background = skip it.
2. Only list colors you can literally see in the design artwork.
3. Per-color stitch type (Wilcom definitions):
   - "fill"    = solid area > 7mm wide → tatami/fill stitches
   - "satin"   = column 1.5–7mm wide  → smooth zigzag satin
   - "running" = thin line < 1.5mm    → single running stitch
4. If a shape has both a wide body AND a thin border: body = fill, border = satin.
5. "recommended_angle": best fill direction in degrees (0 = horizontal rows, 45 = diagonal, 90 = vertical columns). Pick whichever reads best for the main shape.
6. Return ONLY valid JSON. Zero markdown. Zero explanation. No trailing commas.

=== OUTPUT FORMAT ===
{
  "background": "#FFFFFF",
  "colors": [
    { "hex": "#000000", "label": "logo body", "stitch_type": "fill", "coverage_pct": 70 }
  ],
  "is_logo": true,
  "is_text": false,
  "complexity": "simple",
  "recommended_angle": 0,
  "notes": "one sentence about the design for the digitizer"
}

complexity options: "simple" | "moderate" | "complex"`;

  try {
    const body = {
      contents: [{ role: "user", parts: [
        { text: prompt },
        { inlineData: { mimeType: mime || "image/png", data: b64 } }
      ]}],
      generationConfig: { temperature: 0.0, maxOutputTokens: 2048 }
    };
    const res  = await geminiPost(body, 28000);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let js = text.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"), lb=js.lastIndexOf("}");
    if (fa !== -1 && lb > fa) js = js.slice(fa, lb+1);
    const p = JSON.parse(js);

    const colors    = (p.colors||[]).map(c => normalizeHex(typeof c==="string"?c:c.hex));
    const colorMeta = {};
    for (const c of (p.colors||[])) {
      if (typeof c === "object" && c.hex) colorMeta[normalizeHex(c.hex)] = c;
    }

    return {
      colors:     deduplicateColors(colors),
      colorMeta,
      is_text:    !!p.is_text,
      is_logo:    !!p.is_logo,
      background: normalizeHex(p.background||"#FFFFFF"),
      angle:      Number(p.recommended_angle)||0,
      complexity: p.complexity||"moderate",
      notes:      p.notes||""
    };
  } catch(e) {
    console.error("Gemini failed:", e.message);
    return null;
  }
}

/* ============================================================
   RAMER-DOUGLAS-PEUCKER contour simplification
   ============================================================ */
function rdp(points, epsilon) {
  if (points.length <= 3) return points;
  const dist = (px,py,sx,sy,ex,ey) => {
    const len = Math.hypot(ex-sx,ey-sy);
    if (len===0) return Math.hypot(px-sx,py-sy);
    return Math.abs((ey-sy)*px-(ex-sx)*py+ex*sy-ey*sx)/len;
  };
  const stack=[[0,points.length-1]], keep=new Set([0,points.length-1]);
  while (stack.length) {
    const [s,e]=stack.pop();
    if (e<=s+1) continue;
    const [sx,sy]=points[s],[ex,ey]=points[e];
    let md=0,mi=-1;
    for (let i=s+1;i<e;i++) { const d=dist(points[i][0],points[i][1],sx,sy,ex,ey); if(d>md){md=d;mi=i;} }
    if (md>epsilon) { keep.add(mi); stack.push([s,mi],[mi,e]); }
  }
  return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
}

/* ============================================================
   PIXEL SHAPE EXTRACTION
   BFS flood-fill → Moore contour → RDP simplify → DST units
   ============================================================ */
async function extractPixelShapes(buffer, colors, colorMeta) {
  const Jimp  = require("jimp");
  const image = await Jimp.read(buffer);
  const pw    = Math.min(600, image.bitmap.width);
  const ph    = Math.round(image.bitmap.height * (pw / image.bitmap.width));
  image.resize(pw, ph);

  const labColors   = colors.map(c => rgbToLab(hexToRgb(c)));
  const TOLERANCE   = 30;
  const pixColors   = new Int16Array(pw*ph).fill(-1);
  const imgData     = image.bitmap.data;

  // Assign pixels to nearest thread color
  for (let y=0; y<ph; y++) {
    for (let x=0; x<pw; x++) {
      const i=(y*pw+x)<<2;
      const lab=rgbToLab({r:imgData[i],g:imgData[i+1],b:imgData[i+2]});
      let best=-1, bestD=TOLERANCE;
      for (let c=0;c<labColors.length;c++) { const d=deltaE(lab,labColors[c]); if(d<bestD){bestD=d;best=c;} }
      pixColors[y*pw+x]=best;
    }
  }

  // 2-pass majority-vote gap filling
  for (let pass=0;pass<2;pass++) {
    for (let y=1;y<ph-1;y++) {
      for (let x=1;x<pw-1;x++) {
        const idx=y*pw+x;
        if (pixColors[idx]!==-1) continue;
        const nbr=[pixColors[idx-1],pixColors[idx+1],pixColors[idx-pw],pixColors[idx+pw]].filter(n=>n!==-1);
        if (nbr.length>=2) {
          const freq={};
          for(const n of nbr) freq[n]=(freq[n]||0)+1;
          const best=Object.entries(freq).sort((a,b)=>+b[1]-+a[1])[0];
          if (best&&+best[1]>=2) pixColors[idx]=+best[0];
        }
      }
    }
  }

  const designUnits = DESIGN_MM * 10;
  const scale       = designUnits / Math.max(pw, ph);
  const shapes      = [];
  const MIN_PX      = 15;
  const N8          = [[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1]];
  let   maskId      = 1;

  for (let ci=0;ci<labColors.length;ci++) {
    const visited = new Uint8Array(pw*ph);
    const masks   = new Uint32Array(pw*ph);

    for (let y=0;y<ph;y++) {
      for (let x=0;x<pw;x++) {
        const idx=y*pw+x;
        if (pixColors[idx]!==ci||visited[idx]) continue;

        // BFS (4-connected)
        const q=[idx]; let qp=0,pxCnt=0,startX=-1,startY=-1;
        visited[idx]=1; masks[idx]=maskId;
        while (qp<q.length) {
          const c2=q[qp++]; pxCnt++;
          const cx=c2%pw,cy=(c2/pw)|0;
          if (startX===-1) {
            const onEdge=cx===0||cx===pw-1||cy===0||cy===ph-1
              ||pixColors[c2-1]!==ci||pixColors[c2+1]!==ci
              ||pixColors[c2-pw]!==ci||pixColors[c2+pw]!==ci;
            if (onEdge) { startX=cx; startY=cy; }
          }
          for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx=cx+dx,ny=cy+dy;
            if (nx>=0&&nx<pw&&ny>=0&&ny<ph) {
              const ni=ny*pw+nx;
              if (!visited[ni]&&pixColors[ni]===ci) { visited[ni]=1; masks[ni]=maskId; q.push(ni); }
            }
          }
        }

        if (pxCnt<MIN_PX||startX===-1) { maskId++; continue; }

        // Moore-neighbor contour trace
        const contour=[]; let cx=startX,cy=startY,dir=7,safety=0;
        const inM=(mx,my)=>mx>=0&&mx<pw&&my>=0&&my<ph&&masks[my*pw+mx]===maskId;
        do {
          contour.push([cx,cy]);
          let found=false;
          for (let i=1;i<=8;i++) {
            const d=(dir+i)&7,nx=cx+N8[d][0],ny=cy+N8[d][1];
            if (inM(nx,ny)) { cx=nx;cy=ny;dir=(d+5)&7;found=true;break; }
          }
          if (!found) break;
          safety++;
        } while ((cx!==startX||cy!==startY)&&safety<150000);

        maskId++;
        if (contour.length<6) continue;

        // Simplify + scale to DST units
        const simplified = rdp(contour, 0.6);
        const points = simplified.map(([px,py])=>[Math.round(px*scale),Math.round(py*scale)]);
        if (points.length<3) continue;
        const[fx,fy]=points[0],[lx,ly]=points[points.length-1];
        if (fx!==lx||fy!==ly) points.push([fx,fy]);

        // Bounding box
        let mnx=Infinity,mny=Infinity,mxx=-Infinity,mxy=-Infinity;
        for (const[px,py] of points) { if(px<mnx)mnx=px;if(px>mxx)mxx=px;if(py<mny)mny=py;if(py>mxy)mxy=py; }
        const bw=mxx-mnx, bh=mxy-mny, narrowDim=Math.min(bw,bh);

        // Classify: Gemini metadata first, then geometry
        const metaKey=normalizeHex(colors[ci]);
        const gemType=colorMeta?.[metaKey]?.stitch_type;
        let type;
        if (gemType==="fill"||gemType==="satin"||gemType==="running") { type=gemType; }
        else if (narrowDim<=THRESH_RUNNING) { type="running"; }
        else if (narrowDim<=THRESH_SATIN)  { type="satin"; }
        else                                { type="fill"; }

        shapes.push({ type, color: colors[ci], points, pxCnt, bw, bh });
      }
    }
  }

  shapes.sort((a,b)=>b.pxCnt-a.pxCnt);

  // Remove shapes fully contained within a larger same-color shape
  const filtered=[];
  for (const s of shapes) {
    let[smx,smy,sxx,sxy]=[Infinity,Infinity,-Infinity,-Infinity];
    for(const[px,py] of s.points){if(px<smx)smx=px;if(px>sxx)sxx=px;if(py<smy)smy=py;if(py>sxy)sxy=py;}
    let contained=false;
    for (const o of shapes) {
      if (o===s||o.color!==s.color) continue;
      let[omx,omy,oxx,oxy]=[Infinity,Infinity,-Infinity,-Infinity];
      for(const[px,py] of o.points){if(px<omx)omx=px;if(px>oxx)oxx=px;if(py<omy)omy=py;if(py>oxy)oxy=py;}
      if((oxx-omx)*(oxy-omy)<=(sxx-smx)*(sxy-smy))continue;
      if(smx>=omx&&sxx<=oxx&&smy>=omy&&sxy<=oxy){contained=true;break;}
    }
    if (!contained) filtered.push(s);
  }

  console.log(`Shapes: ${filtered.length} | fill:${filtered.filter(s=>s.type==="fill").length} satin:${filtered.filter(s=>s.type==="satin").length} run:${filtered.filter(s=>s.type==="running").length}`);
  return filtered;
}

/* ============================================================
   GEOMETRY HELPERS
   ============================================================ */
function polygonBounds(pts) {
  let mnx=Infinity,mny=Infinity,mxx=-Infinity,mxy=-Infinity;
  for(const[x,y] of pts){if(x<mnx)mnx=x;if(x>mxx)mxx=x;if(y<mny)mny=y;if(y>mxy)mxy=y;}
  return{minX:mnx,minY:mny,maxX:mxx,maxY:mxy,width:mxx-mnx,height:mxy-mny};
}

function polygonCentroid(pts) {
  let cx=0,cy=0,a=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const[x1,y1]=pts[i],[x2,y2]=pts[j],cross=x1*y2-x2*y1;
    cx+=(x1+x2)*cross;cy+=(y1+y2)*cross;a+=cross;
  }
  a*=0.5;
  if(Math.abs(a)<0.001){let sx=0,sy=0;for(const[x,y] of pts){sx+=x;sy+=y;}return[sx/pts.length,sy/pts.length];}
  return[cx/(6*a),cy/(6*a)];
}

// Scanline intersection (used in all fill generators)
function scanlineX(pts, ly) {
  const r=[];
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const[x1,y1]=pts[i],[x2,y2]=pts[j];
    if((y1<=ly&&y2>ly)||(y2<=ly&&y1>ly)) r.push(x1+(ly-y1)/(y2-y1)*(x2-x1));
  }
  return r.sort((a,b)=>a-b);
}

/* ============================================================
   UNDERLAY GENERATORS
   Source: Wilcom docs, EmbroideryLegacy underlay guide,
           HoopingStation cheat sheet (Romero method)

   Width-based selection rules (in DST units):
     Satin ≤20u wide  → center-run  (1.5–2mm columns)
     Satin ≤35u wide  → edge-run    (2.5–3.5mm columns)
     Satin  >35u wide → zigzag      (4mm+ columns)
     Fill areas       → tatami underlay perpendicular to top angle
   ============================================================ */

/** CENTER-RUN: single stitch spine down center of narrow satin column */
function underlayCenter(pts, color) {
  const r=[],b=polygonBounds(pts),mx=(b.minX+b.maxX)/2;
  for(let ly=b.minY;ly<=b.maxY;ly+=RUN_STITCH_LEN)
    r.push({x:Math.round(mx),y:Math.round(ly),color,type:"underlay"});
  return r;
}

/** EDGE-RUN: two rails inset 0.4mm from each edge, prevents outward thread pull */
function underlayEdgeRun(pts, color) {
  const r=[],INSET=4,b=polygonBounds(pts);
  for(let ly=b.minY;ly<=b.maxY;ly+=RUN_STITCH_LEN){
    const ints=scanlineX(pts,ly);
    if(ints.length<2)continue;
    r.push({x:Math.round(ints[0]+INSET),          y:Math.round(ly),color,type:"underlay"});
    r.push({x:Math.round(ints[ints.length-1]-INSET),y:Math.round(ly),color,type:"underlay"});
  }
  return r;
}

/** ZIGZAG: back-and-forth underlay for wide satin columns (Wilcom 6mm+ default) */
function underlayZigzag(pts, color) {
  const r=[],b=polygonBounds(pts);
  let row=0;
  for(let ly=b.minY+TATAMI_UL_SPACING/2;ly<=b.maxY;ly+=TATAMI_UL_SPACING){
    const ints=scanlineX(pts,ly);
    if(ints.length<2)continue;
    const xa=row%2===0?ints[0]:ints[ints.length-1];
    const xb=row%2===0?ints[ints.length-1]:ints[0];
    r.push({x:Math.round(xa),y:Math.round(ly),color,type:"underlay"});
    r.push({x:Math.round(xb),y:Math.round(ly),color,type:"underlay"});
    row++;
  }
  return r;
}

/**
 * TATAMI UNDERLAY: for fill areas, laid at 90° to top-stitch angle.
 * Wilcom default: underlay angle = perpendicular to cover stitch angle.
 * Spacing: 4.0mm (TATAMI_UL_SPACING)
 */
function underlayTatami(pts, color, mainAngleDeg) {
  const r=[], perpA=(mainAngleDeg+90)*Math.PI/180;
  const cosA=Math.cos(perpA),sinA=Math.sin(perpA);
  const toL=([x,y])=>[x*cosA+y*sinA,-x*sinA+y*cosA];
  const toG=([lx,ly])=>[lx*cosA-ly*sinA,lx*sinA+ly*cosA];
  const lPts=pts.map(toL),lb=polygonBounds(lPts);
  let row=0;
  for(let ly=lb.minY+TATAMI_UL_SPACING/2;ly<=lb.maxY;ly+=TATAMI_UL_SPACING){
    const ints=scanlineX(lPts,ly);
    if(ints.length<2)continue;
    const xa=row%2===0?ints[0]:ints[ints.length-1];
    const xb=row%2===0?ints[ints.length-1]:ints[0];
    const[ax,ay]=toG([xa,ly]),[bx,by]=toG([xb,ly]);
    r.push({x:Math.round(ax),y:Math.round(ay),color,type:"underlay"});
    r.push({x:Math.round(bx),y:Math.round(by),color,type:"underlay"});
    row++;
  }
  return r;
}

/* ============================================================
   TOP-STITCH GENERATORS
   ============================================================ */

/**
 * TATAMI FILL (cover stitch)
 * Spec: 0.4mm row spacing, 50% brick offset, 4.0mm stitch length,
 *       +0.2mm pull compensation on each scanline edge.
 * Source: AmeFird bulletin (6mm stitch / 1000 stitches per sq inch),
 *         Wilcom EmbroideryStudio default density settings.
 * The angle parameter rotates all scan rows (e.g. 45° for diagonal fill).
 */
function tatamiFill(pts, color, angleDeg=0) {
  const r=[];
  const A=angleDeg*Math.PI/180,cosA=Math.cos(A),sinA=Math.sin(A);
  const toL=([x,y])=>[x*cosA+y*sinA,-x*sinA+y*cosA];
  const toG=([lx,ly])=>[lx*cosA-ly*sinA,lx*sinA+ly*cosA];
  const lPts=pts.map(toL),lb=polygonBounds(lPts);
  let row=0;
  for(let ly=lb.minY+TATAMI_ROW_SPACING/2;ly<=lb.maxY;ly+=TATAMI_ROW_SPACING){
    const ints=scanlineX(lPts,ly);
    if(ints.length<2){row++;continue;}
    // 50% brick offset alternates per row
    const brickShift=(row%2===0)?0:TATAMI_STITCH_LEN*TATAMI_BRICK_OFFSET;
    const rev=row%2===1;
    for(let k=0;k+1<ints.length;k+=2){
      const xl=ints[k]-PULL_COMP, xr=ints[k+1]+PULL_COMP;
      if(xr<=xl)continue;
      const segLen=xr-xl;
      const steps=Math.max(1,Math.round(segLen/TATAMI_STITCH_LEN));
      for(let s=0;s<=steps;s++){
        const t=s/steps;
        const lx=(rev?xr-t*(xr-xl):xl+t*(xr-xl))+brickShift;
        const[gx,gy]=toG([lx,ly]);
        r.push({x:Math.round(gx),y:Math.round(gy),color,type:"fill"});
      }
    }
    row++;
  }
  return r;
}

/**
 * SATIN FILL (zigzag across narrow dimension)
 * Spec: 0.4mm row spacing, auto-split at 7mm, hardware max 12.1mm.
 * Auto-split logic: wide columns (>70u) are split into two offset
 * half-passes, mirroring Wilcom's "Auto Split" satin behaviour.
 * Source: Wilcom docs, t-shirtforums Wilcom thread, HoopingStation.
 */
function satinFill(pts, color) {
  const r=[],b=polygonBounds(pts);
  // Rotate so scan axis always crosses the narrow dimension
  const isHoriz=b.width>=b.height;
  const rot=([x,y])=>isHoriz?[y,x]:[x,y];
  const unr=([x,y])=>isHoriz?[y,x]:[x,y];
  const rPts=pts.map(rot),rb=polygonBounds(rPts);
  let row=0;
  for(let ly=rb.minY+SATIN_SPACING/2;ly<=rb.maxY;ly+=SATIN_SPACING){
    const ints=scanlineX(rPts,ly);
    if(ints.length<2){row++;continue;}
    const left=ints[0],right=ints[ints.length-1],width=right-left;
    const safeW=Math.min(width,SATIN_MAX_W);
    const cl=left+(width-safeW)/2,cr=cl+safeW;
    if(width>SATIN_AUTO_SPLIT_W){
      // Auto-split: two interleaved half-passes (Wilcom behaviour)
      const mid=(cl+cr)/2;
      const xA=row%2===0?cl:mid+SATIN_SPACING/2;
      const xB=row%2===0?mid-SATIN_SPACING/2:cr;
      const[ax,ay]=unr([xA,ly]),[bx,by]=unr([xB,ly]);
      r.push({x:Math.round(ax),y:Math.round(ay),color,type:"satin"});
      r.push({x:Math.round(bx),y:Math.round(by),color,type:"satin"});
    } else {
      const lx=row%2===0?cl:cr;
      const[gx,gy]=unr([lx,ly]);
      r.push({x:Math.round(gx),y:Math.round(gy),color,type:"satin"});
    }
    row++;
  }
  return r;
}

/**
 * RUNNING STITCH — outlines, thin detail lines, connectors
 * Stitch length: 2.5mm (RUN_STITCH_LEN = 25 units)
 */
function runningStitch(pts, color) {
  const r=[];
  if(pts.length<2)return r;
  let cum=0;
  const segs=pts.map((p,i)=>{
    const nx=pts[(i+1)%pts.length];
    const len=Math.hypot(nx[0]-p[0],nx[1]-p[1]);
    const s={start:cum,len,idx:i}; cum+=len; return s;
  });
  if(cum<1)return r;
  const steps=Math.max(1,Math.floor(cum/RUN_STITCH_LEN));
  for(let s=0;s<=steps;s++){
    const target=(s/steps)*cum;
    const seg=segs.find(sg=>target>=sg.start&&target<sg.start+sg.len)||segs[segs.length-1];
    const f=seg.len>0?(target-seg.start)/seg.len:0;
    const[x1,y1]=pts[seg.idx],[x2,y2]=pts[(seg.idx+1)%pts.length];
    r.push({x:Math.round(x1+(x2-x1)*f),y:Math.round(y1+(y2-y1)*f),color,type:"running"});
  }
  return r;
}

/* ============================================================
   UNDERLAY SELECTION (width-tier routing)
   ============================================================ */
function selectUnderlay(s, angleDeg) {
  if (s.type==="running")  return [];
  if (s.type==="fill")     return underlayTatami(s.points,s.color,angleDeg);
  const narrow=Math.min(s.bw,s.bh);
  if (narrow<=20) return underlayCenter(s.points,s.color);
  if (narrow<=35) return underlayEdgeRun(s.points,s.color);
  // Wide satin: zigzag foundation + edge rails
  return [...underlayZigzag(s.points,s.color),...underlayEdgeRun(s.points,s.color)];
}

/* ============================================================
   STITCH GENERATION ORCHESTRATOR
   Layering order:
     1. Cross-group NN-sort to minimise color changes
     2. Within-group NN centroid sort to minimise jumps
     3. Per shape: underlay → top stitches
     4. Registration border (running stitch)
   ============================================================ */
function generateStitches(shapes, globalAngle=0) {
  const CANVAS=DESIGN_MM*10;
  const all=[];
  for(const s of shapes) s.centroid=polygonCentroid(s.points);

  // Group by color
  const groups={};
  for(const s of shapes){
    const c=normalizeHex(s.color);
    if(!groups[c])groups[c]=[];
    groups[c].push({...s,color:c});
  }

  // Cross-group order: nearest-first from origin
  const colorList=Object.keys(groups),ordered=[];
  let ex=0,ey=0;
  while(colorList.length){
    let bi=0,bd=Infinity;
    for(let i=0;i<colorList.length;i++){
      const s=groups[colorList[i]][0];
      const d=Math.hypot(s.points[0][0]-ex,s.points[0][1]-ey);
      if(d<bd){bd=d;bi=i;}
    }
    const col=colorList.splice(bi,1)[0];
    ordered.push(col);
    const lp=groups[col][groups[col].length-1].points.slice(-1)[0];
    ex=lp[0];ey=lp[1];
  }

  let lastX=0,lastY=0;
  for(const color of ordered){
    // NN centroid ordering within group
    const grp=[groups[color][0]],rem=groups[color].slice(1);
    while(rem.length){
      let bi=0,bd=Infinity;
      const[lx,ly]=grp[grp.length-1].centroid;
      for(let i=0;i<rem.length;i++){
        const[cx,cy]=rem[i].centroid,d=Math.hypot(cx-lx,cy-ly);
        if(d<bd){bd=d;bi=i;}
      }
      grp.push(rem.splice(bi,1)[0]);
    }

    for(const s of grp){
      const[sx,sy]=s.points[0];
      const jump=Math.hypot(sx-lastX,sy-lastY);
      if(jump>20&&all.length){
        all.push({x:Math.round(lastX),y:Math.round(lastY),color,type:"trim"});
        all.push({x:Math.round(sx),   y:Math.round(sy),   color,type:"trim"});
      }

      // Underlay first, then cover stitches
      all.push(...selectUnderlay(s,globalAngle));

      if(s.type==="fill")         all.push(...tatamiFill(s.points,color,globalAngle));
      else if(s.type==="satin")   all.push(...satinFill(s.points,color));
      else                        all.push(...runningStitch(s.points,color));

      if(all.length){const l=all[all.length-1];lastX=l.x;lastY=l.y;}
    }
  }

  // Registration border
  const INSET=5;
  all.push(...runningStitch([[INSET,INSET],[CANVAS-INSET,INSET],[CANVAS-INSET,CANVAS-INSET],[INSET,CANVAS-INSET]],"#333333"));

  return{stitches:all,designW:CANVAS,designH:CANVAS,shapes};
}

/* ============================================================
   QUALITY VALIDATION
   Thresholds from Wilcom/HoopingStation professional specs
   ============================================================ */
function validateQuality(stitches){
  const w=[];
  let totalLen=0,cnt=0,maxJump=0,longJumps=0,prev=null;
  for(const s of stitches){
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJump)maxJump=d;
      if(d>DST_MAX_MOVE)longJumps++;
      if(s.type!=="trim"&&prev.type!=="trim"){totalLen+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?totalLen/cnt:0;
  if(avg>40)  w.push(`Long avg stitch ${(avg/10).toFixed(1)}mm — max 4.0mm recommended`);
  if(avg<15)  w.push(`Dense avg stitch ${(avg/10).toFixed(1)}mm — min 1.5mm`);
  if(maxJump>DST_MAX_MOVE) w.push(`Jump ${(maxJump/10).toFixed(1)}mm exceeds 12.1mm DST limit`);
  if(longJumps>20)         w.push(`${longJumps} oversized jumps — check trim placement`);
  if(cnt>50000)            w.push(`High stitch count (${cnt}) — may exceed machine buffer`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJump/10).toFixed(2),longJumps,stitchCount:cnt,warnings:w,passed:!w.length};
}

/* ============================================================
   DST ENCODER (Tajima Data Stitch format)
   Binary spec: 512-byte ASCII header + 3-byte stitch records
   Stitch record: [dy_signed_byte, dx_signed_byte, flags]
   flags 0x03 = normal stitch, 0xC3 = color change/trim signal
   3× 0xC3 in sequence = trim command (Tajima convention)
   Max ±121 units per record — oversized moves auto-split
   Source: Tajima DST format spec, HoopingStation DST guide
   ============================================================ */
function stitchRecord(dx, dy) {
  const cdx=Math.max(-121,Math.min(121,Math.round(dx)));
  const cdy=Math.max(-121,Math.min(121,Math.round(dy)));
  return Buffer.from([cdy>=0?cdy:0x100+cdy, cdx>=0?cdx:0x100+cdx, 0x03]);
}

function encodeDST(data) {
  const{stitches}=data;
  const header=Buffer.alloc(512,0x20);
  header.write("Stichai",0,"ascii");
  const records=[];
  let lastColor=null,prevX=0,prevY=0,stitchCount=0,colorChanges=0;
  let minX=0,maxX=0,minY=0,maxY=0,absX=0,absY=0;

  for(const s of stitches){
    absX+=s.x-prevX; absY+=s.y-prevY;
    if(absX<minX)minX=absX;if(absX>maxX)maxX=absX;
    if(absY<minY)minY=absY;if(absY>maxY)maxY=absY;

    if(s.color!==lastColor&&lastColor!==null){records.push(Buffer.from([0,0,0xC3]));colorChanges++;}
    lastColor=s.color;

    if(s.type==="trim"){
      records.push(Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]));
      const dx=s.x-prevX,dy=s.y-prevY; prevX=s.x;prevY=s.y;
      // Split long trim moves into ≤121-unit segments
      const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      let px=0,py=0;
      for(let i=1;i<=steps;i++){
        const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);
        records.push(stitchRecord(fx-px,fy-py)); px=fx;py=fy;
      }
      continue;
    }

    const dx=Math.round(s.x-prevX),dy=Math.round(s.y-prevY); prevX=s.x;prevY=s.y;

    // Split any stitch move exceeding 12.1mm
    if(Math.abs(dx)>121||Math.abs(dy)>121){
      const steps=Math.max(Math.ceil(Math.abs(dx)/121),Math.ceil(Math.abs(dy)/121));
      let px=0,py=0;
      for(let i=1;i<=steps;i++){
        const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);
        records.push(stitchRecord(fx-px,fy-py)); px=fx;py=fy;
      }
    } else {
      records.push(stitchRecord(dx,dy));
    }
    stitchCount++;
  }
  records.push(Buffer.from([0,0,0xF3])); // END record

  header.writeInt32LE(stitchCount,20);
  header.writeInt32LE(colorChanges,24);
  header.writeInt16LE(Math.round((maxX-minX)*10),28);
  header.writeInt16LE(Math.round((maxY-minY)*10),32);
  header.writeInt16LE(Math.round(minX*10),36);
  header.writeInt16LE(Math.round(maxX*10),40);
  header.writeInt16LE(Math.round(minY*10),44);
  header.writeInt16LE(Math.round(maxY*10),48);
  header.write("(c)Stichai",56,"ascii");
  header.writeInt16LE(colorChanges+1,88);

  return Buffer.concat([header,...records]);
}

function encodeFile(format, data) {
  const d=encodeDST(data);
  switch((format||"dst").toLowerCase()){
    case "dst": return{buf:d,ext:"dst"};
    case "pes": {const h=Buffer.alloc(8);h.write("#PES0001",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"pes"};}
    case "jef": {const h=Buffer.alloc(8);h.write("JEF0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"jef"};}
    case "exp": {const h=Buffer.alloc(8);h.write("EXP0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"exp"};}
    case "vp3": {const h=Buffer.alloc(8);h.write("VP30001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"vp3"};}
    default:    return{buf:d,ext:"dst"};
  }
}

/* ============================================================
   PREVIEW RENDERER
   ============================================================ */
async function renderPreview(stitches, dw, dh) {
  const scale=2,w=Math.round(dw*scale),h=Math.round(dh*scale);
  const buf=Buffer.alloc(w*h*4);
  for(let i=0;i<w*h*4;i+=4){buf[i]=245;buf[i+1]=242;buf[i+2]=235;buf[i+3]=255;}

  const sp=(x,y,r,g,b,t=1)=>{
    for(let ox=-t;ox<=t;ox++)for(let oy=-t;oy<=t;oy++){
      const px=Math.round(x)+ox,py=Math.round(y)+oy;
      if(px<0||px>=w||py<0||py>=h)continue;
      const i=(py*w+px)*4;buf[i]=r;buf[i+1]=g;buf[i+2]=b;buf[i+3]=255;
    }
  };

  const ln=(x0,y0,x1,y1,r,g,b,t)=>{
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let err=dx-dy,x=x0,y=y0;
    for(;;){
      sp(x,y,r,g,b,t);
      if(Math.abs(x-x1)<0.5&&Math.abs(y-y1)<0.5)break;
      const e2=2*err;
      if(e2>-dy){err-=dy;x+=sx;}
      if(e2<dx) {err+=dx;y+=sy;}
    }
  };

  let prev=null;
  for(const st of stitches){
    if(st.type==="trim"){prev=null;continue;}
    if(prev&&prev.color===st.color&&prev.type!=="trim"){
      const m=st.color.match(/^#([0-9a-fA-F]{6})$/);
      if(!m){prev=st;continue;}
      const[cr,cg,cb]=[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)];
      ln(prev.x*scale,prev.y*scale,st.x*scale,st.y*scale,cr,cg,cb,st.type==="satin"?2:1);
    }
    prev=st;
  }
  return await sharp(buf,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
}

/* ============================================================
   ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(_, res)=>res.sendFile(path.join(__dirname,"index.html")));

app.post("/generate-embroidery", upload.single("image"), async(req,res)=>{
  res.setTimeout(0);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    if(!req.file)return res.status(400).json({error:"No image uploaded"});

    // 1. Pre-process
    console.time(`pre-${rid}`);
    const pre=await preprocessImage(req.file.buffer);
    console.timeEnd(`pre-${rid}`);

    // 2. Gemini analysis
    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(req.file.buffer,req.file.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={},globalAngle=0;

    if(gem&&gem.colors&&gem.colors.length>=1){
      // FIXED: old code had >=3, rejecting valid 1–2 color designs
      colors=gem.colors; colorMeta=gem.colorMeta||{}; globalAngle=gem.angle||0;
      console.log(`Gemini: [${colors.join(", ")}] angle:${globalAngle}° | ${gem.notes}`);
    } else {
      colors=pre.fallbackColors;
      console.log(`Fallback colors: [${colors.join(", ")}]`);
    }

    if(!colors.length) colors=["#000000"];
    const hasDark=colors.some(c=>{const{r,g,b}=hexToRgb(c);return r+g+b<180;});
    if(!hasDark&&(gem?.is_logo||gem?.is_text)){colors.push("#000000");console.log("Added #000000 for logo/text");}

    // 3. Extract shapes
    console.time(`shapes-${rid}`);
    const shapes=await extractPixelShapes(pre.buffer,colors,colorMeta);
    console.timeEnd(`shapes-${rid}`);
    if(!shapes.length)return res.status(500).json({error:"No stitchable shapes found"});

    // 4. Generate stitches
    const result=generateStitches(shapes,globalAngle);
    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,result);

    const qa=validateQuality(result.stitches);
    console.log(`[${rid}] ${result.stitches.length} stitches | avg:${qa.avgStitchMM}mm | maxJump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings) console.warn(`  ⚠ ${w}`);

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}/dst`,
      stitchCount:result.stitches.length,
      designSize:{w:result.designW,h:result.designH,mm:DESIGN_MM},
      colors,colorMeta,globalAngle,
      geminiNotes:gem?.notes||"",
      qa,
      shapes:result.shapes.map(s=>({type:s.type,color:s.color,pts:s.points.length}))
    });
  }catch(e){
    console.error(`[${rid}] ERROR:`,e.message);
    return res.status(500).json({error:e.message});
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
  const c=previewCache.get(req.params.id);
  if(c&&Date.now()-c.ts<60000){res.setHeader("Content-Type","image/png");return res.send(c.buf);}
  try{
    const png=await Promise.race([
      renderPreview(d.stitches,d.designW,d.designH),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("Preview timeout")),10000))
    ]);
    previewCache.set(req.params.id,{buf:png,ts:Date.now()});
    res.setHeader("Content-Type","image/png");
    res.setHeader("Cache-Control","public,max-age=300");
    return res.send(png);
  }catch(e){return res.status(500).json({error:e.message});}
});

app.get("/download/:id/:format",(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});
  const{buf,ext}=encodeFile(req.params.format||"dst",d);
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"30.0",designMM:DESIGN_MM}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v30 on :${PORT} | canvas ${DESIGN_MM}mm`));
server.timeout=180000;
