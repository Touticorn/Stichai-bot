with open('index.html', 'r') as f:
    html = f.read()

# Fix 1: In handleFile, also set previewOriginal.src
old_handle = '''        function handleFile(event) {
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

new_handle = '''        function handleFile(event) {
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

if old_handle in html:
    html = html.replace(old_handle, new_handle)
    print("[1/2] Fixed: handleFile now sets previewOriginal.src")
else:
    print("[1/2] WARNING: handleFile pattern didn't match")

# Fix 2: Show previewOriginal in submitOrder
old_submit = '''        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''

new_submit = '''        document.getElementById('previewOriginal').style.display = 'block';
        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''

if old_submit in html:
    html = html.replace(old_submit, new_submit)
    print("[2/2] Fixed: submitOrder now shows previewOriginal")
else:
    print("[2/2] WARNING: submitOrder pattern didn't match")

with open('index.html', 'w') as f:
    f.write(html)

print("\nDone.")
