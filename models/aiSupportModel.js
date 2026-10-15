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

let tablesInitializedPromise = null;

/**
 * Initializes the MySQL schema for the Autonomous AI Customer Support Engine.
 * Supports idempotent execution via migrations or runtime boot check.
 */
async function initAiSupportTables(customPool = null) {
  const pool = getPool(customPool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_support_sessions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_token VARCHAR(64) NOT NULL UNIQUE,
      user_id INT NULL,
      guest_name VARCHAR(100) NULL,
      guest_email VARCHAR(150) NULL,
      guest_phone VARCHAR(25) NULL,
      status ENUM('active', 'escalated', 'resolved', 'closed') NOT NULL DEFAULT 'active',
      sentiment_score DECIMAL(4,2) NOT NULL DEFAULT 0.00,
      frustration_score INT UNSIGNED NOT NULL DEFAULT 0,
      priority ENUM('Low', 'Medium', 'High', 'Critical') NOT NULL DEFAULT 'Low',
      page_context JSON NULL,
      escalated_ticket_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_support_user_updated (user_id, updated_at),
      INDEX idx_ai_support_priority_status (priority, status, updated_at),
      CONSTRAINT fk_ai_support_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_support_messages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_id BIGINT UNSIGNED NOT NULL,
      sender ENUM('user', 'assistant', 'system', 'tool') NOT NULL,
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
      status ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
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
    guestName: row.guest_name || null,
    guestEmail: row.guest_email || null,
    guestPhone: row.guest_phone || null,
    status: row.status || 'active',
    sentimentScore: Number(row.sentiment_score || 0),
    frustrationScore: Number(row.frustration_score || 0),
    priority: row.priority || 'Low',
    pageContext: parseJsonColumn(row.page_context) || {},
    escalatedTicketId: row.escalated_ticket_id ? Number(row.escalated_ticket_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const normalizeMessageRow = row => ({
  id: Number(row.id),
  sessionId: Number(row.session_id),
  sender: row.sender,
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
 */
async function createOrResumeSession({
  sessionToken,
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

  if (typeof sessionToken === 'string' && /^[a-f0-9-]{16,64}$/i.test(sessionToken.trim())) {
    const [existingRows] = await pool.query(
      'SELECT * FROM ai_support_sessions WHERE session_token = ? LIMIT 1',
      [sessionToken.trim()]
    );
    const existing = existingRows?.[0];
    if (existing) {
      // Prevent cross-user session hijacking if session belongs to a different authenticated user
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

async function updateSessionTelemetry(sessionId, { sentimentScore, frustrationScore, priority, status, escalatedTicketId }, customPool = null) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  await pool.query(
    `UPDATE ai_support_sessions
     SET sentiment_score = COALESCE(?, sentiment_score),
         frustration_score = COALESCE(?, frustration_score),
         priority = COALESCE(?, priority),
         status = COALESCE(?, status),
         escalated_ticket_id = COALESCE(?, escalated_ticket_id)
     WHERE id = ?`,
    [
      sentimentScore !== undefined ? sentimentScore : null,
      frustrationScore !== undefined ? frustrationScore : null,
      priority || null,
      status || null,
      escalatedTicketId || null,
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
      (session_id, sender, content, tool_calls, order_cards, quick_actions, attachments, sentiment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, sender, maskedContent, safeToolCalls, safeOrderCards, safeQuickActions, safeAttachments, safeSentiment]
  );

  return {
    id: result.insertId,
    sessionId,
    sender,
    content: maskedContent,
    toolCalls: toolCalls || [],
    orderCards: orderCards || [],
    quickActions: quickActions || [],
    attachments: attachments || [],
    sentiment: sentiment || null,
    createdAt: new Date().toISOString(),
  };
}

async function getSessionMessages(sessionId, limit = 50, customPool = null) {
  const pool = getPool(customPool);
  await ensureAiSupportTables(pool);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await pool.query(
    `SELECT * FROM ai_support_messages
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [sessionId, safeLimit]
  );
  return (rows || []).map(normalizeMessageRow);
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
  if (status && ['open', 'acknowledged', 'resolved'].includes(status)) {
    where = 'WHERE e.status = ?';
    params.push(status);
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const [rows] = await pool.query(
    `SELECT e.*, s.session_token, s.page_context
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

module.exports = {
  initAiSupportTables,
  ensureAiSupportTables,
  createOrResumeSession,
  getSessionByToken,
  updateSessionContext,
  updateSessionTelemetry,
  appendMessage,
  getSessionMessages,
  createEscalationRecord,
  listEscalations,
};
