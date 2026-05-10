/**
 * Stichai v41.2 — cors removed, native headers
 */

"use strict";

const express = require("express");
const multer  = require("multer");
const axios   = require("axios");
const path    = require("path");
const sharp   = require("sharp");

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

// Native CORS — no npm package needed
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true,limit:"10mb"}));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.5-pro",
];

const CANVAS    = 800;
const DESIGN_MM = CANVAS / 10;

let TATAMI_ROW   = 4;
let TATAMI_LEN   = 30;
const TATAMI_BRICK = 0.5;
let TATAMI_UL    = 40;
const RUN_LEN      = 25;
let PULL         = 2;
const DST_MAX      = 121;
const SMART_TRIM   = 30;

function getStitchParams(specs) {
  const s = specs || {};
  const fabric = (s.fabric || "cotton").toLowerCase();
  const density = (s.density || "medium").toLowerCase();
  const machine = (s.machine || "generic").toLowerCase();
  const stabilizer = (s.stabilizer || "cutaway").toLowerCase();

  const p = {
    tatamiRow: 4, tatamiLen: 30, tatamiUl: 40, pull: 2,
    machine, fabric, stabilizer, density, maxStitchLen: 121
  };

  const fabricMap = {
    cotton:  { pull: 2, tatamiRow: 4, tatamiUl: 40, tatamiLen: 30 },
    denim:   { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    fleece:  { pull: 5, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
    pique:   { pull: 3, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    twill:   { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    satin:   { pull: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    leather: { pull: 1, tatamiRow: 5, tatamiUl: 50, tatamiLen: 35 },
    towel:   { pull: 6, tatamiRow: 2, tatamiUl: 20, tatamiLen: 20 },
    canvas:  { pull: 4, tatamiRow: 3, tatamiUl: 30, tatamiLen: 25 },
    knit:    { pull: 5, tatamiRow: 3, tatamiUl: 25, tatamiLen: 25 },
  };
  const f = fabricMap[fabric] || fabricMap.cotton;
  Object.assign(p, f);

  const densityMap = {
    low:    { tatamiRow: 6, tatamiLen: 40, tatamiUl: 60 },
    medium: { },
    high:   { tatamiRow: 2, tatamiLen: 20, tatamiUl: 25 },
  };
  if (densityMap[density]) Object.assign(p, densityMap[density]);

  if (stabilizer === "none" || stabilizer === "hoop") {
    p.tatamiUl = Math.max(15, p.tatamiUl - 15);
    p.pull = Math.max(1, p.pull - 1);
  } else if (stabilizer === "washaway") {
    p.tatamiUl = Math.max(20, p.tatamiUl - 10);
  }

  if (fabric === "twill" && stabilizer !== "cutaway") {
    p.tatamiRow = Math.max(2, p.tatamiRow);
    p.tatamiUl = Math.max(20, p.tatamiUl);
  }

  return p;
}

async function applyUserMask(pre, maskBuffer) {
  const maskRaw = await sharp(maskBuffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: mData, info: mInfo } = maskRaw;
  const channels = mInfo.channels;

  const bgRgb = hexToRgb(pre.bgColor);

  const imgRaw = await sharp(pre.buffer)
    .resize(CANVAS, CANVAS, { fit: "contain", background: { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const out = Buffer.alloc(CANVAS * CANVAS * iCh);

  let maskedPixels = 0;
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const idx = (y * CANVAS + x);
      const iOff = idx * iCh;
      const mOff = idx * channels;

      const mR = mData[mOff] || 0;
      const mG = mData[mOff + 1] || 0;
      const mB = mData[mOff + 2] || 0;
      const mA = channels >= 4 ? mData[mOff + 3] : 255;

      const shouldRemove = mR > 140 && mG < 90 && mB < 90 && mA > 30;

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

  const maskedBuffer = await sharp(out, {
    raw: { width: CANVAS, height: CANVAS, channels: iCh }
  }).png().toBuffer();

  return { ...pre, buffer: maskedBuffer };
}

const MIN_AREA    = 20;
const SATIN_MAX_W = 150;

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
  const fallback= sorted.slice(0,8).map(([h])=>h);

  return {buffer:q, bgColor, bgLab:rgbToLab(hexToRgb(bgColor)), fallbackColors:fallback};
}

function cleanFallbackColors(rawColors) {
  if(!rawColors.length) return ["#000000"];
  const merged=[];
  for(const c of rawColors){
    const cLab=rgbToLab(hexToRgb(c));
    const mi=merged.findIndex(m=>dE(cLab,rgbToLab(hexToRgb(m)))<20);
    if(mi===-1) merged.push(normHex(c));
  }
  return merged.slice(0,6);
}

async function analyzeWithGemini(originalBuffer, mime) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer (Wilcom EmbroideryStudio).
Analyze this image and return ONE JSON object for DST file generation.
List ALL distinct colors present in the image — including white, light colors, dark colors, and background colors.
The user will decide which colors to stitch. Do not skip any color.
For each color, classify stitch_type: "fill" (large solid area >7mm), "satin" (column 1.5-7mm), "running" (thin line <1.5mm).
Return ONLY valid JSON, no markdown.

{"background":"#FFFFFF","colors":[{"hex":"#000000","label":"logo black","stitch_type":"fill","coverage_pct":60},{"hex":"#FFFFFF","label":"background white","stitch_type":"fill","coverage_pct":40}],"is_logo":true,"is_text":true,"complexity":"simple","recommended_angle":0,"notes":"brief note"}`;

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

function extractRegions(pixMap, colors) {
  const visited  = new Uint8Array(CANVAS*CANVAS);
  const regions  = [];

  for(let ci=0;ci<colors.length;ci++){
    for(let sy=0;sy<CANVAS;sy++){
      for(let sx=0;sx<CANVAS;sx++){
        const si = sy*CANVAS+sx;
        if(pixMap[si]!==ci||visited[si])continue;

        const q=[si];let qp=0;
        visited[si]=1;
        let mnx=sx,mxx=sx,mny=sy,mxy=sy,area=0;

        while(qp<q.length){
          const idx=q[qp++]; area++;
          const x=idx%CANVAS, y=(idx/CANVAS)|0;
          if(x<mnx)mnx=x;if(x>mxx)mxx=x;
          if(y<mny)mny=y;if(y>mxy)mxy=y;

          for(const[dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<CANVAS&&ny>=0&&ny<CANVAS){
              const ni=ny*CANVAS+nx;
              if(!visited[ni]&&pixMap[ni]===ci){visited[ni]=1;q.push(ni);}
            }
          }
        }

        if(area<MIN_AREA)continue;

        const bw=mxx-mnx+1, bh=mxy-mny+1;
        const aspectRatio=bh/Math.max(bw,1);
        const solidity=area/(bw*bh);

        let totalRunW=0, runCount=0;
        for(let ry=mny; ry<=mxy; ry++){
          const runs=getRunsInRow(pixMap,ci,ry,mnx,mxx);
          for(const r of runs){ totalRunW+=(r.x2-r.x1+1); runCount++; }
        }
        const avgRunW=runCount>0?totalRunW/runCount:bw;

        let type;
        if(area<MIN_AREA*3)         type="running";
        else if(aspectRatio>1.6 && solidity>0.35) type="fill";
        else if(avgRunW>8 && avgRunW<=100 && solidity>0.25) type="satin";
        else if(bw<=SATIN_MAX_W && bh<=SATIN_MAX_W*2) type="satin";
        else                        type="fill";

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity});
      }
    }
  }

  console.log(`Regions: ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  console.log("Aspect ratios sample:", regions.slice(0,8).map(r=>`${r.type}(${r.bw}×${r.bh},r=${r.aspectRatio.toFixed(1)})`).join(" "));
  return regions;
}

function generateStitchesFromRegions(pixMap, regions, colors, params) {
  const stitches    = [];
  const colorCounts = colors.map(()=>({fill:0,satin:0,running:0}));

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

  const ordered=[
    ...regions.filter(r=>r.type==="fill"),
    ...regions.filter(r=>r.type==="satin"),
    ...regions.filter(r=>r.type==="running")
  ];

  for(const reg of ordered){
    const {ci,color,type,mnx,mny,mxx,mxy}=reg;
    let lastX=globalLastX,lastY=globalLastY;

    if(lastX!==-1){
      const gap=Math.hypot(reg.mnx-lastX, reg.mny-lastY);
      if(gap>SMART_TRIM) emitTrim(lastX,lastY,reg.mnx,reg.mny,color);
    }

    if(type==="fill"){
      let ulRow=0;
      for(let y=mny;y<=mxy;y+=pUl){
        const runs=getRunsInRow(pixMap,ci,y,mnx,mxx);
        if(!runs.length)continue;
        const rev=ulRow%2===1;
        for(const{x1,x2} of (rev?[...runs].reverse():runs)){
          const ux=rev?x2-pPull:x1+pPull;
          if(lastX!==-1){
            const g=Math.hypot(ux-lastX,y-lastY);
            if(g>SMART_TRIM) emitTrim(lastX,lastY,ux,y,color);
          } else stitches.push({x:ux,y,color,type:"trim"});
          stitches.push({x:x1+pPull,y,color,type:"underlay"});
          stitches.push({x:x2-pPull,y,color,type:"underlay"});
          lastX=x2-pPull;lastY=y;
        }
        ulRow++;
      }
    }

    let rowIdx=0;
    for(let y=mny;y<=mxy;y+=pRow){
      const runs=getRunsInRow(pixMap,ci,y,mnx,mxx);
      if(!runs.length)continue;
      const rev=rowIdx%2===1;
      const ord=rev?[...runs].reverse():runs;

      for(const{x1,x2} of ord){
        const runW=x2-x1+1;
        const jx=rev?x2:x1;

        if(lastX!==-1){
          const g=Math.hypot(jx-lastX,y-lastY);
          if(g>SMART_TRIM) emitTrim(lastX,lastY,jx,y,color);
        } else stitches.push({x:jx,y,color,type:"trim"});

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

async function renderPreview(pixMap, colors, stitches, params) {
  const W = CANVAS, H = CANVAS;
  const buf = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const weave = ((x + y) % 2 === 0) ? 4 : -2;
      buf[idx]     = 242 + weave;
      buf[idx + 1] = 238 + weave;
      buf[idx + 2] = 228 + weave;
      buf[idx + 3] = 255;
    }
  }

  const threadColors = colors.map(c => {
    const { r, g, b } = hexToRgb(normHex(c));
    return {
      r, g, b,
      dr: Math.max(0, r - 40),
      dg: Math.max(0, g - 40),
      db: Math.max(0, b - 40),
    };
  });

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

  function drawLine(x0, y0, x1, y1, r, g, b, thickness) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) { setPixel(x0, y0, r, g, b, 220); return; }
    const steps = Math.ceil(dist * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      setPixel(x, y, r, g, b, 230);
      if (thickness >= 2) {
        if (Math.abs(dx) > Math.abs(dy)) { setPixel(x, y + 1, r, g, b, 180); setPixel(x, y - 1, r, g, b, 80); }
        else { setPixel(x + 1, y, r, g, b, 180); setPixel(x - 1, y, r, g, b, 80); }
      }
    }
  }

  const byColor = new Map();
  for (const s of stitches) {
    if (s.type === "trim") continue;
    if (!byColor.has(s.color)) byColor.set(s.color, []);
    byColor.get(s.color).push(s);
  }

  for (const [color, colStitches] of byColor) {
    const ci = colors.findIndex(c => normHex(c) === normHex(color));
    const tc = ci >= 0 ? threadColors[ci] : { r: 128, g: 128, b: 128, dr: 80, dg: 80, db: 80 };

    const underlays = colStitches.filter(s => s.type === "underlay");
    const covers    = colStitches.filter(s => s.type !== "underlay");

    for (let i = 1; i < underlays.length; i++) {
      const a = underlays[i - 1], b = underlays[i];
      const dy = Math.abs(b.y - a.y);
      if (Math.hypot(b.x - a.x, dy) > 80) continue;
      drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, 1);
    }

    const rowMap = new Map();
    for (const s of covers) {
      const ry = Math.round(s.y);
      if (!rowMap.has(ry)) rowMap.set(ry, []);
      rowMap.get(ry).push(s);
    }

    let prevStitch = null;
    for (let i = 0; i < covers.length; i++) {
      const s = covers[i];
      const nextStitch = covers[i + 1] || null;

      const isSatin = s.type === "satin";
      const isFill  = s.type === "fill";
      const isRun   = s.type === "running";

      const dotAlpha = isRun ? 200 : 240;
      const dotSize = isSatin ? 2 : isFill ? 1.5 : 1;
      setPixel(s.x, s.y, tc.r, tc.g, tc.b, dotAlpha);
      if (dotSize >= 2) {
        setPixel(s.x + 1, s.y, tc.dr, tc.dg, tc.db, 160);
        setPixel(s.x, s.y + 1, tc.dr, tc.dg, tc.db, 120);
      }

      if (nextStitch && nextStitch.color === s.color) {
        const jump = Math.hypot(nextStitch.x - s.x, nextStitch.y - s.y);
        if (jump < 50) {
          const thick = isSatin ? 3 : isFill ? 2 : 1;
          drawLine(s.x, s.y, nextStitch.x, nextStitch.y, tc.r, tc.g, tc.b, thick);
        }
      }

      prevStitch = s;
    }

    const pRow = (params && params.tatamiRow) ? params.tatamiRow : TATAMI_ROW;
    for (const [ry, rowStitches] of rowMap) {
      if (rowStitches.length < 2) continue;
      const hasFill = rowStitches.some(s => s.type === "fill");
      if (!hasFill) continue;

      rowStitches.sort((a, b) => a.x - b.x);
      for (let i = 1; i < rowStitches.length; i++) {
        const a = rowStitches[i - 1], b = rowStitches[i];
        const gap = b.x - a.x;
        if (gap > 8 && gap < 60) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
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

const detections = new Map();
setInterval(()=>{
  const now = Date.now();
  for(const [id,d] of detections){ if(now-d.timestamp>300000) detections.delete(id); }
}, 60000);

app.use(express.static(path.join(__dirname,"public")));
app.get("/",(_, res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.post("/detect-shapes", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});
    console.log(`[${rid}] DETECT: image=${imgFile.size}B mask=${maskFile?maskFile.size+'B':'none'}`);

    console.time(`pre-${rid}`);
    let pre=await preprocessImage(imgFile.buffer);
    console.timeEnd(`pre-${rid}`);

    if(maskFile){
      console.time(`mask-${rid}`);
      pre=await applyUserMask(pre,maskFile.buffer);
      console.timeEnd(`mask-${rid}`);
      console.log(`[${rid}] Mask applied`);
    }

    console.time(`gem-${rid}`);
    const gem=await analyzeWithGemini(imgFile.buffer,imgFile.mimetype||"image/png");
    console.timeEnd(`gem-${rid}`);

    let colors,colorMeta={};
    if(gem&&gem.colors&&gem.colors.length>=1){
      colors=gem.colors; colorMeta=gem.meta||{};
      console.log(`[${rid}] Gemini: [${colors.join(",")}] | ${gem.notes}`);
    }else{
      console.log(`[${rid}] Gemini failed — fallback`);
      colors=cleanFallbackColors(pre.fallbackColors);
      console.log(`[${rid}] Fallback: [${colors.join(",")}]`);
    }
    if(!colors.length) colors=["#000000"];

    console.time(`pixmap-${rid}`);
    const pixMap=await buildPixelMap(pre.buffer,colors);
    console.timeEnd(`pixmap-${rid}`);

    console.time(`regions-${rid}`);
    const regions=extractRegions(pixMap,colors);
    console.timeEnd(`regions-${rid}`);

    if(!regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }
    console.log(`[${rid}] Regions: ${regions.length}`);

    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:0});
    }

    const detectionId=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    detections.set(detectionId,{
      pixMap,regions,colors,pre,geminiNotes:gem?.notes||"",timestamp:Date.now()
    });

    const colorInfo = {};
    colors.forEach(c => { colorInfo[c] = {label: '', coverage_pct: 0}; });

    console.log(`[${rid}] DETECT DONE: ${shapes.length} shapes, ${colors.length} colors`);

    return res.json({
      success:true,
      detectionId,
      colors,
      colorMeta:colorInfo,
      shapes,
      geminiNotes:gem?.notes||""
    });
  }catch(e){
    console.error(`[${rid}] DETECT CRASH:`,e.message);
    return res.status(500).json({error:e.message||"Detection failed"});
  }
});

app.post("/generate-embroidery", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});

    const body = req.body || {};
    console.log(`[${rid}] GENERATE: image=${imgFile.size}B detectionId=${body.detectionId || 'none'}`);

    const specs = {
      fabric: body.fabric || "cotton",
      machine: body.machine || "generic",
      hoop: body.hoop || "5x7",
      density: body.density || "medium",
      thread: body.thread || "generic",
      stabilizer: body.stabilizer || "cutaway",
      instructions: body.instructions || ""
    };
    const params = getStitchParams(specs);
    console.log(`[${rid}] Specs:`, JSON.stringify(specs));
    console.log(`[${rid}] Tuned: row=${params.tatamiRow} len=${params.tatamiLen} pull=${params.pull} ul=${params.tatamiUl}`);

    const detectionId = body.detectionId;
    const det = detectionId ? detections.get(detectionId) : null;
    let pixMap, regions, colors;

    if(det){
      console.log(`[${rid}] Using cached detection ${detectionId}`);
      pixMap = det.pixMap;
      regions = det.regions;
      colors = det.colors;
    }else{
      console.log(`[${rid}] No cache — full re-analysis`);
      console.time(`pre-${rid}`);
      let pre=await preprocessImage(imgFile.buffer);
      console.timeEnd(`pre-${rid}`);

      if(maskFile){
        console.time(`mask-${rid}`);
        pre=await applyUserMask(pre,maskFile.buffer);
        console.timeEnd(`mask-${rid}`);
      }

      console.time(`gem-${rid}`);
      const gem=await analyzeWithGemini(imgFile.buffer,imgFile.mimetype||"image/png");
      console.timeEnd(`gem-${rid}`);

      let colorMeta={};
      if(gem&&gem.colors&&gem.colors.length>=1){
        colors=gem.colors;colorMeta=gem.meta||{};
      }else{
        colors=cleanFallbackColors(pre.fallbackColors);
      }
      if(!colors.length) colors=["#000000"];

      console.time(`pixmap-${rid}`);
      pixMap=await buildPixelMap(pre.buffer,colors);
      console.timeEnd(`pixmap-${rid}`);

      console.time(`regions-${rid}`);
      regions=extractRegions(pixMap,colors);
      console.timeEnd(`regions-${rid}`);
    }

    if(!regions || !regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    let selectedColors = colors;
    try{
      if(body.selectedColors){
        const parsed = JSON.parse(body.selectedColors);
        if(Array.isArray(parsed) && parsed.length>0){
          selectedColors = parsed.map(c => normHex(c));
          console.log(`[${rid}] Selected colors: [${selectedColors.join(",")}]`);
        }
      }
    }catch(e){ console.log(`[${rid}] No color filter`); }

    let filteredRegions = regions;
    try{
      if(body.selectedShapes){
        const parsed = JSON.parse(body.selectedShapes);
        if(Array.isArray(parsed) && parsed.length>0 && parsed.length < regions.length){
          filteredRegions = parsed.map(idx => regions[idx]).filter(Boolean);
          console.log(`[${rid}] Selected shapes: ${parsed.length}/${regions.length}`);
        }
      }
    }catch(e){ console.log(`[${rid}] No shape filter`); }

    if(selectedColors.length < colors.length){
      const excludedCis = new Set();
      colors.forEach((c,ci) => { if(!selectedColors.includes(normHex(c))) excludedCis.add(ci); });
      for(let i=0;i<pixMap.length;i++){ if(excludedCis.has(pixMap[i])) pixMap[i]=-1; }
      filteredRegions = filteredRegions.filter(r => {
        const ci = colors.findIndex(c => normHex(c) === normHex(r.color));
        return selectedColors.includes(normHex(r.color));
      });
      console.log(`[${rid}] After color filter: ${filteredRegions.length} regions`);
    }

    if(!filteredRegions.length){
      return res.status(400).json({error:"No regions left after selection — select more colors/shapes"});
    }

    console.time(`stitch-${rid}`);
    const{stitches,colorCounts}=generateStitchesFromRegions(pixMap,filteredRegions,selectedColors,params);
    console.timeEnd(`stitch-${rid}`);

    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5){
      return res.status(500).json({error:"Not enough stitches — select more shapes or check contrast"});
    }

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,{stitches,pixMap,colors:selectedColors,params,designW:CANVAS,designH:CANVAS});

    const qa=validateQuality(stitches);
    console.log(`[${rid}] DONE: ${qa.stitchCount} stitches, ${filteredRegions.length} regions, ${selectedColors.length} colors`);
    for(const w of qa.warnings)console.warn(`  ⚠ ${w}`);

    const shapes=[];
    for(const r of filteredRegions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      const sc=stitches.filter(s=>s.color===r.color&&s.type!=="trim"&&s.type!=="underlay"&&s.x>=r.mnx&&s.x<=r.mxx&&s.y>=r.mny&&s.y<=r.mxy).length;
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:sc});
    }

    return res.json({
      success:true,id,
      previewUrl:`/preview/${id}`,
      previewImageUrl:`/preview-image/${id}`,
      downloadUrl:`/download/${id}`,
      stitchCount:qa.stitchCount,
      designSize:{w:CANVAS,h:CANVAS,mm:DESIGN_MM},
      colors:selectedColors,colorMeta:{},
      geminiNotes:det?.geminiNotes||"",
      specs,
      tunedParams:params,
      qa,shapes,regions:filteredRegions.length
    });
  }catch(e){
    console.error(`[${rid}] CRASH:`,e.message,"\n",e.stack);
    return res.status(500).json({error:e.message||"Server error"});
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

app.get("/download/:id",(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});
  const buf=encodeDST(d.stitches);
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename="design.dst"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"41.2",canvas:`${CANVAS}px=${DESIGN_MM}mm`}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v41.2 | :${PORT} | ${CANVAS}px=${DESIGN_MM}mm`));
server.timeout=120000;
server.keepAliveTimeout=65000;
