const crypto = require('node:crypto');

const KEY_HEADER = 'x-idempotency-key';
const MAX_KEY_LENGTH = 200;
const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_IN_FLIGHT = 500;
const WAIT_TIMEOUT_MS = 60000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Webhooks are signature-verified and must always be processed individually.
const SKIPPED_PATHS = /\/webhooks?(\/|$)/i;

const scopeOf = req => crypto
  .createHash('sha256')
  .update(`${req.get('authorization') || req.ip || ''}|${req.method}|${(req.originalUrl || '').split('?')[0]}|${req.get(KEY_HEADER)}`)
  .digest('hex');

const captureResponse = (res, onDone) => {
  const chunks = [];
  let size = 0;
  let replayable = true;
  const collect = chunk => {
    if (!chunk || !replayable) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REPLAY_BYTES) {
      replayable = false;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  };
  const write = res.write;
  const end = res.end;
  res.write = function patchedWrite(chunk, ...args) {
    collect(chunk);
    return write.call(this, chunk, ...args);
  };
  res.end = function patchedEnd(chunk, ...args) {
    if (typeof chunk !== 'function') collect(chunk);
    return end.call(this, chunk, ...args);
  };
  res.once('close', () => onDone(replayable && res.writableFinished
    ? { status: res.statusCode, contentType: res.getHeader('Content-Type'), body: Buffer.concat(chunks) }
    : null));
};

// Concurrent identical mutations (double clicks, several tabs, impatient retries on a laggy network)
// run once; the others wait for that run and receive the same response.
const createRequestDeduplication = () => {
  const inFlight = new Map();

  return (req, res, next) => {
    const clientKey = req.get(KEY_HEADER);
    if (
      !MUTATING.has(req.method) ||
      !clientKey ||
      clientKey.length > MAX_KEY_LENGTH ||
      SKIPPED_PATHS.test(req.path)
    ) {
      return next();
    }

    const scope = scopeOf(req);
    const running = inFlight.get(scope);

    if (running) {
      res.setHeader('X-Deduplicated', '1');
      const timer = setTimeout(() => {
        running.waiters.delete(deliver);
        if (!res.headersSent) {
          res.status(409).json({ success: false, code: 'DUPLICATE_IN_PROGRESS', message: 'This request is already being processed.' });
        }
      }, WAIT_TIMEOUT_MS);
      timer.unref?.();
      function deliver(result) {
        clearTimeout(timer);
        if (res.headersSent || res.writableEnded) return;
        if (!result) {
          return res.status(409).json({ success: false, code: 'DUPLICATE_IN_PROGRESS', message: 'This request was already processed. Please refresh to see the latest state.' });
        }
        if (result.contentType) res.setHeader('Content-Type', result.contentType);
        return res.status(result.status).end(result.body);
      }
      running.waiters.add(deliver);
      req.on('close', () => {
        clearTimeout(timer);
        running.waiters.delete(deliver);
      });
      return undefined;
    }

    if (inFlight.size >= MAX_IN_FLIGHT) return next();

    const entry = { waiters: new Set() };
    inFlight.set(scope, entry);
    captureResponse(res, result => {
      inFlight.delete(scope);
      for (const waiter of entry.waiters) waiter(result);
      entry.waiters.clear();
    });
    return next();
  };
};

module.exports = { createRequestDeduplication, KEY_HEADER };
