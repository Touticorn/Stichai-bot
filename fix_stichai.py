#!/usr/bin/env python3
"""
Stichai Fix Script - v2
Fixes index.html and bot.js for Gemini 3.1 + clean preview
Run in your ~/stichai directory
"""
import re
import shutil

def main():
    print("=== Stichai Fix Script ===")
    
    # Backup files
    print("\n[1/4] Creating backups...")
    shutil.copy('index.html', 'index.html.bak')
    shutil.copy('bot.js', 'bot.js.bak')
    print("  index.html -> index.html.bak")
    print("  bot.js -> bot.js.bak")

    # Read index.html
    print("\n[2/4] Fixing index.html...")
    with open('index.html', 'r') as f:
        html = f.read()
    
    original_len = len(html)
    
    # --- Fix A: Replace the broken preview grid ---
    # We need to remove the second preview-box (duplicate canvas)
    # and keep the first one with zoom controls moved into it
    
    # Find the section using a regex that handles varying whitespace
    old_grid_pattern = (
        r'<div class="preview-grid">\s*'
        r'<div class="preview-box">\s*'
        r'<h3[^>]*>.*?</h3>\s*'
        r'<img id="stitchPreview"[^>]*>\s*'
        r'<canvas id="stitchCanvas"[^>]*>.*?</canvas>\s*'
        r'</div>\s*'
        r'<div class="preview-box">\s*'
        r'<h3[^>]*>.*?</h3>\s*'
        r'<canvas id="stitchCanvas"[^>]*>.*?</canvas>\s*'
        r'<div class="zoom-controls">.*?</div>\s*'
        r'</div>\s*'
        r'</div>'
    )
    
    new_grid = '''            <div class="preview-grid">
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
            </div>'''
    
    grid_match = re.search(old_grid_pattern, html, re.DOTALL)
    if grid_match:
        html = html[:grid_match.start()] + new_grid + html[grid_match.end():]
        print("  ✓ Fixed duplicate canvas in preview grid")
    else:
        print("  ⚠ Preview grid pattern not matched - may already be fixed or format changed")
    
    # --- Fix B: Remove generateStitchPreview function ---
    # Match from "function generateStitchPreview(...) {" to its closing brace
    gen_pattern = r'function\s+generateStitchPreview\s*\([^)]*\)\s*\{'
    gen_match = re.search(gen_pattern, html)
    if gen_match:
        start = gen_match.start()
        brace_start = html.find('{', start)
        depth = 0
        end = brace_start
        for i, char in enumerate(html[brace_start:], brace_start):
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        # Eat trailing whitespace/newlines
        while end < len(html) and html[end] in ' \t\n':
            end += 1
        html = html[:start] + html[end:]
        print("  ✓ Removed generateStitchPreview")
    else:
        print("  ⚠ generateStitchPreview not found (may already be removed)")
    
    # --- Fix C: Replace submitOrder and remove dead code after it ---
    submit_match = re.search(r'async\s+function\s+submitOrder\s*\([^)]*\)\s*\{', html)
    if submit_match:
        start = submit_match.start()
        # Find matching closing brace using depth counting
        brace_start = html.find('{', start)
        depth = 0
        func_end = brace_start
        for i, char in enumerate(html[brace_start:], brace_start):
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    func_end = i + 1
                    break
        
        # Find </script> tag - everything between func_end and </script> is dead code
        script_end = html.find('</script>', func_end)
        
        new_submit = '''async function submitOrder() {
    if (!uploadedFile) {
        alert(currentLang === 'fr' ? 'Veuillez télécharger une image!' : 
              currentLang === 'ar' ? 'الرجاء رفع صورة!' : 
              'Please upload an image first!');
        return;
    }

    const btn = document.getElementById('submitBtn');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const previewSection = document.getElementById('previewSection');

    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    progressBar.classList.add('active');
    previewSection.classList.remove('active');
    progressFill.style.width = '0%';

    setTimeout(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }, 100);

    try {
        const formData = new FormData();
        formData.append('image', uploadedFile);

        let progress = 0;
        const progressInterval = setInterval(() => {
            progress += 5;
            if (progress > 90) progress = 90;
            progressFill.style.width = progress + '%';
        }, 1000);

        const response = await fetch('/api/analyze-image', { 
            method: 'POST', 
            body: formData 
        });
        
        clearInterval(progressInterval);
        progressFill.style.width = '100%';
        
        if (!response.ok) {
            throw new Error('Analysis failed: ' + response.status);
        }
        
        const analysis = await response.json();

        if (analysis.error) {
            throw new Error(analysis.error);
        }

        const colors = analysis.dominant_colors || ['#c41e3a', '#ffd700', '#ffffff'];
        
        // Show image preview if available, otherwise show canvas
        if (analysis.preview_image) {
            document.getElementById('stitchPreview').src = analysis.preview_image;
            document.getElementById('stitchPreview').style.display = 'block';
            document.getElementById('stitchCanvas').style.display = 'none';
        } else {
            document.getElementById('stitchPreview').style.display = 'none';
            document.getElementById('stitchCanvas').style.display = 'block';
        }
        
        updateColorPalette(colors);
        
        document.getElementById('previewStitches').textContent = '~' + (analysis.estimated_stitch_count || 5000).toLocaleString();
        document.getElementById('previewColors').textContent = colors.length;
        document.getElementById('previewTime').textContent = Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + 'm';
        
        previewSection.classList.add('active');
        
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
        
    } catch(e) {
        alert('Error: ' + e.message);
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = TRANSLATIONS[currentLang].submitBtn;
        setTimeout(() => {
            progressBar.classList.remove('active');
            progressFill.style.width = '0%';
        }, 2000);
    }
}

'''
        
        html = html[:start] + new_submit + html[script_end:]
        print("  ✓ Replaced submitOrder + removed dead code")
    else:
        print("  ⚠ submitOrder not found")
    
    with open('index.html', 'w') as f:
        f.write(html)
    print(f"  Saved index.html ({original_len} -> {len(html)} bytes)")
    
    # Read bot.js
    print("\n[3/4] Fixing bot.js...")
    with open('bot.js', 'r') as f:
        bot = f.read()
    
    original_bot_len = len(bot)
    
    # Update Gemini model names in CONFIG (flexible whitespace)
    bot = re.sub(
        r'lite\s*:\s*"gemini-2\.5-flash-lite-preview-06-17"',
        'lite:  "gemini-3.1-flash-preview"',
        bot
    )
    bot = re.sub(
        r'flash\s*:\s*"gemini-2\.5-flash"',
        'flash: "gemini-3.1-flash-preview"',
        bot
    )
    bot = re.sub(
        r'pro\s*:\s*"gemini-2\.5-pro"',
        'pro:   "gemini-3.1-pro-preview"',
        bot
    )
    
    with open('bot.js', 'w') as f:
        f.write(bot)
    print(f"  Saved bot.js ({original_bot_len} -> {len(bot)} bytes)")
    
    # Verification
    print("\n[4/4] Verification...")
    with open('index.html', 'r') as f:
        h = f.read()
    with open('bot.js', 'r') as f:
        b = f.read()
    
    canvas_count = h.count('id="stitchCanvas"')
    analysis_count = h.count('const analysis = await response.json()')
    
    checks = [
        ("setLang found", 'setLang(' in h),
        ("pointer-events found", 'pointer-events: none' in h),
        ("/api/analyze-image found", '/api/analyze-image' in h),
        ("Only 1 stitchCanvas", canvas_count == 1),
        ("No duplicate analysis code", analysis_count == 1),
        ("No dead code comment", '// Display Gemini-generated preview' not in h),
        ("No generateStitchPreview", 'function generateStitchPreview' not in h),
        ("Gemini 3.1 in bot.js", 'gemini-3.1' in b),
        ("No gemini-2.5 in bot.js", 'gemini-2.5' not in b),
    ]
    
    all_pass = True
    for name, result in checks:
        status = "✅" if result else "❌"
        if not result:
            all_pass = False
        print(f"  {status} {name}")
    
    print(f"\n{'All checks passed!' if all_pass else 'Some checks failed - review above'}")
    print("\nNext steps:")
    print("  git add -A")
    print("  git commit -m 'fix: clean preview + Gemini 3.1'")
    print("  git push origin main")

if __name__ == '__main__':
    main()
