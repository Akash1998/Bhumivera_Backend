'use strict';

const crypto = require('crypto');
const { calculateShippingCost } = require('./shippingPolicy');

let defaultPool = null;
function getPool(customPool) {
  if (customPool) return customPool;
  if (!defaultPool) {
    defaultPool = require('../config/db');
  }
  return defaultPool;
}

const DISPATCH_CUTOFF_HOUR_IST = 14;
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const RETURN_COOLING_DELAY_MS = 30 * 60 * 1000;

/**
 * Computes delivery estimate window based on Bhumivera's 14:00 IST dispatch cutoff rule.
 */
function computeDeliveryEstimate(orderDateInput = new Date(), status = 'pending', deliveredAt = null) {
  const normalizedStatus = String(status || 'pending').toLowerCase();
  if (normalizedStatus === 'delivered' && deliveredAt) {
    return `Delivered on ${new Date(deliveredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  if (['cancelled', 'returned'].includes(normalizedStatus)) {
    return `Order ${normalizedStatus}`;
  }

  const baseDate = orderDateInput ? new Date(orderDateInput) : new Date();
  const validDate = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;
  const istTime = new Date(validDate.getTime() + INDIA_OFFSET_MS);
  const beforeCutoff = istTime.getUTCHours() < DISPATCH_CUTOFF_HOUR_IST;

  const minDays = beforeCutoff ? 4 : 5;
  const maxDays = beforeCutoff ? 6 : 7;
  const earliest = new Date(validDate.getTime() + minDays * 86400000);
  const latest = new Date(validDate.getTime() + maxDays * 86400000);

  const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${fmt(earliest)} – ${fmt(latest)}`;
}

const parseJsonSafe = (val, fallback = null) => {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

const normalizePhoneDigits = phone => String(phone || '').replace(/\D/g, '').slice(-10);

/**
 * Verifies whether the caller (authenticated user or guest with matching email/phone)
 * is authorized to access or mutate a given order row.
 */
function isCallerAuthorizedForOrder(order, { user = null, email = null, phone = null, session = null } = {}) {
  if (!order) return false;
  if (user && ['admin', 'superadmin', 'support_agent'].includes(user.role)) return true;
  if (user?.id && Number(order.user_id) === Number(user.id)) return true;

  // Guest verification: requires matching email OR 10-digit phone number
  const candidateEmail = String(email || session?.guestEmail || '').trim().toLowerCase();
  const candidatePhone = normalizePhoneDigits(phone || session?.guestPhone || '');

  const orderEmail = String(order.user_email || '').trim().toLowerCase();
  const addressObj = parseJsonSafe(order.address_snapshot, {});
  const orderPhone = normalizePhoneDigits(order.user_phone || addressObj?.phone || addressObj?.mobile || '');

  if (candidateEmail && orderEmail && candidateEmail === orderEmail) return true;
  if (candidatePhone && candidatePhone.length === 10 && orderPhone && candidatePhone === orderPhone) return true;

  return false;
}

/**
 * Formats a raw database order row + items into a rich OrderCard object for the frontend widget.
 */
function buildOrderCard(order, items = [], returnInfo = null, returnPolicyDays = 7) {
  const status = String(order.status || 'pending').toLowerCase();
  const stepMap = { pending: 0, placed: 0, confirmed: 1, packed: 2, shipped: 3, delivered: 4 };
  const currentStep = stepMap[status] ?? 0;
  const cancellable = ['pending', 'confirmed'].includes(status);

  let canReturn = false;
  let returnEligibilityReason = null;
  if (status === 'delivered' && order.delivered_at) {
    const deliveredMs = new Date(order.delivered_at).getTime();
    const now = Date.now();
    const availableAt = deliveredMs + RETURN_COOLING_DELAY_MS;
    const expiresAt = deliveredMs + returnPolicyDays * 86400000;
    if (returnInfo && !['rejected', 'cancelled'].includes(returnInfo.status)) {
      returnEligibilityReason = `Return ${returnInfo.rma_number || `#${returnInfo.id}`} (${returnInfo.status.replace(/_/g, ' ')})`;
    } else if (now < availableAt) {
      returnEligibilityReason = 'Return window opens 30 minutes after delivery';
    } else if (now > expiresAt) {
      returnEligibilityReason = `${returnPolicyDays}-day return window has closed`;
    } else {
      canReturn = true;
    }
  }

  return {
    id: Number(order.id),
    orderNumber: order.order_number || String(order.id).padStart(9, '0'),
    status,
    currentStep,
    paymentMode: order.payment_mode || 'COD',
    paymentStatus: order.payment_status || 'pending',
    subtotal: Number(order.subtotal || order.total || 0),
    discount: Number(order.discount || 0),
    shippingCost: Number(order.shipping_cost || 0),
    total: Number(order.total || 0),
    trackingNumber: order.tracking_number || order.label_tracking_number || null,
    courier: order.courier || order.label_provider || null,
    serviceName: order.label_service_name || order.delivery_type || 'standard',
    deliveryEstimate: computeDeliveryEstimate(order.created_at, status, order.delivered_at),
    createdAt: order.created_at,
    deliveredAt: order.delivered_at || null,
    cancellable,
    canReturn,
    returnEligibilityReason,
    activeReturn: returnInfo
      ? {
          id: returnInfo.id,
          rmaNumber: returnInfo.rma_number,
          status: returnInfo.status,
          refundType: returnInfo.refund_type,
          refundAmount: returnInfo.refund_amount,
        }
      : null,
    items: (items || []).map(item => ({
      id: item.id,
      productId: item.product_id,
      name: item.name || item.product_name || 'Bhumivera Formulation',
      sku: item.sku || null,
      price: Number(item.price || 0),
      quantity: Number(item.quantity || 1),
      image: item.image || null,
      isGift: Boolean(item.is_gift),
    })),
  };
}

/**
 * Helper to fetch configured return_policy_days from settings table (default 7).
 */
async function getReturnPolicyDays(pool) {
  try {
    const [rows] = await pool.query("SELECT value FROM settings WHERE key_name = 'return_policy_days' LIMIT 1");
    const parsed = Number.parseInt(rows?.[0]?.value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 7;
  } catch {
    return 7;
  }
}

/**
 * TOOL 1: Real-time Order Lookup (`lookup_order`)
 * Queries MySQL for order status, tracking numbers, carrier details, delivery estimates, and items.
 */
async function lookupOrderTool(args = {}, context = {}) {
  const pool = getPool(context.pool);
  const { user, session } = context;
  const rawOrderRef = String(args.order_id || args.order_number || args.orderRef || '').trim().replace(/^#/, '');
  const email = String(args.email || user?.email || session?.guestEmail || '').trim().toLowerCase();
  const phone = String(args.phone || user?.phone || session?.guestPhone || '').trim();
  const returnDays = await getReturnPolicyDays(pool);

  // Case A: Specific order ID or 9-digit order_number requested
  if (rawOrderRef) {
    const isNineDigitRef = /^\d{9}$/.test(rawOrderRef);
    const numericId = /^\d+$/.test(rawOrderRef) ? Number(rawOrderRef) : null;

    const [orders] = await pool.query(
      `SELECT o.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
              sl.tracking_number AS label_tracking_number, sl.provider AS label_provider, sl.service_name AS label_service_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN shipping_labels sl ON sl.order_id = o.id AND sl.direction = 'forward' AND sl.status = 'booked'
       WHERE ${isNineDigitRef ? 'o.order_number = ? OR o.id = ?' : 'o.id = ? OR o.order_number = ?'}
       LIMIT 1`,
      [rawOrderRef, numericId || 0]
    );

    const order = orders?.[0];
    if (!order) {
      return {
        success: false,
        code: 'ORDER_NOT_FOUND',
        message: `We could not find an order matching reference #${rawOrderRef}. Please double-check your 9-digit order number or internal order ID.`,
        orderCards: [],
      };
    }

    if (!isCallerAuthorizedForOrder(order, { user, email, phone, session })) {
      return {
        success: false,
        code: 'VERIFICATION_REQUIRED',
        message: `To protect your privacy, please sign in or share the email address or 10-digit phone number used when placing Order #${order.order_number || order.id}.`,
        requiresVerification: true,
        orderCards: [],
      };
    }

    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [order.id]);
    const [returns] = await pool.query(
      'SELECT * FROM returns WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      [order.id]
    );
    const card = buildOrderCard(order, items, returns?.[0] || null, returnDays);
    return {
      success: true,
      code: 'ORDER_FOUND',
      order: card,
      orderCards: [card],
      message: `Order #${card.orderNumber} is currently ${card.status.toUpperCase()}.`,
    };
  }

  // Case B: Lookup recent orders for authenticated user or verified email/phone
  let orders = [];
  if (user?.id) {
    const [rows] = await pool.query(
      `SELECT o.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
              sl.tracking_number AS label_tracking_number, sl.provider AS label_provider, sl.service_name AS label_service_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN shipping_labels sl ON sl.order_id = o.id AND sl.direction = 'forward' AND sl.status = 'booked'
       WHERE o.user_id = ?
       ORDER BY o.created_at DESC
       LIMIT 5`,
      [user.id]
    );
    orders = rows || [];
  } else if (email || normalizePhoneDigits(phone).length === 10) {
    const cleanPhone = normalizePhoneDigits(phone);
    const [rows] = await pool.query(
      `SELECT o.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
              sl.tracking_number AS label_tracking_number, sl.provider AS label_provider, sl.service_name AS label_service_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN shipping_labels sl ON sl.order_id = o.id AND sl.direction = 'forward' AND sl.status = 'booked'
       WHERE (LOWER(u.email) = ? OR (? <> '' AND u.phone LIKE ?))
       ORDER BY o.created_at DESC
       LIMIT 5`,
      [email || '__none__', cleanPhone, `%${cleanPhone}`]
    );
    orders = rows || [];
  } else {
    return {
      success: false,
      code: 'ORDER_IDENTIFIER_REQUIRED',
      message: 'Please provide your Order Number (e.g., #123456789) along with your registered email or phone number, or sign in to view your orders automatically.',
      requiresVerification: true,
      orderCards: [],
    };
  }

  if (!orders.length) {
    return {
      success: true,
      code: 'NO_ORDERS_FOUND',
      message: 'No recent orders were found for your account.',
      orderCards: [],
    };
  }

  const cards = [];
  for (const ord of orders) {
    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [ord.id]);
    const [returns] = await pool.query('SELECT * FROM returns WHERE order_id = ? ORDER BY created_at DESC LIMIT 1', [ord.id]);
    cards.push(buildOrderCard(ord, items, returns?.[0] || null, returnDays));
  }

  return {
    success: true,
    code: 'ORDERS_LISTED',
    order: cards[0],
    orderCards: cards,
    message: `Found ${cards.length} recent order(s). Latest order #${cards[0].orderNumber} is ${cards[0].status.toUpperCase()}.`,
  };
}

/**
 * TOOL 2: Automated Order Cancellation (`cancel_order`)
 * Processes order cancellations if status permits ('pending' or 'confirmed'),
 * restocking inventory and handling online payment refund safeguards.
 */
async function cancelOrderTool(args = {}, context = {}) {
  const pool = getPool(context.pool);
  const { user, session } = context;
  const rawOrderRef = String(args.order_id || args.order_number || '').trim().replace(/^#/, '');
  const reason = String(args.reason || 'Cancelled via Bhumivera AI Support Assistant').trim().slice(0, 500);

  if (!rawOrderRef) {
    return {
      success: false,
      code: 'ORDER_ID_REQUIRED',
      message: 'Please specify which Order ID or 9-digit Order Number you would like to cancel.',
    };
  }

  const lookup = await lookupOrderTool(
    { order_id: rawOrderRef, email: args.email, phone: args.phone },
    context
  );
  if (!lookup.success || !lookup.order) {
    return lookup;
  }

  const targetOrder = lookup.order;
  const allowedStatuses = ['pending', 'confirmed'];
  if (!allowedStatuses.includes(targetOrder.status)) {
    return {
      success: false,
      code: 'ORDER_NOT_CANCELLABLE',
      message: `Order #${targetOrder.orderNumber} is already '${targetOrder.status}' and cannot be cancelled directly because fulfillment has progressed. ${
        targetOrder.status === 'delivered'
          ? 'However, you can initiate a return or replacement right here in chat!'
          : 'Once delivered, we can help you initiate a return within the return window.'
      }`,
      orderCards: [targetOrder],
    };
  }

  // Safeguard from models/orderModel.js: online paid orders require provider refund handling
  if (targetOrder.paymentMode === 'online' && targetOrder.paymentStatus === 'paid') {
    let ticketId = null;
    try {
      const [ticketRes] = await pool.query(
        `INSERT INTO support_tickets (user_id, order_id, name, email, subject, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [
          user?.id || session?.userId || null,
          targetOrder.id,
          user?.name || session?.guestName || 'Customer',
          user?.email || session?.guestEmail || 'customer@bhumivera.com',
          `[Priority Refund & Cancel] Order #${targetOrder.orderNumber}`,
          `Automated AI Support request to cancel paid online Order #${targetOrder.orderNumber} (ID: ${targetOrder.id}) and issue a Razorpay refund of ₹${targetOrder.total}. Reason: ${reason}`,
        ]
      );
      ticketId = ticketRes?.insertId || null;
    } catch (err) {
      console.error('[AI_CANCEL_ONLINE_TICKET_ERR]', err.message);
    }

    return {
      success: true,
      code: 'ONLINE_REFUND_CANCELLATION_QUEUED',
      ticketId,
      message: `Because Order #${targetOrder.orderNumber} (₹${targetOrder.total}) was paid online via Razorpay, our system safeguards your funds by reconciling the payment refund alongside cancellation. I have locked in Priority Cancellation & Refund Request ${ticketId ? `#${ticketId}` : ''} so your full refund of ₹${targetOrder.total} is processed back to your original payment method.`,
      orderCards: [targetOrder],
    };
  }

  // Execute transactional cancellation & stock restoration via orderModel or direct transaction
  try {
    let updated = false;
    if (typeof context.updateOrderStatusFn === 'function') {
      updated = await context.updateOrderStatusFn(targetOrder.id, 'cancelled', reason, {
        allowedCurrentStatuses: allowedStatuses,
      });
    } else {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [lockedRows] = await conn.query(
          'SELECT id, user_id, status, payment_mode, payment_status FROM orders WHERE id = ? FOR UPDATE',
          [targetOrder.id]
        );
        const locked = lockedRows?.[0];
        if (!locked || !allowedStatuses.includes(locked.status)) {
          await conn.rollback();
          return {
            success: false,
            code: 'ORDER_STATUS_CHANGED',
            message: `Order #${targetOrder.orderNumber} status changed to '${locked?.status || 'unknown'}' and can no longer be cancelled.`,
          };
        }
        const [items] = await conn.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [targetOrder.id]);
        for (const item of items || []) {
          if (item.product_id) {
            await conn.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [item.quantity, item.product_id]);
          }
        }
        await conn.query(
          "UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?",
          [reason, targetOrder.id]
        );
        await conn.commit();
        updated = true;
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }
    }

    if (!updated) {
      return {
        success: false,
        code: 'CANCEL_FAILED',
        message: `Could not cancel Order #${targetOrder.orderNumber}.`,
      };
    }

    const updatedCard = { ...targetOrder, status: 'cancelled', cancellable: false };
    return {
      success: true,
      code: 'ORDER_CANCELLED',
      order: updatedCard,
      orderCards: [updatedCard],
      message: `Order #${targetOrder.orderNumber} has been cancelled and reserved stock has been released.`,
    };
  } catch (error) {
    return {
      success: false,
      code: error.code || 'CANCEL_ERROR',
      message: error.message || 'An error occurred while cancelling the order.',
    };
  }
}

/**
 * TOOL 3: Automated Return & Replacement Initiation (`initiate_return`)
 * Validates delivery window and creates an RMA record in `returns`.
 */
async function initiateReturnTool(args = {}, context = {}) {
  const pool = getPool(context.pool);
  const rawOrderRef = String(args.order_id || args.order_number || '').trim().replace(/^#/, '');
  const reason = String(args.reason || 'Product issue reported via AI Concierge').trim().slice(0, 255);
  const description = String(args.description || args.notes || reason).trim().slice(0, 2000);
  const requestedType = String(args.resolution_type || args.refund_type || 'refund').toLowerCase();
  const refundType = requestedType === 'exchange' || requestedType === 'replacement' ? 'replacement' : 'refund';
  const refundMethod = refundType === 'replacement'
    ? 'replacement'
    : (['wallet', 'original'].includes(args.refund_method) ? args.refund_method : 'original');
  const imageUrls = Array.isArray(args.image_urls) ? args.image_urls.slice(0, 5) : [];

  if (!rawOrderRef) {
    return {
      success: false,
      code: 'ORDER_ID_REQUIRED',
      message: 'Please provide the Order ID or 9-digit Order Number for the delivered order you want to return or replace.',
    };
  }

  const lookup = await lookupOrderTool(
    { order_id: rawOrderRef, email: args.email, phone: args.phone },
    context
  );
  if (!lookup.success || !lookup.order) {
    return lookup;
  }

  const order = lookup.order;
  if (order.status !== 'delivered') {
    return {
      success: false,
      code: 'ORDER_NOT_DELIVERED',
      message: `Only delivered orders can be submitted for a return or replacement. Order #${order.orderNumber} is currently '${order.status}'. ${
        order.cancellable ? 'Would you like me to cancel this order instead?' : ''
      }`,
      orderCards: [order],
    };
  }

  const returnDays = await getReturnPolicyDays(pool);
  if (order.deliveredAt) {
    const deliveredMs = new Date(order.deliveredAt).getTime();
    const now = Date.now();
    if (now < deliveredMs + RETURN_COOLING_DELAY_MS) {
      return {
        success: false,
        code: 'RETURN_WINDOW_NOT_OPEN',
        message: `The self-service return/replacement window opens 30 minutes after delivery confirmation for Order #${order.orderNumber}.`,
        orderCards: [order],
      };
    }
    if (now > deliveredMs + returnDays * 86400000) {
      return {
        success: false,
        code: 'RETURN_WINDOW_CLOSED',
        message: `The ${returnDays}-day return window for Order #${order.orderNumber} has ended. I can connect you with a human support specialist if you need an exception review.`,
        orderCards: [order],
      };
    }
  }

  // Check for existing active return
  const [existingReturns] = await pool.query(
    "SELECT id, rma_number, status, refund_type FROM returns WHERE order_id = ? AND status NOT IN ('rejected', 'cancelled') LIMIT 1",
    [order.id]
  );
  if (existingReturns?.length) {
    const existing = existingReturns[0];
    return {
      success: false,
      code: 'ALREADY_RETURNED',
      returnId: existing.id,
      rmaNumber: existing.rma_number,
      message: `An active ${existing.refund_type || 'return'} request (${existing.rma_number || `#${existing.id}`}) is already in progress for Order #${order.orderNumber} with status '${existing.status.replace(/_/g, ' ')}'.`,
      orderCards: [order],
    };
  }

  const selectedItems = (order.items || []).map(item => ({
    order_item_id: item.id,
    product_id: item.productId,
    name: item.name,
    sku: item.sku,
    price: item.price,
    quantity: item.quantity,
    image: item.image,
  }));

  const rmaNumber = `RMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const [ orderUserRow ] = await pool.query('SELECT user_id FROM orders WHERE id = ? LIMIT 1', [order.id]);
  const ownerUserId = orderUserRow?.[0]?.user_id || context.user?.id || 0;

  const [insertRes] = await pool.query(
    `INSERT INTO returns
      (order_id, user_id, reason, description, refund_type, refund_method, items, rma_number, image_urls, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_admin_review')`,
    [
      order.id,
      ownerUserId,
      reason,
      description,
      refundType,
      refundMethod,
      JSON.stringify(selectedItems),
      rmaNumber,
      JSON.stringify(imageUrls),
    ]
  );

  const updatedOrderCard = {
    ...order,
    canReturn: false,
    activeReturn: {
      id: insertRes.insertId,
      rmaNumber,
      status: 'pending_admin_review',
      refundType,
      refundAmount: order.total,
    },
  };

  return {
    success: true,
    code: 'RETURN_INITIATED',
    returnId: insertRes.insertId,
    rmaNumber,
    resolutionType: refundType,
    refundMethod,
    status: 'pending_admin_review',
    orderCards: [updatedOrderCard],
    message: `${refundType === 'replacement' ? 'Replacement' : 'Return'} request ${rmaNumber} has been submitted for Order #${order.orderNumber} (${selectedItems.length} item(s)). Our quality assurance team will review it and arrange reverse pickup within 24–48 hours.`,
  };
}

/**
 * TOOL 4: Automated Refund & RMA Status Check (`check_refund_status`)
 * Queries `returns` and `return_refund_requests` for live provider refund status.
 */
async function checkRefundStatusTool(args = {}, context = {}) {
  const pool = getPool(context.pool);
  const { user, session } = context;
  const rawOrderRef = String(args.order_id || args.order_number || '').trim().replace(/^#/, '');
  const rmaNumber = String(args.rma_number || '').trim().toUpperCase();

  let whereClause = '';
  let params = [];

  if (rmaNumber) {
    whereClause = 'WHERE r.rma_number = ?';
    params = [rmaNumber];
  } else if (rawOrderRef) {
    whereClause = 'WHERE (o.order_number = ? OR o.id = ?)';
    params = [rawOrderRef, /^\d+$/.test(rawOrderRef) ? Number(rawOrderRef) : 0];
  } else if (user?.id) {
    whereClause = 'WHERE r.user_id = ?';
    params = [user.id];
  } else {
    return {
      success: false,
      code: 'REFUND_LOOKUP_IDENTIFIER_REQUIRED',
      message: 'Please share your RMA number (e.g., RMA-1A2B3C4D) or Order Number so I can check your live refund status.',
    };
  }

  const [rows] = await pool.query(
    `SELECT r.*, o.order_number, o.total AS order_total, o.payment_mode, o.payment_status,
            o.user_id, o.address_snapshot, u.email AS user_email, u.phone AS user_phone,
            rr.receipt AS refund_receipt, rr.provider_refund_id, rr.amount_paise, rr.status AS provider_refund_status, rr.updated_at AS refund_updated_at
     FROM returns r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN return_refund_requests rr ON rr.id = (
       SELECT MAX(rr2.id) FROM return_refund_requests rr2 WHERE rr2.return_id = r.id
     )
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT 5`,
    params
  );

  if (!rows || rows.length === 0) {
    return {
      success: true,
      code: 'NO_RETURN_FOUND',
      refunds: [],
      message: 'No return or refund requests were found matching that reference.',
    };
  }

  // Authorize caller against the first matching order
  if (!isCallerAuthorizedForOrder(rows[0], { user, email: args.email, phone: args.phone, session })) {
    return {
      success: false,
      code: 'VERIFICATION_REQUIRED',
      requiresVerification: true,
      message: 'Please sign in or confirm the email address or phone number associated with this order to view refund details.',
    };
  }

  const refunds = rows.map(r => {
    const amountInr = r.amount_paise
      ? Number(r.amount_paise) / 100
      : Number(r.refund_amount || r.order_total || 0);
    return {
      returnId: r.id,
      rmaNumber: r.rma_number || `RMA-${r.id}`,
      orderId: r.order_id,
      orderNumber: r.order_number || String(r.order_id).padStart(9, '0'),
      returnStatus: r.status,
      refundType: r.refund_type || 'refund',
      refundMethod: r.refund_method || 'original',
      amountInr,
      providerRefundStatus: r.provider_refund_status || null,
      providerRefundId: r.provider_refund_id || null,
      refundReceipt: r.refund_receipt || null,
      createdAt: r.created_at,
      updatedAt: r.refund_updated_at || r.updated_at,
      estimatedSettlement:
        r.status === 'refunded' || r.provider_refund_status === 'processed'
          ? 'Processed by Razorpay — reflects in bank/original source within 3–5 business days'
          : r.status === 'refund_pending' || r.provider_refund_status === 'pending'
          ? 'Accepted by payment gateway — settlement in progress (5–7 business days)'
          : r.status === 'replacement_sent'
          ? 'Replacement order has been dispatched'
          : 'Awaiting warehouse return inspection before refund initiation',
    };
  });

  const latest = refunds[0];
  return {
    success: true,
    code: 'REFUND_STATUS_FOUND',
    refunds,
    latestRefund: latest,
    message: `RMA ${latest.rmaNumber} for Order #${latest.orderNumber}: status is '${latest.returnStatus.replace(/_/g, ' ')}' (${latest.estimatedSettlement}).`,
  };
}

/**
 * TOOL 5: Inventory, Botanical Catalog & Shipping Policy Querying (`query_inventory_catalog`)
 * Queries real-time stock levels, SKU variants, product specifications/usage guides, and shipping rules.
 */
async function queryInventoryCatalogTool(args = {}, context = {}) {
  const pool = getPool(context.pool);
  const query = String(args.query || args.product_name || '').trim();
  const sku = String(args.sku || '').trim();
  const productId = args.product_id ? Number(args.product_id) : null;

  // Fetch shipping policy & store settings
  let shippingPolicy = {
    freeShippingThresholdInr: 500,
    standardShippingChargeInr: 50,
    expressShippingChargeInr: 150,
    expressSurchargeBelow799Inr: 100,
    expressThresholdInr: 799,
    dispatchCutoffIst: '14:00 IST (2:00 PM)',
    estimatedDeliveryBeforeCutoff: '4–6 calendar days',
    estimatedDeliveryAfterCutoff: '5–7 calendar days',
    returnWindowDays: 7,
  };

  try {
    const [settingsRows] = await pool.query(
      "SELECT key_name, value FROM settings WHERE key_name IN ('free_shipping_threshold', 'standard_charge', 'express_charge', 'return_policy_days')"
    );
    const map = Object.fromEntries((settingsRows || []).map(r => [r.key_name, r.value]));
    const freeThreshold = Number(map.free_shipping_threshold) || 500;
    const stdCharge = Number(map.standard_charge) || 50;
    const expCharge = Number(map.express_charge) || 150;
    const retDays = Number(map.return_policy_days) || 7;

    shippingPolicy = {
      ...shippingPolicy,
      freeShippingThresholdInr: freeThreshold,
      standardShippingChargeInr: stdCharge,
      expressShippingChargeInr: expCharge,
      returnWindowDays: retDays,
      sampleStandardBelow500: calculateShippingCost({
        deliveryType: 'standard',
        cartSubtotal: 350,
        standardCharge: stdCharge,
        premiumCharge: expCharge,
        freeShippingThreshold: freeThreshold,
      }),
      sampleStandardAbove500: calculateShippingCost({
        deliveryType: 'standard',
        cartSubtotal: freeThreshold,
        standardCharge: stdCharge,
        premiumCharge: expCharge,
        freeShippingThreshold: freeThreshold,
      }),
    };
  } catch {
    // Fallback to defaults if settings table query fails
  }

  let products = [];
  if (productId || sku || query) {
    const clauses = ["p.status = 'active'"];
    const params = [];
    if (productId) {
      clauses.push('p.id = ?');
      params.push(productId);
    } else if (sku) {
      clauses.push('LOWER(p.sku) = LOWER(?)');
      params.push(sku);
    } else if (query) {
      const term = `%${query}%`;
      clauses.push('(p.name LIKE ? OR p.sku LIKE ? OR p.tags LIKE ? OR p.description LIKE ? OR c.name LIKE ?)');
      params.push(term, term, term, term, term);
    }

    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.slug, p.sku, p.brand, p.description, p.price, p.discount_price,
              p.quantity, p.status, p.rating, p.review_count, p.warranty_period, p.tags, p.specifications,
              c.name AS category_name, sc.name AS subcategory_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.is_featured DESC, p.rating DESC, p.quantity DESC
       LIMIT 6`,
      params
    );
    products = rows || [];
  } else {
    // Return top featured / in-stock products if no filter specified
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.slug, p.sku, p.brand, p.description, p.price, p.discount_price,
              p.quantity, p.status, p.rating, p.review_count, p.warranty_period, p.tags, p.specifications,
              c.name AS category_name, sc.name AS subcategory_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
       WHERE p.status = 'active'
       ORDER BY p.is_featured DESC, p.quantity DESC
       LIMIT 5`
    );
    products = rows || [];
  }

  const catalogItems = products.map(p => {
    const specs = parseJsonSafe(p.specifications, {});
    const qty = Number(p.quantity || 0);
    const effectivePrice = p.discount_price && Number(p.discount_price) > 0 ? Number(p.discount_price) : Number(p.price);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      sku: p.sku,
      brand: p.brand || 'Bhumivera',
      category: p.category_name || 'Botanical Care',
      subcategory: p.subcategory_name || null,
      price: Number(p.price),
      discountPrice: p.discount_price ? Number(p.discount_price) : null,
      effectivePrice,
      stockQuantity: qty,
      stockStatus: qty <= 0 ? 'out_of_stock' : qty <= 5 ? 'low_stock' : 'in_stock',
      rating: Number(p.rating || 0),
      reviewCount: Number(p.review_count || 0),
      description: p.description || '',
      ingredients: specs?.ingredients || specs?.key_ingredients || null,
      usageGuide: specs?.how_to_use || specs?.usage || specs?.directions || null,
      specifications: specs,
      productUrl: p.slug ? `/product/${p.slug}` : `/product/${p.id}`,
    };
  });

  return {
    success: true,
    code: 'CATALOG_AND_POLICY_RESULT',
    products: catalogItems,
    shippingPolicy,
    message: catalogItems.length
      ? `Found ${catalogItems.length} matching product(s) in the live catalog.`
      : 'No exact product match found in the active catalog, but shipping and return policies are attached.',
  };
}

/**
 * Registry of all agentic tools exposed to the LLM Orchestrator.
 */
const SUPPORT_TOOLS_REGISTRY = Object.freeze({
  lookup_order: {
    name: 'lookup_order',
    description: 'Look up real-time order status, 9-digit order number, tracking number, courier, delivery estimate, and items using order_id/order_number, email, phone, or authenticated session.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'STRING', description: 'Order number (9 digits) or numeric order ID' },
        email: { type: 'STRING', description: 'Customer email address for verification' },
        phone: { type: 'STRING', description: 'Customer 10-digit phone number for verification' },
      },
    },
    execute: lookupOrderTool,
  },
  cancel_order: {
    name: 'cancel_order',
    description: 'Cancel a customer order if its status is pending or confirmed, restocking inventory and handling online payment refund safeguards.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'STRING', description: 'Order number or ID to cancel' },
        reason: { type: 'STRING', description: 'Customer reason for cancellation' },
        email: { type: 'STRING', description: 'Verification email if guest' },
        phone: { type: 'STRING', description: 'Verification phone if guest' },
      },
      required: ['order_id'],
    },
    execute: cancelOrderTool,
  },
  initiate_return: {
    name: 'initiate_return',
    description: 'Initiate an automated item return or replacement request for a delivered order within the return window and generate an RMA number.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'STRING', description: 'Delivered order number or ID' },
        reason: { type: 'STRING', description: 'Reason for return or replacement (e.g., damaged item, wrong item)' },
        resolution_type: { type: 'STRING', description: 'Either "refund" or "replacement"' },
        refund_method: { type: 'STRING', description: 'Either "original", "wallet", or "replacement"' },
        description: { type: 'STRING', description: 'Detailed customer notes' },
      },
      required: ['order_id', 'reason'],
    },
    execute: initiateReturnTool,
  },
  check_refund_status: {
    name: 'check_refund_status',
    description: 'Check real-time status of an RMA return, replacement, or Razorpay refund receipt.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'STRING', description: 'Order number or ID' },
        rma_number: { type: 'STRING', description: 'RMA reference (e.g., RMA-1A2B3C4D)' },
      },
    },
    execute: checkRefundStatusTool,
  },
  query_inventory_catalog: {
    name: 'query_inventory_catalog',
    description: 'Query real-time product stock levels, SKU variants, prices, botanical ingredients/usage guides, and shipping/return policy rules.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Product name, keyword, or ingredient to search' },
        sku: { type: 'STRING', description: 'Exact SKU code' },
        product_id: { type: 'NUMBER', description: 'Numeric product ID' },
      },
    },
    execute: queryInventoryCatalogTool,
  },
});

async function executeSupportTool(toolName, args = {}, context = {}) {
  const tool = SUPPORT_TOOLS_REGISTRY[toolName];
  if (!tool) {
    return {
      success: false,
      code: 'UNKNOWN_TOOL',
      message: `Tool '${toolName}' is not registered.`,
    };
  }
  try {
    return await tool.execute(args || {}, context);
  } catch (error) {
    console.error(`[AI_SUPPORT_TOOL_ERROR] tool=${toolName}`, error);
    return {
      success: false,
      code: 'TOOL_EXECUTION_ERROR',
      message: 'We encountered a temporary database issue while running that lookup. Please try again in a moment.',
    };
  }
}

module.exports = {
  SUPPORT_TOOLS_REGISTRY,
  executeSupportTool,
  lookupOrderTool,
  cancelOrderTool,
  initiateReturnTool,
  checkRefundStatusTool,
  queryInventoryCatalogTool,
  computeDeliveryEstimate,
  buildOrderCard,
};
