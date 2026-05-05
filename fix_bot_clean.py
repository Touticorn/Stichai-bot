import re

with open('bot.js', 'r') as f:
    bot = f.read()

# Find and replace the broken /api/analyze-image route
route_start = bot.find('app.post("/api/analyze-image"')
if route_start == -1:
    print("ERROR: cannot find route")
    exit(1)

next_route = bot.find('app.post("', route_start + 1)
if next_route == -1:
    print("ERROR: cannot find next route")
    exit(1)

end_search = bot.rfind('});', route_start, next_route)
if end_search == -1:
    print("ERROR: cannot find route end")
    exit(1)
route_end = end_search + 3

old_route = bot[route_start:route_end]

new_route = '''app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    
    const b64 = req.file.buffer.toString("base64");
    const mime = req.file.mimetype || "image/jpeg";
    
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
});'''

bot = bot[:route_start] + new_route + bot[route_end:]

# Fix CONFIG
bot = bot.replace('lite:  "gemini-3.1-flash-preview"', 'lite:  "gemini-2.5-flash-lite-preview-06-17"')
bot = bot.replace('flash: "gemini-3.1-flash-preview"', 'flash: "gemini-2.5-flash"')
bot = bot.replace('pro:   "gemini-3.1-pro-preview"', 'pro:   "gemini-2.5-pro"')

# Fix processAndDeliver
old_wa = '''    const modelLabel = analysis._model?.includes("lite") ? "Flash-Lite" : analysis._model?.includes("pro") ? "Pro" : "Flash";
    const summary = {
      ar:`Stitches: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} color | Gemini ${modelLabel}`,
      fr:`Points: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} couleur | Gemini ${modelLabel}`,
      en:`Stitches: ~${(analysis.stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.colors?.length||1} color | Gemini ${modelLabel}`,
    };'''
new_wa = '''    const modelLabel = analysis._model?.includes("pro") ? "Pro" : "Flash";
    const summary = {
      ar:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
      fr:`Points: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} couleur | Gemini ${modelLabel}`,
      en:`Stitches: ~${(analysis.estimated_stitch_count||5000).toLocaleString()} | ${analysis.width_mm}x${analysis.height_mm}mm | ${analysis.dominant_colors?.length||1} color | Gemini ${modelLabel}`,
    };'''
if old_wa in bot:
    bot = bot.replace(old_wa, new_wa)

# Fix processWebJob
old_web = '''    job.result = {
      stitch_count: files?.stitch_count || analysis.stitch_count || 5000,
      estimated_stitch_count: files?.stitch_count || analysis.stitch_count || 5000,
      colors: analysis.colors?.length || 1,
      dominant_colors: analysis.colors || ['#c41e3a', '#ffd700', '#ffffff'],
      suggested_stitch_type: analysis.stitch_type || settings.stitchType || 'fill',
      width_mm: analysis.width_mm,
      height_mm: analysis.height_mm,
      description: analysis.description || '',
      dst_url: files?.dst_url || null,
      pes_url: files?.pes_url || null,
      jef_url: files?.jef_url || null,
      exp_url: files?.exp_url || null,
      vp3_url: files?.vp3_url || null,
      estimated_time: Math.ceil((analysis.stitch_count || 5000) / 300) + "m"
    };'''
new_web = '''    job.result = {
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
if old_web in bot:
    bot = bot.replace(old_web, new_web)

with open('bot.js', 'w') as f:
    f.write(bot)

# Verify
if 'async (req, res) => {' in bot[route_start:route_start+100]:
    print("OK: async present in route")
else:
    print("WARNING: async missing!")

if bot.count('app.post("/api/analyze-image"') == 1:
    print("OK: exactly 1 analyze-image route")
else:
    print(f"WARNING: {bot.count('app.post(\\\"/api/analyze-image\\\"')} routes found")

print("\nDone.")
