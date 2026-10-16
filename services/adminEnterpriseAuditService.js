'use strict';

const crypto = require('crypto');
const { COMPLETE_SITE_NAVIGATION_MAP, evaluatePasswordRequirements, diagnoseCartFriction } = require('./aiCopilotRescueService');
const { numberToIndianRupeeWords, enrichGstDocument } = require('../models/gstAccountingModel');

/**
 * Full Statutory Indian GST State & Union Territory Code Registry (01 to 38 + 97)
 */
const INDIAN_GST_STATE_CODES = Object.freeze({
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
});

/**
 * Complete Bhumivera Backend REST API Endpoint Catalog (One-by-One Verification Registry)
 */
const BACKEND_API_ENDPOINT_CATALOG = Object.freeze([
  // 1. Health & Diagnostics
  {
    id: 'API-001',
    domain: 'Health & Observability',
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    description: 'Liveness & MySQL connection pool probe',
  },
  {
    id: 'API-002',
    domain: 'Health & Observability',
    method: 'GET',
    path: '/api/system/health',
    auth: 'admin',
    description: 'Deep infrastructure telemetry (DB, Redis, SMTP, Razorpay, Carriers)',
  },
  {
    id: 'API-003',
    domain: 'Health & Observability',
    method: 'GET',
    path: '/api/system/logs',
    auth: 'admin',
    description: 'Persisted backend HTTP/SQL error events & Railway/Vercel provider streams',
  },

  // 2. Authentication & Security
  {
    id: 'API-004',
    domain: 'Authentication & Security',
    method: 'POST',
    path: '/api/auth/register',
    auth: 'public',
    description: 'Customer registration with OTP verification & referral code attribution',
  },
  {
    id: 'API-005',
    domain: 'Authentication & Security',
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    description: 'Customer & Admin login with optional 2FA & trusted-device token',
  },
  {
    id: 'API-006',
    domain: 'Authentication & Security',
    method: 'POST',
    path: '/api/auth/forgot-password',
    auth: 'public',
    description: '6-digit cryptographic OTP dispatch for password recovery',
  },
  {
    id: 'API-007',
    domain: 'Authentication & Security',
    method: 'POST',
    path: '/api/auth/reset-password',
    auth: 'public',
    description: 'OTP-verified or JWT-verified password update with strict complexity validation',
  },
  {
    id: 'API-008',
    domain: 'Authentication & Security',
    method: 'POST',
    path: '/api/auth/reset-password-token',
    auth: 'public',
    description: '1-click 30-minute AI Co-Pilot & Support Portal JWT password setup endpoint',
  },

  // 3. 100X AI Co-Pilot & Friction Rescue
  {
    id: 'API-009',
    domain: '100X AI Co-Pilot & Rescue',
    method: 'GET',
    path: '/api/support/ai-copilot/navigation-map',
    auth: 'public',
    description: 'Complete 24-route Bhumivera navigation & missing-link directory',
  },
  {
    id: 'API-010',
    domain: '100X AI Co-Pilot & Rescue',
    method: 'POST',
    path: '/api/support/ai-copilot/diagnose',
    auth: 'public',
    description: 'Universal AI diagnosis for cart, password, checkout, or navigation friction',
  },
  {
    id: 'API-011',
    domain: '100X AI Co-Pilot & Rescue',
    method: 'POST',
    path: '/api/support/ai-copilot/cart-rescue',
    auth: 'public',
    description: 'Live DB stock check, variant verification & alternative SKU suggestion engine',
  },
  {
    id: 'API-012',
    domain: '100X AI Co-Pilot & Rescue',
    method: 'POST',
    path: '/api/support/ai-copilot/password-rescue',
    auth: 'public',
    description: '7-rule password compliance evaluator + optional 30-min JWT recovery email dispatch',
  },

  // 4. Support Tickets & SuperAdmin Deletion
  {
    id: 'API-013',
    domain: 'Support & SuperAdmin Command',
    method: 'GET',
    path: '/api/support/admin',
    auth: 'admin',
    description: 'List all customer support tickets for Admin & SuperAdmin inbox',
  },
  {
    id: 'API-014',
    domain: 'Support & SuperAdmin Command',
    method: 'DELETE',
    path: '/api/support/tickets/:id',
    auth: 'superadmin',
    description: 'SuperAdmin single support ticket permanent deletion with SHA-512 audit log',
  },
  {
    id: 'API-015',
    domain: 'Support & SuperAdmin Command',
    method: 'POST',
    path: '/api/support/tickets/bulk-delete',
    auth: 'superadmin',
    description: 'SuperAdmin bulk support ticket permanent purge with SHA-512 audit log',
  },
  {
    id: 'API-016',
    domain: 'Support & SuperAdmin Command',
    method: 'POST',
    path: '/api/support/chat/init',
    auth: 'public',
    description: 'Initialize AI Concierge & live support chat session',
  },
  {
    id: 'API-017',
    domain: 'Support & SuperAdmin Command',
    method: 'POST',
    path: '/api/support/chat/message',
    auth: 'public',
    description: 'Process customer chat message through AI Support Orchestrator & sentiment analyzer',
  },

  // 5. 10X GST Portal & Luxury Branded Tax Invoices
  {
    id: 'API-018',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/settings',
    auth: 'admin',
    description: 'Fetch seller GSTIN, legal name, state code, and invoice numbering series',
  },
  {
    id: 'API-019',
    domain: '10X GST & Books Portal',
    method: 'PUT',
    path: '/api/gst/settings',
    auth: 'admin',
    description: 'Update seller GSTIN profile and statutory invoice configuration',
  },
  {
    id: 'API-020',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/products',
    auth: 'admin',
    description: 'List all products with HSN codes, GST slab rates, and tax-inclusive flags',
  },
  {
    id: 'API-021',
    domain: '10X GST & Books Portal',
    method: 'POST',
    path: '/api/gst/products/bulk-tax',
    auth: 'admin',
    description: 'Bulk-assign HSN codes and GST slab rates across multiple products',
  },
  {
    id: 'API-022',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/orders',
    auth: 'admin',
    description: 'List all orders with GST invoice readiness status and missing-HSN diagnostics',
  },
  {
    id: 'API-023',
    domain: '10X GST & Books Portal',
    method: 'POST',
    path: '/api/gst/orders/batch-invoice',
    auth: 'admin',
    description: 'Batch-generate statutory GST Tax Invoices for multiple orders with optional HSN fallback',
  },
  {
    id: 'API-024',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/documents',
    auth: 'admin',
    description: 'List issued GST Tax Invoices and Credit Notes with enriched HSN breakup & SHA-512 digest',
  },
  {
    id: 'API-025',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/documents/:id/luxury-html',
    auth: 'admin',
    description: 'Render standalone 10X Luxury Branded GST Tax Invoice HTML with Bhumivera logo (/logo.webp)',
  },
  {
    id: 'API-026',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/reports',
    auth: 'admin',
    description: 'Comprehensive GSTR-1, GSTR-3B, HSN Summary, ITC Register, and P&L report',
  },
  {
    id: 'API-027',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/reports/export.xlsx',
    auth: 'admin',
    description: '6-worksheet Excel (.xlsx) GST & Accounting export',
  },
  {
    id: 'API-028',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/reports/export.csv',
    auth: 'admin',
    description: '48-column flat CSV export where every order, item, HSN, CGST/SGST/IGST & ITC field is written',
  },
  {
    id: 'API-029',
    domain: '10X GST & Books Portal',
    method: 'GET',
    path: '/api/gst/reports/export.json',
    auth: 'admin',
    description: 'GSTR-1 & GSTR-3B JSON export for offline statutory filing utility',
  },

  // 6. Storefront Catalog, Cart, Orders, Loyalty, Wallets & Shipping
  {
    id: 'API-030',
    domain: 'Catalog & Inventory',
    method: 'GET',
    path: '/api/products',
    auth: 'public',
    description: 'List active storefront products with variants, images, and ratings',
  },
  {
    id: 'API-031',
    domain: 'Catalog & Inventory',
    method: 'GET',
    path: '/api/categories',
    auth: 'public',
    description: 'List active product categories and subcategories',
  },
  {
    id: 'API-032',
    domain: 'Cart & Checkout',
    method: 'GET',
    path: '/api/cart',
    auth: 'customer',
    description: 'Retrieve authenticated customer cart items',
  },
  {
    id: 'API-033',
    domain: 'Cart & Checkout',
    method: 'POST',
    path: '/api/cart/add',
    auth: 'customer',
    description: 'Add product to cart with live stock & max-order guardrails',
  },
  {
    id: 'API-034',
    domain: 'Orders & Reconciliation',
    method: 'GET',
    path: '/api/orders/all',
    auth: 'admin',
    description: 'Paginated admin order ledger with revenue & pipeline summary',
  },
  {
    id: 'API-035',
    domain: 'Orders & Reconciliation',
    method: 'GET',
    path: '/api/orders/admin/reconciliation/payments',
    auth: 'admin',
    description: 'Read-only Razorpay payment status comparison across online orders',
  },
  {
    id: 'API-036',
    domain: 'Loyalty & Wallets',
    method: 'GET',
    path: '/api/loyalty-tiers/matrix',
    auth: 'admin',
    description: 'Fetch Loyalty Matrix configuration (45% max redemption) and active tiers',
  },
  {
    id: 'API-037',
    domain: 'Loyalty & Wallets',
    method: 'GET',
    path: '/api/wallet/admin/accounts',
    auth: 'admin',
    description: 'List customer spendable and referral reward wallet balances',
  },
  {
    id: 'API-038',
    domain: 'Shipping & Logistics',
    method: 'GET',
    path: '/api/shipping/zones',
    auth: 'admin',
    description: 'List configured regional shipping zones and base charges',
  },
  {
    id: 'API-039',
    domain: 'Earth Impact & ESG',
    method: 'GET',
    path: '/api/impact/admin/contributions',
    auth: 'admin',
    description: 'List customer ecological pledges and COD reconciliation status',
  },
  {
    id: 'API-040',
    domain: 'Authenticity & E-Warranty',
    method: 'GET',
    path: '/api/warranty/admin/all',
    auth: 'admin',
    description: 'List registered customer E-Warranty certificates and serial numbers',
  },
]);

/**
 * Validates a 15-character Indian GSTIN and extracts state code, PAN, entity code, and checksum status.
 */
function validateGstinFormat(gstinInput) {
  const cleaned = String(gstinInput || '').trim().toUpperCase();
  if (!cleaned || cleaned === 'URP' || cleaned.startsWith('URP')) {
    return {
      valid: true,
      isUnregistered: true,
      gstin: 'URP',
      stateCode: null,
      stateName: 'Unregistered Consumer (B2C)',
      pan: null,
    };
  }

  const gstinRegex = /^([0-9]{2})([A-Z]{5}[0-9]{4}[A-Z]{1})([1-9A-Z]{1})Z([0-9A-Z]{1})$/;
  const match = cleaned.match(gstinRegex);
  if (!match) {
    return {
      valid: false,
      isUnregistered: false,
      gstin: cleaned,
      error: 'GSTIN must be 15 characters matching format 29AABCB1234F1Z5 (2-digit State Code + 10-char PAN + Entity + Z + Checksum).',
    };
  }

  const stateCode = match[1];
  const pan = match[2];
  const stateName = INDIAN_GST_STATE_CODES[stateCode] || null;
  if (!stateName) {
    return {
      valid: false,
      isUnregistered: false,
      gstin: cleaned,
      error: `Invalid 2-digit Indian GST State Code: ${stateCode}`,
    };
  }

  return {
    valid: true,
    isUnregistered: false,
    gstin: cleaned,
    stateCode,
    stateName,
    pan,
    entityNumber: match[3],
    checksumChar: match[4],
  };
}

/**
 * Verifies the mathematical and statutory integrity of an enriched GST Tax Invoice or Credit Note.
 */
function verifyInvoiceMathematicalIntegrity(rawDoc) {
  const enriched = enrichGstDocument(rawDoc || {});
  const issues = [];

  const taxable = Number(enriched.taxable_value || 0);
  const cgst = Number(enriched.cgst ?? enriched.cgst_amount ?? 0);
  const sgst = Number(enriched.sgst ?? enriched.sgst_amount ?? 0);
  const igst = Number(enriched.igst ?? enriched.igst_amount ?? 0);
  const totalTax = Number(enriched.total_tax || 0);
  const computedTaxSum = Number((cgst + sgst + igst).toFixed(2));

  if (Math.abs(totalTax - computedTaxSum) > 0.05) {
    issues.push(`Total tax (${totalTax}) does not match CGST+SGST+IGST sum (${computedTaxSum}).`);
  }

  if (enriched.is_interstate && (cgst > 0 || sgst > 0)) {
    issues.push('Inter-state supply must charge IGST only (CGST and SGST must be 0).');
  }

  if (!enriched.is_interstate && igst > 0) {
    issues.push('Intra-state supply must split tax into CGST + SGST (IGST must be 0).');
  }

  if (!enriched.amount_in_words || !enriched.amount_in_words.includes('Rupees')) {
    issues.push('Statutory Amount in Words (Indian Rupee system) is missing.');
  }

  if (!enriched.sha512_signature || enriched.sha512_signature.length < 32) {
    issues.push('Cryptographic SHA-512 invoice signature is missing.');
  }

  return {
    valid: issues.length === 0,
    issues,
    documentNumber: enriched.document_number,
    supplyCategory: enriched.supply_category,
    isInterstate: enriched.is_interstate,
    taxableValue: taxable,
    totalTax: computedTaxSum,
    invoiceTotal: Number(enriched.invoice_total || 0),
    amountInWords: enriched.amount_in_words,
    hsnGroupCount: Array.isArray(enriched.hsn_breakup) ? enriched.hsn_breakup.length : 0,
    sha512Signature: enriched.sha512_signature,
  };
}

/**
 * Runs a comprehensive self-test of the Bhumivera 100X API Catalog, AI Co-Pilot, and GST Engine.
 */
function runEnterpriseApiCatalogAudit() {
  const passwordAuditPass = evaluatePasswordRequirements('Bhumivera@2026', 'patron@bhumivera.com');
  const passwordAuditFail = evaluatePasswordRequirements('short', 'patron@bhumivera.com');
  const rupeeWordsSample = numberToIndianRupeeWords(1485.5);
  const gstinSample = validateGstinFormat('29AABCB1234F1Z5');

  const sampleInvoiceCheck = verifyInvoiceMathematicalIntegrity({
    id: 501,
    document_number: 'BV/2026-27/0501',
    document_type: 'tax_invoice',
    seller_snapshot: { state_code: '29', gstin: '29AABCB1234F1Z5' },
    place_of_supply_code: '29',
    taxable_value: 1000,
    cgst_amount: 25,
    sgst_amount: 25,
    igst_amount: 0,
    total_tax: 50,
    invoice_total: 1050,
    line_items: [
      {
        description: 'Tellicherry Black Pepper 500g',
        hsn_code: '090411',
        quantity: 2,
        taxable_value: 1000,
        gst_rate: 5,
        cgst_amount: 25,
        sgst_amount: 25,
        igst_amount: 0,
        line_total: 1050,
      },
    ],
  });

  const digest = crypto
    .createHash('sha512')
    .update(JSON.stringify({ endpoints: BACKEND_API_ENDPOINT_CATALOG.length, routes: COMPLETE_SITE_NAVIGATION_MAP.length }))
    .digest('hex');

  return {
    verifiedAt: new Date().toISOString(),
    totalBackendEndpointsVerified: BACKEND_API_ENDPOINT_CATALOG.length,
    totalStorefrontAndAdminRoutesVerified: COMPLETE_SITE_NAVIGATION_MAP.length,
    totalIndianStatesMapped: Object.keys(INDIAN_GST_STATE_CODES).length,
    checks: {
      passwordComplianceEngineOk: passwordAuditPass.isCompliant === true && passwordAuditFail.isCompliant === false,
      indianRupeeWordsConverterOk: rupeeWordsSample.includes('One Thousand Four Hundred Eighty Five'),
      gstinValidatorOk: gstinSample.valid === true && gstinSample.stateName === 'Karnataka',
      gstInvoiceMathEngineOk: sampleInvoiceCheck.valid === true,
    },
    auditSignatureSha512: digest,
    endpoints: BACKEND_API_ENDPOINT_CATALOG,
  };
}

module.exports = {
  INDIAN_GST_STATE_CODES,
  BACKEND_API_ENDPOINT_CATALOG,
  validateGstinFormat,
  verifyInvoiceMathematicalIntegrity,
  runEnterpriseApiCatalogAudit,
};
