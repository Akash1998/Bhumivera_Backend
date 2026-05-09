const express = require('express');
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin, isWarehouseAdmin } = require('../middleware/authMiddleware');
const router = express.Router();

// Aliases for readability
const auth = authenticateUser;
const adminAuth = authenticateAdmin;

// ── USER ROUTES ──────────────────────────────────────────────────────────────────────

/**
 * Check if current user has warehouse access
 * Updated to grant 'admin' the same bypass privileges as 'superadmin'
 */
router.get('/check-access', auth, isWarehouseAdmin, async (req, res) => {
  try {
    // FIX: Added 'admin' alongside 'superadmin' for master clearance
    if (req.user.role === 'superadmin' || req.user.role === 'admin') {
      return res.json({ 
        success: true, 
        hasAccess: true, 
        isAdmin: true, 
        storeName: 'Master Admin Access' 
      });
    }

    const [rows] = await pool.query(
      'SELECT is_active, store_name FROM warehouse_access WHERE user_id = ?',
      [req.user.id]
    );

    const hasAccess = rows.length > 0 && rows[0].is_active === 1;
    
    res.json({ 
      success: true, 
      hasAccess, 
      isAdmin: false,
      storeName: hasAccess ? rows[0].store_name : null 
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Download State to Browser (requires warehouse access)
router.get('/state', auth, isWarehouseAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT app_state FROM warehouse_user_states WHERE user_id=?', [req.user.id]);
    if (rows.length > 0 && rows[0].app_state) {
      res.json({ success: true, state: JSON.parse(rows[0].app_state) });
    } else {
      res.json({ success: true, state: null });
    }
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Upload State from Browser (requires warehouse access)
router.post('/sync', auth, isWarehouseAdmin, async (req, res) => {
  try {
    const stateStr = JSON.stringify(req.body);
    await pool.query(`
      INSERT INTO warehouse_user_states (user_id, app_state)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE app_state=VALUES(app_state)
    `, [req.user.id, stateStr]);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Log a sale (called from warehouse app)
router.post('/log-sale', auth, isWarehouseAdmin, async (req, res) => {
  try {
    const { product_name, quantity, sale_price } = req.body;
    if (!product_name) return res.status(400).json({ message: 'product_name required' });

    // For admins/superadmins, we use the master label if they aren't in the access table
    let store_name = 'Master Admin Access';
    
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
      const [access] = await pool.query('SELECT store_name FROM warehouse_access WHERE user_id=?', [req.user.id]);
      store_name = access.length > 0 ? access[0].store_name : 'Unknown';
    }

    await pool.query(
      'INSERT INTO warehouse_sales_log (user_id, store_name, product_name, quantity, sale_price) VALUES (?,?,?,?,?)',
      [req.user.id, store_name, product_name, quantity || 1, sale_price || 0]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ROUTES (superadmin/admin via adminAuth) ───────────────────────────────────

// Get all users with warehouse access
router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT wa.id, wa.user_id, u.name, u.email, wa.store_name, wa.is_active, wa.granted_at,
        (SELECT COUNT(*) FROM warehouse_sales_log wsl WHERE wsl.user_id = wa.user_id) as total_sales
      FROM warehouse_access wa
      JOIN users u ON u.id = wa.user_id
      ORDER BY wa.granted_at DESC
    `);
    res.json({ success: true, users: rows });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Get all users (for grant access dropdown)
router.get('/admin/all-users', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.name, u.email,
        CASE WHEN wa.user_id IS NOT NULL AND wa.is_active=1 THEN 1 ELSE 0 END as has_access
      FROM users u
      LEFT JOIN warehouse_access wa ON wa.user_id = u.id
      WHERE u.role NOT IN ('admin', 'superadmin') OR u.role IS NULL
      ORDER BY u.name ASC
    `);
    res.json({ success: true, users: rows });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Grant warehouse access to a user
router.post('/admin/grant-access', adminAuth, async (req, res) => {
  try {
    const { user_id, store_name } = req.body;
    if (!user_id) return res.status(400).json({ message: 'user_id required' });
    
    // Check if performing user is admin or superadmin from adminAuth
    const grantorId = req.admin ? req.admin.id : req.user.id;

    await pool.query(`
      INSERT INTO warehouse_access (user_id, granted_by, store_name, is_active)
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE is_active=1, store_name=VALUES(store_name), granted_by=VALUES(granted_by)
    `, [user_id, grantorId, store_name || null]);
    res.json({ success: true, message: 'Warehouse access granted' });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Revoke warehouse access from a user
router.post('/admin/revoke-access', adminAuth, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ message: 'user_id required' });
    await pool.query('UPDATE warehouse_access SET is_active=0 WHERE user_id=?', [user_id]);
    res.json({ success: true, message: 'Warehouse access revoked' });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Update store name
router.post('/admin/update-store', adminAuth, async (req, res) => {
  try {
    const { user_id, store_name } = req.body;
    if (!user_id) return res.status(400).json({ message: 'user_id required' });
    await pool.query('UPDATE warehouse_access SET store_name=? WHERE user_id=?', [store_name, user_id]);
    res.json({ success: true, message: 'Store name updated' });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Get sales overview
router.get('/admin/sales', adminAuth, async (req, res) => {
  try {
    const { date, store_user_id } = req.query;
    let baseQuery = `SELECT wsl.id, wsl.user_id, u.name as distributor_name, wsl.store_name,
      wsl.product_name, wsl.quantity, wsl.sale_price,
      (wsl.quantity * wsl.sale_price) as total_value, wsl.sold_at
      FROM warehouse_sales_log wsl JOIN users u ON u.id = wsl.user_id WHERE 1=1`;
    const params = [];
    if (date) { baseQuery += ' AND DATE(wsl.sold_at) = ?'; params.push(date); }
    if (store_user_id) { baseQuery += ' AND wsl.user_id = ?'; params.push(store_user_id); }
    baseQuery += ' ORDER BY wsl.sold_at DESC';
    const [rows] = await pool.query(baseQuery, params);
    res.json({ success: true, sales: rows });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Get sales summary per product grouped
router.get('/admin/sales-summary', adminAuth, async (req, res) => {
  try {
    const { date, store_user_id } = req.query;
    let q = `SELECT product_name, store_name, SUM(quantity) as total_qty,
      SUM(quantity * sale_price) as total_revenue, COUNT(*) as transactions
      FROM warehouse_sales_log WHERE 1=1`;
    const params = [];
    if (date) { q += ' AND DATE(sold_at) = ?'; params.push(date); }
    if (store_user_id) { q += ' AND user_id = ?'; params.push(store_user_id); }
    q += ' GROUP BY product_name, store_name ORDER BY total_qty DESC';
    const [rows] = await pool.query(q, params);
    res.json({ success: true, summary: rows });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// Get daily totals for chart (last 30 days)
router.get('/admin/sales-daily', adminAuth, async (req, res) => {
  try {
    const { store_user_id } = req.query;
    let q = `SELECT DATE(sold_at) as date, SUM(quantity) as total_qty,
      SUM(quantity * sale_price) as total_revenue
      FROM warehouse_sales_log WHERE sold_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    const params = [];
    if (store_user_id) { q += ' AND user_id = ?'; params.push(store_user_id); }
    q += ' GROUP BY DATE(sold_at) ORDER BY date ASC';
    const [rows] = await pool.query(q, params);
    res.json({ success: true, daily: rows });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// View individual distributor's warehouse state
router.get('/admin/user-state/:userId', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT app_state, updated_at FROM warehouse_user_states WHERE user_id=?',
      [req.params.userId]
    );
    if (rows.length > 0 && rows[0].app_state) {
      res.json({ success: true, state: JSON.parse(rows[0].app_state), updated_at: rows[0].updated_at });
    } else {
      res.json({ success: true, state: null });
    }
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
