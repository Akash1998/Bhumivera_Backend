const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser, ROLE_PERMISSIONS } = require('../middleware/authMiddleware');
const { challengeLimiter, loginIpLimiter, loginLimiter } = require('../middleware/rateLimiter');
const { getAdminByEmail, getAdminLockStatus, updateAdminFailedAttempts } = require('../models/adminModel');
const { getUserByEmail, getUserLockStatus } = require('../models/userModel');
const { issueToken } = require('../utils/sessionStore');

const router = express.Router();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = 'Bhumivera';
let webAuthnModulePromise;

const getWebAuthn = () => {
  if (!webAuthnModulePromise) webAuthnModulePromise = import('@simplewebauthn/server');
  return webAuthnModulePromise;
};

const getAccountType = value => value === 'admin' ? 'admin' : value === 'customer' ? 'customer' : null;

const getWebAuthnConfig = req => {
  const origin = req.get('origin');
  if (typeof origin !== 'string' || !origin) {
    const error = new Error('Passkey requests must include an allowed website origin.');
    error.status = 400;
    throw error;
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    const error = new Error('Passkey website origin is invalid.');
    error.status = 400;
    throw error;
  }
  if (!['https:', 'http:'].includes(parsedOrigin.protocol) ||
      (parsedOrigin.protocol !== 'https:' && parsedOrigin.hostname !== 'localhost' && parsedOrigin.hostname !== '127.0.0.1')) {
    const error = new Error('Passkeys require a secure website origin.');
    error.status = 400;
    throw error;
  }

  const configuredOrigins = (process.env.WEBAUTHN_ORIGINS || process.env.FRONTEND_ORIGINS ||
    'https://bhumivera.com,https://www.bhumivera.com,http://localhost:5173,http://localhost:3000')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (!configuredOrigins.includes(origin)) {
    const error = new Error('Passkey website origin is not allowed.');
    error.status = 403;
    throw error;
  }

  const hostname = parsedOrigin.hostname.toLowerCase();
  const rpID = (process.env.WEBAUTHN_RP_ID || hostname.replace(/^www\./, '')).toLowerCase();
  if (hostname !== rpID && !hostname.endsWith(`.${rpID}`)) {
    const error = new Error('Passkey relying-party ID does not match this website.');
    error.status = 500;
    throw error;
  }
  return { origin, rpID };
};

const getAuthenticatedOwner = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Sign in before managing passkeys.' });
  }

  let payload;
  try {
    payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET || 'fallback_secret');
  } catch {
    return res.status(401).json({ message: 'Your sign-in has expired. Please sign in again.' });
  }

  if (payload.role === 'warehouse_admin') {
    return res.status(403).json({ message: 'Warehouse accounts cannot manage passkeys.' });
  }
  if (ROLE_PERMISSIONS[payload.role]) return authenticateAdmin(req, res, next);
  return authenticateUser(req, res, next);
};

const getOwner = req => {
  const accountType = ROLE_PERMISSIONS[req.user?.role] ? 'admin' : 'customer';
  return { accountType, accountId: req.user.id };
};

const getPasskeys = async (accountType, accountId) => {
  const [rows] = await pool.query(
    `SELECT id, credential_id, public_key, counter, transports, device_name, created_at, last_used_at
     FROM webauthn_credentials WHERE account_type = ? AND account_id = ?`,
    [accountType, accountId]
  );
  return rows;
};

const createChallenge = async ({ purpose, accountType, accountId, challenge, origin, rpID }) => {
  const challengeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await pool.query(
    `INSERT INTO webauthn_challenges
      (challenge_id, purpose, account_type, account_id, challenge, origin, rp_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [challengeId, purpose, accountType, accountId, challenge, origin, rpID, expiresAt]
  );
  return challengeId;
};

const consumeChallenge = async (challengeId, purpose) => {
  if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(challengeId)) return null;
  const [result] = await pool.query(
    `UPDATE webauthn_challenges SET consumed_at = NOW()
     WHERE challenge_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [challengeId, purpose]
  );
  if (!result.affectedRows) return null;
  const [rows] = await pool.query(
    `SELECT challenge_id, account_type, account_id, challenge, origin, rp_id
     FROM webauthn_challenges WHERE challenge_id = ?`,
    [challengeId]
  );
  return rows[0] || null;
};

const getAccountForLogin = async (accountType, email) => {
  if (accountType === 'admin') {
    const account = await getAdminByEmail(email);
    if (!account || !['admin', 'superadmin'].includes(account.role || 'admin')) return null;
    return { ...account, accountType: 'admin' };
  }

  const account = await getUserByEmail(email);
  if (!account || account.role !== 'customer' || Number(account.is_active) === 0) return null;
  return { ...account, accountType: 'customer' };
};

const getAccountById = async (accountType, accountId) => {
  if (accountType === 'admin') {
    const [rows] = await pool.query(
      'SELECT id, email, role FROM admin_users WHERE id = ? LIMIT 1',
      [accountId]
    );
    const account = rows[0];
    if (!account || !['admin', 'superadmin'].includes(account.role || 'admin')) return null;
    return { ...account, role: account.role || 'admin' };
  }

  const [rows] = await pool.query(
    `SELECT id, name, email, role, is_active, two_factor_enabled
     FROM users WHERE id = ? AND role = 'customer' AND is_active = 1 LIMIT 1`,
    [accountId]
  );
  return rows[0] || null;
};

router.post('/register-challenge', getAuthenticatedOwner, challengeLimiter, async (req, res) => {
  try {
    const { accountType, accountId } = getOwner(req);
    const account = await getAccountById(accountType, accountId);
    if (!account) return res.status(404).json({ message: 'The signed-in account is not available.' });

    const { origin, rpID } = getWebAuthnConfig(req);
    const { generateRegistrationOptions } = await getWebAuthn();
    const existing = await getPasskeys(accountType, accountId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userID: crypto.createHash('sha256').update(`bhumivera:${accountType}:${accountId}`).digest(),
      userName: account.email,
      userDisplayName: account.name || account.email,
      attestationType: 'none',
      excludeCredentials: existing.map(credential => ({
        id: credential.credential_id,
        transports: typeof credential.transports === 'string'
          ? JSON.parse(credential.transports)
          : credential.transports || undefined,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const challengeId = await createChallenge({
      purpose: 'registration',
      accountType,
      accountId,
      challenge: options.challenge,
      origin,
      rpID,
    });
    await pool.query('DELETE FROM webauthn_challenges WHERE expires_at <= NOW()');
    return res.json({ challengeId, options });
  } catch (error) {
    console.error('[PASSKEY_REGISTER_CHALLENGE]', error);
    return res.status(error.status || 500).json({
      message: error.status ? error.message : 'Could not start passkey registration.',
    });
  }
});

router.post('/register-verify', getAuthenticatedOwner, challengeLimiter, async (req, res) => {
  try {
    const { challengeId, response, deviceName } = req.body || {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ message: 'A passkey registration response is required.' });
    }
    const { accountType, accountId } = getOwner(req);
    const challenge = await consumeChallenge(challengeId, 'registration');
    if (!challenge || challenge.account_type !== accountType || String(challenge.account_id) !== String(accountId)) {
      return res.status(400).json({ message: 'Passkey registration challenge is invalid or expired. Please try again.' });
    }

    const { verifyRegistrationResponse } = await getWebAuthn();
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ message: 'The authenticator could not be verified. Please try again.' });
    }

    const credential = verification.registrationInfo.credential;
    const transports = Array.isArray(credential.transports) ? credential.transports : [];
    const cleanName = typeof deviceName === 'string' ? deviceName.trim().slice(0, 100) : '';
    try {
      await pool.query(
        `INSERT INTO webauthn_credentials
          (account_type, account_id, credential_id, public_key, counter, transports, device_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          accountType,
          accountId,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(transports),
          cleanName || 'Passkey device',
        ]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'This passkey is already registered.' });
      }
      throw error;
    }
    return res.status(201).json({ message: 'Passkey registered successfully.' });
  } catch (error) {
    console.error('[PASSKEY_REGISTER_VERIFY]', error);
    return res.status(error.status || 500).json({
      message: error.status ? error.message : 'Could not verify passkey registration.',
    });
  }
});

router.post('/login-challenge', loginIpLimiter, challengeLimiter, async (req, res) => {
  try {
    const accountType = getAccountType(req.body?.accountType);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!accountType) {
      return res.status(400).json({ message: 'A valid account type is required.' });
    }
    let account = null;
    let credentials = [];
    if (email) {
      account = await getAccountForLogin(accountType, email);
      if (!account) return res.status(404).json({ message: 'No passkey sign-in is available for this account.' });
      credentials = await getPasskeys(accountType, account.id);
      if (!credentials.length) {
        return res.status(404).json({ message: 'No passkey is registered for this account. Sign in another way and add one in Security settings.' });
      }
    }

    const { origin, rpID } = getWebAuthnConfig(req);
    const { generateAuthenticationOptions } = await getWebAuthn();
    const options = await generateAuthenticationOptions({
      rpID,
      ...(email ? {
        allowCredentials: credentials.map(credential => ({
          id: credential.credential_id,
          transports: typeof credential.transports === 'string'
            ? JSON.parse(credential.transports)
            : credential.transports || undefined,
        })),
      } : {}),
      userVerification: 'required',
    });
    const challengeId = await createChallenge({
      purpose: 'authentication',
      accountType,
      accountId: account?.id ?? null,
      challenge: options.challenge,
      origin,
      rpID,
    });
    await pool.query('DELETE FROM webauthn_challenges WHERE expires_at <= NOW()');
    return res.json({ challengeId, options });
  } catch (error) {
    console.error('[PASSKEY_LOGIN_CHALLENGE]', error);
    return res.status(error.status || 500).json({
      message: error.status ? error.message : 'Could not start passkey sign-in.',
    });
  }
});

router.post('/login-verify', loginIpLimiter, loginLimiter, async (req, res) => {
  try {
    const { challengeId, response } = req.body || {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ message: 'A passkey authentication response is required.' });
    }
    const challenge = await consumeChallenge(challengeId, 'authentication');
    if (!challenge) return res.status(401).json({ message: 'Passkey sign-in challenge expired. Please try again.' });

    const credentialId = typeof response.id === 'string' ? response.id : response.rawId;
    if (typeof credentialId !== 'string' || !credentialId) {
      return res.status(400).json({ message: 'Passkey response is missing its credential ID.' });
    }
    const [credentialRows] = await pool.query(
      `SELECT id, account_type, account_id, credential_id, public_key, counter, transports
       FROM webauthn_credentials WHERE credential_id = ? AND account_type = ? LIMIT 1`,
      [credentialId, challenge.account_type]
    );
    const credential = credentialRows[0];
    if (!credential || (challenge.account_id !== null &&
        String(credential.account_id) !== String(challenge.account_id))) {
      return res.status(401).json({ message: 'Passkey could not be verified for this account.' });
    }

    const account = await getAccountById(challenge.account_type, credential.account_id);
    if (!account) return res.status(401).json({ message: 'This account is not available for sign-in.' });

    const { verifyAuthenticationResponse } = await getWebAuthn();
    const transports = typeof credential.transports === 'string'
      ? JSON.parse(credential.transports)
      : credential.transports || undefined;
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      credential: {
        id: credential.credential_id,
        publicKey: credential.public_key,
        counter: Number(credential.counter),
        transports,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return res.status(401).json({ message: 'Passkey could not be verified. Please try again.' });
    }

    const { newCounter } = verification.authenticationInfo;
    const [counterUpdate] = await pool.query(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = NOW(6)
       WHERE id = ? AND counter = ?`,
      [newCounter, credential.id, credential.counter]
    );
    if (!counterUpdate.affectedRows) {
      return res.status(401).json({ message: 'This passkey response has already been used. Please try again.' });
    }

    if (challenge.account_type === 'admin') {
      const lockStatus = await getAdminLockStatus(account.id);
      if (lockStatus.locked) {
        return res.status(423).json({ message: 'This admin account is temporarily locked. Please try again later.' });
      }
      await updateAdminFailedAttempts(account.id, true);
      const token = await issueToken(
        { id: account.id, email: account.email, role: account.role || 'admin' },
        req,
        { sessionType: 'admin' }
      );
      return res.json({
        token,
        admin: { id: account.id, email: account.email, role: account.role || 'admin' },
      });
    }

    const lockStatus = await getUserLockStatus(account.id);
    if (lockStatus.locked) {
      return res.status(423).json({ message: 'This account is temporarily locked. Please try again later.' });
    }
    if (account.two_factor_enabled) {
      return res.status(202).json({
        requires2FA: true,
        factor: 'authenticator',
        email: account.email,
        message: 'Enter the code from your authenticator app.',
      });
    }
    const token = await issueToken(
      { id: account.id, email: account.email, role: account.role || 'customer' },
      req,
      { sessionType: 'user' }
    );
    return res.json({
      token,
      user: { id: account.id, name: account.name, email: account.email, role: account.role || 'customer' },
    });
  } catch (error) {
    console.error('[PASSKEY_LOGIN_VERIFY]', error);
    return res.status(error.status || 500).json({
      message: error.status ? error.message : 'Could not verify passkey sign-in.',
    });
  }
});

router.get('/list', getAuthenticatedOwner, async (req, res) => {
  try {
    const { accountType, accountId } = getOwner(req);
    const passkeys = await getPasskeys(accountType, accountId);
    return res.json({
      passkeys: passkeys.map(passkey => ({
        id: passkey.id,
        device_name: passkey.device_name,
        created_at: passkey.created_at,
        last_used_at: passkey.last_used_at,
      })),
    });
  } catch (error) {
    console.error('[PASSKEY_LIST]', error);
    return res.status(500).json({ message: 'Could not load registered passkeys.' });
  }
});

router.delete('/:id', getAuthenticatedOwner, async (req, res) => {
  try {
    const { accountType, accountId } = getOwner(req);
    const [result] = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id = ? AND account_type = ? AND account_id = ?',
      [req.params.id, accountType, accountId]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Passkey not found.' });
    return res.json({ message: 'Passkey removed.' });
  } catch (error) {
    console.error('[PASSKEY_DELETE]', error);
    return res.status(500).json({ message: 'Could not remove passkey.' });
  }
});

module.exports = router;
