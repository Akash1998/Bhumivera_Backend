const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { performSemanticSearch } = require('../services/vectorService');

const parseImages = (rows) => {
  return rows.map(row => {
    let parsedImages = [];
    if (row.images) {
      try {
        parsedImages = typeof row.images === 'string' ? JSON.parse(row.images) : row.images;
      } catch (e) { parsedImages = []; }
    }
    return { ...row, images: parsedImages };
  });
};

// GET /api/search?q=dry+skin+soap
router.get('/', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }

    // Attempt Semantic AI Search first
    try {
      const semanticResults = await performSemanticSearch(q, parseInt(limit));
      
      return res.json({ 
        success: true, 
        isAiPowered: true,
        data: parseImages(semanticResults) 
      });
      
    } catch (aiError) {
      // FALLBACK: If Pinecone/OpenAI fails or isn't set up yet, fallback to standard SQL search gracefully
      console.warn("[Search] AI Search unavailable, falling back to SQL LIKE search.");
      
      const [sqlResults] = await pool.query(`
        SELECT p.*, 
        (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
        FROM products p 
        WHERE p.status = 'active' 
        AND (p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ?)
        LIMIT ?
      `, [`%${q}%`, `%${q}%`, `%${q}%`, parseInt(limit)]);

      return res.json({ 
        success: true, 
        isAiPowered: false,
        data: parseImages(sqlResults) 
      });
    }

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
