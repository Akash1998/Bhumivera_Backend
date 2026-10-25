const { reviewLimiter } = require('../middleware/rateLimiter');
const express = require('express');
const router = express.Router();
let pool;
try {
  pool = require('../config/db');
} catch (_) {
  pool = { query: async () => [[]] };
}
const { authenticateUser, authenticateAdmin } = require('../middleware/authMiddleware');
const { generateUploadUrl, deleteReviewImage } = require('../config/s3Upload');
const {
  createReview,
  createReviewAsAdmin,
  getReviewsByProduct,
  getReviewsByComboName,
  getProductRatingSummary,
  getPublicCustomerStories,
  getAllReviews,
  approveReview,
  archiveReview,
  deleteReviewPermanently,
  getUserReviews,
  updateReviewAsAdmin,
  syncProductStats
} = require('../models/reviewModel');

const MAX_REVIEW_IMAGES = 5;
const MAX_REVIEW_VIDEOS = 3;
const MAX_REVIEW_MEDIA_BYTES = 25 * 1024 * 1024;
const REVIEW_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
const { MAISON_REGIMEN_BUNDLES } = require('../data/luxuryCatalog');

const isValidMediaItem = item =>
  typeof item === 'string' &&
  item.length > 0 &&
  item.length <= 8000000 &&
  (
    /^reviews\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|mp4|webm)$/i.test(item) ||
    /^\/(?:images|assets)\/[a-zA-Z0-9/_.\s-]+\.(jpg|jpeg|png|webp|svg|mp4|webm)$/i.test(item) ||
    /^https?:\/\/[^\s]+$/i.test(item) ||
    /^data:(?:image\/(?:jpeg|jpg|png|webp)|video\/(?:mp4|webm));base64,[a-zA-Z0-9+/=]+$/i.test(item)
  );

const validReviewImages = images =>
  Array.isArray(images) &&
  images.length <= MAX_REVIEW_IMAGES &&
  images.every(isValidMediaItem);

const validReviewVideos = videos =>
  Array.isArray(videos) &&
  videos.length <= MAX_REVIEW_VIDEOS &&
  videos.every(isValidMediaItem);

const cleanupReviewImages = async images => {
  const failures = [];
  for (const image of (images || [])) {
    if (typeof image !== 'string' || !image.startsWith('reviews/')) continue;
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
  const { filename, fileType, size } = req.body || {};
  if (
    typeof filename !== 'string' || !filename.trim() || filename.length > 180 ||
    !REVIEW_MEDIA_TYPES.has(fileType) ||
    !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > MAX_REVIEW_MEDIA_BYTES
  ) {
    return res.status(400).json({ message: 'Choose a JPEG, PNG, WebP, MP4, or WebM file up to 25 MB.' });
  }
  const extension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
  }[fileType];
  const safeFilename = /\.(jpe?g|png|webp|mp4|webm)$/i.test(filename.trim())
    ? filename.trim()
    : `${filename.trim()}.${extension}`;

  const { uploadUrl, key } = await generateUploadUrl(
    safeFilename,
    fileType,
    isAdmin ? `reviews/admin/${req.user?.id || 'admin'}` : `reviews/${req.user?.id || 'patron'}`,
    Number(size)
  );
  return res.json({ uploadUrl, key });
};

// GET /api/reviews/product/:productId - public: approved reviews + rating summary
router.get('/product/:productId', async (req, res) => {
  try {
    const param = req.params.productId;
    const productKey = /^\d+$/.test(param) ? parseInt(param, 10) : param;
    const [reviews, summary] = await Promise.all([
      getReviewsByProduct(productKey, true),
      getProductRatingSummary(productKey)
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ reviews, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get reviews' });
  }
});

router.get('/combo/:bundleId', async (req, res) => {
  const bundle = MAISON_REGIMEN_BUNDLES.find(item => item.id === req.params.bundleId);
  if (!bundle) return res.status(404).json({ message: 'Regimen not found.' });
  try {
    const reviews = await getReviewsByComboName(bundle.name);
    const average = reviews.length
      ? Number((reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / reviews.length).toFixed(2))
      : 0;
    res.set('Cache-Control', 'no-store');
    return res.json({ reviews, summary: { total: reviews.length, average } });
  } catch (error) {
    console.error('[COMBO_REVIEWS_LOAD]', error);
    return res.status(500).json({ message: 'Could not load regimen reviews.' });
  }
});

router.get('/public-stories', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ stories: await getPublicCustomerStories() });
  } catch (error) {
    console.error('[PUBLIC_CUSTOMER_STORIES]', error);
    res.status(500).json({ message: 'Could not load customer stories.' });
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
    const { rating, title, body, comment, images, videos } = req.body;
    const reviewText = body || comment;
    const result = await updateReviewAsAdmin(req.params.id, {
      ...(rating !== undefined ? { rating: Number(rating) } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(reviewText !== undefined ? { body: reviewText } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(videos !== undefined ? { videos } : {})
    });
    if (!result) return res.status(404).json({ message: 'Review not found' });
    res.json({ message: 'Review updated', review: result.review });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update review' });
  }
});

// POST /api/reviews - user or storefront: submit review with optional photos & videos
router.post('/', reviewLimiter, async (req, res) => {
  try {
    const {
      product_id,
      order_id,
      rating = 5,
      title = '',
      body,
      comment,
      user_name = 'Verified Patron',
      reviewer_location = 'India',
      category_tag = 'Quick & Everyday Impressions',
      images = [],
      videos = [],
      public_story_consent = true
    } = req.body || {};
    const reviewText = body || comment || '';
    const productId = Number(product_id) || 2;
    const numericRating = Number(rating);

    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: 'A valid 1–5 star rating is required.' });
    }
    if (!validReviewImages(images) || !validReviewVideos(videos)) {
      return res.status(400).json({ message: 'Reviews may include up to 5 photos and 3 videos.' });
    }

    const id = await createReview({
      product_id: productId,
      user_id: req.user?.id || null,
      order_id: order_id ? Number(order_id) : null,
      rating: Math.round(numericRating),
      title: String(title || '').trim(),
      body: String(reviewText || '').trim(),
      user_name: String(user_name || 'Verified Patron').trim(),
      reviewer_location: String(reviewer_location || 'India').trim(),
      category_tag: String(category_tag || 'Quick & Everyday Impressions').trim(),
      images,
      videos,
      public_story_consent: Boolean(public_story_consent)
    });
    res.status(201).json({ message: 'Review submitted and published', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to submit review' });
  }
});

router.post('/upload-url', authenticateUser, async (req, res) => {
  try {
    return await createUploadLink(req, res, false);
  } catch (error) {
    return res.status(200).json({ fallbackDataUrlMode: true });
  }
});

router.post('/admin/upload-url', authenticateAdmin, async (req, res) => {
  try {
    return await createUploadLink(req, res, true);
  } catch (error) {
    return res.status(200).json({ fallbackDataUrlMode: true });
  }
});

// GET /api/reviews - admin: all 1,080+ reviews
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const approved = req.query.approved !== undefined ? parseInt(req.query.approved, 10) : null;
    const reviews = await getAllReviews(approved);
    res.json(reviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to get reviews' });
  }
});

// POST /api/reviews/admin - admin: manually add a new review to database
router.post('/admin', authenticateAdmin, async (req, res) => {
  try {
    const {
      product_id = 2,
      rating = 5,
      title = '',
      body = '',
      comment = '',
      user_name = 'Verified Patron',
      reviewer_name,
      reviewer_location = 'India',
      category_tag = 'Quick & Everyday Impressions',
      is_combo_review = false,
      created_at,
      images = [],
      videos = [],
      is_approved = 1
    } = req.body || {};

    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }
    if (!validReviewImages(images) || !validReviewVideos(videos)) {
      return res.status(400).json({ message: 'Reviews may include up to 5 valid images and 3 videos.' });
    }

    const created = await createReviewAsAdmin({
      product_id: Number(product_id) || 2,
      rating: Math.round(numericRating),
      title: String(title || '').slice(0, 255),
      body: String(body || comment || '').slice(0, 5000),
      user_name: String(user_name || reviewer_name || 'Verified Patron').slice(0, 120),
      reviewer_location: String(reviewer_location || 'India').slice(0, 120),
      category_tag: String(category_tag || 'Quick & Everyday Impressions').slice(0, 120),
      is_combo_review: Boolean(is_combo_review || category_tag === 'Combo Pack Ritual'),
      created_at: created_at || new Date().toISOString(),
      images,
      videos,
      is_approved: is_approved ? 1 : 0
    });
    return res.status(201).json({ message: 'Review added to database successfully.', review: created });
  } catch (error) {
    console.error('[ADMIN_REVIEW_CREATE]', error);
    return res.status(500).json({ message: 'Failed to create review.' });
  }
});

// PUT /api/reviews/admin/:id - admin: manually edit review (date 2020-2029+, rating 1-5, photos, videos, classification, text)
router.put('/admin/:id', authenticateAdmin, async (req, res) => {
  const rating = req.body?.rating === undefined ? undefined : Number(req.body.rating);
  const {
    title,
    body,
    comment,
    user_name,
    reviewer_name,
    reviewer_location,
    category_tag,
    is_combo_review,
    created_at,
    product_id,
    images,
    videos,
    is_approved: isApproved
  } = req.body || {};
  const reviewText = body !== undefined ? body : comment;

  if (rating !== undefined && (!Number.isFinite(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
  }
  if (images !== undefined && !validReviewImages(images)) {
    return res.status(400).json({ message: 'Reviews may include up to 5 valid images.' });
  }
  if (videos !== undefined && !validReviewVideos(videos)) {
    return res.status(400).json({ message: 'Reviews may include up to 3 valid videos.' });
  }

  try {
    const result = await updateReviewAsAdmin(req.params.id, {
      ...(rating !== undefined ? { rating: Math.round(rating) } : {}),
      ...(title !== undefined ? { title: String(title).trim() || null } : {}),
      ...(reviewText !== undefined ? { body: String(reviewText).trim() || null } : {}),
      ...((user_name !== undefined || reviewer_name !== undefined) ? { user_name: String(user_name ?? reviewer_name).trim() } : {}),
      ...(reviewer_location !== undefined ? { reviewer_location: String(reviewer_location).trim() } : {}),
      ...(category_tag !== undefined ? { category_tag: String(category_tag).trim() } : {}),
      ...(is_combo_review !== undefined ? { is_combo_review: Boolean(is_combo_review) } : {}),
      ...(created_at !== undefined ? { created_at: new Date(created_at).toISOString() } : {}),
      ...(product_id !== undefined ? { product_id: Number(product_id) } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(videos !== undefined ? { videos } : {}),
      ...(isApproved !== undefined ? { is_approved: isApproved ? 1 : 0 } : {})
    });
    if (!result) return res.status(404).json({ message: 'Review not found.' });
    const orphanedImages = await cleanupReviewImages(result.removedImages);
    return res.json({
      message: 'Review updated in database successfully.',
      review: result.review || null,
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

// DELETE /api/reviews/admin/:id - admin: delete or archive review
router.delete('/admin/:id', authenticateAdmin, async (req, res) => {
  try {
    const isPermanent = req.query.permanent !== 'false';
    if (isPermanent) {
      await deleteReviewPermanently(req.params.id);
      return res.json({ message: 'Review permanently deleted from database.', deleted: true });
    }
    const archived = await archiveReview(req.params.id);
    if (!archived) return res.status(404).json({ message: 'Review not found.' });
    return res.json({ message: 'Review hidden from customers and retained in the database.', archived: true });
  } catch (err) {
    console.error('[ADMIN_REVIEW_DELETE]', err);
    res.status(500).json({ message: 'Failed to delete review.' });
  }
});

// DELETE /api/reviews/:id - admin: hide or delete review
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const isPermanent = req.query.permanent === 'true' || req.query.hard === 'true';
    if (isPermanent) {
      const deleted = await deleteReviewPermanently(req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Review not found.' });
      return res.json({ message: 'Review permanently deleted from database.', deleted: true });
    }
    const archived = await archiveReview(req.params.id);
    if (!archived) return res.status(404).json({ message: 'Review not found.' });
    return res.json({ message: 'Review hidden from customers and retained in the database.', archived: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete review' });
  }
});

module.exports = router;
