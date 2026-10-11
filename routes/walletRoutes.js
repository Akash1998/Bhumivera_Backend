const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
const { WalletModel } = require("../models/walletModel");
const { ensureWalletAccount } = require("../utils/walletAccount");
const { getRazorpayClient, isValidPaymentSignature, verifyRazorpayPayment } = require('../services/razorpayService');
const crypto = require('crypto');

const syncUserWallet = async userId => {
  const balance = await WalletModel.getWalletBalance(userId);
  await pool.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [balance, userId]);
};

router.get("/balance", authenticateUser, async (req, res) => {
  try {
    const balance = await WalletModel.getWalletBalance(req.user.id);
    let referralBalance = null;
    let referralBalanceAvailable = false;
    try {
      const [[referralWallet]] = await pool.query(
        'SELECT balance FROM referral_wallets WHERE user_id = ?',
        [req.user.id]
      );
      referralBalance = Number(referralWallet?.balance) || 0;
      referralBalanceAvailable = true;
    } catch (error) {
      console.error(`[WALLET_REFERRAL_BALANCE_UNAVAILABLE] code=${error.code || 'UNKNOWN'} message=${error.message}`);
    }
    await syncUserWallet(req.user.id);
    res.json({
      success: true,
      balance,
      referralBalance,
      referralBalanceAvailable,
    });
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

router.post('/top-up/confirm', authenticateUser, async (req, res) => {
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body || {};
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ success: false, message: 'Payment order, payment ID, and signature are required.' });
  }
  if (!isValidPaymentSignature(orderId, paymentId, signature)) {
    return res.status(400).json({ success: false, message: 'Wallet top-up payment verification failed.' });
  }

  let verifiedPayment;
  try {
    const razorpay = getRazorpayClient();
    const providerOrder = await razorpay.orders.fetch(orderId);
    if (String(providerOrder.notes?.userId) !== String(req.user.id) ||
        providerOrder.notes?.purpose !== 'wallet_topup' ||
        providerOrder.currency !== 'INR') {
      return res.status(400).json({ success: false, message: 'This payment is not a wallet top-up for your account.' });
    }
    verifiedPayment = await verifyRazorpayPayment({
      orderId,
      paymentId,
      signature,
      userId: req.user.id,
      expectedAmount: providerOrder.amount,
    });
  } catch (error) {
    console.error(`[WALLET_TOPUP_VERIFY] code=${error.code || 'UNKNOWN'} message=${error.message}`);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: 'WALLET_TOPUP_VERIFICATION_FAILED',
      message: error.statusCode === 503
        ? 'Wallet top-ups are temporarily unavailable.'
        : error.statusCode === 400
          ? error.message
          : 'Could not verify this wallet top-up. Contact support if you were charged.',
    });
  }

  const amount = verifiedPayment.payment.amount / 100;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [priorTopUps] = await connection.query(
      'SELECT user_id, amount FROM wallet_topups WHERE payment_id = ? FOR UPDATE',
      [paymentId]
    );
    if (priorTopUps.length) {
      if (String(priorTopUps[0].user_id) !== String(req.user.id)) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'This payment has already been applied to another account.' });
      }
      await ensureWalletAccount(connection, req.user.id);
      const [[wallet]] = await connection.query('SELECT balance FROM wallets WHERE user_id = ?', [req.user.id]);
      await connection.commit();
      return res.json({ success: true, alreadyCredited: true, balance: Number(wallet?.balance) || 0 });
    }

    await connection.query(
      'INSERT INTO wallet_topups (user_id, payment_id, payment_order_id, amount) VALUES (?, ?, ?, ?)',
      [req.user.id, paymentId, orderId, amount]
    );
    await ensureWalletAccount(connection, req.user.id);
    const [[wallet]] = await connection.query('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', [req.user.id]);
    const balance = (Number(wallet?.balance) || 0) + amount;
    await connection.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [balance, req.user.id]);
    await connection.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [balance, req.user.id]);
    await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description, reference_id)
       VALUES (?, ?, 'credit', 'Wallet balance purchased through Razorpay', ?)`,
      [req.user.id, amount, `wallet-topup-${paymentId}`]
    );
    await connection.commit();
    return res.json({ success: true, balance });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      const [existing] = await pool.query(
        'SELECT user_id FROM wallet_topups WHERE payment_id = ?',
        [paymentId]
      );
      if (existing.length && String(existing[0].user_id) === String(req.user.id)) {
        const balance = await WalletModel.getWalletBalance(req.user.id);
        return res.json({ success: true, alreadyCredited: true, balance });
      }
    }
    console.error(`[WALLET_TOPUP_CREDIT] code=${error.code || 'UNKNOWN'} message=${error.message}`);
    return res.status(500).json({
      success: false,
      code: 'WALLET_TOPUP_CREDIT_FAILED',
      message: 'Payment was verified, but wallet credit needs support review. Keep your payment ID.',
    });
  } finally {
    connection.release();
  }
});

router.get('/admin/accounts', authenticateAdmin, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.email, COALESCE(w.balance, 0) AS balance,
              COALESCE(rw.balance, 0) AS referral_balance
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN referral_wallets rw ON rw.user_id = u.id
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
    const transactions = await WalletModel.getTransactions(userId);
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
  const bucket = req.body?.bucket || 'cash';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 ||
      !Number.isInteger(Math.round(amount * 100)) ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001 ||
      !['credit', 'debit'].includes(type) || !['cash', 'referral'].includes(bucket) || reason.length < 5) {
    return res.status(400).json({ success: false, message: 'Provide a valid customer, amount, credit or debit action, and a reason of at least 5 characters.' });
  }
  try {
    const [users] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'customer'", [userId]);
    if (!users.length) return res.status(404).json({ success: false, message: 'Customer account not found.' });
    if (bucket === 'cash') {
      const reference = `admin-wallet-${crypto.randomUUID()}`;
      const balance = await WalletModel.processTransaction(userId, amount, type, reason, reference);
      await pool.query('UPDATE users SET wallet_balance = ? WHERE id = ?', [balance, userId]);
      return res.json({ success: true, balance, bucket });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('INSERT IGNORE INTO referral_wallets (user_id, balance) VALUES (?, 0.00)', [userId]);
      const [[wallet]] = await connection.query('SELECT balance FROM referral_wallets WHERE user_id = ? FOR UPDATE', [userId]);
      const currentBalance = Number(wallet?.balance) || 0;
      if (type === 'debit' && currentBalance < amount) {
        throw Object.assign(new Error('Insufficient referral balance.'), { status: 400 });
      }
      const balance = type === 'credit' ? currentBalance + amount : currentBalance - amount;
      await connection.query('UPDATE referral_wallets SET balance = ? WHERE user_id = ?', [balance, userId]);
      await connection.query(
        `INSERT INTO referral_wallet_transactions (user_id, amount, type, description, reference_id)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, amount, type, reason, `admin-referral-wallet-${crypto.randomUUID()}`]
      );
      await connection.commit();
      return res.json({ success: true, balance, bucket });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error.status === 400 || error.message?.includes('Insufficient')) return res.status(400).json({ success: false, message: error.message || 'Wallet debit exceeds the available balance.' });
    console.error('[ADMIN_WALLET_ADJUSTMENT]', error);
    return res.status(500).json({ success: false, message: 'Could not update this wallet.' });
  }
});

module.exports = router;
