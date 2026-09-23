const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { initWarrantyTable, validateSerial, registerWarranty, getAllRegistrations, updatGenuiine_testStatus, deletGenuiine_test } = require('../models/warrantyModel');

const ensureUserIdColumn = async () => {
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM warranty_registrations LIKE 'user_id'`);
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE warranty_registrations ADD COLUMN user_id INT NULL AFTER id`);
    }
  } catch (e) {}
};

router.use(async (req, res, next) => {
  try {
    await initWarrantyTable();
    await ensureUserIdColumn();
  } catch (e) {}
  next();
});

router.post('/validate', async (req, res) => {
  try {
    const info = await validateSerial(req.body.serial);
    res.json({ success: true, info });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/register', authenticateUser, async (req, res) => {
  try {
    const user = (await pool.query('SELECT name, email, phone FROM users WHERE id = ?', [req.user.id]))[0][0] || {};
    const payload = {
      ...req.body,
      customerName: req.body.customerName || req.body.user_name || user.name,
      email: req.body.email || req.body.user_email || user.email,
      phone: req.body.phone || req.body.user_phone || user.phone,
    };
    const result = await registerWarranty(payload);
    try {
      const [[reg]] = await pool.query('SELECT id FROM warranty_registrations ORDER BY id DESC LIMIT 1');
      if (reg) {
        await pool.query('UPDATE warranty_registrations SET user_id = ? WHERE id = ?', [req.user.id, reg.id]);
      }
    } catch (_) {}
    res.status(201).json({ success: true, message: 'Warranty registered successfully', ...result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/my', authenticateUser, async (req, res) => {
  try {
    let rows = [];
    try {
      [rows] = await pool.query(
        `SELECT wr.*, p.name AS product_name,
                COALESCE(p.image_url, p.image, '') AS product_image
         FROM warranty_registrations wr
         LEFT JOIN products p ON wr.product_id = p.id
         WHERE wr.user_id = ? OR wr.user_email = (SELECT email FROM users WHERE id = ?)
         ORDER BY wr.registered_at DESC`,
        [req.user.id, req.user.id]
      );
    } catch (queryErr) {
      if (queryErr.code === 'ER_BAD_FIELD_ERROR' || queryErr.code === 'ER_BAD_TABLE_ERROR') {
        console.warn('[Warranty /my] Falling back to column-safe SELECT:', queryErr.message);
        [rows] = await pool.query(
          `SELECT wr.*
           FROM warranty_registrations wr
           WHERE wr.user_id = ? OR wr.user_email = (SELECT email FROM users WHERE id = ?)
           ORDER BY wr.registered_at DESC`,
          [req.user.id, req.user.id]
        );
      } else {
        throw queryErr;
      }
    }
    res.json(rows || []);
  } catch (err) {
    console.error('[Warranty /my Error]:', err);
    res.status(500).json({ message: 'Failed to load warranties' });
  }
});

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const rows = await getAllRegistrations();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load registrations' });
  }
});

router.patch('/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await updatGenuiine_testStatus(req.params.id, req.body.status);
    res.json({ message: 'Status updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update status' });
  }
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await deletGenuiine_test(req.params.id);
    res.json({ message: 'Registration deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete' });
  }
});

module.exports = router;
