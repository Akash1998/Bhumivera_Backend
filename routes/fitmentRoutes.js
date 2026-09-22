const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// Configure Multer for pure in-memory processing (zero disk bloat)
const upload = multer({ storage: multer.memoryStorage() });

// 1. UPLOAD AND PARSE EXCEL EXPORT (Admin)
router.post('/upload/:productId', authenticateAdmin, upload.single('file'), async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) return res.status(400).json({ success: false, message: 'Invalid Product ID' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No Excel payload detected' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    const fitmentData = [];
    let isFirstRow = true;
    let colMap = { make: -1, model: -1, year: -1 };

    worksheet.eachRow((row, rowNumber) => {
      const rowValues = row.values; // 1-indexed array in exceljs
      
      // Dynamically map columns on the first row (Header immunity)
      if (isFirstRow) {
        for (let i = 1; i < rowValues.length; i++) {
          const header = String(rowValues[i] || '').toLowerCase().trim();
          if (header.includes('make') || header.includes('brand')) colMap.make = i;
          if (header.includes('model')) colMap.model = i;
          if (header.includes('year')) colMap.year = i;
        }
        isFirstRow = false;
        return;
      }

      const make = colMap.make !== -1 ? String(rowValues[colMap.make] || '').trim() : '';
      const model = colMap.model !== -1 ? String(rowValues[colMap.model] || '').trim() : '';
      const year = colMap.year !== -1 ? String(rowValues[colMap.year] || '').trim() : '';

      if (make && model) {
        fitmentData.push([productId, make, model, year]);
      }
    });

    if (fitmentData.length === 0) {
      return res.status(400).json({ success: false, message: 'No viable data. Ensure headers include "Make" and "Model".' });
    }

    // Transaction Protocol: Purge old fitments -> Bulk insert new array
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM product_fitments WHERE product_id = ?', [productId]);
      await connection.query(
        'INSERT INTO product_fitments (product_id, make, model, year_range) VALUES ?',
        [fitmentData]
      );
      await connection.commit();
      res.json({ success: true, message: `Successfully injected ${fitmentData.length} fitment profiles.` });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Excel Parsing Error:', error);
    res.status(500).json({ success: false, message: 'Failed to process Excel payload' });
  }
});

// 2. GET UNIQUE MAKES (Public)
router.get('/makes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT make FROM product_fitments ORDER BY make ASC');
    res.json({ success: true, data: rows.map(r => r.make) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// 3. GET MODELS BY MAKE (Public)
router.get('/models', async (req, res) => {
  try {
    const { make } = req.query;
    if (!make) return res.status(400).json({ success: false, message: 'Make parameter required' });
    const [rows] = await pool.query('SELECT DISTINCT model FROM product_fitments WHERE make = ? ORDER BY model ASC', [make]);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// 4. CHECK FITMENT MATCH (Public)
router.post('/check', async (req, res) => {
  try {
    const { productId, make, model, year } = req.body;
    if (!productId || !make || !model) {
      return res.status(400).json({ success: false, message: 'Product, Make, and Model required' });
    }

    let query = 'SELECT * FROM product_fitments WHERE product_id = ? AND make = ? AND model = ?';
    const params = [productId, make, model];

    if (year) {
      query += ' AND (year_range IS NULL OR year_range = "" OR year_range LIKE ?)';
      params.push(`%${year}%`);
    }

    const [rows] = await pool.query(query, params);
    
    if (rows.length > 0) {
      res.json({ fits: true, data: rows });
    } else {
      res.json({ fits: false, message: 'Not guaranteed to fit this specific vehicle configuration.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

module.exports = router;
