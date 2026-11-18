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

const normalizeSlug = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const parseGeminiJson = rawText => {
  const cleaned = String(rawText || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object.');
    }
    return parsed;
  } catch {
    throw new Error('Gemini returned invalid JSON. Please retry generation.');
  }
};

const limitText = (value, maxLength) => {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  const shortened = text.slice(0, maxLength + 1).replace(/\s+\S*$/, '').trim();
  return shortened || text.slice(0, maxLength).trim();
};

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
"slug": lower-case URL slug using only letters, numbers, and hyphens.
"description": Two or three concise sentences, based only on supplied facts.
"meta_title": SEO title under 60 characters.
"meta_description": Search snippet under 160 characters.
"tags": Five relevant comma-separated search terms.`;

    const rawText = await callGeminiModel({
      prompt,
      responseMimeType: 'application/json',
      timeoutMs: Number(process.env.GEMINI_SEO_TIMEOUT_MS) || 45000,
    });
    const generated = parseGeminiJson(rawText);
    const fields = ['slug', 'description', 'meta_title', 'meta_description', 'tags'];
    if (fields.some(field => typeof generated[field] !== 'string' || !generated[field].trim())) {
      throw new Error('Gemini returned incomplete product SEO content. Please retry generation.');
    }
    const slug = normalizeSlug(generated.slug);
    if (!slug || slug.length > 120) {
      throw new Error('Gemini returned an invalid product slug. Please retry generation.');
    }

    return res.json({
      success: true,
      model: resolveGeminiConfig().model,
      data: {
        slug,
        description: limitText(generated.description, 10000),
        meta_title: limitText(generated.meta_title, 60),
        meta_description: limitText(generated.meta_description, 160),
        tags: generated.tags.trim(),
      },
    });
  } catch (error) {
    console.error('[AI Generation Error]:', error);
    const isConfigurationError = error.message?.includes('not configured');
    const status = isConfigurationError ? 503 : Number(error.status) === 504 ? 504 : 502;
    return res.status(status).json({
      success: false,
      message: isConfigurationError
        ? error.message
        : status === 504
          ? 'Gemini timed out before finishing the generation. Retry with fewer product details.'
          : error.message || 'Gemini could not generate product content right now.',
    });
  }
});

router.post('/generate-taxonomy-seo', authenticateAdmin, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
      return res.status(400).json({
        success: false,
        message: 'Generate SEO for between 1 and 8 categories at a time.',
      });
    }

    const normalizedItems = items.map(item => ({
      id: String(item?.id ?? '').trim(),
      type: item?.type,
      name: typeof item?.name === 'string' ? item.name.trim() : '',
      parentName: typeof item?.parentName === 'string' ? item.parentName.trim().slice(0, 120) : '',
      currentSlug: typeof item?.slug === 'string' ? item.slug.trim().slice(0, 120) : '',
      description: typeof item?.description === 'string' ? item.description.trim().slice(0, 1200) : '',
    }));

    if (normalizedItems.some(item =>
      !item.id || item.id.length > 80 ||
      !['category', 'subcategory'].includes(item.type) ||
      !item.name || item.name.length > 100
    ) || new Set(normalizedItems.map(item => item.id)).size !== normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: 'Each item needs a unique ID, a category type, and a name under 100 characters.',
      });
    }

    const { configured, model } = resolveGeminiConfig();
    if (!configured) {
      return res.status(503).json({
        success: false,
        message: 'SEO generation is not configured. Set GEMINI_API_KEY on the server.',
      });
    }

    const prompt = `Generate SEO fields for each supplied Bhumivera catalog category.
Use only the supplied category names, parent names, and descriptions. Do not invent products, ingredients, benefits, certifications, prices, or claims. Do not claim or promise rankings. Write natural, useful English for shoppers; avoid keyword stuffing.
For each item, return its exact id, a concise lower-case URL slug, a useful category description (one or two sentences), a meta_title no longer than 60 characters, and a meta_description no longer than 160 characters.
Return only valid JSON with this shape:
{"items":[{"id":"exact input id","slug":"...","description":"...","meta_title":"...","meta_description":"..."}]}
Input:
${JSON.stringify(normalizedItems)}`;

    const rawText = await callGeminiModel({
      prompt,
      responseMimeType: 'application/json',
      timeoutMs: Number(process.env.GEMINI_SEO_TIMEOUT_MS) || 45000,
    });
    const generated = parseGeminiJson(rawText);
    if (!Array.isArray(generated.items) || generated.items.length !== normalizedItems.length) {
      throw new Error('Gemini returned an incomplete taxonomy SEO batch. Please retry generation.');
    }

    const generatedById = new Map();
    for (const result of generated.items) {
      const id = String(result?.id ?? '').trim();
      const slug = normalizeSlug(result?.slug);
      if (!id || generatedById.has(id) || !normalizedItems.some(item => item.id === id) ||
          !slug || slug.length > 120 ||
          ['description', 'meta_title', 'meta_description'].some(field =>
            typeof result[field] !== 'string' || !result[field].trim()
          )) {
        throw new Error('Gemini returned invalid taxonomy SEO fields. Please retry generation.');
      }
      generatedById.set(id, {
        id,
        slug,
        description: limitText(result.description, 600),
        meta_title: limitText(result.meta_title, 60),
        meta_description: limitText(result.meta_description, 160),
      });
    }

    if (generatedById.size !== normalizedItems.length) {
      throw new Error('Gemini did not return SEO fields for every taxonomy item. Please retry generation.');
    }
    return res.json({
      success: true,
      model,
      items: normalizedItems.map(item => generatedById.get(item.id)),
    });
  } catch (error) {
    console.error('[AI Taxonomy SEO Error]:', error);
    const isConfigurationError = error.message?.includes('not configured');
    const status = isConfigurationError ? 503 : Number(error.status) === 504 ? 504 : 502;
    return res.status(status).json({
      success: false,
      message: isConfigurationError
        ? error.message
        : status === 504
          ? 'Gemini timed out before finishing SEO generation. Retry with fewer categories.'
          : error.message || 'Gemini could not generate taxonomy SEO right now.',
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

/**
 * GET /api/ai/veo/jobs
 * Returns registered Veo concierge video jobs and their cached asset status.
 */
router.get('/veo/jobs', (_req, res) => {
  try {
    const { getRegisteredJobs, queueState } = require('../services/veoVideoService');
    const jobs = getRegisteredJobs();
    return res.json({
      success: true,
      activeJobId: queueState.activeJobId,
      activeProgressSeconds: queueState.activeProgressSeconds,
      jobs,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/ai/veo/generate
 * Triggers sequential Veo 2 video generation for a specific job or custom prompt.
 */
router.post('/veo/generate', authenticateAdmin, async (req, res) => {
  try {
    const { CONCIERGE_VIDEO_JOBS, executeVeoJob, queueState } = require('../services/veoVideoService');
    const { jobId, prompt, durationSeconds = 10, aspectRatio = '16:9' } = req.body || {};

    if (queueState.activeJobId) {
      return res.status(429).json({
        success: false,
        message: `A video generation job (${queueState.activeJobId}) is currently active. To protect API limits, only 1 video can be generated at a time.`,
        activeJobId: queueState.activeJobId,
      });
    }

    let targetJob = CONCIERGE_VIDEO_JOBS.find(j => j.id === jobId);
    if (!targetJob) {
      if (!prompt) {
        return res.status(400).json({ success: false, message: 'Valid jobId or prompt is required.' });
      }
      targetJob = {
        id: `custom_${Date.now()}`,
        category: 'Custom Admin',
        title: 'Custom Admin Prompt',
        fileName: `custom_${Date.now()}.mp4`,
        prompt: String(prompt).trim(),
        durationSeconds: Math.min(10, Math.max(5, Number(durationSeconds) || 10)),
        aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
      };
    }

    // Trigger asynchronously so HTTP request doesn't hang for 90s
    executeVeoJob(targetJob).catch(err => {
      console.error(`[VEO ASYNC ERROR for ${targetJob.id}]:`, err);
    });

    return res.json({
      success: true,
      message: `Veo video generation initiated for "${targetJob.id}". Processing in background.`,
      job: targetJob,
    });
  } catch (err) {
    console.error('[VEO GENERATE ERROR]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


/**
 * GET /api/ai/legal-charter
 * Returns structured metadata for the 4x-expanded 8-part, 88-clause Bhumivera Master Legal & Anti-Scam Charter
 * and the 12 Storefront/Footer + 9 Concierge MP4 video assets.
 */
router.get('/legal-charter', (_req, res) => {
  const { STOREFRONT_VIDEO_JOBS, CONCIERGE_VIDEO_JOBS } = require('../services/veoVideoService');
  return res.json({
    success: true,
    version: '2026-10-17-v4X',
    totalParts: 8,
    totalClauses: 88,
    governingLaws: [
      'Consumer Protection Act, 2019 & Consumer Protection (E-Commerce) Rules, 2020',
      'Information Technology Act, 2000 & Intermediary Rules, 2021',
      'Digital Personal Data Protection (DPDP) Act, 2023',
      'Indian Contract Act, 1872 & Sale of Goods Act, 1930',
      'Drugs and Cosmetics Act, 1940 & Cosmetics Rules, 2020',
      'Bharatiya Sakshya Adhiniyam, 2023 (Section 63 Electronic Evidence)',
      'Arbitration and Conciliation Act, 1996 (Seat: Paschim Bardhaman / Asansol, West Bengal)',
    ],
    antiScamProtections: {
      hygieneNonReturnRule: true,
      mandatory360UncutUnboxingVideoWithin48Hours: true,
      warehouseCctvAndDigitalWeightVerification: true,
      superAdminExclusiveOrderCancellationLock: true,
      dualLedgerWalletRingFencing: true,
      chargebackAndSybilFraudEnforcement: true,
    },
    storefrontVideos: STOREFRONT_VIDEO_JOBS,
    conciergeVideosCount: CONCIERGE_VIDEO_JOBS.length,
  });
});

module.exports = router;

