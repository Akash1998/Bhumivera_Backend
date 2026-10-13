const { GoogleGenAI } = require('@google/genai');
const pool = require('../config/db');
const { cleanProductMarketingFields } = require('../utils/productMarketingClaims');

const getAIClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

async function identifyFromImage(imageBase64, mimeType = 'image/jpeg') {
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
  const ai = getAIClient();

  let detection = {
    detectedEntity: 'Skincare Product',
    category: 'Skincare',
    searchKeywords: ['organic', 'natural', 'ayurvedic', 'skincare'],
  };

  if (ai) {
    try {
      const prompt = `Analyze this image for an eco-friendly Ayurvedic and skincare ecommerce store (Bhumivera).
Identify:
1. What item, cosmetic product, plant, or botanical ingredient is visible?
2. Extract 3-5 concise search keywords suitable for querying a catalog (e.g., "neem soap", "face oil", "aloe vera", "serum", "hair oil").
Return a JSON object with:
"detectedEntity": string,
"category": string,
"searchKeywords": string[]`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: cleanBase64,
            },
          },
        ],
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text);
      if (parsed && parsed.searchKeywords && Array.isArray(parsed.searchKeywords)) {
        detection = parsed;
      }
    } catch (aiErr) {
      console.warn('[VISUAL_SEARCH_GEMINI_FALLBACK]', aiErr.message);
    }
  }

  // Find matching catalog products using keywords
  const keywords = detection.searchKeywords || [detection.detectedEntity];
  const searchClause = keywords.map(() => '(name LIKE ? OR description LIKE ? OR tags LIKE ?)').join(' OR ');
  const params = [];
  keywords.forEach(kw => {
    const term = `%${kw.trim()}%`;
    params.push(term, term, term);
  });

  const [products] = await pool.query(
    `SELECT p.*,
     (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
     FROM products p
     WHERE p.status = 'active' AND (${searchClause})
     LIMIT 12`,
    params
  );

  const parsedProducts = products.map(row => {
    let parsedImages = [];
    if (row.images) {
      try {
        parsedImages = typeof row.images === 'string' ? JSON.parse(row.images) : row.images;
      } catch (e) { parsedImages = []; }
    }
    return { ...cleanProductMarketingFields(row), images: parsedImages };
  });

  return {
    detection,
    products: parsedProducts,
  };
}

module.exports = { identifyFromImage };
