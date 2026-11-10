const pool = require('../config/db');

let tablePromise;
const createNewsletterTable = async () => {
  if (!tablePromise) tablePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      source VARCHAR(80) DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(error => { tablePromise = null; throw error; });
  return tablePromise;
};

const subscribeNewsletter = async (email, source = 'site') => {
  await createNewsletterTable();
  const [result] = await pool.query(
    `INSERT INTO newsletter_subscribers (email, source) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE is_active = 1, source = VALUES(source)`,
    [email, source]
  );
  return result.insertId || null;
};

module.exports = { createNewsletterTable, subscribeNewsletter };
