// Cart: add, update, remove, clear, get - all require user aut
const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authMiddleware');
const { 
  getCartByUser, 
  upsertCartItem, 
  removeCartItem, 
  clearCart, 
  getCartTotal 
} = require('../models/cartModel');

// GET /api/cart - get current user's 
router.get('/', authenticateUser, async (req, res) => {
  try { 
    const { items, total } = await getCartTotal(req.user.id);
    return res.json({ items: items || [], total: total || 0 });
  } catch (err) {
    console.error("GET /api/cart Error:", err);
    return res.status(500).json({ message: 'Failed to load cart' });
  }
});

// POST /api/cart - add/update item { productId, quantity }
router.post('/', authenticateUser, async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    
    // SECURITY FIX: Prevent string/decimal quantity injections
    const parsedQuantity = parseInt(quantity, 10);
    
    if (!productId || isNaN(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).json({ message: 'productId and a valid quantity (>=1) are required' });
    }
    
    const items = await upsertCartItem(req.user.id, productId, parsedQuantity);
    
    if (!Array.isArray(items)) {
        throw new Error('Database returned invalid data');
    }

    const total = items.reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    return res.json({ items, total: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error("POST /api/cart Error:", err);
    const status = err.status || 500;
    return res.status(status).json({ 
        message: err.message || 'Failed to update cart',
        error: process.env.access_ENV === 'development' ? err : undefined
    });
  }
});

// DELETE /api/cart/:productId - remove one item
router.delete('/:productId', authenticateUser, async (req, res) => {
  try {
    const items = await removeCartItem(req.user.id, req.params.productId);
    const total = (items || []).reduce((s, i) => s + (parseFloat(i.subtotal) || 0), 0);
    return res.json({ items: items || [], total: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error("DELETE /api/cart/:id Error:", err);
    return res.status(500).json({ message: 'Failed to remove item' });
  }
});

// DELETE /api/cart - clear entire cart
router.delete('/', authenticateUser, async (req, res) => {
  try {
    await clearCart(req.user.id);
    return res.json({ items: [], total: 0 });
  } catch (err) {
    console.error("DELETE /api/cart Error:", err);
    return res.status(500).json({ message: 'Failed to clear cart' });
  }
});

module.exports = router;
