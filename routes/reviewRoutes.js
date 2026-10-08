// backend/routes/reviewRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { generateUploadUrl, deleteReviewImage } = require('../config/s3Upload');
const { createReview, getReviewsByProduct, getProductRatingSummary, getAllReviews, approveReview, rejectReview, getUserReviews, updateReviewAsAdmin } = require('../models/reviewModel');

const MAX_REVIEW_IMAGES = 5;
const MAX_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
const REVIEW_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const validReviewImages = images =>
  Array.isArray(images) &&
  images.length <= MAX_REVIEW_IMAGES &&
  images.every(image => typeof image === 'string' && /^reviews\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/i.test(image));
const cleanupReviewImages = async images => {
  const failures = [];
  for (const image of images) {
    try {
      await deleteReviewImage(image);
    } catch (error) {
      console.error('[REVIEW_IMAGE_CLEANUP]', image, error.message);
      failures.push(image);
    }
  }
  return failures;
};

const createUploadLink = async (req, res, isAdmin) => {
  const { filename, fileType, size, order_id, product_id } = req.body || {};
  if (
    typeof filename !== 'string' || !filename.trim() || filename.length > 180 ||
    !REVIEW_IMAGE_TYPES.has(fileType) ||
    !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > MAX_REVIEW_IMAGE_BYTES
  ) {
    return res.status(400).json({ message: 'Choose a JPEG, PNG, or WebP image up to 8 MB.' });
  }
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[fileType];
  const safeFilename = /\.(jpe?g|png|webp)$/i.test(filename.trim())
    ? filename.trim()
    : `${filename.trim()}.${extension}`;
  if (!isAdmin) {
    const orderId = Number(order_id);
    const productId = Number(product_id);
    if (!Number.isSafeInteger(orderId) || !Number.isSafeInteger(productId)) {
      return res.status(400).json({ message: 'A delivered order and product are required to upload review photos.' });
    }
    const [[purchase]] = await pool.query(
      `SELECT o.id FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ? AND o.user_id = ? AND oi.product_id = ?
         AND LOWER(o.status) IN ('delivered', 'completed')
       LIMIT 1`,
      [orderId, req.user.id, productId]
    );
    if (!purchase) {
      return res.status(403).json({ message: 'Review photos can only be added to a product in your delivered order.' });
    }
  }
  const { uploadUrl, key } = await generateUploadUrl(
    safeFilename,
    fileType,
    isAdmin ? `reviews/admin/${req.user.id}` : `reviews/${req.user.id}`,
    Number(size)
  );
  return res.json({ uploadUrl, key });
};

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
      'SELECT id, user_id, product_id, images FROM reviews WHERE id = ?',
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
router.delete('/:id', authenticateUser, async (req, res, next) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT id, user_id, product_id, images FROM reviews WHERE id = ?',
      [req.params.id]
    );
    if (!existing) return res.status(404).json({ message: 'Review not found' });
    if (req.user.role === 'admin' || req.user.role === 'superadmin') return next();
    if (existing.user_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    const syncProductStats = require('../models/reviewModel').syncProductStats;
    if (syncProductStats && existing.product_id) {
      try { await syncProductStats(existing.product_id); } catch (_) {}
    }
    const imageKeys = Array.isArray(existing.images) ? existing.images : (() => {
      try { return JSON.parse(existing.images || '[]'); } catch { return []; }
    })();
    const orphanedImages = await cleanupReviewImages(imageKeys.filter(key => typeof key === 'string' && key.startsWith('reviews/')));
    res.json({ message: 'Review deleted', ...(orphanedImages.length ? { warning: 'Review was deleted, but some photos could not be removed from storage.' } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete review' });
  }
});

// POST /api/reviews - user: submit review
router.post('/', authenticateUser, async (req, res) => {
  try {
    const { product_id, order_id, rating, title, body, comment, images = [] } = req.body;
    const reviewText = body || comment;
    const productId = Number(product_id);
    const orderId = Number(order_id);
    const numericRating = Number(rating);

    if (!Number.isSafeInteger(productId) || productId < 1 ||
        !Number.isSafeInteger(orderId) || orderId < 1 ||
        !Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: 'A valid product, delivered order, and 1–5 star rating are required.' });
    }
    if (typeof title === 'string' && title.length > 255) {
      return res.status(400).json({ message: 'Review title cannot exceed 255 characters.' });
    }
    if (reviewText !== undefined && reviewText !== null &&
        (typeof reviewText !== 'string' || reviewText.length > 5000)) {
      return res.status(400).json({ message: 'Review text cannot exceed 5000 characters.' });
    }
    if (!validReviewImages(images) || images.some(image => !image.startsWith(`reviews/${req.user.id}/`))) {
      return res.status(400).json({ message: 'Reviews may include up to 5 valid uploaded images.' });
    }

    const [[purchase]] = await pool.query(
      `SELECT o.id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ? AND o.user_id = ? AND oi.product_id = ?
         AND LOWER(o.status) IN ('delivered', 'completed')
       LIMIT 1`,
      [orderId, req.user.id, productId]
    );
    if (!purchase) {
      return res.status(403).json({ message: 'Reviews are available only for products in your delivered orders.' });
    }
    
    const id = await createReview({
      product_id: productId,
      user_id: req.user.id,
      order_id: orderId,
      rating: numericRating,
      title: typeof title === 'string' ? title.trim() || null : null,
      body: typeof reviewText === 'string' ? reviewText.trim() || null : null,
      images
    });
    res.status(201).json({ message: 'Review submitted and pending approval', id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'You already reviewed this product for this order' });
    console.error(err);
    res.status(500).json({ message: 'Failed to submit review' });
  }
});

router.post('/upload-url', authenticateUser, async (req, res) => {
  try {
    return await createUploadLink(req, res, false);
  } catch (error) {
    console.error('[REVIEW_IMAGE_UPLOAD_URL]', error);
    return res.status(500).json({ message: 'Could not prepare the review photo upload.' });
  }
});

router.post('/admin/upload-url', authenticateAdmin, async (req, res) => {
  try {
    return await createUploadLink(req, res, true);
  } catch (error) {
    console.error('[ADMIN_REVIEW_IMAGE_UPLOAD_URL]', error);
    return res.status(500).json({ message: 'Could not prepare the review photo upload.' });
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

router.put('/admin/:id', authenticateAdmin, async (req, res) => {
  const rating = req.body?.rating === undefined ? undefined : Number(req.body.rating);
  const { title, body, images, is_approved: isApproved } = req.body || {};
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
  }
  if (title !== undefined && (typeof title !== 'string' || title.length > 255)) {
    return res.status(400).json({ message: 'Review title cannot exceed 255 characters.' });
  }
  if (body !== undefined && (typeof body !== 'string' || body.length > 5000)) {
    return res.status(400).json({ message: 'Review text cannot exceed 5000 characters.' });
  }
  if (images !== undefined && !validReviewImages(images)) {
    return res.status(400).json({ message: 'Reviews may include up to 5 valid uploaded images.' });
  }
  if (isApproved !== undefined && ![0, 1, false, true].includes(isApproved)) {
    return res.status(400).json({ message: 'Review visibility must be approved or pending.' });
  }

  try {
    const result = await updateReviewAsAdmin(req.params.id, {
      ...(rating !== undefined ? { rating } : {}),
      ...(title !== undefined ? { title: title.trim() || null } : {}),
      ...(body !== undefined ? { body: body.trim() || null } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(isApproved !== undefined ? { is_approved: isApproved ? 1 : 0 } : {})
    });
    if (!result) return res.status(404).json({ message: 'Review not found.' });
    const orphanedImages = await cleanupReviewImages(result.removedImages);
    return res.json({
      message: 'Review updated successfully.',
      ...(orphanedImages.length ? { warning: 'Changes were saved, but some removed photos could not be deleted from storage.' } : {})
    });
  } catch (error) {
    console.error('[ADMIN_REVIEW_UPDATE]', error);
    return res.status(500).json({ message: 'Failed to update review.' });
  }
});

// PUT /api/reviews/:id/approve - admin: approve review
router.put('/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const approved = await approveReview(req.params.id);
    if (!approved) return res.status(404).json({ message: 'Review not found.' });
    res.json({ message: 'Review approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to approve review' });
  }
});

// DELETE /api/reviews/:id - admin: reject/delete review
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const images = await rejectReview(req.params.id);
    if (!images) return res.status(404).json({ message: 'Review not found.' });
    const orphanedImages = await cleanupReviewImages(images);
    res.json({
      message: 'Review deleted',
      ...(orphanedImages.length ? { warning: 'Review was deleted, but some photos could not be removed from storage.' } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete review' });
  }
});

module.exports = router;
