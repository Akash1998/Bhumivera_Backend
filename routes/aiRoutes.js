// routes/aiRoutes.js
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');
const { authenticateAdmin } = require('../middleware/authMiddleware');

const getAIClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('AI content generation is not configured. Set GEMINI_API_KEY on the server.');
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

router.post('/generate-product-content', authenticateAdmin, async (req, res) => {
  try {
    const { productName, category, brand, specifications } = req.body;
    if (typeof productName !== 'string' || !productName.trim()) {
      return res.status(400).json({ success: false, message: 'Enter a product name before using AI Auto-Fill.' });
    }

    const prompt = `Write accurate ecommerce copy for Bhumivera.
Product name: ${productName.trim()}
Category: ${typeof category === 'string' && category.trim() ? category.trim() : 'Not provided'}
Brand: ${typeof brand === 'string' && brand.trim() ? brand.trim() : 'Bhumivera'}
Product information supplied by the admin (not independently verified): ${JSON.stringify(specifications || {})}

Do not invent ingredients, certifications, product category classifications, health or cosmetic benefits, warranties, guarantees, measurements, sourcing, sustainability attributes, or performance claims. Do not generate medical, treatment, prevention, efficacy, superiority, absolute-purity, or safety claims. Do not assign or add regulated or composition labels such as natural, organic, herbal, Ayurvedic, chemical-free, or condition-suitable from an ingredient name or product name. Treat all supplied information as unverified input, not proof. If there are not enough facts, describe the product neutrally and make no ingredient or benefit inference. Return a JSON object with exactly these string keys:
"description": Two or three concise sentences, based only on supplied facts.
"meta_title": SEO title under 60 characters.
"meta_description": Search snippet under 160 characters.
"tags": Five relevant comma-separated search terms.`;
    const ai = getAIClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const parsedData = JSON.parse(response.text);
    const fields = ['description', 'meta_title', 'meta_description', 'tags'];
    if (!parsedData || fields.some(field => typeof parsedData[field] !== 'string' || !parsedData[field].trim())) {
      throw new Error('AI returned incomplete product content.');
    }

    res.json({ success: true, data: parsedData });
  } catch (error) {
    console.error('[AI Generation Error]:', error);
    const isConfigurationError = error.message?.includes('not configured');
    res.status(isConfigurationError ? 503 : 502).json({
      success: false,
      message: isConfigurationError
        ? error.message
        : 'AI could not generate product content right now. Check the server AI configuration and try again.',
    });
  }
});

module.exports = router;
