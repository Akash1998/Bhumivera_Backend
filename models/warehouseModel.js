const pool = require('../config/db');

const initWarehouseTables = async () => {
  try {
    // Inventory mapped to user accounts
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_inventory (
      id BIGINT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      quantity INT DEFAULT 0,
      sell_price DECIMAL(12,2) DEFAULT 0,
      date_added DATETIME,
      sold_qty INT DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // Customers mapped to user accounts
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_customers (
      id BIGINT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      loc VARCHAR(255),
      type VARCHAR(50),
      wallet DECIMAL(12,2) DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // Sales mapped to user accounts
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_sales (
      id BIGINT PRIMARY KEY,
      user_id INT NOT NULL,
      date DATETIME,
      customer_id BIGINT,
      total DECIMAL(12,2) DEFAULT 0,
      paid DECIMAL(12,2) DEFAULT 0,
      sale_json LONGTEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // System Settings & Logs payload
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_cloud_state (
      user_id INT PRIMARY KEY,
      logs_json LONGTEXT,
      proofs_json LONGTEXT,
      cfg_json LONGTEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    console.log('[Warehouse] Multi-Tenant Cloud Tables initialized successfully');
  } catch (e) {
    console.error('[Warehouse] Table init error:', e.message);
  }
};

module.exports = { initWarehouseTables };
