#!/usr/bin/env python3
"""
Stichai Complete Fix v4 — works from any directory
Usage: python3 fix_stichai_v4.py [path/to/stichai/folder]

If no path given, defaults to current directory.
Common Termux paths: ~/stichai, ~/downloads/stichai, ~/storage/downloads/stichai
"""
import sys
import os
import re
import shutil

def fix_project(project_dir):
    project_dir = os.path.expanduser(project_dir)
    if not os.path.isdir(project_dir):
        print(f"ERROR: Directory not found: {project_dir}")
        sys.exit(1)

    index_path = os.path.join(project_dir, 'index.html')
    bot_path = os.path.join(project_dir, 'bot.js')

    if not os.path.isfile(index_path):
        print(f"ERROR: index.html not found in {project_dir}")
        sys.exit(1)
    if not os.path.isfile(bot_path):
        print(f"ERROR: bot.js not found in {project_dir}")
        sys.exit(1)

    print(f"=== Fixing Stichai project in: {project_dir} ===")

    # --- index.html ---
    print("\n[1/2] Fixing index.html...")
    shutil.copy(index_path, index_path + '.bak.v4')
    with open(index_path, 'r') as f:
        html = f.read()
    orig_len = len(html)

    # Remove #stitchCanvas CSS rule
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

    # Replace preview grid: Original Design + Stitch Simulation (no canvas)
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

    # Remove resizeImageForUpload and simplify handleFile
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
                document.getElementById('previewOriginal').src = e.target.result;
            };
            reader.readAsDataURL(file);
        }'''
    )
    print("  Removed resizeImageForUpload, simplified handleFile")

    # Fix zoomPreview to target img
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
    print("  Fixed zoomPreview to zoom <img>")

    # Fix regeneratePreview
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
    print("  Fixed regeneratePreview to reset images")

    # Remove canvas fallback in submitOrder
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
    print("  Removed canvas fallback, uses original image as fallback")

    # Show previewOriginal when results open
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
    print("  Set previewOriginal visible on results")

    with open(index_path, 'w') as f:
        f.write(html)
    print(f"  Saved index.html ({orig_len} -> {len(html)} bytes)")

    # --- bot.js ---
    print("\n[2/2] Fixing bot.js...")
    shutil.copy(bot_path, bot_path + '.bak.v4')
    with open(bot_path, 'r') as f:
        bot = f.read()
    orig_len = len(bot)

    # Remove duplicate comment block
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

    # Fix analyzeImage fallback fields
    bot = bot.replace(
        '''    return { complexity:"medium", colors:["#000000"], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", _model:CONFIG.GEMINI.flash };''',
        '''    return { complexity:"medium", dominant_colors:["#000000"], width_mm:80, height_mm:80, estimated_stitch_count:5000, suggested_stitch_type:"fill", _model:CONFIG.GEMINI.flash };'''
    )
    print("  Fixed analyzeImage fallback field names")

    # Fix processAndDeliver fields + model label
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

    # Fix processWebJob fields
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

    with open(bot_path, 'w') as f:
        f.write(bot)
    print(f"  Saved bot.js ({orig_len} -> {len(bot)} bytes)")

    # --- Verification ---
    print("\n=== Verification ===")
    with open(index_path, 'r') as f:
        h = f.read()
    with open(bot_path, 'r') as f:
        b = f.read()

    checks = [
        ("index.html: no visible <canvas>", '<canvas' not in h),
        ("index.html: no #stitchCanvas CSS", '#stitchCanvas' not in h),
        ("index.html: no stitchCanvas JS refs", 'stitchCanvas' not in h),
        ("index.html: previewOriginal exists", 'id="previewOriginal"' in h),
        ("index.html: zoomPreview targets img", "const img = document.getElementById('stitchPreview')" in h),
        ("index.html: no canvas fallback", "getElementById('stitchCanvas')" not in h),
        ("index.html: /api/analyze-image present", '/api/analyze-image' in h),
        ("bot.js: no gemini-2.5", 'gemini-2.5' not in b),
        ("bot.js: gemini-3.1 present", 'gemini-3.1' in b),
        ("bot.js: single GEMINI comment", b.count('GEMINI IMAGE ANALYSIS') == 1),
        ("bot.js: uses estimated_stitch_count", 'estimated_stitch_count' in b),
        ("bot.js: uses dominant_colors", 'dominant_colors' in b),
        ("bot.js: no old .stitch_count", 'analysis.stitch_count' not in b),
        ("bot.js: no old .colors", 'analysis.colors' not in b),
    ]

    all_ok = True
    for name, ok in checks:
        status = "OK" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"  [{status}] {name}")

    print(f"\n{'ALL CHECKS PASSED' if all_ok else 'SOME CHECKS FAILED'}")
    if all_ok:
        print(f"\nBackups saved as:")
        print(f"  {index_path}.bak.v4")
        print(f"  {bot_path}.bak.v4")
        print(f"\nNext steps:")
        print(f"  cd {project_dir}")
        print(f"  git add -A")
        print(f"  git commit -m 'fix: remove all canvas + Gemini 3.1 + field fixes'")
        print(f"  git push origin main")

if __name__ == '__main__':
    # Accept path from command line, default to current directory
    project_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    fix_project(project_dir)
