const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { authenticateAdmin } = require('../middleware/authMiddleware');
const { ContactModel } = require('../models/contactModel');
const { getUserById, updateUserStatus } = require('../models/userModel');
const { sendMail } = require('../utils/mail');
const { isSessionActive } = require('../utils/sessionStore');
const {
  supportSessionLimiter,
  supportChatLimiter,
  supportEscalationLimiter,
} = require('../middleware/rateLimiter');
const {
  createOrResumeSession,
  getSessionByToken,
  updateSessionContext,
  getSessionMessages,
  appendMessage,
  listEscalations,
} = require('../models/aiSupportModel');
const {
  buildContextualGreeting,
  processSupportTurn,
} = require('../services/aiSupportOrchestrator');
const {
  analyzeSentiment,
  triggerInstantEscalation,
} = require('../services/sentimentEscalationEngine');

const router = express.Router();
const secret = () => process.env.JWT_SECRET || 'fallback_secret';
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Try again later.' },
});
const resetLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Password reset links are limited. Try again later.' },
});
let tablesReady;

const ensureTables = () => {
  if (!tablesReady) {
    tablesReady = pool.query(`
      CREATE TABLE IF NOT EXISTS support_agents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      tablesReady = null;
      throw error;
    });
  }
  return tablesReady;
};

const authenticateSupportAgent = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!token) return res.status(401).json({ message: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(token, secret());
    if (['admin', 'superadmin'].includes(payload.role)) {
      req.supportAgent = { id: payload.id, username: payload.email, name: payload.name || 'Admin', is_active: true };
      return next();
    }
    if (payload.scope !== 'support-agent' || !payload.sub) {
      return res.status(401).json({ message: 'Invalid support session.' });
    }
    await ensureTables();
    const [[agent]] = await pool.query(
      'SELECT id, username, name, is_active FROM support_agents WHERE id = ?',
      [payload.sub]
    );
    if (!agent || !agent.is_active) return res.status(401).json({ message: 'Support access has been disabled.' });
    req.supportAgent = agent;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your support session has expired. Sign in again.' });
    }
    console.error('[SUPPORT_AGENT_AUTH]', error);
    return res.status(503).json({ message: 'Could not validate your support session.' });
  }
};

/**
 * Optional customer authentication middleware for AI Support Chat endpoints.
 * Binds `req.user` (id, name, email, phone, role) when a valid customer Bearer JWT is present,
 * while gracefully allowing guest access (`req.user = null`) when unauthenticated.
 */
const optionalAuthenticateCustomer = async (req, _res, next) => {
  req.user = null;
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
  const rawToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : queryToken;

  if (!rawToken) return next();
  try {
    const payload = jwt.verify(rawToken, secret());
    if (!payload?.id) return next();
    const active = await isSessionActive(payload, req).catch(() => true);
    if (!active) return next();
    const userRecord = await getUserById(payload.id).catch(() => null);
    if (userRecord && Number(userRecord.is_active) !== 0) {
      req.user = {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
        phone: userRecord.phone,
        role: userRecord.role || payload.role || 'customer',
      };
    } else {
      req.user = {
        id: payload.id,
        name: payload.name || null,
        email: payload.email || null,
        role: payload.role || 'customer',
      };
    }
  } catch {
    req.user = null;
  }
  return next();
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
const validMessage = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 10000;
const normalizeAgent = row => ({
  id: row.id,
  username: row.username,
  name: row.name,
  is_active: Boolean(row.is_active),
  created_at: row.created_at,
});

// ============================================================================
// PART 1: AUTONOMOUS AI CUSTOMER SUPPORT ENGINE ENDPOINTS (`/api/support/chat/*`)
// ============================================================================

/**
 * POST /api/support/chat/session
 * Initializes or resumes a multi-turn AI support conversation session,
 * injects page/cart/user context, and returns contextual greeting + history.
 */
router.post('/chat/session', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const { sessionToken, pageContext = {}, guestInfo = {} } = req.body || {};
    const session = await createOrResumeSession({
      sessionToken,
      userId: req.user?.id || null,
      guestName: guestInfo?.name || req.user?.name || null,
      guestEmail: guestInfo?.email || req.user?.email || null,
      guestPhone: guestInfo?.phone || req.user?.phone || null,
      pageContext,
    });

    let messages = await getSessionMessages(session.id, 50);
    const { greeting, quickActions } = buildContextualGreeting({
      user: req.user,
      pageContext: { ...session.pageContext, ...pageContext },
    });

    if (messages.length === 0) {
      const greetingMsg = await appendMessage({
        sessionId: session.id,
        sender: 'assistant',
        content: greeting,
        quickActions,
      });
      messages = [greetingMsg];
    }

    return res.json({
      success: true,
      sessionToken: session.sessionToken,
      session,
      greeting,
      quickActions,
      messages,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_SESSION_INIT]', error);
    const fallbackGreeting = buildContextualGreeting({
      user: req.user,
      pageContext: req.body?.pageContext || {},
    });
    return res.status(200).json({
      success: true,
      degraded: true,
      sessionToken: req.body?.sessionToken || `local-${crypto.randomUUID()}`,
      greeting: fallbackGreeting.greeting,
      quickActions: fallbackGreeting.quickActions,
      messages: [
        {
          id: Date.now(),
          sender: 'assistant',
          content: fallbackGreeting.greeting,
          quickActions: fallbackGreeting.quickActions,
          orderCards: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
  }
});

/**
 * POST /api/support/chat/context
 * Real-time context injection endpoint (route transitions, cart state, linger >45s, rage-click telemetry).
 */
router.post('/chat/context', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const { sessionToken, pageContext = {}, guestInfo = {} } = req.body || {};
    const contextual = buildContextualGreeting({
      user: req.user,
      pageContext,
    });

    if (sessionToken) {
      const session = await getSessionByToken(sessionToken);
      if (session) {
        await updateSessionContext(session.id, pageContext, guestInfo);
      }
    }

    return res.json({
      success: true,
      proactiveMessage: contextual.greeting,
      quickActions: contextual.quickActions,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_CONTEXT_INJECT]', error);
    return res.status(200).json({
      success: true,
      proactiveMessage: 'Need any help with your Bhumivera order or checkout? I am right here to assist.',
      quickActions: buildContextualGreeting({}).quickActions,
    });
  }
});

/**
 * GET /api/support/chat/history/:sessionToken
 * Retrieves persisted multi-turn conversation messages and session state.
 */
router.get('/chat/history/:sessionToken', optionalAuthenticateCustomer, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', message: 'Chat session not found.' });
    }
    if (session.userId && req.user?.id && Number(session.userId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN_SESSION', message: 'Unauthorized session access.' });
    }
    const messages = await getSessionMessages(session.id, 80);
    return res.json({
      success: true,
      session,
      messages,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_HISTORY]', error);
    return res.status(500).json({ success: false, message: 'Could not load conversation history.' });
  }
});

/**
 * POST /api/support/chat/message
 * Processes a customer message through the AI Support Orchestrator (sentiment scoring,
 * autonomous MySQL tool execution, LLM synthesis with fallback, and instant escalation).
 */
router.post('/chat/message', supportChatLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const {
      sessionToken,
      message,
      attachments = [],
      pageContext = {},
      guestInfo = {},
    } = req.body || {};

    if (typeof message !== 'string' || message.trim().length > 4000) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MESSAGE',
        message: 'Please enter a message up to 4,000 characters.',
      });
    }

    const turnResult = await processSupportTurn({
      sessionToken,
      message,
      attachments,
      pageContext,
      guestInfo,
      user: req.user,
    });

    return res.json({
      success: true,
      ...turnResult,
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    console.error('[AI_SUPPORT_MESSAGE_ERROR]', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      reply:
        'I am experiencing a momentary connection delay while reaching our live order database. You can retry your message in a few seconds, or reach our Senior Concierge team directly at **support@bhumivera.com** or WhatsApp **+91 7430985647**.',
      orderCards: [],
      quickActions: buildContextualGreeting({ user: req.user }).quickActions,
      sentiment: { score: 0, frustrationScore: 0, priority: 'Low', label: 'neutral' },
      escalation: null,
    });
  }
});

/**
 * POST /api/support/chat/stream (and GET /api/support/chat/stream)
 * Server-Sent Events (SSE) streaming endpoint for real-time token & tool-call streaming.
 */
const handleSseStream = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const payload = req.method === 'GET' ? req.query : (req.body || {});
    const message = String(payload.message || '').trim();
    const sessionToken = payload.sessionToken || null;
    const pageContext = typeof payload.pageContext === 'string'
      ? (() => { try { return JSON.parse(payload.pageContext); } catch { return {}; } })()
      : (payload.pageContext || {});
    const guestInfo = typeof payload.guestInfo === 'string'
      ? (() => { try { return JSON.parse(payload.guestInfo); } catch { return {}; } })()
      : (payload.guestInfo || {});
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (!message && attachments.length === 0) {
      sendEvent('error', { code: 'EMPTY_MESSAGE', message: 'Please enter a message.' });
      return res.end();
    }

    sendEvent('status', { phase: 'analyzing', detail: 'Analyzing request & checking Bhumivera records…' });

    const turnResult = await processSupportTurn({
      sessionToken,
      message,
      attachments,
      pageContext,
      guestInfo,
      user: req.user,
    });

    if (Array.isArray(turnResult.toolCalls) && turnResult.toolCalls.length > 0) {
      for (const tc of turnResult.toolCalls) {
        sendEvent('tool_call', {
          name: tc.name,
          code: tc.result?.code || 'EXECUTED',
        });
      }
    }

    // Stream reply chunks progressively for responsive typing UX
    const fullReply = String(turnResult.reply || '');
    const tokens = fullReply.match(/.{1,28}(\s|$)|.{1,28}/gs) || [fullReply];
    for (const chunk of tokens) {
      sendEvent('token', { delta: chunk });
    }

    sendEvent('metadata', {
      sessionToken: turnResult.sessionToken,
      messageId: turnResult.message?.id,
      orderCards: turnResult.orderCards || [],
      quickActions: turnResult.quickActions || [],
      sentiment: turnResult.sentiment,
      escalation: turnResult.escalation,
      provider: turnResult.provider,
    });

    sendEvent('done', { ok: true, sessionToken: turnResult.sessionToken });
    return res.end();
  } catch (error) {
    console.error('[AI_SUPPORT_SSE_ERROR]', error);
    sendEvent('token', {
      delta: 'I encountered a temporary connection hiccup while checking our database. Please try again shortly or contact support@bhumivera.com.',
    });
    sendEvent('done', { ok: false, degraded: true });
    return res.end();
  }
};

router.post('/chat/stream', supportChatLimiter, optionalAuthenticateCustomer, handleSseStream);
router.get('/chat/stream', supportChatLimiter, optionalAuthenticateCustomer, handleSseStream);

/**
 * POST /api/support/chat/escalate
 * Instant manual or automated escalation endpoint to create a human support ticket
 * and dispatch Telegram / WhatsApp / Email alerts.
 */
router.post('/chat/escalate', supportEscalationLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const {
      sessionToken,
      reason = 'Customer requested human concierge escalation',
      message = '',
      orderId = null,
      guestInfo = {},
    } = req.body || {};

    const session = await createOrResumeSession({
      sessionToken,
      userId: req.user?.id || null,
      guestName: guestInfo?.name || req.user?.name || null,
      guestEmail: guestInfo?.email || req.user?.email || null,
      guestPhone: guestInfo?.phone || req.user?.phone || null,
    });

    const history = await getSessionMessages(session.id, 20);
    const sentiment = analyzeSentiment(message || reason, history);
    sentiment.priority = sentiment.priority === 'Low' ? 'High' : sentiment.priority;

    const escalation = await triggerInstantEscalation({
      session,
      user: req.user,
      latestMessage: message || reason,
      sentiment,
      reason,
      orderId: validId(orderId) ? Number(orderId) : null,
      transcript: history,
    });

    const confirmationText =
      `I have escalated your conversation to our Senior Concierge team (Ticket ${escalation.ticketId ? `#${escalation.ticketId}` : 'Assigned'} · Priority: **${escalation.priority}**). ` +
      `Our specialists have been alerted via Email, WhatsApp, and Telegram and will respond within **${escalation.slaResponseWindow}**.`;

    await appendMessage({
      sessionId: session.id,
      sender: 'assistant',
      content: confirmationText,
      sentiment,
    });

    return res.status(201).json({
      success: true,
      escalation,
      reply: confirmationText,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_ESCALATE]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not complete instant escalation. Please email support@bhumivera.com or message +91 7430985647 on WhatsApp.',
    });
  }
});

/**
 * GET /api/support/ai-escalations
 * Staff & Admin endpoint to inspect AI support escalations and sentiment telemetry.
 */
router.get('/ai-escalations', authenticateSupportAgent, async (req, res) => {
  try {
    const escalations = await listEscalations({
      status: req.query.status || null,
      limit: req.query.limit || 50,
    });
    return res.json({ success: true, escalations });
  } catch (error) {
    console.error('[AI_SUPPORT_ESCALATIONS_LIST]', error);
    return res.status(500).json({ message: 'Could not load AI support escalations.' });
  }
});

// ============================================================================
// PART 2: EXISTING STAFF SUPPORT PORTAL ENDPOINTS (PRESERVED 100%)
// ============================================================================

router.post('/login', loginLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || username.length > 50 || password.length > 128) {
    return res.status(400).json({ message: 'Enter your support user ID and password.' });
  }
  try {
    await ensureTables();
    const [[agent]] = await pool.query(
      'SELECT id, username, name, password_hash, is_active FROM support_agents WHERE username = ?',
      [username]
    );
    if (!agent || !agent.is_active || !await bcrypt.compare(password, agent.password_hash)) {
      return res.status(401).json({ message: 'Invalid user ID or password.' });
    }
    const token = jwt.sign(
      { sub: String(agent.id), username: agent.username, name: agent.name, role: 'support_agent', scope: 'support-agent' },
      secret(),
      { expiresIn: '8h', jwtid: crypto.randomUUID() }
    );
    return res.json({ token, agent: normalizeAgent(agent) });
  } catch (error) {
    console.error('[SUPPORT_AGENT_LOGIN]', error);
    return res.status(500).json({ message: 'Could not sign in to support.' });
  }
});

router.get('/me', authenticateSupportAgent, (req, res) => res.json({ agent: req.supportAgent }));

router.get('/agents', authenticateAdmin, async (req, res) => {
  try {
    await ensureTables();
    const [agents] = await pool.query(
      'SELECT id, username, name, is_active, created_at FROM support_agents ORDER BY name, id'
    );
    return res.json({ agents: agents.map(normalizeAgent) });
  } catch (error) {
    console.error('[SUPPORT_AGENT_LIST]', error);
    return res.status(500).json({ message: 'Could not load support agents.' });
  }
});

router.post('/agents', authenticateAdmin, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[a-z0-9._-]{3,50}$/.test(username) || !name || name.length > 100 ||
      password.length < 12 || password.length > 128) {
    return res.status(400).json({
      message: 'Use a 3–50 character user ID, a name, and a password of at least 12 characters.',
    });
  }
  try {
    await ensureTables();
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'INSERT INTO support_agents (username, name, password_hash) VALUES (?, ?, ?)',
      [username, name, hash]
    );
    const [[agent]] = await pool.query(
      'SELECT id, username, name, is_active, created_at FROM support_agents WHERE id = ?',
      [result.insertId]
    );
    return res.status(201).json({ agent: normalizeAgent(agent) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That support user ID is already in use.' });
    console.error('[SUPPORT_AGENT_CREATE]', error);
    return res.status(500).json({ message: 'Could not create support agent.' });
  }
});

router.patch('/agents/:id/status', authenticateAdmin, async (req, res) => {
  if (!validId(req.params.id) || ![true, false, 0, 1].includes(req.body?.is_active)) {
    return res.status(400).json({ message: 'A valid agent ID and active status are required.' });
  }
  try {
    await ensureTables();
    const [result] = await pool.query(
      'UPDATE support_agents SET is_active = ? WHERE id = ?',
      [Number(Boolean(req.body.is_active)), req.params.id]
    );
    return result.affectedRows
      ? res.json({ message: 'Support agent status updated.' })
      : res.status(404).json({ message: 'Support agent not found.' });
  } catch (error) {
    console.error('[SUPPORT_AGENT_STATUS]', error);
    return res.status(500).json({ message: 'Could not update support agent.' });
  }
});

router.get('/customers', authenticateSupportAgent, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search.length < 2 || search.length > 100) {
    return res.status(400).json({ message: 'Enter at least 2 characters to search customers.' });
  }
  try {
    const term = `%${search}%`;
    const [customers] = await pool.query(
      `SELECT id, name, email, phone, is_active, created_at, wallet_balance, loyalty_points
       FROM users WHERE role = 'customer' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)
       ORDER BY name LIMIT 30`,
      [term, term, term]
    );
    return res.json({ customers });
  } catch (error) {
    console.error('[SUPPORT_CUSTOMER_SEARCH]', error);
    return res.status(500).json({ message: 'Could not search customers.' });
  }
});

router.get('/customers/:id', authenticateSupportAgent, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid customer ID.' });
  try {
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found.' });
    const [[customer]] = await pool.query(
      `SELECT id, name, email, phone, is_active, created_at, wallet_balance, loyalty_points
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    const [orders] = await pool.query(
      `SELECT id, order_number, status, payment_status, payment_mode, total, subtotal,
              discount, shipping_cost, tracking_number, courier, created_at, address_snapshot
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );
    for (const order of orders) {
      const [items] = await pool.query(
        'SELECT id, name, price, quantity FROM order_items WHERE order_id = ? ORDER BY id',
        [order.id]
      );
      order.items = items;
    }
    const [tickets] = await pool.query(
      'SELECT id, subject, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    return res.json({ customer, orders, tickets });
  } catch (error) {
    console.error('[SUPPORT_CUSTOMER_DETAILS]', error);
    return res.status(500).json({ message: 'Could not load customer details.' });
  }
});

router.patch('/customers/:id/status', authenticateSupportAgent, async (req, res) => {
  if (!validId(req.params.id) || !['active', 'disabled'].includes(req.body?.status)) {
    return res.status(400).json({ message: 'Choose active or disabled status.' });
  }
  try {
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found.' });
    await updateUserStatus(req.params.id, req.body.status);
    return res.json({ is_active: req.body.status === 'active' ? 1 : 0 });
  } catch (error) {
    console.error('[SUPPORT_CUSTOMER_STATUS]', error);
    return res.status(500).json({ message: 'Could not update customer status.' });
  }
});

router.post('/customers/:id/email', authenticateSupportAgent, async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!validId(req.params.id) || !subject || subject.length > 200 || !validMessage(message)) {
    return res.status(400).json({ message: 'Provide a subject and a message (up to 10,000 characters).' });
  }
  try {
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found.' });
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    await sendMail({
      to: user.email,
      subject,
      text: message,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6">${safeMessage}<p>— Bhumivera Customer Support</p></div>`,
    });
    return res.json({ message: 'Email sent.' });
  } catch (error) {
    console.error('[SUPPORT_CUSTOMER_EMAIL]', error);
    return res.status(502).json({ message: 'Email could not be sent. Please retry after checking delivery status.' });
  }
});

router.post('/customers/:id/password-reset-link', resetLinkLimiter, authenticateSupportAgent, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid customer ID.' });
  try {
    const user = await getUserById(req.params.id);
    if (!user || user.role !== 'customer') return res.status(404).json({ message: 'Customer not found.' });
    const token = jwt.sign(
      { sub: String(user.id), email: user.email, role: 'customer', aud: 'reset', scope: 'reset-password' },
      secret(),
      { expiresIn: '30m', jwtid: crypto.randomUUID() }
    );
    const frontendUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');
    const resetUrl = `${frontendUrl}/reset-password?mode=support&token=${encodeURIComponent(token)}`;
    await sendMail({
      to: user.email,
      subject: 'Secure link to update your Bhumivera password',
      text: `A Bhumivera support agent initiated a secure password update. Open this one-time link within 30 minutes: ${resetUrl}\nIf you did not request help, ignore this email.`,
      html: `<p>A Bhumivera support agent initiated a secure password update for your account.</p><p><a href="${escapeHtml(resetUrl)}">Update your password</a></p><p>This one-time link expires in 30 minutes. If you did not request help, ignore this email.</p>`,
    });
    return res.json({ message: `Secure reset link sent to ${user.email}. It expires in 30 minutes.` });
  } catch (error) {
    console.error('[SUPPORT_PASSWORD_RESET_LINK]', error);
    return res.status(502).json({ message: 'The reset link email could not be sent.' });
  }
});

router.get('/tickets', authenticateSupportAgent, async (req, res) => {
  try {
    const tickets = await ContactModel.getAllTickets();
    const messages = await ContactModel.getMessagesByTicketIds(tickets.map(ticket => ticket.id));
    const byTicket = new Map();
    for (const message of messages) {
      if (!byTicket.has(message.ticket_id)) byTicket.set(message.ticket_id, []);
      byTicket.get(message.ticket_id).push(message);
    }
    return res.json({
      tickets: tickets.map(ticket => ({
        ...ticket,
        messages: [
          { id: `ticket-${ticket.id}`, ticket_id: ticket.id, sender_type: 'customer', message: ticket.message, created_at: ticket.created_at },
          ...(byTicket.get(ticket.id) || []),
        ],
      })),
    });
  } catch (error) {
    console.error('[SUPPORT_TICKETS]', error);
    return res.status(500).json({ message: 'Could not load support tickets.' });
  }
});

router.patch('/tickets/:id', authenticateSupportAgent, async (req, res) => {
  const status = req.body?.status;
  const reply = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
  if (!validId(req.params.id) || !['open', 'in_progress', 'resolved', 'closed'].includes(status) ||
      req.body?.reply !== undefined && !validMessage(reply)) {
    return res.status(400).json({ message: 'Provide a valid ticket status and reply.' });
  }
  try {
    const [[ticket]] = await pool.query(
      'SELECT id, name, email, subject FROM support_tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
    const updated = await ContactModel.updateTicketStatus(Number(req.params.id), status, reply || null);
    if (!updated) return res.status(404).json({ message: 'Ticket not found.' });
    if (!reply) return res.json({ message: 'Ticket updated.', emailSent: null });
    try {
      const safeReply = escapeHtml(reply).replace(/\n/g, '<br>');
      await sendMail({
        to: ticket.email,
        subject: `Re: ${ticket.subject}`,
        text: `Hello ${ticket.name},\n\n${reply}\n\nBhumivera Customer Support`,
        html: `<p>Hello ${escapeHtml(ticket.name)},</p><p>${safeReply}</p><p>Bhumivera Customer Support</p>`,
      });
      return res.json({ message: 'Reply sent.', emailSent: true });
    } catch (error) {
      console.error('[SUPPORT_TICKET_REPLY_EMAIL]', error);
      return res.json({ message: 'Reply saved, but the email could not be sent.', emailSent: false });
    }
  } catch (error) {
    console.error('[SUPPORT_TICKET_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update support ticket.' });
  }
});

module.exports = router;
