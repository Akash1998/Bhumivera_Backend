'use strict';

const https = require('https');
const { maskPII } = require('../utils/piiMasker');
const {
  createOrResumeSession,
  getSessionByToken,
  updateSessionContext,
  appendMessage,
  getAiSupportFeatureConfig,
} = require('../models/aiSupportModel');

const DEFAULT_TELEGRAM_BOT_USERNAME = 'BhumiveraBot';
const DEFAULT_TELEGRAM_BOT_TOKEN =
  process.env.SUPPORT_TELEGRAM_BOT_TOKEN ||
  '8304879119:AAGEC1XbwxJhxdNv0JPaknsnMHk9xeops9g';

let lastTelegramUpdateOffset = 0;

function resolveTelegramBotToken(featureConfig = {}) {
  return (
    process.env.SUPPORT_TELEGRAM_BOT_TOKEN ||
    featureConfig?.telegram_bot_token ||
    DEFAULT_TELEGRAM_BOT_TOKEN
  );
}

/**
 * Calls the Telegram Bot HTTPS API (`https://api.telegram.org/bot<TOKEN>/<METHOD>`).
 */
function callTelegramApi(method, payload = {}, botToken = DEFAULT_TELEGRAM_BOT_TOKEN, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!botToken) {
      return resolve({ ok: false, simulated: true, description: 'No Telegram bot token configured' });
    }
    try {
      const body = JSON.stringify(payload);
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${botToken}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
        },
        res => {
          let raw = '';
          res.on('data', chunk => {
            raw += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw || '{}');
              resolve(parsed);
            } catch {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, raw });
            }
          });
        }
      );
      req.on('error', err => resolve({ ok: false, error: err.message }));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve({ ok: false, error: 'Telegram API request timeout' });
      });
      req.write(body);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * Sends a message to a specific Telegram chat_id (used when Support Staff replies in /support or /superadminsupport).
 */
async function sendTelegramReplyToCustomer({
  chatId,
  text,
  senderName = 'Bhumivera Support',
  botToken = null,
  httpCallFn = callTelegramApi,
}) {
  if (!chatId || !text) return { ok: false, reason: 'Missing chatId or text' };
  const token = botToken || resolveTelegramBotToken();
  const formattedText = `🌿 *${senderName}*\n\n${maskPII(String(text))}`;
  return httpCallFn(
    'sendMessage',
    {
      chat_id: chatId,
      text: formattedText,
      parse_mode: 'Markdown',
    },
    token
  );
}

/**
 * Processes an incoming Telegram Update (from webhook or getUpdates polling).
 * Links the customer's Telegram chat_id to their Bhumivera support session so
 * the customer and support staff can message back and forth seamlessly.
 */
async function processIncomingTelegramUpdate(update, { pool = null, httpCallFn = callTelegramApi } = {}) {
  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.chat?.id) return { handled: false };

  const chatId = String(msg.chat.id);
  const telegramUsername = msg.from?.username ? `@${msg.from.username}` : null;
  const senderFullName =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() ||
    telegramUsername ||
    `Telegram User ${chatId}`;
  const rawText = String(msg.text || msg.caption || '').trim();
  if (!rawText) return { handled: false };

  const featureConfig = await getAiSupportFeatureConfig(pool);
  const botToken = resolveTelegramBotToken(featureConfig);

  // Check if message is `/start <sessionToken>` to link an existing web/app chat session
  const startMatch = rawText.match(/^\/start(?:\s+([a-f0-9-]{8,64}))?/i);
  let session = null;

  if (startMatch && startMatch[1]) {
    session = await getSessionByToken(startMatch[1], pool);
  }

  // Otherwise look up existing session linked to this telegramChatId
  if (!session && pool) {
    try {
      const [rows] = await pool.query(
        `SELECT session_token FROM ai_support_sessions
         WHERE JSON_UNQUOTE(JSON_EXTRACT(page_context, '$.telegramChatId')) = ?
         ORDER BY updated_at DESC LIMIT 1`,
        [chatId]
      );
      if (rows?.[0]?.session_token) {
        session = await getSessionByToken(rows[0].session_token, pool);
      }
    } catch {}
  }

  if (!session) {
    session = await createOrResumeSession({
      guestName: senderFullName,
      pageContext: {
        channel: 'telegram',
        telegramChatId: chatId,
        telegramUsername,
      },
      pool,
    });
  } else {
    await updateSessionContext(
      session.id,
      {
        channel: 'telegram',
        telegramChatId: chatId,
        telegramUsername,
      },
      { name: senderFullName },
      pool
    );
  }

  if (startMatch) {
    const welcome =
      `Namaste ${senderFullName}! Welcome to *Bhumivera Support* (@${DEFAULT_TELEGRAM_BOT_USERNAME}).\n\n` +
      `Your Telegram chat is now linked to Support Session \`#${session.sessionToken.slice(0, 8)}\`.\n` +
      `• Share your 9-digit Order Number to track an order\n` +
      `• Or type your question here — our AI & Support Team will reply directly in this Telegram chat!`;

    await appendMessage({
      sessionId: session.id,
      sender: 'system',
      senderName: 'Telegram Bridge',
      content: `Customer connected via Telegram (${telegramUsername || chatId}).`,
      pool,
    });

    await httpCallFn('sendMessage', { chat_id: chatId, text: welcome, parse_mode: 'Markdown' }, botToken);
    return { handled: true, type: 'start', sessionToken: session.sessionToken, chatId };
  }

  // If a human agent is already assigned to this session, append the customer's Telegram message
  // so the agent sees it immediately in /support and /superadminsupport
  if (session.assignedAgentId) {
    const savedMsg = await appendMessage({
      sessionId: session.id,
      sender: 'user',
      senderName: `${senderFullName} (Telegram)`,
      content: rawText,
      pool,
    });
    return {
      handled: true,
      type: 'routed_to_assigned_agent',
      sessionToken: session.sessionToken,
      message: savedMsg,
    };
  }

  // Otherwise run through the AI Support Orchestrator and reply back on Telegram
  const { processSupportTurn } = require('./aiSupportOrchestrator');
  const turnResult = await processSupportTurn({
    sessionToken: session.sessionToken,
    message: rawText,
    pageContext: {
      channel: 'telegram',
      telegramChatId: chatId,
      telegramUsername,
    },
    guestInfo: { name: senderFullName },
    pool,
  });

  if (turnResult?.reply) {
    await httpCallFn(
      'sendMessage',
      {
        chat_id: chatId,
        text: turnResult.reply,
        parse_mode: 'Markdown',
      },
      botToken
    );
  }

  return {
    handled: true,
    type: 'ai_replied',
    sessionToken: session.sessionToken,
    chatId,
    reply: turnResult?.reply,
  };
}

/**
 * Polls Telegram `getUpdates` to sync any new customer messages sent to @BhumiveraBot.
 */
async function syncTelegramBotUpdates({ pool = null, httpCallFn = callTelegramApi } = {}) {
  const featureConfig = await getAiSupportFeatureConfig(pool);
  const botToken = resolveTelegramBotToken(featureConfig);
  const response = await httpCallFn(
    'getUpdates',
    {
      offset: lastTelegramUpdateOffset ? lastTelegramUpdateOffset + 1 : undefined,
      limit: 25,
      timeout: 0,
    },
    botToken
  );

  if (!response?.ok || !Array.isArray(response.result)) {
    return { synced: 0, ok: Boolean(response?.ok), error: response?.description || response?.error };
  }

  let processedCount = 0;
  for (const update of response.result) {
    if (update.update_id > lastTelegramUpdateOffset) {
      lastTelegramUpdateOffset = update.update_id;
    }
    const res = await processIncomingTelegramUpdate(update, { pool, httpCallFn });
    if (res.handled) processedCount += 1;
  }

  return {
    ok: true,
    synced: processedCount,
    botUsername: DEFAULT_TELEGRAM_BOT_USERNAME,
    botUrl: `https://t.me/${DEFAULT_TELEGRAM_BOT_USERNAME}`,
  };
}

module.exports = {
  DEFAULT_TELEGRAM_BOT_USERNAME,
  DEFAULT_TELEGRAM_BOT_TOKEN,
  resolveTelegramBotToken,
  callTelegramApi,
  sendTelegramReplyToCustomer,
  processIncomingTelegramUpdate,
  syncTelegramBotUpdates,
};
