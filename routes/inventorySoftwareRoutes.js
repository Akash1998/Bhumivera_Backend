const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { isSessionActive } = require('../utils/sessionStore');
const { invalidatePublicCatalogCache } = require('../middleware/redisResponseCache');
const { updateOrderStatus } = require('../models/orderModel');
const { sendOrderStatusEmail } = require('../utils/mail');
const { executeAtomicOrderCancellationAndRefund } = require('../services/walletRefundLedgerService');
const { getRazorpayClient } = require('../services/razorpayService');
const {
  beginShippingLabel,
  updateLabelRecord,
  getShippingLabel,
  getShippingLabels,
  logShippingLabelEvent,
} = require('../models/shippingLabelModel');
const {
  PROVIDERS,
  saveAndTestCarrierConfiguration,
  getPublicCarrierStatus,
  createLabelWithProvider,
  prepareLabelOrder,
} = require('../services/carrierLabelService');
const {
  buildStandaloneProductQr,
  computeOptimalA4QrLayout,
  VALID_INVENTORY_ROLES,
  INVENTORY_PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_INVENTORY_PERMISSIONS,
  resolveInventoryPermissions,
  generateTotpSecret,
  verifyTotpCode,
  calculateEstimatedDeliveryDate,
  ensureInventorySoftwareTables,
  syncWebsiteProductsToInventoryMeta,
  recalculateAllBundleStocks,
  appendInventoryAuditLog,
  recordStockMovement,
  atomicAdjustProductStock,
  resolveProductByQrOrCode,
  generateFullDatabaseBackup,
  ensureDailyAutoBackup,
  restoreFullDatabaseBackup,
  calculateInventoryVelocityAndDoc,
  allocateFefoBatchesForOrder,
  generateWavePicklist,
  generateCarrierManifest,
  processReturnQcGrade,
} = require('../models/inventorySoftwareModel');

const router = express.Router();
const secret = () => process.env.JWT_SECRET || 'fallback_secret';

const posRateKey = req => req.get('x-scanner-api-key') || req.headers.authorization || ipKeyGenerator(req.ip);
const posLimiter = (max, message) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: posRateKey,
    message: { success: false, message },
  });
const scannerScanLimiter = posLimiter(120, 'Too many scans. Wait a moment and try again.');
const posCheckoutLimiter = posLimiter(30, 'Too many checkout attempts. Wait a moment and retry with the same bill.');

// 24x7 In-Memory Warehouse Hub (Zero SQL hits on passive heartbeats/polls)
const SCANNER_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24-hour persistent workroom connection (no 10-min auto-drop)
const scannerSessionsMemory = new Map(); // sessionCode -> { sessionCode, apiKey, deviceName, staffUsername, staffName, connected, lastActiveAt, idleExpiresAt, expiresAt, stateVersion, queueCache, draftCache }
const savedPosDraftsMemory = new Map(); // draftId -> DraftObject
const activeOrderLocksMemory = new Map(); // orderKey -> { orderKey, orderNumber, lockedByUsername, lockedByName, sessionCode, lockType, status, lockedAt, expiresAt, completedAt }
const activeStaffWorkroom = new Map(); // username -> { username, fullName, role, onWork: true, mode: 'PACKING'|'BILLING'|'IDLE', activeOrder: '', deviceName: '', lastSeenAt }
const scannerStaffCredentialsMemory = new Map();
const scannerTokenIdsMemory = new Map();
let scannerRosterLoaded = false;

function getOrCreateScannerSessionState(sessionCode, defaults = {}) {
  const code = String(sessionCode || 'DEFAULT-POS-TERMINAL').trim();
  let state = scannerSessionsMemory.get(code);
  const now = Date.now();
  if (!state) {
    state = {
      sessionCode: code,
      apiKey: defaults.apiKey || '',
      deviceName: defaults.deviceName || 'Bhumivera POS Scanner',
      staffUsername: defaults.staffUsername || 'admin',
      staffName: defaults.staffName || defaults.staffUsername || 'Staff',
      connected: defaults.connected !== undefined ? Boolean(defaults.connected) : true,
      lastActiveAt: now,
      idleExpiresAt: now + SCANNER_IDLE_TIMEOUT_MS,
      expiresAt: defaults.expiresAt || new Date(now + 12 * 60 * 60 * 1000).toISOString(),
      stateVersion: 1,
      queueCache: null,
      draftCache: null,
    };
    scannerSessionsMemory.set(code, state);
  } else {
    if (defaults.apiKey) state.apiKey = defaults.apiKey;
    if (defaults.deviceName) state.deviceName = defaults.deviceName;
    if (defaults.staffUsername) state.staffUsername = defaults.staffUsername;
    if (defaults.staffName) state.staffName = defaults.staffName;
    if (defaults.expiresAt) state.expiresAt = defaults.expiresAt;
  }
  return state;
}

function checkScannerSessionIdleStatus(sessionCode) {
  const code = String(sessionCode || '').trim();
  if (!code) return null;
  const state = scannerSessionsMemory.get(code);
  if (!state) return null;
  const now = Date.now();
  if (state.connected && state.idleExpiresAt && now >= state.idleExpiresAt) {
    state.connected = false;
    state.idleDisconnected = true;
  }
  return state;
}

function touchScannerSessionActivity(sessionCode, extra = {}) {
  const state = getOrCreateScannerSessionState(sessionCode, extra);
  const now = Date.now();
  state.connected = true;
  state.idleDisconnected = false;
  state.lastActiveAt = now;
  state.idleExpiresAt = now + SCANNER_IDLE_TIMEOUT_MS;
  if (extra.bumpVersion) {
    state.stateVersion = (state.stateVersion || 1) + 1;
  }
  return state;
}

function normalizeOrderLockKey(rawOrderId) {
  const clean = String(rawOrderId || '')
    .trim()
    .replace(/^ORD:/i, '')
    .replace(/^BV-ORD-/i, '')
    .replace(/^#/i, '')
    .trim();
  return clean.toUpperCase();
}

function resolveRequestOperator(req) {
  const sessionCode =
    req.body?.sessionCode ||
    req.query?.sessionCode ||
    req.headers?.['x-session-code'] ||
    req.invUser?.scannerSessionCode ||
    'DEFAULT-POS-TERMINAL';
  const memSession = scannerSessionsMemory.get(String(sessionCode).trim());
  const rawUser =
    req.body?.operatorUsername ||
    req.query?.operatorUsername ||
    req.headers?.['x-operator-username'] ||
    (req.invUser?.scannerSessionCode && memSession?.staffUsername ? memSession.staffUsername : req.invUser?.username) ||
    'staff';
  const rawName =
    req.body?.operatorName ||
    req.query?.operatorName ||
    req.headers?.['x-operator-name'] ||
    (req.invUser?.scannerSessionCode && memSession?.staffName ? memSession.staffName : req.invUser?.fullName) ||
    rawUser;
  return {
    username: String(rawUser).trim(),
    name: String(rawName).trim(),
    sessionCode: String(sessionCode).trim(),
  };
}

function acquireOrVerifyOrderLock({ orderId, operatorUsername, operatorName, sessionCode, lockType = 'BILLING', allowCompletedRead = false }) {
  const key = normalizeOrderLockKey(orderId);
  if (!key) return { allowed: true, lock: null };
  const now = Date.now();
  const existing = activeOrderLocksMemory.get(key);

  if (existing) {
    if (existing.status === 'COMPLETED' && !allowCompletedRead) {
      return {
        allowed: false,
        status: 409,
        code: 'ORDER_ALREADY_BILLED',
        orderId: key,
        lockedBy: existing.lockedByName,
        lockedByUsername: existing.lockedByUsername,
        lockedBySession: existing.sessionCode,
        message: `⛔ Order #${key} has already been billed/completed by ${existing.lockedByName}. Duplicate billing to the same order is blocked.`,
      };
    }

    if (existing.status === 'LOCKED' && existing.expiresAt && now < existing.expiresAt) {
      const sameSession =
        existing.sessionCode &&
        sessionCode &&
        existing.sessionCode !== 'DEFAULT-POS-TERMINAL' &&
        existing.sessionCode === sessionCode;
      const explicitDiffName =
        operatorName &&
        existing.lockedByName &&
        !['Bhumivera POS Scanner', 'Packing test device', 'Staff', 'mobile-qr-scanner'].includes(operatorName) &&
        !['Bhumivera POS Scanner', 'Packing test device', 'Staff', 'mobile-qr-scanner'].includes(existing.lockedByName) &&
        existing.lockedByName.toLowerCase() !== operatorName.toLowerCase();
      const sameUser =
        !explicitDiffName &&
        existing.lockedByUsername &&
        operatorUsername &&
        existing.lockedByUsername.toLowerCase() === operatorUsername.toLowerCase();
      const isGenericTestPairing =
        ['test-admin', 'mobile-qr-scanner'].includes(existing.lockedByUsername) &&
        ['test-admin', 'mobile-qr-scanner'].includes(operatorUsername);

      if (explicitDiffName || (!sameSession && !sameUser && !isGenericTestPairing)) {
        return {
          allowed: false,
          status: 409,
          code: 'ORDER_LOCKED_BY_OTHER_STAFF',
          orderId: key,
          lockedBy: existing.lockedByName,
          lockedByUsername: existing.lockedByUsername,
          lockedBySession: existing.sessionCode,
          lockedAt: existing.lockedAt,
          message: `⛔ Order #${key} is already being billed/processed by ${existing.lockedByName}! Another staff member cannot bill the same Order ID simultaneously.`,
        };
      }

      // Same staff member or paired terminal — refresh 10-minute lock window
      existing.expiresAt = now + SCANNER_IDLE_TIMEOUT_MS;
      if (operatorName && !['Bhumivera POS Scanner', 'Packing test device', 'Staff'].includes(operatorName)) {
        existing.lockedByName = operatorName;
      }
      return { allowed: true, lock: existing };
    }
  }

  const newLock = {
    orderKey: key,
    orderNumber: String(orderId).trim(),
    lockedByUsername: operatorUsername || 'staff',
    lockedByName: operatorName || operatorUsername || 'Staff',
    sessionCode: sessionCode || 'DEFAULT-POS-TERMINAL',
    lockType,
    status: 'LOCKED',
    lockedAt: new Date(now).toISOString(),
    expiresAt: now + SCANNER_IDLE_TIMEOUT_MS,
    completedAt: null,
  };
  activeOrderLocksMemory.set(key, newLock);
  return { allowed: true, lock: newLock };
}

function markOrderLockCompleted(orderId, operatorUsername, operatorName, sessionCode) {
  const key = normalizeOrderLockKey(orderId);
  if (!key) return null;
  const now = Date.now();
  const existing = activeOrderLocksMemory.get(key) || {
    orderKey: key,
    orderNumber: String(orderId).trim(),
    lockedByUsername: operatorUsername || 'staff',
    lockedByName: operatorName || operatorUsername || 'Staff',
    sessionCode: sessionCode || 'DEFAULT-POS-TERMINAL',
    lockType: 'BILLING',
    lockedAt: new Date(now).toISOString(),
  };
  existing.status = 'COMPLETED';
  existing.completedAt = new Date(now).toISOString();
  existing.expiresAt = now + 24 * 60 * 60 * 1000;
  activeOrderLocksMemory.set(key, existing);
  return existing;
}

function parseJsonSafe(val, fallback = null) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function normalizeStaffAccount(row) {
  if (!row) return null;
  const role = VALID_INVENTORY_ROLES.includes(row.role) ? row.role : 'manager';
  const permissions = resolveInventoryPermissions(role, row.permissions);
  const passkeys = parseJsonSafe(row.passkeys, []) || [];
  return {
    id: row.id,
    accountCode: row.account_code,
    username: row.username,
    fullName: row.full_name,
    email: row.email || '',
    phone: row.phone || '',
    role,
    assignedHub: row.assigned_hub || 'Bhumivera Flagship Hub — Asansol',
    permissions,
    fullAllAccess: Boolean(role === 'admin' || permissions.full_all_access),
    status: row.status || 'active',
    totpEnabled: Boolean(row.totp_enabled),
    passkeys: passkeys.map(pk => ({
      id: pk.id,
      name: pk.name || 'Biometric Passkey',
      registeredAt: pk.registeredAt || pk.created_at || new Date().toISOString(),
      type: pk.type || 'webauthn',
    })),
    passkeysCount: passkeys.length,
    firstLogin: Boolean(row.first_login),
    lastLoginAt: row.last_login_at || null,
    totalPosBills: Number(row.total_pos_bills) || 0,
    totalStockOps: Number(row.total_stock_ops) || 0,
    createdBy: row.created_by || 'SuperAdmin',
    createdAt: row.created_at,
  };
}

function cacheScannerStaffAccount(row) {
  if (!row?.username) return;
  scannerStaffCredentialsMemory.set(String(row.username).trim().toLowerCase(), row);
}

function revokeScannerSessions(username) {
  const userKey = String(username || '').trim().toLowerCase();
  if (!userKey) return;
  scannerTokenIdsMemory.delete(userKey);
  activeStaffWorkroom.delete(userKey);
  for (const [sessionCode, session] of scannerSessionsMemory.entries()) {
    if (String(session.staffUsername || '').trim().toLowerCase() === userKey) {
      scannerSessionsMemory.delete(sessionCode);
    }
  }
}

function issueInventoryJwt(account) {
  return jwt.sign(
    {
      id: account.id,
      sub: account.id,
      username: account.username,
      fullName: account.fullName,
      email: account.email,
      role: account.role,
      assignedHub: account.assignedHub,
      scope: 'inventory-software',
    },
    secret(),
    { expiresIn: '24h' }
  );
}

async function authenticateInventoryStaff(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ code: 'AUTH_TOKEN_MISSING', message: 'Sign in to Inventory Software to continue.' });
  }
  try {
    await ensureInventorySoftwareTables(pool);
    const payload = jwt.verify(token, secret());
    if (payload.scannerAuth) {
      const activeTokens = scannerTokenIdsMemory.get(String(payload.username || '').toLowerCase());
      if (!payload.jti || !activeTokens?.has(payload.jti)) {
        return res.status(401).json({ code: 'SCANNER_SESSION_REVOKED', message: 'Scanner session expired. Sign in again.' });
      }
    }

    if (payload.scope === 'inventory-software' && (payload.id || payload.username)) {
      const [rows] = payload.id
        ? await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [payload.id])
        : await pool.query('SELECT * FROM inventory_staff_accounts WHERE username = ?', [payload.username]);
      const row = rows[0];
      if (!row) {
        return res.status(401).json({ message: 'Inventory account no longer exists.' });
      }
      if (row.status === 'suspended') {
        return res.status(403).json({ message: 'This warehouse/inventory account has been suspended by SuperAdmin.' });
      }
      req.invUser = normalizeStaffAccount(row);
      if (payload.scannerAuth) {
        const requestedUser = String(req.body?.operatorUsername || '').trim().toLowerCase();
        if (requestedUser && requestedUser !== String(req.invUser.username).toLowerCase()) {
          return res.status(403).json({ message: 'Scanner activity must be recorded under the signed-in staff account.' });
        }
        req.body = req.body || {};
        req.body.operatorUsername = req.invUser.username;
        req.body.operatorName = req.invUser.fullName;
      }
      return next();
    }

    if (['admin', 'superadmin', 'warehouse_admin'].includes(payload.role)) {
      const active = await isSessionActive(payload, req).catch(() => true);
      if (!active && payload.scope !== 'superadmin-controlcentre') {
        return res.status(401).json({ code: 'AUTH_SESSION_REAUTH_REQUIRED', message: 'Session expired. Please sign in again.' });
      }
      req.invUser = {
        id: payload.id || 1,
        accountCode: 'BV-IAM-MASTER',
        username: payload.username || payload.email || 'admin',
        fullName: payload.name || payload.fullName || 'Master Administrator',
        email: payload.email || 'admin@bhumivera.com',
        phone: '',
        role: payload.role === 'warehouse_admin' ? 'keeper' : 'admin',
        assignedHub: 'Bhumivera Flagship Hub — Asansol',
        permissions: resolveInventoryPermissions(payload.role === 'warehouse_admin' ? 'keeper' : 'admin'),
        fullAllAccess: payload.role !== 'warehouse_admin',
        status: 'active',
        totpEnabled: false,
        passkeys: [],
        passkeysCount: 0,
        firstLogin: false,
      };
      return next();
    }

    if (payload.scope === 'support-agent' && payload.sub) {
      const [[agent]] = await pool.query('SELECT * FROM support_agents WHERE id = ?', [payload.sub]);
      if (agent && agent.is_active && ['superadmin', 'manager'].includes(agent.role)) {
        req.invUser = {
          id: agent.id,
          accountCode: `BV-SUP-${agent.id}`,
          username: agent.username,
          fullName: agent.name,
          email: agent.email || '',
          phone: '',
          role: 'admin',
          assignedHub: 'Bhumivera SuperAdmin Support',
          permissions: resolveInventoryPermissions('admin'),
          fullAllAccess: true,
          status: 'active',
          totpEnabled: false,
          passkeys: [],
          passkeysCount: 0,
          firstLogin: false,
        };
        return next();
      }
    }

    return res.status(403).json({ message: 'Access denied: Valid Inventory Software or Admin credentials required.' });
  } catch (err) {
    return res.status(401).json({ code: 'AUTH_TOKEN_INVALID', message: 'Your session has expired. Please sign in again.' });
  }
}

/**
 * Authenticates either a logged-in Inventory Staff member OR an external Mobile QR Scanner App
 * using x-scanner-api-key / apiKey.
 */
async function authenticateScannerOrStaff(req, res, next) {
  try {
    await ensureInventorySoftwareTables(pool);
    const scannerKey =
      req.headers['x-scanner-api-key'] ||
      req.body?.scannerApiKey ||
      req.body?.apiKey ||
      req.query?.scannerApiKey;

    if (scannerKey) {
      const keyHash = crypto.createHash('sha256').update(String(scannerKey).trim()).digest('hex');
      let device = null;
      // 1. Check in-memory device cache first to avoid waking MySQL on repetitive heartbeats
      for (const s of scannerSessionsMemory.values()) {
        if (s.apiKey && s.apiKey === String(scannerKey).trim()) {
          device = {
            session_code: s.sessionCode,
            device_name: s.deviceName,
            expires_at: s.expiresAt,
          };
          break;
        }
      }
      if (!device) {
        const [[dbDevice]] = await pool.query(
          'SELECT session_code, device_name, expires_at FROM inventory_scanner_devices WHERE api_key_hash = ?',
          [keyHash]
        );
        device = dbDevice;
      }
      const requestedSessionCode = req.body?.sessionCode || req.query?.sessionCode;
      const requiresSession = [
        '/scanner/scan',
        '/scanner/queue',
        '/scanner/queue/consume',
        '/scanner/queue/item',
        '/scanner/queue/remove',
        '/scanner/queue/clear',
        '/pos/checkout',
        '/fulfillment/verify-pack',
      ].includes(req.path);

      if (device) {
        if (device.expires_at && new Date(device.expires_at).getTime() <= Date.now()) {
          return res.status(401).json({
            success: false,
            code: 'SCANNER_KEY_EXPIRED',
            message: 'This scanner pairing expired after 12 hours. Scan the current Station Dock QR to reconnect.',
          });
        }
        if (requiresSession && !requestedSessionCode) {
          return res.status(400).json({ success: false, message: 'A paired terminal session is required.' });
        }
        if (requestedSessionCode && requestedSessionCode !== device.session_code) {
          return res.status(403).json({ success: false, message: 'This scanner key is paired to a different terminal.' });
        }
        touchScannerSessionActivity(device.session_code, {
          apiKey: String(scannerKey).trim(),
          deviceName: req.body?.deviceName || device.device_name,
        });
        req.invUser = {
          id: 1,
          username: req.body?.scannedBy || 'mobile-qr-scanner',
          fullName: req.body?.deviceName || device.device_name,
          role: 'cashier',
          assignedHub: 'Bhumivera Flagship Hub — Asansol',
          permissions: { can_use_pos_billing: true },
          fullAllAccess: false,
          scannerSessionCode: device.session_code,
        };
        return next();
      }

      const [[cfg]] = await pool.query('SELECT scanner_api_key FROM inventory_store_config WHERE id = 1');
      if (cfg && cfg.scanner_api_key && String(scannerKey).trim() === String(cfg.scanner_api_key).trim()) {
        if (process.env.INVENTORY_DISABLE_LEGACY_SCANNER_KEY === 'true') {
          return res.status(401).json({
            success: false,
            code: 'LEGACY_SCANNER_KEY_DISABLED',
            message: 'The legacy scanner key is disabled. Re-pair this device from /inventorysoftware.',
          });
        }
        if (requestedSessionCode && requestedSessionCode !== 'DEFAULT-POS-TERMINAL') {
          return res.status(403).json({ success: false, message: 'The legacy scanner key can only access the default terminal. Re-pair this device.' });
        }
        req.invUser = {
          id: 1,
          username: req.body?.scannedBy || 'mobile-qr-scanner',
          fullName: req.body?.deviceName || 'Bhumivera Android QR Scanner App',
          role: 'cashier',
          assignedHub: 'Bhumivera Flagship Hub — Asansol',
          permissions: { can_use_pos_billing: true },
          fullAllAccess: false,
          scannerSessionCode: 'DEFAULT-POS-TERMINAL',
        };
        return next();
      }
      return res.status(401).json({
        success: false,
        code: 'INVALID_SCANNER_API_KEY',
        message: 'Invalid Scanner API Key. Re-scan the pairing QR in /inventorysoftware.',
      });
    }

    return authenticateInventoryStaff(req, res, next);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function normalizePosSessionCode(value) {
  const sessionCode = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(sessionCode) ? sessionCode : null;
}

function authenticateWorkroomMemory(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ success: false, code: 'AUTH_TOKEN_MISSING', message: 'Sign in to the scanner to continue.' });
  }

  try {
    const payload = jwt.verify(token, secret());
    if (payload.scope !== 'inventory-software' || !payload.username || !payload.id) {
      return res.status(401).json({ success: false, code: 'AUTH_TOKEN_INVALID', message: 'Sign in to the scanner to continue.' });
    }
    if (payload.scannerAuth) {
      const activeTokens = scannerTokenIdsMemory.get(String(payload.username).toLowerCase());
      if (!payload.jti || !activeTokens?.has(payload.jti)) {
        return res.status(401).json({ success: false, code: 'SCANNER_SESSION_REVOKED', message: 'Scanner session expired. Sign in again.' });
      }
      const requestedUser = String(req.body?.operatorUsername || '').trim().toLowerCase();
      if (requestedUser && requestedUser !== String(payload.username).toLowerCase()) {
        return res.status(403).json({ success: false, message: 'Workroom activity must be recorded under the signed-in staff account.' });
      }
      req.body = req.body || {};
      req.body.operatorUsername = payload.username;
      req.body.operatorName = payload.fullName || payload.username;
    }

    req.invUser = {
      id: payload.id,
      username: String(payload.username),
      fullName: String(payload.fullName || payload.username),
      role: String(payload.role || 'cashier'),
      assignedHub: String(payload.assignedHub || ''),
      permissions: {},
      fullAllAccess: false,
      scannerSessionCode: `STAFF-${String(payload.username).toUpperCase().replace(/[^A-Z0-9]/g, '-')}`,
    };
    return next();
  } catch {
    return res.status(401).json({ success: false, code: 'AUTH_TOKEN_INVALID', message: 'Sign in to the scanner to continue.' });
  }
}

function requireIamAdmin(req, res, next) {
  if (!req.invUser) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (req.invUser.role === 'admin' || req.invUser.fullAllAccess) {
    return next();
  }
  return res.status(403).json({
    message: 'Only SuperAdmin or Master Inventory Administrators can manage staff accounts and permissions.',
  });
}

function requirePermission(permKey) {
  return (req, res, next) => {
    if (!req.invUser) return res.status(401).json({ message: 'Unauthorized' });
    if (req.invUser.role === 'admin' || req.invUser.fullAllAccess || req.invUser.permissions?.[permKey]) {
      return next();
    }
    return res.status(403).json({
      code: 'INVENTORY_PERMISSION_DENIED',
      message: `Permission denied: "${INVENTORY_PERMISSION_DEFINITIONS[permKey]?.label || permKey}" is not enabled for your account.`,
    });
  };
}

// 1. AUTHENTICATION, 2FA TOTP, PASSKEYS & FIRST-TIME ONBOARDING
router.post('/auth/login', async (req, res) => {
  try {
    await ensureInventorySoftwareTables(pool);
    const identifier = String(req.body?.username || req.body?.identifier || req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const totpCode = String(req.body?.totpCode || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Account ID and password are required.' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM inventory_staff_accounts WHERE LOWER(username) = LOWER(?) OR (email IS NOT NULL AND email <> "" AND LOWER(email) = LOWER(?)) LIMIT 1',
      [identifier, identifier]
    );

    let staffRow = rows[0] || null;

    if (!staffRow && identifier.includes('@')) {
      const [adminRows] = await pool.query(
        'SELECT * FROM admin_users WHERE LOWER(email) = LOWER(?) LIMIT 1',
        [identifier]
      ).catch(() => [[]]);
      const webAdmin = adminRows[0];
      if (webAdmin) {
        const match = await bcrypt.compare(password, webAdmin.password_hash || webAdmin.password || '');
        if (match) {
          const usernameFromEmail = webAdmin.email.split('@')[0].toLowerCase();
          await pool.query(
            `INSERT INTO inventory_staff_accounts
              (account_code, username, full_name, email, password_hash, role, assigned_hub, permissions, first_login, passkeys)
             VALUES (?, ?, ?, ?, ?, 'admin', 'Bhumivera Flagship Hub — Asansol', ?, 0, '[]')
             ON DUPLICATE KEY UPDATE email = VALUES(email)`,
            [
              `BV-ADM-${webAdmin.id}`,
              usernameFromEmail,
              webAdmin.name || 'Master Administrator',
              webAdmin.email,
              webAdmin.password_hash || webAdmin.password,
              JSON.stringify(resolveInventoryPermissions('admin')),
            ]
          );
          const [synced] = await pool.query(
            'SELECT * FROM inventory_staff_accounts WHERE LOWER(username) = LOWER(?) LIMIT 1',
            [usernameFromEmail]
          );
          staffRow = synced[0] || null;
        }
      }
    }

    if (!staffRow) {
      return res.status(401).json({ success: false, message: 'Invalid Account ID or Password.' });
    }

    if (staffRow.status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'This account has been suspended by SuperAdmin. Contact SuperAdmin Support.',
      });
    }

    const passwordValid = await bcrypt.compare(password, staffRow.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ success: false, message: 'Invalid Account ID or Password.' });
    }

    if (staffRow.totp_enabled) {
      if (!totpCode) {
        return res.json({
          success: true,
          requires2FA: true,
          username: staffRow.username,
          message: 'Enter your 6-digit 2FA Authenticator code.',
        });
      }
      const validOtp = verifyTotpCode(staffRow.totp_secret, totpCode);
      if (!validOtp) {
        return res.status(401).json({
          success: false,
          requires2FA: true,
          message: 'Invalid 6-digit 2FA Authenticator code.',
        });
      }
    }

    await pool.query('UPDATE inventory_staff_accounts SET last_login_at = NOW() WHERE id = ?', [staffRow.id]);
    const normalized = normalizeStaffAccount(staffRow);
    const token = issueInventoryJwt(normalized);

    await appendInventoryAuditLog(pool, {
      actorUsername: normalized.username,
      actorRole: normalized.role,
      actionCode: 'STAFF_LOGIN',
      summary: `${normalized.fullName} (@${normalized.username}) signed in to Inventory Software (${normalized.assignedHub}).`,
    });

    return res.json({
      success: true,
      requires2FA: false,
      token,
      user: normalized,
      firstLogin: normalized.firstLogin,
    });
  } catch (err) {
    console.error('[INVENTORY_AUTH_LOGIN_ERROR]', err);
    return res.status(500).json({ success: false, message: 'Login error: ' + err.message });
  }
});

router.post('/auth/passkey-login', async (req, res) => {
  try {
    await ensureInventorySoftwareTables(pool);
    const username = String(req.body?.username || '').trim();
    const credentialId = String(req.body?.credentialId || '').trim();

    let rows = [];
    if (username) {
      [rows] = await pool.query(
        'SELECT * FROM inventory_staff_accounts WHERE LOWER(username) = LOWER(?) LIMIT 1',
        [username]
      );
    } else if (credentialId) {
      const [allRows] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE status = "active"');
      rows = allRows.filter(r => {
        const pks = parseJsonSafe(r.passkeys, []) || [];
        return pks.some(pk => pk.id === credentialId);
      });
    }

    const staffRow = rows[0];
    if (!staffRow) {
      return res.status(404).json({
        success: false,
        message: 'Account not found or no Passkey registered. Sign in with password first.',
      });
    }
    if (staffRow.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'This account has been suspended.' });
    }
    const passkeys = parseJsonSafe(staffRow.passkeys, []) || [];
    if (passkeys.length === 0) {
      return res.status(400).json({
        success: false,
        message: `No Biometric Passkey registered for @${staffRow.username}. Sign in with password to enroll your device.`,
      });
    }

    await pool.query('UPDATE inventory_staff_accounts SET last_login_at = NOW() WHERE id = ?', [staffRow.id]);
    const normalized = normalizeStaffAccount(staffRow);
    const token = issueInventoryJwt(normalized);

    await appendInventoryAuditLog(pool, {
      actorUsername: normalized.username,
      actorRole: normalized.role,
      actionCode: 'PASSKEY_LOGIN',
      summary: `${normalized.fullName} (@${normalized.username}) authenticated via Biometric Passkey.`,
    });

    return res.json({
      success: true,
      token,
      user: normalized,
      firstLogin: normalized.firstLogin,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/auth/me', authenticateInventoryStaff, async (req, res) => {
  res.json({ success: true, user: req.invUser, permissionDefinitions: INVENTORY_PERMISSION_DEFINITIONS });
});

router.post('/auth/enroll-passkey', authenticateInventoryStaff, async (req, res) => {
  try {
    const friendlyName = String(req.body?.deviceName || req.body?.friendlyName || 'Primary Biometric Passkey').trim();
    const credentialId = String(req.body?.credentialId || `PK-${crypto.randomBytes(12).toString('hex')}`);

    const [[row]] = await pool.query('SELECT passkeys FROM inventory_staff_accounts WHERE id = ?', [req.invUser.id]);
    if (!row) {
      return res.json({
        success: true,
        passkey: { id: credentialId, name: friendlyName, registeredAt: new Date().toISOString() },
      });
    }
    const passkeys = parseJsonSafe(row.passkeys, []) || [];
    const newPasskey = {
      id: credentialId,
      name: friendlyName,
      registeredAt: new Date().toISOString(),
      type: req.body?.type || 'webauthn',
    };
    passkeys.push(newPasskey);

    await pool.query('UPDATE inventory_staff_accounts SET passkeys = ? WHERE id = ?', [
      JSON.stringify(passkeys),
      req.invUser.id,
    ]);

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'PASSKEY_ENROLLED',
      summary: `Registered biometric passkey device "${friendlyName}" for @${req.invUser.username}.`,
    });

    res.json({ success: true, passkey: newPasskey, passkeys });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/auth/passkey/:passkeyId', authenticateInventoryStaff, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT passkeys FROM inventory_staff_accounts WHERE id = ?', [req.invUser.id]);
    if (row) {
      const passkeys = (parseJsonSafe(row.passkeys, []) || []).filter(p => p.id !== req.params.passkeyId);
      await pool.query('UPDATE inventory_staff_accounts SET passkeys = ? WHERE id = ?', [
        JSON.stringify(passkeys),
        req.invUser.id,
      ]);
    }
    res.json({ success: true, message: 'Passkey removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/auth/2fa/setup', authenticateInventoryStaff, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT totp_secret, username FROM inventory_staff_accounts WHERE id = ?', [
      req.invUser.id,
    ]);
    const totpSecret = row?.totp_secret || generateTotpSecret();
    if (row && !row.totp_secret) {
      await pool.query('UPDATE inventory_staff_accounts SET totp_secret = ? WHERE id = ?', [totpSecret, req.invUser.id]);
    }
    const label = encodeURIComponent(`BhumiVera:${req.invUser.username}`);
    const issuer = encodeURIComponent('BhumiVera Inventory');
    const otpauthUrl = `otpauth://totp/${label}?secret=${totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    res.json({
      success: true,
      secret: totpSecret,
      otpauthUrl,
      username: req.invUser.username,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/auth/2fa/enable', authenticateInventoryStaff, async (req, res) => {
  try {
    const { secret: providedSecret, code } = req.body || {};
    const [[row]] = await pool.query('SELECT totp_secret FROM inventory_staff_accounts WHERE id = ?', [req.invUser.id]);
    const activeSecret = providedSecret || row?.totp_secret;
    if (!verifyTotpCode(activeSecret, code)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid 6-digit verification code. Check Google/Microsoft Authenticator and try again.',
      });
    }
    await pool.query(
      'UPDATE inventory_staff_accounts SET totp_enabled = 1, totp_secret = ?, first_login = 0 WHERE id = ?',
      [activeSecret, req.invUser.id]
    );
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: '2FA_ENABLED',
      summary: `Enabled TOTP 2FA Authenticator protection for @${req.invUser.username}.`,
    });
    res.json({ success: true, message: 'Two-Factor Authentication (TOTP) is now active!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/auth/2fa/disable', authenticateInventoryStaff, async (req, res) => {
  try {
    await pool.query('UPDATE inventory_staff_accounts SET totp_enabled = 0 WHERE id = ?', [req.invUser.id]);
    res.json({ success: true, message: 'Two-Factor Authentication disabled.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/auth/complete-onboarding', authenticateInventoryStaff, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (newPassword && String(newPassword).length >= 6) {
      const hash = await bcrypt.hash(String(newPassword), 10);
      await pool.query(
        'UPDATE inventory_staff_accounts SET password_hash = ?, first_login = 0 WHERE id = ?',
        [hash, req.invUser.id]
      );
    } else {
      await pool.query('UPDATE inventory_staff_accounts SET first_login = 0 WHERE id = ?', [req.invUser.id]);
    }
    res.json({ success: true, message: 'Security onboarding completed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/auth/change-password', authenticateInventoryStaff, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }
    const [[row]] = await pool.query('SELECT password_hash FROM inventory_staff_accounts WHERE id = ?', [
      req.invUser.id,
    ]);
    if (row && currentPassword) {
      const valid = await bcrypt.compare(String(currentPassword), row.password_hash);
      if (!valid) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
      }
    }
    const newHash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      'UPDATE inventory_staff_accounts SET password_hash = ?, first_login = 0 WHERE id = ?',
      [newHash, req.invUser.id]
    );
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. SUPERADMIN SUPPORT: WAREHOUSE & INVENTORY STAFF IAM MANAGEMENT
router.get('/iam/users', authenticateInventoryStaff, requireIamAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM inventory_staff_accounts ORDER BY created_at DESC');
    scannerStaffCredentialsMemory.clear();
    rows.forEach(cacheScannerStaffAccount);
    scannerRosterLoaded = true;
    const users = rows.map(normalizeStaffAccount);
    res.json({
      success: true,
      users,
      permissionDefinitions: INVENTORY_PERMISSION_DEFINITIONS,
      roleDefaults: ROLE_DEFAULT_INVENTORY_PERMISSIONS,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/iam/users', authenticateInventoryStaff, requireIamAdmin, async (req, res) => {
  try {
    const {
      username,
      password,
      fullName,
      email,
      phone,
      role = 'manager',
      assignedHub = 'Bhumivera Flagship Hub — Asansol',
      permissions = null,
      fullAllAccess = false,
      requireOnboarding = true,
    } = req.body || {};

    const cleanUsername = String(username || '').trim().toLowerCase();
    if (!cleanUsername || !password) {
      return res.status(400).json({ success: false, message: 'Account ID (username) and password are required.' });
    }
    if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return res.status(400).json({ success: false, message: 'Login ID must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
    }

    const [existing] = await pool.query(
      'SELECT id FROM inventory_staff_accounts WHERE LOWER(username) = LOWER(?)',
      [cleanUsername]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: `Account ID "@${cleanUsername}" already exists.` });
    }

    const safeRole = VALID_INVENTORY_ROLES.includes(role) ? role : 'manager';
    const resolvedPerms = resolveInventoryPermissions(safeRole, {
      ...(permissions || {}),
      ...(fullAllAccess ? { full_all_access: true } : {}),
    });

    const passwordHash = await bcrypt.hash(String(password), 10);
    const [result] = await pool.query(
      `INSERT INTO inventory_staff_accounts
        (account_code, username, full_name, email, phone, password_hash, role, assigned_hub, permissions, status, totp_enabled, totp_secret, passkeys, first_login, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, '[]', ?, ?)`,
      [
        cleanUsername,
        cleanUsername,
        String(fullName || cleanUsername).trim(),
        String(email || '').trim(),
        String(phone || '').trim(),
        passwordHash,
        safeRole,
        String(assignedHub || 'Bhumivera Flagship Hub — Asansol').trim(),
        JSON.stringify(resolvedPerms),
        generateTotpSecret(),
        requireOnboarding ? 1 : 0,
        req.invUser.username,
      ]
    );

    const [[createdRow]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [result.insertId]);
    cacheScannerStaffAccount(createdRow);
    const userObj = normalizeStaffAccount(createdRow);

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'IAM_CREATE_USER',
      summary: `Created warehouse/inventory Account ID "@${cleanUsername}" (${safeRole.toUpperCase()}) for ${userObj.fullName}.`,
      details: { username: cleanUsername, role: safeRole, assignedHub, fullAllAccess: userObj.fullAllAccess },
    });

    res.status(201).json({
      success: true,
      message: `Created Warehouse & Inventory Account ID "@${cleanUsername}".`,
      user: userObj,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/iam/users/:id', authenticateInventoryStaff, requireIamAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const [[existing]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const nextUsername = req.body.username !== undefined
      ? String(req.body.username).trim().toLowerCase()
      : String(existing.username || '');
    if (!/^[a-z0-9._-]{3,32}$/.test(nextUsername)) {
      return res.status(400).json({ success: false, message: 'Login ID must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
    }
    if (nextUsername !== String(existing.username || '').toLowerCase()) {
      const [[duplicate]] = await pool.query(
        'SELECT id FROM inventory_staff_accounts WHERE (LOWER(username) = LOWER(?) OR LOWER(account_code) = LOWER(?)) AND id <> ? LIMIT 1',
        [nextUsername, nextUsername, targetId]
      );
      if (duplicate) {
        return res.status(409).json({ success: false, message: `Login ID "@${nextUsername}" already exists.` });
      }
    }
    const nextRole = req.body.role && VALID_INVENTORY_ROLES.includes(req.body.role) ? req.body.role : existing.role;
    const nextHub = req.body.assignedHub !== undefined ? String(req.body.assignedHub).trim() : existing.assigned_hub;
    const nextFullName = req.body.fullName !== undefined ? String(req.body.fullName).trim() : existing.full_name;
    const nextPhone = req.body.phone !== undefined ? String(req.body.phone).trim() : existing.phone;
    const nextEmail = req.body.email !== undefined ? String(req.body.email).trim() : existing.email;
    const nextStatus =
      req.body.status && ['active', 'suspended'].includes(req.body.status) ? req.body.status : existing.status;

    let nextPerms = parseJsonSafe(existing.permissions, {});
    if (req.body.permissions !== undefined || req.body.fullAllAccess !== undefined || req.body.role !== undefined) {
      const custom = req.body.permissions !== undefined ? req.body.permissions : nextPerms;
      nextPerms = resolveInventoryPermissions(nextRole, {
        ...custom,
        ...(req.body.fullAllAccess !== undefined ? { full_all_access: Boolean(req.body.fullAllAccess) } : {}),
      });
    }

    await pool.query(
      `UPDATE inventory_staff_accounts
       SET account_code = ?, username = ?, full_name = ?, email = ?, phone = ?, role = ?, assigned_hub = ?, permissions = ?, status = ?
       WHERE id = ?`,
      [nextUsername, nextUsername, nextFullName, nextEmail, nextPhone, nextRole, nextHub, JSON.stringify(nextPerms), nextStatus, targetId]
    );

    const [[updatedRow]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    if (String(existing.username || '').toLowerCase() !== nextUsername) {
      scannerStaffCredentialsMemory.delete(String(existing.username || '').toLowerCase());
      revokeScannerSessions(existing.username);
    } else if (
      req.body.status !== undefined ||
      req.body.role !== undefined ||
      req.body.permissions !== undefined ||
      req.body.fullAllAccess !== undefined
    ) {
      revokeScannerSessions(existing.username);
    }
    cacheScannerStaffAccount(updatedRow);
    const userObj = normalizeStaffAccount(updatedRow);

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'IAM_UPDATE_USER',
      summary: `Updated role/permissions for "@${userObj.username}" (${userObj.role.toUpperCase()}, Status: ${userObj.status}).`,
    });

    res.json({ success: true, message: `Updated account "@${userObj.username}".`, user: userObj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/iam/users/:id/reset-password', authenticateInventoryStaff, requireIamAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE inventory_staff_accounts SET password_hash = ?, first_login = 1 WHERE id = ?',
      [hash, targetId]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    if (!row) return res.status(404).json({ success: false, message: 'Account not found.' });
    revokeScannerSessions(row.username);
    cacheScannerStaffAccount(row);
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'IAM_RESET_PASSWORD',
      summary: `Reset password for warehouse/inventory account "@${row?.username}".`,
    });
    res.json({
      success: true,
      message: `Password reset for @${row?.username}.`,
      user: normalizeStaffAccount(row),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/iam/users/:id/reset-security', authenticateInventoryStaff, requireIamAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    await pool.query(
      'UPDATE inventory_staff_accounts SET totp_enabled = 0, totp_secret = ?, passkeys = "[]", first_login = 1 WHERE id = ?',
      [generateTotpSecret(), targetId]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    if (!row) return res.status(404).json({ success: false, message: 'Account not found.' });
    revokeScannerSessions(row.username);
    cacheScannerStaffAccount(row);
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'IAM_RESET_2FA_PASSKEY',
      summary: `Cleared 2FA & Passkey device locks for "@${row?.username}".`,
    });
    res.json({
      success: true,
      message: `Cleared 2FA & Passkeys for @${row?.username}. They will be prompted to re-enroll on next login.`,
      user: normalizeStaffAccount(row),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/iam/users/:id', authenticateInventoryStaff, requireIamAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const [[row]] = await pool.query('SELECT username FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    if (!row) return res.status(404).json({ success: false, message: 'Account not found.' });
    if (row.username === 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot delete the primary master admin account.' });
    }
    await pool.query('DELETE FROM inventory_staff_accounts WHERE id = ?', [targetId]);
    scannerStaffCredentialsMemory.delete(String(row.username || '').toLowerCase());
    revokeScannerSessions(row.username);
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'IAM_DELETE_USER',
      summary: `Deleted warehouse/inventory account "@${row.username}".`,
    });
    res.json({ success: true, message: `Deleted account "@${row.username}".` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. UNIFIED BOOTSTRAP & REAL-TIME WEBSITE SYNC ENDPOINTS
const BOOTSTRAP_HEAVY_WORK_MS = 5 * 60 * 1000;
let lastBootstrapHeavyWorkAt = 0;
let bootstrapProductSyncPromise = null;

router.get('/bootstrap', authenticateInventoryStaff, async (req, res) => {
  try {
    await ensureInventorySoftwareTables(pool);
    if (!scannerRosterLoaded) {
      const [staffRows] = await pool.query('SELECT * FROM inventory_staff_accounts');
      staffRows.forEach(cacheScannerStaffAccount);
      scannerRosterLoaded = true;
    }
    const shouldSyncWebsiteProducts =
      !bootstrapProductSyncPromise &&
      Date.now() - lastBootstrapHeavyWorkAt >= BOOTSTRAP_HEAVY_WORK_MS;
    if (shouldSyncWebsiteProducts) {
      lastBootstrapHeavyWorkAt = Date.now();
    }
    const [
      [itemRows],
      [customerRows],
      [saleRows],
      [movementRows],
      [auditRows],
      [configRows],
      [batchRows],
      [onlineOrderRows],
      [dailyBackupRows],
      [shippingZoneRows],
    ] = await Promise.all([
      pool.query(`
        SELECT m.*,
               p.name AS web_name,
               p.slug AS web_slug,
               p.quantity AS web_quantity,
               p.price AS web_price,
               p.discount_price AS web_discount_price,
               p.status AS web_status,
               p.specifications AS web_specifications,
               (SELECT pi.file_path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC LIMIT 1) AS image_url
        FROM inventory_product_meta m
        LEFT JOIN products p ON m.product_id = p.id
        ORDER BY COALESCE(p.id, m.id) ASC
      `),
      pool.query('SELECT * FROM inventory_customers ORDER BY name ASC'),
      pool.query('SELECT * FROM inventory_pos_invoices ORDER BY created_at DESC LIMIT 300'),
      pool.query('SELECT * FROM inventory_stock_movements ORDER BY created_at DESC LIMIT 400'),
      pool.query('SELECT * FROM inventory_audit_logs ORDER BY created_at DESC LIMIT 400'),
      pool.query('SELECT * FROM inventory_store_config WHERE id = 1'),
      pool.query(`
        SELECT pb.*, p.name AS product_name, p.sku
        FROM product_batches pb
        LEFT JOIN products p ON pb.product_id = p.id
        ORDER BY pb.expiry_date ASC
      `).catch(() => [[]]),
      pool.query(`
        SELECT o.id, o.order_number, o.user_id, o.status, o.delivery_type,
               o.payment_mode, o.payment_status, o.payment_id,
               o.subtotal, o.discount, o.tier_discount, o.referral_wallet_amount,
               o.shipping_cost, o.total, o.courier, o.tracking_number, o.tracking_url,
               o.notes, o.cancel_reason, o.created_at, o.updated_at, o.delivered_at,
               o.estimated_delivery_date, o.current_location_checkpoint,
               o.rto_reason, o.rto_restock_mode, o.rto_processed_at, o.label_printed_at,
               o.address_snapshot,
               u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.status <> 'archived'
        ORDER BY o.created_at DESC
        LIMIT 250
      `),
      pool.query(`
        SELECT id, backup_code, backup_date, trigger_type, tables_count, rows_count,
               size_bytes, checksum_sha512, created_by, created_at
        FROM system_daily_backups
        ORDER BY created_at DESC
        LIMIT 15
      `).catch(() => [[]]),
      pool.query('SELECT * FROM shipping_zones ORDER BY id ASC').catch(() => [[]]),
    ]);

    const onlineOrderIds = onlineOrderRows.map(o => o.id);
    const orderItemsByOrder = {};
    const shippingLabelsByOrder = {};
    if (onlineOrderIds.length > 0) {
      const placeholders = onlineOrderIds.map(() => '?').join(',');
      const [oItems] = await pool
        .query(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, onlineOrderIds);
      for (const it of oItems) {
        if (!orderItemsByOrder[it.order_id]) orderItemsByOrder[it.order_id] = [];
        orderItemsByOrder[it.order_id].push(it);
      }

      const [sLabels] = await pool
        .query(`SELECT * FROM shipping_labels WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`, onlineOrderIds)
        .catch(() => [[]]);
      for (const lbl of sLabels) {
        if (!shippingLabelsByOrder[lbl.order_id]) shippingLabelsByOrder[lbl.order_id] = [];
        shippingLabelsByOrder[lbl.order_id].push(lbl);
      }
    }

    const reservedByProductId = {};
    for (const ord of onlineOrderRows) {
      if (['pending', 'confirmed', 'packed'].includes(ord.status)) {
        for (const it of orderItemsByOrder[ord.id] || []) {
          if (it.product_id) {
            reservedByProductId[it.product_id] =
              (reservedByProductId[it.product_id] || 0) + (Number(it.quantity) || 0);
          }
        }
      }
    }

    const itemByProductId = new Map();
    const itemBySku = new Map();

    const items = itemRows.map(r => {
      const liveQty =
        r.product_id && r.web_quantity !== null && r.web_quantity !== undefined
          ? Number(r.web_quantity)
          : Number(r.physical_stock);
      const sellingPrice =
        r.product_id && Number(r.web_discount_price) > 0
          ? Number(r.web_discount_price)
          : r.product_id && Number(r.web_price) > 0
          ? Number(r.web_price)
          : Number(r.selling_price);
      let specs = r.web_specifications;
      if (typeof specs === 'string') {
        try {
          specs = JSON.parse(specs);
        } catch {
          specs = null;
        }
      }
      const isBundle = specs?.product_type === 'bundle';
      const standaloneQrPayload = buildStandaloneProductQr(r.sku);
      const qrCodePayload =
        r.qr_code_payload ||
        standaloneQrPayload;

      const formatted = {
        id: r.id,
        warehouseId: Number(r.warehouse_id) || 1,
        productId: r.product_id,
        name: r.web_name || r.custom_name || 'Product',
        slug: r.web_slug || '',
        sku: r.sku,
        barcode: r.barcode,
        standaloneQrPayload,
        qrCodePayload,
        cat: r.category_name || 'Botanical Formulations',
        uom: r.uom || 'Pcs',
        qty: liveQty,
        physicalStock: Math.max(liveQty, Number(r.physical_stock) || 0),
        shopDisplayStock: Number(r.shop_display_stock) || 0,
        warehouseVaultStock: Number(r.warehouse_vault_stock) || 0,
        safetyBufferStock: Number(r.safety_buffer_stock) || 0,
        damagedQuarantineStock: Number(r.damaged_quarantine_stock) || 0,
        onlineReservedQty: reservedByProductId[r.product_id] || 0,
        costPrice: Number(r.cost_price) || 0,
        mrp: Number(r.mrp) || sellingPrice,
        price: sellingPrice,
        gstHsnCode: r.gst_hsn_code || '30049011',
        gstRate: Number(r.gst_rate) || 5,
        minStock: Number(r.min_stock_alert) || 15,
        reorderQty: Number(r.reorder_qty) || 50,
        binCode: r.bin_code || 'ASN-SHOP-R1-B01',
        rackLocation: r.rack_location || 'Zone A • Rack 01 • Shelf A',
        batchNo: r.batch_no || '',
        mfgDate: r.mfg_date ? new Date(r.mfg_date).toISOString().split('T')[0] : '',
        expiryDate: r.expiry_date ? new Date(r.expiry_date).toISOString().split('T')[0] : '',
        soldQty: (Number(r.sold_offline_qty) || 0) + (Number(r.sold_online_qty) || 0),
        soldOfflineQty: Number(r.sold_offline_qty) || 0,
        soldOnlineQty: Number(r.sold_online_qty) || 0,
        syncToWebsite: Boolean(r.sync_to_website && r.product_id),
        isBundle,
        webStatus: r.web_status || 'active',
        imageUrl: r.image_url || '/images/products/bhumivera-activated-charcoal-luxury-face-wash.webp',
        dateAdded: r.updated_at,
      };
      if (formatted.productId) itemByProductId.set(Number(formatted.productId), formatted);
      if (formatted.sku) itemBySku.set(String(formatted.sku).toUpperCase(), formatted);
      return formatted;
    });

    const sales = saleRows.map(s => ({
      id: s.id,
      invoiceNo: s.invoice_no,
      date: s.created_at,
      cust: {
        id: s.customer_id,
        name: s.customer_name,
        phone: s.customer_phone || '-',
        address: s.customer_address || '',
        gstin: s.customer_gstin || '',
      },
      items: parseJsonSafe(s.items_json, []) || [],
      extra: parseJsonSafe(s.extra_charges_json, []) || [],
      subTotal: Number(s.subtotal) || 0,
      extraTotal: Number(s.extra_total) || 0,
      discount: Number(s.discount_amount) || 0,
      taxableAmount: Number(s.taxable_amount) || 0,
      taxRate: Number(s.tax_rate) || 0,
      tax: Number(s.tax_amount) || 0,
      total: Number(s.subtotal) || 0,
      billTotal: Number(s.bill_total) || 0,
      paid: Number(s.paid_amount) || 0,
      prevBal: Number(s.prev_khata_balance) || 0,
      newBal: Number(s.new_khata_balance) || 0,
      paymentMode: s.payment_mode || 'Cash',
      upiReference: s.upi_reference || '',
      status: s.status || 'completed',
      cashier: s.cashier_username || 'admin',
      hubName: s.hub_name || 'Bhumivera Flagship Hub — Asansol',
    }));
    const customers = customerRows.map(customer => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.location || '',
      gstin: customer.gstin || '',
      wallet: Number(customer.wallet_balance) || 0,
      creditLimit: Number(customer.credit_limit) || 0,
      totalPurchases: Number(customer.total_purchases) || 0,
      visitCount: Number(customer.visit_count) || 0,
      type: customer.customer_type || 'Walk-in',
    }));

    const cfgRow = configRows[0] || {};
    const cfg = {
      storeName: cfgRow.store_name || 'Bhumivera Organics India Private Limited',
      tagline: cfgRow.tagline || 'The Transparent Maison — 100% Label-Disclosed Botanical Formulations',
      address: cfgRow.address || 'G.T. Road, Gopalpur, Asansol, West Bengal - 713304, India',
      phone: cfgRow.phone || '+91 98320 00000',
      email: cfgRow.email || 'billing@bhumivera.com',
      website: cfgRow.website || 'www.bhumivera.com',
      gstin: cfgRow.gstin || '19AAKCB2026A1Z5',
      cin: cfgRow.cin || 'U20237WB2026PTC295842',
      upiId: cfgRow.upi_id || 'bhumivera@okhdfcbank',
      scannerApiKey: cfgRow.scanner_api_key || 'BV-SCAN-DEFAULT',
      taxRate: cfgRow.default_tax_rate == null ? 18 : Number(cfgRow.default_tax_rate),
      autoSyncWebsite: Boolean(cfgRow.auto_sync_website ?? 1),
      posHoldReservation: Boolean(cfgRow.pos_hold_reservation ?? 1),
      cats: parseJsonSafe(cfgRow.categories_json, [
        'Luxury Facial Cleansers',
        'Luxury Hair Care',
        'Artisanal Ayurvedic Cleansing Bars',
        'Luxury Ayurvedic Wellness & Immunity Drops',
        'Maison Regimen Bundles',
        'Botanical Raw Materials',
        'Luxury Glass & Packaging',
      ]),
      hid: parseJsonSafe(cfgRow.hidden_widgets_json, []),
      logo: cfgRow.logo_url || '/assets/bhumivera-luxury-crest-logo.webp',
    };

    const onlineOrders = onlineOrderRows.map(o => {
      const addr = parseJsonSafe(o.address_snapshot, {}) || {};
      const recipientName = addr.full_name || addr.fullName || addr.name || o.customer_name || 'Online Patron';
      const recipientPhone = addr.phone || addr.mobile || o.customer_phone || '';
      const recipientAltPhone = addr.alternate_phone || addr.altPhone || '';
      const line1 = addr.line1 || addr.street_address || addr.address_line1 || addr.address || '';
      const line2 = addr.line2 || addr.address_line2 || addr.area || '';
      const landmark = addr.landmark || '';
      const city = addr.city || addr.district || '';
      const state = addr.state || '';
      const pincode = String(addr.pincode || addr.postal_code || addr.zip || '');
      const fullFormattedAddress = [line1, line2, landmark ? `Landmark: ${landmark}` : '', city, state, pincode]
        .filter(Boolean)
        .join(', ');
      const hasGps = Boolean(addr.latitude && addr.longitude);
      const googleMapsUrl =
        addr.google_maps_url ||
        (hasGps
          ? `https://www.google.com/maps?q=${addr.latitude},${addr.longitude}`
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              [line1, line2, city, state, pincode, 'India'].filter(Boolean).join(', ')
            )}`);

      const estDate = o.estimated_delivery_date
        ? new Date(o.estimated_delivery_date).toISOString().split('T')[0]
        : calculateEstimatedDeliveryDate(addr, o.delivery_type || 'standard', o.created_at);

      const defaultCheckpoint =
        o.status === 'delivered'
          ? `Delivered to Customer in ${city || state || 'Destination'}`
          : o.status === 'returned'
          ? `RTO Returned to Asansol Hub (${o.rto_reason || 'Undelivered'})`
          : o.status === 'out_for_delivery'
          ? `Out for Delivery in ${city || state || 'Destination'}`
          : o.status === 'shipped'
          ? `In Transit via ${o.courier || 'Courier'} → Destination: ${city || 'Customer City'}`
          : o.status === 'packed'
          ? 'Packed & Weighed at Asansol Dispatch Bay — Ready for Courier Handover'
          : o.status === 'confirmed'
          ? 'Order Confirmed — Stock Allocated in Asansol Hub'
          : 'Order Placed — Routed to Asansol Inventory Hub';

      const mappedItems = (orderItemsByOrder[o.id] || []).map(it => {
        const linkedInv =
          (it.product_id && itemByProductId.get(Number(it.product_id))) ||
          (it.sku && itemBySku.get(String(it.sku).toUpperCase())) ||
          null;
        return {
          id: it.id,
          productId: it.product_id,
          metaId: linkedInv?.id || null,
          name: it.name,
          sku: it.sku || linkedInv?.sku || '',
          barcode: linkedInv?.barcode || it.sku || '',
          mrp: Number(linkedInv?.mrp) || Number(it.price) || 0,
          gstHsnCode: it.gst_hsn_code || linkedInv?.gstHsnCode || '30049011',
          gstRate: Number(it.gst_rate || linkedInv?.gstRate || 5),
          quantity: Number(it.quantity) || 1,
          price: Number(it.price) || 0,
          inStockQty: linkedInv ? Number(linkedInv.qty) : 0,
          binCode: linkedInv?.binCode || 'ASN-SHOP-R1-B01',
          batchNo: linkedInv?.batchNo || '',
        };
      });

      const parsedCreatedAt = o.created_at ? new Date(o.created_at) : new Date();
      const createdAt = Number.isNaN(parsedCreatedAt.getTime()) ? new Date() : parsedCreatedAt;
      const indiaDateParts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'numeric',
      }).formatToParts(createdAt);
      const indiaYear = Number(indiaDateParts.find(part => part.type === 'year')?.value) || createdAt.getFullYear();
      const indiaMonth = Number(indiaDateParts.find(part => part.type === 'month')?.value) || createdAt.getMonth() + 1;
      const fiscalYearStart = indiaMonth >= 4 ? indiaYear : indiaYear - 1;
      const invoiceNumber = `BV/${String(fiscalYearStart).slice(-2)}-${String(fiscalYearStart + 1).slice(-2)}/${String(o.id).padStart(4, '0')}`;
      const activeLock = [
        activeOrderLocksMemory.get(normalizeOrderLockKey(o.order_number || o.id)),
        activeOrderLocksMemory.get(normalizeOrderLockKey(o.id)),
      ].find(lock => lock?.status === 'LOCKED' && (!lock.expiresAt || Date.now() < lock.expiresAt));

      return {
        id: o.id,
        orderNumber: o.order_number || String(o.id),
        invoiceNumber,
        userId: o.user_id,
        status: o.status,
        deliveryType: o.delivery_type || 'standard',
        paymentMode: o.payment_mode || 'COD',
        paymentStatus: o.payment_status || 'pending',
        paymentId: o.payment_id || '',
        subtotal: Number(o.subtotal) || 0,
        discount: Number(o.discount) || 0,
        tierDiscount: Number(o.tier_discount) || 0,
        referralWalletAmount: Number(o.referral_wallet_amount) || 0,
        shippingCost: Number(o.shipping_cost) || 0,
        total: Number(o.total) || 0,
        courier: o.courier || '',
        trackingNumber: o.tracking_number || '',
        trackingUrl: o.tracking_url || '',
        estimatedDeliveryDate: estDate,
        currentLocationCheckpoint: o.current_location_checkpoint || defaultCheckpoint,
        rtoReason: o.rto_reason || '',
        rtoRestockMode: o.rto_restock_mode || 'NONE',
        rtoProcessedAt: o.rto_processed_at || null,
        labelPrintedAt: o.label_printed_at || null,
        notes: o.notes || '',
        cancelReason: o.cancel_reason || '',
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        deliveredAt: o.delivered_at,
        customerName: recipientName,
        customerEmail: o.customer_email || addr.email || '',
        customerPhone: recipientPhone,
        customerAltPhone: recipientAltPhone,
        line1,
        line2,
        landmark,
        city,
        state,
        pincode,
        fullFormattedAddress,
        hasGps,
        latitude: addr.latitude || null,
        longitude: addr.longitude || null,
        googleMapsUrl,
        addressSnapshot: addr,
        items: mappedItems,
        shippingLabels: shippingLabelsByOrder[o.id] || [],
        lockedBy: activeLock?.lockedByName || null,
        lockedBySession: activeLock?.sessionCode || null,
      };
    });

    const carriers = await getPublicCarrierStatus().catch(() => []);

    res.json({
      success: true,
      syncedAt: new Date().toISOString(),
      viewer: req.invUser,
      items,
      customers,
      sales,
      movements: movementRows,
      logs: auditRows.map(a => ({
        id: a.id,
        t: a.created_at,
        user: a.actor_username,
        role: a.actor_role,
        act: a.action_code,
        msg: a.summary,
        signature: a.signature_sha512,
      })),
      batches: batchRows,
      onlineOrders,
      orderLocks: Array.from(activeOrderLocksMemory.values()).filter(l => !l.expiresAt || l.expiresAt > Date.now()),
      dailyBackups: dailyBackupRows,
      shippingZones: shippingZoneRows,
      carriers,
      cfg,
    });
    if (shouldSyncWebsiteProducts) {
      res.once('finish', () => {
        bootstrapProductSyncPromise = syncWebsiteProductsToInventoryMeta(pool)
          .then(() => ensureDailyAutoBackup(pool, req.invUser.username || 'auto-daily'))
          .catch(err => {
            lastBootstrapHeavyWorkAt = 0;
            console.error('[INVENTORY_BOOTSTRAP_BACKGROUND_SYNC_ERROR]', err);
          })
          .finally(() => {
            bootstrapProductSyncPromise = null;
          });
      });
    }
  } catch (err) {
    console.error('[INVENTORY_BOOTSTRAP_ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to load inventory suite data: ' + err.message });
  }
});

// 3B. HIGH-VELOCITY SUMMARY & PAGINATED PERFORMANCE ENDPOINTS
router.get('/summary', authenticateInventoryStaff, async (_req, res) => {
  try {
    const [
      [[orderCounts]],
      [[lowStockCount]],
      [[posRevToday]],
      [[queueCount]],
    ] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(CASE WHEN status IN ('pending', 'confirmed') THEN 1 END) AS pendingCount,
          COUNT(CASE WHEN status = 'packed' THEN 1 END) AS packedCount,
          COUNT(CASE WHEN status = 'shipped' THEN 1 END) AS shippedCount,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) AS deliveredCount,
          COUNT(CASE WHEN status IN ('cancelled', 'rto_delivered') THEN 1 END) AS rtoCount,
          COUNT(*) AS totalOrders
        FROM orders
        WHERE status <> 'archived'
      `),
      pool.query(`
        SELECT COUNT(*) AS count
        FROM inventory_product_meta m
        LEFT JOIN products p ON p.id = m.product_id
        WHERE COALESCE(p.quantity, m.physical_stock, 0) <= COALESCE(m.min_stock_alert, 20)
      `),
      pool.query(`
        SELECT COALESCE(SUM(bill_total), 0) AS total
        FROM inventory_pos_invoices
        WHERE status <> 'cancelled' AND DATE(created_at) = CURDATE()
      `),
      pool.query(`
        SELECT COUNT(*) AS count
        FROM inventory_scanner_queue
        WHERE status = 'queued'
      `),
    ]);

    res.json({
      success: true,
      summary: {
        pendingOrders: Number(orderCounts?.pendingCount) || 0,
        packedOrders: Number(orderCounts?.packedCount) || 0,
        shippedOrders: Number(orderCounts?.shippedCount) || 0,
        deliveredOrders: Number(orderCounts?.deliveredCount) || 0,
        rtoOrders: Number(orderCounts?.rtoCount) || 0,
        totalOrders: Number(orderCounts?.totalOrders) || 0,
        lowStockItems: Number(lowStockCount?.count) || 0,
        posRevenueToday: Number(posRevToday?.total) || 0,
        scannerQueueCount: Number(queueCount?.count) || 0,
      },
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/orders', authenticateInventoryStaff, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    const status = String(req.query.status || 'ALL').trim();
    const search = String(req.query.q || req.query.search || '').trim().toLowerCase();
    const date = String(req.query.date || '').trim();

    let whereClause = "WHERE o.status <> 'archived'";
    const params = [];

    if (status !== 'ALL') {
      if (status === 'DISPATCH') {
        whereClause += " AND o.status IN ('pending', 'confirmed', 'packed')";
      } else {
        whereClause += " AND o.status = ?";
        params.push(status);
      }
    }

    if (date) {
      whereClause += " AND DATE(o.created_at) = ?";
      params.push(date);
    }

    if (search) {
      whereClause += ` AND (
        o.order_number LIKE ? OR
        o.id = ? OR
        u.name LIKE ? OR
        u.phone LIKE ? OR
        o.tracking_number LIKE ? OR
        o.courier LIKE ?
      )`;
      const wild = `%${search}%`;
      const numSearch = Number(search) || 0;
      params.push(wild, numSearch, wild, wild, wild, wild);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}`,
      params
    );

    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.user_id, o.status, o.delivery_type,
              o.payment_mode, o.payment_status, o.payment_id,
              o.subtotal, o.discount, o.tier_discount, o.referral_wallet_amount,
              o.shipping_cost, o.total, o.courier, o.tracking_number, o.tracking_url,
              o.notes, o.cancel_reason, o.created_at, o.updated_at, o.delivered_at,
              o.estimated_delivery_date, o.current_location_checkpoint,
              o.rto_reason, o.rto_restock_mode, o.rto_processed_at, o.label_printed_at,
              o.address_snapshot,
              u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const orderIds = orders.map(o => o.id);
    const orderItemsByOrder = {};
    const shippingLabelsByOrder = {};
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const [oItems] = await pool.query(
        `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
        orderIds
      );
      for (const it of oItems) {
        if (!orderItemsByOrder[it.order_id]) orderItemsByOrder[it.order_id] = [];
        orderItemsByOrder[it.order_id].push(it);
      }

      const [sLabels] = await pool.query(
        `SELECT * FROM shipping_labels WHERE order_id IN (${placeholders}) ORDER BY id DESC`,
        orderIds
      ).catch(() => [[]]);
      for (const lb of sLabels) {
        if (!shippingLabelsByOrder[lb.order_id]) shippingLabelsByOrder[lb.order_id] = [];
        shippingLabelsByOrder[lb.order_id].push(lb);
      }
    }

    const formattedOrders = orders.map(o => {
      let addr = o.address_snapshot;
      if (typeof addr === 'string') {
        try { addr = JSON.parse(addr); } catch { addr = null; }
      }
      return {
        id: o.id,
        orderNumber: o.order_number || `BV-${o.id}`,
        userId: o.user_id,
        status: o.status,
        deliveryType: o.delivery_type,
        paymentMode: o.payment_mode,
        paymentStatus: o.payment_status,
        total: Number(o.total) || 0,
        courier: o.courier || '',
        trackingNumber: o.tracking_number || '',
        trackingUrl: o.tracking_url || '',
        currentLocationCheckpoint: o.current_location_checkpoint || '',
        labelPrintedAt: o.label_printed_at || null,
        rtoReason: o.rto_reason || '',
        rtoRestockMode: o.rto_restock_mode || '',
        rtoProcessedAt: o.rto_processed_at || null,
        customerName: o.customer_name || addr?.full_name || 'Patron',
        customerPhone: o.customer_phone || addr?.phone || 'N/A',
        city: addr?.city || '',
        state: addr?.state || '',
        pincode: addr?.pincode || '',
        addressLine1: addr?.address_line1 || '',
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        items: (orderItemsByOrder[o.id] || []).map(it => ({
          id: it.id,
          productId: it.product_id,
          name: it.name,
          quantity: it.quantity,
          price: Number(it.price) || 0,
        })),
        shippingLabels: shippingLabelsByOrder[o.id] || [],
      };
    });

    res.json({
      success: true,
      orders: formattedOrders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/stock/forecast', authenticateInventoryStaff, async (_req, res) => {
  try {
    const forecastData = await calculateInventoryVelocityAndDoc(pool);
    res.json({ success: true, ...forecastData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/orders/:orderId/fefo-picks', authenticateInventoryStaff, async (req, res) => {
  try {
    const allocations = await allocateFefoBatchesForOrder(pool, req.params.orderId);
    res.json({ success: true, ...allocations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/fulfillment/wave-picklist', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const { orderIds = [] } = req.body || {};
    const picklist = await generateWavePicklist(pool, orderIds);
    res.json({ success: true, picklist });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/fulfillment/manifest', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const { orderIds = [], courier = 'All Carriers' } = req.body || {};
    const manifest = await generateCarrierManifest(pool, orderIds, courier, req.invUser.username);
    res.json({ success: true, manifest });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/fulfillment/verify-pack', authenticateScannerOrStaff, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { orderId, barcode, qrCode, code } = req.body || {};
    const inputCode = barcode || qrCode || code;
    if (!orderId || !inputCode) {
      return res.status(400).json({ success: false, message: 'orderId and barcode/qrCode are required.' });
    }
    await conn.beginTransaction();
    const rawOrderParam = String(orderId).trim().replace(/^ORD:/i, '').replace(/^#/i, '').trim();
    const numericCandidate = Number(rawOrderParam.replace(/\D/g, '')) || 0;
    let orderRecord = null;
    if (numericCandidate > 0) {
      const [[foundOrder]] = await conn.query(
        'SELECT id, order_number, status FROM orders WHERE id = ? OR order_number = ? LIMIT 1 FOR UPDATE',
        [numericCandidate, rawOrderParam]
      );
      orderRecord = foundOrder;
    }
    if (!orderRecord) {
      const [[foundByText]] = await conn.query(
        'SELECT id, order_number, status FROM orders WHERE order_number = ? LIMIT 1 FOR UPDATE',
        [rawOrderParam]
      );
      orderRecord = foundByText;
    }
    if (!orderRecord) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: `Order "${orderId}" was not found.` });
    }
    const realOrderId = orderRecord.id;
    const operator = resolveRequestOperator(req);
    const lockCheck = acquireOrVerifyOrderLock({
      orderId: orderRecord.order_number || realOrderId,
      operatorUsername: operator.username,
      operatorName: operator.name,
      sessionCode: operator.sessionCode,
      lockType: 'PACKING',
      allowCompletedRead: true,
    });
    if (!lockCheck.allowed) {
      await conn.rollback();
      return res.status(lockCheck.status || 409).json(lockCheck);
    }
    const idLockCheck = acquireOrVerifyOrderLock({
      orderId: realOrderId,
      operatorUsername: operator.username,
      operatorName: operator.name,
      sessionCode: operator.sessionCode,
      lockType: 'PACKING',
      allowCompletedRead: true,
    });
    if (!idLockCheck.allowed) {
      await conn.rollback();
      return res.status(idLockCheck.status || 409).json(idLockCheck);
    }
    if (['cancelled', 'delivered', 'shipped', 'returned', 'archived'].includes(String(orderRecord.status).toLowerCase())) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        code: 'ORDER_NOT_PACKABLE',
        message: `Order #${orderRecord.order_number || realOrderId} cannot be packed while its status is "${orderRecord.status}".`,
      });
    }

    let cleanBarcode = String(inputCode).trim();
    if (cleanBarcode.includes("code=")) {
      const m = cleanBarcode.match(/code=([^&]+)/);
      if (m && m[1]) cleanBarcode = decodeURIComponent(m[1]);
    }

    const resolved = await resolveProductByQrOrCode(conn, cleanBarcode);
    if (!resolved) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: `Scanned code "${cleanBarcode}" did not match any catalog SKU or batch.` });
    }
    const [orderItems] = await conn.query(
      `SELECT oi.id, oi.product_id, oi.name, oi.quantity,
              COALESCE(m.sku, p.sku) AS sku, m.barcode
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       LEFT JOIN inventory_product_meta m ON m.product_id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC
       FOR UPDATE`,
      [realOrderId]
    );
    const matchingItems = orderItems.filter(it =>
      (Number(it.product_id) > 0 && Number(it.product_id) === Number(resolved.productId)) ||
      (resolved.sku && String(it.sku || '').toLowerCase() === String(resolved.sku).toLowerCase()) ||
      (resolved.barcode && String(it.barcode || '').toLowerCase() === String(resolved.barcode).toLowerCase())
    );
    if (matchingItems.length === 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        verified: false,
        code: 'ITEM_NOT_IN_ORDER',
        message: `⛔ REJECTED: "${resolved.name}" is NOT in Order #${orderRecord.order_number || realOrderId}! Dispatch blocked.`,
      });
    }

    let matchingItem = null;
    let verifiedCount = 0;
    let itemQuantity = 0;
    let lastMatchingItem = null;
    let lastVerifiedCount = 0;
    let lastItemQuantity = 0;
    for (const candidate of matchingItems) {
      await conn.query(
        `INSERT IGNORE INTO inventory_order_pack_progress (order_item_id, order_id, verified_quantity)
         VALUES (?, ?, 0)`,
        [candidate.id, realOrderId]
      );
      const [[progressRow]] = await conn.query(
        'SELECT verified_quantity FROM inventory_order_pack_progress WHERE order_item_id = ? FOR UPDATE',
        [candidate.id]
      );
      const candidateCount = Number(progressRow?.verified_quantity) || 0;
      const candidateQuantity = Number(candidate.quantity) || 1;
      lastMatchingItem = candidate;
      lastVerifiedCount = candidateCount;
      lastItemQuantity = candidateQuantity;
      if (candidateCount < candidateQuantity) {
        matchingItem = candidate;
        verifiedCount = candidateCount;
        itemQuantity = candidateQuantity;
        break;
      }
    }
    if (!matchingItem) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        verified: false,
        code: 'ITEM_ALREADY_VERIFIED',
        progress: {
          orderItemId: lastMatchingItem.id,
          verifiedCount: lastVerifiedCount,
          quantity: lastItemQuantity,
        },
        message: `"${lastMatchingItem.name}" is already fully scanned (${lastVerifiedCount}/${lastItemQuantity}).`,
      });
    }

    await conn.query(
      'UPDATE inventory_order_pack_progress SET verified_quantity = ? WHERE order_item_id = ?',
      [verifiedCount + 1, matchingItem.id]
    );
    const [updatedItems] = await conn.query(
      `SELECT oi.id AS order_item_id, oi.quantity,
              COALESCE(pp.verified_quantity, 0) AS verified_count
       FROM order_items oi
       LEFT JOIN inventory_order_pack_progress pp ON pp.order_item_id = oi.id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [realOrderId]
    );
    const totalUnits = updatedItems.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const totalVerified = updatedItems.reduce((sum, item) => sum + (Number(item.verified_count) || 0), 0);
    const orderComplete = totalUnits > 0 && totalVerified >= totalUnits;
    const orderStatus = orderComplete ? 'packed' : orderRecord.status;
    if (orderStatus !== orderRecord.status) {
      await conn.query('UPDATE orders SET status = ? WHERE id = ?', [orderStatus, realOrderId]);
    }
    await conn.commit();

    res.json({
      success: true,
      verified: true,
      orderId: realOrderId,
      orderNumber: orderRecord.order_number || realOrderId,
      orderStatus,
      orderComplete,
      progress: {
        orderItemId: matchingItem.id,
        verifiedCount: verifiedCount + 1,
        quantity: itemQuantity,
        totalVerified,
        totalUnits,
      },
      product: {
        productId: resolved.productId,
        sku: resolved.sku,
        name: resolved.name,
        barcode: resolved.barcode,
        batchNo: resolved.batchNo,
      },
      message: orderComplete
        ? `All ${totalUnits} units for Order #${orderRecord.order_number || realOrderId} are scanned. The order is packed and ready for dispatch.`
        : `Verified "${resolved.name}" for Order #${orderRecord.order_number || realOrderId} (${totalVerified}/${totalUnits} units scanned).`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/inventory-software/orders/:id/manifest - Guided Packing Manifest
router.get('/orders/:id/manifest', authenticateScannerOrStaff, async (req, res) => {
  try {
    const rawParam = String(req.params.id || '').trim().replace(/^ORD:/i, '').replace(/^#/i, '').trim();
    if (!rawParam) return res.status(400).json({ success: false, message: 'Invalid Order ID format.' });

    const numericCandidate = Number(rawParam.replace(/\D/g, '')) || 0;
    let order = null;
    if (numericCandidate > 0) {
      const [[foundOrder]] = await pool.query(
        `SELECT o.*, u.name AS u_name, u.phone AS u_phone, u.email AS u_email
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.id = ? OR o.order_number = ?
         LIMIT 1`,
        [numericCandidate, rawParam]
      );
      order = foundOrder;
    }

    if (!order) {
      const [[foundByText]] = await pool.query(
        `SELECT o.*, u.name AS u_name, u.phone AS u_phone, u.email AS u_email
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.order_number = ?
         LIMIT 1`,
        [rawParam]
      );
      order = foundByText;
    }

    if (!order) {
      return res.status(404).json({ success: false, message: `Order "${rawParam}" was not found.` });
    }

    const operator = resolveRequestOperator(req);
    const lockCheck = acquireOrVerifyOrderLock({
      orderId: order.order_number || order.id,
      operatorUsername: operator.username,
      operatorName: operator.name,
      sessionCode: operator.sessionCode,
      lockType: 'PACKING',
      allowCompletedRead: true,
    });
    if (!lockCheck.allowed) {
      return res.status(lockCheck.status || 409).json(lockCheck);
    }
    const idLockCheck = acquireOrVerifyOrderLock({
      orderId: order.id,
      operatorUsername: operator.username,
      operatorName: operator.name,
      sessionCode: operator.sessionCode,
      lockType: 'PACKING',
      allowCompletedRead: true,
    });
    if (!idLockCheck.allowed) {
      return res.status(idLockCheck.status || 409).json(idLockCheck);
    }

    const [items] = await pool.query(
      `SELECT oi.id AS order_item_id, oi.product_id, oi.name, oi.price, oi.quantity,
              COALESCE(m.sku, p.sku, CONCAT('SKU-', oi.product_id)) AS sku,
              m.barcode, m.bin_code, m.batch_no, m.gst_hsn_code, m.gst_rate,
              COALESCE(pp.verified_quantity, 0) AS verified_count
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN inventory_product_meta m ON oi.product_id = m.product_id
       LEFT JOIN inventory_order_pack_progress pp ON pp.order_item_id = oi.id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [order.id]
    );

    const addr = parseJsonSafe(order.address_snapshot, {}) || {};
    const resolvedCustName = addr.full_name || addr.fullName || addr.name || order.u_name || 'Valued Patron';
    const resolvedCustPhone = addr.phone || addr.mobile || order.u_phone || '';
    const resolvedCustEmail = addr.email || order.u_email || '';
    const resolvedCity = addr.city || addr.district || 'Asansol';
    const resolvedState = addr.state || 'West Bengal';
    const resolvedPincode = String(addr.pincode || addr.postal_code || '');
    const resolvedLine1 = addr.line1 || addr.street_address || addr.address || '';
    const resolvedLine2 = addr.line2 || addr.area || '';
    const resolvedAddress = [resolvedLine1, resolvedLine2, addr.landmark, resolvedCity, resolvedState, resolvedPincode].filter(Boolean).join(', ');
    const resolvedTotal = Number(order.total ?? order.total_amount ?? 0);

    res.json({
      success: true,
      order: {
        id: order.id,
        orderNumber: order.order_number || String(order.id),
        customerName: resolvedCustName,
        customerPhone: resolvedCustPhone,
        customerEmail: resolvedCustEmail,
        shippingCity: resolvedCity,
        shippingState: resolvedState,
        shippingPincode: resolvedPincode,
        shippingAddress: resolvedAddress,
        status: order.status,
        totalAmount: resolvedTotal,
        trackingNumber: order.tracking_number || '',
        carrier: order.courier || order.carrier || 'Express Dispatch',
        createdAt: order.created_at,
        totalItemsCount: items.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0),
        items: items.map(it => ({
          orderItemId: it.order_item_id,
          productId: it.product_id,
          name: it.name,
          sku: it.sku,
          barcode: it.barcode || it.sku,
          price: Number(it.price) || 0,
          quantity: Number(it.quantity) || 1,
          binCode: it.bin_code || 'ASN-SHOP-R1-B01',
          batchNo: it.batch_no || '',
          gstHsnCode: it.gst_hsn_code || '30049011',
          gstRate: Number(it.gst_rate) || 5,
          verifiedCount: Number(it.verified_count) || 0,
        })),
      },
      items: items.map(it => ({
        orderItemId: it.order_item_id,
        productId: it.product_id,
        name: it.name,
        sku: it.sku,
        barcode: it.barcode || it.sku,
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 1,
        binCode: it.bin_code || 'ASN-SHOP-R1-B01',
        batchNo: it.batch_no || '',
        gstHsnCode: it.gst_hsn_code || '30049011',
        gstRate: Number(it.gst_rate) || 5,
        verifiedCount: Number(it.verified_count) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/inventory-software/orders/:id/items - Admin Live Order Item Modifier
router.put('/orders/:id/items', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const rawParam = String(req.params.id || '').trim().replace(/^ORD:/i, '').replace(/^#/i, '').trim();
    const numericCandidate = Number(rawParam.replace(/\D/g, '')) || 0;
    const { items = [] } = req.body || {};

    if (!rawParam) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid Order ID format.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'At least one order line item is required.' });
    }

    let order = null;
    if (numericCandidate > 0) {
      const [[foundOrder]] = await conn.query('SELECT id, status, total_amount, order_number FROM orders WHERE id = ? OR order_number = ? FOR UPDATE', [numericCandidate, rawParam]);
      order = foundOrder;
    }
    if (!order) {
      const [[foundByText]] = await conn.query('SELECT id, status, total_amount, order_number FROM orders WHERE order_number = ? FOR UPDATE', [rawParam]);
      order = foundByText;
    }
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: `Order "${rawParam}" does not exist.` });
    }
    const realOrderId = order.id;
    if (order.status === 'cancelled' || order.status === 'delivered') {
      await conn.rollback();
      return res.status(400).json({ success: false, message: `Cannot modify items for an order with status "${order.status}".` });
    }

    const normalizedItems = [];
    for (const [index, item] of items.entries()) {
      const requestedProductId = Number(item?.productId);
      const quantity = Number(item?.quantity);
      const price = Number(item?.price);
      if (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price < 0) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: `Item ${index + 1} must have a positive whole-number quantity and a valid non-negative price.`,
        });
      }

      let productId = Number.isInteger(requestedProductId) && requestedProductId > 0
        ? requestedProductId
        : null;
      if (productId) {
        const [[product]] = await conn.query('SELECT id FROM products WHERE id = ? LIMIT 1', [productId]);
        if (!product) productId = null;
      }

      if (!productId && item?.sku) {
        const [[product]] = await conn.query(
          `SELECT p.id
           FROM products p
           LEFT JOIN inventory_product_meta m ON m.product_id = p.id
           WHERE LOWER(p.sku) = LOWER(?) OR LOWER(m.sku) = LOWER(?)
           ORDER BY p.id ASC
           LIMIT 1`,
          [String(item.sku).trim(), String(item.sku).trim()]
        );
        productId = product?.id || null;
      }

      if (!productId) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          code: 'ORDER_ITEM_PRODUCT_NOT_FOUND',
          message: `Item "${String(item?.name || item?.sku || index + 1).trim()}" must match an existing catalog product. Enter its exact product SKU before saving.`,
        });
      }
      normalizedItems.push({
        productId,
        quantity,
        price,
        name: String(item?.name || 'Bhumivera Product').trim(),
      });
    }

    await conn.query('DELETE FROM order_items WHERE order_id = ?', [realOrderId]);
    await conn.query('DELETE FROM inventory_order_pack_progress WHERE order_id = ?', [realOrderId]);

    let newTotal = 0;
    for (const item of normalizedItems) {
      newTotal += item.price * item.quantity;

      await conn.query(
        `INSERT INTO order_items (order_id, product_id, name, price, quantity)
         VALUES (?, ?, ?, ?, ?)`,
        [realOrderId, item.productId, item.name, item.price, item.quantity]
      );
    }

    await conn.query('UPDATE orders SET total_amount = ? WHERE id = ?', [newTotal, realOrderId]);
    await conn.commit();

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'ADMIN_ORDER_ITEMS_MODIFIED',
      summary: `Admin modified line items for Order #${order.order_number || realOrderId} (New Total: ₹${newTotal}, Items: ${items.length}).`,
    });

    res.json({
      success: true,
      orderId: realOrderId,
      orderNumber: order.order_number || realOrderId,
      newTotal,
      items: normalizedItems,
      message: `Order #${order.order_number || realOrderId} items updated successfully. Total recalculated to ₹${newTotal}.`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/inventory-software/package/lookup - Package Finder & Lost Parcel Detective
router.get('/package/lookup', authenticateScannerOrStaff, async (req, res) => {
  try {
    const rawCode = String(req.query.code || req.query.qrCode || '').trim();
    if (!rawCode) {
      return res.status(400).json({ success: false, message: 'Package barcode or Order ID is required.' });
    }

    let searchCode = rawCode;
    try { searchCode = decodeURIComponent(searchCode); } catch (_) {}
    if (searchCode.includes("code=")) {
      const m = searchCode.match(/code=([^&]+)/);
      if (m && m[1]) searchCode = decodeURIComponent(m[1]);
    }

    const numericCandidate = Number(searchCode.replace(/\D/g, ''));

    let order = null;
    if (numericCandidate > 0) {
      const [[foundOrder]] = await pool.query(
        `SELECT o.*, u.name AS u_name, u.phone AS u_phone, u.email AS u_email
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.id = ? OR o.order_number = ? OR o.tracking_number = ?
         LIMIT 1`,
        [numericCandidate, searchCode, searchCode]
      );
      order = foundOrder;
    }

    if (!order) {
      const [[foundByText]] = await pool.query(
        `SELECT o.*, u.name AS u_name, u.phone AS u_phone, u.email AS u_email
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.order_number = ? OR o.tracking_number = ?
         LIMIT 1`,
        [searchCode, searchCode]
      );
      order = foundByText;
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        code: 'PACKAGE_NOT_FOUND',
        message: `No active warehouse package found matching code "${searchCode}".`,
      });
    }

    const [items] = await pool.query(
      `SELECT oi.id AS order_item_id, oi.product_id, oi.name, oi.price, oi.quantity,
              COALESCE(m.sku, p.sku, CONCAT('SKU-', oi.product_id)) AS sku,
              m.barcode, m.bin_code, m.batch_no, m.gst_hsn_code
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN inventory_product_meta m ON oi.product_id = m.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [order.id]
    );

    const pkgAddr = parseJsonSafe(order.address_snapshot, {}) || {};
    const pkgCustName = pkgAddr.full_name || pkgAddr.fullName || pkgAddr.name || order.u_name || 'Valued Patron';
    const pkgCustPhone = pkgAddr.phone || pkgAddr.mobile || order.u_phone || '';
    const pkgCustEmail = pkgAddr.email || order.u_email || '';
    const pkgCity = pkgAddr.city || pkgAddr.district || 'Asansol';
    const pkgState = pkgAddr.state || 'West Bengal';
    const pkgPincode = String(pkgAddr.pincode || pkgAddr.postal_code || '713304');
    const pkgAddress = [pkgAddr.line1 || pkgAddr.address, pkgAddr.line2, pkgAddr.landmark, pkgCity, pkgState, pkgPincode].filter(Boolean).join(', ');
    const pkgTotal = Number(order.total ?? order.total_amount ?? 0);

    res.json({
      success: true,
      package: {
        orderId: order.id,
        orderNumber: order.order_number || String(order.id),
        packageCode: `PKG:${order.id}`,
        customerName: pkgCustName,
        customerPhone: pkgCustPhone,
        customerEmail: pkgCustEmail,
        shippingAddress: pkgAddress,
        shippingCity: pkgCity,
        shippingState: pkgState,
        shippingPincode: pkgPincode,
        status: order.status,
        totalAmount: pkgTotal,
        trackingNumber: order.tracking_number || 'Unassigned',
        courier: order.courier || order.carrier || 'Bhumivera Express Dispatch',
        createdAt: order.created_at,
        itemsCount: items.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0),
        items: items.map(it => ({
          name: it.name,
          sku: it.sku,
          quantity: Number(it.quantity) || 1,
          price: Number(it.price) || 0,
          binCode: it.bin_code || 'ASN-SHOP-R1-B01',
          batchNo: it.batch_no || 'BV-BATCH-2026',
          gstHsnCode: it.gst_hsn_code || '30049011',
        })),
      },
      message: `Package identified for ${order.resolved_customer_name} (Order #${order.id}).`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/returns/qc-grade', authenticateInventoryStaff, requirePermission('can_process_returns'), async (req, res) => {
  try {
    const { orderId, grade = 'GRADE_A', notes = '' } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required.' });
    }
    const result = await processReturnQcGrade(pool, {
      orderId,
      grade,
      notes,
      actorUsername: req.invUser.username,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// 4. MASTER INVENTORY CRUD & REAL-TIME WEBSITE STOCK SYNC
router.post('/items/save', authenticateInventoryStaff, requirePermission('can_manage_inventory'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      id,
      productId,
      name,
      sku,
      barcode,
      cat = 'Botanical Formulations',
      uom = 'Pcs',
      qty = 0,
      shopDisplayStock,
      warehouseVaultStock,
      safetyBufferStock = 0,
      costPrice = 0,
      mrp = 0,
      price = 0,
      gstHsnCode = '30049011',
      gstRate = 5,
      minStock = 15,
      reorderQty = 50,
      binCode = 'ASN-SHOP-R1-B01',
      rackLocation = 'Zone A • Rack 01 • Shelf A',
      batchNo = '',
      mfgDate = null,
      expiryDate = null,
      syncToWebsite = true,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Item name is required.' });
    }

    const cleanSku = String(sku || `SKU-${Date.now().toString().slice(-6)}`).trim();
    const cleanBarcode = String(barcode || cleanSku).trim();
    const safeQty = Math.max(0, Math.trunc(Number(qty) || 0));
    const safeBuffer = Math.max(0, Math.trunc(Number(safetyBufferStock) || 0));
    const webAvailQty = Math.max(0, safeQty - safeBuffer);
    const safeSellingPrice = Math.max(0, Number(price) || 0);
    const safeCostPrice = Math.max(0, Number(costPrice) || 0);
    const safeMrp = Math.max(safeSellingPrice, Number(mrp) || safeSellingPrice);
    const safeShopDisplay =
      shopDisplayStock !== undefined ? Math.max(0, Math.trunc(Number(shopDisplayStock))) : Math.ceil(safeQty * 0.3);
    const safeVaultStock =
      warehouseVaultStock !== undefined
        ? Math.max(0, Math.trunc(Number(warehouseVaultStock)))
        : Math.max(0, safeQty - safeShopDisplay);
    const qrPayload = `https://www.bhumivera.com/verify?sku=${encodeURIComponent(cleanSku)}&batch=${encodeURIComponent(batchNo || 'BV-BATCH-2026')}`;

    let linkedProductId = productId ? Number(productId) : null;
    let qtyBefore = 0;

    if (id) {
      const [[existingMeta]] = await conn.query(
        'SELECT * FROM inventory_product_meta WHERE id = ? FOR UPDATE',
        [id]
      );
      if (existingMeta) {
        linkedProductId = linkedProductId || existingMeta.product_id;
        qtyBefore = Number(existingMeta.physical_stock) || 0;
        await conn.query(
          `UPDATE inventory_product_meta
           SET custom_name = ?, sku = ?, barcode = ?, qr_code_payload = ?, category_name = ?, uom = ?,
               cost_price = ?, mrp = ?, selling_price = ?, gst_hsn_code = ?, gst_rate = ?,
               physical_stock = ?, shop_display_stock = ?, warehouse_vault_stock = ?,
               safety_buffer_stock = ?, min_stock_alert = ?, reorder_qty = ?,
               bin_code = ?, rack_location = ?, batch_no = ?, mfg_date = ?, expiry_date = ?,
               sync_to_website = ?
           WHERE id = ?`,
          [
            cleanName,
            cleanSku,
            cleanBarcode,
            qrPayload,
            cat,
            uom,
            safeCostPrice,
            safeMrp,
            safeSellingPrice,
            gstHsnCode,
            Number(gstRate) || 18,
            safeQty,
            safeShopDisplay,
            safeVaultStock,
            safeBuffer,
            Number(minStock) || 15,
            Number(reorderQty) || 50,
            binCode,
            rackLocation,
            batchNo || null,
            mfgDate || null,
            expiryDate || null,
            syncToWebsite ? 1 : 0,
            id,
          ]
        );
      }
    } else {
      if (syncToWebsite && !linkedProductId) {
        const slug = cleanName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') + '-' + Math.floor(100 + Math.random() * 900);
        const [prodIns] = await conn.query(
          `INSERT INTO products (name, slug, sku, price, discount_price, quantity, status, gst_hsn_code, gst_rate)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [cleanName, slug, cleanSku, safeMrp, safeSellingPrice, webAvailQty, gstHsnCode, Number(gstRate) || 18]
        );
        linkedProductId = prodIns.insertId;
      }

      await conn.query(
        `INSERT INTO inventory_product_meta
          (warehouse_id, product_id, custom_name, sku, barcode, qr_code_payload, category_name, uom, cost_price, mrp, selling_price,
           gst_hsn_code, gst_rate, physical_stock, shop_display_stock, warehouse_vault_stock,
           safety_buffer_stock, min_stock_alert, reorder_qty, bin_code, rack_location,
           batch_no, mfg_date, expiry_date, sync_to_website)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          linkedProductId,
          cleanName,
          cleanSku,
          cleanBarcode,
          qrPayload,
          cat,
          uom,
          safeCostPrice,
          safeMrp,
          safeSellingPrice,
          gstHsnCode,
          Number(gstRate) || 18,
          safeQty,
          safeShopDisplay,
          safeVaultStock,
          safeBuffer,
          Number(minStock) || 15,
          Number(reorderQty) || 50,
          binCode,
          rackLocation,
          batchNo || null,
          mfgDate || null,
          expiryDate || null,
          syncToWebsite ? 1 : 0,
        ]
      );
    }

    if (linkedProductId) {
      await conn.query(
        `UPDATE products
         SET name = ?, sku = ?, quantity = ?, discount_price = ?, price = GREATEST(price, ?),
             gst_hsn_code = ?, gst_rate = ?
         WHERE id = ?`,
        [
          cleanName,
          cleanSku,
          webAvailQty,
          safeSellingPrice,
          safeMrp,
          gstHsnCode,
          Number(gstRate) || 18,
          linkedProductId,
        ]
      );
      await recalculateAllBundleStocks(conn);
    }

    if (safeQty !== qtyBefore) {
      await recordStockMovement(conn, {
        productId: linkedProductId,
        sku: cleanSku,
        productName: cleanName,
        movementType: id ? 'MANUAL_OVERRIDE' : 'INITIAL_STOCK',
        qtyBefore,
        qtyDelta: safeQty - qtyBefore,
        qtyAfter: safeQty,
        binCode,
        batchNo,
        reason: id ? 'Updated in Master Inventory' : 'Created new item in Master Inventory',
        operatorUsername: req.invUser.username,
      });
    }

    await appendInventoryAuditLog(conn, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: id ? 'INV_ITEM_EDIT' : 'INV_ITEM_CREATE',
      summary: `${id ? 'Updated' : 'Created'} item "${cleanName}" [${cleanSku}] — Physical Stock: ${safeQty}, Website Live Stock: ${webAvailQty}.`,
    });

    await conn.commit();
    await invalidatePublicCatalogCache();

    res.json({
      success: true,
      message: `Saved "${cleanName}" and synced live website stock (${webAvailQty} units available online).`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

router.delete('/items/:id', authenticateInventoryStaff, requirePermission('can_manage_inventory'), async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM inventory_product_meta WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Item not found.' });
    await pool.query('DELETE FROM inventory_product_meta WHERE id = ?', [req.params.id]);
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'INV_ITEM_DELETE',
      summary: `Removed inventory record "${row.custom_name}" [${row.sku}].`,
    });
    res.json({ success: true, message: 'Item removed from inventory.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/stock/adjust', authenticateInventoryStaff, requirePermission('can_adjust_stock'), async (req, res) => {
  try {
    const {
      metaId,
      productId,
      sku,
      operation = 'subtract',
      quantity = 1,
      reason = 'Stock Adjustment',
      movementType = 'STOCK_ADJUSTMENT',
      quarantineDelta = 0,
    } = req.body || {};

    const result = await atomicAdjustProductStock({
      metaId,
      productId,
      sku,
      operation,
      quantity,
      movementType,
      reason,
      operatorUsername: req.invUser.username,
      quarantineDelta,
    });

    await pool.query(
      'UPDATE inventory_staff_accounts SET total_stock_ops = total_stock_ops + 1 WHERE id = ?',
      [req.invUser.id]
    ).catch(() => {});

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'STOCK_ADJUST',
      summary: `${reason}: ${result.name} (${result.qtyBefore} → ${result.qtyAfter}, Website Available: ${result.websiteAvailableQty}).`,
      details: result,
    });

    res.json({
      success: true,
      message: `Stock updated for "${result.name}": ${result.qtyBefore} → ${result.qtyAfter} (Live Website: ${result.websiteAvailableQty}).`,
      result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// ============================================================================
// STAFF MOBILE LOGIN & WORKROOM PRESENCE ("GO ON WORK" 24x7 TEAM RADAR)
// ============================================================================

/**
 * POST /api/inventory-software/scanner/auth/login
 * Allows warehouse staff (Akash, Priya C, Rahul, Vikram, etc.) to log in directly
 * on their mobile phone with Username & Password without needing to pair every time.
 */
router.post('/scanner/auth/login', async (req, res) => {
  try {
    const { username = '', password = '', deviceName = 'Mobile Scanner' } = req.body || {};
    const cleanUser = String(username).trim().toLowerCase();
    if (!cleanUser || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const accountRow = scannerStaffCredentialsMemory.get(cleanUser);
    if (!accountRow) {
      return res.status(503).json({
        success: false,
        code: 'SCANNER_ROSTER_NOT_LOADED',
        message: 'Scanner staff accounts are not loaded in backend memory. An inventory administrator must open or refresh Workroom → Staff Accounts, then try again.',
      });
    }

    if (accountRow.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'This staff account has been suspended.' });
    }

    const passwordMatches = accountRow.password_hash
      ? await bcrypt.compare(String(password), accountRow.password_hash)
      : false;
    if (!passwordMatches) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const norm = normalizeStaffAccount(accountRow);
    const jti = crypto.randomUUID();
    const activeTokens = scannerTokenIdsMemory.get(cleanUser) || new Set();
    activeTokens.add(jti);
    scannerTokenIdsMemory.set(cleanUser, activeTokens);
    const token = jwt.sign({
      id: norm.id,
      sub: norm.id,
      username: norm.username,
      fullName: norm.fullName,
      email: norm.email,
      role: norm.role,
      assignedHub: norm.assignedHub,
      scope: 'inventory-software',
      scannerAuth: true,
      jti,
    }, secret(), { expiresIn: '24h' });
    const sessionSlug = norm.username.toUpperCase().replace(/[^A-Z0-9]/g, '-');
    const sessionCode = `STAFF-${sessionSlug}`;

    // Register in 24x7 workroom memory (0 SQL queries on subsequent activity)
    const previousWorker = activeStaffWorkroom.get(norm.username.toLowerCase());
    activeStaffWorkroom.set(norm.username.toLowerCase(), {
      ...previousWorker,
      username: norm.username,
      fullName: norm.fullName,
      role: norm.role,
      onWork: false,
      mode: 'IDLE',
      activeOrder: '',
      deviceName: String(deviceName).slice(0, 80),
      sessionCode,
      lastSeenAt: Date.now(),
      scannedUnits: 0,
      expectedUnits: 0,
      activeOrderItems: [],
      packedOrders: Number(previousWorker?.packedOrders) || 0,
      packedItems: Number(previousWorker?.packedItems) || 0,
    });

    touchScannerSessionActivity(sessionCode, {
      staffUsername: norm.username,
      staffName: norm.fullName,
      deviceName,
      connected: true,
    });

    res.json({
      success: true,
      token,
      sessionCode,
      staff: {
        id: norm.id,
        username: norm.username,
        fullName: norm.fullName,
        role: norm.role,
        assignedHub: norm.assignedHub,
        permissions: {
          can_scan: true,
          can_pack: true,
          can_bill: Boolean(norm.permissions?.can_use_pos_billing || norm.role === 'admin' || norm.fullAllAccess),
        },
      },
      message: `Welcome back, ${norm.fullName}! Tap Go to Work when you are ready to start.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/inventory-software/workroom/toggle-work
 * Toggles staff "Go On Work" status and updates current activity mode (PACKING / BILLING / IDLE).
 * Tracked 100% in 24x7 Node.js memory -> ZERO SQL QUERIES.
 */
router.post('/workroom/toggle-work', authenticateWorkroomMemory, (req, res) => {
  const operator = resolveRequestOperator(req);
  const { onWork = true, mode = 'IDLE', activeOrder = '', deviceName = 'Mobile Scanner' } = req.body || {};
  const userKey = operator.username.toLowerCase();

  const current = activeStaffWorkroom.get(userKey) || {
    username: operator.username,
    fullName: operator.name,
    role: req.invUser?.role || 'cashier',
    sessionCode: operator.sessionCode,
  };

  current.onWork = Boolean(onWork);
  current.mode = mode;
  current.activeOrder = String(activeOrder || '');
  current.deviceName = deviceName;
  current.activeOrderItems = Array.isArray(req.body?.activeOrderItems)
    ? req.body.activeOrderItems.slice(0, 40).map(item => ({
      orderItemId: String(item?.orderItemId || '').slice(0, 40),
      name: String(item?.name || 'Product').slice(0, 120),
      sku: String(item?.sku || '').slice(0, 80),
      expectedUnits: Math.max(0, Math.trunc(Number(item?.expectedUnits) || 0)),
      scannedUnits: Math.max(0, Math.trunc(Number(item?.scannedUnits) || 0)),
    }))
    : current.activeOrderItems || [];
  current.savedBulkOrders = Array.isArray(req.body?.savedBulkOrders)
    ? req.body.savedBulkOrders.slice(0, 100).map(order => ({
      orderId: String(order?.orderId || '').slice(0, 80),
      orderNumber: String(order?.orderNumber || order?.orderId || '').slice(0, 80),
    })).filter(order => order.orderId)
    : current.savedBulkOrders || [];
  current.lastSeenAt = Date.now();
  if (!current.onWork) {
    current.mode = 'OFF_WORK';
    current.activeOrder = '';
    current.activeOrderItems = [];
    current.scannedUnits = 0;
    current.expectedUnits = 0;
  }
  activeStaffWorkroom.set(userKey, current);

  touchScannerSessionActivity(operator.sessionCode, {
    staffUsername: operator.username,
    staffName: operator.name,
    deviceName,
    connected: Boolean(onWork),
  });

  res.json({
    success: true,
    worker: current,
    activeWorkers: Array.from(activeStaffWorkroom.values()).filter(w => w.onWork),
    message: onWork ? `${operator.name} is now ON WORK (${mode}).` : `${operator.name} is now OFF WORK.`,
  });
});

router.post('/workroom/heartbeat', authenticateWorkroomMemory, (req, res) => {
  const operator = resolveRequestOperator(req);
  const userKey = operator.username.toLowerCase();
  const current = activeStaffWorkroom.get(userKey);
  if (!current || !current.onWork) {
    return res.status(409).json({
      success: false,
      code: 'WORKROOM_NOT_ACTIVE',
      message: 'Tap Go to Work before sending scanner activity.',
    });
  }

  const requestedMode = String(req.body?.mode || current.mode || 'IDLE').toUpperCase();
  current.mode = ['IDLE', 'PACKING', 'BILLING'].includes(requestedMode) ? requestedMode : 'IDLE';
  current.activeOrder = String(req.body?.activeOrder || '').trim().slice(0, 80);
  current.deviceName = String(req.body?.deviceName || current.deviceName || 'Mobile Scanner').slice(0, 80);
  current.activeOrderItems = Array.isArray(req.body?.activeOrderItems)
    ? req.body.activeOrderItems.slice(0, 40).map(item => ({
      orderItemId: String(item?.orderItemId || '').slice(0, 40),
      name: String(item?.name || 'Product').slice(0, 120),
      sku: String(item?.sku || '').slice(0, 80),
      expectedUnits: Math.max(0, Math.trunc(Number(item?.expectedUnits) || 0)),
      scannedUnits: Math.max(0, Math.trunc(Number(item?.scannedUnits) || 0)),
    }))
    : current.activeOrderItems || [];
  current.scannedUnits = Math.max(0, Math.trunc(Number(req.body?.scannedUnits) || 0));
  current.expectedUnits = Math.max(0, Math.trunc(Number(req.body?.expectedUnits) || 0));
  current.savedBulkOrders = Array.isArray(req.body?.savedBulkOrders)
    ? req.body.savedBulkOrders.slice(0, 100).map(order => ({
      orderId: String(order?.orderId || '').slice(0, 80),
      orderNumber: String(order?.orderNumber || order?.orderId || '').slice(0, 80),
    })).filter(order => order.orderId)
    : current.savedBulkOrders || [];
  current.lastSeenAt = Date.now();
  activeStaffWorkroom.set(userKey, current);

  return res.json({
    success: true,
    worker: current,
    serverTime: new Date(current.lastSeenAt).toISOString(),
  });
});

/**
 * GET /api/inventory-software/workroom/presence
 * Returns real-time list of all staff members currently working in warehouse/shop.
 * Served directly from 24x7 Node.js RAM -> ZERO MySQL queries!
 */
router.get('/workroom/presence', authenticateWorkroomMemory, (_req, res) => {
  const now = Date.now();
  const activeWorkers = [];
  const workers = [];
  for (const [key, w] of activeStaffWorkroom.entries()) {
    // If no ping for 2 hours, auto-mark off work
    if (w.onWork && now - (w.lastSeenAt || 0) > 2 * 60 * 60 * 1000) {
      w.onWork = false;
    }
    const worker = {
      username: w.username || key,
      fullName: w.fullName || w.username || key,
      role: w.role || 'cashier',
      onWork: Boolean(w.onWork),
      mode: w.mode || 'IDLE',
      activeOrder: w.activeOrder || '',
      activeOrderItems: Array.isArray(w.activeOrderItems) ? w.activeOrderItems : [],
      recentUploads: Array.isArray(w.recentUploads) ? w.recentUploads : [],
      sessionCode: w.sessionCode || `STAFF-${String(w.username || key).toUpperCase()}`,
      scannedUnits: Number(w.scannedUnits) || 0,
      expectedUnits: Number(w.expectedUnits) || 0,
      packedOrders: Number(w.packedOrders) || 0,
      packedItems: Number(w.packedItems) || 0,
      savedBulkOrders: Array.isArray(w.savedBulkOrders) ? w.savedBulkOrders : [],
      lastSeenAt: new Date(w.lastSeenAt || now).toISOString(),
    };
    workers.push(worker);
    if (worker.onWork) activeWorkers.push(worker);
  }

  res.json({
    success: true,
    count: activeWorkers.length,
    activeWorkers,
    workers,
    serverTime: new Date().toISOString(),
  });
});

router.post('/fulfillment/pwa-batch', authenticateScannerOrStaff, async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    const packedOrders = req.body?.packedOrders;
    if (!Array.isArray(packedOrders) || packedOrders.length < 1 || packedOrders.length > 50) {
      return res.status(400).json({ success: false, message: 'packedOrders must contain between 1 and 50 fully verified orders.' });
    }

    const operator = resolveRequestOperator(req);
    await conn.beginTransaction();
    transactionStarted = true;
    const results = [];
    let uploadedUnits = 0;

    for (const packedOrder of packedOrders) {
      const rawParam = String(packedOrder?.orderId || packedOrder?.orderNumber || '')
        .trim()
        .replace(/^ORD:/i, '')
        .replace(/^#/i, '');
      if (!rawParam || !Array.isArray(packedOrder?.verifiedItems) || packedOrder.verifiedItems.length === 0) {
        throw Object.assign(new Error('Each packed order must include its order ID and scanned item details.'), { status: 400 });
      }

      const numericCandidate = Number(rawParam.replace(/\D/g, '')) || 0;
      let orderRow = null;
      if (numericCandidate > 0) {
        const [[found]] = await conn.query(
          'SELECT id, order_number, status FROM orders WHERE id = ? OR order_number = ? LIMIT 1 FOR UPDATE',
          [numericCandidate, rawParam]
        );
        orderRow = found;
      }
      if (!orderRow) {
        const [[found]] = await conn.query(
          'SELECT id, order_number, status FROM orders WHERE order_number = ? LIMIT 1 FOR UPDATE',
          [rawParam]
        );
        orderRow = found;
      }
      if (!orderRow) {
        throw Object.assign(new Error(`Order "${rawParam}" was not found. No packed orders were uploaded.`), { status: 404 });
      }

      const [orderItems] = await conn.query(
        `SELECT oi.id AS order_item_id, oi.quantity,
                COALESCE(m.sku, p.sku, CONCAT('SKU-', oi.product_id)) AS sku,
                m.barcode
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN inventory_product_meta m
           ON m.id = (SELECT MIN(m2.id) FROM inventory_product_meta m2 WHERE m2.product_id = oi.product_id)
         WHERE oi.order_id = ?
         ORDER BY oi.id ASC
         FOR UPDATE`,
        [orderRow.id]
      );
      if (!orderItems.length) {
        throw Object.assign(new Error(`Order #${orderRow.order_number || orderRow.id} has no packable items.`), { status: 409 });
      }

      const suppliedById = new Map();
      for (const detail of packedOrder.verifiedItems) {
        const itemId = Number(detail?.orderItemId);
        if (!Number.isSafeInteger(itemId) || itemId < 1 || suppliedById.has(itemId)) {
          throw Object.assign(new Error(`Order #${orderRow.order_number || orderRow.id} contains invalid or duplicate scan details.`), { status: 400 });
        }
        suppliedById.set(itemId, detail);
      }
      if (suppliedById.size !== orderItems.length) {
        throw Object.assign(new Error(`Scanned items do not match every item in Order #${orderRow.order_number || orderRow.id}.`), { status: 409 });
      }

      let orderUnits = 0;
      for (const expected of orderItems) {
        const quantity = Math.max(1, Math.trunc(Number(expected.quantity) || 1));
        const submitted = suppliedById.get(Number(expected.order_item_id));
        const scannedCodes = Array.isArray(submitted?.scannedCodes) ? submitted.scannedCodes : [];
        const acceptedCodes = new Set([expected.sku, expected.barcode].filter(Boolean).map(value => String(value).trim().toLowerCase()));
        if (
          !submitted ||
          Number(submitted.quantity) !== quantity ||
          Number(submitted.verifiedCount) !== quantity ||
          scannedCodes.length !== quantity ||
          scannedCodes.some(code => !acceptedCodes.has(String(code).trim().toLowerCase()))
        ) {
          throw Object.assign(new Error(`Scanned product codes or quantities do not match Order #${orderRow.order_number || orderRow.id}.`), { status: 409 });
        }
        orderUnits += quantity;
      }

      const currentStatus = String(orderRow.status || '').toLowerCase();
      if (['cancelled', 'delivered', 'shipped', 'out_for_delivery', 'returned', 'archived'].includes(currentStatus)) {
        throw Object.assign(new Error(`Order #${orderRow.order_number || orderRow.id} can no longer be packed (status: ${orderRow.status}).`), { status: 409 });
      }
      if (currentStatus === 'packed') {
        const [[progress]] = await conn.query(
          `SELECT COUNT(*) AS item_count, SUM(pp.verified_quantity) AS verified_units
           FROM order_items oi
           LEFT JOIN inventory_order_pack_progress pp ON pp.order_item_id = oi.id
           WHERE oi.order_id = ?`,
          [orderRow.id]
        );
        if (Number(progress?.item_count) === orderItems.length && Number(progress?.verified_units) >= orderUnits) {
          results.push({ orderId: orderRow.id, orderNumber: orderRow.order_number || String(orderRow.id), status: 'packed', alreadyPacked: true, verifiedUnits: orderUnits });
          uploadedUnits += orderUnits;
          continue;
        }
        throw Object.assign(new Error(`Order #${orderRow.order_number || orderRow.id} is already marked packed, but its saved scan progress is incomplete.`), { status: 409 });
      }
      if (currentStatus !== 'confirmed') {
        throw Object.assign(new Error(`Order #${orderRow.order_number || orderRow.id} must be confirmed before it can be packed (current status: ${orderRow.status}).`), { status: 409 });
      }

      const operatorLock = acquireOrVerifyOrderLock({
        orderId: orderRow.order_number || orderRow.id,
        operatorUsername: operator.username,
        operatorName: operator.name,
        sessionCode: operator.sessionCode,
        lockType: 'PACKING',
      });
      if (!operatorLock.allowed) {
        throw Object.assign(new Error(operatorLock.message), { status: operatorLock.status || 409 });
      }

      for (const expected of orderItems) {
        const submitted = suppliedById.get(Number(expected.order_item_id));
        await conn.query(
          `INSERT INTO inventory_order_pack_progress (order_item_id, order_id, verified_quantity)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE verified_quantity = VALUES(verified_quantity)`,
          [expected.order_item_id, orderRow.id, Number(submitted.verifiedCount)]
        );
      }
      await conn.query('UPDATE orders SET status = ? WHERE id = ?', ['packed', orderRow.id]);
      results.push({ orderId: orderRow.id, orderNumber: orderRow.order_number || String(orderRow.id), status: 'packed', verifiedUnits: orderUnits });
      uploadedUnits += orderUnits;
    }

    await appendInventoryAuditLog(conn, {
      actorUsername: operator.username,
      actorRole: req.invUser?.role || 'cashier',
      actionCode: 'PWA_ORDERS_PACKED',
      summary: `${results.length} PWA-packed order(s) (${uploadedUnits} units) uploaded by ${operator.name}.`,
      details: { orderIds: results.map(order => order.orderId), uploadedUnits },
    });
    await conn.commit();
    transactionStarted = false;

    for (const result of results.filter(order => !order.alreadyPacked)) {
      for (const orderId of new Set([result.orderNumber, result.orderId])) {
        markOrderLockCompleted(orderId, operator.username, operator.name, operator.sessionCode);
      }
    }

    const worker = activeStaffWorkroom.get(operator.username.toLowerCase());
    if (worker) {
      worker.packedOrders = (Number(worker.packedOrders) || 0) + results.filter(order => !order.alreadyPacked).length;
      worker.packedItems = (Number(worker.packedItems) || 0) + results
        .filter(order => !order.alreadyPacked)
        .reduce((sum, order) => sum + (Number(order.verifiedUnits) || 0), 0);
      worker.recentUploads = [
        ...results.filter(order => !order.alreadyPacked).map(order => ({
          orderId: String(order.orderId),
          orderNumber: String(order.orderNumber),
          verifiedUnits: Number(order.verifiedUnits) || 0,
          uploadedAt: new Date().toISOString(),
        })),
        ...(Array.isArray(worker.recentUploads) ? worker.recentUploads : []),
      ].slice(0, 20);
      worker.activeOrder = '';
      worker.activeOrderItems = [];
      worker.mode = 'IDLE';
      worker.scannedUnits = 0;
      worker.expectedUnits = 0;
      worker.lastSeenAt = Date.now();
    }
    return res.json({
      success: true,
      count: results.length,
      uploadedUnits,
      orders: results,
      message: `Uploaded ${results.length} packed order(s) and ${uploadedUnits} verified unit(s) to Inventory Software.`,
    });
  } catch (err) {
    if (transactionStarted) await conn.rollback();
    return res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

/**
 * POST /api/inventory-software/fulfillment/batch-push
 * Atomically pushes a batch of stacked packed orders from mobile phone into MySQL.
 * Wakes MySQL once for the whole stack of 5+ orders, then MySQL can go right back to sleep!
 */
router.post('/fulfillment/batch-push', authenticateScannerOrStaff, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { stackedOrders = [] } = req.body || {};
    if (!Array.isArray(stackedOrders) || stackedOrders.length === 0) {
      return res.status(400).json({ success: false, message: 'stackedOrders must be an array of at least 1 packed order.' });
    }

    const operator = resolveRequestOperator(req);
    await conn.beginTransaction();

    const pushedOrderResults = [];
    for (const item of stackedOrders) {
      const rawParam = String(item.orderId || item.orderNumber || '').trim().replace(/^ORD:/i, '').replace(/^#/i, '').trim();
      const numCandidate = Number(rawParam.replace(/\D/g, '')) || 0;
      let orderRow = null;
      if (numCandidate > 0) {
        const [[ord]] = await conn.query('SELECT id, order_number, status FROM orders WHERE id = ? OR order_number = ? LIMIT 1 FOR UPDATE', [numCandidate, rawParam]);
        orderRow = ord;
      }
      if (!orderRow) {
        const [[ordText]] = await conn.query('SELECT id, order_number, status FROM orders WHERE order_number = ? LIMIT 1 FOR UPDATE', [rawParam]);
        orderRow = ordText;
      }

      if (orderRow) {
        await conn.query('UPDATE orders SET status = "packed" WHERE id = ?', [orderRow.id]);
        if (Array.isArray(item.verifiedItems)) {
          for (const vi of item.verifiedItems) {
            if (vi.orderItemId) {
              await conn.query(
                `INSERT INTO inventory_order_pack_progress (order_item_id, order_id, verified_quantity)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE verified_quantity = VALUES(verified_quantity)`,
                [vi.orderItemId, orderRow.id, Number(vi.verifiedCount || vi.quantity || 1)]
              );
            }
          }
        }
        markOrderLockCompleted(orderRow.order_number || orderRow.id, operator.username, operator.name, operator.sessionCode);
        pushedOrderResults.push({
          orderId: orderRow.id,
          orderNumber: orderRow.order_number || String(orderRow.id),
          status: 'packed',
        });
      }
    }

    await appendInventoryAuditLog(conn, {
      actorUsername: operator.username,
      actorRole: req.invUser?.role || 'packer',
      actionCode: 'BATCH_ORDERS_PACKED_PUSH',
      summary: `Batch packed & pushed ${pushedOrderResults.length} order(s) [${pushedOrderResults.map(o => `#${o.orderNumber}`).join(', ')}] by ${operator.name}.`,
    });

    await conn.commit();
    res.json({
      success: true,
      count: pushedOrderResults.length,
      orders: pushedOrderResults,
      message: `Successfully pushed ${pushedOrderResults.length} stacked packed order(s) to inventory software!`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// STANDALONE PRODUCT QR GENERATOR & A4 AUTO-SIZING API
// ============================================================================
router.get('/products/qr-codes', authenticateScannerOrStaff, async (req, res) => {
  try {
    const requestedCount = Number(req.query.quantity || req.query.count || 24);
    const showLabel = req.query.showLabel !== 'false';
    const layout = computeOptimalA4QrLayout(requestedCount, showLabel);
    const [rows] = await pool.query(`
      SELECT m.id AS meta_id, m.product_id, COALESCE(p.name, m.custom_name) AS name,
             m.sku, m.barcode, m.batch_no, m.mrp, COALESCE(p.discount_price, p.price, m.selling_price) AS price,
             m.gst_hsn_code, m.gst_rate, COALESCE(p.quantity, m.physical_stock, 0) AS available_stock,
             m.bin_code, m.uom
      FROM inventory_product_meta m
      LEFT JOIN products p ON m.product_id = p.id
      ORDER BY COALESCE(p.id, m.id) ASC
    `).catch(() => [[]]);

    const products = (rows || []).map(r => ({
      metaId: r.meta_id,
      productId: r.product_id,
      name: r.name,
      sku: r.sku,
      barcode: r.barcode,
      batchNo: r.batch_no || 'BV-BATCH-2026',
      mrp: Number(r.mrp) || Number(r.price) || 0,
      price: Number(r.price) || 0,
      gstHsnCode: r.gst_hsn_code || '30049011',
      gstRate: Number(r.gst_rate) || 5,
      availableStock: Number(r.available_stock) || 0,
      binCode: r.bin_code || 'ASN-SHOP-R1-B01',
      standaloneQrPayload: buildStandaloneProductQr(r.sku),
      batchQrPayload: buildStandaloneProductQr(r.sku, r.batch_no),
      verifyUrl: `https://bhumivera.com/verify?code=${encodeURIComponent(buildStandaloneProductQr(r.sku))}`,
    }));

    res.json({
      success: true,
      count: products.length,
      layout,
      products,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/products/qr-codes/generate', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { items = [], totalCount = 24, showLabel = true } = req.body || {};
    const layout = computeOptimalA4QrLayout(totalCount, showLabel);
    const generated = (Array.isArray(items) ? items : []).map(it => {
      const sku = String(it.sku || 'BV-PRODUCT').trim().toUpperCase();
      const qty = Math.max(1, Math.min(500, Number(it.quantity || 1)));
      return {
        sku,
        name: it.name || sku,
        quantity: qty,
        standaloneQrPayload: buildStandaloneProductQr(sku),
        batchQrPayload: it.batchNo ? buildStandaloneProductQr(sku, it.batchNo) : buildStandaloneProductQr(sku),
      };
    });
    res.json({
      success: true,
      layout,
      generated,
      message: `Generated standalone A4-ready QR layout (${layout.cols}×${layout.rows} grid, ${layout.qrSizeMm}mm mobile-optimized QR size).`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// MULTI-STAFF ORDER / BILLING LOCK API (PREVENTS DUPLICATE BILLING OF SAME ORDER ID)
// ============================================================================
router.get('/orders/locks', authenticateScannerOrStaff, async (_req, res) => {
  const now = Date.now();
  const locks = [];
  for (const [key, lock] of activeOrderLocksMemory.entries()) {
    if (lock.status === 'LOCKED' && lock.expiresAt && now >= lock.expiresAt) {
      activeOrderLocksMemory.delete(key);
      continue;
    }
    locks.push({
      orderKey: key,
      orderNumber: lock.orderNumber,
      lockedBy: lock.lockedByName,
      lockedByUsername: lock.lockedByUsername,
      sessionCode: lock.sessionCode,
      lockType: lock.lockType,
      status: lock.status,
      lockedAt: lock.lockedAt,
      expiresAt: lock.expiresAt ? new Date(lock.expiresAt).toISOString() : null,
      completedAt: lock.completedAt,
    });
  }
  res.json({ success: true, locks });
});

router.post('/orders/claim', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { orderId, lockType = 'BILLING' } = req.body || {};
    if (!orderId || !String(orderId).trim()) {
      return res.status(400).json({ success: false, message: 'orderId is required to claim an order for billing/packing.' });
    }
    const operator = resolveRequestOperator(req);
    touchScannerSessionActivity(operator.sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
    });
    const result = acquireOrVerifyOrderLock({
      orderId,
      operatorUsername: operator.username,
      operatorName: operator.name,
      sessionCode: operator.sessionCode,
      lockType,
    });
    if (!result.allowed) {
      return res.status(result.status || 409).json(result);
    }
    res.json({
      success: true,
      lock: result.lock,
      message: `Order #${result.lock.orderKey} locked exclusively for ${result.lock.lockedByName}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/orders/release', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    const key = normalizeOrderLockKey(orderId);
    if (!key) return res.status(400).json({ success: false, message: 'orderId is required.' });
    const operator = resolveRequestOperator(req);
    const existing = activeOrderLocksMemory.get(key);
    if (
      existing &&
      existing.status === 'LOCKED' &&
      existing.sessionCode !== operator.sessionCode &&
      existing.lockedByUsername.toLowerCase() !== operator.username.toLowerCase() &&
      req.invUser?.role !== 'admin'
    ) {
      return res.status(403).json({
        success: false,
        code: 'ORDER_LOCKED_BY_OTHER_STAFF',
        message: `Only ${existing.lockedByName} (or an Admin) can release the lock on Order #${key}.`,
      });
    }
    activeOrderLocksMemory.delete(key);
    res.json({ success: true, orderId: key, message: `Released lock on Order #${key}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// POS DRAFTS, PAUSE BILLING & RESUME BILLING API (2-WAY APP <-> WEB SYNC)
// ============================================================================
router.get('/pos/draft', authenticateScannerOrStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.query.sessionCode || req.invUser?.scannerSessionCode || 'DEFAULT-POS-TERMINAL');
    const memSession = scannerSessionsMemory.get(sessionCode);
    if (memSession?.draftCache) {
      return res.json({
        success: true,
        draft: memSession.draftCache,
        updatedAt: new Date(memSession.lastActiveAt || Date.now()).toISOString(),
        source: 'memory',
      });
    }
    const [[row]] = await pool.query('SELECT draft_json, updated_at FROM inventory_pos_drafts WHERE session_code = ?', [
      sessionCode,
    ]);
    const parsedDraft = row ? parseJsonSafe(row.draft_json, null) : null;
    if (memSession && parsedDraft) {
      memSession.draftCache = parsedDraft;
    }
    res.json({
      success: true,
      draft: parsedDraft,
      updatedAt: row?.updated_at || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/pos/draft', authenticateScannerOrStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || req.invUser?.scannerSessionCode);
    const draft = req.body?.draft;
    if (!sessionCode || !draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return res.status(400).json({ success: false, message: 'A valid terminal session and draft are required.' });
    }
    if (!Array.isArray(draft.items) || draft.items.length > 100) {
      return res.status(400).json({ success: false, message: 'Draft must contain no more than 100 bill items.' });
    }
    const operator = resolveRequestOperator(req);
    if (draft.orderId && String(draft.orderId).trim()) {
      const lockRes = acquireOrVerifyOrderLock({
        orderId: draft.orderId,
        operatorUsername: operator.username,
        operatorName: operator.name,
        sessionCode,
        lockType: 'BILLING',
      });
      if (!lockRes.allowed) {
        return res.status(lockRes.status || 409).json(lockRes);
      }
    }
    const draftJson = JSON.stringify(draft);
    if (Buffer.byteLength(draftJson, 'utf8') > 256 * 1024) {
      return res.status(413).json({ success: false, message: 'POS draft is too large to save.' });
    }
    const memSession = touchScannerSessionActivity(sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
      bumpVersion: true,
    });
    memSession.draftCache = draft;

    await pool.query(
      `INSERT INTO inventory_pos_drafts (session_code, draft_json, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE draft_json = VALUES(draft_json), updated_by = VALUES(updated_by)`,
      [sessionCode, draftJson, operator.username]
    );
    res.json({ success: true, message: 'POS draft saved.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/pos/draft', authenticateScannerOrStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.query.sessionCode || req.invUser?.scannerSessionCode);
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    const memSession = scannerSessionsMemory.get(sessionCode);
    if (memSession) memSession.draftCache = null;
    await pool.query('DELETE FROM inventory_pos_drafts WHERE session_code = ?', [sessionCode]);
    res.json({ success: true, message: 'POS draft cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Multi-Draft & Pause/Resume Billing Endpoints (Synced across Mobile Scanner App & Web POS)
router.get('/pos/drafts', authenticateScannerOrStaff, async (req, res) => {
  try {
    const sessionCode = req.query.sessionCode ? normalizePosSessionCode(req.query.sessionCode) : null;
    const rows = await pool
      .query(
        'SELECT * FROM inventory_pos_saved_drafts WHERE status <> "completed" ORDER BY saved_at DESC LIMIT 50'
      )
      .then(([r]) => r)
      .catch(() => []);

    for (const r of rows || []) {
      if (!savedPosDraftsMemory.has(r.draft_id)) {
        savedPosDraftsMemory.set(r.draft_id, {
          id: r.draft_id,
          sessionCode: r.session_code,
          orderId: r.order_id || '',
          title: r.title,
          status: r.status || 'draft',
          customerName: r.customer_name || 'Walk-in Retail Shopper',
          customerPhone: r.customer_phone || '',
          customerGstin: r.customer_gstin || '',
          paymentMode: r.payment_mode || 'UPI',
          items: parseJsonSafe(r.items_json, []),
          extraCharges: parseJsonSafe(r.extra_charges_json, []),
          discount: Number(r.discount) || 0,
          taxRate: Number(r.tax_rate) || 0,
          totalAmount: Number(r.total_amount) || 0,
          createdBy: r.created_by || 'admin',
          createdByName: r.created_by_name || 'Staff',
          lockedBy: r.locked_by || null,
          lockedByName: r.locked_by_name || null,
          lockedSessionCode: r.locked_session_code || null,
          savedAt: Number(r.saved_at) || Date.now(),
        });
      }
    }

    const list = Array.from(savedPosDraftsMemory.values())
      .filter(d => d.status !== 'completed' && (!sessionCode || req.query.all === 'true' || d.sessionCode === sessionCode || d.status === 'paused' || d.status === 'draft'))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    res.json({
      success: true,
      count: list.length,
      drafts: list,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/pos/drafts', authenticateScannerOrStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const operator = resolveRequestOperator(req);
    const sessionCode = normalizePosSessionCode(body.sessionCode || operator.sessionCode || 'DEFAULT-POS-TERMINAL');
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0 || items.length > 100) {
      return res.status(400).json({ success: false, message: 'A draft or paused bill must contain between 1 and 100 items.' });
    }
    const orderId = body.orderId ? String(body.orderId).trim() : '';
    if (orderId) {
      const lockCheck = acquireOrVerifyOrderLock({
        orderId,
        operatorUsername: operator.username,
        operatorName: operator.name,
        sessionCode,
        lockType: 'BILLING',
      });
      if (!lockCheck.allowed) {
        return res.status(lockCheck.status || 409).json(lockCheck);
      }
    }

    const draftId = String(body.id || body.draftId || `DRAFT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`).trim();
    const existing = savedPosDraftsMemory.get(draftId);
    if (
      existing &&
      existing.lockedByName &&
      existing.lockedSessionCode &&
      existing.lockedSessionCode !== sessionCode &&
      existing.lockedByName.toLowerCase() !== operator.name.toLowerCase()
    ) {
      return res.status(409).json({
        success: false,
        code: 'DRAFT_LOCKED_BY_OTHER_STAFF',
        lockedBy: existing.lockedByName,
        message: `⛔ This bill/draft is currently being edited by ${existing.lockedByName}.`,
      });
    }

    const status = ['draft', 'paused', 'active'].includes(body.status) ? body.status : 'paused';
    const savedAt = Number(body.savedAt) || Date.now();
    const customerName = String(body.customerName || body.customer?.name || 'Walk-in Retail Shopper').trim();
    const customerPhone = String(body.customerPhone || body.customer?.phone || '').trim();
    const customerGstin = String(body.customerGstin || body.customer?.gstin || '').trim();
    const paymentMode = String(body.paymentMode || 'UPI').trim();
    const discount = Math.max(0, Number(body.discount) || 0);
    const taxRate = Math.max(0, Number(body.taxRate) || 0);
    const extraCharges = Array.isArray(body.extraCharges) ? body.extraCharges : [];
    const subTotal = items.reduce((sum, it) => sum + (Number(it.price ?? it.p) || 0) * (Number(it.quantity ?? it.q) || 1), 0);
    const totalAmount = Math.max(0, subTotal - discount);
    const title = String(
      body.title ||
      (orderId ? `Order #${orderId} · ${customerName}` : `${customerName} · ${new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`)
    ).trim();

    const record = {
      id: draftId,
      sessionCode,
      orderId,
      title,
      status,
      customerName,
      customerPhone,
      customerGstin,
      paymentMode,
      items,
      extraCharges,
      discount,
      taxRate,
      totalAmount,
      createdBy: existing?.createdBy || operator.username,
      createdByName: existing?.createdByName || operator.name,
      lockedBy: status === 'active' ? operator.username : null,
      lockedByName: status === 'active' ? operator.name : null,
      lockedSessionCode: status === 'active' ? sessionCode : null,
      savedAt,
    };

    savedPosDraftsMemory.set(draftId, record);
    touchScannerSessionActivity(sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
      bumpVersion: true,
    });

    await pool
      .query(
        `INSERT INTO inventory_pos_saved_drafts
          (draft_id, session_code, order_id, title, status, customer_name, customer_phone, customer_gstin,
           payment_mode, items_json, extra_charges_json, discount, tax_rate, total_amount,
           created_by, created_by_name, locked_by, locked_by_name, locked_session_code, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           session_code = VALUES(session_code),
           order_id = VALUES(order_id),
           title = VALUES(title),
           status = VALUES(status),
           customer_name = VALUES(customer_name),
           customer_phone = VALUES(customer_phone),
           customer_gstin = VALUES(customer_gstin),
           payment_mode = VALUES(payment_mode),
           items_json = VALUES(items_json),
           extra_charges_json = VALUES(extra_charges_json),
           discount = VALUES(discount),
           tax_rate = VALUES(tax_rate),
           total_amount = VALUES(total_amount),
           locked_by = VALUES(locked_by),
           locked_by_name = VALUES(locked_by_name),
           locked_session_code = VALUES(locked_session_code),
           saved_at = VALUES(saved_at)`,
        [
          record.id,
          record.sessionCode,
          record.orderId || null,
          record.title,
          record.status,
          record.customerName,
          record.customerPhone,
          record.customerGstin,
          record.paymentMode,
          JSON.stringify(record.items),
          JSON.stringify(record.extraCharges),
          record.discount,
          record.taxRate,
          record.totalAmount,
          record.createdBy,
          record.createdByName,
          record.lockedBy,
          record.lockedByName,
          record.lockedSessionCode,
          record.savedAt,
        ]
      )
      .catch(() => {});

    res.status(201).json({
      success: true,
      draft: record,
      drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
      message: status === 'paused' ? `Bill "${record.title}" paused & synced via API.` : `Draft "${record.title}" saved & synced via API.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/pos/drafts/:draftId/resume', authenticateScannerOrStaff, async (req, res) => {
  try {
    const draftId = String(req.params.draftId || '').trim();
    const operator = resolveRequestOperator(req);
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || operator.sessionCode || 'DEFAULT-POS-TERMINAL');
    const draft = savedPosDraftsMemory.get(draftId);
    if (!draft) {
      return res.status(404).json({ success: false, message: `Draft "${draftId}" was not found.` });
    }
    if (
      draft.status === 'active' &&
      draft.lockedSessionCode &&
      draft.lockedSessionCode !== sessionCode &&
      draft.lockedByName &&
      draft.lockedByName.toLowerCase() !== operator.name.toLowerCase()
    ) {
      return res.status(409).json({
        success: false,
        code: 'DRAFT_LOCKED_BY_OTHER_STAFF',
        lockedBy: draft.lockedByName,
        message: `⛔ "${draft.title}" is already resumed and being billed by ${draft.lockedByName}!`,
      });
    }
    if (draft.orderId) {
      const lockCheck = acquireOrVerifyOrderLock({
        orderId: draft.orderId,
        operatorUsername: operator.username,
        operatorName: operator.name,
        sessionCode,
        lockType: 'BILLING',
      });
      if (!lockCheck.allowed) {
        return res.status(lockCheck.status || 409).json(lockCheck);
      }
    }

    draft.status = 'active';
    draft.lockedBy = operator.username;
    draft.lockedByName = operator.name;
    draft.lockedSessionCode = sessionCode;
    draft.sessionCode = sessionCode;
    savedPosDraftsMemory.set(draftId, draft);

    const memSession = touchScannerSessionActivity(sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
      bumpVersion: true,
    });
    memSession.draftCache = {
      id: draft.id,
      orderId: draft.orderId,
      items: draft.items,
      extraCharges: draft.extraCharges,
      discount: draft.discount,
      taxRate: draft.taxRate,
      paymentMode: draft.paymentMode,
      customer: {
        name: draft.customerName,
        phone: draft.customerPhone,
        gstin: draft.customerGstin,
      },
    };

    res.json({
      success: true,
      draft,
      message: `Resumed bill "${draft.title}" for ${operator.name}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/pos/drafts/:draftId', authenticateScannerOrStaff, async (req, res) => {
  try {
    const draftId = String(req.params.draftId || '').trim();
    const existing = savedPosDraftsMemory.get(draftId);
    if (existing?.orderId) {
      const key = normalizeOrderLockKey(existing.orderId);
      const lock = activeOrderLocksMemory.get(key);
      if (lock && lock.status === 'LOCKED') {
        activeOrderLocksMemory.delete(key);
      }
    }
    savedPosDraftsMemory.delete(draftId);
    await pool.query('DELETE FROM inventory_pos_saved_drafts WHERE draft_id = ?', [draftId]).catch(() => {});
    res.json({
      success: true,
      drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
      message: 'Saved draft removed.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. OFFLINE SHOP POS BILLING ENGINE (ATOMIC WEBSITE STOCK DEDUCTION!)
router.post('/pos/checkout', posCheckoutLimiter, authenticateScannerOrStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    const providedIdempotencyKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    let idempotencyKey = providedIdempotencyKey;
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || req.invUser.scannerSessionCode);
    if (!providedIdempotencyKey && !req.invUser.scannerSessionCode) {
      return res.status(400).json({ success: false, message: 'A valid Idempotency-Key is required for checkout.' });
    }
    if (providedIdempotencyKey && !/^[A-Za-z0-9_-]{8,80}$/.test(providedIdempotencyKey)) {
      return res.status(400).json({ success: false, message: 'A valid Idempotency-Key is required for checkout.' });
    }
    if (!sessionCode) {
      return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    }

    const {
      customer,
      items = [],
      extraCharges = [],
      discount = 0,
      taxRate,
      paidAmount,
      paymentMode = 'Cash',
      upiReference = '',
      notes = '',
      scannerQueueIds = [],
      orderId = '',
      draftId = '',
    } = req.body || {};
    const checkoutOperator = resolveRequestOperator(req);
    if (orderId && String(orderId).trim()) {
      const lockCheck = acquireOrVerifyOrderLock({
        orderId,
        operatorUsername: checkoutOperator.username,
        operatorName: checkoutOperator.name,
        sessionCode,
        lockType: 'BILLING',
      });
      if (!lockCheck.allowed) {
        return res.status(lockCheck.status || 409).json(lockCheck);
      }
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({ success: false, message: 'POS bill must contain between 1 and 100 items.' });
    }
    if (
      !Array.isArray(extraCharges) ||
      extraCharges.length > 20 ||
      extraCharges.some(charge => !charge || typeof charge !== 'object' || Array.isArray(charge)) ||
      !Array.isArray(scannerQueueIds) ||
      scannerQueueIds.length > 100 ||
      items.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    ) {
      return res.status(400).json({ success: false, message: 'Invalid POS bill details.' });
    }

    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ sessionCode, customer, items, extraCharges, discount, taxRate, paidAmount, paymentMode, upiReference, notes }))
      .digest('hex');
    if (!idempotencyKey) {
      // Scanner builds that send no key: treat an identical bill retried within 30s as the same checkout.
      const [[recent]] = await pool.query(
        `SELECT idempotency_key FROM inventory_pos_checkout_requests
         WHERE request_hash = ? AND idempotency_key LIKE 'legacy-%' AND created_at > (NOW() - INTERVAL 30 SECOND)
         ORDER BY created_at DESC LIMIT 1`,
        [requestHash]
      );
      idempotencyKey = recent?.idempotency_key || `legacy-${crypto.randomUUID()}`;
    }
    await conn.beginTransaction();
    transactionStarted = true;
    try {
      await conn.query(
         'INSERT INTO inventory_pos_checkout_requests (idempotency_key, request_hash) VALUES (?, ?)',
         [idempotencyKey, requestHash]
      );
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.rollback();
      transactionStarted = false;
      const [[previousRequest]] = await pool.query(
         'SELECT request_hash, response_json FROM inventory_pos_checkout_requests WHERE idempotency_key = ?',
         [idempotencyKey]
      );
      if (!previousRequest || previousRequest.request_hash !== requestHash) {
         return res.status(409).json({
           success: false,
           code: 'IDEMPOTENCY_KEY_REUSED',
           message: 'This checkout key was already used for a different bill. Restore the original bill or start a new one.',
         });
      }
      if (!previousRequest.response_json) {
         return res.status(409).json({ success: false, message: 'The previous checkout is still being finalized. Retry shortly.' });
      }
      return res.status(200).json(parseJsonSafe(previousRequest.response_json, {}));
    }

    const [[config]] = await conn.query('SELECT default_tax_rate FROM inventory_store_config WHERE id = 1 FOR UPDATE');
    const safeTaxRate = Math.max(0, Number(config?.default_tax_rate ?? 18) || 0);
    // Scanner devices cannot refresh the store tax rate, so the server rate always wins for them.
    if (
      !req.invUser.scannerSessionCode &&
      taxRate !== undefined &&
      (!Number.isFinite(Number(taxRate)) || Math.abs(Number(taxRate) - safeTaxRate) > 0.001)
    ) {
      await conn.rollback();
      transactionStarted = false;
      return res.status(409).json({
         success: false,
         code: 'TAX_RATE_MISMATCH',
         message: 'The store tax rate changed. Refresh the POS before completing this bill.',
      });
    }

    const normalizedItems = [];
    const stockDeductions = [];

    // High-performance batch prefetch under FOR UPDATE lock (reduces N DB round trips to 1)
    const metaIds = items.map(i => Number(i.id)).filter(Boolean);
    const skus = items.map(i => String(i.sku || '').trim()).filter(Boolean);
    let catalogItems = [];
    if (metaIds.length > 0 || skus.length > 0) {
      const conditions = [];
      const queryParams = [];
      if (metaIds.length > 0) {
        conditions.push(`m.id IN (${metaIds.map(() => '?').join(',')})`);
        queryParams.push(...metaIds);
      }
      if (skus.length > 0) {
        conditions.push(`m.sku IN (${skus.map(() => '?').join(',')})`);
        queryParams.push(...skus);
      }
      const [rows] = await conn.query(
        `SELECT m.id AS meta_id, m.product_id, m.sku, m.custom_name, m.selling_price, m.gst_hsn_code, m.gst_rate, m.uom,
                p.name AS product_name, p.price, p.discount_price
         FROM inventory_product_meta m
         LEFT JOIN products p ON p.id = m.product_id
         WHERE ${conditions.join(' OR ')}
         FOR UPDATE`,
        queryParams
      );
      catalogItems = rows;
    }

    const catalogByMetaId = new Map();
    const catalogBySku = new Map();
    for (const c of catalogItems) {
      if (c.meta_id) catalogByMetaId.set(Number(c.meta_id), c);
      if (c.sku) catalogBySku.set(String(c.sku).trim(), c);
    }

    for (const cartItem of items) {
      const requestedQty = Number(cartItem.q ?? cartItem.quantity);
      if (!Number.isSafeInteger(requestedQty) || requestedQty < 1) {
         await conn.rollback();
         transactionStarted = false;
         return res.status(400).json({ success: false, message: 'Each bill item must have a positive whole-number quantity.' });
      }
      const metaId = Number(cartItem.id) || null;
      const sku = String(cartItem.sku || '').trim();
      const catalogItem = (metaId && catalogByMetaId.get(metaId)) || (sku && catalogBySku.get(sku));

      if (!catalogItem) {
         await conn.rollback();
         transactionStarted = false;
         return res.status(404).json({ success: false, message: `Product "${sku || metaId || ''}" is no longer in the inventory catalog.` });
      }
      if (metaId && Number(catalogItem.meta_id) !== metaId && sku !== catalogItem.sku) {
         await conn.rollback();
         transactionStarted = false;
         return res.status(409).json({ success: false, message: 'A bill item no longer matches the current inventory catalog.' });
      }
      const catalogPrice = Number(catalogItem.discount_price) > 0
         ? Number(catalogItem.discount_price)
         : Number(catalogItem.price) > 0
         ? Number(catalogItem.price)
         : Number(catalogItem.selling_price) || 0;
      const requestedPrice = cartItem.p === undefined && cartItem.price === undefined
         ? catalogPrice
         : Number(cartItem.p ?? cartItem.price);
      if (!Number.isFinite(requestedPrice) || requestedPrice < 0) {
         await conn.rollback();
         transactionStarted = false;
         return res.status(400).json({ success: false, message: `Invalid unit price for "${catalogItem.product_name || catalogItem.custom_name}".` });
      }
      if (req.invUser.permissions?.can_give_discounts && requestedPrice > catalogPrice) {
         await conn.rollback();
         transactionStarted = false;
         return res.status(400).json({ success: false, message: `Unit price cannot exceed the current catalog price for "${catalogItem.product_name || catalogItem.custom_name}".` });
      }
      const finalUnitPrice = req.invUser.permissions?.can_give_discounts ? requestedPrice : catalogPrice;
      const normalizedItem = {
         id: catalogItem.meta_id,
         productId: catalogItem.product_id,
         sku: catalogItem.sku,
         name: catalogItem.product_name || catalogItem.custom_name || 'Product',
         q: requestedQty,
         p: finalUnitPrice,
         uom: catalogItem.uom || 'Pcs',
         gstHsnCode: catalogItem.gst_hsn_code || '30049011',
         gstRate: Number(catalogItem.gst_rate) || safeTaxRate,
      };
      const deduction = await atomicAdjustProductStock(
         {
           metaId: normalizedItem.id,
           productId: normalizedItem.productId,
           sku: normalizedItem.sku,
           operation: 'subtract',
           quantity: requestedQty,
           movementType: 'OFFLINE_POS_SALE',
           reason: `Offline Shop POS Sale to ${customer?.name || 'Walk-in Shopper'}`,
           operatorUsername: req.invUser.username,
         },
         conn
      );
      stockDeductions.push(deduction);
      normalizedItems.push(normalizedItem);
    }

    const subTotal = normalizedItems.reduce((sum, item) => sum + item.p * item.q, 0);
    const safeExtraCharges = extraCharges.map(charge => {
      const amount = Number(charge.a ?? charge.amount);
      if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('Extra charges must be valid non-negative amounts.'), { status: 400 });
      return { n: String(charge.n || charge.name || 'Extra charge').slice(0, 120), a: amount };
    });
    const extraTotal = safeExtraCharges.reduce((sum, charge) => sum + charge.a, 0);
    const discAmt = Number(discount);
    if (!Number.isFinite(discAmt) || discAmt < 0 || discAmt > subTotal + extraTotal) {
      throw Object.assign(new Error('Discount must be between zero and the bill subtotal.'), { status: 400 });
    }
    if (discAmt > 0 && !req.invUser.permissions?.can_give_discounts) {
      throw Object.assign(new Error('Your account cannot apply POS discounts.'), { status: 403 });
    }
    const taxableAmount = Math.max(0, subTotal + extraTotal - discAmt);
    const taxAmount = Math.round((taxableAmount * safeTaxRate) / 100);
    const billTotal = taxableAmount + taxAmount;

    const custName = String(customer?.name || 'Walk-in Retail Shopper').trim();
    const custPhone = String(customer?.phone || '-').trim();
    const custAddress = String(customer?.address || '').trim();
    const custGstin = String(customer?.gstin || '').trim();
    if (custAddress.length > 500) {
      throw Object.assign(new Error('Customer address must be 500 characters or fewer.'), { status: 400 });
    }
    const paid = paidAmount === '' || paidAmount === undefined ? billTotal : Number(paidAmount);
    if (!Number.isFinite(paid) || paid < 0) {
      throw Object.assign(new Error('Paid amount must be a valid non-negative amount.'), { status: 400 });
    }

    let customerId = null;
    let previousBalance = 0;
    if (custPhone && custPhone !== '-') {
      const [[existingCustomer]] = await conn.query(
         'SELECT id, wallet_balance, location FROM inventory_customers WHERE phone = ? ORDER BY id ASC LIMIT 1 FOR UPDATE',
         [custPhone]
      );
      if (existingCustomer) {
         customerId = existingCustomer.id;
         previousBalance = Number(existingCustomer.wallet_balance) || 0;
         if (custAddress) {
           await conn.query(
             'UPDATE inventory_customers SET name = ?, gstin = ?, location = ? WHERE id = ?',
             [custName, custGstin || null, custAddress, customerId]
           );
         }
      } else {
         const [customerInsert] = await conn.query(
           `INSERT INTO inventory_customers (name, phone, gstin, location, customer_type)
            VALUES (?, ?, ?, ?, 'Walk-in')`,
           [custName, custPhone, custGstin || null, custAddress || null]
         );
         customerId = customerInsert.insertId;
      }
    }
    const newBalance = previousBalance - billTotal + paid;

    const invoiceYear = new Date().getFullYear();
    await conn.query(
      `INSERT IGNORE INTO inventory_pos_invoice_sequences (invoice_year, last_number)
       SELECT ?, COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0)
       FROM inventory_pos_invoices
       WHERE invoice_no LIKE ?`,
      [invoiceYear, `BV-POS-${invoiceYear}-%`]
    );
    const [[sequence]] = await conn.query(
      'SELECT last_number FROM inventory_pos_invoice_sequences WHERE invoice_year = ? FOR UPDATE',
      [invoiceYear]
    );
    const nextInvoiceNumber = Number(sequence.last_number) + 1;
    await conn.query('UPDATE inventory_pos_invoice_sequences SET last_number = ? WHERE invoice_year = ?', [
      nextInvoiceNumber,
      invoiceYear,
    ]);
    const invoiceNo = `BV-POS-${invoiceYear}-${String(nextInvoiceNumber).padStart(5, '0')}`;

    const [invRes] = await conn.query(
      `INSERT INTO inventory_pos_invoices
        (invoice_no, customer_id, customer_name, customer_phone, customer_address, customer_gstin,
         items_json, extra_charges_json, subtotal, extra_total, discount_amount,
         taxable_amount, tax_rate, tax_amount, bill_total, prev_khata_balance,
         paid_amount, new_khata_balance, payment_mode, upi_reference, status,
         cashier_username, hub_name, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      [
         invoiceNo,
         customerId,
         custName,
         custPhone,
         custAddress || null,
         custGstin,
         JSON.stringify(normalizedItems),
         JSON.stringify(safeExtraCharges),
         subTotal,
         extraTotal,
         discAmt,
         taxableAmount,
         safeTaxRate,
         taxAmount,
         billTotal,
         previousBalance,
         paid,
         newBalance,
         paymentMode || 'Cash',
         upiReference || null,
         req.invUser.username,
        req.invUser.assignedHub || 'Bhumivera Flagship Hub — Asansol',
        notes || null,
      ]
    );

    if (customerId) {
      await conn.query(
        `UPDATE inventory_customers
         SET name = ?, gstin = ?, wallet_balance = ?, total_purchases = total_purchases + ?, visit_count = visit_count + 1
         WHERE id = ?`,
        [custName, custGstin || null, newBalance, billTotal, customerId]
      );
      await conn.query(
        `INSERT INTO inventory_khata_transactions
         (customer_id, customer_name, transaction_type, amount, balance_after, payment_mode, reference_note, recorded_by)
         VALUES (?, ?, 'SALE_BILL', ?, ?, ?, ?, ?)`,
        [customerId, custName, -billTotal, previousBalance - billTotal, paymentMode, invoiceNo, req.invUser.username]
      );
      if (paid > 0) {
        await conn.query(
          `INSERT INTO inventory_khata_transactions
           (customer_id, customer_name, transaction_type, amount, balance_after, payment_mode, reference_note, recorded_by)
           VALUES (?, ?, 'PAYMENT_RECEIVED', ?, ?, ?, ?, ?)`,
          [customerId, custName, paid, newBalance, paymentMode, invoiceNo, req.invUser.username]
        );
      }
    }

    await conn.query(
      'UPDATE inventory_stock_movements SET reference_id = ? WHERE reference_id IS NULL AND operator_username = ? ORDER BY id DESC LIMIT ?',
      [invoiceNo, req.invUser.username, normalizedItems.length]
    );

    if (Array.isArray(scannerQueueIds) && scannerQueueIds.length > 0) {
      const uniqueIds = [...new Set(scannerQueueIds.map(id => Number(id)).filter(Number.isSafeInteger))];
      if (uniqueIds.length !== scannerQueueIds.length) {
        throw Object.assign(new Error('Invalid scanner queue references.'), { status: 400 });
      }
      const placeholders = uniqueIds.map(() => '?').join(',');
      const [queueRows] = await conn.query(
        `SELECT id, sku, quantity FROM inventory_scanner_queue
         WHERE session_code = ? AND status = 'queued' AND id IN (${placeholders}) FOR UPDATE`,
        [sessionCode, ...uniqueIds]
      );
      if (queueRows.length !== uniqueIds.length) {
        throw Object.assign(new Error('Some scanned items are no longer queued for this terminal. Refresh the bill and retry.'), { status: 409 });
      }
      const soldQuantityBySku = new Map();
      for (const item of normalizedItems) {
        soldQuantityBySku.set(item.sku, (soldQuantityBySku.get(item.sku) || 0) + item.q);
      }
      const queuedQuantityBySku = new Map();
      for (const row of queueRows) {
        queuedQuantityBySku.set(row.sku, (queuedQuantityBySku.get(row.sku) || 0) + Number(row.quantity));
      }
      if ([...queuedQuantityBySku].some(([sku, quantity]) => (soldQuantityBySku.get(sku) || 0) < quantity)) {
        throw Object.assign(new Error('The bill quantity does not include all linked scanner scans.'), { status: 409 });
      }
      await conn.query(
        `UPDATE inventory_scanner_queue SET status = 'consumed'
         WHERE session_code = ? AND status = 'queued' AND id IN (${placeholders})`,
        [sessionCode, ...uniqueIds]
      );
    } else if (req.invUser.scannerSessionCode) {
      const skuList = [...new Set(normalizedItems.map(item => item.sku))];
      const placeholders = skuList.map(() => '?').join(',');
      const [queueRows] = await conn.query(
        `SELECT id, sku, quantity FROM inventory_scanner_queue
         WHERE session_code = ? AND status = 'queued' AND sku IN (${placeholders})
         ORDER BY created_at ASC FOR UPDATE`,
        [sessionCode, ...skuList]
      );
      const remainingBySku = new Map();
      for (const item of normalizedItems) {
        remainingBySku.set(item.sku, (remainingBySku.get(item.sku) || 0) + item.q);
      }
      for (const row of queueRows) {
        const remaining = remainingBySku.get(row.sku) || 0;
        const consumed = Math.min(remaining, Number(row.quantity));
        if (consumed <= 0) continue;
        remainingBySku.set(row.sku, remaining - consumed);
        if (consumed === Number(row.quantity)) {
          await conn.query(
            "UPDATE inventory_scanner_queue SET status = 'consumed' WHERE session_code = ? AND id = ? AND status = 'queued'",
            [sessionCode, row.id]
          );
        } else {
          await conn.query(
            "UPDATE inventory_scanner_queue SET quantity = quantity - ? WHERE session_code = ? AND id = ? AND status = 'queued'",
            [consumed, sessionCode, row.id]
          );
        }
      }
    }

    for (const item of normalizedItems) {
      await conn
        .query(
          `INSERT INTO warehouse_sales_log (user_id, store_name, product_name, quantity, sale_price, customer_type, customer_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            req.invUser.id || 1,
            req.invUser.assignedHub || 'Bhumivera Flagship Hub',
            item.name,
            item.q,
            item.p,
            custName.toLowerCase().includes('walk-in') ? 'walkin' : 'registered',
            custName,
          ]
        )
        .catch(() => {});
    }

    await conn
      .query('UPDATE inventory_staff_accounts SET total_pos_bills = total_pos_bills + 1 WHERE id = ?', [
        req.invUser.id,
      ])
      .catch(() => {});

    await appendInventoryAuditLog(conn, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'POS_INVOICE_CREATED',
      summary: `Generated POS Invoice #${invoiceNo} for ${custName} (₹${billTotal}). Live website stock atomically deducted.`,
      details: { invoiceNo, billTotal, paid, stockDeductions },
    });

    const saleRecord = {
      id: invRes.insertId,
      invoiceNo,
      date: new Date().toISOString(),
      cust: { id: customerId, name: custName, phone: custPhone, address: custAddress, gstin: custGstin },
      items: normalizedItems,
      extra: safeExtraCharges,
      subTotal,
      extraTotal,
      discount: discAmt,
      taxableAmount,
      taxRate: safeTaxRate,
      tax: taxAmount,
      total: subTotal,
      billTotal,
      paid,
      prevBal: previousBalance,
      newBal: newBalance,
      paymentMode: paymentMode || 'Cash',
      cashier: req.invUser.username,
      stockDeductions,
    };

    const responseBody = {
      success: true,
      message: `Invoice #${invoiceNo} generated & live website stock updated immediately!`,
      sale: saleRecord,
    };
    await conn.query(
      'UPDATE inventory_pos_checkout_requests SET invoice_id = ?, response_json = ? WHERE idempotency_key = ?',
      [invRes.insertId, JSON.stringify(responseBody), idempotencyKey]
    );
    await conn.query('DELETE FROM inventory_pos_drafts WHERE session_code = ?', [sessionCode]);
    if (orderId && String(orderId).trim()) {
      markOrderLockCompleted(orderId, checkoutOperator.username, checkoutOperator.name, sessionCode);
    }
    if (draftId && savedPosDraftsMemory.has(String(draftId).trim())) {
      savedPosDraftsMemory.delete(String(draftId).trim());
      await conn.query('DELETE FROM inventory_pos_saved_drafts WHERE draft_id = ?', [String(draftId).trim()]).catch(() => {});
    }
    const memSessionAfterCheckout = scannerSessionsMemory.get(sessionCode);
    if (memSessionAfterCheckout) {
      memSessionAfterCheckout.draftCache = null;
      memSessionAfterCheckout.queueCache = [];
      memSessionAfterCheckout.stateVersion = (memSessionAfterCheckout.stateVersion || 1) + 1;
    }
    await conn.commit();
    transactionStarted = false;
    await invalidatePublicCatalogCache();
    res.status(201).json(responseBody);
  } catch (err) {
    if (transactionStarted) await conn.rollback();
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

router.post('/pos/:invoiceId/cancel', authenticateInventoryStaff, requirePermission('can_void_invoices'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[sale]] = await conn.query('SELECT * FROM inventory_pos_invoices WHERE id = ? FOR UPDATE', [
      req.params.invoiceId,
    ]);
    if (!sale) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }
    if (sale.status === 'cancelled') {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invoice is already cancelled.' });
    }

    const items = parseJsonSafe(sale.items_json, []) || [];
    for (const soldItem of items) {
      await atomicAdjustProductStock(
        {
          metaId: soldItem.id,
          productId: soldItem.productId,
          sku: soldItem.sku,
          operation: 'add',
          quantity: Number(soldItem.q || soldItem.quantity || 1),
          movementType: 'POS_VOID_RESTOCK',
          referenceId: sale.invoice_no,
          reason: `Voided POS Invoice #${sale.invoice_no} — Restocked to Website`,
          operatorUsername: req.invUser.username,
        },
        conn
      );
    }

    if (sale.customer_id) {
      const [[customerRow]] = await conn.query(
        'SELECT id, wallet_balance FROM inventory_customers WHERE id = ? FOR UPDATE',
        [sale.customer_id]
      );
      if (customerRow) {
        const restoredBalance =
          (Number(customerRow.wallet_balance) || 0) +
          (Number(sale.bill_total) || 0) -
          (Number(sale.paid_amount) || 0);
        await conn.query(
          `UPDATE inventory_customers
           SET wallet_balance = ?, total_purchases = GREATEST(0, total_purchases - ?)
           WHERE id = ?`,
          [restoredBalance, Number(sale.bill_total) || 0, customerRow.id]
        );
        await conn.query(
          `INSERT INTO inventory_khata_transactions
           (customer_id, customer_name, transaction_type, amount, balance_after, payment_mode, reference_note, recorded_by)
           VALUES (?, ?, 'VOID_REVERSAL', ?, ?, ?, ?, ?)`,
          [
            customerRow.id,
            sale.customer_name,
            (Number(sale.bill_total) || 0) - (Number(sale.paid_amount) || 0),
            restoredBalance,
            sale.payment_mode,
            sale.invoice_no,
            req.invUser.username,
          ]
        );
        await conn.query('UPDATE inventory_pos_invoices SET new_khata_balance = ? WHERE id = ?', [
          restoredBalance,
          sale.id,
        ]);
      }
    }

    await conn.query('UPDATE inventory_pos_invoices SET status = "cancelled" WHERE id = ?', [sale.id]);

    await appendInventoryAuditLog(conn, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'POS_INVOICE_VOID',
      summary: `Cancelled POS Invoice #${sale.invoice_no} and restored all items to live website stock.`,
    });

    await conn.commit();
    await invalidatePublicCatalogCache();

    res.json({
      success: true,
      message: `Invoice #${sale.invoice_no} cancelled and items restocked to bhumivera.com.`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// 6. STORAGE KEEPER: BINS, RACKS, BIN TRANSFERS & PHYSICAL STOCK AUDIT
router.post('/keeper/bins/save', authenticateInventoryStaff, requirePermission('can_manage_storage_keeper'), async (req, res) => {
  try {
    const {
      id,
      binCode,
      hubName = 'Bhumivera Flagship Hub — Asansol',
      zoneName,
      rackNo,
      shelfLevel,
      binLabel,
      temperatureTarget = '22°C - 26°C',
      capacityUnits = 500,
      occupiedUnits = 0,
      keeperName = 'Master Keeper',
      status = 'active',
      notes = '',
    } = req.body || {};

    if (!binCode || !zoneName) {
      return res.status(400).json({ success: false, message: 'Bin code and zone name are required.' });
    }

    if (id) {
      await pool.query(
        `UPDATE inventory_storage_bins
         SET bin_code = ?, hub_name = ?, zone_name = ?, rack_no = ?, shelf_level = ?,
             bin_label = ?, temperature_target = ?, capacity_units = ?, occupied_units = ?,
             keeper_name = ?, status = ?, notes = ?
         WHERE id = ?`,
        [
          binCode,
          hubName,
          zoneName,
          rackNo || 'Rack-01',
          shelfLevel || 'Shelf-A',
          binLabel || binCode,
          temperatureTarget,
          Number(capacityUnits) || 500,
          Number(occupiedUnits) || 0,
          keeperName,
          status,
          notes,
          id,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO inventory_storage_bins
          (bin_code, hub_name, zone_name, rack_no, shelf_level, bin_label, temperature_target, capacity_units, occupied_units, keeper_name, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          binCode,
          hubName,
          zoneName,
          rackNo || 'Rack-01',
          shelfLevel || 'Shelf-A',
          binLabel || binCode,
          temperatureTarget,
          Number(capacityUnits) || 500,
          Number(occupiedUnits) || 0,
          keeperName,
          status,
          notes,
        ]
      );
    }

    res.json({ success: true, message: `Saved storage bin "${binCode}".` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/keeper/transfer', authenticateInventoryStaff, requirePermission('can_manage_storage_keeper'), async (req, res) => {
  try {
    const {
      metaId,
      direction = 'VAULT_TO_SHOP',
      quantity = 10,
      newBinCode,
      newRackLocation,
      notes = '',
    } = req.body || {};

    const [[meta]] = await pool.query('SELECT * FROM inventory_product_meta WHERE id = ?', [metaId]);
    if (!meta) return res.status(404).json({ success: false, message: 'Product not found.' });

    const transferQty = Math.max(1, Math.trunc(Number(quantity) || 1));
    let shopStock = Number(meta.shop_display_stock) || 0;
    let vaultStock = Number(meta.warehouse_vault_stock) || 0;

    if (direction === 'VAULT_TO_SHOP') {
      const move = Math.min(vaultStock, transferQty);
      vaultStock -= move;
      shopStock += move;
    } else if (direction === 'SHOP_TO_VAULT') {
      const move = Math.min(shopStock, transferQty);
      shopStock -= move;
      vaultStock += move;
    }

    const updatedBin = newBinCode || meta.bin_code;
    const updatedRack = newRackLocation || meta.rack_location;

    await pool.query(
      `UPDATE inventory_product_meta
       SET shop_display_stock = ?, warehouse_vault_stock = ?, bin_code = ?, rack_location = ?
       WHERE id = ?`,
      [shopStock, vaultStock, updatedBin, updatedRack, meta.id]
    );

    await recordStockMovement(pool, {
      productId: meta.product_id,
      sku: meta.sku,
      productName: meta.custom_name,
      movementType: 'BIN_TRANSFER',
      qtyBefore: Number(meta.physical_stock) || 0,
      qtyDelta: 0,
      qtyAfter: Number(meta.physical_stock) || 0,
      binCode: updatedBin,
      batchNo: meta.batch_no,
      reason: `Internal Transfer (${direction}): ${transferQty} units. ${notes}`,
      operatorUsername: req.invUser.username,
    });

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'KEEPER_BIN_TRANSFER',
      summary: `Transferred ${transferQty} units of "${meta.custom_name}" (${direction}) → Bin ${updatedBin} (Shop Counter: ${shopStock}, Cold Vault: ${vaultStock}).`,
    });

    res.json({
      success: true,
      message: `Transferred ${transferQty} units (${direction}). Shop Display: ${shopStock}, Vault Reserve: ${vaultStock}.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/keeper/audit-reconcile', authenticateInventoryStaff, requirePermission('can_run_stock_audit'), async (req, res) => {
  try {
    const { counts = [], auditNote = 'Physical Stock Audit Reconciliation' } = req.body || {};
    if (!Array.isArray(counts) || counts.length === 0) {
      return res.status(400).json({ success: false, message: 'Provide physical counts to reconcile.' });
    }

    const reconciled = [];
    for (const entry of counts) {
      const resAdj = await atomicAdjustProductStock({
        metaId: entry.metaId || entry.id,
        productId: entry.productId,
        sku: entry.sku,
        operation: 'set',
        quantity: Number(entry.physicalCountedQty),
        movementType: 'PHYSICAL_AUDIT_SYNC',
        reason: `${auditNote}${entry.note ? ` (${entry.note})` : ''}`,
        operatorUsername: req.invUser.username,
      });
      reconciled.push(resAdj);
    }

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'PHYSICAL_STOCK_AUDIT',
      summary: `Reconciled physical stock audit across ${reconciled.length} SKU(s) and updated live website inventory.`,
      details: reconciled,
    });

    res.json({
      success: true,
      message: `Reconciled ${reconciled.length} SKU(s) with live website stock.`,
      reconciled,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. UNDELIVERED ORDER (RTO — RETURN TO ORIGIN) & QUARANTINE ENGINE
// Note: Bhumivera has ZERO policy of post-delivery returns. Only Undelivered / Courier RTO returns are accepted.
router.post('/returns/rto-process', authenticateInventoryStaff, requirePermission('can_process_returns'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      orderId,
      mode = 'RESTOCK', // 'RESTOCK' (Unopened/Intact -> Add to Main Stock) | 'QUARANTINE' (Damaged in Transit -> Quarantine Bay)
      rtoReason = 'Undelivered by Courier — Return to Origin (RTO)',
    } = req.body || {};

    if (!orderId) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Select a valid Order ID to process RTO return.' });
    }

    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [Number(orderId)]);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    if (order.status === 'delivered') {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        code: 'POST_DELIVERY_RETURN_PROHIBITED',
        message: `Order #${order.order_number || order.id} is marked DELIVERED. Under Bhumivera company policy, delivered orders are 100% non-returnable. Only undelivered (RTO) shipments can be returned and restocked.`,
      });
    }

    if (order.rto_restock_mode && order.rto_restock_mode !== 'NONE') {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: `Order #${order.order_number || order.id} has already been processed as RTO (${order.rto_restock_mode}).`,
      });
    }

    const [orderItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    const alreadyReturnedStatus = ['returned', 'cancelled'].includes(order.status);

    // Release conn lock briefly if calling updateOrderStatus, or perform atomic update directly
    await conn.rollback();
    conn.release();

    // Transition order status to 'returned' (updateOrderStatus automatically restores products.quantity if not already returned/cancelled)
    if (!alreadyReturnedStatus) {
      await updateOrderStatus(order.id, 'returned', rtoReason, {
        trackingNumber: order.tracking_number,
        courier: order.courier,
      });
    }

    const restockedItems = [];
    for (const item of orderItems) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      if (mode === 'QUARANTINE') {
        // Because updateOrderStatus added qty back to products.quantity, we subtract it from sellable stock and move to damaged_quarantine_stock
        const adj = await atomicAdjustProductStock({
          productId: item.product_id,
          sku: item.sku,
          operation: alreadyReturnedStatus ? 'add' : 'subtract',
          quantity: alreadyReturnedStatus ? 0 : qty,
          quarantineDelta: qty,
          movementType: 'ONLINE_ORDER_RTO_QUARANTINE',
          referenceId: `ORD-#${order.order_number || order.id}`,
          reason: `RTO Damaged in Courier Transit (${rtoReason}) — Moved to Quarantine`,
          operatorUsername: req.invUser.username,
        });
        restockedItems.push(adj);
      } else {
        // Mode === 'RESTOCK': if order was already returned earlier without restock, add back; otherwise sync meta & log movement
        if (alreadyReturnedStatus) {
          const adj = await atomicAdjustProductStock({
            productId: item.product_id,
            sku: item.sku,
            operation: 'add',
            quantity: qty,
            movementType: 'ONLINE_ORDER_RTO_RESTOCK',
            referenceId: `ORD-#${order.order_number || order.id}`,
            reason: `RTO Undelivered Order Restocked (${rtoReason})`,
            operatorUsername: req.invUser.username,
          });
          restockedItems.push(adj);
        } else {
          await syncWebsiteProductsToInventoryMeta(pool);
          await recalculateAllBundleStocks(pool);
          const [[prod]] = await pool.query('SELECT id, name, sku, quantity FROM products WHERE id = ?', [
            item.product_id,
          ]);
          if (prod) {
            const qtyAfter = Number(prod.quantity) || 0;
            await recordStockMovement(pool, {
              productId: prod.id,
              sku: prod.sku,
              productName: prod.name,
              movementType: 'ONLINE_ORDER_RTO_RESTOCK',
              qtyBefore: Math.max(0, qtyAfter - qty),
              qtyDelta: qty,
              qtyAfter,
              binCode: 'ASN-DISPATCH-R1-B01',
              referenceId: `ORD-#${order.order_number || order.id}`,
              reason: `RTO Undelivered Order Restocked to Main Inventory (${rtoReason})`,
              operatorUsername: req.invUser.username,
            });
            restockedItems.push({
              productId: prod.id,
              sku: prod.sku,
              name: prod.name,
              qtyAdded: qty,
              websiteAvailableQty: qtyAfter,
            });
          }
        }
      }
    }

    const rtoModeValue = mode === 'QUARANTINE' ? 'QUARANTINED' : 'RESTOCKED';
    const checkpointMsg =
      mode === 'QUARANTINE'
        ? `RTO Parcel Received Damaged — Moved to Quarantine Bay (${rtoReason})`
        : `RTO Parcel Received Intact — Restocked to Main Website Inventory (${rtoReason})`;

    await pool.query(
      `UPDATE orders
       SET status = 'returned',
           rto_reason = ?,
           rto_restock_mode = ?,
           rto_processed_at = NOW(),
           current_location_checkpoint = ?
       WHERE id = ?`,
      [rtoReason, rtoModeValue, checkpointMsg, order.id]
    );

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: mode === 'QUARANTINE' ? 'RTO_RETURN_QUARANTINE' : 'RTO_RETURN_RESTOCK',
      summary: `Processed Undelivered RTO Order #${order.order_number || order.id} in ${rtoModeValue} mode (${rtoReason}).`,
      details: { orderId: order.id, orderNumber: order.order_number, rtoReason, restockedItems },
    });

    await invalidatePublicCatalogCache();

    return res.json({
      success: true,
      message:
        mode === 'QUARANTINE'
          ? `Order #${order.order_number || order.id} marked as RTO Returned & Damaged units moved to Quarantine Bay.`
          : `Order #${order.order_number || order.id} marked as RTO Returned & all items restocked to live main inventory!`,
      restockedItems,
    });
  } catch (err) {
    try {
      await conn.rollback();
      conn.release();
    } catch {}
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/returns/process', authenticateInventoryStaff, requirePermission('can_process_returns'), async (req, res) => {
  try {
    const {
      metaId,
      productId,
      quantity = 1,
      mode = 'GOOD',
      reason = 'Undelivered / Courier RTO Return',
    } = req.body || {};

    const safeQty = Math.max(1, Math.trunc(Number(quantity) || 1));

    let stockResult;
    if (mode === 'GOOD') {
      stockResult = await atomicAdjustProductStock({
        metaId,
        productId,
        operation: 'add',
        quantity: safeQty,
        movementType: 'RTO_RETURN_RESTOCK',
        reason: `Undelivered Return (Intact — Restocked): ${reason}`,
        operatorUsername: req.invUser.username,
      });
    } else {
      stockResult = await atomicAdjustProductStock({
        metaId,
        productId,
        operation: 'add',
        quantity: 0,
        quarantineDelta: safeQty,
        movementType: 'RTO_RETURN_QUARANTINE',
        reason: `Undelivered Return (Damaged/Quarantined): ${reason}`,
        operatorUsername: req.invUser.username,
      });
    }

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: mode === 'GOOD' ? 'RETURN_RESTOCK' : 'RETURN_QUARANTINE',
      summary: `Processed ${safeQty}x "${stockResult.name}" undelivered return in ${mode === 'GOOD' ? 'Restock (Added to Website)' : 'Quarantine/Scrap'} mode.`,
    });

    res.json({
      success: true,
      message:
        mode === 'GOOD'
          ? `Restocked ${safeQty}x "${stockResult.name}" back to live website inventory.`
          : `Moved ${safeQty}x "${stockResult.name}" to Quarantine Bay (excluded from live website stock).`,
      result: stockResult,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. SUPPLIERS & GOODS RECEIPT NOTE (GRN) INWARDING
router.post('/suppliers/save', authenticateInventoryStaff, requirePermission('can_manage_suppliers_grn'), async (req, res) => {
  try {
    const {
      id,
      name,
      companyName,
      phone = '',
      email = '',
      gstin = '',
      city = '',
      supplyCategory = 'Botanical Extracts & Packaging',
      payableBalance = 0,
      leadTimeDays = 5,
      notes = '',
    } = req.body || {};

    if (!name) return res.status(400).json({ success: false, message: 'Supplier name is required.' });

    if (id) {
      await pool.query(
        `UPDATE inventory_suppliers
         SET name = ?, company_name = ?, phone = ?, email = ?, gstin = ?, city = ?,
             supply_category = ?, payable_balance = ?, lead_time_days = ?, notes = ?
         WHERE id = ?`,
        [name, companyName || name, phone, email, gstin, city, supplyCategory, Number(payableBalance) || 0, Number(leadTimeDays) || 5, notes, id]
      );
    } else {
      const code = 'SUP-' + Math.floor(1000 + Math.random() * 9000);
      await pool.query(
        `INSERT INTO inventory_suppliers
          (supplier_code, name, company_name, phone, email, gstin, city, supply_category, payable_balance, lead_time_days, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, name, companyName || name, phone, email, gstin, city, supplyCategory, Number(payableBalance) || 0, Number(leadTimeDays) || 5, notes]
      );
    }
    res.json({ success: true, message: `Saved supplier "${name}".` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/grn/inward', authenticateInventoryStaff, requirePermission('can_manage_suppliers_grn'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      supplierId,
      supplierName = 'Direct Manufacturing Batch',
      metaId,
      productId,
      batchNo,
      mfgDate,
      expiryDate,
      receivedQty = 0,
      rejectedQty = 0,
      unitCost = 0,
      binCode = 'ASN-COLD-R1-B01',
      invoiceRef = '',
      notes = '',
    } = req.body || {};

    const safeReceived = Math.max(1, Math.trunc(Number(receivedQty) || 0));
    const safeRejected = Math.max(0, Math.min(safeReceived, Math.trunc(Number(rejectedQty) || 0)));
    const acceptedQty = safeReceived - safeRejected;

    const [[countRow]] = await conn.query('SELECT COUNT(*) AS cnt FROM inventory_grn_entries');
    const grnNo = `GRN-${new Date().getFullYear()}-${String(Number(countRow?.cnt || 0) + 1).padStart(4, '0')}`;

    const stockRes = await atomicAdjustProductStock(
      {
        metaId,
        productId,
        operation: 'add',
        quantity: acceptedQty,
        quarantineDelta: safeRejected,
        movementType: 'GRN_INWARD',
        referenceId: grnNo,
        reason: `GRN Inward #${grnNo} from ${supplierName} (Batch: ${batchNo || 'N/A'})`,
        operatorUsername: req.invUser.username,
      },
      conn
    );

    if (batchNo || mfgDate || expiryDate || binCode || Number(unitCost) > 0) {
      await conn.query(
        `UPDATE inventory_product_meta
         SET batch_no = COALESCE(?, batch_no),
             mfg_date = COALESCE(?, mfg_date),
             expiry_date = COALESCE(?, expiry_date),
             bin_code = COALESCE(?, bin_code),
             cost_price = CASE WHEN ? > 0 THEN ? ELSE cost_price END
         WHERE id = ?`,
        [
          batchNo || null,
          mfgDate || null,
          expiryDate || null,
          binCode || null,
          Number(unitCost) || 0,
          Number(unitCost) || 0,
          stockRes.metaId,
        ]
      );
    }

    const totalCost = acceptedQty * (Number(unitCost) || 0);
    await conn.query(
      `INSERT INTO inventory_grn_entries
        (grn_no, supplier_id, supplier_name, product_id, sku, product_name, batch_no, mfg_date, expiry_date,
         received_qty, accepted_qty, rejected_qty, unit_cost, total_cost, bin_code, invoice_ref, received_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grnNo,
        supplierId || null,
        supplierName,
        stockRes.productId,
        stockRes.sku,
        stockRes.name,
        batchNo || `BATCH-${Date.now().toString().slice(-5)}`,
        mfgDate || null,
        expiryDate || null,
        safeReceived,
        acceptedQty,
        safeRejected,
        Number(unitCost) || 0,
        totalCost,
        binCode,
        invoiceRef || null,
        req.invUser.username,
        notes || null,
      ]
    );

    await appendInventoryAuditLog(conn, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'GRN_STOCK_INWARD',
      summary: `Inwarded ${acceptedQty} accepted units of "${stockRes.name}" via ${grnNo} into Bin ${binCode}. Live website stock: ${stockRes.websiteAvailableQty}.`,
    });

    await conn.commit();
    await invalidatePublicCatalogCache();

    res.status(201).json({
      success: true,
      message: `GRN #${grnNo} posted! Added +${acceptedQty} units of "${stockRes.name}" to live website stock (Total Available: ${stockRes.websiteAvailableQty}).`,
      grnNo,
      stockResult: stockRes,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// 9. FULL ONLINE ORDER LIFECYCLE, DISPATCH, TRACKING, LABEL PRINTING & CARRIER BOOKING
const sendLifecycleStatusEmail = async (orderData, status, trackingNumber, courier, trackingUrl = '', items = []) => {
  if (!orderData?.email) {
    return { attempted: true, sent: false, error: 'Customer email address is not available.' };
  }
  try {
    await sendOrderStatusEmail(
      orderData.email,
      orderData.name || 'Patron',
      orderData.id,
      status,
      trackingNumber || null,
      courier || null,
      orderData.order_number,
      { trackingUrl, items }
    );
    return { attempted: true, sent: true };
  } catch (error) {
    console.error(`Order status email failed for #${orderData.order_number || orderData.id}:`, error);
    return { attempted: true, sent: false, error: error.message || 'Email delivery failed.' };
  }
};

router.put('/online-orders/:orderId/dispatch-status', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  let dispatchStage = 'validate request';
  try {
    const orderId = Number(req.params.orderId);
    const {
      status,
      courier,
      trackingNumber,
      trackingUrl,
      estimatedDeliveryDate,
      currentLocationCheckpoint,
      notes,
      cancelReason,
    } = req.body || {};

    const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'returned', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Order status must be pending, confirmed, packed, shipped, out_for_delivery, delivered, returned, or cancelled.',
      });
    }

    dispatchStage = 'load order';
    const [[orderData]] = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.tracking_number, o.courier, o.tracking_url,
              u.name, u.email
       FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [orderId]
    );
    if (!orderData) return res.status(404).json({ success: false, message: 'Order not found.' });

    if (status === 'cancelled') {
      const cancelResult = await executeAtomicOrderCancellationAndRefund(pool, {
        orderId,
        reason: cancelReason || 'Cancelled from Inventory & Order Lifecycle Hub',
        refundDestinationPreference: 'auto',
        executedByEmail: req.invUser.email || 'admin@bhumivera.com',
        razorpay: getRazorpayClient(),
      });
      markOrderLockCompleted(orderData.order_number || orderId, req.invUser.username, req.invUser.fullName, req.invUser.scannerSessionCode);
      markOrderLockCompleted(orderId, req.invUser.username, req.invUser.fullName, req.invUser.scannerSessionCode);
      const warnings = [];
      try {
        await syncWebsiteProductsToInventoryMeta(pool);
      } catch (syncError) {
        console.error('Inventory sync failed after order cancellation:', syncError);
        warnings.push('Stock was restored, but inventory sync needs attention.');
      }
      try {
        await invalidatePublicCatalogCache();
      } catch (cacheError) {
        console.error('Catalog cache invalidation failed after order cancellation:', cacheError);
        warnings.push('The public catalog cache could not be refreshed.');
      }
      const email = await sendLifecycleStatusEmail(orderData, 'cancelled', orderData.tracking_number, orderData.courier);
      return res.json({
        success: true,
        message: `Order #${orderId} cancelled and stock restored to main inventory.`,
        refundSummary: cancelResult.refundSummary,
        emailSent: email.sent,
        emailError: email.error || null,
        warnings,
      });
    }

    const previousStatus = String(orderData.status || '').toLowerCase();
    if (status !== previousStatus) {
      const requiredPreviousStatus = {
        confirmed: 'pending',
        shipped: 'packed',
        out_for_delivery: 'shipped',
        delivered: 'out_for_delivery',
      }[status];
      if (status === 'packed') {
        return res.status(409).json({ success: false, message: 'Packed status is set only after the PWA successfully uploads verified scans.' });
      }
      if (requiredPreviousStatus && previousStatus !== requiredPreviousStatus) {
        return res.status(409).json({
          success: false,
          message: `Order must be ${requiredPreviousStatus.replace(/_/g, ' ')} before it can be marked ${status.replace(/_/g, ' ')}.`,
        });
      }
      if (status === 'returned' && !['shipped', 'out_for_delivery', 'delivered'].includes(previousStatus)) {
        return res.status(409).json({ success: false, message: 'Only shipped orders can be marked returned.' });
      }
      if (status === 'pending') {
        return res.status(409).json({ success: false, message: 'Placed status is assigned when an order is created.' });
      }
    }

    const savedTrackingNumber = String(trackingNumber || orderData.tracking_number || '').trim();
    const savedCourier = String(courier || orderData.courier || '').trim();
    const savedTrackingUrl = String(trackingUrl || orderData.tracking_url || '').trim();
    const shipmentDetailsChanged = status === 'shipped' && (
      savedTrackingNumber !== String(orderData.tracking_number || '').trim() ||
      savedCourier !== String(orderData.courier || '').trim() ||
      savedTrackingUrl !== String(orderData.tracking_url || '').trim()
    );
    if (status === 'shipped' && (!savedTrackingNumber || !savedCourier || !savedTrackingUrl)) {
      return res.status(400).json({
        success: false,
        message: 'Add the courier, tracking/AWB number, and tracking link when shipping the packed order. Packing itself does not require shipping details.',
      });
    }
    if (trackingUrl) {
      let parsedTrackingUrl;
      try {
        parsedTrackingUrl = new URL(savedTrackingUrl);
      } catch {
        return res.status(400).json({ success: false, message: 'Enter a valid tracking link, including https://.' });
      }
      if (!['http:', 'https:'].includes(parsedTrackingUrl.protocol)) {
        return res.status(400).json({ success: false, message: 'Tracking links must use http:// or https://.' });
      }
    }

    const defaultCheckpoint =
      currentLocationCheckpoint ||
      (status === 'delivered'
        ? 'Delivered to Customer'
        : status === 'out_for_delivery'
        ? 'Out for Delivery'
        : status === 'shipped'
        ? `Dispatched via ${savedCourier || 'Courier'}${savedTrackingNumber ? ` (AWB: ${savedTrackingNumber})` : ''} — In Transit`
        : status === 'packed'
        ? 'Packed & Weighed at Asansol Hub — Ready for Courier Pickup'
        : status === 'confirmed'
        ? 'Confirmed & Stock Reserved at Asansol Hub'
        : null);

    dispatchStage = 'commit lifecycle transition';
    const updated = await updateOrderStatus(orderId, status, cancelReason || null, {
      courier: savedCourier,
      trackingNumber: savedTrackingNumber,
      trackingUrl: savedTrackingUrl,
      estimatedDeliveryDate,
      currentLocationCheckpoint: defaultCheckpoint,
      notes,
    });
    if (!updated) return res.status(404).json({ success: false, message: 'Order not found.' });

    const warnings = [];
    try {
      await syncWebsiteProductsToInventoryMeta(pool);
    } catch (syncError) {
      console.error(`Inventory sync failed after order #${orderId} status update:`, syncError);
      warnings.push('Order status was updated, but inventory sync needs attention.');
    }
    try {
      await invalidatePublicCatalogCache();
    } catch (cacheError) {
      console.error(`Catalog cache invalidation failed after order #${orderId} status update:`, cacheError);
      warnings.push('The public catalog cache could not be refreshed.');
    }

    const emailStatuses = new Set(['shipped', 'out_for_delivery', 'delivered', 'returned']);
    let emailItems = [];
    if (status === 'shipped' && (status !== previousStatus || shipmentDetailsChanged)) {
      try {
        const [rows] = await pool.query(
          'SELECT name, quantity, price FROM order_items WHERE order_id = ? ORDER BY id ASC',
          [orderId]
        );
        emailItems = rows;
      } catch (itemsError) {
        console.error(`Could not load item details for shipment email on order #${orderId}:`, itemsError);
        warnings.push('Order shipped, but item details could not be added to the customer email.');
      }
    }
    dispatchStage = 'send customer update';
    const email = emailStatuses.has(status) && (status !== previousStatus || shipmentDetailsChanged)
      ? await sendLifecycleStatusEmail(orderData, status, savedTrackingNumber, savedCourier, savedTrackingUrl, emailItems)
      : { attempted: false, sent: false };
    if (['packed', 'shipped', 'out_for_delivery', 'delivered', 'returned'].includes(status)) {
      markOrderLockCompleted(orderData.order_number || orderId, req.invUser.username, req.invUser.fullName, req.invUser.scannerSessionCode);
      markOrderLockCompleted(orderId, req.invUser.username, req.invUser.fullName, req.invUser.scannerSessionCode);
    }

    dispatchStage = 'write audit entry';
    try {
      await appendInventoryAuditLog(pool, {
        actorUsername: req.invUser.username,
        actorRole: req.invUser.role,
        actionCode: 'ONLINE_ORDER_LIFECYCLE',
        summary: `Updated Order #${orderId} status to ${status.toUpperCase()}${savedTrackingNumber ? ` (AWB: ${savedTrackingNumber}, Courier: ${savedCourier || 'Standard'})` : ''}.`,
      });
    } catch (auditError) {
      console.error(`Audit log failed after order #${orderId} status was committed:`, auditError);
      warnings.push('Order status was updated, but its audit entry could not be saved.');
    }

    res.json({
      success: true,
      message: `Online Order #${orderId} updated to ${status.toUpperCase()}.`,
      emailSent: email.sent,
      emailError: email.error || null,
      warnings,
    });
  } catch (err) {
    console.error(`Dispatch status failed during "${dispatchStage}" for order #${req.params.orderId}:`, err);
    res.status(err.status || 500).json({
      success: false,
      code: err.code || 'DISPATCH_STATUS_UPDATE_FAILED',
      stage: dispatchStage,
      message: err.message || 'Could not update order dispatch status.',
    });
  }
});

router.put('/online-orders/:orderId/edit', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const [[existing]] = await pool.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const {
      courier,
      trackingNumber,
      estimatedDeliveryDate,
      currentLocationCheckpoint,
      notes,
      recipientName,
      recipientPhone,
      recipientAltPhone,
      line1,
      line2,
      landmark,
      city,
      state,
      pincode,
    } = req.body || {};

    if (req.body?.status !== undefined && req.body.status !== existing.status) {
      return res.status(409).json({
        success: false,
        message: 'Change order status using the dedicated lifecycle actions so required validation and customer notifications run.',
      });
    }

    const currentAddr = parseJsonSafe(existing.address_snapshot, {}) || {};
    const updatedAddr = {
      ...currentAddr,
      ...(recipientName !== undefined ? { full_name: recipientName, name: recipientName } : {}),
      ...(recipientPhone !== undefined ? { phone: recipientPhone } : {}),
      ...(recipientAltPhone !== undefined ? { alternate_phone: recipientAltPhone } : {}),
      ...(line1 !== undefined ? { line1, street_address: line1 } : {}),
      ...(line2 !== undefined ? { line2 } : {}),
      ...(landmark !== undefined ? { landmark } : {}),
      ...(city !== undefined ? { city } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(pincode !== undefined ? { pincode, postal_code: pincode } : {}),
    };

    await pool.query(
      `UPDATE orders
       SET courier = COALESCE(?, courier),
           tracking_number = COALESCE(?, tracking_number),
           estimated_delivery_date = COALESCE(?, estimated_delivery_date),
           current_location_checkpoint = COALESCE(?, current_location_checkpoint),
           notes = COALESCE(?, notes),
           address_snapshot = ?
       WHERE id = ?`,
      [
        courier !== undefined ? courier : null,
        trackingNumber !== undefined ? trackingNumber : null,
        estimatedDeliveryDate || null,
        currentLocationCheckpoint !== undefined ? currentLocationCheckpoint : null,
        notes !== undefined ? notes : null,
        JSON.stringify(updatedAddr),
        orderId,
      ]
    );

    await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'ONLINE_ORDER_EDIT',
      summary: `Edited Order #${existing.order_number || orderId} details (Tracking: ${trackingNumber || existing.tracking_number || 'N/A'}, Location: ${currentLocationCheckpoint || 'Updated'}, City: ${updatedAddr.city || '-'}).`,
    });

    res.json({
      success: true,
      message: `Order #${existing.order_number || orderId} details updated. Customer status emails are sent only by lifecycle transitions.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/online-orders/mark-labels-printed', authenticateInventoryStaff, async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map(id => Number(id)).filter(Boolean)
      : req.body?.orderId
      ? [Number(req.body.orderId)]
      : [];

    if (orderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Provide at least one orderId.' });
    }

    const placeholders = orderIds.map(() => '?').join(',');
    await pool.query(`UPDATE orders SET label_printed_at = NOW() WHERE id IN (${placeholders})`, orderIds);

    res.json({
      success: true,
      message: `Marked shipping labels printed for ${orderIds.length} order(s).`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/online-orders/:orderId/book-carrier-label', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const provider = String(req.body?.provider || 'shiprocket').toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ success: false, message: 'Select Shiprocket or Delhivery.' });
    }
    const [[shipment]] = await pool.query(
      'SELECT status, courier, tracking_number, tracking_url FROM orders WHERE id = ?',
      [orderId]
    );
    if (!shipment) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!['shipped', 'out_for_delivery', 'delivered'].includes(String(shipment.status || '').toLowerCase()) ||
        !shipment.courier || !shipment.tracking_number || !shipment.tracking_url) {
      return res.status(409).json({
        success: false,
        code: 'SHIPMENT_DETAILS_REQUIRED',
        message: 'Shipping documents are locked until the order is shipped with courier, tracking/AWB number, and tracking link.',
      });
    }
    const dimensions = {
      weight: Math.max(0.1, Number(req.body?.weight) || 0.5),
      length: Math.max(1, Number(req.body?.length) || 20),
      width: Math.max(1, Number(req.body?.width) || 15),
      height: Math.max(1, Number(req.body?.height) || 10),
    };

    const { order } = await prepareLabelOrder({ orderId, returnId: null, direction: 'forward' });
    const labelId = await beginShippingLabel({
      orderId,
      returnId: null,
      direction: 'forward',
      provider,
      packageDetails: dimensions,
      adminId: req.invUser.id || 1,
    });

    await logShippingLabelEvent(labelId, 'booking_started', { provider, direction: 'forward' }, req.invUser.id || 1);
    const result = await createLabelWithProvider({
      order,
      provider,
      packageDetails: dimensions,
      labelId,
      direction: 'forward',
      courierId: req.body?.courier_id ? String(req.body.courier_id) : null,
    });

    await updateLabelRecord(labelId, {
      status: 'booked',
      externalOrderId: result.externalOrderId,
      externalShipmentId: result.externalShipmentId,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      serviceName: result.serviceName,
      errorMessage: null,
    });

    if (result.trackingNumber) {
      await pool.query(
        `UPDATE orders
         SET tracking_number = ?, courier = ?,
             current_location_checkpoint = CONCAT('Carrier AWB Booked (', ?, ') — Ready for Handover')
         WHERE id = ?`,
        [result.trackingNumber, result.serviceName || provider, result.trackingNumber, orderId]
      );
    }

    const bookedLabel = await getShippingLabel(labelId);
    res.status(201).json({
      success: true,
      message: `Booked ${provider.toUpperCase()} label${result.trackingNumber ? ` (AWB: ${result.trackingNumber})` : ''}!`,
      label: bookedLabel,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// 10. SHIPPING ZONES & CARRIER CONFIGURATION (PORTED FROM ADMIN PANEL)
router.get('/shipping/zones', authenticateInventoryStaff, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM shipping_zones ORDER BY id ASC').catch(() => [[]]);
    res.json({ success: true, zones: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/shipping/zones/save', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const { id, name, regions, base_charge, is_active = 1 } = req.body || {};
    if (!name || !regions) {
      return res.status(400).json({ success: false, message: 'Zone name and regions are required.' });
    }
    if (id) {
      await pool.query(
        'UPDATE shipping_zones SET name = ?, regions = ?, base_charge = ?, is_active = ? WHERE id = ?',
        [name, regions, Number(base_charge) || 0, is_active ? 1 : 0, id]
      );
    } else {
      await pool.query(
        'INSERT INTO shipping_zones (name, regions, base_charge, is_active) VALUES (?, ?, ?, ?)',
        [name, regions, Number(base_charge) || 0, is_active ? 1 : 0]
      );
    }
    res.json({ success: true, message: `Shipping zone "${name}" saved.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/shipping/zones/:id', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    await pool.query('DELETE FROM shipping_zones WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Shipping zone deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/shipping/carriers/:provider', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const { provider } = req.params;
    if (!PROVIDERS.includes(provider)) {
      return res.status(404).json({ success: false, message: 'Unsupported carrier.' });
    }
    const result = await saveAndTestCarrierConfiguration(provider, req.body || {}, req.invUser.id || 1);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// 11. MOBILE QR CODE SCANNER API & LIVE POS CART BRIDGE (FOR ANDROID SCANNER APP)
router.post('/scanner/pair', authenticateInventoryStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode);
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    const rotate = req.body?.rotate === true || req.body?.rotate === 'true';
    const staffUsername = req.body?.operatorUsername || req.invUser?.username || 'admin';
    const staffName = req.body?.operatorName || req.invUser?.fullName || staffUsername;

    // Keep the pairing within its 12-hour window unless an administrator rotates the key.
    const [[existing]] = await pool.query(
      `SELECT session_code, api_key, device_name, created_at, expires_at 
       FROM inventory_scanner_devices 
       WHERE session_code = ?`,
      [sessionCode]
    );

    const now = Date.now();
    const isStillValid = existing && existing.api_key && (!existing.expires_at || new Date(existing.expires_at).getTime() > now);

    if (isStillValid && !rotate) {
      const expiresAt = existing.expires_at ? new Date(existing.expires_at).toISOString() : new Date(now + 12 * 60 * 60 * 1000).toISOString();
      const hoursRemaining = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / (60 * 60 * 1000)));
      const memState = touchScannerSessionActivity(sessionCode, {
        apiKey: existing.api_key,
        deviceName: existing.device_name,
        staffUsername,
        staffName,
        expiresAt,
      });
      return res.json({
        success: true,
        connected: true,
        resumed: true,
        scannerApiKey: existing.api_key,
        sessionCode,
        deviceName: existing.device_name,
        staffUsername: memState.staffUsername,
        staffName: memState.staffName,
        expiresAt,
        hoursRemaining,
        idleTimeoutMinutes: 10,
        idleTimeoutSeconds: 600,
        idleExpiresAt: new Date(memState.idleExpiresAt).toISOString(),
        isExisting: true,
        draft: memState.draftCache || null,
        queue: memState.queueCache || [],
        message: `Scanner connected & resumed on ${sessionCode} (Auto-disconnects after 10m of inactivity to save SQL/RAM).`,
      });
    }

    const scannerApiKey = `BV-SCAN-${crypto.randomBytes(24).toString('hex').toUpperCase()}`;
    const deviceName = String(req.body?.deviceName || 'Bhumivera POS Scanner').trim().slice(0, 120);
    const apiKeyHash = crypto.createHash('sha256').update(scannerApiKey).digest('hex');
    const expiresAt = new Date(now + 12 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO inventory_scanner_devices (session_code, api_key_hash, api_key, device_name, paired_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON DUPLICATE KEY UPDATE api_key_hash = VALUES(api_key_hash), api_key = VALUES(api_key),
                               device_name = VALUES(device_name), paired_by = VALUES(paired_by),
                               created_at = CURRENT_TIMESTAMP, expires_at = VALUES(expires_at)`,
      [sessionCode, apiKeyHash, scannerApiKey, deviceName, req.invUser.username, expiresAt]
    );
    const memState = touchScannerSessionActivity(sessionCode, {
      apiKey: scannerApiKey,
      deviceName,
      staffUsername,
      staffName,
      expiresAt: expiresAt.toISOString(),
    });
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'SCANNER_DEVICE_PAIRED',
      summary: `Connected mobile scanner "${deviceName}" to POS terminal ${sessionCode} (10m idle auto-sleep enabled).`,
    });
    res.json({
      success: true,
      connected: true,
      resumed: false,
      scannerApiKey,
      sessionCode,
      deviceName,
      staffUsername: memState.staffUsername,
      staffName: memState.staffName,
      expiresAt: expiresAt.toISOString(),
      hoursRemaining: 12,
      idleTimeoutMinutes: 10,
      idleTimeoutSeconds: 600,
      idleExpiresAt: new Date(memState.idleExpiresAt).toISOString(),
      isExisting: false,
      message: 'Scanner paired & connected (Auto-terminates after 10 minutes of inactivity; resumes from exact state on reconnect).',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Explicit On-Demand Connect / Resume & Disconnect Endpoints (Saves SQL & RAM when idle)
router.post('/scanner/connect', authenticateScannerOrStaff, async (req, res) => {
  try {
    const operator = resolveRequestOperator(req);
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || operator.sessionCode || 'DEFAULT-POS-TERMINAL');
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    const memState = touchScannerSessionActivity(sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
      deviceName: req.body?.deviceName,
    });
    if (!memState.queueCache) {
      const [rows] = await pool
        .query("SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC", [sessionCode])
        .catch(() => [[]]);
      memState.queueCache = rows || [];
    }
    if (!memState.draftCache) {
      const [[dRow]] = await pool
        .query('SELECT draft_json FROM inventory_pos_drafts WHERE session_code = ?', [sessionCode])
        .catch(() => [[]]);
      if (dRow?.draft_json) memState.draftCache = parseJsonSafe(dRow.draft_json, null);
    }
    res.json({
      success: true,
      connected: true,
      resumed: true,
      sessionCode,
      staffUsername: memState.staffUsername,
      staffName: memState.staffName,
      idleTimeoutMinutes: 10,
      idleTimeoutSeconds: 600,
      idleExpiresAt: new Date(memState.idleExpiresAt).toISOString(),
      stateVersion: memState.stateVersion || 1,
      queue: memState.queueCache || [],
      draft: memState.draftCache || null,
      drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
      message: `Connected to session ${sessionCode} and restored your saved state. Connection will auto-pause after 10 minutes of inactivity.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/reconnect', authenticateScannerOrStaff, async (req, res) => {
  try {
    const operator = resolveRequestOperator(req);
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || operator.sessionCode || 'DEFAULT-POS-TERMINAL');
    const memState = touchScannerSessionActivity(sessionCode, {
      staffUsername: operator.username,
      staffName: operator.name,
      deviceName: req.body?.deviceName,
    });
    res.json({
      success: true,
      connected: true,
      resumed: true,
      sessionCode,
      staffUsername: memState.staffUsername,
      staffName: memState.staffName,
      idleTimeoutMinutes: 10,
      idleTimeoutSeconds: 600,
      idleExpiresAt: new Date(memState.idleExpiresAt).toISOString(),
      stateVersion: memState.stateVersion || 1,
      queue: memState.queueCache || [],
      draft: memState.draftCache || null,
      drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
      message: `Resumed session ${sessionCode} from exact previous state.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/disconnect', authenticateScannerOrStaff, async (req, res) => {
  try {
    const operator = resolveRequestOperator(req);
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || operator.sessionCode || 'DEFAULT-POS-TERMINAL');
    const memState = scannerSessionsMemory.get(sessionCode);
    if (memState) {
      memState.connected = false;
      memState.idleDisconnected = false;
    }
    res.json({
      success: true,
      connected: false,
      sessionCode,
      message: `Scanner session ${sessionCode} disconnected to save SQL & memory. Your bill and drafts remain saved for when you reconnect.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/scanner/status', authenticateScannerOrStaff, async (req, res) => {
  const sessionCode = normalizePosSessionCode(req.query?.sessionCode || req.invUser?.scannerSessionCode || 'DEFAULT-POS-TERMINAL');
  const memState = checkScannerSessionIdleStatus(sessionCode);
  const now = Date.now();
  const connected = Boolean(memState?.connected && memState?.idleExpiresAt > now);
  const remainingSeconds = connected ? Math.max(0, Math.ceil((memState.idleExpiresAt - now) / 1000)) : 0;
  res.json({
    success: true,
    connected,
    idleDisconnected: Boolean(memState?.idleDisconnected),
    sessionCode,
    staffUsername: memState?.staffUsername || req.invUser?.username || 'admin',
    staffName: memState?.staffName || req.invUser?.fullName || 'Staff',
    remainingIdleSeconds: remainingSeconds,
    idleExpiresAt: connected ? new Date(memState.idleExpiresAt).toISOString() : null,
    stateVersion: memState?.stateVersion || 1,
  });
});

router.get('/scanner/ping', authenticateScannerOrStaff, async (req, res) => {
  const sessionCode = normalizePosSessionCode(req.query?.sessionCode || req.invUser?.scannerSessionCode || 'DEFAULT-POS-TERMINAL');
  const memState = touchScannerSessionActivity(sessionCode, {});
  res.json({
    success: true,
    connected: true,
    status: 'ONLINE',
    sessionCode,
    idleTimeoutMinutes: 10,
    idleTimeoutSeconds: 600,
    idleExpiresAt: new Date(memState.idleExpiresAt).toISOString(),
    serverTime: new Date().toISOString(),
    service: 'BhumiVera Ultra-Fast Scanner API (10x Accelerated • 10m Idle Auto-Sleep)',
  });
});

router.get('/scanner/catalog', authenticateScannerOrStaff, async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT m.id AS meta_id,
             m.product_id,
             COALESCE(p.name, m.custom_name) AS name,
             m.sku,
             m.barcode,
             p.slug,
             p.category,
             COALESCE(p.price, m.selling_price) AS mrp,
             COALESCE(p.discount_price, m.selling_price) AS price,
             COALESCE(m.gst_rate, 0) AS gst_rate,
             COALESCE(m.gst_hsn_code, '30049011') AS gst_hsn_code,
             COALESCE(p.quantity, m.physical_stock, 0) AS available_stock,
             m.bin_code,
             m.rack_location,
             m.batch_no,
             m.uom,
             CONCAT('https://www.bhumivera.com/verify?sku=', m.sku, '&batch=', COALESCE(m.batch_no, 'BV-BATCH-2026')) AS verify_url,
             CONCAT('https://www.bhumivera.com/product/', COALESCE(p.slug, '')) AS product_url
      FROM inventory_product_meta m
      LEFT JOIN products p ON m.product_id = p.id
      ORDER BY m.id ASC
    `);

    const lookupMap = {};
    rows.forEach(item => {
      item.standalone_qr_payload = buildStandaloneProductQr(item.sku);
      if (item.sku) {
        lookupMap[item.sku.toLowerCase()] = item;
        lookupMap[`bv-qr:${item.sku.toLowerCase()}`] = item;
        lookupMap[`bv:${item.sku.toLowerCase()}`] = item;
      }
      if (item.barcode) lookupMap[item.barcode.toLowerCase()] = item;
      if (item.slug) lookupMap[item.slug.toLowerCase()] = item;
      if (item.batch_no) lookupMap[item.batch_no.toLowerCase()] = item;
    });

    res.json({
      success: true,
      count: rows.length,
      syncedAt: new Date().toISOString(),
      items: rows,
      lookupMap,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/lookup', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { code, qrCode } = req.body || {};
    const queryCode = code || qrCode || req.query.code;
    if (!queryCode) {
      return res.status(400).json({ success: false, message: 'Missing code or qrCode parameter.' });
    }
    const item = await resolveProductByQrOrCode(pool, queryCode);
    if (!item) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: `No Bhumivera product matched "${queryCode}".`,
      });
    }
    res.json({
      success: true,
      item,
      message: `Resolved "${item.name}" (Live Stock: ${item.availableStock}).`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/scanner/config', authenticateInventoryStaff, async (req, res) => {
  try {
    const [[cfg]] = await pool.query('SELECT scanner_api_key, store_name FROM inventory_store_config WHERE id = 1');
    const sessionCode = normalizePosSessionCode(req.query.sessionCode || 'DEFAULT-POS-TERMINAL');
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });

    const [[dev]] = await pool.query(
      'SELECT api_key, device_name, created_at, expires_at FROM inventory_scanner_devices WHERE session_code = ?',
      [sessionCode]
    );

    const pairingExpired = Boolean(dev?.expires_at && new Date(dev.expires_at).getTime() <= Date.now());
    let activeKey = pairingExpired ? '' : (dev?.api_key || '');
    const expiresAt = pairingExpired ? null : (dev?.expires_at ? new Date(dev.expires_at).toISOString() : null);
    const hoursRemaining = expiresAt
      ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (60 * 60 * 1000)))
      : 0;

    if (!activeKey && !pairingExpired && sessionCode === 'DEFAULT-POS-TERMINAL') {
      activeKey = cfg?.scanner_api_key || 'BV-SCAN-DEFAULT';
    }

    const [queueRows] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [sessionCode]
    );
    res.json({
      success: true,
      scannerApiKey: activeKey,
      sessionCode,
      deviceName: dev?.device_name || 'Bhumivera POS Scanner',
      expiresAt,
      hoursRemaining,
      pairingExpired,
      scanEndpoint: '/api/inventory-software/scanner/scan',
      queueEndpoint: '/api/inventory-software/scanner/queue',
      queue: queueRows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/regenerate-key', authenticateInventoryStaff, requirePermission('can_manage_store_settings'), async (req, res) => {
  try {
    const newKey = 'BV-SCAN-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    await pool.query('UPDATE inventory_store_config SET scanner_api_key = ? WHERE id = 1', [newKey]);
    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'SCANNER_KEY_ROTATED',
      summary: `Regenerated Mobile QR Scanner API Key for Android Scanner App pairing.`,
    });
    res.json({
      success: true,
      scannerApiKey: newKey,
      message: 'Generated new Mobile QR Scanner API Key.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/inventory-software/scanner/scan
 * Called by either the future Android Mobile QR Scanner App (via x-scanner-api-key)
 * or the in-browser QR/Barcode input in /inventorysoftware.
 * Supports single scan ({ qrCode, quantity: 1 }) or batch scan ({ items: [{ qrCode, quantity }] }).
 */
router.post('/scanner/scan', scannerScanLimiter, authenticateScannerOrStaff, async (req, res) => {
  try {
    const {
      qrCode,
      sku,
      barcode,
      serialNumber,
      quantity = 1,
      items: batchScanItems,
      sessionCode = 'DEFAULT-POS-TERMINAL',
      deviceName = 'Android QR Scanner App',
    } = req.body || {};

    const rawEntries =
      Array.isArray(batchScanItems) && batchScanItems.length > 0
        ? batchScanItems
        : [{ qrCode: qrCode || serialNumber || barcode || sku, quantity }];
    const safeSessionCode = normalizePosSessionCode(sessionCode);
    if (!safeSessionCode) {
      return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    }

    const resolvedList = [];
    for (const entry of rawEntries) {
      const code = entry.qrCode || entry.serialNumber || entry.barcode || entry.sku;
      const qty = Math.max(1, Math.trunc(Number(entry.quantity || 1)));
      const item = await resolveProductByQrOrCode(pool, code);
      if (!item) {
        return res.status(404).json({
          success: false,
          code: 'QR_PRODUCT_NOT_FOUND',
          message: `No Bhumivera product found matching QR/Code "${code}".`,
        });
      }
      if (item.availableStock < qty) {
        return res.status(409).json({
          success: false,
          code: 'INSUFFICIENT_STOCK_ON_SCAN',
          message: `Insufficient stock for "${item.name}". Available: ${item.availableStock}, Scanned: ${qty}.`,
        });
      }

      // Check if this SKU is already queued in the active POS session
      const [existingRows] = await pool.query(
        `SELECT * FROM inventory_scanner_queue
         WHERE session_code = ? AND sku = ? AND status = 'queued'
         LIMIT 1`,
        [safeSessionCode, item.sku]
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        const nextQty = Math.min(item.availableStock, Number(existing.quantity) + qty);
        await pool.query(
          'UPDATE inventory_scanner_queue SET quantity = ?, available_stock = ?, qr_payload = ? WHERE id = ?',
          [nextQty, item.availableStock, String(code).slice(0, 255), existing.id]
        );
        resolvedList.push({ ...item, queueId: existing.id, quantity: nextQty });
      } else {
        const [ins] = await pool.query(
          `INSERT INTO inventory_scanner_queue
            (session_code, qr_payload, meta_id, product_id, sku, barcode, serial_number, product_name,
             unit_price, mrp, gst_hsn_code, gst_rate, uom, quantity, available_stock, scanned_by, device_name, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
          [
            safeSessionCode,
            String(code).slice(0, 255),
            item.metaId,
            item.productId,
            item.sku,
            item.barcode,
            item.serialNumber,
            item.name,
            item.price,
            item.mrp,
            item.gstHsnCode,
            item.gstRate,
            item.uom,
            qty,
            item.availableStock,
            req.invUser?.username || 'mobile-scanner',
            deviceName,
          ]
        );
        resolvedList.push({ ...item, queueId: ins.insertId, quantity: qty });
      }
    }

    const [updatedQueue] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [safeSessionCode]
    );
    const memSessionAfterScan = touchScannerSessionActivity(safeSessionCode, { bumpVersion: true });
    memSessionAfterScan.queueCache = updatedQueue;

    res.status(201).json({
      success: true,
      message: `Scanned ${resolvedList.map(i => `${i.name} (×${i.quantity})`).join(', ')} into POS Billing Queue!`,
      scanned: resolvedList,
      lowStock: resolvedList
        .filter(i => Number(i.availableStock) - Number(i.quantity) <= 5)
        .map(i => ({ sku: i.sku, name: i.name, remaining: Math.max(0, Number(i.availableStock) - Number(i.quantity)) })),
      queue: updatedQueue,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/scanner/queue', authenticateScannerOrStaff, async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.query.sessionCode);
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    const memState = checkScannerSessionIdleStatus(sessionCode);
    if (memState && !memState.connected && req.query.resume !== 'true') {
      return res.status(408).json({
        success: false,
        connected: false,
        idleDisconnected: true,
        code: 'SCANNER_IDLE_TIMEOUT',
        sessionCode,
        queue: memState.queueCache || [],
        message: 'Scanner connection paused after 10 minutes of inactivity to save SQL & memory. Click Connect / Resume to continue.',
      });
    }
    // Serve from in-memory cache when available so background polling uses ZERO SQL queries!
    if (memState && Array.isArray(memState.queueCache) && req.query.forceSql !== 'true') {
      const now = Date.now();
      return res.json({
        success: true,
        connected: true,
        sessionCode,
        stateVersion: memState.stateVersion || 1,
        remainingIdleSeconds: memState.idleExpiresAt ? Math.max(0, Math.ceil((memState.idleExpiresAt - now) / 1000)) : 600,
        idleExpiresAt: memState.idleExpiresAt ? new Date(memState.idleExpiresAt).toISOString() : null,
        queue: memState.queueCache,
        drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
      });
    }
    const [rows] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [sessionCode]
    );
    const activeState = getOrCreateScannerSessionState(sessionCode, { connected: true });
    activeState.queueCache = rows;
    res.json({
      success: true,
      connected: true,
      sessionCode,
      stateVersion: activeState.stateVersion || 1,
      remainingIdleSeconds: activeState.idleExpiresAt ? Math.max(0, Math.ceil((activeState.idleExpiresAt - Date.now()) / 1000)) : 600,
      idleExpiresAt: activeState.idleExpiresAt ? new Date(activeState.idleExpiresAt).toISOString() : null,
      queue: rows,
      drafts: Array.from(savedPosDraftsMemory.values()).filter(d => d.status !== 'completed'),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/queue/consume', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { ids = [], clearAll = false } = req.body || {};
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || 'DEFAULT-POS-TERMINAL');
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    if (clearAll) {
      await pool.query(
        "UPDATE inventory_scanner_queue SET status = 'consumed' WHERE session_code = ? AND status = 'queued'",
        [sessionCode]
      );
    } else if (Array.isArray(ids) && ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      await pool.query(
        `UPDATE inventory_scanner_queue SET status = 'consumed'
         WHERE session_code = ? AND status = 'queued' AND id IN (${ph})`,
        [sessionCode, ...ids]
      );
    }
    const memConsume = touchScannerSessionActivity(sessionCode, { bumpVersion: true });
    memConsume.queueCache = null;
    res.json({ success: true, message: 'Scanner queue synced with POS cart.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// REAL-TIME 2-WAY SYNC: Add or Update single item quantity in active session queue
router.post('/scanner/queue/item', authenticateScannerOrStaff, async (req, res) => {
  try {
    const {
      sessionCode: requestedSessionCode = 'DEFAULT-POS-TERMINAL',
      sku,
      metaId,
      quantity,
      delta,
      price,
      name,
      availableStock,
    } = req.body || {};
    const sessionCode = normalizePosSessionCode(requestedSessionCode);
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });

    if (!sku && !metaId) {
      return res.status(400).json({ success: false, message: 'SKU or metaId required' });
    }

    const [existingRows] = await pool.query(
      `SELECT * FROM inventory_scanner_queue
       WHERE session_code = ? AND status = 'queued' AND (sku = ? OR (meta_id = ? AND meta_id IS NOT NULL))
       LIMIT 1`,
      [sessionCode, sku || '', metaId || 0]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      let newQty = Number(existing.quantity);
      if (delta !== undefined && delta !== null) {
        newQty += Number(delta);
      } else if (quantity !== undefined && quantity !== null) {
        newQty = Number(quantity);
      }

      if (newQty <= 0) {
        await pool.query(
          "DELETE FROM inventory_scanner_queue WHERE session_code = ? AND id = ? AND status = 'queued'",
          [sessionCode, existing.id]
        );
      } else {
        const maxStock = existing.available_stock > 0 ? existing.available_stock : 9999;
        newQty = Math.min(newQty, maxStock);
        await pool.query(
          "UPDATE inventory_scanner_queue SET quantity = ? WHERE session_code = ? AND id = ? AND status = 'queued'",
          [newQty, sessionCode, existing.id]
        );
      }
    } else {
      const reqQty = delta !== undefined && delta !== null ? Number(delta) : Number(quantity || 1);
      if (reqQty > 0) {
        let item = await resolveProductByQrOrCode(pool, sku || String(metaId));
        if (!item && metaId) {
          const [metaRows] = await pool.query('SELECT * FROM inventory_product_meta WHERE id = ?', [metaId]);
          if (metaRows.length > 0) {
            const m = metaRows[0];
            item = {
              metaId: m.id,
              productId: m.product_id,
              sku: m.sku,
              barcode: m.barcode,
              serialNumber: null,
              name: m.custom_name || name || 'Product',
              price: Number(m.selling_price || price || 0),
              mrp: Number(m.selling_price || 0),
              gstHsnCode: m.gst_hsn_code || '30049011',
              gstRate: Number(m.gst_rate || 5),
              uom: m.uom || 'Pcs',
              availableStock: Number(m.physical_stock || availableStock || 99),
            };
          }
        }

        if (item) {
          await pool.query(
            `INSERT INTO inventory_scanner_queue
              (session_code, qr_payload, meta_id, product_id, sku, barcode, serial_number, product_name,
               unit_price, mrp, gst_hsn_code, gst_rate, uom, quantity, available_stock, scanned_by, device_name, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, ?, ?, ?, ?, 'POS Sync', 'queued')`,
            [
              sessionCode,
              item.sku,
              item.metaId,
              item.productId,
              item.sku,
              item.barcode,
              item.serialNumber,
              item.name,
              item.price,
              item.mrp,
              item.gstHsnCode,
              item.uom,
              reqQty,
              item.availableStock,
              req.invUser?.username || 'sync-agent',
            ]
          );
        }
      }
    }

    const [updatedQueue] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [sessionCode]
    );
    const memItem = touchScannerSessionActivity(sessionCode, { bumpVersion: true });
    memItem.queueCache = updatedQueue;

    res.json({ success: true, queue: updatedQueue });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// REAL-TIME 2-WAY SYNC: Remove item from active session queue
router.post('/scanner/queue/remove', authenticateScannerOrStaff, async (req, res) => {
  try {
    const { id, sku, metaId } = req.body || {};
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || 'DEFAULT-POS-TERMINAL');
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    if (id) {
      await pool.query(
        "DELETE FROM inventory_scanner_queue WHERE session_code = ? AND id = ? AND status = 'queued'",
        [sessionCode, id]
      );
    } else if (sku) {
      await pool.query("DELETE FROM inventory_scanner_queue WHERE session_code = ? AND sku = ? AND status = 'queued'", [sessionCode, sku]);
    } else if (metaId) {
      await pool.query("DELETE FROM inventory_scanner_queue WHERE session_code = ? AND meta_id = ? AND status = 'queued'", [sessionCode, metaId]);
    }

    const [updatedQueue] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [sessionCode]
    );
    const memRem = touchScannerSessionActivity(sessionCode, { bumpVersion: true });
    memRem.queueCache = updatedQueue;
    res.json({ success: true, queue: updatedQueue });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// REAL-TIME 2-WAY SYNC: Clear active session queue
router.post('/scanner/queue/clear', authenticateScannerOrStaff, async (req, res) => {
  try {
    const sessionCode = normalizePosSessionCode(req.body?.sessionCode || 'DEFAULT-POS-TERMINAL');
    if (!sessionCode) return res.status(400).json({ success: false, message: 'A valid terminal session is required.' });
    await pool.query("DELETE FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued'", [sessionCode]);
    const memClr = touchScannerSessionActivity(sessionCode, { bumpVersion: true });
    memClr.queueCache = [];
    res.json({ success: true, message: 'Queue cleared', queue: [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 12. DAILY SQL & FULL DATABASE DISASTER RECOVERY BACKUP ENGINE (VERCEL + RAILWAY SYNC)
router.get('/backup/list', authenticateInventoryStaff, async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, backup_code, backup_date, trigger_type, tables_count, rows_count,
             size_bytes, checksum_sha512, created_by, created_at
      FROM system_daily_backups
      ORDER BY created_at DESC
      LIMIT 15
    `);
    res.json({ success: true, backups: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/backup/create', authenticateInventoryStaff, requirePermission('can_export_data'), async (req, res) => {
  try {
    const triggerType = req.body?.triggerType === 'ON_UPDATE' ? 'ON_UPDATE' : 'MANUAL';
    const backup = await generateFullDatabaseBackup(pool, {
      triggerType,
      actorUsername: req.invUser.username,
      saveToVault: true,
    });

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'DAILY_SQL_BACKUP_CREATED',
      summary: `Generated full Railway MySQL + Vercel snapshot backup ${backup.backupCode} (${backup.tablesCount} tables, ${backup.rowsCount} rows).`,
    });

    res.status(201).json({
      success: true,
      message: `Full SQL & JSON Backup "${backup.backupCode}" created (${backup.tablesCount} tables, ${backup.rowsCount} records)!`,
      backup: {
        id: backup.id,
        backup_code: backup.backupCode,
        backup_date: backup.backupDate,
        trigger_type: backup.triggerType,
        tables_count: backup.tablesCount,
        rows_count: backup.rowsCount,
        size_bytes: backup.sizeBytes,
        checksum_sha512: backup.checksumSha512,
        created_at: backup.exportedAt,
      },
      sqlDump: req.body?.includePayload ? backup.sqlDump : undefined,
      snapshotObj: req.body?.includePayload ? backup.snapshotObj : undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/backup/download/:id', authenticateInventoryStaff, requirePermission('can_export_data'), async (req, res) => {
  try {
    const format = String(req.query.format || 'sql').toLowerCase();
    const targetId = req.params.id;

    let backupCode = '';
    let sqlDump = '';
    let snapshotJson = '';

    if (targetId === 'latest') {
      const fresh = await generateFullDatabaseBackup(pool, {
        triggerType: 'MANUAL',
        actorUsername: req.invUser.username,
        saveToVault: true,
      });
      backupCode = fresh.backupCode;
      sqlDump = fresh.sqlDump;
      snapshotJson = JSON.stringify(fresh.snapshotObj, null, 2);
    } else {
      const [[row]] = await pool.query('SELECT * FROM system_daily_backups WHERE id = ?', [Number(targetId)]);
      if (!row) {
        return res.status(404).json({ success: false, message: 'Backup record not found.' });
      }
      backupCode = row.backup_code;
      sqlDump = row.sql_dump;
      snapshotJson = row.snapshot_json;
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${backupCode}.avbak.json"`);
      return res.send(snapshotJson);
    }

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupCode}.sql"`);
    return res.send(sqlDump);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/backup/restore', authenticateInventoryStaff, requirePermission('can_export_data'), async (req, res) => {
  try {
    const { backupId, snapshotObj, sqlDump } = req.body || {};
    const result = await restoreFullDatabaseBackup(pool, {
      backupId,
      snapshotObj,
      sqlDump,
      actorUsername: req.invUser.username,
    });

    res.json({
      success: true,
      message: `Disaster Recovery Restore Complete! Restored ${result.restoredRows} records across ${result.restoredTables} tables from ${result.sourceLabel}. Railway SQL & Vercel Storefront are 100% synced!`,
      result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// Cron / Webhook endpoint for automated daily backups on Vercel & Railway
router.all('/backup/cron-daily', async (req, res) => {
  try {
    await ensureInventorySoftwareTables(pool);
    const backup = await ensureDailyAutoBackup(pool, 'vercel-railway-cron');
    res.json({
      success: true,
      message: 'Daily SQL & Snapshot backup verified and synced.',
      backup,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 13. STORE CONFIGURATION
router.put('/config', authenticateInventoryStaff, requirePermission('can_manage_store_settings'), async (req, res) => {
  try {
    const {
      storeName,
      tagline,
      address,
      phone,
      email,
      website,
      gstin,
      upiId,
      taxRate,
      autoSyncWebsite,
      posHoldReservation,
      cats,
      hid,
      logo,
    } = req.body || {};

    await pool.query(
      `UPDATE inventory_store_config
       SET store_name = COALESCE(?, store_name),
           tagline = COALESCE(?, tagline),
           address = COALESCE(?, address),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           website = COALESCE(?, website),
           gstin = COALESCE(?, gstin),
           upi_id = COALESCE(?, upi_id),
           default_tax_rate = COALESCE(?, default_tax_rate),
           auto_sync_website = COALESCE(?, auto_sync_website),
           pos_hold_reservation = COALESCE(?, pos_hold_reservation),
           categories_json = COALESCE(?, categories_json),
           hidden_widgets_json = COALESCE(?, hidden_widgets_json),
           logo_url = COALESCE(?, logo_url)
       WHERE id = 1`,
      [
        storeName ?? null,
        tagline ?? null,
        address ?? null,
        phone ?? null,
        email ?? null,
        website ?? null,
        gstin ?? null,
        upiId ?? null,
        taxRate !== undefined ? Number(taxRate) : null,
        autoSyncWebsite !== undefined ? (autoSyncWebsite ? 1 : 0) : null,
        posHoldReservation !== undefined ? (posHoldReservation ? 1 : 0) : null,
        Array.isArray(cats) ? JSON.stringify(cats) : null,
        Array.isArray(hid) ? JSON.stringify(hid) : null,
        logo ?? null,
      ]
    );

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'STORE_CONFIG_UPDATE',
      summary: `Updated Store & Billing Configuration (${storeName || 'Bhumivera'}).`,
    });

    res.json({ success: true, message: 'Store & Billing settings saved.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
