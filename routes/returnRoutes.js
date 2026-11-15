const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { generateUploadUrl } = require('../config/s3Upload');
const {
  createReturn,
  getReturnsByUser,
  getReturnById,
  getAllReturns,
  updateReturnStatus,
} = require('../models/returnModel');
const { getOrderById } = require('../models/orderModel');
const { getSetting } = require('../models/settingsModel');
const { getRazorpayClient } = require('../services/razorpayService');
const {
  createReturnRefund,
  reconcileReturnRefund,
  toPaise,
} = require('../services/returnRefundService');

const MAX_RETURN_IMAGES = 5;
const MAX_RETURN_IMAGE_BYTES = 8 * 1024 * 1024;
const RETURN_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ADMIN_TRANSITIONS = Object.freeze({
  pending_admin_review: ['return_in_progress', 'waiting_customer_service_review', 'rejected'],
  waiting_customer_service_review: ['return_in_progress', 'rejected'],
  return_in_progress: ['received'],
  received: ['replacement_sent'],
  refund_pending: [],
  rejected: [],
  refunded: [],
  replacement_sent: [],
});

const returnPolicyDays = async () => {
  const configuredDays = Number.parseInt(await getSetting('return_policy_days'), 10);
  return Number.isFinite(configuredDays) && configuredDays > 0 ? Math.min(configuredDays, 90) : 7;
};

const getWindow = (deliveredAt, days) => {
  if (!deliveredAt) return null;
  const deliveredTime = new Date(deliveredAt).getTime();
  if (!Number.isFinite(deliveredTime)) return null;
  return {
    expiresAt: new Date(deliveredTime + days * 24 * 60 * 60 * 1000),
  };
};

const isOwnedDeliveredOrder = async (orderId, userId) => {
  const order = await getOrderById(orderId);
  if (!order) return { error: { status: 404, message: 'Order not found.' } };
  if (Number(order.user_id) !== Number(userId)) return { error: { status: 403, message: 'You cannot request a return for another customer’s order.' } };
  if (String(order.status).toLowerCase() !== 'delivered') return { error: { status: 400, message: 'Only delivered orders can be submitted for return.' } };

  const days = await returnPolicyDays();
  const window = getWindow(order.delivered_at, days);
  if (!window) return { error: { status: 400, message: 'This order has no verified delivery timestamp. Contact customer support to review it.' } };
  if (Date.now() > window.expiresAt.getTime()) {
    return {
      error: {
        status: 403,
        code: 'STANDARD_RETURN_WINDOW_CLOSED',
        message: 'The standard online request period has ended. Contact customer support if you believe a warranty or statutory remedy applies.',
      },
    };
  }
  return { order, window, days };
};

router.get('/', authenticateUser, async (req, res) => {
  try {
    if (['admin', 'superadmin'].includes(req.user.role)) {
      return res.json(await getAllReturns(req.query.status || null));
    }
    return res.json(await getReturnsByUser(req.user.id));
  } catch (error) {
    console.error('[RETURNS_LIST]', error);
    return res.status(500).json({ message: 'Failed to load returns.' });
  }
});

router.get('/my', authenticateUser, async (req, res) => {
  try {
    return res.json(await getReturnsByUser(req.user.id));
  } catch (error) {
    console.error('[RETURNS_MY_LIST]', error);
    return res.status(500).json({ message: 'Failed to load your return requests.' });
  }
});

router.get('/eligibility', authenticateUser, async (req, res) => {
  try {
    const days = await returnPolicyDays();
    const now = Date.now();
    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.delivered_at, o.total,
        EXISTS(SELECT 1 FROM returns r WHERE r.order_id = o.id AND r.user_id = o.user_id
          AND r.status NOT IN ('rejected', 'cancelled')) AS has_return_request
       FROM orders o WHERE o.user_id = ? AND LOWER(o.status) = 'delivered'
       ORDER BY o.delivered_at DESC, o.id DESC`,
      [req.user.id]
    );
    return res.json(orders.map(order => {
      const window = getWindow(order.delivered_at, days);
      const alreadyRequested = Number(order.has_return_request) > 0;
      const withinStandardWindow = Boolean(window && now <= window.expiresAt.getTime());
      return {
        ...order,
        return_window_days: days,
        return_available_at: null,
        return_expires_at: window?.expiresAt || null,
        can_request_return: !alreadyRequested && withinStandardWindow,
        non_returnable_reason: alreadyRequested
          ? 'A request for this order is already under review.'
          : !withinStandardWindow
            ? 'The standard online request period has ended. Contact customer support if you believe a warranty or statutory remedy applies.'
            : null,
      };
    }));
  } catch (error) {
    console.error('[RETURNS_ELIGIBILITY]', error);
    return res.status(500).json({ message: 'Could not check return eligibility.' });
  }
});

router.post('/upload-url', authenticateUser, async (req, res) => {
  try {
    const { filename, fileType, size, order_id } = req.body || {};
    if (
      typeof filename !== 'string' || !filename.trim() || filename.length > 180 ||
      !RETURN_IMAGE_TYPES.has(fileType) ||
      !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > MAX_RETURN_IMAGE_BYTES
    ) {
      return res.status(400).json({ message: 'Choose a JPEG, PNG, or WebP evidence photo up to 8 MB.' });
    }
    const access = await isOwnedDeliveredOrder(Number(order_id), req.user.id);
    if (access.error) return res.status(access.error.status).json(access.error);
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[fileType];
    const safeFilename = /\.(jpe?g|png|webp)$/i.test(filename.trim()) ? filename.trim() : `${filename.trim()}.${extension}`;
    const upload = await generateUploadUrl(safeFilename, fileType, `returns/${req.user.id}`, Number(size));
    return res.json(upload);
  } catch (error) {
    console.error('[RETURN_UPLOAD_URL]', error);
    return res.status(500).json({ message: 'Could not prepare the return evidence upload.' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  const orderId = Number(req.body?.order_id);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const refundType = req.body?.refund_type === 'replacement' ? 'replacement' : 'refund';
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !reason || reason.length > 255 ||
      !description || description.length > 10000) {
    return res.status(400).json({
      code: 'INVALID_RETURN_REQUEST',
      message: 'Provide a valid order, issue reason, and description (up to 10,000 characters).',
    });
  }
  try {
    const access = await isOwnedDeliveredOrder(orderId, req.user.id);
    if (access.error) return res.status(access.error.status).json(access.error);
    const returnId = await createReturn({
      order_id: orderId,
      user_id: req.user.id,
      reason,
      description,
      refund_type: refundType,
      refund_method: 'review',
      items: [],
      image_urls: [],
    });
    return res.status(201).json({
      success: true,
      message: 'Your request has been received for review. Submission does not guarantee a refund or replacement; any remedy will be assessed under the order terms and applicable law.',
      data: { id: returnId, status: 'pending_admin_review' },
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        code: error.code || 'RETURN_REQUEST_REJECTED',
        message: error.message,
        ...(error.returnId ? { return_id: error.returnId } : {}),
      });
    }
    console.error('[RETURN_REQUEST_CREATE]', error);
    return res.status(500).json({ code: 'RETURN_REQUEST_FAILED', message: 'Could not submit the request. Please contact customer support.' });
  }
});

router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    return res.json(await getAllReturns(req.query.status || null));
  } catch (error) {
    console.error('[RETURNS_ADMIN_LIST]', error);
    return res.status(500).json({ message: 'Failed to load return requests.' });
  }
});

router.put('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status, admin_notes, refund_amount, condition_grade } = req.body || {};
    if (['refunded', 'refund_pending'].includes(status)) {
      return res.status(409).json({
        code: 'REFUND_PROVIDER_REQUIRED',
        message: 'Use the provider-backed refund action; return status cannot be changed manually.',
      });
    }
    const existing = await getReturnById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Return request not found.' });
    if (!ADMIN_TRANSITIONS[existing.status]?.includes(status)) {
      return res.status(409).json({ message: `Cannot move a ${existing.status.replace(/_/g, ' ')} request to ${String(status || '').replace(/_/g, ' ')}.` });
    }
    if (['waiting_customer_service_review', 'rejected'].includes(status) && !String(admin_notes || '').trim()) {
      return res.status(400).json({ message: 'Add an internal note explaining this review decision.' });
    }
    const amount = refund_amount === '' || refund_amount === null || refund_amount === undefined ? null : Number(refund_amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ message: 'Refund amount must be a non-negative number.' });
    }
    const updated = await updateReturnStatus(
      req.params.id,
      status,
      String(admin_notes || '').trim() || null,
      amount,
      condition_grade || null
    );
    if (!updated) return res.status(404).json({ message: 'Return request not found.' });
    return res.json({ message: 'Return request updated.', status });
  } catch (error) {
    console.error('[RETURNS_ADMIN_UPDATE]', error);
    return res.status(500).json({ message: 'Failed to update the return request.' });
  }
});

router.post('/admin/:id/refund', authenticateAdmin, async (req, res) => {
  const returnId = Number(req.params.id);
  const amountPaise = toPaise(req.body?.refund_amount);
  if (!Number.isSafeInteger(returnId) || returnId < 1) {
    return res.status(400).json({ code: 'INVALID_RETURN_ID', message: 'Choose a valid return request.' });
  }
  if (amountPaise === null || amountPaise < 100) {
    return res.status(400).json({ code: 'INVALID_REFUND_AMOUNT', message: 'Enter a refund amount of at least ₹1.00 with up to two decimal places.' });
  }
  const adminNotes = typeof req.body?.admin_notes === 'string' ? req.body.admin_notes.trim() : '';
  if (adminNotes.length > 10000) {
    return res.status(400).json({ code: 'INVALID_ADMIN_NOTES', message: 'Admin notes cannot exceed 10000 characters.' });
  }
  try {
    const result = await createReturnRefund({
      pool,
      razorpay: getRazorpayClient(),
      returnId,
      amountPaise,
      admin: req.admin,
      adminNotes: adminNotes || null,
    });
    if (result.status === 'failed') {
      return res.status(502).json({
        code: 'REFUND_PROVIDER_FAILED',
        message: 'Razorpay reported that the refund failed. The return remains available for review.',
        data: result,
      });
    }
    return res.status(result.status === 'pending' ? 202 : 200).json({
      success: true,
      message: result.status === 'processed'
        ? 'Razorpay processed the refund.'
        : 'Razorpay accepted the refund; processing confirmation is pending.',
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        ...(error.remainingPaise !== undefined ? { remainingPaise: error.remainingPaise } : {}),
        ...(error.receipt ? { receipt: error.receipt } : {}),
      });
    }
    console.error('[RETURN_REFUND_CREATE]', error);
    return res.status(500).json({ code: 'REFUND_PROCESSING_FAILED', message: 'The refund result could not be saved. Check the refund receipt before retrying.' });
  }
});

router.post('/admin/:id/refund/reconcile', authenticateAdmin, async (req, res) => {
  const returnId = Number(req.params.id);
  if (!Number.isSafeInteger(returnId) || returnId < 1) {
    return res.status(400).json({ code: 'INVALID_RETURN_ID', message: 'Choose a valid return request.' });
  }
  try {
    const result = await reconcileReturnRefund({
      pool,
      razorpay: getRazorpayClient(),
      returnId,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        ...(error.receipt ? { receipt: error.receipt } : {}),
      });
    }
    console.error('[RETURN_REFUND_RECONCILE]', error);
    return res.status(500).json({ code: 'REFUND_RECONCILIATION_FAILED', message: 'Could not reconcile the refund with Razorpay.' });
  }
});

router.get('/:id', authenticateUser, async (req, res) => {
  try {
    const request = await getReturnById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Return request not found.' });
    if (Number(request.user_id) !== Number(req.user.id) && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Unauthorized.' });
    }
    return res.json(request);
  } catch (error) {
    console.error('[RETURNS_GET]', error);
    return res.status(500).json({ message: 'Failed to load the return request.' });
  }
});

module.exports = router;
