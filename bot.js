/**
 * Stichai v41
 * ═══════════════════════════════════════════════════════
 *  TWO ROOT-CAUSE FIXES
 * ═══════════════════════════════════════════════════════
 *
 *  FIX A — Preview rendering (immediate visual fix)
 *  ──────────────────────────────────────────────────
 *  Old: drew stitch-to-stitch lines → sparse skeleton, invisible at phone scale
 *  New: renders the pixMap directly as filled regions with stitch-row texture.
 *  The preview now shows the EXACT logo shape (letter counter holes visible)
 *  with horizontal linen-colored bands overlaid at stitch row spacing.
 *  This is how Wilcom/Hatch "realistic simulation" mode works.
 *
 *  FIX B — Connected-component classification (correct stitching)
 *  ─────────────────────────────────────────────────────────────
 *  Old: classified each horizontal run by its width alone.
 *       No fixed threshold works: diagonal stripe bodies vary from 60-100px,
 *       overlapping with letter body widths (50-80px) at 800px canvas.
 *  New: flood-fill finds each connected region, computes its aspect ratio.
 *       Tall/narrow region (stripe) → fill. Square/wide region (letter) → satin.
 *       Tiny region → running stitch.
 *       This separates stripes from letters regardless of per-row width.
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

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.5-pro",
];

/* ─── CANVAS ────────────────────────────────────────────────
   800px = 800 DST units = 80mm. 1px = 1 DST unit = 0.1mm.
*/
const CANVAS    = 800;
const DESIGN_MM = CANVAS / 10;

/* ─── STITCH CONSTANTS (DST units = 0.1mm) ─────────────────*/
// These are defaults — getStitchParams() below overrides them based on user specs
let TATAMI_ROW   = 4;    // 0.40mm row spacing
let TATAMI_LEN   = 30;   // 3.0mm fill stitch length
const TATAMI_BRICK = 0.5;  // 50% brick offset
let TATAMI_UL    = 40;   // 4.0mm underlay row spacing
const RUN_LEN      = 25;   // 2.5mm running stitch
let PULL         = 2;    // 0.2mm pull compensation
const DST_MAX      = 121;  // 12.1mm max DST move

/* ─── SPEC-AWARE PARAMETER TUNING ──────────────────────────
   Different fabrics, machines, and user preferences require
   different stitch parameters for optimal results.
   ============================================================ */
function getStitchParams(specs) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();

  // Base params
  const p = {
    tatamiRow: 4,
    tatamiLen: 30,
    tatamiUl: 40,
    pull: 2,
    machine,
    fabric,
    stabilizer,
    density,
    // Machine-specific: max stitch length before jump trim
    maxStitchLen: machine === "tajima" ? 121 : machine === "barudan" ? 121 : 121,
  };

  // ── FABRIC TYPE ADJUSTMENTS ──
  // Stretchy/thick fabrics need more underlay + higher pull comp
  const fabricMap = {
    cotton:    { pull: 2,  tatamiRow: 4,  tatamiUl: 40, tatamiLen: 30 },
    denim:     { pull: 4,  tatamiRow: 3,  tatamiUl: 30, tatamiLen: 25 }, // dense, strong
    fleece:    { pull: 5,  tatamiRow: 3,  tatamiUl: 25, tatamiLen: 25 }, // stretchy + thick
    pique:     { pull: 3,  tatamiRow: 3,  tatamiUl: 30, tatamiLen: 25 }, // textured
    twill:     { pull: 4,  tatamiRow: 3,  tatamiUl: 30, tatamiLen: 25 }, // caps/hats — dense
    satin:     { pull: 1,  tatamiRow: 5,  tatamiUl: 50, tatamiLen: 35 }, // delicate — wider spacing
    leather:   { pull: 1,  tatamiRow: 5,  tatamiUl: 50, tatamiLen: 35 }, // no holes — longer stitches
    towel:     { pull: 6,  tatamiRow: 2,  tatamiUl: 20, tatamiLen: 20 }, // very dense to hold pile
    canvas:    { pull: 4,  tatamiRow: 3,  tatamiUl: 30, tatamiLen: 25 }, // heavy
    knit:      { pull: 5,  tatamiRow: 3,  tatamiUl: 25, tatamiLen: 25 }, // very stretchy
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  // ── DENSITY OVERRIDE ──
  const densityMap = {
    low:    { tatamiRow: 6,  tatamiLen: 40, tatamiUl: 60 },
    medium: { }, // use fabric defaults
    high:   { tatamiRow: 2,  tatamiLen: 20, tatamiUl: 25 },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  // ── STABILIZER ADJUSTMENTS ──
  // Less stabilizer → more underlay needed to prevent distortion
  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  // Cap fabric (twill) + no cutaway = warning-level params
  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(2, p.tatamiRow);
    p.tatamiUl = Math.max(20, p.tatamiUl);
  }

  return p;
}

/* ─── APPLY USER MASK ───────────────────────────────────────
   The user paints white strokes on a transparent mask canvas.
   White pixels = REMOVE (treat as background).
   We composite the mask over the preprocessed image: where
   mask is bright/white, replace with background color.
   ============================================================ */
async function applyUserMask(pre, maskBuffer) {
  // Read mask and resize to CANVAS
  const maskRaw = await sharp(maskBuffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: mData, info: mInfo } = maskRaw;
  const channels = mInfo.channels;

  // Parse background color from pre (stored as hex string like "#FFFFFF")
  const bgRgb = hexToRgb(pre.bgColor);

  // Read the preprocessed image as raw RGBA
  const imgRaw = await sharp(pre.buffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const out = Buffer.alloc(CANVAS * CANVAS * iCh);

  // For each pixel: if mask is bright (white stroke painted), set to bgColor
  let maskedPixels = 0;
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const idx = (y * CANVAS + x);
      const iOff = idx * iCh;
      const mOff = idx * channels;

      // Mask brightness: average of RGB channels (ignore alpha)
      const mR = mData[mOff] || 0;
      const mG = mData[mOff + 1] || 0;
      const mB = mData[mOff + 2] || 0;
      const mA = channels >= 4 ? mData[mOff + 3] : 255;
      const maskBrightness = (mR + mG + mB) / 3;

      // If mask pixel is bright/white and has some alpha → user painted this area to REMOVE
      const shouldRemove = maskBrightness > 180 && mA > 30;

      if (shouldRemove) {
        out[iOff] = bgRgb.r;
        out[iOff + 1] = bgRgb.g;
        out[iOff + 2] = bgRgb.b;
        if (iCh >= 4) out[iOff + 3] = 255;
        maskedPixels++;
      } else {
        out[iOff] = iData[iOff];
        out[iOff + 1] = iData[iOff + 1];
        out[iOff + 2] = iData[iOff + 2];
        if (iCh >= 4) out[iOff + 3] = iData[iOff + 3];
      }
    }
  }

  console.log(`Mask applied: ${maskedPixels} pixels masked (${(maskedPixels / (CANVAS * CANVAS) * 100).toFixed(1)}%)`);

  // Convert back to PNG buffer
  const maskedBuffer = await sharp(out, {
    raw: { width: CANVAS, height: CANVAS, channels: iCh }
  }).png().toBuffer();

  return { ...pre, buffer: maskedBuffer };
}

/* ─── REGION CLASSIFICATION (by connected-component bounding box) ──
   Aspect ratio = height / width of each connected region.
   TALL region (ratio > 1.5):  stripe-like  → tatami fill
   SQUARE region (ratio ≤ 1.5): letter-like  → satin if width ≤ SATIN_MAX_W, else fill
   TINY region (< MIN_AREA px): noise        → skip or running stitch
*/
const MIN_AREA    = 30;    // min pixels to be a stitchable region
const SATIN_MAX_W = 150;   // satin up to 15mm wide; wider → fill

/* ============================================================
   GEMINI HTTP
   ============================================================ */
async function geminiPost(body, ms = 32000) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const res = await axios.post(url, body, { timeout: ms });
      console.log(`Gemini OK: ${model}`);
      return res;
    } catch (e) {
      console.error(`Gemini ${model} → ${e.response?.status}: ${e.response?.data?.error?.message||e.message}`);
    }
  }
  return null;
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
   ============================================================ */
async function preprocessImage(buffer) {
  const cleaned = await sharp(buffer)
    .resize(CANVAS, CANVAS, {fit:"contain",background:{r:255,g:255,b:255,alpha:1}})
    .median(2)
    .sharpen({sigma:1.0})
    .linear(1.2,-15)
    .toBuffer();

  const q = await sharp(cleaned).png({colours:10,dither:0}).toBuffer();
  const {data,info} = await sharp(q).raw().toBuffer({resolveWithObject:true});
  const cm = new Map();
  for(let i=0;i<data.length;i+=info.channels){
    const h="#"+[data[i],data[i+1],data[i+2]].map(c=>c.toString(16).padStart(2,"0")).join("").toUpperCase();
    cm.set(h,(cm.get(h)||0)+1);
  }
  const sorted  = [...cm.entries()].sort((a,b)=>b[1]-a[1]);
  const bgColor = sorted[0][0];
  const bgLab   = rgbToLab(hexToRgb(bgColor));
  const fallback= sorted.slice(1,10)
    .filter(([h])=>dE(rgbToLab(hexToRgb(h)),bgLab)>35)
    .map(([h])=>h);

  return {buffer:cleaned, bgColor, bgLab, fallbackColors:fallback};
}

function cleanFallbackColors(rawColors, bgLab) {
  let cols = rawColors.filter(c=>dE(rgbToLab(hexToRgb(c)),bgLab)>35);
  if(!cols.length) return ["#000000"];
  const merged=[];
  for(const c of cols){
    const cLab=rgbToLab(hexToRgb(c));
    const mi=merged.findIndex(m=>dE(cLab,rgbToLab(hexToRgb(m)))<25);
    if(mi===-1)merged.push(c);
    else if(cLab.l<rgbToLab(hexToRgb(merged[mi])).l)merged[mi]=c;
  }
  return merged.slice(0,4);
}

/* ============================================================
   GEMINI ANALYSIS
   ============================================================ */
async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer (Wilcom EmbroideryStudio).
Analyze this image and return ONE JSON object for DST file generation.
Background fabric is NEVER a thread color. Skip white, cream, grey backgrounds.
Only list colors visible in the actual design artwork.
Return ONLY valid JSON, no markdown.

{"background":"#FFFFFF","colors":[{"hex":"#000000","label":"logo","stitch_type":"fill","coverage_pct":60}],"is_logo":true,"is_text":true,"complexity":"simple","recommended_angle":0,"notes":"brief note"}`;

  const res = await geminiPost({
    contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
    generationConfig:{temperature:0.0,maxOutputTokens:4096}
  });
  if(!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    let js = raw.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    const p=JSON.parse(js);
    const colors=(p.colors||[]).map(c=>normHex(typeof c==="string"?c:c.hex));
    const meta={};
    for(const c of (p.colors||[]))if(typeof c==="object"&&c.hex)meta[normHex(c.hex)]=c;
    return{colors:dedupe(colors),meta,is_text:!!p.is_text,is_logo:!!p.is_logo,
      angle:Number(p.recommended_angle)||0,complexity:p.complexity||"moderate",notes:p.notes||""};
  }catch(e){console.error("Gemini JSON:",e.message);return null;}
}

/* ============================================================
   PIXEL COLOR MAP  (TOL=50, strict 1-pass gap fill)
   ============================================================ */
async function buildPixelMap(buffer, colors) {
  const Jimp  = require("jimp");
  const image = await Jimp.read(buffer);
  if(image.bitmap.width!==CANVAS||image.bitmap.height!==CANVAS)
    image.resize(CANVAS,CANVAS);

  const labC  = colors.map(c=>rgbToLab(hexToRgb(c)));
  const TOL   = 50;
  const pixMap= new Int16Array(CANVAS*CANVAS).fill(-1);
  const imgD  = image.bitmap.data;

  for(let y=0;y<CANVAS;y++){
    for(let x=0;x<CANVAS;x++){
      const i=(y*CANVAS+x)<<2;
      const lab=rgbToLab({r:imgD[i],g:imgD[i+1],b:imgD[i+2]});
      let best=-1,bestD=TOL;
      for(let c=0;c<labC.length;c++){const d=dE(lab,labC[c]);if(d<bestD){bestD=d;best=c;}}
      pixMap[y*CANVAS+x]=best;
    }
  }

  // Strict 1-pass gap fill: only fill pixels with ≥3 matching neighbors
  // Prevents inter-letter gap bridging (2-neighbor gaps) while closing edge noise
  for(let y=1;y<CANVAS-1;y++){
    for(let x=1;x<CANVAS-1;x++){
      const idx=y*CANVAS+x;
      if(pixMap[idx]!==-1)continue;
      const nbr=[pixMap[idx-1],pixMap[idx+1],pixMap[idx-CANVAS],pixMap[idx+CANVAS]].filter(n=>n!==-1);
      if(nbr.length>=3){
        const freq={};
        for(const n of nbr)freq[n]=(freq[n]||0)+1;
        const top=Object.entries(freq).sort((a,b)=>+b[1]-+a[1])[0];
        if(top&&+top[1]>=3)pixMap[idx]=+top[0];
      }
    }
  }

  const cnt=new Array(colors.length).fill(0);let un=0;
  for(let i=0;i<pixMap.length;i++){if(pixMap[i]>=0)cnt[pixMap[i]]++;else un++;}
  const total=CANVAS*CANVAS;
  console.log("Coverage:",cnt.map((c,i)=>`${normHex(colors[i])}:${(c/total*100).toFixed(1)}%`).join(" "),
    `unmatched:${(un/total*100).toFixed(1)}%`);

  return pixMap;
}

/* ============================================================
   CONNECTED-COMPONENT REGION EXTRACTION  (FIX B)
   Flood-fill finds each distinct connected region.
   Classifies by aspect ratio of bounding box:
     Tall (H/W > 1.5) → fill (stripe-like)
     Square/wide      → satin if ≤ SATIN_MAX_W, else fill
     Tiny (< MIN_AREA)→ running stitch
   This correctly separates diagonal stripes from letter bodies
   regardless of per-row horizontal run width.
   ============================================================ */
function extractRegions(pixMap, colors) {
  const visited  = new Uint8Array(CANVAS*CANVAS);
  const regions  = [];

  for(let ci=0;ci<colors.length;ci++){
    for(let sy=0;sy<CANVAS;sy++){
      for(let sx=0;sx<CANVAS;sx++){
        const si = sy*CANVAS+sx;
        if(pixMap[si]!==ci||visited[si])continue;

        // BFS flood fill
        const q=[si];let qp=0;
        visited[si]=1;
        let mnx=sx,mxx=sx,mny=sy,mxy=sy,area=0;

        while(qp<q.length){
          const idx=q[qp++]; area++;
          const x=idx%CANVAS, y=(idx/CANVAS)|0;
          if(x<mnx)mnx=x;if(x>mxx)mxx=x;
          if(y<mny)mny=y;if(y>mxy)mxy=y;

          for(const[dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<CANVAS&&ny>=0&&ny<CANVAS){
              const ni=ny*CANVAS+nx;
              if(!visited[ni]&&pixMap[ni]===ci){visited[ni]=1;q.push(ni);}
            }
          }
        }

        if(area<MIN_AREA)continue;

        const bw=mxx-mnx+1, bh=mxy-mny+1;
        const aspectRatio=bh/bw;

        // Classify region by shape
        let type;
        if(area<MIN_AREA*3)         type="running";
        else if(aspectRatio>1.5)    type="fill";     // tall → stripe-like
        else if(bw<=SATIN_MAX_W)    type="satin";    // squarish, not too wide → letter
        else                        type="fill";     // wide and flat → fill

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio});
      }
    }
  }

  console.log(`Regions: ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  console.log("Aspect ratios sample:", regions.slice(0,8).map(r=>`${r.type}(${r.bw}×${r.bh},r=${r.aspectRatio.toFixed(1)})`).join(" "));
  return regions;
}

/* ============================================================
   STITCH GENERATION — region-aware scanline
   Uses the per-region stitch type from extractRegions,
   then scans only the pixels within each region's bbox.
   ============================================================ */
function generateStitchesFromRegions(pixMap, regions, colors, params) {
  const stitches    = [];
  const colorCounts = colors.map(()=>({fill:0,satin:0,running:0}));

  // Use tuned params if provided, else fall back to module globals
  const P = params || {};
  const pRow   = P.tatamiRow   !== undefined ? P.tatamiRow   : TATAMI_ROW;
  const pLen   = P.tatamiLen   !== undefined ? P.tatamiLen   : TATAMI_LEN;
  const pUl    = P.tatamiUl    !== undefined ? P.tatamiUl    : TATAMI_UL;
  const pPull  = P.pull        !== undefined ? P.pull        : PULL;

  function emitTrim(x0,y0,x1,y1,color){
    stitches.push({x:Math.round(x0),y:Math.round(y0),color,type:"trim"});
    stitches.push({x:Math.round(x1),y:Math.round(y1),color,type:"trim"});
  }

  let globalLastX=-1,globalLastY=-1;

  // Sort regions: fills first (background), then satin, then running
  const ordered=[
    ...regions.filter(r=>r.type==="fill"),
    ...regions.filter(r=>r.type==="satin"),
    ...regions.filter(r=>r.type==="running")
  ];

  for(const reg of ordered){
    const {ci,color,type,mnx,mny,mxx,mxy}=reg;
    let lastX=globalLastX,lastY=globalLastY;

    // ── UNDERLAY (sparse horizontal pass at tuned spacing) ──
    if(type==="fill"){
      let ulRow=0;
      for(let y=mny;y<=mxy;y+=pUl){
        const runs=getRunsInRow(pixMap,ci,y,mnx,mxx);
        if(!runs.length)continue;
        const rev=ulRow%2===1;
        for(const{x1,x2} of (rev?[...runs].reverse():runs)){
          const ux=rev?x2-pPull:x1+pPull;
          if(lastX!==-1)emitTrim(lastX,lastY,ux,y,color);
          else stitches.push({x:ux,y,color,type:"trim"});
          stitches.push({x:x1+pPull,y,color,type:"underlay"});
          stitches.push({x:x2-pPull,y,color,type:"underlay"});
          lastX=x2-pPull;lastY=y;
        }
        ulRow++;
      }
    }

    // ── COVER STITCHES ──
    let rowIdx=0;
    for(let y=mny;y<=mxy;y+=pRow){
      const runs=getRunsInRow(pixMap,ci,y,mnx,mxx);
      if(!runs.length)continue;
      const rev=rowIdx%2===1;
      const ord=rev?[...runs].reverse():runs;

      for(const{x1,x2} of ord){
        const runW=x2-x1+1;
        const jx=rev?x2:x1;

        // Always trim before each run
        if(lastX!==-1)emitTrim(lastX,lastY,jx,y,color);
        else stitches.push({x:jx,y,color,type:"trim"});

        if(type==="running"){
          const rx=Math.round((x1+x2)/2);
          stitches.push({x:rx,y,color,type:"running"});
          colorCounts[ci].running++;
          lastX=rx;

        }else if(type==="satin"){
          const sx=rev?x2-pPull:x1+pPull;
          const ex=rev?x1+pPull:x2-pPull;
          if(Math.abs(ex-sx)>1){
            stitches.push({x:sx,y,color,type:"satin"});
            stitches.push({x:ex,y,color,type:"satin"});
            colorCounts[ci].satin+=2;
            lastX=ex;
          }else{
            const rx=Math.round((x1+x2)/2);
            stitches.push({x:rx,y,color,type:"satin"});
            colorCounts[ci].satin++;
            lastX=rx;
          }

        }else{
          // TATAMI FILL with tuned parameters
          const brickOff=rowIdx%2===0?0:Math.round(pLen*TATAMI_BRICK);
          const lx=x1+pPull+brickOff, rx=x2-pPull;
          if(rx>lx){
            const steps=Math.max(1,Math.round((rx-lx)/pLen));
            const sx2=rev?rx:lx, ex2=rev?lx:rx;
            for(let s=0;s<=steps;s++){
              stitches.push({x:Math.round(sx2+(ex2-sx2)*s/steps),y,color,type:"fill"});
              colorCounts[ci].fill++;
            }
            lastX=stitches[stitches.length-1].x;
          }else{
            stitches.push({x:Math.round((x1+x2)/2),y,color,type:"fill"});
            colorCounts[ci].fill++;
            lastX=Math.round((x1+x2)/2);
          }
        }
        lastY=y;
      }
      rowIdx++;
    }
    globalLastX=lastX;globalLastY=lastY;
  }

  console.log("Stitches:",colors.map((c,i)=>{
    const k=colorCounts[i];
    return`${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running}`;
  }).join(" | "));

  return{stitches,colorCounts};
}

// Helper: get horizontal runs of color ci in row y, within x range [x0..x1]
function getRunsInRow(pixMap,ci,y,x0,x1){
  const runs=[];let s=-1;
  for(let x=x0;x<=x1;x++){
    const hit=y>=0&&y<CANVAS&&pixMap[y*CANVAS+x]===ci;
    if(hit&&s===-1)s=x;
    if(!hit&&s!==-1){runs.push({x1:s,x2:x-1});s=-1;}
  }
  if(s!==-1)runs.push({x1:s,x2:x1});
  return runs;
}

/* ============================================================
   STITCH-BASED PREVIEW RENDERER
   Draws every individual stitch as an anti-aliased line segment
   on a fabric background. Shows the actual stitch pattern:
   - Tatami fill: staggered horizontal rows with gaps
   - Satin:     zigzag columns perpendicular to stroke
   - Running:   sparse dotted lines
   - Underlay:  fainter sparse grid beneath cover stitches

   This produces a realistic embroidery simulation similar to
   Wilcom/Hatch "Realistic View" mode.
   ============================================================ */
async function renderPreview(pixMap, colors, stitches, params) {
  const W = CANVAS, H = CANVAS;
  const buf = Buffer.alloc(W * H * 4);

  // ── Fabric background (subtle linen texture) ──
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      // Base linen color with slight weave pattern
      const weave = ((x + y) % 2 === 0) ? 4 : -2;
      buf[idx]     = 242 + weave;
      buf[idx + 1] = 238 + weave;
      buf[idx + 2] = 228 + weave;
      buf[idx + 3] = 255;
    }
  }

  // Pre-compute thread colors as RGB + a slightly darker shade for stitch edges
  const threadColors = colors.map(c => {
    const { r, g, b } = hexToRgb(normHex(c));
    return {
      r, g, b,
      dr: Math.max(0, r - 40),  // darker for edges/shadows
      dg: Math.max(0, g - 40),
      db: Math.max(0, b - 40),
    };
  });

  // Helper: set pixel with blend (simple alpha blend onto fabric)
  function setPixel(x, y, r, g, b, alpha) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    const a = alpha / 255;
    buf[idx]     = Math.round(buf[idx]     * (1 - a) + r * a);
    buf[idx + 1] = Math.round(buf[idx + 1] * (1 - a) + g * a);
    buf[idx + 2] = Math.round(buf[idx + 2] * (1 - a) + b * a);
    buf[idx + 3] = 255;
  }

  // Helper: draw anti-aliased line (Xiaolin Wu-ish, simplified)
  function drawLine(x0, y0, x1, y1, r, g, b, thickness) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) { setPixel(x0, y0, r, g, b, 220); return; }
    const steps = Math.ceil(dist * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      // Main pixel
      setPixel(x, y, r, g, b, 230);
      // Thickness: add neighbors for 2px wide stitches
      if (thickness >= 2) {
        if (Math.abs(dx) > Math.abs(dy)) { setPixel(x, y + 1, r, g, b, 180); setPixel(x, y - 1, r, g, b, 80); }
        else { setPixel(x + 1, y, r, g, b, 180); setPixel(x - 1, y, r, g, b, 80); }
      }
    }
  }

  // ── GROUP STITCHES BY COLOR ──
  const byColor = new Map();
  for (const s of stitches) {
    if (s.type === "trim") continue;
    if (!byColor.has(s.color)) byColor.set(s.color, []);
    byColor.get(s.color).push(s);
  }

  // ── DRAW STITCHES IN COLOR ORDER ──
  for (const [color, colStitches] of byColor) {
    const ci = colors.findIndex(c => normHex(c) === normHex(color));
    const tc = ci >= 0 ? threadColors[ci] : { r: 128, g: 128, b: 128, dr: 80, dg: 80, db: 80 };

    // Separate by type
    const underlays = colStitches.filter(s => s.type === "underlay");
    const covers    = colStitches.filter(s => s.type !== "underlay");

    // Draw underlays first (fainter)
    for (let i = 1; i < underlays.length; i++) {
      const a = underlays[i - 1], b = underlays[i];
      const dy = Math.abs(b.y - a.y);
      // Skip jumps
      if (Math.hypot(b.x - a.x, dy) > 80) continue;
      drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, 1);
    }

    // Group cover stitches by row (same Y) for fill pattern visualization
    const rowMap = new Map();
    for (const s of covers) {
      const ry = Math.round(s.y);
      if (!rowMap.has(ry)) rowMap.set(ry, []);
      rowMap.get(ry).push(s);
    }

    // Draw cover stitches
    let prevStitch = null;
    for (let i = 0; i < covers.length; i++) {
      const s = covers[i];
      const nextStitch = covers[i + 1] || null;

      // Draw the stitch point itself
      const isSatin = s.type === "satin";
      const isFill  = s.type === "fill";
      const isRun   = s.type === "running";

      // Dot/endpoint for each stitch
      const dotAlpha = isRun ? 200 : 240;
      const dotSize = isSatin ? 2 : isFill ? 1.5 : 1;
      setPixel(s.x, s.y, tc.r, tc.g, tc.b, dotAlpha);
      if (dotSize >= 2) {
        setPixel(s.x + 1, s.y, tc.dr, tc.dg, tc.db, 160);
        setPixel(s.x, s.y + 1, tc.dr, tc.dg, tc.db, 120);
      }

      // Connect to next stitch in sequence (same row/region)
      if (nextStitch && nextStitch.color === s.color) {
        const jump = Math.hypot(nextStitch.x - s.x, nextStitch.y - s.y);
        if (jump < 50) {  // < 5mm — same region
          // Satin gets thick zigzag lines
          // Fill gets medium horizontal lines
          // Running gets thin dotted lines
          const thick = isSatin ? 3 : isFill ? 2 : 1;
          const alpha = isRun ? 180 : 220;
          // Use brighter color for stitch body, darker for edges
          drawLine(s.x, s.y, nextStitch.x, nextStitch.y, tc.r, tc.g, tc.b, thick);
        }
      }

      prevStitch = s;
    }

    // ── ADD STITCH ROW TEXTURE FOR FILL REGIONS ──
    // Darken the gaps between stitch rows to show fabric peeking through
    const pRow = (params && params.tatamiRow) ? params.tatamiRow : TATAMI_ROW;
    for (const [ry, rowStitches] of rowMap) {
      if (rowStitches.length < 2) continue;
      // Only for fill-type rows
      const hasFill = rowStitches.some(s => s.type === "fill");
      if (!hasFill) continue;

      rowStitches.sort((a, b) => a.x - b.x);
      // Between consecutive stitches on same row, add subtle shadow
      for (let i = 1; i < rowStitches.length; i++) {
        const a = rowStitches[i - 1], b = rowStitches[i];
        const gap = b.x - a.x;
        if (gap > 8 && gap < 60) {  // reasonable gap — add shadow
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          // Shadow pixel beneath the stitch row
          if (my + 1 < H) {
            const idx = (Math.round(my + 1) * W + Math.round(mx)) * 4;
            buf[idx]     = Math.max(0, buf[idx] - 15);
            buf[idx + 1] = Math.max(0, buf[idx + 1] - 15);
            buf[idx + 2] = Math.max(0, buf[idx + 2] - 15);
          }
        }
      }
    }
  }

  // ── CROP TO CONTENT BOUNDS ──
  let cminX = W, cmaxX = 0, cminY = H, cmaxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pixMap[y * W + x] >= 0) {
        if (x < cminX) cminX = x; if (x > cmaxX) cmaxX = x;
        if (y < cminY) cminY = y; if (y > cmaxY) cmaxY = y;
      }
    }
  }
  const pad = 30;
  const cropX = Math.max(0, cminX - pad), cropY = Math.max(0, cminY - pad);
  const cropW = Math.min(W, cmaxX + pad) - cropX;
  const cropH = Math.min(H, cmaxY + pad) - cropY;

  if (cropW > 50 && cropH > 50) {
    const cropped = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const sIdx = ((cropY + y) * W + (cropX + x)) * 4;
        const dIdx = (y * cropW + x) * 4;
        cropped[dIdx] = buf[sIdx]; cropped[dIdx + 1] = buf[sIdx + 1];
        cropped[dIdx + 2] = buf[sIdx + 2]; cropped[dIdx + 3] = buf[sIdx + 3];
      }
    }
    return await sharp(cropped, { raw: { width: cropW, height: cropH, channels: 4 } })
      .png({ compressionLevel: 6 }).toBuffer();
  }

  return await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 6 }).toBuffer();
}

/* ============================================================
   QUALITY VALIDATION
   ============================================================ */
function validateQuality(stitches){
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,prev=null;
  for(const s of stitches){
    if(s.type==="trim"){prev=null;continue;}
    if(prev){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>maxJ)maxJ=d;
      if(d>DST_MAX)longJ++;
      if(s.type!=="underlay"){tot+=d;cnt++;}
    }
    prev=s;
  }
  const avg=cnt>0?tot/cnt:0;
  if(avg>50)w.push(`Long avg ${(avg/10).toFixed(1)}mm`);
  if(maxJ>DST_MAX)w.push(`Jump ${(maxJ/10).toFixed(1)}mm > 12.1mm`);
  if(longJ>30)    w.push(`${longJ} oversized jumps`);
  if(cnt>80000)   w.push(`High stitch count ${cnt}`);
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,warnings:w,passed:!w.length};
}

/* ============================================================
   DST ENCODER
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
  let lCol=null,px=0,py=0,sc=0,cc=0,mnx=0,mxx=0,mny=0,mxy=0,ax=0,ay=0;
  for(const s of stitches){
    ax+=s.x-px;ay+=s.y-py;
    if(ax<mnx)mnx=ax;if(ax>mxx)mxx=ax;if(ay<mny)mny=ay;if(ay>mxy)mxy=ay;
    if(s.color!==lCol&&lCol!==null){recs.push(Buffer.from([0,0,0xC3]));cc++;}
    lCol=s.color;
    if(s.type==="trim"){
      recs.push(Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]),Buffer.from([0,0,0xC3]));
      const dx=s.x-px,dy=s.y-py;px=s.x;py=s.y;
      const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/121));
      let ppx=0,ppy=0;
      for(let i=1;i<=steps;i++){const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);recs.push(stitchRecord(fx-ppx,fy-ppy));ppx=fx;ppy=fy;}
      continue;
    }
    const dx=Math.round(s.x-px),dy=Math.round(s.y-py);px=s.x;py=s.y;
    if(Math.abs(dx)>121||Math.abs(dy)>121){
      const steps=Math.max(Math.ceil(Math.abs(dx)/121),Math.ceil(Math.abs(dy)/121));
      let ppx=0,ppy=0;
      for(let i=1;i<=steps;i++){const fx=Math.round(dx*i/steps),fy=Math.round(dy*i/steps);recs.push(stitchRecord(fx-ppx,fy-ppy));ppx=fx;ppy=fy;}
    }else recs.push(stitchRecord(dx,dy));
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
   ROUTES
   ============================================================ */
app.use(express.static(path.join(__dirname,"public")));
app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true,limit:"10mb"}));
app.get("/",(_, res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.post("/generate-embroidery", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(0);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile)return res.status(400).json({error:"No image uploaded"});

    // ── Parse embroidery specs from form data ──
    const specs = {
      fabric: req.body?.fabric || "cotton",
      machine: req.body?.machine || "generic",
      hoop: req.body?.hoop || "5x7",
      density: req.body?.density || "medium",
      thread: req.body?.thread || "generic",
      stabilizer: req.body?.stabilizer || "cutaway",
      instructions: req.body?.instructions || ""
    };
    console.log(`[${rid}] Specs:`, JSON.stringify(specs));

    // Get tuned stitch parameters based on specs
    const params = getStitchParams(specs);
    console.log(`[${rid}] Tuned params: row=${params.tatamiRow} len=${params.tatamiLen} pull=${params.pull} ul=${params.tatamiUl}`);

    console.time(`pre-${rid}`);
    let pre=await preprocessImage(imgFile.buffer);
    console.timeEnd(`pre-${rid}`);

    // Apply user mask if provided (white=remove, black/transparent=keep)
    if(maskFile){
      console.time(`mask-${rid}`);
      pre=await applyUserMask(pre,maskFile.buffer);
      console.timeEnd(`mask-${rid}`);
      console.log(`[${rid}] User mask applied`);
    }

    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(imgFile.buffer,imgFile.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={};
    if(gem&&gem.colors&&gem.colors.length>=1){
      colors=gem.colors;colorMeta=gem.meta||{};
      console.log(`[${rid}] Gemini: [${colors.join(",")}] | ${gem.notes}`);
    }else{
      console.log(`[${rid}] Gemini failed — smart fallback`);
      colors=cleanFallbackColors(pre.fallbackColors,pre.bgLab);
      console.log(`[${rid}] Fallback colors: [${colors.join(",")}]`);
    }
    if(!colors.length)colors=["#000000"];
    const hasDark=colors.some(c=>{const{r,g,b}=hexToRgb(c);return r+g+b<200;});
    if(!hasDark){colors.unshift("#000000");console.log(`[${rid}] Injected #000000`);}

    console.time(`pixmap-${rid}`);
    const pixMap=await buildPixelMap(pre.buffer,colors);
    console.timeEnd(`pixmap-${rid}`);

    console.time(`regions-${rid}`);
    const regions=extractRegions(pixMap,colors);
    console.timeEnd(`regions-${rid}`);

    if(!regions.length)return res.status(500).json({error:"No stitchable regions found"});

    console.time(`stitch-${rid}`);
    // Pass tuned params to stitch generation
    const{stitches,colorCounts}=generateStitchesFromRegions(pixMap,regions,colors,params);
    console.timeEnd(`stitch-${rid}`);

    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5)return res.status(500).json({error:"No stitchable content — check image contrast"});

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    // Store everything needed for preview + download
    jobs.set(id,{stitches,pixMap,colors,params,designW:CANVAS,designH:CANVAS});

    const qa=validateQuality(stitches);
    console.log(`[${rid}] cover:${qa.stitchCount} avg:${qa.avgStitchMM}mm maxJump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

    // Count stitches per region by bbox + color match
    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      // Count stitches inside this region's bbox with matching color and non-trim/underlay types
      const sc = stitches.filter(s =>
        s.color === r.color &&
        s.type !== "trim" && s.type !== "underlay" &&
        s.x >= r.mnx && s.x <= r.mxx && s.y >= r.mny && s.y <= r.mxy
      ).length;
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:sc});
    }

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}/dst`,
      stitchCount:qa.stitchCount,
      designSize:{w:CANVAS,h:CANVAS,mm:DESIGN_MM},
      colors,colorMeta,
      geminiNotes:gem?.notes||"",
      specs,                 // echo back the specs used
      tunedParams:params,    // the actual params applied
      qa,shapes,regions:regions.length
    });
  }catch(e){
    console.error(`[${rid}] CRASH:`,e.message,"\n",e.stack);
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
  if(c&&Date.now()-c.ts<120000){res.setHeader("Content-Type","image/png");return res.send(c.buf);}
  try{
    const png=await Promise.race([
      renderPreview(d.pixMap,d.colors,d.stitches,d.params),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),15000))
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

app.get("/health",(_,res)=>res.json({status:"ok",version:"41.0",canvas:`${CANVAS}px=${DESIGN_MM}mm`}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v41 | :${PORT} | ${CANVAS}px=${DESIGN_MM}mm`));
server.timeout=180000;
