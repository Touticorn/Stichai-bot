// gen_test_dst.js — build a KNOWN synthetic fill and run it through Stichai's
// real encodeDST, so the python harness can validate decoder + encoder geometry.
// Units: coords in px where 1px = 0.1mm (pxPerMm=10), == DST native 0.1mm.
const fs = require("fs");
const { encodeDST } = require("../lib/export");

// 20mm x 20mm square, horizontal serpentine rows.
const SIZE = 200;       // 200px = 20.0mm
const ROW  = 4;         // 0.4mm row spacing
const STEP = 30;        // 3.0mm stitch length along row
const color = 0;

const stitches = [];
let serp = false;
for (let y = 0; y <= SIZE; y += ROW) {
  const xs = [];
  for (let x = 0; x <= SIZE; x += STEP) xs.push(x);
  if (serp) xs.reverse();
  for (const x of xs) stitches.push({ x, y, color, type: "fill" });
  serp = !serp;
}

const expectedStitches = stitches.length;
const bboxAreaMm2 = (SIZE/10) * (SIZE/10);  // 20*20 = 400 mm^2
console.log(`[gen] synthetic stitches  = ${expectedStitches}`);
console.log(`[gen] bbox                 = 20.0 x 20.0 mm  (400 mm^2)`);
console.log(`[gen] expected density     = ${(expectedStitches/bboxAreaMm2).toFixed(3)} st/mm^2 (bbox)`);

const buf = encodeDST(stitches, { maxJump: 121, minStitch: 3 });
fs.writeFileSync(__dirname + "/_test_stichai.dst", buf);
console.log(`[gen] wrote tools/_test_stichai.dst (${buf.length} bytes)`);
