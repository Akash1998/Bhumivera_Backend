const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
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

module.exports = router;
