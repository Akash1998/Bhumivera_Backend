const pool = require('../config/db');
const { ensureWalletAccount } = require('../utils/walletAccount');

async function initWalletTables() {
  const walletQuery = `
    CREATE TABLE IF NOT EXISTS wallets (
      user_id INT PRIMARY KEY,
      balance DECIMAL(10, 2) DEFAULT 0.00,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const transactionQuery = `
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      type ENUM('credit', 'debit') NOT NULL,
      description VARCHAR(255) NOT NULL,
      reference_id VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await pool.query(walletQuery);
    await pool.query(transactionQuery);
    console.log("[DB] Wallet & Transaction tables ready.");
  } catch (error) {
    console.error("[DB] Error initializing wallet tables:", error);
    throw error;
  }
}

const WalletModel = {
  getWalletBalance: async (userId) => {
    await ensureWalletAccount(pool, userId);
    const [rows] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
    return Number(rows[0]?.balance) || 0;
  },

  getTransactions: async (userId) => {
    const [[cashRows], [referralRows]] = await Promise.all([
      pool.query(
        `SELECT id, amount, type, description, reference_id, created_at, 'cash' AS wallet_bucket
         FROM wallet_transactions WHERE user_id = ?`,
        [userId]
      ),
      pool.query(
        `SELECT id, amount, type, description, reference_id, coupon_code, order_id, created_at,
                CASE WHEN reference_id LIKE 'shopping-reward-%' THEN 'shopping' ELSE 'referral' END AS wallet_bucket
         FROM referral_wallet_transactions WHERE user_id = ?`,
        [userId]
      ),
    ]);
    return [...cashRows, ...referralRows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100);
  },

  processTransaction: async (userId, amount, type, description, reference_id = null) => {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('Transaction amount must be a positive number.');
    }
    if (!['credit', 'debit'].includes(type)) {
      throw new Error('Transaction type must be credit or debit.');
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await ensureWalletAccount(connection, userId);
      const [wallet] = await connection.query('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
      const currentBalance = Number(wallet[0]?.balance) || 0;
      const currentPaise = Math.round(currentBalance * 100);
      const deltaPaise = Math.round(numericAmount * 100);

      if (type === 'debit' && currentPaise < deltaPaise) {
        throw new Error('Insufficient wallet balance');
      }

      const newPaise = type === 'credit' ? currentPaise + deltaPaise : currentPaise - deltaPaise;
      const newBalance = Number((newPaise / 100).toFixed(2));

      await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [newBalance, userId]);
      
      await connection.query(
        'INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
        [userId, numericAmount.toFixed(2), type, description, reference_id]
      );

      await connection.commit();
      return newBalance;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }
};

module.exports = {
  initWalletTables,
  WalletModel,
};
