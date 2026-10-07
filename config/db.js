const mysql = require("mysql2");

const pool = mysql
  .createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "bhumivera",
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  })
  .promise();

module.exports = pool;
