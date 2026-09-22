const pool = require('../config/db');

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
    const [rows] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
    if (rows.length === 0) {
      await pool.query('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0.00)', [userId]);
      return 0.00;
    }
    return parseFloat(rows[0].balance);
  },

  getTransactions: async (userId) => {
    const [rows] = await pool.query('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return rows;
  },

  processTransaction: async (userId, amount, type, description, reference_id = null) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [wallet] = await connection.query('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
      
      let currentBalance = 0.00;
      if (wallet.length === 0) {
        await connection.query('INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)', [userId]);
      } else {
        currentBalance = parseFloat(wallet[0].balance);
      }

      if (type === 'debit' && currentBalance < amount) {
        throw new Error('Insufficient wallet balance');
      }

      const newBalance = type === 'credit' ? currentBalance + parseFloat(amount) : currentBalance - parseFloat(amount);

      await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [newBalance, userId]);
      
      await connection.query(
        'INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
        [userId, amount, type, description, reference_id]
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
  WalletModel
};
