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
const { notifyOrderWhatsApp } = require('../services/orderWhatsAppNotifier');

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

router.get('/users/email-campaigns/recipients', authenticateAdmin, async (req, res) => {
  try {
    const [[result]] = await db.query(
      `SELECT COUNT(DISTINCT email) AS recipientCount
       FROM users
       WHERE role = 'customer'
         AND is_active = 1
         AND marketing_email_opt_in = 1
         AND email IS NOT NULL
         AND TRIM(email) <> ''`
    );
    return res.json({ recipientCount: Number(result?.recipientCount || 0) });
  } catch (error) {
    console.error('[ADMIN_EMAIL_CAMPAIGN_RECIPIENTS]', error);
    return res.status(500).json({ message: 'Could not count customers opted in to promotional email.' });
  }
});

router.post('/users/email-campaigns', authenticateAdmin, async (req, res) => {
  const audience = req.body?.audience === 'all_opted_in' ? 'all_opted_in' : 'selected';
  const requestedIds = req.body?.userIds;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (audience === 'selected' && (
    !Array.isArray(requestedIds) ||
    requestedIds.length < 1 ||
    requestedIds.length > 500 ||
    requestedIds.some(id => !isPositiveId(id))
  )) {
    return res.status(400).json({ message: 'Select between 1 and 500 valid customers.' });
  }
  if (!title || title.length > 200 || !message || message.length > 10000) {
    return res.status(400).json({ message: 'A subject (up to 200 characters) and message (up to 10000 characters) are required.' });
  }

  try {
    let recipients;
    if (audience === 'all_opted_in') {
      [recipients] = await db.query(
        `SELECT DISTINCT email FROM users
         WHERE role = 'customer'
           AND is_active = 1
           AND marketing_email_opt_in = 1
           AND email IS NOT NULL
           AND TRIM(email) <> ''`
      );
    } else {
      const ids = [...new Set(requestedIds.map(Number))];
      const placeholders = ids.map(() => '?').join(',');
      [recipients] = await db.query(
        `SELECT DISTINCT email FROM users
         WHERE role = 'customer'
           AND is_active = 1
           AND marketing_email_opt_in = 1
           AND email IS NOT NULL
           AND TRIM(email) <> ''
           AND id IN (${placeholders})`,
        ids
      );
    }
    if (recipients.length === 0) {
      return res.status(409).json({
        message: audience === 'all_opted_in'
          ? 'There are no active customers opted in to promotional emails.'
          : 'None of the selected active customers have opted in to promotional emails.'
      });
    }

    const safeSubject = title.replace(/[\r\n]+/g, ' ');
    const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>');
    await sendMail({
      to: recipients.map(recipient => recipient.email),
      subject: safeSubject,
      text: `${message}\n\nYou received this promotional email because you opted in to Bhumivera updates. To change your preference, sign in and visit Profile at https://www.bhumivera.com/profile.\n\nSupport: https://www.bhumivera.com/contact | WhatsApp: https://wa.me/917430985647 | Email: support@bhumivera.com`,
      html: `<!doctype html><html lang="en"><body style="margin:0;padding:32px 16px;background:#faf8f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden"><tr><td style="padding:24px;text-align:center;border-bottom:3px solid #d4af37"><a href="https://www.bhumivera.com" style="text-decoration:none"><img src="https://www.bhumivera.com/logo.webp" width="56" height="56" alt="Bhumivera" style="display:block;margin:0 auto 8px;border:0"><span style="font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:3px;color:#0b2419">BHUMIVERA</span></a><div style="margin-top:6px;font-size:11px;letter-spacing:1px;color:#8b5a2b">BOTANICAL SCIENCE, THOUGHTFULLY MADE</div></td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:25px;line-height:1.3;color:#0b2419">${escapeHtml(title)}</h1><div style="font-size:15px;line-height:1.8;color:#374151">${safeMessage}</div></td></tr><tr><td style="padding:22px;background:#faf8f5;border-top:1px solid #e7e5e4;text-align:center;font-size:12px;line-height:1.8;color:#64748b">You received this promotional email because you opted in to Bhumivera updates. Manage your preferences in your <a href="https://www.bhumivera.com/profile" style="color:#8b5a2b">account profile</a>.<br><a href="https://www.bhumivera.com/contact" style="color:#8b5a2b">Support portal</a> · <a href="https://wa.me/917430985647" style="color:#8b5a2b">WhatsApp chat</a> · <a href="mailto:support@bhumivera.com" style="color:#8b5a2b">Email support</a><br>© 2026 Bhumivera</td></tr></table></body></html>`
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
    const deleted = await deleteUser(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Customer not found' });
    return res.json({
      message: 'Customer account deleted and personal profile details anonymized. Only this customer’s sessions were revoked.',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('[ADMIN_CUSTOMER_DELETE]', err);
    return res.status(500).json({ message: 'Failed to delete customer account' });
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

    const orderId = req.params.id;
    const previousOrder = await getOrderById(orderId);
    if (!previousOrder) return res.status(404).json({ message: 'Order not found' });
    const updated = await updateOrderStatus(orderId, status, req.body.cancel_reason, {
      trackingNumber: tracking_number,
      courier,
    });
    if (updated === false) return res.status(404).json({ message: 'Order not found' });
    const hasOrderUpdate = previousOrder.status !== status ||
      (tracking_number !== undefined && previousOrder.tracking_number !== tracking_number) ||
      (courier !== undefined && previousOrder.courier !== courier);
    if (hasOrderUpdate) {
      void notifyOrderWhatsApp(orderId, status, {
        trackingNumber: tracking_number,
        courier,
        cancelReason: req.body.cancel_reason,
      });
    }
    return res.json({ message: 'Order updated successfully' });
  } catch (err) {
    console.error("Update Order Error:", err);
    if (err.status) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ message: 'Failed to update order' });
  }
});

function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  const sanitized = /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
  return '"' + sanitized.replace(/"/g, '""') + '"';
}

router.get('/orders/export/csv', authenticateAdmin, async (req, res) => {
  try {
    const orders = await getAllOrders();
    const headers = ['ID', 'Status', 'Total', 'Customer Email', 'Created'];
    let csv = headers.map(sanitizeCsvCell).join(',') + '\r\n';
    for (const o of orders) {
      const row = [o.id, o.status, o.total || 0, o.user_email || '', o.created_at || ''];
      csv += row.map(sanitizeCsvCell).join(',') + '\r\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to export orders' });
  }
});
module.exports = router;
