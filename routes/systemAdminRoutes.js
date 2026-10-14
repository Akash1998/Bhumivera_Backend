const express = require('express');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const pool = require('../config/db');
const { getMailMetrics } = require('../utils/mail');
const { getRequestMetrics } = require('../middleware/requestObservability');
const {
  fetchRailwayHttpErrors,
  fetchVercelDeploymentEvents,
  fetchVercelRuntimeLogs,
  getProviderConfiguration,
} = require('../utils/providerDiagnostics');
const {
  getModuleStates,
  isKnownModule,
  setModuleEnabled,
} = require('../utils/moduleAvailability');

const router = express.Router();
const moduleApiPrefixes = {
  products: ['/api/products'],
  categories: ['/api/categories', '/api/subcategories'],
  search: ['/api/search'],
  recommendations: ['/api/recommendations'],
  ai: ['/api/ai'],
  cart: ['/api/cart'],
  orders: ['/api/orders'],
  payments: ['/api/create-order', '/api/verify-payment'],
  warehouse: ['/api/warehouse'],
  inventory: ['/api/inventory'],
  support: ['/api/contact'],
  returns: ['/api/returns'],
  shipping: ['/api/shipping'],
  wallet: ['/api/wallet'],
  coupons: ['/api/coupons'],
  addresses: ['/api/addresses'],
  wishlist: ['/api/wishlist'],
  reviews: ['/api/reviews'],
  notifications: ['/api/notifications'],
  analytics: ['/api/analytics'],
  affiliate: ['/api/affiliate'],
  flash_sales: ['/api/flash-sales'],
  newsletter: ['/api/newsletter'],
  gamification: ['/api/gamification'],
  tax: ['/api/tax'],
  gst: ['/api/gst'],
  impact: ['/api/impact'],
  warranty: ['/api/warranty'],
  serials: ['/api/serials'],
};

const pathMatchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

router.get('/health', authenticateAdmin, async (_req, res) => {
  let database = { status: 'healthy' };
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error('[ADMIN_HEALTH_DATABASE_CHECK]', error);
    database = { status: 'unavailable', code: error.code || 'DATABASE_CHECK_FAILED' };
  }

  try {
    const requestMetrics = getRequestMetrics();
    const modules = (await getModuleStates()).map(module => {
      const prefixes = moduleApiPrefixes[module.id] || [];
      const recentServerErrorCount = Object.entries(requestMetrics.errorCountsByPath).reduce(
        (total, [path, count]) => total + (
          prefixes.some(prefix => pathMatchesPrefix(path, prefix)) ? count : 0
        ),
        0
      );
      return {
        ...module,
        recentServerErrorCount,
        healthStatus: recentServerErrorCount ? 'errors_detected' : 'no_recent_errors',
      };
    });
    const services = {
      database,
      email: {
        status: process.env.MAILRELAY_API_KEY ? 'configured' : 'not_configured',
        note: 'Configuration is checked; delivery is not probed to avoid sending test email.',
        deliveryMetrics: getMailMetrics(),
      },
      payments: {
        status: process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? 'configured' : 'not_configured',
      },
      rateLimits: {
        status: process.env.RATE_LIMIT_REDIS_URL ? 'redis_configured' : 'process_local',
        note: process.env.RATE_LIMIT_REDIS_URL ? undefined : 'Limits are isolated per running process.',
      },
    };
    const degraded = Object.values(services).some(service =>
      ['unavailable', 'not_configured'].includes(service.status)
    ) || requestMetrics.serverErrorCount > 0 || services.email.deliveryMetrics.failedCount > 0;
    return res.status(database.status === 'healthy' ? 200 : 503).json({
      status: degraded ? 'degraded' : 'healthy',
      checkedAt: new Date().toISOString(),
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsedBytes: process.memoryUsage().heapUsed,
      },
      services,
      modules,
      requestMetrics,
      limitations: 'Module status and service configuration are monitored. This endpoint cannot prove every user workflow or external provider is fully operational.',
    });
  } catch (error) {
    console.error('[ADMIN_HEALTH_READ]', error);
    return res.status(500).json({
      status: 'unavailable',
      message: 'Could not load system health data.',
    });
  }
});

router.get('/logs', authenticateAdmin, async (req, res) => {
  const diagnostics = req.app.locals.systemDiagnostics;
  if (!diagnostics) {
    return res.status(503).json({
      code: 'SYSTEM_LOGS_UNAVAILABLE',
      message: 'Persistent system logs are not ready yet.',
    });
  }

  try {
    const configuration = getProviderConfiguration();
    const [events, railway, vercelRuntime, vercelEvents] = await Promise.all([
      diagnostics.getRecentEvents(req.query.limit),
      fetchRailwayHttpErrors().catch(error => ({ configured: configuration.railway.configured, source: 'Railway deployment HTTP logs', error: error.message, records: [] })),
      fetchVercelRuntimeLogs().catch(error => ({ configured: configuration.vercel.configured, source: 'Vercel deployment runtime logs', error: error.message, records: [] })),
      fetchVercelDeploymentEvents().catch(error => ({ configured: configuration.vercel.configured, source: 'Vercel deployment/build events', error: error.message, records: [] })),
    ]);
    res.json({
      checkedAt: new Date().toISOString(),
      events,
      providers: {
        configuration,
        railway,
        vercelRuntime,
        vercelEvents,
      },
      limitations: 'Railway HTTP logs show failing requests but may not include application stack traces. Vercel runtime logs are fetched for the configured production deployment; deployment/build events are shown separately. Correlate records by timestamp, endpoint, status, and request ID where available.',
    });
  } catch (error) {
    console.error('[ADMIN_SYSTEM_LOGS_READ]', error);
    res.status(500).json({
      code: 'SYSTEM_LOGS_READ_FAILED',
      message: 'Could not load persistent system logs.',
    });
  }
});

router.patch('/modules/:moduleId', authenticateAdmin, async (req, res) => {
  const { moduleId } = req.params;
  const { enabled } = req.body || {};
  if (!isKnownModule(moduleId)) {
    return res.status(404).json({ code: 'UNKNOWN_MODULE', message: 'That system module is not registered.' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ code: 'INVALID_MODULE_STATE', message: 'enabled must be true or false.' });
  }
  try {
    await setModuleEnabled(moduleId, enabled);
    return res.json({ success: true, module: moduleId, enabled });
  } catch (error) {
    console.error(`[ADMIN_MODULE_AVAILABILITY_UPDATE] module=${moduleId}`, error);
    return res.status(500).json({
      code: 'MODULE_AVAILABILITY_UPDATE_FAILED',
      message: 'Could not update module availability.',
    });
  }
});

module.exports = router;
