const pool = require('../config/db');

async function initContactTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,          -- Nullable in case a guest submits a ticket
      order_id INT NULL,         -- Nullable for general inquiries
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
      subject VARCHAR(200) NOT NULL,
      message TEXT NOT NULL,
      status ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
      admin_reply TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await pool.query(query);
    console.log("[DB] Support Tickets table ready.");
  } catch (error) {
    console.error("[DB] Error initializing support tickets table:", error);
    throw error;
  }
}

const ContactModel = {
  createTicket: async (data) => {
    const { user_id, order_id, name, email, subject, message } = data;
    const [result] = await pool.query(
      `INSERT INTO support_tickets (user_id, order_id, name, email, subject, message) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id || null, order_id || null, name, email, subject, message]
    );
    return result.insertId;
  },

  getTicketsByUser: async (userId) => {
    const [rows] = await pool.query(
      `SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },

  getAllTickets: async () => {
    const [rows] = await pool.query(
      `SELECT * FROM support_tickets ORDER BY 
       CASE status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, 
       created_at DESC`
    );
    return rows;
  },

  updateTicketStatus: async (id, status, adminReply = null) => {
    const [result] = await pool.query(
      `UPDATE support_tickets SET status = ?, admin_reply = ? WHERE id = ?`,
      [status, adminReply, id]
    );
    return result.affectedRows > 0;
  }
};

module.exports = {
  initContactTable,
  ContactModel
};
