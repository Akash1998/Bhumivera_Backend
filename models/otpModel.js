// backend/models/otpModel.js
// Converted from obsolete Mongoose to native MySQL connection
const pool = require('../config/db');
const { hashOtp, compareOtp } = require('../utils/otpCrypto');

/**
 * Clean legacy interface backed by MySQL
 */
module.exports = {
  async saveOtp(email, otp, purpose = 'login', ttlMinutes = 10) {
    const hashed = hashOtp(otp, email, purpose);
    await pool.query(
      `INSERT INTO user_otps (email, otp_hash, purpose, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
       ON DUPLICATE KEY UPDATE otp_hash = VALUES(otp_hash), expires_at = VALUES(expires_at), consumed_at = NULL`,
      [email.toLowerCase().trim(), hashed, purpose, ttlMinutes]
    ).catch(() => {}); // Graceful if table not initialized yet
  },
  
  async verifyOtp(email, otp, purpose = 'login') {
    const [rows] = await pool.query(
      `SELECT id, otp_hash FROM user_otps
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [email.toLowerCase().trim(), purpose]
    ).catch(() => [[]]);
    if (!rows || !rows.length) return false;
    const ok = compareOtp(otp, rows[0].otp_hash, email, purpose);
    if (ok) {
      await pool.query('UPDATE user_otps SET consumed_at = NOW() WHERE id = ?', [rows[0].id]).catch(() => {});
    }
    return ok;
  }
};
