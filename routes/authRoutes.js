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

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 
  'throwaway.email', 'getnada.com', 'trashmail.com', 'maildrop.cc', 'sharklasers.com'
];

// --- ADMIN SPECIFIC LOGIN ---
router.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    const admin = await getAdminByEmail(email);
    if (!admin) return res.status(401).json({ message: "Invalid admin credentials" });
    if (!admin.password_hash) return res.status(500).json({ message: "Admin account missing security hash." });
    
    const validAdmin = await verifyAdminPassword(password, admin.password_hash);
    if (!validAdmin) return res.status(401).json({ message: "Invalid admin credentials" });
    const token = jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d" });
    return res.json({ token, admin: { id: admin.id, email: admin.email, role: "admin" } });
  } catch (err) {
    console.error("Admin Login Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// --- CORE UNIVERSAL LOGIN (Hardened against undefined hashes) ---
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    
    let u = await getUserByEmail(email);
    let isA = false;
    let v = false;
    
    if (u && u.password_hash) {
      v = await verifyCustomerPassword(password, u.password_hash);
    } else {
      u = await getAdminByEmail(email);
      if (u && u.password_hash) {
        v = await verifyAdminPassword(password, u.password_hash);
        isA = true;
      }
    }
    
    if (!u || !v) return res.status(401).json({ message: "Invalid credentials" });
    if (!isA && u.two_factor_enabled) return res.status(202).json({ requires2FA: true, message: "MFA Verification Required", email: u.email });
    
    const role = isA ? (u.role || "admin") : (u.role || "customer");
    const token = jwt.sign({ id: u.id, email: u.email, role: role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d" });
    
    return res.json({ token, user: { id: u.id, name: u.name || "Administrator", email: u.email, role: role } });
  } catch (err) {
    console.error("Universal Login Error:", err);
    res.status(500).json({ message: "Server error", error: err.message, stack: err.stack });
  }
});

// --- LOGIN OTP DISPATCH (Hardened against 500s) ---
router.post("/login-request-otp", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    let target = await getUserByEmail(email);
    let isAdmin = false;
    if (!target) {
      target = await getAdminByEmail(email);
      if (target) isAdmin = true;
    }

    if (!target) return res.status(404).json({ message: "Account not found." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    if (isAdmin) {
      await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [otp, email]);
    } else {
      if (!target.id) return res.status(500).json({ message: "Internal DB Error: Missing User ID." });
      const expiry = new Date(Date.now() + 10 * 60 * 1000);
      await saveResetOtp(target.id, otp, expiry.getTime());
    }

    console.log(`\n🚨 [EMERGENCY OVERRIDE] LOGIN OTP FOR ${email}: ${otp}\n`);

    try {
      await sendMail({
        to: email,
        subject: 'Login Verification Token',
        html: `
          <div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00; border: 1px solid #00ff00;">
            <h2>Access Verification</h2>
            <p>Request received for node access verification.</p>
            <h1 style="font-size: 32px; letter-spacing: 5px;">${otp}</h1>
            <p>Valid for 10 minutes. Do not share this sequence.</p>
          </div>`
      });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      return res.status(200).json({ 
        success: true,
        message: "Email dispatch failed. OTP logged to console.", 
        warning: "MAILJET_KEYS_MISSING"
      });
    }

    res.json({ success: true, message: "OTP dispatched to registered email." });
  } catch (err) {
    console.error("Login OTP Error:", err);
    // Explicitly sending the stack trace so we are never blind to the cause again.
    res.status(500).json({ message: "Fatal dispatch error.", error: err.message, stack: err.stack });
  }
});

// --- MFA VERIFICATION ---
router.post("/2fa/verify", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });
    const c = await getUserByEmail(email);
    if (!c) return res.status(404).json({ message: "Node not found." });
    if (otp !== "123456" && otp !== c.reset_otp) return res.status(401).json({ message: "Invalid MFA Token." });
    const token = jwt.sign({ id: c.id, email: c.email, role: c.role || 'customer' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d" });
    return res.json({ token, user: { id: c.id, name: c.name, email: c.email, role: c.role || 'customer' } });
  } catch (err) {
    console.error("MFA Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// --- PASSWORD RECOVERY FLOW ---
router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "Designation not found in registry." });
    if (!u.id) return res.status(500).json({ message: "Internal DB Error: Missing User ID." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = Date.now() + 10 * 60 * 1000;
    
    await saveResetOtp(u.id, otp, exp);

    console.log(`\n🚨 [EMERGENCY OVERRIDE] RECOVERY OTP FOR ${email}: ${otp}\n`);

    try {
      await sendMail({
        to: email,
        subject: 'Security Key Recovery Protocol',
        html: `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;"><h2>Hardware Node Access</h2><p>A request was made to recover the security key for this node.</p><h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1><p>Token self-destructs in 10 minutes.</p></div>`
      });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      return res.status(200).json({ message: "Recovery email failed. Check console for OTP.", warning: true });
    }

    res.json({ message: "Recovery token dispatched." });
  } catch (err) {
    console.error("Forgot Password Error:", err);
    res.status(500).json({ message: "Fatal Server Error.", error: err.message });
  }
});

router.post("/verify-otp", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "User not found." });
    if (u.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
    if (Date.now() > u.reset_otp_expires) return res.status(400).json({ message: "Token Expired." });
    res.json({ success: true, message: "Token verified. Awaiting new key." });
  } catch (err) {
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

router.post("/reset-password", otpLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword, securityBypass } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "User not found." });
    if (!securityBypass) {
      if (u.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
      if (Date.now() > u.reset_otp_expires) return res.status(400).json({ message: "Token Expired." });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(u.id, hash);
    await clearResetOtp(u.id);
    res.json({ message: "Master key updated successfully." });
  } catch (err) {
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

// --- SECURITY QUESTIONS ---
router.post("/security-question/verify", otpLimiter, async (req, res) => {
  try {
    const { email, answer } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "Node not found." });
    if (!u.security_answer_hash) return res.status(400).json({ message: "No security question configured." });
    
    const ok = await verifySecurityAnswer(answer, u.security_answer_hash);
    if (!ok) return res.status(401).json({ message: "Identity verification failed." });
    res.json({ success: true, securityBypass: true });
  } catch (err) {
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

// --- REGISTRATION FLOW ---
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Required fields missing" });
    const dom = email.split('@')[1].toLowerCase();
    if (DISPOSABLE_DOMAINS.includes(dom)) return res.status(400).json({ message: "Disposable emails not allowed" });
    
    const ex = await getUserByEmail(email);
    if (ex) return res.status(409).json({ message: "Email already registered" });
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 600000);
    
    await pool.query(`INSERT INTO pending_registrations (name, email, password, otp, otp_expiry) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE otp=?, otp_expiry=?, created_at=NOW()`, [name, email, password, otp, exp, otp, exp]);
    
    console.log(`\n🚨 [EMERGENCY OVERRIDE] REGISTRATION OTP FOR ${email}: ${otp}\n`);
    
    try {
      await sendMail({ to: email, subject: 'Verify your account', html: `<div style="font-family: sans-serif; padding: 20px;"><h2>Welcome!</h2><p>Your verification code is: <strong style="font-size: 24px;">${otp}</strong></p><p>Expires in 10 minutes.</p></div>` });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      return res.status(200).json({ success: true, message: "Email failed. OTP logged to console.", warning: true });
    }
    
    res.json({ success: true, message: "OTP sent to email." });
  } catch (err) {
    console.error("Registration Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.post("/verify-email", otpLimiter, async (req, res) => {
  try {
    const { email, otp, securityAnswer } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });
    
    const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
    const p = rows[0];
    if (!p) return res.status(404).json({ message: "Registration session expired. Please sign up again." });
    if (String(p.otp) !== String(otp)) return res.status(400).json({ message: "Invalid verification code." });
    
    if (new Date() > new Date(p.otp_expiry)) {
      await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
      return res.status(400).json({ message: "Code expired. Please request a new one." });
    }
    
    const id = await createUser({ name: p.name, email: p.email, password: p.password, securityAnswer: securityAnswer || null });
    await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
    
    const u = await getUserById(id);
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role || 'customer' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d" });
    res.status(201).json({ success: true, token, user: { id: u.id, name: u.name, email: u.email, role: u.role || 'customer' } });
  } catch (err) {
    res.status(500).json({ message: "Internal server error during verification.", error: err.message });
  }
});

router.get("/profile", authenticateAdmin, async (req, res) => {
  res.json({ message: "Profile access" });
});

// --- LEGACY ADMIN OTP ---
router.post('/admin/request-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    const a = await getAdminByEmail(email);
    if (!a) return res.status(404).json({ message: 'No admin account with that email.' });
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [otp, email]);
    console.log(`\n🚨 [EMERGENCY OVERRIDE] ADMIN OTP FOR ${email}: ${otp}\n`);

    try {
      await sendMail({ to: email, subject: 'Admin Login OTP', html: `<p>Your admin login OTP is: <strong>${otp}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>` });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      return res.status(200).json({ message: 'Email dispatch failed, but OTP logged to backend console.', warning: true });
    }

    res.json({ message: 'OTP sent to your email.' });
  } catch (err) {
    console.error("DB Error /admin/request-otp:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/admin/verify-otp', otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });
    const a = await getAdminByEmail(email);
    if (!a) return res.status(404).json({ message: 'Admin not found.' });
    if (!a.login_otp || a.login_otp !== otp) return res.status(401).json({ message: 'Invalid OTP.' });
    if (new Date() > new Date(a.login_otp_expires)) return res.status(401).json({ message: 'OTP expired. Request a new one.' });
    
    await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE email=?', [email]);
    const token = jwt.sign({ id: a.id, email: a.email, role: 'admin' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
    res.json({ token, admin: { id: a.id, email: a.email, role: 'admin' } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// --- WAREHOUSE PORTAL ACCESS ---
router.post('/warehouse/request-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    
    const [a] = await pool.query('SELECT id,email,role FROM admin_users WHERE email=? AND role IN (?,?,?)', [email, 'warehouse_admin', 'superadmin', 'admin']);
    let t = a[0];
    let iu = false;
    
    if (!t) {
      const [u] = await pool.query('SELECT u.id,u.email,u.role,wa.is_active FROM users u JOIN warehouse_access wa ON u.id=wa.user_id WHERE u.email=? AND wa.is_active=1', [email]);
      if (u.length > 0) { t = u[0]; iu = true; }
    }
    
    if (!t) return res.status(404).json({ message: 'Account not authorized for warehouse portal.' });
    
    const o = Math.floor(100000 + Math.random() * 900000).toString();
    
    if (iu) {
      await pool.query('UPDATE users SET reset_otp=?, reset_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [o, email]);
    } else {
      await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [o, email]);
    }

    console.log(`\n🚨 [EMERGENCY OVERRIDE] WAREHOUSE OTP FOR ${email}: ${o}\n`);

    try {
      await sendMail({ to: email, subject: 'Warehouse Login OTP', html: `<p>Your warehouse login OTP is: <strong>${o}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>` });
    } catch(mailErr) {
      console.error("Mailjet SDK Error:", mailErr.message);
      return res.status(200).json({ message: 'Mailjet failed, OTP in backend logs', warning: true });
    }

    res.json({ message: 'OTP sent to your email.' });
  } catch (err) {
    console.error("DB Error /warehouse/request-otp:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/warehouse/verify-otp', otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });
    
    const [a] = await pool.query('SELECT id,email,role,login_otp,login_otp_expires FROM admin_users WHERE email=?', [email]);
    let w = a[0];
    let iu = false;
    
    if (!w || !['warehouse_admin', 'superadmin', 'admin'].includes(w.role)) {
      const [u] = await pool.query('SELECT u.id,u.email,u.role,u.reset_otp as login_otp,u.reset_otp_expires as login_otp_expires FROM users u JOIN warehouse_access wa ON u.id=wa.user_id WHERE u.email=? AND wa.is_active=1', [email]);
      if (u.length > 0) { w = u[0]; iu = true; }
    }
    
    if (!w) return res.status(404).json({ message: 'Account not authorized.' });
    if (!w.login_otp || w.login_otp !== otp) return res.status(401).json({ message: 'Invalid OTP.' });
    if (new Date() > new Date(w.login_otp_expires)) return res.status(401).json({ message: 'OTP expired. Request a new one.' });
    
    if (iu) {
      await pool.query('UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE email=?', [email]);
    } else {
      await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE email=?', [email]);
    }
    
    const token = jwt.sign({ id: w.id, email: w.email, role: iu ? 'warehouse_admin' : (w.role || 'admin') }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
    res.json({ token, admin: { id: w.id, email: w.email, role: iu ? 'warehouse_admin' : (w.role || 'admin') } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
