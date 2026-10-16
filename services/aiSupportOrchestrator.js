'use strict';

const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');
const { analyzeSentiment, triggerInstantEscalation } = require('./sentimentEscalationEngine');
const {
  findRelevantConciergeAnswer,
  getConciergeKnowledgeAnswer,
} = require('./conciergeKnowledgeBase');
const { executeSupportTool, SUPPORT_TOOLS_REGISTRY } = require('./aiSupportTools');
const {
  COMPLETE_SITE_NAVIGATION_MAP,
  evaluatePasswordRequirements,
  findRelevantNavigationLinks,
} = require('./aiCopilotRescueService');
const {
  ensureAiSupportTables,
  createOrResumeSession,
  updateSessionContext,
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
      { label: 'Request Order Assistance', prompt: 'Cancel my pending order' },
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
    (/^(return|returns|replace|replacement|exchange|rma|damaged|defective|leaking|broken)$/i.test(text) ||
      /\b(initiate\s*(?:a\s*)?return|return\s*(?:my\s*|this\s*|the\s*|an?\s*)?(?:order|item|product|bottle|jar|package)?|want\s*to\s*(?:return|replace|exchange)|replace\s*(?:my\s*|this\s*)?(?:order|item|product)?|damaged\s*(?:item|product|bottle|box|order)|wrong\s*(?:item|product)|defective|leaking|broken)\b/i.test(rawText)) &&
    !/\breturn\s+policy\b/i.test(rawText)
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

  // 4b. Bhumivera Client Concierge: Unable to Add to Cart / Cart Friction Rescue
  if (
    /\b(unable\s*to\s*add\s*to\s*cart|can'?t\s*add\s*to\s*cart|cannot\s*add\s*to\s*cart|add\s*to\s*cart\s*(?:not\s*working|failed|error|issue|problem|disabled)|cart\s*(?:not\s*working|error|problem|issue|empty)|item\s*not\s*adding|button\s*disabled)\b/i.test(rawText)
  ) {
    intent = 'cart_friction_rescue';
    toolPlan.push({
      name: 'query_inventory_catalog',
      args: {
        query: pageContext?.productName || '',
        product_id: pageContext?.productId || null,
      },
    });
    return { intent, toolPlan, extracted: { productId: pageContext?.productId || null } };
  }

  // 4c. Bhumivera Client Concierge: Unable to Set Password / Reset Password / OTP / Login Rescue
  if (
    /^(password|forgot\s*password|reset\s*password|login\s*help|otp)$/i.test(text) ||
    /\b(unable\s*to\s*(?:set|reset|change|create)\s*password|can'?t\s*(?:set|reset|change|login|sign\s*in)|cannot\s*(?:set|reset|change|login|sign\s*in)|password\s*(?:not\s*working|error|issue|problem|invalid|weak|rules?|requirements?|policy|reset|forgot)|forgot\s*(?:my\s*)?password|reset\s*(?:my\s*)?password|otp\s*(?:not\s*received|expired|invalid|error)|login\s*(?:failed|error|issue|problem)|passkey\s*(?:issue|help))\b/i.test(rawText)
  ) {
    intent = 'password_auth_rescue';
    return { intent, toolPlan, extracted: { email, phone } };
  }

  // 4d. Bhumivera Client Concierge: GST Invoice / Tax Bill / B2B GSTIN Assistance
  if (
    /^(invoice|gst|gst\s*invoice|tax\s*invoice|bill|receipt)$/i.test(text) ||
    /\b(gst\s*(?:invoice|bill|number|gstin|certificate|credit)|tax\s*invoice|download\s*(?:invoice|bill|receipt)|order\s*(?:invoice|bill|receipt)|b2b\s*invoice)\b/i.test(rawText)
  ) {
    intent = 'gst_invoice_assistance';
    toolPlan.push({
      name: 'lookup_order',
      args: { order_id: orderRef || historyOrderRef || null, email, phone },
    });
    return { intent, toolPlan, extracted: { orderRef: orderRef || historyOrderRef, email, phone } };
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

  const hasActiveMedicalConcern =
    /\b(psoriasis|eczema|infection|infected|open\s+(?:lesions?|wounds?|sores?)|weeping\s+(?:eczema|lesions?|sores?)|active\s+(?:skin\s+)?(?:lesions?|infection))\b/i.test(rawText);
  if (hasActiveMedicalConcern) {
    return { intent: 'knowledge_archive', toolPlan, extracted: { email, phone } };
  }

  const archiveAnswer = findRelevantConciergeAnswer(rawText);
  const isOperationalQuery =
    /\b(price|cost|stock|availability|available|buy|purchase|shipping|delivery|coupon|order|tracking|track)\b/i.test(rawText);
  const asksForProductKnowledge =
    /\b(what|why|how|does|do|can|is|are|will|should|safe|use|ingredient|benefit|work|contain|suitable|explain|tell)\b/i.test(rawText);
  if (archiveAnswer && !isOperationalQuery && asksForProductKnowledge) {
    return { intent: 'knowledge_archive', toolPlan, extracted: { knowledgeEntry: archiveAnswer.number } };
  }

  // Answer common non-order questions directly instead of searching the product catalog.
  if (
    /\b(brand\s+story|about\s+bhumivera|about\s+(?:your|the)\s+brand|tell\s+me\s+about\s+(?:your|the)\s+brand|what\s+is\s+bhumivera|who\s+are\s+you|your\s+philosophy|brand\s+philosophy)\b/i.test(rawText) ||
    /\b(what\s+ingredients?\s+do\s+you\s+use|are\s+your\s+products?\s+natural|how\s+do\s+i\s+choose\s+a\s+product|how\s+do\s+i\s+place\s+an?\s+order|how\s+to\s+order|place\s+an?\s+order|payment\s+methods?|cash\s+on\s+delivery|cod\s+available|contact\s+(?:customer\s+)?support|customer\s+care\s+number)\b/i.test(rawText) ||
    /\b(is\s+this\s+safe\s+for\s+my\s+skin|allerg(?:y|ic)|medical\s+advice)\b/i.test(rawText)
  ) {
    return { intent: 'general_inquiry', toolPlan, extracted: { email, phone } };
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

  // Unknown questions should receive a relevant clarification, not unrelated catalog results.
  intent = 'general_inquiry';
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

  if (esc?.verificationStep === 'STEP_1_VERIFY_ORDER') {
    return {
      reply:
        `${nameGreeting}as part of our **Bhumivera Client Concierge** security protocol, orders that are confirmed or in fulfillment cannot be cancelled automatically via chat, and specialist escalations require order verification first.

` +
        `Please share your **9-digit Order ID (e.g., BHVM815899599)** along with your **Registered Email Address or 10-Digit Phone Number** so I can verify your purchase against our records.`,
      quickActions: [
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Shipping & Return Policy', prompt: 'What are your shipping charges and delivery timelines?' },
      ],
    };
  }

  if (esc?.verificationStep === 'STEP_2_CONTACT_PREFERENCE') {
    const ordNum = esc.verifiedOrder?.orderNumber || '';
    return {
      reply:
        `Thank you for verifying **Order #${ordNum}**. Our specialist team will reach out to you within 12 hours.

` +
        `Would you prefer to receive our update via **Email** or a **Direct Phone Call**?`,
      quickActions: [
        { label: 'Prefer Email Update', prompt: 'Prefer Email update' },
        { label: 'Prefer Direct Phone Call', prompt: 'Prefer Direct Phone Call' },
      ],
    };
  }

  if (esc?.verificationStep === 'STEP_2B_PHONE_AND_SLOT') {
    return {
      reply:
        `Certainly. To schedule your **Direct Phone Call**, please reply with your **10-digit Phone Number** and select your **Preferred Callback Time Slot**:
` +
        `• **Morning:** 10:00 AM – 1:00 PM IST
` +
        `• **Afternoon:** 1:00 PM – 5:00 PM IST
` +
        `• **Evening:** 5:00 PM – 8:00 PM IST`,
      quickActions: [
        { label: 'Morning (10 AM–1 PM)', prompt: 'Morning 10 AM–1 PM' },
        { label: 'Afternoon (1 PM–5 PM)', prompt: 'Afternoon 1 PM–5 PM' },
        { label: 'Evening (5 PM–8 PM)', prompt: 'Evening 5 PM–8 PM' },
      ],
    };
  }

  if (esc?.escalated) {
    const prefDetail = esc.contactPreference === 'phone_call'
      ? `via **Direct Phone Call** (${esc.callbackPhone || 'registered phone'} · **${esc.callbackTimeSlot || 'Scheduled Slot'}**)`
      : `via **Email**`;
    return {
      reply:
        `Your verified specialist request${esc.ticketId ? ` (**#${esc.ticketId}**)` : ''} has been logged with the **Bhumivera Client Concierge** desk. ` +
        `Our specialist team will reach out to you within **12 hours** ${prefDetail}.`,
      quickActions: [
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Check Refund Status', prompt: 'Check the status of my refund' },
      ],
    };
  }

  if (intent === 'knowledge_archive') {
    const question = String(userMessage || '');
    const lowerQuestion = question.toLowerCase();

    if (/\b(psoriasis|eczema|infection|infected|open\s+(?:lesions?|wounds?|sores?)|weeping\s+(?:eczema|lesions?|sores?)|active\s+(?:skin\s+)?(?:lesions?|infection))\b/i.test(question)) {
      return {
        reply:
          'I’m sorry you’re dealing with this. Please consult your medical provider or dermatologist before using a cosmetic product on an active skin or scalp condition. Do not apply products to open or weeping skin, and do not use cosmetic care in place of prescribed treatment. Once your provider confirms it is appropriate, patch test before first use.',
        quickActions: [],
      };
    }

    if (/\bsea\s*buckthorn\b/i.test(question)) {
      const profile = getConciergeKnowledgeAnswer(1);
      const barrier = getConciergeKnowledgeAnswer(5);
      return {
        reply:
          `${profile.answer} ${barrier.answer.replace(/^Absolutely\.\s*/i, '')} Before first use, please perform a 24-hour patch test.`,
        quickActions: [],
      };
    }

    if (/\b(shampoo|reetha|shikakai|bhringraj|rosemary)\b/i.test(question)) {
      const rosemary = getConciergeKnowledgeAnswer(78);
      const bhringraj = getConciergeKnowledgeAnswer(79);
      return {
        reply:
          `Reetha and Shikakai use natural saponins rather than high-foaming chemical sulfates (like SLS/SLES), creating a gentle lather that lifts sebum and buildup while maintaining the scalp’s acidic protective mantle. ${rosemary.answer} ${bhringraj.answer} Before first use, please perform a 24-hour patch test.`,
        quickActions: [],
      };
    }

    if (/\b(face\s*wash|face\s*cleanser|cleanser|charcoal|glycerin|hyaluronic|turmeric|neem)\b/i.test(question)) {
      const charcoal = getConciergeKnowledgeAnswer(37);
      const hydration = getConciergeKnowledgeAnswer(38);
      const turmeric = getConciergeKnowledgeAnswer(39);
      const neem = getConciergeKnowledgeAnswer(40);
      return {
        reply:
          `${charcoal.answer.replace(/^It utilizes/i, 'The 3% Activated Charcoal uses')} ${hydration.answer.replace(/^No\.\s*/i, '')} ${turmeric.answer.replace(/^Haridra/i, 'Haridra (Turmeric)')} ${neem.answer} Before first use, please perform a 24-hour patch test.`,
        quickActions: [],
      };
    }

    const knowledge = findRelevantConciergeAnswer(question);
    if (knowledge) {
      const patchTestAdvice = knowledge.number <= 185 && !/\bpatch\s*test\b/i.test(knowledge.answer)
        ? ' Before first use, please perform a 24-hour patch test.'
        : '';
      return {
        reply: `${knowledge.answer}${patchTestAdvice}`,
        quickActions: [],
      };
    }
  }

  if (intent === 'general_inquiry') {
    const question = String(userMessage || '');
    if (/\b(brand\s+story|about\s+bhumivera|about\s+(?:your|the)\s+brand|tell\s+me\s+about\s+(?:your|the)\s+brand|what\s+is\s+bhumivera|who\s+are\s+you|your\s+philosophy|brand\s+philosophy)\b/i.test(question)) {
      const sourcing = getConciergeKnowledgeAnswer(186);
      const crueltyFree = getConciergeKnowledgeAnswer(187);
      const vegan = getConciergeKnowledgeAnswer(188);
      const testing = getConciergeKnowledgeAnswer(194);
      return {
        reply: `The documented Bhumivera standards include ethical botanical sourcing: ${sourcing.answer} The products are cruelty-free and vegan. ${crueltyFree.answer} ${vegan.answer} ${testing.answer}`,
        quickActions: [
          { label: 'Ask About Ingredients', prompt: 'What ingredients are used in this product?' },
          { label: 'Shipping & Delivery', prompt: 'What are your shipping charges and delivery timelines?' },
        ],
      };
    }
    if (/\b(what\s+ingredients?\s+do\s+you\s+use|are\s+your\s+products?\s+natural)\b/i.test(question)) {
      return {
        reply: 'Ingredients vary by formulation, so I don’t want to guess or give you a brand-wide list that may not apply. Tell me the product name and I can check its listed ingredients and usage details.',
        quickActions: [
          { label: 'Ask About a Product', prompt: 'What are the ingredients in [product name]?' },
          { label: 'Product Availability', prompt: 'Show me available products' },
        ],
      };
    }
    if (/\b(how\s+do\s+i\s+choose\s+a\s+product|is\s+this\s+safe\s+for\s+my\s+skin|allerg(?:y|ic)|medical\s+advice)\b/i.test(question)) {
      return {
        reply: 'I can explain the documented ingredients and directions for a specific product, but I can’t assess an individual allergy or diagnose a skin concern. Please consult a qualified healthcare professional if you have a sensitivity or active condition, and perform a 24-hour patch test before first use.',
        quickActions: [
          { label: 'Ask About Ingredients', prompt: 'What ingredients are used in this product?' },
          { label: 'Product Information', prompt: 'Show me available products' },
        ],
      };
    }
    if (/\b(how\s+do\s+i\s+place\s+an?\s+order|how\s+to\s+order|place\s+an?\s+order)\b/i.test(question)) {
      return {
        reply: 'Choose a product, add it to your bag, then continue to checkout to enter your delivery details and select an available payment method. The site shows applicable delivery charges and payment options before you confirm the order.',
        quickActions: [
          { label: 'Shipping & Delivery', prompt: 'What are your shipping charges and delivery timelines?' },
          { label: 'Payment Options', prompt: 'What payment methods are available?' },
        ],
      };
    }
    if (/\b(cash\s+on\s+delivery|cod\s+available)\b/i.test(question)) {
      return {
        reply: 'Cash on Delivery becomes available after two orders have been successfully delivered. If you meet that requirement, check the payment options shown for your order at checkout.',
        quickActions: [
          { label: 'How to Place an Order', prompt: 'How do I place an order?' },
          { label: 'Shipping & Delivery', prompt: 'What are your shipping charges and delivery timelines?' },
        ],
      };
    }
    if (/\bpayment\s+methods?\b/i.test(question)) {
      return {
        reply: 'Available payment methods are shown during checkout and can depend on your order and eligibility. Cash on Delivery becomes available after two successfully delivered orders.',
        quickActions: [
          { label: 'Cash on Delivery', prompt: 'Is Cash on Delivery available?' },
          { label: 'How to Place an Order', prompt: 'How do I place an order?' },
        ],
      };
    }
    if (/\bcontact\s+(?:customer\s+)?support|customer\s+care\s+number\b/i.test(question)) {
      return {
        reply: 'You can contact Bhumivera support at support@bhumivera.com or by WhatsApp at +91 7430985647. You can also tell me what you need help with here.',
        quickActions: [
          { label: 'Shipping & Delivery', prompt: 'What are your shipping charges and delivery timelines?' },
          { label: 'Order Support', prompt: 'I need help with an order' },
        ],
      };
    }
    return {
      reply: 'I can help with product details, ingredients, usage, shipping, payment options, order tracking, returns, refunds, coupons, and account questions. Tell me a little more about what you’d like to know.',
      quickActions: [
        { label: 'Product Information', prompt: 'Show me available products' },
        { label: 'Shipping & Delivery', prompt: 'What are your shipping charges and delivery timelines?' },
        { label: 'Order Support', prompt: 'I need help with an order' },
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
        `Hello${firstName ? ` ${firstName}` : ''}! Welcome to **Bhumivera Client Concierge**.\n\n` +
        `Here is everything I can help you with right here in chat or on Telegram (@BhumiveraBot):\n` +
        `• **Track Any Order:** Send your 9-digit Order Number or BHVM ID (e.g., \`BHVM815899599\` or \`#918273646\`)\n` +
        `• **Order History:** Type \`my orders\` or \`order history\` to see your recent purchases\n` +
        `• **Returns & Replacements:** Type \`return #<OrderNumber>\` or \`replace #<OrderNumber>\` for instant RMA pickup\n` +
        `• **Order Intervention & Assistance:** Type \`cancel #<OrderNumber>\`\n` +
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

  // Bhumivera Client Concierge: Cart Friction Rescue
  if (intent === 'cart_friction_rescue') {
    const catRes = toolResults.find(t => t.name === 'query_inventory_catalog')?.result;
    const products = (catRes?.products || []).filter(p => p.stockQuantity > 0);
    const inStockList = products
      .slice(0, 3)
      .map(p => `• **${p.name}** (₹${p.effectivePrice} · ${p.stockQuantity} in stock) — ${p.shareUrl}`)
      .join('\n');

    return {
      reply:
        `${nameGreeting}I can help you fix the **Add to Cart** issue right away! Here are the 4 most common reasons and instant fixes:\n` +
        `1. **Option / Pack Size Required:** If a product has pack size or variant pills above the button, click one option first to unlock **Add to Cart**.\n` +
        `2. **Stock Limit Reached:** If your requested quantity exceeds live warehouse stock, reduce the quantity selector to \`1\` or pick an in-stock formulation below.\n` +
        `3. **Quick-Add from Shop:** Open https://www.bhumivera.com/shop and click the green **Shopping Bag** icon on any product card.\n` +
        `4. **Checkout & Coupons:** Once added, open https://www.bhumivera.com/checkout to apply eligible promo codes and complete your order.` +
        (inStockList ? `\n\n**Ready-to-Ship In-Stock Formulations:**\n${inStockList}` : ''),
      quickActions: [
        { label: 'Open Shop Catalog (/shop)', prompt: 'Share Bhumivera website and product links' },
        { label: 'Show Active Coupons', prompt: 'Show my available discount coupons' },
        { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
      ],
    };
  }

  // Bhumivera Client Concierge: Password Setup, Reset & Login Rescue
  if (intent === 'password_auth_rescue') {
    return {
      reply:
        `${nameGreeting}here is your step-by-step **AI Password & Account Recovery Guide**:\n` +
        `• **Password Rules Checklist (Required for New / Reset Passwords):**\n` +
        `  1. **8 to 72 characters** in total\n` +
        `  2. At least **1 Uppercase letter** (\`A–Z\`) and **1 Lowercase letter** (\`a–z\`)\n` +
        `  3. At least **1 Number** (\`0–9\`) and **1 Special Symbol** (\`! @ # $ % ^ & *\`)\n` +
        `  4. Must not be a common password or contain your email username (Example valid format: \`Botanical#2026!\`)\n` +
        `• **Forgot or Unable to Set Password?**\n` +
        `  1. Open **Password Recovery**: https://www.bhumivera.com/forgot-password\n` +
        `  2. Enter your registered email to receive a **6-digit verification code (OTP)** (valid for 10 minutes).\n` +
        `  3. Or ask a Support Specialist in this chat to send you a **1-Click 30-Minute Password Reset Link** directly to your email!`,
      quickActions: [
        { label: 'Send Me a Password Reset Link', prompt: 'Connect me with a human support agent to send a password reset link' },
        { label: 'Check My Orders', prompt: 'Show my recent orders' },
        { label: 'Share All Account Links', prompt: 'Share Bhumivera website and product links' },
      ],
    };
  }

  // Bhumivera Client Concierge: GST Tax Invoice Assistance
  if (intent === 'gst_invoice_assistance') {
    const lookupRes = toolResults.find(t => t.name === 'lookup_order')?.result;
    const latestOrder = lookupRes?.order || lookupRes?.orderCards?.[0] || null;
    const orderLine = latestOrder
      ? `\n• **Your Latest Order (#${latestOrder.orderNumber} / BHVM${latestOrder.orderNumber}):** Status is **${latestOrder.status.toUpperCase()}** (Total: ₹${latestOrder.total}).`
      : '';

    return {
      reply:
        `${nameGreeting}here is how to access your **GST-Compliant Tax Invoice (with HSN, CGST/SGST/IGST Breakup & Bhumivera Crest)**:` +
        orderLine +
        `\n• **Download from Profile:** Sign in at https://www.bhumivera.com/profile → **My Orders** → click **View / Print Tax Invoice** on any shipped or delivered order.\n` +
        `• **Need B2B GSTIN on Your Invoice?** Add your 15-character GSTIN in your shipping address before checkout or share your Order Number (\`BHVM...\`) and GSTIN here so our team can assist you.`,
      quickActions: [
        { label: 'Show My Recent Orders', prompt: 'Show my recent orders' },
        { label: 'Track My Order', prompt: 'Where is my latest order?' },
        { label: 'Talk to Human Agent', prompt: 'Connect me with a human support agent' },
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
  if (!toolResults.length) return deterministicFallback.reply;
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
    const knowledge = findRelevantConciergeAnswer(userMessage);

    const systemPrompt = [
      'You are the Bhumivera Customer Support Assistant (Web & @BhumiveraBot on Telegram).',
      'Rules:',
      '1. Ground every order number, status, price, stock count, RMA, wallet balance, coupon code, and tracking link strictly in the provided TOOL_RESULTS JSON.',
      '2. Always include direct clickable links (e.g. https://www.bhumivera.com/order-tracking or product shareUrl) when available in TOOL_RESULTS.',
      '3. Keep your response concise (2 to 5 sentences or clean bullet points), warm, and directly helpful.',
      '4. Never expose raw passwords, full payment card numbers, CVVs, OTPs, or JWTs.',
      '5. Ground product, formulation, usage, and safety facts only in KNOWLEDGE_ARCHIVE_ENTRY. Do not add unverified efficacy claims or guess missing product facts.',
      '6. Always recommend a 24-hour patch test before first use of a topical or haircare product.',
      '7. For active medical conditions, open lesions, or infection, advise the customer to consult their medical provider and do not present cosmetics as treatment.',
      `Customer Name: ${user?.name || 'Guest'}`,
      `Recent Conversation:\n${recentTurns || 'None'}`,
      `KNOWLEDGE_ARCHIVE_ENTRY:\n${knowledge ? `Q${knowledge.number}: ${knowledge.question}\nA: ${knowledge.answer}` : 'No relevant archive entry. Do not make product or formulation claims.'}`,
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

  // Anti-Spam 3-Step Verification & Human-Like Concierge Escalation Flow:
  // NEVER auto-generate a database ticket just because a user types 'human', 'cancel order', or 'connect me to an associate'.
  let escalationInfo = {
    escalated: false,
    ticketId: session.escalatedTicketId || null,
    verificationStep: null,
    verifiedOrder: null,
  };

  const slotMatch = String(message || '').match(/\b(morning|10\s*am|afternoon|1\s*pm|evening|5\s*pm)\b/i);
  const prefEmailMatch = /\b(via\s*email|by\s*email|prefer\s*email|email\s*update|send\s*email|^email$)\b/i.test(String(message || '').trim());
  const prefPhoneMatch = /\b(phone\s*call|direct\s*call|call\s*me|callback|call\s*back|^call$|^phone$)\b/i.test(String(message || '').trim());
  const wantsEscalationOrCancel =
    intent === 'human_escalation' ||
    intent === 'cancel_order' ||
    intent === 'cancel_assistance' ||
    Boolean(session.pageContext?.awaitingConciergeVerification) ||
    Boolean(session.pageContext?.verifiedOrderForEscalation);

  if (wantsEscalationOrCancel && session.status !== 'escalated') {
    const verifiedOrderCard = collectedOrderCards[0] || session.pageContext?.verifiedOrderForEscalation || null;

    if (!verifiedOrderCard) {
      // Step 1: Require Order ID + Registered Email/Phone verification against DB
      escalationInfo.verificationStep = 'STEP_1_VERIFY_ORDER';
      await updateSessionContext(session.id, { awaitingConciergeVerification: true }, {}, activePool);
    } else if (!prefEmailMatch && !prefPhoneMatch && !slotMatch && !session.pageContext?.selectedContactPreference) {
      // Step 2: Order verified! Ask for Contact Preference (Email vs Direct Phone Call)
      escalationInfo.verificationStep = 'STEP_2_CONTACT_PREFERENCE';
      escalationInfo.verifiedOrder = verifiedOrderCard;
      await updateSessionContext(
        session.id,
        {
          awaitingConciergeVerification: false,
          verifiedOrderForEscalation: {
            id: verifiedOrderCard.id,
            orderNumber: verifiedOrderCard.orderNumber,
            status: verifiedOrderCard.status,
            total: verifiedOrderCard.total,
          },
        },
        {},
        activePool
      );
    } else {
      const chosenPref = prefPhoneMatch || slotMatch || session.pageContext?.selectedContactPreference === 'phone_call'
        ? 'phone_call'
        : 'email';
      const candidatePhone = String(extracted.phone || resolvedUser?.phone || session.guestPhone || '').replace(/\D/g, '').slice(-10);
      const chosenSlot = slotMatch
        ? (/morning|10/i.test(slotMatch[0]) ? 'Morning (10:00 AM – 1:00 PM IST)' : /afternoon|1/i.test(slotMatch[0]) ? 'Afternoon (1:00 PM – 5:00 PM IST)' : 'Evening (5:00 PM – 8:00 PM IST)')
        : (session.pageContext?.callbackTimeSlot || null);

      if (chosenPref === 'phone_call' && (candidatePhone.length !== 10 || !chosenSlot)) {
        escalationInfo.verificationStep = 'STEP_2B_PHONE_AND_SLOT';
        escalationInfo.verifiedOrder = verifiedOrderCard;
        await updateSessionContext(
          session.id,
          {
            selectedContactPreference: 'phone_call',
            callbackPhone: candidatePhone.length === 10 ? candidatePhone : null,
            callbackTimeSlot: chosenSlot,
          },
          {},
          activePool
        );
      } else {
        // Step 3: Both Verification AND Contact Preference complete -> Create single structured Escalation Ticket
        emit('status', { phase: 'escalating', label: 'Logging verified specialist escalation request...' });
        const escRes = await triggerInstantEscalation({
          pool: activePool,
          session,
          user: resolvedUser,
          sentiment,
          recentMessages: [...history.slice(-4), { sender: 'user', content: message }],
          orderId: verifiedOrderCard.id,
          reason: `Verified Order #${verifiedOrderCard.orderNumber} (${chosenPref === 'phone_call' ? `Phone Callback: ${candidatePhone} · ${chosenSlot}` : `Email Update: ${extracted.email || resolvedUser?.email || session.guestEmail}`})`,
        });

        try {
          const { computeQuantumHash512 } = require('../utils/fortressCrypto');
          const ticketRef = `BV-ESC-${verifiedOrderCard.orderNumber}-${Date.now().toString().slice(-4)}`;
          const sig512 = computeQuantumHash512({ ticketRef, orderId: verifiedOrderCard.id, chosenPref, candidatePhone, chosenSlot }, 'ESC_TICKET_512');
          await activePool.query(
            `INSERT INTO support_escalation_tickets
              (ticket_reference, session_id, user_id, order_id, order_number, verified_email, verified_phone,
               contact_preference, callback_phone, callback_time_slot, inquiry_category, query_details, status, sla_deadline, signature_sha512)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Order Intervention', ?, 'open', DATE_ADD(NOW(), INTERVAL 12 HOUR), ?)`,
            [
              ticketRef,
              session.id,
              resolvedUser?.id || session.userId || 1,
              verifiedOrderCard.id,
              String(verifiedOrderCard.orderNumber || verifiedOrderCard.id),
              extracted.email || resolvedUser?.email || session.guestEmail || null,
              candidatePhone || null,
              chosenPref,
              chosenPref === 'phone_call' ? candidatePhone : null,
              chosenPref === 'phone_call' ? chosenSlot : null,
              String(message || '').slice(0, 2000),
              sig512,
            ]
          );
        } catch {}

        await updateSessionContext(
          session.id,
          {
            awaitingConciergeVerification: false,
            verifiedOrderForEscalation: null,
            selectedContactPreference: null,
          },
          {},
          activePool
        );

        escalationInfo = {
          escalated: true,
           verificationStep: 'STEP_3_COMPLETED',
          ticketId: escRes?.ticketId || null,
          contactPreference: chosenPref,
          callbackPhone: candidatePhone || null,
          callbackTimeSlot: chosenSlot || null,
          priority: sentiment.priority || 'High',
          slaResponseWindow: 'Within 12 hours',
        };
      }
    }
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
  const hasCatalogProducts = executedTools.some(
    tool => tool.name === 'query_inventory_catalog' && tool.result?.products?.length
  );
  const productKnowledgeQuery =
    /\b(ingredient|how\s+to\s+use|safe|suitable|benefit|skin|hair|face\s*wash|face\s*cleanser|shampoo|sea\s*buckthorn)\b/i.test(message);
  const replyWithSafetyAdvice =
    hasCatalogProducts && productKnowledgeQuery && !/\bpatch\s*test\b/i.test(finalReply)
      ? `${finalReply} Before first use, please perform a 24-hour patch test.`
      : finalReply;

  if (typeof onStreamEvent === 'function') {
    const chunks = replyWithSafetyAdvice.match(/.{1,18}(\s|$)|\S+/g) || [replyWithSafetyAdvice];
    for (const chunk of chunks) {
      emit('token', { text: chunk });
    }
  }

  const savedAssistantMessage = await appendMessage({
    sessionId: session.id,
    sender: 'assistant',
    content: replyWithSafetyAdvice,
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
    reply: replyWithSafetyAdvice,
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
