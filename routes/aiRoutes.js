// routes/aiRoutes.js
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

router.post('/generate-product-content', async (req, res) => {
  try {
    const { productName } = req.body;
    
    // We remove the instruction to "Respond ONLY with valid JSON" from the prompt
    // because we are forcing it at the protocol level via the config object.
    const prompt = `You are an expert copywriter for an organic skincare brand named Bhumivera. 
    Generate content for a product named "${productName}". 
    You must return a JSON object with exactly these four keys:
    "description": A beautiful, 3-sentence engaging description emphasizing natural ingredients.
    "meta_title": A catchy SEO title strictly under 60 characters.
    "meta_description": An SEO snippet strictly under 160 characters.
    "tags": A single string of 5 comma-separated relevant SEO keywords.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        // This is the enterprise-grade fix. It forces the Gemini API 
        // to bypass Markdown wrappers and return raw, parseable JSON.
        responseMimeType: "application/json",
      }
    });

    // Directly parse the text, no Regex required.
    const parsedData = JSON.parse(response.text);

    res.json({ success: true, data: parsedData });
  } catch (error) {
    console.error('[AI Generation Error]:', error);
    res.status(500).json({ success: false, error: 'Failed to generate AI content. Please ensure API keys are valid.' });
  }
});

module.exports = router;
