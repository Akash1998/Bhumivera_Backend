const db = require('../config/db');
const pool = db.promise ? db : require('../config/db');

const initReturnsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS returns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      user_id INT NOT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      refund_type VARCHAR(30) NOT NULL DEFAULT 'refund',
      refund_method VARCHAR(30) DEFAULT NULL,
      items JSON DEFAULT NULL,
      image_urls JSON DEFAULT NULL,
      rma_number VARCHAR(40) DEFAULT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending_admin_review',
      admin_notes TEXT DEFAULT NULL,
      refund_amount DECIMAL(10,2) DEFAULT NULL,
      condition_grade VARCHAR(10) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_returns_user_created (user_id, created_at),
      INDEX idx_returns_order_user (order_id, user_id),
      INDEX idx_returns_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const columns = [
    ['reason', 'VARCHAR(255) DEFAULT NULL'],
    ['description', 'TEXT DEFAULT NULL'],
    ['refund_type', "VARCHAR(30) NOT NULL DEFAULT 'refund'"],
    ['refund_method', 'VARCHAR(30) DEFAULT NULL'],
    ['items', 'JSON DEFAULT NULL'],
    ['image_urls', 'JSON DEFAULT NULL'],
    ['rma_number', 'VARCHAR(40) DEFAULT NULL'],
    ['status', "VARCHAR(40) NOT NULL DEFAULT 'pending_admin_review'"],
    ['admin_notes', 'TEXT DEFAULT NULL'],
    ['refund_amount', 'DECIMAL(10,2) DEFAULT NULL'],
    ['condition_grade', 'VARCHAR(10) DEFAULT NULL'],
    ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  for (const [name, definition] of columns) {
    const [found] = await pool.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['returns', name]
    );
    if (!found.length) await pool.query(`ALTER TABLE returns ADD COLUMN \`${name}\` ${definition}`);
  }
  await pool.query("ALTER TABLE returns MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'pending_admin_review'");
  await pool.query("UPDATE returns SET status = 'pending_admin_review' WHERE status = 'pending'");
  await pool.query("UPDATE returns SET status = 'return_in_progress' WHERE status = 'approved'");
  await pool.query("UPDATE returns SET status = 'replacement_sent' WHERE status = 'exchanged'");
};

const createReturn = async (request = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query(
      'SELECT id, status FROM orders WHERE id = ? AND user_id = ? FOR UPDATE',
      [request.order_id, request.user_id]
    );
    if (!orders.length || orders[0].status !== 'delivered') {
      const error = new Error('Only your delivered orders can be submitted for return.');
      error.status = 400;
      throw error;
    }

    const [existing] = await conn.query(
      "SELECT id FROM returns WHERE order_id = ? AND user_id = ? AND status NOT IN ('rejected', 'cancelled') LIMIT 1 FOR UPDATE",
      [request.order_id, request.user_id]
    );
    if (existing.length) {
      const error = new Error('A return request for this order has already been submitted.');
      error.status = 409;
      error.returnId = existing[0].id;
      throw error;
    }

    const [result] = await conn.query(
      `INSERT INTO returns
        (order_id, user_id, reason, description, refund_type, refund_method, items, rma_number, image_urls, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_admin_review')`,
      [
        request.order_id,
        request.user_id,
        request.reason || null,
        request.description || null,
        request.refund_type || 'refund',
        request.refund_method || null,
        JSON.stringify(request.items || []),
        request.rma_number || null,
        JSON.stringify(request.image_urls || []),
      ]
    );
    await conn.commit();
    return result.insertId;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const getReturnsByUser = async userId => {
  const [rows] = await pool.execute(
    `SELECT r.*, o.id AS order_number, o.delivered_at
     FROM returns r JOIN orders o ON r.order_id = o.id
     WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows;
};

const getReturnById = async returnId => {
  const [rows] = await pool.execute('SELECT * FROM returns WHERE id = ?', [returnId]);
  return rows[0] || null;
};

const getReturnsByOrderAndUser = async (orderId, userId) => {
  const [rows] = await pool.execute(
    'SELECT * FROM returns WHERE order_id = ? AND user_id = ? LIMIT 1',
    [orderId, userId]
  );
  return rows[0] || null;
};

const getAllReturns = async statusFilter => {
  let sql = `SELECT r.*, u.email AS user_email, u.name AS customer_name, o.id AS order_number
             FROM returns r LEFT JOIN users u ON r.user_id = u.id
             JOIN orders o ON r.order_id = o.id`;
  const params = [];
  if (statusFilter) {
    sql += ' WHERE r.status = ?';
    params.push(statusFilter);
  }
  sql += ' ORDER BY r.created_at DESC';
  const [rows] = await pool.execute(sql, params);
  return rows;
};

const updateReturnStatus = async (id, status, adminNotes = null, refundAmount = null, conditionGrade = null) => {
  const [result] = await pool.execute(
    `UPDATE returns SET status = ?, admin_notes = ?, refund_amount = ?, condition_grade = ?
     WHERE id = ?`,
    [status, adminNotes, refundAmount, conditionGrade, id]
  );
  return result.affectedRows > 0;
};

module.exports = {
  initReturnsTable,
  createReturn,
  createReturnRequest: createReturn,
  getReturnsByUser,
  getReturnById,
  getReturnsByOrderAndUser,
  getAllReturns,
  updateReturnStatus,
};
