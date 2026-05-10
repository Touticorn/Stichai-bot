/**
 * Stichai v36
 * ═══════════════════════════════════════════════════════
 *  3 SURGICAL FIXES from Railway log (v33 → v34)
 * ═══════════════════════════════════════════════════════
 *
 *  FIX 1 — All Gemini models returned 404
 *    Log: "gemini-1.5-flash is not found for API version v1beta"
 *         "gemini-2.0-flash is no longer available to new users"
 *    Root cause: model names outdated. API key is on a tier that
 *    only has access to 2.5-series and 2.0-flash-lite.
 *    Fix: updated model list to current valid names (May 2026).
 *    Also: the API URL uses v1beta which is correct for these models.
 *
 *  FIX 2 — Two diagonal lines in the preview
 *    Root cause: underlay pass jump guard was `jd > TATAMI_UL` (40u).
 *    A jump of 41 units does NOT emit a trim — it just connects
 *    underlay dots with a raw stitch line, visible as a diagonal.
 *    Fix: underlay jumps ALWAYS emit trim records (no threshold).
 *    Also removed the separate underlay pass entirely — underlay
 *    is now interleaved with cover stitches, row by row, so the
 *    needle never travels far between underlay and cover stitch.
 *
 *  FIX 3 — Shape cards still show "0pts"
 *    Root cause: colorCounts was correctly built but the shape
 *    card data was assembled before colorCounts was in scope
 *    in some code paths. Now colorCounts is returned alongside
 *    stitches and always used for the shape summary.
 *    Also fixed: pts now shows STITCH count (meaningful number)
 *    not point count, so "fill · 434pts" appears correctly.
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

/* ─── GEMINI MODELS — correct names as of May 2026 ──────────
   1.x and 2.0 models are SHUT DOWN (return 404).
   Use 2.5-flash (stable alias) → 2.5-flash latest preview → 2.5-pro.
   v1beta URL is correct for all 2.5 models.
*/
const GEMINI_MODELS = [
  "gemini-2.5-flash",                  // stable alias, always latest 2.5-flash
  "gemini-2.5-flash-preview-05-20",    // specific latest preview (May 2026)
  "gemini-2.5-pro",                    // pro fallback
];

/* ─── CANVAS ────────────────────────────────────────────────
   800px canvas = 800 DST units = 80mm design.
   1 pixel === 1 DST unit === 0.1mm. Zero coordinate collapse.
*/
const CANVAS    = 800;
const DESIGN_MM = CANVAS / 10;

/* ─── STITCH CONSTANTS (DST units = 0.1mm) ─────────────────*/
const TATAMI_ROW   = 4;    // 0.40mm row spacing
const TATAMI_LEN   = 30;   // 3.0mm stitch length per segment
const TATAMI_BRICK = 0.5;  // 50% brick offset
const TATAMI_UL    = 40;   // every 40 rows = 4mm underlay spacing
const SATIN_SPACE  = 4;    // 0.40mm satin row spacing (unused in scanline but kept for DST)
const RUN_LEN      = 25;   // 2.5mm running stitch
const PULL         = 2;    // 0.2mm pull compensation
const DST_MAX      = 121;  // 12.1mm max DST move per record

/* ─── RUN WIDTH THRESHOLDS (px = DST units) ─────────────────*/
const R_RUN   = 6;   // ≤6px  → running stitch
const R_SATIN = 70;  // ≤70px → satin  |  >70px → tatami fill

/* ============================================================
   GEMINI HTTP — tries each model, logs exact error per model
   ============================================================ */
async function geminiPost(body, ms = 32000) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const res = await axios.post(url, body, { timeout: ms });
      console.log(`Gemini OK: ${model}`);
      return res;
    } catch (e) {
      const status = e.response?.status;
      const msg    = e.response?.data?.error?.message || e.message;
      console.error(`Gemini ${model} → ${status}: ${msg}`);
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
    .resize(CANVAS, CANVAS, {fit:"contain", background:{r:255,g:255,b:255,alpha:1}})
    .median(2)
    .sharpen({sigma:1.0})
    .normalize()
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

/* ============================================================
   SMART FALLBACK COLOR CLEANUP
   Removes near-background greys, merges near-duplicate darks.
   ============================================================ */
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
  const prompt = `You are a senior machine-embroidery digitizer (Wilcom EmbroideryStudio expert).
Analyze this image and return ONE JSON object for generating a DST embroidery file.

RULES:
1. Background fabric is NEVER a thread color. Skip white, cream, light grey.
2. Only list colors literally visible in the design/artwork itself.
3. stitch_type per Wilcom:
   "fill"    = solid area > 7mm   (large logo bodies, big shapes)
   "satin"   = column 1.5-7mm    (borders, letter strokes)
   "running" = thin line < 1.5mm  (fine outlines, details)
4. recommended_angle: fill row direction degrees (0=horizontal, 45=diagonal, 90=vertical).
5. Return ONLY valid JSON. No markdown. No extra text.

{"background":"#FFFFFF","colors":[{"hex":"#000000","label":"logo","stitch_type":"fill","coverage_pct":60}],"is_logo":true,"is_text":false,"complexity":"simple","recommended_angle":0,"notes":"single black logo on white"}`;

  const res = await geminiPost({
    contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
    generationConfig:{temperature:0.0,maxOutputTokens:4096}
  });
  if(!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    console.log("Gemini raw response:",raw.slice(0,300));  // log first 300 chars for debugging
    let js = raw.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    const p=JSON.parse(js);
    const colors=(p.colors||[]).map(c=>normHex(typeof c==="string"?c:c.hex));
    const meta={};
    for(const c of (p.colors||[]))if(typeof c==="object"&&c.hex)meta[normHex(c.hex)]=c;
    return{colors:dedupe(colors),meta,is_text:!!p.is_text,is_logo:!!p.is_logo,
      angle:Number(p.recommended_angle)||0,complexity:p.complexity||"moderate",notes:p.notes||""};
  }catch(e){console.error("Gemini JSON parse:",e.message);return null;}
}

/* ============================================================
   PIXEL COLOR MAP
   ============================================================ */
async function buildPixelMap(buffer, colors) {
  const Jimp  = require("jimp");
  const image = await Jimp.read(buffer);
  if(image.bitmap.width!==CANVAS||image.bitmap.height!==CANVAS)
    image.resize(CANVAS,CANVAS);

  const labC  = colors.map(c=>rgbToLab(hexToRgb(c)));
  const TOL   = 40;
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

  // 3-pass gap fill for JPEG anti-aliasing
  for(let pass=0;pass<3;pass++){
    for(let y=1;y<CANVAS-1;y++){
      for(let x=1;x<CANVAS-1;x++){
        const idx=y*CANVAS+x;
        if(pixMap[idx]!==-1)continue;
        const nbr=[pixMap[idx-1],pixMap[idx+1],pixMap[idx-CANVAS],pixMap[idx+CANVAS]].filter(n=>n!==-1);
        if(nbr.length>=2){
          const freq={};
          for(const n of nbr)freq[n]=(freq[n]||0)+1;
          const top=Object.entries(freq).sort((a,b)=>+b[1]-+a[1])[0];
          if(top&&+top[1]>=2)pixMap[idx]=+top[0];
        }
      }
    }
  }

  // Log pixel coverage
  const cnt=new Array(colors.length).fill(0); let un=0;
  for(let i=0;i<pixMap.length;i++){if(pixMap[i]>=0)cnt[pixMap[i]]++;else un++;}
  const total=CANVAS*CANVAS;
  console.log("Coverage:",cnt.map((c,i)=>`${normHex(colors[i])}:${(c/total*100).toFixed(1)}%`).join(" "),
    `unmatched:${(un/total*100).toFixed(1)}%`);

  return pixMap;
}

/* ============================================================
   DIRECT PIXEL-SCANLINE STITCH GENERATION  v34
   ════════════════════════════════════════════════════════════
   FIX 2: Underlay is now generated row-by-row alongside cover
   stitches (interleaved), so the needle never makes a long
   naked jump between underlay rows. Every transition between
   disconnected runs always emits a trim record — no threshold.
   ============================================================ */
function generateStitchesFromPixels(pixMap, colors, colorMeta) {
  const stitches    = [];
  const colorCounts = colors.map(()=>({fill:0,satin:0,running:0,underlay:0}));

  // Helper: emit trim (jump+cut) between two positions
  function emitTrim(x0,y0,x1,y1,color){
    stitches.push({x:Math.round(x0),y:Math.round(y0),color,type:"trim"});
    stitches.push({x:Math.round(x1),y:Math.round(y1),color,type:"trim"});
  }

  let globalLastX=-1, globalLastY=-1, globalLastColor=null;

  for(let ci=0;ci<colors.length;ci++){
    const color   = normHex(colors[ci]);
    const gemType = colorMeta?.[color]?.stitch_type;

    // Build run-length map: y → [{x1,x2},...]
    const rowRuns = new Map();
    for(let y=0;y<CANVAS;y++){
      const runs=[]; let s=-1;
      for(let x=0;x<CANVAS;x++){
        const hit=pixMap[y*CANVAS+x]===ci;
        if(hit&&s===-1)s=x;
        if(!hit&&s!==-1){runs.push({x1:s,x2:x-1});s=-1;}
      }
      if(s!==-1)runs.push({x1:s,x2:CANVAS-1});
      if(runs.length)rowRuns.set(y,runs);
    }
    if(!rowRuns.size)continue;

    let lastX = globalLastX;
    let lastY = globalLastY;
    let rowIdx= 0;
    let ulCtr = 0;   // underlay row counter (separate from cover rowIdx)

    // Emit color-change trim from previous color if needed
    if(globalLastColor!==null && globalLastColor!==color && lastX!==-1){
      emitTrim(lastX,lastY,lastX,lastY,color);
      lastX=-1; lastY=-1;
    }

    // Iterate every TATAMI_ROW pixels in Y-space (not array index)
    // This ensures consistent 0.4mm row density regardless of run distribution
    for(let y=0;y<CANVAS;y++){
      // ── UNDERLAY ROW (every TATAMI_UL pixels) ──
      if(y%TATAMI_UL===0){
        const runs=rowRuns.get(y);
        if(runs){
          const rev=ulCtr%2===1;
          const ord=rev?[...runs].reverse():runs;
          for(const{x1,x2} of ord){
            const ux=rev?x2-PULL:x1+PULL;
            const ux2=rev?x1+PULL:x2-PULL;
            // ALWAYS trim before every underlay stitch — zero threshold
            // Any unguarded stitch between runs draws a diagonal line
            if(lastX!==-1){emitTrim(lastX,lastY,ux,y,color);}
            else{stitches.push({x:ux,y,color,type:"trim"});}
            stitches.push({x:ux, y,color,type:"underlay"});
            stitches.push({x:ux2,y,color,type:"underlay"});
            colorCounts[ci].underlay+=2;
            lastX=ux2; lastY=y;
          }
          ulCtr++;
        }
      }

      // ── COVER STITCH ROW (every TATAMI_ROW pixels) ──
      if(y%TATAMI_ROW!==0)continue;
      const runs=rowRuns.get(y);
      if(!runs)continue;

      const rev=rowIdx%2===1;
      const ord=rev?[...runs].reverse():runs;

      for(const{x1,x2} of ord){
        const runW=x2-x1+1;
        const jx  =rev?x2:x1;

        // ALWAYS trim between runs — zero threshold, no raw connecting lines
        if(lastX!==-1){emitTrim(lastX,lastY,jx,y,color);}
        else{stitches.push({x:jx,y,color,type:"trim"});}

        // Classify this run
        let rType=gemType;
        if(!rType){
          if(runW<=R_RUN)        rType="running";
          else if(runW<=R_SATIN) rType="satin";
          else                   rType="fill";
        }

        if(rType==="running"){
          const rx=Math.round((x1+x2)/2);
          stitches.push({x:rx,y,color,type:"running"});
          colorCounts[ci].running++;
          lastX=rx;

        } else if(rType==="satin"){
          const sx=rev?x2-PULL:x1+PULL;
          const ex=rev?x1+PULL:x2-PULL;
          if(Math.abs(ex-sx)>1){
            stitches.push({x:sx,y,color,type:"satin"});
            stitches.push({x:ex,y,color,type:"satin"});
            colorCounts[ci].satin+=2;
            lastX=ex;
          } else {
            const rx=Math.round((x1+x2)/2);
            stitches.push({x:rx,y,color,type:"satin"});
            colorCounts[ci].satin++;
            lastX=rx;
          }

        } else {
          // TATAMI FILL: brick-offset segments across the run
          const brickOff=rowIdx%2===0?0:Math.round(TATAMI_LEN*TATAMI_BRICK);
          const lx=x1+PULL+brickOff;
          const rx=x2-PULL;
          if(rx>lx){
            const steps=Math.max(1,Math.round((rx-lx)/TATAMI_LEN));
            const sx2=rev?rx:lx, ex2=rev?lx:rx;
            for(let s=0;s<=steps;s++){
              const t=s/steps;
              stitches.push({x:Math.round(sx2+(ex2-sx2)*t),y,color,type:"fill"});
              colorCounts[ci].fill++;
            }
            lastX=stitches[stitches.length-1].x;
          } else {
            const rx2=Math.round((x1+x2)/2);
            stitches.push({x:rx2,y,color,type:"fill"});
            colorCounts[ci].fill++;
            lastX=rx2;
          }
        }
        lastY=y;
      }
      rowIdx++;
    }

    globalLastX=lastX;
    globalLastY=lastY;
    globalLastColor=color;
  }

  // Log stitch breakdown
  console.log("Stitches:",colors.map((c,i)=>{
    const k=colorCounts[i];
    return`${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running}`;
  }).join(" | "));

  return {stitches, colorCounts};
}

/* ============================================================
   QUALITY VALIDATION  (skips trim records)
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
  if(avg>50)w.push(`Long avg ${(avg/10).toFixed(1)}mm (max 5mm)`);
  if(avg<8) w.push(`Dense avg ${(avg/10).toFixed(1)}mm (min 0.8mm)`);
  if(maxJ>DST_MAX)w.push(`Jump ${(maxJ/10).toFixed(1)}mm > 12.1mm limit`);
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
    }else{recs.push(stitchRecord(dx,dy));}
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
   Wild-jump guard: skip lines > CANVAS/3 units.
   Satin rendered 2px thick, fill 1px, underlay faint grey.
   ============================================================ */
async function renderPreview(stitches){
  const W=CANVAS,H=CANVAS;
  const buf=Buffer.alloc(W*H*4);
  for(let i=0;i<W*H*4;i+=4){buf[i]=245;buf[i+1]=242;buf[i+2]=235;buf[i+3]=255;}

  const sp=(x,y,r,g,b,t)=>{
    for(let ox=-t;ox<=t;ox++)for(let oy=-t;oy<=t;oy++){
      const px=x+ox,py=y+oy;
      if(px<0||px>=W||py<0||py>=H)return;
      const i2=(py*W+px)*4;buf[i2]=r;buf[i2+1]=g;buf[i2+2]=b;buf[i2+3]=255;
    }
  };
  const ln=(x0,y0,x1,y1,r,g,b,t)=>{
    const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
    let err=dx-dy,x=x0,y=y0;
    for(let guard=0;guard<W+H;guard++){
      sp(x,y,r,g,b,t);
      if(x===x1&&y===y1)break;
      const e2=2*err;
      if(e2>-dy){err-=dy;x+=sx;}
      if(e2<dx) {err+=dx;y+=sy;}
    }
  };

  const MAX_LINE=Math.round(CANVAS/3);
  let prev=null;
  for(const st of stitches){
    if(st.type==="trim"){prev=null;continue;}
    if(prev){
      const dist=Math.hypot(st.x-prev.x,st.y-prev.y);
      if(dist>0.5&&dist<MAX_LINE){
        const dc=st.color||prev.color||"#000000";
        const m=dc.match(/^#([0-9a-fA-F]{6})$/);
        if(m){
          let r=parseInt(m[1].slice(0,2),16);
          let g=parseInt(m[1].slice(2,4),16);
          let b=parseInt(m[1].slice(4,6),16);
          // Underlay: render as faint grey so it doesn't obscure cover
          if(st.type==="underlay"){r=180;g=180;b=180;}
          const thick=st.type==="satin"?2:1;
          ln(prev.x,prev.y,st.x,st.y,r,g,b,thick);
        }
      }
    }
    prev=st;
  }
  return await sharp(buf,{raw:{width:W,height:H,channels:4}}).png().toBuffer();
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

    console.time(`pre-${rid}`);
    const pre=await preprocessImage(req.file.buffer);
    console.timeEnd(`pre-${rid}`);

    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(req.file.buffer,req.file.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={},globalAngle=0;
    if(gem&&gem.colors&&gem.colors.length>=1){
      colors=gem.colors;colorMeta=gem.meta||{};globalAngle=gem.angle||0;
      console.log(`[${rid}] Gemini: [${colors.join(",")}] ${globalAngle}° | ${gem.notes}`);
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

    console.time(`stitch-${rid}`);
    const {stitches,colorCounts}=generateStitchesFromPixels(pixMap,colors,colorMeta);
    console.timeEnd(`stitch-${rid}`);

    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5)return res.status(500).json({error:"No stitchable content — check image contrast"});

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,{stitches,designW:CANVAS,designH:CANVAS});

    const qa=validateQuality(stitches);
    console.log(`[${rid}] cover:${qa.stitchCount} avg:${qa.avgStitchMM}mm maxJump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

    // FIX 3: shape summary uses colorCounts directly — always has real pts values
    const shapes=[];
    for(let i=0;i<colors.length;i++){
      const c=normHex(colors[i]),k=colorCounts[i];
      if(k.fill>0)    shapes.push({type:"fill",   color:c,pts:k.fill});
      if(k.satin>0)   shapes.push({type:"satin",  color:c,pts:k.satin});
      if(k.running>0) shapes.push({type:"running",color:c,pts:k.running});
    }

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}/dst`,
      stitchCount:qa.stitchCount,
      designSize:{w:CANVAS,h:CANVAS,mm:DESIGN_MM},
      colors,colorMeta,globalAngle,
      geminiNotes:gem?.notes||"",
      qa,shapes
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
  if(c&&Date.now()-c.ts<60000){res.setHeader("Content-Type","image/png");return res.send(c.buf);}
  try{
    const png=await Promise.race([
      renderPreview(d.stitches),
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

app.get("/health",(_,res)=>res.json({status:"ok",version:"36.0",canvas:`${CANVAS}px=${DESIGN_MM}mm`}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v36 | :${PORT} | ${CANVAS}px=${DESIGN_MM}mm`));
server.timeout=180000;
