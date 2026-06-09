"use strict";
/**
 * lib/vectorize.js  v2  —  Vector embroidery digitizer
 * Phase 1: fix safety cap, per-polygon NN ordering, hole-aware path groups
 * Phase 2: edge-walk underlay, pull compensation
 */
const { buildPixelMap, hexToRgb } = require("./image");

// ── potrace ──────────────────────────────────────────────────────────────────
let _pt = null;
function getPotrace() {
  if (_pt) return _pt;
  try { _pt = require("potrace"); return _pt; }
  catch { throw new Error("potrace not installed — run: npm install potrace"); }
}
function traceMask(pngBuf, opts={}) {
  const pt=getPotrace();
  return new Promise((res,rej) => pt.trace(pngBuf, {
    turdSize: opts.turdSize ?? 10,
    turnPolicy: pt.Potrace ? pt.Potrace.TURNPOLICY_MINORITY : "minority",
    threshold: 128, blackOnWhite: true,
    optCurve: true, alphaMax: 1.0, optTolerance: 0.2
  }, (e,s)=>e?rej(e):res(s)));
}

// ── SVG parser: returns PATH GROUPS (one per <path> = one connected region) ──
// Each group is an array of sub-polygons: [0]=outer boundary, [1..]=holes.
// This preserves the even-odd semantics from potrace correctly.
function parseSVGPathGroups(svg) {
  const groups=[];
  const re=/\bd\s*=\s*["']([^"']+)["']/g; let m;
  while ((m=re.exec(svg))!==null) {
    const polys=pathToPolygons(m[1]);
    if (polys.length) groups.push(polys);
  }
  return groups;
}

function pathToPolygons(d) {
  const tok=d.replace(/([MmLlCcQqHhVvZz])/g," $1 ").trim().split(/[\s,]+/).filter(Boolean);
  const out=[]; let pts=[],cx=0,cy=0,sx=0,sy=0,cmd="",i=0;
  const n=()=>parseFloat(tok[i++]);
  while (i<tok.length) {
    if (/^[MmLlCcQqHhVvZz]$/.test(tok[i])) { cmd=tok[i++]; }
    switch(cmd) {
      case"M":cx=n();cy=n();sx=cx;sy=cy;pts=[[cx,cy]];cmd="L";break;
      case"m":cx+=n();cy+=n();sx=cx;sy=cy;pts=[[cx,cy]];cmd="l";break;
      case"L":cx=n();cy=n();pts.push([cx,cy]);break;
      case"l":cx+=n();cy+=n();pts.push([cx,cy]);break;
      case"H":cx=n();pts.push([cx,cy]);break;
      case"h":cx+=n();pts.push([cx,cy]);break;
      case"V":cy=n();pts.push([cx,cy]);break;
      case"v":cy+=n();pts.push([cx,cy]);break;
      case"C":{ const x1=n(),y1=n(),x2=n(),y2=n(),ex=n(),ey=n();
        for(let s=1;s<=10;s++){const u=s/10,v=1-u;pts.push([v*v*v*cx+3*v*v*u*x1+3*v*u*u*x2+u*u*u*ex,v*v*v*cy+3*v*v*u*y1+3*v*u*u*y2+u*u*u*ey]);}
        cx=ex;cy=ey;break;}
      case"c":{ const x1=cx+n(),y1=cy+n(),x2=cx+n(),y2=cy+n(),ex=cx+n(),ey=cy+n();
        for(let s=1;s<=10;s++){const u=s/10,v=1-u;pts.push([v*v*v*cx+3*v*v*u*x1+3*v*u*u*x2+u*u*u*ex,v*v*v*cy+3*v*v*u*y1+3*v*u*u*y2+u*u*u*ey]);}
        cx=ex;cy=ey;break;}
      case"Z":case"z":if(pts.length>2)out.push([...pts]);pts=[];cx=sx;cy=sy;cmd="";break;
      default:i++;break;
    }
  }
  if (pts.length>2) out.push(pts);
  return out;
}

// ── Centroid of a polygon ────────────────────────────────────────────────────
function centroid(poly) {
  let x=0,y=0;
  for(const[px,py]of poly){x+=px;y+=py;}
  return [x/poly.length,y/poly.length];
}

// ── Scanline fill (even-odd, handles holes) ──────────────────────────────────
function scanlineRuns(polygons, pRow, pullComp=0) {
  let miny=Infinity,maxy=-Infinity;
  for(const p of polygons) for(const[,y]of p){if(y<miny)miny=y;if(y>maxy)maxy=y;}
  const runs=[]; const y0=Math.ceil(miny/pRow)*pRow;
  for(let y=y0;y<=maxy;y+=pRow){
    const xs=[];
    for(const poly of polygons){
      const n=poly.length;
      for(let i=0;i<n;i++){
        const[ax,ay]=poly[i],[bx,by]=poly[(i+1)%n];
        if((ay<=y&&by>y)||(by<=y&&ay>y)) xs.push(ax+(y-ay)/(by-ay)*(bx-ax));
      }
    }
    xs.sort((a,b)=>a-b);
    for(let k=0;k+1<xs.length;k+=2){
      const x0=xs[k]-pullComp, x1=xs[k+1]+pullComp;
      if(x1-x0>1) runs.push({y,x0,x1});
    }
  }
  return runs;
}

// ── Runs → stitches (serpentine, capped at maxStitch) ───────────────────────
const pRowTol=6; // px — row direction reset threshold
function runsToStitches(runs, color, maxStitch) {
  const st=[]; let prevY=null,prevX=null,dir=1;
  for(const{y,x0,x1}of runs){
    // flip direction for serpentine
    if(prevY!==null && Math.abs(y-prevY)>pRowTol) dir=1; // reset on big gap
    const[sX,eX]=dir>0?[x0,x1]:[x1,x0];
    // travel to start of this row
    if(prevX!==null) st.push({x:sX,y,color,type:"running"});
    // fill row (subdivided)
    const len=Math.abs(eX-sX);
    const nSeg=Math.max(1,Math.ceil(len/maxStitch));
    for(let k=1;k<=nSeg;k++) st.push({x:sX+(eX-sX)*k/nSeg,y,color,type:"fill"});
    prevY=y; prevX=eX; dir=-dir;
  }
  return st;
}

// ── Edge-walk underlay (boundary lock before tatami) ────────────────────────
function edgeWalkUnderlay(polygons, color, stepPx, trimGap) {
  // Walk the OUTER boundary once at double step, inset by 2px, before the fill.
  // This anchors the perimeter so tatami rows don't float away from the edge.
  return boundaryWalk(polygons.slice(0,1), color, stepPx*2, trimGap, 2); // only outer
}

// ── Boundary walk (resampled polygon boundary → running stitches) ────────────
function boundaryWalk(polygons, color, stepPx, trimGap, insetPx=0) {
  const paths=[];
  for(const poly of polygons){
    // inset polygon slightly if requested (pull-back for underlay)
    const c=centroid(poly);
    const inset=insetPx>0?poly.map(([x,y])=>{
      const dx=c[0]-x,dy=c[1]-y,d=Math.hypot(dx,dy)||1;
      return [x+dx/d*insetPx, y+dy/d*insetPx];
    }):poly;
    // resample boundary at stepPx intervals (correct arc-length walk)
    const pts=[[inset[0][0],inset[0][1]]]; let acc=0;
    for(let i=1;i<=inset.length;i++){
      const a=inset[(i-1)%inset.length], b=inset[i%inset.length];
      const segLen=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(segLen<1e-6) continue;
      let pos=0;
      while(acc+(segLen-pos)>=stepPx){
        pos+=stepPx-acc;
        const t=pos/segLen;
        pts.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]);
        acc=0;
      }
      acc+=segLen-pos;
    }
    if(pts.length>1) paths.push(pts);
  }
  // NN-order + sew short hops
  const used=new Array(paths.length).fill(false);
  const out=[]; let last=null;
  for(let k=0;k<paths.length;k++){
    let bi=-1,bd=Infinity;
    for(let j=0;j<paths.length;j++){
      if(used[j])continue;
      const d=last?(paths[j][0][0]-last[0])**2+(paths[j][0][1]-last[1])**2:0;
      if(d<bd){bd=d;bi=j;}
    }
    if(bi<0)break; used[bi]=true;
    const p=paths[bi];
    if(last){
      const d=Math.hypot(p[0][0]-last[0],p[0][1]-last[1]);
      if(d>trimGap) out.push({x:p[0][0],y:p[0][1],color,type:"trim"});
      else{ const n=Math.max(1,Math.ceil(d/stepPx)); for(let q=1;q<=n;q++) out.push({x:last[0]+(p[0][0]-last[0])*q/n,y:last[1]+(p[0][1]-last[1])*q/n,color,type:"running"}); }
    }
    for(const[x,y]of p) out.push({x,y,color,type:"running"});
    last=p[p.length-1];
  }
  return out;
}

// ── Binary mask PNG builder ──────────────────────────────────────────────────
async function buildMaskPNG(sharp, pixMap, ci, W, H) {
  const raw=Buffer.alloc(W*H*3);
  for(let i=0;i<W*H;i++){const v=pixMap[i]===ci?0:255;raw[i*3]=raw[i*3+1]=raw[i*3+2]=v;}
  return sharp(raw,{raw:{width:W,height:H,channels:3}}).png().toBuffer();
}

// ── Hard stitch-length cap ────────────────────────────────────────────────────
function hardCap(stitches, maxStitch, trimGap) {
  const out=[]; let prev=null;
  for(const s of stitches){
    if(prev && s.type!=="trim"){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>trimGap){
        out.push({x:s.x,y:s.y,color:s.color,type:"trim"});
        prev=null;
      } else if(d>maxStitch){
        const n=Math.ceil(d/maxStitch);
        for(let k=1;k<n;k++) out.push({x:prev.x+(s.x-prev.x)*k/n,y:prev.y+(s.y-prev.y)*k/n,color:s.color,type:s.type});
      }
    }
    out.push(s); prev=s;
  }
  return out;
}

// ── Main: vectorizeToDST ──────────────────────────────────────────────────────
async function vectorizeToDST(cleanedBuffer, colors, canvasSize, pxPerMm, params={}) {
  const sharp=require("sharp");
  const P=params;
  const pRow     = Math.max(3, Math.round((P.tatamiRow??4)));
  const maxStitch= Math.round(3.8 * pxPerMm);   // 3.8mm — under 4mm with margin
  const stepPx   = Math.max(8, Math.round(1.8*pxPerMm));
  const trimGap  = 7*pxPerMm;
  const pullComp = Math.round(0.3*pxPerMm);      // 0.3mm pull compensation
  const MIN_AREA = 1.5*pxPerMm*pxPerMm;

  const W=canvasSize, H=canvasSize;
  const pixMap = await buildPixelMap(cleanedBuffer, null, colors, W);

  const isMagenta=(h)=>{const{r,g,b}=hexToRgb(h);return g<r-55&&g<b-55&&r>110&&b>110;};
  const lum=(h)=>{const{r,g,b}=hexToRgb(h);return 0.299*r+0.587*g+0.114*b;};
  const darkCi=colors.reduce((di,c,i)=>lum(c)<lum(colors[di])?i:di,0);

  // Trace each colour → path groups
  const colorRegions=[];
  for(let ci=0;ci<colors.length;ci++){
    if(isMagenta(colors[ci])) continue;
    const pngBuf=await buildMaskPNG(sharp,pixMap,ci,W,H);
    let svg;
    try{ svg=await traceMask(pngBuf,{turdsize:Math.round(MIN_AREA)}); }
    catch(e){ console.warn(`[vec] ci=${ci} potrace fail: ${e.message}`); continue; }
    const groups=parseSVGPathGroups(svg);
    const subpaths=groups.reduce((s,g)=>s+g.length,0);
    const pathTags=(svg.match(/<path/g)||[]).length;
    const pi=svg.indexOf("<path");
    const head=pi>=0?svg.slice(pi,pi+100):svg.slice(0,100);
    console.log(`[vec] ci=${ci} ${colors[ci]} svgLen=${svg.length} pathTags=${pathTags} groups=${groups.length} subpaths=${subpaths} head=${JSON.stringify(head)}`);
    if(!groups.length) continue;
    const areaPx=groups.reduce((s,g)=>s+g[0].length,0);
    colorRegions.push({ci,color:colors[ci],groups,areaPx});
  }

  // Sort: large fills first, dark last
  colorRegions.sort((a,b)=>{
    if(a.ci===darkCi)return 1; if(b.ci===darkCi)return -1;
    return b.areaPx-a.areaPx;
  });

  const allStitches=[];
  let _last=null;

  const emitAll=(arr)=>{ for(const s of arr){allStitches.push(s);_last=s;} };

  const travelTo=(tx,ty,color)=>{
    if(!_last)return;
    const d=Math.hypot(tx-_last.x,ty-_last.y);
    if(d<=1)return;
    if(d>trimGap){allStitches.push({x:tx,y:ty,color,type:"trim"});_last={x:tx,y:ty,color,type:"trim"};return;}
    const sx=_last.x, sy=_last.y;
    const n=Math.max(1,Math.ceil(d/stepPx));
    for(let k=1;k<=n;k++) allStitches.push({x:sx+(tx-sx)*k/n,y:sy+(ty-sy)*k/n,color,type:"running"});
    _last={x:tx,y:ty,color,type:"running"};
  };

  for(const{ci,color,groups}of colorRegions){
    const isDark=ci===darkCi;

    if(isDark){
      // Dark colour → boundary running (outline on top)
      for(const group of groups){
        const bw=boundaryWalk(group,color,stepPx,trimGap);
        if(!bw.length)continue;
        travelTo(bw[0].x,bw[0].y,color);
        emitAll(bw);
      }
    } else {
      // Fill colour → NN-ordered groups, each with underlay + tatami + edge finish

      // NN-order path groups by centroid proximity
      const used=new Array(groups.length).fill(false);
      let curPos=_last?[_last.x,_last.y]:null;
      for(let pass=0;pass<groups.length;pass++){
        let bi=-1,bd=Infinity;
        for(let j=0;j<groups.length;j++){
          if(used[j])continue;
          const c=centroid(groups[j][0]);
          const d=curPos?Math.hypot(c[0]-curPos[0],c[1]-curPos[1]):0;
          if(d<bd){bd=d;bi=j;}
        }
        if(bi<0)break; used[bi]=true;
        const group=groups[bi];
        const outer=group[0];

        // --- PHASE 2A: Edge-walk underlay (perimeter lock) ---
        const ul=edgeWalkUnderlay(group,color,stepPx,trimGap);
        if(ul.length){ travelTo(ul[0].x,ul[0].y,color); emitAll(ul); }

        // --- PHASE 2B: Tatami fill with pull compensation ---
        const runs=scanlineRuns(group,pRow,pullComp);
        if(runs.length){
          const fs=runsToStitches(runs,color,maxStitch);
          if(fs.length){ travelTo(fs[0].x,fs[0].y,color); emitAll(fs); }
        }

        // --- PHASE 2C: Finish edge (closes fill-to-outline gap) ---
        const finish=boundaryWalk([outer],color,stepPx,trimGap,0);
        if(finish.length){ travelTo(finish[0].x,finish[0].y,color); emitAll(finish); }

        curPos=_last?[_last.x,_last.y]:centroid(outer);
      }
    }
  }

  // Hard stitch-length cap — guarantees p95 ≤ 3.8mm
  const capped=hardCap(allStitches,maxStitch,trimGap);
  const jc=capped.filter(s=>s.type==="trim"||s.type==="jump").length;
  console.log(`[vectorize] stitches=${capped.length} jumps=${jc} (${(100*jc/Math.max(1,capped.length)).toFixed(1)}%)`);
  const colorCounts=colors.map(()=>({count:0,type:"fill"}));
  for(let ci=0;ci<colors.length;ci++) colorCounts[ci].count=capped.filter(s=>s.color===colors[ci]&&s.type==="fill").length;
  return {stitches:capped,colorCounts};
}

module.exports = { vectorizeToDST, parseSVGPathGroups, scanlineRuns };
