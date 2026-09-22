const db = require('../config/db');

const ReturnModel = {
  createReturnRequest: async (returnRequest) => {
    const { order_id, user_id, reason, details, image_urls } = returnRequest;
    const [result] = await db.execute(
      `INSERT INTO returns (order_id, user_id, reason, details, image_urls, status) 
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [order_id, user_id, reason, details, JSON.stringify(image_urls)]
    );
    return result.insertId;
  },

  getReturnsByUser: async (userId) => {
    // Fixed: Changed o.order_number to o.id as order_number to match schem
    const [rows] = await db.execute(
      `SELECT r.*, o.id as order_number FROM returns r
       JOIN orders o ON r.order_id = o.id
       WHERE r.user_id = ? ORDER BY r.created_at DESC`,
      [userId]
    );
    return rows;
  },

  getAllReturns: async () => {
    const [rows] = await db.execute(
      `SELECT r.*, u.email as user_email, o.id as order_number 
       FROM returns r
       LEFT JOIN users u ON r.user_id = u.id
       JOIN orders o ON r.order_id = o.id
       ORDER BY r.created_at DESC`
    );
    return rows;
  },

  updateReturnStatus: async (id, status, adminNotes = null) => {
    const [result] = await db.execute(
      `UPDATE returns SET status = ?, admin_notes = ? WHERE id = ?`,
      [status, adminNotes, id]
    );
    return result.affectedRows > 0;
  }
};

module.exports = ReturnModel;
