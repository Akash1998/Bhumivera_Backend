const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser } = require("../middleware/authMiddleware");
const { WalletModel } = require("../models/walletModel");

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

router.post("/add", authenticateUser, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: "A valid positive amount is required." });
    }
    const newBalance = await WalletModel.processTransaction(
      req.user.id,
      amt,
      "credit",
      description || `Wallet top-up (+${amt.toFixed(2)})`,
      req.body.reference_id || null
    );
    await syncUserWallet(req.user.id);
    res.json({ success: true, message: "Funds added to wallet", balance: newBalance });
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

router.get("/overview", async (req, res) => {
  try {
    const [wallets] = await pool.query("SELECT * FROM wallets LIMIT 50");
    const [transactions] = await pool.query("SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT 20");
    
    const stats = {
      totalActiveWallets: wallets.length || 0,
      totalBalanceHeld: wallets.reduce((acc, curr) => acc + (parseFloat(curr.balance) || 0), 0),
    };

    res.json({ success: true, stats, wallets, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/adjust", async (req, res) => {
  const { userId, amount, type, description } = req.body; 
  try {
    if (!userId || !amount || !type) return res.status(400).json({ success: false, message: 'userId, amount, type are required' });
    const newBalance = await WalletModel.processTransaction(userId, amount, type, description || 'Admin adjustment');
    await syncUserWallet(userId);
    res.json({ success: true, message: `Wallet successfully ${type}ed.`, balance: newBalance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
