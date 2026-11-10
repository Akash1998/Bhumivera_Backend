#!/usr/bin/env node
/**
 * Bhumivera Organics - 24/7 Backend Availability Controller
 *
 * Keeps one Railway service replica available for the scanner PWA.
 *
 * Usage:
 *   node scripts/nightSleepSchedule.js --wake    # Ensure one production replica is running
 *   node scripts/nightSleepSchedule.js --status  # Show current IST time and availability policy
 */

const { execSync } = require('child_process');

const SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME || 'Bhumivera_Backend';
const REGION_KEY = process.env.RAILWAY_REGION_KEY || 'asia-southeast1-eqsg3a';
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT_NAME || 'production';
const TIMEZONE = process.env.NIGHT_SLEEP_TIMEZONE || 'Asia/Kolkata';
function getIstTimeInfo() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const getVal = type => parts.find(p => p.type === type)?.value;
  const hour = parseInt(getVal('hour') || '0', 10);
  const minute = parseInt(getVal('minute') || '0', 10);
  const formatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${TIMEZONE})`;

  return { hour, minute, formatted };
}

function runRailwayScale(replicas) {
  const cmd = `railway scale --environment ${ENVIRONMENT} --service ${SERVICE_NAME} ${REGION_KEY}=${replicas}`;
  console.log(`[INFRA_SCALE] Executing: ${cmd}`);
  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(output);
    return true;
  } catch (err) {
    console.error(`[INFRA_SCALE_ERROR]: ${err.stderr || err.message}`);
    return false;
  }
}

async function main() {
  const action = process.argv[2] || '--status';
  const info = getIstTimeInfo();

  console.log(`\n======================================================`);
  console.log(`Bhumivera 24/7 Backend Availability`);
  console.log(`Current Time : ${info.formatted}`);
  console.log(`Availability : one Railway replica is expected to remain running at all times`);
  console.log(`Target       : Service "${SERVICE_NAME}" in region "${REGION_KEY}"`);
  console.log(`======================================================\n`);

  if (action === '--wake') {
    console.log(`[ACTION] Waking backend up (replicas = 1)...`);
    if (!runRailwayScale(1)) {
      process.exitCode = 1;
      throw new Error('Railway did not accept the request to keep one backend replica running.');
    }
    console.log(`\nBackend availability ensured (replicas = 1).`);
  } else if (action === '--sleep' || action === '--auto') {
    process.exitCode = 1;
    throw new Error('Scheduled scale-to-zero is disabled; the scanner PWA backend must remain available 24/7.');
  } else {
    console.log(`Usage:`);
    console.log(`  node scripts/nightSleepSchedule.js --wake   # Ensure one replica is running`);
    console.log(`  node scripts/nightSleepSchedule.js --status # Show current time and availability policy`);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
