import re

with open('bot.js', 'r') as f:
    bot = f.read()

# Find the entire /api/analyze-image route by start/end markers
start_idx = bot.find('app.post("/api/analyze-image"')
if start_idx == -1:
    print("ERROR: Could not find route")
    exit(1)

end_idx = bot.find('});', start_idx)
if end_idx == -1:
    print("ERROR: Could not find end of route")
    exit(1)
end_idx += 3

old_route = bot[start_idx:end_idx]

new_route = '''app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    
    // STEP 1: Analyze the image (safe fallback)
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

print("Replaced route. Every Gemini call is now wrapped in try/catch.")
