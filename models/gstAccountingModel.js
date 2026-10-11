const pool = require('../config/db');

const addColumnIfMissing = async (table, column, definition) => {
  const [columns] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
  if (!columns.some(existing => existing.Field === column)) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
};

const initGstAccountingTables = async () => {
  await addColumnIfMissing('products', 'gst_hsn_code', 'VARCHAR(8) DEFAULT NULL');
  await addColumnIfMissing('products', 'gst_rate', 'DECIMAL(5,2) DEFAULT NULL');
  await addColumnIfMissing('order_items', 'gst_hsn_code', 'VARCHAR(8) DEFAULT NULL');
  await addColumnIfMissing('order_items', 'gst_rate', 'DECIMAL(5,2) DEFAULT NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gst_business_profile (
      id TINYINT PRIMARY KEY,
      legal_name VARCHAR(255) DEFAULT NULL,
      gstin VARCHAR(15) DEFAULT NULL,
      address TEXT DEFAULT NULL,
      state_code CHAR(2) DEFAULT NULL,
      state_name VARCHAR(100) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      phone VARCHAR(30) DEFAULT NULL,
      invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'BV',
      next_invoice_number INT UNSIGNED NOT NULL DEFAULT 1,
      shipping_sac VARCHAR(8) DEFAULT NULL,
      shipping_gst_rate DECIMAL(5,2) DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
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
     SET legal_name = ?, gstin = ?, address = ?, state_code = ?, state_name = ?,
         email = ?, phone = ?, invoice_prefix = ?, shipping_sac = ?, shipping_gst_rate = ?, updated_by = ?
     WHERE id = 1`,
    [
      profile.legal_name, profile.gstin, profile.address, profile.state_code, profile.state_name,
      profile.email, profile.phone, profile.invoice_prefix, profile.shipping_sac,
      profile.shipping_gst_rate, adminId,
    ]
  );
  return getBusinessProfile();
};

const getGstProducts = async ({ search = '' } = {}) => {
  const term = String(search).trim();
  const [products] = await pool.query(
    `SELECT id, name, sku, gst_hsn_code, gst_rate
     FROM products
     WHERE (? = '' OR name LIKE ? OR sku LIKE ?)
     ORDER BY name`,
    [term, `%${term}%`, `%${term}%`]
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

const listOrdersForInvoicing = async () => {
  const [orders] = await pool.query(`
    SELECT o.id, o.status, o.created_at, o.total, o.shipping_cost, o.impact_amount,
           u.name AS customer_name, u.email AS customer_email
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN gst_documents gd ON gd.order_id = o.id AND gd.document_type = 'invoice'
    WHERE gd.id IS NULL AND o.status IN ('shipped', 'delivered')
    ORDER BY o.created_at DESC
    LIMIT 500
  `);
  return orders;
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
    `SELECT id, order_id, document_number, document_type, status, issue_date,
            taxable_value, cgst, sgst, igst, total, created_at
     FROM gst_documents
     WHERE issue_date BETWEEN ? AND ?
     ORDER BY issue_date DESC, id DESC`,
    [from, to]
  );
  return documents;
};

const getDocumentById = async id => {
  const [[document]] = await pool.query(
    `SELECT d.*, original.document_number AS original_document_number
     FROM gst_documents d
     LEFT JOIN gst_documents original ON original.id = d.original_document_id
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
  return document;
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
  initGstAccountingTables,
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
};
