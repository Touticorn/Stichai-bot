#!/usr/bin/env python3
"""
Definitive line-based fix for index.html
"""

with open('index.html', 'r') as f:
    lines = f.readlines()

print(f"Read {len(lines)} lines")

# ========================================================================
# FIX 1: Show previewOriginal when results come in
# Find the line with "document.getElementById('stitchPreview').style.display = 'block';"
# and add previewOriginal display right before it
# ========================================================================
for i, line in enumerate(lines):
    if "document.getElementById('stitchPreview').style.display = 'block';" in line:
        # Insert previewOriginal show before this line
        indent = '        '
        lines.insert(i, indent + "document.getElementById('previewOriginal').style.display = 'block';\n")
        print(f"[1/3] Added previewOriginal show at line {i+1}")
        break

# ========================================================================
# FIX 2: Replace multiple download buttons with single format-aware button
# Find lines 707-710 (0-indexed 706-709) which have the 3 download links
# ========================================================================
# First find where download buttons start
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if 'id="downloadDst"' in line:
        start_idx = i
    if start_idx and 'downloadVp3' in line or (start_idx and i > start_idx and '</div>' in line and 'download' not in line.lower()):
        # Find the closing div after download buttons
        pass

# Simpler: just search for the pattern and replace block
new_download_block = '''                <a href="#" class="download-btn" id="downloadFileBtn" onclick="downloadSelectedFormat()" style="display:none;">
                    Download <span id="selectedFormatName">DST</span> File
                </a>
'''

# Find and replace from downloadDst to end of that section
for i, line in enumerate(lines):
    if 'id="downloadDst"' in line:
        start_idx = i
        # Find the end of the download button section
        for j in range(i+1, len(lines)):
            if '</a>' in lines[j] and 'download' not in lines[j+1].lower() if j+1 < len(lines) else True:
                end_idx = j + 1
                break
            if '</div>' in lines[j] and j > i + 3:
                end_idx = j
                break
        if start_idx and end_idx:
            # Replace the whole block
            lines = lines[:start_idx] + [new_download_block] + lines[end_idx:]
            print(f"[2/3] Replaced download buttons at lines {start_idx+1}-{end_idx+1}")
            break

# ========================================================================
# FIX 3: Add downloadSelectedFormat function and update format label
# Find the first <script> tag or add before </script> at end
# ========================================================================
# Add function before closing </script> or </body>
func_code = '''
        function downloadSelectedFormat() {
            const settings = getSettings();
            const format = settings.fileType || 'dst';
            downloadFile(format);
        }

        function updateDownloadButton() {
            const settings = getSettings();
            const format = settings.fileType || 'dst';
            const formatNames = { dst: 'DST', pes: 'PES', jef: 'JEF', exp: 'EXP', vp3: 'VP3' };
            document.getElementById('selectedFormatName').textContent = formatNames[format] || 'DST';
            document.getElementById('downloadFileBtn').style.display = 'inline-block';
        }
'''

# Find </script> or </body> and insert before
for i in range(len(lines)-1, -1, -1):
    if '</script>' in lines[i] or '</body>' in lines[i]:
        lines.insert(i, func_code)
        print(f"[3/3] Added download functions at line {i+1}")
        break

# ========================================================================
# FIX 4: Call updateDownloadButton when preview opens
# Find "previewSection.classList.add('active');" and add before it
# ========================================================================
for i, line in enumerate(lines):
    if "previewSection.classList.add('active');" in line:
        indent = '        '
        lines.insert(i, indent + "updateDownloadButton();\n")
        print(f"[4/4] Added download button update at line {i+1}")
        break

with open('index.html', 'w') as f:
    f.writelines(lines)

print("\nDone. Commit with:")
print("  git add index.html")
print("  git commit -m 'fix: show preview + single download button'")
print("  git push origin main --force")
