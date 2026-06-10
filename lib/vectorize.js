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
      case"M":if(pts.length>2)out.push([...pts]);cx=n();cy=n();sx=cx;sy=cy;pts=[[cx,cy]];cmd="L";break;
      case"m":if(pts.length>2)out.push([...pts]);cx+=n();cy+=n();sx=cx;sy=cy;pts=[[cx,cy]];cmd="l";break;
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
function polyArea(poly){let a=0;for(let i=0;i<poly.length;i++){const[x1,y1]=poly[i],[x2,y2]=poly[(i+1)%poly.length];a+=x1*y2-x2*y1;}return Math.abs(a)/2;}
function filterSubpaths(polygons,minArea){const k=polygons.filter(p=>polyArea(p)>=minArea);return k.length?k:polygons.slice(0,1);}
function pointInPoly(pt,poly){let c=false;const px=pt[0],py=pt[1];for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))c=!c;}return c;}
function groupByContainment(polys){
  const n=polys.length; if(n<=1) return [polys];
  const areas=polys.map(polyArea);
  const depth=new Array(n).fill(0), parent=new Array(n).fill(-1);
  for(let i=0;i<n;i++){
    let bestA=Infinity;
    for(let j=0;j<n;j++){
      if(i===j||areas[j]<=areas[i])continue;
      if(pointInPoly(polys[i][0],polys[j])){depth[i]++;if(areas[j]<bestA){bestA=areas[j];parent[i]=j;}}
    }
  }
  const units=[],unitOf=new Array(n).fill(-1);
  for(let i=0;i<n;i++)if(depth[i]%2===0){unitOf[i]=units.length;units.push([polys[i]]);}
  for(let i=0;i<n;i++)if(depth[i]%2===1&&parent[i]>=0&&unitOf[parent[i]]>=0)units[unitOf[parent[i]]].push(polys[i]);
  return units;
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
function sectionRuns(runs,pRow){
  const used=new Array(runs.length).fill(false);
  const byRow=new Map();
  runs.forEach((r,i)=>{const k=Math.round(r.y/pRow);if(!byRow.has(k))byRow.set(k,[]);byRow.get(k).push(i);});
  const secs=[];
  for(let s=0;s<runs.length;s++){
    if(used[s])continue;
    const sec=[runs[s]];used[s]=true;let cur=s;let k=Math.round(runs[s].y/pRow);
    for(;;){
      const nxt=byRow.get(k+1);if(!nxt)break;
      let pick=-1,best=0;
      for(const j of nxt){
        if(used[j])continue;
        const ov=Math.min(runs[cur].x1,runs[j].x1)-Math.max(runs[cur].x0,runs[j].x0);
        if(ov>best){best=ov;pick=j;}
      }
      if(pick<0)break;
      used[pick]=true;sec.push(runs[pick]);cur=pick;k++;
    }
    secs.push(sec);
  }
  return secs;
}

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
  const DIL=1;
  const a=new Uint8Array(W*H);
  for(let i=0;i<W*H;i++) a[i]=(pixMap[i]===ci)?1:0;
  const b=new Uint8Array(W*H);
  for(let y=0;y<H;y++){
    const o=y*W;let s=0;
    for(let x=0;x<=DIL&&x<W;x++)s+=a[o+x];
    for(let x=0;x<W;x++){
      b[o+x]=s>0?1:0;
      const add=x+DIL+1,rem=x-DIL;
      if(add<W)s+=a[o+add];
      if(rem>=0)s-=a[o+rem];
    }
  }
  const c2=new Uint8Array(W*H);
  for(let x=0;x<W;x++){
    let s=0;
    for(let y=0;y<=DIL&&y<H;y++)s+=b[y*W+x];
    for(let y=0;y<H;y++){
      c2[y*W+x]=s>0?1:0;
      const add=y+DIL+1,rem=y-DIL;
      if(add<H)s+=b[add*W+x];
      if(rem>=0)s-=b[rem*W+x];
    }
  }
  const raw=Buffer.alloc(W*H*3);
  for(let i=0;i<W*H;i++){const v=c2[i]?0:255;raw[i*3]=raw[i*3+1]=raw[i*3+2]=v;}
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
      } else if(d<3 && s.type==="fill"){ continue; }
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
  const pullComp = Math.max(1,Math.round(0.15*pxPerMm)); // 0.15mm pull comp
  const MIN_AREA = 1.5*pxPerMm*pxPerMm;
  const MIN_SUBPATH = 1.5*pxPerMm*pxPerMm;

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
    const filtered=groups.map(g=>filterSubpaths(g,MIN_SUBPATH)).filter(g=>g.length);
    const keptSub=filtered.reduce((s,g)=>s+g.length,0);
    if(keptSub<subpaths) console.log(`[vec] ci=${ci} dropped ${subpaths-keptSub} tiny subpaths (kept ${keptSub})`);
    if(!filtered.length) continue;
    const units=filtered.flatMap(g=>groupByContainment(g));
    console.log(`[vec] ci=${ci} units=${units.length} (containment-grouped)`);
    const areaPx=units.reduce((s,g)=>s+g[0].length,0);
    colorRegions.push({ci,color:colors[ci],groups:units,areaPx});
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

      // v8: per-colour angle lock — dominant unit's PCA, all units share it
      let bigI=0,bigA=0;
      for(let g=0;g<groups.length;g++){const a=polyArea(groups[g][0]);if(a>bigA){bigA=a;bigI=g;}}
      const bo=groups[bigI][0], cB=centroid(bo);
      let xxB=0,xyB=0,yyB=0;
      for(const[px,py]of bo){const dx=px-cB[0],dy=py-cB[1];xxB+=dx*dx;xyB+=dx*dy;yyB+=dy*dy;}
      let colorPhi=Math.PI/2-0.5*Math.atan2(2*xyB,xxB-yyB);
      colorPhi=Math.round(colorPhi/(Math.PI/12))*(Math.PI/12);

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
        const aMm2=polyArea(outer)/(pxPerMm*pxPerMm);

        if(aMm2<15){
          const small=boundaryWalk(group,color,Math.max(6,Math.round(1.2*pxPerMm)),trimGap,0);
          if(small.length){ travelTo(small[0].x,small[0].y,color); emitAll(small); }
          curPos=_last?[_last.x,_last.y]:centroid(outer);
          continue;
        }

        // --- PHASE 2A: Edge-walk underlay (perimeter lock) ---
        const ul=edgeWalkUnderlay(group,color,stepPx,trimGap);
        if(ul.length){ travelTo(ul[0].x,ul[0].y,color); emitAll(ul); }

        // --- v7: per-unit fill direction (PCA long axis, snap 15deg) ---
        const c0=centroid(outer);
        const phi=colorPhi;
        const ca=Math.cos(phi),sa=Math.sin(phi);
        const rot=group.map(poly=>poly.map(([px,py])=>{const dx=px-c0[0],dy=py-c0[1];return[c0[0]+dx*ca-dy*sa,c0[1]+dx*sa+dy*ca];}));

        // --- PHASE 2B: sectioned tatami fill with pull compensation ---
        const runs=scanlineRuns(rot,pRow,pullComp);
        if(runs.length){
          const secs=sectionRuns(runs,pRow);
          const starts=secs.map(s2=>{const r0=s2[0];const dx=r0.x0-c0[0],dy=r0.y-c0[1];return[c0[0]+dx*ca+dy*sa,c0[1]-dx*sa+dy*ca];});
          const u2=new Array(secs.length).fill(false);
          let sp=_last?[_last.x,_last.y]:c0;
          for(let q=0;q<secs.length;q++){
            let bj=-1,bD=Infinity;
            for(let j=0;j<secs.length;j++){
              if(u2[j])continue;
              const d=(starts[j][0]-sp[0])**2+(starts[j][1]-sp[1])**2;
              if(d<bD){bD=d;bj=j;}
            }
            if(bj<0)break; u2[bj]=true;
            const fs=runsToStitches(secs[bj],color,maxStitch);
            for(const s of fs){const dx=s.x-c0[0],dy=s.y-c0[1];s.x=c0[0]+dx*ca+dy*sa;s.y=c0[1]-dx*sa+dy*ca;}
            if(fs.length){ travelTo(fs[0].x,fs[0].y,color); emitAll(fs); sp=_last?[_last.x,_last.y]:starts[bj]; }
          }
        }

        // --- PHASE 2C: Finish edge (closes fill-to-outline gap) ---
        const finish=boundaryWalk([outer],color,stepPx,trimGap,0);
        if(finish.length){ travelTo(finish[0].x,finish[0].y,color); emitAll(finish); }

        curPos=_last?[_last.x,_last.y]:centroid(outer);
      }
    }
  }

  // v8: lock stitches (tie-in/tie-off) at colour block boundaries
  function addLocks(sts){
    const out=[];
    const lock=(x,y,color)=>{out.push({x:x+3,y:y,color,type:"running"},{x:x-3,y:y+3,color,type:"running"},{x:x,y:y,color,type:"running"});};
    for(let i=0;i<sts.length;i++){
      const s=sts[i], prev=sts[i-1], next=sts[i+1];
      const cStart = (i===0 || (prev && prev.color!==s.color)) && s.type!=="trim";
      if(cStart){ out.push(s); lock(s.x,s.y,s.color); continue; }
      out.push(s);
      const cEnd = (!next || next.color!==s.color) && s.type!=="trim";
      if(cEnd) lock(s.x,s.y,s.color);
    }
    return out;
  }
  // Hard stitch-length cap — guarantees p95 ≤ 3.8mm
  const capped=addLocks(hardCap(allStitches,maxStitch,trimGap));
  const jc=capped.filter(s=>s.type==="trim"||s.type==="jump").length;
  console.log(`[vectorize] stitches=${capped.length} jumps=${jc} (${(100*jc/Math.max(1,capped.length)).toFixed(1)}%)`);
  const colorCounts=colors.map(()=>({count:0,type:"fill"}));
  for(let ci=0;ci<colors.length;ci++) colorCounts[ci].count=capped.filter(s=>s.color===colors[ci]&&s.type==="fill").length;
  return {stitches:capped,colorCounts};
}

module.exports = { vectorizeToDST, parseSVGPathGroups, scanlineRuns };
