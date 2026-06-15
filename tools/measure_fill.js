// measure_fill.js — measure FILL density vs maxStitch using the REAL engine
// fill path (scanlineRuns from lib/vectorize.js) on a controlled solid shape.
// No sharp/Gemini needed. Units: px where 1px=0.1mm (pxPerMm=10).
const { scanlineRuns } = require("../lib/vectorize");

const pRowTol = 6; // must match vectorize.js
// verbatim copy of runsToStitches (not exported) so we measure exact engine output
function runsToStitches(runs, color, maxStitch, travelCut = 80) {
  const st=[]; let prevY=null,prevX=null,dir=1;
  for(const{y,x0,x1}of runs){
    if(prevY!==null && Math.abs(y-prevY)>pRowTol) dir=1;
    const[sX,eX]=dir>0?[x0,x1]:[x1,x0];
    if(prevX!==null){const d=Math.hypot(sX-prevX,y-prevY);
      st.push({x:sX,y,color,type:d>travelCut?"trim":"running"});}
    const len=Math.abs(eX-sX);
    const nSeg=Math.max(1,Math.ceil(len/maxStitch));
    for(let k=1;k<=nSeg;k++) st.push({x:sX+(eX-sX)*k/nSeg,y,color,type:"fill"});
    prevY=y; prevX=eX; dir=-dir;
  }
  return st;
}

// solid 40mm x 40mm square (400x400 px)
const SIDE = 400;
const poly = [[0,0],[SIDE,0],[SIDE,SIDE],[0,SIDE]];
const pullComp = 2;    // 0.2mm
const areaMm2 = (SIDE/10)*(SIDE/10);  // 1600 mm^2

function measure(maxStitchPx, pRow){
  const runs = scanlineRuns([poly], pRow, pullComp);
  const st = runsToStitches(runs, 0, maxStitchPx);
  const fills = st.filter(s=>s.type==="fill");
  // stitch-length stats over consecutive fill stitches in same row
  const lens=[];
  for(let i=1;i<st.length;i++){
    if(st[i].type==="fill" && st[i-1].type==="fill"){
      lens.push(Math.hypot(st[i].x-st[i-1].x, st[i].y-st[i-1].y)/10);
    }
  }
  lens.sort((a,b)=>a-b);
  const med = lens.length?lens[Math.floor(lens.length/2)]:0;
  const max = lens.length?lens[lens.length-1]:0;
  return {
    maxStitchMm: maxStitchPx/10,
    fillStitches: fills.length,
    density: fills.length/areaMm2,
    medianLenMm: med,
    maxLenMm: max,
  };
}

console.log(`solid 40x40mm fill density matrix (real scanlineRuns). pro target=3.92 st/mm^2, pro median=2.10mm\n`);
const baseline = measure(38, 3);   // current shipped: 3.8mm step, 0.3mm rows
console.log(`  BASELINE  step 3.8mm rows 0.30mm -> ${baseline.density.toFixed(2)} st/mm^2  (== whole-design 1.45)`);
console.log(`  --- ratio everything to baseline, project onto whole-design 1.45 ---`);
for (const stepMm of [2.7, 2.4]) {
  for (const rowMm of [0.30, 0.25, 0.22, 0.20]) {
    const r = measure(Math.round(stepMm*10), rowMm*10);
    const ratio = r.density/baseline.density;
    const proj = 1.45*ratio;
    const tag = (proj>=3.5)?"  <= reaches pro range":(proj>=2.8?"  <= close":"");
    console.log(`  step ${stepMm.toFixed(1)}mm rows ${rowMm.toFixed(2)}mm -> ${r.density.toFixed(2)} st/mm^2 | ratio ${ratio.toFixed(2)}x | proj whole ${proj.toFixed(2)} | median ${r.medianLenMm.toFixed(2)}mm${tag}`);
  }
}
console.log(`\n  note: above is FILL only. Real path to 3.9 = these + a LAYERED underlay pass (adds a registration layer on top).`);
