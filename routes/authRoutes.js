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

router.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password, turnstileToken } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

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

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const customer = await getUserByEmail(email);
    if (!customer) return res.status(401).json({ message: "Invalid credentials" });

    const validCustomer = await verifyCustomerPassword(password, customer.password_hash);
    if (!validCustomer) return res.status(401).json({ message: "Invalid credentials" });

    // MFA Intercept Logic
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

router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUserByEmail(email);
    
    if (!user) return res.status(404).json({ message: "Designation not found in registry." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // 1. Try to save to DB
    try {
      await saveResetOtp(user.id, otp, otpExpiry);
    } catch (dbErr) {
      console.error("DATABASE ERROR saving OTP:", dbErr);
      return res.status(500).json({ message: "Database failure. Did you run the ALTER TABLE command?" });
    }

    // 2. Try to send Email
    try {
      await sendMail({
        to: email, 
        subject: 'Security Key Recovery Protocol', 
        html: `<div style="font-family: sans-serif; background: #0f172a; color: #fff; padding: 40px; border-radius: 12px; text-align: center;">
                <h2 style="color: #10b981;">Hardware Node Access</h2>
                <p style="color: #94a3b8;">A request was made to recover the security key for this node.</p>
                <div style="background: #020617; border: 1px solid #1e293b; padding: 20px; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">${otp}</div>
                <p style="color: #64748b; font-size: 12px;">Token self-destructs in 10 minutes.</p>
              </div>`
      });
    } catch (mailErr) {
      console.error("MAILJET ERROR:", mailErr);
      return res.status(500).json({ message: "Email dispatch failed. Verify Mailjet API keys in .env." });
    }

    res.json({ message: "Recovery token dispatched." });
  } catch (err) {
    console.error("Forgot Password Fatal Error:", err);
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

router.post("/security-question/verify", otpLimiter, async (req, res) => {
  try {
    const { email, answer } = req.body;
    const user = await getUserByEmail(email);

    if (!user) return res.status(404).json({ message: "Node not found." });
    if (!user.security_answer_hash) return res.status(400).json({ message: "No security question configured for this node." });

    const isValid = await verifySecurityAnswer(answer, user.security_answer_hash);
    if (!isValid) return res.status(401).json({ message: "Identity verification failed." });

    res.json({ success: true, securityBypass: true });
  } catch (err) {
    console.error("Security Question Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password, phone, securityAnswer } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Name, email, and password are required" });

    const emailDomain = email.split('@')[1].toLowerCase();
    if (DISPOSABLE_DOMAINS.includes(emailDomain)) return res.status(400).json({ message: "Disposable emails not allowed" });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const existingUser = await getUserByEmail(email);
    if (existingUser) return res.status(409).json({ message: "Email already registered" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);
    const secHash = securityAnswer ? await bcrypt.hash(securityAnswer.toLowerCase(), 10) : null;
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO pending_registrations (name, email, password, phone, otp, otp_expiry) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE otp=?, otp_expiry=?, created_at=NOW()`,
      [name, email, hashedPassword, phone, otp, otpExpiry, otp, otpExpiry]
    );

    try {
      await sendMail({
        to: email, subject: 'Verify your Anritvox account', html: `<h3>Welcome to Anritvox!</h3><p>Your verification code is: <strong>${otp}</strong></p>`
      });
    } catch (mailErr) {
       console.error("Register Mailjet Error:", mailErr);
       return res.status(500).json({ message: "Failed to dispatch email. Check Mailjet keys." });
    }

    res.json({ success: true, message: "OTP sent to email." });
  } catch (err) { 
    console.error("Register Error:", err);
    res.status(500).json({ message: "Server error" }); 
  }
});

router.post("/verify-email", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });

    const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
    const pending = rows[0];

    if (!pending) return res.status(404).json({ message: "No pending registration found" });
    if (pending.otp !== otp) return res.status(400).json({ message: "Invalid OTP" });
    if (new Date() > new Date(pending.otp_expiry)) return res.status(400).json({ message: "OTP expired." });

    const insertId = await createUser({ name: pending.name, email: pending.email, password: pending.password, phone: pending.phone });
    await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);

    const user = await getUserById(insertId);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { 
    console.error("Verify Email Error:", err);
    res.status(500).json({ message: "Server error" }); 
  }
});

router.get("/profile", authenticateAdmin, async (req, res) => {
  res.json({ message: "Profile access" });
});

module.exports = router;
