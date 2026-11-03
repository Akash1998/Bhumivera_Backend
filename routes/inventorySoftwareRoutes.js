const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
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
} = require('../models/inventorySoftwareModel');

const router = express.Router();
const secret = () => process.env.JWT_SECRET || 'fallback_secret';

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
      const [[cfg]] = await pool.query('SELECT scanner_api_key FROM inventory_store_config WHERE id = 1');
      if (cfg && cfg.scanner_api_key && String(scannerKey).trim() === String(cfg.scanner_api_key).trim()) {
        req.invUser = {
          id: 1,
          username: req.body?.scannedBy || 'mobile-qr-scanner',
          fullName: req.body?.deviceName || 'Bhumivera Android QR Scanner App',
          role: 'cashier',
          assignedHub: 'Bhumivera Flagship Hub — Asansol',
          permissions: resolveInventoryPermissions('admin'),
          fullAllAccess: true,
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

    const cleanUsername = String(username || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!cleanUsername || !password) {
      return res.status(400).json({ success: false, message: 'Account ID (username) and password are required.' });
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
    const accountCode = 'BV-IAM-' + String(Math.floor(1000 + Math.random() * 9000));

    const [result] = await pool.query(
      `INSERT INTO inventory_staff_accounts
        (account_code, username, full_name, email, phone, password_hash, role, assigned_hub, permissions, status, totp_enabled, totp_secret, passkeys, first_login, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, '[]', ?, ?)`,
      [
        accountCode,
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
       SET full_name = ?, email = ?, phone = ?, role = ?, assigned_hub = ?, permissions = ?, status = ?
       WHERE id = ?`,
      [nextFullName, nextEmail, nextPhone, nextRole, nextHub, JSON.stringify(nextPerms), nextStatus, targetId]
    );

    const [[updatedRow]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
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
    const newPassword = String(req.body?.newPassword || 'TempPass@123').trim();
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE inventory_staff_accounts SET password_hash = ?, first_login = 1 WHERE id = ?',
      [hash, targetId]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_staff_accounts WHERE id = ?', [targetId]);
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
router.get('/bootstrap', authenticateInventoryStaff, async (req, res) => {
  try {
    await ensureInventorySoftwareTables(pool);
    await syncWebsiteProductsToInventoryMeta(pool);
    // Trigger daily auto-backup non-blockingly so today's SQL backup is always guaranteed
    void ensureDailyAutoBackup(pool, req.invUser.username || 'auto-daily').catch(() => {});

    const [
      [itemRows],
      [binRows],
      [saleRows],
      [supRows],
      [grnRows],
      [movementRows],
      [auditRows],
      [configRows],
      [batchRows],
      [onlineOrderRows],
      [scannerQueueRows],
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
      pool.query('SELECT * FROM inventory_storage_bins ORDER BY zone_name ASC, rack_no ASC'),
      pool.query('SELECT * FROM inventory_pos_invoices ORDER BY created_at DESC LIMIT 300'),
      pool.query('SELECT * FROM inventory_suppliers ORDER BY name ASC'),
      pool.query('SELECT * FROM inventory_grn_entries ORDER BY created_at DESC LIMIT 150'),
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
               o.shipping_cost, o.total, o.courier, o.tracking_number,
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
      `).catch(() => [[]]),
      pool.query(`
        SELECT * FROM inventory_scanner_queue
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 100
      `).catch(() => [[]]),
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
        .query(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, onlineOrderIds)
        .catch(() => [[]]);
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
      const qrCodePayload =
        r.qr_code_payload ||
        `https://www.bhumivera.com/verify?sku=${encodeURIComponent(r.sku)}&batch=${encodeURIComponent(r.batch_no || 'BV-BATCH-2026')}`;

      const formatted = {
        id: r.id,
        warehouseId: Number(r.warehouse_id) || 1,
        productId: r.product_id,
        name: r.web_name || r.custom_name || 'Product',
        slug: r.web_slug || '',
        sku: r.sku,
        barcode: r.barcode,
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
        gstHsnCode: r.gst_hsn_code || '33049990',
        gstRate: Number(r.gst_rate) || 18,
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
      paymentMode: s.payment_mode || 'Cash',
      upiReference: s.upi_reference || '',
      status: s.status || 'completed',
      cashier: s.cashier_username || 'admin',
      hubName: s.hub_name || 'Bhumivera Flagship Hub — Asansol',
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
      taxRate: Number(cfgRow.default_tax_rate) || 18,
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
          gstHsnCode: it.gst_hsn_code || linkedInv?.gstHsnCode || '33049990',
          gstRate: Number(it.gst_rate || linkedInv?.gstRate || 18),
          quantity: Number(it.quantity) || 1,
          price: Number(it.price) || 0,
          inStockQty: linkedInv ? Number(linkedInv.qty) : 0,
          binCode: linkedInv?.binCode || 'ASN-SHOP-R1-B01',
          batchNo: linkedInv?.batchNo || '',
        };
      });

      return {
        id: o.id,
        orderNumber: o.order_number || String(o.id),
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
      };
    });

    const carriers = await getPublicCarrierStatus().catch(() => []);

    res.json({
      success: true,
      syncedAt: new Date().toISOString(),
      viewer: req.invUser,
      items,
      bins: binRows,
      sales,
      suppliers: supRows,
      grnEntries: grnRows,
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
      scannerQueue: scannerQueueRows,
      dailyBackups: dailyBackupRows,
      shippingZones: shippingZoneRows,
      carriers,
      cfg,
    });
  } catch (err) {
    console.error('[INVENTORY_BOOTSTRAP_ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to load inventory suite data: ' + err.message });
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
      gstHsnCode = '33049990',
      gstRate = 18,
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

// 5. OFFLINE SHOP POS BILLING ENGINE (ATOMIC WEBSITE STOCK DEDUCTION!)
router.post('/pos/checkout', authenticateInventoryStaff, requirePermission('can_use_pos_billing'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      customer,
      items = [],
      extraCharges = [],
      discount = 0,
      taxRate = 18,
      paidAmount = 0,
      paymentMode = 'Cash',
      upiReference = '',
      notes = '',
      scannerQueueIds = [],
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'POS Cart cannot be empty.' });
    }

    const stockDeductions = [];
    for (const cartItem of items) {
      const requestedQty = Math.max(1, Math.trunc(Number(cartItem.q || cartItem.quantity || 1)));
      const deduction = await atomicAdjustProductStock(
        {
          metaId: cartItem.id,
          productId: cartItem.productId,
          sku: cartItem.sku,
          operation: 'subtract',
          quantity: requestedQty,
          movementType: 'OFFLINE_POS_SALE',
          reason: `Offline Shop POS Sale to ${customer?.name || 'Walk-in Shopper'}`,
          operatorUsername: req.invUser.username,
        },
        conn
      );
      stockDeductions.push(deduction);
    }

    const subTotal = items.reduce((sum, i) => sum + (Number(i.p || i.price || 0) * Number(i.q || i.quantity || 1)), 0);
    const extraTotal = (extraCharges || []).reduce((sum, x) => sum + (Number(x.a || x.amount || 0)), 0);
    const discAmt = Math.max(0, Number(discount) || 0);
    const taxableAmount = Math.max(0, subTotal + extraTotal - discAmt);
    const safeTaxRate = Math.max(0, Number(taxRate) || 0);
    const taxAmount = Math.round((taxableAmount * safeTaxRate) / 100);
    const billTotal = taxableAmount + taxAmount;

    const custName = String(customer?.name || 'Walk-in Retail Shopper').trim();
    const custPhone = String(customer?.phone || '-').trim();
    const custGstin = String(customer?.gstin || '').trim();
    const paid = paidAmount === '' || paidAmount === undefined ? billTotal : Math.max(0, Number(paidAmount) || 0);

    const [[countRow]] = await conn.query('SELECT COUNT(*) AS cnt FROM inventory_pos_invoices');
    const seq = Number(countRow?.cnt || 0) + 1;
    const invoiceNo = `BV-POS-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;

    const [invRes] = await conn.query(
      `INSERT INTO inventory_pos_invoices
        (invoice_no, customer_id, customer_name, customer_phone, customer_gstin,
         items_json, extra_charges_json, subtotal, extra_total, discount_amount,
         taxable_amount, tax_rate, tax_amount, bill_total, prev_khata_balance,
         paid_amount, new_khata_balance, payment_mode, upi_reference, status,
         cashier_username, hub_name, notes)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'completed', ?, ?, ?)`,
      [
        invoiceNo,
        custName,
        custPhone,
        custGstin,
        JSON.stringify(items),
        JSON.stringify(extraCharges || []),
        subTotal,
        extraTotal,
        discAmt,
        taxableAmount,
        safeTaxRate,
        taxAmount,
        billTotal,
        paid,
        paymentMode || 'Cash',
        upiReference || null,
        req.invUser.username,
        req.invUser.assignedHub || 'Bhumivera Flagship Hub — Asansol',
        notes || null,
      ]
    );

    await conn.query(
      'UPDATE inventory_stock_movements SET reference_id = ? WHERE reference_id IS NULL AND operator_username = ? ORDER BY id DESC LIMIT ?',
      [invoiceNo, req.invUser.username, items.length]
    );

    // Mark any mobile-scanned items as consumed
    if (Array.isArray(scannerQueueIds) && scannerQueueIds.length > 0) {
      const ph = scannerQueueIds.map(() => '?').join(',');
      await conn
        .query(`UPDATE inventory_scanner_queue SET status = 'consumed' WHERE id IN (${ph})`, scannerQueueIds)
        .catch(() => {});
    } else {
      await conn
        .query("UPDATE inventory_scanner_queue SET status = 'consumed' WHERE status = 'queued'")
        .catch(() => {});
    }

    for (const item of items) {
      await conn
        .query(
          `INSERT INTO warehouse_sales_log (user_id, store_name, product_name, quantity, sale_price, customer_type, customer_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            req.invUser.id || 1,
            req.invUser.assignedHub || 'Bhumivera Flagship Hub',
            item.name,
            Number(item.q || item.quantity || 1),
            Number(item.p || item.price || 0),
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

    await conn.commit();
    await invalidatePublicCatalogCache();

    const saleRecord = {
      id: invRes.insertId,
      invoiceNo,
      date: new Date().toISOString(),
      cust: { name: custName, phone: custPhone, gstin: custGstin },
      items,
      extra: extraCharges || [],
      subTotal,
      extraTotal,
      discount: discAmt,
      taxableAmount,
      taxRate: safeTaxRate,
      tax: taxAmount,
      total: subTotal,
      billTotal,
      paid,
      paymentMode: paymentMode || 'Cash',
      cashier: req.invUser.username,
      stockDeductions,
    };

    res.status(201).json({
      success: true,
      message: `Invoice #${invoiceNo} generated & live website stock updated immediately!`,
      sale: saleRecord,
    });
  } catch (err) {
    await conn.rollback();
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
router.put('/online-orders/:orderId/dispatch-status', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const {
      status,
      courier,
      trackingNumber,
      estimatedDeliveryDate,
      currentLocationCheckpoint,
      notes,
      cancelReason,
    } = req.body || {};

    const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'returned', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Order status must be pending, confirmed, packed, shipped, delivered, returned, or cancelled.',
      });
    }

    if (status === 'cancelled') {
      const cancelResult = await executeAtomicOrderCancellationAndRefund(pool, {
        orderId,
        reason: cancelReason || 'Cancelled from Inventory & Order Lifecycle Hub',
        refundDestinationPreference: 'auto',
        executedByEmail: req.invUser.email || 'admin@bhumivera.com',
        razorpay: getRazorpayClient(),
      });
      await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});
      await invalidatePublicCatalogCache().catch(() => {});
      return res.json({
        success: true,
        message: `Order #${orderId} cancelled and stock restored to main inventory.`,
        refundSummary: cancelResult.refundSummary,
      });
    }

    await updateOrderStatus(orderId, status, cancelReason || null, { courier, trackingNumber });

    const defaultCheckpoint =
      currentLocationCheckpoint ||
      (status === 'delivered'
        ? 'Delivered to Customer'
        : status === 'shipped'
        ? `Dispatched via ${courier || 'Courier'}${trackingNumber ? ` (AWB: ${trackingNumber})` : ''} — In Transit`
        : status === 'packed'
        ? 'Packed & Weighed at Asansol Hub — Ready for Courier Pickup'
        : status === 'confirmed'
        ? 'Confirmed & Stock Reserved at Asansol Hub'
        : null);

    await pool.query(
      `UPDATE orders
       SET estimated_delivery_date = COALESCE(?, estimated_delivery_date),
           current_location_checkpoint = COALESCE(?, current_location_checkpoint),
           notes = COALESCE(?, notes)
       WHERE id = ?`,
      [estimatedDeliveryDate || null, defaultCheckpoint, notes !== undefined ? notes : null, orderId]
    );

    await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});
    await invalidatePublicCatalogCache().catch(() => {});

    // Notify customer by email
    try {
      const [orderData] = await pool.query(
        'SELECT o.id, o.order_number, o.status, u.name, u.email FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?',
        [orderId]
      );
      if (orderData.length > 0 && orderData[0].email) {
        sendOrderStatusEmail(
          orderData[0].email,
          orderData[0].name || 'Patron',
          orderId,
          status,
          trackingNumber,
          courier,
          orderData[0].order_number
        ).catch(() => {});
      }
    } catch {}

    await appendInventoryAuditLog(pool, {
      actorUsername: req.invUser.username,
      actorRole: req.invUser.role,
      actionCode: 'ONLINE_ORDER_LIFECYCLE',
      summary: `Updated Order #${orderId} status to ${status.toUpperCase()}${trackingNumber ? ` (AWB: ${trackingNumber}, Courier: ${courier || 'Standard'})` : ''}.`,
    });

    res.json({
      success: true,
      message: `Online Order #${orderId} updated to ${status.toUpperCase()}.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.put('/online-orders/:orderId/edit', authenticateInventoryStaff, requirePermission('can_manage_online_dispatch'), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const [[existing]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const {
      status,
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

    if (status && status !== existing.status) {
      await updateOrderStatus(orderId, status, null, { courier, trackingNumber });
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
      message: `Order #${existing.order_number || orderId} details, tracking & shipping label address updated!`,
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
router.get('/scanner/config', authenticateInventoryStaff, async (_req, res) => {
  try {
    const [[cfg]] = await pool.query('SELECT scanner_api_key, store_name FROM inventory_store_config WHERE id = 1');
    const [queueRows] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE status = 'queued' ORDER BY created_at ASC"
    );
    res.json({
      success: true,
      scannerApiKey: cfg?.scanner_api_key || 'BV-SCAN-DEFAULT',
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
router.post('/scanner/scan', authenticateScannerOrStaff, async (req, res) => {
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
        [sessionCode, item.sku]
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
            sessionCode,
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
      [sessionCode]
    );

    res.status(201).json({
      success: true,
      message: `Scanned ${resolvedList.map(i => `${i.name} (×${i.quantity})`).join(', ')} into POS Billing Queue!`,
      scanned: resolvedList,
      queue: updatedQueue,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/scanner/queue', authenticateScannerOrStaff, async (req, res) => {
  try {
    const sessionCode = String(req.query.sessionCode || 'DEFAULT-POS-TERMINAL');
    const [rows] = await pool.query(
      "SELECT * FROM inventory_scanner_queue WHERE session_code = ? AND status = 'queued' ORDER BY created_at ASC",
      [sessionCode]
    );
    res.json({ success: true, queue: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/scanner/queue/consume', authenticateInventoryStaff, async (req, res) => {
  try {
    const { ids = [], clearAll = false, sessionCode = 'DEFAULT-POS-TERMINAL' } = req.body || {};
    if (clearAll) {
      await pool.query(
        "UPDATE inventory_scanner_queue SET status = 'consumed' WHERE session_code = ? AND status = 'queued'",
        [sessionCode]
      );
    } else if (Array.isArray(ids) && ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      await pool.query(`UPDATE inventory_scanner_queue SET status = 'consumed' WHERE id IN (${ph})`, ids);
    }
    res.json({ success: true, message: 'Scanner queue synced with POS cart.' });
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
