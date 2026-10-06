const db = require('../config/db');
const pool = db.promise ? db : require('../config/db');

const createReturn = async (returnRequest = {}) => {
  const {
    order_id,
    user_id,
    reason,
    description,
    refund_type,
    items = [],
    rma_number,
    image_urls
  } = returnRequest;
  const safeItems = Array.isArray(items) ? items : [];
  const [result] = await pool.execute(
    `INSERT INTO returns (order_id, user_id, reason, description, refund_type, items, rma_number, image_urls, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      order_id,
      user_id,
      reason || null,
      description || null,
      refund_type || 'refund',
      JSON.stringify(safeItems),
      rma_number || null,
      image_urls ? JSON.stringify(image_urls) : null
    ]
  );
  return result.insertId;
};

const getReturnsByUser = async (userId) => {
  const [rows] = await pool.execute(
    `SELECT r.*, o.id as order_number FROM returns r
     JOIN orders o ON r.order_id = o.id
     WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows;
};

const getReturnById = async (returnId) => {
  const [rows] = await pool.execute('SELECT * FROM returns WHERE id = ?', [returnId]);
  return rows && rows.length > 0 ? rows[0] : null;
};

const getReturnsByOrderAndUser = async (orderId, userId) => {
  const [rows] = await pool.execute(
    'SELECT * FROM returns WHERE order_id = ? AND user_id = ? LIMIT 1',
    [orderId, userId]
  );
  return rows && rows.length > 0 ? rows[0] : null;
};

const getAllReturns = async (statusFilter = null) => {
  let sql = `SELECT r.*, u.email as user_email, o.id as order_number
             FROM returns r
             LEFT JOIN users u ON r.user_id = u.id
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

const updateReturnStatus = async (id, status, adminNotes = null, refundAmount = null) => {
  const [result] = await pool.execute(
    `UPDATE returns SET status = ?, admin_notes = ?, refund_amount = ? WHERE id = ?`,
    [status, adminNotes, refundAmount, id]
  );
  return result.affectedRows > 0;
};

module.exports = {
  createReturn,
  createReturnRequest: createReturn,
  getReturnsByUser,
  getReturnById,
  getReturnsByOrderAndUser,
  getAllReturns,
  updateReturnStatus
};
