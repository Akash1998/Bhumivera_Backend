const ensureWalletAccount = async (connection, userId) => {
  await connection.query(
    `INSERT IGNORE INTO wallets (user_id, balance)
     SELECT id, COALESCE(wallet_balance, 0.00) FROM users WHERE id = ?`,
    [userId]
  );
};

module.exports = { ensureWalletAccount };
