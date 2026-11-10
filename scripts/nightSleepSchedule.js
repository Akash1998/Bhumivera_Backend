#!/usr/bin/env node
/**
 * Bhumivera Organics - Infrastructure Night Sleep & Wake Controller
 *
 * Automatically manages scheduled sleep (10:00 PM to 6:00 AM IST) on Railway:
 * - At 10:00 PM IST (16:30 UTC): scales service replicas to 0 (power down / 0 RAM).
 * - At 06:00 AM IST (00:30 UTC): scales service replicas to 1 (instant wake up).
 *
 * Usage:
 *   node scripts/nightSleepSchedule.js --sleep   # Put server to sleep immediately (0 replicas)
 *   node scripts/nightSleepSchedule.js --wake    # Wake server up immediately (1 replica)
 *   node scripts/nightSleepSchedule.js --auto    # Checks IST time; sleeps if 10pm-6am, wakes otherwise
 *   node scripts/nightSleepSchedule.js --status  # Checks current replica status & sleep window
 */

const { execSync } = require('child_process');

const SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME || 'Bhumivera_Backend';
const REGION_KEY = process.env.RAILWAY_REGION_KEY || 'asia-southeast1-eqsg3a';
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT_NAME || 'production';
const TIMEZONE = process.env.NIGHT_SLEEP_TIMEZONE || 'Asia/Kolkata';
const START_HOUR = Number(process.env.NIGHT_SLEEP_START_HOUR) || 22; // 10:00 PM
const END_HOUR = Number(process.env.NIGHT_SLEEP_END_HOUR) || 6;     // 06:00 AM

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

  const inNightWindow = hour >= START_HOUR || hour < END_HOUR;
  return { hour, minute, formatted, inNightWindow };
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
  console.log(`🌙 Bhumivera Night Sleep & Scale Controller`);
  console.log(`Current Time : ${info.formatted}`);
  console.log(`Night Window : ${START_HOUR}:00 to 0${END_HOUR}:00 (${START_HOUR > 12 ? START_HOUR - 12 : START_HOUR} PM - ${END_HOUR} AM IST)`);
  console.log(`Status       : ${info.inNightWindow ? 'INSIDE Night Sleep Window' : 'OUTSIDE Night Sleep Window (Normal Active Hours)'}`);
  console.log(`Target       : Service "${SERVICE_NAME}" in region "${REGION_KEY}"`);
  console.log(`======================================================\n`);

  if (action === '--sleep') {
    console.log(`[ACTION] Putting backend to sleep (replicas = 0)...`);
    runRailwayScale(0);
    console.log(`\n💤 Backend is now sleeping! RAM & compute charges stopped.`);
  } else if (action === '--wake') {
    console.log(`[ACTION] Waking backend up (replicas = 1)...`);
    runRailwayScale(1);
    console.log(`\n☀️ Backend is now waking up and online!`);
  } else if (action === '--auto') {
    if (info.inNightWindow) {
      console.log(`[AUTO] Current time is in night sleep window (${START_HOUR}:00 - 0${END_HOUR}:00 IST). Putting backend to sleep...`);
      runRailwayScale(0);
    } else {
      console.log(`[AUTO] Current time is within business hours. Ensuring backend is awake (1 replica)...`);
      runRailwayScale(1);
    }
  } else {
    console.log(`Usage:`);
    console.log(`  node scripts/nightSleepSchedule.js --sleep  # Scales to 0 replicas (Sleep)`);
    console.log(`  node scripts/nightSleepSchedule.js --wake   # Scales to 1 replica (Wake)`);
    console.log(`  node scripts/nightSleepSchedule.js --auto   # Automatically sleep or wake based on current IST time`);
  }
}

main().catch(console.error);
