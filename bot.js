/**
 * Stichai v62 — Fix color index crash + mask aspect ratio
 * ═══════════════════════════════════════════════════════════════════
 *  FIXES FROM v47
 *  ──────────────────────────────────────────────────────────────
 *  1. When selectedColors < full palette, regions' ci is re-indexed
 *     to match the new shortened palette before stitch generation.
 *  2. Frontend initMask uses contain-fit with white background,
 *     matching server preprocessing exactly.
 */

"use strict";

const express = require("express");
const multer  = require("multer");
const axios   = require("axios");
const path    = require("path");
const sharp   = require("sharp");

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

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

/* ─── CONSTANTS ───────────────────────────────────────────*/
const DST_MAX      = 121;
const SMART_TRIM   = 30;
const MIN_AREA     = 25;
const PREVIEW_MAX  = 1200;

/* ─── COLOR UTILITIES ────────────────────────────────────*/
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
function isNearWhite(hex){const {r,g,b}=hexToRgb(hex);return r>230&&g>230&&b>230;}
function isNearBlack(hex){const {r,g,b}=hexToRgb(hex);return r<40&&g<40&&b<40;}

/* ─── SPEC TUNING ─────────────────────────────────────────*/
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

/* ─── IMAGE CLEANING ─────────────────────────────────────*/
async function preprocessImage(buffer, canvasSize) {
  return sharp(buffer)
    .resize(canvasSize, canvasSize, {fit:"contain",background:{r:255,g:255,b:255,alpha:1}})
    .median(2)
    .sharpen({sigma:1.0})
    .linear(1.2,-15)
    .toBuffer();
}

/* ─── MASK-AWARE DIVERSITY COLOR EXTRACTION ──────────────*/
async function extractColorsFromUnmasked(imageBuffer, maskBuffer, canvasSize, maxColors) {
  const analysisSize = 200;
  const BUCKET = 16;
  
  const imgRaw = await sharp(imageBuffer)
    .resize(analysisSize, analysisSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(analysisSize, analysisSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true }) : null;
  
  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const mData = maskRaw ? maskRaw.data : null;
  const mCh = maskRaw ? maskRaw.info.channels : 0;
  
  const bucketFreq = new Map();
  const bucketSums = new Map();
  let totalUnmasked = 0;
  
  for (let i = 0; i < analysisSize * analysisSize; i++) {
    const iOff = i * iCh;
    
    if (mData) {
      const mOff = i * mCh;
      const mR = mData[mOff] || 0;
      const mG = mData[mOff + 1] || 0;
      const mB = mData[mOff + 2] || 0;
      const mA = mCh >= 4 ? mData[mOff + 3] : 255;
      if (mR > 140 && mG < 90 && mB < 90 && mA > 30) continue;
    }
    
    totalUnmasked++;
    const r = iData[iOff], g = iData[iOff + 1], b = iData[iOff + 2];
    
    const br = Math.min(255, Math.round(r / BUCKET) * BUCKET);
    const bg = Math.min(255, Math.round(g / BUCKET) * BUCKET);
    const bb = Math.min(255, Math.round(b / BUCKET) * BUCKET);
    const key = (br << 16) | (bg << 8) | bb;
    
    bucketFreq.set(key, (bucketFreq.get(key) || 0) + 1);
    
    if (!bucketSums.has(key)) bucketSums.set(key, { r: 0, g: 0, b: 0, n: 0 });
    const s = bucketSums.get(key);
    s.r += r; s.g += g; s.b += b; s.n++;
  }
  
  if (totalUnmasked === 0) return ["#000000"];
  
  const allBuckets = [];
  for (const [key, freq] of bucketFreq) {
    const s = bucketSums.get(key);
    const avgR = Math.round(s.r / s.n);
    const avgG = Math.round(s.g / s.n);
    const avgB = Math.round(s.b / s.n);
    const hex = "#" + [avgR, avgG, avgB].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    const lab = rgbToLab({r: avgR, g: avgG, b: avgB});
    allBuckets.push({ hex: normHex(hex), lab, freq, pct: freq / totalUnmasked });
  }
  
  allBuckets.sort((a, b) => b.freq - a.freq);
  
  const MIN_DIST = 15;
  const selected = [];
  
  for (const bucket of allBuckets) {
    if (selected.length >= maxColors) break;
    const tooClose = selected.some(s => dE(bucket.lab, s.lab) < MIN_DIST);
    if (!tooClose) selected.push(bucket);
  }
  
  if (selected.length < maxColors) {
    const remaining = allBuckets.filter(b => !selected.some(s => s.hex === b.hex));
    remaining.sort((a, b) => {
      const aMin = Math.min(...selected.map(s => dE(a.lab, s.lab)));
      const bMin = Math.min(...selected.map(s => dE(b.lab, s.lab)));
      return bMin - aMin;
    });
    
    for (const bucket of remaining) {
      if (selected.length >= maxColors) break;
      const tooClose = selected.some(s => dE(bucket.lab, s.lab) < MIN_DIST);
      if (!tooClose) selected.push(bucket);
    }
  }
  
  if (selected.length < maxColors) {
    const paletteLabs = selected.map(s => s.lab);
    const outliers = [];
    
    for (let i = 0; i < analysisSize * analysisSize; i++) {
      const iOff = i * iCh;
      if (mData) {
        const mOff = i * mCh;
        if (mData[mOff] > 140 && mData[mOff+1] < 90 && mData[mOff+2] < 90 && (mCh < 4 || mData[mOff+3] > 30)) continue;
      }
      
      const r = iData[iOff], g = iData[iOff+1], b = iData[iOff+2];
      const lab = rgbToLab({r, g, b});
      const minDist = Math.min(...paletteLabs.map(pl => dE(lab, pl)));
      
      if (minDist > 25) {
        outliers.push({ r, g, b, dist: minDist });
      }
    }
    
    const outlierGroups = new Map();
    for (const o of outliers) {
      const key = (Math.round(o.r/32)*32 << 16) | (Math.round(o.g/32)*32 << 8) | Math.round(o.b/32)*32;
      if (!outlierGroups.has(key)) outlierGroups.set(key, { r: 0, g: 0, b: 0, n: 0, maxDist: 0 });
      const g = outlierGroups.get(key);
      g.r += o.r; g.g += o.g; g.b += o.b; g.n++;
      if (o.dist > g.maxDist) g.maxDist = o.dist;
    }
    
    const outlierBuckets = [...outlierGroups.entries()]
      .map(([_, v]) => ({
        hex: normHex("#" + [Math.round(v.r/v.n), Math.round(v.g/v.n), Math.round(v.b/v.n)]
          .map(c => c.toString(16).padStart(2,"0")).join("")),
        lab: rgbToLab({r: Math.round(v.r/v.n), g: Math.round(v.g/v.n), b: Math.round(v.b/v.n)}),
        maxDist: v.maxDist
      }))
      .filter(b => !selected.some(s => dE(b.lab, s.lab) < MIN_DIST))
      .sort((a, b) => b.maxDist - a.maxDist);
    
    for (const bucket of outlierBuckets) {
      if (selected.length >= maxColors) break;
      selected.push(bucket);
    }
  }
  
  let brightCount = 0, darkCount = 0;
  for (let i = 0; i < analysisSize * analysisSize; i++) {
    if (mData) {
      const mOff = i * mCh;
      if (mData[mOff] > 140 && mData[mOff+1] < 90 && mData[mOff+2] < 90 && (mCh < 4 || mData[mOff+3] > 30)) continue;
    }
    const iOff = i * iCh;
    if (iData[iOff] > 240 && iData[iOff+1] > 240 && iData[iOff+2] > 240) brightCount++;
    if (iData[iOff] < 30 && iData[iOff+1] < 30 && iData[iOff+2] < 30) darkCount++;
  }
  
  const result = selected.map(s => s.hex);
  
  if (!result.some(c => isNearWhite(c)) && brightCount / totalUnmasked > 0.01) {
    result.unshift('#FFFFFF');
    if (result.length > maxColors) result.pop();
  }
  if (!result.some(c => isNearBlack(c)) && darkCount / totalUnmasked > 0.01) {
    result.push('#000000');
    if (result.length > maxColors) result.shift();
  }
  
  console.log(`Extracted ${result.length}/${maxColors} colors: ${result.join(', ')}`);
  return result.length ? result : ["#000000"];
}

/* ─── PIXEL MAP (mask-aware, full resolution) ────────────*/
async function buildPixelMap(imageBuffer, maskBuffer, colors, canvasSize) {
  const imgRaw = await sharp(imageBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const maskRaw = maskBuffer ? await sharp(maskBuffer)
    .resize(canvasSize, canvasSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true }) : null;
  
  const { data: iData, info: iInfo } = imgRaw;
  const iCh = iInfo.channels;
  const mData = maskRaw ? maskRaw.data : null;
  const mCh = maskRaw ? maskRaw.info.channels : 0;
  
  const labC = colors.map(c => rgbToLab(hexToRgb(c)));
  const pixMap = new Int16Array(canvasSize * canvasSize).fill(-1);
  
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      const idx = y * canvasSize + x;
      const iOff = idx * iCh;
      
      if (mData) {
        const mOff = idx * mCh;
        const mR = mData[mOff] || 0;
        const mG = mData[mOff + 1] || 0;
        const mB = mData[mOff + 2] || 0;
        const mA = mCh >= 4 ? mData[mOff + 3] : 255;
        if (mR > 140 && mG < 90 && mB < 90 && mA > 30) {
          pixMap[idx] = -1;
          continue;
        }
      }
      
      const lab = rgbToLab({r: iData[iOff], g: iData[iOff + 1], b: iData[iOff + 2]});
      let best = 0, bestD = Infinity;
      for (let c = 0; c < labC.length; c++) {
        const d = dE(lab, labC[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      pixMap[idx] = best;
    }
  }
  
  const cnt = new Array(colors.length).fill(0);
  let un = 0;
  for (let i = 0; i < pixMap.length; i++) {
    if (pixMap[i] >= 0) cnt[pixMap[i]]++;
    else un++;
  }
  const total = canvasSize * canvasSize;
  console.log("Coverage:", cnt.map((c, i) => `${normHex(colors[i])}:${(c/total*100).toFixed(1)}%`).join(" "), `masked:${(un/total*100).toFixed(1)}%`);
  
  return pixMap;
}

/* ─── GEMINI (metadata only) ─────────────────────────────*/
async function geminiPost(body, ms = 45000) {
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

async function analyzeWithGemini(originalBuffer, mime, colorCount) {
  const b64 = originalBuffer.toString("base64");
  const prompt = `You are a senior machine-embroidery digitizer.
Analyze this image for embroidery. The user wants approximately ${colorCount} thread colors.
Return ONLY valid JSON, no markdown.

{"is_logo":true,"is_text":true,"complexity":"moderate","recommended_angle":0,"notes":"brief note"}`;

  const res = await geminiPost({
    contents:[{role:"user",parts:[{text:prompt},{inlineData:{mimeType:mime||"image/png",data:b64}}]}],
    generationConfig:{temperature:0.0,maxOutputTokens:1024}
  });
  if(!res) return null;

  try {
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text||"";
    let js = raw.replace(/```json|```/g,"").trim();
    const fa=js.indexOf("{"),lb=js.lastIndexOf("}");
    if(fa!==-1&&lb>fa)js=js.slice(fa,lb+1);
    return JSON.parse(js);
  }catch(e){console.error("Gemini JSON:",e.message);return null;}
}

/* ─── RUN HELPERS ────────────────────────────────────────*/
function getRunsInRow(pixMap,ci,y,x0,x1,canvasSize){
  const runs=[];let s=-1;
  for(let x=x0;x<=x1;x++){
    const hit=y>=0&&y<canvasSize&&pixMap[y*canvasSize+x]===ci;
    if(hit&&s===-1)s=x;
    if(!hit&&s!==-1){runs.push({x1:s,x2:x-1});s=-1;}
  }
  if(s!==-1)runs.push({x1:s,x2:x1});
  return runs;
}

/* ─── REGION EXTRACTION ──────────────────────────────────*/
function extractRegions(pixMap, colors, canvasSize) {
  const visited  = new Uint8Array(canvasSize*canvasSize);
  const regions  = [];

  for(let ci=0;ci<colors.length;ci++){
    for(let sy=0;sy<canvasSize;sy++){
      for(let sx=0;sx<canvasSize;sx++){
        const si = sy*canvasSize+sx;
        if(pixMap[si]!==ci||visited[si])continue;

        const q=[si];let qp=0;
        visited[si]=1;
        let mnx=sx,mxx=sx,mny=sy,mxy=sy,area=0;

        while(qp<q.length){
          const idx=q[qp++]; area++;
          const x=idx%canvasSize, y=(idx/canvasSize)|0;
          if(x<mnx)mnx=x;if(x>mxx)mxx=x;
          if(y<mny)mny=y;if(y>mxy)mxy=y;

          for(const[dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<canvasSize&&ny>=0&&ny<canvasSize){
              const ni=ny*canvasSize+nx;
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
          const runs=getRunsInRow(pixMap,ci,ry,mnx,mxx,canvasSize);
          for(const r of runs){ totalRunW+=(r.x2-r.x1+1); runCount++; }
        }
        const avgRunW=runCount>0?totalRunW/runCount:bw;

        let type;
        if(area < MIN_AREA * 3) type = "running";
        else if(aspectRatio > 2.5 && avgRunW <= 18 && solidity > 0.4) type = "satin";
        else if(avgRunW > 3 && avgRunW <= 14 && solidity > 0.5 && aspectRatio > 1.5) type = "satin";
        else type = "fill";

        regions.push({ci,color:normHex(colors[ci]),type,mnx,mny,mxx,mxy,bw,bh,area,aspectRatio,solidity,avgRunW});
      }
    }
  }

  console.log(`Regions (raw): ${regions.length} | fill:${regions.filter(r=>r.type==="fill").length} satin:${regions.filter(r=>r.type==="satin").length} run:${regions.filter(r=>r.type==="running").length}`);
  return regions;
}

/* ─── MERGE ADJACENT FRAGMENTS ───────────────────────────*/
function mergeAdjacentRegions(regions) {
  if(!regions.length) return regions;
  const merged = [];
  const used = new Set();

  for(let i=0;i<regions.length;i++){
    if(used.has(i)) continue;
    const base = regions[i];
    let mnx=base.mnx, mny=base.mny, mxx=base.mxx, mxy=base.mxy, area=base.area;
    let totalRunW = base.avgRunW * base.bh;
    let runCount = base.bh;
    used.add(i);

    for(let j=i+1;j<regions.length;j++){
      if(used.has(j)) continue;
      const other = regions[j];
      if(other.color !== base.color) continue;

      const gap = 1;
      const overlapX = !(mxx + gap < other.mnx || other.mxx + gap < mnx);
      const overlapY = !(mxy + gap < other.mny || other.mxy + gap < mny);

      if(overlapX && overlapY){
        mnx = Math.min(mnx, other.mnx);
        mny = Math.min(mny, other.mny);
        mxx = Math.max(mxx, other.mxx);
        mxy = Math.max(mxy, other.mxy);
        area += other.area;
        totalRunW += other.avgRunW * other.bh;
        runCount += other.bh;
        used.add(j);
      }
    }

    const newBw = mxx-mnx+1, newBh = mxy-mny+1;
    const newAvgRunW = runCount > 0 ? totalRunW / runCount : newBw;
    const newAspect = newBh / Math.max(newBw, 1);
    const newSolidity = area / (newBw * newBh);

    let newType;
    if(area < MIN_AREA * 3) newType = "running";
    else if(newAspect > 2.5 && newAvgRunW <= 18 && newSolidity > 0.4) newType = "satin";
    else if(newAvgRunW > 3 && newAvgRunW <= 14 && newSolidity > 0.5 && newAspect > 1.5) newType = "satin";
    else newType = "fill";

    merged.push({
      ci: base.ci, color: base.color, type: newType,
      mnx, mny, mxx, mxy,
      bw: newBw, bh: newBh, area,
      aspectRatio: newAspect, solidity: newSolidity, avgRunW: newAvgRunW
    });
  }

  console.log(`Regions (merged): ${merged.length}`);
  return merged;
}

/* ─── BRIDGE CONNECTOR (v60) ─────────────────────────────*/
function getEdgePixels(pixMap, reg, canvasSize) {
  const edge = [];
  for (let y = reg.mny; y <= reg.mxy; y++) {
    for (let x = reg.mnx; x <= reg.mxx; x++) {
      const idx = y * canvasSize + x;
      if (pixMap[idx] === reg.ci) {
        let isEdge = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= canvasSize || ny < 0 || ny >= canvasSize) { isEdge = true; break; }
          if (pixMap[ny * canvasSize + nx] !== reg.ci) { isEdge = true; break; }
        }
        if (isEdge) edge.push({x, y});
      }
    }
  }
  return edge.length ? edge : [{x: Math.round((reg.mnx + reg.mxx) / 2), y: Math.round((reg.mny + reg.mxy) / 2)}];
}

function findClosestPair(edgeA, edgeB) {
  let best = {from: edgeA[0], to: edgeB[0], dist: Infinity};
  for (const a of edgeA) {
    for (const b of edgeB) {
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d < best.dist) best = {from: a, to: b, dist: d};
    }
  }
  return best;
}

function sortRegionsNearestNeighbor(regions) {
  if (regions.length <= 1) return regions;
  const sorted = [regions[0]];
  const used = new Set([0]);
  while (used.size < regions.length) {
    const last = sorted[sorted.length - 1];
    const lastCx = (last.mnx + last.mxx) / 2;
    const lastCy = (last.mny + last.mxy) / 2;
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < regions.length; i++) {
      if (used.has(i)) continue;
      const r = regions[i];
      const d = ((r.mnx + r.mxx) / 2 - lastCx) ** 2 + ((r.mny + r.mxy) / 2 - lastCy) ** 2;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    sorted.push(regions[bestIdx]);
  }
  return sorted;
}

function generateBridgeStitches(fromX, fromY, toX, toY, color) {
  const dx = toX - fromX, dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 8)); // 0.8mm bridge stitches
  const stitches = [];
  for (let i = 1; i <= steps; i++) {
    const fx = Math.round(fromX + dx * i / steps);
    const fy = Math.round(fromY + dy * i / steps);
    stitches.push({x: fx, y: fy, color, type: "bridge"});
  }
  return stitches;
}

/* ─── STITCH GENERATION (v60 — absolute coordinates) ───────*/
function generateStitchesFromRegions(pixMap, regions, colors, params, canvasSize) {
  const stitches = [];
  const colorCounts = colors.map(() => ({fill: 0, satin: 0, running: 0}));

  const P = params || {};
  const pRow = P.tatamiRow !== undefined ? P.tatamiRow : 4;
  const pLen = P.tatamiLen !== undefined ? P.tatamiLen : 30;
  const pUl = P.tatamiUl !== undefined ? P.tatamiUl : 40;
  const pPull = P.pull !== undefined ? P.pull : 2;

  // Precompute edge pixels and reorder regions by nearest-neighbor within each color
  const edgePixels = new Map();
  for (const reg of regions) {
    edgePixels.set(reg, getEdgePixels(pixMap, reg, canvasSize));
  }

  // Group by (type, color) and sort each group by nearest neighbor
  const byTypeColor = new Map();
  for (const reg of regions) {
    const key = reg.type + '|' + normHex(reg.color);
    if (!byTypeColor.has(key)) byTypeColor.set(key, []);
    byTypeColor.get(key).push(reg);
  }

  const ordered = [];
  for (const type of ['fill', 'satin', 'running']) {
    for (const [key, group] of byTypeColor) {
      if (key.startsWith(type + '|')) {
        ordered.push(...sortRegionsNearestNeighbor(group));
      }
    }
  }

  let globalLastX = -1, globalLastY = -1;

  for (let ri = 0; ri < ordered.length; ri++) {
    const reg = ordered[ri];
    const ci = colors.findIndex(c => normHex(c) === normHex(reg.color));
    if (ci === -1) {
      console.warn(`Region color ${reg.color} not found in selected palette — skipping`);
      continue;
    }

    const {color, type, mnx, mny, mxx, mxy} = reg;
    let lastX = globalLastX, lastY = globalLastY;

    // Bridge to closest edge point from previous region
    if (lastX !== -1 && ri > 0) {
      const prevReg = ordered[ri - 1];
      if (normHex(prevReg.color) === normHex(reg.color)) {
        const prevEdge = edgePixels.get(prevReg);
        const currEdge = edgePixels.get(reg);
        const pair = findClosestPair(prevEdge, currEdge);
        const bridge = generateBridgeStitches(lastX, lastY, pair.to.x, pair.to.y, color);
        stitches.push(...bridge);
        lastX = pair.to.x;
        lastY = pair.to.y;
      } else {
        // Different color — color change then bridge to entry point
        stitches.push({x: lastX, y: lastY, color, type: "trim"});
        const entryEdge = edgePixels.get(reg);
        const entry = entryEdge[Math.floor(entryEdge.length / 2)];
        const bridge = generateBridgeStitches(lastX, lastY, entry.x, entry.y, color);
        stitches.push(...bridge);
        lastX = entry.x;
        lastY = entry.y;
      }
    } else {
      // First region — set origin to closest edge point (no jump from 0,0)
      const entryEdge = edgePixels.get(reg);
      const entry = entryEdge[Math.floor(entryEdge.length / 2)];
      lastX = entry.x;
      lastY = entry.y;
    }

    // Underlay (fill only)
    if (type === "fill") {
      let ulRow = 0;
      for (let y = mny; y <= mxy; y += pUl) {
        const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
        if (!runs.length) continue;
        const rev = ulRow % 2 === 1;
        for (const {x1, x2} of (rev ? [...runs].reverse() : runs)) {
          const ux = rev ? x2 - pPull : x1 + pPull;
          stitches.push({x: ux, y, color, type: "underlay"});
          stitches.push({x: x2 - pPull, y, color, type: "underlay"});
          lastX = x2 - pPull;
          lastY = y;
        }
        ulRow++;
      }
    }

    // Reset lastX/lastY before fill so underlay doesn't create long trims into fill
    lastX = -1; lastY = -1;

    let rowIdx = 0;
    for (let y = mny; y <= mxy; y += pRow) {
      const runs = getRunsInRow(pixMap, ci, y, mnx, mxx, canvasSize);
      if (!runs.length) continue;
      const rev = rowIdx % 2 === 1;
      const ord = rev ? [...runs].reverse() : runs;

      for (const {x1, x2} of ord) {
        const jx = rev ? x2 : x1;

        if (lastX !== -1) {
          const g = Math.hypot(jx - lastX, y - lastY);
          if (g > SMART_TRIM) {
            const bridge = generateBridgeStitches(lastX, lastY, jx, y, color);
            stitches.push(...bridge);
          } else {
            stitches.push({x: jx, y, color, type: "trim"});
          }
        } else {
          stitches.push({x: jx, y, color, type: "trim"});
        }

        if (type === "running") {
          const rx = Math.round((x1 + x2) / 2);
          stitches.push({x: rx, y, color, type: "running"});
          colorCounts[ci].running++;
          lastX = rx;

        } else if (type === "satin") {
          const sx = rev ? x2 - pPull : x1 + pPull;
          const ex = rev ? x1 + pPull : x2 - pPull;
          if (Math.abs(ex - sx) > 1) {
            stitches.push({x: sx, y, color, type: "satin"});
            stitches.push({x: ex, y, color, type: "satin"});
            colorCounts[ci].satin += 2;
            lastX = ex;
          } else {
            const rx = Math.round((x1 + x2) / 2);
            stitches.push({x: rx, y, color, type: "satin"});
            colorCounts[ci].satin++;
            lastX = rx;
          }

        } else {
          const brickOff = rowIdx % 2 === 0 ? 0 : Math.round(pLen * 0.5);
          const lx = x1 + pPull + brickOff, rx = x2 - pPull;
          if (rx > lx) {
            const steps = Math.max(1, Math.round((rx - lx) / pLen));
            const sx2 = rev ? rx : lx, ex2 = rev ? lx : rx;
            for (let s = 0; s <= steps; s++) {
              const fx = Math.round(sx2 + (ex2 - sx2) * s / steps);
              stitches.push({x: fx, y, color, type: "fill"});
              colorCounts[ci].fill++;
            }
            lastX = Math.round(sx2 + (ex2 - sx2) * steps / steps);
          } else {
            stitches.push({x: Math.round((x1 + x2) / 2), y, color, type: "fill"});
            colorCounts[ci].fill++;
            lastX = Math.round((x1 + x2) / 2);
          }
        }
        lastY = y;
      }
      rowIdx++;
    }
    globalLastX = lastX;
    globalLastY = lastY;
  }

  console.log("Stitches:", colors.map((c, i) => {
    const k = colorCounts[i];
    return `${normHex(c)} fill:${k.fill} satin:${k.satin} run:${k.running}`;
  }).join(" | "));

  return {stitches, colorCounts};
}
/* ─── QUALITY VALIDATION ─────────────────────────────────*/
function validateQuality(stitches){
  const w=[];
  let tot=0,cnt=0,maxJ=0,longJ=0,trimCount=0,prev=null;
  for(const s of stitches){
    if(s.type==="trim"){trimCount++;prev=null;continue;}
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
  return{avgStitchMM:(avg/10).toFixed(2),maxJumpMM:(maxJ/10).toFixed(2),longJumps:longJ,stitchCount:cnt,trimCount,warnings:w,passed:!w.length};
}

/* ─── SEW TIME CALCULATOR ────────────────────────────────*/
function calculateSewTime(stitchCount, trimCount, colorCount, machine) {
  const spm = { tajima: 800, brother: 650, barudan: 850, generic: 750 };
  const rate = spm[machine] || 750;
  
  const stitchMinutes = stitchCount / rate;
  const trimMinutes = (trimCount * 0.3) / 60;
  const colorChangeMinutes = Math.max(0, (colorCount - 1) * 0.5);
  
  const totalMinutes = Math.ceil(stitchMinutes + trimMinutes + colorChangeMinutes);
  
  if (totalMinutes < 1) return "< 1 min";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/* ─── PREVIEW RENDERER ───────────────────────────────────*/
async function renderPreview(pixMap, colors, stitches, params, canvasSize) {
  const renderSize = Math.min(canvasSize, PREVIEW_MAX);
  const scale = renderSize / canvasSize;
  
  const W = renderSize, H = renderSize;
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
    return { r, g, b, dr: Math.max(0, r - 45), dg: Math.max(0, g - 45), db: Math.max(0, b - 45) };
  });

  function setPixel(x, y, r, g, b, a) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = (py * W + px) * 4;
    const alpha = a / 255;
    buf[idx]     = Math.round(buf[idx]     * (1 - alpha) + r * alpha);
    buf[idx + 1] = Math.round(buf[idx + 1] * (1 - alpha) + g * alpha);
    buf[idx + 2] = Math.round(buf[idx + 2] * (1 - alpha) + b * alpha);
    buf[idx + 3] = 255;
  }

  function drawLine(x0, y0, x1, y1, r, g, b, thickness, alphaBase) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) {
      for(let ty = -1; ty <= 1; ty++) {
        for(let tx = -1; tx <= 1; tx++) {
          setPixel(x0 + tx, y0 + ty, r, g, b, alphaBase * 0.7);
        }
      }
      return;
    }

    const steps = Math.ceil(dist * 2.5);
    const nx = dist > 0 ? -dy / dist : 0;
    const ny = dist > 0 ? dx / dist : 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;

      setPixel(x, y, r, g, b, alphaBase);

      if (thickness >= 2) {
        setPixel(x + nx * 0.8, y + ny * 0.8, r, g, b, alphaBase * 0.85);
        setPixel(x - nx * 0.8, y - ny * 0.8, r, g, b, alphaBase * 0.85);
      }
      if (thickness >= 3) {
        setPixel(x + nx * 1.5, y + ny * 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x - nx * 1.5, y - ny * 1.5, r, g, b, alphaBase * 0.55);
      }
      if (thickness >= 4) {
        setPixel(x + nx * 2.5, y + ny * 2.5, r, g, b, alphaBase * 0.35);
        setPixel(x - nx * 2.5, y - ny * 2.5, r, g, b, alphaBase * 0.35);
        setPixel(x, y + 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x, y - 1.5, r, g, b, alphaBase * 0.55);
        setPixel(x, y + 2.5, r, g, b, alphaBase * 0.4);
        setPixel(x, y - 2.5, r, g, b, alphaBase * 0.4);
        setPixel(x, y + 3.2, r, g, b, alphaBase * 0.2);
        setPixel(x, y - 3.2, r, g, b, alphaBase * 0.2);
      }
    }
  }

  const scaledStitches = stitches.map(s => ({
    ...s,
    x: s.x * scale,
    y: s.y * scale
  }));

  const byColor = new Map();
  for (const s of scaledStitches) {
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
      if (Math.hypot(b.x - a.x, Math.abs(b.y - a.y)) > 80 * scale) continue;
      drawLine(a.x, a.y, b.x, b.y, tc.r, tc.g, tc.b, 1, 60);
    }

    for (let i = 0; i < covers.length; i++) {
      const s = covers[i];
      const next = covers[i + 1] || null;

      const isSatin = s.type === "satin";
      const isFill  = s.type === "fill";

      setPixel(s.x, s.y, tc.r, tc.g, tc.b, 240);
      setPixel(s.x + 1, s.y, tc.dr, tc.dg, tc.db, 160);
      setPixel(s.x, s.y + 1, tc.dr, tc.dg, tc.db, 140);
      setPixel(s.x - 1, s.y, tc.dr, tc.dg, tc.db, 140);
      setPixel(s.x, s.y - 1, tc.dr, tc.dg, tc.db, 120);

      if (next && next.color === s.color) {
        const jump = Math.hypot(next.x - s.x, next.y - s.y);
        if (jump < 50 * scale) {
          const thick = isSatin ? 3 : isFill ? 4 : 1;
          drawLine(s.x, s.y, next.x, next.y, tc.r, tc.g, tc.b, thick, 230);
        }
      }
    }
  }

  let cminX = canvasSize, cmaxX = 0, cminY = canvasSize, cmaxY = 0;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      if (pixMap[y * canvasSize + x] >= 0) {
        if (x < cminX) cminX = x; if (x > cmaxX) cmaxX = x;
        if (y < cminY) cminY = y; if (y > cmaxY) cmaxY = y;
      }
    }
  }
  
  const pad = Math.round(30 * scale);
  const cropX = Math.max(0, Math.round(cminX * scale) - pad);
  const cropY = Math.max(0, Math.round(cminY * scale) - pad);
  const cropW = Math.min(W, Math.round(cmaxX * scale) + pad) - cropX;
  const cropH = Math.min(H, Math.round(cmaxY * scale) + pad) - cropY;

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

/* ─── DST ENCODER ─────────────────────────────────────────*/
/* ============================================================
 *  DST ENCODER (Tajima specification)
 *  Each stitch record = 3 bytes. The dx,dy delta (-121..+121)
 *  is split into bit positions across all 3 bytes:
 *    byte0: ±1 and ±9 (X+Y)
 *    byte1: ±3 and ±27 (X+Y)
 *    byte2: ±81 (X+Y) + flag bits (0x03=stitch, 0x83=jump, 0xC3=color, 0xF3=end)
 *  The previous version put dx/dy as raw bytes which is why
 *  Embroidery Viewer Pro reads gibberish coordinates accumulating
 *  to thousands of millimeters in one direction.
 * ============================================================ */

// Encode one delta (-121..+121 in tenths of mm) into 3 DST bytes
// `flag` controls byte 2 high bits: false=stitch(0x03), true=jump(0x83)
function dstEncodeXY(dx, dy, isJump) {
  // DST machine Y-axis is up-positive (image Y is down-positive)
  let x = dx;
  let y = -dy;
  let b0 = 0, b1 = 0, b2 = 0;

  // ±81 -> byte 2
  if (x >  40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x20; x += 81; }
  if (y >  40) { b2 |= 0x80; y -= 81; }
  if (y < -40) { b2 |= 0x40; y += 81; }
  // ±27 -> byte 1
  if (x >  13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x20; x += 27; }
  if (y >  13) { b1 |= 0x80; y -= 27; }
  if (y < -13) { b1 |= 0x40; y += 27; }
  // ±9 -> byte 0
  if (x >   4) { b0 |= 0x04; x -=  9; }
  if (x <  -4) { b0 |= 0x20; x +=  9; }
  if (y >   4) { b0 |= 0x80; y -=  9; }
  if (y <  -4) { b0 |= 0x40; y +=  9; }
  // ±3 -> byte 1
  if (x >   1) { b1 |= 0x01; x -=  3; }
  if (x <  -1) { b1 |= 0x02; x +=  3; }
  if (y >   1) { b1 |= 0x08; y -=  3; }
  if (y <  -1) { b1 |= 0x10; y +=  3; }
  // ±1 -> byte 0
  if (x >   0) { b0 |= 0x01; x -=  1; }
  if (x <   0) { b0 |= 0x02; x +=  1; }
  if (y >   0) { b0 |= 0x08; y -=  1; }
  if (y <   0) { b0 |= 0x10; y +=  1; }

  b2 |= isJump ? 0x83 : 0x03;
  return Buffer.from([b0, b1, b2]);
}

// Build the 512-byte ASCII Tajima header
function dstHeader(stitchCount, colorCount, mnx, mxx, mny, mxy, name) {
  const buf = Buffer.alloc(512, 0x20);
  let off = 0;
  const writeField = (txt) => {
    buf.write(txt, off, "ascii");
    off += txt.length;
    buf[off++] = 0x0D;          // CR terminator
  };
  // LA:<16 chars name>
  const safeName = (name || "Stichai").substring(0, 16).padEnd(16, " ");
  writeField("LA:" + safeName);
  // Note: x extents are in DST units (0.1mm). Use absolute extents.
  // Y is inverted because DST uses machine-up = positive.
  writeField(`ST:${String(stitchCount).padStart(7, "0")}`);
  writeField(`CO:${String(colorCount).padStart(3, "0")}`);
  writeField(`+X:${String(Math.max(0, Math.round( mxx))).padStart(5, "0")}`);
  writeField(`-X:${String(Math.max(0, Math.round(-mnx))).padStart(5, "0")}`);
  writeField(`+Y:${String(Math.max(0, Math.round(-mny))).padStart(5, "0")}`);
  writeField(`-Y:${String(Math.max(0, Math.round( mxy))).padStart(5, "0")}`);
  // AX/AY are last-stitch offsets relative to start, leave zero (single design)
  writeField(`AX:+${String(0).padStart(5, "0")}`);
  writeField(`AY:+${String(0).padStart(5, "0")}`);
  writeField(`MX:+${String(0).padStart(5, "0")}`);
  writeField(`MY:+${String(0).padStart(5, "0")}`);
  writeField(`PD:******`);
  buf[off++] = 0x1A;            // EOF marker for header
  // Rest of header is already 0x20 (spaces)
  return buf;
}

function encodeDST(stitches) {
  const recs = [];
  let lastColor = null;
  let px = 0, py = 0;
  let stitchCount = 0;
  let colorChanges = 0;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;

  // Split a long move into multiple records of max ±121 each
  const emitLong = (dx, dy, isJump) => {
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(dx) / 121),
      Math.ceil(Math.abs(dy) / 121)
    );
    let prevFx = 0, prevFy = 0;
    for (let i = 1; i <= steps; i++) {
      const fx = Math.round(dx * i / steps);
      const fy = Math.round(dy * i / steps);
      recs.push(dstEncodeXY(fx - prevFx, fy - prevFy, isJump));
      prevFx = fx;
      prevFy = fy;
      stitchCount++;
    }
  };

  for (const s of stitches) {
    // Color change: emit color-change record (byte 2 = 0xC3)
    if (s.color !== lastColor && lastColor !== null) {
      recs.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChanges++;
      stitchCount++;
    }
    lastColor = s.color;

    const dx = Math.round(s.x - px);
    const dy = Math.round(s.y - py);
    px = s.x;
    py = s.y;

    const isTrimOrBridge = s.type === "trim" || s.type === "bridge" || s.type === "jump";

    if (Math.abs(dx) > 121 || Math.abs(dy) > 121) {
      emitLong(dx, dy, isTrimOrBridge);     // split, mark each piece as jump if applicable
    } else {
      recs.push(dstEncodeXY(dx, dy, isTrimOrBridge));
      stitchCount++;
    }

    // Track extents based on stitched coordinates
    if (s.x < mnx) mnx = s.x;
    if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y;
    if (s.y > mxy) mxy = s.y;
  }

  // End-of-design marker
  recs.push(Buffer.from([0x00, 0x00, 0xF3]));

  if (mnx === Infinity) { mnx = mxx = mny = mxy = 0; }

  const header = dstHeader(stitchCount, colorChanges + 1, mnx, mxx, mny, mxy, "Stichai");
  return Buffer.concat([header, ...recs]);
}

/* ─── JOBS & DETECTIONS ───────────────────────────────────*/
const jobs         = new Map();
const previewCache = new Map();
const detections   = new Map();

setInterval(()=>{
  const now = Date.now();
  for(const [id,d] of detections){ if(now-d.timestamp>300000) detections.delete(id); }
  for(const [id,j] of jobs){ if(now-j.ts>600000) jobs.delete(id); }
  for(const [id,c] of previewCache){ if(now-c.ts>300000) previewCache.delete(id); }
}, 60000);

/* ─── ROUTES ─────────────────────────────────────────────*/
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(_, res)=>res.sendFile(path.join(__dirname,"public","index.html")));

/* ─── DETECT SHAPES ──────────────────────────────────────*/
app.post("/detect-shapes", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});

    const body = req.body || {};
    const mode = body.mode || 'logo';
    const canvasSize = parseInt(body.canvasSize) || 800;
    const colorCount = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === 'photo' ? 8 : 12)));
    const designMm = canvasSize / 10;

    console.log(`[${rid}] DETECT: mode=${mode} size=${canvasSize}px colors=${colorCount}`);

    const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize);
    
    const colors = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
    
    const gem = await analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png", colorCount);

    const pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
    const rawRegions = extractRegions(pixMap, colors, canvasSize);
    const regions = mergeAdjacentRegions(rawRegions);

    if(!regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    const shapes=[];
    for(const r of regions){
      const pts=[[r.mnx,r.mny],[r.mxx,r.mny],[r.mxx,r.mxy],[r.mnx,r.mxy],[r.mnx,r.mny]];
      shapes.push({type:r.type,color:normHex(r.color),points:pts,
        bounds:{x:r.mnx,y:r.mny,w:r.mxx-r.mnx,h:r.mxy-r.mny},stitchCount:0});
    }

    const detectionId = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    detections.set(detectionId, {
      pixMap, regions, colors, cleanedBuffer, geminiNotes: gem?.notes || "", timestamp: Date.now(), mode, canvasSize
    });

    const colorInfo = {};
    colors.forEach(c => { colorInfo[c] = {label: '', coverage_pct: 0}; });

    return res.json({
      success:true,
      detectionId,
      colors,
      colorMeta:colorInfo,
      shapes,
      designMm,
      geminiNotes:gem?.notes||""
    });
  }catch(e){
    console.error(`[${rid}] DETECT CRASH:`,e.message, e.stack);
    return res.status(500).json({error:e.message||"Detection failed"});
  }
});

/* ─── GENERATE EMBROIDERY ────────────────────────────────*/
app.post("/generate-embroidery", upload.fields([{name:"image",maxCount:1},{name:"mask",maxCount:1}]), async(req,res)=>{
  res.setTimeout(120000);
  const rid=Math.random().toString(36).slice(2,6);
  try{
    const imgFile=req.files?.image?.[0];
    const maskFile=req.files?.mask?.[0];
    if(!imgFile) return res.status(400).json({error:"No image uploaded"});

    const body = req.body || {};
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

    const detectionId = body.detectionId;
    const det = detectionId ? detections.get(detectionId) : null;
    let pixMap, regions, colors, canvasSize, mode;

    if(det){
      pixMap = det.pixMap;
      regions = det.regions;
      colors = det.colors;
      canvasSize = det.canvasSize;
      mode = det.mode;
    }else{
      mode = body.mode || 'logo';
      canvasSize = parseInt(body.canvasSize) || 800;
      const colorCount = Math.min(16, Math.max(3, parseInt(body.colorCount) || (mode === 'photo' ? 8 : 12)));
      
      const cleanedBuffer = await preprocessImage(imgFile.buffer, canvasSize);
      colors = await extractColorsFromUnmasked(cleanedBuffer, maskFile?.buffer, canvasSize, colorCount);
      
      const gem = await analyzeWithGemini(imgFile.buffer, imgFile.mimetype || "image/png", colorCount);
      
      pixMap = await buildPixelMap(cleanedBuffer, maskFile?.buffer, colors, canvasSize);
      const rawRegions = extractRegions(pixMap, colors, canvasSize);
      regions = mergeAdjacentRegions(rawRegions);
    }

    if(!regions || !regions.length){
      return res.status(500).json({error:"No stitchable regions found"});
    }

    let selectedColors = colors;
    try{
      if(body.selectedColors){
        const parsed = JSON.parse(body.selectedColors);
        if(Array.isArray(parsed) && parsed.length>0) selectedColors = parsed.map(c => normHex(c));
      }
    }catch(e){}

    let filteredRegions = regions;
    try{
      if(body.selectedShapes){
        const parsed = JSON.parse(body.selectedShapes);
        if(Array.isArray(parsed) && parsed.length>0 && parsed.length < regions.length){
          filteredRegions = parsed.map(idx => regions[idx]).filter(Boolean);
        }
      }
    }catch(e){}

    if(selectedColors.length < colors.length){
      // FIX v49: Clone pixMap so we don't corrupt the detection cache,
      // AND remap remaining color indices to match the new selectedColors array.
      pixMap = new Int16Array(pixMap);

      const oldToNew = {};
      const excludedCis = new Set();
      colors.forEach((c,ci) => {
        if(!selectedColors.includes(normHex(c))) {
          excludedCis.add(ci);
        } else {
          oldToNew[ci] = selectedColors.findIndex(sc => normHex(sc) === normHex(c));
        }
      });

      for(let i=0;i<pixMap.length;i++){
        if(excludedCis.has(pixMap[i])) {
          pixMap[i] = -1;
        } else if (pixMap[i] >= 0) {
          pixMap[i] = oldToNew[pixMap[i]];
        }
      }

      filteredRegions = filteredRegions.filter(r => selectedColors.includes(normHex(r.color)));
      filteredRegions = filteredRegions.map(r => ({
        ...r,
        ci: selectedColors.findIndex(c => normHex(c) === normHex(r.color))
      }));
    }

    if(!filteredRegions.length){
      return res.status(400).json({error:"No regions left after selection — select more colors/shapes"});
    }

    const{stitches,colorCounts}=generateStitchesFromRegions(pixMap,filteredRegions,selectedColors,params,canvasSize);
    const coverCount=stitches.filter(s=>s.type!=="trim"&&s.type!=="underlay").length;
    if(coverCount<5){
      return res.status(500).json({error:"Not enough stitches — select more shapes or check contrast"});
    }

    let previewBuf = null;
    try {
      previewBuf = await renderPreview(pixMap, selectedColors, stitches, params, canvasSize);
    } catch(e) {
      console.error("Preview pre-render failed:", e.message);
    }

    const qa=validateQuality(stitches);
    const sewTime = calculateSewTime(qa.stitchCount, qa.trimCount, selectedColors.length, specs.machine);
    const designMm = canvasSize / 10;

    const id=Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    jobs.set(id,{
      stitches,pixMap,colors:selectedColors,params,
      designW:canvasSize,designH:canvasSize,designMm,
      ts:Date.now(),previewBuf,sewTime,mode,canvasSize
    });

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
      designSize:{w:canvasSize,h:canvasSize,mm:designMm},
      colors:selectedColors,colorMeta:{},
      geminiNotes:det?.geminiNotes||"",
      specs,
      tunedParams:params,
      qa,shapes,regions:filteredRegions.length,
      sewTime,mode
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
  
  if(d.previewBuf){
    res.setHeader("Content-Type","image/png");
    res.setHeader("Cache-Control","public,max-age=300");
    return res.send(d.previewBuf);
  }
  
  return res.status(500).json({error:"Preview not ready"});
});

app.get("/download/:id",(req,res)=>{
  const d=jobs.get(req.params.id);
  if(!d)return res.status(404).json({error:"Not found"});
  const buf=encodeDST(d.stitches);
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Content-Disposition",`attachment; filename="design.dst"`);
  return res.send(buf);
});

app.get("/health",(_,res)=>res.json({status:"ok",version:"63.0",features:"proper-dst-encoder,tajima-header,jump-records"}));

const PORT=process.env.PORT||3000;
const server=app.listen(PORT,()=>console.log(`Stichai v63 | :${PORT} | proper DST encoder`));
server.timeout=120000;
server.keepAliveTimeout=65000;
