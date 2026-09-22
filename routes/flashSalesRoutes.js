const express = require('express');
const router = express.Router();
const pool = require('../config/db');

const getActiveSales = async (req, res) => {
  try {
    const query = `
      SELECT fs.*, p.name, p.slug, p.price as original_price,
      (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images,
      ROUND((fs.sold_count / fs.total_stock) * 100) as stock_percent
      FROM flash_sales fs
      JOIN products p ON fs.product_id = p.id
      WHERE fs.is_active = 1 
      AND fs.start_time <= NOW() 
      AND fs.end_time >= NOW()
      AND fs.sold_count < fs.total_stock
    `;
    const [sales] = await pool.query(query);
    
    res.json({ success: true, data: sales });
  } catch (error) {
    console.error("Flash sales fetch failed:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/flash-sales/active
router.get('/active', getActiveSales);
// FIXED: Bind base URL as frontend defaults to /api/flash-sales
router.get('/', getActiveSales);

module.exports = router;
