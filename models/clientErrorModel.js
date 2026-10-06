const pool = require('../config/db');

let tablePromise;

const createClientErrorTable = async () => {
  if (!tablePromise) tablePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS client_error_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      message VARCHAR(2000) NOT NULL,
      source VARCHAR(500) DEFAULT NULL,
      line_number INT DEFAULT NULL,
      column_number INT DEFAULT NULL,
      page_url VARCHAR(1000) DEFAULT NULL,
      stack TEXT DEFAULT NULL,
      user_agent VARCHAR(500) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_client_error_created_at (created_at)
    )
  `).catch(error => {
    tablePromise = null;
    throw error;
  });
  return tablePromise;
};

const createClientError = async (error) => {
  await createClientErrorTable();
  const [result] = await pool.query(
    `INSERT INTO client_error_logs
      (message, source, line_number, column_number, page_url, stack, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [error.message, error.source, error.lineNumber, error.columnNumber, error.pageUrl, error.stack, error.userAgent]
  );
  return result.insertId;
};

const getClientErrors = async (limit = 100) => {
  await createClientErrorTable();
  const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 100));
  const [rows] = await pool.query(
    `SELECT id, message, source, line_number, column_number, page_url, stack, user_agent, created_at
     FROM client_error_logs ORDER BY created_at DESC LIMIT ?`,
    [safeLimit]
  );
  return rows;
};

module.exports = { createClientErrorTable, createClientError, getClientErrors };