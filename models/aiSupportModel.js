'use strict';

const crypto = require('crypto');
const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');

let defaultPool = null;
function getPool(customPool) {
  if (customPool) return customPool;
  if (!defaultPool) {
    defaultPool = require('../config/db');
  }
  return defaultPool;
}

const VALID_CHAT_STATUSES = Object.freeze([
  'active',
  'pending',
  'waiting_for_review',
  'escalated',
  'resolved',
  'closed',
]);

const VALID_SUPPORT_ROLES = Object.freeze(['agent', 'supervisor', 'manager']);

const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  agent: Object.freeze({
    can_view_chats: true,
    can_reply_chats: true,
    can_close_chats: true,
    can_mark_pending_review: true,
    can_escalate: true,
    can_view_customers: true,
    can_send_reset_link: true,
    can_initiate_returns: true,
    can_cancel_orders: false,
    can_issue_refund_links: false,
    can_adjust_wallet_goodwill: false,
    can_reassign_chats: false,
    can_barge_in_chats: false,
    can_approve_waiting_review: false,
    can_manage_agents: false,
    can_manage_ai_features: false,
    can_view_analytics: false,
  }),
  supervisor: Object.freeze({
    can_view_chats: true,
    can_reply_chats: true,
    can_close_chats: true,
    can_mark_pending_review: true,
    can_escalate: true,
    can_view_customers: true,
    can_send_reset_link: true,
    can_initiate_returns: true,
    can_cancel_orders: true,
    can_issue_refund_links: true,
    can_adjust_wallet_goodwill: true,
    can_reassign_chats: true,
    can_barge_in_chats: true,
    can_approve_waiting_review: true,
    can_manage_agents: false,
    can_manage_ai_features: false,
    can_view_analytics: true,
  }),
  manager: Object.freeze({
    can_view_chats: true,
    can_reply_chats: true,
    can_close_chats: true,
    can_mark_pending_review: true,
    can_escalate: true,
    can_view_customers: true,
    can_send_reset_link: true,
    can_initiate_returns: true,
    can_cancel_orders: true,
    can_issue_refund_links: true,
    can_adjust_wallet_goodwill: true,
    can_reassign_chats: true,
    can_barge_in_chats: true,
    can_approve_waiting_review: true,
    can_manage_agents: true,
    can_manage_ai_features: true,
    can_view_analytics: true,
  }),
  superadmin: Object.freeze({
    can_view_chats: true,
    can_reply_chats: true,
    can_close_chats: true,
    can_mark_pending_review: true,
    can_escalate: true,
    can_view_customers: true,
    can_send_reset_link: true,
    can_initiate_returns: true,
    can_cancel_orders: true,
    can_issue_refund_links: true,
    can_adjust_wallet_goodwill: true,
    can_reassign_chats: true,
    can_barge_in_chats: true,
    can_approve_waiting_review: true,
    can_manage_agents: true,
    can_manage_ai_features: true,
    can_view_analytics: true,
  }),
});

const DEFAULT_AI_SUPPORT_FEATURES = Object.freeze({
  ai_support_enabled: true,
  ai_auto_cancel_enabled: true,
  ai_auto_return_rma_enabled: true,
  ai_auto_wallet_goodwill_enabled: true,
  ai_proactive_triggers_enabled: true,
  ai_proactive_linger_seconds: 45,
  ai_rage_click_detection_enabled: true,
  support_frustration_threshold: 70,
  support_sla_critical_minutes: 15,
  support_sla_high_minutes: 30,
  support_sla_medium_minutes: 120,
  telegram_alerts_enabled: true,
  whatsapp_alerts_enabled: true,
  email_alerts_enabled: true,
  allow_customer_status_change: true,
  require_supervisor_for_paid_cancel: true,
});

const DEFAULT_CANNED_MACROS = Object.freeze([
  {
    id: 'macro_greeting',
    title: 'Warm Botanical Concierge Greeting',
    category: 'General',
    shortcut: '/greet',
    content: 'Namaste! Thank you for contacting Bhumivera Senior Concierge. I have reviewed your account and I am personally assisting you right now.',
  },
  {
    id: 'macro_expedite_dispatch',
    title: 'Priority Warehouse Dispatch Note',
    category: 'Shipping',
    shortcut: '/expedite',
    content: 'I have flagged your order with our fulfillment desk for priority dispatch and quality seal verification. You will receive your live tracking number via email and SMS shortly.',
  },
  {
    id: 'macro_rma_approved',
    title: 'Instant RMA & Reverse Pickup Confirmation',
    category: 'Returns',
    shortcut: '/rma',
    content: 'Your return/replacement RMA has been approved for priority reverse pickup within 24–48 hours. Please keep the product in its original packaging with batch labels intact.',
  },
  {
    id: 'macro_refund_status',
    title: 'Razorpay Refund Settlement Assurance',
    category: 'Refunds',
    shortcut: '/refund',
    content: 'Your refund has been initiated via Razorpay to your original payment source. Standard bank settlement completes within 3–5 business days.',
  },
  {
    id: 'macro_waiting_review',
    title: 'Placed in Supervisor Review Queue',
    category: 'Escalation',
    shortcut: '/review',
    content: 'I have marked this conversation as Waiting for Supervisor Review so our Senior Quality & Refunds Lead can authorize the best resolution for you.',
  },
]);

function resolveRolePermissions(role = 'agent', customPermissions = null) {
  const normalizedRole = ['superadmin', 'admin'].includes(role)
    ? 'superadmin'
    : (VALID_SUPPORT_ROLES.includes(role) ? role : 'agent');
  const base = { ...(ROLE_DEFAULT_PERMISSIONS[normalizedRole] || ROLE_DEFAULT_PERMISSIONS.agent) };
  if (customPermissions && typeof customPermissions === 'object') {
    for (const [k, v] of Object.entries(customPermissions)) {
      if (Object.prototype.hasOwnProperty.call(base, k) && typeof v === 'boolean') {
        base[k] = v;
      }
    }
  }
  return base;
}

let tablesInitializedPromise = null;

async function addColIfMissing(pool, table, column, definition) {
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    if (!cols || cols.length === 0) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  } catch {
    // Ignore on mock pools that do not implement SHOW COLUMNS
  }
}

/**
 * Initializes & upgrades the MySQL schema for the 20X Autonomous AI Customer Support Engine
 * and SuperAdmin Support Command Center.
 */
async function initAiSupportTables(customPool = null) {
  const pool = getPool(customPool);

  // 1. Support Agents table with multi-role RBAC (agent, supervisor, manager)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_agents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('agent', 'supervisor', 'manager') NOT NULL DEFAULT 'agent',
      department VARCHAR(80) NOT NULL DEFAULT 'General Concierge',
      permissions JSON NULL,
      max_concurrent_chats INT NOT NULL DEFAULT 10,
      online_status ENUM('online', 'busy', 'away', 'offline') NOT NULL DEFAULT 'online',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_login_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await addColIfMissing(pool, 'support_agents', 'email', 'VARCHAR(150) NULL');
  await addColIfMissing(pool, 'support_agents', 'role', "ENUM('agent', 'supervisor', 'manager') NOT NULL DEFAULT 'agent'");
  await addColIfMissing(pool, 'support_agents', 'department', "VARCHAR(80) NOT NULL DEFAULT 'General Concierge'");
  await addColIfMissing(pool, 'support_agents', 'permissions', 'JSON NULL');
  await addColIfMissing(pool, 'support_agents', 'max_concurrent_chats', 'INT NOT NULL DEFAULT 10');
  await addColIfMissing(pool, 'support_agents', 'online_status', "ENUM('online', 'busy', 'away', 'offline') NOT NULL DEFAULT 'online'");
  await addColIfMissing(pool, 'support_agents', 'last_login_at', 'DATETIME NULL');

  // 2. AI Support Sessions table with full lifecycle statuses
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_support_sessions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_token VARCHAR(64) NOT NULL UNIQUE,
      user_id INT NULL,
      guest_name VARCHAR(100) NULL,
      guest_email VARCHAR(150) NULL,
      guest_phone VARCHAR(25) NULL,
      status ENUM('active', 'pending', 'waiting_for_review', 'escalated', 'resolved', 'closed') NOT NULL DEFAULT 'active',
      sentiment_score DECIMAL(4,2) NOT NULL DEFAULT 0.00,
      frustration_score INT UNSIGNED NOT NULL DEFAULT 0,
      priority ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
      page_context JSON NULL,
      escalated_ticket_id INT NULL,
      assigned_agent_id INT NULL,
      assigned_agent_name VARCHAR(100) NULL,
      assigned_role VARCHAR(30) NULL,
      resolution_note TEXT NULL,
      csat_rating TINYINT UNSIGNED NULL,
      csat_feedback VARCHAR(500) NULL,
      closed_by VARCHAR(50) NULL,
      closed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_support_user_updated (user_id, updated_at),
      INDEX idx_ai_support_priority_status (priority, status, updated_at),
      CONSTRAINT fk_ai_support_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    await pool.query(
      "ALTER TABLE ai_support_sessions MODIFY COLUMN status ENUM('active', 'pending', 'waiting_for_review', 'escalated', 'resolved', 'closed') NOT NULL DEFAULT 'active'"
    );
  } catch {
    // Ignore on mock pools
  }

  await addColIfMissing(pool, 'ai_support_sessions', 'assigned_agent_id', 'INT NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'assigned_agent_name', 'VARCHAR(100) NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'assigned_role', 'VARCHAR(30) NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'resolution_note', 'TEXT NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'csat_rating', 'TINYINT UNSIGNED NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'csat_feedback', 'VARCHAR(500) NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'closed_by', 'VARCHAR(50) NULL');
  await addColIfMissing(pool, 'ai_support_sessions', 'closed_at', 'DATETIME NULL');

  // 3. AI Support Messages table with staff sender & whisper support
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_support_messages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_id BIGINT UNSIGNED NOT NULL,
      sender VARCHAR(30) NOT NULL DEFAULT 'user',
      sender_name VARCHAR(100) NULL,
      is_internal_note TINYINT(1) NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      tool_calls JSON NULL,
      order_cards JSON NULL,
      quick_actions JSON NULL,
      attachments JSON NULL,
      sentiment JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ai_support_msg_session_created (session_id, created_at, id),
      CONSTRAINT fk_ai_support_msg_session FOREIGN KEY (session_id) REFERENCES ai_support_sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    await pool.query("ALTER TABLE ai_support_messages MODIFY COLUMN sender VARCHAR(30) NOT NULL DEFAULT 'user'");
  } catch {
    // Ignore on mock pools
  }
  await addColIfMissing(pool, 'ai_support_messages', 'sender_name', 'VARCHAR(100) NULL');
  await addColIfMissing(pool, 'ai_support_messages', 'is_internal_note', 'TINYINT(1) NOT NULL DEFAULT 0');

  // 4. AI Support Escalations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_support_escalations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_id BIGINT UNSIGNED NOT NULL,
      ticket_id INT NULL,
      user_id INT NULL,
      customer_name VARCHAR(100) NULL,
      customer_email VARCHAR(150) NULL,
      priority ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'High',
      reason VARCHAR(255) NOT NULL,
      sentiment_score DECIMAL(4,2) NOT NULL DEFAULT 0.00,
      frustration_score INT UNSIGNED NOT NULL DEFAULT 0,
      channels_notified JSON NULL,
      transcript_summary TEXT NULL,
      status ENUM('open', 'acknowledged', 'waiting_for_review', 'resolved', 'closed') NOT NULL DEFAULT 'open',
      assigned_agent_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_support_esc_priority_created (priority, status, created_at),
      INDEX idx_ai_support_esc_session (session_id),
      CONSTRAINT fk_ai_support_esc_session FOREIGN KEY (session_id) REFERENCES ai_support_sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureAiSupportTables(customPool = null) {
  if (customPool) {
    return initAiSupportTables(customPool);
  }
  if (!tablesInitializedPromise) {
    tablesInitializedPromise = initAiSupportTables().catch(err => {
      tablesInitializedPromise = null;
      throw err;
    });
  }
  return tablesInitializedPromise;
}

const parseJsonColumn = value => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const normalizeSessionRow = row => {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionToken: row.session_token,
    userId: row.user_id ? Number(row.user_id) : null,
    guestName: row.guest_name || row.user_name || null,
    guestEmail: row.guest_email || row.user_email || null,
    guestPhone: row.guest_phone || row.user_phone || null,
    status: row.status || 'active',
    sentimentScore: Number(row.sentiment_score || 0),
    frustrationScore: Number(row.frustration_score || 0),
    priority: row.priority || 'Low',
    pageContext: parseJsonColumn(row.page_context) || {},
    escalatedTicketId: row.escalated_ticket_id ? Number(row.escalated_ticket_id) : null,
    assignedAgentId: row.assigned_agent_id ? Number(row.assigned_agent_id) : null,
    assignedAgentName: row.assigned_agent_name || null,
    assignedRole: row.assigned_role || null,
    resolutionNote: row.resolution_note || null,
    csatRating: row.csat_rating ? Number(row.csat_rating) : null,
    csatFeedback: row.csat_feedback || null,
    closedBy: row.closed_by || null,
    closedAt: row.closed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const normalizeMessageRow = row => ({
  id: Number(row.id),
  sessionId: Number(row.session_id),
  sender: row.sender,
  senderName: row.sender_name || null,
  isInternalNote: Boolean(row.is_internal_note),
  content: row.content,
  toolCalls: parseJsonColumn(row.tool_calls) || [],
  orderCards: parseJsonColumn(row.order_cards) || [],
  quickActions: parseJsonColumn(row.quick_actions) || [],
  attachments: parseJsonColumn(row.attachments) || [],
  sentiment: parseJsonColumn(row.sentiment) || null,
  createdAt: row.created_at,
});

/**
 * Creates a new AI support session or resumes an existing one by sessionToken.
 * If forceNew is true, always creates a brand-new session token.
 */
async function createOrResumeSession({
  sessionToken,
  forceNew = false,
  userId = null,
  guestName = null,
  guestEmail = null,
  guestPhone = null,
  pageContext = {},
  pool: customPool = null,
} = {}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);

  const safeContext = sanitizeObjectPII(pageContext || {});
  const cleanEmail = typeof guestEmail === 'string' && guestEmail.trim() ? guestEmail.trim().toLowerCase().slice(0, 150) : null;
  const cleanName = typeof guestName === 'string' && guestName.trim() ? maskPII(guestName.trim()).slice(0, 100) : null;
  const cleanPhone = typeof guestPhone === 'string' && guestPhone.trim() ? guestPhone.trim().slice(0, 25) : null;

  if (!forceNew && typeof sessionToken === 'string' && /^[a-f0-9-]{16,64}$/i.test(sessionToken.trim())) {
    const [existingRows] = await pool.query(
      'SELECT * FROM ai_support_sessions WHERE session_token = ? LIMIT 1',
      [sessionToken.trim()]
    );
    const existing = existingRows?.[0];
    if (existing) {
      if (!existing.user_id || !userId || Number(existing.user_id) === Number(userId)) {
        const mergedContext = { ...(parseJsonColumn(existing.page_context) || {}), ...safeContext };
        await pool.query(
          `UPDATE ai_support_sessions
           SET user_id = COALESCE(user_id, ?),
               guest_name = COALESCE(?, guest_name),
               guest_email = COALESCE(?, guest_email),
               guest_phone = COALESCE(?, guest_phone),
               page_context = ?
           WHERE id = ?`,
          [userId || null, cleanName, cleanEmail, cleanPhone, JSON.stringify(mergedContext), existing.id]
        );
        const [updatedRows] = await pool.query('SELECT * FROM ai_support_sessions WHERE id = ? LIMIT 1', [existing.id]);
        return normalizeSessionRow(updatedRows?.[0] || existing);
      }
    }
  }

  const newToken = crypto.randomBytes(24).toString('hex');
  const [result] = await pool.query(
    `INSERT INTO ai_support_sessions
      (session_token, user_id, guest_name, guest_email, guest_phone, page_context)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newToken, userId || null, cleanName, cleanEmail, cleanPhone, JSON.stringify(safeContext)]
  );

  const [rows] = await pool.query('SELECT * FROM ai_support_sessions WHERE id = ? LIMIT 1', [result.insertId]);
  return normalizeSessionRow(rows?.[0] || {
    id: result.insertId,
    session_token: newToken,
    user_id: userId,
    guest_name: cleanName,
    guest_email: cleanEmail,
    guest_phone: cleanPhone,
    status: 'active',
    sentiment_score: 0,
    frustration_score: 0,
    priority: 'Low',
    page_context: safeContext,
    created_at: new Date().toISOString(),
  });
}

async function getSessionByToken(sessionToken, customPool = null) {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const [rows] = await pool.query(
    'SELECT * FROM ai_support_sessions WHERE session_token = ? LIMIT 1',
    [sessionToken.trim()]
  );
  return normalizeSessionRow(rows?.[0]);
}

async function getSessionById(sessionId, customPool = null) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const [rows] = await pool.query(
    'SELECT * FROM ai_support_sessions WHERE id = ? LIMIT 1',
    [Number(sessionId)]
  );
  return normalizeSessionRow(rows?.[0]);
}

async function updateSessionContext(sessionId, pageContext = {}, guestInfo = {}, customPool = null) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const [rows] = await pool.query('SELECT page_context FROM ai_support_sessions WHERE id = ? LIMIT 1', [sessionId]);
  const currentContext = parseJsonColumn(rows?.[0]?.page_context) || {};
  const merged = sanitizeObjectPII({ ...currentContext, ...pageContext, updatedAt: new Date().toISOString() });

  await pool.query(
    `UPDATE ai_support_sessions
     SET page_context = ?,
         guest_email = COALESCE(?, guest_email),
         guest_phone = COALESCE(?, guest_phone),
         guest_name = COALESCE(?, guest_name)
     WHERE id = ?`,
    [
      JSON.stringify(merged),
      guestInfo.email ? String(guestInfo.email).trim().toLowerCase().slice(0, 150) : null,
      guestInfo.phone ? String(guestInfo.phone).trim().slice(0, 25) : null,
      guestInfo.name ? maskPII(String(guestInfo.name).trim()).slice(0, 100) : null,
      sessionId,
    ]
  );
  return merged;
}

async function updateSessionTelemetry(sessionId, {
  sentimentScore,
  frustrationScore,
  priority,
  status,
  escalatedTicketId,
  assignedAgentId,
  assignedAgentName,
  assignedRole,
  resolutionNote,
  csatRating,
  csatFeedback,
  closedBy,
}, customPool = null) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  await pool.query(
    `UPDATE ai_support_sessions
     SET sentiment_score = COALESCE(?, sentiment_score),
         frustration_score = COALESCE(?, frustration_score),
         priority = COALESCE(?, priority),
         status = COALESCE(?, status),
         escalated_ticket_id = COALESCE(?, escalated_ticket_id),
         assigned_agent_id = COALESCE(?, assigned_agent_id),
         assigned_agent_name = COALESCE(?, assigned_agent_name),
         assigned_role = COALESCE(?, assigned_role),
         resolution_note = COALESCE(?, resolution_note),
         csat_rating = COALESCE(?, csat_rating),
         csat_feedback = COALESCE(?, csat_feedback),
         closed_by = COALESCE(?, closed_by),
         closed_at = CASE WHEN ? IN ('resolved', 'closed') THEN NOW() WHEN ? = 'active' THEN NULL ELSE closed_at END
     WHERE id = ?`,
    [
      sentimentScore !== undefined ? sentimentScore : null,
      frustrationScore !== undefined ? frustrationScore : null,
      priority || null,
      status || null,
      escalatedTicketId || null,
      assignedAgentId !== undefined ? assignedAgentId : null,
      assignedAgentName !== undefined ? assignedAgentName : null,
      assignedRole !== undefined ? assignedRole : null,
      resolutionNote !== undefined ? maskPII(resolutionNote) : null,
      csatRating !== undefined ? Number(csatRating) : null,
      csatFeedback !== undefined ? maskPII(csatFeedback).slice(0, 500) : null,
      closedBy || null,
      status || null,
      status || null,
      sessionId,
    ]
  );
}

/**
 * Appends a message to the session log after applying strict PII redaction.
 */
async function appendMessage({
  sessionId,
  sender,
  senderName = null,
  isInternalNote = false,
  content,
  toolCalls = null,
  orderCards = null,
  quickActions = null,
  attachments = null,
  sentiment = null,
  pool: customPool = null,
}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);

  const maskedContent = maskPII(String(content || '')).slice(0, 16000);
  const safeToolCalls = toolCalls ? JSON.stringify(sanitizeObjectPII(toolCalls)) : null;
  const safeOrderCards = orderCards ? JSON.stringify(sanitizeObjectPII(orderCards)) : null;
  const safeQuickActions = quickActions ? JSON.stringify(quickActions) : null;
  const safeAttachments = attachments ? JSON.stringify(sanitizeObjectPII(attachments)) : null;
  const safeSentiment = sentiment ? JSON.stringify(sentiment) : null;

  const [result] = await pool.query(
    `INSERT INTO ai_support_messages
      (session_id, sender, sender_name, is_internal_note, content, tool_calls, order_cards, quick_actions, attachments, sentiment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      sender,
      senderName ? maskPII(senderName).slice(0, 100) : null,
      isInternalNote ? 1 : 0,
      maskedContent,
      safeToolCalls,
      safeOrderCards,
      safeQuickActions,
      safeAttachments,
      safeSentiment,
    ]
  );

  return {
    id: result.insertId,
    sessionId,
    sender,
    senderName: senderName || null,
    isInternalNote: Boolean(isInternalNote),
    content: maskedContent,
    toolCalls: toolCalls || [],
    orderCards: orderCards || [],
    quickActions: quickActions || [],
    attachments: attachments || [],
    sentiment: sentiment || null,
    createdAt: new Date().toISOString(),
  };
}

async function getSessionMessages(sessionId, limit = 80, customPool = null, { includeInternal = false } = {}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 80));
  const [rows] = await pool.query(
    `SELECT * FROM ai_support_messages
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [sessionId, safeLimit]
  );
  const normalized = (rows || []).map(normalizeMessageRow);
  return includeInternal ? normalized : normalized.filter(m => !m.isInternalNote && m.sender !== 'whisper');
}

/**
 * Lists all chat sessions for the `/support` and `/superadminsupport` live monitoring consoles.
 */
async function listAllChatSessions({
  status = null,
  priority = null,
  assignedAgentId = null,
  search = '',
  limit = 100,
  pool: customPool = null,
} = {}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const clauses = [];
  const params = [];

  if (status && status !== 'all' && VALID_CHAT_STATUSES.includes(status)) {
    clauses.push('s.status = ?');
    params.push(status);
  }
  if (priority && priority !== 'all' && ['Low', 'Medium', 'High', 'Critical'].includes(priority)) {
    clauses.push('s.priority = ?');
    params.push(priority);
  }
  if (assignedAgentId !== null && assignedAgentId !== undefined && assignedAgentId !== '') {
    clauses.push('s.assigned_agent_id = ?');
    params.push(Number(assignedAgentId));
  }
  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    clauses.push('(s.session_token LIKE ? OR s.guest_name LIKE ? OR s.guest_email LIKE ? OR s.guest_phone LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
    params.push(term, term, term, term, term, term);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(250, Number(limit) || 100)));

  const [rows] = await pool.query(
    `SELECT s.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
     FROM ai_support_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     ${whereSql}
     ORDER BY
       CASE s.status
         WHEN 'escalated' THEN 1
         WHEN 'waiting_for_review' THEN 2
         WHEN 'active' THEN 3
         WHEN 'pending' THEN 4
         WHEN 'resolved' THEN 5
         ELSE 6
       END,
       CASE s.priority
         WHEN 'Critical' THEN 1
         WHEN 'High' THEN 2
         WHEN 'Medium' THEN 3
         ELSE 4
       END,
       s.updated_at DESC
     LIMIT ?`,
    params
  );

  return (rows || []).map(normalizeSessionRow);
}

async function createEscalationRecord({
  sessionId,
  ticketId = null,
  userId = null,
  customerName = null,
  customerEmail = null,
  priority = 'High',
  reason,
  sentimentScore = 0,
  frustrationScore = 0,
  channelsNotified = [],
  transcriptSummary = '',
  pool: customPool = null,
}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const maskedSummary = maskPII(transcriptSummary || '').slice(0, 8000);
  const [result] = await pool.query(
    `INSERT INTO ai_support_escalations
      (session_id, ticket_id, user_id, customer_name, customer_email, priority, reason,
       sentiment_score, frustration_score, channels_notified, transcript_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      ticketId || null,
      userId || null,
      customerName ? maskPII(customerName).slice(0, 100) : null,
      customerEmail ? String(customerEmail).trim().slice(0, 150) : null,
      priority,
      maskPII(reason || 'Customer escalation').slice(0, 255),
      sentimentScore,
      frustrationScore,
      JSON.stringify(channelsNotified || []),
      maskedSummary,
    ]
  );
  return result.insertId;
}

async function listEscalations({ status = null, limit = 50, pool: customPool = null } = {}) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const params = [];
  let where = '';
  if (status && ['open', 'acknowledged', 'waiting_for_review', 'resolved', 'closed'].includes(status)) {
    where = 'WHERE e.status = ?';
    params.push(status);
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const [rows] = await pool.query(
    `SELECT e.*, s.session_token, s.page_context, s.status AS session_status, s.assigned_agent_name
     FROM ai_support_escalations e
     JOIN ai_support_sessions s ON s.id = e.session_id
     ${where}
     ORDER BY
       CASE e.priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END,
       e.created_at DESC
     LIMIT ?`,
    params
  );
  return (rows || []).map(row => ({
    ...row,
    channels_notified: parseJsonColumn(row.channels_notified) || [],
    page_context: parseJsonColumn(row.page_context) || {},
  }));
}

/**
 * Retrieves the live AI Support & SuperAdmin Feature Management configuration from `settings`.
 */
async function getAiSupportFeatureConfig(customPool = null) {
  const pool = getPool(customPool);
  const config = { ...DEFAULT_AI_SUPPORT_FEATURES, macros: [...DEFAULT_CANNED_MACROS] };
  try {
    const [rows] = await pool.query(
      "SELECT key_name, value FROM settings WHERE group_name = 'ai_support_features'"
    );
    for (const row of rows || []) {
      const k = row.key_name;
      if (k === 'support_canned_macros') {
        const parsed = parseJsonColumn(row.value);
        if (Array.isArray(parsed) && parsed.length) config.macros = parsed;
      } else if (Object.prototype.hasOwnProperty.call(DEFAULT_AI_SUPPORT_FEATURES, k)) {
        const defaultVal = DEFAULT_AI_SUPPORT_FEATURES[k];
        if (typeof defaultVal === 'boolean') {
          config[k] = row.value === '1' || row.value === 'true' || row.value === true;
        } else if (typeof defaultVal === 'number') {
          const num = Number(row.value);
          if (Number.isFinite(num)) config[k] = num;
        }
      }
    }
  } catch {
    // Fallback to DEFAULT_AI_SUPPORT_FEATURES
  }
  return config;
}

/**
 * Updates AI Support Feature Flags & Thresholds in the `settings` table.
 */
async function updateAiSupportFeatureConfig(updates = {}, customPool = null) {
  const pool = getPool(customPool);
  for (const [key, val] of Object.entries(updates || {})) {
    if (key === 'macros' && Array.isArray(val)) {
      await pool.query(
        `INSERT INTO settings (key_name, value, group_name)
         VALUES ('support_canned_macros', ?, 'ai_support_features')
         ON DUPLICATE KEY UPDATE value = VALUES(value), group_name = 'ai_support_features'`,
        [JSON.stringify(val.slice(0, 50))]
      );
    } else if (Object.prototype.hasOwnProperty.call(DEFAULT_AI_SUPPORT_FEATURES, key)) {
      const defaultVal = DEFAULT_AI_SUPPORT_FEATURES[key];
      const serialized = typeof defaultVal === 'boolean'
        ? (val ? '1' : '0')
        : String(Math.max(1, Number(val) || defaultVal));
      await pool.query(
        `INSERT INTO settings (key_name, value, group_name)
         VALUES (?, ?, 'ai_support_features')
         ON DUPLICATE KEY UPDATE value = VALUES(value), group_name = 'ai_support_features'`,
        [key, serialized]
      );
    }
  }
  return getAiSupportFeatureConfig(pool);
}

module.exports = {
  VALID_CHAT_STATUSES,
  VALID_SUPPORT_ROLES,
  ROLE_DEFAULT_PERMISSIONS,
  DEFAULT_AI_SUPPORT_FEATURES,
  DEFAULT_CANNED_MACROS,
  resolveRolePermissions,
  initAiSupportTables,
  ensureAiSupportTables,
  createOrResumeSession,
  getSessionByToken,
  getSessionById,
  updateSessionContext,
  updateSessionTelemetry,
  appendMessage,
  getSessionMessages,
  listAllChatSessions,
  createEscalationRecord,
  listEscalations,
  getAiSupportFeatureConfig,
  updateAiSupportFeatureConfig,
};
