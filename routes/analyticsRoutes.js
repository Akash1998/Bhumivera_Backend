const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');

// Shared analytics handler
const getDashboardData = async (req, res) => {
  try {
    const period = req.query.period || '30d';
    let days = 30;
    if (period === '7d') days = 7;
    if (period === '90d') days = 90;

    // 1. Time-Series Sales Velocity Data
    // FIXED: Appended DATE_FORMAT to GROUP BY to bypass ER_WRONG_FIELD_WITH_GROUP
    const [salesData] = await db.execute(`
      SELECT DATE_FORMAT(created_at, '%b %d') as name,
        COUNT(*) as orders,
        SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) as revenue
      FROM orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(created_at), DATE_FORMAT(created_at, '%b %d')
      ORDER BY DATE(created_at) ASC
    `, [days]);

    // 2. Global KPI Metrics
    const [totalStats] = await db.execute(`
      SELECT
        COUNT(*) as totalOrders,
        SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END) as totalRevenue
      FROM orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    // 3. User Acquisition
    const [userStats] = await db.execute(`
      SELECT COUNT(*) as newUsers
      FROM users
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    // 4. Active Catalog Size
    const [productStats] = await db.execute(`
      SELECT COUNT(*) as totalProducts FROM products WHERE status = 'active'
    `);

    // 5. Fulfillment Pipeline
    const [pendingOrders] = await db.execute(`
      SELECT COUNT(*) as pending FROM orders WHERE status = 'pending'
    `);

    // 6. Real Inventory Movement (Category Level Aggregation)
    const [categoryData] = await db.execute(`
      SELECT c.name, SUM(oi.price * oi.quantity) as sales
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status != 'cancelled' AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY c.name
      ORDER BY sales DESC
      LIMIT 5
    `, [days]);

    res.json({
      chartData: salesData,
      categoryData: categoryData,
      metrics: {
        revenue: totalStats[0].totalRevenue || 0,
        orders: totalStats[0].totalOrders || 0,
        newCustomers: userStats[0].newUsers || 0,
        avgOrderValue: totalStats[0].totalOrders > 0
          ? (totalStats[0].totalRevenue / totalStats[0].totalOrders).toFixed(2)
          : 0,
        totalProducts: productStats[0].totalProducts || 0,
        pendingOrders: pendingOrders[0].pending || 0
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
    const [rows] = await db.execute(`
      SELECT p.id, p.name, p.price, p.discount_price, p.quantity,
        p.rating, p.review_count, p.status, c.name as category_name,
        COUNT(oi.id) as total_sold
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN order_items oi ON p.id = oi.product_id
      GROUP BY p.id, p.name, p.price, p.discount_price, p.quantity, p.rating, p.review_count, p.status, c.name
      ORDER BY total_sold DESC
      LIMIT 20
    `);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product analytics' });
  }
});

module.exports = router;
