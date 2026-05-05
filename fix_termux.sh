cat > fix.py << 'PYEOF'
import re

# ========== index.html ==========
with open('index.html', 'r') as f:
    html = f.read()

# 1. Remove ALL <canvas> elements (flexible whitespace)
html = re.sub(r'<canvas[^>]*id="stitchCanvas"[^>]*>.*?</canvas>\s*', '', html, flags=re.DOTALL)
print("[1/6] Removed all <canvas> elements")

# 2. Remove CSS rule for #stitchCanvas
html = re.sub(r'\s*#stitchCanvas\s*\{[^}]*\}', '', html)
print("[2/6] Removed #stitchCanvas CSS")

# 3. Fix preview grid - replace first preview-box content
# The first box has img+canvas, we need img only + add previewOriginal box
old_first_box = re.search(
    r'(<div class="preview-grid">\s*)'
    r'(<div class="preview-box">\s*)'
    r'(<h3[^>]*>.*?</h3>\s*)'
    r'(<img[^>]*id="stitchPreview"[^>]*>\s*)'
    r'(<canvas[^>]*>.*?</canvas>\s*)'
    r'(</div>\s*)'
    r'(<div class="preview-box">.*?</div>\s*)'
    r'(</div>)',
    html, re.DOTALL
)

if old_first_box:
    new_grid = '''            <div class="preview-grid">
                <div class="preview-box">
                    <h3 data-i18n="original">Original Design</h3>
                    <img id="previewOriginal" style="max-width:100%; max-height:300px; border-radius:8px; display:none;">
                </div>
                <div class="preview-box">
                    <h3 data-i18n="simulation">Stitch Simulation</h3>
                    <img id="stitchPreview" style="max-width:100%; max-height:300px; border-radius:8px; display:none; transition: transform 0.3s;">
                    <div class="zoom-controls">
                        <button class="zoom-btn" onclick="zoomPreview(0.8)">🔍-</button>
                        <button class="zoom-btn" onclick="zoomPreview(1.0)">⟲ Reset</button>
                        <button class="zoom-btn" onclick="zoomPreview(1.2)">🔍+</button>
                    </div>
                </div>
            </div>'''
    html = html[:old_first_box.start()] + new_grid + html[old_first_box.end():]
    print("[3/6] Replaced preview grid")
else:
    print("[3/6] WARNING: Could not match preview grid pattern")

# 4. Fix zoomPreview - flexible whitespace around getElementById
html = re.sub(
    r'const canvas = document\.getElementById\([\'"]stitchCanvas[\'"]\);',
    "const img = document.getElementById('stitchPreview');",
    html
)
html = re.sub(
    r'canvas\.style\.transform = `scale\(\$\{currentZoom\}\)`;',
    "img.style.transform = `scale(${currentZoom})`;",
    html
)
html = re.sub(
    r'canvas\.style\.transformOrigin = [\'"]center[\'"];',
    "img.style.transformOrigin = 'center';",
    html
)
print("[4/6] Fixed zoomPreview to use img")

# 5. Fix submitOrder canvas fallback
html = re.sub(
    r'// Show image preview if available, otherwise show canvas\s*'
    r'if \(analysis\.preview_image\) \{\s*'
    r"document\.getElementById\([\'"]stitchPreview[\'"]\)\.src = analysis\.preview_image;\s*"
    r"document\.getElementById\([\'"]stitchPreview[\'"]\)\.style\.display = [\'"]block[\'"];\s*"
    r"document\.getElementById\([\'"]stitchCanvas[\'"]\)\.style\.display = [\'"]none[\'"];\s*"
    r'\} else \{\s*'
    r"document\.getElementById\([\'"]stitchPreview[\'"]\)\.style\.display = [\'"]none[\'"];\s*"
    r"document\.getElementById\([\'"]stitchCanvas[\'"]\)\.style\.display = [\'"]block[\'"];\s*"
    r'\}',
    """// Show Gemini-generated preview, or fallback to original image
        if (analysis.preview_image) {
            document.getElementById('stitchPreview').src = analysis.preview_image;
        } else {
            document.getElementById('stitchPreview').src = document.getElementById('previewOriginal').src || '';
        }
        document.getElementById('stitchPreview').style.display = 'block';""",
    html
)
print("[5/6] Fixed submitOrder fallback")

# 6. Show previewOriginal when results open
html = re.sub(
    r'(previewSection\.classList\.add\([\'"]active[\'"]\);)',
    "document.getElementById('previewOriginal').style.display = 'block';\n        \1",
    html
)
print("[6/6] Set previewOriginal visible on results")

with open('index.html', 'w') as f:
    f.write(html)

# ========== bot.js ==========
with open('bot.js', 'r') as f:
    bot = f.read()

# 1. Fix CONFIG.GEMINI - flexible whitespace around colons
bot = re.sub(r'lite\s*:\s*"gemini-2\.5[^"]*"', 'lite:  "gemini-3.1-flash-preview"', bot)
bot = re.sub(r'flash\s*:\s*"gemini-2\.5[^"]*"', 'flash: "gemini-3.1-flash-preview"', bot)
bot = re.sub(r'pro\s*:\s*"gemini-2\.5[^"]*"', 'pro:   "gemini-3.1-pro-preview"', bot)
print("[bot 1/3] Fixed CONFIG.GEMINI models")

# 2. Remove duplicate comment
bot = re.sub(
    r'(// =+\n// GEMINI IMAGE ANALYSIS.*?\n// =+\n)\s*\1',
    r'\1',
    bot
)
print("[bot 2/3] Removed duplicate comment")

# 3. Fix analyzeImage fallback fields
bot = re.sub(
    r'return \{ complexity:"medium", colors:\["#000000"\], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", _model:CONFIG\.GEMINI\.flash \};',
    'return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", _model:CONFIG.GEMINI.flash };',
    bot
)
print("[bot 3/3] Fixed fallback field names")

with open('bot.js', 'w') as f:
    f.write(bot)

# ========== Verify ==========
with open('index.html', 'r') as f:
    h = f.read()
with open('bot.js', 'r') as f:
    b = f.read()

print("\n=== Verification ===")
canvas_count = len(re.findall(r'<canvas', h))
stitchCanvas_count = h.count('stitchCanvas')
gemini25 = 'gemini-2.5' in b
gemini31 = 'gemini-3.1' in b

print(f"  <canvas> count in HTML: {canvas_count} (want 0)")
print(f"  'stitchCanvas' refs in HTML: {stitchCanvas_count} (want 0)")
print(f"  'previewOriginal' in HTML: {'YES' if 'id=\"previewOriginal\"' in h else 'NO'} (want YES)")
print(f"  gemini-2.5 in bot.js: {'YES' if gemini25 else 'NO'} (want NO)")
print(f"  gemini-3.1 in bot.js: {'YES' if gemini31 else 'NO'} (want YES)")

if canvas_count == 0 and stitchCanvas_count == 0 and not gemini25 and gemini31:
    print("\nALL CHECKS PASSED")
    print("Run: git add -A && git commit -m 'fix: remove canvas + Gemini 3.1' && git push origin main")
else:
    print("\nSome issues remain - review above")
PYEOF

python3 fix.py
