const { createHash } = require('node:crypto');
const { getCurrentRequestContext } = require('../middleware/requestObservability');

const normalizeQuery = query => String(query || '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\r\n]*/g, ' ')
  .replace(/'(?:''|\\.|[^'])*'/g, '?')
  .replace(/"(?:\\.|[^"])*"/g, '?')
  .replace(/\b\d+(?:\.\d+)?\b/g, '?')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 2000);

function createSystemDiagnostics(pool, { logger = console, now = Date.now } = {}) {
  const originalQuery = pool.query.bind(pool);
  const purgeExpired = async () => {
    try {
      await originalQuery(
        'DELETE FROM system_error_events WHERE occurred_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)'
      );
    } catch (error) {
      logger.error(`[SYSTEM_DIAGNOSTICS_RETENTION_FAILED] code=${error.code || 'UNKNOWN'}`);
    }
  };
  let retentionTimer = null;
  if (process.env.ENABLE_DIAGNOSTICS_RETENTION_TIMER === 'true') {
    void purgeExpired();
    retentionTimer = setInterval(purgeExpired, 24 * 60 * 60 * 1000);
    retentionTimer.unref();
  }

  const persistEvent = async event => {
    try {
      await originalQuery(
        `INSERT INTO system_error_events
          (source, request_id, error_code, sql_state, sql_fingerprint, sql_template, http_status, method, endpoint, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.source,
          event.requestId || null,
          event.errorCode || null,
          event.sqlState || null,
          event.sqlFingerprint || null,
          event.sqlTemplate || null,
          event.httpStatus || null,
          event.method || null,
          event.endpoint || null,
          event.occurredAt || new Date(now()),
        ]
      );
    } catch (error) {
      logger.error(`[SYSTEM_DIAGNOSTICS_PERSIST_FAILED] source=${event.source} code=${error.code || 'UNKNOWN'}`);
    }
  };

  const recordHttpError = event => persistEvent({
    ...event,
    source: 'api',
    httpStatus: event.statusCode,
    requestId: event.requestId,
  });

  const originalExecute = pool.execute.bind(pool);
  const observeDatabaseCall = originalCall => (...args) => {
    const result = originalCall(...args);
    return result.catch(error => {
      const query = Array.isArray(args[0]) ? args[0][0] : args[0];
      const normalizedQuery = normalizeQuery(query);
      const request = getCurrentRequestContext();
      void persistEvent({
        source: 'database',
        requestId: request?.requestId,
        method: request?.method,
        endpoint: request?.path,
        errorCode: typeof error.code === 'string' ? error.code.slice(0, 100) : 'DATABASE_QUERY_FAILED',
        sqlState: typeof error.sqlState === 'string' ? error.sqlState.slice(0, 10) : null,
        sqlFingerprint: createHash('sha256').update(normalizedQuery).digest('hex'),
        sqlTemplate: normalizedQuery || null,
        occurredAt: new Date(now()),
      });
      throw error;
    });
  };

  pool.query = observeDatabaseCall(originalQuery);
  pool.execute = observeDatabaseCall(originalExecute);
  if (typeof pool.getConnection === 'function') {
    const originalGetConnection = pool.getConnection.bind(pool);
    const instrumentedConnections = new WeakSet();
    pool.getConnection = (...args) => originalGetConnection(...args).then(connection => {
      if (!instrumentedConnections.has(connection)) {
        connection.query = observeDatabaseCall(connection.query.bind(connection));
        connection.execute = observeDatabaseCall(connection.execute.bind(connection));
        instrumentedConnections.add(connection);
      }
      return connection;
    });
  }
  return {
    recordHttpError,
    getRecentEvents: async (limit = 100) => {
      const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 100));
      const [rows] = await originalQuery(
        `SELECT id, source, request_id, error_code, sql_state, sql_fingerprint, sql_template,
                http_status, method, endpoint, occurred_at
         FROM system_error_events ORDER BY occurred_at DESC LIMIT ?`,
        [safeLimit]
      );
      return rows;
    },
    close: () => clearInterval(retentionTimer),
  };
}

module.exports = { createSystemDiagnostics, normalizeQuery };
