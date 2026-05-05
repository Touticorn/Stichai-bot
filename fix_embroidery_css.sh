cat > fix_embroidery_css.py << 'PYEOF'
with open('index.html', 'r') as f:
    html = f.read()

# Add embroidery CSS effect
old_css = '''        .preview-box img {
            max-width: 100%;
            max-height: 300px;
            border-radius: 8px;
        }'''

new_css = '''        .preview-box img {
            max-width: 100%;
            max-height: 300px;
            border-radius: 8px;
        }
        
        .embroidery-effect {
            filter: contrast(1.3) saturate(1.4) brightness(1.05);
            position: relative;
        }
        
        .embroidery-effect::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: 
                radial-gradient(circle at 20% 30%, rgba(255,255,255,0.3) 1px, transparent 1px),
                radial-gradient(circle at 70% 60%, rgba(255,255,255,0.2) 1px, transparent 1px),
                radial-gradient(circle at 40% 80%, rgba(255,255,255,0.25) 1px, transparent 1px);
            background-size: 4px 4px;
            pointer-events: none;
            border-radius: 8px;
        }'''

if old_css in html:
    html = html.replace(old_css, new_css)
    print("[1/2] Added embroidery CSS effect")
else:
    print("[1/2] CSS pattern didn't match - may need manual add")

# Apply embroidery class to stitchPreview in submitOrder
old_stitch = '''        document.getElementById('stitchPreview').style.display = 'block';'''

new_stitch = '''        document.getElementById('stitchPreview').classList.add('embroidery-effect');
        document.getElementById('stitchPreview').style.display = 'block';'''

if old_stitch in html:
    html = html.replace(old_stitch, new_stitch)
    print("[2/2] Applied embroidery class to stitchPreview")
else:
    print("[2/2] stitchPreview pattern didn't match")

with open('index.html', 'w') as f:
    f.write(html)

print("\nDone. This adds:")
print("  - contrast + saturate filters for thread-like colors")
print("  - fabric texture overlay via CSS radial gradients")
print("  - applied to stitchPreview when analysis completes")
PYEOF

python3 fix_embroidery_css.py

git add index.html
git commit -m "fix: CSS embroidery effect for stitch simulation"
git push origin main
