let pool = null; try { pool = require('../config/db'); } catch { pool = null; }
const { computeQuantumHash512 } = require('../utils/quantumCrypto');

const INDIAN_STATE_NAMES = {
  '01': 'Jammu and Kashmir',
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
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

const addColumnIfMissing = async (table, column, definition) => {
  const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
  if (!columns.some(existing => existing.Field === column)) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
};

/**
 * Converts a numeric INR amount into formal Indian Rupee words
 * (e.g., "Rupees Two Thousand Four Hundred Fifty and Paise Fifty Only").
 */
function numberToIndianRupeeWords(amount) {
  const numeric = Math.abs(Number(amount || 0));
  if (!Number.isFinite(numeric) || numeric === 0) {
    return 'Rupees Zero Only';
  }

  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = [
    '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
  ];

  const twoDigits = n => {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    const t = Math.floor(n / 10);
    const o = n % 10;
    return `${tens[t]}${o ? ` ${ones[o]}` : ''}`;
  };

  const threeDigits = n => {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    const hPart = h > 0 ? `${ones[h]} Hundred` : '';
    const rPart = twoDigits(rem);
    return [hPart, rPart].filter(Boolean).join(' ');
  };

  const rupeesInt = Math.floor(numeric);
  const paiseInt = Math.round((numeric - rupeesInt) * 100);

  const parts = [];
  let rem = rupeesInt;

  const crore = Math.floor(rem / 10000000);
  rem %= 10000000;
  if (crore > 0) parts.push(`${threeDigits(crore)} Crore`);

  const lakh = Math.floor(rem / 100000);
  rem %= 100000;
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);

  const thousand = Math.floor(rem / 1000);
  rem %= 1000;
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);

  if (rem > 0) parts.push(threeDigits(rem));

  const rupeeText = parts.length ? parts.join(' ') : 'Zero';
  const paiseText = paiseInt > 0 ? ` and Paise ${twoDigits(paiseInt)}` : '';
  return `Rupees ${rupeeText}${paiseText} Only`;
}

/**
 * Enriches a raw gst_documents row with expanded B2B/B2C, HSN summary, QR payload,
 * 512-bit verification hash, and Indian Rupee amount in words.
 */
function enrichGstDocument(doc) {
  if (!doc) return null;
  const enriched = { ...doc };

  for (const field of ['seller_snapshot', 'buyer_snapshot', 'line_items']) {
    if (typeof enriched[field] === 'string') {
      try {
        enriched[field] = JSON.parse(enriched[field]);
      } catch {
        enriched[field] = field === 'line_items' ? [] : {};
      }
    }
  }

  const seller = enriched.seller_snapshot || {};
  const buyer = enriched.buyer_snapshot || {};
  const lines = Array.isArray(enriched.line_items) ? enriched.line_items : [];
  const address = buyer.address && typeof buyer.address === 'object' ? buyer.address : {};

  const sellerStateCode = String(seller.state_code || '19').padStart(2, '0');
  const posCode = String(enriched.place_of_supply_code || buyer.state_code || sellerStateCode).padStart(2, '0');
  const posName =
    INDIAN_STATE_NAMES[posCode] ||
    buyer.place_of_supply ||
    address.state ||
    address.state_name ||
    'West Bengal';
  const isInterstate = sellerStateCode !== posCode;
  const buyerGstin = buyer.gstin ? String(buyer.gstin).trim().toUpperCase() : null;
  const invoiceTotalVal = Number(enriched.total ?? enriched.invoice_total ?? 0);
  enriched.total = invoiceTotalVal;
  enriched.invoice_total = invoiceTotalVal;
  const absTotal = Math.abs(invoiceTotalVal);

  let supplyType = 'B2CS';
  if (buyerGstin && /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(buyerGstin)) {
    supplyType = 'B2B';
  } else if (isInterstate && absTotal > 250000) {
    supplyType = 'B2CL';
  }

  // Group HSN-wise breakup for statutory tax table on invoice
  const hsnMap = new Map();
  let totalQuantity = 0;
  for (const line of lines) {
    const hsn = String(line.hsn_sac || line.hsn_code || '33049990');
    const rate = Number(line.gst_rate || 0);
    const key = `${hsn}|${rate}`;
    const current = hsnMap.get(key) || {
      hsn_sac: hsn,
      hsn_code: hsn,
      gst_rate: rate,
      quantity: 0,
      taxable_value: 0,
      cgst_rate: isInterstate ? 0 : rate / 2,
      cgst: 0,
      sgst_rate: isInterstate ? 0 : rate / 2,
      sgst: 0,
      igst_rate: isInterstate ? rate : 0,
      igst: 0,
      total_tax: 0,
      total: 0,
    };
    const qty = Number(line.quantity || 0);
    const txVal = Number(line.taxable_value || 0);
    const cg = Number(line.cgst ?? line.cgst_amount ?? 0);
    const sg = Number(line.sgst ?? line.sgst_amount ?? 0);
    const ig = Number(line.igst ?? line.igst_amount ?? 0);
    const tot = Number(line.total ?? line.line_total ?? 0);

    current.quantity += qty;
    current.taxable_value = Math.round((current.taxable_value + txVal) * 100) / 100;
    current.cgst = Math.round((current.cgst + cg) * 100) / 100;
    current.sgst = Math.round((current.sgst + sg) * 100) / 100;
    current.igst = Math.round((current.igst + ig) * 100) / 100;
    current.total_tax = Math.round((current.cgst + current.sgst + current.igst) * 100) / 100;
    current.total = Math.round((current.total + tot) * 100) / 100;
    totalQuantity += qty;
    hsnMap.set(key, current);
  }

  const hsnBreakup = Array.from(hsnMap.values());
  const hsnCodesList = Array.from(new Set(hsnBreakup.map(h => h.hsn_sac))).join(', ');
  const gstRatesList = Array.from(new Set(hsnBreakup.map(h => `${h.gst_rate}%`))).join(', ');

  const totalTax =
    Math.round(
      (Number(enriched.cgst ?? enriched.cgst_amount ?? 0) + Number(enriched.sgst ?? enriched.sgst_amount ?? 0) + Number(enriched.igst ?? enriched.igst_amount ?? 0)) * 100
    ) / 100;

  const rawOrderNum = enriched.order_number || enriched.order_id;
  const formattedOrderNumber = rawOrderNum
    ? String(rawOrderNum).toUpperCase().startsWith('BHVM')
      ? String(rawOrderNum).toUpperCase()
      : `BHVM${rawOrderNum}`
    : `BHVM${enriched.order_id}`;

  const signaturePayload = {
    document_number: enriched.document_number,
    document_type: enriched.document_type,
    order_id: enriched.order_id,
    seller_gstin: seller.gstin || '',
    buyer_gstin: buyerGstin || 'URP',
    taxable_value: Number(enriched.taxable_value || 0),
    total_tax: totalTax,
    total: Number(enriched.total || 0),
  };

  const sha512Signature = computeQuantumHash512
    ? computeQuantumHash512(signaturePayload)
    : Buffer.from(JSON.stringify(signaturePayload)).toString('hex');

  const qrVerificationPayload = [
    `DOC:${enriched.document_number}`,
    `ORD:${formattedOrderNumber}`,
    `DATE:${String(enriched.issue_date || '').slice(0, 10)}`,
    `SELLER:${seller.gstin || 'UNSET'}`,
    `BUYER:${buyerGstin || 'B2C-URP'}`,
    `POS:${posCode}-${posName}`,
    `TAXABLE:${Number(enriched.taxable_value || 0).toFixed(2)}`,
    `TAX:${totalTax.toFixed(2)}`,
    `TOTAL:${Number(enriched.total || 0).toFixed(2)}`,
    `SIG:${String(sha512Signature).slice(0, 24).toUpperCase()}`,
  ].join('|');

  return {
    ...enriched,
    order_number: enriched.order_number || String(enriched.order_id),
    formatted_order_number: formattedOrderNumber,
    customer_name: buyer.name || enriched.customer_name || 'Customer',
    customer_email: buyer.email || enriched.customer_email || '',
    customer_phone: buyer.phone || enriched.customer_phone || '',
    buyer_gstin: buyerGstin,
    billing_address_line:
      address.street_address ||
      address.address_line1 ||
      address.address ||
      address.line1 ||
      (typeof buyer.address === 'string' ? buyer.address : ''),
    billing_city: address.city || '',
    billing_state: posName,
    billing_pincode: address.postal_code || address.pincode || '',
    place_of_supply_code: posCode,
    place_of_supply_name: posName,
    supply_type: supplyType,
    supply_category: supplyType,
    is_interstate: isInterstate,
    reverse_charge: 'N',
    item_count: lines.length,
    total_quantity: totalQuantity,
    hsn_codes_list: hsnCodesList,
    gst_rates_list: gstRatesList,
    hsn_breakup: hsnBreakup,
    total_tax: totalTax,
    amount_in_words: numberToIndianRupeeWords(enriched.total),
    sha512_signature: sha512Signature,
    qr_verification_payload: qrVerificationPayload,
  };
}

const initGstAccountingTables = async () => {
  await addColumnIfMissing('products', 'gst_hsn_code', 'VARCHAR(8) DEFAULT NULL');
  await addColumnIfMissing('products', 'gst_rate', 'DECIMAL(5,2) DEFAULT NULL');
  await addColumnIfMissing('order_items', 'gst_hsn_code', 'VARCHAR(8) DEFAULT NULL');
  await addColumnIfMissing('order_items', 'gst_rate', 'DECIMAL(5,2) DEFAULT NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_business_profile (
      id TINYINT PRIMARY KEY,
      legal_name VARCHAR(255) DEFAULT NULL,
      trade_name VARCHAR(255) DEFAULT 'Bhumivera Botanicals',
      gstin VARCHAR(15) DEFAULT NULL,
      pan_number VARCHAR(15) DEFAULT NULL,
      cin_number VARCHAR(30) DEFAULT NULL,
      lut_number VARCHAR(60) DEFAULT NULL,
      address TEXT DEFAULT NULL,
      state_code CHAR(2) DEFAULT NULL,
      state_name VARCHAR(100) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      phone VARCHAR(30) DEFAULT NULL,
      invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'BV',
      next_invoice_number INT UNSIGNED NOT NULL DEFAULT 1,
      shipping_sac VARCHAR(8) DEFAULT '996812',
      shipping_gst_rate DECIMAL(5,2) DEFAULT 18.00,
      default_hsn_code VARCHAR(8) DEFAULT '33049990',
      default_gst_rate DECIMAL(5,2) DEFAULT 18.00,
      bank_name VARCHAR(120) DEFAULT NULL,
      bank_account_no VARCHAR(60) DEFAULT NULL,
      bank_ifsc VARCHAR(20) DEFAULT NULL,
      bank_branch VARCHAR(120) DEFAULT NULL,
      upi_id VARCHAR(100) DEFAULT NULL,
      authorized_signatory VARCHAR(120) DEFAULT 'Authorized Signatory — Bhumivera',
      logo_url VARCHAR(500) DEFAULT '/logo.webp',
      terms_and_conditions TEXT DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const extraProfileColumns = [
    ['trade_name', "VARCHAR(255) DEFAULT 'Bhumivera Botanicals'"],
    ['pan_number', 'VARCHAR(15) DEFAULT NULL'],
    ['cin_number', 'VARCHAR(30) DEFAULT NULL'],
    ['lut_number', 'VARCHAR(60) DEFAULT NULL'],
    ['default_hsn_code', "VARCHAR(8) DEFAULT '33049990'"],
    ['default_gst_rate', 'DECIMAL(5,2) DEFAULT 18.00'],
    ['bank_name', 'VARCHAR(120) DEFAULT NULL'],
    ['bank_account_no', 'VARCHAR(60) DEFAULT NULL'],
    ['bank_ifsc', 'VARCHAR(20) DEFAULT NULL'],
    ['bank_branch', 'VARCHAR(120) DEFAULT NULL'],
    ['upi_id', 'VARCHAR(100) DEFAULT NULL'],
    ['authorized_signatory', "VARCHAR(120) DEFAULT 'Authorized Signatory — Bhumivera'"],
    ['logo_url', "VARCHAR(500) DEFAULT '/logo.webp'"],
    ['terms_and_conditions', 'TEXT DEFAULT NULL'],
  ];
  for (const [col, def] of extraProfileColumns) {
    await addColumnIfMissing('gst_business_profile', col, def).catch(() => {});
  }

  await pool.query(`
    INSERT IGNORE INTO gst_business_profile (id, state_code, state_name) VALUES (1, '19', 'West Bengal')
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_documents (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      document_number VARCHAR(40) NOT NULL UNIQUE,
      document_type ENUM('invoice', 'credit_note') NOT NULL DEFAULT 'invoice',
      status ENUM('issued', 'cancelled') NOT NULL DEFAULT 'issued',
      issue_date DATE NOT NULL,
      seller_snapshot JSON NOT NULL,
      buyer_snapshot JSON NOT NULL,
      line_items JSON NOT NULL,
      place_of_supply_code CHAR(2) NOT NULL,
      taxable_value DECIMAL(12,2) NOT NULL,
      cgst DECIMAL(12,2) NOT NULL DEFAULT 0,
      sgst DECIMAL(12,2) NOT NULL DEFAULT 0,
      igst DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      original_document_id BIGINT DEFAULT NULL,
      reason TEXT DEFAULT NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gst_invoice_order (order_id, document_type),
      CONSTRAINT fk_gst_document_order FOREIGN KEY (order_id) REFERENCES orders(id),
      CONSTRAINT fk_gst_document_original FOREIGN KEY (original_document_id) REFERENCES gst_documents(id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_document_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      document_id BIGINT NOT NULL,
      action VARCHAR(30) NOT NULL,
      details JSON DEFAULT NULL,
      performed_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gst_document_events_document (document_id),
      CONSTRAINT fk_gst_document_event FOREIGN KEY (document_id) REFERENCES gst_documents(id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_expenses (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      incurred_on DATE NOT NULL,
      vendor_name VARCHAR(255) NOT NULL,
      supplier_gstin VARCHAR(15) DEFAULT NULL,
      document_reference VARCHAR(100) DEFAULT NULL,
      category VARCHAR(80) NOT NULL,
      description VARCHAR(500) NOT NULL,
      taxable_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      cgst DECIMAL(12,2) NOT NULL DEFAULT 0,
      sgst DECIMAL(12,2) NOT NULL DEFAULT 0,
      igst DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      itc_eligible TINYINT(1) NOT NULL DEFAULT 0,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT NOT NULL,
      updated_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gst_expenses_date (incurred_on, is_deleted)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_accounting_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      entity_type VARCHAR(30) NOT NULL,
      entity_id BIGINT NOT NULL,
      action VARCHAR(30) NOT NULL,
      details JSON DEFAULT NULL,
      performed_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gst_accounting_events_entity (entity_type, entity_id, created_at)
    )
  `);
};

const getBusinessProfile = async () => {
  const [[profile]] = await pool.query('SELECT * FROM gst_business_profile WHERE id = 1');
  return profile;
};

const updateBusinessProfile = async (profile, adminId) => {
  await pool.query(
    `UPDATE gst_business_profile
     SET legal_name = ?, trade_name = COALESCE(?, trade_name), gstin = ?,
         pan_number = COALESCE(?, pan_number), cin_number = COALESCE(?, cin_number),
         lut_number = COALESCE(?, lut_number), address = ?, state_code = ?, state_name = ?,
         email = ?, phone = ?, invoice_prefix = ?, shipping_sac = ?, shipping_gst_rate = ?,
         default_hsn_code = COALESCE(?, default_hsn_code),
         default_gst_rate = COALESCE(?, default_gst_rate),
         bank_name = COALESCE(?, bank_name),
         bank_account_no = COALESCE(?, bank_account_no),
         bank_ifsc = COALESCE(?, bank_ifsc),
         bank_branch = COALESCE(?, bank_branch),
         upi_id = COALESCE(?, upi_id),
         authorized_signatory = COALESCE(?, authorized_signatory),
         logo_url = COALESCE(?, logo_url),
         terms_and_conditions = COALESCE(?, terms_and_conditions),
         updated_by = ?
     WHERE id = 1`,
    [
      profile.legal_name,
      profile.trade_name ?? null,
      profile.gstin,
      profile.pan_number ?? null,
      profile.cin_number ?? null,
      profile.lut_number ?? null,
      profile.address,
      profile.state_code,
      profile.state_name,
      profile.email,
      profile.phone,
      profile.invoice_prefix,
      profile.shipping_sac,
      profile.shipping_gst_rate,
      profile.default_hsn_code ?? null,
      profile.default_gst_rate ?? null,
      profile.bank_name ?? null,
      profile.bank_account_no ?? null,
      profile.bank_ifsc ?? null,
      profile.bank_branch ?? null,
      profile.upi_id ?? null,
      profile.authorized_signatory ?? null,
      profile.logo_url ?? null,
      profile.terms_and_conditions ?? null,
      adminId,
    ]
  );
  return getBusinessProfile();
};

const getGstProducts = async ({ search = '' } = {}) => {
  const term = String(search).trim();
  const [products] = await pool.query(
    `SELECT p.id, p.name, p.sku, p.price, p.discount_price, p.quantity AS stock,
            p.gst_hsn_code, p.gst_rate, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE (? = '' OR p.name LIKE ? OR p.sku LIKE ? OR p.gst_hsn_code LIKE ?)
     ORDER BY p.name`,
    [term, `%${term}%`, `%${term}%`, `%${term}%`]
  );
  return products;
};

const updateGstProduct = async (id, { gst_hsn_code, gst_rate }) => {
  const [result] = await pool.query(
    'UPDATE products SET gst_hsn_code = ?, gst_rate = ? WHERE id = ?',
    [gst_hsn_code, gst_rate, id]
  );
  return result.affectedRows > 0;
};

const bulkUpdateGstProducts = async ({ productIds = [], gst_hsn_code, gst_rate, onlyUnset = false }) => {
  if (onlyUnset) {
    const [result] = await pool.query(
      `UPDATE products
       SET gst_hsn_code = COALESCE(NULLIF(gst_hsn_code, ''), ?),
           gst_rate = COALESCE(gst_rate, ?)
       WHERE gst_hsn_code IS NULL OR gst_hsn_code = '' OR gst_rate IS NULL`,
      [gst_hsn_code, gst_rate]
    );
    return result.affectedRows || 0;
  }
  if (!Array.isArray(productIds) || productIds.length === 0) return 0;
  const placeholders = productIds.map(() => '?').join(',');
  const [result] = await pool.query(
    `UPDATE products SET gst_hsn_code = ?, gst_rate = ? WHERE id IN (${placeholders})`,
    [gst_hsn_code, gst_rate, ...productIds]
  );
  return result.affectedRows || 0;
};

const listOrdersForInvoicing = async () => {
  const [orders] = await pool.query(`
    SELECT o.id, o.order_number, o.status, o.payment_mode, o.payment_status, o.payment_id,
           o.created_at, o.delivered_at, o.subtotal, o.discount, o.coupon_code,
           o.shipping_cost, o.impact_amount, o.total, o.address_snapshot,
           u.id AS customer_id, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN gst_documents gd ON gd.order_id = o.id AND gd.document_type = 'invoice'
    WHERE gd.id IS NULL AND o.status IN ('shipped', 'delivered')
    ORDER BY o.created_at DESC
    LIMIT 500
  `);

  if (!orders.length) return [];

  const orderIds = orders.map(o => o.id);
  const placeholders = orderIds.map(() => '?').join(',');
  const [allItems] = await pool.query(
    `SELECT oi.order_id, oi.id, oi.product_id, oi.name, oi.sku, oi.price, oi.quantity, oi.is_gift,
            COALESCE(oi.gst_hsn_code, p.gst_hsn_code) AS gst_hsn_code,
            COALESCE(oi.gst_rate, p.gst_rate) AS gst_rate
     FROM order_items oi
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id IN (${placeholders})
     ORDER BY oi.id`,
    orderIds
  );

  const itemsByOrder = new Map();
  for (const item of allItems) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push(item);
  }

  return orders.map(order => {
    let addr = {};
    try {
      addr = typeof order.address_snapshot === 'string'
        ? JSON.parse(order.address_snapshot)
        : (order.address_snapshot || {});
    } catch {
      addr = {};
    }
    const items = itemsByOrder.get(order.id) || [];
    const missingTaxItems = items
      .filter(it => !Number(it.is_gift) && (!it.gst_hsn_code || it.gst_rate === null || it.gst_rate === undefined))
      .map(it => it.name);
    const rawNum = order.order_number || order.id;
    const formattedOrderNumber = String(rawNum).toUpperCase().startsWith('BHVM')
      ? String(rawNum).toUpperCase()
      : `BHVM${rawNum}`;

    return {
      ...order,
      order_number: order.order_number || String(order.id),
      formatted_order_number: formattedOrderNumber,
      buyer_name: addr.full_name || order.customer_name || 'Customer',
      buyer_state: addr.state || addr.state_name || '',
      buyer_city: addr.city || '',
      buyer_pincode: addr.pincode || addr.postal_code || '',
      buyer_gstin: addr.gstin || null,
      item_count: items.length,
      items_summary: items.map(i => `${i.name} ×${i.quantity}`).join(', '),
      missing_tax_items: missingTaxItems,
      is_ready_to_invoice: missingTaxItems.length === 0 && items.length > 0,
    };
  });
};

const getOrderForInvoice = async (orderId, connection = pool) => {
  const [[order]] = await connection.query(`
    SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `, [orderId]);
  if (!order) return null;

  let address;
  try {
    address = typeof order.address_snapshot === 'string'
      ? JSON.parse(order.address_snapshot)
      : order.address_snapshot;
  } catch {
    throw Object.assign(new Error('The order address snapshot is invalid; invoice issuance is blocked.'), { status: 409 });
  }
  const [items] = await connection.query(`
    SELECT oi.id, oi.product_id, oi.name, oi.sku, oi.price, oi.quantity, oi.is_gift,
           COALESCE(oi.gst_hsn_code, p.gst_hsn_code) AS gst_hsn_code,
           COALESCE(oi.gst_rate, p.gst_rate) AS gst_rate
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `, [orderId]);
  return { ...order, address_snapshot: address, items };
};

const listDocuments = async ({ from, to }) => {
  const [documents] = await pool.query(
    `SELECT d.*, original.document_number AS original_document_number,
            o.order_number, o.payment_mode, o.payment_status, o.payment_id,
            o.coupon_code, o.discount AS order_discount, o.shipping_cost, o.subtotal AS order_subtotal
     FROM gst_documents d
     LEFT JOIN gst_documents original ON original.id = d.original_document_id
     LEFT JOIN orders o ON o.id = d.order_id
     WHERE d.issue_date BETWEEN ? AND ?
     ORDER BY d.issue_date DESC, d.id DESC`,
    [from, to]
  );
  return documents.map(enrichGstDocument);
};

const getDocumentById = async id => {
  const [[document]] = await pool.query(
    `SELECT d.*, original.document_number AS original_document_number,
            o.order_number, o.payment_mode, o.payment_status, o.payment_id,
            o.coupon_code, o.discount AS order_discount, o.shipping_cost, o.subtotal AS order_subtotal
     FROM gst_documents d
     LEFT JOIN gst_documents original ON original.id = d.original_document_id
     LEFT JOIN orders o ON o.id = d.order_id
     WHERE d.id = ?`,
    [id]
  );
  if (!document) return null;
  for (const field of ['seller_snapshot', 'buyer_snapshot', 'line_items']) {
    try {
      document[field] = typeof document[field] === 'string' ? JSON.parse(document[field]) : document[field];
    } catch {
      throw Object.assign(new Error(`Invoice ${field} data is invalid.`), { status: 500 });
    }
  }
  return enrichGstDocument(document);
};

const getExpenseById = async id => {
  const [[expense]] = await pool.query('SELECT * FROM gst_expenses WHERE id = ? AND is_deleted = 0', [id]);
  return expense || null;
};

const listExpenses = async ({ from, to }) => {
  const [expenses] = await pool.query(
    'SELECT * FROM gst_expenses WHERE is_deleted = 0 AND incurred_on BETWEEN ? AND ? ORDER BY incurred_on DESC, id DESC',
    [from, to]
  );
  return expenses;
};

const listAuditEvents = async ({ from, to }) => {
  const [events] = await pool.query(
    `SELECT id, entity_type, entity_id, action, details, performed_by, created_at
     FROM gst_accounting_events
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     UNION ALL
     SELECT id, 'document' AS entity_type, document_id AS entity_id, action, details, performed_by, created_at
     FROM gst_document_events
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY created_at DESC LIMIT 500`,
    [from, to, from, to]
  );
  for (const event of events) {
    event.details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
  }
  return events;
};

module.exports = {
  INDIAN_STATE_NAMES,
  numberToIndianRupeeWords,
  enrichGstDocument,
  initGstAccountingTables,
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
};
