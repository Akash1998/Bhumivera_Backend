const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { createReturn, getReturnsByUser, getReturnById, getAllReturns, updateReturnStatus, getReturnsByOrderAndUser } = require('../models/returnModel');
const { getOrderById } = require('../models/orderModel');

const ALLOWED_REFUND_TYPES = Object.freeze(['refund', 'replacement', 'wallet']);

const generateRMA = () => `RMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

router.get('/', authenticateUser, async (req, res) => {
  try {
    const returns = await getReturnsByUser(req.user.id);
    res.json(returns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get returns' });
  }
});

router.get('/my', authenticateUser, async (req, res) => {
  try {
    const returns = await getReturnsByUser(req.user.id);
    res.json(returns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get returns' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  try {
    const { order_id, reason, description, refund_type, items } = req.body;

    if (!order_id) {
      return res.status(400).json({
        code: 'ORDER_NOT_FOUND',
        message: 'order_id is required to submit a return.',
        order_id
      });
    }

    const order = await getOrderById(order_id);
    if (!order) {
      return res.status(400).json({
        code: 'ORDER_NOT_FOUND',
        message: 'The referenced order does not exist.',
        order_id
      });
    }

    if (order.user_id !== req.user.id) {
      return res.status(403).json({
        code: 'ORDER_NOT_YOURS',
        message: 'You cannot request a return for another user\'s order.',
        order_id
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        code: 'ITEMS_REQUIRED',
        message: 'At least one item must be specified to return.'
      });
    }

    if (refund_type && !ALLOWED_REFUND_TYPES.includes(refund_type)) {
      return res.status(400).json({
        code: 'INVALID_REFUND_TYPE',
        message: `refund_type must be one of: ${ALLOWED_REFUND_TYPES.join(', ')}.`,
        allowed: ALLOWED_REFUND_TYPES
      });
    }

    const existing = await getReturnsByOrderAndUser(order_id, req.user.id);
    if (existing) {
      return res.status(409).json({
        code: 'ALREADY_RETURNED',
        message: 'A return request for this order has already been submitted.',
        order_id,
        return_id: existing.id
      });
    }

    const rma_number = generateRMA();

    const id = await createReturn({
      order_id,
      user_id: req.user.id,
      reason: reason || null,
      description: description || null,
      refund_type: refund_type || 'refund',
      items,
      rma_number
    });

    res.status(201).json({
      id,
      rma_number,
      message: 'Return request submitted'
    });
  } catch (err) {
    console.error('[RETURNS CREATE DB ERROR]:', err);
    res.status(500).json({
      code: 'RETURN_CREATE_FAILED',
      message: 'Failed to create return request due to a system error.',
      error: err.message
    });
  }
});

// GET /api/returns/:id - user/admin: get specific return
router.get('/:id', authenticateUser, async (req, res) => {
  try {
    const ret = await getReturnById(req.params.id);
    if (!ret) return res.status(404).json({ message: 'Return not found' });
    if (ret.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Unauthorized' });
    res.json(ret);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get return' });
  }
});

// GET /api/returns/admin/all - admin: all returns
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const returns = await getAllReturns(req.query.status || null);
    res.json(returns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get returns' });
  }
});

// PUT /api/returns/admin/:id - admin: update return status
router.put('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status, admin_notes, refund_amount } = req.body;
    if (!status) return res.status(400).json({ message: 'status is required' });
    
    await updateReturnStatus(req.params.id, status, admin_notes, refund_amount);
    
    // TODO (Sprint 4): Trigger Mailjet email here alerting user of status change
    
    res.json({ message: 'Return status updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update return' });
  }
});

module.exports = router;
