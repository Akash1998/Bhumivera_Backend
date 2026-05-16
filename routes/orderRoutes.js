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

// [FIX]: Correctly destructure AddressModel from the exported object
const { AddressModel } = require("../models/addressModel");

router.get("/all", authenticateAdmin, async (req, res) => {
  try {
    const orders = await getAllOrders();
    return res.json(orders);
  } catch (err) {
    console.error("Admin Fetch Orders Error:", err);
    return res.status(500).json({ message: "Failed to load global orders ledger" });
  }
});

router.put("/:id/status", authenticateAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    const { status, trackingNumber, courier } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }

    await connection.query(
      `UPDATE orders SET status = ?, tracking_number = ?, courier = ?, updated_at = NOW() WHERE id = ?`,
      [status, trackingNumber || null, courier || null, id]
    );

    const [orderData] = await connection.query(
      `SELECT o.id, o.status, u.name, u.email FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [id]
    );

    await connection.commit();

    if (orderData.length > 0) {
      const { email, name } = orderData[0];
      sendOrderStatusEmail(email, name, id, status, trackingNumber, courier)
        .catch(err => console.error(`[Mailer] Failed to send email:`, err));
    }

    res.json({ success: true, message: "Order status updated." });
  } catch (err) {
    await connection.rollback();
    console.error("[OrderUpdate Error]:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});

router.post("/", authenticateUser, async (req, res) => {
  try {
    const { addressId, deliveryType, paymentMode, couponCode, notes } = req.body;
    if (!addressId) return res.status(400).json({ message: "Delivery address is required." });

    // [FIX]: Use AddressModel.getAddressesByUser
    const addresses = await AddressModel.getAddressesByUser(req.user.id);
    const address = addresses.find((a) => a.id === parseInt(addressId, 10));
    if (!address) return res.status(404).json({ message: "Address not found." });

    const { items, total: cartTotal } = await getCartTotal(req.user.id);
    if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty." });

    let discount = 0;
    let resolvedCoupon = null;

    if (couponCode) {
      const [coupons] = await pool.query(
        `SELECT * FROM coupons WHERE code=? AND is_active=1 AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_until IS NULL OR valid_until >= NOW())`,
        [couponCode.toUpperCase()]
      );
      const coupon = coupons[0];
      if (coupon && cartTotal >= (coupon.min_order_value || 0)) {
        discount = coupon.type === "percentage"
          ? Math.min((cartTotal * coupon.value) / 100, coupon.max_discount || Infinity)
          : coupon.value;
        discount = parseFloat(Math.min(discount, cartTotal).toFixed(2));
        resolvedCoupon = coupon.code;
        await pool.query("UPDATE coupons SET used_count=used_count+1 WHERE id=?", [coupon.id]);
      }
    }

    const orderId = await createOrder({
      userId: req.user.id,
      items,
      discount,
      couponCode: resolvedCoupon,
      addressSnapshot: address,
      deliveryType: deliveryType || "standard",
      paymentMode: paymentMode || "COD",
      notes: notes || null,
    });

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

    return res.status(201).json({ orderId, message: "Order placed successfully", discount });
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
    if (order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load order" });
  }
});

router.post("/:id/cancel", authenticateUser, async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user_id !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    
    const cancellableStatuses = ["pending", "confirmed"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ message: `Cannot cancel order with status '${order.status}'` });
    }

    await updateOrderStatus(order.id, "cancelled", req.body.reason || "Cancelled by customer");
    return res.json({ message: "Order cancelled successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to cancel order" });
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

module.exports = router;
