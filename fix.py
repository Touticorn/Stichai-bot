import re

with open('index.html', 'r') as f: html = f.read()
with open('bot.js', 'r') as f: bot = f.read()

# index.html fixes
html = re.sub(r'<canvas[^>]*>.*?</canvas>\s*', '', html, flags=re.DOTALL)
html = re.sub(r'\s*#stitchCanvas\s*\{[^}]*\}', '', html)

match = re.search(r'(<div class="preview-grid">\s*)(<div class="preview-box">\s*<h3[^>]*>.*?</h3>\s*<img[^>]*id="stitchPreview"[^>]*>.*?</div>\s*)(<div class="preview-box">.*?</div>\s*)(</div>)', html, re.DOTALL)
if match:
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
    html = html[:match.start()] + new_grid + html[match.end():]

html = html.replace("const canvas = document.getElementById('stitchCanvas');", "const img = document.getElementById('stitchPreview');")
html = html.replace("canvas.style.transform = `scale(${currentZoom})`;", "img.style.transform = `scale(${currentZoom})`;")
html = html.replace("canvas.style.transformOrigin = 'center';", "img.style.transformOrigin = 'center';")

html = re.sub(
    r'// Show image preview if available, otherwise show canvas\s*if \(analysis\.preview_image\) \{\s*document\.getElementById\([\'"]stitchPreview[\'"]\)\.src = analysis\.preview_image;\s*document\.getElementById\([\'"]stitchPreview[\'"]\)\.style\.display = [\'"]block[\'"];\s*document\.getElementById\([\'"]stitchCanvas[\'"]\)\.style\.display = [\'"]none[\'"];\s*\} else \{\s*document\.getElementById\([\'"]stitchPreview[\'"]\)\.style\.display = [\'"]none[\'"];\s*document\.getElementById\([\'"]stitchCanvas[\'"]\)\.style\.display = [\'"]block[\'"];\s*\}',
    """// Show Gemini-generated preview, or fallback to original image\n        if (analysis.preview_image) {\n            document.getElementById('stitchPreview').src = analysis.preview_image;\n        } else {\n            document.getElementById('stitchPreview').src = document.getElementById('previewOriginal').src || '';\n        }\n        document.getElementById('stitchPreview').style.display = 'block';""",
    html
)

html = re.sub(r"(previewSection\.classList\.add\(['\"]active['\"]\);)", r"document.getElementById('previewOriginal').style.display = 'block';\n        \1", html)

with open('index.html', 'w') as f: f.write(html)

# bot.js fixes
bot = re.sub(r'lite\s*:\s*"gemini-2\.5[^"]*"', 'lite:  "gemini-3.1-flash-preview"', bot)
bot = re.sub(r'flash\s*:\s*"gemini-2\.5[^"]*"', 'flash: "gemini-3.1-flash-preview"', bot)
bot = re.sub(r'pro\s*:\s*"gemini-2\.5[^"]*"', 'pro:   "gemini-3.1-pro-preview"', bot)

bot = re.sub(r'return \{ complexity:"medium", colors:\["#000000"\], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", _model:CONFIG\.GEMINI\.flash \};', 'return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", _model:CONFIG.GEMINI.flash };', bot)

with open('bot.js', 'w') as f: f.write(bot)

print("Fixes applied.")
