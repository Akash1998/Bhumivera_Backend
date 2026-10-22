// config/db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

// Support both DB_* and TIDB_* environment variable naming conventions
const dbHost = process.env.TIDB_HOST || process.env.DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.TIDB_PORT || process.env.DB_PORT || 4000);
const dbUser = process.env.TIDB_USER || process.env.DB_USER || 'root';
const dbPassword = process.env.TIDB_PASSWORD || process.env.DB_PASSWORD || process.env.DB_PASS || '';
const dbName = process.env.TIDB_DATABASE || process.env.DB_NAME || process.env.DB_DATABASE || 'bhumivera';

// Enable TLS 1.2+ automatically for TiDB Cloud (Port 4000) or when DB_SSL is enabled
const useSsl =
  process.env.DB_SSL === 'true' ||
  process.env.TIDB_ENABLE_SSL === 'true' ||
  dbPort === 4000 ||
  dbHost.includes('tidbcloud.com');

const sslConfig = useSsl
  ? {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {})
    }
  : undefined;

const poolConfig = {
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  ssl: sslConfig,
  waitForConnections: true,
  // Keep pool small per serverless instance to prevent TiDB connection spikes; larger on persistent servers
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || (isVercel ? 3 : 20),
  maxIdle: isVercel ? 3 : 10,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 10000,
  timezone: '+00:00',
  dateStrings: false
};

// Singleton pool across warm serverless invocations
const rawPool =
  globalThis.__bhumiveraDbPool ||
  (process.env.DATABASE_URL
    ? mysql.createPool({
        uri: process.env.DATABASE_URL,
        ssl: sslConfig,
        waitForConnections: true,
        connectionLimit: poolConfig.connectionLimit,
        maxIdle: poolConfig.maxIdle,
        idleTimeout: 60000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: 10000
      })
    : mysql.createPool(poolConfig));

if (!globalThis.__bhumiveraDbPool) {
  globalThis.__bhumiveraDbPool = rawPool;
}

// Transient network errors common when serverless functions unfreeze after idle
const RETRYABLE_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
]);

const originalQuery = rawPool.query.bind(rawPool);
const originalExecute = rawPool.execute.bind(rawPool);

// Auto-retry wrapper for query() on stale serverless socket
rawPool.query = async function (...args) {
  try {
    return await originalQuery(...args);
  } catch (err) {
    if ( err && RETRYABLE_ERRORS.has(err.code) ) {
      console.warn(`[DB] Retrying query after transient socket error: ${err.code}`);
      return await originalQuery(...args);
    }
    throw err;
  }
};

// Auto-retry wrapper for execute() on stale serverless socket
rawPool.execute = async function (...args) {
  try {
    return await originalExecute(...args);
  } catch (err) {
    if ( err && RETRYABLE_ERRORS.has(err.code) ) {
      console.warn(`[DB] Retrying execute after transient socket error: ${err.code}`);
      return await originalExecute(...args);
    }
    throw err;
  }
};

// Lightweight health check helper
async function testConnection() {
  const start = Date.now();
  await rawPool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - start };
}

// Attach named references so both default and destructured imports work seamlessly
rawPool.pool = rawPool;
rawPool.db = rawPool;
rawPool.testConnection = testConnection;
rawPool.pingDb = testConnection;

module.exports = rawPool;
