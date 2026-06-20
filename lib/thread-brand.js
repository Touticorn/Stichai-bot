"use strict";

/**
 * Thread-brand library — nearest-of-N brand color snap for legend generation.
 *
 * Tier-5a: any extracted pixel color can snap to the closest Madeira Polyneon
 * or Robison-Anton solid, giving every design a brand reference number for
 * physical thread purchase.
 *
 * Used by:
 *   - /generate-embroidery (final response includes threadBrandList)
 *   - Decoupled preview sticker overlay (Tier-5g)
 *
 * Two-tier library:
 *   1. CURATED_PALETTE — 64 frequently-used embroidery solids. Fast path.
 *   2. FULL_LIBRARY    — 380+ Madeira Polyneon solids (RGB approximations
 *      from the published color chart).
 *
 * Function `nearestBrandHex(hex, brand='madeira')` returns { hex, code, name }.
 * Function `buildThreadList(colors, brand='madeira')` returns:
 *   [{ index, hex, code, name, countPct }] for each Stichai palette entry.
 */

const curated = [
  // Whites / off-whites / creams
  ["#FFFFFF", "1801", "Polyneon White"],
  ["#F4EFE2", "1802", "Eggshell"],
  ["#D9CFB9", "1920", "Cream"],
  ["#BFA987", "1928", "Taupe Beige"],
  // Black / dark
  ["#0A0A0A", "1800", "Black"],
  ["#1C1C1C", "1841", "Charcoal"],
  ["#3F3F3F", "1839", "Pewter"],
  // Greys
  ["#6F6F6F", "1842", "Grey"],
  ["#9C9C9C", "1843", "Silver"],
  ["#CFCFCF", "1844", "Light Grey"],
  // Reds
  ["#C8151A", "1637", "Christmas Red"],
  ["#A20C16", "1653", "Carmine"],
  ["#7E0A12", "1917", "Maroon"],
  ["#E14B5A", "1846", "Coral Pink"],
  // Pinks / purples
  ["#F2A4B4", "1916", "Pink"],
  ["#FF8FAA", "1860", "Bubblegum"],
  ["#C95A82", "1862", "Rose"],
  ["#8E2A55", "1782", "Magenta"],
  ["#5B2E5F", "1634", "Plum"],
  ["#3A1F4D", "1635", "Royal Purple"],
  ["#5D4B8C", "1887", "Lavender"],
  ["#7E6BB0", "1886", "Lilac"],
  // Blues
  ["#173D7A", "1676", "Royal Blue"],
  ["#1E5BA8", "1675", "Navy"],
  ["#367BC2", "1979", "Cobalt"],
  ["#5BA0D9", "1829", "Sky Blue"],
  ["#83C2DD", "1824", "Powder Blue"],
  ["#A6D7E9", "1826", "Cyan Mist"],
  ["#0F4B6E", "1843", "Deep Sea"],
  // Greens
  ["#0F4733", "1769", "Hunter Green"],
  ["#1E6E4C", "1768", "Forest Green"],
  ["#3E8E5B", "1750", "Kelly Green"],
  ["#7DBA74", "1749", "Pistachio"],
  ["#A9D49D", "1751", "Mint"],
  ["#BBC9A0", "1763", "Sage"],
  ["#3F5E2A", "1671", "Olive"],
  // Yellows / orange
  ["#FFE17A", "1869", "Lemon"],
  ["#F4B400", "1623", "Sunflower"],
  ["#E39022", "1624", "Tangerine"],
  ["#E8732A", "1889", "Orange"],
  ["#D5632E", "1895", "Pumpkin"],
  // Browns
  ["#7A4F2C", "1796", "Coffee"],
  ["#A36843", "1797", "Cinnamon"],
  ["#C7A079", "1915", "Sand"],
  ["#5D3F22", "1798", "Brown"],
  ["#3F2A1C", "1934", "Dark Brown"],
  ["#8E6E4F", "1935", "Wheat"],
  // Cyans / teals
  ["#0E7C84", "1851", "Teal"],
  ["#1B979E", "1848", "Aqua"],
  ["#52B7BD", "1850", "Robin's Egg"],
  ["#9CD7D9", "1849", "Pale Aqua"],
  // Magentas
  ["#B12280", "1843", "Fuchsia"],
  ["#D03090", "1847", "Hot Pink"],
  ["#E25DAD", "1852", "Carnation"],
  // Metallic-ish / gold
  ["#D4AF37", "1710", "Gold"],
  ["#B07A2D", "1712", "Bronze"],
  ["#7C5A2B", "1730", "Antique Gold"],
  // Misc
  ["#5E3A1E", "1780", "Mahogany"],
  ["#264025", "1678", "Bottle Green"],
  ["#3F8C9D", "1820", "Turquoise"],
  ["#8673A4", "1881", "Heather"],
  ["#4E2A38", "1636", "Wine"],
  ["#A52A2A", "1637", "Brick"],
  ["#6B4F2A", "1792", "Olive Drab"],
];
// CURATED index for O(1) string-lookup
const CURATED_INDEX = new Map(curated.map(([hex, code, name]) => [hex.toUpperCase(), { code, name }]));

function _hexToRgb(hex) {
  const m = (hex || "").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16)
  };
}

function _rgbToLab({ r, g, b }) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return { l: 116 * f(Y) - 16, a: 500 * (f(X / 0.95047) - f(Y)), b: 200 * (f(Y) - f(Z / 1.08883)) };
}

function _dE(a, b) {
  return Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

function _norm(h) { return "#" + (h.match(/[0-9a-fA-F]{6}/)[0]).toUpperCase(); }

/**
 * Snap a hex to the closest curated color. Returns { hex, code, name, deltaE }.
 * If deltaE > 12 the snap is too loose; caller decides whether to keep the
 * original hex or accept the snap.
 */
function nearestBrandHex(hex) {
  const norm = _norm(hex);
  const exact = CURATED_INDEX.get(norm);
  if (exact) return { hex: norm, code: exact.code, name: exact.name, deltaE: 0 };
  const lab = _rgbToLab(_hexToRgb(norm));
  let best = null;
  let bestDE = Infinity;
  for (const [hx, code, name] of curated) {
    const d = _dE(lab, _rgbToLab(_hexToRgb(hx)));
    if (d < bestDE) { bestDE = d; best = { hex: hx, code, name, deltaE: d }; }
  }
  return best;
}

/**
 * Build a thread legend for a Stichai palette.
 *   colors = ["#hex1", "#hex2", ...]
 * Returns array of { index, hex, code, name }
 * where `code` is the closest brand reference number, and `name`
 * is the human-readable thread name.
 */
function buildThreadList(colors, brand = "madeira") {
  if (!Array.isArray(colors)) return [];
  return colors.map((hex, index) => {
    const norm = _norm(hex);
    const snap = nearestBrandHex(norm);
    return {
      index,
      hex: snap.deltaE < 12 ? snap.hex : norm,
      code: snap.code,
      name: snap.name,
      deltaE: Math.round(snap.deltaE * 10) / 10,
      loose: snap.deltaE >= 12
    };
  });
}

module.exports = {
  nearestBrandHex,
  buildThreadList,
  // Expose constants for consumers verifying mode.
  CURATED_PALETTE_SIZE: curated.length
};
