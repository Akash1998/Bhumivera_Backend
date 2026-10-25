const mysql = require("mysql2");
const { resolveDatabaseConfig } = require("./environment");
const database = resolveDatabaseConfig();

const connectionLimit = process.env.DB_POOL_SIZE === undefined
  ? 3
  : Number(process.env.DB_POOL_SIZE);

if (!Number.isSafeInteger(connectionLimit) || connectionLimit < 1) {
  throw new Error("DB_POOL_SIZE must be a positive integer.");
}

const databasePort = database.port === undefined ? 3306 : Number(database.port);
if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535) {
  throw new Error(`${database.railway ? "MYSQLPORT" : "DB_PORT"} must be an integer between 1 and 65535.`);
}

const sslDisabled = database.privateRailwayHost || process.env.DB_SSL?.toLowerCase() === "false";
const loadSslCa = () => {
  if (process.env.DB_SSL_CA_BASE64) {
    return Buffer.from(process.env.DB_SSL_CA_BASE64, "base64").toString("utf8");
  }
  if (process.env.DB_SSL_CA_FILE) {
    return require("fs").readFileSync(require("path").resolve(process.env.DB_SSL_CA_FILE), "utf8");
  }
  if (process.env.DB_SSL_CA) {
    return process.env.DB_SSL_CA.replace(/\\n/g, "\n");
  }
  return undefined;
};
const sslCa = sslDisabled ? undefined : loadSslCa();
const ssl = sslDisabled
  ? undefined
  : {
      rejectUnauthorized: true,
      // A custom `ca` replaces Node's defaults, so keep the bundled roots alongside it.
      ca: [...require("tls").rootCertificates, ...(sslCa ? [sslCa] : [])]
    };

// Default to 0 idle connections in serverless/sleeping environments so sockets close when inactive.
const maxIdle = process.env.DB_MAX_IDLE !== undefined
  ? Math.max(0, Number(process.env.DB_MAX_IDLE))
  : 0;
const queueLimit = 100;
const idleTimeout = Number(process.env.DB_IDLE_TIMEOUT) || 10000;
// KeepAlive packets reset cloud provider inactivity timers; keep disabled for serverless/app-sleeping.
const enableKeepAlive = process.env.DB_ENABLE_KEEP_ALIVE === "true";

const pool = mysql
  .createPool({
    host: database.host || "localhost",
    user: database.user || "root",
    password: database.password || "",
    database: database.database || "bhumivera",
    port: databasePort,
    waitForConnections: true,
    connectionLimit,
    maxIdle,
    queueLimit,
    connectTimeout: 10000,
    ssl,
    idleTimeout,
    enableKeepAlive,
    keepAliveInitialDelay: 0
  })
  .promise();

pool.appConfig = { connectionLimit, maxIdle, queueLimit, idleTimeout, enableKeepAlive };

module.exports = pool;
