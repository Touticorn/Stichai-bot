"use strict";
/**
 * lib/vectorize.js  —  Vector-based embroidery digitizer (Option 1)
 *
 * Pipeline: cartoon PNG → per-colour binary mask → potrace SVG → clean polygon
 *           paths → scanline tatami fill → DST stitches.
 *
 * Advantages over the pixMap approach:
 *   • No fragmentation — potrace gives one clean closed path per region.
 *   • No fill-to-outline gap — the fill is bounded by the exact polygon edge.
 *   • No thin-strip misclassification — polygon area/width decides fill type.
 *   • Holes handled correctly via even-odd SVG winding rule.
 */

const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const { buildPixelMap, hexToRgb, normHex } = require("./image");

// ── potrace wrapper (npm package — pure JS, no binary needed) ───────────────
let _pt = null;
function getPotrace() {
  if (_pt) return _pt;
  try { _pt = require("potrace"); return _pt; }
  catch { throw new Error("potrace npm package not installed. Run: npm install potrace"); }
}

/** Trace a binary PNG buffer through potrace → SVG string */
function traceMask(pngBuf, opts = {}) {
  const pt = getPotrace();
  return new Promise((res, rej) => {
    pt.trace(pngBuf, {
      turdsize:    opts.turdsize    ?? 8,     // drop specks smaller than 8px
      threshold:   opts.threshold   ?? 128,
      turnpolicy:  opts.turnpolicy  ?? "black",
      optcurve:    true,
      alphamax:    1.0,
      opttolerance: 0.2,
      ...opts
    }, (err, svg) => { if (err) rej(err); else res(svg); });
  });
}

// ── SVG path parser ─────────────────────────────────────────────────────────
/** Parse SVG string → array of polygon arrays [[x,y],...] */
function parseSVGPaths(svg) {
  const polys = [];
  const re = /\sd="([^"]+)"/g; let m;
  while ((m = re.exec(svg)) !== null) polys.push(...pathToPolygons(m[1]));
  return polys;
}

function pathToPolygons(d) {
  const tokens = d.replace(/([MmLlCcQqZz])/g, " $1 ").trim()
                  .split(/[\s,]+/).filter(Boolean);
  const out = []; let pts = [], cx=0, cy=0, sx=0, sy=0, cmd="";
  let i=0;
  const n = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlCcQqZz]$/.test(t)) { cmd = t; i++; }
    switch (cmd) {
      case "M": cx=n(); cy=n(); sx=cx; sy=cy; pts=[[cx,cy]]; cmd="L"; break;
      case "m": cx+=n(); cy+=n(); sx=cx; sy=cy; pts=[[cx,cy]]; cmd="l"; break;
      case "L": { cx=n(); cy=n(); pts.push([cx,cy]); break; }
      case "l": { cx+=n(); cy+=n(); pts.push([cx,cy]); break; }
      case "H": { cx=n(); pts.push([cx,cy]); break; }
      case "h": { cx+=n(); pts.push([cx,cy]); break; }
      case "V": { cy=n(); pts.push([cx,cy]); break; }
      case "v": { cy+=n(); pts.push([cx,cy]); break; }
      case "C": {  // cubic bezier → 10-point approximation
        const x1=n(),y1=n(),x2=n(),y2=n(),ex=n(),ey=n();
        for (let s=1;s<=10;s++) {
          const u=s/10,v=1-u;
          pts.push([v*v*v*cx+3*v*v*u*x1+3*v*u*u*x2+u*u*u*ex,
                    v*v*v*cy+3*v*v*u*y1+3*v*u*u*y2+u*u*u*ey]);
        }
        cx=ex; cy=ey; break;
      }
      case "c": {
        const x1=cx+n(),y1=cy+n(),x2=cx+n(),y2=cy+n(),ex=cx+n(),ey=cy+n();
        for (let s=1;s<=10;s++) {
          const u=s/10,v=1-u;
          pts.push([v*v*v*cx+3*v*v*u*x1+3*v*u*u*x2+u*u*u*ex,
                    v*v*v*cy+3*v*v*u*y1+3*v*u*u*y2+u*u*u*ey]);
        }
        cx=ex; cy=ey; break;
      }
      case "Z": case "z":
        if (pts.length > 2) out.push([...pts]);
        pts=[]; cx=sx; cy=sy; cmd=""; break;
      default: i++; break;
    }
  }
  if (pts.length > 2) out.push(pts);
  return out;
}

// ── Scanline polygon fill ────────────────────────────────────────────────────
function scanlineRuns(polygons, pRow) {
  let miny=Infinity, maxy=-Infinity;
  for (const p of polygons) for (const [,y] of p) {
    if (y < miny) miny=y; if (y > maxy) maxy=y;
  }
  const runs=[]; const y0=Math.ceil(miny/pRow)*pRow;
  for (let y=y0; y<=maxy; y+=pRow) {
    const xs=[];
    for (const poly of polygons) {
      const n=poly.length;
      for (let i=0;i<n;i++) {
        const [ax,ay]=poly[i], [bx,by]=poly[(i+1)%n];
        if ((ay<=y && by>y) || (by<=y && ay>y))
          xs.push(ax + (y-ay)/(by-ay) * (bx-ax));
      }
    }
    xs.sort((a,b)=>a-b);
    for (let k=0; k+1<xs.length; k+=2) {
      if (xs[k+1]-xs[k] > 1) runs.push({y, x0:xs[k], x1:xs[k+1]});
    }
  }
  return runs;
}

/**
 * Convert scanline runs to stitches.
 * Consecutive rows connect with a short diagonal travel stitch.
 * Long runs are subdivided to maxStitch length.
 */
function runsToStitches(runs, color, maxStitch) {
  const stitches=[]; let prev=null;
  for (const {y, x0, x1} of runs) {
    const dir = (prev && Math.abs(prev.y-y) < 6) ? prev.dir : 1;
    const [startX, endX] = dir>0 ? [x0,x1] : [x1,x0];
    // travel from previous run end to this run start
    if (prev) {
      stitches.push({x:startX, y, color, type:"running"});
    }
    // fill the run with subdivided stitches
    const len = Math.abs(endX-startX);
    const nSeg = Math.max(1, Math.ceil(len/maxStitch));
    for (let k=1; k<=nSeg; k++) {
      stitches.push({x: startX + (endX-startX)*k/nSeg, y, color, type:"fill"});
    }
    prev = {y, endX, dir: -dir};
  }
  return stitches;
}

// ── Polygon boundary running stitches ───────────────────────────────────────
function boundaryRunning(polygons, color, stepPx, trimGapPx=70) {
  // resample each polygon boundary at stepPx intervals
  const paths=[];
  for (const poly of polygons) {
    const pts=[]; let acc=0, prev=null;
    for (let i=0; i<=poly.length; i++) {
      const [x,y]=poly[i%poly.length];
      if (prev) {
        const d=Math.hypot(x-prev[0],y-prev[1]);
        while (acc+d >= stepPx) {
          const t=(stepPx-acc)/d;
          pts.push([prev[0]+(x-prev[0])*t, prev[1]+(y-prev[1])*t]);
          prev=[prev[0]+(x-prev[0])*t, prev[1]+(y-prev[1])*t];
          acc=0;
        }
        acc+=d;
      }
      prev=[x,y];
    }
    if (pts.length > 1) paths.push(pts);
  }
  // NN-order paths and sew short hops as running
  const used=new Array(paths.length).fill(false);
  const out=[]; let last=null;
  for (let k=0; k<paths.length; k++) {
    let bi=-1, bd=Infinity;
    for (let j=0; j<paths.length; j++) {
      if (used[j]) continue;
      const d=last?(paths[j][0][0]-last[0])**2+(paths[j][0][1]-last[1])**2:0;
      if (d<bd) { bd=d; bi=j; }
    }
    if (bi<0) break; used[bi]=true;
    const p=paths[bi];
    if (last) {
      const d=Math.hypot(p[0][0]-last[0],p[0][1]-last[1]);
      if (d>trimGapPx) out.push({x:p[0][0],y:p[0][1],color,type:"trim"});
      else {
        const n=Math.max(1,Math.ceil(d/stepPx));
        for(let q=1;q<=n;q++) out.push({x:last[0]+(p[0][0]-last[0])*q/n,y:last[1]+(p[0][1]-last[1])*q/n,color,type:"running"});
      }
    }
    for (const [x,y] of p) out.push({x,y,color,type:"running"});
    last=p[p.length-1];
  }
  return out;
}

// ── Colour mask PNG builder ──────────────────────────────────────────────────
/** For a given ci, build a binary PNG (black=target, white=other) via pixMap */
async function buildMaskPNG(sharp, pixMap, ci, canvasSize) {
  const W=canvasSize, H=canvasSize;
  const raw=Buffer.alloc(W*H*3);
  for (let i=0;i<W*H;i++) {
    const v = pixMap[i]===ci ? 0 : 255;
    raw[i*3]=raw[i*3+1]=raw[i*3+2]=v;
  }
  return sharp(raw,{raw:{width:W,height:H,channels:3}}).png().toBuffer();
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * vectorizeToDST(cleanedBuffer, colors, canvasSize, pxPerMm, params)
 *
 * Replaces v72_buildAndGenerate for cartoon mode.
 * Returns { stitches, colorCounts } in the same shape as v72.
 */
async function vectorizeToDST(cleanedBuffer, colors, canvasSize, pxPerMm, params={}) {
  const sharp = require("sharp");
  const P = params;
  const pRow     = Math.max(3, Math.round((P.tatamiRow ?? 4)));   // px
  const maxStitch= Math.max(20, Math.round(4.0 * pxPerMm));       // 4mm cap
  const stepPx   = Math.max(8,  Math.round(1.8 * pxPerMm));       // outline step
  const trimGap  = 7 * pxPerMm;                                   // 7mm
  const MIN_AREA = 1.5 * pxPerMm * pxPerMm;                       // 1.5mm²

  // 1. Build pixel map (one pass, all colours)
  const pixMap = await buildPixelMap(cleanedBuffer, null, colors, canvasSize);

  // 2. Identify magenta (background) and dark (outline) colour indices
  const { r: mgR, g: mgG, b: mgB } = hexToRgb(colors[0] ?? "#FF00FF");
  const isMagenta = (h) => { const{r,g,b}=hexToRgb(h); return g<r-55&&g<b-55&&r>110&&b>110; };
  const lum = (h) => { const{r,g,b}=hexToRgb(h); return 0.299*r+0.587*g+0.114*b; };
  const darkCi = colors.reduce((di,c,i)=>lum(c)<lum(colors[di])?i:di, 0);

  // 3. Trace each colour with potrace
  const colorRegions = [];   // { ci, color, polygons, areaPx }
  for (let ci=0; ci<colors.length; ci++) {
    if (isMagenta(colors[ci])) continue;    // skip background
    const pngBuf = await buildMaskPNG(sharp, pixMap, ci, canvasSize);
    let svg;
    try { svg = await traceMask(pngBuf, { turdsize: Math.round(MIN_AREA) }); }
    catch { console.warn(`[vectorize] potrace failed for ci=${ci}, skipping`); continue; }
    const polys = parseSVGPaths(svg);
    if (!polys.length) continue;
    const areaPx = polys.reduce((s,p)=>s+p.length,0);
    colorRegions.push({ ci, color:colors[ci], polygons:polys, areaPx });
  }

  // 4. Sort: large fills first; dark outline last
  colorRegions.sort((a,b) => {
    if (a.ci===darkCi) return 1; if (b.ci===darkCi) return -1;
    return b.areaPx-a.areaPx;
  });

  // 5. Generate stitches
  const stitches=[]; let _lastPt=null;
  const colorCounts=colors.map(()=>({count:0,type:"fill"}));

  const travel=(nx,ny,color)=>{
    if (!_lastPt) return;
    const d=Math.hypot(nx-_lastPt.x,ny-_lastPt.y);
    if (d<=1) return;
    if (d>trimGap) { stitches.push({x:_lastPt.x,y:_lastPt.y,color,type:"trim"}); return; }
    const n=Math.max(1,Math.ceil(d/stepPx));
    for(let k=1;k<=n;k++) stitches.push({x:_lastPt.x+(nx-_lastPt.x)*k/n,y:_lastPt.y+(ny-_lastPt.y)*k/n,color,type:"running"});
    _lastPt={x:nx,y:ny};
  };
  const emit=(s)=>{ stitches.push(s); _lastPt={x:s.x,y:s.y}; if(s.type==="fill"&&colorCounts[s.ci??0])colorCounts[0].count++; };

  for (const {ci, color, polygons} of colorRegions) {
    const isDark = ci===darkCi;

    if (isDark) {
      // Dark outline colour: boundary running stitches only
      const ol=boundaryRunning(polygons,color,stepPx,trimGap);
      if (!ol.length) continue;
      travel(ol[0].x, ol[0].y, color);
      for (const s of ol) emit(s);
    } else {
      // Fill colour: scanline tatami + boundary outline
      const runs = scanlineRuns(polygons, pRow);
      if (!runs.length) continue;
      travel(runs[0].x0, runs[0].y, color);
      const fillSt = runsToStitches(runs, color, maxStitch);
      for (const s of fillSt) emit(s);
      // light boundary walk on top (closes fill-to-edge gap)
      const ol=boundaryRunning(polygons,color,stepPx*2,trimGap);
      for (const s of ol) emit(s);
    }
    if (colorCounts[ci]) colorCounts[ci].count = stitches.filter(s=>s.color===color&&s.type==="fill").length;
  }

  // 6. Safety pass: split any remaining stitch > 4mm
  const safe=[]; let prev=null;
  for (const s of stitches) {
    if (prev && s.type!=="trim") {
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if (d>trimGap) { safe.push({x:s.x,y:s.y,color:s.color,type:"trim"}); prev=null; }
      else if (d>maxStitch) {
        const n=Math.ceil(d/maxStitch);
        for(let k=1;k<n;k++) safe.push({x:prev.x+(s.x-prev.x)*k/n,y:prev.y+(s.y-prev.y)*k/n,color:s.color,type:s.type});
      }
    }
    safe.push(s); prev=s;
  }

  const jc=safe.filter(s=>s.type==="trim"||s.type==="jump").length;
  console.log(`[vectorize] stitches=${safe.length} trims/jumps=${jc} (${(100*jc/Math.max(1,safe.length)).toFixed(1)}%)`);
  return { stitches:safe, colorCounts };
}

module.exports = { vectorizeToDST, parseSVGPaths, scanlineRuns };
