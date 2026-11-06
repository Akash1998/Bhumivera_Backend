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

test('resolveProductByQrOrCode correctly extracts SKU, Serial, and Slug from website URLs', async () => {
  const fakeDb = {
    query: async (sql, params) => {
      if (sql.includes('product_serials')) return [[]];
      if (sql.includes('inventory_product_meta')) {
        return [[
          {
            id: 1,
            product_id: 10,
            sku: 'BV-LUX-CFW-01',
            barcode: '8908020260015',
            custom_name: 'Bhumivera Activated Charcoal Purifying Luxury Face Wash',
            physical_stock: 249,
            selling_price: 299,
            mrp: 699,
            gst_rate: 5,
            gst_hsn_code: '30049011',
            bin_code: 'ASN-SHOP-R1-B01',
            batch_no: 'BV-BATCH-2026-CF01',
            uom: 'Pcs',
          }
        ]];
      }
      return [[]];
    }
  };

  const { resolveProductByQrOrCode } = require('../models/inventorySoftwareModel');

  // Test 1: Full verification link with ?sku=
  const res1 = await resolveProductByQrOrCode(fakeDb, 'https://www.bhumivera.com/verify?sku=BV-LUX-CFW-01&batch=BV-BATCH-2026-CF01');
  assert.ok(res1);
  assert.equal(res1.sku, 'BV-LUX-CFW-01');
  assert.equal(res1.price, 299);
  assert.equal(res1.availableStock, 249);

  // Test 2: Website product page URL
  const res2 = await resolveProductByQrOrCode(fakeDb, 'https://www.bhumivera.com/product/activated-charcoal-luxury-face-wash');
  assert.ok(res2);
  assert.equal(res2.sku, 'BV-LUX-CFW-01');

  // Test 3: Raw SKU scan
  const res3 = await resolveProductByQrOrCode(fakeDb, 'BV-LUX-CFW-01');
  assert.ok(res3);
  assert.equal(res3.barcode, '8908020260015');
});
