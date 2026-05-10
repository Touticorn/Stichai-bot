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
const TATAMI_ROW   = 4;    // 0.40mm row spacing
const TATAMI_LEN   = 30;   // 3.0mm fill stitch length
const TATAMI_BRICK = 0.5;  // 50% brick offset
const TATAMI_UL    = 40;   // 4.0mm underlay row spacing
const RUN_LEN      = 25;   // 2.5mm running stitch
const PULL         = 2;    // 0.2mm pull compensation
const DST_MAX      = 121;  // 12.1mm max DST move

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
function generateStitchesFromRegions(pixMap, regions, colors) {
  const stitches    = [];
  const colorCounts = colors.map(()=>({fill:0,satin:0,running:0}));

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

    // ── UNDERLAY (sparse horizontal pass at perpendicular spacing) ──
    if(type==="fill"){
      let ulRow=0;
      for(let y=mny;y<=mxy;y+=TATAMI_UL){
        const runs=getRunsInRow(pixMap,ci,y,mnx,mxx);
        if(!runs.length)continue;
        const rev=ulRow%2===1;
        for(const{x1,x2} of (rev?[...runs].reverse():runs)){
          const ux=rev?x2-PULL:x1+PULL;
          if(lastX!==-1)emitTrim(lastX,lastY,ux,y,color);
          else stitches.push({x:ux,y,color,type:"trim"});
          stitches.push({x:x1+PULL,y,color,type:"underlay"});
          stitches.push({x:x2-PULL,y,color,type:"underlay"});
          lastX=x2-PULL;lastY=y;
        }
        ulRow++;
      }
    }

    // ── COVER STITCHES ──
    let rowIdx=0;
    for(let y=mny;y<=mxy;y+=TATAMI_ROW){
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
          const sx=rev?x2-PULL:x1+PULL;
          const ex=rev?x1+PULL:x2-PULL;
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
          // TATAMI FILL
          const brickOff=rowIdx%2===0?0:Math.round(TATAMI_LEN*TATAMI_BRICK);
          const lx=x1+PULL+brickOff, rx=x2-PULL;
          if(rx>lx){
            const steps=Math.max(1,Math.round((rx-lx)/TATAMI_LEN));
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
   PREVIEW RENDERER  —  FIX A: pixMap-based realistic preview
   Renders the exact stitched pixel map with stitch-row texture.
   Shows correct logo shape (letter counter holes visible),
   no sparse line artifacts, no threshold ambiguity.
   ============================================================ */
async function renderPreview(pixMap, colors) {
  const buf = Buffer.alloc(CANVAS*CANVAS*4);

  // Linen background
  for(let i=0;i<CANVAS*CANVAS*4;i+=4){buf[i]=242;buf[i+1]=238;buf[i+2]=228;buf[i+3]=255;}

  // Pre-compute thread colors as RGB arrays
  const rgbs = colors.map(c=>{const{r,g,b}=hexToRgb(normHex(c));return[r,g,b];});

  // Paint every stitched pixel with its thread color
  for(let y=0;y<CANVAS;y++){
    for(let x=0;x<CANVAS;x++){
      const ci=pixMap[y*CANVAS+x];
      if(ci<0)continue;
      const[r,g,b]=rgbs[ci];
      const idx=(y*CANVAS+x)*4;
      buf[idx]=r;buf[idx+1]=g;buf[idx+2]=b;buf[idx+3]=255;
    }
  }

  // Overlay stitch-row texture: every TATAMI_ROW-th row gets a lighter band
  // (simulates the gap between parallel stitch rows on fabric)
  for(let y=0;y<CANVAS;y++){
    if(y%TATAMI_ROW!==0)continue;
    for(let x=0;x<CANVAS;x++){
      const ci=pixMap[y*CANVAS+x];
      if(ci<0)continue;
      const idx=(y*CANVAS+x)*4;
      // Lighten this row to simulate thread sheen on stitch rows
      buf[idx]=Math.min(255,buf[idx]+20);
      buf[idx+1]=Math.min(255,buf[idx+1]+20);
      buf[idx+2]=Math.min(255,buf[idx+2]+20);
    }
  }

  // Darker alternating rows simulate thread shadows between stitches
  for(let y=0;y<CANVAS;y++){
    if(y%TATAMI_ROW!==TATAMI_ROW-1)continue;
    for(let x=0;x<CANVAS;x++){
      const ci=pixMap[y*CANVAS+x];
      if(ci<0)continue;
      const idx=(y*CANVAS+x)*4;
      buf[idx]=Math.max(0,buf[idx]-10);
      buf[idx+1]=Math.max(0,buf[idx+1]-10);
      buf[idx+2]=Math.max(0,buf[idx+2]-10);
    }
  }

  // Draw visible stitch direction lines for fill regions
  const seenRows=new Set();
  for(const st of stitches){
    if(st.type!=="fill")continue;
    const py=Math.round((st.y-OFFSET)*PIXEL_SCALE);
    if(py<0||py>=CANVAS)continue;
    const key=`${st.color}_${py}`;
    if(seenRows.has(key))continue;
    seenRows.add(key);
    const rowStitches=stitches.filter(s=>s.type==="fill"&&s.color===st.color&&Math.abs(s.y-st.y)<0.5);
    if(rowStitches.length<2)continue;
    rowStitches.sort((a,b)=>a.x-b.x);
    for(let i=1;i<rowStitches.length;i++){
      const x1=Math.round((rowStitches[i-1].x-OFFSET)*PIXEL_SCALE);
      const x2=Math.round((rowStitches[i].x-OFFSET)*PIXEL_SCALE);
      if(x2<x1||x1<0||x2>=CANVAS)continue;
      const[cr,cg,cb]=hexToRgb(st.color);
      const lr=Math.max(0,cr-50),lg=Math.max(0,cg-50),lb=Math.max(0,cb-50);
      for(let lx=x1;lx<=x2;lx++){
        if(lx>=0&&lx<CANVAS&&py>=0&&py<CANVAS){
          const idx=(py*CANVAS+lx)*4;
          buf[idx]=lr;buf[idx+1]=lg;buf[idx+2]=lb;buf[idx+3]=255;
        }
      }
    }
  }

  // Crop preview to content bounds
  let cminX=CANVAS,cmaxX=0,cminY=CANVAS,cmaxY=0;
  for(let y=0;y<CANVAS;y++){
    for(let x=0;x<CANVAS;x++){
      if(pixMap[y*CANVAS+x]>=0){
        if(x<cminX)cminX=x;if(x>cmaxX)cmaxX=x;
        if(y<cminY)cminY=y;if(y>cmaxY)cmaxY=y;
      }
    }
  }
  const pad=20;
  const cropX=Math.max(0,cminX-pad),cropY=Math.max(0,cminY-pad);
  const cropW=Math.min(CANVAS,cmaxX+pad)-cropX;
  const cropH=Math.min(CANVAS,cmaxY+pad)-cropY;
  if(cropW>50&&cropH>50){
    const cropped=Buffer.alloc(cropW*cropH*4);
    for(let y=0;y<cropH;y++){
      for(let x=0;x<cropW;x++){
        const sIdx=((cropY+y)*CANVAS+(cropX+x))*4;
        const dIdx=(y*cropW+x)*4;
        cropped[dIdx]=buf[sIdx];cropped[dIdx+1]=buf[sIdx+1];
        cropped[dIdx+2]=buf[sIdx+2];cropped[dIdx+3]=buf[sIdx+3];
      }
    }
    return await sharp(cropped,{raw:{width:cropW,height:cropH,channels:4}})
      .png({compressionLevel:6}).toBuffer();
  }

  return await sharp(buf,{raw:{width:CANVAS,height:CANVAS,channels:4}})
    .png({compressionLevel:6}).toBuffer();
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
    const{stitches,colorCounts}=generateStitchesFromRegions(pixMap,regions,colors);
    console.timeEnd(`stitch-${rid}`);

    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5)return res.status(500).json({error:"No stitchable content — check image contrast"});

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    // Store pixMap+colors for preview rendering
    jobs.set(id,{stitches,pixMap,colors,designW:CANVAS,designH:CANVAS});

    const qa=validateQuality(stitches);
    console.log(`[${rid}] cover:${qa.stitchCount} avg:${qa.avgStitchMM}mm maxJump:${qa.maxJumpMM}mm`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny}});
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
      renderPreview(d.pixMap,d.colors),
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
