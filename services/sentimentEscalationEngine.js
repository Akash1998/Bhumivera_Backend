'use strict';

const https = require('https');
const { maskPII } = require('../utils/piiMasker');
const { createEscalationRecord, updateSessionTelemetry } = require('../models/aiSupportModel');

/**
 * Lexicon & Signal Weights for Real-Time Customer Support Sentiment & Frustration Scoring
 */
const CRITICAL_THREAT_PATTERNS = [
  /\b(consumer\s*court|legal\s*action|lawyer|sue\s*you|police|cyber\s*crime|chargeback|fraud|scam|cheated|stole\s*my\s*money|report\s*to\s*rbi|national\s*consumer\s*helpline)\b/i,
  /\b(allergic\s*reaction|severe\s*rash|chemical\s*burn|hospital|medical\s*emergency|contaminated)\b/i,
];

const HIGH_FRUSTRATION_PATTERNS = [
  /\b(worst\s*service|pathetic|horrible|disgusting|terrible|unacceptable|ridiculous|useless|incompetent|waste\s*of\s*money)\b/i,
  /\b(still\s*not\s*received|where\s*the\s*hell|nobody\s*replies|no\s*response|waiting\s*for\s*days|delayed\s*forever|broken\s*bottle|leaking|damaged|wrong\s*item|missing\s*item|fake\s*product|expired)\b/i,
  /\b(give\s*my\s*money\s*back|refund\s*immediately|instant\s*refund|deducted\s*twice|double\s*charged|payment\s*debited\s*but)\b/i,
];

const HUMAN_ESCALATION_PATTERNS = [
  /\b(talk\s*to\s*(?:a\s*)?(?:human|person|agent|representative|manager|supervisor|support\s*exec|real\s*person))\b/i,
  /\b(connect\s*me\s*to|escalate\s*this|human\s*support|live\s*agent|call\s*me\s*now|speak\s*with\s*someone)\b/i,
];

const NEGATIVE_WORDS = [
  'angry', 'upset', 'frustrated', 'annoyed', 'disappointed', 'bad', 'poor', 'slow', 'late',
  'delayed', 'stuck', 'missing', 'damaged', 'broken', 'leaked', 'wrong', 'issue', 'problem',
  'error', 'failed', 'fail', 'cancel', 'refund', 'return', 'complaint', 'unhappy', 'never',
  'worst', 'rude', 'ignored', 'waiting',
];

const POSITIVE_WORDS = [
  'thank', 'thanks', 'grateful', 'awesome', 'great', 'love', 'excellent', 'helpful',
  'resolved', 'perfect', 'amazing', 'good', 'happy', 'satisfied', 'appreciate', 'wonderful', 'smooth',
];

const URGENCY_WORDS = [
  'urgent', 'urgently', 'asap', 'immediately', 'right now', 'emergency', 'today', 'fast', 'quick',
];

/**
 * Analyzes user message sentiment, frustration velocity, priority level, and escalation triggers.
 *
 * @param {string} rawMessage
 * @param {Array<{sender: string, content: string, sentiment?: object}>} history
 * @param {object} pageContext
 * @returns {{
 *   score: number,
 *   frustrationScore: number,
 *   label: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive',
 *   priority: 'Low' | 'Medium' | 'High' | 'Critical',
 *   emotions: string[],
 *   shouldEscalate: boolean,
 *   escalationReason: string | null,
 *   signals: string[]
 * }}
 */
function analyzeSentiment(rawMessage, history = [], pageContext = {}) {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return {
      score: 0,
      frustrationScore: 0,
      label: 'neutral',
      priority: 'Low',
      emotions: ['neutral'],
      shouldEscalate: false,
      escalationReason: null,
      signals: [],
    };
  }

  const lower = message.toLowerCase();
  const signals = [];
  const emotions = new Set();
  let polarity = 0;
  let frustration = 0;

  // 1. Check critical threats (legal, fraud, adverse reaction)
  const hasCriticalThreat = CRITICAL_THREAT_PATTERNS.some(rx => rx.test(message));
  if (hasCriticalThreat) {
    polarity -= 0.85;
    frustration += 85;
    signals.push('critical_risk_or_escalation_keyword');
    emotions.add('angry');
    emotions.add('urgent');
  }

  // 2. Check high frustration patterns
  for (const rx of HIGH_FRUSTRATION_PATTERNS) {
    if (rx.test(message)) {
      polarity -= 0.45;
      frustration += 38;
      signals.push('high_frustration_phrase');
      emotions.add('frustrated');
    }
  }

  // 3. Check explicit request to speak with a human
  const wantsHuman = HUMAN_ESCALATION_PATTERNS.some(rx => rx.test(message));
  if (wantsHuman) {
    signals.push('explicit_human_handoff_request');
    frustration = Math.max(frustration, 60);
    emotions.add('urgent');
  }

  // 4. Lexical polarity & urgency scan
  for (const word of NEGATIVE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      polarity -= 0.14;
      frustration += 11;
    }
  }
  for (const word of POSITIVE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      polarity += 0.22;
      frustration = Math.max(0, frustration - 15);
      emotions.add('satisfied');
    }
  }
  for (const word of URGENCY_WORDS) {
    if (lower.includes(word)) {
      frustration += 12;
      emotions.add('urgent');
      signals.push('urgency_indicator');
    }
  }

  // 5. Paralinguistic signals (ALL CAPS shouting, repeated exclamation/question marks)
  const alphaChars = message.replace(/[^a-zA-Z]/g, '');
  if (alphaChars.length >= 12) {
    const upperRatio = message.replace(/[^A-Z]/g, '').length / alphaChars.length;
    if (upperRatio > 0.65) {
      polarity -= 0.25;
      frustration += 22;
      signals.push('caps_emphasis');
      emotions.add('frustrated');
    }
  }
  if (/[!?]{3,}/.test(message)) {
    polarity -= 0.15;
    frustration += 15;
    signals.push('intense_punctuation');
  }

  // 6. Behavioral context signals (rage clicks or checkout stall from frontend telemetry)
  if (pageContext?.rageClickDetected) {
    frustration += 20;
    signals.push('rage_click_telemetry');
    emotions.add('frustrated');
  }

  // 7. Multi-turn conversation frustration velocity
  const recentUserTurns = (Array.isArray(history) ? history : [])
    .filter(m => m && m.sender === 'user')
    .slice(-3);

  let consecutiveNegativeTurns = 0;
  for (const turn of recentUserTurns) {
    const prevScore = Number(turn.sentiment?.score ?? 0);
    const prevFrustration = Number(turn.sentiment?.frustrationScore ?? 0);
    if (prevScore < -0.2 || prevFrustration >= 45) {
      consecutiveNegativeTurns += 1;
    }
  }
  if (consecutiveNegativeTurns >= 2 && polarity < 0) {
    frustration += consecutiveNegativeTurns * 15;
    polarity -= 0.15;
    signals.push('compounding_multi_turn_frustration');
    emotions.add('frustrated');
  }

  // Clamp score [-1.0, 1.0] and frustration [0, 100]
  const clampedScore = Math.max(-1, Math.min(1, Math.round(polarity * 100) / 100));
  const clampedFrustration = Math.max(0, Math.min(100, Math.round(frustration)));

  let label = 'neutral';
  if (clampedScore <= -0.6) label = 'very_negative';
  else if (clampedScore <= -0.2) label = 'negative';
  else if (clampedScore >= 0.6) label = 'very_positive';
  else if (clampedScore >= 0.2) label = 'positive';

  if (emotions.size === 0) {
    if (clampedScore < -0.2) emotions.add('disappointed');
    else if (clampedScore > 0.2) emotions.add('satisfied');
    else emotions.add('neutral');
  }

  // Priority classification
  let priority = 'Low';
  if (hasCriticalThreat || clampedFrustration >= 80) {
    priority = 'Critical';
  } else if (wantsHuman || clampedFrustration >= 55 || clampedScore <= -0.55) {
    priority = 'High';
  } else if (clampedFrustration >= 30 || clampedScore <= -0.2) {
    priority = 'Medium';
  }

  const threshold = Number(process.env.SUPPORT_FRUSTRATION_THRESHOLD) || 70;
  const shouldEscalate = Boolean(
    hasCriticalThreat ||
    wantsHuman ||
    clampedFrustration >= threshold
  );

  let escalationReason = null;
  if (hasCriticalThreat) {
    escalationReason = 'Critical customer protection / safety / payment dispute signal detected';
  } else if (wantsHuman) {
    escalationReason = 'Customer explicitly requested human specialist handoff';
  } else if (clampedFrustration >= threshold) {
    escalationReason = `Frustration index (${clampedFrustration}/100) breached automated escalation threshold`;
  }

  return {
    score: clampedScore,
    frustrationScore: clampedFrustration,
    label,
    priority,
    emotions: Array.from(emotions),
    shouldEscalate,
    escalationReason,
    signals,
  };
}

/**
 * Helper to dispatch JSON HTTPS POST requests with timeout for WhatsApp webhooks.
 */
function postJsonWebhook(targetUrl, payload, headers = {}, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(targetUrl);
      const body = JSON.stringify(payload);
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            ...headers,
          },
        },
        res => {
          let responseBody = '';
          res.on('data', chunk => { responseBody += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, status: res.statusCode, body: responseBody });
            } else {
              reject(new Error(`Webhook HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Webhook request timed out')));
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Executes instant escalation loop:
 * 1. Creates or links a human `support_tickets` record for `/support` portal visibility.
 * 2. Logs an admin notification in `notifications`.
 * 3. Fires configured WhatsApp webhook and Admin Email notifications.
 * 4. Persists the audit record in `ai_support_escalations`.
 */
async function triggerInstantEscalation({
  pool: customPool = null,
  session,
  user = null,
  latestMessage = '',
  sentiment = {},
  reason = null,
  orderId = null,
  transcript = [],
  sendMailFn = null,
  httpPostFn = postJsonWebhook,
}) {
  const pool = customPool || require('../config/db');
  const mailSender = sendMailFn || (() => {
    try {
      return require('../utils/mail').sendMail;
    } catch {
      return null;
    }
  })();

  const customerName = user?.name || session?.guestName || 'Bhumivera Customer';
  const customerEmail = user?.email || session?.guestEmail || 'guest-escalation@bhumivera.com';
  const customerPhone = user?.phone || session?.guestPhone || null;
  const priority = sentiment?.priority || (sentiment?.frustrationScore >= 80 ? 'Critical' : 'High');
  const escalationReason = reason || sentiment?.escalationReason || 'Escalated to human concierge specialist';

  const recentLines = (Array.isArray(transcript) ? transcript.slice(-8) : [])
    .map(m => `[${String(m.sender || 'user').toUpperCase()}]: ${maskPII(m.content || '')}`)
    .join('\n');
  const summaryText = maskPII(
    `Priority: ${priority} | Frustration: ${sentiment?.frustrationScore ?? 0}/100 | Sentiment: ${sentiment?.score ?? 0}\n` +
    `Reason: ${escalationReason}\n` +
    (customerPhone ? `Phone: ${customerPhone}\n` : '') +
    `Latest Customer Message: ${latestMessage}\n\n--- Recent Transcript ---\n${recentLines}`
  );

  // 1. Create support_tickets row so human support agents see it immediately in SupportPortal
  let ticketId = session?.escalatedTicketId || null;
  if (!ticketId) {
    try {
      const subject = `[AI Escalation · ${priority}] ${escalationReason}`.slice(0, 200);
      const [ticketResult] = await pool.query(
        `INSERT INTO support_tickets (user_id, order_id, name, email, subject, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [
          user?.id || session?.userId || null,
          orderId || null,
          customerName.slice(0, 100),
          customerEmail.slice(0, 150),
          subject,
          summaryText,
        ]
      );
      ticketId = ticketResult?.insertId || null;
    } catch (ticketErr) {
      console.error('[AI_SUPPORT_ESCALATION_TICKET_ERR]', ticketErr.message);
    }
  }

  // 2. Insert global admin notification in `notifications` table
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, is_global)
       VALUES (NULL, ?, ?, 'support_escalation', 0)`,
      [
        `[${priority}] AI Support Escalation${ticketId ? ` #${ticketId}` : ''}`,
        `${customerName} (${customerEmail}): ${maskPII(latestMessage).slice(0, 220)}`,
      ]
    );
  } catch (notifErr) {
    console.error('[AI_SUPPORT_ESCALATION_NOTIF_ERR]', notifErr.message);
  }

  // 3. Dispatch multi-channel webhooks (WhatsApp, Email)
  const channelsNotified = [];
  // 3a. WhatsApp Business Cloud / Webhook
  const whatsappWebhookUrl = process.env.SUPPORT_WHATSAPP_WEBHOOK_URL;
  if (whatsappWebhookUrl) {
    try {
      await httpPostFn(
        whatsappWebhookUrl,
        {
          type: 'support_escalation',
          priority,
          ticketId,
          customer: { name: customerName, email: customerEmail, phone: customerPhone },
          reason: escalationReason,
          message: maskPII(latestMessage).slice(0, 500),
        },
        process.env.SUPPORT_WHATSAPP_TOKEN
          ? { Authorization: `Bearer ${process.env.SUPPORT_WHATSAPP_TOKEN}` }
          : {}
      );
      channelsNotified.push({ channel: 'whatsapp', status: 'sent', timestamp: new Date().toISOString() });
    } catch (waErr) {
      channelsNotified.push({ channel: 'whatsapp', status: 'failed', error: waErr.message });
    }
  } else {
    channelsNotified.push({ channel: 'whatsapp', status: 'queued_local_no_webhook_env' });
  }

  // 3b. Admin Email Alert via Mailrelay (`utils/mail.js`)
  const escalationEmail = process.env.SUPPORT_ESCALATION_EMAIL || 'support@bhumivera.com';
  if (typeof mailSender === 'function') {
    try {
      await mailSender({
        to: escalationEmail,
        subject: `[${priority} Escalation] Bhumivera Concierge Ticket ${ticketId ? `#${ticketId}` : ''}`,
        text: summaryText,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6">
          <h2 style="color:#0b2419;margin-bottom:8px">[${priority}] AI Concierge Escalation</h2>
          <p><strong>Ticket ID:</strong> ${ticketId ? `#${ticketId}` : 'N/A'}<br>
          <strong>Customer:</strong> ${maskPII(customerName)} (${customerEmail})<br>
          <strong>Reason:</strong> ${maskPII(escalationReason)}<br>
          <strong>Frustration Score:</strong> ${sentiment?.frustrationScore ?? 0}/100</p>
          <pre style="background:#f4f1e9;padding:14px;border-radius:8px;white-space:pre-wrap">${summaryText}</pre>
        </div>`,
        timeoutMs: 4000,
      });
      channelsNotified.push({ channel: 'email', status: 'sent', to: escalationEmail });
    } catch (mailErr) {
      channelsNotified.push({ channel: 'email', status: 'failed', error: mailErr.message });
    }
  }

  // 4. Record in `ai_support_escalations` & update session state
  let escalationId = null;
  if (session?.id) {
    try {
      escalationId = await createEscalationRecord({
        sessionId: session.id,
        ticketId,
        userId: user?.id || session.userId || null,
        customerName,
        customerEmail,
        priority,
        reason: escalationReason,
        sentimentScore: sentiment?.score ?? 0,
        frustrationScore: sentiment?.frustrationScore ?? 0,
        channelsNotified,
        transcriptSummary: summaryText,
        pool,
      });
      await updateSessionTelemetry(
        session.id,
        {
          sentimentScore: sentiment?.score ?? 0,
          frustrationScore: sentiment?.frustrationScore ?? 0,
          priority,
          status: 'escalated',
          escalatedTicketId: ticketId,
        },
        pool
      );
    } catch (escDbErr) {
      console.error('[AI_SUPPORT_ESCALATION_DB_ERR]', escDbErr.message);
    }
  }

  return {
    escalated: true,
    escalationId,
    ticketId,
    priority,
    reason: escalationReason,
    channelsNotified,
    slaResponseWindow: priority === 'Critical' ? 'Under 15 minutes' : priority === 'High' ? 'Under 30 minutes' : 'Within 2 hours',
  };
}

module.exports = {
  analyzeSentiment,
  triggerInstantEscalation,
  postJsonWebhook,
};
