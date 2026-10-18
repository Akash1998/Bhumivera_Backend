const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
const authRoutesPath = path.resolve(__dirname, '../routes/authRoutes.js');
const secret = 'auth-route-tests-only-secret-with-more-than-32-characters';

process.env.JWT_SECRET = secret;

const state = {
  admin: { id: 17, email: 'admin@example.com', role: 'admin', login_otp: 'hashed-123456' },
  loginUser: null,
  recoveryUser: null,
  googlePayload: null,
  createdGoogleUser: null,
  sentMail: null,
  activeSession: true,
  otpConsumed: true,
  expiryValid: false,
  issued: [],
  revoked: [],
};

const pass = (_req, _res, next) => next();
const pool = {
  async query(sql, params = []) {
    if (sql.includes('UPDATE admin_users SET login_otp=NULL')) {
      const affectedRows = state.otpConsumed ? 1 : 0;
      state.otpConsumed = false;
      return [{ affectedRows }];
    }
    if (sql.includes('UPDATE users SET reset_otp=NULL, reset_otp_expires=NULL WHERE id=? AND reset_otp=?')) {
      const matchesOtp = state.recoveryUser?.id === params[0] &&
        state.recoveryUser.reset_otp === params[1] &&
        state.recoveryUser.reset_otp_expires > new Date();
      if (matchesOtp) state.recoveryUser.reset_otp = null;
      return [{ affectedRows: matchesOtp ? 1 : 0 }];
    }
    if (sql.includes('SELECT login_otp_expires >= NOW() AS valid')) {
      return [[{ valid: state.expiryValid ? 1 : 0 }]];
    }
    return [{ affectedRows: 1 }];
  },
};

const mocks = new Map([
  ['../config/db', pool],
  ['../utils/mail', { sendMail: async message => { state.sentMail = message; } }],
  ['google-auth-library', {
    OAuth2Client: class {
      async verifyIdToken({ idToken }) {
        if (idToken !== 'valid-google-token') throw new Error('Invalid ID token');
        return { getPayload: () => state.googlePayload };
      }
    },
  }],
  ['../middleware/rateLimiter', new Proxy({}, { get: () => pass })],
  ['../middleware/authMiddleware', { authenticateAdmin: pass, authenticateUser: pass }],
  ['../utils/passwordPolicy', {}],
  ['../utils/hibp', {}],
  ['../utils/sessionStore', {
    issueToken: async (claims, _req, options) => {
      state.issued.push({ claims, options });
      return jwt.sign({
        ...claims,
        sessionType: options.sessionType,
        sessionStartedAt: claims.sessionStartedAt || Math.floor(Date.now() / 1000),
      }, secret, { expiresIn: options.expiresIn || '24h', jwtid: `issued-${state.issued.length}` });
    },
    isSessionActive: async () => state.activeSession,
    revokeSession: async (jti, sessionType) => state.revoked.push({ jti, sessionType }),
    revokeAllSessions: async () => {},
    consumeOneTimeToken: async () => true,
  }],
  ['../utils/trustedDevice', {
    isTrustedDevice: async () => false,
    sendDeviceChallenge: async () => {},
    consumeDeviceChallenge: async () => true,
    issueTrustedDevice: async () => 'device-hash',
    revokeTrustedDevices: async () => {},
    clearTrustedDeviceCookie: () => {},
  }],
  ['../utils/otpCrypto', {
    hashOtp: (_purpose, _id, otp) => `hashed-${otp}`,
    compareOtp: (_purpose, _id, otp, candidateHash) => candidateHash === `hashed-${otp}`,
  }],
  ['../utils/adminTrustedDevice', {
    getTrustedAdminDevice: async () => false,
    trustAdminDevice: async () => {},
    revokeTrustedAdminDevices: async () => {},
  }],
  ['../models/adminModel', {
    getAdminByEmail: async email => email === state.admin.email ? state.admin : null,
  }],
  ['../models/userModel', {
    getUserByEmail: async email => [state.loginUser, state.recoveryUser, state.createdGoogleUser].find(user => user?.email === email) || null,
    getUserByGoogleId: async googleId => [state.loginUser, state.recoveryUser, state.createdGoogleUser].find(user => user?.google_id === googleId) || null,
    getUserById: async id => state.createdGoogleUser?.id === id ? state.createdGoogleUser : null,
    createUser: async user => {
      state.createdGoogleUser = {
        id: 99,
        name: user.name,
        email: user.email,
        role: 'customer',
        google_id: null,
        two_factor_enabled: 0,
      };
      return state.createdGoogleUser.id;
    },
    linkGoogleId: async (userId, googleId) => {
      const user = [state.loginUser, state.recoveryUser, state.createdGoogleUser].find(candidate => candidate?.id === userId);
      if (!user || user.google_id && user.google_id !== googleId) return false;
      user.google_id = googleId;
      return true;
    },
    verifyPassword: async (password, hash) => password === 'correct-password' && hash === 'test-hash',
    getUserLockStatus: async () => ({ locked: false }),
    updateUserFailedAttempts: async () => {},
    saveResetOtp: async (userId, otp) => {
      if (state.recoveryUser?.id === userId) {
        state.recoveryUser.reset_otp = `hashed-${otp}`;
        state.recoveryUser.reset_otp_expires = new Date(Date.now() + 10 * 60 * 1000);
      }
    },
    clearResetOtp: async userId => {
      if (state.recoveryUser?.id === userId) state.recoveryUser.reset_otp = null;
    },
  }],
]);

for (const request of [
  '../models/adminModel',
  '../models/userModel',
  '../utils/trustedDevice',
  '../utils/otpCrypto',
  '../utils/adminTrustedDevice',
]) {
  const resolved = require.resolve(request, { paths: [path.dirname(authRoutesPath)] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mocks.get(request),
    children: [],
    paths: [],
  };
}

Module._load = function (request, parent, isMain) {
  if (parent?.filename === authRoutesPath && mocks.has(request)) return mocks.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

const authRoutes = require(authRoutesPath);
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/auth`;
});

after(async () => {
  const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await serverClosed;
  for (const request of [
    '../models/adminModel',
    '../models/userModel',
    '../utils/trustedDevice',
    '../utils/otpCrypto',
    '../utils/adminTrustedDevice',
  ]) {
    delete require.cache[require.resolve(request, { paths: [path.dirname(authRoutesPath)] })];
  }
});

beforeEach(() => {
  state.activeSession = true;
  state.otpConsumed = true;
  state.expiryValid = false;
  state.recoveryUser = {
    id: 42,
    email: 'customer@example.com',
    role: 'customer',
    google_id: null,
    reset_otp: null,
    reset_otp_expires: null,
  };
  state.loginUser = {
    id: 54,
    email: 'login@example.com',
    name: 'Customer',
    role: 'customer',
    password_hash: 'test-hash',
    two_factor_enabled: 0,
    google_id: null,
  };
  state.createdGoogleUser = null;
  state.googlePayload = {
    sub: 'google-subject-123',
    email: state.recoveryUser.email,
    email_verified: true,
    name: 'Google Customer',
  };
  state.sentMail = null;
  state.issued.length = 0;
  state.revoked.length = 0;
});

describe('admin OTP and token refresh flows', () => {
  it('accepts a valid admin OTP once and prevents it from being replayed', async () => {
    const request = () => fetch(`${baseUrl}/admin/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ' ADMIN@example.com ', otp: '123456' }),
    });

    const response = await request();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.admin.role, 'admin');
    assert.equal(jwt.verify(body.token, secret).sessionType, 'admin');
    assert.equal(state.issued.length, 1);

    const replay = await request();
    assert.equal(replay.status, 401);
    assert.match((await replay.json()).message, /expired/i);
    assert.equal(state.issued.length, 1);
  });

  it('rejects an OTP that has already expired or been consumed', async () => {
    state.otpConsumed = false;
    state.expiryValid = false;

    const response = await fetch(`${baseUrl}/admin/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.admin.email, otp: '123456' }),
    });

    assert.equal(response.status, 401);
    assert.match((await response.json()).message, /expired/i);
    assert.equal(state.issued.length, 0);
  });

  it('refreshes an expired admin access token and revokes the previous session', async () => {
    const oldToken = jwt.sign({
      id: state.admin.id,
      email: state.admin.email,
      role: state.admin.role,
      sessionType: 'admin',
    }, secret, { expiresIn: -1, jwtid: 'old-admin-session' });

    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.code, 'REFRESH_OK');
    assert.equal(jwt.verify(body.token, secret).sessionType, 'admin');
    assert.deepEqual(state.revoked, [{ jti: 'old-admin-session', sessionType: 'admin' }]);
  });

  it('rejects refresh when the session has been revoked', async () => {
    state.activeSession = false;
    const oldToken = jwt.sign({
      id: state.admin.id,
      email: state.admin.email,
      role: state.admin.role,
      sessionType: 'admin',
    }, secret, { expiresIn: -1, jwtid: 'revoked-admin-session' });

    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}` },
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'SESSION_REAUTH_REQUIRED');
    assert.equal(state.issued.length, 0);
  });

  it('requires customer reauthentication after the maximum session age', async () => {
    const oldToken = jwt.sign({
      id: 23,
      email: 'customer@example.com',
      role: 'customer',
      sessionType: 'user',
      sessionStartedAt: Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60,
    }, secret, { expiresIn: -1, jwtid: 'aged-customer-session' });

    const response = await fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}` },
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'SESSION_REAUTH_REQUIRED');
    assert.equal(state.issued.length, 0);
  });
});

describe('customer password login', () => {
  it('allows a password-only login when 2FA is disabled on an untrusted device', async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.loginUser.email, password: 'correct-password' }),
    });

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.user.id, state.loginUser.id);
    assert.equal(jwt.verify(body.token, secret).sessionType, 'user');
    assert.equal(state.sentMail, null);
    assert.equal(state.issued.length, 1);
  });

  it('still requires an authenticator code when customer 2FA is enabled', async () => {
    state.loginUser.two_factor_enabled = 1;
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.loginUser.email, password: 'correct-password' }),
    });

    assert.equal(response.status, 202);
    assert.equal((await response.json()).requires2FA, true);
    assert.equal(state.issued.length, 0);
  });
});

describe('customer Google sign-in', () => {
  const signIn = (body = { idToken: 'valid-google-token', termsAccepted: true }) => fetch(`${baseUrl}/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects invalid Google ID tokens', async () => {
    const response = await signIn({ idToken: 'invalid-token', termsAccepted: true });
    assert.equal(response.status, 401);
    assert.equal(state.issued.length, 0);
  });

  it('rejects Google tokens with unverified email addresses', async () => {
    state.googlePayload.email_verified = false;
    const response = await signIn();
    assert.equal(response.status, 401);
    assert.equal(state.issued.length, 0);
  });

  it('requires acceptance before creating a new Google account', async () => {
    state.googlePayload.email = 'new-customer@example.com';
    const response = await signIn({ idToken: 'valid-google-token' });
    assert.equal(response.status, 428);
    assert.equal(state.createdGoogleUser, null);
  });

  it('creates an account with accepted terms and issues a customer session', async () => {
    state.googlePayload.email = 'new-customer@example.com';
    const response = await signIn();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.id, 99);
    assert.equal(state.createdGoogleUser.google_id, 'google-subject-123');
    assert.equal(jwt.verify(body.token, secret).sessionType, 'user');
  });

  it('links an existing customer using a verified email and enforces enabled 2FA', async () => {
    state.recoveryUser.two_factor_enabled = 1;
    const response = await signIn();
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.requires2FA, true);
    assert.equal(state.recoveryUser.google_id, 'google-subject-123');
    assert.equal(state.issued.length, 0);
  });

  it('rejects privileged accounts from customer Google sign-in', async () => {
    state.recoveryUser.role = 'admin';
    const response = await signIn();
    assert.equal(response.status, 403);
    assert.equal(state.issued.length, 0);
  });
});

describe('customer password recovery', () => {
  it('stores and verifies a hashed reset OTP using the normalized account email', async () => {
    const request = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  CUSTOMER@EXAMPLE.COM  ' }),
    });

    assert.equal(request.status, 200);
    assert.equal(state.sentMail.to, state.recoveryUser.email);
    assert.match(state.recoveryUser.reset_otp, /^hashed-\d{6}$/);

    const otp = state.sentMail.html.match(/<h1[^>]*>(\d{6})<\/h1>/)?.[1];
    assert.ok(otp, 'recovery email should contain the generated OTP');

    const verify = await fetch(`${baseUrl}/verify-reset-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.recoveryUser.email, otp }),
    });
    const body = await verify.json();

    assert.equal(verify.status, 200);
    assert.equal(jwt.verify(body.resetJwt, secret).scope, 'reset-password');
    assert.equal(state.recoveryUser.reset_otp, null);
  });

  it('rejects malformed recovery email addresses before querying the account', async () => {
    const response = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /valid email/i);
    assert.equal(state.sentMail, null);
  });

  it('returns an account-neutral success response when no account matches', async () => {
    state.recoveryUser = null;

    const response = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.com' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, 'If an account exists for this email, password recovery instructions will be sent.');
    assert.equal(state.sentMail, null);
  });
});
