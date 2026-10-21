const pool = require('../config/db');

const ALLOWED_SCOPES = ['register', 'login2fa', 'forgot', 'admin_forgot', 'challenge', 'warehouse'];

function getAllowedScopes() {
  return ALLOWED_SCOPES;
}

async function canSendOtp(scope, email) {
  if (!ALLOWED_SCOPES.includes(scope)) {
    throw new Error('Invalid scope');
  }
  const normalizedEmail = email.toLowerCase();

  const [rows] = await pool.query(
    'SELECT * FROM otp_attempts WHERE scope=? AND email=? LIMIT 1',
    [scope, normalizedEmail]
  );

  if (rows.length > 0) {
    const row = rows[0];
    const now = new Date();
    const nextAllowedAt = new Date(row.next_allowed_at);
    if (now < nextAllowedAt) {
      const diffMs = nextAllowedAt - now;
      const retryAfterSec = Math.ceil(diffMs / 1000);
      return {
        allowed: false,
        nextAllowedAt: nextAllowedAt,
        retryAfterSec: retryAfterSec,
        attemptCount: row.attempt_count
      };
    } else {
      return {
        allowed: true,
        nextAllowedAt: nextAllowedAt,
        retryAfterSec: 0,
        attemptCount: row.attempt_count
      };
    }
  }

  return {
    allowed: true,
    nextAllowedAt: null,
    retryAfterSec: 0,
    attemptCount: 0
  };
}

async function recordOtpAttempt(scope, email) {
  if (!ALLOWED_SCOPES.includes(scope)) {
    throw new Error('Invalid scope');
  }
  const normalizedEmail = email.toLowerCase();

  const [result] = await pool.query(
    `INSERT INTO otp_attempts (scope, email, attempt_count, backoff_seconds, last_attempt_at, next_allowed_at)
     VALUES (?, ?, 1, 30, NOW(), DATE_ADD(NOW(), INTERVAL 30 SECOND))
     ON DUPLICATE KEY UPDATE
       attempt_count = attempt_count + 1,
       backoff_seconds = CASE WHEN attempt_count+1 = 1 THEN 30 WHEN attempt_count+1 = 2 THEN 60 WHEN attempt_count+1 = 3 THEN 180 ELSE 600 END,
       last_attempt_at = NOW(),
       next_allowed_at = DATE_ADD(NOW(), INTERVAL (CASE WHEN attempt_count+1 = 1 THEN 30 WHEN attempt_count+1 = 2 THEN 60 WHEN attempt_count+1 = 3 THEN 180 ELSE 600 END) SECOND)`,
    [scope, normalizedEmail]
  );

  const [rows] = await pool.query(
    'SELECT attempt_count, backoff_seconds, next_allowed_at FROM otp_attempts WHERE scope=? AND email=? LIMIT 1',
    [scope, normalizedEmail]
  );

  const row = rows[0];
  return {
    attemptCount: row.attempt_count,
    backoffSeconds: row.backoff_seconds,
    nextAllowedAt: new Date(row.next_allowed_at)
  };
}

async function resetOtpAttempts(scope, email) {
  if (!ALLOWED_SCOPES.includes(scope)) {
    throw new Error('Invalid scope');
  }
  const normalizedEmail = email.toLowerCase();

  const [result] = await pool.query(
    'DELETE FROM otp_attempts WHERE scope=? AND email=?',
    [scope, normalizedEmail]
  );

  return result.affectedRows;
}

module.exports = {
  canSendOtp,
  recordOtpAttempt,
  resetOtpAttempts,
  getAllowedScopes
};
