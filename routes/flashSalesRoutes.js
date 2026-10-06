const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { validateDateRange } = require('../utils/dateValidation');

let flashSalesSchemaPromise;

const ensureFlashSalesSchema = async () => {
  if (!flashSalesSchemaPromise) flashSalesSchemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS flash_sales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        campaign_id CHAR(36) DEFAULT NULL,
        name VARCHAR(255) DEFAULT NULL,
        product_id INT NOT NULL,
        discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        total_stock INT NOT NULL DEFAULT 0,
        sold_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const [column, definition] of [
      ['campaign_id', 'CHAR(36) DEFAULT NULL'],
      ['name', 'VARCHAR(255) DEFAULT NULL'],
      ['discount_percentage', 'DECIMAL(5,2) NOT NULL DEFAULT 0'],
    ]) {
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS column_exists FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        ['flash_sales', column]
      );
      if (!rows[0]?.column_exists) await pool.query(`ALTER TABLE flash_sales ADD COLUMN ${column} ${definition}`);
    }
  })().catch(error => {
    flashSalesSchemaPromise = null;
    throw error;
  });

  return flashSalesSchemaPromise;
};

const mysqlDate = date => date.toISOString().slice(0, 19).replace('T', ' ');

const invalidDateResponse = (res, result) => res.status(400).json({
  code: 'INVALID_DATE',
  field: result.field,
  message: result.message,
  userAction: 'Enter valid campaign start and end dates at least one hour apart.',
});

const getProducts = async (productIds) => {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(Number))];
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id < 1)) return null;
  const placeholders = ids.map(() => '?').join(',');
  const [products] = await pool.query(
    `SELECT id, name, quantity FROM products WHERE id IN (${placeholders})`,
    ids
  );
  return products.length === ids.length ? products : null;
};

const writeCampaignProducts = async (connection, campaignId, campaign, products, existingRows = []) => {
  const productIds = products.map(product => product.id);
  const placeholders = productIds.map(() => '?').join(',');
  if (existingRows.length) {
    await connection.query('UPDATE flash_sales SET campaign_id = ?, name = ? WHERE campaign_id IS NULL AND id = ?', [campaignId, campaign.name, existingRows[0].id]);
    await connection.query(`DELETE FROM flash_sales WHERE campaign_id = ? AND product_id NOT IN (${placeholders})`, [campaignId, ...productIds]);
  }

  for (const product of products) {
    const current = existingRows.find(row => Number(row.product_id) === Number(product.id));
    const values = [campaign.name, campaign.discount_percentage, mysqlDate(campaign.startDate), mysqlDate(campaign.endDate), campaign.isActive, Math.max(0, Number(product.quantity) || 0)];
    if (current) {
      await connection.query(
        'UPDATE flash_sales SET name = ?, discount_percentage = ?, start_time = ?, end_time = ?, is_active = ?, total_stock = GREATEST(sold_count, ?) WHERE id = ?',
        [...values, current.id]
      );
    } else {
      await connection.query(
        'INSERT INTO flash_sales (campaign_id, name, product_id, discount_percentage, start_time, end_time, is_active, total_stock, sold_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [campaignId, campaign.name, product.id, campaign.discount_percentage, mysqlDate(campaign.startDate), mysqlDate(campaign.endDate), campaign.isActive, Math.max(0, Number(product.quantity) || 0)]
      );
    }
  }
};

router.get('/admin', authenticateAdmin, async (req, res) => {
  try {
    await ensureFlashSalesSchema();
    const [rows] = await pool.query(`
      SELECT fs.*, p.name AS product_name
      FROM flash_sales fs
      LEFT JOIN products p ON p.id = fs.product_id
      ORDER BY fs.start_time DESC, fs.id DESC
    `);
    const campaigns = new Map();
    for (const row of rows) {
      const key = row.campaign_id || `legacy:${row.id}`;
      if (!campaigns.has(key)) campaigns.set(key, {
        id: row.campaign_id || row.id,
        name: row.name || row.product_name || `Campaign ${row.id}`,
        discount_percentage: row.discount_percentage,
        start_time: row.start_time,
        end_time: row.end_time,
        status: Number(row.is_active) ? 'active' : 'inactive',
        product_ids: [],
        products: [],
      });
      const campaign = campaigns.get(key);
      campaign.product_ids.push(row.product_id);
      campaign.products.push({ id: row.product_id, name: row.product_name });
    }
    res.json({ success: true, data: [...campaigns.values()] });
  } catch (error) {
    console.error('[FLASH_SALES_ADMIN_LIST]', error);
    res.status(500).json({ code: 'FLASH_SALES_LOAD_FAILED', message: 'Failed to load campaigns.' });
  }
});

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

router.post('/', authenticateAdmin, async (req, res) => {
  const dateRange = validateDateRange(req.body, 'start_time', 'end_time', { required: true, minDurationMs: 60 * 60 * 1000 });
  if (!dateRange.valid) return invalidDateResponse(res, dateRange);
  const name = String(req.body.name || '').trim();
  const discount = Number(req.body.discount_percentage);
  if (!name || !Number.isFinite(discount) || discount < 1 || discount > 99) {
    return res.status(400).json({ code: 'INVALID_CAMPAIGN', message: 'Campaign name and a discount from 1 to 99 are required.' });
  }
  try {
    await ensureFlashSalesSchema();
    const products = await getProducts(req.body.product_ids);
    if (!products) return res.status(400).json({ code: 'INVALID_PRODUCTS', message: 'Select one or more existing products.' });
    const campaignId = crypto.randomUUID();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await writeCampaignProducts(connection, campaignId, {
        name,
        discount_percentage: discount,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        isActive: req.body.status === 'inactive' ? 0 : 1,
      }, products);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    res.status(201).json({ success: true, id: campaignId, campaign_id: campaignId });
  } catch (error) {
    console.error('[FLASH_SALES_CREATE]', error);
    res.status(500).json({ code: 'FLASH_SALE_CREATE_FAILED', message: 'Failed to create campaign.' });
  }
});

router.put('/:id', authenticateAdmin, async (req, res) => {
  const dateRange = validateDateRange(req.body, 'start_time', 'end_time', { required: true, minDurationMs: 60 * 60 * 1000 });
  if (!dateRange.valid) return invalidDateResponse(res, dateRange);
  const name = String(req.body.name || '').trim();
  const discount = Number(req.body.discount_percentage);
  if (!name || !Number.isFinite(discount) || discount < 1 || discount > 99) {
    return res.status(400).json({ code: 'INVALID_CAMPAIGN', message: 'Campaign name and a discount from 1 to 99 are required.' });
  }
  try {
    await ensureFlashSalesSchema();
    const products = await getProducts(req.body.product_ids);
    if (!products) return res.status(400).json({ code: 'INVALID_PRODUCTS', message: 'Select one or more existing products.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.query(
        'SELECT id, campaign_id, product_id FROM flash_sales WHERE campaign_id = ? OR (campaign_id IS NULL AND id = ?) FOR UPDATE',
        [req.params.id, req.params.id]
      );
      if (!existingRows.length) {
        await connection.rollback();
        return res.status(404).json({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found.' });
      }
      const campaignId = existingRows[0].campaign_id || crypto.randomUUID();
      await writeCampaignProducts(connection, campaignId, {
        name,
        discount_percentage: discount,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        isActive: req.body.status === 'inactive' ? 0 : 1,
      }, products, existingRows);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    res.json({ success: true, id: req.params.id });
  } catch (error) {
    console.error('[FLASH_SALES_UPDATE]', error);
    res.status(500).json({ code: 'FLASH_SALE_UPDATE_FAILED', message: 'Failed to update campaign.' });
  }
});

router.patch('/:id/status', authenticateAdmin, async (req, res) => {
  if (!['active', 'inactive'].includes(req.body.status)) {
    return res.status(400).json({ code: 'INVALID_STATUS', message: 'Status must be active or inactive.' });
  }
  try {
    await ensureFlashSalesSchema();
    const [result] = await pool.query(
      'UPDATE flash_sales SET is_active = ? WHERE campaign_id = ? OR (campaign_id IS NULL AND id = ?)',
      [req.body.status === 'active' ? 1 : 0, req.params.id, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found.' });
    res.json({ success: true, status: req.body.status });
  } catch (error) {
    console.error('[FLASH_SALES_STATUS]', error);
    res.status(500).json({ code: 'FLASH_SALE_STATUS_FAILED', message: 'Failed to update campaign status.' });
  }
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await ensureFlashSalesSchema();
    const [result] = await pool.query(
      'DELETE FROM flash_sales WHERE campaign_id = ? OR (campaign_id IS NULL AND id = ?)',
      [req.params.id, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found.' });
    res.json({ success: true });
  } catch (error) {
    console.error('[FLASH_SALES_DELETE]', error);
    res.status(500).json({ code: 'FLASH_SALE_DELETE_FAILED', message: 'Failed to delete campaign.' });
  }
});

module.exports = router;
