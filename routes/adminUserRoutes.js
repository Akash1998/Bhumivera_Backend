const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { 
  getAdminCustomers,
  getUserById, 
  updateUserStatus, 
  deleteUser,
  saveResetOtp
} = require('../models/userModel');
const { getAllOrders, getOrdersByUser, updateOrderStatus, getOrderById } = require('../models/orderModel');
const { getAllReviews } = require('../models/reviewModel');
const { sendMail } = require('../utils/mail');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const isPositiveId = value =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0);

router.get('/reviews', authenticateAdmin, async (req, res) => {
  try {
    const approved = req.query.approved !== undefined ? Number.parseInt(req.query.approved, 10) : null;
    return res.json(await getAllReviews(Number.isNaN(approved) ? null : approved));
  } catch (error) {
    console.error('[ADMIN_REVIEWS_ALIAS]', error);
    return res.status(500).json({ message: 'Failed to get reviews.' });
  }
});

router.get('/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const [orderStats] = await db.query('SELECT COUNT(*) as totalOrders, SUM(total) as totalRevenue FROM orders WHERE status != "cancelled"');
    const [userStats] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
    const [productStats] = await db.query('SELECT COUNT(*) as totalProducts FROM products');
    const [pendingStats] = await db.query('SELECT COUNT(*) as pendingOrders FROM orders WHERE status = "pending"');

    res.json({
      totalOrders: orderStats[0].totalOrders || 0,
      totalRevenue: orderStats[0].totalRevenue || 0,
      totalUsers: userStats[0].totalUsers || 0,
      totalProducts: productStats[0].totalProducts || 0,
      pendingOrders: pendingStats[0].pendingOrders || 0
    });
  } catch (err) {
    console.error("Dashboard Stats Error:", err);
    res.status(500).json({ message: 'Failed to load dashboard stats' });
  }
});

router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    const result = await getAdminCustomers({
      page: req.query.page,
      limit: req.query.limit,
      search: typeof req.query.search === 'string' ? req.query.search : '',
      status: ['active', 'disabled'].includes(req.query.status) ? req.query.status : 'all',
      activity: ['ordered', 'no-orders', 'loyalty'].includes(req.query.activity) ? req.query.activity : 'all',
      sort: ['recent', 'orders', 'loyalty', 'value'].includes(req.query.sort) ? req.query.sort : 'recent'
    });
    return res.json(result);
  } catch (err) {
    console.error('[ADMIN_CUSTOMERS_LIST]', err);
    return res.status(500).json({ message: 'Failed to load users' });
  }
});

router.post('/users/notifications', authenticateAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.userIds)
      ? [...new Set(req.body.userIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
      : [];
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const type = req.body?.type === 'promotion' ? 'promotion' : 'system';
    if (!ids.length || ids.length > 500) {
      return res.status(400).json({ message: 'Select between 1 and 500 customers.' });
    }
    if (!title || title.length > 255 || !message || message.length > 5000) {
      return res.status(400).json({ message: 'A title (up to 255 characters) and message (up to 5000 characters) are required.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await db.query(
      `INSERT INTO notifications (user_id, title, message, type, is_global)
       SELECT id, ?, ?, ?, 0 FROM users WHERE role = 'customer' AND id IN (${placeholders})`,
      [title, message, type, ...ids]
    );
    return res.status(201).json({ message: 'Customer notification sent.', recipientCount: result.affectedRows });
  } catch (err) {
    console.error('[ADMIN_CUSTOMER_NOTIFICATION]', err);
    return res.status(500).json({ message: 'Failed to send customer notification.' });
  }
});

router.post('/users/email-campaigns', authenticateAdmin, async (req, res) => {
  const requestedIds = req.body?.userIds;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (
    !Array.isArray(requestedIds) ||
    requestedIds.length < 1 ||
    requestedIds.length > 500 ||
    requestedIds.some(id => !isPositiveId(id))
  ) {
    return res.status(400).json({ message: 'Select between 1 and 500 valid customers.' });
  }
  if (!title || title.length > 200 || !message || message.length > 10000) {
    return res.status(400).json({ message: 'A subject (up to 200 characters) and message (up to 10000 characters) are required.' });
  }

  try {
    const ids = [...new Set(requestedIds.map(Number))];
    const placeholders = ids.map(() => '?').join(',');
    const [recipients] = await db.query(
      `SELECT email FROM users
       WHERE role = 'customer' AND marketing_email_opt_in = 1 AND id IN (${placeholders})`,
      ids
    );
    if (recipients.length === 0) {
      return res.status(409).json({ message: 'None of the selected customers have opted in to promotional emails.' });
    }

    const safeSubject = title.replace(/[\r\n]+/g, ' ');
    const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>');
    await sendMail({
      to: recipients.map(recipient => recipient.email),
      subject: safeSubject,
      text: `${message}\n\nYou received this promotional email because you opted in to Bhumivera updates. To change your preference, sign in and visit Profile > Security at https://www.bhumivera.com/profile.`,
      html: `<main style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#173326;line-height:1.6"><h2>${escapeHtml(title)}</h2><p>${safeMessage}</p><hr><p style="font-size:12px;color:#66736b">You received this promotional email because you opted in to Bhumivera updates. To change your preference, sign in and visit <a href="https://www.bhumivera.com/profile">Profile &gt; Security</a>.</p></main>`
    });
    return res.json({
      success: true,
      recipientCount: recipients.length,
      message: `Email campaign sent to ${recipients.length} opted-in customer(s).`
    });
  } catch (err) {
    console.error('[ADMIN_CUSTOMER_EMAIL_CAMPAIGN]', err);
    return res.status(502).json({ message: 'Campaign delivery could not be confirmed. Check the email service before retrying to avoid duplicates.' });
  }
});

router.get('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load user' });
  }
});

router.get('/users/:id/orders', authenticateAdmin, async (req, res) => {
  try {
    const customer = await getUserById(req.params.id);
    if (!customer || customer.role !== 'customer') return res.status(404).json({ message: 'Customer not found' });
    return res.json(await getOrdersByUser(customer.id));
  } catch (err) {
    console.error('[ADMIN_CUSTOMER_ORDERS]', err);
    return res.status(500).json({ message: 'Failed to load customer order history' });
  }
});

const setCustomerStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ message: 'Status must be active or disabled.' });
    }
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found' });
    await updateUserStatus(req.params.id, status);
    return res.json({ message: 'Customer status updated', is_active: status === 'active' ? 1 : 0 });
  } catch (err) {
    console.error('[ADMIN_CUSTOMER_STATUS]', err);
    return res.status(500).json({ message: 'Failed to update user status' });
  }
};
router.put('/users/:id/status', authenticateAdmin, setCustomerStatus);
router.patch('/users/:id/status', authenticateAdmin, setCustomerStatus);

router.post('/users/:id/reset-password', authenticateAdmin, async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found' });

    const otp = crypto.randomInt(100000, 1000000).toString();
    await saveResetOtp(user.id, otp);

    await sendMail({
      to: user.email,
      subject: 'Your Bhumivera Password Reset OTP',
      html: `<p>An administrator has triggered a password reset for your account.</p><p>Your OTP is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`,
      text: `An administrator has triggered a password reset for your account. Your OTP is ${otp}. It expires in 10 minutes.`,
    });

    return res.json({ message: `Password reset OTP sent to ${user.email}. It expires in 10 minutes.` });
  } catch (err) {
    console.error('Admin reset-password error:', err);
    return res.status(500).json({ message: 'Failed to reset password' });
  }
});

router.delete('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    await deleteUser(req.params.id);
    return res.json({ message: 'User deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to delete user' });
  }
});

router.get('/orders', authenticateAdmin, async (req, res) => {
  try {
    const orders = await getAllOrders();
    return res.json(orders);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load orders' });
  }
});

router.get('/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load order' });
  }
});

router.put('/orders/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status, tracking_number, courier } = req.body;
    const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    let sql = 'UPDATE orders SET status = ?';
    let params = [status];

    if (tracking_number !== undefined) {
      sql += ', tracking_number = ?';
      params.push(tracking_number);
    }
    if (courier !== undefined) {
      sql += ', courier = ?';
      params.push(courier);
    }

    sql += ' WHERE id = ?';
    params.push(req.params.id);

    await db.query(sql, params);

    if (status === 'cancelled' || status === 'returned') {
       await updateOrderStatus(req.params.id, status);
    }

    return res.json({ message: 'Order updated successfully' });
  } catch (err) {
    console.error("Update Order Error:", err);
    return res.status(500).json({ message: 'Failed to update order' });
  }
});

router.get('/orders/export/csv', authenticateAdmin, async (req, res) => {
  try {
    const orders = await getAllOrders();
    const headers = ['ID', 'Status', 'Total', 'Customer Email', 'Created'];
    const rows = orders.map(o => [
      o.id,
      o.status,
      o.total || 0,
      o.user_email || '',
      o.created_at || ''
    ]);
    
    let csv = headers.join(',') + '\n';
    rows.forEach(row => {
      csv += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    return res.status(200).send(csv);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to export orders' });
  }
});

module.exports = router;
