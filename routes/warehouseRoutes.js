const express = require('express');
const pool = require('../config/db');
const { authenticateUser } = require('../middleware/authMiddleware');
const router = express.Router();

const auth = authenticateUser;

// Download State to Browser
router.get('/state', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT app_state FROM warehouse_user_states WHERE user_id=?', [req.user.id]);
    if (rows.length > 0 && rows[0].app_state) {
      res.json({ success: true, state: JSON.parse(rows[0].app_state) });
    } else {
      res.json({ success: true, state: null });
    }
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Upload State from Browser
router.post('/sync', auth, async (req, res) => {
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

module.exports = router;
