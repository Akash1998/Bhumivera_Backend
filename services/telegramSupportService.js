'use strict';

/**
 * Bhumivera Two-Way Telegram Bot Integration (`@BhumiveraBot`)
 * ---------------------------------------------------------------------------
 * Allows customers to chat on Telegram (`t.me/BhumiveraBot` or `web.telegram.org/k/#@BhumiveraBot`)
 * and have their messages appear in `/support` and `/superadminsupport`, while replies from Support
 * Executives, Supervisors, Managers, or the AI Concierge are delivered straight back to the customer's
 * Telegram chat with full order tracking, order history, return/replacement RMA, coupons, and share links.
 */

const crypto = require('crypto');
const { decryptQuantumPayload } = require('../utils/quantumCrypto');
const {
  createOrResumeSession,
  getSessionByToken,
  appendMessage,
  updateSessionTelemetry,
  getAiSupportFeatureConfig,
} = require('../models/aiSupportModel');
const { processSupportTurn } = require('./aiSupportOrchestrator');

// Encrypted 512-bit envelope holding the default @BhumiveraBot token
const DEFAULT_ENCRYPTED_BOT_TOKEN_ENV =
  'q512:921e17c580f685bb194dc60bfbd0eb1e:6243b4cf5b29ca06360449db8d44f0ca6a72844b2434c0142516aa073fa1d219:be578f2512ed95461b6f3cf6bfae05ef5563201b529faef63307c3318b989d1305c9f10da934db6df2a3dc6c68f8db8f9bdacae42bd30992f32f28e2bc5711d1ef77092b305497db1a3aa50cc6aa9ec2cd4976be531f3b80197240';

const DEFAULT_TELEGRAM_BOT_USERNAME = 'BhumiveraBot';
const DEFAULT_BOT_USERNAME = DEFAULT_TELEGRAM_BOT_USERNAME;
const FALLBACK_BOT_TOKEN = '8304879119:AAGEC1XbwxJhxdNv0JPaknsnMHk9xeops9g';

function resolveTelegramBotToken(featureConfig = {}) {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim()) {
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  }
  if (featureConfig?.telegram_bot_token && String(featureConfig.telegram_bot_token).trim()) {
    const raw = String(featureConfig.telegram_bot_token).trim();
    const dec = raw.startsWith('q512:') ? decryptQuantumPayload(raw) : raw;
    if (dec) return dec;
  }
  return decryptQuantumPayload(DEFAULT_ENCRYPTED_BOT_TOKEN_ENV) || FALLBACK_BOT_TOKEN;
}

function getTelegramWebhookSecret(botToken = resolveTelegramBotToken()) {
  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TELEGRAM_WEBHOOK_SECRET.trim();
  if (configuredSecret) return configuredSecret;
  if (!botToken) return '';
  return crypto.createHmac('sha256', botToken).update('bhumivera-telegram-webhook-v1').digest('hex');
}

function isValidTelegramWebhookSecret(headerValue, botToken = resolveTelegramBotToken()) {
  const expected = getTelegramWebhookSecret(botToken);
  if (!expected || typeof headerValue !== 'string') return false;
  const actualBuf = Buffer.from(headerValue);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function getTelegramWebhookUrl(customUrl = null) {
  const rawUrl =
    customUrl ||
    process.env.TELEGRAM_WEBHOOK_URL ||
    (process.env.BACKEND_PUBLIC_URL
      ? `${process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '')}/api/support/telegram/webhook`
      : 'https://bhumivera-backend-production.up.railway.app/api/support/telegram/webhook');
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

const resolveTelegramWebhookUrl = getTelegramWebhookUrl;

/**
 * Low-level helper to call Telegram Bot API (`https://api.telegram.org/bot<TOKEN>/<METHOD>`).
 */
async function callTelegramApi(method, payload = {}, customToken = null) {
  const token = customToken || resolveTelegramBotToken();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' };

  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: Boolean(res.ok && data?.ok), status: res.status, result: data?.result, description: data?.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Sends a direct message to a customer's Telegram chat via `@BhumiveraBot`.
 * Automatically falls back to plain text if Telegram's legacy Markdown parser rejects special characters.
 */
async function sendTelegramMessage(chatId, text, options = {}) {
  if (!chatId || !text) return { ok: false, sent: false, reason: 'missing_chat_or_text' };
  const token = options.botToken || resolveTelegramBotToken(options.featureConfig);
  if (!token) return { ok: false, sent: false, reason: 'missing_bot_token' };

  const res = await callTelegramApi(
    'sendMessage',
    {
      chat_id: String(chatId),
      text: String(text).slice(0, 4000),
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    },
    token
  );

  if (res.ok) {
    return { ok: true, sent: true, messageId: res.result?.message_id || null };
  }

  // Fallback to plain text if Markdown entity parsing failed (e.g. unescaped underscores)
  const plainText = String(text).replace(/\*\*/g, '').replace(/`/g, '').slice(0, 4000);
  const retryRes = await callTelegramApi(
    'sendMessage',
    {
      chat_id: String(chatId),
      text: plainText,
      disable_web_page_preview: false,
    },
    token
  );
  return {
    ok: retryRes.ok,
    sent: retryRes.ok,
    messageId: retryRes.result?.message_id || null,
    error: retryRes.description || null,
  };
}

/**
 * Sends a staff or system reply from `/support` or `/superadminsupport` directly to the customer's Telegram chat.
 */
async function sendTelegramReplyToCustomer(session, messageText, senderLabel = 'Bhumivera Support', options = {}) {
  const ctx =
    typeof session?.pageContext === 'string'
      ? (() => {
          try {
            return JSON.parse(session.pageContext);
          } catch {
            return {};
          }
        })()
      : session?.pageContext || {};

  const chatId = session?.telegramChatId || ctx?.telegramChatId || null;
  if (!chatId) return { ok: false, sent: false, reason: 'no_telegram_chat_id' };

  const formatted = `💬 *${senderLabel}:*\n${messageText}`;
  return sendTelegramMessage(chatId, formatted, options);
}

/**
 * Registers the authenticated HTTPS Telegram Webhook with secret_token header verification.
 */
async function registerTelegramWebhook({ botToken, webhookUrl, httpCallFn } = {}) {
  const token = botToken || resolveTelegramBotToken();
  const url = getTelegramWebhookUrl(webhookUrl);
  if (!token || !url) {
    return { ok: false, registered: false, error: 'TELEGRAM_WEBHOOK_NOT_CONFIGURED' };
  }
  const payload = {
    url,
    secret_token: getTelegramWebhookSecret(token),
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: false,
  };
  const call = typeof httpCallFn === 'function' ? httpCallFn : callTelegramApi;
  const response = await call('setWebhook', payload, token);
  return {
    ok: Boolean(response?.ok),
    registered: Boolean(response?.ok),
    method: 'setWebhook',
    webhookUrl: url,
    result: response?.result,
    description: response?.description,
    error: response?.error,
  };
}

/**
 * Finds an existing support session linked to a given Telegram chat_id.
 */
async function findSessionByTelegramChatId(pool, chatId) {
  const [rows] = await pool.query(
    `SELECT * FROM ai_support_sessions
     WHERE status NOT IN ('closed')
     ORDER BY updated_at DESC LIMIT 100`
  );
  for (const row of rows || []) {
    try {
      const ctx = typeof row.page_context === 'string' ? JSON.parse(row.page_context) : row.page_context || {};
      if (String(ctx.telegramChatId || '') === String(chatId)) {
        return getSessionByToken(row.session_token, pool);
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return null;
}

/**
 * Attempts to correlate a Telegram user with an existing Bhumivera customer account or recent web session
 * using their email, 10-digit phone number, BHVM order number, or recent active web session.
 */
async function correlateTelegramSessionWithCustomer(pool, session, rawText = '', fromUser = {}) {
  if (!pool || !session) return null;

  let matchedUser = null;
  if (session.userId) {
    try {
      const [uRows] = await pool.query('SELECT id, name, email, phone, role FROM users WHERE id = ? LIMIT 1', [session.userId]);
      if (uRows?.[0]) matchedUser = uRows[0];
    } catch {}
  }

  const emailMatch = rawText.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const phoneMatch = rawText.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
  const bhvmMatch = rawText.match(/\bBHVM[-_\s]*(\d{6,12})\b/i);
  const nineDigitMatch = rawText.match(/(?:^|[^0-9])(\d{9})(?!\d)/);
  const orderRef = bhvmMatch?.[1] || nineDigitMatch?.[1] || null;

  if (!matchedUser && emailMatch) {
    try {
      const [uRows] = await pool.query('SELECT id, name, email, phone, role FROM users WHERE LOWER(email) = ? LIMIT 1', [
        emailMatch[0].toLowerCase(),
      ]);
      if (uRows?.[0]) matchedUser = uRows[0];
    } catch {}
  }

  if (!matchedUser && phoneMatch) {
    try {
      const [uRows] = await pool.query('SELECT id, name, email, phone, role FROM users WHERE phone LIKE ? LIMIT 1', [
        `%${phoneMatch[1]}`,
      ]);
      if (uRows?.[0]) matchedUser = uRows[0];
    } catch {}
  }

  if (!matchedUser && orderRef) {
    try {
      const [ordRows] = await pool.query(
        `SELECT o.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.order_number = ? OR o.id = ?
         LIMIT 1`,
        [orderRef, Number(orderRef) || 0]
      );
      if (ordRows?.[0]?.user_id) {
        const ord = ordRows[0];
        matchedUser = {
          id: ord.user_id,
          name: ord.user_name || session.guestName || 'Customer',
          email: ord.user_email || session.guestEmail || null,
          phone: ord.user_phone || session.guestPhone || null,
          role: 'customer',
        };
      }
    } catch {}
  }

  if (matchedUser && !session.userId) {
    session.userId = matchedUser.id;
    session.guestName = matchedUser.name || session.guestName;
    session.guestEmail = matchedUser.email || session.guestEmail;
    session.guestPhone = matchedUser.phone || session.guestPhone;
  }

  return matchedUser;
}

/**
 * Processes a single incoming Telegram update object (either from Webhook or getUpdates polling).
 */
async function processIncomingTelegramUpdate(update, { pool } = {}) {
  const activePool = pool || require('../config/db');
  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.chat || msg.from?.is_bot) {
    return { handled: false };
  }

  const chatId = String(msg.chat.id);
  const fromUser = msg.from || {};
  const guestName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || fromUser.username || 'Telegram Customer';
  const rawText = String(msg.text || msg.caption || '').trim();
  if (!rawText) return { handled: false };

  const featureConfig = await getAiSupportFeatureConfig(activePool);

  let session = null;
  const startMatch = rawText.match(/^\/start(?:\s+([a-f0-9_-]{8,64}))?$/i);
  const startToken = startMatch?.[1] || null;

  if (startToken) {
    session = await getSessionByToken(startToken, activePool);
  }
  if (!session) {
    session = await findSessionByTelegramChatId(activePool, chatId);
  }

  if (!session) {
    session = await createOrResumeSession({
      guestName: `${guestName} (Telegram)`,
      pageContext: {
        pathname: '/telegram-bot',
        channel: 'telegram',
        telegramChatId: chatId,
        telegramUsername: fromUser.username || null,
      },
      pool: activePool,
    });
  } else {
    const nextContext = {
      ...(session.pageContext || {}),
      channel: 'telegram',
      telegramChatId: chatId,
      telegramUsername: fromUser.username || session.pageContext?.telegramUsername || null,
    };
    session.telegramChatId = chatId;
    session.pageContext = nextContext;
    await activePool.query('UPDATE ai_support_sessions SET page_context = ?, updated_at = NOW() WHERE id = ?', [
      JSON.stringify(nextContext),
      session.id,
    ]);
  }
  session.telegramChatId = chatId;

  const matchedUser = await correlateTelegramSessionWithCustomer(activePool, session, rawText, fromUser);

  if (startMatch) {
    const accountLine = matchedUser
      ? `\n✅ Linked to your Bhumivera account (**${matchedUser.name}** · ${matchedUser.email || 'Verified'}).`
      : '';
    const welcomeReply =
      `Namaste ${fromUser.first_name || 'Customer'}! Welcome to **Bhumivera Support** (@${DEFAULT_TELEGRAM_BOT_USERNAME}).\n\n` +
      `Your Telegram chat is now linked to Support Session \`#${session.sessionToken.slice(0, 8)}\`.${accountLine}\n` +
      `• **Track an Order:** Send your 9-digit Order Number or BHVM ID (e.g., \`BHVM815899599\`)\n` +
      `• **Order History:** Type \`my orders\` or \`order history\`\n` +
      `• **Returns & Replacements:** Type \`return\` or \`return #<OrderNumber>\`\n` +
      `• **Coupons & Wallet:** Type \`my coupons\` or \`my wallet\`\n` +
      `• **Website & Product Links:** Type \`share link\` or ask about any product\n` +
      `• **Human Support:** Type \`talk to agent\` and our team will reply right here in Telegram!`;

    await appendMessage({
      sessionId: session.id,
      sender: 'assistant',
      senderName: 'Bhumivera Telegram Bot',
      content: welcomeReply,
      pool: activePool,
    });
    await sendTelegramMessage(chatId, welcomeReply, { featureConfig });
    return { handled: true, sessionToken: session.sessionToken, chatId };
  }

  if (session.assignedAgentId || session.status === 'escalated') {
    await appendMessage({
      sessionId: session.id,
      sender: 'user',
      senderName: guestName,
      content: `[Telegram] ${rawText}`,
      pool: activePool,
    });
    await updateSessionTelemetry(session.id, { status: session.status === 'resolved' ? 'active' : session.status }, activePool);
    return { handled: true, sessionToken: session.sessionToken, chatId, routedToAgent: true };
  }

  const result = await processSupportTurn({
    sessionToken: session.sessionToken,
    message: rawText,
    user: matchedUser,
    guestInfo: {
      name: guestName,
      email: matchedUser?.email || session.guestEmail || null,
      phone: matchedUser?.phone || session.guestPhone || null,
    },
    pageContext: {
      ...(session.pageContext || {}),
      channel: 'telegram',
      telegramChatId: chatId,
    },
    pool: activePool,
  });

  if (result?.reply) {
    await sendTelegramMessage(chatId, result.reply, { featureConfig });
  }

  return {
    handled: true,
    sessionToken: session.sessionToken,
    chatId,
    reply: result?.reply || null,
  };
}

/**
 * Polls Telegram `getUpdates` for any new customer messages and syncs them into the support queue.
 */
async function syncTelegramBotUpdates({ pool } = {}) {
  const activePool = pool || require('../config/db');
  const featureConfig = await getAiSupportFeatureConfig(activePool);
  const token = resolveTelegramBotToken(featureConfig);
  if (!token) return { synced: 0, error: 'No Telegram Bot token configured' };

  let lastUpdateId = Number(featureConfig.telegram_last_update_id || 0);
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&limit=25&timeout=1`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !Array.isArray(data.result)) {
      return { synced: 0, lastUpdateId };
    }

    let syncedCount = 0;
    for (const upd of data.result) {
      if (upd.update_id > lastUpdateId) {
        lastUpdateId = upd.update_id;
      }
      const processed = await processIncomingTelegramUpdate(upd, { pool: activePool });
      if (processed.handled) syncedCount += 1;
    }

    if (data.result.length > 0) {
      await activePool.query(
        `INSERT INTO settings (key_name, value, group_name)
         VALUES ('telegram_last_update_id', ?, 'ai_support_features')
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [String(lastUpdateId)]
      );
    }

    return { synced: syncedCount, lastUpdateId };
  } catch (err) {
    return { synced: 0, error: err.message };
  }
}

module.exports = {
  DEFAULT_TELEGRAM_BOT_USERNAME,
  DEFAULT_BOT_USERNAME,
  resolveTelegramBotToken,
  getTelegramBotToken: resolveTelegramBotToken,
  getTelegramWebhookSecret,
  getTelegramWebhookUrl,
  resolveTelegramWebhookUrl,
  isValidTelegramWebhookSecret,
  registerTelegramWebhook,
  callTelegramApi,
  sendTelegramMessage,
  sendTelegramReplyToCustomer,
  processIncomingTelegramUpdate,
  syncTelegramBotUpdates,
  findSessionByTelegramChatId,
};
