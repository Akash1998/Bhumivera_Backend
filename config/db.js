const pool = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    // Add these lines to allow Railway to sleep:
    idleTimeout: 60000, // Closes idle connections after 60 seconds
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  })
  .promise();
