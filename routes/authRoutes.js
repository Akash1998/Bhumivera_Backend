const express = require("express"),
  crypto = require("crypto"),
  jwt = require("jsonwebtoken"),
  bcrypt = require("bcryptjs"),
  { authenticator } = require('otplib'),
  pool = require('../config/db'),
  { sendMail } = require('../utils/mail'),
  { registerLimiter, loginLimiter, otpLimiter, forgotLimiter, adminStrictLimiter, magicLinkLimiter, googleCallbackLimiter, challengeLimiter } = require('../middleware/rateLimiter'),
  { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware'),
  { validatePassword } = require('../utils/passwordPolicy'),
  { isPwned } = require('../utils/hibp'),
  { issueToken, isSessionActive, revokeSession, revokeAllSessions, consumeOneTimeToken } = require('../utils/sessionStore');
const {
  isTrustedDevice,
  sendDeviceChallenge,
  consumeDeviceChallenge,
  issueTrustedDevice,
  revokeTrustedDevices,
  clearTrustedDeviceCookie,
} = require('../utils/trustedDevice');
const { hashOtp } = require('../utils/otpCrypto');

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

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();
const hashAdminOtp = (adminId, otp) => hashOtp('admin-login', adminId, otp);

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
    return res.status(403).json({
      code: 'ADMIN_OTP_REQUIRED',
      message: 'Admin access requires the emailed verification code. Use the secure OTP sign-in flow.'
    });
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
    if (isA) {
      return res.status(403).json({
        code: 'ADMIN_OTP_REQUIRED',
        message: 'Admin access requires the emailed verification code. Continue through the secure admin sign-in flow.'
      });
    }
    if (u.two_factor_enabled) {
      return res.status(202).json({
        requires2FA: true,
        factor: 'authenticator',
        message: 'Enter the code from your authenticator app.'
      });
    }
    let deviceHash;
    try {
      deviceHash = await isTrustedDevice(u.id, req);
      if (!deviceHash) {
        await sendDeviceChallenge(u, req);
        return res.status(202).json({
          requires2FA: true,
          factor: 'email',
          message: 'We sent a verification code to your email because this browser is not trusted yet.',
          email: u.email
        });
      }
    } catch (challengeError) {
      console.error('[NEW_DEVICE_CHALLENGE_ERROR]:', challengeError);
      return res.status(503).json({ message: 'Could not verify this browser. Please try again later.' });
    }
    
    const role = isA ? (u.role || "admin") : (u.role || "customer");
    const token = await issueToken({ id: u.id, email: u.email, role }, req, { sessionType: 'user', deviceHash });
    
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

    const target = await getUserByEmail(email);
    if (!target) {
      const admin = await getAdminByEmail(email);
      if (admin) return res.status(403).json({ code: 'ADMIN_PASSWORD_REQUIRED', message: 'Admin OTP requests require a verified password.' });
      return res.status(404).json({ message: "Account not found." });
    }
    if (!target.id) return res.status(500).json({ message: "Internal DB Error: Missing User ID." });

    const otp = generateOtp();
    await saveResetOtp(target.id, otp);

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
      await clearResetOtp(target.id);
      return res.status(503).json({ message: "Could not deliver the verification code. Please try again later." });
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
    let verifiedByEmail = false;
    if (c.two_factor_enabled) {
      if (!c.two_factor_secret || !authenticator.check(normalizedOtp, c.two_factor_secret)) {
        return res.status(401).json({ message: "Invalid MFA token." });
      }
    } else {
      verifiedByEmail = await consumeDeviceChallenge(c.id, normalizedOtp);
      if (!verifiedByEmail) {
        if (!c.reset_otp || normalizedOtp !== String(c.reset_otp) || !c.reset_otp_expires || new Date() > new Date(c.reset_otp_expires)) {
          return res.status(401).json({ message: "Invalid or expired MFA token." });
        }
        const [consumed] = await pool.query(
          'UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=? AND reset_otp=? AND reset_otp_expires >= NOW()',
          [c.id, normalizedOtp]
        );
        if (!consumed.affectedRows) return res.status(401).json({ message: "Invalid or expired MFA token." });
        verifiedByEmail = true;
      }
    }
    const deviceHash = await issueTrustedDevice(c.id, req, res);
    const token = await issueToken({ id: c.id, email: c.email, role: c.role || 'customer' }, req, { sessionType: 'user', deviceHash });
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

    const otp = generateOtp();
    await saveResetOtp(u.id, otp);

    try {
      await sendMail({
        to: email,
        subject: 'Security Key Recovery Protocol',
        html: `<div style="font-family: monospace; padding: 20px; background: #0a0a0a; color: #00ff00;"><h2>Hardware access Access</h2><p>A request was made to recover the security key for this access.</p><h1 style="font-size: 32px; letter-spacing: 4px;">${otp}</h1><p>Token self-destructs in 10 minutes.</p></div>`
      });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      await clearResetOtp(u.id);
      return res.status(503).json({ message: "Could not deliver the verification code. Please try again later." });
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
    const { newPassword } = req.body;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "A verified password-reset token is required." });
    }
    let resetPayload;
    try {
      resetPayload = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET || 'fallback_secret');
    } catch (jwtErr) {
      return res.status(401).json({ message: "Invalid or expired reset token." });
    }
    if (!resetPayload || resetPayload.aud !== 'reset' || resetPayload.scope !== 'reset-password' ||
        !resetPayload.sub || !resetPayload.email || !resetPayload.jti || !resetPayload.exp) {
      return res.status(401).json({ message: "Invalid reset token scope." });
    }
    let targetUser = await getUserByEmail(resetPayload.email);
    if (!targetUser || String(targetUser.id) !== String(resetPayload.sub)) {
      return res.status(401).json({ message: "Reset token does not match an active account." });
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
    if (!await consumeOneTimeToken(resetPayload.jti, resetPayload.exp)) {
      return res.status(401).json({ message: "This reset token has already been used or expired." });
    }
    await pool.query(
      'UPDATE users SET password_hash = ?, last_password_change = NOW() WHERE id = ?',
      [hash, targetUser.id]
    );
    await insertPasswordHistory(targetUser.id, 'customer', hash);
    await clearResetOtp(targetUser.id);
    await revokeAllSessions('user', targetUser.id);
    await revokeTrustedDevices(targetUser.id);
    clearTrustedDeviceCookie(req, res);

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
    const resetJwt = jwt.sign(
      { sub: u.id, email: u.email, aud: 'reset', scope: 'reset-password', role: u.role || 'customer' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '5m', jwtid: crypto.randomUUID() }
    );
    res.json({ success: true, resetJwt });
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
    
    const otp = generateOtp();
    
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
    
    try {
      await sendMail({ to: email, subject: 'Verify your account', html: `<div style="font-family: sans-serif; padding: 20px;"><h2>Welcome!</h2><p>Your verification code is: <strong style="font-size: 24px;">${otp}</strong></p><p>Expires in 10 minutes.</p></div>` });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      await pool.query('DELETE FROM pending_registrations WHERE email=?', [email]);
      return res.status(503).json({ message: "Could not deliver the verification code. Please try again later." });
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
    const deviceHash = await issueTrustedDevice(u.id, req, res);
    const token = await issueToken({ id: u.id, email: u.email, role: u.role || 'customer' }, req, { sessionType: 'user', deviceHash });
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
    const sessionType = payload.sessionType;
    if (!sessionType || !await isSessionActive(payload, req)) {
      return res.status(401).json({ code: 'TOKEN_REVOKED', message: "This refresh token is revoked, expired, or belongs to a different trusted browser. Please sign in again.", userAction: "Clear local storage and log in again." });
    }
    const now = Math.floor(Date.now() / 1000);
    const MAX_REFRESH_AGE_SEC = (sessionType === 'user' ? 30 : 14) * 24 * 60 * 60;
    const sessionStartedAt = payload.sessionStartedAt || payload.iat;
    if (sessionStartedAt && (now - sessionStartedAt) > MAX_REFRESH_AGE_SEC) {
      return res.status(401).json({ code: 'TOKEN_TOO_OLD', message: "Token too old to refresh; please re-login", userAction: "Re-login with password." });
    }
    await revokeSession(payload.jti);
    const role = payload.role || 'customer';
    const NEW_EXPIRES_SEC = 7 * 24 * 60 * 60;
    const freshToken = await issueToken(
      { id: payload.id, email: payload.email, role, sessionStartedAt },
      req,
      { expiresIn: NEW_EXPIRES_SEC, sessionType }
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
      let decoded;
      try {
        decoded = jwt.verify(tok, process.env.JWT_SECRET || 'fallback_secret', { ignoreExpiration: true });
      } catch (verifyErr) {
        return res.status(401).json({ code: 'TOKEN_INVALID', message: 'Invalid session token.' });
      }
      if (decoded && decoded.jti) await revokeSession(decoded.jti);
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
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    const a = await getAdminByEmail(email);
    if (!a || !a.password_hash) return res.status(401).json({ message: 'Invalid admin credentials.' });
    const lockStatus = await getAdminLockStatus(a.id);
    if (lockStatus.locked) {
      const secondsRemaining = lockStatus.lockedUntil
        ? Math.max(0, Math.ceil((new Date(lockStatus.lockedUntil) - new Date()) / 1000))
        : 0;
      return res.status(423).json({ code: 'ACCOUNT_LOCKED', message: 'Account temporarily locked due to multiple failed attempts.', secondsRemaining });
    }
    if (!await verifyAdminPassword(password, a.password_hash)) {
      await updateAdminFailedAttempts(a.id, false);
      return res.status(401).json({ message: 'Invalid admin credentials.' });
    }
    await updateAdminFailedAttempts(a.id, true);
    const otp = generateOtp();
    const otpHash = hashAdminOtp(a.id, otp);
    await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id=?', [otpHash, a.id]);

    try {
      await sendMail({ to: email, subject: 'Admin Login OTP', html: `<p>Your admin login OTP is: <strong>${otp}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>` });
    } catch (mailErr) {
      console.error("Mailjet API Error:", mailErr.message);
      await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE id=?', [a.id]);
      return res.status(503).json({ message: 'Could not deliver the verification code. Please try again later.' });
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
    const otpHash = hashAdminOtp(a.id, otp);
    if (!a.login_otp || String(a.login_otp).length !== otpHash.length || !crypto.timingSafeEqual(Buffer.from(String(a.login_otp)), Buffer.from(otpHash))) {
      return res.status(401).json({ message: 'Invalid or expired OTP.' });
    }

    const [consumed] = await pool.query(
      'UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE id=? AND login_otp=? AND login_otp_expires >= NOW()',
      [a.id, otpHash]
    );
    if (consumed.affectedRows === 0) {
      const [[expiry]] = await pool.query('SELECT login_otp_expires >= NOW() AS valid FROM admin_users WHERE id=?', [a.id]);
      return res.status(401).json({ message: expiry?.valid ? 'Invalid OTP.' : 'OTP expired. Request a new one.' });
    }

    const role = a.role || 'admin';
    const token = await issueToken({ id: a.id, email: a.email, role }, req, { sessionType: 'admin' });
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
    
    const o = generateOtp();
    
    if (iu) {
      await pool.query('UPDATE users SET reset_otp=?, reset_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [o, email]);
    } else {
      await pool.query('UPDATE admin_users SET login_otp=?, login_otp_expires=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE email=?', [hashAdminOtp(t.id, o), email]);
    }

    try {
      await sendMail({ to: email, subject: 'Warehouse Login OTP', html: `<p>Your warehouse login OTP is: <strong>${o}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>` });
    } catch(mailErr) {
      console.error("Mailjet SDK Error:", mailErr.message);
      if (iu) await pool.query('UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=?', [t.id]);
      else await pool.query('UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE id=?', [t.id]);
      return res.status(503).json({ message: 'Could not deliver the verification code. Please try again later.' });
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
    if (!w.login_otp || new Date() > new Date(w.login_otp_expires)) return res.status(401).json({ message: 'Invalid or expired OTP.' });
    if (iu) {
      const [consumed] = await pool.query(
        'UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=? AND reset_otp=? AND reset_otp_expires >= NOW()',
        [w.id, otp]
      );
      if (!consumed.affectedRows) return res.status(401).json({ message: 'Invalid or expired OTP.' });
    } else {
      const otpHash = hashAdminOtp(w.id, String(otp));
      if (String(w.login_otp).length !== otpHash.length || !crypto.timingSafeEqual(Buffer.from(String(w.login_otp)), Buffer.from(otpHash))) {
        return res.status(401).json({ message: 'Invalid or expired OTP.' });
      }
      const [consumed] = await pool.query(
        'UPDATE admin_users SET login_otp=NULL, login_otp_expires=NULL WHERE id=? AND login_otp=? AND login_otp_expires >= NOW()',
        [w.id, otpHash]
      );
      if (!consumed.affectedRows) return res.status(401).json({ message: 'Invalid or expired OTP.' });
    }
    
    const role = 'warehouse_admin';
    const deviceHash = iu ? await issueTrustedDevice(w.id, req, res) : undefined;
    const token = await issueToken({ id: w.id, email: w.email, role }, req, { sessionType: iu ? 'user' : 'admin', deviceHash });
    res.json({ token, admin: { id: w.id, email: w.email, role } });
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
    const [consumed] = await pool.query(
      'UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=? AND reset_otp=? AND reset_otp_expires >= NOW()',
      [u.id, String(otp)]
    );
    if (!consumed.affectedRows) return res.status(400).json({ message: genericFail });

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
      const otp = generateOtp();
      await saveAdminResetOtp(a.id, otp);
      try {
        await sendMail({
          to: email,
          subject: '[Bhumivera] Admin Password Reset OTP',
          html: `<p>Your admin password reset OTP is: <strong style="font-size: 24px;">${otp}</strong></p><p>Valid for 10 minutes.</p>`
        });
      } catch (mailErr) {
        console.error('[ADMIN_RESET_OTP_MAIL_ERROR]:', mailErr.message);
        await clearAdminResetOtp(a.id);
        return res.status(503).json({ message: 'Could not deliver the verification code. Please try again later.' });
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
    const [consumed] = await pool.query(
      'UPDATE admin_users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=? AND reset_otp=? AND reset_otp_expires >= NOW()',
      [a.id, otp]
    );
    if (!consumed.affectedRows) return res.status(400).json({ message: genericFail });
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
    const { newPassword } = req.body;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "A verified admin password-reset token is required." });
    }
    let resetPayload;
    try {
      resetPayload = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET || 'fallback_secret');
    } catch (jwtErr) {
      return res.status(401).json({ message: "Invalid or expired admin reset token." });
    }
    if (!resetPayload || resetPayload.aud !== 'reset' || resetPayload.scope !== 'reset-password' ||
        !resetPayload.sub || !resetPayload.email || !resetPayload.jti || !resetPayload.exp) {
      return res.status(401).json({ message: "Invalid admin reset token scope." });
    }
    const targetAdmin = await getAdminByEmail(resetPayload.email);
    if (!targetAdmin || String(targetAdmin.id) !== String(resetPayload.sub)) {
      return res.status(401).json({ message: "Reset token does not match an admin account." });
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
    if (!await consumeOneTimeToken(resetPayload.jti, resetPayload.exp)) {
      return res.status(401).json({ message: "This reset token has already been used or expired." });
    }
    await pool.query(
      `UPDATE admin_users SET password_hash = ?, 
        failed_attempts = 0, locked_until = NULL
       WHERE id = ?`,
      [hash, targetAdmin.id]
    );
    await insertAdminPasswordHistory(targetAdmin.id, hash);
    await clearAdminResetOtp(targetAdmin.id);
    await revokeAllSessions('admin', targetAdmin.id);

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
