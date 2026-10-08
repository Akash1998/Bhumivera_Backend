const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { getTrustedDeviceHash, getRequestDeviceHash } = require('./trustedDevice');

const TABLES = {
  user: 'user_sessions',
  admin: 'admin_sessions',
};

async function issueToken(claims, req, { sessionType = 'user', expiresIn = sessionType === 'admin' ? '24h' : '7d', deviceHash: providedDeviceHash } = {}) {
  const table = TABLES[sessionType];
  if (!table) throw new Error('Unknown session type.');
  const jti = crypto.randomUUID();
  const sessionStartedAt = claims.sessionStartedAt || Math.floor(Date.now() / 1000);
  const deviceHash = sessionType === 'user'
    ? providedDeviceHash || await getTrustedDeviceHash(claims.id, req)
    : undefined;
  if (sessionType === 'user' && !deviceHash) throw new Error('A verified trusted-device cookie is required to issue this session.');
  const token = jwt.sign({ ...claims, sessionStartedAt, sessionType, ...(deviceHash ? { deviceHash } : {}) }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn, jwtid: jti });
  const expiresAt = sessionType === 'user'
    ? new Date((sessionStartedAt + 30 * 24 * 60 * 60) * 1000)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (sessionType === 'user') {
    await pool.query(
      `INSERT INTO user_sessions (user_id, jti, device_hash, ip, user_agent, expires_at, is_current)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [claims.id, jti, deviceHash, req.ip || null, req.get('user-agent') || null, expiresAt]
    );
  } else {
    await pool.query(
      `INSERT INTO admin_sessions (admin_id, jti, ip, user_agent, expires_at, is_current)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [claims.id, jti, req.ip || null, req.get('user-agent') || null, expiresAt]
    );
  }
  return token;
}

async function isSessionActive(payload, req) {
  if (!payload?.jti) return false;
  let rows;
  if (payload.sessionType === 'user') {
    const deviceHash = getRequestDeviceHash(req);
    if (!deviceHash || deviceHash !== payload.deviceHash) return false;
    [rows] = await pool.query(
      `SELECT s.jti FROM user_sessions s
       JOIN trusted_devices d ON d.user_id=s.user_id AND d.token_hash=s.device_hash
       WHERE s.jti=? AND s.device_hash=? AND s.revoked_at IS NULL AND s.expires_at > NOW()
         AND d.revoked_at IS NULL AND d.expires_at > NOW()
       LIMIT 1`,
      [payload.jti, deviceHash]
    );
  } else if (payload.sessionType === 'admin') {
    [rows] = await pool.query(
      `UPDATE admin_sessions
       SET last_seen_at=NOW(), expires_at=DATE_ADD(NOW(), INTERVAL 24 HOUR)
       WHERE jti=? AND revoked_at IS NULL AND expires_at > NOW()`,
      [payload.jti]
    );
    return rows.affectedRows === 1;
  } else {
    return false;
  }
  return rows.length > 0;
}

async function revokeSession(jti, sessionType) {
  if (!jti) return;
  const table = sessionType && TABLES[sessionType];
  if (table) {
    await pool.query(
      `UPDATE ${table} SET revoked_at = COALESCE(revoked_at, NOW()) WHERE jti = ?`,
      [jti]
    );
    return;
  }
  await Promise.all([
    pool.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE jti = ?', [jti]),
    pool.query('UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE jti = ?', [jti]),
  ]);
}

async function revokeAllSessions(sessionType, accountId) {
  const table = TABLES[sessionType];
  const idColumn = sessionType === 'admin' ? 'admin_id' : 'user_id';
  if (!table) throw new Error('Unknown session type.');
  await pool.query(
    `UPDATE ${table} SET revoked_at = COALESCE(revoked_at, NOW()) WHERE ${idColumn} = ?`,
    [accountId]
  );
}

async function consumeOneTimeToken(jti, expiresAt) {
  if (!jti || !expiresAt) return false;
  try {
    await pool.query(
      'INSERT INTO used_auth_tokens (jti, expires_at) VALUES (?, FROM_UNIXTIME(?))',
      [jti, expiresAt]
    );
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

module.exports = { issueToken, isSessionActive, revokeSession, revokeAllSessions, consumeOneTimeToken };
