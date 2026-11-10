const crypto = require('crypto');
const pool = require('../config/db');

const COOKIE_NAME = 'bv_admin_trusted_device';
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
  const entry = String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getTrustedAdminDevice(adminId, req) {
  const token = getCookie(req);
  if (!token) return false;
  const tokenHash = hashDeviceToken(token);
  const [rows] = await pool.query(
    `SELECT id FROM admin_trusted_devices
     WHERE admin_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [adminId, tokenHash]
  );
  if (!rows.length) return false;
  await pool.query('UPDATE admin_trusted_devices SET last_seen_at=NOW() WHERE id=?', [rows[0].id]);
  return true;
}

async function trustAdminDevice(adminId, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashDeviceToken(token);
  await pool.query(
    `INSERT INTO admin_trusted_devices
      (admin_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${TRUST_DAYS} DAY))`,
    [adminId, tokenHash, req.get('user-agent') || null, req.ip || null]
  );
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

async function revokeTrustedAdminDevices(adminId) {
  await pool.query(
    'UPDATE admin_trusted_devices SET revoked_at=COALESCE(revoked_at, NOW()) WHERE admin_id=?',
    [adminId]
  );
}

module.exports = { getTrustedAdminDevice, trustAdminDevice, revokeTrustedAdminDevices };
