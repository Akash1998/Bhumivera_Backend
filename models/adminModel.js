// backend/models/adminModel
const pool = require("../config/db");
const bcrypt = require("bcrypt");

const getAdminByEmail = async (email) => {
  const [rows] = await pool.query(
    `SELECT id, email, password_hash
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

const createAdmin = async (email, password) => {   const hash = await bcrypt.hash(password, 10);   await pool.query(     `INSERT INTO admin_users (email, password_hash) VALUES (?, ?)`,     [email, hash]   ); };  module.exports = {
  createAdmin,   getAdminByEmail,
  getAdminById,
  verifyPassword,
  updateAdminPassword,
};
