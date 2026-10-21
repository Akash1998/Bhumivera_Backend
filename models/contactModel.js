const pool = require('../config/db');

async function initContactTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,          -- Nullable in case a guest submits a ticket
      order_id INT NULL,         -- Nullable for general inquiries
      product_id INT NULL,
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
    const [productColumn] = await pool.query("SHOW COLUMNS FROM support_tickets LIKE 'product_id'");
    if (!productColumn.length) {
      await pool.query('ALTER TABLE support_tickets ADD COLUMN product_id INT NULL');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        sender_type ENUM('customer', 'admin') NOT NULL,
        sender_user_id INT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        legacy_ticket_id INT NULL UNIQUE,
        INDEX idx_support_messages_ticket_created (ticket_id, created_at),
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      INSERT IGNORE INTO support_ticket_messages
        (ticket_id, sender_type, message, created_at, legacy_ticket_id)
      SELECT id, 'admin', admin_reply, updated_at, id
      FROM support_tickets
      WHERE admin_reply IS NOT NULL AND TRIM(admin_reply) <> ''
    `);
    console.log("[DB] Support Tickets table ready.");
  } catch (error) {
    console.error("[DB] Error initializing support tickets table:", error);
    throw error;
  }
}

const ContactModel = {
  createTicket: async (data) => {
    const { user_id, order_id, product_id, name, email, subject, message } = data;
    const [result] = await pool.query(
      `INSERT INTO support_tickets (user_id, order_id, product_id, name, email, subject, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user_id || null, order_id || null, product_id || null, name, email, subject, message]
    );
    return result.insertId;
  },

  getTicketsByUser: async (userId) => {
    const [rows] = await pool.query(
      `SELECT t.*, p.name AS product_name
       FROM support_tickets t
       LEFT JOIN products p ON p.id = t.product_id
       WHERE t.user_id = ? ORDER BY t.created_at DESC`,
      [userId]
    );
    return rows;
  },

  getAllTickets: async () => {
    const [rows] = await pool.query(
      `SELECT t.*, p.name AS product_name FROM support_tickets t
       LEFT JOIN products p ON p.id = t.product_id ORDER BY
       CASE t.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
       t.created_at DESC`
    );
    return rows;
  },

  getMessagesByTicketIds: async (ticketIds) => {
    if (!ticketIds.length) return [];
    const placeholders = ticketIds.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT id, ticket_id, sender_type, sender_user_id, message, created_at
       FROM support_ticket_messages
       WHERE ticket_id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
      ticketIds
    );
    return rows;
  },

  createCustomerReply: async (ticketId, userId, message) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[ticket]] = await connection.query(
        `SELECT id FROM support_tickets WHERE id = ? AND user_id = ? FOR UPDATE`,
        [ticketId, userId]
      );
      if (!ticket) {
        await connection.rollback();
        return false;
      }
      await connection.query(
        `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_user_id, message)
         VALUES (?, 'customer', ?, ?)`,
        [ticketId, userId, message]
      );
      await connection.query(
        `UPDATE support_tickets SET status = 'open' WHERE id = ?`,
        [ticketId]
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  updateTicketStatus: async (id, status, adminReply = null) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[ticket]] = await connection.query(
        `SELECT id FROM support_tickets WHERE id = ? FOR UPDATE`,
        [id]
      );
      if (!ticket) {
        await connection.rollback();
        return false;
      }
      await connection.query(
        `UPDATE support_tickets SET status = ?, admin_reply = COALESCE(?, admin_reply) WHERE id = ?`,
        [status, adminReply, id]
      );
      if (adminReply) {
        await connection.query(
          `INSERT INTO support_ticket_messages (ticket_id, sender_type, message)
           VALUES (?, 'admin', ?)`,
          [id, adminReply]
        );
      }
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
};

module.exports = {
  initContactTable,
  ContactModel
};
