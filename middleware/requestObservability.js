const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const recentRequests = [];
const requestCountsBySecond = new Map();
const requestContext = new AsyncLocalStorage();
const MAX_RECENT_REQUESTS = 2000;
const MAX_DISPLAYED_REQUESTS = 100;
const METRICS_WINDOW_MS = 15 * 60 * 1000;

function normalizeRouteBucket(path = '') {
  return String(path || '/')
    .split('?')[0]
    .replace(/\/\d+\b/g, '/:id')
    .replace(/\/sac_[a-f0-9]+\b/gi, '/:challengeId')
    .replace(/\/[a-f0-9]{24,64}\b/gi, '/:token');
}

const getRequestMetrics = (now = Date.now()) => {
  const cutoff = Math.ceil((now - METRICS_WINDOW_MS) / 1000) * 1000;
  while (recentRequests.length && recentRequests[0].timestamp < cutoff) recentRequests.shift();
  const oldestSecond = Math.floor(cutoff / 1000);
  for (const second of requestCountsBySecond.keys()) {
    if (second < oldestSecond) requestCountsBySecond.delete(second);
  }
  const recent = recentRequests.filter(request => request.timestamp >= cutoff);
  const failures = recent.filter(request => request.statusCode >= 500);
  const activeCountBuckets = [...requestCountsBySecond.entries()]
    .filter(([second]) => second * 1000 <= now)
    .map(([, counts]) => counts);
  const requestCount = activeCountBuckets.reduce((total, counts) => total + counts.requests, 0);
  const serverErrorCount = activeCountBuckets.reduce((total, counts) => total + counts.serverErrors, 0);
  const status2xxCount = recent.filter(r => r.statusCode >= 200 && r.statusCode < 400).length;
  const status4xxCount = recent.filter(r => r.statusCode >= 400 && r.statusCode < 500).length;
  const averageLatencyMs = recent.length
    ? Math.round(recent.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0) / recent.length)
    : 0;

  const routeMap = new Map();
  for (const reqItem of recent) {
    const bucketKey = `${reqItem.method} ${normalizeRouteBucket(reqItem.path)}`;
    const existing = routeMap.get(bucketKey) || {
      route: normalizeRouteBucket(reqItem.path),
      method: reqItem.method,
      totalRequests: 0,
      status2xx: 0,
      status4xx: 0,
      status5xx: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      lastStatusCode: reqItem.statusCode,
      lastSeenAt: new Date(reqItem.timestamp).toISOString(),
    };
    existing.totalRequests += 1;
    if (reqItem.statusCode >= 500) existing.status5xx += 1;
    else if (reqItem.statusCode >= 400) existing.status4xx += 1;
    else existing.status2xx += 1;
    const dur = Number(reqItem.durationMs) || 0;
    existing.totalLatencyMs += dur;
    if (dur > existing.maxLatencyMs) existing.maxLatencyMs = dur;
    existing.lastStatusCode = reqItem.statusCode;
    existing.lastSeenAt = new Date(reqItem.timestamp).toISOString();
    routeMap.set(bucketKey, existing);
  }

  const routeHealthTable = [...routeMap.values()]
    .map(item => ({
      route: item.route,
      method: item.method,
      totalRequests: item.totalRequests,
      status2xx: item.status2xx,
      status4xx: item.status4xx,
      status5xx: item.status5xx,
      avgLatencyMs: item.totalRequests ? Math.round(item.totalLatencyMs / item.totalRequests) : 0,
      maxLatencyMs: item.maxLatencyMs,
      lastStatusCode: item.lastStatusCode,
      healthStatus: item.status5xx > 0 ? '5xx_errors' : item.status4xx > 0 ? '4xx_warnings' : '200_ok',
      lastSeenAt: item.lastSeenAt,
    }))
    .sort((a, b) => b.status5xx - a.status5xx || b.totalRequests - a.totalRequests)
    .slice(0, 60);

  const displayedRequests = recent.slice(-MAX_DISPLAYED_REQUESTS).reverse().map(({ timestamp, method, path, statusCode, requestId, durationMs }) => ({
    occurredAt: new Date(timestamp).toISOString(),
    method,
    path,
    statusCode,
    requestId,
    durationMs,
  }));
  const errorCountsByPath = failures.reduce((counts, request) => {
    counts[request.path] = (counts[request.path] || 0) + 1;
    return counts;
  }, {});
  return {
    windowMinutes: 15,
    scope: 'this_process',
    requestCount,
    status2xxCount,
    status4xxCount,
    serverErrorCount,
    averageLatencyMs,
    routeHealthTable,
    sampleLimit: MAX_DISPLAYED_REQUESTS,
    sampleRecordCount: displayedRequests.length,
    sampleIsCapped: requestCount > displayedRequests.length,
    countGranularitySeconds: 1,
    errorCountsByPath,
    serverErrorRatePercent: requestCount
      ? Number(((serverErrorCount / requestCount) * 100).toFixed(2))
      : 0,
    recentServerErrors: failures.slice(-20).reverse().map(({ timestamp, method, path, statusCode, requestId }) => ({
      occurredAt: new Date(timestamp).toISOString(),
      method,
      path,
      statusCode,
      requestId,
    })),
    recentRequests: displayedRequests,
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
    const second = Math.floor(completedAt / 1000);
    const counts = requestCountsBySecond.get(second) || { requests: 0, serverErrors: 0 };
    counts.requests += 1;
    if (res.statusCode >= 500) counts.serverErrors += 1;
    requestCountsBySecond.set(second, counts);
    const oldestRelevantSecond = Math.floor((completedAt - METRICS_WINDOW_MS) / 1000);
    for (const countedSecond of requestCountsBySecond.keys()) {
      if (countedSecond < oldestRelevantSecond) requestCountsBySecond.delete(countedSecond);
    }
    recentRequests.push({ ...entry, timestamp: completedAt });
    if (recentRequests.length > MAX_RECENT_REQUESTS) {
      recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
    }
    const log = res.statusCode >= 500 ? logger.error : logger.info;
    log.call(logger, JSON.stringify(entry));
    if (res.statusCode >= 500) {
      const diagnostics = req.app?.locals?.systemDiagnostics;
      if (diagnostics?.recordHttpError) {
        void diagnostics.recordHttpError({
          ...entry,
          errorCode: res.locals?.systemErrorCode || 'INTERNAL_SERVER_ERROR',
          occurredAt: new Date(completedAt),
        });
      }
    }
  });

  requestContext.run({ requestId, method: req.method, path: req.path }, next);
};

const getCurrentRequestContext = () => requestContext.getStore();

module.exports = { createRequestObservability, getRequestMetrics, getCurrentRequestContext };
