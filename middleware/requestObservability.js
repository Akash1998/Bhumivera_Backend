const { randomUUID } = require('node:crypto');

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
    const entry = {
      event: 'http.request',
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.max(0, now() - startedAt),
    };
    const log = res.statusCode >= 500 ? logger.error : logger.info;
    log.call(logger, JSON.stringify(entry));
  });

  next();
};

module.exports = { createRequestObservability };
