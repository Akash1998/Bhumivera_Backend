const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateUser, authenticateAdmin } = require("../middleware/authMiddleware");
const { sendOrderStatusEmail } = require("../utils/mail");

const { 
  createOrder, 
  getOrdersByUser, 
  getOrderById, 
  getAllOrders,
  updateOrderStatus 
} = require("../models/orderModel");
const { getCartTotal, clearCart } = require("../models/cartModel");
const { getSetting, getSettingsByGroup } = require('../models/settingsModel');
const { listCartRules } = require('../models/cartRulesModel');
const { evaluateCartRules } = require('../utils/cartRulesEngine');

// [FIX]: Correctly destructure AddressModel from the exported object
const { AddressModel } = require("../models/addressModel");

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

// User-accessible PATCH status endpoint: supports "cancelled" only (used by Profile orders tab)
router.patch("/:id/status", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) return res.status(400).json({ message: "Status is required" });

    if (status === "cancelled") {
      const order = await getOrderById(id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });

      const cancellableStatuses = ["pending", "confirmed"];
      if (!cancellableStatuses.includes(order.status)) {
        return res.status(400).json({ message: `Cannot cancel order with status '${order.status}'` });
      }

      await updateOrderStatus(order.id, "cancelled", req.body.reason || "Cancelled by customer");
      return res.json({ success: true, message: "Order cancelled successfully" });
    }

    // Only admin can set other statuses via PUT (below); reject non-cancel for users
    return res.status(403).json({ message: `Cannot change order status to '${status}'` });
  } catch (err) {
    console.error("[Order User PATCH Error]:", err);
    res.status(500).json({ message: err.message });
  }
});

// User-friendly POST alias to cancel an order (matches frontend orders.cancel helper)
router.post("/:id/cancel", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderById(id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    const cancellableStatuses = ["pending", "confirmed"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ message: `Cannot cancel order with status '${order.status}'` });
    }
    await updateOrderStatus(order.id, "cancelled", req.body.reason || "Cancelled by customer");
    return res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    console.error("[Order Cancel Error]:", err);
    res.status(500).json({ message: err.message });
  }
});

router.put("/:id/status", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber, courier } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }

    const updated = await updateOrderStatus(id, status, req.body.cancelReason, { trackingNumber, courier });
    if (updated === false) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found.' });

    const [orderData] = await pool.query(
      `SELECT o.id, o.status, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [id]
    );

    if (orderData.length > 0) {
      const { email, name } = orderData[0];
      sendOrderStatusEmail(email, name, id, status, trackingNumber, courier)
        .catch(err => console.error(`[Mailer] Failed to send email:`, err));
    }

    res.json({ success: true, message: "Order status updated." });
  } catch (err) {
    console.error("[OrderUpdate Error]:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/", authenticateUser, async (req, res) => {
  try {
    const { addressId, deliveryType, paymentMode, couponCode, notes, loyaltyPointsToRedeem } = req.body;
    if (!addressId) return res.status(400).json({ message: "Delivery address is required." });

    // [FIX]: Use AddressModel.getAddressesByUser
    const addresses = await AddressModel.getAddressesByUser(req.user.id);
    const address = addresses.find((a) => a.id === parseInt(addressId, 10));
    if (!address) return res.status(404).json({ message: "Address not found." });

    const { items, total: cartTotal } = await getCartTotal(req.user.id);
    if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty." });

    const rules = await listCartRules({ activeOnly: true });
    const enforceMinimum = (await getSetting('enforce_cart_rule_minimum')) === '1';
    const rulePreview = evaluateCartRules(cartTotal, rules, { userId: req.user.id, enforceMinimum });
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
    let resolvedCoupon = null;
    let couponId = null;

    if (couponCode) {
      const [coupons] = await pool.query(
        `SELECT * FROM coupons WHERE code=? AND is_active=1 AND (valid_from IS NULL OR valid_from <= NOW()) AND (expires_at IS NULL OR expires_at >= NOW())`,
        [couponCode.toUpperCase()]
      );
      const coupon = coupons[0];
      if (coupon && cartTotal >= (Number(coupon.min_order_amount) || 0)) {
        couponDiscount = coupon.discount_type === "percentage"
          ? Math.min((cartTotal * Number(coupon.discount_value)) / 100, Number(coupon.max_discount) || Infinity)
          : Number(coupon.discount_value) || 0;
        couponDiscount = Math.max(0, Math.min(couponDiscount, cartTotal));
        resolvedCoupon = coupon.code;
        couponId = coupon.id;
      }
    }

    const couponStackPolicy = await getSetting('coupon_stack_policy') || 'rule_first';
    const ruleDiscount = Number(rulePreview.totalDiscount) || 0;
    let discount = ruleDiscount;
    if (couponStackPolicy === 'both') discount = ruleDiscount + couponDiscount;
    else if (couponStackPolicy === 'coupon_first' && couponDiscount > 0) discount = couponDiscount;
    else if (ruleDiscount <= 0) discount = couponDiscount;
    discount = Math.min(Number(cartTotal) || 0, Math.max(0, discount));

    const shippingSettings = await getSettingsByGroup('shipping');
    const shippingKey = deliveryType === 'express' ? 'express_charge' : 'standard_charge';
    const configuredShipping = Number(shippingSettings[shippingKey] ?? (deliveryType === 'express' ? 150 : shippingSettings.default_shipping_charge ?? 50));
    const shippingCost = rulePreview.freeShipping ? 0 : (Number.isFinite(configuredShipping) ? Math.max(0, configuredShipping) : 0);

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
    const loyaltyPointsPerRupee = Math.max(1, Number(await getSetting('loyalty_points_per_rupee')) || 10);
    const orderItems = [...items, ...giftItems];

    const orderId = await createOrder({
      userId: req.user.id,
      items: orderItems,
      discount,
      couponCode: resolvedCoupon,
      addressSnapshot: address,
      deliveryType: deliveryType || "standard",
      paymentMode: paymentMode || "COD",
      notes: notes || null,
      shippingCost,
      loyaltyPointsAwarded: rulePreview.loyaltyBonusPoints,
      lifecycleGiftProductId,
      loyaltyPointsToRedeem,
      loyaltyPointsPerRupee,
    });

    if (couponId) await pool.query("UPDATE coupons SET used_count=used_count+1 WHERE id=?", [couponId]);

    await clearCart(req.user.id);

    // [ENHANCEMENT]: Immediately dispatch Order Confirmation Email upon successful placement
    try {
      const [userRecords] = await pool.query(`SELECT name, email FROM users WHERE id = ?`, [req.user.id]);
      if (userRecords.length > 0) {
        const { name, email } = userRecords[0];
        sendOrderStatusEmail(email, name, orderId, 'pending')
          .catch(err => console.error(`[Mailer] Auto-email placement failed:`, err));
      }
    } catch (mailErr) {
      console.error("[Mailer] DB Query Error during placement:", mailErr);
    }

    return res.status(201).json({ orderId, message: "Order placed successfully", discount, shippingCost, rulePreview });
  } catch (err) {
    console.error("Place order error:", err);
    if (err.message?.includes("Insufficient stock")) return res.status(400).json({ message: err.message });
    if (err.message?.includes("not found")) return res.status(400).json({ message: "Product no longer available." });
    return res.status(500).json({ message: `Checkout Error: ${err.sqlMessage || err.message}` });
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
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    if (order.status !== "delivered") return res.status(400).json({ message: "Only delivered orders can be returned" });

    await updateOrderStatus(order.id, "returned", req.body.reason || "Return requested by customer");
    return res.json({ message: "Return request submitted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to submit return request" });
  }
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
