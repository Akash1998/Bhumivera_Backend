const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser } = require('../middleware/authMiddleware');
const { attachImages } = require('../models/productModel');
const { recordProductView, getPersonalizedRecommendations } = require('../models/recommendationModel');
const { cleanProductMarketingFields } = require('../utils/productMarketingClaims');

router.post('/view', authenticateUser, async (req, res) => {
  const productId = Number(req.body?.product_id);
  if (!Number.isSafeInteger(productId) || productId < 1) {
    return res.status(400).json({ message: 'A valid product is required.' });
  }

  try {
    if (req.user.role !== 'customer') return res.status(204).end();
    const [[consent]] = await pool.query(
      "SELECT ad_personalization_opt_in, ad_personalization_consent_version FROM users WHERE id = ? AND role = 'customer'",
      [req.user.id]
    );
    if (Number(consent?.ad_personalization_opt_in) !== 1 || consent.ad_personalization_consent_version !== 'product-recommendations-v2') {
      return res.status(204).end();
    }

    const [[product]] = await pool.query(
      "SELECT id FROM products WHERE id = ? AND status = 'active'",
      [productId]
    );
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    await recordProductView(req.user.id, productId);
    return res.status(204).end();
  } catch (error) {
    console.error('[PRODUCT_VIEW_SIGNAL]', error);
    return res.status(500).json({ message: 'Could not record product activity.' });
  }
});

router.get('/for-you', authenticateUser, async (req, res) => {
  const currentProductId = Number(req.query.product_id);
  if (!Number.isSafeInteger(currentProductId) || currentProductId < 1) {
    return res.status(400).json({ message: 'A valid current product is required.' });
  }

  try {
    const [[consent]] = await pool.query(
      "SELECT ad_personalization_opt_in, ad_personalization_consent_version FROM users WHERE id = ? AND role = 'customer'",
      [req.user.id]
    );
    const personalizationEnabled = req.user.role === 'customer' &&
      Number(consent?.ad_personalization_opt_in) === 1 &&
      consent.ad_personalization_consent_version === 'product-recommendations-v2';
    const result = await getPersonalizedRecommendations(req.user.id, currentProductId, 8, personalizationEnabled);
    const products = (await attachImages(result.products)).map(cleanProductMarketingFields);
    return res.json({
      products,
      personalized: result.personalized,
      reason: result.personalized ? 'Based on your opted-in product activity and purchases' : 'Popular with customers'
    });
  } catch (error) {
    console.error('[PRODUCT_RECOMMENDATIONS]', error);
    return res.status(500).json({ message: 'Could not load product recommendations.' });
  }
});

module.exports = router;
