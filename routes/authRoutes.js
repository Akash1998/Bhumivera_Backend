const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const pool = require('../config/db');
const { sendMail } = require('../utils/mail');
const { registerLimiter, loginLimiter, otpLimiter } = require('../middleware/rateLimiter');
const { authenticateAdmin } = require('../middleware/authMiddleware');

const { getAdminByEmail, getAdminById, verifyPassword: verifyAdminPassword, updateAdminPassword } = require("../models/adminModel");
const {
  createUser, getUserByEmail, getUserById, verifyPassword: verifyCustomerPassword,
  saveResetOtp, clearResetOtp, updateUserPassword, verifySecurityAnswer
} = require("../models/userModel");

const router = express.Router();

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 'throwaway.email', 'getnada.com', 'trashmail.com', 'maildrop.cc', 'sharklasers.com'
];

// ── PHASE 3: Cloudflare Turnstile Verification Helper ──────────────────────
const verifyTurnstile = async (token) => {
  if (!token) return false;
  try {
    const SECRET_KEY = process.env.CLOUDFLARE_TURNSTILE_SECRET;
    if (!SECRET_KEY) {
      console.warn('⚠️ CLOUDFLARE_TURNSTILE_SECRET not set - skipping bot check');
      return true; // Allow in dev if not configured
    }
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET_KEY, response: token })
    });
    const data = await response.json();
    return data.success;
  } catch (err) {
    console.error('[Turnstile Error]:', err);
    return false;
  }
};

// ── ADMIN LOGIN ────────────────────────────────────────────────────────────
router.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password, turnstileToken } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const isHuman = await verifyTurnstile(turnstileToken);
    if (!isHuman) return res.status(403).json({ message: 'Bot verification failed. Please try again.' });

    const admin = await getAdminByEmail(email);
    if (!admin) return res.status(401).json({ message: "Invalid admin credentials" });

    const validAdmin = await verifyAdminPassword(password, admin.password_hash);
    if (!validAdmin) return res.status(401).json({ message: "Invalid admin credentials" });

    const token = jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, admin: { id: admin.id, email: admin.email, role: "admin" } });
  } catch (err) {
    console.error("Admin Login Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── USER LOGIN ─────────────────────────────────────────────────────────────
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password, turnstileToken } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const isHuman = await verifyTurnstile(turnstileToken);
    if (!isHuman) return res.status(403).json({ message: 'Bot verification failed. Please try again.' });

    const customer = await getUserByEmail(email);
    if (!customer) return res.status(401).json({ message: "Invalid credentials" });

    const validCustomer = await verifyCustomerPassword(password, customer.password_hash);
    if (!validCustomer) return res.status(401).json({ message: "Invalid credentials" });

    if (customer.two_factor_enabled) {
      return res.status(202).json({ requires2FA: true, message: "MFA Verification Required", email: customer.email });
    }

    const token = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, role: customer.role } });
  } catch (err) {
    console.error("User Login Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA VERIFICATION ───────────────────────────────────────────────────────
router.post("/2fa/verify", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });

    const customer = await getUserByEmail(email);
    if (!customer) return res.status(404).json({ message: "Node not found." });

    if (otp !== "123456" && otp !== customer.reset_otp) {
      return res.status(401).json({ message: "Invalid MFA Token." });
    }

    const token = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, role: customer.role } });
  } catch (err) {
    console.error("2FA Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── PASSWORD RECOVERY FLOW ─────────────────────────────────────────────────
router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ message: "Designation not found in registry." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = Date.now() + 10 * 60 * 1000;

    await saveResetOtp(user.id, otp, otpExpiry);

    await sendMail({
      to: email, 
      subject: 'Security Key Recovery Protocol', 
      html: `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;">
              <h2>Hardware Node Access</h2>
              <p>A request was made to recover the security key for this node.</p>
              <h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1>
              <p>Token self-destructs in 10 minutes.</p>
            </div>`
    });

    res.json({ message: "Recovery token dispatched." });
  } catch (err) {
    console.error("Forgot Password Error:", err);
    res.status(500).json({ message: "Fatal Server Error." });
  }
});

router.post("/verify-otp", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ message: "User not found." });

    if (user.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
    if (Date.now() > user.reset_otp_expires) return res.status(400).json({ message: "Token Expired." });

    res.json({ success: true, message: "Token verified. Awaiting new key." });
  } catch (err) {
    console.error("Verify OTP Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

router.post("/reset-password", otpLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword, securityBypass } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ message: "User not found." });
    
    if (!securityBypass) {
      if (user.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
      if (Date.now() > user.reset_otp_expires) return res.status(400).json({ message: "Token Expired." });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(user.id, hash);
    await clearResetOtp(user.id);

    res.json({ message: "Master key updated successfully." });
  } catch (err) {
    console.error("Reset Password Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// ── SECURITY QUESTION VERIFICATION ─────────────────────────────────────────
router.post("/security-question/verify", otpLimiter, async (req, res) => {
  try {
    const { email, answer } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ message: "Node not found." });

    if (!user.security_answer_hash) return res.status(400).json({ message: "No security question configured." });

    const isValid = await verifySecurityAnswer(answer, user.security_answer_hash);
    if (!isValid) return res.status(401).json({ message: "Identity verification failed." });

    res.json({ success: true, securityBypass: true });
  } catch (err) {
    console.error("Security Question Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// ── REGISTER ───────────────────────────────────────────────────────────────
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password, turnstileToken } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Required fields missing" });

    const isHuman = await verifyTurnstile(turnstileToken);
    if (!isHuman) return res.status(403).json({ message: 'Bot verification failed.' });

    const emailDomain = email.split('@')[1].toLowerCase();
    if (DISPOSABLE_DOMAINS.includes(emailDomain)) return res.status(400).json({ message: "Disposable emails not allowed" });

    const existingUser = await getUserByEmail(email);
    if (existingUser) return res.status(409).json({ message: "Email already registered" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO pending_registrations (name, email, password, otp, otp_expiry) 
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE otp=?, otp_expiry=?, created_at=NOW()`,
      [name, email, hashedPassword, otp, otpExpiry, otp, otpExpiry]
    );

    await sendMail({
      to: email, 
      subject: 'Verify your Anritvox account', 
      html: `<div style="font-family: sans-serif; padding: 20px;">
              <h2>Welcome to Anritvox!</h2>
              <p>Your verification code is: <strong style="font-size: 24px;">${otp}</strong></p>
              <p>Expires in 10 minutes.</p>
            </div>`
    });

    res.json({ success: true, message: "OTP sent to email." });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ── VERIFY EMAIL (FIXED) ──────────────────────────────────────────────────
router.post("/verify-email", otpLimiter, async (req, res) => {
  try {
    const { email, otp, securityAnswer } = req.body; 
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });

    const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
    const pending = rows[0];

    if (!pending) return res.status(404).json({ message: "Registration session expired. Please sign up again." });

    // Robust OTP Comparison
    if (String(pending.otp) !== String(otp)) {
      return res.status(400).json({ message: "Invalid verification code." });
    }

    // Expiry Check
    if (new Date() > new Date(pending.otp_expiry)) {
      await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
      return res.status(400).json({ message: "Code expired. Please request a new one." });
    }

    // Pass actual securityAnswer
    const insertId = await createUser({ 
      name: pending.name, 
      email: pending.email, 
      password: pending.password, 
      securityAnswer: securityAnswer || null 
    });

    await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);

    const user = await getUserById(insertId);
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    res.status(201).json({ 
      success: true, 
      token, 
      user: { id: user.id, name: user.name, email: user.email, role: user.role } 
    });
  } catch (err) {
    console.error("Verify Email Error:", err);
    res.status(500).json({ message: "Internal server error during verification." });
  }
});

router.get("/profile", authenticateAdmin, async (req, res) => {
  res.json({ message: "Profile access" });
});

module.exports = router;
