const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStandaloneProductQr,
  computeOptimalA4QrLayout,
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

test('generateWavePicklist groups orders and aggregates items by bin walk path', async () => {
  const { generateWavePicklist } = require('../models/inventorySoftwareModel');
  const fakeDb = {
    query: async () => [
      [
        { order_id: 101, product_id: 1, product_name: 'Face Wash', quantity: 2, sku: 'BV-FW-01', barcode: '111', bin_code: 'ASN-R1-B01', zone_name: 'Zone A', rack_no: '01', shelf_level: 'A' },
        { order_id: 102, product_id: 1, product_name: 'Face Wash', quantity: 3, sku: 'BV-FW-01', barcode: '111', bin_code: 'ASN-R1-B01', zone_name: 'Zone A', rack_no: '01', shelf_level: 'A' },
        { order_id: 102, product_id: 2, product_name: 'Shampoo', quantity: 1, sku: 'BV-SH-02', barcode: '222', bin_code: 'ASN-R2-B01', zone_name: 'Zone B', rack_no: '02', shelf_level: 'B' },
      ],
    ],
  };

  const picklist = await generateWavePicklist(fakeDb, [101, 102]);
  assert.ok(picklist.waveId.startsWith('WAVE-'));
  assert.equal(picklist.orderCount, 2);
  assert.equal(picklist.totalItemsToPick, 6); // 2 + 3 + 1 = 6
  assert.equal(picklist.totalUniqueSkus, 2);
  assert.equal(picklist.walkPath[0].sku, 'BV-FW-01');
  assert.equal(picklist.walkPath[0].totalPickQuantity, 5);
});

test('generateCarrierManifest includes only shipped orders with real tracking details', async () => {
  const { generateCarrierManifest } = require('../models/inventorySoftwareModel');
  const fakeDb = {
    query: async () => [
      [
        { id: 201, order_number: 'BV-ORD-201', status: 'shipped', courier: 'shiprocket', tracking_number: 'AWB-201', tracking_url: 'https://carrier.example/201', total: 1299, payment_mode: 'prepaid', address_snapshot: '{"city":"Asansol","pincode":"713304"}', customer_name: 'Alice', customer_phone: '9876543210' },
        { id: 202, order_number: 'BV-ORD-202', status: 'shipped', courier: 'shiprocket', tracking_number: 'AWB-202', tracking_url: 'https://carrier.example/202', total: 1499, payment_mode: 'cod', address_snapshot: '{"city":"Durgapur","pincode":"713201"}', customer_name: 'Bob', customer_phone: '9876543211' },
      ],
    ],
  };

  const manifest = await generateCarrierManifest(fakeDb, [201, 202], 'shiprocket', 'dispatcher_raj');
  assert.ok(manifest.manifestCode.startsWith('BV-MAN-'));
  assert.equal(manifest.totalShipments, 2);
  assert.equal(manifest.courier, 'shiprocket');
  assert.equal(manifest.generatedBy, 'dispatcher_raj');
  assert.equal(manifest.shipments[1].collectableAmount, 1499);
  assert.equal(manifest.shipments[1].trackingNumber, 'AWB-202');
  await assert.rejects(
    () => generateCarrierManifest({
      query: async () => [[{ id: 203, order_number: 'BV-ORD-203', status: 'packed' }]],
    }, [203], 'shiprocket', 'dispatcher_raj'),
    error => error.status === 409 && error.code === 'SHIPMENT_DETAILS_REQUIRED',
  );
});


test('buildStandaloneProductQr and computeOptimalA4QrLayout generate mobile-scannable A4 layouts', async () => {
  const qr = buildStandaloneProductQr('BV-LUX-CFW-01');
  assert.equal(qr, 'BV-QR:BV-LUX-CFW-01');

  const layout6 = computeOptimalA4QrLayout(6, true);
  assert.equal(layout6.totalCount, 6);
  assert.ok(layout6.qrSizeMm >= 24 && layout6.qrSizeMm <= 38, 'QR size must be clamped between 24mm and 38mm');

  const layout10 = computeOptimalA4QrLayout(10, true);
  assert.equal(layout10.totalCount, 10);
  assert.equal(layout10.totalPages, 1);
  assert.ok(layout10.qrSizeMm >= 24 && layout10.qrSizeMm <= 38);

  const layout20 = computeOptimalA4QrLayout(20, true);
  assert.equal(layout20.totalCount, 20);
  assert.equal(layout20.totalPages, 1);
  assert.ok(layout20.qrSizeMm >= 24 && layout20.qrSizeMm <= 38);

  const { resolveProductByQrOrCode } = require('../models/inventorySoftwareModel');
  const fakeDb = {
    query: async (sql) => {
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
  const resolvedStandalone = await resolveProductByQrOrCode(fakeDb, 'BV-QR:BV-LUX-CFW-01');
  assert.ok(resolvedStandalone);
  assert.equal(resolvedStandalone.sku, 'BV-LUX-CFW-01');
  assert.equal(resolvedStandalone.name, 'Bhumivera Activated Charcoal Purifying Luxury Face Wash');
});
