import urllib.request

# Download the clean original directly from GitHub
url = "https://raw.githubusercontent.com/Touticorn/Stichai-bot/a4fc32a/bot.js"
print("Downloading clean original...")
urllib.request.urlretrieve(url, "bot_clean.js")

with open("bot_clean.js", "r") as f:
    lines = f.readlines()

print(f"Downloaded {len(lines)} lines")

# Fix 1: CONFIG.GEMINI models (lines 46-48 → indices 45-47)
lines[45] = '    lite:  "gemini-2.5-flash-lite-preview-06-17",\n'
lines[46] = '    flash: "gemini-2.5-flash",\n'
lines[47] = '    pro:   "gemini-2.5-pro",\n'
print("[1/3] Fixed CONFIG.GEMINI")

# Fix 2: Replace /api/analyze-image route (lines 620-678 → indices 619-677)
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
    
    // STEP 2: Try to generate stitch preview image (optional)
    let previewImage = null;
    try {
      const previewRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [
              { inlineData: { mimeType: mime, data: b64 } },
              { text: `Generate an embroidery stitch preview of this design. Show how it would look stitched on fabric. Use these thread colors: ${analysis.dominant_colors?.join(', ') || 'red, gold, white'}. Return ONLY the image.` }
            ]
          }]
        },
        { timeout: 45000 }
      );
      
      const candidate = previewRes.data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part?.inlineData) {
          previewImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }
    } catch(e) {
      console.log("Preview generation skipped:", e.message);
    }
    
    res.json({
      ...analysis,
      preview_image: previewImage
    });
    
  } catch(e) {
    console.error("Gemini error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

'''

# Rebuild the file
lines = lines[:619] + [new_route] + lines[678:]

with open("bot.js", "w") as f:
    f.writelines(lines)

# Cleanup
import os
os.remove("bot_clean.js")

print("[2/3] Replaced /api/analyze-image route")
print("[3/3] Wrote clean bot.js")

# Verify
with open("bot.js", "r") as f:
    content = f.read()

print("\n=== Verification ===")
print(f"  gemini-3.1 in file: {'YES (BAD)' if 'gemini-3.1' in content else 'NO (GOOD)'}")
print(f"  gemini-2.5 in CONFIG: {'YES (GOOD)' if 'gemini-2.5' in content else 'NO (BAD)'}")
print(f"  'async (req, res)' in route: {'YES (GOOD)' if 'async (req, res) =>' in content else 'NO (BAD)'}")
print(f"  'data?.candidates' (safe access): {'YES (GOOD)' if 'data?.candidates' in content else 'NO (BAD)'}")
print(f"  File lines: {len(content.split(chr(10)))}")

print("\nDone. Commit with:")
print("  git add bot.js && git commit -m 'fix: clean bot.js from original' && git push origin main --force")
