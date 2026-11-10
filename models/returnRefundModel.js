const pool = require('../config/db');

const initReturnRefundTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS return_refund_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      return_id INT NOT NULL,
      order_id INT NOT NULL,
      attempt_no INT UNSIGNED NOT NULL,
      receipt VARCHAR(40) NOT NULL,
      payment_id VARCHAR(100) NOT NULL,
      provider_refund_id VARCHAR(100) NULL,
      amount_paise BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL,
      requested_by_admin_id BIGINT UNSIGNED NULL,
      requested_by_email VARCHAR(255) NULL,
      admin_notes TEXT NULL,
      failure_code VARCHAR(100) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_return_refund_attempt (return_id, attempt_no),
      UNIQUE KEY uq_return_refund_receipt (receipt),
      UNIQUE KEY uq_return_provider_refund (provider_refund_id),
      INDEX idx_return_refund_order_status (order_id, status),
      INDEX idx_return_refund_payment (payment_id)
    ) ENGINE=InnoDB
  `);
};

module.exports = { initReturnRefundTable };
