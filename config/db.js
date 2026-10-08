const mysql = require("mysql2");

const connectionLimit = process.env.DB_POOL_SIZE === undefined
  ? 5
  : Number(process.env.DB_POOL_SIZE);

if (!Number.isSafeInteger(connectionLimit) || connectionLimit < 1) {
  throw new Error("DB_POOL_SIZE must be a positive integer.");
}

const pool = mysql
  .createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "bhumivera",
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    waitForConnections: true,
    connectionLimit,
    maxIdle: Math.min(connectionLimit, 2),
    queueLimit: 0,
    connectTimeout: 10000,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  })
  .promise();

module.exports = pool;
