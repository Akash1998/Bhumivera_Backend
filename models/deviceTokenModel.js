const pool = require('../config/db');

let tableReady = null;

const ensureDeviceTokensTable = async () => {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS user_device_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(255) NOT NULL,
        platform ENUM('android', 'ios', 'web') NOT NULL DEFAULT 'web',
        device_id VARCHAR(100) DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_token (token),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `).catch(err => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
};

const registerDeviceToken = async ({ userId, token, platform = 'web', deviceId = null }) => {
  await ensureDeviceTokensTable();
  const [result] = await pool.query(
    `INSERT INTO user_device_tokens (user_id, token, platform, device_id, is_active)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       platform = VALUES(platform),
       device_id = VALUES(device_id),
       is_active = 1,
       updated_at = NOW()`,
    [userId, token, platform, deviceId]
  );
  return result.affectedRows > 0;
};

const unregisterDeviceToken = async (token) => {
  await ensureDeviceTokensTable();
  const [result] = await pool.query(
    'UPDATE user_device_tokens SET is_active = 0 WHERE token = ?',
    [token]
  );
  return result.affectedRows > 0;
};

const getTokensForUser = async (userId) => {
  await ensureDeviceTokensTable();
  const [rows] = await pool.query(
    'SELECT token, platform FROM user_device_tokens WHERE user_id = ? AND is_active = 1',
    [userId]
  );
  return rows;
};

const getAllActiveTokens = async () => {
  await ensureDeviceTokensTable();
  const [rows] = await pool.query(
    'SELECT token FROM user_device_tokens WHERE is_active = 1'
  );
  return rows;
};

module.exports = {
  ensureDeviceTokensTable,
  registerDeviceToken,
  unregisterDeviceToken,
  getTokensForUser,
  getAllActiveTokens,
};
