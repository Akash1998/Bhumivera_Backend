const { orderLimiter } = require('../middleware/rateLimiter');
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
const { sendOrderStatusEmail } = require("../utils/mail");

const { 
  createOrder, 
  getDeliveredOrderCount,
  getOrdersByUser, 
  getOrderById, 
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

// Strict Order Cancellation Policy: Customer self-cancellation is disabled.
router.patch("/:id/status", authenticateUser, async (req, res) => {
  return res.status(403).json({
    success: false,
    code: "CUSTOMER_SELF_CANCEL_DISABLED",
    message: "Direct self-service order cancellation is disabled to protect your payment and fulfillment state. Please open the Bhumivera Client Concierge to verify your Order ID and request specialist callback or email assistance.",
  });
});

router.post("/:id/cancel", authenticateUser, async (req, res) => {
  return res.status(403).json({
    success: false,
    code: "CUSTOMER_SELF_CANCEL_DISABLED",
    message: "Direct self-service order cancellation is disabled. Please use the Bhumivera Client Concierge to verify your Order ID and schedule a specialist callback or email update within 12 hours.",
  });
});

router.put("/:id/status", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber, courier } = req.body;
    const validStatuses = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned', 'archived'];

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
      const [orderData] = await pool.query(
        `SELECT o.id, o.order_number, o.status, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
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

    const updated = await updateOrderStatus(id, status, req.body.cancelReason, { trackingNumber, courier });
    if (updated === false) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found.' });
    const [orderData] = await pool.query(
      `SELECT o.id, o.order_number, o.status, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [id]
    );

    if (orderData.length > 0) {
      const { email, name } = orderData[0];
      sendOrderStatusEmail(email, name, id, status, trackingNumber, courier, orderData[0].order_number)
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
      notes,
      loyaltyPointsToRedeem,
    } = req.body;
    const paymentMode = requestedPaymentMode || 'online';
    if (!['online', 'WALLET', 'COD'].includes(paymentMode)) {
      return res.status(400).json({ code: 'INVALID_PAYMENT_METHOD', message: 'Choose Razorpay, Bhumivera Wallet, or cash on delivery.' });
    }
    const rawImpactAmount = req.body.impactAmount;
    const impactAmount = rawImpactAmount === undefined ? 0 : Number(rawImpactAmount);
    const impactProjects = ['native-trees', 'river-care', 'community-care'];
    const allowedImpactAmounts = [0, 50, 100, 250, 500];
    const impactProject = req.body.impactProject;
    if (!Number.isFinite(impactAmount) || !allowedImpactAmounts.includes(impactAmount)) {
      return res.status(400).json({ message: 'Choose a supported contribution amount.' });
    }
    if (impactAmount > 0 && (!impactProjects.includes(impactProject) || (paymentMode || 'COD') !== 'COD')) {
      return res.status(400).json({ message: 'Impact contributions are available with cash-on-delivery orders only.' });
    }
    if (!addressId) return res.status(400).json({ message: "Delivery address is required." });

    const addresses = await AddressModel.getAddressesByUser(req.user.id);
    const address = addresses.find((a) => a.id === parseInt(addressId, 10));
    if (!address) return res.status(404).json({ message: "Address not found." });

    const { items, total: cartTotal } = await getCartTotal(req.user.id);
    if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty." });

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
    const loyaltyConfig = await getLoyaltyConfig();
    const tierDiscount = calculateTierDiscount(
      Number(cartTotal) || 0,
      discount,
      loyaltyTier?.tier_discount_percent,
      Boolean(loyaltyConfig.enabled)
    );
    const referralConfig = await getReferralConfig();
    const [[referralWallet]] = await pool.query(
      'SELECT balance FROM referral_wallets WHERE user_id = ?',
      [req.user.id]
    );
    referralWalletAmount = calculateTieredReferralWalletRedemption(
      Math.max(0, Number(referralWallet?.balance) || 0),
      Number(cartTotal) || 0,
      referralConfig.referral_redemption_tiers,
      Math.max(0, Number(cartTotal) - discount - tierDiscount)
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
    let pointsToRedeemForOrder = Math.max(0, Math.trunc(Number(loyaltyPointsToRedeem) || 0));
    if (paymentMode === 'online') {
      const {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
      } = req.body;
      if (![razorpayOrderId, razorpayPaymentId, razorpaySignature].every(value => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ message: 'Verified Razorpay payment details are required for online orders.' });
      }
      const backendSubtotal = items.reduce((sum, item) => {
        const discountPrice = Number(item.discount_price);
        const unitPrice = discountPrice > 0 ? discountPrice : Number(item.price) || 0;
        return sum + unitPrice * (Number(item.quantity) || 1);
      }, 0);
      const safeDiscount = Math.min(backendSubtotal, Math.max(0, Number(discount) || 0));
      const safeTierDiscount = calculateTierDiscount(
        backendSubtotal,
        safeDiscount,
        loyaltyTier?.tier_discount_percent,
        Boolean(loyaltyConfig.enabled)
      );
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
      pointsToRedeemForOrder = Math.min(requestedPoints, redemption.points);
      const pointsDiscount = Math.min(redemption.discount, pointsToRedeemForOrder / loyaltyConfig.redemption_points_per_rupee);
      const expectedTotal = Math.max(0, backendSubtotal - safeDiscount - safeTierDiscount - referralWalletAmount + shippingCost - pointsDiscount);
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
        title: 'New customer order',
        message: `Order #${orderResult.orderNumber || orderId} was placed by customer ${req.user.id}.`,
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
