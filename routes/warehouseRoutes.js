const express = require('express');
const path = require('path');
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const router = express.Router();

// Auth middleware for all API routes
const auth = authenticateAdmin;

// GET /api/warehouse/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const [items] = await pool.query('SELECT COUNT(*) as totalItems, SUM(quantity*cost_price) as totalValue, SUM(CASE WHEN quantity<=min_stock THEN 1 ELSE 0 END) as lowStock FROM warehouse_inventory');
    const [sales] = await pool.query('SELECT COALESCE(SUM(total),0) as todaySales FROM warehouse_sales WHERE DATE(created_at)=CURDATE()');
    res.json({ ...items[0], todaySales: sales[0].todaySales });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// GET /api/warehouse/inventory
router.get('/inventory', auth, async (req, res) => {
  try {
    const [items] = await pool.query('SELECT * FROM warehouse_inventory ORDER BY name');
    res.json({ items });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// POST /api/warehouse/inventory
router.post('/inventory', auth, async (req, res) => {
  try {
    const { name, category, sku, unit, quantity, cost_price, sell_price, min_stock, location, description } = req.body;
    const [r] = await pool.query('INSERT INTO warehouse_inventory (name,category,sku,unit,quantity,cost_price,sell_price,min_stock,location,description) VALUES (?,?,?,?,?,?,?,?,?,?)', [name,category,sku,unit||'pcs',quantity||0,cost_price||0,sell_price||0,min_stock||0,location,description]);
    await pool.query('INSERT INTO warehouse_logs (action,entity,entity_id,admin_id,details) VALUES (?,?,?,?,?)', ['ADD_ITEM','inventory',r.insertId,req.admin?.id,'Added: '+name]);
    res.json({ id: r.insertId });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// PUT /api/warehouse/inventory/:id
router.put('/inventory/:id', auth, async (req, res) => {
  try {
    const { name, category, sku, unit, cost_price, sell_price, min_stock, location, description } = req.body;
    await pool.query('UPDATE warehouse_inventory SET name=?,category=?,sku=?,unit=?,cost_price=?,sell_price=?,min_stock=?,location=?,description=? WHERE id=?', [name,category,sku,unit,cost_price,sell_price,min_stock,location,description,req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// DELETE /api/warehouse/inventory/:id
router.delete('/inventory/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM warehouse_inventory WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// POST /api/warehouse/inventory/:id/adjust
router.post('/inventory/:id/adjust', auth, async (req, res) => {
  try {
    const { type, quantity, reason, notes } = req.body;
    let sql = 'UPDATE warehouse_inventory SET quantity=quantity+? WHERE id=?';
    let val = quantity;
    if (type === 'remove') val = -quantity;
    if (type === 'set') sql = 'UPDATE warehouse_inventory SET quantity=? WHERE id=?';
    await pool.query(sql, [val, req.params.id]);
    await pool.query('INSERT INTO warehouse_logs (action,entity,entity_id,admin_id,details) VALUES (?,?,?,?,?)', ['STOCK_ADJ','inventory',req.params.id,req.admin?.id,`${type} ${quantity} - ${reason}: ${notes}`]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// GET /api/warehouse/customers
router.get('/customers', auth, async (req, res) => {
  try {
    const [customers] = await pool.query('SELECT * FROM warehouse_customers ORDER BY name');
    res.json({ customers });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// POST /api/warehouse/customers
router.post('/customers', auth, async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;
    const [r] = await pool.query('INSERT INTO warehouse_customers (name,phone,email,notes) VALUES (?,?,?,?)', [name,phone,email,notes]);
    res.json({ id: r.insertId });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// DELETE /api/warehouse/customers/:id
router.delete('/customers/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM warehouse_customers WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// POST /api/warehouse/sales
router.post('/sales', auth, async (req, res) => {
  try {
    const { items, discount, customer_id } = req.body;
    let total = items.reduce((s,i)=>s+(i.qty*i.price),0) - (discount||0);
    const [s] = await pool.query('INSERT INTO warehouse_sales (customer_id,total,discount,admin_id) VALUES (?,?,?,?)', [customer_id||null,total,discount||0,req.admin?.id]);
    for (const item of items) {
      await pool.query('INSERT INTO warehouse_sale_items (sale_id,item_id,quantity,price) VALUES (?,?,?,?)', [s.insertId,item.id,item.qty,item.price]);
      await pool.query('UPDATE warehouse_inventory SET quantity=quantity-? WHERE id=?', [item.qty,item.id]);
    }
    await pool.query('INSERT INTO warehouse_logs (action,entity,entity_id,admin_id,details) VALUES (?,?,?,?,?)', ['SALE','sales',s.insertId,req.admin?.id,'Total: '+total]);
    res.json({ id: s.insertId, total });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// GET /api/warehouse/logs
router.get('/logs', auth, async (req, res) => {
  try {
    const [logs] = await pool.query('SELECT l.*,a.email as admin_email FROM warehouse_logs l LEFT JOIN admin_users a ON l.admin_id=a.id ORDER BY l.created_at DESC LIMIT 200');
    res.json({ logs });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// GET /api/warehouse/export/:type
router.get('/export/:type', auth, async (req, res) => {
  try {
    let data = [], fields = [];
    if (req.params.type === 'inventory') {
      [data] = await pool.query('SELECT * FROM warehouse_inventory');
      fields = ['id','name','category','sku','unit','quantity','cost_price','sell_price','min_stock','location'];
    } else if (req.params.type === 'customers') {
      [data] = await pool.query('SELECT * FROM warehouse_customers');
      fields = ['id','name','phone','email','balance','notes'];
    }
    const csv = [fields.join(','), ...data.map(r=>fields.map(f=>JSON.stringify(r[f]||'')).join(','))].join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename=${req.params.type}.csv`);
    res.send(csv);
  } catch(e) { res.status(500).json({ message: e.message }); }
});

module.exports = router;
