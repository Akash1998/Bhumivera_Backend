const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const {
  getBusinessProfile,
  updateBusinessProfile,
  getGstProducts,
  updateGstProduct,
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
  ['uttarakhand', '05'], ['haryana', '06'], ['delhi', '07'], ['rajasthan', '08'],
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
  const invoicePrefix = body.invoice_prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  if (!invoicePrefix) {
    throw Object.assign(new Error('Invoice prefix must contain at least one letter or number.'), { status: 400 });
  }
  return {
    legal_name: body.legal_name.trim(),
    gstin,
    address: body.address.trim(),
    state_code: body.state_code,
    state_name: body.state_name.trim(),
    email: String(body.email || '').trim() || null,
    phone: String(body.phone || '').trim() || null,
    invoice_prefix: invoicePrefix,
    shipping_sac: String(body.shipping_sac || '').trim() || null,
    shipping_gst_rate: shippingRate,
  };
};

const issueInvoice = async (orderId, adminId) => {
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
    if (order.items.some(item => Number(item.is_gift))) {
      throw Object.assign(new Error('This order contains a gift/free item. Verify its tax treatment with your CA before issuing an invoice.'), { status: 409 });
    }
    const buyerStateCode = getAddressStateCode(order.address_snapshot);
    if (!buyerStateCode) {
      throw Object.assign(new Error('The customer shipping address has no recognized Indian state; update the address before invoicing.'), { status: 409 });
    }
    for (const item of order.items) {
      if (!item.is_gift && (!item.gst_hsn_code || item.gst_rate === null)) {
        throw Object.assign(new Error(`Set and verify the HSN/SAC and GST rate for "${item.name}" before issuing its invoice.`), { status: 409 });
      }
      if (!item.is_gift && (!/^\d{4}(?:\d{2}){0,2}$/.test(item.gst_hsn_code) ||
        !Number.isFinite(Number(item.gst_rate)) || Number(item.gst_rate) < 0 || Number(item.gst_rate) > 100)) {
        throw Object.assign(new Error(`The HSN/SAC or GST rate for "${item.name}" is invalid.`), { status: 409 });
      }
    }
    const shippingGross = roundMoney(order.shipping_cost || 0);
    if (shippingGross > 0 && (!profile.shipping_sac || profile.shipping_gst_rate === null)) {
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
        hsn_sac: item.gst_hsn_code,
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
      const rate = Number(profile.shipping_gst_rate);
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
        hsn_sac: profile.shipping_sac,
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
      legal_name: profile.legal_name, gstin: profile.gstin, address: profile.address,
      state_code: profile.state_code, state_name: profile.state_name, email: profile.email, phone: profile.phone,
    };
    const buyerSnapshot = {
      name: order.address_snapshot?.full_name || order.customer_name || 'Customer',
      gstin: order.address_snapshot?.gstin || null,
      email: order.address_snapshot?.email || order.customer_email || null,
      phone: order.address_snapshot?.phone || order.address_snapshot?.phone_number || order.customer_phone || null,
      address: order.address_snapshot,
      state_code: buyerStateCode,
      place_of_supply: order.address_snapshot?.state || order.address_snapshot?.state_name || buyerStateCode,
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

router.get('/orders-to-invoice', asyncRoute(async (req, res) => res.json(await listOrdersForInvoicing())));

router.get('/documents', asyncRoute(async (req, res) => {
  const range = dateRange(req.query);
  res.json(await listDocuments(range));
}));

router.post('/orders/:id/invoice', asyncRoute(async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({ message: 'Invalid order ID.' });
  const document = await issueInvoice(orderId, req.admin.id);
  res.status(201).json(document);
}));

router.get('/documents/:id', asyncRoute(async (req, res) => {
  const document = await getDocumentById(req.params.id);
  if (!document) return res.status(404).json({ message: 'Invoice not found.' });
  res.json(document);
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

router.get('/reports', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
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
  res.json({
    period: { from, to },
    sales,
    expenses: expenseTotals,
    estimated_profit_loss: roundMoney(Number(sales.taxable_sales) - Number(expenseTotals.profit_and_loss_expenses)),
    monthly,
    notes: [
      'Credit notes are included as negative sales values.',
      'Profit/loss uses entered expenses only; enter cost of goods sold, payroll, fees, and other costs for a complete result.',
      'This workbook is a CA working paper, not a filed or portal-validated GST return.',
    ],
  });
}));

router.get('/reports/export.xlsx', asyncRoute(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bhumivera Admin';
  workbook.created = new Date();
  const salesSheet = workbook.addWorksheet('Sales Register');
  salesSheet.columns = [
    { header: 'Document No.', key: 'document_number', width: 24 },
    { header: 'Type', key: 'document_type', width: 16 },
    { header: 'Issue Date', key: 'issue_date', width: 14 },
    { header: 'Order ID', key: 'order_id', width: 14 },
    { header: 'Customer', key: 'customer_name', width: 28 },
    { header: 'Buyer GSTIN', key: 'buyer_gstin', width: 20 },
    { header: 'Place of Supply', key: 'place_of_supply_code', width: 18 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Invoice Total', key: 'total', width: 18 },
  ];
  const [documents] = await pool.query(
    `SELECT d.id, d.document_number, d.document_type, d.issue_date, d.order_id,
            d.place_of_supply_code, d.buyer_snapshot, d.line_items, d.taxable_value,
            d.cgst, d.sgst, d.igst, d.total, original.document_number AS original_document_number
     FROM gst_documents d
     LEFT JOIN gst_documents original ON original.id = d.original_document_id
     WHERE d.status = 'issued' AND d.issue_date BETWEEN ? AND ?
     ORDER BY d.issue_date, d.id`,
    [from, to]
  );
  const invoiceLinesSheet = workbook.addWorksheet('Invoice Lines');
  invoiceLinesSheet.columns = [
    { header: 'Document No.', key: 'document_number', width: 24 },
    { header: 'Original Document No.', key: 'original_document_number', width: 24 },
    { header: 'Issue Date', key: 'issue_date', width: 14 },
    { header: 'Customer', key: 'customer_name', width: 28 },
    { header: 'Buyer GSTIN', key: 'buyer_gstin', width: 20 },
    { header: 'Place of Supply', key: 'place_of_supply_code', width: 18 },
    { header: 'Description', key: 'description', width: 34 },
    { header: 'HSN/SAC', key: 'hsn_sac', width: 14 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Line Total', key: 'total', width: 18 },
  ];
  const hsnSummary = new Map();
  for (const document of documents) {
    const buyer = typeof document.buyer_snapshot === 'string'
      ? JSON.parse(document.buyer_snapshot)
      : document.buyer_snapshot;
    const lines = typeof document.line_items === 'string'
      ? JSON.parse(document.line_items)
      : document.line_items;
    salesSheet.addRow({
      ...document,
      original_document_number: document.original_document_number || '',
      customer_name: buyer?.name || '',
      buyer_gstin: buyer?.gstin || '',
    });
    for (const line of lines) {
      invoiceLinesSheet.addRow({
        document_number: document.document_number,
        issue_date: document.issue_date,
        customer_name: buyer?.name || '',
        buyer_gstin: buyer?.gstin || '',
        place_of_supply_code: document.place_of_supply_code,
        ...line,
      });
      const summaryKey = `${document.place_of_supply_code}|${line.hsn_sac || ''}|${line.gst_rate || 0}`;
      const summary = hsnSummary.get(summaryKey) || {
        place_of_supply_code: document.place_of_supply_code,
        hsn_sac: line.hsn_sac || '',
        gst_rate: Number(line.gst_rate || 0),
        quantity: 0,
        taxable_value: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: 0,
      };
      summary.quantity += Number(line.quantity || 0);
      summary.taxable_value += Number(line.taxable_value || 0);
      summary.cgst += Number(line.cgst || 0);
      summary.sgst += Number(line.sgst || 0);
      summary.igst += Number(line.igst || 0);
      summary.total += Number(line.total || 0);
      hsnSummary.set(summaryKey, summary);
    }
  }
  const hsnSheet = workbook.addWorksheet('HSN Summary');
  hsnSheet.columns = [
    { header: 'Place of Supply', key: 'place_of_supply_code', width: 18 },
    { header: 'HSN/SAC', key: 'hsn_sac', width: 14 },
    { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Taxable Value', key: 'taxable_value', width: 18 },
    { header: 'CGST', key: 'cgst', width: 14 },
    { header: 'SGST', key: 'sgst', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 },
    { header: 'Total', key: 'total', width: 18 },
  ];
  for (const summary of hsnSummary.values()) hsnSheet.addRow(summary);

  const [expenses] = await pool.query(
    `SELECT incurred_on, vendor_name, supplier_gstin, document_reference, category,
            description, taxable_value, cgst, sgst, igst, total, itc_eligible
     FROM gst_expenses WHERE is_deleted = 0 AND incurred_on BETWEEN ? AND ?
     ORDER BY incurred_on, id`,
    [from, to]
  );
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
    ['Estimated Profit / (Loss)', roundMoney(Number(sales.taxable_sales) - Number(expenseTotals.p_and_l_expenses))],
    ['Important', 'Profit/loss excludes costs not entered in the Expense Register. Review tax classification and ITC eligibility with your CA.'],
  ]);
  for (const sheet of [salesSheet, invoiceLinesSheet, hsnSheet, expensesSheet]) {
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
