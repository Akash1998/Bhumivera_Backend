const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { 
  getAllUsers, 
  getUserById, 
  getUserByEmail, 
  updateUserStatus, 
  updateUserPassword, 
  deleteUser,
  saveResetOtp
} = require('../models/userModel');
const { getAllOrders, updateOrderStatus, getOrderById } = require('../models/orderModel');
const { sendMail } = require('../utils/mail');

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
    const users = await getAllUsers();
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load users' });
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

router.put('/users/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await updateUserStatus(req.params.id, status);
    return res.json({ message: 'User status updated' });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to update user status' });
  }
});

router.post('/users/:id/reset-password', authenticateAdmin, async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { newPassword } = req.body;
    if (newPassword) {
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
      }
      const hash = await bcrypt.hash(newPassword, 10);
      await updateUserPassword(user.id, hash);
      return res.json({ message: `Password for ${user.email} has been reset.` });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await saveResetOtp(user.id, otp, expiresAt);

    await sendMail({
      to: user.email,
      subject: 'Your Bhumivera Password Reset OTP',
      html: `<p>An administrator has triggered a password reset for your account.</p><p>Your OTP is: <strong>${otp}</strong></p><p>It expires in 15 minutes.</p>`,
      text: `Admin triggered reset. OTP: ${otp}. Expires in 15 minutes.`,
    });

    return res.json({ message: `Password reset OTP sent to ${user.email}.` });
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
