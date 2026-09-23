// backend/models/adminModel
const pool = require("../config/db");
const bcrypt = require("bcryptjs");

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
    await addColIfMissing('failed_attempts', 'failed_attempts INT DEFAULT 0');
    await addColIfMissing('locked_until', 'locked_until DATETIME');
    await addColIfMissing('reset_otp', 'reset_otp VARCHAR(10)');
    await addColIfMissing('reset_otp_expires', 'reset_otp_expires DATETIME');
    await addColIfMissing('two_factor_secret', 'two_factor_secret VARCHAR(255)');
    await addColIfMissing('two_factor_enabled', 'two_factor_enabled TINYINT(1) DEFAULT 0');
    console.log('[AdminModel] admin_users columns verified.');
  } catch (err) {
    console.error('[AdminModel] Migration error:', err.message);
  }
};

const updateAdminFailedAttempts = async (id, reset = false) => {
  if (reset) {
    await pool.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
  } else {
    await pool.query(
      `UPDATE admin_users 
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE 
             WHEN (failed_attempts + 1) >= 6 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE)
             ELSE locked_until
           END
       WHERE id = ?`,
      [id]
    );
  }
};

const getAdminLockStatus = async (id) => {
  const [rows] = await pool.query(
    'SELECT failed_attempts, locked_until FROM admin_users WHERE id = ?',
    [id]
  );
  if (rows.length === 0) return { locked: false, lockedUntil: null, failedAttempts: 0 };
  const row = rows[0];
  const locked = row.locked_until && new Date(row.locked_until) > new Date();
  return {
    locked: !!locked,
    lockedUntil: row.locked_until || null,
    failedAttempts: row.failed_attempts || 0
  };
};

const saveAdminResetOtp = async (id, otp) => {
  await pool.query(
    'UPDATE admin_users SET reset_otp = ?, reset_otp_expires = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ?',
    [otp, id]
  );
};

const getAdminByResetOtp = async (email, otp) => {
  const [rows] = await pool.query(
    'SELECT * FROM admin_users WHERE email = ? AND reset_otp = ? AND reset_otp_expires > NOW()',
    [email, otp]
  );
  return rows[0];
};

const clearAdminResetOtp = async (id) => {
  await pool.query(
    'UPDATE admin_users SET reset_otp = NULL, reset_otp_expires = NULL WHERE id = ?',
    [id]
  );
};

const insertAdminPasswordHistory = async (id, hash) => {
  await pool.query(
    "INSERT INTO password_history (user_id, role, password_hash) VALUES (?, 'admin', ?)",
    [id, hash]
  );
};

const getLast5AdminPasswordHashes = async (id) => {
  const [rows] = await pool.query(
    "SELECT password_hash FROM password_history WHERE user_id = ? AND role = 'admin' ORDER BY id DESC LIMIT 5",
    [id]
  );
  return rows;
};

module.exports = {
  getAdminByEmail,
  getAdminById,
  verifyPassword,
  updateAdminPassword,
  initAdminTable,
  updateAdminFailedAttempts,
  getAdminLockStatus,
  saveAdminResetOtp,
  getAdminByResetOtp,
  clearAdminResetOtp,
  insertAdminPasswordHistory,
  getLast5AdminPasswordHashes,
};
