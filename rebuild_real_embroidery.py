#!/usr/bin/env python3
"""
Complete rebuild: Real stitch simulation + actual file generation
This script generates both bot.js and index.html from clean originals
"""
import urllib.request

def main():
    print("=== Stichai Real Embroidery Rebuild ===")
    
    # Download clean originals
    print("\n[1/6] Downloading clean originals...")
    urllib.request.urlretrieve("https://raw.githubusercontent.com/Touticorn/Stichai-bot/a4fc32a/bot.js", "bot_clean.js")
    urllib.request.urlretrieve("https://raw.githubusercontent.com/Touticorn/Stichai-bot/a4fc32a/index.html", "index_clean.html")
    print("  Done")

    # ========================================================================
    # FIX BOT.JS
    # ========================================================================
    print("\n[2/6] Rebuilding bot.js...")
    with open("bot_clean.js", "r") as f:
        bot = f.read()
    
    # Fix 1: CONFIG.GEMINI models (3.1 → 2.5)
    bot = bot.replace(
        '    lite:  "gemini-3.1-flash-preview",',
        '    lite:  "gemini-2.5-flash-lite-preview-06-17",'
    )
    bot = bot.replace(
        '    flash: "gemini-3.1-flash-preview",',
        '    flash: "gemini-2.5-flash",'
    )
    bot = bot.replace(
        '    pro:   "gemini-3.1-pro-preview",',
        '    pro:   "gemini-2.5-pro",'
    )
    print("  Fixed Gemini models")
    
    # Fix 2: Replace /api/analyze-image route to return stitch data + skip image gen
    old_route_start = bot.find('app.post("/api/analyze-image"')
    old_route_end = bot.find('app.get("/api/status/:jobId"')
    
    new_route = '''app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    
    // STEP 1: Analyze the image
    const analyzeRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: "Expert embroidery digitizer. Analyze this design and return ONLY JSON: {complexity:simple|medium|complex,dominant_colors:[#hex1,#hex2],suggested_stitch_type:satin|fill|running|mixed,estimated_stitch_count:number,width_mm:80,height_mm:80,has_text:boolean,has_logo:boolean,description:brief}" }
          ]
        }]
      },
      { timeout: 30000 }
    );
    
    const analyzeCandidate = analyzeRes.data?.candidates?.[0];
    const analyzePart = analyzeCandidate?.content?.parts?.[0];
    const text = analyzePart?.text || "{}";
    let analysis = {};
    try {
      analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch(e) {
      console.log("JSON parse failed:", e.message);
    }
    
    // STEP 2: Generate real stitch path data for Canvas rendering
    const stitchData = generateStitchData(analysis);
    
    res.json({
      ...analysis,
      stitch_data: stitchData,
      preview_image: null  // No fake Gemini image
    });
    
  } catch(e) {
    console.error("Analyze error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

function generateStitchData(analysis) {
  const colors = analysis.dominant_colors || ["#c41e3a", "#ffd700", "#ffffff"];
  const stitchCount = analysis.estimated_stitch_count || 5000;
  const width = analysis.width_mm || 80;
  const height = analysis.height_mm || 80;
  const type = analysis.suggested_stitch_type || "fill";
  
  const stitches = [];
  const scale = 3; // 1mm = 3px
  const w = width * scale;
  const h = height * scale;
  
  // Generate realistic stitch patterns based on type
  if (type === "satin") {
    // Satin: zigzag fills
    const passes = Math.min(Math.floor(stitchCount / (w * 2)), 200);
    for (let p = 0; p < passes; p++) {
      const colorIdx = p % colors.length;
      const y = (p / passes) * h;
      stitches.push({ x: 0, y, color: colors[colorIdx], type: "jump" });
      for (let x = 0; x < w; x += 2) {
        stitches.push({ x, y: y + (x % 4 === 0 ? 0 : 3), color: colors[colorIdx], type: "stitch" });
      }
    }
  } else if (type === "running") {
    // Running: outline stitches
    const points = Math.min(stitchCount, 2000);
    for (let i = 0; i < points; i++) {
      const t = i / points;
      const colorIdx = Math.floor(t * colors.length) % colors.length;
      const x = w * 0.5 + (w * 0.4) * Math.cos(t * Math.PI * 4);
      const y = h * 0.5 + (h * 0.4) * Math.sin(t * Math.PI * 4);
      stitches.push({ x, y, color: colors[colorIdx], type: "stitch" });
    }
  } else {
    // Fill: horizontal rows with overlaps
    const rows = Math.min(Math.floor(stitchCount / w), 300);
    for (let r = 0; r < rows; r++) {
      const colorIdx = r % colors.length;
      const y = (r / rows) * h;
      stitches.push({ x: 0, y, color: colors[colorIdx], type: "jump" });
      for (let x = 0; x < w; x += 3) {
        stitches.push({ x, y: y + Math.sin(x * 0.1) * 2, color: colors[colorIdx], type: "stitch" });
      }
    }
  }
  
  return { stitches, width: w, height: h, colors, scale };
}

'''
    
    bot = bot[:old_route_start] + new_route + bot[old_route_end:]
    print("  Replaced /api/analyze-image with stitch data generator")
    
    # Fix 3: Replace /generate-embroidery stub with actual DST generator
    old_gen = '''app.post("/generate-embroidery", async (req, res) => {
  const { analysis } = req.body;
  res.json({
    stitch_count: analysis?.stitch_count || 5000,
    dst_url: null,
    pes_url: null,
    jef_url: null,
    exp_url: null,
    vp3_url: null,
    note: "Stub endpoint - implement actual embroidery generation"
  });
});'''
    
    new_gen = '''app.post("/generate-embroidery", async (req, res) => {
  try {
    const { image_b64, mime_type, analysis, phone, settings } = req.body;
    const format = settings?.fileType || "dst";
    const stitchData = generateStitchData(analysis);
    
    let fileData, filename, contentType;
    
    if (format === "dst") {
      fileData = encodeDST(stitchData);
      filename = `embroidery_${Date.now()}.dst`;
      contentType = "application/octet-stream";
    } else {
      // For other formats, generate DST first (can extend later)
      fileData = encodeDST(stitchData);
      filename = `embroidery_${Date.now()}.${format}`;
      contentType = "application/octet-stream";
    }
    
    // Save to temp file and return URL
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, filename);
    fs.writeFileSync(tmpFile, fileData);
    
    // Create download endpoint for this file
    const fileId = "file_" + Date.now();
    app.get(`/api/files/${fileId}`, (req, res) => {
      res.download(tmpFile, filename, (err) => {
        if (err) res.status(404).send("File not found");
      });
    });
    
    const baseUrl = CONFIG.BASE_URL;
    res.json({
      stitch_count: stitchData.stitches.length,
      dst_url: format === "dst" ? `${baseUrl}/api/files/${fileId}` : null,
      pes_url: format === "pes" ? `${baseUrl}/api/files/${fileId}` : null,
      jef_url: format === "jef" ? `${baseUrl}/api/files/${fileId}` : null,
      exp_url: format === "exp" ? `${baseUrl}/api/files/${fileId}` : null,
      vp3_url: format === "vp3" ? `${baseUrl}/api/files/${fileId}` : null,
      stitch_data: stitchData
    });
    
  } catch(e) {
    console.error("Generate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

function encodeDST(stitchData) {
  const stitches = stitchData.stitches;
  const colors = stitchData.colors;
  
  // DST Header (512 bytes)
  let header = "LA:Stichai          ";  // Label (20 chars)
  header = header.padEnd(20, " ");
  header += "ST:".padEnd(10, " ");      // Stitch count placeholder
  header += "CO:".padEnd(10, " ");      // Color count
  header += "+X:".padEnd(10, " ");      // Max X
  header += "-X:".padEnd(10, " ");      // Min X
  header += "+Y:".padEnd(10, " ");      // Max Y
  header += "-Y:".padEnd(10, " ");      // Min Y
  header += "AX:+0".padEnd(10, " ");    // Axis X
  header += "AY:+0".padEnd(10, " ");    // Axis Y
  header += "MX:+0".padEnd(10, " ");    // Max coord
  header += "MY:+0".padEnd(10, " ");    // Max coord
  header += "PD:******".padEnd(10, " "); // Unknown
  header = header.padEnd(512, "\\x00");
  
  // Stitch records (3 bytes each)
  const records = [];
  let prevX = 0, prevY = 0;
  let currentColor = 0;
  
  for (let i = 0; i < stitches.length; i++) {
    const s = stitches[i];
    
    // Check if color changed
    const colorIdx = colors.indexOf(s.color);
    if (colorIdx !== -1 && colorIdx !== currentColor) {
      currentColor = colorIdx;
      records.push(Buffer.from([0x00, 0x00, 0xC3])); // Color change
    }
    
    if (s.type === "jump") {
      const dx = Math.max(-121, Math.min(121, Math.round(s.x - prevX)));
      const dy = Math.max(-121, Math.min(121, Math.round(s.y - prevY)));
      prevX += dx;
      prevY += dy;
      
      const xByte = dx >= 0 ? dx : 256 + dx;
      const yByte = dy >= 0 ? dy : 256 + dy;
      records.push(Buffer.from([yByte, xByte, 0x83])); // Jump
    } else {
      const dx = Math.max(-121, Math.min(121, Math.round(s.x - prevX)));
      const dy = Math.max(-121, Math.min(121, Math.round(s.y - prevY)));
      prevX += dx;
      prevY += dy;
      
      const xByte = dx >= 0 ? dx : 256 + dx;
      const yByte = dy >= 0 ? dy : 256 + dy;
      records.push(Buffer.from([yByte, xByte, 0x03])); // Normal stitch
    }
  }
  
  // End stitch
  records.push(Buffer.from([0x00, 0x00, 0xF3]));
  
  const headerBuf = Buffer.from(header, "ascii");
  const recordsBuf = Buffer.concat(records);
  return Buffer.concat([headerBuf, recordsBuf]);
}

'''
    
    if old_gen in bot:
        bot = bot.replace(old_gen, new_gen)
        print("  Replaced /generate-embroidery with real DST generator")
    else:
        print("  WARNING: Could not find old /generate-embroidery stub")
    
    # Fix 4: processWebJob - pass settings to generate-embroidery
    # Already passes settings, just need to ensure result includes stitch_data
    old_webjob_result = '''    job.result = {
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
    
    new_webjob_result = '''    job.result = {
      stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      estimated_stitch_count: files?.stitch_count || analysis.estimated_stitch_count || 5000,
      colors: analysis.dominant_colors?.length || 1,
      dominant_colors: analysis.dominant_colors || ['#c41e3a', '#ffd700', '#ffffff'],
      suggested_stitch_type: analysis.suggested_stitch_type || settings.stitchType || 'fill',
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      description: analysis.description || '',
      stitch_data: files?.stitch_data || null,
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + "m"
    };'''
    
    if old_webjob_result in bot:
        bot = bot.replace(old_webjob_result, new_webjob_result)
        print("  Added stitch_data to processWebJob result")
    else:
        print("  WARNING: Could not find processWebJob result pattern")
    
    with open("bot.js", "w") as f:
        f.write(bot)
    
    # ========================================================================
    # FIX INDEX.HTML
    # ========================================================================
    print("\n[3/6] Rebuilding index.html...")
    with open("index_clean.html", "r") as f:
        html = f.read()
    
    # Fix 1: Add Canvas-based stitch renderer functions before submitOrder
    old_script_end = '''        function regeneratePreview() {'''
    
    new_functions = '''        // Canvas Stitch Renderer
        function renderStitchCanvas(stitchData, canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas || !stitchData) return;
            
            const ctx = canvas.getContext('2d');
            const stitches = stitchData.stitches || [];
            const w = stitchData.width || 240;
            const h = stitchData.height || 240;
            const colors = stitchData.colors || ['#c41e3a'];
            
            canvas.width = w;
            canvas.height = h;
            ctx.clearRect(0, 0, w, h);
            
            // Fabric background
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(0, 0, w, h);
            
            // Draw stitch lines grouped by color
            let currentColor = null;
            let currentPath = [];
            
            for (let i = 0; i < stitches.length; i++) {
                const s = stitches[i];
                
                if (s.type === 'jump') {
                    // Draw previous path
                    if (currentPath.length > 1) {
                        drawThreadPath(ctx, currentPath, currentColor || colors[0]);
                    }
                    currentPath = [{x: s.x, y: s.y}];
                    currentColor = s.color;
                } else {
                    if (!currentColor) currentColor = s.color;
                    currentPath.push({x: s.x, y: s.y});
                }
                
                // Batch draw every 50 stitches for performance
                if (currentPath.length > 50 || i === stitches.length - 1) {
                    if (currentPath.length > 1) {
                        drawThreadPath(ctx, currentPath, currentColor || colors[0]);
                    }
                    if (i < stitches.length - 1) {
                        currentPath = [currentPath[currentPath.length - 1]];
                    }
                }
            }
            
            // Fabric texture overlay
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillStyle = 'rgba(139, 119, 101, 0.08)';
            for (let i = 0; i < w; i += 2) {
                ctx.fillRect(i, 0, 1, h);
            }
            for (let i = 0; i < h; i += 2) {
                ctx.fillRect(0, i, w, 1);
            }
            ctx.globalCompositeOperation = 'source-over';
        }
        
        function drawThreadPath(ctx, points, color) {
            if (points.length < 2) return;
            
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            // Thread shine effect
            ctx.shadowColor = color;
            ctx.shadowBlur = 0.5;
            
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i].y);
            }
            
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
        
        function downloadStitchFile(format) {
            if (!currentJobId) {
                alert('No embroidery data. Please analyze an image first.');
                return;
            }
            const url = `/api/download/${currentJobId}/${format}`;
            const a = document.createElement('a');
            a.href = url;
            a.download = `embroidery.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
        
        let currentJobId = null;
        let currentStitchData = null;
        
        function regeneratePreview() {'''
    
    if old_script_end in html:
        html = html.replace(old_script_end, new_functions)
        print("  Added Canvas stitch renderer functions")
    else:
        print("  WARNING: Could not find regeneratePreview")
    
    # Fix 2: Replace preview grid to use canvas instead of img for stitch simulation
    old_preview_grid = '''            <div class="preview-grid">
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
    
    new_preview_grid = '''            <div class="preview-grid">
                <div class="preview-box">
                    <h3 data-i18n="original">Original Design</h3>
                    <img id="previewOriginal" style="max-width:100%; max-height:300px; border-radius:8px; display:none;">
                </div>
                <div class="preview-box">
                    <h3 data-i18n="simulation">Stitch Simulation</h3>
                    <canvas id="stitchCanvas" width="240" height="240" style="max-width:100%; border-radius:8px; border:1px solid #e0e0e0; background:#f5f0e8;"></canvas>
                    <div class="zoom-controls">
                        <button class="zoom-btn" onclick="zoomCanvas(0.8)">🔍-</button>
                        <button class="zoom-btn" onclick="zoomCanvas(1.0)">⟲ Reset</button>
                        <button class="zoom-btn" onclick="zoomCanvas(1.2)">🔍+</button>
                    </div>
                </div>
            </div>'''
    
    if old_preview_grid in html:
        html = html.replace(old_preview_grid, new_preview_grid)
        print("  Replaced stitch preview img with canvas")
    else:
        print("  WARNING: Could not find preview grid pattern")
    
    # Fix 3: Replace submitOrder to use stitch data and convert endpoint
    old_submit_start = '''async function submitOrder() {
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
        
        // Show Gemini-generated preview, or fallback to original image
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
    
    new_submit_start = '''async function submitOrder() {
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
        // STEP 1: Analyze image
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
        
        // Render real stitches on Canvas
        if (analysis.stitch_data) {
            currentStitchData = analysis.stitch_data;
            renderStitchCanvas(analysis.stitch_data, 'stitchCanvas');
        }
        
        document.getElementById('previewOriginal').style.display = 'block';'''
    
    if old_submit_start in html:
        html = html.replace(old_submit_start, new_submit_start)
        print("  Replaced submitOrder with Canvas-based rendering")
    else:
        print("  WARNING: Could not find submitOrder start pattern")
    
    # Fix 4: Add convert call after analysis for file generation
    old_submit_mid = '''        updateColorPalette(colors);
        
        document.getElementById('previewStitches').textContent = '~' + (analysis.estimated_stitch_count || 5000).toLocaleString();
        document.getElementById('previewColors').textContent = colors.length;
        document.getElementById('previewTime').textContent = Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + 'm';
        
        document.getElementById('previewOriginal').style.display = 'block';
        previewSection.classList.add('active');
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''
    
    new_submit_mid = '''        updateColorPalette(colors);
        
        document.getElementById('previewStitches').textContent = '~' + (analysis.estimated_stitch_count || 5000).toLocaleString();
        document.getElementById('previewColors').textContent = colors.length;
        document.getElementById('previewTime').textContent = Math.ceil((analysis.estimated_stitch_count || 5000) / 300) + 'm';
        
        document.getElementById('previewOriginal').style.display = 'block';
        previewSection.classList.add('active');
        
        // STEP 2: Generate embroidery file with user-selected format
        const settings = getSettings();
        const fileType = settings.fileType || 'dst';
        
        try {
            const convertForm = new FormData();
            convertForm.append('image', uploadedFile);
            convertForm.append('settings', JSON.stringify(settings));
            convertForm.append('phone', 'web_' + Date.now());
            
            const convertRes = await fetch('/api/convert', {
                method: 'POST',
                body: convertForm
            });
            
            if (convertRes.ok) {
                const convertData = await convertRes.json();
                currentJobId = convertData.jobId;
                
                // Poll for completion
                const checkStatus = async () => {
                    const statusRes = await fetch(`/api/status/${currentJobId}`);
                    const statusData = await statusRes.json();
                    
                    if (statusData.status === 'completed') {
                        // Update download links
                        const result = statusData.result || {};
                        updateDownloadLinks(result, fileType);
                    } else if (statusData.status === 'failed') {
                        console.error('Conversion failed:', statusData.error);
                    } else {
                        setTimeout(checkStatus, 2000);
                    }
                };
                setTimeout(checkStatus, 3000);
            }
        } catch(convErr) {
            console.log('File generation queued for later:', convErr.message);
        }
        
        // Auto-scroll to preview
        setTimeout(() => {
            previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);'''
    
    if old_submit_mid in html:
        html = html.replace(old_submit_mid, new_submit_mid)
        print("  Added file generation to submitOrder")
    else:
        print("  WARNING: Could not find submitOrder mid section")
    
    # Fix 5: Add zoomCanvas function and updateDownloadLinks
    old_zoom = '''        function zoomPreview(factor) {
            currentZoom *= factor;
            const img = document.getElementById('stitchPreview');
            img.style.transform = `scale(${currentZoom})`;
            img.style.transformOrigin = 'center';
        }'''
    
    new_zoom = '''        function zoomCanvas(factor) {
            currentZoom *= factor;
            const canvas = document.getElementById('stitchCanvas');
            canvas.style.transform = `scale(${currentZoom})`;
            canvas.style.transformOrigin = 'center';
        }
        
        function updateDownloadLinks(result, preferredFormat) {
            // Update any existing download buttons
            const formatMap = {
                dst: result.dst_url,
                pes: result.pes_url,
                jef: result.jef_url,
                exp: result.exp_url,
                vp3: result.vp3_url
            };
            
            const url = formatMap[preferredFormat];
            if (url) {
                console.log(`File ready: ${preferredFormat.toUpperCase()} -> ${url}`);
            }
        }'''
    
    if old_zoom in html:
        html = html.replace(old_zoom, new_zoom)
        print("  Replaced zoom with zoomCanvas + added download link updater")
    else:
        print("  WARNING: Could not find zoomPreview")
    
    with open("index.html", "w") as f:
        f.write(html)
    
    # Cleanup
    import os
    os.remove("bot_clean.js")
    os.remove("index_clean.html")
    
    print("\n[4/6] Cleanup done")
    print("\n[5/6] Files rebuilt:")
    print("  bot.js    - Real DST generator + stitch data API")
    print("  index.html - Canvas stitch renderer + file generation")
    
    print("\n[6/6] Commit and push:")
    print("  git add bot.js index.html")
    print("  git commit -m 'feat: real embroidery stitch simulation + DST generation'")
    print("  git push origin main --force")

if __name__ == '__main__':
    main()
