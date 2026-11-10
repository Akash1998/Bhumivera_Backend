const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// Shared analytics handler
const getDashboardData = async (req, res) => {
  try {
    const period = ['7d', '30d', '90d', '1y'].includes(req.query.period)
      ? req.query.period
      : '30d';
    const daysByPeriod = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = daysByPeriod[period];
    const dateFormat = period === '1y' ? '%b %Y' : '%b %d';
    const dateGroup = period === '1y'
      ? 'YEAR(created_at), MONTH(created_at)'
      : 'DATE(created_at)';

    const [salesResult, metricResult, categoryResult] = await Promise.all([
      db.execute(`
        SELECT DATE_FORMAT(created_at, '${dateFormat}') as name,
          SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) as orders,
          SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) as revenue
        FROM orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ${dateGroup}, DATE_FORMAT(created_at, '${dateFormat}')
        ORDER BY MIN(created_at) ASC
      `, [days]),
      db.execute(`
        SELECT
          COALESCE(SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END), 0) as totalOrders,
          COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) as totalRevenue,
          (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) as newUsers,
          (SELECT COUNT(*) FROM products WHERE status = 'active') as totalProducts,
          (SELECT COUNT(*) FROM orders WHERE status = 'pending') as pending
        FROM orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [days, days]),
      db.execute(`
        SELECT c.name, SUM(oi.price * oi.quantity) as sales
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        JOIN categories c ON p.category_id = c.id
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status != 'cancelled' AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY c.name
        ORDER BY sales DESC
        LIMIT 5
      `, [days]),
    ]);
    const [salesData] = salesResult;
    const [totalStats] = metricResult;
    const [categoryData] = categoryResult;
    const metrics = totalStats[0];

    res.json({
      chartData: salesData,
      categoryData: categoryData,
      metrics: {
        revenue: metrics.totalRevenue || 0,
        orders: metrics.totalOrders || 0,
        newCustomers: metrics.newUsers || 0,
        avgOrderValue: metrics.totalOrders > 0
          ? (metrics.totalRevenue / metrics.totalOrders).toFixed(2)
          : 0,
        totalProducts: metrics.totalProducts || 0,
        pendingOrders: metrics.pending || 0
      }
    });
  } catch (error) {
    console.error('Analytics Error:', error);
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
  }
};

// Both routes point to same handler
router.get('/kpis', authenticateAdmin, getDashboardData);
router.get('/dashboard', authenticateAdmin, getDashboardData);
router.get('/sales', authenticateAdmin, getDashboardData);
router.get('/revenue', authenticateAdmin, getDashboardData); // Added missing route

// FIXED: ER_WRONG_FIELD_WITH_GROUP error patched via explicit multi-column grouping
router.get('/products', authenticateAdmin, async (req, res) => {
  try {
    const period = ['7d', '30d', '90d', '1y'].includes(req.query.period)
      ? req.query.period
      : '30d';
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period];
    const [rows] = await db.execute(`
      SELECT p.id, p.name, p.price, p.discount_price, p.quantity,
        p.rating, p.review_count, p.status, c.name as category_name,
        COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity ELSE 0 END), 0) as total_sold,
        COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.price * oi.quantity ELSE 0 END), 0) as revenue
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      LEFT JOIN orders o ON oi.order_id = o.id
        AND o.status != 'cancelled'
        AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY p.id, p.name, p.price, p.discount_price, p.quantity, p.rating, p.review_count, p.status, c.name
      ORDER BY total_sold DESC
      LIMIT 20
    `, [days]);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product analytics' });
  }
});

module.exports = router;
