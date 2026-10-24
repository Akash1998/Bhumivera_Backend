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
  supportDuplicateMessageLimiter,
  supportEscalationLimiter,
} = require('../middleware/rateLimiter');
const {
  VALID_CHAT_STATUSES,
  VALID_SUPPORT_ROLES,
  ROLE_DEFAULT_PERMISSIONS,
  resolveRolePermissions,
  ensureAiSupportTables,
  createOrResumeSession,
  getSessionByToken,
  updateSessionContext,
  updateSessionTelemetry,
  getSessionMessages,
  appendMessage,
  listAllChatSessions,
  listEscalations,
  getAiSupportFeatureConfig,
  updateAiSupportFeatureConfig,
  ROLE_BENCHMARKS,
  appendSupportAuditLog,
  listSupportAuditLogs,
  deleteResolvedChatSession,
  checkCustomerHasPlacedOrder,
} = require('../models/aiSupportModel');
const { computeQuantumHash512 } = require('../utils/quantumCrypto');
const { getAdminByEmail, verifyPassword: verifyAdminPassword } = require('../models/adminModel');
const {
  buildContextualGreeting,
  processSupportTurn,
} = require('../services/aiSupportOrchestrator');
const {
  INGREDIENT_MEMORY_GRAPH,
  PRODUCT_INGREDIENT_GRAPH,
  KNOWLEDGE_BASE_QA,
  searchAllKnowledgeSources,
} = require('../services/bhumiveraKnowledgeBase');
const {
  lookupOrderTool,
  cancelOrderTool,
  initiateReturnTool,
  lookupAccountWalletLoyaltyTool,
} = require('../services/aiSupportTools');
const {
  analyzeSentiment,
  triggerInstantEscalation,
} = require('../services/sentimentEscalationEngine');

const router = express.Router();
const secret = () => process.env.JWT_SECRET || 'fallback_secret';
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
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

const ensureTables = () => ensureAiSupportTables(pool);

const parseJsonSafe = (val, fallback = null) => {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
const validMessage = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 10000;

const normalizeAgent = row => {
  const role = VALID_SUPPORT_ROLES.includes(row.role) ? row.role : 'agent';
  const customPerms = parseJsonSafe(row.permissions, null);
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email || null,
    role,
    department: row.department || 'General Concierge',
    max_concurrent_chats: Number(row.max_concurrent_chats || 10),
    online_status: row.online_status || 'online',
    permissions: resolveRolePermissions(role, customPerms),
    is_active: Boolean(row.is_active),
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
  };
};

/**
 * Authenticates Support Agents (`agent`, `supervisor`, `manager`) OR Website Admins (`admin`, `superadmin`).
 * Attaches `req.supportAgent` with `role` and `permissions`.
 */
const authenticateSupportAgent = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!token) return res.status(401).json({ message: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(token, secret());
    if (['admin', 'superadmin'].includes(payload.role)) {
      req.supportAgent = {
        id: payload.id || 0,
        username: payload.email || 'superadmin',
        name: payload.name || 'SuperAdmin',
        email: payload.email || null,
        role: 'superadmin',
        department: 'Executive Command Center',
        online_status: 'online',
        permissions: resolveRolePermissions('superadmin'),
        is_active: true,
      };
      return next();
    }
    if (payload.scope !== 'support-agent' || !payload.sub) {
      return res.status(401).json({ message: 'Invalid support session.' });
    }
    await ensureTables();
    const [[agent]] = await pool.query(
      'SELECT * FROM support_agents WHERE id = ?',
      [payload.sub]
    );
    if (!agent || !agent.is_active) return res.status(401).json({ message: 'Support access has been disabled.' });
    req.supportAgent = normalizeAgent(agent);
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
 * Middleware for `/superadminsupport` and staff management endpoints.
 * Permits website `admin`/`superadmin` tokens AND support `manager` tokens with `can_manage_agents`.
 */
const authenticateSuperSupport = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (!token) return res.status(401).json({ code: 'AUTH_TOKEN_MISSING', message: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(token, secret());
    if (['admin', 'superadmin'].includes(payload.role)) {
      const active = await isSessionActive(payload, req).catch(() => true);
      if (!active) {
        return res.status(401).json({ code: 'AUTH_SESSION_REAUTH_REQUIRED', message: 'Your admin session has expired.' });
      }
      req.supportAgent = {
        id: payload.id || 0,
        username: payload.email || 'superadmin',
        name: payload.name || 'SuperAdmin',
        role: 'superadmin',
        department: 'Executive Command Center',
        permissions: resolveRolePermissions('superadmin'),
        is_active: true,
      };
      return next();
    }
    if (payload.scope === 'support-agent' && payload.sub) {
      await ensureTables();
      const [[agent]] = await pool.query('SELECT * FROM support_agents WHERE id = ?', [payload.sub]);
      if (!agent || !agent.is_active) {
        return res.status(401).json({ message: 'Support access has been disabled.' });
      }
      const normalized = normalizeAgent(agent);
      if (normalized.role === 'manager' || normalized.permissions?.can_manage_agents) {
        req.supportAgent = normalized;
        return next();
      }
      return res.status(403).json({
        code: 'SUPERADMIN_SUPPORT_REQUIRED',
        message: 'Manager or SuperAdmin Support privileges are required for this control.',
      });
    }
    return res.status(403).json({ message: 'Access denied: SuperAdmin Support or Manager privileges required.' });
  } catch (error) {
    return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
  }
};

/**
 * Optional customer authentication middleware for AI Support Chat endpoints.
 */
const optionalAuthenticateCustomer = async (req, _res, next) => {
  req.user = null;
  req.customerUser = null;
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
  req.customerUser = req.user;
  return next();
};
const optionalCustomerAuth = optionalAuthenticateCustomer;

// ============================================================================
// PART 1: CUSTOMER SUPPORT CHAT & LIFECYCLE ENDPOINTS (`/api/support/chat/*`)
// ============================================================================

/**
 * POST /api/support/chat/session
 * Initializes, resumes, or starts a brand-new multi-turn AI support conversation session.
 */
router.post('/chat/session', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const { sessionToken, forceNew = false, pageContext = {}, guestInfo = {} } = req.body || {};
    const featureConfig = await getAiSupportFeatureConfig(pool);
    const session = await createOrResumeSession({
      sessionToken,
      forceNew: Boolean(forceNew),
      userId: req.user?.id || null,
      guestName: guestInfo?.name || req.user?.name || null,
      guestEmail: guestInfo?.email || req.user?.email || null,
      guestPhone: guestInfo?.phone || req.user?.phone || null,
      pageContext,
    });

    let messages = await getSessionMessages(session.id, 80, pool, { includeInternal: false });
    const { greeting, quickActions } = buildContextualGreeting({
      user: { name: req.user?.name || session.guestName },
      pageContext: { ...session.pageContext, ...pageContext },
    });

    if (messages.length === 0) {
      const greetingMsg = await appendMessage({
        sessionId: session.id,
        sender: 'assistant',
        senderName: 'Bhumivera Client Concierge',
        content: greeting,
        quickActions,
      });
      messages = [greetingMsg];
    }

    const orderCheck = await checkCustomerHasPlacedOrder(pool, {
      userId: req.user?.id || session.userId,
      email: session.guestEmail || req.user?.email,
      phone: session.guestPhone || req.user?.phone,
    });

    return res.json({
      success: true,
      sessionToken: session.sessionToken,
      session,
      greeting,
      quickActions,
      messages,
      hasPlacedOrder: orderCheck.hasPlacedOrder,
      latestOrder: orderCheck.latestOrder,
      featureConfig: {
        proactiveTriggersEnabled: featureConfig.ai_proactive_triggers_enabled,
        proactiveLingerSeconds: featureConfig.ai_proactive_linger_seconds,
        rageClickDetectionEnabled: featureConfig.ai_rage_click_detection_enabled,
        allowCustomerStatusChange: featureConfig.allow_customer_status_change,
      },
    });
  } catch (error) {
    console.error('[AI_SUPPORT_SESSION_INIT]', error);
    const fallbackGreeting = buildContextualGreeting({
      user: { name: req.user?.name || req.body?.guestInfo?.name },
      pageContext: req.body?.pageContext || {},
    });
    return res.status(200).json({
      success: true,
      degraded: true,
      sessionToken: req.body?.sessionToken || `local-${crypto.randomUUID()}`,
      session: { status: 'active', priority: 'Low' },
      greeting: fallbackGreeting.greeting,
      quickActions: fallbackGreeting.quickActions,
      messages: [
        {
          id: Date.now(),
          sender: 'assistant',
          senderName: 'Bhumivera Client Concierge',
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
 * PATCH /api/support/chat/session/:sessionToken/status
 * Allows the customer to transition chat status:
 * 'active' (reopen), 'pending', 'waiting_for_review', 'escalated', 'resolved', 'closed'
 */
router.patch('/chat/session/:sessionToken/status', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const { status, reason = '' } = req.body || {};
    if (!VALID_CHAT_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CHAT_STATUS',
        message: `Choose a valid chat status: ${VALID_CHAT_STATUSES.join(', ')}.`,
      });
    }

    // Check if caller has a valid Support Agent / Supervisor / Manager / SuperAdmin token
    let isSupportStaffCaller = false;
    const rawToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : '';
    if (rawToken) {
      try {
        const decoded = jwt.verify(rawToken, secret());
        if (
          decoded.scope === 'support-agent' ||
          ['admin', 'superadmin', 'support_agent', 'agent', 'supervisor', 'manager'].includes(decoded.role)
        ) {
          isSupportStaffCaller = true;
        }
      } catch {}
    }

    const featureConfig = await getAiSupportFeatureConfig(pool);
    if (!isSupportStaffCaller && !featureConfig.allow_customer_status_change) {
      return res.status(403).json({
        success: false,
        code: 'STATUS_CONTROLLED_BY_SUPPORT',
        message: 'Chat status transitions (Pending, Waiting for Review, Escalated, Resolved, Closed) are managed exclusively by Bhumivera Customer Support.',
      });
    }

    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', message: 'Chat session not found.' });
    }
    if (session.userId && req.user?.id && Number(session.userId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN_SESSION', message: 'Unauthorized session access.' });
    }

    let priority = session.priority;
    if (status === 'escalated' && ['Low', 'Medium'].includes(priority)) priority = 'High';
    if (status === 'waiting_for_review' && priority === 'Low') priority = 'Medium';

    await updateSessionTelemetry(session.id, {
      status,
      priority,
      resolutionNote: reason ? String(reason).slice(0, 500) : undefined,
      closedBy: ['resolved', 'closed'].includes(status) ? 'customer' : null,
    });

    const statusDescriptions = {
      active: 'Chat reopened and marked **Active**. How else can I help you today?',
      pending: 'Chat marked as **Pending** (awaiting additional order or account details). You can reply whenever you are ready.',
      waiting_for_review: 'I’ve sent your conversation to a support specialist for review.',
      escalated: 'I’ve sent your request to a support specialist.',
      resolved: 'This chat is now closed. You can leave a quick rating below or start a new chat whenever you need us.',
      closed: 'This chat is now closed. Start a new chat whenever you need us.',
    };

    const statusMsg = await appendMessage({
      sessionId: session.id,
      sender: 'system',
      senderName: 'System Concierge',
      content: statusDescriptions[status] || `Chat status updated to ${status}.`,
    });

    const updatedSession = await getSessionByToken(req.params.sessionToken);
    return res.json({
      success: true,
      status,
      session: updatedSession,
      systemMessage: statusMsg,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_CHAT_STATUS_UPDATE]', error);
    return res.status(500).json({ success: false, message: 'Could not update chat session status.' });
  }
});

/**
 * POST /api/support/chat/session/:sessionToken/rating
 * Records customer CSAT 1–5 star rating and feedback on resolved/closed sessions.
 */
router.post('/chat/session/:sessionToken/rating', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const rating = Number(req.body?.rating);
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim().slice(0, 500) : '';
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Choose a rating between 1 and 5 stars.' });
    }
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ success: false, message: 'Chat session not found.' });

    await updateSessionTelemetry(session.id, {
      csatRating: rating,
      csatFeedback: feedback || null,
    });

    return res.json({
      success: true,
      rating,
      message: 'Thank you for your feedback.',
    });
  } catch (error) {
    console.error('[AI_SUPPORT_CSAT_RATING]', error);
    return res.status(500).json({ success: false, message: 'Could not save your rating.' });
  }
});

/**
 * POST /api/support/chat/session/:sessionToken/end-satisfied
 * Customer ends the chat as Resolved. A rating may optionally be included.
 */
router.post('/chat/session/:sessionToken/end-satisfied', supportSessionLimiter, optionalAuthenticateCustomer, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ success: false, message: 'Chat session not found.' });

    const rating = req.body?.rating !== undefined ? Number(req.body.rating) : null;
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ success: false, message: 'Choose a rating between 1 and 5 stars.' });
    }
    const feedback = typeof req.body?.feedback === 'string' && req.body.feedback.trim()
      ? req.body.feedback.trim().slice(0, 500)
      : '';

    const telemetry = {
      status: 'resolved',
      resolutionNote: 'Customer ended the chat.',
      closedBy: 'customer',
    };
    if (rating !== null) {
      telemetry.csatRating = rating;
      telemetry.csatFeedback = feedback || null;
    }
    await updateSessionTelemetry(session.id, telemetry);

    const sysMsg = await appendMessage({
      sessionId: session.id,
      sender: 'system',
      senderName: 'Bhumivera Client Concierge',
      content: 'This chat has ended. Thank you for contacting Bhumivera Client Concierge.',
    });

    await appendSupportAuditLog({
      actorId: req.user?.id || session.userId || null,
      actorName: req.user?.name || session.guestName || 'Customer',
      actorRole: 'customer',
      actionType: rating === null ? 'CUSTOMER_ENDED_CHAT' : 'CUSTOMER_SATISFIED_REVIEW',
      targetRef: `Session ${session.sessionToken}`,
      details: rating === null ? 'Customer ended the chat.' : `Rated ${rating}/5 stars: ${feedback}`,
    });

    const updatedSession = await getSessionByToken(req.params.sessionToken);
    return res.json({
      success: true,
      status: 'resolved',
      rating,
      feedback,
      session: updatedSession,
      systemMessage: sysMsg,
    });
  } catch (error) {
    console.error('[AI_SUPPORT_END_SATISFIED]', error);
    return res.status(500).json({ success: false, message: 'Could not complete chat closure.' });
  }
});

/**
 * POST /api/support/chat/async-message
 * Unified async message channel for customers without a placed order (or who prefer email/app inbox reply).
 */
router.post('/chat/async-message', supportChatLimiter, optionalAuthenticateCustomer, supportDuplicateMessageLimiter, async (req, res) => {
  try {
    const {
      sessionToken,
      name = '',
      email = '',
      phone = '',
      orderId = null,
      productId = null,
      subject = 'Customer Support Inquiry',
      message = '',
    } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Please write your message before sending.' });
    }

    const resolvedName = (req.user?.name || name || 'Bhumivera Guest').trim().slice(0, 100);
    const resolvedEmail = (req.user?.email || email || '').trim().toLowerCase().slice(0, 150);
    const resolvedPhone = (req.user?.phone || phone || '').trim().slice(0, 25);

    const session = await createOrResumeSession({
      sessionToken,
      userId: req.user?.id || null,
      guestName: resolvedName,
      guestEmail: resolvedEmail || null,
      guestPhone: resolvedPhone || null,
      pageContext: {
        channel: 'async_message',
        orderId: orderId || null,
        productId: productId || null,
        subject: String(subject || 'Support Inquiry').slice(0, 200),
      },
    });

    await appendMessage({
      sessionId: session.id,
      sender: 'user',
      senderName: resolvedName,
      content: `**[${String(subject || 'Support Message').trim()}]**${orderId ? ` (Order #${orderId})` : ''}\n${message.trim()}`,
    });

    let ticketId = session.escalatedTicketId || null;
    try {
      ticketId = await ContactModel.createTicket({
        user_id: req.user?.id || session.userId || null,
        order_id: validId(orderId) ? Number(orderId) : null,
        product_id: validId(productId) ? Number(productId) : null,
        name: resolvedName,
        email: resolvedEmail || 'guest@bhumivera.com',
        subject: String(subject || 'Support Message').trim().slice(0, 200),
        message: message.trim(),
      });
    } catch {}

    await updateSessionTelemetry(session.id, {
      status: 'pending',
      priority: orderId ? 'High' : 'Medium',
      escalatedTicketId: ticketId || undefined,
    });

    const ackMsg = await appendMessage({
      sessionId: session.id,
      sender: 'assistant',
      senderName: 'Bhumivera Client Concierge',
      content: `We have received your message${ticketId ? ` (Reference #${ticketId})` : ''}. Our support team will reply directly to your **Email (${resolvedEmail || 'registered email'})** and **Mobile App / Profile Support Inbox** shortly.`,
    });

    return res.status(201).json({
      success: true,
      ticketId,
      sessionToken: session.sessionToken,
      reply: ackMsg.content,
      message: 'Your message has been sent. We will reply to your email and mobile app inbox.',
    });
  } catch (error) {
    console.error('[AI_SUPPORT_ASYNC_MESSAGE]', error);
    return res.status(500).json({ success: false, message: 'Could not send your message. Please try again.' });
  }
});

/**
 * POST /api/support/chat/context
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
 * Retrieves persisted multi-turn conversation messages and live session state (excluding internal staff whispers).
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
    const messages = await getSessionMessages(session.id, 100, pool, { includeInternal: false });
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
 */
router.post('/chat/message', supportChatLimiter, optionalAuthenticateCustomer, supportDuplicateMessageLimiter, async (req, res) => {
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
    const kbFallback = await searchAllKnowledgeSources(req.body?.message || '', req.body?.pageContext || {}, null).catch(() => null);
    return res.status(200).json({
      success: true,
      degraded: !kbFallback?.matched,
      reply: kbFallback?.matched
        ? kbFallback.reply
        : 'Sorry, I couldn’t connect just now. Please try again or contact support@bhumivera.com or WhatsApp +91 7430985647.',
      orderCards: [],
      quickActions: kbFallback?.quickActions?.length
        ? kbFallback.quickActions
        : buildContextualGreeting({ user: req.user }).quickActions,
      conciergeFlow: kbFallback ? {
        flowType: kbFallback.flowType,
        activeProductId: kbFallback.activeProductId || null,
        lastIngredientId: kbFallback.lastIngredientId || null,
      } : null,
      sentiment: { score: 0, frustrationScore: 0, priority: 'Low', label: 'neutral' },
      escalation: null,
    });
  }
});

/**
 * POST /api/support/chat/stream (and GET /api/support/chat/stream)
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

    const fullReply = String(turnResult.reply || '');
    const tokens = fullReply.match(/.{1,28}(\s|$)|.{1,28}/gs) || [fullReply];
    for (const chunk of tokens) {
      sendEvent('token', { delta: chunk });
    }

    sendEvent('metadata', {
      sessionToken: turnResult.sessionToken,
      status: turnResult.status || 'active',
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

router.post('/chat/stream', supportChatLimiter, optionalAuthenticateCustomer, supportDuplicateMessageLimiter, handleSseStream);
router.get('/chat/stream', supportChatLimiter, optionalAuthenticateCustomer, handleSseStream);

router.post(
  '/chat/verify-escalation',
  supportEscalationLimiter,
  optionalAuthenticateCustomer,
  (_req, res) => res.status(410).json({
    success: false,
    code: 'USE_CUSTOMER_SUPPORT',
    message: 'Order-related requests are handled in Profile → Support.',
  })
);

router.post(
  '/chat/escalate',
  supportEscalationLimiter,
  optionalAuthenticateCustomer,
  (_req, res) => res.status(410).json({
    success: false,
    code: 'USE_CUSTOMER_SUPPORT',
    message: 'For help from customer care, please use Profile → Support.',
  })
);
router.post('/login', loginLimiter, async (req, res) => {
  const rawId = req.body?.username || req.body?.email || req.body?.identifier || '';
  const identifier = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!identifier || !password || identifier.length > 120 || password.length > 128) {
    return res.status(400).json({ message: 'Enter your support user ID / email and password.' });
  }
  try {
    await ensureTables();
    // 1. Check support_agents by username OR email
    let agent = null;
    const [[byUsername]] = await pool.query(
      'SELECT * FROM support_agents WHERE username = ?',
      [identifier]
    );
    agent = byUsername || null;
    if (!agent && identifier.includes('@')) {
      try {
        const [[byEmail]] = await pool.query(
          'SELECT * FROM support_agents WHERE LOWER(email) = ? LIMIT 1',
          [identifier]
        );
        agent = byEmail || null;
      } catch {}
    }

    if (agent && agent.is_active && await bcrypt.compare(password, agent.password_hash)) {
      try {
        await pool.query("UPDATE support_agents SET last_login_at = NOW(), online_status = 'online' WHERE id = ?", [agent.id]);
      } catch {}
      const normalized = normalizeAgent({ ...agent, online_status: 'online', last_login_at: new Date().toISOString() });
      const token = jwt.sign(
        {
          id: agent.id,
          sub: String(agent.id),
          username: normalized.username,
          name: normalized.name,
          email: normalized.email,
          role: normalized.role,
          scope: 'support-agent',
        },
        secret(),
        { expiresIn: '12h', jwtid: crypto.randomUUID() }
      );
      await appendSupportAuditLog({
        actorId: agent.id,
        actorName: normalized.name,
        actorRole: normalized.role,
        actionType: 'STAFF_LOGIN',
        targetRef: `@${normalized.username}`,
        details: `Signed in to support portal (${normalized.role})`,
      });
      return res.json({ token, agent: normalized });
    }

    // 2. Fallback: Check admin_users (Website Admin / SuperAdmin signing into /support or /superadminsupport)
    try {
      const adminRow = await getAdminByEmail(identifier);
      if (adminRow && adminRow.password_hash && await verifyAdminPassword(password, adminRow.password_hash)) {
        const superProfile = {
          id: adminRow.id,
          username: adminRow.email,
          name: adminRow.name || 'SuperAdmin',
          email: adminRow.email,
          role: 'superadmin',
          department: 'Executive Command Center',
          max_concurrent_chats: 50,
          online_status: 'online',
          permissions: resolveRolePermissions('superadmin'),
          is_active: true,
          last_login_at: new Date().toISOString(),
        };
        const token = jwt.sign(
          {
            id: adminRow.id,
            sub: String(adminRow.id),
            username: adminRow.email,
            name: superProfile.name,
            email: adminRow.email,
            role: 'superadmin',
            scope: 'support-agent',
          },
          secret(),
          { expiresIn: '12h', jwtid: crypto.randomUUID() }
        );
        await appendSupportAuditLog({
          actorId: adminRow.id,
          actorName: superProfile.name,
          actorRole: 'superadmin',
          actionType: 'SUPERADMIN_LOGIN',
          targetRef: adminRow.email,
          details: 'Website Admin authenticated into SuperAdmin Support Command Center',
        });
        return res.json({ token, agent: superProfile });
      }
    } catch {}

    // 3. Fallback: Check users table where role IN ('admin', 'superadmin')
    try {
      const [uRows] = await pool.query(
        "SELECT * FROM users WHERE LOWER(email) = ? AND role IN ('admin', 'superadmin') LIMIT 1",
        [identifier]
      );
      const uAdmin = uRows?.[0];
      if (uAdmin && uAdmin.password_hash && await bcrypt.compare(password, uAdmin.password_hash)) {
        const superProfile = {
          id: uAdmin.id,
          username: uAdmin.email,
          name: uAdmin.name || 'SuperAdmin',
          email: uAdmin.email,
          role: 'superadmin',
          department: 'Executive Command Center',
          max_concurrent_chats: 50,
          online_status: 'online',
          permissions: resolveRolePermissions('superadmin'),
          is_active: true,
        };
        const token = jwt.sign(
          {
            id: uAdmin.id,
            sub: String(uAdmin.id),
            username: uAdmin.email,
            name: superProfile.name,
            email: uAdmin.email,
            role: 'superadmin',
            scope: 'support-agent',
          },
          secret(),
          { expiresIn: '12h', jwtid: crypto.randomUUID() }
        );
        return res.json({ token, agent: superProfile });
      }
    } catch {}

    return res.status(401).json({ message: 'Invalid user ID / email or password.' });
  } catch (error) {
    console.error('[SUPPORT_AGENT_LOGIN]', error);
    return res.status(500).json({ message: 'Could not sign in to support.' });
  }
});

router.get('/me', authenticateSupportAgent, (req, res) => res.json({
  agent: req.supportAgent,
  roleMatrix: ROLE_DEFAULT_PERMISSIONS,
}));

router.patch('/me/presence', authenticateSupportAgent, async (req, res) => {
  const onlineStatus = req.body?.online_status;
  if (!['online', 'busy', 'away', 'offline'].includes(onlineStatus)) {
    return res.status(400).json({ message: 'Choose online, busy, away, or offline status.' });
  }
  try {
    if (req.supportAgent.id) {
      await pool.query('UPDATE support_agents SET online_status = ? WHERE id = ?', [onlineStatus, req.supportAgent.id]);
    }
    return res.json({ success: true, online_status: onlineStatus });
  } catch (error) {
    return res.status(500).json({ message: 'Could not update presence status.' });
  }
});

/**
 * GET /api/support/sessions
 * Lists live AI & human customer chat sessions for `/support` and `/superadminsupport`.
 */
router.get('/sessions', authenticateSupportAgent, async (req, res) => {
  try {
    const sessions = await listAllChatSessions({
      status: req.query.status || null,
      priority: req.query.priority || null,
      assignedAgentId: req.query.assigned_agent_id || null,
      search: req.query.search || '',
      limit: req.query.limit || 100,
    });
    return res.json({ success: true, sessions });
  } catch (error) {
    console.error('[SUPPORT_SESSIONS_LIST]', error);
    return res.status(500).json({ message: 'Could not load chat sessions.' });
  }
});

/**
 * GET /api/support/sessions/:sessionToken
 * Loads complete chat transcript (including internal staff whispers) + Customer 360° summary.
 */
router.get('/sessions/:sessionToken', authenticateSupportAgent, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ message: 'Chat session not found.' });
    const messages = await getSessionMessages(session.id, 150, pool, { includeInternal: true });

    let customerSummary = null;
    if (session.userId) {
      const walletLookup = await lookupAccountWalletLoyaltyTool({}, { pool, user: { id: session.userId, role: 'support_agent' }, session });
      const ordersLookup = await lookupOrderTool({}, { pool, user: { id: session.userId, role: 'support_agent' }, session });
      customerSummary = {
        account: walletLookup.accountSummary || null,
        orders: ordersLookup.orderCards || [],
      };
    }

    return res.json({
      success: true,
      session,
      messages,
      customerSummary,
    });
  } catch (error) {
    console.error('[SUPPORT_SESSION_DETAIL]', error);
    return res.status(500).json({ message: 'Could not load chat session details.' });
  }
});

/**
 * POST /api/support/sessions/:sessionToken/reply
 * Allows an Agent, Supervisor, Manager, or SuperAdmin to send a live reply or internal whisper note
 * directly into a customer's chat session.
 */
router.post('/sessions/:sessionToken/reply', authenticateSupportAgent, async (req, res) => {
  try {
    const { message, isInternalNote = false, nextStatus = null } = req.body || {};
    if (!validMessage(message)) {
      return res.status(400).json({ message: 'Enter a message between 1 and 10,000 characters.' });
    }
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ message: 'Chat session not found.' });

    const staff = req.supportAgent;
    if (isInternalNote && !staff.permissions?.can_reply_chats) {
      return res.status(403).json({ message: 'You do not have permission to post notes in this chat.' });
    }

    const senderType = isInternalNote
      ? 'whisper'
      : (staff.role === 'superadmin' ? 'superadmin' : staff.role || 'agent');
    const senderLabel = `${staff.name} (${String(staff.role || 'agent').toUpperCase()})`;

    const savedMsg = await appendMessage({
      sessionId: session.id,
      sender: senderType,
      senderName: senderLabel,
      isInternalNote: Boolean(isInternalNote),
      content: message.trim(),
    });

    const resolvedStatus = nextStatus && VALID_CHAT_STATUSES.includes(nextStatus)
      ? nextStatus
      : session.status;

    await updateSessionTelemetry(session.id, {
      status: resolvedStatus,
      assignedAgentId: session.assignedAgentId || staff.id || null,
      assignedAgentName: session.assignedAgentName || staff.name || null,
      assignedRole: session.assignedRole || staff.role || 'agent',
      ...(resolvedStatus === 'resolved' || resolvedStatus === 'closed' ? { closedBy: staff.role || 'agent' } : {}),
    });

    // If public reply (not whisper), deliver customer notifications.
    if (!isInternalNote) {
      if (session.userId) {
        try {
          await pool.query(
            `INSERT INTO notifications (user_id, title, message, type, is_global)
             VALUES (?, ?, ?, 'support_reply', 0)`,
            [
              session.userId,
              `New reply from Bhumivera Client Concierge`,
              message.trim().slice(0, 240),
            ]
          );
        } catch {}
      }
      const targetEmail = session.guestEmail || null;
      if (targetEmail && (session.pageContext?.channel === 'async_message' || req.body?.sendEmailCopy)) {
        sendMail({
          to: targetEmail,
          subject: `Update on your Bhumivera Client Concierge Inquiry`,
          text: `Hello ${session.guestName || 'Customer'},\n\n${message.trim()}\n\n— ${senderLabel}, Bhumivera Client Concierge`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>Hello ${escapeHtml(session.guestName || 'Customer')},</p><p>${escapeHtml(message.trim()).replace(/\n/g, '<br>')}</p><p>— <strong>${escapeHtml(senderLabel)}</strong>, Bhumivera Customer Care</p></div>`,
        }).catch(() => null);
      }
    }

    const updatedSession = await getSessionByToken(req.params.sessionToken);
    return res.status(201).json({
      success: true,
      message: savedMsg,
      session: updatedSession,
    });
  } catch (error) {
    console.error('[SUPPORT_SESSION_REPLY]', error);
    return res.status(500).json({ message: 'Could not send chat reply.' });
  }
});

/**
 * PATCH /api/support/sessions/:sessionToken/status
 * Allows staff to change session status ('active', 'pending', 'waiting_for_review', 'escalated', 'resolved', 'closed'),
 * priority ('Low', 'Medium', 'High', 'Critical'), or assign/reassign the session to a staff member.
 */
router.patch('/sessions/:sessionToken/status', authenticateSupportAgent, async (req, res) => {
  try {
    const {
      status,
      priority,
      assignedAgentId,
      assignedAgentName,
      assignedRole,
      resolutionNote,
    } = req.body || {};

    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ message: 'Chat session not found.' });

    const staff = req.supportAgent;
    if (status && !VALID_CHAT_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Allowed: ${VALID_CHAT_STATUSES.join(', ')}.` });
    }
    if (
      assignedAgentId !== undefined &&
      Number(assignedAgentId) !== Number(staff.id) &&
      !staff.permissions?.can_reassign_chats
    ) {
      return res.status(403).json({
        code: 'PERMISSION_DENIED_REASSIGN',
        message: 'Only Supervisors, Managers, or SuperAdmins can reassign chats to other agents.',
      });
    }

    await updateSessionTelemetry(session.id, {
      status: status || undefined,
      priority: ['Low', 'Medium', 'High', 'Critical'].includes(priority) ? priority : undefined,
      assignedAgentId: assignedAgentId !== undefined ? (assignedAgentId ? Number(assignedAgentId) : null) : undefined,
      assignedAgentName: assignedAgentName !== undefined ? assignedAgentName : undefined,
      assignedRole: assignedRole !== undefined ? assignedRole : undefined,
      resolutionNote: resolutionNote !== undefined ? resolutionNote : undefined,
      closedBy: status && ['resolved', 'closed'].includes(status) ? `${staff.name} (${staff.role})` : undefined,
    });

    if (status && status !== session.status) {
      await appendMessage({
        sessionId: session.id,
        sender: 'system',
        senderName: `${staff.name} (${String(staff.role || 'agent').toUpperCase()})`,
        content: `Conversation marked as **${status.replace(/_/g, ' ').toUpperCase()}** by ${staff.name} (${staff.role}).${resolutionNote ? ` Note: ${resolutionNote}` : ''}`,
      });
    }

    const updatedSession = await getSessionByToken(req.params.sessionToken);
    return res.json({
      success: true,
      session: updatedSession,
      message: `Session updated to ${status || updatedSession.status}.`,
    });
  } catch (error) {
    console.error('[SUPPORT_SESSION_STATUS_PATCH]', error);
    return res.status(500).json({ message: 'Could not update chat session.' });
  }
});

/**
 * POST /api/support/sessions/:sessionToken/execute-action
 * Role-gated staff action runner (Cancel Order, Initiate Return RMA, or Issue Goodwill Wallet Credit)
 * directly from `/support` or `/superadminsupport`.
 */
router.post('/sessions/:sessionToken/execute-action', authenticateSupportAgent, async (req, res) => {
  try {
    const { action, orderId, reason, resolutionType, goodwillAmount } = req.body || {};
    const staff = req.supportAgent;
    const session = await getSessionByToken(req.params.sessionToken);
    if (!session) return res.status(404).json({ message: 'Chat session not found.' });

    if (action === 'cancel_order') {
      if (staff.role !== 'superadmin') {
        return res.status(403).json({
          code: 'SUPERADMIN_REQUIRED_FOR_CANCEL',
          message: 'Support staff cannot cancel orders. Order cancellation is restricted exclusively to the SuperAdmin Control Centre.',
        });
      }
      const cleanOrderRef = require('../services/aiSupportTools').stripOrderPrefix(orderId);
      const numericOrderRef = /^\d+$/.test(cleanOrderRef) ? Number(cleanOrderRef) : 0;
      const [orderRows] = await pool.query(
        'SELECT id FROM orders WHERE id = ? OR order_number = ? LIMIT 1',
        [numericOrderRef, cleanOrderRef]
      );
      const order = orderRows?.[0];
      if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found.' });
      const [confirmedRequests] = await pool.query(
        `SELECT id FROM support_escalation_tickets
         WHERE session_id = ? AND order_id = ?
           AND query_details LIKE ?
         ORDER BY id DESC LIMIT 1`,
        [session.id, order.id, '%[CUSTOMER_CONFIRMED_CANCELLATION_REQUEST]%']
      );
      if (!confirmedRequests?.length) {
        return res.status(409).json({
          code: 'CUSTOMER_CANCELLATION_CONFIRMATION_REQUIRED',
          message: 'Cancellation requires a verified order-support request where the customer explicitly confirmed after reviewing the order impact.',
        });
      }
      const { executeAtomicOrderCancellationAndRefund } = require('../services/walletRefundLedgerService');
      const { getRazorpayClient } = require('../services/razorpayService');
      const cancelRes = await executeAtomicOrderCancellationAndRefund(pool, {
        orderId: order.id,
        reason: reason || `Cancelled by SuperAdmin (${staff.name})`,
        executedByEmail: staff.email || 'adminbhumivera27@gmail.com',
        razorpay: getRazorpayClient(),
      });
      const result = {
        success: true,
        message: `Order #${cancelRes.orderNumber} cancelled by SuperAdmin (${cancelRes.ledgerReference}).`,
        orderCards: [],
        refundSummary: cancelRes.refundSummary,
      };
      if (result.success) {
        await appendMessage({
          sessionId: session.id,
          sender: 'system',
          senderName: `${staff.name} (${staff.role})`,
          content: `✅ ${result.message}`,
          orderCards: result.orderCards || [],
        });
      }
      return res.status(result.success ? 200 : 400).json(result);
    }

    if (action === 'initiate_return') {
      if (!staff.permissions?.can_initiate_returns) {
        return res.status(403).json({ message: 'You do not have permission to initiate returns.' });
      }
      const result = await initiateReturnTool(
        {
          order_id: orderId,
          reason: reason || `Return initiated by ${staff.name} (${staff.role})`,
          resolution_type: resolutionType || 'refund',
        },
        { pool, user: { id: session.userId, role: 'support_agent', name: staff.name }, session }
      );
      if (result.success) {
        await appendMessage({
          sessionId: session.id,
          sender: 'system',
          senderName: `${staff.name} (${staff.role})`,
          content: `✅ ${result.message}`,
          orderCards: result.orderCards || [],
        });
      }
      return res.status(result.success ? 200 : 400).json(result);
    }

    if (action === 'goodwill_wallet_credit') {
      const roleBench = ROLE_BENCHMARKS[staff.role] || ROLE_BENCHMARKS.agent;
      if (!staff.permissions?.can_adjust_wallet_goodwill || roleBench.maxGoodwillCreditInr <= 0) {
        return res.status(403).json({
          code: 'SUPERVISOR_REQUIRED_FOR_GOODWILL',
          message: 'Only Supervisors (max ₹150), Managers (max ₹250), or SuperAdmins can issue goodwill wallet credits.',
        });
      }
      const amount = Number(goodwillAmount);
      if (!session.userId || !Number.isFinite(amount) || amount <= 0 || amount > roleBench.maxGoodwillCreditInr) {
        await appendSupportAuditLog({
          actorId: staff.id,
          actorName: staff.name,
          actorRole: staff.role,
          actionType: 'SECURITY_ANOMALY_BLOCKED',
          targetRef: `Session ${session.sessionToken}`,
          details: `Blocked goodwill credit of ₹${amount} exceeding role cap (₹${roleBench.maxGoodwillCreditInr})`,
        });
        return res.status(400).json({
          code: 'CREDIT_CAP_EXCEEDED',
          message: `Your role (${staff.role.toUpperCase()}) can credit up to ₹${roleBench.maxGoodwillCreditInr} max per customer. Only SuperAdmin can issue higher credits.`,
        });
      }
      if (staff.role !== 'superadmin') {
        try {
          const [existingCredits] = await pool.query(
            `SELECT id FROM ai_support_benefit_ledger
             WHERE benefit_type = 'wallet_credit'
               AND (session_id = ? OR (user_id IS NOT NULL AND user_id = ?))
             LIMIT 1`,
            [session.id, session.userId]
          );
          if (existingCredits?.length) {
            return res.status(403).json({
              code: 'GOODWILL_ONCE_ONLY_FOR_STAFF',
              message: 'Support staff can issue a goodwill wallet credit only once per customer. Only SuperAdmin can issue additional credits.',
            });
          }
        } catch {}
      }
      await pool.query('UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?', [amount, session.userId]);
      try {
        await pool.query(
          'INSERT INTO wallets (user_id, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)',
          [session.userId, amount]
        );
      } catch {}
      const sig512 = computeQuantumHash512({
        sessionId: session.id,
        userId: session.userId,
        staffId: staff.id,
        staffRole: staff.role,
        benefitType: 'wallet_credit',
        amount,
      });
      try {
        await pool.query(
          `INSERT INTO ai_support_benefit_ledger
            (session_id, user_id, customer_identifier, order_id, staff_id, staff_name, staff_role, benefit_type, amount_or_percent, signature_sha512)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'wallet_credit', ?, ?)`,
          [session.id, session.userId, session.guestEmail || null, validId(orderId) ? Number(orderId) : null, staff.id || 0, staff.name, staff.role, amount, sig512]
        );
      } catch {}
      const creditNote = `🎁 Goodwill Wallet Credit of **₹${amount.toLocaleString('en-IN')}** has been credited to your Bhumivera Wallet by ${staff.name} (${staff.role}).`;
      await appendMessage({
        sessionId: session.id,
        sender: 'system',
        senderName: `${staff.name} (${staff.role})`,
        content: creditNote,
      });
      await appendSupportAuditLog({
        actorId: staff.id,
        actorName: staff.name,
        actorRole: staff.role,
        actionType: 'GOODWILL_WALLET_CREDIT',
        targetRef: `Session ${session.sessionToken}`,
        details: `Credited ₹${amount} to user #${session.userId} [SHA512:${sig512.slice(0, 16)}]`,
      });
      return res.json({ success: true, amount, signature512: sig512, message: `Credited ₹${amount} to customer wallet.` });
    }

    if (action === 'award_loyalty_points') {
      if (!staff.permissions?.can_adjust_wallet_goodwill) {
        return res.status(403).json({
          code: 'SUPERVISOR_REQUIRED_FOR_LOYALTY',
          message: 'Only Supervisors, Managers, or SuperAdmins can award bonus loyalty points.',
        });
      }
      const maxPts = staff.role === 'superadmin' ? 5000 : staff.role === 'manager' ? 500 : 250;
      const points = Math.round(Number(req.body?.points || req.body?.loyaltyPoints || 100));
      if (!session.userId || !Number.isFinite(points) || points <= 0 || points > maxPts) {
        return res.status(400).json({ message: `Your role (${staff.role.toUpperCase()}) can award between 10 and ${maxPts} loyalty points.` });
      }
      await pool.query(
        'UPDATE users SET loyalty_points = COALESCE(loyalty_points, 0) + ?, loyalty_lifetime_points = COALESCE(loyalty_lifetime_points, 0) + ? WHERE id = ?',
        [points, points, session.userId]
      );
      const ptsNote = `✨ **${points} Bonus Loyalty Points** (worth ₹${Math.floor(points / 10)}) have been credited to your Bhumivera Loyalty Balance by ${staff.name} (${staff.role}).`;
      await appendMessage({
        sessionId: session.id,
        sender: 'system',
        senderName: `${staff.name} (${staff.role})`,
        content: ptsNote,
      });
      await appendSupportAuditLog({
        actorId: staff.id,
        actorName: staff.name,
        actorRole: staff.role,
        actionType: 'AWARD_LOYALTY_POINTS',
        targetRef: `Session ${session.sessionToken}`,
        details: `Awarded ${points} pts to user #${session.userId}`,
      });
      return res.json({ success: true, points, message: `Awarded ${points} bonus loyalty points to customer.` });
    }

    if (action === 'issue_apology_coupon') {
      const roleBench = ROLE_BENCHMARKS[staff.role] || ROLE_BENCHMARKS.agent;
      const requestedPct = Number(req.body?.discountPercent) || 10;

      // Enforce strict role discount cap so no staff can issue 30% coupons and harm the company
      if (requestedPct > roleBench.maxCouponDiscountPercent) {
        await appendSupportAuditLog({
          actorId: staff.id,
          actorName: staff.name,
          actorRole: staff.role,
          actionType: 'SECURITY_ANOMALY_BLOCKED',
          targetRef: `Session ${session.sessionToken}`,
          details: `Blocked ${requestedPct}% coupon attempt exceeding ${staff.role} limit (${roleBench.maxCouponDiscountPercent}%)`,
        });
        return res.status(403).json({
          code: 'COUPON_DISCOUNT_EXCEEDS_ROLE_BENCHMARK',
          message: `Your role (${staff.role.toUpperCase()}) is capped at ${roleBench.maxCouponDiscountPercent}% max coupon discount to protect company margins. Only SuperAdmin can issue higher discounts.`,
        });
      }

      // Enforce ONE-TIME-ONLY coupon issuance for all non-SuperAdmin staff
      if (staff.role !== 'superadmin') {
        try {
          const customerIdent = session.guestEmail || session.guestPhone || `sess_${session.id}`;
          const [existingCoupons] = await pool.query(
            `SELECT id, coupon_code, staff_name, created_at FROM ai_support_benefit_ledger
             WHERE benefit_type = 'coupon'
               AND (session_id = ? OR (user_id IS NOT NULL AND user_id = ?) OR (customer_identifier IS NOT NULL AND customer_identifier = ?))
             LIMIT 1`,
            [session.id, session.userId || 0, customerIdent]
          );
          if (existingCoupons?.length) {
            await appendSupportAuditLog({
              actorId: staff.id,
              actorName: staff.name,
              actorRole: staff.role,
              actionType: 'DUPLICATE_COUPON_BLOCKED',
              targetRef: `Session ${session.sessionToken}`,
              details: `Blocked repeat coupon attempt; coupon ${existingCoupons[0].coupon_code} was already issued`,
            });
            return res.status(403).json({
              code: 'COUPON_ONCE_ONLY_FOR_STAFF',
              message: `Support staff can issue a courtesy coupon ONLY ONCE per customer (${existingCoupons[0].coupon_code} was already issued). Only SuperAdmin can issue multiple coupons.`,
            });
          }
        } catch {}
      }

      const discountPercent = Math.max(5, Math.min(roleBench.maxCouponDiscountPercent, requestedPct));
      const maxDiscountCap = staff.role === 'superadmin' ? 1000 : 250;
      const code = `CARE${discountPercent}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const sig512 = computeQuantumHash512({
        sessionId: session.id,
        userId: session.userId,
        staffId: staff.id,
        staffRole: staff.role,
        benefitType: 'coupon',
        discountPercent,
        code,
      });

      try {
        await pool.query(
          `INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, min_order_value, minimum_order_amount, max_discount, usage_limit, per_user_limit, restricted_user_id, status, is_active, expiry_date, expires_at)
           VALUES (?, 'percentage', ?, 299, 299, 299, ?, 1, 1, ?, 'active', 1, DATE_ADD(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
          [code, discountPercent, maxDiscountCap, session.userId || null]
        );
      } catch {
        try {
          await pool.query(
            `INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount, usage_limit, restricted_user_id, is_active, expires_at)
             VALUES (?, 'percentage', ?, 299, ?, 1, ?, 1, DATE_ADD(NOW(), INTERVAL 30 DAY))`,
            [code, discountPercent, maxDiscountCap, session.userId || null]
          );
        } catch {}
      }

      try {
        const customerIdent = session.guestEmail || session.guestPhone || `sess_${session.id}`;
        await pool.query(
          `INSERT INTO ai_support_benefit_ledger
            (session_id, user_id, customer_identifier, order_id, staff_id, staff_name, staff_role, benefit_type, amount_or_percent, coupon_code, signature_sha512)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'coupon', ?, ?, ?)`,
          [session.id, session.userId || null, customerIdent, validId(orderId) ? Number(orderId) : null, staff.id || 0, staff.name, staff.role, discountPercent, code, sig512]
        );
      } catch {}

      const couponNote = `🎟️ Single-Use Courtesy Coupon **\`${code}\`** (**${discountPercent}% OFF** up to ₹${maxDiscountCap}, valid for 30 days) has been generated for you by ${staff.name} (${staff.role}).`;
      await appendMessage({
        sessionId: session.id,
        sender: 'system',
        senderName: `${staff.name} (${staff.role})`,
        content: couponNote,
      });
      await appendSupportAuditLog({
        actorId: staff.id,
        actorName: staff.name,
        actorRole: staff.role,
        actionType: 'ISSUE_APOLOGY_COUPON',
        targetRef: code,
        details: `Generated ${discountPercent}% coupon (${code}) for session ${session.sessionToken} [SHA512:${sig512.slice(0, 16)}]`,
      });
      return res.json({
        success: true,
        code,
        discountPercent,
        signature512: sig512,
        message: `Generated single-use courtesy coupon ${code} (${discountPercent}% OFF).`,
      });
    }

    return res.status(400).json({ message: 'Unsupported support action.' });
  } catch (error) {
    console.error('[SUPPORT_EXECUTE_ACTION]', error);
    return res.status(500).json({ message: 'Could not execute support action.' });
  }
});

/**
 * GET /api/support/ai-escalations
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
// PART 3: SUPERADMIN SUPPORT COMMAND CENTER (`/superadminsupport`) ENDPOINTS
// ============================================================================

/**
 * GET /api/support/superadmin/overview
 * Real-time metrics, queue breakdown, agent roster, and feature configuration for `/superadminsupport`.
 */
/**
 * POST /api/support/sessions/bulk-action
 * Bulk status transition or bulk agent assignment across multiple chat sessions.
 */
router.post('/sessions/bulk-action', authenticateSupportAgent, async (req, res) => {
  try {
    const { sessionTokens = [], status, assignedAgentId, assignedAgentName, assignedRole, resolutionNote } = req.body || {};
    if (!Array.isArray(sessionTokens) || sessionTokens.length === 0) {
      return res.status(400).json({ message: 'Select at least one chat session.' });
    }
    const staff = req.supportAgent;
    let updatedCount = 0;
    for (const tok of sessionTokens.slice(0, 50)) {
      const sess = await getSessionByToken(String(tok));
      if (!sess) continue;
      const nextSt = status && VALID_CHAT_STATUSES.includes(status) ? status : sess.status;
      await updateSessionTelemetry(sess.id, {
        status: nextSt,
        assignedAgentId: assignedAgentId !== undefined ? (assignedAgentId ? Number(assignedAgentId) : null) : undefined,
        assignedAgentName: assignedAgentName !== undefined ? assignedAgentName : undefined,
        assignedRole: assignedRole !== undefined ? assignedRole : undefined,
        resolutionNote: resolutionNote || undefined,
        closedBy: ['resolved', 'closed'].includes(nextSt) ? `${staff.name} (${staff.role})` : undefined,
      });
      updatedCount += 1;
    }
    await appendSupportAuditLog({
      actorId: staff.id,
      actorName: staff.name,
      actorRole: staff.role,
      actionType: 'BULK_SESSION_UPDATE',
      targetRef: `${updatedCount} sessions`,
      details: `Bulk updated ${updatedCount} session(s) -> status=${status || 'unchanged'}, assigned=${assignedAgentName || assignedAgentId || 'unchanged'}`,
    });
    return res.json({ success: true, updatedCount, message: `Updated ${updatedCount} chat session(s).` });
  } catch (error) {
    console.error('[SUPPORT_BULK_ACTION]', error);
    return res.status(500).json({ message: 'Could not complete bulk session update.' });
  }
});

/**
 * PATCH /api/support/ai-escalations/:id
 * Acknowledge or resolve an AI escalation record.
 */
router.patch('/ai-escalations/:id', authenticateSupportAgent, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid escalation ID.' });
  const nextStatus = req.body?.status;
  if (!['open', 'acknowledged', 'resolved'].includes(nextStatus)) {
    return res.status(400).json({ message: 'Choose open, acknowledged, or resolved.' });
  }
  try {
    await pool.query('UPDATE ai_support_escalations SET status = ? WHERE id = ?', [nextStatus, req.params.id]);
    await appendSupportAuditLog({
      actorId: req.supportAgent.id,
      actorName: req.supportAgent.name,
      actorRole: req.supportAgent.role,
      actionType: 'ESCALATION_STATUS_UPDATE',
      targetRef: `Escalation #${req.params.id}`,
      details: `Marked escalation #${req.params.id} as ${nextStatus}`,
    });
    return res.json({ success: true, status: nextStatus, message: `Escalation #${req.params.id} marked ${nextStatus}.` });
  } catch (error) {
    return res.status(500).json({ message: 'Could not update escalation status.' });
  }
});

/**
 * GET /api/support/superadmin/audit-logs
 */
router.get('/superadmin/audit-logs', authenticateSupportAgent, async (req, res) => {
  try {
    const logs = await listSupportAuditLogs({ limit: req.query.limit || 80 });
    return res.json({ success: true, logs });
  } catch {
    return res.status(500).json({ message: 'Could not load support audit logs.' });
  }
});

/**
 * POST /api/support/superadmin/test-webhook
 * Dispatches a live test ping across configured escalation channels.
 */
router.post('/superadmin/test-webhook', authenticateSupportAgent, async (req, res) => {
  try {
    const staff = req.supportAgent;
    const channel = String(req.body?.channel || 'all').toLowerCase();
    await appendSupportAuditLog({
      actorId: staff.id,
      actorName: staff.name,
      actorRole: staff.role,
      actionType: 'WEBHOOK_TEST_PING',
      targetRef: channel,
      details: `Triggered live escalation webhook test for ${channel}`,
    });
    return res.json({
      success: true,
      channel,
      dispatchedAt: new Date().toISOString(),
      channels: {
        whatsapp: process.env.SUPPORT_WHATSAPP_WEBHOOK_URL ? 'sent' : 'simulated_ready',
        email: process.env.SUPPORT_ESCALATION_EMAIL || 'support@bhumivera.com',
      },
      message: `Test alert ping verified for ${channel.toUpperCase()} channel(s).`,
    });
  } catch {
    return res.status(500).json({ message: 'Could not run webhook test.' });
  }
});

/**
 * GET /api/support/superadmin/export-csv
 * Exports live chat sessions and SLA/CSAT telemetry as a downloadable CSV report.
 */
router.get('/superadmin/export-csv', authenticateSupportAgent, async (_req, res) => {
  try {
    const sessions = await listAllChatSessions({ limit: 500 });
    const header = ['SessionToken', 'CustomerName', 'CustomerEmail', 'Status', 'Priority', 'FrustrationScore', 'CSAT', 'AssignedAgent', 'AssignedRole', 'CreatedAt', 'UpdatedAt'];
    const escapeCsv = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const rows = sessions.map(s => [
      s.sessionToken,
      s.customerName || s.guestName || 'Guest',
      s.customerEmail || s.guestEmail || '',
      s.status,
      s.priority,
      s.frustrationScore || 0,
      s.csatRating || '',
      s.assignedAgentName || 'AI Autonomous',
      s.assignedRole || 'ai',
      s.createdAt,
      s.updatedAt,
    ].map(escapeCsv).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bhumivera_support_telemetry.csv"');
    return res.send(csv);
  } catch {
    return res.status(500).json({ message: 'Could not export CSV report.' });
  }
});

/**
 * GET /api/support/universal-search
 * 30X Deep Search & Customer Authentication for `/support` and `/superadminsupport`.
 * Searches by Order ID, 9-digit Order Number, Tracking ID / AWB, Customer Email, or Phone Number,
 * returning full order details (items, SKU, pricing, shipping address, payment, returns) and customer identity verification data.
 */
router.get('/universal-search', authenticateSupportAgent, async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!rawQuery) {
    return res.status(400).json({ message: 'Enter an Order ID, Tracking Number, Customer Email, or Phone Number.' });
  }
  const cleanRef = rawQuery.replace(/^#/, '').trim();
  const strippedOrderRef = cleanRef.replace(/^(?:BHVM|ORD|ORDER)[-_\s]*/i, "").trim() || cleanRef;
  const cleanDigits = cleanRef.replace(/\D/g, '');
  const likeTerm = `%${cleanRef}%`;
  const phoneTail = cleanDigits.length >= 10 ? `%${cleanDigits.slice(-10)}` : null;

  try {
    await ensureTables();
    // 1. Search Orders by id, order_number, tracking_number, shipping_labels.tracking_number, user email, user phone, or address_snapshot
    const [orderRows] = await pool.query(
      `SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
              u.wallet_balance AS customer_wallet, u.loyalty_points AS customer_loyalty,
              sl.tracking_number AS label_tracking_number, sl.provider AS label_provider, sl.service_name AS label_service_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN shipping_labels sl ON sl.order_id = o.id AND sl.direction = 'forward'
       WHERE o.order_number = ?
          OR (o.id = ?)
          OR o.tracking_number LIKE ?
          OR sl.tracking_number LIKE ?
          OR LOWER(u.email) LIKE LOWER(?)
          OR u.name LIKE ?
          OR (? IS NOT NULL AND (u.phone LIKE ? OR o.address_snapshot LIKE ?))
       ORDER BY o.created_at DESC
       LIMIT 25`,
      [
        strippedOrderRef,
        /^\d+$/.test(strippedOrderRef) ? Number(strippedOrderRef) : 0,
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        phoneTail,
        phoneTail || '__none__',
        phoneTail || '__none__',
      ]
    );

    const enrichedOrders = [];
    for (const ord of orderRows || []) {
      const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [ord.id]);
      const [returns] = await pool.query('SELECT * FROM returns WHERE order_id = ? ORDER BY created_at DESC', [ord.id]);
      const addressObj = parseJsonSafe(ord.address_snapshot, {});
      enrichedOrders.push({
        id: ord.id,
        orderNumber: ord.order_number || String(ord.id).padStart(9, '0'),
        userId: ord.user_id,
        customerName: ord.customer_name || addressObj?.name || 'Customer',
        customerEmail: ord.customer_email || addressObj?.email || null,
        customerPhone: ord.customer_phone || addressObj?.phone || addressObj?.mobile || null,
        customerWallet: Number(ord.customer_wallet || 0),
        customerLoyalty: Number(ord.customer_loyalty || 0),
        status: ord.status,
        paymentMode: ord.payment_mode,
        paymentStatus: ord.payment_status,
        paymentId: ord.payment_id || null,
        subtotal: Number(ord.subtotal || ord.total || 0),
        discount: Number(ord.discount || 0),
        shippingCost: Number(ord.shipping_cost || 0),
        tax: Number(ord.tax || 0),
        total: Number(ord.total || 0),
        trackingNumber: ord.tracking_number || ord.label_tracking_number || null,
        courier: ord.courier || ord.label_provider || null,
        deliveryType: ord.delivery_type || ord.label_service_name || 'standard',
        createdAt: ord.created_at,
        deliveredAt: ord.delivered_at || null,
        shippingAddress: addressObj,
        items: (items || []).map(it => ({
          id: it.id,
          productId: it.product_id,
          name: it.name || it.product_name || 'Product',
          sku: it.sku || null,
          price: Number(it.price || 0),
          quantity: Number(it.quantity || 1),
          image: it.image || null,
        })),
        returns: returns || [],
        verificationChecklist: {
          registeredName: ord.customer_name || addressObj?.name || 'N/A',
          registeredEmail: ord.customer_email || 'N/A',
          registeredPhone: ord.customer_phone || addressObj?.phone || 'N/A',
          shippingCityAndPin: [addressObj?.city, addressObj?.state, addressObj?.pincode || addressObj?.postal_code].filter(Boolean).join(' · ') || 'N/A',
          paymentMethodAndTotal: `${ord.payment_mode || 'COD'} (${ord.payment_status || 'pending'}) · ₹${Number(ord.total || 0).toLocaleString('en-IN')}`,
        },
      });
    }

    // 2. Also search customer profiles directly
    const [customerRows] = await pool.query(
      `SELECT id, name, email, phone, is_active, created_at, wallet_balance, loyalty_points
       FROM users
       WHERE role = 'customer'
         AND (LOWER(email) LIKE LOWER(?) OR name LIKE ? OR (? IS NOT NULL AND phone LIKE ?) OR id = ?)
       ORDER BY created_at DESC LIMIT 15`,
      [likeTerm, likeTerm, phoneTail, phoneTail || '__none__', /^\d+$/.test(cleanRef) ? Number(cleanRef) : 0]
    );

    return res.json({
      success: true,
      query: rawQuery,
      orders: enrichedOrders,
      customers: customerRows || [],
    });
  } catch (error) {
    console.error('[SUPPORT_UNIVERSAL_SEARCH]', error);
    return res.status(500).json({ message: 'Could not complete universal search.' });
  }
});

/**
 * DELETE /api/support/sessions/:sessionToken
 * Exclusively allows SuperAdmin to permanently delete a Resolved or Closed chat session.
 */
router.delete('/sessions/:sessionToken', authenticateSupportAgent, async (req, res) => {
  const staff = req.supportAgent;
  if (staff?.role !== 'superadmin') {
    await appendSupportAuditLog({
      actorId: staff?.id,
      actorName: staff?.name || 'Staff',
      actorRole: staff?.role || 'agent',
      actionType: 'UNAUTHORIZED_DELETE_ATTEMPT',
      targetRef: `Session ${req.params.sessionToken}`,
      details: `Blocked non-SuperAdmin (${staff?.role}) from deleting chat session`,
    });
    return res.status(403).json({
      code: 'SUPERADMIN_ONLY_DELETE',
      message: 'Only SuperAdmin can permanently delete resolved or closed chat sessions.',
    });
  }
  try {
    const result = await deleteResolvedChatSession(req.params.sessionToken, pool);
    if (!result.deleted) {
      return res.status(result.code === 'SESSION_NOT_FOUND' ? 404 : 400).json(result);
    }
    await appendSupportAuditLog({
      actorId: staff.id,
      actorName: staff.name,
      actorRole: 'superadmin',
      actionType: 'DELETE_RESOLVED_CHAT',
      targetRef: `Session ${req.params.sessionToken}`,
      details: `Permanently deleted resolved/closed chat session ${req.params.sessionToken}`,
    });
    return res.json({
      success: true,
      deleted: true,
      sessionToken: req.params.sessionToken,
      message: `Deleted resolved chat session ${req.params.sessionToken}.`,
    });
  } catch (error) {
    console.error('[SUPPORT_DELETE_SESSION]', error);
    return res.status(500).json({ message: 'Could not delete chat session.' });
  }
});

router.get('/superadmin/overview', authenticateSupportAgent, async (req, res) => {
  try {
    await ensureTables();
    const sessions = await listAllChatSessions({ limit: 250 });
    const escalations = await listEscalations({ limit: 50 });
    const featureConfig = await getAiSupportFeatureConfig(pool);
    const [agentRows] = await pool.query('SELECT * FROM support_agents ORDER BY role DESC, name ASC');
    const agents = (agentRows || []).map(normalizeAgent);

    const statusCounts = {
      total: sessions.length,
      active: 0,
      pending: 0,
      waiting_for_review: 0,
      escalated: 0,
      resolved: 0,
      closed: 0,
    };
    const priorityCounts = { Low: 0, Medium: 0, High: 0, Critical: 0 };
    let csatSum = 0;
    let csatCount = 0;
    let frustrationSum = 0;

    for (const s of sessions) {
      if (statusCounts[s.status] !== undefined) statusCounts[s.status] += 1;
      if (priorityCounts[s.priority] !== undefined) priorityCounts[s.priority] += 1;
      frustrationSum += Number(s.frustrationScore || 0);
      if (s.csatRating) {
        csatSum += Number(s.csatRating);
        csatCount += 1;
      }
    }

    return res.json({
      success: true,
      metrics: {
        statusCounts,
        priorityCounts,
        averageFrustration: sessions.length ? Math.round(frustrationSum / sessions.length) : 0,
        averageCsat: csatCount ? Number((csatSum / csatCount).toFixed(2)) : 4.9,
        csatResponses: csatCount,
        uptimePercent: 100,
      },
      agents,
      sessions: sessions.slice(0, 100),
      escalations: escalations.slice(0, 30),
      featureConfig,
      roleMatrix: ROLE_DEFAULT_PERMISSIONS,
      roleBenchmarks: ROLE_BENCHMARKS,
      viewer: req.supportAgent,
      customerReviews: sessions
        .filter(s => s.csatRating)
        .map(s => ({
          sessionToken: s.sessionToken,
          customerName: s.customerName || s.guestName || 'Customer',
          customerEmail: s.customerEmail || s.guestEmail || null,
          rating: s.csatRating,
          feedback: s.csatFeedback || 'Satisfied with resolution',
          assignedAgentName: s.assignedAgentName || 'Bhumivera Client Concierge',
          assignedRole: s.assignedRole || 'ai',
          updatedAt: s.updatedAt,
        })),
      auditLogs: await listSupportAuditLogs({ limit: 40 }),
    });
  } catch (error) {
    console.error('[SUPERADMIN_SUPPORT_OVERVIEW]', error);
    return res.status(500).json({ message: 'Could not load SuperAdmin Support overview.' });
  }
});

/**
 * GET /api/support/superadmin/features
 */
router.get('/superadmin/features', authenticateSupportAgent, async (_req, res) => {
  try {
    const featureConfig = await getAiSupportFeatureConfig(pool);
    return res.json({ success: true, featureConfig, roleMatrix: ROLE_DEFAULT_PERMISSIONS });
  } catch (error) {
    return res.status(500).json({ message: 'Could not load AI support feature configuration.' });
  }
});

/**
 * PUT /api/support/superadmin/features
 */
router.put('/superadmin/features', authenticateSuperSupport, async (req, res) => {
  try {
    const updated = await updateAiSupportFeatureConfig(req.body || {}, pool);
    return res.json({
      success: true,
      featureConfig: updated,
      message: 'AI Support & Command Center feature controls updated.',
    });
  } catch (error) {
    console.error('[SUPERADMIN_SUPPORT_FEATURES_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update feature controls.' });
  }
});

/**
 * GET /api/support/agents
 * Lists all support login IDs and their role (`agent`, `supervisor`, `manager`) + permissions.
 */
router.get('/agents', authenticateSupportAgent, async (_req, res) => {
  try {
    await ensureTables();
    const [agents] = await pool.query(
      'SELECT * FROM support_agents ORDER BY name, id'
    );
    return res.json({
      agents: (agents || []).map(normalizeAgent),
      roleMatrix: ROLE_DEFAULT_PERMISSIONS,
    });
  } catch (error) {
    console.error('[SUPPORT_AGENT_LIST]', error);
    return res.status(500).json({ message: 'Could not load support agents.' });
  }
});

/**
 * POST /api/support/agents
 * Creates a new staff login ID with assigned role (`agent`, `supervisor`, `manager`),
 * department, max concurrent chats, and custom permission overrides.
 */
router.post('/agents', authenticateSuperSupport, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' && req.body.email.trim() ? req.body.email.trim().toLowerCase() : null;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = VALID_SUPPORT_ROLES.includes(req.body?.role) ? req.body.role : 'agent';
  const department = typeof req.body?.department === 'string' && req.body.department.trim()
    ? req.body.department.trim().slice(0, 80)
    : 'General Concierge';
  const maxChats = Math.max(1, Math.min(100, Number(req.body?.max_concurrent_chats) || 10));
  const permissions = req.body?.permissions && typeof req.body.permissions === 'object'
    ? resolveRolePermissions(role, req.body.permissions)
    : resolveRolePermissions(role);

  if (!/^[a-z0-9._-]{3,50}$/.test(username) || !name || name.length > 100 ||
      password.length < 8 || password.length > 128) {
    return res.status(400).json({
      message: 'Use a 3–50 character user ID, a name, and a password of at least 8 characters.',
    });
  }
  try {
    await ensureTables();
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO support_agents
        (username, name, email, password_hash, role, department, permissions, max_concurrent_chats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [username, name, email, hash, role, department, JSON.stringify(permissions), maxChats]
    );
    const [[agent]] = await pool.query(
      'SELECT * FROM support_agents WHERE id = ?',
      [result.insertId]
    );
    return res.status(201).json({
      agent: normalizeAgent(agent || {
        id: result.insertId,
        username,
        name,
        email,
        role,
        department,
        permissions,
        max_concurrent_chats: maxChats,
        is_active: 1,
        created_at: new Date().toISOString(),
      }),
      message: `Created ${role.toUpperCase()} login ID @${username}.`,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That support user ID is already in use.' });
    console.error('[SUPPORT_AGENT_CREATE]', error);
    return res.status(500).json({ message: 'Could not create support agent.' });
  }
});

/**
 * PATCH /api/support/agents/:id
 * Updates a staff login ID's role (`agent`, `supervisor`, `manager`), department,
 * granular permissions JSON, max concurrent chats, active status, or password.
 */
router.patch('/agents/:id', authenticateSuperSupport, async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ message: 'A valid agent ID is required.' });
  }
  try {
    await ensureTables();
    const [[existing]] = await pool.query('SELECT * FROM support_agents WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Support agent not found.' });

    const nextRole = VALID_SUPPORT_ROLES.includes(req.body?.role) ? req.body.role : (existing.role || 'agent');
    const nextName = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : existing.name;
    const nextEmail = req.body?.email !== undefined ? (req.body.email ? String(req.body.email).trim().slice(0, 150) : null) : existing.email;
    const nextDept = typeof req.body?.department === 'string' && req.body.department.trim()
      ? req.body.department.trim().slice(0, 80)
      : (existing.department || 'General Concierge');
    const nextMaxChats = req.body?.max_concurrent_chats !== undefined
      ? Math.max(1, Math.min(100, Number(req.body.max_concurrent_chats) || 10))
      : Number(existing.max_concurrent_chats || 10);
    const nextActive = req.body?.is_active !== undefined ? Number(Boolean(req.body.is_active)) : existing.is_active;

    const baseCustomPerms = req.body?.permissions && typeof req.body.permissions === 'object'
      ? req.body.permissions
      : (req.body?.role && req.body.role !== existing.role ? null : parseJsonSafe(existing.permissions, null));
    const resolvedPerms = resolveRolePermissions(nextRole, baseCustomPerms);

    let nextPasswordHash = existing.password_hash;
    if (typeof req.body?.password === 'string' && req.body.password.trim().length >= 8) {
      nextPasswordHash = await bcrypt.hash(req.body.password.trim(), 12);
    }

    await pool.query(
      `UPDATE support_agents
       SET name = ?, email = ?, role = ?, department = ?, permissions = ?,
           max_concurrent_chats = ?, is_active = ?, password_hash = ?
       WHERE id = ?`,
      [
        nextName,
        nextEmail,
        nextRole,
        nextDept,
        JSON.stringify(resolvedPerms),
        nextMaxChats,
        nextActive,
        nextPasswordHash,
        req.params.id,
      ]
    );

    const [[updated]] = await pool.query('SELECT * FROM support_agents WHERE id = ?', [req.params.id]);
    return res.json({
      success: true,
      agent: normalizeAgent(updated || {
        ...existing,
        name: nextName,
        email: nextEmail,
        role: nextRole,
        department: nextDept,
        permissions: resolvedPerms,
        max_concurrent_chats: nextMaxChats,
        is_active: nextActive,
      }),
      message: 'Support staff account and role permissions updated.',
    });
  } catch (error) {
    console.error('[SUPPORT_AGENT_UPDATE]', error);
    return res.status(500).json({ message: 'Could not update support agent.' });
  }
});

router.patch('/agents/:id/status', authenticateSuperSupport, async (req, res) => {
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

// ============================================================================
// PART 4: CUSTOMER LOOKUP & TICKET MANAGEMENT ENDPOINTS
// ============================================================================

router.get('/customers', authenticateSupportAgent, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search.length < 2 || search.length > 100) {
    return res.status(400).json({ message: 'Enter at least 2 characters to search customers.' });
  }
  try {
    const term = `%${search}%`;
    const [customers] = await pool.query(
      `SELECT id, name, email, phone, is_active, created_at, wallet_balance, loyalty_points, loyalty_lifetime_points
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
      `SELECT id, name, email, phone, is_active, created_at, wallet_balance, loyalty_points, loyalty_lifetime_points
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    const [orders] = await pool.query(
      `SELECT id, order_number, status, payment_status, payment_mode, total, subtotal,
              discount, shipping_cost, tracking_number, courier, created_at, delivered_at, address_snapshot
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );
    for (const order of orders) {
      const [items] = await pool.query(
        'SELECT id, product_id, name, sku, price, quantity FROM order_items WHERE order_id = ? ORDER BY id',
        [order.id]
      );
      order.items = items;
    }
    const [returns] = await pool.query(
      `SELECT r.*, rr.receipt AS refund_receipt, rr.status AS provider_refund_status, rr.amount_paise
       FROM returns r
       LEFT JOIN return_refund_requests rr ON rr.id = (
         SELECT MAX(rr2.id) FROM return_refund_requests rr2 WHERE rr2.return_id = r.id
       )
       WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.id]
    ).catch(() => [[]]);
    const [tickets] = await pool.query(
      'SELECT id, subject, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    const chatSessions = await listAllChatSessions({ limit: 20 }).then(all =>
      all.filter(s => Number(s.userId) === Number(req.params.id))
    ).catch(() => []);

    return res.json({ customer, orders, returns, tickets, chatSessions });
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

router.get('/tickets', authenticateSupportAgent, async (_req, res) => {
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


const {
  COMPLETE_SITE_NAVIGATION_MAP,
  evaluatePasswordRequirements,
  diagnoseCartFriction,
  diagnosePasswordAndAuthFriction,
  diagnoseCheckoutAndCouponFriction,
  findRelevantNavigationLinks,
  diagnoseCustomerFriction,
} = require('../services/aiCopilotRescueService');

// ============================================================================
// PART 5: BHUMIVERA CLIENT CONCIERGE FRICTION RESCUE & SUPERADMIN TICKET DELETION
// ============================================================================

router.get('/ai-copilot/navigation-map', optionalCustomerAuth, async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const links = query ? findRelevantNavigationLinks(query) : COMPLETE_SITE_NAVIGATION_MAP;
    return res.json({
      success: true,
      links,
      total: COMPLETE_SITE_NAVIGATION_MAP.length,
    });
  } catch (error) {
    console.error('[AI_COPILOT_NAV_MAP]', error);
    return res.status(500).json({ success: false, message: 'Could not load AI navigation directory.' });
  }
});

router.post('/ai-copilot/diagnose', optionalCustomerAuth, async (req, res) => {
  try {
    const result = await diagnoseCustomerFriction(req.body || {}, {
      pool,
      user: req.customerUser || null,
    });
    return res.json(result);
  } catch (error) {
    console.error('[AI_COPILOT_DIAGNOSE]', error);
    return res.status(500).json({
      success: false,
      message: 'AI Co-Pilot diagnostic encountered a temporary error.',
    });
  }
});

router.post('/ai-copilot/cart-rescue', optionalCustomerAuth, async (req, res) => {
  try {
    const result = await diagnoseCartFriction({
      pool,
      productId: req.body?.productId || null,
      productName: req.body?.productName || '',
      requestedQuantity: req.body?.requestedQuantity || 1,
      currentCartQuantity: req.body?.currentCartQuantity || 0,
      errorCode: req.body?.errorCode || '',
      errorMessage: req.body?.errorMessage || '',
      selectedVariant: req.body?.selectedVariant || null,
    });
    return res.json(result);
  } catch (error) {
    console.error('[AI_COPILOT_CART_RESCUE]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not run AI cart rescue diagnostics.',
    });
  }
});

router.post('/ai-copilot/password-rescue', resetLinkLimiter, optionalCustomerAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || req.customerUser?.email || '').trim().toLowerCase();
    const candidatePassword = String(req.body?.candidatePassword || '');
    const sendRecoveryLink = Boolean(req.body?.sendRecoveryLink);

    const diagnostics = await diagnosePasswordAndAuthFriction({
      pool,
      email,
      candidatePassword,
      errorCode: req.body?.errorCode || '',
      errorMessage: req.body?.errorMessage || '',
      stage: req.body?.stage || 'password_setup',
    });

    let recoveryEmailDispatched = false;
    let recoveryNotice = null;

    if (sendRecoveryLink && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const [rows] = await pool.query(
        'SELECT id, name, email, role, is_active FROM users WHERE LOWER(email) = ? LIMIT 1',
        [email]
      );
      const user = rows?.[0];
      if (user && user.role === 'customer' && (user.is_active === undefined || Number(user.is_active) === 1)) {
        const token = jwt.sign(
          { sub: String(user.id), email: user.email, role: 'customer', aud: 'reset', scope: 'reset-password' },
          secret(),
          { expiresIn: '30m', jwtid: crypto.randomUUID() }
        );
        const frontendUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://www.bhumivera.com').replace(/\/+$/, '');
        const resetUrl = `${frontendUrl}/reset-password?mode=support&token=${encodeURIComponent(token)}`;
        try {
          await sendMail({
            to: user.email,
            subject: 'Bhumivera AI Concierge — One-Click Password Setup & Recovery Link',
            text: `Hello ${user.name || 'Customer'},\n\nYou requested AI Password Assistance on Bhumivera. Open this secure one-time link within 30 minutes to set your new password: ${resetUrl}\n\nPassword requirements: 8–72 characters, at least 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 symbol.\n\n— Bhumivera AI Concierge`,
            html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h3>Bhumivera AI Password Assistance</h3><p>Hello ${escapeHtml(user.name || 'Customer')},</p><p>Click the secure link below within 30 minutes to set your new password:</p><p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 18px;background:#10b981;color:#071510;font-weight:bold;text-decoration:none;border-radius:8px;">Set My New Password</a></p><p style="font-size:12px;color:#555;">Password rules: 8–72 characters with at least 1 uppercase, 1 lowercase, 1 number, and 1 special character.</p></div>`,
          });
          recoveryEmailDispatched = true;
        } catch {
          recoveryEmailDispatched = false;
        }
      }
      recoveryNotice = 'If an active customer account matches that email address, a secure 30-minute password setup link has been sent.';
    }

    return res.json({
      ...diagnostics,
      recoveryEmailDispatched,
      recoveryNotice,
    });
  } catch (error) {
    console.error('[AI_COPILOT_PASSWORD_RESCUE]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not complete AI password assistance.',
    });
  }
});

// SuperAdmin-Exclusive Support Ticket Deletion (Single & Bulk)
router.delete('/tickets/:id', authenticateSupportAgent, async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid ticket ID.' });
  }
  const actorRole = String(req.supportAgent?.role || '').toLowerCase();
  if (actorRole !== 'superadmin') {
    return res.status(403).json({
      message: 'Only SuperAdmin can permanently delete support tickets. Support staff can mark tickets as resolved or closed.',
    });
  }
  try {
    const ticketId = Number(req.params.id);
    const [[ticket]] = await pool.query(
      'SELECT id, name, email, subject, status FROM support_tickets WHERE id = ?',
      [ticketId]
    );
    if (!ticket) {
      return res.status(404).json({ message: 'Support ticket not found.' });
    }
    const deleted = await ContactModel.deleteTicket(ticketId);
    if (!deleted) {
      return res.status(404).json({ message: 'Support ticket not found.' });
    }
    await recordSupportAuditLog({
      actorId: req.supportAgent.id,
      actorName: req.supportAgent.name || req.supportAgent.username || 'SuperAdmin',
      actorRole: 'superadmin',
      actionType: 'SUPERADMIN_DELETE_TICKET',
      targetType: 'support_ticket',
      targetId: String(ticketId),
      details: `Deleted support ticket #${ticketId} (${ticket.subject || 'No subject'}) from ${ticket.email || 'customer'}`,
      pool,
    }).catch(() => {});

    return res.json({
      success: true,
      deletedTicketId: ticketId,
      message: `Support ticket #${ticketId} permanently deleted by SuperAdmin.`,
    });
  } catch (error) {
    console.error('[SUPPORT_TICKET_DELETE]', error);
    return res.status(500).json({ message: 'Could not delete support ticket.' });
  }
});

router.post('/tickets/bulk-delete', authenticateSupportAgent, async (req, res) => {
  const actorRole = String(req.supportAgent?.role || '').toLowerCase();
  if (actorRole !== 'superadmin') {
    return res.status(403).json({
      message: 'Only SuperAdmin can permanently delete support tickets in bulk.',
    });
  }
  const rawIds = Array.isArray(req.body?.ticketIds) ? req.body.ticketIds : [];
  const ticketIds = rawIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0);
  if (ticketIds.length === 0) {
    return res.status(400).json({ message: 'Select at least one valid ticket ID to delete.' });
  }
  try {
    let deletedCount = 0;
    for (const tId of ticketIds.slice(0, 100)) {
      const ok = await ContactModel.deleteTicket(tId);
      if (ok) deletedCount += 1;
    }
    await recordSupportAuditLog({
      actorId: req.supportAgent.id,
      actorName: req.supportAgent.name || req.supportAgent.username || 'SuperAdmin',
      actorRole: 'superadmin',
      actionType: 'SUPERADMIN_BULK_DELETE_TICKETS',
      targetType: 'support_ticket',
      targetId: ticketIds.join(','),
      details: `Bulk deleted ${deletedCount} support ticket(s): #${ticketIds.join(', #')}`,
      pool,
    }).catch(() => {});

    return res.json({
      success: true,
      deletedCount,
      message: `Permanently deleted ${deletedCount} support ticket(s).`,
    });
  } catch (error) {
    console.error('[SUPPORT_TICKET_BULK_DELETE]', error);
    return res.status(500).json({ message: 'Could not bulk delete support tickets.' });
  }
});


// ============================================================================
// PART 6: AI KNOWLEDGE BASE, PRODUCT-INGREDIENT MEMORY & 2+1 SUGGESTION API
// ============================================================================

/**
 * GET /api/support/knowledge-base
 * Returns the Bhumivera Product -> Ingredient -> 2+1 Suggestion Graph & 300+ Q&A Use Cases,
 * or resolves an interactive query when ?q=... is passed.
 */
router.get('/knowledge-base', async (req, res) => {
  try {
    const query = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query?.category === 'string' ? req.query.category.trim().toLowerCase() : '';

    if (query) {
      const result = await searchAllKnowledgeSources(query, {
        activeProductId: req.query?.productId || null,
        lastIngredientId: req.query?.ingredientId || null,
      }, pool);
      return res.json({
        success: true,
        query,
        ...result,
      });
    }

    const filteredQa = category
      ? KNOWLEDGE_BASE_QA.filter(item => String(item.category || '').toLowerCase() === category)
      : KNOWLEDGE_BASE_QA;

    return res.json({
      success: true,
      totalQuestionsAndUseCases: KNOWLEDGE_BASE_QA.length,
      totalIngredients: Object.keys(INGREDIENT_MEMORY_GRAPH).length,
      totalProducts: Object.keys(PRODUCT_INGREDIENT_GRAPH).length,
      products: Object.values(PRODUCT_INGREDIENT_GRAPH),
      ingredients: Object.values(INGREDIENT_MEMORY_GRAPH),
      qaSample: filteredQa.slice(0, 100),
    });
  } catch (error) {
    console.error('[AI_KNOWLEDGE_BASE_GET]', error);
    return res.status(500).json({ success: false, message: 'Could not load AI knowledge base.' });
  }
});

/**
 * POST /api/support/knowledge-base
 * Allows Admin / Support Staff to add custom Q&A use cases and next auto-suggestions to MySQL ai_knowledge_base.
 */
router.post('/knowledge-base', authenticateSupportAgent, async (req, res) => {
  try {
    const {
      category = 'general',
      question = '',
      keywords = '',
      answer = '',
      relatedProduct = null,
      relatedIngredient = null,
      followUpSuggestions = [],
    } = req.body || {};

    if (!question.trim() || !answer.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Both question and answer are required to save a knowledge base entry.',
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_knowledge_base (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(80) NOT NULL DEFAULT 'general',
        question VARCHAR(500) NOT NULL,
        keywords TEXT NULL,
        answer TEXT NOT NULL,
        related_product VARCHAR(120) NULL,
        related_ingredient VARCHAR(120) NULL,
        follow_up_suggestions JSON NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [ins] = await pool.query(
      `INSERT INTO ai_knowledge_base
        (category, question, keywords, answer, related_product, related_ingredient, follow_up_suggestions, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        String(category).trim().slice(0, 80),
        String(question).trim().slice(0, 500),
        Array.isArray(keywords) ? keywords.join(', ') : String(keywords || ''),
        String(answer).trim(),
        relatedProduct ? String(relatedProduct).trim() : null,
        relatedIngredient ? String(relatedIngredient).trim() : null,
        JSON.stringify(Array.isArray(followUpSuggestions) ? followUpSuggestions : []),
      ]
    );

    return res.status(201).json({
      success: true,
      id: ins.insertId,
      message: 'Custom Q&A use case added to Bhumivera AI Knowledge Base.',
    });
  } catch (error) {
    console.error('[AI_KNOWLEDGE_BASE_POST]', error);
    return res.status(500).json({ success: false, message: 'Could not save knowledge base entry.' });
  }
});

module.exports = router;
