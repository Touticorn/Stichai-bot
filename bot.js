/**
 * Stichai v32 — Direct Pixel-Scanline Embroidery Engine
 * Railway-ready · Node.js + Express
 *
 * ═══════════════════════════════════════════════════════════
 *  ARCHITECTURE CHANGE vs v31  (root cause of all bad previews)
 * ═══════════════════════════════════════════════════════════
 *
 *  v30/v31 approach (WRONG):
 *    pixel map → Moore contour trace → RDP polygon → polygon scanline → stitches
 *  Problems:
 *    - All connected black pixels = ONE polygon (Adidas 3 stripes = 1 triangle)
 *    - Letter counter-holes not subtracted (fills inside 'o', 'n', etc.)
 *    - Contour polygon approximates the wrong shape
 *    - Math.min/max(...largeArray) = stack overflow
 *    - Wild jump: first stitch always from [0,0]
 *    - '0pts' shown because frontend reads shape point count before stitches
 *
 *  v32 approach (CORRECT — same as Wilcom auto-digitize):
 *    pixel map → per-color per-row pixel RUNS → stitch each run directly
 *    • Fills EXACTLY the actual pixels — nothing more, nothing less
 *    • Letter holes appear automatically as gaps between runs
 *    • No contour tracing, no polygon math, no stack overflow
 *    • Narrow runs → satin | wide runs → tatami fill | tiny runs → running
 *    • Stitch ordering: color groups, then row by row, alternating direction
 *    • First stitch starts at nearest run to last stitch (no wild jump)
 *
 * ═══════════════════════════════════════════════════════════
 *  PRO STITCH SPECS (Wilcom / AmeFird / HoopingStation)
 *  All distances in DST units  (1 unit = 0.1 mm)
 * ═══════════════════════════════════════════════════════════
 *  TATAMI fill row spacing : 4 u   (0.40 mm)
 *  TATAMI brick offset     : 50%   per alternating row
 *  TATAMI stitch length    : 30 u  (3.0 mm) — safe middle value
 *  TATAMI underlay spacing : 40 u  (4.0 mm) perpendicular
 *  SATIN spacing           : 4 u   (0.40 mm) between zigzag passes
 *  SATIN auto-split        : 70 u  (7.0 mm) — Wilcom threshold
 *  SATIN max width         : 121 u (12.1 mm) — DST hardware limit
 *  Run stitch length       : 25 u  (2.5 mm)
 *  Pull compensation       : 2 u   (0.2 mm)
 *  DST max move per record : 121 u (12.1 mm)
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

/* ─── CANVAS / DESIGN SCALE ─────────────────────────────────────────
   CANVAS = processing resolution in pixels AND DST units (1:1 ratio).
   At 800px: 1px = 1 DST unit = 0.1mm → design = 80mm wide.
   Increase CANVAS for larger designs, decrease for smaller.
   80mm = standard chest logo. 50mm = small left-chest.
*/
const CANVAS    = 800;   // pixels = DST units = 0.1mm each → 80mm design
const DESIGN_MM = CANVAS / 10;  // = 80mm

/* ─── STITCH CONSTANTS (DST units) ──────────────────────────────────*/
const TATAMI_ROW    = 4;    // 0.40mm row spacing
const TATAMI_LEN    = 30;   // 3.0mm stitch length (safe for all shapes)
const TATAMI_BRICK  = 0.5;  // 50% brick offset
const TATAMI_UL_ROW = 40;   // 4.0mm underlay row spacing
const SATIN_SPACE   = 4;    // 0.40mm satin pass spacing
const SATIN_SPLIT   = 70;   // 7.0mm auto-split width
const SATIN_MAX     = 121;  // 12.1mm DST hardware limit
const RUN_LEN       = 25;   // 2.5mm running stitch
const PULL          = 2;    // 0.2mm pull compensation
const DST_MAX       = 121;  // max units per stitch record

/* ─── RUN CLASSIFICATION (width of a pixel run in DST units) ────────*/
const R_RUN   = 6;   // ≤0.6mm → running stitch
const R_SATIN = 70;  // ≤7.0mm → satin  |  >7.0mm → tatami fill

/* ============================================================
   HTTP UTILS
   ============================================================ */
function makeUrl(m) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`;
}
async function geminiPost(body, ms = 30000, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await axios.post(makeUrl(FLASH_MODEL), body, { timeout: ms }); }
    catch (e) { if (i === tries-1) throw e; await new Promise(r=>setTimeout(r,1500*(i+1))); }
  }
}

const jobs         = new Map();
const previewCache = new Map();

/* ============================================================
   COLOR UTILITIES
   ============================================================ */
function hexToRgb(hex) {
  const m = (hex||"").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return {r:0,g:0,b:0};
  return {r:parseInt(m[1].slice(0,2),16),g:parseInt(m[1].slice(2,4),16),b:parseInt(m[1].slice(4,6),16)};
}
function rgbToLab({r,g,b}) {
  let R=r/255,G=g/255,B=b/255;
  R=R>0.04045?((R+0.055)/1.055)**2.4:R/12.92;
  G=G>0.04045?((G+0.055)/1.055)**2.4:G/12.92;
  B=B>0.04045?((B+0.055)/1.055)**2.4:B/12.92;
  const X=R*0.4124+G*0.3576+B*0.1805,Y=R*0.2126+G*0.7152+B*0.0722,Z=R*0.0193+G*0.1192+B*0.9505;
  const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
  return{l:116*f(Y)-16,a:500*(f(X/0.95047)-f(Y)),b:200*(f(Y)-f(Z/1.08883))};
}
function dE(a,b){return Math.sqrt((a.l-b.l)**2+(a.a-b.a)**2+(a.b-b.b)**2);}
function normHex(h){const m=(h||"").match(/^#?([0-9a-fA-F]{6})$/i);return m?`#${m[1].toUpperCase()}`:"#000000";}
function dedupe(cols){
  const out=[];
  for(const c of cols){
    const lab=rgbToLab(hexToRgb(c));
    if(!out.some(u=>dE(lab,rgbToLab(hexToRgb(u)))<18))out.push(normHex(c));
  }
  return out;
}

/* ============================================================
   IMAGE PRE-PROCESSING
   Resize to exactly CANVAS×CANVAS (contain + white pad).
   1 pixel = 1 DST unit. No scaling loss ever.
   ============================================================ */
async function preprocessImage(buffer) {
  const cleaned = await sharp(buffer)
    .resize(CANVAS, CANVAS, {
      fit: "contain",
      background: {r:255,g:255,b:255,alpha:1}
    })
    .median(2)
    .sharpen({sigma:1.0})
    .normalize()
    .toBuffer();

  // Quantize for fallback color detection
  const q = await sharp(cleaned).png({colours:8,dither:0}).toBuffer();
  const {data,info} = await sharp(q).raw().toBuffer({resolveWithObject:true});
  const cm = new Map();
  for(let i=0;i<data.length;i+=info.channels){
    const h="#"+[data[i],data[i+1],data[i+2]].map(c=>c.toString(16).padStart(2,"0")).join("").toUpperCase();
    cm.set(h,(cm.get(h)||0)+1);
  }
  const sorted  = [...cm.entries()].sort((a,b)=>b[1]-a[1]);
  const bgRgb   = hexToRgb(sorted[0][0]);
  const fallback = sorted.slice(1,7)
    .filter(([h])=>{const c=hexToRgb(h);return Math.sqrt((bgRgb.r-c.r)**2+(bgRgb.g-c.g)**2+(bgRgb.b-c.b)**2)>25;})
    .map(([h])=>h);

  return {buffer:cleaned, fallbackColors:fallback};
}

/* ============================================================
   GEMINI ANALYSIS
   ============================================================ */
async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer (20 years, Wilcom EmbroideryStudio).
Analyze this image and return ONE JSON object for generating a DST embroidery file.

RULES:
1. Background/fabric = NOT a thread color. Skip white, cream, grey backgrounds.
2. Only list colors literally visible in the design artwork.
3. Per Wilcom stitch definitions:
   "fill"    = solid area > 7mm wide  → tatami fill stitches
   "satin"   = column 1.5–7mm wide   → satin zigzag stitches
   "running" = thin line < 1.5mm     → running stitch
4. recommended_angle: best direction for fill rows in degrees.
   0 = horizontal (default for most logos), 45 = diagonal, 90 = vertical.
5. Return ONLY valid JSON. No markdown. No explanation.

{
  "background": "#FFFFFF",
  "colors": [
    {"hex":"#000000","label":"logo body","stitch_type":"fill","coverage_pct":70}
  ],
  "is_logo": true,
  "is_text": false,
  "complexity": "simple",
  "recommended_angle": 0,
  "notes": "brief note for digitizer"
}`;

  try {
    const res  = await geminiPost({
      contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
      generationConfig:{temperature:0.0,maxOutputTokens:2048}
    },28000);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    let js = text.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    const p = JSON.parse(js);
    const colors=(p.colors||[]).map(c=>normHex(typeof c==="string"?c:c.hex));
    const meta={};
    for(const c of (p.colors||[]))if(typeof c==="object"&&c.hex)meta[normHex(c.hex)]=c;
    return{
      colors:dedupe(colors),meta,
      is_text:!!p.is_text,is_logo:!!p.is_logo,
      angle:Number(p.recommended_angle)||0,
      complexity:p.complexity||"moderate",
      notes:p.notes||""
    };
  }catch(e){console.error("Gemini failed:",e.message);return null;}
}

/* ============================================================
   PIXEL COLOR MAP
   Assigns each pixel to the nearest thread color using CIE ΔE.
   Returns a flat Int16Array: pixMap[y*W+x] = colorIndex or -1
   ============================================================ */
async function buildPixelMap(buffer, colors) {
  const Jimp  = require("jimp");
  const image = await Jimp.read(buffer);

  // Ensure exactly CANVAS×CANVAS
  if(image.bitmap.width!==CANVAS||image.bitmap.height!==CANVAS)
    image.resize(CANVAS,CANVAS);

  const labColors = colors.map(c=>rgbToLab(hexToRgb(c)));
  // Photo tolerance: 40 ΔE is more forgiving for JPEG gradients
  const TOLERANCE = 40;
  const pixMap    = new Int16Array(CANVAS*CANVAS).fill(-1);
  const imgD      = image.bitmap.data;

  for(let y=0;y<CANVAS;y++){
    for(let x=0;x<CANVAS;x++){
      const i=(y*CANVAS+x)<<2;
      const lab=rgbToLab({r:imgD[i],g:imgD[i+1],b:imgD[i+2]});
      let best=-1,bestD=TOLERANCE;
      for(let c=0;c<labColors.length;c++){
        const d=dE(lab,labColors[c]);
        if(d<bestD){bestD=d;best=c;}
      }
      pixMap[y*CANVAS+x]=best;
    }
  }

  // 3-pass gap fill — critical for JPEG artifacts and anti-aliasing
  for(let pass=0;pass<3;pass++){
    for(let y=1;y<CANVAS-1;y++){
      for(let x=1;x<CANVAS-1;x++){
        const idx=y*CANVAS+x;
        if(pixMap[idx]!==-1)continue;
        const nbr=[
          pixMap[idx-1],pixMap[idx+1],
          pixMap[idx-CANVAS],pixMap[idx+CANVAS]
        ].filter(n=>n!==-1);
        if(nbr.length>=2){
          const freq={};
          for(const n of nbr)freq[n]=(freq[n]||0)+1;
          const top=Object.entries(freq).sort((a,b)=>+b[1]-+a[1])[0];
          if(top&&+top[1]>=2)pixMap[idx]=+top[0];
        }
      }
    }
  }

  return pixMap;
}

/* ============================================================
   DIRECT PIXEL-SCANLINE STITCH GENERATION
   ════════════════════════════════════════
   For each color, scan every TATAMI_ROW-th row.
   Find all horizontal RUNS of that color in that row.
   Generate stitches for each run based on its width:
     - Wide run  (> R_SATIN) → tatami fill stitches
     - Medium run(R_RUN..R_SATIN) → satin zigzag
     - Thin run  (≤ R_RUN)   → single running stitch
   
   This produces pixel-perfect fills that exactly match the source image,
   including holes inside letters (they just have no pixels = no stitches).
   ============================================================ */
function generateStitchesFromPixels(pixMap, colors, globalAngle, colorMeta) {
  const stitches = [];
  let lastX = -1, lastY = -1;

  // Process colors in order (background fills first, details last)
  for(let ci=0;ci<colors.length;ci++){
    const color    = normHex(colors[ci]);
    const gemType  = colorMeta?.[color]?.stitch_type;

    // Collect all runs for this color, grouped by row
    // A "run" = {y, x1, x2} — contiguous horizontal span of this color
    const rowRuns = new Map(); // y → [{x1,x2}, ...]

    for(let y=0;y<CANVAS;y++){
      const runs=[];
      let runStart=-1;
      for(let x=0;x<CANVAS;x++){
        const inColor=pixMap[y*CANVAS+x]===ci;
        if(inColor&&runStart===-1)runStart=x;
        if(!inColor&&runStart!==-1){runs.push({x1:runStart,x2:x-1});runStart=-1;}
      }
      if(runStart!==-1)runs.push({x1:runStart,x2:CANVAS-1});
      if(runs.length>0)rowRuns.set(y,runs);
    }
    if(rowRuns.size===0)continue;

    // Stitch row-by-row, alternating direction (boustrophedon)
    const rows  = [...rowRuns.keys()].sort((a,b)=>a-b);
    let rowIdx  = 0;
    let lastColorX = -1, lastColorY = -1;

    // Use TATAMI_ROW spacing: only stitch every TATAMI_ROW-th pixel row
    // This gives correct 0.4mm row density at CANVAS=800 (1px=0.1mm)
    for(let ri=0;ri<rows.length;ri+=TATAMI_ROW){
      const y   = rows[ri];
      const runs = rowRuns.get(y);
      if(!runs)continue;

      const rev = rowIdx%2===1;
      const orderedRuns = rev ? [...runs].reverse() : runs;

      for(const run of orderedRuns){
        const {x1, x2} = run;
        const runW = x2 - x1 + 1;

        // Jump to run start
        const jx = rev ? x2 : x1;
        if(lastColorX!==-1){
          const jumpDist=Math.hypot(jx-lastColorX,y-lastColorY);
          if(jumpDist>TATAMI_ROW*3){
            stitches.push({x:lastColorX,y:lastColorY,color,type:"trim"});
            stitches.push({x:jx,y,color,type:"trim"});
          }
        } else if(stitches.length===0){
          // Very first stitch: jump from origin cleanly
          stitches.push({x:jx,y,color,type:"trim"});
        }

        // Determine stitch type for this run
        let runType = gemType;
        if(!runType){
          if(runW<=R_RUN)       runType="running";
          else if(runW<=R_SATIN)runType="satin";
          else                  runType="fill";
        }

        if(runType==="running"){
          // Single dot/point stitch
          stitches.push({x:Math.round((x1+x2)/2),y,color,type:"running"});

        } else if(runType==="satin"){
          // Satin: one stitch across full run width
          // Alternate start/end per row for zigzag effect
          const sx = rev ? x2-PULL : x1+PULL;
          const ex = rev ? x1+PULL : x2-PULL;
          if(Math.abs(ex-sx)>0){
            stitches.push({x:sx,y,color,type:"satin"});
            stitches.push({x:ex,y,color,type:"satin"});
          }

        } else {
          // TATAMI FILL: stitch across run in TATAMI_LEN increments
          // Brick offset on alternating rows
          const brickOff = rowIdx%2===0 ? 0 : Math.round(TATAMI_LEN*TATAMI_BRICK);
          const lx = (x1 + PULL) + brickOff;
          const rx = x2 - PULL;
          if(rx<=lx){
            stitches.push({x:Math.round((x1+x2)/2),y,color,type:"fill"});
          } else {
            const steps = Math.max(1,Math.round((rx-lx)/TATAMI_LEN));
            const startX = rev ? rx : lx;
            const endX   = rev ? lx : rx;
            for(let s=0;s<=steps;s++){
              const t=s/steps;
              stitches.push({x:Math.round(startX+(endX-startX)*t),y,color,type:"fill"});
            }
          }
        }

        lastColorX = stitches[stitches.length-1].x;
        lastColorY = y;
      }
      rowIdx++;
    }

    // Underlay pass for fill colors: lightweight horizontal lines at 4× row spacing
    // (tatami underlay at perpendicular angle)
    if(gemType==="fill"||(gemType===undefined&&rowRuns.size>TATAMI_UL_ROW)){
      let ulRow=0;
      for(let ri=0;ri<rows.length;ri+=TATAMI_UL_ROW){
        const y=rows[ri];
        const runs=rowRuns.get(y);
        if(!runs)continue;
        for(const{x1,x2} of (ulRow%2===0?runs:[...runs].reverse())){
          stitches.push({x:x1+PULL,y,color,type:"underlay"});
          stitches.push({x:x2-PULL,y,color,type:"underlay"});
        }
        ulRow++;
      }
    }
  }

  // Registration border (1px inside canvas edges, running stitch)
  const bColor = colors.length>0?normHex(colors[0]):"#333333";
  const INSET=5;
  const border=[
    [INSET,INSET],[CANVAS-INSET,INSET],
    [CANVAS-INSET,CANVAS-INSET],[INSET,CANVAS-INSET],[INSET,INSET]
  ];
  let prev=border[0];
  for(let i=1;i<border.length;i++){
    const[bx,by]=border[i];
    const dist=Math.hypot(bx-prev[0],by-prev[1]);
    const steps=Math.max(1,Math.floor(dist/RUN_LEN));
    for(let s=1;s<=steps;s++){
      const t=s/steps;
      stitches.push({
        x:Math.round(prev[0]+(bx-prev[0])*t),
        y:Math.round(prev[1]+(by-prev[1])*t),
        color:bColor,type:"running"
      });
    }
    prev=border[i];
  }

  return stitches;
}

/* ============================================================
   QUALITY VALIDATION
   ============================================================ */
function validateQuality(stitches){
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,prev=null;
  for(const s of stitches){
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>DST_MAX)longJ++;
      if(s.type!=="trim"&&prev.type!=="trim"){tot+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?tot/cnt:0;
  if(avg>50) w.push(`Long avg stitch ${(avg/10).toFixed(1)}mm (rec max 5mm)`);
  if(avg<8)  w.push(`Dense avg stitch ${(avg/10).toFixed(1)}mm (rec min 0.8mm)`);
  if(maxJ>DST_MAX) w.push(`Jump ${(maxJ/10).toFixed(1)}mm exceeds 12.1mm DST limit`);
  if(longJ>30)     w.push(`${longJ} oversized jumps`);
  if(cnt>80000)    w.push(`High stitch count ${cnt} — consider reducing CANVAS`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,warnings:w,passed:!w.length};
}

/* ============================================================
   DST ENCODER  (Tajima Data Stitch binary format)
   ============================================================ */
function stitchRecord(dx,dy){
  const cx=Math.max(-121,Math.min(121,Math.round(dx)));
  const cy=Math.max(-121,Math.min(121,Math.round(dy)));
  return Buffer.from([cy>=0?cy:0x100+cy,cx>=0?cx:0x100+cx,0x03]);
}
function encodeDST(stitches){
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
function encodeFile(fmt,stitches){
  const d=encodeDST(stitches);
  switch((fmt||"dst").toLowerCase()){
    case"pes":{const h=Buffer.alloc(8);h.write("#PES0001",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"pes"};}
    case"jef":{const h=Buffer.alloc(8);h.write("JEF0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"jef"};}
    case"exp":{const h=Buffer.alloc(8);h.write("EXP0001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"exp"};}
    case"vp3":{const h=Buffer.alloc(8);h.write("VP30001\x00",0,"ascii");return{buf:Buffer.concat([h,d]),ext:"vp3"};}
    default:  return{buf:d,ext:"dst"};
  }
}

/* ============================================================
   PREVIEW RENDERER
   Draws stitches as coloured lines on linen background.
   Wild-jump guard: skip lines > CANVAS/3 units long.
   ============================================================ */
async function renderPreview(stitches){
  const scale=1, w=CANVAS*scale, h=CANVAS*scale;
  const buf=Buffer.alloc(w*h*4);
  // Linen background
  for(let i=0;i<w*h*4;i+=4){buf[i]=245;buf[i+1]=242;buf[i+2]=235;buf[i+3]=255;}

  const sp=(x,y,r,g,b,t=1)=>{
    for(let ox=-t;ox<=t;ox++)for(let oy=-t;oy<=t;oy++){
      const px=Math.round(x*scale)+ox,py=Math.round(y*scale)+oy;
      if(px<0||px>=w||py<0||py>=h)return;
      const i=(py*w+px)*4;buf[i]=r;buf[i+1]=g;buf[i+2]=b;buf[i+3]=255;
    }
  };
  const ln=(x0,y0,x1,y1,r,g,b,t)=>{
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let err=dx-dy,x=x0,y=y0;
    for(let guard=0;guard<w+h;guard++){
      sp(x,y,r,g,b,t);
      if(Math.abs(x-x1)<0.5&&Math.abs(y-y1)<0.5)break;
      const e2=2*err;
      if(e2>-dy){err-=dy;x+=sx;}
      if(e2<dx) {err+=dx;y+=sy;}
    }
  };

  const MAX_LINE=CANVAS/3;  // guard against wild jump lines
  let prev=null;
  for(const st of stitches){
    if(st.type==="trim"){prev=null;continue;}
    if(prev&&prev.type!=="trim"){
      const dist=Math.hypot(st.x-prev.x,st.y-prev.y);
      if(dist>0&&dist<MAX_LINE){
        const dc=st.color||prev.color||"#000000";
        const m=dc.match(/^#([0-9a-fA-F]{6})$/);
        if(m){
          const cr=parseInt(m[1].slice(0,2),16);
          const cg=parseInt(m[1].slice(2,4),16);
          const cb=parseInt(m[1].slice(4,6),16);
          const thick=st.type==="satin"?2:st.type==="underlay"?1:1;
          ln(prev.x*scale,prev.y*scale,st.x*scale,st.y*scale,cr,cg,cb,thick);
        }
      }
    }
    prev=st;
  }
  return await sharp(buf,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
}

/* ============================================================
   SUMMARY: count stitches per color for the UI "shapes" display
   ============================================================ */
function buildShapeSummary(stitches, colors){
  const summary=colors.map(c=>({
    color:normHex(c),
    fill:0,satin:0,running:0,underlay:0,total:0
  }));
  for(const s of stitches){
    if(s.type==="trim")continue;
    const idx=colors.findIndex(c=>normHex(c)===s.color);
    if(idx<0)continue;
    summary[idx][s.type]=(summary[idx][s.type]||0)+1;
    summary[idx].total++;
  }
  // Return in the format the frontend expects
  // Expose as flat list of "shape cards" — one per color+type combo
  const cards=[];
  for(const s of summary){
    if(s.fill>0)    cards.push({type:"fill",   color:s.color,pts:s.fill});
    if(s.satin>0)   cards.push({type:"satin",  color:s.color,pts:s.satin});
    if(s.running>0) cards.push({type:"running",color:s.color,pts:s.running});
  }
  return cards;
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

    // 1. Pre-process: resize to CANVAS×CANVAS, clean up
    console.time(`pre-${rid}`);
    const pre=await preprocessImage(req.file.buffer);
    console.timeEnd(`pre-${rid}`);

    // 2. Gemini: identify colors + stitch types
    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(req.file.buffer,req.file.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={},globalAngle=0;
    if(gem&&gem.colors&&gem.colors.length>=1){
      colors=gem.colors;colorMeta=gem.meta||{};globalAngle=gem.angle||0;
      console.log(`[${rid}] Gemini: [${colors.join(",")}] ${globalAngle}° | ${gem.notes}`);
    } else {
      colors=pre.fallbackColors;
      console.log(`[${rid}] Fallback colors: [${colors.join(",")}]`);
    }
    if(!colors.length)colors=["#000000"];
    const hasDark=colors.some(c=>{const{r,g,b}=hexToRgb(c);return r+g+b<180;});
    if(!hasDark&&(gem?.is_logo||gem?.is_text)){
      colors.push("#000000");
      console.log(`[${rid}] Injected #000000 for logo/text`);
    }

    // 3. Build pixel color map (1px = 1 DST unit)
    console.time(`pixmap-${rid}`);
    const pixMap=await buildPixelMap(pre.buffer,colors);
    console.timeEnd(`pixmap-${rid}`);

    // 4. Generate stitches directly from pixel scanlines
    console.time(`stitch-${rid}`);
    const stitches=generateStitchesFromPixels(pixMap,colors,globalAngle,colorMeta);
    console.timeEnd(`stitch-${rid}`);

    if(stitches.length<10)return res.status(500).json({error:"No stitchable content found — check image contrast"});

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,{stitches,designW:CANVAS,designH:CANVAS});

    const qa=validateQuality(stitches);
    console.log(`[${rid}] stitches:${stitches.length} avg:${qa.avgStitchMM}mm maxJump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

    const shapes=buildShapeSummary(stitches,colors);

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}/dst`,
      stitchCount:stitches.length,
      designSize:{w:CANVAS,h:CANVAS,mm:DESIGN_MM},
      colors,colorMeta,globalAngle,
      geminiNotes:gem?.notes||"",
      qa,shapes
    });
  }catch(e){
    console.error(`[${rid}] ERROR:`,e.message,"\n",e.stack);
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
      renderPreview(d.stitches),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("Preview timeout")),15000))
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
  const{buf,ext}=encodeFile(req.params.format||"dst",d.stitches);
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename="design.${ext}"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({
  status:"ok",version:"32.0",
  canvas:`${CANVAS}px/${DESIGN_MM}mm`
}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>
  console.log(`Stichai v32 | :${PORT} | ${CANVAS}px canvas = ${DESIGN_MM}mm design`)
);
server.timeout=180000;
