const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VALID_INVENTORY_ROLES,
  INVENTORY_PERMISSION_DEFINITIONS,
  resolveInventoryPermissions,
  generateTotpSecret,
  verifyTotpCode,
  calculateEstimatedDeliveryDate,
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

test('calculateEstimatedDeliveryDate computes automatic delivery date by destination region and speed', () => {
  const base = '2026-11-03T00:00:00.000Z';
  const wbDate = calculateEstimatedDeliveryDate({ state: 'West Bengal', city: 'Asansol', pincode: '713304' }, 'standard', base);
  const delhiDate = calculateEstimatedDeliveryDate({ state: 'Delhi', city: 'New Delhi', pincode: '110001' }, 'standard', base);
  const delhiExpress = calculateEstimatedDeliveryDate({ state: 'Delhi', city: 'New Delhi', pincode: '110001' }, 'express', base);

  assert.equal(wbDate, '2026-11-05'); // +2 days for WB
  assert.equal(delhiDate, '2026-11-07'); // +4 days for Metro Delhi
  assert.equal(delhiExpress, '2026-11-06'); // +3 days for Express Metro Delhi
});
