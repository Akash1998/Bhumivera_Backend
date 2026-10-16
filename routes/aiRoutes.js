//
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { callGeminiModel, resolveGeminiConfig } = require('../services/geminiService');
const {
  INGREDIENT_MEMORY_GRAPH,
  PRODUCT_INGREDIENT_GRAPH,
  KNOWLEDGE_BASE_QA,
  searchAllKnowledgeSources,
} = require('../services/bhumiveraKnowledgeBase');

router.post('/generate-product-content', authenticateAdmin, async (req, res) => {
  try {
    const { productName, category, brand, specifications } = req.body || {};
    if (typeof productName !== 'string' || !productName.trim()) {
      return res.status(400).json({ success: false, message: 'Enter a product name before using AI Auto-Fill.' });
    }

    const { configured } = resolveGeminiConfig();
    if (!configured) {
      return res.status(503).json({
        success: false,
        message: 'AI content generation is not configured. Set GEMINI_API_KEY on the server.',
      });
    }

    const prompt = `Write accurate ecommerce copy for Bhumivera.
Product name: ${productName.trim()}
Category: ${typeof category === 'string' && category.trim() ? category.trim() : 'Not provided'}
Brand: ${typeof brand === 'string' && brand.trim() ? brand.trim() : 'Bhumivera'}
Product information supplied by the admin (not independently verified): ${JSON.stringify(specifications || {})}

Do not invent ingredients, certifications, product category classifications, health or cosmetic benefits, warranties, guarantees, measurements, sourcing, sustainability attributes, or performance claims. Return a JSON object with exactly these string keys:
"description": Two or three concise sentences, based only on supplied facts.
"meta_title": SEO title under 60 characters.
"meta_description": Search snippet under 160 characters.
"tags": Five relevant comma-separated search terms.`;

    const rawText = await callGeminiModel({
      prompt,
      responseMimeType: 'application/json',
      timeoutMs: 6000,
    });

    let parsedData = null;
    if (rawText) {
      try {
        parsedData = JSON.parse(rawText);
      } catch {
        parsedData = null;
      }
    }

    // Graceful grounded fallback if external API is unreachable
    if (!parsedData) {
      const cleanName = productName.trim();
      const catLabel = typeof category === 'string' && category.trim() ? category.trim() : 'Botanical Care';
      parsedData = {
        description: `${cleanName} by ${brand || 'Bhumivera'} is part of our ${catLabel} collection. Check the product specification panel for the complete listed ingredients and directions for use.`,
        meta_title: `${cleanName} | Bhumivera ${catLabel}`.slice(0, 58),
        meta_description: `Explore ${cleanName} by Bhumivera. View complete ingredient notes, specifications, and daily usage directions.`.slice(0, 155),
        tags: `${cleanName.toLowerCase()}, bhumivera, ${catLabel.toLowerCase()}, botanical care, daily ritual`,
      };
    }

    const fields = ['description', 'meta_title', 'meta_description', 'tags'];
    if (!parsedData || fields.some(field => typeof parsedData[field] !== 'string' || !parsedData[field].trim())) {
      throw new Error('AI returned incomplete product content.');
    }

    return res.json({ success: true, data: parsedData });
  } catch (error) {
    console.error('[AI Generation Error]:', error);
    const isConfigurationError = error.message?.includes('not configured');
    return res.status(isConfigurationError ? 503 : 502).json({
      success: false,
      message: isConfigurationError
        ? error.message
        : 'AI could not generate product content right now. Check the server AI configuration and try again.',
    });
  }
});

/**
 * GET /api/ai/knowledge-guide
 * Public endpoint returning the complete Bhumivera Product & Ingredient Guide
 * and 300+ Q&A Knowledge Base for the website and concierge widget.
 */
router.get('/knowledge-guide', (_req, res) => {
  return res.json({
    success: true,
    totalQuestions: KNOWLEDGE_BASE_QA.length,
    products: Object.values(PRODUCT_INGREDIENT_GRAPH),
    ingredients: Object.values(INGREDIENT_MEMORY_GRAPH),
    featuredQuestions: KNOWLEDGE_BASE_QA.slice(0, 50),
  });
});

/**
 * POST /api/ai/ask
 * Direct AI Concierge Q&A & Ingredient Suggestion endpoint.
 */
router.post('/ask', async (req, res) => {
  try {
    const { question = '', sessionContext = {} } = req.body || {};
    if (!String(question || '').trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a question.' });
    }
    const match = await searchAllKnowledgeSources(String(question).trim(), { sessionContext });
    if (match?.matched) {
      return res.json({
        success: true,
        reply: match.reply,
        quickActions: match.quickActions || [],
        matchedType: match.matchedType,
        updatedContext: match.updatedContext || {},
      });
    }
    return res.json({
      success: true,
      reply:
        'Explore our **Sea Buckthorn Face Wash**, **Charcoal Face Wash**, **Niacinamide**, **Hyaluronic Acid**, or **Brand Ambassador Program** using the suggestions below!',
      quickActions: [
        { id: 'know_sb_fw', label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
        { id: 'ing_niacinamide', label: 'Ingredient: Niacinamide', prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash' },
        { id: 'amb_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
      ],
    });
  } catch (err) {
    console.error('[AI_ASK_ERR]', err);
    return res.status(500).json({ success: false, message: 'Could not process AI question.' });
  }
});

module.exports = router;
