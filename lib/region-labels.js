"use strict";

/**
 * Tier-5d: region labels.
 *
 * Each Stichai palette entry maps to a human label. Embroidermodder
 * doesn't do this; users get to name colors as they see them, but
 * Stichai can suggest a likely role from the chroma distribution:
 *
 *   - skin      hue   0–50  or 330–360  AND L 30–90
 *   - hair      very dark (L<35) OR very saturated dark
 *   - cloth-blue hue 200–250 AND L 30–80
 *   - cloth-red  hue 0–25  AND L 30–80
 *   - white       L > 88 AND low saturation
 *   - black       L < 22
 *   - accent-fuchsia high L high saturation, hue 280–320
 *   - midtone    otherwise, indexed sequentially
 *
 * Returns array of { index, hex, label, role }
 */

function _hexToRgb(h) {
  const m = (h || "").match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
  };
}
function _rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)); break;
      case gn: h = ((bn - rn) / d + 2); break;
      case bn: h = ((rn - gn) / d + 4); break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

let roleCounter = 0;
function labelForRole(role, hex, index) {
  const pad = (n) => String(n).padStart(2, "0");
  const normH = "#" + (hex.match(/[0-9a-fA-F]{6}/)[0]).toUpperCase();
  switch (role) {
    case "white":       return { role, label: "Background (light)" };
    case "black":       return { role, label: "Outline / detail" };
    case "hair-dark":   return { role, label: "Hair (dark)" };
    case "hair-light":  return { role, label: "Hair (light)" };
    case "skin-light":  return { role, label: "Skin (light)" };
    case "skin-medium": return { role, label: "Skin (warm)" };
    case "skin-dark":   return { role, label: "Skin (deep)" };
    case "cloth-blue":  return { role, label: "Clothing (blue)" };
    case "cloth-red":   return { role, label: "Clothing (red)" };
    case "cloth-purple":return { role, label: "Clothing (purple)" };
    case "cloth-green": return { role, label: "Clothing (green)" };
    case "cloth-yellow":return { role, label: "Clothing (yellow)" };
    case "cloth-orange":return { role, label: "Clothing (orange)" };
    case "cloth-neutral": return { role, label: "Clothing (neutral)" };
    case "accent":      return { role, label: "Accent" };
    default:            return { role: "midtone", label: `Color ${index + 1}` };
  }
}

function classifyColor(hex) {
  const rgb = _hexToRgb(hex);
  const { h, s, l } = _rgbToHsl(rgb);
  if (l < 22 && s < 30) return "black";
  if (l > 88 && s < 18) return "white";
  if (l < 35 && s < 50) return "hair-dark";
  if (h >= 0 && h <= 50  && l >= 35 && l <= 80 && s >= 15 && s <= 75) {
    if (l > 70) return "skin-light";
    if (l > 50) return "skin-medium";
    return "skin-dark";
  }
  if (h >= 200 && h <= 260 && l >= 30 && l <= 80) return "cloth-blue";
  if ((h >= 0  && h <= 25) && l >= 30 && l <= 80 && s >= 35) return "cloth-red";
  if ((h >= 250 && h <= 320)) return "cloth-purple";
  if ((h >= 80 && h <= 160) && l >= 30 && l <= 80) return "cloth-green";
  if ((h >= 40 && h <= 60)  && l >= 60 && l <= 85) return "cloth-yellow";
  if ((h >= 25 && h <= 45)  && l >= 50 && l <= 80) return "cloth-orange";
  if (l < 65 && s < 25) return "cloth-neutral";
  if (s >= 60 && h >= 280) return "accent";
  return "midtone";
}

function buildRegionLabels(colors) {
  if (!Array.isArray(colors)) return [];
  // Sort roles so dominant appears first
  return colors.map((hex, index) => {
    const role = classifyColor(hex);
    const info = labelForRole(role, hex, index);
    return {
      index,
      hex: "#" + (hex.match(/[0-9a-fA-F]{6}/)[0] || "000000").toUpperCase(),
      role,
      label: info.label,
    };
  });
}

module.exports = {
  buildRegionLabels,
  classifyColor,
  labelForRole,
};
