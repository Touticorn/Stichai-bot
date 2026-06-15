// unit-test the zigzag underlay generator (no sharp needed).
const { zigzagUnderlay } = require("../lib/vectorize");
const SIDE=400, pxPerMm=10;            // 40mm square
const sq=[[0,0],[SIDE,0],[SIDE,SIDE],[0,SIDE]];
const c0=[SIDE/2,SIDE/2];
const phi=0;                            // top fill horizontal -> underlay perpendicular
const spacingPx=Math.round(2.5*pxPerMm); // 2.5mm
const st=zigzagUnderlay([sq], 0, c0, phi, spacingPx, Math.round(4*pxPerMm), 5, 80);

const pts=st.filter(s=>s.type==="running"||s.type==="fill");
const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
const bbox=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
// distinct row coordinate (perpendicular axis). phi=0 -> a=90deg -> rows vary in x.
const rowCoords=[...new Set(pts.map(p=>Math.round(p.x)))].sort((a,b)=>a-b);
const gaps=[]; for(let i=1;i<rowCoords.length;i++){const g=rowCoords[i]-rowCoords[i-1]; if(g>5)gaps.push(g);}
const medGap=gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)]||0;

console.log("underlay stitches:", pts.length);
console.log("bbox px:", bbox.map(v=>v.toFixed(0)).join(","), " (shape 0..400; inset ~5px expected)");
const insideShape = bbox[0]>=-1 && bbox[1]>=-1 && bbox[2]<=SIDE+1 && bbox[3]<=SIDE+1;
const alongInset  = (bbox[1]>=3) || (bbox[0]>=3);   // stitch runs pulled in from at least one pair of edges
console.log("stays inside shape:", insideShape, "| along-run inset present:", alongInset);
console.log("median row spacing:", (medGap/10).toFixed(2),"mm  (target 2.5mm, rule 2-3mm)");
console.log("underlay density on 40x40mm:", (pts.length/((SIDE/10)**2)).toFixed(2),"st/mm^2 (SPARSE foundation, by design)");
const PASS = pts.length>0 && Math.abs(medGap/10-2.5)<0.6 && insideShape && alongInset;
console.log("PASS:", PASS);
