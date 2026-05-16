const pool = require('../config/db');

const createNotificationTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT DEFAULT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'system',
      is_read TINYINT(1) DEFAULT 0,
      is_global TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Architect Note: Silent upgrade for existing table from ENUM to VARCHAR to support expansive telemetry (SQL Errors, F12 Crashes)
  try {
    await pool.query(`ALTER TABLE notifications MODIFY COLUMN type VARCHAR(50) DEFAULT 'system'`);
  } catch (err) {
    // Ignore if table was already altered in a previous deployment
  }
};

// Admin: create notification for specific user or all users (global)
const createNotification = async (data) => {
  const { user_id, title, message, type, is_global } = data;
  const [result] = await pool.query(
    'INSERT INTO notifications (user_id, title, message, type, is_global) VALUES (?, ?, ?, ?, ?)',
    [user_id || null, title, message, type || 'system', is_global ? 1 : 0]
  );
  return result.insertId;
};

// System: Log core errors, SQL failures, and F12 browser crashes directly
const logSystemEvent = async (title, message, type = 'error') => {
  const [result] = await pool.query(
    'INSERT INTO notifications (title, message, type, is_global) VALUES (?, ?, ?, 1)',
    [title, message, type]
  );
  return result.insertId;
};

// Get notifications for a user (own + global)
const getNotificationsForUser = async (userId) => {
  const [rows] = await pool.query(
    `SELECT * FROM notifications
     WHERE (user_id = ? OR is_global = 1)
     ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return rows;
};

// Mark notification(s) as read
const markAsRead = async (userId, notifId = null) => {
  if (notifId) {
    // Modified: Allows users/admins to acknowledge global system alerts (where user_id IS NULL)
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)', [notifId, userId]);
  } else {
    // Modified: Mark all personal AND global alerts as read
    await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ? OR user_id IS NULL', [userId]);
  }
};

// Count unread for user
const countUnread = async (userId) => {
  const [rows] = await pool.query(
    `SELECT COUNT(*) as count FROM notifications WHERE (user_id = ? OR is_global = 1) AND is_read = 0`,
    [userId]
  );
  return rows[0].count;
};

// Admin: get all notifications (The Heartbeat Telemetry)
const getAllNotifications = async () => {
  const [rows] = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
  return rows;
};

// Admin: delete notification
const deleteNotification = async (id) => {
  await pool.query('DELETE FROM notifications WHERE id = ?', [id]);
};

module.exports = { 
  createNotificationTable, 
  createNotification, 
  logSystemEvent,
  getNotificationsForUser, 
  markAsRead, 
  countUnread, 
  getAllNotifications, 
  deleteNotification 
};
