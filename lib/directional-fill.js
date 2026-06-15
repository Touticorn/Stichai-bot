/**
 * directional-fill.js — curvature-guided fill that follows region form,
 * the way a hand digitizer lays stitches along a strand of hair or around
 * a limb, instead of one global scanline angle.
 *
 * Pipeline:
 *   1. Rasterize the region (outer poly minus holes) to a binary grid.
 *   2. Chamfer distance transform (JS, two-pass) -> dist-to-boundary.
 *   3. Flow field: stitch direction = perpendicular to grad(dist) = along form.
 *   4. Smooth the angle field so rows don't jitter.
 *   5. Trace fill rows that follow the angle field, spaced `rowPx` apart.
 *   6. Serpentine-order rows, emit stitches capped at maxStitch.
 *
 * Output: array of {x,y,color,type} in ORIGINAL coordinates (no rotation),
 * matching the interface the engine already consumes from runsToStitches.
 */

function polyBBox(polys) {
  let mnx=Infinity,mny=Infinity,mxx=-Infinity,mxy=-Infinity;
  for (const p of polys) for (const [x,y] of p) {
    if (x<mnx)mnx=x; if (x>mxx)mxx=x; if (y<mny)mny=y; if (y>mxy)mxy=y;
  }
  return {mnx,mny,mxx,mxy};
}

// even-odd point-in-polygon over a group (outer + holes)
function pointInGroup(x, y, group) {
  let inside=false;
  for (const poly of group) {
    const n=poly.length;
    for (let i=0,j=n-1;i<n;j=i++) {
      const [xi,yi]=poly[i], [xj,yj]=poly[j];
      if (((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
    }
  }
  return inside;
}

// Two-pass chamfer (3,4) distance transform on a Uint8 grid (1=inside).
function chamferDT(grid, W, H) {
  const INF=1e9;
  const d=new Float32Array(W*H);
  for (let i=0;i<W*H;i++) d[i]= grid[i] ? INF : 0;
  // forward
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const i=y*W+x; if (!grid[i]) continue;
    let b=d[i];
    if (x>0)            b=Math.min(b,d[i-1]+3);
    if (y>0)            b=Math.min(b,d[i-W]+3);
    if (x>0&&y>0)       b=Math.min(b,d[i-W-1]+4);
    if (x<W-1&&y>0)     b=Math.min(b,d[i-W+1]+4);
    d[i]=b;
  }
  // backward
  for (let y=H-1;y>=0;y--) for (let x=W-1;x>=0;x--) {
    const i=y*W+x; if (!grid[i]) continue;
    let b=d[i];
    if (x<W-1)          b=Math.min(b,d[i+1]+3);
    if (y<H-1)          b=Math.min(b,d[i+W]+3);
    if (x<W-1&&y<H-1)   b=Math.min(b,d[i+W+1]+4);
    if (x>0&&y<H-1)     b=Math.min(b,d[i+W-1]+4);
    d[i]=b;
  }
  for (let i=0;i<W*H;i++) d[i]/=3;
  return d;
}

/**
 * Compute a smoothed along-form angle field (radians) for the region.
 * Returns {ang, gridW, gridH, ox, oy, res, grid, dist}.
 */
function flowField(group, res) {
  const {mnx,mny,mxx,mxy}=polyBBox(group);
  const ox=mnx-2*res, oy=mny-2*res;
  const W=Math.max(4,Math.ceil((mxx-mnx)/res)+4);
  const H=Math.max(4,Math.ceil((mxy-mny)/res)+4);
  const grid=new Uint8Array(W*H);
  for (let gy=0;gy<H;gy++) for (let gx=0;gx<W;gx++) {
    const wx=ox+gx*res, wy=oy+gy*res;
    if (pointInGroup(wx,wy,group)) grid[gy*W+gx]=1;
  }
  const dist=chamferDT(grid,W,H);

  // gradient via central differences; along-form dir = perpendicular to grad
  const ang=new Float32Array(W*H);
  const cs=new Float32Array(W*H), sn=new Float32Array(W*H);
  const gmag=new Float32Array(W*H);
  for (let gy=0;gy<H;gy++) for (let gx=0;gx<W;gx++) {
    const i=gy*W+gx; if (!grid[i]) continue;
    const xm=gx>0?dist[i-1]:dist[i], xp=gx<W-1?dist[i+1]:dist[i];
    const ym=gy>0?dist[i-W]:dist[i], yp=gy<H-1?dist[i+W]:dist[i];
    const dxv=(xp-xm)/2, dyv=(yp-ym)/2;
    gmag[i]=Math.hypot(dxv,dyv);
    // along-form = perpendicular to gradient (-dy, dx)
    const a=Math.atan2(dxv,-dyv);
    // store as unit vector doubled-angle for averaging (handle 180 ambiguity)
    cs[i]=Math.cos(2*a); sn[i]=Math.sin(2*a);
  }
  // smooth the doubled-angle vector field (box blur, a few passes)
  for (let pass=0; pass<4; pass++) {
    const c2=cs.slice(), s2=sn.slice();
    for (let gy=1;gy<H-1;gy++) for (let gx=1;gx<W-1;gx++) {
      const i=gy*W+gx; if (!grid[i]) continue;
      let sc=0,ss=0,n=0;
      for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
        const j=i+dy*W+dx;
        if (grid[j]) { sc+=c2[j]; ss+=s2[j]; n++; }
      }
      if (n) { cs[i]=sc/n; sn[i]=ss/n; }
    }
  }
  for (let i=0;i<W*H;i++) if (grid[i]) ang[i]=0.5*Math.atan2(sn[i],cs[i]);
  // Dead-zone fix: where gradient magnitude is tiny (medial ridge / symmetric
  // centers), the direction is unreliable -> pull it toward the local smoothed
  // dominant axis so rows stay coherent instead of spinning.
  let dc=0,ds=0;
  for (let i=0;i<W*H;i++) if (grid[i]&&gmag[i]>0.15){ dc+=Math.cos(2*ang[i]); ds+=Math.sin(2*ang[i]); }
  const domA=0.5*Math.atan2(ds,dc);
  for (let i=0;i<W*H;i++){
    if(!grid[i])continue;
    if(gmag[i]<0.12){ ang[i]=domA; }      // fully unreliable -> dominant
    else if(gmag[i]<0.30){                  // weak -> blend toward dominant
      const w=(0.30-gmag[i])/0.18;
      const bx=(1-w)*Math.cos(2*ang[i])+w*Math.cos(2*domA);
      const by=(1-w)*Math.sin(2*ang[i])+w*Math.sin(2*domA);
      ang[i]=0.5*Math.atan2(by,bx);
    }
  }
  return {ang,grid,dist,gmag,W,H,ox,oy,res};
}

function sampleAngle(field, x, y) {
  const gx=Math.round((x-field.ox)/field.res);
  const gy=Math.round((y-field.oy)/field.res);
  if (gx<0||gy<0||gx>=field.W||gy>=field.H) return 0;
  return field.ang[gy*field.W+gx];
}
function inside(field, x, y) {
  const gx=Math.round((x-field.ox)/field.res);
  const gy=Math.round((y-field.oy)/field.res);
  if (gx<0||gy<0||gx>=field.W||gy>=field.H) return false;
  return !!field.grid[gy*field.W+gx];
}

/**
 * Trace curved fill rows following the angle field.
 * Strategy: seed rows perpendicular to the dominant axis, then each row is a
 * polyline that steps along the local along-form angle, staying inside.
 * Rows are seeded along the gradient (across-form) direction spaced rowPx.
 *
 * Returns array of polylines (each an array of [x,y]).
 */
// ---- Iso-band directional fill --------------------------------------------
// Assign every interior cell an across-form coordinate u (Dijkstra over the grid
// where moving ACROSS the flow costs full, moving ALONG the flow costs ~0).
// Iso-bands of u at rowPx spacing become evenly-spaced rows that follow the form.

function buildAcrossCoord(field) {
  const {W,H,grid,ang,res}=field;
  const N=W*H;
  const U=new Float32Array(N).fill(Infinity);
  // seed: all interior cells adjacent to boundary on the "low" side along dom axis.
  // Simpler robust seed: the single interior cell with min projection on across-axis.
  let mc=0,ms=0;
  for(let i=0;i<N;i++) if(grid[i]){mc+=Math.cos(2*ang[i]);ms+=Math.sin(2*ang[i]);}
  const domA=0.5*Math.atan2(ms,mc);
  const ux=Math.cos(domA+Math.PI/2), uy=Math.sin(domA+Math.PI/2); // across dir
  // fallback single seed = most-negative-projection interior cell
  let seed=-1,best=Infinity;
  for(let gy=0;gy<H;gy++)for(let gx=0;gx<W;gx++){const i=gy*W+gx;if(!grid[i])continue;const p=gx*ux+gy*uy;if(p<best){best=p;seed=i;}}
  // Multi-source seed: every interior cell that borders the background AND lies on
  // the "entry" side of the form (its boundary-normal points opposite +across).
  // This makes U a true distance-ACROSS-the-form, not distance from one corner.
  const isBoundary=(gx,gy)=>{
    const i=gy*W+gx; if(!grid[i])return false;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const nx=gx+dx,ny=gy+dy;
      if(nx<0||ny<0||nx>=W||ny>=H) return true;
      if(!grid[ny*W+nx]) return true;
    }
    return false;
  };
  const seeds=[];
  for(let gy=0;gy<H;gy++)for(let gx=0;gx<W;gx++){
    const i=gy*W+gx; if(!grid[i]||!isBoundary(gx,gy))continue;
    // outward normal ~ direction toward nearest background; approximate by summing
    // vectors to background neighbors
    let nxs=0,nys=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy)continue;
      const nx=gx+dx,ny=gy+dy;
      const out=(nx<0||ny<0||nx>=W||ny>=H)||!grid[ny*W+nx];
      if(out){nxs+=dx;nys+=dy;}
    }
    const nl=Math.hypot(nxs,nys)||1;
    const align=(nxs/nl)*ux+(nys/nl)*uy;   // +1 => normal points along +across
    if(align < -0.30) seeds.push(i);        // entry side (normal opposes +across)
  }
  if(!seeds.length){ // fallback: most-negative-projection cell
    seeds.push(seed);
  }
  const visited=new Uint8Array(N);
  const heap=[];
  const hpush=(c,i)=>{heap.push([c,i]); let k=heap.length-1; while(k>0){const p=(k-1)>>1; if(heap[p][0]<=heap[k][0])break; [heap[p],heap[k]]=[heap[k],heap[p]]; k=p;}};
  const hpop=()=>{const top=heap[0]; const last=heap.pop(); if(heap.length){heap[0]=last; let k=0; for(;;){let l=2*k+1,r=2*k+2,m=k; if(l<heap.length&&heap[l][0]<heap[m][0])m=l; if(r<heap.length&&heap[r][0]<heap[m][0])m=r; if(m===k)break; [heap[m],heap[k]]=[heap[k],heap[m]]; k=m;}} return top;};
  for(const sd of seeds){ U[sd]=0; hpush(0,sd); }
  while(heap.length){
    const [cu,i]=hpop();
    if(visited[i])continue; visited[i]=1;
    const gx=i%W, gy=(i-gx)/W;
    const a=ang[i]; const fxc=Math.cos(a), fyc=Math.sin(a); // along-flow unit
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy)continue;
      const nx=gx+dx, ny=gy+dy;
      if(nx<0||ny<0||nx>=W||ny>=H)continue;
      const j=ny*W+nx; if(!grid[j]||visited[j])continue;
      const segLen=Math.hypot(dx,dy)*res;
      // component across flow = step minus its projection on flow
      const sxn=dx/Math.hypot(dx,dy), syn=dy/Math.hypot(dx,dy);
      const along=Math.abs(sxn*fxc+syn*fyc);          // 0..1
      const across=Math.sqrt(Math.max(0,1-along*along));
      const cost=segLen*(across + 0.04);               // tiny base cost to keep finite
      const nu=cu+cost;
      if(nu<U[j]){ U[j]=nu; hpush(nu,j); }
    }
  }
  return {U,domA};
}

// Along-form coordinate V: Dijkstra where moving ALONG flow costs full distance,
// moving ACROSS costs ~0. Seed from one end of the form (extreme V cell).
function buildAlongCoord(field, Uref) {
  const {W,H,grid,ang,res,ox,oy}=field;
  const N=W*H;
  const V=new Float32Array(N).fill(Infinity);
  // dominant flow axis for picking an end
  let mc=0,ms=0; for(let i=0;i<N;i++) if(grid[i]){mc+=Math.cos(2*ang[i]);ms+=Math.sin(2*ang[i]);}
  const domA=0.5*Math.atan2(ms,mc);
  const ax=Math.cos(domA), ay=Math.sin(domA);
  // seed at the cell with min projection on flow axis (one tip)
  let seed=-1,best=Infinity;
  for(let gy=0;gy<H;gy++)for(let gx=0;gx<W;gx++){const i=gy*W+gx;if(!grid[i])continue;const p=gx*ax+gy*ay;if(p<best){best=p;seed=i;}}
  if(seed<0)return null;
  const visited=new Uint8Array(N);
  const heap=[];
  const hpush=(c,i)=>{heap.push([c,i]);let k=heap.length-1;while(k>0){const p=(k-1)>>1;if(heap[p][0]<=heap[k][0])break;[heap[p],heap[k]]=[heap[k],heap[p]];k=p;}};
  const hpop=()=>{const t=heap[0];const l=heap.pop();if(heap.length){heap[0]=l;let k=0;for(;;){let a=2*k+1,b=2*k+2,m=k;if(a<heap.length&&heap[a][0]<heap[m][0])m=a;if(b<heap.length&&heap[b][0]<heap[m][0])m=b;if(m===k)break;[heap[m],heap[k]]=[heap[k],heap[m]];k=m;}}return t;};
  V[seed]=0; hpush(0,seed);
  while(heap.length){
    const [cv,i]=hpop(); if(visited[i])continue; visited[i]=1;
    const gx=i%W, gy=(i-gx)/W;
    const a=ang[i]; const fx=Math.cos(a), fy=Math.sin(a);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy)continue; const nx=gx+dx,ny=gy+dy;
      if(nx<0||ny<0||nx>=W||ny>=H)continue; const j=ny*W+nx;
      if(!grid[j]||visited[j])continue;
      const sl=Math.hypot(dx,dy), sxn=dx/sl, syn=dy/sl;
      const along=Math.abs(sxn*fx+syn*fy);
      const cost=sl*res*(along+0.04);   // ALONG-flow steps accumulate V
      const nv=cv+cost;
      if(nv<V[j]){V[j]=nv; hpush(nv,j);}
    }
  }
  return V;
}

function traceRows(field, rowPx, stepPx) {
  const {W,H,grid,ox,oy,res}=field;
  const ac=buildAcrossCoord(field);
  if(!ac)return [];
  const {U}=ac;
  const V=buildAlongCoord(field,U);
  if(!V)return [];
  let umax=0,vmax=0;
  for(let i=0;i<W*H;i++) if(grid[i]){ if(isFinite(U[i])&&U[i]>umax)umax=U[i]; if(isFinite(V[i])&&V[i]>vmax)vmax=V[i]; }
  if(umax<=0||vmax<=0)return [];
  const nBands=Math.max(1,Math.round(umax/rowPx));
  // For each band, bin cells by V into columns of width ~stepPx, average position.
  const vBin=Math.max(stepPx*0.8, vmax/Math.max(8,Math.round(vmax/stepPx)));
  const nCols=Math.max(2,Math.ceil(vmax/vBin)+1);
  const rows=[];
  for(let b=0;b<=nBands;b++){
    const ulo=b*rowPx - rowPx*0.5, uhi=b*rowPx + rowPx*0.5;
    const sumX=new Float64Array(nCols), sumY=new Float64Array(nCols), cnt=new Int32Array(nCols);
    for(let gy=0;gy<H;gy++)for(let gx=0;gx<W;gx++){
      const i=gy*W+gx; if(!grid[i]||!isFinite(U[i])||!isFinite(V[i]))continue;
      if(U[i]<ulo||U[i]>=uhi)continue;
      const c=Math.min(nCols-1,Math.floor(V[i]/vBin));
      sumX[c]+=ox+gx*res; sumY[c]+=oy+gy*res; cnt[c]++;
    }
    // Split the band into V-contiguous segments (handles fold-back: each arm is a
    // separate run of occupied columns). A gap of >=2 empty columns = new segment.
    let seg=[]; let gap=0;
    const flush=()=>{ if(seg.length>=2) rows.push(seg); seg=[]; };
    for(let c=0;c<nCols;c++){
      if(cnt[c]>0){ seg.push([sumX[c]/cnt[c], sumY[c]/cnt[c]]); gap=0; }
      else { gap++; if(gap>=2 && seg.length) flush(); }
    }
    flush();
  }
  return rows;
}

/**
 * Public: directionalFill(group, color, pxPerMm, rowMm, maxStitchPx)
 * group = [outerPoly, hole1, hole2, ...] in original coords.
 * Returns {x,y,color,type} stitches (serpentine).
 */
// Detect fold and split the region polygon by a cutting line into two sub-groups.
// Returns null if no split needed, else [groupA, groupB] (each [outer,...holes]).
function splitIfFolded(group, pxPerMm) {
  // quick raster flow field to test fold extent
  const res=Math.max(1,Math.round(0.6*pxPerMm));
  const f=flowField(group,res);
  const {W,H,grid,ang}=f;
  // angle spread (doubled-angle vector mean -> per-cell deviation)
  let mc=0,ms=0,nC=0;
  for(let i=0;i<W*H;i++) if(grid[i]){mc+=Math.cos(2*ang[i]);ms+=Math.sin(2*ang[i]);nC++;}
  if(nC<20) return null;
  const dom=0.5*Math.atan2(ms,mc);
  let maxdev=0;
  for(let i=0;i<W*H;i++) if(grid[i]){
    let d=Math.abs(ang[i]-dom); if(d>Math.PI/2)d=Math.PI-d; if(d>maxdev)maxdev=d;
  }
  // fold if flow direction varies more than ~50deg from dominant
  if(maxdev < 1.40) return null;   // ~80deg: permit normal curves, reject true folds

  // cut line: through region centroid, perpendicular to dominant flow axis,
  // i.e. the cut runs ACROSS the fold so each side has monotonic flow.
  const outer=group[0];
  let cx=0,cy=0; for(const[x,y]of outer){cx+=x;cy+=y;} cx/=outer.length; cy/=outer.length;
  // The two arms sit on opposite sides of a line that runs ACROSS the form at the
  // fold. That cut line's normal is the dominant flow direction, so points are
  // separated by their projection onto the dominant axis.
  const side=(x,y)=> (x-cx)*Math.cos(dom)+(y-cy)*Math.sin(dom);
  // Build two polygons by clipping the outer ring at side=0. Simple split: walk ring,
  // emit vertices to current side bucket, insert intersection points at sign changes.
  function clip(poly, keepPos){
    const out=[]; const n=poly.length;
    for(let i=0;i<n;i++){
      const a=poly[i], b=poly[(i+1)%n];
      const sa=side(a[0],a[1]), sb=side(b[0],b[1]);
      const ina=keepPos?sa>=0:sa<=0, inb=keepPos?sb>=0:sb<=0;
      if(ina) out.push(a);
      if(ina!==inb){
        const t=sa/(sa-sb);
        out.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]);
      }
    }
    return out.length>=3?out:null;
  }
  const pa=clip(outer,true), pb=clip(outer,false);
  if(!pa||!pb) return null;
  // holes: assign each hole to the side its centroid falls on (approx; good enough)
  const holesA=[],holesB=[];
  for(let h=1;h<group.length;h++){
    const hp=group[h]; let hx=0,hy=0; for(const[x,y]of hp){hx+=x;hy+=y;} hx/=hp.length;hy/=hp.length;
    if(side(hx,hy)>=0) holesA.push(hp); else holesB.push(hp);
  }
  return [[pa,...holesA],[pb,...holesB]];
}

// Convex hull (Andrew's monotone chain) and solidity = area / hullArea.
// Solidity near 1 => roughly convex => the (U,V) fill coordinate is injective
// => directional fill is guaranteed clean (cannot fold back on itself).
function convexHull(pts){
  const p=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(p.length<3) return p;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[];
  for(const q of p){ while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],q)<=0)lo.pop(); lo.push(q); }
  const hi=[];
  for(let i=p.length-1;i>=0;i--){const q=p[i]; while(hi.length>=2&&cross(hi[hi.length-2],hi[hi.length-1],q)<=0)hi.pop(); hi.push(q);}
  lo.pop(); hi.pop(); return lo.concat(hi);
}
function polyAreaLocal(poly){let a=0;for(let i=0;i<poly.length;i++){const[x1,y1]=poly[i],[x2,y2]=poly[(i+1)%poly.length];a+=x1*y2-x2*y1;}return Math.abs(a)/2;}
function elongation(outer){
  let cx=0,cy=0; for(const[x,y]of outer){cx+=x;cy+=y;} cx/=outer.length; cy/=outer.length;
  let sxx=0,syy=0,sxy=0;
  for(const[x,y]of outer){const dx=x-cx,dy=y-cy; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy;}
  sxx/=outer.length; syy/=outer.length; sxy/=outer.length;
  const tr=sxx+syy, det=sxx*syy-sxy*sxy;
  const disc=Math.sqrt(Math.max(0,tr*tr/4-det));
  const l1=tr/2+disc, l2=tr/2-disc;
  if(l2<=1e-6) return 999;
  return Math.sqrt(l1/l2);
}
function solidity(outer){
  const h=convexHull(outer); if(h.length<3) return 0;
  const ha=polyAreaLocal(h); if(ha<=0) return 0;
  return polyAreaLocal(outer)/ha;
}

function directionalFill(group, color, pxPerMm, rowMm, maxStitchPx, _depth=0) {
  // Fold-back regions (arcs, U-shapes, bananas) are split once into monotonic
  // halves so the (U,V) coordinate stays injective. Limit recursion depth.
  // Gate by ELONGATION (matches the proven-clean strip case): activate only on
  // long, thin regions where the flow runs through without an interior singularity
  // (hair strands, limb/cloth segments). Blob-like regions (faces, torsos) have a
  // central flow singularity that tangles directional rows -> they decline here and
  // the caller falls back to the proven scanline fill.
  const elong=elongation(group[0]);
  if(elong < 3.0) return [];   // conservative: only clearly-elongated strips (proven safe)
  const res=Math.max(1, Math.round(0.4*pxPerMm));        // ~0.4mm raster cells
  const rowPx=Math.max(1.5, rowMm*pxPerMm);
  const stepPx=Math.max(2, Math.round(0.8*pxPerMm));
  const field=flowField(group, res);
  const rows=traceRows(field, rowPx, stepPx);
  if (!rows.length) return [];

  // Rows already arrive in U-band order (adjacent bands = physically adjacent rows).
  // Boustrophedon: keep that order, reverse alternate rows so each row's end is
  // near the next row's start -> short connectors, no cross-shape travel.
  const ordered=[];
  let cur=null;
  for (let k=0;k<rows.length;k++){
    let r=rows[k];
    if (cur){
      const head=r[0], tail=r[r.length-1];
      const dh=(head[0]-cur[0])**2+(head[1]-cur[1])**2;
      const dt=(tail[0]-cur[0])**2+(tail[1]-cur[1])**2;
      if (dt<dh) r=r.slice().reverse();   // start from whichever end is closer
    }
    ordered.push(r);
    cur=r[r.length-1];
  }

  // even-spacing resample each row so stitch spacing is uniform (no end-bunching)
  const resample=(poly,step)=>{
    if(poly.length<2)return poly;
    const out=[poly[0]]; let acc=0;
    for(let i=1;i<poly.length;i++){
      let [ax,ay]=poly[i-1],[bx,by]=poly[i];
      let segLen=Math.hypot(bx-ax,by-ay);
      while(acc+segLen>=step){
        const t=(step-acc)/segLen;
        const nx=ax+(bx-ax)*t, ny=ay+(by-ay)*t;
        out.push([nx,ny]);
        ax=nx; ay=ny; segLen=Math.hypot(bx-ax,by-ay); acc=0;
      }
      acc+=segLen;
    }
    const last=poly[poly.length-1];
    if(Math.hypot(out[out.length-1][0]-last[0],out[out.length-1][1]-last[1])>step*0.4) out.push(last);
    return out;
  };
  const resStep=Math.max(2, Math.round(0.7*pxPerMm));
  const ordered2=ordered.map(r=>resample(r,resStep));

  // emit stitches, capping segment length at maxStitchPx
  const out=[];
  for (const r of ordered2) {
    for (let i=0;i<r.length;i++){
      const [px,py]=r[i];
      if (i===0){ out.push({x:px,y:py,color,type:"running"}); continue; }
      const [qx,qy]=r[i-1];
      const seg=Math.hypot(px-qx,py-qy);
      if (seg>maxStitchPx){
        const n=Math.ceil(seg/maxStitchPx);
        for (let k=1;k<=n;k++) out.push({x:qx+(px-qx)*k/n,y:qy+(py-qy)*k/n,color,type:"fill"});
      } else {
        out.push({x:px,y:py,color,type:"fill"});
      }
    }
  }
  return out;
}

module.exports = { directionalFill, flowField, chamferDT, _internal:{ traceRows, buildAcrossCoord, buildAlongCoord, pointInGroup } };
