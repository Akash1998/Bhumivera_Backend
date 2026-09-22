// backend/routes/reviewRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { createReview, getReviewsByProduct, getProductRatingSummary, getAllReviews, approveReview, rejectReview, getUserReviews } = require('../models/reviewModel');

// GET /api/reviews/product/:productId - public: approved reviews + rating summary
router.get('/product/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const [reviews, summary] = await Promise.all([
      getReviewsByProduct(productId, true),
      getProductRatingSummary(productId)
    ]);
    res.json({ reviews, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get reviews' });
  }
});

// GET /api/reviews/my - user: my reviews
router.get('/my', authenticateUser, async (req, res) => {
  try {
    const reviews = await getUserReviews(req.user.id);
    res.json(reviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get reviews' });
  }
});

// PUT /api/reviews/:id - owner: update own review
router.put('/:id', authenticateUser, async (req, res) => {
  try {
    const { rating, title, body, comment } = req.body;
    const reviewText = body || comment;

    const [[existing]] = await pool.query(
      'SELECT id, user_id, product_id FROM reviews WHERE id = ?',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ message: 'Review not found' });
    if (existing.user_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const fields = [];
    const values = [];
    if (rating !== undefined) {
      if (rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be between 1 and 5' });
      fields.push('rating = ?'); values.push(rating);
    }
    if (title !== undefined) { fields.push('title = ?'); values.push(title); }
    if (reviewText !== undefined) { fields.push('body = ?'); values.push(reviewText); }

    if (fields.length) {
      values.push(req.params.id);
      await pool.query(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    const syncProductStats = require('../models/reviewModel').syncProductStats;
    if (syncProductStats && existing.product_id) {
      try { await syncProductStats(existing.product_id); } catch (_) {}
    }
    res.json({ message: 'Review updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update review' });
  }
});

// DELETE /api/reviews/:id - owner: delete own review
router.delete('/:id', authenticateUser, async (req, res) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT id, user_id, product_id FROM reviews WHERE id = ?',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ message: 'Review not found' });
    if (existing.user_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    const syncProductStats = require('../models/reviewModel').syncProductStats;
    if (syncProductStats && existing.product_id) {
      try { await syncProductStats(existing.product_id); } catch (_) {}
    }
    res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete review' });
  }
});

// POST /api/reviews - user: submit review
router.post('/', authenticateUser, async (req, res) => {
  try {
    // FIXED: Accept both 'comment' and 'body' to bridge the frontend payload to the DB schema
    const { product_id, order_id, rating, title, body, comment } = req.body;
    const reviewText = body || comment; 

    if (!product_id || !rating) return res.status(400).json({ message: 'product_id and rating are required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    
    const id = await createReview({ product_id, user_id: req.user.id, order_id, rating, title, body: reviewText });
    res.status(201).json({ message: 'Review submitted and pending approval', id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'You already reviewed this product for this order' });
    console.error(err);
    res.status(500).json({ message: 'Failed to submit review' });
  }
});

// GET /api/reviews - admin: all reviews (optional ?approved=0 or 1)
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const approved = req.query.approved !== undefined ? parseInt(req.query.approved) : null;
    const reviews = await getAllReviews(approved);
    res.json(reviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get reviews' });
  }
});

// PUT /api/reviews/:id/approve - admin: approve review
router.put('/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    await approveReview(req.params.id);
    res.json({ message: 'Review approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to approve review' });
  }
});

// DELETE /api/reviews/:id - admin: reject/delete review
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    await rejectReview(req.params.id);
    res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete review' });
  }
});

module.exports = router;
