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

const REQUEST_REVIEW_DELAY_MS = 30 * 60 * 1000;
const MAX_RETURN_IMAGES = 5;
const MAX_RETURN_IMAGE_BYTES = 8 * 1024 * 1024;
const RETURN_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ADMIN_TRANSITIONS = Object.freeze({
  pending_admin_review: ['return_in_progress', 'waiting_customer_service_review', 'rejected'],
  waiting_customer_service_review: ['return_in_progress', 'rejected'],
  return_in_progress: ['received'],
  received: ['refunded', 'replacement_sent'],
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
    availableAt: new Date(deliveredTime + REQUEST_REVIEW_DELAY_MS),
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
  const now = Date.now();
  if (now < window.availableAt.getTime()) {
    return { error: { status: 403, code: 'RETURN_WINDOW_NOT_OPEN', message: 'The return option will be available 30 minutes after delivery.', available_at: window.availableAt } };
  }
  if (now > window.expiresAt.getTime()) {
    return { error: { status: 403, code: 'RETURN_WINDOW_CLOSED', message: 'The configured return window for this order has ended.' } };
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
      const now = Date.now();
      return {
        ...order,
        return_window_days: days,
        return_available_at: window?.availableAt || null,
        return_expires_at: window?.expiresAt || null,
        can_request_return: Boolean(window && !Number(order.has_return_request) &&
          now >= window.availableAt.getTime() && now <= window.expiresAt.getTime()),
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
  try {
    const { order_id, reason, description, notes, refund_type, refund_method, items, image_urls } = req.body || {};
    const orderId = Number(order_id);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({ code: 'ORDER_NOT_FOUND', message: 'Choose a valid delivered order.' });
    }
    const access = await isOwnedDeliveredOrder(orderId, req.user.id);
    if (access.error) return res.status(access.error.status).json(access.error);
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
      return res.status(400).json({ code: 'RETURN_REASON_REQUIRED', message: 'Select a return reason.' });
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
      return res.status(400).json({ code: 'ITEMS_REQUIRED', message: 'Select at least one item from the delivered order.' });
    }
    if (!Array.isArray(image_urls || []) || (image_urls || []).length > MAX_RETURN_IMAGES ||
      (image_urls || []).some(key => typeof key !== 'string' || !new RegExp(`^returns/${req.user.id}/[a-zA-Z0-9/_-]+\\.(jpg|jpeg|png|webp)$`, 'i').test(key))) {
      return res.status(400).json({ code: 'INVALID_RETURN_IMAGES', message: 'Return requests may include up to five evidence photos uploaded for this account.' });
    }
    if (refund_method && !['wallet', 'original', 'replacement'].includes(refund_method)) {
      return res.status(400).json({ code: 'INVALID_REFUND_METHOD', message: 'Choose a supported refund or replacement option.' });
    }

    const [purchasedItems] = await pool.query(
      'SELECT id, product_id, name, sku, price, quantity, image FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const purchaseById = new Map(purchasedItems.map(item => [String(item.id), item]));
    const seen = new Set();
    const selectedItems = [];
    for (const requested of items) {
      const lineId = String(requested?.order_item_id ?? requested?.id ?? '');
      const purchased = purchaseById.get(lineId);
      const quantity = Number(requested?.quantity ?? 1);
      if (!purchased || seen.has(lineId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > purchased.quantity) {
        return res.status(400).json({ code: 'INVALID_RETURN_ITEM', message: 'Select valid quantities from the items in this order.' });
      }
      seen.add(lineId);
      selectedItems.push({
        order_item_id: purchased.id,
        product_id: purchased.product_id,
        name: purchased.name,
        sku: purchased.sku,
        price: Number(purchased.price),
        quantity,
        image: purchased.image,
      });
    }

    const id = await createReturn({
      order_id: orderId,
      user_id: req.user.id,
      reason: reason.trim(),
      description: String(description || notes || '').trim().slice(0, 2000),
      refund_type: refund_type || refund_method || 'refund',
      refund_method: refund_method || null,
      items: selectedItems,
      image_urls: image_urls || [],
      rma_number: `RMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    });
    return res.status(201).json({
      id,
      status: 'pending_admin_review',
      message: 'Return request sent to our team for review. Your order is not marked as returned while it is being assessed.',
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ code: error.status === 409 ? 'ALREADY_RETURNED' : 'RETURN_REQUEST_REJECTED', message: error.message, return_id: error.returnId });
    }
    console.error('[RETURNS_CREATE]', error);
    return res.status(500).json({ code: 'RETURN_CREATE_FAILED', message: 'Could not submit the return request. Please try again.' });
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
