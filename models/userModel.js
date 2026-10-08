const pool = require('../config/db');
const bcrypt = require('bcryptjs');

const createUsersTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      role ENUM('customer','admin','superadmin','warehouse_admin') DEFAULT 'customer',
      is_active TINYINT(1) DEFAULT 1,
      marketing_email_opt_in TINYINT(1) NOT NULL DEFAULT 0,
      marketing_email_consent_at DATETIME NULL,
      wallet_balance DECIMAL(10,2) DEFAULT 0.00,
      loyalty_points INT NOT NULL DEFAULT 0,
      pending_lifecycle_gift_product_id INT DEFAULT NULL,
      two_factor_secret VARCHAR(255),
      two_factor_enabled TINYINT(1) DEFAULT 0,
      security_question VARCHAR(255) DEFAULT 'What is your mother''s maiden name?',
      security_answer_hash VARCHAR(255),
      reset_otp VARCHAR(10),
      reset_otp_expires DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const syncColumns = [
    { name: 'phone', type: `VARCHAR(20)` },
    { name: 'role', type: `ENUM('customer','admin','superadmin','warehouse_admin') DEFAULT 'customer'` },
    { name: 'is_active', type: `TINYINT(1) DEFAULT 1` },
    { name: 'marketing_email_opt_in', type: `TINYINT(1) NOT NULL DEFAULT 0` },
    { name: 'marketing_email_consent_at', type: `DATETIME NULL` },
    { name: 'wallet_balance', type: `DECIMAL(10,2) DEFAULT 0.00` },
    { name: 'loyalty_points', type: `INT NOT NULL DEFAULT 0` },
    { name: 'pending_lifecycle_gift_product_id', type: `INT DEFAULT NULL` },
    { name: 'two_factor_secret', type: `VARCHAR(255)` },
    { name: 'two_factor_enabled', type: `TINYINT(1) DEFAULT 0` },
    { name: 'security_question', type: `VARCHAR(255) DEFAULT 'What is your mother''s maiden name?'` },
    { name: 'security_answer_hash', type: `VARCHAR(255)` },
    { name: 'reset_otp', type: `VARCHAR(10)` },
    { name: 'reset_otp_expires', type: `DATETIME` },
    { name: 'failed_attempts', type: `INT DEFAULT 0` },
    { name: 'locked_until', type: `DATETIME` },
    { name: 'google_id', type: `VARCHAR(255)` },
    { name: 'magic_token', type: `VARCHAR(255)` },
    { name: 'magic_token_expires', type: `DATETIME` },
    { name: 'last_password_change', type: `DATETIME` },
    { name: 'remember_device_hash', type: `VARCHAR(255)` }
  ];

  for (const col of syncColumns) {
    try {
      const [columns] = await pool.query(`SHOW COLUMNS FROM users LIKE ?`, [col.name]);
      if (columns.length === 0) {
        console.log(`[DB_SYNC] Adding missing column to users: ${col.name}`);
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
      }
    } catch (err) {
      console.error(`[DB_SYNC] Error syncing column ${col.name}:`, err.message);
    }
  }

  try {
    await pool.query(`ALTER TABLE users MODIFY COLUMN reset_otp_expires DATETIME`);
  } catch(err) {
    console.warn(`[DB_SYNC] Info: Could not modify reset_otp_expires (ignoring):`, err.message);
  }

  await createAuthSecurityTables();
};

const createAuthSecurityTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      jti VARCHAR(64) UNIQUE NOT NULL,
      device_hash CHAR(64) DEFAULT NULL,
      device_info JSON DEFAULT NULL,
      ip VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      expires_at DATETIME,
      revoked_at DATETIME DEFAULT NULL,
      is_current TINYINT(1) DEFAULT 0,
      INDEX idx_us_jti(jti),
      INDEX idx_us_user(user_id)
    )
  `);

  const [deviceHashColumn] = await pool.query(`SHOW COLUMNS FROM user_sessions LIKE 'device_hash'`);
  if (deviceHashColumn.length === 0) {
    await pool.query(`ALTER TABLE user_sessions ADD COLUMN device_hash CHAR(64) DEFAULT NULL AFTER jti`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      jti VARCHAR(64) UNIQUE NOT NULL,
      device_info JSON DEFAULT NULL,
      ip VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      expires_at DATETIME,
      revoked_at DATETIME DEFAULT NULL,
      is_current TINYINT(1) DEFAULT 0,
      INDEX idx_us_jti(jti),
      INDEX idx_us_user(admin_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_trusted_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      user_agent TEXT,
      ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME DEFAULT NULL,
      UNIQUE KEY idx_atd_token_hash(token_hash),
      INDEX idx_atd_admin_id(admin_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS used_auth_tokens (
      jti VARCHAR(64) PRIMARY KEY,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_used_auth_tokens_expiry(expires_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      role ENUM('customer','admin','warehouse_admin') DEFAULT 'customer',
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ph_user_role(user_id,role)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      scope ENUM('register','login2fa','forgot','admin_forgot','challenge','warehouse') DEFAULT 'register',
      email VARCHAR(150),
      attempt_count INT DEFAULT 0,
      backoff_seconds INT DEFAULT 30,
      last_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      next_allowed_at DATETIME,
      INDEX idx_oa_scope_email(scope,email)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS new_device_alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      role ENUM('customer','admin','warehouse_admin') DEFAULT 'customer',
      ip VARCHAR(64),
      user_agent TEXT,
      city VARCHAR(128) DEFAULT NULL,
      challenge_code CHAR(6),
      challenge_hash CHAR(64) DEFAULT NULL,
      expires_at DATETIME,
      used TINYINT(1) DEFAULT 0,
      INDEX idx_device_challenge(user_id, challenge_hash, used, expires_at)
    )
  `);

  const [challengeHashColumn] = await pool.query(`SHOW COLUMNS FROM new_device_alerts LIKE 'challenge_hash'`);
  if (challengeHashColumn.length === 0) {
    await pool.query(`ALTER TABLE new_device_alerts ADD COLUMN challenge_hash CHAR(64) DEFAULT NULL AFTER challenge_code`);
  }
  const [challengeIndex] = await pool.query(`SHOW INDEX FROM new_device_alerts WHERE Key_name = 'idx_device_challenge'`);
  if (challengeIndex.length === 0) {
    await pool.query(`ALTER TABLE new_device_alerts ADD INDEX idx_device_challenge(user_id, challenge_hash, used, expires_at)`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      user_agent TEXT,
      ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_trusted_devices_user(user_id, revoked_at, expires_at)
    )
  `);
};

const getLast5PasswordHashes = async (userId, role = 'customer') => {
  const [rows] = await pool.query(
    'SELECT password_hash FROM password_history WHERE user_id = ? AND role = ? ORDER BY id DESC LIMIT 5',
    [userId, role]
  );
  return rows;
};

const insertPasswordHistory = async (userId, role, hash) => {
  await pool.query(
    'INSERT INTO password_history (user_id, role, password_hash) VALUES (?, ?, ?)',
    [userId, role, hash]
  );
};

const updateUserFailedAttempts = async (userId, reset = false) => {
  if (reset) {
    await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [userId]);
  } else {
    await pool.query(
      `UPDATE users 
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE 
             WHEN (failed_attempts + 1) >= 6 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE)
             ELSE locked_until
           END
       WHERE id = ?`,
      [userId]
    );
  }
};

const getUserLockStatus = async (userId) => {
  const [rows] = await pool.query(
    'SELECT failed_attempts, locked_until FROM users WHERE id = ?',
    [userId]
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

const saveMagicToken = async (userId, token, expiresMinutes = 15) => {
  await pool.query(
    'UPDATE users SET magic_token = ?, magic_token_expires = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
    [token, expiresMinutes, userId]
  );
};

const findUserByMagicToken = async (token) => {
  const [rows] = await pool.query(
    'SELECT * FROM users WHERE magic_token = ? AND magic_token_expires > NOW()',
    [token]
  );
  return rows[0];
};

const consumeMagicToken = async (userId) => {
  await pool.query(
    'UPDATE users SET magic_token = NULL, magic_token_expires = NULL WHERE id = ?',
    [userId]
  );
};

const saveRememberDevice = async (userId, hash) => {
  await pool.query(
    'UPDATE users SET remember_device_hash = ? WHERE id = ?',
    [hash, userId]
  );
};

const linkGoogleId = async (userId, googleId) => {
  await pool.query(
    'UPDATE users SET google_id = ? WHERE id = ?',
    [googleId, userId]
  );
};

const initAuthTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      email VARCHAR(150) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      marketing_email_opt_in TINYINT(1) NOT NULL DEFAULT 0,
      otp VARCHAR(10) NOT NULL,
      otp_expiry DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const [marketingConsentColumn] = await pool.query(
    `SHOW COLUMNS FROM pending_registrations LIKE 'marketing_email_opt_in'`
  );
  if (marketingConsentColumn.length === 0) {
    await pool.query(
      'ALTER TABLE pending_registrations ADD COLUMN marketing_email_opt_in TINYINT(1) NOT NULL DEFAULT 0'
    );
  }
};

const createUser = async ({ name, email, password, phone, securityAnswer, marketingEmailOptIn = false }) => {
  const isHashed = password.startsWith('$2b$');
  const hash = isHashed ? password : await bcrypt.hash(password, 10);
  
  const safeSecurityAnswer = securityAnswer ? String(securityAnswer).toLowerCase() : 'default-answer';
  const secHash = await bcrypt.hash(safeSecurityAnswer, 10);
  
  const [result] = await pool.query(
    `INSERT INTO users
      (name, email, password_hash, phone, security_answer_hash, marketing_email_opt_in, marketing_email_consent_at)
     VALUES (?, ?, ?, ?, ?, ?, IF(? = 1, CURRENT_TIMESTAMP, NULL))`,
    [name, email, hash, phone || null, secHash, marketingEmailOptIn ? 1 : 0, marketingEmailOptIn ? 1 : 0]
  );
  return result.insertId;
};

const getUserByEmail = async (email) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
};

const getUserById = async (id) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, role, is_active, wallet_balance, loyalty_points,
      two_factor_enabled, security_question, marketing_email_opt_in, marketing_email_consent_at, created_at
     FROM users WHERE id = ?`,
    [id]
  );
  return rows[0];
};

const getAdminCustomers = async ({ page = 1, limit = 25, search = '', status = 'all', activity = 'all', sort = 'recent' } = {}) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const offset = (safePage - 1) * safeLimit;
  const clauses = ["u.role = 'customer'"];
  const params = [];

  if (search.trim()) {
    const term = `%${search.trim()}%`;
    clauses.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
    params.push(term, term, term);
  }
  if (status === 'active') clauses.push('u.is_active = 1');
  if (status === 'disabled') clauses.push('u.is_active = 0');
  if (activity === 'ordered') clauses.push('COALESCE(o.order_count, 0) > 0');
  if (activity === 'no-orders') clauses.push('COALESCE(o.order_count, 0) = 0');
  if (activity === 'loyalty') clauses.push('u.loyalty_points > 0');

  const whereSql = `WHERE ${clauses.join(' AND ')}`;
  const orderBy = {
    recent: 'u.created_at DESC, u.id DESC',
    orders: 'COALESCE(o.order_count, 0) DESC, u.created_at DESC',
    loyalty: 'u.loyalty_points DESC, u.created_at DESC',
    value: 'COALESCE(o.total_spent, 0) DESC, u.created_at DESC'
  }[sort] || 'u.created_at DESC, u.id DESC';
  const orderSummary = `LEFT JOIN (
    SELECT user_id, COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'returned') THEN total ELSE 0 END), 0) AS total_spent
    FROM orders GROUP BY user_id
  ) o ON o.user_id = u.id`;

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM users u ${orderSummary} ${whereSql}`,
    params
  );
  const [[summaryRow]] = await pool.query(
    `SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END), 0) AS disabled
     FROM users WHERE role = 'customer'`
  );
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.wallet_balance,
      u.loyalty_points, u.marketing_email_opt_in, u.created_at,
      COALESCE(o.order_count, 0) AS order_count,
      COALESCE(o.total_spent, 0) AS total_spent
     FROM users u ${orderSummary} ${whereSql}
     ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, safeLimit, offset]
  );

  const total = Number(countRow?.total || 0);
  return {
    users: rows,
    summary: summaryRow,
    pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
  };
};

const updateUserStatus = async (id, status) => {
  const isActive = status === 'active' ? 1 : 0;
  await pool.query(
    'UPDATE users SET is_active = ?, failed_attempts = CASE WHEN ? = 1 THEN 0 ELSE failed_attempts END, locked_until = CASE WHEN ? = 1 THEN NULL ELSE locked_until END WHERE id = ? AND role = ?',
    [isActive, isActive, isActive, id, 'customer']
  );
};

const updateUser = async (id, { name, phone, marketingEmailOptIn }) => {
  if (typeof marketingEmailOptIn === 'boolean') {
    await pool.query(
      `UPDATE users
       SET name = ?, phone = ?, marketing_email_opt_in = ?,
           marketing_email_consent_at = CASE
             WHEN ? = 1 THEN CURRENT_TIMESTAMP
             ELSE marketing_email_consent_at
           END
       WHERE id = ? AND role = 'customer'`,
      [name, phone || null, marketingEmailOptIn ? 1 : 0, marketingEmailOptIn ? 1 : 0, id]
    );
    return;
  }
  await pool.query('UPDATE users SET name=?, phone=? WHERE id=?', [name, phone || null, id]);
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
  const [userRows] = await conn.query('SELECT wallet_balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (userRows.length === 0) throw new Error("User not found for wallet adjustment.");
  
  const currentBalance = parseFloat(userRows[0].wallet_balance);
  const newBalance = type === 'credit' ? currentBalance + amount : currentBalance - amount;
  
  if (newBalance < 0) throw new Error("Insufficient wallet balance.");
  
  await conn.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, userId]);
  await conn.query(
    'INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, desc, refId]
  );
  return newBalance;
};

const saveResetOtp = async (userId, otp) => {
  await pool.query('UPDATE users SET reset_otp=?, reset_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id=?', [otp, userId]);
};

const clearResetOtp = async (userId) => {
  await pool.query('UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=?', [userId]);
};

const updateUserPassword = async (userId, hash) => {
  await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, userId]);
};

module.exports = {
  createUsersTable,
  createAuthSecurityTables,
  initAuthTables,
  createUser,
  getUserByEmail,
  getUserById,
  getAdminCustomers,
  updateUserStatus,
  updateUser,
  updateUserPassword,
  createPendingUser,
  getPendingUser,
  deletePendingUser,
  adjustWallet,
  saveResetOtp,
  clearResetOtp,
  getLast5PasswordHashes,
  insertPasswordHistory,
  updateUserFailedAttempts,
  getUserLockStatus,
  saveMagicToken,
  findUserByMagicToken,
  consumeMagicToken,
  saveRememberDevice,
  linkGoogleId,
  verifyPassword: async (password, hash) => bcrypt.compare(password, hash),
  verifySecurityAnswer: async (answer, hash) => bcrypt.compare(answer.toLowerCase(), hash),
};
