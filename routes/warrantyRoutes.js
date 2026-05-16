const express = require('express');
const pool = require('../config/db');
const { authenticateUser } = require('../middleware/authMiddleware');
const router = express.Router();

// Apply standard user authentication
const auth = authenticateUser;

const fetchStateLogic = async (req, res) => {
  try {
    const uid = req.user.id;
    const [inv] = await pool.query('SELECT * FROM warehouse_inventory WHERE user_id=?', [uid]);
    const [cust] = await pool.query('SELECT * FROM warehouse_customers WHERE user_id=?', [uid]);
    const [sales] = await pool.query('SELECT * FROM warehouse_sales WHERE user_id=?', [uid]);
    const [state] = await pool.query('SELECT * FROM warehouse_cloud_state WHERE user_id=?', [uid]);

    // Format DB rows back into the exact JSON structure your frontend expects
    const avState = {
      i: inv.map(x => ({ id: x.id, name: x.name, cat: x.category, qty: x.quantity, price: parseFloat(x.sell_price), dateAdded: x.date_added, soldQty: x.sold_qty })),
      c: cust.map(x => ({ id: x.id, name: x.name, phone: x.phone, loc: x.loc, type: x.type, wallet: parseFloat(x.wallet) })),
      s: sales.map(x => JSON.parse(x.sale_json)),
      l: state.length > 0 && state[0].logs_json ? JSON.parse(state[0].logs_json) : [],
      p: state.length > 0 && state[0].proofs_json ? JSON.parse(state[0].proofs_json) : [],
      cfg: state.length > 0 && state[0].cfg_json ? JSON.parse(state[0].cfg_json) : { cats: ['General'], hid: [], auth: {} }
    };

    res.json({ success: true, state: avState });
  } catch(e) { res.status(500).json({ message: e.message }); }
};

// GET: Fetch the user's entire warehouse state on login
router.get('/state', auth, fetchStateLogic);
router.get('/', auth, fetchStateLogic); // FIXED: Aliased to prevent 404
router.get('/serials', auth, async (req, res) => res.json({ success: true, data: [] })); // FIXED: Graceful fail for serial fetch

// POST: Sync the frontend state to the relational database
router.post('/sync', auth, async (req, res) => {
  const uid = req.user.id;
  const { i, c, s, p, l, cfg } = req.body;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Sync Inventory (Upsert)
    if (i && i.length) {
      const invIds = i.map(item => item.id);
      if(invIds.length > 0) {
        await conn.query(`DELETE FROM warehouse_inventory WHERE user_id = ? AND id NOT IN (?)`, [uid, invIds]);
      }
      for (const item of i) {
        await conn.query(`
          INSERT INTO warehouse_inventory (id, user_id, name, category, quantity, sell_price, date_added, sold_qty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), quantity=VALUES(quantity), sell_price=VALUES(sell_price), sold_qty=VALUES(sold_qty)
        `, [item.id, uid, item.name, item.cat, item.qty, item.price, new Date(item.dateAdded), item.soldQty || 0]);
      }
    } else {
        await conn.query(`DELETE FROM warehouse_inventory WHERE user_id = ?`, [uid]);
    }

    // 2. Sync Customers (Upsert)
    if (c && c.length) {
      const custIds = c.map(cust => cust.id);
      if(custIds.length > 0) {
        await conn.query(`DELETE FROM warehouse_customers WHERE user_id = ? AND id NOT IN (?)`, [uid, custIds]);
      }
      for (const cust of c) {
        await conn.query(`
          INSERT INTO warehouse_customers (id, user_id, name, phone, loc, type, wallet)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), loc=VALUES(loc), type=VALUES(type), wallet=VALUES(wallet)
        `, [cust.id, uid, cust.name, cust.phone, cust.loc, cust.type, cust.wallet]);
      }
    } else {
        await conn.query(`DELETE FROM warehouse_customers WHERE user_id = ?`, [uid]);
    }

    // 3. Sync Sales (Upsert)
    if (s && s.length) {
      const saleIds = s.map(sale => sale.id);
      if(saleIds.length > 0) {
        await conn.query(`DELETE FROM warehouse_sales WHERE user_id = ? AND id NOT IN (?)`, [uid, saleIds]);
      }
      for (const sale of s) {
        await conn.query(`
          INSERT INTO warehouse_sales (id, user_id, date, customer_id, total, paid, sale_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE sale_json=VALUES(sale_json)
        `, [sale.id, uid, new Date(sale.date), sale.cust.id, sale.billTotal || sale.total, sale.paid || 0, JSON.stringify(sale)]);
      }
    } else {
        await conn.query(`DELETE FROM warehouse_sales WHERE user_id = ?`, [uid]);
    }

    // 4. Sync Settings & Media
    await conn.query(`
      INSERT INTO warehouse_cloud_state (user_id, logs_json, proofs_json, cfg_json)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE logs_json=VALUES(logs_json), proofs_json=VALUES(proofs_json), cfg_json=VALUES(cfg_json)
    `, [uid, JSON.stringify(l), JSON.stringify(p), JSON.stringify(cfg)]);

    await conn.commit();
    res.json({ success: true });
  } catch(err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
