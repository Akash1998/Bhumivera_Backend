// backend/models/adminModel
const pool = require("../config/db");
const bcrypt = require("bcrypt");

const getAdminByEmail = async (email) => {
  const [rows] = await pool.query(
    `SELECT id, email, password_hash, role, login_otp, login_otp_expires
     FROM admin_users
     WHERE email = ?`,
    [email]
  );
  return rows[0];
};

const getAdminById = async (id) => {
  const [rows] = await pool.query(
    `SELECT id, email FROM admin_users WHERE id = ?`,
    [id]
  );
  return rows[0];
};

const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

const updateAdminPassword = async (id, newHash) => {
  await pool.query(
    `UPDATE admin_users SET password_hash = ? WHERE id = ?`,
    [newHash, id]
  );
};
const initAdminTable = async () => {
  const addColIfMissing = async (col, def) => {
    const [cols] = await pool.query(`SHOW COLUMNS FROM admin_users LIKE ?`, [col]);
    if (cols.length === 0) await pool.query(`ALTER TABLE admin_users ADD COLUMN ${def}`);
  };
  try {
    await addColIfMissing('role', "role VARCHAR(50) NOT NULL DEFAULT 'admin'");
    await addColIfMissing('login_otp', 'login_otp VARCHAR(10) DEFAULT NULL');
    await addColIfMissing('login_otp_expires', 'login_otp_expires DATETIME DEFAULT NULL');
    console.log('[AdminModel] admin_users columns verified.');
  } catch (err) {
    console.error('[AdminModel] Migration error:', err.message);
  }
};
module.exports = {

    getAdminByEmail,
  getAdminById,
  verifyPassword,
  updateAdminPassword,
    initAdminTable,
};
