const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
const { WalletModel } = require("../models/walletModel");
const crypto = require('crypto');

const syncUserWallet = async (userId) => {
  try {
    const bal = await WalletModel.getWalletBalance(userId);
    await pool.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [bal, userId]);
  } catch (_) {}
};

router.get("/balance", authenticateUser, async (req, res) => {
  try {
    const balance = await WalletModel.getWalletBalance(req.user.id);
    await syncUserWallet(req.user.id);
    res.json({ success: true, balance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/history", authenticateUser, async (req, res) => {
  try {
    const transactions = await WalletModel.getTransactions(req.user.id);
    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/pay", authenticateUser, async (req, res) => {
  try {
    const { amount, reference_id, description } = req.body;
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: "A valid positive amount is required." });
    }
    const newBalance = await WalletModel.processTransaction(
      req.user.id,
      amt,
      "debit",
      description || `Wallet payment (-${amt.toFixed(2)})`,
      reference_id || null
    );
    await syncUserWallet(req.user.id);
    res.json({ success: true, message: "Wallet payment successful", balance: newBalance });
  } catch (error) {
    if (error.message && error.message.includes('Insufficient')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/admin/accounts', authenticateAdmin, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.email, COALESCE(w.balance, 0) AS balance
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.role = 'customer' AND (? = '' OR u.name LIKE ? OR u.email LIKE ?)
       ORDER BY u.id DESC LIMIT ?`,
      [search, `%${search}%`, `%${search}%`, limit]
    );
    return res.json({ success: true, accounts: users });
  } catch (error) {
    console.error('[ADMIN_WALLET_ACCOUNTS]', error);
    return res.status(500).json({ success: false, message: 'Could not load wallet accounts.' });
  }
});

router.get('/admin/accounts/:userId/transactions', authenticateAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ success: false, message: 'A valid customer account is required.' });
  try {
    const [transactions] = await pool.query(
      `SELECT id, amount, type, description, reference_id, created_at
       FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
    return res.json({ success: true, transactions });
  } catch (error) {
    console.error('[ADMIN_WALLET_TRANSACTIONS]', error);
    return res.status(500).json({ success: false, message: 'Could not load wallet history.' });
  }
});

router.post('/admin/accounts/:userId/adjust', authenticateAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const amount = Number(req.body?.amount);
  const type = req.body?.type;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 ||
      !Number.isInteger(Math.round(amount * 100)) ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001 ||
      !['credit', 'debit'].includes(type) || reason.length < 5) {
    return res.status(400).json({ success: false, message: 'Provide a valid customer, amount, credit or debit action, and a reason of at least 5 characters.' });
  }
  try {
    const [users] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'customer'", [userId]);
    if (!users.length) return res.status(404).json({ success: false, message: 'Customer account not found.' });
    const reference = `admin-wallet-${crypto.randomUUID()}`;
    const balance = await WalletModel.processTransaction(userId, amount, type, reason, reference);
    await pool.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [balance, userId]);
    return res.json({ success: true, balance });
  } catch (error) {
    if (error.message?.includes('Insufficient')) return res.status(400).json({ success: false, message: 'Wallet debit exceeds the available balance.' });
    console.error('[ADMIN_WALLET_ADJUSTMENT]', error);
    return res.status(500).json({ success: false, message: 'Could not update this wallet.' });
  }
});

module.exports = router;
