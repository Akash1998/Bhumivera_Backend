const pool = require('../config/db');

const initShippingLabelTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_carrier_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      provider ENUM('shiprocket', 'delhivery', 'bluedart') NOT NULL UNIQUE,
      credentials_ciphertext TEXT NOT NULL,
      is_enabled TINYINT(1) NOT NULL DEFAULT 0,
      updated_by INT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_labels (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      return_id INT DEFAULT NULL,
      direction ENUM('forward', 'return') NOT NULL,
      provider ENUM('shiprocket', 'delhivery', 'bluedart') NOT NULL,
      status ENUM('creating', 'booked', 'failed', 'cancelled') NOT NULL DEFAULT 'creating',
      external_order_id VARCHAR(100) DEFAULT NULL,
      external_shipment_id VARCHAR(100) DEFAULT NULL,
      tracking_number VARCHAR(100) DEFAULT NULL,
      label_url TEXT DEFAULT NULL,
      service_name VARCHAR(150) DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      package_weight DECIMAL(8,3) NOT NULL,
      package_length DECIMAL(8,2) NOT NULL,
      package_width DECIMAL(8,2) NOT NULL,
      package_height DECIMAL(8,2) NOT NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_shipping_label_order_direction (order_id, direction),
      UNIQUE KEY uq_shipping_label_return (return_id),
      INDEX idx_shipping_label_tracking (tracking_number),
      CONSTRAINT fk_shipping_label_order FOREIGN KEY (order_id) REFERENCES orders(id),
      CONSTRAINT fk_shipping_label_return FOREIGN KEY (return_id) REFERENCES returns(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_label_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      label_id BIGINT NOT NULL,
      action VARCHAR(30) NOT NULL,
      details JSON DEFAULT NULL,
      performed_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_shipping_label_events_label (label_id),
      CONSTRAINT fk_shipping_label_event FOREIGN KEY (label_id) REFERENCES shipping_labels(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

const getCarrierAccount = async provider => {
  const [[account]] = await pool.query(
    'SELECT provider, credentials_ciphertext, is_enabled, updated_at FROM shipping_carrier_accounts WHERE provider = ?',
    [provider]
  );
  return account || null;
};

const saveCarrierAccount = async ({ provider, credentialsCiphertext, enabled, adminId }) => {
  await pool.query(
    `INSERT INTO shipping_carrier_accounts (provider, credentials_ciphertext, is_enabled, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE credentials_ciphertext = VALUES(credentials_ciphertext),
       is_enabled = VALUES(is_enabled), updated_by = VALUES(updated_by)`,
    [provider, credentialsCiphertext, enabled ? 1 : 0, adminId]
  );
};

const listCarrierAccounts = async () => {
  const [accounts] = await pool.query(
    'SELECT provider, is_enabled, updated_at FROM shipping_carrier_accounts ORDER BY provider'
  );
  return accounts;
};

const beginShippingLabel = async ({ orderId, returnId, direction, provider, packageDetails, adminId }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.query(
      'SELECT id, status FROM shipping_labels WHERE order_id = ? AND direction = ? FOR UPDATE',
      [orderId, direction]
    );
    const existing = existingRows[0];
    if (existing && existing.status !== 'failed') {
      throw Object.assign(new Error('A shipping label is already being created or booked for this order/return.'), { status: 409 });
    }
    if (existing) {
      await conn.query(
        `UPDATE shipping_labels
         SET provider = ?, status = 'creating', external_order_id = NULL, external_shipment_id = NULL,
             tracking_number = NULL, label_url = NULL, service_name = NULL, error_message = NULL,
             package_weight = ?, package_length = ?, package_width = ?, package_height = ?, created_by = ?
         WHERE id = ? AND status = 'failed'`,
        [
          provider, packageDetails.weight, packageDetails.length, packageDetails.width,
          packageDetails.height, adminId, existing.id,
        ]
      );
      await conn.commit();
      return existing.id;
    }
    const [result] = await conn.query(
      `INSERT INTO shipping_labels
       (order_id, return_id, direction, provider, package_weight, package_length,
        package_width, package_height, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, returnId, direction, provider,
        packageDetails.weight, packageDetails.length, packageDetails.width, packageDetails.height, adminId,
      ]
    );
    await conn.commit();
    return result.insertId;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const updateLabelRecord = async (id, values) => {
  await pool.query(
    `UPDATE shipping_labels
     SET status = ?, external_order_id = ?, external_shipment_id = ?, tracking_number = ?,
         label_url = ?, service_name = ?, error_message = ?
     WHERE id = ?`,
    [
      values.status, values.externalOrderId || null, values.externalShipmentId || null,
      values.trackingNumber || null, values.labelUrl || null, values.serviceName || null,
      values.errorMessage || null, id,
    ]
  );
};

const getShippingLabel = async id => {
  const [[label]] = await pool.query('SELECT * FROM shipping_labels WHERE id = ?', [id]);
  return label || null;
};

const getShippingLabels = async ({ orderId, returnId }) => {
  let query = 'SELECT * FROM shipping_labels';
  const params = [];
  if (orderId) {
    query += ' WHERE order_id = ?';
    params.push(orderId);
  } else if (returnId) {
    query += ' WHERE return_id = ?';
    params.push(returnId);
  } else {
    query += ' ORDER BY created_at DESC LIMIT 200';
  }
  if (params.length) query += ' ORDER BY created_at DESC';
  const [labels] = await pool.query(query, params);
  return labels;
};

const logShippingLabelEvent = async (labelId, action, details, adminId) => {
  await pool.query(
    'INSERT INTO shipping_label_events (label_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
    [labelId, action, JSON.stringify(details), adminId]
  );
};

module.exports = {
  initShippingLabelTables,
  getCarrierAccount,
  saveCarrierAccount,
  listCarrierAccounts,
  beginShippingLabel,
  updateLabelRecord,
  getShippingLabel,
  getShippingLabels,
  logShippingLabelEvent,
};
