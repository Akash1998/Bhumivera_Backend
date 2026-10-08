const crypto = require('crypto');
const pool = require('../config/db');
const { sendMail } = require('./mail');
const { hashOtp } = require('./otpCrypto');

const COOKIE_NAME = 'bv_trusted_device';
const TRUST_DAYS = 30;

function cookieOptions(req) {
  const bhumiveraHost = /(^|\.)bhumivera\.com$/i.test(req.hostname || '');
  const options = {
    httpOnly: true,
    secure: Boolean(req.secure || bhumiveraHost),
    sameSite: 'lax',
    path: '/',
    maxAge: TRUST_DAYS * 24 * 60 * 60 * 1000,
  };
  if (bhumiveraHost) options.domain = process.env.TRUSTED_DEVICE_COOKIE_DOMAIN || '.bhumivera.com';
  return options;
}

function getCookie(req) {
  const prefix = `${COOKIE_NAME}=`;
  const entry = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getRequestDeviceHash(req) {
  const token = getCookie(req);
  return token ? hashDeviceToken(token) : null;
}

async function getTrustedDeviceHash(userId, req) {
  const token = getCookie(req);
  if (!token) return null;
  const tokenHash = getRequestDeviceHash(req);
  const [rows] = await pool.query(
    'SELECT id FROM trusted_devices WHERE user_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1',
    [userId, tokenHash]
  );
  if (!rows.length) return null;
  await pool.query('UPDATE trusted_devices SET last_seen_at=NOW() WHERE id=?', [rows[0].id]);
  return tokenHash;
}

async function isTrustedDevice(userId, req) {
  return getTrustedDeviceHash(userId, req);
}

async function sendDeviceChallenge(user, req) {
  const otp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = hashOtp('new-device', user.id, otp);
  await pool.query(
    "UPDATE new_device_alerts SET used=1 WHERE user_id=? AND role='customer' AND used=0",
    [user.id]
  );
  const [result] = await pool.query(
    `INSERT INTO new_device_alerts
      (user_id, role, ip, user_agent, challenge_code, challenge_hash, expires_at, used)
     VALUES (?, 'customer', ?, ?, NULL, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0)`,
    [user.id, req.ip || null, req.get('user-agent') || null, otpHash]
  );
  try {
    await sendMail({
      to: user.email,
      subject: 'Verify this new Bhumivera sign-in',
      html: `<p>A sign-in from a new browser was requested for your Bhumivera account.</p><p>Your verification code is <strong>${otp}</strong>. It expires in 10 minutes. If this was not you, change your password.</p>`,
    });
  } catch (error) {
    await pool.query('UPDATE new_device_alerts SET used=1 WHERE id=?', [result.insertId]);
    throw error;
  }
}

async function consumeDeviceChallenge(userId, otp) {
  const otpHash = hashOtp('new-device', userId, String(otp));
  const [rows] = await pool.query(
    `SELECT id FROM new_device_alerts
     WHERE user_id=? AND role='customer' AND challenge_hash=? AND used=0 AND expires_at >= NOW()
     ORDER BY id DESC LIMIT 1`,
    [userId, otpHash]
  );
  if (!rows.length) return false;
  const [result] = await pool.query(
    'UPDATE new_device_alerts SET used=1 WHERE id=? AND used=0 AND expires_at >= NOW()',
    [rows[0].id]
  );
  return result.affectedRows === 1;
}

async function issueTrustedDevice(userId, req, res) {
  const existingHash = await getTrustedDeviceHash(userId, req);
  if (existingHash) return existingHash;
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashDeviceToken(token);
  await pool.query(
    `INSERT INTO trusted_devices (user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${TRUST_DAYS} DAY))`,
    [userId, tokenHash, req.get('user-agent') || null, req.ip || null]
  );
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  return tokenHash;
}

async function revokeTrustedDevices(userId) {
  await pool.query(
    'UPDATE trusted_devices SET revoked_at=COALESCE(revoked_at, NOW()) WHERE user_id=?',
    [userId]
  );
}

function clearTrustedDeviceCookie(req, res) {
  const options = cookieOptions(req);
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
}

module.exports = {
  isTrustedDevice,
  getTrustedDeviceHash,
  getRequestDeviceHash,
  sendDeviceChallenge,
  consumeDeviceChallenge,
  issueTrustedDevice,
  revokeTrustedDevices,
  clearTrustedDeviceCookie,
};
