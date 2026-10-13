const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  fetchRailwayHttpErrors,
  fetchVercelDeploymentEvents,
  getProviderConfiguration,
} = require('../utils/providerDiagnostics');
const { createSystemDiagnostics, normalizeQuery } = require('../utils/systemDiagnostics');

describe('provider diagnostics', () => {
  it('reports missing provider settings without making an external request', async () => {
    const env = {};
    assert.deepEqual(getProviderConfiguration(env), {
      railway: {
        configured: false,
        missing: ['RAILWAY_PROJECT_ACCESS_TOKEN or RAILWAY_API_TOKEN', 'RAILWAY_DEPLOYMENT_ID'],
      },
      vercel: {
        configured: false,
        missing: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID or VERCEL_DEPLOYMENT_ID'],
      },
    });
    assert.equal((await fetchRailwayHttpErrors({ env })).configured, false);
    assert.equal((await fetchVercelDeploymentEvents({ env })).configured, false);
  });

  it('requests Railway HTTP logs with the project-token header and returns only failures', async () => {
    let request;
    const result = await fetchRailwayHttpErrors({
      env: {
        RAILWAY_PROJECT_ACCESS_TOKEN: 'private-token',
        RAILWAY_DEPLOYMENT_ID: 'deployment-1',
      },
      now: () => 1_800_000_000_000,
      fetchImpl: async (url, options) => {
        request = { url, ...options };
        return {
          ok: true,
          json: async () => ({
            data: {
              httpLogs: [
                { timestamp: '2027-01-15T08:00:00Z', method: 'GET', path: '/ok?secret=value', httpStatus: 200 },
                { timestamp: '2027-01-15T08:01:00Z', method: 'POST', path: '/api/orders?email=private', httpStatus: 500, upstreamRqDuration: 47 },
              ],
            },
          }),
        };
      },
    });
    assert.equal(request.url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(request.headers['Project-Access-Token'], 'private-token');
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(JSON.parse(request.body).variables.deploymentId, 'deployment-1');
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0], {
      occurredAt: '2027-01-15T08:01:00Z',
      method: 'POST',
      path: '/api/orders',
      statusCode: 500,
      durationMs: 47,
    });
  });

  it('requests time-bounded Vercel deployment events and safely maps the result', async () => {
    let request;
    const result = await fetchVercelDeploymentEvents({
      env: { VERCEL_TOKEN: 'private-token', VERCEL_DEPLOYMENT_ID: 'dep/one', VERCEL_TEAM_ID: 'team-1' },
      now: () => 1_800_000_000_000,
      fetchImpl: async (url, options) => {
        request = { url: new URL(url), ...options };
        return {
          ok: true,
          json: async () => [{ created: 1_800_000_000_000, type: 'command', text: 'Build completed' }],
        };
      },
    });
    assert.equal(request.url.pathname, '/v3/deployments/dep%2Fone/events');
    assert.equal(request.url.searchParams.get('teamId'), 'team-1');
    assert.equal(request.url.searchParams.get('since'), null);
    assert.equal(request.headers.Authorization, 'Bearer private-token');
    assert.equal(result.records[0].message, 'Build completed');
    assert.match(result.source, /not runtime function logs/);
  });

  it('selects the latest production deployment when only a Vercel project is configured', async () => {
    const requests = [];
    const result = await fetchVercelDeploymentEvents({
      env: { VERCEL_TOKEN: 'private-token', VERCEL_PROJECT_ID: 'project-1' },
      fetchImpl: async (url) => {
        requests.push(new URL(url));
        return {
          ok: true,
          json: async () => requests.length === 1
            ? { deployments: [{ uid: 'latest-production' }] }
            : [{ created: 1_800_000_000_000, type: 'command', text: 'Production build' }],
        };
      },
    });
    assert.equal(requests[0].pathname, '/v7/deployments');
    assert.equal(requests[0].searchParams.get('target'), 'production');
    assert.equal(requests[1].pathname, '/v3/deployments/latest-production/events');
    assert.equal(result.deploymentId, 'latest-production');
  });
});

describe('system diagnostic persistence', () => {
  it('normalizes literal values before creating a SQL fingerprint', () => {
    assert.equal(normalizeQuery("SELECT * FROM users WHERE email='person@example.com' AND id=42"),
      'SELECT * FROM users WHERE email=? AND id=?');
  });

  it('records API and database errors without persisting SQL parameters', async () => {
    const inserts = [];
    const pool = {
      query: (sql, values) => {
        if (sql.includes('INSERT INTO system_error_events')) {
          inserts.push({ sql, values });
          return Promise.resolve([{}]);
        }
        if (sql.startsWith('SELECT * FROM users')) return Promise.reject(Object.assign(new Error('duplicate value'), { code: 'ER_DUP_ENTRY', sqlState: '23000' }));
        return Promise.resolve([{}]);
      },
      execute: () => Promise.resolve([{}]),
    };
    const diagnostics = createSystemDiagnostics(pool, { logger: { error: () => {} } });
    await diagnostics.recordHttpError({
      requestId: 'request-1',
      statusCode: 500,
      errorCode: 'INTERNAL_SERVER_ERROR',
      method: 'GET',
      path: '/api/orders',
      occurredAt: new Date('2027-01-15T08:00:00.000Z'),
    });
    await assert.rejects(pool.query("SELECT * FROM users WHERE email='private@example.com'"), { code: 'ER_DUP_ENTRY' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].values[0], 'api');
    assert.equal(inserts[0].values[2], 'INTERNAL_SERVER_ERROR');
    assert.equal(inserts[1].values[0], 'database');
    assert.equal(inserts[1].values[2], 'ER_DUP_ENTRY');
    assert.equal(inserts[0].values[5], null);
    assert.equal(inserts[1].values[5], 'SELECT * FROM users WHERE email=?');
    assert.doesNotMatch(JSON.stringify(inserts), /private@example\.com/);
  });
});
