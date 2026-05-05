#!/bin/bash
# Run this in ~/stichai after a git reset to get clean files

cd ~/stichai

# Step 1: Reset to the last known clean commit
git checkout a4fc32a -- bot.js index.html

# Step 2: Create the minimal fix script
cat > fix_minimal.py << 'PYEOF'
with open('bot.js', 'r') as f:
    lines = f.readlines()

# Fix 1: CONFIG.GEMINI models (lines 46-48, 0-indexed: 45-47)
lines[45] = '    lite:  "gemini-2.5-flash-lite-preview-06-17",\n'
lines[46] = '    flash: "gemini-2.5-flash",\n'
lines[47] = '    pro:   "gemini-2.5-pro",\n'
print("[1/2] Fixed CONFIG.GEMINI models")

# Fix 2: Replace the entire /api/analyze-image route (lines 620-678, 0-indexed: 619-677)
# with a safe version using gemini-2.5-flash for analysis and gemini-2.0-flash-exp for preview
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

# Replace lines 619-677 (the old route) with new_route
lines = lines[:619] + [new_route] + lines[678:]
print("[2/2] Replaced /api/analyze-image route with safe version")

with open('bot.js', 'w') as f:
    f.writelines(lines)

print("\nDone. bot.js is clean and fixed.")
PYEOF

python3 fix_minimal.py

# Verify
echo ""
echo "=== Verification ==="
grep -n "gemini-" bot.js | grep -E "lite:|flash:|pro:|models/" | head -5
grep -c "async (req, res) =>" bot.js
grep -n "app.post.*analyze-image" bot.js

echo ""
echo "Run these to commit:"
echo "  git add bot.js index.html"
echo "  git commit -m 'fix: Gemini 2.5 + safe analyze-image route'"
echo "  git push origin main --force"
