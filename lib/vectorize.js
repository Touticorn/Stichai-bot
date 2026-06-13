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
const SATIN_ROW=4;
const SATIN_MAXW=68;
function satinStitches(runs,color,maxStitch){
  const st=[];let flip=false;
  for(const r of runs){
    const w=r.x1-r.x0;
    const[sX,eX]=flip?[r.x1,r.x0]:[r.x0,r.x1];
    st.push({x:sX,y:r.y,color,type:"running"});
    if(w>SATIN_MAXW){
      const n=Math.ceil(Math.abs(eX-sX)/maxStitch);
      for(let k=1;k<=n;k++)st.push({x:sX+(eX-sX)*k/n,y:r.y,color,type:"fill"});
    } else {
      st.push({x:eX,y:r.y,color,type:"satin"});
    }
    flip=!flip;
  }
  return st;
}

function resatinSection(sec,color,maxStitch){
  if(sec.length<6) return satinStitches(sec,color,maxStitch);
  const ctr=sec.map(r=>[(r.x0+r.x1)/2,r.y]);
  const cuts=[];let st=0;
  let refA=Math.atan2(ctr[4][1]-ctr[0][1],ctr[4][0]-ctr[0][0]);
  for(let i=5;i<ctr.length;i++){
    const a=Math.atan2(ctr[i][1]-ctr[i-4][1],ctr[i][0]-ctr[i-4][0]);
    let d=Math.abs(a-refA); if(d>Math.PI)d=2*Math.PI-d;
    if(d>0.52){ cuts.push([st,i-2]); st=i-2; refA=a; }
  }
  cuts.push([st,sec.length]);
  const out=[];
  for(const[s0,s1]of cuts){
    const sub=sec.slice(s0,s1);
    if(sub.length<4){ out.push(...satinStitches(sub,color,maxStitch)); continue; }
    const A=sub[0],B=sub[sub.length-1];
    const psi=Math.atan2(B.y-A.y,(B.x0+B.x1)/2-(A.x0+A.x1)/2);
    let dev=Math.abs(psi-Math.PI/2); dev=Math.min(dev,Math.PI-dev);
    if(dev<0.26){ out.push(...satinStitches(sub,color,maxStitch)); continue; }
    const poly=[];
    for(const r of sub) poly.push([r.x0,r.y]);
    for(let i=sub.length-1;i>=0;i--) poly.push([sub[i].x1,sub[i].y]);
    if(poly.length<6){ out.push(...satinStitches(sub,color,maxStitch)); continue; }
    const cc=centroid(poly);
    const dphi=Math.PI/2-psi;
    const cb=Math.cos(dphi),sb=Math.sin(dphi);
    const rp=poly.map(([px,py])=>[cc[0]+(px-cc[0])*cb-(py-cc[1])*sb, cc[1]+(px-cc[0])*sb+(py-cc[1])*cb]);
    const runs2=scanlineRuns([rp],SATIN_ROW,1);
    if(!runs2.length){ out.push(...satinStitches(sub,color,maxStitch)); continue; }
    const secs2=sectionRuns(runs2,SATIN_ROW);
    for(const s2 of secs2){
      const fs=satinStitches(s2,color,maxStitch);
      for(const s of fs){const dx=s.x-cc[0],dy=s.y-cc[1];s.x=cc[0]+dx*cb+dy*sb;s.y=cc[1]-dx*sb+dy*cb;}
      out.push(...fs);
    }
  }
  return out;
}

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
async function removeBorderBackground(sharp,cleanedBuffer,pm,W,H){
  const seen=new Uint8Array(W*H);
  const stack=new Int32Array(W*H);
  const seeds=[0, W-1, (H-1)*W, H*W-1, (W>>1)];
  const bg=new Uint8Array(W*H);
  let any=false;
  for(const s0 of seeds){
    if(seen[s0])continue;
    const col=pm[s0];
    if(col<0)continue;
    let top=0;stack[top++]=s0;seen[s0]=1;
    const px=[];
    while(top>0){
      const i=stack[--top];px.push(i);
      const xx=i%W,yy=(i/W)|0;
      if(xx>0&&!seen[i-1]&&pm[i-1]===col){seen[i-1]=1;stack[top++]=i-1;}
      if(xx<W-1&&!seen[i+1]&&pm[i+1]===col){seen[i+1]=1;stack[top++]=i+1;}
      if(yy>0&&!seen[i-W]&&pm[i-W]===col){seen[i-W]=1;stack[top++]=i-W;}
      if(yy<H-1&&!seen[i+W]&&pm[i+W]===col){seen[i+W]=1;stack[top++]=i+W;}
    }
    if(px.length > W*H*0.02){ for(const i of px) bg[i]=1; any=true; }
  }
  if(!any)return;
  let raw=null;
  try{
    raw=await sharp(cleanedBuffer).resize(W,H,{fit:"fill"}).removeAlpha().raw().toBuffer();
    if(!raw||raw.length<W*H*3) raw=null;
  }catch(e){ raw=null; }
  if(!raw){ for(let i=0;i<W*H;i++) if(bg[i]) pm[i]=-1; return; }
  const T=8;
  const e1=new Uint8Array(W*H);
  for(let y=0;y<H;y++){const o=y*W;let s=0;
    for(let x=0;x<=T&&x<W;x++)s+=bg[o+x];
    for(let x=0;x<W;x++){
      const lo=Math.max(0,x-T),hi=Math.min(W-1,x+T);
      e1[o+x]=(s===(hi-lo+1))?1:0;
      const ad=x+T+1,rm=x-T;if(ad<W)s+=bg[o+ad];if(rm>=0)s-=bg[o+rm];}}
  const core=new Uint8Array(W*H);
  for(let x=0;x<W;x++){let s=0;
    for(let y=0;y<=T&&y<H;y++)s+=e1[y*W+x];
    for(let y=0;y<H;y++){
      const lo=Math.max(0,y-T),hi=Math.min(H-1,y+T);
      core[y*W+x]=(s===(hi-lo+1))?1:0;
      const ad=y+T+1,rm=y-T;if(ad<H)s+=e1[ad*W+x];if(rm>=0)s-=e1[rm*W+x];}}
  const rs=[],gs=[],bs=[];
  for(let i=0;i<W*H;i+=17){
    if(core[i]){rs.push(raw[i*3]);gs.push(raw[i*3+1]);bs.push(raw[i*3+2]);}
  }
  if(!rs.length){ for(let i=0;i<W*H;i++) if(bg[i]) pm[i]=-1; return; }
  const med=a=>{a.sort((x,y)=>x-y);return a[a.length>>1];};
  const mr=med(rs),mg=med(gs),mb=med(bs);
  const D2=70*70;
  for(let i=0;i<W*H;i++){
    if(!bg[i])continue;
    const dr=raw[i*3]-mr,dg=raw[i*3+1]-mg,db=raw[i*3+2]-mb;
    if(dr*dr+dg*dg+db*db<=D2) pm[i]=-1;
  }
}

function absorbSlivers(pm,W,H,darkCi,magCi){
  for(let pass=0;pass<2;pass++){
    const lbl=new Int32Array(W*H);
    const stack=new Int32Array(W*H);
    let nc=0;
    const areas=[0],cols=[0],bestN=[0],pers=[0];
    for(let s=0;s<W*H;s++){
      if(lbl[s])continue;
      nc++;const col=pm[s];
      let top=0;stack[top++]=s;lbl[s]=nc;
      let area=0,per=0;
      const cnt=new Int32Array(18);
      while(top>0){
        const i=stack[--top];area++;
        const xx=i%W,yy=(i/W)|0;
        if(xx>0){const j=i-1;if(pm[j]===col){if(!lbl[j]){lbl[j]=nc;stack[top++]=j;}}else{per++;cnt[pm[j]+1]++;}}else per++;
        if(xx<W-1){const j=i+1;if(pm[j]===col){if(!lbl[j]){lbl[j]=nc;stack[top++]=j;}}else{per++;cnt[pm[j]+1]++;}}else per++;
        if(yy>0){const j=i-W;if(pm[j]===col){if(!lbl[j]){lbl[j]=nc;stack[top++]=j;}}else{per++;cnt[pm[j]+1]++;}}else per++;
        if(yy<H-1){const j=i+W;if(pm[j]===col){if(!lbl[j]){lbl[j]=nc;stack[top++]=j;}}else{per++;cnt[pm[j]+1]++;}}else per++;
      }
      let bi=-1,bc=0;
      for(let k=1;k<18;k++){if(cnt[k]>bc){bc=cnt[k];bi=k-1;}}
      areas.push(area);cols.push(col);bestN.push(bi);pers.push(per);
    }
    const tgt=new Int32Array(nc+1).fill(-1);
    let changed=0;
    for(let c=1;c<=nc;c++){
      const col=cols[c],a=areas[c],per=pers[c],bn=bestN[c];
      if(col===darkCi)continue;
      let absorb;
      if(col===magCi) absorb = a<2000;
      else absorb = (a<150) || (a<12000 && a<per*3.0);
      if(!absorb)continue;
      if(bn>=0){tgt[c]=bn;changed++;}
      else if(a<2000){tgt[c]=-2;changed++;}
    }
    if(!changed)break;
    for(let i=0;i<W*H;i++){const c=lbl[i];if(tgt[c]===-2)pm[i]=-1;else if(tgt[c]>=0)pm[i]=tgt[c];}
  }
}

function modeFilter(pm,W,H,nC){
  const out=new Int16Array(pm);
  const cnt=new Int16Array(nC+2);
  for(let y=2;y<H-2;y++){
    const o=y*W;
    for(let x=2;x<W-2;x++){
      const i=o+x,v=pm[i];
      if(pm[i-1]===v&&pm[i+1]===v&&pm[i-W]===v&&pm[i+W]===v) continue;
      cnt.fill(0);
      let best=v,bc=0;
      for(let dy=-2;dy<=2;dy++){
        const r=i+dy*W;
        for(let dx=-2;dx<=2;dx++){
          const u=pm[r+dx];
          if(u==null||u<0)continue;
          const c=++cnt[u];
          if(c>bc){bc=c;best=u;}
        }
      }
      out[i]=best;
    }
  }
  return out;
}

async function buildMaskPNG(sharp, pixMap, ci, W, H, tuckZone) {
  const a=new Uint8Array(W*H);
  for(let i=0;i<W*H;i++) a[i]=(pixMap[i]===ci)?1:0;

  function dilateBin(src,T){
    const b=new Uint8Array(W*H);
    for(let y=0;y<H;y++){const o=y*W;let s=0;
      for(let x=0;x<=T&&x<W;x++)s+=src[o+x];
      for(let x=0;x<W;x++){b[o+x]=s>0?1:0;const ad=x+T+1,rm=x-T;if(ad<W)s+=src[o+ad];if(rm>=0)s-=src[o+rm];}}
    const c=new Uint8Array(W*H);
    for(let x=0;x<W;x++){let s=0;
      for(let y=0;y<=T&&y<H;y++)s+=b[y*W+x];
      for(let y=0;y<H;y++){c[y*W+x]=s>0?1:0;const ad=y+T+1,rm=y-T;if(ad<H)s+=b[ad*W+x];if(rm>=0)s-=b[rm*W+x];}}
    return c;
  }
  function erodeBin(src,T){
    const b=new Uint8Array(W*H);
    for(let y=0;y<H;y++){const o=y*W;let s=0;
      for(let x=0;x<=T&&x<W;x++)s+=src[o+x];
      for(let x=0;x<W;x++){
        const lo=Math.max(0,x-T),hi=Math.min(W-1,x+T);
        b[o+x]=(s===(hi-lo+1))?1:0;
        const ad=x+T+1,rm=x-T;if(ad<W)s+=src[o+ad];if(rm>=0)s-=src[o+rm];}}
    const c=new Uint8Array(W*H);
    for(let x=0;x<W;x++){let s=0;
      for(let y=0;y<=T&&y<H;y++)s+=b[y*W+x];
      for(let y=0;y<H;y++){
        const lo=Math.max(0,y-T),hi=Math.min(H-1,y+T);
        c[y*W+x]=(s===(hi-lo+1))?1:0;
        const ad=y+T+1,rm=y-T;if(ad<H)s+=b[ad*W+x];if(rm>=0)s-=b[rm*W+x];}}
    return c;
  }

  let m=a;
  if(tuckZone){
    m=erodeBin(dilateBin(a,4),4);
    for(let i=0;i<W*H;i++) if(a[i]) m[i]=1;
  }

  const c2=dilateBin(m,1);

  if(tuckZone){
    for(let it=0;it<3;it++){
      const prev=c2.slice();
      for(let i=W;i<W*H-W;i++){
        if(prev[i]||!tuckZone[i])continue;
        if(prev[i-1]||prev[i+1]||prev[i-W]||prev[i+W])c2[i]=1;
      }
    }
  }
  const raw=Buffer.alloc(W*H*3);
  for(let i=0;i<W*H;i++){const v=c2[i]?0:255;raw[i*3]=raw[i*3+1]=raw[i*3+2]=v;}
  return sharp(raw,{raw:{width:W,height:H,channels:3}}).png().toBuffer();
}

// ── Hard stitch-length cap ────────────────────────────────────────────────────
function hardCap(stitches, maxStitch, trimGap) {
  const TRAVEL_CUT = Math.min(trimGap, 40);   // cut any move >4mm (0.1mm units) -> trim, not a sewn slash
  const out=[]; let prev=null;
  for(const s of stitches){
    if(prev && s.type!=="trim"){
      const d=Math.hypot(s.x-prev.x,s.y-prev.y);
      if(d>TRAVEL_CUT){
        out.push({x:s.x,y:s.y,color:s.color,type:"trim"});
        prev=null;
      } else if(d>maxStitch && s.type!=="satin"){
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
  const travelCut= 4*pxPerMm;   // cut (trim) any travel longer than 4mm instead of sewing a slash
  const pullComp = Math.max(1,Math.round(0.15*pxPerMm)); // 0.15mm pull comp
  const MIN_AREA = 1.5*pxPerMm*pxPerMm;
  const MIN_SUBPATH = 1.5*pxPerMm*pxPerMm;

  const W=canvasSize, H=canvasSize;
  const pixMap0 = await buildPixelMap(cleanedBuffer, null, colors, W);
  const pixMap = modeFilter(pixMap0, W, H, colors.length);

  const isMagenta=(h)=>{const{r,g,b}=hexToRgb(h);return g<r-55&&g<b-55&&r>110&&b>110;};
  const lum=(h)=>{const{r,g,b}=hexToRgb(h);return 0.299*r+0.587*g+0.114*b;};
  // v19: dark-unify + structural darkCi (ink = strokes, not dark blobs)
  const _cnt=new Array(colors.length).fill(0);
  const _edge=new Array(colors.length).fill(0);
  for(let yy=1;yy<H-1;yy++)for(let xx=1;xx<W-1;xx++){
    const i=yy*W+xx,v=pixMap[i];
    if(v<0)continue;
    _cnt[v]++;
    if(pixMap[i-1]!==v||pixMap[i+1]!==v||pixMap[i-W]!==v||pixMap[i+W]!==v)_edge[v]++;
  }
  {
    const cand=[];
    for(let c2=0;c2<colors.length;c2++) if(lum(colors[c2])<58) cand.push(c2);
    if(cand.length>1){
      cand.sort((p,q)=>_cnt[q]-_cnt[p]);
      const tg=cand[0], rT=hexToRgb(colors[tg]);
      for(const c2 of cand.slice(1)){
        const r2=hexToRgb(colors[c2]);
        const d2=(r2.r-rT.r)**2+(r2.g-rT.g)**2+(r2.b-rT.b)**2;
        if(d2<95*95){
          for(let i=0;i<W*H;i++) if(pixMap[i]===c2){pixMap[i]=tg;}
          _cnt[tg]+=_cnt[c2];_edge[tg]+=_edge[c2];_cnt[c2]=0;_edge[c2]=0;
          console.log(`[vec] dark-unify: ${colors[c2]} merged into ${colors[tg]}`);
        }
      }
    }
  }
  const darkCi=(()=>{
    let t1=-1,t2=-1;
    for(let c2=0;c2<colors.length;c2++){
      if(lum(colors[c2])>=58||_cnt[c2]===0)continue;
      const ef=_edge[c2]/_cnt[c2];
      if(ef>0.2&&(t1<0||_cnt[c2]>_cnt[t1]))t1=c2;
      if(t2<0||_cnt[c2]>_cnt[t2])t2=c2;
    }
    if(t1>=0)return t1;
    if(t2>=0)return t2;
    return colors.reduce((di,c,i)=>lum(c)<lum(colors[di])?i:di,0);
  })();

  const magCi=colors.reduce((mi,c,i)=>{
    const D=h=>{const v=hexToRgb(h);return (v.r-255)**2+v.g**2+(v.b-255)**2;};
    return D(c)<D(colors[mi])?i:mi;
  },0);
  await removeBorderBackground(sharp,cleanedBuffer,pixMap,W,H);
  absorbSlivers(pixMap,W,H,darkCi,magCi);

  // v18 auto-zoom: if the subject fills <80% of the canvas, crop the source
  // to the subject (canvas aspect, 4% margin) and rescan at full resolution.
  {
    let bx0=W,bx1=0,by0=H,by1=0,n=0;
    for(let yy=0;yy<H;yy++)for(let xx=0;xx<W;xx++){
      if(pixMap[yy*W+xx]>=0){n++;if(xx<bx0)bx0=xx;if(xx>bx1)bx1=xx;if(yy<by0)by0=yy;if(yy>by1)by1=yy;}
    }
    if(n>0){
      const bw=bx1-bx0+1,bh=by1-by0+1;
      if(Math.max(bw/W,bh/H)<0.8){
        const mar=0.04;
        let ex0=bx0-W*mar,ey0=by0-H*mar,ex1=bx1+W*mar,ey1=by1+H*mar;
        let ew=ex1-ex0,eh=ey1-ey0;
        const A=W/H;
        if(ew/eh<A){const d=(eh*A-ew)/2;ex0-=d;ex1+=d;}
        else{const d=(ew/A-eh)/2;ey0-=d;ey1+=d;}
        ex0=Math.max(0,ex0);ey0=Math.max(0,ey0);ex1=Math.min(W,ex1);ey1=Math.min(H,ey1);
        try{
          const meta=await sharp(cleanedBuffer).metadata();
          const sx=meta.width/W, sy=meta.height/H;
          const zoomBuf=await sharp(cleanedBuffer).extract({
            left:Math.round(ex0*sx), top:Math.round(ey0*sy),
            width:Math.round((ex1-ex0)*sx), height:Math.round((ey1-ey0)*sy)
          }).resize(W,H,{fit:"fill"}).png().toBuffer();
          const pm2_0=await buildPixelMap(zoomBuf,null,colors,W);
          const pm2=modeFilter(pm2_0,W,H,colors.length);
          await removeBorderBackground(sharp,zoomBuf,pm2,W,H);
          absorbSlivers(pm2,W,H,darkCi,magCi);
          pixMap.set(pm2);
          console.log(`[vec] auto-zoom: subject was ${Math.round(100*bw/W)}%x${Math.round(100*bh/H)}% of frame — rescanned at full size`);
        }catch(e){ console.warn("[vec] auto-zoom skipped:",e.message); }
      }
    }
  }

  const tuckZone=(()=>{
    const T=3;
    const a=new Uint8Array(W*H);
    for(let i=0;i<W*H;i++) a[i]=(pixMap[i]===darkCi)?1:0;
    const b=new Uint8Array(W*H);
    for(let y=0;y<H;y++){
      const o=y*W;let s=0;
      for(let x=0;x<=T&&x<W;x++)s+=a[o+x];
      for(let x=0;x<W;x++){
        b[o+x]=s>0?1:0;
        const add=x+T+1,rem=x-T;
        if(add<W)s+=a[o+add];
        if(rem>=0)s-=a[o+rem];
      }
    }
    const c=new Uint8Array(W*H);
    for(let x=0;x<W;x++){
      let s=0;
      for(let y=0;y<=T&&y<H;y++)s+=b[y*W+x];
      for(let y=0;y<H;y++){
        c[y*W+x]=s>0?1:0;
        const add=y+T+1,rem=y-T;
        if(add<H)s+=b[add*W+x];
        if(rem>=0)s-=b[rem*W+x];
      }
    }
    return c;
  })();

  // Trace each colour → path groups
  const colorRegions=[];
  for(let ci=0;ci<colors.length;ci++){
    if(isMagenta(colors[ci])) continue;
    const pngBuf=await buildMaskPNG(sharp,pixMap,ci,W,H, ci===darkCi?null:tuckZone);
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
    if(d>travelCut){allStitches.push({x:tx,y:ty,color,type:"trim"});_last={x:tx,y:ty,color,type:"trim"};return;}
    const sx=_last.x, sy=_last.y;
    const n=Math.max(1,Math.ceil(d/stepPx));
    for(let k=1;k<=n;k++) allStitches.push({x:sx+(tx-sx)*k/n,y:sy+(ty-sy)*k/n,color,type:"running"});
    _last={x:tx,y:ty,color,type:"running"};
  };

  for(const{ci,color,groups}of colorRegions){
    const isDark=ci===darkCi;

    if(isDark){
      // v10: dark colour → satin along each stroke (bold cartoon line work)
      for(const group of groups){
        const outer=group[0];
        const c0=centroid(outer);
        let xx=0,xy=0,yy=0;
        for(const[px,py]of outer){const dx=px-c0[0],dy=py-c0[1];xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;}
        const phi=Math.PI/2-0.5*Math.atan2(2*xy,xx-yy);
        const ca=Math.cos(phi),sa=Math.sin(phi);
        const rot=group.map(poly=>poly.map(([px,py])=>{const dx=px-c0[0],dy=py-c0[1];return[c0[0]+dx*ca-dy*sa,c0[1]+dx*sa+dy*ca];}));
        const runs=scanlineRuns(rot,SATIN_ROW,1);
        if(!runs.length){
          const bw=boundaryWalk(group,color,stepPx,trimGap);
          if(bw.length){travelTo(bw[0].x,bw[0].y,color);emitAll(bw);}
          continue;
        }
        const secs=sectionRuns(runs,SATIN_ROW);
        const starts=secs.map(s2=>{const r0=s2[0];const dx=r0.x0-c0[0],dy=r0.y-c0[1];return[c0[0]+dx*ca+dy*sa,c0[1]-dx*sa+dy*ca];});
        const u2=new Array(secs.length).fill(false);
        let sp=_last?[_last.x,_last.y]:c0;
        for(let q=0;q<secs.length;q++){
          let bj=-1,bD=Infinity;
          for(let j=0;j<secs.length;j++){if(u2[j])continue;const d=(starts[j][0]-sp[0])**2+(starts[j][1]-sp[1])**2;if(d<bD){bD=d;bj=j;}}
          if(bj<0)break;u2[bj]=true;
          const fs=resatinSection(secs[bj],color,maxStitch);
          for(const s of fs){const dx=s.x-c0[0],dy=s.y-c0[1];s.x=c0[0]+dx*ca+dy*sa;s.y=c0[1]-dx*sa+dy*ca;}
          if(fs.length){travelTo(fs[0].x,fs[0].y,color);emitAll(fs);sp=_last?[_last.x,_last.y]:starts[bj];}
        }
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
