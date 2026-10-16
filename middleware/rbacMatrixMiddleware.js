'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const {
  SUPERADMIN_EMAIL,
  PLATFORM_MODULES_CATALOG,
  ensureSuperAdminFortressTables,
  verifyStepUpActionPasscode,
} = require('../models/superAdminVaultModel');
const { verifyCsrfToken } = require('../utils/fortressCrypto');

function parseCookieHeader(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function extractSuperAdminToken(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookies = parseCookieHeader(req.headers?.cookie);
  if (cookies.bv_sa_session) {
    return cookies.bv_sa_session;
  }
  return null;
}

/**
 * Authenticates the Supreme SuperAdmin (`adminbhumivera27@gmail.com`) for `/superadmin/controlcentre`.
 */
async function authenticateSuperAdminControlCentre(req, res, next) {
  const rawToken = extractSuperAdminToken(req);
  if (!rawToken) {
    return res.status(401).json({
      code: 'SUPERADMIN_AUTH_REQUIRED',
      message: 'SuperAdmin Control Centre authentication is required.',
    });
  }

  try {
    const payload = jwt.verify(rawToken, process.env.JWT_SECRET || 'fallback_secret');
    const normalizedEmail = String(payload?.email || '').trim().toLowerCase();
    if (
      payload?.role !== 'superadmin' ||
      (normalizedEmail && normalizedEmail !== SUPERADMIN_EMAIL && payload?.scope === 'superadmin-controlcentre')
    ) {
      return res.status(403).json({
        code: 'SUPERADMIN_EXCLUSIVE_ACCESS',
        message: 'Access restricted exclusively to the Supreme SuperAdmin.',
      });
    }

    // Verify CSRF token if provided on mutating requests with cookie auth
    const csrfHeader = req.headers['x-csrf-token'];
    if (csrfHeader && payload.jti && !verifyCsrfToken(String(csrfHeader), payload.jti)) {
      return res.status(403).json({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Invalid security CSRF token. Refresh the Control Centre and try again.',
      });
    }

    req.superAdmin = {
      id: payload.id || 1,
      email: SUPERADMIN_EMAIL,
      role: 'superadmin',
      jti: payload.jti || null,
    };
    req.admin = req.superAdmin;
    req.user = req.superAdmin;
    return next();
  } catch {
    return res.status(401).json({
      code: 'SUPERADMIN_SESSION_EXPIRED',
      message: 'Your SuperAdmin Control Centre session has expired. Please authenticate again.',
    });
  }
}

/**
 * Requires and verifies the 6-Digit Master Action Passcode on sensitive or destructive operations.
 */
function requireStepUpPasscode(actionCode = 'SENSITIVE_OPERATION') {
  return async (req, res, next) => {
    try {
      const candidatePasscode =
        req.headers['x-superadmin-action-passcode'] ||
        req.body?.actionPasscode ||
        req.query?.actionPasscode ||
        '';

      const result = await verifyStepUpActionPasscode(pool, candidatePasscode, {
        actionCode,
        targetEntity: req.originalUrl,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      if (!result.valid) {
        return res.status(403).json({
          success: false,
          code: result.code || 'STEP_UP_PASSCODE_INVALID',
          requiresStepUpPasscode: true,
          message: result.message || 'Valid 6-Digit Master Action Passcode is required to execute this action.',
        });
      }

      return next();
    } catch (error) {
      console.error('[STEP_UP_PASSCODE_VERIFY_ERR]', error);
      return res.status(500).json({
        success: false,
        code: 'STEP_UP_VERIFY_ERROR',
        message: 'Could not verify Master Action Passcode.',
      });
    }
  };
}

/**
 * Enforces dynamic per-user module permissions (`hidden`, `read`, `write`, `full`)
 * for staff accounts stored in `staff_accounts` / `staff_module_permissions`.
 * SuperAdmin (`adminbhumivera27@gmail.com` / `role === 'superadmin'`) always has unrestricted `full` control.
 */
async function enforceDynamicRbacMatrix(req, res, next) {
  try {
    const actor = req.user || req.admin || req.supportAgent;
    if (!actor) return next();

    const actorEmail = String(actor.email || '').trim().toLowerCase();
    if (actor.role === 'superadmin' || actorEmail === SUPERADMIN_EMAIL) {
      return next();
    }

    const requestPath = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/{2,}/g, '/');
    const method = String(req.method || 'GET').toUpperCase();

    // Match request path against PLATFORM_MODULES_CATALOG
    const matchedModule = PLATFORM_MODULES_CATALOG.find(mod =>
      Array.isArray(mod.apiPrefixes) &&
      mod.apiPrefixes.some(prefix => requestPath === prefix || requestPath.startsWith(`${prefix}/`))
    );
    if (!matchedModule) return next();

    await ensureSuperAdminFortressTables(pool);
    const [staffRows] = await pool.query(
      'SELECT id, is_active FROM staff_accounts WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1',
      [actorEmail || '__none__', String(actor.username || '').trim().toLowerCase() || '__none__']
    );
    const staff = staffRows?.[0];
    if (!staff) return next();

    if (!staff.is_active) {
      return res.status(403).json({
        code: 'STAFF_ACCOUNT_SUSPENDED',
        message: 'Your staff account has been suspended by the SuperAdmin.',
      });
    }

    const [permRows] = await pool.query(
      'SELECT access_level FROM staff_module_permissions WHERE staff_id = ? AND module_key = ? LIMIT 1',
      [staff.id, matchedModule.key]
    );
    const accessLevel = permRows?.[0]?.access_level || 'read';

    if (accessLevel === 'hidden') {
      return res.status(403).json({
        code: 'RBAC_MODULE_HIDDEN',
        moduleKey: matchedModule.key,
        message: `Access to '${matchedModule.title}' is disabled for your staff profile.`,
      });
    }

    if (accessLevel === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return res.status(403).json({
        code: 'RBAC_READ_ONLY',
        moduleKey: matchedModule.key,
        message: `Your profile has Read-Only access to '${matchedModule.title}'. Creating, editing, or deleting records requires Write or Full Control.`,
      });
    }

    if (accessLevel === 'write' && method === 'DELETE') {
      return res.status(403).json({
        code: 'RBAC_FULL_CONTROL_REQUIRED',
        moduleKey: matchedModule.key,
        message: `Deleting records in '${matchedModule.title}' requires Full Control privileges.`,
      });
    }

    return next();
  } catch {
    return next();
  }
}

module.exports = {
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode,
  enforceDynamicRbacMatrix,
  parseCookieHeader,
};
