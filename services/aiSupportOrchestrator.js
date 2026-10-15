'use strict';

const { executeSupportTool } = require('./aiSupportTools');
const { analyzeSentiment, triggerInstantEscalation } = require('./sentimentEscalationEngine');
const {
  VALID_CHAT_STATUSES,
  createOrResumeSession,
  appendMessage,
  getSessionMessages,
  updateSessionTelemetry,
  getAiSupportFeatureConfig,
} = require('../models/aiSupportModel');
const { maskPII } = require('../utils/piiMasker');

const DEFAULT_QUICK_ACTIONS = [
  { id: 'track_order', label: 'Where is my order?', prompt: 'Where is my order?' },
  { id: 'initiate_return', label: 'Initiate Return / Replace', prompt: 'I want to initiate a return or replacement for my delivered order.' },
  { id: 'cancel_order', label: 'Cancel an Order', prompt: 'I need help cancelling my recent order.' },
  { id: 'refund_status', label: 'Check Refund / RMA', prompt: 'What is my current refund or RMA status?' },
  { id: 'wallet_loyalty', label: 'My Wallet & Loyalty', prompt: 'What is my current wallet balance and loyalty points?' },
  { id: 'active_coupons', label: 'Available Coupons', prompt: 'Show me active coupons and offers for my account.' },
  { id: 'shipping_policy', label: 'Shipping & Policy', prompt: 'What are your shipping charges and delivery timelines?' },
  { id: 'talk_to_human', label: 'Talk to Human Concierge', prompt: 'Please connect me with a human support agent.' },
];

/**
 * Generates contextual proactive greeting or assistance nudge based on current page / behavior.
 */
function buildContextualGreeting({ user = null, pageContext = {} } = {}) {
  const firstName = user?.name ? user.name.split(' ')[0] : null;
  const path = String(pageContext?.pathname || pageContext?.path || '/');
  const triggerType = pageContext?.proactiveTrigger || null;

  if (triggerType === 'rage_click') {
    return {
      greeting: `${firstName ? `Hi ${firstName}, ` : 'Hi there — '}I noticed something on this page might not be responding as expected. Can I help you complete your action, check an order, or connect you with our team right away?`,
      quickActions: [
        { id: 'checkout_help', label: 'Help with Checkout', prompt: 'I am having trouble completing my action on this page.' },
        { id: 'track_order', label: 'Where is my order?', prompt: 'Where is my order?' },
        { id: 'talk_to_human', label: 'Talk to Human Concierge', prompt: 'Please connect me with a human support agent.' },
      ],
    };
  }

  if (path.startsWith('/checkout') || triggerType === 'checkout_linger') {
    return {
      greeting: `${firstName ? `Hi ${firstName}! ` : 'Welcome to Bhumivera Concierge! '}Need a hand with checkout? Standard shipping is free on orders ₹500+, and orders placed before 2:00 PM IST dispatch the same day.`,
      quickActions: [
        { id: 'active_coupons', label: 'Available Coupons', prompt: 'Show me active coupons and offers for my account.' },
        { id: 'wallet_loyalty', label: 'Check Wallet & Points', prompt: 'What is my current wallet balance and loyalty points?' },
        { id: 'shipping_policy', label: 'Delivery Timelines & Cutoff', prompt: 'When will my order arrive if I place it today?' },
        { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
      ],
    };
  }

  if (path.startsWith('/order-tracking') || triggerType === 'tracking_linger') {
    return {
      greeting: `${firstName ? `Welcome back, ${firstName}! ` : 'Hello! '}Looking for live tracking updates on a Bhumivera order? Share your 9-digit order number or tap below to inspect your latest shipment.`,
      quickActions: [
        { id: 'track_order', label: 'Check My Latest Order', prompt: 'Where is my order?' },
        { id: 'initiate_return', label: 'Initiate Return / Exchange', prompt: 'I want to return or replace a delivered order.' },
        { id: 'refund_status', label: 'Check Refund Status', prompt: 'What is my current refund status?' },
        { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
      ],
    };
  }

  if (path.startsWith('/returns') || triggerType === 'returns_linger') {
    return {
      greeting: `${firstName ? `Hi ${firstName}, ` : 'Hello! '}I can check your return eligibility, generate an instant RMA for delivered orders, or look up your Razorpay refund receipt right here.`,
      quickActions: [
        { id: 'initiate_return', label: 'Initiate Return', prompt: 'I want to initiate a return for my delivered order.' },
        { id: 'refund_status', label: 'Check Refund Status', prompt: 'What is my current refund status?' },
        { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
      ],
    };
  }

  return {
    greeting: `${firstName ? `Namaste ${firstName}! ` : 'Namaste! '}I'm your Bhumivera 20X AI Support Concierge. I can track orders in real time, process self-service cancellations or returns, check Razorpay refund receipts, inspect your Wallet & Loyalty points, or manage this chat's status (Active, Pending, Waiting for Review, Escalated, Resolved, Closed).`,
    quickActions: DEFAULT_QUICK_ACTIONS,
  };
}

/**
 * Deterministic Multi-Intent & Entity Planner for Autonomous Tool Routing.
 * Supports executing multiple tools in a single turn when a customer asks a compound question!
 */
function detectIntentAndToolPlan(message, pageContext = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  const rmaMatch = text.match(/\b(RMA-[A-Z0-9]{6,12})\b/i);
  const nineDigitMatch = text.match(/\b(\d{9})\b/);
  const hashOrderMatch = text.match(/(?:order\s*(?:id|no|number|#)?\s*[:#-]?\s*|#)(\d{1,9})\b/i);
  const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  const phoneMatch = text.match(/\b(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
  const serialMatch = text.match(/\b(BV-[A-Z0-9-]{5,24}|SER-[A-Z0-9-]{5,24})\b/i);

  const extractedOrderId = nineDigitMatch?.[1] || hashOrderMatch?.[1] || pageContext?.activeOrderId || null;
  const extractedRma = rmaMatch?.[1]?.toUpperCase() || null;
  const extractedEmail = emailMatch?.[1]?.toLowerCase() || null;
  const extractedPhone = phoneMatch?.[1] || null;
  const extractedSerial = serialMatch?.[1]?.toUpperCase() || null;

  // Chat status transitions (pending, waiting_for_review, resolved, closed) are controlled strictly by Customer Support Staff
  const requestedChatStatus = null;

  const toolCalls = [];
  let primaryIntent = 'general_concierge';

  // 1. Refund status check intent
  if (
    extractedRma ||
    /\b(refund\s*status|where\s*is\s*my\s*refund|rma\s*status|check\s*refund|refund\s*receipt|when\s*will\s*i\s*get\s*my\s*refund)\b/i.test(lower)
  ) {
    toolCalls.push({
      name: 'check_refund_status',
      args: {
        order_id: extractedOrderId || undefined,
        rma_number: extractedRma || undefined,
        email: extractedEmail || undefined,
        phone: extractedPhone || undefined,
      },
    });
    primaryIntent = 'refund_status';
  }

  // 2. Order cancellation intent
  if (/\b(cancel\s*(?:my\s*|the\s*|this\s*)?order|want\s*to\s*cancel|abort\s*order|stop\s*shipment)\b/i.test(lower)) {
    toolCalls.push({
      name: 'cancel_order',
      args: {
        order_id: extractedOrderId || undefined,
        reason: text.slice(0, 300),
        email: extractedEmail || undefined,
        phone: extractedPhone || undefined,
      },
    });
    primaryIntent = 'cancel_order';
  }

  // 3. Return or replacement / exchange initiation intent
  if (
    !toolCalls.some(t => t.name === 'cancel_order') &&
    /\b(initiate\s*(?:a\s*)?return|return\s*(?:my\s*|this\s*|the\s*)?(?:order|item|product)|replace\s*(?:my\s*|this\s*)?(?:order|item|product)|replacement|exchange|received\s*(?:damaged|broken|leaking|wrong))\b/i.test(lower)
  ) {
    const isReplacement = /\b(replace|replacement|exchange)\b/i.test(lower);
    toolCalls.push({
      name: 'initiate_return',
      args: {
        order_id: extractedOrderId || undefined,
        reason: text.slice(0, 200),
        resolution_type: isReplacement ? 'replacement' : 'refund',
        refund_method: isReplacement ? 'replacement' : (/wallet/i.test(lower) ? 'wallet' : 'original'),
        email: extractedEmail || undefined,
        phone: extractedPhone || undefined,
      },
    });
    primaryIntent = 'initiate_return';
  }

  // 4. Order tracking / status lookup intent
  if (
    (!toolCalls.length && extractedOrderId && !/\b(price|stock|ingredient)\b/i.test(lower)) ||
    /\b(where\s*is\s*my\s*order|track\s*(?:my\s*)?order|order\s*status|delivery\s*status|shipment|tracking\s*number|when\s*will\s*(?:my\s*order|it)\s*(?:arrive|be\s*delivered)|my\s*orders|recent\s*order)\b/i.test(lower)
  ) {
    if (!toolCalls.some(t => ['cancel_order', 'initiate_return'].includes(t.name))) {
      toolCalls.push({
        name: 'lookup_order',
        args: {
          order_id: extractedOrderId || undefined,
          email: extractedEmail || undefined,
          phone: extractedPhone || undefined,
        },
      });
      if (primaryIntent === 'general_concierge') primaryIntent = 'lookup_order';
    }
  }

  // 5. Wallet, Referral Wallet & Loyalty Points intent
  if (/\b(wallet\s*balance|my\s*wallet|referral\s*(?:wallet|balance|code|reward)|loyalty\s*(?:points|tier|balance)|how\s*many\s*points)\b/i.test(lower)) {
    toolCalls.push({
      name: 'lookup_account_wallet_loyalty',
      args: { email: extractedEmail || undefined },
    });
    if (primaryIntent === 'general_concierge') primaryIntent = 'wallet_loyalty';
  }

  // 6. Coupons, Offers & Promo Codes intent
  if (/\b(coupons?|promo\s*codes?|discount\s*codes?|offers?|spin\s*rewards?|available\s*deals?)\b/i.test(lower)) {
    toolCalls.push({
      name: 'lookup_coupons_and_offers',
      args: {},
    });
    if (primaryIntent === 'general_concierge') primaryIntent = 'coupons_offers';
  }

  // 7. Warranty & Serial Authenticity intent
  if (extractedSerial || /\b(warranty|e-warranty|serial\s*number|authentic|genuine\s*check|verify\s*serial)\b/i.test(lower)) {
    toolCalls.push({
      name: 'lookup_warranty_and_serial',
      args: { serial: extractedSerial || undefined },
    });
    if (primaryIntent === 'general_concierge') primaryIntent = 'warranty_serial';
  }

  // 8. Product catalog / stock / ingredients / shipping policy intent
  if (
    /\b(in\s*stock|out\s*of\s*stock|available|price|cost|sku|ingredient|how\s*to\s*use|usage|routine|shipping\s*(?:policy|charge|fee|cost|time)|delivery\s*(?:charge|time|policy)|free\s*shipping|return\s*policy|cod|cash\s*on\s*delivery|serums?|cleansers?|oils?|creams?|toners?|botanical|elixirs?)\b/i.test(lower)
  ) {
    const cleanedQuery = text
      .replace(/\b(is|are|the|in|stock|available|what|price|of|for|how|to|use|ingredients?|shipping|policy|charges?|delivery|tell|me|about|do|you|have|show|me)\b/gi, ' ')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    toolCalls.push({
      name: 'query_inventory_catalog',
      args: {
        query: cleanedQuery.length >= 2 ? cleanedQuery.slice(0, 60) : '',
      },
    });
    if (primaryIntent === 'general_concierge') primaryIntent = 'catalog_or_policy';
  }

  return {
    intent: primaryIntent,
    toolCalls,
    requestedChatStatus,
    extractedOrderId,
    extractedEmail,
    extractedPhone,
  };
}

/**
 * Synthesizes an empathetic, 100% grounded markdown response from all executed tool results,
 * sentiment state, chat status transitions, and escalation outcomes.
 */
function synthesizeDeterministicResponse({
  userMessage,
  toolResults = [],
  sentiment = {},
  escalation = null,
  statusUpdatedTo = null,
  user = null,
}) {
  const firstName = user?.name ? user.name.split(' ')[0] : null;
  const empathyPrefix = sentiment?.frustrationScore >= 40
    ? `I completely understand how frustrating this is${firstName ? `, ${firstName}` : ''}, and I'm on it right away. `
    : '';

  const orderCards = [];
  let quickActions = [...DEFAULT_QUICK_ACTIONS];
  const sections = [];

  for (const tr of toolResults) {
    const res = tr.result || {};
    if (Array.isArray(res.orderCards) && res.orderCards.length) {
      for (const card of res.orderCards) {
        if (!orderCards.some(existing => existing.id === card.id)) {
          orderCards.push(card);
        }
      }
    }

    if (tr.name === 'lookup_order') {
      if (res.code === 'ORDER_FOUND' && res.order) {
        const o = res.order;
        const trackingLine = o.trackingNumber
          ? `\n- **Courier & Tracking:** ${o.courier ? `${o.courier} — ` : ''}\`${o.trackingNumber}\``
          : '\n- **Tracking Number:** Assigned upon dispatch';
        const itemsLine = (o.items || []).length
          ? `\n- **Items (${o.items.length}):** ${o.items.map(i => `${i.quantity}× ${i.name} (₹${i.price})`).join(', ')}`
          : '';
        sections.push(
          `${empathyPrefix}Here are the 100% verified live details for **Order #${o.orderNumber}**:\n` +
          `- **Status:** \`${o.status.toUpperCase()}\` (${o.paymentMode} · Payment: ${o.paymentStatus})\n` +
          `- **Total Paid/Payable:** ₹${o.total.toLocaleString('en-IN')} (Subtotal: ₹${o.subtotal.toLocaleString('en-IN')}${o.discount > 0 ? ` · Discount: -₹${o.discount}` : ''})\n` +
          `- **Estimated Delivery:** ${o.deliveryEstimate}${trackingLine}${itemsLine}`
        );
        quickActions = [
          ...(o.cancellable ? [{ id: `cancel_${o.id}`, label: `Cancel Order #${o.orderNumber}`, prompt: `Cancel my order #${o.orderNumber}` }] : []),
          ...(o.canReturn ? [
            { id: `return_${o.id}`, label: `Return Order #${o.orderNumber}`, prompt: `Initiate return for order #${o.orderNumber}` },
            { id: `replace_${o.id}`, label: `Replace Order #${o.orderNumber}`, prompt: `Request replacement for order #${o.orderNumber}` },
          ] : []),
          { id: 'mark_resolved', label: 'Mark Chat Resolved', prompt: 'Mark this chat as resolved' },
          { id: 'talk_to_human', label: 'Talk to Human Concierge', prompt: 'Please connect me with a human support agent.' },
        ];
      } else if (res.code === 'ORDERS_LISTED' && res.orderCards?.length) {
        const latest = res.orderCards[0];
        sections.push(
          `${empathyPrefix}I found **${res.orderCards.length}** recent order(s) on your account. Your latest purchase **Order #${latest.orderNumber}** (₹${latest.total.toLocaleString('en-IN')}) is currently **${latest.status.toUpperCase()}** with estimated delivery **${latest.deliveryEstimate}**.`
        );
        quickActions = [
          ...(latest.cancellable ? [{ id: `cancel_${latest.id}`, label: `Cancel #${latest.orderNumber}`, prompt: `Cancel order #${latest.orderNumber}` }] : []),
          ...(latest.canReturn ? [{ id: `return_${latest.id}`, label: `Return #${latest.orderNumber}`, prompt: `Initiate return for order #${latest.orderNumber}` }] : []),
          { id: 'refund_status', label: 'Check Refund Status', prompt: 'What is my current refund status?' },
          { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
        ];
      } else {
        sections.push(`${empathyPrefix}${res.message}`);
        quickActions = [
          { id: 'provide_order', label: 'How to find my Order ID?', prompt: 'Where can I find my 9-digit Bhumivera order number?' },
          { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
        ];
      }
    } else if (tr.name === 'cancel_order') {
      sections.push(`${empathyPrefix}${res.message}`);
      quickActions = [
        { id: 'track_order', label: 'View My Orders', prompt: 'Where is my order?' },
        { id: 'refund_status', label: 'Check Refund Status', prompt: 'What is my current refund status?' },
        { id: 'mark_resolved', label: 'Mark Chat Resolved', prompt: 'Mark this chat as resolved' },
      ];
    } else if (tr.name === 'initiate_return') {
      sections.push(`${empathyPrefix}${res.message}`);
      if (res.rmaNumber) {
        sections.push(
          `**Next Steps for ${res.rmaNumber}:**\n` +
          `1. Keep the item in its original packaging with batch/serial labels intact.\n` +
          `2. You can attach photos of the item directly in this chat using the camera/attachment button.\n` +
          `3. Track your RMA anytime by asking *"Check status of ${res.rmaNumber}"*.`
        );
      }
      quickActions = [
        ...(res.rmaNumber ? [{ id: `check_${res.rmaNumber}`, label: `Track ${res.rmaNumber}`, prompt: `Check refund status for ${res.rmaNumber}` }] : []),
        { id: 'mark_waiting_review', label: 'Request Supervisor Review', prompt: 'Mark this chat as waiting for review' },
        { id: 'talk_to_human', label: 'Talk to Human Concierge', prompt: 'Please connect me with a human support agent.' },
      ];
    } else if (tr.name === 'check_refund_status') {
      if (res.refunds?.length) {
        const lines = res.refunds.map(
          r => `- **${r.rmaNumber}** (Order #${r.orderNumber} · ₹${Number(r.amountInr).toLocaleString('en-IN')}): **${r.returnStatus.replace(/_/g, ' ').toUpperCase()}**${r.refundReceipt ? ` · Receipt \`${r.refundReceipt}\`` : ''} — *${r.estimatedSettlement}*`
        );
        sections.push(`${empathyPrefix}Here is your live return & refund ledger:\n${lines.join('\n')}`);
      } else {
        sections.push(`${empathyPrefix}${res.message}`);
      }
    } else if (tr.name === 'lookup_account_wallet_loyalty') {
      if (res.success && res.accountSummary) {
        const a = res.accountSummary;
        sections.push(
          `**Live Wallet & Loyalty Ledger for ${a.name}:**\n` +
          `- **Spendable Cash Wallet:** ₹${a.spendableWalletBalanceInr.toLocaleString('en-IN')}\n` +
          `- **Referral / Shopping Reward Wallet:** ₹${a.referralWalletBalanceInr.toLocaleString('en-IN')}\n` +
          `- **Loyalty Points Balance:** **${a.loyaltyPointsAvailable} pts** (worth ₹${a.loyaltyPointsRupeeValue} at checkout)\n` +
          `- **Current Loyalty Tier:** **${a.loyaltyTier.name}** (${a.loyaltyTier.pointsMultiplier}× points multiplier${a.loyaltyTier.tierDiscountPercent > 0 ? ` · ${a.loyaltyTier.tierDiscountPercent}% automatic tier discount` : ''}${a.loyaltyTier.freeShipping ? ' · Free Standard Shipping' : ''})` +
          (a.referralCode ? `\n- **Your Referral Code:** \`${a.referralCode}\`` : '')
        );
      } else {
        sections.push(res.message);
      }
    } else if (tr.name === 'lookup_coupons_and_offers') {
      if (res.coupons?.length) {
        const cLines = res.coupons.map(c => {
          const valDesc = c.rewardType === 'free_shipping'
            ? 'Free Shipping'
            : c.discountType === 'percentage'
            ? `${c.discountValue}% OFF`
            : `₹${c.discountValue} OFF`;
          return `- \`${c.code}\` — **${valDesc}** (Min order: ₹${c.minOrderAmount}${c.isPersonalReward ? ' · Personal Reward' : ''})`;
        });
        sections.push(`**Active Coupons & Offers Available:**\n${cLines.join('\n')}`);
      } else {
        sections.push(res.message);
      }
    } else if (tr.name === 'lookup_warranty_and_serial') {
      sections.push(res.message);
    } else if (tr.name === 'query_inventory_catalog') {
      const sp = res.shippingPolicy || {};
      if (res.products?.length) {
        const prodLines = res.products.slice(0, 4).map(p => {
          const stockBadge = p.stockStatus === 'in_stock'
            ? `In Stock (${p.stockQuantity} units available)`
            : p.stockStatus === 'low_stock'
            ? `Low Stock (Only ${p.stockQuantity} left)`
            : 'Out of Stock';
          const usage = p.usageGuide ? `\n  - *Usage:* ${p.usageGuide}` : '';
          const ingr = p.ingredients ? `\n  - *Botanical Profile:* ${p.ingredients}` : '';
          return `- **[${p.name}](${p.productUrl})** (SKU: \`${p.sku || 'N/A'}\`) — **₹${p.effectivePrice.toLocaleString('en-IN')}** · *${stockBadge}*${ingr}${usage}`;
        });
        sections.push(`Here are the live catalog & inventory details:\n${prodLines.join('\n')}`);
      }
      if (/shipping|delivery|cutoff|policy|return|cod|charge|free/i.test(userMessage) || !res.products?.length) {
        sections.push(
          `**Bhumivera Shipping & Self-Service Policy:**\n` +
          `- **Free Standard Delivery:** On all orders **₹${sp.freeShippingThresholdInr || 500}+** (₹${sp.standardShippingChargeInr || 50} below threshold)\n` +
          `- **Express Delivery:** ₹${sp.expressShippingChargeInr || 150} (or +₹${sp.expressSurchargeBelow799Inr || 100} surcharge under ₹${sp.expressThresholdInr || 799})\n` +
          `- **Same-Day Dispatch Cutoff:** Orders placed before **${sp.dispatchCutoffIst || '2:00 PM IST'}** arrive in **${sp.estimatedDeliveryBeforeCutoff || '4–6 days'}** (5–7 days after cutoff)\n` +
          `- **Returns & Replacements:** Eligible within **${sp.returnWindowDays || 7} days** of delivery (opens 30 minutes after delivery confirmation)`
        );
      }
    }
  }

  if (statusUpdatedTo) {
    sections.push(
      `✅ **Chat Status Updated to \`${statusUpdatedTo.replace(/_/g, ' ').toUpperCase()}\`**\n` +
      (statusUpdatedTo === 'resolved'
        ? 'Thank you for letting us help today! You can rate your experience below or reopen this chat anytime.'
        : statusUpdatedTo === 'closed'
        ? 'This chat session is now closed and saved to your transcript history. Click **Start New Chat** or **Reopen Chat** anytime you need us.'
        : statusUpdatedTo === 'waiting_for_review'
        ? 'Your conversation has been placed in the **Waiting for Supervisor Review** queue.'
        : `Your session is now marked as **${statusUpdatedTo.replace(/_/g, ' ')}**.`)
    );
  }

  if (escalation?.escalated) {
    sections.push(
      `🚨 **Priority Human Concierge Escalation Activated**\n` +
      `- **Ticket Reference:** ${escalation.ticketId ? `#${escalation.ticketId}` : 'Assigned'}\n` +
      `- **Priority Tier:** \`${escalation.priority}\` (Target response: **${escalation.slaResponseWindow}**)\n` +
      `- **Channels Alerted:** Instant notification dispatched to our Senior Concierge Desk via Email, Telegram & WhatsApp.`
    );
  }

  if (sections.length === 0) {
    if (/order\s*number|where\s*can\s*i\s*find/i.test(userMessage)) {
      sections.push(
        `You can find your **9-digit Order Number** in your Bhumivera order confirmation email, on your **[Profile → Orders](/profile)** page, or on the **[Order Tracking](/order-tracking)** page.`
      );
    } else if (/payment|razorpay|wallet|cod/i.test(userMessage)) {
      sections.push(
        `**Bhumivera Payment Options:**\n` +
        `- **Online Checkout (Razorpay):** Instant verification via UPI, Cards, and NetBanking with automated refund protection.\n` +
        `- **Bhumivera Wallet & Loyalty Points:** Redeemable directly at checkout.\n` +
        `- **Cash on Delivery (COD):** Unlocks automatically once your account has completed the required delivered orders.`
      );
    } else {
      sections.push(
        `${empathyPrefix}I can help you right away with:\n` +
        `- **Real-Time Order Tracking:** Share your 9-digit order number or ask *"Where is my order?"*\n` +
        `- **Instant Self-Service Resolutions:** Cancel eligible orders, initiate returns/replacements (` + '`RMA`' + `), or check Razorpay refund receipts\n` +
        `- **Wallet, Loyalty & Coupons:** Check your live spendable wallet, referral rewards, loyalty tier, and active promo codes\n` +
        `- **Chat Lifecycle Controls:** Use the status bar to mark this chat **Pending**, **Waiting for Review**, **Escalated**, **Resolved**, or **Closed**`
      );
    }
  }

  return {
    reply: sections.join('\n\n'),
    orderCards,
    quickActions,
  };
}

/**
 * Primary 20X LLM Orchestration Engine (`processSupportTurn`)
 */
async function processSupportTurn({
  sessionToken,
  message,
  attachments = [],
  pageContext = {},
  guestInfo = {},
  user = null,
  pool = null,
  aiClient = null,
  sendMailFn = null,
  httpPostFn = null,
}) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage && (!Array.isArray(attachments) || attachments.length === 0)) {
    throw Object.assign(new Error('Please enter a message or attach an image.'), {
      status: 400,
      code: 'EMPTY_MESSAGE',
    });
  }

  const featureConfig = await getAiSupportFeatureConfig(pool);

  // 1. Initialize or resume session
  const session = await createOrResumeSession({
    sessionToken,
    userId: user?.id || null,
    guestName: guestInfo?.name || user?.name || null,
    guestEmail: guestInfo?.email || user?.email || null,
    guestPhone: guestInfo?.phone || user?.phone || null,
    pageContext,
    pool,
  });

  // If session was previously closed/resolved and customer sends a new regular message, reopen to active
  let currentStatus = session.status || 'active';

  // 2. Load recent conversation history for multi-turn memory
  const history = await getSessionMessages(session.id, 25, pool);

  // 3. Score real-time sentiment & frustration (using dynamic threshold from featureConfig)
  const sentiment = analyzeSentiment(cleanMessage, history, { ...session.pageContext, ...pageContext });
  const configuredThreshold = Number(featureConfig.support_frustration_threshold) || 70;
  if (sentiment.frustrationScore >= configuredThreshold && !sentiment.shouldEscalate) {
    sentiment.shouldEscalate = true;
    sentiment.escalationReason = `Frustration index (${sentiment.frustrationScore}/100) breached configured threshold (${configuredThreshold})`;
  }

  // 4. Persist user message (with automatic PII masking inside appendMessage)
  await appendMessage({
    sessionId: session.id,
    sender: 'user',
    senderName: user?.name || session.guestName || 'Customer',
    content: cleanMessage || '[Image Attachment]',
    attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [],
    sentiment,
    pool,
  });

  // 5. Detect intent and run autonomous tools
  const plan = detectIntentAndToolPlan(cleanMessage, { ...session.pageContext, ...pageContext });
  if (Array.isArray(attachments) && attachments.length > 0 && plan.intent === 'initiate_return') {
    for (const tc of plan.toolCalls) {
      tc.args.image_urls = attachments.map(a => a.url || a.key || a.name).filter(Boolean);
    }
  }

  const toolResults = [];
  for (const call of plan.toolCalls) {
    const result = await executeSupportTool(call.name, call.args, {
      pool,
      user,
      featureConfig,
      session: {
        ...session,
        guestEmail: plan.extractedEmail || guestInfo?.email || session.guestEmail,
        guestPhone: plan.extractedPhone || guestInfo?.phone || session.guestPhone,
      },
    });
    toolResults.push({
      name: call.name,
      args: call.args,
      result,
    });
  }

  // Handle requested chat status transition if customer asked to mark resolved/closed/waiting_for_review/pending
  let statusUpdatedTo = null;
  if (plan.requestedChatStatus && VALID_CHAT_STATUSES.includes(plan.requestedChatStatus)) {
    currentStatus = plan.requestedChatStatus;
    statusUpdatedTo = plan.requestedChatStatus;
  } else if (['resolved', 'closed'].includes(currentStatus)) {
    currentStatus = 'active';
  }

  // 6. Trigger instant escalation if sentiment/frustration threshold breached or user asked for human
  let escalation = null;
  if (sentiment.shouldEscalate) {
    const targetOrderId = toolResults.find(t => t.result?.order?.id)?.result?.order?.id || plan.extractedOrderId || null;
    escalation = await triggerInstantEscalation({
      pool,
      session,
      user,
      latestMessage: cleanMessage,
      sentiment,
      reason: sentiment.escalationReason,
      orderId: /^\d+$/.test(String(targetOrderId || '')) ? Number(targetOrderId) : null,
      transcript: [...history, { sender: 'user', content: cleanMessage }],
      sendMailFn,
      httpPostFn,
    });
    currentStatus = 'escalated';
  } else {
    await updateSessionTelemetry(
      session.id,
      {
        sentimentScore: sentiment.score,
        frustrationScore: sentiment.frustrationScore,
        priority: sentiment.priority,
        status: currentStatus,
        ...(statusUpdatedTo === 'closed' || statusUpdatedTo === 'resolved' ? { closedBy: 'customer' } : {}),
      },
      pool
    );
  }

  // 7. Build deterministic baseline synthesis (guarantees structured orderCards & quickActions)
  const baseline = synthesizeDeterministicResponse({
    userMessage: cleanMessage,
    intent: plan.intent,
    toolResults,
    sentiment,
    escalation,
    statusUpdatedTo,
    user,
  });

  let finalReply = baseline.reply;
  let providerUsed = 'bhumivera-agentic-core';

  // 8. Optional LLM Enhancement Layer (@google/genai Gemini 2.5 Flash) with strict timeout & fallback
  const resolvedAiClient = aiClient || (() => {
    if (!process.env.GEMINI_API_KEY || featureConfig.ai_support_enabled === false) return null;
    try {
      const { GoogleGenAI } = require('@google/genai');
      return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch {
      return null;
    }
  })();

  if (resolvedAiClient?.models?.generateContent) {
    try {
      const memoryTranscript = history
        .slice(-6)
        .map(m => `${m.sender.toUpperCase()}: ${m.content}`)
        .join('\n');

      const llmPrompt = `You are the Bhumivera Autonomous Enterprise AI Customer Concierge.
Customer: ${user?.name || session.guestName || 'Valued Guest'}
Chat Status: ${currentStatus}
Sentiment: ${sentiment.label} (Frustration: ${sentiment.frustrationScore}/100, Priority: ${sentiment.priority})
Recent Memory:
${memoryTranscript || 'None'}

Latest Customer Message: "${maskPII(cleanMessage)}"
Verified Tool Execution Data (STRICT GROUND TRUTH — never invent order numbers, prices, stock, or medical claims):
${JSON.stringify(toolResults.map(t => ({ tool: t.name, output: t.result })))}
${escalation ? `Escalation Dispatched: ${JSON.stringify(escalation)}` : ''}

Return a JSON object with keys:
"reply": Warm, concise, empathetic markdown response grounded 100% in the Verified Tool Execution Data above.
"quick_actions": Optional array of up to 4 objects with {"id", "label", "prompt"}.`;

      const llmResponse = await Promise.race([
        resolvedAiClient.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: llmPrompt,
          config: { responseMimeType: 'application/json' },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LLM_TIMEOUT')), 6000)),
      ]);

      const parsed = JSON.parse(llmResponse.text || '{}');
      if (typeof parsed.reply === 'string' && parsed.reply.trim().length > 10) {
        finalReply = maskPII(parsed.reply.trim());
        providerUsed = 'gemini-2.5-flash';
      }
    } catch {
      providerUsed = 'bhumivera-agentic-fallback';
    }
  }

  // 9. Persist assistant message to conversation ledger
  const savedAssistantMessage = await appendMessage({
    sessionId: session.id,
    sender: 'assistant',
    senderName: 'Bhumivera AI Concierge',
    content: finalReply,
    toolCalls: toolResults.map(t => ({ name: t.name, args: t.args, code: t.result?.code })),
    orderCards: baseline.orderCards,
    quickActions: baseline.quickActions,
    sentiment,
    pool,
  });

  return {
    sessionToken: session.sessionToken,
    sessionId: session.id,
    status: currentStatus,
    provider: providerUsed,
    message: savedAssistantMessage,
    reply: finalReply,
    toolCalls: toolResults,
    orderCards: baseline.orderCards,
    quickActions: baseline.quickActions,
    sentiment,
    escalation,
  };
}

module.exports = {
  DEFAULT_QUICK_ACTIONS,
  buildContextualGreeting,
  detectIntentAndToolPlan,
  synthesizeDeterministicResponse,
  processSupportTurn,
};
