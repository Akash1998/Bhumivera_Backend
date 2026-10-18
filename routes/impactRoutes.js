const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const { authenticateAdmin, authenticateUser } = require('../middleware/authMiddleware');
const { orderLimiter } = require('../middleware/rateLimiter');
const { initImpactTables, getPublicImpact, getAllContributions, getAllImpactUpdates } = require('../models/impactModel');
const { getRazorpayClient, verifyRazorpayPayment } = require('../services/razorpayService');
const {
  IMPACT_DONATION_PROJECTS,
  sendImpactCertificateForContribution,
} = require('../services/impactDonationService');

const router = express.Router();
const PROJECTS = new Set([
  'native-trees',
  'river-care',
  'community-care',
  'saffron-pollinators',
  'sacred-groves',
  'wetland-rejuvenation',
]);
const safeMediaUrl = value => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};
router.post('/donations/create-order', orderLimiter, authenticateUser, async (req, res) => {
  const amount = Number(req.body?.amount);
  const projectKey = req.body?.projectKey;
  if (!Number.isSafeInteger(amount) || amount < 50 || amount > 500000) {
    return res.status(400).json({ success: false, message: 'Enter a contribution amount between ₹50 and ₹5,00,000.' });
  }
  if (!IMPACT_DONATION_PROJECTS.has(projectKey)) {
    return res.status(400).json({ success: false, message: 'Choose a valid impact project.' });
  }

  try {
    await initImpactTables();
    const [[user]] = await pool.query('SELECT id, email FROM users WHERE id = ?', [req.user.id]);
    if (!user || typeof user.email !== 'string' || !user.email.trim()) {
      return res.status(409).json({ success: false, message: 'A registered email address is required for the certificate.' });
    }
    const amountPaise = amount * 100;
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `stewardship-${req.user.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      notes: {
        purpose: 'community_stewardship_token',
        userId: String(req.user.id),
        projectKey,
        amountPaise: String(amountPaise),
      },
    });
    const certificateCode = `BV-${projectKey.slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const dedication = typeof req.body?.dedication === 'string' ? req.body.dedication.trim().slice(0, 100) : '';
    await pool.query(
      `INSERT INTO impact_contributions
        (user_id, project_key, amount, status, razorpay_order_id, certificate_code, dedication)
       VALUES (?, ?, ?, 'pledged', ?, ?, ?)`,
      [req.user.id, projectKey, amount, order.id, certificateCode, dedication || null]
    );
    return res.status(201).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('[IMPACT_DONATION_CREATE_ORDER]', error);
    const status = error.code === 'RAZORPAY_NOT_CONFIGURED'
      ? 503
      : error.statusCode === 401 || error.status === 401
        ? 401
        : 500;
    return res.status(status).json({
      success: false,
      message: error.code === 'RAZORPAY_NOT_CONFIGURED'
        ? 'Razorpay is not configured on the payment server.'
        : status === 401
          ? 'Razorpay authentication failed. Check the backend payment credentials.'
          : 'Could not create the impact contribution payment.',
    });
  }
});

router.post('/donations/verify-payment', authenticateUser, async (req, res) => {
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body || {};
  const amountPaise = Number(req.body?.amountPaise);
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.trim()) ||
      !Number.isSafeInteger(amountPaise) || amountPaise < 5000 || amountPaise > 50000000) {
    return res.status(400).json({ success: false, message: 'Verified payment details are required.' });
  }

  let connection;
  let transactionOpen = false;
  try {
    const verified = await verifyRazorpayPayment({
      orderId,
      paymentId,
      signature,
      userId: req.user.id,
      expectedAmount: amountPaise,
    });
    const { order, payment } = verified;
    const projectKey = order.notes?.projectKey;
    const validPurposes = new Set(['community_stewardship_token', 'eco_action_sponsorship', 'impact_donation']);
    if (
      !validPurposes.has(order.notes?.purpose) ||
      String(order.notes?.userId) !== String(req.user.id) ||
      String(order.notes?.amountPaise) !== String(amountPaise) ||
      !IMPACT_DONATION_PROJECTS.has(projectKey)
    ) {
      return res.status(400).json({ success: false, message: 'Payment does not match this impact contribution.' });
    }

    await initImpactTables();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionOpen = true;
    const [existingRows] = await connection.query(
      `SELECT ic.*, u.name AS customer_name, u.email AS customer_email
       FROM impact_contributions ic
       JOIN users u ON u.id = ic.user_id
       WHERE ic.razorpay_order_id = ? FOR UPDATE`,
      [order.id]
    );

    let contribution = existingRows[0];
    if (!contribution ||
        String(contribution.user_id) !== String(req.user.id) ||
        contribution.project_key !== projectKey ||
        Math.round(Number(contribution.amount) * 100) !== amountPaise ||
        contribution.payment_id && contribution.payment_id !== payment.id) {
      await connection.rollback();
      transactionOpen = false;
      return res.status(409).json({ success: false, message: 'This payment is not linked to an eligible impact contribution.' });
    }
    await connection.query(
      `UPDATE impact_contributions
       SET payment_id = ?, status = 'collected', collected_at = COALESCE(collected_at, NOW())
       WHERE id = ? AND (payment_id IS NULL OR payment_id = ?)`,
      [payment.id, contribution.id, payment.id]
    );
    contribution.payment_id = payment.id;
    contribution.status = 'collected';
    await connection.commit();
    transactionOpen = false;
    connection.release();
    connection = null;

    const certificateSent = await sendImpactCertificateForContribution(pool, contribution.id);

    return res.json({
      success: true,
      certificateSent,
      certificate: {
        code: contribution.certificate_code,
        name: contribution.customer_name,
        email: contribution.customer_email,
        amount: Number(contribution.amount),
        projectTitle: IMPACT_DONATION_PROJECTS.get(contribution.project_key),
        dedication: contribution.dedication,
        issuedAt: contribution.created_at || new Date().toISOString(),
      },
    });
  } catch (error) {
    if (transactionOpen && connection) await connection.rollback().catch(() => {});
    console.error('[IMPACT_DONATION_VERIFY]', error);
    const status = error.code === 'RAZORPAY_NOT_CONFIGURED'
      ? 503
      : error.statusCode === 401 || error.status === 401
        ? 401
        : error.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: status === 400
        ? error.message || 'Payment verification failed.'
        : status === 401
          ? 'Razorpay authentication failed. Check the backend payment credentials.'
          : status === 503
            ? 'Razorpay is not configured on the payment server.'
            : 'Could not verify and record the impact contribution.',
    });
  } finally {
    connection?.release();
  }
});

router.get('/public', async (req, res) => {
  try {
    await initImpactTables();
    res.json(await getPublicImpact());
  } catch (error) {
    console.error('[IMPACT_PUBLIC]', error);
    res.status(500).json({ message: 'Unable to load the verified impact ledger.' });
  }
});

router.get('/admin/contributions', authenticateAdmin, async (req, res) => {
  try {
    await initImpactTables();
    res.json({ contributions: await getAllContributions() });
  } catch (error) {
    console.error('[IMPACT_CONTRIBUTIONS]', error);
    res.status(500).json({ message: 'Unable to load contributions.' });
  }
});

router.patch('/admin/contributions/:id/collected', authenticateAdmin, async (req, res) => {
  const reference = typeof req.body?.collectionReference === 'string' ? req.body.collectionReference.trim().slice(0, 255) : '';
  if (reference.length < 2) return res.status(400).json({ message: 'A collection receipt or reconciliation reference is required.' });

  let connection;
  try {
    await initImpactTables();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT ic.status, o.status AS order_status, o.payment_mode
       FROM impact_contributions ic JOIN orders o ON o.id = ic.order_id
       WHERE ic.id = ? FOR UPDATE`,
      [req.params.id]
    );
    const contribution = rows[0];
    if (!contribution) {
      await connection.rollback();
      return res.status(404).json({ message: 'Contribution not found.' });
    }
    if (contribution.status !== 'pledged' || contribution.order_status !== 'delivered' || contribution.payment_mode !== 'COD') {
      await connection.rollback();
      return res.status(409).json({ message: 'Only an uncollected contribution on a delivered COD order can be reconciled.' });
    }
    await connection.query(
      `UPDATE impact_contributions SET status = 'collected', collection_reference = ?, collected_at = NOW()
       WHERE id = ? AND status = 'pledged'`,
      [reference, req.params.id]
    );
    await connection.commit();
    res.json({ success: true, message: 'Contribution collection recorded.' });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[IMPACT_COLLECTION]', error);
    res.status(500).json({ message: 'Unable to reconcile the contribution.' });
  } finally {
    connection?.release();
  }
});

router.get('/admin/updates', authenticateAdmin, async (req, res) => {
  try {
    await initImpactTables();
    res.json({ updates: await getAllImpactUpdates() });
  } catch (error) {
    console.error('[IMPACT_UPDATES_ADMIN]', error);
    res.status(500).json({ message: 'Unable to load field updates.' });
  }
});

router.post('/admin/updates', authenticateAdmin, async (req, res) => {
  const { projectKey, title, summary, fieldDate } = req.body || {};
  const photoUrl = safeMediaUrl(req.body?.photoUrl);
  const videoUrl = safeMediaUrl(req.body?.videoUrl);
  if (!PROJECTS.has(projectKey) || typeof title !== 'string' || !title.trim() || typeof summary !== 'string' || !summary.trim()) {
    return res.status(400).json({ message: 'Choose a project and provide a report title and field summary.' });
  }
  if (!photoUrl && !videoUrl) return res.status(400).json({ message: 'Add at least one secure photo or video link as evidence.' });
  if (req.body?.verified !== true) return res.status(400).json({ message: 'Confirm that this report documents completed, on-ground work.' });

  try {
    await initImpactTables();
    const [result] = await pool.query(
      `INSERT INTO impact_updates (project_key, title, summary, field_date, photo_url, video_url, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [projectKey, title.trim().slice(0, 180), summary.trim(), fieldDate || null, photoUrl, videoUrl, req.admin.id]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    console.error('[IMPACT_UPDATE_CREATE]', error);
    res.status(500).json({ message: 'Unable to publish the field report.' });
  }
});

module.exports = router;