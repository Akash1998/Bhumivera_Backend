const PLACEHOLDER_SECRETS = new Set([
  'fallback_secret',
  'replace_with_a_long_random_secret_at_least_32_chars',
  'your_secret',
  'changeme',
  'change_me',
]);

const resolveDatabaseConfig = (env = process.env) => {
  const railway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const host = railway ? env.MYSQLHOST : env.DB_HOST;
  return {
    railway,
    host,
    user: railway ? env.MYSQLUSER : env.DB_USER,
    password: railway ? env.MYSQLPASSWORD : env.DB_PASSWORD,
    database: railway ? env.MYSQLDATABASE : env.DB_NAME,
    port: railway ? env.MYSQLPORT : env.DB_PORT,
    privateRailwayHost: railway && typeof host === 'string' && /\.railway\.internal$/i.test(host.trim()),
  };
};

const parseOrigins = (value, fallbackOrigins, nodeEnv = process.env.NODE_ENV) => {
  const origins = (value || fallbackOrigins.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`FRONTEND_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.username || parsed.password || parsed.pathname !== '/' ||
        parsed.search || parsed.hash) {
      throw new Error(`FRONTEND_ORIGINS entries must be exact HTTP(S) origins: ${origin}`);
    }
    if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
      throw new Error(`FRONTEND_ORIGINS must use HTTPS in production: ${origin}`);
    }
  }
  return [...new Set(origins)];
};

const validateProductionEnvironment = env => {
  if (env.NODE_ENV !== 'production') return [];

  const errors = [];
  const database = resolveDatabaseConfig(env);
  const requireSecret = (name, { distinctFrom, required = true } = {}) => {
    const value = env[name]?.trim();
    if (!value) {
      if (required) errors.push(`${name} is required in production.`);
    } else if (value.length < 32 || PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
      errors.push(`${name} must be a non-placeholder secret of at least 32 characters.`);
    }
    if (value && distinctFrom && value === env[distinctFrom]?.trim()) {
      errors.push(`${name} must be different from ${distinctFrom}.`);
    }
  };

  requireSecret('JWT_SECRET');
  requireSecret('OTP_SECRET', { distinctFrom: 'JWT_SECRET', required: false });
  const databaseVariables = database.railway
    ? [['MYSQLHOST', database.host], ['MYSQLUSER', database.user], ['MYSQLDATABASE', database.database]]
    : [['DB_HOST', database.host], ['DB_USER', database.user], ['DB_NAME', database.database]];
  for (const [name, value] of databaseVariables) {
    if (!value?.trim()) errors.push(`${name} is required in production.`);
  }
  const passwordVariable = database.railway ? 'MYSQLPASSWORD' : 'DB_PASSWORD';
  if (!database.password?.trim()) errors.push(`${passwordVariable} is required in production.`);
  if (database.host?.trim() && /\$\{\{[^}]+\}\}|\$\{[^}]+\}/.test(database.host)) {
    errors.push(`${database.railway ? 'MYSQLHOST' : 'DB_HOST'} contains an unresolved environment-variable placeholder.`);
  }
  if (env.DB_SSL?.toLowerCase() === 'false' && !database.privateRailwayHost) {
    errors.push('DB_SSL cannot be disabled in production except for a Railway private database host.');
  }
  if (env.DB_SSL !== undefined && !['true', 'false'].includes(env.DB_SSL.toLowerCase())) {
    errors.push('DB_SSL must be set to true or false.');
  }

  for (const [name, value] of [['PORT', env.PORT], [database.railway ? 'MYSQLPORT' : 'DB_PORT', database.port]]) {
    if (value !== undefined && value !== '') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`${name} must be an integer between 1 and 65535.`);
      }
    }
  }

  if (Boolean(env.RAZORPAY_KEY_ID?.trim()) !== Boolean(env.RAZORPAY_KEY_SECRET?.trim())) {
    errors.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together.');
  }
  if (env.CARRIER_CREDENTIALS_KEY &&
      !/^[a-f\d]{64}$/i.test(env.CARRIER_CREDENTIALS_KEY.trim())) {
    errors.push('CARRIER_CREDENTIALS_KEY must be a 64-character hexadecimal key.');
  }
  if (env.RAZORPAY_WEBHOOK_SECRET?.trim() &&
      (env.RAZORPAY_WEBHOOK_SECRET.trim().length < 32 ||
       PLACEHOLDER_SECRETS.has(env.RAZORPAY_WEBHOOK_SECRET.trim().toLowerCase()))) {
    errors.push('RAZORPAY_WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters.');
  }

  if (errors.length) {
    throw new Error(`Invalid production environment:\n- ${errors.join('\n- ')}`);
  }
  return [];
};

module.exports = { parseOrigins, resolveDatabaseConfig, validateProductionEnvironment };
