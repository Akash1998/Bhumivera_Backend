const pool = require('../config/db');
const bcrypt = require('bcrypt');

const createUsersTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('customer','admin','superadmin','warehouse_admin') DEFAULT 'customer',
      is_active TINYINT(1) DEFAULT 1,
      wallet_balance DECIMAL(10,2) DEFAULT 0.00,
      two_factor_secret VARCHAR(255),
      two_factor_enabled TINYINT(1) DEFAULT 0,
      security_question VARCHAR(255) DEFAULT 'What is your mother's maiden name?',
      security_answer_hash VARCHAR(255),
      reset_otp VARCHAR(10),
      reset_otp_expires BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const syncColumns = [
    { name: 'security_question', type: `VARCHAR(255) DEFAULT 'What is your mother''s maiden name?' AFTER two_factor_enabled` },
    { name: 'security_answer_hash', type: `VARCHAR(255) AFTER security_question` },
    { name: 'reset_otp', type: `VARCHAR(10) AFTER security_answer_hash` },
    { name: 'reset_otp_expires', type: `BIGINT AFTER reset_otp` }
  ];

  for (const col of syncColumns) {
    try {
      const [rows] = await pool.query(
        `SHOW COLUMNS FROM users LIKE ?`,
        [col.name]
      );
      if (rows.length === 0) {
        console.log(`[DB_SYNC] Adding missing column: ${col.name}`);
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
      }
    } catch (err) {
      console.warn(`[DB_SYNC] Warning syncing column ${col.name}:`, err.message);
    }
  }
};

const initAuthTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      email VARCHAR(150) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      otp VARCHAR(10) NOT NULL,
      otp_expiry DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};


const createUser = async ({ name, email, password, securityAnswer }) => {
 
  const isHashed = password.startsWith('$2b$');
  const hash = isHashed ? password : await bcrypt.hash(password, 10);
  
  // FIX: Safely handle null/undefined overriding default parameters
  const safeSecurityAnswer = securityAnswer ? String(securityAnswer).toLowerCase() : 'default-answer';
  const secHash = await bcrypt.hash(safeSecurityAnswer, 10);
  
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password_hash, security_answer_hash) VALUES (?, ?, ?, ?)',
    [name, email, hash, secHash]
  );
  return result.insertId;
};

const getUserByEmail = async (email) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
};

const getUserById = async (id) => {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, is_active, wallet_balance, two_factor_enabled, security_question, created_at FROM users WHERE id = ?',
    [id]
  );
  return rows[0];
};

const getAllUsers = async () => {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, is_active, wallet_balance, created_at FROM users ORDER BY created_at DESC'
  );
  return rows;
};

const updateUser = async (id, { name }) => {
  await pool.query('UPDATE users SET name=? WHERE id=?', [name, id]);
};


const createPendingUser = async ({ name, email, password, otp, expiry }) => {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO pending_registrations (email, name, password, otp, otp_expiry) 
     VALUES (?, ?, ?, ?, ?) 
     ON DUPLICATE KEY UPDATE name=?, password=?, otp=?, otp_expiry=?`,
    [email, name, hash, otp, expiry, name, hash, otp, expiry]
  );
};

const getPendingUser = async (email) => {
  const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
  return rows[0];
};

const deletePendingUser = async (email) => {
  await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
};


const adjustWallet = async (conn, userId, amount, type, desc, refId = null) => {
  const [user] = await conn.query('SELECT wallet_balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  const currentBalance = parseFloat(user[0].wallet_balance);
  const newBalance = type === 'credit' ? currentBalance + amount : currentBalance - amount;
  
  if (newBalance < 0) throw new Error("Insufficient wallet balance.");
  
  await conn.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, userId]);
  await conn.query(
    'INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, desc, refId]
  );
  return newBalance;
};


const saveResetOtp = async (userId, otp, expiry) => {
  await pool.query('UPDATE users SET reset_otp=?, reset_otp_expires=? WHERE id=?', [otp, expiry, userId]);
};

const clearResetOtp = async (userId) => {
  await pool.query('UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=?', [userId]);
};

const updateUserPassword = async (userId, hash) => {
  await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, userId]);
};

module.exports = {
  // Initialization
  createUsersTable,
  initAuthTables,
  
  // Standard Users
  createUser,
  getUserByEmail,
  getUserById,
  getAllUsers,
  updateUser,
  updateUserPassword,
  
  // Pending Queue
  createPendingUser,
  getPendingUser,
  deletePendingUser,
  
  // Wallet
  adjustWallet,
  
  // OTP / Auth Logic
  saveResetOtp,
  clearResetOtp,
  verifyPassword: async (password, hash) => bcrypt.compare(password, hash),
  verifySecurityAnswer: async (answer, hash) => bcrypt.compare(answer.toLowerCase(), hash),
};
