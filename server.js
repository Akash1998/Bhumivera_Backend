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
const {
  SITE_URL,
  LUXURY_CATALOG_SKUS,
  PILLAR_GUIDES,
  generateRobotsTxt,
  generateLlmsTxt,
  generateLlmsFullTxt,
  seoPrerenderMiddleware,
} = require("./middleware/seoPrerender");

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

const { normalizeErrorResponses, requestErrorHandler } = require("./utils/errorReporting");

const app = express();
const isVercel = process.env.VERCEL === "1";
let databaseReady = false;
let startupFailure = null;
let databaseInitializationPromise = null;
let referralApprovalTimer = null;
let telegramWebhookTimer = null;
let telegramWebhookSetupRunning = false;
let systemDiagnostics = null;
if (isVercel) app.set("trust proxy", 1);
app.use(createRequestObservability());
app.use(clientContextMiddleware());
if (isVercel) {
  app.use(async (req, res, next) => {
    const isApiRequest = req.path === "/api" || req.path.startsWith("/api/");
    if ((!isApiRequest && req.path !== "/health/ready" && req.path !== "/health") ||
        databaseReady) return next();
    const ready = await initializeDatabase();
    if (!ready) {
      return res.status(503).json({
        success: false,
        message: "The API database is not ready. Retry shortly.",
        code: startupFailure?.code || "STARTUP_FAILED",
      });
    }
    return next();
  });
}

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
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob: https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com https://checkout.razorpay.com https://cdn.razorpay.com https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com; " +
    "script-src-elem 'self' 'unsafe-eval' 'unsafe-inline' blob: https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com https://checkout.razorpay.com https://cdn.razorpay.com https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self' https://challenges.cloudflare.com https://vercel.live https://*.google.com https://checkout.razorpay.com https://api.razorpay.com; " +
    "connect-src 'self' https://challenges.cloudflare.com https://vercel.live https://bhumivera-backend.railway.app https://bhumiverabackend-production.up.railway.app https://service.bhumivera.com https://analytics.google.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.r2.cloudflarestorage.com https://overbridgenet.com https://api.razorpay.com https://lumberjack.razorpay.com https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com; " +
    "img-src 'self' data: blob: https: https://*.google-analytics.com https://*.analytics.google.com https://*.razorpay.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com; " +
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; " +
    "trusted-types *;"
  );
  
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(self), browsing-topics=()"
  );
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Robots-Tag", "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1");

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// --- SEO, BRAVE SEARCH & GEO STATIC/DYNAMIC ENDPOINTS (Always Available) ---
app.get("/robots.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(generateRobotsTxt());
});

app.get("/llms.txt", (req, res) => {
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(generateLlmsTxt());
});

app.get("/llms-full.txt", (req, res) => {
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(generateLlmsFullTxt());
});

app.get("/bhumivera-indexnow-2026.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send("bhumivera-indexnow-2026");
});

// Mount SSR Prerender Middleware for Search & AI Crawlers
app.use(seoPrerenderMiddleware());

app.use("/health", createHealthRouter(() => ({ databaseReady, failure: startupFailure })));

// --- SEO: DYNAMIC XML SITEMAP GENERATOR (Google, Brave Search, Bing & AI Crawlers) ---
app.get("/sitemap.xml", async (req, res) => {
  try {
    let dbProducts = [];
    if (databaseReady) {
      try {
        const [rows] = await pool.query("SELECT slug, name, updated_at FROM products WHERE status = 'active'");
        dbProducts = Array.isArray(rows) ? rows : [];
      } catch (dbErr) {
        console.warn("[SITEMAP_DB_FALLBACK]:", dbErr.message);
      }
    }

    const today = new Date().toISOString().split("T")[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

    const staticRoutes = [
      { loc: `${SITE_URL}/`, changefreq: "daily", priority: "1.0" },
      { loc: `${SITE_URL}/shop`, changefreq: "daily", priority: "0.95" },
      { loc: `${SITE_URL}/products`, changefreq: "daily", priority: "0.90" },
      { loc: `${SITE_URL}/guides`, changefreq: "weekly", priority: "0.90" },
      { loc: `${SITE_URL}/guides/ultimate-guide-luxury-organic-face-wash-india`, changefreq: "weekly", priority: "0.95" },
      { loc: `${SITE_URL}/guides/science-of-sulfate-free-luxury-herbal-shampoos`, changefreq: "weekly", priority: "0.95" },
      { loc: `${SITE_URL}/science`, changefreq: "weekly", priority: "0.90" },
      { loc: `${SITE_URL}/provenance-engine`, changefreq: "weekly", priority: "0.85" },
      { loc: `${SITE_URL}/somatic-registry`, changefreq: "weekly", priority: "0.85" },
      { loc: `${SITE_URL}/verify`, changefreq: "monthly", priority: "0.80" },
      { loc: `${SITE_URL}/impact`, changefreq: "weekly", priority: "0.80" },
      { loc: `${SITE_URL}/about`, changefreq: "monthly", priority: "0.75" },
      { loc: `${SITE_URL}/contact`, changefreq: "monthly", priority: "0.70" },
      { loc: `${SITE_URL}/purchase-protection`, changefreq: "monthly", priority: "0.65" },
      { loc: `${SITE_URL}/legal`, changefreq: "monthly", priority: "0.50" },
      { loc: `${SITE_URL}/llms.txt`, changefreq: "weekly", priority: "0.80" },
      { loc: `${SITE_URL}/llms-full.txt`, changefreq: "weekly", priority: "0.80" },
    ];

    for (const r of staticRoutes) {
      xml += `\n  <url>\n    <loc>${r.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`;
    }

    const seenSlugs = new Set();
    for (const sku of LUXURY_CATALOG_SKUS) {
      seenSlugs.add(sku.slug);
      const imgLoc = sku.image_url.startsWith("http") ? sku.image_url : `${SITE_URL}${sku.image_url}`;
      xml += `\n  <url>\n    <loc>${SITE_URL}/product/${sku.slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.95</priority>\n    <image:image>\n      <image:loc>${imgLoc}</image:loc>\n      <image:title>${sku.name.replace(/&/g, "&amp;")}</image:title>\n    </image:image>\n  </url>`;
    }

    for (const p of dbProducts) {
      if (!p.slug || seenSlugs.has(p.slug)) continue;
      seenSlugs.add(p.slug);
      const lastModDate = p.updated_at ? new Date(p.updated_at).toISOString().split("T")[0] : today;
      xml += `\n  <url>\n    <loc>${SITE_URL}/product/${p.slug}</loc>\n    <lastmod>${lastModDate}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.85</priority>\n  </url>`;
    }

    xml += `\n</urlset>`;
    res.header("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    console.error("[SITEMAP ERROR]:", err);
    res.status(500).end();
  }
});

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

app.get("/", (req, res) => res.json({ status: "ok", message: "Bhumivera Maison Core API running!" }));

// --- ERROR HANDLING ---
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: `API Endpoint Not Found: ${req.originalUrl}` });
});

app.use(requestErrorHandler);

const PORT = process.env.PORT || 5000;
const httpServer = isVercel ? null : app.listen(PORT, () => {
  console.log(`Access Core Online on Port ${PORT}`);
});

const initializeDatabase = () => {
  if (databaseReady) return Promise.resolve(true);
  if (databaseInitializationPromise) return databaseInitializationPromise;

  databaseInitializationPromise = (async () => {
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
      if (!isVercel && !referralApprovalTimer) {
        const runReferralApprovals = () => approveDueReferralClaims().catch(error => {
          console.error('[REFERRAL_AUTO_APPROVAL_RUN]', error);
        });
        runReferralApprovals();
        referralApprovalTimer = setInterval(runReferralApprovals, 15000);
        referralApprovalTimer.unref();
      }
      if (!isVercel && !telegramWebhookTimer) {
        const configureTelegramWebhook = async () => {
          if (telegramWebhookSetupRunning) return;
          telegramWebhookSetupRunning = true;
          try {
            const featureConfig = await getAiSupportFeatureConfig(pool);
            const webhookResult = await registerTelegramWebhook({
              botToken: resolveTelegramBotToken(featureConfig),
            });
            if (!webhookResult.ok) {
              console.error(
                "[TELEGRAM_WEBHOOK_SETUP]",
                webhookResult.description || webhookResult.error || "Telegram webhook registration failed."
              );
              return;
            }
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
      return true;
    } catch (err) {
      databaseReady = false;
      startupFailure = err.migration
        ? { migration: err.migration, code: err.code || "MIGRATION_FAILED" }
        : { code: err.code || "STARTUP_FAILED" };
      console.error("[STARTUP] Required database initialization failed; API will retry.", err);
      if (!isVercel) setTimeout(() => void initializeDatabase(), 15000).unref();
      return false;
    }
  })().finally(() => {
    databaseInitializationPromise = null;
  });

  return databaseInitializationPromise;
};

if (!isVercel) void initializeDatabase();

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

if (httpServer) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
