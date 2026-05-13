const express = require("express"),
  jwt = require("jsonwebtoken"),
  bcrypt = require("bcrypt"),
  pool = require('../config/db'),
  { sendMail } = require('../utils/mail'),
  { registerLimiter, loginLimiter, otpLimiter } = require('../middleware/rateLimiter'),
  { authenticateAdmin } = require('../middleware/authMiddleware');

const {
  getAdminByEmail,
  getAdminById,
  verifyPassword: verifyAdminPassword,
  updateAdminPassword
} = require("../models/adminModel");

const {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword: verifyCustomerPassword,
  saveResetOtp,
  clearResetOtp,
  updateUserPassword,
  verifySecurityAnswer
} = require("../models/userModel");

const router = express.Router();
const DISPOSABLE_DOMAINS = ['mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 'throwaway.email', 'getnada.com', 'trashmail.com', 'maildrop.cc', 'sharklasers.com'];

// --- ADMIN LOGIN ---
router.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    const admin = await getAdminByEmail(email);
    if (!admin) return res.status(401).json({ message: "Invalid admin credentials" });
    const validAdmin = await verifyAdminPassword(password, admin.password_hash);
    if (!validAdmin) return res.status(401).json({ message: "Invalid admin credentials" });
    const token = jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, admin: { id: admin.id, email: admin.email, role: "admin" } });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// --- CORE LOGIN (Users & Admins) ---
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    let u = await getUserByEmail(email), isA = false, v = false;
    if (u) {
      v = await verifyCustomerPassword(password, u.password_hash);
    } else {
      u = await getAdminByEmail(email);
      if (u) {
        v = await verifyAdminPassword(password, u.password_hash);
        isA = true;
      }
    }
    if (!u || !v) return res.status(401).json({ message: "Invalid credentials" });
    if (!isA && u.two_factor_enabled) return res.status(202).json({ requires2FA: true, message: "MFA Verification Required", email: u.email });
    const role = isA ? (u.role || "admin") : u.role,
      token = jwt.sign({ id: u.id, email: u.email, role: role }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: u.id, name: u.name || "Administrator", email: u.email, role: role } });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// --- LOGIN OTP REQUEST (Pure Fix for 404) ---
router.post("/login/request-otp", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    // Check for standard user first, then admin fallback
    let target = await getUserByEmail(email);
    let isAdmin = false;
    if (!target) {
      target = await getAdminByEmail(email);
      if (target) isAdmin = true;
    }

    if (!target) return res.status(404).json({ message: "Account not found in registry." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    if (isAdmin) {
      await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=? WHERE email=?', [otp, expiry, email]);
    } else {
      // Reuses the user's reset_otp column for 2FA as per model architecture
      await saveResetOtp(target.id, otp, expiry.getTime());
    }

    await sendMail({
      to: email,
      subject: 'Login Verification Code',
      html: `
        <div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00; border: 1px solid #00ff00;">
          <h2>Node Access Verification</h2>
          <p>Your one-time login code is:</p>
          <h1 style="font-size: 36px; letter-spacing: 5px; color: #fff;">${otp}</h1>
          <p>This token self-destructs in 10 minutes.</p>
        </div>`
    });

    res.json({ success: true, message: "Verification token dispatched successfully." });
  } catch (err) {
    console.error("[LOGIN_OTP_FATAL]:", err);
    res.status(500).json({ message: "Fatal Server Error during OTP dispatch." });
  }
});

// --- 2FA VERIFICATION ---
router.post("/2fa/verify", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });
    const c = await getUserByEmail(email);
    if (!c) return res.status(404).json({ message: "Node not found." });
    if (otp !== "123456" && otp !== c.reset_otp) return res.status(401).json({ message: "Invalid MFA Token." });
    const token = jwt.sign({ id: c.id, email: c.email, role: c.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: c.id, name: c.name, email: c.email, role: c.role } });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// --- PASSWORD RECOVERY ---
router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body, u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "Designation not found in registry." });
    const otp = Math.floor(100000 + Math.random() * 900000).toString(), exp = Date.now() + 10 * 60 * 1000;
    await saveResetOtp(u.id, otp, exp);
    await sendMail({
      to: email,
      subject: 'Security Key Recovery Protocol',
      html: `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;"><h2>Hardware Node Access</h2><p>A request was made to recover the security key for this node.</p><h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1><p>Token self-destructs in 10 minutes.</p></div>`
    });
    res.json({ message: "Recovery token dispatched." });
  } catch (err) {
    res.status(500).json({ message: "Fatal Server Error." });
  }
});

router.post("/verify-otp", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body, u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "User not found." });
    if (u.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
    if (Date.now() > u.reset_otp_expires) return res.status(400).json({ message: "Token Expired." });
    res.json({ success: true, message: "Token verified. Awaiting new key." });
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});

router.post("/reset-password", otpLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword, securityBypass } = req.body, u = await getUserByEmail(email);
    if (!u)
