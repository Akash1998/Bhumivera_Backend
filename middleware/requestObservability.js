const { randomUUID } = require('node:crypto');

const recentRequests = [];
const MAX_RECENT_REQUESTS = 2000;
const METRICS_WINDOW_MS = 15 * 60 * 1000;

const getRequestMetrics = (now = Date.now()) => {
  const cutoff = now - METRICS_WINDOW_MS;
  while (recentRequests.length && recentRequests[0].timestamp < cutoff) recentRequests.shift();
  const recent = recentRequests.filter(request => request.timestamp >= cutoff);
  const failures = recent.filter(request => request.statusCode >= 500);
  const errorCountsByPath = failures.reduce((counts, request) => {
    counts[request.path] = (counts[request.path] || 0) + 1;
    return counts;
  }, {});
  return {
    windowMinutes: 15,
    scope: 'this_process',
    requestCount: recent.length,
    serverErrorCount: failures.length,
    sampleLimit: MAX_RECENT_REQUESTS,
    sampleIsCapped: recent.length === MAX_RECENT_REQUESTS,
    errorCountsByPath,
    serverErrorRatePercent: recent.length
      ? Number(((failures.length / recent.length) * 100).toFixed(2))
      : 0,
    recentServerErrors: failures.slice(-20).reverse().map(({ timestamp, method, path, statusCode, requestId }) => ({
      occurredAt: new Date(timestamp).toISOString(),
      method,
      path,
      statusCode,
      requestId,
    })),
  };
};

const createRequestObservability = ({
  logger = console,
  createRequestId = randomUUID,
  now = Date.now,
} = {}) => (req, res, next) => {
  const startedAt = now();
  const requestId = createRequestId();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.once('finish', () => {
    const completedAt = now();
    const entry = {
      event: 'http.request',
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.max(0, completedAt - startedAt),
    };
    recentRequests.push({ ...entry, timestamp: completedAt });
    if (recentRequests.length > MAX_RECENT_REQUESTS) {
      recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
    }
    const log = res.statusCode >= 500 ? logger.error : logger.info;
    log.call(logger, JSON.stringify(entry));
  });

  next();
};

module.exports = { createRequestObservability, getRequestMetrics };
