require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const path = require("path");
const bcrypt = require("bcrypt");

// Route Imports
const categoryRoutes = require("./routes/categoryRoutes");
const affiliateRoutes = require("./routes/affiliateRoutes");
const taxRoutes = require("./routes/taxRoutes");
const walletRoutes = require("./routes/walletRoutes");
const searchRoutes = require("./routes/searchRoutes");
const flashSalesRoutes = require("./routes/flashSalesRoutes");
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
const bannerRoutes = require("./routes/bannerRoutes");
const fitmentRoutes = require("./routes/fitmentRoutes");
const warehouseRoutes = require("./routes/warehouseRoutes");

// Model Initializations
const { initWarehouseTables } = require("./models/warehouseModel");
const { initWalletTables } = require("./models/walletModel");
const { createBannerTable } = require("./models/bannerModel");
const { createCartTable } = require("./models/cartModel");
const { createOrdersTables } = require("./models/orderModel");
const { createAddressTable } = require("./models/addressModel");
const { initProductsTable } = require("./models/productModel");
const { initCategoriesTable } = require("./models/categoryModel");
const { initReturnsTable } = require("./models/returnModel");
const { initContactTable } = require("./models/contactModel");
const { initAdminTable } = require("./models/adminModel");

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
    const isAllowed = allowedOrigins.includes(origin) || origin.endsWith(".vercel.app") || process.env.NODE_ENV === "development";
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

// FIX for "goog#html" Trusted Types Block
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "require-trusted-types-for 'script'; trusted-types ymiGc5 default goog#html");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- ROUTE REGISTRATION ---
app.use("/api/flash-sales", flashSalesRoutes);
app.use("/api/affiliate", affiliateRoutes);
app.use("/api/tax", taxRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/fitments", fitmentRoutes);
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
app.use("/api/addresses", addressRoutes);
app.use("/api/admin", adminUserRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/warehouse", warehouseRoutes);

app.get("/", (req, res) => res.json({ status: "ok", message: "Bhumivera Eco-Lab Core API running!" }));

// --- DATABASE INITIALIZATION (Fixes 500 Errors) ---
async function initDB() {
  try {
    const safeInit = async (name, initFunction) => {
      if (typeof initFunction === 'function') {
        try { await initFunction(); } catch (e) { console.warn(`[DB_INIT] ${name} Warning:`, e.message); }
      }
    };

    await safeInit('Categories', initCategoriesTable);
    await safeInit('Products', initProductsTable);
    await safeInit('Address', createAddressTable);
    await safeInit('Wallet', initWalletTables);
    await safeInit('Cart', createCartTable);
    await safeInit('Orders', createOrdersTables);
    await safeInit('Banner', createBannerTable);
    await safeInit('Returns', initReturnsTable);
    await safeInit('Contact', initContactTable);
    await safeInit('Admin', initAdminTable);

    // Initialize Settings (Fixes /api/settings/public 500 error)
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

    // Auto-Provision Root Admin
    const [adminCheck] = await pool.query("SELECT * FROM admin_users WHERE email='adminbhumivera27@gmail.com'");
    if (adminCheck.length === 0) {
      const hash = await bcrypt.hash('Bhumivera#*@2026', 10);
      await pool.query(
        "INSERT INTO admin_users (email, password_hash, role) VALUES ('adminbhumivera27@gmail.com', ?, 'superadmin')",
        [hash]
      );
      console.log('--- ROOT ADMIN NODE ACTIVATED: adminbhumivera27@gmail.com ---');
    }

    // Auto-Provision Warehouse
    const [wh] = await pool.query("SELECT * FROM admin_users WHERE email='adminwarehouse2026'");
    if (wh.length === 0) {
      const wHash = await bcrypt.hash('Bhumivera#*@2026', 10);
      await pool.query(
        "INSERT INTO admin_users (email, password_hash, role) VALUES ('adminwarehouse2026', ?, 'warehouse_admin')",
        [wHash]
      );
    }

  } catch (err) {
    console.error("Critical Init Error:", err.message);
  }
}

// --- ERROR HANDLING ---
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: `API Endpoint Not Found: ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") return res.status(403).json({ success: false, message: "CORS Origin Rejected" });
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") return res.status(401).json({ success: false, message: "Session invalid or expired" });
  res.status(err.status || 500).json({ success: false, message: err.message || "Internal Server Error" });
});

const PORT = process.env.PORT || 5000;
initWarehouseTables().catch(e => {});

app.listen(PORT, async () => {
  console.log(`Node Core Online on Port ${PORT}`);
  await initDB();
});

module.exports = app;
