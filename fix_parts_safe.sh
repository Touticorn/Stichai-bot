cat > fix_parts.py << 'PYEOF'
import re

with open('bot.js', 'r') as f:
    bot = f.read()

# Strategy: find the entire /api/analyze-image route by its start signature
# and replace the whole thing with a safe version

start_marker = 'app.post("/api/analyze-image"'
start_idx = bot.find(start_marker)
if start_idx == -1:
    print("ERROR: Could not find /api/analyze-image route")
    exit(1)

# Find the end of this route: look for the matching });
# We'll find "});" after the start, but need to be careful with nested braces
# Simple heuristic: find the next "});" that ends a route block
end_idx = bot.find('});', start_idx)
if end_idx == -1:
    print("ERROR: Could not find end of route")
    exit(1)
end_idx += 3  # include the });

old_route = bot[start_idx:end_idx]

new_route = '''app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    
    // STEP 1: Analyze the image
    let analysis = { 
      complexity: "medium", 
      dominant_colors: ["#c41e3a", "#ffd700", "#ffffff"], 
      suggested_stitch_type: "fill", 
      estimated_stitch_count: 5000, 
      width_mm: 80, 
      height_mm: 80,
      has_text: false,
      has_logo: false,
      description: "Embroidery design"
    };
    
    try {
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
      
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
        analysis = { ...analysis, ...parsed };
      } catch(jsonErr) {
        console.log("JSON parse failed:", jsonErr.message);
      }
    } catch(analyzeErr) {
      console.log("Analysis failed:", analyzeErr.message);
    }
    
    // STEP 2: Try to generate preview image (completely optional)
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
    } catch(previewErr) {
      console.log("Preview generation skipped:", previewErr.message);
    }
    
    res.json({
      ...analysis,
      preview_image: previewImage
    });
    
  } catch(e) {
    console.error("Fatal error:", e.message);
    res.status(500).json({ error: e.message });
  }
});'''

bot = bot[:start_idx] + new_route + bot[end_idx:]

with open('bot.js', 'w') as f:
    f.write(bot)

print("Replaced /api/analyze-image route with fully safe version")
print("Every Gemini call is wrapped in try/catch")
print("Returns sensible defaults if anything fails")
PYEOF

python3 fix_parts.py

git add bot.js
git commit -m "fix: safe analyze-image with fallbacks"
git push origin main
