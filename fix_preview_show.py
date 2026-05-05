with open('index.html', 'r') as f:
    html = f.read()

# Fix: Add previewOriginal visibility BEFORE previewSection.classList.add('active')
old_code = '''        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''

new_code = '''        document.getElementById('previewOriginal').style.display = 'block';
        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''

if old_code in html:
    html = html.replace(old_code, new_code)
    print("[1/2] Fixed: previewOriginal now shows when results load")
else:
    print("[1/2] WARNING: Could not find the exact code block to replace")

# Fix: Also ensure stitchPreview shows properly with fallback
old_fallback = '''        // Show Gemini-generated preview, or fallback to original image
        if (analysis.preview_image) {
            document.getElementById('stitchPreview').src = analysis.preview_image;
        } else {
            document.getElementById('stitchPreview').src = document.getElementById('previewOriginal').src || '';
        }
        document.getElementById('stitchPreview').style.display = 'block';'''

new_fallback = '''        // Show Gemini-generated preview, or fallback to original image
        const previewOriginal = document.getElementById('previewOriginal');
        const stitchPreview = document.getElementById('stitchPreview');
        
        if (analysis.preview_image) {
            stitchPreview.src = analysis.preview_image;
        } else if (previewOriginal.src && previewOriginal.src !== '') {
            stitchPreview.src = previewOriginal.src;
        } else {
            // No image available at all
            stitchPreview.style.display = 'none';
            stitchPreview.parentElement.querySelector('h3').textContent = 'Analysis Complete (No Preview)';
        }
        stitchPreview.style.display = 'block';'''

if old_fallback in html:
    html = html.replace(old_fallback, new_fallback)
    print("[2/2] Fixed: stitchPreview fallback improved")
else:
    print("[2/2] WARNING: Could not find fallback code")

with open('index.html', 'w') as f:
    f.write(html)

print("\nDone. Commit with:")
print("  git add index.html && git commit -m 'fix: show preview images' && git push origin main")
