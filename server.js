require("dotenv").config();
const { parseOrigins, validateProductionEnvironment } = require("./config/environment");
validateProductionEnvironment(process.env);
if (process.env.NODE_ENV === "production" && !process.env.OTP_SECRET?.trim()) {
  console.warn("[SECURITY WARNING] OTP_SECRET is unset; OTP HMAC uses a stable HKDF-derived key from JWT_SECRET. Configure an independent OTP_SECRET to isolate key compromise.");
}
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const path = require("path");
const { connectRateLimitStore, closeRateLimitStore } = require("./middleware/rateLimiter");
const {
  redisResponseCache,
  connectResponseCache,
  closeResponseCache,
} = require("./middleware/redisResponseCache");
const { createRequestObservability } = require("./middleware/requestObservability");
const { createSystemDiagnostics } = require("./utils/systemDiagnostics");
const { clientContextMiddleware, ALLOWED_NATIVE_ORIGINS } = require("./middleware/clientContext");
const { createModuleAvailabilityMiddleware } = require("./utils/moduleAvailability");
const { createRazorpayWebhookRouter } = require("./services/razorpayWebhook");
const { runMigrations } = require("./utils/migrationRunner");
const { createHealthRouter } = require("./utils/healthRoutes");
const migrations = require("./migrations");
const { approveDueReferralClaims } = require("./models/referralModel");
const {
  registerTelegramWebhook,
  resolveTelegramBotToken,
} = require("./services/telegramSupportService");
const { getAiSupportFeatureConfig } = require("./models/aiSupportModel");

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
if (JWT_SECRET === 'fallback_secret') {
  console.warn("[SECURITY WARNING] JWT_SECRET environment variable is NOT set. Using unsafe fallback. Set a random string >= 32 characters in production.");
} else if (JWT_SECRET.length < 32) {
  console.warn(`[SECURITY WARNING] JWT_SECRET length is ${JWT_SECRET.length} characters. Recommendation: use at least 32 characters (256 bits) for production.`);
}

// Route Imports
const categoryRoutes = require("./routes/categoryRoutes");
const affiliateRoutes = require("./routes/affiliateRoutes");
const taxRoutes = require("./routes/taxRoutes");
const walletRoutes = require("./routes/walletRoutes");
const searchRoutes = require("./routes/searchRoutes");
const flashSalesRoutes = require("./routes/flashSalesRoutes");
const aiRoutes = require("./routes/aiRoutes"); 
const subcategoryRoutes = require("./routes/subcategoryRoutes");
const productRoutes = require("./routes/productRoutes");
const recommendationRoutes = require("./routes/recommendationRoutes");
const warrantyRoutes = require("./routes/warrantyRoutes");
const contactRoutes = require("./routes/contactRoutes");
const authRoutes = require("./routes/authRoutes");
const serialRoutes = require("./routes/serialRoutes");
const { router: userRoutes } = require("./routes/userRoutes");
const cartRoutes = require("./routes/cartRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const addressRoutes = require("./routes/addressRoutes");
const adminUserRoutes = require("./routes/adminUserRoutes");
const wishlistRoutes = require("./routes/wishlistRoutes");
const couponRoutes = require("./routes/couponRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const shippingRoutes = require("./routes/shippingRoutes");
const returnRoutes = require("./routes/returnRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const warehouseRoutes = require("./routes/warehouseRoutes");
const gstRoutes = require("./routes/gstRoutes");
const clientLogRoutes = require("./routes/clientLogRoutes");
const logsRoutes = require("./routes/logsRoutes");
const newsletterRoutes = require("./routes/newsletterRoutes");
const gamificationRoutes = require("./routes/gamificationRoutes");
const impactRoutes = require("./routes/impactRoutes");
const systemAdminRoutes = require("./routes/systemAdminRoutes");
const supportRoutes = require("./routes/supportRoutes");
const superAdminControlCentreRoutes = require("./routes/superAdminControlCentreRoutes");

const { normalizeErrorResponses, requestErrorHandler } = require("./utils/errorReporting");

const app = express();
let databaseReady = false;
let startupFailure = null;
let referralApprovalTimer = null;
let telegramWebhookTimer = null;
let telegramWebhookSetupRunning = false;
let systemDiagnostics = null;
app.use(createRequestObservability());
app.use(clientContextMiddleware());

// --- SECURITY & CORS POLICIES ---
const defaultAllowedOrigins = [
  "https://www.bhumivera.com",
  "https://bhumivera.com",
  "http://localhost:5173",
  "http://localhost:3000"
];
const productionAllowedOrigins = defaultAllowedOrigins.filter(origin => origin.startsWith("https://"));
const allowedOrigins = new Set(parseOrigins(
  process.env.FRONTEND_ORIGINS,
  process.env.NODE_ENV === "production" ? productionAllowedOrigins : defaultAllowedOrigins,
  process.env.NODE_ENV
));

const corsOptions = {
  origin: function (origin, callback) {
    const currentEnv = process.env.NODE_ENV || process.env.access_ENV || "production";
    if (!origin) {
      return callback(null, true);
    }
    const isAllowed = allowedOrigins.has(origin) || ALLOWED_NATIVE_ORIGINS.has(origin) || (currentEnv === "development" && origin.includes("localhost"));
    if (isAllowed) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Client-Platform",
    "X-SuperAdmin-Action-Passcode",
    "X-CSRF-Token",
    "Accept",
    "Origin"
  ],
  exposedHeaders: ["Content-Range", "X-Content-Range", "X-Request-Id"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; " +
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob: https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com https://checkout.razorpay.com https://cdn.razorpay.com; " +
    "script-src-elem 'self' 'unsafe-eval' 'unsafe-inline' blob: https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com https://checkout.razorpay.com https://cdn.razorpay.com; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self' https://challenges.cloudflare.com https://vercel.live https://*.google.com https://checkout.razorpay.com https://api.razorpay.com; " +
    "connect-src 'self' https://challenges.cloudflare.com https://vercel.live https://bhumivera-backend.railway.app https://bhumiverabackend-production.up.railway.app https://service.bhumivera.com https://analytics.google.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.r2.cloudflarestorage.com https://overbridgenet.com https://api.razorpay.com https://lumberjack.razorpay.com; " +
    "img-src 'self' data: blob: https: https://*.google-analytics.com https://*.analytics.google.com https://*.razorpay.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; " +
    "trusted-types *;"
  );
  
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use("/health", createHealthRouter(() => ({ databaseReady, failure: startupFailure })));

app.use((req, res, next) => {
  if (databaseReady) return next();
  res.setHeader("Retry-After", "15");
  return res.status(503).json({
    success: false,
    code: "DATABASE_UNAVAILABLE",
    message: "The API is online but its database is not ready. Please retry shortly."
  });
});

app.set("trust proxy", 1);
app.use("/api/webhooks/razorpay", createRazorpayWebhookRouter({ pool }));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(normalizeErrorResponses);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(redisResponseCache);

// --- ROUTE REGISTRATION ---
app.use("/api/superadmin/controlcentre", superAdminControlCentreRoutes);
app.use("/api/admin/system", systemAdminRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/flash-sales", createModuleAvailabilityMiddleware('flash_sales'), flashSalesRoutes);
app.use("/api/client-log", clientLogRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/newsletter", createModuleAvailabilityMiddleware('newsletter'), newsletterRoutes);
app.use("/api/ai", createModuleAvailabilityMiddleware('ai'), aiRoutes);
app.use("/api/affiliate", createModuleAvailabilityMiddleware('affiliate'), affiliateRoutes);
app.use("/api/tax", createModuleAvailabilityMiddleware('tax'), taxRoutes);
app.use("/api/wallet", createModuleAvailabilityMiddleware('wallet'), walletRoutes);
app.use("/api/search", createModuleAvailabilityMiddleware('search'), searchRoutes);
app.use("/api/categories", createModuleAvailabilityMiddleware('categories'), categoryRoutes);
app.use("/api/subcategories", createModuleAvailabilityMiddleware('categories'), subcategoryRoutes);
app.use("/api/products", createModuleAvailabilityMiddleware('products'), productRoutes);
app.use("/api/recommendations", createModuleAvailabilityMiddleware('recommendations'), recommendationRoutes);
app.use("/api/warranty", createModuleAvailabilityMiddleware('warranty'), warrantyRoutes);
app.use("/api/contact", createModuleAvailabilityMiddleware('support'), contactRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/serials", createModuleAvailabilityMiddleware('serials'), serialRoutes);
app.use("/api/users", userRoutes);
app.use("/api/cart", createModuleAvailabilityMiddleware('cart'), cartRoutes);
app.use("/api/orders", createModuleAvailabilityMiddleware('orders'), orderRoutes);
app.use("/api", createModuleAvailabilityMiddleware('payments', req =>
  ['/create-order', '/verify-payment'].includes(req.path)
), paymentRoutes);
app.use("/api/impact", createModuleAvailabilityMiddleware('impact'), impactRoutes);
app.use("/api/addresses", createModuleAvailabilityMiddleware('addresses'), addressRoutes);
app.use("/api/admin", adminUserRoutes);
app.use("/api/wishlist", createModuleAvailabilityMiddleware('wishlist'), wishlistRoutes);
app.use("/api/coupons", createModuleAvailabilityMiddleware('coupons'), couponRoutes);
app.use("/api/reviews", createModuleAvailabilityMiddleware('reviews'), reviewRoutes);
app.use("/api/notifications", createModuleAvailabilityMiddleware('notifications'), notificationRoutes);
app.use("/api/gamification", createModuleAvailabilityMiddleware('gamification'), gamificationRoutes);
app.use("/api/analytics", createModuleAvailabilityMiddleware('analytics'), analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", createModuleAvailabilityMiddleware('shipping'), shippingRoutes);
app.use("/api/returns", createModuleAvailabilityMiddleware('returns'), returnRoutes);
app.use("/api/inventory", createModuleAvailabilityMiddleware('inventory'), inventoryRoutes);
app.use("/api/warehouse", createModuleAvailabilityMiddleware('warehouse'), warehouseRoutes);
app.use("/api/gst", createModuleAvailabilityMiddleware('gst'), gstRoutes);

// --- SEO: DYNAMIC XML SITEMAP GENERATOR ---
app.get("/sitemap.xml", async (req, res) => {
  try {
    const [products] = await pool.query("SELECT slug, updated_at FROM products WHERE status = 'active'");
    
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/</loc>\n    <priority>1.0</priority>\n  </url>`;
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/products</loc>\n    <priority>0.95</priority>\n  </url>`;
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/shop</loc>\n    <priority>0.9</priority>\n  </url>`;
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/about</loc>\n    <priority>0.7</priority>\n  </url>`;
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/contact</loc>\n    <priority>0.7</priority>\n  </url>`;

    for (const p of products) {
      if (!p.slug) continue;
      const lastModDate = p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      xml += `\n  <url>\n    <loc>https://www.bhumivera.com/product/${p.slug}</loc>\n    <lastmod>${lastModDate}</lastmod>\n    <priority>0.8</priority>\n  </url>`;
    }
    
    xml += `\n</urlset>`;
    
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error("[SITEMAP ERROR]:", err);
    res.status(500).end();
  }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Bhumivera Maison Core API running!" }));

// --- ERROR HANDLING ---
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: `API Endpoint Not Found: ${req.originalUrl}` });
});

app.use(requestErrorHandler);

const PORT = process.env.PORT || 5000;
const httpServer = app.listen(PORT, () => {
  console.log(`Access Core Online on Port ${PORT}`);
});

const initializeDatabase = async () => {
  try {
    await connectRateLimitStore();
    try {
      await connectResponseCache();
    } catch (error) {
      console.warn('[RESPONSE_CACHE] Redis connection failed; requests will continue without response caching.', error.message);
    }
    await pool.query('SELECT 1');
    await runMigrations(pool, migrations);
    if (!systemDiagnostics) {
      systemDiagnostics = createSystemDiagnostics(pool);
      app.locals.systemDiagnostics = systemDiagnostics;
    }
    databaseReady = true;
    startupFailure = null;
    if (!referralApprovalTimer) {
      const runReferralApprovals = () => approveDueReferralClaims().catch(error => {
        console.error('[REFERRAL_AUTO_APPROVAL_RUN]', error);
      });
      runReferralApprovals();
      referralApprovalTimer = setInterval(runReferralApprovals, 15000);
      referralApprovalTimer.unref();
    }
    if (!telegramWebhookTimer) {
      const configureTelegramWebhook = async () => {
        if (telegramWebhookSetupRunning) return;
        telegramWebhookSetupRunning = true;
        try {
          const featureConfig = await getAiSupportFeatureConfig(pool);
          await registerTelegramWebhook({
            botToken: resolveTelegramBotToken(featureConfig),
          });
          clearInterval(telegramWebhookTimer);
          telegramWebhookTimer = null;
          console.log("[TELEGRAM] Incoming bot webhook registered.");
        } catch (error) {
          console.error("[TELEGRAM_WEBHOOK_SETUP]", error.message);
        } finally {
          telegramWebhookSetupRunning = false;
        }
      };
      void configureTelegramWebhook();
      telegramWebhookTimer = setInterval(configureTelegramWebhook, 60000);
      telegramWebhookTimer.unref();
    }
    console.log("[STARTUP] Database initialization complete; API is ready.");
  } catch (err) {
    databaseReady = false;
    startupFailure = err.migration
      ? { migration: err.migration, code: err.code || "MIGRATION_FAILED" }
      : { code: err.code || "STARTUP_FAILED" };
    console.error("[STARTUP] Required database initialization failed; API will retry.", err);
    setTimeout(initializeDatabase, 15000).unref();
  }
};

initializeDatabase();

let shutdownStarted = false;
const shutdown = signal => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  databaseReady = false;
  console.info(`[SHUTDOWN] Received ${signal}; draining HTTP connections.`);
  const forceCloseTimer = setTimeout(() => {
    console.error('[SHUTDOWN] Graceful shutdown timed out.');
    process.exitCode = 1;
    httpServer.closeAllConnections();
  }, 10000);
  forceCloseTimer.unref();

  httpServer.close(async error => {
    clearTimeout(forceCloseTimer);
    const shutdownTasks = [
        Promise.resolve().then(() => clearInterval(referralApprovalTimer)),
        Promise.resolve().then(() => clearInterval(telegramWebhookTimer)),
      Promise.resolve().then(() => systemDiagnostics?.close()),
      pool.end(),
      closeRateLimitStore(),
    closeResponseCache(),
    ];
    const results = await Promise.allSettled(shutdownTasks);
    const failure = error || results.find(result => result.status === 'rejected')?.reason;
    if (failure) {
      console.error('[SHUTDOWN] Failed to close one or more service connections.', failure);
      process.exitCode = 1;
      return;
    }
    console.info('[SHUTDOWN] HTTP, database, rate-limit, and response-cache connections closed.');
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
