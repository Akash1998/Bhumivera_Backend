const express = require("express");
const router = express.Router();
const pool = require("../config/db");
// FIXED: Using the exact middleware name exported by your authMiddleware.js
const { authenticateUser } = require("../middleware/authMiddleware");

// NEW: Added missing endpoint for Checkout.jsx with correct middleware
router.get("/balance", authenticateUser, async (req, res) => {
  try {
    const [wallets] = await pool.query(
      "SELECT balance FROM wallets WHERE user_id = ?",
      [req.user.id]
    );
    
    // Default to 0 if wallet record doesn't exist yet
    const balance = wallets.length > 0 ? parseFloat(wallets[0].balance) : 0;
    
    res.json({ success: true, balance });
  } catch (error) {
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
    const operator = type === 'credit' ? '+' : '-';
    await pool.query(
      `UPDATE wallets SET balance = balance ${operator} ? WHERE user_id = ?`,
      [amount, userId]
    );

    await pool.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)`,
      [userId, amount, type, description]
    );

    res.json({ success: true, message: `Wallet successfully ${type}ed.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
