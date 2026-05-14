// backend/config/db.js
const mysql = require("mysql2");
require("dotenv").config();

const pool = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
  })
  .promise();

// --- ZERO-REGRESSION AUTO-MIGRATION ---
// Automatically provisions missing tables required for the Auth Flow on Railway
const initializeDatabase = async () => {
  try {
    const createPendingRegistrationsTable = `
      CREATE TABLE IF NOT EXISTS pending_registrations (
        email VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        otp VARCHAR(10) NOT NULL,
        otp_expiry DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    
    await pool.query(createPendingRegistrationsTable);
    console.log("✅ Database Verified: 'pending_registrations' table is active and ready.");
  } catch (err) {
    console.error("❌ Critical Database Initialization Error:", err.message);
  }
};

// Execute schema verification on boot
initializeDatabase();

module.exports = pool;
