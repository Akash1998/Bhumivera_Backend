const pool = require('../config/db');

const initWarehouseTables = async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      sku VARCHAR(100),
      unit VARCHAR(50) DEFAULT 'pcs',
      quantity INT DEFAULT 0,
      cost_price DECIMAL(12,2) DEFAULT 0,
      sell_price DECIMAL(12,2) DEFAULT 0,
      min_stock INT DEFAULT 0,
      location VARCHAR(100),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(255),
      balance DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      admin_id INT,
      total DECIMAL(12,2) DEFAULT 0,
      discount DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_sale_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sale_id INT NOT NULL,
      item_id INT NOT NULL,
      quantity INT DEFAULT 1,
      price DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action VARCHAR(100),
      entity VARCHAR(100),
      entity_id INT,
      admin_id INT,
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('[Warehouse] Tables initialized successfully');
  } catch (e) {
    console.error('[Warehouse] Table init error:', e.message);
  }
};

module.exports = { initWarehouseTables };
