// routes/aiRoutes.js (New File)
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

router.post('/generate-product-content', async (req, res) => {
  try {
    const { productName } = req.body;
    const prompt = `You are an expert copywriter for an organic skincare brand named Bhumivera. 
    Generate a JSON response for a product named "${productName}". 
    Include:
    - description: A beautiful, 3-sentence engaging description emphasizing natural ingredients.
    - meta_title: A catchy SEO title under 60 characters.
    - meta_description: An SEO snippet under 160 characters.
    - tags: A comma-separated list of 5 relevant SEO keywords.
    Respond ONLY with valid JSON.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Flash is blazing fast
      contents: prompt,
    });

    // Clean and parse the JSON response
    const jsonStr = response.text.replace(/```json/g, '').replace(/```/g, '');
    res.json({ success: true, data: JSON.parse(jsonStr) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
module.exports = router;
