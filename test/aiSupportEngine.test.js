'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const { maskPII, sanitizeObjectPII } = require('../utils/piiMasker');
const { analyzeSentiment, triggerInstantEscalation } = require('../services/sentimentEscalationEngine');
const {
  lookupOrderTool,
  cancelOrderTool,
  initiateReturnTool,
  checkRefundStatusTool,
  queryInventoryCatalogTool,
} = require('../services/aiSupportTools');
const {
  buildContextualGreeting,
  detectIntentAndToolPlan,
  processSupportTurn,
} = require('../services/aiSupportOrchestrator');
const supportRoutes = require('../routes/supportRoutes');

const TEST_JWT_SECRET = 'ai-support-live-test-secret-with-more-than-32-chars';
process.env.JWT_SECRET = TEST_JWT_SECRET;

/**
 * In-memory MySQL Pool Mock for deterministic end-to-end verification of
 * AI Support Sessions, Messages, Escalations, Orders, Returns, Refunds, Inventory, and Staff Portal.
 */
function createMockSupportPool(agentPasswordHash = '') {
  const state = {
    sessions: [],
    messages: [],
    escalations: [],
    tickets: [],
    ticketMessages: [],
    notifications: [],
    supportAgents: [
      {
        id: 1,
        username: 'concierge_lead',
        name: 'Priya Nair',
        password_hash: agentPasswordHash,
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    ],
    users: [
      {
        id: 7,
        name: 'Aarav Sharma',
        email: 'aarav@example.com',
        phone: '9876543210',
        role: 'customer',
        is_active: 1,
        wallet_balance: 250,
        loyalty_points: 400,
      },
    ],
    orders: [
      {
        id: 101,
        order_number: '918273645',
        user_id: 7,
        user_name: 'Aarav Sharma',
        user_email: 'aarav@example.com',
        user_phone: '9876543210',
        status: 'confirmed',
        payment_mode: 'COD',
        payment_status: 'pending',
        subtotal: 899,
        discount: 50,
        shipping_cost: 0,
        total: 849,
        tracking_number: null,
        courier: null,
        delivery_type: 'standard',
        created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        delivered_at: null,
        address_snapshot: JSON.stringify({ phone: '9876543210', city: 'Kolkata' }),
      },
      {
        id: 102,
        order_number: '918273646',
        user_id: 7,
        user_name: 'Aarav Sharma',
        user_email: 'aarav@example.com',
        user_phone: '9876543210',
        status: 'delivered',
        payment_mode: 'online',
        payment_status: 'paid',
        payment_id: 'pay_Rzp998877',
        subtotal: 1299,
        discount: 0,
        shipping_cost: 0,
        total: 1299,
        tracking_number: 'DLV99881122',
        courier: 'Delhivery',
        delivery_type: 'express',
        created_at: new Date(Date.now() - 4 * 86400 * 1000).toISOString(),
        delivered_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        address_snapshot: JSON.stringify({ phone: '9876543210', city: 'Kolkata' }),
      },
      {
        id: 103,
        order_number: '918273647',
        user_id: 7,
        user_name: 'Aarav Sharma',
        user_email: 'aarav@example.com',
        user_phone: '9876543210',
        status: 'confirmed',
        payment_mode: 'online',
        payment_status: 'paid',
        payment_id: 'pay_RzpPaidOnline',
        subtotal: 699,
        discount: 0,
        shipping_cost: 0,
        total: 699,
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
        delivered_at: null,
        address_snapshot: JSON.stringify({ phone: '9876543210' }),
      },
    ],
    orderItems: [
      { id: 1, order_id: 101, product_id: 11, name: 'Kumkumadi Night Elixir', sku: 'BV-KUM-30', price: 849, quantity: 1, image: '/img/kumkumadi.webp', is_gift: 0 },
      { id: 2, order_id: 102, product_id: 12, name: 'Gotu Kola Barrier Repair Cream', sku: 'BV-GK-50', price: 1299, quantity: 1, image: '/img/gotukola.webp', is_gift: 0 },
      { id: 3, order_id: 103, product_id: 11, name: 'Kumkumadi Night Elixir', sku: 'BV-KUM-30', price: 699, quantity: 1, image: '/img/kumkumadi.webp', is_gift: 0 },
    ],
    returns: [],
    refundRequests: [],
    products: [
      {
        id: 11,
        name: 'Kumkumadi Night Elixir',
        slug: 'kumkumadi-night-elixir',
        sku: 'BV-KUM-30',
        brand: 'Bhumivera',
        description: 'Cold-pressed botanical facial oil with Kashmir saffron and vetiver.',
        price: 999,
        discount_price: 849,
        quantity: 18,
        status: 'active',
        is_featured: 1,
        rating: 4.8,
        review_count: 142,
        category_name: 'Facial Oils',
        subcategory_name: 'Night Care',
        specifications: JSON.stringify({
          ingredients: 'Crocus sativus (Saffron), Vetiveria zizanioides, Santalum album',
          how_to_use: 'Apply 3-4 drops on damp skin after cleansing every evening.',
        }),
      },
    ],
  };

  const executeQuery = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('CREATE TABLE IF NOT EXISTS')) {
      return [{ affectedRows: 0 }];
    }
    if (norm.includes("FROM settings WHERE key_name = 'return_policy_days'")) {
      return [[{ value: '7' }]];
    }
    if (norm.includes('FROM settings WHERE key_name IN')) {
      return [[
        { key_name: 'free_shipping_threshold', value: '500' },
        { key_name: 'standard_charge', value: '50' },
        { key_name: 'express_charge', value: '150' },
        { key_name: 'return_policy_days', value: '7' },
      ]];
    }

    // Users & sessions
    if (norm.includes('FROM users WHERE id = ?')) {
      const u = state.users.find(x => x.id === Number(params[0]));
      return [u ? [u] : []];
    }
    if (norm.includes('FROM user_sessions')) {
      return [[{ jti: 'active-jti' }]];
    }

    // support_agents
    if (norm.includes('FROM support_agents WHERE username = ?')) {
      const agent = state.supportAgents.find(a => a.username === params[0]);
      return [agent ? [agent] : []];
    }
    if (norm.includes('FROM support_agents WHERE id = ?')) {
      const agent = state.supportAgents.find(a => a.id === Number(params[0]));
      return [agent ? [agent] : []];
    }

    // ai_support_sessions
    if (norm.startsWith('SELECT * FROM ai_support_sessions WHERE session_token = ?')) {
      const found = state.sessions.find(s => s.session_token === params[0]);
      return [found ? [found] : []];
    }
    if (norm.startsWith('SELECT * FROM ai_support_sessions WHERE id = ?') || norm.startsWith('SELECT page_context FROM ai_support_sessions WHERE id = ?')) {
      const found = state.sessions.find(s => s.id === Number(params[0]));
      return [found ? [found] : []];
    }
    if (norm.startsWith('INSERT INTO ai_support_sessions')) {
      const row = {
        id: state.sessions.length + 1,
        session_token: params[0],
        user_id: params[1],
        guest_name: params[2],
        guest_email: params[3],
        guest_phone: params[4],
        page_context: params[5],
        status: 'active',
        sentiment_score: 0,
        frustration_score: 0,
        priority: 'Low',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.sessions.push(row);
      return [{ insertId: row.id }];
    }
    if (norm.startsWith('UPDATE ai_support_sessions')) {
      const id = Number(params[params.length - 1]);
      const found = state.sessions.find(s => s.id === id);
      if (found) {
        if (norm.includes('SET sentiment_score')) {
          if (params[0] !== null) found.sentiment_score = params[0];
          if (params[1] !== null) found.frustration_score = params[1];
          if (params[2] !== null) found.priority = params[2];
          if (params[3] !== null) found.status = params[3];
          if (params[4] !== null) found.escalated_ticket_id = params[4];
        } else {
          found.page_context = params[params.length - 2];
        }
      }
      return [{ affectedRows: found ? 1 : 0 }];
    }

    // ai_support_messages
    if (norm.startsWith('INSERT INTO ai_support_messages')) {
      const msg = {
        id: state.messages.length + 1,
        session_id: params[0],
        sender: params[1],
        content: params[2],
        tool_calls: params[3],
        order_cards: params[4],
        quick_actions: params[5],
        attachments: params[6],
        sentiment: params[7],
        created_at: new Date().toISOString(),
      };
      state.messages.push(msg);
      return [{ insertId: msg.id }];
    }
    if (norm.startsWith('SELECT * FROM ai_support_messages')) {
      const rows = state.messages.filter(m => Number(m.session_id) === Number(params[0]));
      return [rows];
    }

    // support_tickets & notifications & ai_support_escalations
    if (norm.startsWith('INSERT INTO support_tickets')) {
      const ticket = {
        id: 500 + state.tickets.length + 1,
        user_id: params[0],
        order_id: params[1],
        name: params[2],
        email: params[3],
        subject: params[4],
        message: params[5],
        status: 'open',
        created_at: new Date().toISOString(),
      };
      state.tickets.push(ticket);
      return [{ insertId: ticket.id }];
    }
    if (norm.includes('FROM support_tickets t')) {
      return [state.tickets];
    }
    if (norm.includes('FROM support_ticket_messages')) {
      return [state.ticketMessages];
    }
    if (norm.startsWith('INSERT INTO notifications')) {
      state.notifications.push({ title: params[0], message: params[1] });
      return [{ insertId: state.notifications.length }];
    }
    if (norm.startsWith('INSERT INTO ai_support_escalations')) {
      const esc = {
        id: state.escalations.length + 1,
        session_id: params[0],
        ticket_id: params[1],
        user_id: params[2],
        customer_name: params[3],
        customer_email: params[4],
        priority: params[5],
        reason: params[6],
        sentiment_score: params[7],
        frustration_score: params[8],
        channels_notified: params[9],
        transcript_summary: params[10],
        status: 'open',
        created_at: new Date().toISOString(),
      };
      state.escalations.push(esc);
      return [{ insertId: esc.id }];
    }
    if (norm.includes('FROM ai_support_escalations e')) {
      return [state.escalations.map(e => ({
        ...e,
        session_token: state.sessions.find(s => s.id === e.session_id)?.session_token || 'tok',
        page_context: '{}',
      }))];
    }

    // Orders & Items
    if (norm.includes('FROM orders o') && (norm.includes('WHERE o.order_number = ?') || norm.includes('WHERE o.id = ?'))) {
      const ref = String(params[0]);
      const num = Number(params[1]);
      const match = state.orders.find(o => o.order_number === ref || o.id === Number(ref) || o.id === num);
      return [match ? [match] : []];
    }
    if (norm.includes('FROM orders o') && norm.includes('WHERE o.user_id = ?')) {
      const matches = state.orders.filter(o => Number(o.user_id) === Number(params[0]));
      return [matches];
    }
    if (norm.startsWith('SELECT user_id FROM orders WHERE id = ?')) {
      const match = state.orders.find(o => o.id === Number(params[0]));
      return [match ? [{ user_id: match.user_id }] : []];
    }
    if (norm.startsWith('SELECT id, user_id, status, payment_mode, payment_status FROM orders WHERE id = ? FOR UPDATE')) {
      const match = state.orders.find(o => o.id === Number(params[0]));
      return [match ? [match] : []];
    }
    if (norm.startsWith('SELECT * FROM order_items WHERE order_id = ?') || norm.startsWith('SELECT product_id, quantity FROM order_items WHERE order_id = ?')) {
      const items = state.orderItems.filter(i => Number(i.order_id) === Number(params[0]));
      return [items];
    }
    if (norm.startsWith('UPDATE products SET quantity = quantity + ? WHERE id = ?')) {
      const prod = state.products.find(p => p.id === Number(params[1]));
      if (prod) prod.quantity += Number(params[0]);
      return [{ affectedRows: prod ? 1 : 0 }];
    }
    if (norm.startsWith("UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?")) {
      const ord = state.orders.find(o => o.id === Number(params[1]));
      if (ord) {
        ord.status = 'cancelled';
        ord.cancel_reason = params[0];
      }
      return [{ affectedRows: ord ? 1 : 0 }];
    }

    // Returns & Refunds
    if (norm.startsWith('SELECT * FROM returns WHERE order_id = ?') || norm.startsWith("SELECT id, rma_number, status, refund_type FROM returns WHERE order_id = ?")) {
      const found = state.returns.filter(r => Number(r.order_id) === Number(params[0]));
      return [found];
    }
    if (norm.startsWith('INSERT INTO returns')) {
      const ret = {
        id: 300 + state.returns.length + 1,
        order_id: params[0],
        user_id: params[1],
        reason: params[2],
        description: params[3],
        refund_type: params[4],
        refund_method: params[5],
        items: params[6],
        rma_number: params[7],
        image_urls: params[8],
        status: 'pending_admin_review',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.returns.push(ret);
      return [{ insertId: ret.id }];
    }
    if (norm.includes('FROM returns r JOIN orders o ON o.id = r.order_id')) {
      const rows = state.returns.map(r => {
        const o = state.orders.find(ord => ord.id === Number(r.order_id)) || {};
        const rr = state.refundRequests.find(req => req.return_id === r.id) || {};
        return {
          ...r,
          order_number: o.order_number,
          order_total: o.total,
          payment_mode: o.payment_mode,
          payment_status: o.payment_status,
          user_id: o.user_id,
          user_email: o.user_email,
          user_phone: o.user_phone,
          address_snapshot: o.address_snapshot,
          refund_receipt: rr.receipt || 'bvrma-301-1',
          provider_refund_id: rr.provider_refund_id || 'rfnd_Rzp112233',
          amount_paise: rr.amount_paise || 129900,
          provider_refund_status: rr.status || 'processed',
        };
      });
      return [rows];
    }

    // Catalog & Products
    if (norm.includes('FROM products p')) {
      return [state.products];
    }

    return [[]];
  };

  return {
    state,
    query: executeQuery,
    execute: executeQuery,
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        query: executeQuery,
      };
    },
  };
}

describe('Phase 4 Verification Suite: Autonomous Enterprise AI Customer Support Engine', () => {
  it('1. PII Masker redacts payment cards, CVVs, passwords, OTPs, and JWTs while preserving 9-digit Order IDs', () => {
    const raw =
      'My order is #918273645, my card 4532 0151 1283 0366 with CVV 842 failed, password is MySecretPass!123, OTP: 482910, token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const masked = maskPII(raw);

    assert.match(masked, /#918273645/, 'Preserves 9-digit Bhumivera order reference');
    assert.ok(!masked.includes('4532 0151 1283 0366'), 'Redacts 16-digit card number');
    assert.match(masked, /\[REDACTED_CARD_ENDING_0366\]/);
    assert.ok(!masked.includes('842'), 'Redacts CVV');
    assert.ok(!masked.includes('MySecretPass!123'), 'Redacts password');
    assert.ok(!masked.includes('482910'), 'Redacts OTP');
    assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Redacts JWT');

    const obj = sanitizeObjectPII({
      customer: 'Aarav',
      password_hash: '$2b$10$secret',
      nested: { cvv: '999', note: 'Card 4532015112830366' },
    });
    assert.equal(obj.password_hash, '[REDACTED]');
    assert.equal(obj.nested.cvv, '[REDACTED]');
    assert.match(obj.nested.note, /\[REDACTED_CARD_ENDING_0366\]/);
  });

  it('2. Sentiment & Escalation Engine scores frustration, priority tiers, and dispatches multi-channel webhooks', async () => {
    const calm = analyzeSentiment('Thank you so much, when will my order arrive?');
    assert.equal(calm.priority, 'Low');
    assert.equal(calm.shouldEscalate, false);

    const critical = analyzeSentiment(
      'THIS IS A SCAM!!! My bottle arrived broken and leaking and nobody replies! I am filing a consumer court complaint and chargeback right now!'
    );
    assert.equal(critical.priority, 'Critical');
    assert.equal(critical.shouldEscalate, true);
    assert.ok(critical.frustrationScore >= 80);

    const mockPool = createMockSupportPool();
    let mailCalled = false;
    const escResult = await triggerInstantEscalation({
      pool: mockPool,
      session: { id: 1, userId: 7, guestName: 'Aarav Sharma', guestEmail: 'aarav@example.com' },
      user: { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com' },
      latestMessage: 'Connect me to a human manager right now!',
      sentiment: critical,
      sendMailFn: async () => {
        mailCalled = true;
        return { success: true };
      },
    });

    assert.equal(escResult.escalated, true);
    assert.equal(escResult.priority, 'Critical');
    assert.ok(escResult.ticketId >= 501, 'Creates human support ticket in support_tickets');
    assert.equal(mailCalled, true, 'Dispatches escalation email alert');
    assert.equal(mockPool.state.escalations.length, 1, 'Records escalation in ai_support_escalations');
  });

  it('3. Autonomous Tool Engine: lookup_order enforces ownership authorization and returns rich order cards', async () => {
    const mockPool = createMockSupportPool();

    const unauthorized = await lookupOrderTool(
      { order_id: '918273645' },
      { pool: mockPool, user: null, session: {} }
    );
    assert.equal(unauthorized.success, false);
    assert.equal(unauthorized.code, 'VERIFICATION_REQUIRED');

    const authorized = await lookupOrderTool(
      { order_id: '918273646' },
      { pool: mockPool, user: { id: 7, email: 'aarav@example.com', role: 'customer' } }
    );
    assert.equal(authorized.success, true);
    assert.equal(authorized.order.orderNumber, '918273646');
    assert.equal(authorized.order.trackingNumber, 'DLV99881122');
    assert.equal(authorized.order.canReturn, true);
  });

  it('4. Autonomous Tool Engine: cancel_order cancels COD orders & restocks inventory, and safeguards paid online orders', async () => {
    const mockPool = createMockSupportPool();
    const user = { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', role: 'customer' };

    const initialStock = mockPool.state.products[0].quantity;
    const codCancel = await cancelOrderTool({ order_id: '918273645', reason: 'Ordered by mistake' }, { pool: mockPool, user });
    assert.equal(codCancel.success, true);
    assert.equal(codCancel.code, 'ORDER_CANCELLED');
    assert.equal(mockPool.state.orders[0].status, 'cancelled');
    assert.equal(mockPool.state.products[0].quantity, initialStock + 1, 'Restocks inventory upon cancellation');

    const onlineCancel = await cancelOrderTool({ order_id: '918273647', reason: 'Change of address' }, { pool: mockPool, user });
    assert.equal(onlineCancel.success, true);
    assert.equal(onlineCancel.code, 'ONLINE_REFUND_CANCELLATION_QUEUED');
    assert.ok(onlineCancel.ticketId >= 501);
  });

  it('5. Autonomous Tool Engine: initiate_return, check_refund_status, and query_inventory_catalog work end-to-end', async () => {
    const mockPool = createMockSupportPool();
    const user = { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', role: 'customer' };

    const returnRes = await initiateReturnTool(
      { order_id: '918273646', reason: 'Outer seal damaged in transit', resolution_type: 'replacement' },
      { pool: mockPool, user }
    );
    assert.equal(returnRes.success, true);
    assert.equal(returnRes.code, 'RETURN_INITIATED');
    assert.match(returnRes.rmaNumber, /^RMA-[A-F0-9]{8}$/);
    assert.equal(returnRes.resolutionType, 'replacement');

    const dupRes = await initiateReturnTool(
      { order_id: '918273646', reason: 'Second attempt' },
      { pool: mockPool, user }
    );
    assert.equal(dupRes.success, false);
    assert.equal(dupRes.code, 'ALREADY_RETURNED');

    const refundCheck = await checkRefundStatusTool(
      { rma_number: returnRes.rmaNumber },
      { pool: mockPool, user }
    );
    assert.equal(refundCheck.success, true);
    assert.equal(refundCheck.code, 'REFUND_STATUS_FOUND');
    assert.equal(refundCheck.latestRefund.rmaNumber, returnRes.rmaNumber);
    assert.equal(refundCheck.latestRefund.refundReceipt, 'bvrma-301-1');

    const catalogRes = await queryInventoryCatalogTool(
      { query: 'Kumkumadi' },
      { pool: mockPool, user }
    );
    assert.equal(catalogRes.success, true);
    assert.equal(catalogRes.products.length, 1);
    assert.equal(catalogRes.products[0].sku, 'BV-KUM-30');
    assert.equal(catalogRes.shippingPolicy.freeShippingThresholdInr, 500);
  });

  it('6. Orchestrator: processSupportTurn persists masked multi-turn memory and handles LLM fallback gracefully', async () => {
    const mockPool = createMockSupportPool();
    const user = { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', role: 'customer' };

    const turn1 = await processSupportTurn({
      sessionToken: null,
      message: 'Where is my order #918273646? Also my card 4532 0151 1283 0366 was used.',
      pageContext: { pathname: '/order-tracking' },
      user,
      pool: mockPool,
      aiClient: null,
    });

    assert.ok(turn1.sessionToken);
    assert.equal(turn1.orderCards.length, 1);
    assert.equal(turn1.orderCards[0].orderNumber, '918273646');
    assert.match(turn1.reply, /918273646/);
    assert.ok(
      !mockPool.state.messages[0].content.includes('4532 0151 1283 0366'),
      'User message stored in DB has card number redacted'
    );

    const greeting = buildContextualGreeting({
      user,
      pageContext: { pathname: '/checkout', proactiveTrigger: 'checkout_linger' },
    });
    assert.match(greeting.greeting, /Aarav/);
    assert.ok(greeting.quickActions.length >= 3);

    const plan = detectIntentAndToolPlan('What is my refund status for RMA-ABCD1234?');
    assert.equal(plan.intent, 'refund_status');
    assert.equal(plan.toolCalls[0].name, 'check_refund_status');
  });
});

describe('Live HTTP Server & SSE Streaming Verification (/api/support/*)', () => {
  let server;
  let baseUrl;
  let livePool;
  let customerToken;

  before(async () => {
    const agentHash = await bcrypt.hash('SupportPass!2026', 10);
    livePool = createMockSupportPool(agentHash);
    if (typeof pool.setMockHandler === 'function') {
      pool.setMockHandler((sql, params) => livePool.query(sql, params));
    }

    customerToken = jwt.sign(
      { id: 7, name: 'Aarav Sharma', email: 'aarav@example.com', role: 'customer', sessionType: 'user' },
      TEST_JWT_SECRET,
      { expiresIn: '1h', jwtid: 'live-cust-jti' }
    );

    const app = express();
    app.use(express.json());
    app.use('/api/support', supportRoutes);

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/support`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  });

  it('7. Live HTTP POST /chat/session and POST /chat/context initialize session and return contextual nudges', async () => {
    const sessionRes = await fetch(`${baseUrl}/chat/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        pageContext: { pathname: '/checkout', proactiveTrigger: 'checkout_linger' },
      }),
    });
    assert.equal(sessionRes.status, 200);
    const sessionData = await sessionRes.json();
    assert.equal(sessionData.success, true);
    assert.ok(sessionData.sessionToken);
    assert.match(sessionData.greeting, /Aarav/);

    const ctxRes = await fetch(`${baseUrl}/chat/context`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        sessionToken: sessionData.sessionToken,
        pageContext: { pathname: '/checkout', proactiveTrigger: 'rage_click' },
      }),
    });
    assert.equal(ctxRes.status, 200);
    const ctxData = await ctxRes.json();
    assert.equal(ctxData.success, true);
    assert.match(ctxData.proactiveMessage, /not be responding as expected/);
  });

  it('8. Live HTTP POST /chat/message & GET /chat/history/:token execute order lookup, return RMA, and enforce session ownership', async () => {
    const msgRes = await fetch(`${baseUrl}/chat/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        message: 'Where is my order #918273646?',
        pageContext: { pathname: '/order-tracking' },
      }),
    });
    assert.equal(msgRes.status, 200);
    const msgData = await msgRes.json();
    assert.equal(msgData.success, true);
    assert.equal(msgData.orderCards.length, 1);
    assert.equal(msgData.orderCards[0].orderNumber, '918273646');

    // Fetch history with owning customer token -> 200
    const histRes = await fetch(`${baseUrl}/chat/history/${msgData.sessionToken}`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(histRes.status, 200);
    const histData = await histRes.json();
    assert.ok(histData.messages.length >= 2);

    // Fetch history with a different customer's token -> 403 FORBIDDEN_SESSION
    const otherUserToken = jwt.sign(
      { id: 999, email: 'other@example.com', role: 'customer', sessionType: 'user' },
      TEST_JWT_SECRET,
      { expiresIn: '1h', jwtid: 'other-jti' }
    );
    const forbiddenRes = await fetch(`${baseUrl}/chat/history/${msgData.sessionToken}`, {
      headers: { authorization: `Bearer ${otherUserToken}` },
    });
    assert.equal(forbiddenRes.status, 403);
  });

  it('9. Live HTTP POST /chat/stream streams real-time Server-Sent Events (status, tool_call, token, metadata, done)', async () => {
    const streamRes = await fetch(`${baseUrl}/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        message: 'Initiate return for order #918273646 because outer box was damaged',
      }),
    });

    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const rawSse = await streamRes.text();
    assert.match(rawSse, /event: status/);
    assert.match(rawSse, /event: tool_call/);
    assert.match(rawSse, /"name":"initiate_return"/);
    assert.match(rawSse, /event: token/);
    assert.match(rawSse, /RMA-/);
    assert.match(rawSse, /event: metadata/);
    assert.match(rawSse, /event: done/);
  });

  it('10. Live HTTP POST /chat/escalate & Staff Support Portal (/login, /ai-escalations, /tickets) work end-to-end', async () => {
    const escRes = await fetch(`${baseUrl}/chat/escalate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        reason: 'Urgent delivery issue',
        message: 'Please connect me with a senior support specialist.',
      }),
    });
    assert.equal(escRes.status, 201);
    const escData = await escRes.json();
    assert.equal(escData.success, true);
    assert.equal(escData.escalation.escalated, true);

    // Staff Support Agent login via POST /api/support/login
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'concierge_lead', password: 'SupportPass!2026' }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.ok(loginData.token);

    // Staff Support Agent inspects AI escalations via GET /api/support/ai-escalations
    const listEscRes = await fetch(`${baseUrl}/ai-escalations`, {
      headers: { authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(listEscRes.status, 200);
    const listEscData = await listEscRes.json();
    assert.equal(listEscData.success, true);
    assert.ok(listEscData.escalations.length >= 1);

    // Staff Support Agent inspects support tickets via GET /api/support/tickets
    const ticketsRes = await fetch(`${baseUrl}/tickets`, {
      headers: { authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(ticketsRes.status, 200);
    const ticketsData = await ticketsRes.json();
    assert.ok(Array.isArray(ticketsData.tickets));
    assert.ok(ticketsData.tickets.length >= 1);
  });
});
