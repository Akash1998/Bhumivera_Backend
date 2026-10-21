const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const {
  INDIAN_STATE_NAMES,
  numberToIndianRupeeWords,
  enrichGstDocument,
  getBusinessProfile,
  updateBusinessProfile,
  getGstProducts,
  updateGstProduct,
  bulkUpdateGstProducts,
  listOrdersForInvoicing,
  getOrderForInvoice,
  listDocuments,
  getDocumentById,
  getExpenseById,
  listExpenses,
  listAuditEvents,
} = require('../models/gstAccountingModel');

const router = express.Router();
router.use(authenticateAdmin);
router.use((req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.admin?.role)) {
    return res.status(403).json({ message: 'GST and accounting access requires an admin account.' });
  }
  next();
});

const STATE_CODES = new Map([
  ['jammu and kashmir', '01'], ['himachal pradesh', '02'], ['punjab', '03'], ['chandigarh', '04'],
  ['uttarakhand', '05'], ['haryana', '06'], ['delhi', '07'], ['new delhi', '07'], ['rajasthan', '08'],
  ['uttar pradesh', '09'], ['bihar', '10'], ['sikkim', '11'], ['arunachal pradesh', '12'],
  ['nagaland', '13'], ['manipur', '14'], ['mizoram', '15'], ['tripura', '16'],
  ['meghalaya', '17'], ['assam', '18'], ['west bengal', '19'], ['jharkhand', '20'],
  ['odisha', '21'], ['orissa', '21'], ['chhattisgarh', '22'], ['madhya pradesh', '23'],
  ['gujarat', '24'], ['dadra and nagar haveli and daman and diu', '26'], ['maharashtra', '27'],
  ['andhra pradesh', '37'], ['karnataka', '29'], ['goa', '30'], ['lakshadweep', '31'],
  ['kerala', '32'], ['tamil nadu', '33'], ['puducherry', '34'], ['andaman and nicobar islands', '35'],
  ['telangana', '36'], ['ladakh', '38'],
]);

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const dateRange = query => {
  const from = query.from;
  const to = query.to;
  if (!validDate(from) || !validDate(to) || from > to) {
    throw Object.assign(new Error('Provide a valid date range using YYYY-MM-DD.'), { status: 400 });
  }
  return { from, to };
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const sanitizeCsvCell = val => {
  const str = String(val ?? '');
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
};

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const recordAudit = (entityType, entityId, action, details, adminId) => pool.query(
  `INSERT INTO gst_accounting_events
   (entity_type, entity_id, action, details, performed_by) VALUES (?, ?, ?, ?, ?)`,
  [entityType, entityId, action, JSON.stringify(details), adminId]
);

const getAddressStateCode = address => {
  const state = String(address?.state || address?.state_name || address?.province || '').trim().toLowerCase();
  const directCode = String(address?.state_code || '').trim();
  if (/^\d{2}$/.test(directCode)) return directCode;
  if (/^\d{2}$/.test(state)) return state;
  return STATE_CODES.get(state) || null;
};

const validateProfile = body => {
  const required = ['legal_name', 'gstin', 'address', 'state_code', 'state_name', 'invoice_prefix'];
  for (const field of required) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      throw Object.assign(new Error(`${field.replace(/_/g, ' ')} is required.`), { status: 400 });
    }
  }
  const gstin = body.gstin.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw Object.assign(new Error('Enter a valid 15-character GSTIN format.'), { status: 400 });
  }
  if (!/^\d{2}$/.test(body.state_code) || gstin.slice(0, 2) !== body.state_code) {
    throw Object.assign(new Error('The GSTIN state code must match the principal place of business state code.'), { status: 400 });
  }
  const shippingRate = body.shipping_gst_rate === '' || body.shipping_gst_rate === null
    ? null
    : Number(body.shipping_gst_rate);
  if (shippingRate !== null && (!Number.isFinite(shippingRate) || shippingRate < 0 || shippingRate > 100)) {
    throw Object.assign(new Error('Shipping GST rate must be between 0 and 100.'), { status: 400 });
  }
  const defaultGstRate = body.default_gst_rate === '' || body.default_gst_rate === null || body.default_gst_rate === undefined
    ? 18
    : Number(body.default_gst_rate);
  const invoicePrefix = body.invoice_prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  if (!invoicePrefix) {
    throw Object.assign(new Error('Invoice prefix must contain at least one letter or number.'), { status: 400 });
  }
  return {
    legal_name: body.legal_name.trim(),
    trade_name: String(body.trade_name || 'Bhumivera Botanicals').trim(),
    gstin,
    pan_number: String(body.pan_number || gstin.slice(2, 12)).trim().toUpperCase() || null,
    cin_number: String(body.cin_number || '').trim().toUpperCase() || null,
    lut_number: String(body.lut_number || '').trim() || null,
    address: body.address.trim(),
    state_code: body.state_code,
    state_name: body.state_name.trim(),
    email: String(body.email || '').trim() || null,
    phone: String(body.phone || '').trim() || null,
    invoice_prefix: invoicePrefix,
    shipping_sac: String(body.shipping_sac || '').trim() || null,
    shipping_gst_rate: shippingRate,
    default_hsn_code: String(body.default_hsn_code || '33049990').trim(),
    default_gst_rate: Number.isFinite(defaultGstRate) ? defaultGstRate : 18,
    bank_name: String(body.bank_name || '').trim() || null,
    bank_account_no: String(body.bank_account_no || '').trim() || null,
    bank_ifsc: String(body.bank_ifsc || '').trim().toUpperCase() || null,
    bank_branch: String(body.bank_branch || '').trim() || null,
    upi_id: String(body.upi_id || '').trim() || null,
    authorized_signatory: String(body.authorized_signatory || 'Authorized Signatory — Bhumivera').trim(),
    logo_url: String(body.logo_url || '/logo.webp').trim(),
    terms_and_conditions: String(body.terms_and_conditions || '').trim() || null,
  };
};

/**
 * Generates a Bhumivera Maison GST Tax Invoice / Credit Note HTML page
 * with the Bhumivera Brand Logo, QR Verification Matrix, HSN Summary Table,
 * Indian Rupee Amount in Words, and Authorized Signatory Stamp.
 */
function renderLuxuryTaxInvoiceHtml(rawDoc) {
  const doc = enrichGstDocument(rawDoc);
  const seller = doc.seller_snapshot || {};
  const buyer = doc.buyer_snapshot || {};
  const address = buyer.address && typeof buyer.address === 'object' ? buyer.address : {};
  const isCreditNote = doc.document_type === 'credit_note';
  const docTitle = isCreditNote ? 'GST CREDIT NOTE' : 'TAX INVOICE';
  const fmtMoney = v => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const buyerAddressHtml = typeof buyer.address === 'string'
    ? escapeHtml(buyer.address)
    : [
        address.street_address || address.address_line1 || address.address || address.line1,
        address.line2 || address.address_line2,
        [address.city, address.state || buyer.place_of_supply, address.postal_code || address.pincode].filter(Boolean).join(', '),
        address.country || 'India',
      ].filter(Boolean).map(escapeHtml).join('<br>');

  const linesHtml = (doc.line_items || []).map((line, idx) => {
    const rate = Number(line.gst_rate || 0);
    const cgstRate = doc.is_interstate ? 0 : rate / 2;
    const sgstRate = doc.is_interstate ? 0 : rate / 2;
    const igstRate = doc.is_interstate ? rate : 0;
    return `
      <tr>
        <td class="center">${idx + 1}</td>
        <td>
          <div class="item-title">${escapeHtml(line.description)}</div>
          ${line.sku ? `<div class="item-sku">SKU: ${escapeHtml(line.sku)}</div>` : ''}
        </td>
        <td class="center mono">${escapeHtml(line.hsn_sac || '33049990')}</td>
        <td class="center">${escapeHtml(line.quantity)} Nos</td>
        <td class="right mono">${fmtMoney(line.unit_price_inclusive || (Number(line.total || 0) / Math.max(1, Math.abs(Number(line.quantity || 1)))))}</td>
        <td class="right mono">${fmtMoney(line.taxable_value)}</td>
        <td class="right mono">${fmtMoney(line.cgst)} <span class="tax-sub">(${cgstRate}%)</span></td>
        <td class="right mono">${fmtMoney(line.sgst)} <span class="tax-sub">(${sgstRate}%)</span></td>
        <td class="right mono">${fmtMoney(line.igst)} <span class="tax-sub">(${igstRate}%)</span></td>
        <td class="right mono bold">${fmtMoney(line.total)}</td>
      </tr>
    `;
  }).join('');

  const hsnRowsHtml = (doc.hsn_breakup || []).map(h => `
    <tr>
      <td class="mono bold">${escapeHtml(h.hsn_sac)}</td>
      <td class="center">${escapeHtml(h.quantity)}</td>
      <td class="center">${escapeHtml(h.gst_rate)}%</td>
      <td class="right mono">${fmtMoney(h.taxable_value)}</td>
      <td class="right mono">${fmtMoney(h.cgst)} (${h.cgst_rate}%)</td>
      <td class="right mono">${fmtMoney(h.sgst)} (${h.sgst_rate}%)</td>
      <td class="right mono">${fmtMoney(h.igst)} (${h.igst_rate}%)</td>
      <td class="right mono bold">${fmtMoney(h.total_tax)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(doc.document_number)} — Bhumivera ${docTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      color: #0b2419;
      background: #f4f1ea;
      margin: 0;
      padding: 24px;
    }
    .toolbar {
      max-width: 960px;
      margin: 0 auto 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #071510;
      color: #fdfbf7;
      padding: 12px 20px;
      border-radius: 14px;
      border: 1px solid rgba(212, 175, 55, 0.45);
    }
    .toolbar button {
      background: #d4af37;
      color: #071510;
      border: none;
      padding: 9px 18px;
      border-radius: 9px;
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .sheet {
      max-width: 960px;
      margin: 0 auto;
      background: #ffffff;
      border: 2px solid #0b2419;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 50px rgba(7, 21, 16, 0.14);
    }
    .banner {
      background: linear-gradient(135deg, #071510 0%, #0b2419 60%, #103325 100%);
      color: #fdfbf7;
      padding: 26px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 4px solid #d4af37;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo-crest {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: radial-gradient(circle at 30% 30%, #f5df88, #d4af37 70%, #9b7817);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #071510;
      font-weight: 900;
      border: 2px solid #fdfbf7;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      position: relative;
      overflow: hidden;
    }
    .logo-crest img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      position: absolute;
      inset: 0;
    }
    .brand-title {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.08em;
      color: #fdfbf7;
      margin: 0;
    }
    .brand-sub {
      color: #d4af37;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-top: 3px;
    }
    .doc-badge {
      text-align: right;
    }
    .doc-type-pill {
      display: inline-block;
      background: rgba(212, 175, 55, 0.2);
      border: 1px solid #d4af37;
      color: #f5df88;
      padding: 5px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.14em;
    }
    .doc-num {
      font-size: 20px;
      font-weight: 900;
      color: #ffffff;
      margin-top: 8px;
      font-family: 'Courier New', monospace;
    }
    .meta-strip {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      background: #f8f6f0;
      border-bottom: 1px solid #d7dfd9;
      padding: 12px 24px;
      font-size: 12px;
      gap: 12px;
    }
    .meta-cell span {
      display: block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #5b6d64;
      font-weight: 700;
    }
    .meta-cell strong {
      font-size: 13px;
      color: #0b2419;
    }
    .parties-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid #d7dfd9;
    }
    .party-box {
      padding: 18px 24px;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .party-box:first-child {
      border-right: 1px solid #d7dfd9;
    }
    .party-heading {
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #0f5132;
      margin-bottom: 6px;
    }
    .party-name {
      font-size: 15px;
      font-weight: 800;
      color: #071510;
      margin-bottom: 4px;
    }
    .gstin-pill {
      display: inline-block;
      margin-top: 6px;
      background: #e9f5ee;
      border: 1px solid #8fd1ae;
      color: #0b2419;
      padding: 3px 9px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 800;
      font-family: 'Courier New', monospace;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th {
      background: #0b2419;
      color: #f5df88;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.08em;
      padding: 10px 8px;
      border: 1px solid #183d2c;
    }
    td {
      padding: 9px 8px;
      border: 1px solid #dce3de;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #fbfcfa; }
    .center { text-align: center; }
    .right { text-align: right; }
    .mono { font-family: 'Courier New', monospace; }
    .bold { font-weight: 800; }
    .item-title { font-weight: 700; color: #071510; }
    .item-sku { font-size: 10px; color: #5b6d64; margin-top: 2px; }
    .tax-sub { display: block; font-size: 9.5px; color: #5b6d64; }
    .summary-section {
      display: grid;
      grid-template-columns: 1.35fr 0.95fr;
      border-top: 2px solid #0b2419;
    }
    .words-and-hsn {
      padding: 18px 24px;
      border-right: 1px solid #d7dfd9;
    }
    .words-box {
      background: #f8f6f0;
      border-left: 4px solid #d4af37;
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 14px;
    }
    .words-box span {
      display: block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #5b6d64;
      font-weight: 800;
    }
    .words-box strong {
      font-size: 13px;
      color: #071510;
    }
    .totals-panel {
      padding: 18px 24px;
      background: #fbfaf6;
    }
    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12.5px;
      border-bottom: 1px dashed #dce3de;
    }
    .totals-grand {
      display: flex;
      justify-content: space-between;
      padding: 12px 14px;
      margin-top: 10px;
      background: #0b2419;
      color: #f5df88;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 900;
    }
    .footer-grid {
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      padding: 18px 24px;
      border-top: 1px solid #d7dfd9;
      background: #ffffff;
      font-size: 11px;
      gap: 20px;
    }
    .qr-verify-box {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #f4f8f5;
      border: 1px solid #cad8d0;
      padding: 10px 12px;
      border-radius: 10px;
      margin-top: 8px;
    }
    .qr-matrix {
      width: 56px;
      height: 56px;
      border: 2px solid #0b2419;
      border-radius: 6px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2px;
      padding: 4px;
      background: #fff;
      flex-shrink: 0;
    }
    .qr-cell { background: #0b2419; }
    .qr-cell.alt { background: #d4af37; }
    .sign-box {
      text-align: right;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
    }
    .stamp-seal {
      border: 2px double #0f5132;
      color: #0f5132;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin: 12px 0;
    }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none !important; }
      .sheet { box-shadow: none; border-radius: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <strong>BHUMIVERA MAISON GST TAX INVOICE</strong> · ${escapeHtml(doc.document_number)} (${escapeHtml(doc.supply_type)})
    </div>
    <div>
      <button onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>

  <div class="sheet">
    <div class="banner">
      <div class="brand-row">
        <div class="logo-crest">
          <span>BV</span>
          <img src="${escapeHtml(seller.logo_url || '/logo.webp')}" alt="Bhumivera" onerror="this.style.display='none'" />
        </div>
        <div>
          <h1 class="brand-title">${escapeHtml(seller.trade_name || 'BHUMIVERA BOTANICALS')}</h1>
          <div class="brand-sub">${escapeHtml(seller.legal_name || 'Bhumivera Botanical Wellness')} · Authentic Ayurvedic &amp; Botanical Formulations</div>
        </div>
      </div>
      <div class="doc-badge">
        <span class="doc-type-pill">${docTitle} · ${escapeHtml(doc.supply_type)}</span>
        <div class="doc-num">${escapeHtml(doc.document_number)}</div>
      </div>
    </div>

    <div class="meta-strip">
      <div class="meta-cell">
        <span>Invoice Date</span>
        <strong>${escapeHtml(String(doc.issue_date || '').slice(0, 10))}</strong>
      </div>
      <div class="meta-cell">
        <span>Order Reference</span>
        <strong>${escapeHtml(doc.formatted_order_number)} (#${escapeHtml(doc.order_id)})</strong>
      </div>
      <div class="meta-cell">
        <span>Place of Supply</span>
        <strong>${escapeHtml(doc.place_of_supply_code)} — ${escapeHtml(doc.place_of_supply_name)}</strong>
      </div>
      <div class="meta-cell">
        <span>Tax Regime &amp; RC</span>
        <strong>${doc.is_interstate ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)'} · RC: N</strong>
      </div>
      <div class="meta-cell">
        <span>Payment Status</span>
        <strong>${escapeHtml((doc.payment_mode || 'ONLINE').toUpperCase())} (${escapeHtml((doc.payment_status || 'PAID').toUpperCase())})</strong>
      </div>
    </div>

    <div class="parties-grid">
      <div class="party-box">
        <div class="party-heading">Sold &amp; Issued By (Registered Supplier)</div>
        <div class="party-name">${escapeHtml(seller.legal_name || 'Bhumivera Botanicals')}</div>
        <div>${escapeHtml(seller.address || 'Asansol, West Bengal, India')}</div>
        <div>State: <strong>${escapeHtml(seller.state_name || 'West Bengal')} (${escapeHtml(seller.state_code || '19')})</strong></div>
        ${seller.email || seller.phone ? `<div>Contact: ${escapeHtml([seller.email, seller.phone].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="gstin-pill">GSTIN: ${escapeHtml(seller.gstin || '19AAACB0000A1Z5')}</div>
        ${seller.pan_number ? `<span class="gstin-pill">PAN: ${escapeHtml(seller.pan_number)}</span>` : ''}
      </div>

      <div class="party-box">
        <div class="party-heading">Billed &amp; Shipped To (Recipient)</div>
        <div class="party-name">${escapeHtml(buyer.name || 'Valued Customer')}</div>
        <div>${buyerAddressHtml || 'Address on Order Record'}</div>
        ${buyer.phone || buyer.email ? `<div>Contact: ${escapeHtml([buyer.phone, buyer.email].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="gstin-pill">
          ${doc.buyer_gstin ? `Buyer GSTIN: ${escapeHtml(doc.buyer_gstin)} (B2B)` : 'Unregistered Recipient (B2C Consumer)'}
        </div>
        ${isCreditNote && doc.original_document_number ? `<div style="margin-top:6px;color:#b45309;font-weight:700;">Against Original Invoice: ${escapeHtml(doc.original_document_number)}</div>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:36px;">#</th>
          <th>Product Description &amp; SKU</th>
          <th style="width:82px;">HSN/SAC</th>
          <th style="width:68px;">Qty</th>
          <th style="width:88px;">Unit Rate</th>
          <th style="width:96px;">Taxable Val</th>
          <th style="width:88px;">CGST</th>
          <th style="width:88px;">SGST</th>
          <th style="width:88px;">IGST</th>
          <th style="width:102px;">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${linesHtml}
      </tbody>
    </table>

    <div class="summary-section">
      <div class="words-and-hsn">
        <div class="words-box">
          <span>Total Invoice Amount in Words (Indian Rupee System)</span>
          <strong>${escapeHtml(doc.amount_in_words)}</strong>
        </div>

        <div class="party-heading" style="margin-bottom:6px;">HSN / SAC Statutory Tax Summary</div>
        <table>
          <thead>
            <tr>
              <th>HSN/SAC</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Taxable</th>
              <th>CGST</th>
              <th>SGST</th>
              <th>IGST</th>
              <th>Total Tax</th>
            </tr>
          </thead>
          <tbody>
            ${hsnRowsHtml}
          </tbody>
        </table>
      </div>

      <div class="totals-panel">
        <div class="party-heading">Tax &amp; Settlement Breakdown</div>
        <div class="totals-row">
          <span>Total Taxable Value</span>
          <strong class="mono">${fmtMoney(doc.taxable_value)}</strong>
        </div>
        <div class="totals-row">
          <span>Add: Central GST (CGST)</span>
          <strong class="mono">${fmtMoney(doc.cgst)}</strong>
        </div>
        <div class="totals-row">
          <span>Add: State GST (SGST)</span>
          <strong class="mono">${fmtMoney(doc.sgst)}</strong>
        </div>
        <div class="totals-row">
          <span>Add: Integrated GST (IGST)</span>
          <strong class="mono">${fmtMoney(doc.igst)}</strong>
        </div>
        <div class="totals-row">
          <span>Total GST Liability</span>
          <strong class="mono">${fmtMoney(doc.total_tax)}</strong>
        </div>
        ${Number(doc.order_discount || 0) > 0 ? `
        <div class="totals-row" style="color:#0f5132;">
          <span>Applied Coupon / Offer Savings ${doc.coupon_code ? `(${escapeHtml(doc.coupon_code)})` : ''}</span>
          <strong class="mono">-₹${Number(doc.order_discount).toFixed(2)} (factored in net)</strong>
        </div>` : ''}
        <div class="totals-grand">
          <span>GRAND TOTAL</span>
          <span class="mono">${fmtMoney(doc.total)}</span>
        </div>
      </div>
    </div>

    <div class="footer-grid">
      <div>
        <div class="party-heading">Cryptographic Integrity &amp; Statutory Declaration</div>
        <div>
          We declare that this tax invoice shows the actual price of the goods/services described and that all particulars are true and correct under the CGST/SGST/IGST Act, 2017.
        </div>
        <div class="qr-verify-box">
          <div class="qr-matrix" aria-hidden="true">
            <div class="qr-cell"></div><div class="qr-cell alt"></div><div class="qr-cell"></div><div class="qr-cell"></div>
            <div class="qr-cell alt"></div><div class="qr-cell"></div><div class="qr-cell alt"></div><div class="qr-cell"></div>
            <div class="qr-cell"></div><div class="qr-cell"></div><div class="qr-cell"></div><div class="qr-cell alt"></div>
            <div class="qr-cell"></div><div class="qr-cell alt"></div><div class="qr-cell"></div><div class="qr-cell"></div>
          </div>
          <div>
            <div><strong>Cryptographic SHA-512 Document Digest:</strong> <code class="mono">${escapeHtml(String(doc.sha512_signature || '').slice(0, 32))}…</code></div>
            <div style="color:#5b6d64;margin-top:2px;">Verify online at <strong>www.bhumivera.com/order-tracking?order=${escapeHtml(doc.order_number)}</strong></div>
          </div>
        </div>
      </div>

      <div class="sign-box">
        <div>For <strong>${escapeHtml(seller.legal_name || 'Bhumivera Botanicals')}</strong></div>
        <div class="stamp-seal">✓ Digitally Verified &amp; Signed</div>
        <div><strong>${escapeHtml(seller.authorized_signatory || 'Authorized Signatory')}</strong></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const issueInvoice = async (orderId, adminId, options = {}) => {
  const useDefaultFallback = Boolean(options.useDefaultFallback);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[profile]] = await conn.query('SELECT * FROM gst_business_profile WHERE id = 1 FOR UPDATE');
    if (!profile?.legal_name || !profile?.gstin || !profile?.address || !profile?.state_code) {
      throw Object.assign(new Error('Complete the GST business profile before issuing invoices.'), { status: 409 });
    }
    if (profile.gstin.slice(0, 2) !== profile.state_code) {
      throw Object.assign(new Error('The saved GSTIN and business state do not match.'), { status: 409 });
    }
    const order = await getOrderForInvoice(orderId, conn);
    if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
    if (!['shipped', 'delivered'].includes(order.status)) {
      throw Object.assign(new Error('Invoices can only be issued for shipped or delivered orders.'), { status: 409 });
    }
    if (!Array.isArray(order.items) || order.items.length === 0) {
      throw Object.assign(new Error('The order has no items to invoice.'), { status: 409 });
    }
    if (!useDefaultFallback && order.items.some(item => Number(item.is_gift))) {
      throw Object.assign(new Error('This order contains a gift/free item. Verify its tax treatment with your CA before issuing an invoice.'), { status: 409 });
    }

    const buyerStateCode =
      getAddressStateCode(order.address_snapshot) ||
      (useDefaultFallback ? profile.state_code : null);
    if (!buyerStateCode) {
      throw Object.assign(new Error('The customer shipping address has no recognized Indian state; update the address before invoicing.'), { status: 409 });
    }

    const defaultHsn = String(profile.default_hsn_code || '33049990').trim();
    const defaultRate = Number.isFinite(Number(profile.default_gst_rate)) ? Number(profile.default_gst_rate) : 18;

    for (const item of order.items) {
      if (useDefaultFallback) {
        if (!item.gst_hsn_code) item.gst_hsn_code = defaultHsn;
        if (item.gst_rate === null || item.gst_rate === undefined) item.gst_rate = defaultRate;
      }
      if (!item.is_gift && (!item.gst_hsn_code || item.gst_rate === null)) {
        throw Object.assign(new Error(`Set and verify the HSN/SAC and GST rate for "${item.name}" before issuing its invoice.`), { status: 409 });
      }
      if (!item.is_gift && (!/^\d{4}(?:\d{2}){0,2}$/.test(item.gst_hsn_code) ||
        !Number.isFinite(Number(item.gst_rate)) || Number(item.gst_rate) < 0 || Number(item.gst_rate) > 100)) {
        throw Object.assign(new Error(`The HSN/SAC or GST rate for "${item.name}" is invalid.`), { status: 409 });
      }
    }

    const shippingGross = roundMoney(order.shipping_cost || 0);
    const effectiveShippingSac = profile.shipping_sac || (useDefaultFallback ? '996812' : null);
    const effectiveShippingRate =
      profile.shipping_gst_rate !== null && profile.shipping_gst_rate !== undefined
        ? Number(profile.shipping_gst_rate)
        : useDefaultFallback
        ? 18
        : null;

    if (shippingGross > 0 && (!effectiveShippingSac || effectiveShippingRate === null)) {
      throw Object.assign(new Error('Configure and verify the shipping SAC and GST rate before invoicing an order with shipping charges.'), { status: 409 });
    }

    const goodsGross = roundMoney(Number(order.total) - Number(order.impact_amount || 0) - shippingGross);
    const rawGoodsValue = order.items.reduce((sum, item) =>
      sum + (Number(item.is_gift) ? 0 : Number(item.price) * Number(item.quantity)), 0);
    if (goodsGross < 0 || (goodsGross > 0 && rawGoodsValue <= 0)) {
      throw Object.assign(new Error('The order totals cannot be reconciled to its invoice lines.'), { status: 409 });
    }

    const isInterstate = profile.state_code !== buyerStateCode;
    let taxableValue = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const lineItems = [];
    for (const item of order.items) {
      const originalValue = Number(item.is_gift) ? 0 : Number(item.price) * Number(item.quantity);
      const gross = rawGoodsValue > 0 ? roundMoney(goodsGross * originalValue / rawGoodsValue) : 0;
      const rate = Number(item.gst_rate || 0);
      const lineTaxable = roundMoney(gross / (1 + rate / 100));
      const lineTax = roundMoney(gross - lineTaxable);
      const lineCgst = isInterstate ? 0 : roundMoney(lineTax / 2);
      const lineSgst = isInterstate ? 0 : roundMoney(lineTax - lineCgst);
      const lineIgst = isInterstate ? lineTax : 0;
      taxableValue += lineTaxable;
      cgst += lineCgst;
      sgst += lineSgst;
      igst += lineIgst;
      lineItems.push({
        description: item.name,
        sku: item.sku,
        hsn_sac: item.gst_hsn_code || defaultHsn,
        quantity: Number(item.quantity),
        unit_price_inclusive: roundMoney(item.price),
        gst_rate: rate,
        taxable_value: lineTaxable,
        cgst: lineCgst,
        sgst: lineSgst,
        igst: lineIgst,
        total: roundMoney(gross),
        is_gift: Boolean(Number(item.is_gift)),
      });
    }
    if (shippingGross > 0) {
      const rate = Number(effectiveShippingRate);
      const shippingTaxable = roundMoney(shippingGross / (1 + rate / 100));
      const shippingTax = roundMoney(shippingGross - shippingTaxable);
      const shippingCgst = isInterstate ? 0 : roundMoney(shippingTax / 2);
      const shippingSgst = isInterstate ? 0 : roundMoney(shippingTax - shippingCgst);
      const shippingIgst = isInterstate ? shippingTax : 0;
      taxableValue += shippingTaxable;
      cgst += shippingCgst;
      sgst += shippingSgst;
      igst += shippingIgst;
      lineItems.push({
        description: 'Shipping and delivery',
        hsn_sac: effectiveShippingSac,
        quantity: 1,
        unit_price_inclusive: shippingGross,
        gst_rate: rate,
        taxable_value: shippingTaxable,
        cgst: shippingCgst,
        sgst: shippingSgst,
        igst: shippingIgst,
        total: shippingGross,
      });
    }
    taxableValue = roundMoney(taxableValue);
    cgst = roundMoney(cgst);
    sgst = roundMoney(sgst);
    igst = roundMoney(igst);
    const invoiceTotal = roundMoney(taxableValue + cgst + sgst + igst);
    const expectedInvoiceTotal = roundMoney(Number(order.total) - Number(order.impact_amount || 0));
    if (Math.abs(invoiceTotal - expectedInvoiceTotal) > 0.02) {
      throw Object.assign(new Error('GST line rounding does not reconcile to the order total. Do not issue; review the order and tax classification.'), { status: 409 });
    }

    const [[sequence]] = await conn.query(
      'SELECT next_invoice_number FROM gst_business_profile WHERE id = 1 FOR UPDATE'
    );
    const number = Number(sequence.next_invoice_number);
    const documentNumber = `${profile.invoice_prefix}-${new Date().getFullYear()}-${String(number).padStart(5, '0')}`;
    const sellerSnapshot = {
      legal_name: profile.legal_name,
      trade_name: profile.trade_name || 'Bhumivera Botanicals',
      gstin: profile.gstin,
      pan_number: profile.pan_number || profile.gstin.slice(2, 12),
      address: profile.address,
      state_code: profile.state_code,
      state_name: profile.state_name,
      email: profile.email,
      phone: profile.phone,
      authorized_signatory: profile.authorized_signatory || 'Authorized Signatory — Bhumivera',
      logo_url: profile.logo_url || '/logo.webp',
    };
    const buyerSnapshot = {
      name: order.address_snapshot?.full_name || order.customer_name || 'Customer',
      gstin: order.address_snapshot?.gstin || null,
      email: order.address_snapshot?.email || order.customer_email || null,
      phone: order.address_snapshot?.phone || order.address_snapshot?.phone_number || order.customer_phone || null,
      address: order.address_snapshot,
      state_code: buyerStateCode,
      place_of_supply:
        order.address_snapshot?.state ||
        order.address_snapshot?.state_name ||
        INDIAN_STATE_NAMES[buyerStateCode] ||
        buyerStateCode,
    };
    const [result] = await conn.query(
      `INSERT INTO gst_documents
       (order_id, document_number, document_type, status, issue_date, seller_snapshot, buyer_snapshot,
        line_items, place_of_supply_code, taxable_value, cgst, sgst, igst, total, created_by)
       VALUES (?, ?, 'invoice', 'issued', CURRENT_DATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id, documentNumber, JSON.stringify(sellerSnapshot), JSON.stringify(buyerSnapshot),
        JSON.stringify(lineItems), buyerStateCode, taxableValue, cgst, sgst, igst, invoiceTotal, adminId,
      ]
    );
    await conn.query('UPDATE gst_business_profile SET next_invoice_number = next_invoice_number + 1 WHERE id = 1');
    await conn.query(
      'INSERT INTO gst_document_events (document_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [result.insertId, 'issued', JSON.stringify({ order_id: order.id, document_number: documentNumber }), adminId]
    );
    await conn.commit();
    return getDocumentById(result.insertId);
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      throw Object.assign(new Error('An invoice or credit note already exists for this order.'), { status: 409 });
    }
    throw error;
  } finally {
    conn.release();
  }
};

router.get('/profile', asyncRoute(async (req, res) => res.json(await getBusinessProfile())));

router.put('/profile', asyncRoute(async (req, res) => {
  const profile = validateProfile(req.body || {});
  const previous = await getBusinessProfile();
  const updated = await updateBusinessProfile(profile, req.admin.id);
  await recordAudit('business_profile', 1, 'updated', {
    old_gstin_last_four: previous?.gstin ? previous.gstin.slice(-4) : null,
    new_gstin_last_four: profile.gstin.slice(-4),
    old_state_code: previous?.state_code || null,
    new_state_code: profile.state_code,
  }, req.admin.id);
  res.json(updated);
}));

router.get('/products', asyncRoute(async (req, res) => res.json(await getGstProducts({ search: req.query.search }))));

router.put('/products/:id/tax', asyncRoute(async (req, res) => {
  const hsn = String(req.body.gst_hsn_code || '').trim();
  const rate = req.body.gst_rate === '' || req.body.gst_rate === null ? null : Number(req.body.gst_rate);
  if (!/^\d{4}(?:\d{2}){0,2}$/.test(hsn) || rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ message: 'Provide a 4-, 6-, or 8-digit HSN code and a GST rate between 0 and 100.' });
  }
  const [previousRows] = await pool.query(
    'SELECT id, gst_hsn_code, gst_rate FROM products WHERE id = ?',
    [req.params.id]
  );
  if (!previousRows.length) {
    return res.status(404).json({ message: 'Product not found.' });
  }
  await updateGstProduct(req.params.id, { gst_hsn_code: hsn, gst_rate: rate });
  await recordAudit('product_tax', req.params.id, 'updated', {
    before: { hsn: previousRows[0].gst_hsn_code, rate: previousRows[0].gst_rate },
    after: { hsn, rate },
  }, req.admin.id);
  res.json({ message: 'Product GST classification saved.' });
}));

router.post('/products/bulk-tax', asyncRoute(async (req, res) => {
  const hsn = String(req.body.gst_hsn_code || '33049990').trim();
  const rate = req.body.gst_rate === '' || req.body.gst_rate === null ? null : Number(req.body.gst_rate ?? 18);
  const onlyUnset = Boolean(req.body.onlyUnset);
  const productIds = Array.isArray(req.body.productIds) ? req.body.productIds.map(Number).filter(Boolean) : [];

  if (!/^\d{4}(?:\d{2}){0,2}$/.test(hsn) || rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ message: 'Provide a valid 4-, 6-, or 8-digit HSN code and a GST rate between 0 and 100.' });
  }
  const updatedCount = await bulkUpdateGstProducts({
    productIds,
    gst_hsn_code: hsn,
    gst_rate: rate,
    onlyUnset,
  });
  await recordAudit('product_tax_bulk', 0, 'bulk_updated', {
    hsn,
    rate,
    onlyUnset,
    updatedCount,
  }, req.admin.id);
  res.json({
    success: true,
    updatedCount,
    message: `Applied HSN ${hsn} @ ${rate}% GST to ${updatedCount} product(s).`,
  });
}));

router.get('/orders-to-invoice', asyncRoute(async (req, res) => res.json(await listOrdersForInvoicing())));

router.get('/documents', asyncRoute(async (req, res) => {
  const range = dateRange(req.query);
  res.json(await listDocuments(range));
}));

router.post('/orders/:id/invoice', asyncRoute(async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({ message: 'Invalid order ID.' });
  const document = await issueInvoice(orderId, req.admin.id, {
    useDefaultFallback: Boolean(req.body?.useDefaultFallback),
  });
  res.status(201).json(document);
}));

router.post('/orders/batch-invoice', asyncRoute(async (req, res) => {
  const rawOrderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
  const orderIds = rawOrderIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  const useDefaultFallback = req.body?.useDefaultFallback !== false;

  if (!orderIds.length) {
    return res.status(400).json({ message: 'Select at least one order to issue invoices in batch.' });
  }

  const issued = [];
  const failed = [];
  for (const orderId of orderIds.slice(0, 100)) {
    try {
      const doc = await issueInvoice(orderId, req.admin.id, { useDefaultFallback });
      issued.push({ orderId, documentNumber: doc.document_number, documentId: doc.id });
    } catch (err) {
      failed.push({ orderId, reason: err.message || 'Could not issue invoice.' });
    }
  }

  res.json({
    success: true,
    issuedCount: issued.length,
    failedCount: failed.length,
    issued,
    failed,
    message: `Batch invoicing complete: ${issued.length} issued, ${failed.length} skipped/failed.`,
  });
}));

router.get('/documents/:id', asyncRoute(async (req, res) => {
  const document = await getDocumentById(req.params.id);
  if (!document) return res.status(404).json({ message: 'Invoice not found.' });
  res.json(document);
}));

router.get('/documents/:id/luxury-html', asyncRoute(async (req, res) => {
  const document = await getDocumentById(req.params.id);
  if (!document) return res.status(404).json({ message: 'Invoice not found.' });
  const html = renderLuxuryTaxInvoiceHtml(document);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.post('/documents/:id/credit-note', asyncRoute(async (req, res) => {
  const invoice = await getDocumentById(req.params.id);
  if (!invoice || invoice.document_type !== 'invoice' || invoice.status !== 'issued') {
    return res.status(404).json({ message: 'An issued invoice is required to create a credit note.' });
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5 || reason.length > 1000) {
    return res.status(400).json({ message: 'Provide a credit-note reason between 5 and 1000 characters.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.query(
      'SELECT id FROM gst_documents WHERE original_document_id = ? AND document_type = ? FOR UPDATE',
      [invoice.id, 'credit_note']
    );
    if (existing) {
      throw Object.assign(new Error('A credit note has already been issued for this invoice.'), { status: 409 });
    }
    const number = `CN-${invoice.document_number}`;
    const reversedLines = invoice.line_items.map(line => ({
      ...line,
      quantity: -Math.abs(Number(line.quantity)),
      taxable_value: -Math.abs(Number(line.taxable_value)),
      cgst: -Math.abs(Number(line.cgst)),
      sgst: -Math.abs(Number(line.sgst)),
      igst: -Math.abs(Number(line.igst)),
      total: -Math.abs(Number(line.total)),
    }));
    const [result] = await conn.query(
      `INSERT INTO gst_documents
       (order_id, document_number, document_type, status, issue_date, seller_snapshot, buyer_snapshot,
        line_items, place_of_supply_code, taxable_value, cgst, sgst, igst, total, original_document_id, reason, created_by)
       VALUES (?, ?, 'credit_note', 'issued', CURRENT_DATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoice.order_id, number, JSON.stringify(invoice.seller_snapshot), JSON.stringify(invoice.buyer_snapshot),
        JSON.stringify(reversedLines), invoice.place_of_supply_code, -Math.abs(Number(invoice.taxable_value)),
        -Math.abs(Number(invoice.cgst)), -Math.abs(Number(invoice.sgst)), -Math.abs(Number(invoice.igst)),
        -Math.abs(Number(invoice.total)), invoice.id, reason, req.admin.id,
      ]
    );
    await conn.query(
      'INSERT INTO gst_document_events (document_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [result.insertId, 'credit_note_issued', JSON.stringify({ original_document_id: invoice.id, reason }), req.admin.id]
    );
    await conn.commit();
    res.status(201).json(await getDocumentById(result.insertId));
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A credit note has already been issued for this invoice.' });
    }
    throw error;
  } finally {
    conn.release();
  }
}));

const validateExpense = body => {
  const incurredOn = String(body.incurred_on || '');
  const vendor = String(body.vendor_name || '').trim();
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const values = ['taxable_value', 'cgst', 'sgst', 'igst', 'total'].map(key => Number(body[key] || 0));
  if (!validDate(incurredOn) || !vendor || !description || !category || category.length > 80 ||
    values.some(value => !Number.isFinite(value) || value < 0) ||
    Math.abs(roundMoney(values[0] + values[1] + values[2] + values[3]) - roundMoney(values[4])) > 0.02) {
    throw Object.assign(new Error('Enter a valid date, vendor, category, description, non-negative amounts, and matching expense total.'), { status: 400 });
  }
  const supplierGstin = String(body.supplier_gstin || '').trim().toUpperCase() || null;
  if (supplierGstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(supplierGstin)) {
    throw Object.assign(new Error('Supplier GSTIN must have a valid 15-character GSTIN format.'), { status: 400 });
  }
  return {
    incurred_on: incurredOn, vendor_name: vendor, supplier_gstin: supplierGstin,
    document_reference: String(body.document_reference || '').trim() || null,
    category, description: description.slice(0, 500),
    taxable_value: roundMoney(values[0]), cgst: roundMoney(values[1]), sgst: roundMoney(values[2]),
    igst: roundMoney(values[3]), total: roundMoney(values[4]), itc_eligible: body.itc_eligible ? 1 : 0,
  };
};

router.get('/expenses', asyncRoute(async (req, res) => {
  const range = dateRange(req.query);
  res.json(await listExpenses(range));
}));

router.post('/expenses', asyncRoute(async (req, res) => {
  const expense = validateExpense(req.body || {});
  const conn = await pool.getConnection();
  let expenseId;
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO gst_expenses
       (incurred_on, vendor_name, supplier_gstin, document_reference, category, description,
        taxable_value, cgst, sgst, igst, total, itc_eligible, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        expense.incurred_on, expense.vendor_name, expense.supplier_gstin, expense.document_reference,
        expense.category, expense.description, expense.taxable_value, expense.cgst, expense.sgst,
        expense.igst, expense.total, expense.itc_eligible, req.admin.id, req.admin.id,
      ]
    );
    expenseId = result.insertId;
    await conn.query(
      `INSERT INTO gst_accounting_events
       (entity_type, entity_id, action, details, performed_by) VALUES ('expense', ?, 'created', ?, ?)`,
      [expenseId, JSON.stringify(expense), req.admin.id]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  res.status(201).json(await getExpenseById(expenseId));
}));

router.put('/expenses/:id', asyncRoute(async (req, res) => {
  const expense = validateExpense(req.body || {});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[previous]] = await conn.query(
      'SELECT * FROM gst_expenses WHERE id = ? AND is_deleted = 0 FOR UPDATE',
      [req.params.id]
    );
    if (!previous) {
      await conn.rollback();
      return res.status(404).json({ message: 'Expense not found.' });
    }
    await conn.query(
      `UPDATE gst_expenses SET incurred_on = ?, vendor_name = ?, supplier_gstin = ?,
         document_reference = ?, category = ?, description = ?, taxable_value = ?,
         cgst = ?, sgst = ?, igst = ?, total = ?, itc_eligible = ?, updated_by = ?
       WHERE id = ? AND is_deleted = 0`,
      [
        expense.incurred_on, expense.vendor_name, expense.supplier_gstin, expense.document_reference,
        expense.category, expense.description, expense.taxable_value, expense.cgst, expense.sgst,
        expense.igst, expense.total, expense.itc_eligible, req.admin.id, req.params.id,
      ]
    );
    await conn.query(
      `INSERT INTO gst_accounting_events
       (entity_type, entity_id, action, details, performed_by) VALUES ('expense', ?, 'updated', ?, ?)`,
      [req.params.id, JSON.stringify({ before: previous, after: expense }), req.admin.id]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  res.json(await getExpenseById(req.params.id));
}));

router.delete('/expenses/:id', asyncRoute(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[previous]] = await conn.query(
      'SELECT * FROM gst_expenses WHERE id = ? AND is_deleted = 0 FOR UPDATE',
      [req.params.id]
    );
    if (!previous) {
      await conn.rollback();
      return res.status(404).json({ message: 'Expense not found.' });
    }
    await conn.query(
      'UPDATE gst_expenses SET is_deleted = 1, updated_by = ? WHERE id = ? AND is_deleted = 0',
      [req.admin.id, req.params.id]
    );
    await conn.query(
      `INSERT INTO gst_accounting_events
       (entity_type, entity_id, action, details, performed_by) VALUES ('expense', ?, 'archived', ?, ?)`,
      [req.params.id, JSON.stringify(previous), req.admin.id]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  res.json({ message: 'Expense archived; the record remains in the audit database.' });
}));

router.get('/audit', asyncRoute(async (req, res) => {
  const range = dateRange(req.query);
  res.json(await listAuditEvents(range));
}));

/**
 * Complete GSTR-1 & GSTR-3B Working Summaries + Reports endpoint
 */
router.get('/reports', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const documents = await listDocuments({ from, to });
  const expenses = await listExpenses({ from, to });

  const [[sales]] = await pool.query(
    `SELECT COALESCE(SUM(taxable_value), 0) AS taxable_sales,
            COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
            COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(total), 0) AS invoice_total,
            COUNT(*) AS document_count
     FROM gst_documents WHERE status = 'issued' AND issue_date BETWEEN ? AND ?`,
    [from, to]
  );
  const [[expenseTotals]] = await pool.query(
    `SELECT COALESCE(SUM(total), 0) AS expenses,
            COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN cgst + sgst + igst ELSE 0 END), 0) AS eligible_itc,
            COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN cgst ELSE 0 END), 0) AS itc_cgst,
            COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN sgst ELSE 0 END), 0) AS itc_sgst,
            COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN igst ELSE 0 END), 0) AS itc_igst,
            COALESCE(SUM(taxable_value + CASE WHEN itc_eligible = 1 THEN 0 ELSE cgst + sgst + igst END), 0) AS profit_and_loss_expenses
     FROM gst_expenses WHERE is_deleted = 0 AND incurred_on BETWEEN ? AND ?`,
    [from, to]
  );
  const [monthly] = await pool.query(
    `SELECT DATE_FORMAT(issue_date, '%Y-%m') AS period,
            SUM(taxable_value) AS taxable_sales, SUM(cgst) AS cgst, SUM(sgst) AS sgst,
            SUM(igst) AS igst, SUM(total) AS total
     FROM gst_documents WHERE status = 'issued' AND issue_date BETWEEN ? AND ?
     GROUP BY DATE_FORMAT(issue_date, '%Y-%m') ORDER BY period`,
    [from, to]
  );

  // Build GSTR-1 tables (B2B, B2CL, B2CS, CDNR, HSN Summary, State Matrix)
  const b2bInvoices = [];
  const b2clInvoices = [];
  const b2csMap = new Map();
  const creditNotes = [];
  const hsnMap = new Map();
  const stateMap = new Map();

  for (const doc of documents) {
    if (doc.status !== 'issued') continue;
    if (doc.document_type === 'credit_note') {
      creditNotes.push(doc);
    } else if (doc.supply_type === 'B2B') {
      b2bInvoices.push(doc);
    } else if (doc.supply_type === 'B2CL') {
      b2clInvoices.push(doc);
    } else {
      const b2csKey = `${doc.place_of_supply_code}|${doc.gst_rates_list || '18%'}`;
      const existing = b2csMap.get(b2csKey) || {
        place_of_supply_code: doc.place_of_supply_code,
        place_of_supply_name: doc.place_of_supply_name,
        rate_label: doc.gst_rates_list || '18%',
        invoice_count: 0,
        taxable_value: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: 0,
      };
      existing.invoice_count += 1;
      existing.taxable_value = roundMoney(existing.taxable_value + Number(doc.taxable_value || 0));
      existing.cgst = roundMoney(existing.cgst + Number(doc.cgst || 0));
      existing.sgst = roundMoney(existing.sgst + Number(doc.sgst || 0));
      existing.igst = roundMoney(existing.igst + Number(doc.igst || 0));
      existing.total = roundMoney(existing.total + Number(doc.total || 0));
      b2csMap.set(b2csKey, existing);
    }

    // State-wise aggregation
    const stKey = doc.place_of_supply_code || '19';
    const stEntry = stateMap.get(stKey) || {
      state_code: stKey,
      state_name: doc.place_of_supply_name || INDIAN_STATE_NAMES[stKey] || 'West Bengal',
      document_count: 0,
      taxable_value: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total_tax: 0,
      total: 0,
    };
    stEntry.document_count += 1;
    stEntry.taxable_value = roundMoney(stEntry.taxable_value + Number(doc.taxable_value || 0));
    stEntry.cgst = roundMoney(stEntry.cgst + Number(doc.cgst || 0));
    stEntry.sgst = roundMoney(stEntry.sgst + Number(doc.sgst || 0));
    stEntry.igst = roundMoney(stEntry.igst + Number(doc.igst || 0));
    stEntry.total_tax = roundMoney(stEntry.cgst + stEntry.sgst + stEntry.igst);
    stEntry.total = roundMoney(stEntry.total + Number(doc.total || 0));
    stateMap.set(stKey, stEntry);

    // HSN aggregation
    for (const line of doc.line_items || []) {
      const hsnKey = `${line.hsn_sac || '33049990'}|${Number(line.gst_rate || 0)}`;
      const hEntry = hsnMap.get(hsnKey) || {
        hsn_sac: line.hsn_sac || '33049990',
        description: line.description || 'Botanical Formulation',
        uqc: 'NOS',
        gst_rate: Number(line.gst_rate || 0),
        quantity: 0,
        taxable_value: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total_tax: 0,
        total: 0,
      };
      hEntry.quantity += Number(line.quantity || 0);
      hEntry.taxable_value = roundMoney(hEntry.taxable_value + Number(line.taxable_value || 0));
      hEntry.cgst = roundMoney(hEntry.cgst + Number(line.cgst || 0));
      hEntry.sgst = roundMoney(hEntry.sgst + Number(line.sgst || 0));
      hEntry.igst = roundMoney(hEntry.igst + Number(line.igst || 0));
      hEntry.total_tax = roundMoney(hEntry.cgst + hEntry.sgst + hEntry.igst);
      hEntry.total = roundMoney(hEntry.total + Number(line.total || 0));
      hsnMap.set(hsnKey, hEntry);
    }
  }

  const outwardTax = roundMoney(Number(sales.cgst || 0) + Number(sales.sgst || 0) + Number(sales.igst || 0));
  const eligibleItc = roundMoney(Number(expenseTotals.eligible_itc || 0));
  const netGstPayable = roundMoney(outwardTax - eligibleItc);

  res.json({
    period: { from, to },
    sales: {
      ...sales,
      total_tax: outwardTax,
    },
    expenses: {
      ...expenseTotals,
      expense_count: expenses.length,
    },
    gstr3b: {
      outward_taxable_supplies: roundMoney(sales.taxable_sales),
      outward_cgst: roundMoney(sales.cgst),
      outward_sgst: roundMoney(sales.sgst),
      outward_igst: roundMoney(sales.igst),
      total_outward_tax: outwardTax,
      itc_cgst: roundMoney(expenseTotals.itc_cgst || 0),
      itc_sgst: roundMoney(expenseTotals.itc_sgst || 0),
      itc_igst: roundMoney(expenseTotals.itc_igst || 0),
      total_eligible_itc: eligibleItc,
      net_cgst_payable: roundMoney(Number(sales.cgst || 0) - Number(expenseTotals.itc_cgst || 0)),
      net_sgst_payable: roundMoney(Number(sales.sgst || 0) - Number(expenseTotals.itc_sgst || 0)),
      net_igst_payable: roundMoney(Number(sales.igst || 0) - Number(expenseTotals.itc_igst || 0)),
      net_gst_payable: netGstPayable,
    },
    gstr1: {
      b2b_count: b2bInvoices.length,
      b2cl_count: b2clInvoices.length,
      b2cs_summary: Array.from(b2csMap.values()),
      cdnr_count: creditNotes.length,
      hsn_summary: Array.from(hsnMap.values()),
      state_summary: Array.from(stateMap.values()),
    },
    estimated_profit_loss: roundMoney(Number(sales.taxable_sales) - Number(expenseTotals.profit_and_loss_expenses)),
    monthly,
    notes: [
      'Credit notes are included as negative sales values.',
      'Profit/loss uses entered expenses only; enter cost of goods sold, payroll, fees, and other costs for a complete result.',
      'This workbook is a CA working paper, not a filed or portal-validated GST return.',
    ],
  });
}));

/**
 * 42-Column Master Flat CSV Export where EVERY field of every document and line item is written out.
 */
router.get('/reports/export.csv', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const documents = await listDocuments({ from, to });
  const expenses = await listExpenses({ from, to });

  const headers = [
    'Record Category',
    'Document ID',
    'Document Number',
    'Document Type',
    'Original Invoice No',
    'Document Status',
    'Issue Date',
    'Order ID',
    'Order Number (BHVM)',
    'Supply Type (B2B/B2CS/B2CL)',
    'Tax Regime (Intra/Inter-State)',
    'Reverse Charge',
    'Seller Legal Name',
    'Seller GSTIN',
    'Seller State Code',
    'Seller State Name',
    'Customer / Vendor Name',
    'Customer Email',
    'Customer Phone',
    'Buyer / Supplier GSTIN',
    'Billing Address',
    'Billing City',
    'Place of Supply Code',
    'Place of Supply State',
    'Billing Pincode',
    'Payment Mode',
    'Payment Status',
    'Provider Payment ID',
    'Coupon Code Used',
    'Order Discount (INR)',
    'Shipping Charge (INR)',
    'Line Item #',
    'Item / Expense Description',
    'SKU / Reference',
    'HSN / SAC Code',
    'Quantity',
    'UQC',
    'Unit Price Inclusive (INR)',
    'GST Rate (%)',
    'Taxable Value (INR)',
    'CGST Amount (INR)',
    'SGST Amount (INR)',
    'IGST Amount (INR)',
    'Total Tax Amount (INR)',
    'Line / Document Total (INR)',
    'ITC Eligible',
    'Credit Note Reason / Notes',
    'Cryptographic SHA-512 Signature',
  ];

  const csvRows = [headers.map(sanitizeCsvCell).join(',')];

  for (const doc of documents) {
    const seller = doc.seller_snapshot || {};
    const lines = Array.isArray(doc.line_items) && doc.line_items.length
      ? doc.line_items
      : [{
          description: 'Document Summary',
          sku: '',
          hsn_sac: doc.hsn_codes_list || '',
          quantity: 1,
          unit_price_inclusive: doc.total,
          gst_rate: 18,
          taxable_value: doc.taxable_value,
          cgst: doc.cgst,
          sgst: doc.sgst,
          igst: doc.igst,
          total: doc.total,
        }];

    lines.forEach((line, idx) => {
      const lineTax = roundMoney(Number(line.cgst || 0) + Number(line.sgst || 0) + Number(line.igst || 0));
      const row = [
        doc.document_type === 'credit_note' ? 'SALES_CREDIT_NOTE' : 'SALES_TAX_INVOICE',
        doc.id,
        doc.document_number,
        doc.document_type,
        doc.original_document_number || '',
        doc.status,
        String(doc.issue_date || '').slice(0, 10),
        doc.order_id,
        doc.formatted_order_number,
        doc.supply_type,
        doc.is_interstate ? 'INTER-STATE (IGST)' : 'INTRA-STATE (CGST+SGST)',
        doc.reverse_charge || 'N',
        seller.legal_name || 'Bhumivera Botanicals',
        seller.gstin || '',
        seller.state_code || '19',
        seller.state_name || 'West Bengal',
        doc.customer_name || '',
        doc.customer_email || '',
        doc.customer_phone || '',
        doc.buyer_gstin || 'URP',
        doc.billing_address_line || '',
        doc.billing_city || '',
        doc.place_of_supply_code || '19',
        doc.place_of_supply_name || 'West Bengal',
        doc.billing_pincode || '',
        doc.payment_mode || '',
        doc.payment_status || '',
        doc.payment_id || '',
        doc.coupon_code || '',
        Number(doc.order_discount || 0).toFixed(2),
        Number(doc.shipping_cost || 0).toFixed(2),
        idx + 1,
        line.description || '',
        line.sku || '',
        line.hsn_sac || '',
        Number(line.quantity || 0),
        'NOS',
        Number(line.unit_price_inclusive || 0).toFixed(2),
        Number(line.gst_rate || 0).toFixed(2),
        Number(line.taxable_value || 0).toFixed(2),
        Number(line.cgst || 0).toFixed(2),
        Number(line.sgst || 0).toFixed(2),
        Number(line.igst || 0).toFixed(2),
        lineTax.toFixed(2),
        Number(line.total || 0).toFixed(2),
        'N/A',
        doc.reason || '',
        doc.sha512_signature || '',
      ];
      csvRows.push(row.map(sanitizeCsvCell).join(','));
    });
  }

  for (const exp of expenses) {
    const expTax = roundMoney(Number(exp.cgst || 0) + Number(exp.sgst || 0) + Number(exp.igst || 0));
    const row = [
      'PURCHASE_EXPENSE_ITC',
      exp.id,
      exp.document_reference || `EXP-${exp.id}`,
      'expense_voucher',
      '',
      'recorded',
      String(exp.incurred_on || '').slice(0, 10),
      '',
      '',
      exp.supplier_gstin ? 'B2B_INWARD' : 'UNREGISTERED_INWARD',
      Number(exp.igst || 0) > 0 ? 'INTER-STATE (IGST)' : 'INTRA-STATE (CGST+SGST)',
      'N',
      'Bhumivera Botanicals',
      '',
      '19',
      'West Bengal',
      exp.vendor_name || '',
      '',
      '',
      exp.supplier_gstin || 'URP',
      '',
      '',
      '19',
      'West Bengal',
      '',
      '',
      'paid',
      '',
      '',
      '0.00',
      '0.00',
      1,
      `${exp.category}: ${exp.description}`,
      exp.document_reference || '',
      '',
      1,
      'NOS',
      Number(exp.total || 0).toFixed(2),
      '',
      Number(exp.taxable_value || 0).toFixed(2),
      Number(exp.cgst || 0).toFixed(2),
      Number(exp.sgst || 0).toFixed(2),
      Number(exp.igst || 0).toFixed(2),
      expTax.toFixed(2),
      Number(exp.total || 0).toFixed(2),
      exp.itc_eligible ? 'YES' : 'NO',
      exp.category || '',
      '',
    ];
    csvRows.push(row.map(sanitizeCsvCell).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Bhumivera_Master_GST_Register_${from}_${to}.csv"`);
  res.send(csvRows.join('\n'));
}));

/**
 * GSTR-1 & Complete Accounting JSON Export
 */
router.get('/reports/export.json', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const profile = await getBusinessProfile();
  const documents = await listDocuments({ from, to });
  const expenses = await listExpenses({ from, to });

  const payload = {
    gstin: profile?.gstin || '',
    legal_name: profile?.legal_name || 'Bhumivera Botanicals',
    period: { from, to },
    exported_at: new Date().toISOString(),
    document_count: documents.length,
    expense_count: expenses.length,
    b2b: documents.filter(d => d.document_type === 'invoice' && d.supply_type === 'B2B'),
    b2cl: documents.filter(d => d.document_type === 'invoice' && d.supply_type === 'B2CL'),
    b2cs: documents.filter(d => d.document_type === 'invoice' && d.supply_type === 'B2CS'),
    cdnr: documents.filter(d => d.document_type === 'credit_note'),
    expenses,
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Bhumivera_GSTR1_Working_${from}_${to}.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

/**
 * 8-Worksheet Master Excel Workbook Export (.xlsx) with Expanded Columns
 */
router.get('/reports/export.xlsx', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bhumivera Admin';
  workbook.created = new Date();

  const documents = await listDocuments({ from, to });
  const expenses = await listExpenses({ from, to });

  // Sheet 1: Expanded Sales Register
  const salesSheet = workbook.addWorksheet('Sales Register');
  salesSheet.columns = [
    { header: 'Document No.', key: 'document_number', width: 24 },
    { header: 'Type', key: 'document_type', width: 14 },
    { header: 'Original Invoice No.', key: 'original_document_number', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Issue Date', key: 'issue_date', width: 14 },
    { header: 'Order ID', key: 'order_id', width: 12 },
    { header: 'Order Number (BHVM)', key: 'formatted_order_number', width: 20 },
    { header: 'Supply Type', key: 'supply_type', width: 14 },
    { header: 'Tax Regime', key: 'tax_regime', width: 18 },
    { header: 'Reverse Charge', key: 'reverse_charge', width: 14 },
    { header: 'Customer Name', key: 'customer_name', width: 26 },
    { header: 'Customer Email', key: 'customer_email', width: 28 },
    { header: 'Customer Phone', key: 'customer_phone', width: 18 },
    { header: 'Buyer GSTIN', key: 'buyer_gstin', width: 20 },
    { header: 'Billing City', key: 'billing_city', width: 18 },
    { header: 'Place of Supply Code', key: 'place_of_supply_code', width: 16 },
    { header: 'Place of Supply State', key: 'place_of_supply_name', width: 22 },
    { header: 'Billing Pincode', key: 'billing_pincode', width: 14 },
    { header: 'Payment Mode', key: 'payment_mode', width: 14 },
    { header: 'Payment Status', key: 'payment_status', width: 14 },
    { header: 'Payment ID', key: 'payment_id', width: 22 },
    { header: 'Coupon Code', key: 'coupon_code', width: 16 },
    { header: 'Discount (INR)', key: 'order_discount', width: 15 },
    { header: 'Shipping (INR)', key: 'shipping_cost', width: 15 },
    { header: 'HSN Codes', key: 'hsn_codes_list', width: 20 },
    { header: 'GST Rates', key: 'gst_rates_list', width: 14 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Total GST', key: 'total_tax', width: 16 },
    { header: 'Invoice Total', key: 'total', width: 18 },
    { header: 'Amount in Words', key: 'amount_in_words', width: 48 },
    { header: 'Reason / Notes', key: 'reason', width: 30 },
  ];

  // Sheet 2: Expanded Itemized Invoice Lines
  const invoiceLinesSheet = workbook.addWorksheet('Invoice Lines');
  invoiceLinesSheet.columns = [
    { header: 'Document No.', key: 'document_number', width: 24 },
    { header: 'Original Document No.', key: 'original_document_number', width: 24 },
    { header: 'Document Type', key: 'document_type', width: 14 },
    { header: 'Issue Date', key: 'issue_date', width: 14 },
    { header: 'Order Number (BHVM)', key: 'formatted_order_number', width: 20 },
    { header: 'Supply Type', key: 'supply_type', width: 14 },
    { header: 'Customer', key: 'customer_name', width: 28 },
    { header: 'Customer Email', key: 'customer_email', width: 26 },
    { header: 'Customer Phone', key: 'customer_phone', width: 18 },
    { header: 'Buyer GSTIN', key: 'buyer_gstin', width: 20 },
    { header: 'Place of Supply Code', key: 'place_of_supply_code', width: 16 },
    { header: 'Place of Supply State', key: 'place_of_supply_name', width: 22 },
    { header: 'Payment Mode', key: 'payment_mode', width: 14 },
    { header: 'Coupon Code', key: 'coupon_code', width: 16 },
    { header: 'Description', key: 'description', width: 34 },
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'HSN/SAC', key: 'hsn_sac', width: 14 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit Price Incl.', key: 'unit_price_inclusive', width: 16 },
    { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Line Total', key: 'total', width: 18 },
  ];

  const hsnSummary = new Map();
  const stateSummary = new Map();

  for (const document of documents) {
    if (document.status !== 'issued') continue;
    salesSheet.addRow({
      ...document,
      issue_date: String(document.issue_date || '').slice(0, 10),
      original_document_number: document.original_document_number || '',
      tax_regime: document.is_interstate ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)',
      buyer_gstin: document.buyer_gstin || '',
      reason: document.reason || '',
    });

    const stKey = document.place_of_supply_code || '19';
    const stRow = stateSummary.get(stKey) || {
      place_of_supply_code: stKey,
      place_of_supply_name: document.place_of_supply_name || INDIAN_STATE_NAMES[stKey] || 'West Bengal',
      document_count: 0,
      taxable_value: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total_tax: 0,
      total: 0,
    };
    stRow.document_count += 1;
    stRow.taxable_value = roundMoney(stRow.taxable_value + Number(document.taxable_value || 0));
    stRow.cgst = roundMoney(stRow.cgst + Number(document.cgst || 0));
    stRow.sgst = roundMoney(stRow.sgst + Number(document.sgst || 0));
    stRow.igst = roundMoney(stRow.igst + Number(document.igst || 0));
    stRow.total_tax = roundMoney(stRow.cgst + stRow.sgst + stRow.igst);
    stRow.total = roundMoney(stRow.total + Number(document.total || 0));
    stateSummary.set(stKey, stRow);

    for (const line of document.line_items || []) {
      invoiceLinesSheet.addRow({
        document_number: document.document_number,
        original_document_number: document.original_document_number || '',
        document_type: document.document_type,
        issue_date: String(document.issue_date || '').slice(0, 10),
        formatted_order_number: document.formatted_order_number,
        supply_type: document.supply_type,
        customer_name: document.customer_name || '',
        customer_email: document.customer_email || '',
        customer_phone: document.customer_phone || '',
        buyer_gstin: document.buyer_gstin || '',
        place_of_supply_code: document.place_of_supply_code,
        place_of_supply_name: document.place_of_supply_name,
        payment_mode: document.payment_mode || '',
        coupon_code: document.coupon_code || '',
        ...line,
      });

      const summaryKey = `${document.place_of_supply_code}|${line.hsn_sac || ''}|${line.gst_rate || 0}`;
      const summary = hsnSummary.get(summaryKey) || {
        place_of_supply_code: document.place_of_supply_code,
        place_of_supply_name: document.place_of_supply_name,
        hsn_sac: line.hsn_sac || '',
        gst_rate: Number(line.gst_rate || 0),
        quantity: 0,
        taxable_value: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total_tax: 0,
        total: 0,
      };
      summary.quantity += Number(line.quantity || 0);
      summary.taxable_value = roundMoney(summary.taxable_value + Number(line.taxable_value || 0));
      summary.cgst = roundMoney(summary.cgst + Number(line.cgst || 0));
      summary.sgst = roundMoney(summary.sgst + Number(line.sgst || 0));
      summary.igst = roundMoney(summary.igst + Number(line.igst || 0));
      summary.total_tax = roundMoney(summary.cgst + summary.sgst + summary.igst);
      summary.total = roundMoney(summary.total + Number(line.total || 0));
      hsnSummary.set(summaryKey, summary);
    }
  }

  // Sheet 3: HSN Summary
  const hsnSheet = workbook.addWorksheet('HSN Summary');
  hsnSheet.columns = [
    { header: 'Place of Supply Code', key: 'place_of_supply_code', width: 18 },
    { header: 'Place of Supply State', key: 'place_of_supply_name', width: 22 },
    { header: 'HSN/SAC', key: 'hsn_sac', width: 14 },
    { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Total Tax', key: 'total_tax', width: 16 },
    { header: 'Total', key: 'total', width: 18 },
  ];
  for (const summary of hsnSummary.values()) hsnSheet.addRow(summary);

  // Sheet 4: State-Wise Place of Supply Summary
  const stateSheet = workbook.addWorksheet('State-Wise Summary');
  stateSheet.columns = [
    { header: 'State Code', key: 'place_of_supply_code', width: 14 },
    { header: 'State Name', key: 'place_of_supply_name', width: 26 },
    { header: 'Documents Count', key: 'document_count', width: 16 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Total Tax', key: 'total_tax', width: 16 },
    { header: 'Invoice Total', key: 'total', width: 18 },
  ];
  for (const st of stateSummary.values()) stateSheet.addRow(st);

  // Sheet 5: Expense Register
  const expensesSheet = workbook.addWorksheet('Expense Register');
  expensesSheet.columns = [
    { header: 'Date', key: 'incurred_on', width: 14 },
    { header: 'Vendor', key: 'vendor_name', width: 28 },
    { header: 'Supplier GSTIN', key: 'supplier_gstin', width: 20 },
    { header: 'Reference', key: 'document_reference', width: 18 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Description', key: 'description', width: 36 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Total', key: 'total', width: 18 },
    { header: 'ITC Eligible', key: 'itc_eligible', width: 14 },
  ];
  for (const row of expenses) expensesSheet.addRow(row);

  const [[sales]] = await pool.query(
    `SELECT COALESCE(SUM(taxable_value), 0) AS taxable_sales, COALESCE(SUM(cgst), 0) AS cgst,
            COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(igst), 0) AS igst,
            COALESCE(SUM(total), 0) AS invoice_total
     FROM gst_documents WHERE status = 'issued' AND issue_date BETWEEN ? AND ?`,
    [from, to]
  );
  const [[expenseTotals]] = await pool.query(
    `SELECT COALESCE(SUM(total), 0) AS total_expenses,
            COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN cgst + sgst + igst ELSE 0 END), 0) AS eligible_itc,
            COALESCE(SUM(taxable_value + CASE WHEN itc_eligible = 1 THEN 0 ELSE cgst + sgst + igst END), 0) AS p_and_l_expenses
     FROM gst_expenses WHERE is_deleted = 0 AND incurred_on BETWEEN ? AND ?`,
    [from, to]
  );

  // Sheet 6: Period Summary
  const summarySheet = workbook.addWorksheet('Period Summary');
  summarySheet.addRows([
    ['CA Working Papers — not a filed GST return'],
    ['Period From', from],
    ['Period To', to],
    ['Taxable Sales (incl. credit notes)', Number(sales.taxable_sales)],
    ['CGST', Number(sales.cgst)],
    ['SGST', Number(sales.sgst)],
    ['IGST', Number(sales.igst)],
    ['Invoice Total (incl. credit notes)', Number(sales.invoice_total)],
    ['Entered Expenses', Number(expenseTotals.total_expenses)],
    ['Eligible ITC (as marked by admin)', Number(expenseTotals.eligible_itc)],
    ['Net GST Liability (Outward Tax - Eligible ITC)', roundMoney(Number(sales.cgst) + Number(sales.sgst) + Number(sales.igst) - Number(expenseTotals.eligible_itc))],
    ['Estimated Profit / (Loss)', roundMoney(Number(sales.taxable_sales) - Number(expenseTotals.p_and_l_expenses))],
    ['Important', 'Profit/loss excludes costs not entered in the Expense Register. Review tax classification and ITC eligibility with your CA.'],
  ]);

  for (const sheet of [salesSheet, invoiceLinesSheet, hsnSheet, stateSheet, expensesSheet]) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Bhumivera_GST_Working_Papers_${from}_${to}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[GST_ACCOUNTING]', error);
  res.status(status).json({ message: status === 500 ? 'GST accounting operation failed.' : error.message });
});

module.exports = router;
