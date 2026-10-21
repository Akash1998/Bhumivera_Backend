// backend/routes/wishlistRoutes
const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authMiddleware');
const { addToWishlist, removeFromWishlist, getWishlistByUser, isInWishlist } = require('../models/wishlistModel');

// GET /api/wishlist - get user wishlist
router.get('/', authenticateUser, async (req, res) => {
  try {
    const items = await getWishlistByUser(req.user.id);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get wishlist' });
  }
});

// POST /api/wishlist - add to wishlist via JSON body { productId } (frontend api.js shape)
router.post('/', authenticateUser, async (req, res) => {
  try {
    const rawId = req.body?.productId ?? req.params.productId;
    const productId = parseInt(rawId, 10);
    if (!productId || isNaN(productId)) return res.status(400).json({ message: 'productId is required' });
    await addToWishlist(req.user.id, productId);
    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add to wishlist' });
  }
});

// POST /api/wishlist/:productId - add to wishlist via URL param (legacy)
router.post('/:productId', authenticateUser, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    await addToWishlist(req.user.id, productId);
    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add to wishlist' });
  }
});

// DELETE /api/wishlist/:productId - remove from wishlist
router.delete('/:productId', authenticateUser, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    await removeFromWishlist(req.user.id, productId);
    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to remove from wishlist' });
  }
});

// GET /api/wishlist/check/:productId - check if in wishlist
router.get('/check/:productId', authenticateUser, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const inWishlist = await isInWishlist(req.user.id, productId);
    res.json({ inWishlist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to check wishlist' });
  }
});

module.exports = router;
