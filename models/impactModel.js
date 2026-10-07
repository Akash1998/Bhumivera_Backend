const pool = require('../config/db');

const initImpactTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS impact_contributions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL UNIQUE,
      user_id INT NOT NULL,
      project_key VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      status ENUM('pledged', 'collected', 'cancelled') NOT NULL DEFAULT 'pledged',
      collection_reference VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      collected_at DATETIME DEFAULT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_impact_project_status (project_key, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS impact_updates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_key VARCHAR(50) NOT NULL,
      title VARCHAR(180) NOT NULL,
      summary TEXT NOT NULL,
      field_date DATE DEFAULT NULL,
      photo_url VARCHAR(1000) DEFAULT NULL,
      video_url VARCHAR(1000) DEFAULT NULL,
      verified_by INT DEFAULT NULL,
      verified_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_impact_updates_project_date (project_key, field_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

const getPublicImpact = async () => {
  const [totals] = await pool.query(`
    SELECT project_key, COUNT(*) AS contributions, COALESCE(SUM(amount), 0) AS collected_amount
    FROM impact_contributions
    WHERE status = 'collected'
    GROUP BY project_key
  `);
  const [updates] = await pool.query(`
    SELECT id, project_key, title, summary, field_date, photo_url, video_url, verified_at
    FROM impact_updates
    WHERE verified_at IS NOT NULL
    ORDER BY COALESCE(field_date, DATE(verified_at)) DESC, id DESC
  `);
  return { totals, updates };
};

const getAllContributions = async () => {
  const [rows] = await pool.query(`
    SELECT ic.*, o.status AS order_status, o.payment_mode, u.name AS customer_name,
           u.email AS customer_email
    FROM impact_contributions ic
    JOIN orders o ON o.id = ic.order_id
    JOIN users u ON u.id = ic.user_id
    ORDER BY ic.created_at DESC
  `);
  return rows;
};

const getAllImpactUpdates = async () => {
  const [rows] = await pool.query(`
    SELECT id, project_key, title, summary, field_date, photo_url, video_url, verified_by, verified_at, created_at
    FROM impact_updates
    ORDER BY created_at DESC
  `);
  return rows;
};

module.exports = { initImpactTables, getPublicImpact, getAllContributions, getAllImpactUpdates };