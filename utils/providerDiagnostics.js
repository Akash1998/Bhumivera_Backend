const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const VERCEL_API = 'https://api.vercel.com';

const RAILWAY_HTTP_LOGS_QUERY = `query HttpLogs($deploymentId: String!, $startDate: String, $endDate: String, $limit: Int) {
  httpLogs(deploymentId: $deploymentId, startDate: $startDate, endDate: $endDate, limit: $limit) {
    timestamp
    method
    path
    httpStatus
    upstreamRqDuration
  }
}`;

const redact = value => String(value || '')
  .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[redacted credential]')
  .replace(/\b(?:sk|rk|pk|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
  .slice(0, 2000);

async function readVercelLogRecords(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [payload];
  }

  const records = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let bytesRead = 0;
  let isArrayPayload = false;
  const maxBytes = 2 * 1024 * 1024;
  const appendRecord = line => {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed || trimmed === '[' || trimmed === ']') return;
    const recordText = trimmed.startsWith('[') ? trimmed.slice(1) : trimmed;
    if (recordText.endsWith(']')) {
      const json = JSON.parse(recordText);
      records.push(...(Array.isArray(json) ? json : [json]));
      return;
    }
    records.push(JSON.parse(recordText));
  };

  try {
    while (records.length < limit && bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (!buffer.trim()) continue;
      if (buffer.trimStart().startsWith('[')) isArrayPayload = true;
      if (isArrayPayload) continue;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) appendRecord(line);
        if (records.length >= limit) break;
      }
    }
    if (buffer.trim()) {
      if (isArrayPayload) {
        const parsed = JSON.parse(buffer);
        records.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } else {
        appendRecord(buffer);
      }
    }
    return records.slice(0, limit);
  } catch {
    throw new Error('Vercel runtime logs request returned invalid streamed JSON.');
  } finally {
    if (records.length >= limit || bytesRead >= maxBytes) {
      await reader.cancel().catch(() => {});
    }
  }
}

function getProviderConfiguration(env = process.env) {
  const railwayToken = env.RAILWAY_PROJECT_ACCESS_TOKEN || env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN;
  const vercelToken = env.VERCEL_TOKEN || env.VERCEL_API_TOKEN;
  return {
    railway: {
      configured: Boolean(railwayToken && env.RAILWAY_DEPLOYMENT_ID),
      missing: [
        ...(!railwayToken ? ['RAILWAY_PROJECT_ACCESS_TOKEN, RAILWAY_API_TOKEN, or RAILWAY_TOKEN'] : []),
        ...(!env.RAILWAY_DEPLOYMENT_ID ? ['RAILWAY_DEPLOYMENT_ID'] : []),
      ],
    },
    vercel: {
      configured: Boolean(vercelToken && env.VERCEL_PROJECT_ID),
      missing: [
        ...(!vercelToken ? ['VERCEL_TOKEN or VERCEL_API_TOKEN'] : []),
        ...(!env.VERCEL_PROJECT_ID ? ['VERCEL_PROJECT_ID'] : []),
      ],
    },
  };
}

async function fetchRailwayHttpErrors({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  limit = 200,
} = {}) {
  const token = env.RAILWAY_PROJECT_ACCESS_TOKEN || env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN;
  const deploymentId = env.RAILWAY_DEPLOYMENT_ID;
  if (!token || !deploymentId) {
    return { configured: false, source: 'Railway deployment HTTP logs', missing: getProviderConfiguration(env).railway.missing, records: [] };
  }
  const endDate = new Date(now()).toISOString();
  const startDate = new Date(now() - 60 * 60 * 1000).toISOString();
  const headers = { 'Content-Type': 'application/json' };
  if (env.RAILWAY_PROJECT_ACCESS_TOKEN) headers['Project-Access-Token'] = token;
  else headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(RAILWAY_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: RAILWAY_HTTP_LOGS_QUERY,
        variables: { deploymentId, startDate, endDate, limit: Math.max(1, Math.min(Number(limit) || 200, 500)) },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Railway HTTP logs request failed: ${error.name === 'TimeoutError' ? 'request timed out' : 'provider could not be reached'}`);
  }
  if (!response.ok) throw new Error(`Railway HTTP logs request failed with HTTP ${response.status}.`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Railway HTTP logs request returned invalid JSON.');
  }
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(`Railway GraphQL rejected the HTTP logs query: ${redact(payload.errors[0].message || 'Unknown GraphQL error')}`);
  }
  if (!Array.isArray(payload.data?.httpLogs)) {
    throw new Error('Railway returned an unexpected response: the httpLogs field was missing.');
  }
  const records = payload.data.httpLogs;
  return {
    configured: true,
    source: 'Railway deployment HTTP logs',
    windowMinutes: 60,
    records: records
      .filter(record => Number(record.httpStatus) >= 400)
      .map(record => ({
        occurredAt: record.timestamp || null,
        method: redact(record.method).slice(0, 12),
        path: redact(String(record.path || '').split('?')[0]).slice(0, 500),
        statusCode: Number(record.httpStatus) || null,
        durationMs: Number.isFinite(Number(record.upstreamRqDuration)) ? Number(record.upstreamRqDuration) : null,
      })),
  };
}

async function fetchVercelDeploymentEvents({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  limit = 100,
} = {}) {
  const token = env.VERCEL_TOKEN || env.VERCEL_API_TOKEN;
  let deploymentId = env.VERCEL_DEPLOYMENT_ID;
  if (!token || (!deploymentId && !env.VERCEL_PROJECT_ID)) {
    return { configured: false, source: 'Vercel deployment events', missing: getProviderConfiguration(env).vercel.missing, records: [] };
  }

  const requestVercelJson = async (url, failureLabel) => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: ['Bearer ', token].join(''), Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new Error(`${failureLabel}: ${error.name === 'TimeoutError' ? 'request timed out' : 'provider could not be reached'}`);
    }
    if (!response.ok) throw new Error(`${failureLabel} with HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${failureLabel}: provider returned invalid JSON.`);
    }
  };

  if (!deploymentId) {
    const deploymentsUrl = new URL('/v7/deployments', VERCEL_API);
    deploymentsUrl.searchParams.set('projectId', env.VERCEL_PROJECT_ID);
    deploymentsUrl.searchParams.set('target', 'production');
    deploymentsUrl.searchParams.set('limit', '1');
    if (env.VERCEL_TEAM_ID) deploymentsUrl.searchParams.set('teamId', env.VERCEL_TEAM_ID);
    const deployments = await requestVercelJson(deploymentsUrl, 'Vercel deployment lookup failed');
    deploymentId = deployments?.deployments?.[0]?.uid || deployments?.deployments?.[0]?.id;
    if (!deploymentId) {
      throw new Error('Vercel returned no production deployment for the configured project.');
    }
  }

  const url = new URL(`/v3/deployments/${encodeURIComponent(deploymentId)}/events`, VERCEL_API);
  url.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 100, 200))));
  url.searchParams.set('since', String(now() - 60 * 60 * 1000));
  url.searchParams.set('until', String(now()));
  if (env.VERCEL_TEAM_ID) url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
  const payload = await requestVercelJson(url, 'Vercel deployment events request failed');
  if (!Array.isArray(payload)) {
    const providerMessage = payload?.error?.message;
    throw new Error(`Vercel returned an unexpected deployment-events response${providerMessage ? `: ${redact(providerMessage)}` : '.'}`);
  }
  const events = payload;
  return {
    configured: true,
    source: 'Vercel deployment/build events (not runtime function logs)',
    deploymentId,
    recordLimit: Math.max(1, Math.min(Number(limit) || 100, 200)),
    records: events.map(event => ({
      occurredAt: event.created || event.date || (Number.isFinite(Number(event.createdAt)) ? new Date(Number(event.createdAt)).toISOString() : null),
      severity: redact(event.type || event.status || 'event').slice(0, 40),
      message: redact(event.text || event.info?.message || event.info?.text || event.type || event.status || 'Vercel deployment event'),
    })),
  };
}

async function fetchVercelRuntimeLogs({
  env = process.env,
  fetchImpl = globalThis.fetch,
  limit = 200,
} = {}) {
  const token = env.VERCEL_TOKEN || env.VERCEL_API_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return {
      configured: false,
      source: 'Vercel deployment runtime logs',
      missing: getProviderConfiguration(env).vercel.missing,
      records: [],
    };
  }

  const requestJson = async (url, label) => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: ['Bearer ', token].join(''), Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new Error(`${label}: ${error.name === 'TimeoutError' ? 'request timed out' : 'provider could not be reached'}`);
    }
    if (!response.ok) throw new Error(`${label} with HTTP ${response.status}.`);
    try {
      return new URL(url).pathname.endsWith('/runtime-logs')
        ? await readVercelLogRecords(response, 200)
        : await response.json();
    } catch {
      throw new Error(`${label}: provider returned invalid JSON.`);
    }
  };

  let deploymentId = env.VERCEL_DEPLOYMENT_ID;
  if (!deploymentId) {
    const deploymentsUrl = new URL('/v7/deployments', VERCEL_API);
    deploymentsUrl.searchParams.set('projectId', projectId);
    deploymentsUrl.searchParams.set('target', 'production');
    deploymentsUrl.searchParams.set('limit', '1');
    if (env.VERCEL_TEAM_ID) deploymentsUrl.searchParams.set('teamId', env.VERCEL_TEAM_ID);
    const deployments = await requestJson(deploymentsUrl, 'Vercel deployment lookup failed');
    deploymentId = deployments?.deployments?.[0]?.uid || deployments?.deployments?.[0]?.id;
    if (!deploymentId) throw new Error('Vercel returned no production deployment for the configured project.');
  }

  const url = new URL(
    `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`,
    VERCEL_API
  );
  if (env.VERCEL_TEAM_ID) url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 200));
  const logs = await requestJson(url, 'Vercel runtime logs request failed');
  return {
    configured: true,
    source: 'Vercel deployment runtime logs',
    deploymentId,
    recordLimit: safeLimit,
    records: logs.slice(0, safeLimit).map(log => ({
      occurredAt: Number.isFinite(Number(log.timestampInMs))
        ? new Date(Number(log.timestampInMs)).toISOString()
        : log.timestamp || null,
      severity: redact(log.level || 'log').slice(0, 40),
      statusCode: Number(log.responseStatusCode) || null,
      method: redact(log.requestMethod || '').slice(0, 12),
      path: redact(String(log.requestPath || '').split('?')[0]).slice(0, 500),
      message: redact(log.message || 'Vercel runtime log'),
      source: redact(log.source || '').slice(0, 40),
      domain: redact(log.domain || '').slice(0, 255),
    })),
  };
}

module.exports = {
  RAILWAY_HTTP_LOGS_QUERY,
  getProviderConfiguration,
  fetchRailwayHttpErrors,
  fetchVercelDeploymentEvents,
  fetchVercelRuntimeLogs,
};
