const express = require('express');
const router = express.Router();
const crypto = require('crypto'); // Added for secure RMA generation
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { createReturn, getReturnsByUser, getReturnById, getAllReturns, updateReturnStatus } = require('../models/returnModel');

// Utility to generate a unique RMA (Return Merchandise Authorization) number
const generateRMA = () => `RMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// GET /api/returns - user: get my returns
router.get('/', authenticateUser, async (req, res) => {
  try {
    const returns = await getReturnsByUser(req.user.id);
    res.json(returns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get returns' });
  }
});

// GET /api/returns/my - alias for frontend returns.getMyReturns()
router.get('/my', authenticateUser, async (req, res) => {
  try {
    const returns = await getReturnsByUser(req.user.id);
    res.json(returns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get returns' });
  }
});

// POST /api/returns - user: create return request
router.post('/', authenticateUser, async (req, res) => {
  try {
    const { order_id, reason, description, refund_type, items } = req.body;
    if (!order_id || !reason) return res.status(400).json({ message: 'order_id and reason are required' });

    // Generate the automated tracking number
    const rma_number = generateRMA();

    // Passing rma_number down to your model
    const id = await createReturn({ 
      order_id, 
      user_id: req.user.id, 
      reason, 
      description, 
      refund_type, 
      items,
      rma_number 
    });

    // Return the RMA number to the frontend so the user sees it immediately
    res.status(201).json({ 
      message: 'Return request submitted', 
      id, 
      rma_number 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create return request' });
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
