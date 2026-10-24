'use strict';

const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');
const { analyzeSentiment, triggerInstantEscalation } = require('./sentimentEscalationEngine');
const SUPPORT_REQUEST_PATTERN = /^(?:agent|human|support|live\s*agent|executive|supervisor|manager|escalate|helpdesk)$|\b(?:customer support|support team|(?:need|want|request)\s+(?:some\s+)?support|(?:need|want|request)\s+(?:a\s+)?human(?:\s+(?:agent|support))?|live\s*agent|real\s*person|customer\s*care|speak\s*to\s*(?:someone|agent|manager|supervisor)|talk\s*to\s*(?:agent|human|person|support)|connect\s*me\s*(?:to|with)\s*(?:an?\s*)?(?:agent|human|support)|escalat(?:e|ion))\b/i;
const ORDER_SUPPORT_PATTERN = /\b(?:order|delivery|shipping|payment|return|refund|replacement|tracking|parcel|package)\b/i;
const { executeSupportTool, SUPPORT_TOOLS_REGISTRY } = require('./aiSupportTools');
const {
  COMPLETE_SITE_NAVIGATION_MAP,
  evaluatePasswordRequirements,
  findRelevantNavigationLinks,
} = require('./aiCopilotRescueService');
const {
  INGREDIENT_MEMORY_GRAPH,
  PRODUCT_INGREDIENT_GRAPH,
  KNOWLEDGE_BASE_QA,
  searchAllKnowledgeSources,
  buildIngredientFollowUpSuggestions,
  buildProductIngredientSuggestions,
} = require('./bhumiveraKnowledgeBase');
const {
  synthesizeWithGeminiOrDeterministic,
} = require('./geminiService');
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
    { id: 'know_sb_fw', label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
    { id: 'ing_niacinamide', label: 'Ingredient: Niacinamide', prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash' },
    { id: 'how_to_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
    { id: 'active_coupons', label: 'Active Coupons', prompt: 'Show my available discount coupons' },
  ];

  if (proactiveTrigger === 'checkout_linger' || pathname.includes('/checkout')) {
    greeting = `${greetingPrefix} need a hand with shipping, coupons, or payment at checkout? Orders placed before 2:00 PM IST dispatch the same day.`;
    quickActions = [
      { id: 'active_coupons', label: 'Available Coupons', prompt: 'Show my available discount coupons' },
      { id: 'wallet_points', label: 'Check Wallet & Points', prompt: 'Check my wallet balance and loyalty points' },
      { id: 'delivery_time', label: 'Delivery Timeline', prompt: 'When will my order arrive if I order today?' },
      { id: 'payment_opts', label: 'Payment Options', prompt: 'What payment options do you accept at checkout?' },
    ];
  } else if (proactiveTrigger === 'rage_click') {
    greeting = `${greetingPrefix} it looks like something on this page isn't responding as expected. Tell me what you're trying to do and I'll help right away.`;
  } else if (pathname.includes('/order-tracking') || pathname.includes('/profile')) {
    greeting = `${greetingPrefix} I can help with product, policy, reward, and website questions. For help with a specific order, use Customer Support in your profile.`;
    quickActions = [
      { id: 'order_support', label: 'Open Customer Support', prompt: '__OPEN_SUPPORT_CENTER__' },
      { id: 'how_to_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
      { id: 'know_sb_fw', label: 'Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
    ];
  } else if (pathname.includes('/product/') || pathname.includes('/science') || pathname.includes('/somatic-registry')) {
    const prodName = pageContext?.productName || 'Sea Buckthorn Face Wash';
    greeting = `${greetingPrefix} ask me anything about ${prodName}, including its listed botanical ingredients, Niacinamide & Hyaluronic Acid synergy, or AM/PM usage timing.`;
    quickActions = [
      { id: 'know_sb_fw', label: `Know More: ${prodName}`, prompt: `Tell me about ${prodName} and its key ingredients` },
      { id: 'ing_niacinamide', label: 'Explore Niacinamide', prompt: `Tell me about Niacinamide in ${prodName}` },
      { id: 'ing_hyaluronic', label: 'Explore Hyaluronic Acid', prompt: `Tell me about Hyaluronic Acid in ${prodName}` },
      { id: 'usage_time', label: 'How & What Time to Use', prompt: `How do I really use ${prodName} step-by-step and what time of day should I use it?` },
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
 * Handles Website and Mobile App support queries.
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
  const orderFollowUp = Boolean(
    historyOrderRef &&
    /\b(?:it|that|my order|shipment|package|payment)\b.{0,50}\b(?:delayed|late|lost|paid|charged|refund|total|amount|tracking|courier|delivery|arrive|deliver|ship|status|invoice|address|items?|products?)\b|\b(?:where is it|when will it arrive|any update on it|has it shipped)\b/i.test(rawText)
  );

  const rmaMatch = rawText.match(/\b(RMA-[A-Z0-9]{6,12})\b/i);
  const serialMatch = rawText.match(/\b(BV-[A-Z0-9-]{5,20}|BHM[V]?-[A-Z0-9-]{5,20})\b/i);
  const emailMatch = rawText.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const phoneMatch = rawText.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);

  const email = emailMatch?.[0] || user?.email || null;
  const phone = phoneMatch?.[1] || user?.phone || null;

  const toolPlan = [];
  let intent = 'general_inquiry';
  const returnPolicyQuestion =
    /\b(?:what\s+is\s+(?:your|the)\s+return\s+policy|how\s+do\s+returns?\s+work)\b/i.test(rawText);
  const orderSupportRequest = !returnPolicyQuestion && Boolean(
    orderRef ||
    orderFollowUp ||
    rmaMatch ||
    /\b(?:initiate|start|request|process|submit)\s+(?:a\s+)?(?:return|replacement|refund)\b|\b(?:want|need|request)\s+(?:a\s+)?(?:refund|return|replacement)\b|\b(?:how\s+(?:can|do)\s+i|would\s+like\s+to|want\s+to|need\s+to)\s+(?:return|replace|exchange|refund)\b|\b(?:want|need|would like|request)\s+to\s+cancel\b|\bcancel\s+(?:my|this|the)\b|\breturn\s+(?:my|this|the)\s+(?:item|product|purchase|package)\b|\b(?:my|your)\s+(?:gst\s+)?(?:tax\s+)?(?:invoice|receipt|order\s+history|purchase\s+history)\b|\bwhat\s+(?:did|have)\s+i\s+order(?:ed)?\b/i.test(rawText) ||
    /\b(?:my|this|that|latest|recent)\s+(?:orders?|delivery|shipment|package|parcel|refund|return)\b|\b(?:where\s+is|when\s+will|check)\s+my\s+(?:order|delivery|shipment|package|parcel|refund)\b|\border\b.{0,40}\b(?:status|details|history|track|tracking|cancel|return|refund|invoice|delivery|placed|arrive|shipped)\b|\b(?:track|cancel|return|replace|refund|invoice)\b.{0,40}\border\b|\b(?:refund\s+status|return\s+status|download\s+(?:my\s+)?invoice|send\s+me\s+(?:my\s+)?invoice)\b|^(?:orders?|tracking|refund\s*status|rma\s*status|cancel|cancellation|return|returns|replace|replacement)$/i.test(rawText)
  );
  if (orderSupportRequest) {
    return {
      intent: 'order_support_redirect',
      toolPlan,
      extracted: { orderRef: null, email: null, phone: null },
    };
  }
  if (
    (
      /^(agent|human|support|live\s*agent|executive|supervisor|manager|escalate|helpdesk)$/i.test(text) ||
      SUPPORT_REQUEST_PATTERN.test(rawText) ||
      (/\bcustomer\s+support\b/i.test(rawText) && /\b(?:need|want|request|contact|speak|talk|connect)\b/i.test(rawText))
    )
  ) {
    return {
      intent: 'customer_support_redirect',
      toolPlan,
      extracted: { orderRef: null, email: null, phone: null },
    };
  }

  // 1. Human agent / escalation request
  if (
    /^(agent|human|support|live\s*agent|executive|supervisor|manager|escalate|helpdesk)$/i.test(text) ||
    SUPPORT_REQUEST_PATTERN.test(rawText) ||
    (/\bcustomer\s+support\b/i.test(rawText) && /\b(?:need|want|request|contact|speak|talk|connect)\b/i.test(rawText))
  ) {
    intent = 'human_escalation';
    if (orderRef) {
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

  // 3. Return / Replacement / Damaged item intent (excluding general policy question "what is your return policy")
  if (
    !/\b(what\s+is\s+(?:your|the)\s+return\s+policy|how\s+do\s+returns?\s+work|shipping\s+charges?)\b/i.test(rawText) &&
    (/^(return|returns|replace|replacement|exchange|rma|damaged|defective|leaking|broken)$/i.test(text) ||
      /\b(initiate\s*(?:a\s*)?return|return\s*(?:my\s*|this\s*|the\s*|an?\s*)?(?:order|item|product|bottle|jar|package|#\d+)|want\s*to\s*(?:return|replace|exchange)|replace\s*(?:my\s*|this\s*)?(?:order|item|product|#\d+)|damaged\s*(?:item|product|bottle|box|order)|wrong\s*(?:item|product)|defective|leaking|broken)\b/i.test(rawText))
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
    /\b(unable\s*to\s*(?:set|reset|change|create)\s*password|can'?t\s*(?:set|reset|change|login|sign\s*in)|cannot\s*(?:set|reset|change|login|sign\s*in)|password\s*(?:not\s*working|error|issue|problem|invalid|weak|rules?|requirements?|policy|reset|forgot)|forgot\s*(?:my\s*)?password|reset\s*(?:my\s*)?password|otp\s*(?:not\s*received|expired|invalid|error)|login\s*(?:failed|error|issue|problem))\b/i.test(rawText)
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

  // 4e. Brand Ambassador Program / How to Join Ambassador Program (Before generic wallet check!)
  if (
    /\b(brand\s*ambassador|ambassador\s*program|join\s*(?:the\s*)?(?:bhumivera\s*)?(?:brand\s*)?ambassador|how\s*do\s*i\s*join\s*(?:the\s*)?(?:bhumivera|affiliate|ambassador|referral)|become\s*an?\s*(?:ambassador|partner|affiliate)|ambassador\s*(?:rewards?|tiers?|link))\b/i.test(rawText)
  ) {
    intent = 'knowledge_or_ambassador_inquiry';
    return { intent, toolPlan, extracted: { email } };
  }

  // 5. Account Wallet, Referral Balance & Loyalty Points check
  if (
    /^(wallet|points|loyalty|balance|referral|tier|rewards)$/i.test(text) ||
    /\b(wallet\s*balance|my\s*wallet|check\s*my\s*wallet|loyalty\s*points?|my\s*points|referral\s*(?:balance|code|wallet)|shopping\s*wallet|how\s*many\s*points)\b/i.test(rawText)
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
    /\b(coupon\s*codes?|available\s*(?:discount\s*)?coupons?|my\s*coupons?|active\s*(?:coupons?|offers?)|promo\s*codes?|discount\s*codes?|spin\s*rewards?|any\s*offers?|show\s*(?:me\s*)?active\s*coupons?)\b/i.test(rawText)
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
    /\b(share\s*(?:a\s*|the\s*|bhumivera\s*)?(?:website\s*(?:and\s*product\s*)?)?links?|website\s*link|store\s*link|shop\s*link|tracking\s*link|product\s*link|send\s*(?:me\s*)?(?:a\s*|the\s*)?link|give\s*(?:me\s*)?(?:a\s*|the\s*)?link)\b/i.test(rawText)
  ) {
    intent = 'share_links';
    const cleanedQuery = rawText
      .replace(/\b(share|send|give|me|a|the|link|links|url|for|of|to|website|and|product|bhumivera|please)\b/gi, ' ')
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
    orderFollowUp ||
    /\borders?\b/i.test(rawText) ||
    /^(order|orders|my\s*orders?|order\s*history|history|track|tracking|shipment|delivery|status|dispatch|package|parcel)$/i.test(text) ||
    /\b(where\s*is\s*my\s*(?:latest\s*)?order|track\s*(?:my\s*)?(?:order|package|shipment)|order\s*(?:status|history|details|update|tracking|list)|delivery\s*(?:status|date|time|estimate|update)|when\s*will\s*(?:my\s*order|it)\s*(?:arrive|deliver|ship)|latest\s*order|recent\s*orders?|past\s*orders?|all\s*(?:my\s*)?orders|my\s*orders?|check\s*order|tracking\s*(?:id|number|details)|show\s*(?:the\s*status\s*of\s*)?my\s*(?:recent|latest)\s*orders?)\b/i.test(rawText) ||
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

  // 11b. General Inquiries & High-Level Storefront / Knowledge Overview
  if (
    /\b(general\s*(?:question|inquiry|inquiries)|products?,\s*ingredients?,\s*or\s*policies|about\s*bhumivera|store\s*policies|general\s*help)\b/i.test(rawText) ||
    /^(general|policies|products\s*and\s*policies|help\s*me)$/i.test(text)
  ) {
    intent = 'general_inquiry';
    return { intent, toolPlan: [], extracted: { email, phone } };
  }

  // 12. Product, Ingredient Deep-Dive, Usage/Timing, Catalog & Policy Queries
  intent = 'catalog_or_policy';
  const cleanedQuery = rawText
    .replace(/\b(is|are|what|the|of|for|in|stock|available|price|cost|ingredients?|how|to|use|tell|me|about|do|you|have|show|products?|catalog|shop|buy|recommend|best|sellers?|know|more|key)\b/gi, ' ')
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
  return { intent, toolPlan, extracted: { query: cleanedQuery, orderRef, email, phone } };
}

/**
 * Synthesizes a grounded, natural customer support response from executed tool outputs and Knowledge Base matches.
 */
function synthesizeDeterministicResponse({
  intent,
  userMessage,
   message,
  toolResults = [],
  knowledgeResult = null,
  sentiment = {},
  escalation = null,
  escalationInfo = null,
  user = null,
} = {}) {
  const effectiveUserMessage = userMessage || message || '';
  const firstName = user?.name ? user.name.split(' ')[0] : '';
  const nameGreeting = firstName ? `${firstName}, ` : '';
  const esc = escalation || escalationInfo;

  if (intent === 'order_support_redirect' || intent === 'customer_support_redirect') {
    return {
      reply:
        `${nameGreeting}I can help with product questions, ingredients, policies, rewards, and website guidance. ` +
        `For order details, delivery updates, returns, refunds, or changes, please use **Profile → Support** so the customer-care team can securely review your request.`,
      quickActions: [
        { label: 'Open Customer Support', prompt: '__OPEN_SUPPORT_CENTER__' },
        { label: 'Ask a Website Question', prompt: 'I have a question about Bhumivera products or policies.' },
      ],
    };
  }

  if (intent === 'human_escalation' && !esc?.followUpRequested) {
    return {
      reply:
        `${nameGreeting}I’m an automated assistant, so there isn’t a live agent in this chat. I can still help with common questions here. ` +
        `If you still need a follow-up after sharing the issue, ask for customer support again. For an order-related request, we’ll verify the order before recording it for later review.`,
      quickActions: [
        { label: 'Order-related issue', prompt: 'I need help with an order.' },
        { label: 'General question', prompt: 'I have a general question.' },
      ],
    };
  }

  if (intent === 'human_escalation' && esc?.followUpRequested && !esc?.verificationStep) {
    return {
      reply:
        `${nameGreeting}I’ve noted your request in this conversation for later review. This is not a live-agent chat, so a reply may take some time. ` +
        `For an order-related issue, please choose **Order-related issue** and verify your order details.`,
      quickActions: [
        { label: 'Order-related issue', prompt: 'I need help with an order.' },
        { label: 'General question', prompt: 'I have a general question.' },
      ],
    };
  }

  if (esc?.verificationStep === 'STEP_1_VERIFY_ORDER') {
    return {
      reply:
        `${nameGreeting}as part of our **Bhumivera Client Concierge** security protocol, order-related follow-up requests require verification first.\n\n` +
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
        `Thank you for verifying **Order #${ordNum}**. Your follow-up request can be recorded for later review; replies are not live and may take some time.\n\n` +
        `Would you prefer an update via **Email** or a **Phone Call**?`,
      quickActions: [
        { label: 'Prefer Email Update', prompt: 'Prefer Email update' },
        { label: 'Prefer Direct Phone Call', prompt: 'Prefer Direct Phone Call' },
      ],
    };
  }

  if (esc?.verificationStep === 'STEP_2B_PHONE_AND_SLOT') {
    return {
      reply:
        `Certainly. To schedule your **Direct Phone Call**, please reply with your **10-digit Phone Number** and select your **Preferred Callback Time Slot**:\n` +
        `• **Morning:** 10:00 AM – 1:00 PM IST\n` +
        `• **Afternoon:** 1:00 PM – 5:00 PM IST\n` +
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
      ? ` via **Direct Phone Call** (${esc.callbackPhone || 'registered phone'} · **${esc.callbackTimeSlot || 'Scheduled Slot'}**)`
      : esc.contactPreference === 'email'
      ? ` via **Email**`
      : '';
    return {
      reply:
        `Your verified follow-up request has been recorded${esc.ticketId ? ` (ticket #${esc.ticketId})` : ''}. ` +
        `A team member will review it and reply when available; this is not a live-agent chat${prefDetail}.`,
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
        `Hello${firstName ? ` ${firstName}` : ''}! Welcome to **Bhumivera Client Concierge**.\n\n` +
        `I can help with botanical products and ingredients, skincare routines, website navigation, shipping and return policies, rewards, and personalized skin guidance. ` +
        `For details or changes relating to a specific order, please use **Profile → Support** so customer care can review it securely.`,
      quickActions: [
        { id: 'know_sb_fw', label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
        { id: 'ing_niacinamide', label: 'Ingredient: Niacinamide', prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash' },
        { id: 'how_to_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
        { id: 'my_orders', label: 'My Orders & Tracking', prompt: 'Show my recent orders' },
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
        { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
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
        `• **Botanical Science & Ingredients Guide:** https://www.bhumivera.com/science\n` +
        `• **Somatic Label Registry:** https://www.bhumivera.com/somatic-registry\n` +
        `• **Live Order Tracking:** https://www.bhumivera.com/order-tracking\n` +
        `• **Customer Profile & Ambassador Program:** https://www.bhumivera.com/profile\n` +
        `• **E-Warranty & Serial Check:** https://www.bhumivera.com/e-warranty\n` +
        referralLine +
        (productLinks ? `\n\n**Featured Product Share Links:**\n${productLinks}` : ''),
      quickActions: [
        { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
        { label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
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
          { label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
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
        (s.referralCode ? `\n• **Your Brand Ambassador Referral Code:** \`${s.referralCode}\` — Share link: ${s.referralShareUrl}` : ''),
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
          { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
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
        { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
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
            `I can help with your order cancellation request. ` +
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
          { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
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
      const paymentBreakdown = [
        `Subtotal: ₹${Number(o.subtotal || 0).toLocaleString('en-IN')}`,
        `discount: ₹${Number(o.discount || 0).toLocaleString('en-IN')}`,
        Number(o.tierDiscount) > 0 ? `tier discount: ₹${Number(o.tierDiscount).toLocaleString('en-IN')}` : '',
        Number(o.referralWalletAmount) > 0 ? `wallet applied: ₹${Number(o.referralWalletAmount).toLocaleString('en-IN')}` : '',
        `shipping: ₹${Number(o.shippingCost || 0).toLocaleString('en-IN')}`,
      ].filter(Boolean).join(' · ');
      const rewardLines = [
        o.couponCode ? `• **Coupon used:** ${o.couponCode}\n` : '',
        Number(o.loyaltyPointsRedeemed) > 0 ? `• **Loyalty points redeemed:** ${Number(o.loyaltyPointsRedeemed).toLocaleString('en-IN')}\n` : '',
        Number(o.loyaltyPointsAwarded) > 0 ? `• **Loyalty points earned:** ${Number(o.loyaltyPointsAwarded).toLocaleString('en-IN')}\n` : '',
        Number(o.impactAmount) > 0 ? `• **Nature-impact pledge:** ₹${Number(o.impactAmount).toLocaleString('en-IN')}\n` : '',
      ].join('');

      const actions = [];
      const isCancellable = ['pending', 'confirmed', 'placed', 'processing'].includes(String(o.status || '').toLowerCase());
      if (isCancellable) {
        actions.push({ label: `Cancel Order #${o.orderNumber}`, prompt: `I want to cancel order #${o.orderNumber}` });
      } else if (o.status === 'delivered') {
        actions.push({ label: 'Verify Bottle Serial', prompt: `I want to verify the bottle serial for order #${o.orderNumber}` });
      } else {
        actions.push({ label: 'Track Consignment', prompt: `Track order #${o.orderNumber}` });
      }
      actions.push({ label: 'Show All My Orders', prompt: 'Show my recent orders' });

      return {
        reply:
          `${nameGreeting}here are the live details for **Order #${o.orderNumber}** (\`BHVM${o.orderNumber}\`):\n` +
          `• **Status:** ${o.status.toUpperCase()}\n` +
          `• **Estimated Delivery:** ${o.deliveryEstimate}\n` +
          (o.createdAt ? `• **Placed:** ${new Date(o.createdAt).toLocaleString('en-IN')}\n` : '') +
          `• **Shipment:** ${trackingLine}\n` +
          `• **Payment:** ${o.paymentMode} (${o.paymentStatus}) — Total: **₹${o.total}**\n` +
          (o.paymentId ? `• **Payment Reference:** ${o.paymentId}\n` : '') +
          `• **Order breakdown:** ${paymentBreakdown}\n` +
          (itemsLine ? `• **Items:** ${itemsLine}\n` : '') +
          rewardLines +
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
        const returnHint =
          `🌿 **Strict 100% Non-Returnable Policy**:\n` +
          `All Bhumivera formulations are intimate personal care cosmetics sealed with tamper-evident security. Once shipped or delivered, **all items are 100% non-returnable**.\n\n` +
          `• **Pre-Dispatch Order Cancellation**: You can cancel an order **only if it has not yet been packed and shipped** (status Pending, Confirmed, or Processing).\n` +
          `• **Damaged in Transit / Defective Parcel**: If an item arrived damaged or leaking, submit an uncut 360° unboxing video within 48 hours for direct replacement or refund without return shipping.`;
        const cancellable = lookupResult.orderCards.filter(ord =>
          ['pending', 'confirmed', 'placed', 'processing'].includes(String(ord.status || '').toLowerCase())
        );
        return {
          reply: `Here are the orders on your account:\n${historyLines}\n\n${returnHint}`,
          quickActions: [
            ...(cancellable.length
              ? [{ label: `Cancel Order #${cancellable[0].orderNumber}`, prompt: `I want to cancel order #${cancellable[0].orderNumber}` }]
              : []),
            { label: 'Talk to Human Specialist', prompt: 'Connect me with a human support agent' },
          ],
        };
      }

      if (intent === 'cancel_assistance') {
        const cancellable = lookupResult.orderCards.filter(ord =>
          ['pending', 'confirmed', 'placed', 'processing'].includes(String(ord.status || '').toLowerCase())
        );
        const cancelHint =
          `Orders can only be cancelled **before they are packed and shipped** from our warehouse. ` +
          `Once an order enters Packed or Shipped status, courier dispatch is locked and cannot be cancelled or recalled. Delivered items are 100% non-returnable.`;
        return {
          reply: `Here are the orders on your account:\n${historyLines}\n\n${cancelHint}`,
          quickActions: [
            ...(cancellable.length
              ? [{ label: `Cancel Order #${cancellable[0].orderNumber}`, prompt: `I want to cancel order #${cancellable[0].orderNumber}` }]
              : []),
            { label: 'Talk to Human Specialist', prompt: 'Connect me with a human support agent' },
          ],
        };
      }

      const actions = [];
      const latestCancellable = ['pending', 'confirmed', 'placed', 'processing'].includes(String(latest.status || '').toLowerCase());
      if (latestCancellable) {
        actions.push({ label: `Cancel Order #${latest.orderNumber}`, prompt: `I want to cancel order #${latest.orderNumber}` });
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
          { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
          { label: 'Shipping Policy', prompt: 'What are your shipping charges and delivery timelines?' },
        ],
      };
    }
  }

  // Check if Shipping Policy was explicitly asked before Knowledge Base
  const catalogResult = toolResults.find(t => t.name === 'query_inventory_catalog')?.result;
  const isShippingQuestion = /\b(shipping|delivery\s*charge|free\s*shipping|express|cutoff|delivery\s*timelines?)\b/i.test(effectiveUserMessage);

  if (catalogResult && isShippingQuestion) {
    const policy = catalogResult.shippingPolicy;
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
        { label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
        { label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
      ],
    };
  }

  // If our Product/Ingredient Knowledge Graph or 300+ Q&A Knowledge Base matched, return it with its dynamic contextual suggestions!
  if (knowledgeResult?.matched) {
    return {
      reply: knowledgeResult.reply,
      quickActions: knowledgeResult.quickActions,
    };
  }

  if (catalogResult && catalogResult.products?.length > 0) {
    const policy = catalogResult.shippingPolicy;
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
        { id: 'know_sb_fw', label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
        { id: 'ing_niacinamide', label: 'Ingredient: Niacinamide', prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash' },
        { id: 'how_to_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
        { id: 'show_coupons', label: 'Show Active Coupons', prompt: 'Show my available discount coupons' },
      ],
    };
  }

  return {
    reply:
      `Welcome to **Bhumivera Client Concierge**. I can help with our products, ingredients, skincare routines, website guidance, rewards, and store policies. ` +
      `For a specific order, delivery, return, or refund request, please open **Profile → Support** to contact customer care.`,
    quickActions: [
      { id: 'know_sb_fw', label: 'Know More: Sea Buckthorn Face Wash', prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients' },
      { id: 'ing_niacinamide', label: 'Ingredient: Niacinamide', prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash' },
      { id: 'how_to_join', label: 'Brand Ambassador Program', prompt: 'How do I join the Bhumivera Brand Ambassador Program?' },
      { id: 'usage_guide', label: 'How & What Time to Use Face Wash', prompt: 'How do I really use Sea Buckthorn Face Wash and what time of day should I use it?' },
    ],
  };
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

  const mergedPageContext = { ...(session.pageContext || {}), ...(pageContext || {}) };

  // Detect intent and plan autonomous tool calls
  const { intent, toolPlan, extracted } = detectIntentAndToolPlan(message, {
    user: resolvedUser,
    pageContext: mergedPageContext,
    history,
  });
  const priorSupportRequests = history.filter(
    entry => entry.sender === 'user' && SUPPORT_REQUEST_PATTERN.test(String(entry.content || ''))
  ).length;
  const followUpRequested = intent === 'human_escalation' && priorSupportRequests > 0;
  const isOrderRelatedSupportRequest =
    session.pageContext?.supportCategory === 'order' ||
    pageContext?.supportCategory === 'order' ||
    ORDER_SUPPORT_PATTERN.test(message) ||
    history.some(entry => entry.sender === 'user' && ORDER_SUPPORT_PATTERN.test(String(entry.content || '')));

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
      pageContext: mergedPageContext,
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

  // Consult Bhumivera Knowledge Graph (Product -> Ingredient -> 2+1+Usage State Machine + 300+ Q&As)
  let knowledgeResult = null;
  if (['catalog_or_policy', 'knowledge_or_ambassador_inquiry', 'general_inquiry'].includes(intent)) {
    const liveCatalogProducts = executedTools.find(t => t.name === 'query_inventory_catalog')?.result?.products || [];
    // Do not override if the customer explicitly asked about a database catalog SKU like Kumkumadi price/stock unless it's an ingredient/ambassador/facewash/Q&A query
    const isExplicitlyShipping = /\b(shipping\s*charge|free\s*shipping|delivery\s*charge|dispatch\s*cutoff)\b/i.test(message || '');
    if (!isExplicitlyShipping) {
      knowledgeResult = await searchAllKnowledgeSources(message, {
        pool: activePool,
        sessionContext: mergedPageContext.conciergeFlow || {},
        liveCatalogProducts,
      });
      if (knowledgeResult?.matched && knowledgeResult.updatedContext) {
        await updateSessionContext(
          session.id,
          {
            conciergeFlow: {
              ...(mergedPageContext.conciergeFlow || {}),
              ...knowledgeResult.updatedContext,
            },
          },
          {},
          activePool
        );
      }
    }
  }

  // Anti-Spam 3-Step Verification & Human-Like Concierge Escalation Flow
  let escalationInfo = {
    escalated: false,
    ticketId: session.escalatedTicketId || null,
    verificationStep: null,
    verifiedOrder: null,
    followUpRequested,
  };

  const slotMatch = String(message || '').match(/\b(morning|10\s*am|afternoon|1\s*pm|evening|5\s*pm)\b/i);
  const prefEmailMatch = /\b(via\s*email|by\s*email|prefer\s*email|email\s*update|send\s*email|^email$)\b/i.test(String(message || '').trim());
  const prefPhoneMatch = /\b(phone\s*call|direct\s*call|call\s*me|callback|call\s*back|^call$|^phone$)\b/i.test(String(message || '').trim());
  const isExplicitEscalationOrCancel =
    (intent === 'human_escalation' && followUpRequested && isOrderRelatedSupportRequest) ||
    intent === 'cancel_order' ||
    intent === 'cancel_assistance';

  const isAnsweringContactPref = (prefEmailMatch || prefPhoneMatch || Boolean(slotMatch)) && Boolean(session.pageContext?.verifiedOrderForEscalation);
  const isAnsweringOrderVerify = (Boolean(extracted.orderRef) || Boolean(extracted.email) || Boolean(extracted.phone)) && Boolean(session.pageContext?.awaitingConciergeVerification);

  const wantsEscalationOrCancel = isExplicitEscalationOrCancel || isAnsweringContactPref || isAnsweringOrderVerify;

  if (!wantsEscalationOrCancel && (session.pageContext?.awaitingConciergeVerification || session.pageContext?.verifiedOrderForEscalation)) {
    // Clear stale verification locks so the user can freely converse with the AI
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
  }

  if (wantsEscalationOrCancel && session.status !== 'escalated') {
    const verifiedOrderCard = collectedOrderCards[0] || session.pageContext?.verifiedOrderForEscalation || null;

    if (!verifiedOrderCard) {
      escalationInfo.verificationStep = 'STEP_1_VERIFY_ORDER';
      await updateSessionContext(session.id, { awaitingConciergeVerification: true }, {}, activePool);
    } else if (!prefEmailMatch && !prefPhoneMatch && !slotMatch && !session.pageContext?.selectedContactPreference) {
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
        status: followUpRequested && !isOrderRelatedSupportRequest ? 'pending' : undefined,
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
    knowledgeResult,
    sentiment,
    escalation: escalationInfo,
    escalationInfo,
    user: resolvedUser,
  });

  const synthesized = await synthesizeWithGeminiOrDeterministic({
    userMessage: message,
    history,
    toolResults: executedTools,
    knowledgeResult,
    deterministicFallback: deterministic,
    user: resolvedUser,
  });

  const mustUseSupportPolicyReply =
    intent === 'human_escalation' ||
    intent === 'order_support_redirect' ||
    intent === 'customer_support_redirect' ||
    Boolean(escalationInfo.verificationStep) ||
    Boolean(escalationInfo.escalated);
  const finalReply = mustUseSupportPolicyReply ? deterministic.reply : synthesized.reply;
  const finalQuickActions = mustUseSupportPolicyReply
    ? deterministic.quickActions
    : synthesized.quickActions || deterministic.quickActions;

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
    quickActions: finalQuickActions,
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
    quickActions: finalQuickActions,
    toolCalls: executedTools.map(t => ({ name: t.name, code: t.result?.code, success: t.result?.success, result: t.result })),
    provider: mustUseSupportPolicyReply ? 'deterministic-support-policy' : synthesized.provider || 'deterministic-verified',
  };
}

module.exports = {
  buildContextualGreeting,
  detectIntentAndToolPlan,
  synthesizeDeterministicResponse,
  processSupportTurn,
  SUPPORT_TOOLS_REGISTRY,
};
