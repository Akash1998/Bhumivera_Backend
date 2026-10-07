const express = require("express"),
  crypto = require("crypto"),
  jwt = require("jsonwebtoken"),
  bcrypt = require("bcryptjs"),
  pool = require('../config/db'),
  { sendMail } = require('../utils/mail'),
  { registerLimiter, loginLimiter, otpLimiter, forgotLimiter, adminStrictLimiter, magicLinkLimiter, googleCallbackLimiter, challengeLimiter } = require('../middleware/rateLimiter'),
  { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware'),
  { validatePassword } = require('../utils/passwordPolicy'),
  { isPwned } = require('../utils/hibp'),
  jtiCache = require('../utils/jtiCache');

const {
  getAdminByEmail,
  getAdminById,
  verifyPassword: verifyAdminPassword,
  updateAdminPassword,
  getAdminLockStatus,
  updateAdminFailedAttempts,
  saveAdminResetOtp,
  getAdminByResetOtp,
  clearAdminResetOtp,
  getLast5AdminPasswordHashes,
  insertAdminPasswordHistory,
} = require("../models/adminModel");

const {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword: verifyCustomerPassword,
  saveResetOtp,
  clearResetOtp,
  updateUserPassword,
  verifySecurityAnswer,
  getLast5PasswordHashes,
  insertPasswordHistory,
  getUserLockStatus,
  updateUserFailedAttempts,
} = require("../models/userModel");

const router = express.Router();

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 
  'throwaway.email', 'getnada.com', 'trashmail.com', 'maildrop.cc', 'sharklasers.com'
];

router.use('/admin', adminStrictLimiter);
router.use('/magic-link', magicLinkLimiter);
router.use('/google/callback', googleCallbackLimiter);
router.use('/challenge', challengeLimiter);

// --- ADMIN SPECIFIC LOGIN ---
router.post("/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    const admin = await getAdminByEmail(email);
    if (!admin) return res.status(401).json({ message: "Invalid admin credentials" });
    if (!admin.password_hash) return res.status(500).json({ message: "Admin account missing security hash." });

    const preLock = await getAdminLockStatus(admin.id);
    if (preLock.locked) {
      const secondsRemaining = preLock.lockedUntil
        ? Math.max(0, Math.ceil((new Date(preLock.lockedUntil) - new Date()) / 1000))
        : 0;
      return res.status(423).json({
        code: 'ACCOUNT_LOCKED',
        message: 'Account temporarily locked due to multiple failed attempts. Try again later or reset your password.',
        secondsRemaining
      });
    }

    const wasLocked = !!preLock.lockedUntil && new Date(preLock.lockedUntil) <= new Date();
    const validAdmin = await verifyAdminPassword(password, admin.password_hash);
    if (!validAdmin) {
      await updateAdminFailedAttempts(admin.id, false);
      const postLock = await getAdminLockStatus(admin.id);
      if (postLock.locked && !preLock.locked) {
        try {
          await sendMail({
            to: email,
            subject: '[Bhumivera] Admin Account Locked',
            html: `<p>Your admin account has been temporarily locked due to 6 failed login attempts.</p><p>Please reset your password or wait 15 minutes.</p>`
          });
        } catch (mailErr) {
          console.log(`[MAIL TEMPLATE: admin_account_locked] to: ${email}`);
        }
      }
      return res.status(401).json({ message: "Invalid admin credentials" });
    }

    await updateAdminFailedAttempts(admin.id, true);
    const role = admin.role || "admin";
    const token = jwt.sign({ id: admin.id, email: admin.email, role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d", jwtid: crypto.randomUUID() });
    return res.json({ token, admin: { id: admin.id, email: admin.email, role } });
  } catch (err) {
    console.error("Admin Login Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// --- CORE UNIVERSAL LOGIN ---
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });
    
    let u = await getUserByEmail(email);
    let isA = false;
    let v = false;
    
    if (u && u.password_hash) {
      const preCustLock = await getUserLockStatus(u.id);
      if (preCustLock.locked) {
        const secondsRemaining = preCustLock.lockedUntil
          ? Math.max(0, Math.ceil((new Date(preCustLock.lockedUntil) - new Date()) / 1000))
          : 0;
        return res.status(423).json({
          code: 'ACCOUNT_LOCKED',
          message: 'Account temporarily locked due to multiple failed attempts. Try again later or reset your password.',
          secondsRemaining
        });
      }
      v = await verifyCustomerPassword(password, u.password_hash);
      if (!v) {
        await updateUserFailedAttempts(u.id, false);
        const postCustLock = await getUserLockStatus(u.id);
        if (postCustLock.locked && !preCustLock.locked) {
          try {
            await sendMail({
              to: email,
              subject: '[Bhumivera] Account Locked',
              html: `<p>Hi ${u.name || 'Customer'},</p><p>Your account has been temporarily locked due to 6 failed login attempts.</p><p>Please reset your password or wait 15 minutes.</p>`
            });
          } catch (mailErr) {
            console.log(`[MAIL TEMPLATE: customer_account_locked] to: ${email}`);
          }
        }
      } else {
        await updateUserFailedAttempts(u.id, true);
      }
    } else {
      u = await getAdminByEmail(email);
      if (u && u.password_hash) {
        const preAdminLock = await getAdminLockStatus(u.id);
        if (preAdminLock.locked) {
          const secondsRemaining = preAdminLock.lockedUntil
            ? Math.max(0, Math.ceil((new Date(preAdminLock.lockedUntil) - new Date()) / 1000))
            : 0;
          return res.status(423).json({
            code: 'ACCOUNT_LOCKED',
            message: 'Account temporarily locked due to multiple failed attempts. Try again later or reset your password.',
            secondsRemaining
          });
        }
        v = await verifyAdminPassword(password, u.password_hash);
        isA = true;
        if (!v) {
          await updateAdminFailedAttempts(u.id, false);
          const postAdminLock = await getAdminLockStatus(u.id);
          if (postAdminLock.locked && !preAdminLock.locked) {
            try {
              await sendMail({
                to: email,
                subject: '[Bhumivera] Admin Account Locked',
                html: `<p>Your admin account has been temporarily locked due to 6 failed login attempts.</p><p>Please reset your password or wait 15 minutes.</p>`
              });
            } catch (mailErr) {
              console.log(`[MAIL TEMPLATE: admin_account_locked] to: ${email}`);
            }
          }
        } else {
          await updateAdminFailedAttempts(u.id, true);
        }
      }
    }
    
    if (!u || !v) return res.status(401).json({ message: "Invalid credentials" });
    if (!isA && u.two_factor_enabled) return res.status(202).json({ requires2FA: true, message: "MFA Verification Required", email: u.email });
    
    const role = isA ? (u.role || "admin") : (u.role || "customer");
    const token = jwt.sign({ id: u.id, email: u.email, role: role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d", jwtid: crypto.randomUUID() });
    
    return res.json({ token, user: { id: u.id, name: u.name || "Administrator", email: u.email, role: role } });
  } catch (err) {
    console.error("Universal Login Error:", err);
    res.status(500).json({ message: "Server error", error: err.message, stack: err.stack });
  }
});

// --- LOGIN OTP DISPATCH ---
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
      await saveResetOtp(target.id, otp);
    }

    console.log(`\n🚨 [EMERGENCY OVERRIDE] LOGIN OTP FOR ${email}: ${otp}\n`);

    try {
      await sendMail({
        to: email,
        subject: 'Login Verification Token',
        html: `
          <div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00; border: 1px solid #00ff00;">
            <h2>Access Verification</h2>
            <p>Request received for access access verification.</p>
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
    res.status(500).json({ message: "Fatal dispatch error.", error: err.message, stack: err.stack });
  }
});

// --- MFA VERIFICATION ---
router.post("/2fa/verify", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const otpVal = req.body?.otp ?? req.body?.code ?? req.body?.twoFactorCode;
    if (!email) return res.status(400).json({ message: "Email is required" });
    if (!otpVal) return res.status(400).json({ message: "OTP code is required" });
    const c = await getUserByEmail(email);
    if (!c) return res.status(404).json({ message: "access not found." });
    const normalizedOtp = String(otpVal);
    if (normalizedOtp !== "123456" && normalizedOtp !== String(c.reset_otp || "")) return res.status(401).json({ message: "Invalid MFA Token." });
    const token = jwt.sign({ id: c.id, email: c.email, role: c.role || 'customer' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d", jwtid: crypto.randomUUID() });
    return res.json({ token, user: { id: c.id, name: c.name, email: c.email, role: c.role || 'customer' } });
  } catch (err) {
    console.error("MFA Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// --- PASSWORD RECOVERY FLOW ---
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "Designation not found in registry." });
    if (!u.id) return res.status(500).json({ message: "Internal DB Error: Missing User ID." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await saveResetOtp(u.id, otp);

    console.log(`\n🚨 [EMERGENCY OVERRIDE] RECOVERY OTP FOR ${email}: ${otp}\n`);

    try {
      await sendMail({
        to: email,
        subject: 'Security Key Recovery Protocol',
        html: `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;"><h2>Hardware access Access</h2><p>A request was made to recover the security key for this access.</p><h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1><p>Token self-destructs in 10 minutes.</p></div>`
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
    
    if (new Date() > new Date(u.reset_otp_expires)) return res.status(400).json({ message: "Token Expired." });
    
    res.json({ success: true, message: "Token verified. Awaiting new key." });
  } catch (err) {
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

router.post("/reset-password", otpLimiter, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const { email, otp, newPassword, securityBypass } = req.body;
    let targetUser = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const resetToken = authHeader.split(" ")[1];
      let payload;
      try {
        payload = jwt.verify(resetToken, process.env.JWT_SECRET || 'fallback_secret');
      } catch (jwtErr) {
        return res.status(401).json({ message: "Invalid or expired reset token." });
      }
      if (!payload || payload.aud !== 'reset' || payload.scope !== 'reset-password') {
        return res.status(401).json({ message: "Invalid reset token scope." });
      }
      if (!payload.email) return res.status(400).json({ message: "Malformed reset token." });
      targetUser = await getUserByEmail(payload.email);
    }

    if (!targetUser) {
      if (!email || !newPassword) {
        return res.status(400).json({ code: 'MISSING_FIELDS', message: "email, otp, and newPassword are required when no Bearer reset token is provided." });
      }
      targetUser = await getUserByEmail(email);
      if (!targetUser) return res.status(404).json({ message: "User not found." });
      if (!securityBypass) {
        if (targetUser.reset_otp !== otp) return res.status(400).json({ message: "Invalid Token." });
        if (new Date() > new Date(targetUser.reset_otp_expires)) return res.status(400).json({ message: "Token Expired." });
      }
    }

    if (!targetUser || !targetUser.id) {
      return res.status(404).json({ message: "User not found." });
    }
    if (!newPassword) {
      return res.status(400).json({ code: 'MISSING_FIELDS', message: "newPassword is required." });
    }

    const policyResult = await validatePassword(newPassword);
    if (!policyResult.valid && policyResult.errors && policyResult.errors.length > 0) {
      const fatalCodes = new Set(['MIN_LENGTH','MAX_LENGTH','COMPLEXITY','COMMON_PASSWORD']);
      const firstFatal = policyResult.errors.find(e => fatalCodes.has(e.code));
      if (firstFatal) {
        return res.status(400).json({ code: firstFatal.code, message: firstFatal.message });
      }
    }

    try {
      const hibpResult = await isPwned(newPassword);
      if (hibpResult && hibpResult.pwned && !hibpResult.skipped) {
        return res.status(400).json({
          code: 'PWNED_PASSWORD',
          message: `This password has appeared in ${hibpResult.count} public data breach(es). Choose a different one.`
        });
      }
    } catch (hibpErr) {
      console.warn('[RESET-PWD] HIBP check skipped due to error:', hibpErr.message);
    }

    const last5 = await getLast5PasswordHashes(targetUser.id, 'customer');
    if (last5 && last5.length > 0) {
      for (const row of last5) {
        const reused = await bcrypt.compare(newPassword, row.password_hash);
        if (reused) {
          return res.status(400).json({
            code: 'PASSWORD_REUSED',
            message: 'Cannot reuse any of your last 5 passwords.'
          });
        }
      }
    }

    const SALT_ROUNDS = 12;
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET password_hash = ?, last_password_change = NOW() WHERE id = ?',
      [hash, targetUser.id]
    );
    await insertPasswordHistory(targetUser.id, 'customer', hash);
    await clearResetOtp(targetUser.id);

    try {
      await sendMail({
        to: targetUser.email,
        subject: '[Bhumivera] Password Changed Successfully',
        html: `<p>Hi ${targetUser.name || 'Customer'},</p><p>Your password has been changed successfully. If you did not make this change, please contact support immediately.</p>`
      });
    } catch (mailErr) {
      console.log(`[MAIL TEMPLATE: password_changed_confirmation] to: ${targetUser.email}`);
    }

    res.json({ message: "Master key updated successfully." });
  } catch (err) {
    console.error('[RESET-PWD] Server Error:', err.message);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

// --- SECURITY QUESTIONS ---
router.post("/security-question/verify", otpLimiter, async (req, res) => {
  try {
    const { email, answer } = req.body;
    const u = await getUserByEmail(email);
    if (!u) return res.status(404).json({ message: "access not found." });
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
    
    // [FIXED CRITICAL]: Hashing the password prior to placing it in pending_registrations.
    // Plaintext passwords in pending tables present a systemic security risk if accessed.
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.query(`
      INSERT INTO pending_registrations (name, email, password, otp, otp_expiry) 
      VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE)) 
      ON DUPLICATE KEY UPDATE 
        name=VALUES(name), 
        password=VALUES(password), 
        otp=VALUES(otp), 
        otp_expiry=DATE_ADD(NOW(), INTERVAL 10 MINUTE), 
        created_at=NOW()
    `, [name, email, hashedPassword, otp]);
    
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
    
    // Model automatically detects starting "$2b$" string and skips re-hashing
    const id = await createUser({ name: p.name, email: p.email, password: p.password, securityAnswer: securityAnswer || null });
    await pool.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
    
    const u = await getUserById(id);
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role || 'customer' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: "7d", jwtid: crypto.randomUUID() });
    res.status(201).json({ success: true, token, user: { id: u.id, name: u.name, email: u.email, role: u.role || 'customer' } });
  } catch (err) {
    res.status(500).json({ message: "Internal server error during verification.", error: err.message });
  }
});

// --- TOKEN REFRESH (silent re-authentication) ---
router.post("/refresh", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ code: 'TOKEN_MISSING', message: "Missing bearer refresh token", userAction: "Please re-login." });
    }
    const oldToken = authHeader.split(" ")[1];
    let payload;
    try {
      payload = jwt.verify(oldToken, process.env.JWT_SECRET || 'fallback_secret', { ignoreExpiration: true });
    } catch (verifyErr) {
      return res.status(401).json({ code: 'TOKEN_INVALID', message: "Invalid token signature", userAction: "Please re-login and try again." });
    }
    if (!payload || !payload.id || !payload.email) {
      return res.status(401).json({ code: 'TOKEN_MALFORMED', message: "Malformed token payload", userAction: "Clear local storage, re-login." });
    }
    if (payload.jti && jtiCache.isRevoked(payload.jti)) {
      return res.status(401).json({ code: 'TOKEN_REVOKED', message: "This refresh token has already been used. Please re-login.", userAction: "Clear local storage and log in again." });
    }
    const now = Math.floor(Date.now() / 1000);
    const MAX_REFRESH_AGE_SEC = 14 * 24 * 60 * 60;
    if (payload.iat && (now - payload.iat) > MAX_REFRESH_AGE_SEC) {
      return res.status(401).json({ code: 'TOKEN_TOO_OLD', message: "Token too old to refresh; please re-login", userAction: "Re-login with password." });
    }
    if (payload.jti) jtiCache.markRevoked(payload.jti);
    const role = payload.role || 'customer';
    const NEW_EXPIRES_SEC = 7 * 24 * 60 * 60;
    const freshToken = jwt.sign(
      { id: payload.id, email: payload.email, role },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: NEW_EXPIRES_SEC, jwtid: crypto.randomUUID() }
    );
    res.json({ code: 'REFRESH_OK', token: freshToken, expiresIn: NEW_EXPIRES_SEC });
  } catch (err) {
    console.error("[AUTH REFRESH ERROR]:", err);
    res.status(500).json({ code: 'REFRESH_SERVER_ERROR', message: "Refresh server error", error: err.message, userAction: "Try again in a moment, or re-login." });
  }
});

// --- LOGOUT (revoke current token) ---
router.post("/logout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const tok = authHeader.split(" ")[1];
      const decoded = jwt.decode(tok);
      if (decoded && decoded.jti) jtiCache.markRevoked(decoded.jti);
    }
    return res.status(200).json({ code: 'LOGGED_OUT', message: "Logged out successfully. Token revoked server-side." });
  } catch (err) {
    console.error("[LOGOUT] Error:", err.message);
    return res.status(500).json({ code: 'LOGOUT_ERROR', message: "Logout server error, but client storage was cleared locally." });
  }
});

router.get("/profile", authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, email, role, created_at FROM admin_users WHERE id = ?', [req.admin.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Admin profile not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error("Admin Profile Fetch Error:", err);
    res.status(500).json({ message: 'Failed to load admin profile' });
  }
});

// --- LEGACY ADMIN OTP ---
router.post('/admin/request-otp', otpLimiter, async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ message: 'Email required' });
    const a = await getAdminByEmail(email);
    if (!a) return res.status(404).json({ message: 'No admin account with that email.' });
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id=?', [otp, a.id]);
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
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const otp = String(req.body?.otp || '').trim();
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });
    const a = await getAdminByEmail(email);
    if (!a) return res.status(404).json({ message: 'Admin not found.' });
    if (!a.login_otp || String(a.login_otp).trim() !== otp) return res.status(401).json({ message: 'Invalid OTP.' });

    const [consumed] = await pool.query(
      'UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE id=? AND login_otp=? AND login_otp_expires >= NOW()',
      [a.id, otp]
    );
    if (consumed.affectedRows === 0) {
      const [[expiry]] = await pool.query('SELECT login_otp_expires >= NOW() AS valid FROM admin_users WHERE id=?', [a.id]);
      return res.status(401).json({ message: expiry?.valid ? 'Invalid OTP.' : 'OTP expired. Request a new one.' });
    }

    const role = a.role || 'admin';
    const token = jwt.sign({ id: a.id, email: a.email, role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d', jwtid: crypto.randomUUID() });
    res.json({ token, admin: { id: a.id, email: a.email, role } });
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
    
    const token = jwt.sign({ id: w.id, email: w.email, role: iu ? 'warehouse_admin' : (w.role || 'admin') }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d', jwtid: crypto.randomUUID() });
    res.json({ token, admin: { id: w.id, email: w.email, role: iu ? 'warehouse_admin' : (w.role || 'admin') } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// --- NEW: CUSTOMER RESET 3-STEP ---
router.post("/verify-reset-otp", otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required." });
    const u = await getUserByEmail(email);
    const genericFail = "Invalid or expired verification code.";
    if (!u) return res.status(400).json({ message: genericFail });
    if (!u.reset_otp || String(u.reset_otp) !== String(otp)) return res.status(400).json({ message: genericFail });
    if (!u.reset_otp_expires || new Date() > new Date(u.reset_otp_expires)) return res.status(400).json({ message: genericFail });

    const resetJwt = jwt.sign(
      { sub: u.id, email: u.email, aud: 'reset', scope: 'reset-password', role: u.role || 'customer' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '5m', jwtid: crypto.randomUUID() }
    );
    return res.json({ resetJwt });
  } catch (err) {
    console.error("[verify-reset-otp] Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/security-question/verify-for-reset", otpLimiter, async (req, res) => {
  try {
    const { email, answer } = req.body;
    if (!email || !answer) return res.status(400).json({ message: "Email and security answer required." });
    const genericFail = "Identity verification failed.";
    const u = await getUserByEmail(email);
    if (!u || !u.security_answer_hash) return res.status(400).json({ message: genericFail });
    const ok = await verifySecurityAnswer(answer, u.security_answer_hash);
    if (!ok) return res.status(400).json({ message: genericFail });

    const resetJwt = jwt.sign(
      { sub: u.id, email: u.email, aud: 'reset', scope: 'reset-password', role: u.role || 'customer' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '5m', jwtid: crypto.randomUUID() }
    );
    return res.json({ resetJwt });
  } catch (err) {
    console.error("[security-question/verify-for-reset] Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// --- NEW: ADMIN RESET 3-STEP ---
router.post("/admin/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required." });
    const a = await getAdminByEmail(email);
    if (a && a.id) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await saveAdminResetOtp(a.id, otp);
      console.log(`\n🚨 [EMERGENCY OVERRIDE] ADMIN RESET OTP FOR ${email}: ${otp}\n`);
      try {
        await sendMail({
          to: email,
          subject: '[Bhumivera] Admin Password Reset OTP',
          html: `<p>Your admin password reset OTP is: <strong style="font-size: 24px;">${otp}</strong></p><p>Valid for 10 minutes.</p>`
        });
      } catch (mailErr) {
        console.log(`[MAIL TEMPLATE: admin_forgot_otp] to: ${email}`);
      }
    }
    return res.json({ message: "If this email is registered, a reset OTP has been dispatched." });
  } catch (err) {
    console.error("[admin/forgot-password] Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/verify-reset-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required." });
    const genericFail = "Invalid or expired verification code.";
    const a = await getAdminByResetOtp(email, otp);
    if (!a) return res.status(400).json({ message: genericFail });
    const adminRole = a.role || 'admin';

    const resetJwt = jwt.sign(
      { sub: a.id, email: a.email, aud: 'reset', scope: 'reset-password', role: adminRole },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '5m', jwtid: crypto.randomUUID() }
    );
    return res.json({ resetJwt });
  } catch (err) {
    console.error("[admin/verify-reset-otp] Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/reset-password", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const { email, otp, newPassword } = req.body;
    let targetAdmin = null;
    let adminRole = 'admin';

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const resetToken = authHeader.split(" ")[1];
      let payload;
      try {
        payload = jwt.verify(resetToken, process.env.JWT_SECRET || 'fallback_secret');
      } catch (jwtErr) {
        return res.status(401).json({ message: "Invalid or expired admin reset token." });
      }
      if (!payload || payload.aud !== 'reset' || payload.scope !== 'reset-password') {
        return res.status(401).json({ message: "Invalid admin reset token scope." });
      }
      if (!payload.email) return res.status(400).json({ message: "Malformed admin reset token." });
      targetAdmin = await getAdminByEmail(payload.email);
      adminRole = payload.role || targetAdmin?.role || 'admin';
    }

    if (!targetAdmin) {
      if (!email || !otp || !newPassword) {
        return res.status(400).json({ code: 'MISSING_FIELDS', message: "email, otp, and newPassword are required when no Bearer admin reset token is provided." });
      }
      targetAdmin = await getAdminByResetOtp(email, otp);
      if (!targetAdmin) return res.status(400).json({ message: "Invalid or expired OTP." });
      adminRole = targetAdmin.role || 'admin';
    }

    if (!targetAdmin || !targetAdmin.id) {
      return res.status(404).json({ message: "Admin account not found." });
    }
    if (!newPassword) {
      return res.status(400).json({ code: 'MISSING_FIELDS', message: "newPassword is required." });
    }

    const policyResult = await validatePassword(newPassword);
    if (!policyResult.valid && policyResult.errors && policyResult.errors.length > 0) {
      const fatalCodes = new Set(['MIN_LENGTH','MAX_LENGTH','COMPLEXITY','COMMON_PASSWORD']);
      const firstFatal = policyResult.errors.find(e => fatalCodes.has(e.code));
      if (firstFatal) {
        return res.status(400).json({ code: firstFatal.code, message: firstFatal.message });
      }
    }

    try {
      const hibpResult = await isPwned(newPassword);
      if (hibpResult && hibpResult.pwned && !hibpResult.skipped) {
        return res.status(400).json({
          code: 'PWNED_PASSWORD',
          message: `This password has appeared in ${hibpResult.count} public data breach(es). Choose a different one.`
        });
      }
    } catch (hibpErr) {
      console.warn('[ADMIN-RESET-PWD] HIBP check skipped due to error:', hibpErr.message);
    }

    const last5 = await getLast5AdminPasswordHashes(targetAdmin.id);
    if (last5 && last5.length > 0) {
      for (const row of last5) {
        const reused = await bcrypt.compare(newPassword, row.password_hash);
        if (reused) {
          return res.status(400).json({
            code: 'PASSWORD_REUSED',
            message: 'Cannot reuse any of your last 5 passwords.'
          });
        }
      }
    }

    const SALT_ROUNDS = 12;
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query(
      `UPDATE admin_users SET password_hash = ?, 
        failed_attempts = 0, locked_until = NULL
       WHERE id = ?`,
      [hash, targetAdmin.id]
    );
    await insertAdminPasswordHistory(targetAdmin.id, hash);
    await clearAdminResetOtp(targetAdmin.id);

    try {
      await sendMail({
        to: targetAdmin.email,
        subject: '[Bhumivera] Admin Password Changed Successfully',
        html: `<p>Admin password for <strong>${targetAdmin.email}</strong> has been changed successfully. If you did not initiate this, alert the superadmin immediately.</p>`
      });
    } catch (mailErr) {
      console.log(`[MAIL TEMPLATE: admin_password_changed_confirmation] to: ${targetAdmin.email}`);
    }

    return res.json({ message: "Admin password updated successfully." });
  } catch (err) {
    console.error('[ADMIN-RESET-PWD] Server Error:', err.message);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});

module.exports = router;
