const { orderLimiter } = require('../middleware/rateLimiter');
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
const { invalidatePublicCatalogCache } = require("../middleware/redisResponseCache");
const {
  syncWebsiteProductsToInventoryMeta,
  calculateEstimatedDeliveryDate,
  recordStockMovement,
} = require("../models/inventorySoftwareModel");
const { sendOrderStatusEmail } = require("../utils/mail");

const { 
  createOrder, 
  getDeliveredOrderCount,
  getOrdersByUser, 
  getOrderById, 
  trackOrderByCustomer,
  getAllOrders,
  updateOrderStatus
} = require("../models/orderModel");
const {
  COD_REQUIRED_DELIVERED_ORDERS,
  calculateTieredReferralWalletRedemption,
} = require('../services/orderPaymentPolicy');
const { getCartTotal, clearCart } = require("../models/cartModel");
const { getSetting, getSettingsByGroup } = require('../models/settingsModel');
const { listCartRules } = require('../models/cartRulesModel');
const { evaluateCartRules } = require('../utils/cartRulesEngine');
const { getUserLoyaltyTier } = require('../models/loyaltyTierModel');
const { getLoyaltyConfig } = require('../models/loyaltyTierModel');
const { calculateTierDiscount, calculateLoyaltyRedemption } = require('../services/loyaltyPolicy');
const { getRazorpayClient } = require('../services/razorpayService');
const { MAX_RECONCILIATION_ORDERS, reconcileOrderPayments } = require('../services/paymentReconciliationService');
const { reconcileReferralRewards, getReferralConfig } = require('../models/referralModel');
const { calculateShippingCost } = require('../services/shippingPolicy');
const { createNotification } = require('../models/notificationModel');
const { validateCoupon } = require('../models/couponModel');
const {
  getProgramConfig,
  getPartnerByCode,
  syncCommissionOrderStatus,
} = require('../models/affiliatePartnerModel');
const { calculateAffiliateProfit, roundCurrency } = require('../services/affiliateProfitPolicy');

// [FIX]: Correctly destructure AddressModel from the exported object
const { AddressModel } = require("../models/addressModel");
const { verifyRazorpayPayment } = require('../services/razorpayService');
const TERMS_VERSION = '2026-10-13';

router.get("/all", authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status || null;
    const search = req.query.search || null;
    const result = await getAllOrders({ page, limit, status, search });
    return res.json(result);
  } catch (err) {
    console.error("Admin Fetch Orders Error:", err);
    return res.status(500).json({ message: "Failed to load global orders ledger" });
  }
});

router.get('/admin/reconciliation/payments', authenticateAdmin, async (req, res) => {
  const rawOrderIds = req.query.order_ids;
  if (typeof rawOrderIds !== 'string' || !rawOrderIds.trim()) {
    return res.status(400).json({
      code: 'INVALID_RECONCILIATION_ORDER_IDS',
      message: `Provide 1 to ${MAX_RECONCILIATION_ORDERS} comma-separated order IDs.`,
    });
  }
  const orderIds = rawOrderIds.split(',').map(value => {
    if (!/^[1-9]\d*$/.test(value)) return NaN;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : NaN;
  });
  try {
    const rows = await reconcileOrderPayments({
      pool,
      razorpay: getRazorpayClient(),
      orderIds,
    });
    return res.json({ success: true, readOnly: true, rows });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ code: error.code, message: error.message });
    }
    console.error('[ORDER_PAYMENT_RECONCILIATION]', error);
    return res.status(500).json({
      code: 'ORDER_PAYMENT_RECONCILIATION_FAILED',
      message: 'Could not reconcile the selected orders with Razorpay.',
    });
  }
});

const { executeAtomicOrderCancellationAndRefund } = require("../services/walletRefundLedgerService");

// Arbitrary customer status tampering is disabled; cancellation must use POST /:id/cancel
router.patch("/:id/status", authenticateUser, async (req, res) => {
  return res.status(403).json({
    success: false,
    code: "CUSTOMER_STATUS_TAMPER_DISABLED",
    message: "Direct status editing is disabled. If your order has not yet been packed or shipped, please use the Cancel Order button in your order details.",
  });
});

router.post("/:id/cancel", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.query(
      "SELECT id, order_number, user_id, status, payment_mode, payment_status, total FROM orders WHERE id = ? LIMIT 1",
      [id]
    );
    const order = orders?.[0];
    if (!order) {
      return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND", message: "Order not found." });
    }

    const isAdmin = ['admin', 'superadmin'].includes(req.user?.role);
    if (!isAdmin && Number(order.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, code: "FORBIDDEN", message: "You can only cancel your own orders." });
    }

    const currentStatus = String(order.status || '').toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(400).json({ success: false, code: "ORDER_ALREADY_CANCELLED", message: "This order is already cancelled." });
    }

    const nonCancellableStatuses = ['packed', 'shipped', 'out_for_delivery', 'delivered'];
    if (nonCancellableStatuses.includes(currentStatus)) {
      const isDelivered = currentStatus === 'delivered';
      return res.status(400).json({
        success: false,
        code: isDelivered ? "ORDER_DELIVERED_NON_RETURNABLE" : "ORDER_ALREADY_PACKED_OR_SHIPPED",
        message: isDelivered
          ? `Order #${order.order_number || order.id} is already delivered. All Bhumivera formulations are intimate personal care cosmetics and are 100% non-returnable once delivered.`
          : `Order #${order.order_number || order.id} is already ${currentStatus.replace(/_/g, ' ')} and cannot be cancelled because it has already been packed and dispatched from our warehouse. Orders can only be cancelled before they are packed and shipped.`,
      });
    }

    const cancelResult = await executeAtomicOrderCancellationAndRefund(pool, {
      orderId: order.id,
      reason: req.body.reason || "Cancelled by customer before packaging/dispatch",
      executedByEmail: req.user.email || "customer@bhumivera.com",
    });
    await syncCommissionOrderStatus(order.id, 'cancelled');

    await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});
    await invalidatePublicCatalogCache().catch(() => {});

    return res.json({
      success: true,
      message: `Order #${order.order_number || order.id} has been cancelled successfully. Full refund has been initiated.`,
      orderId: cancelResult.orderId,
      refundSummary: cancelResult.refundSummary,
    });
  } catch (error) {
    console.error("[CUSTOMER_ORDER_CANCEL_ERROR]", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "ORDER_CANCEL_FAILED",
      message: error.message || "Failed to cancel order.",
    });
  }
});

router.put("/:id/status", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber, trackingUrl, tracking_url, courier } = req.body;
    const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned', 'archived'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "A valid order status is required." });
    }

    if (status === "cancelled") {
      if (req.user?.role !== "superadmin") {
        return res.status(403).json({
          success: false,
          code: "SUPERADMIN_REQUIRED_FOR_CANCELLATION",
          message: "Order cancellation can only be executed by the SuperAdmin.",
        });
      }
      const cancelResult = await executeAtomicOrderCancellationAndRefund(pool, {
        orderId: id,
        reason: req.body.cancelReason || req.body.reason || "Cancelled by SuperAdmin",
        refundDestinationPreference: req.body.refundDestinationPreference || "auto",
        executedByEmail: req.user?.email || "adminbhumivera27@gmail.com",
        razorpay: getRazorpayClient(),
      });
      await syncCommissionOrderStatus(cancelResult.orderId, 'cancelled');
      await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});
      await invalidatePublicCatalogCache().catch(() => {});
      const [orderData] = await pool.query(
        `SELECT o.id, o.order_number, o.status, o.tracking_number, o.courier, o.tracking_url, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
        [cancelResult.orderId]
      );
      if (orderData.length > 0) {
        const { email, name } = orderData[0];
        sendOrderStatusEmail(email, name, cancelResult.orderId, "cancelled", trackingNumber, courier, orderData[0].order_number)
          .catch(err => console.error(`[Mailer] Failed to send email:`, err));
      }
      return res.json({
        success: true,
        message: "Order cancelled and atomic refund/wallet ledger updated.",
        refundSummary: cancelResult.refundSummary,
        ledgerReference: cancelResult.ledgerReference,
      });
    }

    const updated = await updateOrderStatus(id, status, req.body.cancelReason, {
      trackingNumber,
      courier,
      trackingUrl: trackingUrl || tracking_url,
    });
    if (updated === false) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found.' });
    await syncWebsiteProductsToInventoryMeta(pool).catch(() => {});
    await invalidatePublicCatalogCache().catch(() => {});

    const [orderData] = await pool.query(
      `SELECT o.id, o.order_number, o.status, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [id]
    );

    if (orderData.length > 0 && ['shipped', 'out_for_delivery', 'delivered', 'returned', 'cancelled'].includes(String(status).toLowerCase())) {
      const { email, name } = orderData[0];
      let shipmentItems = [];
      if (String(status).toLowerCase() === 'shipped') {
        try {
          const [items] = await pool.query(
            'SELECT name, quantity, price FROM order_items WHERE order_id = ? ORDER BY id ASC',
            [id]
          );
          shipmentItems = items;
        } catch (itemsError) {
          console.error(`Could not load shipment items for order #${id}:`, itemsError);
        }
      }
      sendOrderStatusEmail(email, name, id, status, trackingNumber || orderData[0].tracking_number, courier || orderData[0].courier, orderData[0].order_number, {
        trackingUrl: orderData[0].tracking_url,
        items: shipmentItems,
      })
        .catch(err => console.error(`[Mailer] Failed to send email:`, err));
    }
    res.json({ success: true, message: "Order status updated." });
  } catch (err) {
    console.error("[OrderUpdate Error]:", err);
    if (err.status === 409) return res.status(409).json({ code: err.code, message: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/", orderLimiter, authenticateUser, async (req, res) => {
  let verifiedPayment = null;
  try {
    if (req.body?.termsAccepted !== true) {
      return res.status(400).json({ code: 'TERMS_ACCEPTANCE_REQUIRED', message: 'Accept the Conditions of Sale before placing your order.' });
    }
    const {
      addressId,
      deliveryType,
      paymentMode: requestedPaymentMode,
      couponCode,
      affiliateCode: requestedAffiliateCode,
      notes,
      loyaltyPointsToRedeem,
    } = req.body;
    const paymentMode = requestedPaymentMode || 'online';
    if (!['online', 'WALLET', 'COD'].includes(paymentMode)) {
      return res.status(400).json({ code: 'INVALID_PAYMENT_METHOD', message: 'Choose Razorpay, Bhumivera Wallet, or cash on delivery.' });
    }
    const rawImpactAmount = req.body.impactAmount;
    const impactAmount = rawImpactAmount === undefined ? 0 : Number(rawImpactAmount);
    const allowedImpactAmounts = [0, 50, 100, 250, 500];
    if (!Number.isFinite(impactAmount) || !allowedImpactAmounts.includes(impactAmount)) {
      return res.status(400).json({ message: 'Choose a supported contribution amount.' });
    }
    if (impactAmount > 0) {
      return res.status(400).json({
        code: 'IMPACT_PAYMENT_REQUIRED',
        message: 'Impact co-sponsorships must be paid through the secure Razorpay checkout on the impact project page.',
      });
    }
    const impactProject = null;
    if (!addressId) return res.status(400).json({ message: "Delivery address is required." });

    const addresses = await AddressModel.getAddressesByUser(req.user.id);
    const address = addresses.find((a) => a.id === parseInt(addressId, 10));
    if (!address) return res.status(404).json({ message: "Address not found." });

    const { items, total: cartTotal } = await getCartTotal(req.user.id);
    if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty." });
    const affiliateCode = typeof requestedAffiliateCode === 'string' ? requestedAffiliateCode.trim().toUpperCase() : '';
    if (requestedAffiliateCode && (!affiliateCode || affiliateCode.length > 32 || !/^[A-Z0-9_-]+$/.test(affiliateCode))) {
      return res.status(400).json({ code: 'INVALID_PROMOTER_CODE', message: 'This promoter code is invalid.' });
    }
    const programConfig = await getProgramConfig();

    const rules = await listCartRules({ activeOnly: true });
    const enforceMinimum = (await getSetting('enforce_cart_rule_minimum')) === '1';
    const loyaltyTier = await getUserLoyaltyTier(req.user.id);
    const rulePreview = evaluateCartRules(cartTotal, rules, {
      userId: req.user.id,
      enforceMinimum,
      loyaltyTierId: loyaltyTier?.id,
      loyaltyTierName: loyaltyTier?.name,
    });
    if (rulePreview.enforcedMin !== null && cartTotal < rulePreview.enforcedMin) {
      return res.status(400).json({
        code: 'CART_BELOW_MIN_TIER',
        message: `Add ₹${rulePreview.missingAmount} more to place this order.`,
        enforcedMin: rulePreview.enforcedMin,
        missingAmount: rulePreview.missingAmount,
        userAction: 'Add more items to your cart and try again.',
      });
    }

    let couponDiscount = 0;
    let referralWalletAmount = 0;
    let resolvedCoupon = null;
    let couponId = null;
    let recoveryCoupon = false;
    let couponFreeShipping = false;

    if (couponCode && String(couponCode).trim()) {
      await reconcileReferralRewards(req.user.id);
      let validated;
      try {
        validated = await validateCoupon(couponCode, cartTotal, req.user.id, {
          paymentMode,
          items,
        });
      } catch (couponErr) {
        return res.status(400).json({
          code: couponErr.code || 'INVALID_COUPON',
          message: couponErr.message || 'This coupon is invalid, expired, already used, or assigned to another customer.',
        });
      }
      if (!validated || !validated.valid || !validated.coupon) {
        return res.status(400).json({
          code: validated?.code || 'INVALID_COUPON',
          message: validated?.message || 'This coupon is invalid, expired, already used, or assigned to another customer.',
        });
      }
      const coupon = validated.coupon;
      resolvedCoupon = coupon.code;
      couponId = coupon.id;
      recoveryCoupon = Boolean(coupon.restricted_user_id) && String(coupon.restricted_user_id) === String(req.user.id);

      if (coupon.reward_type !== 'referral_wallet') {
        couponFreeShipping = Boolean(validated.freeShipping || coupon.reward_type === 'free_shipping' || coupon.discount_type === 'free_shipping');
        couponDiscount = couponFreeShipping ? 0 : Math.max(0, Math.min(Number(validated.discountAmount ?? validated.discount ?? 0), cartTotal));
      }
    }

    const couponStackPolicy = await getSetting('coupon_stack_policy') || 'both';
    const ruleDiscount = Number(rulePreview.totalDiscount) || 0;
    let discount = ruleDiscount;
    if (recoveryCoupon || couponStackPolicy === 'both') discount = ruleDiscount + couponDiscount;
    else if (couponStackPolicy === 'coupon_first' && couponDiscount > 0) discount = couponDiscount;
    else if (ruleDiscount <= 0) discount = couponDiscount;
    discount = Math.min(Number(cartTotal) || 0, Math.max(0, discount));
    const discountWithoutAffiliate = discount;
    const loyaltyConfig = await getLoyaltyConfig();
    let tierDiscount = calculateTierDiscount(
      Number(cartTotal) || 0,
      discount,
      loyaltyTier?.tier_discount_percent,
      Boolean(loyaltyConfig.enabled)
    );
    let affiliatePartner = null;
    let affiliateDiscount = 0;
    if (affiliateCode) {
      affiliatePartner = await getPartnerByCode(affiliateCode);
      if (!affiliatePartner) {
        return res.status(400).json({ code: 'PROMOTER_CODE_INVALID', message: 'This promoter offer is not active.' });
      }
      if (String(affiliatePartner.user_id) === String(req.user.id)) {
        return res.status(400).json({ code: 'PROMOTER_SELF_REFERRAL', message: 'Promoter codes cannot be used on the promoter’s own orders.' });
      }
      affiliateDiscount = roundCurrency(Number(cartTotal) * Number(affiliatePartner.discount_percent) / 100);
      discount = Math.min(Number(cartTotal) || 0, Math.max(0, discount + affiliateDiscount));
      tierDiscount = calculateTierDiscount(
        Number(cartTotal) || 0,
        discount,
        loyaltyTier?.tier_discount_percent,
        Boolean(loyaltyConfig.enabled)
      );
    }
    const discountedMerchandiseAmount = roundCurrency(Math.max(0, Number(cartTotal) - discount - tierDiscount));
    if (discountedMerchandiseAmount < Number(programConfig.minimum_order_amount)) {
      const missingAmount = roundCurrency(Number(programConfig.minimum_order_amount) - discountedMerchandiseAmount);
      return res.status(400).json({
        code: 'MINIMUM_ORDER_NOT_MET',
        minimumOrderAmount: Number(programConfig.minimum_order_amount),
        missingAmount,
        message: `Add ₹${missingAmount.toFixed(2)} more in merchandise after discounts to place this order.`,
      });
    }
    const referralConfig = await getReferralConfig();
    const [[referralWallet]] = await pool.query(
      'SELECT balance, welcome_bonus_balance FROM referral_wallets WHERE user_id = ?',
      [req.user.id]
    ).catch(async () => {
      const [[fallback]] = await pool.query('SELECT balance FROM referral_wallets WHERE user_id = ?', [req.user.id]);
      return [[fallback]];
    });
    referralWalletAmount = calculateTieredReferralWalletRedemption(
      Math.max(0, Number(referralWallet?.balance) || 0),
      Number(cartTotal) || 0,
      referralConfig.referral_redemption_tiers,
      Math.max(0, Number(cartTotal) - discount - tierDiscount),
      referralWallet?.welcome_bonus_balance !== undefined ? Number(referralWallet.welcome_bonus_balance) : null
    );

    const shippingSettings = await getSettingsByGroup('shipping');
    const shippingCost = calculateShippingCost({
      deliveryType,
      cartSubtotal: cartTotal,
      standardCharge: shippingSettings.standard_charge ?? shippingSettings.default_shipping_charge ?? 50,
      premiumCharge: shippingSettings.express_charge ?? 150,
      freeShippingThreshold: shippingSettings.free_shipping_threshold,
      freeShipping: Boolean(rulePreview.freeShipping) ||
        (Boolean(loyaltyConfig.enabled) && Number(loyaltyTier?.free_shipping) === 1) ||
        couponFreeShipping,
    });

    const giftItems = [];
    for (const gift of rulePreview.gifts) {
      const [products] = await pool.query('SELECT id, name, sku, quantity FROM products WHERE id = ? AND status = \'active\'', [gift.productId]);
      if (products.length && Number(products[0].quantity) >= gift.quantity) {
        giftItems.push({ product_id: products[0].id, quantity: gift.quantity, is_gift: true });
      }
    }
    const lifecycleSettings = await getSettingsByGroup('lifecycle');
    const lifecycleGiftProductId = lifecycleSettings.lifecycle_third_order_enabled === '1'
      ? Number(lifecycleSettings.lifecycle_third_order_gift_product_id) || null
      : null;
    const orderItems = [...items, ...giftItems];
    const backendSubtotal = items.reduce((sum, item) => {
      const discountPrice = Number(item.discount_price);
      const unitPrice = discountPrice > 0 ? discountPrice : Number(item.price) || 0;
      return sum + unitPrice * (Number(item.quantity) || 1);
    }, 0);
    if (affiliatePartner) {
      affiliateDiscount = roundCurrency(backendSubtotal * Number(affiliatePartner.discount_percent) / 100);
      discount = Math.min(backendSubtotal, discountWithoutAffiliate + affiliateDiscount);
      tierDiscount = calculateTierDiscount(
        backendSubtotal,
        discount,
        loyaltyTier?.tier_discount_percent,
        Boolean(loyaltyConfig.enabled)
      );
    }
    const safeDiscount = Math.min(backendSubtotal, Math.max(0, Number(discount) || 0));
    const safeTierDiscount = calculateTierDiscount(
      backendSubtotal,
      safeDiscount,
      loyaltyTier?.tier_discount_percent,
      Boolean(loyaltyConfig.enabled)
    );
    const actualDiscountedMerchandise = roundCurrency(Math.max(0, backendSubtotal - safeDiscount - safeTierDiscount));
    if (actualDiscountedMerchandise < Number(programConfig.minimum_order_amount)) {
      const missingAmount = roundCurrency(Number(programConfig.minimum_order_amount) - actualDiscountedMerchandise);
      return res.status(400).json({
        code: 'MINIMUM_ORDER_NOT_MET',
        minimumOrderAmount: Number(programConfig.minimum_order_amount),
        missingAmount,
        message: `Add ₹${missingAmount.toFixed(2)} more in merchandise after discounts to place this order.`,
      });
    }
    let pointsToRedeemForOrder = Math.max(0, Math.trunc(Number(loyaltyPointsToRedeem) || 0));
    const requestedPoints = Math.max(0, Math.trunc(Number(loyaltyPointsToRedeem) || 0));
    const [[userPoints]] = await pool.query('SELECT loyalty_points FROM users WHERE id = ?', [req.user.id]);
    const redemption = calculateLoyaltyRedemption({
      pointsBalance: userPoints?.loyalty_points,
      eligibleSubtotal: backendSubtotal - safeDiscount - safeTierDiscount - referralWalletAmount,
      redemptionPointsPerRupee: loyaltyConfig.redemption_points_per_rupee,
      maxRedemptionPercent: loyaltyConfig.max_redemption_percent,
      minimumRedemptionPoints: loyaltyConfig.minimum_redemption_points,
      enabled: Boolean(loyaltyConfig.enabled),
    });
    if (paymentMode !== 'online' && requestedPoints > redemption.points) {
      return res.status(400).json({ code: 'LOYALTY_POINTS_BALANCE_CHANGED', message: 'Your loyalty points or eligible order amount changed. Refresh checkout and try again.' });
    }
    pointsToRedeemForOrder = paymentMode === 'online' ? Math.min(requestedPoints, redemption.points) : requestedPoints;
    const pointsDiscount = Math.min(redemption.discount, pointsToRedeemForOrder / loyaltyConfig.redemption_points_per_rupee);
    const expectedTotal = Math.max(0, backendSubtotal - safeDiscount - safeTierDiscount - referralWalletAmount + shippingCost - pointsDiscount);

    if (affiliatePartner) {
      const productIds = [...new Set(orderItems.map(item => Number(item.product_id || item.id)).filter(Number.isSafeInteger))];
      const placeholders = productIds.map(() => '?').join(',');
      const [products] = await pool.query(
        `SELECT p.id, p.price, p.discount_price, p.gst_rate, m.cost_price
         FROM products p
         LEFT JOIN inventory_product_meta m ON m.product_id = p.id
         WHERE p.id IN (${placeholders})`,
        productIds
      );
      const productById = new Map(products.map(product => [Number(product.id), product]));
      const policyItems = orderItems.map(item => {
        const product = productById.get(Number(item.product_id || item.id));
        if (!product || !Number.isFinite(Number(product.cost_price)) || Number(product.cost_price) <= 0) {
          return null;
        }
        const isGift = item.is_gift === true || Number(item.is_gift) === 1;
        return {
          unitPrice: isGift ? 0 : (Number(product.discount_price) > 0 ? Number(product.discount_price) : Number(product.price)),
          unitCost: Number(product.cost_price),
          quantity: Number(item.quantity) || 1,
          gstRate: product.gst_rate === null || product.gst_rate === undefined ? 18 : Number(product.gst_rate),
        };
      });
      if (policyItems.some(item => item === null)) {
        return res.status(400).json({
          code: 'AFFILIATE_PRODUCT_COST_MISSING',
          message: 'This basket includes a product without a verified inventory unit cost, so the promoter offer cannot be applied.',
        });
      }
      const profit = calculateAffiliateProfit({
        items: policyItems,
        merchandiseSubtotal: backendSubtotal,
        totalMerchandiseDiscount: safeDiscount + safeTierDiscount + referralWalletAmount + pointsDiscount,
        paymentTotal: expectedTotal,
        paymentMode,
        commissionSharePercent: Number(affiliatePartner.commission_share_percent),
        fulfillmentCost: programConfig.fulfillment_cost,
        rtoReserve: programConfig.rto_reserve,
        onlinePaymentFeePercent: programConfig.online_payment_fee_percent,
        minimumRetainedMarginPercent: programConfig.minimum_retained_margin_percent,
      });
      if (!profit.eligible) {
        return res.status(400).json({
          code: 'AFFILIATE_MARGIN_FLOOR_NOT_MET',
          message: 'This basket cannot receive the promoter offer while preserving the minimum product margin. Adjust the basket or remove the offer.',
        });
      }
    }

    if (paymentMode === 'online') {
      const {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
      } = req.body;
      if (![razorpayOrderId, razorpayPaymentId, razorpaySignature].every(value => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ message: 'Verified Razorpay payment details are required for online orders.' });
      }
      verifiedPayment = await verifyRazorpayPayment({
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
        userId: req.user.id,
        expectedAmount: Math.round(expectedTotal * 100),
      });
    }

    const orderResult = await createOrder({
      userId: req.user.id,
      items: orderItems,
      discount,
      couponCode: resolvedCoupon,
      couponId,
      referralWalletAmount,
      tierDiscount,
      addressSnapshot: address,
      deliveryType: deliveryType || "standard",
      paymentMode,
      paymentStatus: verifiedPayment || paymentMode === 'WALLET' ? 'paid' : 'pending',
      paymentId: verifiedPayment?.payment.id || null,
      notes: notes || null,
      shippingCost,
      impactAmount,
      impactProject,
      loyaltyRuleBonusPoints: rulePreview.loyaltyBonusPoints,
      termsVersion: TERMS_VERSION,
      lifecycleGiftProductId,
      loyaltyPointsToRedeem: pointsToRedeemForOrder,
      affiliateCode: affiliatePartner?.referral_code || null,
      affiliateDiscount,
      affiliatePartnerId: affiliatePartner?.id || null,
      ipAddress: req.ip || null,
      userAgent: req.headers?.['user-agent'] || null,
    });
    const orderId = orderResult.id;
    if (orderResult.reused) {
      return res.status(200).json({
        orderId,
        orderNumber: orderResult.orderNumber,
        message: "This payment was already used to place an order.",
        discount,
        shippingCost,
        rulePreview,
      });
    }

    await clearCart(req.user.id);

    // Automatically route order to Inventory Software (/inventorysoftware) with calculated delivery date & live stock movement logs
    try {
      const estDate = calculateEstimatedDeliveryDate(address, deliveryType || 'standard');
      await pool.query(
        `UPDATE orders
         SET estimated_delivery_date = COALESCE(estimated_delivery_date, ?),
             current_location_checkpoint = COALESCE(current_location_checkpoint, 'Order Placed — Routed to Asansol Inventory Hub')
         WHERE id = ?`,
        [estDate, orderId]
      );
      await syncWebsiteProductsToInventoryMeta(pool);
      for (const it of orderItems) {
        const pid = it.product_id || it.id;
        if (pid) {
          const [[prodRow]] = await pool.query('SELECT id, name, sku, quantity FROM products WHERE id = ?', [pid]);
          if (prodRow) {
            const qtyOrdered = Number(it.quantity) || 1;
            const qtyAfter = Number(prodRow.quantity) || 0;
            await recordStockMovement(pool, {
              productId: prodRow.id,
              sku: prodRow.sku || `PROD-${prodRow.id}`,
              productName: prodRow.name,
              movementType: 'ONLINE_ORDER_PLACED',
              qtyBefore: qtyAfter + qtyOrdered,
              qtyDelta: -qtyOrdered,
              qtyAfter,
              binCode: 'ASN-DISPATCH-R1-B01',
              referenceId: `ORD-#${orderResult.orderNumber || orderId}`,
              reason: `Online Storefront Order #${orderResult.orderNumber || orderId} (${address.city || 'India'})`,
              operatorUsername: 'bhumivera.com',
            });
          }
        }
      }
    } catch (syncErr) {
      console.warn('[ORDER_INVENTORY_ROUTE_SYNC_WARN]', syncErr.message);
    }

    await invalidatePublicCatalogCache().catch(() => {});

    const orderNotifications = [
      {
        user_id: req.user.id,
        title: 'Order placed successfully',
        message: `Your order #${orderResult.orderNumber || orderId} is confirmed as received.`,
        type: 'order',
        is_global: false,
      },
      {
        user_id: null,
        title: 'New customer order routed to Inventory Hub',
        message: `Order #${orderResult.orderNumber || orderId} (${address.city || 'India'}) was routed to /inventorysoftware for dispatch.`,
        type: 'order',
        is_global: false,
      },
    ];
    for (const notification of orderNotifications) {
      try {
        await createNotification(notification);
      } catch (notificationError) {
        console.error('[ORDER_PLACED_NOTIFICATION_FAILED]', { orderId, userId: notification.user_id, error: notificationError });
      }
    }
    try {
      const [userRecords] = await pool.query(`SELECT name, email FROM users WHERE id = ?`, [req.user.id]);
      if (userRecords.length > 0) {
        const { name, email } = userRecords[0];
        sendOrderStatusEmail(email, name, orderId, 'pending', null, null, orderResult.orderNumber)
          .catch(err => console.error(`[Mailer] Auto-email placement failed:`, err));
      }
    } catch (mailErr) {
      console.error("[Mailer] DB Query Error during placement:", mailErr);
    }

    return res.status(201).json({ orderId, orderNumber: orderResult.orderNumber, message: "Order placed successfully", discount, tierDiscount, referralWalletAmount, shippingCost, rulePreview });
  } catch (err) {
    console.error("Place order error:", err);
    if (verifiedPayment?.payment?.id) {
      console.error("[CRITICAL_PAYMENT_CAPTURED_ORDER_FAILED]", { paymentId: verifiedPayment.payment.id, error: err.message });
      try {
        const razorpay = getRazorpayClient();
        await razorpay.payments.refund(verifiedPayment.payment.id, {
          notes: { reason: 'Order creation failed after payment capture; automated rollback refund', userId: String(req.user.id) }
        });
        console.info('[AUTO_REFUND_ISSUED]', verifiedPayment.payment.id);
        return res.status(409).json({
          code: 'PAYMENT_REFUNDED_ORDER_FAILED',
          message: (err.message || "Checkout failed.") + " Your payment (ID: " + verifiedPayment.payment.id + ") has been automatically refunded.",
          refunded: true,
          paymentId: verifiedPayment.payment.id
        });
      } catch (refundErr) {
        console.error('[AUTO_REFUND_FAILED]', refundErr.message);
      }
    }
    if (err.status === 403 && err.code === 'COD_DELIVERY_REQUIREMENT') {
      return res.status(403).json({ code: err.code, message: err.message });
    }
    if (err.status === 400 && err.code === 'INSUFFICIENT_WALLET_BALANCE') {
      return res.status(400).json({ code: err.code, message: err.message });
    }
    if (err.statusCode === 400 || err.status === 400) {
      return res.status(400).json({
        ...(err.code ? { code: err.code } : {}),
        message: err.message,
      });
    }
    if (err.status === 409) return res.status(409).json({ code: err.code, message: err.message });
    if (err.message?.includes("Insufficient stock")) return res.status(400).json({ message: err.message });
    if (err.message?.includes("not found")) return res.status(400).json({ message: "Product no longer available." });
    return res.status(500).json({ message: "Checkout failed due to a server error. Please try again." });
  }
});

router.get('/cod-eligibility', authenticateUser, async (req, res) => {
  try {
    const deliveredOrderCount = await getDeliveredOrderCount(req.user.id);
    const [[orderCountRow]] = await pool.query(
      `SELECT COUNT(*) AS order_count FROM orders
       WHERE user_id = ? AND status NOT IN ('cancelled', 'returned')
         AND (payment_status = 'paid' OR (payment_mode = 'COD' AND delivered_at IS NOT NULL))`,
      [req.user.id]
    );
    const orderCount = Number(orderCountRow?.order_count) || 0;
    const requiredDeliveredOrders = COD_REQUIRED_DELIVERED_ORDERS;
    return res.json({
      eligible: deliveredOrderCount >= requiredDeliveredOrders,
      deliveredOrderCount,
      requiredDeliveredOrders,
      isNewCustomer: orderCount === 0,
    });
  } catch (error) {
    console.error('[CUSTOMER_COD_ELIGIBILITY]', error);
    return res.status(500).json({ message: 'Could not check cash-on-delivery eligibility.' });
  }
});

router.get("/my", authenticateUser, async (req, res) => {
  try {
    const orders = await getOrdersByUser(req.user.id);
    return res.json(orders);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load orders" });
  }
});

router.post("/track", orderLimiter, async (req, res) => {
  const orderReference = typeof req.body?.orderId === 'string'
    ? req.body.orderId.trim().replace(/^#/, '')
    : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!orderReference || orderReference.length > 50 || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      code: 'INVALID_ORDER_TRACKING_DETAILS',
      message: 'Enter your order number and the email address used at checkout.',
    });
  }
  try {
    const order = await trackOrderByCustomer(orderReference, email);
    if (!order) {
      return res.status(404).json({
        code: 'ORDER_NOT_FOUND',
        message: 'We could not find an order matching those details. Check the order number and checkout email, then try again.',
      });
    }
    return res.json({ order });
  } catch (error) {
    console.error('[CUSTOMER_ORDER_TRACKING]', error);
    return res.status(500).json({ message: 'Order tracking is temporarily unavailable. Please try again shortly.' });
  }
});

router.get("/", authenticateUser, async (req, res) => {
  try {
    const orders = await getOrdersByUser(req.user.id);
    return res.json(orders);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load orders" });
  }
});

router.get("/:id", authenticateUser, async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');
    if (!isAdmin && order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load order" });
  }
});

router.post("/:id/return", authenticateUser, async (req, res) => {
  return res.status(410).json({
    code: "RETURN_REQUEST_ENDPOINT_RETIRED",
    message: "Submit a return request through /api/returns so it can be reviewed before the order status changes."
  });
});

router.delete("/:id", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderById(id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    await pool.query(`UPDATE orders SET status = 'archived', updated_at = NOW() WHERE id = ?`, [id]);
    return res.json({ success: true, message: "Order archived successfully" });
  } catch (err) {
    console.error("[Order Delete Error]:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
