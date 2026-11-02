const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VALID_INVENTORY_ROLES,
  INVENTORY_PERMISSION_DEFINITIONS,
  resolveInventoryPermissions,
  generateTotpSecret,
  verifyTotpCode,
} = require('../models/inventorySoftwareModel');

test('resolveInventoryPermissions grants all permissions when full_all_access or admin role', () => {
  const perms = resolveInventoryPermissions('keeper', { full_all_access: true });
  assert.equal(perms.full_all_access, true);
  for (const key of Object.keys(INVENTORY_PERMISSION_DEFINITIONS)) {
    assert.equal(perms[key], true, `Expected ${key} to be true under full_all_access`);
  }

  const adminPerms = resolveInventoryPermissions('admin', {});
  assert.equal(adminPerms.full_all_access, true);
  for (const key of Object.keys(INVENTORY_PERMISSION_DEFINITIONS)) {
    assert.equal(adminPerms[key], true, `Expected ${key} to be true for admin`);
  }
});

test('resolveInventoryPermissions respects role defaults and custom overrides for cashier/keeper', () => {
  assert.ok(VALID_INVENTORY_ROLES.includes('cashier'));
  assert.ok(VALID_INVENTORY_ROLES.includes('keeper'));
  const cashierPerms = resolveInventoryPermissions('cashier', { can_void_invoices: true });
  assert.equal(cashierPerms.can_use_pos_billing, true);
  assert.equal(cashierPerms.can_void_invoices, true);
  assert.equal(cashierPerms.can_manage_store_settings, false);
});

test('generateTotpSecret and verifyTotpCode validate 6-digit RFC 6238 TOTP codes', () => {
  const secret = generateTotpSecret(20);
  assert.ok(secret.length >= 16);
  assert.equal(verifyTotpCode(secret, '000000'), false);
});
