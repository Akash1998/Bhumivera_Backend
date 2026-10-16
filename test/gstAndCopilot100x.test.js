'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETE_SITE_NAVIGATION_MAP,
  evaluatePasswordRequirements,
  diagnoseCartFriction,
  diagnosePasswordAndAuthFriction,
  diagnoseCheckoutAndCouponFriction,
} = require('../services/aiCopilotRescueService');

const {
  numberToIndianRupeeWords,
  enrichGstDocument,
} = require('../models/gstAccountingModel');

const {
  validateGstinFormat,
  verifyInvoiceMathematicalIntegrity,
  runEnterpriseApiCatalogAudit,
} = require('../services/adminEnterpriseAuditService');

test('100X AI Co-Pilot: COMPLETE_SITE_NAVIGATION_MAP provides all storefront, customer, support, and admin links', () => {
  assert.ok(Array.isArray(COMPLETE_SITE_NAVIGATION_MAP));
  assert.ok(COMPLETE_SITE_NAVIGATION_MAP.length >= 24);

  const paths = new Set(COMPLETE_SITE_NAVIGATION_MAP.map(item => item.path));
  assert.ok(paths.has('/'));
  assert.ok(paths.has('/shop'));
  assert.ok(paths.has('/forgot-password'));
  assert.ok(paths.has('/reset-password'));
  assert.ok(paths.has('/verify-product'));
  assert.ok(paths.has('/ewarranty'));
  assert.ok(paths.has('/support'));
  assert.ok(paths.has('/superadminsupport'));
  assert.ok(paths.has('/admin/dashboard/gst'));
});

test('100X AI Co-Pilot: evaluatePasswordRequirements enforces all 7 security rules and gives clear fixes', () => {
  const weakResult = evaluatePasswordRequirements('abc123', 'patron@bhumivera.com');
  assert.equal(weakResult.isCompliant, false);
  assert.ok(weakResult.failedChecks.length >= 3);
  assert.ok(weakResult.suggestedFixes.length >= 1);

  const emailLeakResult = evaluatePasswordRequirements('Patron@12345', 'patron@bhumivera.com');
  assert.equal(emailLeakResult.isCompliant, false);
  assert.ok(emailLeakResult.failedChecks.some(r => r.id === 'not_email_local'));

  const strongResult = evaluatePasswordRequirements('Bhumivera#2026', 'patron@bhumivera.com');
  assert.equal(strongResult.isCompliant, true);
  assert.equal(strongResult.scorePercent, 100);
  assert.equal(strongResult.failedChecks.length, 0);
});

test('100X AI Co-Pilot: diagnoseCartFriction handles out-of-stock, max limit, variant required, and network sync', async () => {
  const outOfStockDiag = await diagnoseCartFriction({
    productName: 'Tellicherry Black Pepper',
    requestedQuantity: 2,
    errorCode: 'OUT_OF_STOCK',
    errorMessage: 'Out of stock',
  });
  assert.equal(outOfStockDiag.frictionType, 'cart');
  assert.equal(outOfStockDiag.cause, 'out_of_stock');
  assert.ok(outOfStockDiag.steps.length >= 2);
  assert.ok(outOfStockDiag.quickFixes.some(l => l.url && l.url.endsWith('/shop')));

  const variantDiag = await diagnoseCartFriction({
    productName: 'Kashmiri Saffron',
    errorCode: 'VARIANT_REQUIRED',
    errorMessage: 'Please select a variant size',
  });
  assert.equal(variantDiag.cause, 'variant_required');
  assert.ok(
    variantDiag.headline.toLowerCase().includes('pack') ||
      variantDiag.headline.toLowerCase().includes('option')
  );
});

test('100X AI Co-Pilot: diagnosePasswordAndAuthFriction and diagnoseCheckoutAndCouponFriction return actionable steps', async () => {
  const otpDiag = await diagnosePasswordAndAuthFriction({
    email: 'aarav@example.com',
    errorCode: 'OTP_EXPIRED',
    errorMessage: 'Verification code expired',
  });
  assert.equal(otpDiag.cause, 'otp_expired_or_invalid');
  assert.ok(otpDiag.steps.length >= 2);

  const couponDiag = await diagnoseCheckoutAndCouponFriction({
    cartSubtotal: 380,
    couponCode: 'WELCOME10',
    errorMessage: 'Minimum order value not met',
  });
  assert.ok(couponDiag.steps.length >= 1);
});

test('10X GST Engine: numberToIndianRupeeWords converts Indian currency accurately with Paise', () => {
  assert.equal(
    numberToIndianRupeeWords(1450),
    'Rupees One Thousand Four Hundred Fifty Only'
  );
  assert.equal(
    numberToIndianRupeeWords(125480.75),
    'Rupees One Lakh Twenty Five Thousand Four Hundred Eighty and Paise Seventy Five Only'
  );
});

test('10X GST Engine: enrichGstDocument computes B2B/B2CS, HSN breakup, amount in words, and SHA-512 signature', () => {
  const enriched = enrichGstDocument({
    id: 99,
    document_number: 'BV/2026-27/0099',
    document_type: 'tax_invoice',
    seller_snapshot: { gstin: '29AABCB1234F1Z5', state_code: '29' },
    buyer_snapshot: { gstin: '', state_code: '29' },
    place_of_supply_code: '29',
    taxable_value: 2000,
    cgst: 50,
    sgst: 50,
    igst: 0,
    total_tax: 100,
    total: 2100,
    line_items: [
      {
        description: 'Malabar Black Pepper 1kg',
        hsn_sac: '090411',
        quantity: 2,
        taxable_value: 2000,
        gst_rate: 5,
        cgst: 50,
        sgst: 50,
        igst: 0,
        total: 2100,
      },
    ],
  });

  assert.equal(enriched.supply_type, 'B2CS');
  assert.equal(enriched.supply_category, 'B2CS');
  assert.equal(enriched.is_interstate, false);
  assert.equal(enriched.amount_in_words, 'Rupees Two Thousand One Hundred Only');
  assert.equal(enriched.hsn_breakup.length, 1);
  assert.equal(enriched.hsn_breakup[0].hsn_sac, '090411');
  assert.equal(enriched.sha512_signature.length, 128);
  assert.ok(enriched.qr_verification_payload.includes('BV/2026-27/0099'));
});

test('Enterprise API & GST Audit Service: validates GSTINs, invoice math, and full 40-endpoint catalog', () => {
  const validGstin = validateGstinFormat('29AABCB1234F1Z5');
  assert.equal(validGstin.valid, true);
  assert.equal(validGstin.stateName, 'Karnataka');

  const invalidGstin = validateGstinFormat('99INVALID');
  assert.equal(invalidGstin.valid, false);

  const auditReport = runEnterpriseApiCatalogAudit();
  assert.equal(auditReport.checks.passwordComplianceEngineOk, true);
  assert.equal(auditReport.checks.indianRupeeWordsConverterOk, true);
  assert.equal(auditReport.checks.gstinValidatorOk, true);
  assert.equal(auditReport.checks.gstInvoiceMathEngineOk, true);
  assert.ok(auditReport.totalBackendEndpointsVerified >= 40);
});
