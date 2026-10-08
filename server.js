require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const path = require("path");
const bcrypt = require("bcryptjs");

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
const warrantyRoutes = require("./routes/warrantyRoutes");
const contactRoutes = require("./routes/contactRoutes");
const authRoutes = require("./routes/authRoutes");
const serialRoutes = require("./routes/serialRoutes");
const { router: userRoutes } = require("./routes/userRoutes");
const cartRoutes = require("./routes/cartRoutes");
const orderRoutes = require("./routes/orderRoutes");
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
const clientLogRoutes = require("./routes/clientLogRoutes");
const logsRoutes = require("./routes/logsRoutes");
const newsletterRoutes = require("./routes/newsletterRoutes");
const gamificationRoutes = require("./routes/gamificationRoutes");
const impactRoutes = require("./routes/impactRoutes");

// Model Initializations
const { initWarehouseTables } = require("./models/warehouseModel");
const { initWalletTables } = require("./models/walletModel");
const { createCartTable } = require("./models/cartModel");
const { createOrdersTables } = require("./models/orderModel");
const { createAddressTable } = require("./models/addressModel");
const { initProductsTable } = require("./models/productModel");
const { initCategoriesTable } = require("./models/categoryModel");
const { initReturnsTable } = require("./models/returnModel");
const { initContactTable } = require("./models/contactModel");
const { initAdminTable } = require("./models/adminModel");
const { createUsersTable, initAuthTables } = require("./models/userModel");
const { createReviewTable } = require("./models/reviewModel"); 
const { createNotificationTable } = require("./models/notificationModel");
const { createClientErrorTable } = require("./models/clientErrorModel");
const { createError, normalizeErrorResponses, sendError } = require("./utils/errorReporting");
const { createSettingsTable } = require("./models/settingsModel");
const { createCartRulesTable } = require("./models/cartRulesModel");
const { createLoyaltyTierTable } = require("./models/loyaltyTierModel");
const { createNewsletterTable } = require("./models/newsletterModel");
const { createShippingTable } = require("./models/shippingModel");
const { initSerialTable } = require("./models/serialModel");
const { initImpactTables } = require("./models/impactModel");

const app = express();

// --- SECURITY & CORS POLICIES ---
const allowedOrigins = [
  "https://www.bhumivera.com",
  "https://bhumivera.com",
  "http://localhost:5173",
  "http://localhost:3000"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const currentEnv = process.env.NODE_ENV || process.env.access_ENV || "production";
    const isAllowed = allowedOrigins.includes(origin) || origin.endsWith(".vercel.app") || currentEnv === "development";
    if (isAllowed) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; " +
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob: https://challenges.cloudflare.com https://vercel.live https://overbridgenet.com https://www.google-analytics.com https://ssl.google-analytics.com https://www.googletagmanager.com; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self' https://challenges.cloudflare.com https://vercel.live https://*.google.com; " +
    "connect-src 'self' https://challenges.cloudflare.com https://vercel.live https://bhumivera-backend.railway.app https://bhumiverabackend-production.up.railway.app https://service.bhumivera.com https://analytics.google.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.r2.cloudflarestorage.com https://overbridgenet.com; " +
    "img-src 'self' data: blob: https: https://*.google-analytics.com https://*.analytics.google.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "trusted-types *;"
  );
  
  // Explicitly override downstream noise and clear DevTools warnings
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(normalizeErrorResponses);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- ROUTE REGISTRATION ---
app.use("/api/flash-sales", flashSalesRoutes);
app.use("/api/client-log", clientLogRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/ai", aiRoutes); 
app.use("/api/affiliate", affiliateRoutes);
app.use("/api/tax", taxRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/subcategories", subcategoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/warranty", warrantyRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/serials", serialRoutes);
app.use("/api/users", userRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/impact", impactRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/admin", adminUserRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/gamification", gamificationRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/warehouse", warehouseRoutes);

// --- SEO: DYNAMIC XML SITEMAP GENERATOR ---
app.get("/sitemap.xml", async (req, res) => {
  try {
    const [products] = await pool.query("SELECT slug, updated_at FROM products WHERE status = 'active'");
    
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    
    xml += `\n  <url>\n    <loc>https://www.bhumivera.com/</loc>\n    <priority>1.0</priority>\n  </url>`;
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

app.get("/", (req, res) => res.json({ status: "ok", message: "Bhumivera Eco-Lab Core API running!" }));

// --- DATABASE INITIALIZATION ---
async function initDB() {
  try {
    const safeInit = async (name, initFunction) => {
      if (typeof initFunction === 'function') {
        try { await initFunction(); } catch (e) { console.warn(`[DB_INIT] ${name} Warning:`, e.message); }
      }
    };

    // Authentication schema migrations must finish before the API accepts requests.
    await createUsersTable();
    await safeInit('Auth', initAuthTables);
    await safeInit('Categories', initCategoriesTable);
    await safeInit('Products', initProductsTable);
    await safeInit('ProductSerials', initSerialTable);
    await safeInit('Reviews', createReviewTable);
    await safeInit('Notifications', createNotificationTable);
    await safeInit('Address', createAddressTable);
    await safeInit('Wallet', initWalletTables);
    await safeInit('Cart', createCartTable);
    await safeInit('Orders', createOrdersTables);
    await safeInit('ImpactLedger', initImpactTables);
    await safeInit('Returns', initReturnsTable);
    await safeInit('Contact', initContactTable);
    await safeInit('Admin', initAdminTable);
    await safeInit('Warehouse', initWarehouseTables); 
    await safeInit('Settings', createSettingsTable);
    await safeInit('CartRules', createCartRulesTable);
    await safeInit('LoyaltyTiers', createLoyaltyTierTable);
    await safeInit('Newsletter', createNewsletterTable);
    await safeInit('ShippingZones', createShippingTable);
    await safeInit('ClientErrorLogs', createClientErrorTable);

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_name VARCHAR(50) NOT NULL,
          key_name VARCHAR(50) UNIQUE NOT NULL,
          value TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const initialSettings = [
        ['general', 'site_name', 'Bhumivera'],
        ['seo', 'meta_title', 'Bhumivera | Botanical Science'],
        ['policy', 'return_policy', '15-day botanical window']
      ];
      for (const [g, k, v] of initialSettings) {
        await pool.query("INSERT IGNORE INTO settings (group_name, key_name, value) VALUES (?, ?, ?)", [g, k, v]);
      }
    } catch (settingErr) {
      console.warn("[DB_INIT] Settings Table Warning:", settingErr.message);
    }

    try {
      const [adminCheck] = await pool.query("SELECT * FROM admin_users WHERE email='adminbhumivera27@gmail.com'");
      if (adminCheck.length === 0) {
        const hash = await bcrypt.hash('Akash#*@1998', 10);
        await pool.query(
          "INSERT INTO admin_users (email, password_hash, role) VALUES ('adminbhumivera27@gmail.com', ?, 'superadmin')",
          [hash]
        );
        console.log('--- ROOT ADMIN ACCESS ACTIVATED: adminbhumivera27@gmail.com ---');
      }
    } catch (adminQueryErr) {
      console.warn("[DB_INIT] Admin Master Account Verification Deferred:", adminQueryErr.message);
    }
  } catch (err) {
    console.error("Critical Init Error:", err.message);
    throw err;
  }
}

// --- ERROR HANDLING ---
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: `API Endpoint Not Found: ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return sendError(res, createError(403, 'CORS_ORIGIN_REJECTED', 'CORS origin rejected.'));
  }
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return sendError(res, createError(401, 'TOKEN_INVALID', 'Session invalid or expired.'));
  }
  console.error('[UNHANDLED_REQUEST_ERROR]', err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  const message = status >= 500 ? 'An unexpected server error occurred.' : (err.message || 'The request could not be processed.');
  return sendError(res, createError(status, status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED', message));
});

const PORT = process.env.PORT || 5000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Access Core Online on Port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[STARTUP] Required database initialization failed; API will not start.", err);
    process.exitCode = 1;
});

module.exports = app;
