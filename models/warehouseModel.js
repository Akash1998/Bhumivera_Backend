const pool = require('../config/db');

const initWarehouseTables = async () => {
  try {
    // Main warehouse state table (existing)
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_user_states (
      user_id INT PRIMARY KEY,
      app_state LONGTEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    console.log('[Warehouse] Cloud Blob State Table initialized successfully');

    // Warehouse access control table
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      granted_by INT,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      store_name VARCHAR(255) DEFAULT NULL,
      is_active TINYINT(1) DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    console.log('[Warehouse] Access control table initialized successfully');

    // Warehouse sales log table
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_sales_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      store_name VARCHAR(255),
      product_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      sale_price DECIMAL(10,2) DEFAULT 0,
      sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    console.log('[Warehouse] Sales log table initialized successfully');

  } catch (e) {
    console.error('[Warehouse] Table init error:', e.message);
  }
};

module.exports = { initWarehouseTables };
