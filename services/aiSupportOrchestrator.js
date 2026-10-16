'use strict';

const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');
const { analyzeSentiment, triggerInstantEscalation } = require('./sentimentEscalationEngine');
const { executeSupportTool, SUPPORT_TOOLS_REGISTRY } = require('./aiSupportTools');
const {
  ensureAiSupportTables,
  createOrResumeSession,
  updateSessionTelemetry,
  appendMessage,
  getSessionMessages,
  getAiSupportFeatureConfig,
} = require('../models/aiSupportModel');

let defaultPool = null;
function getPool(customPool) {
  if (customPool) return customPool;
  if (!defaultPool) {
    defaultPool = require('../config/db');
  }
  return defaultPool;
}

/**
 * Generates contextual proactive greeting based on route, cart state, or recent orders.
 */
function buildContextualGreeting({ user = null, pageContext = {} } = {}) {
  const pathname = String(pageContext?.pathname || '/').toLowerCase();
  const proactiveTrigger = String(pageContext?.proactiveTrigger || '').toLowerCase();
  const firstName = user?.name ? user.name.split(' ')[0] : '';
  const greetingPrefix = firstName ? `Hi ${firstName},` : 'Hello!';

  let greeting = `${greetingPrefix} how can I help you today?`;
  let quickActions = [
    { label: 'Track My Order', prompt: 'Where is my latest order?' },
    { label: 'My Wallet & Loyalty', prompt: 'Check my wallet balance and loyalty points' },
    { label: 'Active Coupons', prompt: 'Show my available discount coupons' },
    { label: 'Return or Replace', prompt: 'I want to initiate a return or replacement' },
  ];

  if (proactiveTrigger === 'checkout_linger' || pathname.includes('/checkout')) {
    greeting = `${greetingPrefix} need a hand with shipping, coupons, or payment at checkout? Orders placed before 2:00 PM IST dispatch the same day.`;
    quickActions = [
      { label: 'Available Coupons', prompt: 'Show my available discount coupons' },
      { label: 'Check Wallet & Points', prompt: 'Check my wallet balance and loyalty points' },
      { label: 'Delivery Timeline', prompt: 'When will my order arrive if I order today?' },
      { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
    ];
  } else if (proactiveTrigger === 'rage_click') {
    greeting = `${greetingPrefix} it looks like something on this page isn't responding as expected. Tell me what you're trying to do and I'll help right away.`;
  } else if (pathname.includes('/order-tracking') || pathname.includes('/profile')) {
    greeting = `${greetingPrefix} I can check your order status, start a return or replacement, or look up a refund.`;
    quickActions = [
      { label: 'Check Latest Order', prompt: 'Show the status of my latest order' },
      { label: 'Start Return / Replace', prompt: 'I need to return or replace a delivered item' },
      { label: 'Check Refund Status', prompt: 'Check the status of my refund or RMA' },
      { label: 'Cancel Pending Order', prompt: 'Cancel my pending order' },
    ];
  } else if (pathname.includes('/product/')) {
    const prodName = pageContext?.productName || 'this product';
    greeting = `${greetingPrefix} ask me anything about ${prodName}, including ingredients, usage, stock, or delivery time.`;
    quickActions = [
      { label: 'Ingredients & Usage', prompt: `What are the key ingredients and usage directions for ${prodName}?` },
      { label: 'In-Stock Status', prompt: `Is ${prodName} currently in stock?` },
      { label: 'Verify Product Serial', prompt: 'How do I verify my product serial number?' },
    ];
  }

  return { greeting, quickActions };
}

/**
 * Extracts recent order number or BHVM reference from conversation history if the user is replying to a verification prompt.
 */
function extractOrderRefFromHistory(history = []) {
  if (!Array.isArray(history) || !history.length) return null;
  for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i -= 1) {
    const content = String(history[i]?.content || '');
    const bhvm = content.match(/\bBHVM[-_\s]*(\d{6,12})\b/i);
    if (bhvm) return bhvm[1];
    const nine = content.match(/(?:^|[^0-9])(\d{9})(?!\d)/);
    if (nine) return nine[1];
    const hashOrd = content.match(/Order\s*#(\d{1,12})\b/i);
    if (hashOrd) return hashOrd[1];
  }
  return null;
}

/**
 * Intent classifier & deterministic tool-call planner.
 * Handles Website, Mobile App, and Telegram (@BhumiveraBot) queries A-to-Z.
 */
function detectIntentAndToolPlan(message = '', { user = null, pageContext = {}, history = [] } = {}) {
  const rawText = String(message || '').trim();
  const text = rawText.replace(/^\/+/, '').trim();

  // Extract 9-digit Order Number, BHVM-prefixed Order/Tracking ID, internal #ID, RMA, Serial, Email, and Phone
  const bhvmMatch = rawText.match(/\bBHVM[-_\s]*([A-Z0-9]{4,16})\b/i);
  const explicitOrderMatch = rawText.match(/(?:order\s*(?:id|no|number|#)?\s*[:#-]?\s*|#)(?:BHVM[-_\s]*)?(\d{1,12})\b/i);
  const nineDigitMatch = rawText.match(/(?:^|[^0-9])(\d{9})(?!\d)/);
  const trackingCodeMatch = rawText.match(/\b(?:DLV|BLUEDART|DTDC|SHIP|TRK|AWB)[-_\s]*([A-Z0-9]{5,18})\b/i);

  const orderRef =
    bhvmMatch?.[0] ||
    explicitOrderMatch?.[1] ||
    nineDigitMatch?.[1] ||
    trackingCodeMatch?.[0] ||
    pageContext?.orderId ||
    null;

  const historyOrderRef = extractOrderRefFromHistory(history);

  const rmaMatch = rawText.match(/\b(RMA-[A-Z0-9]{6,12})\b/i);
  const serialMatch = rawText.match(/\b(BV-[A-Z0-9-]{5,20}|ANR[I]?-[A-Z0-9-]{5,20})\b/i);
  const emailMatch = rawText.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const phoneMatch = rawText.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);

  const email = emailMatch?.[0] || user?.email || null;
  const phone = phoneMatch?.[1] || user?.phone || null;

  const toolPlan = [];
  let intent = 'general_inquiry';

  // 1. Human agent / escalation request
  if (
    /^(agent|human|support|live\s*agent|executive|supervisor|manager|escalate|helpdesk)$/i.test(text) ||
    /\b(human|live\s*agent|real\s*person|customer\s*care\s*executive|speak\s*to\s*(?:someone|agent|manager|supervisor)|talk\s*to\s*(?:agent|human|person|support)|escalate|connect\s*me\s*(?:to|with)\s*(?:an?\s*)?(?:agent|human|support))\b/i.test(rawText)
  ) {
    intent = 'human_escalation';
    if (orderRef || user?.id) {
      toolPlan.push({ name: 'lookup_order', args: { order_id: orderRef, email, phone } });
    }
    return { intent, toolPlan, extracted: { orderRef, email, phone } };
  }

  // 2. Cancellation intent
  if (
    /^(cancel|cancellation)$/i.test(text) ||
    /\b(cancel\s*(?:my\s*|this\s*|the\s*)?order|cancel\s*#?\s*(?:BHVM[-_\s]*)?\d+|stop\s*(?:my\s*)?order|don'?t\s*want\s*(?:this\s*|the\s*)?order|abort\s*order)\b/i.test(rawText)
  ) {
    if (orderRef || historyOrderRef) {
      intent = 'cancel_order';
      toolPlan.push({
        name: 'cancel_order',
        args: {
          order_id: orderRef || historyOrderRef,
          reason: rawText,
          email,
          phone,
        },
      });
    } else {
      intent = 'cancel_assistance';
      toolPlan.push({
        name: 'lookup_order',
        args: { email, phone },
      });
    }
    return { intent, toolPlan, extracted: { orderRef: orderRef || historyOrderRef, email, phone } };
  }

  // 3. Return / Replacement / Damaged item intent (including single-word 'return', 'replace', 'exchange')
  if (
    /^(return|returns|replace|replacement|exchange|rma|damaged|defective|leaking|broken)$/i.test(text) ||
    /\b(initiate\s*(?:a\s*)?return|return\s*(?:my\s*|this\s*|the\s*|an?\s*)?(?:order|item|product|bottle|jar|package)?|want\s*to\s*(?:return|replace|exchange)|replace\s*(?:my\s*|this\s*)?(?:order|item|product)?|damaged\s*(?:item|product|bottle|box|order)|wrong\s*(?:item|product)|defective|leaking|broken)\b/i.test(rawText)
  ) {
    const isReplacement = /\b(replace|replacement|exchange)\b/i.test(rawText);
    const wantsWallet = /\b(wallet|store\s*credit|instant\s*credit)\b/i.test(rawText);
    if (orderRef || historyOrderRef) {
      intent = 'initiate_return';
      toolPlan.push({
        name: 'initiate_return',
        args: {
          order_id: orderRef || historyOrderRef,
          reason: rawText,
          resolution_type: isReplacement ? 'replacement' : 'refund',
          refund_method: wantsWallet ? 'wallet' : 'original',
          email,
          phone,
        },
      });
    } else {
      intent = 'return_assistance';
      toolPlan.push({
        name: 'lookup_order',
        args: { email, phone },
      });
    }
    return { intent, toolPlan, extracted: { orderRef: orderRef || historyOrderRef, email, phone } };
  }

  // 4. Refund / RMA Status check
  if (
    rmaMatch ||
    /^(refund|refunds|refund\s*status|rma\s*status)$/i.test(text) ||
    /\b(refund\s*status|where\s*is\s*my\s*refund|check\s*refund|when\s*will\s*i\s*get\s*(?:my\s*)?refund|rma\s*status|return\s*status|refund\s*for\s*order)\b/i.test(rawText)
  ) {
    intent = 'check_refund_status';
    toolPlan.push({
      name: 'check_refund_status',
      args: {
        rma_number: rmaMatch?.[1] || null,
        order_id: orderRef || historyOrderRef,
        email,
        phone,
      },
    });
    return { intent, toolPlan, extracted: { orderRef: orderRef || historyOrderRef, rmaNumber: rmaMatch?.[1], email, phone } };
  }

  // 5. Account Wallet, Referral & Loyalty Points check
  if (
    /^(wallet|points|loyalty|balance|referral|tier|rewards)$/i.test(text) ||
    /\b(wallet\s*balance|my\s*wallet|loyalty\s*points?|my\s*points|loyalty\s*tier|referral\s*(?:balance|code|reward|wallet)|shopping\s*wallet|how\s*many\s*points)\b/i.test(rawText)
  ) {
    intent = 'lookup_account_wallet_loyalty';
    toolPlan.push({
      name: 'lookup_account_wallet_loyalty',
      args: { email },
    });
    return { intent, toolPlan, extracted: { email } };
  }

  // 6. Coupons, Promo Codes & Active Offers
  if (
    /^(coupon|coupons|promo|offers?|discounts?|spin)$/i.test(text) ||
    /\b(coupon\s*codes?|available\s*coupons?|my\s*coupons?|active\s*offers?|promo\s*codes?|discount\s*codes?|spin\s*rewards?|any\s*offers?)\b/i.test(rawText)
  ) {
    intent = 'lookup_coupons_and_offers';
    toolPlan.push({
      name: 'lookup_coupons_and_offers',
      args: {},
    });
    return { intent, toolPlan, extracted: {} };
  }

  // 7. Product Serial Authenticity & E-Warranty check
  if (
    serialMatch ||
    /^(warranty|ewarranty|e-warranty|serial|authenticity)$/i.test(text) ||
    /\b(verify\s*serial|serial\s*number|authentic(?:ity)?\s*check|e-?warranty|my\s*warrant(?:y|ies)|batch\s*code|fake\s*or\s*real|genuine\s*product)\b/i.test(rawText)
  ) {
    intent = 'lookup_warranty_and_serial';
    toolPlan.push({
      name: 'lookup_warranty_and_serial',
      args: { serial_number: serialMatch?.[1] || null },
    });
    return { intent, toolPlan, extracted: { serialNumber: serialMatch?.[1] || null } };
  }

  // 8. Share Links, Website Links, Tracking Links & Product Share Links
  if (
    /^(link|links|share|website|url|store\s*link|shop\s*link)$/i.test(text) ||
    /\b(share\s*(?:a\s*|the\s*)?link|website\s*link|store\s*link|shop\s*link|tracking\s*link|referral\s*link|product\s*link|send\s*(?:me\s*)?(?:a\s*|the\s*)?link|give\s*(?:me\s*)?(?:a\s*|the\s*)?link)\b/i.test(rawText)
  ) {
    intent = 'share_links';
    const cleanedQuery = rawText
      .replace(/\b(share|send|give|me|a|the|link|url|for|of|to|website|product|please)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    toolPlan.push({
      name: 'query_inventory_catalog',
      args: { query: cleanedQuery.length >= 3 ? cleanedQuery : '' },
    });
    if (user?.id) {
      toolPlan.push({ name: 'lookup_account_wallet_loyalty', args: { email } });
    }
    return { intent, toolPlan, extracted: { query: cleanedQuery } };
  }

  // 9. Order Lookup, Tracking Details & Order History
  if (
    orderRef ||
    /^(order|orders|my\s*orders?|order\s*history|history|track|tracking|shipment|delivery|status|dispatch|package|parcel)$/i.test(text) ||
    /\b(where\s*is\s*my\s*order|track\s*(?:my\s*)?(?:order|package|shipment)|order\s*(?:status|history|details|update|tracking|list)|delivery\s*(?:status|date|time|estimate|update)|when\s*will\s*(?:my\s*order|it)\s*(?:arrive|deliver|ship)|latest\s*order|recent\s*orders?|past\s*orders?|all\s*(?:my\s*)?orders|my\s*orders?|check\s*order|tracking\s*(?:id|number|details))\b/i.test(rawText) ||
    ((emailMatch || phoneMatch) && historyOrderRef)
  ) {
    intent = 'lookup_order';
    toolPlan.push({
      name: 'lookup_order',
      args: { order_id: orderRef || historyOrderRef, email, phone },
    });
    return { intent, toolPlan, extracted: { orderRef: orderRef || historyOrderRef, email, phone } };
  }

  // 10. If the user sent ONLY their email or 10-digit phone number (to verify their account/orders)
  if ((emailMatch || phoneMatch) && rawText.split(/\s+/).length <= 4) {
    intent = 'lookup_order';
    toolPlan.push({
      name: 'lookup_order',
      args: { order_id: historyOrderRef || null, email, phone },
    });
    return { intent, toolPlan, extracted: { orderRef: historyOrderRef, email, phone } };
  }

  // 11. Greetings & Help Menu ('hi', 'hello', 'hey', 'namaste', 'start', 'help', 'menu')
  if (
    /^(hi+|hello+|hey+|namaste|hola|good\s*(?:morning|afternoon|evening|day)|start|help|menu|commands|options|what\s+can\s+you\s+do|how\s+are\s+you)[!?.]*$/i.test(text)
  ) {
    intent = 'greeting_or_menu';
    if (user?.id) {
      toolPlan.push({ name: 'lookup_order', args: { email, phone } });
      toolPlan.push({ name: 'lookup_coupons_and_offers', args: {} });
    }
    return { intent, toolPlan, extracted: { email, phone } };
  }

  // 12. Product Catalog, Ingredients, Pricing, Stock & Shipping Policy
  if (
    /\b(stock|available|availability|price|cost|ingredient|how\s*to\s*use|benefit|shipping\s*charge|free\s*shipping|delivery\s*charge|return\s*policy|cod|cash\s*on\s*delivery|kumkumadi|elixir|oil|serum|cream|cleanser|shampoo|soap|toner|gel|balm|scrub|mask|face|hair|skin|product|catalog|shop|buy|recommend|best\s*seller)\b/i.test(rawText)
  ) {
    intent = 'catalog_or_policy';
    const cleanedQuery = rawText
      .replace(/\b(is|are|what|the|of|for|in|stock|available|price|cost|ingredients?|how|to|use|tell|me|about|do|you|have|show|products?|catalog|shop|buy|recommend|best|sellers?)\b/gi, ' ')
      .replace(/[?!.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    toolPlan.push({
      name: 'query_inventory_catalog',
      args: {
        query: cleanedQuery.length >= 3 ? cleanedQuery : (pageContext?.productName || ''),
        product_id: pageContext?.productId || null,
      },
    });
    return { intent, toolPlan, extracted: { query: cleanedQuery } };
  }

  // 13. Fallback: Query catalog & policy so we always give a helpful, grounded answer
  intent = 'catalog_or_policy';
  toolPlan.push({
    name: 'query_inventory_catalog',
    args: {
      query: text.length >= 3 ? text : '',
      product_id: pageContext?.productId || null,
    },
  });
  return { intent, toolPlan, extracted: { orderRef, email, phone } };
}

/**
 * Synthesizes a grounded, natural customer support response from executed tool outputs.
 */
function synthesizeDeterministicResponse({
  intent,
  userMessage,
  toolResults = [],
  sentiment = {},
  escalation = null,
  escalationInfo = null,
  user = null,
} = {}) {
  const firstName = user?.name ? user.name.split(' ')[0] : '';
  const nameGreeting = firstName ? `${firstName}, ` : '';
  const esc = escalation || escalationInfo;

  if (esc?.escalated) {
    return {
      reply: `I've connected you with a human support specialist${
        esc.ticketId ? ` (ticket #${esc.ticketId})` : ''
      }. A team member will reply within 30 minutes right here in chat.`,
      quickActions: [
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Check Refund Status', prompt: 'Check the status of my refund' },
      ],
    };
  }

  // Greeting / Help Menu
  if (intent === 'greeting_or_menu') {
    const lookupRes = toolResults.find(t => t.name === 'lookup_order')?.result;
    const couponRes = toolResults.find(t => t.name === 'lookup_coupons_and_offers')?.result;

    let accountLine = '';
    if (lookupRes?.orderCards?.length) {
      const latest = lookupRes.orderCards[0];
      accountLine += `\n\n📦 **Your Latest Order (#${latest.orderNumber} / BHVM${latest.orderNumber}):** Status is **${latest.status.toUpperCase()}** (${latest.deliveryEstimate}). Track live: ${latest.trackingUrl}`;
    }
    if (couponRes?.coupons?.length) {
      const topCoupon = couponRes.coupons[0];
      accountLine += `\n🎁 **Active Offer:** Use code \`${topCoupon.code}\` at checkout!`;
    }

    return {
      reply:
        `Hello${firstName ? ` ${firstName}` : ''}! Welcome to **Bhumivera Support**.\n\n` +
        `Here is everything I can help you with right here in chat or on Telegram (@BhumiveraBot):\n` +
        `• **Track Any Order:** Send your 9-digit Order Number or BHVM ID (e.g., \`BHVM815899599\` or \`#918273646\`)\n` +
        `• **Order History:** Type \`my orders\` or \`order history\` to see your recent purchases\n` +
        `• **Returns & Replacements:** Type \`return #<OrderNumber>\` or \`replace #<OrderNumber>\` for instant RMA pickup\n` +
        `• **Cancel Unshipped Order:** Type \`cancel #<OrderNumber>\`\n` +
        `• **Refund Status:** Type \`refund status\` or your \`RMA-...\` number\n` +
        `• **Coupons & Wallet:** Type \`my coupons\` or \`my wallet\` to check live balances & promo codes\n` +
        `• **Products & Share Links:** Ask about any product or type \`share link\` for direct website links` +
        accountLine,
      quickActions: [
        { label: 'My Orders & Tracking', prompt: 'Show my recent orders' },
        { label: 'Return or Replace', prompt: 'I want to return or replace an order' },
        { label: 'Active Coupons', prompt: 'Show my available discount coupons' },
        { label: 'Share Website Links', prompt: 'Share Bhumivera website and product links' },
      ],
    };
  }

  // Share Links intent
  if (intent === 'share_links') {
    const catRes = toolResults.find(t => t.name === 'query_inventory_catalog')?.result;
    const walletRes = toolResults.find(t => t.name === 'lookup_account_wallet_loyalty')?.result;
    const products = catRes?.products || [];
    const productLinks = products
      .slice(0, 4)
      .map(p => `• **${p.name}** (₹${p.effectivePrice}): ${p.shareUrl}`)
      .join('\n');
    const referralLine = walletRes?.accountSummary?.referralCode
      ? `\n• **Your Personal Referral Link:** ${walletRes.accountSummary.referralShareUrl} (Code: \`${walletRes.accountSummary.referralCode}\`)`
      : '';

    return {
      reply:
        `Here are your direct **Bhumivera Share & Quick-Access Links**:\n` +
        `• **Official Storefront:** https://www.bhumivera.com/shop\n` +
        `• **Live Order Tracking:** https://www.bhumivera.com/order-tracking\n` +
        `• **Customer Profile & Orders:** https://www.bhumivera.com/profile\n` +
        `• **E-Warranty & Serial Check:** https://www.bhumivera.com/e-warranty\n` +
        `• **Telegram Support Bot:** https://t.me/BhumiveraBot` +
        referralLine +
        (productLinks ? `\n\n**Featured Product Share Links:**\n${productLinks}` : ''),
      quickActions: [
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Show Active Coupons', prompt: 'Show my available discount coupons' },
      ],
    };
  }

  const cancelResult = toolResults.find(t => t.name === 'cancel_order')?.result;
  if (cancelResult) {
    return {
      reply: cancelResult.message,
      quickActions: cancelResult.success
        ? [
            { label: 'Browse Products', prompt: 'What are your best-selling products?' },
            { label: 'Check Other Orders', prompt: 'Show my recent orders' },
          ]
        : [
            { label: 'Initiate Return Instead', prompt: 'I want to return this order' },
            { label: 'Speak to Support Agent', prompt: 'Connect me with a human support agent' },
          ],
    };
  }

  const returnResult = toolResults.find(t => t.name === 'initiate_return')?.result;
  if (returnResult) {
    return {
      reply: returnResult.message,
      quickActions: [
        { label: 'Check Refund Status', prompt: `Check refund status for ${returnResult.rmaNumber || 'my order'}` },
        { label: 'Speak to Support Agent', prompt: 'Connect me with a human support agent' },
      ],
    };
  }

  const refundResult = toolResults.find(t => t.name === 'check_refund_status')?.result;
  if (refundResult) {
    return {
      reply: refundResult.message,
      quickActions: [
        { label: 'Track My Orders', prompt: 'Show my recent orders' },
        { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
      ],
    };
  }

  const walletResult = toolResults.find(t => t.name === 'lookup_account_wallet_loyalty')?.result;
  if (walletResult) {
    if (!walletResult.success) {
      return {
        reply: walletResult.message,
        quickActions: [
          { label: 'Active Coupons', prompt: 'Show my available discount coupons' },
          { label: 'Track Order', prompt: 'Where is my latest order?' },
        ],
      };
    }
    const s = walletResult.accountSummary;
    const tierPerks = [];
    if (s.loyaltyTier.tierDiscountPercent > 0) tierPerks.push(`${s.loyaltyTier.tierDiscountPercent}% automatic tier discount`);
    if (s.loyaltyTier.freeShipping) tierPerks.push('Free Shipping on all orders');
    if (s.loyaltyTier.pointsMultiplier > 1) tierPerks.push(`${s.loyaltyTier.pointsMultiplier}x points multiplier`);

    return {
      reply:
        `Here is your live Bhumivera Wallet & Loyalty summary:\n` +
        `• **Spendable Wallet:** ₹${s.spendableWalletBalanceInr.toLocaleString('en-IN')}\n` +
        `• **Referral / Shopping Wallet:** ₹${s.referralWalletBalanceInr.toLocaleString('en-IN')}\n` +
        `• **Loyalty Points:** ${s.loyaltyPointsAvailable} pts (worth ~₹${s.loyaltyPointsRupeeValue} at checkout)\n` +
        `• **Current Tier:** ${s.loyaltyTier.name}${tierPerks.length ? ` (${tierPerks.join(', ')})` : ''}` +
        (s.referralCode ? `\n• **Your Referral Code:** \`${s.referralCode}\` — Share link: ${s.referralShareUrl}` : ''),
      quickActions: [
        { label: 'Show My Coupons', prompt: 'Show my available discount coupons' },
        { label: 'Track My Orders', prompt: 'Show my recent orders' },
      ],
    };
  }

  const couponResult = toolResults.find(t => t.name === 'lookup_coupons_and_offers')?.result;
  if (couponResult) {
    if (!couponResult.coupons || couponResult.coupons.length === 0) {
      return {
        reply: couponResult.message,
        quickActions: [
          { label: 'Check Wallet & Points', prompt: 'Check my wallet balance and loyalty points' },
          { label: 'Browse Products', prompt: 'Show your featured products' },
        ],
      };
    }
    const listText = couponResult.coupons
      .map(c => {
        const benefit =
          c.rewardType === 'free_shipping' || c.discountType === 'free_shipping'
            ? 'Free Shipping'
            : c.discountType === 'percentage'
            ? `${c.discountValue}% OFF${c.maxDiscount ? ` (up to ₹${c.maxDiscount})` : ''}`
            : `₹${c.discountValue} OFF`;
        const minText = c.minOrderAmount > 0 ? ` on orders above ₹${c.minOrderAmount}` : '';
        const personalTag = c.isPersonalReward ? ' [Personal Reward]' : '';
        return `• **\`${c.code}\`** — ${benefit}${minText}${personalTag}`;
      })
      .join('\n');

    return {
      reply: `Here are the active coupons currently available for your account (each single-use coupon is protected against duplicate reuse):\n${listText}\n\nYou can apply any eligible code inside your Cart or at Checkout (https://www.bhumivera.com/checkout).`,
      quickActions: [
        { label: 'Check Wallet & Points', prompt: 'Check my wallet balance and loyalty points' },
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
      ],
    };
  }

  const warrantyResult = toolResults.find(t => t.name === 'lookup_warranty_and_serial')?.result;
  if (warrantyResult) {
    return {
      reply: `${warrantyResult.message}\n\nYou can also register or download your E-Warranty certificate anytime at https://www.bhumivera.com/e-warranty.`,
      quickActions: [
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
      ],
    };
  }

  const lookupResult = toolResults.find(t => t.name === 'lookup_order')?.result;
  if (lookupResult) {
    if (lookupResult.code === 'VERIFICATION_REQUIRED' || lookupResult.code === 'ORDER_IDENTIFIER_REQUIRED') {
      if (intent === 'return_assistance') {
        return {
          reply:
            `I can initiate a return or replacement for your delivered order right away! ` +
            `Please reply with your **9-digit Order Number** (e.g., \`BHVM815899599\` or \`return #918273646\`) along with your registered **email address** or **10-digit phone number**.`,
          quickActions: [
            { label: 'Check Refund Status', prompt: 'Check the status of my refund' },
            { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
          ],
        };
      }
      if (intent === 'cancel_assistance') {
        return {
          reply:
            `I can cancel any unshipped (Pending or Confirmed) order immediately. ` +
            `Please reply with your **9-digit Order Number** (e.g., \`cancel BHVM815899599\`) and your registered **email or 10-digit phone number**.`,
          quickActions: [
            { label: 'Track My Order', prompt: 'Where is my latest order?' },
            { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
          ],
        };
      }
      return {
        reply: lookupResult.message,
        quickActions: [
          { label: 'Shipping & Delivery Policy', prompt: 'What are your shipping charges and delivery timelines?' },
          { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
        ],
      };
    }

    if (lookupResult.code === 'ORDER_NOT_FOUND') {
      return {
        reply:
          `${lookupResult.message}\n\n` +
          `• **Track on Website:** https://www.bhumivera.com/order-tracking\n` +
          `• **Tip:** You can also reply here with your registered **email address** or **10-digit phone number** and I will find all orders linked to your profile.`,
        quickActions: [
          { label: 'Show My Recent Orders', prompt: 'Show my recent orders' },
          { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
        ],
      };
    }

    if (lookupResult.code === 'ORDER_FOUND' && lookupResult.order) {
      const o = lookupResult.order;
      const trackingLine = o.trackingNumber
        ? `Courier: **${o.courier || 'Partner Courier'}** (Tracking ID: \`${o.trackingNumber}\`).`
        : 'Your tracking number will be assigned as soon as the package leaves our dispatch hub.';
      const itemsLine = (o.items || [])
        .map(it => `${it.name} × ${it.quantity} (₹${it.price})`)
        .join(', ');

      const actions = [];
      if (o.cancellable) {
        actions.push({ label: `Cancel Order #${o.orderNumber}`, prompt: `Cancel order #${o.orderNumber}` });
      }
      if (o.canReturn) {
        actions.push({ label: `Return Order #${o.orderNumber}`, prompt: `Initiate return for order #${o.orderNumber}` });
        actions.push({ label: `Replace Order #${o.orderNumber}`, prompt: `Initiate replacement for order #${o.orderNumber}` });
      }
      actions.push({ label: 'Show All My Orders', prompt: 'Show my recent orders' });

      return {
        reply:
          `${nameGreeting}here are the live details for **Order #${o.orderNumber}** (\`BHVM${o.orderNumber}\`):\n` +
          `• **Status:** ${o.status.toUpperCase()}\n` +
          `• **Estimated Delivery:** ${o.deliveryEstimate}\n` +
          `• **Shipment:** ${trackingLine}\n` +
          `• **Payment:** ${o.paymentMode} (${o.paymentStatus}) — Total: **₹${o.total}**\n` +
          (itemsLine ? `• **Items:** ${itemsLine}\n` : '') +
          `• **Live Tracking Link:** ${o.trackingUrl}`,
        quickActions: actions,
      };
    }

    if (lookupResult.code === 'ORDERS_LISTED' && lookupResult.orderCards?.length) {
      const latest = lookupResult.orderCards[0];
      const historyLines = lookupResult.orderCards
        .map(
          ord =>
            `• **Order #${ord.orderNumber}** (\`BHVM${ord.orderNumber}\`) — **${ord.status.toUpperCase()}** · ₹${ord.total} · ${
              ord.trackingNumber ? `Tracking: \`${ord.trackingNumber}\`` : ord.deliveryEstimate
            } (${ord.trackingUrl})`
        )
        .join('\n');

      if (intent === 'return_assistance') {
        const returnable = lookupResult.orderCards.filter(ord => ord.status === 'delivered');
        const returnHint = returnable.length
          ? `To start a return or replacement right now, reply with **\`return #${returnable[0].orderNumber}\`** or **\`replace #${returnable[0].orderNumber}\`**.`
          : `Note: Only delivered orders are eligible for return/replacement. If you wish to cancel an unshipped order, reply **\`cancel #${latest.orderNumber}\`**.`;
        return {
          reply: `Here are the orders on your account:\n${historyLines}\n\n${returnHint}`,
          quickActions: [
            ...(returnable.length
              ? [{ label: `Return Order #${returnable[0].orderNumber}`, prompt: `Initiate return for order #${returnable[0].orderNumber}` }]
              : []),
            ...(latest.cancellable
              ? [{ label: `Cancel Order #${latest.orderNumber}`, prompt: `Cancel order #${latest.orderNumber}` }]
              : []),
            { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
          ],
        };
      }

      if (intent === 'cancel_assistance') {
        const cancellable = lookupResult.orderCards.filter(ord => ord.cancellable);
        const cancelHint = cancellable.length
          ? `To cancel your unshipped order immediately, reply **\`cancel #${cancellable[0].orderNumber}\`**.`
          : `None of your recent orders are in 'pending' or 'confirmed' status for direct cancellation. For delivered orders, you can reply **\`return #${latest.orderNumber}\`**.`;
        return {
          reply: `Here are the orders on your account:\n${historyLines}\n\n${cancelHint}`,
          quickActions: [
            ...(cancellable.length
              ? [{ label: `Cancel Order #${cancellable[0].orderNumber}`, prompt: `Cancel order #${cancellable[0].orderNumber}` }]
              : []),
            { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
          ],
        };
      }

      const actions = [];
      if (latest.cancellable) {
        actions.push({ label: `Cancel Order #${latest.orderNumber}`, prompt: `Cancel order #${latest.orderNumber}` });
      }
      if (latest.canReturn) {
        actions.push({ label: `Return Order #${latest.orderNumber}`, prompt: `Initiate return for order #${latest.orderNumber}` });
      }
      actions.push({ label: 'Check Refund Status', prompt: 'Check the status of my refund' });

      return {
        reply:
          `I found **${lookupResult.orderCards.length} recent order(s)** on your account:\n` +
          `${historyLines}\n\n` +
          `Your latest order **#${latest.orderNumber}** is **${latest.status.toUpperCase()}** (${latest.deliveryEstimate}).`,
        quickActions: actions,
      };
    }

    if (lookupResult.code === 'NO_ORDERS_FOUND') {
      return {
        reply: `${lookupResult.message} If you placed an order using a different phone number or email, reply with your 9-digit Order Number (e.g., \`BHVM815899599\`) and that phone/email!`,
        quickActions: [
          { label: 'Explore Products', prompt: 'Show your featured products' },
          { label: 'Shipping Policy', prompt: 'What are your shipping charges?' },
        ],
      };
    }
  }

  const catalogResult = toolResults.find(t => t.name === 'query_inventory_catalog')?.result;
  if (catalogResult) {
    const policy = catalogResult.shippingPolicy;
    const isShippingQuestion = /\b(shipping|delivery\s*charge|free\s*shipping|express|cutoff|return\s*policy|cod|cash\s*on\s*delivery)\b/i.test(userMessage || '');

    if (isShippingQuestion) {
      return {
        reply:
          `**Bhumivera Shipping, COD & Return Policy:**\n` +
          `• **Free Standard Shipping** on all orders of ₹${policy.freeShippingThresholdInr} or above (₹${policy.standardShippingChargeInr} below ₹${policy.freeShippingThresholdInr}).\n` +
          `• **Express Delivery:** ₹${policy.expressShippingChargeInr} for orders ₹${policy.expressThresholdInr}+ (or +₹${policy.expressSurchargeBelow799Inr} surcharge below ₹${policy.expressThresholdInr}).\n` +
          `• **Dispatch Cutoff:** Orders placed before ${policy.dispatchCutoffIst} arrive in ${policy.estimatedDeliveryBeforeCutoff}; after cutoff in ${policy.estimatedDeliveryAfterCutoff}.\n` +
          `• **Returns:** Self-service returns and replacements are open for ${policy.returnWindowDays} days after delivery.\n` +
          `• **Track Orders:** https://www.bhumivera.com/order-tracking`,
        quickActions: [
          { label: 'Track My Order', prompt: 'Where is my latest order?' },
          { label: 'Browse Products', prompt: 'What are your best-selling products?' },
        ],
      };
    }

    if (catalogResult.products?.length > 0) {
      const top = catalogResult.products[0];
      const stockText =
        top.stockStatus === 'in_stock'
          ? `In Stock (${top.stockQuantity} units available)`
          : top.stockStatus === 'low_stock'
          ? `Low Stock (Only ${top.stockQuantity} left!)`
          : 'Currently Out of Stock';
      const ingText = top.ingredients ? `\n• **Key Ingredients:** ${top.ingredients}` : '';
      const useText = top.usageGuide ? `\n• **How to Use:** ${top.usageGuide}` : '';
      const moreList =
        catalogResult.products.length > 1
          ? `\n\n**More Featured Products & Share Links:**\n` +
            catalogResult.products
              .slice(1, 4)
              .map(p => `• **${p.name}** (₹${p.effectivePrice}) — ${p.shareUrl}`)
              .join('\n')
          : '';

      return {
        reply:
          `**${top.name}** (SKU: \`${top.sku || 'N/A'}\`)\n` +
          `• **Price:** ₹${top.effectivePrice}${top.discountPrice ? ` (MRP ₹${top.price})` : ''}\n` +
          `• **Availability:** ${stockText}` +
          ingText +
          useText +
          `\n• **Product Link:** ${top.shareUrl}` +
          moreList +
          `\n\nFree standard shipping applies on orders of ₹${policy.freeShippingThresholdInr} or more.`,
        quickActions: [
          { label: 'Show Active Coupons', prompt: 'Show my available discount coupons' },
          { label: 'Track My Order', prompt: 'Where is my latest order?' },
        ],
      };
    }
  }

  return {
    reply:
      `I can help with orders, returns, refunds, coupons, wallet balances, or product questions. Send your 9-digit Order Number (e.g., \`BHVM815899599\`) or tell me what you'd like to check!`,
    quickActions: [
      { label: 'Track My Order', prompt: 'Where is my latest order?' },
      { label: 'Initiate Return / Replace', prompt: 'I want to return or replace an item' },
      { label: 'Check Refund Status', prompt: 'Check the status of my refund' },
      { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
    ],
  };
}

/**
 * Optional Gemini LLM synthesis when GEMINI_API_KEY is configured in production.
 */
async function tryGeminiSynthesis({ userMessage, history = [], toolResults = [], deterministicFallback, user = null }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return deterministicFallback.reply;

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_SUPPORT_MODEL || 'gemini-2.5-flash',
    });

    const sanitizedToolContext = sanitizeObjectPII(toolResults);
    const recentTurns = (history || [])
      .slice(-6)
      .map(m => `${m.sender.toUpperCase()}: ${maskPII(m.content)}`)
      .join('\n');

    const systemPrompt = [
      'You are the Bhumivera Customer Support Assistant (Web & @BhumiveraBot on Telegram).',
      'Rules:',
      '1. Ground every order number, status, price, stock count, RMA, wallet balance, coupon code, and tracking link strictly in the provided TOOL_RESULTS JSON.',
      '2. Always include direct clickable links (e.g. https://www.bhumivera.com/order-tracking or product shareUrl) when available in TOOL_RESULTS.',
      '3. Keep your response concise (2 to 5 sentences or clean bullet points), warm, and directly helpful.',
      '4. Never expose raw passwords, full payment card numbers, CVVs, OTPs, or JWTs.',
      `Customer Name: ${user?.name || 'Guest'}`,
      `Recent Conversation:\n${recentTurns || 'None'}`,
      `TOOL_RESULTS:\n${JSON.stringify(sanitizedToolContext)}`,
      `Customer Message: ${maskPII(userMessage)}`,
    ].join('\n\n');

    const response = await model.generateContent(systemPrompt);
    const text = response?.response?.text?.();
    if (text && text.trim().length > 10) {
      return maskPII(text.trim());
    }
  } catch {
    // Fallback cleanly to deterministic synthesis
  }
  return deterministicFallback.reply;
}

/**
 * Main entry point for processing a customer support turn (both REST and SSE streaming).
 */
async function processSupportTurn({
  sessionToken = null,
  message = '',
  user = null,
  guestInfo = {},
  guestName = null,
  guestEmail = null,
  guestPhone = null,
  pageContext = {},
  attachments = [],
  pool = null,
  onStreamEvent = null,
  updateOrderStatusFn = null,
}) {
  const activePool = getPool(pool);
  await ensureAiSupportTables(activePool);
  const featureConfig = await getAiSupportFeatureConfig(activePool);

  const emit = (event, data) => {
    if (typeof onStreamEvent === 'function') {
      try {
        onStreamEvent(event, data);
      } catch {
        // Ignore stream callback errors
      }
    }
  };

  emit('status', { phase: 'session_init', label: 'Securing conversation & masking sensitive PII...' });

  const session = await createOrResumeSession({
    sessionToken,
    userId: user?.id || null,
    guestName: user?.name || guestInfo?.name || guestName,
    guestEmail: user?.email || guestInfo?.email || guestEmail,
    guestPhone: user?.phone || guestInfo?.phone || guestPhone,
    pageContext,
    pool: activePool,
  });

  // If user is null but session has a linked userId, load the user profile so tools have full context
  let resolvedUser = user;
  if (!resolvedUser && session?.userId && activePool) {
    try {
      const [uRows] = await activePool.query('SELECT id, name, email, phone, role FROM users WHERE id = ? LIMIT 1', [session.userId]);
      if (uRows?.[0]) resolvedUser = uRows[0];
    } catch {
      // Ignore if not mocked
    }
  }

  const history = await getSessionMessages(session.id, 20, activePool);

  // Evaluate sentiment & escalation priority
  const sentiment = analyzeSentiment(message, {
    previousSentimentScore: session.sentimentScore,
    previousFrustrationScore: session.frustrationScore,
    turnCount: history.filter(m => m.sender === 'user').length + 1,
    frustrationThreshold: featureConfig.support_frustration_threshold || 70,
  });

  // Persist user message (with PII masked)
  await appendMessage({
    sessionId: session.id,
    sender: 'user',
    content: message,
    attachments,
    sentiment,
    pool: activePool,
  });

  // Detect intent and plan autonomous tool calls
  const { intent, toolPlan, extracted } = detectIntentAndToolPlan(message, {
    user: resolvedUser,
    pageContext: { ...session.pageContext, ...pageContext },
    history,
  });

  if ((extracted?.email && !session.guestEmail) || (extracted?.phone && !session.guestPhone)) {
    session.guestEmail = session.guestEmail || extracted.email || null;
    session.guestPhone = session.guestPhone || extracted.phone || null;
  }

  const executedTools = [];
  const collectedOrderCards = [];

  for (const planned of toolPlan) {
    emit('tool_call', { name: planned.name, status: 'running' });
    const result = await executeSupportTool(planned.name, planned.args, {
      pool: activePool,
      user: resolvedUser,
      session,
      pageContext: { ...session.pageContext, ...pageContext },
      featureConfig,
      updateOrderStatusFn,
    });
    executedTools.push({ name: planned.name, args: sanitizeObjectPII(planned.args), result });
    if (Array.isArray(result?.orderCards)) {
      for (const card of result.orderCards) {
        if (!collectedOrderCards.some(existing => existing.id === card.id)) {
          collectedOrderCards.push(card);
        }
      }
    }
    emit('tool_call', { name: planned.name, status: 'completed', code: result?.code });
  }

  // Handle escalation if triggered by frustration/keywords or explicit request
  let escalationInfo = { escalated: false, ticketId: session.escalatedTicketId || null };
  if ((sentiment.shouldEscalate || intent === 'human_escalation') && session.status !== 'escalated') {
    emit('status', { phase: 'escalating', label: 'Routing to Priority Human Concierge Queue...' });
    const escRes = await triggerInstantEscalation({
      pool: activePool,
      session,
      user: resolvedUser,
      sentiment,
      recentMessages: [...history.slice(-4), { sender: 'user', content: message }],
      orderId: collectedOrderCards[0]?.id || extracted.orderRef || null,
      reason: (sentiment.signals || []).join(', ') || 'Customer requested human agent',
    });

    escalationInfo = {
      escalated: true,
      ticketId: escRes?.ticketId || null,
      priority: sentiment.priority,
      slaResponseWindow: sentiment.slaResponseWindow || 'Under 30 minutes',
    };
  } else {
    await updateSessionTelemetry(
      session.id,
      {
        sentimentScore: sentiment.score ?? sentiment.sentimentScore ?? 0,
        frustrationScore: sentiment.frustrationScore ?? 0,
        priority: sentiment.priority || 'Low',
      },
      activePool
    );
  }

  // Synthesize response
  emit('status', { phase: 'synthesizing', label: 'Composing verified response...' });
  const deterministic = synthesizeDeterministicResponse({
    intent,
    userMessage: message,
    toolResults: executedTools,
    sentiment,
    escalation: escalationInfo,
    escalationInfo,
    user: resolvedUser,
  });

  const finalReply = await tryGeminiSynthesis({
    userMessage: message,
    history,
    toolResults: executedTools,
    deterministicFallback: deterministic,
    user: resolvedUser,
  });

  if (typeof onStreamEvent === 'function') {
    const chunks = finalReply.match(/.{1,18}(\s|$)|\S+/g) || [finalReply];
    for (const chunk of chunks) {
      emit('token', { text: chunk });
    }
  }

  const savedAssistantMessage = await appendMessage({
    sessionId: session.id,
    sender: 'assistant',
    content: finalReply,
    toolCalls: executedTools.map(t => ({ name: t.name, code: t.result?.code, success: t.result?.success, result: t.result })),
    orderCards: collectedOrderCards,
    quickActions: deterministic.quickActions,
    sentiment,
    pool: activePool,
  });

  return {
    sessionToken: session.sessionToken,
    sessionId: session.id,
    status: escalationInfo.escalated ? 'escalated' : session.status,
    messageId: savedAssistantMessage.id,
    message: savedAssistantMessage,
    reply: finalReply,
    intent,
    sentiment,
    escalation: escalationInfo,
    orderCards: collectedOrderCards,
    quickActions: deterministic.quickActions,
    toolCalls: executedTools.map(t => ({ name: t.name, code: t.result?.code, success: t.result?.success, result: t.result })),
    provider: 'deterministic-verified',
  };
}

module.exports = {
  buildContextualGreeting,
  detectIntentAndToolPlan,
  synthesizeDeterministicResponse,
  processSupportTurn,
  SUPPORT_TOOLS_REGISTRY,
};
