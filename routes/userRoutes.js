const express = require('express');
const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const router = express.Router();
const {
  createUser,
  getUserByEmail,
  getUserById,
  verifyPassword,
  updateUser,
  updateUserPassword,
  saveResetOtp,
  clearResetOtp,
} = require('../models/userModel');
const { authenticateUser } = require('../middleware/authMiddleware');
const pool = require('../config/db');

authenticator.options = { window: 1 };

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ message: 'Email already registered' });
    
    const jwt = require('jsonwebtoken');
    const id = await createUser({ name, email, password, phone });
    const token = jwt.sign({ id, email, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ token, user: { id, name, email, phone, role: 'customer' } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getUserByEmail(email);
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (!user.is_active) return res.status(403).json({ message: 'Account is disabled' });
    
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid email or password' });
    
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    return res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Login failed' });
  }
});

router.get('/profile', authenticateUser, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch user' });
  }
});

router.put('/profile', authenticateUser, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    await updateUser(req.user.id, { name, phone });
    const user = await getUserById(req.user.id);
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Update failed' });
  }
});

router.post('/change-password', authenticateUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    
    const user = await getUserByEmail(req.user.email);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });
    
    const hash = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(user.id, hash);
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/security-question', authenticateUser, async (req, res) => {
  try {
    const { question, answer } = req.body;
    const answerHash = await bcrypt.hash(answer.toLowerCase(), 10);
    await pool.query('UPDATE users SET security_question=?, security_answer_hash=? WHERE id=?', [question, answerHash, req.user.id]);
    res.json({ message: "Security question updated." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.post('/2fa/generate', authenticateUser, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.email, 'Bhumivera Store', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauth);
    res.json({ secret, qrCode: qrCodeUrl });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.post('/2fa/enable', authenticateUser, async (req, res) => {
  try {
    const { token, secret } = req.body;
    const isValid = authenticator.verify({ token, secret });
    if (!isValid) return res.status(400).json({ message: "Invalid Authenticator Code." });

    await pool.query('UPDATE users SET two_factor_secret=?, two_factor_enabled=1 WHERE id=?', [secret, req.user.id]);
    res.json({ message: "2FA Enabled Successfully." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

router.post('/2fa/disable', authenticateUser, async (req, res) => {
  try {
    await pool.query('UPDATE users SET two_factor_secret=NULL, two_factor_enabled=0 WHERE id=?', [req.user.id]);
    res.json({ message: "2FA Disabled." });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

module.exports = { router, userAuth: authenticateUser };
