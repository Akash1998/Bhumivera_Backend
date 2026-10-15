'use strict';

const { SUPPORT_TOOLS_REGISTRY, executeSupportTool } = require('./aiSupportTools');
const { analyzeSentiment, triggerInstantEscalation } = require('./sentimentEscalationEngine');
const {
  createOrResumeSession,
  appendMessage,
  getSessionMessages,
  updateSessionTelemetry,
} = require('../models/aiSupportModel');
const { maskPII } = require('../utils/piiMasker');

const DEFAULT_QUICK_ACTIONS = [
  { id: 'track_order', label: 'Where is my order?', prompt: 'Where is my order?' },
  { id: 'initiate_return', label: 'Initiate a Return', prompt: 'I want to initiate a return or replacement for my delivered order.' },
  { id: 'cancel_order', label: 'Cancel an Order', prompt: 'I need help cancelling my recent order.' },
  { id: 'refund_status', label: 'Check Refund Status', prompt: 'What is my current refund or RMA status?' },
  { id: 'shipping_policy', label: 'Shipping & Delivery Policy', prompt: 'What are your shipping charges and delivery timelines?' },
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
        { id: 'shipping_policy', label: 'Delivery Timelines & Cutoff', prompt: 'When will my order arrive if I place it today?' },
        { id: 'payment_help', label: 'Payment & COD Eligibility', prompt: 'How do Razorpay, Wallet, and Cash on Delivery work?' },
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
    greeting: `${firstName ? `Namaste ${firstName}! ` : 'Namaste! '}I'm your Bhumivera AI Support Concierge. I can track orders in real time, process self-service cancellations or returns, check refund receipts, or look up botanical product details.`,
    quickActions: DEFAULT_QUICK_ACTIONS,
  };
}

/**
 * Deterministic Intent & Entity Parser for Autonomous Tool Routing.
 * Ensures sub-50ms tool selection and provides 100% reliable fallback when external LLM APIs
 * are offline, rate-limited, or unconfigured.
 */
function detectIntentAndToolPlan(message, pageContext = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  // Extract potential 9-digit order number, #orderId, or RMA number
  const rmaMatch = text.match(/\b(RMA-[A-Z0-9]{6,12})\b/i);
  const nineDigitMatch = text.match(/\b(\d{9})\b/);
  const hashOrderMatch = text.match(/(?:order\s*(?:id|no|number|#)?\s*[:#-]?\s*|#)(\d{1,9})\b/i);
  const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  const phoneMatch = text.match(/\b(?:\+?91[\s-]?)?([6-9]\d{9})\b/);

  const extractedOrderId = nineDigitMatch?.[1] || hashOrderMatch?.[1] || pageContext?.activeOrderId || null;
  const extractedRma = rmaMatch?.[1]?.toUpperCase() || null;
  const extractedEmail = emailMatch?.[1]?.toLowerCase() || null;
  const extractedPhone = phoneMatch?.[1] || null;

  const toolCalls = [];

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
    return { intent: 'refund_status', toolCalls, extractedOrderId, extractedEmail, extractedPhone };
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
    return { intent: 'cancel_order', toolCalls, extractedOrderId, extractedEmail, extractedPhone };
  }

  // 3. Return or replacement / exchange initiation intent
  if (
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
    return { intent: 'initiate_return', toolCalls, extractedOrderId, extractedEmail, extractedPhone };
  }

  // 4. Order tracking / status lookup intent
  if (
    /\b(where\s*is\s*my\s*order|track\s*(?:my\s*)?order|order\s*status|delivery\s*status|shipment|tracking\s*number|when\s*will\s*(?:my\s*order|it)\s*(?:arrive|be\s*delivered)|my\s*orders|recent\s*order)\b/i.test(lower) ||
    (extractedOrderId && !/\b(price|stock|ingredient)\b/i.test(lower))
  ) {
    toolCalls.push({
      name: 'lookup_order',
      args: {
        order_id: extractedOrderId || undefined,
        email: extractedEmail || undefined,
        phone: extractedPhone || undefined,
      },
    });
    return { intent: 'lookup_order', toolCalls, extractedOrderId, extractedEmail, extractedPhone };
  }

  // 5. Product catalog / stock / ingredients / shipping policy intent
  if (
    /\b(in\s*stock|out\s*of\s*stock|available|price|cost|sku|ingredient|how\s*to\s*use|usage|routine|shipping\s*(?:policy|charge|fee|cost|time)|delivery\s*(?:charge|time|policy)|free\s*shipping|return\s*policy|cod|cash\s*on\s*delivery|serums?|cleansers?|oils?|creams?|toners?|botanical)\b/i.test(lower)
  ) {
    // Extract a clean search keyword if the user is asking about a product
    const cleanedQuery = text
      .replace(/\b(is|are|the|in|stock|available|what|price|of|for|how|to|use|ingredients?|shipping|policy|charges?|delivery|tell|me|about|do|you|have)\b/gi, ' ')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    toolCalls.push({
      name: 'query_inventory_catalog',
      args: {
        query: cleanedQuery.length >= 2 ? cleanedQuery.slice(0, 60) : '',
      },
    });
    return { intent: 'catalog_or_policy', toolCalls, extractedOrderId, extractedEmail, extractedPhone };
  }

  return { intent: 'general_concierge', toolCalls: [], extractedOrderId, extractedEmail, extractedPhone };
}

/**
 * Synthesizes an empathetic, grounded, markdown-formatted response from tool outputs,
 * sentiment state, and escalation results.
 */
function synthesizeDeterministicResponse({
  userMessage,
  intent,
  toolResults = [],
  sentiment = {},
  escalation = null,
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
        sections.push(
          `${empathyPrefix}Here is the real-time status for **Order #${o.orderNumber}**:\n` +
          `- **Status:** ${o.status.toUpperCase()} (${o.paymentMode} · ${o.paymentStatus})\n` +
          `- **Total:** ₹${o.total.toLocaleString('en-IN')}\n` +
          `- **Estimated Delivery:** ${o.deliveryEstimate}${trackingLine}`
        );
        quickActions = [
          ...(o.cancellable ? [{ id: `cancel_${o.id}`, label: `Cancel Order #${o.orderNumber}`, prompt: `Cancel my order #${o.orderNumber}` }] : []),
          ...(o.canReturn ? [
            { id: `return_${o.id}`, label: `Return Order #${o.orderNumber}`, prompt: `Initiate return for order #${o.orderNumber}` },
            { id: `replace_${o.id}`, label: `Replace Order #${o.orderNumber}`, prompt: `Request replacement for order #${o.orderNumber}` },
          ] : []),
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
        { id: 'talk_to_human', label: 'Talk to Human', prompt: 'Please connect me with a human support agent.' },
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
    } else if (tr.name === 'query_inventory_catalog') {
      const sp = res.shippingPolicy || {};
      if (res.products?.length) {
        const prodLines = res.products.slice(0, 4).map(p => {
          const stockBadge = p.stockStatus === 'in_stock'
            ? `In Stock (${p.stockQuantity} available)`
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
        `- **Product & Stock Queries:** Check live stock levels, botanical specifications, and shipping timelines`
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
 * Primary LLM Orchestration Engine (`processSupportTurn`)
 * 1. Scores real-time sentiment & frustration velocity.
 * 2. Plans & executes autonomous tool calls against MySQL.
 * 3. Attempts Gemini 2.5 Flash structured synthesis when `GEMINI_API_KEY` or custom `aiClient` is provided,
 *    with automatic zero-downtime fallback to the deterministic synthesizer.
 * 4. Triggers instant multi-channel webhook escalation when frustration thresholds are breached.
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

  // 2. Load recent conversation history for multi-turn memory
  const history = await getSessionMessages(session.id, 20, pool);

  // 3. Score real-time sentiment & frustration
  const sentiment = analyzeSentiment(cleanMessage, history, { ...session.pageContext, ...pageContext });

  // 4. Persist user message (with automatic PII masking inside appendMessage)
  await appendMessage({
    sessionId: session.id,
    sender: 'user',
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
  } else {
    await updateSessionTelemetry(
      session.id,
      {
        sentimentScore: sentiment.score,
        frustrationScore: sentiment.frustrationScore,
        priority: sentiment.priority,
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
    user,
  });

  let finalReply = baseline.reply;
  let providerUsed = 'bhumivera-agentic-core';

  // 8. Optional LLM Enhancement Layer (@google/genai Gemini 2.5 Flash) with strict timeout & fallback
  const resolvedAiClient = aiClient || (() => {
    if (!process.env.GEMINI_API_KEY) return null;
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
    } catch (llmErr) {
      // Seamless fallback to deterministic agentic core
      providerUsed = 'bhumivera-agentic-fallback';
    }
  }

  // 9. Persist assistant message to conversation ledger
  const savedAssistantMessage = await appendMessage({
    sessionId: session.id,
    sender: 'assistant',
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
