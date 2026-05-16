// backend-Bhumivera/routes/taxRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// FIXED: Database Auto-Init interceptor to prevent 500 crashes
const ensureTaxTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tax_rates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        rate DECIMAL(5,2) NOT NULL,
        region VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.warn("Tax DB intercept warning:", e.message);
  }
};

router.get('/', async (req, res) => {
  try {
    await ensureTaxTable();
    const [rates] = await pool.query('SELECT * FROM tax_rates ORDER BY id DESC');
    res.json(rates);
  } catch (err) {
    // Fallback empty array if table doesn't exist yet
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    res.status(500).json({ message: 'Failed to get tax rates', error: err.message });
  }
});

// POST create a new tax rate
router.post('/', async (req, res) => {
  try {
    await ensureTaxTable();
    const { name, rate, region, is_active } = req.body;
    const [result] = await pool.query(
      'INSERT INTO tax_rates (name, rate, region, is_active) VALUES (?, ?, ?, ?)',
      [name, rate, region, is_active !== undefined ? is_active : true]
    );
    res.status(201).json({ message: 'Tax rule created', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create tax rule', error: err.message });
  }
});

// PUT update a tax rate
router.put('/:id', async (req, res) => {
  try {
    const { name, rate, region, is_active } = req.body;
    await pool.query(
      'UPDATE tax_rates SET name = ?, rate = ?, region = ?, is_active = ? WHERE id = ?',
      [name, rate, region, is_active, req.params.id]
    );
    res.json({ message: 'Tax rule updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update tax rule', error: err.message });
  }
});

// DELETE a tax rate
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tax_rates WHERE id = ?', [req.params.id]);
    res.json({ message: 'Tax rule deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete tax rule', error: err.message });
  }
});

module.exports = router;
