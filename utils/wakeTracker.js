// In-memory record of what woke the database, so it never touches the database itself.
const MAX_EVENTS = 50;

const BOT_PATTERN = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|whatsapp|telegram|discord|preview|headless|lighthouse|gtmetrix|pingdom|python-requests|curl\/|wget|go-http-client|axios\/|node-fetch|okhttp|java\//i;
const MONITOR_PATTERN = /uptime|monitor|pingdom|statuscake|better ?stack|healthcheck|health-check|site24x7|vercel-|railway|render|kube-probe/i;

const classify = ({ userAgent = '', path = '', hasAuth = false }) => {
  if (!userAgent) return 'unknown-no-user-agent';
  if (MONITOR_PATTERN.test(userAgent) || /^\/(health|api\/health)/.test(path)) return 'monitor-or-health-check';
  if (BOT_PATTERN.test(userAgent)) return 'bot-or-crawler';
  if (hasAuth) return 'signed-in-user';
  return 'human-visitor';
};

const events = [];
const requestCounts = {};
const wakeCounts = {};
const bootedAt = Date.now();

const describe = req => ({
  userAgent: String(req.get?.('user-agent') || '').slice(0, 200),
  ip: req.ip || req.socket?.remoteAddress || '',
  origin: req.get?.('origin') || req.get?.('referer') || '',
  method: req.method,
  path: req.path || '',
  hasAuth: Boolean(req.get?.('authorization')),
});

const countRequest = req => {
  const kind = classify(describe(req));
  requestCounts[kind] = (requestCounts[kind] || 0) + 1;
  return kind;
};

const recordWake = (info, outcome = 'started') => {
  const kind = classify(info);
  wakeCounts[kind] = (wakeCounts[kind] || 0) + 1;
  const entry = {
    at: new Date().toISOString(),
    kind,
    outcome,
    method: info.method,
    path: info.path,
    ip: info.ip,
    userAgent: info.userAgent,
    origin: info.origin,
  };
  events.unshift(entry);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  console.info(JSON.stringify({ event: 'database.wake', ...entry }));
  return entry;
};

const getWakeReport = () => ({
  since: new Date(bootedAt).toISOString(),
  note: 'In-memory only; resets whenever the serverless instance restarts.',
  wakeCountsByKind: { ...wakeCounts },
  apiRequestsByKind: { ...requestCounts },
  recentWakes: [...events],
});

module.exports = { classify, describe, countRequest, recordWake, getWakeReport };
