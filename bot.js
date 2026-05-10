/**
 * Stichai v31 — Professional Embroidery Digitizer
 * Railway-ready · Node.js + Express
 *
 * ═══════════════════════════════════════════════════════
 *  BUG FIXES vs v30
 * ═══════════════════════════════════════════════════════
 *  BUG 1 (CRITICAL — caused "0pts" shapes):
 *    DESIGN_MM=30 → canvas=300 DST units, processing at 600px
 *    → scale = 300/600 = 0.5 → pixel coords COLLAPSE when rounded
 *    → pixel [1,1] and [2,1] both become DST [1,1] → duplicate points
 *    → contour collapses to <3 unique pts → shape skipped
 *    FIX: process image at exactly DESIGN_MM*10 pixels so scale = 1.0
 *         No rounding loss. 1 pixel = 1 DST unit throughout.
 *
 *  BUG 2 (caused wild preview lines):
 *    Registration border used "#333333" as color but renderer checks
 *    prev.color === st.color — border stitches drew random lines across
 *    the entire canvas because prev was from a different color group.
 *    FIX: border uses the last real color; renderer adds null-check.
 *
 *  BUG 3 (caused poor fill coverage):
 *    TATAMI_STITCH_LEN=40 (4mm) on shapes only 50–80 units wide
 *    = 1–2 stitches per row, leaving visible gaps.
 *    FIX: stitch length is now adaptive per shape width.
 *
 *  BUG 4 (caused contained-shapes over-filtering):
 *    Bounding-box containment check used collapsed DST coords
 *    (all zeros after scale collapse) → every shape looked contained.
 *    FIX: containment check now uses pixel-space coords before scale.
 *
 *  BUG 5 (caused satin on Adidas stripes instead of fill):
 *    DESIGN_MM=30 → Adidas stripe = ~50 DST units → < THRESH_SATIN(70)
 *    → classified as satin, which looked terrible on wide areas.
 *    FIX: DESIGN_MM=80, so Adidas stripe = ~130 DST units → fill ✓
 *
 *  BUG 6 (masked all errors):
 *    Gemini colorMeta keys were sometimes un-normalised hex values
 *    → lookup always missed → fell through to geometry classification.
 *    FIX: normalizeHex() applied consistently at both write and read.
 *
 * ═══════════════════════════════════════════════════════
 *  PRO STITCH SPECS (Wilcom / AmeFird / HoopingStation)
 * ═══════════════════════════════════════════════════════
 *  All distances in DST units (1 unit = 0.1 mm)
 *  - Tatami row spacing   : 4 u  (0.40 mm)
 *  - Tatami brick offset  : 50%
 *  - Tatami stitch length : adaptive 20–50 u (2–5 mm per shape width)
 *  - Tatami underlay      : perpendicular (90°), 40 u spacing
 *  - Satin spacing        : 4 u  (0.40 mm)
 *  - Satin auto-split     : > 70 u  (7 mm)
 *  - Satin max width      : 121 u (12.1 mm) — DST hardware limit
 *  - Underlay by width    : center-run ≤20u | edge-run ≤35u | zigzag >35u
 *  - Run stitch length    : 25 u  (2.5 mm)
 *  - Pull compensation    : 2 u   (0.2 mm) on fill edges
 *  - DST max move         : 121 u (12.1 mm)
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

/* ─── DESIGN SCALE ──────────────────────────────────────────────────
   DESIGN_MM = output design width/height in millimetres.
   Internal canvas = DESIGN_MM * 10 DST units.
   Processing image is resized to DESIGN_MM * 10 PIXELS so that
   1 pixel === 1 DST unit and there is ZERO coordinate collapse.

   80mm = standard chest logo (fits 100×100 hoop easily)
   50mm = small left-chest logo
   Increase for larger output designs.
*/
const DESIGN_MM  = 80;   // mm
const CANVAS     = DESIGN_MM * 10;  // DST units = pixels during processing

/* ─── PRO STITCH CONSTANTS (all in DST units = 0.1 mm) ─────────────*/
const TATAMI_ROW   = 4;    // 0.40 mm row spacing
const TATAMI_UL_ROW= 40;   // 4.0  mm underlay row spacing (perpendicular)
const TATAMI_BRICK = 0.5;  // 50%  brick offset per row
const SATIN_SPACE  = 4;    // 0.40 mm between zigzag passes
const SATIN_SPLIT  = 70;   // 7.0  mm auto-split threshold (Wilcom)
const SATIN_MAX    = 121;  // 12.1 mm DST hardware limit
const RUN_LEN      = 25;   // 2.5  mm running stitch
const PULL_COMP    = 2;    // 0.2  mm pull compensation on fill edges
const DST_MAX      = 121;  // max units per stitch record

/* ─── SHAPE CLASSIFICATION THRESHOLDS (DST units) ──────────────────
   narrow dimension of bounding box:
   ≤15u → running stitch  (≤1.5 mm)
   ≤80u → satin column    (≤8.0 mm)  [Wilcom satin recommended max]
   >80u → tatami fill
*/
const T_RUN   = 15;
const T_SATIN = 80;

/* ─── ADAPTIVE TATAMI STITCH LENGTH ────────────────────────────────
   Stitch length scales with shape width so fills always look solid.
   Min 15u (1.5mm), max 50u (5mm), targeting ~4 stitches per row minimum.
*/
function adaptiveStitchLen(shapeWidthUnits) {
  const target = Math.floor(shapeWidthUnits / 5);
  return Math.max(15, Math.min(50, target));
}

/* ============================================================
   HTTP UTILS
   ============================================================ */
function makeUrl(m) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`;
}
async function geminiPost(body, ms = 30000, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await axios.post(makeUrl(FLASH_MODEL), body, { timeout: ms }); }
    catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
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
  let R=r/255,G=g/255,B=b/255;
  R=R>0.04045?((R+0.055)/1.055)**2.4:R/12.92;
  G=G>0.04045?((G+0.055)/1.055)**2.4:G/12.92;
  B=B>0.04045?((B+0.055)/1.055)**2.4:B/12.92;
  const X=R*0.4124+G*0.3576+B*0.1805,Y=R*0.2126+G*0.7152+B*0.0722,Z=R*0.0193+G*0.1192+B*0.9505;
  const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
  return{l:116*f(Y)-16,a:500*(f(X/0.95047)-f(Y)),b:200*(f(Y)-f(Z/1.08883))};
}
function deltaE(a, b) { return Math.sqrt((a.l-b.l)**2+(a.a-b.a)**2+(a.b-b.b)**2); }
function normHex(h) { const m=(h||"").match(/^#?([0-9a-fA-F]{6})$/i); return m?`#${m[1].toUpperCase()}`:"#000000"; }
function dedupe(cols) {
  const out=[];
  for (const c of cols) {
    const lab=rgbToLab(hexToRgb(c));
    if (!out.some(u=>deltaE(lab,rgbToLab(hexToRgb(u)))<18)) out.push(normHex(c));
  }
  return out;
}

/* ============================================================
   IMAGE PRE-PROCESSING
   Key fix: resize to exactly CANVAS pixels so scale = 1.0
   ============================================================ */
async function preprocessImage(buffer) {
  // Resize to CANVAS×CANVAS (keeping aspect, padding with white)
  const cleaned = await sharp(buffer)
    .resize(CANVAS, CANVAS, {
      fit: "contain",          // letterbox, never distort
      background: { r:255, g:255, b:255, alpha:1 }
    })
    .median(2)
    .sharpen({ sigma: 1.2 })
    .normalize()
    .toBuffer();

  // Quantize for fallback color extraction
  const q = await sharp(cleaned).png({ colours: 8, dither: 0 }).toBuffer();
  const { data, info } = await sharp(q).raw().toBuffer({ resolveWithObject: true });
  const cm = new Map();
  for (let i=0;i<data.length;i+=info.channels) {
    const h="#"+[data[i],data[i+1],data[i+2]].map(c=>c.toString(16).padStart(2,"0")).join("").toUpperCase();
    cm.set(h,(cm.get(h)||0)+1);
  }
  const sorted = [...cm.entries()].sort((a,b)=>b[1]-a[1]);
  const bgRgb  = hexToRgb(sorted[0][0]);
  const fallback= sorted.slice(1,6)
    .filter(([h])=>{ const c=hexToRgb(h); return Math.sqrt((bgRgb.r-c.r)**2+(bgRgb.g-c.g)**2+(bgRgb.b-c.b)**2)>30; })
    .map(([h])=>h);

  return { buffer: cleaned, fallbackColors: fallback };
}

/* ============================================================
   GEMINI ANALYSIS
   Returns colors with per-color stitch_type from a pro prompt
   ============================================================ */
async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer (20 years, Wilcom EmbroideryStudio).
Analyze this image. Return ONE JSON object to generate a DST file.

RULES:
1. Background fabric is NOT a thread color. Skip white/cream/grey background.
2. Only list colors actually visible in the design.
3. stitch_type per Wilcom definitions:
   "fill"    = solid area > 8mm wide → tatami
   "satin"   = column 1.5–8mm wide  → satin zigzag
   "running" = thin line < 1.5mm    → running stitch
4. If shape has wide body + thin border: body=fill, border=satin (list the dominant type).
5. recommended_angle: fill direction degrees (0=horizontal, 45=diagonal, 90=vertical).
6. Return ONLY valid JSON. No markdown. No explanation. No trailing commas.

OUTPUT:
{
  "background": "#FFFFFF",
  "colors": [
    { "hex": "#000000", "label": "logo body", "stitch_type": "fill", "coverage_pct": 70 }
  ],
  "is_logo": true,
  "is_text": false,
  "complexity": "simple",
  "recommended_angle": 0,
  "notes": "one sentence for the digitizer"
}`;

  try {
    const res  = await geminiPost({
      contents: [{ role:"user", parts:[{ text:prompt },{ inlineData:{ mimeType:mime||"image/png", data:b64 } }] }],
      generationConfig: { temperature:0.0, maxOutputTokens:2048 }
    }, 28000);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let js = text.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if (fa!==-1&&lb>fa) js=js.slice(fa,lb+1);
    const p = JSON.parse(js);

    const colors = (p.colors||[]).map(c=>normHex(typeof c==="string"?c:c.hex));
    const meta   = {};
    for (const c of (p.colors||[])) if (typeof c==="object"&&c.hex) meta[normHex(c.hex)]=c;

    return {
      colors:    dedupe(colors),
      meta,
      is_text:   !!p.is_text,
      is_logo:   !!p.is_logo,
      angle:     Number(p.recommended_angle)||0,
      complexity:p.complexity||"moderate",
      notes:     p.notes||""
    };
  } catch(e) {
    console.error("Gemini failed:", e.message);
    return null;
  }
}

/* ============================================================
   RAMER-DOUGLAS-PEUCKER simplification
   ============================================================ */
function rdp(pts, eps) {
  if (pts.length<=3) return pts;
  const d=(px,py,sx,sy,ex,ey)=>{
    const l=Math.hypot(ex-sx,ey-sy);
    return l===0?Math.hypot(px-sx,py-sy):Math.abs((ey-sy)*px-(ex-sx)*py+ex*sy-ey*sx)/l;
  };
  const stack=[[0,pts.length-1]],keep=new Set([0,pts.length-1]);
  while(stack.length){
    const[s,e]=stack.pop(); if(e<=s+1)continue;
    const[sx,sy]=pts[s],[ex,ey]=pts[e]; let md=0,mi=-1;
    for(let i=s+1;i<e;i++){const dv=d(pts[i][0],pts[i][1],sx,sy,ex,ey);if(dv>md){md=dv;mi=i;}}
    if(md>eps){keep.add(mi);stack.push([s,mi],[mi,e]);}
  }
  return[...keep].sort((a,b)=>a-b).map(i=>pts[i]);
}

/* ============================================================
   PIXEL SHAPE EXTRACTION
   ─────────────────────────────────────────────────────────
   KEY FIX: image is already CANVAS×CANVAS pixels.
   scale = CANVAS / CANVAS = 1.0 exactly.
   1 pixel = 1 DST unit. Zero coordinate collapse.
   ============================================================ */
async function extractPixelShapes(buffer, colors, meta) {
  const Jimp  = require("jimp");
  const image = await Jimp.read(buffer);

  // Image is already CANVAS×CANVAS from preprocessImage()
  // If somehow different size, resize to exactly CANVAS×CANVAS
  if (image.bitmap.width !== CANVAS || image.bitmap.height !== CANVAS) {
    image.resize(CANVAS, CANVAS);
  }
  const pw = CANVAS, ph = CANVAS;
  // scale = 1.0 — no conversion needed, pixels ARE DST units

  const labColors = colors.map(c=>rgbToLab(hexToRgb(c)));
  const TOLERANCE = 32;
  const pixC      = new Int16Array(pw*ph).fill(-1);
  const imgD      = image.bitmap.data;

  // Assign each pixel to nearest thread color
  for (let y=0;y<ph;y++) {
    for (let x=0;x<pw;x++) {
      const i=(y*pw+x)<<2;
      const lab=rgbToLab({r:imgD[i],g:imgD[i+1],b:imgD[i+2]});
      let best=-1,bestD=TOLERANCE;
      for (let c=0;c<labColors.length;c++){const dv=deltaE(lab,labColors[c]);if(dv<bestD){bestD=dv;best=c;}}
      pixC[y*pw+x]=best;
    }
  }

  // 2-pass majority-vote gap fill (closes anti-aliasing gaps)
  for (let pass=0;pass<2;pass++) {
    for (let y=1;y<ph-1;y++) {
      for (let x=1;x<pw-1;x++) {
        const idx=y*pw+x;
        if (pixC[idx]!==-1) continue;
        const nbr=[pixC[idx-1],pixC[idx+1],pixC[idx-pw],pixC[idx+pw]].filter(n=>n!==-1);
        if (nbr.length>=2) {
          const freq={};
          for(const n of nbr)freq[n]=(freq[n]||0)+1;
          const top=Object.entries(freq).sort((a,b)=>+b[1]-+a[1])[0];
          if(top&&+top[1]>=2)pixC[idx]=+top[0];
        }
      }
    }
  }

  const shapes  = [];
  const MIN_PX  = 20;   // ignore noise blobs < 20px (< 0.2mm²)
  const N8      = [[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1]];
  let   maskId  = 1;

  for (let ci=0;ci<labColors.length;ci++) {
    const visited = new Uint8Array(pw*ph);
    const masks   = new Uint32Array(pw*ph);

    for (let y=0;y<ph;y++) {
      for (let x=0;x<pw;x++) {
        const idx=y*pw+x;
        if (pixC[idx]!==ci||visited[idx]) continue;

        // BFS 4-connected flood fill
        const q=[idx]; let qp=0,pxCnt=0,startX=-1,startY=-1;
        visited[idx]=1; masks[idx]=maskId;
        while (qp<q.length) {
          const c2=q[qp++]; pxCnt++;
          const cx=c2%pw, cy=(c2/pw)|0;
          if (startX===-1) {
            const onEdge=cx===0||cx===pw-1||cy===0||cy===ph-1
              ||pixC[c2-1]!==ci||pixC[c2+1]!==ci||pixC[c2-pw]!==ci||pixC[c2+pw]!==ci;
            if (onEdge){startX=cx;startY=cy;}
          }
          for (const[dx,dy]of[[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx=cx+dx,ny=cy+dy;
            if(nx>=0&&nx<pw&&ny>=0&&ny<ph){
              const ni=ny*pw+nx;
              if(!visited[ni]&&pixC[ni]===ci){visited[ni]=1;masks[ni]=maskId;q.push(ni);}
            }
          }
        }
        if (pxCnt<MIN_PX||startX===-1){maskId++;continue;}

        // Moore-neighbor contour trace
        const contour=[]; let cx=startX,cy=startY,dir=7,safety=0;
        const inM=(mx,my)=>mx>=0&&mx<pw&&my>=0&&my<ph&&masks[my*pw+mx]===maskId;
        do {
          contour.push([cx,cy]);
          let found=false;
          for(let i=1;i<=8;i++){
            const d=(dir+i)&7,nx=cx+N8[d][0],ny=cy+N8[d][1];
            if(inM(nx,ny)){cx=nx;cy=ny;dir=(d+5)&7;found=true;break;}
          }
          if(!found)break; safety++;
        } while((cx!==startX||cy!==startY)&&safety<300000);

        maskId++;
        if (contour.length<8) continue;

        // Simplify contour (epsilon in pixels = DST units since scale=1)
        // Use larger epsilon for smoother shapes and fewer micro-segments
        const eps = Math.max(1.5, Math.sqrt(pxCnt) * 0.05);
        const simplified = rdp(contour, eps);

        // Points are already in DST units (scale = 1.0, no rounding loss)
        const points = simplified.map(([px,py])=>[px, py]);
        if (points.length<3) continue;

        // Close polygon
        const[fx,fy]=points[0],[lx,ly]=points[points.length-1];
        if(fx!==lx||fy!==ly)points.push([fx,fy]);

        // Bounding box
        let mnx=Infinity,mny=Infinity,mxx=-Infinity,mxy=-Infinity;
        for(const[px,py]of points){if(px<mnx)mnx=px;if(px>mxx)mxx=px;if(py<mny)mny=py;if(py>mxy)mxy=py;}
        const bw=mxx-mnx, bh=mxy-mny, narrow=Math.min(bw,bh);

        // Classify: Gemini metadata → geometry fallback
        const gType = meta?.[normHex(colors[ci])]?.stitch_type;
        let type;
        if (gType==="fill"||gType==="satin"||gType==="running"){type=gType;}
        else if (narrow<=T_RUN)  {type="running";}
        else if (narrow<=T_SATIN){type="satin";}
        else                     {type="fill";}

        shapes.push({type,color:colors[ci],points,pxCnt,bw,bh,mnx,mny,mxx,mxy});
      }
    }
  }

  shapes.sort((a,b)=>b.pxCnt-a.pxCnt);

  // Remove shapes fully contained in a larger same-color shape
  // FIX: use the already-computed bbox fields, not re-derived ones
  const filtered=[];
  for(const s of shapes){
    let contained=false;
    for(const o of shapes){
      if(o===s||o.color!==s.color)continue;
      const oArea=(o.mxx-o.mnx)*(o.mxy-o.mny);
      const sArea=(s.mxx-s.mnx)*(s.mxy-s.mny);
      if(oArea<=sArea)continue;
      if(s.mnx>=o.mnx&&s.mxx<=o.mxx&&s.mny>=o.mny&&s.mxy<=o.mxy){contained=true;break;}
    }
    if(!contained)filtered.push(s);
  }

  console.log(`Shapes extracted: ${filtered.length} (fill:${filtered.filter(s=>s.type==="fill").length} satin:${filtered.filter(s=>s.type==="satin").length} run:${filtered.filter(s=>s.type==="running").length})`);
  return filtered;
}

/* ============================================================
   GEOMETRY HELPERS
   ============================================================ */
function polygonCentroid(pts) {
  let cx=0,cy=0,a=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const[x1,y1]=pts[i],[x2,y2]=pts[j],c=x1*y2-x2*y1;
    cx+=(x1+x2)*c;cy+=(y1+y2)*c;a+=c;
  }
  a*=0.5;
  if(Math.abs(a)<0.001){let sx=0,sy=0;for(const[x,y]of pts){sx+=x;sy+=y;}return[sx/pts.length,sy/pts.length];}
  return[cx/(6*a),cy/(6*a)];
}

function scanX(pts, ly) {
  const r=[];
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const[x1,y1]=pts[i],[x2,y2]=pts[j];
    if((y1<=ly&&y2>ly)||(y2<=ly&&y1>ly))r.push(x1+(ly-y1)/(y2-y1)*(x2-x1));
  }
  return r.sort((a,b)=>a-b);
}

/* ============================================================
   UNDERLAY GENERATORS
   Source: Wilcom docs, EmbroideryLegacy, HoopingStation (Romero)
   ============================================================ */

// Center-run: spine down narrow satin (≤20u wide)
function ulCenter(pts, color) {
  const r=[],mnx=Math.min(...pts.map(p=>p[0])),mxx=Math.max(...pts.map(p=>p[0]));
  const mx=(mnx+mxx)/2;
  const mny=Math.min(...pts.map(p=>p[1])),mxy=Math.max(...pts.map(p=>p[1]));
  for(let ly=mny;ly<=mxy;ly+=RUN_LEN)r.push({x:Math.round(mx),y:Math.round(ly),color,type:"underlay"});
  return r;
}

// Edge-run: two rails 0.4mm inset from each edge (2.5–3.5mm columns)
function ulEdge(pts, color) {
  const r=[],INSET=4;
  const mny=Math.min(...pts.map(p=>p[1])),mxy=Math.max(...pts.map(p=>p[1]));
  for(let ly=mny;ly<=mxy;ly+=RUN_LEN){
    const xs=scanX(pts,ly);
    if(xs.length<2)continue;
    r.push({x:Math.round(xs[0]+INSET),         y:Math.round(ly),color,type:"underlay"});
    r.push({x:Math.round(xs[xs.length-1]-INSET),y:Math.round(ly),color,type:"underlay"});
  }
  return r;
}

// Zigzag: back-and-forth for wide satin (4mm+ columns)
function ulZigzag(pts, color) {
  const r=[];
  const mny=Math.min(...pts.map(p=>p[1])),mxy=Math.max(...pts.map(p=>p[1]));
  let row=0;
  for(let ly=mny+TATAMI_UL_ROW/2;ly<=mxy;ly+=TATAMI_UL_ROW){
    const xs=scanX(pts,ly);
    if(xs.length<2)continue;
    const xa=row%2===0?xs[0]:xs[xs.length-1];
    const xb=row%2===0?xs[xs.length-1]:xs[0];
    r.push({x:Math.round(xa),y:Math.round(ly),color,type:"underlay"});
    r.push({x:Math.round(xb),y:Math.round(ly),color,type:"underlay"});
    row++;
  }
  return r;
}

// Tatami underlay: for fills, at 90° to top-stitch angle
function ulTatami(pts, color, angleDeg) {
  const r=[],perpA=(angleDeg+90)*Math.PI/180;
  const cosA=Math.cos(perpA),sinA=Math.sin(perpA);
  const toL=([x,y])=>[x*cosA+y*sinA,-x*sinA+y*cosA];
  const toG=([lx,ly])=>[lx*cosA-ly*sinA,lx*sinA+ly*cosA];
  const lPts=pts.map(toL);
  const lmny=Math.min(...lPts.map(p=>p[1])),lmxy=Math.max(...lPts.map(p=>p[1]));
  let row=0;
  for(let ly=lmny+TATAMI_UL_ROW/2;ly<=lmxy;ly+=TATAMI_UL_ROW){
    const xs=scanX(lPts,ly);
    if(xs.length<2)continue;
    const xa=row%2===0?xs[0]:xs[xs.length-1];
    const xb=row%2===0?xs[xs.length-1]:xs[0];
    const[ax,ay]=toG([xa,ly]),[bx,by]=toG([xb,ly]);
    r.push({x:Math.round(ax),y:Math.round(ay),color,type:"underlay"});
    r.push({x:Math.round(bx),y:Math.round(by),color,type:"underlay"});
    row++;
  }
  return r;
}

function selectUnderlay(s, angleDeg) {
  if(s.type==="running") return [];
  if(s.type==="fill")    return ulTatami(s.points,s.color,angleDeg);
  const narrow=Math.min(s.bw,s.bh);
  if(narrow<=20) return ulCenter(s.points,s.color);
  if(narrow<=35) return ulEdge(s.points,s.color);
  return[...ulZigzag(s.points,s.color),...ulEdge(s.points,s.color)];
}

/* ============================================================
   TOP-STITCH GENERATORS
   ============================================================ */

// TATAMI FILL: adaptive stitch length, 50% brick offset, pull comp
function tatamiFill(pts, color, angleDeg, shapeW) {
  const r=[],sLen=adaptiveStitchLen(shapeW);
  const A=angleDeg*Math.PI/180,cosA=Math.cos(A),sinA=Math.sin(A);
  const toL=([x,y])=>[x*cosA+y*sinA,-x*sinA+y*cosA];
  const toG=([lx,ly])=>[lx*cosA-ly*sinA,lx*sinA+ly*cosA];
  const lPts=pts.map(toL);
  const lmny=Math.min(...lPts.map(p=>p[1])),lmxy=Math.max(...lPts.map(p=>p[1]));
  let row=0;
  for(let ly=lmny+TATAMI_ROW/2;ly<=lmxy;ly+=TATAMI_ROW){
    const xs=scanX(lPts,ly);
    if(xs.length<2){row++;continue;}
    const brickShift=(row%2===0)?0:sLen*TATAMI_BRICK;
    const rev=row%2===1;
    for(let k=0;k+1<xs.length;k+=2){
      const xl=xs[k]-PULL_COMP,xr=xs[k+1]+PULL_COMP;
      if(xr<=xl)continue;
      const steps=Math.max(1,Math.round((xr-xl)/sLen));
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

// SATIN: proper zigzag across narrow dimension, auto-split at 7mm
function satinFill(pts, color) {
  const r=[],bw=Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0]));
  const bh=Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1]));
  // Rotate so we always scan across the narrow side
  const isHoriz=bw>=bh;
  const rot=([x,y])=>isHoriz?[y,x]:[x,y];
  const unr=([x,y])=>isHoriz?[y,x]:[x,y];
  const rPts=pts.map(rot);
  const rmny=Math.min(...rPts.map(p=>p[1])),rmxy=Math.max(...rPts.map(p=>p[1]));
  let row=0;
  for(let ly=rmny+SATIN_SPACE/2;ly<=rmxy;ly+=SATIN_SPACE){
    const xs=scanX(rPts,ly);
    if(xs.length<2){row++;continue;}
    const left=xs[0],right=xs[xs.length-1],width=right-left;
    const safeW=Math.min(width,SATIN_MAX);
    const cl=left+(width-safeW)/2,cr=cl+safeW;
    if(width>SATIN_SPLIT){
      // Auto-split: two interleaved half-passes (mirrors Wilcom Auto Split)
      const mid=(cl+cr)/2;
      const xA=row%2===0?cl:mid+SATIN_SPACE/2;
      const xB=row%2===0?mid-SATIN_SPACE/2:cr;
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

// RUNNING STITCH
function runStitch(pts, color) {
  const r=[];
  if(pts.length<2)return r;
  let cum=0;
  const segs=pts.map((p,i)=>{
    const nx=pts[(i+1)%pts.length];
    const len=Math.hypot(nx[0]-p[0],nx[1]-p[1]);
    const s={start:cum,len,idx:i};cum+=len;return s;
  });
  if(cum<1)return r;
  const steps=Math.max(1,Math.floor(cum/RUN_LEN));
  for(let s=0;s<=steps;s++){
    const t=(s/steps)*cum;
    const seg=segs.find(sg=>t>=sg.start&&t<sg.start+sg.len)||segs[segs.length-1];
    const f=seg.len>0?(t-seg.start)/seg.len:0;
    const[x1,y1]=pts[seg.idx],[x2,y2]=pts[(seg.idx+1)%pts.length];
    r.push({x:Math.round(x1+(x2-x1)*f),y:Math.round(y1+(y2-y1)*f),color,type:"running"});
  }
  return r;
}

/* ============================================================
   STITCH GENERATION ORCHESTRATOR
   ============================================================ */
function generateStitches(shapes, globalAngle) {
  const all=[],ang=globalAngle||0;
  for(const s of shapes)s.centroid=polygonCentroid(s.points);

  // Group by color
  const groups={};
  for(const s of shapes){const c=normHex(s.color);if(!groups[c])groups[c]=[];groups[c].push({...s,color:c});}

  // Cross-group nearest-neighbor order from origin
  const cList=Object.keys(groups),ordered=[];
  let ex=0,ey=0;
  while(cList.length){
    let bi=0,bd=Infinity;
    for(let i=0;i<cList.length;i++){
      const s=groups[cList[i]][0];
      const d=Math.hypot(s.points[0][0]-ex,s.points[0][1]-ey);
      if(d<bd){bd=d;bi=i;}
    }
    const col=cList.splice(bi,1)[0];
    ordered.push(col);
    const lp=groups[col][groups[col].length-1].points.slice(-1)[0];
    ex=lp[0];ey=lp[1];
  }

  let lastX=0,lastY=0,lastColor=null;

  for(const color of ordered){
    // NN centroid sort within group
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
      if(jump>10&&all.length){
        all.push({x:Math.round(lastX),y:Math.round(lastY),color,type:"trim"});
        all.push({x:Math.round(sx),y:Math.round(sy),color,type:"trim"});
      }
      // Underlay → top stitches
      all.push(...selectUnderlay(s,ang));
      if(s.type==="fill")        all.push(...tatamiFill(s.points,color,ang,Math.max(s.bw,s.bh)));
      else if(s.type==="satin")  all.push(...satinFill(s.points,color));
      else                       all.push(...runStitch(s.points,color));

      if(all.length){const l=all[all.length-1];lastX=l.x;lastY=l.y;lastColor=l.color;}
    }
  }

  // Registration border — FIX: uses last real color so renderer connects correctly
  const borderColor = lastColor||"#333333";
  const INSET=5;
  all.push(...runStitch([[INSET,INSET],[CANVAS-INSET,INSET],[CANVAS-INSET,CANVAS-INSET],[INSET,CANVAS-INSET],[INSET,INSET]],borderColor));

  return{stitches:all,designW:CANVAS,designH:CANVAS,shapes};
}

/* ============================================================
   QUALITY VALIDATION
   ============================================================ */
function validateQuality(stitches){
  const w=[];
  let totLen=0,cnt=0,maxJ=0,longJ=0,prev=null;
  for(const s of stitches){
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>DST_MAX)longJ++;
      if(s.type!=="trim"&&prev.type!=="trim"){totLen+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?totLen/cnt:0;
  if(avg>40) w.push(`Long avg stitch ${(avg/10).toFixed(1)}mm (rec max 4.0mm)`);
  if(avg<10) w.push(`Dense avg stitch ${(avg/10).toFixed(1)}mm (rec min 1.0mm)`);
  if(maxJ>DST_MAX) w.push(`Jump ${(maxJ/10).toFixed(1)}mm exceeds 12.1mm DST limit`);
  if(longJ>20)     w.push(`${longJ} oversized jumps`);
  if(cnt>60000)    w.push(`High stitch count ${cnt} — may exceed machine buffer`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,warnings:w,passed:!w.length};
}

/* ============================================================
   DST ENCODER  (Tajima Data Stitch binary format)
   512-byte header + 3-byte records [dy, dx, flags]
   3× 0xC3 = trim. 0xF3 = end.
   ============================================================ */
function stitchRecord(dx,dy){
  const cdx=Math.max(-121,Math.min(121,Math.round(dx)));
  const cdy=Math.max(-121,Math.min(121,Math.round(dy)));
  return Buffer.from([cdy>=0?cdy:0x100+cdy,cdx>=0?cdx:0x100+cdx,0x03]);
}
function encodeDST(data){
  const{stitches}=data;
  const hdr=Buffer.alloc(512,0x20);
  hdr.write("Stichai",0,"ascii");
  const recs=[];
  let lastCol=null,px=0,py=0,sc=0,cc=0;
  let mnx=0,mxx=0,mny=0,mxy=0,ax=0,ay=0;

  for(const s of stitches){
    ax+=s.x-px;ay+=s.y-py;
    if(ax<mnx)mnx=ax;if(ax>mxx)mxx=ax;if(ay<mny)mny=ay;if(ay>mxy)mxy=ay;
    if(s.color!==lastCol&&lastCol!==null){recs.push(Buffer.from([0,0,0xC3]));cc++;}
    lastCol=s.color;

    if(s.type==="trim"){
      recs.push(Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]));
      const dx=s.x-px,dy=s.y-py;px=s.x;py=s.y;
      const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      let ppx=0,ppy=0;
      for(let i=1;i<=steps;i++){
        const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);
        recs.push(stitchRecord(fx-ppx,fy-ppy));ppx=fx;ppy=fy;
      }
      continue;
    }
    const dx=Math.round(s.x-px),dy=Math.round(s.y-py);px=s.x;py=s.y;
    if(Math.abs(dx)>121||Math.abs(dy)>121){
      const steps=Math.max(Math.ceil(Math.abs(dx)/121),Math.ceil(Math.abs(dy)/121));
      let ppx=0,ppy=0;
      for(let i=1;i<=steps;i++){
        const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);
        recs.push(stitchRecord(fx-ppx,fy-ppy));ppx=fx;ppy=fy;
      }
    } else {
      recs.push(stitchRecord(dx,dy));
    }
    sc++;
  }
  recs.push(Buffer.from([0,0,0xF3]));
  hdr.writeInt32LE(sc,20);hdr.writeInt32LE(cc,24);
  hdr.writeInt16LE(Math.round((mxx-mnx)*10),28);hdr.writeInt16LE(Math.round((mxy-mny)*10),32);
  hdr.writeInt16LE(Math.round(mnx*10),36);hdr.writeInt16LE(Math.round(mxx*10),40);
  hdr.writeInt16LE(Math.round(mny*10),44);hdr.writeInt16LE(Math.round(mxy*10),48);
  hdr.write("(c)Stichai",56,"ascii");hdr.writeInt16LE(cc+1,88);
  return Buffer.concat([hdr,...recs]);
}
function encodeFile(fmt,data){
  const d=encodeDST(data);
  switch((fmt||"dst").toLowerCase()){
    case"pes":{const h=Buffer.alloc(8);h.write("#PES0001",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"pes"};}
    case"jef":{const h=Buffer.alloc(8);h.write("JEF0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"jef"};}
    case"exp":{const h=Buffer.alloc(8);h.write("EXP0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"exp"};}
    case"vp3":{const h=Buffer.alloc(8);h.write("VP30001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"vp3"};}
    default:  return{buf:d,ext:"dst"};
  }
}

/* ============================================================
   PREVIEW RENDERER  (stitches → PNG for UI display)
   ============================================================ */
async function renderPreview(stitches,dw,dh){
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
    if(prev&&prev.type!=="trim"){
      // FIX: draw even if color changed (underlay→top stitch transitions)
      const drawColor=st.color||prev.color;
      const m=drawColor.match(/^#([0-9a-fA-F]{6})$/);
      if(m){
        const cr=parseInt(m[1].slice(0,2),16),cg=parseInt(m[1].slice(2,4),16),cb=parseInt(m[1].slice(4,6),16);
        const dist=Math.hypot(st.x-prev.x,st.y-prev.y);
        if(dist<CANVAS*0.5){  // skip wild lines > half canvas
          ln(prev.x*scale,prev.y*scale,st.x*scale,st.y*scale,cr,cg,cb,st.type==="satin"?2:1);
        }
      }
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

    // 1. Pre-process → resizes to CANVAS×CANVAS pixels
    console.time(`pre-${rid}`);
    const pre=await preprocessImage(req.file.buffer);
    console.timeEnd(`pre-${rid}`);

    // 2. Gemini analysis
    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(req.file.buffer,req.file.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={},globalAngle=0;
    if(gem&&gem.colors&&gem.colors.length>=1){
      colors=gem.colors;colorMeta=gem.meta||{};globalAngle=gem.angle||0;
      console.log(`Gemini: [${colors.join(",")}] angle:${globalAngle}° | ${gem.notes}`);
    } else {
      colors=pre.fallbackColors;
      console.log(`Fallback: [${colors.join(",")}]`);
    }
    if(!colors.length)colors=["#000000"];
    const hasDark=colors.some(c=>{const{r,g,b}=hexToRgb(c);return r+g+b<180;});
    if(!hasDark&&(gem?.is_logo||gem?.is_text)){colors.push("#000000");console.log("Injected #000000 for logo/text");}

    // 3. Extract shapes (1px = 1 DST unit, no collapse)
    console.time(`shapes-${rid}`);
    const shapes=await extractPixelShapes(pre.buffer,colors,colorMeta);
    console.timeEnd(`shapes-${rid}`);
    if(!shapes.length)return res.status(500).json({error:"No stitchable shapes found"});

    // 4. Generate stitches
    const result=generateStitches(shapes,globalAngle);
    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,result);

    const qa=validateQuality(result.stitches);
    console.log(`[${rid}] stitches:${result.stitches.length} avg:${qa.avgStitchMM}mm jump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

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
    console.error(`[${rid}] ERROR:`,e.message,e.stack);
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
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),12000))
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

app.get("/health",(_,res)=>res.json({status:"ok",version:"31.0",canvas:`${CANVAS}u`,designMM:DESIGN_MM}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v31 on :${PORT} | canvas ${CANVAS} DST units (${DESIGN_MM}mm)`));
server.timeout=180000;
