const mysql = require("mysql2");

const connectionLimit = process.env.DB_POOL_SIZE === undefined
  ? 2
  : Number(process.env.DB_POOL_SIZE);

if (!Number.isSafeInteger(connectionLimit) || connectionLimit < 1) {
  throw new Error("DB_POOL_SIZE must be a positive integer.");
}

const databasePort = process.env.DB_PORT === undefined ? 3306 : Number(process.env.DB_PORT);
if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535) {
  throw new Error("DB_PORT must be an integer between 1 and 65535.");
}

const sslDisabled = process.env.DB_SSL?.toLowerCase() === "false";
const ssl = sslDisabled
  ? undefined
  : {
      rejectUnauthorized: true,
      ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, "\n") } : {})
    };

const maxIdle = Math.min(connectionLimit, 1);
const queueLimit = 100;
const pool = mysql
  .createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "bhumivera",
    port: databasePort,
    waitForConnections: true,
    connectionLimit,
    maxIdle,
    queueLimit,
    connectTimeout: 10000,
    ssl,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  })
  .promise();

pool.appConfig = { connectionLimit, maxIdle, queueLimit };

module.exports = pool;
