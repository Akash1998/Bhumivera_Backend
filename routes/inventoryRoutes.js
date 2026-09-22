// backend/routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.name, p.sku, p.quantity AS stock, p.price, p.discount_price AS sale_price, 
             p.status AS is_active, p.video_urls, p.product_links,
             c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.quantity ASC
    `); // Added p.video_urls and p.product_links to the selection
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get inventory' });
  }
});

// GET /api/inventory/low-stock?threshold=5 - admin: low stock alert
router.get('/low-stock', authenticateAdmin, async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 5;
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.sku, p.quantity AS stock, p.price, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.quantity <= ? AND p.status = 'active'
       ORDER BY p.quantity ASC`,
      [threshold]
    );
    res.json({ threshold, count: rows.length, products: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get low stock products' });
  }
});

// GET /api/inventory/out-of-stock - admin: out of stock products
router.get('/out-of-stock', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.sku, p.quantity AS stock, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.quantity = 0
       ORDER BY p.name ASC`
    );
    res.json({ count: rows.length, products: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get out of stock products' });
  }
});

// PUT /api/inventory/:productId/stock - admin: update product stock
router.put('/:productId/stock', authenticateAdmin, async (req, res) => {
  try {
    const { stock, operation } = req.body;
    if (stock === undefined) return res.status(400).json({ message: 'stock is required' });
    const productId = req.params.productId;
    
    if (operation === 'add') {
      await pool.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [parseInt(stock), productId]);
    } else if (operation === 'subtract') {
      await pool.query('UPDATE products SET quantity = GREATEST(0, quantity - ?) WHERE id = ?', [parseInt(stock), productId]);
    } else {
      await pool.query('UPDATE products SET quantity = ? WHERE id = ?', [parseInt(stock), productId]);
    }
    
    const [[product]] = await pool.query('SELECT id, name, quantity AS stock FROM products WHERE id = ?', [productId]);
    res.json({ message: 'Stock updated', product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update stock' });
  }
});

// PUT /api/inventory/bulk-update - admin: bulk stock update
router.put('/bulk-update', authenticateAdmin, async (req, res) => {
  try {
    const { updates } = req.body; // [{ product_id, stock }]
    if (!updates || !Array.isArray(updates)) return res.status(400).json({ message: 'updates array required' });
    
    for (const { product_id, stock } of updates) {
      await pool.query('UPDATE products SET quantity = ? WHERE id = ?', [parseInt(stock), product_id]);
    }
    
    res.json({ message: `Updated stock for ${updates.length} products` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to bulk update stock' });
  }
});

module.exports = router;
