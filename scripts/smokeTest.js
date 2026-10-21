const assert = require('node:assert/strict');

const apiBaseUrl = process.env.API_BASE_URL;
const frontendUrl = process.env.FRONTEND_URL;
if (!apiBaseUrl) {
  console.error('Set API_BASE_URL to the deployed backend URL before running the release smoke test.');
  process.exitCode = 2;
} else {
  const checks = [
    ['backend liveness', `${apiBaseUrl.replace(/\/$/, '')}/health/live`],
    ['backend readiness', `${apiBaseUrl.replace(/\/$/, '')}/health/ready`],
    ['backend root route', `${apiBaseUrl.replace(/\/$/, '')}/`],
    ...(frontendUrl ? [['frontend delivery', frontendUrl]] : []),
  ];

  (async () => {
    let failed = false;
    for (const [name, url] of checks) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        assert.equal(response.ok, true, `${name} returned HTTP ${response.status}`);
        if (name === 'backend liveness' || name === 'backend readiness') {
          const payload = await response.json();
          assert.ok(payload.status === 'live' || payload.status === 'ready', `${name} returned an invalid health payload`);
        }
        console.log(`PASS ${name}: HTTP ${response.status}`);
      } catch (error) {
        failed = true;
        console.error(`FAIL ${name}: ${error.message}`);
      }
    }
    if (failed) process.exitCode = 1;
  })();
}
