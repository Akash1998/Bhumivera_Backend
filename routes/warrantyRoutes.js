const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { validateSerial, registerWarranty, getAllRegistrations, updatGenuiine_testStatus, deletGenuiine_test } = require('../models/warrantyModel');


router.get('/validate/:serial', async (req, res) => {
  try {
    const info = await validateSerial(req.params.serial);
    res.json({ success: true, ...info });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
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
      userId: req.user.id,
      customerName: req.body.customerName || req.body.user_name || user.name,
      email: req.body.email || req.body.user_email || user.email,
      phone: req.body.phone || req.body.user_phone || user.phone,
    };
    const result = await registerWarranty(payload);
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
