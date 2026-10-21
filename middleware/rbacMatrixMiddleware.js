'use strict';

const pool = require('../config/db');
const {
  SUPERADMIN_EMAIL,
  PLATFORM_MODULES_CATALOG,
  ensureSuperAdminFortressTables,
} = require('../models/superAdminVaultModel');

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
  enforceDynamicRbacMatrix,
};
