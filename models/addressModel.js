const pool = require('../config/db');

async function createAddressTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS addresses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      street_address TEXT NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(100) NOT NULL,
      postal_code VARCHAR(20) NOT NULL,
      country VARCHAR(100) DEFAULT 'India',
      label VARCHAR(50) DEFAULT 'Home',
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await pool.query(query);
    const [labelCol] = await pool.query(`SHOW COLUMNS FROM addresses LIKE 'label'`);
    if (labelCol.length === 0) {
      try { await pool.query(`ALTER TABLE addresses ADD COLUMN label VARCHAR(50) DEFAULT 'Home' AFTER is_default`); } catch (_) {}
    }
    console.log("[DB] Addresses table ready.");
  } catch (error) {
    console.error("[DB Error] Error initializing addresses table:", error.message);
    throw error;
  }
}

const AddressModel = {

  getAddressesByUser: async (userId) => {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', 
        [userId]
      );
      return rows;
    } catch (error) {
      console.error("[Database Error] getAddressesByUser failed:", error.message);
      throw error;
    }
  },


  getUserAddresses: async (userId) => {
    return await AddressModel.getAddressesByUser(userId);
  },


  createAddress: async (userId, data) => {
    const { 
      full_name, 
      phone, phone_number,
      line1, street_address,
      city, 
      state, 
      pincode, postal_code,
      country, 
      is_default,
      label
    } = data;

    // Mapping inputs to DB columns to prevent crashes regardless of frontend key naming
    const db_phone = phone_number || phone;
    const db_street = street_address || line1;
    const db_postal = postal_code || pincode;

    try {
      if (is_default) {
        await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = ?', [userId]);
      }

      const [result] = await pool.query(
        `INSERT INTO addresses (user_id, full_name, phone_number, street_address, city, state, postal_code, country, is_default, label) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId, 
          full_name, 
          db_phone, 
          db_street, 
          city, 
          state, 
          db_postal, 
          country || 'India', 
          is_default ? 1 : 0,
          label || 'Home'
        ]
      );
      return result.insertId;
    } catch (error) {
      console.error("[AddressModel.createAddress Error]:", error.message);
      throw error;
    }
  },

  getDefaultAddress: async (userId) => {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM addresses WHERE user_id = ? AND is_default = TRUE LIMIT 1', 
        [userId]
      );
      return rows[0] || null;
    } catch (error) {
      console.error("[AddressModel.getDefaultAddress Error]:", error.message);
      throw error;
    }
  },

  setAsDefault: async (userId, addressId) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('UPDATE addresses SET is_default = FALSE WHERE user_id = ?', [userId]);
      const [result] = await connection.query(
        'UPDATE addresses SET is_default = TRUE WHERE id = ? AND user_id = ?', 
        [addressId, userId]
      );
      await connection.commit();
      return result.affectedRows > 0;
    } catch (error) {
      await connection.rollback();
      console.error("[AddressModel.setAsDefault Error]:", error.message);
      throw error;
    } finally {
      connection.release();
    }
  },

  deleteAddress: async (userId, addressId) => {
    try {
      const [result] = await pool.query(
        'DELETE FROM addresses WHERE id = ? AND user_id = ?', 
        [addressId, userId]
      );
      return result.affectedRows > 0;
    } catch (error) {
      console.error("[AddressModel.deleteAddress Error]:", error.message);
      throw error;
    }
  }
};

module.exports = {
  createAddressTable,
  AddressModel
};
