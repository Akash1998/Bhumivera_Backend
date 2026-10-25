/**
 * Bhumivera Organics - Night Sleep & Resource Conservation Manager
 *
 * Automatically manages scheduled sleep (10:00 PM to 6:00 AM IST) to eliminate
 * unnecessary cloud RAM and compute charges during zero-traffic night hours.
 *
 * Supports:
 * 1. Automatic time-based sleep window (default 22:00 to 06:00 Asia/Kolkata).
 * 2. Instant manual wake/sleep overrides via API or 'X-Bhumivera-Wake' header.
 * 3. Graceful wake-on-request option for customer traffic.
 * 4. Zero-database execution while asleep (returns instant lightweight JSON).
 */

const DEFAULT_TIMEZONE = process.env.NIGHT_SLEEP_TIMEZONE || 'Asia/Kolkata';
const DEFAULT_START_HOUR = Number.isInteger(Number(process.env.NIGHT_SLEEP_START_HOUR))
  ? Number(process.env.NIGHT_SLEEP_START_HOUR)
  : 22; // 10:00 PM
const DEFAULT_END_HOUR = Number.isInteger(Number(process.env.NIGHT_SLEEP_END_HOUR))
  ? Number(process.env.NIGHT_SLEEP_END_HOUR)
  : 6; // 06:00 AM

// Wake window duration when awakened on-demand (15 minutes)
const WAKE_ON_REQUEST_DURATION_MS = (Number(process.env.NIGHT_SLEEP_WAKE_MINUTES) || 15) * 60 * 1000;

class NightSleepManager {
  constructor(options = {}) {
    this.timezone = options.timezone || DEFAULT_TIMEZONE;
    this.startHour = options.startHour !== undefined ? options.startHour : DEFAULT_START_HOUR;
    this.endHour = options.endHour !== undefined ? options.endHour : DEFAULT_END_HOUR;
    this.enabled = process.env.NIGHT_SLEEP_ENABLED !== 'false';
    this.allowWakeOnRequest = process.env.NIGHT_SLEEP_ALLOW_WAKE_ON_REQUEST === 'true';

    this.wokenUntil = 0;
    this.forcedSleepUntil = 0;
    this.lastState = null;
  }

  /**
   * Returns current time and breakdown in configured timezone.
   */
  getTimeInfo(date = new Date()) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = formatter.formatToParts(date);
      const getVal = type => parts.find(p => p.type === type)?.value;
      const hour = parseInt(getVal('hour') || '0', 10);
      const minute = parseInt(getVal('minute') || '0', 10);
      const second = parseInt(getVal('second') || '0', 10);
      const formattedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} (${this.timezone})`;

      // Calculate if current hour falls in the night sleep window (e.g., 22:00 to 06:00)
      let inNightWindow = false;
      if (this.startHour > this.endHour) {
        // Crosses midnight (e.g. 22 to 6)
        inNightWindow = hour >= this.startHour || hour < this.endHour;
      } else {
        // Same-day window (e.g. 1 to 5)
        inNightWindow = hour >= this.startHour && hour < this.endHour;
      }

      return {
        hour,
        minute,
        second,
        formattedTime,
        inNightWindow,
        dateString: `${getVal('year')}-${getVal('month')}-${getVal('day')}`,
      };
    } catch {
      // Fallback to UTC if timezone is invalid
      const hour = date.getUTCHours();
      const inNightWindow = hour >= this.startHour || hour < this.endHour;
      return {
        hour,
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        formattedTime: `${hour}:${date.getUTCMinutes()} (UTC fallback)`,
        inNightWindow,
        dateString: date.toISOString().split('T')[0],
      };
    }
  }

  /**
   * Determines whether the server should be sleeping right now.
   */
  isSleeping(now = Date.now()) {
    if (!this.enabled) return false;

    // Check manual wake override
    if (now < this.wokenUntil) return false;

    // Check manual force sleep override
    if (now < this.forcedSleepUntil) return true;

    // Check scheduled night window
    const info = this.getTimeInfo(new Date(now));
    return info.inNightWindow;
  }

  /**
   * Manually wake the backend for a given duration (default 15 mins or until next window).
   */
  wake(durationMs = WAKE_ON_REQUEST_DURATION_MS, reason = 'manual_request') {
    const now = Date.now();
    this.forcedSleepUntil = 0;
    this.wokenUntil = now + Math.max(60000, durationMs);
    console.info(`[NIGHT_SLEEP] Backend manually awakened. Active until ${new Date(this.wokenUntil).toISOString()} (reason: ${reason})`);
    return {
      success: true,
      status: 'awake',
      wokenUntil: new Date(this.wokenUntil).toISOString(),
      wokenForMinutes: Math.round(durationMs / 60000),
      reason,
    };
  }

  /**
   * Manually put the backend to sleep for a given duration (default 8 hours or until wake).
   */
  sleep(durationMs = 8 * 60 * 60 * 1000, reason = 'manual_sleep') {
    const now = Date.now();
    this.wokenUntil = 0;
    this.forcedSleepUntil = now + durationMs;
    console.info(`[NIGHT_SLEEP] Backend manually put to sleep until ${new Date(this.forcedSleepUntil).toISOString()} (reason: ${reason})`);
    return {
      success: true,
      status: 'sleeping',
      forcedSleepUntil: new Date(this.forcedSleepUntil).toISOString(),
      reason,
    };
  }

  /**
   * Reset any manual overrides and revert to automatic clock schedule.
   */
  resetSchedule() {
    this.wokenUntil = 0;
    this.forcedSleepUntil = 0;
    return {
      success: true,
      message: 'Overrides cleared; following standard 10:00 PM - 6:00 AM IST schedule.',
      isSleeping: this.isSleeping(),
    };
  }

  /**
   * Returns complete diagnostic and status telemetry.
   */
  getStatus() {
    const now = Date.now();
    const timeInfo = this.getTimeInfo(new Date(now));
    const sleeping = this.isSleeping(now);
    const mem = process.memoryUsage();

    return {
      status: sleeping ? 'asleep' : 'awake',
      enabled: this.enabled,
      schedule: {
        start: `${String(this.startHour).padStart(2, '0')}:00`,
        end: `${String(this.endHour).padStart(2, '0')}:00`,
        timezone: this.timezone,
        description: `${this.startHour > 12 ? this.startHour - 12 : this.startHour}:00 PM to ${this.endHour}:00 AM ${this.timezone}`,
      },
      currentTime: timeInfo.formattedTime,
      inNightWindow: timeInfo.inNightWindow,
      overrides: {
        hasWakeOverride: now < this.wokenUntil,
        wokenUntil: now < this.wokenUntil ? new Date(this.wokenUntil).toISOString() : null,
        hasForceSleepOverride: now < this.forcedSleepUntil,
        forcedSleepUntil: now < this.forcedSleepUntil ? new Date(this.forcedSleepUntil).toISOString() : null,
      },
      memory: {
        rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      },
      serverlessOptimized: true,
      scaleToZeroActive: true,
    };
  }

  /**
   * Express middleware handler to intercept requests during sleep window.
   */
  middleware() {
    return (req, res, next) => {
      const path = req.path || req.url || '';

      // 1. Whitelisted management & diagnostic paths always pass through
      if (
        path.startsWith('/api/system/sleep') ||
        path.startsWith('/api/system/wake') ||
        path === '/robots.txt' ||
        path === '/llms.txt' ||
        path === '/llms-full.txt' ||
        path === '/bhumivera-indexnow-2026.txt'
      ) {
        return next();
      }

      // 2. Health routes return a fast, lightweight sleep-acknowledging payload without touching DB
      if (path === '/health' || path === '/health/liveness' || path === '/health/readiness') {
        const sleeping = this.isSleeping();
        if (sleeping) {
          return res.status(200).json({
            status: 'ok',
            mode: 'night_sleep',
            message: 'Bhumivera backend is sleeping to conserve resources (10:00 PM - 6:00 AM IST).',
            time: new Date().toISOString(),
          });
        }
        return next();
      }

      // 3. Check for wake triggers (header, query, or wake-on-request setting)
      const wakeHeader = req.get('x-bhumivera-wake')?.toLowerCase() === 'true';
      const wakeQuery = req.query?.wake === 'true';

      if (wakeHeader || wakeQuery || this.allowWakeOnRequest) {
        if (this.isSleeping()) {
          this.wake(WAKE_ON_REQUEST_DURATION_MS, wakeHeader ? 'header' : (wakeQuery ? 'query' : 'traffic'));
        }
        return next();
      }

      // 4. If sleeping and no wake trigger, block database execution and return power-saving response
      if (this.isSleeping()) {
        const status = this.getStatus();
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Bhumivera-Status', 'asleep');

        return res.status(200).json({
          success: true,
          status: 'asleep',
          code: 'NIGHT_SLEEP_ACTIVE',
          message: 'Bhumivera Core Backend is in scheduled night sleep mode (10:00 PM to 6:00 AM IST) to conserve RAM and cloud compute costs.',
          schedule: status.schedule,
          currentTime: status.currentTime,
          wakeOptions: {
            automaticWakeAt: `${status.schedule.end} ${status.schedule.timezone}`,
            instantWakeHeader: 'X-Bhumivera-Wake: true',
            instantWakeEndpoint: 'POST /api/system/wake',
          },
        });
      }

      return next();
    };
  }
}

const defaultManager = new NightSleepManager();

module.exports = {
  NightSleepManager,
  nightSleepManager: defaultManager,
};
