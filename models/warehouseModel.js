const pool = require('../config/db');

const initWarehouseTables = async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouse_user_states (
      user_id INT PRIMARY KEY,
      app_state LONGTEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    console.log('[Warehouse] Cloud Blob State Table initialized successfully');
  } catch (e) {
    console.error('[Warehouse] Table init error:', e.message);
  }
};

module.exports = { initWarehouseTables };
