const { searchLimiter } = require('../middleware/rateLimiter');
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { performSemanticSearch } = require('../services/vectorService');
const { cleanProductMarketingFields } = require('../utils/productMarketingClaims');
const { BHUMIVERA_6_PRODUCTS } = require('../data/bhumiveraCatalog');

const STOP_WORDS = new Set(['with', 'for', 'and', 'the', 'best', 'in', 'by', 'of', 'to', 'from', 'a', 'an', 'on', 'my', 'all']);

const normalizeQuerySynonyms = (raw = '') =>
  String(raw || '')
    .toLowerCase()
    .replace(/niacidamine|niacinimide|nicotinamide|vitamin\s*b3/g, 'niacinamide')
    .replace(/hyaluronic|hyluronic|sodium\s*hyaluronate/g, 'hyaluronic acid')
    .replace(/facewash|face-wash/g, 'face wash')
    .replace(/seabuckthorn|sea-buckthorn|seabuck\s*thorn/g, 'sea buckthorn')
    .replace(/aloevera|aleovera/g, 'aloe vera')
    .replace(/shikhakai/g, 'shikakai')
    .replace(/bringna|bhringraj/g, 'bhringraj')
    .replace(/ritta|reetha|soapnut/g, 'reetha')
    .replace(/haridra|turmeric/g, 'haridra turmeric')
    .replace(/manjistha|rubia\s*cordifolia/g, 'manjistha')
    .replace(/panchtulsi|panch\s*tulsi|seven\s*tulsi|7\s*tulsi/g, 'tulsi')
    .trim();

const scoreCatalogMatch = (product, rawQuery) => {
  const normalizedQ = normalizeQuerySynonyms(rawQuery);
  const tokens = normalizedQ
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  const corpus = normalizeQuerySynonyms(
    [
      product.name,
      product.subtitle,
      product.slug,
      ...(product.legacySlugs || []),
      product.category,
      product.active_ingredients,
      product.short_description,
      product.search_keywords,
      product.full_description,
    ].join(' ')
  );

  let score = 0;
  if (corpus.includes(normalizedQ)) score += 50;
  for (const token of tokens) {
    if (token === 'bhumivera') {
      score += 5;
      continue;
    }
    if (normalizeQuerySynonyms(product.name).includes(token)) score += 20;
    else if (normalizeQuerySynonyms(product.active_ingredients).includes(token)) score += 15;
    else if (normalizeQuerySynonyms(product.search_keywords).includes(token)) score += 10;
    else if (corpus.includes(token)) score += 5;
  }
  return score;
};

const parseImages = (rows) => {
  return rows.map(row => {
    let parsedImages = [];
    if (row.images) {
      try {
        parsedImages = typeof row.images === 'string' ? JSON.parse(row.images) : row.images;
      } catch (e) { parsedImages = []; }
    }
    return { ...cleanProductMarketingFields(row), images: parsedImages };
  });
};

// GET /api/search?q=facewash+with+niacidamine
router.get('/', searchLimiter, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }

    const maxItems = Math.max(1, parseInt(limit, 10) || 10);

    // Attempt Semantic AI Search first
    try {
      const semanticResults = await performSemanticSearch(q, maxItems);
      if (Array.isArray(semanticResults) && semanticResults.length > 0) {
        return res.json({ 
          success: true, 
          isAiPowered: true,
          data: parseImages(semanticResults) 
        });
      }
    } catch (aiError) {
      console.warn("[Search] AI Search unavailable, falling back to synonym-aware SQL & catalog search.");
    }

    const normalizedQ = normalizeQuerySynonyms(q);
    let sqlResults = [];
    try {
      const [rows] = await pool.query(`
        SELECT p.*, 
        (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
        FROM products p 
        WHERE p.status = 'active' 
        AND (p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ? OR p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ?)
        LIMIT ?
      `, [`%${q}%`, `%${q}%`, `%${q}%`, `%${normalizedQ}%`, `%${normalizedQ}%`, `%${normalizedQ}%`, maxItems]);
      sqlResults = Array.isArray(rows) ? parseImages(rows) : [];
    } catch {
      sqlResults = [];
    }

    const catalogScored = BHUMIVERA_6_PRODUCTS
      .map((product) => ({ product, score: scoreCatalogMatch(product, q) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.product);

    const merged = [...sqlResults];
    for (const catProd of catalogScored) {
      if (!merged.some((m) => m.slug === catProd.slug || String(m.id) === String(catProd.id))) {
        merged.push(catProd);
      }
    }

    return res.json({ 
      success: true, 
      isAiPowered: false,
      data: merged.slice(0, maxItems)
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Search operation failed' });
  }
});
const { syncProductToVectorDB } = require('../services/vectorService');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// POST /api/search/sync-all (Admin Only - Run this once to fill Pinecone)
router.post('/sync-all', authenticateAdmin, async (req, res) => {
  try {
    // 1. Fetch all active products from your MySQL database
    const [products] = await pool.query('SELECT * FROM products WHERE status = "active"');
    
    if (products.length === 0) {
      return res.json({ success: true, message: "No active products found to sync." });
    }

    console.log(`[Sync] Starting vector sync for ${products.length} products...`);

    // 2. Loop through and push each one to Pinecone via OpenAI
    let successCount = 0;
    for (const product of products) {
      try {
        await syncProductToVectorDB(product);
        successCount++;
      } catch (err) {
        console.error(`Failed to sync product ID ${product.id}`);
      }
    }

    res.json({ 
      success: true, 
      message: `Successfully synced ${successCount}/${products.length} products to Pinecone!` 
    });
  } catch (error) {
    console.error("Bulk sync error:", error);
    res.status(500).json({ success: false, message: "Bulk sync failed" });
  }
});
module.exports = router;
