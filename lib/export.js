"use strict";

/**
 * Embroidery file export: DST, JEF, PES, ZIP, PDF colour chart
 * Thread databases (JEF_THREADS, PEC_THREADS) are defined here.
 */

function dstEncodeXY(dx, dy, isJump) {
  let x = dx;
  let y = -dy;
  let b0 = 0, b1 = 0, b2 = 0x03;

  if (x >  40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x08; x += 81; }
  if (y >  40) { b2 |= 0x20; y -= 81; }
  if (y < -40) { b2 |= 0x10; y += 81; }

  if (x >  13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x08; x += 27; }
  if (y >  13) { b1 |= 0x20; y -= 27; }
  if (y < -13) { b1 |= 0x10; y += 27; }

  if (x >   4) { b0 |= 0x04; x -=  9; }
  if (x <  -4) { b0 |= 0x08; x +=  9; }
  if (y >   4) { b0 |= 0x20; y -=  9; }
  if (y <  -4) { b0 |= 0x10; y +=  9; }

  if (x >   1) { b1 |= 0x01; x -=  3; }
  if (x <  -1) { b1 |= 0x02; x +=  3; }
  if (y >   1) { b1 |= 0x80; y -=  3; }
  if (y <  -1) { b1 |= 0x40; y +=  3; }

  if (x >   0) { b0 |= 0x01; }
  if (x <   0) { b0 |= 0x02; }
  if (y >   0) { b0 |= 0x80; }
  if (y <   0) { b0 |= 0x40; }

  if (isJump) b2 |= 0x80;
  return Buffer.from([b0, b1, b2]);
}

function fmtExtent(n) {
  const abs = Math.max(0, Math.round(Math.abs(n)));
  let digits = String(abs);
  if (digits.length < 2) digits = "0" + digits;
  return digits.padStart(5, " ");
}

function dstHeader(stitchCount, colorCount, minX, maxX, minY, maxY, name) {
  const buf = Buffer.alloc(512, 0x20);
  let off = 0;
  const write = (txt) => {
    buf.write(txt, off, "ascii");
    off += txt.length;
    buf[off++] = 0x0D;
  };
  const safeName = (name || "Stichai").substring(0, 16).padEnd(16, " ");
  write("LA:" + safeName);
  write("ST:" + String(stitchCount).padStart(7, " "));
  write("CO:" + String(colorCount).padStart(3, " "));
  write("+X:" + fmtExtent(Math.max(0,  maxX)));
  write("-X:" + fmtExtent(Math.max(0, -minX)));
  write("+Y:" + fmtExtent(Math.max(0, -minY)));
  write("-Y:" + fmtExtent(Math.max(0,  maxY)));
  write("AX:+" + String(0).padStart(5, " "));
  write("AY:+" + String(0).padStart(5, " "));
  write("MX:+" + String(0).padStart(5, " "));
  write("MY:+" + String(0).padStart(5, " "));
  write("PD:******");
  buf[off++] = 0x1A;
  return buf;
}

function encodeDST(stitches, machineLimits) {
  const limits = machineLimits || MACHINE_LIMITS.generic;
  
  /* Filter out stitches below machine minimum */
  const filtered = [];
  let last = null;
  for (const s of stitches) {
    if (s.type === "trim" || s.type === "color-change") {
      filtered.push(s);
      last = s;
      continue;
    }
    if (!last || last.type === "trim") {
      filtered.push(s);
      last = s;
      continue;
    }
    const dist = Math.hypot(s.x - last.x, s.y - last.y);
    if (dist < limits.minStitch && s.color === last.color && s.type === last.type) {
      continue;
    }
    filtered.push(s);
    last = s;
  }

  const recs = [];
  let lastColor = null;
  let px = 0, py = 0;
  let stitchCount = 0;
  let colorChanges = 0;
  let mnx =  Infinity, mxx = -Infinity, mny =  Infinity, mxy = -Infinity;

  const emitLong = (dx, dy, isJump) => {
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(dx) / limits.maxJump),
      Math.ceil(Math.abs(dy) / limits.maxJump)
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

  let needJump = false;

  for (const s of filtered) {
    if (s.color !== lastColor && lastColor !== null) {
      recs.push(Buffer.from([0x00, 0x00, 0xC3]));
      colorChanges++;
      stitchCount++;
      needJump = true; // after color change, next move must be a jump
    }
    lastColor = s.color;

    const dx = Math.round(s.x - px);
    const dy = Math.round(s.y - py);
    px = s.x;
    py = s.y;

    let isJump = s.type === "trim" || s.type === "jump";
    if (needJump && !isJump) {
      isJump = true;
      needJump = false;
    }
    if (s.type === "trim" || s.type === "color-change") {
      needJump = true; // after trim/color-change, next move must be a jump
    }

    if (Math.abs(dx) > limits.maxJump || Math.abs(dy) > limits.maxJump) {
      emitLong(dx, dy, isJump);
    } else {
      recs.push(dstEncodeXY(dx, dy, isJump));
      stitchCount++;
    }

    if (s.x < mnx) mnx = s.x;
    if (s.x > mxx) mxx = s.x;
    if (s.y < mny) mny = s.y;
    if (s.y > mxy) mxy = s.y;
  }

  recs.push(Buffer.from([0x00, 0x00, 0xF3]));

  if (mnx === Infinity) { mnx = mxx = mny = mxy = 0; }

  const header = dstHeader(stitchCount, colorChanges + 1, mnx, mxx, mny, mxy, "Stichai");
  return Buffer.concat([header, ...recs]);
}


/* ═══════════════════════════════════════════════════════════════════
   JEF ENCODER (Janome) — based on pyembroidery / libembroidery
   ═══════════════════════════════════════════════════════════════════ */
/* ── Real Tajima thread RGB values (index-matched to Tajima color table) ──────
   These match what Tajima-compatible viewers (Viewer Pro, SewWhat, etc.) display
   when they read palette indices from DST/JEF/PES files.
   Source: Tajima official thread chart + pyembroidery reference data.         */
const JEF_THREADS = [
  {r:0,   g:0,   b:0   }, // 0  Black
  {r:255, g:255, b:255 }, // 1  White
  {r:255, g:255, b:23  }, // 2  Yellow
  {r:250, g:160, b:96  }, // 3  Orange
  {r:235, g:0,   b:0   }, // 4  Red
  {r:160, g:0,   b:96  }, // 5  Burgundy
  {r:220, g:95,  b:155 }, // 6  Pink
  {r:240, g:185, b:210 }, // 7  Light Pink
  {r:255, g:215, b:0   }, // 8  Gold
  {r:205, g:130, b:0   }, // 9  Dark Gold
  {r:168, g:105, b:40  }, // 10 Brown
  {r:100, g:60,  b:5   }, // 11 Dark Brown
  {r:200, g:225, b:120 }, // 12 Olive Green
  {r:80,  g:145, b:60  }, // 13 Green
  {r:0,   g:100, b:20  }, // 14 Dark Green
  {r:225, g:240, b:245 }, // 15 Sky Blue
  {r:100, g:190, b:225 }, // 16 Light Blue
  {r:0,   g:130, b:200 }, // 17 Blue
  {r:0,   g:65,  b:160 }, // 18 Dark Blue
  {r:100, g:80,  b:160 }, // 19 Purple
  {r:135, g:115, b:175 }, // 20 Light Purple
  {r:200, g:190, b:230 }, // 21 Lavender
  {r:210, g:210, b:210 }, // 22 Silver
  {r:160, g:160, b:160 }, // 23 Grey
  {r:80,  g:80,  b:80  }, // 24 Dark Grey
  {r:195, g:175, b:145 }, // 25 Beige
  {r:240, g:225, b:190 }, // 26 Light Beige
  {r:210, g:180, b:135 }, // 27 Tan
  {r:145, g:105, b:70  }, // 28 Caramel
  {r:95,  g:60,  b:25  }, // 29 Dark Caramel
  {r:230, g:95,  b:40  }, // 30 Orange Red
  {r:255, g:185, b:90  }, // 31 Light Orange
];

/* Perceptual color distance (weighted RGB approximating CIE Lab lightness).
   Much more accurate than Manhattan — prevents gold matching to green etc.   */
function colorDistPerceptual(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  // Redmean approximation (Colour FAQ weighted Euclidean)
  const rm = (a.r + b.r) / 2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

function findNearestThread(rgb, set) {
  let best = 0, bestD = 1e9;
  for (let i = 0; i < set.length; i++) {
    const d = colorDistPerceptual(rgb, set[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function writeInt8(buf, v) { buf.push(v & 0xFF); }
function writeInt16LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF); }
function writeInt16BE(buf, v) { buf.push((v >> 8) & 0xFF, v & 0xFF); }
function writeInt24LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF); }
function writeInt32LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); }
function writeString(buf, s) { for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)); }

function getBounds(stitches) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'trim' || s.type === 'end') continue;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  if (minX === Infinity) { minX = maxX = minY = maxY = 0; }
  return {minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY};
}

/* Normalize stitches: split long moves, convert trims→jumps, emit color_changes.
   Also inserts tie-in lock stitches at the START of each color segment and
   tie-off lock stitches at the END — without these the thread unravels from
   both ends of every segment (the "7 Missing Tie-Ins / 7 Missing Tie-Offs"). */
function normalizeStitches(stitches, maxJump) {
  const out = [];
  let px = 0, py = 0, prevColor = null;
  let needsTieIn = true;   /* first color also needs tie-in after initial jump */
  const LOCK = 12;         /* 12 px ≈ 1.2 mm — short enough not to show,
                              long enough for the machine to catch the thread */

  for (const s of stitches) {
    if (s.type === 'trim') continue;

    if (prevColor !== null && s.color !== prevColor) {
      /* ── TIE-OFF: 3 lock stitches before ending this colour ── */
      const lastOut = out[out.length - 1];
      if (lastOut && lastOut.type === 'stitch') {
        out.push({dx:-LOCK, dy:0, type:'stitch'});
        out.push({dx: LOCK, dy:0, type:'stitch'});
        out.push({dx:-LOCK, dy:0, type:'stitch'});
      }
      out.push({dx:0, dy:0, type:'color_change'});
      needsTieIn = true;
    }
    prevColor = s.color;

    const dx = s.x - px, dy = s.y - py;
    const dist = Math.hypot(dx, dy);
    if (dist > maxJump) {
      const steps = Math.ceil(dist / maxJump);
      for (let i = 1; i < steps; i++) {
        const ix = Math.round(px + dx * i / steps);
        const iy = Math.round(py + dy * i / steps);
        out.push({dx: ix - px, dy: iy - py, type: 'jump'});
        px = ix; py = iy;
      }
      out.push({dx: s.x - px, dy: s.y - py, type: s.type === 'jump' ? 'jump' : 'stitch'});
    } else {
      out.push({dx, dy, type: s.type === 'jump' ? 'jump' : 'stitch'});
    }
    px = s.x; py = s.y;

    /* ── TIE-IN: 3 lock stitches right after first needle-down of each colour ── */
    if (needsTieIn && s.type !== 'jump') {
      out.push({dx: LOCK, dy:0, type:'stitch'});
      out.push({dx:-LOCK, dy:0, type:'stitch'});
      out.push({dx: LOCK, dy:0, type:'stitch'});
      needsTieIn = false;
    }
  }

  /* ── FINAL TIE-OFF at end of design ── */
  const lastOut = out[out.length - 1];
  if (lastOut && lastOut.type === 'stitch') {
    out.push({dx:-LOCK, dy:0, type:'stitch'});
    out.push({dx: LOCK, dy:0, type:'stitch'});
    out.push({dx:-LOCK, dy:0, type:'stitch'});
  }

  out.push({dx:0, dy:0, type:'end'});
  return out;
}

function getJefHoopSize(width, height) {
  if (width < 500 && height < 500) return 1; // 50x50
  if (width < 1260 && height < 1100) return 3; // 126x110
  if (width < 1400 && height < 2000) return 2; // 140x200
  if (width < 2000 && height < 2000) return 4; // 200x200
  return 0; // 110x110 default
}

function writeHoopEdge(buf, x, y) {
  if (x >= 0 && y >= 0) {
    writeInt32LE(buf, x); writeInt32LE(buf, y);
    writeInt32LE(buf, x); writeInt32LE(buf, y);
  } else {
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
  }
}

function encodeJEF(stitches, colors) {
  const norm = normalizeStitches(stitches, 127);
  const bounds = getBounds(stitches);
  const colorCount = colors.length;

  let pointCount = 1; // END
  for (const s of norm) {
    if (s.type === 'stitch') pointCount += 1;
    else if (s.type === 'jump') pointCount += 2;
    else if (s.type === 'color_change') pointCount += 2;
  }

  const palette = colors.map(c => findNearestThread(hexToRgb(c), JEF_THREADS));
  const headerSize = 0x74 + colorCount * 8;

  const buf = [];
  writeInt32LE(buf, headerSize); // stitch offset
  writeInt32LE(buf, 0x14);

  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth()+1).padStart(2,'0') +
    String(now.getDate()).padStart(2,'0') +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0') +
    String(now.getSeconds()).padStart(2,'0');
  writeString(buf, dateStr);
  writeInt8(buf, 0); writeInt8(buf, 0);

  writeInt32LE(buf, colorCount);
  writeInt32LE(buf, pointCount);
  writeInt32LE(buf, getJefHoopSize(bounds.width, bounds.height));

  const halfW = Math.round(bounds.width / 2);
  const halfH = Math.round(bounds.height / 2);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);

  writeHoopEdge(buf, 550 - halfW, 550 - halfH);
  writeHoopEdge(buf, 250 - halfW, 250 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);

  for (const p of palette) writeInt32LE(buf, p);
  for (let i = 0; i < colorCount; i++) writeInt32LE(buf, 0x0D);

  let xx = 0, yy = 0;
  for (const s of norm) {
    if (s.type === 'stitch') {
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'color_change') {
      buf.push(0x80, 0x01);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'jump') {
      buf.push(0x80, 0x02);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'end') {
      buf.push(0x80, 0x10);
      break;
    }
  }
  return Buffer.from(buf);
}

/* ═══════════════════════════════════════════════════════════════════
   PES / PEC ENCODER (Brother) — based on pyembroidery / libembroidery
   ═══════════════════════════════════════════════════════════════════ */
const PEC_THREADS = [
  {r:0,   g:0,   b:0   }, // 0  Black
  {r:255, g:255, b:255 }, // 1  White
  {r:255, g:255, b:23  }, // 2  Yellow
  {r:255, g:165, b:0   }, // 3  Orange
  {r:255, g:102, b:102 }, // 4  Pink
  {r:255, g:0,   b:0   }, // 5  Red
  {r:155, g:0,   b:30  }, // 6  Burgundy
  {r:240, g:185, b:215 }, // 7  Light Pink
  {r:255, g:215, b:0   }, // 8  Gold
  {r:200, g:130, b:0   }, // 9  Dark Gold
  {r:140, g:90,  b:25  }, // 10 Brown
  {r:90,  g:50,  b:5   }, // 11 Dark Brown
  {r:195, g:215, b:110 }, // 12 Olive
  {r:75,  g:140, b:55  }, // 13 Green
  {r:0,   g:95,  b:20  }, // 14 Dark Green
  {r:0,   g:170, b:55  }, // 15 Emerald
  {r:180, g:235, b:240 }, // 16 Sky Blue
  {r:95,  g:185, b:220 }, // 17 Light Blue
  {r:0,   g:120, b:190 }, // 18 Blue
  {r:0,   g:60,  b:150 }, // 19 Dark Blue
  {r:95,  g:75,  b:155 }, // 20 Purple
  {r:195, g:185, b:225 }, // 21 Lavender
  {r:205, g:205, b:205 }, // 22 Silver
  {r:150, g:150, b:150 }, // 23 Grey
  {r:65,  g:65,  b:65  }, // 24 Dark Grey
  {r:190, g:170, b:140 }, // 25 Beige
  {r:240, g:220, b:185 }, // 26 Light Beige
  {r:200, g:175, b:130 }, // 27 Tan
  {r:140, g:100, b:65  }, // 28 Caramel
  {r:90,  g:55,  b:20  }, // 29 Dark Caramel
  {r:225, g:90,  b:35  }, // 30 Orange Red
  {r:255, g:180, b:85  }, // 31 Light Orange
  {r:235, g:235, b:60  }, // 32 Lemon
  {r:130, g:195, b:235 }, // 33 Powder Blue
  {r:145, g:110, b:215 }, // 34 Lilac
  {r:255, g:20,  b:145 }, // 35 Hot Pink
  {r:50,  g:200, b:50  }, // 36 Lime Green
  {r:250, g:95,  b:70  }, // 37 Coral
  {r:255, g:140, b:0   }, // 38 Amber
  {r:170, g:250, b:45  }, // 39 Yellow Green
  {r:240, g:125, b:125 }, // 40 Salmon
  {r:255, g:155, b:120 }, // 41 Peach
  {r:125, g:255, b:210 }, // 42 Aqua
  {r:110, g:125, b:140 }, // 43 Slate
  {r:255, g:225, b:220 }, // 44 Blush
  {r:253, g:245, b:230 }, // 45 Old Lace
  {r:240, g:248, b:255 }, // 46 Alice Blue
  {r:245, g:245, b:245 }, // 47 Off White
  {r:45,  g:75,  b:75  }, // 48 Dark Teal
  {r:100, g:100, b:100 }, // 49 Medium Grey
  {r:176, g:196, b:222 }, // 50 Steel Blue
  {r:220, g:20,  b:60  }, // 51 Crimson
  {r:0,   g:185, b:255 }, // 52 Cyan
  {r:150, g:200, b:50  }, // 53 Yellow Green 2
  {r:255, g:125, b:80  }, // 54 Tomato
  {r:100, g:88,  b:200 }, // 55 Slate Blue
  {r:102, g:200, b:170 }, // 56 Medium Aquamarine
  {r:233, g:148, b:122 }, // 57 Dark Salmon
  {r:255, g:220, b:170 }, // 58 Moccasin
  {r:30,  g:144, b:255 }, // 59 Dodger Blue
  {r:119, g:136, b:153 }, // 60 Light Slate Grey
  {r:255, g:250, b:250 }, // 61 Snow
];

function writePecValue(buf, value, long, flag) {
  if (!long && value > -64 && value < 63) {
    writeInt8(buf, value & 0x7F);
  } else {
    let v = value & 0x0FFF;
    v |= 0x8000;
    v |= (flag || 0) << 8;
    writeInt8(buf, (v >> 8) & 0xFF);
    writeInt8(buf, v & 0xFF);
  }
}

function encodePEC(stitches, colors) {
  const norm = normalizeStitches(stitches, 2047);
  const bounds = getBounds(stitches);
  const width = bounds.width, height = bounds.height;
  const colorCount = colors.length;
  const palette = colors.map(c => findNearestThread(hexToRgb(c), PEC_THREADS));
  const rgbList = colors.map(c => { const r = hexToRgb(c); return (r.r << 16) | (r.g << 8) | r.b; });

  const buf = [];
  // 512-byte header
  const name = "Stichai";
  writeString(buf, "LA:" + name.padEnd(16, ' '));
  buf.push(0x0D);
  for (let i = 0; i < 12; i++) buf.push(0x20);
  buf.push(0xFF, 0x00);
  buf.push(6); // icon width bytes (48/8)
  buf.push(38); // icon height
  const pad1 = [0x20,0x20,0x20,0x20,0x64,0x20,0x00,0x20,0x00,0x20,0x20,0x20];
  for (const b of pad1) buf.push(b);

  if (colorCount > 0) {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(colorCount - 1);
    for (const p of palette) buf.push(p);
  } else {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xFF);
  }
  while (buf.length < 512) buf.push(0x20);

  // Second section
  buf.push(0x00, 0x00);
  const graphicsOffsetPos = buf.length;
  writeInt24LE(buf, 0); // placeholder
  buf.push(0x31, 0xFF, 0xF0);
  writeInt16LE(buf, Math.round(width));
  writeInt16LE(buf, Math.round(height));
  writeInt16LE(buf, 0x01E0);
  writeInt16LE(buf, 0x01B0);
  writeInt16BE(buf, 0x9000 - bounds.minX);
  writeInt16BE(buf, 0x9000 - bounds.minY);

  const stitchBlockStart = buf.length;
  let xx = 0, yy = 0, colorTwo = true, jumping = true, init = true;
  for (const s of norm) {
    if (s.type === 'stitch') {
      if (jumping) {
        if (s.dx !== 0 || s.dy !== 0) {
          writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        }
        jumping = false;
      }
      writePecValue(buf, s.dx, false);
      writePecValue(buf, s.dy, false);
    } else if (s.type === 'jump') {
      jumping = true;
      if (init) {
        writePecValue(buf, s.dx, true, 0x10);
        writePecValue(buf, s.dy, true, 0x10);
      } else {
        writePecValue(buf, s.dx, true, 0x20);
        writePecValue(buf, s.dy, true, 0x20);
      }
    } else if (s.type === 'color_change') {
      if (jumping) {
        writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        jumping = false;
      }
      buf.push(0xFE, 0xB0);
      buf.push(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (s.type === 'end') {
      buf.push(0xFF);
      break;
    }
    init = false;
  }

  const stitchBlockLength = buf.length - stitchBlockStart;
  buf[graphicsOffsetPos] = stitchBlockLength & 0xFF;
  buf[graphicsOffsetPos + 1] = (stitchBlockLength >> 8) & 0xFF;
  buf[graphicsOffsetPos + 2] = (stitchBlockLength >> 16) & 0xFF;

  // Graphics thumbnails (blank)
  const thumbSize = 6 * 38; // 228 bytes per thumbnail
  for (let i = 0; i < thumbSize; i++) buf.push(0); // main thumbnail
  for (let c = 0; c < colorCount; c++) {
    for (let i = 0; i < thumbSize; i++) buf.push(0);
  }

  return Buffer.from(buf);
}

function encodePES(stitches, colors) {
  const pec = encodePEC(stitches, colors);
  const pecOffset = 8 + 4 + 10; // signature + offset field + padding
  const buf = [];
  writeString(buf, "#PES0001");
  writeInt32LE(buf, pecOffset);
  while (buf.length < pecOffset) buf.push(0);
  for (let i = 0; i < pec.length; i++) buf.push(pec[i]);
  return Buffer.from(buf);
}

/* ─── ZIP BUILDER (STORE) ──────────────────────────────── */
function buildZipStore(files) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
  function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
  const localHeaders = [];
  const centralDir   = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc     = crc32(data);
    const size    = data.length;
    const now     = new Date();
    const dosTime = ((now.getSeconds() >> 1) | (now.getMinutes() << 5) | (now.getHours() << 11));
    const dosDate = (now.getDate() | ((now.getMonth()+1) << 5) | ((now.getFullYear()-1980) << 9));
    const lh = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(size), u32(size),
      u16(nameBuf.length), u16(0),
      nameBuf
    ]);
    localHeaders.push(lh, data);
    centralDir.push(Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20), u16(0), u16(0),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(size), u32(size),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset),
      nameBuf
    ]));
    offset += lh.length + data.length;
  }
  const cdBuf = Buffer.concat(centralDir);
  const eocd  = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cdBuf.length), u32(offset),
    u16(0)
  ]);
  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/* ─── PDF COLOR CHART GENERATOR ─────────────────────────── */
async function generateColorChartPdf(colors, machineBrand) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch(e) {
    console.warn('pdfkit not installed, skipping PDF generation');
    return Buffer.from([]);
  }
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {});
  doc.fontSize(18).text('Stichai Color Chart', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Machine format: ${machineBrand.toUpperCase()}`, { align: 'center' });
  doc.moveDown();
  colors.forEach((hex, idx) => {
    const { r, g, b } = hexToRgb(hex);
    doc.fillColor(`#${hex.slice(1)}`).rect(50, doc.y, 50, 20).fill();
    doc.fillColor('black').text(` ${idx+1}. ${hex} (R:${r}, G:${g}, B:${b})`, 110, doc.y-15);
    doc.moveDown(0.5);
  });
  doc.end();
  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}


/* Perceptual color distance (weighted RGB approximating CIE Lab lightness).
   Much more accurate than Manhattan — prevents gold matching to green etc.   */
function colorDistPerceptual(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  // Redmean approximation (Colour FAQ weighted Euclidean)
  const rm = (a.r + b.r) / 2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

function findNearestThread(rgb, set) {
  let best = 0, bestD = 1e9;
  for (let i = 0; i < set.length; i++) {
    const d = colorDistPerceptual(rgb, set[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function writeInt8(buf, v) { buf.push(v & 0xFF); }
function writeInt16LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF); }
function writeInt16BE(buf, v) { buf.push((v >> 8) & 0xFF, v & 0xFF); }
function writeInt24LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF); }
function writeInt32LE(buf, v) { buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); }
function writeString(buf, s) { for (let i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)); }

function getBounds(stitches) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'trim' || s.type === 'end') continue;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  if (minX === Infinity) { minX = maxX = minY = maxY = 0; }
  return {minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY};
}

/* Normalize stitches: split long moves, convert trims→jumps, emit color_changes.
   Also inserts tie-in lock stitches at the START of each color segment and
   tie-off lock stitches at the END — without these the thread unravels from
   both ends of every segment (the "7 Missing Tie-Ins / 7 Missing Tie-Offs"). */
function normalizeStitches(stitches, maxJump) {
  const out = [];
  let px = 0, py = 0, prevColor = null;
  let needsTieIn = true;   /* first color also needs tie-in after initial jump */
  const LOCK = 12;         /* 12 px ≈ 1.2 mm — short enough not to show,
                              long enough for the machine to catch the thread */

  for (const s of stitches) {
    if (s.type === 'trim') continue;

    if (prevColor !== null && s.color !== prevColor) {
      /* ── TIE-OFF: 3 lock stitches before ending this colour ── */
      const lastOut = out[out.length - 1];
      if (lastOut && lastOut.type === 'stitch') {
        out.push({dx:-LOCK, dy:0, type:'stitch'});
        out.push({dx: LOCK, dy:0, type:'stitch'});
        out.push({dx:-LOCK, dy:0, type:'stitch'});
      }
      out.push({dx:0, dy:0, type:'color_change'});
      needsTieIn = true;
    }
    prevColor = s.color;

    const dx = s.x - px, dy = s.y - py;
    const dist = Math.hypot(dx, dy);
    if (dist > maxJump) {
      const steps = Math.ceil(dist / maxJump);
      for (let i = 1; i < steps; i++) {
        const ix = Math.round(px + dx * i / steps);
        const iy = Math.round(py + dy * i / steps);
        out.push({dx: ix - px, dy: iy - py, type: 'jump'});
        px = ix; py = iy;
      }
      out.push({dx: s.x - px, dy: s.y - py, type: s.type === 'jump' ? 'jump' : 'stitch'});
    } else {
      out.push({dx, dy, type: s.type === 'jump' ? 'jump' : 'stitch'});
    }
    px = s.x; py = s.y;

    /* ── TIE-IN: 3 lock stitches right after first needle-down of each colour ── */
    if (needsTieIn && s.type !== 'jump') {
      out.push({dx: LOCK, dy:0, type:'stitch'});
      out.push({dx:-LOCK, dy:0, type:'stitch'});
      out.push({dx: LOCK, dy:0, type:'stitch'});
      needsTieIn = false;
    }
  }

  /* ── FINAL TIE-OFF at end of design ── */
  const lastOut = out[out.length - 1];
  if (lastOut && lastOut.type === 'stitch') {
    out.push({dx:-LOCK, dy:0, type:'stitch'});
    out.push({dx: LOCK, dy:0, type:'stitch'});
    out.push({dx:-LOCK, dy:0, type:'stitch'});
  }

  out.push({dx:0, dy:0, type:'end'});
  return out;
}

function getJefHoopSize(width, height) {
  if (width < 500 && height < 500) return 1; // 50x50
  if (width < 1260 && height < 1100) return 3; // 126x110
  if (width < 1400 && height < 2000) return 2; // 140x200
  if (width < 2000 && height < 2000) return 4; // 200x200
  return 0; // 110x110 default
}

function writeHoopEdge(buf, x, y) {
  if (x >= 0 && y >= 0) {
    writeInt32LE(buf, x); writeInt32LE(buf, y);
    writeInt32LE(buf, x); writeInt32LE(buf, y);
  } else {
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
    writeInt32LE(buf, -1); writeInt32LE(buf, -1);
  }
}

function encodeJEF(stitches, colors) {
  const norm = normalizeStitches(stitches, 127);
  const bounds = getBounds(stitches);
  const colorCount = colors.length;

  let pointCount = 1; // END
  for (const s of norm) {
    if (s.type === 'stitch') pointCount += 1;
    else if (s.type === 'jump') pointCount += 2;
    else if (s.type === 'color_change') pointCount += 2;
  }

  const palette = colors.map(c => findNearestThread(hexToRgb(c), JEF_THREADS));
  const headerSize = 0x74 + colorCount * 8;

  const buf = [];
  writeInt32LE(buf, headerSize); // stitch offset
  writeInt32LE(buf, 0x14);

  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth()+1).padStart(2,'0') +
    String(now.getDate()).padStart(2,'0') +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0') +
    String(now.getSeconds()).padStart(2,'0');
  writeString(buf, dateStr);
  writeInt8(buf, 0); writeInt8(buf, 0);

  writeInt32LE(buf, colorCount);
  writeInt32LE(buf, pointCount);
  writeInt32LE(buf, getJefHoopSize(bounds.width, bounds.height));

  const halfW = Math.round(bounds.width / 2);
  const halfH = Math.round(bounds.height / 2);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);
  writeInt32LE(buf, halfW); writeInt32LE(buf, halfH);

  writeHoopEdge(buf, 550 - halfW, 550 - halfH);
  writeHoopEdge(buf, 250 - halfW, 250 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);
  writeHoopEdge(buf, 700 - halfW, 1000 - halfH);

  for (const p of palette) writeInt32LE(buf, p);
  for (let i = 0; i < colorCount; i++) writeInt32LE(buf, 0x0D);

  let xx = 0, yy = 0;
  for (const s of norm) {
    if (s.type === 'stitch') {
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'color_change') {
      buf.push(0x80, 0x01);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'jump') {
      buf.push(0x80, 0x02);
      writeInt8(buf, s.dx); writeInt8(buf, -s.dy);
    } else if (s.type === 'end') {
      buf.push(0x80, 0x10);
      break;
    }
  }
  return Buffer.from(buf);
}

/* ═══════════════════════════════════════════════════════════════════
   PES / PEC ENCODER (Brother) — based on pyembroidery / libembroidery
   ═══════════════════════════════════════════════════════════════════ */


function writePecValue(buf, value, long, flag) {
  if (!long && value > -64 && value < 63) {
    writeInt8(buf, value & 0x7F);
  } else {
    let v = value & 0x0FFF;
    v |= 0x8000;
    v |= (flag || 0) << 8;
    writeInt8(buf, (v >> 8) & 0xFF);
    writeInt8(buf, v & 0xFF);
  }
}

function encodePEC(stitches, colors) {
  const norm = normalizeStitches(stitches, 2047);
  const bounds = getBounds(stitches);
  const width = bounds.width, height = bounds.height;
  const colorCount = colors.length;
  const palette = colors.map(c => findNearestThread(hexToRgb(c), PEC_THREADS));
  const rgbList = colors.map(c => { const r = hexToRgb(c); return (r.r << 16) | (r.g << 8) | r.b; });

  const buf = [];
  // 512-byte header
  const name = "Stichai";
  writeString(buf, "LA:" + name.padEnd(16, ' '));
  buf.push(0x0D);
  for (let i = 0; i < 12; i++) buf.push(0x20);
  buf.push(0xFF, 0x00);
  buf.push(6); // icon width bytes (48/8)
  buf.push(38); // icon height
  const pad1 = [0x20,0x20,0x20,0x20,0x64,0x20,0x00,0x20,0x00,0x20,0x20,0x20];
  for (const b of pad1) buf.push(b);

  if (colorCount > 0) {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(colorCount - 1);
    for (const p of palette) buf.push(p);
  } else {
    for (let i = 0; i < 12; i++) buf.push(0x20);
    buf.push(0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xFF);
  }
  while (buf.length < 512) buf.push(0x20);

  // Second section
  buf.push(0x00, 0x00);
  const graphicsOffsetPos = buf.length;
  writeInt24LE(buf, 0); // placeholder
  buf.push(0x31, 0xFF, 0xF0);
  writeInt16LE(buf, Math.round(width));
  writeInt16LE(buf, Math.round(height));
  writeInt16LE(buf, 0x01E0);
  writeInt16LE(buf, 0x01B0);
  writeInt16BE(buf, 0x9000 - bounds.minX);
  writeInt16BE(buf, 0x9000 - bounds.minY);

  const stitchBlockStart = buf.length;
  let xx = 0, yy = 0, colorTwo = true, jumping = true, init = true;
  for (const s of norm) {
    if (s.type === 'stitch') {
      if (jumping) {
        if (s.dx !== 0 || s.dy !== 0) {
          writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        }
        jumping = false;
      }
      writePecValue(buf, s.dx, false);
      writePecValue(buf, s.dy, false);
    } else if (s.type === 'jump') {
      jumping = true;
      if (init) {
        writePecValue(buf, s.dx, true, 0x10);
        writePecValue(buf, s.dy, true, 0x10);
      } else {
        writePecValue(buf, s.dx, true, 0x20);
        writePecValue(buf, s.dy, true, 0x20);
      }
    } else if (s.type === 'color_change') {
      if (jumping) {
        writePecValue(buf, 0, false); writePecValue(buf, 0, false);
        jumping = false;
      }
      buf.push(0xFE, 0xB0);
      buf.push(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (s.type === 'end') {
      buf.push(0xFF);
      break;
    }
    init = false;
  }

  const stitchBlockLength = buf.length - stitchBlockStart;
  buf[graphicsOffsetPos] = stitchBlockLength & 0xFF;
  buf[graphicsOffsetPos + 1] = (stitchBlockLength >> 8) & 0xFF;
  buf[graphicsOffsetPos + 2] = (stitchBlockLength >> 16) & 0xFF;

  // Graphics thumbnails (blank)
  const thumbSize = 6 * 38; // 228 bytes per thumbnail
  for (let i = 0; i < thumbSize; i++) buf.push(0); // main thumbnail
  for (let c = 0; c < colorCount; c++) {
    for (let i = 0; i < thumbSize; i++) buf.push(0);
  }

  return Buffer.from(buf);
}

function encodePES(stitches, colors) {
  const pec = encodePEC(stitches, colors);
  const pecOffset = 8 + 4 + 10; // signature + offset field + padding
  const buf = [];
  writeString(buf, "#PES0001");
  writeInt32LE(buf, pecOffset);
  while (buf.length < pecOffset) buf.push(0);
  for (let i = 0; i < pec.length; i++) buf.push(pec[i]);
  return Buffer.from(buf);
}

/* ─── ZIP BUILDER (STORE) ──────────────────────────────── */

module.exports = {
  encodeDST,
  encodeJEF,
  encodePES,
  buildZipStore,
  generateColorChartPdf,
  findNearestThread,
  JEF_THREADS,
  PEC_THREADS,
};
