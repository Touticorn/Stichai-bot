#!/usr/bin/env python3
"""
Stichai Complete Fix v3
- Removes ALL canvas (visible + internal)
- Restores Original Design preview box
- Fixes all bot.js field name mismatches
- Fixes Gemini model labels
"""
import re
import shutil

def fix_index_html():
    print("=== Fixing index.html ===")
    shutil.copy('index.html', 'index.html.bak.v3')
    with open('index.html', 'r') as f:
        html = f.read()
    orig_len = len(html)

    # 1. Remove #stitchCanvas CSS rule
    html = html.replace(
        '''        #stitchCanvas {
            max-width: 100%;
            border-radius: 8px;
            border: 1px solid #e0e0e0;
        }
''',
        ''
    )
    print("  Removed #stitchCanvas CSS rule")

    # 2. Replace preview grid: restore Original Design box, remove canvas
    html = html.replace(
        '''                        <div class="preview-grid">
                <div class="preview-box">
                    <h3 data-i18n="simulation">Stitch Simulation</h3>
                    <img id="stitchPreview" style="max-width:100%; max-height:300px; border-radius:8px; display:none;">
                    <canvas id="stitchCanvas" width="300" height="300" style="display:none; pointer-events: none;"></canvas>
                    <div class="zoom-controls">
                        <button class="zoom-btn" onclick="zoomPreview(0.8)">🔍-</button>
                        <button class="zoom-btn" onclick="zoomPreview(1.0)">⟲ Reset</button>
                        <button class="zoom-btn" onclick="zoomPreview(1.2)">🔍+</button>
                    </div>
                </div>
            </div>''',
        '''            <div class="preview-grid">
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
    )
    print("  Replaced preview grid (Original + Simulation, no canvas)")

    # 3. Replace handleFile: remove resizeImageForUpload call, use file directly
    html = html.replace(
        '''        function handleFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Resize in browser before storing
    resizeImageForUpload(file, 512, (resizedBlob) => {
        uploadedFile = new File([resizedBlob], file.name, { type: 'image/jpeg' });
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = document.getElementById('previewImg');
            img.src = e.target.result;
            img.style.display = 'block';
            document.getElementById('uploadPrompt').style.display = 'none';
            document.getElementById('dropZone').classList.add('has-image');
            document.getElementById('previewOriginal').src = e.target.result;
        };
        reader.readAsDataURL(uploadedFile);
    });
}

function resizeImageForUpload(file, maxWidth, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(maxWidth / img.width, maxWidth / img.height, 1);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(callback, 'image/jpeg', 0.9);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}''',
        '''        function handleFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            uploadedFile = file;
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = document.getElementById('previewImg');
                img.src = e.target.result;
                img.style.display = 'block';
                document.getElementById('uploadPrompt').style.display = 'none';
                document.getElementById('dropZone').classList.add('has-image');
            };
            reader.readAsDataURL(file);
        }'''
    )
    print("  Removed resizeImageForUpload (no internal canvas), simplified handleFile")

    # 4. Replace zoomPreview to work on img
    html = html.replace(
        '''        function zoomPreview(factor) {
            currentZoom *= factor;
            const canvas = document.getElementById('stitchCanvas');
            canvas.style.transform = `scale(${currentZoom})`;
            canvas.style.transformOrigin = 'center';
        }''',
        '''        function zoomPreview(factor) {
            currentZoom *= factor;
            const img = document.getElementById('stitchPreview');
            img.style.transform = `scale(${currentZoom})`;
            img.style.transformOrigin = 'center';
        }'''
    )
    print("  Fixed zoomPreview to zoom <img> instead of canvas")

    # 5. Replace regeneratePreview to reset image
    html = html.replace(
        '''        function regeneratePreview() {
            document.getElementById('previewSection').classList.remove('active');
            document.getElementById('submitBtn').disabled = false;
            document.getElementById('submitBtn').textContent = TRANSLATIONS[currentLang].submitBtn;
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }''',
        '''        function regeneratePreview() {
            document.getElementById('previewSection').classList.remove('active');
            document.getElementById('stitchPreview').style.display = 'none';
            document.getElementById('stitchPreview').src = '';
            document.getElementById('previewOriginal').style.display = 'none';
            currentZoom = 1.0;
            document.getElementById('stitchPreview').style.transform = 'scale(1)';
            document.getElementById('submitBtn').disabled = false;
            document.getElementById('submitBtn').textContent = TRANSLATIONS[currentLang].submitBtn;
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }'''
    )
    print("  Fixed regeneratePreview to reset image state")

    # 6. Replace canvas fallback in submitOrder
    html = html.replace(
        '''        // Show image preview if available, otherwise show canvas
        if (analysis.preview_image) {
            document.getElementById('stitchPreview').src = analysis.preview_image;
            document.getElementById('stitchPreview').style.display = 'block';
            document.getElementById('stitchCanvas').style.display = 'none';
        } else {
            document.getElementById('stitchPreview').style.display = 'none';
            document.getElementById('stitchCanvas').style.display = 'block';
        }''',
        '''        // Show Gemini-generated preview, or fallback to original image
        if (analysis.preview_image) {
            document.getElementById('stitchPreview').src = analysis.preview_image;
        } else {
            document.getElementById('stitchPreview').src = document.getElementById('previewOriginal').src || '';
        }
        document.getElementById('stitchPreview').style.display = 'block';'''
    )
    print("  Removed canvas fallback in submitOrder")

    # 7. Also set previewOriginal visible when preview opens
    html = html.replace(
        '''        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);''',
        '''        document.getElementById('previewOriginal').style.display = 'block';
        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''
    )
    print("  Set previewOriginal visible when results show")

    with open('index.html', 'w') as f:
        f.write(html)
    print(f"  Saved index.html ({orig_len} -> {len(html)} bytes)")

def fix_bot_js():
    print("\n=== Fixing bot.js ===")
    shutil.copy('bot.js', 'bot.js.bak.v3')
    with open('bot.js', 'r') as f:
        bot = f.read()
    orig_len = len(bot)

    # 1. Remove duplicate comment block
    bot = bot.replace(
        '''// ============================================================
// GEMINI IMAGE ANALYSIS (Secure - uses Railway env var)
// ============================================================
// ============================================================
// GEMINI IMAGE ANALYSIS (Secure - uses Railway env var)
// ============================================================''',
        '''// ============================================================
// GEMINI IMAGE ANALYSIS (Secure - uses Railway env var)
// ============================================================'''
    )
    print("  Removed duplicate comment block")

    # 2. Fix analyzeImage fallback fields
    bot = bot.replace(
        '''    return { complexity:"medium", colors:["#000000"], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", _model:CONFIG.GEMINI.flash };''',
        '''    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", _model:CONFIG.GEMINI.flash };'''
    )
    print("  Fixed analyzeImage fallback field names")

    # 3. Fix processAndDeliver field names + model label
    bot = bot.replace(
        '''    const modelLabel = analysis._model?.includes("lite") ? "Flash-Lite" : analysis._model?.includes("pro") ? "Pro" : "Flash";
    const summary = {
      ar:`Stitches: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} color | Gemini ${modelLabel}`,
      fr:`Points: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} couleur | Gemini ${modelLabel}`,
      en:`Stitches: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} color | Gemini ${modelLabel}`,
    };''',
        '''    const modelLabel = analysis._model?.includes("pro") ? "Pro" : "Flash";
    const summary = {
      ar:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
      fr:`Points: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} couleur | Gemini ${modelLabel}`,
      en:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
    };'''
    )
    print("  Fixed processAndDeliver field names + model label")

    # 4. Fix processWebJob field names
    bot = bot.replace(
        '''    job.result = {
      stitch_count: files?.stitch_count || analysis.stitch_count || 5000,
      estimated_stitch_count: files?.stitch_count || analysis.stitch_count || 5000,
      colors: analysis.colors?.length || 1,
      dominant_colors: analysis.colors || ['#c41e3a', '#ffd700', '#ffffff'],
      suggested_stitch_type: analysis.stitch_type || settings.stitchType || 'fill',
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      description: analysis.description || '',
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.stitch_count || 5000) / 300) + "m"
    };''',
        '''    job.result = {
      stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      estimated_stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ['#c41e3a', '#ffd700', '#ffffff'],
      suggested_stitch_type: analysis.suggested_stitch_type || settings.stitchType || 'fill',
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      description: analysis.description || '',
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + "m"
    };'''
    )
    print("  Fixed processWebJob field names")

    with open('bot.js', 'w') as f:
        f.write(bot)
    print(f"  Saved bot.js ({orig_len} -> {len(bot)} bytes)")

def verify():
    print("\n=== Verification ===")
    with open('index.html', 'r') as f:
        h = f.read()
    with open('bot.js', 'r') as f:
        b = f.read()

    checks = [
        ("index.html: no visible <canvas>", '<canvas' not in h),
        ("index.html: no #stitchCanvas CSS", '#stitchCanvas' not in h),
        ("index.html: stitchCanvas JS refs removed", 'stitchCanvas' not in h),
        ("index.html: previewOriginal element exists", 'id="previewOriginal"' in h),
        ("index.html: zoomPreview targets img", "const img = document.getElementById('stitchPreview')" in h),
        ("index.html: no canvas fallback in submitOrder", "getElementById('stitchCanvas')" not in h),
        ("index.html: /api/analyze-image present", '/api/analyze-image' in h),
        ("bot.js: no gemini-2.5", 'gemini-2.5' not in b),
        ("bot.js: gemini-3.1 present", 'gemini-3.1' in b),
        ("bot.js: no duplicate GEMINI comment", b.count('GEMINI IMAGE ANALYSIS') == 1),
        ("bot.js: uses estimated_stitch_count", 'estimated_stitch_count' in b),
        ("bot.js: uses dominant_colors", 'dominant_colors' in b),
        ("bot.js: no old .stitch_count fallback", 'analysis.stitch_count' not in b),
        ("bot.js: no old .colors fallback", 'analysis.colors' not in b),
    ]

    all_ok = True
    for name, ok in checks:
        status = "OK" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"  [{status}] {name}")

    print(f"\n{'ALL CHECKS PASSED' if all_ok else 'SOME CHECKS FAILED'}")
    if all_ok:
        print("\nNext steps:")
        print("  git add -A")
        print("  git commit -m 'fix: remove all canvas + Gemini 3.1 + field name fixes'")
        print("  git push origin main")

if __name__ == '__main__':
    fix_index_html()
    fix_bot_js()
    verify()
