// Client error reports are diagnostics, not user data: while the database is asleep they wait here
// (bounded, de-duplicated) instead of waking it, and are written once it is awake for a real reason.
const MAX_QUEUED = 50;
const queue = new Map();

const keyOf = entry => `${entry.message}|${entry.source || ''}|${entry.pageUrl || ''}`;

const enqueue = entry => {
  const key = keyOf(entry);
  if (queue.has(key)) return false;
  if (queue.size >= MAX_QUEUED) queue.delete(queue.keys().next().value);
  queue.set(key, entry);
  return true;
};

const flush = async createClientError => {
  const entries = [...queue.values()];
  queue.clear();
  for (const entry of entries) {
    try {
      await createClientError(entry);
    } catch (error) {
      console.warn('[CLIENT_LOG_FLUSH]', error.message);
    }
  }
  return entries.length;
};

module.exports = { enqueue, flush, size: () => queue.size };
