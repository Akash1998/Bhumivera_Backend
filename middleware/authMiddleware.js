const jwt = require('jsonwebtoken');

// ── authenticateAdmin: Verifies JWT, confirms role is 'admin' or 'superadmin' ──
const authenticateAdmin = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing token' });
  }

  try {
    const token = auth.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.role !== 'admin' && payload.role !== 'superadmin') {
      return res.status(403).json({ message: 'Access denied: Admin privileges required.' });
    }

    // Setting both req.admin and req.user for maximum compatibility with downstream middleware
    req.admin = { id: payload.id, email: payload.email, role: payload.role };
    req.user = payload; 
    next();
  } catch (err) {
    console.error("[Admin Auth Error]:", err.message);
    return res.status(401).json({ message: 'Invalid or expired admin token' });
  }
};

// ── authenticateUser: Verifies JWT for regular users ──────────────────────────
const authenticateUser = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing token' });
  }

  try {
    const token = auth.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // If they are an admin, we skip the database "is_active" check for speed
    if (payload.role === 'admin' || payload.role === 'superadmin') {
      req.user = payload;
      return next();
    }

    const pool = require('../config/db');
    try {
      const [userData] = await pool.query('SELECT is_active FROM users WHERE id = ?', [payload.id]);
      if (!userData || userData.length === 0 || userData[0].is_active === 0) {
        return res.status(401).json({ message: 'Account is disabled or deleted.' });
      }
    } catch (dbErr) {
      if (dbErr.code === 'ER_BAD_FIELD_ERROR') {
        console.warn("⚠️ Column 'is_active' not found in users table. Bypassing active check.");
      } else {
        throw dbErr;
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    console.error("[User Auth Error]:", err.message);
    return res.status(401).json({ message: 'Invalid or expired user token' });
  }
};

// ── isAdmin: Super Admin only (anritvox.com/admin) ────────────────────────────
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'superadmin') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Access Denied: Super Admin Only.' });
  }
};

// ── isWarehouseAdmin: Warehouse staff, Admins, + Superadmins ──────────────────
const isWarehouseAdmin = (req, res, next) => {
  // Added 'admin' to the check to resolve 403 errors for admin logins
  if (req.user && (req.user.role === 'admin' || req.user.role === 'warehouse_admin' || req.user.role === 'superadmin')) {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Access Denied: Warehouse Staff Only.' });
  }
};

module.exports = { 
  authenticateAdmin, 
  authenticateUser, 
  isAdmin, 
  isWarehouseAdmin 
};
